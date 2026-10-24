import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import type { MobileDecodedRequest } from '@music-bridge/contracts';
import type { MobileContentScope } from '../../../../packages/bridge-core/src/mobile/content-types.js';
import type { MobileAuthService, MobileOwnerPrivateResult, MobilePrincipal, MobileSealedState } from '../../../../packages/bridge-core/src/mobile/types.js';
import { MobileServiceError } from '../../../../packages/bridge-core/src/mobile/types.js';
import type { MobileOwnerSourceResult } from '../../../../packages/bridge-core/src/mobile/source-protocol.js';
import type { createMainMobileContentPort } from '../../src/main/mobile-content-port.js';
import { createMobilePlaybackBackend } from '../../src/main/mobile-playback-backend.js';
import { createMobileHttpsServer } from '../../src/main/mobile-https-server.js';
import { loadOrCreateMobileIdentity } from '../../src/main/mobile-tls-identity.js';

const FEATURE = ['X-MusicBridge-Catalog-Features', 'unknown-duration-v1'];
const SERVER = 'server.compat', DATASET = 'dataset.compat';
const principal: MobilePrincipal = { serverId: SERVER, datasetId: DATASET, deviceId: 'device.compat', deviceEpoch: 1, generation: 1,
  accountDomain: `local:${DATASET}`, accessTokenHash: 'a'.repeat(64), accessExpiresAt: '2030-01-01T00:00:00Z' };
const scope: Readonly<MobileContentScope> = { serverId: SERVER, datasetId: DATASET, deviceId: principal.deviceId,
  deviceEpoch: 1, accessGeneration: 1, ownerEpoch: 'owner.compat', providerEpoch: null, accountDomain: principal.accountDomain };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }

/** 真实HTTPS、wire、Main、播放业务guard和状态Worker；Owner/来源/认证叶全为合成，不接真实账号。 */
async function fixture(t: TestContext) {
  assert.ok(process.env.TMPDIR?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'));
  const directory = fs.mkdtempSync(path.join(process.env.TMPDIR!, 'playback-feature-')), key = randomBytes(32);
  let stored: MobileSealedState = { kind: 'missing', datasetId: DATASET, revision: 0 }, revoked = false, authCalls = 0, saves = 0, prepares = 0, controls = 0;
  let holdVerify = false;
  const verify = deferred(), entered = deferred(), bytes = Uint8Array.from({ length: 65536 }, (_, i) => i % 251);
  const audio = { codec: 'flac', container: 'flac', sampleRateHz: 48000, bitsPerSample: 24, channels: 2 };
  const auth = { async authenticate(token: string) { authCalls++; if (token !== 'synthetic.access') throw new MobileServiceError(401, 'UNAUTHORIZED');
    if (revoked) throw new MobileServiceError(403, 'DEVICE_REVOKED'); return { ...principal }; },
    async assertCurrent() { if (revoked) throw new MobileServiceError(403, 'DEVICE_REVOKED'); },
    async assertDeviceCurrent() { if (revoked) throw new MobileServiceError(403, 'DEVICE_REVOKED'); },
  } as unknown as MobileAuthService;
  const content = { async scopeForIdentity() { return { scope, neteasePlayback: false }; }, async source(_scope, request, signal) {
    signal.throwIfAborted(); let result: MobileOwnerSourceResult;
    if (request.operation === 'prepare') { prepares++; result = { kind: 'mobile-source-prepared', source: { handle: request.selection.resourceId,
      sourceAudio: audio, actualAudio: { ...audio }, processing: { mode: 'direct', reason: '合成原字节', fromPreparedCache: false },
      contentType: 'audio/flac', size: bytes.length, durationMs: 4000, seekable: true } }; }
    else if (request.operation === 'read') result = { kind: 'mobile-source-read', handle: request.handle, readId: request.readId,
      start: request.start, bytes: bytes.slice(request.start, request.start + request.maxBytes) };
    else if (request.operation === 'capabilities') result = { kind: 'mobile-source-capabilities', resourceDsdToPcm: false };
    else if (request.operation === 'status') throw new Error('合成直接来源不请求DSD状态。');
    else { if (request.operation === 'verify' && holdVerify) { entered.resolve(); await verify.promise; signal.throwIfAborted(); }
      result = { kind: 'mobile-source-ack', operation: request.operation, handle: request.handle,
        readId: request.operation === 'close-read' ? request.readId : null, quiet: true }; }
    return { source: 'local', result };
  } } satisfies Pick<ReturnType<typeof createMainMobileContentPort>, 'scopeForIdentity' | 'source'>;
  const handle = createMobilePlaybackBackend({ serverId: SERVER, datasetId: DATASET, authKey: key, auth, assertCurrent() {},
    contentPort: content as unknown as ReturnType<typeof createMainMobileContentPort>, async requestOwner(request): Promise<MobileOwnerPrivateResult> {
      if (request.kind === 'playback-activity') return { kind: 'playback-activity', datasetId: DATASET,
        ownerEpoch: '11111111-1111-4111-8111-111111111111', operation: request.request.operation,
        leaseId: '22222222-2222-4222-8222-222222222222' };
      if (request.kind === 'playback-load') return structuredClone(stored);
      assert.equal(request.kind, 'playback-save'); if (request.kind !== 'playback-save') throw new Error('非本测试Owner操作。');
      assert.equal(request.request.expectedRevision, stored.revision); saves++;
      stored = { kind: 'sealed', datasetId: DATASET, revision: stored.revision + 1, commitId: request.request.commitId, sealed: new Uint8Array(request.request.sealed) };
      return { kind: 'saved', datasetId: DATASET, revision: stored.revision, commitId: stored.commitId };
    } });
  const identity = await loadOrCreateMobileIdentity({ directory: path.join(directory, 'tls'), hosts: ['127.0.0.1'], secretProtector: {
    encryptString(value) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv), data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, data, cipher.getAuthTag()]); },
    decryptString(value) { const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(-16));
      return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString('utf8'); },
  } });
  const playback = { ...handle.backend, async dispatch(input: Parameters<typeof handle.backend.dispatch>[0]) { controls++; return handle.backend.dispatch(input); } };
  const server = createMobileHttpsServer({ host: '127.0.0.1', port: 0, tls: { key: identity.privateKeyPEM, cert: identity.certificatePEM },
    backend: { async dispatch() { throw new MobileServiceError(404, 'INVALID_REQUEST'); } }, playback });
  const listening = await server.start(); handle.activate(listening.baseUrl);
  t.after(async () => { holdVerify = false; verify.resolve(); await server.close(); await handle.close(); key.fill(0); fs.rmSync(directory, { recursive: true, force: true }); });
  const call = (method: string, target: string, extra: string[] = [], body?: unknown, authenticated = true) => new Promise<{ status: number; body: Buffer; headers: string[] }>((resolve, reject) => {
    const origin = new URL(listening.baseUrl), data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const headers = ['Host', origin.host, 'Connection', 'close', ...(authenticated ? ['Authorization', 'Bearer synthetic.access'] : []), ...extra,
      ...(data === undefined ? [] : ['Content-Type', 'application/json', 'Content-Length', String(data.length)])];
    const req = httpsRequest({ hostname: '127.0.0.1', port: origin.port, path: target, method, ca: identity.certificatePEM, agent: false, headers }, response => {
      const chunks: Buffer[] = []; response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      response.once('error', reject); response.once('aborted', () => reject(new Error('合成HTTPS响应关闭。')));
      response.once('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks), headers: response.rawHeaders }));
    });
    req.once('error', reject); req.setTimeout(10000, () => req.destroy(new Error('合成HTTPS请求超时。'))); req.end(data);
  });
  const json = (response: { body: Buffer }) => JSON.parse(response.body.toString('utf8')) as Record<string, unknown>;
  const session = async () => { const response = await call('POST', '/mobile/v1/sessions', ['Idempotency-Key', 'compat.session'], { clientInstanceId: 'compat.instance' });
    assert.equal(response.status, 201); const value = json(response); assert.equal(typeof value.id, 'string'); return value.id as string; };
  const resource = async (sessionId: string) => { const response = await call('POST', `/mobile/v1/sessions/${sessionId}/resources`, ['Idempotency-Key', 'compat.resource'],
    { trackId: 'track.compat', versionId: 'version.compat', contentRevision: 'revision.compat', quality: { profile: 'lossless', allowLossyFallback: false, preferredTransport: 'file' },
      formats: [{ codec: 'flac', container: 'flac', maxSampleRateHz: 48000, maxBitsPerSample: 24, maxChannels: 2 }] });
    assert.ok([201, 202].includes(response.status)); const value = json(response); assert.equal(typeof value.id, 'string');
    return { response, value, target: `/mobile/v1/sessions/${sessionId}/resources/${value.id as string}` }; };
  return { call, json, session, resource, handle, origin: listening.baseUrl, data: bytes, entered,
    counts: () => ({ saves, prepares, authCalls, controls }), hold: () => { holdVerify = true; }, release: () => { holdVerify = false; verify.resolve(); }, revoke: () => { revoked = true; } };
}

test('M36真实HTTPS兼容：POST201后session GET带目录feature仍200，同一会话且零额外持久写', async t => {
  const f = await fixture(t), id = await f.session(), target = `/mobile/v1/sessions/${id}`;
  const old = await f.call('GET', target); assert.equal(old.status, 200); const before = f.counts();
  const response = await f.call('GET', target, FEATURE); assert.equal(response.status, 200); assert.deepEqual(f.json(response), f.json(old));
  assert.equal(f.counts().saves, before.saves); assert.ok(f.counts().authCalls > before.authCalls);
});

test('M36真实HTTPS兼容：ready resource GET带feature保持原资源/精确时长与回执，不重复POST或prepare', async t => {
  const f = await fixture(t), id = await f.session(), r = await f.resource(id); assert.equal(r.response.status, 201);
  const old = await f.call('GET', r.target); assert.equal(old.status, 200); const before = f.counts();
  const response = await f.call('GET', r.target, FEATURE); assert.equal(response.status, 200); assert.deepEqual(f.json(response), f.json(old));
  assert.equal(f.counts().saves, before.saves); assert.equal(f.counts().prepares, 1);
  assert.equal((f.json(response).media as { durationMs: number }).durationMs, 4000);
});

test('M36真实HTTPS兼容：原POST202的preparing receipt GET带feature可核对，解除verify后仍同资源ready', async t => {
  const f = await fixture(t), id = await f.session(); f.hold(); const r = await f.resource(id); assert.equal(r.response.status, 202);
  await f.entered.promise; const response = await f.call('GET', r.target, FEATURE); assert.equal(response.status, 200);
  assert.equal(f.json(response).state, 'preparing'); assert.equal(f.json(response).id, r.value.id); f.release();
  for (let i = 0; i < 50; i++) { const current = await f.call('GET', r.target, FEATURE); assert.equal(current.status, 200);
    if (f.json(current).state === 'ready') { assert.equal(f.json(current).id, r.value.id); assert.equal(f.counts().prepares, 1); return; }
    await new Promise<void>(done => setTimeout(done, 5)); }
  assert.fail('同一原资源没有在有界核对内ready。');
});

test('M36真实HTTPS兼容：media GET额外feature不进入业务请求，Range206字节与无feature HEAD仍严格', async t => {
  const f = await fixture(t), id = await f.session(), r = await f.resource(id), url = new URL((r.value.media as { url: string }).url);
  const target = url.pathname + url.search;
  const response = await f.call('GET', target, [...FEATURE, 'Range', 'bytes=0-15'], undefined, false);
  assert.equal(response.status, 206); assert.deepEqual(response.body, Buffer.from(f.data.slice(0, 16)));
  const head = await f.call('HEAD', target, [], undefined, false); assert.equal(head.status, 200); assert.equal(head.body.length, 0);
  const invalid = await f.call('GET', target, [...FEATURE, 'Range', 'bytes=0-1,3-4'], undefined, false); assert.equal(invalid.status, 400); assert.equal(invalid.body.length, 0);
});

test('M36真实HTTPS边界：错误/重复feature和POST协商仍400且零业务投递', async t => {
  const f = await fixture(t), id = await f.session(), before = f.counts();
  for (const headers of [['X-MusicBridge-Catalog-Features', 'unknown-duration-v2'], [...FEATURE, ...FEATURE]]) {
    assert.equal((await f.call('GET', `/mobile/v1/sessions/${id}`, headers)).status, 400);
  }
  assert.equal((await f.call('POST', '/mobile/v1/sessions', [...FEATURE, 'Idempotency-Key', 'compat.invalid'], { clientInstanceId: 'other.instance' })).status, 400);
  assert.deepEqual(f.counts(), before);
});

test('M36业务闭集不放宽：只剥传输feature，其他额外字段与getter仍400且不执行', async t => {
  const f = await fixture(t), id = await f.session(); let getters = 0;
  const request: MobileDecodedRequest<unknown> = { path: `/mobile/v1/sessions/${id}`, pathParameters: { sessionId: id }, query: {}, body: null };
  for (const feature of [false, true]) {
    const bad = { ...request, ...(feature ? { catalogFeatures: 'unknown-duration-v1' as const } : {}), extra: '拒绝无关字段' };
    await assert.rejects(f.handle.backend.dispatch({ operation: 'getSession', request: bad, accessToken: 'synthetic.access', origin: f.origin, signal: new AbortController().signal, headers: [] }),
      e => e instanceof MobileServiceError && e.status === 400 && e.code === 'INVALID_REQUEST');
  }
  const bad = { ...request }; Object.defineProperty(bad, 'catalogFeatures', { enumerable: true, get() { getters++; return 'unknown-duration-v1'; } });
  await assert.rejects(f.handle.backend.dispatch({ operation: 'getSession', request: bad, accessToken: 'synthetic.access', origin: f.origin, signal: new AbortController().signal, headers: [] }),
    e => e instanceof MobileServiceError && e.status === 400 && e.code === 'INVALID_REQUEST');
  assert.equal(getters, 0);
});

test('M36已带feature的GET仍fresh鉴权，撤销后403且不创建或恢复另一会话', async t => {
  const f = await fixture(t), id = await f.session(), before = f.counts(); f.revoke();
  assert.equal((await f.call('GET', `/mobile/v1/sessions/${id}`, FEATURE)).status, 403); assert.equal(f.counts().saves, before.saves);
});
