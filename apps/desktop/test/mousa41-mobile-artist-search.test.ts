import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { ArtistCatalogArtist, ArtistQuery, ArtistSearchCatalogPublicApi, LocalAlbumSummary, LocalArtistTrackItem,
  MobileAlbum, MobileArtist, MobileArtistPage, MobileTrack, MobileTrackPage } from '@music-bridge/contracts';
import { createMobileArtistSearchBackend, isMobileArtistSearchRequestTarget } from '../src/main/mobile-artist-search-backend.js';
import type { MobileArtistSearchBackendInput } from '../src/main/mobile-artist-search-backend.js';
import { mobileAlbumId, mobileArtworkId, mobileGroupHash, mobileTrackId } from '../../../packages/bridge-core/src/mobile/local-album-identity.js';
import { MobileServiceError, type MobilePrincipal } from '../../../packages/bridge-core/src/mobile/types.js';
import type { MobileDirectoryPage, MobileDirectoryQuery } from '../../../packages/bridge-core/src/mobile/directory-rpc.js';

const DATASET = '11111111-1111-1111-1111-111111111111', ROOT = '22222222-2222-2222-2222-222222222222';
const ARTIST = `local-artist:${'a'.repeat(64)}`, ALBUM = `directory-${'b'.repeat(64)}`;
const IDS = ['33333333-3333-3333-3333-333333333331', '33333333-3333-3333-3333-333333333332', '33333333-3333-3333-3333-333333333333'];
const ALBUM_ID = mobileAlbumId(DATASET, ROOT, ALBUM);
const ARTWORK = mobileArtworkId(DATASET, ALBUM, 'artwork:1');
function deferred() {
  let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve };
}
function refusal(promise: Promise<unknown>, status: number, code: string) {
  return assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof MobileServiceError); assert.equal(error.status, status); assert.equal(error.code, code);
    assert.equal(error.message, '移动服务当前无法完成请求。'); assert.equal(Object.hasOwn(error, 'cause'), false); return true;
  });
}
function page<T>(items: readonly T[], offset: number, limit: number, revision: string) {
  const selected = items.slice(offset, offset + limit);
  return { items: selected, offset, limit, total: items.length, revision, hasMore: offset + selected.length < items.length };
}
function principal(deviceId: string): MobilePrincipal {
  return { serverId: 'server.synthetic', datasetId: DATASET, accountDomain: 'account.synthetic', deviceId,
    deviceEpoch: 1, generation: 1, accessTokenHash: 'c'.repeat(64), accessExpiresAt: '2099-01-01T00:00:00Z' };
}

/** 原身份算法与真实HTTP门面，依赖为受控合成目录；不读取资料、凭据或Provider。 */
function fixture(t: TestContext, settings: { maxInflight?: number; requestMs?: number } = {}) {
  const state = { revision: 'r1', current: true, revoked: false, linked: null as string | null,
    providerFails: false, providerChanged: false, localPreparing: false, localHold: null as ReturnType<typeof deferred> | null,
    localEntered: deferred(), onTrack: null as (() => void) | null, additionalArtists: [] as ArtistCatalogArtist[],
    trackHold: null as ReturnType<typeof deferred> | null, trackEntered: deferred() };
  const actors = new Map([['synthetic-A', principal('device.A')], ['synthetic-B', principal('device.B')]]);
  const calls = { tracks: [] as string[], albums: [] as string[], directory: [] as MobileDirectoryQuery[], mutations: [] as (string | null)[],
    artistQueries: [] as ArtistQuery[], details: [] as string[] };
  const summary: LocalAlbumSummary = { id: ALBUM, kind: 'source-directory', rootId: ROOT, editionId: null,
    title: 'Music Album', artists: ['合成人物'], year: null, versionLabel: null, trackCount: IDS.length,
    representativeTrackId: IDS[0]!, revision: '1', artworkAvailable: true, statuses: [] };
  const localItems: LocalArtistTrackItem[] = IDS.map((id, index) => ({
    track: { id, assetId: id, selectionRevision: '1', segment: null },
    asset: { id, libraryRootId: ROOT, sourceRootId: ROOT, rootRevision: '1', fileRevision: '1', locationRevision: '1', sampleFrames: null, timebaseHz: null },
    metadata: { title: `Music ${index}`, artist: '合成人物', album: 'Music Album' }, versionTokens: [], rootId: ROOT, albumKey: ALBUM,
  }));
  const localArtist = (): ArtistCatalogArtist => ({ id: ARTIST, name: '合成人物', source: 'local', albumCount: 1, trackCount: IDS.length,
    artworkUrl: 'https://provider.invalid/private-url-must-not-leak',
    linkState: state.linked === null ? 'unlinked' : 'manual', ...(state.linked === null ? {} : { linkedNeteaseId: state.linked }) });
  const allArtists = () => [localArtist(), ...state.additionalArtists];
  const album: MobileAlbum = { id: ALBUM_ID, title: 'Music Album', artists: ['合成人物'], source: 'local', editionLabel: '',
    trackCount: IDS.length, artworkId: ARTWORK };
  const localTrack = (id: string): MobileTrack => ({ id, title: 'Music', artists: ['合成人物'], albumId: ALBUM_ID,
    source: 'local', sourceItemId: 'local-source', versionId: 'version:1', contentRevision: 'content:1', editionLabel: '',
    durationMs: 120000, availability: 'available', artworkId: ARTWORK,
    audio: { codec: 'flac', container: 'flac', sampleRateHz: 44100, bitsPerSample: 16, channels: 2 } });
  const artists: ArtistSearchCatalogPublicApi = {
    async listArtists(query) { calls.artistQueries.push({ ...query }); return { ...query, ...page(allArtists(), query.offset, query.limit, state.revision) }; },
    async getArtist(query) { calls.details.push(query.artistId); assert.equal(query.artistId, ARTIST); return localArtist(); },
    async listArtistAlbums(query) { return { ...query, ...page([summary], query.offset, query.limit, state.revision) }; },
    async listArtistTracks(query) { return { ...query, ...page(localItems, query.offset, query.limit, state.revision) }; },
    async search(query) {
      if (state.localPreparing) throw Object.assign(new Error('合成本地索引正在准备'), { code: 'ARTIST_INDEX_PREPARING' });
      if (state.localHold) { state.localEntered.resolve(); await state.localHold.promise; }
      return { query: query.query, revision: state.revision,
        artists: { ...query, ...page(allArtists(), query.offset, query.limit, state.revision) },
        albums: { ...query, ...page([summary], query.offset, query.limit, state.revision) },
        tracks: { ...query, ...page(localItems, query.offset, query.limit, state.revision) } };
    },
    async suggest() { return { keywords: [] }; }, async artistMatches() { return []; },
    async bindArtist(query) { calls.mutations.push(query.neteaseArtistId); state.linked = query.neteaseArtistId; return localArtist(); },
    async playLocalSelection() { throw new Error('本门面测试不触发播放。'); },
  };
  const backend = createMobileArtistSearchBackend({
    auth: {
      async authenticate(token) { const value = actors.get(token); if (!value || state.revoked) throw new MobileServiceError(401, 'UNAUTHORIZED'); return value; },
      async assertCurrent(value) { if (state.revoked || ![...actors.values()].includes(value)) throw new MobileServiceError(401, 'UNAUTHORIZED'); },
    },
    catalog: {
      async getAlbum(id) { calls.albums.push(id); assert.equal(id, ALBUM_ID); return album; },
      async getTrack(id) {
        calls.tracks.push(id); state.onTrack?.();
        if (state.trackHold) { state.trackEntered.resolve(); await state.trackHold.promise; }
        return localTrack(id);
      },
    }, artists,
    async assertCatalogCurrent(value) { if (!state.current || value.datasetId !== DATASET) throw new MobileServiceError(409, 'SOURCE_CHANGED'); },
    async providerDirectory(_actor, query) {
      calls.directory.push(structuredClone(query));
      if (state.providerFails) throw new MobileServiceError(503, 'BUSY');
      const rows: MobileDirectoryPage['items'] = query.kind === 'artists'
        ? [{ id: query.artistId ?? '123', name: '合成人物', source: 'netease' as const, albumCount: 2, trackCount: 3,
          artworkId: 'naw:r:synthetic', biography: '合成人物简介', credit: '人物资料来自网易云' }]
        : query.kind === 'albums' ? [{ ...album, id: 'na:123', source: 'netease' as const, artworkId: 'naw:r:synthetic' }]
        : IDS.map((_id, index) => ({ ...localTrack(`nt:${index + 1}`), source: 'netease' as const,
          sourceItemId: String(index + 1), albumId: 'na:123', artworkId: 'naw:r:synthetic' }));
      const selected = page(rows, query.offset, query.limit, 'directory:1');
      const result: MobileDirectoryPage = { kind: query.kind, items: [...selected.items], offset: query.offset, limit: query.limit,
        total: selected.total, revision: selected.revision, nextOffset: selected.hasMore ? query.offset + selected.items.length : null };
      return { page: result, async beforeSend() { if (state.providerChanged) throw new MobileServiceError(409, 'SOURCE_CHANGED'); } };
    }, cursorKey: new Uint8Array(32).fill(7), ...settings,
  });
  t.after(() => backend.close());
  function input(requestTarget: string, overrides: Partial<MobileArtistSearchBackendInput> = {}): MobileArtistSearchBackendInput {
    return { method: 'GET', requestTarget, headerPairs: [['Authorization', 'Bearer synthetic-A']], body: new Uint8Array(),
      signal: new AbortController().signal, ...overrides };
  }
  async function read<T>(path: string, overrides: Partial<MobileArtistSearchBackendInput> = {}) {
    const reply = await backend.dispatch(input(path, overrides));
    assert.equal(reply.status, 200); assert.equal(reply.headers.some(([name, value]) => name === 'Cache-Control' && value === 'private, no-store'), true);
    return { reply, value: JSON.parse(new TextDecoder().decode(reply.body)) as T };
  }
  return { backend, state, calls, actors, input, read };
}

test('4.1 本地搜索使用原ma/mt身份，完整分页保留原选择与顺序', async t => {
  const f = fixture(t);
  const first = await f.read<MobileTrackPage>('/mobile/v1/search/tracks?q=music&source=local&limit=2');
  assert.equal(first.value.items.length, 2); assert.ok(first.value.nextCursor);
  assert.deepEqual(first.value.items.map(row => row.id), IDS.slice(0, 2).map(id => mobileTrackId(DATASET, id, mobileGroupHash(ROOT, ALBUM))));
  assert.equal(first.value.items[0]?.albumId, ALBUM_ID); await first.reply.beforeSend?.();
  const second = await f.read<MobileTrackPage>(`/mobile/v1/search/tracks?q=music&source=local&limit=2&cursor=${encodeURIComponent(first.value.nextCursor)}`);
  assert.equal(second.value.items.length, 1); assert.equal(second.value.nextCursor, null);
  assert.equal(second.value.libraryRevision, first.value.libraryRevision); assert.equal(f.calls.directory.length, 0);
});

test('4.1 两设备在本地索引准备时收到明确503，在线来源可读，准备后恢复原查询', async t => {
  const f = fixture(t); f.state.localPreparing = true;
  await Promise.all(['synthetic-A', 'synthetic-B'].map(token => refusal(f.backend.dispatch(f.input(
    '/mobile/v1/search/tracks?q=music&source=local', { headerPairs: [['Authorization', `Bearer ${token}`]] },
  )), 503, 'ARTIST_INDEX_PREPARING')));
  const online = await f.read<MobileTrackPage>('/mobile/v1/search/tracks?q=music&source=netease');
  assert.ok(online.value.items.every(item => item.source === 'netease'));
  f.state.localPreparing = false;
  const local = await f.read<MobileTrackPage>('/mobile/v1/search/tracks?q=music&source=local');
  assert.equal(local.value.items.length, IDS.length);
  assert.ok(local.value.items.every(item => item.source === 'local'));
});

test('4.1 cursor不能跨来源、查询、类型、设备或limit重放', async t => {
  const f = fixture(t);
  const { value } = await f.read<MobileTrackPage>('/mobile/v1/search/tracks?q=music&source=local&limit=2');
  assert.ok(value.nextCursor); const token = encodeURIComponent(value.nextCursor);
  for (const path of [
    `/mobile/v1/search/tracks?q=other&source=local&limit=2&cursor=${token}`,
    `/mobile/v1/search/tracks?q=music&source=netease&limit=2&cursor=${token}`,
    `/mobile/v1/search/albums?q=music&source=local&limit=2&cursor=${token}`,
    `/mobile/v1/search/tracks?q=music&source=local&limit=1&cursor=${token}`,
  ]) await refusal(f.backend.dispatch(f.input(path)), 409, 'CURSOR_INVALID');
  await refusal(f.backend.dispatch(f.input(`/mobile/v1/search/tracks?q=music&source=local&limit=2&cursor=${token}`,
    { headerPairs: [['authorization', 'Bearer synthetic-B']] })), 409, 'CURSOR_INVALID');
});

test('4.1 修订变化拒绝旧cursor，读后切库与发送前撤销也拒绝', async t => {
  const f = fixture(t);
  const { value } = await f.read<MobileTrackPage>('/mobile/v1/search/tracks?q=music&source=local&limit=2');
  assert.ok(value.nextCursor); f.state.revision = 'r2';
  await refusal(f.backend.dispatch(f.input(`/mobile/v1/search/tracks?q=music&source=local&limit=2&cursor=${encodeURIComponent(value.nextCursor)}`)), 409, 'SOURCE_CHANGED');
  f.state.onTrack = () => { f.state.current = false; };
  await refusal(f.backend.dispatch(f.input('/mobile/v1/search/tracks?q=music&source=local&limit=2')), 409, 'SOURCE_CHANGED');
  f.state.current = true; f.state.onTrack = null;
  const staged = await f.read<MobileTrackPage>('/mobile/v1/search/tracks?q=music&source=local&limit=2');
  f.state.revoked = true; await refusal(staged.reply.beforeSend!(), 401, 'UNAUTHORIZED');
});

test('4.1 本地Artist封面来自代表专辑，内部URL不进入回执', async t => {
  const f = fixture(t);
  const { value, reply } = await f.read<MobileArtist>(`/mobile/v1/library/artists/${ARTIST}?source=local`);
  assert.equal(value.source, 'local'); assert.equal(value.artworkId, ARTWORK); assert.equal(value.id, ARTIST);
  assert.equal(new TextDecoder().decode(reply.body).includes('provider.invalid'), false);
  assert.equal(Object.hasOwn(value, 'artworkUrl'), false); assert.equal(f.calls.directory.length, 0);
});

test('4.1 列表与搜索的发送前只重读一次缓存页，不触发人物详情或联网匹配', async t => {
  const f = fixture(t);
  f.state.additionalArtists.push(...['b', 'c'].map(letter => ({ id: `local-artist:${letter.repeat(64)}`,
    name: `合成人物${letter}`, source: 'local' as const, albumCount: 1, trackCount: 3, linkState: 'unlinked' as const })));
  const list = await f.read<MobileArtistPage>('/mobile/v1/library/artists?limit=3');
  assert.equal(list.value.items.length, 3); await list.reply.beforeSend?.();
  assert.equal(f.calls.artistQueries.filter(query => query.query === '' && query.limit === 3).length, 2);
  const search = await f.read<MobileArtistPage>('/mobile/v1/search/artists?q=music&source=local&limit=3');
  await search.reply.beforeSend?.();
  assert.equal(f.calls.artistQueries.filter(query => query.query === 'music' && query.limit === 3).length, 1);
  assert.deepEqual(f.calls.details, []); assert.deepEqual(f.calls.directory, []);
  const staged = await f.read<MobileArtistPage>('/mobile/v1/library/artists?limit=3');
  f.state.linked = '123'; await refusal(staged.reply.beforeSend!(), 409, 'SOURCE_CHANGED');
  assert.deepEqual(f.calls.details, []);
});

test('4.1 人物详情只在初次读取匹配，发送前用缓存绑定发现并发更正', async t => {
  const f = fixture(t);
  const staged = await f.read<MobileArtist>(`/mobile/v1/library/artists/${ARTIST}?source=local`);
  assert.deepEqual(f.calls.details, [ARTIST]);
  f.state.linked = '123'; await refusal(staged.reply.beforeSend!(), 409, 'SOURCE_CHANGED');
  assert.deepEqual(f.calls.details, [ARTIST]);
  assert.equal(f.calls.artistQueries.some(query => query.query === '合成人物' && query.limit === 200), true);
});

test('4.1 绑定人物只补资料，作品仍是local；显式null解绑只写一次', async t => {
  const f = fixture(t); f.state.linked = '123';
  const profile = await f.read<MobileArtist>(`/mobile/v1/library/artists/${ARTIST}?source=local`);
  assert.equal(profile.value.source, 'local'); assert.equal(profile.value.linkedNeteaseId, '123');
  assert.equal(profile.value.artworkId, 'naw:r:synthetic'); assert.equal(profile.value.credit, '人物资料来自网易云');
  const works = await f.read<MobileTrackPage>(`/mobile/v1/library/artists/${ARTIST}/tracks?source=local&limit=2`);
  assert.ok(works.value.items.every(row => row.source === 'local' && row.id.startsWith('mt:')));
  const unlinked = await f.read<MobileArtist>(`/mobile/v1/library/artists/${ARTIST}/link`, {
    method: 'PUT', headerPairs: [['authorization', 'Bearer synthetic-A'], ['content-type', 'application/json']],
    body: new TextEncoder().encode('{"neteaseArtistId":null}'),
  });
  assert.equal(unlinked.value.linkedNeteaseId, undefined); assert.equal(unlinked.value.linkState, 'unlinked');
  await unlinked.reply.beforeSend?.(); assert.deepEqual(f.calls.mutations, [null]);
});

test('4.1 Provider失败不影响本地查询，已绑定本地资料也安全回退', async t => {
  const f = fixture(t); f.state.providerFails = true;
  await refusal(f.backend.dispatch(f.input('/mobile/v1/search/tracks?q=music&source=netease')), 503, 'BUSY');
  const local = await f.read<MobileTrackPage>('/mobile/v1/search/tracks?q=music&source=local');
  assert.ok(local.value.items.length > 0);
  f.state.linked = '123';
  const profile = await f.read<MobileArtist>(`/mobile/v1/library/artists/${ARTIST}?source=local`);
  assert.equal(profile.value.artworkId, ARTWORK); assert.equal(profile.value.biography, undefined);
  await profile.reply.beforeSend?.();
});

test('4.1 远端发送前Scope变化拒绝，不能把全部专辑伪称参与作品', async t => {
  const f = fixture(t);
  const remote = await f.read<MobileTrackPage>('/mobile/v1/search/tracks?q=music&source=netease&limit=2');
  assert.ok(remote.value.items.every(row => row.source === 'netease' && row.id.startsWith('nt:')));
  f.state.providerChanged = true; await refusal(remote.reply.beforeSend!(), 409, 'SOURCE_CHANGED');
  await refusal(f.backend.dispatch(f.input('/mobile/v1/library/artists/123/albums?source=netease&relation=appearsOn')), 400, 'INVALID_REQUEST');
});

test('4.1 matches只请求带本地姓名的目录查询，并返回不含上游URL的候选', async t => {
  const f = fixture(t);
  const { value } = await f.read<MobileArtistPage>(`/mobile/v1/library/artists/${ARTIST}/matches?limit=20`);
  assert.equal(f.calls.directory[0]?.query, '合成人物'); assert.equal(f.calls.directory[0]?.artistId, null);
  assert.equal(value.items[0]?.source, 'netease'); assert.equal(value.items[0]?.id, '123');
  assert.equal(Object.hasOwn(value.items[0]!, 'artworkUrl'), false);
});

test('4.1 重复query/header、裸offset、GET正文及非规范target拒绝', async t => {
  const f = fixture(t);
  for (const path of ['/mobile/v1/search/tracks?q=music&source=local&source=netease',
    '/mobile/v1/search/tracks?q=music&source=local&offset=2',
    '/mobile/v1/search/../search/tracks?q=music&source=local']) {
    await refusal(f.backend.dispatch(f.input(path)), 400, 'INVALID_REQUEST');
  }
  await refusal(f.backend.dispatch(f.input('/mobile/v1/search/tracks?q=music&source=local', {
    headerPairs: [['Authorization', 'Bearer synthetic-A'], ['authorization', 'Bearer synthetic-B']],
  })), 400, 'INVALID_REQUEST');
  await refusal(f.backend.dispatch(f.input('/mobile/v1/search/tracks?q=music&source=local', { body: new TextEncoder().encode('{}') })), 400, 'INVALID_REQUEST');
  assert.equal(isMobileArtistSearchRequestTarget('/mobile/v1/search/tracks?q=music&source=local'), true);
  assert.equal(isMobileArtistSearchRequestTarget('/mobile/v1/tracks?source=local'), false);
});

test('4.1 取消不释放未静止工作容量，close等待原工作真正返回', async t => {
  const f = fixture(t, { maxInflight: 1 });
  const gate = deferred(); f.state.localHold = gate;
  const controller = new AbortController();
  const operation = f.backend.dispatch(f.input('/mobile/v1/search/tracks?q=music&source=local', { signal: controller.signal }));
  await f.state.localEntered.promise; controller.abort();
  await refusal(operation, 503, 'BUSY');
  await refusal(f.backend.dispatch(f.input('/mobile/v1/search/tracks?q=next&source=local')), 503, 'BUSY');
  const close = f.backend.close(); let quiet = false; void close.then(() => { quiet = true; });
  await Promise.resolve(); assert.equal(quiet, false);
  gate.resolve(); await close; assert.equal(quiet, true);
  await refusal(f.backend.dispatch(f.input('/mobile/v1/search/tracks?q=music&source=local')), 503, 'BUSY');
});

test('4.1 本地逐项映射超时不会返回残缺成功，也不释放仍在工作中的容量', async t => {
  const f = fixture(t, { maxInflight: 1, requestMs: 20 });
  const gate = deferred(); f.state.trackHold = gate;
  const operation = f.backend.dispatch(f.input('/mobile/v1/search/tracks?q=music&source=local&limit=2'));
  try {
    await f.state.trackEntered.promise;
    await refusal(operation, 503, 'BUSY');
    assert.equal(f.calls.tracks.length, 2);
    await refusal(f.backend.dispatch(f.input('/mobile/v1/search/tracks?q=next&source=local')), 503, 'BUSY');
  } finally { gate.resolve(); await f.backend.close(); }
});

test('4.1 响应缓冲被改写时beforeSend拒绝，且不关闭共享auth或Artist服务', async t => {
  const f = fixture(t);
  const { reply } = await f.read<MobileTrackPage>('/mobile/v1/search/tracks?q=music&source=local');
  reply.body[0] = reply.body[0]! ^ 1;
  await refusal(reply.beforeSend!(), 503, 'BUSY');
  await f.backend.close();
  assert.equal(f.state.revoked, false); assert.equal(f.state.current, true);
});
