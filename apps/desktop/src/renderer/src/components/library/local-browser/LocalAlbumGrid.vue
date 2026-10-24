<script setup lang="ts">
import { desktopArtworkKey } from '../../../../../../../../packages/bridge-core/src/shared/desktop-artwork-trace.js'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { LocalAlbumArtworkInvalidation, LocalAlbumArtworkState, LocalAlbumArtworkWindow, LocalAlbumSummary } from '../../../composables/application/local-library-browser/types.js'
import { createGridArtworkCache, GRID_ARTWORK_DECODED_BYTES, type GridArtworkSource } from '../../../composables/application/local-library-browser/grid-artwork-cache.js'
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
  refreshing?: boolean
  loadingMore?: boolean
  hasMore?: boolean
  total?: number
  error?: string
  loadMoreError?: string
  searching?: boolean
  filtering?: boolean
  readAvailable?: boolean
  managementAvailable?: boolean
  showManagementActions?: boolean
  emptyTitle?: string
  emptyCopy?: string
  selectedAlbumIds?: ReadonlySet<string>
  artworkPrefetchRows?: number
  showPageStatus?: boolean
}>(), {
  active: true, loaded: false, initialLoading: false, refreshing: false, loadingMore: false, hasMore: false,
  total: 0, error: '', loadMoreError: '', searching: false, filtering: false,
  readAvailable: true, managementAvailable: true, showManagementActions: true, artworkPrefetchRows: 3, showPageStatus: true,
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
type DisplayedImageEvent = Readonly<{ identityKey: string | undefined; src: string }>
const failedImages = ref<Record<string, { identityKey: string; src: string }>>({}), imageRetries = ref<Record<string, number>>({})
// 只在本次兴趣窗口消费一次资格；成功图离窗重入可复用持久缓存，同窗淘汰不循环。
const automaticRequests = ref(new Map<string, { identity: string; observed: boolean; priority: number; failed: boolean }>())
let observedInvalidationEpoch = 0
let observer: IntersectionObserver | undefined
let observerRoot: Element | null | undefined
let automaticPageRequest: string | null = null
let disposed = false
const idleArtwork: LocalAlbumArtworkState = { status: 'idle', dataUrl: null, error: '', canRetry: false }
const grid = useGridWindow(computed(() => props.albums), root, {
  nearbyRows: props.artworkPrefetchRows,
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
function persistentGrid(image: LocalAlbumArtworkState): LocalAlbumArtworkState['grid'] {
  return image.grid && [image.grid.width, image.grid.height].every(value => Number.isSafeInteger(value) && value > 0 && value <= 512) ? image.grid : undefined
}
const thumbnailDimension = computed(() => {
  const width = Number.parseFloat(grid.rendered.value[0]?.style?.width ?? '')
  const pixels = (Number.isFinite(width) && width > 0 ? width : 256) * (typeof window === 'undefined' ? 2 : Math.max(1, window.devicePixelRatio || 1))
  return [128, 256, 384, 512].find(size => size >= pixels) ?? 512
})
// 预取只准备数据。解码引用按实际DOM槽位预留，不能因第25张近邻完成而翻转整窗路线。
const displayPlan = ref<{ routes: ReadonlyMap<string, number>; dimension: number }>({ routes: new Map(), dimension: 512 })
watch(() => JSON.stringify([thumbnailDimension.value, ...grid.rendered.value.map(entry => requestIdentity(entry.item))]), () => {
  const entries = grid.rendered.value, visible = new Set(grid.visible.value.map(entry => entry.item.id)), previous = displayPlan.value.routes
  const dimension = [512, 384, 256, 128].find(size => size <= thumbnailDimension.value && size * size * 4 * entries.length <= GRID_ARTWORK_DECODED_BYTES) ?? 128
  const fallbackBytes = dimension * dimension * 4, routes = new Map<string, number>()
  let remaining = GRID_ARTWORK_DECODED_BYTES - fallbackBytes * entries.length
  const candidates = entries.map(({ item }) => {
    const image = artworkFor(item), source = persistentGrid(image), identity = requestIdentity(item)
    // 未完成的槽位按512上限预留；同窗完成只消费预留，不迫使成功图改src。
    const bytes = source ? source.width * source.height * 4 : 512 * 512 * 4
    return { item, identity, bytes, eligible: !!source || image.status === 'idle' || image.status === 'loading' }
  }).sort((left, right) => Number(left.bytes > fallbackBytes) - Number(right.bytes > fallbackBytes)
    || Number(visible.has(right.item.id)) - Number(visible.has(left.item.id))
    || Number((previous.get(right.identity) ?? 0) > 0) - Number((previous.get(left.identity) ?? 0) > 0))
  for (const candidate of candidates) {
    const cost = candidate.bytes - fallbackBytes
    if (candidate.eligible && cost <= remaining) { routes.set(candidate.identity, candidate.bytes); remaining -= cost }
    else routes.set(candidate.identity, 0)
  }
  displayPlan.value = { routes, dimension }
}, { immediate: true })
const directGridAlbums = computed<ReadonlySet<string>>(() => new Set(grid.rendered.value
  .filter(({ item }) => {
    const source = persistentGrid(artworkFor(item)), reservation = displayPlan.value.routes.get(requestIdentity(item)) ?? 0
    return !!source && source.width * source.height * 4 <= reservation
  })
  .map(({ item }) => item.id)))
function displayedArtworkFor(album: LocalAlbumSummary): LocalAlbumArtworkState {
  void thumbnailRevision.value
  const original = artworkFor(album)
  if (original.grid && directGridAlbums.value.has(album.id)) return { ...original, dataUrl: original.grid.dataUrl }
  if (original.status !== 'ready' || !(original.grid?.dataUrl ?? original.dataUrl) || !(original.grid ?? original.display)) return original
  const thumbnail = thumbnails.get(requestIdentity(album))
  return thumbnail.status === 'ready' ? { ...original, dataUrl: thumbnail.dataUrl } : thumbnail.status === 'error'
    ? { status: 'error', dataUrl: null, error: '封面展示暂时失败，可重试。', canRetry: true }
    : { status: 'loading', dataUrl: null, error: '', canRetry: false }
}
function syncThumbnails(): void {
  if (!props.readAvailable) { thumbnails.setWindow([]); return }
  if (!props.active) return
  const visible = new Set(grid.visible.value.map(entry => entry.item.id)), sources: GridArtworkSource[] = []
  let reserved = 0, fallbackSlots = 0
  for (const { item: album } of grid.rendered.value) {
    const image = artworkFor(album)
    const reservation = displayPlan.value.routes.get(requestIdentity(album)) ?? 0
    if (reservation && (directGridAlbums.value.has(album.id) || image.status === 'idle' || image.status === 'loading')) reserved += reservation
    else fallbackSlots++
    if (image.status !== 'ready' || directGridAlbums.value.has(album.id)) continue
    const source = image.grid ?? (image.display && image.dataUrl ? { ...image.display, dataUrl: image.dataUrl } : null)
    if (source) sources.push({ identity: requestIdentity(album), dataUrl: source.dataUrl, display: source, visible: visible.has(album.id) })
  }
  thumbnails.setWindow(sources, displayPlan.value.dimension, fallbackSlots, Math.max(0, GRID_ARTWORK_DECODED_BYTES - reserved))
}
watch(() => [props.active, props.readAvailable, props.artworkInvalidation?.epoch ?? 0, displayPlan.value,
  ...grid.visible.value.map(entry => entry.item.id),
  ...grid.rendered.value.map(({ item: album }) => `${requestIdentity(album)}:${artworkFor(album).status}:${artworkFor(album).display?.sha256 ?? ''}:${artworkFor(album).grid?.sha256 ?? ''}:${artworkFor(album).grid?.width ?? 0}:${artworkFor(album).grid?.height ?? 0}`)], syncThumbnails, { immediate: true })

function artworkCoverage(album: LocalAlbumSummary): NonNullable<LocalAlbumSummary['artworkState']> {
  return album.artworkState ?? (album.artworkAvailable ? 'available' : 'missing')
}
function hasImageError(album: LocalAlbumSummary): boolean {
  const image = artworkFor(album), displayed = displayedArtworkFor(album), failed = failedImages.value[album.id]
  return displayed.status === 'error' || image.status === 'error'
    || !!failed && failed.identityKey === requestIdentity(album) && failed.src === displayed.dataUrl
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
function currentImageEvent(album: LocalAlbumSummary, image: DisplayedImageEvent): boolean {
  return image.identityKey === requestIdentity(album) && image.src === displayedArtworkFor(album).dataUrl
}
function onImageError(album: LocalAlbumSummary, image: DisplayedImageEvent): void {
  if (!currentImageEvent(album, image)) return
  failedImages.value = { ...failedImages.value, [album.id]: { identityKey: requestIdentity(album), src: image.src } }
}
function onImageLoad(album: LocalAlbumSummary, image: DisplayedImageEvent): void {
  if (!currentImageEvent(album, image) || failedImages.value[album.id]?.identityKey !== image.identityKey) return
  const failures = { ...failedImages.value }; delete failures[album.id]; failedImages.value = failures
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
  if (!props.showManagementActions || !props.managementAvailable) return
  emit('workbench', request)
}
function requestMore(manual = false): void {
  if (disposed || !props.active || !props.readAvailable || !props.loaded || !props.hasMore || props.initialLoading || props.refreshing || props.loadingMore || !manual && !!props.loadMoreError) return
  const boundary = JSON.stringify([props.albums.length, props.albums[0] && requestIdentity(props.albums[0]), props.albums.at(-1) && requestIdentity(props.albums.at(-1)!)])
  if (!manual && automaticPageRequest === boundary) return
  automaticPageRequest = boundary; observer?.disconnect(); emit('load-more')
}
function observeSentinel(): void {
  observer?.disconnect()
  if (disposed || !sentinel.value || typeof IntersectionObserver === 'undefined') return
  const scrollRoot = root.value?.closest<HTMLElement>('.content-scroll') ?? null
  if (!observer || observerRoot !== scrollRoot) {
    observerRoot = scrollRoot
    observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) requestMore() }, { root: scrollRoot, rootMargin: '640px 0px', threshold: 0 })
  }
  if (props.active && props.hasMore && !props.loadingMore && !props.initialLoading && !props.refreshing && !props.loadMoreError && props.readAvailable) observer.observe(sentinel.value)
}
function continueVisibleWindow(): void {
  observeSentinel()
  const last = Math.max(-1, ...grid.visible.value.map(entry => entry.index), ...grid.nearby.value.map(entry => entry.index))
  if (last >= props.albums.length - 1) requestMore()
}
onMounted(continueVisibleWindow)
watch(() => [props.active, props.readAvailable, props.loaded, props.hasMore, props.initialLoading, props.refreshing, props.loadingMore, props.loadMoreError,
  props.albums, ...grid.visible.value.map(entry => entry.index), ...grid.nearby.value.map(entry => entry.index)], () => {
  if (!props.active || !props.readAvailable || props.initialLoading || props.refreshing) automaticPageRequest = null
  void nextTick(continueVisibleWindow)
}, { immediate: true })
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
  const failures = Object.fromEntries(Object.entries(failedImages.value).filter(([id, image]) => visibleIds.has(id) && next.get(id)?.identity === image.identityKey))
  if (Object.keys(failures).length !== Object.keys(failedImages.value).length) failedImages.value = failures
  const retries = Object.fromEntries(Object.entries(imageRetries.value).filter(([id]) => visibleIds.has(id)))
  if (Object.keys(retries).length !== Object.keys(imageRetries.value).length) imageRetries.value = retries
  emit('artwork-window', window)
  for (const item of pending) emit('ensure-artwork', item)
}, { immediate: true })
watch(() => props.active, active => { if (active) void nextTick(grid.refresh) })
onUnmounted(() => { disposed = true; thumbnails.dispose(); observer?.disconnect(); emit('artwork-window', { visible: [], nearby: [] }) })

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
    <button v-if="props.showManagementActions" type="button" class="secondary-button" :disabled="!props.managementAvailable" @click="requestWorkbench({ action: 'overview' })">打开整理工作台</button>
  </div>
  <div v-else-if="props.initialLoading && !props.albums.length" class="empty-state roon-library-state" role="status"><span class="loading-line"></span><p>正在读取本地专辑…</p></div>
  <div v-else-if="props.error && !props.albums.length" class="empty-state roon-library-state" role="alert">
    <i class="bi bi-folder2-open empty-glyph" aria-hidden="true"></i><h3>本地专辑暂时无法读取</h3><p>{{ props.error }}</p><button type="button" class="secondary-button" @click="emit('retry')">重试读取</button>
  </div>
  <div v-else-if="!props.albums.length" class="empty-state roon-library-state" role="status">
    <i class="bi bi-disc empty-glyph" aria-hidden="true"></i><h3>{{ props.searching || props.filtering ? '没有匹配的专辑' : props.emptyTitle || (props.loaded ? '本地音乐库还没有专辑' : '尚未读取本地专辑') }}</h3>
    <p>{{ props.searching || props.filtering ? '换一个关键词或筛选条件，查看其他专辑。' : props.emptyCopy || (props.loaded ? '在整理工作台加入目录并读取音乐后，专辑会显示在这里。' : '重新读取后可查看已有专辑。') }}</p>
    <button v-if="props.showManagementActions && props.loaded && !props.searching && !props.filtering" type="button" class="secondary-button" :disabled="!props.managementAvailable" @click="requestWorkbench({ action: 'overview' })">打开整理工作台</button>
    <button v-else-if="!props.loaded" type="button" class="secondary-button" @click="emit('retry')">重新读取</button>
  </div>
  <template v-else>
    <div ref="root" v-bind="grid.attrs.value" :style="grid.rootStyle.value" class="roon-album-grid local-album-grid" aria-label="本地专辑" :aria-busy="props.initialLoading || props.refreshing || props.loadingMore" @focusin="grid.onFocusIn" @focusout="grid.onFocusOut" @keydown="grid.onKeydown">
      <div v-for="{ item: album, index, style } in grid.rendered.value" :key="album.id" :data-grid-index="index" :style="style" class="local-album-grid-entry">
        <button type="button" class="roon-album-card" :class="{ 'is-selected': props.selectedAlbumIds?.has(album.id) }" :data-local-album-id="album.id" :aria-label="`查看 ${album.title}，${localAlbumIdentity(album)}${props.selectedAlbumIds?.has(album.id) ? '，已选择' : ''}`" @click="emit('select', album, $event)">
          <LocalAlbumArtwork :key="`${album.id}:${imageRetries[album.id] ?? 0}`" class="roon-artwork roon-album-art" :artwork="displayedArtworkFor(album)" :identity-key="requestIdentity(album)" :trace-key="desktopArtworkKey(requestIdentity(album))" :source-state="artworkCoverage(album)" :alt="`${album.title} 封面`" eager @image-error="onImageError(album, $event)" @image-load="onImageLoad(album, $event)" />
          <span class="roon-album-copy"><strong :title="album.title">{{ album.title }}</strong><small>{{ album.artists.join('、') || '未提供专辑艺术家' }}</small><small :title="localAlbumIdentity(album)">{{ localAlbumIdentity(album) }}</small><small v-if="localAlbumIssueLabel(album.statuses)" class="local-album-issue" :title="localAlbumIssueLabel(album.statuses)">{{ localAlbumIssueLabel(album.statuses) }}</small></span>
        </button>
        <button v-if="props.selectedAlbumIds" type="button" class="secondary-button local-album-select-action" role="checkbox" :aria-checked="props.selectedAlbumIds.has(album.id)" :aria-label="`${props.selectedAlbumIds.has(album.id) ? '取消选择' : '选择'} ${album.title}，${localAlbumIdentity(album)}`" :title="props.selectedAlbumIds.has(album.id) ? '取消选择这张专辑' : '选择这张专辑；Shift 连续选择'" @click.stop="emit('toggle-selection', album, $event)"><i :class="props.selectedAlbumIds.has(album.id) ? 'bi bi-check2-square' : 'bi bi-square'" aria-hidden="true"></i></button>
        <button v-if="hasImageError(album) || needsExplicitRetry(album)" type="button" class="secondary-button local-album-cover-action" :disabled="!canRetryArtwork(album)" :aria-label="`重试读取 ${album.title} 的封面`" @click="retryArtwork(album)">重试封面</button>
        <button v-else-if="props.showManagementActions && (artworkCoverage(album) === 'missing' || artworkCoverage(album) === 'unknown' || artworkFor(album).status === 'missing')" type="button" class="secondary-button local-album-cover-action" :disabled="!props.managementAvailable" :aria-label="`为 ${album.title} ${artworkCoverage(album) === 'unknown' ? '查找或选择' : '选择'}封面`" @click="requestWorkbench(localAlbumWorkbenchRequest(album, 'artwork'))">{{ artworkCoverage(album) === 'unknown' ? '查找封面' : '选择封面' }}</button>
      </div>
    </div>
    <div v-if="props.hasMore" ref="sentinel" class="roon-library-more" :class="{ 'local-album-page-sentinel': !props.showPageStatus }" :aria-live="props.showPageStatus ? 'polite' : undefined">
      <template v-if="props.showPageStatus">
        <span v-if="props.loadingMore" role="status">正在加载更多专辑…</span>
        <template v-else-if="props.loadMoreError"><span role="alert">{{ props.loadMoreError }}</span><button type="button" class="text-button" :disabled="!props.active || !props.readAvailable || props.initialLoading || props.refreshing" @click="requestMore(true)">重试加载</button></template>
        <span v-else>专辑会继续自动载入</span>
        <span>已载入 {{ props.albums.length }} / {{ props.total }} 张专辑</span>
      </template>
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
.local-album-page-sentinel { min-height: 1px; height: 1px; margin: 0; padding: 0; }
@container (max-width: 1090px) { .local-album-grid.roon-album-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
@container (max-width: 850px) { .local-album-grid.roon-album-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@container (max-width: 620px) { .local-album-grid.roon-album-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@container (max-width: 340px) { .local-album-grid.roon-album-grid { grid-template-columns: minmax(0, 1fr); } }
@media (prefers-reduced-motion: reduce) { .roon-album-card:deep(.roon-album-art) { transition: none; transform: none; } }
</style>
