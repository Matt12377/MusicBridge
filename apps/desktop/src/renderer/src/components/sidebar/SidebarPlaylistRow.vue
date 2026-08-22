<script setup lang="ts">
import { computed } from 'vue'
import type { PlaylistSummary } from '@music-bridge/contracts'

const emit = defineEmits<{
  select: []
}>()

const props = defineProps<{
  playlist: PlaylistSummary
  expanded: boolean
  selected: boolean
}>()

function hashName(value: string): number {
  return [...value].reduce((hash, character) => ((hash << 5) - hash + character.charCodeAt(0)) | 0, 0)
}

const fallbackGradient = computed(() => {
  const hue = Math.abs(hashName(props.playlist.name)) % 360
  return `linear-gradient(135deg, hsl(${hue} 52% 38%), hsl(${(hue + 48) % 360} 58% 22%))`
})
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
