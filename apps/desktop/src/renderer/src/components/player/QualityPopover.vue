<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import { PLAYBACK_QUALITY_PREFERENCES, type PlaybackQualityPreference } from '@music-bridge/contracts'

const props = defineProps<{ selectedQuality: PlaybackQualityPreference }>()
const emit = defineEmits<{ select: [quality: PlaybackQualityPreference]; close: [] }>()
const options = ref<HTMLElement[]>([])

function qualityLabel(quality: PlaybackQualityPreference): string {
  if (quality === 'auto') return '自动'
  return quality === 'hires' ? 'Hi-Res' : quality[0].toUpperCase() + quality.slice(1)
}

function qualityDescription(quality: PlaybackQualityPreference): string {
  if (quality === 'auto') return '按来源自动选择'
  if (quality === 'hires') return '优先最高解析度'
  return `优先 ${qualityLabel(quality)} 档位`
}

function setOption(element: unknown, index: number): void {
  if (element instanceof HTMLElement) options.value[index] = element
}

function moveFocus(delta: number): void {
  const current = options.value.indexOf(document.activeElement as HTMLElement)
  const next = (Math.max(0, current) + delta + options.value.length) % options.value.length
  options.value[next]?.focus()
}

onMounted(() => void nextTick(() => {
  const selectedIndex = PLAYBACK_QUALITY_PREFERENCES.indexOf(props.selectedQuality)
  options.value[Math.max(0, selectedIndex)]?.focus()
}))
</script>

<template>
  <div class="sidebar-popover zone-popover quality-popover" role="dialog" aria-label="下次播放音质" @keydown.esc.prevent="emit('close')" @keydown.down.prevent="moveFocus(1)" @keydown.up.prevent="moveFocus(-1)" @keydown.home.prevent="options[0]?.focus()" @keydown.end.prevent="options.at(-1)?.focus()">
    <div class="popover-heading"><strong>下次播放音质</strong><button type="button" class="popover-close" aria-label="关闭音质选择" @click="emit('close')">×</button></div>
    <div class="zone-list" role="listbox" aria-label="可选音质">
      <button
        v-for="(quality, index) in PLAYBACK_QUALITY_PREFERENCES"
        :ref="(element) => setOption(element, index)"
        :key="quality"
        type="button"
        class="zone-option quality-option"
        role="option"
        :aria-selected="quality === props.selectedQuality"
        :class="{ selected: quality === props.selectedQuality }"
        @click="emit('select', quality)"
      ><span><span><strong>{{ qualityLabel(quality) }}</strong><small>{{ qualityDescription(quality) }}</small></span></span><span v-if="quality === props.selectedQuality" class="zone-check" aria-hidden="true">✓</span></button>
    </div>
  </div>
</template>
