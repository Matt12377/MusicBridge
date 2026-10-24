import type { DatasetIdentity } from '../../recording/dataset-identity.js'
import { logLibraryOperation, traceLibraryRemoval } from '../../shared/library-operation-log.js'
import { captureLocalLibraryManagementRecord, localLibraryManagementDigest,
  LOCAL_LIBRARY_MANAGEMENT_BYTES, LOCAL_LIBRARY_MANAGEMENT_RESOURCES,
  type LocalLibraryManagementBindingRecord, type LocalLibraryManagementOperationRecord,
  type LocalLibraryManagementOriginalOperation, type LocalLibraryManagementMutation,
  type LocalLibraryManagementCaptureRecord, type LocalLibraryManagementCapturedAlbum,
  type LocalLibraryManagementJobRecord, type LocalLibraryManagementJobItem,
  type LocalLibraryManagementJobAction, type LocalLibraryManagementStart,
  type LocalLibraryManagementStored, type LocalLibraryManagementWrite,
} from './owner-journal.js'
import { isLocalScanSettings, type LocalScanSettingsStore } from '../local-scan-settings.js'
import type { CompletedScanSnapshotView, CompletedScanSnapshotLoad } from '../local-scan-snapshot-view.js'
import type { LocalLyricsLibraryAuthor } from './lyrics-service.js'
import type { LocalLyricsLibraryCapture } from '../local-library-lyrics/types.js'

import { createHash, randomUUID } from 'node:crypto'
import { cleanArtistName, cleanAlbumName, classifyDirectoryName } from '../../library/local-name-rules.js'
import * as dto from '@music-bridge/contracts'
import type { LocalCatalogStore, LocalLibraryManagementFrozenAlbumSelection } from '../local-catalog-store.js'
import { isScanFileState, type LocalScanStore } from '../local-scan-store.js'
import type { ScanFileState } from '../local-scan-facts.js'
import { isLocalAlbumPrivateRelative } from '../local-album-browser/grouping.js'
import type { LocalAlbumGroup, LocalAlbumInspectRequest } from '../local-album-browser/types.js'

type WorkbenchCapturePhase = 'OWNER_REVISION' | 'TARGET_INSPECT' | 'GROUP_INSPECT' | 'GROUP_REUSED' | 'DIRECTORY_FACTS'
  | 'PROVENANCE' | 'MEMBER_FACTS' | 'ROOT_VERIFY' | 'ARTWORK' | 'SETTINGS' | 'READBACK_VERIFY' | 'REMEMBER_RESOLVE' | 'REMEMBER_COMMIT'
/** 捕获诊断只含固定阶段与耗时；不记录路径、名称、读取引用或异常正文。 */
function startWorkbenchCapturePhase(code: WorkbenchCapturePhase, count?: number): () => void {
  const started = performance.now(), metrics = { code, ...(count === undefined ? {} : { count }) }
  logLibraryOperation('library', 'workbench.capture.phase', 'start', metrics)
  return () => logLibraryOperation('library', 'workbench.capture.phase', 'complete', { ...metrics, elapsedMs: Math.max(0, performance.now() - started) })
}

function sourceSearchNames(capture:LocalWorkbenchAlbumCapture,directoryFallback?:{artist:string;title:string}):NonNullable<dto.LocalWorkbenchAlbumSnapshot['searchNames']>{
  const originalArtists=[...new Set(capture.members.map(member=>member.artist).filter((value):value is string=>value!==null&&!!value.trim()))];
  const originalTitles=[...new Set(capture.members.map(member=>member.album).filter((value):value is string=>value!==null&&!!value.trim()))];
  const original={artist:originalArtists.length===1?originalArtists[0]!:originalArtists.length===0?directoryFallback?.artist??'':'',
    title:originalTitles.length===1?originalTitles[0]!:originalTitles.length===0?directoryFallback?.title??capture.directoryName:capture.directoryName};
  return{original,cleaned:{artist:cleanArtistName(original.artist),title:cleanAlbumName(original.title,original.artist)}};
}
import type { LocalAlbumSqlCueStored } from '../local-album-browser/sql-types.js'
import type { CueOwnerAssetReference, CueReadResult } from '../../library/cue-text-reader.js'
import { createLocalNamePlanDraft, isLocalWorkbenchAlbumCapture, localNameModelPrompts, parseLocalNameProposal } from './name-proposal.js'
import { isLocalWorkbenchArtworkCapture, isLocalWorkbenchPlanCapture } from './plan-registry.js'
import {
  freezeLocalWorkbenchValue, isLocalWorkbenchDataRecord, isLocalWorkbenchDenseArray, LocalWorkbenchPlanError,
  type LocalNameProposal, type LocalNameProposalResult, type LocalWorkbenchAlbumCapture, type LocalWorkbenchMemberCapture,
  type LocalWorkbenchNameSource, type LocalWorkbenchPlanCapture, type LocalWorkbenchPlanDraft, type LocalWorkbenchArtworkCapture,
} from './types.js'

/** 仅由原扫描Owner同一guarded连接读取，不是Renderer给出的路径授权。 */
export interface LocalWorkbenchDirectoryFactsRequest {
  expectedRevision: string
  libraryRootId: string
  directories: readonly string[]
  maxFiles: number
  maxBytes: number
}
export interface LocalWorkbenchDirectoryFacts {
  revision: string
  files: readonly {
    jobId: string
    rootRevision: string
    sourceRootId: string
    /** 原currentFileState与当前catalog locator已共同核验，历史value.relative保持原样。 */
    currentRelative: string
    value: ScanFileState
  }[]
  cues: readonly LocalAlbumSqlCueStored[]
}
/** 只证明最新原override命令与当前字段；该操作本身不能证明human/AI作者。 */
export interface LocalWorkbenchMetadataProvenanceFact {
  trackId: string
  override: null | { commandId: string; revision: string; fields: dto.LocalMetadata }
}
export interface LocalWorkbenchReadContext { signal?: AbortSignal }
export interface LocalWorkbenchNamePreparation {
  preparationId: string
  backend: dto.LocalAiBackend
  systemPrompt: string
  userPrompt: string
}
export interface LocalWorkbenchResolvedReadCapture {
  datasetId: string
  datasetRevision: string
  capture: LocalWorkbenchAlbumCapture
  group: LocalAlbumGroup
  directoryFacts: LocalWorkbenchDirectoryFacts
  provenance: readonly LocalWorkbenchMetadataProvenanceFact[]
  availability: dto.LocalWorkbenchAlbumSnapshot['availability']
}
type CatalogReadPort = Pick<LocalCatalogStore, 'root' | 'track' | 'metadata' | 'privateAssetLocator'
  | 'privateAlbumBrowserRevision' | 'privateWorkbenchMetadataProvenance'> & Partial<Pick<LocalCatalogStore,'privateLibraryManagementRootAvailable'>>
type ScanReadPort = Pick<LocalScanStore, 'privateAlbumBrowserRevision' | 'privateWorkbenchDirectoryFacts'>
export interface LocalWorkbenchReadServiceOptions {
  datasetId: string
  repository: { localCatalog: CatalogReadPort; localScan: ScanReadPort }
  localAlbums: { inspectAlbum(request: LocalAlbumInspectRequest): LocalAlbumGroup | Promise<LocalAlbumGroup> }
  assertCurrent(): void
  /** 必须复用原来源作者实际ONLINE/OFFLINE投影，不能只看authorized。 */
  readRootViews(): Promise<readonly dto.LocalRootView[]>
  /** 真实同Owner durable journal证明的作者；缺失或无法证明时明确unknown。 */
  readOverrideAuthor?(fact: LocalWorkbenchMetadataProvenanceFact): LocalWorkbenchNameSource | Promise<LocalWorkbenchNameSource>
  /** 艺人与专辑分别回读原作者，保留未改字段的人工锁。 */
  readNameSources?(fact: LocalWorkbenchMetadataProvenanceFact): { artistName: LocalWorkbenchNameSource; albumName: LocalWorkbenchNameSource } | Promise<{ artistName: LocalWorkbenchNameSource; albumName: LocalWorkbenchNameSource }>
  readAuthorRevision?(): string
  readLibraryOrganizations?(): readonly import('../local-album-browser/sql-types.js').LocalAlbumLibraryOrganization[]
  readSettings?(): LocalWorkbenchSettings | Promise<LocalWorkbenchSettings>
  readCurrentArtwork?(group: Readonly<LocalAlbumGroup>, context: LocalWorkbenchReadContext): Promise<dto.LocalArtworkImage | null>
  now?: () => number
  makeReadToken?: () => string
  makePreparationId?: () => string
  ttlMs?: number
  maxCaptures?: number
  maxBytes?: number
}
type LocalWorkbenchSettings = NonNullable<dto.LocalWorkbenchReadback['settings']>
type Lease = LocalWorkbenchResolvedReadCapture & { expiresAt: number; bytes: number }
type Preparation = { lease: Lease; request: dto.LocalWorkbenchAiRequest; expiresAt: number }
const MAX_MEMBERS = 10000
const MAX_BYTES = 32 * 1024 * 1024
const hash = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex')
const parent = (relative: string): string => relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : ''
const basename = (relative: string): string => relative.slice(relative.lastIndexOf('/') + 1)
const sameIds = (left: readonly string[], right: readonly string[]): boolean => left.length === right.length
  && new Set(left).size === left.length && left.every(value => right.includes(value))
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, child]) => JSON.stringify(key) + ':' + canonical(child)).join(',') + '}'
  return JSON.stringify(value) ?? 'null'
}
const same = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right)
const changed = (): never => { throw new LocalWorkbenchPlanError('CHANGED', '专辑成员、来源定位或原字段已变化，请重新读取。') }
const invalid = (message = '整理读取没有完整、可信的原作者事实。'): never => { throw new LocalWorkbenchPlanError('INVALID_CAPTURE', message) }
const limit = (): never => invalid('明确选择的完整整理范围超过预算；本次未返回截断结果。')
function metadata(value: unknown): value is dto.LocalMetadata {
  return isLocalWorkbenchDataRecord(value, [], ['title', 'artist', 'album', 'disc', 'track', 'year', 'albumArtist', 'artists', 'albumArtists']) && dto.isLocalMetadata(value)
}
function validateDirectoryFacts(value: unknown, request: LocalWorkbenchDirectoryFactsRequest): value is LocalWorkbenchDirectoryFacts {
  if (!isLocalWorkbenchDataRecord(value, ['revision', 'files', 'cues']) || value.revision !== request.expectedRevision
    || !isLocalWorkbenchDenseArray(value.files, request.maxFiles) || !isLocalWorkbenchDenseArray(value.cues, request.maxFiles)
    || value.files.length + value.cues.length > request.maxFiles) return false
  const files = value.files
  if (!files.every(file => isLocalWorkbenchDataRecord(file, ['jobId', 'rootRevision', 'sourceRootId', 'currentRelative', 'value'])
    && [file.jobId, file.rootRevision, file.sourceRootId].every(dto.isLocalWorkbenchIdentity)
    && isLocalAlbumPrivateRelative(file.currentRelative) && request.directories.includes(parent(file.currentRelative))
    && isLocalWorkbenchDataRecord(file.value, ['libraryRootId', 'relative', 'signature', 'parserVersion', 'outcome', 'assetId', 'trackId', 'failureCode', 'readFacts'])
    && isScanFileState(file.value) && file.value.libraryRootId === request.libraryRootId)
    || new Set(files.map(file => (file as LocalWorkbenchDirectoryFacts['files'][number]).currentRelative)).size !== files.length) return false
  if (!value.cues.every(cue => isLocalWorkbenchDataRecord(cue, ['id', 'sidecarId', 'libraryRootId', 'sourceRootId', 'rootRevision', 'item'])
    && [cue.id, cue.sidecarId, cue.libraryRootId, cue.sourceRootId, cue.rootRevision].every(dto.isLocalWorkbenchIdentity)
    && cue.libraryRootId === request.libraryRootId && dto.isLocalCuePreparedItem(cue.item)
    && request.directories.includes(parent(cue.item.relative)))
    || new Set(value.cues.map(cue => (cue as LocalAlbumSqlCueStored).id)).size !== value.cues.length) return false
  return Buffer.byteLength(JSON.stringify(value), 'utf8') <= request.maxBytes
}
function validateProvenance(value: unknown, trackIds: readonly string[]): value is LocalWorkbenchMetadataProvenanceFact[] {
  return isLocalWorkbenchDenseArray(value, MAX_MEMBERS) && sameIds(value.map(item => isLocalWorkbenchDataRecord(item, ['trackId', 'override'])
    && dto.isLocalWorkbenchIdentity(item.trackId) ? item.trackId : ''), trackIds)
    && value.every(item => isLocalWorkbenchDataRecord(item, ['trackId', 'override']) && (item.override === null
      || isLocalWorkbenchDataRecord(item.override, ['commandId', 'revision', 'fields']) && dto.isLocalWorkbenchIdentity(item.override.commandId)
        && dto.isLocalWorkbenchIdentity(item.override.revision) && metadata(item.override.fields)))
}
function issueSummary(group: LocalAlbumGroup, capture: LocalWorkbenchAlbumCapture): string[] {
  const result: string[] = []
  const counts = new Map<string, number>()
  for (const issue of group.issues) counts.set(issue.kind, (counts.get(issue.kind) ?? 0) + 1)
  const rejected = capture.members.filter(member => member.scan?.failureCode !== null && member.scan !== undefined).length
  if (counts.get('missing-metadata')) result.push('原元数据缺字段：' + counts.get('missing-metadata') + ' 项。')
  if (rejected) result.push('音频元数据读取或格式问题：' + rejected + ' 个真实扫描文件；不计为名称 AI 失败。')
  if (counts.get('name-enhancement-failed')) result.push('原名称 AI 失败记录：' + counts.get('name-enhancement-failed') + ' 项。')
  if (capture.nameSources?.artistName === 'unknown' || capture.nameSources?.albumName === 'unknown') result.push('已有名称覆盖的原作者尚未确认；候选可查看，变化预览会阻断。')
  if (capture.manualLocks.artistName || capture.manualLocks.albumName) result.push('存在已证明的人工名称锁，预览将保留锁定字段。')
  if (!group.members.length) result.push('此目录没有成功音轨；仅捕获真实扫描文件事实，不建立代表音轨或发行。')
  return result
}
function nameSource(sources: readonly LocalWorkbenchNameSource[]): LocalWorkbenchNameSource {
  return sources.includes('manual') ? 'manual' : sources.includes('unknown') ? 'unknown' : sources.includes('workbench-ai') ? 'workbench-ai' : 'raw'
}

/** 仅模块内部实际Owner实例可注册/消费；序列化捕获不能签发源写许可。 */
// 仅标记本生产读取在最后守卫之后生成的递归冻结正文；不证明当前作者、权限或期限。
const unleasedAlbumBodies=new WeakSet<object>()
const frozenReadMembers=new WeakMap<object,(albumId:string,rootId:string)=>Promise<readonly {trackId:string;assetId:string}[]>>()
const frozenReadAuthors=new WeakMap<object,(original:Readonly<LocalWorkbenchResolvedReadCapture>,assertOriginal:()=>void,context:LocalWorkbenchReadContext)=>Promise<string>>()
function sameFrozenReadSource(original:Readonly<LocalWorkbenchResolvedReadCapture>,current:Readonly<LocalWorkbenchResolvedReadCapture>):boolean {
  const facts=(value:Readonly<LocalWorkbenchResolvedReadCapture>)=>{const {revision:_captureRevision,...capture}=value.capture
    const {revision:_summaryRevision,...summary}=value.group.summary
    const {revision:_scanRevision,...directoryFacts}=value.directoryFacts
    return {datasetId:value.datasetId,capture,group:{...value.group,summary},directoryFacts,provenance:value.provenance,availability:value.availability}}
  return same(facts(original),facts(current))
}

/** 真实原Owner读取/名称准备；只保存短期只读捕获，持久计划与执行仍由registry和受保护writer负责。 */
export function createLocalWorkbenchReadService(options: LocalWorkbenchReadServiceOptions) {
  if (!dto.isLocalWorkbenchIdentity(options.datasetId)) return invalid('整理工作库身份无效。')
  const catalog = options.repository.localCatalog, scan = options.repository.localScan
  const now = options.now ?? Date.now, ttlMs = options.ttlMs ?? 10 * 60_000, maxCaptures = options.maxCaptures ?? 512, maxBytes = options.maxBytes ?? MAX_BYTES
  const token = options.makeReadToken ?? randomUUID, preparationId = options.makePreparationId ?? randomUUID
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 30 * 60_000 || !Number.isSafeInteger(maxCaptures) || maxCaptures < 1 || maxCaptures > 512
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES) return invalid('整理只读捕获预算无效。')
  const frozenLeases = new Map<string, {original:Readonly<LocalWorkbenchResolvedReadCapture>;assertOriginal():void}>()
  const leases = new Map<string, Lease>(), preparations = new Map<string, Preparation>(), proposals = new Map<string, { lease: Lease; proposal: LocalNameProposal }>()
  let closed = false
  const check = (context: LocalWorkbenchReadContext = {}): void => {
    options.assertCurrent()
    if (closed) invalid('整理读取已结束，请重新打开。')
    if (context.signal?.aborted) throw new LocalWorkbenchPlanError('INVALID_REQUEST', '整理读取已取消，迟到结果不会进入候选。')
  }
  function ownerRevision(): string {
    check()
    const catalogRevision = catalog.privateAlbumBrowserRevision(), scanRevision = scan.privateAlbumBrowserRevision(), authorRevision = options.readAuthorRevision?.() ?? null
    if (![catalogRevision, scanRevision].every(dto.isLocalWorkbenchIdentity) || authorRevision !== null && !dto.isLocalWorkbenchIdentity(authorRevision)) return invalid()
    return hash([options.datasetId, catalogRevision, scanRevision, authorRevision])
  }
  /** 原始搜索名只回退同一实际组织目录事实，不借有效标签、人工/AI覆盖或edition标题。 */
  function readSearchNames(lease:Lease):NonNullable<dto.LocalWorkbenchAlbumSnapshot['searchNames']>{
    const organization=options.readLibraryOrganizations?.().find(value=>value.rootId===lease.capture.rootId);
    if(!organization||organization.role!=='artist'&&organization.role!=='album')return sourceSearchNames(lease.capture);
    const root=catalog.root(lease.capture.rootId);
    if(organization.datasetId!==options.datasetId||organization.sourceRootId!==root.sourceRootId||organization.rootRevision!==root.revision)return changed();
    const artist=organization.role==='album'||classifyDirectoryName(organization.rootName)==='album-container'?organization.parentName
      :organization.rootName.replace(/\s+\d+\s*[张張](?:\[[^\]]+\])?\s*$/u,'').trim();
    const title=organization.role==='album'?organization.rootName:lease.group.directory!==null?basename(lease.group.directory):'';
    return sourceSearchNames(lease.capture,{artist,title});
  }
  function prune(): void {
    const time = now()
    for (const [id, lease] of leases) if (lease.expiresAt <= time) { leases.delete(id); frozenLeases.delete(id) }
    for (const [id, preparation] of preparations) if (preparation.expiresAt <= time || !leases.has(preparation.lease.capture.readToken)) preparations.delete(id)
    for (const [id, proposal] of proposals) if (!leases.has(proposal.lease.capture.readToken)) proposals.delete(id)
  }
  async function captureAlbum(ref: dto.LocalWorkbenchAlbumRef, readToken: string, datasetRevision: string, context: LocalWorkbenchReadContext, inspectedGroup?:LocalAlbumGroup): Promise<Lease> {
    check(context)
    if (!ref.rootId || !dto.isLocalWorkbenchIdentity(readToken)) return invalid('专辑缺少原来源根或作者读取引用。')
    const finishInspect = startWorkbenchCapturePhase(inspectedGroup ? 'GROUP_REUSED' : 'GROUP_INSPECT')
    const group = inspectedGroup??await options.localAlbums.inspectAlbum({ albumKey: ref.albumId, rootId: ref.rootId })
    finishInspect()
    check(context)
    if (!dto.isLocalAlbumSummary(group.summary) || group.summary.id !== ref.albumId || group.summary.rootId !== ref.rootId
      || !isLocalWorkbenchDenseArray(group.members, MAX_MEMBERS) || !sameIds(group.members.map(member => member.fact.summary.track.id), ref.trackIds)
      || (ref.editionId ?? null) !== group.summary.editionId || group.directory !== null && !isLocalAlbumPrivateRelative(group.directory, true)) return changed()
    if(catalog.privateLibraryManagementRootAvailable?.(ref.rootId)===false)return changed()
    const root = catalog.root(ref.rootId)
    if (!dto.isLibraryRoot(root) || root.role !== 'library') return invalid()
    const organization=options.readLibraryOrganizations?.().find(value=>value.rootId===root.id)
    const structured=organization?.role==='artist'||organization?.role==='album'
    // 新组织边界可能横跨CD/格式子目录；仍从本次真实成员/拒收/CUE事实取原直接目录，不用祖先目录代替完整facts。
    const directories = [...new Set(structured ? [
      ...(group.directory !== null ? [group.directory] : []), ...group.members.map(member=>parent(member.fact.relative)),
      ...(group.rejectedFiles??[]).map(file=>parent(file.relative)),
      ...group.issues.flatMap(issue=>issue.kind==='cue'?[parent(issue.relative)]:[]),
    ] : group.directory !== null ? [group.directory] : group.members.map(member => parent(member.fact.relative)))]
    if (!directories.length || directories.length > 100) return limit()
    const finishDirectoryFacts = startWorkbenchCapturePhase('DIRECTORY_FACTS', directories.length)
    const request: LocalWorkbenchDirectoryFactsRequest = { expectedRevision: scan.privateAlbumBrowserRevision(), libraryRootId: root.id,
      directories, maxFiles: MAX_MEMBERS, maxBytes }
    const facts = scan.privateWorkbenchDirectoryFacts(request)
    if (!validateDirectoryFacts(facts, request) || facts.files.some(file => file.rootRevision !== root.revision || file.sourceRootId !== root.sourceRootId)) return invalid()
    finishDirectoryFacts()
    const byRelative = new Map(facts.files.map(file => [file.currentRelative, file]))
    const finishProvenance = startWorkbenchCapturePhase('PROVENANCE', group.members.length)
    const trackIds = group.members.map(member => member.fact.summary.track.id), provenance = catalog.privateWorkbenchMetadataProvenance(trackIds)
    if (!validateProvenance(provenance, trackIds)) return invalid('名称覆盖的原命令事实不完整，未准备模型输入。')
    finishProvenance()
    const byTrack = new Map(provenance.map(fact => [fact.trackId, fact])), artistSources: LocalWorkbenchNameSource[] = [], albumSources: LocalWorkbenchNameSource[] = []
    const members: LocalWorkbenchMemberCapture[] = [], includedRelatives = new Set<string>(), effectiveAlbums: string[] = [], effectiveArtists: string[] = []
    const finishMemberFacts = startWorkbenchCapturePhase('MEMBER_FACTS', group.members.length)
    for (const member of group.members) {
      check(context)
      const fact = member.fact, selected = catalog.track(fact.summary.track.id), located = catalog.privateAssetLocator(fact.summary.asset.id), view = catalog.metadata(selected.id)
      if (!same(selected, fact.summary.track) || !same(located.asset, fact.summary.asset) || located.relative !== fact.relative
        || located.asset.libraryRootId !== root.id || located.asset.sourceRootId !== root.sourceRootId || located.asset.rootRevision !== root.revision
        || !same(view.raw, fact.rawMetadata) || !same(view.effective, fact.summary.metadata)) return changed()
      const origin = byTrack.get(selected.id)!
      if (view.override === null ? origin.override !== null : origin.override === null || origin.override.revision !== view.override.revision || !same(origin.override.fields, view.override.fields)) return changed()
      let author: LocalWorkbenchNameSource = 'unknown'
      let fieldAuthors: { artistName: LocalWorkbenchNameSource; albumName: LocalWorkbenchNameSource } = { artistName: author, albumName: author }
      if (origin.override !== null && options.readNameSources) {
        fieldAuthors = await options.readNameSources(freezeLocalWorkbenchValue(structuredClone(origin)))
        check(context)
        if (!isLocalWorkbenchDataRecord(fieldAuthors, ['artistName', 'albumName'])
          || ![fieldAuthors.artistName, fieldAuthors.albumName].every(value => ['raw', 'manual', 'workbench-ai', 'unknown'].includes(value))
          || Object.hasOwn(view.override?.fields ?? {}, 'artist') && fieldAuthors.artistName === 'raw'
          || Object.hasOwn(view.override?.fields ?? {}, 'album') && fieldAuthors.albumName === 'raw') return invalid('名称覆盖的字段作者证明无效。')
      } else if (origin.override !== null && options.readOverrideAuthor) {
        author = await options.readOverrideAuthor(freezeLocalWorkbenchValue(structuredClone(origin)))
        check(context)
        if (!['manual', 'workbench-ai', 'unknown'].includes(author)) return invalid('名称覆盖作者证明无效。')
        fieldAuthors = { artistName: author, albumName: author }
      }
      artistSources.push(Object.hasOwn(view.override?.fields ?? {}, 'artist') ? fieldAuthors.artistName : 'raw')
      albumSources.push(Object.hasOwn(view.override?.fields ?? {}, 'album') ? fieldAuthors.albumName : 'raw')
      effectiveArtists.push(view.effective.artist ?? ''); effectiveAlbums.push(view.effective.album ?? '')
      const scanned = byRelative.get(located.relative)
      if (scanned?.value.outcome === 'accepted' && scanned.value.assetId !== located.asset.id) return changed()
      const scanFact = scanned ? { signature: scanned.value.signature, parserVersion: scanned.value.parserVersion,
        revision: hash(scanned), failureCode: scanned.value.failureCode } : undefined
      members.push({ trackId: selected.id, assetId: located.asset.id, fileName: basename(located.relative), title: view.raw.title ?? null,
        artist: view.raw.artist ?? null, album: view.raw.album ?? null, rootRevision: root.revision, fileRevision: located.asset.fileRevision,
        locationRevision: located.asset.locationRevision, metadataRevision: hash(view), ...(scanFact ? { scan: scanFact } : {}) })
      includedRelatives.add(located.relative)
    }
    finishMemberFacts()
    // 新inspect明确分配全部rejected；不能根据某类issue推断或随意扩大到同目录另一个专辑。
    const inspected = group as LocalAlbumGroup & { rejectedFiles?: readonly { relative: string; revision: string }[] }
    let rejectedRelatives: readonly string[]
    if (inspected.rejectedFiles !== undefined) {
      if (!isLocalWorkbenchDenseArray(inspected.rejectedFiles, MAX_MEMBERS) || !inspected.rejectedFiles.every(file => isLocalWorkbenchDataRecord(file, ['relative', 'revision'])
        && isLocalAlbumPrivateRelative(file.relative) && dto.isLocalWorkbenchIdentity(file.revision))
        || new Set(inspected.rejectedFiles.map(file => file.relative)).size !== inspected.rejectedFiles.length) return invalid()
      rejectedRelatives = inspected.rejectedFiles.map(file => file.relative)
    } else if (!group.members.length) rejectedRelatives = facts.files.filter(file => file.value.outcome === 'rejected').map(file => file.currentRelative)
    else {
      if (facts.files.some(file => file.value.outcome === 'rejected' && !includedRelatives.has(file.currentRelative))) return invalid('未取得此专辑完整的扫描拒绝归属，不能猜测成员范围。')
      rejectedRelatives = []
    }
    for (const relative of rejectedRelatives) {
      const file = byRelative.get(relative)
      if (!file || file.value.outcome !== 'rejected' || file.value.failureCode === null) return changed()
      if (includedRelatives.has(relative)) continue
      members.push({ trackId: null, assetId: null, fileName: basename(file.currentRelative), title: null, artist: null, album: null,
        rootRevision: root.revision, fileRevision: null, locationRevision: null, metadataRevision: null,
        scan: { signature: file.value.signature, parserVersion: file.value.parserVersion, revision: hash(file), failureCode: file.value.failureCode } })
    }
    if (members.length > MAX_MEMBERS) return limit()
    const artists = [...new Set(effectiveArtists.filter(value => value.trim()))], albums = [...new Set(effectiveAlbums.filter(value => value.trim()))]
    const artistName = artists.length === 1 ? artists[0]! : artists.length === 0 && structured && group.summary.artists.length === 1 ? group.summary.artists[0]! : '',
      albumName = group.summary.editionId ? group.summary.title : albums.length === 1 ? albums[0]!
        : structured ? group.summary.title : group.directory !== null ? basename(group.directory) : ''
    if (group.summary.editionId && albums.some(value => value !== albumName)) albumSources.push('unknown')
    const nameSources = { artistName: nameSource(artistSources), albumName: nameSource(albumSources) }
    const capture: LocalWorkbenchAlbumCapture = { albumId: group.summary.id, readToken, revision: hash([group.summary.revision, root, facts, provenance, members, nameSources]),
      rootId: root.id, directoryId: 'directory-' + hash([root.id, root.sourceRootId, directories]), editionId: group.summary.editionId,
      artistName, albumName, directoryName: directories.length === 1 ? basename(directories[0]!) : '',
      manualLocks: { artistName: nameSources.artistName === 'manual', albumName: nameSources.albumName === 'manual' }, nameSources, members }
    if (!isLocalWorkbenchAlbumCapture(capture)) return invalid('专辑没有可捕获的真实音频文件事实，未生成读取引用。')
    const finishRootVerify = startWorkbenchCapturePhase('ROOT_VERIFY')
    const roots = await options.readRootViews()
    check(context)
    if (!isLocalWorkbenchDenseArray(roots, 100) || !roots.every(dto.isLocalRootView) || new Set(roots.map(view => view.root.id)).size !== roots.length) return invalid()
    const currentRoot = roots.find(view => view.root.id === root.id)
    if (!currentRoot || !same(currentRoot.root, root) || ownerRevision() !== datasetRevision) return changed()
    finishRootVerify()
    const availability: dto.LocalWorkbenchAlbumSnapshot['availability'] = currentRoot.availability === 'ONLINE' ? 'online' : currentRoot.availability === 'SOURCE_ROOT_OFFLINE' ? 'offline' : 'unavailable'
    const value: LocalWorkbenchResolvedReadCapture = { datasetId: options.datasetId, datasetRevision, capture, group: structuredClone(group),
      directoryFacts: structuredClone(facts), provenance: structuredClone(provenance), availability }
    const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8')
    if (bytes > maxBytes) return limit()
    return freezeLocalWorkbenchValue({ ...value, bytes, expiresAt: now() + ttlMs })
  }
  function cueRecords(lease: Lease): readonly LocalAlbumSqlCueStored[] {
    const references = new Set(lease.group.issues.filter(issue => issue.kind === 'cue').map(issue => issue.relative))
    const result = lease.directoryFacts.cues.filter(cue => references.has(cue.item.relative))
    if (result.length > 100) return limit()
    return result
  }
  function cueEligible(lease: Lease, cue: LocalAlbumSqlCueStored): boolean {
    const root = catalog.root(lease.capture.rootId), parsed = cue.item.result
    if (lease.availability !== 'online' || cue.item.outcome !== 'accepted' || !parsed || cue.rootRevision !== root.revision || cue.sourceRootId !== root.sourceRootId) return false
    if (new Set(parsed.tracks.map(track => track.assetReference.assetId)).size === parsed.tracks.length) return false
    return parsed.tracks.every(track => {
      const ref = track.assetReference, member = lease.capture.members.find(item => item.assetId === ref.assetId), file = lease.directoryFacts.files.find(item => item.currentRelative === ref.relative)
      return ref.libraryRootId === root.id && ref.sourceRootId === root.sourceRootId && ref.rootRevision === root.revision && member !== undefined
        && member.fileRevision === ref.fileRevision && member.locationRevision === ref.locationRevision && file?.value.outcome === 'accepted'
        && file.value.assetId === ref.assetId && file.value.signature === ref.signature
    })
  }
  async function readAlbums(request: dto.LocalWorkbenchReadRequest, context: LocalWorkbenchReadContext = {}): Promise<dto.LocalWorkbenchReadback> {
    check(context); prune()
    if (!dto.isLocalWorkbenchCommandPayload('localWorkbench.read', request)) throw new LocalWorkbenchPlanError('INVALID_REQUEST', '请明确选择本地专辑完整成员。')
    const revision = ownerRevision(), fresh: Lease[] = [], ids = new Set<string>(), snapshots: dto.LocalWorkbenchAlbumSnapshot[] = []
    for (const ref of request.albums) {
      const readToken = token()
      if (!dto.isLocalWorkbenchIdentity(readToken) || ids.has(readToken) || leases.has(readToken)) return invalid('只读捕获引用重复，未替换原读取。')
      ids.add(readToken)
      const lease = await captureAlbum(ref, readToken, revision, context)
      let artwork: dto.LocalArtworkImage | null = null
      if (options.readCurrentArtwork && lease.availability === 'online') {
        artwork = await options.readCurrentArtwork(lease.group, context); check(context)
        if (artwork !== null && !dto.isLocalArtworkImage(artwork)) return invalid('封面展示副本未取得归一化资格。')
      }
      const summary = lease.group.summary
      snapshots.push({ album: { albumId: summary.id, title: summary.title, artist: lease.capture.artistName, rootId: summary.rootId,
        directoryId: lease.capture.directoryId, ...(summary.editionId ? { editionId: summary.editionId } : {}), trackIds: [...ref.trackIds] },
      capture: { albumId: summary.id, readToken }, searchNames:readSearchNames(lease), availability: lease.availability, issues: issueSummary(lease.group, lease.capture),
      currentArtwork: artwork !== null || summary.artworkAvailable ? { label: '已有封面', previewUrl: artwork?.display.dataUrl ?? null } : null,
      cueSheets: cueRecords(lease).map(cue => ({ cueId: cue.id, label: basename(cue.item.relative), eligible: cueEligible(lease, cue),
        ...(!cueEligible(lease, cue) ? { reason: 'CUE来源未就绪、修订已变化或已为实际独立分轨文件。' } : {}) })) })
      fresh.push(lease)
    }
    if (leases.size + fresh.length > maxCaptures || [...leases.values(), ...fresh].reduce((bytes, lease) => bytes + lease.bytes, 0) > maxBytes) return limit()
    const finishSettings = startWorkbenchCapturePhase('SETTINGS')
    const settings = options.readSettings ? await options.readSettings() : undefined
    finishSettings()
    check(context)
    if (ownerRevision() !== revision) return changed()
    const result: dto.LocalWorkbenchReadback = { datasetId: options.datasetId, snapshotId: hash([revision, fresh.map(lease => lease.capture)]), albums: snapshots,
      ...(settings ? { settings: structuredClone(settings) } : {}) }
    if (!dto.isLocalWorkbenchReadback(result, request)) return invalid('整理公开读取副本不符合闭集合同。')
    fresh.forEach(lease => leases.set(lease.capture.readToken, lease))
    return freezeLocalWorkbenchValue(structuredClone(result))
  }
  async function resolveCapture(request: dto.LocalWorkbenchArtworkRequest, context: LocalWorkbenchReadContext = {}): Promise<Readonly<LocalWorkbenchResolvedReadCapture>> {
    check(context); prune()
    if (!dto.isLocalWorkbenchCommandPayload('localWorkbench.artwork.local', request) || request.datasetId !== options.datasetId) throw new LocalWorkbenchPlanError('INVALID_REQUEST', '原读取引用不属于当前工作库。')
    const saved = leases.get(request.capture.readToken)
    if (!saved || saved.capture.albumId !== request.capture.albumId || saved.expiresAt <= now()) throw new LocalWorkbenchPlanError('EXPIRED', '原读取引用已过期，请重新读取。')
    const frozenOriginal=frozenLeases.get(request.capture.readToken)
    if(frozenOriginal){frozenOriginal.assertOriginal();const ref=saved.group.summary,current=await captureAlbum({albumId:ref.id,rootId:ref.rootId,title:ref.title,artist:saved.capture.artistName,
      ...(ref.editionId?{editionId:ref.editionId}:{}),trackIds:saved.group.members.map(m=>m.fact.summary.track.id)},saved.capture.readToken,ownerRevision(),context)
      frozenOriginal.assertOriginal();check(context);if(!sameFrozenReadSource(frozenOriginal.original,current))return changed()
      if(ownerRevision()!==current.datasetRevision)return changed();saved.datasetRevision=current.datasetRevision
      return freezeLocalWorkbenchValue(structuredClone({...frozenOriginal.original,datasetRevision:saved.datasetRevision}))}
    if (ownerRevision() !== saved.datasetRevision) return changed()
    const summary = saved.group.summary
    const fresh = await captureAlbum({ albumId: summary.id, rootId: summary.rootId, title: summary.title, artist: saved.capture.artistName,
      ...(summary.editionId ? { editionId: summary.editionId } : {}), trackIds: saved.group.members.map(member => member.fact.summary.track.id) }, saved.capture.readToken, saved.datasetRevision, context)
    if (!same(fresh.capture, saved.capture) || fresh.availability !== saved.availability) return changed()
    return freezeLocalWorkbenchValue(structuredClone({ datasetId: saved.datasetId, datasetRevision: saved.datasetRevision, capture: saved.capture,
      group: saved.group, directoryFacts: saved.directoryFacts, provenance: saved.provenance, availability: saved.availability }))
  }
  /** 按作者分组捕获全部成员；公开回复只携带签发引用，不回传大型成员数组。 */
  async function readAlbumTarget(request: dto.LocalLibraryManagementPayloads['library.album.capture'], context: LocalWorkbenchReadContext = {}): Promise<dto.LocalWorkbenchReadback> {
    return readAlbumTargets({ albums: [request] }, context)
  }
  async function readAlbumTargets(request: dto.LocalLibraryManagementPayloads['library.albums.capture'], context: LocalWorkbenchReadContext = {}): Promise<dto.LocalWorkbenchReadback> {
    check(context); prune()
    if (!dto.isLocalLibraryManagementPayload('library.albums.capture', request)) return invalid('请重新选择当前专辑。')
    const finishOwnerRevision = startWorkbenchCapturePhase('OWNER_REVISION')
    const revision = ownerRevision(), fresh: Lease[] = [], snapshots: dto.LocalWorkbenchAlbumSnapshot[] = []
    finishOwnerRevision()
    for (const target of request.albums) {
    const finishTargetInspect = startWorkbenchCapturePhase('TARGET_INSPECT')
    const group = await options.localAlbums.inspectAlbum({ albumKey: target.albumId, rootId: target.rootId, revision: target.revision })
    finishTargetInspect()
    check(context)
    if (group.summary.id !== target.albumId || group.summary.rootId !== target.rootId || group.summary.revision !== target.revision) return changed()
    const readToken = token()
    if (!dto.isLocalWorkbenchIdentity(readToken) || leases.has(readToken) || fresh.some(item => item.capture.readToken === readToken)) return invalid('只读捕获引用重复，未替换原读取。')
    const fullRef: dto.LocalWorkbenchAlbumRef = { albumId: group.summary.id, rootId: group.summary.rootId,
      title: group.summary.title, artist: group.summary.artists.join(' / '),
      ...(group.summary.editionId ? { editionId: group.summary.editionId } : {}), trackIds: group.members.map(member => member.fact.summary.track.id) }
    const lease = await captureAlbum(fullRef, readToken, revision, context, group)
    fresh.push(lease)
    if (leases.size + fresh.length > maxCaptures || [...leases.values(), ...fresh].reduce((bytes, item) => bytes + item.bytes, 0) > maxBytes) return limit()
    let artwork: dto.LocalArtworkImage | null = null
    if (options.readCurrentArtwork && lease.availability === 'online') {
      const finishArtwork = startWorkbenchCapturePhase('ARTWORK')
      artwork = await options.readCurrentArtwork(lease.group, context); check(context)
      if (artwork !== null && !dto.isLocalArtworkImage(artwork)) return invalid('封面展示副本未取得归一化资格。')
      finishArtwork()
    }
    const summary = lease.group.summary
    const snapshot: dto.LocalWorkbenchAlbumSnapshot = { album: { albumId: summary.id, title: summary.title, artist: lease.capture.artistName,
      rootId: summary.rootId, directoryId: lease.capture.directoryId, ...(summary.editionId ? { editionId: summary.editionId } : {}), trackIds: [],
      trackCount: summary.trackCount, revision: summary.revision },
      capture: { albumId: summary.id, readToken }, searchNames:readSearchNames(lease), availability: lease.availability, issues: issueSummary(lease.group, lease.capture),
      currentArtwork: artwork !== null || summary.artworkAvailable ? { label: '已有封面', previewUrl: artwork?.display.dataUrl ?? null } : null,
      cueSheets: cueRecords(lease).map(cue => ({ cueId: cue.id, label: basename(cue.item.relative), eligible: cueEligible(lease, cue),
        ...(!cueEligible(lease, cue) ? { reason: 'CUE来源未就绪、修订已变化或已为实际独立分轨文件。' } : {}) })) }
    snapshots.push(snapshot)
    }
    const finishSettings = startWorkbenchCapturePhase('SETTINGS')
    const settings = options.readSettings ? await options.readSettings() : undefined
    finishSettings()
    const result: dto.LocalWorkbenchReadback = { datasetId: options.datasetId, snapshotId: hash([revision, fresh.map(lease => lease.capture)]), albums: snapshots,
      ...(settings ? { settings: structuredClone(settings) } : {}) }
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 128 * 1024) snapshots.forEach(snapshot => { if (snapshot.currentArtwork) snapshot.currentArtwork.previewUrl = null })
    const finishReadbackVerify = startWorkbenchCapturePhase('READBACK_VERIFY')
    check(context)
    if (ownerRevision() !== revision) return changed()
    if (!dto.isLocalWorkbenchReadback(result) || Buffer.byteLength(JSON.stringify(result), 'utf8') > 128 * 1024) return limit()
    finishReadbackVerify()
    fresh.forEach(lease => leases.set(lease.capture.readToken, lease))
    return freezeLocalWorkbenchValue(structuredClone(result))
  }
  async function prepareNameSuggestion(request: dto.LocalWorkbenchAiRequest, context: LocalWorkbenchReadContext = {}): Promise<LocalWorkbenchNamePreparation> {
    check(context)
    if (!dto.isLocalWorkbenchCommandPayload('localWorkbench.ai.suggest', request)) throw new LocalWorkbenchPlanError('INVALID_REQUEST', '名称建议请求无效。')
    const resolved = await resolveCapture({ datasetId: request.datasetId, capture: request.capture }, context)
    if (resolved.availability !== 'online') return invalid('此来源目前离线或不可读，未请求名称模型。')
    const id = preparationId()
    if (!dto.isLocalWorkbenchIdentity(id) || preparations.has(id) || preparations.size >= 512) return invalid('名称准备引用无法建立，未请求模型。')
    const lease = leases.get(request.capture.readToken)!, prompts = localNameModelPrompts(resolved.capture)
    check(context)
    preparations.set(id, { lease, request: structuredClone(request), expiresAt: lease.expiresAt })
    return freezeLocalWorkbenchValue({ preparationId: id, backend: request.backend, ...prompts })
  }
  async function completeNameSuggestion(id: string, response: { backend: dto.LocalAiBackend; content: string }, context: LocalWorkbenchReadContext = {}): Promise<LocalNameProposalResult> {
    check(context); prune()
    if (!dto.isLocalWorkbenchIdentity(id) || !isLocalWorkbenchDataRecord(response, ['backend', 'content']) || !['ollama', 'vllm', 'cloud'].includes(response.backend)) return invalid('名称模型回报身份无效。')
    const prepared = preparations.get(id)
    if (!prepared || prepared.request.backend !== response.backend) throw new LocalWorkbenchPlanError('EXPIRED', '名称准备已结束或后端不一致，迟到结果未进入候选。')
    preparations.delete(id)
    const resolved = await resolveCapture({ datasetId: prepared.request.datasetId, capture: prepared.request.capture }, context)
    const result = parseLocalNameProposal(response.content, resolved.capture, response.backend)
    check(context)
    if (result.status === 'ready') {
      if (proposals.size >= 1000 && !proposals.has(result.proposal.candidateId)) return limit()
      proposals.set(result.proposal.candidateId, { lease: prepared.lease, proposal: structuredClone(result.proposal) })
    }
    return freezeLocalWorkbenchValue(structuredClone(result))
  }
  async function prepareNamePreview(request: dto.LocalWorkbenchAiPreviewRequest, context: LocalWorkbenchReadContext = {}): Promise<{
    draft: Extract<LocalWorkbenchPlanDraft, { kind: 'ai' }>; capture: LocalWorkbenchPlanCapture
  }> {
    check(context)
    if (!dto.isLocalWorkbenchAiPreviewRequest(request) || request.datasetId !== options.datasetId) throw new LocalWorkbenchPlanError('INVALID_REQUEST', '请明确选择原名称候选与完整专辑读取。')
    const revision = ownerRevision(), selections: Array<{ capture: LocalWorkbenchAlbumCapture; proposal: LocalNameProposal }> = []
    for (const selection of request.selections) {
      const reference = request.captures.find(value => value.albumId === selection.albumId)!, candidate = proposals.get(selection.candidateId)
      if (!candidate || candidate.proposal.albumId !== selection.albumId || candidate.lease.capture.readToken !== reference.readToken) return changed()
      const resolved = await resolveCapture({ datasetId: request.datasetId, capture: reference }, context)
      if (resolved.availability !== 'online') return invalid('名称预览包含当前离线来源，尚未生成可执行计划。')
      selections.push({ capture: structuredClone(resolved.capture), proposal: structuredClone(candidate.proposal) })
    }
    check(context)
    if (ownerRevision() !== revision) return changed()
    return freezeLocalWorkbenchValue({ draft: createLocalNamePlanDraft(selections), capture: { datasetId: options.datasetId, datasetRevision: revision, albums: selections.map(selection => selection.capture) } })
  }
  async function prepareArtworkPreview(input: {
    resolved: Readonly<LocalWorkbenchResolvedReadCapture>; artwork: Readonly<LocalWorkbenchArtworkCapture>
  }, context: LocalWorkbenchReadContext = {}): Promise<{ draft: Extract<LocalWorkbenchPlanDraft, { kind: 'artwork' }>; capture: LocalWorkbenchPlanCapture }> {
    check(context)
    if (!isLocalWorkbenchDataRecord(input, ['resolved', 'artwork'])
      || !isLocalWorkbenchDataRecord(input.resolved, ['datasetId', 'datasetRevision', 'capture', 'group', 'directoryFacts', 'provenance', 'availability'])
      || !isLocalWorkbenchAlbumCapture(input.resolved.capture) || !isLocalWorkbenchArtworkCapture(input.artwork)
      || input.artwork.albumId !== input.resolved.capture.albumId) return invalid('选中封面与原专辑完整读取不一致。')
    const resolved = await resolveCapture({ datasetId: input.resolved.datasetId, capture: { albumId: input.resolved.capture.albumId,
      readToken: input.resolved.capture.readToken } }, context)
    if (!same(resolved, input.resolved) || resolved.availability !== 'online') return changed()
    const artwork = structuredClone(input.artwork), capture: LocalWorkbenchPlanCapture = { datasetId: options.datasetId,
      datasetRevision: resolved.datasetRevision, albums: [structuredClone(resolved.capture)], artwork: [artwork] }
    if (!isLocalWorkbenchPlanCapture(capture)) return limit()
    const blockers: string[] = []
    if (!resolved.capture.members.some(member => member.trackId !== null)) blockers.push('没有成功音轨，尚无可建立的安全MusicBridge关系；选中候选仍保留。')
    if (['local-independent', 'embedded'].includes(artwork.origin) && !artwork.sourceIdentity) blockers.push('本地封面来源尚未取得原作者引用，不能猜测或伪造来源身份。')
    const draft: Extract<LocalWorkbenchPlanDraft, { kind: 'artwork' }> = { kind: 'artwork', scope: 'MB_ONLY', albumIds: [resolved.capture.albumId],
      relationship: resolved.capture.editionId === null ? 'create-on-apply' : 'existing', state: blockers.length ? 'blocked' : 'ready', blockers,
      items: [{ itemId: 'artwork-item-' + resolved.capture.albumId, albumId: resolved.capture.albumId, label: artwork.sourceLabel, changes: [] }] }
    check(context)
    return freezeLocalWorkbenchValue({ draft, capture })
  }
  async function resolveCueFacts(request: dto.LocalWorkbenchArtworkRequest & { cueId: string }, context: LocalWorkbenchReadContext = {}): Promise<{
    capture: LocalWorkbenchAlbumCapture; cueId: string; cueRevision: string; parsed: CueReadResult<CueOwnerAssetReference>
  }> {
    if (!isLocalWorkbenchDataRecord(request, ['datasetId', 'capture', 'cueId']) || !dto.isLocalWorkbenchIdentity(request.cueId)) throw new LocalWorkbenchPlanError('INVALID_REQUEST', 'CUE选择引用无效。')
    const resolved = await resolveCapture({ datasetId: request.datasetId, capture: request.capture }, context), lease = leases.get(request.capture.readToken)!
    const cue = cueRecords(lease).find(value => value.id === request.cueId)
    if (!cue || !cueEligible(lease, cue) || !cue.item.result) throw new LocalWorkbenchPlanError('CUE_INVALID', '所选CUE未取得当前完整来源绑定，尚未准备输出。')
    // 原CUE的relative/signature仅留在私有directoryFacts；纯分段消费实际解析索引和精确资产修订。
    const result = cue.item.result
    const parsed: CueReadResult<CueOwnerAssetReference> = { status: 'ok', ...(result.albumTitle !== undefined ? { albumTitle: result.albumTitle } : {}),
      ...(result.albumPerformer !== undefined ? { albumPerformer: result.albumPerformer } : {}), tracks: result.tracks.map(track => ({ ...track,
        assetReference: { assetId: track.assetReference.assetId, libraryRootId: track.assetReference.libraryRootId, sourceRootId: track.assetReference.sourceRootId,
          rootRevision: track.assetReference.rootRevision, fileRevision: track.assetReference.fileRevision, locationRevision: track.assetReference.locationRevision } })) }
    return freezeLocalWorkbenchValue({ capture: structuredClone(resolved.capture), cueId: cue.id, cueRevision: hash(cue), parsed })
  }
  function cancelNamePreparation(id: string): boolean { check(); return dto.isLocalWorkbenchIdentity(id) && preparations.delete(id) }
  /** 整库捕获按原SQL水位逐专辑保存，不预开512个UI读取租约。 */
  async function readUnleasedAlbum(target:dto.LocalLibraryManagementPayloads['library.album.capture'],context:LocalWorkbenchReadContext={}):Promise<Readonly<LocalWorkbenchResolvedReadCapture>> {
    check(context)
    if(!dto.isLocalLibraryManagementPayload('library.album.capture',target))return invalid('原专辑范围无效。')
    const revision=ownerRevision(),group=await options.localAlbums.inspectAlbum({albumKey:target.albumId,rootId:target.rootId,revision:target.revision});check(context)
    if(group.summary.id!==target.albumId||group.summary.rootId!==target.rootId||group.summary.revision!==target.revision)return changed()
    const readToken=token()
    if(!dto.isLocalWorkbenchIdentity(readToken)||leases.has(readToken))return invalid('原捕获身份无效。')
    const ref:dto.LocalWorkbenchAlbumRef={albumId:group.summary.id,rootId:group.summary.rootId,title:group.summary.title,artist:group.summary.artists.join(' / '),
      ...(group.summary.editionId?{editionId:group.summary.editionId}:{}),trackIds:group.members.map(member=>member.fact.summary.track.id)}
    const value=await captureAlbum(ref,readToken,revision,context,group);check(context)
    if(ownerRevision()!==revision)return changed()
    const {bytes:_bytes,expiresAt:_expiresAt,...original}=value
    const frozen=freezeLocalWorkbenchValue(original)
    unleasedAlbumBodies.add(frozen)
    return frozen
  }
  /** 实际目录失效撤销该根的旧读取；持久capture与历史成功快照由原账本保留。 */
  function invalidateRoot(rootId:string):void {
    if(!dto.isLocalWorkbenchIdentity(rootId))return invalid('原目录身份无效。')
    const removed=new Set<string>()
    for(const [readToken,lease]of leases)if(lease.capture.rootId===rootId){removed.add(readToken);leases.delete(readToken);frozenLeases.delete(readToken)}
    for(const [id,preparation]of preparations)if(removed.has(preparation.lease.capture.readToken))preparations.delete(id)
    for(const [id,proposal]of proposals)if(removed.has(proposal.lease.capture.readToken))proposals.delete(id)
  }
  function close(): void { closed = true; leases.clear(); frozenLeases.clear(); preparations.clear(); proposals.clear() }
  const service={ inspectRoot(capture:{albumId:string;readToken:string}):string{check();prune();const original=leases.get(capture.readToken);if(!original||original.capture.albumId!==capture.albumId||catalog.privateLibraryManagementRootAvailable?.(original.capture.rootId)===false)return changed();return original.capture.rootId},readAlbums, readAlbumTarget, readAlbumTargets, readUnleasedAlbum, invalidateRoot, resolveCapture, prepareNameSuggestion, completeNameSuggestion, prepareNamePreview, prepareArtworkPreview, resolveCueFacts, cancelNamePreparation, close,
    inspect: () => ({ captures: leases.size, preparations: preparations.size, candidates: proposals.size }) }
  frozenReadMembers.set(service,async(albumId,rootId)=>{
    check();const group=await options.localAlbums.inspectAlbum({albumKey:albumId,rootId});check()
    if(group.summary.id!==albumId||group.summary.rootId!==rootId||!isLocalWorkbenchDenseArray(group.members,MAX_MEMBERS)||group.members.length!==group.summary.trackCount)return changed()
    const members=group.members.map(m=>({trackId:m.fact.summary.track.id,assetId:m.fact.summary.asset.id}))
    if(members.some(m=>!dto.isCollectionId(m.trackId)||!dto.isCollectionId(m.assetId))||new Set(members.map(m=>m.trackId)).size!==members.length)return changed()
    return members
  })
  frozenReadAuthors.set(service,async(original,assertOriginal,context)=>{
    check(context);prune();assertOriginal()
    const summary=original.group.summary,current=await captureAlbum({albumId:summary.id,rootId:summary.rootId,title:summary.title,artist:original.capture.artistName,
      ...(summary.editionId?{editionId:summary.editionId}:{}),trackIds:original.group.members.map(m=>m.fact.summary.track.id)},original.capture.readToken,ownerRevision(),context)
    check(context);assertOriginal();if(!sameFrozenReadSource(original,current))return changed()
    if(!leases.has(original.capture.readToken)&&leases.size>=maxCaptures){const prior=frozenLeases.keys().next().value as string|undefined
      if(prior===undefined)return limit();frozenLeases.delete(prior);leases.delete(prior)}
    const bytes=Buffer.byteLength(canonical(original))
    while(bytes+[...leases.values()].filter(v=>v.capture.readToken!==original.capture.readToken).reduce((sum,v)=>sum+v.bytes,0)>maxBytes){const prior=frozenLeases.keys().next().value as string|undefined
      if(prior===undefined)return limit();frozenLeases.delete(prior);leases.delete(prior)}
    if(ownerRevision()!==current.datasetRevision)return changed()
    const existing=leases.get(original.capture.readToken);if(existing&&(existing.capture.albumId!==original.capture.albumId||existing.capture.rootId!==original.capture.rootId))return changed()
    leases.set(original.capture.readToken,{...structuredClone(original),datasetRevision:current.datasetRevision,bytes,expiresAt:now()+ttlMs})
    frozenLeases.set(original.capture.readToken,{original:freezeLocalWorkbenchValue(structuredClone(original)),assertOriginal})
    return original.capture.readToken
  })
  return service
}
export type LocalWorkbenchReadService = ReturnType<typeof createLocalWorkbenchReadService>

/** 私有作者端口只在原Owner装配；公开choice/UUID/回执形状不构成目录或Native许可。 */
export interface LocalLibraryManagementImportPort {
  prepare(context:LocalWorkbenchReadContext):Promise<dto.LocalLibraryImportChoice|null>
  confirm(request:dto.LocalLibraryManagementPayloads['library.import.confirm'],context:LocalWorkbenchReadContext):Promise<dto.LibraryRoot>
  /** 必须回读原批准/注册作者保存的原请求，不能再次注册或重新弹授权。 */
  readOriginal(commandId:string,context:LocalWorkbenchReadContext):Promise<{
    original:Extract<LocalLibraryManagementOriginalOperation,{command:'library.import.confirm'}>;
    root:dto.LibraryRoot; state:'succeeded'|'unknown'|'failed';
  }|null>
}
export interface LocalLibraryManagementWatchPort {
  enable(rootId:string):Promise<void>
  disable(rootId:string):Promise<unknown>
  remove(rootId:string):Promise<unknown>
  watching(rootId:string):boolean
  close():Promise<void>
}
export interface LocalLibraryManagementAttempt {planId:string;commandId:string}
export interface LocalLibraryManagementJobInput {
  job:Readonly<LocalLibraryManagementJobRecord>
  capture:Readonly<LocalLibraryManagementCaptureRecord>
  album:Readonly<LocalLibraryManagementCapturedAlbum>
  selection:Readonly<LocalLibraryManagementJobRecord['original']['expandedSelection'][number]>
  /** 只有显式resume/retry才非null；原start/selection/watermark保持。 */
  action:LocalLibraryManagementJobAction|null
}
export interface LocalLibraryManagementJobPort {
  /** 返回的plan必须已由原registry/AI/CUE作者持久受理；null只表示明确需review。 */
  prepare(input:LocalLibraryManagementJobInput,context:LocalWorkbenchReadContext):Promise<LocalLibraryManagementAttempt|null>
  run(input:LocalLibraryManagementJobInput,attempt:Readonly<LocalLibraryManagementAttempt>,context:LocalWorkbenchReadContext):Promise<dto.LocalWorkbenchReceipt|null>
  readOriginal(input:LocalLibraryManagementJobInput,attempt:Readonly<LocalLibraryManagementAttempt>,context:LocalWorkbenchReadContext):Promise<dto.LocalWorkbenchReceipt|null>
  /** 无论run是否抛错，均join同一原job所有真实资源；拒绝不能伪称stopped/closed。 */
  join(job:Readonly<LocalLibraryManagementJobRecord>):Promise<void>
}
export interface LocalLibraryManagementRuntimeOptions {
  identity:DatasetIdentity
  catalog:Pick<LocalCatalogStore,'privateBindWorkbenchDataset'|'privateLibraryManagementRead'|'privateLibraryManagementReadCaptureHeader'|'privateLibraryManagementReadFrozenAlbum'|'privateLibraryManagementBindings'
    |'privateLibraryManagementRevision'|'privateLibraryManagementCompareAndSwap'|'privateLibraryManagementRootAvailable'|'privateLibraryManagementJobs'|'privateAlbumBrowserRevision'|'privateScanSettingsStore'
    |'root'|'queryTracks'|'privateLyricsTrackFacts'>
  localScan:Pick<LocalScanStore,'privateAlbumBrowserRevision'|'page'>
  workbench:LocalWorkbenchReadService
  localAlbums:{queryAlbums(request:dto.LocalAlbumQuery):Promise<dto.LocalAlbumPage>|dto.LocalAlbumPage}
  readRootViews():Promise<readonly dto.LocalRootView[]>
  assertAccepting():void
  completedSnapshots:Pick<CompletedScanSnapshotView,'load'|'retry'>&Partial<Pick<CompletedScanSnapshotView,'privateLastSuccessId'>>
  /** 已完成快照只恢复派生视图，不改媒体或重新扫描。必须由原实际scan/view作者消费。 */
  activateSnapshot?(libraryId:string,snapshot:NonNullable<CompletedScanSnapshotLoad['lastSuccess']>,original:LocalLibraryManagementOriginalOperation,context:LocalWorkbenchReadContext):Promise<void>
  /** 实际Root按原库/原命令收口全部原资源；缺少作者不得撤绑定或返回清理成功。 */
  removeResources?(libraryId:string,context:LocalWorkbenchReadContext,removingLibraries:readonly string[],original:Readonly<{commandId:string;originalSha256:string}>,pin:Readonly<{libraryId:string;sourceRootId:string;rootRevision:string;bindingSha256:string|null}>):Promise<void>
  /** 仅原remove提交前重核Domain品牌context的真实期限；signal回调尚未运行也不能迟到开CAS。 */
  assertRemoveCurrent?(context:LocalWorkbenchReadContext):void
  beforeSnapshotRetry?(libraryId:string,jobId:string,context:LocalWorkbenchReadContext):Promise<void>
  /** 只关联原导入命令的持久扫描；已存在job不借此自动恢复或重新扫描。 */
  startInitialScan?(commandId:string,root:Readonly<dto.LibraryRoot>,context:LocalWorkbenchReadContext):Promise<void>
  imports?:LocalLibraryManagementImportPort
  watch?:LocalLibraryManagementWatchPort
  jobs?:LocalLibraryManagementJobPort
  now?:()=>number
  makeCaptureId?:()=>string
}
export interface LocalLibraryManagementFrozenAlbum {
  resolved:Readonly<LocalWorkbenchResolvedReadCapture>
  /** 原完整record的轻量header；原完整正文仍只在catalog projection与全record读取口保留。 */
  captureRecord:LocalLibraryManagementFrozenAlbumSelection['captureRecord']
  managementCapture:LocalLibraryManagementFrozenAlbumSelection['managementCapture']
}

/** 同GuardedSQLite的有限四域管理作者；运行中的资源不由JSON恢复或授予权限。 */
export function createLocalLibraryManagementRuntime(options:LocalLibraryManagementRuntimeOptions) {
  const {identity,catalog,localScan,workbench}=options,datasetId=identity.datasetId,now=options.now??(()=>performance.now())
  if(!dto.isCommandOutboxDatasetId(datasetId)||!frozenReadAuthors.has(workbench))return invalid('管理作者必须装配同Owner实际只读作者。')
  catalog.privateBindWorkbenchDataset(identity)
  const settings:LocalScanSettingsStore=catalog.privateScanSettingsStore(identity)
  let closing=false,closePromise:Promise<void>|undefined,serial:Promise<void>=Promise.resolve()
  const flights=new Map<string,{controller:AbortController;work:Promise<void>;action:LocalLibraryManagementJobAction|null}>()
  // 只留同实际Owner原work成功join的有限闭口事实，不是写授权；冷JSON或空Map不能恢复。
  const jobJoins=new Map<string,{identity:DatasetIdentity;datasetId:string;originalSha256:string;work:Promise<void>}>()
  const originals=new Map<string,LocalLibraryManagementOriginalOperation>()
  const libraryProofs=new WeakMap<object,{record:Readonly<LocalLibraryManagementCaptureRecord>;libraryId:string;deadline:number}>()
  const libraryDeadlines=new Map<string,number>()
  function check(context:LocalWorkbenchReadContext={}):void {
    identity.assertCurrent();options.assertAccepting()
    if(closing)return invalid('库管理已关闭，原操作保留。')
    if(context.signal?.aborted)throw new LocalWorkbenchPlanError('INVALID_REQUEST','库管理读取已取消，原操作保留。')
  }
  async function exclusively<T>(body:()=>Promise<T>|T):Promise<T> {
    const previous=serial;let release!:()=>void;serial=new Promise<void>(resolve=>{release=resolve})
    await previous;try{return await body()}finally{release()}
  }
  function rootsCheck(roots:readonly dto.LocalRootView[]):void {
    if(!isLocalWorkbenchDenseArray(roots,100)||!roots.every(dto.isLocalRootView)||new Set(roots.map(r=>r.root.id)).size!==roots.length)return invalid('管理作者没有完整当前根投影。')
    for(const root of roots)if(root.root.role==='library'&&!same(catalog.root(root.root.id),root.root))return changed()
  }
  async function views(context:LocalWorkbenchReadContext={}):Promise<readonly dto.LocalRootView[]> {
    check(context);const values=await options.readRootViews();check(context);rootsCheck(values);return values
  }
  function activeBinding(id:string) {
    const stored=catalog.privateLibraryManagementRead(identity,'binding',id)
    if(!stored||!stored.record.active||!catalog.privateLibraryManagementRootAvailable(id))return invalid('原库未取得有效管理绑定，或原撤销仍未完整收口。')
    const root=catalog.root(id)
    if(root.role!=='library'||root.sourceRootId!==stored.record.sourceRootId||root.revision!==stored.record.rootRevision)return changed()
    return stored
  }
  /** 旧目录只取得原remove的关闭资格；不补导入回执，也不先创建active绑定。 */
  function removalTarget(id:string) {
    const stored=catalog.privateLibraryManagementRead(identity,'binding',id)
    if(stored){const binding=activeBinding(id);return {root:catalog.root(id),binding}}
    const root=catalog.root(id)
    if(root.role!=='library'||!catalog.privateLibraryManagementRootAvailable(id))return invalid('原旧库不存在、不是音乐库或原撤销尚未收口。')
    return {root,binding:null}
  }
  function captureRecord(id:string):Readonly<LocalLibraryManagementCaptureRecord> {
    const stored=catalog.privateLibraryManagementRead(identity,'capture',id)
    if(!stored)return invalid('完整原捕获不存在，不能从当前分页替换。')
    return stored.record
  }
  function operationRecord(id:string) {return catalog.privateLibraryManagementRead(identity,'operation',id)}
  function write(record:LocalLibraryManagementWrite['record'],expectedRevision:number|null):void {
    check();catalog.privateLibraryManagementCompareAndSwap(identity,[{record,expectedRevision}]);check()
  }
  function newOperation(original:LocalLibraryManagementOriginalOperation,libraryIds:readonly string[],state:dto.LocalLibraryManagementOperation['state']):LocalLibraryManagementOperationRecord {
    return {schema:1,kind:'operation',datasetId,key:original.request.commandId,revision:1,original:structuredClone(original),originalSha256:localLibraryManagementDigest(original),
      receipt:{commandId:original.request.commandId,kind:original.command,state,libraryIds:[...libraryIds],message:null}}
  }
  function knownOperation(original:LocalLibraryManagementOriginalOperation):Readonly<LocalLibraryManagementOperationRecord>|null {
    const stored=operationRecord(original.request.commandId)
    if(stored){if(!same(stored.record.original,original))return invalid('同一命令不能换请求或库。');return stored.record}
    const inFlight=originals.get(original.request.commandId)
    if(inFlight&&!same(inFlight,original))return invalid('同一目录命令不能换原请求。')
    return null
  }
  async function readLibrary(context:LocalWorkbenchReadContext):Promise<dto.LocalLibraryManagementReadback> {
    const rootViews=await views(context),bindings=catalog.privateLibraryManagementBindings(identity),bound=new Map(bindings.map(s=>[s.record.libraryId,s.record]))
    const scanJobs:dto.ScanJobRecord[]=[];let expected:number|null=null
    for(let offset=0;;){check(context);const page=localScan.page(datasetId,{offset,limit:200})
      if(!Number.isSafeInteger(page.total)||page.total<0||!isLocalWorkbenchDenseArray(page.items,200)||!page.items.every(dto.isScanJobRecord)||expected!==null&&page.total!==expected||page.offset!==offset||page.limit!==200||page.hasMore!==(page.offset+page.items.length<page.total))return changed()
      expected=page.total;scanJobs.push(...page.items);offset+=page.items.length
      if(!page.hasMore){if(offset!==expected)return changed();break}if(page.items.length===0)return changed()
    }
    const libraries:dto.LocalLibraryManagedRoot[]=[]
    for(const view of rootViews){if(view.root.role!=='library'||bound.get(view.root.id)?.active===false)continue
      const binding=bound.get(view.root.id)
      if(binding&&(binding.sourceRootId!==view.root.sourceRootId||binding.rootRevision!==view.root.revision))return changed()
      const page=await options.localAlbums.queryAlbums({rootId:view.root.id,query:'',filter:'all',offset:0,limit:1});check(context)
      if(!dto.isLocalAlbumPage(page,{rootId:view.root.id,query:'',filter:'all',offset:0,limit:1}))return invalid()
      check(context);const latestSnapshotId=options.completedSnapshots.privateLastSuccessId?options.completedSnapshots.privateLastSuccessId(view.root.id):options.completedSnapshots.load(view.root.id).lastSuccess?.attempt.attemptId??null,latest=scanJobs.filter(j=>j.libraryRootId===view.root.id&&j.sourceRootId===view.root.sourceRootId&&j.rootRevision===view.root.revision).at(-1)
      check(context);const online=view.availability==='ONLINE',phase=latest?.phase
      const scanState:dto.LocalLibraryManagedRoot['scanState']=!online?'offline':phase==='completed'?'complete':phase==='pending'?'queued':phase??'idle'
      libraries.push({libraryId:view.root.id,label:binding?.name??view.label,role:binding?.role??'catalog',online,watching:options.watch?.watching(view.root.id)??false,
        latestSnapshotId,totalAlbums:page.total,totalTracks:catalog.queryTracks({rootId:view.root.id,query:'',offset:0,limit:1}).total,scanState})
    }
    const value=settings.read(identity);if(!isLocalScanSettings(value))return invalid()
    return {datasetId,revision:hash([catalog.privateAlbumBrowserRevision(),localScan.privateAlbumBrowserRevision(),catalog.privateLibraryManagementRevision(identity),scanJobs,libraries]),libraries,scanConcurrency:value.albumConcurrency}
  }
  async function captureAll(request:dto.LocalLibraryManagementPayloads['library.capture'],context:LocalWorkbenchReadContext):Promise<dto.LocalLibraryCompleteCapture> {
    check(context);if(request.libraryIds.length>100)return limit()
    const wholeDeadline=now()+480000
    const pulse=async():Promise<void>=>{await new Promise<void>(resolve=>setImmediate(resolve));check(context);if(now()>=wholeDeadline)throw new LocalWorkbenchPlanError('INVALID_CAPTURE','原完整库捕获整体期限已到，未返回不完整范围。')}
    const rootViews=await views(context),catalogRevision=catalog.privateAlbumBrowserRevision(),scanRevision=localScan.privateAlbumBrowserRevision()
    const pins=request.libraryIds.map(libraryId=>{const view=rootViews.find(r=>r.root.id===libraryId&&r.root.role==='library')
      if(!view||!catalog.privateLibraryManagementRootAvailable(libraryId))return invalid('选中的原库已撤销或不存在。')
      return {libraryId,sourceRootId:view.root.sourceRootId,rootRevision:view.root.revision}})
    const refs:LocalLibraryManagementCaptureRecord['original']['albumRefs'][number][]=[],albums:LocalLibraryManagementCapturedAlbum[]=[]
    let watermark:string|null=null,totalMembers=0,used=0
    for(const pin of pins){let total:number|null=null;const baseAlbums=refs.length
      for(let offset=0;;){await pulse();const query:dto.LocalAlbumQuery={rootId:pin.libraryId,query:'',filter:'all',offset,limit:200}
        const page=await options.localAlbums.queryAlbums(query);check(context)
        if(!dto.isLocalAlbumPage(page,query)||total!==null&&page.total!==total)return changed()
        total=page.total
        if(total+baseAlbums>10000)return limit()
        for(const summary of page.items){await pulse();if(summary.rootId!==pin.libraryId||refs.some(r=>r.albumId===summary.id))return changed()
          const ref={albumId:summary.id,rootId:pin.libraryId,revision:summary.revision},resolved=await workbench.readUnleasedAlbum(ref,context);check(context)
          if(watermark!==null&&resolved.datasetRevision!==watermark||resolved.directoryFacts.revision!==scanRevision)return changed()
          watermark=resolved.datasetRevision;totalMembers+=resolved.capture.members.length;used+=Buffer.byteLength(canonical(resolved))
          if(totalMembers>LOCAL_LIBRARY_MANAGEMENT_RESOURCES||used>LOCAL_LIBRARY_MANAGEMENT_BYTES)return limit()
          // 同模块真实读取正文已脱离存储并递归冻结；替代端口的普通正文仍防御复制。
          refs.push(ref);albums.push({...pin,resolved:unleasedAlbumBodies.has(resolved)?resolved:structuredClone(resolved)})
        }
        offset+=page.items.length
        if(!page.hasMore){if(offset!==total)return changed();break}if(page.items.length===0)return changed()
      }
    }
    await pulse()
    const captureId=(options.makeCaptureId??randomUUID)()
    const original:LocalLibraryManagementCaptureRecord['original']={mode:'library',request:structuredClone(request),captureId,watermark:watermark??hash([datasetId,catalogRevision,scanRevision]),catalogRevision,scanRevision,libraries:pins,albumRefs:refs,albums}
    if(catalog.privateAlbumBrowserRevision()!==catalogRevision||localScan.privateAlbumBrowserRevision()!==scanRevision)return changed()
    write({schema:1,kind:'capture',datasetId,key:captureId,revision:1,original,originalSha256:localLibraryManagementDigest(original)},null)
    return {datasetId,captureId,libraryIds:[...request.libraryIds],revision:original.watermark,lyricsLibraries:request.libraryIds.map(libraryId=>({datasetId,libraryId,captureId}))}
  }
  async function rememberAlbumReadback(readback:dto.LocalWorkbenchReadback,context:LocalWorkbenchReadContext={}):Promise<void> {
    check(context);if(!dto.isLocalWorkbenchReadback(readback)||readback.datasetId!==datasetId||readback.albums.length>100)return invalid('仅接受原同Owner已签发读取。')
    const fresh:Readonly<LocalWorkbenchResolvedReadCapture>[]=[],originalsRead:Readonly<LocalWorkbenchResolvedReadCapture>[]=[]
    for(const album of readback.albums){const old=catalog.privateLibraryManagementRead(identity,'capture',album.capture.readToken)
      if(old){const stored=old.record.original.albums
        if(old.record.original.mode!=='albums'||stored.length!==1||stored[0]!.resolved.capture.albumId!==album.album.albumId||stored[0]!.resolved.capture.rootId!==album.album.rootId)return changed()
        originalsRead.push(stored[0]!.resolved);continue}
      const finishResolve=startWorkbenchCapturePhase('REMEMBER_RESOLVE')
      const resolved=await workbench.resolveCapture({datasetId,capture:album.capture},context);check(context)
      finishResolve()
      if(resolved.capture.albumId!==album.album.albumId||resolved.capture.rootId!==album.album.rootId)return changed()
      fresh.push(resolved);originalsRead.push(resolved)
    }
    if(originalsRead.length===0||originalsRead.some(r=>r.datasetRevision!==originalsRead[0]!.datasetRevision)||readback.snapshotId!==hash([originalsRead[0]!.datasetRevision,originalsRead.map(r=>r.capture)]))return invalid('公开readback不匹配原作者完整读取。')
    if(!fresh.length)return
    const catalogRevision=catalog.privateAlbumBrowserRevision(),scanRevision=localScan.privateAlbumBrowserRevision()
    const writes:LocalLibraryManagementWrite[]=fresh.map(resolved=>{const captureId=resolved.capture.readToken,root=catalog.root(resolved.capture.rootId)
      const pin={libraryId:root.id,sourceRootId:root.sourceRootId,rootRevision:root.revision},ref={albumId:resolved.capture.albumId,rootId:root.id,revision:resolved.group.summary.revision}
      const original:LocalLibraryManagementCaptureRecord['original']={mode:'albums',request:{albums:[ref]},captureId,watermark:resolved.datasetRevision,catalogRevision,scanRevision,libraries:[pin],albumRefs:[ref],albums:[{...pin,resolved:structuredClone(resolved)}]}
      return {record:{schema:1,kind:'capture',datasetId,key:captureId,revision:1,original,originalSha256:localLibraryManagementDigest(original)},expectedRevision:null}})
    const finishCommit=startWorkbenchCapturePhase('REMEMBER_COMMIT',writes.length)
    catalog.privateLibraryManagementCompareAndSwap(identity,writes);check(context)
    finishCommit()
  }
  async function readFrozenAlbum(scope:dto.LocalLyricsScope):Promise<LocalLibraryManagementFrozenAlbum> {
    check();if(!dto.isLocalLyricsScope(scope)||scope.datasetId!==datasetId)return invalid('原歌词范围不属于此工作库。')
    const selected=catalog.privateLibraryManagementReadFrozenAlbum(identity,scope)
    if(!selected)return invalid('原完整捕获不存在或不包含该专辑。')
    const album=selected.album
    const root=catalog.root(scope.libraryId),binding=catalog.privateLibraryManagementRead(identity,'binding',scope.libraryId)
    if(root.role!=='library'||root.sourceRootId!==album.sourceRootId||root.revision!==album.rootRevision||binding?.record.active===false||!catalog.privateLibraryManagementRootAvailable(scope.libraryId))return changed()
    const members=await frozenReadMembers.get(workbench)!(scope.albumId,scope.libraryId);check()
    const before=album.resolved.group.members.map(m=>({trackId:m.fact.summary.track.id,assetId:m.fact.summary.asset.id})),keys=(list:readonly {trackId:string;assetId:string}[])=>list.map(m=>canonical(m)).sort()
    if(!same(keys(members),keys(before)))return changed()
    // 原await后再核同一完整record pins及所选原件；不以当前成员页替换冻结范围。
    const current=catalog.privateLibraryManagementReadFrozenAlbum(identity,scope)
    if(!current||!same(current.captureRecord,selected.captureRecord)||!same(current.managementCapture,selected.managementCapture)
      ||!same(current.album,album))return changed()
    return freezeLocalWorkbenchValue({resolved:album.resolved,captureRecord:selected.captureRecord,managementCapture:selected.managementCapture})
  }
  const lyricsLibraryAuthor:LocalLyricsLibraryAuthor={
    async capture(library){check();if(!dto.isLocalLyricsLibraryRequest(library)||library.datasetId!==datasetId)return invalid()
      const record=captureRecord(library.captureId)
      if(record.original.mode!=='library'||!record.original.libraries.some(p=>p.libraryId===library.libraryId))return invalid('全库原范围不存在。')
      const key=canonical(library),deadline=libraryDeadlines.get(key)??now()+480000;libraryDeadlines.set(key,deadline)
      if(libraryDeadlines.size>10000)return limit()
      const authorityRef=Object.freeze({}),value:LocalLyricsLibraryCapture={library:structuredClone(library),authorityRef,watermark:record.original.watermark,deadlineAtMs:deadline}
      libraryProofs.set(authorityRef,{record,libraryId:library.libraryId,deadline});await this.assertCurrent(value);return value},
    async assertCurrent(value){check();const proof=libraryProofs.get(value.authorityRef)
      if(!proof||value.library.datasetId!==datasetId||value.library.libraryId!==proof.libraryId||value.library.captureId!==proof.record.key||value.watermark!==proof.record.original.watermark||value.deadlineAtMs!==proof.deadline||now()>=proof.deadline)return changed()
      const current=catalog.privateLibraryManagementReadCaptureHeader(identity,proof.record.key)
      if(!current)return invalid('完整原捕获不存在，不能从当前分页替换。')
      if(current.originalSha256!==proof.record.originalSha256)return changed()
      const pin=proof.record.original.libraries.find(p=>p.libraryId===proof.libraryId)!,root=catalog.root(pin.libraryId)
      if(root.role!=='library'||root.revision!==pin.rootRevision||root.sourceRootId!==pin.sourceRootId||catalog.privateLibraryManagementRead(identity,'binding',pin.libraryId)?.record.active===false)return changed()},
    async page(value,cursor){await this.assertCurrent(value);const proof=libraryProofs.get(value.authorityRef)!,all=proof.record.original.albums.filter(a=>a.libraryId===proof.libraryId)
      const offset=cursor===null?0:Number(cursor)
      if(cursor!==null&&(!/^\d+$/u.test(cursor)||String(offset)!==cursor)||!Number.isSafeInteger(offset)||offset<0||offset>all.length)return invalid('原库分页游标无效。')
      const scopes=all.slice(offset,offset+200).map(a=>({datasetId,libraryId:proof.libraryId,albumId:a.resolved.capture.albumId,captureId:proof.record.key}))
      const next=offset+scopes.length<all.length?String(offset+scopes.length):null
      return {scopes,next,total:all.length,watermark:proof.record.original.watermark}},
    async resolveAlbumReadToken(scope){const {resolved}=await readFrozenAlbum(scope);check()
      return frozenReadAuthors.get(workbench)!(resolved,()=>{check();const actual=catalog.privateLibraryManagementReadFrozenAlbum(identity,scope);if(!actual||!same(actual.album.resolved,resolved))return changed()}, {})},
    async readAlbumPresence(value,scope){await this.assertCurrent(value)
      if(scope.datasetId!==datasetId||scope.libraryId!==value.library.libraryId||scope.captureId!==value.library.captureId)return changed()
      const {resolved}=await readFrozenAlbum(scope),tracks=resolved.capture.members.filter(m=>m.trackId!==null)
      if(!tracks.length)return 'unknown'
      let missing=false
      for(const member of tracks){if(member.fileRevision===null)return 'unknown';const actual=catalog.privateLyricsTrackFacts(datasetId,member.trackId!,scope.libraryId,member.fileRevision)
        const presence=actual.lrc==='true'||actual.embedded==='true'?'true':actual.lrc==='unknown'||actual.embedded==='unknown'?'unknown':'false'
        if(presence==='unknown')return 'unknown';if(presence==='false')missing=true}
      return missing?'false':'true'},
  }
  async function importConfirm(original:Extract<LocalLibraryManagementOriginalOperation,{command:'library.import.confirm'}>,context:LocalWorkbenchReadContext):Promise<dto.LocalLibraryManagementOperation> {
    const previous=knownOperation(original)
    if(catalog.privateLibraryManagementRead(identity,'job',original.request.commandId))return invalid('原任务编号不能改作目录批准。')
    if(previous&&['succeeded','failed','cancelled'].includes(previous.receipt.state))return previous.receipt
    const port=options.imports;if(!port)return invalid('实际目录审批作者未装配。')
    // 原body先同SQL落账；审批仅恢复原回执，缺失的首次扫描仍由同command补全。
    let operation=previous??newOperation(original,[],'running')
    if(!previous)write(operation,null)
    let root:dto.LibraryRoot|undefined
    try{
      if(previous){const recovered=await port.readOriginal(original.request.commandId,context);check(context)
        if(recovered&&!same(recovered.original,original))return invalid('原批准命令正文不匹配。')
        if(recovered?.state==='succeeded')root=recovered.root
      }else{root=await port.confirm(original.request,context);check(context)}
      if(!root){if(operation.receipt.state!=='unknown'){operation={...structuredClone(operation),revision:operation.revision+1,receipt:{...operation.receipt,state:'unknown'}};write(operation,operation.revision-1)}return operation.receipt}
      if(!dto.isLibraryRoot(root)||root.role!=='library'||!same(catalog.root(root.id),root))return invalid('目录批准没有给出同SQL实际原Root。')
      await options.startInitialScan?.(original.request.commandId,root,context);check(context)
      if(!same(catalog.root(root.id),root)||!catalog.privateLibraryManagementRootAvailable(root.id))return changed()
      const old=catalog.privateLibraryManagementRead(identity,'binding',root.id)
      const next:LocalLibraryManagementOperationRecord={...structuredClone(operation),revision:operation.revision+1,receipt:{...operation.receipt,state:'succeeded',libraryIds:[root.id]}}
      const binding:LocalLibraryManagementBindingRecord={schema:1,kind:'binding',datasetId,key:root.id,revision:(old?.record.revision??0)+1,libraryId:root.id,sourceRootId:root.sourceRootId,rootRevision:root.revision,role:original.request.role,
        name:old?.record.name??(await views(context)).find(v=>v.root.id===root!.id)?.label??'本地库',active:true,watchEnabled:old?.record.watchEnabled??false,operationId:next.key}
      check(context);if(!same(catalog.root(root.id),root)||!catalog.privateLibraryManagementRootAvailable(root.id))return changed()
      catalog.privateLibraryManagementCompareAndSwap(identity,[{record:binding,expectedRevision:old?.record.revision??null},{record:next,expectedRevision:operation.revision}]);check(context);return next.receipt
    }catch{
      const actual=operationRecord(original.request.commandId)!.record
      if(actual.receipt.state==='succeeded')return actual.receipt
      if(actual.receipt.state!=='unknown'){const next={...structuredClone(actual),revision:actual.revision+1,receipt:{...actual.receipt,state:'unknown' as const}};write(next,actual.revision);return next.receipt}
      return actual.receipt
    }
  }
  async function removeLibraries(request:dto.LocalLibraryManagementPayloads['library.remove'],context:LocalWorkbenchReadContext):Promise<dto.LocalLibraryManagementOperation>{
    const original:LocalLibraryManagementOriginalOperation={command:'library.remove',request};
    const accepted=await exclusively(()=>{check(context);const known=knownOperation(original);if(known)return {kind:'known' as const,known};
      if(!options.removeResources)return invalid('本库的实际资源join作者未装配，未撤绑定或清缓存。');
      if(catalog.privateLibraryManagementRead(identity,'job',request.commandId))return invalid('原任务编号不能改作撤销命令。');
      const targets=request.libraryIds.map(removalTarget),operation=newOperation(original,request.libraryIds,'running');write(operation,null);return {kind:'new' as const,targets,operation};});
    if(accepted.kind==='known')return accepted.known.receipt;
    const {targets,operation}=accepted;
    try{
      // 释放管理serial再stop/join；原job最终checkpoint仍需要同一队列，不能在队列内等待自身。
      const ids=new Set(request.libraryIds);
      for(const job of catalog.privateLibraryManagementJobs(identity))if(job.original.expandedSelection.some(item=>ids.has(item.rootId))){
        if(job.original.expandedSelection.some(item=>!ids.has(item.rootId))&&['queued','running','unknown'].includes(job.checkpoint.state))return invalid('原任务跨库共享，尚无单库叶join口；保留其它库任务并拒绝本次撤绑定。');
        if(['queued','running'].includes(job.checkpoint.state))await stopJob(job.key);
        if(!options.jobs)return invalid('原AI/CUE join作者缺失，管理绑定与缓存保留。');
        await options.jobs.join(jobRecord(job.key));const actual=jobRecord(job.key);
        if(actual.checkpoint.state==='unknown'||actual.checkpoint.items.some(item=>['running','unknown'].includes(item.state)))return invalid('原AI/CUE物理结果未确认，不能撤绑定。');
      }
      for(const target of targets){const root=target.root;await traceLibraryRemoval('owner.execute',operation.key,()=>options.removeResources!(root.id,context,request.libraryIds,{commandId:operation.key,originalSha256:operation.originalSha256},
        {libraryId:root.id,sourceRootId:root.sourceRootId,rootRevision:root.revision,bindingSha256:target.binding?.recordSha256??null}));check(context);}
      return await traceLibraryRemoval('owner.commit',operation.key,()=>exclusively(()=>{check(context);options.assertRemoveCurrent?.(context);const actual=operationRecord(request.commandId);
        if(!actual||actual.record.originalSha256!==operation.originalSha256||actual.record.revision!==1)return changed();
        const writes:LocalLibraryManagementWrite[]=targets.map(target=>{const root=target.root,binding=target.binding,current=catalog.privateLibraryManagementRead(identity,'binding',root.id);
          if(!same(catalog.root(root.id),root)||(binding?(!current||current.recordSha256!==binding.recordSha256):current!==null))return changed();
          if(binding)return {record:{...structuredClone(binding.record),revision:binding.record.revision+1,operationId:request.commandId,active:false,watchEnabled:false},expectedRevision:binding.record.revision};
          const tombstone:LocalLibraryManagementBindingRecord={schema:1,kind:'binding',datasetId,key:root.id,revision:1,libraryId:root.id,sourceRootId:root.sourceRootId,rootRevision:root.revision,
            role:'catalog',name:'本地库',active:false,watchEnabled:false,operationId:request.commandId};
          return {record:tombstone,expectedRevision:null};});
        const finished:LocalLibraryManagementOperationRecord={...operation,revision:2,receipt:{...operation.receipt,state:'succeeded',message:'原本库资源已join；专属未引用封面staging已清理，音乐、保存封面/LRC、他库及不可变历史保留。'}};
        writes.push({record:finished,expectedRevision:1});options.assertRemoveCurrent?.(context);catalog.privateLibraryManagementCompareAndSwap(identity,writes);check(context);return finished.receipt;}));
    }catch{return exclusively(()=>{check();const actual=operationRecord(request.commandId);if(!actual)return invalid();
      if(actual.record.receipt.state==='succeeded')return actual.record.receipt;
      if(actual.record.revision===1)write({...structuredClone(actual.record),revision:2,receipt:{...actual.record.receipt,state:'unknown',message:'原本库资源join或同SQL清理尚未确认；绑定与未清材料保留，只查询原命令。'}},1);
      return operationRecord(request.commandId)!.record.receipt;});}
  }
  async function mutate(original:LocalLibraryManagementOriginalOperation,context:LocalWorkbenchReadContext):Promise<dto.LocalLibraryManagementOperation> {
    check(context);if(original.command==='library.import.confirm')return importConfirm(original,context)
    const old=knownOperation(original);if(old)return old.receipt
    if(catalog.privateLibraryManagementRead(identity,'job',original.request.commandId))return invalid('原任务编号不能改作库管理操作。')
    const command=original.command,request=original.request
    const ids=command==='library.remove'?(request as dto.LocalLibraryManagementPayloads['library.remove']).libraryIds:
      command==='library.settings.save'?[]:[(request as {libraryId:string}).libraryId]
    const bindings=ids.map(activeBinding)
    if(command==='library.watch.set'||command==='library.remove'){if(!options.watch)return invalid('实际watch作者未装配，尚未更改绑定。')}
    if(command==='library.snapshot.load'||command==='library.snapshot.retry')if(!options.activateSnapshot)return invalid('实际完成快照视图作者未装配。')
    let operation=newOperation(original,ids,'running');write(operation,null)
    try{
      if(command==='library.settings.save'){
        const current=settings.read(identity);settings.save(identity,{schema:1,datasetId,eventId:randomUUID(),commandId:request.commandId,expectedRevision:current.revision,kind:'settings',settings:{revision:String(BigInt(current.revision)+1n),albumConcurrency:(request as dto.LocalLibraryManagementPayloads['library.settings.save']).scanConcurrency}})
      }else if(command==='library.watch.set'){
        const p=request as dto.LocalLibraryManagementPayloads['library.watch.set'];if(p.enabled)await options.watch!.enable(p.libraryId);else await options.watch!.disable(p.libraryId)
        if(options.watch!.watching(p.libraryId)!==p.enabled)return invalid('真实watch未完成READY或STOP，原操作待核对。')
      }else if(command==='library.remove'){
        for(const id of ids){await options.watch!.remove(id);if(options.watch!.watching(id))return invalid('原watch仍在运行，未撤销管理绑定。')}
      }else if(command==='library.snapshot.load'||command==='library.snapshot.retry'){
        let snapshot=options.completedSnapshots.load(ids[0]!)
        if(command==='library.snapshot.retry'){
          if(!snapshot.retryJobId)return invalid('没有明确失败的原快照可重试。')
          if(!options.beforeSnapshotRetry)return invalid('实际原扫描facts重验作者未装配，未创建retry快照。')
          await options.beforeSnapshotRetry(ids[0]!,snapshot.retryJobId,context);check(context)
          snapshot=options.completedSnapshots.retry(snapshot.retryJobId)
        }
        if(!snapshot.lastSuccess)return invalid('实际最近成功快照不可用。')
        if(command==='library.snapshot.retry'&&snapshot.status!=='ready')throw new LocalWorkbenchPlanError('CHANGED','原快照重试未完成，最近成功快照保留。')
        await options.activateSnapshot!(ids[0]!,snapshot.lastSuccess,original,context)
      }
      check(context);operation={...operation,revision:2,receipt:{...operation.receipt,state:'succeeded'}}
      const writes:LocalLibraryManagementWrite[]=[]
      if(['library.rename','library.remove','library.watch.set'].includes(command))for(const b of bindings){const current=catalog.privateLibraryManagementRead(identity,'binding',b.record.key);if(!current||current.recordSha256!==b.recordSha256)return changed()
        const next:LocalLibraryManagementBindingRecord={...structuredClone(b.record),revision:b.record.revision+1,operationId:request.commandId}
        if(command==='library.rename')next.name=(request as dto.LocalLibraryManagementPayloads['library.rename']).name
        else if(command==='library.remove'){next.active=false;next.watchEnabled=false}
        else next.watchEnabled=(request as dto.LocalLibraryManagementPayloads['library.watch.set']).enabled
        writes.push({record:next,expectedRevision:b.record.revision})}
      writes.push({record:operation,expectedRevision:1});catalog.privateLibraryManagementCompareAndSwap(identity,writes);check(context);return operation.receipt
    }catch{
      // 物理动作/COMMIT曾被送出；失败或失联保持原id为UNKNOWN，不自动重放。
      const actual=operationRecord(request.commandId);if(actual?.record.receipt.state==='succeeded')return actual.record.receipt
      if(actual?.record.revision===1){operation={...actual.record,revision:2,receipt:{...actual.record.receipt,state:'unknown'}};write(operation,1)}
      return operationRecord(request.commandId)!.record.receipt
    }
  }
  function jobRecord(id:string):Readonly<LocalLibraryManagementJobRecord> {
    const stored=catalog.privateLibraryManagementRead(identity,'job',id);if(!stored)return invalid('原全库任务不存在。');return stored.record
  }
  function publicJob(record:Readonly<LocalLibraryManagementJobRecord>,offset=0,limit=200):dto.LocalLibraryBatchPage {
    const items=record.checkpoint.items;if(offset>items.length)return invalid('原任务分页超出完整范围。')
    return {jobId:record.key,captureId:record.original.captureId,kind:record.original.start.command==='library.ai.start'?'ai':'cue',state:record.checkpoint.state,totalAlbums:items.length,
      processedAlbums:items.filter(i=>!['queued','running'].includes(i.state)).length,succeededAlbums:items.filter(i=>i.state==='applied').length,failedAlbums:items.filter(i=>i.state==='failed').length,
      offset,items:items.slice(offset,offset+limit).map(i=>({albumId:i.albumId,state:i.state,message:i.message}))}
  }
  function jobInput(record:Readonly<LocalLibraryManagementJobRecord>,index:number,action:LocalLibraryManagementJobAction|null):LocalLibraryManagementJobInput {
    const capture=captureRecord(record.original.captureId),selection=record.original.expandedSelection[index]!,album=capture.original.albums.find(a=>a.resolved.capture.albumId===selection.albumId&&a.libraryId===selection.rootId)
    if(!album||capture.originalSha256!==record.original.captureSha256)return changed()
    return freezeLocalWorkbenchValue({job:structuredClone(record),capture:structuredClone(capture),album:structuredClone(album),selection:structuredClone(selection),action:structuredClone(action)})
  }
  function originalJobAlbum(record:Readonly<LocalLibraryManagementJobRecord>,albumId:string):dto.LocalLibraryJobOriginalEntry|null {
    const index=record.original.expandedSelection.findIndex(value=>value.albumId===albumId)
    if(index<0)return null
    const input=jobInput(record,index,null),resolved=input.album.resolved,summary=resolved.group.summary
    const value:dto.LocalLibraryJobOriginalEntry={datasetId,album:{albumId:summary.id,rootId:input.album.libraryId,title:summary.title,artist:resolved.capture.artistName,
      ...(summary.editionId?{editionId:summary.editionId}:{}),trackIds:[],trackCount:summary.trackCount,revision:summary.revision},
      capture:{albumId:summary.id,readToken:resolved.capture.readToken}}
    if(!dto.isLocalLibraryJobOriginalEntry(value)||summary.rootId!==input.album.libraryId||summary.id!==albumId)return changed()
    return freezeLocalWorkbenchValue(structuredClone(value))
  }
  async function patchJob(id:string,body:(old:Readonly<LocalLibraryManagementJobRecord>)=>LocalLibraryManagementJobRecord):Promise<void> {
    await exclusively(()=>{check();const old=jobRecord(id),next=body(old);write(next,old.revision)})
  }
  function receiptItem(old:Readonly<LocalLibraryManagementJobItem>,receipt:dto.LocalWorkbenchReceipt|null):LocalLibraryManagementJobItem {
    if(receipt!==null&&(!dto.isLocalWorkbenchReceipt(receipt)||receipt.datasetId!==datasetId||receipt.commandId!==old.commandId||receipt.planId!==old.planId||!receipt.items.some(i=>i.albumId===old.albumId)))return invalid('原执行回执身份不一致。')
    const state=receipt?.state==='succeeded'?'applied':receipt?.state==='failed'?'failed':receipt?.state==='cancelled'?'cancelled':'unknown'
    return {...structuredClone(old),state,receipt:structuredClone(receipt),message:state==='unknown'?'原执行结果尚未确认，只查询原命令。':receipt?.message??null}
  }
  async function runJob(id:string,signal:AbortSignal,action:LocalLibraryManagementJobAction|null):Promise<void> {
    const port=options.jobs!;let failedJoin=false
    try{
      await patchJob(id,old=>({...structuredClone(old),revision:old.revision+1,checkpoint:{...structuredClone(old.checkpoint),state:'running',action:null}}))
      for(let index=0;index<jobRecord(id).checkpoint.items.length;index++){
        if(signal.aborted)break
        const original=jobRecord(id),item=original.checkpoint.items[index]!
        if(item.state!=='queued')continue
        const input=jobInput(original,index,action);let attempt:LocalLibraryManagementAttempt|null=null
        try{
          attempt=await port.prepare(input,{signal});check();if(signal.aborted)break
          if(attempt===null){await patchJob(id,old=>({...structuredClone(old),revision:old.revision+1,checkpoint:{...structuredClone(old.checkpoint),action:null,items:old.checkpoint.items.map((i,n)=>n===index?{...i,state:'review',message:'原作者要求人工确认，尚未写入。'}:i)}}));continue}
          if(!isLocalWorkbenchDataRecord(attempt,['planId','commandId'])||![attempt.planId,attempt.commandId].every(dto.isLocalWorkbenchIdentity))return invalid('原执行作者没有实际plan/command。')
          await patchJob(id,old=>({...structuredClone(old),revision:old.revision+1,checkpoint:{...structuredClone(old.checkpoint),action:null,items:old.checkpoint.items.map((i,n)=>n===index?{...i,state:'running',planId:attempt!.planId,commandId:attempt!.commandId}:i)}}))
          const receipt=await port.run(input,attempt,{signal});check()
          await patchJob(id,old=>({...structuredClone(old),revision:old.revision+1,checkpoint:{...structuredClone(old.checkpoint),action:null,items:old.checkpoint.items.map((i,n)=>n===index?receiptItem(i,receipt):i)}}))
        }catch(error){
          if(attempt!==null){let receipt:dto.LocalWorkbenchReceipt|null=null;try{receipt=await port.readOriginal(input,attempt,{})}catch{ /* 原receipt未知，仍保留同UUID。 */ }
            await patchJob(id,old=>({...structuredClone(old),revision:old.revision+1,checkpoint:{...structuredClone(old.checkpoint),action:null,items:old.checkpoint.items.map((i,n)=>n===index?receiptItem(i,receipt):i)}}))}
          else await patchJob(id,old=>({...structuredClone(old),revision:old.revision+1,checkpoint:{...structuredClone(old.checkpoint),action:null,items:old.checkpoint.items.map((i,n)=>n===index?{...i,state:signal.aborted?'cancelled':error instanceof LocalWorkbenchPlanError?'failed':'unknown',message:signal.aborted?'原任务已停止。':error instanceof LocalWorkbenchPlanError?'原准备明确失败，未受理写入。':'原准备响应未知，只查询原job，不能换UUID重发。'}:i)}}))
          if(signal.aborted)break
        }
      }
    }finally{
      try{await port.join(jobRecord(id))}catch{failedJoin=true}
      if(!signal.aborted||failedJoin)await patchJob(id,old=>{const items=old.checkpoint.items,unknown=failedJoin||items.some(i=>i.state==='unknown'||i.state==='running'),failed=items.some(i=>i.state==='failed'),queued=items.some(i=>i.state==='queued')
        const state=unknown?'unknown':queued?'partial':failed?(items.some(i=>i.state==='applied'||i.state==='review')?'partial':'failed'):'complete'
        return {...structuredClone(old),revision:old.revision+1,checkpoint:{...structuredClone(old.checkpoint),action:null,state}}})
      const actual=jobRecord(id),flight=flights.get(id)
      if(!failedJoin&&flight&&actual.checkpoint.state!=='unknown'&&!actual.checkpoint.items.some(item=>['running','unknown'].includes(item.state))){
        if(!jobJoins.has(id)&&jobJoins.size>=MAX_MEMBERS)jobJoins.delete(jobJoins.keys().next().value!)
        jobJoins.set(id,{identity,datasetId,originalSha256:actual.originalSha256,work:flight.work})
      }else jobJoins.delete(id)
    }
  }
  function launch(id:string,action:LocalLibraryManagementJobAction|null):void {
    if(flights.has(id))return invalid('原任务仍在运行，不能重复受理。')
    jobJoins.delete(id)
    const controller=new AbortController(),work=Promise.resolve().then(()=>runJob(id,controller.signal,action)).finally(()=>{flights.delete(id)})
    flights.set(id,{controller,work,action});void work.catch(()=>{})
  }
  function cueCandidates(album:Readonly<LocalLibraryManagementCapturedAlbum>):readonly string[] {
    const r=album.resolved
    return r.directoryFacts.cues.filter(c=>{const parsed=c.item.result
      return r.availability==='online'&&c.item.outcome==='accepted'&&parsed&&r.group.issues.some(i=>i.kind==='cue'&&i.relative===c.item.relative)
        &&new Set(parsed.tracks.map(t=>t.assetReference.assetId)).size<parsed.tracks.length
        &&parsed.tracks.every(t=>{const ref=t.assetReference,m=r.capture.members.find(m=>m.assetId===ref.assetId),f=r.directoryFacts.files.find(f=>f.currentRelative===ref.relative)
          return ref.libraryRootId===album.libraryId&&ref.sourceRootId===album.sourceRootId&&ref.rootRevision===album.rootRevision&&m&&m.fileRevision===ref.fileRevision&&m.locationRevision===ref.locationRevision&&f?.value.outcome==='accepted'&&f.value.assetId===ref.assetId&&f.value.signature===ref.signature})
    }).map(c=>c.id)
  }
  async function startJob(start:LocalLibraryManagementStart):Promise<dto.LocalLibraryBatchPage> {
    check();const stored=catalog.privateLibraryManagementRead(identity,'job',start.request.commandId)
    if(stored){if(!same(stored.record.original.start,start))return invalid('原任务编号不能换请求。');return publicJob(stored.record)}
    if(operationRecord(start.request.commandId))return invalid('原命令编号已用于其他操作。')
    if(!options.jobs||!['prepare','run','readOriginal','join'].every(name=>typeof options.jobs![name as keyof LocalLibraryManagementJobPort]==='function'))return invalid('真实AI/CUE任务作者未装配，未写queued。')
    const capture=captureRecord(start.request.captureId),all=capture.original.albums
    if(capture.original.libraries.some(pin=>!catalog.privateLibraryManagementRootAvailable(pin.libraryId)))return changed()
    let selected:LocalLibraryManagementJobRecord['original']['expandedSelection']
    if(start.command==='library.ai.start')selected=start.request.selection==='selected'?start.request.albumIds.map(id=>{const ref=capture.original.albumRefs.find(r=>r.albumId===id);if(!ref)return changed();return {...ref,cueId:null}}):all.filter(a=>a.resolved.group.summary.statuses.includes('missing-artwork')).map(a=>({...capture.original.albumRefs.find(r=>r.albumId===a.resolved.capture.albumId)!,cueId:null}))
    else if(start.request.selection==='selected')selected=start.request.selections.map(s=>{const album=all.find(a=>a.resolved.capture.albumId===s.albumId);if(!album||!cueCandidates(album).includes(s.cueId))return invalid('所选CUE未取得完整原作者绑定。');return {...capture.original.albumRefs.find(r=>r.albumId===s.albumId)!,cueId:s.cueId}})
    else selected=all.filter(a=>a.resolved.group.summary.statuses.includes('cue-unsplit')).map(a=>{const candidates=cueCandidates(a);return {...capture.original.albumRefs.find(r=>r.albumId===a.resolved.capture.albumId)!,cueId:candidates.length===1?candidates[0]!:null}})
    const original:LocalLibraryManagementJobRecord['original']={start:structuredClone(start),startSha256:localLibraryManagementDigest(start),captureId:capture.key,captureSha256:capture.originalSha256,expandedSelection:structuredClone(selected)}
    const record:LocalLibraryManagementJobRecord={schema:1,kind:'job',datasetId,key:start.request.commandId,revision:1,original,originalSha256:localLibraryManagementDigest(original),
      checkpoint:{state:'queued',action:null,items:selected.map(s=>({albumId:s.albumId,state:start.command==='library.cue.start'&&s.cueId===null?'review':'queued',message:null,planId:null,commandId:null,receipt:null}))}}
    write(record,null);launch(record.key,null);return publicJob(record)
  }
  async function recoverJob(id:string):Promise<Readonly<LocalLibraryManagementJobRecord>> {
    let record=jobRecord(id)
    if(flights.has(id)||!['queued','running','unknown'].includes(record.checkpoint.state))return record
    // 冷开只读原attempt，queued未受理叶不能凭旧JSON自动执行。
    const items:LocalLibraryManagementJobItem[]=record.checkpoint.items.map(i=>structuredClone(i))
    for(let i=0;i<items.length;i++){const item=items[i]!
      if(item.commandId&&item.planId&&['running','unknown'].includes(item.state)&&options.jobs){let receipt:dto.LocalWorkbenchReceipt|null=null
        try{receipt=await options.jobs.readOriginal(jobInput(record,i,null),{commandId:item.commandId,planId:item.planId},{})}catch{}
        items[i]=receiptItem(item,receipt)
      }else if(['queued','running'].includes(item.state))items[i]={...item,state:'unknown',message:'冷开只查询原请求，不能自动重发。'}
    }
    const state:LocalLibraryManagementJobRecord['checkpoint']['state']=items.some(i=>i.state==='unknown')?'unknown':items.some(i=>i.state==='failed')?'partial':'complete'
    if(!same(items,record.checkpoint.items)||state!==record.checkpoint.state){const next:LocalLibraryManagementJobRecord={...structuredClone(record),revision:record.revision+1,checkpoint:{state,action:null,items}};write(next,record.revision);record=jobRecord(id)}
    return record
  }
  async function stopJob(id:string):Promise<dto.LocalLibraryBatchPage> {
    check();let record=jobRecord(id)
    if(!['queued','running','partial','failed','stopped'].includes(record.checkpoint.state))return invalid('原任务当前状态不能stop。')
    const originalSha256=record.originalSha256,flight=flights.get(id),prior=jobJoins.get(id)
    if(prior&&(prior.identity!==identity||prior.datasetId!==datasetId||prior.originalSha256!==record.originalSha256))jobJoins.delete(id)
    if(!flight&&!jobJoins.has(id))return invalid('缺少当前原任务的实际done与join闭口事实，只能查询原id。')
    const originalWork=flight?.work??jobJoins.get(id)!.work
    flight?.controller.abort()
    let joined=true
    try{await originalWork}catch{joined=false}
    check();record=jobRecord(id)
    const proof=jobJoins.get(id),afterWork=flights.get(id)
    if(record.originalSha256!==originalSha256||proof&&proof.work!==originalWork||afterWork&&afterWork.work!==originalWork)return invalid('原任务在done期间已变化，请查询原id。')
    if(!proof||proof.identity!==identity||proof.datasetId!==datasetId||proof.originalSha256!==originalSha256)joined=false
    if(joined&&options.jobs){try{await options.jobs.join(record)}catch{joined=false}}else joined=false
    return exclusively(()=>{
      check();record=jobRecord(id)
      // 显式resume/retry或不同原件不能借刚才的旧done；不取消新run或重签旧许可。
      const currentFlight=flights.get(id)
      if(record.originalSha256!==originalSha256||currentFlight&&currentFlight.work!==originalWork||jobJoins.get(id)!==proof)return invalid('原任务在join期间已变化，请查询原id。')
      if(record.checkpoint.state==='unknown')return publicJob(record)
      const action:LocalLibraryManagementJobAction={command:'library.job.stop',request:{jobId:id}}
      if(!joined){
        jobJoins.delete(id)
        if(record.checkpoint.state==='complete')return invalid('原完整回执保留；实际join未确认，不能签闭口。')
        const uncertain:LocalLibraryManagementJobRecord={...structuredClone(record),revision:record.revision+1,checkpoint:{...structuredClone(record.checkpoint),state:'unknown',action:['queued','running'].includes(record.checkpoint.state)?action:null}}
        write(uncertain,record.revision);return publicJob(uncertain)
      }
      if(record.checkpoint.items.some(item=>['running','unknown'].includes(item.state)))return invalid('原完整任务仍含未闭项，只能查询原id。')
      if(['complete','stopped'].includes(record.checkpoint.state))return publicJob(record)
      const items=record.checkpoint.items.map(item=>item.state==='queued'?{...item,state:'cancelled' as const}:item)
      if(['partial','failed'].includes(record.checkpoint.state)){
        // 已产出/失败历史保原状态与回执；仅撤尚未受理选择，不伪造journal的stop状态转移。
        if(!record.checkpoint.items.some(item=>item.state==='queued'))return publicJob(record)
        const next:LocalLibraryManagementJobRecord={...structuredClone(record),revision:record.revision+1,checkpoint:{...structuredClone(record.checkpoint),action:null,items}}
        write(next,record.revision);return publicJob(next)
      }
      const next:LocalLibraryManagementJobRecord={...structuredClone(record),revision:record.revision+1,checkpoint:{state:'stopped',action,items}}
      write(next,record.revision);return publicJob(next)
    })
  }
  async function restartJob(action:Extract<LocalLibraryManagementJobAction,{command:'library.job.resume'|'library.job.retry'}>):Promise<dto.LocalLibraryBatchPage> {
    check();if(!options.jobs)return invalid('实际任务作者未装配。')
    const record=jobRecord(action.request.jobId);if(flights.has(record.key))return invalid('原任务尚未join，不能再次受理。')
    // 冷实例没有flight不表示原任务已收口；核完整checkpoint，不能只看首页或请求failed子集。
    if(['queued','running','unknown'].includes(record.checkpoint.state)||record.checkpoint.items.some(item=>['queued','running','unknown'].includes(item.state)))return invalid('原任务包含未确认或尚未收口的执行项，只能查询原id。')
    if(action.command==='library.job.resume'&&record.checkpoint.state!=='stopped'||action.command==='library.job.retry'&&!action.request.albumIds.every(id=>record.checkpoint.items.some(i=>i.albumId===id&&i.state==='failed')))return invalid('只能resume原stopped或retry明确failed子集；UNKNOWN只查原id。')
    const hasApplied=(item:Readonly<LocalLibraryManagementJobItem>)=>item.receipt?.items.some(track=>track.state==='applied')===true
    if(action.command==='library.job.retry'&&record.checkpoint.items.some(item=>action.request.albumIds.includes(item.albumId)&&hasApplied(item)))return invalid('原部分输出已保留，只能查询同一回执，不能重编码整专辑。')
    const items=record.checkpoint.items.map(i=>(action.command==='library.job.resume'?i.state==='cancelled'&&!hasApplied(i):action.request.albumIds.includes(i.albumId))?{...i,state:'queued' as const,message:null,planId:null,commandId:null,receipt:null}:i)
    if(!items.some(item=>item.state==='queued'))return publicJob(record)
    const next:LocalLibraryManagementJobRecord={...structuredClone(record),revision:record.revision+1,checkpoint:{state:'queued',action:structuredClone(action),items}}
    write(next,record.revision);launch(record.key,action);return publicJob(next)
  }
  const handlers:{[C in dto.LocalLibraryManagementCommand]:(payload:dto.LocalLibraryManagementPayloads[C],context:LocalWorkbenchReadContext)=>Promise<dto.LocalLibraryManagementResults[C]>}={
    'library.read':(_p,c)=>readLibrary(c),'library.import.prepare':async(_p,c)=>{if(!options.imports)return invalid('实际目录审批作者未装配。');return options.imports.prepare(c)},
    'library.import.confirm':(p,c)=>exclusively(()=>mutate({command:'library.import.confirm',request:p},c)),
    'library.capture':(p,c)=>exclusively(()=>captureAll(p,c)),
    'library.album.capture':async(p,c)=>{const result=await workbench.readAlbumTarget(p,c);await exclusively(()=>rememberAlbumReadback(result,c));return result},
    'library.albums.capture':async(p,c)=>{const result=await workbench.readAlbumTargets(p,c);await exclusively(()=>rememberAlbumReadback(result,c));return result},
    'library.rename':(p,c)=>exclusively(()=>mutate({command:'library.rename',request:p},c)),
    'library.remove':(p,c)=>removeLibraries(p,c),
    'library.snapshot.load':(p,c)=>exclusively(()=>mutate({command:'library.snapshot.load',request:p},c)),
    'library.snapshot.retry':(p,c)=>exclusively(()=>mutate({command:'library.snapshot.retry',request:p},c)),
    'library.operation.read':async(p,c)=>{const stored=operationRecord(p.commandId);if(stored){if(stored.record.original.command==='library.import.confirm'&&['running','unknown'].includes(stored.record.receipt.state))return exclusively(()=>importConfirm(stored.record.original as Extract<LocalLibraryManagementOriginalOperation,{command:'library.import.confirm'}>,c));return structuredClone(stored.record.receipt)}
      const imported=await options.imports?.readOriginal(p.commandId,c);check(c);if(imported){if(imported.original.request.commandId!==p.commandId||!dto.isLibraryRoot(imported.root))return invalid();return {commandId:p.commandId,kind:'library.import.confirm',state:imported.state,libraryIds:[imported.root.id],message:null}}
      const original=originals.get(p.commandId);return original?{commandId:p.commandId,kind:original.command,state:'unknown',libraryIds:[],message:null}:null},
    'library.settings.read':async()=>{const value=settings.read(identity);if(!isLocalScanSettings(value))return invalid();return {scanConcurrency:value.albumConcurrency,revision:value.revision}},
    'library.settings.save':(p,c)=>exclusively(()=>mutate({command:'library.settings.save',request:p},c)),
    'library.watch.set':(p,c)=>exclusively(()=>mutate({command:'library.watch.set',request:p},c)),
    'library.ai.start':p=>exclusively(()=>startJob({command:'library.ai.start',request:p})),
    'library.cue.start':p=>exclusively(()=>startJob({command:'library.cue.start',request:p})),
    'library.job.read':async p=>{
      if(!catalog.privateLibraryManagementRead(identity,'job',p.jobId))return null
      // 原条目检查只读持久引用，不进入会settle/CAS的任务恢复路径。
      if(p.albumId!==undefined){const record=jobRecord(p.jobId);return {...publicJob(record,p.offset,p.limit),originalEntry:originalJobAlbum(record,p.albumId)}}
      return publicJob(await recoverJob(p.jobId),p.offset,p.limit)
    },
    'library.job.stop':p=>stopJob(p.jobId),
    'library.job.resume':p=>exclusively(()=>restartJob({command:'library.job.resume',request:p})),
    'library.job.retry':p=>exclusively(()=>restartJob({command:'library.job.retry',request:p})),
  }
  return {
    async execute<C extends dto.LocalLibraryManagementCommand>(command:C,payload:dto.LocalLibraryManagementPayloads[C],context:LocalWorkbenchReadContext={}):Promise<dto.LocalLibraryManagementResults[C]> {
      if(closePromise)return invalid('库管理正在关闭，不能接受新命令。')
      check(context);if(!dto.isLocalLibraryManagementCommand(command)||!dto.isLocalLibraryManagementPayload(command,payload))throw new LocalWorkbenchPlanError('INVALID_REQUEST','库管理请求无效。')
      const result=await handlers[command](structuredClone(payload),context);check(context)
      if(!dto.isLocalLibraryManagementResult(command,result,payload))return invalid('库管理原结果不符合有限合同。')
      const copy=structuredClone(result);freezeLocalWorkbenchValue(copy);return copy
    },
    rememberAlbumReadback:(readback:dto.LocalWorkbenchReadback,context:LocalWorkbenchReadContext={})=>{if(closePromise)return Promise.reject(new LocalWorkbenchPlanError('INVALID_CAPTURE','库管理正在关闭。'));return exclusively(()=>rememberAlbumReadback(readback,context))},
    readFrozenAlbum,lyricsLibraryAuthor,
    async joinJob(id:string):Promise<void>{check();const flight=flights.get(id);if(flight)await flight.work;else if(options.jobs)await options.jobs.join(jobRecord(id));else return invalid('原任务join作者未装配。')},
    close():Promise<void>{if(!closePromise)closePromise=(async()=>{const errors:unknown[]=[]
      // 先abort并join，直到耐久stopped/unknown写入后才撤接受状态。
      await serial
      for(const id of [...flights.keys()])try{await stopJob(id)}catch(error){errors.push(error)}
      await serial;closing=true;try{await options.watch?.close()}catch(error){errors.push(error)}
      libraryDeadlines.clear();jobJoins.clear();if(errors.length)throw new LocalWorkbenchPlanError('INVALID_CAPTURE','库管理物理关闭未完整完成，原回执保留。')
    })();return closePromise},
    inspect:()=>({runningJobs:flights.size,closing}),
  }
}
export type LocalLibraryManagementRuntime=ReturnType<typeof createLocalLibraryManagementRuntime>
