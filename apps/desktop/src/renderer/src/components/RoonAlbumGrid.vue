<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { RoonLibraryItem, RoonLibraryPage } from '@music-bridge/contracts'
import RoonArtwork from './RoonArtwork.vue'
import { useGridArtworkRetry } from '../composables/useGridArtworkRetry.js'
import { useGridWindow } from '../composables/useGridWindow.js'
import { prepareRoonCardProbe } from '../composables/gridCardProbe.js'
import { shouldAutoLoadRoonPage } from '../composables/roonLibraryPagination.js'

const props = withDefaults(defineProps<{
  page: RoonLibraryPage
  searching?: boolean
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
  select: [album: RoonLibraryItem]
  retry: []
  'load-more': []
}>()

const loadMoreSentinel = ref<HTMLElement | null>(null)
let intersectionObserver: IntersectionObserver | undefined

function observeLoadMoreSentinel(): void {
  intersectionObserver?.disconnect()
  if (!loadMoreSentinel.value || !props.page.hasMore) return
  intersectionObserver?.observe(loadMoreSentinel.value)
}

onMounted(() => {
  if (typeof IntersectionObserver === 'undefined') return
  intersectionObserver = new IntersectionObserver((entries) => {
    const entry = entries[0]
    if (!entry || !shouldAutoLoadRoonPage({
      isIntersecting: entry.isIntersecting,
      hasMore: props.page.hasMore === true,
      initialLoading: props.initialLoading,
      loadingMore: props.loadingMore,
      loadMoreError: props.loadMoreError,
    })) return
    intersectionObserver?.unobserve(entry.target)
    emit('load-more')
  }, { rootMargin: '320px 0px', threshold: 0 })
  observeLoadMoreSentinel()
})

watch(
  () => [props.page.offset, props.page.hasMore, props.loadingMore, props.loadMoreError] as const,
  () => { void nextTick(observeLoadMoreSentinel) },
)

onUnmounted(() => intersectionObserver?.disconnect())
const gridRoot = ref<HTMLElement | null>(null)
const grid = useGridWindow(computed(() => props.page.items), gridRoot, { profile: item => item.year ? 'year' : 'plain', prepareProbe: prepareRoonCardProbe })
const artworkRetry = useGridArtworkRetry(computed(() => grid.rendered.value.map(entry => entry.item)), item => item.reference)
// 初始占位页也有 total=0；只有带成功读取身份且已完成的首页才能确认空结果。
const confirmedEmptyRead = computed(() => props.page.offset === 0 && props.page.total === 0 && props.page.complete === true && typeof props.page.sourceEpoch === 'string')
</script>

<template>
  <div v-if="props.error" class="empty-state roon-library-state">
    <span class="empty-glyph" aria-hidden="true">⌁</span>
    <h3>Roon 专辑暂时不可用</h3>
    <p>{{ props.error }}</p>
    <button type="button" class="secondary-button" @click="emit('retry')">重试</button>
  </div>
  <div v-else-if="props.initialLoading && !props.page.items.length" class="empty-state roon-library-state">
    <span class="loading-line"></span>
    <p>正在读取 Roon 专辑…</p>
  </div>
  <div v-else-if="!props.page.items.length" class="empty-state roon-library-state">
    <span class="empty-glyph" aria-hidden="true">♫</span>
    <h3>{{ searching ? '没有匹配的本地专辑' : '还没有可显示的专辑' }}</h3>
    <p>{{ searching ? '换一个关键词，或清除搜索查看全部专辑。' : confirmedEmptyRead ? '本次读取未返回专辑。可在 Roon 中检查资料库内容后重新读取。' : '当前没有可显示的专辑，请重新读取。若仍为空，可在 Roon 中检查资料库内容。' }}</p>
    <button type="button" class="secondary-button" @click="emit('retry')">重新读取</button>
  </div>
  <template v-else>
    <div ref="gridRoot" v-bind="grid.attrs.value" :style="grid.rootStyle.value" @focusin="grid.onFocusIn" @focusout="grid.onFocusOut" @keydown="grid.onKeydown" class="roon-album-grid" aria-label="Roon 专辑">
      <div v-for="{ item: album, index, style } in grid.rendered.value" :data-grid-index="index" :style="style" :key="album.reference"><button :style="{ width: '100%', height: '100%' }" type="button" class="roon-album-card" @click="emit('select', album)">
        <RoonArtwork :external-retry="true" :onRetryAction="artworkRetry.handler(album)" class="roon-album-art" :reference="album.artworkReference" :alt="`${album.title} 封面`" :width="256" :height="256" />
        <span class="roon-album-copy"><strong>{{ album.title }}</strong><small>{{ album.artist || album.subtitle || 'Roon Library' }}</small><small v-if="album.year">{{ album.year }}</small></span>
      </button><button v-if="artworkRetry.available(album)" type="button" class="secondary-button" :style="{ position: 'absolute', top: '8px', right: '8px', zIndex: 3 }" aria-label="重试读取封面" @click="artworkRetry.run(album, $event)">重试封面</button></div>
    </div>
    <div v-if="props.page.hasMore" ref="loadMoreSentinel" class="roon-library-more" aria-live="polite">
      <span v-if="props.loadingMore" role="status">正在加载更多专辑…</span>
      <template v-else-if="props.loadMoreError">
        <span>{{ props.loadMoreError }}</span>
        <button type="button" class="text-button" @click="emit('load-more')">重试</button>
      </template>
      <button v-else type="button" class="text-button" @click="emit('load-more')">加载更多专辑</button>
      <span v-if="props.page.total">已显示 {{ props.page.items.length }} / {{ props.page.total }}</span>
    </div>
  </template>
</template>
