<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue'
import type { VolumeOutput, VolumeSnapshot } from '@music-bridge/contracts'
import SidebarIcon from '../sidebar/SidebarIcon.vue'
import { createLiveVolume } from './liveVolume.js'
const props = defineProps<{zoneId?: string}>()
const open = ref(false), pending = ref(false)
const root = ref<HTMLElement | null>(null), trigger = ref<HTMLButtonElement | null>(null)
const state = ref<VolumeSnapshot>({zoneId:'',outputs:[]})
const values=ref<Record<string,number>>({})
const controllers=new Map<string,ReturnType<typeof createLiveVolume>>()
const error = ref('')
let generation = 0, readRevision=0
let timer: ReturnType<typeof setInterval> | undefined
function reset(){generation++;readRevision++;controllers.forEach(c=>c.dispose());controllers.clear();values.value={};state.value={zoneId:'',outputs:[]};pending.value=false}
async function refresh() {
 const current = generation, read=++readRevision
 if (!props.zoneId) return
 try {
  const result = await window.musicBridge.getVolume()
  if(current!==generation || read!==readRevision || result.zoneId!==props.zoneId)return
  state.value=result
  for(const output of result.outputs){
   if(output.value===undefined || output.type==='incremental')continue
   let controller=controllers.get(output.outputId)
   if(!controller){
    const zoneId=result.zoneId, outputId=output.outputId
    values.value[outputId]=output.value
    controller=createLiveVolume({initial:output.value,step:output.step ?? 1,now:()=>performance.now(),schedule:(fn,ms)=>window.setTimeout(fn,ms),cancel:id=>clearTimeout(id),
     send:value=>window.musicBridge.setVolume({zoneId,outputId,how:'absolute',value}),
     show:value=>{values.value[outputId]=value},error:()=>{error.value='设备未确认音量，已恢复设备读数'}
    })
    controllers.set(outputId,controller)
   }
   controller.observe(output.value)
  }
  for(const [id,c] of controllers)if(!result.outputs.some(o=>o.outputId===id)){c.dispose();controllers.delete(id);delete values.value[id]}
 } catch { if (current === generation) error.value = '暂时无法读取设备音量' }
}
watch(() => props.zoneId,()=>{reset();error.value='';if(!props.zoneId)open.value=false;else if(open.value)void refresh()})
watch(open,()=>{
 if(timer)clearInterval(timer)
 if(open.value){error.value='';void refresh();timer=setInterval(()=>void refresh(),500)}
 else controllers.forEach(c=>c.commit())
})
function preview(output:VolumeOutput,event:Event){error.value='';controllers.get(output.outputId)?.input(Number((event.target as HTMLInputElement).value))}
function commit(output:VolumeOutput){controllers.get(output.outputId)?.commit()}
async function change(output:VolumeOutput,value:number){
 if(!props.zoneId || state.value.zoneId!==props.zoneId || pending.value)return
 const current=generation
 pending.value=true;error.value=''
 try {await window.musicBridge.setVolume({zoneId:props.zoneId,outputId:output.outputId,how:'relative',value})}
 catch {if(current===generation)error.value='音量未调节成功，请检查设备连接'}
 finally {if(current===generation){pending.value=false;void refresh()}}
}
function close() { open.value = false; trigger.value?.focus() }
function outside(e: MouseEvent) { if (e.target instanceof Node && !root.value?.contains(e.target)) open.value = false }
onMounted(() => document.addEventListener('click',outside))
onUnmounted(() => { reset(); if (timer) clearInterval(timer); document.removeEventListener('click',outside) })
</script>
<template>
 <div ref="root" class="player-volume" @keydown.esc.stop="close">
  <button ref="trigger" type="button" class="player-inspector-button" aria-label="调节音量" aria-haspopup="dialog" :aria-expanded="open" :disabled="!zoneId" @click="open = !open"><SidebarIcon name="volume" :size="20" /></button>
  <div v-if="open" class="player-volume-panel" role="dialog" aria-label="播放设备音量">
   <strong>播放设备音量</strong>
   <p v-if="error" role="status">{{ error }}</p>
   <p v-else-if="!state.zoneId">正在读取…</p>
   <p v-else-if="!state.outputs.length">此设备未提供音量控制，请在设备上调节。</p>
   <div v-for="output in state.outputs" :key="output.outputId" class="volume-output">
    <span>{{ output.name }}</span>
    <div v-if="output.type === 'incremental'" class="volume-step-controls"><button :disabled="pending" :aria-label="`降低 ${output.name} 音量`" @click="change(output,-1)">−</button><button :disabled="pending" :aria-label="`提高 ${output.name} 音量`" @click="change(output,1)">＋</button></div>
    <template v-else><input type="range" :aria-label="`${output.name} 音量`" :min="output.min" :max="output.max" :step="output.step" :value="values[output.outputId] ?? output.value" @input="preview(output,$event)" @pointercancel="commit(output)" @blur="commit(output)" @change="commit(output)" /><small>{{ output.muted ? '已静音 · ' : '' }}{{ values[output.outputId] ?? output.value }}{{ output.type === 'db' ? ' dB' : '' }}</small></template>
   </div>
   <button type="button" class="text-button" @click="close">关闭</button>
  </div>
 </div>
</template>
