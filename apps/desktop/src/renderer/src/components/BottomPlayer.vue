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
}>()

const activityWidth = computed(() => (props.playbackState?.state === 'playing' ? '38%' : '0%'))
</script>

<template>
  <footer class="global-player" aria-label="全局播放器">
    <div class="player-track">
      <div class="player-art"><img v-if="currentTrack?.artworkUrl" :src="currentTrack.artworkUrl" alt="" /><span v-else aria-hidden="true">♪</span></div>
      <div><span class="player-label">{{ playbackState?.state === 'playing' ? '正在播放' : '待机' }}</span><strong>{{ currentTrack?.title ?? '选择内容开始播放' }}</strong><small>{{ currentTrack ? currentTrack.artists.join('、') : 'Music Bridge for Roon' }}</small></div>
    </div>
    <div class="player-center">
      <div class="player-lyric"><span>LYRICS</span><strong>{{ currentLyricLine ?? '同步歌词会显示在这里' }}</strong></div>
      <div class="player-progress" role="presentation" aria-hidden="true"><span class="player-progress-fill" :style="{ width: activityWidth }"></span></div>
    </div>
    <div class="player-actions">
      <button type="button" :disabled="!playbackState?.canPrevious" aria-label="Previous" @click="emit('previous')"><span aria-hidden="true">←</span></button>
      <button type="button" class="player-stop" :disabled="!playbackState?.canStop" aria-label="Stop" @click="emit('stop')"><span aria-hidden="true">■</span></button>
      <button type="button" :disabled="!playbackState?.canNext" aria-label="Next" @click="emit('next')"><span aria-hidden="true">→</span></button>
    </div>
  </footer>
</template>
