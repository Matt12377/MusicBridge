import type { RoonLibraryItem, RoonLibraryPage } from '@music-bridge/contracts'

export interface RoonAutoLoadState {
  isIntersecting: boolean
  hasMore: boolean
  initialLoading: boolean
  loadingMore: boolean
  loadMoreError: string | null
}

export function shouldAutoLoadRoonPage(state: RoonAutoLoadState): boolean {
  return state.isIntersecting
    && state.hasMore
    && !state.initialLoading
    && !state.loadingMore
    && state.loadMoreError === null
}

export function emptyRoonPage(limit = 24): RoonLibraryPage {
  return { items: [], offset: 0, limit, total: 0, hasMore: false }
}

/** 将分页结果按运行期 opaque reference 去重，保持 Roon 返回顺序。 */
export function appendRoonPage(
  current: RoonLibraryPage | null,
  next: RoonLibraryPage,
): RoonLibraryPage {
  const previous = current?.items ?? []
  const seen = new Set(previous.map((item) => item.reference))
  const items: RoonLibraryItem[] = [...previous]
  for (const item of next.items) {
    if (seen.has(item.reference)) continue
    seen.add(item.reference)
    items.push(item)
  }
  return {
    items,
    offset: next.offset,
    limit: next.limit,
    ...(next.total !== undefined ? { total: next.total } : current?.total !== undefined ? { total: current.total } : {}),
    ...(next.hasMore !== undefined ? { hasMore: next.hasMore } : {}),
  }
}
