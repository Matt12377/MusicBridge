<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from 'vue'
import type { PlaybackSnapshot } from '@music-bridge/contracts'
import { playbackPosition, formatPlaybackTime } from './details.js'
const props = defineProps<{ snapshot: PlaybackSnapshot | null; allowed: boolean }>()
const emit = defineEmits<{ seek: [positionMs: number] }>()
const position = ref(0)
const dragging = ref(false)
const duration = computed(() => props.snapshot?.currentTrack?.durationMs ?? 0)
let anchor = 0, at = 0
let timer: ReturnType<typeof setInterval> | undefined
function tick() { if (!dragging.value) position.value = playbackPosition(anchor, performance.now() - at, duration.value, props.snapshot?.state === 'playing') }
watch(() => [props.snapshot?.currentTrack?.id, props.snapshot?.positionMs, props.snapshot?.state], () => {
 dragging.value = false
 anchor = props.snapshot?.positionMs ?? 0; at = performance.now(); tick()
 if (timer) clearInterval(timer)
 if (props.snapshot?.state === 'playing') timer = setInterval(tick, 250)
}, {immediate:true})
onUnmounted(() => { if (timer) clearInterval(timer) })
function preview(event: Event) { dragging.value = true; position.value = Number((event.target as HTMLInputElement).value) }
function commit(event: Event) {
 dragging.value = false
 if (!props.allowed || duration.value <= 0) { tick(); return }
 const value = Math.min(duration.value, Math.max(0, Number((event.target as HTMLInputElement).value)))
 if (Number.isFinite(value)) emit('seek', value)
 // 提交后等待真实快照确认，失败时不保留虚假的时间。
 tick()
}
</script>
<template>
 <div class="player-timeline">
  <time>{{ formatPlaybackTime(position) }}</time>
  <input type="range" aria-label="播放栏进度" :aria-valuetext="`${formatPlaybackTime(position)} / ${formatPlaybackTime(duration)}`" :min="0" :max="Math.max(1,duration)" :step="1000" :value="position" :disabled="!allowed || duration <= 0" :style="{'--progress': `${duration > 0 ? position/duration*100 : 0}%`}" @input="preview" @change="commit" @pointercancel="dragging = false; tick()" />
  <time>{{ formatPlaybackTime(duration) }}</time>
 </div>
</template>
