import type { PageRequest, RoonLibraryPage } from '@music-bridge/contracts'
import { ref, type Ref } from 'vue'
import { cacheIdentity, mergeRefreshedRoonPage, type PageCacheOwnerOptions } from './libraryPageCache.js'

import { appendRoonPage, emptyRoonPage, nextRoonPageOffset, readRoonDatasetPage, RoonPageEpochChanged } from './roonLibraryPagination.js'
import type { LibraryReadOptions } from './libraryReadScope.js'

export interface RoonCollectionLoader {
  page: Ref<RoonLibraryPage>
  initialLoading: Ref<boolean>
  loadingMore: Ref<boolean>
  loadMoreError: Ref<string | null>
  error: Ref<string | null>
  refreshError: Ref<string | null>
  load: (page?: PageRequest) => Promise<void>
  loadMore: () => Promise<void>
  retry: () => Promise<void>
  reset: () => void
  suspend: () => void
  resume: () => Promise<void>
  dispose: () => void
}

export function useRoonCollection(
  requestPage: (page: PageRequest, context?: LibraryReadOptions) => Promise<RoonLibraryPage>,
  formatError: (error: unknown) => string,
  pageSize = 24,
  options: PageCacheOwnerOptions & { getDataset?: () => string } = {},
): RoonCollectionLoader {
  const page = ref<RoonLibraryPage>(emptyRoonPage(pageSize))
  const initialLoading = ref(false)
  const loadingMore = ref(false)
  const loadMoreError = ref<string | null>(null)
  const error = ref<string | null>(null)
  const refreshError = ref<string | null>(null)
  let visibleReadAt = 0
  let visibleIdentity: string | undefined
  let generation = 0
  let disposed = false
  let controller: AbortController | undefined
  let pendingRequest: PageRequest | undefined
  let rebaseAttempts = 0

  const suspend = (): void => {
    generation += 1
    controller?.abort()
    controller = undefined
    initialLoading.value = false
    loadingMore.value = false
  }

  const load = async (
    request: PageRequest = { offset: 0, limit: pageSize },
    resume = false,
    reload = false,
  ): Promise<void> => {
    if (disposed) return
    const initial = request.offset === 0
    const scope = options.getCacheScope?.() ?? 'collection', dataset = options.getDataset?.() ?? 'collection'
    const identity = JSON.stringify([scope, dataset])
    if (visibleIdentity !== undefined && visibleIdentity !== identity) { suspend(); page.value = emptyRoonPage(pageSize); error.value = null; refreshError.value = null }
    visibleIdentity = identity
    const cacheKey = cacheIdentity(scope, dataset, request)
    const cached = options.cache?.peek<RoonLibraryPage>(cacheKey)
    if (cached && initial && !page.value.items.length) page.value = cached.value
    const isCurrent = () => !disposed && requestGeneration === generation && scope === (options.getCacheScope?.() ?? 'collection') && dataset === (options.getDataset?.() ?? 'collection')
    if (initial) {
      if (!resume) rebaseAttempts = 0
      suspend()
      initialLoading.value = true
      loadingMore.value = false
      loadMoreError.value = null
      error.value = null
      refreshError.value = null
    } else {
      if (loadingMore.value) return
      loadingMore.value = true
      loadMoreError.value = null
    }
    const requestGeneration = generation
    const active = new AbortController()
    controller = active
    pendingRequest = { ...request }
    if (initial && cached && !cached.stale && !reload) {
      page.value = mergeRefreshedRoonPage(page.value, cached.value)
      visibleReadAt = cached.writtenAt
      pendingRequest = undefined; initialLoading.value = false; loadingMore.value = false; controller = undefined; return
    }
    let firstRead = true
    try {
      const result = await readRoonDatasetPage(initial ? undefined : page.value, request,
        target => { const force = firstRead && (reload || !!cached?.stale); firstRead = false; return requestPage(target, { signal: active.signal, ...(force ? { cacheMode: 'reload' as const } : {}) }) }, isCurrent,
        rebaseAttempts === 0 ? () => { rebaseAttempts++; pendingRequest = { offset: 0, limit: request.limit } } : undefined)
      if (!result || !isCurrent()) return
      pendingRequest = undefined
      if (result.restarted || (initial && page.value.sourceEpoch !== result.page.sourceEpoch)) options.cache?.evictDataset(scope, dataset)
      options.cache?.put(cacheIdentity(scope, dataset, result.page), result.page)
      visibleReadAt = Date.now()
      page.value = result.restarted ? result.page : initial ? mergeRefreshedRoonPage(page.value, result.page) : appendRoonPage(page.value, result.page)
      initialLoading.value = false
      loadingMore.value = false
      error.value = null
    } catch (requestError) {
      if (!isCurrent()) return
      initialLoading.value = false
      loadingMore.value = false
      // 离页和替换请求已由代际过滤；当前请求被 Core 撤销仍须显示重试状态。
      pendingRequest = undefined
      if (initial) {
        initialLoading.value = false
        if (page.value.items.length) refreshError.value = formatError(requestError)
        else error.value = formatError(requestError)
      } else {
        loadingMore.value = false
        loadMoreError.value = requestError instanceof RoonPageEpochChanged ? '读取上下文反复变化，请重新读取。'
          : requestError instanceof Error && requestError.message === '分页响应异常，点击重试' ? requestError.message : '加载失败，点击重试'
      }
    } finally {
      if (controller === active) controller = undefined
    }
  }

  return {
    page,
    initialLoading,
    loadingMore,
    loadMoreError,
    error,
    refreshError,
    load,
    loadMore: async () => {
      if (initialLoading.value || page.value.hasMore === false) return
      if (error.value) return
      try { await load({ offset: nextRoonPageOffset(page.value), limit: page.value.limit }) }
      catch { loadMoreError.value = '分页游标异常，请重新读取。' }
    },
    retry: () => load({ offset: 0, limit: page.value.limit }, false, true),
    reset: () => {
      suspend()
      pendingRequest = undefined
      visibleIdentity = undefined
      refreshError.value = null
      page.value = emptyRoonPage(pageSize)
      initialLoading.value = false
      loadingMore.value = false
      loadMoreError.value = null
      error.value = null
    },
    suspend,
    resume: async () => {
      if (pendingRequest && !controller && !disposed) { await load(pendingRequest, true); return }
      if (!options.cache || controller || disposed || !page.value.items.length) return
      const age = Date.now() - visibleReadAt
      if (age >= 0 && age < 30_000) return
      if (age < 0) page.value = emptyRoonPage(page.value.limit)
      await load({ offset: 0, limit: page.value.limit }, true)
    },
    dispose: () => { disposed = true; suspend(); pendingRequest = undefined },
  }
}
