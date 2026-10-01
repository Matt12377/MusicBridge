import assert from 'node:assert/strict'
import test from 'node:test'
import type { MusicBridgePublicApi } from '../src/preload/api.js'
import { useAggregatedSearch, type AggregatedSearchOptions } from '../src/renderer/src/composables/application/useAggregatedSearch.js'
import { useRoonCollection } from '../src/renderer/src/composables/useRoonCollection.js'
import { useNeteaseLibrary } from '../src/renderer/src/composables/application/useNeteaseLibrary.js'
import type { PageRequest, PlaylistDetail, RoonLibraryItem } from '@music-bridge/contracts'
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail }); return { promise, resolve, reject } }
const page = (id: string, offset = 0) => ({ items: [{ id, title: id, artists: ['合成艺人'], album: '合成专辑' }], offset, limit: 1, total: 2, hasMore: offset === 0 })
const empty = { items: [], offset: 0, limit: 8, total: 0, hasMore: false }
function searchHarness(api: Partial<MusicBridgePublicApi>, options: Partial<AggregatedSearchOptions> = {}) { return useAggregatedSearch({ api: api as MusicBridgePublicApi, getZoneId: () => 'zone-a', getScrollTop: () => 0, scrollTo: () => {}, classifyError: () => 'generic', onResetSearchOrigin: () => {}, onInvalidateRoonDetails: () => {}, ...options }) }

test('MBP005：网易云快分区不等待未返回艺人，Roon专辑不等待艺人', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const artists = deferred<typeof empty>(), roonArtists = deferred<typeof empty>()
  const search = searchHarness({ searchTracks: async () => page('fast-track'), searchArtists: () => artists.promise, searchAlbums: async () => empty,
    searchRoonLibrary: async (_query, _page, kind) => kind === 'artist' ? roonArtists.promise : { ...empty, items: [{ reference: 'fast-album', kind: 'album', title: '即时本地专辑' }] }, matchLibraryTrack: async () => ({ state: 'NOT_FOUND' }) as never })
  t.after(() => search.dispose())
  search.searchQuery.value = '相同查询'; search.scheduleSearch(); t.mock.timers.tick(250); await turn()
  assert.equal(search.searchPage.value.items[0]?.id, 'fast-track')
  assert.equal(search.roonSearchAlbums.value.items[0]?.reference, 'fast-album')
  assert.equal(search.searchArtistsState.value, 'loading'); assert.equal(search.searchAlbumsState.value, 'ready')
  artists.resolve(empty); roonArtists.resolve(empty); await turn()
})
test('MBP005：相同查询刷新先保留内容，不同查询输入立即清旧', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const search = searchHarness({ searchTracks: async () => page('same-track'), searchArtists: async () => empty, searchAlbums: async () => empty, searchRoonLibrary: async () => empty, matchLibraryTrack: async () => ({ state: 'NOT_FOUND' }) as never })
  t.after(() => search.dispose())
  search.searchQuery.value = '相同查询'; search.scheduleSearch(); t.mock.timers.tick(250); await turn()
  assert.equal(search.searchPage.value.items.length, 1)
  search.scheduleSearch(); assert.equal(search.searchPage.value.items[0]?.id, 'same-track')
  search.searchQuery.value = '另一查询'; search.scheduleSearch(); assert.equal(search.searchPage.value.items.length, 0)
})
test('MBP005：同一Roon页面刷新失败只报刷新错误，不隐藏旧内容', async () => {
  let failed = false
  const collection = useRoonCollection(async () => { if (failed) throw new Error('合成失败'); return { ...empty, items: [{ reference: 'same-album', kind: 'album' as const, title: '已加载专辑' }] } }, () => '刷新失败')
  await collection.load(); failed = true; await collection.retry()
  assert.equal(collection.page.value.items[0]?.reference, 'same-album'); assert.equal(collection.error.value, null)
  assert.equal((collection as typeof collection & { refreshError: { value: string | null } }).refreshError.value, '刷新失败'); collection.dispose()
})
test('MBP005：歌单续页换版本先重读首页，不混合旧尾页', async t => {
  const a = '00000000-0000-4000-8000-000000000001', b = '00000000-0000-4000-8000-000000000002'; const calls: number[] = []
  const library = useNeteaseLibrary({ api: {
    getAccountState: async () => ({ status: 'ready', profile: { displayName: '同名用户' } }), getLikedTracks: async () => empty, getUserPlaylists: async () => [], getDailyRecommendations: async () => ({ dayKey: '2026-10-01', tracks: [] }),
    getPlaylist: async (id: string, request: PageRequest): Promise<PlaylistDetail> => { calls.push(request.offset); return { id, name: id, trackCount: 2, snapshotVersion: calls.length === 1 ? a : b, tracks: page(calls.length === 1 ? 'old' : 'new', request.offset) } },
  } as unknown as MusicBridgePublicApi, getCoreRuntime: () => 'ready', getRemoteStatus: () => 'ready', getView: () => 'playlist-detail', onMatchTracks: () => {}, onPlaylistSwitch: () => {}, onPlaylistReady: () => {}, onResetPrivate: () => {}, onError: () => {}, accountMessage: () => '账户失败', dailyMessage: () => '推荐失败', libraryErrorKind: () => 'generic' })
  t.after(() => library.dispose()); library.applyAuthState({ status: 'authorized' }); await turn()
  await library.loadPlaylist('playlist-a', { offset: 0, limit: 1 }); await library.loadPlaylist('playlist-a', { offset: 1, limit: 1 })
  assert.deepEqual(calls, [0, 1, 0]); assert.deepEqual(library.selectedPlaylist.value?.tracks.items.map(track => track.id), ['new'])
})

import { cacheIdentity, createLibraryPageCache, mergeRefreshedRoonPage } from '../src/renderer/src/composables/libraryPageCache.js'
import { createPlaylistSnapshotLoader, PlaylistSnapshotChanged } from '../src/renderer/src/composables/playlistSnapshotPagination.js'
import { createSearchSnapshotLoader } from '../src/renderer/src/composables/search.js'

test('MBP005：纯值缓存隔离读写，命中不续TTL，过期与dispose清空', () => {
  let now = 0
  const cache = createLibraryPageCache({ now: () => now }), identity = cacheIdentity('账户代A', '歌单A', { ...empty, items: ['不能成为缓存身份'] } as typeof empty)
  assert.deepEqual(Object.keys(identity).sort(), ['dataset', 'limit', 'offset', 'scope'])
  const source = { tracks: [{ id: '原曲目' }] }; cache.put(identity, source); source.tracks[0]!.id = '写入后修改'
  const first = cache.peek<typeof source>(identity)!; assert.equal(first.value.tracks[0]!.id, '原曲目'); first.value.tracks[0]!.id = '读取后修改'
  now = 30_000; assert.equal(cache.peek<typeof source>(identity)!.stale, true); assert.equal(cache.peek<typeof source>(identity)!.value.tracks[0]!.id, '原曲目')
  now = 300_001; assert.equal(cache.peek(identity), undefined); assert.deepEqual(cache.stats(), { pages: 0, bytes: 0 })
  cache.put(identity, source); cache.dispose(); assert.equal(cache.put(identity, source), false); assert.equal(cache.peek(identity), undefined)
})
test('MBP005：默认总64页、单dataset8页与8MiB均为硬预算，超预算不截断原值', () => {
  const cache = createLibraryPageCache(), key = (dataset: string, offset: number) => cacheIdentity('scope', dataset, { offset, limit: 1 })
  for (let i = 0; i < 9; i++) cache.put(key('同数据集', i), { i })
  assert.equal(cache.stats().pages, 8); assert.equal(cache.peek(key('同数据集', 0)), undefined)
  for (let i = 0; i < 70; i++) cache.put(key(`不同数据集${i}`, 0), { i })
  assert.equal(cache.stats().pages, 64); assert.equal(cache.peek(key('不同数据集0', 0)), undefined)
  const large = { text: 'x'.repeat(8 * 1024 * 1024) }; assert.equal(cache.put(key('超预算', 0), large), false)
  assert.equal(large.text.length, 8 * 1024 * 1024); assert.ok(cache.stats().bytes <= 8 * 1024 * 1024)
  const tiny = createLibraryPageCache({ maxBytes: 30 }); tiny.put(key('a', 0), { text: 'a'.repeat(10) }); tiny.put(key('b', 0), { text: 'b'.repeat(10) }); assert.equal(tiny.stats().pages, 1)
})
test('MBP005：取消与scope变化后的Roon迟到页不发布、不暖缓存', async () => {
  const cache = createLibraryPageCache(), pending = deferred<ReturnType<typeof roonPage>>()
  let scope = 'scope-a', calls = 0
  const collection = useRoonCollection(() => { calls++; return pending.promise }, () => '错误', 1, { cache, getCacheScope: () => scope, getDataset: () => 'albums' })
  const load = collection.load(); collection.suspend(); scope = 'scope-b'; pending.resolve(roonPage('迟到')); await load
  assert.equal(collection.page.value.items.length, 0); assert.equal(collection.error.value, null); assert.equal(cache.stats().pages, 0); assert.equal(calls, 1); collection.dispose()
})
function roonPage(id: string, offset = 0, epoch = '00000000-0000-4000-8000-000000000001') { return { items: [{ reference: id, kind: 'album' as const, title: id }], offset, limit: 1, hasMore: offset === 0, nextOffset: offset + 1, sourceEpoch: epoch } }
test('MBP005：stale先显示旧页，后台失败不续TTL；fresh返回不IPC', async () => {
  let now = 0, calls = 0
  const cache = createLibraryPageCache({ now: () => now }), key = cacheIdentity('scope', 'albums', { offset: 0, limit: 1 })
  cache.put(key, roonPage('旧页')); const pending = deferred<ReturnType<typeof roonPage>>()
  const collection = useRoonCollection(() => { calls++; return pending.promise }, () => '刷新错误', 1, { cache, getCacheScope: () => 'scope', getDataset: () => 'albums' })
  await collection.load(); assert.equal(calls, 0)
  now = 30_000; const load = collection.load(); assert.equal(collection.page.value.items[0]?.reference, '旧页'); assert.equal(collection.initialLoading.value, true)
  pending.reject(new Error('合成刷新失败')); await load
  assert.equal(collection.refreshError.value, '刷新错误'); assert.equal(collection.error.value, null); assert.equal(collection.page.value.items[0]?.reference, '旧页')
  assert.equal(cache.peek<ReturnType<typeof roonPage>>(key)!.writtenAt, 0)
  now = 300_001; assert.equal(cache.peek(key), undefined); collection.dispose()
})
test('MBP005：真实Roon reload只第一次实际读，换epoch续页的rebase0普通读取', async () => {
  const calls: Array<{ offset: number; reload?: string }> = []
  let round = 0
  const collection = useRoonCollection(async (request, options) => {
    calls.push({ offset: request.offset, ...(options?.cacheMode ? { reload: options.cacheMode } : {}) }); round++
    return roonPage(round === 1 ? '旧首页' : '新页', request.offset, round === 1 ? '00000000-0000-4000-8000-000000000001' : '00000000-0000-4000-8000-000000000002')
  }, () => '失败', 1)
  await collection.load(); await collection.loadMore()
  assert.deepEqual(calls, [{ offset: 0 }, { offset: 1 }, { offset: 0 }]); assert.deepEqual(collection.page.value.items.map(item => item.reference), ['新页'])
  await collection.retry(); assert.deepEqual(calls[3], { offset: 0, reload: 'reload' }); collection.dispose()
})
for (const versions of [[undefined, undefined], ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001'], ['00000000-0000-4000-8000-000000000001', undefined], [undefined, '00000000-0000-4000-8000-000000000001'], ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002']]) {
  test(`MBP005：队列loader版本${versions.map(value => value ?? 'legacy').join('→')}，不混页或重放`, async () => {
    const calls: number[] = []
    const load = createPlaylistSnapshotLoader(async request => { calls.push(request.offset); return { id: 'playlist', name: '歌单', trackCount: 2, ...(versions[calls.length - 1] ? { snapshotVersion: versions[calls.length - 1] } : {}), tracks: page(`曲目${request.offset}`, request.offset) } })
    assert.equal((await load({ offset: 0, limit: 1 })).items[0]?.id, '曲目0')
    if (versions[0] === versions[1]) assert.equal((await load({ offset: 1, limit: 1 })).items[0]?.id, '曲目1')
    else await assert.rejects(load({ offset: 1, limit: 1 }), PlaylistSnapshotChanged)
    assert.deepEqual(calls, [0, 1])
  })
}
test('MBP005：刷新同epoch保留累积页handle/游标，换epoch或handle拒旧尾页', () => {
  const a = roonPage('前页'), tail = { ...roonPage('尾页', 7), playbackContextHandle: '00000000-0000-4000-8000-000000000003', items: [...a.items, ...roonPage('尾页').items] }
  const first = { ...a, playbackContextHandle: tail.playbackContextHandle }
  const merged = mergeRefreshedRoonPage(tail, first); assert.deepEqual(merged.items.map(item => item.reference), ['前页', '尾页']); assert.equal(merged.nextOffset, 8); assert.equal(merged.playbackContextHandle, tail.playbackContextHandle)
  assert.equal(mergeRefreshedRoonPage(tail, { ...first, sourceEpoch: '00000000-0000-4000-8000-000000000002' }).items.length, 1)
  assert.equal(mergeRefreshedRoonPage(tail, { ...first, playbackContextHandle: undefined }).items.length, 1)
})
test('MBP005：搜索缓存过期独立reload，取消旧query结果不暖缓存', async () => {
  let now = 0, calls = 0
  const cache = createLibraryPageCache({ now: () => now }), modes: Array<boolean | undefined> = [], pending = deferred<typeof empty>()
  const loader = createSearchSnapshotLoader({ artists: async (_q, _p, options) => { modes.push(options?.reload); return empty }, albums: async () => empty, tracks: async () => { calls++; return calls === 2 ? pending.promise : page('快结果') } }, { cache })
  await loader.load('相同query', { onSection: () => {} }); now = 30_000
  const refresh = loader.load('相同query', { onSection: () => {} }); loader.cancel(); pending.resolve(empty); assert.equal((await refresh).stale, true)
  assert.deepEqual(modes, [false, true]); now = 300_001; assert.equal(cache.stats().pages, 0)
})

function privateLibrary(api: Partial<MusicBridgePublicApi>, options: { cache?: ReturnType<typeof createLibraryPageCache>; getCacheScope?: () => string; onResetPrivate?: () => void } = {}) {
  return useNeteaseLibrary({ api: { getAccountState: async () => ({ status: 'ready', profile: { displayName: '同名账户' } }), getLikedTracks: async () => empty,
    getUserPlaylists: async () => [], getDailyRecommendations: async () => ({ dayKey: '2026-10-01', tracks: [] }), ...api } as unknown as MusicBridgePublicApi,
    getCoreRuntime: () => 'ready', getRemoteStatus: () => 'ready', getView: () => 'playlist-detail', onMatchTracks: () => {}, onPlaylistSwitch: () => {}, onPlaylistReady: () => {}, onResetPrivate: () => {},
    onError: () => {}, accountMessage: () => '账户失败', dailyMessage: () => '推荐失败', libraryErrorKind: () => 'generic', ...options })
}
test('MBP005：歌单换版重读仍变化只失败一次，不安装新代尾页、不无限rebase', async t => {
  const versions = [1, 2, 3].map(n => `00000000-0000-4000-8000-00000000000${n}`), offsets: number[] = []
  const library = privateLibrary({ getPlaylist: async (id, request) => { offsets.push(request.offset); return { id, name: id, trackCount: 2, snapshotVersion: versions[offsets.length - 1], tracks: page(`版本${offsets.length}`, request.offset) } } })
  t.after(() => library.dispose()); library.applyAuthState({ status: 'authorized' }); await turn()
  await library.loadPlaylist('playlist-a', { offset: 0, limit: 1 }); await library.loadPlaylist('playlist-a', { offset: 1, limit: 1 })
  assert.deepEqual(offsets, [0, 1, 0]); assert.deepEqual(library.selectedPlaylist.value?.tracks.items.map(track => track.id), ['版本1'])
  assert.match(library.playlistRefreshError.value!, /内容已变化/); assert.equal(library.playlistInitialLoading.value, false); assert.equal(library.playlistLoadingMore.value, false)
})
test('MBP005：歌单fresh首页缓存不截已加载尾页，scroll保持，刷新失败可重试', async t => {
  let now = 0, calls = 0, failed = false
  const cache = createLibraryPageCache({ now: () => now }), library = privateLibrary({ getPlaylist: async (id, request) => {
    calls++; if (failed) throw new Error('合成刷新失败'); return { id, name: id, trackCount: 2, snapshotVersion: '00000000-0000-4000-8000-000000000001', tracks: page(`曲目${request.offset}`, request.offset) }
  } }, { cache, getCacheScope: () => '同账户' })
  t.after(() => library.dispose()); library.applyAuthState({ status: 'authorized' }); await turn()
  await library.loadPlaylist('playlist-a', { offset: 0, limit: 1 }); await library.loadPlaylist('playlist-a', { offset: 1, limit: 1 }); library.playlistContentScrollTop.value = 880
  await library.loadPlaylist('playlist-a', { offset: 0, limit: 1 }); assert.equal(calls, 2); assert.deepEqual(library.selectedPlaylist.value?.tracks.items.map(track => track.id), ['曲目0', '曲目1']); assert.equal(library.playlistContentScrollTop.value, 880)
  now = 30_000; failed = true; await library.loadPlaylist('playlist-a', { offset: 0, limit: 1 }); assert.equal(library.selectedPlaylist.value?.tracks.items.length, 2); assert.equal(library.playlistDetailError.value, null); assert.ok(library.playlistRefreshError.value)
})
test('MBP005：logout/account epoch清空值与pool，迟到旧私有页不恢复也不暖缓存', async t => {
  const cache = createLibraryPageCache(), pending = deferred<PlaylistDetail>(); let scope = '账户A'
  const library = privateLibrary({ getPlaylist: () => pending.promise }, { cache, getCacheScope: () => scope, onResetPrivate: () => cache.clear() })
  t.after(() => library.dispose()); library.applyAuthState({ status: 'authorized' }); await turn()
  const read = library.loadPlaylist('playlist-a', { offset: 0, limit: 1 }); library.applyAuthState({ status: 'idle' }); scope = '账户B'
  pending.resolve({ id: 'playlist-a', name: '不能恢复的旧账户页', trackCount: 1, tracks: page('旧账户歌曲') }); await read
  assert.equal(library.selectedPlaylist.value, null); assert.equal(library.likedPage.value.items.length, 0); assert.equal(library.playlists.value.length, 0); assert.equal(library.playlistInitialLoading.value, false); assert.equal(cache.stats().pages, 0)
})
test('MBP005：搜索新query迟到旧分区不发布，健康艺人不被失败专辑阻住', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const old = deferred<typeof empty>(), search = searchHarness({ searchTracks: async query => query === '旧查询' ? old.promise : page('新查询歌曲'),
    searchArtists: async () => ({ ...empty, items: [{ id: 'artist-a', name: '即时艺人' }] }), searchAlbums: async () => { throw new Error('专辑暂时失败') },
    searchRoonLibrary: async () => empty, matchLibraryTrack: async () => ({ state: 'NOT_FOUND' }) as never })
  t.after(() => search.dispose()); search.searchQuery.value = '旧查询'; search.scheduleSearch(); t.mock.timers.tick(250); await turn()
  search.searchQuery.value = '新查询'; search.scheduleSearch(); assert.equal(search.searchPage.value.items.length, 0); t.mock.timers.tick(250); await turn()
  assert.equal(search.searchArtistsState.value, 'ready'); assert.equal(search.searchArtistsPage.value.items[0]?.name, '即时艺人'); assert.equal(search.searchAlbumsState.value, 'error')
  old.resolve(page('迟到旧查询歌曲') as typeof empty); await turn(); assert.equal(search.searchPage.value.items[0]?.id, '新查询歌曲')
})

import { useRoonBrowse } from '../src/renderer/src/composables/application/useRoonBrowse.js'
test('MBP005：50/500/5000合成条目逐页读取，pool只留最多8窗口页并报告精确bytes', async t => {
  const retained: Array<{ inputItems: number; pages: number; bytes: number; retainedItems: number }> = []
  for (const count of [50, 500, 5000]) {
    const cache = createLibraryPageCache(), keys = []
    for (let offset = 0; offset < count; offset += 24) {
      const value = { items: Array.from({ length: Math.min(24, count - offset) }, (_, i) => ({ reference: `合成引用${offset + i}`, kind: 'album', title: `合成标题${offset + i}` })), offset, limit: 24, total: count, hasMore: offset + 24 < count }
      const key = cacheIdentity('纯合成scope', '单数据集', value); keys.push(key); cache.put(key, value)
    }
    const stats = cache.stats(), retainedItems = keys.reduce((sum, key) => sum + (cache.peek<{ items: unknown[] }>(key)?.value.items.length ?? 0), 0)
    assert.equal(stats.pages, Math.min(8, Math.ceil(count / 24))); assert.ok(stats.bytes <= 8 * 1024 * 1024); assert.equal(retainedItems, count === 50 ? 50 : count % 24 + 7 * 24)
    retained.push({ inputItems: count, ...stats, retainedItems }); cache.dispose()
  }
  t.diagnostic(JSON.stringify({ note: '纯值pool页与UTF8序列化bytes，不是RSS或实际设备数据', retained }))
})
test('MBP005：真实browse父详情返回保留累计页与handle，fresh不重读，scope变更拒恢复', async t => {
  const cache = createLibraryPageCache(), offsets: number[] = []; let scope = 'scope-a'
  const artist = { reference: 'artist-a', kind: 'artist' as const, title: '合成艺人' }, handle = '00000000-0000-4000-8000-000000000003'
  const browse = useRoonBrowse({ cache, getCacheScope: () => scope, api: { listRoonArtists: async () => ({ ...roonPage('artist-a'), items: [artist] }),
    getRoonArtistAlbums: async (_ref: string, request: PageRequest) => { offsets.push(request.offset); return { ...roonPage(`album-${request.offset}`, request.offset), playbackContextHandle: handle } }, checkFavorite: async () => ({ favorite: false }) } as unknown as MusicBridgePublicApi,
    formatError: () => '读取错误', onError: () => {}, onToast: () => {}, getView: () => 'roon-artist-detail', onDetailOpening: () => {}, onDetailReady: () => {}, onNavigateSource: () => {}, onPlayTrack: () => {} })
  t.after(() => browse.dispose()); await browse.loadRoonArtists(); await browse.loadRoonArtist('artist-a', { offset: 0, limit: 1 }); await browse.loadRoonArtist('artist-a', { offset: 1, limit: 1 })
  const captured = browse.captureDetail(); browse.leaveDetail(); browse.restoreDetail(captured); await browse.resumePageReads('roon-artist-detail')
  assert.deepEqual(offsets, [0, 1]); assert.deepEqual(browse.selectedRoonArtistPage.value.items.map(item => item.reference), ['album-0', 'album-1']); assert.equal(browse.selectedRoonArtistPage.value.playbackContextHandle, handle)
  scope = 'scope-b'; browse.resetSession(); browse.restoreDetail(captured); assert.equal(browse.selectedRoonArtistPage.value.items.length, 0)
})

test('MBP005：五分区显式同query刷新各reload一次，普通fresh恢复不再读IPC', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const cache = createLibraryPageCache(), requests: Array<{ command: string; mode?: string }> = []
  const search = searchHarness({ cancelLibraryRead: async () => {}, readLibrary: (async request => {
    requests.push({ command: request.command, ...(request.cacheMode ? { mode: request.cacheMode } : {}) })
    if (request.command === 'library.search') return page('同query歌曲')
    if (request.command === 'roon.library.search') return { ...roonPage('同query专辑'), hasMore: false }
    return empty
  }) as MusicBridgePublicApi['readLibrary'] }, { cache, getZoneId: () => undefined })
  t.after(() => search.dispose()); search.searchQuery.value = '同查询'; search.scheduleSearch(); t.mock.timers.tick(250); await turn()
  assert.equal(requests.length, 5); assert.equal(requests.filter(value => value.mode).length, 0)
  search.scheduleSearch(); t.mock.timers.tick(250); await turn()
  assert.equal(requests.length, 10); assert.equal(requests.slice(5).filter(value => value.mode === 'reload').length, 5)
  search.suspend(); search.resume(); await turn(); assert.equal(requests.length, 10)
})
test('MBP005：私有scope轮转先同步取消，原恢复链替换pending，旧回执不清新loading', async t => {
  const old = deferred<PlaylistDetail>(), current = deferred<PlaylistDetail>(); let calls = 0, scope = 'scope-a'
  const library = privateLibrary({ getPlaylist: () => (++calls === 1 ? old.promise : current.promise) }, { getCacheScope: () => scope, cache: createLibraryPageCache() })
  t.after(() => library.dispose()); library.applyAuthState({ status: 'authorized' }); await turn()
  const first = library.loadPlaylist('playlist-a', { offset: 0, limit: 1 }); scope = 'scope-b'; library.resetAuthorizedLoadStarted(); library.loadAuthorizedLibraryWhenReady(); await turn()
  assert.equal(calls, 2); assert.equal(library.playlistInitialLoading.value, true)
  old.resolve({ id: 'playlist-a', name: '旧值', trackCount: 1, tracks: page('旧歌曲') }); await first; await turn()
  assert.equal(library.selectedPlaylist.value, null); assert.equal(library.playlistInitialLoading.value, true)
  current.resolve({ id: 'playlist-a', name: '当前值', trackCount: 1, tracks: page('当前歌曲') }); await turn(); assert.equal((library.selectedPlaylist.value as PlaylistDetail | null)?.name, '当前值'); assert.equal(library.playlistInitialLoading.value, false)
})

test('MBP005 R1：collection时钟回拨不能把已有页当fresh，恢复必须重采', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100_000 }); let calls = 0
  const collection = useRoonCollection(async () => { calls++; return roonPage('采样页') }, () => '错误', 1, { cache: createLibraryPageCache() })
  t.after(() => collection.dispose()); await collection.load(); collection.suspend(); t.mock.timers.setTime(90_000); await collection.resume()
  assert.equal(calls, 2); assert.equal(collection.page.value.items[0]?.reference, '采样页')
})
test('MBP005 R1：父详情snapshot时钟回拨必须重采，不能绕pool拒负age', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100_000 }); let calls = 0
  const artist = { reference: 'artist-a', kind: 'artist' as const, title: '合成艺人' }
  const browse = useRoonBrowse({ cache: createLibraryPageCache(), getCacheScope: () => 'scope', api: {
    listRoonArtists: async () => ({ ...roonPage('artist-a'), items: [artist] }), getRoonArtistAlbums: async () => { calls++; return roonPage('采样页') }, checkFavorite: async () => ({ favorite: false }),
  } as unknown as MusicBridgePublicApi, formatError: () => '读取错误', onError: () => {}, onToast: () => {}, getView: () => 'roon-artist-detail', onDetailOpening: () => {}, onDetailReady: () => {}, onNavigateSource: () => {}, onPlayTrack: () => {} })
  t.after(() => browse.dispose()); await browse.loadRoonArtists(); await browse.loadRoonArtist('artist-a', { offset: 0, limit: 1 }); const snapshot = browse.captureDetail(); browse.leaveDetail()
  t.mock.timers.setTime(90_000); browse.restoreDetail(snapshot); browse.resumeDetail('roon-artist-detail'); await turn()
  assert.equal(calls, 2); assert.equal(browse.selectedRoonArtistPage.value.items[0]?.reference, '采样页')
})
test('MBP005 R1：真实App account.changed清私有值后恢复列表且不重读profile形成环', async t => {
  const { readFile } = await import('node:fs/promises'), { parse } = await import('@vue/compiler-sfc'), ts = (await import('typescript')).default, { ref } = await import('vue')
  const { descriptor } = parse(await readFile(new URL('../src/renderer/src/App.vue', import.meta.url), 'utf8'))
  const ast = ts.createSourceFile('App.ts', descriptor.scriptSetup!.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let branch = '', invalidate = ''
  function visit(node: import('typescript').Node): void {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'invalidatePageCaches') invalidate = node.getText(ast)
    if (ts.isIfStatement(node) && node.expression.getText(ast) === "event.event === 'account.changed'") branch = node.getText(ast)
    ts.forEachChild(node, visit)
  }
  visit(ast); assert.ok(branch); assert.ok(invalidate)
  let likedCalls = 0, playlistCalls = 0, accountCalls = 0, dailyCalls = 0
  const library = privateLibrary({ getAccountState: async () => { accountCalls++; return { status: 'ready', profile: { userId: '合成用户', displayName: '合成账户' } } },
    getLikedTracks: async () => { likedCalls++; return page('恢复的喜欢') }, getUserPlaylists: async () => { playlistCalls++; return [{ id: 'playlist-a', name: '恢复的歌单', trackCount: 1 }] },
    getDailyRecommendations: async () => { dailyCalls++; return { dayKey: '2026-10-01', tracks: [] } } })
  t.after(() => library.dispose()); library.applyAuthState({ status: 'authorized' }); await turn(); assert.equal(likedCalls, 1); assert.equal(playlistCalls, 1); assert.equal(accountCalls, 1)
  const script = ts.transpileModule(`let pageCacheEpoch=0; ${invalidate}; return event => { ${branch} }`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  const scopeEpoch = ref(0); let artworkInvalidations = 0
  const execute = new Function('pageCache', 'netease', 'journey', 'playback', 'recentTracks', 'applyAccountState', 'search', 'currentView', 'roonGridScopeEpoch', 'roonArtworkCache', script)(
    createLibraryPageCache(), library, { resetPrivatePath() {} }, { invalidateCollectionOperation() {} }, ref([]), library.applyAccountState, { invalidateAccountScope() {}, resume() {} }, ref('liked'), scopeEpoch, { clear() { artworkInvalidations++ } }) as (event: unknown) => void
  execute({ event: 'account.changed', payload: { state: { status: 'ready', profile: { userId: '合成用户', displayName: '合成账户' } } } }); await turn()
  assert.equal(likedCalls, 2); assert.equal(playlistCalls, 2); assert.equal(library.likedPage.value.items[0]?.id, '恢复的喜欢'); assert.equal(library.playlists.value[0]?.name, '恢复的歌单')
  assert.equal(accountCalls, 1, '可信profile事件恢复数据时不得再读profile触发反馈'); assert.equal(dailyCalls, 2, '沿applyAccountState原逻辑刷新一次daily，恢复函数不再重复')
  assert.equal(scopeEpoch.value, 1, '身份轮转同步废弃旧收藏解析作用域'); assert.equal(artworkInvalidations, 1, '身份轮转同步清旧图片租期，不由迟到回执重放')
})

test('MBP005 R1：collection恰在0/29999ms为fresh，30000ms恢复重采', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100_000 }); let calls = 0
  const collection = useRoonCollection(async () => { calls++; return roonPage('采样页') }, () => '错误', 1, { cache: createLibraryPageCache() })
  t.after(() => collection.dispose()); await collection.load(); collection.suspend(); await collection.resume(); assert.equal(calls, 1)
  t.mock.timers.setTime(129_999); await collection.resume(); assert.equal(calls, 1)
  t.mock.timers.setTime(130_000); await collection.resume(); assert.equal(calls, 2)
})
test('MBP005 R1：详情retry显式reload正确target，取消旧more且迟到响应不暖cache或覆盖新详情', async t => {
  const cache = createLibraryPageCache(), pending = deferred<{ id: string; name: string; artistName: string; tracks: ReturnType<typeof page> }>()
  const requests: Array<{ command: string; payload: unknown; mode?: string }> = []
  let visibleScroll = 321, restoredScroll = -1
  const detail = (title: string, offset = 0) => ({ id: 'album-a', name: title, artistName: '合成艺人', tracks: page(title, offset) })
  const search = searchHarness({ cancelLibraryRead: async () => {}, readLibrary: (async request => {
    requests.push({ command: request.command, payload: request.payload, ...(request.cacheMode ? { mode: request.cacheMode } : {}) })
    if (requests.length === 2) return pending.promise
    return detail(requests.length === 1 ? '初始歌曲' : '刷新歌曲')
  }) as MusicBridgePublicApi['readLibrary'] }, { cache, getZoneId: () => undefined, getScrollTop: () => visibleScroll, scrollTo: top => { restoredScroll = top } })
  t.after(() => search.dispose()); await search.openSearchDetail('album', 'album-a', '合成专辑', '合成艺人')
  visibleScroll = 987
  const more = search.loadMoreSearchDetail(); await search.retrySearchDetail()
  assert.deepEqual(requests.map(r => ({ command: r.command, mode: r.mode, payload: r.payload })), [
    { command: 'library.album', mode: undefined, payload: { albumId: 'album-a', page: { offset: 0, limit: 20 } } },
    { command: 'library.album', mode: undefined, payload: { albumId: 'album-a', page: { offset: 1, limit: 1 } } },
    { command: 'library.album', mode: 'reload', payload: { albumId: 'album-a', page: { offset: 0, limit: 20 } } },
  ])
  pending.resolve(detail('迟到旧尾页', 1)); await more; await turn()
  assert.equal(search.searchDetail.value?.title, '刷新歌曲'); assert.deepEqual(search.searchDetail.value?.tracks.items.map(track => track.id), ['刷新歌曲'])
  assert.equal(search.searchDetailLoadingMore.value, false); assert.equal(search.searchDetailMoreError.value, null)
  const identity = cacheIdentity(JSON.stringify(['', 'netease', 0, null, true]), JSON.stringify(['detail', 'album', 'album-a']), { offset: 0, limit: 20 })
  assert.equal(cache.peek<{ title: string }>(identity)?.value.title, '刷新歌曲')
  search.closeSearchDetail(); assert.equal(restoredScroll, 321, '详情重试不能覆盖返回搜索页的滚动位置')
})

function descriptorHarness(kind: 'album' | 'artist' | 'genre' | 'playlist') {
  let reads = 0
  const cache = createLibraryPageCache(), child = { ...roonPage('缓存子项'), hasMore: false }
  const read = async () => { reads++; return child }
  const browse = useRoonBrowse({ cache, getCacheScope: () => '描述符测试scope', api: {
    getRoonAlbumTracks: read, getRoonArtistAlbums: read, getRoonGenreItems: read, getRoonPlaylistTracks: read, checkFavorite: async () => ({ favorite: false }),
  } as unknown as MusicBridgePublicApi, formatError: () => '读取错误', onError: () => {}, onToast: () => {}, getView: () => `roon-${kind}-detail`,
    onDetailOpening: () => {}, onDetailReady: () => {}, onNavigateSource: () => {}, onPlayTrack: () => {} })
  const ports = { album: { root: browse.roonAlbumsPage, selected: browse.selectedRoonAlbum, page: browse.selectedRoonAlbumPage, load: browse.loadRoonAlbum },
    artist: { root: browse.roonArtistsPage, selected: browse.selectedRoonArtist, page: browse.selectedRoonArtistPage, load: browse.loadRoonArtist },
    genre: { root: browse.roonGenresPage, selected: browse.selectedRoonGenre, page: browse.selectedRoonGenrePage, load: browse.loadRoonGenre },
    playlist: { root: browse.roonPlaylistsPage, selected: browse.selectedRoonPlaylist, page: browse.selectedRoonPlaylistPage, load: browse.loadRoonPlaylist } }
  return { browse, ...ports[kind], readCount: () => reads, child }
}
for (const kind of ['album', 'artist', 'genre', 'playlist'] as const) {
  for (const origin of ['当前列表', '当前点击'] as const) test(`MBP005 Gate回归：${kind}相同reference的${origin}新metadata优先旧cache描述符`, async t => {
    const h = descriptorHarness(kind), old = { reference: `${kind}-same-reference`, kind, title: '旧查询标题', subtitle: '旧说明' }
    t.after(() => h.browse.dispose()); h.root.value = { ...roonPage('root'), items: [old] }; await h.load(old.reference, { offset: 0, limit: 1 }); assert.equal(h.selected.value?.title, '旧查询标题')
    const current = { ...old, title: '聚合验证的新标题', subtitle: '当前查询说明' }
    if (origin === '当前列表') {
      h.root.value = { ...h.root.value, items: [current] }
      await dispatchAppRootSelect(kind, h.browse, current, () => {})
    }
    else { h.root.value = { ...h.root.value, items: [] }; h.selected.value = current }
    await h.load(current.reference, { offset: 0, limit: 1 })
    assert.equal(h.selected.value?.title, current.title); assert.equal(h.selected.value?.subtitle, current.subtitle)
    assert.equal(h.readCount(), 1, '只更新当前描述符，fresh缓存详情页仍复用'); assert.equal(h.page.value.sourceEpoch, h.child.sourceEpoch); assert.equal(h.page.value.items[0]?.reference, '缓存子项')
    const snapshot = h.browse.captureDetail(); h.browse.leaveDetail(); h.browse.restoreDetail(snapshot); await h.browse.resumePageReads(`roon-${kind}-detail`)
    assert.equal(h.selected.value?.title, current.title, '父详情恢复不倒退metadata'); assert.equal(h.readCount(), 1)
  })
  test(`MBP005 Gate保护：${kind}没有当前目标描述符时仍允许cache恢复且不带入另一target`, async t => {
    const h = descriptorHarness(kind), original = { reference: `${kind}-same-reference`, kind, title: '可恢复的旧目标描述符' }
    t.after(() => h.browse.dispose()); h.root.value = { ...roonPage('root'), items: [original] }; await h.load(original.reference, { offset: 0, limit: 1 })
    h.root.value = { ...h.root.value, items: [] }; h.selected.value = null
    await h.load(original.reference, { offset: 0, limit: 1 }); assert.equal((h.selected.value as RoonLibraryItem | null)?.title, original.title); assert.equal(h.readCount(), 1)
    h.selected.value = { reference: `${kind}-another-reference`, kind, title: '不得带入的另一个目标' }
    await h.load(original.reference, { offset: 0, limit: 1 }); assert.equal(h.selected.value?.reference, original.reference); assert.equal(h.selected.value?.title, original.title); assert.equal(h.readCount(), 1)
  })
}

// 执行实际App模板绑定与脚本函数，验证点击条目先seed，再进入原导航链。
async function dispatchAppRootSelect(kind: 'album' | 'artist' | 'genre' | 'playlist', browse: ReturnType<typeof useRoonBrowse>, item: RoonLibraryItem, navigateSource: (source: { type: string; reference: string }) => void) {
  const { readFile } = await import('node:fs/promises'), { parse } = await import('@vue/compiler-sfc'), ts = (await import('typescript')).default
  const { descriptor } = parse(await readFile(new URL('../src/renderer/src/App.vue', import.meta.url), 'utf8'))
  const plural = { album: 'albums', artist: 'artists', genre: 'genres', playlist: 'playlists' }[kind]
  const section = descriptor.template!.content.split(`currentView === 'roon-${plural}'`)[1]!.split('</section>')[0]!
  const expression = section.match(/@select="([^"]+)"/)![1]!
  const ast = ts.createSourceFile('App.ts', descriptor.scriptSetup!.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const functions: string[] = []
  function visit(node: import('typescript').Node): void {
    if (ts.isFunctionDeclaration(node) && ['seedCurrentRoonDescriptor', 'openRoonLibraryItem'].includes(node.name?.text ?? '')) functions.push(node.getText(ast))
    ts.forEachChild(node, visit)
  }
  visit(ast)
  const script = ts.transpileModule(`${functions.join('\n')}; return $event => { ${expression.includes('$event') ? expression : `${expression}($event)`} }`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  const execute = new Function('browse', 'navigateSource', script)(browse, navigateSource) as (item: RoonLibraryItem) => void
  execute(item)
}
for (const kind of ['album', 'artist', 'genre', 'playlist'] as const) {
  test(`MBP005 Gate根覆盖：${kind}当前seed优先同reference旧root及旧cache`, async t => {
    const h = descriptorHarness(kind), old = { reference: `${kind}-same-reference`, kind, title: '旧根与旧缓存' }
    t.after(() => h.browse.dispose()); h.root.value = { ...roonPage('root'), items: [old] }; await h.load(old.reference, { offset: 0, limit: 1 })
    const current = { ...old, title: '当前seed的新metadata', subtitle: '当前说明' }; h.selected.value = current
    await h.load(current.reference, { offset: 0, limit: 1 })
    assert.equal(h.selected.value?.title, current.title); assert.equal(h.selected.value?.subtitle, current.subtitle); assert.equal(h.readCount(), 1)
  })
  test(`MBP005 Gate实际App点击：${kind}同ref新条目必须在导航前seed，旧root不抢当前metadata`, async t => {
    const h = descriptorHarness(kind), old = { reference: `${kind}-same-reference`, kind, title: '旧查询条目' }
    t.after(() => h.browse.dispose()); h.root.value = { ...roonPage('root'), items: [old] }; await h.load(old.reference, { offset: 0, limit: 1 })
    const current = { ...old, title: '刚点击的新查询条目', subtitle: '新查询说明' }; let navigations = 0, loading: Promise<void> | undefined
    await dispatchAppRootSelect(kind, h.browse, current, source => {
      navigations++; assert.equal(h.selected.value?.reference, current.reference); assert.equal(h.selected.value?.title, current.title, '实际模板点击必须先seed描述符再导航'); assert.equal(h.selected.value?.subtitle, current.subtitle)
      assert.deepEqual(source, { type: `roon-${kind}`, reference: current.reference }); loading = h.load(source.reference, { offset: 0, limit: 1 })
    })
    await loading; assert.equal(navigations, 1); assert.equal(h.selected.value?.title, current.title); assert.equal(h.selected.value?.subtitle, current.subtitle); assert.equal(h.readCount(), 1)
  })
}
