import { computed, ref } from 'vue'
import { cacheIdentity, type PageCacheOwnerOptions } from '../libraryPageCache.js'
import { createLibraryReadScope, isLibraryReadCancelled } from '../libraryReadScope.js'
import type {
  AlbumSummary, ArtistSummary, MatchState, Page, PageRequest,
  PublicTrackMatchResult, RoonLibraryPage, TrackSummary,
} from '@music-bridge/contracts'
import type { MusicBridgePublicApi } from '../../../../preload/api.js'
import { appendPage } from '../libraryPagination.js'
import { appendRoonPage, emptyRoonPage, nextRoonPageOffset, readRoonDatasetPage, RoonPageEpochChanged } from '../roonLibraryPagination.js'
import { createSearchSnapshotLoader } from '../search.js'
import {
  SMART_MATCH_REQUEST_CONCURRENCY, createMatchRequestScheduler,
  settledMapWithConcurrency, shouldPreloadSmartMatches, trackSummaryForMatching,
  tracksForInitialMatching,
} from '../playbackMatching.js'

const LIBRARY_PAGE_SIZE = 20
const SEARCH_DEBOUNCE_MS = 250
export type SearchErrorKind = 'auth-required' | 'auth-expired' | 'generic'

function emptyPage<T>(limit = LIBRARY_PAGE_SIZE): Page<T> {
  return { items: [], offset: 0, limit, total: 0, hasMore: false }
}

function searchSectionErrorKind(message: string): SearchErrorKind {
  if (message.includes('请先登录')) return 'auth-required'
  if (message.includes('登录已过期')) return 'auth-expired'
  return 'generic'
}

export interface AggregatedSearchOptions extends PageCacheOwnerOptions {
  getProviderAuthorized?: () => boolean
  api: MusicBridgePublicApi
  getZoneId: () => string | undefined
  getScrollTop: () => number
  scrollTo: (top: number) => void
  classifyError: (error: unknown) => SearchErrorKind
  onResetSearchOrigin: () => void
  onInvalidateRoonDetails: () => void
}

export function useAggregatedSearch(options: AggregatedSearchOptions) {
  const { api, getZoneId, getScrollTop, scrollTo, classifyError,
    onResetSearchOrigin, onInvalidateRoonDetails } = options
  let disposed = false, roonScopeEpoch = 0, neteaseScopeEpoch = 0
  const roonRebases = { album: 0, artist: 0 }
  const searchReads = createLibraryReadScope(api), roonReads = createLibraryReadScope(api)
  const detailReads = createLibraryReadScope(api), matchReads = createLibraryReadScope(api)
  let lastPage: PageRequest = { offset: 0, limit: LIBRARY_PAGE_SIZE }
  let pendingResume: PageRequest | undefined
  let roonQueryPending = false, roonResume = false
  const pendingEntities = new Map<string, { source: 'roon' | 'netease'; kind: 'album' | 'artist' }>()
  let detailResume = false, accountResume = false
  let searchDetailScope: string | undefined
  const searchQuery = ref('')
  const searchCategory = ref<'all' | 'tracks' | 'albums' | 'artists'>('all')
  const searchSongsOpen = computed({
    get: () => searchCategory.value === 'tracks',
    set: (value: boolean) => { searchCategory.value = value ? 'tracks' : 'all' },
  })
  function selectSearchCategory(category: 'all' | 'tracks' | 'albums' | 'artists'): void {
    searchCategory.value = category
    scrollTo(0)
  }
  const searchSongScrollTop = ref(0)
  const roonSearchAlbums = ref<RoonLibraryPage>(emptyRoonPage(8))
  const roonSearchArtists = ref<RoonLibraryPage>(emptyRoonPage(6))
  const roonAlbumsLoading = ref(false), roonArtistsLoading = ref(false)
  const roonAlbumsError = ref<string | null>(null), roonArtistsError = ref<string | null>(null)
  const roonSearchLoading = computed(() => roonAlbumsLoading.value || roonArtistsLoading.value)
  const roonSearchError = computed(() => roonAlbumsError.value ?? roonArtistsError.value)
  const roonSectionOperations = { album: 0, artist: 0 }
  const refreshErrors = ref<Partial<Record<'tracks' | 'artists' | 'albums' | 'roon-albums' | 'roon-artists', string>>>({})
  let publishedQuery = ''
  const cacheScope = (source: 'roon' | 'netease') => JSON.stringify([options.getCacheScope?.() ?? '', source, source === 'roon' ? roonScopeEpoch : neteaseScopeEpoch, getZoneId() ?? null, source === 'netease' ? options.getProviderAuthorized?.() ?? true : true])
  const searchPage = ref<Page<TrackSummary>>(emptyPage())
  const searchArtistsPage = ref<Page<ArtistSummary>>(emptyPage(6))
  const searchAlbumsPage = ref<Page<AlbumSummary>>(emptyPage(8))
  const searchArtistsState = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const searchAlbumsState = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const searchArtistsError = ref<string | null>(null)
  const searchAlbumsError = ref<string | null>(null)
  const searchDetail = ref<{
    kind: 'artist' | 'album'; id: string; title: string; subtitle: string
    tracks: Page<TrackSummary>; loading: boolean; error: string | null
  } | null>(null)
  const searchDetailLoadingMore = ref(false)
  const searchDetailMoreError = ref<string | null>(null)
  const searchScrollTop = ref(0)
  const matchStates = ref<Record<string, MatchState>>({})
  const matchResults = ref<Record<string, PublicTrackMatchResult>>({})
  const pendingMatchRequests = new Map<string, Promise<PublicTrackMatchResult>>()
  const matchRequestScheduler = createMatchRequestScheduler(
    (track: TrackSummary) => matchReads.read('library.match', { track }, () => api.matchLibraryTrack(track)),
    SMART_MATCH_REQUEST_CONCURRENCY,
  )
  async function snapshotRead<T>(operation: Promise<T>): Promise<T> {
    try { return await operation }
    catch (error) {
      // 旧分区汇总会格式化错误；保留取消标记，避免 Electron 前缀将其变成普通失败。
      if (isLibraryReadCancelled(error)) throw new Error('[CANCELLED] 本次搜索读取已取消。')
      throw error
    }
  }
  const newSnapshotLoader = () => createSearchSnapshotLoader({
    artists: (query, page, readOptions) => snapshotRead(searchReads.read('library.searchArtists', { query, page }, () => api.searchArtists(query, page), readOptions?.reload ? { cacheMode: 'reload' } : undefined)),
    tracks: (query, page, readOptions) => snapshotRead(searchReads.read('library.search', { query, page }, () => api.searchTracks(query, page), readOptions?.reload ? { cacheMode: 'reload' } : undefined)),
    albums: (query, page, readOptions) => snapshotRead(searchReads.read('library.searchAlbums', { query, page }, () => api.searchAlbums(query, page), readOptions?.reload ? { cacheMode: 'reload' } : undefined)),
  }, { cache: options.cache, getCacheScope: () => cacheScope('netease') })
  let searchSnapshotLoader = newSnapshotLoader()
  const searchInitialLoading = ref(false)
  const searchLoadingMore = ref(false)
  const searchLoadMoreError = ref<string | null>(null)
  const searchError = ref<SearchErrorKind | null>(null)
  let searchTimer: ReturnType<typeof setTimeout> | undefined
  let searchRequestGeneration = 0
  let searchDetailGeneration = 0
  let matchGeneration = 0

  function stopSearchTimer(): void {
    if (searchTimer !== undefined) {
      clearTimeout(searchTimer)
      searchTimer = undefined
    }
  }

  function resetSearchSections(): void {
    roonRebases.album = 0; roonRebases.artist = 0
    searchRequestGeneration += 1
    searchReads.cancelAll(); roonReads.cancelAll(); detailReads.cancelAll()
    pendingResume = undefined; detailResume = false; accountResume = false
    roonQueryPending = false; roonResume = false; pendingEntities.clear()
    searchDetailLoadingMore.value = false
    onInvalidateRoonDetails()
    searchSongsOpen.value = false
    onResetSearchOrigin()
    roonSearchAlbums.value = emptyRoonPage(8)
    roonSearchArtists.value = emptyRoonPage(6)
    roonAlbumsLoading.value = false; roonArtistsLoading.value = false
    roonAlbumsError.value = null; roonArtistsError.value = null
    searchSnapshotLoader.cancel()
    searchDetailGeneration += 1
    searchArtistsPage.value = emptyPage(6)
    searchAlbumsPage.value = emptyPage(8)
    searchArtistsState.value = 'idle'
    searchAlbumsState.value = 'idle'
    searchArtistsError.value = null
    searchAlbumsError.value = null
    searchDetail.value = null
  }


  async function loadSearch(query: string, page: PageRequest, generation: number, includeRoon = true, reload = false): Promise<void> {
    if (disposed) return
    const epoch = neteaseScopeEpoch, scope = cacheScope('netease')
    lastPage = { ...page }
    const initial = page.offset === 0
    if (initial) {
      searchInitialLoading.value = true
      searchLoadMoreError.value = null
      searchArtistsState.value = 'loading'
      searchAlbumsState.value = 'loading'
      searchArtistsError.value = null
      searchAlbumsError.value = null
      if (includeRoon) void loadRoonSearch(query, generation, reload)
    } else {
      if (searchLoadingMore.value) return
      searchLoadingMore.value = true
      searchLoadMoreError.value = null
    }
    try {
      if (initial) {
        await searchSnapshotLoader.load(query, { reload, onSection: publication => {
          if (disposed || generation !== searchRequestGeneration || epoch !== neteaseScopeEpoch || scope !== cacheScope('netease') || publication.query !== searchQuery.value.trim()) return
          const section = publication.section, result = publication.result
          if (section === 'tracks') {
            searchInitialLoading.value = false
            if (publication.result.state === 'ready') {
              searchPage.value = publication.result.page; searchError.value = null
              delete refreshErrors.value.tracks
              void matchTracks(searchPage.value.items)
            } else if (!isLibraryReadCancelled({ message: publication.result.message })) {
              if (searchPage.value.items.length) refreshErrors.value.tracks = publication.result.message
              else searchError.value = searchSectionErrorKind(publication.result.message)
            }
          } else {
            const state = section === 'artists' ? searchArtistsState : searchAlbumsState
            const error = section === 'artists' ? searchArtistsError : searchAlbumsError
            if (result.state === 'ready') {
              if (publication.section === 'artists' && publication.result.state === 'ready') searchArtistsPage.value = publication.result.page
              if (publication.section === 'albums' && publication.result.state === 'ready') searchAlbumsPage.value = publication.result.page
              state.value = 'ready'; error.value = null; delete refreshErrors.value[section]
            } else if (isLibraryReadCancelled({ message: result.message })) state.value = (section === 'artists' ? searchArtistsPage.value : searchAlbumsPage.value).items.length ? 'ready' : 'idle'
            else {
              const hasItems = (section === 'artists' ? searchArtistsPage.value : searchAlbumsPage.value).items.length > 0
              state.value = hasItems ? 'ready' : 'error'
              if (hasItems) refreshErrors.value[section] = result.message
              else error.value = result.message
            }
          }
        } })
      } else {
        const result = await searchReads.read('library.search', { query, page }, () => api.searchTracks(query, page))
        if (generation !== searchRequestGeneration || epoch !== neteaseScopeEpoch || scope !== cacheScope('netease')) return
        searchPage.value = appendPage(searchPage.value, result)
        void matchTracks(result.items)
        searchError.value = null
        searchLoadingMore.value = false
      }
    } catch (error) {
      if (generation !== searchRequestGeneration || epoch !== neteaseScopeEpoch || scope !== cacheScope('netease')) return
      if (isLibraryReadCancelled(error)) { searchInitialLoading.value = false; searchLoadingMore.value = false; return }
      if (initial) {
        searchInitialLoading.value = false
        searchError.value = classifyError(error)
        searchArtistsState.value = 'error'
        searchAlbumsState.value = 'error'
        searchArtistsError.value = '搜索艺人暂时不可用。'
        searchAlbumsError.value = '搜索专辑暂时不可用。'
      } else {
        searchLoadingMore.value = false
        searchLoadMoreError.value = '加载失败，点击重试'
      }
    }
  }

  async function loadRoonSearch(query: string, generation: number, reload = false): Promise<void> {
    if (disposed) return
    const epoch = roonScopeEpoch, scope = cacheScope('roon')
    roonQueryPending = true; roonResume = false
    await Promise.all((['album', 'artist'] as const).map(async kind => {
      const operation = ++roonSectionOperations[kind]
      const target = kind === 'album' ? roonSearchAlbums : roonSearchArtists
      const loading = kind === 'album' ? roonAlbumsLoading : roonArtistsLoading, errorState = kind === 'album' ? roonAlbumsError : roonArtistsError
      const section = kind === 'album' ? 'roon-albums' : 'roon-artists'
      const request = { offset: 0, limit: kind === 'album' ? 8 : 6 }, dataset = JSON.stringify(['search', query, kind])
      const identity = cacheIdentity(scope, dataset, request), cached = options.cache?.peek<RoonLibraryPage>(identity)
      const current = () => !disposed && generation === searchRequestGeneration && epoch === roonScopeEpoch && operation === roonSectionOperations[kind] && scope === cacheScope('roon') && query === searchQuery.value.trim()
      loading.value = true; errorState.value = null
      if (cached) target.value = cached.value
      if (cached && !cached.stale && !reload) { loading.value = false; return }
      try {
        const result = await roonReads.read('roon.library.search', { query, page: request, kind }, () => api.searchRoonLibrary(query, request, kind), reload || cached?.stale ? { cacheMode: 'reload' } : undefined)
        if (!current()) return
        options.cache?.put(identity, result); target.value = result; delete refreshErrors.value[section]
      } catch (error) {
        if (!current() || isLibraryReadCancelled(error)) return
        if (target.value.items.length) refreshErrors.value[section] = '刷新 Roon 搜索失败，保留已加载内容。'
        else errorState.value = '部分 Roon 搜索结果暂时不可用，请检查 Roon 连接后重新搜索。'
      } finally { if (current()) loading.value = false }
    }))
    if (generation === searchRequestGeneration && epoch === roonScopeEpoch) roonQueryPending = false
  }

  async function loadMoreSearchEntities(source: 'roon' | 'netease', kind: 'album' | 'artist'): Promise<void> {
    if (disposed) return
    const generation = searchRequestGeneration, epoch = roonScopeEpoch, netEpoch = neteaseScopeEpoch
    const query = searchQuery.value.trim(), scope = cacheScope(source)
    const current = () => !disposed && generation === searchRequestGeneration && (source === 'roon' ? epoch === roonScopeEpoch : netEpoch === neteaseScopeEpoch) && scope === cacheScope(source) && query === searchQuery.value.trim()
    const isAlbum = kind === 'album'
    const key = `${source}:${kind}`
    if (source === 'roon') {
      const loading = isAlbum ? roonAlbumsLoading : roonArtistsLoading, errorState = isAlbum ? roonAlbumsError : roonArtistsError
      if (loading.value) return
      const target = isAlbum ? roonSearchAlbums : roonSearchArtists
      if (!target.value.hasMore) return
      pendingEntities.set(key, { source, kind })
      loading.value = true
      try {
        const request = { offset: nextRoonPageOffset(target.value), limit: target.value.limit }
        const result = await readRoonDatasetPage(target.value, request,
          page => roonReads.read('roon.library.search', { query, page, kind }, () => api.searchRoonLibrary(query, page, kind)),
          current,
          roonRebases[kind] === 0 ? () => { roonRebases[kind]++ } : undefined)
        if (!result || !current()) return
        pendingEntities.delete(key)
        target.value = result.restarted ? result.page : appendRoonPage(target.value, result.page)
        errorState.value = null
      } catch (error) {
        if (current() && !isLibraryReadCancelled(error)) {
          pendingEntities.delete(key)
          errorState.value = error instanceof RoonPageEpochChanged ? '读取上下文反复变化，请重新读取。' : '加载更多 Roon 结果失败，请重试。'
        }
      } finally {
        if (current()) loading.value = false
      }
      return
    }
    const state = isAlbum ? searchAlbumsState : searchArtistsState
    if (state.value === 'loading' || !(isAlbum ? searchAlbumsPage.value : searchArtistsPage.value).hasMore) return
    pendingEntities.set(key, { source, kind })
    state.value = 'loading'
    try {
      if (isAlbum) {
        const request = { offset: searchAlbumsPage.value.offset + searchAlbumsPage.value.limit, limit: 8 }
        const page = await searchReads.read('library.searchAlbums', { query, page: request }, () => api.searchAlbums(query, request))
        if (!current()) return
        searchAlbumsPage.value = appendPage(searchAlbumsPage.value, page)
        searchAlbumsError.value = null
      } else {
        const request = { offset: searchArtistsPage.value.offset + searchArtistsPage.value.limit, limit: 6 }
        const page = await searchReads.read('library.searchArtists', { query, page: request }, () => api.searchArtists(query, request))
        if (!current()) return
        searchArtistsPage.value = appendPage(searchArtistsPage.value, page)
        searchArtistsError.value = null
      }
      pendingEntities.delete(key)
      state.value = 'ready'
    } catch (error) {
      if (!current()) return
      if (isLibraryReadCancelled(error)) { state.value = 'ready'; return }
      pendingEntities.delete(key)
      state.value = 'error'
      if (isAlbum) searchAlbumsError.value = '加载更多专辑失败，请重试。'
      else searchArtistsError.value = '加载更多艺人失败，请重试。'
    }
  }

  function openSearchSongs(): void {
    searchScrollTop.value = getScrollTop()
    searchSongsOpen.value = true
    scrollTo(0)
  }


  function cancelPendingMatches(): void {
    matchReads.cancelAll()
    matchRequestScheduler.cancelPending()
    pendingMatchRequests.clear()
  }

  function requestLibraryMatch(track: TrackSummary): Promise<PublicTrackMatchResult> {
    const existing = pendingMatchRequests.get(track.id)
    if (existing) return existing
    const request = matchRequestScheduler.schedule(trackSummaryForMatching(track))
    pendingMatchRequests.set(track.id, request)
    return request
  }

  async function matchTracks(
    tracks: readonly TrackSummary[],
    visible = true,
  ): Promise<void> {
    if (disposed || !shouldPreloadSmartMatches(getZoneId(), visible)) return
    const generation = matchGeneration
    const boundedTracks = tracksForInitialMatching(tracks)
    const results = await settledMapWithConcurrency(
      boundedTracks,
      3,
      (track) => generation === matchGeneration
        ? requestLibraryMatch(track)
        : Promise.reject(new Error('Smart matching batch was superseded')),
    )
    if (generation !== matchGeneration) return
    const next = { ...matchStates.value }
    const nextResults = { ...matchResults.value }
    results.forEach((result, index) => {
      const track = boundedTracks[index]
      if (track) pendingMatchRequests.delete(track.id)
      if (result.status !== 'fulfilled') return
      if (track) {
        next[track.id] = result.value.state
        nextResults[track.id] = result.value
      }
    })
    matchStates.value = next
    matchResults.value = nextResults
  }

  function scheduleSearch(): void {
    if (disposed) return
    stopSearchTimer()
    const sameQuery = publishedQuery === searchQuery.value.trim() && !!publishedQuery
    if (sameQuery) { searchRequestGeneration++; searchReads.cancelAll(); roonReads.cancelAll(); detailReads.cancelAll(); searchDetailGeneration++; searchSnapshotLoader.cancel() }
    else { resetSearchSections(); refreshErrors.value = {} }
    searchSnapshotLoader.cancel()
    const generation = ++searchRequestGeneration
    searchError.value = null
    searchLoadMoreError.value = null
    if (!sameQuery) {
      searchPage.value = emptyPage(); searchArtistsPage.value = emptyPage(6); searchAlbumsPage.value = emptyPage(8)
      searchArtistsState.value = 'idle'; searchAlbumsState.value = 'idle'
      searchArtistsError.value = null; searchAlbumsError.value = null
    }
    searchDetail.value = null
    if (!sameQuery) {
      matchStates.value = {}; matchResults.value = {}; cancelPendingMatches(); matchGeneration += 1
    }
    searchInitialLoading.value = false
    searchLoadingMore.value = false
    const query = searchQuery.value.trim()
    publishedQuery = query
    if (query.length === 0) {
      searchPage.value = emptyPage()
      return
    }
    searchTimer = setTimeout(() => {
      searchTimer = undefined
      void loadSearch(query, { offset: 0, limit: LIBRARY_PAGE_SIZE }, generation, true, sameQuery)
    }, SEARCH_DEBOUNCE_MS)
  }


  function searchPageAt(offset: number): void {
    if (disposed) return
    const query = searchQuery.value.trim()
    if (!query) return
    stopSearchTimer()
    void loadSearch(query, { offset, limit: LIBRARY_PAGE_SIZE }, searchRequestGeneration)
  }

  async function openSearchDetail(kind: 'artist' | 'album', id: string, title: string, subtitle: string, reload = false): Promise<void> {
    if (!reload) searchScrollTop.value = getScrollTop()
    if (disposed) return
    const scope = cacheScope('netease'), previous = searchDetail.value
    const retained = reload && previous?.kind === kind && previous.id === id && searchDetailScope === scope && previous.tracks.items.length ? previous : undefined
    searchDetailScope = scope
    const operation = ++searchDetailGeneration
    detailReads.cancelAll()
    detailResume = false
    searchDetailLoadingMore.value = false
    searchDetailMoreError.value = null
    searchDetail.value = retained ? { ...retained, loading: true, error: null } : {
      kind, id, title, subtitle, tracks: emptyPage(), loading: true, error: null,
    }
    const request = { offset: 0, limit: LIBRARY_PAGE_SIZE }
    const identity = cacheIdentity(scope, JSON.stringify(['detail', kind, id]), request)
    type DetailView = NonNullable<typeof searchDetail.value>
    const cached = options.cache?.peek<DetailView>(identity)
    const current = () => !disposed && operation === searchDetailGeneration && scope === cacheScope('netease') && searchDetail.value?.id === id && searchDetail.value.kind === kind
    if (cached && !retained) searchDetail.value = { ...cached.value, loading: reload || cached.stale, error: null }
    try {
      if (cached && !cached.stale && !reload) return
      const result = kind === 'artist'
        ? await detailReads.read('library.artist', { artistId: id, page: request }, () => api.getArtist(id, request), reload || cached?.stale ? { cacheMode: 'reload' } : undefined)
        : await detailReads.read('library.album', { albumId: id, page: request }, () => api.getAlbum(id, request), reload || cached?.stale ? { cacheMode: 'reload' } : undefined)
      if (!current()) return
      const subtitle = 'artistName' in result ? `${result.artistName} · ${result.trackCount ?? result.tracks.total} 首歌曲` : `${result.albumCount ?? 0} 张专辑 · ${result.trackCount ?? result.tracks.total} 首歌曲`
      const view: DetailView = { kind, id, title: result.name, subtitle, tracks: result.tracks, loading: false, error: null }
      searchDetail.value = view; options.cache?.put(identity, view)
    } catch (error) {
      if (!current()) return
      if (isLibraryReadCancelled(error)) { detailResume = true; searchDetail.value = { ...searchDetail.value!, loading: false }; return }
      if (searchDetail.value?.tracks.items.length) searchDetail.value = { ...searchDetail.value, loading: false, error: '刷新详情失败，保留已加载歌曲。' }
      else searchDetail.value = { kind, id, title, subtitle, tracks: emptyPage(), loading: false, error: '详情歌曲暂时不可用，请稍后重试。' }
    }
  }

  function retrySearchDetail(): Promise<void> {
    const detail = searchDetail.value
    if (!detail || detail.loading || disposed) return Promise.resolve()
    return openSearchDetail(detail.kind, detail.id, detail.title, detail.subtitle, true)
  }

  async function loadMoreSearchDetail(): Promise<void> {
    const detail = searchDetail.value
    if (disposed || !detail || detail.loading || searchDetailLoadingMore.value) return
    const generation = searchDetailGeneration, scope = cacheScope('netease')
    const current = () => !disposed && generation === searchDetailGeneration && scope === cacheScope('netease') && searchDetail.value?.id === detail.id && searchDetail.value.kind === detail.kind
    searchDetailLoadingMore.value = true
    searchDetailMoreError.value = null
    try {
      const request = { offset: detail.tracks.offset + detail.tracks.limit, limit: detail.tracks.limit }
      const result = detail.kind === 'artist'
        ? await detailReads.read('library.artist', { artistId: detail.id, page: request }, () => api.getArtist(detail.id, request))
        : await detailReads.read('library.album', { albumId: detail.id, page: request }, () => api.getAlbum(detail.id, request))
      if (current() && searchDetail.value) searchDetail.value = { ...searchDetail.value, tracks: appendPage(searchDetail.value.tracks, result.tracks) }
    } catch (error) {
      if (current()) {
        if (isLibraryReadCancelled(error)) detailResume = true
        else searchDetailMoreError.value = '加载更多歌曲失败，请重试。'
      }
    } finally {
      if (current()) searchDetailLoadingMore.value = false
    }
  }

  function closeSearchDetail(): void {
    searchDetailGeneration += 1
    detailReads.cancelAll()
    searchDetailLoadingMore.value = false
    detailResume = false
    searchDetail.value = null
    scrollTo(searchScrollTop.value)
  }


  function resetSearch(): void {
    refreshErrors.value = {}; publishedQuery = ''
    searchQuery.value = ''
    stopSearchTimer()
    resetSearchSections()
    searchRequestGeneration += 1
    searchPage.value = emptyPage()
    matchStates.value = {}
    matchResults.value = {}
    cancelPendingMatches()
    matchGeneration += 1
    searchInitialLoading.value = false
    searchLoadingMore.value = false
    searchLoadMoreError.value = null
    searchError.value = null
  }

  function resetMatches(): void {
    matchGeneration += 1
    matchStates.value = {}
    matchResults.value = {}
    cancelPendingMatches()
  }

  function suspend(): void {
    if (searchTimer !== undefined || searchInitialLoading.value || searchLoadingMore.value) pendingResume = searchTimer !== undefined ? { offset: 0, limit: LIBRARY_PAGE_SIZE } : { ...lastPage }
    roonResume = roonResume || roonQueryPending || searchTimer !== undefined
    roonQueryPending = false
    detailResume = detailResume || !!searchDetail.value?.loading || searchDetailLoadingMore.value
    stopSearchTimer()
    searchRequestGeneration += 1; searchDetailGeneration += 1; matchGeneration += 1
    searchSnapshotLoader.cancel()
    searchReads.cancelAll(); roonReads.cancelAll(); detailReads.cancelAll(); cancelPendingMatches()
    searchInitialLoading.value = false; searchLoadingMore.value = false; roonAlbumsLoading.value = false; roonArtistsLoading.value = false
    searchDetailLoadingMore.value = false
    if (searchDetail.value?.loading) searchDetail.value = { ...searchDetail.value, loading: false }
    if (searchArtistsState.value === 'loading') searchArtistsState.value = searchArtistsPage.value.items.length ? 'ready' : 'idle'
    if (searchAlbumsState.value === 'loading') searchAlbumsState.value = searchAlbumsPage.value.items.length ? 'ready' : 'idle'
  }

  function resume(): void {
    if (disposed) return
    const generation = searchRequestGeneration
    const resumeEntities = (source: 'roon' | 'netease') => {
      if (disposed || generation !== searchRequestGeneration) return
      for (const request of [...pendingEntities.values()]) if (request.source === source) void loadMoreSearchEntities(request.source, request.kind)
    }
    let neteasePending: Promise<void> | undefined
    if (pendingResume && searchQuery.value.trim()) {
      const page = pendingResume; pendingResume = undefined
      accountResume = false
      neteasePending = loadSearch(searchQuery.value.trim(), page, generation, false)
    } else if (accountResume && searchQuery.value.trim()) {
      accountResume = false
      neteasePending = loadSearch(searchQuery.value.trim(), { offset: 0, limit: LIBRARY_PAGE_SIZE }, generation, false)
    }
    if (neteasePending) void neteasePending.then(() => resumeEntities('netease'))
    else resumeEntities('netease')
    if (roonResume && searchQuery.value.trim()) {
      roonResume = false
      void loadRoonSearch(searchQuery.value.trim(), generation).then(() => resumeEntities('roon'))
    } else resumeEntities('roon')
    if (detailResume && searchDetail.value) {
      const detail = searchDetail.value; detailResume = false
      if (!detail.tracks.items.length) void openSearchDetail(detail.kind, detail.id, detail.title, detail.subtitle)
      else void loadMoreSearchDetail()
    }
  }

  function invalidateScope(): void {
    refreshErrors.value = {}
    neteaseScopeEpoch += 1; roonScopeEpoch += 1
    suspend()
    searchSnapshotLoader = newSnapshotLoader()
    pendingEntities.clear()
    searchPage.value = emptyPage(); searchArtistsPage.value = emptyPage(6); searchAlbumsPage.value = emptyPage(8)
    searchArtistsState.value = 'idle'; searchAlbumsState.value = 'idle'
    roonSearchAlbums.value = emptyRoonPage(8); roonSearchArtists.value = emptyRoonPage(6)
    searchDetail.value = null; detailResume = false; accountResume = false
    searchError.value = null; searchArtistsError.value = null; searchAlbumsError.value = null; roonAlbumsError.value = null; roonArtistsError.value = null
    resetMatches()
    if (searchQuery.value.trim()) { pendingResume = { offset: 0, limit: LIBRARY_PAGE_SIZE }; roonResume = true }
  }

  function invalidateAccountScope(): void {
    delete refreshErrors.value.tracks; delete refreshErrors.value.artists; delete refreshErrors.value.albums
    neteaseScopeEpoch += 1
    searchSnapshotLoader.cancel()
    searchReads.cancelAll(); detailReads.cancelAll()
    searchDetailGeneration += 1
    for (const [key, request] of pendingEntities) if (request.source === 'netease') pendingEntities.delete(key)
    searchSnapshotLoader = newSnapshotLoader()
    searchPage.value = emptyPage(); searchArtistsPage.value = emptyPage(6); searchAlbumsPage.value = emptyPage(8)
    searchArtistsState.value = 'idle'; searchAlbumsState.value = 'idle'
    searchInitialLoading.value = false; searchLoadingMore.value = false
    searchError.value = null; searchArtistsError.value = null; searchAlbumsError.value = null
    searchDetail.value = null; searchDetailLoadingMore.value = false; detailResume = false
    resetMatches()
    // 尚在防抖中的查询会直接使用新账户；不要先派发再由原 timer 重放。
    accountResume = searchTimer === undefined && !!searchQuery.value.trim()
    if (pendingResume) pendingResume = { offset: 0, limit: LIBRARY_PAGE_SIZE }
  }

  function invalidateRoonScope(refresh = false): void {
    delete refreshErrors.value['roon-albums']; delete refreshErrors.value['roon-artists']
    roonScopeEpoch += 1
    roonQueryPending = false
    for (const [key, request] of pendingEntities) if (request.source === 'roon') pendingEntities.delete(key)
    roonReads.cancelAll()
    roonSearchAlbums.value = emptyRoonPage(8); roonSearchArtists.value = emptyRoonPage(6)
    roonAlbumsLoading.value = false; roonArtistsLoading.value = false; roonAlbumsError.value = null; roonArtistsError.value = null
    resetMatches()
    roonResume = searchTimer === undefined && !!searchQuery.value.trim()
    if (refresh && !disposed && searchTimer === undefined && !pendingResume && searchQuery.value.trim()) void loadRoonSearch(searchQuery.value.trim(), searchRequestGeneration)
  }

  function dispose(): void {
    disposed = true
    resetSearch()
    for (const scope of [searchReads, roonReads, detailReads, matchReads]) scope.dispose()
    searchDetailGeneration += 1
  }

  return {
    searchQuery, searchCategory, searchSongsOpen, searchSongScrollTop,
    roonSearchAlbums, roonSearchArtists, roonSearchLoading, roonSearchError, roonAlbumsLoading, roonArtistsLoading, roonAlbumsError, roonArtistsError, refreshErrors,
    searchPage, searchArtistsPage, searchAlbumsPage, searchArtistsState, searchAlbumsState,
    searchArtistsError, searchAlbumsError, searchDetail, searchDetailLoadingMore,
    searchDetailMoreError, searchScrollTop, searchInitialLoading, searchLoadingMore,
    searchLoadMoreError, searchError, matchStates, matchResults, pendingMatchRequests,
    selectSearchCategory, stopSearchTimer, resetSearchSections, resetSearch,
    resetMatches, cancelPendingMatches, matchTracks, scheduleSearch, searchPageAt,
    loadMoreSearchEntities, openSearchSongs, openSearchDetail, retrySearchDetail, loadMoreSearchDetail,
    closeSearchDetail, suspend, resume, invalidateScope, invalidateAccountScope, invalidateRoonScope, dispose,
  }
}
