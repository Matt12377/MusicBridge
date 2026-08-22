<script setup lang="ts">
import type { PlaylistSummary } from '@music-bridge/contracts'

const emit = defineEmits<{
  select: []
}>()

const props = defineProps<{
  playlist: PlaylistSummary
  expanded: boolean
  selected: boolean
}>()

const fallbackGradient = 'linear-gradient(135deg, hsl(0 0% 42%), hsl(0 0% 20%))'
</script>

<template>
  <button type="button" class="sidebar-playlist-row" :class="{ selected }" :data-playlist-id="playlist.id" :aria-current="selected ? 'page' : undefined" :aria-label="playlist.name" :title="expanded ? `${playlist.name} · ${playlist.trackCount} 首歌曲` : playlist.name" @click="emit('select')">
    <span class="sidebar-playlist-art" :style="{ background: playlist.artworkUrl ? undefined : fallbackGradient }">
      <img v-if="playlist.artworkUrl" :src="playlist.artworkUrl" alt="" loading="lazy" />
      <span v-else class="sidebar-playlist-art-fallback" aria-hidden="true"></span>
    </span>
    <span v-if="expanded" class="sidebar-playlist-name">{{ playlist.name }}</span>
  </button>
</template>
