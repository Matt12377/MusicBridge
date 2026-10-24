import assert from 'node:assert/strict'
import test from 'node:test'
import { computed, createRenderer, markRaw, nextTick, ref, watch } from 'vue'
import { LOCAL_ALBUM_STATUSES, type LocalAlbumFilterCounts, type LocalAlbumPage, type LocalAlbumQuery, type LocalAlbumReadPort, type LocalAlbumSummary, type LocalAlbumTrackPage, type LocalAlbumTrackQuery, type LocalArtistSummary } from '@music-bridge/contracts'
import type { MusicBridgePublicApi } from '../src/preload/api.js'
import { useAggregatedSearch } from '../src/renderer/src/composables/application/useAggregatedSearch.js'
import { useRoonBrowse } from '../src/renderer/src/composables/application/useRoonBrowse.js'
import { usePageJourney } from '../src/renderer/src/composables/application/usePageJourney.js'
import { useLocalAlbumBrowser } from '../src/renderer/src/composables/application/local-library-browser/useLocalAlbumBrowser.js'
import { localAlbumItem, localArtistItem, localTrackItem, type CatalogItem, type CatalogPage } from '../src/renderer/src/composables/catalog/catalog-presentation.js'
import { useCatalogExperience, type CatalogDataPort } from '../src/renderer/src/composables/catalog/useCatalogExperience.js'
import { useCatalogAlbumNavigation } from '../src/renderer/src/composables/catalog/useCatalogAlbumNavigation.js'
import { useGridWindow } from '../src/renderer/src/composables/useGridWindow.js'

const album: LocalAlbumSummary = { id: 'catalog-return-album', kind: 'source-directory', rootId: '44444444-4444-4444-8444-000000000001',
  editionId: null, title: '七里香', artists: ['周杰伦'], year: '2004', versionLabel: null, trackCount: 0,
  representativeTrackId: null, revision: 'r1', artworkAvailable: false, artworkState: 'missing', statuses: ['missing-artwork'] }
const artist: LocalArtistSummary = { id: `local-artist:${'a'.repeat(64)}`, name: '周杰伦', source: 'local', albumCount: 2, trackCount: 7 }
const empty = (): CatalogPage => ({ items: [], offset: 0, limit: 24, total: 0, hasMore: false, revision: 'r1' })
const page = (items: CatalogItem[], offset = 0, hasMore = false): CatalogPage => ({ ...empty(), items, offset, total: offset + items.length + Number(hasMore), hasMore })
const albumPage = (request: LocalAlbumQuery): LocalAlbumPage => ({ ...request, items: [album], total: 1, hasMore: false,
  counts: Object.fromEntries([['all', 1], ...LOCAL_ALBUM_STATUSES.map(status => [status, Number(album.statuses.includes(status))])]) as LocalAlbumFilterCounts })
const trackPage = (request: LocalAlbumTrackQuery): LocalAlbumTrackPage => ({ ...request, album, total: 0, hasMore: false, items: [] })
const track = (title: string, n: number): CatalogItem => localTrackItem({ rootId: album.rootId, albumKey: album.id,
  track: { id: `44444444-4444-4444-8444-${String(n).padStart(12, '0')}`, assetId: '44444444-4444-4444-8444-000000000100', selectionRevision: '1', segment: null },
  asset: { id: '44444444-4444-4444-8444-000000000100', libraryRootId: album.rootId, sourceRootId: '44444444-4444-4444-8444-000000000200', rootRevision: '1', fileRevision: '1', locationRevision: '1', sampleFrames: null, timebaseHz: null },
  metadata: { title, artist: '周杰伦', album: album.title }, versionTokens: [] })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
const turn = () => new Promise<void>(yes => setImmediate(yes))

function fixture(t: test.TestContext, options: { port?: Partial<CatalogDataPort>; albumApi?: Partial<LocalAlbumReadPort>; afterRender?: () => Promise<void> } = {}) {
  const searches: { source: string; kind: string; query: string; offset: number }[] = [], albumReads: LocalAlbumTrackQuery[] = []
  const catalog = useCatalogExperience({
    search: async (source, kind, query, window) => { searches.push({ source, kind, query, offset: window.offset }); return source === 'local' && kind === 'albums' ? page([localAlbumItem(album)]) : empty() },
    suggest: async () => [], artists: async () => page([localArtistItem(artist)]), artist: async () => ({ artist }),
    artistAlbums: async () => page([localAlbumItem(album)]), artistTracks: async () => empty(), remoteDetail: async () => empty(),
    artistMatches: async () => [], bindArtist: async () => { throw new Error('导航不得写入关联') }, ...options.port,
  })
  const browser = useLocalAlbumBrowser({ reuseLoadedOnActivate: true, api: {
    queryAlbums: async request => albumPage(request), queryAlbumTracks: async request => { albumReads.push(request); return trackPage(request) },
    getArtwork: async request => ({ ...request, image: null, status: 'ready' }), ...options.albumApi,
  } })
  const emptyLegacyPage = { items: [], offset: 0, limit: 20, total: 0, hasMore: false }
  const api = { listRoonAlbums: async () => emptyLegacyPage, searchRoonLibrary: async () => emptyLegacyPage,
    getRoonAlbumTracks: async () => emptyLegacyPage, checkFavorite: async () => ({ favorite: false }),
    searchArtists: async () => emptyLegacyPage, searchTracks: async () => emptyLegacyPage, searchAlbums: async () => emptyLegacyPage } as unknown as MusicBridgePublicApi
  let journey!: ReturnType<typeof usePageJourney>
  const browse = useRoonBrowse({ api, formatError: () => '合成读取失败', onError() {}, onToast() {}, getView: () => journey.currentView.value,
    onDetailOpening: view => journey.setDetailView(view), onDetailReady: (view, source) => journey.setDetailView(view, source),
    onNavigateSource: source => journey.navigateSource(source), onPlayTrack() {} })
  const search = useAggregatedSearch({ api, getZoneId: () => undefined, getScrollTop: () => 0, scrollTo() {}, classifyError: () => 'generic', onResetSearchOrigin() {}, onInvalidateRoonDetails() {} })
  journey = usePageJourney({ browse, search, localArtistsEnabled: true,
    library: { hasLikedItems: () => true, isPlaylistReady: () => true, getPlaylistScrollTop: () => 0, setPlaylistScrollTop() {}, async loadLiked() {}, async loadPlaylists() {}, async loadPlaylist() {} },
    onPlayRoonTrack() {}, onCloseInspector() {}, onClearActionError() {} })
  const scrolls: number[] = [], scroll = { scrollTop: 0, scrollTo({ top }: { top: number }) { this.scrollTop = top; scrolls.push(top) } }
  journey.contentScroll.value = scroll as unknown as HTMLElement
  let selectedAlbumView = 0
  const navigation = useCatalogAlbumNavigation({ journey, catalog, browser, selectAlbumView() { selectedAlbumView++ }, ...(options.afterRender ? { afterRender: options.afterRender } : {}) })
  let workspace: { mode: 'search' | 'artists'; token: symbol } | undefined
  // 对接父级 currentView 与 CatalogWorkspace 的离页协议；组件事件透传另由原 SFC 测试覆盖。
  const stop = watch(journey.currentView, view => {
    if (workspace) { catalog.suspendWorkspace(workspace.mode, workspace.token); workspace = undefined }
    if (view !== 'local-library') browser.deactivate()
    if (view === 'search' || view === 'roon-artists') {
      workspace = { mode: view === 'search' ? 'search' : 'artists', token: Symbol('navigation-workspace') }
      catalog.activateWorkspace(workspace.mode, workspace.token)
      if (view === 'search') catalog.resumeSearch()
    }
  }, { flush: 'sync' })
  t.after(() => { stop(); navigation.dispose(); catalog.dispose(); browser.dispose(); journey.dispose(); browse.dispose(); search.dispose() })
  return { catalog, browser, journey, navigation, scroll, scrolls, searches, albumReads, selectedAlbumView: () => selectedAlbumView }
}

function returnedWall(t: test.TestContext, f: ReturnType<typeof fixture>) {
  const frames: FrameRequestCallback[] = [], old = new Map<string, PropertyDescriptor | undefined>()
  for (const [name, value] of Object.entries({
    getComputedStyle: () => ({ gridTemplateColumns: '222px 222px 222px', columnGap: '24px', rowGap: '28px' }),
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.push(callback); return frames.length },
  })) { old.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, value }) }
  type Host = { parent: Host | null; children: Host[] }
  const host = (): Host => ({ parent: null, children: [] })
  const renderer = createRenderer<Host, Host>({ createElement: host, createText: host, createComment: host, setText() {}, setElementText() {}, patchProp() {},
    insert(node, parent) { node.parent = parent; parent.children.push(node) }, remove() {}, parentNode: node => node.parent, nextSibling: () => null })
  let app: ReturnType<typeof renderer.createApp> | undefined, grid!: ReturnType<typeof useGridWindow<CatalogItem>>
  let mounted = false, height = 0, top = f.scroll.scrollTop
  const rect = (left: number, y: number, width: number, h: number) => ({ x: left, y, left, top: y, width, height: h, right: left + width, bottom: y + h, toJSON() {} })
  const probe = (): HTMLElement => ({ childNodes: [], style: {}, cloneNode: probe, removeAttribute() {}, setAttribute() {},
    querySelectorAll: () => [], remove() {}, getBoundingClientRect: () => rect(0, 0, 222, 301) }) as unknown as HTMLElement
  const prototype = probe()
  const element = markRaw({ getBoundingClientRect: () => rect(0, 200 - top, 714, height), closest: () => f.scroll, parentElement: null,
    querySelector: () => f.catalog.searchSections.local.albums.items.length ? prototype : null,
    querySelectorAll: () => f.catalog.searchSections.local.albums.items.length ? [prototype] : [], append() {},
  }) as unknown as HTMLElement
  Object.assign(f.scroll, { clientHeight: 600, clientTop: 0, getBoundingClientRect: () => rect(0, 0, 714, 600), addEventListener() {}, removeEventListener() {},
    querySelectorAll: () => mounted ? [element] : [] })
  Object.defineProperty(f.scroll, 'scrollTop', { configurable: true, get: () => top,
    set: (value: number) => { top = Math.max(0, Math.min(value, mounted ? Math.max(0, 200 + height - 600) : Number.MAX_SAFE_INTEGER)) } })
  const stop = watch(f.journey.currentView, view => {
    app?.unmount(); app = undefined; mounted = false
    if (view !== 'search') return
    mounted = true
    app = renderer.createApp({ setup() {
      grid = useGridWindow(computed(() => f.catalog.searchSections.local.albums.items), ref(element))
      // 只有 Vue 提交本次 rootStyle 后，浏览器才取得新的 scrollHeight；不能让赋值越过当前可滚范围。
      watch(grid.rootStyle, style => { height = Number.parseFloat(style?.height ?? '0') }, { immediate: true, flush: 'post' })
      return () => null
    } })
    app.mount(host())
  }, { flush: 'sync' })
  t.after(() => { stop(); app?.unmount(); for (const [name, descriptor] of old) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name) } })
  return { grid: () => grid, height: () => height,
    async frame() {
      assert.ok(frames.length, '必须等待真实测量帧')
      let passes = 0
      while (frames.length) {
        assert.ok(++passes <= 8, '真实测量队列必须取得进展')
        const callbacks = frames.splice(0); for (const callback of callbacks) callback(0)
        await nextTick(); await turn()
      }
    } }
}

function elevenAlbumPort(): Partial<CatalogDataPort> {
  return { search: async (source, kind) => source === 'local' && kind === 'albums'
    ? page(Array.from({ length: 11 }, (_, index) => localAlbumItem({ ...album, id: index === 6 ? album.id : `return-wall-${index}` }))) : empty() }
}

test('4.1 返回等待三列真实墙几何提交，默认四列 scrollHeight 不截断原位置', async t => {
  const f = fixture(t, { port: elevenAlbumPort() })
  f.journey.navigate('search', false); await f.catalog.search('周杰伦'); f.catalog.selectSource('local'); f.catalog.category.value = 'albums'
  f.scroll.scrollTop = 716; await f.navigation.open(album); f.scroll.scrollTop = 0
  const wall = returnedWall(t, f)
  let completed = false
  const returning = f.navigation.back().then(() => { completed = true }); await turn()
  assert.equal(wall.grid().attrs.value['data-grid-columns'], 4); assert.equal(wall.height(), 896)
  assert.equal(completed, false); assert.ok(!f.scrolls.includes(716), '尚未测量时写入716只会被旧高度截断到496')
  await wall.frame(); await returning
  assert.equal(wall.grid().attrs.value['data-grid-columns'], 3); assert.equal(wall.grid().attrs.value['data-grid-measured'], 'true')
  assert.equal(wall.height(), 1288); assert.equal(f.scroll.scrollTop, 716)
  assert.equal(200 + 2 * 329 - f.scroll.scrollTop, 142, '同一专辑在真实三列墙中回到原视口坐标')
})

for (const invalidation of ['leave', 'source', 'category', 'query', 'epoch', 'dispose'] as const)
  test(`4.1 ${invalidation} 后迟到三列测量不能恢复旧搜索滚动`, async t => {
    const f = fixture(t, { port: elevenAlbumPort() })
    f.journey.navigate('search', false); await f.catalog.search('周杰伦'); f.catalog.selectSource('local'); f.catalog.category.value = 'albums'
    f.scroll.scrollTop = 716; await f.navigation.open(album); f.scroll.scrollTop = 0
    const wall = returnedWall(t, f), returning = f.navigation.back(); await turn()
    assert.ok(!f.scrolls.includes(716))
    if (invalidation === 'leave') f.journey.navigate('home', false)
    else if (invalidation === 'source') f.catalog.selectSource('roon')
    else if (invalidation === 'category') f.catalog.category.value = 'tracks'
    else if (invalidation === 'query') await f.catalog.search('另一查询')
    else if (invalidation === 'epoch') f.catalog.invalidateSource('local')
    else f.navigation.dispose()
    f.scroll.scrollTop = 74
    if (invalidation === 'leave' || invalidation === 'dispose') await returning
    await wall.frame(); await returning
    assert.ok(!f.scrolls.includes(716)); assert.equal(f.scroll.scrollTop, 74)
    assert.equal(f.journey.currentView.value, invalidation === 'leave' ? 'home' : 'search')
  })

test('4.1 搜索本地专辑返回原关键词、来源、分类与滚动，复用已加载结果', async t => {
  const f = fixture(t)
  f.journey.navigate('search', false); await f.catalog.search('周杰伦')
  f.catalog.selectSource('local'); f.catalog.category.value = 'albums'; f.scroll.scrollTop = 1380
  const items = f.catalog.searchSections.local.albums.items
  await f.navigation.open(album)
  assert.equal(f.journey.currentView.value, 'local-library'); assert.equal(f.browser.selectedAlbum.value?.id, album.id)
  assert.equal(f.navigation.backLabel.value, '返回搜索结果'); assert.equal(f.selectedAlbumView(), 1)
  f.scroll.scrollTop = 0
  await f.navigation.back()
  assert.equal(f.journey.currentView.value, 'search'); assert.deepEqual(f.journey.sidebar.activeSource.value, { type: 'home' })
  assert.equal(f.catalog.query.value, '周杰伦'); assert.equal(f.catalog.draft.value, '周杰伦')
  assert.equal(f.catalog.sourceFilter.value, 'local'); assert.equal(f.catalog.category.value, 'albums')
  assert.equal(f.catalog.searchSections.local.albums.items, items); assert.equal(f.scroll.scrollTop, 1380)
  assert.equal(f.searches.filter(read => read.source === 'local' && read.kind === 'albums').length, 1)
  assert.equal(f.browser.selectedAlbum.value, null); assert.equal(f.navigation.backLabel.value, undefined)
})

test('4.1 本地艺术家内打开专辑后返回同一详情分页、资料和位置', async t => {
  const second = localAlbumItem({ ...album, id: 'catalog-return-album-two', title: '十一月的萧邦' }), reads: string[] = []
  const f = fixture(t, { port: {
    artist: async () => { reads.push('profile'); return { artist, biography: '合成人物资料' } },
    artistAlbums: async (_id, relation, window) => { reads.push(`${relation}:${window.offset}`); return relation === 'appearsOn' ? empty() : page([window.offset ? second : localAlbumItem(album)], window.offset, !window.offset) },
  } })
  f.journey.navigateSource({ type: 'roon-artists' }); await f.catalog.loadArtists('周')
  await f.catalog.openDetail(localArtistItem(artist)); await f.catalog.readDetailSection('albums', true)
  const selected = f.catalog.detail.value, albumItems = selected!.albums.items, nextOffset = selected!.albums.nextOffset
  const previousReads = [...reads]; f.scroll.scrollTop = 916
  await f.navigation.open(album)
  assert.equal(f.catalog.detail.value, null, '真实离页协议关闭当前详情')
  assert.equal(f.navigation.backLabel.value, '返回周杰伦')
  await f.navigation.back()
  assert.equal(f.journey.currentView.value, 'roon-artists'); assert.deepEqual(f.journey.sidebar.activeSource.value, { type: 'roon-artists' })
  assert.equal(f.catalog.artistQuery.value, '周'); assert.equal(f.catalog.artistSource.value, 'local')
  assert.equal(f.catalog.detail.value, selected); assert.equal(f.catalog.detail.value!.albums.items, albumItems)
  assert.equal(f.catalog.detail.value!.albums.nextOffset, nextOffset); assert.equal(f.catalog.detail.value!.profile?.biography, '合成人物资料')
  assert.deepEqual(reads, previousReads); assert.equal(f.scroll.scrollTop, 916)
})

test('4.1 返回仅恢复未完成分区，离页前旧回包不能覆盖新读取', async t => {
  const old = deferred<CatalogPage>(), resumed = deferred<CatalogPage>(); let trackReads = 0, profileReads = 0, albumReads = 0
  const f = fixture(t, { port: { artist: async () => { profileReads++; return { artist } },
    artistAlbums: async () => { albumReads++; return page([localAlbumItem(album)]) }, artistTracks: () => ++trackReads === 1 ? old.promise : resumed.promise } })
  f.journey.navigate('search', false); await f.catalog.search('周杰伦')
  const opening = f.catalog.openDetail(localArtistItem(artist)); await turn()
  const selected = f.catalog.detail.value; assert.equal(selected?.tracks.loading, true)
  await f.navigation.open(album); await opening; await f.navigation.back(); await turn()
  assert.equal(f.catalog.detail.value, selected); assert.equal(trackReads, 2); assert.equal(profileReads, 1); assert.equal(albumReads, 2)
  old.resolve(page([track('旧回包', 2)])); await turn()
  assert.equal(f.catalog.detail.value!.tracks.items.length, 0); assert.equal(f.catalog.detail.value!.tracks.loading, true)
  resumed.resolve(page([track('新回包', 3)])); await turn()
  assert.deepEqual(f.catalog.detail.value!.tracks.items.map(item => item.title), ['新回包'])
  assert.equal(f.catalog.detail.value!.tracks.loading, false); assert.equal(f.journey.currentView.value, 'search')
})

test('4.1 来源失效后返回父列表，不能借快照复活旧艺术家详情', async t => {
  const f = fixture(t)
  f.journey.navigate('search', false); await f.catalog.search('周杰伦'); f.catalog.selectSource('local')
  await f.catalog.openDetail(localArtistItem(artist)); await f.navigation.open(album)
  f.catalog.invalidateSource('local'); await f.navigation.back()
  assert.equal(f.journey.currentView.value, 'search'); assert.equal(f.catalog.detail.value, null)
  assert.equal(f.catalog.searchSections.local.albums.items.length, 0)
  assert.match(f.catalog.searchSections.local.albums.error, /来源已变化/u)
})

test('4.1 原本地库返回仍只关闭专辑，保留库内搜索、筛选和位置', async t => {
  const f = fixture(t)
  f.journey.navigate('local-library', false); await f.browser.activate()
  await f.browser.setScope({ query: '周杰伦', rootId: album.rootId, filter: 'missing-artwork' })
  await f.browser.openAlbum(album, { scrollTop: 613 }); await f.navigation.back()
  assert.equal(f.journey.currentView.value, 'local-library'); assert.equal(f.browser.selectedAlbum.value, null)
  assert.equal(f.browser.query.value, '周杰伦'); assert.equal(f.browser.rootId.value, album.rootId)
  assert.equal(f.browser.filter.value, 'missing-artwork'); assert.equal(f.browser.scrollTop.value, 613)
})

test('4.1 激活等待中离开再回库，旧 await 不能打开原专辑或留下返回路径', async t => {
  const pending = deferred<LocalAlbumPage>(); let request!: LocalAlbumQuery
  const f = fixture(t, { albumApi: { queryAlbums: value => { request = value; return pending.promise } } })
  f.journey.navigate('search', false); await f.catalog.search('周杰伦')
  const opening = f.navigation.open(album); await turn(); assert.ok(request)
  f.journey.navigate('home', false); f.journey.navigate('local-library', false)
  pending.resolve(albumPage(request)); await opening
  assert.equal(f.journey.currentView.value, 'local-library'); assert.equal(f.albumReads.length, 0)
  assert.equal(f.browser.selectedAlbum.value, null); assert.equal(f.navigation.backLabel.value, undefined)
})

test('4.1 专辑详情回包迟到不能选中专辑，也不能把侧栏离开后的页面拉回', async t => {
  const pending = deferred<LocalAlbumTrackPage>(); let request!: LocalAlbumTrackQuery
  const f = fixture(t, { albumApi: { queryAlbumTracks: value => { request = value; return pending.promise } } })
  f.journey.navigate('search', false); await f.catalog.search('周杰伦')
  const opening = f.navigation.open(album); await turn(); assert.ok(request)
  f.journey.navigateSource({ type: 'home' }); pending.resolve(trackPage(request)); await opening
  assert.equal(f.journey.currentView.value, 'home'); assert.equal(f.browser.selectedAlbum.value, null)
  assert.equal(f.navigation.backLabel.value, undefined)
})

test('4.1 返回等待渲染时新导航或销毁使旧滚动恢复失效', async t => {
  for (const invalidate of ['navigate', 'dispose'] as const) {
    const render = deferred<void>(); let renders = 0
    const f = fixture(t, { afterRender: () => ++renders === 1 ? Promise.resolve() : render.promise })
    f.journey.navigate('search', false); await f.catalog.search('周杰伦'); f.scroll.scrollTop = 1380
    await f.navigation.open(album); const returning = f.navigation.back()
    if (invalidate === 'navigate') { f.journey.navigate('home', false); f.journey.navigate('search', false) }
    else f.navigation.dispose()
    f.scroll.scrollTop = 74; render.resolve(); await returning
    assert.equal(f.scroll.scrollTop, 74); assert.ok(!f.scrolls.includes(1380))
    assert.equal(f.navigation.backLabel.value, undefined)
  }
})
