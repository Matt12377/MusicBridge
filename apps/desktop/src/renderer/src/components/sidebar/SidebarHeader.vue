<script setup lang="ts">
defineProps<{
  expanded: boolean
}>()

const emit = defineEmits<{
  toggle: []
}>()
</script>

<template>
  <header class="sidebar-header">
    <span class="sidebar-brand" :title="expanded ? 'Music Bridge' : '展开侧栏'">
      <strong v-if="expanded">Music Bridge</strong>
      <strong v-else aria-hidden="true">MB</strong>
    </span>
    <button type="button" class="sidebar-collapse-button" :aria-label="expanded ? '收起侧栏' : '展开侧栏'" :title="expanded ? '收起侧栏 (⌘\\)' : '展开侧栏 (⌘\\)'" @click="emit('toggle')">
      <span v-if="expanded" class="sidebar-brand-mark" aria-hidden="true">MB</span>
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path v-if="expanded" d="m15 6-6 6 6 6" />
        <path v-else d="m9 6 6 6-6 6" />
      </svg>
    </button>
  </header>
</template>
