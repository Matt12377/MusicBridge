<script setup lang="ts">
import { computed } from 'vue'
import type { PlaybackSnapshot, TrackSummary } from '@music-bridge/contracts'

const props = defineProps<{
  currentTrack?: TrackSummary
  playbackState: PlaybackSnapshot | null
  currentLyricLine?: string
}>()

const emit = defineEmits<{
  previous: []
  stop: []
  next: []
  'open-now-playing': []
  'open-lyrics': []
  'open-queue': []
}>()

const activityWidth = computed(() => (props.playbackState?.state === 'playing' ? '38%' : '0%'))
</script>

<template>
  <footer class="global-player" aria-label="全局播放器">
    <button type="button" class="player-track player-track-button" aria-label="打开正在播放" @click="emit('open-now-playing')">
      <div class="player-art"><img v-if="currentTrack?.artworkUrl" :src="currentTrack.artworkUrl" alt="" /><span v-else aria-hidden="true">♪</span></div>
      <div><span class="player-label">{{ playbackState?.state === 'playing' ? '正在播放' : '待机' }}</span><strong>{{ currentTrack?.title ?? '选择内容开始播放' }}</strong><small>{{ currentTrack ? currentTrack.artists.join('、') : 'Music Bridge for Roon' }}</small></div>
    </button>
    <div class="player-center">
      <button type="button" class="player-lyric player-inspector-trigger" aria-label="打开歌词" @click="emit('open-lyrics')"><span>歌词</span><strong>{{ currentLyricLine ?? '同步歌词会显示在这里' }}</strong></button>
      <div class="player-progress" role="presentation" aria-hidden="true"><span class="player-progress-fill" :style="{ width: activityWidth }"></span></div>
    </div>
    <div class="player-actions">
      <button type="button" class="player-inspector-button" aria-label="打开队列" @click="emit('open-queue')">队列</button>
      <button type="button" :disabled="!playbackState?.canPrevious" aria-label="Previous" @click="emit('previous')"><span aria-hidden="true">←</span></button>
      <button type="button" class="player-stop" :disabled="!playbackState?.canStop" aria-label="Stop" @click="emit('stop')"><span aria-hidden="true">■</span></button>
      <button type="button" :disabled="!playbackState?.canNext" aria-label="Next" @click="emit('next')"><span aria-hidden="true">→</span></button>
    </div>
  </footer>
</template>
