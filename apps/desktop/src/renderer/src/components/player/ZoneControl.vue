<script setup lang="ts">
import type { PublicRoonZone } from '@music-bridge/contracts'
import { useZoneSelection } from '../../composables/useZoneSelection.js'
import SidebarIcon from '../sidebar/SidebarIcon.vue'
import ZonePopover from '../sidebar/ZonePopover.vue'
import { zoneLifecycleLabel, type ZoneLifecycleStatus } from '../../zone-lifecycle.js'

const props = defineProps<{
  zones: readonly PublicRoonZone[]
  selectedZone?: PublicRoonZone
  roonStatus: string
  zoneStatus: ZoneLifecycleStatus
}>()

const emit = defineEmits<{
  select: [zoneId: string]
}>()

const { root, open, toggle, close, selectZone } = useZoneSelection((zoneId) => emit('select', zoneId))
</script>

<template>
  <div ref="root" class="player-zone-control">
    <button
      type="button"
      class="player-zone-button"
      :aria-expanded="open"
      aria-haspopup="dialog"
      :aria-label="selectedZone?.displayName ?? '选择播放设备'"
      @click="toggle"
    >
      <SidebarIcon name="speaker" :size="15" />
      <span><strong>{{ selectedZone?.displayName ?? '选择播放设备' }}</strong><small>{{ zoneLifecycleLabel(zoneStatus) }}</small></span>
      <SidebarIcon name="chevron-down" :size="13" />
    </button>
    <ZonePopover v-if="open" :zones="props.zones" :selected-zone="props.selectedZone" :roon-status="props.roonStatus" :zone-status="props.zoneStatus" @select="selectZone" @close="close" />
  </div>
</template>
