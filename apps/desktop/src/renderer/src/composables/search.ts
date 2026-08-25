import type { AlbumSummary, ArtistSummary, Page, PageRequest, TrackSummary } from '@music-bridge/contracts'

export type SearchSectionResult<T> =
  | { state: 'ready'; page: Page<T> }
  | { state: 'error'; message: string }

export interface SearchSnapshotLoaderRequests {
  artists: (query: string, page: PageRequest) => Promise<Page<ArtistSummary>>
  tracks: (query: string, page: PageRequest) => Promise<Page<TrackSummary>>
  albums: (query: string, page: PageRequest) => Promise<Page<AlbumSummary>>
}

export interface SearchSnapshotResult {
  query: string
  stale: boolean
  artists: SearchSectionResult<ArtistSummary>
  tracks: SearchSectionResult<TrackSummary>
  albums: SearchSectionResult<AlbumSummary>
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

function errorText(message: string): string {
  if (message.includes('Provider login required')) return '请先登录音乐服务，再搜索内容。'
  if (message.includes('Provider session expired')) return '登录已过期，请重新登录后再搜索。'
  if (
    message.includes('Error invoking remote method') ||
    message.startsWith('Core ')
  ) {
    return '搜索分区暂时不可用，请检查连接状态。'
  }
  return message
}

function errorMessage(error: unknown): string {
  switch (errorCode(error)) {
    case 'AUTH_REQUIRED':
      return '请先登录音乐服务，再搜索内容。'
    case 'AUTH_EXPIRED':
      return '登录已过期，请重新登录后再搜索。'
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return errorText(error.message)
  }
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string' && error.message.trim().length > 0) {
    return errorText(error.message)
  }
  return '搜索分区暂时不可用'
}

export function createSearchSnapshotLoader(
  requests: SearchSnapshotLoaderRequests,
  pages: { artists?: PageRequest; tracks?: PageRequest; albums?: PageRequest; cacheSize?: number } = {},
): {
  load: (query: string) => Promise<SearchSnapshotResult>
  cancel: () => void
} {
  const artistPage = pages.artists ?? { offset: 0, limit: 6 }
  const trackPage = pages.tracks ?? { offset: 0, limit: 20 }
  const albumPage = pages.albums ?? { offset: 0, limit: 8 }
  const cacheSize = Math.max(1, Math.floor(pages.cacheSize ?? 8))
  const cache = new Map<string, SearchSnapshotResult>()
  let generation = 0
  let inFlightQuery: string | undefined
  let inFlightPromise: Promise<SearchSnapshotResult> | undefined

  const load = (queryInput: string): Promise<SearchSnapshotResult> => {
    const query = queryInput.trim()
    if (inFlightPromise && inFlightQuery === query) return inFlightPromise
    const cached = cache.get(query)
    if (cached) {
      cache.delete(query)
      cache.set(query, cached)
      return Promise.resolve({ ...cached, stale: false })
    }

    const currentGeneration = ++generation
    const promise = Promise.allSettled([
      requests.artists(query, artistPage),
      requests.tracks(query, trackPage),
      requests.albums(query, albumPage),
    ]).then(([artists, tracks, albums]) => {
      const result: SearchSnapshotResult = {
        query,
        stale: currentGeneration !== generation,
        artists: artists.status === 'fulfilled'
          ? { state: 'ready', page: artists.value }
          : { state: 'error', message: errorMessage(artists.reason) },
        tracks: tracks.status === 'fulfilled'
          ? { state: 'ready', page: tracks.value }
          : { state: 'error', message: errorMessage(tracks.reason) },
        albums: albums.status === 'fulfilled'
          ? { state: 'ready', page: albums.value }
          : { state: 'error', message: errorMessage(albums.reason) },
      }
      if (
        !result.stale &&
        result.artists.state === 'ready' &&
        result.tracks.state === 'ready' &&
        result.albums.state === 'ready'
      ) {
        cache.set(query, result)
        while (cache.size > cacheSize) cache.delete(cache.keys().next().value as string)
      }
      return result
    })
    inFlightQuery = query
    inFlightPromise = promise
    void promise.finally(() => {
      if (inFlightPromise === promise) {
        inFlightQuery = undefined
        inFlightPromise = undefined
      }
    })
    return promise
  }

  const cancel = (): void => {
    generation += 1
    inFlightQuery = undefined
    inFlightPromise = undefined
  }

  return { load, cancel }
}
