import type { AlbumSummary, ArtistSummary, LocalAlbumSummary, RoonLibraryItem, TrackSummary } from '@music-bridge/contracts'
import type { LocalArtistSummary, LocalArtistTrackItem } from '@music-bridge/contracts'

export type CatalogSource = 'local' | 'netease' | 'roon'
export type CatalogKind = 'artists' | 'albums' | 'tracks'
export type CatalogCategory = 'all' | CatalogKind
export const catalogSources: readonly CatalogSource[] = ['local', 'netease', 'roon']
export const catalogKinds: readonly CatalogKind[] = ['artists', 'albums', 'tracks']
export const catalogSourceLabel = { local: '本地', netease: '网易云', roon: 'Roon' } as const
export const catalogKindLabel = { artists: '艺术家', albums: '专辑', tracks: '歌曲' } as const

export type CatalogIdentity =
  | { type: 'local-artist'; value: LocalArtistSummary }
  | { type: 'local-album'; value: LocalAlbumSummary }
  | { type: 'local-track'; value: LocalArtistTrackItem }
  | { type: 'netease-artist'; value: ArtistSummary }
  | { type: 'netease-album'; value: AlbumSummary }
  | { type: 'netease-track'; value: TrackSummary }
  | { type: 'roon'; value: RoonLibraryItem }

/** 仅展示投影；操作始终使用 identity 内原来源的完整对象。 */
export interface CatalogItem {
  key: string
  source: CatalogSource
  kind: CatalogKind
  title: string
  subtitle: string
  artworkUrl?: string
  artworkReference?: string
  identity: CatalogIdentity
}
export interface CatalogPage {
  items: readonly CatalogItem[]
  offset: number
  limit: number
  total?: number
  hasMore: boolean
  nextOffset?: number
  revision?: string
}
export interface CatalogArtistCard {
  key: string
  name: string
  entries: readonly CatalogItem[]
  artworkUrl?: string
  artworkReference?: string
  localAlbumCount?: number
  localTrackCount?: number
}

export function localArtistItem(value: LocalArtistSummary, artworkUrl?: string): CatalogItem {
  return { key: `local:artist:${value.id}`, source: 'local', kind: 'artists', title: value.name,
    subtitle: `${value.albumCount} 张本地专辑 · ${value.trackCount} 首参与歌曲`, artworkUrl, identity: { type: 'local-artist', value } }
}
export function localAlbumItem(value: LocalAlbumSummary): CatalogItem {
  return { key: `local:album:${value.rootId}:${value.id}`, source: 'local', kind: 'albums', title: value.title,
    subtitle: value.artists.join('、'), identity: { type: 'local-album', value } }
}
export function localTrackItem(value: LocalArtistTrackItem): CatalogItem {
  return { key: `local:track:${value.track.id}`, source: 'local', kind: 'tracks', title: value.metadata.title || '未命名歌曲',
    subtitle: [value.metadata.artist, value.metadata.album].filter(Boolean).join(' · '), identity: { type: 'local-track', value } }
}
export function neteaseArtistItem(value: ArtistSummary): CatalogItem {
  return { key: `netease:artist:${value.id}`, source: 'netease', kind: 'artists', title: value.name,
    subtitle: value.albumCount === undefined ? '网易云艺术家' : `${value.albumCount} 张专辑`, artworkUrl: value.artworkUrl, identity: { type: 'netease-artist', value } }
}
export function neteaseAlbumItem(value: AlbumSummary): CatalogItem {
  return { key: `netease:album:${value.id}`, source: 'netease', kind: 'albums', title: value.name,
    subtitle: value.artistName, artworkUrl: value.artworkUrl, identity: { type: 'netease-album', value } }
}
export function neteaseTrackItem(value: TrackSummary): CatalogItem {
  return { key: `netease:track:${value.id}`, source: 'netease', kind: 'tracks', title: value.title,
    subtitle: [value.artists.join('、'), value.album].filter(Boolean).join(' · '), artworkUrl: value.artworkUrl, identity: { type: 'netease-track', value } }
}
export function roonCatalogItem(value: RoonLibraryItem): CatalogItem {
  return { key: `roon:${value.kind}:${value.reference}`, source: 'roon', kind: value.kind === 'artist' ? 'artists' : value.kind === 'album' ? 'albums' : 'tracks',
    title: value.title, subtitle: value.artist || value.subtitle || 'Roon', artworkReference: value.artworkReference ?? (value.kind === 'artist' ? value.reference : undefined), identity: { type: 'roon', value } }
}

export function interleaveCatalogItems(sources: readonly (readonly CatalogItem[])[]): CatalogItem[] {
  const result: CatalogItem[] = []
  for (let index = 0; index < Math.max(0, ...sources.map(items => items.length)); index++) {
    for (const items of sources) if (items[index]) result.push(items[index]!)
  }
  return result
}

/** 只有明确的外部人物 ID 关联才聚合；名字完全相同也不会成为关联凭据。 */
export function groupCatalogArtists(items: readonly CatalogItem[], sources: readonly CatalogSource[] = catalogSources): CatalogArtistCard[] {
  const groups: CatalogArtistCard[] = [], consumed = new Set<string>()
  const visible = items.filter(item => sources.includes(item.source))
  const remote = new Map(visible.filter(item => item.identity.type === 'netease-artist').map(item => [item.identity.type === 'netease-artist' ? item.identity.value.id : '', item]))
  for (const item of visible) {
    if (item.identity.type !== 'local-artist') continue
    const artist = item.identity.value, linked = artist.linkedNeteaseId
    const bound = linked && sources.includes('netease') ? remote.get(linked) ?? neteaseArtistItem({ id: linked, name: artist.name }) : undefined
    if (bound) consumed.add(bound.key)
    groups.push({ key: item.key, name: item.title, entries: bound ? [item, bound] : [item],
      artworkUrl: item.artworkUrl ?? bound?.artworkUrl, localAlbumCount: artist.albumCount, localTrackCount: artist.trackCount })
  }
  for (const item of visible) {
    if (item.identity.type === 'local-artist' || consumed.has(item.key)) continue
    groups.push({ key: item.key, name: item.title, entries: [item], artworkUrl: item.artworkUrl, artworkReference: item.artworkReference })
  }
  return groups
}

export function mergeCatalogPage(previous: readonly CatalogItem[], page: CatalogPage): CatalogItem[] {
  const keys = new Set(previous.map(item => item.key)), result = [...previous]
  for (const item of page.items) if (!keys.has(item.key)) { keys.add(item.key); result.push(item) }
  return result
}
