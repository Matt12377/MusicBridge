import type { RoonLibraryItem } from '@music-bridge/contracts'

// 未提供数量不等于零；只过滤来源明确标注的零专辑，避免逐个浏览艺人拖慢列表。
export function hasNoAlbums(item: Pick<RoonLibraryItem, 'kind' | 'subtitle' | 'albumCount'>): boolean {
  if (item.kind !== 'artist') return false
  if (item.albumCount !== undefined) return item.albumCount === 0
  return /(?:^|[\s·,，;；])0\s*(?:albums?\b|张?专辑|張?專輯)(?:$|[\s·,，;；])/iu.test((item.subtitle ?? '').normalize('NFKC'))
}
