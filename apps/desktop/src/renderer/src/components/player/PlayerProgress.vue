<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from 'vue'
import type { PlaybackSnapshot } from '@music-bridge/contracts'
import { formatPlaybackTime } from './details.js'
import { createPlaybackClock } from './playbackClock.js'
const props = defineProps<{ snapshot: PlaybackSnapshot | null; allowed: boolean }>()
const emit = defineEmits<{ seek: [positionMs: number, settle: (positionMs?:number)=>void] }>()
const position = ref(0)
const duration = computed(() => props.snapshot?.currentTrack?.durationMs ?? 0)
const clock=createPlaybackClock()
let frame=0, seekToken=0, disposed=false
function tick(){position.value=clock.read(performance.now());if(props.snapshot?.state==='playing')frame=requestAnimationFrame(tick)}
watch(() => [props.snapshot?.currentTrack?.id,props.snapshot?.selectedZoneId,props.snapshot?.positionMs,props.snapshot?.state],()=>{
 clock.observe({id:`${props.snapshot?.selectedZoneId ?? ''}:${props.snapshot?.currentTrack?.id ?? ''}`,state:props.snapshot?.state ?? 'idle',position:props.snapshot?.positionMs ?? 0,duration:duration.value},performance.now())
 cancelAnimationFrame(frame);tick()
},{immediate:true})
onUnmounted(()=>{disposed=true;cancelAnimationFrame(frame)})
function preview(event:Event){seekToken=clock.preview(Number((event.target as HTMLInputElement).value),performance.now());position.value=clock.read(performance.now())}
function commit(event:Event){
 if(!props.allowed || duration.value<=0){clock.cancel(performance.now());return}
 const value=Number((event.target as HTMLInputElement).value)
 seekToken=clock.preview(value,performance.now())
 const token=seekToken
 emit('seek',value,confirmed=>{if(disposed)return;clock.settle(token,confirmed,performance.now());position.value=clock.read(performance.now())})
}
function cancel(){clock.cancel(performance.now());position.value=clock.read(performance.now())}
</script>
<template>
 <div class="player-timeline">
  <time>{{ formatPlaybackTime(position) }}</time>
  <input type="range" aria-label="播放栏进度" :aria-valuetext="`${formatPlaybackTime(position)} / ${formatPlaybackTime(duration)}`" :min="0" :max="Math.max(1,duration)" :step="1" :value="position" :disabled="!allowed || duration <= 0" :style="{'--progress': `${duration > 0 ? position/duration*100 : 0}%`}" @input="preview" @change="commit" @pointercancel="cancel" />
  <time>{{ formatPlaybackTime(duration) }}</time>
 </div>
</template>
