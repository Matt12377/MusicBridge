<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import type { FavoriteKind, FavoritePage, FavoriteRecord, RoonLibraryItem } from '@music-bridge/contracts'
import RoonArtwork from './RoonArtwork.vue'
import { useGridArtworkRetry } from '../composables/useGridArtworkRetry.js'
import { useGridWindow } from '../composables/useGridWindow.js'
import { prepareFavoriteCardProbe } from '../composables/gridCardProbe.js'
import { favoriteResolutionKey, useFavoriteWindowResolution } from '../composables/useFavoriteWindowResolution.js'

const props = withDefaults(defineProps<{
  page: FavoritePage
  kind: FavoriteKind
  scopeKey?: string
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

const resolution = shallowRef<ReturnType<typeof useFavoriteWindowResolution>>()
function resultFor(item: FavoriteRecord) { return resolution.value?.result(item) }
const gridRoot = ref<HTMLElement | null>(null)
const grid = useGridWindow(computed(() => props.page.items), gridRoot, {
  profile: item => status(item),
  prepareProbe(element, item) { const result = resultFor(item); prepareFavoriteCardProbe(element, { message: status(item), ready: result?.state === 'ready', retry: !!result && result.state !== 'ready', resolving: !!resolution.value?.resolving.value }) },
})
resolution.value = useFavoriteWindowResolution(computed(() => grid.rendered.value.map(entry => entry.item)), () => props.scopeKey ?? 'component', () => props.kind, window.musicBridge)
const artworkRetry = useGridArtworkRetry(computed(() => grid.rendered.value.map(entry => entry.item)), item => `${favoriteResolutionKey(props.scopeKey ?? 'component', props.kind, item)}:${artwork(item) ?? ''}`)
const resolving = resolution.value.resolving
watch(() => grid.rendered.value.map(entry => status(entry.item)).join('\n'), () => grid.refresh())
const dateFormatter = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' })
function retryItem(item: FavoriteRecord): void { resolution.value?.retry(item) }
function artwork(item: FavoriteRecord): string | undefined {
  const result = resultFor(item)
  return result?.state === 'ready' ? result.item.artworkReference ?? (item.kind === 'artist' ? result.item.reference : undefined) : undefined
}

function open(item: FavoriteRecord): void {
  const result = resultFor(item)
  if (result?.state === 'ready') emit('select', result.item, item)
}

function status(item: FavoriteRecord): string {
  const result = resultFor(item)
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
  return dateFormatter.format(timestamp)
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
    <div ref="gridRoot" v-bind="grid.attrs.value" :style="grid.rootStyle.value" @focusin="grid.onFocusIn" @focusout="grid.onFocusOut" @keydown="grid.onKeydown" :data-favorite-pool-entries="resolution?.stats().entries" :data-favorite-pool-bytes="resolution?.stats().bytes" class="favorite-entity-grid" :aria-label="`喜欢的${kindLabels[props.kind]}`">
      <article v-for="{ item, index, style } in grid.rendered.value" :data-grid-index="index" :style="style" :key="item.favoriteId" class="favorite-entity-card">
        <button type="button" class="favorite-open" :disabled="resultFor(item)?.state !== 'ready'" :aria-label="`${item.kind === 'track' ? '播放' : '打开'} ${item.title}`" @click="open(item)">
        <RoonArtwork :external-retry="true" :onRetryAction="artworkRetry.handler(item)" class="favorite-entity-art" :class="{ 'is-artist': item.kind === 'artist' }" :reference="artwork(item)" :alt="`${item.title} 封面`" :width="384" :height="384" />
        <span class="favorite-entity-copy">
          <strong>{{ item.title }}</strong>
          <span>{{ supportingText(item) }}</span>
          <small>收藏于 {{ formatDate(item.createdAt) }}</small>
        </span>
        </button>
        <button v-if="artworkRetry.available(item)" type="button" class="secondary-button" :style="{ position: 'absolute', top: '8px', right: '8px', zIndex: 3 }" aria-label="重试读取封面" @click="artworkRetry.run(item, $event)">重试封面</button>
        <span class="favorite-entity-status" role="status">{{ status(item) }}</span>
        <div class="favorite-entity-actions">
          <button v-if="resultFor(item) && resultFor(item)?.state !== 'ready'" type="button" class="text-button" :disabled="!!resolving" @click="retryItem(item)">重试匹配</button>
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
