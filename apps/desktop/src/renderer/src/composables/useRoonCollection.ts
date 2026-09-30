import type { PageRequest, RoonLibraryPage } from '@music-bridge/contracts'
import { ref, type Ref } from 'vue'

import { appendRoonPage, emptyRoonPage } from './roonLibraryPagination.js'
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

  const suspend = (): void => {
    generation += 1
    controller?.abort()
    controller = undefined
    initialLoading.value = false
    loadingMore.value = false
  }

  const load = async (
    request: PageRequest = { offset: 0, limit: pageSize },
  ): Promise<void> => {
    if (disposed) return
    const initial = request.offset === 0
    if (initial) {
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
      const result = await requestPage(request, { signal: active.signal })
      if (requestGeneration !== generation) return
      pendingRequest = undefined
      if (!initial && result.offset !== request.offset) {
        loadingMore.value = false
        loadMoreError.value = '分页响应异常，点击重试'
        return
      }
      page.value = initial ? result : appendRoonPage(page.value, result)
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
        loadMoreError.value = '加载失败，点击重试'
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
      await load({
        offset: page.value.offset + page.value.limit,
        limit: page.value.limit,
      })
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
    resume: async () => { if (pendingRequest && !controller && !disposed) await load(pendingRequest) },
    dispose: () => { disposed = true; suspend(); pendingRequest = undefined },
  }
}
