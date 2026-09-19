<script setup lang="ts">
import type { TrackSummary } from '@music-bridge/contracts'
import TrackArtwork from './TrackArtwork.vue'
defineProps<{ tracks: readonly TrackSummary[]; busy: boolean }>()
const emit = defineEmits<{ play: [track: TrackSummary]; queue: [track: TrackSummary]; 'play-next': [track: TrackSummary] }>()
</script>

<template>
  <div class="search-song-preview" aria-label="单曲预览，最多六首">
    <div v-for="track in tracks.slice(0, 6)" :key="track.id" class="search-song">
      <button type="button" class="search-song-main" :disabled="busy" :aria-label="`播放 ${track.title} · ${track.artists.join('、')}`" @click="emit('play', track)">
        <TrackArtwork class="search-song-art" :track="track" :alt="`${track.title} 封面`" />
        <span class="search-song-copy"><strong>{{ track.title }}</strong><span>{{ track.artists.join(' / ') }}</span><small>{{ track.album }}</small></span>
      </button>
      <details class="search-song-menu">
        <summary :aria-label="`${track.title} 的更多操作`"><i class="bi bi-three-dots" aria-hidden="true"></i></summary>
        <div><button type="button" @click="emit('play-next', track)">下一首播放</button><button type="button" @click="emit('queue', track)">加入队列</button></div>
      </details>
    </div>
  </div>
</template>

<style scoped>
.search-song-preview { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px 28px; padding: 4px 0 0; }
.search-song { display: flex; align-items: center; min-width: 0; position: relative; border-radius: 12px; }
.search-song:hover { background: rgba(255,255,255,.05); }
.search-song-main { display: flex; align-items: center; gap: 14px; flex: 1; min-width: 0; padding: 0; border: 0; background: transparent; text-align: left; color: inherit; cursor: pointer; }
.search-song-art { width: 72px; height: 72px; flex-shrink: 0; border-radius: 10px; overflow: hidden; }
.search-song-art :deep(img) { width: 100%; height: 100%; object-fit: cover; }
.search-song-copy { display: grid; gap: 5px; min-width: 0; }
.search-song-copy > * { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.search-song-copy strong { font-size: 16px; }
.search-song-copy span, .search-song-copy small { color: var(--mb-text-secondary); }
.search-song-menu summary { list-style: none; cursor: pointer; padding: 12px; }
.search-song-menu summary::-webkit-details-marker { display: none; }
.search-song-menu > div { position: absolute; right: 0; top: 64px; z-index: 4; display: grid; padding: 6px; border-radius: 10px; background: var(--mb-bg-panel, #30303a); box-shadow: 0 4px 18px #0003; }
.search-song-menu button { padding: 10px 16px; color: inherit; background: transparent; border: 0; text-align: left; cursor: pointer; white-space: nowrap; }
@media (max-width: 950px) { .search-song-preview { gap: 18px; } .search-song-art { width: 76px; height: 76px; } .search-song-main { gap: 12px; } }
@media (max-width: 700px) { .search-song-preview { grid-template-columns: minmax(0, 1fr); } }
</style>
