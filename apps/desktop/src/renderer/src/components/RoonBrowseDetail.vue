<script setup lang="ts">
import { computed } from 'vue'
import type { RoonLibraryItem, RoonLibraryPage } from '@music-bridge/contracts'
import RoonAlbumGrid from './RoonAlbumGrid.vue'
import RoonArtwork from './RoonArtwork.vue'

const props = withDefaults(defineProps<{
  entity: RoonLibraryItem
  page: RoonLibraryPage
  mode: 'genre' | 'playlist'
  initialLoading?: boolean
  loadingMore?: boolean
  loadMoreError?: string | null
  error?: string | null
}>(), {
  initialLoading: false,
  loadingMore: false,
  loadMoreError: null,
  error: null,
})

const emit = defineEmits<{
  back: []
  album: [album: RoonLibraryItem]
  play: [track: RoonLibraryItem]
  queue: [track: RoonLibraryItem]
  retry: []
  'load-more': []
}>()

const albums = computed(() => props.page.items.filter((item) => item.kind === 'album'))
const tracks = computed(() => props.page.items.filter((item) => item.kind === 'track'))
const albumPage = computed<RoonLibraryPage>(() => ({
  items: albums.value,
  offset: 0,
  limit: Math.max(1, albums.value.length),
  total: albums.value.length,
  hasMore: false,
}))

function formatDuration(durationMs: number | undefined): string {
  if (!durationMs || durationMs < 0) return '—'
  const seconds = Math.floor(durationMs / 1_000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
</script>

<template>
  <section class="view roon-browse-detail-view" :aria-labelledby="`roon-${props.mode}-heading`">
    <button type="button" class="back-link" @click="emit('back')">← {{ props.mode === 'genre' ? '流派' : 'Roon 歌单' }}</button>
    <div class="roon-album-detail-hero">
      <RoonArtwork class="roon-album-detail-art" :reference="props.entity.artworkReference" :alt="`${props.entity.title} 封面`" :width="768" :height="768" eager />
      <div class="roon-album-detail-copy">
        <p class="section-kicker">{{ props.mode === 'genre' ? 'Roon 流派' : 'Roon 歌单' }}</p>
        <h2 :id="`roon-${props.mode}-heading`">{{ props.entity.title }}</h2>
        <p class="lede">{{ props.entity.subtitle || (props.mode === 'genre' ? '真实专辑与曲目' : '真实 Roon Playlist 曲目') }}</p>
        <span class="roon-album-detail-meta">{{ props.page.total ?? props.page.items.length }} 个条目</span>
      </div>
    </div>

    <p v-if="props.error" class="persistent-error">{{ props.error }} <button type="button" class="inline-action" @click="emit('retry')">重试</button></p>
    <div v-if="props.initialLoading && !props.page.items.length" class="empty-state"><span class="loading-line"></span><p>正在读取 Roon {{ props.mode === 'genre' ? '流派内容' : '歌单曲目' }}…</p></div>
    <div v-else-if="!props.page.items.length" class="empty-state"><span class="empty-glyph" aria-hidden="true">♫</span><h3>没有可显示的内容</h3><p>Roon 没有返回可识别的专辑或曲目层级。</p></div>
    <template v-else>
      <section v-if="albums.length" class="roon-detail-section" aria-labelledby="roon-detail-albums-heading">
        <div class="search-section-heading"><h3 id="roon-detail-albums-heading">专辑</h3><span>{{ albums.length }} 张</span></div>
        <RoonAlbumGrid :page="albumPage" @select="emit('album', $event)" />
      </section>
      <section v-if="tracks.length" class="roon-detail-section" aria-labelledby="roon-detail-tracks-heading">
        <div class="search-section-heading"><h3 id="roon-detail-tracks-heading">曲目</h3><span>{{ tracks.length }} 首</span></div>
        <div class="roon-track-table" role="table" :aria-label="props.mode === 'genre' ? 'Roon 流派曲目' : 'Roon 歌单曲目'">
          <div class="roon-track-table-header" role="row"><span>#</span><span>歌曲</span><span>时长</span><span class="visually-hidden">操作</span></div>
          <div v-for="(track, index) in tracks" :key="track.reference" class="roon-track-row" role="row" tabindex="0" @dblclick="emit('play', track)" @keydown.enter="emit('play', track)">
            <span class="roon-track-index">{{ track.trackNumber ?? index + 1 }}</span>
            <span class="roon-track-copy"><strong>{{ track.title }}</strong><small>{{ track.artist || track.subtitle || track.album || '—' }}</small></span>
            <span class="roon-track-duration">{{ formatDuration(track.durationMs) }}</span>
            <span class="row-actions"><button type="button" class="row-action" :aria-label="`播放 ${track.title}`" @click.stop="emit('play', track)">▶</button><button type="button" class="row-action" :aria-label="`将 ${track.title} 加入队列`" @click.stop="emit('queue', track)">＋</button></span>
          </div>
        </div>
      </section>
    </template>

    <div v-if="props.page.hasMore" class="roon-library-more">
      <span v-if="props.loadingMore" role="status">正在加载更多…</span>
      <template v-else-if="props.loadMoreError"><span>{{ props.loadMoreError }}</span><button type="button" class="text-button" @click="emit('load-more')">重试</button></template>
      <button v-else type="button" class="text-button" @click="emit('load-more')">加载更多</button>
      <span v-if="props.page.total">已显示 {{ props.page.items.length }} / {{ props.page.total }}</span>
    </div>
  </section>
</template>
