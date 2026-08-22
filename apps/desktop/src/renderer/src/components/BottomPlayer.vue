<script setup lang="ts">
import type { PlaybackSnapshot, PublicRoonZone, TrackSummary } from '@music-bridge/contracts'
import ZoneControl from './player/ZoneControl.vue'

defineProps<{
  currentTrack?: TrackSummary
  playbackState: PlaybackSnapshot | null
  currentLyricLine?: string
  zones: readonly PublicRoonZone[]
  selectedZone?: PublicRoonZone
  roonStatus: string
  actualQuality: string
}>()

const emit = defineEmits<{
  previous: []
  stop: []
  next: []
  'open-now-playing': []
  'open-lyrics': []
  'open-queue': []
  'select-zone': [zoneId: string]
}>()

function hideBrokenArtwork(event: Event): void {
  const image = event.currentTarget as HTMLImageElement
  image.hidden = true
}
</script>

<template>
  <footer class="global-player" aria-label="全局播放器">
    <button type="button" class="player-track player-track-button" aria-label="打开正在播放" @click="emit('open-now-playing')">
      <div class="player-art"><span class="artwork-fallback" aria-hidden="true">♪</span><img v-if="currentTrack?.artworkUrl" :src="currentTrack.artworkUrl" alt="" @error="hideBrokenArtwork" /></div>
      <div><span class="player-label">{{ playbackState?.state === 'playing' ? '正在播放' : '待机' }}</span><strong>{{ currentTrack?.title ?? '选择内容开始播放' }}</strong><small>{{ currentTrack ? currentTrack.artists.join('、') : 'Music Bridge for Roon' }}</small><em v-if="currentLyricLine">{{ currentLyricLine }}</em></div>
    </button>

    <div class="player-controls" aria-label="播放控制">
      <button type="button" :disabled="!playbackState?.canPrevious" aria-label="上一首" @click="emit('previous')"><span aria-hidden="true">←</span></button>
      <button type="button" class="player-stop" :disabled="!playbackState?.canStop" aria-label="停止" @click="emit('stop')"><span aria-hidden="true">■</span></button>
      <button type="button" :disabled="!playbackState?.canNext" aria-label="下一首" @click="emit('next')"><span aria-hidden="true">→</span></button>
    </div>

    <div class="player-meta">
      <span class="player-quality"><small>实际音质</small><strong>{{ actualQuality }}</strong></span>
      <ZoneControl :zones="zones" :selected-zone="selectedZone" :roon-status="roonStatus" @select="emit('select-zone', $event)" />
      <button type="button" class="player-inspector-button" aria-label="打开歌词检查器" @click="emit('open-lyrics')">歌词</button>
      <button type="button" class="player-inspector-button" aria-label="打开队列检查器" @click="emit('open-queue')">队列</button>
    </div>
  </footer>
</template>
