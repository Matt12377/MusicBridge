<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import type { TrackSummary } from '@music-bridge/contracts'

const props = withDefaults(defineProps<{
  tracks: readonly TrackSummary[]
  busy?: boolean
  total?: number
  hasMore?: boolean
  emptyTitle?: string
  emptyCopy?: string
  emptyGlyph?: string
}>(), {
  busy: false,
  total: 0,
  hasMore: false,
  emptyTitle: '没有歌曲',
  emptyCopy: '歌曲会在内容可用后显示在这里。',
  emptyGlyph: '♫',
})

const emit = defineEmits<{
  play: [track: TrackSummary]
  queue: [track: TrackSummary]
  'play-next': [track: TrackSummary]
  'load-more': []
}>()

const contextTrack = ref<TrackSummary | null>(null)
const contextPosition = ref({ x: 0, y: 0 })

function formatDuration(durationMs: number | undefined): string {
  if (!durationMs || durationMs < 0) return '—'
  const seconds = Math.floor(durationMs / 1_000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function hideBrokenArtwork(event: Event): void {
  const image = event.currentTarget as HTMLImageElement
  image.hidden = true
}

function showContextMenu(event: MouseEvent, track: TrackSummary): void {
  event.preventDefault()
  contextTrack.value = track
  contextPosition.value = {
    x: Math.min(event.clientX, window.innerWidth - 190),
    y: Math.min(event.clientY, window.innerHeight - 150),
  }
}

function closeContextMenu(): void {
  contextTrack.value = null
}

function playFromContext(): void {
  if (!contextTrack.value) return
  emit('play', contextTrack.value)
  closeContextMenu()
}

function queueFromContext(): void {
  if (!contextTrack.value) return
  emit('queue', contextTrack.value)
  closeContextMenu()
}

function playNextFromContext(): void {
  if (!contextTrack.value) return
  emit('play-next', contextTrack.value)
  closeContextMenu()
}

onMounted(() => document.addEventListener('click', closeContextMenu))
onUnmounted(() => document.removeEventListener('click', closeContextMenu))
</script>

<template>
  <div class="track-table-wrap">
    <div v-if="props.busy" class="empty-state track-table-state"><span class="loading-line"></span><p>正在读取歌曲…</p></div>
    <div v-else-if="!props.tracks.length" class="empty-state track-table-state">
      <span class="empty-glyph" aria-hidden="true">{{ props.emptyGlyph }}</span>
      <h3>{{ props.emptyTitle }}</h3>
      <p>{{ props.emptyCopy }}</p>
    </div>
    <div v-else class="track-table" role="table" aria-label="歌曲列表">
      <div class="track-table-header" role="row">
        <span>#</span><span>歌曲</span><span>专辑</span><span>时长</span><span class="visually-hidden">操作</span>
      </div>
      <div
        v-for="(track, index) in props.tracks"
        :key="track.id"
        class="track-row"
        role="row"
        tabindex="0"
        @dblclick="emit('play', track)"
        @keydown.enter="emit('play', track)"
        @contextmenu="showContextMenu($event, track)"
      >
        <span class="track-index" aria-hidden="true"><span class="track-number">{{ index + 1 }}</span><span class="track-play-mark">▶</span></span>
        <span class="track-art"><span class="artwork-fallback" aria-hidden="true">♪</span><img v-if="track.artworkUrl" :src="track.artworkUrl" :alt="`${track.title} 封面`" loading="lazy" @error="hideBrokenArtwork" /></span>
        <span class="track-copy"><strong>{{ track.title }}</strong><small>{{ track.artists.join('、') }}</small></span>
        <span class="track-album">{{ track.album }}</span>
        <span class="track-duration">{{ formatDuration(track.durationMs) }}</span>
        <span class="row-actions">
          <button type="button" class="row-action" :aria-label="`播放 ${track.title}`" @click.stop="emit('play', track)">▶</button>
          <button type="button" class="row-action row-action-more" :aria-label="`打开 ${track.title} 的更多操作`" @click.stop="showContextMenu($event, track)">•••</button>
        </span>
      </div>
    </div>

    <div v-if="props.hasMore" class="track-table-more">
      <button type="button" class="text-button" :disabled="props.busy" @click="emit('load-more')">加载更多歌曲</button>
      <span v-if="props.total">已显示 {{ props.tracks.length }} / {{ props.total }}</span>
    </div>

    <div
      v-if="contextTrack"
      class="track-context-menu"
      role="menu"
      aria-label="歌曲操作"
      :style="{ left: `${contextPosition.x}px`, top: `${contextPosition.y}px` }"
      @click.stop
    >
      <strong>{{ contextTrack.title }}</strong>
      <button type="button" role="menuitem" @click="playFromContext">播放</button>
      <button type="button" role="menuitem" @click="playNextFromContext">下一首播放</button>
      <button type="button" role="menuitem" @click="queueFromContext">加入队列</button>
    </div>
  </div>
</template>
