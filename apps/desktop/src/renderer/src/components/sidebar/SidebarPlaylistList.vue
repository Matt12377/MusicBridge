<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import type { PlaylistSummary } from '@music-bridge/contracts'
import SidebarIcon from './SidebarIcon.vue'
import SidebarPlaylistRow from './SidebarPlaylistRow.vue'

defineProps<{
  playlists: readonly PlaylistSummary[]
  expanded: boolean
  activePlaylistId?: string
  state: 'loading' | 'ready' | 'error'
}>()

const emit = defineEmits<{
  select: [playlistId: string]
  retry: []
}>()

const root = ref<HTMLElement | null>(null)
const open = ref(false)

function toggle(): void {
  open.value = !open.value
}

function closeOnOutside(event: MouseEvent): void {
  if (open.value && root.value && !root.value.contains(event.target as Node)) open.value = false
}

function selectPlaylist(playlistId: string): void {
  open.value = false
  emit('select', playlistId)
}

onMounted(() => document.addEventListener('mousedown', closeOnOutside))
onUnmounted(() => document.removeEventListener('mousedown', closeOnOutside))
</script>

<template>
  <section class="sidebar-playlist-section" aria-label="歌单" :data-sidebar-playlist-state="state">
    <h2 class="sidebar-section-title">歌单</h2>
    <div v-if="state === 'loading'" class="sidebar-playlist-list" aria-label="歌单加载中" aria-busy="true">
      <span v-for="index in 4" :key="index" class="sidebar-playlist-skeleton"><i></i><b></b></span>
    </div>
    <div v-else-if="state === 'error'" class="sidebar-playlist-error" role="status">
      <span v-if="expanded">歌单暂时无法加载</span>
      <button type="button" class="sidebar-retry-button" @click="emit('retry')">重试</button>
    </div>
    <div v-else-if="playlists.length && expanded" class="sidebar-playlist-list">
      <SidebarPlaylistRow v-for="playlist in playlists" :key="playlist.id" :playlist="playlist" :expanded="expanded" :selected="activePlaylistId === playlist.id" @select="emit('select', playlist.id)" />
    </div>
    <div v-else-if="playlists.length" ref="root" class="sidebar-collapsed-playlist-control">
      <button type="button" class="sidebar-collapsed-source-button" :aria-expanded="open" aria-haspopup="dialog" aria-label="歌单" title="歌单" @click="toggle">
        <SidebarIcon name="music-note" />
      </button>
      <div v-if="open" class="sidebar-popover sidebar-playlist-popover" role="dialog" aria-label="歌单" @keydown.esc="open = false">
        <strong>歌单</strong>
        <div class="sidebar-playlist-list">
          <SidebarPlaylistRow v-for="playlist in playlists" :key="playlist.id" :playlist="playlist" :expanded="true" :selected="activePlaylistId === playlist.id" @select="selectPlaylist(playlist.id)" />
        </div>
      </div>
    </div>
    <p v-else-if="expanded" class="sidebar-empty-playlists">暂无歌单</p>
  </section>
</template>
