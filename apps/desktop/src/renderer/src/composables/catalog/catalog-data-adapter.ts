import type { ArtistCatalogArtist, ArtistCatalogSearch, ArtistSearchCatalogPublicApi, Page, PageRequest, TrackSummary } from '@music-bridge/contracts'
import type { MusicBridgePublicApi } from '../../../../preload/api.js'
import { createLibraryReadScope } from '../libraryReadScope.js'
import { nextRoonPageOffset } from '../roonLibraryPagination.js'
import type { CatalogArtistProfile, CatalogDataPort } from './useCatalogExperience.js'
import { localAlbumItem, localArtistItem, localTrackItem, neteaseAlbumItem, neteaseArtistItem, neteaseTrackItem, roonCatalogItem,
  type CatalogItem, type CatalogPage } from './catalog-presentation.js'

function profile(value: ArtistCatalogArtist): CatalogArtistProfile {
  return { artist: value, artworkUrl: value.artworkUrl, biography: value.biography, credit: value.credit, linkState: value.linkState }
}
function page<T>(value: { items: readonly T[]; offset: number; limit: number; total?: number; hasMore?: boolean; revision?: string }, map: (item: T) => CatalogItem): CatalogPage {
  return { items: value.items.map(map), offset: value.offset, limit: value.limit, total: value.total, hasMore: !!value.hasMore, revision: value.revision }
}

/** 三来源仅共享展示协议；取消、游标与实际身份各自沿原业务 API。 */
export function createCatalogDataAdapter(api: MusicBridgePublicApi, getCatalog: () => ArtistSearchCatalogPublicApi | undefined) {
  const sourceReads = { netease: createLibraryReadScope(api), roon: createLibraryReadScope(api) }, localSearches = new Map<string, Promise<ArtistCatalogSearch>>()
  let localEpoch = 0, disposed = false
  const catalog = (): ArtistSearchCatalogPublicApi => { const value = getCatalog(); if (!value) throw new Error('本地艺术家接口尚未就绪。'); return value }
  async function localRead<T>(read: () => Promise<T>): Promise<T> {
    const epoch = localEpoch
    if (disposed) throw new Error('[CANCELLED] 本次本地读取已结束。')
    const result = await read()
    if (disposed || epoch !== localEpoch) throw new Error('[CANCELLED] 原本地读取范围已经撤销。')
    return result
  }
  const localSearch = (query: string, window: PageRequest): Promise<ArtistCatalogSearch> => {
    const key = JSON.stringify([query, window.offset, window.limit]), existing = localSearches.get(key)
    if (existing) return existing
    const result = localRead(() => catalog().search({ query, ...window })); localSearches.set(key, result)
    void result.then(() => { if (localSearches.get(key) === result) localSearches.delete(key) }, () => { if (localSearches.get(key) === result) localSearches.delete(key) })
    return result
  }
  const port: CatalogDataPort = {
    async search(source, kind, query, window) {
      if (source === 'local') {
        const result = await localSearch(query, window)
        if (kind === 'artists') return page(result.artists, item => localArtistItem(item, item.artworkUrl))
        if (kind === 'albums') return page(result.albums, localAlbumItem)
        return page(result.tracks, localTrackItem)
      }
      if (source === 'roon') {
        const reads = sourceReads.roon
        const selectedKind = kind === 'artists' ? 'artist' : kind === 'albums' ? 'album' : 'track'
        const result = await reads.read('roon.library.search', { query, page: window, kind: selectedKind }, () => api.searchRoonLibrary(query, window, selectedKind))
        return { ...page(result, roonCatalogItem), nextOffset: nextRoonPageOffset(result), revision: result.sourceEpoch }
      }
      const reads = sourceReads.netease
      if (kind === 'artists') return page(await reads.read('library.searchArtists', { query, page: window }, () => api.searchArtists(query, window)), neteaseArtistItem)
      if (kind === 'albums') return page(await reads.read('library.searchAlbums', { query, page: window }, () => api.searchAlbums(query, window)), neteaseAlbumItem)
      return page(await reads.read('library.search', { query, page: window }, () => api.searchTracks(query, window)), neteaseTrackItem)
    },
    async suggest(query) { return (await catalog().suggest({ query })).keywords },
    async artists(query, window) { return page(await localRead(() => catalog().listArtists({ query, ...window })), item => localArtistItem(item, item.artworkUrl)) },
    async artist(artistId) { return profile(await localRead(() => catalog().getArtist({ artistId }))) },
    async artistAlbums(artistId, relation, window) { return page(await localRead(() => catalog().listArtistAlbums({ artistId, relation, ...window })), localAlbumItem) },
    async artistTracks(artistId, window) { return page(await localRead(() => catalog().listArtistTracks({ artistId, ...window })), localTrackItem) },
    async remoteDetail(item, window) {
      if (item.identity.type === 'netease-artist') {
        const artistId = item.identity.value.id
        return page((await sourceReads.netease.read('library.artist', { artistId, page: window }, () => api.getArtist(artistId, window))).tracks, neteaseTrackItem)
      }
      if (item.identity.type === 'netease-album') {
        const albumId = item.identity.value.id
        return page((await sourceReads.netease.read('library.album', { albumId, page: window }, () => api.getAlbum(albumId, window))).tracks, neteaseTrackItem)
      }
      throw new Error('此来源的详情需要从原来源入口打开。')
    },
    async artistMatches(artistId, query) { return (await localRead(() => catalog().artistMatches({ artistId, ...(query ? { query } : {}) }))).map(item => neteaseArtistItem({ id: item.id, name: item.name, artworkUrl: item.artworkUrl, albumCount: item.albumCount, trackCount: item.trackCount })) },
    async bindArtist(artistId, neteaseArtistId) { return profile(await catalog().bindArtist({ artistId, neteaseArtistId })) },
  }
  function neteaseLoader(query: string, detail: CatalogItem | undefined): (window: PageRequest) => Promise<Page<TrackSummary>> {
    if (detail?.identity.type === 'netease-artist') { const artistId = detail.identity.value.id; return async window => (await sourceReads.netease.read('library.artist', { artistId, page: window }, () => api.getArtist(artistId, window))).tracks }
    if (detail?.identity.type === 'netease-album') { const albumId = detail.identity.value.id; return async window => (await sourceReads.netease.read('library.album', { albumId, page: window }, () => api.getAlbum(albumId, window))).tracks }
    return window => sourceReads.netease.read('library.search', { query, page: window }, () => api.searchTracks(query, window))
  }
  return { port, neteaseLoader, cancelSource(source: 'local' | 'netease' | 'roon') { if (source === 'local') { localEpoch++; localSearches.clear() } else sourceReads[source].cancelAll() },
    dispose() { disposed = true; localEpoch++; sourceReads.netease.dispose(); sourceReads.roon.dispose(); localSearches.clear() } }
}
