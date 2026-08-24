import type { Page, PageRequest, TrackSummary } from '@music-bridge/contracts'

export type CollectionPageLoader = (page: PageRequest) => Promise<Page<TrackSummary>>

const COLLECTION_PAGE_SIZE = 20

export interface ProgressiveCollectionBatch {
  tracks: readonly TrackSummary[]
  offset: number
  nextOffset: number
  total: number
  loadedCount: number
  hasMore: boolean
}

export interface ProgressiveCollectionLoader {
  next: () => Promise<ProgressiveCollectionBatch | undefined>
  cancel: () => void
}

/**
 * 按 Provider 顺序逐页读取集合。第一次 next() 只请求/返回第一页，调用方可以先开始播放，
 * 后续页面由调用方在后台继续消费；代次失效或显式 cancel 后不会再产出结果。
 */
export function createProgressiveCollectionLoader(
  loadPage: CollectionPageLoader,
  pageSize = COLLECTION_PAGE_SIZE,
  initialPage?: Page<TrackSummary>,
): ProgressiveCollectionLoader {
  const cancellation = new AbortController()
  const seen = new Set<string>()
  let pendingInitialPage = initialPage
  let nextOffset = initialPage?.offset ?? 0
  let total = initialPage?.total ?? 0
  let loadedCount = 0
  let done = false

  const next = async (): Promise<ProgressiveCollectionBatch | undefined> => {
    if (done || cancellation.signal.aborted) return undefined
    const page = pendingInitialPage ?? await loadPage({ offset: nextOffset, limit: pageSize })
    pendingInitialPage = undefined
    if (cancellation.signal.aborted) return undefined

    const effectiveLimit = page.limit > 0 ? page.limit : pageSize
    const pageNextOffset = Math.max(page.offset + 1, page.offset + effectiveLimit)
    nextOffset = pageNextOffset
    total = Math.max(total, page.total, page.offset + page.items.length)
    const tracks = page.items.filter((track) => {
      if (seen.has(track.id)) return false
      seen.add(track.id)
      return true
    })
    loadedCount += tracks.length
    const hasMore = page.hasMore && page.items.length > 0
    if (!hasMore) done = true

    return {
      tracks,
      offset: page.offset,
      nextOffset: pageNextOffset,
      total,
      loadedCount,
      hasMore,
    }
  }

  return {
    next,
    cancel: () => {
      cancellation.abort()
      done = true
    },
  }
}

/**
 * 独立于已渲染页面构建播放集合。
 * 取消与代次由调用方负责；本模块只保证顺序、有界请求和幂等合并。
 */
export async function loadCollectionTracks(
  loadPage: CollectionPageLoader,
  pageSize = COLLECTION_PAGE_SIZE,
): Promise<readonly TrackSummary[]> {
  const tracks: TrackSummary[] = []
  const loader = createProgressiveCollectionLoader(loadPage, pageSize)
  while (true) {
    const batch = await loader.next()
    if (!batch) return tracks
    tracks.push(...batch.tracks)
    if (!batch.hasMore) return tracks
  }
}
