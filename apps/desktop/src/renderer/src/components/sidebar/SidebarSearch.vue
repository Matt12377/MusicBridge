<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref } from 'vue'

defineProps<{
  modelValue: string
  expanded: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'clear-search': []
  expand: []
}>()

const input = ref<HTMLInputElement | null>(null)

function focusInput(): void {
  emit('expand')
  void nextTick(() => input.value?.focus())
}

function onGlobalKeydown(event: KeyboardEvent): void {
  if (event.metaKey && !event.shiftKey && event.key.toLowerCase() === 'l') {
    event.preventDefault()
    focusInput()
  }
}

function onInput(value: string): void {
  emit('update:modelValue', value)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  event.preventDefault()
  if (input.value?.value) emit('clear-search')
  input.value?.blur()
}

onMounted(() => window.addEventListener('keydown', onGlobalKeydown))
onUnmounted(() => window.removeEventListener('keydown', onGlobalKeydown))
</script>

<template>
  <div class="sidebar-search" :class="{ 'is-collapsed': !expanded }">
    <button v-if="!expanded" type="button" class="sidebar-search-collapsed" aria-label="搜索音乐 (⌘L)" title="搜索音乐 (⌘L)" @click="focusInput">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10.8" cy="10.8" r="7.2" /><path d="m20 20-4.3-4.3" /></svg>
    </button>
    <label v-else class="sidebar-search-field">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10.8" cy="10.8" r="7.2" /><path d="m20 20-4.3-4.3" /></svg>
      <span class="visually-hidden">搜索歌曲或歌手</span>
      <input ref="input" :value="modelValue" type="search" maxlength="100" placeholder="搜索歌曲或歌手" aria-label="搜索歌曲或歌手" @input="onInput(($event.target as HTMLInputElement).value)" @keydown="onKeydown" />
      <kbd aria-hidden="true">⌘L</kbd>
    </label>
  </div>
</template>
