<script setup lang="ts">
import { PLAYBACK_QUALITY_LEVELS, type PlaybackQuality, type PlaybackSnapshot, type PublicRoonZone, type TrackSummary } from '@music-bridge/contracts'
import SidebarIcon from './sidebar/SidebarIcon.vue'
import ZoneControl from './player/ZoneControl.vue'

defineProps<{
  currentTrack?: TrackSummary
  playbackState: PlaybackSnapshot | null
  currentLyricLine?: string
  zones: readonly PublicRoonZone[]
  selectedZone?: PublicRoonZone
  roonStatus: string
  selectedQuality: PlaybackQuality
}>()

const emit = defineEmits<{
  previous: []
  'play-current': []
  stop: []
  next: []
  'open-now-playing': []
  'open-lyrics': []
  'open-queue': []
  'select-zone': [zoneId: string]
  'update:selected-quality': [quality: PlaybackQuality]
}>()

function qualityLabel(quality: PlaybackQuality): string {
  return quality === 'hires' ? 'Hi-Res' : quality[0].toUpperCase() + quality.slice(1)
}

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
      <button type="button" class="player-control-button" :disabled="!playbackState?.canPrevious" aria-label="上一首" @click="emit('previous')"><SidebarIcon name="chevron-left" :size="18" /></button>
      <button v-if="playbackState?.canStop" type="button" class="player-play-button" aria-label="停止" @click="emit('stop')"><span class="player-stop-glyph" aria-hidden="true"></span></button>
      <button v-else type="button" class="player-play-button" :disabled="!currentTrack" aria-label="播放当前歌曲" @click="emit('play-current')"><SidebarIcon name="play" :size="18" /></button>
      <button type="button" class="player-control-button" :disabled="!playbackState?.canNext" aria-label="下一首" @click="emit('next')"><SidebarIcon name="chevron-right" :size="18" /></button>
    </div>

    <div class="player-meta">
      <label class="player-quality-select">
        <span>音质切换</span>
        <select aria-label="切换播放音质" :value="selectedQuality" @change="emit('update:selected-quality', ($event.target as HTMLSelectElement).value as PlaybackQuality)">
          <option v-for="quality in PLAYBACK_QUALITY_LEVELS" :key="quality" :value="quality">{{ qualityLabel(quality) }}</option>
        </select>
      </label>
      <ZoneControl :zones="zones" :selected-zone="selectedZone" :roon-status="roonStatus" @select="emit('select-zone', $event)" />
      <button type="button" class="player-inspector-button" aria-label="打开歌词检查器" @click="emit('open-lyrics')">歌词</button>
      <button type="button" class="player-inspector-button" aria-label="打开队列检查器" @click="emit('open-queue')">队列</button>
    </div>
  </footer>
</template>
