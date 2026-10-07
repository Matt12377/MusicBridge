<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { MatchState, TrackSummary } from '@music-bridge/contracts'
import TrackArtwork from '../TrackArtwork.vue'
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
  scrollTop?: number
  rangeWindow?: { total: number; entries: readonly { index: number; track: TrackSummary }[] }
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
  scrollTop: 0,
})

const emit = defineEmits<{
  play: [track: TrackSummary]
  queue: [track: TrackSummary]
  'play-next': [track: TrackSummary]
  'load-more': []
  'update:scrollTop': [scrollTop: number]
  'visible-range': [start: number, end: number]
}>()

const contextTrack = ref<TrackSummary | null>(null)
const contextPosition = ref({ x: 0, y: 0 })
const sentinel = ref<HTMLElement | null>(null)
const virtualViewport = ref<HTMLElement | null>(null)
const virtualScrollTop = ref(0)
const virtualViewportHeight = ref(620)
const VIRTUALIZATION_THRESHOLD = 200
const TRACK_ROW_HEIGHT = 84
const rowCount = computed(() => props.rangeWindow?.total ?? props.tracks.length)
const isVirtualized = computed(() => props.rangeWindow !== undefined || props.tracks.length > VIRTUALIZATION_THRESHOLD)
const virtualWindow = computed(() => calculateVirtualWindow(
  rowCount.value,
  virtualScrollTop.value,
  virtualViewportHeight.value,
  TRACK_ROW_HEIGHT,
))
const renderedTracks = computed(() => isVirtualized.value
  ? props.tracks.slice(virtualWindow.value.start, virtualWindow.value.end)
  : props.tracks)
const renderedRows = computed(() => {
  if (!props.rangeWindow) return renderedTracks.value.map((track, index) => ({ track, index: trackIndex(index) }))
  const cached = new Map(props.rangeWindow.entries.map(entry => [entry.index, entry.track]))
  return Array.from({ length: virtualWindow.value.end - virtualWindow.value.start }, (_, offset) => {
    const index = virtualWindow.value.start + offset
    return { index, track: cached.get(index) }
  })
})
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
  emit('update:scrollTop', target.scrollTop)
}

function restoreVirtualScroll(): void {
  if (!isVirtualized.value || !virtualViewport.value) return
  const next = Math.max(0, props.scrollTop)
  virtualViewport.value.scrollTop = next
  virtualScrollTop.value = next
}

function playFromContext(): void {
  if (!contextTrack.value || props.busy) return
  emit('play', contextTrack.value)
  closeContextMenu()
}

function requestPlay(track: TrackSummary): void {
  if (props.busy) return
  emit('play', track)
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
  void nextTick(() => {
    restoreVirtualScroll()
    observeSentinel()
  })
})
watch(() => props.tracks.length, () => {
  if (!isVirtualized.value) virtualScrollTop.value = 0
  void nextTick(observeSentinel)
})
watch(() => [props.hasMore, props.loadMoreError, props.tracks.length, props.loadingMore], () => {
  void nextTick(observeSentinel)
})
watch(() => props.scrollTop, () => void nextTick(restoreVirtualScroll))
watch(() => [rowCount.value, isVirtualized.value], () => void nextTick(restoreVirtualScroll))
watch(() => [virtualWindow.value.start, virtualWindow.value.end, props.rangeWindow?.total], () => {
  if (props.rangeWindow) emit('visible-range', virtualWindow.value.start, virtualWindow.value.end)
}, { immediate: true })
onUnmounted(() => {
  document.removeEventListener('click', closeContextMenu)
  observer?.disconnect()
})
</script>

<template>
  <div class="track-table-wrap">
    <div v-if="isInitialLoading()" class="empty-state track-table-state"><span class="loading-line"></span><p>正在读取歌曲…</p></div>
    <div v-else-if="!rowCount" class="empty-state track-table-state">
      <span class="empty-glyph" aria-hidden="true">{{ props.emptyGlyph }}</span>
      <h3>{{ props.emptyTitle }}</h3>
      <p>{{ props.emptyCopy }}</p>
    </div>
    <div v-else ref="virtualViewport" class="track-table" :class="{ 'is-virtualized': isVirtualized, 'is-range-window': !!props.rangeWindow, 'track-table-no-artwork': !props.showArtwork, 'has-row-leading': !!$slots['row-leading'] }" role="table" aria-label="歌曲列表" :aria-colcount="$slots['row-leading'] ? 4 : 3" :aria-rowcount="props.rangeWindow ? rowCount + 1 : undefined" @scroll="onVirtualScroll">
      <div class="track-table-header" role="row">
        <span v-if="$slots['row-leading']" role="columnheader">选择</span>
        <span role="columnheader">歌曲</span><span role="columnheader">时长</span><span role="columnheader">操作</span>
      </div>
      <div v-if="isVirtualized" aria-hidden="true" :style="{ height: `${virtualWindow.topSpacer}px` }"></div>
      <template v-for="entry in renderedRows" :key="entry.track?.id ?? `loading-${entry.index}`">
      <div v-if="entry.track" :key="entry.track.id"
        class="track-row"
        role="row"
        :aria-rowindex="props.rangeWindow ? entry.index + 2 : undefined"
        :tabindex="props.busy ? -1 : 0"
        :aria-disabled="props.busy ? 'true' : undefined"
        @dblclick="requestPlay(entry.track)"
        @keydown.enter.self.prevent="requestPlay(entry.track)"
        @contextmenu="showContextMenu($event, entry.track)"
      >
        <span v-if="$slots['row-leading']" class="track-leading" role="cell"><slot name="row-leading" :track="entry.track" /></span>
        <span v-else class="track-index" aria-hidden="true"><span class="track-number">{{ entry.index + 1 }}</span><span class="track-play-mark">▶</span></span>
        <TrackArtwork v-if="props.showArtwork" class="track-art" :track="entry.track" alt="" aria-hidden="true" />
        <span class="track-copy" role="cell"><strong>{{ entry.track.title }}</strong><small>{{ entry.track.artists.join('、') }}<span v-if="entry.track.album" class="track-inline-album"> · {{ entry.track.album }}</span></small><span v-if="entry.track.version || props.matchStates?.[entry.track.id] === 'CONFIRMED' || props.matchStates?.[entry.track.id] === 'POSSIBLE'" class="track-quality-details"><span v-if="entry.track.version">{{ entry.track.version }}</span><span v-if="props.matchStates?.[entry.track.id] === 'CONFIRMED'" class="track-source-badge">Roon 已匹配</span><span v-else-if="props.matchStates?.[entry.track.id] === 'POSSIBLE'" class="track-source-badge is-muted" title="存在多个候选，保持 Provider 播放">Smart 匹配不唯一</span></span></span>
        <span class="track-album" aria-hidden="true">{{ entry.track.album }}</span>
        <span class="track-duration" role="cell">{{ formatDuration(entry.track.durationMs) }}</span>
        <span class="row-actions" role="cell">
          <button type="button" class="row-action" :disabled="props.busy" :aria-label="`播放 ${entry.track.title}`" @click.stop="requestPlay(entry.track)">▶</button>
          <button type="button" class="row-action row-action-more" :aria-label="`打开 ${entry.track.title} 的更多操作`" @click.stop="showContextMenu($event, entry.track)">•••</button>
          <slot name="row-detail" :track="entry.track" />
        </span>
      </div>
      <div v-else class="track-row track-row-placeholder" role="row" :aria-rowindex="entry.index + 2" aria-disabled="true"><span v-if="$slots['row-leading']" class="track-leading" role="cell" aria-label="选择暂不可用"></span><span v-else class="track-index" aria-hidden="true">{{ entry.index + 1 }}</span><span class="track-copy" role="cell">正在读取这一页…</span><span class="placeholder-cell" role="cell">时长暂未读取</span><span class="placeholder-cell" role="cell">操作暂不可用</span></div>
      </template>
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
      <button type="button" role="menuitem" :disabled="props.busy" @click="playFromContext">播放</button>
      <button type="button" role="menuitem" @click="playNextFromContext">下一首播放</button>
      <button type="button" role="menuitem" @click="queueFromContext">加入队列</button>
    </div>
  </div>
</template>

<style scoped>
.track-table .track-table-header, .track-table .placeholder-cell { display: flex !important; position: absolute; width: 1px; height: 1px; min-height: 0; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
.track-table.is-range-window .track-row { height: 84px; min-height: 84px; grid-template-columns: 24px 64px minmax(0, 1fr) 60px 142px; }
.track-table.is-range-window.track-table-no-artwork .track-row { grid-template-columns: 24px minmax(0, 1fr) 60px 142px; }
.track-table.is-range-window.has-row-leading .track-row { grid-template-columns: 44px 64px minmax(0, 1fr) 60px 142px; }
.track-table.is-range-window.has-row-leading.track-table-no-artwork .track-row { grid-template-columns: 44px minmax(0, 1fr) 60px 142px; }
.track-leading { display:flex; align-items:center; justify-content:center; min-width:44px; min-height:44px; }
.track-table.is-range-window .row-actions { width: 142px; opacity: 1; display: flex; gap: 5px; grid-column: auto; }
.track-table.is-range-window .row-actions button { display: inline-flex; flex: 0 0 44px; width: 44px; min-width: 44px; min-height: 44px; padding-inline: 0; align-items: center; justify-content: center; }
.track-table.is-range-window .track-row-placeholder .track-copy { grid-column: 3; color: var(--mb-text-secondary); }
.track-table.is-range-window.track-table-no-artwork .track-row-placeholder .track-copy { grid-column: 2; }
.track-table.is-range-window button:focus-visible, .track-table.is-range-window .track-row:focus-visible { outline: 2px solid var(--mb-accent); outline-offset: -2px; }
@media (max-width: 800px) {
  .track-table.is-range-window .track-row, .track-table.is-range-window.track-table-no-artwork .track-row { grid-template-columns: minmax(0, 1fr) 142px; gap: 8px; }
  .track-table.is-range-window .track-row .track-index, .track-table.is-range-window .track-row .track-art { display: none; }
  .track-table.is-range-window .track-row .track-duration { display: block; position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .track-table.is-range-window .track-row-placeholder .track-copy, .track-table.is-range-window.track-table-no-artwork .track-row-placeholder .track-copy { grid-column: 1; }
  .track-table.is-range-window.has-row-leading .track-row, .track-table.is-range-window.has-row-leading.track-table-no-artwork .track-row { grid-template-columns:44px minmax(0, 1fr) 142px; }
  .track-table.is-range-window.has-row-leading .track-row-placeholder .track-copy { grid-column:2; }
}
</style>
