import type { PageRequest, RoonLibraryPage } from '@music-bridge/contracts'
import { ref } from 'vue'
import { useRoonCollection } from './useRoonCollection.js'

/** 页面内的 Roon 搜索和分页共享查询；不调用 Provider 或聚合搜索。 */
export function useRoonSearchCollection(
  kind: 'album' | 'artist',
  list: (page: PageRequest) => Promise<RoonLibraryPage>,
  search: (query: string, page: PageRequest, kind: 'album' | 'artist') => Promise<RoonLibraryPage>,
  formatError: (error: unknown) => string,
  debounceMs = 300,
) {
  const query = ref('')
  let timer: ReturnType<typeof setTimeout> | undefined
  const collection = useRoonCollection(page => {
    const text = query.value.trim()
    return text ? search(text, page, kind) : list(page)
  }, formatError)
  function reset(): void {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    collection.reset()
  }
  function setQuery(value: string): void {
    query.value = value
    // 输入时就使旧请求失效，不能等到防抖结束才阻止旧结果写回。
    reset()
    collection.initialLoading.value = true
    if (!value.trim()) { void collection.load(); return }
    timer = setTimeout(() => { timer = undefined; void collection.load() }, debounceMs)
  }
  return { ...collection, query, setQuery, reset }
}
