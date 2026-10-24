<script setup lang="ts">
import { type PlaybackQualityPreference, type PlaybackSnapshot, type PublicRoonZone, type TrackSummary } from '@music-bridge/contracts'
import PlayerProgress from './player/PlayerProgress.vue'
import VolumeControl from './player/VolumeControl.vue'
import { qualityDetails, audioQualityDetails, localPlaybackSeekAllowed } from './player/details.js'
import QualityControl from './player/QualityControl.vue'
import ZoneControl from './player/ZoneControl.vue'
import TrackArtwork from './TrackArtwork.vue'
import PlayerReferenceIcon from './player/PlayerReferenceIcon.vue'
import type { ZoneLifecycleStatus } from '../zone-lifecycle.js'

defineProps<{
  currentTrack?: TrackSummary
  playbackState: PlaybackSnapshot | null
  clockIdentity?: string
  playbackReady?: boolean
  zones: readonly PublicRoonZone[]
  selectedZone?: PublicRoonZone
  roonStatus: string
  zoneStatus: ZoneLifecycleStatus
  selectedQuality: PlaybackQualityPreference
}>()

const emit = defineEmits<{
  seek: [positionMs: number, settle: (positionMs?: number) => void]
  previous: []
  'toggle-playback': []
  next: []
  'open-now-playing': []
  'open-queue': []
  'select-zone': [zoneId: string]
  'update:selected-quality': [quality: PlaybackQualityPreference]
}>()

function transportLabel(state: PlaybackSnapshot['state'] | undefined): string {
  if (state === 'pausing') return '正在暂停'
  if (state === 'resuming') return '正在恢复'
  if (state === 'paused') return '恢复播放'
  if (state === 'playing') return '暂停'
  return '播放当前歌曲'
}

</script>

<template>
  <footer class="global-player is-reference-player" :class="{ 'is-idle': !currentTrack }" aria-label="全局播放器">
    <div v-if="currentTrack" class="player-content">
      <div class="player-content-details">
        <button type="button" class="player-track player-track-button" aria-label="打开正在播放" @click="emit('open-now-playing')">
          <TrackArtwork class="player-art" :track="currentTrack" alt="" :width="96" :height="96" eager />
          <div class="player-track-copy">
            <strong>{{ currentTrack.title }}</strong>
            <small>{{ currentTrack.artists.join('、') }}<template v-if="currentTrack.album"> — {{ currentTrack.album }}</template></small>
            <span class="visually-hidden" aria-label="文件与来源音质参数">{{ playbackState?.source === 'local_file' ? audioQualityDetails(playbackState).file : qualityDetails(playbackState ?? {}) }}</span>
          </div>
        </button>
        <QualityControl :actual-quality="playbackState?.actualQuality ?? 'unknown'" :selected-quality="selectedQuality" @update:selected-quality="emit('update:selected-quality', $event)" />
      </div>
      <PlayerProgress :snapshot="playbackState" :clock-identity="clockIdentity" :allowed="playbackReady !== false && selectedZone?.seekAllowed === true && localPlaybackSeekAllowed(playbackState, selectedZone?.zoneId)" @seek="(position, settle) => emit('seek', position, settle)" />
    </div>
    <span v-else class="player-idle-brand" aria-hidden="true">&#63743;</span>

    <div class="player-controls" aria-label="播放控制">
      <span class="player-mode-icon" aria-hidden="true"><PlayerReferenceIcon name="shuffle" :size="18" /></span>
      <button type="button" class="player-control-button" :disabled="!playbackState?.canPrevious" aria-label="上一首" @click="emit('previous')"><PlayerReferenceIcon name="previous" :size="26" /></button>
      <button
        type="button"
        class="player-play-button"
        :data-playing="playbackState?.state === 'playing'"
        :disabled="['resolving', 'preparing', 'pausing', 'resuming', 'stopping', 'error'].includes(playbackState?.state ?? '') || (!playbackState?.canPause && !playbackState?.canResume && !currentTrack)"
        :aria-label="transportLabel(playbackState?.state)"
        @click="emit('toggle-playback')"
      ><PlayerReferenceIcon :name="playbackState?.state === 'playing' || playbackState?.state === 'pausing' ? 'pause' : 'play'" :size="32" /></button>
      <button type="button" class="player-control-button" :disabled="!playbackState?.canNext" aria-label="下一首" @click="emit('next')"><PlayerReferenceIcon name="next" :size="26" /></button>
      <span class="player-mode-icon" aria-hidden="true"><PlayerReferenceIcon name="repeat" :size="18" /></span>
    </div>

    <div class="player-meta">
      <button type="button" class="player-inspector-button" aria-label="打开播放队列" @click="emit('open-queue')"><PlayerReferenceIcon name="queue" :size="26" /></button>
      <ZoneControl :zones="zones" :selected-zone="selectedZone" :roon-status="roonStatus" :zone-status="zoneStatus" @select="emit('select-zone', $event)">
        <template #icon><PlayerReferenceIcon name="airplay" :size="26" /></template>
      </ZoneControl>
      <VolumeControl :zone-id="selectedZone?.zoneId"><template #icon><PlayerReferenceIcon name="volume" :size="26" /></template></VolumeControl>
    </div>
  </footer>
</template>

<style src="./player/reference-player.css"></style>
