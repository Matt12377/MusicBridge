import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test, { type TestContext } from 'node:test';
import { decodeMobileRequest, decodeMobileResponse, mobileCanonicalJson, mobileDataSnapshot } from '@music-bridge/contracts';
import type { MobileContentReadContext, MobileHeaderPairs, MobileWireCodecContext } from '@music-bridge/contracts';
import { createMobileContentBackend } from '../src/main/mobile-content-backend.js';
import { createMobileAuthService } from '../../../packages/bridge-core/src/mobile/auth-service.js';
import { createMobileAuthCrypto } from '../../../packages/bridge-core/src/mobile/auth-crypto.js';
import { captureMobileContentReply } from '../../../packages/bridge-core/src/mobile/content-protocol.js';
import { createMobileContentService } from '../../../packages/bridge-core/src/mobile/content-service.js';
import { MOBILE_CONTENT_OPERATIONS, type MobileContentOperation, type MobileContentPort,
  type MobileContentScope, type MobileContentServiceInput, type MobileContentSnapshot } from '../../../packages/bridge-core/src/mobile/content-types.js';
import { MobileServiceError, type MobileAuthPersistence, type MobileAuthService,
  type MobilePrincipal, type MobileSealedState } from '../../../packages/bridge-core/src/mobile/types.js';

interface BodyFile { fileName: string; bytes: number; sha256: string }
interface FixtureRow {
  operationId: string; role: string; context: string; method: string; path: string;
  request: { headers: MobileHeaderPairs; query: MobileHeaderPairs; body: BodyFile | null };
  response: { status: number; body: BodyFile };
}
const fixtureRoot = new URL('../../../packages/contracts/mobile/fixtures/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', fixtureRoot), 'utf8')) as {
  cases: FixtureRow[]; contexts: Record<string, MobileWireCodecContext>;
};
const SERVER = 'server.fixture.1', DATASET = 'dataset.fixture.1', ORIGIN = 'https://127.0.0.1:9443';
const START = 1_700_000_000_000;
const selection = { trackId: 'local:track.1', source: 'local' as const, versionId: 'local:version.1', contentRevision: 'rev.1' };
const addedSelection = { trackId: 'local:track.2', source: 'local' as const, versionId: 'local:version.2', contentRevision: 'rev.1' };
const paged = new Set<MobileContentOperation>(['listRecentlyAddedAlbums', 'listNeteaseLikedPlaylistTracks',
  'listFavoriteAlbums', 'listFavoriteAlbumTracks', 'listPersonalPlaylists', 'listPersonalPlaylistTracks',
  'listNeteaseRecommendedPlaylists', 'listNeteaseNewAlbums', 'listNeteaseCharts', 'getNeteaseDiscoveryCollectionTracks']);
function fileBytes(file: BodyFile | null): Uint8Array {
  if (!file) return new Uint8Array();
  assert.match(file.fileName, /^bodies\/[A-Za-z0-9_.-]+$/u);
  const bytes = new Uint8Array(readFileSync(new URL(file.fileName, fixtureRoot)));
  assert.equal(bytes.length, file.bytes); assert.equal(hash(bytes), file.sha256); return bytes;
}
function hash(raw: Uint8Array): string { return createHash('sha256').update(raw).digest('hex'); }
function canonical(raw: unknown): string {
  const result = mobileDataSnapshot(raw); assert.ok(result.ok); return mobileCanonicalJson(result.value);
}
/** 完整封存 HTTP body 经过真实 codec；这些 fixture 不是 Provider/持久库或网络证明。 */
function contentFixture<O extends MobileContentOperation>(operation: O, scope: Readonly<MobileContentScope>) {
  const row = manifest.cases.find(candidate => candidate.operationId === operation && candidate.role === 'DECLARED_SUCCESS'); assert.ok(row);
  const originalContext = manifest.contexts[row.context]; assert.ok(originalContext?.content);
  const context: MobileContentReadContext = { ...structuredClone(originalContext.content), serverId: scope.serverId,
    deviceId: scope.deviceId, accountDomain: scope.accountDomain,
    ...(paged.has(operation) ? { pageOffset: 0 } : {}),
    ...(operation === 'listNeteaseRecommendedPlaylists' || operation === 'listNeteaseCharts' ? { source: 'netease' as const } : {}),
    ...(operation === 'setTrackFavorite' ? { selection } : operation === 'addPersonalPlaylistTrack' ? { selection: addedSelection } : {}),
  };
  const decoded = decodeMobileRequest(operation, { method: row.method, path: row.path, headers: row.request.headers,
    query: row.request.query, body: fileBytes(row.request.body) }, originalContext); assert.ok(decoded.ok);
  const facts = captureMobileContentReply(operation, decoded.value, scope,
    { status: row.response.status, category: 'success', body: JSON.parse(new TextDecoder().decode(fileBytes(row.response.body))) as unknown }, context);
  return { request: decoded.value, ...facts };
}
function deferred() {
  let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve };
}
function object(raw: unknown): Record<string, unknown> {
  assert.ok(raw && typeof raw === 'object' && !Array.isArray(raw)); return raw as Record<string, unknown>;
}
function refuses(promise: Promise<unknown>, status = 503, code = 'BUSY') {
  return assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof MobileServiceError); assert.equal(error.status, status); assert.equal(error.code, code);
    assert.equal(error.message, '移动服务当前无法完成请求。'); assert.equal(Object.hasOwn(error, 'cause'), false); return true;
  });
}

/** 原真实认证作者 + Node AES-GCM + 受控内存 CAS；不装载第二 auth、磁盘 Owner 或 HTTPS。 */
async function fixture(t: TestContext) {
  const key = randomBytes(32); let stored: MobileSealedState = { kind: 'missing', datasetId: DATASET, revision: 0 };
  const persistence: MobileAuthPersistence = {
    async load() { return stored.kind === 'missing' ? { ...stored } : { ...stored, sealed: new Uint8Array(stored.sealed) }; },
    async save(request) {
      if (stored.revision !== request.expectedRevision) return { kind: 'conflict', datasetId: DATASET, currentRevision: stored.revision };
      stored = { kind: 'sealed', datasetId: DATASET, revision: request.expectedRevision + 1,
        commitId: request.commitId, sealed: new Uint8Array(request.sealed) };
      return { kind: 'saved', datasetId: DATASET, revision: stored.revision, commitId: stored.commitId };
    },
  };
  const auth = createMobileAuthService({ serverId: SERVER, datasetId: DATASET, displayName: '合成内容桥',
    environment: 'development', persistence, crypto: createMobileAuthCrypto(key), now: () => START });
  const permit = await auth.issuePairing(), pair = await auth.claim({ pairingSecret: permit.pairingSecret,
    installationId: 'installation.content', deviceName: '合成设备' }, 'claim.content');
  const principal = await auth.authenticate(pair.accessToken);
  let accountDomain = 'account.fixture.1', ownerEpoch = 'owner.fixture.1', providerEpoch = 'provider.fixture.1';
  const scope = (actor: MobilePrincipal): Readonly<MobileContentScope> => ({ serverId: actor.serverId, datasetId: actor.datasetId,
    deviceId: actor.deviceId, deviceEpoch: actor.deviceEpoch, accessGeneration: actor.generation,
    ownerEpoch, accountDomain, providerEpoch });
  const assertScope = (input: Readonly<MobileContentScope>) => {
    if (input.ownerEpoch !== ownerEpoch || input.accountDomain !== accountDomain || input.providerEpoch !== providerEpoch) throw new MobileServiceError(409, 'SOURCE_CHANGED');
  };
  const calls: { operation: MobileContentOperation; request: string; scope: Readonly<MobileContentScope> }[] = [];
  const releases = new Set<() => void>();
  let effect: ((input: MobileContentServiceInput) => void | Promise<void>) | undefined;
  const controlled: MobileContentPort = { async dispatch<O extends MobileContentOperation>(input: MobileContentServiceInput<O>) {
    calls.push({ operation: input.operation, request: canonical(input.request), scope: input.scope }); await effect?.(input);
    const data = contentFixture(input.operation, input.scope);
    return { operation: input.operation, scope: input.scope, reply: data.reply, context: data.context, beforeSend: async () => undefined };
  } };
  const service = createMobileContentService({ owner: controlled, provider: controlled, lyrics: controlled, assertCurrent: assertScope });
  const options = { auth, content: service, resolveScope: async (actor: MobilePrincipal) => scope(actor), assertScope };
  const backend = createMobileContentBackend(options);
  t.after(async () => {
    for (const release of releases) release(); await backend.close(); await service.close(); await auth.close();
    key.fill(0); if (stored.kind === 'sealed') stored.sealed.fill(0);
  });
  return { auth, principal, pair, backend, service, controlled, calls, options,
    scope: () => scope(principal), resolveScope: options.resolveScope,
    changeAccount: () => { accountDomain = 'account.next'; providerEpoch = 'provider.next'; },
    changeOwner: () => { ownerEpoch = 'owner.next'; },
    setEffect: (next: typeof effect) => { effect = next; },
    barrier: () => { const entered = deferred(), release = deferred(); releases.add(release.resolve); return { entered, release }; },
    input: <O extends MobileContentOperation>(operation: O, signal = new AbortController().signal, token: string | null = pair.accessToken) =>
      ({ operation, request: contentFixture(operation, scope(principal)).request, signal, accessToken: token, origin: ORIGIN }),
  };
}

test('新 Main 门面沿同一真实 branded auth；无认证、伪 principal 和错误可信 Scope 均不进内容端口', async t => {
  const f = await fixture(t);
  await refuses(f.backend.dispatch(f.input('listPersonalPlaylists', undefined, null)), 401, 'UNAUTHORIZED');
  await refuses(f.backend.dispatch(f.input('listPersonalPlaylists', undefined, 'invalid.synthetic')), 401, 'UNAUTHORIZED');
  assert.equal(f.calls.length, 0);
  const forged: MobileAuthService = { ...f.auth, authenticate: async () => ({ ...f.principal }) };
  const bad = createMobileContentBackend({ ...f.options, auth: forged }); t.after(() => bad.close());
  await refuses(bad.dispatch(f.input('listPersonalPlaylists')), 401, 'UNAUTHORIZED'); assert.equal(f.calls.length, 0);
  const wrongScope = createMobileContentBackend({ ...f.options, resolveScope: async actor => ({ ...await f.resolveScope(actor), deviceId: 'other.device' }) });
  t.after(() => wrongScope.close());
  await refuses(wrongScope.dispatch(f.input('listPersonalPlaylists')), 409, 'SOURCE_CHANGED'); assert.equal(f.calls.length, 0);
  // provider 账号域是可信映射，不把 principal 的 local domain 当作 provider 身份。
  const result = await f.backend.dispatch(f.input('listPersonalPlaylists')); await result.beforeSend();
  assert.equal(result.contentContext.accountDomain, 'account.fixture.1');
  assert.notEqual(f.principal.accountDomain, result.contentContext.accountDomain);
});

test('十九项 whole HTTP 成功保持原 status、JSON、长度与可信身份，门面不增加路由或能力', async t => {
  const f = await fixture(t);
  for (const operation of MOBILE_CONTENT_OPERATIONS) {
    const input = f.input(operation), expected = contentFixture(operation, f.scope()), reply = await f.backend.dispatch(input);
    await reply.beforeSend();
    assert.equal(reply.kind, 'buffered'); assert.equal(reply.status, expected.reply.status);
    assert.equal(reply.headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1], 'application/json');
    assert.equal(reply.headers.find(([name]) => name.toLowerCase() === 'content-length')?.[1], String(reply.body.byteLength));
    assert.equal(reply.headers.find(([name]) => name.toLowerCase() === 'cache-control')?.[1], 'private, no-store');
    const decoded = decodeMobileResponse(operation, { status: reply.status, headers: reply.headers,
      body: new Uint8Array(reply.body), finalUrl: `${ORIGIN}${input.request.path}` },
    { responseOrigin: ORIGIN, requestPath: input.request.path, content: reply.contentContext });
    assert.ok(decoded.ok); assert.equal(decoded.value.category, 'success');
    assert.equal(canonical(decoded.value.body), canonical(expected.reply.body));
    assert.equal(f.calls.at(-1)?.request, canonical(input.request));
  }
  assert.equal(f.calls.length, 19);
});

test('正文账号不能签发 Scope，错误原 path/query/key/body 在投递前拒绝', async t => {
  const f = await fixture(t), input = f.input('setAlbumFavorite');
  await refuses(f.backend.dispatch({ ...input, request: { ...input.request, body: { ...input.request.body, accountDomain: 'account.foreign' } } }), 409, 'SOURCE_CHANGED');
  assert.equal(f.calls.length, 0);
  for (const request of [{ ...input.request, path: '/mobile/v1/ui/playlists' },
    { ...input.request, idempotencyKey: '' }, { ...input.request, query: { arbitraryGrant: 'forbidden' } },
    { ...input.request, body: { ...input.request.body, actor: 'forbidden' } }]) {
    await refuses(f.backend.dispatch({ ...input, request }), 400, 'INVALID_REQUEST');
  }
  assert.equal(f.calls.length, 0);
});

test('Provider 等待不占原 auth 队列；真实刷新或撤销拒绝迟到旧 generation 回包', async t => {
  for (const action of ['refresh', 'revoke'] as const) {
    const f = await fixture(t), held = f.barrier();
    f.setEffect(async () => { held.entered.resolve(); await held.release.promise; });
    const pending = f.backend.dispatch(f.input('getNeteaseDailyRecommendations'));
    const refused = assert.rejects(pending, (error: unknown) => error instanceof MobileServiceError && [401, 403].includes(error.status));
    await held.entered.promise;
    if (action === 'refresh') await f.auth.refresh({ refreshToken: f.pair.refreshToken }, 'refresh.while.provider');
    else await f.auth.revokeDevice(f.pair.deviceId);
    held.release.resolve(); await refused; assert.equal(f.calls.length, 1);
  }
});

test('账号和 Owner 在等待及 beforeSend 变化会围住旧域，取消的迟到内容也不能输出', async t => {
  for (const action of ['account', 'owner', 'abort'] as const) {
    const f = await fixture(t), held = f.barrier(), controller = new AbortController();
    f.setEffect(async () => { held.entered.resolve(); await held.release.promise; });
    const pending = f.backend.dispatch(f.input('getNeteaseDailyRecommendations', controller.signal));
    const refused = assert.rejects(pending, MobileServiceError); await held.entered.promise;
    if (action === 'account') f.changeAccount(); else if (action === 'owner') f.changeOwner(); else controller.abort();
    held.release.resolve(); await refused; assert.equal(f.calls.length, 1);
  }
  const f = await fixture(t), reply = await f.backend.dispatch(f.input('listPersonalPlaylists'));
  f.changeAccount(); await refuses(reply.beforeSend(), 409, 'SOURCE_CHANGED');
});

test('真实 logout 阻断已提交写回包，但不会把已提交状态或原回执推断为撤回', async t => {
  const f = await fixture(t); let commits = 0;
  f.setEffect(input => { if (input.operation === 'createPersonalPlaylist') commits++; });
  const reply = await f.backend.dispatch(f.input('createPersonalPlaylist'));
  assert.equal(reply.status, 201); assert.equal(commits, 1);
  await f.auth.logout(f.principal);
  await assert.rejects(reply.beforeSend(), (error: unknown) => error instanceof MobileServiceError && [401, 403].includes(error.status));
  assert.equal(commits, 1); assert.equal(f.calls.length, 1);
});

test('同原 key/body 回执跨真实 refresh 保持 whole bytes，换意图和 UNKNOWN 不会自动再写', async t => {
  const f = await fixture(t); let commits = 0, attempts = 0, unknown = false;
  const receipts = new Map<string, { identity: string; body: string }>();
  const owner: MobileContentPort = { async dispatch<O extends MobileContentOperation>(input: MobileContentServiceInput<O>) {
    attempts++; const identity = canonical(input.request), key = input.request.idempotencyKey; assert.ok(key);
    const prior = receipts.get(key);
    if (prior && prior.identity !== identity) throw new MobileServiceError(409, 'IDEMPOTENCY_CONFLICT');
    if (unknown) { const error = new MobileServiceError(503, 'BUSY'); Object.assign(error, { outcome: 'unknown' }); throw error; }
    const data = contentFixture(input.operation, input.scope);
    if (!prior) { receipts.set(key, { identity, body: canonical(data.reply) }); commits++; }
    else assert.equal(canonical(data.reply), prior.body);
    return { operation: input.operation, scope: input.scope, reply: data.reply, context: data.context, beforeSend: async () => undefined };
  } };
  const service = createMobileContentService({ owner, provider: owner, lyrics: owner, assertCurrent: f.options.assertScope });
  const backend = createMobileContentBackend({ ...f.options, content: service });
  t.after(async () => { await backend.close(); await service.close(); });
  const input = f.input('createPersonalPlaylist'), first = await backend.dispatch(input); await first.beforeSend();
  const refreshed = await f.auth.refresh({ refreshToken: f.pair.refreshToken }, 'refresh.original.receipt');
  const again = await backend.dispatch({ ...input, accessToken: refreshed.accessToken }); await again.beforeSend();
  assert.equal(hash(first.body), hash(again.body)); assert.equal(first.status, again.status);
  assert.equal(commits, 1); assert.equal(attempts, 2);
  await refuses(backend.dispatch({ ...input, accessToken: refreshed.accessToken,
    request: { ...input.request, body: { ...input.request.body, draft: { ...input.request.body.draft, title: '新意图' } } } }), 409, 'IDEMPOTENCY_CONFLICT');
  unknown = true;
  await refuses(backend.dispatch({ ...input, accessToken: refreshed.accessToken }));
  assert.equal(attempts, 4); assert.equal(commits, 1);
});

test('Main 对可信候选后改、错 kind 和非数据回调再次拒绝，安全错误不泄漏端口异常', async t => {
  const f = await fixture(t);
  for (const change of ['context', 'body', 'callback', 'getter'] as const) {
    let raw: MobileContentSnapshot | undefined, getters = 0;
    const content: MobileContentPort = { async dispatch<O extends MobileContentOperation>(input: MobileContentServiceInput<O>) {
      const data = contentFixture(input.operation, input.scope), candidate: MobileContentSnapshot<O> = {
        operation: input.operation, scope: input.scope, reply: structuredClone(data.reply), context: structuredClone(data.context), beforeSend: async () => undefined };
      if (change === 'getter') Object.defineProperty(candidate, 'beforeSend', { enumerable: true, get() { getters++; return async () => undefined; } });
      raw = candidate; return candidate;
    } };
    const backend = createMobileContentBackend({ ...f.options, content }); t.after(() => backend.close());
    if (change === 'getter') { await refuses(backend.dispatch(f.input('listPersonalPlaylists'))); assert.equal(getters, 0); continue; }
    const reply = await backend.dispatch(f.input('listPersonalPlaylists')); assert.ok(raw);
    if (change === 'context') raw.context = { ...raw.context, pageOffset: 1 };
    if (change === 'body') object(raw.reply.body).collectionRevision = 'collection.next';
    if (change === 'callback') raw.beforeSend = async () => undefined;
    await assert.rejects(reply.beforeSend(), MobileServiceError);
  }
  const failing: MobileContentPort = { async dispatch() { throw new Error('合成内部路径及认证细节'); } };
  const bad = createMobileContentBackend({ ...f.options, content: failing }); t.after(() => bad.close());
  await refuses(bad.dispatch(f.input('getNeteaseDailyRecommendations')));
  const wrongKind: MobileContentPort = { async dispatch<O extends MobileContentOperation>(input: MobileContentServiceInput<O>) {
    const data = contentFixture(input.operation, input.scope), reply = structuredClone(data.reply), items = object(reply.body).items;
    assert.ok(Array.isArray(items)); object(items[0]).kind = 'chart';
    return { operation: input.operation, scope: input.scope, reply, context: data.context, beforeSend: async () => undefined };
  } };
  const kind = createMobileContentBackend({ ...f.options, content: wrongKind }); t.after(() => kind.close());
  await refuses(kind.dispatch(f.input('listNeteaseRecommendedPlaylists')));
});

test('原 auth 或可信映射挂起时独立请求与 close 有界，未 quiet 的工作保留槽位且不关闭共享 auth', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(), settled = deferred();
  t.after(() => release.resolve());
  const delayedAuth: MobileAuthService = { ...f.auth, authenticate: async token => {
    entered.resolve(); await release.promise;
    try { return await f.auth.authenticate(token); } finally { settled.resolve(); }
  } };
  const backend = createMobileContentBackend({ ...f.options, auth: delayedAuth, requestMs: 20, closeMs: 20, maxInflight: 1 });
  t.after(async () => { release.resolve(); await backend.close().catch(() => undefined); });
  const pending = backend.dispatch(f.input('listPersonalPlaylists')), refused = refuses(pending);
  await entered.promise; await refused; assert.equal(f.calls.length, 0);
  await refuses(backend.dispatch(f.input('listPersonalPlaylists')));
  await refuses(backend.close()); release.resolve(); await settled.promise;
  assert.equal(f.calls.length, 0); await f.auth.assertCurrent(f.principal);
  for (const override of [{ requestMs: 10_001 }, { closeMs: 10_001 }, { maxInflight: 17 }, { requestMs: 0 }]) {
    assert.throws(() => createMobileContentBackend({ ...f.options, ...override }), MobileServiceError);
  }
});
