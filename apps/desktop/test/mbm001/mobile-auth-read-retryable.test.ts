import assert from 'node:assert/strict';
import test, { before, after, type TestContext } from 'node:test';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { isMobileErrorEnvelope } from '@music-bridge/contracts';
import { createMobileBackend } from '../../src/main/mobile-backend.js';
import { createMobileHttpsServer } from '../../src/main/mobile-https-server.js';
import { loadOrCreateMobileIdentity, type MobileTlsIdentity } from '../../src/main/mobile-tls-identity.js';
import { MobileAuthPersistenceError, MobileServiceError,
  type MobileOwnerPrivateRequest, type MobileOwnerPrivateResult, type MobileSealedState,
} from '../../../../packages/bridge-core/src/mobile/types.js';
import { isMobileOwnerPrivateRequest } from '../../../../packages/bridge-core/src/mobile/owner-protocol.js';

const SERVER = 'server.auth-read-fixture', DATASET = 'dataset.auth-read-fixture';
let identity: MobileTlsIdentity, owned = '';
before(async () => {
  const temporaryRoot = process.env.TMPDIR;
  if (!temporaryRoot?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/')) {
    throw new Error('合成TLS材料必须保存在外置工作目录。');
  }
  owned = await mkdtemp(path.join(temporaryRoot, 'auth-read-retry-'));
  const key = randomBytes(32);
  identity = await loadOrCreateMobileIdentity({ directory: path.join(owned, 'identity'), hosts: ['127.0.0.1'],
    secretProtector: {
      encryptString(value) {
        const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
        const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), body]);
      },
      decryptString(value) {
        const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
        decipher.setAuthTag(value.subarray(12, 28));
        return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
      },
    } });
  key.fill(0);
});
after(async () => { if (owned) await rm(owned, { recursive: true, force: true }); });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

/** 真实Main/auth/公开codec/HTTPS；只有Owner存储是合成内存，且只绑定loopback。 */
async function fixture(t: TestContext, observeIdentitySignal?: (signal: AbortSignal) => void) {
  let stored: MobileSealedState = { kind: 'missing', datasetId: DATASET, revision: 0 };
  let current = true, loadFault: { ordinal: number; error: unknown } | undefined;
  let afterSave: (() => void) | undefined;
  let nextLoad: { entered(): void; wait: Promise<void>; settled(): void; release(): void } | undefined;
  const loadReleases = new Set<() => void>();
  const counts = { loads: 0, saves: 0 };
  const requestOwner = async (request: MobileOwnerPrivateRequest): Promise<MobileOwnerPrivateResult> => {
    assert.equal(isMobileOwnerPrivateRequest(request), true);
    assert.equal(request.datasetId, DATASET);
    if (request.kind === 'load') {
      counts.loads++;
      const held = nextLoad; nextLoad = undefined;
      try {
        if (held) { held.entered(); await held.wait; }
        if (loadFault?.ordinal === counts.loads) {
          const { error } = loadFault; loadFault = undefined;
          if (error === 'owner-busy') return { kind: 'mobile-error', status: 503, code: 'BUSY', retryable: false, outcome: null };
          throw error;
        }
        return structuredClone(stored);
      } finally {
        if (held) { loadReleases.delete(held.release); held.settled(); }
      }
    }
    if (request.kind === 'save') {
      const value = request.request;
      if (value.expectedRevision !== stored.revision) {
        return { kind: 'conflict', datasetId: DATASET, currentRevision: stored.revision };
      }
      stored = { kind: 'sealed', datasetId: DATASET, revision: stored.revision + 1,
        commitId: value.commitId, sealed: new Uint8Array(value.sealed) };
      counts.saves++;
      const hook = afterSave; afterSave = undefined; hook?.();
      return { kind: 'saved', datasetId: DATASET, revision: stored.revision, commitId: stored.commitId };
    }
    throw new Error('此合成认证夹具不接受其它Owner操作。');
  };
  const handle = createMobileBackend({ serverId: SERVER, datasetId: DATASET,
    authKey: new Uint8Array(32).fill(91), displayName: '合成认证暂错', environment: 'development', requestOwner,
    assertCurrent() { if (!current) throw new MobileServiceError(503, 'BUSY'); },
    resizeArtwork() { throw new Error('认证测试不能读取封面。'); } });
  const server = createMobileHttpsServer({ tls: { key: identity.privateKeyPEM, cert: identity.certificatePEM },
    host: '127.0.0.1', port: 0, backend: { dispatch(input) {
      if (input.operation === 'getServer') observeIdentitySignal?.(input.signal);
      return handle.backend.dispatch(input);
    } } });
  t.after(async () => {
    for (const release of loadReleases) release();
    await server.close(); await handle.close();
  });
  const listening = await server.start();
  async function read(target = '/mobile/v1/server', options: { body?: unknown; key?: string; signal?: AbortSignal } = {}) {
    const url = new URL(listening.baseUrl), body = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body));
    return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const request = httpsRequest({ hostname: '127.0.0.1', port: url.port, path: target,
        method: body === undefined ? 'GET' : 'POST', ca: identity.certificatePEM, agent: false,
        ...(options.signal ? { signal: options.signal } : {}),
        headers: { Host: url.host, Connection: 'close', ...(body === undefined ? {} : {
          'Content-Type': 'application/json', 'Content-Length': String(body.length),
        }), ...(options.key ? { 'Idempotency-Key': options.key } : {}) } }, response => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        response.once('error', reject);
        response.once('aborted', () => reject(new Error('合成响应已关闭。')));
        response.once('end', () => {
          try { resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }); }
          catch { reject(new Error('合成响应不符合JSON合同。')); }
        });
      });
      request.once('error', reject); request.setTimeout(5000, () => request.destroy(new Error('合成请求已超时。')));
      request.end(body);
    });
  }
  return { handle, read, counts, snapshot: () => structuredClone(stored),
    blockNextLoad() {
      assert.equal(nextLoad, undefined);
      const entered = deferred(), released = deferred(), settled = deferred();
      const release = () => released.resolve();
      loadReleases.add(release);
      nextLoad = { entered: entered.resolve, wait: released.promise, settled: settled.resolve, release };
      return { entered: entered.promise, release, settled: settled.promise };
    },
    failOnLoad(ordinal: number, error: unknown) { loadFault = { ordinal, error }; },
    afterSave(hook: () => void) { afterSave = hook; },
    invalidate() { current = false; },
  };
}
function busy(response: { status: number; body: unknown }, retryable: boolean) {
  assert.equal(response.status, 503); assert.ok(isMobileErrorEnvelope(response.body));
  assert.equal(response.body.error.code, 'BUSY'); assert.equal(response.body.error.retryable, retryable);
  assert.deepEqual(Object.keys(response.body.error).sort(), ['code', 'message', 'requestId', 'retryable']);
}

for (const [name, error] of [
  ['未发送', () => new MobileAuthPersistenceError('not-sent')],
  ['读回未知', () => new MobileAuthPersistenceError('unknown')],
  ['Owner忙', () => 'owner-busy'],
] as const) {
  test(`实际GET server首读${name}的完整503封套可重试，随后fresh读取成功`, async t => {
    const f = await fixture(t); f.failOnLoad(1, error());
    busy(await f.read(), true); assert.equal(f.counts.loads, 1);
    assert.equal((await f.read()).status, 200); assert.equal(f.counts.loads, 3);
    assert.equal(f.counts.saves, 0);
  });
}

test('实际HTTPS身份首读中取消HTTP只结束原响应，Owner收口后fresh身份不变且零save', { timeout: 10_000 }, async t => {
  const serverAborted = deferred();
  const f = await fixture(t, signal => signal.addEventListener('abort', serverAborted.resolve, { once: true }));
  const stored = f.snapshot(), held = f.blockNextLoad(), controller = new AbortController();
  const first = f.read('/mobile/v1/server', { signal: controller.signal }).then(
    value => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
  try {
    await Promise.race([held.entered, first.then(result => {
      if (!result.ok) throw result.error;
      throw new Error('首次身份请求不应在Owner读取屏障释放前返回。');
    })]);
    assert.equal(f.counts.loads, 1);
    controller.abort();
    const cancelled = await first;
    assert.equal(cancelled.ok, false);
    if (cancelled.ok) throw new Error('已取消的HTTPS请求不应返回身份正文。');
    assert.ok(cancelled.error instanceof Error && cancelled.error.name === 'AbortError');
    await serverAborted.promise;
    assert.equal(f.counts.loads, 1, 'HTTP取消不能补发Owner读取或抢先完成原读取。');
    assert.equal(f.counts.saves, 0);
    held.release(); await held.settled;
    const recovered = await f.read();
    assert.equal(recovered.status, 200);
    assert.deepEqual(recovered.body, { serverId: SERVER, displayName: '合成认证暂错', contractVersion: '0.1.0', environment: 'development' });
    assert.equal(f.counts.loads, 3, '恢复请求必须重读认证和发送前Owner状态，不能续用原响应。');
    assert.equal(f.counts.saves, 0); assert.deepEqual(f.snapshot(), stored);
  } finally { controller.abort(); held.release(); await first; }
});

test('GET server的beforeSend独立Owner未知读沿既有safe映射为可重试', async t => {
  const f = await fixture(t); f.failOnLoad(2, new MobileAuthPersistenceError('unknown'));
  busy(await f.read(), true); assert.equal(f.counts.loads, 2);
  assert.equal((await f.read()).status, 200); assert.equal(f.counts.loads, 4); assert.equal(f.counts.saves, 0);
});

test('beforeSend的原Owner非重试BUSY不因其它读分支被全局改写', async t => {
  const f = await fixture(t); f.failOnLoad(2, 'owner-busy');
  busy(await f.read(), false); assert.equal(f.counts.loads, 2);
  assert.equal((await f.read()).status, 200); assert.equal(f.counts.saves, 0);
});

test('Main身份失效仍非重试，未发送新的Owner请求', async t => {
  const f = await fixture(t); assert.equal((await f.read()).status, 200);
  f.invalidate(); const reads = f.counts.loads;
  busy(await f.read(), false); assert.equal(f.counts.loads, reads); assert.equal(f.counts.saves, 0);
});

test('未知load异常仍fatal且封套不可重试，下一HTTP也不读取旧授权', async t => {
  const f = await fixture(t); f.failOnLoad(1, new Error('合成未知Owner异常'));
  busy(await f.read(), false); busy(await f.read(), false); assert.equal(f.counts.loads, 1);
});

test('refresh已提交后的发送前auth读暂错只能原key回执恢复，不再次旋转', async t => {
  const f = await fixture(t), permit = await f.handle.auth.issuePairing();
  const tokens = await f.handle.auth.claim({ pairingSecret: permit.pairingSecret,
    installationId: 'installation.auth-read', deviceName: '合成自有设备' }, 'pair.original');
  const before = f.counts.saves;
  f.afterSave(() => {
    // 提交后先经过alive，再在原key/token回执核对中的auth.load注入一次纯读错。
    f.failOnLoad(f.counts.loads + 2, new MobileAuthPersistenceError('unknown'));
  });
  const request = { body: { refreshToken: tokens.refreshToken }, key: 'refresh.original' };
  busy(await f.read('/mobile/v1/auth/refresh', request), true);
  const committed = f.snapshot(); assert.equal(f.counts.saves, before + 1);
  const repeated = await f.read('/mobile/v1/auth/refresh', request);
  assert.equal(repeated.status, 200); assert.equal(f.counts.saves, before + 1); assert.deepEqual(f.snapshot(), committed);
});
