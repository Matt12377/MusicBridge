<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { LocalLyricsMatchSnapshot, LyricsSnapshot, PlaybackIssue, PlaybackSnapshot, TrackSummary } from '@music-bridge/contracts'
import SidebarIcon from './sidebar/SidebarIcon.vue'
import TrackArtwork from './TrackArtwork.vue'
import LyricsLines from './LyricsLines.vue'
import LocalLyricsMatchDrawer from './LocalLyricsMatchDrawer.vue'
import { createPlaybackClock } from './player/playbackClock.js'
import { audioQualityDetails, playbackSourceLabel } from './player/details.js'
import { roonQueueContextStatus } from '../roon-queue-context-status.js'

const props = defineProps<{
  currentTrack?: TrackSummary
  playbackState: PlaybackSnapshot | null
  clockIdentity?: string
  lyricsSnapshot: LyricsSnapshot
  qualityLabel: (quality: string | undefined) => string
  qualityNotice?: PlaybackIssue
  playbackIssueMessage: (issue: PlaybackIssue) => string
  trackLikeState: 'idle' | 'loading' | 'liked' | 'not-liked' | 'error'
  trackLikeAvailable: boolean
  playbackSource: 'roon' | 'netease' | 'local_file'
  seekAllowed: boolean
  localLyricsMatchState: LocalLyricsMatchSnapshot
  localLyricsMatchBusy?: boolean
  localLyricsMatchError?: boolean
}>()

const emit = defineEmits<{
  back: []
  previous: []
  'toggle-playback': []
  next: []
  'toggle-like': []
  seek: [positionMs: number, settle: (positionMs?: number) => void]
  'select-lyrics-match': [matchSessionId: string, candidateId: string]
  'revoke-lyrics-match': []
}>()

const qualityDetailsOpen = ref(false)
const contextStatus = computed(() => roonQueueContextStatus(props.playbackState?.queue.context))
const lyricsMatchOpen = ref(false)
const playbackQualityIdentity = computed(() => [
  props.currentTrack?.id ?? '',
  props.playbackState?.actualQuality ?? '',
  props.playbackState?.bitrate ?? '',
  props.playbackState?.format ?? '',
].join('\u0000'))

const durationMs = computed(() => props.currentTrack?.durationMs ?? 0)
const progressMs = ref(0)
const seeking = ref(false)
const progressRatio = computed(() => {
  if (durationMs.value <= 0) return 0
  return Math.min(1, Math.max(0, progressMs.value / durationMs.value))
})
let progressAnimationFrame: number | undefined
const clock = createPlaybackClock()
let disposed = false

function stopProgressInterpolation(): void {
  if (progressAnimationFrame !== undefined) { cancelAnimationFrame(progressAnimationFrame); progressAnimationFrame = undefined }
}
function tickProgress(): void {
  progressMs.value = clock.read(performance.now())
  if (props.playbackState?.state === 'playing') progressAnimationFrame = requestAnimationFrame(tickProgress)
}
function readSeekValue(event: Event): number {
  const target = event.target
  if (!(target instanceof HTMLInputElement)) return progressMs.value
  const value = Number(target.value)
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : progressMs.value
}
function previewSeek(event: Event): void {
  seeking.value = true
  clock.preview(readSeekValue(event), performance.now()); progressMs.value = clock.read(performance.now())
}
function commitSeek(event: Event): void {
  if (!props.seekAllowed || durationMs.value <= 0) { cancelSeek(); return }
  seeking.value = false
  const value = Math.min(readSeekValue(event), durationMs.value)
  const token = clock.preview(value, performance.now())
  progressMs.value = clock.read(performance.now())
  emit('seek', value, confirmed => {
    if (disposed) return
    clock.settle(token, confirmed, performance.now()); progressMs.value = clock.read(performance.now())
  })
}
function cancelSeek(): void { seeking.value = false; clock.cancel(performance.now()); progressMs.value = clock.read(performance.now()) }
function startProgressInterpolation(): void {
  stopProgressInterpolation()
  clock.observe({ id: props.clockIdentity ?? `${props.playbackState?.selectedZoneId ?? ''}:${props.currentTrack?.id ?? ''}`,
    state: props.playbackState?.state ?? 'idle', position: props.playbackState?.positionMs ?? 0, duration: durationMs.value }, performance.now())
  tickProgress()
}
watch(() => [props.clockIdentity, props.currentTrack?.id, props.playbackState?.selectedZoneId, props.playbackState?.positionMs, props.playbackState?.state], startProgressInterpolation)
watch(() => props.currentTrack?.id, () => { lyricsMatchOpen.value = false })
watch(playbackQualityIdentity, () => {
  qualityDetailsOpen.value = false
})
onMounted(startProgressInterpolation)
onUnmounted(() => {
  disposed = true
  stopProgressInterpolation()
})

function formatTime(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return '0:00'
  const totalSeconds = Math.floor(milliseconds / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = String(totalSeconds % 60).padStart(2, '0')
  return `${minutes}:${seconds}`
}

function formatBitrate(bitrate: number | undefined): string | undefined {
  if (!Number.isFinite(bitrate) || bitrate === undefined || bitrate <= 0) return undefined
  return `${Math.round(bitrate / 1000).toLocaleString('en-US')} kbps`
}

function transportLabel(state: PlaybackSnapshot['state'] | undefined): string {
  if (state === 'pausing') return '正在暂停'
  if (state === 'resuming') return '正在恢复'
  if (state === 'paused') return '恢复播放'
  if (state === 'playing') return '暂停'
  return '播放当前歌曲'
}

const evidenceDetails = computed(() => audioQualityDetails(props.playbackState ?? {}))
const actualQualityDetail = computed(() => {
  if (props.playbackSource === 'local_file') return evidenceDetails.value.file
  const bitrate = formatBitrate(props.playbackState?.bitrate)
  const format = props.playbackState?.format?.trim()
  if (bitrate && format) return `${bitrate} · ${format.toUpperCase()}`
  if (bitrate) return bitrate
  if (format) return format.toUpperCase()
  return props.playbackSource === 'roon' ? 'Roon API 未提供码率' : '码率未知'
})

</script>

<template>
  <section class="now-playing-fullscreen" aria-labelledby="listening-heading">
    <header class="now-playing-header">
      <button type="button" class="now-playing-back" aria-label="退出全屏播放" @click="emit('back')"><span aria-hidden="true">←</span><span>返回</span></button>
    </header>

    <div class="now-playing-stage now-playing-immersive">
      <div class="now-playing-art-column">
        <TrackArtwork class="now-playing-art" :track="props.currentTrack" :alt="`${props.currentTrack?.title ?? ''} 封面`" :width="768" :height="768" eager />
        <div class="now-playing-copy">
          <div class="now-playing-track-heading">
            <p class="section-kicker">正在播放</p>
            <div class="now-playing-title-row"><h2 id="listening-heading">{{ props.currentTrack?.title ?? '还没有正在播放的歌曲' }}</h2><span v-if="props.currentTrack" class="source-badge">{{ playbackSourceLabel(props.playbackSource) }}</span><button v-if="props.currentTrack && props.trackLikeAvailable" type="button" class="now-playing-like" :class="{ 'is-liked': props.trackLikeState === 'liked' }" :disabled="props.trackLikeState === 'loading'" :aria-pressed="props.trackLikeState === 'liked'" aria-label="喜欢这首歌" @click="emit('toggle-like')">{{ props.trackLikeState === 'liked' ? '♥' : '♡' }}</button></div>
            <p class="artist-line">{{ props.currentTrack ? `${props.currentTrack.artists.join('、')} · ${props.currentTrack.album}` : '从歌曲列表选择内容开始。' }}</p>
          </div>
          <div class="now-playing-progress" aria-label="播放进度">
            <div class="now-playing-progress-track" :style="{ '--progress-ratio': `${progressRatio * 100}%` }">
              <span class="now-playing-progress-visual" aria-hidden="true"></span>
              <progress aria-label="播放进度" :max="Math.max(durationMs, 1)" :value="progressMs">{{ progressMs }}</progress>
              <input class="now-playing-progress-input" type="range" aria-label="拖动播放进度" :min="0" :max="Math.max(durationMs, 1)" :value="progressMs" :disabled="!props.seekAllowed || !props.currentTrack || durationMs <= 0" @input="previewSeek" @change="commitSeek" @pointercancel="cancelSeek" />
            </div>
            <div class="now-playing-progress-meta"><span>{{ formatTime(progressMs) }}</span><span>{{ formatTime(durationMs) }}</span></div>
          </div>
          <div class="now-playing-quality-row" aria-label="文件与音质证据">
            <button
              type="button"
              class="now-playing-quality-button"
              :aria-expanded="qualityDetailsOpen"
              :aria-label="props.playbackSource === 'local_file' ? evidenceDetails.file : `来源返回音质 ${props.qualityLabel(props.playbackState?.actualQuality)}`"
              @click="qualityDetailsOpen = !qualityDetailsOpen"
            ><span>{{ props.playbackSource === 'local_file' ? '文件' : '来源' }}</span>{{ qualityDetailsOpen ? actualQualityDetail : props.playbackSource === 'local_file' ? (props.playbackState?.local?.file_parameters?.container ?? '参数未知') : props.qualityLabel(props.playbackState?.actualQuality) }}<SidebarIcon name="chevron-down" :size="12" /></button>
          </div>
          <div v-if="qualityDetailsOpen || props.playbackSource === 'local_file'" class="artist-line" aria-label="音质证据详情"><p>{{ evidenceDetails.file }}</p><p>{{ evidenceDetails.provider }}</p><p>{{ evidenceDetails.output }}</p><p>{{ evidenceDetails.evidence }}</p></div>
          <div class="transport-controls" aria-label="歌曲切换控制">
            <button type="button" class="transport-button transport-button-secondary" :disabled="!props.playbackState?.canPrevious" aria-label="上一首" @click="emit('previous')"><SidebarIcon name="previous" :size="21" /></button>
            <button
              type="button"
              class="transport-button transport-button-primary"
              :data-playing="props.playbackState?.state === 'playing'"
              :disabled="['resolving', 'preparing', 'pausing', 'resuming', 'stopping', 'error'].includes(props.playbackState?.state ?? '') || (!props.playbackState?.canPause && !props.playbackState?.canResume && !props.currentTrack)"
              :aria-label="transportLabel(props.playbackState?.state)"
              @click="emit('toggle-playback')"
            ><SidebarIcon :name="props.playbackState?.state === 'playing' || props.playbackState?.state === 'pausing' ? 'pause' : 'play'" :size="24" /></button>
            <button type="button" class="transport-button transport-button-secondary" :disabled="!props.playbackState?.canNext" aria-label="下一首" @click="emit('next')"><SidebarIcon name="next" :size="21" /></button>
          </div>
          <p v-if="contextStatus" class="artist-line" role="status">{{ contextStatus }}</p>
        </div>
      </div>

      <div class="now-playing-lyrics" aria-label="歌词滚动区域">
        <div v-if="props.lyricsSnapshot.source || props.localLyricsMatchState.status !== 'hidden'" class="now-playing-lyrics-toolbar">
          <span v-if="props.lyricsSnapshot.source === 'roon-display'" class="lyrics-source-label">歌词来源：Roon Web Display</span>
          <span v-if="props.lyricsSnapshot.source === 'netease'" class="lyrics-source-label">歌词来源：网易云</span>
          <button
            v-if="props.localLyricsMatchState.status !== 'hidden'"
            type="button"
            class="lyrics-match-trigger"
            :aria-expanded="lyricsMatchOpen"
            aria-haspopup="dialog"
            @click="lyricsMatchOpen = true"
          >{{ props.localLyricsMatchState.status === 'needs-choice' ? '选择匹配歌词' : '歌词匹配' }}</button>
        </div>
        <LyricsLines :snapshot="props.lyricsSnapshot" :track-id="props.currentTrack?.id" class="now-playing-lyrics-lines" />
      </div>
    </div>

    <LocalLyricsMatchDrawer
      v-if="lyricsMatchOpen"
      :state="props.localLyricsMatchState"
      :busy="props.localLyricsMatchBusy"
      :error="props.localLyricsMatchError"
      @close="lyricsMatchOpen = false"
      @select="(sessionId, candidateId) => emit('select-lyrics-match', sessionId, candidateId)"
      @revoke="emit('revoke-lyrics-match')"
    />

    <p v-if="props.qualityNotice" class="persistent-error">{{ props.playbackIssueMessage(props.qualityNotice) }}<span>诊断标识：{{ props.qualityNotice.diagnosticId }}</span></p>
  </section>
</template>
