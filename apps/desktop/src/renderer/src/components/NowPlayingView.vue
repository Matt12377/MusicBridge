<script setup lang="ts">
import { computed } from 'vue'
import type { LyricsSnapshot, PlaybackIssue, PlaybackSnapshot, TrackSummary } from '@music-bridge/contracts'
import SidebarIcon from './sidebar/SidebarIcon.vue'

const props = defineProps<{
  currentTrack?: TrackSummary
  playbackState: PlaybackSnapshot | null
  lyricsSnapshot: LyricsSnapshot
  selectedQuality: string
  qualityLabel: (quality: string | undefined) => string
  qualityNotice?: PlaybackIssue
  playbackIssueMessage: (issue: PlaybackIssue) => string
}>()

const emit = defineEmits<{
  back: []
  previous: []
  'play-current': []
  stop: []
  next: []
}>()

function hideBrokenArtwork(event: Event): void {
  const image = event.currentTarget as HTMLImageElement
  image.hidden = true
}

const durationMs = computed(() => props.currentTrack?.durationMs ?? 0)
const progressMs = computed(() => {
  const activeLine = props.lyricsSnapshot.lines[props.lyricsSnapshot.activeLineIndex]
  return Math.max(0, Math.min(activeLine?.startMs ?? 0, durationMs.value))
})

function formatTime(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return '0:00'
  const totalSeconds = Math.floor(milliseconds / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = String(totalSeconds % 60).padStart(2, '0')
  return `${minutes}:${seconds}`
}

function qualityLabel(quality: string | undefined): string {
  if (!quality) return '—'
  return quality === 'hires' ? 'Hi-Res' : quality[0].toUpperCase() + quality.slice(1)
}
</script>

<template>
  <section class="now-playing-fullscreen" aria-labelledby="listening-heading">
    <header class="now-playing-header">
      <button type="button" class="now-playing-back" aria-label="退出全屏播放" @click="emit('back')"><span aria-hidden="true">←</span><span>返回</span></button>
      <h1 class="now-playing-header-label">正在播放</h1>
    </header>

    <div class="now-playing-stage now-playing-immersive">
      <div class="now-playing-art-column">
        <div class="now-playing-art"><span class="artwork-fallback" aria-hidden="true">♪</span><img v-if="props.currentTrack?.artworkUrl" :src="props.currentTrack.artworkUrl" :alt="`${props.currentTrack.title} 封面`" @error="hideBrokenArtwork" /></div>
        <div class="now-playing-copy">
          <p class="section-kicker">正在播放</p>
          <h2 id="listening-heading">{{ props.currentTrack?.title ?? '还没有正在播放的歌曲' }}</h2>
          <p class="artist-line">{{ props.currentTrack ? `${props.currentTrack.artists.join('、')} · ${props.currentTrack.album}` : '从歌曲列表选择内容开始。' }}</p>
          <div class="now-playing-progress" aria-label="播放进度">
            <progress aria-label="播放进度" :max="Math.max(durationMs, 1)" :value="progressMs">{{ progressMs }}</progress>
            <div class="now-playing-progress-meta"><span>{{ formatTime(progressMs) }}</span><span>{{ props.playbackState?.format?.toUpperCase() ?? '音频' }} · {{ props.playbackState?.bitrate ? `${Math.round(props.playbackState.bitrate / 1000)} kbps` : '—' }}</span><span>{{ formatTime(durationMs) }}</span></div>
          </div>
          <div class="now-playing-quality-row"><span>音质</span><strong>{{ qualityLabel(props.selectedQuality) }}</strong><small>实际 {{ props.qualityLabel(props.playbackState?.actualQuality) }}</small></div>
          <div class="transport-controls" aria-label="歌曲切换控制">
            <button type="button" class="transport-button" :disabled="!props.playbackState?.canPrevious" aria-label="上一首" @click="emit('previous')"><SidebarIcon name="chevron-left" :size="22" /></button>
            <button v-if="props.playbackState?.canStop" type="button" class="transport-button stop-button" aria-label="停止" @click="emit('stop')"><span class="player-stop-glyph" aria-hidden="true"></span></button>
            <button v-else type="button" class="transport-button stop-button" :disabled="!props.currentTrack" aria-label="播放当前歌曲" @click="emit('play-current')"><SidebarIcon name="play" :size="22" /></button>
            <button type="button" class="transport-button" :disabled="!props.playbackState?.canNext" aria-label="下一首" @click="emit('next')"><SidebarIcon name="chevron-right" :size="22" /></button>
          </div>
        </div>
      </div>

      <div class="now-playing-lyrics" aria-label="同步歌词">
        <div class="now-playing-lyrics-heading"><div><p class="section-kicker">歌词</p><h3>同步歌词</h3></div><span>{{ props.lyricsSnapshot.status === 'loading' ? '正在读取…' : '随播放进度滚动' }}</span></div>
        <div v-if="props.lyricsSnapshot.lines.length" class="now-playing-lyrics-lines">
          <p v-for="(line, index) in props.lyricsSnapshot.lines" :key="`${line.startMs}-${index}`" class="now-playing-lyrics-line" :class="{ active: props.lyricsSnapshot.activeLineIndex === index }">{{ line.text }}<small v-if="line.translation">{{ line.translation }}</small></p>
        </div>
        <p v-else class="now-playing-lyrics-empty">暂无可用歌词。</p>
      </div>
    </div>

    <p v-if="props.qualityNotice" class="persistent-error">{{ props.playbackIssueMessage(props.qualityNotice) }}<span>诊断标识：{{ props.qualityNotice.diagnosticId }}</span></p>
  </section>
</template>
