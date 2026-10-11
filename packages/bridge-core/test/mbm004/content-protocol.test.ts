import test from 'node:test';
import assert from 'node:assert/strict';
import type { MobileContentReadContext, MobileRequestMap } from '@music-bridge/contracts';
import {
  captureMobileContentPrivateRequest, captureMobileContentPrivateResponse,
  captureMobileContentReply, captureMobileContentRequest,
} from '../../src/mobile/content-protocol.js';
import type { MobileContentScope } from '../../src/mobile/content-types.js';
import { MobileServiceError } from '../../src/mobile/types.js';

const scope: MobileContentScope = { serverId: 'server-a', datasetId: 'dataset-a', deviceId: 'device-a', deviceEpoch: 1,
  accessGeneration: 1, ownerEpoch: 'owner-a', accountDomain: 'account-a', providerEpoch: 'provider-a' };
const id = '11111111-1111-4111-8111-111111111111';
const request: MobileRequestMap['listRecentlyAddedAlbums'] = {
  path: '/mobile/v1/ui/home/added-albums', pathParameters: {}, query: { limit: 2 }, body: null,
};
const context: MobileContentReadContext = { serverId: scope.serverId, deviceId: scope.deviceId, accountDomain: scope.accountDomain,
  revision: 'library-a', source: 'local', limit: 2, pageOffset: 0 };
const reply = () => ({ status: 200, category: 'success' as const, body: { items: [], nextCursor: null, libraryRevision: 'library-a' } });
const changed = (error: unknown): boolean => error instanceof MobileServiceError && error.code === 'SOURCE_CHANGED';

test('原19操作请求使用原HTTP合同，复制且冻结有效请求', () => {
  const input = structuredClone(request), checked = captureMobileContentRequest('listRecentlyAddedAlbums', input);
  input.query.limit = 3;
  assert.equal(checked.query.limit, 2); assert(Object.isFrozen(checked.query));
  assert.equal(checked.path, request.path);
  for (const raw of [{ ...request, operation: 'listAlbums' }, { ...request, path: '/mobile/v1/albums' },
    { ...request, pathParameters: { albumId: 'album-a' } }, { ...request, body: {} },
    { ...request, query: { limit: 101 } }, { ...request, query: { limit: 2, credential: 'not-a-secret' } }]) {
    assert.throws(() => captureMobileContentRequest('listRecentlyAddedAlbums', raw));
  }
});

test('descriptor capture拒绝accessor不执行，scope不能携带第二认证或账号地址', () => {
  let calls = 0;
  const hostile = { ...request, get body(): null { calls++; return null; } };
  assert.throws(() => captureMobileContentRequest('listRecentlyAddedAlbums', hostile));
  assert.equal(calls, 0);
  const envelope = { type: 'mobile-content-main-request', id, operation: 'listRecentlyAddedAlbums', scope, request };
  for (const value of [{ ...envelope, accessToken: 'synthetic' }, { ...envelope, id: 'not-uuid' },
    { ...envelope, operation: 'getCapabilities' }, { ...envelope, scope: { ...scope, upstreamUrl: 'https://provider.invalid/' } },
    { ...envelope, scope: { ...scope, deviceEpoch: 0 } }]) assert.throws(() => captureMobileContentPrivateRequest(value));
  assert.equal(captureMobileContentPrivateRequest(envelope).operation, 'listRecentlyAddedAlbums');
});

test('合法空页使用Owner独立revision，body无法自签账号、权限或版本', () => {
  const result = captureMobileContentReply('listRecentlyAddedAlbums', request, scope, reply(), context);
  assert.deepEqual(result.reply.body.items, []); assert(Object.isFrozen(result.reply.body));
  assert.throws(() => captureMobileContentReply('listRecentlyAddedAlbums', request, scope,
    { ...reply(), body: { ...reply().body, libraryRevision: 'attacker-revision' } }, context), changed);
  for (const change of [{ accountDomain: 'account-b' }, { serverId: 'server-b' }, { deviceId: 'device-b' },
    { limit: 3 }, { pageOffset: -1 }, { source: 'netease' as const }, { revision: undefined }, { url: 'https://provider.invalid/' }]) {
    assert.throws(() => captureMobileContentReply('listRecentlyAddedAlbums', request, scope, reply(), { ...context, ...change } as MobileContentReadContext));
  }
});

test('错误status/category/正文和传输超限不被包装成内容success', () => {
  for (const value of [{ ...reply(), status: 201 }, { ...reply(), category: 'error' }, { ...reply(), extra: true },
    { ...reply(), body: { items: [], nextCursor: 'cursor', libraryRevision: 'library-a' } },
    { ...reply(), body: { items: [], nextCursor: null } }]) {
    assert.throws(() => captureMobileContentReply('listRecentlyAddedAlbums', request, scope, value, context));
  }
  assert.throws(() => captureMobileContentReply('listRecentlyAddedAlbums', request, scope, reply(), context,
    { limits: { requestBytes: 262144, responseBytes: 20, depth: 64, nodes: 1000, extensionBytes: 20 } }));
});

test('exact歌词依原track/source/version/revision核验，真实missing仍是合法内容', () => {
  const lyricsRequest: MobileRequestMap['getExactTrackLyrics'] = { path: '/mobile/v1/ui/tracks/track-a/lyrics',
    pathParameters: { trackId: 'track-a' }, query: { source: 'local', versionId: 'version-a', contentRevision: 'content-a' }, body: null };
  const selection = { trackId: 'track-a', source: 'local' as const, versionId: 'version-a', contentRevision: 'content-a' };
  const lyrics = { status: 200, category: 'success', body: { ...selection, status: 'missing', synchronized: false, lines: [] } };
  const trusted = { serverId: scope.serverId, deviceId: scope.deviceId, accountDomain: scope.accountDomain, source: 'local' as const, selection };
  assert.equal(captureMobileContentReply('getExactTrackLyrics', lyricsRequest, scope, lyrics, trusted).reply.body.status, 'missing');
  for (const name of ['trackId', 'source', 'versionId', 'contentRevision'] as const) {
    const other = { ...selection, [name]: name === 'source' ? 'netease' : 'other' };
    assert.throws(() => captureMobileContentReply('getExactTrackLyrics', lyricsRequest, scope,
      { ...lyrics, body: { ...lyrics.body, ...other } }, { ...trusted, selection: other } as MobileContentReadContext), changed);
  }
});

test('收藏回执使用提交后真实revision，同key旧CAS回执不被新CAS预检阻挡', () => {
  const favoriteRequest: MobileRequestMap['setAlbumFavorite'] = { path: '/mobile/v1/ui/favorites/albums/album-a', pathParameters: { albumId: 'album-a' },
    query: {}, body: { source: 'local', isFavorite: false, accountDomain: scope.accountDomain, expectedRevision: 'favorites-old' }, idempotencyKey: 'key-a' };
  const favoriteReply = { status: 200, category: 'success', body: { accountDomain: scope.accountDomain, favoritesRevision: 'favorites-new',
    identity: { albumId: 'album-a', source: 'local' }, favorite: null } };
  const trusted = { serverId: scope.serverId, deviceId: scope.deviceId, accountDomain: scope.accountDomain, source: 'local' as const,
    albumId: 'album-a', revision: 'favorites-new' };
  assert.equal(captureMobileContentReply('setAlbumFavorite', favoriteRequest, scope, favoriteReply, trusted).reply.body.favoritesRevision, 'favorites-new');
  assert.throws(() => captureMobileContentRequest('setAlbumFavorite', { ...favoriteRequest, idempotencyKey: '' }));
  assert.throws(() => captureMobileContentReply('setAlbumFavorite', favoriteRequest, scope, favoriteReply, { ...trusted, albumId: 'album-b' }), changed);
});

test('推荐歌单和排行榜按各自canonical kind核验，不把互换页接纳为成功', () => {
  for (const [operation, segment, kind] of [['listNeteaseRecommendedPlaylists', 'recommended-playlists', 'playlist'],
    ['listNeteaseCharts', 'charts', 'chart']] as const) {
    const req = { path: `/mobile/v1/ui/netease/${segment}`, pathParameters: {}, query: { limit: 2 }, body: null };
    const body = { accountDomain: scope.accountDomain, feedRevision: 'feed-a', nextCursor: null,
      items: [{ id: 'collection-a', kind, title: '测试列表', artworkId: null, trackCount: 0, collectionRevision: 'collection-revision' }] };
    const trusted = { ...context, source: 'netease' as const, revision: 'feed-a' };
    assert.equal(captureMobileContentReply(operation, req, scope, { status: 200, category: 'success', body }, trusted).reply.body.items[0]!.kind, kind);
    assert.throws(() => captureMobileContentReply(operation, req, scope,
      { status: 200, category: 'success', body: { ...body, items: [{ ...body.items[0], kind: kind === 'chart' ? 'playlist' : 'chart' }] } }, trusted));
  }
});

test('私有response绑定原调用和独立可信context，没有beforeSend可序列化回调', () => {
  const expected = { type: 'mobile-content-main-request' as const, id, operation: 'listRecentlyAddedAlbums' as const, scope, request };
  const response = { type: 'mobile-content-main-response', id, operation: expected.operation, scope, reply: reply(), context };
  assert.equal(captureMobileContentPrivateResponse(response, expected, context).reply.status, 200);
  for (const change of [{ id: '22222222-2222-4222-8222-222222222222' }, { operation: 'listFavoriteAlbums' },
    { scope: { ...scope, ownerEpoch: 'owner-b' } }, { context: { ...context, revision: 'forged' } }, { beforeSend: () => {} }]) {
    assert.throws(() => captureMobileContentPrivateResponse({ ...response, ...change }, expected, context));
  }
});
