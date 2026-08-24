<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { PLAYBACK_QUALITY_PREFERENCES, type LyricsSnapshot, type PlaybackIssue, type PlaybackQualityPreference, type PlaybackSnapshot, type TrackSummary } from '@music-bridge/contracts'
import SidebarIcon from './sidebar/SidebarIcon.vue'
import SafeArtwork from './SafeArtwork.vue'
import LyricsLines from './LyricsLines.vue'

const props = defineProps<{
  currentTrack?: TrackSummary
  playbackState: PlaybackSnapshot | null
  lyricsSnapshot: LyricsSnapshot
  selectedQuality: PlaybackQualityPreference
  qualityLabel: (quality: string | undefined) => string
  qualityNotice?: PlaybackIssue
  playbackIssueMessage: (issue: PlaybackIssue) => string
}>()

const emit = defineEmits<{
  back: []
  previous: []
  'toggle-playback': []
  next: []
  'update:selected-quality': [quality: PlaybackQualityPreference]
}>()

const QUALITY_OPTION_LABELS: Record<PlaybackQualityPreference, string> = {
  auto: '自动 · 最高可用',
  standard: '标准 · 128 kbps',
  exhigh: '极高 · 320 kbps',
  lossless: '无损 · 1,411 kbps',
  hires: 'Hi-Res · 2,304 kbps',
}

const qualityMenuOpen = ref(false)
const qualityMenuRoot = ref<HTMLElement | null>(null)

function qualityOptionLabel(quality: PlaybackQualityPreference): string {
  return QUALITY_OPTION_LABELS[quality]
}

function toggleQualityMenu(): void {
  qualityMenuOpen.value = !qualityMenuOpen.value
}

function selectQuality(quality: PlaybackQualityPreference): void {
  qualityMenuOpen.value = false
  emit('update:selected-quality', quality)
}

function closeQualityMenuOnPointerDown(event: PointerEvent): void {
  const target = event.target
  if (target instanceof Node && !qualityMenuRoot.value?.contains(target)) qualityMenuOpen.value = false
}

function closeQualityMenuOnEscape(event: KeyboardEvent): void {
  if (event.key === 'Escape') qualityMenuOpen.value = false
}

const durationMs = computed(() => props.currentTrack?.durationMs ?? 0)
const progressMs = ref(0)
const progressRatio = computed(() => {
  if (durationMs.value <= 0) return 0
  return Math.min(1, Math.max(0, progressMs.value / durationMs.value))
})
let progressAnimationFrame: number | undefined
let positionAnchorMs = 0
let positionAnchorAt = 0

function stopProgressInterpolation(): void {
  if (progressAnimationFrame !== undefined) {
    cancelAnimationFrame(progressAnimationFrame)
    progressAnimationFrame = undefined
  }
}

function syncPlaybackPosition(): void {
  positionAnchorMs = Math.max(0, props.playbackState?.positionMs ?? 0)
  positionAnchorAt = performance.now()
  progressMs.value = Math.min(positionAnchorMs, durationMs.value || Number.MAX_SAFE_INTEGER)
}

function tickProgress(): void {
  if (props.playbackState?.state !== 'playing') {
    stopProgressInterpolation()
    return
  }
  const interpolated = positionAnchorMs + Math.max(0, performance.now() - positionAnchorAt)
  progressMs.value = Math.min(interpolated, durationMs.value || Number.MAX_SAFE_INTEGER)
  progressAnimationFrame = requestAnimationFrame(tickProgress)
}

function startProgressInterpolation(): void {
  stopProgressInterpolation()
  syncPlaybackPosition()
  if (props.playbackState?.state === 'playing') {
    progressAnimationFrame = requestAnimationFrame(tickProgress)
  }
}

watch(() => [props.currentTrack?.id, props.playbackState?.positionMs, props.playbackState?.state], startProgressInterpolation)
onMounted(() => {
  startProgressInterpolation()
  document.addEventListener('pointerdown', closeQualityMenuOnPointerDown)
  document.addEventListener('keydown', closeQualityMenuOnEscape)
})
onUnmounted(() => {
  stopProgressInterpolation()
  document.removeEventListener('pointerdown', closeQualityMenuOnPointerDown)
  document.removeEventListener('keydown', closeQualityMenuOnEscape)
})

function formatTime(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return '0:00'
  const totalSeconds = Math.floor(milliseconds / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = String(totalSeconds % 60).padStart(2, '0')
  return `${minutes}:${seconds}`
}

</script>

<template>
  <section class="now-playing-fullscreen" aria-labelledby="listening-heading">
    <header class="now-playing-header">
      <button type="button" class="now-playing-back" aria-label="退出全屏播放" @click="emit('back')"><span aria-hidden="true">←</span><span>返回</span></button>
    </header>

    <div class="now-playing-stage now-playing-immersive">
      <div class="now-playing-art-column">
        <SafeArtwork class="now-playing-art" :src="props.currentTrack?.artworkUrl" :alt="`${props.currentTrack?.title ?? ''} 封面`" loading="eager" />
        <div class="now-playing-copy">
          <div class="now-playing-track-heading">
            <p class="section-kicker">正在播放</p>
            <h2 id="listening-heading">{{ props.currentTrack?.title ?? '还没有正在播放的歌曲' }}</h2>
            <p class="artist-line">{{ props.currentTrack ? `${props.currentTrack.artists.join('、')} · ${props.currentTrack.album}` : '从歌曲列表选择内容开始。' }}</p>
          </div>
          <div class="now-playing-progress" aria-label="播放进度">
            <div class="now-playing-progress-track" :style="{ '--progress-ratio': `${progressRatio * 100}%` }">
              <span class="now-playing-progress-visual" aria-hidden="true"></span>
              <progress aria-label="播放进度" :max="Math.max(durationMs, 1)" :value="progressMs">{{ progressMs }}</progress>
            </div>
            <div class="now-playing-progress-meta"><span>{{ formatTime(progressMs) }}</span><span>{{ formatTime(durationMs) }}</span></div>
          </div>
          <div class="now-playing-quality-row" aria-label="音质选择">
            <div ref="qualityMenuRoot" class="now-playing-quality-control">
              <button
                type="button"
                class="now-playing-quality-button"
                :aria-expanded="qualityMenuOpen"
                aria-haspopup="menu"
                :aria-label="`选择播放音质，当前 ${qualityOptionLabel(props.selectedQuality)}`"
                @click="toggleQualityMenu"
              ><span>音质</span>{{ qualityOptionLabel(props.selectedQuality) }}<SidebarIcon name="chevron-down" :size="12" /></button>
              <div v-if="qualityMenuOpen" class="now-playing-quality-menu" role="menu" aria-label="播放音质">
                <button
                  v-for="quality in PLAYBACK_QUALITY_PREFERENCES"
                  :key="quality"
                  type="button"
                  role="menuitemradio"
                  :aria-checked="props.selectedQuality === quality"
                  @click="selectQuality(quality)"
                >{{ qualityOptionLabel(quality) }}</button>
              </div>
            </div>
            <span class="now-playing-quality-actual">实际 {{ props.qualityLabel(props.playbackState?.actualQuality) }}</span>
          </div>
          <div class="transport-controls" aria-label="歌曲切换控制">
            <button type="button" class="transport-button transport-button-secondary" :disabled="!props.playbackState?.canPrevious" aria-label="上一首" @click="emit('previous')"><SidebarIcon name="previous" :size="21" /></button>
            <button
              type="button"
              class="transport-button transport-button-primary"
              :disabled="['resolving', 'preparing', 'stopping', 'error'].includes(props.playbackState?.state ?? '') || (!props.playbackState?.canPause && !props.playbackState?.canResume && !props.currentTrack)"
              :aria-label="props.playbackState?.state === 'paused' ? '恢复播放' : props.playbackState?.state === 'playing' ? '暂停' : '播放当前歌曲'"
              @click="emit('toggle-playback')"
            ><SidebarIcon :name="props.playbackState?.state === 'playing' ? 'pause' : 'play'" :size="24" /></button>
            <button type="button" class="transport-button transport-button-secondary" :disabled="!props.playbackState?.canNext" aria-label="下一首" @click="emit('next')"><SidebarIcon name="next" :size="21" /></button>
          </div>
        </div>
      </div>

      <div class="now-playing-lyrics" aria-label="歌词滚动区域">
        <LyricsLines :snapshot="props.lyricsSnapshot" :track-id="props.currentTrack?.id" class="now-playing-lyrics-lines" />
      </div>
    </div>

    <p v-if="props.qualityNotice" class="persistent-error">{{ props.playbackIssueMessage(props.qualityNotice) }}<span>诊断标识：{{ props.qualityNotice.diagnosticId }}</span></p>
  </section>
</template>
