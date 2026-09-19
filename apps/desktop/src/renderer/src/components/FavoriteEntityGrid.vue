<script setup lang="ts">
import { ref, watch } from 'vue'
import type { FavoriteKind, FavoritePage, FavoriteRecord, RoonLibraryItem } from '@music-bridge/contracts'
import RoonArtwork from './RoonArtwork.vue'
import { resolveFavorite, type FavoriteResolution } from '../composables/favoriteResolution.js'

const props = withDefaults(defineProps<{
  page: FavoritePage
  kind: FavoriteKind
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
  retry: []
  'load-more': []
  select: [item: RoonLibraryItem, record: FavoriteRecord]
  remove: [item: FavoriteRecord]
}>()

const resolved = ref<Record<string, FavoriteResolution>>({})
const resolving = ref<string | null>(null)
// 只用一个资料库请求通道；离开页面或切换分类即停止剩余封面解析。
watch(() => props.page.items, async (items, _previous, cleanup) => {
  let active = true
  cleanup(() => { active = false })
  for (const item of items) {
    if (!active) break
    if (resolved.value[item.favoriteId]?.state === 'ready') continue
    resolving.value = item.favoriteId
    const result = await resolveFavorite(item, window.musicBridge.searchRoonLibrary, () => active, window.musicBridge.getRoonAlbumTracks)
    if (active) resolved.value = { ...resolved.value, [item.favoriteId]: result }
  }
  if (active) resolving.value = null
}, { immediate: true })

async function retryItem(item: FavoriteRecord): Promise<void> {
  if (resolving.value) return
  resolving.value = item.favoriteId
  resolved.value = { ...resolved.value, [item.favoriteId]: await resolveFavorite(item, window.musicBridge.searchRoonLibrary, undefined, window.musicBridge.getRoonAlbumTracks) }
  resolving.value = null
}

function artwork(item: FavoriteRecord): string | undefined {
  const result = resolved.value[item.favoriteId]
  return result?.state === 'ready' ? result.item.artworkReference ?? (item.kind === 'artist' ? result.item.reference : undefined) : undefined
}

function open(item: FavoriteRecord): void {
  const result = resolved.value[item.favoriteId]
  if (result?.state === 'ready') emit('select', result.item, item)
}

function status(item: FavoriteRecord): string {
  const result = resolved.value[item.favoriteId]
  if (!result) return '正在匹配资料库…'
  return result.state === 'ready' ? (item.kind === 'track' ? '点击播放' : '点击打开') : result.message
}

const kindLabels: Record<FavoriteKind, string> = {
  track: '歌曲',
  album: '专辑',
  artist: '艺术家',
}

function supportingText(item: FavoriteRecord): string {
  if (props.kind === 'track') return [item.artist, item.album].filter(Boolean).join(' · ') || '本地收藏'
  if (props.kind === 'album') return item.artist || item.subtitle || '本地收藏'
  return item.subtitle || item.album || '本地收藏'
}

function formatDate(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return ''
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' }).format(timestamp)
}
</script>

<template>
  <div v-if="props.error" class="empty-state favorite-library-state">
    <span class="empty-glyph" aria-hidden="true">⌁</span>
    <h3>收藏暂时不可用</h3>
    <p>{{ props.error }}</p>
    <button type="button" class="secondary-button" @click="emit('retry')">重试</button>
  </div>
  <div v-else-if="props.initialLoading && !props.page.items.length" class="empty-state favorite-library-state">
    <span class="loading-line"></span>
    <p>正在读取喜欢的{{ kindLabels[props.kind] }}…</p>
  </div>
  <div v-else-if="!props.page.items.length" class="empty-state favorite-library-state">
    <span class="empty-glyph" aria-hidden="true">♡</span>
    <h3>还没有喜欢的{{ kindLabels[props.kind] }}</h3>
    <p>明确收藏的本地关系会保存在 MusicBridge 中，不会改变 Roon Library 媒体。</p>
    <button type="button" class="secondary-button" @click="emit('retry')">重新读取</button>
  </div>
  <template v-else>
    <div class="favorite-entity-grid" :aria-label="`喜欢的${kindLabels[props.kind]}`">
      <article v-for="item in props.page.items" :key="item.favoriteId" class="favorite-entity-card">
        <button type="button" class="favorite-open" :disabled="resolved[item.favoriteId]?.state !== 'ready'" :aria-label="`${item.kind === 'track' ? '播放' : '打开'} ${item.title}`" @click="open(item)">
        <RoonArtwork class="favorite-entity-art" :class="{ 'is-artist': item.kind === 'artist' }" :reference="artwork(item)" :alt="`${item.title} 封面`" :width="384" :height="384" />
        <span class="favorite-entity-copy">
          <strong>{{ item.title }}</strong>
          <span>{{ supportingText(item) }}</span>
          <small>收藏于 {{ formatDate(item.createdAt) }}</small>
        </span>
        </button>
        <span class="favorite-entity-status" role="status">{{ status(item) }}</span>
        <div class="favorite-entity-actions">
          <button v-if="resolved[item.favoriteId] && resolved[item.favoriteId]?.state !== 'ready'" type="button" class="text-button" :disabled="!!resolving" @click="retryItem(item)">重试匹配</button>
          <button type="button" class="text-button" :aria-label="`取消收藏 ${item.title}`" @click="emit('remove', item)">取消收藏</button>
        </div>
      </article>
    </div>
    <div v-if="props.page.hasMore" class="roon-library-more">
      <span v-if="props.loadingMore" role="status">正在加载更多{{ kindLabels[props.kind] }}…</span>
      <template v-else-if="props.loadMoreError">
        <span>{{ props.loadMoreError }}</span>
        <button type="button" class="text-button" @click="emit('load-more')">重试</button>
      </template>
      <button v-else type="button" class="text-button" @click="emit('load-more')">加载更多{{ kindLabels[props.kind] }}</button>
      <span v-if="props.page.total">已显示 {{ props.page.items.length }} / {{ props.page.total }}</span>
    </div>
  </template>
</template>
