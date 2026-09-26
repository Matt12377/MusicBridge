import { computed, ref } from 'vue'
import type {
  AlbumSummary, ArtistSummary, MatchState, Page, PageRequest,
  PublicTrackMatchResult, RoonLibraryPage, TrackSummary,
} from '@music-bridge/contracts'
import type { MusicBridgePublicApi } from '../../../../preload/api.js'
import { appendPage } from '../libraryPagination.js'
import { appendRoonPage, emptyRoonPage } from '../roonLibraryPagination.js'
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
    (track: TrackSummary) => api.matchLibraryTrack(track),
    SMART_MATCH_REQUEST_CONCURRENCY,
  )
  const searchSnapshotLoader = createSearchSnapshotLoader({
    artists: (query, page) => api.searchArtists(query, page),
    tracks: (query, page) => api.searchTracks(query, page),
    albums: (query, page) => api.searchAlbums(query, page),
  })
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
    searchRequestGeneration += 1
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


  async function loadSearch(query: string, page: PageRequest, generation: number): Promise<void> {
    const initial = page.offset === 0
    if (initial) {
      searchInitialLoading.value = true
      searchLoadMoreError.value = null
      searchArtistsState.value = 'loading'
      searchAlbumsState.value = 'loading'
      searchArtistsError.value = null
      searchAlbumsError.value = null
      void loadRoonSearch(query, generation)
    } else {
      if (searchLoadingMore.value) return
      searchLoadingMore.value = true
      searchLoadMoreError.value = null
    }
    try {
      if (initial) {
        const snapshot = await searchSnapshotLoader.load(query)
        if (generation !== searchRequestGeneration || snapshot.stale) return
        if (snapshot.artists.state === 'ready') {
          searchArtistsPage.value = snapshot.artists.page
          searchArtistsState.value = 'ready'
        } else {
          searchArtistsState.value = 'error'
          searchArtistsError.value = snapshot.artists.message
        }
        if (snapshot.albums.state === 'ready') {
          searchAlbumsPage.value = snapshot.albums.page
          searchAlbumsState.value = 'ready'
        } else {
          searchAlbumsState.value = 'error'
          searchAlbumsError.value = snapshot.albums.message
        }
        if (snapshot.tracks.state === 'ready') {
          searchPage.value = snapshot.tracks.page
          searchError.value = null
        } else {
          searchPage.value = emptyPage()
          searchError.value = searchSectionErrorKind(snapshot.tracks.message)
        }
        searchInitialLoading.value = false
        void matchTracks(searchPage.value.items)
      } else {
        const result = await api.searchTracks(query, page)
        if (generation !== searchRequestGeneration) return
        searchPage.value = appendPage(searchPage.value, result)
        void matchTracks(result.items)
        searchError.value = null
        searchLoadingMore.value = false
      }
    } catch (error) {
      if (generation !== searchRequestGeneration) return
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
    roonSearchLoading.value = true
    const results = await Promise.allSettled([
      api.searchRoonLibrary(query, { offset: 0, limit: 8 }, 'album'),
      api.searchRoonLibrary(query, { offset: 0, limit: 6 }, 'artist'),
    ])
    if (generation !== searchRequestGeneration) return
    const [albums, artists] = results
    if (albums.status === 'fulfilled') roonSearchAlbums.value = albums.value
    if (artists.status === 'fulfilled') roonSearchArtists.value = artists.value

    roonSearchError.value = results.some((result) => result.status === 'rejected') ? '部分 Roon 搜索结果暂时不可用，请检查 Roon 连接后重新搜索。' : null
    roonSearchLoading.value = false
  }

  async function loadMoreSearchEntities(source: 'roon' | 'netease', kind: 'album' | 'artist'): Promise<void> {
    const generation = searchRequestGeneration
    const query = searchQuery.value.trim()
    const isAlbum = kind === 'album'
    if (source === 'roon') {
      if (roonSearchLoading.value) return
      const target = isAlbum ? roonSearchAlbums : roonSearchArtists
      if (!target.value.hasMore) return
      roonSearchLoading.value = true
      try {
        const page = await api.searchRoonLibrary(query, { offset: target.value.offset + target.value.limit, limit: target.value.limit }, kind)
        if (generation !== searchRequestGeneration) return
        target.value = appendRoonPage(target.value, page)
        roonSearchError.value = null
      } catch {
        if (generation === searchRequestGeneration) roonSearchError.value = '加载更多 Roon 结果失败，请重试。'
      } finally {
        if (generation === searchRequestGeneration) roonSearchLoading.value = false
      }
      return
    }
    const state = isAlbum ? searchAlbumsState : searchArtistsState
    if (state.value === 'loading' || !(isAlbum ? searchAlbumsPage.value : searchArtistsPage.value).hasMore) return
    state.value = 'loading'
    try {
      if (isAlbum) {
        const page = await api.searchAlbums(query, { offset: searchAlbumsPage.value.offset + searchAlbumsPage.value.limit, limit: 8 })
        if (generation !== searchRequestGeneration) return
        searchAlbumsPage.value = appendPage(searchAlbumsPage.value, page)
        searchAlbumsError.value = null
      } else {
        const page = await api.searchArtists(query, { offset: searchArtistsPage.value.offset + searchArtistsPage.value.limit, limit: 6 })
        if (generation !== searchRequestGeneration) return
        searchArtistsPage.value = appendPage(searchArtistsPage.value, page)
        searchArtistsError.value = null
      }
      state.value = 'ready'
    } catch {
      if (generation !== searchRequestGeneration) return
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
    if (!shouldPreloadSmartMatches(getZoneId(), visible)) return
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
    const query = searchQuery.value.trim()
    if (!query) return
    stopSearchTimer()
    void loadSearch(query, { offset, limit: LIBRARY_PAGE_SIZE }, searchRequestGeneration)
  }

  async function openSearchDetail(kind: 'artist' | 'album', id: string, title: string, subtitle: string): Promise<void> {
    searchScrollTop.value = getScrollTop()
    const operation = ++searchDetailGeneration
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
        const detail = await api.getArtist(id, { offset: 0, limit: LIBRARY_PAGE_SIZE })
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
      const detail = await api.getAlbum(id, { offset: 0, limit: LIBRARY_PAGE_SIZE })
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
    } catch {
      if (operation !== searchDetailGeneration) return
      searchDetail.value = { kind, id, title, subtitle, tracks: emptyPage(), loading: false, error: '详情歌曲暂时不可用，请稍后重试。' }
    }
  }

  async function loadMoreSearchDetail(): Promise<void> {
    const detail = searchDetail.value
    if (!detail || searchDetailLoadingMore.value) return
    const generation = searchDetailGeneration
    searchDetailLoadingMore.value = true
    searchDetailMoreError.value = null
    try {
      const request = { offset: detail.tracks.offset + detail.tracks.limit, limit: detail.tracks.limit }
      const result = detail.kind === 'artist'
        ? await api.getArtist(detail.id, request)
        : await api.getAlbum(detail.id, request)
      if (generation === searchDetailGeneration && searchDetail.value) searchDetail.value = { ...searchDetail.value, tracks: appendPage(searchDetail.value.tracks, result.tracks) }
    } catch {
      if (generation === searchDetailGeneration) searchDetailMoreError.value = '加载更多歌曲失败，请重试。'
    } finally {
      if (generation === searchDetailGeneration) searchDetailLoadingMore.value = false
    }
  }

  function closeSearchDetail(): void {
    searchDetailGeneration += 1
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

  function dispose(): void {
    resetSearch()
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
    closeSearchDetail, dispose,
  }
}
