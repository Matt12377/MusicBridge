import assert from 'node:assert/strict'
import test from 'node:test'
import type { IpcCommandResults, LibraryReadCommand, LibraryReadRequest, PageRequest, PlaylistDetail, PublicBridgeState, RoonLibraryPage } from '@music-bridge/contracts'
import type { MusicBridgePublicApi } from '../src/preload/api.js'
import { useNeteaseLibrary } from '../src/renderer/src/composables/application/useNeteaseLibrary.js'
import { useRoonBrowse } from '../src/renderer/src/composables/application/useRoonBrowse.js'
import { useAggregatedSearch } from '../src/renderer/src/composables/application/useAggregatedSearch.js'
import { usePageJourney } from '../src/renderer/src/composables/application/usePageJourney.js'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const empty = { items: [], offset: 0, limit: 24, total: 0, hasMore: false }
const roonPage = (title: string, request: PageRequest = { offset: 0, limit: 24 }, more = false): RoonLibraryPage => ({
  ...request, items: [{ kind: 'album', reference: title, title }], total: 3, hasMore: more,
})
const playlistPage = (id: string, request: PageRequest, more = true): PlaylistDetail => ({
  id, name: id, trackCount: 3, tracks: { ...request, total: 3, hasMore: more, items: [{ id: `${id}-${request.offset}`, title: id, artists: [], album: '合成专辑' }] },
})
const turn = () => new Promise<void>(resolve => setImmediate(resolve))

function harness(overrides: Partial<MusicBridgePublicApi> = {}) {
  const errors: unknown[] = [], ready: string[] = []
  let runtime: PublicBridgeState['runtime'] = 'ready'
  const api = {
    listRoonAlbums: async () => empty, listRoonArtists: async () => empty,
    listRoonGenres: async () => empty, listRoonPlaylists: async () => empty,
    getRoonAlbumTracks: async () => empty, getRoonArtistAlbums: async () => empty,
    getRoonGenreItems: async () => empty, getRoonPlaylistTracks: async () => empty,
    checkFavorite: async () => ({ favorite: false }), listFavorites: async () => empty,
    searchArtists: async () => empty, searchAlbums: async () => empty, searchTracks: async () => empty,
    searchRoonLibrary: async () => empty, getUserPlaylists: async () => [],
    getLikedTracks: async () => empty, getDailyRecommendations: async () => ({ dayKey: '2026-10-01', tracks: [] }),
    getAccountState: async () => ({ status: 'missing' }),
    getPlaylist: async (id: string, request: PageRequest) => playlistPage(id, request),
    ...overrides,
  } as unknown as MusicBridgePublicApi
  let journey!: ReturnType<typeof usePageJourney>
  const browse = useRoonBrowse({ api, formatError: () => '读取失败', onError: error => { errors.push(error) },
    onToast: () => undefined, getView: () => journey.currentView.value,
    onDetailOpening: view => journey.setDetailView(view), onDetailReady: (view, source) => { ready.push(view); journey.setDetailView(view, source) },
    onNavigateSource: source => journey.navigateSource(source), onPlayTrack: () => undefined,
  })
  const search = useAggregatedSearch({ api, getZoneId: () => undefined,
    getScrollTop: () => 0, scrollTo: () => undefined, classifyError: () => 'generic',
    onResetSearchOrigin: () => { journey.roonSearchOrigin.value = false },
    onInvalidateRoonDetails: () => browse.invalidateAlbumArtistRequests(),
  })
  const library = useNeteaseLibrary({ api, getCoreRuntime: () => runtime, getRemoteStatus: () => 'ready',
    getView: () => journey.currentView.value, onMatchTracks: () => undefined, onPlaylistSwitch: () => undefined,
    onPlaylistReady: id => { ready.push(id); journey.setDetailView('playlist-detail', { type: 'playlist', playlistId: id }) },
    onResetPrivate: () => undefined, onError: error => { errors.push(error) }, accountMessage: () => '账户失败', dailyMessage: () => '推荐失败', libraryErrorKind: () => 'generic',
  })
  library.authState.value = { status: 'authorized' }
  journey = usePageJourney({ browse, search, library: {
    ...library,
    hasLikedItems: () => library.likedPage.value.items.length > 0,
    isPlaylistReady: () => library.playlistState.value === 'ready',
    getPlaylistScrollTop: () => library.playlistContentScrollTop.value,
    setPlaylistScrollTop: top => { library.playlistContentScrollTop.value = top },
  }, onPlayRoonTrack: () => undefined, onCloseInspector: () => undefined, onClearActionError: () => undefined })
  return { api, browse, search, library, journey, errors, ready, setRuntime: (value: PublicBridgeState['runtime']) => { runtime = value }, dispose: () => { journey.dispose(); library.dispose(); search.dispose(); browse.dispose() } }
}

for (const kind of ['album', 'artist', 'genre', 'playlist'] as const) {
  test(`MBP-002：${kind} 详情离页后旧成功不能抢回首页`, async t => {
    const pending = deferred<RoonLibraryPage>()
    const methods = { album: 'getRoonAlbumTracks', artist: 'getRoonArtistAlbums', genre: 'getRoonGenreItems', playlist: 'getRoonPlaylistTracks' } as const
    const state = harness({ [methods[kind]]: () => pending.promise })
    t.after(state.dispose)
    state.journey.navigateSource({ type: `roon-${kind}`, reference: '旧详情' })
    state.journey.navigateSource({ type: 'home' })
    pending.resolve(roonPage('不能回填'))
    await turn()
    assert.equal(state.journey.currentView.value, 'home')
    assert.deepEqual(state.ready, [])
  })
}

test('MBP-002：NET 歌单离页后旧成功不能抢回详情', async t => {
  const pending = deferred<PlaylistDetail>()
  const state = harness({ getPlaylist: () => pending.promise })
  t.after(state.dispose)
  state.journey.navigateSource({ type: 'playlist', playlistId: 'A' })
  state.journey.navigateSource({ type: 'home' })
  pending.resolve(playlistPage('A', { offset: 0, limit: 20 }))
  await turn()
  assert.equal(state.journey.currentView.value, 'home')
  assert.deepEqual(state.ready, [])
})

test('MBP-002：NET 旧更多页换代不能阻塞新歌单更多页', async t => {
  const pending = deferred<PlaylistDetail>(), calls: string[] = []
  const state = harness({ getPlaylist: async (id, page) => {
    calls.push(`${id}:${page.offset}`)
    if (id === 'A' && page.offset > 0) return pending.promise
    return playlistPage(id, page)
  } })
  t.after(state.dispose)
  await state.library.loadPlaylist('A', { offset: 0, limit: 1 })
  const oldMore = state.library.loadPlaylist('A', { offset: 1, limit: 1 })
  await state.library.loadPlaylist('B', { offset: 0, limit: 1 })
  await state.library.loadPlaylist('B', { offset: 1, limit: 1 })
  pending.resolve(playlistPage('A', { offset: 1, limit: 1 }))
  await oldMore
  assert.deepEqual(calls, ['A:0', 'A:1', 'B:0', 'B:1'])
  assert.equal(state.library.selectedPlaylist.value?.id, 'B')
  assert.equal(state.library.playlistLoadingMore.value, false)
})

test('MBP-002：聚合搜索防抖中离页不派发隐藏查询且保留关键词', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const calls: string[] = []
  const state = harness({ searchTracks: async query => { calls.push(query); return empty } })
  t.after(state.dispose)
  state.journey.navigateSource({ type: 'roon-genres' })
  state.journey.updateSearchQuery('保留搜索')
  state.journey.navigateSource({ type: 'home' })
  t.mock.timers.tick(500)
  await turn()
  assert.deepEqual(calls, [])
  assert.equal(state.search.searchQuery.value, '保留搜索')
  assert.equal(state.journey.currentView.value, 'home')
})

test('MBP-002：Roon 本地搜索防抖中离页不派发，返回恢复同一关键词', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const calls: string[] = []
  const state = harness({ searchRoonLibrary: async query => { calls.push(query); return roonPage(query) } })
  t.after(state.dispose)
  state.journey.navigateSource({ type: 'roon-albums' })
  await turn()
  state.journey.updateSearchQuery('本地关键词')
  state.journey.navigateSource({ type: 'home' })
  t.mock.timers.tick(500)
  await turn()
  assert.deepEqual(calls, [])
  assert.equal(state.browse.localAlbumQuery.value, '本地关键词')
  state.journey.navigateSource({ type: 'roon-albums' })
  t.mock.timers.tick(500)
  await turn()
  assert.deepEqual(calls, ['本地关键词'])
})

test('MBP-002：旧 favorite check 失败离页后不产生错误提示', async t => {
  const pending = deferred<{ favorite: boolean }>()
  const state = harness({ checkFavorite: () => pending.promise })
  t.after(state.dispose)
  const old = state.browse.loadRoonEntityFavorite({ kind: 'album', title: '旧专辑', reference: '旧引用' }, 'album')
  state.journey.navigateSource({ type: 'home' })
  pending.reject(new Error('旧检查失败'))
  await old
  assert.deepEqual(state.errors, [])
})

test('MBP-002：Core 恢复不重放已离页的 NET 歌单，显式返回仍可读取', async t => {
  const calls: string[] = []
  const state = harness({ getPlaylist: async (id, page) => { calls.push(id); return playlistPage(id, page) } })
  t.after(state.dispose)
  state.setRuntime('starting')
  state.journey.navigateSource({ type: 'playlist', playlistId: 'A' })
  state.journey.navigateSource({ type: 'home' })
  state.setRuntime('ready')
  state.library.loadAuthorizedLibraryWhenReady()
  await turn()
  assert.deepEqual(calls, [])
  assert.equal(state.journey.currentView.value, 'home')
  state.journey.navigateSource({ type: 'playlist', playlistId: 'A' })
  await turn()
  assert.deepEqual(calls, ['A'])
  assert.equal(state.journey.currentView.value, 'playlist-detail')
})

test('MBP-002：父级艺术家数据和滚动在子专辑返回后恢复', async t => {
  const artist = { kind: 'artist' as const, reference: 'artist-A', title: '父级艺术家' }
  const album = { kind: 'album' as const, reference: 'album-B', title: '子专辑' }
  const state = harness({
    listRoonArtists: async () => ({ ...empty, items: [artist] }),
    getRoonArtistAlbums: async () => ({ ...empty, items: [album] }),
    getRoonAlbumTracks: async () => roonPage('子歌曲'),
  })
  t.after(state.dispose)
  let scrollTop = 146
  state.journey.contentScroll.value = { get scrollTop() { return scrollTop }, scrollTo: ({ top }: { top: number }) => { scrollTop = top } } as HTMLElement
  state.journey.navigateSource({ type: 'roon-artists' })
  await turn()
  state.journey.navigateSource({ type: 'roon-artist', reference: artist.reference })
  await turn()
  scrollTop = 146
  state.journey.navigateSource({ type: 'roon-album', reference: album.reference })
  await turn()
  scrollTop = 0
  state.journey.returnFromRoonDetail('album')
  await turn()
  assert.equal(state.journey.currentView.value, 'roon-artist-detail')
  assert.equal(state.browse.selectedRoonArtist.value?.reference, artist.reference)
  assert.deepEqual(state.browse.selectedRoonArtistPage.value.items.map(item => item.reference), [album.reference])
  assert.equal(scrollTop, 146)
})

test('MBP-002：恢复未知 B 的 pending 描述符不重读旧 A 元数据', async t => {
  const firstB = deferred<RoonLibraryPage>(), secondB = deferred<RoonLibraryPage>(), calls: string[] = []
  const state = harness({
    listRoonAlbums: async () => roonPage('A'),
    getRoonAlbumTracks: reference => { calls.push(reference); return reference === 'A' ? Promise.resolve(roonPage('A-tracks')) : calls.filter(item => item === 'B').length === 1 ? firstB.promise : secondB.promise },
  })
  t.after(state.dispose)
  state.journey.navigateSource({ type: 'roon-albums' })
  await turn()
  state.browse.localAlbumQuery.value = '保留路径'
  state.journey.navigateSource({ type: 'roon-album', reference: 'A' })
  await turn()
  state.journey.navigateSource({ type: 'roon-album', reference: 'B' })
  state.journey.navigateSource({ type: 'home' })
  state.journey.navigateSource({ type: 'roon-albums' })
  assert.deepEqual(calls, ['A', 'B', 'B'])
  assert.notEqual(state.browse.selectedRoonAlbum.value?.reference, 'A')
  firstB.resolve(roonPage('迟到 B'))
  await turn()
  assert.equal(state.browse.roonAlbumInitialLoading.value, true)
  secondB.resolve(roonPage('当前 B'))
  await turn()
  assert.equal(state.browse.selectedRoonAlbumPage.value.items[0]?.title, '当前 B')
  assert.equal(state.browse.localAlbumQuery.value, '保留路径')
})

function newProtocol() {
  const requests: LibraryReadRequest[] = [], cancelled: string[] = [], waits = new Map<string, ReturnType<typeof deferred<unknown>>>()
  return { requests, cancelled, waits, api: {
    readLibrary: <C extends LibraryReadCommand>(request: LibraryReadRequest<C>) => {
      requests.push(request)
      const wait = deferred<unknown>(); waits.set(request.id, wait)
      return wait.promise as Promise<IpcCommandResults[C]>
    },
    cancelLibraryRead: async (id: string) => { cancelled.push(id) },
  } }
}

test('MBP-002：真实 Renderer 新协议离页只取消详情，后台侧栏歌单继续', async t => {
  const transport = newProtocol()
  const state = harness(transport.api)
  t.after(state.dispose)
  const background = state.library.loadPlaylists()
  state.journey.navigateSource({ type: 'playlist', playlistId: 'A' })
  const sidebar = transport.requests.find(request => request.command === 'library.playlists')!
  const detail = transport.requests.find(request => request.command === 'library.playlist')!
  state.journey.navigateSource({ type: 'home' })
  assert.deepEqual(transport.cancelled, [detail.id])
  transport.waits.get(sidebar.id)!.resolve([])
  await background
  assert.equal(state.library.playlistState.value, 'ready')
  assert.equal(state.journey.currentView.value, 'home')
  transport.waits.get(detail.id)!.resolve(playlistPage('A', { offset: 0, limit: 20 }))
  await turn()
  assert.deepEqual(state.ready, [])
})

test('MBP-002：真实 Renderer 新协议 TIMEOUT 保留失败提示，离页取消不提示', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const transport = newProtocol(), state = harness(transport.api)
  t.after(state.dispose)
  state.journey.navigateSource({ type: 'roon-genre', reference: 'A' })
  t.mock.timers.tick(10_000)
  await turn()
  assert.equal(state.browse.roonGenreError.value, '读取失败')
  assert.equal(state.browse.roonGenreInitialLoading.value, false)
  assert.equal(transport.cancelled.length, 1)
  state.journey.navigateSource({ type: 'roon-playlist', reference: 'B' })
  state.journey.navigateSource({ type: 'home' })
  await turn()
  assert.equal(state.browse.roonPlaylistError.value, null)
  assert.deepEqual(state.errors, [])
  assert.equal(transport.cancelled.length, 2)
})

test('MBP-002：账户作用域换代隔离完成搜索缓存，普通导航保留分区', async t => {
  let account = 'A'
  const calls: string[] = []
  const state = harness({ searchTracks: async () => { calls.push(account); return { ...empty, items: [{ id: account, title: account, artists: [], album: account }] } } })
  t.after(state.dispose)
  state.search.searchQuery.value = '同一查询'
  state.search.searchPageAt(0)
  await turn()
  assert.equal(state.search.searchPage.value.items[0]?.id, 'A')
  state.search.searchCategory.value = 'albums'
  state.search.suspend()
  state.search.resume()
  assert.equal(state.search.searchCategory.value, 'albums')
  assert.deepEqual(calls, ['A'])
  account = 'B'
  state.search.invalidateAccountScope()
  state.search.resume()
  await turn()
  assert.deepEqual(calls, ['A', 'B'])
  assert.equal(state.search.searchPage.value.items[0]?.id, 'B')
  assert.equal(state.search.searchQuery.value, '同一查询')
})

test('MBP-002：防抖期间账户换代仍只派发一次新账户查询', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const transport = newProtocol(), state = harness(transport.api)
  t.after(state.dispose)
  state.search.searchQuery.value = '防抖查询'
  state.search.scheduleSearch()
  state.search.invalidateAccountScope()
  state.search.resume()
  assert.equal(transport.requests.length, 0)
  t.mock.timers.tick(250)
  await turn()
  assert.equal(transport.requests.filter(request => request.command === 'library.search').length, 1)
  assert.equal(transport.requests.filter(request => request.command === 'roon.library.search').length, 2)
})

test('MBP-002：新协议账户换代只取消 NET 分区，Roon 在途结果继续有效', async t => {
  const transport = newProtocol(), state = harness(transport.api)
  t.after(state.dispose)
  state.search.searchQuery.value = '同一查询'
  state.search.searchCategory.value = 'artists'
  state.search.searchPageAt(0)
  const old = [...transport.requests]
  state.search.invalidateAccountScope()
  state.search.resume()
  assert.deepEqual(transport.cancelled.sort(), old.filter(request => request.command.startsWith('library.')).map(request => request.id).sort())
  assert.equal(transport.requests.filter(request => request.command === 'roon.library.search').length, 2)
  for (const request of old) transport.waits.get(request.id)!.resolve(request.command === 'roon.library.search' ? roonPage('仍有效的 Roon') : empty)
  await turn()
  assert.equal(state.search.roonSearchAlbums.value.items[0]?.title, '仍有效的 Roon')
  assert.equal(state.search.searchInitialLoading.value, true)
  for (const request of transport.requests.slice(old.length)) transport.waits.get(request.id)!.resolve(request.command === 'library.search' ? { ...empty, items: [{ id: '新账户', title: '新账户', artists: [], album: '合成专辑' }] } : empty)
  await turn()
  assert.equal(state.search.searchPage.value.items[0]?.id, '新账户')
  assert.equal(state.search.searchCategory.value, 'artists')
  assert.equal(state.search.searchError.value, null)
})

test('MBP-002：新协议 Roon 换代只取消 Roon 分区，NET 与后台侧栏继续', async t => {
  const transport = newProtocol(), state = harness(transport.api)
  t.after(state.dispose)
  state.journey.currentView.value = 'search'
  const background = state.library.loadPlaylists()
  state.search.searchQuery.value = '原查询'
  state.search.searchPageAt(0)
  const old = [...transport.requests]
  state.search.invalidateRoonScope(true)
  assert.deepEqual(transport.cancelled.sort(), old.filter(request => request.command === 'roon.library.search').map(request => request.id).sort())
  assert.equal(transport.requests.filter(request => request.command === 'library.search').length, 1)
  for (const request of old) transport.waits.get(request.id)!.resolve(request.command === 'library.playlists' ? [] : request.command === 'roon.library.search' ? roonPage('无效旧 Roon') : empty)
  await background
  for (const request of transport.requests.slice(old.length)) transport.waits.get(request.id)!.resolve(roonPage('新 Roon'))
  await turn()
  assert.equal(state.search.roonSearchAlbums.value.items[0]?.title, '新 Roon')
  assert.equal(state.library.playlistState.value, 'ready')
  assert.equal(state.search.searchInitialLoading.value, false)
})

test('MBP-002：新协议 Core 换代取消全部搜索分区并以新 ID 恢复可见查询', async t => {
  const transport = newProtocol(), state = harness(transport.api)
  t.after(state.dispose)
  state.search.searchQuery.value = '恢复关键词'
  state.search.searchCategory.value = 'albums'
  state.search.searchPageAt(0)
  const old = [...transport.requests]
  state.search.invalidateScope()
  state.search.resume()
  assert.deepEqual(transport.cancelled.sort(), old.map(request => request.id).sort())
  assert.equal(transport.requests.length, 10)
  assert.equal(new Set(transport.requests.map(request => request.id)).size, 10)
  for (const request of old) transport.waits.get(request.id)!.resolve(request.command === 'roon.library.search' ? roonPage('不能恢复的旧数据') : empty)
  for (const request of transport.requests.slice(old.length)) transport.waits.get(request.id)!.resolve(request.command === 'roon.library.search' ? roonPage('恢复数据') : empty)
  await turn()
  assert.equal(state.search.roonSearchAlbums.value.items[0]?.title, '恢复数据')
  assert.equal(state.search.searchQuery.value, '恢复关键词')
  assert.equal(state.search.searchCategory.value, 'albums')
  assert.equal(state.search.searchError.value, null)
})

for (const kind of ['album', 'artist', 'genre', 'playlist'] as const) {
  test(`MBP-002：新协议 ${kind} 可见 pending 详情保留原 reference/page 并换 ID`, async t => {
    const transport = newProtocol(), state = harness(transport.api)
    t.after(state.dispose)
    state.journey.navigateSource({ type: `roon-${kind}`, reference: '未知 B' })
    const first = transport.requests.find(request => request.command === `roon.library.${kind}`)!
    state.journey.enterNowPlaying()
    state.journey.exitNowPlaying()
    const reads = transport.requests.filter(request => request.command === `roon.library.${kind}`)
    assert.equal(reads.length, 2)
    assert.deepEqual(reads[1]!.payload, first.payload)
    assert.notEqual(reads[1]!.id, first.id)
    assert.deepEqual(transport.cancelled, [first.id])
    transport.waits.get(first.id)!.resolve(roonPage('旧成功'))
    transport.waits.get(reads[1]!.id)!.resolve(roonPage('当前成功'))
    await turn()
    assert.equal(state.journey.currentView.value, `roon-${kind}-detail`)
    assert.deepEqual(state.ready, [`roon-${kind}-detail`])
  })
}

test('MBP-002：新协议 Core 恢复只重放仍可见的 NET 歌单描述符', async t => {
  const transport = newProtocol(), state = harness(transport.api)
  t.after(state.dispose)
  state.journey.navigateSource({ type: 'playlist', playlistId: 'A' })
  const first = transport.requests.find(request => request.command === 'library.playlist')!
  state.setRuntime('starting')
  state.library.resetAuthorizedLoadStarted()
  state.setRuntime('ready')
  state.library.loadAuthorizedLibraryWhenReady()
  const reads = transport.requests.filter(request => request.command === 'library.playlist')
  assert.equal(reads.length, 2)
  assert.notEqual(reads[1]!.id, first.id)
  assert.deepEqual(reads[1]!.payload, first.payload)
  assert.deepEqual(transport.cancelled, [first.id])
  transport.waits.get(first.id)!.resolve(playlistPage('旧 A', { offset: 0, limit: 20 }))
  transport.waits.get(reads[1]!.id)!.resolve(playlistPage('A', { offset: 0, limit: 20 }))
  for (const request of transport.requests.filter(request => request.command !== 'library.playlist')) transport.waits.get(request.id)!.resolve(request.command === 'library.playlists' ? [] : request.command === 'library.dailyRecommendations' ? { dayKey: '2026-10-01', tracks: [] } : empty)
  await turn()
  assert.equal(state.library.selectedPlaylist.value?.id, 'A')
  assert.deepEqual(state.ready, ['A'])
})

test('MBP-002：新协议主动 CANCELLED 搜索不转为失败提示且结束 loading', async t => {
  const transport = newProtocol(), state = harness(transport.api)
  t.after(state.dispose)
  state.search.searchQuery.value = '查询'
  state.search.searchPageAt(0)
  for (const request of transport.requests) transport.waits.get(request.id)!.reject(new Error("Error invoking remote method 'library:read': [CANCELLED] 合成换代"))
  await turn()
  assert.equal(state.search.searchInitialLoading.value, false)
  assert.equal(state.search.roonSearchLoading.value, false)
  assert.equal(state.search.searchError.value, null)
  assert.equal(state.search.searchArtistsError.value, null)
  assert.equal(state.search.searchAlbumsError.value, null)
  assert.equal(state.search.roonSearchError.value, null)
})

test('MBP-002：新协议主动 CANCELLED 的 NET 详情结束 loading 并保留重试描述符', async t => {
  const transport = newProtocol(), state = harness(transport.api)
  t.after(state.dispose)
  const pending = state.search.openSearchDetail('album', 'A', '专辑 A', '艺人')
  const first = transport.requests[0]!
  transport.waits.get(first.id)!.reject(Object.assign(new Error('取消'), { code: 'CANCELLED' }))
  await pending
  assert.equal(state.search.searchDetail.value?.loading, false)
  assert.equal(state.search.searchDetail.value?.error, null)
  state.search.resume()
  assert.equal(transport.requests.length, 2)
  assert.deepEqual(transport.requests[1]!.payload, first.payload)
})

test('MBP-002：防抖期间 Zone 换代不会抢先派发或重复 Roon 查询', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const transport = newProtocol(), state = harness(transport.api)
  t.after(state.dispose)
  state.search.searchQuery.value = 'Zone 查询'
  state.search.scheduleSearch()
  state.search.invalidateRoonScope(true)
  assert.equal(transport.requests.length, 0)
  t.mock.timers.tick(250)
  await turn()
  assert.equal(transport.requests.filter(request => request.command === 'roon.library.search').length, 2)
})

test('MBP-002：新协议取消后台歌单读取结束 loading 而不显示失败', async t => {
  const transport = newProtocol(), state = harness(transport.api)
  t.after(state.dispose)
  const pending = state.library.loadPlaylists()
  transport.waits.get(transport.requests[0]!.id)!.reject(Object.assign(new Error('取消'), { code: 'CANCELLED' }))
  await pending
  assert.equal(state.library.playlistState.value, 'ready')
  assert.equal(state.library.playlistError.value, null)
})

test('MBP-002：新协议取消首页推荐保留已有数据并允许恢复', async t => {
  const transport = newProtocol(), state = harness(transport.api)
  t.after(state.dispose)
  state.library.playlists.value = [{ id: 'A', name: 'A', trackCount: 1 }]
  const track = { id: '已有曲目', title: '已有曲目', artists: [], album: '合成专辑' }
  state.library.homePlaylistTracks.value = [track]
  const pending = state.library.loadHomeRecommendations()
  transport.waits.get(transport.requests[0]!.id)!.reject(Object.assign(new Error('取消'), { code: 'CANCELLED' }))
  await pending
  assert.equal(state.library.homeRecommendationState.value, 'ready')
  assert.deepEqual(state.library.homePlaylistTracks.value, [track])
  state.library.resumePageReads('home')
  assert.equal(transport.requests.filter(request => request.command === 'library.playlist').length, 2)
})

for (const source of ['netease', 'roon'] as const) {
  test(`MBP-002：新协议 ${source} 实体更多页离页恢复同一 offset，保留已有页`, async t => {
    const transport = newProtocol(), state = harness(transport.api)
    t.after(state.dispose)
    state.search.searchQuery.value = '分页查询'
    state.search.searchAlbumsPage.value = { ...empty, items: [{ id: 'NET-已加载', name: 'NET', artistName: '合成艺人' }], limit: 8, hasMore: true }
    state.search.searchAlbumsState.value = 'ready'
    state.search.roonSearchAlbums.value = roonPage('Roon-已加载', { offset: 0, limit: 8 }, true)
    const pending = state.search.loadMoreSearchEntities(source, 'album')
    const first = transport.requests[0]!
    state.search.suspend()
    await pending
    state.search.resume()
    assert.equal(transport.requests.length, 2)
    const second = transport.requests[1]!
    assert.deepEqual(second.payload, first.payload)
    assert.equal(second.command, first.command)
    assert.notEqual(second.id, first.id)
    assert.equal(state.search.searchAlbumsPage.value.items[0]?.id, 'NET-已加载')
    assert.equal(state.search.roonSearchAlbums.value.items[0]?.title, 'Roon-已加载')
    transport.waits.get(first.id)!.resolve(empty)
    transport.waits.get(second.id)!.resolve(source === 'netease'
      ? { ...empty, items: [{ id: 'NET-新页', name: 'NET 新页', artistName: '合成艺人' }], offset: 8, limit: 8 }
      : roonPage('Roon-新页', { offset: 8, limit: 8 }))
    await turn()
    if (source === 'netease') assert.deepEqual(state.search.searchAlbumsPage.value.items.map(item => item.id), ['NET-已加载', 'NET-新页'])
    else assert.deepEqual(state.search.roonSearchAlbums.value.items.map(item => item.title), ['Roon-已加载', 'Roon-新页'])
  })
}
