import type { Page, PageRequest, TrackSummary } from '@music-bridge/contracts'

export type CollectionPageLoader = (page: PageRequest) => Promise<Page<TrackSummary>>

const COLLECTION_PAGE_SIZE = 20
const MAX_COLLECTION_TRACKS = 500

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
  let offset = 0

  while (tracks.length < MAX_COLLECTION_TRACKS) {
    const page = await loadPage({ offset, limit: pageSize })
    for (const track of page.items) {
      if (seen.has(track.id)) continue
      seen.add(track.id)
      tracks.push(track)
      if (tracks.length >= MAX_COLLECTION_TRACKS) break
    }
    if (!page.hasMore || page.items.length === 0) break

    const nextOffset = page.offset + page.limit
    if (!Number.isSafeInteger(nextOffset) || nextOffset <= offset) break
    offset = nextOffset
  }

  return tracks
}
