<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { LyricsSnapshot } from '@music-bridge/contracts'

defineOptions({ inheritAttrs: false })

const props = defineProps<{
  snapshot: LyricsSnapshot
  trackId?: string
}>()

const container = ref<HTMLElement | null>(null)
let followPausedUntil = 0
let resumeTimer: ReturnType<typeof setTimeout> | undefined
let programmaticScroll = false

const decoratedLines = computed(() => props.snapshot.lines.map((line, index) => ({
  line,
  index,
  distance: props.snapshot.activeLineIndex >= 0 ? Math.abs(props.snapshot.activeLineIndex - index) : -1,
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
  followPausedUntil = Date.now() + 4_000
  if (resumeTimer !== undefined) clearTimeout(resumeTimer)
  resumeTimer = setTimeout(() => {
    resumeTimer = undefined
    followActiveLine()
  }, 4_050)
}

function followActiveLine(): void {
  const index = props.snapshot.activeLineIndex
  if (index < 0 || Date.now() < followPausedUntil || !container.value) return
  void nextTick(() => {
    if (!container.value || index < 0 || Date.now() < followPausedUntil) return
    const target = container.value.querySelector<HTMLElement>(`[data-line-index="${index}"]`)
    if (!target) return
    programmaticScroll = true
    target.scrollIntoView({
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      block: 'center',
    })
    window.setTimeout(() => {
      programmaticScroll = false
    }, prefersReducedMotion() ? 0 : 350)
  })
}

function onScroll(): void {
  if (!programmaticScroll) pauseFollow()
}

watch(() => [props.snapshot.activeLineIndex, props.snapshot.lines.length], followActiveLine)
watch(() => props.trackId, () => {
  followPausedUntil = 0
  if (resumeTimer !== undefined) {
    clearTimeout(resumeTimer)
    resumeTimer = undefined
  }
  followActiveLine()
})
onMounted(followActiveLine)
onUnmounted(() => {
  if (resumeTimer !== undefined) clearTimeout(resumeTimer)
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
        <span v-for="(word, wordIndex) in entry.line.words" :key="`${word.startMs}-${wordIndex}`" :class="{ 'word-active': entry.distance === 0 && props.snapshot.activeWordIndex === wordIndex }">{{ word.text }}</span>
      </span>
      <span v-else>{{ entry.line.text }}</span>
      <small v-if="entry.line.translation">{{ entry.line.translation }}</small>
      <small v-if="entry.line.romanization">{{ entry.line.romanization }}</small>
    </p>
  </div>
</template>
