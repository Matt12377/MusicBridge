import { MAX_PLAYBACK_QUEUE_ITEMS, type Page, type PageRequest, type TrackSummary, type RoonLibraryPage } from '@music-bridge/contracts'
import { appendRoonPage, assertRoonPageEpoch, nextRoonPageOffset } from '../roonLibraryPagination.js'

/** 点击后先找到原选择，再交给原渐进队列；不能把后页点击悄悄改播第一页。 */
export async function readCatalogPlaybackPrefix(load: (page: PageRequest) => Promise<Page<TrackSummary>>, selectedId: string,
  current: () => boolean = () => true): Promise<Page<TrackSummary>> {
  const items: TrackSummary[] = [], seen = new Set<string>()
  let offset = 0
  while (offset < MAX_PLAYBACK_QUEUE_ITEMS) {
    const result = await load({ offset, limit: Math.min(100, MAX_PLAYBACK_QUEUE_ITEMS - offset) })
    if (!current()) throw new Error('这次歌曲选择已结束。')
    if (result.offset !== offset) throw new Error('歌曲分页位置已变化，请重新搜索后选择。')
    for (const item of result.items) if (!seen.has(item.id)) { seen.add(item.id); items.push(item) }
    const next = result.offset + result.limit
    if (items.some(item => item.id === selectedId)) return { items, offset: 0, limit: next, total: result.total, hasMore: result.hasMore }
    if (!result.hasMore || !result.items.length || next <= offset) break
    offset = next
  }
  throw new Error('所选歌曲已不在当前结果中，请重新读取后选择。')
}

export async function readCatalogRoonPlaybackPrefix(load: (page: PageRequest) => Promise<RoonLibraryPage>, reference: string,
  current: () => boolean = () => true): Promise<RoonLibraryPage> {
  let result: RoonLibraryPage | undefined, offset = 0
  while (offset < MAX_PLAYBACK_QUEUE_ITEMS) {
    const page = await load({ offset, limit: Math.min(100, MAX_PLAYBACK_QUEUE_ITEMS - offset) })
    if (!current()) throw new Error('这次 Roon 歌曲选择已结束。')
    if (page.offset !== offset) throw new Error('Roon 歌曲分页位置已变化，请重新搜索。')
    if (result) assertRoonPageEpoch(result, page)
    result = result ? appendRoonPage(result, page) : page
    if (result.items.some(item => item.kind === 'track' && item.reference === reference)) return result
    const next = nextRoonPageOffset(page)
    if (!page.hasMore || next <= offset) break
    offset = next
  }
  throw new Error('所选 Roon 歌曲已不在当前结果中，请重新读取后选择。')
}
