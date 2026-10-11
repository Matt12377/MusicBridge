import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { mobileDataSnapshot } from '@music-bridge/contracts';
import type { MobileFavoriteAlbumState, MobilePersonalPlaylistReceipt, MobileRequestMap, MobileTrack, MobileUIAlbumRecord } from '@music-bridge/contracts';
import type { MobileContentOwnerDispatch, MobileContentOwnerResult } from '../../src/mobile/owner-content-protocol.js';
import { captureMobileContentOwnerRequest, isMobileContentOwnerResult } from '../../src/mobile/owner-content-protocol.js';
import { isMobileOwnerPrivateResult } from '../../src/mobile/owner-protocol.js';
import { mobileContentDomainSnapshot, createMobileContentState } from '../../src/mobile/content-state.js';
import { contentLimits, ownerFixture, selected, snapshot } from './content-owner-fixture.js';

function failure(result: MobileContentOwnerResult, code: string, status: number): void {
  assert.equal(result.kind, 'content-error'); if (result.kind !== 'content-error') throw new Error('期望明确拒绝。');
  assert.equal(result.code, code); assert.equal(result.status, status); assert.equal(result.retryable, false);
}
function safeExpected(value: unknown) {
  const result = mobileDataSnapshot(value); assert.equal(result.ok, true);
  if (!result.ok) throw new Error('完整期望值不符合安全 JSON 闭集。'); return result.value;
}
type Fixture = Awaited<ReturnType<typeof ownerFixture>>;
const favoriteBody = (result: MobileContentOwnerResult) => snapshot(result).reply.body as MobileFavoriteAlbumState;
const playlistBody = (result: MobileContentOwnerResult) => snapshot(result).reply.body as MobilePersonalPlaylistReceipt;
function albumWrite(f: Fixture, revision: string, value = true, key = 'album.once', album: MobileUIAlbumRecord | null = null): MobileContentOwnerDispatch {
  const id = album?.id ?? f.track.albumId;
  return { action: 'dispatch', operation: 'setAlbumFavorite', scope: f.scope, request: {
    path: `/mobile/v1/ui/favorites/albums/${encodeURIComponent(id)}`, pathParameters: { albumId: id }, query: {},
    idempotencyKey: key, body: { source: album?.source ?? 'local', isFavorite: value,
      accountDomain: f.scope.accountDomain, expectedRevision: revision } }, ...(album ? { providerFacts: { album } } : {}) };
}
function trackWrite(f: Fixture, revision: string, value: boolean, key: string, track = f.track,
  album: MobileUIAlbumRecord | null = null): MobileContentOwnerDispatch {
  return { action: 'dispatch', operation: 'setTrackFavorite', scope: f.scope, request: {
    path: `/mobile/v1/ui/favorites/tracks/${encodeURIComponent(track.id)}`, pathParameters: { trackId: track.id }, query: {},
    idempotencyKey: key, body: { source: track.source, isFavorite: value, accountDomain: f.scope.accountDomain,
      expectedRevision: revision, albumId: track.albumId, versionId: track.versionId, contentRevision: track.contentRevision } },
  ...(album ? { providerFacts: { album, track } } : {}) };
}
async function getFavorite(f: Fixture, albumId = f.track.albumId, source: 'local' | 'netease' = 'local') {
  return favoriteBody(await f.dispatch({ action: 'dispatch', operation: 'getFavoriteAlbumState', scope: f.scope,
    request: { path: `/mobile/v1/ui/favorites/albums/${encodeURIComponent(albumId)}`, pathParameters: { albumId }, query: { source }, body: null } }));
}
function emptyCollectionRevision(f: Fixture): string {
  return mobileContentDomainSnapshot(createMobileContentState({ serverId: f.serverId, datasetId: f.datasetId }), f.scope, contentLimits).collectionRevision;
}
function createPlaylist(f: Fixture, revision: string, key: string, first = f.track): MobileContentOwnerDispatch {
  return { action: 'dispatch', operation: 'createPersonalPlaylist', scope: f.scope,
    request: { path: '/mobile/v1/ui/playlists', pathParameters: {}, query: {}, idempotencyKey: key,
      body: { accountDomain: f.scope.accountDomain, expectedCollectionRevision: revision,
        draft: { title: '  自有歌单  ', description: '  原子内容  ', icon: 'music.note' }, initialTrack: selected(first) } } };
}
const listPlaylists: MobileRequestMap['listPersonalPlaylists'] = { path: '/mobile/v1/ui/playlists', pathParameters: {}, query: {}, body: null };
function providerAlbum(): MobileUIAlbumRecord {
  return { id: 'netease.album', source: 'netease', title: '受控 Provider 发行', artists: ['合成艺人'],
    editionLabel: '合成标准发行', trackCount: 101 };
}
function providerTrack(index: number): MobileTrack {
  return { id: `nt:${index}`, title: '重复标题仍是独立曲目', artists: ['合成艺人'], source: 'netease', sourceItemId: `ns:${index}`,
    albumId: 'netease.album', versionId: `nv:${index}`, contentRevision: `nc:${index}`, editionLabel: '合成标准发行',
    durationMs: 1000, audio: { codec: 'flac', container: 'flac', sampleRateHz: 48000, bitsPerSample: 24, channels: 2 }, availability: 'unavailable' };
}
async function providerScope(f: Fixture): Promise<void> {
  Object.assign(f.scope, { accountDomain: 'netease.synthetic', providerEpoch: 'provider.1' });
  assert.equal((await f.dispatch({ action: 'updateScope', scope: f.scope })).kind, 'content-scope-updated');
}
function providerRequest(f: Fixture, revision: string, cursor?: string): MobileRequestMap['listFavoriteAlbumTracks'] {
  return { path: '/mobile/v1/ui/favorites/albums/netease.album/tracks', pathParameters: { albumId: 'netease.album' },
    query: { source: 'netease', accountDomain: f.scope.accountDomain, favoritesRevision: revision, limit: 100, ...(cursor ? { cursor } : {}) }, body: null };
}

test('内容Owner：初始化沿原epoch，Scope必须显式登记，换key不能静默重建', async t => {
  const f = await ownerFixture(t);
  const context = await f.dispatch({ action: 'context', serverId: f.serverId });
  assert.equal(context.kind, 'content-context'); if (context.kind === 'content-context') assert.equal(context.ownerEpoch, f.ownerEpoch);
  const foreign = { ...f.scope, deviceId: 'unregistered.device' };
  failure(await f.dispatch({ action: 'dispatch', operation: 'listPersonalPlaylists', scope: foreign, request: listPlaylists }), 'UNAUTHORIZED', 401);
  const changedKey = await f.dispatch({ action: 'initialize', serverId: f.serverId, datasetId: f.datasetId, key: randomBytes(32) });
  failure(changedKey, 'BUSY', 503); if (changedKey.kind === 'content-error') assert.equal(changedKey.outcome, 'unknown');
  assert.equal((await f.dispatch({ action: 'context', serverId: f.serverId })).kind, 'content-context');
});

test('内容Owner：真扫描整专与单曲独立，旧回执优先CAS且改正文拒绝', async t => {
  const f = await ownerFixture(t), initial = await getFavorite(f);
  const original = albumWrite(f, initial.favoritesRevision), first = await f.dispatch(original);
  assert.equal(favoriteBody(first).favorite?.albumFavorite, true);
  const track = await f.dispatch(trackWrite(f, favoriteBody(first).favoritesRevision, true, 'track.once'));
  const removed = favoriteBody(await f.dispatch(albumWrite(f, favoriteBody(track).favoritesRevision, false, 'album.remove')));
  assert.equal(removed.favorite?.albumFavorite, false); assert.deepEqual(removed.favorite?.favoriteTracks, safeExpected([selected(f.track)]));
  assert.deepEqual(snapshot(await f.dispatch(original)).reply, snapshot(first).reply, '后续修订不重写原200回执。');
  failure(await f.dispatch(albumWrite(f, initial.favoritesRevision, false, 'album.once')), 'IDEMPOTENCY_CONFLICT', 409);
  failure(await f.dispatch(albumWrite(f, initial.favoritesRevision, true, 'fresh.stale')), 'REVISION_CONFLICT', 409);
});

test('内容Owner：只读lookup先返回原Provider回执，不取新事实或再提交，缺失与冲突明确区分', async t => {
  const f = await ownerFixture(t); await providerScope(f);
  const original = albumWrite(f, (await getFavorite(f, 'netease.album', 'netease')).favoritesRevision, true, 'provider.receipt', providerAlbum());
  const first = snapshot(await f.dispatch(original)), file = path.join(f.directory, 'mobile-content', 'content-state.v1.sealed.json');
  const persisted = await readFile(file), request = original.request as MobileRequestMap['setAlbumFavorite'];
  const scope = { ...f.scope, accessGeneration: 2 };
  assert.equal((await f.dispatch({ action: 'updateScope', scope })).kind, 'content-scope-updated');
  const lookup = snapshot(await f.dispatch({ action: 'lookup-receipt', operation: 'setAlbumFavorite', scope, request }));
  assert.deepEqual(lookup.reply, first.reply); assert.equal(lookup.scope.accessGeneration, 2);
  assert.equal((await f.dispatch({ action: 'revalidate', scope, snapshotId: lookup.snapshotId })).kind, 'content-revalidated');
  assert.deepEqual(await readFile(file), persisted, 'lookup和发送前复核均不得重写密文或commit。');
  const absent = await f.dispatch({ action: 'lookup-receipt', operation: 'setAlbumFavorite', scope,
    request: { ...request, idempotencyKey: 'never.submitted' } });
  assert.equal(absent.kind, 'content-receipt-not-found');
  failure(await f.dispatch({ action: 'lookup-receipt', operation: 'setAlbumFavorite', scope,
    request: { ...request, body: { ...request.body, isFavorite: false } } }), 'IDEMPOTENCY_CONFLICT', 409);
  assert.deepEqual(await readFile(file), persisted);
});

test('内容Owner：歌单首次曲目与回执同次提交，首曲无封面不会找后曲回填', async t => {
  const f = await ownerFixture(t), input = createPlaylist(f, emptyCollectionRevision(f), 'playlist.once');
  const first = playlistBody(await f.dispatch(input));
  assert.equal(first.playlist.title, '自有歌单'); assert.equal(first.playlist.trackCount, 1);
  assert.equal(first.playlist.coverArtworkId, f.track.artworkId ?? null);
  const add: MobileContentOwnerDispatch = { action: 'dispatch', operation: 'addPersonalPlaylistTrack', scope: f.scope,
    request: { path: `/mobile/v1/ui/playlists/${first.playlist.playlistId}/tracks`, pathParameters: { playlistId: first.playlist.playlistId },
      query: {}, idempotencyKey: 'add.same', body: { accountDomain: f.scope.accountDomain,
        expectedRevision: first.playlist.playlistRevision, selection: selected(f.track) } } };
  const duplicate = playlistBody(await f.dispatch(add)); assert.deepEqual(duplicate.playlist, first.playlist);
  const read = snapshot(await f.dispatch({ action: 'dispatch', operation: 'listPersonalPlaylistTracks', scope: f.scope,
    request: { path: add.request.path, pathParameters: { playlistId: first.playlist.playlistId }, body: null,
      query: { accountDomain: f.scope.accountDomain, playlistRevision: first.playlist.playlistRevision } } }));
  assert.deepEqual((read.reply.body as { items: MobileTrack[] }).items, [f.track]);
  assert.deepEqual(snapshot(await f.dispatch(input)).reply.body, first);
});

test('内容Owner：账户内容共享而原key回执按设备隔离，账户域不得串读', async t => {
  const f = await ownerFixture(t), initial = await getFavorite(f), first = favoriteBody(await f.dispatch(albumWrite(f, initial.favoritesRevision)));
  const second = { ...f.scope, deviceId: 'device.2' };
  assert.equal((await f.dispatch({ action: 'updateScope', scope: second })).kind, 'content-scope-updated');
  const request = albumWrite(f, first.favoritesRevision, false); request.scope = second;
  const ownReply = favoriteBody(await f.dispatch(request)); assert.equal(ownReply.favorite, null);
  const foreign = { ...second, accountDomain: 'local.other-domain' };
  assert.equal((await f.dispatch({ action: 'updateScope', scope: foreign })).kind, 'content-scope-updated');
  failure(await f.dispatch({ action: 'dispatch', operation: 'listPersonalPlaylists', scope: second, request: listPlaylists }), 'UNAUTHORIZED', 401);
  const page = snapshot(await f.dispatch({ action: 'dispatch', operation: 'listFavoriteAlbums', scope: foreign,
    request: { path: '/mobile/v1/ui/favorites/albums', pathParameters: {}, query: {}, body: null } }));
  assert.deepEqual((page.reply.body as { items: unknown[] }).items, []);
});

test('内容Owner：未知本地selection明确失败，不能伪造发行或静默漏曲', async t => {
  const f = await ownerFixture(t), initial = await getFavorite(f);
  const bad = trackWrite(f, initial.favoritesRevision, true, 'unknown.track');
  bad.request = { ...bad.request, path: '/mobile/v1/ui/favorites/tracks/lt:unknown', pathParameters: { trackId: 'lt:unknown' } };
  const result = await f.dispatch(bad); assert.equal(result.kind, 'content-error');
  assert.equal((await getFavorite(f)).favoritesRevision, initial.favoritesRevision);
  assert.deepEqual(await readFile(f.file), f.original);
});

test('内容Owner：Provider整专两阶段101曲分页只取计划页，来源修订漂移拒绝', async t => {
  const f = await ownerFixture(t); await providerScope(f);
  const initial = await getFavorite(f, 'netease.album', 'netease');
  const favorite = favoriteBody(await f.dispatch(albumWrite(f, initial.favoritesRevision, true, 'provider.album', providerAlbum())));
  const firstRequest = providerRequest(f, favorite.favoritesRevision);
  const plan = await f.dispatch({ action: 'plan-read', scope: f.scope, operation: 'listFavoriteAlbumTracks', request: firstRequest });
  assert.equal(plan.kind, 'content-read-plan'); if (plan.kind !== 'content-read-plan') throw new Error('缺少可信分页计划。');
  assert.equal(plan.offset, 0); assert.equal(plan.limit, 100); assert.equal(plan.selections, null); assert.equal(plan.total, null);
  const first = snapshot(await f.dispatch({ action: 'dispatch', scope: f.scope, operation: 'listFavoriteAlbumTracks', request: firstRequest,
    providerPage: { planId: plan.planId, scope: f.scope, album: providerAlbum(), offset: 0, limit: 100, total: 101,
      sourceRevision: 'provider.collection.1', items: Array.from({ length: 100 }, (_, i) => providerTrack(i)) } }));
  const body = first.reply.body as { items: MobileTrack[]; nextCursor: string | null }; assert.equal(body.items.length, 100); assert.ok(body.nextCursor);
  const secondRequest = providerRequest(f, favorite.favoritesRevision, body.nextCursor), second = await f.dispatch({ action: 'plan-read', scope: f.scope,
    operation: 'listFavoriteAlbumTracks', request: secondRequest });
  assert.equal(second.kind, 'content-read-plan'); if (second.kind !== 'content-read-plan') throw new Error('缺少第二页计划。'); assert.equal(second.offset, 100);
  const page = { planId: second.planId, scope: f.scope, album: providerAlbum(), offset: 100, limit: 100, total: 101,
    sourceRevision: 'provider.collection.changed', items: [providerTrack(100)] };
  failure(await f.dispatch({ action: 'dispatch', scope: f.scope, operation: 'listFavoriteAlbumTracks', request: secondRequest, providerPage: page }), 'SOURCE_CHANGED', 409);
  const final = snapshot(await f.dispatch({ action: 'dispatch', scope: f.scope, operation: 'listFavoriteAlbumTracks', request: secondRequest,
    providerPage: { ...page, sourceRevision: 'provider.collection.1' } }));
  assert.equal((final.reply.body as { items: MobileTrack[] }).items[0]?.id, 'nt:100');
  assert.equal((final.reply.body as { nextCursor: string | null }).nextCursor, null);
});

test('内容Owner：Provider单曲收藏计划只接受精确选择，不拿整专首页替代', async t => {
  const f = await ownerFixture(t); await providerScope(f);
  const initial = await getFavorite(f, 'netease.album', 'netease');
  const favorite = favoriteBody(await f.dispatch(trackWrite(f, initial.favoritesRevision, true, 'provider.track', providerTrack(100), providerAlbum())));
  assert.equal(favorite.favorite?.albumFavorite, false);
  const request = providerRequest(f, favorite.favoritesRevision), plan = await f.dispatch({ action: 'plan-read', scope: f.scope,
    operation: 'listFavoriteAlbumTracks', request });
  assert.equal(plan.kind, 'content-read-plan'); if (plan.kind !== 'content-read-plan') throw new Error('缺少单曲计划。');
  assert.deepEqual(plan.selections, safeExpected([selected(providerTrack(100))])); assert.equal(plan.total, 1);
  const page = { planId: plan.planId, scope: f.scope, album: providerAlbum(), offset: 0, limit: 100, total: 1,
    sourceRevision: 'provider.track-set.1', items: [providerTrack(0)] };
  failure(await f.dispatch({ action: 'dispatch', scope: f.scope, operation: 'listFavoriteAlbumTracks', request, providerPage: page }), 'SOURCE_CHANGED', 409);
  const accepted = snapshot(await f.dispatch({ action: 'dispatch', scope: f.scope, operation: 'listFavoriteAlbumTracks', request,
    providerPage: { ...page, items: [providerTrack(100)] } }));
  assert.deepEqual((accepted.reply.body as { items: MobileTrack[] }).items, safeExpected([providerTrack(100)]));
});

test('内容Owner：Scope刷新撤销围栏阻断旧快照，原持久回执仍可由当前权限读取', async t => {
  const f = await ownerFixture(t), initial = await getFavorite(f), input = albumWrite(f, initial.favoritesRevision);
  const first = snapshot(await f.dispatch(input));
  const refresh = { ...f.scope, accessGeneration: 2 };
  assert.equal((await f.dispatch({ action: 'updateScope', scope: refresh })).kind, 'content-scope-updated');
  failure(await f.dispatch({ action: 'revalidate', scope: f.scope, snapshotId: first.snapshotId }), 'UNAUTHORIZED', 401);
  const replay = snapshot(await f.dispatch({ ...input, scope: refresh })); assert.deepEqual(replay.reply, first.reply);
  failure(await f.dispatch({ action: 'revalidate', scope: refresh, snapshotId: first.snapshotId }), 'SOURCE_CHANGED', 409);
  assert.equal((await f.dispatch({ action: 'invalidateScope', kind: 'device', deviceId: f.scope.deviceId })).kind, 'content-scope-invalidated');
  failure(await f.dispatch({ action: 'revalidate', scope: refresh, snapshotId: replay.snapshotId }), 'UNAUTHORIZED', 401);
  failure(await f.dispatch({ action: 'updateScope', scope: f.scope }), 'UNAUTHORIZED', 401);
  failure(await f.dispatch({ action: 'updateScope', scope: { ...refresh, accessGeneration: 3 } }), 'UNAUTHORIZED', 401);
  const next = { ...f.scope, deviceEpoch: 2 };
  assert.equal((await f.dispatch({ action: 'updateScope', scope: next })).kind, 'content-scope-updated');
  const retained = favoriteBody(await f.dispatch({ action: 'dispatch', operation: 'getFavoriteAlbumState', scope: next,
    request: { path: input.request.path, pathParameters: input.request.pathParameters, query: { source: 'local' }, body: null } }));
  assert.equal(retained.favorite?.albumFavorite, true, '撤销设备不会删除账户内容或旧持久回执。');
});

test('内容Owner：同代账号切换清除旧镜像，Provider失效不冒充设备撤销', async t => {
  const f = await ownerFixture(t), originalScope = { ...f.scope };
  await providerScope(f);
  failure(await f.dispatch({ action: 'dispatch', operation: 'listPersonalPlaylists', scope: originalScope, request: listPlaylists }), 'UNAUTHORIZED', 401);
  const oldProvider = { ...f.scope };
  const replaced = { ...oldProvider, accountDomain: 'netease.replaced', providerEpoch: 'provider.2' };
  assert.equal((await f.dispatch({ action: 'updateScope', scope: replaced })).kind, 'content-scope-updated');
  failure(await f.dispatch({ action: 'dispatch', operation: 'listPersonalPlaylists', scope: oldProvider, request: listPlaylists }), 'UNAUTHORIZED', 401);
  assert.equal((await f.dispatch({ action: 'invalidateScope', kind: 'provider', providerEpoch: 'provider.2' })).kind, 'content-scope-invalidated');
  failure(await f.dispatch({ action: 'updateScope', scope: replaced }), 'UNAUTHORIZED', 401);
  assert.equal((await f.dispatch({ action: 'updateScope', scope: originalScope })).kind, 'content-scope-updated');
  assert.equal((await f.dispatch({ action: 'dispatch', operation: 'listPersonalPlaylists', scope: originalScope, request: listPlaylists })).kind, 'content-snapshot');
});

test('内容Owner：beforeSend重核实际目录修订，最近新增使用原账本时间', async t => {
  const f = await ownerFixture(t);
  const recent = snapshot(await f.dispatch({ action: 'dispatch', operation: 'listRecentlyAddedAlbums', scope: f.scope,
    request: { path: '/mobile/v1/ui/home/added-albums', pathParameters: {}, query: {}, body: null } }));
  const items = (recent.reply.body as { items: { id: string; addedAt: string }[] }).items; assert.equal(items.length, 1);
  const created = f.repository.privateMobileCatalogAccess!(db => db.prepare("SELECT created_at FROM local_catalog_ledger WHERE operation='create-edition' AND json_extract(result,'$.id')=?").get(f.edition.id));
  assert.equal(items[0]?.addedAt, created?.created_at);
  f.repository.localCatalog.createEdition({ commandId: randomUUID(), title: '新的真实目录修订', edition: '未造曲目' });
  failure(await f.dispatch({ action: 'revalidate', scope: f.scope, snapshotId: recent.snapshotId }), 'SOURCE_CHANGED', 409);
});

test('内容Owner：计划与快照共同16槽和15秒有效期，满额不驱逐活快照', async t => {
  const f = await ownerFixture(t);
  // 夹具启动的 local-track 不占快照；十六条实际读取均独立有界。
  const results = [];
  for (let i = 0; i < 16; i++) results.push(snapshot(await f.dispatch({ action: 'dispatch', operation: 'listPersonalPlaylists', scope: f.scope, request: listPlaylists })));
  failure(await f.dispatch({ action: 'dispatch', operation: 'listPersonalPlaylists', scope: f.scope, request: listPlaylists }), 'BUSY', 503);
  assert.equal((await f.dispatch({ action: 'revalidate', scope: f.scope, snapshotId: results[0]!.snapshotId })).kind, 'content-revalidated');
  f.advance(15000);
  failure(await f.dispatch({ action: 'revalidate', scope: f.scope, snapshotId: results[0]!.snapshotId }), 'SOURCE_CHANGED', 409);
  assert.equal((await f.dispatch({ action: 'dispatch', operation: 'listPersonalPlaylists', scope: f.scope, request: listPlaylists })).kind, 'content-snapshot');
});

test('内容Owner：密文原子存储0600与冷重开保持原key/body回执，不改变源文件', async t => {
  const f = await ownerFixture(t), initial = await getFavorite(f), input = albumWrite(f, initial.favoritesRevision);
  const first = snapshot(await f.dispatch(input)), file = path.join(f.directory, 'mobile-content', 'content-state.v1.sealed.json');
  const directory = await lstat(path.dirname(file)), stat = await lstat(file), bytes = await readFile(file);
  assert.equal(directory.mode & 0o777, 0o700); assert.equal(stat.mode & 0o777, 0o600); assert.equal(stat.nlink, 1);
  assert.equal(bytes.includes(Buffer.from('真实夹具发行')), false); assert.equal(bytes.includes(f.key), false);
  await f.restart(); assert.deepEqual(snapshot(await f.dispatch(input)).reply, first.reply);
  assert.deepEqual(await readFile(f.file), f.original);
});

test('内容Owner：rename后fsync故障保留UNKNOWN，显式原commit只读对账不重做', async t => {
  const f = await ownerFixture(t), initial = await getFavorite(f), input = albumWrite(f, initial.favoritesRevision);
  const original = fs.fsyncSync; let failed = false;
  fs.fsyncSync = (fd: number): void => { if (!failed && fs.fstatSync(fd).isDirectory()) { failed = true; throw new Error('受控发布后的目录fsync故障'); } original(fd); };
  syncBuiltinESMExports();
  let unknown: MobileContentOwnerResult;
  try { unknown = await f.dispatch(input); } finally { fs.fsyncSync = original; syncBuiltinESMExports(); }
  failure(unknown, 'BUSY', 503); assert.equal(failed, true);
  if (unknown.kind !== 'content-error') throw new Error('没有保留未知提交。'); assert.equal(unknown.outcome, 'unknown'); assert.ok(unknown.commitId);
  const file = path.join(f.directory, 'mobile-content', 'content-state.v1.sealed.json'), committed = await readFile(file);
  const repeat = await f.dispatch(input); failure(repeat, 'BUSY', 503);
  assert.deepEqual(await readFile(file), committed, 'UNKNOWN不能第二次保存或生成新的commit。');
  const wrong = { ...input.request, idempotencyKey: 'other.intent' } as MobileRequestMap['setAlbumFavorite'];
  failure(await f.dispatch({ action: 'revalidate', scope: f.scope, commitId: unknown.commitId,
    operation: 'setAlbumFavorite', request: wrong }), 'BUSY', 503);
  const resolved = snapshot(await f.dispatch({ action: 'revalidate', scope: f.scope, commitId: unknown.commitId,
    operation: 'setAlbumFavorite', request: input.request as MobileRequestMap['setAlbumFavorite'] }));
  assert.equal((resolved.reply.body as MobileFavoriteAlbumState).favorite?.albumFavorite, true);
  assert.deepEqual(await readFile(file), committed); assert.deepEqual(snapshot(await f.dispatch(input)).reply, resolved.reply);
});

test('内容Owner：私有闭集拒绝getter和额外键，普通mobile-error不能替代content回执', () => {
  let calls = 0;
  const raw = { action: 'initialize', serverId: 'server.1', datasetId: 'dataset.1', get key() { calls++; return randomBytes(32); } };
  assert.throws(() => captureMobileContentOwnerRequest(raw)); assert.equal(calls, 0);
  assert.throws(() => captureMobileContentOwnerRequest({ action: 'context', serverId: 'server.1', arbitrarySql: 'not permitted' }));
  assert.equal(isMobileContentOwnerResult({ kind: 'mobile-error', status: 503, code: 'BUSY', retryable: false, outcome: 'unknown' },
    { action: 'context', serverId: 'server.1' }), false);
  assert.equal(isMobileOwnerPrivateResult({ kind: 'mobile-error', status: 503, code: 'BUSY', retryable: false, outcome: 'unknown' },
    { kind: 'content', datasetId: 'dataset.1', request: { action: 'context', serverId: 'server.1' } }), false);
});
