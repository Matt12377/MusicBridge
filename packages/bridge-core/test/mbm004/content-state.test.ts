import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MobileTrack, MobileUIAlbumRecord } from '@music-bridge/contracts';
import { mobileDataSnapshot } from '@music-bridge/contracts';
import {
  applyMobileContentMutation, createMobileContentState, decodeMobileContentState,
  encodeMobileContentState, lookupMobileContentReceipt, mobileContentDomainSnapshot,
} from '../../src/mobile/content-state.js';
import type { MobileContentMutationInput, MobileContentScope, MobileContentStateLimits } from '../../src/mobile/content-types.js';
import { MobileServiceError } from '../../src/mobile/types.js';

const limits: MobileContentStateLimits = { stateBytes: 2 * 1024 * 1024, receipts: 100,
  albums: 100, favoriteTracks: 200, playlists: 100, playlistTracks: 200 };
const scope: MobileContentScope = { serverId: 'server.004', datasetId: 'dataset.004', deviceId: 'device.1',
  deviceEpoch: 1, accessGeneration: 1, ownerEpoch: 'owner.1', accountDomain: 'content.1', providerEpoch: null };
const album: MobileUIAlbumRecord = { id: 'album.1', title: '同名发行', artists: ['合成艺人'], source: 'local', editionLabel: '发行一', trackCount: 3 };
const track: MobileTrack = { id: 'track.1', title: '合成曲目', artists: ['合成艺人'], albumId: album.id, source: 'local',
  sourceItemId: 'source.1', versionId: 'version.1', contentRevision: 'content.track.1', editionLabel: '发行一',
  durationMs: 1000, audio: { codec: 'flac', container: 'flac', sampleRateHz: 48000, bitsPerSample: 24, channels: 2 }, availability: 'available' };
const selection = (t: MobileTrack = track) => ({ trackId: t.id, source: t.source, versionId: t.versionId, contentRevision: t.contentRevision });
const initial = () => createMobileContentState({ serverId: scope.serverId, datasetId: scope.datasetId });
function albumInput(revision: string, value: boolean, key: string, who = scope): MobileContentMutationInput {
  return { operation: 'setAlbumFavorite', scope: who, request: { path: '/mobile/v1/ui/favorites/albums/' + album.id,
    pathParameters: { albumId: album.id }, query: {}, idempotencyKey: key,
    body: { source: 'local', isFavorite: value, accountDomain: who.accountDomain, expectedRevision: revision } } };
}
function trackInput(revision: string, value: boolean, key: string, t = track): MobileContentMutationInput {
  return { operation: 'setTrackFavorite', scope, request: { path: '/mobile/v1/ui/favorites/tracks/' + t.id,
    pathParameters: { trackId: t.id }, query: {}, idempotencyKey: key,
    body: { source: t.source, isFavorite: value, accountDomain: scope.accountDomain, expectedRevision: revision,
      albumId: t.albumId, versionId: t.versionId, contentRevision: t.contentRevision } } };
}
function createInput(revision: string, key: string, first: MobileTrack | null = null): MobileContentMutationInput {
  return { operation: 'createPersonalPlaylist', scope, request: { path: '/mobile/v1/ui/playlists', pathParameters: {}, query: {},
    idempotencyKey: key, body: { accountDomain: scope.accountDomain, expectedCollectionRevision: revision,
      draft: { title: '  合成歌单  ', icon: 'music.note', description: '  描述  ' }, initialTrack: first && selection(first) } } };
}
function addInput(id: string, revision: string, key: string, t = track): MobileContentMutationInput {
  return { operation: 'addPersonalPlaylistTrack', scope, request: { path: '/mobile/v1/ui/playlists/' + id + '/tracks',
    pathParameters: { playlistId: id }, query: {}, idempotencyKey: key,
    body: { accountDomain: scope.accountDomain, expectedRevision: revision, selection: selection(t) } } };
}
const errorCode = (code: string) => (error: unknown) => error instanceof MobileServiceError && error.code === code;

test('内容状态：整专与单曲独立，取消其中一种保留另一种', () => {
  let state = initial();
  state = applyMobileContentMutation(state, trackInput(mobileContentDomainSnapshot(state, scope, limits).favoritesRevision, true, 'track.on'), { album, track }, { limits }).state;
  let view = mobileContentDomainSnapshot(state, scope, limits);
  const expected = mobileDataSnapshot([selection()]); assert.equal(expected.ok, true);
  assert.equal(Object.getPrototypeOf(view.favorites[0]!.favoriteTracks[0]), null);
  assert.equal(view.favorites[0]!.albumFavorite, false); assert.deepEqual(view.favorites[0]!.favoriteTracks, expected.ok ? expected.value : null);
  state = applyMobileContentMutation(state, albumInput(view.favoritesRevision, true, 'album.on'), { album }, { limits }).state;
  view = mobileContentDomainSnapshot(state, scope, limits); assert.equal(view.favorites[0]!.albumFavorite, true);
  state = applyMobileContentMutation(state, albumInput(view.favoritesRevision, false, 'album.off'), { album }, { limits }).state;
  view = mobileContentDomainSnapshot(state, scope, limits); assert.equal(view.favorites.length, 1); assert.equal(view.favorites[0]!.favoriteTracks.length, 1);
  state = applyMobileContentMutation(state, trackInput(view.favoritesRevision, false, 'track.off'), { album, track }, { limits }).state;
  assert.equal(mobileContentDomainSnapshot(state, scope, limits).favorites.length, 0);
});

test('内容状态：同域设备共享集合，不共享写回执或其他账户域', () => {
  const state = initial(), revision = mobileContentDomainSnapshot(state, scope, limits).favoritesRevision;
  const input = albumInput(revision, true, 'shared-key');
  const first = applyMobileContentMutation(state, input, { album }, { limits });
  const device2 = { ...scope, deviceId: 'device.2' };
  assert.deepEqual(mobileContentDomainSnapshot(first.state, device2, limits).favorites, mobileContentDomainSnapshot(first.state, scope, limits).favorites);
  assert.equal(lookupMobileContentReceipt(first.state, { ...input, scope: device2 }, limits), null);
  const other = { ...scope, accountDomain: 'content.other', providerEpoch: 'provider.2' };
  assert.equal(mobileContentDomainSnapshot(first.state, other, limits).favorites.length, 0);
  assert.equal(lookupMobileContentReceipt(first.state, albumInput(revision, true, 'shared-key', other), limits), null);
});

test('内容状态：CAS失败不改变数据，原回执优先于旧CAS和新元数据', () => {
  const state = initial(), input = albumInput(mobileContentDomainSnapshot(state, scope, limits).favoritesRevision, true, 'original');
  const first = applyMobileContentMutation(state, input, { album }, { limits });
  const replay = applyMobileContentMutation(first.state, { ...input, scope: { ...scope, accessGeneration: 2, ownerEpoch: 'owner.cold' } }, {}, { limits });
  assert.equal(replay.replayed, true); assert.deepEqual(replay.reply, first.reply); assert.deepEqual(replay.state, first.state);
  const bytes = encodeMobileContentState(first.state, limits);
  assert.throws(() => applyMobileContentMutation(first.state, albumInput('stale.rev', false, 'new'), { album }, { limits }), errorCode('REVISION_CONFLICT'));
  assert.deepEqual(encodeMobileContentState(first.state, limits), bytes);
});

test('内容状态：同key改正文或目标拒绝，递归getter不被执行', () => {
  const state = initial(), input = albumInput(mobileContentDomainSnapshot(state, scope, limits).favoritesRevision, true, 'identity');
  const first = applyMobileContentMutation(state, input, { album }, { limits });
  const changed = albumInput(mobileContentDomainSnapshot(first.state, scope, limits).favoritesRevision, false, 'identity');
  assert.throws(() => applyMobileContentMutation(first.state, changed, { album }, { limits }), errorCode('IDEMPOTENCY_CONFLICT'));
  const target = { ...input, request: { ...input.request, path: '/mobile/v1/ui/favorites/albums/album.other', pathParameters: { albumId: 'album.other' } } };
  assert.throws(() => lookupMobileContentReceipt(first.state, target, limits), errorCode('IDEMPOTENCY_CONFLICT'));
  let called = 0; const forged: unknown = { ...input, request: { ...input.request, get body() { called++; return input.request.body; } } };
  assert.throws(() => applyMobileContentMutation(first.state, forged as MobileContentMutationInput, { album }, { limits }), errorCode('INVALID_REQUEST')); assert.equal(called, 0);
});

test('内容状态：精确曲目版本与所属专辑来自可信facts，不猜缺失字段', () => {
  const state = initial(), revision = mobileContentDomainSnapshot(state, scope, limits).favoritesRevision;
  const input = trackInput(revision, true, 'exact');
  for (const facts of [{ album }, { album, track: { ...track, albumId: 'album.other' } }, { album, track: { ...track, versionId: 'version.other' } }]) {
    assert.throws(() => applyMobileContentMutation(state, input, facts, { limits }), errorCode('SOURCE_CHANGED'));
  }
  assert.equal(state.revision, 0); assert.equal(state.receipts.length, 0);
});

test('内容状态：空歌单和同名歌单独立，原201完整回执冷序列化保持', () => {
  const state = initial(), input = createInput(mobileContentDomainSnapshot(state, scope, limits).collectionRevision, 'create.1');
  const first = applyMobileContentMutation(state, input, {}, { limits, newPlaylistId: 'playlist.1' });
  assert.equal(first.reply.status, 201);
  const view = mobileContentDomainSnapshot(first.state, scope, limits), p = view.playlists[0]!.playlist;
  assert.equal(p.title, '合成歌单'); assert.equal(p.description, '描述'); assert.equal(p.trackCount, 0); assert.equal(p.coverArtworkId, null);
  const second = applyMobileContentMutation(first.state, createInput(view.collectionRevision, 'create.2'), {}, { limits, newPlaylistId: 'playlist.2' });
  assert.deepEqual(mobileContentDomainSnapshot(second.state, scope, limits).playlists.map(v => v.playlist.playlistId), ['playlist.1', 'playlist.2']);
  const cold = decodeMobileContentState(encodeMobileContentState(second.state, limits), limits);
  assert.deepEqual(lookupMobileContentReceipt(cold, input, limits), first.reply);
});

test('内容状态：创建与首曲原子，错误首曲不留下空歌单或回执', () => {
  const state = initial(), input = createInput(mobileContentDomainSnapshot(state, scope, limits).collectionRevision, 'atomic', track);
  assert.throws(() => applyMobileContentMutation(state, input, {}, { limits, newPlaylistId: 'playlist.1' }), errorCode('SOURCE_CHANGED'));
  assert.equal(state.revision, 0); assert.equal(state.domains.length, 0); assert.equal(state.receipts.length, 0);
  const first = applyMobileContentMutation(state, input, { track: { ...track, artworkId: 'artwork.first' } }, { limits, newPlaylistId: 'playlist.1' });
  const p = mobileContentDomainSnapshot(first.state, scope, limits).playlists[0]!.playlist;
  assert.equal(p.trackCount, 1); assert.equal(p.coverArtworkId, 'artwork.first');
});

test('内容状态：无图首曲不取后曲封面，相同精确曲目不重复计数或修订', () => {
  const state = initial(), first = applyMobileContentMutation(state, createInput(mobileContentDomainSnapshot(state, scope, limits).collectionRevision, 'create', track), { track }, { limits, newPlaylistId: 'playlist.1' });
  const one = mobileContentDomainSnapshot(first.state, scope, limits).playlists[0]!.playlist;
  const next = { ...track, id: 'track.2', sourceItemId: 'source.2', artworkId: 'artwork.later' };
  const added = applyMobileContentMutation(first.state, addInput(one.playlistId, one.playlistRevision, 'add', next), { track: next }, { limits });
  const two = mobileContentDomainSnapshot(added.state, scope, limits).playlists[0]!.playlist;
  assert.equal(two.trackCount, 2); assert.equal(two.coverArtworkId, null);
  const duplicate = applyMobileContentMutation(added.state, addInput(two.playlistId, two.playlistRevision, 'duplicate', next), { track: next }, { limits });
  const unchanged = mobileContentDomainSnapshot(duplicate.state, scope, limits).playlists[0]!.playlist;
  assert.equal(duplicate.changed, false); assert.equal(unchanged.trackCount, 2); assert.equal(unchanged.playlistRevision, two.playlistRevision);
});

test('内容状态：同曲名不同版本或来源保留独立项，第一曲封面不被替换', () => {
  const firstTrack = { ...track, artworkId: 'artwork.first' }, state = initial();
  let result = applyMobileContentMutation(state, createInput(mobileContentDomainSnapshot(state, scope, limits).collectionRevision, 'create', firstTrack), { track: firstTrack }, { limits, newPlaylistId: 'playlist.1' });
  for (const t of [{ ...track, versionId: 'version.2' }, { ...track, source: 'netease' as const, sourceItemId: 'provider.item', versionId: 'version.netease' }]) {
    const p = mobileContentDomainSnapshot(result.state, scope, limits).playlists[0]!.playlist;
    result = applyMobileContentMutation(result.state, addInput(p.playlistId, p.playlistRevision, 'add.' + t.versionId, t), { track: t }, { limits });
  }
  const view = mobileContentDomainSnapshot(result.state, scope, limits).playlists[0]!;
  assert.equal(view.playlist.trackCount, 3); assert.equal(view.playlist.coverArtworkId, 'artwork.first');
  assert.deepEqual(view.tracks.map(t => [t.source, t.versionId]), [['local', 'version.1'], ['local', 'version.2'], ['netease', 'version.netease']]);
});

test('内容状态：显式容量满时不淘汰回执，原回执仍可精确读取', () => {
  const tiny = { ...limits, receipts: 1 }, state = initial();
  const input = albumInput(mobileContentDomainSnapshot(state, scope, tiny).favoritesRevision, true, 'one');
  const first = applyMobileContentMutation(state, input, { album }, { limits: tiny });
  assert.deepEqual(applyMobileContentMutation(first.state, input, {}, { limits: tiny }).reply, first.reply);
  assert.throws(() => applyMobileContentMutation(first.state, albumInput(mobileContentDomainSnapshot(first.state, scope, tiny).favoritesRevision, false, 'two'), { album }, { limits: tiny }), errorCode('CONTENT_LIMIT_EXCEEDED'));
  assert.equal(first.state.receipts.length, 1);
});

test('内容状态：有限序列化拒非canonical重复键、未知字段、孤立代理和坏预算', () => {
  const state = initial(), bytes = encodeMobileContentState(state, limits), raw = Buffer.from(bytes).toString('utf8');
  assert.throws(() => decodeMobileContentState(Buffer.from(raw.replace('"schema":', '"unexpected":1,"schema":')), limits));
  assert.throws(() => decodeMobileContentState(Buffer.from(raw.replace('"revision":0', '"revision":0,"revision":0')), limits));
  assert.throws(() => encodeMobileContentState(state, { ...limits, stateBytes: 1 }));
  assert.throws(() => mobileContentDomainSnapshot(state, { ...scope, accountDomain: '\ud800' }, limits));
  assert.deepEqual(decodeMobileContentState(bytes, limits), state);
});
