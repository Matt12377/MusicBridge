<script setup lang="ts">
import type { RoonLibraryItem, RoonLibraryPage } from '@music-bridge/contracts'
import RoonArtwork from './RoonArtwork.vue'

const props = withDefaults(defineProps<{
  album: RoonLibraryItem
  page: RoonLibraryPage
  initialLoading?: boolean
  loadingMore?: boolean
  loadMoreError?: string | null
  error?: string | null
  favoriteState?: 'idle' | 'loading' | 'liked' | 'not-liked' | 'error'
}>(), {
  initialLoading: false,
  loadingMore: false,
  loadMoreError: null,
  error: null,
  favoriteState: 'idle',
})

const emit = defineEmits<{
  back: []
  play: [track: RoonLibraryItem]
  queue: [track: RoonLibraryItem]
  'toggle-favorite': []
  retry: []
  'load-more': []
}>()

function formatDuration(durationMs: number | undefined): string {
  if (!durationMs || durationMs < 0) return '—'
  const seconds = Math.floor(durationMs / 1_000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
</script>

<template>
  <section class="view roon-album-detail-view" aria-labelledby="roon-album-heading">
    <button type="button" class="back-link" @click="emit('back')">← 本地音乐库</button>
    <div class="roon-album-detail-hero">
      <RoonArtwork class="roon-album-detail-art" :reference="props.album.artworkReference" :alt="`${props.album.title} 封面`" :width="768" :height="768" eager />
      <div class="roon-album-detail-copy">
        <p class="section-kicker">Roon 专辑</p>
        <h2 id="roon-album-heading">{{ props.album.title }}</h2>
        <p class="lede">{{ props.album.artist || props.album.subtitle || '本地音乐库' }}</p>
        <span class="roon-album-detail-meta">{{ props.album.year ? `${props.album.year} · ` : '' }}{{ props.page.total ?? props.page.items.length }} 首歌曲</span>
        <button type="button" class="secondary-button detail-favorite-button" :disabled="props.favoriteState === 'loading'" :aria-pressed="props.favoriteState === 'liked'" @click="emit('toggle-favorite')">{{ props.favoriteState === 'liked' ? '♥ 已收藏' : '♡ 收藏专辑' }}</button>
      </div>
    </div>

    <p v-if="props.error" class="persistent-error">{{ props.error }} <button type="button" class="inline-action" @click="emit('retry')">重试</button></p>
    <div v-if="props.initialLoading && !props.page.items.length" class="empty-state"><span class="loading-line"></span><p>正在读取专辑曲目…</p></div>
    <div v-else-if="!props.page.items.length" class="empty-state"><span class="empty-glyph" aria-hidden="true">♫</span><h3>没有可显示的曲目</h3><p>Roon 没有返回这张专辑的曲目。</p></div>
    <div v-else class="roon-track-table" role="table" aria-label="Roon 专辑曲目">
      <div class="roon-track-table-header" role="row"><span>#</span><span>歌曲</span><span>时长</span><span class="visually-hidden">操作</span></div>
      <div v-for="(track, index) in props.page.items" :key="track.reference" class="roon-track-row" role="row" tabindex="0" @dblclick="emit('play', track)" @keydown.enter="emit('play', track)">
        <span class="roon-track-index">{{ track.trackNumber ?? index + 1 }}</span>
        <span class="roon-track-copy"><strong>{{ track.title }}</strong><small>{{ track.artist || track.subtitle || props.album.artist || '—' }}</small></span>
        <span class="roon-track-duration">{{ formatDuration(track.durationMs) }}</span>
        <span class="row-actions"><button type="button" class="row-action" :aria-label="`播放 ${track.title}`" @click.stop="emit('play', track)">▶</button><button type="button" class="row-action" :aria-label="`将 ${track.title} 加入队列`" @click.stop="emit('queue', track)">＋</button></span>
      </div>
    </div>
    <div v-if="props.page.hasMore" class="roon-library-more">
      <span v-if="props.loadingMore" role="status">正在加载更多曲目…</span>
      <template v-else-if="props.loadMoreError"><span>{{ props.loadMoreError }}</span><button type="button" class="text-button" @click="emit('load-more')">重试</button></template>
      <button v-else type="button" class="text-button" @click="emit('load-more')">加载更多曲目</button>
      <span v-if="props.page.total">已显示 {{ props.page.items.length }} / {{ props.page.total }}</span>
    </div>
  </section>
</template>
