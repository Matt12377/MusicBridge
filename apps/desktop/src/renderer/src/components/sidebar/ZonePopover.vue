<script setup lang="ts">
import type { PublicRoonZone } from '@music-bridge/contracts'
import SidebarIcon from './SidebarIcon.vue'
import { zoneLifecycleLabel, type ZoneLifecycleStatus } from '../../zone-lifecycle.js'

defineProps<{
  zones: readonly PublicRoonZone[]
  selectedZone?: PublicRoonZone
  roonStatus: string
  zoneStatus: ZoneLifecycleStatus
}>()

const emit = defineEmits<{
  select: [zoneId: string]
  close: []
}>()

function roonLabel(status: string): string {
  if (status === 'disconnected') return 'Roon 未连接'
  if (status === 'ready' || status === 'paired') return 'Roon 已连接'
  return 'Roon 连接中'
}
</script>

<template>
  <div class="sidebar-popover zone-popover" role="dialog" aria-label="播放设备" @keydown.esc="emit('close')">
    <div class="popover-heading"><strong>播放设备</strong><button type="button" class="popover-close" aria-label="关闭播放设备" @click="emit('close')">×</button></div>
    <p v-if="zoneStatus === 'loading'" class="popover-empty">{{ zoneLifecycleLabel(zoneStatus) }}</p>
    <div v-else-if="zones.length" class="zone-list">
      <button v-for="zone in zones" :key="zone.zoneId" type="button" class="zone-option" :class="{ selected: zone.selected || zone.zoneId === selectedZone?.zoneId }" @click="emit('select', zone.zoneId)">
        <span><SidebarIcon name="speaker" :size="15" />{{ zone.displayName }}</span>
        <span v-if="zone.selected || zone.zoneId === selectedZone?.zoneId" class="zone-check" aria-label="当前播放设备">✓</span>
      </button>
    </div>
    <p v-else class="popover-empty">{{ zoneLifecycleLabel(zoneStatus) }}</p>
    <div class="popover-divider"></div>
    <p class="popover-status"><i class="status-led" :class="roonStatus"></i>{{ roonLabel(roonStatus) }}</p>
  </div>
</template>
