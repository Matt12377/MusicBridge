<script setup lang="ts">
import type { RecordingChainStep } from '@music-bridge/contracts'
const props = withDefaults(defineProps<{ modelValue: readonly RecordingChainStep[]; disabled?: boolean; prefix?: string }>(), { prefix: '' })
const emit = defineEmits<{ 'update:modelValue': [value: RecordingChainStep[]] }>()
const kinds: Record<RecordingChainStep['kind'], string> = { 'audio-interface': '声卡', dac: 'DAC', 'digital-output': '数字输出', 'cassette-deck': '磁带机', 'dat-recorder': 'DAT 录音机', connection: '连接' }
function patch(index: number, event: Event, field: 'label' | 'kind'): void { const value = (event.target as HTMLInputElement).value; emit('update:modelValue', props.modelValue.map((step,i) => i === index ? { ...step, [field]: value } as RecordingChainStep : step)) }
function move(index: number, delta: number): void { const list = [...props.modelValue], target = index + delta; if (target < 0 || target >= list.length) return; [list[index],list[target]] = [list[target]!,list[index]!]; emit('update:modelValue', list) }
function add(): void { emit('update:modelValue', [...props.modelValue, { id: crypto.randomUUID(), kind: 'connection', label: '' }]) }
</script>
<template>
  <div class="chain-editor">
    <ol><li v-for="(step,i) in modelValue" :key="step.id">
      <span class="position">{{ i + 1 }}</span>
      <label>类型<select :value="step.kind" :disabled="disabled" :aria-label="`${prefix}链路类型 ${i + 1}`" @change="patch(i,$event,'kind')"><option v-for="(label,kind) in kinds" :key="kind" :value="kind">{{ label }}</option></select></label>
      <label>设备或连接<input :value="step.label" :aria-label="`${prefix}设备或连接 ${i + 1}`" maxlength="240" :disabled="disabled" @input="patch(i,$event,'label')"></label>
      <div class="actions"><button type="button" :disabled="disabled || i === 0" :aria-label="`${prefix}上移链路 ${i + 1}`" @click="move(i,-1)">上移</button><button type="button" :disabled="disabled || i === modelValue.length - 1" :aria-label="`${prefix}下移链路 ${i + 1}`" @click="move(i,1)">下移</button><button type="button" :disabled="disabled || modelValue.length === 1" :aria-label="`${prefix}移除链路 ${i + 1}`" @click="emit('update:modelValue',modelValue.filter((_,n) => n !== i))">移除</button></div>
    </li></ol>
    <button type="button" :disabled="disabled || modelValue.length >= 16" @click="add">添加设备或连接</button>
  </div>
</template>
<style scoped>
ol{list-style:none;margin:12px 0;padding:0}li{display:grid;grid-template-columns:24px minmax(110px,1fr) minmax(160px,2fr);gap:10px;padding:14px 0;border-bottom:1px solid var(--mb-glass-border)}.position{padding-top:32px;color:var(--mb-text-secondary);font-variant-numeric:tabular-nums}.actions{grid-column:2/-1;display:flex;flex-wrap:wrap;gap:8px}label{display:grid;gap:7px;font-size:13px}input,select,button{min-height:44px;border:1px solid var(--mb-glass-border);border-radius:8px;background:var(--mb-bg-base);color:var(--mb-text-primary);padding:8px 10px;box-sizing:border-box;font:inherit;min-width:0}button{cursor:pointer;font-size:12px}button:disabled{opacity:.5;cursor:not-allowed}:focus-visible{outline:2px solid var(--mb-accent);outline-offset:3px}@media(max-width:600px){li{grid-template-columns:20px minmax(0,1fr)}li>label:nth-of-type(2){grid-column:2}input,select{width:100%}}
</style>
