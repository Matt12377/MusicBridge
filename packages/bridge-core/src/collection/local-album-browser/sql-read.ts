import { createHash, type Hash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { captureLocalAlbumContext, localAlbumPhase, emitLocalAlbumNodeTrace } from '../../shared/local-album-read-trace-node.js'
import type { LocalAlbumTraceStage } from '../../shared/library-read-trace.js'
import { classifyDirectoryName } from '../../library/local-name-rules.js'
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import * as dto from '@music-bridge/contracts'
import { isLocalAlbumPrivateRelative, LocalAlbumReadError } from './grouping.js'
import { LOCAL_ALBUM_SQL_ENVELOPE_MAX_BYTES, LOCAL_ALBUM_SQL_DERIVED_MAX_BYTES, LOCAL_ALBUM_SQL_DERIVED_ALLOCATION_BYTES, LOCAL_ALBUM_SQL_DERIVED_MAX_ITEMS, type LocalAlbumSqlCodec, type LocalAlbumSqlScope, type LocalAlbumSqlSource, type LocalAlbumSqlMemberPage, type LocalAlbumSqlIssuePage, type LocalAlbumSqlIssueReadOptions, type LocalAlbumSqlPageEnvelope, type LocalAlbumSqlMobileQuery, type LocalAlbumSqlMobileRow, type LocalAlbumSqlMobilePage } from './sql-types.js'
import type { LocalAlbumArtworkReadContext, LocalAlbumGroupMember, LocalAlbumIssue, LocalAlbumTrackFact } from './types.js'

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const invalid = (): never => { throw new LocalAlbumReadError('INVALID_REQUEST', '本地专辑请求无效，请重新选择。') }
const unavailable = (): never => { throw new LocalAlbumReadError('UNAVAILABLE', '本地专辑事实暂时无法读取，请重试。') }
const changed = (): never => { throw new LocalAlbumReadError('SNAPSHOT_CHANGED', '音乐库或来源信息已变化，请重新读取。') }
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
const fields = ['title', 'artist', 'album', 'year', 'disc', 'track'] as const
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
interface DerivedEntry { barrier: string; inventory: LocalAlbumSqlScope['lyricsInventory']; artworkInventory: LocalAlbumSqlScope['artworkInventory']; snapshot: DerivedSnapshot | null }
const derivedSnapshots = new WeakMap<DatabaseSync, DerivedEntry>()
const currentReaders = new WeakMap<DatabaseSync, object>()
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
  if (!closed(scope, ['revision', 'roots'], ['nameEnhancements', 'artworkObservations', 'artworkInventory', 'lyricsInventory', 'libraryOrganizations']) || !opaque(scope.revision) || !dense(scope.roots, 100) || !scope.roots.every(dto.isLocalRootView) || new Set(scope.roots.map(view => view.root.id)).size !== scope.roots.length) return unavailable()
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
export function createLocalAlbumSqlReader(db: DatabaseSync, source: LocalAlbumSqlSource, codec: LocalAlbumSqlCodec, scope: LocalAlbumSqlScope) {
  localAlbumSqlScopeFingerprint(scope)
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
  const install = (name: string, action: (...args: SQLOutputValue[]) => string | number | null): void => { db.function(name, { deterministic: true }, action) }
  install('mb_album_root', value => typeof value === 'string' && roots.has(value) ? 1 : 0)
  install('mb_album_root_view', value => JSON.stringify(roots.get(String(value)) ?? null))
  install('mb_album_root_label', value => roots.get(String(value))?.label ?? '本地来源')
  install('mb_album_online', value => roots.get(String(value))?.availability === 'ONLINE' ? 1 : 0)
  install('mb_album_artwork_state', (albumKey, rootId) => {
    if (typeof albumKey !== 'string' || typeof rootId !== 'string' || !roots.has(rootId)) return unavailable()
    const value = scope.artworkInventory?.read(albumKey, rootId) ?? 'unknown'
    if (!['available', 'missing', 'unknown'].includes(value)) return unavailable()
    return roots.get(rootId)?.availability === 'ONLINE' && value !== 'unknown' ? value : null
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
  install('mb_album_key', (rootId, editionId, directory, rawAlbum, versions) => {
    if(editionId!==null)return `edition-${hash([rootId,editionId])}`
    const role=organizations.get(String(rootId))?.role
    if(role==='artist'||role==='album')return `directory-${hash([rootId,directory,'',[]])}`
    return `directory-${hash([rootId,directory,directory===''?'':String(rawAlbum??'').trim(),directory===''?[]:JSON.parse(String(versions))])}`
  })
  install('mb_album_digest', value => hash(JSON.parse(String(value))))
  install('mb_album_group_hash', (rootId, albumKey) => typeof rootId === 'string' && roots.has(rootId) && opaque(albumKey) ? hash([rootId, albumKey]) : unavailable())
  // 输入只由固定SQL的json_object/json_array构造；按完整编码字节分层hash，不生成全库JS对象。
  install('mb_album_fact_digest', value => createHash('sha256').update(String(value)).digest('hex'))
  install('mb_album_match', (title, artists, year, version, label, query) => [title, ...JSON.parse(String(artists)), year ?? '', version ?? '', label].join(' ').toLocaleLowerCase('zh').includes(String(query).toLocaleLowerCase('zh')) ? 1 : 0)
  install('mb_album_scan', (rootId, relative) => cached(JSON.stringify(['scan', rootId, relative]), () => { const state = codec.scanState(String(rootId), String(relative)); return JSON.stringify(state ? { rootId: state.libraryRootId, relative: state.relative, outcome: state.outcome, assetId: state.assetId, trackId: state.trackId, embedded: !!state.readFacts?.coverEvidence.length, revision: hash([state.signature, state.parserVersion, state.failureCode, state.readFacts?.coverEvidence ?? []]), signature: state.signature, metadataFailed: state.failureCode === 'PARSE_FAILED' } : null) }))
  install('mb_album_cue', raw => cached(JSON.stringify(['cue', raw]), () => {
    const cue = codec.cue(raw), result = cue.item.result; let current = cue.item.outcome === 'accepted' && result !== null
    if (current) for (const item of result!.tracks) { const ref = item.assetReference, root = roots.get(ref.libraryRootId)?.root, row = db.prepare('SELECT * FROM local_catalog_assets WHERE id=?').get(ref.assetId), scan = codec.scanState(ref.libraryRootId, ref.relative), asset = row ? codec.asset(row) : null
      if (!root || !asset || root.id !== cue.libraryRootId || ref.sourceRootId !== cue.sourceRootId || root.sourceRootId !== ref.sourceRootId || root.revision !== ref.rootRevision || row!.relative !== ref.relative || asset.fileRevision !== ref.fileRevision || asset.locationRevision !== ref.locationRevision || scan?.signature !== ref.signature) current = false }
    const ids = result?.tracks.map(item => item.assetReference.assetId) ?? []
    return JSON.stringify({ rootId: cue.libraryRootId, directory: parent(cue.item.relative), relative: cue.item.relative, revision: hash(cue), status: cue.item.outcome === 'rejected' ? 'failed' : current ? 'ready' : 'unresolved', audioAssetIds: [...new Set(ids)], alreadySplit: current && ids.length > 0 && new Set(ids).size === ids.length })
  }))
  const makeFact = (row: Record<string, unknown>, selected: string | null, scanning: string | null): LocalAlbumTrackFact => {
    // 原64KiB行预算只计原投影；聚合键、hash输入等派生重复项不能压缩合法原字段域。
    const sourceRow = Object.fromEntries(sourceColumns.map(column => [column,row[column]]))
    codec.boundedRow(sourceRow); const rawMetadata: dto.LocalMetadata = {}, metadata: dto.LocalMetadata = {}
    for (const field of fields) { if (typeof row[`raw_${field}`] === 'string') rawMetadata[field] = row[`raw_${field}`] as string; if (typeof row[`effective_${field}`] === 'string') metadata[field] = row[`effective_${field}`] as string }
    const track = codec.track(sourceRow), asset = codec.asset({ id: row.asset_record_id, root_id: row.root_id, source_root_id: row.source_root_id, relative: row.relative, sha256: row.sha256, data: row.asset_data })
    const summary = { track, asset, metadata, versionTokens: codec.versionTokens(rawMetadata) }, scan = scanning ? JSON.parse(scanning) as { outcome: string; assetId: string; trackId: string; embedded: boolean; revision: string } | null : null
    const embedded = scan?.outcome === 'accepted' && scan.assetId === asset.id && scan.trackId === track.id && scan.embedded, available = selected !== null || !!embedded
    if (!dto.isLocalLibraryTrackSummary(summary) || !dto.isLocalMetadata(rawMetadata) || !isLocalAlbumPrivateRelative(row.relative)) return unavailable()
    return { relative: row.relative, summary, rawMetadata, hasArtwork: available, artworkRevision: available ? hash([selected, embedded ? scan!.revision : null]) : null, artworkState: available ? 'available' : 'unknown' }
  }
  function aggregate(name: string, type: 'hash' | 'artists' | 'consensus' | 'versions'): void {
    db.aggregate<number>(name, { start() { const key = ++serial; aggregates.set(key, type === 'hash' ? { hash: createHash('sha256') } : { values: [] }); return key }, step(key, value) {
      const state = aggregates.get(key)!; if (type === 'hash') { if (value !== null) state.hash!.update(String(value)).update('\n'); return key }
      const values = type === 'versions' ? JSON.parse(String(value ?? '[]')) as string[] : typeof value === 'string' && value.trim() ? [value.trim()] : []
      if (!state.many) for (const item of values) if (!state.values!.includes(item)) { state.values!.push(item); if ((type === 'artists' && state.values!.length > 32) || (type === 'consensus' && state.values!.length > 1) || (type === 'versions' && state.values!.join(' · ').length > 512)) { state.many = true; state.values = []; break } }; return key
    }, result(key) { const state = aggregates.get(key)!; aggregates.delete(key); if (type === 'hash') return state.hash!.digest('hex'); if (type === 'artists') return JSON.stringify(state.many ? ['多位艺人'] : state.values); if (type === 'versions') return state.many ? '多个版本' : state.values!.join(' · ') || null; return state.many ? null : state.values![0] ?? null } })
  }
  aggregate('mb_album_hash', 'hash'); aggregate('mb_album_artists', 'artists'); aggregate('mb_album_consensus', 'consensus'); aggregate('mb_album_versions', 'versions')
  let projection = source.projectionSql
  // 每条guarded SQL只物化基础来源位置；完整字段仍由原raw/effective的COALESCE按需读取。
  if (source.sourceLookup) { install('mb_album_source_ordinal', value => source.sourceLookup!(String(value))?.ordinal ?? null); install('mb_album_source_fields', value => { const found = source.sourceLookup!(String(value)); return found ? JSON.stringify(found.fields) : null }); const end = projection.indexOf('),candidates AS ('); if (end < 0) return unavailable(); projection = `WITH source_marks AS MATERIALIZED(SELECT id,mb_album_source_ordinal(id) ordinal FROM local_catalog_tracks),source_full AS (SELECT id track_id,ordinal,mb_album_source_fields(id) fields FROM source_marks),candidates AS (` + projection.slice(end + '),candidates AS ('.length) }
  if(organized){if(!/^WITH\s/iu.test(projection))return unavailable();projection=projection.replace(/^WITH\s+(?:RECURSIVE\s+)?/iu,'WITH RECURSIVE ')}
  const packed = `json_object('id',t.id,'asset_id',t.asset_id,'data',t.data,'asset_record_id',a.id,'root_id',a.root_id,'source_root_id',a.source_root_id,'relative',a.relative,'sha256',a.sha256,'asset_data',a.data,${fields.flatMap(field => [`'raw_${field}',m.raw_${field}`, `'effective_${field}',m.effective_${field}`]).join(',')})`
  const factColumns = `t.id,t.asset_id,t.data,a.id asset_record_id,a.root_id,a.source_root_id,a.relative,a.sha256,a.data asset_data,${fields.flatMap(field => [`m.raw_${field}`, `m.effective_${field}`]).join(',')}`
  const selection = hasTable('local_artwork_selections') ? `LEFT JOIN local_artwork_selections art ON art.edition_id=l.edition_id AND json_extract(art.data,'$.candidate') IS NOT NULL` : `LEFT JOIN (SELECT NULL edition_id,NULL data) art ON 0`
  const selectedRevision = `CASE WHEN art.data IS NOT NULL THEN json_array(l.edition_id,json_extract(art.data,'$.revision')) ELSE NULL END`
  const scanFiles = hasTable('local_scan_file_state') ? `SELECT mb_album_scan(library_root_id,relative) payload FROM local_scan_file_state WHERE mb_album_root(library_root_id)=1` : `SELECT NULL payload WHERE 0`
  const scanFor = (rootId: string, relative: string, assetId: string): string => hasTable('local_scan_file_state') ? `CASE WHEN EXISTS(SELECT 1 FROM local_scan_file_state f WHERE f.library_root_id=${rootId} AND f.relative=${relative})
    OR EXISTS(SELECT 1 FROM local_scan_file_state f WHERE f.asset_id=${assetId}) THEN mb_album_scan(${rootId},${relative}) ELSE NULL END` : `NULL`
  const memberScan = scanFor('s.root_id', 's.relative', 's.asset_record_id'), pageScan = scanFor('a.root_id', 'a.relative', 'a.id')
  const cues = hasTable('local_cue_sources') ? `SELECT mb_album_cue(data) payload FROM local_cue_sources WHERE rowid IN(SELECT max(rowid) FROM local_cue_sources GROUP BY library_root_id,relative) AND mb_album_root(library_root_id)=1` : `SELECT NULL payload WHERE 0`
  // 十二标签先按原投影计算一次；完整track/asset与字段编码只进入digest，不穿过成员排序。
  // 详情再按当页真实ID取同一标签屏障和原行，不能用卡片汇总代替原facts。
  // 扫描证据按基础来源身份在关系展开前计算；窄行保留原resolver及完整payload。
  // 每个真实关系只计算一次分组键；三列屏障保留无关系行及全部活动关系，不提前分页。
  const sourceRowsSql = organized ? `source_audio AS MATERIALIZED(SELECT t.id,a.id asset_record_id,a.root_id,a.relative,mb_album_parent(a.relative) physical_directory,mb_album_sort(a.relative) sort_relative,
      m.raw_album,m.effective_artist,m.effective_album,m.effective_year,mb_album_version(m.raw_title,m.raw_artist,m.raw_album) versions,
      mb_album_ordinal(m.effective_disc) source_disc,mb_album_ordinal(m.effective_track) source_track,mb_album_named(a.relative) track_named_audio,
      mb_album_lyrics(t.id,a.root_id,json_extract(a.data,'$.fileRevision')) lyrics_presence,
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
      mb_album_lyrics(t.id,a.root_id,json_extract(a.data,'$.fileRevision')) lyrics_presence,
      mb_album_fact_digest(${packed}) source_digest FROM source_metadata m JOIN local_catalog_tracks t ON t.id=m.id JOIN local_catalog_assets a ON a.id=t.asset_id)`
  const eventDirectory = (root:string,directory:string):string => organized
    ? `CASE WHEN mb_album_organization(${root})='album' THEN '' WHEN mb_album_organization(${root})='artist' THEN coalesce((SELECT b.directory FROM organization_boundaries b WHERE b.root_id=${root} AND b.physical_directory=${directory}),mb_album_event_boundary(${root},${directory})) ELSE ${directory} END`
    : directory
  const sql = `${projection},
    source_metadata AS MATERIALIZED(SELECT c.id,${fields.flatMap(field => [`c.raw_${field}`, `c.effective_${field}`]).join(',')} FROM candidates c WHERE mb_album_root(c.root_id)=1),
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
    scan_files AS(${scanFiles}),
    rejected AS(SELECT json_extract(payload,'$.rootId') root_id,${eventDirectory("json_extract(payload,'$.rootId')","mb_album_parent(json_extract(payload,'$.relative'))")} directory,json_extract(payload,'$.relative') relative,json_extract(payload,'$.revision') revision,json_extract(payload,'$.metadataFailed') metadata_issue FROM scan_files WHERE json_extract(payload,'$.outcome')='rejected'),
    cue_facts AS(${cues}),
    cue_members AS(SELECT DISTINCT json_extract(c.payload,'$.rootId') root_id,${organized ? "CASE WHEN mb_album_organization(m.root_id) IN ('artist','album') THEN m.directory ELSE json_extract(c.payload,'$.directory') END" : "json_extract(c.payload,'$.directory')"} directory,m.album_key,c.payload FROM cue_facts c CROSS JOIN json_each(c.payload,'$.audioAssetIds') a CROSS JOIN members m WHERE m.root_id=json_extract(c.payload,'$.rootId') AND m.asset_record_id=a.value),
    cue_fallback AS(SELECT json_extract(c.payload,'$.rootId') root_id,${eventDirectory("json_extract(c.payload,'$.rootId')","json_extract(c.payload,'$.directory')")} directory,c.payload FROM cue_facts c WHERE NOT EXISTS(SELECT 1 FROM cue_members x WHERE x.payload=c.payload)),
    fallback_events AS(SELECT root_id,directory,revision,metadata_issue,0 cue_unsplit,0 name_failed,CASE WHEN metadata_issue THEN json_object('kind','metadata-read-failed','relative',relative) ELSE NULL END issue_json FROM rejected
      UNION ALL SELECT root_id,directory,json_extract(payload,'$.revision'),0,NOT json_extract(payload,'$.alreadySplit'),0,json_object('kind','cue','relative',json_extract(payload,'$.relative'),'status',json_extract(payload,'$.status')) FROM cue_fallback),
    directory_events AS(SELECT f.root_id,f.directory,CASE WHEN d.n=1 AND d.has_edition=0 THEN d.only_key ELSE mb_album_key(f.root_id,NULL,f.directory,'','[]') END album_key,f.revision,f.metadata_issue,f.cue_unsplit,f.name_failed,f.issue_json FROM fallback_events f LEFT JOIN directories d ON d.root_id=f.root_id AND d.directory=f.directory),
    names AS(SELECT json_extract(value,'$.rootId') root_id,${eventDirectory("json_extract(value,'$.rootId')","json_extract(value,'$.directory')")} directory,json_extract(value,'$.revision') revision FROM json_each(@names) WHERE json_extract(value,'$.state')='failed' AND mb_album_root(json_extract(value,'$.rootId'))=1),
    name_events AS(SELECT DISTINCT n.root_id,n.directory,m.album_key,n.revision,0 metadata_issue,0 cue_unsplit,1 name_failed,json_object('kind','name-enhancement-failed','revision',n.revision) issue_json FROM names n JOIN members m ON m.root_id=n.root_id AND m.directory=n.directory
      UNION ALL SELECT n.root_id,n.directory,mb_album_key(n.root_id,NULL,n.directory,'','[]'),n.revision,0,0,1,json_object('kind','name-enhancement-failed','revision',n.revision) FROM names n WHERE NOT EXISTS(SELECT 1 FROM members m WHERE m.root_id=n.root_id AND m.directory=n.directory)),
    events AS(SELECT * FROM directory_events UNION ALL SELECT root_id,directory,album_key,json_extract(payload,'$.revision'),0,NOT json_extract(payload,'$.alreadySplit'),0,json_object('kind','cue','relative',json_extract(payload,'$.relative'),'status',json_extract(payload,'$.status')) FROM cue_members UNION ALL SELECT * FROM name_events),
    seeds AS(SELECT album_key,root_id,edition_id,CASE WHEN edition_id IS NULL THEN directory ELSE NULL END directory,mb_album_trim(raw_album) raw_album FROM members UNION ALL SELECT album_key,root_id,NULL,directory,'' FROM events),
    identities AS(SELECT album_key,root_id,max(edition_id) edition_id,CASE WHEN max(edition_id) IS NOT NULL THEN NULL ELSE min(directory) END directory,max(raw_album) raw_album FROM seeds GROUP BY album_key),
    member_summary AS(SELECT album_key,count(*) track_count,count(DISTINCT id) distinct_tracks,mb_album_artists(effective_artist ORDER BY sequence) artists,mb_album_consensus(effective_album) album_title,mb_album_consensus(effective_year) year,mb_album_versions(versions ORDER BY sequence) version_label,max(has_artwork) has_artwork,max(track_named_audio) track_named_audio,min(lyrics_presence) lyrics_presence,
      min(CASE WHEN sequence=1 THEN id END) representative_track_id,mb_album_hash(member_digest ORDER BY sequence) fingerprint FROM members GROUP BY album_key),
    event_summary AS(SELECT album_key,max(metadata_issue) metadata_issue,max(cue_unsplit) cue_unsplit,max(name_failed) name_failed,mb_album_hash(json_array(directory,revision,metadata_issue,cue_unsplit,name_failed) ORDER BY directory,revision) fingerprint FROM events GROUP BY album_key),
    artwork_observations AS(SELECT json_extract(value,'$.albumKey') album_key,json_extract(value,'$.rootId') root_id,json_extract(value,'$.state') state,json_extract(value,'$.revision') revision FROM json_each(@artwork)),
    groups AS MATERIALIZED(SELECT i.*,coalesce(m.track_count,0) track_count,coalesce(m.distinct_tracks,0) distinct_tracks,CASE WHEN i.edition_id IS NULL AND mb_album_organization(i.root_id) IN ('artist','album') AND coalesce(m.artists,'[]')='[]' AND mb_album_artist_fallback(i.root_id)<>'' THEN json_array(mb_album_artist_fallback(i.root_id)) ELSE coalesce(m.artists,'[]') END artists,
      CASE WHEN i.edition_id IS NOT NULL THEN json_extract(ed.data,'$.title') WHEN mb_album_organization(i.root_id)='album' THEN coalesce(m.album_title,nullif(mb_album_root_name(i.root_id),''),'来源目录') WHEN i.directory='' THEN CASE WHEN coalesce(m.track_count,0)>0 THEN '散落音频' ELSE '根目录待处理记录' END ELSE coalesce(m.album_title,CASE WHEN mb_album_organization(i.root_id)='artist' THEN NULL ELSE nullif(i.raw_album,'') END,nullif(mb_album_basename(i.directory),''),'来源目录') END title,m.year,
      coalesce(nullif(json_extract(ed.data,'$.edition'),''),m.version_label) version_label,
      CASE WHEN coalesce(mb_album_artwork_state(i.album_key,i.root_id),o.state)='missing' THEN 0 WHEN coalesce(mb_album_artwork_state(i.album_key,i.root_id),o.state)='available' THEN 1 ELSE coalesce(m.has_artwork,0) END has_artwork,
      mb_album_online(i.root_id)=1 AND coalesce(mb_album_artwork_state(i.album_key,i.root_id),o.state)='missing' missing_artwork,coalesce(e.metadata_issue,0) metadata_issue,coalesce(e.cue_unsplit,0) cue_unsplit,coalesce(e.name_failed,0) name_failed,
      mb_album_digest(json_array(i.album_key,i.root_id,mb_album_root_view(i.root_id),json(ed.data),m.fingerprint,e.fingerprint,mb_album_organization_revision(i.root_id))) artwork_source_revision,
      i.directory='' AND coalesce(m.track_count,0)>0 AND coalesce(mb_album_organization(i.root_id),'')<>'album' loose_audio,coalesce(m.track_named_audio,0) track_named_audio,
      CASE WHEN mb_album_online(i.root_id)=1 THEN coalesce(m.lyrics_presence,0) ELSE 0 END lyrics_presence,
      mb_album_online(i.root_id)=1 AND coalesce(m.track_count,0)>0 AND m.lyrics_presence=1 missing_lyrics,
      m.representative_track_id,
      mb_album_digest(CASE WHEN mb_album_organization_revision(i.root_id) IS NULL THEN json_array(mb_album_root_view(i.root_id),json(ed.data),m.fingerprint,e.fingerprint,m.lyrics_presence,@lyricsRevision) ELSE json_array(mb_album_root_view(i.root_id),json(ed.data),m.fingerprint,e.fingerprint,m.lyrics_presence,@lyricsRevision,mb_album_organization_revision(i.root_id)) END) revision,
      mb_album_root_label(i.root_id) source_label,mb_album_online(i.root_id) online FROM identities i LEFT JOIN local_catalog_editions ed ON ed.id=i.edition_id LEFT JOIN member_summary m ON m.album_key=i.album_key LEFT JOIN event_summary e ON e.album_key=i.album_key
      LEFT JOIN artwork_observations o ON o.album_key=i.album_key AND o.root_id=i.root_id AND mb_album_online(i.root_id)=1)
  `
  const bindings = { sourceRaw: source.sourceRaw ?? '[]', root: null, names: JSON.stringify(names), artwork: JSON.stringify(observations), lyricsRevision: scope.lyricsInventory?.revision() ?? null }
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
  function readBarrier(): string {
    if (scopeFingerprint() !== initialScope) return changed()
    const lyricsRevision = scope.lyricsInventory?.revision() ?? null
    if (lyricsRevision !== null && !opaque(lyricsRevision)) return unavailable()
    bindings.lyricsRevision = lyricsRevision
    const changes = statement('SELECT total_changes() changes').get()?.changes
    const dataVersion = statement('PRAGMA data_version').get()?.data_version
    const schemaVersion = statement('PRAGMA schema_version').get()?.schema_version
    if (![changes, dataVersion, schemaVersion].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) return unavailable()
    return hash([initialScope, lyricsRevision, changes, dataVersion, schemaVersion, db.isTransaction])
  }
  let operationBarrier = ''
  function run<T>(action: () => T): T {
    noteSqlTiming('sql.run.enter', 'begin')
    try {
      operationBarrier = readBarrier()
      const saved = derivedSnapshots.get(db)
      if (saved && (saved.barrier !== operationBarrier || saved.inventory !== scope.lyricsInventory || saved.artworkInventory !== scope.artworkInventory)) derivedSnapshots.delete(db)
      const result = action()
      if (readBarrier() !== operationBarrier) { derivedSnapshots.delete(db); return changed() }
      return result
    } catch (error) { derivedSnapshots.delete(db); currentReaders.delete(db); statements.clear(); statementBytes = 0; if (error instanceof LocalAlbumReadError) throw error; return unavailable() }
    finally { aggregates.clear(); smallCache.clear(); smallBytes = 0; operationBarrier = '' }
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
    return previous?.barrier === operationBarrier && previous.inventory === scope.lyricsInventory && previous.artworkInventory === scope.artworkInventory ? previous.snapshot : null
  }
  function derived(): DerivedSnapshot | null {
    const previous = derivedSnapshots.get(db)
    if (previous?.barrier === operationBarrier && previous.inventory === scope.lyricsInventory && previous.artworkInventory === scope.artworkInventory) return previous.snapshot
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
    derivedSnapshots.set(db, { barrier: operationBarrier, inventory: scope.lyricsInventory, artworkInventory: scope.artworkInventory, snapshot })
    noteSqlTiming('sql.derived', 'ok')
    return snapshot
  }
  function find(albumKey: string, rootId: string): { album: dto.LocalAlbumSummary; directory: string | null; artworkSourceRevision: string } {
    const snapshot = cachedDerived(), raw = snapshot?.groups.get(groupIdentity(rootId, albumKey))
    const row = snapshot ? raw ? JSON.parse(raw) as Record<string, unknown> : undefined
      : statement(`${sql} SELECT * FROM groups WHERE album_key=@albumKey AND root_id=@rootId`).get({ ...bindings, albumKey, rootId })
    if (!row) return changed()
    if (!opaque(row.artwork_source_revision)) return unavailable()
    return { album: summary(row), directory: row.directory === null ? null : String(row.directory), artworkSourceRevision: String(row.artwork_source_revision) }
  }
  function indexedRows(snapshot: DerivedSnapshot, albumKey: string, rootId: string, offset: number, limit: number): Record<string, unknown>[] {
    const memberPage = `[${(snapshot.members.get(groupIdentity(rootId,albumKey)) ?? []).slice(offset,offset+limit).map(item=>item.raw).join(',')}]`
    // 原Source字段仅对实际索引页ID求值；其余原tag/asset/关系/扫描解码仍由当前SQLite行提供。
    const pageProjection = source.sourceLookup ? projection.replace('SELECT id,mb_album_source_ordinal(id) ordinal FROM local_catalog_tracks)',
      "SELECT id,mb_album_source_ordinal(id) ordinal FROM local_catalog_tracks WHERE id IN(SELECT json_extract(value,'$.id') FROM json_each(@memberPage)))") : projection
    const text = `${pageProjection}, source_metadata AS(SELECT c.id,${fields.flatMap(field=>[`c.raw_${field}`,`c.effective_${field}`]).join(',')} FROM candidates c),
      page_members AS MATERIALIZED(SELECT ${memberIndexColumns.map(column=>`json_extract(value,'$.${column}') ${column}`).join(',')} FROM json_each(@memberPage))
      SELECT ${factColumns},${selectedRevision} selected_revision,${pageScan} scan_json,p.directory,l.data relation_data,p.disc,p.track_number,p.sequence,p.cue_member${organized ? ',p.name_failed_member' : ''}
      FROM page_members p ${pageFactJoins} ORDER BY p.sequence`
    const rows = statement(text).all({ ...bindings, memberPage })
    if (rows.length !== Math.min(limit,Math.max(0,(snapshot.members.get(groupIdentity(rootId,albumKey))?.length ?? 0)-offset))) return changed()
    return rows
  }
  function queryAlbums(request: dto.LocalAlbumQuery): dto.LocalAlbumPage {
    return run(() => { if (!dto.isLocalAlbumQuery(request) || request.rootId !== null && !roots.has(request.rootId)) return invalid()
      const where = `(@rootId IS NULL OR root_id=@rootId) AND mb_album_match(title,artists,year,version_label,source_label,@query)=1`, filter = request.filter === 'all' ? '1' : `${statusColumns[statuses.indexOf(request.filter)]}=1`
      // 完整groups只构造一次。先截当页，再投影公开卡片；不得聚合全groups或私有目录/资产JSON。
      const row = statement(`${sql}, scoped AS MATERIALIZED(SELECT * FROM groups WHERE ${where}),
        counts AS(SELECT json_object('all',count(*),${statuses.map((status,index)=>`'${status}',coalesce(sum(${statusColumns[index]}),0)`).join(',')}) counts,
          coalesce(sum(CASE WHEN ${filter} THEN 1 ELSE 0 END),0) total FROM scoped),
        page_rows AS MATERIALIZED(SELECT ${publicSummaryColumns.join(',')} FROM scoped WHERE ${filter} ORDER BY mb_album_sort(title),album_key LIMIT @limit OFFSET @offset),
        page AS(SELECT mb_album_page_item(json_object(${publicSummaryColumns.map(column=>`'${column}',${column}`).join(',')})) item_json FROM page_rows)
        SELECT json_object('counts',json(counts),'total',total,'items',json(coalesce((SELECT json_group_array(json(item_json)) FROM page),'[]'))) envelope FROM counts`)
        .get({ ...bindings, rootId: request.rootId, query: request.query, limit: request.limit, offset: request.offset })
      if (!row || typeof row.envelope !== 'string') return unavailable()
      // 独立API包按精确UTF8字节在parse前拒绝，不能套用原64KiB源行预算或截断卡片。
      if (Buffer.byteLength(row.envelope, 'utf8') > LOCAL_ALBUM_SQL_ENVELOPE_MAX_BYTES) return limited()
      const parsed: unknown = JSON.parse(row.envelope)
      if (!closed(parsed, ['counts','total','items']) || !dense(parsed.items, request.limit)) return unavailable()
      const { total, counts, items } = parsed as unknown as LocalAlbumSqlPageEnvelope
      const result = { ...request, total, counts, hasMore: request.offset + items.length < total, items }; if (!dto.isLocalAlbumPage(result, request)) return unavailable(); return result
    })
  }
  function queryAlbumMembers(request: dto.LocalAlbumTrackQuery): LocalAlbumSqlMemberPage {
    return run(() => { if (!dto.isLocalAlbumTrackQuery(request)) return invalid(); const found = find(request.albumKey, request.rootId)
      const snapshot = cachedDerived()
      const rows = snapshot ? indexedRows(snapshot, request.albumKey, request.rootId, request.offset, request.limit) : statement(`${sql}, page_members AS MATERIALIZED(SELECT * FROM members WHERE album_key=@albumKey AND root_id=@rootId ORDER BY sequence LIMIT @limit OFFSET @offset)
        SELECT ${factColumns},${selectedRevision} selected_revision,${pageScan} scan_json,p.directory,l.data relation_data,p.disc,p.track_number,p.sequence,
          ${organized ? 'EXISTS(SELECT 1 FROM names n WHERE n.root_id=p.root_id AND n.directory=p.directory) name_failed_member,' : ''}
          EXISTS(SELECT 1 FROM cue_members c JOIN json_each(c.payload,'$.audioAssetIds') a WHERE c.album_key=p.album_key AND a.value=p.asset_record_id AND NOT json_extract(c.payload,'$.alreadySplit'))
          OR EXISTS(SELECT 1 FROM cue_fallback c LEFT JOIN directories d ON d.root_id=c.root_id AND d.directory=c.directory WHERE json_array_length(c.payload,'$.audioAssetIds')=0 AND NOT json_extract(c.payload,'$.alreadySplit')
            AND CASE WHEN d.n=1 AND d.has_edition=0 THEN d.only_key ELSE mb_album_key(c.root_id,NULL,c.directory,'','[]') END=p.album_key) cue_member FROM page_members p ${pageFactJoins} ORDER BY p.sequence`).all({ ...bindings, ...request })
      const items: LocalAlbumGroupMember[] = rows.map(row => { const fact = makeFact(row, row.selected_revision === null ? null : String(row.selected_revision), row.scan_json === null ? null : String(row.scan_json)), directory = String(row.directory)
        return { fact, editionLink: row.relation_data === null ? null : JSON.parse(String(row.relation_data)) as dto.AlbumEditionTrack, disc: row.disc === null ? null : Number(row.disc), trackNumber: row.track_number === null ? null : Number(row.track_number), sequence: Number(row.sequence), statuses: [...(fact.hasArtwork ? ['has-artwork' as const] : []), ...(Number(row.cue_member) === 1 && !fact.summary.track.segment ? ['cue-unsplit' as const] : []), ...((organized ? Number(row.name_failed_member) === 1 : names.some(item => item.state === 'failed' && item.rootId === request.rootId && item.directory === directory)) ? ['parse-failed' as const] : []), ...(found.directory === '' && organizations.get(request.rootId)?.role !== 'album' ? ['loose-audio' as const] : []), ...(/^track(?:\d+)?$/iu.test(basename(fact.relative).replace(/\.[^.]+$/u, '')) ? ['track-named-audio' as const] : [])] } })
      return { ...request, album: found.album, directory: found.directory, total: found.album.trackCount, hasMore: request.offset + items.length < found.album.trackCount, items }
    })
  }
  // 仅缓存活动曲目的精确SELECT结果；原run/readBarrier和完整scope每次仍校验。
  // 沿原2MiB信封上限约束全部条目，来源/SQL水位变化立即丢弃，不能替代业务目录。
  const mobileExactPages = new Map<string, { page: LocalAlbumSqlMobilePage; bytes: number }>()
  let mobileExactBarrier = '', mobileExactBytes = 0
  /** 手机目录只分页原groups/members，不创建第二份目录或主动构造全库派生缓存。 */
  function queryMobile(request: LocalAlbumSqlMobileQuery): LocalAlbumSqlMobilePage {
    return run(() => {
      if (!closed(request, ['kind','offset','limit','query','rootId','albumKey','trackId','editionId','groupHash'])
        || !['groups','members'].includes(request.kind) || !Number.isSafeInteger(request.offset) || request.offset < 0
        || !Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100
        || !dto.isLocalCatalogText(request.query, true) || [...request.query].length > 200
        || request.rootId !== null && (!dto.isCollectionId(request.rootId) || !roots.has(request.rootId))
        || request.albumKey !== null && !opaque(request.albumKey) || request.trackId !== null && !dto.isCollectionId(request.trackId)
        || request.editionId !== null && !dto.isCollectionId(request.editionId)
        || request.groupHash !== null && (typeof request.groupHash !== 'string' || !/^[a-f0-9]{64}$/u.test(request.groupHash))) return invalid()
      if (mobileExactBarrier !== operationBarrier) { mobileExactPages.clear(); mobileExactBytes = 0; mobileExactBarrier = operationBarrier }
      const exact = request.offset === 0 && request.limit <= 2 && request.query === ''
        && (request.kind === 'members' && request.trackId !== null || request.kind === 'groups' && request.editionId !== null)
      const exactKey = exact ? JSON.stringify(request) : null, previous = exactKey === null ? undefined : mobileExactPages.get(exactKey)
      if (previous) return structuredClone(previous.page)
      const params = { ...bindings, ...request, query: request.query.trim() }
      const groupWhere = `(@rootId IS NULL OR g.root_id=@rootId) AND (@albumKey IS NULL OR g.album_key=@albumKey)
        AND (@editionId IS NULL OR g.edition_id=@editionId)
        AND (@groupHash IS NULL OR mb_album_group_hash(g.root_id,g.album_key)=@groupHash)`
      const order = 'mb_album_sort(g.title),g.album_key'
      const groupColumns = [...publicSummaryColumns, 'directory', 'artwork_source_revision']
      const groupJson = `json_object(${groupColumns.map(column => `'${column}',g.${column}`).join(',')})`
      const projectGroup = (row: Record<string, unknown>): LocalAlbumSqlMobileRow => {
        const album = summary(row)
        if (!roots.has(album.rootId) || row.root_id !== album.rootId || row.album_key !== album.id
          || typeof row.artwork_source_revision !== 'string' || !/^[a-f0-9]{64}$/u.test(row.artwork_source_revision)) return unavailable()
        return { album, groupHash: hash([album.rootId, album.id]), artworkSourceRevision: row.artwork_source_revision, member: null }
      }
      let total: number, items: LocalAlbumSqlMobileRow[]
      if (request.kind === 'groups') {
        const where = `${groupWhere} AND mb_album_match(g.title,g.artists,g.year,g.version_label,g.source_label,@query)=1
          AND (@trackId IS NULL OR EXISTS(SELECT 1 FROM members p WHERE p.root_id=g.root_id AND p.album_key=g.album_key AND p.id=@trackId))`
        total = Number(statement(`${sql} SELECT count(*) total FROM groups g WHERE ${where}`).get(params)?.total)
        items = statement(`${sql} SELECT g.* FROM groups g WHERE ${where} ORDER BY ${order} LIMIT @limit OFFSET @offset`).all(params).map(projectGroup)
      } else {
        // 保留原移动曲目完整搜索域；不从标题另建分组或提前裁剪真实成员关系。
        const search = `(@query='' OR ${['title','artist','album','year'].flatMap(field => [`instr(lower(coalesce(mobile_metadata.raw_${field},'')),lower(@query))>0`, `instr(lower(coalesce(mobile_metadata.effective_${field},'')),lower(@query))>0`]).join(' OR ')}
          OR EXISTS(SELECT 1 FROM local_catalog_edition_tracks search_link JOIN local_catalog_editions search_edition ON search_edition.id=search_link.edition_id
            WHERE search_link.track_id=mobile_metadata.id AND json_extract(search_link.data,'$.active')=1
              AND (instr(lower(json_extract(search_edition.data,'$.title')),lower(@query))>0 OR instr(lower(json_extract(search_edition.data,'$.edition')),lower(@query))>0)))`
        const from = `FROM members p JOIN groups g ON g.root_id=p.root_id AND g.album_key=p.album_key
          JOIN source_metadata mobile_metadata ON mobile_metadata.id=p.id WHERE ${groupWhere} AND (@trackId IS NULL OR p.id=@trackId) AND ${search}`
        total = Number(statement(`${sql} SELECT count(*) total ${from}`).get(params)?.total)
        const rows = statement(`${sql}, page_members AS MATERIALIZED(SELECT p.*,${groupJson} album_json ${from}
          ORDER BY ${order},p.sequence,p.id LIMIT @limit OFFSET @offset)
          SELECT ${factColumns},${selectedRevision} selected_revision,${pageScan} scan_json,p.directory,l.data relation_data,
            p.root_id member_root_id,p.album_key member_album_key,p.id member_track_id,p.asset_record_id member_asset_id,
            p.disc,p.track_number,p.sequence,p.album_json,(${cueMember}) cue_member${organized ? ',EXISTS(SELECT 1 FROM names n WHERE n.root_id=p.root_id AND n.directory=p.directory) name_failed_member' : ''}
          FROM page_members p ${pageFactJoins}
          ORDER BY mb_album_sort(json_extract(p.album_json,'$.title')),p.album_key,p.sequence,p.id`).all(params)
        items = rows.map(row => {
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
        })
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
          mobileExactPages.set(exactKey, { page: structuredClone(page), bytes }); mobileExactBytes += bytes
        }
      }
      return page
    })
  }
  function queryAlbumIssues(request: dto.LocalAlbumTrackQuery, readOptions?: LocalAlbumSqlIssueReadOptions): LocalAlbumSqlIssuePage {
    return run(() => {
      if (!dto.isLocalAlbumTrackQuery(request)) return invalid()
      find(request.albumKey, request.rootId)
      const snapshot = readOptions?.buildDerivedIndex === false ? cachedDerived() : derived()
      if (snapshot) {
        const key = groupIdentity(request.rootId, request.albumKey), issues = snapshot.issues.get(key) ?? [], rejected = snapshot.rejected.get(key) ?? []
        return { total: issues.length, items: issues.slice(request.offset,request.offset+request.limit).map(item=>JSON.parse(String((JSON.parse(item.raw) as Record<string, unknown>).issue_json)) as LocalAlbumIssue),
          rejectedTotal: rejected.length, rejectedFiles: rejected.slice(request.offset,request.offset+request.limit).map(item=>{const raw=JSON.parse(item.raw) as Record<string, unknown>;return {relative:String(raw.relative),revision:String(raw.revision)}}) }
      }
      const rowsSql = `${sql}, issues AS(SELECT p.album_key,p.root_id,0 category,p.sequence ordinal,json_object('kind','missing-metadata','trackId',p.id,'fields',json(mb_album_missing(m.raw_title,m.raw_artist,m.raw_album))) issue_json
        FROM members p JOIN source_metadata m ON m.id=p.id WHERE json_array_length(mb_album_missing(m.raw_title,m.raw_artist,m.raw_album))>0 UNION ALL SELECT album_key,root_id,1,0,issue_json FROM events WHERE issue_json IS NOT NULL)`
      const params = { ...bindings, ...request }, total = Number(statement(`${rowsSql} SELECT count(*) total FROM issues WHERE album_key=@albumKey AND root_id=@rootId`).get(params)!.total)
      const items = statement(`${rowsSql} SELECT issue_json FROM issues WHERE album_key=@albumKey AND root_id=@rootId ORDER BY category,ordinal,issue_json LIMIT @limit OFFSET @offset`).all(params).map(row => JSON.parse(String(row.issue_json)) as LocalAlbumIssue)
      const rejectedSql = `${sql}, rejected_files AS(SELECT r.*,CASE WHEN d.n=1 AND d.has_edition=0 THEN d.only_key ELSE mb_album_key(r.root_id,NULL,r.directory,'','[]') END album_key FROM rejected r LEFT JOIN directories d ON d.root_id=r.root_id AND d.directory=r.directory)`
      const rejectedTotal = Number(statement(`${rejectedSql} SELECT count(*) total FROM rejected_files WHERE album_key=@albumKey AND root_id=@rootId`).get(params)!.total)
      const rejectedFiles = statement(`${rejectedSql} SELECT relative,revision FROM rejected_files WHERE album_key=@albumKey AND root_id=@rootId ORDER BY relative LIMIT @limit OFFSET @offset`).all(params).map(row => ({ relative: String(row.relative), revision: String(row.revision) }))
      return { total, items, rejectedTotal, rejectedFiles }
    })
  }
  function getArtworkContext(request: dto.LocalAlbumArtworkRequest): LocalAlbumArtworkReadContext {
    return run(() => { if (!dto.isLocalAlbumArtworkRequest(request)) return invalid(); const found = find(request.albumKey, request.rootId); if (found.album.revision !== request.revision || found.album.editionId !== request.editionId || found.album.representativeTrackId !== request.representativeTrackId) return changed()
      const snapshot = cachedDerived()
      // 公开代表成员保持原顺序；物理图源只从同组当前证据选取，随后仍实读原track/asset/扫描行。
      const artworkIndex = snapshot?.members.get(groupIdentity(request.rootId,request.albumKey))?.findIndex(item => (JSON.parse(item.raw) as Record<string, unknown>).has_artwork === 1) ?? -1
      const row = snapshot ? indexedRows(snapshot,request.albumKey,request.rootId,Math.max(0,artworkIndex),1)[0] : statement(`${sql}, page_members AS MATERIALIZED(SELECT * FROM members WHERE album_key=@albumKey AND root_id=@rootId ORDER BY has_artwork DESC,sequence LIMIT 1)
        SELECT ${factColumns},${selectedRevision} selected_revision,${pageScan} scan_json FROM page_members p ${pageFactJoins}`).get({ ...bindings, albumKey: request.albumKey, rootId: request.rootId }); return { ...found, representative: row ? makeFact(row, row.selected_revision === null ? null : String(row.selected_revision), row.scan_json === null ? null : String(row.scan_json)) : null }
    })
  }
  const reader = { queryAlbums, queryAlbumMembers, queryMobile, queryAlbumIssues, getArtworkContext }
  currentReaders.set(db, reader)
  return reader
}
