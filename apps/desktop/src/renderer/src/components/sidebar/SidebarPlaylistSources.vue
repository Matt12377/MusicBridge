<script setup lang="ts">
import type { SidebarSource } from '../navigation.js'
import SidebarNavRow from './SidebarNavRow.vue'

defineProps<{ activeSource?: SidebarSource }>()
const emit = defineEmits<{ navigate: [source: SidebarSource] }>()
</script>

<template>
  <div class="sidebar-playlist-sources">
    <SidebarNavRow source="roon-playlists" label="Roon 歌单" icon="music-list" :expanded="true" :selected="activeSource?.type === 'roon-playlists' || activeSource?.type === 'roon-playlist'" @select="emit('navigate', { type: 'roon-playlists' })" />
    <SidebarNavRow source="playlists" label="网易云歌单" icon="music-note" :expanded="true" :selected="activeSource?.type === 'playlists'" @select="emit('navigate', { type: 'playlists' })" />
  </div>
</template>
