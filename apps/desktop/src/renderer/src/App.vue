<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

import type {
  LyricsSnapshot,
  Page,
  PageRequest,
  PlaybackQuality,
  PlaybackQueueItem,
  PlaybackSnapshot,
  PlaylistDetail,
  PlaylistSummary,
  PublicAuthState,
  PublicBridgeState,
  PublicRoonZone,
  TrackSummary,
} from '@music-bridge/contracts'
import type { AppInfo } from '../../preload/api.js'

type ViewId =
  | 'home'
  | 'search'
  | 'library'
  | 'playlist-detail'
  | 'now-playing'
  | 'queue'
  | 'settings'
  | 'diagnostics'

const LIBRARY_PAGE_SIZE = 20
const SEARCH_DEBOUNCE_MS = 350

const NAV_ITEMS: readonly { id: Exclude<ViewId, 'playlist-detail'>; label: string; hint: string }[] = [
  { id: 'home', label: 'Home', hint: '总览' },
  { id: 'search', label: 'Search', hint: '发现音乐' },
  { id: 'library', label: 'Library', hint: '音乐库' },
  { id: 'now-playing', label: 'Now Playing', hint: '正在播放' },
  { id: 'queue', label: 'Queue', hint: '播放队列' },
  { id: 'settings', label: 'Settings', hint: '偏好设置' },
  { id: 'diagnostics', label: 'Diagnostics', hint: '诊断信息' },
]

const VIEW_LABELS: Record<ViewId, string> = {
  home: 'Home',
  search: 'Search',
  library: 'Library',
  'playlist-detail': 'Playlist detail',
  'now-playing': 'Now Playing',
  queue: 'Queue',
  settings: 'Settings',
  diagnostics: 'Diagnostics',
}

function emptyPage<T>(limit = LIBRARY_PAGE_SIZE): Page<T> {
  return { items: [], offset: 0, limit, total: 0, hasMore: false }
}

function emptyLyricsSnapshot(status: LyricsSnapshot['status'] = 'idle'): LyricsSnapshot {
  return { status, lines: [], activeLineIndex: -1, timingSource: 'static' }
}

const appInfo = ref<AppInfo | null>(null)
const currentView = ref<ViewId>('home')
const coreState = ref<PublicBridgeState | null>(null)
const authState = ref<PublicAuthState>({ status: 'idle' })
const coreError = ref(false)
const authError = ref(false)
const playbackState = ref<PlaybackSnapshot | null>(null)
const lyricsSnapshot = ref<LyricsSnapshot>(emptyLyricsSnapshot())
const zones = ref<readonly PublicRoonZone[]>([])
const selectedQuality = ref<PlaybackQuality>('lossless')
const lyricsOrQueue = ref<'lyrics' | 'queue'>('lyrics')
const actionError = ref<string | null>(null)
const actionDiagnosticId = ref<string | null>(null)
const diagnosticNotice = ref<{ code: string; message?: string } | null>(null)

const libraryTab = ref<'liked' | 'playlists'>('liked')
const searchQuery = ref('')
const searchPage = ref<Page<TrackSummary>>(emptyPage())
const likedPage = ref<Page<TrackSummary>>(emptyPage())
const playlists = ref<readonly PlaylistSummary[]>([])
const selectedPlaylist = ref<PlaylistDetail | null>(null)
const libraryBusy = ref(false)
const libraryError = ref<'auth-expired' | 'generic' | null>(null)

let removeCoreListener: (() => void) | undefined
let pollTimer: ReturnType<typeof setInterval> | undefined
let searchTimer: ReturnType<typeof setTimeout> | undefined
let authOperation = 0
let pollInFlight = false
let libraryOperation = 0
let lyricsOperation = 0

const currentTrack = computed(() => playbackState.value?.currentTrack)
const currentLyricLine = computed(() => {
  const index = lyricsSnapshot.value.activeLineIndex
  return index >= 0 ? lyricsSnapshot.value.lines[index]?.text : undefined
})
const selectedZone = computed(() => {
  const selectedId = playbackState.value?.selectedZoneId
  return zones.value.find((zone) => zone.zoneId === selectedId) ?? zones.value.find((zone) => zone.selected)
})
const viewTitle = computed(() => VIEW_LABELS[currentView.value])
const providerConfigured = computed(() => coreState.value?.provider === 'configured')
const hasPlaybackIssue = computed(() => Boolean(playbackState.value?.lastIssue || actionError.value))

function navigate(view: ViewId): void {
  currentView.value = view
  actionError.value = null
  actionDiagnosticId.value = null
  if (view === 'search' && searchQuery.value.trim()) scheduleSearch()
  if (view === 'library' && libraryTab.value === 'liked' && likedPage.value.items.length === 0) {
    void loadLiked()
  }
  if (view === 'library' && libraryTab.value === 'playlists' && playlists.value.length === 0) {
    void loadPlaylists()
  }
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

function isAuthExpired(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'AUTH_EXPIRED'
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

function actionableMessage(error: unknown): string {
  switch (errorCode(error)) {
    case 'AUTH_REQUIRED':
    case 'AUTH_EXPIRED':
      return 'Provider 登录已失效，请到 Settings 重新登录。'
    case 'ROON_NOT_PAIRED':
      return 'Roon 尚未配对，请先确认 Roon Core 正在运行。'
    case 'ROON_ZONE_NOT_SELECTED':
      return '请先在 Settings 选择播放 Zone。'
    case 'QUALITY_DOWNGRADED':
      return '当前请求质量已被安全降级，实际质量以 Signal Path 为准。'
    case 'ROON_ZONE_LOST':
      return '播放 Zone 暂时不可用，请检查 Roon 状态后重试。'
    default:
      return '操作暂时不可用，请到 Diagnostics 查看状态。'
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
}

function applyLibraryError(error: unknown, operation: number): void {
  if (operation !== libraryOperation) return
  libraryBusy.value = false
  libraryError.value = isAuthExpired(error) ? 'auth-expired' : 'generic'
}

function beginLibraryOperation(): number {
  libraryOperation += 1
  libraryError.value = null
  return libraryOperation
}

async function loadSearch(query: string, page: PageRequest, operation: number): Promise<void> {
  libraryBusy.value = true
  try {
    const result = await window.musicBridge.searchTracks(query, page)
    if (operation !== libraryOperation) return
    searchPage.value = result
    libraryBusy.value = false
  } catch (error) {
    applyLibraryError(error, operation)
  }
}

function scheduleSearch(): void {
  stopSearchTimer()
  const operation = beginLibraryOperation()
  const query = searchQuery.value.trim()
  if (query.length === 0) {
    searchPage.value = emptyPage()
    libraryBusy.value = false
    return
  }
  searchTimer = setTimeout(() => {
    searchTimer = undefined
    void loadSearch(query, { offset: 0, limit: LIBRARY_PAGE_SIZE }, operation)
  }, SEARCH_DEBOUNCE_MS)
}

async function loadLiked(page: PageRequest = { offset: 0, limit: LIBRARY_PAGE_SIZE }): Promise<void> {
  const operation = beginLibraryOperation()
  libraryBusy.value = true
  try {
    const result = await window.musicBridge.getLikedTracks(page)
    if (operation !== libraryOperation) return
    likedPage.value = result
    libraryBusy.value = false
  } catch (error) {
    applyLibraryError(error, operation)
  }
}

async function loadPlaylists(): Promise<void> {
  const operation = beginLibraryOperation()
  libraryBusy.value = true
  try {
    const result = await window.musicBridge.getUserPlaylists()
    if (operation !== libraryOperation) return
    playlists.value = result
    selectedPlaylist.value = null
    libraryBusy.value = false
  } catch (error) {
    applyLibraryError(error, operation)
  }
}

async function loadPlaylist(
  playlistId: string,
  page: PageRequest = { offset: 0, limit: LIBRARY_PAGE_SIZE },
): Promise<void> {
  const operation = beginLibraryOperation()
  libraryBusy.value = true
  try {
    const result = await window.musicBridge.getPlaylist(playlistId, page)
    if (operation !== libraryOperation) return
    selectedPlaylist.value = result
    currentView.value = 'playlist-detail'
    libraryBusy.value = false
  } catch (error) {
    applyLibraryError(error, operation)
  }
}

function searchPageAt(offset: number): void {
  const query = searchQuery.value.trim()
  if (!query) return
  stopSearchTimer()
  const operation = beginLibraryOperation()
  void loadSearch(query, { offset, limit: LIBRARY_PAGE_SIZE }, operation)
}

function likedPageAt(offset: number): void {
  void loadLiked({ offset, limit: LIBRARY_PAGE_SIZE })
}

function playlistPageAt(offset: number): void {
  const playlistId = selectedPlaylist.value?.id
  if (playlistId) void loadPlaylist(playlistId, { offset, limit: LIBRARY_PAGE_SIZE })
}

function selectLibraryTab(tab: 'liked' | 'playlists'): void {
  stopSearchTimer()
  libraryTab.value = tab
  if (tab === 'liked') void loadLiked()
  if (tab === 'playlists') void loadPlaylists()
}

function acceptsPolling(state: PublicAuthState): boolean {
  return state.status === 'waiting' || state.status === 'scanned'
}

function applyAuthState(state: PublicAuthState, operation = authOperation): void {
  if (operation !== authOperation) return
  authState.value = state
  if (!acceptsPolling(state)) stopPolling()
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
  authOperation += 1
  authError.value = false
  stopPolling()
  try {
    applyAuthState(await window.musicBridge.logout())
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
  playbackState.value = snapshot
  const trackId = snapshot.currentTrack?.id
  if (trackId) void loadLyrics(trackId)
  else {
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

async function playTrack(track: TrackSummary, addToQueue = false): Promise<void> {
  actionError.value = null
  try {
    if (addToQueue && playbackState.value?.queue.items.length) {
      const items = [
        ...ipcQueueItems(playbackState.value.queue.items),
        { trackId: track.id, quality: selectedQuality.value },
      ]
      const index = Math.max(0, playbackState.value.queue.index)
      applyPlaybackState(await window.musicBridge.replaceQueue(items, index))
    } else {
      applyPlaybackState(await window.musicBridge.play(track.id, selectedQuality.value))
    }
    currentView.value = 'now-playing'
  } catch (error) {
    recordActionError(error)
  }
}

async function playQueueItem(item: PlaybackQueueItem, index: number): Promise<void> {
  const items = playbackState.value?.queue.items
  if (!items?.length) return
  try {
    applyPlaybackState(await window.musicBridge.replaceQueue(ipcQueueItems(items), index))
    currentView.value = 'now-playing'
  } catch (error) {
    recordActionError(error)
  }
}

async function stopPlayback(): Promise<void> {
  try {
    applyPlaybackState(await window.musicBridge.stop())
  } catch (error) {
    recordActionError(error)
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

async function retryAction(): Promise<void> {
  const track = currentTrack.value
  if (track) await playTrack(track)
  else await refreshPlayback()
}

function formatDuration(durationMs: number | undefined): string {
  if (!durationMs || durationMs < 0) return '—'
  const seconds = Math.floor(durationMs / 1_000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function qualityLabel(quality: string | undefined): string {
  if (!quality) return '—'
  return quality === 'hires' ? 'Hi-Res' : quality[0].toUpperCase() + quality.slice(1)
}

function ipcQueueItems(items: readonly PlaybackQueueItem[]): PlaybackQueueItem[] {
  return items.map((item) => ({ trackId: item.trackId, quality: item.quality }))
}

onMounted(async () => {
  removeCoreListener = window.musicBridge.onCoreEvent((event) => {
    if (event.event === 'core.ready' || event.event === 'core.health' || event.event === 'roon.changed') {
      coreState.value = event.payload.state
    }
    if (event.event === 'auth.changed') applyAuthState(event.payload.state)
    if (event.event === 'playback.changed') applyPlaybackState(event.payload.state)
    if (event.event === 'lyrics.changed') lyricsSnapshot.value = event.payload.state
    if (event.event === 'diagnostic.notice') diagnosticNotice.value = event.payload
  })
  try {
    appInfo.value = await window.musicBridge.getAppInfo()
    coreState.value = await window.musicBridge.getCoreHealth()
    applyAuthState(await window.musicBridge.getAuthState())
    applyPlaybackState(await window.musicBridge.getPlaybackState())
    await loadZones()
  } catch (error) {
    coreError.value = true
    recordActionError(error)
  }
})

onUnmounted(() => {
  removeCoreListener?.()
  stopPolling()
  stopSearchTimer()
})
</script>

<template>
  <main class="app-shell">
    <aside class="sidebar" aria-label="主导航">
      <div class="brand-lockup">
        <span class="brand-mark" aria-hidden="true">MB</span>
        <div>
          <strong>Music Bridge</strong>
          <span>for Roon</span>
        </div>
      </div>

      <nav class="primary-nav" aria-label="应用视图">
        <button
          v-for="item in NAV_ITEMS"
          :key="item.id"
          type="button"
          class="nav-item"
          :class="{ selected: currentView === item.id || (item.id === 'library' && currentView === 'playlist-detail') }"
          :aria-current="currentView === item.id || (item.id === 'library' && currentView === 'playlist-detail') ? 'page' : undefined"
          @click="navigate(item.id)"
        >
          <span class="nav-icon" aria-hidden="true">{{ item.label.slice(0, 1) }}</span>
          <span><strong>{{ item.label }}</strong><small>{{ item.hint }}</small></span>
        </button>
      </nav>

      <div class="sidebar-footer">
        <div class="mini-status"><span class="status-led" :class="coreState?.runtime"></span><span>Bridge {{ coreState?.runtime ?? 'starting' }}</span></div>
        <button type="button" class="support-link" @click="navigate('diagnostics')">运行状态</button>
      </div>
    </aside>

    <section class="workspace">
      <header class="topbar">
        <div>
          <p class="section-kicker">Music Bridge / V1</p>
          <h1>{{ viewTitle }}</h1>
        </div>
        <div class="connection-strip" aria-label="连接状态">
          <span class="connection-pill"><i :class="`status-led ${coreState?.runtime ?? 'starting'}`"></i>Core / Bridge Core 状态 {{ coreState?.runtime ?? 'starting' }}</span>
          <span class="connection-pill"><i :class="`status-led ${coreState?.roon ?? 'disconnected'}`"></i>Roon / Roon 状态 {{ coreState?.roon ?? 'disconnected' }}</span>
          <span class="connection-pill"><i :class="`status-led ${coreState?.provider ?? 'missing'}`"></i>Provider / 网易云状态 {{ coreState?.provider ?? 'missing' }}</span>
        </div>
      </header>

      <div class="content-scroll">
        <section v-if="currentView === 'home'" class="view home-view" aria-labelledby="home-heading">
          <div class="view-intro">
            <div>
              <p class="section-kicker">Local Hi-Fi console</p>
              <h2 id="home-heading">把音乐留在你选择的 Zone。</h2>
              <p class="lede">控制面板只负责清晰地表达状态与动作，Bridge Core 继续守住 Provider、Roon 和流媒体边界。</p>
            </div>
            <button type="button" class="primary-button" @click="navigate('search')">开始搜索</button>
          </div>

          <div class="overview-grid">
            <article class="feature-card feature-card-accent">
              <p class="section-kicker">Now Playing</p>
              <h3>{{ currentTrack?.title ?? '还没有正在播放的内容' }}</h3>
              <p>{{ currentTrack ? `${currentTrack.artists.join('、')} · ${currentTrack.album}` : '从 Search 或 Library 选择一首歌曲开始。' }}</p>
              <button v-if="currentTrack" type="button" class="text-button" @click="navigate('now-playing')">查看正在播放 →</button>
              <button v-else type="button" class="text-button" @click="navigate('settings')">检查连接 →</button>
            </article>
            <article class="feature-card">
              <p class="section-kicker">Queue</p>
              <h3>{{ playbackState?.queue.items.length ?? 0 }} 首待播</h3>
              <p>{{ selectedZone?.displayName ?? '尚未选择 Zone' }}</p>
              <button type="button" class="text-button" @click="navigate('queue')">打开队列 →</button>
            </article>
            <article class="feature-card">
              <p class="section-kicker">Lyrics</p>
              <h3>{{ lyricsSnapshot.status === 'ready' ? '同步中' : '等待内容' }}</h3>
              <p>{{ currentLyricLine ?? '当前曲目歌词状态会显示在 Now Playing。' }}</p>
              <button type="button" class="text-button" @click="navigate('now-playing')">查看歌词 →</button>
            </article>
          </div>

          <div class="status-row" aria-label="系统摘要">
            <article><span>Bridge Core</span><strong>{{ coreState?.runtime ?? (coreError ? '不可用' : '读取中') }}</strong></article>
            <article><span>Roon</span><strong>{{ coreState?.roon ?? '读取中' }}</strong></article>
            <article><span>Provider</span><strong>{{ coreState?.provider ?? '读取中' }}</strong></article>
            <article><span>活动流</span><strong>{{ coreState?.activeStreamCount ?? 0 }}</strong></article>
          </div>
        </section>

        <section v-else-if="currentView === 'search'" class="view" aria-labelledby="search-heading">
          <div class="view-heading"><div><p class="section-kicker">Discovery</p><h2 id="search-heading">Search</h2><p class="lede">用 Provider 搜索内容，结果通过 Core 分页返回。</p></div></div>
          <div class="search-box">
            <label for="search-input">搜索歌曲、艺人或专辑</label>
            <div class="search-controls"><input id="search-input" v-model="searchQuery" type="search" maxlength="100" placeholder="输入关键词" @input="scheduleSearch" @keyup.enter="scheduleSearch" /><button type="button" class="primary-button" @click="scheduleSearch">搜索</button></div>
          </div>
          <p v-if="libraryError === 'auth-expired'" class="persistent-error">登录已过期，请到 Settings 重新扫码登录。</p>
          <p v-else-if="libraryError === 'generic'" class="persistent-error">搜索暂时不可用，请检查 Diagnostics。</p>
          <div class="result-list" aria-label="搜索结果">
            <div v-if="libraryBusy" class="empty-state"><span class="loading-line"></span><p>正在读取结果…</p></div>
            <div v-else-if="!searchPage.items.length" class="empty-state"><span class="empty-glyph">⌕</span><h3>{{ searchQuery.trim() ? '没有匹配结果' : '开始一段搜索' }}</h3><p>搜索结果会保留在当前视图，旧请求不会覆盖新请求。</p></div>
            <article v-for="track in searchPage.items" v-else :key="track.id" class="track-row">
              <div class="track-art"><img v-if="track.artworkUrl" :src="track.artworkUrl" :alt="`${track.title} 封面`" loading="lazy" /><span v-else aria-hidden="true">♪</span></div>
              <div class="track-copy"><strong>{{ track.title }}</strong><span>{{ track.artists.join('、') }} · {{ track.album }}</span><small>{{ formatDuration(track.durationMs) }}</small></div>
              <div class="row-actions"><button type="button" class="icon-action" :aria-label="`播放 ${track.title}`" @click="playTrack(track)">播放</button><button type="button" class="icon-action secondary" :aria-label="`添加 ${track.title} 到队列`" @click="playTrack(track, true)">加入队列</button></div>
            </article>
          </div>
          <div v-if="searchPage.total > 0" class="pagination"><button type="button" class="secondary-button" :disabled="searchPage.offset === 0 || libraryBusy" @click="searchPageAt(Math.max(0, searchPage.offset - searchPage.limit))">上一页</button><span>{{ searchPage.offset + 1 }}–{{ Math.min(searchPage.offset + searchPage.items.length, searchPage.total) }} / {{ searchPage.total }}</span><button type="button" class="secondary-button" :disabled="!searchPage.hasMore || libraryBusy" @click="searchPageAt(searchPage.offset + searchPage.limit)">下一页</button></div>
        </section>

        <section v-else-if="currentView === 'library'" class="view" aria-labelledby="library-heading">
          <div class="view-heading"><div><p class="section-kicker">Your collection</p><h2 id="library-heading">Library</h2><p class="lede">音乐库临时列表：我喜欢与歌单使用分页读取，列表不会一次性吞掉整个库。</p></div></div>
          <div class="segmented-control" role="tablist" aria-label="音乐库视图"><button type="button" :class="{ selected: libraryTab === 'liked' }" role="tab" :aria-selected="libraryTab === 'liked'" @click="selectLibraryTab('liked')">我喜欢</button><button type="button" :class="{ selected: libraryTab === 'playlists' }" role="tab" :aria-selected="libraryTab === 'playlists'" @click="selectLibraryTab('playlists')">我的歌单</button></div>
          <p v-if="libraryError" class="persistent-error">{{ libraryError === 'auth-expired' ? '登录已过期，请到 Settings 重新登录。' : '音乐库暂时不可用，请稍后重试。' }}</p>
          <div v-if="libraryTab === 'liked'" class="result-list"><div v-if="libraryBusy" class="empty-state"><p>读取我喜欢…</p></div><div v-else-if="!likedPage.items.length" class="empty-state"><h3>还没有喜欢的内容</h3><p>登录 Provider 后，这里会显示你的收藏。</p></div><article v-for="track in likedPage.items" v-else :key="track.id" class="track-row"><div class="track-art"><img v-if="track.artworkUrl" :src="track.artworkUrl" :alt="`${track.title} 封面`" /><span v-else>♪</span></div><div class="track-copy"><strong>{{ track.title }}</strong><span>{{ track.artists.join('、') }} · {{ track.album }}</span></div><div class="row-actions"><button type="button" class="icon-action" @click="playTrack(track)">播放</button><button type="button" class="icon-action secondary" @click="playTrack(track, true)">加入队列</button></div></article></div>
          <div v-else class="playlist-grid"><div v-if="libraryBusy" class="empty-state"><p>读取歌单…</p></div><div v-else-if="!playlists.length" class="empty-state"><h3>还没有歌单</h3><p>歌单会在 Provider 可用后出现在这里。</p></div><button v-for="playlist in playlists" v-else :key="playlist.id" type="button" class="playlist-card" @click="loadPlaylist(playlist.id)"><span class="playlist-art" aria-hidden="true">♫</span><span><strong>{{ playlist.name }}</strong><small>{{ playlist.trackCount }} 首歌曲</small></span><b aria-hidden="true">→</b></button></div>
          <div v-if="libraryTab === 'liked' && likedPage.total > 0" class="pagination"><button type="button" class="secondary-button" :disabled="likedPage.offset === 0 || libraryBusy" @click="likedPageAt(Math.max(0, likedPage.offset - likedPage.limit))">上一页</button><span>{{ likedPage.offset + 1 }}–{{ Math.min(likedPage.offset + likedPage.items.length, likedPage.total) }} / {{ likedPage.total }}</span><button type="button" class="secondary-button" :disabled="!likedPage.hasMore || libraryBusy" @click="likedPageAt(likedPage.offset + likedPage.limit)">下一页</button></div>
        </section>

        <section v-else-if="currentView === 'playlist-detail'" class="view" aria-labelledby="playlist-heading">
          <button type="button" class="back-link" @click="navigate('library')">← 返回 Library</button>
          <div v-if="selectedPlaylist" class="view-heading"><div><p class="section-kicker">Playlist detail</p><h2 id="playlist-heading">{{ selectedPlaylist.name }}</h2><p class="lede">{{ selectedPlaylist.trackCount }} 首歌曲 · 分页读取</p></div></div>
          <div v-if="selectedPlaylist" class="result-list"><div v-if="!selectedPlaylist.tracks.items.length" class="empty-state"><h3>歌单为空</h3></div><article v-for="track in selectedPlaylist.tracks.items" v-else :key="track.id" class="track-row"><div class="track-art"><span>♪</span></div><div class="track-copy"><strong>{{ track.title }}</strong><span>{{ track.artists.join('、') }} · {{ track.album }}</span></div><div class="row-actions"><button type="button" class="icon-action" @click="playTrack(track)">播放</button><button type="button" class="icon-action secondary" @click="playTrack(track, true)">加入队列</button></div></article></div>
          <div v-if="selectedPlaylist && selectedPlaylist.tracks.total > 0" class="pagination"><button type="button" class="secondary-button" :disabled="selectedPlaylist.tracks.offset === 0 || libraryBusy" @click="playlistPageAt(Math.max(0, selectedPlaylist.tracks.offset - selectedPlaylist.tracks.limit))">上一页</button><span>{{ selectedPlaylist.tracks.offset + 1 }}–{{ Math.min(selectedPlaylist.tracks.offset + selectedPlaylist.tracks.items.length, selectedPlaylist.tracks.total) }} / {{ selectedPlaylist.tracks.total }}</span><button type="button" class="secondary-button" :disabled="!selectedPlaylist.tracks.hasMore || libraryBusy" @click="playlistPageAt(selectedPlaylist.tracks.offset + selectedPlaylist.tracks.limit)">下一页</button></div>
        </section>

        <section v-else-if="currentView === 'now-playing'" class="view now-playing-view" aria-labelledby="now-playing-heading">
          <div class="view-heading"><div><p class="section-kicker">The listening room</p><h2 id="now-playing-heading">Now Playing</h2><p class="lede">当前播放状态、实际质量和同步歌词。</p></div><span class="live-badge"><i class="status-led playing"></i>{{ playbackState?.state ?? 'idle' }}</span></div>
          <div class="now-playing-layout">
            <div class="hero-art"><img v-if="currentTrack?.artworkUrl" :src="currentTrack.artworkUrl" alt="当前曲目封面" /><span v-else aria-hidden="true">♪</span></div>
            <div class="now-playing-copy"><p class="section-kicker">Selected Zone</p><h3>{{ currentTrack?.title ?? '没有正在播放的歌曲' }}</h3><p class="artist-line">{{ currentTrack ? `${currentTrack.artists.join('、')} · ${currentTrack.album}` : '从 Search 或 Library 选择内容。' }}</p><p class="zone-line">{{ selectedZone?.displayName ?? '尚未选择 Zone' }}</p><div class="quality-grid"><div><span>请求质量</span><strong>{{ qualityLabel(playbackState?.requestedQuality) }}</strong></div><div><span>实际质量</span><strong>{{ qualityLabel(playbackState?.actualQuality) }}</strong></div><div><span>格式</span><strong>{{ playbackState?.format ?? '—' }}</strong></div><div><span>码率</span><strong>{{ playbackState?.bitrate ? `${Math.round(playbackState.bitrate / 1000)} kbps` : '—' }}</strong></div></div><div class="transport-controls"><button type="button" class="transport-button" :disabled="!playbackState?.canPrevious" @click="previousTrack">Previous</button><button type="button" class="transport-button primary" :disabled="!playbackState?.canStop" @click="stopPlayback">Stop</button><button type="button" class="transport-button" :disabled="!playbackState?.canNext" @click="nextTrack">Next</button></div></div>
          </div>
          <p v-if="playbackState?.qualityNotice" class="persistent-error">{{ playbackIssueMessage(playbackState.qualityNotice) }}<span>诊断标识：{{ playbackState.qualityNotice.diagnosticId }}</span></p>
          <div class="switch-row"><button type="button" :class="{ selected: lyricsOrQueue === 'lyrics' }" @click="lyricsOrQueue = 'lyrics'">Lyrics</button><button type="button" :class="{ selected: lyricsOrQueue === 'queue' }" @click="lyricsOrQueue = 'queue'">Queue</button></div>
          <div v-if="lyricsOrQueue === 'lyrics'" class="lyrics-panel" aria-live="polite"><div class="panel-heading"><div><p class="section-kicker">Synchronized</p><h3>同步歌词 / 歌词</h3></div><span>{{ lyricsSnapshot.status }}</span></div><p class="empty-copy">歌词只在内存中处理。</p><p v-if="!currentTrack" class="empty-copy">播放内容后，歌词会在这里出现。</p><p v-else-if="lyricsSnapshot.status === 'loading'" class="empty-copy">歌词读取中…</p><p v-else-if="lyricsSnapshot.status === 'instrumental'" class="empty-copy">纯音乐，暂无歌词。</p><p v-else-if="lyricsSnapshot.status === 'unavailable'" class="empty-copy">暂无可用歌词。</p><p v-else-if="lyricsSnapshot.status === 'error'" class="empty-copy">歌词暂时不可用。</p><div v-else class="lyrics-lines"><p v-for="(line, lineIndex) in lyricsSnapshot.lines" :key="`${line.startMs}-${lineIndex}`" :class="{ active: lyricsSnapshot.activeLineIndex === lineIndex }" class="lyrics-line"><span v-if="line.words?.length" class="lyrics-words"><span v-for="(word, wordIndex) in line.words" :key="`${word.startMs}-${wordIndex}`" :class="{ 'word-active': lyricsSnapshot.activeLineIndex === lineIndex && lyricsSnapshot.activeWordIndex === wordIndex }">{{ word.text }}</span></span><span v-else>{{ line.text }}</span><small v-if="line.translation">{{ line.translation }}</small><small v-if="line.romanization">{{ line.romanization }}</small></p></div></div>
          <div v-else class="queue-panel"><div class="panel-heading"><div><p class="section-kicker">Up next</p><h3>Queue</h3></div><span>{{ playbackState?.queue.items.length ?? 0 }} items</span></div><p v-if="!playbackState?.queue.items.length" class="empty-copy">队列为空。</p><button v-for="(item, index) in playbackState?.queue.items" v-else :key="`${item.trackId}-${index}`" type="button" class="queue-row" :class="{ active: playbackState?.queue.index === index }" @click="playQueueItem(item, index)"><span>{{ String(index + 1).padStart(2, '0') }}</span><strong>{{ item.trackId }}</strong><small>{{ qualityLabel(item.quality) }}</small></button></div>
        </section>

        <section v-else-if="currentView === 'queue'" class="view" aria-labelledby="queue-heading">
          <div class="view-heading"><div><p class="section-kicker">Playback plan</p><h2 id="queue-heading">Queue</h2><p class="lede">只保留 Previous、Next、Stop 三个明确的播放动作。</p></div><button type="button" class="secondary-button" @click="navigate('search')">添加内容</button></div>
          <div class="queue-panel large"><div class="panel-heading"><div><p class="section-kicker">Current queue</p><h3>{{ playbackState?.queue.items.length ?? 0 }} items</h3></div><span>{{ selectedZone?.displayName ?? '未选择 Zone' }}</span></div><p v-if="!playbackState?.queue.items.length" class="empty-copy">队列为空。前往 Search 选择内容。</p><button v-for="(item, index) in playbackState?.queue.items" v-else :key="`${item.trackId}-${index}`" type="button" class="queue-row" :class="{ active: playbackState?.queue.index === index }" @click="playQueueItem(item, index)"><span>{{ String(index + 1).padStart(2, '0') }}</span><strong>{{ item.trackId }}</strong><small>{{ qualityLabel(item.quality) }}</small><em v-if="playbackState?.queue.index === index">当前</em></button></div>
          <div class="transport-controls queue-controls"><button type="button" class="transport-button" :disabled="!playbackState?.canPrevious" @click="previousTrack">Previous</button><button type="button" class="transport-button primary" :disabled="!playbackState?.canStop" @click="stopPlayback">Stop</button><button type="button" class="transport-button" :disabled="!playbackState?.canNext" @click="nextTrack">Next</button></div>
        </section>

        <section v-else-if="currentView === 'settings'" class="view" aria-labelledby="settings-heading">
          <div class="view-heading"><div><p class="section-kicker">Local preferences</p><h2 id="settings-heading">Settings</h2><p class="lede">敏感 Provider 会话由主进程安全保存，Renderer 只看到公开状态。</p></div></div>
          <div class="settings-grid">
            <article class="settings-card"><div class="panel-heading"><div><p class="section-kicker">Provider</p><h3>扫码登录</h3></div><span class="state-value">{{ authState.status }}</span></div><p class="muted-copy">二维码只在本地窗口显示，登录状态由桌面主进程管理。</p><div v-if="authState.qrImage" class="qr-frame"><img :src="authState.qrImage" alt="Provider 登录二维码" /></div><p class="auth-state">当前状态：<strong>{{ authState.status }}</strong></p><div class="button-row"><button type="button" class="primary-button" :disabled="authState.status === 'creating' || acceptsPolling(authState)" @click="beginQrLogin">{{ authState.status === 'creating' ? '生成中…' : '显示二维码' }}</button><button v-if="acceptsPolling(authState)" type="button" class="secondary-button" @click="cancelQrLogin">取消</button><button v-if="authState.status === 'authorized'" type="button" class="secondary-button" @click="logout">退出登录</button></div><p v-if="authError" class="persistent-error">登录操作暂时不可用，请检查 Diagnostics。</p></article>
            <article class="settings-card"><div class="panel-heading"><div><p class="section-kicker">Playback</p><h3>播放偏好</h3></div></div><label class="field-label" for="quality-select">请求质量</label><select id="quality-select" v-model="selectedQuality"><option value="standard">Standard</option><option value="exhigh">Exhigh</option><option value="lossless">Lossless</option><option value="hires">Hi-Res</option></select><p class="muted-copy">实际质量由 Provider、Roon 和 Signal Path 共同决定。</p><label class="field-label" for="zone-select">播放 Zone</label><select id="zone-select" :value="selectedZone?.zoneId ?? ''" @change="selectZone(($event.target as HTMLSelectElement).value)"><option value="" disabled>选择 Zone</option><option v-for="zone in zones" :key="zone.zoneId" :value="zone.zoneId">{{ zone.displayName }}</option></select><p class="muted-copy">控制与流端口继续只绑定本机 loopback。</p></article>
            <article class="settings-card"><div class="panel-heading"><div><p class="section-kicker">Application</p><h3>应用信息</h3></div></div><dl class="detail-list"><div><dt>版本</dt><dd>{{ appInfo?.version ?? '读取中' }}</dd></div><div><dt>构建模式</dt><dd>{{ appInfo?.buildMode ?? '读取中' }}</dd></div><div><dt>平台</dt><dd>{{ appInfo?.platform ?? '读取中' }}</dd></div></dl></article>
          </div>
        </section>

        <section v-else class="view" aria-labelledby="diagnostics-heading">
          <div class="view-heading"><div><p class="section-kicker">Read-only signal</p><h2 id="diagnostics-heading">Diagnostics</h2><p class="lede">这里只展示公开状态、可操作建议和诊断标识，不导出 Provider 原始内容。</p></div><button type="button" class="secondary-button" @click="refreshPlayback">刷新状态</button></div>
          <p v-if="hasPlaybackIssue" class="persistent-error">{{ actionError ?? playbackState?.lastIssue?.message }}<span v-if="actionDiagnosticId ?? playbackState?.lastIssue?.diagnosticId">诊断标识：{{ actionDiagnosticId ?? playbackState?.lastIssue?.diagnosticId }}</span><button v-if="playbackState?.lastIssue?.retryable || actionError" type="button" class="inline-action" @click="retryAction">重试</button></p>
          <p v-if="diagnosticNotice" class="notice-card">{{ diagnosticNotice.code }}<span v-if="diagnosticNotice.message">{{ diagnosticNotice.message }}</span></p>
          <div class="diagnostic-grid"><article class="diagnostic-card"><span>Bridge Core</span><strong>{{ coreState?.runtime ?? 'starting' }}</strong><small>活动流 {{ coreState?.activeStreamCount ?? 0 }}</small></article><article class="diagnostic-card"><span>Roon</span><strong>{{ coreState?.roon ?? 'disconnected' }}</strong><small>{{ selectedZone?.displayName ?? '未选择 Zone' }}</small></article><article class="diagnostic-card"><span>Provider</span><strong>{{ coreState?.provider ?? 'missing' }}</strong><small>凭据状态仅显示公开枚举</small></article><article class="diagnostic-card"><span>Playback</span><strong>{{ playbackState?.state ?? 'idle' }}</strong><small>{{ coreState?.activePlaybackPresent ? '活动播放存在' : '无活动播放' }}</small></article></div>
          <div class="diagnostic-checks"><h3>安全边界</h3><ul><li>Renderer 无 Node / Electron 访问</li><li>导航与新窗口默认拒绝</li><li>控制与流端口保持 loopback-only</li><li>歌词只在内存中处理</li></ul></div>
        </section>
      </div>

      <footer class="global-player" aria-label="全局播放器">
        <div class="player-track"><div class="player-art"><img v-if="currentTrack?.artworkUrl" :src="currentTrack.artworkUrl" alt="" /><span v-else aria-hidden="true">♪</span></div><div><span class="player-label">{{ playbackState?.state === 'playing' ? '正在播放' : '待机' }}</span><strong>{{ currentTrack?.title ?? '选择内容开始播放' }}</strong><small>{{ currentTrack ? currentTrack.artists.join('、') : 'Music Bridge for Roon' }}</small></div></div>
        <div class="player-lyric"><span>LYRICS</span><strong>{{ currentLyricLine ?? '同步歌词会显示在这里' }}</strong></div>
        <div class="player-actions"><button type="button" :disabled="!playbackState?.canPrevious" aria-label="Previous" @click="previousTrack">Previous</button><button type="button" class="player-stop" :disabled="!playbackState?.canStop" aria-label="Stop" @click="stopPlayback">Stop</button><button type="button" :disabled="!playbackState?.canNext" aria-label="Next" @click="nextTrack">Next</button></div>
      </footer>
    </section>
  </main>
</template>
