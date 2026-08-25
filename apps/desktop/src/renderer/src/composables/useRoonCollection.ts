import type { PageRequest, RoonLibraryPage } from '@music-bridge/contracts'
import { ref, type Ref } from 'vue'

import { appendRoonPage, emptyRoonPage } from './roonLibraryPagination.js'

export interface RoonCollectionLoader {
  page: Ref<RoonLibraryPage>
  initialLoading: Ref<boolean>
  loadingMore: Ref<boolean>
  loadMoreError: Ref<string | null>
  error: Ref<string | null>
  load: (page?: PageRequest) => Promise<void>
  loadMore: () => Promise<void>
  retry: () => Promise<void>
}

export function useRoonCollection(
  requestPage: (page: PageRequest) => Promise<RoonLibraryPage>,
  formatError: (error: unknown) => string,
  pageSize = 24,
): RoonCollectionLoader {
  const page = ref<RoonLibraryPage>(emptyRoonPage(pageSize))
  const initialLoading = ref(false)
  const loadingMore = ref(false)
  const loadMoreError = ref<string | null>(null)
  const error = ref<string | null>(null)
  let generation = 0

  const load = async (
    request: PageRequest = { offset: 0, limit: pageSize },
  ): Promise<void> => {
    const initial = request.offset === 0
    if (initial) {
      generation += 1
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
    try {
      const result = await requestPage(request)
      if (requestGeneration !== generation) return
      page.value = initial ? result : appendRoonPage(page.value, result)
      initialLoading.value = false
      loadingMore.value = false
      error.value = null
    } catch (requestError) {
      if (requestGeneration !== generation) return
      if (initial) {
        initialLoading.value = false
        error.value = formatError(requestError)
      } else {
        loadingMore.value = false
        loadMoreError.value = '加载失败，点击重试'
      }
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
  }
}
