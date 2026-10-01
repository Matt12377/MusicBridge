import type { PageRequest, RoonLibraryPage } from '@music-bridge/contracts'

export interface PageCacheIdentity { scope: string; dataset: string; offset: number; limit: number }
export interface LibraryPageCache {
  peek: <T>(identity: PageCacheIdentity) => { value: T; stale: boolean; writtenAt: number } | undefined
  put: <T>(identity: PageCacheIdentity, value: T) => boolean
  evictDataset: (scope: string, dataset: string) => void
  clear: () => void
  dispose: () => void
  stats: () => { pages: number; bytes: number }
}
export interface PageCacheOwnerOptions { cache?: LibraryPageCache; getCacheScope?: () => string }
export function cacheIdentity(scope: string, dataset: string, page: PageRequest): PageCacheIdentity { return { scope, dataset, offset: page.offset, limit: page.limit } }

/** 只存已批准的公开页面值；请求、取消及响应状态仍归各页面 owner。 */
export function createLibraryPageCache(options: { now?: () => number; maxPages?: number; maxBytes?: number; maxDatasetPages?: number; freshMs?: number; maxAgeMs?: number } = {}): LibraryPageCache {
  const now = options.now ?? Date.now
  const maxPages = options.maxPages ?? 64, maxBytes = options.maxBytes ?? 8 * 1024 * 1024, maxDatasetPages = options.maxDatasetPages ?? 8
  const freshMs = options.freshMs ?? 30_000, maxAgeMs = options.maxAgeMs ?? 300_000
  const entries = new Map<string, { identity: PageCacheIdentity; body: string; bytes: number; writtenAt: number }>()
  let bytes = 0, disposed = false
  const key = (id: PageCacheIdentity) => JSON.stringify([id.scope, id.dataset, id.offset, id.limit])
  const remove = (id: string) => { const value = entries.get(id); if (value) { bytes -= value.bytes; entries.delete(id) } }
  const expire = () => { const current = now(); for (const [id, value] of entries) if (current - value.writtenAt > maxAgeMs || current < value.writtenAt) remove(id) }
  return {
    peek<T>(identity: PageCacheIdentity) {
      if (disposed) return
      expire()
      const id = key(identity), value = entries.get(id)
      if (!value) return
      entries.delete(id); entries.set(id, value)
      return { value: JSON.parse(value.body) as T, stale: now() - value.writtenAt >= freshMs, writtenAt: value.writtenAt }
    },
    put(identity, value) {
      if (disposed) return false
      expire()
      const id = key(identity)
      remove(id)
      let body: string
      try { body = JSON.stringify(value) } catch { return false }
      if (typeof body !== 'string') return false
      const size = new TextEncoder().encode(body).byteLength
      if (size > maxBytes || maxPages < 1 || maxDatasetPages < 1) return false
      entries.set(id, { identity: cacheIdentity(identity.scope, identity.dataset, identity), body, bytes: size, writtenAt: now() }); bytes += size
      const sameDataset = () => [...entries].filter(([, item]) => item.identity.scope === identity.scope && item.identity.dataset === identity.dataset)
      while (sameDataset().length > maxDatasetPages) remove(sameDataset()[0]![0])
      while (entries.size > maxPages || bytes > maxBytes) remove(entries.keys().next().value!)
      return entries.has(id)
    },
    evictDataset(scope, dataset) { for (const [id, item] of entries) if (item.identity.scope === scope && item.identity.dataset === dataset) remove(id) },
    clear() { entries.clear(); bytes = 0 },
    dispose() { disposed = true; entries.clear(); bytes = 0 },
    stats() { expire(); return { pages: entries.size, bytes } },
  }
}

/** 相同强代次的首页刷新可保留已读取尾页和它的真实游标；未知身份不能猜。 */
export function mergeRefreshedRoonPage(previous: RoonLibraryPage, first: RoonLibraryPage): RoonLibraryPage {
  if (!previous.sourceEpoch || previous.sourceEpoch !== first.sourceEpoch || previous.playbackContextHandle !== first.playbackContextHandle || previous.items.length <= first.items.length) return first
  const prefix = new Set(first.items.map(item => item.reference))
  return { ...previous, ...(first.total !== undefined ? { total: first.total } : {}), items: [...first.items, ...previous.items.filter(item => !prefix.has(item.reference))] }
}
