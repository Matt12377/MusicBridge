import { MAX_PLAYBACK_QUEUE_ITEMS, type PageRequest, type RoonLibraryItem, type RoonLibraryPage } from '@music-bridge/contracts'
import { assertRoonPageEpoch, nextRoonPageOffset, RoonPageEpochChanged } from './composables/roonLibraryPagination.js'

/** 只使用当前浏览上下文；完整读取后才派发，不将跨代集合当成完整队列。 */
export async function collectRoonPlaybackContext(
  track: RoonLibraryItem,
  initial?: RoonLibraryPage,
  loadPage?: (page: PageRequest) => Promise<RoonLibraryPage>,
  isCurrent: () => boolean = () => true,
): Promise<readonly RoonLibraryItem[]> {
  if (!initial?.items.some((item) => item.reference === track.reference)) return [track]
  const tracks = new Map<string, RoonLibraryItem>()
  let page = initial, restarted = false
  const current = () => { if (!isCurrent()) throw new Error('本地播放请求已取消') }
  for (;;) {
    current()
    nextRoonPageOffset(page)
    for (const item of page.items) if (item.kind === 'track') tracks.set(item.reference, item)
    if (tracks.size > MAX_PLAYBACK_QUEUE_ITEMS) throw new Error('本地播放队列超过容量限制，请选择较小的歌单。')
    if (!page.hasMore) {
      if (page.complete === false) throw new Error('本地曲目列表尚未读取完整，请重试。')
      if (!tracks.has(track.reference)) throw new Error('所选曲目已变化，请重新读取后选择。')
      return [...tracks.values()]
    }
    if (!loadPage || page.limit <= 0 || (page.items.length === 0 && page.nextOffset === undefined)) throw new Error('本地曲目列表尚未读取完整，请重试。')
    const offset = nextRoonPageOffset(page)
    if (offset >= MAX_PLAYBACK_QUEUE_ITEMS) throw new Error('本地播放队列超过容量限制，请选择较小的歌单。')
    const next = await loadPage({ offset, limit: page.limit })
    current()
    if (next.offset !== offset) throw new Error('本地曲目分页位置无效，请重新读取。')
    nextRoonPageOffset(next)
    try { assertRoonPageEpoch(page, next) }
    catch (error) {
      if (!(error instanceof RoonPageEpochChanged) || restarted) throw error
      restarted = true
      const first = await loadPage({ offset: 0, limit: page.limit })
      current()
      if (first.offset !== 0) throw new Error('本地曲目分页位置无效，请重新读取。')
      assertRoonPageEpoch(next, first)
      nextRoonPageOffset(first)
      tracks.clear()
      page = first
      continue
    }
    page = next
  }
}
