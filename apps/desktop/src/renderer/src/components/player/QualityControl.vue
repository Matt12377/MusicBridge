<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref } from 'vue'
import type { PlaybackQualityPreference } from '@music-bridge/contracts'
import SidebarIcon from '../sidebar/SidebarIcon.vue'
import QualityPopover from './QualityPopover.vue'

defineProps<{ selectedQuality: PlaybackQualityPreference }>()
const emit = defineEmits<{ 'update:selected-quality': [quality: PlaybackQualityPreference] }>()
const root = ref<HTMLElement | null>(null)
const trigger = ref<HTMLButtonElement | null>(null)
const open = ref(false)

function qualityLabel(quality: PlaybackQualityPreference): string {
  if (quality === 'auto') return '自动'
  return quality === 'hires' ? 'Hi-Res' : quality[0].toUpperCase() + quality.slice(1)
}

function close(restoreFocus = false): void {
  open.value = false
  if (restoreFocus) void nextTick(() => trigger.value?.focus())
}

function toggle(): void {
  open.value = !open.value
}

function select(quality: PlaybackQualityPreference): void {
  emit('update:selected-quality', quality)
  close(true)
}

function closeOnOutside(event: MouseEvent): void {
  if (open.value && root.value && !root.value.contains(event.target as Node)) close()
}

onMounted(() => document.addEventListener('mousedown', closeOnOutside))
onUnmounted(() => document.removeEventListener('mousedown', closeOnOutside))
</script>

<template>
  <div ref="root" class="player-quality-control">
    <button
      ref="trigger"
      type="button"
      class="player-quality-button"
      :aria-expanded="open"
      aria-haspopup="dialog"
      aria-label="选择下次播放音质"
      @click="toggle"
      @keydown.down.prevent="open = true"
      @keydown.up.prevent="open = true"
    >
      <span><small>下次音质</small><strong>{{ qualityLabel(selectedQuality) }}</strong></span>
      <SidebarIcon name="chevron-down" :size="13" />
    </button>
    <QualityPopover v-if="open" :selected-quality="selectedQuality" @select="select" @close="close(true)" />
  </div>
</template>
