import type { PageRequest, RoonLibraryPage } from '@music-bridge/contracts'
import { ref } from 'vue'
import type { PageCacheOwnerOptions } from './libraryPageCache.js'
import { useRoonCollection } from './useRoonCollection.js'
import type { LibraryReadOptions } from './libraryReadScope.js'

/** 页面内的 Roon 搜索和分页共享查询；不调用 Provider 或聚合搜索。 */
export function useRoonSearchCollection(
  kind: 'album' | 'artist',
  list: (page: PageRequest, context?: LibraryReadOptions) => Promise<RoonLibraryPage>,
  search: (query: string, page: PageRequest, kind: 'album' | 'artist', context?: LibraryReadOptions) => Promise<RoonLibraryPage>,
  formatError: (error: unknown) => string,
  debounceMs = 300,
  options: PageCacheOwnerOptions = {},
) {
  const query = ref('')
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false, pendingQuery = false
  const collection = useRoonCollection((page, context) => {
    const text = query.value.trim()
    return text ? search(text, page, kind, context) : list(page, context)
  }, formatError, 24, { ...options, getDataset: () => JSON.stringify([kind, query.value.trim()]) })
  function reset(): void {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    pendingQuery = false
    collection.reset()
  }
  function setQuery(value: string): void {
    if (disposed) return
    const same = query.value.trim() === value.trim()
    query.value = value
    // 输入时就使旧请求失效，不能等到防抖结束才阻止旧结果写回。
    if (same) suspend()
    else reset()
    collection.initialLoading.value = true
    if (!value.trim()) { void collection.load(); return }
    pendingQuery = true
    timer = setTimeout(() => { timer = undefined; pendingQuery = false; void collection.load() }, debounceMs)
  }
  function suspend(): void {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    collection.suspend()
  }
  async function resume(): Promise<void> {
    if (disposed) return
    if (pendingQuery) { pendingQuery = false; await collection.load() }
    else await collection.resume()
  }
  return { ...collection, query, setQuery, reset, suspend, resume,
    dispose: () => { disposed = true; suspend(); pendingQuery = false; collection.dispose() },
  }
}
