<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'

import type {
  Page,
  PageRequest,
  PlaylistDetail,
  PlaylistSummary,
  PublicAuthState,
  PublicBridgeState,
  TrackSummary,
} from '@music-bridge/contracts'
import type { AppInfo } from '../../preload/api.js'

const LIBRARY_PAGE_SIZE = 20
const SEARCH_DEBOUNCE_MS = 350

function emptyPage<T>(limit = LIBRARY_PAGE_SIZE): Page<T> {
  return { items: [], offset: 0, limit, total: 0, hasMore: false }
}

const appInfo = ref<AppInfo | null>(null)
const coreState = ref<PublicBridgeState | null>(null)
const authState = ref<PublicAuthState>({ status: 'idle' })
const coreError = ref(false)
const authError = ref(false)
let removeCoreListener: (() => void) | undefined
let pollTimer: ReturnType<typeof setInterval> | undefined
let authOperation = 0
let pollInFlight = false
const libraryTab = ref<'search' | 'liked' | 'playlists'>('search')
const searchQuery = ref('')
const searchPage = ref<Page<TrackSummary>>(emptyPage())
const likedPage = ref<Page<TrackSummary>>(emptyPage())
const playlists = ref<readonly PlaylistSummary[]>([])
const selectedPlaylist = ref<PlaylistDetail | null>(null)
const libraryBusy = ref(false)
const libraryError = ref<'auth-expired' | 'generic' | null>(null)
let searchTimer: ReturnType<typeof setTimeout> | undefined
let libraryOperation = 0

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
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'AUTH_EXPIRED'
  )
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
    libraryBusy.value = false
  } catch (error) {
    applyLibraryError(error, operation)
  }
}

function selectLibraryTab(tab: 'search' | 'liked' | 'playlists'): void {
  stopSearchTimer()
  libraryTab.value = tab
  if (tab === 'liked') void loadLiked()
  if (tab === 'playlists') void loadPlaylists()
  if (tab === 'search') beginLibraryOperation()
}

function searchPageAt(offset: number): void {
  const query = searchQuery.value.trim()
  if (query.length === 0) return
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
    const state = await window.musicBridge.pollQrLogin(challengeId)
    applyAuthState(state, operation)
  } catch {
    if (operation === authOperation) authError.value = true
    stopPolling()
  } finally {
    pollInFlight = false
  }
}

function startPolling(): void {
  stopPolling()
  const operation = authOperation
  pollTimer = setInterval(() => {
    void pollQr(operation)
  }, 2_000)
  void pollQr(operation)
}

async function beginQrLogin(): Promise<void> {
  authOperation += 1
  authError.value = false
  stopPolling()
  try {
    const state = await window.musicBridge.beginQrLogin()
    applyAuthState(state)
    if (acceptsPolling(state)) startPolling()
  } catch {
    authError.value = true
  }
}

async function cancelQrLogin(): Promise<void> {
  const challengeId = authState.value.challengeId
  if (!challengeId) return
  authOperation += 1
  stopPolling()
  try {
    applyAuthState(await window.musicBridge.cancelQrLogin(challengeId))
  } catch {
    authError.value = true
  }
}

async function logout(): Promise<void> {
  authOperation += 1
  authError.value = false
  stopPolling()
  try {
    applyAuthState(await window.musicBridge.logout())
  } catch {
    authError.value = true
  }
}

onMounted(async () => {
  removeCoreListener = window.musicBridge.onCoreEvent((event) => {
    if (event.event === 'core.ready' || event.event === 'core.health' || event.event === 'roon.changed') {
      coreState.value = event.payload.state
    }
    if (event.event === 'auth.changed') {
      applyAuthState(event.payload.state)
    }
  })
  try {
    appInfo.value = await window.musicBridge.getAppInfo()
    coreState.value = await window.musicBridge.getCoreHealth()
    applyAuthState(await window.musicBridge.getAuthState())
  } catch {
    coreError.value = true
  }
})

onUnmounted(() => {
  removeCoreListener?.()
  stopPolling()
  stopSearchTimer()
})
</script>

<template>
  <main class="shell">
    <header class="hero">
      <p class="eyebrow">安全桌面空壳</p>
      <h1>Music Bridge for Roon</h1>
      <p class="description">本地桌面控制面板，当前提供 Provider 登录与音乐库分页读取。</p>
    </header>

    <section class="info-card" aria-label="应用信息">
      <h2>应用信息</h2>
      <dl>
        <div><dt>App 版本</dt><dd>{{ appInfo?.version ?? '读取中' }}</dd></div>
        <div><dt>构建模式</dt><dd>{{ appInfo?.buildMode ?? '读取中' }}</dd></div>
        <div><dt>平台</dt><dd>{{ appInfo?.platform ?? '读取中' }}</dd></div>
      </dl>
    </section>

    <section class="auth-card" aria-label="Provider 登录">
      <div class="auth-copy">
        <p class="eyebrow">Provider</p>
        <h2>扫码登录</h2>
        <p>二维码只在本地窗口显示，登录状态由桌面主进程安全保存。</p>
      </div>
      <div v-if="authState.qrImage" class="qr-frame">
        <img :src="authState.qrImage" alt="Provider 登录二维码" />
      </div>
      <p class="auth-status">当前状态：{{ authState.status }}</p>
      <div class="auth-actions">
        <button
          type="button"
          :disabled="authState.status === 'creating' || acceptsPolling(authState)"
          @click="beginQrLogin"
        >
          {{ authState.status === 'creating' ? '生成中…' : '显示二维码' }}
        </button>
        <button
          v-if="acceptsPolling(authState)"
          type="button"
          class="secondary"
          @click="cancelQrLogin"
        >
          取消
        </button>
        <button
          v-if="authState.status === 'authorized'"
          type="button"
          class="secondary"
          @click="logout"
        >
          退出登录
        </button>
      </div>
      <p v-if="authState.status === 'expired'" class="auth-hint">二维码已过期，请重新生成。</p>
      <p v-if="authError" class="auth-hint">登录操作暂时不可用，请稍后重试。</p>
    </section>

    <section class="library-card" aria-label="音乐库">
      <div class="library-header">
        <div>
          <p class="eyebrow">Library</p>
          <h2>音乐库临时列表</h2>
          <p class="description">搜索、我喜欢和歌单通过 Core 分页读取；Renderer 不接收 Provider 原始响应。</p>
        </div>
        <span v-if="libraryBusy" class="library-busy">读取中…</span>
      </div>

      <div class="library-tabs" role="tablist" aria-label="音乐库分类">
        <button
          type="button"
          :class="{ selected: libraryTab === 'search' }"
          @click="selectLibraryTab('search')"
        >
          搜索
        </button>
        <button
          type="button"
          :class="{ selected: libraryTab === 'liked' }"
          @click="selectLibraryTab('liked')"
        >
          我喜欢
        </button>
        <button
          type="button"
          :class="{ selected: libraryTab === 'playlists' }"
          @click="selectLibraryTab('playlists')"
        >
          我的歌单
        </button>
      </div>

      <p v-if="libraryError === 'auth-expired'" class="library-hint">登录已过期，请重新扫码登录。</p>
      <p v-else-if="libraryError === 'generic'" class="library-hint">音乐库暂时不可用，请稍后重试。</p>
      <p v-else-if="coreState?.provider !== 'configured'" class="library-hint">请先完成 Provider 登录，再读取音乐库。</p>

      <div v-if="libraryTab === 'search'" class="library-panel">
        <div class="library-search-bar">
          <input
            v-model="searchQuery"
            type="search"
            maxlength="100"
            placeholder="搜索歌曲"
            aria-label="搜索歌曲"
            @input="scheduleSearch"
            @keyup.enter="scheduleSearch"
          />
          <button type="button" @click="scheduleSearch">搜索</button>
        </div>
        <p v-if="searchQuery.trim() && searchPage.items.length === 0 && !libraryBusy" class="library-empty">暂无搜索结果。</p>
        <ul v-else class="library-list" aria-label="搜索结果">
          <li v-for="track in searchPage.items" :key="track.id" class="library-item">
            <img
              v-if="track.artworkUrl"
              :src="track.artworkUrl"
              :alt="`${track.title} 封面`"
              loading="lazy"
              referrerpolicy="no-referrer"
            />
            <div>
              <strong>{{ track.title }}</strong>
              <span>{{ track.artists.join('、') }} · {{ track.album }}</span>
            </div>
          </li>
        </ul>
        <div v-if="searchPage.total > 0" class="library-pagination">
          <button
            type="button"
            class="secondary"
            :disabled="searchPage.offset === 0 || libraryBusy"
            @click="searchPageAt(Math.max(0, searchPage.offset - searchPage.limit))"
          >
            上一页
          </button>
          <span>{{ searchPage.offset + 1 }}–{{ Math.min(searchPage.offset + searchPage.items.length, searchPage.total) }} / {{ searchPage.total }}</span>
          <button
            type="button"
            class="secondary"
            :disabled="!searchPage.hasMore || libraryBusy"
            @click="searchPageAt(searchPage.offset + searchPage.limit)"
          >
            下一页
          </button>
        </div>
      </div>

      <div v-else-if="libraryTab === 'liked'" class="library-panel">
        <p v-if="likedPage.items.length === 0 && !libraryBusy" class="library-empty">暂无我喜欢的歌曲。</p>
        <ul v-else class="library-list" aria-label="我喜欢的歌曲">
          <li v-for="track in likedPage.items" :key="track.id" class="library-item">
            <img
              v-if="track.artworkUrl"
              :src="track.artworkUrl"
              :alt="`${track.title} 封面`"
              loading="lazy"
              referrerpolicy="no-referrer"
            />
            <div>
              <strong>{{ track.title }}</strong>
              <span>{{ track.artists.join('、') }} · {{ track.album }}</span>
            </div>
          </li>
        </ul>
        <div v-if="likedPage.total > 0" class="library-pagination">
          <button
            type="button"
            class="secondary"
            :disabled="likedPage.offset === 0 || libraryBusy"
            @click="likedPageAt(Math.max(0, likedPage.offset - likedPage.limit))"
          >
            上一页
          </button>
          <span>{{ likedPage.offset + 1 }}–{{ Math.min(likedPage.offset + likedPage.items.length, likedPage.total) }} / {{ likedPage.total }}</span>
          <button
            type="button"
            class="secondary"
            :disabled="!likedPage.hasMore || libraryBusy"
            @click="likedPageAt(likedPage.offset + likedPage.limit)"
          >
            下一页
          </button>
        </div>
      </div>

      <div v-else class="library-panel">
        <div v-if="selectedPlaylist" class="playlist-detail-header">
          <button type="button" class="secondary" @click="selectedPlaylist = null">返回歌单列表</button>
          <div>
            <strong>{{ selectedPlaylist.name }}</strong>
            <span>{{ selectedPlaylist.trackCount }} 首歌曲</span>
          </div>
        </div>
        <ul v-if="!selectedPlaylist" class="playlist-list" aria-label="我的歌单">
          <li v-for="playlist in playlists" :key="playlist.id">
            <button type="button" class="playlist-button" @click="loadPlaylist(playlist.id)">
              <img
                v-if="playlist.artworkUrl"
                :src="playlist.artworkUrl"
                :alt="`${playlist.name} 封面`"
                loading="lazy"
                referrerpolicy="no-referrer"
              />
              <span><strong>{{ playlist.name }}</strong><small>{{ playlist.trackCount }} 首歌曲</small></span>
            </button>
          </li>
        </ul>
        <p v-if="!selectedPlaylist && playlists.length === 0 && !libraryBusy" class="library-empty">暂无歌单。</p>
        <ul v-if="selectedPlaylist" class="library-list" aria-label="歌单歌曲">
          <li v-for="track in selectedPlaylist.tracks.items" :key="track.id" class="library-item">
            <img
              v-if="track.artworkUrl"
              :src="track.artworkUrl"
              :alt="`${track.title} 封面`"
              loading="lazy"
              referrerpolicy="no-referrer"
            />
            <div>
              <strong>{{ track.title }}</strong>
              <span>{{ track.artists.join('、') }} · {{ track.album }}</span>
            </div>
          </li>
        </ul>
        <div v-if="selectedPlaylist && selectedPlaylist.tracks.total > 0" class="library-pagination">
          <button
            type="button"
            class="secondary"
            :disabled="selectedPlaylist.tracks.offset === 0 || libraryBusy"
            @click="playlistPageAt(Math.max(0, selectedPlaylist.tracks.offset - selectedPlaylist.tracks.limit))"
          >
            上一页
          </button>
          <span>{{ selectedPlaylist.tracks.offset + 1 }}–{{ Math.min(selectedPlaylist.tracks.offset + selectedPlaylist.tracks.items.length, selectedPlaylist.tracks.total) }} / {{ selectedPlaylist.tracks.total }}</span>
          <button
            type="button"
            class="secondary"
            :disabled="!selectedPlaylist.tracks.hasMore || libraryBusy"
            @click="playlistPageAt(selectedPlaylist.tracks.offset + selectedPlaylist.tracks.limit)"
          >
            下一页
          </button>
        </div>
      </div>
    </section>

    <section class="status-grid" aria-label="运行状态占位">
      <article class="status-card">
        <span class="status-dot" aria-hidden="true"></span>
        <h2>Roon 状态</h2>
        <p>{{ coreState?.roon ?? '读取中' }}</p>
      </article>
      <article class="status-card">
        <span class="status-dot" aria-hidden="true"></span>
        <h2>网易云状态</h2>
        <p>{{ coreState?.provider ?? (coreError ? '不可用' : '读取中') }}</p>
      </article>
      <article class="status-card">
        <span class="status-dot" aria-hidden="true"></span>
        <h2>Bridge Core 状态</h2>
        <p>{{ coreState?.runtime ?? (coreError ? '不可用' : '读取中') }}</p>
        <small v-if="coreState">活动流：{{ coreState.activeStreamCount }}</small>
      </article>
    </section>
  </main>
</template>
