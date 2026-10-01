import { cacheIdentity, createLibraryPageCache, type PageCacheOwnerOptions } from './libraryPageCache.js'
import type { AlbumSummary, ArtistSummary, Page, PageRequest, TrackSummary } from '@music-bridge/contracts'

export type SearchSectionResult<T> =
  | { state: 'ready'; page: Page<T> }
  | { state: 'error'; message: string }

export interface SearchSnapshotLoaderRequests {
  artists: (query: string, page: PageRequest, options?: { reload?: boolean }) => Promise<Page<ArtistSummary>>
  tracks: (query: string, page: PageRequest, options?: { reload?: boolean }) => Promise<Page<TrackSummary>>
  albums: (query: string, page: PageRequest, options?: { reload?: boolean }) => Promise<Page<AlbumSummary>>
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

export type SearchSectionPublication =
  | { query: string; section: 'artists'; result: SearchSectionResult<ArtistSummary> }
  | { query: string; section: 'tracks'; result: SearchSectionResult<TrackSummary> }
  | { query: string; section: 'albums'; result: SearchSectionResult<AlbumSummary> }

export function createSearchSnapshotLoader(
  requests: SearchSnapshotLoaderRequests,
  pages: { artists?: PageRequest; tracks?: PageRequest; albums?: PageRequest; cacheSize?: number } & PageCacheOwnerOptions = {},
): {
  load: (query: string, options?: { reload?: boolean; onSection?: (publication: SearchSectionPublication) => void }) => Promise<SearchSnapshotResult>
  cancel: () => void
} {
  const artistPage = pages.artists ?? { offset: 0, limit: 6 }, trackPage = pages.tracks ?? { offset: 0, limit: 20 }, albumPage = pages.albums ?? { offset: 0, limit: 8 }
  const cacheSize = Math.max(1, Math.floor(pages.cacheSize ?? 8))
  const cache = pages.cache ?? createLibraryPageCache({ maxPages: cacheSize * 3, maxDatasetPages: cacheSize * 3 })
  let generation = 0, inFlightQuery: string | undefined, inFlightScope: string | undefined, inFlightPromise: Promise<SearchSnapshotResult> | undefined
  const load = (queryInput: string, options: { reload?: boolean; onSection?: (publication: SearchSectionPublication) => void } = {}): Promise<SearchSnapshotResult> => {
    const query = queryInput.trim(), scope = pages.getCacheScope?.() ?? 'search'
    if (inFlightPromise && inFlightQuery === query && inFlightScope === scope) return inFlightPromise
    const currentGeneration = ++generation
    const current = () => currentGeneration === generation && scope === (pages.getCacheScope?.() ?? 'search')
    const identity = (kind: string, page: PageRequest) => cacheIdentity(scope, `search:${query}:${kind}`, page)
    const cachedArtists = cache.peek<Page<ArtistSummary>>(identity('artists', artistPage)), cachedTracks = cache.peek<Page<TrackSummary>>(identity('tracks', trackPage)), cachedAlbums = cache.peek<Page<AlbumSummary>>(identity('albums', albumPage))
    const allFresh = cachedArtists && !cachedArtists.stale && cachedTracks && !cachedTracks.stale && cachedAlbums && !cachedAlbums.stale
    const publish = (publication: SearchSectionPublication) => { if (current()) options.onSection?.(publication) }
    async function section<K extends 'artists' | 'tracks' | 'albums'>(kind: K, page: PageRequest, cached: ReturnType<LibraryPageCachePeek>, read: () => Promise<Page<ArtistSummary | TrackSummary | AlbumSummary>>): Promise<SearchSnapshotResult[K]> {
      if (cached) publish({ query, section: kind, result: { state: 'ready', page: cached.value } } as SearchSectionPublication)
      if (cached && !cached.stale && !options.reload) return { state: 'ready', page: cached!.value } as SearchSnapshotResult[K]
      let result: SearchSnapshotResult[K]
      try { result = { state: 'ready', page: await read() } as SearchSnapshotResult[K] }
      catch (error) { result = { state: 'error', message: errorMessage(error) } as SearchSnapshotResult[K] }
      if (current()) {
        if (options.onSection && result.state === 'ready') cache.put(identity(kind, page), result.page)
        publish({ query, section: kind, result } as SearchSectionPublication)
      }
      return result
    }
    const promise = Promise.all([
      section('artists', artistPage, cachedArtists, () => requests.artists(query, artistPage, { reload: !!options.reload || !!cachedArtists?.stale })),
      section('tracks', trackPage, cachedTracks, () => requests.tracks(query, trackPage, { reload: !!options.reload || !!cachedTracks?.stale })),
      section('albums', albumPage, cachedAlbums, () => requests.albums(query, albumPage, { reload: !!options.reload || !!cachedAlbums?.stale })),
    ]).then(([artists, tracks, albums]) => {
      const result: SearchSnapshotResult = { query, stale: !current(), artists, tracks, albums }
      if (!options.onSection && current() && artists.state === 'ready' && tracks.state === 'ready' && albums.state === 'ready' && !(allFresh && !options.reload)) {
        cache.put(identity('artists', artistPage), artists.page); cache.put(identity('tracks', trackPage), tracks.page); cache.put(identity('albums', albumPage), albums.page)
      }
      return result
    })
    inFlightQuery = query; inFlightScope = scope; inFlightPromise = promise
    void promise.then(() => { if (inFlightPromise === promise) { inFlightQuery = undefined; inFlightScope = undefined; inFlightPromise = undefined } }, () => { if (inFlightPromise === promise) { inFlightQuery = undefined; inFlightScope = undefined; inFlightPromise = undefined } })
    return promise
  }
  return { load, cancel: () => { generation++; inFlightQuery = undefined; inFlightScope = undefined; inFlightPromise = undefined } }
}
type LibraryPageCachePeek = () => { value: Page<ArtistSummary | TrackSummary | AlbumSummary>; stale: boolean; writtenAt: number } | undefined
