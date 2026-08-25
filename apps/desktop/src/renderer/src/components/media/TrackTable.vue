<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { MatchState, TrackSummary } from '@music-bridge/contracts'
import SafeArtwork from '../SafeArtwork.vue'
import { calculateVirtualWindow } from '../../composables/virtualWindow.js'

const props = withDefaults(defineProps<{
  tracks: readonly TrackSummary[]
  showArtwork?: boolean
  busy?: boolean
  initialLoading?: boolean
  loadingMore?: boolean
  loadMoreError?: string | null
  total?: number
  hasMore?: boolean
  emptyTitle?: string
  emptyCopy?: string
  emptyGlyph?: string
  matchStates?: Readonly<Record<string, MatchState>>
}>(), {
  showArtwork: true,
  busy: false,
  initialLoading: false,
  loadingMore: false,
  loadMoreError: null,
  total: 0,
  hasMore: false,
  emptyTitle: '没有歌曲',
  emptyCopy: '歌曲会在内容可用后显示在这里。',
  emptyGlyph: '♫',
  matchStates: undefined,
})

const emit = defineEmits<{
  play: [track: TrackSummary]
  queue: [track: TrackSummary]
  'play-next': [track: TrackSummary]
  'load-more': []
}>()

const contextTrack = ref<TrackSummary | null>(null)
const contextPosition = ref({ x: 0, y: 0 })
const sentinel = ref<HTMLElement | null>(null)
const virtualViewport = ref<HTMLElement | null>(null)
const virtualScrollTop = ref(0)
const virtualViewportHeight = ref(620)
const VIRTUALIZATION_THRESHOLD = 200
const TRACK_ROW_HEIGHT = 58
const isVirtualized = computed(() => props.tracks.length > VIRTUALIZATION_THRESHOLD)
const virtualWindow = computed(() => calculateVirtualWindow(
  props.tracks.length,
  virtualScrollTop.value,
  virtualViewportHeight.value,
  TRACK_ROW_HEIGHT,
))
const renderedTracks = computed(() => isVirtualized.value
  ? props.tracks.slice(virtualWindow.value.start, virtualWindow.value.end)
  : props.tracks)
let observer: IntersectionObserver | undefined

const isInitialLoading = () => (props.initialLoading || props.busy) && props.tracks.length === 0

function formatDuration(durationMs: number | undefined): string {
  if (!durationMs || durationMs < 0) return '—'
  const seconds = Math.floor(durationMs / 1_000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function showContextMenu(event: MouseEvent, track: TrackSummary): void {
  event.preventDefault()
  contextTrack.value = track
  contextPosition.value = {
    x: Math.min(event.clientX, window.innerWidth - 190),
    y: Math.min(event.clientY, Math.max(12, window.innerHeight - 230)),
  }
}

function closeContextMenu(): void {
  contextTrack.value = null
}

function trackIndex(renderedIndex: number): number {
  return isVirtualized.value ? virtualWindow.value.start + renderedIndex : renderedIndex
}

function onVirtualScroll(event: Event): void {
  const target = event.currentTarget as HTMLElement
  virtualScrollTop.value = target.scrollTop
  virtualViewportHeight.value = target.clientHeight || virtualViewportHeight.value
}

function playFromContext(): void {
  if (!contextTrack.value) return
  emit('play', contextTrack.value)
  closeContextMenu()
}

function queueFromContext(): void {
  if (!contextTrack.value) return
  emit('queue', contextTrack.value)
  closeContextMenu()
}

function playNextFromContext(): void {
  if (!contextTrack.value) return
  emit('play-next', contextTrack.value)
  closeContextMenu()
}

function observeSentinel(): void {
  observer?.disconnect()
  observer = undefined
  if (!props.hasMore || props.loadMoreError || typeof IntersectionObserver === 'undefined' || !sentinel.value) return
  observer = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting) && !props.loadingMore && !props.busy) {
      emit('load-more')
    }
  }, { rootMargin: '240px 0px' })
  observer.observe(sentinel.value)
}

onMounted(() => {
  document.addEventListener('click', closeContextMenu)
  void nextTick(observeSentinel)
})
watch(() => props.tracks.length, () => {
  if (!isVirtualized.value) virtualScrollTop.value = 0
  void nextTick(observeSentinel)
})
watch(() => [props.hasMore, props.loadMoreError, props.tracks.length, props.loadingMore], () => {
  void nextTick(observeSentinel)
})
onUnmounted(() => {
  document.removeEventListener('click', closeContextMenu)
  observer?.disconnect()
})
</script>

<template>
  <div class="track-table-wrap">
    <div v-if="isInitialLoading()" class="empty-state track-table-state"><span class="loading-line"></span><p>正在读取歌曲…</p></div>
    <div v-else-if="!props.tracks.length" class="empty-state track-table-state">
      <span class="empty-glyph" aria-hidden="true">{{ props.emptyGlyph }}</span>
      <h3>{{ props.emptyTitle }}</h3>
      <p>{{ props.emptyCopy }}</p>
    </div>
    <div v-else ref="virtualViewport" class="track-table" :class="{ 'is-virtualized': isVirtualized, 'track-table-no-artwork': !props.showArtwork }" role="table" aria-label="歌曲列表" @scroll="onVirtualScroll">
      <div class="track-table-header" role="row">
        <span>#</span><span>歌曲</span><span>专辑</span><span>时长</span><span class="visually-hidden">操作</span>
      </div>
      <div v-if="isVirtualized" aria-hidden="true" :style="{ height: `${virtualWindow.topSpacer}px` }"></div>
      <div
        v-for="(track, index) in renderedTracks"
        :key="track.id"
        class="track-row"
        role="row"
        tabindex="0"
        @dblclick="emit('play', track)"
        @keydown.enter="emit('play', track)"
        @contextmenu="showContextMenu($event, track)"
      >
        <span class="track-index" aria-hidden="true"><span class="track-number">{{ trackIndex(index) + 1 }}</span><span class="track-play-mark">▶</span></span>
        <SafeArtwork v-if="props.showArtwork" class="track-art" :src="track.artworkUrl" :alt="`${track.title} 封面`" />
        <span class="track-copy"><strong>{{ track.title }}</strong><small>{{ track.artists.join('、') }}</small><span v-if="props.matchStates?.[track.id] === 'CONFIRMED'" class="track-source-badge">Roon 已匹配</span><span v-else-if="props.matchStates?.[track.id] === 'POSSIBLE'" class="track-source-badge is-muted">可能有本地版本</span></span>
        <span class="track-album">{{ track.album }}</span>
        <span class="track-duration">{{ formatDuration(track.durationMs) }}</span>
        <span class="row-actions">
          <button type="button" class="row-action" :aria-label="`播放 ${track.title}`" @click.stop="emit('play', track)">▶</button>
          <button type="button" class="row-action row-action-more" :aria-label="`打开 ${track.title} 的更多操作`" @click.stop="showContextMenu($event, track)">•••</button>
        </span>
      </div>
      <div v-if="isVirtualized" aria-hidden="true" :style="{ height: `${virtualWindow.bottomSpacer}px` }"></div>
    </div>

    <div v-if="props.hasMore" ref="sentinel" class="track-table-more">
      <span v-if="props.loadingMore" class="loading-more-label" role="status" aria-live="polite">正在加载更多…</span>
      <template v-else-if="props.loadMoreError">
        <span class="load-more-error" role="status">{{ props.loadMoreError }}</span>
        <button type="button" class="text-button" @click="emit('load-more')">重试</button>
      </template>
      <button v-else type="button" class="text-button" :disabled="props.busy" @click="emit('load-more')">加载更多歌曲</button>
      <span v-if="props.total">已显示 {{ props.tracks.length }} / {{ props.total }}</span>
    </div>

    <div
      v-if="contextTrack"
      class="track-context-menu"
      role="menu"
      aria-label="歌曲操作"
      :style="{ left: `${contextPosition.x}px`, top: `${contextPosition.y}px` }"
      @click.stop
    >
      <strong>{{ contextTrack.title }}</strong>
      <button type="button" role="menuitem" @click="playFromContext">播放</button>
      <button type="button" role="menuitem" @click="playNextFromContext">下一首播放</button>
      <button type="button" role="menuitem" @click="queueFromContext">加入队列</button>
    </div>
  </div>
</template>
