import type { AudioAsset, LocalAlbumArtworkRequest, LocalAlbumFilterCounts, LocalAlbumPage, LocalAlbumQuery, LocalAlbumSummary, LocalAlbumTrackQuery, LocalMetadata, LocalRootView, LocalTrack, VersionNameToken, LocalCuePreparedItem } from '@music-bridge/contracts'
import type { ScanFileState } from '../local-scan-facts.js'
import type { LocalAlbumArtworkReadContext, LocalAlbumGroupMember, LocalAlbumIssue, LocalAlbumNameEnhancementFact } from './types.js'

/** 真实管理绑定的组织事实；无路径、FD或Source写许可，不是公开IPC合同。 */
export interface LocalAlbumLibraryOrganization {
  datasetId: string; rootId: string; sourceRootId: string; rootRevision: string
  bindingRevision: number; recordSha256: string; role: import('@music-bridge/contracts').LocalLibraryRole
  rootName: string; parentName: string
}
/** 只由原Owner构造；不携带路径许可，不是公开IPC合同。 */
/** 只有实际按需读取成功的证据；不保留图像，也不把 unknown/不可用写成缺图。 */
export interface LocalAlbumSqlArtworkObservation { albumKey: string; rootId: string; sourceRevision: string; state: 'available' | 'missing'; revision: string }
/** Owner 持有的紧凑事实作者；与旧 512 项观测包、图片 LRU 分离，不进入 IPC。 */
export interface LocalAlbumArtworkInventory { revision(): string; read(albumKey: string, rootId: string): 'available' | 'missing' | 'unknown' }
export interface LocalAlbumLyricsInventory { revision(): string; read(trackId: string, rootId: string, fileRevision: string): 'unknown' | 'false' | 'true' }
export interface LocalAlbumSqlScope { revision: string; roots: readonly LocalRootView[]; nameEnhancements?: readonly LocalAlbumNameEnhancementFact[]; artworkObservations?: readonly LocalAlbumSqlArtworkObservation[]; artworkInventory?: LocalAlbumArtworkInventory; lyricsInventory?: LocalAlbumLyricsInventory; libraryOrganizations?: readonly LocalAlbumLibraryOrganization[] }
export interface LocalAlbumSqlMemberPage extends LocalAlbumTrackQuery { album: LocalAlbumArtworkReadContext['album']; total: number; hasMore: boolean; items: readonly LocalAlbumGroupMember[]; directory: string | null }
/** 手机私有投影仍读取原groups/members；筛选值不授予来源或文件读取许可。 */
export interface LocalAlbumSqlMobileQuery {
  kind: 'groups' | 'members'; offset: number; limit: number; query: string
  rootId: string | null; albumKey: string | null; trackId: string | null; editionId: string | null; groupHash: string | null
}
export interface LocalAlbumSqlMobileRow { album: LocalAlbumSummary; groupHash: string; artworkSourceRevision: string; member: LocalAlbumGroupMember | null }
export interface LocalAlbumSqlMobilePage { revision: string; total: number; items: readonly LocalAlbumSqlMobileRow[] }
/** 私有读取策略；完整捕获只复用有效缓存，冷读保留原问题与拒收SQL。 */
export interface LocalAlbumSqlIssueReadOptions { buildDerivedIndex?: boolean }
export interface LocalAlbumSqlIssuePage { total: number; items: readonly LocalAlbumIssue[]; rejectedTotal: number; rejectedFiles: readonly { relative: string; revision: string }[] }
export interface LocalAlbumSqlCueStored { id: string; sidecarId: string; libraryRootId: string; sourceRootId: string; rootRevision: string; item: LocalCuePreparedItem }
/** 派生API包独立预算；仅含当页≤200张公开卡片及完整counts，不套用原64KiB源行限制。 */
export const LOCAL_ALBUM_SQL_ENVELOPE_MAX_BYTES = 2 * 1024 * 1024
/** 派生缓存的独立更小上限；超界放弃整缓存，不改变原读取/完整捕获预算。 */
export const LOCAL_ALBUM_SQL_DERIVED_MAX_BYTES = 16 * 1024 * 1024
export const LOCAL_ALBUM_SQL_DERIVED_ALLOCATION_BYTES = 32 * 1024 * 1024
export const LOCAL_ALBUM_SQL_DERIVED_MAX_ITEMS = 10_000
export interface LocalAlbumSqlPageEnvelope { counts: LocalAlbumFilterCounts; total: number; items: readonly LocalAlbumSummary[] }
export interface LocalAlbumSqlCodec {
  track(row: Record<string, unknown>): LocalTrack
  asset(row: Record<string, unknown>): AudioAsset
  versionTokens(fields: LocalMetadata): VersionNameToken[]
  boundedRow(row: Record<string, unknown>): void
  scanState(rootId: string, relative: string): ScanFileState | null
  cue(raw: unknown): LocalAlbumSqlCueStored
}
export interface LocalAlbumSqlSource { projectionSql: string; sourceRaw?: string; sourceLookup?: (trackId: string) => { ordinal: number; fields: LocalMetadata } | undefined }
export interface LocalAlbumSqlPort {
  privateAlbumBrowserQuery(request: LocalAlbumQuery, scope: LocalAlbumSqlScope): LocalAlbumPage
  privateAlbumBrowserMobile(request: LocalAlbumSqlMobileQuery, scope: LocalAlbumSqlScope): LocalAlbumSqlMobilePage
  privateAlbumBrowserMembers(request: LocalAlbumTrackQuery, scope: LocalAlbumSqlScope): LocalAlbumSqlMemberPage
  privateAlbumBrowserIssues(request: LocalAlbumTrackQuery, scope: LocalAlbumSqlScope, readOptions?: LocalAlbumSqlIssueReadOptions): LocalAlbumSqlIssuePage
  privateAlbumBrowserArtwork(request: LocalAlbumArtworkRequest, scope: LocalAlbumSqlScope): LocalAlbumArtworkReadContext
}
