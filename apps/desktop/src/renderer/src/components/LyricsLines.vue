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
type ScrollFollowState = 'following' | 'programmatic-scrolling' | 'user-scrolling' | 'settling'

let followPausedUntil = 0
let resumeTimer: ReturnType<typeof setTimeout> | undefined
let scrollFollowState: ScrollFollowState = 'following'
let pendingFollowIndex = -1
let settleFrame: number | undefined
let settleFrameCount = 0
let stableFrameCount = 0
let previousScrollTop: number | undefined
let followGeneration = 0

const FOLLOW_PAUSE_MS = 4_000
const CENTER_TOLERANCE_PX = 12
const REQUIRED_STABLE_FRAMES = 3
const MAX_SETTLE_FRAMES = 60

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

function beginUserScroll(): void {
  followGeneration += 1
  scrollFollowState = 'user-scrolling'
  pendingFollowIndex = -1
  cancelScrollSettlement()
  followPausedUntil = Date.now() + FOLLOW_PAUSE_MS
  if (resumeTimer !== undefined) clearTimeout(resumeTimer)
  resumeTimer = setTimeout(() => {
    resumeTimer = undefined
    scrollFollowState = 'settling'
    followActiveLine()
  }, FOLLOW_PAUSE_MS + 50)
}

function cancelScrollSettlement(): void {
  if (settleFrame !== undefined) {
    cancelAnimationFrame(settleFrame)
    settleFrame = undefined
  }
  settleFrameCount = 0
  stableFrameCount = 0
  previousScrollTop = undefined
}

function lineVisuallyCentered(target: HTMLElement, host: HTMLElement): boolean {
  const hostRect = host.getBoundingClientRect()
  const targetRect = target.getBoundingClientRect()
  const center = targetRect.top + targetRect.height / 2 - hostRect.top
  return Math.abs(center - hostRect.height / 2) <= CENTER_TOLERANCE_PX
}

function updateEdgeSpacers(target: HTMLElement, host: HTMLElement): void {
  const height = Math.max(0, host.clientHeight / 2 - target.getBoundingClientRect().height / 2)
  for (const spacer of host.querySelectorAll<HTMLElement>('.lyrics-edge-spacer')) {
    spacer.style.height = `${height}px`
  }
}

function finishProgrammaticScroll(): void {
  scrollFollowState = 'following'
  pendingFollowIndex = -1
  cancelScrollSettlement()
}

function monitorScrollSettlement(target: HTMLElement, host: HTMLElement): void {
  cancelScrollSettlement()
  settleFrameCount = 0
  stableFrameCount = 0
  previousScrollTop = host.scrollTop
  const check = (): void => {
    if (scrollFollowState !== 'programmatic-scrolling' && scrollFollowState !== 'settling') return
    settleFrameCount += 1
    const currentScrollTop = host.scrollTop
    const stable = previousScrollTop !== undefined
      && Math.abs(currentScrollTop - previousScrollTop) < 0.5
      && lineVisuallyCentered(target, host)
    stableFrameCount = stable ? stableFrameCount + 1 : 0
    previousScrollTop = currentScrollTop
    if (lineVisuallyCentered(target, host)) scrollFollowState = 'settling'
    // scrollend is the primary completion signal. Engines without it must show
    // a genuinely stable target for several frames before follow resumes.
    if (!target.isConnected || stableFrameCount >= REQUIRED_STABLE_FRAMES || settleFrameCount >= MAX_SETTLE_FRAMES) {
      finishProgrammaticScroll()
      return
    }
    settleFrame = requestAnimationFrame(check)
  }
  settleFrame = requestAnimationFrame(check)
}

function followActiveLine(): void {
  const index = focusLineIndex.value
  if (
    index < 0
    || scrollFollowState === 'user-scrolling'
    || Date.now() < followPausedUntil
    || !container.value
  ) return
  const generation = ++followGeneration
  void nextTick(() => {
    if (
      generation !== followGeneration
      || !container.value
      || index < 0
      || scrollFollowState === 'user-scrolling'
      || Date.now() < followPausedUntil
    ) return
    const target = container.value.querySelector<HTMLElement>(`[data-line-index="${index}"]`)
    if (!target) return
    updateEdgeSpacers(target, container.value)
    if (lineVisuallyCentered(target, container.value)) {
      finishProgrammaticScroll()
      return
    }
    pendingFollowIndex = index
    scrollFollowState = 'programmatic-scrolling'
    target.scrollIntoView({
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      block: 'center',
    })
    monitorScrollSettlement(target, container.value)
  })
}

function onScroll(): void {
  // User input handlers enter user-scrolling before their resulting scroll
  // event. Programmatic events are observed only by the settlement monitor.
}

function onScrollEnd(): void {
  if (
    (scrollFollowState === 'programmatic-scrolling' || scrollFollowState === 'settling')
    && pendingFollowIndex >= 0
  ) finishProgrammaticScroll()
}

watch(() => [props.snapshot.activeLineIndex, props.snapshot.lines.length], () => {
  cancelScrollSettlement()
  followActiveLine()
})
watch(() => props.snapshot.activeLineIndex, (index) => {
  if (index >= 0 && index < props.snapshot.lines.length) retainedActiveLineIndex.value = index
})
watch(() => props.trackId, () => {
  followGeneration += 1
  retainedActiveLineIndex.value = props.snapshot.activeLineIndex >= 0 ? props.snapshot.activeLineIndex : -1
  followPausedUntil = 0
  if (resumeTimer !== undefined) {
    clearTimeout(resumeTimer)
    resumeTimer = undefined
  }
  cancelScrollSettlement()
  scrollFollowState = 'following'
  pendingFollowIndex = -1
  followActiveLine()
})
function onViewportResize(): void {
  followActiveLine()
}

onMounted(() => {
  window.addEventListener('resize', onViewportResize)
  followActiveLine()
})
onUnmounted(() => {
  followGeneration += 1
  if (resumeTimer !== undefined) clearTimeout(resumeTimer)
  cancelScrollSettlement()
  window.removeEventListener('resize', onViewportResize)
})
</script>

<template>
  <div
    ref="container"
    class="lyrics-lines lyrics-follow-scroll"
    :class="$attrs.class"
    tabindex="0"
    @wheel="beginUserScroll"
    @touchstart="beginUserScroll"
    @pointerdown="beginUserScroll"
    @scroll="onScroll"
    @scrollend="onScrollEnd"
  >
    <span class="lyrics-edge-spacer" aria-hidden="true"></span>
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
    <span class="lyrics-edge-spacer" aria-hidden="true"></span>
  </div>
</template>
