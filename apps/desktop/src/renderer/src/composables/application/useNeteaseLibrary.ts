import { computed, ref } from 'vue'
import type {
  DailyRecommendationsSnapshot, Page, PageRequest, PlaylistDetail, PlaylistSummary,
  PublicAccountState, PublicAuthState, PublicBridgeState, RemoteCoreTunnelState, TrackSummary,
} from '@music-bridge/contracts'
import type { MusicBridgePublicApi } from '../../../../preload/api.js'
import type { ViewId } from '../../components/navigation.js'
import { canLoadAuthorizedLibrary, isCoreRuntimeStable } from '../../core-readiness.js'
import { appendPage } from '../libraryPagination.js'
import {
  selectRandomPlaylistPages, settleHomePlaylistPages, shuffleTracks,
  type HomeRecommendationState,
} from '../homeRecommendations.js'

const LIBRARY_PAGE_SIZE = 20
const QR_POLL_INTERVAL_MS = 2_000

type LibraryErrorKind = 'auth-required' | 'auth-expired' | 'generic'
type DailyState = 'idle' | 'loading' | 'ready' | 'empty' | 'error'
type PlaylistLoadState = 'loading' | 'ready' | 'error'

export interface NeteaseLibraryOptions {
  api: MusicBridgePublicApi
  getCoreRuntime: () => PublicBridgeState['runtime'] | undefined
  getRemoteStatus: () => RemoteCoreTunnelState['status']
  getView: () => ViewId
  onMatchTracks: (tracks: readonly TrackSummary[], visible: boolean) => void | Promise<void>
  onPlaylistSwitch: () => void
  onPlaylistReady: (playlistId: string) => void
  onResetPrivate: () => void
  onError: (error: unknown) => void
  accountMessage: (error: unknown) => string
  dailyMessage: (error: unknown) => string
  libraryErrorKind: (error: unknown) => LibraryErrorKind
}

function emptyPage<T>(limit = LIBRARY_PAGE_SIZE): Page<T> {
  return { items: [], offset: 0, limit, total: 0, hasMore: false }
}

function localDayKey(now = Date.now()): string {
  const date = new Date(now)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function emptyDailyRecommendations(): DailyRecommendationsSnapshot {
  return { dayKey: localDayKey(), tracks: [] }
}

function acceptsPolling(state: PublicAuthState): boolean {
  return state.status === 'waiting' || state.status === 'scanned'
}

/** 网易云私有资料库的唯一状态持有者；跨领域清理和页面导航由调用方协调。 */
export function useNeteaseLibrary(options: NeteaseLibraryOptions) {
  const {
    api, getCoreRuntime, getRemoteStatus, getView, onMatchTracks, onPlaylistSwitch, onPlaylistReady,
    onResetPrivate, onError, accountMessage, dailyMessage, libraryErrorKind,
  } = options

  const authState = ref<PublicAuthState>({ status: 'idle' })
  const authError = ref(false)
  const accountState = ref<PublicAccountState>({ status: 'missing' })
  const accountError = ref<string | null>(null)
  const dailyRecommendations = ref<DailyRecommendationsSnapshot>(emptyDailyRecommendations())
  const dailyState = ref<DailyState>('idle')
  const dailyError = ref<string | null>(null)
  const likedPage = ref<Page<TrackSummary>>(emptyPage())
  const likedInitialLoading = ref(false)
  const likedLoadingMore = ref(false)
  const likedLoadMoreError = ref<string | null>(null)
  const likedError = ref<LibraryErrorKind | null>(null)
  const playlists = ref<readonly PlaylistSummary[]>([])
  const playlistState = ref<PlaylistLoadState>('ready')
  const playlistError = ref<unknown | null>(null)
  const selectedPlaylist = ref<PlaylistDetail | null>(null)
  const selectedPlaylistId = ref<string | null>(null)
  const playlistContentScrollTop = ref(0)
  const playlistTableScrollTop = ref(0)
  const playlistInitialLoading = ref(false)
  const playlistLoadingMore = ref(false)
  const playlistLoadMoreError = ref<string | null>(null)
  const playlistDetailError = ref<LibraryErrorKind | null>(null)
  const homePlaylistTracks = ref<readonly TrackSummary[]>([])
  const homeRecommendationState = ref<HomeRecommendationState>('loading')

  const likedHomeState = computed<'unauthorized' | 'loading' | 'ready' | 'empty' | 'error'>(() => {
    if (authState.value.status !== 'authorized') return 'unauthorized'
    if (likedInitialLoading.value && likedPage.value.items.length === 0) return 'loading'
    if (likedError.value) return 'error'
    return likedPage.value.items.length ? 'ready' : 'empty'
  })

  let disposed = false
  let authOperation = 0
  let authRevision = 0
  let authEventReceived = false
  let authorizedLibraryLoadStarted = false
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let pollChallengeId: string | undefined
  let pollInFlight = false
  let accountOperation = 0
  let dailyOperation = 0
  let likedRequestGeneration = 0
  let playlistListGeneration = 0
  let playlistRequestGeneration = 0
  let homeRecommendationOperation = 0
  let pendingPlaylistRequest: { id: string; page: PageRequest } | undefined

  const canLoadPrivate = (): boolean => !disposed && canLoadAuthorizedLibrary(
    authState.value.status, getCoreRuntime(), getRemoteStatus(),
  )

  function stopPolling(): void {
    if (pollTimer !== undefined) clearInterval(pollTimer)
    pollTimer = undefined
    pollChallengeId = undefined
  }

  function resetPlaylistList(): void {
    playlistListGeneration += 1
    playlists.value = []
    playlistState.value = 'ready'
    playlistError.value = null
  }

  function resetPrivateLibraryState(): void {
    accountOperation += 1
    dailyOperation += 1
    likedRequestGeneration += 1
    playlistRequestGeneration += 1
    homeRecommendationOperation += 1
    pendingPlaylistRequest = undefined
    authorizedLibraryLoadStarted = false
    likedPage.value = emptyPage()
    likedInitialLoading.value = false
    likedLoadingMore.value = false
    likedLoadMoreError.value = null
    likedError.value = null
    selectedPlaylist.value = null
    selectedPlaylistId.value = null
    playlistContentScrollTop.value = 0
    playlistTableScrollTop.value = 0
    playlistInitialLoading.value = false
    playlistLoadingMore.value = false
    playlistLoadMoreError.value = null
    playlistDetailError.value = null
    homePlaylistTracks.value = []
    homeRecommendationState.value = 'ready'
    dailyRecommendations.value = emptyDailyRecommendations()
    dailyState.value = 'empty'
    dailyError.value = null
    accountError.value = null
    resetPlaylistList()
    onResetPrivate()
  }

  function resetAuthorizedLoadStarted(): void {
    if (disposed) return
    authorizedLibraryLoadStarted = false
    accountOperation += 1
    dailyOperation += 1
    likedRequestGeneration += 1
    playlistListGeneration += 1
    playlistRequestGeneration += 1
    homeRecommendationOperation += 1
    likedInitialLoading.value = false
    likedLoadingMore.value = false
    playlistLoadingMore.value = false
    if (selectedPlaylistId.value) {
      pendingPlaylistRequest = { id: selectedPlaylistId.value, page: { offset: 0, limit: LIBRARY_PAGE_SIZE } }
      playlistInitialLoading.value = true
    }
    if (authState.value.status === 'authorized') {
      accountState.value = { status: 'loading' }
      dailyState.value = 'loading'
      homeRecommendationState.value = 'loading'
    }
  }

  async function loadLiked(page: PageRequest = { offset: 0, limit: LIBRARY_PAGE_SIZE }): Promise<void> {
    if (disposed) return
    if (authState.value.status !== 'authorized') {
      likedRequestGeneration += 1
      likedPage.value = emptyPage()
      likedInitialLoading.value = false
      likedLoadingMore.value = false
      return
    }
    const initial = page.offset === 0
    if (!canLoadPrivate()) {
      if (initial) likedInitialLoading.value = true
      return
    }
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
      const result = await api.getLikedTracks(page)
      if (disposed || generation !== likedRequestGeneration || !canLoadPrivate()) return
      likedPage.value = initial ? result : appendPage(likedPage.value, result)
      likedError.value = null
      if (initial) likedInitialLoading.value = false
      else likedLoadingMore.value = false
    } catch (error) {
      if (disposed || generation !== likedRequestGeneration || !canLoadPrivate()) return
      if (initial) {
        likedInitialLoading.value = false
        likedError.value = libraryErrorKind(error)
      } else {
        likedLoadingMore.value = false
        likedLoadMoreError.value = '加载失败，点击重试'
      }
    }
  }

  function likedPageAt(offset: number): void {
    void loadLiked({ offset, limit: LIBRARY_PAGE_SIZE })
  }

  async function loadDailyRecommendations(): Promise<void> {
    if (disposed) return
    const operation = ++dailyOperation
    dailyError.value = null
    if (authState.value.status !== 'authorized') {
      dailyRecommendations.value = emptyDailyRecommendations()
      dailyState.value = 'empty'
      return
    }
    dailyState.value = 'loading'
    if (!canLoadPrivate()) return
    try {
      const snapshot = await api.getDailyRecommendations()
      if (disposed || operation !== dailyOperation || !canLoadPrivate()) return
      dailyRecommendations.value = snapshot
      void onMatchTracks(snapshot.tracks, getView() === 'home' || getView() === 'daily-recommendations')
      dailyState.value = snapshot.tracks.length ? 'ready' : 'empty'
    } catch (error) {
      if (disposed || operation !== dailyOperation || !canLoadPrivate()) return
      dailyRecommendations.value = emptyDailyRecommendations()
      dailyState.value = 'error'
      dailyError.value = dailyMessage(error)
    }
  }

  async function loadAccountState(): Promise<void> {
    if (disposed) return
    const operation = ++accountOperation
    accountError.value = null
    if (!isCoreRuntimeStable(getCoreRuntime(), getRemoteStatus())) {
      accountState.value = authState.value.status === 'authorized' ? { status: 'loading' } : { status: 'missing' }
      return
    }
    try {
      const state = await api.getAccountState()
      if (disposed || operation !== accountOperation || !isCoreRuntimeStable(getCoreRuntime(), getRemoteStatus())) return
      accountState.value = state
    } catch (error) {
      if (disposed || operation !== accountOperation || !isCoreRuntimeStable(getCoreRuntime(), getRemoteStatus())) return
      accountState.value = { status: 'unavailable' }
      accountError.value = accountMessage(error)
    }
  }

  async function refreshAccountProfile(): Promise<void> {
    if (disposed) return
    const operation = ++accountOperation
    accountError.value = null
    if (!isCoreRuntimeStable(getCoreRuntime(), getRemoteStatus())) {
      accountState.value = { status: 'loading' }
      return
    }
    try {
      const state = await api.refreshAccountProfile()
      if (disposed || operation !== accountOperation || !isCoreRuntimeStable(getCoreRuntime(), getRemoteStatus())) return
      accountState.value = state
      if (authState.value.status === 'authorized') void loadDailyRecommendations()
    } catch (error) {
      if (disposed || operation !== accountOperation || !isCoreRuntimeStable(getCoreRuntime(), getRemoteStatus())) return
      accountState.value = { status: 'unavailable' }
      accountError.value = accountMessage(error)
    }
  }

  async function loadHomeRecommendations(): Promise<void> {
    if (disposed) return
    const operation = ++homeRecommendationOperation
    homeRecommendationState.value = 'loading'
    if (!canLoadPrivate()) return
    const selections = selectRandomPlaylistPages(playlists.value)
    if (!selections.length) {
      homePlaylistTracks.value = []
      homeRecommendationState.value = 'ready'
      return
    }
    try {
      const settled = await settleHomePlaylistPages(
        selections.map((selection) => api.getPlaylist(selection.playlistId, selection.page)),
      )
      if (disposed || operation !== homeRecommendationOperation || !canLoadPrivate()) return
      homePlaylistTracks.value = shuffleTracks(settled.tracks)
      homeRecommendationState.value = settled.successCount > 0 ? 'ready' : 'error'
    } catch {
      if (disposed || operation !== homeRecommendationOperation || !canLoadPrivate()) return
      homePlaylistTracks.value = []
      homeRecommendationState.value = 'error'
    }
  }

  async function loadPlaylists(): Promise<void> {
    if (disposed) return
    if (authState.value.status !== 'authorized') {
      resetPlaylistList()
      homePlaylistTracks.value = []
      homeRecommendationState.value = 'ready'
      return
    }
    if (!canLoadPrivate()) {
      homeRecommendationState.value = 'loading'
      return
    }
    const generation = ++playlistListGeneration
    playlistState.value = 'loading'
    playlistError.value = null
    try {
      const result = await api.getUserPlaylists()
      if (disposed || generation !== playlistListGeneration || !canLoadPrivate()) return
      playlists.value = result
      playlistState.value = 'ready'
      await loadHomeRecommendations()
    } catch (error) {
      if (disposed || generation !== playlistListGeneration || !canLoadPrivate()) return
      playlistError.value = error
      playlistState.value = 'error'
      homePlaylistTracks.value = []
      homeRecommendationState.value = 'error'
    }
  }

  function refreshHomeRecommendations(): void {
    if (playlistState.value === 'ready') void loadHomeRecommendations()
    else void loadPlaylists()
  }

  async function loadPlaylist(
    playlistId: string,
    page: PageRequest = { offset: 0, limit: LIBRARY_PAGE_SIZE },
  ): Promise<void> {
    if (disposed || authState.value.status !== 'authorized') return
    const switchingPlaylist = selectedPlaylistId.value !== playlistId
    selectedPlaylistId.value = playlistId
    const previousPlaylist = selectedPlaylist.value
    const initial = page.offset === 0
    if (switchingPlaylist) {
      onPlaylistSwitch()
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
    if (!canLoadPrivate()) {
      pendingPlaylistRequest = { id: playlistId, page }
      return
    }
    const generation = playlistRequestGeneration
    try {
      const result = await api.getPlaylist(playlistId, page)
      if (disposed || generation !== playlistRequestGeneration || selectedPlaylistId.value !== playlistId || !canLoadPrivate()) return
      selectedPlaylist.value = {
        ...result,
        tracks: initial ? result.tracks : appendPage(previousPlaylist?.tracks ?? null, result.tracks),
      }
      pendingPlaylistRequest = undefined
      onPlaylistReady(playlistId)
      playlistDetailError.value = null
      if (initial) playlistInitialLoading.value = false
      else playlistLoadingMore.value = false
    } catch (error) {
      if (disposed || generation !== playlistRequestGeneration || selectedPlaylistId.value !== playlistId || !canLoadPrivate()) return
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
    if (selectedPlaylistId.value) void loadPlaylist(selectedPlaylistId.value)
  }

  function playlistPageAt(offset: number): void {
    if (selectedPlaylist.value) void loadPlaylist(selectedPlaylist.value.id, { offset, limit: LIBRARY_PAGE_SIZE })
  }

  function loadAuthorizedLibraryWhenReady(): void {
    if (authorizedLibraryLoadStarted || !canLoadPrivate()) return
    authorizedLibraryLoadStarted = true
    void loadAccountState()
    void loadLiked()
    void loadPlaylists()
    void loadDailyRecommendations()
    if (pendingPlaylistRequest) {
      const pending = pendingPlaylistRequest
      pendingPlaylistRequest = undefined
      void loadPlaylist(pending.id, pending.page)
    }
  }

  function acceptAuthState(state: PublicAuthState): void {
    if (disposed) return
    authRevision += 1
    authState.value = state
    if (acceptsPolling(state)) {
      startPolling()
    } else {
      stopPolling()
    }
    if (state.status === 'authorized') {
      resetPrivateLibraryState()
      dailyState.value = 'loading'
      homeRecommendationState.value = 'loading'
      accountState.value = { status: 'loading' }
      loadAuthorizedLibraryWhenReady()
    } else if (state.status === 'idle' || state.status === 'cancelled' || state.status === 'expired') {
      resetPrivateLibraryState()
      accountState.value = { status: 'missing' }
    }
  }

  function applyAuthState(state: PublicAuthState): void {
    authEventReceived = true
    acceptAuthState(state)
  }

  function applyInitialAuthState(state: PublicAuthState): void {
    if (disposed) return
    if (!authEventReceived && authOperation === 0) acceptAuthState(state)
    else loadAuthorizedLibraryWhenReady()
  }

  function applyAccountState(state: PublicAccountState): void {
    if (disposed) return
    // 切换 Core 时早到的 missing 不应清掉仍在等待恢复的账户资料。
    if (state.status === 'missing' && authState.value.status === 'authorized' && !canLoadPrivate()) return
    accountOperation += 1
    accountState.value = state
    if (state.status === 'ready' && canLoadPrivate()) void loadDailyRecommendations()
    if (state.status === 'missing' && (authState.value.status !== 'authorized' || getCoreRuntime() === 'ready')) {
      resetPrivateLibraryState()
    }
  }

  async function pollQr(operation: number, challengeId: string): Promise<void> {
    if (disposed || pollInFlight || operation !== authOperation || !isCoreRuntimeStable(getCoreRuntime(), getRemoteStatus())) return
    if (authState.value.challengeId !== challengeId) return
    pollInFlight = true
    const revision = authRevision
    try {
      const state = await api.pollQrLogin(challengeId)
      if (disposed || operation !== authOperation || revision !== authRevision || authState.value.challengeId !== challengeId) return
      acceptAuthState(state)
    } catch (error) {
      if (!disposed && operation === authOperation && revision === authRevision && authState.value.challengeId === challengeId) {
        authError.value = true
        onError(error)
        stopPolling()
      }
    } finally {
      pollInFlight = false
    }
  }

  function startPolling(): void {
    const challengeId = authState.value.challengeId
    if (disposed || !challengeId) return
    if (pollTimer !== undefined && pollChallengeId === challengeId) return
    stopPolling()
    pollChallengeId = challengeId
    const operation = authOperation
    pollTimer = setInterval(() => void pollQr(operation, challengeId), QR_POLL_INTERVAL_MS)
    void pollQr(operation, challengeId)
  }

  async function beginQrLogin(): Promise<void> {
    if (disposed) return
    const operation = ++authOperation
    const revision = authRevision
    authError.value = false
    stopPolling()
    try {
      const state = await api.beginQrLogin()
      if (disposed || operation !== authOperation || revision !== authRevision) return
      acceptAuthState(state)
    } catch (error) {
      if (disposed || operation !== authOperation || revision !== authRevision) return
      authError.value = true
      onError(error)
    }
  }

  async function cancelQrLogin(): Promise<void> {
    const challengeId = authState.value.challengeId
    if (disposed || !challengeId) return
    const operation = ++authOperation
    const revision = authRevision
    stopPolling()
    try {
      const state = await api.cancelQrLogin(challengeId)
      if (disposed || operation !== authOperation || revision !== authRevision) return
      acceptAuthState(state)
    } catch (error) {
      if (disposed || operation !== authOperation || revision !== authRevision) return
      authError.value = true
      onError(error)
    }
  }

  async function logout(): Promise<void> {
    if (disposed || !window.confirm('退出登录会停止播放、清空队列并移除本地账户状态。确定继续吗？')) return
    const operation = ++authOperation
    const revision = authRevision
    authError.value = false
    stopPolling()
    try {
      const state = await api.logout()
      if (disposed || operation !== authOperation || revision !== authRevision) return
      acceptAuthState(state)
      accountState.value = { status: 'missing' }
    } catch (error) {
      if (disposed || operation !== authOperation || revision !== authRevision) return
      authError.value = true
      onError(error)
    }
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    authOperation += 1
    authRevision += 1
    accountOperation += 1
    dailyOperation += 1
    likedRequestGeneration += 1
    playlistListGeneration += 1
    playlistRequestGeneration += 1
    homeRecommendationOperation += 1
    pendingPlaylistRequest = undefined
    stopPolling()
  }

  return {
    authState, authError, accountState, accountError,
    dailyRecommendations, dailyState, dailyError,
    likedPage, likedInitialLoading, likedLoadingMore, likedLoadMoreError, likedError, likedHomeState,
    playlists, playlistState, playlistError,
    selectedPlaylist, selectedPlaylistId, playlistContentScrollTop, playlistTableScrollTop,
    playlistInitialLoading, playlistLoadingMore, playlistLoadMoreError, playlistDetailError,
    homePlaylistTracks, homeRecommendationState,
    loadLiked, likedPageAt, loadDailyRecommendations, loadAccountState, refreshAccountProfile,
    loadPlaylists, loadHomeRecommendations, refreshHomeRecommendations,
    loadPlaylist, retryPlaylist, playlistPageAt,
    applyAuthState, applyAccountState, applyInitialAuthState,
    loadAuthorizedLibraryWhenReady, resetAuthorizedLoadStarted, resetPrivateLibraryState,
    beginQrLogin, cancelQrLogin, logout, dispose,
  }
}
