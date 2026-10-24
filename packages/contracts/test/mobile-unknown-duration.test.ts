import assert from 'node:assert/strict';
import test from 'node:test';
import { mapLocalDetailToMobileTrack, mobileCatalogResponseSnapshot } from '../src/mobile-catalog.js';
import { mobileSchemaSnapshot } from '../src/mobile-common.js';
import { MOBILE_RESOURCE_SCHEMAS } from '../src/mobile-resource.js';
import { decodeMobileRequest, decodeMobileResponse, encodeMobileRequest, encodeMobileJsonReply, type MobileHeaderPairs } from '../src/mobile-wire.js';

const origin = 'https://127.0.0.1:34443', path = '/mobile/v1/tracks';
const feature = { catalogFeatures: 'unknown-duration-v1' as const };
const track = { id: 'local.track', title: '合成未知时长', artists: [], albumId: 'local.album', source: 'local' as const,
  sourceItemId: 'local.item', versionId: 'local.version', contentRevision: 'local.revision', editionLabel: '',
  durationMs: null, audio: { codec: 'flac', container: 'flac', sampleRateHz: 44100, channels: 2, bitsPerSample: 16 }, availability: 'unavailable' as const };
const rawRequest = (headers: MobileHeaderPairs = []) => ({ method: 'GET', path, headers, query: [], body: new Uint8Array() });
const context = { responseOrigin: origin, requestPath: path };
const decodedRequest = (headers: MobileHeaderPairs = []) => decodeMobileRequest('listTracks', rawRequest(headers), context);

test('M35合同：时长键仍必需，仅local且unavailable可明确为null', () => {
  const value = mobileCatalogResponseSnapshot('track', track); assert.ok(value.ok); assert.equal(value.value.durationMs, null);
  assert.ok(mobileCatalogResponseSnapshot('track', { ...track, durationMs: 0 }).ok);
  assert.ok(mobileCatalogResponseSnapshot('track', { ...track, durationMs: 12345, availability: 'available' }).ok);
  const { durationMs: _unused, ...missing } = track;
  for (const bad of [missing, { ...track, durationMs: -1 }, { ...track, durationMs: 1.5 }, { ...track, durationMs: 'unknown' },
    { ...track, source: 'netease' }, { ...track, availability: 'available' }, { ...track, availability: 'missing' }]) {
    assert.equal(mobileCatalogResponseSnapshot('track', bad).ok, false);
  }
});

test('M35本地mapper：未知时长保留原发行绑定，仅不可播放投影合法', () => {
  const detail = { track: { id: 'track.synthetic', assetId: 'asset.synthetic', selectionRevision: '1', segment: null },
    asset: { id: 'asset.synthetic', libraryRootId: 'root.synthetic', sourceRootId: 'source.synthetic', rootRevision: '1', fileRevision: '1', locationRevision: '1', sampleFrames: null, timebaseHz: null },
    metadata: { raw: {}, override: null, effective: {} }, versionTokens: [],
    editions: [{ id: 'edition.synthetic', revision: '1', title: '合成发行', edition: '合成版本' }],
    fileParameters: { container: 'FLAC' as const, codec: 'flac', lossless: true, sampleRateHz: 44100, channels: 2, bitsPerSample: 16, durationMs: null, evidence: 'bounded-parser-reported' as const } };
  const binding = { localTrackId: detail.track.id, assetId: detail.asset.id, fileRevision: '1', selectionRevision: '1', segmentId: null,
    editionId: 'edition.synthetic', editionRevision: '1', trackId: track.id, sourceItemId: track.sourceItemId, albumId: track.albumId,
    versionId: track.versionId, contentRevision: track.contentRevision };
  const projection = { title: track.title, artists: [], editionLabel: '', availability: 'unavailable' as const };
  const result = mapLocalDetailToMobileTrack(detail, binding, projection); assert.ok(result.ok); assert.equal(result.value.durationMs, null);
  assert.equal(mapLocalDetailToMobileTrack(detail, binding, { ...projection, availability: 'available' }).ok, false);
  assert.equal(mapLocalDetailToMobileTrack(detail, { ...binding, editionRevision: '2' }, projection).ok, false);
  assert.equal(mapLocalDetailToMobileTrack(detail, { ...binding, assetId: 'different.asset' }, projection).ok, false);
});

test('M35协商：仅精确Features头被保留，缺省仍为旧请求，往返不丢协商', () => {
  const normal = decodedRequest(); assert.ok(normal.ok); assert.equal(Object.hasOwn(normal.value, 'catalogFeatures'), false);
  const requested = decodedRequest([['X-MusicBridge-Catalog-Features', 'unknown-duration-v1']]); assert.ok(requested.ok);
  assert.equal(Reflect.get(requested.value, 'catalogFeatures'), 'unknown-duration-v1');
  const encoded = encodeMobileRequest('listTracks', { ...normal.value, ...feature }, context); assert.ok(encoded.ok);
  assert.deepEqual(encoded.value.headers, [['X-MusicBridge-Catalog-Features', 'unknown-duration-v1']]);
  const again = decodeMobileRequest('listTracks', encoded.value, context); assert.ok(again.ok);
  assert.deepEqual(again.value, requested.value);
  const caseInsensitive = decodedRequest([['x-musicbridge-catalog-features', 'unknown-duration-v1']]); assert.ok(caseInsensitive.ok);
  assert.equal(Reflect.get(caseInsensitive.value, 'catalogFeatures'), 'unknown-duration-v1');
});

test('M35协商：未知值、列表、重复头或写操作头不能取得nullable出站资格', () => {
  for (const value of ['', 'unknown-duration-v2', 'UNKNOWN-DURATION-V1', 'unknown-duration-v1,other', ' unknown-duration-v1']) {
    const result = decodedRequest([['X-MusicBridge-Catalog-Features', value]]);
    assert.equal(result.ok, false);
  }
  assert.equal(decodedRequest([['X-MusicBridge-Catalog-Features', 'unknown-duration-v1'], ['x-musicbridge-catalog-features', 'unknown-duration-v1']]).ok, false);
  assert.equal(decodeMobileRequest('logout', { method: 'POST', path: '/mobile/v1/auth/logout', query: [],
    headers: [['Content-Type', 'application/json'], ['X-MusicBridge-Catalog-Features', 'unknown-duration-v1']], body: new TextEncoder().encode('{}') },
  { responseOrigin: origin, requestPath: '/mobile/v1/auth/logout' }).ok, false);
});

test('M35wire：整页与单条仅协商后允许null，旧客户端和错误资格不能吃到新正文', () => {
  const body = { items: [track], nextCursor: null, libraryRevision: 'revision.synthetic' };
  const reply = { status: 200, category: 'success' as const, body };
  assert.equal(encodeMobileJsonReply('listTracks', reply, context).ok, false);
  const negotiated = encodeMobileJsonReply('listTracks', reply, { ...context, ...feature }); assert.ok(negotiated.ok);
  const wire = { ...negotiated.value, finalUrl: `${origin}${path}` };
  assert.equal(decodeMobileResponse('listTracks', wire, context).ok, false);
  assert.ok(decodeMobileResponse('listTracks', wire, { ...context, ...feature }).ok);
  const detailContext = { ...context, requestPath: '/mobile/v1/tracks/local.track' };
  assert.equal(encodeMobileJsonReply('getTrack', { status: 200, category: 'success', body: track }, detailContext).ok, false);
  assert.ok(encodeMobileJsonReply('getTrack', { status: 200, category: 'success', body: track }, { ...detailContext, ...feature }).ok);
});

test('M35wire：收藏和个人歌单的嵌套local Track也服从真实协商，netease永不接受null', () => {
  const playlist = { playlistId: 'playlist.synthetic', title: '合成列表', icon: 'music.note' as const, description: '', trackCount: 1, playlistRevision: 'revision.synthetic' };
  const reply = { status: 200, category: 'success' as const, body: { accountDomain: 'account.synthetic', playlist, items: [track], nextCursor: null } };
  const c = { ...context, requestPath: '/mobile/v1/ui/playlists/playlist.synthetic/tracks' };
  assert.equal(encodeMobileJsonReply('listPersonalPlaylistTracks', reply, c).ok, false);
  assert.ok(encodeMobileJsonReply('listPersonalPlaylistTracks', reply, { ...c, ...feature }).ok);
  const favorites = { status: 200, category: 'success' as const, body: { accountDomain: 'account.synthetic', favoritesRevision: 'revision.synthetic',
    favorite: null, items: [track], nextCursor: null, identity: { albumId: 'local.album', source: 'local' as const } } };
  const fc = { ...context, requestPath: '/mobile/v1/ui/favorites/albums/local.album/tracks' };
  assert.equal(encodeMobileJsonReply('listFavoriteAlbumTracks', favorites, fc).ok, false);
  assert.ok(encodeMobileJsonReply('listFavoriteAlbumTracks', favorites, { ...fc, ...feature }).ok);
  assert.equal(encodeMobileJsonReply('listTracks', { status: 200, category: 'success', body: { items: [{ ...track, source: 'netease' }], nextCursor: null, libraryRevision: 'revision.synthetic' } }, { ...context, ...feature }).ok, false);
});

test('M35媒体：catalog协商不改变媒体时长严格整数合同', () => {
  const media = { url: `${origin}/mobile/v1/media/resource.synthetic/file`, transport: 'file', expiresAt: '2026-10-21T23:00:00Z',
    durationMs: null, seekable: true, actualAudio: track.audio };
  assert.equal(mobileSchemaSnapshot(MOBILE_RESOURCE_SCHEMAS.Media!, media, MOBILE_RESOURCE_SCHEMAS).ok, false);
  assert.ok(mobileSchemaSnapshot(MOBILE_RESOURCE_SCHEMAS.Media!, { ...media, durationMs: 1000 }, MOBILE_RESOURCE_SCHEMAS).ok);
});
