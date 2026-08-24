<script setup lang="ts">
import { computed } from 'vue'
import type { PlaybackQueueItem, PlaybackSnapshot, TrackSummary } from '@music-bridge/contracts'
import SafeArtwork from '../SafeArtwork.vue'

const props = defineProps<{
  currentTrack?: TrackSummary
  playbackState: PlaybackSnapshot | null
  qualityLabel: (quality: string | undefined) => string
}>()

const emit = defineEmits<{
  close: []
  'play-queue-item': [item: PlaybackQueueItem, index: number]
}>()

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

function entryTitle(item: PlaybackQueueItem): string {
  return item.track?.title ?? '正在读取歌曲信息'
}

function entryArtists(item: PlaybackQueueItem): string {
  return item.track?.artists.join('、') ?? '—'
}

function entryAlbum(item: PlaybackQueueItem): string {
  return item.track?.album ?? '—'
}
</script>

<template>
  <aside class="playback-inspector" aria-label="播放队列检查器">
    <div class="inspector-header">
      <div><h2>播放队列</h2></div>
      <button type="button" class="inspector-close" aria-label="关闭播放检查器" @click="emit('close')">×</button>
    </div>
    <div class="queue-panel inspector-queue">
      <div class="panel-heading"><div><p class="section-kicker">接下来</p></div><span>{{ upcomingEntries.length }} 首</span></div>
      <div v-if="!props.playbackState?.queue.items.length" class="empty-copy">队列为空，去歌曲列表添加内容。</div>
      <template v-else>
        <div v-if="currentEntry || props.currentTrack" class="queue-current">
          <SafeArtwork class="queue-current-art" :src="props.currentTrack?.artworkUrl ?? currentEntry?.track?.artworkUrl" :alt="`${props.currentTrack?.title ?? currentEntry?.track?.title ?? '当前歌曲'} 封面`" />
          <span>正在播放</span>
          <strong>{{ props.currentTrack?.title ?? (currentEntry ? entryTitle(currentEntry) : '当前歌曲') }}</strong>
          <small>{{ props.currentTrack?.artists.join('、') ?? (currentEntry ? entryArtists(currentEntry) : '—') }} · {{ props.currentTrack?.album ?? (currentEntry ? entryAlbum(currentEntry) : '—') }}</small>
          <small v-if="props.playbackState?.requestedQuality">本次请求 {{ props.qualityLabel(props.playbackState.requestedQuality) }} · Provider 返回 {{ props.qualityLabel(props.playbackState.actualQuality) }}</small>
        </div>
        <div v-if="!upcomingEntries.length" class="empty-copy">队列已播放完</div>
        <button v-for="entry in upcomingEntries" :key="`${entry.item.trackId}-${entry.index}`" type="button" class="queue-row" @click="emit('play-queue-item', entry.item, entry.index)">
          <span>{{ String(entry.index + 1).padStart(2, '0') }}</span><SafeArtwork class="queue-row-art" :src="entry.item.track?.artworkUrl" :alt="`${entryTitle(entry.item)} 封面`" />
          <span class="queue-row-copy"><strong>{{ entryTitle(entry.item) }}</strong><small>{{ entryArtists(entry.item) }} · {{ entryAlbum(entry.item) }}</small></span>
          <small>{{ props.qualityLabel(entry.item.qualityPreference) }}</small>
        </button>
      </template>
    </div>
  </aside>
</template>
