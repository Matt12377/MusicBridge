<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { roonTrackIdFromReference } from '@music-bridge/contracts'

import type {
  AlbumSummary,
  ArtistSummary,
  LyricsSnapshot,
  LocalLyricsMatchSnapshot,
  MatchState,
  Page,
  PageRequest,
  DailyRecommendationsSnapshot,
  FavoriteEntityDescriptor,
  FavoriteKind,
  FavoritePage,
  PlaybackQualityPreference,
  PlaybackQueueRequestItem,
  PlaybackQueueItem,
  PlaybackSnapshot,
  PlaylistDetail,
  PublicAuthState,
  PublicAccountState,
  PublicAggregatedSearchResult,
  PublicBridgeState,
  PublicRoonZone,
  PublicTrackMatchResult,
  RoonLibraryItem,
  RoonLibraryPage,
  RemoteCoreTunnelState,
  TrackSummary,
} from '@music-bridge/contracts'
import type { AppInfo } from '../../preload/api.js'
import AlbumAmbientBackground from './components/AlbumAmbientBackground.vue'
import BottomPlayer from './components/BottomPlayer.vue'
import HomeView from './components/HomeView.vue'
import SafeArtwork from './components/SafeArtwork.vue'
import NowPlayingView from './components/NowPlayingView.vue'
import DailyRecommendationsView from './components/views/DailyRecommendationsView.vue'
import SettingsView from './components/settings/SettingsView.vue'
import PlaybackInspector from './components/inspector/PlaybackInspector.vue'
import TrackTable from './components/media/TrackTable.vue'
import RoonAlbumGrid from './components/RoonAlbumGrid.vue'
import RoonEntityGrid from './components/RoonEntityGrid.vue'
import FavoriteEntityGrid from './components/FavoriteEntityGrid.vue'
import RoonAlbumDetail from './components/RoonAlbumDetail.vue'
import RoonBrowseDetail from './components/RoonBrowseDetail.vue'
import MusicSidebar from './components/sidebar/MusicSidebar.vue'
import CommandOutboxPanel from './components/CommandOutboxPanel.vue'
import { useLibrarySources } from './composables/useLibrarySources.js'
import { appendPage } from './composables/libraryPagination.js'
import {
  createProgressiveCollectionLoader,
  loadCollectionTracks,
  selectInitialCollectionPlayback,
  type CollectionPageLoader,
  type ProgressiveCollectionLoader,
} from './composables/collectionQueue.js'
import { appendRoonPage, emptyRoonPage } from './composables/roonLibraryPagination.js'
import { useRoonCollection } from './composables/useRoonCollection.js'
import { shouldRefreshVisibleRoonCollection } from './roon-collection-lifecycle.js'
import { canLoadAuthorizedLibrary, isCoreRuntimeStable } from './core-readiness.js'
import {
  selectRandomPlaylistPages,
  settleHomePlaylistPages,
  shuffleTracks,
  type HomeRecommendationState,
} from './composables/homeRecommendations.js'
import { useSidebarState } from './composables/useSidebarState.js'
import { createSearchSnapshotLoader } from './composables/search.js'
import {
  readPublicIpcErrorCode,
  roonLibraryMessage as formatRoonLibraryMessage,
} from './roonLibraryMessages.js'
import { roonArtworkCache } from './roon-artwork-cache.js'
import {
  favoriteDescriptorForRoonItem,
  favoriteDescriptorForTrack,
  resolveFavoriteToggle,
} from './composables/playbackFavorites.js'
import {
  SMART_MATCH_REQUEST_CONCURRENCY,
  confirmedRoonCandidate,
  createMatchRequestScheduler,
  immediatePlaybackSelection,
  nativeRoonQueueItemHasNeteaseIdentity,
  queuePreferenceForMatch,
  settledMapWithConcurrency,
  shouldPreloadSmartMatches,
  trackSummaryForMatching,
  tracksForInitialMatching,
  waitForMatchWithinPlaybackBudget,
} from './composables/playbackMatching.js'
import type { SidebarSource, ViewId } from './components/navigation.js'
import { createZoneRefreshCoordinator, resolveZoneLifecycleStatus } from './zone-lifecycle.js'
import { createOptimisticRoonPlayback } from './roon-playback-optimism.js'
import { collectRoonPlaybackContext } from './roon-context-queue.js'
import CollectionView from './components/collection/CollectionView.vue'
import RecordingView from './components/recording/RecordingView.vue'

const LIBRARY_PAGE_SIZE = 20
const SEARCH_DEBOUNCE_MS = 250

function emptyPage<T>(limit = LIBRARY_PAGE_SIZE): Page<T> {
  return { items: [], offset: 0, limit, total: 0, hasMore: false }
}

function emptyFavoritePage(limit = LIBRARY_PAGE_SIZE): FavoritePage {
  return { items: [], offset: 0, limit, total: 0, hasMore: false }
}

function emptyLyricsSnapshot(status: LyricsSnapshot['status'] = 'idle'): LyricsSnapshot {
  return { status, lines: [], activeLineIndex: -1, timingSource: 'static' }
}

function emptyLocalLyricsMatchSnapshot(): LocalLyricsMatchSnapshot {
  return { status: 'hidden', candidates: [], canRevoke: false }
}

function localDayKey(now = Date.now()): string {
  const date = new Date(now)
  return String(date.getFullYear()) + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0')
}

const appInfo = ref<AppInfo | null>(null)
const currentView = ref<ViewId>('home')
const recordingReloadRequired = ref(false)
const nowPlayingReturnView = ref<ViewId>('home')
const sidebar = useSidebarState()
const searchReturnSource = ref<SidebarSource>({ type: 'home' })
const coreState = ref<PublicBridgeState | null>(null)
const authState = ref<PublicAuthState>({ status: 'idle' })
const accountState = ref<PublicAccountState>({ status: 'missing' })
const dailyRecommendations = ref<DailyRecommendationsSnapshot>({
  dayKey: localDayKey(),
  tracks: [],
})
const dailyState = ref<'idle' | 'loading' | 'ready' | 'empty' | 'error'>('idle')
const dailyError = ref<string | null>(null)
const accountError = ref<string | null>(null)
const coreError = ref(false)
const authError = ref(false)
const playbackState = ref<PlaybackSnapshot | null>(null)
const playbackStartPending = ref(false)
const playbackSource = ref<'roon' | 'netease'>('netease')
const nativeRoonHasNeteaseMatch = ref(false)
const lyricsSnapshot = ref<LyricsSnapshot>(emptyLyricsSnapshot())
const localLyricsMatchState = ref<LocalLyricsMatchSnapshot>(emptyLocalLyricsMatchSnapshot())
const localLyricsMatchBusy = ref(false)
const localLyricsMatchError = ref(false)
let localLyricsMatchRevision = 0
const trackLikeState = ref<'idle' | 'loading' | 'liked' | 'not-liked' | 'error'>('idle')
const neteaseTrackLiked = ref<boolean | null>(null)
const localTrackFavoriteState = ref<'idle' | 'loading' | 'liked' | 'not-liked' | 'error'>('idle')
const localTrackFavoriteDescriptor = ref<FavoriteEntityDescriptor | null>(null)
const roonQueueDescriptors = new Map<string, RoonLibraryItem>()
const roonQueueNeteaseMatches = new Set<string>()
const MAX_ROON_QUEUE_DESCRIPTORS = 256

function rememberRoonQueueDescriptor(
  trackId: string,
  item: RoonLibraryItem,
  linkedToNetease = false,
): void {
  roonQueueDescriptors.set(trackId, item)
  if (linkedToNetease) roonQueueNeteaseMatches.add(trackId)
  else roonQueueNeteaseMatches.delete(trackId)
  while (roonQueueDescriptors.size > MAX_ROON_QUEUE_DESCRIPTORS) {
    const oldest = roonQueueDescriptors.keys().next().value
    if (oldest === undefined) break
    roonQueueDescriptors.delete(oldest)
    roonQueueNeteaseMatches.delete(oldest)
  }
}
const zones = ref<readonly PublicRoonZone[]>([])
const zonesLoading = ref(false)
const zoneRefreshCoordinator = createZoneRefreshCoordinator({
  load: async () => (await window.musicBridge.listZones()).zones,
  onZones: (nextZones) => { zones.value = nextZones },
  onLoading: (loading) => { zonesLoading.value = loading },
  onError: (error) => recordActionError(error),
})
const selectedQuality = ref<PlaybackQualityPreference>('auto')
const remoteCoreState = ref<RemoteCoreTunnelState>({
  mode: 'local-core',
  status: 'idle',
  localStreamPort: 38502,
  remoteHealth: 'unavailable',
  autoReconnect: false,
})
const remoteAutoStart = ref(false)
const remoteSshTarget = ref('')
const inspectorOpen = ref(false)
const commandOutboxOpen = ref(false)
const commandOutboxTrigger = ref<HTMLButtonElement>()
async function closeCommandOutbox(): Promise<void> {
  commandOutboxOpen.value = false
  await nextTick()
  commandOutboxTrigger.value?.focus({ preventScroll: true })
}
const inspectorReturnFocus = ref<HTMLElement | null>(null)
const actionError = ref<string | null>(null)
const actionDiagnosticId = ref<string | null>(null)
const diagnosticNotice = ref<{ code: string; message?: string } | null>(null)
const diagnosticExportState = ref<'idle' | 'working' | 'done' | 'cancelled' | 'error'>('idle')
const toastMessage = ref<string | null>(null)

const searchQuery = ref('')
const searchPage = ref<Page<TrackSummary>>(emptyPage())
const searchArtistsPage = ref<Page<ArtistSummary>>(emptyPage(6))
const searchAlbumsPage = ref<Page<AlbumSummary>>(emptyPage(8))
const searchArtistsState = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
const searchAlbumsState = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
const searchArtistsError = ref<string | null>(null)
const searchAlbumsError = ref<string | null>(null)
const searchDetail = ref<{
  kind: 'artist' | 'album'
  title: string
  subtitle: string
  tracks: Page<TrackSummary>
  loading: boolean
  error: string | null
} | null>(null)
const searchScrollTop = ref(0)
const contentScroll = ref<HTMLElement | null>(null)
const aggregatedSearch = ref<PublicAggregatedSearchResult | null>(null)
const matchStates = ref<Record<string, MatchState>>({})
const matchResults = ref<Record<string, PublicTrackMatchResult>>({})
const pendingMatchRequests = new Map<string, Promise<PublicTrackMatchResult>>()
const matchRequestScheduler = createMatchRequestScheduler(
  (track: TrackSummary) => window.musicBridge.matchLibraryTrack(track),
  SMART_MATCH_REQUEST_CONCURRENCY,
)
const likedPage = ref<Page<TrackSummary>>(emptyPage())
const {
  playlists,
  playlistState,
  playlistError,
  loadPlaylists: loadPlaylistSources,
  reset: resetPlaylistSources,
} = useLibrarySources()
const selectedPlaylist = ref<PlaylistDetail | null>(null)
const selectedPlaylistId = ref<string | null>(null)
const playlistContentScrollTop = ref(0)
const playlistTableScrollTop = ref(0)
const {
  page: roonAlbumsPage,
  initialLoading: roonAlbumsInitialLoading,
  loadingMore: roonAlbumsLoadingMore,
  loadMoreError: roonAlbumsLoadMoreError,
  error: roonAlbumsError,
  load: loadRoonAlbums,
  loadMore: loadMoreRoonAlbums,
  retry: retryRoonAlbums,
  reset: resetRoonAlbums,
} = useRoonCollection(
  (page) => window.musicBridge.listRoonAlbums(page),
  (error) => roonLibraryMessage(error),
)
const {
  page: roonArtistsPage,
  initialLoading: roonArtistsInitialLoading,
  loadingMore: roonArtistsLoadingMore,
  loadMoreError: roonArtistsLoadMoreError,
  error: roonArtistsError,
  load: loadRoonArtists,
  loadMore: loadMoreRoonArtists,
  retry: retryRoonArtists,
  reset: resetRoonArtists,
} = useRoonCollection(
  (page) => window.musicBridge.listRoonArtists(page),
  (error) => roonLibraryMessage(error),
)
const {
  page: roonGenresPage,
  initialLoading: roonGenresInitialLoading,
  loadingMore: roonGenresLoadingMore,
  loadMoreError: roonGenresLoadMoreError,
  error: roonGenresError,
  load: loadRoonGenres,
  loadMore: loadMoreRoonGenres,
  retry: retryRoonGenres,
  reset: resetRoonGenres,
} = useRoonCollection(
  (page) => window.musicBridge.listRoonGenres(page),
  (error) => roonLibraryMessage(error),
)
const {
  page: roonPlaylistsPage,
  initialLoading: roonPlaylistsInitialLoading,
  loadingMore: roonPlaylistsLoadingMore,
  loadMoreError: roonPlaylistsLoadMoreError,
  error: roonPlaylistsError,
  load: loadRoonPlaylists,
  loadMore: loadMoreRoonPlaylists,
  retry: retryRoonPlaylists,
  reset: resetRoonPlaylists,
} = useRoonCollection(
  (page) => window.musicBridge.listRoonPlaylists(page),
  (error) => roonLibraryMessage(error),
)
const favoriteKind = ref<FavoriteKind>('track')
const favoritesPage = ref<FavoritePage>(emptyFavoritePage())
const favoritesInitialLoading = ref(false)
const favoritesLoadingMore = ref(false)
const favoritesLoadMoreError = ref<string | null>(null)
const favoritesError = ref<string | null>(null)
const selectedRoonAlbum = ref<RoonLibraryItem | null>(null)
const roonAlbumFavoriteState = ref<'idle' | 'loading' | 'liked' | 'not-liked' | 'error'>('idle')
const selectedRoonAlbumPage = ref<RoonLibraryPage>(emptyRoonPage())
const roonAlbumInitialLoading = ref(false)
const roonAlbumLoadingMore = ref(false)
const roonAlbumLoadMoreError = ref<string | null>(null)
const roonAlbumError = ref<string | null>(null)
const selectedRoonArtist = ref<RoonLibraryItem | null>(null)
const roonArtistFavoriteState = ref<'idle' | 'loading' | 'liked' | 'not-liked' | 'error'>('idle')
const selectedRoonArtistPage = ref<RoonLibraryPage>(emptyRoonPage())
const roonArtistInitialLoading = ref(false)
const roonArtistLoadingMore = ref(false)
const roonArtistLoadMoreError = ref<string | null>(null)
const roonArtistError = ref<string | null>(null)
const selectedRoonGenre = ref<RoonLibraryItem | null>(null)
const selectedRoonGenrePage = ref<RoonLibraryPage>(emptyRoonPage())
const roonGenreInitialLoading = ref(false)
const roonGenreLoadingMore = ref(false)
const roonGenreLoadMoreError = ref<string | null>(null)
const roonGenreError = ref<string | null>(null)
const selectedRoonPlaylist = ref<RoonLibraryItem | null>(null)
const selectedRoonPlaylistPage = ref<RoonLibraryPage>(emptyRoonPage())
const roonPlaylistInitialLoading = ref(false)
const roonPlaylistLoadingMore = ref(false)
const roonPlaylistLoadMoreError = ref<string | null>(null)
const roonPlaylistError = ref<string | null>(null)
const homePlaylistTracks = ref<readonly TrackSummary[]>([])
const recentTracks = ref<readonly TrackSummary[]>([])
const homeRecommendationState = ref<HomeRecommendationState>('loading')
const searchInitialLoading = ref(false)
const searchLoadingMore = ref(false)
const searchLoadMoreError = ref<string | null>(null)
type SearchErrorKind = 'auth-required' | 'auth-expired' | 'generic'
type LibraryErrorKind = SearchErrorKind

const searchError = ref<SearchErrorKind | null>(null)
const likedInitialLoading = ref(false)
const likedLoadingMore = ref(false)
const likedLoadMoreError = ref<string | null>(null)
const likedError = ref<LibraryErrorKind | null>(null)
const playlistInitialLoading = ref(false)
const playlistLoadingMore = ref(false)
const playlistLoadMoreError = ref<string | null>(null)
const playlistDetailError = ref<LibraryErrorKind | null>(null)

let removeCoreListener: (() => void) | undefined
let removeAppCommandListener: (() => void) | undefined
let removeRemoteCoreListener: (() => void) | undefined
let pollTimer: ReturnType<typeof setInterval> | undefined
let searchTimer: ReturnType<typeof setTimeout> | undefined
let authOperation = 0
let authorizedLibraryLoadStarted = false
let authEventReceived = false
let pollInFlight = false
let lyricsOperation = 0
let trackLikeOperation = 0
let localFavoriteOperation = 0
let homeRecommendationOperation = 0
let dailyOperation = 0
let collectionOperation = 0
let roonPlaybackOperation = 0
let optimisticRoonTrackId: string | undefined

function cancelRoonPlaybackPreparation(): void {
  ++roonPlaybackOperation
  optimisticRoonTrackId = undefined
}
let activeCollectionLoader: ProgressiveCollectionLoader | undefined
let collectionPlaybackStartInFlight = false
let toastTimer: ReturnType<typeof setTimeout> | undefined
let searchRequestGeneration = 0
let searchDetailGeneration = 0
let matchGeneration = 0
let likedRequestGeneration = 0
let playlistRequestGeneration = 0
let favoritesRequestGeneration = 0
let roonAlbumRequestGeneration = 0
let roonArtistRequestGeneration = 0
let roonGenreRequestGeneration = 0
let roonPlaylistRequestGeneration = 0
let entityFavoriteOperation = 0

const currentTrack = computed(() => playbackState.value?.currentTrack)
const homeTracks = computed(() => recentTracks.value)
const selectedZone = computed(() => {
  const selectedId = playbackState.value?.selectedZoneId
  return zones.value.find((zone) => zone.zoneId === selectedId) ?? zones.value.find((zone) => zone.selected)
})
const zoneLifecycleStatus = computed(() => resolveZoneLifecycleStatus({
  roonStatus: coreState.value?.roon ?? 'disconnected',
  loading: zonesLoading.value,
  zoneCount: zones.value.length,
  selected: selectedZone.value !== undefined,
}))
const isImmersiveNowPlaying = computed(() => currentView.value === 'now-playing')
const hasPlaybackIssue = computed(() => Boolean(playbackState.value?.lastIssue || actionError.value))
const greeting = computed(() => {
  const hour = new Date().getHours()
  return hour >= 5 && hour < 12 ? '早上好' : hour >= 12 && hour < 18 ? '下午好' : '晚上好'
})
const likedHomeState = computed<'unauthorized' | 'loading' | 'ready' | 'empty' | 'error'>(() => {
  if (authState.value.status !== 'authorized') return 'unauthorized'
  if (likedInitialLoading.value && likedPage.value.items.length === 0) return 'loading'
  if (likedError.value) return 'error'
  return likedPage.value.items.length ? 'ready' : 'empty'
})

const searchSnapshotLoader = createSearchSnapshotLoader({
  artists: (query, page) => window.musicBridge.searchArtists(query, page),
  tracks: (query, page) => window.musicBridge.searchTracks(query, page),
  albums: (query, page) => window.musicBridge.searchAlbums(query, page),
})

function enterNowPlaying(): void {
  if (currentView.value !== 'now-playing') {
    nowPlayingReturnView.value = currentView.value
    if (currentView.value === 'playlist-detail') {
      playlistContentScrollTop.value = contentScroll.value?.scrollTop ?? 0
    }
  }
  currentView.value = 'now-playing'
  inspectorOpen.value = false
}

function exitNowPlaying(): void {
  const destination = nowPlayingReturnView.value
  currentView.value = destination === 'now-playing' ? 'home' : destination
  inspectorOpen.value = false
  if (currentView.value === 'playlist-detail') {
    void nextTick(() => contentScroll.value?.scrollTo({ top: playlistContentScrollTop.value }))
  }
}

function navigate(view: ViewId): void {
  if (view === 'now-playing') {
    enterNowPlaying()
    return
  }
  currentView.value = view
  if (view !== 'queue') inspectorOpen.value = false
  actionError.value = null
  actionDiagnosticId.value = null
  if (view === 'search' && searchQuery.value.trim()) scheduleSearch()
  if (view === 'liked') {
    sidebar.setActiveSource({ type: 'liked' })
  }
  if (view === 'playlists') {
    sidebar.setActiveSource({ type: 'playlists' })
  }
  if (view === 'roon-albums') {
    sidebar.setActiveSource({ type: 'roon-albums' })
    if (!roonAlbumsPage.value.items.length && !roonAlbumsInitialLoading.value) void loadRoonAlbums()
  }
  if (view === 'roon-favorites') {
    sidebar.setActiveSource({ type: 'roon-favorites' })
    if (!favoritesInitialLoading.value && !favoritesPage.value.items.length) void loadFavorites()
  }
  if (view === 'home') {
    sidebar.setActiveSource({ type: 'home' })
  }
  if (view === 'liked' && likedPage.value.items.length === 0) {
    void loadLiked()
  }
  if (view === 'playlists' && playlistState.value !== 'ready') {
    void loadPlaylists()
  }
}

function viewForSource(source: SidebarSource): ViewId {
  switch (source.type) {
    case 'home':
      return 'home'
    case 'collection':
      return 'collection'
    case 'recording':
      return 'recording'
    case 'liked':
      return 'liked'
    case 'playlists':
      return 'playlists'
    case 'playlist':
      return 'playlist-detail'
    case 'roon-albums':
      return 'roon-albums'
    case 'roon-artists':
      return 'roon-artists'
    case 'roon-genres':
      return 'roon-genres'
    case 'roon-playlists':
      return 'roon-playlists'
    case 'roon-favorites':
      return 'roon-favorites'
    case 'roon-album':
      return 'roon-album-detail'
    case 'roon-artist':
      return 'roon-artist-detail'
    case 'roon-genre':
      return 'roon-genre-detail'
    case 'roon-playlist':
      return 'roon-playlist-detail'
  }
}

// 只保留本次会话的视图选择，不承载库存、曲目或持久化数据。
const collectionView = ref<'tapes' | 'music'>('tapes')

function openTapeCollection(): void {
  collectionView.value = 'tapes'
  navigateSource({ type: 'collection' })
}

function navigateSource(source: SidebarSource): void {
  stopSearchTimer()
  resetSearchSections()
  searchQuery.value = ''
  searchPage.value = emptyPage()
  aggregatedSearch.value = null
  matchStates.value = {}
  matchResults.value = {}
  cancelPendingMatches()
  matchGeneration += 1
  searchReturnSource.value = source
  sidebar.setActiveSource(source)
  navigate(viewForSource(source))
  if (source.type === 'playlist') void loadPlaylist(source.playlistId)
  if (source.type === 'roon-albums') {
    if (!roonAlbumsInitialLoading.value && (!roonAlbumsPage.value.items.length || roonAlbumsError.value)) void loadRoonAlbums()
  }
  if (source.type === 'roon-artists') {
    if (!roonArtistsInitialLoading.value && (!roonArtistsPage.value.items.length || roonArtistsError.value)) void loadRoonArtists()
  }
  if (source.type === 'roon-genres') {
    if (!roonGenresInitialLoading.value && (!roonGenresPage.value.items.length || roonGenresError.value)) void loadRoonGenres()
  }
  if (source.type === 'roon-playlists') {
    if (!roonPlaylistsInitialLoading.value && (!roonPlaylistsPage.value.items.length || roonPlaylistsError.value)) void loadRoonPlaylists()
  }
  if (source.type === 'roon-favorites') void loadFavorites()
  if (source.type === 'roon-album') void loadRoonAlbum(source.reference)
  if (source.type === 'roon-artist') void loadRoonArtist(source.reference)
  if (source.type === 'roon-genre') void loadRoonGenre(source.reference)
  if (source.type === 'roon-playlist') void loadRoonPlaylist(source.reference)
}

function clearSearch(): void {
  if (currentView.value !== 'search' && searchQuery.value.length === 0 && searchPage.value.items.length === 0) return
  stopSearchTimer()
  resetSearchSections()
  searchRequestGeneration += 1
  searchQuery.value = ''
  searchPage.value = emptyPage()
  aggregatedSearch.value = null
  matchStates.value = {}
  matchResults.value = {}
  cancelPendingMatches()
  matchGeneration += 1
  searchInitialLoading.value = false
  searchLoadingMore.value = false
  searchLoadMoreError.value = null
  searchError.value = null
  const source = searchReturnSource.value
  sidebar.setActiveSource(source)
  currentView.value = viewForSource(source)
  if (source.type === 'liked' && likedPage.value.items.length === 0) void loadLiked()
  if (source.type === 'playlists' && playlistState.value !== 'ready') void loadPlaylists()
}

function updateSearchQuery(query: string): void {
  if (currentView.value !== 'search') searchReturnSource.value = sidebar.activeSource.value
  searchQuery.value = query
  if (!query.trim()) {
    clearSearch()
    return
  }
  currentView.value = 'search'
  scheduleSearch()
}

function stopPolling(): void {
  if (pollTimer !== undefined) {
    clearInterval(pollTimer)
    pollTimer = undefined
  }
}

function stopSearchTimer(): void {
  if (searchTimer !== undefined) {
    clearTimeout(searchTimer)
    searchTimer = undefined
  }
}

function resetSearchSections(): void {
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

function resetRoonRuntimeReferences(): void {
  resetRoonAlbums()
  resetRoonArtists()
  resetRoonGenres()
  resetRoonPlaylists()
  roonAlbumRequestGeneration += 1
  roonArtistRequestGeneration += 1
  roonGenreRequestGeneration += 1
  roonPlaylistRequestGeneration += 1
  selectedRoonAlbum.value = null
  selectedRoonAlbumPage.value = emptyRoonPage()
  roonAlbumInitialLoading.value = false
  roonAlbumLoadingMore.value = false
  roonAlbumLoadMoreError.value = null
  roonAlbumError.value = null
  roonAlbumFavoriteState.value = 'idle'
  selectedRoonArtist.value = null
  selectedRoonArtistPage.value = emptyRoonPage()
  roonArtistInitialLoading.value = false
  roonArtistLoadingMore.value = false
  roonArtistLoadMoreError.value = null
  roonArtistError.value = null
  roonArtistFavoriteState.value = 'idle'
  selectedRoonGenre.value = null
  selectedRoonGenrePage.value = emptyRoonPage()
  roonGenreInitialLoading.value = false
  roonGenreLoadingMore.value = false
  roonGenreLoadMoreError.value = null
  roonGenreError.value = null
  selectedRoonPlaylist.value = null
  selectedRoonPlaylistPage.value = emptyRoonPage()
  roonPlaylistInitialLoading.value = false
  roonPlaylistLoadingMore.value = false
  roonPlaylistLoadMoreError.value = null
  roonPlaylistError.value = null
  entityFavoriteOperation += 1
  roonQueueDescriptors.clear()
  roonQueueNeteaseMatches.clear()
  matchGeneration += 1
  matchStates.value = {}
  matchResults.value = {}
  cancelPendingMatches()
  if (aggregatedSearch.value) {
    aggregatedSearch.value = {
      ...aggregatedSearch.value,
      roon: emptyRoonPage(aggregatedSearch.value.roon.limit),
      roonAvailable: false,
    }
  }
  roonArtworkCache.clear()

  const activeSource = sidebar.activeSource.value
  const staleAlbumContext = activeSource.type === 'roon-album'
    || currentView.value === 'roon-album-detail'
    || nowPlayingReturnView.value === 'roon-album-detail'
  const staleArtistContext = activeSource.type === 'roon-artist'
    || currentView.value === 'roon-artist-detail'
    || nowPlayingReturnView.value === 'roon-artist-detail'
  const staleGenreContext = activeSource.type === 'roon-genre'
    || currentView.value === 'roon-genre-detail'
    || nowPlayingReturnView.value === 'roon-genre-detail'
  const stalePlaylistContext = activeSource.type === 'roon-playlist'
    || currentView.value === 'roon-playlist-detail'
    || nowPlayingReturnView.value === 'roon-playlist-detail'
  let fallbackView: ViewId | undefined
  if (staleAlbumContext) {
    sidebar.setActiveSource({ type: 'roon-albums' })
    fallbackView = 'roon-albums'
  } else if (staleArtistContext) {
    sidebar.setActiveSource({ type: 'roon-artists' })
    fallbackView = 'roon-artists'
  } else if (staleGenreContext) {
    sidebar.setActiveSource({ type: 'roon-genres' })
    fallbackView = 'roon-genres'
  } else if (stalePlaylistContext) {
    sidebar.setActiveSource({ type: 'roon-playlists' })
    fallbackView = 'roon-playlists'
  }
  if (fallbackView && currentView.value.endsWith('-detail')) {
    currentView.value = fallbackView
  }
  if (fallbackView && nowPlayingReturnView.value.endsWith('-detail')) {
    nowPlayingReturnView.value = fallbackView
  }
  if (searchReturnSource.value.type === 'roon-album') {
    searchReturnSource.value = { type: 'roon-albums' }
  } else if (searchReturnSource.value.type === 'roon-artist') {
    searchReturnSource.value = { type: 'roon-artists' }
  } else if (searchReturnSource.value.type === 'roon-genre') {
    searchReturnSource.value = { type: 'roon-genres' }
  } else if (searchReturnSource.value.type === 'roon-playlist') {
    searchReturnSource.value = { type: 'roon-playlists' }
  }
}

function refreshVisibleRoonCollection(): void {
  if (currentView.value === 'roon-albums' && !roonAlbumsInitialLoading.value) void loadRoonAlbums()
  if (currentView.value === 'roon-artists' && !roonArtistsInitialLoading.value) void loadRoonArtists()
  if (currentView.value === 'roon-genres' && !roonGenresInitialLoading.value) void loadRoonGenres()
  if (currentView.value === 'roon-playlists' && !roonPlaylistsInitialLoading.value) void loadRoonPlaylists()
}

function publicErrorCode(error: unknown): string | undefined {
  const code = readPublicIpcErrorCode(error)
  if (code) return code
  const message = error instanceof Error
    ? error.message
    : typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
      ? error.message
      : undefined
  if (message === 'Provider login required') return 'AUTH_REQUIRED'
  if (message === 'Provider session expired') return 'AUTH_EXPIRED'
  return undefined
}

function accountMessage(error: unknown): string {
  switch (publicErrorCode(error)) {
    case 'AUTH_REQUIRED':
    case 'AUTH_EXPIRED':
      return '音乐服务登录已失效，请重新登录。'
    case 'ACCOUNT_PROFILE_UNAVAILABLE':
      return '账户资料暂时不可用，登录状态仍然保留。'
    default:
      return '账户资料暂时不可用，请稍后重试。'
  }
}

function dailyMessage(error: unknown): string {
  switch (publicErrorCode(error)) {
    case 'AUTH_REQUIRED':
    case 'AUTH_EXPIRED':
      return '音乐服务登录已失效，请到设置重新登录。'
    default:
      return '每日推荐暂时不可用，请稍后重试。'
  }
}

function actionableMessage(error: unknown): string {
  switch (publicErrorCode(error)) {
    case 'AUTH_REQUIRED':
    case 'AUTH_EXPIRED':
      return '音乐服务登录已失效，请到设置重新登录。'
    case 'ROON_NOT_PAIRED':
    case 'ROON_CORE_NOT_CONNECTED':
      return 'Roon 尚未配对，请先确认 Roon Core 正在运行。'
    case 'ROON_ZONE_NOT_SELECTED':
      return '请先在设置选择播放设备。'
    case 'QUALITY_DOWNGRADED':
      return '当前请求质量已被安全降级，实际质量以 Signal Path 为准。'
    case 'ROON_ZONE_LOST':
      return '播放 Zone 暂时不可用，请检查 Roon 状态后重试。'
    case 'ROON_TIMEOUT':
      return 'Roon 未确认真实播放状态，请检查设备后重试。'
    case 'ROON_LIBRARY_UNAVAILABLE':
    case 'NOT_READY':
      return 'Roon Library 暂时不可用，请确认 Core 已配对并重试。'
    case 'ROON_LIBRARY_REQUEST_FAILED':
      return 'Roon Library 请求失败，请检查 Core 连接后重试。'
    case 'ROON_IMAGE_DECODE_FAILED':
      return 'Roon 封面解码失败，请重新打开页面。'
    case 'ROON_ALBUM_HIERARCHY_INVALID':
      return 'Roon 返回的专辑层级无效，请返回列表后重试。'
    case 'ROON_TRACK_ACTION_UNAVAILABLE':
      return '这首曲目的 Roon 播放操作不可用。'
    case 'ROON_LIBRARY_INVALID_REFERENCE':
    case 'INVALID_IPC_REQUEST':
      return '这个 Roon 条目已过期，请返回专辑列表后重新打开。'
    default:
      return '操作暂时不可用，请稍后重试。'
  }
}

function playbackIssueMessage(issue: { code: string; message: string }): string {
  return issue.code === 'QUALITY_DOWNGRADED' ? actionableMessage(issue) : issue.message
}

function recordActionError(error: unknown): void {
  actionError.value = actionableMessage(error)
  actionDiagnosticId.value =
    typeof error === 'object' && error !== null && 'diagnosticId' in error && typeof error.diagnosticId === 'string'
      ? error.diagnosticId
      : null
  showToast(actionError.value)
}

function libraryErrorKind(error: unknown): LibraryErrorKind {
  switch (publicErrorCode(error)) {
    case 'AUTH_REQUIRED':
      return 'auth-required'
    case 'AUTH_EXPIRED':
      return 'auth-expired'
    default:
      return 'generic'
  }
}

function searchErrorKind(error: unknown): SearchErrorKind {
  switch (publicErrorCode(error)) {
    case 'AUTH_REQUIRED':
      return 'auth-required'
    case 'AUTH_EXPIRED':
      return 'auth-expired'
    default:
      return 'generic'
  }
}

function searchSectionErrorKind(message: string): SearchErrorKind {
  if (message.includes('请先登录')) return 'auth-required'
  if (message.includes('登录已过期')) return 'auth-expired'
  return 'generic'
}

function roonLibraryMessage(error: unknown): string {
  return formatRoonLibraryMessage(error, {
    roonStatus: coreState.value?.roon,
    remoteCoreDevelopment: remoteCoreState.value.mode === 'remote-core-development',
  })
}

async function loadRoonAlbum(
  reference: string,
  page: PageRequest = { offset: 0, limit: 24 },
): Promise<void> {
  const album = [
    ...roonAlbumsPage.value.items,
    ...selectedRoonArtistPage.value.items,
    ...selectedRoonGenrePage.value.items,
  ].find((item) => item.reference === reference)
  if (album && album.kind === 'album') {
    selectedRoonAlbum.value = album
    void loadRoonEntityFavorite(album, 'album')
  }
  const initial = page.offset === 0
  if (initial) {
    roonAlbumRequestGeneration += 1
    roonAlbumInitialLoading.value = true
    roonAlbumLoadMoreError.value = null
    roonAlbumError.value = null
    selectedRoonAlbumPage.value = emptyRoonPage(page.limit)
  } else {
    if (roonAlbumLoadingMore.value) return
    roonAlbumLoadingMore.value = true
    roonAlbumLoadMoreError.value = null
  }
  const generation = roonAlbumRequestGeneration
  try {
    const result = await window.musicBridge.getRoonAlbumTracks(reference, page)
    if (generation !== roonAlbumRequestGeneration) return
    selectedRoonAlbumPage.value = initial ? result : appendRoonPage(selectedRoonAlbumPage.value, result)
    roonAlbumInitialLoading.value = false
    roonAlbumLoadingMore.value = false
    roonAlbumError.value = null
    currentView.value = 'roon-album-detail'
    sidebar.setActiveSource({ type: 'roon-album', reference })
  } catch (error) {
    if (generation !== roonAlbumRequestGeneration) return
    if (initial) {
      roonAlbumInitialLoading.value = false
      roonAlbumError.value = roonLibraryMessage(error)
    } else {
      roonAlbumLoadingMore.value = false
      roonAlbumLoadMoreError.value = '加载失败，点击重试'
    }
  }
}

async function loadRoonArtist(
  reference: string,
  page: PageRequest = { offset: 0, limit: 24 },
): Promise<void> {
  const artist = roonArtistsPage.value.items.find((item) => item.reference === reference)
  if (artist && artist.kind === 'artist') {
    selectedRoonArtist.value = artist
    void loadRoonEntityFavorite(artist, 'artist')
  }
  const initial = page.offset === 0
  if (initial) {
    roonArtistRequestGeneration += 1
    roonArtistInitialLoading.value = true
    roonArtistLoadMoreError.value = null
    roonArtistError.value = null
    selectedRoonArtistPage.value = emptyRoonPage(page.limit)
  } else {
    if (roonArtistLoadingMore.value) return
    roonArtistLoadingMore.value = true
    roonArtistLoadMoreError.value = null
  }
  const generation = roonArtistRequestGeneration
  try {
    const result = await window.musicBridge.getRoonArtistAlbums(reference, page)
    if (generation !== roonArtistRequestGeneration) return
    selectedRoonArtistPage.value = initial ? result : appendRoonPage(selectedRoonArtistPage.value, result)
    roonArtistInitialLoading.value = false
    roonArtistLoadingMore.value = false
    roonArtistError.value = null
    currentView.value = 'roon-artist-detail'
    sidebar.setActiveSource({ type: 'roon-artist', reference })
  } catch (error) {
    if (generation !== roonArtistRequestGeneration) return
    if (initial) {
      roonArtistInitialLoading.value = false
      roonArtistError.value = roonLibraryMessage(error)
    } else {
      roonArtistLoadingMore.value = false
      roonArtistLoadMoreError.value = '加载失败，点击重试'
    }
  }
}

async function loadRoonGenre(
  reference: string,
  page: PageRequest = { offset: 0, limit: 24 },
): Promise<void> {
  const genre = roonGenresPage.value.items.find((item) => item.reference === reference)
  if (genre?.kind === 'genre') selectedRoonGenre.value = genre
  const initial = page.offset === 0
  if (initial) {
    roonGenreRequestGeneration += 1
    roonGenreInitialLoading.value = true
    roonGenreLoadMoreError.value = null
    roonGenreError.value = null
    selectedRoonGenrePage.value = emptyRoonPage(page.limit)
  } else {
    if (roonGenreLoadingMore.value) return
    roonGenreLoadingMore.value = true
    roonGenreLoadMoreError.value = null
  }
  const generation = roonGenreRequestGeneration
  try {
    const result = await window.musicBridge.getRoonGenreItems(reference, page)
    if (generation !== roonGenreRequestGeneration) return
    selectedRoonGenrePage.value = initial ? result : appendRoonPage(selectedRoonGenrePage.value, result)
    roonGenreInitialLoading.value = false
    roonGenreLoadingMore.value = false
    roonGenreError.value = null
    currentView.value = 'roon-genre-detail'
    sidebar.setActiveSource({ type: 'roon-genre', reference })
  } catch (error) {
    if (generation !== roonGenreRequestGeneration) return
    if (initial) {
      roonGenreInitialLoading.value = false
      roonGenreError.value = roonLibraryMessage(error)
    } else {
      roonGenreLoadingMore.value = false
      roonGenreLoadMoreError.value = '加载失败，点击重试'
    }
  }
}

async function loadRoonPlaylist(
  reference: string,
  page: PageRequest = { offset: 0, limit: 24 },
): Promise<void> {
  const playlist = roonPlaylistsPage.value.items.find((item) => item.reference === reference)
  if (playlist?.kind === 'playlist') selectedRoonPlaylist.value = playlist
  const initial = page.offset === 0
  if (initial) {
    roonPlaylistRequestGeneration += 1
    roonPlaylistInitialLoading.value = true
    roonPlaylistLoadMoreError.value = null
    roonPlaylistError.value = null
    selectedRoonPlaylistPage.value = emptyRoonPage(page.limit)
  } else {
    if (roonPlaylistLoadingMore.value) return
    roonPlaylistLoadingMore.value = true
    roonPlaylistLoadMoreError.value = null
  }
  const generation = roonPlaylistRequestGeneration
  try {
    const result = await window.musicBridge.getRoonPlaylistTracks(reference, page)
    if (generation !== roonPlaylistRequestGeneration) return
    selectedRoonPlaylistPage.value = initial ? result : appendRoonPage(selectedRoonPlaylistPage.value, result)
    roonPlaylistInitialLoading.value = false
    roonPlaylistLoadingMore.value = false
    roonPlaylistError.value = null
    currentView.value = 'roon-playlist-detail'
    sidebar.setActiveSource({ type: 'roon-playlist', reference })
  } catch (error) {
    if (generation !== roonPlaylistRequestGeneration) return
    if (initial) {
      roonPlaylistInitialLoading.value = false
      roonPlaylistError.value = roonLibraryMessage(error)
    } else {
      roonPlaylistLoadingMore.value = false
      roonPlaylistLoadMoreError.value = '加载失败，点击重试'
    }
  }
}

function roonAlbumPageAt(offset: number): void {
  const album = selectedRoonAlbum.value
  if (album) void loadRoonAlbum(album.reference, { offset, limit: selectedRoonAlbumPage.value.limit })
}

function roonArtistPageAt(offset: number): void {
  const artist = selectedRoonArtist.value
  if (artist) void loadRoonArtist(artist.reference, { offset, limit: selectedRoonArtistPage.value.limit })
}

function roonGenrePageAt(offset: number): void {
  const genre = selectedRoonGenre.value
  if (genre) void loadRoonGenre(genre.reference, { offset, limit: selectedRoonGenrePage.value.limit })
}

function roonPlaylistPageAt(offset: number): void {
  const playlist = selectedRoonPlaylist.value
  if (playlist) void loadRoonPlaylist(playlist.reference, { offset, limit: selectedRoonPlaylistPage.value.limit })
}

async function loadRoonEntityFavorite(
  item: RoonLibraryItem,
  kind: 'album' | 'artist',
): Promise<void> {
  const operation = ++entityFavoriteOperation
  const state = kind === 'album' ? roonAlbumFavoriteState : roonArtistFavoriteState
  state.value = 'loading'
  try {
    const result = await window.musicBridge.checkFavorite(favoriteDescriptorForRoonItem(item))
    if (operation !== entityFavoriteOperation) return
    state.value = result.favorite ? 'liked' : 'not-liked'
  } catch (error) {
    if (operation === entityFavoriteOperation) state.value = 'error'
    recordActionError(error)
  }
}

async function toggleRoonEntityFavorite(kind: 'album' | 'artist'): Promise<void> {
  const item = kind === 'album' ? selectedRoonAlbum.value : selectedRoonArtist.value
  const state = kind === 'album' ? roonAlbumFavoriteState : roonArtistFavoriteState
  if (!item || item.kind !== kind || state.value === 'loading') return
  const operation = ++entityFavoriteOperation
  const nextFavorite = state.value !== 'liked'
  state.value = 'loading'
  try {
    const result = await window.musicBridge.setFavorite(
      favoriteDescriptorForRoonItem(item),
      nextFavorite,
    )
    if (operation !== entityFavoriteOperation) return
    state.value = result.favorite ? 'liked' : 'not-liked'
    const label = kind === 'album' ? '专辑' : '艺术家'
    showToast(nextFavorite ? `已加入本地${label}收藏` : `已取消本地${label}收藏`)
  } catch (error) {
    if (operation === entityFavoriteOperation) state.value = 'error'
    recordActionError(error)
  }
}

async function loadFavorites(
  kind: FavoriteKind = favoriteKind.value,
  page: PageRequest = { offset: 0, limit: LIBRARY_PAGE_SIZE },
): Promise<void> {
  const initial = page.offset === 0
  if (initial) {
    favoriteKind.value = kind
    favoritesRequestGeneration += 1
    favoritesInitialLoading.value = true
    favoritesLoadMoreError.value = null
    favoritesError.value = null
    favoritesPage.value = emptyFavoritePage(page.limit)
  } else {
    if (favoritesLoadingMore.value || kind !== favoriteKind.value) return
    favoritesLoadingMore.value = true
    favoritesLoadMoreError.value = null
  }
  const generation = favoritesRequestGeneration
  try {
    const result = await window.musicBridge.listFavorites(kind, page)
    if (generation !== favoritesRequestGeneration || kind !== favoriteKind.value) return
    favoritesPage.value = initial ? result : {
      ...result,
      items: [...favoritesPage.value.items, ...result.items.filter((item) => !favoritesPage.value.items.some((existing) => existing.favoriteId === item.favoriteId))],
    }
    favoritesInitialLoading.value = false
    favoritesLoadingMore.value = false
    favoritesError.value = null
    currentView.value = 'roon-favorites'
    sidebar.setActiveSource({ type: 'roon-favorites' })
  } catch (error) {
    if (generation !== favoritesRequestGeneration || kind !== favoriteKind.value) return
    if (initial) {
      favoritesInitialLoading.value = false
      favoritesError.value = roonLibraryMessage(error)
    } else {
      favoritesLoadingMore.value = false
      favoritesLoadMoreError.value = '加载失败，点击重试'
    }
  }
}

function setFavoriteKind(kind: FavoriteKind): void {
  if (favoriteKind.value === kind && favoritesPage.value.items.length) return
  void loadFavorites(kind)
}

function favoritesPageAt(offset: number): void {
  void loadFavorites(favoriteKind.value, { offset, limit: favoritesPage.value.limit })
}

function retryFavorites(): void {
  void loadFavorites(favoriteKind.value)
}

function retryRoonAlbum(): void {
  const album = selectedRoonAlbum.value
  if (album) void loadRoonAlbum(album.reference)
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
      const tracksForMatching = searchPage.value.items
      void loadRoonSearch(query, generation, searchPage.value).then(() => {
        if (generation === searchRequestGeneration) void matchTracks(tracksForMatching)
      })
    } else {
      const result = await window.musicBridge.searchTracks(query, page)
      if (generation !== searchRequestGeneration) return
      searchPage.value = appendPage(searchPage.value, result)
      if (aggregatedSearch.value) {
        aggregatedSearch.value = { ...aggregatedSearch.value, netease: searchPage.value }
      }
      void matchTracks(result.items)
      searchError.value = null
      searchLoadingMore.value = false
    }
  } catch (error) {
    if (generation !== searchRequestGeneration) return
    if (initial) {
      searchInitialLoading.value = false
      searchError.value = searchErrorKind(error)
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

async function loadRoonSearch(
  query: string,
  generation: number,
  netease: Page<TrackSummary>,
): Promise<void> {
  try {
    const roon = await window.musicBridge.searchRoonLibrary(query, {
      offset: 0,
      limit: LIBRARY_PAGE_SIZE,
    })
    if (generation !== searchRequestGeneration) return
    aggregatedSearch.value = { query, netease, roon, roonAvailable: true }
  } catch {
    if (generation !== searchRequestGeneration) return
    aggregatedSearch.value = {
      query,
      netease,
      roon: emptyRoonPage(LIBRARY_PAGE_SIZE),
      roonAvailable: false,
    }
  }
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
  if (!shouldPreloadSmartMatches(selectedZone.value?.zoneId, visible)) return
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
  aggregatedSearch.value = null
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

async function loadLiked(page: PageRequest = { offset: 0, limit: LIBRARY_PAGE_SIZE }): Promise<void> {
  if (authState.value.status !== 'authorized') {
    likedPage.value = emptyPage()
    likedInitialLoading.value = false
    likedLoadingMore.value = false
    return
  }
  if (!canLoadAuthorizedLibrary(
    authState.value.status,
    coreState.value?.runtime,
    remoteCoreState.value.status,
  )) {
    if (page.offset === 0) likedInitialLoading.value = true
    return
  }
  const initial = page.offset === 0
  if (initial) {
    likedRequestGeneration += 1
    likedInitialLoading.value = true
    likedLoadMoreError.value = null
  } else {
    if (likedLoadingMore.value) return
    likedLoadingMore.value = true
    likedLoadMoreError.value = null
  }
  const generation = likedRequestGeneration
  try {
    const result = await window.musicBridge.getLikedTracks(page)
    if (generation !== likedRequestGeneration) return
    likedPage.value = initial ? result : appendPage(likedPage.value, result)
    likedError.value = null
    if (initial) likedInitialLoading.value = false
    else likedLoadingMore.value = false
  } catch (error) {
    if (generation !== likedRequestGeneration) return
    if (initial) {
      likedInitialLoading.value = false
      likedError.value = libraryErrorKind(error)
    } else {
      likedLoadingMore.value = false
      likedLoadMoreError.value = '加载失败，点击重试'
    }
  }
}

async function loadDailyRecommendations(): Promise<void> {
  const operation = ++dailyOperation
  dailyError.value = null
  if (authState.value.status !== 'authorized') {
    dailyRecommendations.value = { dayKey: localDayKey(), tracks: [] }
    dailyState.value = 'empty'
    return
  }
  dailyState.value = 'loading'
  if (!canLoadAuthorizedLibrary(
    authState.value.status,
    coreState.value?.runtime,
    remoteCoreState.value.status,
  )) return
  try {
    const snapshot = await window.musicBridge.getDailyRecommendations()
    if (operation !== dailyOperation) return
    dailyRecommendations.value = snapshot
    void matchTracks(
      snapshot.tracks,
      currentView.value === 'home' || currentView.value === 'daily-recommendations',
    )
    dailyState.value = snapshot.tracks.length ? 'ready' : 'empty'
  } catch (error) {
    if (operation !== dailyOperation) return
    dailyRecommendations.value = { dayKey: localDayKey(), tracks: [] }
    dailyState.value = 'error'
    dailyError.value = dailyMessage(error)
  }
}

function selectAggregatedRoonItem(item: RoonLibraryItem): void {
  if (item.kind === 'track') {
    void playRoonLibraryTrack(item)
    return
  }
  if (item.kind === 'album') {
    selectedRoonAlbum.value = item
    void loadRoonEntityFavorite(item, 'album')
    navigateSource({ type: 'roon-album', reference: item.reference })
    return
  }
  if (item.kind === 'artist') {
    selectedRoonArtist.value = item
    void loadRoonEntityFavorite(item, 'artist')
    navigateSource({ type: 'roon-artist', reference: item.reference })
  }
}

async function loadAccountState(): Promise<void> {
  accountError.value = null
  if (!isCoreRuntimeStable(coreState.value?.runtime, remoteCoreState.value.status)) {
    accountState.value = authState.value.status === 'authorized'
      ? { status: 'loading' }
      : { status: 'missing' }
    return
  }
  try {
    const state = await window.musicBridge.getAccountState()
    accountState.value = state
  } catch (error) {
    accountState.value = { status: 'unavailable' }
    accountError.value = accountMessage(error)
  }
}

async function refreshAccountProfile(): Promise<void> {
  accountError.value = null
  try {
    accountState.value = await window.musicBridge.refreshAccountProfile()
    if (authState.value.status === 'authorized') void loadDailyRecommendations()
  } catch (error) {
    accountState.value = { status: 'unavailable' }
    accountError.value = accountMessage(error)
  }
}

async function loadPlaylists(): Promise<void> {
  if (authState.value.status !== 'authorized') {
    resetPlaylistSources()
    homePlaylistTracks.value = []
    homeRecommendationState.value = 'ready'
    return
  }
  if (!canLoadAuthorizedLibrary(
    authState.value.status,
    coreState.value?.runtime,
    remoteCoreState.value.status,
  )) {
    homeRecommendationState.value = 'loading'
    return
  }
  await loadPlaylistSources()
  const error = playlistError.value
  if (error) {
    homePlaylistTracks.value = []
    homeRecommendationState.value = 'error'
    return
  }
  await loadHomeRecommendations()
}

async function loadHomeRecommendations(): Promise<void> {
  const operation = ++homeRecommendationOperation
  homeRecommendationState.value = 'loading'
  const selections = selectRandomPlaylistPages(playlists.value)

  if (!selections.length) {
    homePlaylistTracks.value = []
    homeRecommendationState.value = 'ready'
    return
  }

  try {
    const settled = await settleHomePlaylistPages(
      selections.map((selection) => window.musicBridge.getPlaylist(selection.playlistId, selection.page)),
    )
    if (operation !== homeRecommendationOperation) return
    homePlaylistTracks.value = shuffleTracks(settled.tracks)
    homeRecommendationState.value = settled.successCount > 0 ? 'ready' : 'error'
  } catch {
    if (operation !== homeRecommendationOperation) return
    homePlaylistTracks.value = []
    homeRecommendationState.value = 'error'
  }
}

function refreshHomeRecommendations(): void {
  if (playlistState.value === 'ready') {
    void loadHomeRecommendations()
    return
  }
  void loadPlaylists()
}

function invalidateCollectionOperation(): void {
  collectionOperation += 1
  activeCollectionLoader?.cancel()
  activeCollectionLoader = undefined
  collectionPlaybackStartInFlight = false
}

async function loadPlaylist(
  playlistId: string,
  page: PageRequest = { offset: 0, limit: LIBRARY_PAGE_SIZE },
): Promise<void> {
  if (authState.value.status !== 'authorized') return
  const switchingPlaylist = selectedPlaylistId.value !== playlistId
  selectedPlaylistId.value = playlistId
  const previousPlaylist = selectedPlaylist.value
  const initial = page.offset === 0
  if (switchingPlaylist) {
    invalidateCollectionOperation()
    playlistRequestGeneration += 1
    selectedPlaylist.value = null
    playlistContentScrollTop.value = 0
    playlistTableScrollTop.value = 0
  }
  if (initial && !switchingPlaylist) playlistRequestGeneration += 1
  if (initial) {
    playlistInitialLoading.value = true
    playlistLoadMoreError.value = null
  } else {
    if (playlistLoadingMore.value) return
    playlistLoadingMore.value = true
    playlistLoadMoreError.value = null
  }
  const generation = playlistRequestGeneration
  try {
    const result = await window.musicBridge.getPlaylist(playlistId, page)
    if (generation !== playlistRequestGeneration || selectedPlaylistId.value !== playlistId) return
    selectedPlaylist.value = {
      ...result,
      tracks: initial ? result.tracks : appendPage(previousPlaylist?.tracks ?? null, result.tracks),
    }
    currentView.value = 'playlist-detail'
    sidebar.setActiveSource({ type: 'playlist', playlistId })
    playlistDetailError.value = null
    if (initial) playlistInitialLoading.value = false
    else playlistLoadingMore.value = false
  } catch (error) {
    if (generation !== playlistRequestGeneration || selectedPlaylistId.value !== playlistId) return
    if (initial) {
      playlistInitialLoading.value = false
      playlistDetailError.value = libraryErrorKind(error)
    } else {
      playlistLoadingMore.value = false
      playlistLoadMoreError.value = '加载失败，点击重试'
    }
  }
}

function retryPlaylist(): void {
  const playlistId = selectedPlaylistId.value
  if (playlistId) void loadPlaylist(playlistId)
}

function searchPageAt(offset: number): void {
  const query = searchQuery.value.trim()
  if (!query) return
  stopSearchTimer()
  void loadSearch(query, { offset, limit: LIBRARY_PAGE_SIZE }, searchRequestGeneration)
}

async function openSearchDetail(kind: 'artist' | 'album', id: string, title: string, subtitle: string): Promise<void> {
  searchScrollTop.value = contentScroll.value?.scrollTop ?? 0
  const operation = ++searchDetailGeneration
  searchDetail.value = {
    kind,
    title,
    subtitle,
    tracks: emptyPage(),
    loading: true,
    error: null,
  }
  try {
    if (kind === 'artist') {
      const detail = await window.musicBridge.getArtist(id, { offset: 0, limit: LIBRARY_PAGE_SIZE })
      if (operation !== searchDetailGeneration) return
      searchDetail.value = {
        kind,
        title: detail.name,
        subtitle: `${detail.albumCount ?? 0} 张专辑 · ${detail.trackCount ?? detail.tracks.total} 首歌曲`,
        tracks: detail.tracks,
        loading: false,
        error: null,
      }
      return
    }
    const detail = await window.musicBridge.getAlbum(id, { offset: 0, limit: LIBRARY_PAGE_SIZE })
    if (operation !== searchDetailGeneration) return
    searchDetail.value = {
      kind,
      title: detail.name,
      subtitle: `${detail.artistName} · ${detail.trackCount ?? detail.tracks.total} 首歌曲`,
      tracks: detail.tracks,
      loading: false,
      error: null,
    }
  } catch {
    if (operation !== searchDetailGeneration) return
    searchDetail.value = { kind, title, subtitle, tracks: emptyPage(), loading: false, error: '详情歌曲暂时不可用，请稍后重试。' }
  }
}

function closeSearchDetail(): void {
  searchDetailGeneration += 1
  searchDetail.value = null
  void nextTick(() => {
    contentScroll.value?.scrollTo({ top: searchScrollTop.value })
  })
}

function likedPageAt(offset: number): void {
  void loadLiked({ offset, limit: LIBRARY_PAGE_SIZE })
}

function playlistPageAt(offset: number): void {
  const playlistId = selectedPlaylist.value?.id
  if (playlistId) void loadPlaylist(playlistId, { offset, limit: LIBRARY_PAGE_SIZE })
}

function resetPrivateLibraryState(): void {
  stopSearchTimer()
  resetSearchSections()
  searchRequestGeneration += 1
  likedRequestGeneration += 1
  playlistRequestGeneration += 1
  invalidateCollectionOperation()
  searchQuery.value = ''
  searchPage.value = emptyPage()
  aggregatedSearch.value = null
  matchStates.value = {}
  matchResults.value = {}
  cancelPendingMatches()
  matchGeneration += 1
  searchInitialLoading.value = false
  searchLoadingMore.value = false
  searchLoadMoreError.value = null
  searchError.value = null
  likedPage.value = emptyPage()
  likedInitialLoading.value = false
  likedLoadingMore.value = false
  likedLoadMoreError.value = null
  likedError.value = null
  selectedPlaylist.value = null
  selectedPlaylistId.value = null
  playlistInitialLoading.value = false
  playlistLoadingMore.value = false
  playlistLoadMoreError.value = null
  playlistDetailError.value = null
  homePlaylistTracks.value = []
  homeRecommendationOperation += 1
  homeRecommendationState.value = 'ready'
  accountError.value = null
  dailyOperation += 1
  dailyRecommendations.value = { dayKey: localDayKey(), tracks: [] }
  dailyState.value = 'empty'
  dailyError.value = null
  recentTracks.value = []
  resetPlaylistSources()
}

function acceptsPolling(state: PublicAuthState): boolean {
  return state.status === 'waiting' || state.status === 'scanned'
}

function loadAuthorizedLibraryWhenReady(): void {
  if (
    authorizedLibraryLoadStarted
    || !canLoadAuthorizedLibrary(
      authState.value.status,
      coreState.value?.runtime,
      remoteCoreState.value.status,
    )
  ) return
  authorizedLibraryLoadStarted = true
  void loadAccountState()
  void loadLiked()
  void loadPlaylists()
  void loadDailyRecommendations()
}

function applyAuthState(state: PublicAuthState, operation = authOperation): void {
  if (operation !== authOperation) return
  authState.value = state
  if (!acceptsPolling(state)) stopPolling()
  if (state.status === 'authorized') {
    resetPrivateLibraryState()
    authorizedLibraryLoadStarted = false
    dailyState.value = 'loading'
    homeRecommendationState.value = 'loading'
    accountState.value = { status: 'loading' }
    loadAuthorizedLibraryWhenReady()
  } else if (state.status === 'idle' || state.status === 'cancelled' || state.status === 'expired') {
    authorizedLibraryLoadStarted = false
    resetPrivateLibraryState()
    accountState.value = { status: 'missing' }
    dailyRecommendations.value = { dayKey: localDayKey(), tracks: [] }
    dailyState.value = 'empty'
  }
}

async function pollQr(operation: number): Promise<void> {
  const challengeId = authState.value.challengeId
  if (!challengeId || pollInFlight || operation !== authOperation) return
  pollInFlight = true
  try {
    applyAuthState(await window.musicBridge.pollQrLogin(challengeId), operation)
  } catch (error) {
    if (operation === authOperation) {
      authError.value = true
      recordActionError(error)
    }
    stopPolling()
  } finally {
    pollInFlight = false
  }
}

function startPolling(): void {
  stopPolling()
  const operation = authOperation
  pollTimer = setInterval(() => void pollQr(operation), 2_000)
  void pollQr(operation)
}

async function beginQrLogin(): Promise<void> {
  authOperation += 1
  authError.value = false
  actionError.value = null
  stopPolling()
  try {
    const state = await window.musicBridge.beginQrLogin()
    applyAuthState(state)
    if (acceptsPolling(state)) startPolling()
  } catch (error) {
    authError.value = true
    recordActionError(error)
  }
}

async function cancelQrLogin(): Promise<void> {
  const challengeId = authState.value.challengeId
  if (!challengeId) return
  authOperation += 1
  stopPolling()
  try {
    applyAuthState(await window.musicBridge.cancelQrLogin(challengeId))
  } catch (error) {
    authError.value = true
    recordActionError(error)
  }
}

async function logout(): Promise<void> {
  if (!window.confirm('退出登录会停止播放、清空队列并移除本地账户状态。确定继续吗？')) return
  authOperation += 1
  authError.value = false
  stopPolling()
  try {
    applyAuthState(await window.musicBridge.logout())
    accountState.value = { status: 'missing' }
  } catch (error) {
    authError.value = true
    recordActionError(error)
  }
}

async function loadLyrics(trackId: string): Promise<void> {
  const operation = ++lyricsOperation
  lyricsSnapshot.value = emptyLyricsSnapshot('loading')
  try {
    const snapshot = await window.musicBridge.getLyrics(trackId)
    if (operation !== lyricsOperation || playbackState.value?.currentTrack?.id !== trackId) return
    lyricsSnapshot.value = snapshot
  } catch {
    if (operation === lyricsOperation) lyricsSnapshot.value = emptyLyricsSnapshot('error')
  }
}

async function selectLocalLyricsMatch(matchSessionId: string, candidateId: string): Promise<void> {
  if (localLyricsMatchBusy.value) return
  const revision = localLyricsMatchRevision
  localLyricsMatchBusy.value = true
  localLyricsMatchError.value = false
  try {
    const state = await window.musicBridge.selectLocalLyricsMatch(matchSessionId, candidateId)
    if (localLyricsMatchRevision === revision) localLyricsMatchState.value = state
  } catch (error) {
    if (localLyricsMatchRevision === revision) {
      localLyricsMatchError.value = true
      recordActionError(error)
    }
  } finally {
    localLyricsMatchBusy.value = false
  }
}

async function revokeLocalLyricsMatch(): Promise<void> {
  if (localLyricsMatchBusy.value) return
  const revision = localLyricsMatchRevision
  localLyricsMatchBusy.value = true
  localLyricsMatchError.value = false
  try {
    const state = await window.musicBridge.revokeLocalLyricsMatch()
    if (localLyricsMatchRevision === revision) localLyricsMatchState.value = state
  } catch (error) {
    if (localLyricsMatchRevision === revision) {
      localLyricsMatchError.value = true
      recordActionError(error)
    }
  } finally {
    localLyricsMatchBusy.value = false
  }
}

function resetLocalTrackFavorite(): void {
  localFavoriteOperation += 1
  localTrackFavoriteDescriptor.value = null
  localTrackFavoriteState.value = 'idle'
}

async function loadTrackLikeStatus(trackId: string): Promise<void> {
  const operation = ++trackLikeOperation
  const isRoonPlayback = playbackSource.value === 'roon'
  const hasNeteaseIdentity = !isRoonPlayback || nativeRoonHasNeteaseMatch.value
  const descriptor = isRoonPlayback ? localTrackFavoriteDescriptor.value : null
  trackLikeState.value = 'loading'
  neteaseTrackLiked.value = null
  if (descriptor) {
    localFavoriteOperation += 1
    localTrackFavoriteState.value = 'loading'
  } else {
    localTrackFavoriteState.value = 'idle'
  }
  try {
    const [neteaseResult, localResult] = await Promise.all([
      hasNeteaseIdentity
        ? window.musicBridge.getTrackLikeStatus(trackId)
        : Promise.resolve(undefined),
      descriptor
        ? window.musicBridge.checkFavorite(descriptor)
        : Promise.resolve(undefined),
    ])
    if (operation !== trackLikeOperation || playbackState.value?.currentTrack?.id !== trackId) return
    const neteaseLiked = neteaseResult?.liked ?? false
    const localLiked = localResult?.favorite ?? false
    neteaseTrackLiked.value = hasNeteaseIdentity ? neteaseLiked : null
    if (descriptor) localTrackFavoriteState.value = localLiked ? 'liked' : 'not-liked'
    trackLikeState.value = (isRoonPlayback ? localLiked || neteaseLiked : neteaseLiked)
      ? 'liked'
      : 'not-liked'
  } catch {
    if (operation === trackLikeOperation) {
      trackLikeState.value = 'error'
      if (descriptor) localTrackFavoriteState.value = 'error'
    }
  }
}

async function toggleTrackLike(): Promise<void> {
  const trackId = currentTrack.value?.id
  const descriptor = localTrackFavoriteDescriptor.value
  const isRoonPlayback = playbackSource.value === 'roon'
  const hasNeteaseIdentity = !isRoonPlayback || nativeRoonHasNeteaseMatch.value
  if (
    !trackId ||
    trackLikeState.value === 'loading' ||
    (!hasNeteaseIdentity && !descriptor)
  ) return
  const nextLiked = resolveFavoriteToggle({
    netease: neteaseTrackLiked.value === true,
    local: localTrackFavoriteState.value === 'liked',
  })
  const operation = ++trackLikeOperation
  trackLikeState.value = 'loading'
  localTrackFavoriteState.value = descriptor ? 'loading' : 'idle'
  try {
    const [neteaseResult, localResult] = await Promise.all([
      hasNeteaseIdentity
        ? window.musicBridge.setTrackLiked(trackId, nextLiked)
        : Promise.resolve(undefined),
      descriptor
        ? window.musicBridge.setFavorite(descriptor, nextLiked)
        : Promise.resolve(undefined),
    ])
    if (operation !== trackLikeOperation || playbackState.value?.currentTrack?.id !== trackId) return
    neteaseTrackLiked.value = neteaseResult?.liked ?? null
    if (descriptor) localTrackFavoriteState.value = nextLiked ? 'liked' : 'not-liked'
    trackLikeState.value = nextLiked ? 'liked' : 'not-liked'
    if (isRoonPlayback && hasNeteaseIdentity && descriptor) {
      showToast(nextLiked ? '已同步网易云与本地收藏' : '已取消网易云与本地收藏')
    } else if (isRoonPlayback && hasNeteaseIdentity) {
      showToast(nextLiked ? '已加入网易云喜欢的音乐' : '已取消网易云喜欢')
    } else if (isRoonPlayback) {
      showToast(nextLiked ? '已加入本地收藏' : '已取消本地收藏')
    } else {
      showToast(nextLiked ? '已加入网易云喜欢的音乐' : '已取消网易云喜欢')
    }
  } catch (error) {
    if (operation === trackLikeOperation) {
      trackLikeState.value = 'error'
      if (descriptor) localTrackFavoriteState.value = 'error'
    }
    recordActionError(error)
  }
}

function applyPlaybackState(snapshot: PlaybackSnapshot): void {
  const previousTrackId = playbackState.value?.currentTrack?.id
  const wasPlaying = playbackState.value?.state === 'playing'
  playbackState.value = snapshot
  const queueItem = snapshot.queue.items[snapshot.queue.index]
  const nextSource = snapshot.source ?? queueItem?.resolvedSource
  if (nextSource !== undefined) {
    const sourceChanged = playbackSource.value !== nextSource
    playbackSource.value = nextSource
    if (nextSource === 'roon') {
      const trackId = snapshot.currentTrack?.id ?? ''
      const localItem = snapshot.currentTrack
        ? roonQueueDescriptors.get(snapshot.currentTrack.id)
        : undefined
      const rememberedNeteaseMatch = roonQueueNeteaseMatches.has(trackId)
      nativeRoonHasNeteaseMatch.value = nativeRoonQueueItemHasNeteaseIdentity(
        queueItem,
        rememberedNeteaseMatch,
      )
      if (localItem) {
        localTrackFavoriteDescriptor.value = favoriteDescriptorForRoonItem(localItem)
      } else {
        resetLocalTrackFavorite()
      }
      if (sourceChanged) {
        neteaseTrackLiked.value = null
        trackLikeState.value = 'idle'
      }
    } else if (sourceChanged || !snapshot.currentTrack) {
      nativeRoonHasNeteaseMatch.value = false
      resetLocalTrackFavorite()
      neteaseTrackLiked.value = null
    }
  } else if (!snapshot.currentTrack) {
    playbackSource.value = 'netease'
    nativeRoonHasNeteaseMatch.value = false
    resetLocalTrackFavorite()
    neteaseTrackLiked.value = null
  }
  if (snapshot.state === 'playing' && snapshot.currentTrack && (!wasPlaying || previousTrackId !== snapshot.currentTrack.id)) {
    recentTracks.value = [
      snapshot.currentTrack,
      ...recentTracks.value.filter((track) => track.id !== snapshot.currentTrack?.id),
    ].slice(0, 6)
  }
  const trackId = snapshot.currentTrack?.id
  if (trackId && trackId !== previousTrackId) {
    if (playbackSource.value !== 'roon' || nativeRoonHasNeteaseMatch.value) void loadLyrics(trackId)
    void loadTrackLikeStatus(trackId)
  }
  else if (!trackId && previousTrackId) {
    lyricsOperation += 1
    lyricsSnapshot.value = emptyLyricsSnapshot()
    trackLikeOperation += 1
    trackLikeState.value = 'idle'
    neteaseTrackLiked.value = null
    resetLocalTrackFavorite()
  }
}

function applyNeteasePlayback(snapshot: PlaybackSnapshot): void {
  applyPlaybackState(snapshot)
}

async function refreshPlayback(): Promise<void> {
  try {
    applyPlaybackState(await window.musicBridge.getPlaybackState())
  } catch (error) {
    recordActionError(error)
  }
}

async function exportDiagnostics(): Promise<void> {
  diagnosticExportState.value = 'working'
  try {
    const result = await window.musicBridge.exportDiagnostics()
    diagnosticExportState.value = result.exported ? 'done' : 'cancelled'
  } catch (error) {
    diagnosticExportState.value = 'error'
    recordActionError(error)
  }
}

function showToast(message: string): void {
  toastMessage.value = message
  if (toastTimer !== undefined) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toastMessage.value = null
    toastTimer = undefined
  }, 2_400)
}

function queueItemsForTracks(tracks: readonly TrackSummary[]): PlaybackQueueRequestItem[] {
  return tracks.map((track) => {
    const match = matchResults.value[track.id]
    const candidate = confirmedRoonCandidate(match)
    if (candidate) rememberRoonQueueDescriptor(track.id, candidate, true)
    return {
      trackId: track.id,
      qualityPreference: selectedQuality.value,
      preferredSource: queuePreferenceForMatch(match),
    }
  })
}

function cloneTrackSummary(track: TrackSummary): TrackSummary {
  return {
    id: track.id,
    title: track.title,
    artists: [...track.artists],
    album: track.album,
    ...(track.durationMs !== undefined ? { durationMs: track.durationMs } : {}),
    ...(track.artworkUrl !== undefined ? { artworkUrl: track.artworkUrl } : {}),
    ...(track.artworkReference !== undefined
      ? { artworkReference: track.artworkReference }
      : {}),
  }
}

async function playTrack(track: TrackSummary): Promise<void> {
  if (playbackStartPending.value) return
  cancelRoonPlaybackPreparation()
  const rendererClickAtMs = Date.now()
  playbackStartPending.value = true
  actionError.value = null
  showToast('正在准备')
  try {
    const zoneId = selectedZone.value?.zoneId
    const cachedMatch = matchResults.value[track.id]
    const pendingMatch = zoneId && !cachedMatch
      ? pendingMatchRequests.get(track.id)
      : undefined
    const match = cachedMatch
      ?? (pendingMatch ? await waitForMatchWithinPlaybackBudget(pendingMatch) : undefined)
    const selection = immediatePlaybackSelection(
      match,
      zoneId,
    )
    if (selection.source === 'roon') {
      rememberRoonQueueDescriptor(track.id, selection.candidate, true)
      const snapshot = await window.musicBridge.replaceQueue([{
        trackId: track.id,
        qualityPreference: selectedQuality.value,
        preferredSource: 'smart',
      }], 0)
      applyPlaybackState(snapshot)
      showToast(snapshot.source === 'roon' ? '已使用 Roon 本地版本播放' : '本地版本不可用，已使用网易云播放')
      enterNowPlaying()
      return
    }
    applyNeteasePlayback(await window.musicBridge.play(track.id, selectedQuality.value, rendererClickAtMs))
    if (!matchResults.value[track.id]) void matchTracks([cloneTrackSummary(track)])
    enterNowPlaying()
  } catch (error) {
    recordActionError(error)
  } finally {
    playbackStartPending.value = false
  }
}

async function playRoonLibraryTrack(track: RoonLibraryItem): Promise<void> {
  const zoneId = selectedZone.value?.zoneId ?? playbackState.value?.selectedZoneId
  if (!zoneId) {
    if (zoneLifecycleStatus.value === 'loading') {
      actionError.value = '正在读取播放设备，请稍候。'
      return
    }
    recordActionError({ code: 'ROON_ZONE_NOT_SELECTED' })
    return
  }
  actionError.value = null
  const operation = ++roonPlaybackOperation
  // 在进入正在播放页面前捕获原浏览上下文，搜索/单曲入口不借用旧专辑。
  const context = currentView.value === 'roon-album-detail' && selectedRoonAlbum.value
    ? { page: selectedRoonAlbumPage.value, reference: selectedRoonAlbum.value.reference, load: window.musicBridge.getRoonAlbumTracks }
    : currentView.value === 'roon-playlist-detail' && selectedRoonPlaylist.value
      ? { page: selectedRoonPlaylistPage.value, reference: selectedRoonPlaylist.value.reference, load: window.musicBridge.getRoonPlaylistTracks }
      : currentView.value === 'roon-genre-detail' && selectedRoonGenre.value
        ? { page: selectedRoonGenrePage.value, reference: selectedRoonGenre.value.reference, load: window.musicBridge.getRoonGenreItems }
        : undefined
  const roonTrackId = roonTrackIdFromReference(track.reference)
  optimisticRoonTrackId = roonTrackId
  rememberRoonQueueDescriptor(roonTrackId, track)
  applyPlaybackState(createOptimisticRoonPlayback(track, zoneId, selectedQuality.value))
  enterNowPlaying()
  try {
    const tracks = await collectRoonPlaybackContext(track, context?.page,
      context ? (page) => context.load(context.reference, page) : undefined,
      () => operation === roonPlaybackOperation)
    if (operation !== roonPlaybackOperation) return
    for (const item of tracks) rememberRoonQueueDescriptor(roonTrackIdFromReference(item.reference), item)
    await window.musicBridge.playRoonTrack(track.reference, zoneId, tracks.map((item) => item.reference))
    if (operation !== roonPlaybackOperation) return
    optimisticRoonTrackId = undefined
    applyPlaybackState(await window.musicBridge.getPlaybackState())
  } catch (error) {
    if (operation !== roonPlaybackOperation) return
    optimisticRoonTrackId = undefined
    await refreshPlayback()
    if (operation !== roonPlaybackOperation) return
    recordActionError(error)
  }
}

async function queueRoonLibraryTrack(track: RoonLibraryItem): Promise<void> {
  const zoneId = selectedZone.value?.zoneId ?? playbackState.value?.selectedZoneId
  if (!zoneId) {
    if (zoneLifecycleStatus.value === 'loading') {
      actionError.value = '正在读取播放设备，请稍候。'
      return
    }
    recordActionError({ code: 'ROON_ZONE_NOT_SELECTED' })
    return
  }
  actionError.value = null
  try {
    const roonTrackId = roonTrackIdFromReference(track.reference)
    rememberRoonQueueDescriptor(roonTrackId, track)
    await window.musicBridge.queueRoonTrack(track.reference, zoneId)
    applyPlaybackState(await window.musicBridge.getPlaybackState())
    showToast('已将 Roon 曲目加入队列')
  } catch (error) {
    recordActionError(error)
  }
}

async function appendTrack(track: TrackSummary): Promise<void> {
  actionError.value = null
  try {
    applyNeteasePlayback(await window.musicBridge.appendQueue(queueItemsForTracks([track])))
    showToast('已加入播放队列')
  } catch (error) {
    recordActionError(error)
  }
}

async function insertTrackNext(track: TrackSummary): Promise<void> {
  actionError.value = null
  try {
    applyNeteasePlayback(await window.musicBridge.insertNext(queueItemsForTracks([track])))
    showToast('将在下一首播放')
  } catch (error) {
    recordActionError(error)
  }
}

async function continueCollectionQueue(
  loader: ProgressiveCollectionLoader,
  operation: number,
  pendingTracks: readonly TrackSummary[] = [],
): Promise<void> {
  try {
    if (pendingTracks.length > 0 && operation === collectionOperation) {
      applyPlaybackState(await window.musicBridge.appendQueue(queueItemsForTracks(pendingTracks)))
    }
    while (operation === collectionOperation) {
      const batch = await loader.next()
      if (!batch || operation !== collectionOperation) return
      if (batch.tracks.length > 0) {
        applyPlaybackState(await window.musicBridge.appendQueue(queueItemsForTracks(batch.tracks)))
      }
      if (!batch.hasMore) return
    }
  } catch (error) {
    // 后续分页失败不能终止已经开始的歌曲；只报告可重试的局部错误。
    if (operation === collectionOperation) recordActionError(error)
  } finally {
    if (activeCollectionLoader === loader) activeCollectionLoader = undefined
  }
}

async function replaceAndPlayCollection(
  loadPage: CollectionPageLoader,
  selectedTrackId?: string,
  initialPage?: Page<TrackSummary>,
  openNowPlaying = true,
): Promise<void> {
  if (collectionPlaybackStartInFlight || activeCollectionLoader) return
  cancelRoonPlaybackPreparation()
  collectionPlaybackStartInFlight = true
  const operation = ++collectionOperation
  actionError.value = null
  const loader = createProgressiveCollectionLoader(loadPage, LIBRARY_PAGE_SIZE, initialPage)
  activeCollectionLoader = loader
  try {
    const firstBatch = await loader.next()
    if (operation !== collectionOperation || !firstBatch || firstBatch.tracks.length === 0) {
      if (operation === collectionOperation) collectionPlaybackStartInFlight = false
      return
    }
    const initial = selectInitialCollectionPlayback(firstBatch.tracks, selectedTrackId)
    const snapshot = await window.musicBridge.replaceQueue(
      queueItemsForTracks(initial.tracks),
      initial.index,
    )
    if (operation !== collectionOperation) return
    applyPlaybackState(snapshot)
    if (openNowPlaying) enterNowPlaying()
    collectionPlaybackStartInFlight = false
    if (firstBatch.hasMore) {
      void continueCollectionQueue(loader, operation)
    } else {
      activeCollectionLoader = undefined
    }
  } catch (error) {
    if (operation === collectionOperation) recordActionError(error)
    if (operation === collectionOperation) {
      collectionPlaybackStartInFlight = false
      activeCollectionLoader = undefined
    }
  } finally {
    if (operation === collectionOperation && collectionPlaybackStartInFlight && activeCollectionLoader !== loader) {
      collectionPlaybackStartInFlight = false
    }
  }
}

async function appendCollection(loadPage: CollectionPageLoader): Promise<void> {
  const operation = ++collectionOperation
  activeCollectionLoader?.cancel()
  actionError.value = null
  const loader = createProgressiveCollectionLoader(loadPage, LIBRARY_PAGE_SIZE)
  activeCollectionLoader = loader
  try {
    const firstBatch = await loader.next()
    if (operation !== collectionOperation || !firstBatch || firstBatch.tracks.length === 0) return
    applyPlaybackState(await window.musicBridge.appendQueue(queueItemsForTracks(firstBatch.tracks)))
    showToast('已加入播放队列')
    if (firstBatch.hasMore) void continueCollectionQueue(loader, operation)
  } catch (error) {
    if (operation === collectionOperation) recordActionError(error)
  }
}

function playAllLiked(): void {
  void replaceAndPlayCollection(
    (page) => window.musicBridge.getLikedTracks(page),
    undefined,
    likedPage.value.items.length > 0 ? likedPage.value : undefined,
  )
}

function appendAllLiked(): void {
  void appendCollection((page) => window.musicBridge.getLikedTracks(page))
}

function playPlaylistTrack(track: TrackSummary): void {
  const playlistId = selectedPlaylistId.value
  if (!playlistId) return
  void replaceAndPlayCollection(
    (page) => window.musicBridge.getPlaylist(playlistId, page).then((detail) => detail.tracks),
    track.id,
    selectedPlaylist.value?.tracks.items.length ? selectedPlaylist.value.tracks : undefined,
    false,
  )
}

function playAllPlaylist(): void {
  const playlistId = selectedPlaylistId.value
  if (!playlistId) return
  void replaceAndPlayCollection(
    (page) => window.musicBridge.getPlaylist(playlistId, page).then((detail) => detail.tracks),
    undefined,
    selectedPlaylist.value?.tracks.items.length ? selectedPlaylist.value.tracks : undefined,
  )
}

function appendAllPlaylist(): void {
  const playlistId = selectedPlaylistId.value
  if (!playlistId) return
  void appendCollection(
    (page) => window.musicBridge.getPlaylist(playlistId, page).then((detail) => detail.tracks),
  )
}

async function playAllDailyRecommendations(): Promise<void> {
  if (!dailyRecommendations.value.tracks.length) return
  cancelRoonPlaybackPreparation()
  actionError.value = null
  const items = queueItemsForTracks(dailyRecommendations.value.tracks)
  try {
    applyNeteasePlayback(await window.musicBridge.replaceQueue(items, 0))
    enterNowPlaying()
  } catch (error) {
    recordActionError(error)
  }
}

async function playQueueItem(_item: PlaybackQueueItem, index: number): Promise<void> {
  const items = playbackState.value?.queue.items
  if (!items?.[index]) return
  cancelRoonPlaybackPreparation()
  try {
    applyPlaybackState(await window.musicBridge.playQueueIndex(index))
    enterNowPlaying()
  } catch (error) {
    recordActionError(error)
  }
}

async function togglePlayback(): Promise<void> {
  const snapshot = playbackState.value
  if (!snapshot) return
  if (snapshot.state === 'playing' && snapshot.canPause) {
    try {
      applyPlaybackState(await window.musicBridge.pause())
    } catch (error) {
      recordActionError(error)
    }
    return
  }
  if (snapshot.state === 'paused' && snapshot.canResume) {
    try {
      applyPlaybackState(await window.musicBridge.resume())
    } catch (error) {
      recordActionError(error)
    }
    return
  }
  if (snapshot.state === 'idle' && currentTrack.value) {
    await playTrack(currentTrack.value)
  }
}

async function stopPlayback(): Promise<void> {
  cancelRoonPlaybackPreparation()
  try {
    if (playbackSource.value === 'roon') {
      await window.musicBridge.stopRoonTransport()
      await refreshPlayback()
      return
    }
    applyNeteasePlayback(await window.musicBridge.stop())
  } catch (error) {
    recordActionError(error)
  }
}

async function nextTrack(): Promise<void> {
  cancelRoonPlaybackPreparation()
  try {
    applyNeteasePlayback(await window.musicBridge.next())
  } catch (error) {
    recordActionError(error)
  }
}

async function previousTrack(): Promise<void> {
  cancelRoonPlaybackPreparation()
  try {
    applyNeteasePlayback(await window.musicBridge.previous())
  } catch (error) {
    recordActionError(error)
  }
}

async function seekPlayback(positionMs: number): Promise<void> {
  const snapshot = playbackState.value
  const currentTrack = snapshot?.currentTrack
  if (
    !snapshot ||
    !currentTrack ||
    currentTrack.durationMs === undefined ||
    selectedZone.value?.seekAllowed !== true
  ) return
  try {
    await window.musicBridge.seek(positionMs)
    await refreshPlayback()
  } catch (error) {
    recordActionError(error)
    await refreshPlayback()
  }
}

async function loadZones(): Promise<void> {
  await zoneRefreshCoordinator.refreshNow()
}

async function selectZone(zoneId: string): Promise<void> {
  cancelRoonPlaybackPreparation()
  try {
    coreState.value = await window.musicBridge.selectZone(zoneId)
    await loadZones()
    await refreshPlayback()
  } catch (error) {
    recordActionError(error)
  }
}

function updateRemoteAutoStart(value: boolean): void {
  remoteAutoStart.value = value
  window.localStorage.setItem('musicbridge.remoteCore.autoStart', value ? '1' : '0')
}

function updateRemoteSshTarget(value: string): void {
  if (value.length > 255) return
  remoteSshTarget.value = value
  window.localStorage.setItem('musicbridge.remoteCore.sshTarget', value)
}

async function startRemoteCore(): Promise<void> {
  actionError.value = null
  try {
    remoteCoreState.value = await window.musicBridge.startRemoteCore(remoteSshTarget.value)
  } catch (error) {
    recordActionError(error)
  }
}

async function stopRemoteCore(): Promise<void> {
  cancelRoonPlaybackPreparation()
  actionError.value = null
  try {
    remoteCoreState.value = await window.musicBridge.stopRemoteCore()
  } catch (error) {
    recordActionError(error)
  }
}

async function reconnectRemoteCore(): Promise<void> {
  actionError.value = null
  try {
    remoteCoreState.value = await window.musicBridge.reconnectRemoteCore()
  } catch (error) {
    recordActionError(error)
  }
}

function rememberInspectorFocus(): void {
  const active = document.activeElement
  inspectorReturnFocus.value = active instanceof HTMLElement && !active.closest('.playback-inspector')
    ? active
    : null
}

function openInspector(): void {
  rememberInspectorFocus()
  if (isImmersiveNowPlaying.value) exitNowPlaying()
  inspectorOpen.value = true
  void nextTick(() => document.querySelector<HTMLElement>('.playback-inspector .inspector-close')?.focus())
}

function openQueue(): void {
  openInspector()
}

function closeInspector(): void {
  inspectorOpen.value = false
  const target = inspectorReturnFocus.value
  inspectorReturnFocus.value = null
  if (target?.isConnected) void nextTick(() => target.focus())
}

function openNowPlaying(): void {
  enterNowPlaying()
}

function navigateShortcut(source: SidebarSource): void {
  navigateSource(source)
}

function onGlobalShortcut(event: KeyboardEvent): void {
  if (event.key === 'Escape' && isImmersiveNowPlaying.value) {
    event.preventDefault()
    exitNowPlaying()
    return
  }
  if (event.key === 'Escape' && inspectorOpen.value) {
    event.preventDefault()
    closeInspector()
    return
  }
  if (event.key === 'Escape' && searchQuery.value) {
    event.preventDefault()
    clearSearch()
    return
  }
  if (!event.metaKey || event.altKey || event.ctrlKey) return

  const key = event.key.toLowerCase()
  if (event.shiftKey && key === 'l') {
    event.preventDefault()
    enterNowPlaying()
    return
  }
  if (event.shiftKey && key === 'q') {
    event.preventDefault()
    openQueue()
    return
  }
  if (event.shiftKey) return

  if (key === '1') {
    event.preventDefault()
    navigateShortcut({ type: 'home' })
  } else if (key === '2') {
    event.preventDefault()
    navigateShortcut({ type: 'liked' })
  } else if (key === '3') {
    event.preventDefault()
    navigateShortcut({ type: 'playlists' })
  }
}

async function retryAction(): Promise<void> {
  const track = currentTrack.value
  if (track) await playTrack(track)
  else await refreshPlayback()
}

function qualityLabel(quality: string | undefined): string {
  if (!quality) return '—'
  if (quality === 'auto') return '自动（当前歌曲最高）'
  if (quality === 'unknown') return '未知（以 Roon Signal Path 为准）'
  return quality === 'hires' ? 'Hi-Res' : quality[0].toUpperCase() + quality.slice(1)
}

function setSelectedQuality(preference: PlaybackQualityPreference): void {
  selectedQuality.value = preference
  window.localStorage.setItem('musicbridge.qualityPreference', preference)
}

onMounted(async () => {
  window.addEventListener('keydown', onGlobalShortcut)
  removeAppCommandListener = window.musicBridge.onAppCommand((command) => {
    if (command === 'show-queue') openQueue()
  })
  removeRemoteCoreListener = window.musicBridge.onRemoteCoreEvent((state) => {
    const previousStatus = remoteCoreState.value.status
    remoteCoreState.value = state
    if (state.sshTarget) remoteSshTarget.value = state.sshTarget
    if (previousStatus === 'ready' && state.status !== 'ready') resetRoonRuntimeReferences()
    if (state.status !== 'ready' && coreState.value) {
      coreState.value = { ...coreState.value, roon: 'disconnected' }
    }
    zoneRefreshCoordinator.handleRemoteCoreState(state.status)
    if (['checking', 'starting', 'reconnecting', 'stopping'].includes(state.status)) {
      authorizedLibraryLoadStarted = false
    } else {
      loadAuthorizedLibraryWhenReady()
    }
  })
  removeCoreListener = window.musicBridge.onCoreEvent((event) => {
    const previousRoonStatus = coreState.value?.roon
    if (
      event.event === 'core.ready'
      || (event.event === 'roon.changed'
        && previousRoonStatus === 'ready'
        && event.payload.state.roon !== 'ready')
    ) {
      resetRoonRuntimeReferences()
    }
    if (event.event === 'core.ready' || event.event === 'core.health' || event.event === 'roon.changed') {
      coreState.value = event.payload.state
      if (event.payload.state.runtime !== 'ready') authorizedLibraryLoadStarted = false
    }
    if (event.event === 'core.ready') {
      authorizedLibraryLoadStarted = false
      loadAuthorizedLibraryWhenReady()
    }
    if (
      (event.event === 'core.ready' || event.event === 'roon.changed')
      && isCoreRuntimeStable(event.payload.state.runtime, remoteCoreState.value.status)
    ) {
      zoneRefreshCoordinator.handleCoreEvent(event.event, event.payload.state.roon)
    }
    if (
      (event.event === 'core.ready' || event.event === 'roon.changed')
      && isCoreRuntimeStable(event.payload.state.runtime, remoteCoreState.value.status)
      && shouldRefreshVisibleRoonCollection(
        event.event,
        previousRoonStatus,
        event.payload.state.roon,
      )
    ) {
      refreshVisibleRoonCollection()
    }
    if (event.event === 'auth.changed') {
      authEventReceived = true
      applyAuthState(event.payload.state)
    }
    if (event.event === 'account.changed') {
      accountState.value = event.payload.state
      if (
        event.payload.state.status === 'ready'
        && canLoadAuthorizedLibrary(
          authState.value.status,
          coreState.value?.runtime,
          remoteCoreState.value.status,
        )
      ) {
        void loadDailyRecommendations()
      }
      if (
        event.payload.state.status === 'missing'
        && (
          authState.value.status !== 'authorized'
          || coreState.value?.runtime === 'ready'
        )
      ) {
        resetPrivateLibraryState()
        dailyRecommendations.value = { dayKey: localDayKey(), tracks: [] }
        dailyState.value = 'empty'
      }
    }
    if (event.event === 'playback.changed') {
      const snapshot = event.payload.state
      if (
        optimisticRoonTrackId === undefined
        || (
          snapshot.state === 'playing'
          && snapshot.source === 'roon'
          && snapshot.currentTrack?.id === optimisticRoonTrackId
        )
      ) {
        optimisticRoonTrackId = undefined
        applyPlaybackState(snapshot)
      }
    }
    if (event.event === 'lyrics.changed') lyricsSnapshot.value = event.payload.state
    if (event.event === 'lyrics.match.changed') {
      localLyricsMatchRevision += 1
      localLyricsMatchState.value = event.payload.state
      localLyricsMatchError.value = false
    }
    if (event.event === 'diagnostic.notice') diagnosticNotice.value = event.payload
  })
  const initialLocalLyricsMatchRevision = localLyricsMatchRevision
  void window.musicBridge.getLocalLyricsMatch()
    .then((state) => {
      if (localLyricsMatchRevision === initialLocalLyricsMatchRevision) localLyricsMatchState.value = state
    })
    .catch(() => {
      if (localLyricsMatchRevision === initialLocalLyricsMatchRevision) {
        localLyricsMatchState.value = emptyLocalLyricsMatchSnapshot()
      }
    })
  try {
    appInfo.value = await window.musicBridge.getAppInfo()
    const storedQuality = window.localStorage.getItem('musicbridge.qualityPreference')
    if (['auto', 'standard', 'exhigh', 'lossless', 'hires'].includes(storedQuality ?? '')) {
      selectedQuality.value = storedQuality as PlaybackQualityPreference
    }
    remoteCoreState.value = await window.musicBridge.getRemoteCoreState()
    remoteSshTarget.value = remoteCoreState.value.sshTarget
      ?? window.localStorage.getItem('musicbridge.remoteCore.sshTarget')
      ?? ''
    remoteAutoStart.value = window.localStorage.getItem('musicbridge.remoteCore.autoStart') === '1'
    if (remoteAutoStart.value && remoteSshTarget.value && remoteCoreState.value.status === 'idle') {
      // 先在 Renderer 内标记切换中，避免隧道事件抵达前抢跑旧 Core 请求。
      remoteCoreState.value = { ...remoteCoreState.value, status: 'checking' }
      void startRemoteCore()
    }
    coreState.value = await window.musicBridge.getCoreHealth()
    const initialAuthState = await window.musicBridge.getAuthState()
    if (!authEventReceived) applyAuthState(initialAuthState)
    else loadAuthorizedLibraryWhenReady()
    if (initialAuthState.status !== 'authorized') await loadAccountState()
    if (isCoreRuntimeStable(coreState.value.runtime, remoteCoreState.value.status)) {
      applyPlaybackState(await window.musicBridge.getPlaybackState())
      await loadZones()
    }
  } catch (error) {
    coreError.value = true
    recordActionError(error)
  }
})

onUnmounted(() => {
  window.removeEventListener('keydown', onGlobalShortcut)
  removeCoreListener?.()
  removeAppCommandListener?.()
  removeRemoteCoreListener?.()
  zoneRefreshCoordinator.dispose()
  roonArtworkCache.clear()
  stopPolling()
  stopSearchTimer()
  inspectorReturnFocus.value = null
  if (toastTimer !== undefined) window.clearTimeout(toastTimer)
})
</script>

<template>
  <main class="app-shell" :class="{ 'is-now-playing': isImmersiveNowPlaying }" data-ui-reference="simple-music-player-2">
    <AlbumAmbientBackground :current-track="currentTrack" />
    <div class="app-main">
      <MusicSidebar
        v-if="!isImmersiveNowPlaying"
        :expanded="sidebar.expanded.value"
        :active-source="sidebar.activeSource.value"
        :search-query="searchQuery"
        :playlists="playlists"
        :playlist-state="playlistState"
        :source-scroll-top="sidebar.sourceScrollTop.value"
        :settings-active="currentView === 'settings'"
        @toggle="sidebar.toggleExpanded"
        @navigate="navigateSource"
        @update:search-query="updateSearchQuery"
        @clear-search="clearSearch"
        @retry-playlists="loadPlaylists"
        @scroll-source="sidebar.setSourceScrollTop"
        @settings="navigate('settings')"
      />

      <section class="workspace" :class="{ 'is-immersive': isImmersiveNowPlaying }">
      <div class="workspace-body" :class="{ 'is-immersive': isImmersiveNowPlaying }">
      <div ref="contentScroll" class="content-scroll" :class="{ 'is-immersive': isImmersiveNowPlaying }">
        <HomeView
          v-if="currentView === 'home'"
          :liked-tracks="likedPage.items"
          :recent-tracks="homeTracks"
          :liked-state="likedHomeState"
          :liked-error="likedError"
          :playlist-tracks="homePlaylistTracks"
          :playlist-recommendations-state="homeRecommendationState"
          :daily-day-key="dailyRecommendations.dayKey"
          :daily-tracks="dailyRecommendations.tracks"
          :daily-state="dailyState"
          :daily-authenticated="authState.status === 'authorized'"
          :daily-error="dailyError"
          :greeting="greeting"
          @navigate="navigate"
          @play="playTrack"
          @refresh-playlists="refreshHomeRecommendations"
          @play-daily="playTrack"
          @play-all-daily="playAllDailyRecommendations"
          @view-all-daily="navigate('daily-recommendations')"
          @open-settings="navigate('settings')"
          @retry-daily="refreshAccountProfile"
        />

        <CollectionView
          v-else-if="currentView === 'collection'"
          v-model="collectionView"
        />

        <RecordingView
          v-else-if="currentView === 'recording'"
          :reload-required="recordingReloadRequired"
          @reload-required="recordingReloadRequired = true"
          @open-collection="openTapeCollection"
        />

        <DailyRecommendationsView
          v-else-if="currentView === 'daily-recommendations'"
          :day-key="dailyRecommendations.dayKey"
          :tracks="dailyRecommendations.tracks"
          :state="dailyState"
          :error="dailyError"
          @back="navigate('home')"
          @play="playTrack"
          @queue="appendTrack"
          @play-all="playAllDailyRecommendations"
          @retry="refreshAccountProfile"
        />

        <section v-else-if="currentView === 'roon-albums'" class="view" aria-labelledby="roon-albums-heading">
          <div class="view-heading">
            <div><p class="section-kicker">本地音乐库</p><h2 id="roon-albums-heading">专辑</h2><p class="lede">只显示 Roon Library 中的真实专辑，不扫描本地文件系统。</p></div>
          </div>
          <RoonAlbumGrid
            :page="roonAlbumsPage"
            :initial-loading="roonAlbumsInitialLoading"
            :loading-more="roonAlbumsLoadingMore"
            :load-more-error="roonAlbumsLoadMoreError"
            :error="roonAlbumsError"
            @select="navigateSource({ type: 'roon-album', reference: $event.reference })"
            @retry="retryRoonAlbums"
            @load-more="loadMoreRoonAlbums"
          />
        </section>

        <section v-else-if="currentView === 'roon-artists'" class="view" aria-labelledby="roon-artists-heading">
          <div class="view-heading"><div><p class="section-kicker">本地音乐库</p><h2 id="roon-artists-heading">艺术家</h2><p class="lede">选择艺术家后读取其真实 Roon 专辑层级。</p></div></div>
          <RoonEntityGrid
            :page="roonArtistsPage"
            entity-label="艺术家"
            empty-title="还没有可显示的艺术家"
            empty-copy="Roon Core 当前返回 0 位艺术家。请在 Roon 中检查存储位置与资料库内容后重新读取。"
            :initial-loading="roonArtistsInitialLoading"
            :loading-more="roonArtistsLoadingMore"
            :load-more-error="roonArtistsLoadMoreError"
            :error="roonArtistsError"
            @select="navigateSource({ type: 'roon-artist', reference: $event.reference })"
            @retry="retryRoonArtists"
            @load-more="loadMoreRoonArtists"
          />
        </section>

        <section v-else-if="currentView === 'roon-genres'" class="view" aria-labelledby="roon-genres-heading">
          <div class="view-heading"><div><p class="section-kicker">本地音乐库</p><h2 id="roon-genres-heading">流派</h2><p class="lede">选择流派后读取其中真实的专辑与曲目。</p></div></div>
          <RoonEntityGrid
            :page="roonGenresPage"
            entity-label="流派"
            empty-title="还没有可显示的流派"
            empty-copy="Roon Core 当前返回 0 个流派。请在 Roon 中检查存储位置与资料库内容后重新读取。"
            :initial-loading="roonGenresInitialLoading"
            :loading-more="roonGenresLoadingMore"
            :load-more-error="roonGenresLoadMoreError"
            :error="roonGenresError"
            @select="navigateSource({ type: 'roon-genre', reference: $event.reference })"
            @retry="retryRoonGenres"
            @load-more="loadMoreRoonGenres"
          />
        </section>

        <section v-else-if="currentView === 'roon-playlists'" class="view" aria-labelledby="roon-playlists-heading">
          <div class="view-heading"><div><p class="section-kicker">本地音乐库</p><h2 id="roon-playlists-heading">Roon 歌单</h2><p class="lede">选择歌单后读取真实 Roon Playlist 曲目。</p></div></div>
          <RoonEntityGrid
            :page="roonPlaylistsPage"
            entity-label="歌单"
            empty-title="还没有可显示的 Roon 歌单"
            empty-copy="Roon Core 当前返回 0 个歌单。请在 Roon 中检查存储位置与资料库内容后重新读取。"
            :initial-loading="roonPlaylistsInitialLoading"
            :loading-more="roonPlaylistsLoadingMore"
            :load-more-error="roonPlaylistsLoadMoreError"
            :error="roonPlaylistsError"
            @select="navigateSource({ type: 'roon-playlist', reference: $event.reference })"
            @retry="retryRoonPlaylists"
            @load-more="loadMoreRoonPlaylists"
          />
        </section>

        <section v-else-if="currentView === 'roon-favorites'" class="view" aria-labelledby="roon-favorites-heading">
          <div class="view-heading"><div><p class="section-kicker">本地音乐库</p><h2 id="roon-favorites-heading">收藏</h2><p class="lede">收藏关系由 MusicBridge 本地保存，不会删除或移动 Roon Library 媒体。</p></div></div>
          <div class="button-row favorite-kind-tabs" role="tablist" aria-label="本地收藏分类">
            <button type="button" class="secondary-button" :class="{ 'is-selected': favoriteKind === 'track' }" role="tab" :aria-selected="favoriteKind === 'track'" @click="setFavoriteKind('track')">喜欢的歌曲</button>
            <button type="button" class="secondary-button" :class="{ 'is-selected': favoriteKind === 'album' }" role="tab" :aria-selected="favoriteKind === 'album'" @click="setFavoriteKind('album')">喜欢的专辑</button>
            <button type="button" class="secondary-button" :class="{ 'is-selected': favoriteKind === 'artist' }" role="tab" :aria-selected="favoriteKind === 'artist'" @click="setFavoriteKind('artist')">喜欢的艺术家</button>
          </div>
          <FavoriteEntityGrid
            :page="favoritesPage"
            :kind="favoriteKind"
            :initial-loading="favoritesInitialLoading"
            :loading-more="favoritesLoadingMore"
            :load-more-error="favoritesLoadMoreError"
            :error="favoritesError"
            @retry="retryFavorites"
            @load-more="favoritesPageAt(favoritesPage.offset + favoritesPage.limit)"
          />
        </section>

        <section v-else-if="currentView === 'roon-artist-detail' && selectedRoonArtist" class="view" aria-labelledby="roon-artist-heading">
          <button type="button" class="back-link" @click="navigateSource({ type: 'roon-artists' })">← 艺术家</button>
          <div class="view-heading"><div><p class="section-kicker">Roon 艺术家</p><h2 id="roon-artist-heading">{{ selectedRoonArtist.title }}</h2><p class="lede">只显示该艺术家在 Roon Library 中的真实专辑。</p><button type="button" class="secondary-button detail-favorite-button" :disabled="roonArtistFavoriteState === 'loading'" :aria-pressed="roonArtistFavoriteState === 'liked'" @click="toggleRoonEntityFavorite('artist')">{{ roonArtistFavoriteState === 'liked' ? '♥ 已收藏' : '♡ 收藏艺术家' }}</button></div></div>
          <RoonAlbumGrid
            :page="selectedRoonArtistPage"
            :initial-loading="roonArtistInitialLoading"
            :loading-more="roonArtistLoadingMore"
            :load-more-error="roonArtistLoadMoreError"
            :error="roonArtistError"
            @select="navigateSource({ type: 'roon-album', reference: $event.reference })"
            @retry="loadRoonArtist(selectedRoonArtist.reference)"
            @load-more="roonArtistPageAt(selectedRoonArtistPage.offset + selectedRoonArtistPage.limit)"
          />
        </section>

        <RoonAlbumDetail
          v-else-if="currentView === 'roon-album-detail' && selectedRoonAlbum"
          :album="selectedRoonAlbum"
          :page="selectedRoonAlbumPage"
          :initial-loading="roonAlbumInitialLoading"
          :loading-more="roonAlbumLoadingMore"
          :load-more-error="roonAlbumLoadMoreError"
          :error="roonAlbumError"
          :favorite-state="roonAlbumFavoriteState"
          @back="navigateSource({ type: 'roon-albums' })"
          @play="playRoonLibraryTrack"
          @queue="queueRoonLibraryTrack"
          @toggle-favorite="toggleRoonEntityFavorite('album')"
          @retry="retryRoonAlbum"
          @load-more="roonAlbumPageAt(selectedRoonAlbumPage.offset + selectedRoonAlbumPage.limit)"
        />

        <RoonBrowseDetail
          v-else-if="currentView === 'roon-genre-detail' && selectedRoonGenre"
          :entity="selectedRoonGenre"
          :page="selectedRoonGenrePage"
          mode="genre"
          :initial-loading="roonGenreInitialLoading"
          :loading-more="roonGenreLoadingMore"
          :load-more-error="roonGenreLoadMoreError"
          :error="roonGenreError"
          @back="navigateSource({ type: 'roon-genres' })"
          @album="selectAggregatedRoonItem"
          @play="playRoonLibraryTrack"
          @queue="queueRoonLibraryTrack"
          @retry="loadRoonGenre(selectedRoonGenre.reference)"
          @load-more="roonGenrePageAt(selectedRoonGenrePage.offset + selectedRoonGenrePage.limit)"
        />

        <RoonBrowseDetail
          v-else-if="currentView === 'roon-playlist-detail' && selectedRoonPlaylist"
          :entity="selectedRoonPlaylist"
          :page="selectedRoonPlaylistPage"
          mode="playlist"
          :initial-loading="roonPlaylistInitialLoading"
          :loading-more="roonPlaylistLoadingMore"
          :load-more-error="roonPlaylistLoadMoreError"
          :error="roonPlaylistError"
          @back="navigateSource({ type: 'roon-playlists' })"
          @play="playRoonLibraryTrack"
          @queue="queueRoonLibraryTrack"
          @retry="loadRoonPlaylist(selectedRoonPlaylist.reference)"
          @load-more="roonPlaylistPageAt(selectedRoonPlaylistPage.offset + selectedRoonPlaylistPage.limit)"
        />

        <section v-else-if="currentView === 'search'" class="view view-search" aria-labelledby="search-heading">
          <div class="view-heading"><div><p class="section-kicker">搜索</p><h2 id="search-heading">搜索结果</h2><p class="lede">“{{ searchQuery }}”</p></div></div>
          <template v-if="searchDetail">
            <button type="button" class="back-link" @click="closeSearchDetail">← 返回搜索结果</button>
            <div class="search-detail-hero">
              <div><p class="section-kicker">{{ searchDetail.kind === 'artist' ? '艺人详情' : '专辑详情' }}</p><h3>{{ searchDetail.title }}</h3><p class="lede">{{ searchDetail.subtitle }}</p></div>
            </div>
            <div v-if="searchDetail.loading" class="empty-state"><span class="loading-line"></span><p>正在读取歌曲…</p></div>
            <p v-else-if="searchDetail.error" class="persistent-error">{{ searchDetail.error }}</p>
            <TrackTable
              v-else
              :tracks="searchDetail.tracks.items"
              :busy="playbackStartPending"
              :match-states="matchStates"
              :total="searchDetail.tracks.total"
              :has-more="searchDetail.tracks.hasMore"
              empty-title="没有可显示的歌曲"
              empty-copy="Provider 暂时没有返回此项的歌曲。"
              @play="playTrack"
              @queue="appendTrack"
              @play-next="insertTrackNext"
            />
          </template>
          <template v-else>
            <section class="search-result-section" aria-labelledby="search-artists-heading">
              <div class="search-section-heading"><h3 id="search-artists-heading">艺人</h3><span v-if="searchArtistsState === 'ready'">{{ searchArtistsPage.total }} 位</span></div>
              <div v-if="searchArtistsState === 'loading'" class="search-card-grid search-card-grid-artists"><div v-for="index in 3" :key="index" class="search-card-skeleton" aria-hidden="true"></div></div>
              <p v-else-if="searchArtistsState === 'error'" class="persistent-error">{{ searchArtistsError }}</p>
              <div v-else-if="searchArtistsPage.items.length" class="search-card-grid search-card-grid-artists" role="list">
                <button v-for="artist in searchArtistsPage.items" :key="artist.id" type="button" class="search-artist-card" role="listitem" @click="openSearchDetail('artist', artist.id, artist.name, `${artist.albumCount ?? 0} 张专辑 · ${artist.trackCount ?? 0} 首歌曲`)">
                  <SafeArtwork class="search-artist-art" :src="artist.artworkUrl" :alt="`${artist.name} 头像`" loading="lazy" fallback="♩" />
                  <span><strong>{{ artist.name }}</strong><small>{{ artist.albumCount ?? 0 }} 张专辑 · {{ artist.trackCount ?? 0 }} 首歌曲</small></span>
                </button>
              </div>
              <p v-else class="search-section-empty">没有匹配的艺人</p>
            </section>

            <section class="search-result-section" aria-labelledby="search-albums-heading">
              <div class="search-section-heading"><h3 id="search-albums-heading">专辑</h3><span v-if="searchAlbumsState === 'ready'">{{ searchAlbumsPage.total }} 张</span></div>
              <div v-if="searchAlbumsState === 'loading'" class="search-card-grid search-card-grid-albums"><div v-for="index in 4" :key="index" class="search-card-skeleton" aria-hidden="true"></div></div>
              <p v-else-if="searchAlbumsState === 'error'" class="persistent-error">{{ searchAlbumsError }}</p>
              <div v-else-if="searchAlbumsPage.items.length" class="search-card-grid search-card-grid-albums" role="list">
                <button v-for="album in searchAlbumsPage.items" :key="album.id" type="button" class="search-album-card" role="listitem" @click="openSearchDetail('album', album.id, album.name, `${album.artistName} · ${album.trackCount ?? 0} 首歌曲`)">
                  <SafeArtwork class="search-album-art" :src="album.artworkUrl" :alt="`${album.name} 封面`" loading="lazy" fallback="♫" />
                  <span><strong>{{ album.name }}</strong><small>{{ album.artistName }} · {{ album.trackCount ?? 0 }} 首歌曲</small></span>
                </button>
              </div>
              <p v-else class="search-section-empty">没有匹配的专辑</p>
            </section>

            <section class="search-result-section" aria-labelledby="search-tracks-heading">
              <div class="search-section-heading"><h3 id="search-tracks-heading">单曲</h3><span v-if="searchPage.total">{{ searchPage.total }} 首</span></div>
              <p v-if="searchError === 'auth-required'" class="persistent-error">请先登录音乐服务，再搜索内容。</p>
              <p v-else-if="searchError === 'auth-expired'" class="persistent-error">登录已过期，请从侧栏账户菜单重新登录。</p>
              <p v-else-if="searchError === 'generic'" class="persistent-error">搜索单曲暂时不可用，请检查连接状态。</p>
              <div class="search-track-results">
                <TrackTable
                  :tracks="searchPage.items"
                  :busy="playbackStartPending"
                  :match-states="matchStates"
                  :show-artwork="true"
                  :initial-loading="searchInitialLoading"
                  :loading-more="searchLoadingMore"
                  :load-more-error="searchLoadMoreError"
                  :total="searchPage.total"
                  :has-more="searchPage.hasMore"
                  :empty-title="searchQuery.trim() ? '没有匹配的单曲' : '开始一段搜索'"
                  empty-copy="搜索结果会以连续歌曲列表显示。"
                  empty-glyph="⌕"
                  @play="playTrack"
                  @queue="appendTrack"
                  @play-next="insertTrackNext"
                  @load-more="searchPageAt(searchPage.offset + searchPage.limit)"
                />
              </div>
            </section>

            <section v-if="aggregatedSearch" class="aggregated-search-section" aria-labelledby="roon-search-heading">
              <div class="subsection-heading"><div><p class="section-kicker">本地音乐库</p><h3 id="roon-search-heading">Roon 本地结果</h3></div><span class="source-badge">Roon</span></div>
              <p v-if="!aggregatedSearch.roonAvailable" class="notice-card">Roon Library 当前不可用；已保留 V1 的 Provider 搜索结果。</p>
              <RoonEntityGrid
                v-else
                :page="{ ...aggregatedSearch.roon, hasMore: false }"
                entity-label="本地结果"
                empty-title="Roon 没有匹配条目"
                empty-copy="可以继续使用 Provider 结果，或调整搜索词。"
                @select="selectAggregatedRoonItem"
              />
            </section>
          </template>
        </section>

        <section v-else-if="currentView === 'liked'" class="view view-library view-liked" aria-labelledby="liked-heading">
          <div class="liked-hero">
            <div class="view-heading"><div><p class="section-kicker">MUSIC BRIDGE</p><h2 id="liked-heading">我喜欢的音乐</h2><p class="lede">{{ likedPage.total }} 首歌曲</p></div><div class="button-row"><button type="button" class="primary-button" :disabled="!likedPage.items.length" @click="playAllLiked">播放全部</button><button type="button" class="secondary-button" :disabled="!likedPage.items.length" @click="appendAllLiked">加入队列</button></div></div>
          </div>
          <p v-if="likedError" class="persistent-error">{{ likedError === 'auth-required' ? '请先登录音乐服务，再打开我喜欢的音乐。' : likedError === 'auth-expired' ? '登录已过期，请从侧栏账户菜单重新登录。' : '我喜欢的音乐暂时不可用，请稍后重试。' }}<button type="button" class="inline-action" @click="loadLiked()">重试</button></p>
          <TrackTable :tracks="likedPage.items" :initial-loading="likedInitialLoading" :loading-more="likedLoadingMore" :load-more-error="likedLoadMoreError" :total="likedPage.total" :has-more="likedPage.hasMore" empty-title="还没有喜欢的内容" empty-copy="登录网易云后，这里会显示你的收藏。" @play="playTrack" @queue="appendTrack" @play-next="insertTrackNext" @load-more="likedPageAt(likedPage.offset + likedPage.limit)" />
        </section>

        <section v-else-if="currentView === 'playlists'" class="view view-library" aria-labelledby="playlists-heading">
          <div class="view-heading"><div><p class="section-kicker">资料库</p><h2 id="playlists-heading">所有歌单</h2><p class="lede">你的网易云歌单直接来自当前 Provider 数据。</p></div></div>
          <p v-if="playlistState === 'error'" class="persistent-error">歌单暂时无法加载，请从侧栏歌单区域重试。</p>
          <div class="playlist-grid"><div v-if="playlistState === 'loading'" class="empty-state"><p>读取歌单…</p></div><div v-else-if="!playlists.length" class="empty-state"><h3>还没有歌单</h3><p>歌单会在网易云可用后出现在这里。</p></div><button v-for="playlist in playlists" v-else :key="playlist.id" type="button" class="playlist-card" @click="navigateSource({ type: 'playlist', playlistId: playlist.id })"><SafeArtwork class="playlist-art" :src="playlist.artworkUrl" alt="" fallback="♫" /><span><strong>{{ playlist.name }}</strong><small>{{ playlist.trackCount }} 首歌曲</small></span><b aria-hidden="true">→</b></button></div>
        </section>

        <section v-else-if="currentView === 'playlist-detail'" class="view view-playlist" aria-labelledby="playlist-heading">
          <button type="button" class="back-link" @click="navigateSource({ type: 'playlists' })">← 所有歌单</button>
          <p v-if="playlistDetailError === 'auth-required'" class="persistent-error">请先登录音乐服务，再打开歌单。</p>
          <p v-else-if="playlistDetailError === 'auth-expired'" class="persistent-error">登录已过期，请从侧栏账户菜单重新登录。</p>
          <p v-else-if="playlistDetailError === 'generic'" class="persistent-error">歌单暂时无法加载，请稍后重试。</p>
          <div v-if="playlistInitialLoading && !selectedPlaylist" class="empty-state"><span class="loading-line"></span><p>正在读取歌单…</p></div>
          <template v-else-if="selectedPlaylist">
            <div class="playlist-detail-hero">
              <SafeArtwork class="playlist-detail-art" :src="selectedPlaylist.artworkUrl" alt="" fallback="♫" />
              <div class="playlist-detail-copy"><p class="section-kicker">歌单</p><h2 id="playlist-heading">{{ selectedPlaylist.name }}</h2><p class="lede">{{ selectedPlaylist.description || '来自你的音乐收藏。' }}</p><span class="playlist-count">{{ selectedPlaylist.trackCount }} 首歌曲</span><div class="button-row"><button type="button" class="primary-button" :disabled="!selectedPlaylist.tracks.items.length" @click="playAllPlaylist">播放全部</button><button type="button" class="secondary-button" :disabled="!selectedPlaylist.tracks.items.length" @click="appendAllPlaylist">加入队列</button></div></div>
            </div>
            <TrackTable v-model:scroll-top="playlistTableScrollTop" :tracks="selectedPlaylist.tracks.items" :initial-loading="playlistInitialLoading" :loading-more="playlistLoadingMore" :load-more-error="playlistLoadMoreError" :total="selectedPlaylist.tracks.total" :has-more="selectedPlaylist.tracks.hasMore" empty-title="歌单为空" empty-copy="这个歌单暂时没有可显示的歌曲。" @play="playPlaylistTrack" @queue="appendTrack" @play-next="insertTrackNext" @load-more="playlistPageAt(selectedPlaylist.tracks.offset + selectedPlaylist.tracks.limit)" />
          </template>
          <div v-else-if="playlistDetailError === null" class="empty-state"><p>选择一个歌单查看内容。</p></div>
          <button v-if="playlistDetailError" type="button" class="secondary-button" @click="retryPlaylist">重试</button>
        </section>

        <NowPlayingView
          v-else-if="currentView === 'now-playing'"
          :current-track="currentTrack"
          :playback-state="playbackState"
          :lyrics-snapshot="lyricsSnapshot"
          :local-lyrics-match-state="localLyricsMatchState"
          :local-lyrics-match-busy="localLyricsMatchBusy"
          :local-lyrics-match-error="localLyricsMatchError"
          :quality-label="qualityLabel"
          :quality-notice="playbackState?.qualityNotice"
          :playback-issue-message="playbackIssueMessage"
          :track-like-state="trackLikeState"
          :track-like-available="playbackSource === 'netease' || nativeRoonHasNeteaseMatch || localTrackFavoriteDescriptor !== null"
          :playback-source="playbackSource"
          :seek-allowed="selectedZone?.seekAllowed === true"
          @back="exitNowPlaying"
          @previous="previousTrack"
          @toggle-playback="togglePlayback"
          @next="nextTrack"
          @toggle-like="toggleTrackLike"
          @seek="seekPlayback"
          @select-lyrics-match="selectLocalLyricsMatch"
          @revoke-lyrics-match="revokeLocalLyricsMatch"
        />

        <SettingsView
          v-else-if="currentView === 'settings'"
          :app-info="appInfo"
          :auth-state="authState"
          :account-state="accountState"
          :zones="zones"
          :selected-zone="selectedZone"
          :roon-status="coreState?.roon ?? 'disconnected'"
          :zone-status="zoneLifecycleStatus"
          :selected-quality="selectedQuality"
          :auth-error="authError"
          :account-error="accountError"
          :remote-core-state="remoteCoreState"
          :remote-auto-start="remoteAutoStart"
          :remote-ssh-target="remoteSshTarget"
          @begin-login="beginQrLogin"
          @cancel-login="cancelQrLogin"
          @logout="logout"
          @refresh-account="refreshAccountProfile"
          @update:selected-quality="setSelectedQuality($event)"
          @select-zone="selectZone"
          @refresh-zones="loadZones"
          @diagnostics="navigate('diagnostics')"
          @start-remote-core="startRemoteCore"
          @stop-remote-core="stopRemoteCore"
          @reconnect-remote-core="reconnectRemoteCore"
          @update:remote-auto-start="updateRemoteAutoStart"
          @update:remote-ssh-target="updateRemoteSshTarget"
        >
          <template #application-tools>
            <button ref="commandOutboxTrigger" type="button" class="command-outbox-entry" aria-haspopup="dialog" @click="commandOutboxOpen = true">未确认操作</button>
          </template>
        </SettingsView>

        <section v-else class="view view-diagnostics" aria-labelledby="diagnostics-heading">
          <div class="view-heading"><div><p class="section-kicker">Read-only signal</p><h2 id="diagnostics-heading">Diagnostics</h2><p class="lede">这里只展示公开状态、可操作建议和诊断标识，不导出 Provider 原始内容。</p></div><div class="button-row"><button type="button" class="secondary-button" @click="refreshPlayback">刷新状态</button><button type="button" class="secondary-button" :disabled="diagnosticExportState === 'working'" @click="exportDiagnostics">{{ diagnosticExportState === 'working' ? '导出中…' : '导出诊断文件' }}</button></div></div>
          <p v-if="diagnosticExportState === 'done'" class="notice-card">诊断文件已导出，仅包含脱敏运行信息。</p>
          <p v-else-if="diagnosticExportState === 'cancelled'" class="notice-card">已取消诊断文件导出。</p>
          <p v-if="hasPlaybackIssue" class="persistent-error">{{ actionError ?? playbackState?.lastIssue?.message }}<span v-if="actionDiagnosticId ?? playbackState?.lastIssue?.diagnosticId">诊断标识：{{ actionDiagnosticId ?? playbackState?.lastIssue?.diagnosticId }}</span><button v-if="playbackState?.lastIssue?.retryable || actionError" type="button" class="inline-action" @click="retryAction">重试</button></p>
          <p v-if="diagnosticNotice" class="notice-card">{{ diagnosticNotice.code }}<span v-if="diagnosticNotice.message">{{ diagnosticNotice.message }}</span></p>
          <div class="diagnostic-grid"><article class="diagnostic-card"><span>Bridge Core</span><strong>{{ coreState?.runtime ?? 'starting' }}</strong><small>活动流 {{ coreState?.activeStreamCount ?? 0 }}</small></article><article class="diagnostic-card"><span>Roon</span><strong>{{ coreState?.roon ?? 'disconnected' }}</strong><small>{{ selectedZone?.displayName ?? '未选择 Zone' }}</small></article><article class="diagnostic-card"><span>Provider</span><strong>{{ coreState?.provider ?? 'missing' }}</strong><small>凭据状态仅显示公开枚举</small></article><article class="diagnostic-card"><span>Playback</span><strong>{{ playbackState?.state ?? 'idle' }}</strong><small>{{ coreState?.activePlaybackPresent ? '活动播放存在' : '无活动播放' }}</small></article></div>
          <div class="diagnostic-checks"><h3>安全边界</h3><ul><li>Renderer 无 Node / Electron 访问</li><li>导航与新窗口默认拒绝</li><li>控制与流端口保持 loopback-only</li><li>歌词只在内存中处理</li></ul></div>
        </section>
      </div>
      <PlaybackInspector
        v-if="inspectorOpen && !isImmersiveNowPlaying"
        :current-track="currentTrack"
        :playback-state="playbackState"
        :quality-label="qualityLabel"
        @close="closeInspector"
        @play-queue-item="playQueueItem"
      />
      </div>

      </section>
    </div>

    <BottomPlayer
      v-if="!isImmersiveNowPlaying"
      :current-track="currentTrack"
      :playback-state="playbackState"
      :zones="zones"
      :selected-zone="selectedZone"
      :roon-status="coreState?.roon ?? 'disconnected'"
      :zone-status="zoneLifecycleStatus"
      :selected-quality="selectedQuality"
      @seek="seekPlayback"
      @previous="previousTrack"
      @toggle-playback="togglePlayback"
      @next="nextTrack"
      @open-now-playing="openNowPlaying"
      @open-queue="openQueue"
      @select-zone="selectZone"
      @update:selected-quality="setSelectedQuality($event)"
    />

    <div v-if="toastMessage" class="toast" role="status" aria-live="polite">{{ toastMessage }}</div>
    <CommandOutboxPanel v-if="commandOutboxOpen" @close="closeCommandOutbox" />

  </main>
</template>

<style scoped>
.command-outbox-entry { min-height: 44px; padding: 8px 12px; border: 1px solid var(--mb-glass-border); border-radius: 8px; background: var(--mb-glass-clear); color: var(--mb-text-primary); font: inherit; font-size: 13px; cursor: pointer; }
.command-outbox-entry:focus-visible { outline: 2px solid var(--mb-accent); outline-offset: 3px; }
@media (hover: hover) and (pointer: fine) { .command-outbox-entry:hover { border-color: var(--mb-accent); } }
</style>
