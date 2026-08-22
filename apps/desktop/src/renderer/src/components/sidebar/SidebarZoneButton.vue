<script setup lang="ts">
import type { PublicRoonZone } from '@music-bridge/contracts'
import { useZoneSelection } from '../../composables/useZoneSelection.js'
import SidebarIcon from './SidebarIcon.vue'
import ZonePopover from './ZonePopover.vue'

const props = defineProps<{
  zones: readonly PublicRoonZone[]
  selectedZone?: PublicRoonZone
  roonStatus: string
}>()

const emit = defineEmits<{
  select: [zoneId: string]
}>()

const { root, open, toggle, close, selectZone } = useZoneSelection((zoneId) => emit('select', zoneId))
</script>

<template>
  <div ref="root" class="playback-zone-control">
    <button type="button" class="playback-zone-button" :aria-expanded="open" aria-haspopup="dialog" :aria-label="selectedZone?.displayName ?? '选择播放设备'" @click="toggle">
      <SidebarIcon name="speaker" />
      <span class="playback-zone-copy"><strong>{{ selectedZone?.displayName ?? '选择播放设备' }}</strong><small>{{ roonStatus === 'disconnected' ? 'Roon 未连接' : '播放设备' }}</small></span>
      <SidebarIcon name="chevron-down" :size="14" />
    </button>
    <ZonePopover v-if="open" :zones="zones" :selected-zone="selectedZone" :roon-status="roonStatus" @select="selectZone" @close="close" />
  </div>
</template>
