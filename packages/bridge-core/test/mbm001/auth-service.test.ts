import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import type { MobilePairingClaim, MobileTokenPair } from '@music-bridge/contracts';
import { createMobileAuthService, type MobileAuthServiceOptions } from '../../src/mobile/auth-service.js';
import {
  MOBILE_AUTH_MAX_DEVICES, MOBILE_AUTH_MAX_PAIRINGS, MOBILE_AUTH_MAX_RECEIPTS,
  MOBILE_AUTH_SEALED_MAX_BYTES, MOBILE_AUTH_STATE_MAX_BYTES,
  MobileAuthPersistenceError, MobileServiceError,
  type MobileAuthCrypto, type MobileAuthPersistence, type MobileAuthService,
  type MobileSealedState,
} from '../../src/mobile/types.js';

const START = 1_700_000_000_000;
const PAIRING_MS = 300_000, ACCESS_MS = 900_000, REFRESH_MS = 2_592_000_000;
const SERVER = 'server-owned', DATASET = 'dataset-owned';
type Sealed = Extract<MobileSealedState, { kind: 'sealed' }>;
type Fault = 'not-sent' | 'unknown-before' | 'unknown-after' | 'malformed-ack';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function cloneState(state: MobileSealedState): MobileSealedState {
  return state.kind === 'missing' ? { ...state } : { ...state, sealed: new Uint8Array(state.sealed) };
}
function aad(revision: number): Uint8Array {
  return Buffer.from(JSON.stringify(['MBM001_AUTH_STATE_V1', SERVER, DATASET, revision]));
}
function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function array(state: Record<string, unknown>, key: string): unknown[] {
  const value = state[key]; assert.ok(Array.isArray(value)); return value;
}
function pairShape(pair: MobileTokenPair) {
  assert.deepEqual(Object.keys(pair).sort(), [
    'accessExpiresAt', 'accessToken', 'deviceId', 'refreshExpiresAt', 'refreshToken', 'serverId',
  ]);
  assert.equal(pair.serverId, SERVER);
  assert.notEqual(pair.accessToken, pair.refreshToken);
  assert.equal(pair.accessExpiresAt, new Date(START + ACCESS_MS).toISOString());
  assert.equal(pair.refreshExpiresAt, new Date(START + REFRESH_MS).toISOString());
}
async function refuses(promise: Promise<unknown>, status: MobileServiceError['status'], code: MobileServiceError['code']) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof MobileServiceError);
    assert.equal(error.status, status); assert.equal(error.code, code);
    assert.equal(error.message, '移动服务当前无法完成请求。');
    assert.equal(Object.hasOwn(error, 'cause'), false);
    return true;
  });
}

/** 真实 Node AES-GCM 加受控内存 CAS 端口；不是磁盘、HTTP 或 safeStorage 的证明。 */
function fixture(t: TestContext) {
  const encryptionKey = randomBytes(32);
  const crypto: MobileAuthCrypto = {
    seal(plain, associated) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
      cipher.setAAD(associated);
      const body = Buffer.concat([cipher.update(plain), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    open(sealed, associated) {
      const decipher = createDecipheriv('aes-256-gcm', encryptionKey, sealed.subarray(0, 12));
      decipher.setAAD(associated); decipher.setAuthTag(sealed.subarray(12, 28));
      return Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]);
    },
  };
  let stored: MobileSealedState = { kind: 'missing', datasetId: DATASET, revision: 0 };
  let clock = START, fault: Fault | undefined;
  let saveGate: ReturnType<typeof barrier> | undefined, loadGate: ReturnType<typeof barrier> | undefined;
  const releases = new Set<() => void>(), services: MobileAuthService[] = [];
  const counts = { loads: 0, attempts: 0, commits: 0, random: 0 };
  function barrier() {
    const entered = deferred(), released = deferred();
    const release = () => { released.resolve(); releases.delete(release); };
    releases.add(release);
    return { entered: entered.promise, release, markEntered: entered.resolve, wait: released.promise };
  }
  const persistence: MobileAuthPersistence = {
    async load(datasetId) {
      assert.equal(datasetId, DATASET); counts.loads++;
      const held = loadGate; loadGate = undefined;
      if (held) { held.markEntered(); await held.wait; }
      return cloneState(stored);
    },
    async save(request) {
      assert.equal(request.datasetId, DATASET); counts.attempts++;
      // 接收时捕获整份密文，不能依赖调用者之后清零的缓冲区。
      const captured = { ...request, sealed: new Uint8Array(request.sealed) };
      const held = saveGate, effect = fault; saveGate = undefined; fault = undefined;
      if (held) { held.markEntered(); await held.wait; }
      if (effect === 'not-sent') throw new MobileAuthPersistenceError('not-sent');
      if (effect === 'unknown-before') throw new MobileAuthPersistenceError('unknown');
      if (stored.revision !== captured.expectedRevision) {
        return { kind: 'conflict', datasetId: DATASET, currentRevision: stored.revision };
      }
      stored = { kind: 'sealed', datasetId: DATASET, revision: captured.expectedRevision + 1,
        commitId: captured.commitId, sealed: captured.sealed };
      counts.commits++;
      if (effect === 'unknown-after') throw new MobileAuthPersistenceError('unknown');
      if (effect === 'malformed-ack') return { kind: 'saved', datasetId: DATASET,
        revision: stored.revision, commitId: 'wrong-commit' };
      return { kind: 'saved', datasetId: DATASET, revision: stored.revision, commitId: stored.commitId };
    },
  };
  function open(overrides: Partial<MobileAuthServiceOptions> = {}) {
    const service = createMobileAuthService({ persistence, crypto, serverId: SERVER, datasetId: DATASET,
      displayName: '自有测试桥', environment: 'development', now: () => clock,
      randomToken: () => { counts.random++; return randomBytes(32).toString('base64url'); }, ...overrides });
    services.push(service); return service;
  }
  function sealed(): Sealed {
    assert.equal(stored.kind, 'sealed');
    if (stored.kind !== 'sealed') throw new Error('测试尚无密文记录。');
    return { ...stored, sealed: new Uint8Array(stored.sealed) };
  }
  function plain(): Record<string, unknown> {
    const row = sealed(), bytes = crypto.open(row.sealed, aad(row.revision));
    try { return object(JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown); }
    finally { bytes.fill(0); }
  }
  function edit(mutate: (state: Record<string, unknown>) => void) {
    const row = sealed(), state = plain(); mutate(state);
    const bytes = Buffer.from(JSON.stringify(state));
    try { stored = { ...row, sealed: crypto.seal(bytes, aad(row.revision)) }; }
    finally { bytes.fill(0); }
  }
  t.after(async () => {
    for (const release of [...releases]) release();
    await Promise.all(services.map(service => service.close()));
    encryptionKey.fill(0);
    if (stored.kind === 'sealed') stored.sealed.fill(0);
  });
  const auth = open();
  return { auth, open, crypto, persistence, counts, plain, edit, sealed,
    advance: (milliseconds: number) => { clock += milliseconds; },
    setClock: (milliseconds: number) => { clock = milliseconds; },
    snapshot: () => cloneState(stored), restore: (state: MobileSealedState) => { stored = cloneState(state); },
    failNext: (next: Fault) => { fault = next; },
    blockSave: () => { const held = barrier(); saveGate = held; return held; },
    blockLoad: () => { const held = barrier(); loadGate = held; return held; },
  };
}
type Fixture = ReturnType<typeof fixture>;
async function pair(f: Fixture, installationId = 'installation-one', service = f.auth, claimKey = `claim-${installationId}`) {
  const permit = await service.issuePairing();
  const body: MobilePairingClaim = { pairingSecret: permit.pairingSecret, installationId, deviceName: '自有设备' };
  return { body, key: claimKey, tokenPair: await service.claim(body, claimKey) };
}

test('匿名服务身份只读，非法闭集或可执行请求不会产生许可和回执', async t => {
  const f = fixture(t);
  assert.deepEqual(await f.auth.serverInfo(), { serverId: SERVER, displayName: '自有测试桥',
    contractVersion: '0.1.0', environment: 'development' });
  assert.deepEqual(await f.auth.devices(), []);
  assert.equal(f.counts.attempts, 0); assert.equal(f.snapshot().kind, 'missing');
  const permit = await f.auth.issuePairing();
  const body: MobilePairingClaim = { pairingSecret: permit.pairingSecret, installationId: 'installation-one', deviceName: '自有设备' };
  const before = f.snapshot(), attempts = f.counts.attempts;
  let getterCalls = 0;
  const getterBody = Object.defineProperty({ ...body }, 'deviceName', { enumerable: true,
    get() { getterCalls++; return '不应求值'; } });
  const symbolBody = { ...body, [Symbol('非数据')]: true };
  for (const invalidBody of [getterBody, symbolBody, { ...body, unknown: true }, { ...body, installationId: 'installation-one\n' }]) {
    await refuses(f.auth.claim(invalidBody, 'same-key'), 400, 'INVALID_REQUEST');
  }
  await refuses(f.auth.claim(body, 'key\n'), 400, 'INVALID_REQUEST');
  assert.equal(getterCalls, 0); assert.equal(f.counts.attempts, attempts); assert.deepEqual(f.snapshot(), before);
});

test('配对原 key 和完整 body 返回原六字段回执，改 body 冲突且不延长期限', async t => {
  const f = fixture(t), first = await pair(f);
  pairShape(first.tokenPair);
  const before = f.snapshot(), counts = { ...f.counts };
  f.advance(10_000);
  assert.deepEqual(await f.auth.claim(first.body, first.key), first.tokenPair);
  await refuses(f.auth.claim({ ...first.body, deviceName: '更改名称' }, first.key), 409, 'IDEMPOTENCY_CONFLICT');
  assert.equal(f.counts.attempts, counts.attempts); assert.equal(f.counts.random, counts.random);
  assert.deepEqual(f.snapshot(), before);
  const row = f.sealed();
  assert.equal(Buffer.from(row.sealed).includes(Buffer.from(first.tokenPair.accessToken)), false);
  assert.equal(Buffer.from(row.sealed).includes(Buffer.from(first.body.pairingSecret)), false);
});

test('同 key 同 body 并发只受理一次，许可单次使用和300秒到期均真实拒绝', async t => {
  const f = fixture(t), permit = await f.auth.issuePairing();
  const body = { pairingSecret: permit.pairingSecret, installationId: 'installation-one', deviceName: '自有设备' };
  const before = f.counts.commits;
  const [a, b] = await Promise.all([f.auth.claim(body, 'claim-one'), f.auth.claim(body, 'claim-one')]);
  assert.deepEqual(a, b); assert.equal(f.counts.commits, before + 1);
  await refuses(f.auth.claim(body, 'another-key'), 401, 'UNAUTHORIZED');
  const expired = await f.auth.issuePairing(); f.advance(PAIRING_MS);
  const snapshot = f.snapshot();
  await refuses(f.auth.claim({ ...body, pairingSecret: expired.pairingSecret, installationId: 'installation-expired' }, 'expired'), 401, 'UNAUTHORIZED');
  assert.deepEqual(f.snapshot(), snapshot);
  assert.deepEqual(await f.auth.claim(body, 'claim-one'), a);
});

test('refresh 原回执先查且原子轮换，旧access和晚到fence失效，后续轮换不复活旧回执', async t => {
  const f = fixture(t), first = await pair(f), oldPrincipal = await f.auth.authenticate(first.tokenPair.accessToken);
  const body = { refreshToken: first.tokenPair.refreshToken }, key = 'refresh-one';
  const rotated = await f.auth.refresh(body, key);
  assert.equal(rotated.deviceId, first.tokenPair.deviceId);
  assert.notEqual(rotated.accessToken, first.tokenPair.accessToken); assert.notEqual(rotated.refreshToken, body.refreshToken);
  await refuses(f.auth.authenticate(first.tokenPair.accessToken), 401, 'UNAUTHORIZED');
  await refuses(f.auth.assertCurrent(oldPrincipal), 401, 'UNAUTHORIZED');
  const current = await f.auth.authenticate(rotated.accessToken);
  assert.equal(current.generation, oldPrincipal.generation + 1); assert.equal(current.deviceEpoch, oldPrincipal.deviceEpoch);
  const snapshot = f.snapshot(), attempts = f.counts.attempts, random = f.counts.random;
  assert.deepEqual(await f.auth.refresh(body, key), rotated);
  await refuses(f.auth.refresh({ refreshToken: rotated.refreshToken }, key), 409, 'IDEMPOTENCY_CONFLICT');
  assert.equal(f.counts.attempts, attempts); assert.equal(f.counts.random, random); assert.deepEqual(f.snapshot(), snapshot);
  await f.auth.refresh({ refreshToken: rotated.refreshToken }, 'refresh-two');
  await refuses(f.auth.refresh(body, key), 401, 'UNAUTHORIZED');
  await refuses(f.auth.claim(first.body, first.key), 401, 'UNAUTHORIZED');
  await refuses(f.auth.assertCurrent(current), 401, 'UNAUTHORIZED');
});

test('900秒access到期不延长原回执，30天refresh到期不得从历史凭据新签', async t => {
  const f = fixture(t), first = await pair(f), principal = await f.auth.authenticate(first.tokenPair.accessToken);
  f.advance(ACCESS_MS);
  await refuses(f.auth.authenticate(first.tokenPair.accessToken), 401, 'UNAUTHORIZED');
  await refuses(f.auth.assertCurrent(principal), 401, 'UNAUTHORIZED');
  const before = f.snapshot(), random = f.counts.random;
  assert.deepEqual(await f.auth.claim(first.body, first.key), first.tokenPair);
  assert.deepEqual(f.snapshot(), before); assert.equal(f.counts.random, random);
  f.setClock(START);
  await refuses(f.auth.authenticate(first.tokenPair.accessToken), 401, 'UNAUTHORIZED');
  f.setClock(START + ACCESS_MS);
  f.advance(REFRESH_MS - ACCESS_MS);
  await refuses(f.auth.claim(first.body, first.key), 401, 'UNAUTHORIZED');
  await refuses(f.auth.refresh({ refreshToken: first.tokenPair.refreshToken }, 'expired-refresh'), 401, 'UNAUTHORIZED');
  assert.deepEqual(f.snapshot(), before); assert.equal(f.counts.random, random);
});

test('同installation新可信许可保deviceId并推进epoch/generation，旧key不被覆盖且logout后可重新配对', async t => {
  const f = fixture(t), first = await pair(f), principal = await f.auth.authenticate(first.tokenPair.accessToken);
  const permit = await f.auth.issuePairing(), body = { ...first.body, pairingSecret: permit.pairingSecret };
  await refuses(f.auth.claim(body, first.key), 409, 'IDEMPOTENCY_CONFLICT');
  const second = await f.auth.claim(body, 'claim-repair'), repaired = await f.auth.authenticate(second.accessToken);
  assert.equal(second.deviceId, first.tokenPair.deviceId);
  assert.equal(repaired.deviceEpoch, principal.deviceEpoch + 1); assert.equal(repaired.generation, principal.generation + 1);
  await refuses(f.auth.assertCurrent(principal), 401, 'UNAUTHORIZED');
  await refuses(f.auth.claim(first.body, first.key), 401, 'UNAUTHORIZED');
  await f.auth.logout(repaired);
  await refuses(f.auth.claim(body, 'claim-repair'), 401, 'UNAUTHORIZED');
  const third = await pair(f, first.body.installationId, f.auth, 'claim-after-logout');
  const reconnected = await f.auth.authenticate(third.tokenPair.accessToken);
  assert.equal(third.tokenPair.deviceId, second.deviceId);
  assert.equal(reconnected.deviceEpoch, repaired.deviceEpoch + 2);
  assert.equal((await f.auth.devices()).length, 1);
});

test('principal是冻结的本实例能力，克隆/跨实例拒绝，logout和撤销在晚到目录发body前生效', async t => {
  const f = fixture(t), a = await pair(f), b = await pair(f, 'installation-two');
  const principal = await f.auth.authenticate(a.tokenPair.accessToken), other = await f.auth.authenticate(b.tokenPair.accessToken);
  assert.equal(Object.isFrozen(principal), true);
  assert.equal(principal.accountDomain, `local:${DATASET}`);
  assert.deepEqual(Object.keys(principal).sort(), ['accessExpiresAt', 'accessTokenHash', 'accountDomain', 'datasetId', 'deviceEpoch', 'deviceId', 'generation', 'serverId']);
  await refuses(f.auth.assertCurrent({ ...principal }), 401, 'UNAUTHORIZED');
  const second = f.open(); await refuses(second.assertCurrent(principal), 401, 'UNAUTHORIZED');
  const secondPrincipal = await second.authenticate(a.tokenPair.accessToken);
  await refuses(f.auth.assertCurrent(secondPrincipal), 401, 'UNAUTHORIZED');
  await f.auth.assertCurrent(principal);
  // 目录异步工作不占auth队列；发送前仍使用同一个真实principal再次核验。
  const directoryReady = deferred();
  const bodyReady = directoryReady.promise.then(() => f.auth.assertCurrent(principal));
  await f.auth.logout(principal); directoryReady.resolve();
  await refuses(bodyReady, 401, 'UNAUTHORIZED');
  await refuses(second.assertCurrent(secondPrincipal), 401, 'UNAUTHORIZED');
  await f.auth.assertCurrent(other);
  await f.auth.revokeDevice(other.deviceId);
  await refuses(f.auth.assertCurrent(other), 401, 'UNAUTHORIZED');
  const cold = f.open();
  await refuses(cold.authenticate(b.tokenPair.accessToken), 401, 'UNAUTHORIZED');
  assert.ok((await cold.devices()).every(device => device.revoked));
});

test('claim未知ACK只有同commitId完整原记录可解除，重新查询不增mint或save', async t => {
  const f = fixture(t), permit = await f.auth.issuePairing();
  const body = { pairingSecret: permit.pairingSecret, installationId: 'installation-one', deviceName: '自有设备' };
  f.failNext('unknown-after');
  await refuses(f.auth.claim(body, 'lost-claim'), 503, 'BUSY');
  const committed = f.snapshot(), attempts = f.counts.attempts, random = f.counts.random;
  const expected = object(array(f.plain(), 'receipts')[0]).tokenPair;
  // 保持commitId/revision及有效密文，只改变一个合法状态字段仍不是原记录。
  f.edit(state => { object(array(state, 'devices')[0]).deviceName = '同提交标记的其它内容'; });
  await refuses(f.auth.claim(body, 'lost-claim'), 503, 'BUSY');
  assert.equal(f.counts.attempts, attempts); assert.equal(f.counts.random, random);
  f.restore(committed);
  assert.deepEqual(await f.auth.claim(body, 'lost-claim'), expected);
  assert.equal(f.counts.attempts, attempts); assert.equal(f.counts.random, random); assert.deepEqual(f.snapshot(), committed);
  const current = await f.auth.authenticate((expected as MobileTokenPair).accessToken);
  assert.equal(current.deviceEpoch, 1);
});

test('refresh未知ACK轮换后旧access立即失效，原body回执对账和冷重开都不再提交', async t => {
  const f = fixture(t), first = await pair(f), principal = await f.auth.authenticate(first.tokenPair.accessToken);
  const body = { refreshToken: first.tokenPair.refreshToken };
  f.failNext('unknown-after'); await refuses(f.auth.refresh(body, 'lost-refresh'), 503, 'BUSY');
  const attempts = f.counts.attempts, random = f.counts.random, committed = f.snapshot();
  const rotatedPair = await f.auth.refresh(body, 'lost-refresh');
  await refuses(f.auth.assertCurrent(principal), 401, 'UNAUTHORIZED');
  await refuses(f.auth.authenticate(first.tokenPair.accessToken), 401, 'UNAUTHORIZED');
  const cold = f.open(); assert.deepEqual(await cold.refresh(body, 'lost-refresh'), rotatedPair);
  assert.equal(f.counts.attempts, attempts); assert.equal(f.counts.random, random); assert.deepEqual(f.snapshot(), committed);
});

test('未落盘UNKNOWN保持封闭，缺记录或另一份有效记录均不得自动补发或新签', async t => {
  const f = fixture(t), permit = await f.auth.issuePairing();
  const body = { pairingSecret: permit.pairingSecret, installationId: 'installation-one', deviceName: '自有设备' };
  f.failNext('unknown-before'); await refuses(f.auth.claim(body, 'unknown-before'), 503, 'BUSY');
  const old = f.snapshot(), attempts = f.counts.attempts, random = f.counts.random;
  for (let count = 0; count < 2; count++) {
    await refuses(f.auth.claim(body, 'unknown-before'), 503, 'BUSY');
    await refuses(f.auth.issuePairing(), 503, 'BUSY');
  }
  f.restore({ kind: 'missing', datasetId: DATASET, revision: 0 });
  await refuses(f.auth.serverInfo(), 503, 'BUSY');
  f.restore(old);
  const another = f.open(); await another.issuePairing();
  const unrelated = f.snapshot();
  await refuses(f.auth.claim(body, 'unknown-before'), 503, 'BUSY');
  assert.equal(f.counts.attempts, attempts + 1); assert.equal(f.counts.random, random + 1);
  assert.deepEqual(f.snapshot(), unrelated);
});

test('明确not-sent不自动重save，调用者显式原key/body重试才产生一个确定回执', async t => {
  const f = fixture(t), permit = await f.auth.issuePairing();
  const body = { pairingSecret: permit.pairingSecret, installationId: 'installation-one', deviceName: '自有设备' };
  const old = f.snapshot(), commits = f.counts.commits;
  f.failNext('not-sent'); await refuses(f.auth.claim(body, 'not-sent'), 503, 'BUSY');
  assert.deepEqual(f.snapshot(), old); assert.equal(f.counts.commits, commits);
  const attempts = f.counts.attempts, random = f.counts.random;
  await f.auth.serverInfo(); assert.equal(f.counts.attempts, attempts); assert.equal(f.counts.random, random);
  const result = await f.auth.claim(body, 'not-sent'); pairShape(result);
  assert.equal(f.counts.attempts, attempts + 1); assert.equal(f.counts.commits, commits + 1);
  const stable = f.snapshot(); assert.deepEqual(await f.auth.claim(body, 'not-sent'), result); assert.deepEqual(f.snapshot(), stable);
});

test('冷重开保留完整回执，AAD跨server/dataset、损坏密文或未知私有字段均封闭拒绝', async t => {
  const f = fixture(t), first = await pair(f), snapshot = f.snapshot(), attempts = f.counts.attempts;
  const cold = f.open(); assert.deepEqual(await cold.claim(first.body, first.key), first.tokenPair);
  assert.equal(f.counts.attempts, attempts);
  const wrongServer = f.open({ serverId: 'another-server' }); await refuses(wrongServer.serverInfo(), 503, 'BUSY');
  const row = f.sealed(); row.sealed[28] = (row.sealed[28] ?? 0) ^ 1; f.restore(row);
  const corrupted = f.open(); await refuses(corrupted.serverInfo(), 503, 'BUSY');
  f.restore(snapshot);
  f.edit(state => { state.unapproved = true; });
  const unknownField = f.open(); await refuses(unknownField.serverInfo(), 503, 'BUSY');
  f.restore(snapshot);
  const crossDatasetPersistence: MobileAuthPersistence = {
    async load(datasetId) { return { ...f.sealed(), datasetId }; },
    async save() { throw new Error('此负例不得写入。'); },
  };
  const wrongDataset = f.open({ datasetId: 'another-dataset', persistence: crossDatasetPersistence });
  await refuses(wrongDataset.serverInfo(), 503, 'BUSY');
  assert.deepEqual(f.snapshot(), snapshot); assert.equal(f.counts.attempts, attempts);
  await cold.assertCurrent(await cold.authenticate(first.tokenPair.accessToken));
});

test('两个实例争用同revision时CAS拒绝落后写入，不丢新记录且不自动重签', async t => {
  const f = fixture(t), permit = await f.auth.issuePairing(), other = f.open();
  const body = { pairingSecret: permit.pairingSecret, installationId: 'installation-one', deviceName: '自有设备' };
  const gate = f.blockSave(), losing = f.auth.claim(body, 'same-claim'); await gate.entered;
  const winner = await other.claim(body, 'same-claim');
  const committed = f.snapshot(), attempts = f.counts.attempts, random = f.counts.random;
  gate.release(); await refuses(losing, 409, 'REVISION_CONFLICT');
  assert.deepEqual(f.snapshot(), committed); assert.equal(f.counts.commits, 2);
  assert.deepEqual(await f.auth.claim(body, 'same-claim'), winner);
  assert.equal(f.counts.attempts, attempts); assert.equal(f.counts.random, random);
});

test('close同步封新请求并等待实际load/save完成，不取消未知提交或留下后台任务', async t => {
  const f = fixture(t), loadGate = f.blockLoad(), reading = f.auth.serverInfo(); await loadGate.entered;
  const firstClose = f.auth.close(); let closed = false; void firstClose.then(() => { closed = true; });
  assert.equal(f.auth.close(), firstClose);
  await refuses(f.auth.issuePairing(), 503, 'BUSY'); assert.equal(closed, false);
  loadGate.release(); await reading; await firstClose; assert.equal(closed, true);
  const service = f.open(), saveGate = f.blockSave(), writing = service.issuePairing(); await saveGate.entered;
  const secondClose = service.close(); let savedClose = false; void secondClose.then(() => { savedClose = true; });
  await refuses(service.serverInfo(), 503, 'BUSY'); assert.equal(savedClose, false);
  saveGate.release(); await writing; await secondClose; assert.equal(savedClose, true);
  assert.equal(f.counts.commits, 1);
  await refuses(service.devices(), 503, 'BUSY');
});

test('32未过期许可及32稳定设备上限返回BUSY，既存许可与回执不被静默驱逐', async t => {
  const f = fixture(t), permits = [];
  for (let i = 0; i < MOBILE_AUTH_MAX_PAIRINGS; i++) permits.push(await f.auth.issuePairing());
  const full = f.snapshot(), attempts = f.counts.attempts;
  await refuses(f.auth.issuePairing(), 503, 'BUSY'); assert.deepEqual(f.snapshot(), full); assert.equal(f.counts.attempts, attempts);
  const first = await f.auth.claim({ pairingSecret: permits[0]!.pairingSecret, installationId: 'installation-0', deviceName: '自有设备' }, 'claim-0');
  for (let i = 1; i < MOBILE_AUTH_MAX_DEVICES; i++) {
    await f.auth.claim({ pairingSecret: permits[i]!.pairingSecret, installationId: `installation-${i}`, deviceName: '自有设备' }, `claim-${i}`);
  }
  const extra = await f.auth.issuePairing(), capped = f.snapshot(), before = { ...f.counts };
  await refuses(f.auth.claim({ pairingSecret: extra.pairingSecret, installationId: 'installation-over', deviceName: '自有设备' }, 'claim-over'), 503, 'BUSY');
  assert.deepEqual(f.snapshot(), capped); assert.equal(f.counts.attempts, before.attempts); assert.equal(f.counts.random, before.random);
  const devices = await f.auth.devices(); assert.equal(devices.length, MOBILE_AUTH_MAX_DEVICES);
  for (const device of devices) assert.deepEqual(Object.keys(device).sort(), ['createdAt', 'deviceId', 'deviceName', 'revoked']);
  assert.deepEqual(await f.auth.claim({ pairingSecret: permits[0]!.pairingSecret, installationId: 'installation-0', deviceName: '自有设备' }, 'claim-0'), first);
  f.advance(PAIRING_MS); const fresh = await f.auth.issuePairing(); assert.notEqual(fresh.pairingSecret, extra.pairingSecret);
  assert.equal(array(f.plain(), 'permits').length, 1); assert.equal(array(f.plain(), 'receipts').length, MOBILE_AUTH_MAX_DEVICES);
});

test('2MiB明文、4MiB密文及4096回执独立有限闭集，超限不写入或驱逐原回执', async t => {
  const f = fixture(t), first = await pair(f), snapshot = f.snapshot(), before = { ...f.counts };
  const oversizedSeal: MobileAuthCrypto = {
    open: (sealed, associated) => f.crypto.open(sealed, associated),
    seal(plain, associated) { const genuine = f.crypto.seal(plain, associated);
      const excessive = new Uint8Array(MOBILE_AUTH_SEALED_MAX_BYTES + 1); excessive.set(genuine); return excessive; },
  };
  const cannotSeal = f.open({ crypto: oversizedSeal }); await refuses(cannotSeal.issuePairing(), 503, 'BUSY');
  assert.equal(f.counts.attempts, before.attempts); assert.deepEqual(f.snapshot(), snapshot);
  const oversizedOpen: MobileAuthCrypto = {
    seal: (plain, associated) => f.crypto.seal(plain, associated),
    open(sealed, associated) { f.crypto.open(sealed, associated).fill(0); return new Uint8Array(MOBILE_AUTH_STATE_MAX_BYTES + 1); },
  };
  const cannotOpen = f.open({ crypto: oversizedOpen }); await refuses(cannotOpen.serverInfo(), 503, 'BUSY');
  f.edit(state => {
    const receipts = array(state, 'receipts'), original = object(receipts[0]);
    // 明文上限可能先于4096行触发；此负例只证明超出闭集的完整记录不能准入。
    state.receipts = Array.from({ length: MOBILE_AUTH_MAX_RECEIPTS + 1 }, (_, index) => ({ ...original,
      keyHash: index.toString(16).padStart(64, '0') }));
  });
  const excessiveReceipts = f.open(); await refuses(excessiveReceipts.serverInfo(), 503, 'BUSY');
  f.restore(snapshot); assert.deepEqual(await f.auth.claim(first.body, first.key), first.tokenPair);
  assert.equal(f.counts.attempts, before.attempts); assert.deepEqual(f.snapshot(), snapshot);
});

test('错误ACK不能当确定成功，原记录可核回；已观察revision倒退或缺失必须拒绝', async t => {
  const f = fixture(t), permit = await f.auth.issuePairing(), old = f.snapshot();
  const body = { pairingSecret: permit.pairingSecret, installationId: 'installation-one', deviceName: '自有设备' };
  f.failNext('malformed-ack'); await refuses(f.auth.claim(body, 'bad-ack'), 503, 'BUSY');
  const attempts = f.counts.attempts, committed = f.snapshot();
  const result = await f.auth.claim(body, 'bad-ack'); pairShape(result);
  assert.equal(f.counts.attempts, attempts); assert.deepEqual(f.snapshot(), committed);
  f.restore(old); await refuses(f.auth.serverInfo(), 503, 'BUSY');
  f.restore(committed); await refuses(f.auth.authenticate(result.accessToken), 503, 'BUSY');
  const observer = f.open(); await observer.serverInfo();
  f.restore({ kind: 'missing', datasetId: DATASET, revision: 0 });
  await refuses(observer.serverInfo(), 503, 'BUSY');
  f.restore(committed); assert.equal(f.counts.attempts, attempts);
});
