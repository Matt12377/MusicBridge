import type { AlbumSummary, ArtistSummary, RoonLibraryItem } from '@music-bridge/contracts'
import { hasNoAlbums } from './artistVisibility.js'

export interface SearchArtistGroup {
  key: string
  name: string
  netease?: ArtistSummary
  roon?: RoonLibraryItem
}

const artistName = (name: string): string => name.normalize('NFKC').trim().toLocaleLowerCase()

// 同名只聚合展示，保留两个来源入口；同一来源存在重名时不合并。
export function groupSearchArtists(netease: readonly ArtistSummary[], roon: readonly RoonLibraryItem[]): SearchArtistGroup[] {
  const local = roon.filter((item) => item.kind === 'artist' && !hasNoAlbums(item))
  const groups: SearchArtistGroup[] = local.map((item) => ({ key: `roon:${item.reference}`, name: item.title, roon: item }))
  for (const artist of netease.filter(item => item.albumCount !== 0)) {
    const name = artistName(artist.name)
    const matches = groups.filter((item) => artistName(item.name) === name)
    if (matches.length === 1 && netease.filter((item) => artistName(item.name) === name).length === 1 && !matches[0]!.netease) {
      matches[0]!.netease = artist
    } else {
      groups.push({ key: `netease:${artist.id}`, name: artist.name, netease: artist })
    }
  }
  return groups
}

export type SearchAlbum = { key: string; source: 'roon'; item: RoonLibraryItem } | { key: string; source: 'netease'; item: AlbumSummary }

export function mixSearchAlbums(netease: readonly AlbumSummary[], roon: readonly RoonLibraryItem[]): SearchAlbum[] {
  const local = roon.filter((item) => item.kind === 'album')
  const result: SearchAlbum[] = []
  // 保持各来源内部排序，交错展示；同名专辑和不同版本分别保留。
  for (let index = 0; index < Math.max(local.length, netease.length); index += 1) {
    const r = local[index]
    const n = netease[index]
    if (r) result.push({ key: `roon:${r.reference}`, source: 'roon', item: r })
    if (n) result.push({ key: `netease:${n.id}`, source: 'netease', item: n })
  }
  return result
}
