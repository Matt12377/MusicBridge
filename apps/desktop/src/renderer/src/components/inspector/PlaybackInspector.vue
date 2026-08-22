<script setup lang="ts">
import type { LyricsSnapshot, PlaybackQueueItem, PlaybackSnapshot, TrackSummary } from '@music-bridge/contracts'
import LyricsPanel from '../LyricsPanel.vue'

const props = defineProps<{
  mode: 'lyrics' | 'queue'
  currentTrack?: TrackSummary
  playbackState: PlaybackSnapshot | null
  lyricsSnapshot: LyricsSnapshot
  qualityLabel: (quality: string | undefined) => string
}>()

const emit = defineEmits<{
  close: []
  'update:mode': [mode: 'lyrics' | 'queue']
  'play-queue-item': [item: PlaybackQueueItem, index: number]
}>()
</script>

<template>
  <aside class="playback-inspector" aria-label="播放检查器">
    <div class="inspector-header">
      <div><p class="section-kicker">Inspector</p><h2>{{ props.mode === 'lyrics' ? '歌词' : '队列' }}</h2></div>
      <button type="button" class="inspector-close" aria-label="关闭播放检查器" @click="emit('close')">×</button>
    </div>
    <div class="inspector-tabs" role="tablist" aria-label="播放检查器视图">
      <button type="button" role="tab" :aria-selected="props.mode === 'lyrics'" :class="{ selected: props.mode === 'lyrics' }" @click="emit('update:mode', 'lyrics')">歌词</button>
      <button type="button" role="tab" :aria-selected="props.mode === 'queue'" :class="{ selected: props.mode === 'queue' }" @click="emit('update:mode', 'queue')">队列</button>
    </div>
    <LyricsPanel v-if="props.mode === 'lyrics'" :current-track="props.currentTrack" :snapshot="props.lyricsSnapshot" />
    <div v-else class="queue-panel inspector-queue">
      <div class="panel-heading"><div><p class="section-kicker">接下来</p><h3>播放队列</h3></div><span>{{ props.playbackState?.queue.items.length ?? 0 }} 首</span></div>
      <div v-if="!props.playbackState?.queue.items.length" class="empty-copy">队列为空，去歌曲列表添加内容。</div>
      <template v-else>
        <div class="queue-current"><span>正在播放</span><strong>{{ props.currentTrack?.title ?? '当前歌曲' }}</strong></div>
        <button v-for="(item, index) in props.playbackState.queue.items" :key="`${item.trackId}-${index}`" type="button" class="queue-row" :class="{ active: props.playbackState.queue.index === index }" @click="emit('play-queue-item', item, index)">
          <span>{{ String(index + 1).padStart(2, '0') }}</span>
          <strong>{{ props.playbackState.queue.index === index ? (props.currentTrack?.title ?? '当前歌曲') : `队列歌曲 ${index + 1}` }}</strong>
          <small>{{ props.qualityLabel(item.quality) }}</small>
        </button>
      </template>
    </div>
  </aside>
</template>
