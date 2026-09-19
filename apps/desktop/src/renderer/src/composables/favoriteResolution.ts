import type { FavoriteRecord, PageRequest, RoonLibraryItem, RoonLibraryPage, FavoriteKind } from '@music-bridge/contracts'

const normalized = (value?: string): string => (value ?? '').normalize('NFKC').trim().toLocaleLowerCase()

// 收藏保存描述，不保存跨 Core 会话失效的 Browse 引用；每次进入从当前资料库恢复引用。
export function matchesFavorite(record: FavoriteRecord, item: RoonLibraryItem): boolean {
  if (record.kind !== item.kind || normalized(record.title) !== normalized(item.title)) return false
  const artist = item.artist || (item.kind !== 'artist' ? item.subtitle : undefined)
  if (record.artist && normalized(record.artist) !== normalized(artist)) return false
  if (record.kind === 'album' && !record.artist && record.subtitle && normalized(record.subtitle) !== normalized(artist)) return false
  if (record.kind === 'track' && !record.artist && record.subtitle && normalized(record.subtitle) !== normalized(item.subtitle)) return false
  if (record.album && normalized(record.album) !== normalized(item.album)) return false
  for (const key of ['trackNumber', 'discNumber', 'year', 'version'] as const) {
    if (record[key] !== undefined && item[key] !== undefined && record[key] !== item[key]) return false
  }
  return !(record.durationMs && item.durationMs && Math.abs(record.durationMs - item.durationMs) > 2000)
}

export type FavoriteResolution = { state: 'ready'; item: RoonLibraryItem } | { state: 'missing' | 'ambiguous' | 'error'; message: string }

export async function resolveFavorite(
  record: FavoriteRecord,
  search: (query: string, page: PageRequest, kind: FavoriteKind) => Promise<RoonLibraryPage>,
  active: () => boolean = () => true,
  albumTracks?: (reference: string, page: PageRequest) => Promise<RoonLibraryPage>,
): Promise<FavoriteResolution> {
  const matches = new Map<string, RoonLibraryItem>()
  try {
    if (record.kind === 'track' && record.album && albumTracks) {
      let scannedTracks = 0
      for (let offset = 0; offset < 1000 && active(); offset += 100) {
        const albums = await search(record.album.slice(0, 128), { offset, limit: 100 }, 'album')
        if (!active()) return { state: 'error', message: '读取已取消' }
        for (const album of albums.items) {
          if (normalized(album.title) !== normalized(record.album)) continue
          for (let trackOffset = 0; trackOffset < 1000 && active(); trackOffset += 100) {
            const tracks = await albumTracks(album.reference, { offset: trackOffset, limit: 100 })
            if (!active()) return { state: 'error', message: '读取已取消' }
            scannedTracks += tracks.items.length
            if (scannedTracks > 1000) return { state: 'error', message: '同名专辑结果过多，请到本地搜索选择' }
            for (const track of tracks.items) {
              const enriched = { ...track, artist: track.artist || track.subtitle || album.artist || album.subtitle, album: track.album || album.title, artworkReference: track.artworkReference || album.artworkReference }
              if (matchesFavorite(record, enriched)) matches.set(track.reference, enriched)
            }
            if (!tracks.hasMore) break
            if (trackOffset === 900) return { state: 'error', message: '专辑曲目过多，请从专辑详情选择' }
          }
        }
        if (matches.size > 1) return { state: 'ambiguous', message: '存在多个同名版本，请到本地搜索选择' }
        if (!albums.hasMore) {
          const item = [...matches.values()][0]
          return item ? { state: 'ready', item } : { state: 'missing', message: '当前资料库未找到，收藏仍保留' }
        }
      }
      return { state: 'error', message: '读取未完成，请重试或从专辑详情选择' }
    }
    // 有界串行分页，未完成扫描不把第一条同名结果当作唯一匹配。
    for (let offset = 0; offset < 1000 && active(); offset += 100) {
      const page = await search(record.title.slice(0, 128), { offset, limit: 100 }, record.kind)
      if (!active()) return { state: 'error', message: '读取已取消' }
      for (const item of page.items) if (matchesFavorite(record, item)) matches.set(item.reference, item)
      if (matches.size > 1) return { state: 'ambiguous', message: '存在多个同名版本，请到本地搜索选择' }
      if (!page.hasMore) {
        const item = [...matches.values()][0]
        return item ? { state: 'ready', item } : { state: 'missing', message: '当前资料库未找到，收藏仍保留' }
      }
    }
    return { state: 'error', message: '结果过多或读取已取消，请重试或缩小搜索范围' }
  } catch {
    return { state: 'error', message: '暂时无法连接资料库，点击重试' }
  }
}
