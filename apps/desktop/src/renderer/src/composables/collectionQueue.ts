import type { Page, PageRequest, TrackSummary } from '@music-bridge/contracts'

export type CollectionPageLoader = (page: PageRequest) => Promise<Page<TrackSummary>>

const COLLECTION_PAGE_SIZE = 20
const MAX_COLLECTION_TRACKS = 500
const COLLECTION_PAGE_CONCURRENCY = 4

/**
 * 独立于已渲染页面构建播放集合。
 * 取消与代次由调用方负责；本模块只保证顺序、有界请求和幂等合并。
 */
export async function loadCollectionTracks(
  loadPage: CollectionPageLoader,
  pageSize = COLLECTION_PAGE_SIZE,
): Promise<readonly TrackSummary[]> {
  const tracks: TrackSummary[] = []
  const seen = new Set<string>()

  const collectPage = (page: Page<TrackSummary>): void => {
    for (const track of page.items) {
      if (seen.has(track.id)) continue
      seen.add(track.id)
      tracks.push(track)
      if (tracks.length >= MAX_COLLECTION_TRACKS) break
    }
  }

  const firstPage = await loadPage({ offset: 0, limit: pageSize })
  collectPage(firstPage)
  if (!firstPage.hasMore || firstPage.items.length === 0 || tracks.length >= MAX_COLLECTION_TRACKS) {
    return tracks
  }

  const effectivePageSize = firstPage.limit > 0 ? firstPage.limit : pageSize
  const targetTrackCount = Math.min(firstPage.total, MAX_COLLECTION_TRACKS)
  const offsets: number[] = []
  for (let offset = effectivePageSize; offset < targetTrackCount; offset += effectivePageSize) {
    offsets.push(offset)
  }

  for (let start = 0; start < offsets.length; start += COLLECTION_PAGE_CONCURRENCY) {
    const pages = await Promise.all(
      offsets.slice(start, start + COLLECTION_PAGE_CONCURRENCY).map((offset) =>
        loadPage({ offset, limit: pageSize }),
      ),
    )
    for (const page of pages) {
      collectPage(page)
      if (tracks.length >= MAX_COLLECTION_TRACKS) return tracks
    }
  }

  return tracks
}
