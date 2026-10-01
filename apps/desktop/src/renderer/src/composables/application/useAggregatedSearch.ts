import { computed, ref } from 'vue'
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

export interface AggregatedSearchOptions {
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
  const roonSearchLoading = ref(false)
  const roonSearchError = ref<string | null>(null)
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
    artists: (query, page) => snapshotRead(searchReads.read('library.searchArtists', { query, page }, () => api.searchArtists(query, page))),
    tracks: (query, page) => snapshotRead(searchReads.read('library.search', { query, page }, () => api.searchTracks(query, page))),
    albums: (query, page) => snapshotRead(searchReads.read('library.searchAlbums', { query, page }, () => api.searchAlbums(query, page))),
  })
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
    roonSearchLoading.value = false
    roonSearchError.value = null
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


  async function loadSearch(query: string, page: PageRequest, generation: number, includeRoon = true): Promise<void> {
    if (disposed) return
    const epoch = neteaseScopeEpoch
    lastPage = { ...page }
    const initial = page.offset === 0
    if (initial) {
      searchInitialLoading.value = true
      searchLoadMoreError.value = null
      searchArtistsState.value = 'loading'
      searchAlbumsState.value = 'loading'
      searchArtistsError.value = null
      searchAlbumsError.value = null
      if (includeRoon) void loadRoonSearch(query, generation)
    } else {
      if (searchLoadingMore.value) return
      searchLoadingMore.value = true
      searchLoadMoreError.value = null
    }
    try {
      if (initial) {
        const snapshot = await searchSnapshotLoader.load(query)
        if (generation !== searchRequestGeneration || epoch !== neteaseScopeEpoch || snapshot.stale) return
        if (snapshot.artists.state === 'ready') {
          searchArtistsPage.value = snapshot.artists.page
          searchArtistsState.value = 'ready'
        } else if (isLibraryReadCancelled({ message: snapshot.artists.message })) {
          searchArtistsState.value = searchArtistsPage.value.items.length ? 'ready' : 'idle'
          searchArtistsError.value = null
        } else {
          searchArtistsState.value = 'error'
          searchArtistsError.value = snapshot.artists.message
        }
        if (snapshot.albums.state === 'ready') {
          searchAlbumsPage.value = snapshot.albums.page
          searchAlbumsState.value = 'ready'
        } else if (isLibraryReadCancelled({ message: snapshot.albums.message })) {
          searchAlbumsState.value = searchAlbumsPage.value.items.length ? 'ready' : 'idle'
          searchAlbumsError.value = null
        } else {
          searchAlbumsState.value = 'error'
          searchAlbumsError.value = snapshot.albums.message
        }
        if (snapshot.tracks.state === 'ready') {
          searchPage.value = snapshot.tracks.page
          searchError.value = null
        } else if (isLibraryReadCancelled({ message: snapshot.tracks.message })) {
          searchError.value = null
        } else {
          searchPage.value = emptyPage()
          searchError.value = searchSectionErrorKind(snapshot.tracks.message)
        }
        searchInitialLoading.value = false
        void matchTracks(searchPage.value.items)
      } else {
        const result = await searchReads.read('library.search', { query, page }, () => api.searchTracks(query, page))
        if (generation !== searchRequestGeneration || epoch !== neteaseScopeEpoch) return
        searchPage.value = appendPage(searchPage.value, result)
        void matchTracks(result.items)
        searchError.value = null
        searchLoadingMore.value = false
      }
    } catch (error) {
      if (generation !== searchRequestGeneration || epoch !== neteaseScopeEpoch) return
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

  async function loadRoonSearch(query: string, generation: number): Promise<void> {
    if (disposed) return
    const epoch = roonScopeEpoch
    roonQueryPending = true; roonResume = false
    roonSearchLoading.value = true
    const results = await Promise.allSettled([
      roonReads.read('roon.library.search', { query, page: { offset: 0, limit: 8 }, kind: 'album' }, () => api.searchRoonLibrary(query, { offset: 0, limit: 8 }, 'album')),
      roonReads.read('roon.library.search', { query, page: { offset: 0, limit: 6 }, kind: 'artist' }, () => api.searchRoonLibrary(query, { offset: 0, limit: 6 }, 'artist')),
    ])
    if (generation !== searchRequestGeneration || epoch !== roonScopeEpoch) return
    roonQueryPending = false
    const [albums, artists] = results
    if (albums.status === 'fulfilled') roonSearchAlbums.value = albums.value
    if (artists.status === 'fulfilled') roonSearchArtists.value = artists.value

    roonSearchError.value = results.some((result) => result.status === 'rejected' && !isLibraryReadCancelled(result.reason)) ? '部分 Roon 搜索结果暂时不可用，请检查 Roon 连接后重新搜索。' : null
    roonSearchLoading.value = false
  }

  async function loadMoreSearchEntities(source: 'roon' | 'netease', kind: 'album' | 'artist'): Promise<void> {
    if (disposed) return
    const generation = searchRequestGeneration, epoch = roonScopeEpoch, netEpoch = neteaseScopeEpoch
    const query = searchQuery.value.trim()
    const isAlbum = kind === 'album'
    const key = `${source}:${kind}`
    if (source === 'roon') {
      if (roonSearchLoading.value) return
      const target = isAlbum ? roonSearchAlbums : roonSearchArtists
      if (!target.value.hasMore) return
      pendingEntities.set(key, { source, kind })
      roonSearchLoading.value = true
      try {
        const request = { offset: nextRoonPageOffset(target.value), limit: target.value.limit }
        const result = await readRoonDatasetPage(target.value, request,
          page => roonReads.read('roon.library.search', { query, page, kind }, () => api.searchRoonLibrary(query, page, kind)),
          () => generation === searchRequestGeneration && epoch === roonScopeEpoch,
          roonRebases[kind] === 0 ? () => { roonRebases[kind]++ } : undefined)
        if (!result || generation !== searchRequestGeneration || epoch !== roonScopeEpoch) return
        pendingEntities.delete(key)
        target.value = result.restarted ? result.page : appendRoonPage(target.value, result.page)
        roonSearchError.value = null
      } catch (error) {
        if (generation === searchRequestGeneration && epoch === roonScopeEpoch && !isLibraryReadCancelled(error)) {
          pendingEntities.delete(key)
          roonSearchError.value = error instanceof RoonPageEpochChanged ? '读取上下文反复变化，请重新读取。' : '加载更多 Roon 结果失败，请重试。'
        }
      } finally {
        if (generation === searchRequestGeneration && epoch === roonScopeEpoch) roonSearchLoading.value = false
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
        if (generation !== searchRequestGeneration || netEpoch !== neteaseScopeEpoch) return
        searchAlbumsPage.value = appendPage(searchAlbumsPage.value, page)
        searchAlbumsError.value = null
      } else {
        const request = { offset: searchArtistsPage.value.offset + searchArtistsPage.value.limit, limit: 6 }
        const page = await searchReads.read('library.searchArtists', { query, page: request }, () => api.searchArtists(query, request))
        if (generation !== searchRequestGeneration || netEpoch !== neteaseScopeEpoch) return
        searchArtistsPage.value = appendPage(searchArtistsPage.value, page)
        searchArtistsError.value = null
      }
      pendingEntities.delete(key)
      state.value = 'ready'
    } catch (error) {
      if (generation !== searchRequestGeneration || netEpoch !== neteaseScopeEpoch) return
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
    resetSearchSections()
    searchSnapshotLoader.cancel()
    const generation = ++searchRequestGeneration
    searchError.value = null
    searchLoadMoreError.value = null
    searchPage.value = emptyPage()
    searchArtistsPage.value = emptyPage(6)
    searchAlbumsPage.value = emptyPage(8)
    searchArtistsState.value = 'idle'
    searchAlbumsState.value = 'idle'
    searchArtistsError.value = null
    searchAlbumsError.value = null
    searchDetail.value = null
    matchStates.value = {}
    matchResults.value = {}
    cancelPendingMatches()
    matchGeneration += 1
    searchInitialLoading.value = false
    searchLoadingMore.value = false
    const query = searchQuery.value.trim()
    if (query.length === 0) {
      searchPage.value = emptyPage()
      return
    }
    searchTimer = setTimeout(() => {
      searchTimer = undefined
      void loadSearch(query, { offset: 0, limit: LIBRARY_PAGE_SIZE }, generation)
    }, SEARCH_DEBOUNCE_MS)
  }


  function searchPageAt(offset: number): void {
    if (disposed) return
    const query = searchQuery.value.trim()
    if (!query) return
    stopSearchTimer()
    void loadSearch(query, { offset, limit: LIBRARY_PAGE_SIZE }, searchRequestGeneration)
  }

  async function openSearchDetail(kind: 'artist' | 'album', id: string, title: string, subtitle: string): Promise<void> {
    searchScrollTop.value = getScrollTop()
    if (disposed) return
    const operation = ++searchDetailGeneration
    detailReads.cancelAll()
    detailResume = false
    searchDetailLoadingMore.value = false
    searchDetailMoreError.value = null
    searchDetail.value = {
      kind,
      id,
      title,
      subtitle,
      tracks: emptyPage(),
      loading: true,
      error: null,
    }
    try {
      if (kind === 'artist') {
        const page = { offset: 0, limit: LIBRARY_PAGE_SIZE }
        const detail = await detailReads.read('library.artist', { artistId: id, page }, () => api.getArtist(id, page))
        if (operation !== searchDetailGeneration) return
        searchDetail.value = {
          kind,
          id,
          title: detail.name,
          subtitle: `${detail.albumCount ?? 0} 张专辑 · ${detail.trackCount ?? detail.tracks.total} 首歌曲`,
          tracks: detail.tracks,
          loading: false,
          error: null,
        }
        return
      }
      const page = { offset: 0, limit: LIBRARY_PAGE_SIZE }
      const detail = await detailReads.read('library.album', { albumId: id, page }, () => api.getAlbum(id, page))
      if (operation !== searchDetailGeneration) return
      searchDetail.value = {
        kind,
        id,
        title: detail.name,
        subtitle: `${detail.artistName} · ${detail.trackCount ?? detail.tracks.total} 首歌曲`,
        tracks: detail.tracks,
        loading: false,
        error: null,
      }
    } catch (error) {
      if (operation !== searchDetailGeneration) return
      if (isLibraryReadCancelled(error)) {
        detailResume = true
        if (searchDetail.value) searchDetail.value = { ...searchDetail.value, loading: false }
        return
      }
      searchDetail.value = { kind, id, title, subtitle, tracks: emptyPage(), loading: false, error: '详情歌曲暂时不可用，请稍后重试。' }
    }
  }

  async function loadMoreSearchDetail(): Promise<void> {
    const detail = searchDetail.value
    if (disposed || !detail || searchDetailLoadingMore.value) return
    const generation = searchDetailGeneration
    searchDetailLoadingMore.value = true
    searchDetailMoreError.value = null
    try {
      const request = { offset: detail.tracks.offset + detail.tracks.limit, limit: detail.tracks.limit }
      const result = detail.kind === 'artist'
        ? await detailReads.read('library.artist', { artistId: detail.id, page: request }, () => api.getArtist(detail.id, request))
        : await detailReads.read('library.album', { albumId: detail.id, page: request }, () => api.getAlbum(detail.id, request))
      if (generation === searchDetailGeneration && searchDetail.value) searchDetail.value = { ...searchDetail.value, tracks: appendPage(searchDetail.value.tracks, result.tracks) }
    } catch (error) {
      if (generation === searchDetailGeneration) {
        if (isLibraryReadCancelled(error)) detailResume = true
        else searchDetailMoreError.value = '加载更多歌曲失败，请重试。'
      }
    } finally {
      if (generation === searchDetailGeneration) searchDetailLoadingMore.value = false
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
    searchInitialLoading.value = false; searchLoadingMore.value = false; roonSearchLoading.value = false
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
    neteaseScopeEpoch += 1; roonScopeEpoch += 1
    suspend()
    searchSnapshotLoader = newSnapshotLoader()
    pendingEntities.clear()
    searchPage.value = emptyPage(); searchArtistsPage.value = emptyPage(6); searchAlbumsPage.value = emptyPage(8)
    searchArtistsState.value = 'idle'; searchAlbumsState.value = 'idle'
    roonSearchAlbums.value = emptyRoonPage(8); roonSearchArtists.value = emptyRoonPage(6)
    searchDetail.value = null; detailResume = false; accountResume = false
    searchError.value = null; searchArtistsError.value = null; searchAlbumsError.value = null; roonSearchError.value = null
    resetMatches()
    if (searchQuery.value.trim()) { pendingResume = { offset: 0, limit: LIBRARY_PAGE_SIZE }; roonResume = true }
  }

  function invalidateAccountScope(): void {
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
    roonScopeEpoch += 1
    roonQueryPending = false
    for (const [key, request] of pendingEntities) if (request.source === 'roon') pendingEntities.delete(key)
    roonReads.cancelAll()
    roonSearchAlbums.value = emptyRoonPage(8); roonSearchArtists.value = emptyRoonPage(6)
    roonSearchLoading.value = false; roonSearchError.value = null
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
    roonSearchAlbums, roonSearchArtists, roonSearchLoading, roonSearchError,
    searchPage, searchArtistsPage, searchAlbumsPage, searchArtistsState, searchAlbumsState,
    searchArtistsError, searchAlbumsError, searchDetail, searchDetailLoadingMore,
    searchDetailMoreError, searchScrollTop, searchInitialLoading, searchLoadingMore,
    searchLoadMoreError, searchError, matchStates, matchResults, pendingMatchRequests,
    selectSearchCategory, stopSearchTimer, resetSearchSections, resetSearch,
    resetMatches, cancelPendingMatches, matchTracks, scheduleSearch, searchPageAt,
    loadMoreSearchEntities, openSearchSongs, openSearchDetail, loadMoreSearchDetail,
    closeSearchDetail, suspend, resume, invalidateScope, invalidateAccountScope, invalidateRoonScope, dispose,
  }
}
