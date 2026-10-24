import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { ArtistQuery, ArtistSearchCatalogPublicApi, LocalAlbumSummary, LocalArtistTrackItem,
  MobileAlbum, MobileAlbumPage, MobileTrack, MobileTrackPage } from '@music-bridge/contracts';
import { createMobileArtistSearchBackend } from '../src/main/mobile-artist-search-backend.js';
import { mobileAlbumId, mobileGroupHash, mobileTrackId } from '../../../packages/bridge-core/src/mobile/local-album-identity.js';
import { MobileServiceError, type MobilePrincipal } from '../../../packages/bridge-core/src/mobile/types.js';

const DATASET = '11111111-1111-1111-1111-111111111111', ROOT = '22222222-2222-2222-2222-222222222222';
const uuid = (index: number) => `33333333-3333-3333-3333-${String(index).padStart(12, '0')}`;
const key = (index: number) => `directory-${index.toString(16).padStart(64, '0')}`;
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
function page<T>(items: readonly T[], request: ArtistQuery, revision: string) {
  const selected = items.slice(request.offset, request.offset + request.limit);
  return { ...request, items: selected, total: items.length, revision, hasMore: request.offset + selected.length < items.length };
}
interface Selection { kind: 'albums' | 'tracks'; ids: readonly string[]; sourceRevision: string }
function failure(promise: Promise<unknown>, status: number, code: string) {
  return assert.rejects(promise, error => error instanceof MobileServiceError && error.status === status && error.code === code);
}

/** 只测真实HTTP门面的页级接线；合成DTO不能替代Owner事实/文件围栏验证。 */
function fixture(t: TestContext, count = 125, blockLegacy = false) {
  const legacyGate = deferred(), selectedGate = deferred(), selectedEntered = deferred();
  const state = { revision: 'source:one', current: true, revoked: new Set<string>(), holdDevice: '', version: '1', reverse: false };
  const principals = new Map(['A', 'B'].map(deviceId => [deviceId, { serverId: 'server.synthetic', datasetId: DATASET,
    accountDomain: `local:${DATASET}`, deviceId, deviceEpoch: 1, generation: 1, accessTokenHash: 'a'.repeat(64),
    accessExpiresAt: '2099-01-01T00:00:00Z' } satisfies MobilePrincipal]));
  // 特意与字符串排序不同，批量投影必须保留原索引页次序。
  const ordinals = Array.from({ length: count }, (_, index) => count - index);
  const albums: LocalAlbumSummary[] = ordinals.map(index => ({ id: key(index), kind: 'source-directory', rootId: ROOT, editionId: null,
    title: `合成专辑${index}`, artists: ['合成艺人'], year: null, versionLabel: null, trackCount: 1,
    representativeTrackId: uuid(index), revision: '1', artworkAvailable: false, statuses: [] }));
  const tracks: LocalArtistTrackItem[] = ordinals.map(index => ({ track: { id: uuid(index), assetId: uuid(index), selectionRevision: '1', segment: null },
    asset: { id: uuid(index), libraryRootId: ROOT, sourceRootId: ROOT, rootRevision: '1', fileRevision: '1', locationRevision: '1', sampleFrames: null, timebaseHz: null },
    metadata: { title: `合成曲目${index}`, artist: '合成艺人', album: `合成专辑${index}` }, versionTokens: [], rootId: ROOT, albumKey: key(index) }));
  const albumIds = albums.map(item => mobileAlbumId(DATASET, item.rootId, item.id));
  const trackIds = tracks.map(item => mobileTrackId(DATASET, item.track.id, mobileGroupHash(item.rootId, item.albumKey)));
  const albumDtos = new Map(albumIds.map((id, index) => [id, { id, title: albums[index]!.title, artists: ['合成艺人'], source: 'local',
    editionLabel: '', trackCount: 1 } satisfies MobileAlbum]));
  const trackDto = (id: string): MobileTrack => ({ id, title: '合成曲目', artists: ['合成艺人'], albumId: albumIds[trackIds.indexOf(id)]!, source: 'local',
    sourceItemId: 'ls:synthetic', versionId: `lv:${state.version}`, contentRevision: `lc:${state.version}`, editionLabel: '', durationMs: 1000,
    availability: 'unavailable', audio: { codec: 'flac', container: 'flac', sampleRateHz: 48000, bitsPerSample: 24, channels: 2 } });
  const calls = { legacy: 0, selected: [] as Array<Selection & { deviceId: string }>, auth: 0 };
  const artists: ArtistSearchCatalogPublicApi = {
    async listArtists(request) { return page([], request, state.revision); },
    async getArtist() { throw new Error('本场景不读取艺人资料。'); },
    async listArtistAlbums(request) { return { ...page(albums, { query: '', ...request }, state.revision), ...request }; },
    async listArtistTracks(request) { return { ...page(tracks, { query: '', ...request }, state.revision), ...request }; },
    async search(request) { return { query: request.query, revision: state.revision, artists: page([], request, state.revision),
      albums: page(albums, request, state.revision), tracks: page(tracks, request, state.revision) }; },
    async suggest() { return { keywords: [] }; }, async artistMatches() { return []; },
    async bindArtist() { throw new Error('本场景不写关联。'); }, async playLocalSelection() { throw new Error('本场景不播放。'); },
  };
  const catalog = {
    async getAlbum(id: string) { calls.legacy++; if (blockLegacy) await legacyGate.promise; return albumDtos.get(id)!; },
    async getTrack(id: string) { calls.legacy++; if (blockLegacy) await legacyGate.promise; return trackDto(id); },
    async selected(selection: Selection, principal: MobilePrincipal, signal?: AbortSignal) {
      calls.selected.push({ ...selection, ids: [...selection.ids], deviceId: principal.deviceId }); selectedEntered.resolve();
      if (state.holdDevice === principal.deviceId) await selectedGate.promise;
      signal?.throwIfAborted();
      const items = selection.ids.map(id => selection.kind === 'albums' ? albumDtos.get(id)! : trackDto(id));
      return state.reverse ? [...items].reverse() : items;
    },
  };
  const backend = createMobileArtistSearchBackend({ artists, catalog, requestMs: 500, closeMs: 500,
    cursorKey: new Uint8Array(32).fill(7), auth: {
      async authenticate(token) { const principal = principals.get(token); if (!principal) throw new MobileServiceError(401, 'UNAUTHORIZED'); return principal; },
      async assertCurrent(principal) { calls.auth++; if (state.revoked.has(principal.deviceId)) throw new MobileServiceError(401, 'UNAUTHORIZED'); },
    },
    async assertCatalogCurrent(principal) { if (!state.current || principal.datasetId !== DATASET) throw new MobileServiceError(409, 'SOURCE_CHANGED'); },
    async providerDirectory() { throw new Error('本地页不能调用Provider。'); },
  });
  t.after(async () => { legacyGate.resolve(); selectedGate.resolve(); await backend.close(); });
  const read = (kind: 'albums' | 'tracks', options: { cursor?: string; device?: string; signal?: AbortSignal } = {}) => backend.dispatch({
    method: 'GET', requestTarget: `/mobile/v1/search/${kind}?q=zjl&source=local&limit=100${options.cursor ? `&cursor=${encodeURIComponent(options.cursor)}` : ''}`,
    headerPairs: [['Authorization', `Bearer ${options.device ?? 'A'}`]], body: new Uint8Array(), signal: options.signal ?? new AbortController().signal,
  });
  return { backend, state, calls, read, albumIds, trackIds, selectedEntered, selectedGate };
}

test('4.1 selected-page：100命中不再等待逐条旧目录，原次序及下一页25项保持', { timeout: 5000 }, async t => {
  for (const kind of ['tracks', 'albums'] as const) {
    const f = fixture(t, 125, true), ids = kind === 'tracks' ? f.trackIds : f.albumIds;
    const first = await f.read(kind), page = JSON.parse(new TextDecoder().decode(first.body)) as MobileTrackPage | MobileAlbumPage;
    assert.deepEqual(page.items.map(item => item.id), ids.slice(0, 100)); assert.ok(page.nextCursor);
    assert.equal(f.calls.legacy, 0, '作品页不能再为每条命中回读旧detail'); assert.equal(f.calls.selected.length, 1);
    await first.beforeSend?.(); assert.equal(f.calls.selected.length, 2, '发送前仍重核同一页的真实投影');
    const second = await f.read(kind, { cursor: page.nextCursor! });
    const tail = JSON.parse(new TextDecoder().decode(second.body)) as MobileTrackPage | MobileAlbumPage;
    assert.deepEqual(tail.items.map(item => item.id), ids.slice(100)); assert.equal(tail.nextCursor, null); assert.equal(f.calls.legacy, 0);
    assert.equal(f.calls.selected[2]!.sourceRevision, page.libraryRevision);
  }
});

test('4.1 selected-page：发送前撤销、切库或版本变化均拒绝原整页', async t => {
  const revoked = fixture(t, 3), r = await revoked.read('tracks'); revoked.state.revoked.add('A');
  await failure(Promise.resolve().then(() => r.beforeSend?.()), 401, 'UNAUTHORIZED');
  const changed = fixture(t, 3), c = await changed.read('albums'); changed.state.current = false;
  await failure(Promise.resolve().then(() => c.beforeSend?.()), 409, 'SOURCE_CHANGED');
  const version = fixture(t, 3), v = await version.read('tracks'); version.state.version = '2';
  await failure(Promise.resolve().then(() => v.beforeSend?.()), 409, 'SOURCE_CHANGED');
});

test('4.1 selected-page：投影次序错配不能重排冒充原索引页', async t => {
  const f = fixture(t, 3); f.state.reverse = true;
  await failure(f.read('albums'), 409, 'SOURCE_CHANGED'); assert.equal(f.calls.legacy, 0);
});

test('4.1 selected-page：取消A后不继续物化、不外发迟到结果，B的原页和游标仍独立', { timeout: 5000 }, async t => {
  const f = fixture(t); f.state.holdDevice = 'A'; const cancelled = new AbortController();
  const a = f.read('tracks', { signal: cancelled.signal }); const rejected = failure(a, 503, 'BUSY');
  await f.selectedEntered.promise;
  const b = await f.read('tracks', { device: 'B' }), bp = JSON.parse(new TextDecoder().decode(b.body)) as MobileTrackPage;
  cancelled.abort(); await rejected; f.selectedGate.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
  await b.beforeSend?.();
  assert.deepEqual(bp.items.map(item => item.id), f.trackIds.slice(0, 100)); assert.equal(f.calls.legacy, 0);
  assert.equal(f.calls.selected.filter(call => call.deviceId === 'A').length, 1, '取消后不能继续发后续选中页或发送前请求');
  await failure(f.read('tracks', { cursor: bp.nextCursor!, device: 'A' }), 409, 'CURSOR_INVALID');
  assert.equal((await f.read('tracks', { cursor: bp.nextCursor!, device: 'B' })).status, 200);
});

test('4.1 selected-page：整页返回后父请求取消不再进入发送前投影', async t => {
  const f = fixture(t, 3), controller = new AbortController(); const result = await f.read('tracks', { signal: controller.signal });
  controller.abort(); await failure(Promise.resolve().then(() => result.beforeSend?.()), 503, 'BUSY');
  assert.equal(f.calls.selected.length, 1); assert.equal(f.calls.legacy, 0);
});
