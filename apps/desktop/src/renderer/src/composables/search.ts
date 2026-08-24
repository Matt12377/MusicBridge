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

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : '搜索分区暂时不可用'
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
      if (!result.stale) {
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
