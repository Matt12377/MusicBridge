import type { PageRequest, RoonLibraryPage } from '@music-bridge/contracts'
import { ref, type Ref } from 'vue'

import { appendRoonPage, emptyRoonPage, nextRoonPageOffset, readRoonDatasetPage, RoonPageEpochChanged } from './roonLibraryPagination.js'
import { isLibraryReadCancelled, type LibraryReadOptions } from './libraryReadScope.js'

export interface RoonCollectionLoader {
  page: Ref<RoonLibraryPage>
  initialLoading: Ref<boolean>
  loadingMore: Ref<boolean>
  loadMoreError: Ref<string | null>
  error: Ref<string | null>
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
): RoonCollectionLoader {
  const page = ref<RoonLibraryPage>(emptyRoonPage(pageSize))
  const initialLoading = ref(false)
  const loadingMore = ref(false)
  const loadMoreError = ref<string | null>(null)
  const error = ref<string | null>(null)
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
  ): Promise<void> => {
    if (disposed) return
    const initial = request.offset === 0
    if (initial) {
      if (!resume) rebaseAttempts = 0
      suspend()
      initialLoading.value = true
      loadingMore.value = false
      loadMoreError.value = null
      error.value = null
    } else {
      if (loadingMore.value) return
      loadingMore.value = true
      loadMoreError.value = null
    }
    const requestGeneration = generation
    const active = new AbortController()
    controller = active
    pendingRequest = { ...request }
    try {
      const result = await readRoonDatasetPage(initial ? undefined : page.value, request,
        target => requestPage(target, { signal: active.signal }), () => requestGeneration === generation,
        rebaseAttempts === 0 ? () => { rebaseAttempts++; pendingRequest = { offset: 0, limit: request.limit } } : undefined)
      if (!result || requestGeneration !== generation) return
      pendingRequest = undefined
      page.value = initial || result.restarted ? result.page : appendRoonPage(page.value, result.page)
      initialLoading.value = false
      loadingMore.value = false
      error.value = null
    } catch (requestError) {
      if (requestGeneration !== generation) return
      initialLoading.value = false
      loadingMore.value = false
      if (isLibraryReadCancelled(requestError)) return
      pendingRequest = undefined
      if (initial) {
        initialLoading.value = false
        error.value = formatError(requestError)
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
    load,
    loadMore: async () => {
      if (initialLoading.value || page.value.hasMore === false) return
      if (error.value) return
      try { await load({ offset: nextRoonPageOffset(page.value), limit: page.value.limit }) }
      catch { loadMoreError.value = '分页游标异常，请重新读取。' }
    },
    retry: () => load({ offset: 0, limit: page.value.limit }),
    reset: () => {
      suspend()
      pendingRequest = undefined
      page.value = emptyRoonPage(pageSize)
      initialLoading.value = false
      loadingMore.value = false
      loadMoreError.value = null
      error.value = null
    },
    suspend,
    resume: async () => { if (pendingRequest && !controller && !disposed) await load(pendingRequest, true) },
    dispose: () => { disposed = true; suspend(); pendingRequest = undefined },
  }
}
