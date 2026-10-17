import type { LocalAlbumFilter, LocalAlbumFilterCounts, LocalAlbumReadPort, LocalAlbumSummary, LocalAlbumTrackItem } from '@music-bridge/contracts'
export { LOCAL_ALBUM_STATUSES } from '@music-bridge/contracts'
export type { LocalAlbumStatus, LocalAlbumFilter, LocalAlbumFilterCounts, LocalAlbumSummary, LocalAlbumQuery, LocalAlbumPage, LocalAlbumTrackItem, LocalAlbumTrackQuery, LocalAlbumTrackPage, LocalAlbumArtworkRequest, LocalAlbumArtworkReply } from '@music-bridge/contracts'
export type LocalAlbumBrowserApi = LocalAlbumReadPort

export type LocalAlbumReadStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'error'
export type LocalAlbumArtworkStatus = 'idle' | 'loading' | 'ready' | 'missing' | 'error'
export interface LocalAlbumArtworkState {
  status: LocalAlbumArtworkStatus
  dataUrl: string | null
  error: string
  canRetry: boolean
  /** 仅Renderer私有展示元数据；来源仍由原Owner读取校验，详情保留原display。 */
  display?: Readonly<{ sha256: string; width: number; height: number; bytes: number }>
}
export interface LocalAlbumReturnTarget {
  albumKey: string
  query: string
  rootId: string | null
  filter: LocalAlbumFilter
  scrollTop: number
}
export interface LocalAlbumArtworkInvalidation {
  epoch: number
  /** null 表示明确失效全部封面；单专辑失效只恢复该项自动读取资格。 */
  albumKey: string | null
}
/** 仅当前页面的短期读兴趣；可见项先于一行近邻，不持有第二份图片。 */
export interface LocalAlbumArtworkWindow {
  visible: readonly LocalAlbumSummary[]
  nearby: readonly LocalAlbumSummary[]
}
export interface LocalAlbumBrowserSnapshot {
  active: boolean
  query: string
  rootId: string | null
  filter: LocalAlbumFilter
  items: readonly LocalAlbumSummary[]
  total: number
  hasMore: boolean
  counts: LocalAlbumFilterCounts
  loaded: boolean
  status: LocalAlbumReadStatus
  initialLoading: boolean
  refreshing: boolean
  loadingMore: boolean
  error: string
  refreshError: string
  loadMoreError: string
  stale: boolean
  scrollTop: number
  selectedAlbumIds?: readonly string[]
  selectedAlbum: LocalAlbumSummary | null
  tracks: readonly LocalAlbumTrackItem[]
  trackTotal: number
  tracksHasMore: boolean
  detailStatus: LocalAlbumReadStatus
  detailLoading: boolean
  detailRefreshing: boolean
  detailLoadingMore: boolean
  detailError: string
  detailRefreshError: string
  detailLoadMoreError: string
  detailStale: boolean
  returnTarget: LocalAlbumReturnTarget | null
  /** 缓存只保存已验证的显示图，不保存 LocalArtworkImage 原图。 */
  artwork: Readonly<Record<string, LocalAlbumArtworkState>>
  /** 可选以兼容既有快照；普通 LRU 淘汰不改变此信号。 */
  artworkInvalidation?: Readonly<LocalAlbumArtworkInvalidation>
}
export interface LocalAlbumBrowserOptions {
  api: Readonly<LocalAlbumBrowserApi>
  pageSize?: number
  trackPageSize?: number
  artworkConcurrency?: number
  artworkCacheBytes?: number
  artworkCacheEntries?: number
  onChange?: (snapshot: LocalAlbumBrowserSnapshot) => void
}
