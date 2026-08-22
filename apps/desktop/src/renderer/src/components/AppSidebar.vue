<script setup lang="ts">
import type { NavigationItem, ViewId } from './navigation.js'

defineProps<{
  items: readonly NavigationItem[]
  currentView: ViewId
  runtime?: string
}>()

const emit = defineEmits<{
  navigate: [view: Exclude<ViewId, 'playlist-detail'>]
}>()

function isSelected(item: NavigationItem, currentView: ViewId): boolean {
  return currentView === item.id || (item.id === 'library' && currentView === 'playlist-detail')
}
</script>

<template>
  <aside class="sidebar" aria-label="主导航">
    <div class="brand-lockup">
      <span class="brand-mark" aria-hidden="true">MB</span>
      <div>
        <strong>Music Bridge</strong>
        <span>for Roon</span>
      </div>
    </div>

    <nav class="primary-nav" aria-label="应用视图">
      <button
        v-for="item in items"
        :key="item.id"
        type="button"
        class="nav-item"
        :class="{ selected: isSelected(item, currentView) }"
        :aria-current="isSelected(item, currentView) ? 'page' : undefined"
        @click="emit('navigate', item.id)"
      >
        <span class="nav-icon" aria-hidden="true">{{ item.label.slice(0, 1) }}</span>
        <span><strong>{{ item.label }}</strong><small>{{ item.hint }}</small></span>
      </button>
    </nav>

    <div class="sidebar-footer">
      <div class="mini-status"><span class="status-led" :class="runtime"></span><span>Bridge {{ runtime ?? 'starting' }}</span></div>
      <button type="button" class="support-link" @click="emit('navigate', 'diagnostics')">运行状态</button>
    </div>
  </aside>
</template>
