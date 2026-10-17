import { computed, getCurrentScope, onScopeDispose, shallowReadonly, shallowRef } from 'vue'
import { createLocalAlbumBrowserModel } from './model.js'
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
    detailStale: computed(() => snapshot.value.detailStale), returnTarget: computed(() => snapshot.value.returnTarget), artwork: computed(() => snapshot.value.artwork) }
}

/** 两个入口各有纯读页面状态，仍复用同一公开读口；仅当前页激活，封面缓存保原总上限。 */
export function useLocalAlbumBrowserPages(options: LocalAlbumBrowserOptions) {
  const library = useLocalAlbumBrowser(options), coverDrop = useLocalAlbumBrowser(options)
  const page = (current: ReturnType<typeof useLocalAlbumBrowser>, other: ReturnType<typeof useLocalAlbumBrowser>) => ({
    ...current,
    activate: () => { other.deactivate(true); return current.activate() },
    deactivate: () => current.deactivate(true),
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
