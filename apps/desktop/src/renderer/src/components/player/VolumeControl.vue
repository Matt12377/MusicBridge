<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue'
import type { VolumeOutput, VolumeSnapshot } from '@music-bridge/contracts'
import SidebarIcon from '../sidebar/SidebarIcon.vue'
const props = defineProps<{zoneId?: string}>()
const open = ref(false), pending = ref(false), editing = ref(false)
const root = ref<HTMLElement | null>(null), trigger = ref<HTMLButtonElement | null>(null)
const state = ref<VolumeSnapshot>({zoneId:'',outputs:[]})
const error = ref('')
let generation = 0
let timer: ReturnType<typeof setInterval> | undefined
async function refresh() {
 const current = generation
 if (!props.zoneId || pending.value || editing.value) return
 try {
  const result = await window.musicBridge.getVolume()
  if (current === generation && !pending.value && !editing.value && result.zoneId === props.zoneId) state.value = result
 } catch { if (current === generation) error.value = '暂时无法读取设备音量' }
}
watch(() => [open.value, props.zoneId], () => {
 generation++; state.value = {zoneId:'',outputs:[]}; error.value = ''; pending.value = false; editing.value = false
 if (timer) clearInterval(timer)
 if (open.value) { void refresh(); timer = setInterval(() => void refresh(), 1500) }
})
async function change(output: VolumeOutput, value: number) {
 editing.value = false
 if (!props.zoneId || state.value.zoneId !== props.zoneId || pending.value) return
 const current = ++generation
 pending.value = true; error.value = ''
 try {
  const result = await window.musicBridge.setVolume({zoneId:props.zoneId,outputId:output.outputId,how:output.type === 'incremental' ? 'relative' : 'absolute',value})
  if (current === generation && result.zoneId === props.zoneId) state.value = result
 } catch { if (current === generation) error.value = '音量未调节成功，请检查设备连接' }
 finally { if (current === generation) { pending.value = false; void refresh() } }
}
function close() { open.value = false; trigger.value?.focus() }
function outside(e: MouseEvent) { if (e.target instanceof Node && !root.value?.contains(e.target)) open.value = false }
onMounted(() => document.addEventListener('click',outside))
onUnmounted(() => { generation++; if (timer) clearInterval(timer); document.removeEventListener('click',outside) })
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
    <template v-else><input type="range" :aria-label="`${output.name} 音量`" :min="output.min" :max="output.max" :step="output.step" :value="output.value" :disabled="pending" @input="editing = true" @pointercancel="editing = false" @blur="editing = false" @change="change(output,Number(($event.target as HTMLInputElement).value))" /><small>{{ output.muted ? '已静音 · ' : '' }}{{ output.value }}{{ output.type === 'db' ? ' dB' : '' }}</small></template>
   </div>
   <button type="button" class="text-button" @click="close">关闭</button>
  </div>
 </div>
</template>
