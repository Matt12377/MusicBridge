import type { AlbumEdition, AlbumEditionTrack, LocalAlbumArtworkRequest, LocalAlbumStatus, LocalAlbumSummary, LocalArtworkImage, LocalLibraryTrackDetail, LocalLibraryTrackSummary, LocalMetadata, LocalRootView } from '@music-bridge/contracts'

/** 这些相对位置只来自工作库作者，不进入 Renderer 或公开专辑合同。 */
export interface LocalAlbumTrackFact {
  relative: string
  summary: LocalLibraryTrackSummary
  rawMetadata: LocalMetadata
  hasArtwork: boolean
  artworkRevision: string | null
  artworkState?: 'available' | 'missing' | 'unknown' | 'source-unavailable'
}
export interface LocalAlbumRejectedFact { rootId: string; relative: string; revision: string; metadataReadFailed: boolean }
export interface LocalAlbumCueFact { rootId: string; relative: string; revision: string; status: 'ready' | 'failed' | 'unresolved'; audioAssetIds: readonly string[]; alreadySplit: boolean }
export interface LocalAlbumNameEnhancementFact { rootId: string; directory: string; revision: string; state: 'failed' | 'ready' | 'cancelled' | 'not-run' }
export interface LocalAlbumReadSnapshot {
  revision: string
  roots: readonly LocalRootView[]
  tracks: readonly LocalAlbumTrackFact[]
  editions: readonly AlbumEdition[]
  editionLinks: readonly AlbumEditionTrack[]
  rejected: readonly LocalAlbumRejectedFact[]
  cues: readonly LocalAlbumCueFact[]
  nameEnhancements: readonly LocalAlbumNameEnhancementFact[]
}
export interface LocalAlbumSnapshotBudget {
  expectedRevision: string
  maxTracks: number
  maxScanFacts: number
  maxBytes: number
}
export interface LocalAlbumSnapshotPort {
  /** 必须覆盖当前 dataset、catalog、有效 scan/CUE、封面和名称增强事实的修订。 */
  readRevision(): string
  /** 作者先检查总行数/预算，再读取完整快照；不截断或从普通浏览触发扫描。 */
  readSnapshot(budget: LocalAlbumSnapshotBudget): LocalAlbumReadSnapshot
  readTrackDetails(ids: readonly string[]): readonly LocalLibraryTrackDetail[]
  readArtwork(request: LocalAlbumArtworkRequest, context: LocalAlbumArtworkReadContext): LocalAlbumArtworkReadResult | Promise<LocalAlbumArtworkReadResult>
}
export interface LocalAlbumArtworkReadResult { image: LocalArtworkImage | null; status: 'ready' | 'source-unavailable' }
/** 仅交给可信作者封面port；目录与代表文件仍不是Renderer授予的路径权限。 */
/** 同组来源指纹不含读取观察及全库lyrics水位；仅作派生缓存键，不代替公开tuple校验。 */
export interface LocalAlbumArtworkReadContext { artworkSourceRevision?: string; readDeadlineAtMs?: number; album: LocalAlbumSummary; directory: string | null; representative: LocalAlbumTrackFact | null }
export interface LocalAlbumReadServiceOptions { port: Readonly<LocalAlbumSnapshotPort>; maxTracks?: number; maxScanFacts?: number; maxBytes?: number }
/** 可信工作台捕获成员范围；不能携带 Renderer 路径或写入能力。 */
export interface LocalAlbumInspectRequest { albumKey: string; rootId: string; revision?: string }
export type LocalAlbumIssue = { kind: 'missing-metadata'; trackId: string; fields: readonly ('title' | 'artist' | 'album')[] }
  | { kind: 'metadata-read-failed'; relative: string }
  | { kind: 'cue'; relative: string; status: LocalAlbumCueFact['status'] }
  | { kind: 'name-enhancement-failed'; revision: string }
export interface LocalAlbumGroupMember { fact: LocalAlbumTrackFact; disc: number | null; trackNumber: number | null; sequence: number; editionLink: AlbumEditionTrack | null; statuses: readonly LocalAlbumStatus[] }
export interface LocalAlbumGroup {
  summary: LocalAlbumSummary
  members: readonly LocalAlbumGroupMember[]
  /** 单个来源目录的内部身份；正式发行可能跨目录，不能把这项当路径授权。 */
  directory: string | null
  issues: readonly LocalAlbumIssue[]
  /** 仅可信工作台回核原扫描事实；拒收记录没有虚构的资产或轨道身份。 */
  rejectedFiles?: readonly { relative: string; revision: string }[]
}
export interface LocalAlbumGroupedSnapshot { revision: string; groups: readonly LocalAlbumGroup[]; bytes: number; trackCount: number }
