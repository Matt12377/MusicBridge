<script setup lang="ts">
import type { PublicRoonZone } from '@music-bridge/contracts'
import SidebarIcon from './SidebarIcon.vue'

defineProps<{
  zones: readonly PublicRoonZone[]
  selectedZone?: PublicRoonZone
  roonStatus: string
}>()

const emit = defineEmits<{
  select: [zoneId: string]
  close: []
}>()
</script>

<template>
  <div class="sidebar-popover zone-popover" role="dialog" aria-label="播放设备" @keydown.esc="emit('close')">
    <div class="popover-heading"><strong>播放设备</strong><button type="button" class="popover-close" aria-label="关闭播放设备" @click="emit('close')">×</button></div>
    <div v-if="zones.length" class="zone-list">
      <button v-for="zone in zones" :key="zone.zoneId" type="button" class="zone-option" :class="{ selected: zone.selected || zone.zoneId === selectedZone?.zoneId }" @click="emit('select', zone.zoneId)">
        <span><SidebarIcon name="speaker" :size="15" />{{ zone.displayName }}</span>
        <span v-if="zone.selected || zone.zoneId === selectedZone?.zoneId" class="zone-check" aria-label="当前播放设备">✓</span>
      </button>
    </div>
    <p v-else class="popover-empty">暂无可用播放设备</p>
    <div class="popover-divider"></div>
    <p class="popover-status"><i class="status-led" :class="roonStatus"></i>{{ roonStatus === 'disconnected' ? 'Roon 未连接' : 'Roon 已连接' }}</p>
  </div>
</template>
