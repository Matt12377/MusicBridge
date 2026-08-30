<script setup lang="ts">
import type { SidebarSource } from '../navigation.js'
import SidebarIcon from './SidebarIcon.vue'

defineProps<{
  source: Exclude<SidebarSource['type'], 'playlist'>
  label: string
  icon: 'grid' | 'heart' | 'home' | 'music-note' | 'cassette' | 'record'
  expanded: boolean
  selected: boolean
}>()

const emit = defineEmits<{
  select: []
}>()
</script>

<template>
  <button type="button" class="sidebar-nav-row" :class="{ selected }" :data-sidebar-source="source" :aria-current="selected ? 'page' : undefined" :aria-label="label" :title="expanded ? undefined : label" @click="emit('select')">
    <SidebarIcon :name="icon" />
    <span v-if="expanded" class="sidebar-row-label">{{ label }}</span>
  </button>
</template>
