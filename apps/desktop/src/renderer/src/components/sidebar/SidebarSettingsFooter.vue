<script setup lang="ts">
import SidebarIcon from './SidebarIcon.vue'

const props = defineProps<{
  expanded: boolean
  active: boolean
}>()

const emit = defineEmits<{
  open: []
}>()
</script>

<template>
  <footer class="sidebar-settings-footer" :class="{ 'is-collapsed': !props.expanded }">
    <button
      type="button"
      class="sidebar-settings-button"
      aria-label="打开设置"
      title="设置"
      :aria-current="props.active ? 'page' : undefined"
      @click="emit('open')"
    >
      <SidebarIcon name="settings" :size="18" />
      <span v-if="props.expanded" class="sidebar-settings-label">设置</span>
      <SidebarIcon v-if="props.expanded" name="chevron-right" :size="14" />
    </button>
  </footer>
</template>
