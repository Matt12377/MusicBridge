import assert from 'node:assert/strict';
import test, { after, before, type TestContext } from 'node:test';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdtemp, rm, stat } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import path from 'node:path';
import {
  captureMobileArtist, captureMobileArtistPage, decodeMobileResponse, isMobileErrorEnvelope,
  type ArtistCatalogArtist, type ArtistQuery, type ArtistSearchCatalogPublicApi,
} from '@music-bridge/contracts';
import { createMobileBackend } from '../src/main/mobile-backend.js';
import type { MobileArtistSearchBackend } from '../src/main/mobile-artist-search-backend.js';
import { createMobileHttpsServer } from '../src/main/mobile-https-server.js';
import { loadOrCreateMobileIdentity, type MobileTlsIdentity } from '../src/main/mobile-tls-identity.js';
import {
  MobileServiceError, type MobileOwnerPrivateRequest, type MobileOwnerPrivateResult, type MobileSealedState,
} from '../../../packages/bridge-core/src/mobile/types.js';

// 原 Main/Auth/Artist 门面和真实 loopback TLS；目录、持久化及保护器均为合成数据。
const DATASET = '11111111-1111-4111-8111-111111111111';
const ARTIST = `local-artist:${'a'.repeat(64)}`;
let directory = '', identity: MobileTlsIdentity;
const protectorKey = randomBytes(32);
before(async () => {
  const [volume, root] = await Promise.all([stat('/Volumes/LifeWeave'), stat('/')]);
  assert.ok(volume.isDirectory() && volume.dev !== root.dev, 'TLS 合成材料必须位于已挂载的外置卷。');
  const temporaryRoot = '/Volumes/LifeWeave/Developer/CommandLine/tmp';
  await access(temporaryRoot, constants.W_OK);
  directory = await mkdtemp(path.join(temporaryRoot, 'mousa41-https-'));
  identity = await loadOrCreateMobileIdentity({ directory: path.join(directory, 'identity'), hosts: ['127.0.0.1'], secretProtector: {
    encryptString(value) {
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', protectorKey, nonce);
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
    },
    decryptString(value) {
      const decipher = createDecipheriv('aes-256-gcm', protectorKey, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
    },
  } });
});
after(async () => {
  protectorKey.fill(0); identity?.authKey.fill(0);
  if (directory) await rm(directory, { recursive: true, force: true });
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function cleanup(steps: readonly (() => unknown | Promise<unknown>)[]) {
  const failures: unknown[] = [];
  for (const step of steps) { try { await step(); } catch (error) { failures.push(error); } }
  if (failures.length) throw new AggregateError(failures, '合成 HTTPS 资源尚未完整关闭。');
}
interface HttpReply { status: number; body: Buffer; headers: IncomingHttpHeaders }
function http(base: string, target: string, options: { token?: string; method?: string; body?: unknown; headers?: readonly string[]; signal?: AbortSignal } = {}): Promise<HttpReply> {
  const origin = new URL(base), bytes = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body));
  const headers = ['Host', origin.host, 'Connection', 'close', ...(options.headers ?? [])];
  if (options.token) headers.push('Authorization', `Bearer ${options.token}`);
  if (bytes) headers.push('Content-Type', 'application/json', 'Content-Length', String(bytes.length));
  return new Promise((resolve, reject) => {
    const request = httpsRequest({ hostname: origin.hostname, port: origin.port, path: target, method: options.method ?? 'GET',
      headers, ca: identity.certificatePEM, agent: false, ...(options.signal ? { signal: options.signal } : {}) }, response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      response.once('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks), headers: response.headers }));
      response.once('error', reject); response.once('aborted', () => reject(new Error('合成 HTTPS 响应已中断。')));
    });
    request.once('error', reject);
    request.setTimeout(5000, () => request.destroy(new Error('合成 HTTPS 请求超时。'))); request.end(bytes);
  });
}
const parsed = (reply: HttpReply): unknown => JSON.parse(reply.body.toString('utf8'));
function errorReply(reply: HttpReply, status: number, code: string) {
  assert.equal(reply.status, status);
  const value = parsed(reply); assert.ok(isMobileErrorEnvelope(value)); assert.equal(value.error.code, code);
  assert.deepEqual(Object.keys(value.error).sort(), ['code', 'message', 'requestId', 'retryable']);
  assert.equal(reply.headers['cache-control'], 'no-store');
  return value;
}
function page<T>(items: readonly T[], request: { offset: number; limit: number }, revision: string) {
  const selected = items.slice(request.offset, request.offset + request.limit);
  return { items: selected, offset: request.offset, limit: request.limit, total: items.length,
    hasMore: request.offset + selected.length < items.length, revision };
}
async function fixture(t: TestContext, linked: string | null = null) {
  const state = { revision: 'revision.1', linked, searchFailure: null as Error | null,
    hold: null as ReturnType<typeof deferred> | null, entered: deferred(),
    searchGates: new Map<string, { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> }>() };
  const calls = { catalog: [] as string[], searches: [] as ArtistQuery[], binds: [] as (string | null)[] };
  const artist = (): ArtistCatalogArtist => ({ id: ARTIST, name: '合成艺术家', source: 'local', albumCount: 0, trackCount: 0,
    linkState: state.linked === null ? 'unlinked' : 'manual', ...(state.linked === null ? {} : { linkedNeteaseId: state.linked }),
    artworkUrl: 'https://provider.invalid/private-artwork' });
  const rows = (query: string) => !query || artist().name.includes(query) ? [artist()] : [];
  const artists: ArtistSearchCatalogPublicApi = {
    async listArtists(request) { calls.catalog.push('list'); return { ...request, ...page(rows(request.query), request, state.revision) }; },
    async getArtist(request) { calls.catalog.push('detail'); assert.equal(request.artistId, ARTIST); return artist(); },
    async listArtistAlbums(request) { return { ...request, ...page([], request, state.revision) }; },
    async listArtistTracks(request) { return { ...request, ...page([], request, state.revision) }; },
    async search(request) {
      calls.catalog.push('search'); calls.searches.push({ ...request }); state.entered.resolve();
      const gate = state.searchGates.get(request.query);
      if (gate) { gate.entered.resolve(); await gate.release.promise; }
      if (state.hold) await state.hold.promise;
      if (state.searchFailure) throw state.searchFailure;
      return { query: request.query, revision: state.revision,
        artists: { ...request, ...page(rows(request.query), request, state.revision) },
        albums: { ...request, ...page([], request, state.revision) }, tracks: { ...request, ...page([], request, state.revision) } };
    },
    async suggest() { return { keywords: [] }; }, async artistMatches() { return []; },
    async bindArtist(request) { assert.equal(request.artistId, ARTIST); calls.binds.push(request.neteaseArtistId); state.linked = request.neteaseArtistId; return artist(); },
    async playLocalSelection() { throw new Error('合成 HTTPS 测试不触发播放。'); },
  };
  let stored: MobileSealedState = { kind: 'missing', datasetId: DATASET, revision: 0 };
  async function requestOwner(request: MobileOwnerPrivateRequest): Promise<MobileOwnerPrivateResult> {
    if (request.kind === 'load') return structuredClone(stored);
    if (request.kind === 'save') {
      if (request.request.expectedRevision !== stored.revision) return { kind: 'conflict', datasetId: DATASET, currentRevision: stored.revision };
      stored = { kind: 'sealed', datasetId: DATASET, revision: stored.revision + 1,
        commitId: request.request.commitId, sealed: new Uint8Array(request.request.sealed) };
      return { kind: 'saved', datasetId: DATASET, revision: stored.revision, commitId: request.request.commitId };
    }
    throw new Error('合成夹具不允许访问 Provider、媒体或真实目录。');
  }
  const key = randomBytes(32), servers: ReturnType<typeof createMobileHttpsServer>[] = [];
  const service = createMobileBackend({ serverId: identity.serverId, datasetId: DATASET, authKey: key,
    displayName: '合成艺术家搜索桥', environment: 'development', requestOwner, artists, assertCurrent() {},
    resizeArtwork() { throw new Error('合成目录没有图片字节。'); } });
  t.after(() => cleanup([() => { state.hold?.resolve(); for (const gate of state.searchGates.values()) gate.release.resolve(); },
    ...servers.map(server => () => server.close()), () => service.close(),
    () => { key.fill(0); if (stored.kind === 'sealed') stored.sealed.fill(0); }]));
  const permit = await service.auth.issuePairing();
  const pair = await service.auth.claim({ pairingSecret: permit.pairingSecret, installationId: 'installation.https-synthetic',
    deviceName: '合成手机' }, 'claim.https-synthetic');
  assert.ok(service.artistSearchBackend);
  async function listen(artistSearch: MobileArtistSearchBackend | null = service.artistSearchBackend!) {
    const server = createMobileHttpsServer({ tls: { key: identity.privateKeyPEM, cert: identity.certificatePEM },
      host: '127.0.0.1', port: 0, backend: service.backend, ...(artistSearch ? { artistSearch } : {}) });
    servers.push(server); return { server, ...await server.start() };
  }
  return { service, state, calls, pair, listen };
}
const SEARCH = '/mobile/v1/search/artists?q=%E5%90%88%E6%88%90&source=local&limit=2';

test('4.1 真实 HTTPS 显式挂载艺术家与搜索，原 server/capabilities 路由继续可用', { timeout: 10_000 }, async t => {
  const f = await fixture(t), h = await f.listen();
  assert.equal(h.certificateSha256, identity.certificateSha256);
  const old = await http(h.baseUrl, '/mobile/v1/capabilities', { token: f.pair.accessToken });
  const headers = Object.entries(old.headers).flatMap(([name, value]) => typeof value === 'string' ? [[name, value] as [string, string]] : []);
  assert.equal(old.status, 200);
  // 原 codec 只接收规范 Uint8Array；Node HTTPS 收到的 Buffer 先按传输边界复制。
  const decoded = decodeMobileResponse('getCapabilities', { status: old.status, body: new Uint8Array(old.body), headers,
    finalUrl: `${h.baseUrl}/mobile/v1/capabilities` }, { responseOrigin: h.baseUrl, requestPath: '/mobile/v1/capabilities' });
  assert.ok(decoded.ok, decoded.ok ? undefined : JSON.stringify(decoded.issue));
  for (const target of ['/mobile/v1/library/artists?limit=2', SEARCH]) {
    const reply = await http(h.baseUrl, target, { token: f.pair.accessToken }); assert.equal(reply.status, 200);
    const value = captureMobileArtistPage(parsed(reply), 'local'); assert.ok(value.ok);
    assert.deepEqual(value.value.items.map(item => item.id), [ARTIST]); assert.equal(value.value.nextCursor, null);
    assert.equal(reply.headers['cache-control'], 'no-store'); assert.equal(reply.headers['x-content-type-options'], 'nosniff');
    assert.equal(Number(reply.headers['content-length']), reply.body.length); assert.doesNotMatch(reply.body.toString('utf8'), /provider\.invalid|artworkUrl/u);
  }
  assert.equal(f.calls.searches[0]?.query, '合成');
  const unmounted = await f.listen(null);
  for (const target of ['/mobile/v1/library/artists', SEARCH]) errorReply(await http(unmounted.baseUrl, target, { token: f.pair.accessToken }), 404, 'INVALID_REQUEST');
  assert.equal((await http(unmounted.baseUrl, '/mobile/v1/server')).status, 200);
});

test('4.1 HTTPS 保留认证原始头检查，并将 PUT 的显式 null 解绑正文送达一次', { timeout: 10_000 }, async t => {
  const f = await fixture(t, '123'), h = await f.listen();
  errorReply(await http(h.baseUrl, SEARCH), 401, 'UNAUTHORIZED');
  errorReply(await http(h.baseUrl, SEARCH, { token: 'synthetic.invalid' }), 401, 'UNAUTHORIZED');
  errorReply(await http(h.baseUrl, SEARCH, { headers: ['Authorization', `Bearer ${f.pair.accessToken}`,
    'authorization', 'Bearer synthetic.other'] }), 400, 'INVALID_REQUEST');
  assert.deepEqual(f.calls.catalog, []);
  const reply = await http(h.baseUrl, `/mobile/v1/library/artists/${ARTIST}/link`, {
    method: 'PUT', token: f.pair.accessToken, body: { neteaseArtistId: null } });
  assert.equal(reply.status, 200);
  const value = captureMobileArtist(parsed(reply)); assert.ok(value.ok);
  assert.equal(value.value.id, ARTIST); assert.equal(value.value.source, 'local');
  assert.equal(value.value.linkState, 'unlinked'); assert.equal(value.value.linkedNeteaseId, undefined);
  assert.deepEqual(f.calls.binds, [null]);
});

test('4.1 HTTPS 在实际写出前重核目录修订和设备撤销，拒绝已准备好的成功正文', { timeout: 10_000 }, async t => {
  for (const change of ['revision', 'revoke'] as const) {
    const f = await fixture(t), original = f.service.artistSearchBackend!;
    const h = await f.listen({
      async dispatch(input) {
        const reply = await original.dispatch(input);
        if (change === 'revision') f.state.revision = 'revision.2';
        else await f.service.auth.revokeDevice(f.pair.deviceId);
        return reply;
      }, close: () => original.close(),
    });
    const reply = await http(h.baseUrl, SEARCH, { token: f.pair.accessToken });
    errorReply(reply, change === 'revision' ? 409 : 401, change === 'revision' ? 'SOURCE_CHANGED' : 'UNAUTHORIZED');
    assert.doesNotMatch(reply.body.toString('utf8'), /libraryRevision|合成艺术家|private-artwork/u);
  }
});

test('4.1 HTTPS 将目录异常映射为安全失败，下一次正常查询仍可成功', { timeout: 10_000 }, async t => {
  const f = await fixture(t), h = await f.listen();
  f.state.searchFailure = new Error('https://provider.invalid/private?token=private-synthetic-token');
  const reply = await http(h.baseUrl, SEARCH, { token: f.pair.accessToken });
  errorReply(reply, 503, 'BUSY');
  assert.doesNotMatch(reply.body.toString('utf8'), /provider\.invalid|private-synthetic-token|stack|cause|items/u);
  f.state.searchFailure = null;
  assert.equal((await http(h.baseUrl, SEARCH, { token: f.pair.accessToken })).status, 200);
});

test('4.1 HTTPS 关闭中止在途请求，组合服务继续等待未静止的 Artist 工作', { timeout: 10_000 }, async t => {
  const f = await fixture(t), original = f.service.artistSearchBackend!;
  f.state.hold = deferred(); let requestSignal: AbortSignal | undefined;
  const h = await f.listen({ dispatch(input) { requestSignal = input.signal; return original.dispatch(input); }, close: () => original.close() });
  const pending = http(h.baseUrl, SEARCH, { token: f.pair.accessToken }).then(reply => ({ reply }), (error: unknown) => ({ error }));
  await f.state.entered.promise; assert.ok(requestSignal); assert.equal(requestSignal.aborted, false);
  const serverClose = h.server.close(); assert.equal(h.server.close(), serverClose); await serverClose;
  assert.equal(requestSignal.aborted, true); assert.equal('error' in await pending, true);
  let quiet = false;
  const serviceClose = f.service.close(); assert.equal(f.service.close(), serviceClose);
  void serviceClose.then(() => { quiet = true; }, () => {});
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(quiet, false);
  f.state.hold.resolve(); await serviceClose; assert.equal(quiet, true);
  await assert.rejects(http(h.baseUrl, '/mobile/v1/server'));
  await assert.rejects(original.dispatch({ method: 'GET', requestTarget: SEARCH,
    headerPairs: [['Authorization', `Bearer ${f.pair.accessToken}`]], body: new Uint8Array(), signal: new AbortController().signal }),
  (error: unknown) => error instanceof MobileServiceError && error.status === 503 && error.code === 'BUSY');
});

test('4.1 双设备真实 TLS 交叠读取，关闭 A 连接与撤销 A 不影响 B 的在途搜索和认证', { timeout: 10_000 }, async t => {
  const f = await fixture(t), original = f.service.artistSearchBackend!;
  const permitB = await f.service.auth.issuePairing();
  const pairB = await f.service.auth.claim({ pairingSecret: permitB.pairingSecret,
    installationId: 'installation.https-synthetic-B', deviceName: '合成手机 B' }, 'claim.https-synthetic-B');
  assert.notEqual(pairB.deviceId, f.pair.deviceId); assert.notEqual(pairB.accessToken, f.pair.accessToken);
  const gateA = { entered: deferred(), release: deferred() }, gateB = { entered: deferred(), release: deferred() };
  f.state.searchGates.set('合成', gateA); f.state.searchGates.set('艺术家', gateB);
  const searchB = `/mobile/v1/search/artists?q=${encodeURIComponent('艺术家')}&source=local&limit=2`;
  const signals = new Map<string, AbortSignal>(), abortedA = deferred();
  const h = await f.listen({
    dispatch(input) {
      if (input.requestTarget === SEARCH) {
        signals.set('A', input.signal); input.signal.addEventListener('abort', abortedA.resolve, { once: true });
      } else if (input.requestTarget === searchB) signals.set('B', input.signal);
      return original.dispatch(input);
    }, close: () => original.close(),
  });
  // agent:false 为每个客户端请求建立独立 TLS 连接；两页均进入目录后才允许断开 A。
  const clientA = new AbortController();
  const pendingA = http(h.baseUrl, SEARCH, { token: f.pair.accessToken, signal: clientA.signal })
    .then(reply => ({ reply }), (error: unknown) => ({ error }));
  const pendingB = http(h.baseUrl, searchB, { token: pairB.accessToken })
    .then(reply => ({ reply }), (error: unknown) => ({ error }));
  await Promise.all([gateA.entered.promise, gateB.entered.promise]);
  const signalA = signals.get('A'), signalB = signals.get('B');
  assert.ok(signalA); assert.ok(signalB); assert.notEqual(signalA, signalB);
  assert.equal(signalA.aborted, false); assert.equal(signalB.aborted, false);
  const artistTarget = `/mobile/v1/library/artists/${ARTIST}?source=local`;
  const artists = await Promise.all([http(h.baseUrl, artistTarget, { token: f.pair.accessToken }),
    http(h.baseUrl, artistTarget, { token: pairB.accessToken })]);
  for (const reply of artists) { assert.equal(reply.status, 200); assert.ok(captureMobileArtist(parsed(reply)).ok); }

  clientA.abort();
  const canceled = await pendingA; assert.ok('error' in canceled);
  assert.ok(canceled.error instanceof Error && canceled.error.name === 'AbortError');
  await abortedA.promise; assert.equal(signalA.aborted, true); assert.equal(signalB.aborted, false);
  await f.service.auth.revokeDevice(f.pair.deviceId);
  assert.equal(signalB.aborted, false);
  errorReply(await http(h.baseUrl, artistTarget, { token: f.pair.accessToken }), 401, 'UNAUTHORIZED');
  assert.equal((await http(h.baseUrl, artistTarget, { token: pairB.accessToken })).status, 200);

  gateB.release.resolve();
  const completed = await pendingB; assert.ok('reply' in completed); assert.equal(completed.reply.status, 200);
  const pageB = captureMobileArtistPage(parsed(completed.reply), 'local'); assert.ok(pageB.ok);
  assert.deepEqual(pageB.value.items.map(item => item.id), [ARTIST]);
  assert.equal((await http(h.baseUrl, '/mobile/v1/capabilities', { token: pairB.accessToken })).status, 200);
  gateA.release.resolve();
});
