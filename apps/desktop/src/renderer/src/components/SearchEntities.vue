<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { AlbumSummary, ArtistSummary, RoonLibraryItem } from '@music-bridge/contracts'
import { groupSearchArtists, mixSearchAlbums } from '../composables/search-entities'
import SafeArtwork from './SafeArtwork.vue'
import RoonArtwork from './RoonArtwork.vue'

const props = defineProps<{
  mode: 'all' | 'albums' | 'artists'
  artists: readonly ArtistSummary[]
  albums: readonly AlbumSummary[]
  roonArtists: readonly RoonLibraryItem[]
  roonAlbums: readonly RoonLibraryItem[]
  artistsLoading: boolean
  albumsLoading: boolean
  roonLoading: boolean
  artistsError: string | null
  albumsError: string | null
  roonError: string | null
  moreRoonAlbums: boolean
  moreRoonArtists: boolean
  moreAlbums: boolean
  moreArtists: boolean
}>()
const emit = defineEmits<{
  category: [category: 'albums' | 'artists']
  artist: [artist: ArtistSummary]
  album: [album: AlbumSummary]
  roon: [item: RoonLibraryItem]
  more: [source: 'roon' | 'netease', kind: 'album' | 'artist']
}>()
const artists = computed(() => groupSearchArtists(props.artists, props.roonArtists))
const albums = computed(() => mixSearchAlbums(props.albums, props.roonAlbums))
const visibleArtists = computed(() => {
  if (props.mode !== 'all') return artists.value
  const preferred = [artists.value.find(item => item.roon), artists.value.find(item => item.netease), ...artists.value]
  return [...new Set(preferred.filter((item): item is NonNullable<typeof item> => !!item))].slice(0, 2)
})
const visibleAlbums = computed(() => props.mode === 'all' ? albums.value.slice(0, 6) : albums.value)

const moreSentinel = ref<HTMLElement | null>(null)
let observer: IntersectionObserver | undefined
function observeMore(): void {
  observer?.disconnect()
  if (props.mode === 'all' || !moreSentinel.value || typeof IntersectionObserver === 'undefined') return
  const kind = props.mode === 'albums' ? 'album' : 'artist'
  observer = new IntersectionObserver(entries => {
    if (!entries.some(entry => entry.isIntersecting)) return
    observer?.disconnect()
    const moreRoon = kind === 'album' ? props.moreRoonAlbums : props.moreRoonArtists
    const moreNetease = kind === 'album' ? props.moreAlbums : props.moreArtists
    const neteaseLoading = kind === 'album' ? props.albumsLoading : props.artistsLoading
    const neteaseError = kind === 'album' ? props.albumsError : props.artistsError
    // 两个来源独立推进；失败来源等待明确重试，不能形成无限请求。
    if (moreRoon && !props.roonLoading && !props.roonError) emit('more', 'roon', kind)
    if (moreNetease && !neteaseLoading && !neteaseError) emit('more', 'netease', kind)
  }, { root: moreSentinel.value.closest('.content-scroll'), rootMargin: '240px 0px' })
  observer.observe(moreSentinel.value)
}
onMounted(() => void nextTick(observeMore))
watch(() => [props.mode, props.albums.length, props.artists.length, props.roonAlbums.length, props.roonArtists.length,
  props.moreAlbums, props.moreArtists, props.moreRoonAlbums, props.moreRoonArtists,
  props.albumsLoading, props.artistsLoading, props.roonLoading, props.albumsError, props.artistsError, props.roonError],
  () => void nextTick(observeMore))
onUnmounted(() => observer?.disconnect())
</script>

<template>
  <p v-if="roonError" class="persistent-error">{{ roonError }}</p>
  <section v-if="mode !== 'albums'" class="search-result-section" :class="{ 'search-artist-preview': mode === 'all', 'search-artists-expanded': mode === 'artists' }" aria-labelledby="search-artists-heading">
    <div class="search-section-heading"><h3 id="search-artists-heading">艺人</h3><button v-if="mode === 'all'" type="button" class="text-button" @click="emit('category', 'artists')">查看全部 →</button></div>
    <p v-if="artistsError" class="persistent-error">{{ artistsError }}</p>
    <p v-if="artistsLoading || roonLoading" role="status">正在搜索艺人…</p>
    <div v-if="artists.length" class="search-card-grid search-card-grid-artists" role="list">
      <div v-for="artist in visibleArtists" :key="artist.key" class="search-artist-card unified-artist" role="listitem">
        <button class="artist-primary" type="button" :aria-label="`打开 ${artist.name}`" @click="artist.roon ? emit('roon', artist.roon) : artist.netease && emit('artist', artist.netease)">
          <SafeArtwork v-if="artist.netease?.artworkUrl" class="search-artist-art" :src="artist.netease.artworkUrl" :alt="artist.name" />
          <RoonArtwork v-else-if="artist.roon" class="search-artist-art" :reference="artist.roon.artworkReference ?? artist.roon.reference" :alt="artist.name" />
          <SafeArtwork v-else class="search-artist-art" :alt="artist.name" />
          <strong>{{ artist.name }}</strong>
        </button>
        <div class="artist-sources">
          <button v-if="artist.roon" type="button" class="text-button" :aria-label="`${artist.name} · Roon 艺人详情`" @click="emit('roon', artist.roon)">Roon</button>
          <button v-if="artist.netease" type="button" class="text-button" :aria-label="`${artist.name} · 网易云艺人详情`" @click="emit('artist', artist.netease)">网易云</button>
        </div>
      </div>
    </div>
    <p v-else-if="!artistsLoading && !roonLoading" class="search-section-empty">没有匹配的艺人</p>
    <div v-if="mode !== 'all'" class="button-row">
      <button v-if="moreRoonArtists && roonError" type="button" class="text-button" :disabled="roonLoading" @click="emit('more', 'roon', 'artist')">重试 Roon 艺人</button>
      <button v-if="moreArtists && artistsError" type="button" class="text-button" :disabled="artistsLoading" @click="emit('more', 'netease', 'artist')">重试网易云艺人</button>
    </div>
  </section>
  <section v-if="mode !== 'artists'" class="search-result-section" aria-labelledby="search-albums-heading">
    <div class="search-section-heading"><h3 id="search-albums-heading">专辑</h3><button v-if="mode === 'all'" type="button" class="text-button" @click="emit('category', 'albums')">查看全部 →</button></div>
    <p v-if="albumsError" class="persistent-error">{{ albumsError }}</p>
    <p v-if="albumsLoading || roonLoading" role="status">正在搜索专辑…</p>
    <div v-if="albums.length" class="search-card-grid search-card-grid-albums" role="list">
      <button v-for="album in visibleAlbums" :key="album.key" type="button" class="search-album-card" role="listitem" @click="album.source === 'roon' ? emit('roon', album.item) : emit('album', album.item)">
        <template v-if="album.source === 'roon'">
          <RoonArtwork class="search-album-art" :reference="album.item.artworkReference" :alt="album.item.title" />
          <span><strong>{{ album.item.title }}</strong><small>{{ album.item.artist || album.item.subtitle }}{{ album.item.year ? ` · ${album.item.year}` : '' }}</small><small class="search-source">Roon</small></span>
        </template>
        <template v-else>
          <SafeArtwork class="search-album-art" :src="album.item.artworkUrl" :alt="album.item.name" />
          <span><strong>{{ album.item.name }}</strong><small>{{ album.item.artistName }}</small><small class="search-source">网易云</small></span>
        </template>
      </button>
    </div>
    <p v-else-if="!albumsLoading && !roonLoading" class="search-section-empty">没有匹配的专辑</p>
    <div v-if="mode !== 'all'" class="button-row">
      <button v-if="moreRoonAlbums && roonError" type="button" class="text-button" :disabled="roonLoading" @click="emit('more', 'roon', 'album')">重试 Roon 专辑</button>
      <button v-if="moreAlbums && albumsError" type="button" class="text-button" :disabled="albumsLoading" @click="emit('more', 'netease', 'album')">重试网易云专辑</button>
    </div>
  </section>
  <div v-if="mode !== 'all'" ref="moreSentinel" class="search-entity-sentinel" aria-live="polite">
    <span v-if="roonLoading || (mode === 'albums' ? albumsLoading : artistsLoading)" role="status">正在加载更多{{ mode === 'albums' ? '专辑' : '艺人' }}…</span>
  </div>
</template>

<style scoped>
.search-artist-preview .search-card-grid-artists { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.unified-artist { display: flex; flex-direction: column; align-items: stretch; gap: 4px; }
.artist-primary { display: flex; align-items: center; gap: 14px; border: 0; padding: 0; background: transparent; color: inherit; text-align: left; cursor: pointer; }
.artist-primary strong { overflow: hidden; text-overflow: ellipsis; }
.artist-sources { display: flex; gap: 10px; padding-left: 82px; }
.search-source { opacity: .8; font-size: 11px; }
.button-row:empty { display: none; }
.button-row { margin-top: 12px; }
.search-entity-sentinel { min-height: 1px; text-align: center; color: var(--mb-text-secondary); }
</style>
