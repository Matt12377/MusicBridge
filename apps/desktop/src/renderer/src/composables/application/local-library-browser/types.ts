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
  grid?: Readonly<import('@music-bridge/contracts').LocalAlbumArtworkGrid>
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
  /** 当前目录中已完成后台尝试的项数；包含缺图和失败，不等于已有封面数。 */
  backgroundArtwork?: Readonly<{ completed: number; total: number; running: boolean }>
}
export interface LocalAlbumBrowserOptions {
  api: Readonly<LocalAlbumBrowserApi>
  pageSize?: number
  trackPageSize?: number
  artworkConcurrency?: number
  artworkCacheBytes?: number
  artworkCacheEntries?: number
  /** 首屏提交后持续分批读取目录；RAM预热由独立开关控制。 */
  backgroundLoading?: boolean
  /** 仅控制Renderer逐项RAM预热；自动分页、Core持久补齐与前台兴趣读取独立。 */
  backgroundArtworkLoading?: boolean
  /** 画廊只保留持久网格图；所选详情单独按需保留一个高清副本。 */
  compactGridArtwork?: boolean
  /** 普通切页保留已确认目录；失效、范围变更及明确刷新仍走真实读口。 */
  reuseLoadedOnActivate?: boolean
  onChange?: (snapshot: LocalAlbumBrowserSnapshot) => void
}
