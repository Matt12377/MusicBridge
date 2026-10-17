<script setup lang="ts">
import { desktopArtworkKey } from '../../../../../../../../packages/bridge-core/src/shared/desktop-artwork-trace.js'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { LocalAlbumArtworkInvalidation, LocalAlbumArtworkState, LocalAlbumArtworkWindow, LocalAlbumSummary } from '../../../composables/application/local-library-browser/types.js'
import { createGridArtworkCache, type GridArtworkSource } from '../../../composables/application/local-library-browser/grid-artwork-cache.js'
import { useGridWindow } from '../../../composables/useGridWindow.js'
import LocalAlbumArtwork from './LocalAlbumArtwork.vue'
import { localAlbumIdentity, localAlbumIssueLabel, localAlbumWorkbenchRequest, type LocalAlbumWorkbenchRequest } from './presentation.js'

const props = withDefaults(defineProps<{
  albums: readonly LocalAlbumSummary[]
  artwork: Readonly<Record<string, LocalAlbumArtworkState>>
  artworkInvalidation?: Readonly<LocalAlbumArtworkInvalidation>
  active?: boolean
  loaded?: boolean
  initialLoading?: boolean
  loadingMore?: boolean
  hasMore?: boolean
  total?: number
  error?: string
  loadMoreError?: string
  searching?: boolean
  filtering?: boolean
  readAvailable?: boolean
  managementAvailable?: boolean
  selectedAlbumIds?: ReadonlySet<string>
}>(), {
  active: true, loaded: false, initialLoading: false, loadingMore: false, hasMore: false,
  total: 0, error: '', loadMoreError: '', searching: false, filtering: false,
  readAvailable: true, managementAvailable: true,
})
const emit = defineEmits<{
  select: [album: LocalAlbumSummary, event: MouseEvent]
  'toggle-selection': [album: LocalAlbumSummary, event: MouseEvent]
  retry: []
  'load-more': []
  'ensure-artwork': [album: LocalAlbumSummary]
  'artwork-window': [window: LocalAlbumArtworkWindow]
  'retry-artwork': [album: LocalAlbumSummary]
  workbench: [request: LocalAlbumWorkbenchRequest]
}>()
const thumbnailRevision = ref(0)
const thumbnails = createGridArtworkCache({ onChange: () => { thumbnailRevision.value++ } })
const root = ref<HTMLElement | null>(null), sentinel = ref<HTMLElement | null>(null)
const failedImages = ref<Record<string, string>>({}), imageRetries = ref<Record<string, number>>({})
// 只在本次兴趣窗口消费一次资格；成功图离窗重入可复用持久缓存，同窗淘汰不循环。
const automaticRequests = ref(new Map<string, { identity: string; observed: boolean; priority: number; failed: boolean }>())
let observedInvalidationEpoch = 0
let observer: IntersectionObserver | undefined
const idleArtwork: LocalAlbumArtworkState = { status: 'idle', dataUrl: null, error: '', canRetry: false }
const grid = useGridWindow(computed(() => props.albums), root, {
  profile: album => localAlbumIssueLabel(album.statuses) ? 'issue' : 'plain',
  prepareProbe: (element, album) => {
    const copy = element.querySelector('.roon-album-copy')
    if (!copy) return
    copy.querySelector('.local-album-issue')?.remove()
    const label = localAlbumIssueLabel(album.statuses)
    if (label) {
      const issue = element.ownerDocument.createElement('small')
      issue.className = 'local-album-issue'; issue.textContent = label; copy.append(issue)
    }
  },
})
const artworkWindow = computed<LocalAlbumArtworkWindow>(() => {
  if (!props.active || !props.readAvailable) return { visible: [], nearby: [] }
  const visible = grid.visible.value.slice(0, 128).map(entry => entry.item)
  return { visible, nearby: grid.nearby.value.slice(0, 128 - visible.length).map(entry => entry.item) }
})

function artworkFor(album: LocalAlbumSummary): LocalAlbumArtworkState { return props.artwork[album.id] ?? idleArtwork }
function displayedArtworkFor(album: LocalAlbumSummary): LocalAlbumArtworkState {
  void thumbnailRevision.value
  const original = artworkFor(album)
  if (original.status !== 'ready' || !original.dataUrl || !original.display) return original
  const thumbnail = thumbnails.get(requestIdentity(album))
  return thumbnail.status === 'ready' ? { ...original, dataUrl: thumbnail.dataUrl } : thumbnail.status === 'error'
    ? { status: 'error', dataUrl: null, error: '封面展示暂时失败，可重试。', canRetry: true }
    : { status: 'loading', dataUrl: null, error: '', canRetry: false }
}
const thumbnailDimension = computed(() => {
  const width = Number.parseFloat(grid.rendered.value[0]?.style?.width ?? '')
  const pixels = (Number.isFinite(width) && width > 0 ? width : 256) * (typeof window === 'undefined' ? 2 : Math.max(1, window.devicePixelRatio || 1))
  return [128, 256, 384, 512].find(size => size >= pixels) ?? 512
})
function syncThumbnails(): void {
  const window = artworkWindow.value, visible = new Set(window.visible.map(album => album.id)), sources: GridArtworkSource[] = []
  for (const album of [...window.visible, ...window.nearby]) {
    const image = artworkFor(album)
    if (image.status === 'ready' && image.dataUrl && image.display) sources.push({ identity: requestIdentity(album), dataUrl: image.dataUrl, display: image.display, visible: visible.has(album.id) })
  }
  thumbnails.setWindow(sources, thumbnailDimension.value, window.visible.length)
}
watch(() => [props.active, props.readAvailable, props.artworkInvalidation?.epoch ?? 0, thumbnailDimension.value,
  ...[...artworkWindow.value.visible, ...artworkWindow.value.nearby].map(album => `${requestIdentity(album)}:${artworkFor(album).status}:${artworkFor(album).display?.sha256 ?? ''}`)], syncThumbnails, { immediate: true })

function artworkCoverage(album: LocalAlbumSummary): NonNullable<LocalAlbumSummary['artworkState']> {
  return album.artworkState ?? (album.artworkAvailable ? 'available' : 'missing')
}
function hasImageError(album: LocalAlbumSummary): boolean {
  const image = artworkFor(album)
  return displayedArtworkFor(album).status === 'error' || image.status === 'error' || !!image.dataUrl && failedImages.value[album.id] === image.dataUrl
}
function requestIdentity(album: LocalAlbumSummary): string {
  return JSON.stringify([album.id, album.rootId, album.editionId, album.representativeTrackId, album.revision])
}
function needsExplicitRetry(album: LocalAlbumSummary): boolean {
  const request = automaticRequests.value.get(album.id)
  return props.active && artworkCoverage(album) !== 'missing' && artworkFor(album).status === 'idle'
    && request?.identity === requestIdentity(album) && request?.observed === true
}
function canRetryArtwork(album: LocalAlbumSummary): boolean {
  const image = displayedArtworkFor(album)
  return props.readAvailable && image.status !== 'loading' && (image.canRetry || needsExplicitRetry(album) || hasImageError(album))
}
function onImageError(album: LocalAlbumSummary): void {
  const src = artworkFor(album).dataUrl
  if (src) failedImages.value = { ...failedImages.value, [album.id]: src }
}
function retryArtwork(album: LocalAlbumSummary): void {
  if (!canRetryArtwork(album)) return
  imageRetries.value = { ...imageRetries.value, [album.id]: (imageRetries.value[album.id] ?? 0) + 1 }
  const failures = { ...failedImages.value }; delete failures[album.id]; failedImages.value = failures
  const original = artworkFor(album)
  if (original.status === 'ready' && original.dataUrl && original.display) { thumbnails.retry(requestIdentity(album)); syncThumbnails(); return }
  emit('retry-artwork', album)
}
function requestWorkbench(request: LocalAlbumWorkbenchRequest): void {
  if (!props.managementAvailable) return
  emit('workbench', request)
}
function observeSentinel(): void {
  observer?.disconnect()
  if (sentinel.value && props.active && props.hasMore && !props.loadMoreError && props.readAvailable) observer?.observe(sentinel.value)
}
onMounted(() => {
  if (typeof IntersectionObserver === 'undefined') return
  observer = new IntersectionObserver(entries => {
    if (!entries.some(entry => entry.isIntersecting) || !props.active || !props.hasMore || props.initialLoading || props.loadingMore || props.loadMoreError || !props.readAvailable) return
    observer?.disconnect(); emit('load-more')
  }, { rootMargin: '320px 0px', threshold: 0 })
  observeSentinel()
})
watch(() => [props.active, props.readAvailable, props.hasMore, props.loadingMore, props.loadMoreError, props.albums.length], () => void nextTick(observeSentinel))
watch(() => [props.active, props.readAvailable, props.artworkInvalidation?.epoch ?? 0,
  ...artworkWindow.value.visible.map(item => `visible:${requestIdentity(item)}:${props.artwork[item.id]?.status ?? 'idle'}`),
  ...artworkWindow.value.nearby.map(item => `nearby:${requestIdentity(item)}:${props.artwork[item.id]?.status ?? 'idle'}`)], () => {
  const window = artworkWindow.value, interested = [...window.visible, ...window.nearby], visibleIds = new Set(interested.map(item => item.id))
  const actuallyVisible = new Set(window.visible.map(item => item.id))
  const next = new Map(automaticRequests.value), pending: LocalAlbumSummary[] = []
  let changed = false
  for (const id of next.keys()) if (!visibleIds.has(id)) { next.delete(id); changed = true }
  const invalidation = props.artworkInvalidation
  if (invalidation && invalidation.epoch !== observedInvalidationEpoch) {
    observedInvalidationEpoch = invalidation.epoch
    if (invalidation.albumKey === null) { changed ||= next.size > 0; next.clear() }
    else changed = next.delete(invalidation.albumKey) || changed
  }
  // 先记录窗口内全部身份，包括 ready/loading；否则第一次淘汰 ready 项仍会被当成新请求。
  for (const item of interested) {
    const identity = requestIdentity(item), previous = next.get(item.id), status = artworkFor(item).status, observed = status !== 'idle'
    const priority = actuallyVisible.has(item.id) ? 0 : 1
    // 消费自动资格不代表缓存已存在；首次未探测仍保留原来的查找入口。
    if (previous && previous.identity === identity) {
      const failed = status === 'error' ? true : status === 'ready' || status === 'missing' ? false : previous.failed
      // 近邻真正进入视口只续一次资格；缓存容量不足不能靠ready→idle抖动无限续读，失败仍显式重试。
      if (previous.priority === 1 && priority === 0 && !failed && !hasImageError(item) && (status === 'idle' || status === 'ready')) pending.push(item)
      if (priority !== previous.priority || failed !== previous.failed || observed && !previous.observed) {
        next.set(item.id, { identity, observed: previous.observed || observed, priority, failed }); changed = true
      }
      continue
    }
    next.set(item.id, { identity, observed, priority, failed: status === 'error' }); changed = true
    // 成功图重入只触碰现有LRU；同窗口身份仍只获得一次资格，不因淘汰循环读图。
    if (artworkFor(item).status === 'idle' || artworkFor(item).status === 'ready' || artworkFor(item).status === 'missing') pending.push(item)
  }
  if (changed) automaticRequests.value = next
  const failures = Object.fromEntries(Object.entries(failedImages.value).filter(([id, src]) => visibleIds.has(id) && props.artwork[id]?.dataUrl === src))
  if (Object.keys(failures).length !== Object.keys(failedImages.value).length) failedImages.value = failures
  const retries = Object.fromEntries(Object.entries(imageRetries.value).filter(([id]) => visibleIds.has(id)))
  if (Object.keys(retries).length !== Object.keys(imageRetries.value).length) imageRetries.value = retries
  emit('artwork-window', window)
  for (const item of pending) emit('ensure-artwork', item)
}, { immediate: true })
watch(() => props.active, active => { if (active) void nextTick(grid.refresh) })
onUnmounted(() => { thumbnails.dispose(); observer?.disconnect(); emit('artwork-window', { visible: [], nearby: [] }) })

function focusAlbum(albumId: string): boolean {
  const button = [...(root.value?.querySelectorAll<HTMLButtonElement>('[data-local-album-id]') ?? [])].find(item => item.dataset.localAlbumId === albumId)
  if (!button) return false
  button.focus({ preventScroll: true }); return true
}
defineExpose({ focusAlbum, refresh: grid.refresh })
</script>

<template>
  <div v-if="!props.readAvailable" class="empty-state roon-library-state" role="status">
    <i class="bi bi-folder2-open empty-glyph" aria-hidden="true"></i><h3>专辑浏览服务尚未接入</h3><p>可在整理工作台继续查看现有本地音乐功能。</p>
    <button type="button" class="secondary-button" :disabled="!props.managementAvailable" @click="requestWorkbench({ action: 'overview' })">打开整理工作台</button>
  </div>
  <div v-else-if="props.initialLoading && !props.albums.length" class="empty-state roon-library-state" role="status"><span class="loading-line"></span><p>正在读取本地专辑…</p></div>
  <div v-else-if="props.error && !props.albums.length" class="empty-state roon-library-state" role="alert">
    <i class="bi bi-folder2-open empty-glyph" aria-hidden="true"></i><h3>本地专辑暂时无法读取</h3><p>{{ props.error }}</p><button type="button" class="secondary-button" @click="emit('retry')">重试读取</button>
  </div>
  <div v-else-if="!props.albums.length" class="empty-state roon-library-state" role="status">
    <i class="bi bi-disc empty-glyph" aria-hidden="true"></i><h3>{{ props.searching || props.filtering ? '没有匹配的专辑' : props.loaded ? '本地音乐库还没有专辑' : '尚未读取本地专辑' }}</h3>
    <p>{{ props.searching || props.filtering ? '换一个关键词或筛选条件，查看其他专辑。' : props.loaded ? '在整理工作台加入目录并读取音乐后，专辑会显示在这里。' : '重新读取后可查看已有专辑。' }}</p>
    <button v-if="props.loaded && !props.searching && !props.filtering" type="button" class="secondary-button" :disabled="!props.managementAvailable" @click="requestWorkbench({ action: 'overview' })">打开整理工作台</button>
    <button v-else-if="!props.loaded" type="button" class="secondary-button" @click="emit('retry')">重新读取</button>
  </div>
  <template v-else>
    <div ref="root" v-bind="grid.attrs.value" :style="grid.rootStyle.value" class="roon-album-grid local-album-grid" aria-label="本地专辑" @focusin="grid.onFocusIn" @focusout="grid.onFocusOut" @keydown="grid.onKeydown">
      <div v-for="{ item: album, index, style } in grid.rendered.value" :key="album.id" :data-grid-index="index" :style="style" class="local-album-grid-entry">
        <button type="button" class="roon-album-card" :class="{ 'is-selected': props.selectedAlbumIds?.has(album.id) }" :data-local-album-id="album.id" :aria-label="`查看 ${album.title}，${localAlbumIdentity(album)}${props.selectedAlbumIds?.has(album.id) ? '，已选择' : ''}`" @click="emit('select', album, $event)">
          <LocalAlbumArtwork :key="`${album.id}:${imageRetries[album.id] ?? 0}`" class="roon-artwork roon-album-art" :artwork="displayedArtworkFor(album)" :trace-key="desktopArtworkKey(requestIdentity(album))" :source-state="artworkCoverage(album)" :alt="`${album.title} 封面`" @image-error="onImageError(album)" />
          <span class="roon-album-copy"><strong :title="album.title">{{ album.title }}</strong><small>{{ album.artists.join('、') || '未提供专辑艺术家' }}</small><small :title="localAlbumIdentity(album)">{{ localAlbumIdentity(album) }}</small><small v-if="localAlbumIssueLabel(album.statuses)" class="local-album-issue" :title="localAlbumIssueLabel(album.statuses)">{{ localAlbumIssueLabel(album.statuses) }}</small></span>
        </button>
        <button v-if="props.selectedAlbumIds" type="button" class="secondary-button local-album-select-action" role="checkbox" :aria-checked="props.selectedAlbumIds.has(album.id)" :aria-label="`${props.selectedAlbumIds.has(album.id) ? '取消选择' : '选择'} ${album.title}，${localAlbumIdentity(album)}`" :title="props.selectedAlbumIds.has(album.id) ? '取消选择这张专辑' : '选择这张专辑；Shift 连续选择'" @click.stop="emit('toggle-selection', album, $event)"><i :class="props.selectedAlbumIds.has(album.id) ? 'bi bi-check2-square' : 'bi bi-square'" aria-hidden="true"></i></button>
        <button v-if="hasImageError(album) || needsExplicitRetry(album)" type="button" class="secondary-button local-album-cover-action" :disabled="!canRetryArtwork(album)" :aria-label="`重试读取 ${album.title} 的封面`" @click="retryArtwork(album)">重试封面</button>
        <button v-else-if="artworkCoverage(album) === 'missing' || artworkCoverage(album) === 'unknown' || artworkFor(album).status === 'missing'" type="button" class="secondary-button local-album-cover-action" :disabled="!props.managementAvailable" :aria-label="`为 ${album.title} ${artworkCoverage(album) === 'unknown' ? '查找或选择' : '选择'}封面`" @click="requestWorkbench(localAlbumWorkbenchRequest(album, 'artwork'))">{{ artworkCoverage(album) === 'unknown' ? '查找封面' : '选择封面' }}</button>
      </div>
    </div>
    <div v-if="props.hasMore" ref="sentinel" class="roon-library-more" aria-live="polite">
      <span v-if="props.loadingMore" role="status">正在加载更多专辑…</span>
      <template v-else-if="props.loadMoreError"><span>{{ props.loadMoreError }}</span><button type="button" class="text-button" @click="emit('load-more')">重试加载</button></template>
      <button v-else type="button" class="text-button" :disabled="props.initialLoading" @click="emit('load-more')">加载更多专辑</button>
      <span>已显示 {{ props.albums.length }} / {{ props.total }}</span>
    </div>
  </template>
</template>

<style scoped>
.local-album-grid.roon-album-grid { grid-template-columns: repeat(5, minmax(0, 1fr)); }
.local-album-grid-entry { min-width: 0; position: relative; }
.local-album-grid-entry > .roon-album-card { width: 100%; height: 100%; align-content: start; }
.local-album-grid-entry .roon-album-copy { align-self: start; }
.local-album-cover-action { position: absolute; z-index: 3; top: 8px; right: 8px; min-height: 44px; }
.local-album-select-action { position: absolute; z-index: 3; top: 8px; left: 8px; display: inline-flex; width: 44px; height: 44px; padding: 0; align-items: center; justify-content: center; }
.local-album-grid-entry:has(.local-album-select-action) .local-album-cover-action { max-width: calc(100% - 72px); }
.roon-album-card.is-selected .roon-album-art { outline: 2px solid var(--mb-accent); outline-offset: 3px; }
.local-album-grid button:focus-visible { outline: 2px solid var(--mb-accent); outline-offset: 4px; border-radius: 10px; }
.roon-library-state .secondary-button { margin-top: 14px; }
@container (max-width: 1090px) { .local-album-grid.roon-album-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
@container (max-width: 850px) { .local-album-grid.roon-album-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@container (max-width: 620px) { .local-album-grid.roon-album-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@container (max-width: 340px) { .local-album-grid.roon-album-grid { grid-template-columns: minmax(0, 1fr); } }
@media (prefers-reduced-motion: reduce) { .roon-album-card:deep(.roon-album-art) { transition: none; transform: none; } }
</style>
