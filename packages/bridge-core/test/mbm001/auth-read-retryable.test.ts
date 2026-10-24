import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createMobileAuthService } from '../../src/mobile/auth-service.js';
import {
  MobileAuthPersistenceError, MobileServiceError,
  type MobileAuthCrypto, type MobileAuthPersistence, type MobileSealedState,
} from '../../src/mobile/types.js';

const SERVER = 'server.read-retry-fixture', DATASET = 'dataset.read-retry-fixture';
const START = 1_700_000_000_000;
type WriteFault = 'not-sent' | 'unknown-before' | 'unknown-after';
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function copy(value: MobileSealedState): MobileSealedState {
  return value.kind === 'missing' ? { ...value } : { ...value, sealed: new Uint8Array(value.sealed) };
}

/** 合成 AES-GCM 与内存 CAS；不访问真实 Owner、密钥库或账号。 */
function fixture(t: TestContext) {
  const key = randomBytes(32);
  const crypto: MobileAuthCrypto = {
    seal(plain, aad) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(aad);
      const body = Buffer.concat([cipher.update(plain), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    open(sealed, aad) {
      const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
      decipher.setAAD(aad); decipher.setAuthTag(sealed.subarray(12, 28));
      return Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]);
    },
  };
  let stored: MobileSealedState = { kind: 'missing', datasetId: DATASET, revision: 0 };
  let loadFault: unknown, writeFault: WriteFault | undefined;
  let held: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;
  const releases = new Set<() => void>();
  const counts = { loads: 0, saves: 0, commits: 0 };
  const persistence: MobileAuthPersistence = {
    async load(datasetId) {
      assert.equal(datasetId, DATASET); counts.loads++;
      const gate = held; held = undefined;
      if (gate) { gate.entered.resolve(); await gate.release.promise; }
      const error = loadFault; loadFault = undefined;
      if (error !== undefined) throw error;
      return copy(stored);
    },
    async save(request) {
      assert.equal(request.datasetId, DATASET); counts.saves++;
      const captured = { ...request, sealed: new Uint8Array(request.sealed) };
      const fault = writeFault; writeFault = undefined;
      if (fault === 'not-sent' || fault === 'unknown-before') {
        throw new MobileAuthPersistenceError(fault === 'not-sent' ? 'not-sent' : 'unknown');
      }
      if (captured.expectedRevision !== stored.revision) {
        return { kind: 'conflict', datasetId: DATASET, currentRevision: stored.revision };
      }
      stored = { kind: 'sealed', datasetId: DATASET, revision: stored.revision + 1,
        commitId: captured.commitId, sealed: captured.sealed };
      counts.commits++;
      if (fault === 'unknown-after') throw new MobileAuthPersistenceError('unknown');
      return { kind: 'saved', datasetId: DATASET, revision: stored.revision, commitId: stored.commitId };
    },
  };
  const auth = createMobileAuthService({ persistence, crypto, serverId: SERVER, datasetId: DATASET,
    displayName: '合成只读暂错', environment: 'development', now: () => START });
  t.after(async () => {
    for (const release of releases) release();
    await auth.close(); key.fill(0);
    if (stored.kind === 'sealed') stored.sealed.fill(0);
  });
  return { auth, counts, snapshot: () => copy(stored),
    failLoad(error: unknown) { loadFault = error; },
    failWrite(error: WriteFault) { writeFault = error; },
    restore(value: MobileSealedState) { stored = copy(value); },
    holdLoad() {
      const entered = deferred(), release = deferred(); held = { entered, release };
      releases.add(release.resolve); return { entered: entered.promise, release: release.resolve };
    },
  };
}
type Fixture = ReturnType<typeof fixture>;
async function pair(f: Fixture) {
  const permit = await f.auth.issuePairing();
  return f.auth.claim({ pairingSecret: permit.pairingSecret, installationId: 'installation.read-retry',
    deviceName: '合成设备' }, 'pair.read-retry');
}
async function rejects(promise: Promise<unknown>, retryable: boolean,
                       status: MobileServiceError['status'] = 503, code: MobileServiceError['code'] = 'BUSY') {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof MobileServiceError);
    assert.equal(error.status, status); assert.equal(error.code, code); assert.equal(error.retryable, retryable);
    assert.equal(error.retryAfterMs, undefined); assert.equal(Object.hasOwn(error, 'cause'), false);
    return true;
  });
}

for (const [name, failure] of [
  ['未发送', () => new MobileAuthPersistenceError('not-sent')],
  ['读回未知', () => new MobileAuthPersistenceError('unknown')],
  ['Owner忙', () => new MobileServiceError(503, 'BUSY')],
] as const) {
  test(`只读${name}明确可重试，下一请求完整读取且不写盘或旋转身份`, async t => {
    const f = fixture(t), tokens = await pair(f), principal = await f.auth.authenticate(tokens.accessToken);
    const stored = f.snapshot(), before = { ...f.counts }; f.failLoad(failure());
    await rejects(f.auth.serverInfo(), true);
    assert.equal((await f.auth.serverInfo()).serverId, SERVER);
    assert.equal(f.counts.loads, before.loads + 2);
    await f.auth.assertCurrent(principal);
    assert.equal((await f.auth.authenticate(tokens.accessToken)).deviceEpoch, principal.deviceEpoch);
    assert.equal(f.counts.saves, before.saves); assert.equal(f.counts.commits, before.commits);
    assert.deepEqual(f.snapshot(), stored);
  });
}

test('未提交UNKNOWN写期间的暂态读仍不可重试，不补写候选或猜测释放', async t => {
  const f = fixture(t), tokens = await pair(f), stored = f.snapshot();
  f.failWrite('unknown-before');
  await rejects(f.auth.refresh({ refreshToken: tokens.refreshToken }, 'renew.original'), false);
  const writes = f.counts.saves;
  f.failLoad(new MobileAuthPersistenceError('unknown'));
  await rejects(f.auth.serverInfo(), false);
  await rejects(f.auth.refresh({ refreshToken: tokens.refreshToken }, 'renew.original'), false);
  assert.equal(f.counts.saves, writes); assert.deepEqual(f.snapshot(), stored);
});

test('已提交UNKNOWN写的读暂错仍不可重试，原key核对后只回原回执', async t => {
  const f = fixture(t), tokens = await pair(f);
  f.failWrite('unknown-after');
  await rejects(f.auth.refresh({ refreshToken: tokens.refreshToken }, 'renew.original'), false);
  const committed = f.snapshot(), writes = f.counts.saves, commits = f.counts.commits;
  f.failLoad(new MobileServiceError(503, 'BUSY'));
  await rejects(f.auth.serverInfo(), false);
  const first = await f.auth.refresh({ refreshToken: tokens.refreshToken }, 'renew.original');
  assert.deepEqual(await f.auth.refresh({ refreshToken: tokens.refreshToken }, 'renew.original'), first);
  assert.equal(first.deviceId, tokens.deviceId); assert.notEqual(first.refreshToken, tokens.refreshToken);
  assert.equal(f.counts.saves, writes); assert.equal(f.counts.commits, commits); assert.deepEqual(f.snapshot(), committed);
});

test('未知load异常保持fatal且不通过下一份正常记录恢复', async t => {
  const f = fixture(t); await pair(f);
  f.failLoad(new Error('合成未知读取异常')); await rejects(f.auth.serverInfo(), false);
  const reads = f.counts.loads; await rejects(f.auth.serverInfo(), false);
  assert.equal(f.counts.loads, reads);
});

test('坏密文仍fatal，恢复正常字节也不能洗白', async t => {
  const f = fixture(t); await pair(f); const original = f.snapshot(), broken = f.snapshot();
  assert.equal(broken.kind, 'sealed');
  if (broken.kind !== 'sealed') throw new Error('合成存储缺少密文。');
  broken.sealed[28] = broken.sealed[28]! ^ 1; f.restore(broken);
  await rejects(f.auth.serverInfo(), false); const reads = f.counts.loads;
  f.restore(original); await rejects(f.auth.serverInfo(), false); assert.equal(f.counts.loads, reads);
});

test('close与暂态load交错不发布可重试信号，原tail自然收口', async t => {
  const f = fixture(t); await pair(f); const gate = f.holdLoad();
  f.failLoad(new MobileAuthPersistenceError('unknown'));
  const result = rejects(f.auth.serverInfo(), false); await gate.entered;
  const closed = f.auth.close(); gate.release(); await result; await closed;
  const reads = f.counts.loads; await rejects(f.auth.serverInfo(), false); assert.equal(f.counts.loads, reads);
});

test('首个暂错释放原顺序尾，已排队读取独立fresh成功', async t => {
  const f = fixture(t); await pair(f); const stored = f.snapshot(), gate = f.holdLoad();
  f.failLoad(new MobileAuthPersistenceError('not-sent'));
  const first = rejects(f.auth.serverInfo(), true); await gate.entered;
  const second = f.auth.serverInfo(); gate.release(); await first;
  assert.equal((await second).serverId, SERVER); assert.deepEqual(f.snapshot(), stored);
});

test('save明确未发送仍不自动重试，显式原key回执只提交一次', async t => {
  const f = fixture(t), tokens = await pair(f), before = f.counts.commits;
  f.failWrite('not-sent'); await rejects(f.auth.refresh({ refreshToken: tokens.refreshToken }, 'renew.original'), false);
  assert.equal(f.counts.commits, before);
  const first = await f.auth.refresh({ refreshToken: tokens.refreshToken }, 'renew.original');
  assert.deepEqual(await f.auth.refresh({ refreshToken: tokens.refreshToken }, 'renew.original'), first);
  assert.equal(f.counts.commits, before + 1);
});

test('暂错后的设备撤销继续403，不借可重试信号保留授权', async t => {
  const f = fixture(t), tokens = await pair(f), principal = await f.auth.authenticate(tokens.accessToken);
  f.failLoad(new MobileServiceError(503, 'BUSY')); await rejects(f.auth.serverInfo(), true);
  await f.auth.revokeDevice(tokens.deviceId);
  await rejects(f.auth.assertDeviceCurrent(tokens.deviceId, principal.deviceEpoch), false, 403, 'DEVICE_REVOKED');
  await rejects(f.auth.authenticate(tokens.accessToken), false, 401, 'UNAUTHORIZED');
});
