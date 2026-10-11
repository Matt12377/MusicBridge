import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { decodeMobileRequest, mobileCanonicalJson, mobileDataSnapshot } from '@music-bridge/contracts';
import type { MobileContentReadContext, MobileHeaderPairs, MobileWireCodecContext } from '@music-bridge/contracts';
import { captureMobileContentReply } from '../../src/mobile/content-protocol.js';
import { createMobileContentService, MOBILE_CONTENT_OWNER_OPERATIONS, MOBILE_CONTENT_PROVIDER_OPERATIONS } from '../../src/mobile/content-service.js';
import { MOBILE_CONTENT_OPERATIONS, MOBILE_CONTENT_MUTATIONS, type MobileContentOperation,
  type MobileContentPort, type MobileContentScope, type MobileContentServiceInput,
  type MobileContentSnapshot } from '../../src/mobile/content-types.js';
import { MobileServiceError } from '../../src/mobile/types.js';

interface BodyFile { fileName: string; bytes: number; sha256: string }
interface FixtureRow {
  operationId: string; role: string; context: string; method: string; path: string;
  request: { headers: MobileHeaderPairs; query: MobileHeaderPairs; body: BodyFile | null };
  response: { status: number; body: BodyFile };
}
const fixtureRoot = new URL('../../../contracts/mobile/fixtures/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', fixtureRoot), 'utf8')) as {
  cases: FixtureRow[]; contexts: Record<string, MobileWireCodecContext>;
};
const SCOPE: Readonly<MobileContentScope> = Object.freeze({ serverId: 'server.fixture.1', datasetId: 'dataset.fixture.1',
  deviceId: 'device.fixture.1', deviceEpoch: 1, accessGeneration: 1, ownerEpoch: 'owner.fixture.1',
  accountDomain: 'account.fixture.1', providerEpoch: 'provider.fixture.1' });
const selection = { trackId: 'local:track.1', source: 'local' as const, versionId: 'local:version.1', contentRevision: 'rev.1' };
const addedSelection = { trackId: 'local:track.2', source: 'local' as const, versionId: 'local:version.2', contentRevision: 'rev.1' };
const paged = new Set<MobileContentOperation>(['listRecentlyAddedAlbums', 'listNeteaseLikedPlaylistTracks',
  'listFavoriteAlbums', 'listFavoriteAlbumTracks', 'listPersonalPlaylists', 'listPersonalPlaylistTracks',
  'listNeteaseRecommendedPlaylists', 'listNeteaseNewAlbums', 'listNeteaseCharts', 'getNeteaseDiscoveryCollectionTracks']);
function bytes(descriptor: BodyFile | null): Uint8Array {
  if (!descriptor) return new Uint8Array();
  assert.match(descriptor.fileName, /^bodies\/[A-Za-z0-9_.-]+$/u);
  const data = new Uint8Array(readFileSync(new URL(descriptor.fileName, fixtureRoot)));
  assert.equal(data.length, descriptor.bytes);
  assert.equal(createHash('sha256').update(data).digest('hex'), descriptor.sha256);
  return data;
}
/** 封存 whole fixture 的请求和响应原字节；可信 context 的新增分页事实单独明确给出。 */
function fixture<O extends MobileContentOperation>(operation: O) {
  const row = manifest.cases.find(candidate => candidate.operationId === operation && candidate.role === 'DECLARED_SUCCESS');
  assert.ok(row);
  const originalContext = manifest.contexts[row.context]; assert.ok(originalContext?.content);
  const context: MobileContentReadContext = { ...structuredClone(originalContext.content),
    ...(paged.has(operation) ? { pageOffset: 0 } : {}),
    ...(operation === 'listNeteaseRecommendedPlaylists' || operation === 'listNeteaseCharts' ? { source: 'netease' as const } : {}),
    ...(operation === 'setTrackFavorite' ? { selection } : operation === 'addPersonalPlaylistTrack' ? { selection: addedSelection } : {}),
  };
  const decoded = decodeMobileRequest(operation, { method: row.method, path: row.path,
    headers: row.request.headers, query: row.request.query, body: bytes(row.request.body) }, originalContext);
  assert.ok(decoded.ok);
  const facts = captureMobileContentReply(operation, decoded.value, SCOPE,
    { status: row.response.status, category: 'success', body: JSON.parse(new TextDecoder().decode(bytes(row.response.body))) as unknown }, context);
  return { operation, scope: SCOPE, request: decoded.value, ...facts,
    input: (signal = new AbortController().signal): MobileContentServiceInput<O> => ({ operation, scope: SCOPE, request: decoded.value, signal }) };
}
function canonical(raw: unknown): string {
  const value = mobileDataSnapshot(raw); assert.ok(value.ok); return mobileCanonicalJson(value.value);
}
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve };
}
function object(raw: unknown): Record<string, unknown> {
  assert.ok(raw && typeof raw === 'object' && !Array.isArray(raw)); return raw as Record<string, unknown>;
}
function refuses(promise: Promise<unknown>, status = 503, code = 'BUSY') {
  return assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof MobileServiceError); assert.equal(error.status, status); assert.equal(error.code, code);
    assert.equal(error.message, '移动服务当前无法完成请求。'); return true;
  });
}
function port(effect?: (input: MobileContentServiceInput) => void | Promise<void>): MobileContentPort {
  return { async dispatch<O extends MobileContentOperation>(input: MobileContentServiceInput<O>) {
    await effect?.(input);
    const data = fixture(input.operation);
    return { operation: input.operation, scope: input.scope, reply: data.reply, context: data.context, beforeSend: async () => undefined };
  } };
}

test('十九操作只分流到明确 Owner、Provider 和精确歌词端口，原完整请求与回包保持', async t => {
  const calls: { group: string; operation: MobileContentOperation; request: string; scope: string }[] = [];
  let sends = 0;
  const counted = (group: string): MobileContentPort => ({ async dispatch<O extends MobileContentOperation>(input: MobileContentServiceInput<O>) {
    const data = fixture(input.operation);
    calls.push({ group, operation: input.operation, request: canonical(input.request), scope: canonical(input.scope) });
    return { operation: input.operation, scope: input.scope, reply: data.reply, context: data.context, beforeSend: async () => { sends++; } };
  } });
  const service = createMobileContentService({ owner: counted('owner'), provider: counted('provider'), lyrics: counted('lyrics'), assertCurrent: () => undefined });
  t.after(() => service.close());
  for (const operation of MOBILE_CONTENT_OPERATIONS) {
    const data = fixture(operation), result = await service.dispatch(data.input()); await result.beforeSend();
    assert.equal(canonical(result.reply), canonical(data.reply)); assert.equal(canonical(result.context), canonical(data.context));
    const call = calls.at(-1); assert.ok(call);
    assert.equal(call.group, (MOBILE_CONTENT_OWNER_OPERATIONS as readonly string[]).includes(operation) ? 'owner'
      : (MOBILE_CONTENT_PROVIDER_OPERATIONS as readonly string[]).includes(operation) ? 'provider' : 'lyrics');
    assert.equal(call.request, canonical(data.request)); assert.equal(call.scope, canonical(SCOPE));
  }
  assert.equal(calls.length, 19); assert.equal(sends, 19);
  assert.equal(new Set([...MOBILE_CONTENT_OWNER_OPERATIONS, ...MOBILE_CONTENT_PROVIDER_OPERATIONS, 'getExactTrackLyrics']).size, 19);
});

test('坏请求、外域 Scope、错父条目和两路错 kind 都拒绝，不由正文签发可信上下文', async t => {
  let calls = 0;
  const service = createMobileContentService({ owner: port(() => { calls++; }), provider: port(() => { calls++; }),
    lyrics: port(() => { calls++; }), assertCurrent: () => undefined });
  t.after(() => service.close());
  const favorite = fixture('setAlbumFavorite');
  const maliciousInput: unknown = { ...favorite.input(), request: { ...favorite.request,
    body: { ...favorite.request.body, grant: 'forbidden' } } };
  await refuses(service.dispatch(maliciousInput as MobileContentServiceInput<'setAlbumFavorite'>), 400, 'INVALID_REQUEST');
  await refuses(service.dispatch({ ...favorite.input(), request: { ...favorite.request,
    body: { ...favorite.request.body, accountDomain: 'foreign.account' } } }), 409, 'SOURCE_CHANGED');
  assert.equal(calls, 0);
  for (const mutate of [
    (raw: MobileContentSnapshot) => { raw.scope = { ...raw.scope, datasetId: 'foreign.dataset' }; },
    (raw: MobileContentSnapshot) => { raw.context = { ...raw.context, accountDomain: 'foreign.account' }; },
    (raw: MobileContentSnapshot) => { raw.context = { ...raw.context, albumId: 'foreign.album' }; },
  ]) {
    const bad: MobileContentPort = { async dispatch<O extends MobileContentOperation>(input: MobileContentServiceInput<O>) {
      const data = fixture(input.operation), raw: MobileContentSnapshot<O> = { operation: input.operation, scope: input.scope,
        reply: structuredClone(data.reply), context: structuredClone(data.context), beforeSend: async () => undefined };
      mutate(raw); return raw;
    } };
    const guarded = createMobileContentService({ owner: bad, provider: bad, lyrics: bad, assertCurrent: () => undefined });
    t.after(() => guarded.close()); await assert.rejects(guarded.dispatch(favorite.input()), MobileServiceError);
  }
  for (const operation of ['listNeteaseRecommendedPlaylists', 'listNeteaseCharts'] as const) {
    const bad: MobileContentPort = { async dispatch<O extends MobileContentOperation>(input: MobileContentServiceInput<O>) {
      const data = fixture(input.operation), reply = structuredClone(data.reply), body = object(reply.body);
      assert.ok(Array.isArray(body.items)); object(body.items[0]).kind = input.operation === 'listNeteaseCharts' ? 'playlist' : 'chart';
      return { operation: input.operation, scope: input.scope, reply, context: data.context, beforeSend: async () => undefined };
    } };
    const guarded = createMobileContentService({ owner: bad, provider: bad, lyrics: bad, assertCurrent: () => undefined });
    t.after(() => guarded.close()); await refuses(guarded.dispatch(fixture(operation).input()));
  }
});

test('调用者取消后迟到端口回包不能输出，未静止的原投递仍占槽且 close 等待真实收口', async t => {
  const entered = deferred(), release = deferred(); let observedAbort = false, calls = 0;
  const held = port(async input => { calls++; input.signal.addEventListener('abort', () => { observedAbort = true; }, { once: true });
    entered.resolve(); await release.promise; });
  const service = createMobileContentService({ owner: held, provider: held, lyrics: held, maxInflight: 1, assertCurrent: () => undefined });
  t.after(async () => { release.resolve(); await service.close(); });
  const controller = new AbortController(), pending = service.dispatch(fixture('getNeteaseDailyRecommendations').input(controller.signal));
  const rejected = refuses(pending); await entered.promise; controller.abort(); await rejected;
  assert.equal(observedAbort, true);
  await refuses(service.dispatch(fixture('listPersonalPlaylists').input())); assert.equal(calls, 1);
  let closed = false; const closing = service.close().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false);
  release.resolve(); await closing; assert.equal(closed, true);
  await refuses(service.dispatch(fixture('listPersonalPlaylists').input())); assert.equal(calls, 1);
});

test('账号和 Owner epoch 在读取或发送前变化会阻断旧快照，Provider 等待不阻塞独立 Owner 读取', async t => {
  let current = SCOPE; const entered = deferred(), release = deferred();
  const provider = port(async () => { entered.resolve(); await release.promise; });
  const service = createMobileContentService({ owner: port(), provider, lyrics: port(), assertCurrent: scope => {
    if (canonical(scope) !== canonical(current)) throw new MobileServiceError(409, 'SOURCE_CHANGED');
  } });
  t.after(async () => { release.resolve(); await service.close(); });
  const waiting = service.dispatch(fixture('getNeteaseDailyRecommendations').input());
  const rejected = refuses(waiting, 409, 'SOURCE_CHANGED'); await entered.promise;
  const owner = await service.dispatch(fixture('listPersonalPlaylists').input()); await owner.beforeSend();
  current = { ...SCOPE, providerEpoch: 'provider.next' }; release.resolve(); await rejected;
  current = SCOPE; const result = await service.dispatch(fixture('listPersonalPlaylists').input());
  current = { ...SCOPE, ownerEpoch: 'owner.next' }; await refuses(result.beforeSend(), 409, 'SOURCE_CHANGED');
});

test('发送前重读整件可信候选，正文或 context 后改及 getter 回调不会污染已捕获结果', async t => {
  for (const change of ['body', 'context', 'callback', 'after-callback'] as const) {
    let candidate: MobileContentSnapshot | undefined;
    const controlled: MobileContentPort = { async dispatch<O extends MobileContentOperation>(input: MobileContentServiceInput<O>) {
      const data = fixture(input.operation), raw: MobileContentSnapshot<O> = { operation: input.operation, scope: input.scope,
        reply: structuredClone(data.reply), context: structuredClone(data.context), beforeSend: async () => {
          if (change === 'after-callback') object(raw.reply.body).libraryRevision = 'library.next';
        } };
      candidate = raw; return raw;
    } };
    const service = createMobileContentService({ owner: controlled, provider: controlled, lyrics: controlled, assertCurrent: () => undefined });
    t.after(() => service.close()); const result = await service.dispatch(fixture('listRecentlyAddedAlbums').input()); assert.ok(candidate);
    if (change === 'body') object(candidate.reply.body).libraryRevision = 'library.next';
    if (change === 'context') candidate.context = { ...candidate.context, pageOffset: 1 };
    if (change === 'callback') candidate.beforeSend = async () => undefined;
    await assert.rejects(result.beforeSend(), MobileServiceError);
    assert.equal(object(result.reply.body).libraryRevision, 'library.rev.1');
  }
  let getters = 0;
  const bad: MobileContentPort = { async dispatch<O extends MobileContentOperation>(input: MobileContentServiceInput<O>) {
    const data = fixture(input.operation);
    const raw = { operation: input.operation, scope: input.scope, reply: data.reply, context: data.context };
    Object.defineProperty(raw, 'beforeSend', { enumerable: true, get() { getters++; return async () => undefined; } });
    return raw as unknown as MobileContentSnapshot<O>;
  } };
  const service = createMobileContentService({ owner: bad, provider: bad, lyrics: bad, assertCurrent: () => undefined });
  t.after(() => service.close()); await refuses(service.dispatch(fixture('listPersonalPlaylists').input())); assert.equal(getters, 0);
});

test('四写原 key 和完整 body 保留，回执可重读且未知提交不会被服务自动重发', async t => {
  const originals = new Map<string, string>(), receipts = new Map<string, MobileContentSnapshot>();
  let calls = 0, commits = 0, unknown = false;
  const owner: MobileContentPort = { async dispatch<O extends MobileContentOperation>(input: MobileContentServiceInput<O>) {
    calls++; const key = `${input.operation}:${input.request.idempotencyKey}`;
    const original = originals.get(key), identity = canonical(input.request);
    if (original !== undefined && original !== identity) throw new MobileServiceError(409, 'IDEMPOTENCY_CONFLICT');
    if (unknown) { const error = new MobileServiceError(503, 'BUSY'); Object.assign(error, { outcome: 'unknown' }); throw error; }
    const existing = receipts.get(key); if (existing) return existing as MobileContentSnapshot<O>;
    const data = fixture(input.operation), receipt: MobileContentSnapshot<O> = { operation: input.operation, scope: input.scope,
      reply: data.reply, context: data.context, beforeSend: async () => undefined };
    originals.set(key, identity); receipts.set(key, receipt); commits++; return receipt;
  } };
  const service = createMobileContentService({ owner, provider: port(), lyrics: port(), assertCurrent: () => undefined });
  t.after(() => service.close());
  for (const operation of MOBILE_CONTENT_MUTATIONS) {
    const data = fixture(operation), first = await service.dispatch(data.input()), again = await service.dispatch(data.input());
    await again.beforeSend(); assert.equal(canonical(first.reply), canonical(again.reply));
    assert.equal(originals.get(`${operation}:${data.request.idempotencyKey}`), canonical(data.request));
  }
  assert.equal(commits, 4); assert.equal(calls, 8);
  const request = fixture('createPersonalPlaylist');
  await refuses(service.dispatch({ ...request.input(), request: { ...request.request,
    body: { ...request.request.body, draft: { ...request.request.body.draft, title: '另一个意图' } } } }), 409, 'IDEMPOTENCY_CONFLICT');
  unknown = true; const before = calls;
  await refuses(service.dispatch(fixture('setAlbumFavorite').input()));
  assert.equal(calls, before + 1); assert.equal(commits, 4);
});

test('来源认证、限额和未知内部故障不会成为成功空列表或泄露内部异常', async t => {
  for (const error of [new MobileServiceError(401, 'UNAUTHORIZED'), new MobileServiceError(503, 'CONTENT_LIMIT_EXCEEDED'),
    new Error('合成内部位置及账户细节')]) {
    const failing: MobileContentPort = { async dispatch() { throw error; } };
    const service = createMobileContentService({ owner: failing, provider: failing, lyrics: failing, assertCurrent: () => undefined });
    t.after(() => service.close());
    await refuses(service.dispatch(fixture('getNeteaseDailyRecommendations').input()),
      error instanceof MobileServiceError ? error.status : 503, error instanceof MobileServiceError ? error.code : 'BUSY');
  }
});

test('短请求和槽位预算只可下调，超时不丢原投递或虚称已关闭', async t => {
  for (const options of [{ requestMs: 10_001 }, { maxInflight: 17 }, { closeMs: 10_001 }, { requestMs: 0 }]) {
    assert.throws(() => createMobileContentService({ owner: port(), provider: port(), lyrics: port(), assertCurrent: () => undefined, ...options }), MobileServiceError);
  }
  const entered = deferred(), release = deferred(); let aborted = false;
  const held = port(async input => { input.signal.addEventListener('abort', () => { aborted = true; }, { once: true });
    entered.resolve(); await release.promise; });
  const service = createMobileContentService({ owner: held, provider: held, lyrics: held,
    requestMs: 20, closeMs: 20, maxInflight: 1, assertCurrent: () => undefined });
  t.after(() => { release.resolve(); });
  const pending = service.dispatch(fixture('listPersonalPlaylists').input()), rejected = refuses(pending);
  await entered.promise; await rejected; assert.equal(aborted, true);
  await refuses(service.dispatch(fixture('listPersonalPlaylists').input()));
  await refuses(service.close()); release.resolve();
});
