import { computed, getCurrentScope, nextTick, onScopeDispose, shallowReadonly, shallowRef } from 'vue'
import { logLibraryOperation } from '../../../../../../../../packages/bridge-core/src/shared/library-operation-log.js'
import { createLocalAlbumBrowserModel, LOCAL_ALBUM_ARTWORK_CACHE_BYTES, LOCAL_ALBUM_ARTWORK_COMPACT_CACHE_ENTRIES } from './model.js'
import type { LocalAlbumBrowserOptions, LocalAlbumSummary } from './types.js'
import type { LocalAlbumWorkbenchBatchTarget, LocalAlbumWorkbenchRequest } from '../../../components/library/local-browser/presentation.js'

/** Vue 只订阅纯读快照；生命周期由页面显式激活，离页与销毁不制造业务动作。 */
export function useLocalAlbumBrowser(options: LocalAlbumBrowserOptions) {
  const model = createLocalAlbumBrowserModel({ ...options, onChange: next => { snapshot.value = next; options.onChange?.(next) } })
  const snapshot = shallowRef(model.getSnapshot())
  if (getCurrentScope()) onScopeDispose(model.dispose)
  return { ...model, snapshot: shallowReadonly(snapshot), query: computed(() => snapshot.value.query), rootId: computed(() => snapshot.value.rootId), filter: computed(() => snapshot.value.filter),
    items: computed(() => snapshot.value.items), total: computed(() => snapshot.value.total), hasMore: computed(() => snapshot.value.hasMore), counts: computed(() => snapshot.value.counts),
    loaded: computed(() => snapshot.value.loaded), status: computed(() => snapshot.value.status), initialLoading: computed(() => snapshot.value.initialLoading), refreshing: computed(() => snapshot.value.refreshing),
    loadingMore: computed(() => snapshot.value.loadingMore), error: computed(() => snapshot.value.error), refreshError: computed(() => snapshot.value.refreshError), loadMoreError: computed(() => snapshot.value.loadMoreError),
    stale: computed(() => snapshot.value.stale), scrollTop: computed(() => snapshot.value.scrollTop), selectedAlbum: computed(() => snapshot.value.selectedAlbum), tracks: computed(() => snapshot.value.tracks),
    trackTotal: computed(() => snapshot.value.trackTotal), tracksHasMore: computed(() => snapshot.value.tracksHasMore), detailStatus: computed(() => snapshot.value.detailStatus),
    detailLoading: computed(() => snapshot.value.detailLoading), detailRefreshing: computed(() => snapshot.value.detailRefreshing), detailLoadingMore: computed(() => snapshot.value.detailLoadingMore),
    detailError: computed(() => snapshot.value.detailError), detailRefreshError: computed(() => snapshot.value.detailRefreshError), detailLoadMoreError: computed(() => snapshot.value.detailLoadMoreError),
    detailStale: computed(() => snapshot.value.detailStale), returnTarget: computed(() => snapshot.value.returnTarget), artwork: computed(() => snapshot.value.artwork),
    backgroundArtwork: computed(() => snapshot.value.backgroundArtwork) }
}

/** 两个入口共享总预算，离页保留有界压缩副本；网格卸载仍释放解码内存。 */
export function useLocalAlbumBrowserPages(options: LocalAlbumBrowserOptions) {
  const sharedOptions = { ...options,
    backgroundLoading: options.backgroundLoading ?? true,
    backgroundArtworkLoading: options.backgroundArtworkLoading ?? false,
    compactGridArtwork: options.compactGridArtwork ?? true,
    reuseLoadedOnActivate: options.reuseLoadedOnActivate ?? true,
    artworkCacheBytes: Math.min(options.artworkCacheBytes ?? LOCAL_ALBUM_ARTWORK_CACHE_BYTES, LOCAL_ALBUM_ARTWORK_CACHE_BYTES / 2),
    artworkCacheEntries: Math.min(options.artworkCacheEntries ?? LOCAL_ALBUM_ARTWORK_COMPACT_CACHE_ENTRIES, LOCAL_ALBUM_ARTWORK_COMPACT_CACHE_ENTRIES) }
  const library = useLocalAlbumBrowser(sharedOptions), coverDrop = useLocalAlbumBrowser(sharedOptions)
  const page = (current: ReturnType<typeof useLocalAlbumBrowser>, other: ReturnType<typeof useLocalAlbumBrowser>) => ({
    ...current,
    activate: async () => {
      other.deactivate()
      const started = performance.now()
      await current.activate(); await nextTick()
      if (current.snapshot.value.active) logLibraryOperation('ui', 'albums.first-screen', current.loaded.value ? 'complete' : 'error', {
        elapsedMs: Math.max(0, performance.now() - started), count: current.items.value.length, total: current.total.value,
      })
    },
    deactivate: () => current.deactivate(),
  })
  return { localLibrary: page(library, coverDrop), coverDrop: page(coverDrop, library) }
}

export interface CoverDropPageIntent {
  action: LocalAlbumWorkbenchRequest['action']
  albums: readonly LocalAlbumWorkbenchBatchTarget[]
  /** 原浏览回复的显示快照，仅用于详情读口，不参与写入许可。 */
  focusedAlbum?: LocalAlbumSummary
}

/** 先冻结浏览描述符，原离开守门真正完成导航后才捕获；普通返回不重开或清理工作台。 */
export function createCoverDropPageEntry(options: {
  getView(): string
  isWorkbenchOpen?: () => boolean
  navigate(): void
  requestLeave(resume: () => void): boolean
  close(): boolean
  open(intent: CoverDropPageIntent): void
}) {
  let pending: Readonly<CoverDropPageIntent> | null = null, navigating: Readonly<CoverDropPageIntent> | null = null, disposed = false
  function deliver(intent: Readonly<CoverDropPageIntent>): void {
    if (disposed || pending !== intent || options.getView() !== 'coverdrop') return
    pending = null; options.open(intent)
  }
  function request(intent: CoverDropPageIntent): void {
    if (disposed) return
    const copy = structuredClone(intent)
    for (const album of copy.albums) { Object.freeze(album.artists); Object.freeze(album) }
    if (copy.focusedAlbum) { Object.freeze(copy.focusedAlbum.artists); Object.freeze(copy.focusedAlbum.statuses); Object.freeze(copy.focusedAlbum) }
    Object.freeze(copy.albums); const original = Object.freeze(copy)
    pending = original
    if (options.getView() === 'coverdrop') {
      if (options.requestLeave(() => deliver(original))) deliver(original)
      return
    }
    navigating = original
    try { options.navigate() } finally { navigating = null }
    deliver(original)
  }
  function beforeLeave(destination: string, resume: () => void): boolean {
    const original = destination === 'coverdrop' ? navigating : null
    if (!original) pending = null
    if (options.isWorkbenchOpen?.() === false) return true
    if (!options.requestLeave(() => {
      if (!options.close()) return
      resume()
      if (original) deliver(original)
    })) return false
    return options.close()
  }
  return { request, beforeLeave, dispose: () => { disposed = true; pending = navigating = null } }
}
