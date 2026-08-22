<script setup lang="ts">
import type { LyricsSnapshot, PlaybackIssue, PlaybackQueueItem, PlaybackSnapshot, PublicRoonZone, TrackSummary } from '@music-bridge/contracts'
import LyricsPanel from './LyricsPanel.vue'

defineProps<{
  currentTrack?: TrackSummary
  selectedZone?: PublicRoonZone
  playbackState: PlaybackSnapshot | null
  lyricsSnapshot: LyricsSnapshot
  lyricsOrQueue: 'lyrics' | 'queue'
  qualityLabel: (quality: string | undefined) => string
  qualityNotice?: PlaybackIssue
  playbackIssueMessage: (issue: PlaybackIssue) => string
}>()

const emit = defineEmits<{
  previous: []
  stop: []
  next: []
  'set-lyrics-mode': [mode: 'lyrics' | 'queue']
  'play-queue-item': [item: PlaybackQueueItem, index: number]
}>()
</script>

<template>
  <section class="view now-playing-view" aria-labelledby="now-playing-heading">
    <div class="view-heading">
      <div><p class="section-kicker">The listening room</p><h2 id="now-playing-heading">Now Playing</h2><p class="lede">当前播放状态、实际质量和同步歌词。</p></div>
      <span class="live-badge"><i class="status-led playing"></i>{{ playbackState?.state ?? 'idle' }}</span>
    </div>

    <div class="now-playing-stage">
      <div class="now-playing-layout">
        <div class="hero-art"><img v-if="currentTrack?.artworkUrl" :src="currentTrack.artworkUrl" alt="当前曲目封面" /><span v-else aria-hidden="true">♪</span></div>
        <div class="now-playing-copy">
          <p class="section-kicker">Selected Zone</p>
          <h3>{{ currentTrack?.title ?? '没有正在播放的歌曲' }}</h3>
          <p class="artist-line">{{ currentTrack ? `${currentTrack.artists.join('、')} · ${currentTrack.album}` : '从 Search 或 Library 选择内容。' }}</p>
          <p class="zone-line">{{ selectedZone?.displayName ?? '尚未选择 Zone' }}</p>
          <div class="quality-grid">
            <div><span>请求质量</span><strong>{{ qualityLabel(playbackState?.requestedQuality) }}</strong></div>
            <div><span>实际质量</span><strong>{{ qualityLabel(playbackState?.actualQuality) }}</strong></div>
            <div><span>格式</span><strong>{{ playbackState?.format ?? '—' }}</strong></div>
            <div><span>码率</span><strong>{{ playbackState?.bitrate ? `${Math.round(playbackState.bitrate / 1000)} kbps` : '—' }}</strong></div>
          </div>
          <div class="transport-controls">
            <button type="button" class="transport-button" :disabled="!playbackState?.canPrevious" @click="emit('previous')">Previous</button>
            <button type="button" class="transport-button primary" :disabled="!playbackState?.canStop" @click="emit('stop')">Stop</button>
            <button type="button" class="transport-button" :disabled="!playbackState?.canNext" @click="emit('next')">Next</button>
          </div>
        </div>
      </div>
    </div>

    <p v-if="qualityNotice" class="persistent-error">{{ playbackIssueMessage(qualityNotice) }}<span>诊断标识：{{ qualityNotice.diagnosticId }}</span></p>
    <div class="switch-row"><button type="button" :class="{ selected: lyricsOrQueue === 'lyrics' }" @click="emit('set-lyrics-mode', 'lyrics')">Lyrics</button><button type="button" :class="{ selected: lyricsOrQueue === 'queue' }" @click="emit('set-lyrics-mode', 'queue')">Queue</button></div>
    <LyricsPanel v-if="lyricsOrQueue === 'lyrics'" :current-track="currentTrack" :snapshot="lyricsSnapshot" />
    <div v-else class="queue-panel">
      <div class="panel-heading"><div><p class="section-kicker">Up next</p><h3>Queue</h3></div><span>{{ playbackState?.queue.items.length ?? 0 }} items</span></div>
      <p v-if="!playbackState?.queue.items.length" class="empty-copy">队列为空。</p>
      <button v-for="(item, index) in playbackState?.queue.items" v-else :key="`${item.trackId}-${index}`" type="button" class="queue-row" :class="{ active: playbackState?.queue.index === index }" @click="emit('play-queue-item', item, index)"><span>{{ String(index + 1).padStart(2, '0') }}</span><strong>{{ item.trackId }}</strong><small>{{ qualityLabel(item.quality) }}</small></button>
    </div>
  </section>
</template>
