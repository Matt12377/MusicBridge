import { MAX_PLAYBACK_QUEUE_ITEMS, type PageRequest, type RoonLibraryItem, type RoonLibraryPage } from '@music-bridge/contracts'

/** 只使用当前浏览上下文；补齐分页，避免专辑第二页成为意外的播放终点。 */
export async function collectRoonPlaybackContext(
  track: RoonLibraryItem,
  initial?: RoonLibraryPage,
  loadPage?: (page: PageRequest) => Promise<RoonLibraryPage>,
  isCurrent: () => boolean = () => true,
): Promise<readonly RoonLibraryItem[]> {
  if (!initial?.items.some((item) => item.reference === track.reference)) return [track]
  const tracks = new Map<string, RoonLibraryItem>()
  let page = initial
  for (;;) {
    if (!isCurrent()) throw new Error('本地播放请求已取消')
    for (const item of page.items) {
      if (item.kind === 'track') tracks.set(item.reference, item)
    }
    if (tracks.size > MAX_PLAYBACK_QUEUE_ITEMS) throw new Error('本地播放队列超过容量限制，请选择较小的歌单。')
    if (!page.hasMore) return [...tracks.values()]
    if (!loadPage || page.items.length === 0 || page.limit <= 0) throw new Error('本地曲目列表尚未读取完整，请重试。')
    const offset = page.offset + page.limit
    if (offset >= MAX_PLAYBACK_QUEUE_ITEMS) throw new Error('本地播放队列超过容量限制，请选择较小的歌单。')
    const next = await loadPage({ offset, limit: page.limit })
    if (next.offset !== offset) throw new Error('本地曲目分页位置无效，请重新读取。')
    page = next
  }
}
