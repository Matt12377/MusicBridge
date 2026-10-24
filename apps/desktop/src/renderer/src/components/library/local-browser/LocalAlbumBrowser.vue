<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { LocalRootView } from '@music-bridge/contracts'
import type { LocalAlbumArtworkWindow, LocalAlbumBrowserSnapshot, LocalAlbumFilter, LocalAlbumSummary } from '../../../composables/application/local-library-browser/types.js'
import { LOCAL_ALBUM_STATUSES } from '../../../composables/application/local-library-browser/types.js'
import LocalAlbumGrid from './LocalAlbumGrid.vue'
import LocalAlbumDetail from './LocalAlbumDetail.vue'
import { LOCAL_ALBUM_FILTER_LABELS, LOCAL_ALBUM_BATCH_LIMIT, localAlbumWorkbenchBatchRequest, type LocalAlbumWorkbenchRequest, type LocalAlbumWorkbenchBatchRequest } from './presentation.js'

const props = withDefaults(defineProps<{
  state: LocalAlbumBrowserSnapshot
  roots?: readonly LocalRootView[]
  playbackPending?: boolean
  readAvailable?: boolean
  managementAvailable?: boolean
  /** 嵌在本地音乐页时共用父页标题与内容宽度；读写和选择语义不变。 */
  embedded?: boolean
  /** 本地播放页直接展示封面墙；整理页面继续保留浏览控件。 */
  showControls?: boolean
  emptyTitle?: string
  emptyCopy?: string
  backLabel?: string
}>(), { roots: () => [], playbackPending: false, readAvailable: true, managementAvailable: true, embedded: false, showControls: true })
const emit = defineEmits<{
  search: [request: { query: string; rootId: string | null; filter: LocalAlbumFilter }]
  select: [album: LocalAlbumSummary, scrollTop: number]
  back: []
  retry: []
  'load-more': []
  'retry-detail': []
  'load-more-tracks': []
  'ensure-artwork': [album: LocalAlbumSummary]
  'artwork-window': [window: LocalAlbumArtworkWindow]
  'retry-artwork': [album: LocalAlbumSummary]
  'update:scrollTop': [scrollTop: number]
  'update:selectedAlbumIds': [albumIds: readonly string[]]
  play: [trackId: string]
  queue: [trackId: string]
  'play-next': [trackId: string]
  'open-track': [trackId: string]
  workbench: [request: LocalAlbumWorkbenchRequest]
  'workbench-batch': [request: LocalAlbumWorkbenchBatchRequest]
}>()
const root = ref<HTMLElement | null>(null), searchInput = ref<HTMLInputElement | null>(null)
const grid = ref<InstanceType<typeof LocalAlbumGrid> | null>(null), detail = ref<InstanceType<typeof LocalAlbumDetail> | null>(null)
const queryDraft = ref(props.state.query), rootDraft = ref(props.state.rootId ?? '')
const selectedAlbumIds = ref<ReadonlySet<string>>(new Set(props.state.selectedAlbumIds ?? [])), selectionMessage = ref('')
const selectedAlbums = computed(() => props.state.items.filter(album => selectedAlbumIds.value.has(album.id)))
const canOpenBatch = computed(() => props.managementAvailable && selectedAlbums.value.length > 0 && selectedAlbums.value.length <= LOCAL_ALBUM_BATCH_LIMIT && !props.state.initialLoading && !props.state.refreshing)
const filters: readonly LocalAlbumFilter[] = ['all', ...LOCAL_ALBUM_STATUSES]
const rootLabels = { ONLINE: '目录可读取', SOURCE_ROOT_OFFLINE: '源目录离线', REVOKED: '目录许可已撤销' }
const selectedRoot = computed(() => props.roots.find(item => item.root.id === props.state.selectedAlbum?.rootId))
const sourceUnavailable = computed(() => !!selectedRoot.value && selectedRoot.value.availability !== 'ONLINE')
const sourceStatus = computed(() => selectedRoot.value ? `${selectedRoot.value.label} · ${rootLabels[selectedRoot.value.availability]}` : '目录状态暂未读取')
let scrollRoot: HTMLElement | null = null, detailTrigger: HTMLElement | null = null, focusGeneration = 0
let origin: { albumId: string; scrollTop: number; query: string; rootId: string | null; filter: LocalAlbumFilter } | null = null
let selectionAnchor: string | null = null

function submitSearch(filter = props.state.filter): void {
  if (!props.readAvailable) return
  emit('search', { query: queryDraft.value, rootId: rootDraft.value || null, filter })
}
function setFilter(filter: LocalAlbumFilter): void {
  if (!props.readAvailable || props.state.filter === filter) return
  emit('search', { query: props.state.query, rootId: props.state.rootId, filter })
}
function selectAlbum(album: LocalAlbumSummary, event: MouseEvent): void {
  if (props.showControls && (event.shiftKey || event.metaKey || event.ctrlKey)) { toggleSelection(album, event); return }
  selectionAnchor = album.id
  detailTrigger = event.currentTarget as HTMLElement | null
  const scrollTop = scrollRoot?.scrollTop ?? props.state.scrollTop
  origin = { albumId: album.id, scrollTop, query: props.state.query, rootId: props.state.rootId, filter: props.state.filter }
  emit('select', album, scrollTop)
}
function toggleSelection(album: LocalAlbumSummary, event: MouseEvent): void {
  if (!props.showControls || !props.readAvailable || !props.state.items.some(item => item.id === album.id)) return
  const next = new Set(selectedAlbumIds.value), index = props.state.items.findIndex(item => item.id === album.id)
  const anchor = props.state.items.findIndex(item => item.id === selectionAnchor)
  if (event.shiftKey && anchor >= 0) {
    for (const item of props.state.items.slice(Math.min(index, anchor), Math.max(index, anchor) + 1)) next.add(item.id)
  } else {
    if (next.has(album.id)) next.delete(album.id); else next.add(album.id)
  }
  if (next.size > LOCAL_ALBUM_BATCH_LIMIT) { selectionMessage.value = `一次最多选择 ${LOCAL_ALBUM_BATCH_LIMIT} 张专辑，请缩小连续选择范围。`; return }
  selectedAlbumIds.value = next; emit('update:selectedAlbumIds', [...next]); selectionMessage.value = ''
  if (!event.shiftKey || anchor < 0) selectionAnchor = album.id
}
function focusGallery(): void { const target = searchInput.value ?? root.value; target?.focus({ preventScroll: true }) }
function clearSelection(restoreFocus = false): void {
  const anchor = selectionAnchor
  selectedAlbumIds.value = new Set(); emit('update:selectedAlbumIds', []); selectionAnchor = null; selectionMessage.value = ''
  if (restoreFocus) void nextTick(() => { if (!anchor || !grid.value?.focusAlbum(anchor)) focusGallery() })
}
function requestBatch(): void {
  if (!canOpenBatch.value) return
  emit('workbench-batch', localAlbumWorkbenchBatchRequest(selectedAlbums.value))
}
function selectReadAlbums(): void {
  if (!props.readAvailable || props.state.initialLoading || props.state.refreshing) return
  if (props.state.items.length > LOCAL_ALBUM_BATCH_LIMIT) { selectionMessage.value = `已读取超过 ${LOCAL_ALBUM_BATCH_LIMIT} 张，不能截取一部分冒充全选；整个库请使用工作台的全库任务。`; return }
  selectedAlbumIds.value = new Set(props.state.items.map(value => value.id)); emit('update:selectedAlbumIds', [...selectedAlbumIds.value]); selectionMessage.value = ''
}
function captureScroll(): void { if (!props.state.selectedAlbum && scrollRoot) emit('update:scrollTop', scrollRoot.scrollTop) }
function retryBackgroundPage(): void {
  if (!props.state.active || !props.readAvailable || !props.state.hasMore || props.state.initialLoading || props.state.refreshing || props.state.loadingMore) return
  emit('load-more')
}
function requestWorkbench(request: LocalAlbumWorkbenchRequest): void { if (props.showControls && props.managementAvailable) emit('workbench', request) }
function clearSearch(): void { queryDraft.value = ''; submitSearch() }
async function restoreGallery(generation: number): Promise<void> {
  await nextTick()
  if (generation !== focusGeneration || props.state.selectedAlbum) return
  const sameScope = origin && origin.query === props.state.query && origin.rootId === props.state.rootId && origin.filter === props.state.filter
  if (scrollRoot) scrollRoot.scrollTop = sameScope ? origin!.scrollTop : props.state.scrollTop
  grid.value?.refresh()
  if (sameScope && detailTrigger?.isConnected) { detailTrigger.focus({ preventScroll: true }); return }
  if (sameScope && grid.value?.focusAlbum(origin!.albumId)) return
  focusGallery()
}
watch(() => props.state.selectedAlbumIds, ids => { if (ids) { selectedAlbumIds.value = new Set(ids); if (!ids.length) { selectionAnchor = null; selectionMessage.value = '' } } })
watch(() => props.state.scrollTop, (top, previous) => {
  if (top !== 0 || previous === 0 || props.state.selectedAlbum) return
  origin = null
  if (scrollRoot) scrollRoot.scrollTop = 0
  void nextTick(() => grid.value?.refresh())
})
watch(() => props.state.query, value => { queryDraft.value = value })
watch(() => props.state.rootId, value => { rootDraft.value = value ?? '' })
watch([() => props.state.query, () => props.state.rootId, () => props.state.filter], () => clearSelection())
watch([() => props.state.items, () => props.state.initialLoading, () => props.state.refreshing], () => {
  if (props.state.initialLoading || props.state.refreshing) return
  const current = new Set(props.state.items.map(album => album.id))
  selectedAlbumIds.value = new Set([...selectedAlbumIds.value].filter(id => current.has(id)))
  if (selectionAnchor && !current.has(selectionAnchor)) selectionAnchor = null
})
watch(() => props.state.selectedAlbum?.id, (albumId, previousId) => {
  const generation = ++focusGeneration
  if (albumId) void nextTick(() => {
    if (generation !== focusGeneration || props.state.selectedAlbum?.id !== albumId) return
    if (scrollRoot) scrollRoot.scrollTop = 0
    detail.value?.focusHeading()
  })
  else if (previousId) void restoreGallery(generation)
})
function updateArtworkWindow(window: LocalAlbumArtworkWindow): void {
  const album = props.state.selectedAlbum
  emit('artwork-window', !props.state.active || !props.readAvailable ? { visible: [], nearby: [] } : album ? { visible: [album], nearby: [] } : window)
}
watch([() => props.state.active, () => props.readAvailable, () => props.state.selectedAlbum ? JSON.stringify([props.state.selectedAlbum.id, props.state.selectedAlbum.rootId,
  props.state.selectedAlbum.editionId, props.state.selectedAlbum.representativeTrackId, props.state.selectedAlbum.revision]) : null,
  () => props.state.artworkInvalidation?.albumKey === null || props.state.artworkInvalidation?.albumKey === props.state.selectedAlbum?.id ? props.state.artworkInvalidation?.epoch : 0], () => {
  const album = props.state.selectedAlbum
  if (!props.state.active || !props.readAvailable) { updateArtworkWindow({ visible: [], nearby: [] }); return }
  if (album) {
    updateArtworkWindow({ visible: [album], nearby: [] })
    const status = props.state.artwork[album.id]?.status ?? 'idle'
    if (status === 'idle' || status === 'ready') emit('ensure-artwork', album)
  }
}, { immediate: true })
onMounted(() => {
  scrollRoot = root.value?.closest<HTMLElement>('.content-scroll') ?? null
  scrollRoot?.addEventListener('scroll', captureScroll, { passive: true })
  if (!props.state.selectedAlbum && scrollRoot) scrollRoot.scrollTop = props.state.scrollTop
  else void nextTick(() => detail.value?.focusHeading())
})
onUnmounted(() => { focusGeneration++; scrollRoot?.removeEventListener('scroll', captureScroll); emit('artwork-window', { visible: [], nearby: [] }) })
</script>

<template>
  <section ref="root" class="local-album-browser" :class="{ view: !props.embedded, 'is-embedded': props.embedded }" :aria-labelledby="props.state.selectedAlbum ? 'local-album-detail-heading' : 'local-album-browser-heading'" :tabindex="props.showControls ? undefined : -1" data-testid="local-album-browser" @keydown.esc="clearSelection()">
    <div v-show="!props.state.selectedAlbum" class="local-album-gallery">
      <h2 v-if="!props.showControls" id="local-album-browser-heading" class="visually-hidden">本地音乐</h2>
      <header v-if="props.showControls" class="view-heading"><div :class="{ 'visually-hidden': props.embedded }"><p class="section-kicker">本地数字音乐</p><h2 id="local-album-browser-heading">本地音乐</h2><p class="lede">按专辑浏览已加入的音乐，保留版本与来源。</p></div><div class="button-row"><button type="button" class="secondary-button" :disabled="!props.managementAvailable" @click="requestWorkbench({ action: 'overview' })"><i class="bi bi-sliders" aria-hidden="true"></i> 整理工作台</button><button type="button" class="text-button" :disabled="props.state.initialLoading || props.state.refreshing || !props.readAvailable" @click="emit('retry')"><i class="bi bi-arrow-clockwise" aria-hidden="true"></i> {{ props.state.refreshing ? '正在刷新…' : '刷新' }}</button></div></header>
      <form v-if="props.showControls" class="local-album-search" role="search" aria-label="搜索本地专辑" @submit.prevent="submitSearch()">
        <label for="local-album-search-query" class="visually-hidden">专辑、艺术家或版本</label><div class="local-album-search-field"><i class="bi bi-search" aria-hidden="true"></i><input id="local-album-search-query" ref="searchInput" v-model="queryDraft" type="search" maxlength="256" autocomplete="off" placeholder="搜索本地专辑、艺术家或版本" :disabled="!props.readAvailable"><button v-if="queryDraft" type="button" class="text-button" aria-label="清除本地专辑搜索" @click="clearSearch">清除</button></div>
        <label class="local-album-root-filter"><span class="visually-hidden">专辑来源目录</span><select v-model="rootDraft" :disabled="!props.readAvailable" aria-label="专辑来源目录"><option value="">全部已加入目录</option><option v-for="item in props.roots" :key="item.root.id" :value="item.root.id">{{ item.label }} · {{ rootLabels[item.availability] }}</option></select></label><button type="submit" class="secondary-button" :disabled="!props.readAvailable">搜索</button>
      </form>
      <div v-if="props.showControls" class="local-album-filters" role="group" aria-label="本地专辑筛选"><button v-for="filter in filters" :key="filter" type="button" class="text-button local-album-filter" :class="{ 'is-selected': props.state.filter === filter }" :aria-pressed="props.state.filter === filter" :disabled="!props.readAvailable" @click="setFilter(filter)">{{ LOCAL_ALBUM_FILTER_LABELS[filter] }} <span v-if="props.state.loaded">{{ props.state.counts[filter] }}</span></button></div>
      <div v-if="props.showControls" class="local-album-result-summary" aria-live="polite"><span v-if="props.state.loaded">{{ props.state.total }} 张专辑<span v-if="props.state.query"> · “{{ props.state.query }}”</span></span><span v-if="props.state.initialLoading || props.state.refreshing" role="status">正在读取…</span><span v-if="props.state.stale">正在显示上次成功读取的结果</span><span v-if="!props.managementAvailable">整理工作台尚未接入</span></div>
      <div v-if="props.showControls && selectedAlbums.length" class="local-album-selection-bar" role="group" aria-label="已选择的本地专辑"><span role="status" aria-live="polite">已选择 {{ selectedAlbums.length }} 张专辑</span><button type="button" class="secondary-button" :disabled="!canOpenBatch" @click="requestBatch"><i class="bi bi-sliders" aria-hidden="true"></i> 批量整理</button><button type="button" class="text-button" @click="clearSelection(true)">取消选择</button></div>
      <div v-if="props.showControls" class="local-album-selection-tools">
        <p class="local-album-selection-help">单击打开专辑；使用选择按钮或 Cmd/Ctrl 多选，Shift 按当前已读取顺序连续选择。</p>
        <button type="button" class="text-button" :disabled="!props.readAvailable || props.state.initialLoading || props.state.refreshing || !props.state.items.length" @click="selectReadAlbums()">全选当前已读取专辑</button>
      </div>
      <p v-if="selectionMessage" class="persistent-error" role="status">{{ selectionMessage }}</p>
      <p v-if="props.state.refreshError || props.state.error && props.state.items.length" class="persistent-error" role="alert">{{ props.state.refreshError || props.state.error }} <button type="button" class="inline-action" :disabled="props.state.refreshing" @click="emit('retry')">重试读取</button></p>
      <div v-if="props.state.backgroundArtwork && props.state.items.length" class="local-album-background-status" aria-live="polite">
        <span>已载入 {{ props.state.items.length }} / {{ props.state.total }} 张专辑</span>
        <span v-if="props.state.loadingMore" role="status">正在继续载入专辑…</span>
        <span v-if="props.state.backgroundArtwork.running" role="status">正在准备封面 {{ props.state.backgroundArtwork.completed }} / {{ props.state.backgroundArtwork.total }}</span>
        <span v-else>封面检查进度 {{ props.state.backgroundArtwork.completed }} / {{ props.state.backgroundArtwork.total }}</span>
        <span v-if="props.state.loadMoreError" class="persistent-error" role="alert">{{ props.state.loadMoreError }} <button type="button" class="inline-action" :disabled="!props.state.active || !props.readAvailable || props.state.initialLoading || props.state.refreshing || props.state.loadingMore" @click="retryBackgroundPage">重试载入专辑</button></span>
      </div>
      <LocalAlbumGrid ref="grid" :albums="props.state.items" :selected-album-ids="props.showControls ? selectedAlbumIds : undefined" :empty-title="props.emptyTitle" :empty-copy="props.emptyCopy" :show-management-actions="props.showControls" :show-page-status="!props.state.backgroundArtwork" :artwork="props.state.artwork" :artwork-invalidation="props.state.artworkInvalidation" :active="props.state.active && !props.state.selectedAlbum" :loaded="props.state.loaded" :initial-loading="props.state.initialLoading" :refreshing="props.state.refreshing" :loading-more="props.state.loadingMore" :has-more="props.state.hasMore" :total="props.state.total" :error="props.state.error" :load-more-error="props.state.loadMoreError" :searching="!!props.state.query" :filtering="props.state.filter !== 'all'" :read-available="props.readAvailable" :management-available="props.managementAvailable" @select="selectAlbum" @toggle-selection="toggleSelection" @retry="emit('retry')" @load-more="emit('load-more')" @artwork-window="updateArtworkWindow" @ensure-artwork="emit('ensure-artwork', $event)" @retry-artwork="emit('retry-artwork', $event)" @workbench="requestWorkbench" />
    </div>
    <LocalAlbumDetail v-if="props.state.selectedAlbum" ref="detail" :back-label="props.backLabel" :show-management-actions="props.showControls" :album="props.state.selectedAlbum" :tracks="props.state.tracks" :artwork="props.state.artwork[props.state.selectedAlbum.id]" :total="props.state.trackTotal" :has-more="props.state.tracksHasMore" :initial-loading="props.state.detailLoading" :loading-more="props.state.detailLoadingMore" :error="props.state.detailError" :refresh-error="props.state.detailRefreshError" :load-more-error="props.state.detailLoadMoreError" :stale="props.state.detailStale" :playback-pending="props.playbackPending" :read-available="props.readAvailable" :management-available="props.managementAvailable" :source-unavailable="sourceUnavailable" :source-status="sourceStatus" @back="emit('back')" @play="emit('play', $event)" @queue="emit('queue', $event)" @play-next="emit('play-next', $event)" @open-track="emit('open-track', $event)" @retry="emit('retry-detail')" @load-more="emit('load-more-tracks')" @retry-artwork="emit('retry-artwork', $event)" @workbench="requestWorkbench" />
  </section>
</template>

<style scoped>
.local-album-browser { min-width: 0; container-type: inline-size; }
.local-album-browser.is-embedded { margin: 0; padding: 0; }
.local-album-browser.is-embedded .view-heading { min-height: 44px; margin-bottom: 8px; justify-content: flex-end; }
.local-album-browser.is-embedded .local-album-filters { gap: 4px 12px; }
.local-album-browser.is-embedded .local-album-result-summary { margin-bottom: 8px; }
.local-album-browser.is-embedded .local-album-selection-tools { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 12px; margin-bottom: 8px; }
.local-album-browser.is-embedded .local-album-selection-help { flex: 1 1 300px; margin: 0; }

.local-album-search { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin: 0 0 12px; }
.local-album-search-field { display: flex; flex: 1 1 280px; min-width: 0; align-items: center; gap: 10px; padding: 0 12px; border: 1px solid var(--mb-glass-border); border-radius: 8px; background: var(--mb-glass-clear); color: var(--mb-text-secondary); }
.local-album-search-field input { width: 100%; min-width: 0; min-height: 44px; border: 0; outline: 0; color: var(--mb-text-primary); background: transparent; }
.local-album-search-field:focus-within { outline: 2px solid var(--mb-accent); outline-offset: 2px; }
.local-album-root-filter { max-width: 100%; }
.local-album-root-filter select { min-width: 0; max-width: 100%; min-height: 44px; padding: 8px 12px; border: 1px solid var(--mb-glass-border); border-radius: 8px; color: var(--mb-text-primary); background: var(--mb-glass-clear); }
.local-album-filters { display: flex; flex-wrap: wrap; gap: 4px 18px; align-items: center; margin-bottom: 4px; }
.local-album-filter { display: inline-flex; gap: 6px; min-height: 44px; align-items: center; padding: 6px 0; border-bottom: 2px solid transparent; }
.local-album-filter.is-selected { border-bottom-color: var(--mb-accent); color: var(--mb-text-primary); }
.local-album-filter span { color: var(--mb-text-tertiary); font-size: 11px; font-variant-numeric: tabular-nums; }
.local-album-result-summary { display: flex; min-height: 36px; flex-wrap: wrap; gap: 16px; align-items: center; margin: 0 0 18px; color: var(--mb-text-secondary); font-size: 12px; font-variant-numeric: tabular-nums; }
.local-album-background-status { display: flex; min-height: 36px; flex-wrap: wrap; gap: 8px 16px; align-items: center; margin: 0 0 12px; color: var(--mb-text-secondary); font-size: 12px; font-variant-numeric: tabular-nums; }
.local-album-selection-bar { display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: center; margin-bottom: 10px; font-variant-numeric: tabular-nums; }
.local-album-selection-help { margin: 0 0 18px; color: var(--mb-text-secondary); font-size: 12px; }
.local-album-browser button:focus-visible, .local-album-browser select:focus-visible { outline: 2px solid var(--mb-accent); outline-offset: 3px; border-radius: 6px; }
@container (max-width: 620px) { .local-album-search-field { flex-basis: 100%; } .local-album-root-filter { flex: 1 1 160px; } .local-album-root-filter select { width: 100%; } }
@media (prefers-reduced-motion: reduce) { .local-album-browser :deep(*) { scroll-behavior: auto; } }
</style>
