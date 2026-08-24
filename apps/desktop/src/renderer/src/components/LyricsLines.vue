<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { LyricsSnapshot } from '@music-bridge/contracts'

defineOptions({ inheritAttrs: false })

const props = defineProps<{
  snapshot: LyricsSnapshot
  trackId?: string
}>()

const container = ref<HTMLElement | null>(null)
const retainedActiveLineIndex = ref(props.snapshot.activeLineIndex >= 0 ? props.snapshot.activeLineIndex : -1)
let followPausedUntil = 0
let resumeTimer: ReturnType<typeof setTimeout> | undefined
let programmaticScroll = false
let pendingFollowIndex = -1
let settleFrame: number | undefined
let settleFrameCount = 0

const FOLLOW_PAUSE_MS = 4_000
const SAFE_ZONE_START = 0.35
const SAFE_ZONE_END = 0.65

const focusLineIndex = computed(() => {
  const activeLineIndex = props.snapshot.activeLineIndex
  if (activeLineIndex >= 0 && activeLineIndex < props.snapshot.lines.length) return activeLineIndex
  return retainedActiveLineIndex.value >= 0 && retainedActiveLineIndex.value < props.snapshot.lines.length
    ? retainedActiveLineIndex.value
    : -1
})

const decoratedLines = computed(() => props.snapshot.lines.map((line, index) => ({
  line,
  index,
  distance: focusLineIndex.value >= 0 ? Math.abs(focusLineIndex.value - index) : -1,
})))

function statusLabel(status: LyricsSnapshot['status']): string {
  return {
    idle: '待播放',
    loading: '正在读取',
    ready: '已同步',
    instrumental: '纯音乐',
    unavailable: '暂无歌词',
    error: '歌词不可用',
  }[status]
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

function pauseFollow(): void {
  followPausedUntil = Date.now() + FOLLOW_PAUSE_MS
  if (resumeTimer !== undefined) clearTimeout(resumeTimer)
  resumeTimer = setTimeout(() => {
    resumeTimer = undefined
    followActiveLine()
  }, FOLLOW_PAUSE_MS + 50)
}

function cancelScrollSettlement(): void {
  if (settleFrame !== undefined) {
    cancelAnimationFrame(settleFrame)
    settleFrame = undefined
  }
  settleFrameCount = 0
}

function targetInSafeZone(target: HTMLElement, host: HTMLElement): boolean {
  const hostRect = host.getBoundingClientRect()
  const targetRect = target.getBoundingClientRect()
  const center = targetRect.top + targetRect.height / 2 - hostRect.top
  return center >= hostRect.height * SAFE_ZONE_START && center <= hostRect.height * SAFE_ZONE_END
}

function finishProgrammaticScroll(): void {
  programmaticScroll = false
  pendingFollowIndex = -1
  cancelScrollSettlement()
}

function monitorScrollSettlement(target: HTMLElement, host: HTMLElement): void {
  cancelScrollSettlement()
  settleFrameCount = 0
  const check = (): void => {
    if (!programmaticScroll) return
    settleFrameCount += 1
    // scrollend is the primary completion signal. The bounded rAF fallback is
    // only for engines without scrollend and never guesses an animation time.
    if (!target.isConnected || targetInSafeZone(target, host) || settleFrameCount >= 30) {
      finishProgrammaticScroll()
      return
    }
    settleFrame = requestAnimationFrame(check)
  }
  settleFrame = requestAnimationFrame(check)
}

function followActiveLine(): void {
  const index = focusLineIndex.value
  if (index < 0 || Date.now() < followPausedUntil || !container.value) return
  void nextTick(() => {
    if (!container.value || index < 0 || Date.now() < followPausedUntil) return
    const target = container.value.querySelector<HTMLElement>(`[data-line-index="${index}"]`)
    if (!target) return
    if (targetInSafeZone(target, container.value)) {
      finishProgrammaticScroll()
      return
    }
    pendingFollowIndex = index
    programmaticScroll = true
    target.scrollIntoView({
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      block: 'center',
    })
    monitorScrollSettlement(target, container.value)
  })
}

function onScroll(): void {
  if (!programmaticScroll) pauseFollow()
}

function onScrollEnd(): void {
  if (programmaticScroll && pendingFollowIndex >= 0) finishProgrammaticScroll()
}

watch(() => [props.snapshot.activeLineIndex, props.snapshot.lines.length], () => {
  cancelScrollSettlement()
  followActiveLine()
})
watch(() => props.snapshot.activeLineIndex, (index) => {
  if (index >= 0 && index < props.snapshot.lines.length) retainedActiveLineIndex.value = index
})
watch(() => props.trackId, () => {
  retainedActiveLineIndex.value = props.snapshot.activeLineIndex >= 0 ? props.snapshot.activeLineIndex : -1
  followPausedUntil = 0
  if (resumeTimer !== undefined) {
    clearTimeout(resumeTimer)
    resumeTimer = undefined
  }
  cancelScrollSettlement()
  programmaticScroll = false
  pendingFollowIndex = -1
  followActiveLine()
})
onMounted(followActiveLine)
onUnmounted(() => {
  if (resumeTimer !== undefined) clearTimeout(resumeTimer)
  cancelScrollSettlement()
})
</script>

<template>
  <div
    ref="container"
    class="lyrics-lines lyrics-follow-scroll"
    :class="$attrs.class"
    tabindex="0"
    @wheel="pauseFollow"
    @touchstart="pauseFollow"
    @pointerdown="pauseFollow"
    @scroll="onScroll"
    @scrollend="onScrollEnd"
  >
    <p v-if="!props.snapshot.lines.length" class="lyrics-empty-line">{{ statusLabel(props.snapshot.status) }}</p>
    <p
      v-for="entry in decoratedLines"
      :key="`${entry.line.startMs}-${entry.index}`"
      :data-line-distance="entry.distance >= 0 ? entry.distance : 'unknown'"
      :aria-current="entry.distance === 0 ? 'true' : undefined"
      :data-line-index="entry.index"
      class="lyrics-line"
      :class="{
        active: entry.distance === 0,
        'lyrics-line-near': entry.distance > 0 && entry.distance <= 2,
        'lyrics-line-far': entry.distance > 4,
        [`lyrics-line-distance-${Math.min(entry.distance, 5)}`]: entry.distance >= 0,
      }"
    >
      <span v-if="entry.line.words?.length" class="lyrics-words">
        <span v-for="(word, wordIndex) in entry.line.words" :key="`${word.startMs}-${wordIndex}`">{{ word.text }}</span>
      </span>
      <span v-else>{{ entry.line.text }}</span>
      <small v-if="entry.line.translation">{{ entry.line.translation }}</small>
      <small v-if="entry.line.romanization">{{ entry.line.romanization }}</small>
    </p>
  </div>
</template>
