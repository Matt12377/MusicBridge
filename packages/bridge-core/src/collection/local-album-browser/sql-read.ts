import type { MobileStructureAlbum, MobileStructureRow, MobileStructurePage } from './mobile-structure.js'
import { createLocalAlbumArtworkMembershipIssuer } from './artwork-membership-projection.js'
import { createHash, type Hash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { performance } from 'node:perf_hooks'
import { captureLocalAlbumContext, localAlbumPhase, emitLocalAlbumNodeTrace } from '../../shared/local-album-read-trace-node.js'
import { logLibraryOperation } from '../../shared/library-operation-log.js'
import type { LocalAlbumTraceStage } from '../../shared/library-read-trace.js'
import { classifyDirectoryName } from '../../library/local-name-rules.js'
import { readProjectedLocalMetadata } from '../../library/local-artist-fields.js'
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import * as dto from '@music-bridge/contracts'
import { isLocalAlbumPrivateRelative, LocalAlbumReadError } from './grouping.js'
import { LOCAL_ALBUM_SQL_ENVELOPE_MAX_BYTES, LOCAL_ALBUM_SQL_DERIVED_MAX_BYTES, LOCAL_ALBUM_SQL_DERIVED_ALLOCATION_BYTES, LOCAL_ALBUM_SQL_DERIVED_MAX_ITEMS, type LocalAlbumSqlCodec, type LocalAlbumSqlScope, type LocalAlbumSqlSource, type LocalAlbumSqlMemberPage, type LocalAlbumSqlIssuePage, type LocalAlbumSqlIssueReadOptions, type LocalAlbumSqlPageEnvelope, type LocalAlbumSqlMobileQuery, type LocalAlbumSqlMobileRow, type LocalAlbumSqlMobilePage } from './sql-types.js'
import type { LocalAlbumArtworkReadContext, LocalAlbumGroupMember, LocalAlbumIssue, LocalAlbumTrackFact } from './types.js'
import type { LocalAlbumSourceMemberRequest, LocalAlbumSourceMemberIdentity, LocalAlbumSourceMemberResult } from './source-member-identity.js'
import type { LocalAlbumSqlObservationHistory, LocalAlbumSqlObservationPoint } from './sql-types.js'
import { localAlbumScanScopeOrigin, localAlbumScanPath, type LocalAlbumScanPoint, type LocalAlbumScanScopeOrigin, type LocalAlbumScanPath } from './scan-delta.js'
import { isLocalAlbumBackgroundCandidateQuery, isLocalAlbumBackgroundCandidatePage, LOCAL_ALBUM_BACKGROUND_CANDIDATE_BYTES,
  type LocalAlbumBackgroundCandidateQuery, type LocalAlbumBackgroundCandidatePage } from './artwork-background-candidates.js'

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const invalid = (): never => { throw new LocalAlbumReadError('INVALID_REQUEST', '本地专辑请求无效，请重新选择。') }
const unavailable = (): never => { throw new LocalAlbumReadError('UNAVAILABLE', '本地专辑事实暂时无法读取，请重试。') }
const changed = (): never => { throw new LocalAlbumReadError('SNAPSHOT_CHANGED', '音乐库或来源信息已变化，请重新读取。') }
/** 仅artwork已核当前组的错配或完整当前集合/目标SQL确认缺组；一次消费，公开code或旧异常重放均无资格。 */
const artworkClaimMismatches = new WeakSet<LocalAlbumReadError>()
const staleArtworkClaim = (): never => {
  const error = new LocalAlbumReadError('SNAPSHOT_CHANGED', '音乐库或来源信息已变化，请重新读取。')
  artworkClaimMismatches.add(error); throw error
}
const limited = (): never => { throw new LocalAlbumReadError('CONTENT_LIMIT_EXCEEDED', '本地专辑读取范围超过预算，本次未返回截断内容。') }
function noteSqlTiming(stage: LocalAlbumTraceStage, outcome: 'begin' | 'ok'): void {
  try {
    const context = captureLocalAlbumContext(); if (!context) return
    const previous = context.stage
    try { localAlbumPhase(stage); emitLocalAlbumNodeTrace(outcome) } finally { context.stage = previous }
  } catch { /* 私有计时旁注不能改变原SQL结果、异常或首拒绝阶段。 */ }
}
const parent = (relative: string): string => relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : ''
const basename = (relative: string): string => relative.slice(relative.lastIndexOf('/') + 1)
const ordinal = (value: unknown): number | null => { const text = typeof value === 'string' ? value.trim() : ''; const n = /^(?:[1-9]\d*)(?:\/[1-9]\d*)?$/u.test(text) ? Number(text.split('/')[0]) : NaN; return Number.isSafeInteger(n) && n <= 1_000_000 ? n : null }
const fields = [...dto.LOCAL_METADATA_TEXT_FIELDS, ...dto.LOCAL_METADATA_ARTIST_FIELDS]
const sourceColumns = ['id','asset_id','data','asset_record_id','root_id','source_root_id','relative','sha256','asset_data',...fields.flatMap(field => [`raw_${field}`,`effective_${field}`])]
const statuses = dto.LOCAL_ALBUM_STATUSES
const statusColumns = ['missing_artwork', 'has_artwork', 'cue_unsplit', 'metadata_issue', 'name_failed', 'loose_audio', 'track_named_audio', 'missing_lyrics'] as const
const opaque = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,255}$/u.test(value)
function closed(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false
  return required.every(key => Object.hasOwn(value, key)) && Reflect.ownKeys(value).every(key => typeof key === 'string' && [...required, ...optional].includes(key)
    && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))
}
function dense(value: unknown, maximum: number): value is unknown[] {
  return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length <= maximum
    && Reflect.ownKeys(value).length === value.length + 1 && Reflect.ownKeys(value).every(key => key === 'length' || typeof key === 'string' && /^(0|[1-9][0-9]*)$/u.test(key)
      && Number(key) < value.length && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))
}

/** 与SQL组织边界共用的纯步骤；不打开目录、不产生读取或Source写许可。 */
export function localAlbumOrganizationBoundaryStep(role: dto.LocalLibraryRole | null, directory: string,
  directCount: number, numberedSiblings: number, trackSiblings: number): string {
  if (role !== null && !['catalog','artist','album','container'].includes(role)
    || typeof directory !== 'string' || !isLocalAlbumPrivateRelative(directory,true)) return unavailable()
  if (role === 'album') return ''
  if (role !== 'artist' || !directory || !parent(directory)) return directory
  if (!Number.isSafeInteger(directCount) || directCount < 0 || !Number.isSafeInteger(numberedSiblings) || numberedSiblings < 0
    || trackSiblings !== 0 && trackSiblings !== 1) return unavailable()
  const kind = classifyDirectoryName(basename(directory))
  return kind === 'disc' || kind === 'format'
    || /^\d{1,2}$/u.test(basename(directory).trim()) && Number(basename(directory)) > 0 && numberedSiblings >= 2
    || directCount <= 1 && trackSiblings === 1 ? parent(directory) : directory
}
/** 从同一原目录事实全集复演organization_boundary_steps；资产去重与兄弟判据和SQL相同。 */
export function localAlbumOrganizationDirectoryBoundaries(
  audio: Iterable<Readonly<{rootId: string; assetId: string; relative: string}>>,
  roles: ReadonlyMap<string,dto.LocalLibraryRole>,
): ReadonlyMap<string,ReadonlyMap<string,string>> {
  if (roles.size > 100 || [...roles].some(([id,role]) => !dto.isCollectionId(id) || !['catalog','artist','album','container'].includes(role))) return unavailable()
  const roots = new Map<string,Map<string,Set<string>>>(), assets = new Map<string,string>()
  let rows = 0
  for (const row of audio) {
    if (++rows > 300_000) return limited()
    if (!closed(row,['rootId','assetId','relative']) || !dto.isCollectionId(row.rootId) || !dto.isCollectionId(row.assetId)
      || !isLocalAlbumPrivateRelative(row.relative)) return unavailable()
    if (roles.get(row.rootId) !== 'artist') continue
    const directory = parent(row.relative)
    if (directory && directory.split('/').length > 64) return limited()
    const key = JSON.stringify([row.rootId,row.assetId]), previous = assets.get(key)
    if (previous !== undefined && previous !== row.relative) return unavailable()
    assets.set(key,row.relative)
    const directories = roots.get(row.rootId) ?? new Map<string,Set<string>>()
    const selected = directories.get(directory) ?? new Set<string>()
    selected.add(row.assetId); directories.set(directory,selected); roots.set(row.rootId,directories)
  }
  const result = new Map<string,ReadonlyMap<string,string>>()
  for (const [rootId,directories] of roots) {
    const siblings = new Map<string,{count: number; numbered: number; allTrack: boolean}>()
    for (const [directory,ids] of directories) {
      const key = parent(directory), value = siblings.get(key) ?? {count:0,numbered:0,allTrack:true}
      value.count++; value.numbered += /^\d{1,2}$/u.test(basename(directory).trim()) && Number(basename(directory)) > 0 ? 1 : 0
      value.allTrack &&= ids.size <= 1 && classifyDirectoryName(basename(directory)) === 'track'
      siblings.set(key,value)
    }
    const boundaries = new Map<string,string>()
    for (const physicalDirectory of directories.keys()) {
      let directory = physicalDirectory
      for (let depth = 0; depth < 64; depth++) {
        const sibling = siblings.get(parent(directory))
        const next = localAlbumOrganizationBoundaryStep('artist',directory,directories.get(directory)?.size ?? 0,
          sibling?.numbered ?? 0,sibling && sibling.count >= 2 && sibling.allTrack ? 1 : 0)
        if (next === directory) break
        directory = next
      }
      // SQL min(directory)取仅逐层parent链的最后祖先；无需生成最多64倍的祖先集合。
      boundaries.set(physicalDirectory,directory)
    }
    result.set(rootId,boundaries)
  }
  return result
}

/** 只有同一实际连接、同一完整读屏障的派生索引；不保存FD或写许可。 */
interface DerivedItem { ordinal: number; category: number; tie: string; raw: string }
interface DerivedSnapshot {
  groups: Map<string, string>
  members: Map<string, DerivedItem[]>
  issues: Map<string, DerivedItem[]>
  rejected: Map<string, DerivedItem[]>
}
type SqlAuthor = readonly unknown[]
const observationHistories = new WeakMap<object, { db: DatabaseSync; point: string; ordinal(trackId: string, rowId: bigint): number | undefined; current(): boolean }>()
const observationPoint = (point: LocalAlbumSqlObservationPoint): string => JSON.stringify([point.changes,point.version,point.schema,point.transaction])
/** CAST(rowid AS TEXT)的规范有符号64位身份不经JS number；0也是合法SQLite行号。 */
function observationRowId(value: unknown): bigint | undefined {
  if (typeof value !== 'string' || value.length > 20 || !/^(?:0|[1-9][0-9]*|-[1-9][0-9]*)$/u.test(value)) return undefined
  const rowId = BigInt(value)
  return rowId >= -9223372036854775808n && rowId <= 9223372036854775807n ? rowId : undefined
}
/** 仅供目录完整冷核成功后注册；任意外部对象/跨连接句柄均不能成为SQL事实索引。 */
export function createLocalAlbumSqlObservationHistory(db: DatabaseSync, point: LocalAlbumSqlObservationPoint,
  ordinal: (trackId: string, rowId: bigint) => number | undefined, current: () => boolean): LocalAlbumSqlObservationHistory {
  const handle = Object.freeze(Object.create(null)) as LocalAlbumSqlObservationHistory
  observationHistories.set(handle, { db, point: observationPoint(point), ordinal, current }); return handle
}
/** 同一只读作者已证明只有队列变化时续接原观察索引，不换作者或任何元数据。 */
export function continueReadonlyQueueObservationHistory(db: DatabaseSync, handle: LocalAlbumSqlObservationHistory,
  before: LocalAlbumSqlObservationPoint, after: LocalAlbumSqlObservationPoint): void {
  const saved = observationHistories.get(handle)
  if (!saved || saved.db !== db || saved.point !== observationPoint(before) || !saved.current()
    || !db.isTransaction || db.prepare('PRAGMA query_only').get()?.query_only !== 1
    || before.changes !== after.changes || before.schema !== after.schema) throw new Error('只读队列观察作者水位不匹配。')
  saved.point = observationPoint(after)
}
function currentObservationHistory(db:DatabaseSync,handle:LocalAlbumSqlObservationHistory|undefined,point:string|undefined) {
  try { const history=handle&&observationHistories.get(handle);return history&&history.db===db&&history.point===point&&history.current()?history:undefined } catch { return undefined }
}
const sameAuthor = (left: SqlAuthor, right: SqlAuthor): boolean => left.length === right.length && left.every((value, index) => value === right[index])
interface DerivedEntry { barrier: string; author: SqlAuthor; inventory: LocalAlbumSqlScope['lyricsInventory']; artworkInventory: LocalAlbumSqlScope['artworkInventory']; snapshot: DerivedSnapshot | null }
const derivedSnapshots = new WeakMap<DatabaseSync, DerivedEntry>()
/** 卡片全集只保摘要和每组一个读图索引；不持有全曲目、问题或图片。 */
interface CompactSnapshot { groups: Map<string, string>; bytes: number }
interface ScanCacheOrigin { point: LocalAlbumScanPoint; origin: LocalAlbumScanScopeOrigin; base: string }
interface CompactEntry extends Omit<DerivedEntry, 'snapshot'> { rootId: string | null; snapshot: CompactSnapshot | null; scan?: ScanCacheOrigin }
const compactSnapshots = new WeakMap<DatabaseSync, CompactEntry>()
// 此独立预算只覆盖摘要、键和三ID候选；按字符串四倍及Map开销预留临时JSON拼包。
// 不提高原Derived、capture、DTO、图片或成员读取上限；超界保存弃缓存哨兵，不能返回缓存前缀。
const COMPACT_MAX_GROUPS = 16_384, COMPACT_MAX_BYTES = 16 * 1024 * 1024, COMPACT_MAX_ALLOCATION = 64 * 1024 * 1024
interface DirectoryHint { directory: string; rootPin: string; organizationPin: string }
interface DirectoryHints { entries: Map<string, DirectoryHint>; bytes: number }
/** 位置提示允许跨扫描批次；每次仍重算当前目录，提示本身不是快照或读取许可。 */
const directoryHints = new WeakMap<DatabaseSync, DirectoryHints>()
const HINT_MAX_ITEMS = 4096, HINT_MAX_BYTES = 2 * 1024 * 1024
interface CueSnapshot {
  payloads: Map<number, string>; rootRows: Map<string, number[]>; directories: Map<string, number[]>; unsafe: Set<string>; unknownRoots: Set<string>; bytes: number
}
interface CueEntry { barrier: string; author: SqlAuthor; rootId: string | null; snapshot: CueSnapshot | null }
const cueSnapshots = new WeakMap<DatabaseSync, CueEntry>()
// 只保最新CUE轻量payload及目录归属，不缓存全资产路径；原始CUE、源许可和FD均不进入缓存。
const CUE_MAX_ITEMS = 65_536, CUE_MAX_BYTES = 8 * 1024 * 1024, CUE_MAX_ALLOCATION = 32 * 1024 * 1024
const currentReaders = new WeakMap<DatabaseSync, object>()
const installedAuthors = new WeakMap<DatabaseSync, { author: SqlAuthor; scope: string; inventory: LocalAlbumSqlScope['lyricsInventory']; artworkInventory: LocalAlbumSqlScope['artworkInventory'] }>()
/** 仅丢弃被同连接另一SQL作者替换的缓存；不授予读取或写入许可。 */
export const isCurrentLocalAlbumSqlReader = (db: DatabaseSync, reader: object): boolean => currentReaders.get(db) === reader
const groupIdentity = (rootId: string, albumKey: string): string => JSON.stringify([rootId, albumKey])
const binaryCompare = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b))

/** 原guard只认识原闭集错误。新读模型在回调内封送自己的code，离开guard后重建固定中文错误。 */
export function readWithLocalAlbumSqlErrors<T>(
  read: <V>(action: (db: DatabaseSync) => V) => V,
  action: (db: DatabaseSync) => T,
): T {
  const messages: Record<LocalAlbumReadError['code'], string> = {
    INVALID_REQUEST: '本地专辑请求无效，请重新选择。',
    SNAPSHOT_CHANGED: '音乐库或来源信息已变化，请重新读取。',
    CONTENT_LIMIT_EXCEEDED: '本地专辑读取范围超过预算，本次未返回截断内容。',
    UNAVAILABLE: '本地专辑事实暂时无法读取，请重试。',
  }
  type Outcome = { ok: true; value: T } | { ok: false; code: LocalAlbumReadError['code'] }
  const result = read<Outcome>(db => {
    try { return { ok: true, value: action(db) } }
    catch (error) {
      // 原完整性、资源预算、未知异常继续由原guard处理；不能按message猜测业务码。
      if (!(error instanceof LocalAlbumReadError) || !Object.hasOwn(messages, error.code)) throw error
      return { ok: false, code: error.code }
    }
  })
  if (result.ok) return result.value
  throw new LocalAlbumReadError(result.code, messages[result.code])
}

/** 每次读取都校验完整当前scope；回调身份由原catalog缓存另行比较。 */
export function localAlbumSqlScopeFingerprint(scope: LocalAlbumSqlScope): string {
  if (!closed(scope, ['revision', 'roots'], ['nameEnhancements', 'artworkObservations', 'artworkInventory', 'lyricsInventory', 'libraryOrganizations', 'assertReadActive']) || !opaque(scope.revision) || !dense(scope.roots, 100) || !scope.roots.every(dto.isLocalRootView) || new Set(scope.roots.map(view => view.root.id)).size !== scope.roots.length || scope.assertReadActive !== undefined && typeof scope.assertReadActive !== 'function') return unavailable()
  if (scope.lyricsInventory && (typeof scope.lyricsInventory.revision !== 'function' || typeof scope.lyricsInventory.read !== 'function' || !opaque(scope.lyricsInventory.revision()))) return unavailable()
  if (scope.artworkInventory && (typeof scope.artworkInventory.revision !== 'function' || typeof scope.artworkInventory.read !== 'function' || !opaque(scope.artworkInventory.revision()))) return unavailable()
  const organization = scope.libraryOrganizations ?? []
  if (!dense(organization, 100) || new Set(organization.map(item => item.rootId)).size !== organization.length
    || new Set(organization.map(item => item.datasetId)).size > 1
    || !organization.every(item => closed(item, ['datasetId','rootId','sourceRootId','rootRevision','bindingRevision','recordSha256','role','rootName','parentName'])
      && dto.isCommandOutboxDatasetId(item.datasetId) && dto.isCollectionId(item.rootId) && dto.isCollectionId(item.sourceRootId)
      && dto.isLocalCatalogRevision(item.rootRevision) && Number.isSafeInteger(item.bindingRevision) && item.bindingRevision > 0
      && typeof item.recordSha256 === 'string' && /^[a-f0-9]{64}$/u.test(item.recordSha256)
      && typeof item.role === 'string' && ['catalog','artist','album','container'].includes(item.role) && dto.isLocalCatalogText(item.rootName) && dto.isLocalCatalogText(item.parentName)
      && scope.roots.some(view => view.root.id === item.rootId && view.root.role === 'library'
        && view.root.sourceRootId === item.sourceRootId && view.root.revision === item.rootRevision))) return unavailable()
  const allRoots = new Set(scope.roots.map(view => view.root.id))
  const roots = new Map(scope.roots.filter(view => view.root.role === 'library').map(view => [view.root.id, view]))
  const names = scope.nameEnhancements ?? [], observations = scope.artworkObservations ?? []
  if (!dense(names, 600_000) || !names.every(item => closed(item, ['rootId','directory','revision','state']) && typeof item.rootId === 'string' && allRoots.has(item.rootId)
    && isLocalAlbumPrivateRelative(item.directory, true) && opaque(item.revision) && ['failed','ready','cancelled','not-run'].includes(String(item.state)))
    || !dense(observations, 512) || !observations.every(item => closed(item, ['albumKey','rootId','sourceRevision','state','revision']) && opaque(item.albumKey) && typeof item.rootId === 'string'
      && roots.has(item.rootId) && item.sourceRevision === scope.revision && ['available','missing'].includes(String(item.state)) && opaque(item.revision))
    || new Set(observations.map(item => JSON.stringify([item.rootId, item.albumKey]))).size !== observations.length) return unavailable()
  const original = [scope.revision, scope.roots, names, observations, scope.lyricsInventory?.revision() ?? null,
    ...(scope.artworkInventory ? [scope.artworkInventory.revision()] : [])]
  return hash(organization.length ? [...original, organization] : original)
}

/** 原作者单个 guarded read 内使用；只执行SELECT及受控函数注册，不写表或打开新连接。 */
type MobileSqlRow = LocalAlbumSqlMobileRow | MobileStructureRow
type MobileSqlPage = { revision: string; total: number; items: readonly MobileSqlRow[] }

export function createLocalAlbumSqlReader(db: DatabaseSync, source: LocalAlbumSqlSource, codec: LocalAlbumSqlCodec, scope: LocalAlbumSqlScope) {
  const reader = createSqlReader(db, source, codec, scope, false)
  return reader as Omit<typeof reader, 'queryMobile'> & { queryMobile(request: LocalAlbumSqlMobileQuery): LocalAlbumSqlMobilePage }
}
/** 专用移动候选不生成旧 LocalAlbumSummary，也不读取库存或歌词。 */
export function createLocalAlbumMobileStructureSqlReader(db: DatabaseSync, source: LocalAlbumSqlSource, codec: LocalAlbumSqlCodec, scope: LocalAlbumSqlScope) {
  const reader = createSqlReader(db, source, codec, scope, true)
  return { queryMobile: (request: LocalAlbumSqlMobileQuery): MobileStructurePage => reader.queryMobile(request) as MobileStructurePage }
}
function createSqlReader(db: DatabaseSync, source: LocalAlbumSqlSource, codec: LocalAlbumSqlCodec, scope: LocalAlbumSqlScope, structureOnly: boolean) {
  localAlbumSqlScopeFingerprint(scope)
  const readAuthor = (): SqlAuthor => [source.sourceLookup, source.observationHistory, codec.track, codec.asset, codec.versionTokens, codec.boundedRow, codec.scanState, codec.scanStateProjected, codec.cue, scope.assertReadActive, scope.artworkInventory?.readPersistedProjected]
  // 独立索引连接的只读事务也须逐 UDF 检查 SAB；原显式写事务的事实重核纪律不变。
  const readOnlyConnection = db.prepare('PRAGMA query_only').get()?.query_only === 1
  const assertReadActive = (): void => { if (structureOnly || readOnlyConnection || !db.isTransaction) scope.assertReadActive?.() }
  const initialAuthor = readAuthor()
  const roots = new Map(scope.roots.filter(view => view.root.role === 'library').map(view => [view.root.id, view]))
  const names = scope.nameEnhancements ?? [], observations = scope.artworkObservations ?? []
  const organizationFacts = scope.libraryOrganizations ?? []
  const organizations = new Map(organizationFacts.map(item => [item.rootId, item]))
  const organized = organizationFacts.some(item => item.role === 'artist' || item.role === 'album')
  currentReaders.delete(db)
  const statements = new Map<string, ReturnType<DatabaseSync['prepare']>>()
  let statementBytes = 0
  const hasTable = (table: string): boolean => !!statement("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table)
  const aggregates = new Map<number, { hash?: Hash; values?: string[]; many?: boolean }>(); let serial = 0
  const smallCache = new Map<string, string>(); let smallBytes = 0
  const cached = (key: string, read: () => string): string => { const found = smallCache.get(key); if (found !== undefined) { smallCache.delete(key); smallCache.set(key, found); return found }; const value = read(); const bytes = Buffer.byteLength(value) + Buffer.byteLength(key); while (smallCache.size && (smallBytes + bytes > 1024 * 1024 || smallCache.size >= 32)) { const first = smallCache.keys().next().value!; smallBytes -= Buffer.byteLength(first) + Buffer.byteLength(smallCache.get(first)!); smallCache.delete(first) }; if (bytes <= 1024 * 1024) { smallCache.set(key, value); smallBytes += bytes }; return value }
  const install = (name: string, action: (...args: SQLOutputValue[]) => string | number | null): void => {
    const checked = (...args: SQLOutputValue[]) => { assertReadActive(); return action(...args) }
    // node:sqlite以函数length确定SQL参数个数，包装不能改变原UDF签名。
    Object.defineProperty(checked, 'length', { value: action.length })
    db.function(name, { deterministic: true }, checked)
  }
  let operationObservationPoint: string | undefined, lastObservationPoint: string | undefined
  if (source.observationHistory) install('mb_album_observation_after', (trackId,rowId,anchor) => {
    try {
      const history = currentObservationHistory(db,source.observationHistory,operationObservationPoint)
      const observedRowId = observationRowId(rowId)
      if (!history
        || typeof trackId !== 'string' || observedRowId === undefined
        || typeof anchor !== 'number' || !Number.isSafeInteger(anchor) || anchor < 1) return null
      const ordinal = history.ordinal(trackId,observedRowId)
      return typeof ordinal === 'number' && Number.isSafeInteger(ordinal) && ordinal > 0 ? ordinal > anchor ? 1 : 0 : null
    } catch { return null }
  })
  install('mb_album_root', value => typeof value === 'string' && roots.has(value) ? 1 : 0)
  install('mb_album_root_view', value => JSON.stringify(roots.get(String(value)) ?? null))
  install('mb_album_root_label', value => roots.get(String(value))?.label ?? '本地来源')
  install('mb_album_online', value => roots.get(String(value))?.availability === 'ONLINE' ? 1 : 0)
  install('mb_album_artwork_state', (albumKey, rootId, editionId, representativeTrackId, membershipDigest) => {
    if (typeof albumKey !== 'string' || typeof rootId !== 'string' || !roots.has(rootId)) return unavailable()
    // 同组的三处状态表达式共用本次run的有界缓存；空串只代表内部unknown，finally即清除。
    const result = cached(JSON.stringify(['artwork-state', albumKey, rootId]), () => {
      const projected = operationMembership && editionId === null && typeof representativeTrackId === 'string' && typeof membershipDigest === 'string'
        ? operationMembership.read({ albumKey, rootId, editionId: null, representativeTrackId, membership: membershipDigest }, proof => scope.artworkInventory!.readPersistedProjected!(proof)) : undefined
      const persisted = projected === undefined ? scope.artworkInventory?.readPersisted?.(albumKey, rootId) ?? null : projected
      if (persisted !== null) { if (!['available', 'missing'].includes(persisted)) return unavailable(); return persisted }
      const value = scope.artworkInventory?.read(albumKey, rootId) ?? 'unknown'
      if (!['available', 'missing', 'unknown'].includes(value)) return unavailable()
      return roots.get(rootId)?.availability === 'ONLINE' && value !== 'unknown' ? value : ''
    })
    return result || null
  })
  install('mb_album_organization', value => organizations.get(String(value))?.role ?? null)
  install('mb_album_organization_revision', value => { const fact=organizations.get(String(value)); return fact ? JSON.stringify(fact) : null })
  install('mb_album_root_name', value => organizations.get(String(value))?.rootName ?? '')
  install('mb_album_artist_fallback', value => {
    const fact=organizations.get(String(value)); if(!fact)return ''
    return fact.role==='album' || classifyDirectoryName(fact.rootName)==='album-container' ? fact.parentName
      : fact.rootName.replace(/\s+\d+\s*[张張](?:\[[^\]]+\])?\s*$/u,'').trim()
  })
  install('mb_album_directory_parent', value => typeof value === 'string' && isLocalAlbumPrivateRelative(value,true) ? parent(value) : unavailable())
  install('mb_album_directory_depth', value => { if(typeof value!=='string'||!isLocalAlbumPrivateRelative(value,true))return unavailable();const depth=value?value.split('/').length:0;if(depth>64)return limited();return depth })
  install('mb_album_directory_kind', value => classifyDirectoryName(basename(String(value))))
  install('mb_album_event_boundary', (rootId,value) => {
    if(typeof value!=='string'||!isLocalAlbumPrivateRelative(value,true))return unavailable()
    const role=organizations.get(String(rootId))?.role;if(role==='album')return '';if(role!=='artist')return value
    let directory=value;for(let depth=0;depth<64;depth++){
      if(!directory||!parent(directory))return directory
      const kind=classifyDirectoryName(basename(directory));if(kind!=='disc'&&kind!=='format')return directory
      directory=parent(directory)
    }
    return limited()
  })
  install('mb_album_directory_numbered', value => /^\d{1,2}$/u.test(basename(String(value)).trim()) && Number(basename(String(value)))>0 ? 1 : 0)
  // 与原目录规则使用同一classification；同SQL真实直接成员数决定数字碟和单轨目录折叠。
  install('mb_album_boundary', (rootId,directory,directCount,numberedSiblings,trackSiblings) => {
    if(typeof directory!=='string')return unavailable()
    return localAlbumOrganizationBoundaryStep(organizations.get(String(rootId))?.role ?? null,directory,
      Number(directCount),Number(numberedSiblings),Number(trackSiblings))
  })
  install('mb_album_lyrics', (trackId, rootId, fileRevision) => {
    if (!scope.lyricsInventory || typeof fileRevision !== 'string' || roots.get(String(rootId))?.availability !== 'ONLINE') return 0
    const observed = scope.lyricsInventory.read(String(trackId), String(rootId), fileRevision)
    if (!['unknown', 'false', 'true'].includes(observed)) return unavailable()
    return observed === 'true' ? 2 : observed === 'false' ? 1 : 0
  })
  install('mb_album_parent', value => typeof value === 'string' && isLocalAlbumPrivateRelative(value) ? parent(value) : unavailable())
  install('mb_album_basename', value => basename(String(value)))
  install('mb_album_trim', value => typeof value === 'string' ? value.trim() : '')
  install('mb_album_ordinal', value => ordinal(value))
  install('mb_album_named', value => /^track(?:\d+)?$/iu.test(basename(String(value)).replace(/\.[^.]+$/u, '')) ? 1 : 0)
  install('mb_album_missing', (title, artist, album) => JSON.stringify((['title','artist','album'] as const).filter((_, index) => !String([title,artist,album][index] ?? '').trim())))
  install('mb_album_sort', value => String(value).normalize('NFKD').toLocaleLowerCase('en').replace(/\d+/gu, raw => { const number = raw.replace(/^0+(?=\d)/u, ''); return `${String(number.length).padStart(6, '0')}:${number}` }))
  const tokenCount = (field: 'title' | 'artist', value: SQLOutputValue): number => typeof value === 'string' && value
    ? Number(cached(JSON.stringify(['token-count', field, value]), () => String(codec.versionTokens({ [field]: value }).length))) : 0
  install('mb_album_version', (title, artist, album) => {
    // 原codec按title→artist→album拼接后截64；输出memo必须保留前两字段占用的预算。
    const titleCount = tokenCount('title', title), remaining = Math.max(0, 64 - titleCount - (titleCount >= 64 ? 0 : tokenCount('artist', artist)))
    if (typeof album !== 'string' || !album || remaining === 0) return '[]'
    return cached(JSON.stringify(['version', album, remaining]), () => {
      const tokens = JSON.parse(cached(JSON.stringify(['album-tokens', album]), () => JSON.stringify(codec.versionTokens({ album })))) as dto.VersionNameToken[]
      return JSON.stringify([...new Set(tokens.slice(0, remaining).filter(token => token.source === 'album' && (token.kind === 'edition' || token.kind === 'format')).map(token => token.raw))].sort())
    })
  })
  const memberAlbumKey = (rootId: unknown, editionId: unknown, directory: unknown, rawAlbum: unknown, versions: unknown): string => {
    if(editionId!==null)return `edition-${hash([rootId,editionId])}`
    const role=organizations.get(String(rootId))?.role
    if(role==='artist'||role==='album')return `directory-${hash([rootId,directory,'',[]])}`
    return `directory-${hash([rootId,directory,directory===''?'':String(rawAlbum??'').trim(),directory===''?[]:JSON.parse(String(versions))])}`
  }
  install('mb_album_key', memberAlbumKey)
  install('mb_album_digest', value => hash(JSON.parse(String(value))))
  install('mb_album_group_hash', (rootId, albumKey) => typeof rootId === 'string' && roots.has(rootId) && opaque(albumKey) ? hash([rootId, albumKey]) : unavailable())
  // 输入只由固定SQL的json_object/json_array构造；按完整编码字节分层hash，不生成全库JS对象。
  install('mb_album_fact_digest', value => createHash('sha256').update(String(value)).digest('hex'))
  install('mb_album_match', (title, artists, year, version, label, query) => [title, ...JSON.parse(String(artists)), year ?? '', version ?? '', label].join(' ').toLocaleLowerCase('zh').includes(String(query).toLocaleLowerCase('zh')) ? 1 : 0)
  const scanPayload = (state: ReturnType<LocalAlbumSqlCodec['scanState']>): string => JSON.stringify(state ? { rootId: state.libraryRootId, relative: state.relative, outcome: state.outcome, assetId: state.assetId, trackId: state.trackId, embedded: !!state.readFacts?.coverEvidence.length, revision: hash([state.signature, state.parserVersion, state.failureCode, state.readFacts?.coverEvidence ?? []]), signature: state.signature, metadataFailed: state.failureCode === 'PARSE_FAILED' } : null)
  install('mb_album_scan', (rootId, relative) => cached(JSON.stringify(['scan', rootId, relative]), () => scanPayload(codec.scanState(String(rootId), String(relative)))))
  if (codec.scanStateProjected) install('mb_album_scan_projected', (rootId, relative, data, count, assetRootId, assetRelative) => cached(JSON.stringify(['scan', rootId, relative]),
    () => scanPayload(codec.scanStateProjected!(String(rootId), String(relative), data, count, assetRootId, assetRelative))))
  function decodeCue(raw: unknown): { payload: string; rootId: string; directory: string; physical: Set<string>; unknown: boolean } {
    const cue = codec.cue(raw), result = cue.item.result; let current = cue.item.outcome === 'accepted' && result !== null
    const physical = new Set<string>(); let unknown = false
    if (current) for (const item of result!.tracks) { const ref = item.assetReference, root = roots.get(ref.libraryRootId)?.root, row = statement('SELECT * FROM local_catalog_assets WHERE id=?').get(ref.assetId), scan = codec.scanState(ref.libraryRootId, ref.relative), asset = row ? codec.asset(row) : null
      if (row && asset?.libraryRootId === cue.libraryRootId && typeof row.relative === 'string' && isLocalAlbumPrivateRelative(row.relative)) physical.add(parent(row.relative)); else unknown = true
      if (!root || !asset || root.id !== cue.libraryRootId || ref.sourceRootId !== cue.sourceRootId || root.sourceRootId !== ref.sourceRootId || root.revision !== ref.rootRevision || row!.relative !== ref.relative || asset.fileRevision !== ref.fileRevision || asset.locationRevision !== ref.locationRevision || scan?.signature !== ref.signature) current = false }
    const ids = result?.tracks.map(item => item.assetReference.assetId) ?? []
    if (ids.length && (!physical.size || !current)) unknown = true
    const directory = parent(cue.item.relative)
    return { rootId: cue.libraryRootId, directory, physical, unknown, payload: JSON.stringify({ rootId: cue.libraryRootId, directory, relative: cue.item.relative, revision: hash(cue), status: cue.item.outcome === 'rejected' ? 'failed' : current ? 'ready' : 'unresolved', audioAssetIds: [...new Set(ids)], alreadySplit: current && ids.length > 0 && new Set(ids).size === ids.length }) }
  }
  install('mb_album_cue_row', (rowId, raw) => {
    const saved = operationCue ?? cueSnapshots.get(db)
    const value = saved?.barrier === operationStructureBarrier && sameAuthor(saved.author, initialAuthor) ? saved.snapshot?.payloads.get(Number(rowId)) : undefined
    return value ?? cached(JSON.stringify(['cue', rowId, raw]), () => decodeCue(raw).payload)
  })
  const makeFact = (row: Record<string, unknown>, selected: string | null, scanning: string | null): LocalAlbumTrackFact => {
    // 原64KiB行预算只计原投影；聚合键、hash输入等派生重复项不能压缩合法原字段域。
    const sourceRow = Object.fromEntries(sourceColumns.map(column => [column,row[column]]))
    codec.boundedRow(sourceRow); const rawMetadata = readProjectedLocalMetadata(row, 'raw'), metadata = readProjectedLocalMetadata(row, 'effective')
    const track = codec.track(sourceRow), asset = codec.asset({ id: row.asset_record_id, root_id: row.root_id, source_root_id: row.source_root_id, relative: row.relative, sha256: row.sha256, data: row.asset_data })
    const summary = { track, asset, metadata, versionTokens: codec.versionTokens(rawMetadata) }, scan = scanning ? JSON.parse(scanning) as { outcome: string; assetId: string; trackId: string; embedded: boolean; revision: string } | null : null
    const embedded = scan?.outcome === 'accepted' && scan.assetId === asset.id && scan.trackId === track.id && scan.embedded, available = selected !== null || !!embedded
    if (!dto.isLocalLibraryTrackSummary(summary) || !dto.isLocalMetadata(rawMetadata) || !isLocalAlbumPrivateRelative(row.relative)) return unavailable()
    return { relative: row.relative, summary, rawMetadata, hasArtwork: available, artworkRevision: available ? hash([selected, embedded ? scan!.revision : null]) : null, artworkState: available ? 'available' : 'unknown' }
  }
  // 代表行仍经原完整codec/字段/64-token预算；不把裸json_extract摘要当作已验证成员。
  install('mb_album_membership', (raw, rootId) => {
    if (typeof raw !== 'string' || typeof rootId !== 'string' || !roots.has(rootId)) return unavailable()
    const fact = makeFact(JSON.parse(raw) as Record<string, unknown>, null, null), root = roots.get(rootId)!.root
    if (fact.summary.asset.libraryRootId !== rootId || fact.summary.asset.sourceRootId !== root.sourceRootId || fact.summary.asset.rootRevision !== root.revision) return null
    const versions = [...new Set(fact.summary.versionTokens.filter(token => token.source === 'album' && (token.kind === 'edition' || token.kind === 'format')).map(token => token.raw))].sort()
    return hash(['album-membership-v1', fact.summary.track.id, fact.summary.track.assetId, fact.relative, fact.summary.asset.locationRevision, null, fact.rawMetadata.album?.trim() ?? '', versions])
  })
  function aggregate(name: string, type: 'hash' | 'artists' | 'consensus' | 'versions'): void {
    db.aggregate<number>(name, { start() { assertReadActive(); const key = ++serial; aggregates.set(key, type === 'hash' ? { hash: createHash('sha256') } : { values: [] }); return key }, step(key, value) {
      assertReadActive()
      const state = aggregates.get(key)!; if (type === 'hash') { if (value !== null) state.hash!.update(String(value)).update('\n'); return key }
      const values = type === 'versions' ? JSON.parse(String(value ?? '[]')) as string[] : typeof value === 'string' && value.trim() ? [value.trim()] : []
      if (!state.many) for (const item of values) if (!state.values!.includes(item)) { state.values!.push(item); if ((type === 'artists' && state.values!.length > 32) || (type === 'consensus' && state.values!.length > 1) || (type === 'versions' && state.values!.join(' · ').length > 512)) { state.many = true; state.values = []; break } }; return key
    }, result(key) { assertReadActive(); const state = aggregates.get(key)!; aggregates.delete(key); if (type === 'hash') return state.hash!.digest('hex'); if (type === 'artists') return JSON.stringify(state.many ? ['多位艺人'] : state.values); if (type === 'versions') return state.many ? '多个版本' : state.values!.join(' · ') || null; return state.many ? null : state.values![0] ?? null } })
  }
  aggregate('mb_album_hash', 'hash'); aggregate('mb_album_artists', 'artists'); aggregate('mb_album_consensus', 'consensus'); aggregate('mb_album_versions', 'versions')
  let projection = source.projectionSql
  const directoryGuard = (column: string): string => `(@hintDirectory IS NULL OR mb_album_parent(${column})=@hintDirectory)`
  function directorySql(text: string, directory: string): string {
    // SQL内置BINARY范围只选直属文件；length/substr同用SQLite字符计数，兼容中文及非BMP目录。
    for (const column of ['a.relative', 'c.relative', 'relative']) text = text.replaceAll(directoryGuard(column), directory === ''
      ? `instr(${column},'/')=0`
      : `(${column}>=@hintPrefix AND ${column}<@hintUpper AND instr(substr(${column},length(@hintPrefix)+1),'/')=0)`)
    for (const column of ['a.root_id', 'c.root_id', 'library_root_id']) text = text.replaceAll(`(@root IS NULL OR ${column}=@root)`, `${column}=@root`)
    return text
  }
  const sourceMarks = (membersOnly: boolean): string => `SELECT t.id,mb_album_source_ordinal(t.id) ordinal FROM local_catalog_tracks t
    JOIN local_catalog_assets a ON a.id=t.asset_id WHERE (@root IS NULL OR a.root_id=@root)
    AND ${directoryGuard('a.relative')}
    ${membersOnly ? "AND t.id IN(SELECT json_extract(value,'$.id') FROM json_each(@memberPage))" : ''}`
  // 每条guarded SQL只物化基础来源位置；完整字段仍由原raw/effective的COALESCE按需读取。
  // 无锚点的位置已经由NULL证明；缺失新增字段也不能触发无意义的完整字段回读。
  if (source.sourceLookup) { install('mb_album_source_ordinal', value => source.sourceLookup!(String(value))?.ordinal ?? null); install('mb_album_source_fields', value => { const found = source.sourceLookup!(String(value)); return found ? JSON.stringify(found.fields) : null }); const end = projection.indexOf('),candidates AS ('); if (end < 0) return unavailable(); projection = `WITH source_marks AS MATERIALIZED(${sourceMarks(false)}),source_full AS (SELECT id track_id,ordinal,CASE WHEN ordinal IS NOT NULL THEN mb_album_source_fields(id) END fields FROM source_marks),candidates AS (` + projection.slice(end + '),candidates AS ('.length) }
  const memberProjection = (): string => source.sourceLookup
    ? projection.replace(sourceMarks(false), sourceMarks(true)) : projection
  if(organized){if(!/^WITH\s/iu.test(projection))return unavailable();projection=projection.replace(/^WITH\s+(?:RECURSIVE\s+)?/iu,'WITH RECURSIVE ')}
  const packed = `json_object('id',t.id,'asset_id',t.asset_id,'data',t.data,'asset_record_id',a.id,'root_id',a.root_id,'source_root_id',a.source_root_id,'relative',a.relative,'sha256',a.sha256,'asset_data',a.data,${fields.flatMap(field => [`'raw_${field}',m.raw_${field}`, `'effective_${field}',m.effective_${field}`]).join(',')})`
  const factColumns = `t.id,t.asset_id,t.data,a.id asset_record_id,a.root_id,a.source_root_id,a.relative,a.sha256,a.data asset_data,${fields.flatMap(field => [`m.raw_${field}`, `m.effective_${field}`]).join(',')}`
  const representativePacked = packed.replaceAll('t.', 'representative_track.').replaceAll('a.', 'representative_asset.').replaceAll('m.', 'representative_metadata.')
  const membershipSql = scope.artworkInventory?.readPersistedProjected ? `CASE WHEN i.edition_id IS NULL AND m.representative_track_id IS NOT NULL THEN
    (SELECT mb_album_membership(${representativePacked},i.root_id) FROM local_catalog_tracks representative_track
      JOIN local_catalog_assets representative_asset ON representative_asset.id=representative_track.asset_id
      JOIN source_metadata representative_metadata ON representative_metadata.id=representative_track.id
      WHERE representative_track.id=m.representative_track_id) ELSE NULL END` : 'NULL'
  const selection = hasTable('local_artwork_selections') ? `LEFT JOIN local_artwork_selections art ON art.edition_id=l.edition_id AND json_extract(art.data,'$.candidate') IS NOT NULL` : `LEFT JOIN (SELECT NULL edition_id,NULL data) art ON 0`
  const selectedRevision = `CASE WHEN art.data IS NOT NULL THEN json_array(l.edition_id,json_extract(art.data,'$.revision')) ELSE NULL END`
  // 复用同一次SQL已由原codec核过的相同位置；未覆盖或SQL NULL仍走原resolver。
  // JSON文本'null'必须原样复用，不能当作缺缓存；这里不解码或相信scan表的raw JSON。
  // 所有子查询仍在原SQLite连接/同一语句中执行；LIMIT 2保留原歧义哨兵，不持久缓存状态。
  // json_valid只保护定位用assetId提取；原codec仍按64KiB闭集校验全部direct.data。
  const scanLookup = (rootId: string, relative: string): string => codec.scanStateProjected ? `(SELECT mb_album_scan_projected(${rootId},${relative},
    scan_projection_state.data,(SELECT count(*) FROM (SELECT 1 FROM local_catalog_assets scan_projection_locator
      WHERE scan_projection_locator.root_id=${rootId} AND scan_projection_locator.relative=${relative} LIMIT 2)),
    scan_projection_asset.root_id,scan_projection_asset.relative)
    FROM (SELECT 1) scan_projection_anchor
    LEFT JOIN local_scan_file_state scan_projection_state ON scan_projection_state.library_root_id=${rootId} AND scan_projection_state.relative=${relative}
    LEFT JOIN local_catalog_assets scan_projection_asset ON scan_projection_asset.id=CASE WHEN json_valid(scan_projection_state.data) THEN json_extract(scan_projection_state.data,'$.assetId') END)`
    : `mb_album_scan(${rootId},${relative})`
  const scanFiles = hasTable('local_scan_file_state') ? `SELECT coalesce((SELECT e.scan_json FROM scan_evidence e
    WHERE e.root_id=local_scan_file_state.library_root_id AND e.relative=local_scan_file_state.relative LIMIT 1),
    ${scanLookup('local_scan_file_state.library_root_id','local_scan_file_state.relative')}) payload FROM local_scan_file_state WHERE mb_album_root(library_root_id)=1
    AND (@root IS NULL OR library_root_id=@root) AND ${directoryGuard('relative')}` : `SELECT NULL payload WHERE 0`
  const scanFor = (rootId: string, relative: string, assetId: string): string => hasTable('local_scan_file_state') ? `CASE WHEN EXISTS(SELECT 1 FROM local_scan_file_state f WHERE f.library_root_id=${rootId} AND f.relative=${relative})
    OR EXISTS(SELECT 1 FROM local_scan_file_state f WHERE f.asset_id=${assetId}) THEN ${scanLookup(rootId,relative)} ELSE NULL END` : `NULL`
  const memberScan = scanFor('s.root_id', 's.relative', 's.asset_record_id'), pageScan = scanFor('a.root_id', 'a.relative', 'a.id')
  const cueRows = hasTable('local_cue_sources') ? `SELECT rowid cue_rowid,library_root_id,relative,data FROM local_cue_sources WHERE rowid IN(SELECT max(rowid) FROM local_cue_sources
    WHERE (@root IS NULL OR library_root_id=@root) GROUP BY library_root_id,relative) AND mb_album_root(library_root_id)=1
    AND (@root IS NULL OR library_root_id=@root)` : `SELECT NULL cue_rowid,NULL library_root_id,NULL relative,NULL data WHERE 0`
  const cues = `SELECT value payload FROM json_each(@cuePayloads) WHERE @cuePayloads IS NOT NULL
    UNION ALL SELECT mb_album_cue_row(cue_rowid,data) payload FROM (${cueRows}) WHERE @cuePayloads IS NULL`
  // 十二标签先按原投影计算一次；完整track/asset与字段编码只进入digest，不穿过成员排序。
  // 详情再按当页真实ID取同一标签屏障和原行，不能用卡片汇总代替原facts。
  // 扫描证据按基础来源身份在关系展开前计算；窄行保留原resolver及完整payload。
  // 每个真实关系只计算一次分组键；三列屏障保留无关系行及全部活动关系，不提前分页。
  const sourceRowsSql = organized ? `source_audio AS MATERIALIZED(SELECT t.id,a.id asset_record_id,a.root_id,a.relative,mb_album_parent(a.relative) physical_directory,mb_album_sort(a.relative) sort_relative,
      m.raw_album,m.effective_artist,m.effective_album,m.effective_year,mb_album_version(m.raw_title,m.raw_artist,m.raw_album) versions,
      mb_album_ordinal(m.effective_disc) source_disc,mb_album_ordinal(m.effective_track) source_track,mb_album_named(a.relative) track_named_audio,
      ${structureOnly ? 'NULL' : "mb_album_lyrics(t.id,a.root_id,json_extract(a.data,'$.fileRevision'))"} lyrics_presence,
      mb_album_fact_digest(${packed}) source_digest FROM source_metadata m JOIN local_catalog_tracks t ON t.id=m.id JOIN local_catalog_assets a ON a.id=t.asset_id),
    organization_paths(root_id,directory) AS(SELECT DISTINCT root_id,physical_directory FROM source_audio
      WHERE mb_album_organization(root_id)='artist' AND mb_album_directory_depth(physical_directory)<=64
      UNION SELECT root_id,mb_album_directory_parent(directory) FROM organization_paths WHERE directory<>''),
    organization_direct_audio AS(SELECT root_id,physical_directory,count(DISTINCT asset_record_id) direct_count
      FROM source_audio WHERE mb_album_organization(root_id)='artist' GROUP BY root_id,physical_directory),
    organization_directory_facts AS MATERIALIZED(SELECT p.root_id,p.directory physical_directory,mb_album_directory_parent(p.directory) parent_directory,
      coalesce(a.direct_count,0) direct_count,mb_album_directory_numbered(p.directory) numbered,
      mb_album_directory_kind(p.directory) directory_kind FROM organization_paths p LEFT JOIN organization_direct_audio a ON a.root_id=p.root_id AND a.physical_directory=p.directory),
    organization_siblings AS(SELECT root_id,parent_directory,sum(numbered) numbered_siblings,
      count(*)>=2 AND min(direct_count<=1 AND directory_kind='track') track_siblings FROM organization_directory_facts WHERE direct_count>0 GROUP BY root_id,parent_directory),
    organization_boundary_steps(root_id,physical_directory,directory,depth) AS(SELECT root_id,physical_directory,physical_directory,0
      FROM organization_directory_facts WHERE direct_count>0
      UNION ALL SELECT p.root_id,p.physical_directory,
        mb_album_boundary(p.root_id,p.directory,f.direct_count,coalesce(g.numbered_siblings,0),coalesce(g.track_siblings,0)),p.depth+1
      FROM organization_boundary_steps p JOIN organization_directory_facts f ON f.root_id=p.root_id AND f.physical_directory=p.directory
      LEFT JOIN organization_siblings g ON g.root_id=f.root_id AND g.parent_directory=f.parent_directory
      WHERE p.depth<64 AND mb_album_boundary(p.root_id,p.directory,f.direct_count,coalesce(g.numbered_siblings,0),coalesce(g.track_siblings,0))<>p.directory),
    organization_boundaries AS MATERIALIZED(SELECT root_id,physical_directory,min(directory) directory FROM organization_boundary_steps GROUP BY root_id,physical_directory),
    source_rows AS MATERIALIZED(SELECT a.*,CASE WHEN mb_album_organization(a.root_id)='album' THEN '' ELSE coalesce(b.directory,a.physical_directory) END directory
      FROM source_audio a LEFT JOIN organization_boundaries b ON b.root_id=a.root_id AND b.physical_directory=a.physical_directory)` : `source_rows AS MATERIALIZED(SELECT t.id,a.id asset_record_id,a.root_id,a.relative,mb_album_parent(a.relative) directory,mb_album_sort(a.relative) sort_relative,
      m.raw_album,m.effective_artist,m.effective_album,m.effective_year,mb_album_version(m.raw_title,m.raw_artist,m.raw_album) versions,
      mb_album_ordinal(m.effective_disc) source_disc,mb_album_ordinal(m.effective_track) source_track,mb_album_named(a.relative) track_named_audio,
      ${structureOnly ? 'NULL' : "mb_album_lyrics(t.id,a.root_id,json_extract(a.data,'$.fileRevision'))"} lyrics_presence,
      mb_album_fact_digest(${packed}) source_digest FROM source_metadata m JOIN local_catalog_tracks t ON t.id=m.id JOIN local_catalog_assets a ON a.id=t.asset_id)`
  const eventDirectory = (root:string,directory:string):string => organized
    ? `CASE WHEN mb_album_organization(${root})='album' THEN '' WHEN mb_album_organization(${root})='artist' THEN coalesce((SELECT b.directory FROM organization_boundaries b WHERE b.root_id=${root} AND b.physical_directory=${directory}),mb_album_event_boundary(${root},${directory})) ELSE ${directory} END`
    : directory
  const factsSql = `${projection},
    source_metadata AS MATERIALIZED(SELECT c.id,${fields.flatMap(field => [`c.raw_${field}`, `c.effective_${field}`]).join(',')} FROM candidates c WHERE mb_album_root(c.root_id)=1
      AND (@root IS NULL OR c.root_id=@root) AND ${directoryGuard('c.relative')}),
    ${sourceRowsSql},
    scan_evidence AS MATERIALIZED(SELECT s.id,s.asset_record_id,s.root_id,s.relative,${memberScan} scan_json FROM source_rows s),
    relation_keys AS MATERIALIZED(SELECT s.id,l.id relation_id,
      mb_album_key(s.root_id,l.edition_id,s.directory,s.raw_album,s.versions) album_key
      FROM source_rows s JOIN scan_evidence e ON e.id=s.id AND e.asset_record_id=s.asset_record_id AND e.root_id=s.root_id AND e.relative=s.relative
      LEFT JOIN local_catalog_edition_tracks l ON l.track_id=s.id AND json_extract(l.data,'$.active')=1),
    prepared AS(SELECT s.*,l.id relation_id,l.data relation_data,l.edition_id,
      k.album_key,
      ${selectedRevision} selected_revision,e.scan_json,
      CASE WHEN l.data IS NOT NULL THEN json_extract(l.data,'$.disc') ELSE s.source_disc END disc,
      CASE WHEN l.data IS NOT NULL THEN json_extract(l.data,'$.trackNumber') ELSE s.source_track END track_number,
      json_extract(l.data,'$.sequence') relation_sequence
      FROM relation_keys k JOIN source_rows s ON s.id=k.id JOIN scan_evidence e ON e.id=s.id AND e.asset_record_id=s.asset_record_id AND e.root_id=s.root_id AND e.relative=s.relative
      LEFT JOIN local_catalog_edition_tracks l ON l.id=k.relation_id ${selection}),
    member_evidence AS(SELECT id,asset_record_id,root_id,directory,sort_relative,raw_album,effective_artist,effective_album,effective_year,versions,
      relation_id,edition_id,album_key,disc,track_number,relation_sequence,track_named_audio,lyrics_presence,
      coalesce(selected_revision IS NOT NULL OR json_extract(scan_json,'$.outcome')='accepted' AND json_extract(scan_json,'$.assetId')=asset_record_id AND json_extract(scan_json,'$.trackId')=id AND json_extract(scan_json,'$.embedded')=1,0) has_artwork,
      mb_album_fact_digest(json_array(source_digest,json(relation_data),selected_revision,json(scan_json))) member_digest FROM prepared),
    members AS MATERIALIZED(SELECT id,asset_record_id,root_id,directory,raw_album,effective_artist,effective_album,effective_year,versions,
      relation_id,edition_id,album_key,disc,track_number,track_named_audio,has_artwork,member_digest,lyrics_presence,
      ROW_NUMBER() OVER(PARTITION BY album_key ORDER BY coalesce(disc,1000001),coalesce(track_number,1000001),coalesce(relation_sequence,1000001),sort_relative,id) sequence FROM member_evidence),
    directories AS(SELECT root_id,directory,count(DISTINCT album_key) n,max(edition_id IS NOT NULL) has_edition,min(album_key) only_key FROM members GROUP BY root_id,directory),
    scan_files AS MATERIALIZED(${scanFiles}),
    rejected AS(SELECT json_extract(payload,'$.rootId') root_id,${eventDirectory("json_extract(payload,'$.rootId')","mb_album_parent(json_extract(payload,'$.relative'))")} directory,json_extract(payload,'$.relative') relative,json_extract(payload,'$.revision') revision,json_extract(payload,'$.metadataFailed') metadata_issue FROM scan_files WHERE json_extract(payload,'$.outcome')='rejected'),
    cue_facts AS MATERIALIZED(${cues}),
    cue_members AS(SELECT DISTINCT json_extract(c.payload,'$.rootId') root_id,${organized ? "CASE WHEN mb_album_organization(m.root_id) IN ('artist','album') THEN m.directory ELSE json_extract(c.payload,'$.directory') END" : "json_extract(c.payload,'$.directory')"} directory,m.album_key,c.payload FROM cue_facts c CROSS JOIN json_each(c.payload,'$.audioAssetIds') a CROSS JOIN members m WHERE m.root_id=json_extract(c.payload,'$.rootId') AND m.asset_record_id=a.value),
    cue_fallback AS(SELECT json_extract(c.payload,'$.rootId') root_id,${eventDirectory("json_extract(c.payload,'$.rootId')","json_extract(c.payload,'$.directory')")} directory,c.payload FROM cue_facts c WHERE NOT EXISTS(SELECT 1 FROM cue_members x WHERE x.payload=c.payload)),
    fallback_events AS(SELECT root_id,directory,revision,metadata_issue,0 cue_unsplit,0 name_failed,CASE WHEN metadata_issue THEN json_object('kind','metadata-read-failed','relative',relative) ELSE NULL END issue_json FROM rejected
      UNION ALL SELECT root_id,directory,json_extract(payload,'$.revision'),0,NOT json_extract(payload,'$.alreadySplit'),0,json_object('kind','cue','relative',json_extract(payload,'$.relative'),'status',json_extract(payload,'$.status')) FROM cue_fallback),
    directory_events AS(SELECT f.root_id,f.directory,CASE WHEN d.n=1 AND d.has_edition=0 THEN d.only_key ELSE mb_album_key(f.root_id,NULL,f.directory,'','[]') END album_key,f.revision,f.metadata_issue,f.cue_unsplit,f.name_failed,f.issue_json FROM fallback_events f LEFT JOIN directories d ON d.root_id=f.root_id AND d.directory=f.directory),
    names AS(SELECT json_extract(value,'$.rootId') root_id,${eventDirectory("json_extract(value,'$.rootId')","json_extract(value,'$.directory')")} directory,json_extract(value,'$.revision') revision FROM json_each(@names) WHERE json_extract(value,'$.state')='failed' AND mb_album_root(json_extract(value,'$.rootId'))=1
      AND (@root IS NULL OR json_extract(value,'$.rootId')=@root) AND (@hintDirectory IS NULL OR json_extract(value,'$.directory')=@hintDirectory)),
    name_events AS(SELECT DISTINCT n.root_id,n.directory,m.album_key,n.revision,0 metadata_issue,0 cue_unsplit,1 name_failed,json_object('kind','name-enhancement-failed','revision',n.revision) issue_json FROM names n JOIN members m ON m.root_id=n.root_id AND m.directory=n.directory
      UNION ALL SELECT n.root_id,n.directory,mb_album_key(n.root_id,NULL,n.directory,'','[]'),n.revision,0,0,1,json_object('kind','name-enhancement-failed','revision',n.revision) FROM names n WHERE NOT EXISTS(SELECT 1 FROM members m WHERE m.root_id=n.root_id AND m.directory=n.directory)),
    events AS(SELECT * FROM directory_events UNION ALL SELECT root_id,directory,album_key,json_extract(payload,'$.revision'),0,NOT json_extract(payload,'$.alreadySplit'),0,json_object('kind','cue','relative',json_extract(payload,'$.relative'),'status',json_extract(payload,'$.status')) FROM cue_members UNION ALL SELECT * FROM name_events),
    seeds AS(SELECT album_key,root_id,edition_id,CASE WHEN edition_id IS NULL THEN directory ELSE NULL END directory,mb_album_trim(raw_album) raw_album FROM members UNION ALL SELECT album_key,root_id,NULL,directory,'' FROM events),
    identities AS(SELECT album_key,root_id,max(edition_id) edition_id,CASE WHEN max(edition_id) IS NOT NULL THEN NULL ELSE min(directory) END directory,max(raw_album) raw_album FROM seeds GROUP BY album_key),
    member_summary AS(SELECT album_key,count(*) track_count,count(DISTINCT id) distinct_tracks,mb_album_artists(effective_artist ORDER BY sequence) artists,mb_album_consensus(effective_album) album_title,mb_album_consensus(effective_year) year,mb_album_versions(versions ORDER BY sequence) version_label,max(has_artwork) has_artwork,max(track_named_audio) track_named_audio,min(lyrics_presence) lyrics_presence,
      min(CASE WHEN sequence=1 THEN id END) representative_track_id,mb_album_hash(member_digest ORDER BY sequence) fingerprint FROM members GROUP BY album_key),
    event_summary AS(SELECT album_key,max(metadata_issue) metadata_issue,max(cue_unsplit) cue_unsplit,max(name_failed) name_failed,mb_album_hash(json_array(directory,revision,metadata_issue,cue_unsplit,name_failed) ORDER BY directory,revision) fingerprint FROM events GROUP BY album_key),
    group_facts AS MATERIALIZED(SELECT i.*,coalesce(m.track_count,0) track_count,coalesce(m.distinct_tracks,0) distinct_tracks,CASE WHEN i.edition_id IS NULL AND mb_album_organization(i.root_id) IN ('artist','album') AND coalesce(m.artists,'[]')='[]' AND mb_album_artist_fallback(i.root_id)<>'' THEN json_array(mb_album_artist_fallback(i.root_id)) ELSE coalesce(m.artists,'[]') END artists,
      CASE WHEN i.edition_id IS NOT NULL THEN json_extract(ed.data,'$.title') WHEN mb_album_organization(i.root_id)='album' THEN coalesce(m.album_title,nullif(mb_album_root_name(i.root_id),''),'来源目录') WHEN i.directory='' THEN CASE WHEN coalesce(m.track_count,0)>0 THEN '散落音频' ELSE '根目录待处理记录' END ELSE coalesce(m.album_title,CASE WHEN mb_album_organization(i.root_id)='artist' THEN NULL ELSE nullif(i.raw_album,'') END,nullif(mb_album_basename(i.directory),''),'来源目录') END title,m.year,
      coalesce(nullif(json_extract(ed.data,'$.edition'),''),m.version_label) version_label,
      coalesce(m.has_artwork,0) source_has_artwork,coalesce(e.metadata_issue,0) metadata_issue,coalesce(e.cue_unsplit,0) cue_unsplit,coalesce(e.name_failed,0) name_failed,
      mb_album_digest(json_array(i.album_key,i.root_id,mb_album_root_view(i.root_id),json(ed.data),m.fingerprint,e.fingerprint,mb_album_organization_revision(i.root_id))) artwork_source_revision,
      i.directory='' AND coalesce(m.track_count,0)>0 AND coalesce(mb_album_organization(i.root_id),'')<>'album' loose_audio,coalesce(m.track_named_audio,0) track_named_audio,
      CASE WHEN mb_album_online(i.root_id)=1 THEN coalesce(m.lyrics_presence,0) ELSE 0 END lyrics_presence,
      mb_album_online(i.root_id)=1 AND coalesce(m.track_count,0)>0 AND m.lyrics_presence=1 missing_lyrics,
      m.representative_track_id,${membershipSql} membership_digest,
      mb_album_digest(CASE WHEN mb_album_organization_revision(i.root_id) IS NULL THEN json_array(mb_album_root_view(i.root_id),json(ed.data),m.fingerprint,e.fingerprint,m.lyrics_presence,@lyricsRevision) ELSE json_array(mb_album_root_view(i.root_id),json(ed.data),m.fingerprint,e.fingerprint,m.lyrics_presence,@lyricsRevision,mb_album_organization_revision(i.root_id)) END) revision,
      mb_album_root_label(i.root_id) source_label,mb_album_online(i.root_id) online FROM identities i LEFT JOIN local_catalog_editions ed ON ed.id=i.edition_id LEFT JOIN member_summary m ON m.album_key=i.album_key LEFT JOIN event_summary e ON e.album_key=i.album_key)
  `
  const artworkOverlay = (base: string, where = '1'): string => `artwork_observations AS(SELECT json_extract(value,'$.albumKey') album_key,json_extract(value,'$.rootId') root_id,json_extract(value,'$.state') state FROM json_each(@artwork)),
    artwork_states AS MATERIALIZED(SELECT b.*,coalesce(mb_album_artwork_state(b.album_key,b.root_id,b.edition_id,b.representative_track_id,b.membership_digest),o.state) current_artwork_state FROM ${base} b
      LEFT JOIN artwork_observations o ON o.album_key=b.album_key AND o.root_id=b.root_id AND b.online=1 WHERE ${where}),
    groups AS MATERIALIZED(SELECT s.*,CASE WHEN current_artwork_state='missing' THEN 0 WHEN current_artwork_state='available' THEN 1 ELSE source_has_artwork END has_artwork,
      online=1 AND coalesce(current_artwork_state='missing',0) missing_artwork FROM artwork_states s)`
  const sql = `${factsSql},${artworkOverlay('group_facts')}`
  const bindings = { sourceRaw: source.sourceRaw ?? '[]', root: null as string | null, hintDirectory: null as string | null,
    hintPrefix: null as string | null, hintUpper: null as string | null, cuePayloads: null as string | null,
    names: JSON.stringify(names), artwork: JSON.stringify(observations), lyricsRevision: scope.lyricsInventory?.revision() ?? null }
  const coverageRoot = (rootId: string | null): string | null => rootId ?? (roots.size === 1 ? roots.keys().next().value! : null)
  const rootBindings = (rootId: string | null) => ({ ...bindings, root: coverageRoot(rootId) })
  // 原sourceLookup替换后不再需要sourceRaw参数；此处只有可信作者组装的固定参数集合。
  function statement(text: string) {
    const saved = statements.get(text)
    if (saved) { statements.delete(text); statements.set(text, saved); return saved }
    const value = db.prepare(text); value.setAllowUnknownNamedParameters(true)
    const bytes = Buffer.byteLength(text)
    while (statements.size && (statements.size >= 32 || statementBytes + bytes > 1024 * 1024)) {
      const oldest = statements.keys().next().value!; statementBytes -= Buffer.byteLength(oldest); statements.delete(oldest)
    }
    if (bytes <= 1024 * 1024) { statements.set(text, value); statementBytes += bytes }
    return value
  }
  // scope.revision由原Owner组合Source/catalog/scan/作者修订；全部roots/私有观测仍逐次完整绑定。
  const scopeFingerprint = (): string => {
    const original=[scope.revision,scope.roots,names,observations,source.projectionSql,source.sourceRaw??null,!!source.sourceLookup,
      ...(scope.artworkInventory ? [scope.artworkInventory.revision()] : [])]
    return hash(organizationFacts.length?[...original,organizationFacts]:original)
  }
  const initialScope = scopeFingerprint()
  let lastStructureBarrier = '', lastScanBase = ''
  let lastScanPoint: LocalAlbumScanPoint | undefined
  function readBarrier(): string {
    assertReadActive()
    const installed = installedAuthors.get(db)
    if (scopeFingerprint() !== initialScope || !sameAuthor(initialAuthor, readAuthor()) || !installed
      || installed.scope !== initialScope || !sameAuthor(installed.author, initialAuthor)
      || installed.inventory !== scope.lyricsInventory || installed.artworkInventory !== scope.artworkInventory) return changed()
    const lyricsRevision = scope.lyricsInventory?.revision() ?? null
    if (lyricsRevision !== null && !opaque(lyricsRevision)) return unavailable()
    bindings.lyricsRevision = lyricsRevision
    const changes = statement('SELECT total_changes() changes').get()?.changes
    const dataVersion = statement('PRAGMA data_version').get()?.data_version
    const schemaVersion = statement('PRAGMA schema_version').get()?.schema_version
    if (![changes, dataVersion, schemaVersion].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) return unavailable()
    lastObservationPoint = observationPoint({changes:Number(changes),version:Number(dataVersion),schema:Number(schemaVersion),transaction:db.isTransaction})
    const observationAuthorCurrent = currentObservationHistory(db,source.observationHistory,lastObservationPoint) !== undefined
    // 结构不依赖资源库存/临时读图观测；主库全部物理水位、Source、根、组织、名称和歌词仍完整绑定。
    lastStructureBarrier = hash([scope.revision, scope.roots, names, organizationFacts, source.projectionSql, source.sourceRaw ?? null,
      lyricsRevision, changes, dataVersion, schemaVersion, db.isTransaction,observationAuthorCurrent])
    lastScanBase = hash([scope.roots,names,organizationFacts,source.projectionSql,source.sourceRaw ?? null,lyricsRevision,observationAuthorCurrent])
    // 隔离只读事务只消费原Owner队列证明；普通写事务仍不能发布或借用跨帧路径。
    const readonlyActor = localAlbumScanScopeOrigin(scope)?.readonlyActor === true && statement('PRAGMA query_only').get()?.query_only === 1
    lastScanPoint = db.isTransaction && !readonlyActor ? undefined : {changes:Number(changes),version:Number(dataVersion),schema:Number(schemaVersion)}
    return hash([initialScope, lyricsRevision, changes, dataVersion, schemaVersion, db.isTransaction,observationAuthorCurrent])
  }
  // 精确页与一个完整有序键索引共用原4MiB；索引仅含纯输出，不保存权限、FD或图片。
  const QUERY_PAGE_MAX_BYTES = 4 * 1024 * 1024
  interface QueryIndex { key: string; keys: readonly string[]; counts: string; total: number; bytes: number; structureBarrier?: string }
  const queryPages = new Map<string, string>()
  let queryIndex: QueryIndex | undefined, operationQueryIndex: QueryIndex | undefined
  let queryPageBytes = 0, queryPageBarrier = ''
  const queryBytes = (): number => queryPageBytes + (queryIndex?.bytes ?? 0)
  let queryPageLyricsInventory = scope.lyricsInventory, queryPageArtworkInventory = scope.artworkInventory
  function evictQueryPage(): number {
    const oldest = queryPages.keys().next().value!, value = queryPages.get(oldest)!
    const bytes = Buffer.byteLength(oldest) + Buffer.byteLength(value)
    queryPages.delete(oldest); queryPageBytes -= bytes; return bytes
  }
  function clearQueryPages(code: 'READ_BARRIER_CHANGED' | 'READ_BARRIER_FAILED' | 'READ_FAILED', preserveStructureIndex = false): void {
    if (!queryPages.size && !queryIndex) return
    const started = performance.now(), count = queryPages.size, bytes = queryBytes()
    queryPages.clear(); queryPageBytes = 0; if (!preserveStructureIndex) queryIndex = undefined
    logLibraryOperation('cache', 'albums.query-page.evict', 'complete', { code, count, bytes, elapsedMs: performance.now() - started })
  }
  function retainQueryPage(key: string, result: dto.LocalAlbumPage): void {
    assertReadActive()
    const started = performance.now(), raw = JSON.stringify(result), bytes = Buffer.byteLength(key) + Buffer.byteLength(raw)
    const reserved = operationQueryIndex?.bytes ?? queryIndex?.bytes ?? 0
    let removed = 0, removedBytes = 0
    while (queryPages.size && (queryPages.size >= 8 || queryPageBytes + reserved + bytes > QUERY_PAGE_MAX_BYTES)) {
      removedBytes += evictQueryPage(); removed++
    }
    if (reserved + bytes <= QUERY_PAGE_MAX_BYTES) { queryPages.set(key, raw); queryPageBytes += bytes }
    if (removed) logLibraryOperation('cache', 'albums.query-page.evict', 'complete', { code: 'CAPACITY', count: removed, bytes: removedBytes, elapsedMs: performance.now() - started })
  }
  function retainQueryIndex(value: QueryIndex): void {
    assertReadActive()
    while (queryPages.size && queryPageBytes + value.bytes > QUERY_PAGE_MAX_BYTES) evictQueryPage()
    queryIndex = value
  }
  let operationBarrier = '', operationStructureBarrier = '', operationScanBase = ''
  let operationScanPoint: LocalAlbumScanPoint | undefined
  let operationMembership: ReturnType<typeof createLocalAlbumArtworkMembershipIssuer> | undefined
  let operationCompact: CompactEntry | undefined, operationCue: CueEntry | undefined
  function scanCacheOrigin(): ScanCacheOrigin | undefined {
    const origin=localAlbumScanScopeOrigin(scope)
    return origin&&operationScanPoint ? {origin,point:operationScanPoint,base:operationScanBase}:undefined
  }
  function run<T>(action: () => T): T {
    noteSqlTiming('sql.run.enter', 'begin')
    let failureCode: 'READ_BARRIER_CHANGED' | 'READ_BARRIER_FAILED' | 'READ_FAILED' = 'READ_BARRIER_FAILED'
    try {
      operationBarrier = readBarrier()
      operationObservationPoint = lastObservationPoint
      failureCode = 'READ_FAILED'
      operationStructureBarrier = lastStructureBarrier
      operationScanBase=lastScanBase;operationScanPoint=lastScanPoint
      if (operationScanPoint && scope.artworkInventory?.readPersistedProjected) operationMembership = createLocalAlbumArtworkMembershipIssuer(db, operationScanPoint, scope.artworkInventory)
      if (queryPageBarrier !== operationBarrier || queryPageLyricsInventory !== scope.lyricsInventory || queryPageArtworkInventory !== scope.artworkInventory) {
        clearQueryPages('READ_BARRIER_CHANGED', queryIndex?.structureBarrier === operationStructureBarrier); queryPageBarrier = operationBarrier
        queryPageLyricsInventory = scope.lyricsInventory; queryPageArtworkInventory = scope.artworkInventory
      }
      const saved = derivedSnapshots.get(db)
      if (saved && (saved.barrier !== operationBarrier || !sameAuthor(saved.author, initialAuthor) || saved.inventory !== scope.lyricsInventory || saved.artworkInventory !== scope.artworkInventory)) derivedSnapshots.delete(db)
      const compact = compactSnapshots.get(db)
      if (compact && (compact.barrier !== operationStructureBarrier || !sameAuthor(compact.author, initialAuthor) || compact.inventory !== scope.lyricsInventory || compact.artworkInventory !== scope.artworkInventory)) {
        // 只输出闭集失效原因与物理计数；不记录根、路径、标签或作者内容。
        const physical = { ...(compact.scan ? { count: compact.scan.point.changes } : {}),
          ...(operationScanPoint ? { total: operationScanPoint.changes } : {}) }
        if (compact.barrier !== operationStructureBarrier) logLibraryOperation('cache','albums.compact-invalidate','skipped',{code:'STRUCTURE_CHANGED',...physical})
        if (!sameAuthor(compact.author,initialAuthor)) logLibraryOperation('cache','albums.compact-invalidate','skipped',{code:'AUTHOR_CHANGED',...physical})
        if (compact.inventory !== scope.lyricsInventory) logLibraryOperation('cache','albums.compact-invalidate','skipped',{code:'LYRICS_INVENTORY_CHANGED',...physical})
        if (compact.artworkInventory !== scope.artworkInventory) logLibraryOperation('cache','albums.compact-invalidate','skipped',{code:'ARTWORK_INVENTORY_CHANGED',...physical})
        if(!advanceScanCompact(compact)) {
          logLibraryOperation('cache','albums.compact-invalidate','complete',{code:'FULL_REBUILD_REQUIRED',...physical})
          compactSnapshots.delete(db)
        }
      }
      const cue = cueSnapshots.get(db)
      if (cue && (cue.barrier !== operationStructureBarrier || !sameAuthor(cue.author, initialAuthor))) cueSnapshots.delete(db)
      const result = action()
      failureCode = 'READ_BARRIER_FAILED'
      if (readBarrier() !== operationBarrier) { failureCode = 'READ_BARRIER_CHANGED'; return changed() }
      assertReadActive()
      // 脏目录重建只在本次读取内可见；完整末屏障成功后一次发布，失败不留下半成品。
      if (operationCompact) compactSnapshots.set(db, operationCompact)
      if (operationCue) cueSnapshots.set(db, operationCue)
      if (operationQueryIndex) retainQueryIndex(operationQueryIndex)
      return result
    } catch (error) {
      let failure = error, retain = false
      const rejectedClaim = error instanceof LocalAlbumReadError && artworkClaimMismatches.delete(error)
      if (rejectedClaim && operationBarrier) {
        // 请求修订不匹配本身不是信任证明；拒绝路径也必须重新通过真实完整末屏障。
        try {
          if (readBarrier() === operationBarrier) {
            assertReadActive()
            if (operationCompact) compactSnapshots.set(db, operationCompact)
            if (operationCue) cueSnapshots.set(db, operationCue)
            retain = true
          } else failureCode = 'READ_BARRIER_CHANGED'
        } catch (barrierError) { failure = barrierError; failureCode = 'READ_BARRIER_FAILED' }
      }
      if (retain) logLibraryOperation('cache', 'albums.read-cache', 'hit', { code: 'ARTWORK_CLAIM_STALE' })
      else {
        clearQueryPages(failureCode)
        derivedSnapshots.delete(db); compactSnapshots.delete(db); cueSnapshots.delete(db); currentReaders.delete(db)
        statements.clear(); statementBytes = 0
        logLibraryOperation('cache', 'albums.read-cache.evict', 'complete', { code: failureCode })
      }
      if (failure instanceof LocalAlbumReadError) throw failure
      return unavailable()
    }
    finally { operationMembership?.close(); operationMembership=undefined; aggregates.clear(); smallCache.clear(); smallBytes = 0; operationBarrier = ''; operationStructureBarrier = ''; lastStructureBarrier = ''; operationScanBase='';lastScanBase='';operationScanPoint=undefined;lastScanPoint=undefined;operationCompact=undefined;operationCue=undefined;operationQueryIndex=undefined }
  }
  function structureAlbum(row: Record<string, unknown>): MobileStructureAlbum {
    const value: MobileStructureAlbum = { id: String(row.album_key), rootId: String(row.root_id),
      editionId: row.edition_id === null ? null : String(row.edition_id), title: dto.isLocalCatalogText(row.title) ? row.title : '来源目录',
      artists: JSON.parse(String(row.artists)), versionLabel: row.version_label === null ? null : String(row.version_label),
      trackCount: Number(row.track_count), representativeTrackId: row.representative_track_id === null ? null : String(row.representative_track_id) }
    if (Number(row.track_count) !== Number(row.distinct_tracks) || !dto.isCollectionId(value.rootId)
      || value.editionId !== null && !dto.isCollectionId(value.editionId) || !Array.isArray(value.artists)
      || value.artists.some(item => !dto.isLocalCatalogText(item)) || !Number.isSafeInteger(value.trackCount) || value.trackCount < 0
      || value.representativeTrackId !== null && !dto.isCollectionId(value.representativeTrackId)) return unavailable()
    return value
  }
  function summary(row: Record<string, unknown>): dto.LocalAlbumSummary {
    if (Number(row.track_count) !== Number(row.distinct_tracks)) return unavailable()
    const available = Number(row.has_artwork) === 1, artworkState = available ? 'available' : Number(row.online) !== 1 ? 'source-unavailable' : Number(row.missing_artwork) === 1 ? 'missing' : 'unknown'
    const value: dto.LocalAlbumSummary = { id: String(row.album_key), kind: row.edition_id === null ? 'source-directory' : 'edition', rootId: String(row.root_id), editionId: row.edition_id === null ? null : String(row.edition_id), title: dto.isLocalCatalogText(row.title) ? row.title : '来源目录', artists: JSON.parse(String(row.artists)), year: row.year === null ? null : String(row.year), versionLabel: row.version_label === null ? null : String(row.version_label), sourceLabel: dto.isLocalCatalogText(row.source_label) ? row.source_label : '本地来源', trackCount: Number(row.track_count), representativeTrackId: row.representative_track_id === null ? null : String(row.representative_track_id), revision: String(row.revision), artworkAvailable: available, artworkState,
      lyricsPresence: Number(row.lyrics_presence) === 2 ? 'true' : Number(row.lyrics_presence) === 1 ? 'false' : 'unknown',
      statuses: statuses.filter((_, index) => Number(row[statusColumns[index]!]) === 1) }
    if (!dto.isLocalAlbumSummary(value)) return unavailable(); return value
  }
  install('mb_album_page_item', raw => JSON.stringify(summary(JSON.parse(String(raw)) as Record<string, unknown>)))
  const publicSummaryColumns = ['album_key','edition_id','root_id','title','artists','year','version_label','source_label','track_count','distinct_tracks','representative_track_id','revision','online','lyrics_presence',...statusColumns]
  const pageFactJoins = `JOIN source_metadata m ON m.id=p.id JOIN local_catalog_tracks t ON t.id=p.id JOIN local_catalog_assets a ON a.id=t.asset_id LEFT JOIN local_catalog_edition_tracks l ON l.id=p.relation_id ${selection}`
  const memberIndexColumns = ['id','asset_record_id','root_id','album_key','relation_id','directory','disc','track_number','sequence','cue_member','has_artwork',...(organized ? ['name_failed_member'] : [])]
  const cueMember = `EXISTS(SELECT 1 FROM cue_members c JOIN json_each(c.payload,'$.audioAssetIds') a WHERE c.album_key=p.album_key AND a.value=p.asset_record_id AND NOT json_extract(c.payload,'$.alreadySplit'))
    OR EXISTS(SELECT 1 FROM cue_fallback c LEFT JOIN directories d ON d.root_id=c.root_id AND d.directory=c.directory WHERE json_array_length(c.payload,'$.audioAssetIds')=0 AND NOT json_extract(c.payload,'$.alreadySplit')
      AND CASE WHEN d.n=1 AND d.has_edition=0 THEN d.only_key ELSE mb_album_key(c.root_id,NULL,c.directory,'','[]') END=p.album_key)`
  const issuesCte = `issues AS(SELECT p.album_key,p.root_id,0 category,p.sequence ordinal,json_object('kind','missing-metadata','trackId',p.id,'fields',json(mb_album_missing(m.raw_title,m.raw_artist,m.raw_album))) issue_json
    FROM members p JOIN source_metadata m ON m.id=p.id WHERE json_array_length(mb_album_missing(m.raw_title,m.raw_artist,m.raw_album))>0 UNION ALL SELECT album_key,root_id,1,0,issue_json FROM events WHERE issue_json IS NOT NULL)`
  const rejectedCte = `rejected_files AS(SELECT r.*,CASE WHEN d.n=1 AND d.has_edition=0 THEN d.only_key ELSE mb_album_key(r.root_id,NULL,r.directory,'','[]') END album_key FROM rejected r LEFT JOIN directories d ON d.root_id=r.root_id AND d.directory=r.directory)`
  // 单页/单图只复用同屏障已完成的全组索引；冷读和整件弃缓存均走原目标SQL。
  function cachedDerived(): DerivedSnapshot | null {
    const previous = derivedSnapshots.get(db)
    return previous?.barrier === operationBarrier && sameAuthor(previous.author, initialAuthor) && previous.inventory === scope.lyricsInventory && previous.artworkInventory === scope.artworkInventory ? previous.snapshot : null
  }
  function derived(): DerivedSnapshot | null {
    const previous = derivedSnapshots.get(db)
    if (previous?.barrier === operationBarrier && sameAuthor(previous.author, initialAuthor) && previous.inventory === scope.lyricsInventory && previous.artworkInventory === scope.artworkInventory) return previous.snapshot
    noteSqlTiming('sql.derived', 'begin')
    const value: DerivedSnapshot = { groups: new Map(), members: new Map(), issues: new Map(), rejected: new Map() }
    const counts = { group: 0, member: 0, issue: 0, rejected: 0 }; let bytes = 0, allocation = 0
    // 一个完整CTE共享真实分组/成员/事件。只索引ID和排序，不将完整track/asset/标签复制到内存。
    const text = `${sql}, ${issuesCte}, ${rejectedCte}, indexed_members AS(SELECT p.*,(${cueMember}) cue_member${organized ? ',EXISTS(SELECT 1 FROM names n WHERE n.root_id=p.root_id AND n.directory=p.directory) name_failed_member' : ''} FROM members p)
      SELECT 'group' kind,json_object(${[...publicSummaryColumns,'directory','artwork_source_revision'].map(column=>`'${column}',${column}`).join(',')}) payload FROM groups
      UNION ALL SELECT 'member',json_object(${memberIndexColumns.map(column=>`'${column}',${column}`).join(',')}) FROM indexed_members
      UNION ALL SELECT 'issue',json_object('album_key',album_key,'root_id',root_id,'category',category,'ordinal',ordinal,'issue_json',issue_json) FROM issues
      UNION ALL SELECT 'rejected',json_object('album_key',album_key,'root_id',root_id,'relative',relative,'revision',revision) FROM rejected_files /* mb_album_derived_snapshot */`
    let complete = true
    for (const row of statement(text).iterate(bindings)) {
      assertReadActive()
      if (!['group','member','issue','rejected'].includes(String(row.kind)) || typeof row.payload !== 'string') return unavailable()
      const kind = row.kind as keyof typeof counts, length = Buffer.byteLength(row.payload)
      // 超界只放弃整件缓存。后续原SQL仍返回完整页/全部counts，不拿缓存前缀冒充全集。
      bytes += length; allocation += length * 4 + 512
      if (++counts[kind] > LOCAL_ALBUM_SQL_DERIVED_MAX_ITEMS || bytes > LOCAL_ALBUM_SQL_DERIVED_MAX_BYTES || allocation > LOCAL_ALBUM_SQL_DERIVED_ALLOCATION_BYTES) { complete = false; break }
      const item: unknown = JSON.parse(row.payload)
      if (!item || typeof item !== 'object' || Array.isArray(item)) return unavailable()
      const raw = item as Record<string, unknown>
      if (!opaque(raw.album_key) || typeof raw.root_id !== 'string' || !roots.has(raw.root_id)) return unavailable()
      const key = groupIdentity(raw.root_id, raw.album_key)
      if (kind === 'group') {
        summary(raw)
        if (value.groups.has(key) || raw.directory !== null && !isLocalAlbumPrivateRelative(raw.directory, true)) return unavailable()
        value.groups.set(key, row.payload)
      } else {
        const target = kind === 'member' ? value.members : kind === 'issue' ? value.issues : value.rejected
        const ordinal = kind === 'member' ? Number(raw.sequence) : kind === 'issue' ? Number(raw.ordinal) : 0
        const category = kind === 'issue' ? Number(raw.category) : 0
        if (kind === 'member' && raw.has_artwork !== 0 && raw.has_artwork !== 1) return unavailable()
        if (!Number.isSafeInteger(ordinal) || ordinal < (kind === 'member' ? 1 : 0) || !Number.isSafeInteger(category) || category < 0) return unavailable()
        const tie = kind === 'issue' ? raw.issue_json : kind === 'rejected' ? raw.relative : ''
        if (typeof tie !== 'string') return unavailable()
        const list = target.get(key) ?? []; list.push({ ordinal, category, tie, raw: row.payload }); target.set(key, list)
      }
    }
    if (readBarrier() !== operationBarrier) return changed()
    if (complete) {
      for (const [key, group] of value.groups) {
        const members = value.members.get(key) ?? []
        if (members.length !== Number((JSON.parse(group) as Record<string, unknown>).track_count)) return unavailable()
        members.sort((a,b)=>a.ordinal-b.ordinal)
        if (members.some((member,index)=>member.ordinal !== index+1)) return unavailable()
      }
      for (const [key] of value.members) if (!value.groups.has(key)) return unavailable()
      for (const list of value.issues.values()) list.sort((a,b)=>a.category-b.category || a.ordinal-b.ordinal || binaryCompare(a.tie,b.tie))
      for (const list of value.rejected.values()) list.sort((a,b)=>binaryCompare(a.tie,b.tie))
    }
    const snapshot = complete ? value : null
    assertReadActive()
    derivedSnapshots.set(db, { barrier: operationBarrier, author: initialAuthor, inventory: scope.lyricsInventory, artworkInventory: scope.artworkInventory, snapshot })
    noteSqlTiming('sql.derived', 'ok')
    return snapshot
  }
  function cueEntry(rootId: string | null): CueEntry | undefined {
    const previous = operationCue ?? cueSnapshots.get(db), selectedRoot = coverageRoot(rootId)
    if (!previous || previous.barrier !== operationStructureBarrier || !sameAuthor(previous.author, initialAuthor)) return undefined
    return previous.rootId === selectedRoot || previous.rootId === null && previous.snapshot !== null ? previous : undefined
  }
  function currentCues(rootId: string | null): CueSnapshot | null {
    const previous = cueEntry(rootId)
    if (previous) return previous.snapshot
    const started = performance.now(), value: CueSnapshot = { payloads: new Map(), rootRows: new Map(), directories: new Map(), unsafe: new Set(), unknownRoots: new Set(), bytes: 0 }
    let complete = true, allocation = 0
    for (const row of statement(cueRows).iterate(rootBindings(rootId))) {
      assertReadActive()
      const rowId = Number(row.cue_rowid)
      if (!Number.isSafeInteger(rowId) || rowId <= 0 || typeof row.data !== 'string') return unavailable()
      const cue = decodeCue(row.data)
      if (cue.rootId !== row.library_root_id || !roots.has(cue.rootId) || typeof row.relative !== 'string' || parent(row.relative) !== cue.directory) return unavailable()
      const size = Buffer.byteLength(cue.payload) + 8
      value.bytes += size; allocation += size * 4 + 512
      if (value.payloads.size >= CUE_MAX_ITEMS || value.bytes > CUE_MAX_BYTES || allocation > CUE_MAX_ALLOCATION) { complete = false; break }
      value.payloads.set(rowId, cue.payload)
      if (!value.rootRows.has(cue.rootId)) { const bytes = Buffer.byteLength(cue.rootId); value.bytes += bytes; allocation += bytes * 4 + 256 }
      const rootRows = value.rootRows.get(cue.rootId) ?? []; rootRows.push(rowId); value.rootRows.set(cue.rootId, rootRows)
      value.bytes += 8; allocation += 16
      if (cue.unknown && !value.unknownRoots.has(cue.rootId)) { value.unknownRoots.add(cue.rootId); value.bytes += Buffer.byteLength(cue.rootId); allocation += 256 }
      const directories = new Set([cue.directory, ...cue.physical])
      for (const directory of directories) {
        const key = groupIdentity(cue.rootId, directory), list = value.directories.get(key) ?? []
        if (!value.directories.has(key)) { const bytes = Buffer.byteLength(key); value.bytes += bytes; allocation += bytes * 4 + 256 }
        list.push(rowId); value.directories.set(key, list); value.bytes += 8; allocation += 16
        if (directories.size > 1 && !value.unsafe.has(key)) { value.unsafe.add(key); const bytes = Buffer.byteLength(key); value.bytes += bytes; allocation += bytes * 4 + 128 }
      }
      if (value.directories.size > CUE_MAX_ITEMS || value.bytes > CUE_MAX_BYTES || allocation > CUE_MAX_ALLOCATION) { complete = false; break }
    }
    const snapshot = complete ? value : null
    assertReadActive()
    cueSnapshots.set(db, { barrier: operationStructureBarrier, author: initialAuthor, rootId: coverageRoot(rootId), snapshot })
    logLibraryOperation('cache', 'albums.cue-projection', complete ? 'miss' : 'skipped', { code: complete ? 'CUE_BUILT' : 'CAPACITY', count: value.payloads.size, bytes: value.bytes, elapsedMs: performance.now() - started })
    return snapshot
  }
  function packCues(snapshot: CueSnapshot, rootId: string | null, directory?: string): string {
    const ids = directory !== undefined ? snapshot.directories.get(groupIdentity(rootId!, directory)) ?? []
      : rootId === null ? [...snapshot.payloads.keys()] : snapshot.rootRows.get(rootId) ?? []
    return `[${ids.map(id => snapshot.payloads.get(id)!).join(',')}]`
  }
  function cueBindings(rootId: string | null) {
    const selectedRoot = coverageRoot(rootId), snapshot = currentCues(rootId)
    return { ...rootBindings(rootId), cuePayloads: snapshot ? packCues(snapshot, selectedRoot) : null }
  }
  const compactGroupColumns = [...publicSummaryColumns.filter(column => column !== 'has_artwork' && column !== 'missing_artwork'), 'directory', 'artwork_source_revision', 'source_has_artwork', 'membership_digest']
  function compactEntry(rootId: string | null): CompactEntry | undefined {
    const previous = operationCompact ?? compactSnapshots.get(db), selectedRoot = coverageRoot(rootId)
    if (!previous || previous.barrier !== operationStructureBarrier || !sameAuthor(previous.author, initialAuthor) || previous.inventory !== scope.lyricsInventory || previous.artworkInventory !== scope.artworkInventory) return undefined
    // 全集可以回答其中一个根；单根结果不能冒充多根全集。超预算哨兵只适用于原覆盖范围。
    return previous.rootId === selectedRoot || previous.rootId === null && previous.snapshot !== null ? previous : undefined
  }
  function cachedCompact(rootId: string | null): CompactSnapshot | null { return compactEntry(rootId)?.snapshot ?? null }
  function compactGroupSql(): string {
    const index = ['id', 'asset_record_id', 'relation_id'].map(column => `'${column}',p.${column}`).join(',')
    return `${factsSql}, compact_choices AS MATERIALIZED(SELECT root_id,album_key,min(directory) physical_min,max(directory) physical_max,
      coalesce(min(sequence) FILTER(WHERE has_artwork=1),min(sequence)) selected_sequence FROM members GROUP BY root_id,album_key)
      SELECT json_object(${compactGroupColumns.map(column => `'${column}',g.${column}`).join(',')},
        'physical_directory',CASE WHEN g.edition_id IS NULL AND c.physical_min=c.physical_max THEN c.physical_min ELSE NULL END,
        'artwork_index',json(CASE WHEN p.id IS NULL THEN NULL ELSE json_object(${index}) END)) payload
      FROM group_facts g LEFT JOIN compact_choices c ON c.root_id=g.root_id AND c.album_key=g.album_key
      LEFT JOIN members p ON p.root_id=g.root_id AND p.album_key=g.album_key AND p.sequence=c.selected_sequence /* mb_album_compact_groups */`
  }
  function compactGroups(rootId: string | null): CompactSnapshot | null {
    const previous = compactEntry(rootId)
    if (previous) {
      logLibraryOperation('cache', 'albums.compact-groups', previous.snapshot ? 'hit' : 'skipped', { code: previous.snapshot ? 'COMPACT_HIT' : 'CAPACITY', count: previous.snapshot?.groups.size ?? 0, bytes: previous.snapshot?.bytes ?? 0 })
      return previous.snapshot
    }
    const started = performance.now(), value: CompactSnapshot = { groups: new Map(), bytes: 0 }
    const text = compactGroupSql()
    let complete = true, allocation = 0
    for (const row of statement(text).iterate(cueBindings(rootId))) {
      assertReadActive()
      if (typeof row.payload !== 'string') return unavailable()
      const bytes = Buffer.byteLength(row.payload)
      value.bytes += bytes; allocation += bytes * 4 + 512
      if (value.groups.size >= COMPACT_MAX_GROUPS || value.bytes > COMPACT_MAX_BYTES || allocation > COMPACT_MAX_ALLOCATION) { complete = false; break }
      const raw = JSON.parse(row.payload) as Record<string, unknown>, album = structureOnly ? structureAlbum(raw) : summary({ ...raw, has_artwork: raw.source_has_artwork, missing_artwork: 0 }), key = groupIdentity(album.rootId, album.id)
      const keyBytes = Buffer.byteLength(key); value.bytes += keyBytes; allocation += keyBytes * 2
      if (value.bytes > COMPACT_MAX_BYTES || allocation > COMPACT_MAX_ALLOCATION) { complete = false; break }
      if (!roots.has(album.rootId) || value.groups.has(key) || !opaque(raw.artwork_source_revision) || raw.membership_digest !== null && (typeof raw.membership_digest !== 'string' || !/^[a-f0-9]{64}$/u.test(raw.membership_digest))
        || raw.directory !== null && !isLocalAlbumPrivateRelative(raw.directory, true)
        || raw.physical_directory !== null && !isLocalAlbumPrivateRelative(raw.physical_directory, true)
        || (raw.artwork_index === null) !== (album.trackCount === 0)) return unavailable()
      value.groups.set(key, row.payload)
    }
    const snapshot = complete ? value : null
    const scan = scanCacheOrigin()
    assertReadActive()
    compactSnapshots.set(db, { barrier: operationStructureBarrier, author: initialAuthor, inventory: scope.lyricsInventory, artworkInventory: scope.artworkInventory, rootId: coverageRoot(rootId), snapshot, ...(scan ? { scan } : {}) })
    logLibraryOperation('cache', 'albums.compact-groups', complete ? 'miss' : 'skipped', { code: complete ? 'COMPACT_BUILT' : 'CAPACITY', count: value.groups.size, bytes: value.bytes, elapsedMs: performance.now() - started })
    return snapshot
  }
  function scanCueProjection(previous: CueSnapshot, path: LocalAlbumScanPath): CueSnapshot | null {
    const selected=new Map<string,{rootId:string;relative:string}>()
    for(const item of path.directories){
      const key=groupIdentity(item.rootId,item.directory)
      if(previous.unknownRoots.has(item.rootId)||previous.unsafe.has(key))return null
      for(const rowId of previous.directories.get(key)??[]){
        const payload=previous.payloads.get(rowId)
        if(!payload)return null
        const row=JSON.parse(payload) as {rootId:string;relative:string}
        selected.set(groupIdentity(row.rootId,row.relative),row)
        if(selected.size>512)return null
      }
    }
    for(const cue of path.cues)selected.set(groupIdentity(cue.rootId,cue.relative),cue)
    if(selected.size>512)return null
    if(!selected.size)return previous
    const value:CueSnapshot={payloads:new Map(previous.payloads),rootRows:new Map([...previous.rootRows].map(([key,list])=>[key,[...list]])),
      directories:new Map([...previous.directories].map(([key,list])=>[key,[...list]])),unsafe:new Set(previous.unsafe),unknownRoots:new Set(previous.unknownRoots),bytes:0}
    for(const selectedCue of selected.values()){
      assertReadActive()
      const directory=parent(selectedCue.relative),key=groupIdentity(selectedCue.rootId,directory)
      if(previous.unsafe.has(key)||previous.unknownRoots.has(selectedCue.rootId))return null
      const row=statement('SELECT rowid cue_rowid,library_root_id,relative,data FROM local_cue_sources WHERE library_root_id=? AND relative=? ORDER BY rowid DESC LIMIT 1').get(selectedCue.rootId,selectedCue.relative)
      if(!row||typeof row.data!=='string'||!Number.isSafeInteger(row.cue_rowid)||Number(row.cue_rowid)<=0)return null
      const cue=decodeCue(row.data),rowId=Number(row.cue_rowid)
      // 新CUE可更新本目录；任何跨目录或尚未核实的引用仍走原root全集，不按sidecar早裁。
      if(cue.rootId!==selectedCue.rootId||cue.directory!==directory||cue.unknown||[...cue.physical].some(value=>value!==directory))return null
      for(const oldId of [...(value.directories.get(key)??[])]){
        const raw=value.payloads.get(oldId)
        if(!raw||JSON.parse(raw).relative!==selectedCue.relative)continue
        value.payloads.delete(oldId)
        const roots=(value.rootRows.get(cue.rootId)??[]).filter(id=>id!==oldId)
        if(roots.length)value.rootRows.set(cue.rootId,roots);else value.rootRows.delete(cue.rootId)
        const members=(value.directories.get(key)??[]).filter(id=>id!==oldId)
        if(members.length)value.directories.set(key,members);else value.directories.delete(key)
      }
      if(value.payloads.has(rowId))return null
      value.payloads.set(rowId,cue.payload)
      const rootRows=value.rootRows.get(cue.rootId)??[];rootRows.push(rowId);value.rootRows.set(cue.rootId,rootRows)
      const directoryRows=value.directories.get(key)??[];directoryRows.push(rowId);value.directories.set(key,directoryRows)
    }
    let allocation=0
    for(const payload of value.payloads.values()){assertReadActive();const bytes=Buffer.byteLength(payload)+8;value.bytes+=bytes;allocation+=bytes*4+512}
    for(const [key,list] of value.rootRows){assertReadActive();const bytes=Buffer.byteLength(key);value.bytes+=bytes+list.length*8;allocation+=bytes*4+256+list.length*16}
    for(const [key,list] of value.directories){assertReadActive();const bytes=Buffer.byteLength(key);value.bytes+=bytes+list.length*8;allocation+=bytes*4+256+list.length*16}
    for(const key of value.unsafe){assertReadActive();const bytes=Buffer.byteLength(key);value.bytes+=bytes;allocation+=bytes*4+128}
    for(const key of value.unknownRoots){assertReadActive();value.bytes+=Buffer.byteLength(key);allocation+=256}
    // 共享原字符串，但旧/新Map、数组及本次拼包的临时分配也计入原独立CUE预算。
    allocation+=(previous.payloads.size+previous.rootRows.size+previous.directories.size+previous.unsafe.size+previous.unknownRoots.size)*64
    return value.payloads.size<=CUE_MAX_ITEMS&&value.directories.size<=CUE_MAX_ITEMS&&value.bytes<=CUE_MAX_BYTES&&allocation<=CUE_MAX_ALLOCATION?value:null
  }
  function advanceScanCompact(previous: CompactEntry): boolean {
    const current=scanCacheOrigin(),old=previous.scan
    const reject=(code:'DELTA_CURRENT_ORIGIN_UNAVAILABLE'|'DELTA_PREVIOUS_ORIGIN_UNAVAILABLE'|'DELTA_OWNER_CHANGED'|'DELTA_STABLE_DEPENDENCY_CHANGED'|'DELTA_BASE_CHANGED'
      |'DELTA_AUTHOR_CHANGED'|'DELTA_LYRICS_INVENTORY_CHANGED'|'DELTA_ARTWORK_INVENTORY_CHANGED'|'DELTA_SCHEMA_CHANGED'|'DELTA_EXTERNAL_DATABASE_CHANGED'|'DELTA_CHANGE_RANGE_INVALID'|'DELTA_CHAIN_MISSING'):false=>{
      logLibraryOperation('cache','albums.compact-delta','skipped',{code,...(old?{count:old.point.changes}:{}),...(current?{total:current.point.changes}:{})})
      return false
    }
    if(!current)return reject('DELTA_CURRENT_ORIGIN_UNAVAILABLE')
    if(!old)return reject('DELTA_PREVIOUS_ORIGIN_UNAVAILABLE')
    if(current.origin.owner!==old.origin.owner)return reject('DELTA_OWNER_CHANGED')
    if(current.origin.stable!==old.origin.stable)return reject('DELTA_STABLE_DEPENDENCY_CHANGED')
    if(current.base!==old.base)return reject('DELTA_BASE_CHANGED')
    if(!sameAuthor(previous.author,initialAuthor))return reject('DELTA_AUTHOR_CHANGED')
    if(previous.inventory!==scope.lyricsInventory)return reject('DELTA_LYRICS_INVENTORY_CHANGED')
    if(previous.artworkInventory!==scope.artworkInventory)return reject('DELTA_ARTWORK_INVENTORY_CHANGED')
    const path=localAlbumScanPath(db,old.point,current.point)
    if(!path)return reject(old.point.schema!==current.point.schema?'DELTA_SCHEMA_CHANGED':old.point.version!==current.point.version?'DELTA_EXTERNAL_DATABASE_CHANGED'
      :old.point.changes>current.point.changes?'DELTA_CHANGE_RANGE_INVALID':'DELTA_CHAIN_MISSING')
    const started=performance.now(),oldCue=cueSnapshots.get(db)
    if(!path.directories.length&&!path.cues.length){
      assertReadActive()
      operationCompact={...previous,barrier:operationStructureBarrier,scan:current}
      if(oldCue?.barrier===previous.barrier&&sameAuthor(oldCue.author,initialAuthor))operationCue={...oldCue,barrier:operationStructureBarrier}
      logLibraryOperation('cache','albums.compact-groups','hit',{code:'COMPACT_SCAN_UNCHANGED',count:previous.snapshot?.groups.size??0,elapsedMs:performance.now()-started})
      return true
    }
    if(!previous.snapshot||!oldCue?.snapshot||oldCue.barrier!==previous.barrier||oldCue.rootId!==previous.rootId||!sameAuthor(oldCue.author,initialAuthor))return false
    const dirty=new Map<string,{rootId:string;directory:string}>(),rootIds=new Set<string>()
    for(const item of path.directories){
      const view=roots.get(item.rootId),role=organizations.get(item.rootId)?.role??null
      if(!view||view.root.sourceRootId!==item.sourceRootId||view.root.revision!==item.rootRevision
        ||role!==null&&role!=='catalog'||previous.rootId!==null&&previous.rootId!==item.rootId)return false
      dirty.set(groupIdentity(item.rootId,item.directory),item);rootIds.add(item.rootId)
    }
    // 扫描本身不编辑发行关系；任何现存发行或组织分组均保守回原root全集。
    for(const rootId of rootIds)if(statement(`SELECT 1 FROM local_catalog_edition_tracks l JOIN local_catalog_tracks t ON t.id=l.track_id
      JOIN local_catalog_assets a ON a.id=t.asset_id WHERE a.root_id=? AND json_extract(l.data,'$.active')=1 LIMIT 1`).get(rootId))return false
    const cue=scanCueProjection(oldCue.snapshot,path)
    if(!cue)return false
    const value:CompactSnapshot={groups:new Map(previous.snapshot.groups),bytes:0}
    // 这里只遍历有界卡片摘要；不解码全成员、不重新执行全root事实CTE。
    for(const [key,payload] of value.groups){
      assertReadActive()
      const row=JSON.parse(payload) as Record<string,unknown>
      if(rootIds.has(String(row.root_id))&&row.edition_id!==null)return false
      if(typeof row.directory==='string'&&dirty.has(groupIdentity(String(row.root_id),row.directory)))value.groups.delete(key)
    }
    for(const item of dirty.values()){
      assertReadActive()
      const text=directorySql(compactGroupSql(),item.directory).replace('/* mb_album_compact_groups */','/* mb_album_compact_delta */')
      for(const row of statement(text).iterate({...rootBindings(item.rootId),hintDirectory:item.directory,hintPrefix:`${item.directory}/`,hintUpper:`${item.directory}0`,cuePayloads:packCues(cue,item.rootId,item.directory)})){
        assertReadActive()
        if(typeof row.payload!=='string')return unavailable()
        const raw=JSON.parse(row.payload) as Record<string,unknown>,album=summary({...raw,has_artwork:raw.source_has_artwork,missing_artwork:0}),key=groupIdentity(album.rootId,album.id)
        if(album.rootId!==item.rootId||album.editionId!==null||raw.directory!==item.directory
          ||raw.physical_directory!==null&&raw.physical_directory!==item.directory||!opaque(raw.artwork_source_revision)
          ||(raw.artwork_index===null)!==(album.trackCount===0)||value.groups.has(key))return false
        value.groups.set(key,row.payload)
        if(value.groups.size>COMPACT_MAX_GROUPS)return false
      }
    }
    let allocation=previous.snapshot.groups.size*64
    for(const [key,payload] of value.groups){
      assertReadActive();const bytes=Buffer.byteLength(payload),keyBytes=Buffer.byteLength(key);value.bytes+=bytes+keyBytes;allocation+=bytes*4+512+keyBytes*2
      if(value.bytes>COMPACT_MAX_BYTES||allocation>COMPACT_MAX_ALLOCATION)return false}
    assertReadActive()
    operationCompact={...previous,barrier:operationStructureBarrier,snapshot:value,scan:current}
    operationCue={...oldCue,barrier:operationStructureBarrier,snapshot:cue}
    logLibraryOperation('cache','albums.compact-groups','miss',{code:'COMPACT_SCAN_DELTA',count:dirty.size,total:value.groups.size,bytes:value.bytes,elapsedMs:performance.now()-started})
    return true
  }
  function compactFactsSql(): string {
    return `WITH group_facts AS MATERIALIZED(SELECT ${compactGroupColumns.map(column => `json_extract(value,'$.${column}') ${column}`).join(',')} FROM json_each(@compactRows))`
  }
  function compactRowsSql(rows: readonly string[]): { sql: string; compactRows: string } {
    return { sql: `${compactFactsSql()},${artworkOverlay('group_facts')}`,
      compactRows: `[${rows.join(',')}]` }
  }
  function compactSql(snapshot: CompactSnapshot, albumKey?: string, rootId?: string): { sql: string; compactRows: string } {
    // 用同一SQLite函数保留原自然排序、搜索与counts语义，不另写一份JS分组算法。
    const rows = albumKey === undefined ? [...snapshot.groups.values()] : [snapshot.groups.get(groupIdentity(rootId!, albumKey))].filter((row): row is string => row !== undefined)
    return compactRowsSql(rows)
  }
  const rootPin = (rootId: string): string => JSON.stringify(roots.get(rootId) ?? null)
  const organizationPin = (rootId: string): string => JSON.stringify(organizations.get(rootId) ?? null)
  function retainDirectoryHints(snapshot: CompactSnapshot | null, page: dto.LocalAlbumPage): void {
    assertReadActive()
    if (!snapshot) return
    const saved = directoryHints.get(db) ?? { entries: new Map<string, DirectoryHint>(), bytes: 0 }
    for (const album of page.items) {
      const role = organizations.get(album.rootId)?.role ?? null
      if (album.trackCount === 0 || album.editionId !== null || role !== null && role !== 'catalog') continue
      const key = groupIdentity(album.rootId, album.id), value = snapshot.groups.get(key)
      if (!value) continue
      const raw = JSON.parse(value) as Record<string, unknown>
      // groups.directory可能被跨目录CUE的事件改变；这里只接受真实members的唯一物理目录。
      if (typeof raw.physical_directory !== 'string' || !isLocalAlbumPrivateRelative(raw.physical_directory, true)) continue
      const hint: DirectoryHint = { directory: raw.physical_directory, rootPin: rootPin(album.rootId), organizationPin: organizationPin(album.rootId) }
      const size = Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(hint)), previous = saved.entries.get(key)
      if (previous) { saved.bytes -= Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(previous)); saved.entries.delete(key) }
      while (saved.entries.size && (saved.entries.size >= HINT_MAX_ITEMS || saved.bytes + size > HINT_MAX_BYTES)) {
        const oldest = saved.entries.keys().next().value!
        saved.bytes -= Buffer.byteLength(oldest) + Buffer.byteLength(JSON.stringify(saved.entries.get(oldest)!)); saved.entries.delete(oldest)
      }
      if (size <= HINT_MAX_BYTES) { saved.entries.set(key, hint); saved.bytes += size }
    }
    assertReadActive()
    directoryHints.set(db, saved)
  }
  function currentHint(request: dto.LocalAlbumArtworkRequest): { directory: string; cuePayloads: string } | null {
    const saved = directoryHints.get(db), key = groupIdentity(request.rootId, request.albumKey), hint = saved?.entries.get(key)
    const role = organizations.get(request.rootId)?.role ?? null
    if (!hint || request.editionId !== null || role !== null && role !== 'catalog'
      || hint.rootPin !== rootPin(request.rootId) || hint.organizationPin !== organizationPin(request.rootId)) return null
    // 同当前结构水位的原CUE全集已经逐项核过；这里只取sidecar或实际引用涉及目标目录的完整闭包。
    const cue = currentCues(request.rootId)
    if (!cue || cue.unknownRoots.has(request.rootId) || cue.unsafe.has(groupIdentity(request.rootId, hint.directory))) return null
    saved!.entries.delete(key); saved!.entries.set(key, hint)
    return { directory: hint.directory, cuePayloads: packCues(cue, request.rootId, hint.directory) }
  }
  /** 冷读只借当前代表成员证明位置；原目录全集SQL仍重算组、修订、选图和全部事件。 */
  function coldArtworkHint(request: dto.LocalAlbumArtworkRequest): { directory: string; cuePayloads: string } | null {
    assertReadActive()
    const role = organizations.get(request.rootId)?.role ?? null, root = roots.get(request.rootId)?.root
    if (!root || request.editionId !== null || !request.representativeTrackId || role !== null && role !== 'catalog' || !source.sourceLookup) return null
    // sourceLookup仅是Source写回锚点；原candidates还会合并其后真实observation及当前override。
    // 复用原单ID来源投影，不能把缺锚点当作缺曲目，也不能按旧锚点猜当前分组键。
    const row = statement(`${memberProjection()} SELECT * FROM candidates WHERE id=@seedTrackId`).get({ ...rootBindings(request.rootId),
      memberPage: JSON.stringify([{ id: request.representativeTrackId }]), seedTrackId: request.representativeTrackId })
    if (!row) return null
    const seed = makeFact(row, null, null), { track, asset, versionTokens } = seed.summary
    if (track.id !== request.representativeTrackId || asset.id !== track.assetId || asset.libraryRootId !== request.rootId
      || asset.sourceRootId !== root.sourceRootId || asset.rootRevision !== root.revision
      || statement("SELECT 1 FROM local_catalog_edition_tracks WHERE track_id=? AND json_extract(data,'$.active')=1 LIMIT 1").get(track.id)) return null
    const versions = [...new Set(versionTokens.filter(token => token.source === 'album'
      && (token.kind === 'edition' || token.kind === 'format')).map(token => token.raw))].sort()
    const directory = parent(seed.relative)
    // 与mb_album_key共用原codec的title→artist→album预算；根目录组仍忽略原标题与版本词。
    if (request.albumKey !== `directory-${hash([request.rootId, directory, directory === '' ? '' : seed.rawMetadata.album?.trim() ?? '', directory === '' ? [] : versions])}`) return null
    const cue = currentCues(request.rootId)
    if (!cue || cue.unknownRoots.has(request.rootId) || cue.unsafe.has(groupIdentity(request.rootId, directory))) return null
    assertReadActive()
    return { directory, cuePayloads: packCues(cue, request.rootId, directory) }
  }
  /** 详情只借同屏障完整Compact的位置；原目录facts/成员/事件和末屏障仍逐次实读。 */
  function currentMemberHint(request: dto.LocalAlbumTrackQuery): { directory: string; cuePayloads: string } | null {
    assertReadActive()
    const role = organizations.get(request.rootId)?.role ?? null
    if (role !== null && role !== 'catalog') return null
    const value = cachedCompact(request.rootId)?.groups.get(groupIdentity(request.rootId, request.albumKey))
    if (!value) return null
    const raw = JSON.parse(value) as Record<string, unknown>
    if (raw.root_id !== request.rootId || raw.album_key !== request.albumKey || raw.edition_id !== null
      || Number(raw.track_count) <= 0 || typeof raw.physical_directory !== 'string'
      || raw.directory !== raw.physical_directory || !isLocalAlbumPrivateRelative(raw.physical_directory, true)) return null
    // 跨目录CUE、未知引用或未完整核验的CUE投影不能证明目录闭包，继续原全根SQL。
    const cue = currentCues(request.rootId)
    if (!cue || cue.unknownRoots.has(request.rootId) || cue.unsafe.has(groupIdentity(request.rootId, raw.physical_directory))) return null
    assertReadActive()
    return { directory: raw.physical_directory, cuePayloads: packCues(cue, request.rootId, raw.physical_directory) }
  }
  function find(albumKey: string, rootId: string, hint?: ReturnType<typeof currentMemberHint>): { album: dto.LocalAlbumSummary; directory: string | null; artworkSourceRevision: string } {
    const snapshot = cachedDerived(), raw = snapshot?.groups.get(groupIdentity(rootId, albumKey))
    const targetSql = hint ? directorySql(sql, hint.directory) : sql
    const row = snapshot ? raw ? JSON.parse(raw) as Record<string, unknown> : undefined
      : statement(`${targetSql} SELECT * FROM groups WHERE album_key=@albumKey AND root_id=@rootId`).get({ ...rootBindings(rootId),
        hintDirectory: hint?.directory ?? null, hintPrefix: hint ? hint.directory + '/' : null,
        hintUpper: hint ? hint.directory + '0' : null, cuePayloads: hint?.cuePayloads ?? null, albumKey, rootId })
    if (!row) return changed()
    if (!opaque(row.artwork_source_revision)) return unavailable()
    return { album: summary(row), directory: row.directory === null ? null : String(row.directory), artworkSourceRevision: String(row.artwork_source_revision) }
  }
  function indexedRows(snapshot: DerivedSnapshot, albumKey: string, rootId: string, offset: number, limit: number): Record<string, unknown>[] {
    const memberPage = `[${(snapshot.members.get(groupIdentity(rootId,albumKey)) ?? []).slice(offset,offset+limit).map(item=>item.raw).join(',')}]`
    const rows = indexedFactRows(memberPage, rootId)
    if (rows.length !== Math.min(limit,Math.max(0,(snapshot.members.get(groupIdentity(rootId,albumKey))?.length ?? 0)-offset))) return changed()
    return rows
  }
  function indexedFactRows(memberPage: string, rootId: string): Record<string, unknown>[] {
    // 原Source字段仅对实际索引页ID求值；其余原tag/asset/关系/扫描解码仍由当前SQLite行提供。
    const pageProjection = memberProjection()
    const text = `${pageProjection}, source_metadata AS(SELECT c.id,${fields.flatMap(field=>[`c.raw_${field}`,`c.effective_${field}`]).join(',')} FROM candidates c),
      page_members AS MATERIALIZED(SELECT ${memberIndexColumns.map(column=>`json_extract(value,'$.${column}') ${column}`).join(',')} FROM json_each(@memberPage))
      SELECT ${factColumns},${selectedRevision} selected_revision,${pageScan} scan_json,p.directory,l.data relation_data,p.disc,p.track_number,p.sequence,p.cue_member${organized ? ',p.name_failed_member' : ''}
      FROM page_members p ${pageFactJoins} ORDER BY p.sequence`
    return statement(text).all({ ...rootBindings(rootId), memberPage })
  }
  function queryAlbums(request: dto.LocalAlbumQuery): dto.LocalAlbumPage {
    const started = performance.now(); let hit = false, code: 'ORDERED_INDEX_HIT' | 'ORDERED_INDEX_BUILT' | undefined
    let hintSnapshot: CompactSnapshot | null = null
    const result = run(() => { if (!dto.isLocalAlbumQuery(request) || request.rootId !== null && !roots.has(request.rootId)) return invalid()
      const key = JSON.stringify([request.rootId, request.query, request.filter, request.offset, request.limit]), cached = queryPages.get(key)
      if (cached !== undefined) {
        const result: unknown = JSON.parse(cached)
        if (!dto.isLocalAlbumPage(result, request)) return unavailable()
        hintSnapshot = cachedCompact(request.rootId)
        queryPages.delete(key); queryPages.set(key, cached); hit = true; return result
      }
      const where = `(@rootId IS NULL OR root_id=@rootId) AND mb_album_match(title,artists,year,version_label,source_label,@query)=1`, filter = request.filter === 'all' ? '1' : `${statusColumns[statuses.indexOf(request.filter)]}=1`
      const indexKey = JSON.stringify([request.rootId, request.query, request.filter]), compact = compactGroups(request.rootId)
      const ordered = compact && queryIndex?.key === indexKey ? queryIndex : undefined
      const selected = ordered?.keys.slice(request.offset, request.offset + request.limit)
      const compactSource = compact ? selected ? compactRowsSql(selected.map(identity => {
        const raw = compact.groups.get(identity); if (raw === undefined) return changed(); return raw
      })) : compactSql(compact) : null
      hintSnapshot = compact
      // 首次仍由原SQLite计算完整counts/自然排序；后续同屏障只对本页重新执行库存overlay和公开摘要。
      const countsSql = ordered ? 'SELECT @orderedCounts counts,@orderedTotal total'
        : `SELECT json_object('all',count(*),${statuses.map((status,index)=>`'${status}',coalesce(sum(${statusColumns[index]}),0)`).join(',')}) counts,
          coalesce(sum(CASE WHEN ${filter} THEN 1 ELSE 0 END),0) total FROM scoped`
      const orderedKeysSql = compact && !ordered ? `(SELECT json_group_array(json_array(root_id,album_key)) FROM
        (SELECT root_id,album_key FROM scoped WHERE ${filter} ORDER BY mb_album_sort(title),album_key LIMIT ${COMPACT_MAX_GROUPS + 1}))` : 'NULL'
      const row = statement(`${compactSource?.sql ?? sql}, scoped AS MATERIALIZED(SELECT * FROM groups WHERE ${where}),
        counts AS(${countsSql}),
        page_rows AS MATERIALIZED(SELECT ${publicSummaryColumns.join(',')} FROM scoped WHERE ${filter} ORDER BY mb_album_sort(title),album_key LIMIT @limit OFFSET @offset),
        page AS(SELECT mb_album_page_item(json_object(${publicSummaryColumns.map(column=>`'${column}',${column}`).join(',')})) item_json FROM page_rows),
        public_page AS(SELECT json_object('counts',json(counts),'total',total,'items',json(coalesce((SELECT json_group_array(json(item_json)) FROM page),'[]'))) envelope FROM counts)
        SELECT envelope,${orderedKeysSql} ordered_keys FROM public_page`)
        .get({ ...rootBindings(request.rootId), ...(compactSource ? { compactRows: compactSource.compactRows } : {}),
          ...(ordered ? { orderedCounts: ordered.counts, orderedTotal: ordered.total } : {}), rootId: request.rootId, query: request.query, limit: request.limit, offset: ordered ? 0 : request.offset })
      if (!row || typeof row.envelope !== 'string') return unavailable()
      // 私有键列独立预算；公开信封仍按原UTF8上限拒绝，不能截断卡片或返回部分counts。
      if (Buffer.byteLength(row.envelope, 'utf8') > LOCAL_ALBUM_SQL_ENVELOPE_MAX_BYTES) return limited()
      const parsed: unknown = JSON.parse(row.envelope)
      if (!closed(parsed, ['counts','total','items']) || !dense(parsed.items, request.limit)) return unavailable()
      const { total, counts, items } = parsed as unknown as LocalAlbumSqlPageEnvelope
      const result = { ...request, total, counts, hasMore: request.offset + items.length < total, items }; if (!dto.isLocalAlbumPage(result, request)) return unavailable()
      if (selected) {
        if (selected.length !== items.length || items.some((item,index) => groupIdentity(item.rootId,item.id) !== selected[index])) return changed()
        code = 'ORDERED_INDEX_HIT'
      } else if (compact && typeof row.ordered_keys === 'string' && Buffer.byteLength(row.ordered_keys) + Buffer.byteLength(indexKey) + Buffer.byteLength(JSON.stringify(counts)) <= QUERY_PAGE_MAX_BYTES) {
        const pairs: unknown = JSON.parse(row.ordered_keys)
        if (!dense(pairs,COMPACT_MAX_GROUPS) || pairs.length !== total) return unavailable()
        const keys = pairs.map(pair => {
          if (!dense(pair,2) || pair.length !== 2 || typeof pair[0] !== 'string' || !roots.has(pair[0]) || !opaque(pair[1])) return unavailable()
          const identity = groupIdentity(pair[0],pair[1]); if (!compact.groups.has(identity)) return unavailable(); return identity
        })
        if (new Set(keys).size !== keys.length) return unavailable()
        const pageKeys = keys.slice(request.offset,request.offset+request.limit)
        if (pageKeys.length !== items.length || items.some((item,index) => groupIdentity(item.rootId,item.id) !== pageKeys[index])) return unavailable()
        const encodedCounts = JSON.stringify(counts)
        operationQueryIndex = { key:indexKey,keys,counts:encodedCounts,total,
          bytes:Buffer.byteLength(indexKey)+Buffer.byteLength(row.ordered_keys)+Buffer.byteLength(encodedCounts) }
        code = 'ORDERED_INDEX_BUILT'
      }
      retainQueryPage(key, result); return result
    })
    // 只有真实公开页连末屏障也成功后，才把位置加入跨批次提示。
    retainDirectoryHints(hintSnapshot, result)
    logLibraryOperation('cache', 'albums.query-page', hit ? 'hit' : 'miss', { ...(code ? {code} : {}), count: queryPages.size, bytes: queryBytes(), elapsedMs: performance.now() - started })
    return result
  }
  /** 后台只发现原group身份；不调用封面状态overlay，不构造或冒充公开counts。 */
  function queryBackgroundCandidates(request: LocalAlbumBackgroundCandidateQuery): LocalAlbumBackgroundCandidatePage {
    const started = performance.now(); let code = 'FULL_FACTS'
    const page = run(() => {
      if (!isLocalAlbumBackgroundCandidateQuery(request) || !roots.has(request.rootId)) return invalid()
      const compact = compactGroups(request.rootId)
      const columns = ['album_key','root_id','edition_id','representative_track_id','revision','title']
      const compactRows = compact ? `[${[...compact.groups.values()].join(',')}]` : null
      const sourceSql = compact ? `WITH group_facts AS MATERIALIZED(SELECT ${columns.map(column => `json_extract(value,'$.${column}') ${column}`).join(',')}
        FROM json_each(@compactRows) WHERE json_extract(value,'$.root_id')=@rootId)` : factsSql
      if (compact) code = 'COMPACT_PAGE'
      const row = statement(`${sourceSql}, candidates AS MATERIALIZED(SELECT ${columns.join(',')} FROM group_facts WHERE root_id=@rootId),
        page_rows AS MATERIALIZED(SELECT * FROM candidates ORDER BY mb_album_sort(title),album_key LIMIT @limit OFFSET @offset),
        page AS(SELECT json_object('albumKey',album_key,'rootId',root_id,'editionId',edition_id,'representativeTrackId',representative_track_id,'revision',revision) item_json FROM page_rows)
        SELECT json_object('total',(SELECT count(*) FROM candidates),'items',json(coalesce((SELECT json_group_array(json(item_json)) FROM page),'[]'))) envelope`)
        .get({ ...(compact ? rootBindings(request.rootId) : cueBindings(request.rootId)), ...(compactRows === null ? {} : { compactRows }), rootId: request.rootId, offset: request.offset, limit: request.limit })
      if (!row || typeof row.envelope !== 'string') return unavailable()
      if (Buffer.byteLength(row.envelope) > LOCAL_ALBUM_BACKGROUND_CANDIDATE_BYTES) return limited()
      const value: unknown = JSON.parse(row.envelope)
      if (!closed(value, ['total','items']) || typeof value.total !== 'number' || !dense(value.items, request.limit)) return unavailable()
      const result = { ...request, total: value.total, hasMore: request.offset + value.items.length < value.total, items: value.items }
      if (!isLocalAlbumBackgroundCandidatePage(result, request)) return unavailable()
      return result
    })
    logLibraryOperation('cache', 'albums.background-candidates', 'complete', { code, count: page.items.length, total: page.total, elapsedMs: performance.now() - started })
    return page
  }
  function queryAlbumMembers(request: dto.LocalAlbumTrackQuery): LocalAlbumSqlMemberPage {
    const started = performance.now(); let derivedHit: boolean | undefined, directoryScoped = false, completed = false
    try {
      const result = run(() => {
        if (!dto.isLocalAlbumTrackQuery(request)) return invalid()
        const snapshot = cachedDerived(); derivedHit = snapshot !== null
        let found: ReturnType<typeof find>, rows: Record<string, unknown>[]
        if (snapshot) {
          found = find(request.albumKey, request.rootId)
          rows = indexedRows(snapshot, request.albumKey, request.rootId, request.offset, request.limit)
        } else {
          const hint = currentMemberHint(request), targetSql = hint ? directorySql(sql, hint.directory) : sql
          directoryScoped = hint !== null
          // 同一原CTE完整重算目标物理目录；外层LEFT JOIN保留零成员组及越界空页的total。
          const selected = statement(`${targetSql}, current_group AS MATERIALIZED(SELECT * FROM groups WHERE album_key=@albumKey AND root_id=@rootId),
            page_members AS MATERIALIZED(SELECT * FROM members WHERE album_key=@albumKey AND root_id=@rootId ORDER BY sequence LIMIT @limit OFFSET @offset)
            SELECT json_object(${[...publicSummaryColumns,'directory','artwork_source_revision'].map(column=>`'${column}',g.${column}`).join(',')}) group_json,
              ${factColumns},${selectedRevision} selected_revision,${pageScan} scan_json,p.directory,l.data relation_data,p.disc,p.track_number,p.sequence,
              ${organized ? 'EXISTS(SELECT 1 FROM names n WHERE n.root_id=p.root_id AND n.directory=p.directory) name_failed_member,' : ''}
              ${cueMember} cue_member
            FROM current_group g LEFT JOIN page_members p ON 1 LEFT JOIN source_metadata m ON m.id=p.id
            LEFT JOIN local_catalog_tracks t ON t.id=p.id LEFT JOIN local_catalog_assets a ON a.id=t.asset_id
            LEFT JOIN local_catalog_edition_tracks l ON l.id=p.relation_id ${selection} ORDER BY p.sequence`).all({ ...rootBindings(request.rootId),
              hintDirectory: hint?.directory ?? null, hintPrefix: hint ? hint.directory + '/' : null,
              hintUpper: hint ? hint.directory + '0' : null, cuePayloads: hint?.cuePayloads ?? null, ...request })
          if (!selected.length) return changed()
          const group = JSON.parse(String(selected[0]!.group_json)) as Record<string, unknown>
          if (!opaque(group.artwork_source_revision)) return unavailable()
          found = { album: summary(group), directory: group.directory === null ? null : String(group.directory), artworkSourceRevision: group.artwork_source_revision }
          rows = selected.filter(row => row.id !== null)
        }
        const items: LocalAlbumGroupMember[] = rows.map(row => { const fact = makeFact(row, row.selected_revision === null ? null : String(row.selected_revision), row.scan_json === null ? null : String(row.scan_json)), directory = String(row.directory)
          return { fact, editionLink: row.relation_data === null ? null : JSON.parse(String(row.relation_data)) as dto.AlbumEditionTrack, disc: row.disc === null ? null : Number(row.disc), trackNumber: row.track_number === null ? null : Number(row.track_number), sequence: Number(row.sequence), statuses: [...(fact.hasArtwork ? ['has-artwork' as const] : []), ...(Number(row.cue_member) === 1 && !fact.summary.track.segment ? ['cue-unsplit' as const] : []), ...((organized ? Number(row.name_failed_member) === 1 : names.some(item => item.state === 'failed' && item.rootId === request.rootId && item.directory === directory)) ? ['parse-failed' as const] : []), ...(found.directory === '' && organizations.get(request.rootId)?.role !== 'album' ? ['loose-audio' as const] : []), ...(/^track(?:\d+)?$/iu.test(basename(fact.relative).replace(/\.[^.]+$/u, '')) ? ['track-named-audio' as const] : [])] } })
        return { ...request, album: found.album, directory: found.directory, total: found.album.trackCount, hasMore: request.offset + items.length < found.album.trackCount, items }
      })
      completed = true; return result
    } finally {
      logLibraryOperation('cache', 'albums.members-page', completed ? derivedHit ? 'hit' : 'miss' : 'error', {
        code: derivedHit === undefined ? 'NOT_CHECKED' : derivedHit ? 'DERIVED_HIT' : directoryScoped ? 'DIRECTORY_HINT' : 'DERIVED_MISS', elapsedMs: performance.now() - started,
      })
    }
  }
  // 缓存活动曲目的精确SELECT与反复使用的全库修订首行；原run/readBarrier和完整scope每次仍校验。
  // 沿原2MiB信封上限约束全部条目，来源/SQL/库存水位变化立即丢弃，不能替代授权或业务目录。
  const mobileExactPages = new Map<string, { page: MobileSqlPage; bytes: number }>()
  let mobileExactBarrier = '', mobileExactBytes = 0
  /** 原seeds每个新key必有成员、拒收、无成员CUE或failed-name见证；全表多计只会收紧窄证明。 */
  function sourceMemberCapacityKnown(): boolean {
    let upper = names.length
    for (const table of ['local_catalog_tracks','local_catalog_edition_tracks','local_scan_file_state','local_cue_sources']) {
      if (!hasTable(table)) continue
      const count = Number(statement(`SELECT count(*) n FROM ${table}`).get()?.n)
      if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(upper + count)) return false
      upper += count
    }
    // CUE多音频、name多成员事件只复用既有member key；无成员时每原payload才至多新增一个key。
    // 超过保守上界不等于实际超限：必须回原精确作者，不拒绝合法库，也不省略原容量检查。
    return upper <= 300_000
  }
  function sourceMemberDirectory(rootId: string, relative: string): string | null {
    const role = organizations.get(rootId)?.role ?? null
    if (role === 'album') return ''
    let directory = parent(relative)
    if (role !== 'artist') return directory
    if (directory && directory.split('/').length > 64) return null
    for (let depth = 0; depth < 64; depth++) {
      if (!directory || !parent(directory)) return directory
      const kind = classifyDirectoryName(basename(directory))
      if (kind === 'disc' || kind === 'format') {
        directory = localAlbumOrganizationBoundaryStep(role, directory, 0, 0, 0); continue
      }
      const numbered = /^\d{1,2}$/u.test(basename(directory).trim()) && Number(basename(directory)) > 0
      if (!numbered && kind !== 'track') return directory
      const selectedParent = parent(directory), prefix = selectedParent + '/'
      const siblings = statement(`SELECT directory,count(DISTINCT asset_id) direct_count FROM (
        SELECT a.id asset_id,mb_album_parent(a.relative) directory FROM local_catalog_assets a
        JOIN local_catalog_tracks t ON t.asset_id=a.id WHERE a.root_id=@memberRoot
        AND a.relative COLLATE BINARY>=@memberPrefix AND a.relative COLLATE BINARY<@memberUpper)
        WHERE mb_album_directory_parent(directory)=@memberParent GROUP BY directory`)
        .iterate({ memberRoot: rootId, memberPrefix: prefix, memberUpper: selectedParent + '0', memberParent: selectedParent })
      let direct = 0, siblingCount = 0, numberedSiblings = 0, allTrack = true
      for (const sibling of siblings) {
        assertReadActive()
        const name = sibling.directory, count = Number(sibling.direct_count)
        if (typeof name !== 'string' || !isLocalAlbumPrivateRelative(name,true) || !Number.isSafeInteger(count) || count < 1) return unavailable()
        if (++siblingCount > 300_000) return null
        if (name === directory) direct = count
        numberedSiblings += /^\d{1,2}$/u.test(basename(name).trim()) && Number(basename(name)) > 0 ? 1 : 0
        allTrack &&= count <= 1 && classifyDirectoryName(basename(name)) === 'track'
      }
      const next = localAlbumOrganizationBoundaryStep(role, directory, direct, numberedSiblings, siblingCount >= 2 && allTrack ? 1 : 0)
      if (next === directory) return directory
      directory = next
    }
    return null
  }
  /** 只证明Source所需的当前成员；完整detail由原Owner再核，不制造整组summary或库存状态。 */
  function sourceMemberIdentity(request: LocalAlbumSourceMemberRequest): LocalAlbumSourceMemberResult | null {
    const started = performance.now(); let completed = false, result: LocalAlbumSourceMemberResult | null = null
    try {
    result = run(() => {
      if (!closed(request,['trackId','groupHash','editionId']) || !dto.isCollectionId(request.trackId)
        || (request.groupHash === null) === (request.editionId === null)
        || request.groupHash !== null && !/^[a-f0-9]{64}$/u.test(request.groupHash)
        || request.editionId !== null && !dto.isCollectionId(request.editionId)) return invalid()
      if (!source.sourceLookup || !sourceMemberCapacityKnown()) return null
      const row = statement(`${memberProjection()} SELECT * FROM candidates WHERE id=@seedTrackId AND mb_album_root(root_id)=1`)
        .get({ ...rootBindings(null), memberPage: JSON.stringify([{ id: request.trackId }]), seedTrackId: request.trackId })
      let legacyGroupCount: number | null = null
      if (request.editionId !== null) {
        const seen = new Set<string>()
        for (const root of statement(`SELECT DISTINCT a.root_id FROM local_catalog_edition_tracks l
          JOIN local_catalog_tracks t ON t.id=l.track_id JOIN local_catalog_assets a ON a.id=t.asset_id
          WHERE l.edition_id=? AND json_extract(l.data,'$.active')=1`).iterate(request.editionId)) {
          if (typeof root.root_id !== 'string') return unavailable()
          if (roots.has(root.root_id)) seen.add(root.root_id)
          if (seen.size > 1) break
        }
        legacyGroupCount = seen.size
        if (legacyGroupCount !== 1) return { legacyGroupCount, items: [] }
      }
      if (!row) return { legacyGroupCount, items: [] }
      const selected = makeFact(row, null, null), { track, asset, versionTokens } = selected.summary
      const rootId = asset.libraryRootId, root = roots.get(rootId)?.root
      if (!root || track.id !== request.trackId || track.assetId !== asset.id) return unavailable()
      // Root与asset修订/来源错配仍交原detailFor公共作者判409，不在此降成临时503。
      const fact = { relative: selected.relative, summary: selected.summary, rawMetadata: selected.rawMetadata }
      const versions = [...new Set(versionTokens.filter(token => token.source === 'album' && (token.kind === 'edition' || token.kind === 'format')).map(token => token.raw))].sort()
      const items: LocalAlbumSourceMemberIdentity[] = []
      let relations = 0
      for (const saved of statement("SELECT data,edition_id FROM local_catalog_edition_tracks WHERE track_id=? AND json_extract(data,'$.active')=1").iterate(track.id)) {
        relations++
        const albumKey = memberAlbumKey(rootId,saved.edition_id,'',fact.rawMetadata.album,JSON.stringify(versions)), groupHash = hash([rootId,albumKey])
        if (request.groupHash !== null ? request.groupHash !== groupHash : request.editionId !== saved.edition_id) continue
        const link = JSON.parse(String(saved.data)) as dto.AlbumEditionTrack
        if (!dto.isAlbumEditionTrack(link) || !link.active || link.trackId !== track.id || link.editionId !== saved.edition_id) return unavailable()
        items.push({ rootId,albumKey,groupHash,editionId:link.editionId,fact,editionLink:link })
        if (items.length === 2) break
      }
      if (!relations && request.editionId === null) {
        const directory = sourceMemberDirectory(rootId, fact.relative)
        if (directory === null) return null
        const albumKey = memberAlbumKey(rootId,null,directory,fact.rawMetadata.album,JSON.stringify(versions)), groupHash = hash([rootId,albumKey])
        if (groupHash === request.groupHash) items.push({ rootId,albumKey,groupHash,editionId:null,fact,editionLink:null })
      }
      const result = { legacyGroupCount, items }
      if (Buffer.byteLength(JSON.stringify(result)) > LOCAL_ALBUM_SQL_ENVELOPE_MAX_BYTES) return limited()
      return result
    })
    completed = true; return result
    } finally {
      // 沿原有界指标只记录point/保留精确路径、耗时和0/1/多义计数，不记请求身份或字段正文。
      logLibraryOperation('cache','albums.mobile-members',completed ? 'complete' : 'error', {
        code: completed ? result === null ? 'SOURCE_MEMBER_EXACT' : 'SOURCE_MEMBER_POINT' : 'SOURCE_MEMBER_NOT_CHECKED',
        elapsedMs: performance.now() - started, ...(result ? {count:result.items.length} : {}),
      })
    }
  }
  /** 手机分组复用原有完整摘要与库存overlay；成员事实仍沿原SELECT读取。 */
  function queryMobile(request: LocalAlbumSqlMobileQuery): MobileSqlPage {
    const started = performance.now(); let code = 'NOT_CHECKED', completed = false, metricAction: 'albums.mobile-groups' | 'albums.mobile-members' = 'albums.mobile-groups', observedTotal: number | undefined, observedCount: number | undefined
    try {
    const result = run(() => {
      if (!closed(request, ['kind','offset','limit','query','rootId','albumKey','trackId','editionId','groupHash'])
        || !['groups','members'].includes(request.kind) || !Number.isSafeInteger(request.offset) || request.offset < 0
        || !Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100
        || !dto.isLocalCatalogText(request.query, true) || [...request.query].length > 200
        || request.rootId !== null && (!dto.isCollectionId(request.rootId) || !roots.has(request.rootId))
        || request.albumKey !== null && !opaque(request.albumKey) || request.trackId !== null && !dto.isCollectionId(request.trackId)
        || request.editionId !== null && !dto.isCollectionId(request.editionId)
        || request.groupHash !== null && (typeof request.groupHash !== 'string' || !/^[a-f0-9]{64}$/u.test(request.groupHash))) return invalid()
      metricAction = request.kind === 'members' ? 'albums.mobile-members' : 'albums.mobile-groups'
      if (mobileExactBarrier !== operationBarrier) { mobileExactPages.clear(); mobileExactBytes = 0; mobileExactBarrier = operationBarrier }
      const scopeRevision = request.kind === 'groups' && request.limit === 1 && request.rootId === null
        && request.albumKey === null && request.trackId === null && request.editionId === null && request.groupHash === null
      const exact = request.offset === 0 && request.limit <= 2 && request.query === ''
        && (request.kind === 'members' && request.trackId !== null || request.kind === 'groups' && request.editionId !== null || scopeRevision)
      const exactKey = exact ? JSON.stringify(request) : null, previous = exactKey === null ? undefined : mobileExactPages.get(exactKey)
      if (previous) { code = 'EXACT_CACHE'; return structuredClone(previous.page) }
      // 容量属于整个scope；局部页不能把其它根或未命中筛选的专辑排除在30万闭包之外。
      const params = { ...rootBindings(null), ...request, query: request.query.trim() }
      const readTotal = (text: string, values = params): number => {
        const row = statement(text).get(values), globalTotal = Number(row?.global_total)
        if (!Number.isSafeInteger(globalTotal) || globalTotal < 0) return unavailable()
        if (globalTotal > 300_000) return limited()
        return Number(row?.total)
      }
      const groupWhere = `(@rootId IS NULL OR g.root_id=@rootId) AND (@albumKey IS NULL OR g.album_key=@albumKey)
        AND (@editionId IS NULL OR g.edition_id=@editionId)
        AND (@groupHash IS NULL OR mb_album_group_hash(g.root_id,g.album_key)=@groupHash)`
      const order = 'mb_album_sort(g.title),g.album_key'
      const groupColumns = [...publicSummaryColumns, 'directory', 'artwork_source_revision', ...(structureOnly ? ['source_has_artwork'] : [])]
      const groupJson = `json_object(${groupColumns.map(column => `'${column}',g.${column}`).join(',')})`
      const projectGroup = (row: Record<string, unknown>): MobileSqlRow => {
        const album = structureOnly ? structureAlbum(row) : summary(row)
        if (!roots.has(album.rootId) || row.root_id !== album.rootId || row.album_key !== album.id
          || typeof row.artwork_source_revision !== 'string' || !/^[a-f0-9]{64}$/u.test(row.artwork_source_revision)) return unavailable()
        if (structureOnly) {
          if (typeof row.revision !== 'string' || !/^[a-f0-9]{64}$/u.test(row.revision)) return unavailable()
          return { album, groupHash: hash([album.rootId, album.id]), artworkSourceRevision: row.artwork_source_revision,
            structureRevision: row.revision, sourceHasArtwork: Number(row.source_has_artwork) === 1, online: Number(row.online) === 1, member: null }
        }
        return { album: album as dto.LocalAlbumSummary, groupHash: hash([album.rootId, album.id]), artworkSourceRevision: row.artwork_source_revision, member: null }
      }
      let selectedCompact: { snapshot: CompactSnapshot; rows: readonly string[] } | undefined
      function mobileRows(compact: CompactSnapshot): readonly string[] {
        if (selectedCompact?.snapshot === compact) return selectedCompact.rows
        const rows: string[] = []
        for (const [identity, raw] of compact.groups) {
          // 精确地址先按已核两列键选候选；仍由下方原SQLite筛选和库存overlay证明输出。
          if (request.rootId !== null || request.albumKey !== null || request.groupHash !== null) {
            const pair = JSON.parse(identity) as [string, string]
            if (request.rootId !== null && pair[0] !== request.rootId || request.albumKey !== null && pair[1] !== request.albumKey
              || request.groupHash !== null && hash(pair) !== request.groupHash) continue
          }
          if (request.editionId !== null && (JSON.parse(raw) as Record<string, unknown>).edition_id !== request.editionId) continue
          rows.push(raw)
        }
        selectedCompact = { snapshot: compact, rows }; return rows
      }
      // 和桌面页共用原4MiB位置索引预算。只缓存原SQLite算出的顺序及成员偏移，
      // 每页仍经run完整屏障，再对本页执行当前库存overlay或原成员SELECT。
      function mobileOrder(compact: CompactSnapshot): { keys: readonly string[]; offsets: readonly number[] } | null {
        if (request.trackId !== null || request.kind === 'members' && request.query !== '') return null
        const key = JSON.stringify(['mobile-order', request.query, request.rootId, request.albumKey, request.editionId, request.groupHash])
        const saved = queryIndex?.key === key && queryIndex.structureBarrier === operationStructureBarrier ? queryIndex : undefined
        if (saved) {
          const currentCounts = { ...params, orderedTotal: saved.total, mobileGlobalTotal: compact.groups.size }
          if (readTotal('SELECT @orderedTotal total,@mobileGlobalTotal global_total', currentCounts) !== saved.total) return changed()
          return { keys: saved.keys, offsets: JSON.parse(saved.counts) as number[] }
        }
        const where = `${groupWhere} AND mb_album_match(g.title,g.artists,g.year,g.version_label,g.source_label,@query)=1`
        const values = { ...params, compactRows: `[${mobileRows(compact).join(',')}]`, mobileGlobalTotal: compact.groups.size }
        // 全scope容量与自然排序首次仍由原SQLite证明；不以局部分组数量替代全局上限。
        const total = readTotal(`${compactFactsSql()} SELECT count(*) total,@mobileGlobalTotal global_total FROM group_facts g WHERE ${where}`, values)
        const row = statement(`${compactFactsSql()} SELECT json_group_array(json_array(root_id,album_key,track_count)) ordered_keys FROM
          (SELECT g.root_id,g.album_key,g.track_count FROM group_facts g WHERE ${where} ORDER BY ${order} LIMIT ${COMPACT_MAX_GROUPS + 1})`).get(values)
        if (!row || typeof row.ordered_keys !== 'string' || Buffer.byteLength(row.ordered_keys) > QUERY_PAGE_MAX_BYTES) return null
        const pairs: unknown = JSON.parse(row.ordered_keys)
        if (!dense(pairs, COMPACT_MAX_GROUPS) || pairs.length !== total) return unavailable()
        const keys: string[] = [], offsets = [0]
        for (const pair of pairs) {
          if (!dense(pair, 3) || pair.length !== 3 || typeof pair[0] !== 'string' || !roots.has(pair[0]) || !opaque(pair[1])
            || !Number.isSafeInteger(pair[2]) || Number(pair[2]) < 0) return unavailable()
          const identity = groupIdentity(pair[0], pair[1]), next = offsets[offsets.length - 1]! + Number(pair[2])
          if (!compact.groups.has(identity) || !Number.isSafeInteger(next)) return unavailable()
          keys.push(identity); offsets.push(next)
        }
        if (new Set(keys).size !== keys.length) return unavailable()
        const counts = JSON.stringify(offsets), bytes = Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(keys)) + Buffer.byteLength(counts)
        if (bytes > QUERY_PAGE_MAX_BYTES) return null
        // 高频单封面地址不挤走整库分页的位置索引；其候选本就只有少数行。
        if (request.rootId === null && request.albumKey === null && request.editionId === null && request.groupHash === null) {
          operationQueryIndex = { key, keys, counts, total, bytes, structureBarrier: operationStructureBarrier }
        }
        return { keys, offsets }
      }
      let total: number, items: readonly MobileSqlRow[]
      if (request.kind === 'groups') {
        // Compact只含分组摘要，带trackId的筛选仍须由原members证明实际关系。
        const compact = request.trackId === null ? compactGroups(null) : null
        const compactSource = compact ? compactRowsSql(mobileRows(compact)) : null
        const groupParams = { ...params, ...(compactSource ? { compactRows: compactSource.compactRows } : {}) }
        const where = `${groupWhere} AND mb_album_match(g.title,g.artists,g.year,g.version_label,g.source_label,@query)=1
          AND ${request.trackId === null ? '1' : 'EXISTS(SELECT 1 FROM members p WHERE p.root_id=g.root_id AND p.album_key=g.album_key AND p.id=@trackId)'}`
        if (compactSource) {
          code = 'COMPACT_FAST'
          const ordered = mobileOrder(compact!)
          if (ordered) {
            total = ordered.keys.length
            const selected = ordered.keys.slice(request.offset, request.offset + request.limit)
            const rows = selected.map(identity => { const row = compact!.groups.get(identity); if (row === undefined) return changed(); return row })
            items = statement(`${compactFactsSql()}, mobile_page_groups AS MATERIALIZED(SELECT * FROM group_facts),${artworkOverlay('mobile_page_groups')}
              SELECT g.* FROM groups g ORDER BY ${order}`).all({ ...groupParams, compactRows: `[${rows.join(',')}]` }).map(projectGroup)
            if (items.length !== selected.length || items.some((item, index) => groupIdentity(item.album.rootId, item.album.id) !== selected[index])) return changed()
          } else {
          // 搜索、范围和顺序只依赖结构摘要；先选页，再核该页库存，不能为count读取全部封面。
          total = readTotal(`${compactFactsSql()} SELECT count(*) total,(SELECT count(*) FROM group_facts) global_total FROM group_facts g WHERE ${where}`, groupParams)
          items = statement(`${compactFactsSql()}, mobile_page_groups AS MATERIALIZED(SELECT g.* FROM group_facts g WHERE ${where}
            ORDER BY ${order} LIMIT @limit OFFSET @offset),${artworkOverlay('mobile_page_groups')}
            SELECT g.* FROM groups g ORDER BY ${order}`).all(groupParams).map(projectGroup)
          }
        } else {
          code = 'FULL_FALLBACK'
          total = readTotal(`${sql} SELECT count(*) total,(SELECT count(*) FROM groups) global_total FROM groups g WHERE ${where}`, groupParams)
          items = statement(`${sql} SELECT g.* FROM groups g WHERE ${where} ORDER BY ${order} LIMIT @limit OFFSET @offset`).all(groupParams).map(projectGroup)
        }
      } else {
        // 保留原移动曲目完整搜索域；不从标题另建分组或提前裁剪真实成员关系。
        // 发行候选与当前曲目无相关依赖；SQLite只构建一次集合，避免按每首歌扫描活动关系。
        const search = `(@query='' OR ${['title','artist','album','year'].flatMap(field => [`instr(lower(coalesce(mobile_metadata.raw_${field},'')),lower(@query))>0`, `instr(lower(coalesce(mobile_metadata.effective_${field},'')),lower(@query))>0`]).join(' OR ')}
          OR mobile_metadata.id IN(SELECT search_link.track_id FROM local_catalog_edition_tracks search_link JOIN local_catalog_editions search_edition ON search_edition.id=search_link.edition_id
            WHERE json_extract(search_link.data,'$.active')=1
              AND (instr(lower(json_extract(search_edition.data,'$.title')),lower(@query))>0 OR instr(lower(json_extract(search_edition.data,'$.edition')),lower(@query))>0)))`
        const from = `FROM members p JOIN groups g ON g.root_id=p.root_id AND g.album_key=p.album_key
          JOIN source_metadata mobile_metadata ON mobile_metadata.id=p.id WHERE ${groupWhere} AND (@trackId IS NULL OR p.id=@trackId) AND ${search}`
        const readMembers = (targetSql: string, values: typeof params) => statement(`${targetSql}, page_members AS MATERIALIZED(SELECT p.*,${groupJson} album_json ${from}
          ORDER BY ${order},p.sequence,p.id LIMIT @limit OFFSET @offset)
          SELECT ${factColumns},${selectedRevision} selected_revision,${pageScan} scan_json,p.directory,l.data relation_data,
            p.root_id member_root_id,p.album_key member_album_key,p.id member_track_id,p.asset_record_id member_asset_id,
            p.disc,p.track_number,p.sequence,p.album_json,(${cueMember}) cue_member${organized ? ',EXISTS(SELECT 1 FROM names n WHERE n.root_id=p.root_id AND n.directory=p.directory) name_failed_member' : ''}
          FROM page_members p ${pageFactJoins}
          ORDER BY mb_album_sort(json_extract(p.album_json,'$.title')),p.album_key,p.sequence,p.id`).all(values)
        const projectMember = (row: Record<string, unknown>): MobileSqlRow => {
          const rawGroup = JSON.parse(String(row.album_json)) as Record<string, unknown>, group = projectGroup(rawGroup)
          const fact = makeFact(row, row.selected_revision === null ? null : String(row.selected_revision), row.scan_json === null ? null : String(row.scan_json))
          if (row.member_root_id !== group.album.rootId || row.member_album_key !== group.album.id
            || row.member_track_id !== fact.summary.track.id || row.member_asset_id !== fact.summary.asset.id
            || fact.summary.asset.libraryRootId !== group.album.rootId) return unavailable()
          const editionLink = row.relation_data === null ? null : JSON.parse(String(row.relation_data)) as dto.AlbumEditionTrack
          if (editionLink === null ? group.album.editionId !== null : !dto.isAlbumEditionTrack(editionLink) || !editionLink.active
            || editionLink.editionId !== group.album.editionId || editionLink.trackId !== fact.summary.track.id) return unavailable()
          const directory = String(row.directory)
          const member: LocalAlbumGroupMember = { fact, editionLink, disc: row.disc === null ? null : Number(row.disc),
            trackNumber: row.track_number === null ? null : Number(row.track_number), sequence: Number(row.sequence),
            statuses: [...(fact.hasArtwork ? ['has-artwork' as const] : []), ...(Number(row.cue_member) === 1 && !fact.summary.track.segment ? ['cue-unsplit' as const] : []),
              ...((organized ? Number(row.name_failed_member) === 1 : names.some(item => item.state === 'failed' && item.rootId === group.album.rootId && item.directory === directory)) ? ['parse-failed' as const] : []),
              ...(rawGroup.directory === '' && organizations.get(group.album.rootId)?.role !== 'album' ? ['loose-audio' as const] : []),
              ...(/^track(?:\d+)?$/iu.test(basename(fact.relative).replace(/\.[^.]+$/u, '')) ? ['track-named-audio' as const] : [])] }
          return { ...group, member }
        }
        type DirectoryPlan = { rootId: string; albumKey: string; offset: number; limit: number;
          hint: NonNullable<ReturnType<typeof currentMemberHint>>; size: number; revision: unknown; artworkRevision: unknown }
        /** 只合并本次同步run中已证明的静态目录计划；成员、扫描和库存仍由原CTE逐行实读。 */
        function readPlanMembers(plans: readonly DirectoryPlan[]): Record<string, unknown>[] | null {
          // 复杂组织仍逐目录读取；单目录没有重复物化需要消除。
          if (!source.sourceLookup || organized || plans.length < 2 || plans.length > 100
            || !sql.startsWith('WITH ')) return null
          const packedPlans = JSON.stringify(plans.map((plan, index) => ({ ordinal: index, rootId: plan.rootId, albumKey: plan.albumKey,
            directory: plan.hint.directory, prefix: plan.hint.directory + '/', upper: plan.hint.directory + '0', offset: plan.offset, limit: plan.limit })))
          if (Buffer.byteLength(packedPlans) > LOCAL_ALBUM_SQL_ENVELOPE_MAX_BYTES) return null
          // hint已在本次同步run核过完整CUE闭包。只借同屏障的原行号并集，
          // 不按payload去重，也不把跨目录、未知引用或复杂组织当普通目录。
          let cuePayloads = '[]'
          if (plans.some(plan => plan.hint.cuePayloads !== '[]')) {
            const cue = cueEntry(null)?.snapshot
            if (!cue) return null
            const selected = new Set<number>(), payloads: string[] = []
            let bytes = Buffer.byteLength(packedPlans) + 2
            for (const plan of plans) {
              const key = groupIdentity(plan.rootId, plan.hint.directory)
              if (cue.unknownRoots.has(plan.rootId) || cue.unsafe.has(key)
                || packCues(cue, plan.rootId, plan.hint.directory) !== plan.hint.cuePayloads) return null
              for (const rowId of cue.directories.get(key) ?? []) {
                if (selected.has(rowId)) continue
                const payload = cue.payloads.get(rowId)
                if (typeof payload !== 'string') return unavailable()
                bytes += Buffer.byteLength(payload) + (payloads.length ? 1 : 0)
                if (bytes > LOCAL_ALBUM_SQL_ENVELOPE_MAX_BYTES) return null
                selected.add(rowId); payloads.push(payload)
              }
            }
            cuePayloads = `[${payloads.join(',')}]`
          }
          const inDirectory = (root: string, relative: string): string => `EXISTS(SELECT 1 FROM mobile_plan_directories mobile_directory
            WHERE mobile_directory.root_id=${root} AND (mobile_directory.directory='' AND instr(${relative},'/')=0
              OR mobile_directory.directory<>'' AND ${relative}>=mobile_directory.prefix AND ${relative}<mobile_directory.upper
              AND instr(substr(${relative},length(mobile_directory.prefix)+1),'/')=0))`
          // plans是本次run已核的互不重叠直属目录。先由原位置索引定位，再执行原事实CTE；
          // 相关EXISTS只用于这些候选，不能让每个暖页重新过滤所有根的assets/scan行。
          const positions = (table: string, root: string, relative: string, columns: string): string => `SELECT ${columns}
            FROM mobile_plan_directories mobile_position CROSS JOIN ${table}
            WHERE mobile_position.directory<>'' AND ${root}=mobile_position.root_id
              AND ${relative}>=mobile_position.prefix AND ${relative}<mobile_position.upper
              AND instr(substr(${relative},length(mobile_position.prefix)+1),'/')=0
            UNION ALL SELECT ${columns} FROM mobile_plan_directories mobile_position CROSS JOIN ${table}
            WHERE mobile_position.directory='' AND ${root}=mobile_position.root_id AND instr(${relative},'/')=0`
          const sourceMarkSql = sourceMarks(false)
          if (!sql.includes(sourceMarkSql) || !sql.includes('FROM candidates c WHERE')) return null
          let plannedSql = sql.replace(sourceMarkSql, `SELECT t.id,mb_album_source_ordinal(t.id) ordinal
            FROM mobile_plan_assets mobile_asset CROSS JOIN local_catalog_tracks t ON t.asset_id=mobile_asset.id`)
          const hasScanPositions = scanFiles.includes('FROM local_scan_file_state WHERE')
          if (hasScanPositions) plannedSql = plannedSql.replace(scanFiles, scanFiles.replace('FROM local_scan_file_state WHERE',
            `FROM mobile_plan_scan_positions mobile_scan_position CROSS JOIN local_scan_file_state
              ON local_scan_file_state.library_root_id=mobile_scan_position.mobile_root_id
                AND local_scan_file_state.relative=mobile_scan_position.mobile_relative WHERE`))
          for (const [root, relative] of [['a.root_id', 'a.relative'], ['c.root_id', 'c.relative'], ['library_root_id', 'relative']] as const) {
            plannedSql = plannedSql.replaceAll(directoryGuard(relative), inDirectory(root, relative))
              .replaceAll(`(@root IS NULL OR ${root}=@root)`, `${root} IN(SELECT root_id FROM mobile_plan_directories)`)
          }
          // candidates原来允许没有Source字段的行；此路只物化本次原source_marks完整选中的位置。
          plannedSql = plannedSql.replace('FROM candidates c WHERE', 'FROM source_marks mobile_mark CROSS JOIN candidates c ON mobile_mark.id=c.id WHERE')
            .replace("(@hintDirectory IS NULL OR json_extract(value,'$.directory')=@hintDirectory)",
              "EXISTS(SELECT 1 FROM mobile_plan_directories mobile_name WHERE mobile_name.root_id=json_extract(value,'$.rootId') AND mobile_name.directory=json_extract(value,'$.directory'))")
          const planSql = `WITH mobile_plans AS MATERIALIZED(SELECT CAST(key AS INTEGER) plan_ordinal,
              json_extract(value,'$.rootId') root_id,json_extract(value,'$.albumKey') album_key,json_extract(value,'$.directory') directory,
              json_extract(value,'$.prefix') prefix,json_extract(value,'$.upper') upper,json_extract(value,'$.offset') start_offset,json_extract(value,'$.limit') page_limit
              FROM json_each(@mobilePlans)),
            mobile_plan_directories AS MATERIALIZED(SELECT DISTINCT root_id,directory,prefix,upper FROM mobile_plans),
            mobile_plan_assets AS MATERIALIZED(${positions('local_catalog_assets a', 'a.root_id', 'a.relative', 'a.id')}),
            ${hasScanPositions ? `mobile_plan_scan_positions AS MATERIALIZED(${positions('local_scan_file_state mobile_scan', 'mobile_scan.library_root_id', 'mobile_scan.relative', 'mobile_scan.library_root_id mobile_root_id,mobile_scan.relative mobile_relative')}),` : ''}
            ${plannedSql.slice('WITH '.length)},
            mobile_ranked AS MATERIALIZED(SELECT p.*,${groupJson} album_json,mp.plan_ordinal,mp.start_offset,mp.page_limit,
              ROW_NUMBER() OVER(PARTITION BY mp.plan_ordinal ORDER BY ${order},p.sequence,p.id) plan_position
              ${from.replace('FROM members p', 'FROM mobile_plans mp JOIN members p ON p.root_id=mp.root_id AND p.album_key=mp.album_key')}),
            page_members AS MATERIALIZED(SELECT * FROM mobile_ranked WHERE plan_position>start_offset AND plan_position<=start_offset+page_limit)
            SELECT ${factColumns},${selectedRevision} selected_revision,${pageScan} scan_json,p.directory,l.data relation_data,
              p.root_id member_root_id,p.album_key member_album_key,p.id member_track_id,p.asset_record_id member_asset_id,
              p.disc,p.track_number,p.sequence,p.album_json,(${cueMember}) cue_member,p.plan_ordinal,p.plan_position
            FROM page_members p ${pageFactJoins} ORDER BY p.plan_ordinal,p.plan_position`
          return statement(planSql).all({ ...params, root: coverageRoot(null), hintDirectory: null, hintPrefix: null, hintUpper: null,
            cuePayloads, mobilePlans: packedPlans })
        }
        function searchDirectoryPage(): MobileSqlPage | null {
          const compact = cachedCompact(null)
          if (!compact || !source.sourceLookup || organized || request.trackId !== null) return null
          const values = { ...params, mobileGlobalTotal: compact.groups.size }
          // 原raw/effective及任一活动发行的匹配谓词先找物理目录；不构造scan、分组、摘要或全库成员排序。
          // 有活动发行的匹配曲目仍交回原完整关系SQL，不能凭目录提示推断跨目录发行。
          const candidates = statement(`${projection.replace('source_full AS (SELECT', 'source_full AS MATERIALIZED(SELECT')}
            SELECT c.root_id,mb_album_parent(c.relative) directory,
              max(EXISTS(SELECT 1 FROM local_catalog_edition_tracks l WHERE l.track_id=c.id AND json_extract(l.data,'$.active')=1)) linked
            FROM candidates c WHERE mb_album_root(c.root_id)=1 AND (@root IS NULL OR c.root_id=@root)
              AND ${search.replaceAll('mobile_metadata.', 'c.')}
            GROUP BY c.root_id,mb_album_parent(c.relative) LIMIT 101 /* mb_album_mobile_search_candidates */`).all(params)
          if (candidates.length > 100 || candidates.some(row => Number(row.linked) !== 0)) return null
          const directories = new Set<string>()
          for (const row of candidates) {
            assertReadActive()
            if (typeof row.root_id !== 'string' || !roots.has(row.root_id)
              || typeof row.directory !== 'string' || !isLocalAlbumPrivateRelative(row.directory, true)) return unavailable()
            directories.add(groupIdentity(row.root_id, row.directory))
          }
          // 即使零命中，容量仍属于已通过同屏障完整核验的原scope，不用筛选后的0掩盖全局超限。
          readTotal('SELECT 0 total,@mobileGlobalTotal global_total', values)
          if (!directories.size) { code = 'SEARCH_DIRECTORY_FAST'; return { revision: scope.revision, total: 0, items: [] } }
          const rows: string[] = [], covered = new Set<string>()
          for (const raw of compact.groups.values()) {
            assertReadActive()
            const group = JSON.parse(raw) as Record<string, unknown>
            if (typeof group.physical_directory !== 'string' || Number(group.track_count) <= 0) continue
            const key = groupIdentity(String(group.root_id), group.physical_directory)
            if (!directories.has(key)) continue
            if (group.edition_id !== null || group.directory !== group.physical_directory) return null
            rows.push(raw); covered.add(key)
            if (rows.length > 100) return null
          }
          if (covered.size !== directories.size) return null
          const groups = statement(`${compactFactsSql()} SELECT g.* FROM group_facts g WHERE ${groupWhere} ORDER BY ${order}`)
            .all({ ...values, compactRows: `[${rows.join(',')}]` })
          const plans: Array<{ group: Record<string, unknown>; hint: NonNullable<ReturnType<typeof currentMemberHint>>;
            values: typeof params; count: number; start: number }> = []
          let total = 0
          for (const group of groups) {
            assertReadActive()
            const rootId = String(group.root_id), albumKey = String(group.album_key)
            const hint = currentMemberHint({ rootId, albumKey, offset: 0, limit: request.limit })
            if (!hint) return null
            const local = { ...params, ...rootBindings(rootId), rootId, albumKey,
              hintDirectory: hint.directory, hintPrefix: hint.directory + '/', hintUpper: hint.directory + '0', cuePayloads: hint.cuePayloads }
            // 完整目录CTE保留未匹配成员，故原trackCount、分组修订及扫描/CUE事件不因搜索而缩小。
            const countValues = { ...local, mobileGlobalTotal: compact.groups.size }
            const count = readTotal(`${directorySql(sql, hint.directory)} SELECT count(*) total,@mobileGlobalTotal global_total ${from}`, countValues)
            if (!Number.isSafeInteger(count) || count < 0 || count > Number(group.track_count) || !Number.isSafeInteger(total + count)) return unavailable()
            plans.push({ group, hint, values: local, count, start: total }); total += count
          }
          const items: MobileSqlRow[] = []
          for (const plan of plans) {
            const offset = Math.max(0, request.offset - plan.start)
            const limit = Math.min(plan.count - offset, request.offset + request.limit - plan.start - offset)
            if (limit <= 0) continue
            const selected = readMembers(directorySql(sql, plan.hint.directory), { ...plan.values, offset, limit })
            if (selected.length !== limit) return changed()
            for (const row of selected) {
              const item = projectMember(row), group = plan.group
              if (item.album.rootId !== group.root_id || item.album.id !== group.album_key || item.album.trackCount !== Number(group.track_count)
                || ('structureRevision' in item ? item.structureRevision : item.album.revision) !== group.revision
                || item.artworkSourceRevision !== group.artwork_source_revision) return changed()
              items.push(item)
            }
          }
          code = 'SEARCH_DIRECTORY_FAST'
          return { revision: scope.revision, total, items }
        }
        function directoryPage(): MobileSqlPage | null {
          // 只借已完成的同屏障全scope摘要，不为新请求另建完整曲目索引。
          const compact = params.query === '' ? cachedCompact(null) : null
          if (!compact) return null
          code = 'DIRECTORY_FAST'
          const values = { ...params, compactRows: `[${mobileRows(compact).join(',')}]`, mobileGlobalTotal: compact.groups.size }
          if (request.trackId !== null) {
            // 单曲地址只选候选组；完整当前摘要必须唯一定位，实际成员关系仍由原SQL证明。
            const selected = statement(`${compactFactsSql()} SELECT g.* FROM group_facts g WHERE ${groupWhere} LIMIT 2`).all(values)
            if (selected.length !== 1) return null
            const group = selected[0]!, rootId = String(group.root_id), albumKey = String(group.album_key)
            const hint = currentMemberHint({ rootId, albumKey, offset: request.offset, limit: request.limit })
            if (!hint) return null
            const targetSql = directorySql(sql, hint.directory), localValues = { ...values, ...rootBindings(rootId), rootId, albumKey,
              hintDirectory: hint.directory, hintPrefix: hint.directory + '/', hintUpper: hint.directory + '0', cuePayloads: hint.cuePayloads }
            // track_count不是过滤后的单曲总数；保留p.id和原groupWhere，并核完整scope的分组容量。
            const count = readTotal(`${targetSql} SELECT count(*) total,@mobileGlobalTotal global_total ${from}`, localValues)
            const items = readMembers(targetSql, localValues).map(row => {
              const item = projectMember(row)
              if (item.album.rootId !== rootId || item.album.id !== albumKey || item.album.trackCount !== Number(group.track_count)
                || ('structureRevision' in item ? item.structureRevision : item.album.revision) !== group.revision || item.artworkSourceRevision !== group.artwork_source_revision) return changed()
              return item
            })
            return { revision: scope.revision, total: count, items }
          }
          const ordered = mobileOrder(compact)
          const count = ordered ? ordered.offsets[ordered.offsets.length - 1]! : readTotal(`${compactFactsSql()} SELECT coalesce(sum(g.track_count),0) total,
            @mobileGlobalTotal global_total FROM group_facts g WHERE ${groupWhere}`, values)
          if (!Number.isSafeInteger(count) || count < 0) return unavailable()
          if (request.offset >= count) return { revision: scope.revision, total: count, items: [] }
          const selected: Record<string, unknown>[] = ordered ? ordered.keys.flatMap((identity, index) => {
            const start = ordered.offsets[index]!, end = ordered.offsets[index + 1]!
            if (end <= start || start >= Math.min(count, request.offset + request.limit) || end <= request.offset) return []
            const raw = compact.groups.get(identity); if (raw === undefined) return changed()
            return [{ ...JSON.parse(raw) as Record<string, unknown>, member_offset: start }]
          }) : statement(`${compactFactsSql()}, scoped_groups AS MATERIALIZED(SELECT g.* FROM group_facts g WHERE ${groupWhere}),
            ranked_groups AS MATERIALIZED(SELECT g.*,coalesce(sum(g.track_count) OVER(ORDER BY ${order}
              ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) member_offset FROM scoped_groups g)
            SELECT g.* FROM ranked_groups g WHERE g.track_count>0 AND g.member_offset<@pageEnd
              AND g.member_offset+g.track_count>@offset ORDER BY ${order}`).all({ ...values, pageEnd: Math.min(count, request.offset + request.limit) })
          const plans: DirectoryPlan[] = []
          for (const row of selected) {
            assertReadActive()
            const rootId = String(row.root_id), albumKey = String(row.album_key), size = Number(row.track_count), start = Number(row.member_offset)
            if (!roots.has(rootId) || !Number.isSafeInteger(size) || size <= 0 || !Number.isSafeInteger(start) || start < 0) return unavailable()
            const offset = Math.max(0, request.offset - start), limit = Math.min(size - offset, request.offset + request.limit - start - offset)
            const hint = currentMemberHint({ rootId, albumKey, offset, limit })
            // 必须先证明全部待读组；任何一个不具备目录/CUE闭包就整页回原SQL。
            if (!hint) return null
            plans.push({ rootId, albumKey, offset, limit, hint, size, revision: row.revision, artworkRevision: row.artwork_source_revision })
          }
          const pageItems: MobileSqlRow[] = []
          const plannedRows = readPlanMembers(plans)
          let plannedOffset = 0
          for (let index = 0; index < plans.length; index++) {
            const plan = plans[index]!
            assertReadActive()
            const rows = plannedRows === null ? readMembers(directorySql(sql, plan.hint.directory), { ...params, ...rootBindings(plan.rootId),
              rootId: plan.rootId, albumKey: plan.albumKey, offset: plan.offset, limit: plan.limit,
              hintDirectory: plan.hint.directory, hintPrefix: plan.hint.directory + '/', hintUpper: plan.hint.directory + '0', cuePayloads: plan.hint.cuePayloads })
              : plannedRows.slice(plannedOffset, plannedOffset + plan.limit)
            if (rows.length !== plan.limit) return changed()
            for (let ordinal = 0; ordinal < rows.length; ordinal++) {
              const row = rows[ordinal]!
              if (plannedRows !== null && (row.plan_ordinal !== index || row.plan_position !== plan.offset + ordinal + 1)) return changed()
              const item = projectMember(row)
              if (item.album.rootId !== plan.rootId || item.album.id !== plan.albumKey || item.album.trackCount !== plan.size
                || ('structureRevision' in item ? item.structureRevision : item.album.revision) !== plan.revision || item.artworkSourceRevision !== plan.artworkRevision) return changed()
              pageItems.push(item)
            }
            plannedOffset += plan.limit
          }
          if (plannedRows !== null && plannedRows.length !== plannedOffset) return changed()
          return { revision: scope.revision, total: count, items: pageItems }
        }
        const selected = params.query === '' ? directoryPage() : searchDirectoryPage()
        if (selected) { code = params.query === '' ? 'DIRECTORY_FAST' : 'SEARCH_DIRECTORY_FAST'; total = selected.total; items = selected.items }
        else {
          code = 'FULL_FALLBACK'
          // 仅本条非空成员搜索物化Source字段，避免12个字段表达式重复跨入JS；不跨语句或请求缓存。
          const memberSql = params.query !== '' && source.sourceLookup
            ? sql.replace('source_full AS (SELECT', 'source_full AS MATERIALIZED(SELECT') : sql
          total = readTotal(`${memberSql} SELECT count(*) total,(SELECT count(*) FROM groups) global_total ${from}`)
          // count已核完整scope容量；零命中无需再物化同一份完整事实，首末读屏障仍由run核验。
          items = total === 0 ? [] : readMembers(memberSql, params).map(projectMember)
        }
      }
      if (!Number.isSafeInteger(total) || total < 0 || items.length !== Math.min(request.limit, Math.max(0, total - request.offset))) return unavailable()
      const page = { revision: scope.revision, total, items }
      if (exactKey !== null) {
        const bytes = Buffer.byteLength(exactKey) + Buffer.byteLength(JSON.stringify(page))
        if (bytes <= LOCAL_ALBUM_SQL_ENVELOPE_MAX_BYTES) {
          while (mobileExactPages.size && (mobileExactPages.size >= 32 || mobileExactBytes + bytes > LOCAL_ALBUM_SQL_ENVELOPE_MAX_BYTES)) {
            const key = mobileExactPages.keys().next().value!
            mobileExactBytes -= mobileExactPages.get(key)!.bytes; mobileExactPages.delete(key)
          }
          assertReadActive()
          mobileExactPages.set(exactKey, { page: structuredClone(page), bytes }); mobileExactBytes += bytes
        }
      }
      return page
    })
    observedTotal = result.total; observedCount = result.items.length; completed = true; return result
    } finally {
      logLibraryOperation('cache', metricAction, completed ? 'complete' : 'error', {
        code, elapsedMs: Math.max(0, performance.now() - started), ...(observedTotal === undefined ? {} : { total: observedTotal }),
        ...(observedCount === undefined ? {} : { count: observedCount }),
      })
    }
  }
  function queryAlbumIssues(request: dto.LocalAlbumTrackQuery, readOptions?: LocalAlbumSqlIssueReadOptions): LocalAlbumSqlIssuePage {
    return run(() => {
      if (!dto.isLocalAlbumTrackQuery(request)) return invalid()
      // 完整成员与问题使用同一已核物理目录/CUE闭包；未知范围仍走原全根SQL。
      const hint = readOptions?.buildDerivedIndex === false ? currentMemberHint(request) : null
      let snapshot = readOptions?.buildDerivedIndex === false ? cachedDerived() : null
      if (readOptions?.buildDerivedIndex !== false || snapshot) {
        find(request.albumKey, request.rootId, hint)
        if (readOptions?.buildDerivedIndex !== false) snapshot = derived()
      }
      if (snapshot) {
        const key = groupIdentity(request.rootId, request.albumKey), issues = snapshot.issues.get(key) ?? [], rejected = snapshot.rejected.get(key) ?? []
        return { total: issues.length, items: issues.slice(request.offset,request.offset+request.limit).map(item=>JSON.parse(String((JSON.parse(item.raw) as Record<string, unknown>).issue_json)) as LocalAlbumIssue),
          rejectedTotal: rejected.length, rejectedFiles: rejected.slice(request.offset,request.offset+request.limit).map(item=>{const raw=JSON.parse(item.raw) as Record<string, unknown>;return {relative:String(raw.relative),revision:String(raw.revision)}}) }
      }
      const targetSql = hint ? directorySql(sql, hint.directory) : sql
      const params = { ...rootBindings(request.rootId), hintDirectory: hint?.directory ?? null, hintPrefix: hint ? hint.directory + '/' : null,
        hintUpper: hint ? hint.directory + '0' : null, cuePayloads: hint?.cuePayloads ?? null, ...request }
      // 同一真实SELECT共享原全根CTE；目标、总数与两类有序页仍在本次完整前后屏障内核验。
      const row = statement(`${targetSql}, ${issuesCte}, ${rejectedCte},
        current_group AS MATERIALIZED(SELECT * FROM groups WHERE album_key=@albumKey AND root_id=@rootId),
        current_issues AS MATERIALIZED(SELECT category,ordinal,issue_json FROM issues WHERE album_key=@albumKey AND root_id=@rootId),
        current_rejected AS MATERIALIZED(SELECT relative,revision FROM rejected_files WHERE album_key=@albumKey AND root_id=@rootId),
        issue_page AS MATERIALIZED(SELECT category,ordinal,issue_json FROM current_issues ORDER BY category,ordinal,issue_json LIMIT @limit OFFSET @offset),
        rejected_page AS MATERIALIZED(SELECT relative,revision FROM current_rejected ORDER BY relative LIMIT @limit OFFSET @offset)
        SELECT g.*,(SELECT count(*) FROM current_issues) total,(SELECT count(*) FROM current_rejected) rejected_total,
          coalesce((SELECT json_group_array(json(issue_json) ORDER BY category,ordinal,issue_json) FROM issue_page),'[]') issues_json,
          coalesce((SELECT json_group_array(json_object('relative',relative,'revision',revision) ORDER BY relative) FROM rejected_page),'[]') rejected_json
        FROM current_group g /* mb_album_issues_page */`).get(params)
      if (!row) return changed()
      if (!opaque(row.artwork_source_revision)) return unavailable()
      summary(row)
      return { total: Number(row.total), items: JSON.parse(String(row.issues_json)) as LocalAlbumIssue[],
        rejectedTotal: Number(row.rejected_total), rejectedFiles: JSON.parse(String(row.rejected_json)) as LocalAlbumSqlIssuePage['rejectedFiles'] }
    })
  }
  function getArtworkContext(request: dto.LocalAlbumArtworkRequest): LocalAlbumArtworkReadContext {
    const started = performance.now(); let derivedHit: boolean | undefined, completed = false
    let cacheCode: 'NOT_CHECKED' | 'DERIVED_HIT' | 'DERIVED_MISS' | 'COMPACT_HIT' | 'DIRECTORY_HINT' | 'DIRECTORY_SEED' = 'NOT_CHECKED'
    try {
      const result = run(() => {
        if (!dto.isLocalAlbumArtworkRequest(request)) return invalid()
        if (!roots.has(request.rootId)) return changed()
        const snapshot = cachedDerived()
        let compact = snapshot ? null : cachedCompact(request.rootId)
        let hint = snapshot || compact ? null : currentHint(request), seeded = false
        if (!snapshot && !compact && !hint) { hint = coldArtworkHint(request); seeded = hint !== null }
        // 无法证明当前目录闭包时，持久发现已完成的冷读仍保原完整结构缓存与全根回退。
        // 每DB只有一个Compact槽，原预算内保全集供各根共用；超界仍按原完整SQL回退。
        if (!snapshot && !compact && !hint) compact = compactGroups(null)
        derivedHit = snapshot !== null || compact !== null
        cacheCode = snapshot ? 'DERIVED_HIT' : compact ? 'COMPACT_HIT' : 'DERIVED_MISS'
        let found: ReturnType<typeof find>, row: Record<string, unknown> | undefined
        if (snapshot) {
          if (!snapshot.groups.has(groupIdentity(request.rootId, request.albumKey))) return staleArtworkClaim()
          found = find(request.albumKey, request.rootId)
          if (found.album.revision !== request.revision || found.album.editionId !== request.editionId || found.album.representativeTrackId !== request.representativeTrackId) return staleArtworkClaim()
          // 公开代表成员保持原顺序；物理图源只从同组当前证据选取，再读原track/asset/扫描行。
          const artworkIndex = snapshot.members.get(groupIdentity(request.rootId,request.albumKey))?.findIndex(item => (JSON.parse(item.raw) as Record<string, unknown>).has_artwork === 1) ?? -1
          row = indexedRows(snapshot,request.albumKey,request.rootId,Math.max(0,artworkIndex),1)[0]
        } else if (compact) {
          const raw = compact.groups.get(groupIdentity(request.rootId, request.albumKey))
          if (!raw) return staleArtworkClaim()
          const group = JSON.parse(raw) as Record<string, unknown>
          const current = compactSql(compact, request.albumKey, request.rootId)
          const overlaid = statement(`${current.sql} SELECT * FROM groups`).get({ ...rootBindings(request.rootId), compactRows: current.compactRows })
          if (!overlaid) return changed()
          found = { album: summary(overlaid), directory: group.directory === null ? null : String(group.directory), artworkSourceRevision: String(group.artwork_source_revision) }
          if (found.album.revision !== request.revision || found.album.editionId !== request.editionId || found.album.representativeTrackId !== request.representativeTrackId) return staleArtworkClaim()
          if (group.artwork_index !== null) {
            const rows = indexedFactRows(JSON.stringify([group.artwork_index]), request.rootId)
            if (rows.length !== 1) return changed()
            row = rows[0]
          }
        } else {
          const targetSql = hint ? directorySql(sql, hint.directory) : sql
          if (hint) cacheCode = seeded ? 'DIRECTORY_SEED' : 'DIRECTORY_HINT'
          const selected = statement(`${targetSql}, current_group AS MATERIALIZED(SELECT * FROM groups WHERE album_key=@albumKey AND root_id=@rootId),
            page_members AS MATERIALIZED(SELECT * FROM members WHERE album_key=@albumKey AND root_id=@rootId ORDER BY has_artwork DESC,sequence LIMIT 1)
            SELECT json_object(${[...publicSummaryColumns,'directory','artwork_source_revision'].map(column=>`'${column}',g.${column}`).join(',')}) group_json,
              ${factColumns},${selectedRevision} selected_revision,${pageScan} scan_json
            FROM current_group g LEFT JOIN page_members p ON 1
            LEFT JOIN source_metadata m ON m.id=p.id LEFT JOIN local_catalog_tracks t ON t.id=p.id LEFT JOIN local_catalog_assets a ON a.id=t.asset_id
            LEFT JOIN local_catalog_edition_tracks l ON l.id=p.relation_id ${selection}`).get({ ...rootBindings(request.rootId), hintDirectory: hint?.directory ?? null,
              hintPrefix: hint ? hint.directory + '/' : null, hintUpper: hint ? hint.directory + '0' : null, cuePayloads: hint?.cuePayloads ?? null,
              albumKey: request.albumKey, rootId: request.rootId })
          if (!selected) return staleArtworkClaim()
          const group = JSON.parse(String(selected.group_json)) as Record<string, unknown>
          if (!opaque(group.artwork_source_revision)) return unavailable()
          found = { album: summary(group), directory: group.directory === null ? null : String(group.directory), artworkSourceRevision: group.artwork_source_revision }
          row = selected.id === null ? undefined : selected
        }
        if (found.album.revision !== request.revision || found.album.editionId !== request.editionId || found.album.representativeTrackId !== request.representativeTrackId) return staleArtworkClaim()
        return { ...found, representative: row ? makeFact(row, row.selected_revision === null ? null : String(row.selected_revision), row.scan_json === null ? null : String(row.scan_json)) : null }
      })
      completed = true; return result
    } finally {
      logLibraryOperation('cache', 'albums.artwork-context', completed ? derivedHit ? 'hit' : 'miss' : 'error', {
        code: cacheCode, elapsedMs: performance.now() - started,
      })
    }
  }
  const reader = { queryAlbums, queryBackgroundCandidates, queryAlbumMembers, queryMobile, queryAlbumIssues, getArtworkContext, sourceMemberIdentity }
  installedAuthors.set(db, { author: initialAuthor, scope: initialScope, inventory: scope.lyricsInventory, artworkInventory: scope.artworkInventory })
  currentReaders.set(db, reader)
  return reader
}
