<script setup lang="ts">
import { computed, ref } from 'vue'
import type { PlaybackQueueItem, PlaybackSnapshot, TrackSummary } from '@music-bridge/contracts'
import { qualityDetails, audioQualityDetails } from '../player/details.js'
import TrackArtwork from '../TrackArtwork.vue'
import { calculateVirtualWindow } from '../../composables/virtualWindow.js'
import { roonQueueContextStatus } from '../../roon-queue-context-status.js'

const props = defineProps<{
  currentTrack?: TrackSummary
  playbackState: PlaybackSnapshot | null
  qualityLabel: (quality: string | undefined) => string
}>()

const emit = defineEmits<{
  close: []
  'play-queue-item': [item: PlaybackQueueItem, index: number]
  'edit-queue-entry':[entryId:string,direction:'remove'|'up'|'down']
}>()

const queueViewport = ref<HTMLElement | null>(null)
const queueScrollTop = ref(0)
const queueViewportHeight = ref(420)
const QUEUE_VIRTUALIZATION_THRESHOLD = 200
const QUEUE_ROW_HEIGHT = 80
const contextStatus = computed(() => roonQueueContextStatus(props.playbackState?.queue.context))

const evidenceDetails = computed(() => audioQualityDetails(props.playbackState ?? {}))

const currentEntry = computed(() => {
  const state = props.playbackState
  if (!state || state.queue.index < 0 || (!state.currentTrack && !state.canStop)) return undefined
  return state.queue.items[state.queue.index]
})

const upcomingEntries = computed(() => {
  const state = props.playbackState
  if (!state) return []
  const startIndex = state.queue.index >= 0 ? state.queue.index + 1 : 0
  return state.queue.items.slice(startIndex).map((item, offset) => ({
    item,
    index: startIndex + offset,
  }))
})
const isQueueVirtualized = computed(() => upcomingEntries.value.length > QUEUE_VIRTUALIZATION_THRESHOLD)
const queueWindow = computed(() => calculateVirtualWindow(
  upcomingEntries.value.length,
  queueScrollTop.value,
  queueViewportHeight.value,
  QUEUE_ROW_HEIGHT,
))
const visibleUpcomingEntries = computed(() => isQueueVirtualized.value
  ? upcomingEntries.value.slice(queueWindow.value.start, queueWindow.value.end)
  : upcomingEntries.value)

function onQueueScroll(event: Event): void {
  const target = event.currentTarget as HTMLElement
  queueScrollTop.value = target.scrollTop
  queueViewportHeight.value = target.clientHeight || queueViewportHeight.value
}

function entryTitle(item: PlaybackQueueItem): string {
  return item.track?.title ?? (item.preflight?.reason==='UNSUPPORTED_NATIVE_RESTORE'?'原生来源需重新选择':item.edition?.title ?? '待解析本地曲目')
}

function entryArtists(item: PlaybackQueueItem): string {
  return item.track?.artists.join('、') ?? '—'
}

function entryAlbum(item: PlaybackQueueItem): string {
  return item.track?.album ?? item.edition?.title ?? '—'
}
</script>

<template>
  <aside class="playback-inspector" aria-label="播放队列检查器">
    <div class="inspector-header">
      <div><h2>播放队列</h2></div>
      <button type="button" class="inspector-close" aria-label="关闭播放检查器" @click="emit('close')">×</button>
    </div>
    <div class="queue-panel inspector-queue">
      <div class="panel-heading"><div><p class="section-kicker">接下来</p></div><span>{{ props.playbackState?.queue.context && !props.playbackState.queue.context.afterComplete ? `已加载 ${upcomingEntries.length} 首` : `${upcomingEntries.length} 首` }}</span></div>
      <p v-if="contextStatus" class="empty-copy" role="status">{{ contextStatus }}</p>
      <div v-if="!props.playbackState?.queue.items.length" class="empty-copy">队列为空，去歌曲列表添加内容。</div>
      <template v-else>
        <div v-if="currentEntry || props.currentTrack" class="queue-current">
          <TrackArtwork class="queue-current-art" :track="props.currentTrack ?? currentEntry?.track" :alt="`${props.currentTrack?.title ?? currentEntry?.track?.title ?? '当前歌曲'} 封面`" />
          <span>正在播放</span>
          <strong>{{ props.currentTrack?.title ?? (currentEntry ? entryTitle(currentEntry) : '当前歌曲') }}</strong>
          <small>{{ props.currentTrack?.artists.join('、') ?? (currentEntry ? entryArtists(currentEntry) : '—') }} · {{ props.currentTrack?.album ?? (currentEntry ? entryAlbum(currentEntry) : '—') }}</small>
          <small v-if="props.playbackState?.requestedQuality && props.playbackState.source !== 'local_file'">本次请求 {{ props.qualityLabel(props.playbackState.requestedQuality) }} · 来源返回 {{ props.qualityLabel(props.playbackState.actualQuality) }}</small>
          <small>{{ evidenceDetails.file }}</small><small>{{ evidenceDetails.output }}</small><small>{{ evidenceDetails.evidence }}</small>
        </div>
        <div v-if="!upcomingEntries.length && props.playbackState?.queue.context?.afterComplete !== false" class="empty-copy">队列已播放完</div>
        <div ref="queueViewport" class="queue-upcoming-viewport" :class="{ 'is-virtualized': isQueueVirtualized }" @scroll="onQueueScroll">
          <div v-if="isQueueVirtualized" aria-hidden="true" :style="{ height: `${queueWindow.topSpacer}px` }"></div>
          <div v-for="entry in visibleUpcomingEntries" :key="entry.item.entryId ?? `${entry.item.trackId}-${entry.index}`" role="button" tabindex="0" class="queue-row" @keydown.enter="emit('play-queue-item', entry.item, entry.index)" @click="emit('play-queue-item', entry.item, entry.index)">
            <span>{{ String(entry.index + 1).padStart(2, '0') }}</span><TrackArtwork class="queue-row-art" :track="entry.item.track" :alt="`${entryTitle(entry.item)} 封面`" />
            <span class="queue-row-copy"><strong>{{ entryTitle(entry.item) }}</strong><small>{{ entryArtists(entry.item) }} · {{ entryAlbum(entry.item) }}</small><small v-if="entry.item.track?.artworkReference">{{ qualityDetails(entry.item.track ?? {}) }}</small></span>
            <small v-if="entry.item.edition?.edition">{{ entry.item.edition.edition }}</small>
            <small v-if="entry.item.preflight?.state==='FAILED'" role="status">预检未通过，点击后明确重试</small>
            <span v-if="entry.item.entryId && !props.playbackState?.queue.context" class="queue-edit-actions" @click.stop @keydown.stop>
              <button type="button" aria-label="队列上移" @click="emit('edit-queue-entry',entry.item.entryId,'up')">↑</button>
              <button type="button" aria-label="队列下移" @click="emit('edit-queue-entry',entry.item.entryId,'down')">↓</button>
              <button type="button" aria-label="从队列移除" @click="emit('edit-queue-entry',entry.item.entryId,'remove')">×</button>
            </span>
          </div>
          <div v-if="isQueueVirtualized" aria-hidden="true" :style="{ height: `${queueWindow.bottomSpacer}px` }"></div>
        </div>
      </template>
    </div>
  </aside>
</template>
