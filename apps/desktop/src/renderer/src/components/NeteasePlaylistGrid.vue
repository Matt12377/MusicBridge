<script setup lang="ts">
import { computed, ref } from 'vue'
import type { PlaylistSummary } from '@music-bridge/contracts'
import SafeArtwork from './SafeArtwork.vue'
import { useGridWindow } from '../composables/useGridWindow.js'
const props = defineProps<{ playlists: readonly PlaylistSummary[]; loading?: boolean }>()
const emit = defineEmits<{ select: [playlist: PlaylistSummary] }>()
const gridRoot = ref<HTMLElement | null>(null)
const grid = useGridWindow(computed(() => props.playlists), gridRoot)
</script>
<template>
  <div v-if="loading" class="playlist-grid"><div class="empty-state"><p>读取歌单…</p></div></div>
  <div v-else-if="!playlists.length" class="playlist-grid"><div class="empty-state"><h3>还没有歌单</h3><p>歌单会在网易云可用后出现在这里。</p></div></div>
  <div v-else ref="gridRoot" class="playlist-grid" v-bind="grid.attrs.value" :style="grid.rootStyle.value" @focusin="grid.onFocusIn" @focusout="grid.onFocusOut" @keydown="grid.onKeydown">
    <button v-for="{ item: playlist, index, style } in grid.rendered.value" :key="playlist.id" :data-grid-index="index" :style="style" type="button" class="playlist-card" @click="emit('select', playlist)"><SafeArtwork class="playlist-art" :src="playlist.artworkUrl" alt="" fallback="♫" /><span><strong>{{ playlist.name }}</strong><small>{{ playlist.trackCount }} 首歌曲</small></span><b aria-hidden="true">→</b></button>
  </div>
</template>
