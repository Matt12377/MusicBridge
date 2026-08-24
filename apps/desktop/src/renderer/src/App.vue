<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'

import type {
  AlbumSummary,
  ArtistSummary,
  LyricsSnapshot,
  Page,
  PageRequest,
  DailyRecommendationsSnapshot,
  PlaybackQualityPreference,
  PlaybackQueueRequestItem,
  PlaybackQueueItem,
  PlaybackSnapshot,
  PlaylistDetail,
  PublicAuthState,
  PublicAccountState,
  PublicBridgeState,
  PublicRoonZone,
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
import MusicSidebar from './components/sidebar/MusicSidebar.vue'
import ToolbarStatusPopover from './components/ToolbarStatusPopover.vue'
import { useLibrarySources } from './composables/useLibrarySources.js'
import { appendPage } from './composables/libraryPagination.js'
import {
  createProgressiveCollectionLoader,
  loadCollectionTracks,
  type CollectionPageLoader,
  type ProgressiveCollectionLoader,
} from './composables/collectionQueue.js'
import {
  selectRandomPlaylistPages,
  settleHomePlaylistPages,
  shuffleTracks,
  type HomeRecommendationState,
} from './composables/homeRecommendations.js'
import { useSidebarState } from './composables/useSidebarState.js'
import { createSearchSnapshotLoader } from './composables/search.js'
import type { SidebarSource, ViewId } from './components/navigation.js'

const LIBRARY_PAGE_SIZE = 20
const SEARCH_DEBOUNCE_MS = 250

const VIEW_LABELS: Record<ViewId, string> = {
  home: '主页',
  search: '搜索结果',
  liked: '我喜欢的音乐',
  'daily-recommendations': '每日推荐',
  playlists: '所有歌单',
  'playlist-detail': '歌单详情',
  'now-playing': '正在播放',
  queue: '队列',
  settings: '设置',
  diagnostics: '诊断',
}

function emptyPage<T>(limit = LIBRARY_PAGE_SIZE): Page<T> {
  return { items: [], offset: 0, limit, total: 0, hasMore: false }
}

function emptyLyricsSnapshot(status: LyricsSnapshot['status'] = 'idle'): LyricsSnapshot {
  return { status, lines: [], activeLineIndex: -1, timingSource: 'static' }
}

function localDayKey(now = Date.now()): string {
  const date = new Date(now)
  return String(date.getFullYear()) + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0')
}

const appInfo = ref<AppInfo | null>(null)
const currentView = ref<ViewId>('home')
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
const lyricsSnapshot = ref<LyricsSnapshot>(emptyLyricsSnapshot())
const zones = ref<readonly PublicRoonZone[]>([])
const selectedQuality = ref<PlaybackQualityPreference>('auto')
const remoteCoreState = ref<RemoteCoreTunnelState>({
  mode: 'local-core',
  status: 'idle',
  localStreamPort: 38502,
  remoteHealth: 'unavailable',
  autoReconnect: false,
})
const remoteAutoStart = ref(false)
const inspectorOpen = ref(false)
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
const homePlaylistTracks = ref<readonly TrackSummary[]>([])
const recentTracks = ref<readonly TrackSummary[]>([])
const homeRecommendationState = ref<HomeRecommendationState>('loading')
const searchInitialLoading = ref(false)
const searchLoadingMore = ref(false)
const searchLoadMoreError = ref<string | null>(null)
const searchError = ref<'auth-expired' | 'generic' | null>(null)
const likedInitialLoading = ref(false)
const likedLoadingMore = ref(false)
const likedLoadMoreError = ref<string | null>(null)
const likedError = ref<'auth-expired' | 'generic' | null>(null)
const playlistInitialLoading = ref(false)
const playlistLoadingMore = ref(false)
const playlistLoadMoreError = ref<string | null>(null)
const playlistDetailError = ref<'auth-expired' | 'generic' | null>(null)

let removeCoreListener: (() => void) | undefined
let removeAppCommandListener: (() => void) | undefined
let removeRemoteCoreListener: (() => void) | undefined
let pollTimer: ReturnType<typeof setInterval> | undefined
let searchTimer: ReturnType<typeof setTimeout> | undefined
let authOperation = 0
let pollInFlight = false
let lyricsOperation = 0
let homeRecommendationOperation = 0
let dailyOperation = 0
let collectionOperation = 0
let activeCollectionLoader: ProgressiveCollectionLoader | undefined
let collectionPlaybackStartInFlight = false
let toastTimer: ReturnType<typeof setTimeout> | undefined
let searchRequestGeneration = 0
let searchDetailGeneration = 0
let likedRequestGeneration = 0
let playlistRequestGeneration = 0

const currentTrack = computed(() => playbackState.value?.currentTrack)
const ambientTrack = computed(() => playbackState.value?.state === 'playing' ? currentTrack.value : undefined)
const homeTracks = computed(() => recentTracks.value)
const selectedZone = computed(() => {
  const selectedId = playbackState.value?.selectedZoneId
  return zones.value.find((zone) => zone.zoneId === selectedId) ?? zones.value.find((zone) => zone.selected)
})
const viewTitle = computed(() => VIEW_LABELS[currentView.value])
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
  if (currentView.value !== 'now-playing') nowPlayingReturnView.value = currentView.value
  currentView.value = 'now-playing'
  inspectorOpen.value = false
}

function exitNowPlaying(): void {
  const destination = nowPlayingReturnView.value
  currentView.value = destination === 'now-playing' ? 'home' : destination
  inspectorOpen.value = false
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
    case 'liked':
      return 'liked'
    case 'playlists':
      return 'playlists'
    case 'playlist':
      return 'playlist-detail'
  }
}

function navigateSource(source: SidebarSource): void {
  stopSearchTimer()
  resetSearchSections()
  searchQuery.value = ''
  searchPage.value = emptyPage()
  searchReturnSource.value = source
  sidebar.setActiveSource(source)
  navigate(viewForSource(source))
  if (source.type === 'playlist') void loadPlaylist(source.playlistId)
}

function clearSearch(): void {
  if (currentView.value !== 'search' && searchQuery.value.length === 0 && searchPage.value.items.length === 0) return
  stopSearchTimer()
  resetSearchSections()
  searchRequestGeneration += 1
  searchQuery.value = ''
  searchPage.value = emptyPage()
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

function isAuthExpired(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'AUTH_EXPIRED'
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

function accountMessage(error: unknown): string {
  switch (errorCode(error)) {
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
  switch (errorCode(error)) {
    case 'AUTH_REQUIRED':
    case 'AUTH_EXPIRED':
      return '音乐服务登录已失效，请到设置重新登录。'
    default:
      return '每日推荐暂时不可用，请稍后重试。'
  }
}

function actionableMessage(error: unknown): string {
  switch (errorCode(error)) {
    case 'AUTH_REQUIRED':
    case 'AUTH_EXPIRED':
      return '音乐服务登录已失效，请到设置重新登录。'
    case 'ROON_NOT_PAIRED':
      return 'Roon 尚未配对，请先确认 Roon Core 正在运行。'
    case 'ROON_ZONE_NOT_SELECTED':
      return '请先在设置选择播放设备。'
    case 'QUALITY_DOWNGRADED':
      return '当前请求质量已被安全降级，实际质量以 Signal Path 为准。'
    case 'ROON_ZONE_LOST':
      return '播放 Zone 暂时不可用，请检查 Roon 状态后重试。'
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

function libraryErrorKind(error: unknown): 'auth-expired' | 'generic' {
  return isAuthExpired(error) ? 'auth-expired' : 'generic'
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
        searchError.value = 'generic'
      }
      searchInitialLoading.value = false
    } else {
      const result = await window.musicBridge.searchTracks(query, page)
      if (generation !== searchRequestGeneration) return
      searchPage.value = appendPage(searchPage.value, result)
      searchError.value = null
      searchLoadingMore.value = false
    }
  } catch (error) {
    if (generation !== searchRequestGeneration) return
    if (initial) {
      searchInitialLoading.value = false
      searchError.value = libraryErrorKind(error)
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
  try {
    const snapshot = await window.musicBridge.getDailyRecommendations()
    if (operation !== dailyOperation) return
    dailyRecommendations.value = snapshot
    dailyState.value = snapshot.tracks.length ? 'ready' : 'empty'
  } catch (error) {
    if (operation !== dailyOperation) return
    dailyRecommendations.value = { dayKey: localDayKey(), tracks: [] }
    dailyState.value = 'error'
    dailyError.value = dailyMessage(error)
  }
}

async function loadAccountState(): Promise<void> {
  accountError.value = null
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

function applyAuthState(state: PublicAuthState, operation = authOperation): void {
  if (operation !== authOperation) return
  authState.value = state
  if (!acceptsPolling(state)) stopPolling()
  if (state.status === 'authorized') {
    resetPrivateLibraryState()
    void loadAccountState()
    void loadLiked()
    void loadPlaylists()
    void loadDailyRecommendations()
  } else if (state.status === 'idle' || state.status === 'cancelled' || state.status === 'expired') {
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

function applyPlaybackState(snapshot: PlaybackSnapshot): void {
  const previousTrackId = playbackState.value?.currentTrack?.id
  const wasPlaying = playbackState.value?.state === 'playing'
  playbackState.value = snapshot
  if (snapshot.state === 'playing' && snapshot.currentTrack && (!wasPlaying || previousTrackId !== snapshot.currentTrack.id)) {
    recentTracks.value = [
      snapshot.currentTrack,
      ...recentTracks.value.filter((track) => track.id !== snapshot.currentTrack?.id),
    ].slice(0, 6)
  }
  const trackId = snapshot.currentTrack?.id
  if (trackId && trackId !== previousTrackId) void loadLyrics(trackId)
  else if (!trackId && previousTrackId) {
    lyricsOperation += 1
    lyricsSnapshot.value = emptyLyricsSnapshot()
  }
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
  return tracks.map((track) => ({ trackId: track.id, qualityPreference: selectedQuality.value }))
}

async function playTrack(track: TrackSummary): Promise<void> {
  actionError.value = null
  try {
    applyPlaybackState(await window.musicBridge.play(track.id, selectedQuality.value))
    enterNowPlaying()
  } catch (error) {
    recordActionError(error)
  }
}

async function appendTrack(track: TrackSummary): Promise<void> {
  actionError.value = null
  try {
    applyPlaybackState(await window.musicBridge.appendQueue([
      { trackId: track.id, qualityPreference: selectedQuality.value },
    ]))
    showToast('已加入播放队列')
  } catch (error) {
    recordActionError(error)
  }
}

async function insertTrackNext(track: TrackSummary): Promise<void> {
  actionError.value = null
  try {
    applyPlaybackState(await window.musicBridge.insertNext([
      { trackId: track.id, qualityPreference: selectedQuality.value },
    ]))
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
): Promise<void> {
  if (collectionPlaybackStartInFlight || activeCollectionLoader) return
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
    const tracks = firstBatch.tracks
    const requestedIndex = selectedTrackId === undefined
      ? 0
      : tracks.findIndex((track) => track.id === selectedTrackId)
    const index = requestedIndex >= 0 ? requestedIndex : 0
    const startsWithSingleTrack = selectedTrackId === undefined && index === 0
    const initialTracks = startsWithSingleTrack ? tracks.slice(0, 1) : tracks
    const snapshot = await window.musicBridge.replaceQueue(queueItemsForTracks(initialTracks), startsWithSingleTrack ? 0 : index)
    if (operation !== collectionOperation) return
    applyPlaybackState(snapshot)
    enterNowPlaying()
    collectionPlaybackStartInFlight = false
    if (firstBatch.hasMore || tracks.length > initialTracks.length) {
      void continueCollectionQueue(loader, operation, tracks.slice(initialTracks.length))
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
  const operation = ++collectionOperation
  actionError.value = null
  void (async () => {
    try {
      applyPlaybackState(await window.musicBridge.play(track.id, selectedQuality.value))
      enterNowPlaying()
    } catch (error) {
      if (operation === collectionOperation) recordActionError(error)
      return
    }

    try {
      const tracks = await loadCollectionTracks(
        (page) => window.musicBridge.getPlaylist(playlistId, page).then((detail) => detail.tracks),
      )
      const currentPlayback = playbackState.value
      if (
        operation !== collectionOperation ||
        tracks.length === 0 ||
        !currentPlayback ||
        currentPlayback.currentTrack?.id !== track.id ||
        currentPlayback.queue.items.length !== 1
      ) return
      const requestedIndex = tracks.findIndex((item) => item.id === track.id)
      if (requestedIndex < 0) return
      applyPlaybackState(await window.musicBridge.replaceQueue(queueItemsForTracks(tracks), requestedIndex))
    } catch (error) {
      if (operation === collectionOperation) recordActionError(error)
    }
  })()
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
  actionError.value = null
  const items: PlaybackQueueRequestItem[] = dailyRecommendations.value.tracks.map((track) => ({
    trackId: track.id,
    qualityPreference: selectedQuality.value,
  }))
  try {
    applyPlaybackState(await window.musicBridge.replaceQueue(items, 0))
    enterNowPlaying()
  } catch (error) {
    recordActionError(error)
  }
}

async function playQueueItem(item: PlaybackQueueItem, index: number): Promise<void> {
  const items = playbackState.value?.queue.items
  if (!items?.length) return
  try {
    applyPlaybackState(await window.musicBridge.replaceQueue(ipcQueueItems(items), index))
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

async function nextTrack(): Promise<void> {
  try {
    applyPlaybackState(await window.musicBridge.next())
  } catch (error) {
    recordActionError(error)
  }
}

async function previousTrack(): Promise<void> {
  try {
    applyPlaybackState(await window.musicBridge.previous())
  } catch (error) {
    recordActionError(error)
  }
}

async function loadZones(): Promise<void> {
  try {
    zones.value = (await window.musicBridge.listZones()).zones
  } catch (error) {
    recordActionError(error)
  }
}

async function selectZone(zoneId: string): Promise<void> {
  try {
    coreState.value = await window.musicBridge.selectZone(zoneId)
    await loadZones()
    await refreshPlayback()
  } catch (error) {
    recordActionError(error)
  }
}

function handleSidebarAccount(): void {
  navigate('settings')
}

function updateRemoteAutoStart(value: boolean): void {
  remoteAutoStart.value = value
  window.localStorage.setItem('musicbridge.remoteCore.autoStart', value ? '1' : '0')
}

async function startRemoteCore(): Promise<void> {
  actionError.value = null
  try {
    remoteCoreState.value = await window.musicBridge.startRemoteCore()
  } catch (error) {
    recordActionError(error)
  }
}

async function stopRemoteCore(): Promise<void> {
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

function ipcQueueItems(items: readonly PlaybackQueueItem[]): PlaybackQueueItem[] {
  return items.map((item) => ({ trackId: item.trackId, qualityPreference: item.qualityPreference }))
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
    remoteCoreState.value = state
  })
  removeCoreListener = window.musicBridge.onCoreEvent((event) => {
    if (event.event === 'core.ready' || event.event === 'core.health' || event.event === 'roon.changed') {
      coreState.value = event.payload.state
    }
    if (event.event === 'auth.changed') applyAuthState(event.payload.state)
    if (event.event === 'account.changed') {
      accountState.value = event.payload.state
      if (event.payload.state.status === 'ready' && authState.value.status === 'authorized') {
        void loadDailyRecommendations()
      }
      if (event.payload.state.status === 'missing') {
        resetPrivateLibraryState()
        dailyRecommendations.value = { dayKey: localDayKey(), tracks: [] }
        dailyState.value = 'empty'
      }
    }
    if (event.event === 'playback.changed') applyPlaybackState(event.payload.state)
    if (event.event === 'lyrics.changed') lyricsSnapshot.value = event.payload.state
    if (event.event === 'diagnostic.notice') diagnosticNotice.value = event.payload
  })
  try {
    appInfo.value = await window.musicBridge.getAppInfo()
    const storedQuality = window.localStorage.getItem('musicbridge.qualityPreference')
    if (['auto', 'standard', 'exhigh', 'lossless', 'hires'].includes(storedQuality ?? '')) {
      selectedQuality.value = storedQuality as PlaybackQualityPreference
    }
    if (appInfo.value.buildMode === 'development') {
      remoteCoreState.value = await window.musicBridge.getRemoteCoreState()
      remoteAutoStart.value = window.localStorage.getItem('musicbridge.remoteCore.autoStart') === '1'
      if (remoteAutoStart.value && remoteCoreState.value.status === 'idle') {
        void startRemoteCore()
      }
    }
    coreState.value = await window.musicBridge.getCoreHealth()
    const initialAuthState = await window.musicBridge.getAuthState()
    applyAuthState(initialAuthState)
    if (initialAuthState.status !== 'authorized') await loadAccountState()
    applyPlaybackState(await window.musicBridge.getPlaybackState())
    await loadZones()
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
  stopPolling()
  stopSearchTimer()
  inspectorReturnFocus.value = null
  if (toastTimer !== undefined) window.clearTimeout(toastTimer)
})
</script>

<template>
  <main class="app-shell" :class="{ 'is-now-playing': isImmersiveNowPlaying }" data-ui-reference="simple-music-player-2">
    <AlbumAmbientBackground :current-track="ambientTrack" />
    <div class="app-main">
      <MusicSidebar
        v-if="!isImmersiveNowPlaying"
        :expanded="sidebar.expanded.value"
        :active-source="sidebar.activeSource.value"
        :search-query="searchQuery"
        :playlists="playlists"
        :playlist-state="playlistState"
        :source-scroll-top="sidebar.sourceScrollTop.value"
        :account-state="accountState"
        :auth-state="authState"
        @toggle="sidebar.toggleExpanded"
        @navigate="navigateSource"
        @update:search-query="updateSearchQuery"
        @clear-search="clearSearch"
        @retry-playlists="loadPlaylists"
        @scroll-source="sidebar.setSourceScrollTop"
        @account="handleSidebarAccount"
      />

      <section class="workspace" :class="{ 'is-immersive': isImmersiveNowPlaying }">
      <header v-if="!isImmersiveNowPlaying" class="topbar">
        <div class="topbar-leading">
          <div>
            <p class="section-kicker">Music Bridge</p>
            <h1 v-if="currentView !== 'home'">{{ viewTitle }}</h1>
          </div>
        </div>
        <ToolbarStatusPopover :core-state="coreState" :selected-zone="selectedZone" @diagnostics="navigate('diagnostics')" />
      </header>

      <div class="workspace-body" :class="{ 'is-immersive': isImmersiveNowPlaying }">
      <div ref="contentScroll" class="content-scroll" :class="{ 'is-immersive': isImmersiveNowPlaying }">
        <HomeView
          v-if="currentView === 'home'"
          :current-track="currentTrack"
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

            <section class="search-result-section" aria-labelledby="search-tracks-heading">
              <div class="search-section-heading"><h3 id="search-tracks-heading">单曲</h3><span v-if="searchPage.total">{{ searchPage.total }} 首</span></div>
              <p v-if="searchError === 'auth-expired'" class="persistent-error">登录已过期，请从侧栏账户菜单重新登录。</p>
              <p v-else-if="searchError === 'generic'" class="persistent-error">搜索单曲暂时不可用，请检查连接状态。</p>
              <TrackTable
                :tracks="searchPage.items"
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
          </template>
        </section>

        <section v-else-if="currentView === 'liked'" class="view view-library" aria-labelledby="liked-heading">
          <div class="liked-hero">
            <div class="liked-collage" aria-hidden="true"><SafeArtwork v-for="track in likedPage.items.slice(0, 4)" :key="track.id" class="liked-collage-tile" :src="track.artworkUrl" alt="" /><span v-if="!likedPage.items.length" class="liked-collage-empty">♫</span></div>
            <div class="view-heading"><div><p class="section-kicker">资料库</p><h2 id="liked-heading">我喜欢的音乐</h2><p class="lede">{{ likedPage.total }} 首歌曲</p></div><div class="button-row"><button type="button" class="primary-button" :disabled="!likedPage.items.length" @click="playAllLiked">播放全部</button><button type="button" class="secondary-button" :disabled="!likedPage.items.length" @click="appendAllLiked">加入队列</button></div></div>
          </div>
          <p v-if="likedError" class="persistent-error">{{ likedError === 'auth-expired' ? '登录已过期，请从侧栏账户菜单重新登录。' : '我喜欢的音乐暂时不可用，请稍后重试。' }}</p>
          <TrackTable :tracks="likedPage.items" :initial-loading="likedInitialLoading" :loading-more="likedLoadingMore" :load-more-error="likedLoadMoreError" :total="likedPage.total" :has-more="likedPage.hasMore" empty-title="还没有喜欢的内容" empty-copy="登录网易云后，这里会显示你的收藏。" @play="playTrack" @queue="appendTrack" @play-next="insertTrackNext" @load-more="likedPageAt(likedPage.offset + likedPage.limit)" />
        </section>

        <section v-else-if="currentView === 'playlists'" class="view view-library" aria-labelledby="playlists-heading">
          <div class="view-heading"><div><p class="section-kicker">资料库</p><h2 id="playlists-heading">所有歌单</h2><p class="lede">你的网易云歌单直接来自当前 Provider 数据。</p></div></div>
          <p v-if="playlistState === 'error'" class="persistent-error">歌单暂时无法加载，请从侧栏歌单区域重试。</p>
          <div class="playlist-grid"><div v-if="playlistState === 'loading'" class="empty-state"><p>读取歌单…</p></div><div v-else-if="!playlists.length" class="empty-state"><h3>还没有歌单</h3><p>歌单会在网易云可用后出现在这里。</p></div><button v-for="playlist in playlists" v-else :key="playlist.id" type="button" class="playlist-card" @click="navigateSource({ type: 'playlist', playlistId: playlist.id })"><SafeArtwork class="playlist-art" :src="playlist.artworkUrl" alt="" fallback="♫" /><span><strong>{{ playlist.name }}</strong><small>{{ playlist.trackCount }} 首歌曲</small></span><b aria-hidden="true">→</b></button></div>
        </section>

        <section v-else-if="currentView === 'playlist-detail'" class="view view-playlist" aria-labelledby="playlist-heading">
          <button type="button" class="back-link" @click="navigateSource({ type: 'playlists' })">← 所有歌单</button>
          <p v-if="playlistDetailError === 'auth-expired'" class="persistent-error">登录已过期，请从侧栏账户菜单重新登录。</p>
          <p v-else-if="playlistDetailError === 'generic'" class="persistent-error">歌单暂时无法加载，请稍后重试。</p>
          <div v-if="playlistInitialLoading && !selectedPlaylist" class="empty-state"><span class="loading-line"></span><p>正在读取歌单…</p></div>
          <template v-else-if="selectedPlaylist">
            <div class="playlist-detail-hero">
              <SafeArtwork class="playlist-detail-art" :src="selectedPlaylist.artworkUrl" alt="" fallback="♫" />
              <div class="playlist-detail-copy"><p class="section-kicker">歌单</p><h2 id="playlist-heading">{{ selectedPlaylist.name }}</h2><p class="lede">{{ selectedPlaylist.description || '来自你的音乐收藏。' }}</p><span class="playlist-count">{{ selectedPlaylist.trackCount }} 首歌曲</span><div class="button-row"><button type="button" class="primary-button" :disabled="!selectedPlaylist.tracks.items.length" @click="playAllPlaylist">播放全部</button><button type="button" class="secondary-button" :disabled="!selectedPlaylist.tracks.items.length" @click="appendAllPlaylist">加入队列</button></div></div>
            </div>
            <TrackTable :tracks="selectedPlaylist.tracks.items" :initial-loading="playlistInitialLoading" :loading-more="playlistLoadingMore" :load-more-error="playlistLoadMoreError" :total="selectedPlaylist.tracks.total" :has-more="selectedPlaylist.tracks.hasMore" empty-title="歌单为空" empty-copy="这个歌单暂时没有可显示的歌曲。" @play="playPlaylistTrack" @queue="appendTrack" @play-next="insertTrackNext" @load-more="playlistPageAt(selectedPlaylist.tracks.offset + selectedPlaylist.tracks.limit)" />
          </template>
          <div v-else-if="playlistDetailError === null" class="empty-state"><p>选择一个歌单查看内容。</p></div>
          <button v-if="playlistDetailError" type="button" class="secondary-button" @click="retryPlaylist">重试</button>
        </section>

        <NowPlayingView
          v-else-if="currentView === 'now-playing'"
          :current-track="currentTrack"
          :playback-state="playbackState"
          :lyrics-snapshot="lyricsSnapshot"
          :selected-quality="selectedQuality"
          :quality-label="qualityLabel"
          :quality-notice="playbackState?.qualityNotice"
          :playback-issue-message="playbackIssueMessage"
          @back="exitNowPlaying"
          @previous="previousTrack"
          @toggle-playback="togglePlayback"
          @next="nextTrack"
        />

        <SettingsView
          v-else-if="currentView === 'settings'"
          :app-info="appInfo"
          :auth-state="authState"
          :account-state="accountState"
          :zones="zones"
          :selected-zone="selectedZone"
          :roon-status="coreState?.roon ?? 'disconnected'"
          :selected-quality="selectedQuality"
          :auth-error="authError"
          :account-error="accountError"
          :remote-core-state="remoteCoreState"
          :remote-auto-start="remoteAutoStart"
          @begin-login="beginQrLogin"
          @cancel-login="cancelQrLogin"
          @logout="logout"
          @refresh-account="refreshAccountProfile"
          @update:selected-quality="setSelectedQuality($event)"
          @select-zone="selectZone"
          @diagnostics="navigate('diagnostics')"
          @start-remote-core="startRemoteCore"
          @stop-remote-core="stopRemoteCore"
          @reconnect-remote-core="reconnectRemoteCore"
          @update:remote-auto-start="updateRemoteAutoStart"
        />

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
      :selected-quality="selectedQuality"
      @previous="previousTrack"
      @toggle-playback="togglePlayback"
      @next="nextTrack"
      @open-now-playing="openNowPlaying"
      @open-queue="openQueue"
      @select-zone="selectZone"
      @update:selected-quality="setSelectedQuality($event)"
    />

    <div v-if="toastMessage" class="toast" role="status" aria-live="polite">{{ toastMessage }}</div>

  </main>
</template>
