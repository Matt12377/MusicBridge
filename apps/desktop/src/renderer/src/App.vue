<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { restoreRemoteTarget, reconnectRemoteTarget } from './remote-core-preferences.js'

import type {
  PlaybackQualityPreference,
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
import SearchEntities from './components/SearchEntities.vue'
import SearchTrackPreview from './components/SearchTrackPreview.vue'
import RoonAlbumGrid from './components/RoonAlbumGrid.vue'
import RoonEntityGrid from './components/RoonEntityGrid.vue'
import FavoriteEntityGrid from './components/FavoriteEntityGrid.vue'
import RoonAlbumDetail from './components/RoonAlbumDetail.vue'
import RoonBrowseDetail from './components/RoonBrowseDetail.vue'
import MusicSidebar from './components/sidebar/MusicSidebar.vue'
import CommandOutboxPanel from './components/CommandOutboxPanel.vue'
import { shouldRefreshVisibleRoonCollection } from './roon-collection-lifecycle.js'
import { isCoreRuntimeStable } from './core-readiness.js'
import {
  readPublicIpcErrorCode,
  roonLibraryMessage as formatRoonLibraryMessage,
} from './roonLibraryMessages.js'
import { roonArtworkCache } from './roon-artwork-cache.js'
import type { SidebarSource } from './components/navigation.js'
import { createZoneRefreshCoordinator, resolveZoneLifecycleStatus } from './zone-lifecycle.js'
import { usePlaybackSession, type RoonPlaybackContext } from './composables/application/usePlaybackSession.js'
import { useAggregatedSearch } from './composables/application/useAggregatedSearch.js'
import { useRoonBrowse } from './composables/application/useRoonBrowse.js'
import { usePageJourney } from './composables/application/usePageJourney.js'
import { useNeteaseLibrary } from './composables/application/useNeteaseLibrary.js'
import { useRendererLifecycle } from './composables/application/useRendererLifecycle.js'
import CollectionView from './components/collection/CollectionView.vue'
import RecordingView from './components/recording/RecordingView.vue'

const appInfo = ref<AppInfo | null>(null)
const recordingReloadRequired = ref(false)
const coreState = ref<PublicBridgeState | null>(null)
const coreError = ref(false)
const playback = usePlaybackSession({
  api: window.musicBridge,
  getSelectedZone: () => selectedZone.value,
  getZoneLifecycleStatus: () => zoneLifecycleStatus.value,
  getSelectedQuality: () => selectedQuality.value,
  getMatchResult: trackId => matchResults.value[trackId],
  getPendingMatch: trackId => pendingMatchRequests.get(trackId),
  onMatchTracks: tracks => { void matchTracks(tracks) },
  getRoonPlaybackContext,
  resolveFavoriteDescriptor: item => browse.resolveFavoriteDescriptor(item),
  onEnterNowPlaying: () => journey.enterNowPlaying(),
  clearActionError: () => { actionError.value = null },
  onActionMessage: message => { actionError.value = message },
  onError: recordActionError,
  onToast: showToast,
})
const {
  playbackState, playbackStartPending, playbackSource, nativeRoonHasNeteaseMatch,
  lyricsSnapshot, localLyricsMatchState, localLyricsMatchBusy, localLyricsMatchError,
  trackLikeState, localTrackFavoriteDescriptor, currentTrack, recentTracks,
  applyPlaybackState, refreshPlayback, selectLocalLyricsMatch, revokeLocalLyricsMatch,
  toggleTrackLike, playTrack, playRoonLibraryTrack, queueRoonLibraryTrack,
  appendTrack, insertTrackNext, replaceAndPlayCollection, appendCollection,
  invalidateCollectionOperation, playQueueItem, togglePlayback, stopPlayback,
  nextTrack, previousTrack, seekPlayback, cancelRoonPlaybackPreparation,
} = playback
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

const search = useAggregatedSearch({
  api: window.musicBridge,
  getZoneId: () => selectedZone.value?.zoneId,
  getScrollTop: () => journey.contentScroll.value?.scrollTop ?? 0,
  scrollTo: top => { void nextTick(() => journey.contentScroll.value?.scrollTo({ top })) },
  classifyError: searchErrorKind,
  onResetSearchOrigin: () => { journey.roonSearchOrigin.value = false },
  onInvalidateRoonDetails: () => browse.invalidateAlbumArtistRequests(),
})
const {
  searchQuery, searchCategory, searchSongsOpen, searchSongScrollTop,
  roonSearchAlbums, roonSearchArtists, roonSearchLoading, roonSearchError,
  searchPage, searchArtistsPage, searchAlbumsPage, searchArtistsState,
  searchAlbumsState, searchArtistsError, searchAlbumsError, searchDetail,
  searchDetailLoadingMore, searchDetailMoreError, searchScrollTop,
  searchInitialLoading, searchLoadingMore, searchLoadMoreError, searchError,
  matchStates, matchResults, pendingMatchRequests, selectSearchCategory,
  matchTracks,
  scheduleSearch, searchPageAt, loadMoreSearchEntities, openSearchSongs,
  openSearchDetail, loadMoreSearchDetail, closeSearchDetail,
} = search
const browse = useRoonBrowse({
  api: window.musicBridge,
  formatError: roonLibraryMessage,
  onError: recordActionError,
  onToast: showToast,
  getView: () => journey.currentView.value,
  onDetailOpening: view => { journey.setDetailView(view) },
  onDetailReady: (view, source) => { journey.setDetailView(view, source) },
  onNavigateSource: source => journey.navigateSource(source),
  onPlayTrack: item => { void playRoonLibraryTrack(item) },
})
const {
  localAlbumQuery, setLocalAlbumQuery, roonAlbumsPage, roonAlbumsInitialLoading,
  roonAlbumsLoadingMore, roonAlbumsLoadMoreError, roonAlbumsError, loadRoonAlbums,
  loadMoreRoonAlbums, retryRoonAlbums, resetRoonAlbums,
  localArtistQuery, setLocalArtistQuery, roonArtistsPage, roonArtistsInitialLoading,
  roonArtistsLoadingMore, roonArtistsLoadMoreError, roonArtistsError, loadRoonArtists,
  loadMoreRoonArtists, retryRoonArtists, resetRoonArtists,
  roonGenresPage, roonGenresInitialLoading, roonGenresLoadingMore,
  roonGenresLoadMoreError, roonGenresError, loadRoonGenres, loadMoreRoonGenres,
  retryRoonGenres, resetRoonGenres,
  roonPlaylistsPage, roonPlaylistsInitialLoading, roonPlaylistsLoadingMore,
  roonPlaylistsLoadMoreError, roonPlaylistsError, loadRoonPlaylists,
  loadMoreRoonPlaylists, retryRoonPlaylists, resetRoonPlaylists,
  favoriteKind, favoriteResolutionEpoch, favoritesPage, favoritesInitialLoading,
  favoritesLoadingMore, favoritesLoadMoreError, favoritesError,
  selectedRoonAlbum, roonAlbumFavoriteState, selectedRoonAlbumPage,
  roonAlbumInitialLoading, roonAlbumLoadingMore, roonAlbumLoadMoreError, roonAlbumError,
  selectedRoonArtist, roonArtistFavoriteState, selectedRoonArtistPage,
  roonArtistInitialLoading, roonArtistLoadingMore, roonArtistLoadMoreError, roonArtistError,
  selectedRoonGenre, selectedRoonGenrePage, roonGenreInitialLoading,
  roonGenreLoadingMore, roonGenreLoadMoreError, roonGenreError,
  selectedRoonPlaylist, selectedRoonPlaylistPage, roonPlaylistInitialLoading,
  roonPlaylistLoadingMore, roonPlaylistLoadMoreError, roonPlaylistError,
  loadRoonAlbum, loadRoonArtist, loadRoonGenre, loadRoonPlaylist,
  roonAlbumPageAt, roonArtistPageAt, roonGenrePageAt, roonPlaylistPageAt,
  loadRoonEntityFavorite, toggleRoonEntityFavorite, loadFavorites,
  setFavoriteKind, openFavorite, removeFavorite, favoritesPageAt,
  retryFavorites, retryRoonAlbum, refreshVisibleRoonCollection,
} = browse
type SearchErrorKind = 'auth-required' | 'auth-expired' | 'generic'
type LibraryErrorKind = SearchErrorKind

const netease = useNeteaseLibrary({
  api: window.musicBridge,
  getCoreRuntime: () => coreState.value?.runtime,
  getRemoteStatus: () => remoteCoreState.value.status,
  getView: () => journey.currentView.value,
  onMatchTracks: (tracks, visible) => { void matchTracks(tracks, visible) },
  onPlaylistSwitch: () => playback.invalidateCollectionOperation(),
  onPlaylistReady: playlistId => journey.setDetailView('playlist-detail', { type: 'playlist', playlistId }),
  onResetPrivate: () => {
    journey.resetPrivatePath()
    search.resetSearch()
    playback.invalidateCollectionOperation()
    recentTracks.value = []
  },
  onError: recordActionError,
  accountMessage,
  dailyMessage,
  libraryErrorKind,
})
const {
  authState, authError, accountState, accountError,
  dailyRecommendations, dailyState, dailyError,
  likedPage, likedInitialLoading, likedLoadingMore, likedLoadMoreError, likedError, likedHomeState,
  playlists, playlistState, playlistError, selectedPlaylist, selectedPlaylistId,
  playlistContentScrollTop, playlistTableScrollTop, playlistInitialLoading, playlistLoadingMore,
  playlistLoadMoreError, playlistDetailError, homePlaylistTracks, homeRecommendationState,
  loadLiked, likedPageAt, loadAccountState, refreshAccountProfile,
  loadPlaylists, refreshHomeRecommendations, loadPlaylist, retryPlaylist, playlistPageAt,
  applyAuthState, applyAccountState, beginQrLogin, cancelQrLogin, logout,
  loadAuthorizedLibraryWhenReady, resetAuthorizedLoadStarted, applyInitialAuthState,
} = netease

let toastTimer: ReturnType<typeof setTimeout> | undefined

const journey = usePageJourney({
  search,
  browse,
  library: {
    hasLikedItems: () => likedPage.value.items.length > 0,
    isPlaylistReady: () => playlistState.value === 'ready',
    getPlaylistScrollTop: () => playlistContentScrollTop.value,
    setPlaylistScrollTop: top => { playlistContentScrollTop.value = top },
    loadLiked,
    loadPlaylists,
    loadPlaylist: playlistId => loadPlaylist(playlistId),
  },
  onPlayRoonTrack: item => { void playRoonLibraryTrack(item) },
  onCloseInspector: () => { inspectorOpen.value = false },
  onClearActionError: () => {
    actionError.value = null
    actionDiagnosticId.value = null
  },
})
const {
  currentView, sidebar, roonSearchOrigin,
  contentScroll, collectionView, localSearchScope,
  sidebarSearchQuery, sidebarSearchLabel, roonDetailBackLabel,
  isImmersiveNowPlaying, enterNowPlaying, exitNowPlaying, navigate, navigateSource,
  openTapeCollection, clearSearch, updateSearchQuery, returnFromRoonDetail,
  returnToSearch, selectAggregatedRoonItem,
} = journey

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
const hasPlaybackIssue = computed(() => Boolean(playbackState.value?.lastIssue || actionError.value))
const greeting = computed(() => {
  const hour = new Date().getHours()
  return hour >= 5 && hour < 12 ? '早上好' : hour >= 12 && hour < 18 ? '下午好' : '晚上好'
})
function resetRoonRuntimeReferences(): void {
  browse.resetSession()
  journey.resetRoonPath()
  playback.resetRoonSession()
  search.resetMatches()
  roonArtworkCache.clear()
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

function roonLibraryMessage(error: unknown): string {
  return formatRoonLibraryMessage(error, {
    roonStatus: coreState.value?.roon,
    remoteCoreDevelopment: remoteCoreState.value.mode === 'remote-core-development',
  })
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

function getRoonPlaybackContext(): RoonPlaybackContext | undefined {
  if (currentView.value === 'roon-album-detail' && selectedRoonAlbum.value) {
    return { page: selectedRoonAlbumPage.value, reference: selectedRoonAlbum.value.reference, load: window.musicBridge.getRoonAlbumTracks }
  }
  if (currentView.value === 'roon-playlist-detail' && selectedRoonPlaylist.value) {
    return { page: selectedRoonPlaylistPage.value, reference: selectedRoonPlaylist.value.reference, load: window.musicBridge.getRoonPlaylistTracks }
  }
  if (currentView.value === 'roon-genre-detail' && selectedRoonGenre.value) {
    return { page: selectedRoonGenrePage.value, reference: selectedRoonGenre.value.reference, load: window.musicBridge.getRoonGenreItems }
  }
  return undefined
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
  await playback.playTracks(dailyRecommendations.value.tracks)
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
    const state = await window.musicBridge.startRemoteCore(remoteSshTarget.value)
    if (lifecycle.isActive()) remoteCoreState.value = state
  } catch (error) {
    if (lifecycle.isActive()) recordActionError(error)
  }
}

async function stopRemoteCore(): Promise<void> {
  cancelRoonPlaybackPreparation()
  actionError.value = null
  try {
    const state = await window.musicBridge.stopRemoteCore()
    if (lifecycle.isActive()) remoteCoreState.value = state
  } catch (error) {
    if (lifecycle.isActive()) recordActionError(error)
  }
}

async function reconnectRemoteCore(): Promise<void> {
  actionError.value = null
  try {
    const state = await reconnectRemoteTarget(window.musicBridge, remoteCoreState.value, remoteSshTarget.value)
    if (lifecycle.isActive()) remoteCoreState.value = state
  } catch (error) {
    if (lifecycle.isActive()) recordActionError(error)
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
  if (event.key === 'Escape' && sidebarSearchQuery.value) {
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

const lifecycle = useRendererLifecycle({
  api: window.musicBridge,
  keyTarget: window,
  onKeydown: onGlobalShortcut,
  onAppCommand: command => {
    if (command === 'show-queue') openQueue()
  },
  onRemoteCoreEvent: state => {
    const previousStatus = remoteCoreState.value.status
    remoteCoreState.value = state
    if (state.sshTarget) updateRemoteSshTarget(state.sshTarget)
    if (previousStatus === 'ready' && state.status !== 'ready') resetRoonRuntimeReferences()
    if (state.status !== 'ready' && coreState.value) {
      coreState.value = { ...coreState.value, roon: 'disconnected' }
    }
    zoneRefreshCoordinator.handleRemoteCoreState(state.status)
    if (['checking', 'starting', 'reconnecting', 'stopping'].includes(state.status)) {
      resetAuthorizedLoadStarted()
    } else {
      loadAuthorizedLibraryWhenReady()
    }
  },
  onCoreEvent: event => {
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
      if (event.payload.state.runtime !== 'ready') resetAuthorizedLoadStarted()
    }
    if (event.event === 'core.ready') {
      resetAuthorizedLoadStarted()
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
      applyAuthState(event.payload.state)
    }
    if (event.event === 'account.changed') {
      applyAccountState(event.payload.state)
    }
    if (event.event === 'playback.changed') {
      playback.acceptPlaybackEvent(event.payload.state)
    }
    if (event.event === 'lyrics.changed') playback.onLyricsChanged(event.payload.state)
    if (event.event === 'lyrics.match.changed') playback.onLocalMatchChanged(event.payload.state)
    if (event.event === 'diagnostic.notice') diagnosticNotice.value = event.payload
  },
  initialize: async read => {
    void playback.initializeLocalLyricsMatch()
    const appInfoResult = await read(() => window.musicBridge.getAppInfo())
    if (!appInfoResult.active) return
    appInfo.value = appInfoResult.value
    const storedQuality = window.localStorage.getItem('musicbridge.qualityPreference')
    if (['auto', 'standard', 'exhigh', 'lossless', 'hires'].includes(storedQuality ?? '')) {
      selectedQuality.value = storedQuality as PlaybackQualityPreference
    }
    const remoteResult = await read(() => window.musicBridge.getRemoteCoreState())
    if (!remoteResult.active) return
    remoteCoreState.value = remoteResult.value
    remoteSshTarget.value = restoreRemoteTarget(remoteCoreState.value.sshTarget, window.localStorage)
    remoteAutoStart.value = window.localStorage.getItem('musicbridge.remoteCore.autoStart') === '1'
    if (remoteAutoStart.value && remoteSshTarget.value && remoteCoreState.value.status === 'idle') {
      // 先在 Renderer 内标记切换中，避免隧道事件抵达前抢跑旧 Core 请求。
      remoteCoreState.value = { ...remoteCoreState.value, status: 'checking' }
      void startRemoteCore()
    }
    const coreResult = await read(() => window.musicBridge.getCoreHealth())
    if (!coreResult.active) return
    coreState.value = coreResult.value
    const authResult = await read(() => window.musicBridge.getAuthState())
    if (!authResult.active) return
    applyInitialAuthState(authResult.value)
    if (authResult.value.status !== 'authorized') {
      const accountResult = await read(loadAccountState)
      if (!accountResult.active) return
    }
    if (isCoreRuntimeStable(coreState.value.runtime, remoteCoreState.value.status)) {
      const playbackResult = await read(() => window.musicBridge.getPlaybackState())
      if (!playbackResult.active) return
      applyPlaybackState(playbackResult.value)
      await read(loadZones)
    }
  },
  onInitializationError: error => {
    coreError.value = true
    recordActionError(error)
  },
})

onMounted(() => lifecycle.start())

onUnmounted(() => {
  lifecycle.dispose()
  zoneRefreshCoordinator.dispose()
  journey.dispose()
  netease.dispose()
  search.dispose()
  browse.dispose()
  playback.dispose()
  roonArtworkCache.clear()
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
        :search-query="sidebarSearchQuery"
        :search-label="sidebarSearchLabel"
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
            <div><p class="section-kicker">本地音乐库</p><h2 id="roon-albums-heading">专辑</h2><p class="lede">在本地专辑中搜索，不包含网易云结果。</p></div>
          </div>
          <p v-if="localAlbumQuery.trim()" class="local-search-summary">“{{ localAlbumQuery.trim() }}”的本地专辑 <button type="button" class="text-button" @click="setLocalAlbumQuery('')">清除搜索</button></p>
          <RoonAlbumGrid
            :searching="!!localAlbumQuery.trim()"
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
          <div class="view-heading"><div><p class="section-kicker">本地音乐库</p><h2 id="roon-artists-heading">艺术家</h2><p class="lede">在本地艺术家中搜索，不包含网易云结果。</p></div></div>
          <p v-if="localArtistQuery.trim()" class="local-search-summary">“{{ localArtistQuery.trim() }}”的本地艺术家 <button type="button" class="text-button" @click="setLocalArtistQuery('')">清除搜索</button></p>
          <RoonEntityGrid
            :page="roonArtistsPage"
            entity-label="艺术家"
            :empty-title="localArtistQuery.trim() ? '没有匹配的本地艺术家' : '还没有可显示的艺术家'"
            :empty-copy="localArtistQuery.trim() ? '换一个关键词，或清除搜索查看全部艺术家。' : 'Roon Core 当前返回 0 位艺术家。'"
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
            :key="favoriteResolutionEpoch"
            :page="favoritesPage"
            :kind="favoriteKind"
            :initial-loading="favoritesInitialLoading"
            :loading-more="favoritesLoadingMore"
            :load-more-error="favoritesLoadMoreError"
            :error="favoritesError"
            @select="openFavorite"
            @remove="removeFavorite"
            @retry="retryFavorites"
            @load-more="favoritesPageAt(favoritesPage.offset + favoritesPage.limit)"
          />
        </section>

        <section v-else-if="currentView === 'roon-artist-detail' && selectedRoonArtist" class="view" aria-labelledby="roon-artist-heading">
          <button type="button" class="back-link" @click="returnFromRoonDetail('artist')">← {{ roonDetailBackLabel }}</button>
          <div class="view-heading"><div><p class="section-kicker">Roon 艺术家</p><h2 id="roon-artist-heading">{{ selectedRoonArtist.title }}</h2><p class="lede">只显示该艺术家在 Roon Library 中的真实专辑。</p><button type="button" class="secondary-button detail-favorite-button" :disabled="roonArtistFavoriteState === 'loading'" :aria-pressed="roonArtistFavoriteState === 'liked'" @click="toggleRoonEntityFavorite('artist')">{{ roonArtistFavoriteState === 'liked' ? '♥ 已收藏' : '♡ 收藏艺术家' }}</button></div></div>
          <RoonAlbumGrid
            :page="selectedRoonArtistPage"
            :initial-loading="roonArtistInitialLoading"
            :loading-more="roonArtistLoadingMore"
            :load-more-error="roonArtistLoadMoreError"
            :error="roonArtistError"
            @select="roonSearchOrigin ? selectAggregatedRoonItem($event) : navigateSource({ type: 'roon-album', reference: $event.reference })"
            @retry="loadRoonArtist(selectedRoonArtist.reference)"
            @load-more="roonArtistPageAt(selectedRoonArtistPage.offset + selectedRoonArtistPage.limit)"
          />
        </section>

        <RoonAlbumDetail
          v-else-if="currentView === 'roon-album-detail' && selectedRoonAlbum"
          :album="selectedRoonAlbum"
          :back-label="roonDetailBackLabel"
          :page="selectedRoonAlbumPage"
          :initial-loading="roonAlbumInitialLoading"
          :loading-more="roonAlbumLoadingMore"
          :load-more-error="roonAlbumLoadMoreError"
          :error="roonAlbumError"
          :favorite-state="roonAlbumFavoriteState"
          :playback-pending="playbackStartPending"
          @play-all="selectedRoonAlbumPage.items[0] && playRoonLibraryTrack(selectedRoonAlbumPage.items[0])"
          @back="returnFromRoonDetail('album')"
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

        <section v-else-if="currentView === 'search'" class="view view-search" :class="{ 'search-category-artists': searchCategory === 'artists' && !searchDetail }" aria-labelledby="search-heading">
          <div class="view-heading search-view-heading"><h2 id="search-heading">{{ searchQuery }}</h2></div>
          <nav v-if="!searchDetail" class="search-category-tabs" aria-label="搜索分类">
            <button v-for="category in ([{ id: 'all', label: '综合' }, { id: 'tracks', label: '单曲' }, { id: 'albums', label: '专辑' }, { id: 'artists', label: '艺人' }] as const)" :key="category.id" type="button" :aria-current="searchCategory === category.id ? 'page' : undefined" :class="{ active: searchCategory === category.id }" @click="selectSearchCategory(category.id)">{{ category.label }}</button>
          </nav>
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
              :loading-more="searchDetailLoadingMore" :load-more-error="searchDetailMoreError"
              @load-more="loadMoreSearchDetail"
              empty-title="没有可显示的歌曲"
              empty-copy="Provider 暂时没有返回此项的歌曲。"
              @play="playTrack"
              @queue="appendTrack"
              @play-next="insertTrackNext"
            />
          </template>
          <template v-else>
            <SearchEntities
              v-if="!searchSongsOpen"
              :mode="searchCategory === 'tracks' ? 'all' : searchCategory"
              @category="selectSearchCategory"
              :artists="searchArtistsPage.items" :albums="searchAlbumsPage.items"
              :roon-artists="roonSearchArtists.items" :roon-albums="roonSearchAlbums.items"
              :artists-loading="searchArtistsState === 'loading'" :albums-loading="searchAlbumsState === 'loading'"
              :roon-loading="roonSearchLoading" :artists-error="searchArtistsError" :albums-error="searchAlbumsError" :roon-error="roonSearchError"
              :more-roon-albums="!!roonSearchAlbums.hasMore" :more-roon-artists="!!roonSearchArtists.hasMore"
              :more-albums="searchAlbumsPage.hasMore" :more-artists="searchArtistsPage.hasMore"
              @artist="openSearchDetail('artist', $event.id, $event.name, '网易云')"
              @album="openSearchDetail('album', $event.id, $event.name, $event.artistName)"
              @roon="selectAggregatedRoonItem" @more="loadMoreSearchEntities"
            />
            <button v-if="searchSongsOpen" type="button" class="back-link" @click="returnToSearch">← 返回搜索结果</button>
            <section v-if="searchCategory === 'all' || searchSongsOpen" class="search-result-section" aria-labelledby="search-tracks-heading">
              <div class="search-section-heading"><h3 id="search-tracks-heading">单曲</h3><button v-if="!searchSongsOpen && searchPage.items.length" type="button" class="text-button" @click="openSearchSongs">查看全部 →</button><span v-if="searchPage.total">{{ searchPage.total }} 首</span></div>
              <p v-if="searchError === 'auth-required'" class="persistent-error">请先登录音乐服务，再搜索内容。</p>
              <p v-else-if="searchError === 'auth-expired'" class="persistent-error">登录已过期，请从侧栏账户菜单重新登录。</p>
              <p v-else-if="searchError === 'generic'" class="persistent-error">搜索单曲暂时不可用，请检查连接状态。</p>
              <SearchTrackPreview v-if="!searchSongsOpen" :tracks="searchPage.items" :busy="playbackStartPending" @play="playTrack" @queue="appendTrack" @play-next="insertTrackNext" />
              <p v-if="!searchSongsOpen && searchInitialLoading" role="status">正在搜索单曲…</p>
              <p v-else-if="!searchSongsOpen && !searchError && !searchPage.items.length" class="search-section-empty">没有匹配的单曲</p>
              <div v-if="searchSongsOpen" class="search-track-results">
                <TrackTable v-model:scroll-top="searchSongScrollTop"
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
