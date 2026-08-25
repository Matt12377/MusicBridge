<script setup lang="ts">
import type { FavoriteKind, FavoritePage, FavoriteRecord } from '@music-bridge/contracts'

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
}>()

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
        <div class="favorite-entity-art" aria-hidden="true">{{ item.title.slice(0, 1) || '♫' }}</div>
        <div class="favorite-entity-copy">
          <strong>{{ item.title }}</strong>
          <span>{{ supportingText(item) }}</span>
          <small>收藏于 {{ formatDate(item.createdAt) }}</small>
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
