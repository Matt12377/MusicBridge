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
  if (current) assertRoonPageEpoch(current, next)
  nextRoonPageOffset(next)
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
    ...(next.sourceEpoch !== undefined ? { sourceEpoch: next.sourceEpoch } : {}),
    ...(next.complete !== undefined ? { complete: next.complete } : {}),
    ...(next.nextOffset !== undefined ? { nextOffset: next.nextOffset } : {}),
    ...(next.playbackContextHandle !== undefined ? { playbackContextHandle: next.playbackContextHandle } : {}),
  }
}

export class RoonPageEpochChanged extends Error {
  constructor() { super('Roon 读取上下文已变化，请重新读取。') }
}

/** 缺字段的旧协议可继续使用，但已知身份不能与未知身份混合。 */
export function assertRoonPageEpoch(current: RoonLibraryPage, next: RoonLibraryPage): void {
  if (current.sourceEpoch !== next.sourceEpoch) throw new RoonPageEpochChanged()
  if (current.playbackContextHandle !== next.playbackContextHandle) {
    throw new Error('Roon 播放上下文已变化，请重新读取。')
  }
}

export function nextRoonPageOffset(page: RoonLibraryPage): number {
  const offset = page.nextOffset ?? page.offset + page.limit
  if (!Number.isSafeInteger(offset) || offset < 0 || (page.hasMore === true && offset <= page.offset)) {
    throw new Error('Roon 分页游标异常，请重新读取。')
  }
  return offset
}

/** 请求参数仍使用 offset/limit；新代第 N 页只能丢弃并有界重读第一页。 */
export async function readRoonDatasetPage(
  current: RoonLibraryPage | undefined,
  request: { offset: number; limit: number },
  read: (page: { offset: number; limit: number }) => Promise<RoonLibraryPage>,
  isCurrent: () => boolean,
  onRestart?: () => void,
): Promise<{ page: RoonLibraryPage; restarted: boolean } | undefined> {
  const page = await read(request)
  if (!isCurrent()) return undefined
  if (page.offset !== request.offset) throw new Error('分页响应异常，点击重试')
  nextRoonPageOffset(page)
  if (request.offset === 0 || !current) return { page, restarted: false }
  try { assertRoonPageEpoch(current, page) }
  catch (error) {
    if (!(error instanceof RoonPageEpochChanged) || !onRestart) throw error
    onRestart()
    const first = await read({ offset: 0, limit: request.limit })
    if (!isCurrent()) return undefined
    if (first.offset !== 0) throw new Error('分页响应异常，点击重试')
    nextRoonPageOffset(first)
    assertRoonPageEpoch(page, first)
    return { page: first, restarted: true }
  }
  return { page, restarted: false }
}

/** 替换式选择器记录访问过的真实游标，上一页不推算原始行步长。 */
export class RoonPageCursorHistory {
  private key = ''
  private offsets: number[] = []
  record(key: string, page: RoonLibraryPage): void {
    if (key !== this.key || page.offset === 0) { this.key = key; this.offsets = [] }
    const existing = this.offsets.indexOf(page.offset)
    if (existing >= 0) this.offsets = this.offsets.slice(0, existing + 1)
    else this.offsets.push(page.offset)
  }
  previous(page: RoonLibraryPage | undefined): number {
    if (!page) return 0
    const index = this.offsets.indexOf(page.offset)
    return index > 0 ? this.offsets[index - 1]! : Math.max(0, page.offset - page.limit)
  }
  reset(): void { this.key = ''; this.offsets = [] }
}
