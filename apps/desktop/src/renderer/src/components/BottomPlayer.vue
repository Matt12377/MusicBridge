<script setup lang="ts">
import { PLAYBACK_QUALITY_PREFERENCES, type PlaybackQualityPreference, type PlaybackSnapshot, type PublicRoonZone, type TrackSummary } from '@music-bridge/contracts'
import SidebarIcon from './sidebar/SidebarIcon.vue'
import ZoneControl from './player/ZoneControl.vue'
import TrackArtwork from './TrackArtwork.vue'
import type { ZoneLifecycleStatus } from '../zone-lifecycle.js'

defineProps<{
  currentTrack?: TrackSummary
  playbackState: PlaybackSnapshot | null
  zones: readonly PublicRoonZone[]
  selectedZone?: PublicRoonZone
  roonStatus: string
  zoneStatus: ZoneLifecycleStatus
  selectedQuality: PlaybackQualityPreference
}>()

const emit = defineEmits<{
  previous: []
  'toggle-playback': []
  next: []
  'open-now-playing': []
  'open-queue': []
  'select-zone': [zoneId: string]
  'update:selected-quality': [quality: PlaybackQualityPreference]
}>()

function qualityLabel(quality: PlaybackQualityPreference): string {
  if (quality === 'auto') return '自动'
  return quality === 'hires' ? 'Hi-Res' : quality[0].toUpperCase() + quality.slice(1)
}

function transportLabel(state: PlaybackSnapshot['state'] | undefined): string {
  if (state === 'pausing') return '正在暂停'
  if (state === 'resuming') return '正在恢复'
  if (state === 'paused') return '恢复播放'
  if (state === 'playing') return '暂停'
  return '播放当前歌曲'
}

</script>

<template>
  <footer class="global-player" aria-label="全局播放器">
    <button type="button" class="player-track player-track-button" aria-label="打开正在播放" @click="emit('open-now-playing')">
      <TrackArtwork class="player-art" :track="currentTrack" alt="" eager />
      <div><strong>{{ currentTrack?.title ?? '选择内容开始播放' }}</strong><small>{{ currentTrack ? currentTrack.artists.join('、') : 'Music Bridge for Roon' }}</small></div>
    </button>

    <div class="player-controls" aria-label="播放控制">
      <button type="button" class="player-control-button" :disabled="!playbackState?.canPrevious" aria-label="上一首" @click="emit('previous')"><SidebarIcon name="previous" :size="18" /></button>
      <button
        type="button"
        class="player-play-button"
        :disabled="['resolving', 'preparing', 'pausing', 'resuming', 'stopping', 'error'].includes(playbackState?.state ?? '') || (!playbackState?.canPause && !playbackState?.canResume && !currentTrack)"
        :aria-label="transportLabel(playbackState?.state)"
        @click="emit('toggle-playback')"
      ><SidebarIcon :name="playbackState?.state === 'playing' || playbackState?.state === 'pausing' ? 'pause' : 'play'" :size="18" /></button>
      <button type="button" class="player-control-button" :disabled="!playbackState?.canNext" aria-label="下一首" @click="emit('next')"><SidebarIcon name="next" :size="18" /></button>
    </div>

    <div class="player-meta">
      <label class="player-quality-select">
        <span>下次音质</span>
        <select aria-label="切换播放音质" :value="selectedQuality" @change="emit('update:selected-quality', ($event.target as HTMLSelectElement).value as PlaybackQualityPreference)">
        <option v-for="quality in PLAYBACK_QUALITY_PREFERENCES" :key="quality" :value="quality">{{ qualityLabel(quality) }}</option>
        </select>
      </label>
      <ZoneControl :zones="zones" :selected-zone="selectedZone" :roon-status="roonStatus" :zone-status="zoneStatus" @select="emit('select-zone', $event)" />
      <button type="button" class="player-inspector-button" aria-label="打开播放队列" @click="emit('open-queue')"><SidebarIcon name="list" :size="16" /><span class="visually-hidden">队列</span></button>
    </div>
  </footer>
</template>
