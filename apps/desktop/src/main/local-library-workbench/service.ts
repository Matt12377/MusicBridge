import { captureDatasetNameProviderRequest, datasetNameOriginalStartSha256, DATASET_WORKBENCH_BOUNDS, DATASET_NAME_PROVIDER_CONTENT_BYTES, datasetWorkbenchJson, datasetWorkbenchSha, DatasetNameProviderBridgeError, type DatasetNameProviderRequest, type DatasetNameProviderStart, type DatasetNameProviderRead, type DatasetNameProviderFailure, type DatasetNameProviderState, type DatasetProjectionCommandResults, type DatasetNameProviderCommand } from '../../../../../packages/bridge-core/src/collection/dataset-owner-protocol.js'
import { localLibraryManagementDigest } from '../../../../../packages/bridge-core/src/collection/local-library-workbench/owner-journal.js'
import { isTrackedLocalArtworkProviders } from './providers/artwork-providers.js'
import { isTrackedLocalArtworkWebNavigation } from './providers/artwork-web-navigation.js'
import { isTrackedLocalNameTransport, type TrackedLocalNameTransport, type LocalNamePrivateContent } from './providers/name-transport.js'
import { isDatasetWorkbenchOwnerRequest, isDatasetWorkbenchOwnerResult, type DatasetWorkbenchOwnerCommand, type DatasetWorkbenchOwnerPayloads, type DatasetWorkbenchOwnerResults, isDatasetWorkbenchRequest, isDatasetWorkbenchResult } from '../../../../../packages/bridge-core/src/collection/dataset-owner-protocol.js'
import { types as localBoundaryNodeTypes } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import * as dto from '@music-bridge/contracts'
import type { PhotoDecoderImage } from '../collection-photos.js'
import { LocalArtworkImageError } from '../local-artwork-image.js'
import { normalizeImportedLocalArtwork, probeLocalArtworkImportFormats, type NormalizedImportedLocalArtwork } from './artwork-import-normalizer.js'
import type { LocalWorkbenchMainContext, LocalWorkbenchMainRequest } from './workbench-ipc.js'
import type { createLocalNameSettings } from './name-settings.js'
import type { LocalWorkbenchReadService, LocalWorkbenchResolvedReadCapture } from '../../../../../packages/bridge-core/src/collection/local-library-workbench/read-service.js'
import {
  isLocalWorkbenchArtworkCapture, isLocalWorkbenchPlanCapture,
  type LocalWorkbenchPlanRegistry,
} from '../../../../../packages/bridge-core/src/collection/local-library-workbench/plan-registry.js'
import { isLocalWorkbenchAlbumCapture } from '../../../../../packages/bridge-core/src/collection/local-library-workbench/name-proposal.js'
import {
  LocalWorkbenchPlanError, isLocalWorkbenchDataRecord, isLocalWorkbenchDenseArray,
  type LocalWorkbenchArtworkCapture, type LocalWorkbenchPlanCapture, type LocalWorkbenchPlanDraft, type LocalWorkbenchAlbumCapture,
} from '../../../../../packages/bridge-core/src/collection/local-library-workbench/types.js'
import {
  LocalProviderError, type LocalNameTransport, type LocalArtworkProviders, type LocalArtworkPrivateSource,
  type LocalArtworkRemoteImport, type LocalArtworkSearchSource, type LocalArtworkWebSource,
  type LocalArtworkWebRequest, type LocalArtworkNavigationResult, type createLocalArtworkWebNavigation,
} from './providers/index.js'
import { displayText } from './providers/boundaries.js'
import { checkedRemoteArtworkUrl } from './providers/artwork-urls.js'

type ReadContext = Pick<LocalWorkbenchMainContext, 'signal'>
type Result = dto.LocalWorkbenchCommandResults[dto.LocalWorkbenchCommand]
type OwnerValue<T> = T | Promise<T>
type PreparedPlan<K extends dto.LocalWorkbenchPlan['kind']> = {
  draft: Extract<LocalWorkbenchPlanDraft, { kind: K }>
  capture: LocalWorkbenchPlanCapture
}

/** 原生选择器签发的 Main 私有文件许可；Renderer 路径不能构造此对象。 */
export interface LocalWorkbenchApprovedArtworkFile {
  label: string
  /** 许可端口在打开/读取期间核文件身份并限制为 4 MiB，不能先无界读入。 */
  read(context: ReadContext): Promise<Uint8Array>
  close(): Promise<void>
}
/** 只有实际受保护目录端口能解析路径；公开 choiceId 不等同于文件访问许可。 */
export interface LocalWorkbenchApprovedCueTarget {
  target: dto.LocalCueOutputTarget
  revision: string
  assertCurrent(context: ReadContext): Promise<void>
  withDirectory<T>(operation: (authorizedPath: string) => Promise<T>, context: ReadContext): Promise<T>
  close(): Promise<void>
}
export interface LocalWorkbenchNativeChooser {
  chooseArtwork(context: LocalWorkbenchMainContext): Promise<LocalWorkbenchApprovedArtworkFile | null>
  chooseCueTarget(context: LocalWorkbenchMainContext): Promise<LocalWorkbenchApprovedCueTarget | null>
  /** 当前原host配置可调用；不代表AppKit或Owner Native资格。 */
  readAvailability?(mode: 'artwork' | 'cue-target' | 'library', context: LocalWorkbenchMainContext): Promise<dto.LocalWorkbenchAvailability>
  /** 关闭实际对话框/文件读取后再完成，不用取消确认代替资源退出。 */
  closeReadResources(): Promise<void>
}
export interface LocalWorkbenchOwnerPorts {
  read: Pick<LocalWorkbenchReadService, 'readAlbums' | 'resolveCapture' | 'prepareNameSuggestion' | 'completeNameSuggestion'
    | 'prepareNamePreview' | 'prepareArtworkPreview'> & {
      cancelNamePreparation(preparationId: string): OwnerValue<ReturnType<LocalWorkbenchReadService['cancelNamePreparation']>>
    }
  registry: Pick<LocalWorkbenchPlanRegistry, 'issuePlan' | 'apply' | 'readOriginalReceipt' | 'cancel'> & {
    getPlan(planId: string): OwnerValue<ReturnType<LocalWorkbenchPlanRegistry['getPlan']>>
    readArtworkCapture(request: Parameters<LocalWorkbenchPlanRegistry['readArtworkCapture']>[0]): OwnerValue<ReturnType<LocalWorkbenchPlanRegistry['readArtworkCapture']>>
    operations(): OwnerValue<ReturnType<LocalWorkbenchPlanRegistry['operations']>>
  }
  /** 来自真实 Main/Owner 配置与资格；不把存在一个函数投影成已经可用。 */
  readCapabilities(context: LocalWorkbenchMainContext): Promise<dto.LocalWorkbenchCapabilitiesReply>
  /** 复用原来源读取许可及其 sourceIdentity，不在 Main 自造本地捕获。 */
  readLocalArtwork(resolved: Readonly<LocalWorkbenchResolvedReadCapture>, context: ReadContext): Promise<dto.LocalArtworkSourceCopies>
  /** 必须接实际 CUE/PCM 探测、编码资格与独立目标 actor，随后由原 registry 签发。 */
  prepareCuePreview(request: dto.LocalCueSplitInput, target: LocalWorkbenchApprovedCueTarget, context: ReadContext): Promise<PreparedPlan<'cue'>>
  openExisting(request: dto.LocalWorkbenchExistingRequest, context: LocalWorkbenchMainContext): Promise<dto.LocalWorkbenchExistingReply>
}
export type LocalWorkbenchArtworkSourceRoute =
  | { kind: 'provider'; source: LocalArtworkSearchSource; country?: string }
  | { kind: 'web'; source: LocalArtworkWebSource }
export interface LocalWorkbenchServiceOptions {
  directoryAuthorization?:{enter(request:LocalWorkbenchMainRequest,context:LocalWorkbenchMainContext,targetChoiceId?:string):Promise<object|undefined>}

  owner: LocalWorkbenchOwnerPorts
  names: LocalNameTransport
  artwork: LocalArtworkProviders
  navigation: ReturnType<typeof createLocalArtworkWebNavigation>
  nativeChooser: LocalWorkbenchNativeChooser
  /** 来源编号由 Main 配置映射，Renderer 只选择公开 sourceId。 */
  artworkSources: Readonly<Record<string, LocalWorkbenchArtworkSourceRoute>>
  decode(bytes: Buffer): PhotoDecoderImage
  now?: () => number
  candidateTtlMs?: number
  maxCandidates?: number
  maxCandidateBytes?: number
}
export interface LocalWorkbenchPrivateArtwork {
  datasetId: string
  datasetRevision: string
  capture: dto.LocalWorkbenchCapture
  captureRevision: string
  artwork: LocalWorkbenchArtworkCapture
  /** PNG/JPEG 或 TIFF/WebP 转换后的兼容副本，与 artwork.image.original 一致。 */
  compatibleOriginalBytes: Uint8Array
  privateSource?: LocalArtworkPrivateSource
}
export interface LocalWorkbenchRemoteSourceRequest extends dto.LocalWorkbenchArtworkRequest {
  source: LocalArtworkRemoteImport
}
export interface LocalWorkbenchWebSourceRequest extends dto.LocalWorkbenchArtworkRequest {
  sourceId: string
  query: string
  external?: boolean
}
interface Binding {
  rootId:string
  datasetId: string
  datasetRevision: string
  capture: dto.LocalWorkbenchCapture
  captureRevision: string
  fingerprint: string
}
/** Main私有原remove引用；不是新公开RPC或库/源权限。 */
export interface LocalWorkbenchLibraryRemovalReference {
  datasetId:string
  commandId:string
  libraryIds:readonly string[]
  ownerEpoch:string
  originalSha256:string
}
/** Root私有WORKBENCH_READERS原purpose正文；deadline沿用原端口上下文。 */
export interface LocalWorkbenchLibraryReadersFence {
  commandId:string
  originalSha256:string
  libraryId:string
  datasetId:string
  ownerEpoch:string
}
interface LibraryReadFlight {
  datasetId:string
  controller:AbortController
  task:Promise<unknown>
  required:Set<string>
  roots:Set<string>
  associated:Promise<void>
  associate():void
  failAssociation():void
  bound:boolean
  physicalFailure:boolean
}
interface LibraryPhysicalRead {
  datasetId:string
  rootId:string
  original:Promise<unknown>
  quiet:Promise<void>
  cancel():Promise<void>
  closed:boolean
  failed:boolean
}
interface PrivateArtworkFlight {
  datasetId:string
  rootId:string|null
  associated:Promise<void>
  associate(rootId:string):void
  failAssociation():void
  task:Promise<unknown>
}
interface ArtworkEntry { binding: Binding; public: dto.LocalWorkbenchArtworkCandidate; private: LocalWorkbenchPrivateArtwork; expiresAt: number; bytes: number }
interface NameEntry { binding: Binding; candidate: dto.LocalAiNameCandidate; expiresAt: number; bytes: number }
interface TargetEntry { datasetId: string; permission: LocalWorkbenchApprovedCueTarget; expiresAt: number }
const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex')
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, child]) => JSON.stringify(key) + ':' + canonical(child)).join(',') + '}'
  return JSON.stringify(value) ?? 'null'
}
const same = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right)
const methods = (value: unknown, keys: readonly string[]): boolean => value !== null && typeof value === 'object'
  && keys.every(key => typeof (value as Record<string, unknown>)[key] === 'function')
const invalid = (message = '整理请求或原捕获不一致，请重新读取。'): never => { throw new LocalWorkbenchPlanError('INVALID_REQUEST', message) }
const aborted = (): Error => { const error = new Error('整理读取已取消。'); error.name = 'AbortError'; return error }
const checkSignal = (signal: AbortSignal): void => { if (signal.aborted) throw aborted() }
function safeError(error: unknown, signal: AbortSignal): Error {
  if (signal.aborted || error instanceof Error && error.name === 'AbortError') return aborted()
  if (error instanceof LocalProviderError || error instanceof LocalArtworkImageError || error instanceof LocalWorkbenchPlanError) {
    // 只接受本模块与已有安全边界的固定公开消息，普通上游 Error 从不转交。
    const message = displayText(error.message, 1024)
    if (message && !/(?:[A-Za-z]:[\\/]|\/(?:Users|Volumes|private|tmp)\/|(?:cookie|authorization|bearer|token)\s*[:=])/iu.test(message)) return new Error(message)
  }
  return new Error('整理操作未完成，请重新读取该项状态。')
}
function safeLabel(value: unknown, fallback: string): string {
  const label = displayText(value, 512)
  return label && !/^(?:\/|~\/|[A-Za-z]:[\\/])/u.test(label) ? label : fallback
}
function copyPrivate(value: LocalWorkbenchPrivateArtwork): LocalWorkbenchPrivateArtwork {
  const source = value.privateSource
  return { datasetId: value.datasetId, datasetRevision: value.datasetRevision, capture: { ...value.capture }, captureRevision: value.captureRevision,
    artwork: structuredClone(value.artwork), compatibleOriginalBytes: new Uint8Array(value.compatibleOriginalBytes),
    ...(source ? { privateSource: { ...source, imageUrl: new URL(source.imageUrl.href), sourcePageUrl: source.sourcePageUrl ? new URL(source.sourcePageUrl.href) : null } } : {}) }
}

// 仅由原真实 Main transport 装配登记；该品牌本身不授图片/Provider/Native能力。
const transportOwnerInstances=new WeakSet<object>()

/** 十五项闭集调度；读取不写源，应用与原回执始终委托唯一持久 Owner。 */
export function createLocalWorkbenchService(options: LocalWorkbenchServiceOptions) {
  const owner = options.owner, now = options.now ?? Date.now, ttl = options.candidateTtlMs ?? 10 * 60_000
  let importFormats:readonly dto.LocalArtworkImportFormat[]|undefined
  const originalArtwork=options.artwork,originalNavigation=options.navigation,originalChooser=options.nativeChooser
  const artworkAvailability=originalArtwork.readAvailability,navigationAvailability=originalNavigation.readAvailability,nativeAvailability=originalChooser.readAvailability
  const maxCandidates = options.maxCandidates ?? 128, maxBytes = options.maxCandidateBytes ?? 32 * 1024 * 1024
  if (!methods(owner, ['readCapabilities', 'readLocalArtwork', 'prepareCuePreview', 'openExisting'])
    || !methods(owner?.read, ['readAlbums', 'resolveCapture', 'prepareNameSuggestion', 'completeNameSuggestion', 'prepareNamePreview', 'prepareArtworkPreview', 'cancelNamePreparation'])
    || !methods(owner?.registry, ['issuePlan', 'apply', 'readOriginalReceipt', 'cancel', 'getPlan', 'readArtworkCapture', 'operations'])
    || !methods(options.names, ['suggest', 'stop', 'close']) || !methods(options.artwork, ['search', 'readCandidate', 'importRemoteSource', 'close'])
    || !methods(options.navigation, ['navigate', 'openExternal', 'close']) || !methods(options.nativeChooser, ['chooseArtwork', 'chooseCueTarget', 'closeReadResources'])
    || typeof options.decode !== 'function' || !options.artworkSources
    || !Number.isSafeInteger(ttl) || ttl < 1000 || ttl > 30 * 60_000 || !Number.isSafeInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 512
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024) return invalid('整理工作台需要完整的原 Owner、真实 transport 与原生许可端口。')
  const artworks = new Map<string, ArtworkEntry>(), names = new Map<string, NameEntry>(), targets = new Map<string, TargetEntry>()
  const active = new Set<LibraryReadFlight>(), writes = new Set<Promise<unknown>>()
  const privateArtworkReads = new Set<Promise<LocalWorkbenchPrivateArtwork>>()
  const privateArtworkFlights=new Set<PrivateArtworkFlight>(),failedPrivateArtworkFlights=new Set<PrivateArtworkFlight>(),flightBySignal=new WeakMap<AbortSignal,LibraryReadFlight>()
  const physicalReads=new Set<LibraryPhysicalRead>(),failedFlights=new Set<LibraryReadFlight>()
  const captureRoots=new Map<string,string>(),retiredLibraries=new Set<string>()
  const planRoots=new Map<string,Set<string>>(),planArtworkRefs=new Map<string,Set<string>>(),planNameRefs=new Map<string,Set<string>>()
  const writeRoots=new Map<Promise<unknown>,{datasetId:string;roots:Set<string>|null}>()
  const removalStops=new Map<string,{original:LocalWorkbenchLibraryRemovalReference;promise:Promise<void>}>()
  let privateReadsClosed = false
  let readsClosed = false, closing = false, closed = false, lastNow = now(), closingReads: Promise<void> | null = null, closingService: Promise<void> | null = null
  const check = (context: LocalWorkbenchMainContext): void => {
    if (closed || closing || readsClosed) return invalid('整理读取已结束，请重新打开。')
    if (!dto.isCommandOutboxDatasetId(context.datasetId)) return invalid()
    const flight=flightBySignal.get(context.signal)
    if(flight&&[...flight.roots].some(root=>retiredLibraries.has(root)))flight.controller.abort()
    checkSignal(context.signal)
  }
  const captureKey=(datasetId:string,capture:dto.LocalWorkbenchCapture)=>canonical([datasetId,capture.albumId,capture.readToken])
  function rememberRoot(datasetId:string,capture:LocalWorkbenchAlbumCapture,signal?:AbortSignal):void{
    const key=captureKey(datasetId,capture),prior=captureRoots.get(key)
    if(prior&&prior!==capture.rootId)return invalid('原readToken的库归属已改变，未猜当前曲目。')
    if(!prior&&captureRoots.size>=512)return invalid('原捕获归属缓存达到现有读取预算，未补半捕获。')
    captureRoots.set(key,capture.rootId)
    const flight=signal?flightBySignal.get(signal):undefined
    if(flight){flight.roots.add(capture.rootId);flight.required.delete(key);if(!flight.required.size)flight.associate()}
    if(retiredLibraries.has(capture.rootId)){flight?.controller.abort();return invalid('原库读取已封，保留原命令和材料。')}
  }
  function physical<T>(operation:Promise<T>,rootId:string,context:LocalWorkbenchMainContext,quiet:()=>Promise<void>,cancel:()=>Promise<void>):Promise<T>{
    const original=operation as Promise<unknown>,record:LibraryPhysicalRead={datasetId:context.datasetId,rootId,original,quiet:Promise.resolve(),cancel,closed:false,failed:false}
    const joined=Promise.resolve().then(quiet).then(()=>{record.closed=true;physicalReads.delete(record)},error=>{record.failed=true;throw error})
    record.quiet=joined;physicalReads.add(record);void joined.catch(()=>{})
    return operation
  }
  function artworkOperation<T>(operation:Promise<T>,rootId:string,context:LocalWorkbenchMainContext):Promise<T>{
    if(isTrackedLocalArtworkProviders(options.artwork))options.artwork.associateOriginal(operation,{datasetId:context.datasetId,libraryId:rootId})
    return physical(operation,rootId,context,()=>isTrackedLocalArtworkProviders(options.artwork)?options.artwork.join(operation):Promise.reject(new Error('原封面物理作者未品牌化。')),
      ()=>isTrackedLocalArtworkProviders(options.artwork)?options.artwork.cancelOriginal(operation):Promise.reject(new Error('原封面物理作者未知。')))
  }
  function navigationOperation(operation:Promise<LocalArtworkNavigationResult>,rootId:string,context:LocalWorkbenchMainContext):Promise<LocalArtworkNavigationResult>{
    return physical(operation,rootId,context,()=>isTrackedLocalArtworkWebNavigation(options.navigation)?options.navigation.join(operation):Promise.reject(new Error('原导航producer作者未知。')),
      ()=>isTrackedLocalArtworkWebNavigation(options.navigation)?options.navigation.cancelOriginal(operation):Promise.reject(new Error('原导航producer作者未知。')))
  }
  async function issuePlan<K extends dto.LocalWorkbenchPlan['kind']>(prepared:PreparedPlan<K>,context:LocalWorkbenchMainContext):Promise<dto.LocalWorkbenchPlan>{
    for(const capture of prepared.capture.albums)rememberRoot(prepared.capture.datasetId,capture,context.signal)
    const plan=await owner.registry.issuePlan(prepared.draft,prepared.capture)
    if(!dto.isLocalWorkbenchPlan(plan)||plan.datasetId!==prepared.capture.datasetId)return invalid()
    if(!planRoots.has(plan.planId)&&planRoots.size>=512)return invalid('原计划归属达到现有整组预算。')
    const draft:LocalWorkbenchPlanDraft=prepared.draft
    planRoots.set(plan.planId,new Set(prepared.capture.albums.map(album=>album.rootId)))
    planArtworkRefs.set(plan.planId,new Set(prepared.capture.artwork?.map(artwork=>artwork.candidateId)??[]));planNameRefs.set(plan.planId,new Set(draft.kind==='ai'?draft.candidateIds:[]));return plan
  }
  function prune(): void {
    const time = now()
    if (!Number.isSafeInteger(time) || time < lastNow) { artworks.clear(); names.clear(); for (const item of targets.values()) item.expiresAt = 0; lastNow = time; return }
    lastNow = time
    for (const [id, entry] of artworks) if (entry.expiresAt <= time) artworks.delete(id)
    for (const [id, entry] of names) if (entry.expiresAt <= time) names.delete(id)
  }
  function remember(entries: readonly ArtworkEntry[] | readonly NameEntry[], kind: 'artwork' | 'name'): void {
    prune()
    const ids = entries.map(entry => 'public' in entry ? entry.public.candidateId : entry.candidate.candidateId)
    if (new Set(ids).size !== ids.length || ids.some(id => artworks.has(id) || names.has(id))
      || artworks.size + names.size + entries.length > maxCandidates
      || [...artworks.values(), ...names.values(), ...entries].reduce((total, entry) => total + entry.bytes, 0) > maxBytes) return invalid('候选缓存超过预算；未返回不完整的批次，请缩小范围后重试。')
    if (kind === 'artwork') (entries as readonly ArtworkEntry[]).forEach(entry => artworks.set(entry.public.candidateId, entry))
    else (entries as readonly NameEntry[]).forEach(entry => names.set(entry.candidate.candidateId, entry))
  }
  function binding(resolved: Readonly<LocalWorkbenchResolvedReadCapture>): Binding {
    return { rootId:resolved.capture.rootId,datasetId: resolved.datasetId, datasetRevision: resolved.datasetRevision,
      capture: { albumId: resolved.capture.albumId, readToken: resolved.capture.readToken }, captureRevision: resolved.capture.revision,
      fingerprint: digest([resolved.datasetId, resolved.datasetRevision, resolved.capture]) }
  }
  async function resolve(request: dto.LocalWorkbenchArtworkRequest, context: LocalWorkbenchMainContext) {
    check(context)
    const resolved = await owner.read.resolveCapture({ datasetId: request.datasetId, capture: request.capture }, context)
    if (resolved.datasetId !== context.datasetId || !dto.isLocalWorkbenchIdentity(resolved.datasetRevision) || !isLocalWorkbenchAlbumCapture(resolved.capture)
      || resolved.capture.albumId !== request.capture.albumId || resolved.capture.readToken !== request.capture.readToken
      || !['online', 'offline', 'unavailable'].includes(resolved.availability)) return invalid()
    rememberRoot(resolved.datasetId,resolved.capture,context.signal);check(context)
    return resolved
  }
  function availabilityContext(context:LocalWorkbenchMainContext){
    const signal=context.signal,dataset=context.datasetId,assertCurrent=context.assertCurrent
    const assertUnchanged=()=>{
      if(context.signal!==signal||context.datasetId!==dataset||context.assertCurrent!==assertCurrent
        ||options.owner!==owner||options.artwork!==originalArtwork||options.navigation!==originalNavigation||options.nativeChooser!==originalChooser
        ||originalArtwork.readAvailability!==artworkAvailability||originalNavigation.readAvailability!==navigationAvailability||originalChooser.readAvailability!==nativeAvailability)return invalid('原Main资源或作者已经换代。')
    }
    return {signal,async assertCurrent(){
      check(context);assertUnchanged()
      await assertCurrent?.call(context);check(context)
      assertUnchanged()
    }}
  }
  async function artworkCallable(source:'douban'|'itunes'|'remote-import',context:LocalWorkbenchMainContext):Promise<dto.LocalWorkbenchAvailability>{
    const original=availabilityContext(context);await original.assertCurrent()
    const result=isTrackedLocalArtworkProviders(originalArtwork)&&typeof artworkAvailability==='function'
      ?await artworkAvailability.call(originalArtwork,source,original):{available:false,reason:'原封面transport状态尚未装配。'}
    await original.assertCurrent()
    return dto.isLocalWorkbenchAvailability(result)?result:{available:false,reason:'原封面transport状态未确认。'}
  }
  async function webpageCallable(mode:'navigate'|'refresh'|'openExternal',source:LocalArtworkWebSource,context:LocalWorkbenchMainContext):Promise<dto.LocalWorkbenchAvailability>{
    const original=availabilityContext(context);await original.assertCurrent()
    const result=isTrackedLocalArtworkWebNavigation(originalNavigation)&&typeof navigationAvailability==='function'
      ?await navigationAvailability.call(originalNavigation,mode,source,original):{available:false,reason:'原网页资源状态尚未装配。'}
    await original.assertCurrent()
    return dto.isLocalWorkbenchAvailability(result)?result:{available:false,reason:'原网页资源状态未确认。'}
  }
  async function pickerCallable(mode:'artwork'|'cue-target',context:LocalWorkbenchMainContext):Promise<dto.LocalWorkbenchAvailability>{
    const original=availabilityContext(context);await original.assertCurrent()
    const result=typeof nativeAvailability==='function'?await nativeAvailability.call(originalChooser,mode,context):{available:false,reason:'原Native输入host状态尚未装配。'}
    await original.assertCurrent()
    return dto.isLocalWorkbenchAvailability(result)?result:{available:false,reason:'原Native输入host状态未确认。'}
  }
  async function capability(context: LocalWorkbenchMainContext, purpose:'full'|'artwork-only'='full'): Promise<dto.LocalWorkbenchCapabilitiesReply> {
    const result = await owner.readCapabilities(context); check(context)
    if (!dto.isLocalWorkbenchCapabilitiesReply(result)) return invalid('实际整理能力不符合公开合同。')
    const combined=structuredClone(result)
    if(transportOwnerInstances.has(owner)){
      // 原 Owner 只报告 Core/Native；Main 从本代实际 decoder 完整运行结果补只读导入资格。
      importFormats??=probeLocalArtworkImportFormats(options.decode);check(context)
      combined.artworkImportFormats=structuredClone(importFormats)
      const importReady=combined.capabilities.read?.available===true&&combined.capabilities['artwork-preview']?.available===true&&importFormats.some(format=>format.availability.available)
      combined.capabilities['artwork-drop']=importReady?{available:true}:{available:false,reason:'原Owner读取/预览或当前Main图片解码尚未就绪。'}
      if(purpose==='artwork-only'){
        // 局部图片动作只等待原Owner与实际解码资格；来源或网页按本次动作另核。
        await availabilityContext(context).assertCurrent()
        if(!dto.isLocalWorkbenchCapabilitiesReply(combined))return invalid('本代Main整理能力不符合原公开闭集。')
        return combined
      }
      const backends:dto.LocalAiBackendOption[]=[]
      for(const backend of ['ollama','vllm','cloud'] as const){
        let configured=false
        if(isTrackedLocalNameTransport(options.names)){try{configured=await options.names.configured(backend,context.signal)}catch(error){if(!(error instanceof LocalProviderError&&error.code==='configuration'))throw error}}
        check(context);await context.assertCurrent?.();check(context)
        backends.push({id:backend,label:backend==='ollama'?'Ollama':backend==='vllm'?'vLLM':'云端兼容接口',availability:configured?{available:true}:{available:false,reason:'当前名称后端未配置或本地凭据不可用。'}})
      }
      combined.aiBackends=backends
      if(combined.capabilities['ai-preview']?.available===true&&!backends.some(backend=>backend.availability.available))combined.capabilities['ai-preview']={available:false,reason:'当前Main尚无已配置可调用的名称后端。'}
      // 只合成同代实际Main配置可调用性；原Core读取/格式与Native/CUE资格继续合取。
      const providers=new Map<'douban'|'itunes',dto.LocalWorkbenchAvailability>()
      const provider=async(source:'douban'|'itunes')=>{let value=providers.get(source);if(!value){value=await artworkCallable(source,context);providers.set(source,value)}return value}
      const configured=Object.entries(options.artworkSources)
      if(configured.length>32)return invalid('原Main封面来源超出闭集预算。')
      const sources:dto.LocalArtworkSearchSource[]=[]
      for(const [id,route] of configured){
        if(!dto.isLocalWorkbenchIdentity(id))return invalid('原Main封面来源编号无效。')
        let availability:dto.LocalWorkbenchAvailability,label:string,kind:dto.LocalArtworkSearchSource['kind'],webActions:dto.LocalWorkbenchWebActions|undefined
        if(route.kind==='provider'&&route.source==='douban-itunes'){
          const douban=await provider('douban'),itunes=await provider('itunes')
          availability=douban.available||itunes.available?{available:true}:{available:false,reason:'豆瓣与iTunes原transport均未确认可调用。'};label='豆瓣与 iTunes';kind='aggregate'
        }else if(route.kind==='provider'&&(route.source==='douban'||route.source==='itunes')){
          availability=await provider(route.source);label=route.source==='douban'?'豆瓣':'iTunes';kind='provider'
        }else if(route.kind==='web'&&['google-images','bing-images','douban-web'].includes(route.source)){
          const navigate=await webpageCallable('navigate',route.source,context),refresh=await webpageCallable('refresh',route.source,context),external=await webpageCallable('openExternal',route.source,context)
          webActions={navigate,refresh,external};availability=navigate;label=route.source==='google-images'?'Google 网页':route.source==='bing-images'?'Bing 网页':'豆瓣网页';kind='web'
        }else return invalid('原Main封面来源不在固定策略内。')
        sources.push({id,label,kind,availability:importReady?availability:{available:false,reason:'原Owner读取/预览或当前Main图片格式尚未就绪。'},
          ...(webActions?{webActions:combined.capabilities.read?.available===true?webActions:{navigate:{available:false,reason:'原Owner读取尚未就绪。'},refresh:{available:false,reason:'原Owner读取尚未就绪。'},external:{available:false,reason:'原Owner读取尚未就绪。'}}}:{})})
      }
      combined.artworkSources=sources
      combined.capabilities['artwork-search']=importReady&&sources.some(source=>source.availability.available)?{available:true}:{available:false,reason:'当前Main尚无可调用的封面来源。'}
      const artworkPicker=await pickerCallable('artwork',context)
      combined.capabilities['artwork-file']=importReady?artworkPicker:{available:false,reason:'原Owner读取/预览或当前Main图片格式尚未就绪。'}
      const cuePicker=await pickerCallable('cue-target',context)
      if(combined.capabilities['cue-preview']?.available===true)combined.capabilities['cue-preview']=cuePicker
      await availabilityContext(context).assertCurrent()
      // existing-actions仍保原实际路由事实；Main picker不补Core Native资格。
    }
    if(!dto.isLocalWorkbenchCapabilitiesReply(combined))return invalid('本代Main整理能力不符合原公开闭集。')
    return combined
  }
  function requireAvailable(availability: dto.LocalWorkbenchAvailability | undefined, fallback: string): void {
    if (!availability?.available) return invalid(availability?.reason ? safeLabel(availability.reason, fallback) : fallback)
  }
  const requireOnline = (resolved: Readonly<LocalWorkbenchResolvedReadCapture>): void => {
    if (resolved.availability !== 'online') return invalid('来源当前离线或不可读，请恢复来源后重新读取。')
  }
  function entry(resolved: Readonly<LocalWorkbenchResolvedReadCapture>, normalized: NormalizedImportedLocalArtwork, info: {
    origin: dto.LocalWorkbenchArtworkCandidate['origin']; label: string; sourceLabel: string; licenseLabel: string; sourceIdentity?: string; privateSource?: LocalArtworkPrivateSource
  }): ArtworkEntry {
    const bound = binding(resolved), candidateId = randomUUID(), sourceLabel = safeLabel(info.sourceLabel, '已读取封面副本')
    const artifact: LocalWorkbenchArtworkCapture = { albumId: bound.capture.albumId, candidateId,
      revision: digest([bound.fingerprint, candidateId, normalized.image, normalized.input, info.sourceIdentity ?? null]), image: structuredClone(normalized.image),
      originalBase64: Buffer.from(normalized.compatibleOriginalBytes).toString('base64'),
      origin: info.origin, sourceLabel, licenseLabel: safeLabel(info.licenseLabel, '来源未提供授权信息'), input: { ...normalized.input },
      ...(info.sourceIdentity ? { sourceIdentity: info.sourceIdentity } : {}) }
    const result: dto.LocalWorkbenchArtworkCandidate = { candidateId, albumId: bound.capture.albumId, label: safeLabel(info.label, sourceLabel), origin: artifact.origin,
      sourceLabel, previewUrl: artifact.image.display.dataUrl, width: artifact.image.original.width, height: artifact.image.original.height,
      licenseLabel: artifact.licenseLabel, ...(normalized.conversionLabel ? { reason: normalized.conversionLabel } : {}) }
    if (!isLocalWorkbenchArtworkCapture(artifact) || !dto.isLocalWorkbenchArtworkCandidate(result, bound.capture.albumId)
      || normalized.compatibleOriginalBytes.length !== artifact.image.original.bytes
      || createHash('sha256').update(normalized.compatibleOriginalBytes).digest('hex') !== artifact.image.original.sha256) return invalid('封面规范副本与原输入捕获不一致。')
    const privateValue: LocalWorkbenchPrivateArtwork = { datasetId: bound.datasetId, datasetRevision: bound.datasetRevision, capture: { ...bound.capture }, captureRevision: bound.captureRevision,
      artwork: artifact, compatibleOriginalBytes: new Uint8Array(normalized.compatibleOriginalBytes), ...(info.privateSource ? { privateSource: info.privateSource } : {}) }
    return { binding: bound, public: result, private: privateValue, expiresAt: now() + ttl,
      bytes: privateValue.compatibleOriginalBytes.length + Buffer.byteLength(JSON.stringify([bound, artifact, result]), 'utf8') }
  }
  function boundArtwork(candidateId: string, resolved: Readonly<LocalWorkbenchResolvedReadCapture>): ArtworkEntry {
    prune(); const item = artworks.get(candidateId)
    if (!item || !same(item.binding, binding(resolved))) return invalid('封面候选已过期或原专辑读取已变化，请重新选择。')
    return item
  }
  function checkPlanCapture<K extends dto.LocalWorkbenchPlan['kind']>(prepared: PreparedPlan<K>, resolved: readonly Readonly<LocalWorkbenchResolvedReadCapture>[]): void {
    if (!isLocalWorkbenchPlanCapture(prepared.capture) || prepared.capture.datasetId !== resolved[0]?.datasetId
      || prepared.capture.datasetRevision !== resolved[0]?.datasetRevision || resolved.some(item => item.datasetRevision !== prepared.capture.datasetRevision)
      || !same(prepared.capture.albums, resolved.map(item => item.capture)) || !same(prepared.draft.albumIds, resolved.map(item => item.capture.albumId))) return invalid('预览与同一原捕获不一致，未签发计划。')
  }
  function result(request: LocalWorkbenchMainRequest, value: unknown, context: LocalWorkbenchMainContext): Result {
    if (dto.isLocalWorkbenchReadCommand(request.command)) check(context)
    if (!dto.isLocalWorkbenchCommandResult(request.command, value, request.payload)
      || request.command === 'localWorkbench.read' && (value as dto.LocalWorkbenchReadback).datasetId !== context.datasetId) return invalid('整理结果与原请求不一致。')
    return structuredClone(value) as Result
  }
  async function originalPlan(request: dto.LocalWorkbenchApplyRequest): Promise<dto.LocalWorkbenchPlan> {
    const plan = await owner.registry.getPlan(request.planId)
    if (!dto.isLocalWorkbenchPlan(plan) || plan.datasetId !== request.datasetId || plan.planId !== request.planId || plan.revision !== request.expectedRevision
      || plan.planHash !== request.planHash || plan.contextFingerprint !== request.contextFingerprint || plan.kind !== request.kind) return invalid('原命令与冻结计划不一致，未重新签发或开始执行。')
    return plan
  }
  async function run(request: LocalWorkbenchMainRequest, context: LocalWorkbenchMainContext): Promise<Result> {
    if (dto.isLocalWorkbenchReadCommand(request.command)) check(context)
    switch (request.command) {
      case 'localWorkbench.capabilities': return capability(context)
      case 'localWorkbench.read': {
        requireAvailable((await capability(context)).capabilities.read, '整理读取尚未接入。')
        const value = await owner.read.readAlbums(request.payload, context); check(context)
        if (!dto.isLocalWorkbenchReadback(value, request.payload) || value.datasetId !== context.datasetId) return invalid('原整理读取副本不符合当前工作库合同。')
        let allRooted=true
        for(const album of value.albums){const key=captureKey(value.datasetId,album.capture),prior=captureRoots.get(key),root=album.album.rootId??prior
          if(root===undefined){allRooted=false;continue}
          if(prior&&prior!==root)return invalid('原readToken库归属不一致。')
          if(!prior&&captureRoots.size>=512)return invalid('原捕获归属超过现有预算。')
          captureRoots.set(key,root);flightBySignal.get(context.signal)?.roots.add(root)
          if(retiredLibraries.has(root))return invalid('原库读取已撤销。')}
        if(allRooted)flightBySignal.get(context.signal)?.associate()
        const operations = await owner.registry.operations(); check(context)
        const rawOperations: unknown = operations
        if (!isLocalWorkbenchDenseArray(rawOperations, 512) || !operations.every(operation => dto.isLocalWorkbenchOperation(operation))) return invalid('持久原操作列表不符合整理合同，未恢复不完整列表。')
        const pendingOperations = operations.filter(operation => operation.request.datasetId === context.datasetId
          && (operation.state === 'unknown' || operation.state === 'running'))
        const readback = { ...value, pendingOperations }
        if (!dto.isLocalWorkbenchReadback(readback, request.payload)) return invalid('持久待确认操作超出整理读取合同或预算，未截取列表。')
        return readback
      }
      case 'localWorkbench.artwork.local': {
        requireAvailable((await capability(context)).capabilities['artwork-local'], '本地封面读取尚未接入。')
        const resolved = await resolve(request.payload, context); requireOnline(resolved)
        const copies = await owner.readLocalArtwork(resolved, context); check(context)
        if (!isLocalWorkbenchDataRecord(copies, ['status', 'items']) || !['ready', 'source-unavailable'].includes(copies.status)
          || !isLocalWorkbenchDenseArray(copies.items, 4)) return invalid('本地封面读取副本无效。')
        if (copies.status === 'source-unavailable') return invalid('本地封面来源当前不可读取，不能当作已确认没有封面。')
        let bytes = 0
        const batch = copies.items.map(copy => {
          if (!isLocalWorkbenchDataRecord(copy, ['origin', 'sourceIdentity', 'sourceLabel', 'base64']) || !['local-independent', 'embedded'].includes(copy.origin)
            || !dto.isLocalWorkbenchIdentity(copy.sourceIdentity) || typeof copy.base64 !== 'string'
            || copy.base64.length > 4 * Math.ceil(dto.LOCAL_WORKBENCH_IMAGE_INPUT_BYTES / 3) || !/^[A-Za-z0-9+/]+={0,2}$/u.test(copy.base64)) return invalid('本地封面副本缺少真实来源绑定。')
          const input = Buffer.from(copy.base64, 'base64'); bytes += input.length
          if (!input.length || input.toString('base64') !== copy.base64 || bytes > 8 * 1024 * 1024) return invalid('本地封面副本超过读取预算。')
          return entry(resolved, normalizeImportedLocalArtwork(input, options.decode), { origin: copy.origin, label: copy.sourceLabel,
            sourceLabel: copy.sourceLabel, licenseLabel: '本地来源；仅整理 MusicBridge 副本', sourceIdentity: copy.sourceIdentity })
        })
        const fresh = await resolve(request.payload, context)
        if (!same(binding(fresh), binding(resolved))) return invalid()
        remember(batch, 'artwork'); return batch.map(item => item.public)
      }
      case 'localWorkbench.artwork.search': {
        const action=request.payload.webAction??'navigate'
        const route=Object.hasOwn(options.artworkSources,request.payload.sourceId)?options.artworkSources[request.payload.sourceId]:undefined
        if(!route)return invalid('所选来源没有实际 Main adapter。')
        if(route.kind!=='web'&&action!=='navigate')return invalid('此来源不支持网页动作。')
        const available=await capability(context,route.kind==='web'&&action!=='navigate'?'artwork-only':'full')
        const resolved=await resolve(request.payload,context);requireOnline(resolved)
        if(route.kind==='web'){
          requireAvailable(available.capabilities.read,'原Owner读取尚未就绪。')
          // external与refresh各核原端口，不借navigate或图片导入资格补true/拒绝。
          requireAvailable(await webpageCallable(action==='external'?'openExternal':action,route.source,context),'所选网页端口尚未确认可调用。')
          if(action==='navigate'){requireAvailable(available.capabilities['artwork-search'],'封面搜索尚未接入。');requireAvailable(available.artworkSources.find(item=>item.id===request.payload.sourceId)?.availability,'所选封面来源尚未接入。')}
          const input={source:route.source,query:request.payload.query,originalCaptureKey:binding(resolved).fingerprint,
            hostIdentity:JSON.stringify([resolved.datasetId,resolved.capture.albumId,resolved.capture.readToken])}
          const operation=action==='external'?options.navigation.openExternal(input,context.signal):action==='refresh'?options.navigation.refresh(input,context.signal):options.navigation.navigate(input,context.signal)
          const opened=await navigationOperation(operation,resolved.capture.rootId,context)
          check(context); if (!opened.opened) return invalid(opened.reason)
          return { candidates: [], sources: [{ source: 'web', country: null, status: 'opened', candidateCount: 0,
            previewFailureCount: 0, truncated: false, message: null }] }
        }
        requireAvailable(available.capabilities['artwork-search'],'封面搜索尚未接入。')
        requireAvailable(available.artworkSources.find(item=>item.id===request.payload.sourceId)?.availability,'所选封面来源尚未接入。')
        const country = request.payload.country ?? route.country ?? 'CN'
        const found = await artworkOperation(options.artwork.search({ query: request.payload.query, source: route.source, country, limit: 100 }, context.signal),resolved.capture.rootId,context)
        check(context)
        const batch: ArtworkEntry[] = []
        const sources: dto.LocalWorkbenchArtworkSourceOutcome[] = found.sources.map(item => ({ source: item.source,
          country: item.source === 'itunes' ? country : null, status: item.status, candidateCount: item.candidateCount,
          previewFailureCount: item.previewFailureCount, truncated: item.truncated,
          message: item.status === 'failed' ? '此来源搜索未完成，可单独重试。' : item.previewFailureCount ? '部分预览读取失败，可单独重试此来源。' : null }))
        for (const candidate of found.candidates) {
          if (candidate.width < 1 || candidate.height < 1 || !candidate.previewUrl) continue
          if (batch.length >= 100) { const outcome = sources.find(item => item.source === candidate.source); if (outcome) outcome.truncated = true; continue }
          try {
            const captured = await artworkOperation(options.artwork.readCandidate(candidate.candidateId, context.signal),resolved.capture.rootId,context); check(context)
            const normalized = normalizeImportedLocalArtwork(captured.bytes, options.decode)
            if (!same(normalized.image, captured.normalized)) return invalid('图搜候选与实际规范副本不一致。')
            batch.push(entry(resolved, normalized, { origin: candidate.origin, label: candidate.label, sourceLabel: candidate.sourceLabel,
              licenseLabel: candidate.licenseLabel, privateSource: captured.source }))
          } catch {
            check(context)
            const outcome = sources.find(item => item.source === candidate.source)
            if (outcome) { outcome.previewFailureCount = Math.min(100, outcome.previewFailureCount + 1); outcome.message = '部分预览读取失败，可单独重试此来源。' }
          }
        }
        const fresh = await resolve(request.payload, context)
        if (!same(binding(fresh), binding(resolved))) return invalid()
        const result = { candidates: batch.map(item => item.public), sources }
        if (!dto.isLocalWorkbenchArtworkSearchReply(result, resolved.capture.albumId)) return invalid('封面来源结果超过公开合同预算。')
        remember(batch, 'artwork'); return result
      }
      case 'localWorkbench.artwork.file': {
        requireAvailable((await capability(context)).capabilities['artwork-file'], '原生文件选择入口尚未接入。')
        const resolved = await resolve(request.payload, context); requireOnline(resolved)
        const file = await options.nativeChooser.chooseArtwork(context)
        if (file === null) return null
        try {
          check(context)
          const input = await file.read(context); check(context)
          const item = entry(resolved, normalizeImportedLocalArtwork(input, options.decode), { origin: 'manual', label: file.label,
            sourceLabel: '原生文件选择', licenseLabel: '用户选择的图片；来源授权未核实' })
          const fresh = await resolve(request.payload, context); if (!same(binding(fresh), binding(resolved))) return invalid()
          remember([item], 'artwork'); return item.public
        } finally { try{await file.close()}catch(error){const flight=flightBySignal.get(context.signal);if(flight)flight.physicalFailure=true;throw error} }
      }
      case 'localWorkbench.artwork.import': {
        const available = await capability(context,'artwork-only'); requireAvailable(available.capabilities['artwork-drop'], '封面导入入口尚未接入。')
        const resolved = await resolve(request.payload, context); requireOnline(resolved)
        let input: Uint8Array, mime: string | null = null, privateSource: LocalArtworkPrivateSource | undefined
        if ('bytes' in request.payload) { input = request.payload.bytes; mime = request.payload.mime }
        else if ('text' in request.payload && request.payload.text.startsWith('data:')) {
          const match = /^data:(image\/(?:jpeg|png|tiff|webp|gif|heic|heif|bmp));base64,([A-Za-z0-9+/]+={0,2})$/u.exec(request.payload.text)
          if (!match) return invalid('图片文本格式无效。')
          const bytes = Buffer.from(match[2]!, 'base64')
          if (bytes.toString('base64') !== match[2] || bytes.length < 1 || bytes.length > dto.LOCAL_WORKBENCH_IMAGE_INPUT_BYTES) return invalid('图片文本超过读取预算。')
          input = bytes; mime = match[1]!
        } else {
          const payload = request.payload
          const remote = async (url: string) => {
            checkedRemoteArtworkUrl(url)
            requireAvailable(await artworkCallable('remote-import',context), '原远程图片transport尚未确认可调用。')
            const operations: Promise<unknown>[] = []
            try {
              const importing = options.artwork.importRemoteSource({ url, label: payload.label }, context.signal); operations.push(importing)
              const candidate = await artworkOperation(importing, resolved.capture.rootId, context); check(context)
              const reading = options.artwork.readCandidate(candidate.candidateId, context.signal); operations.push(reading)
              const captured = await artworkOperation(reading, resolved.capture.rootId, context); check(context)
              return { ok: true as const, captured }
            } catch (error) {
              check(context)
              // 原下载和读取已真实settle后才允许备用；物理关闭失败继续阻断，不由新URL掩盖。
              if (!isTrackedLocalArtworkProviders(options.artwork)) throw error
              for (const operation of operations) await options.artwork.join(operation)
              return { ok: false as const, error }
            }
          }
          let imported = 'text' in payload ? await remote(payload.text) : null
          if (!imported?.ok) {
            if (!('webCaptureId' in payload) || !payload.webCaptureId || !isTrackedLocalArtworkWebNavigation(options.navigation)) {
              if (imported) throw imported.error
              return invalid('网页拖图引用已失效，请从当前封面网页重新拖入。')
            }
            const captured = await options.navigation.consumeCapturedImage(binding(resolved).fingerprint, payload.webCaptureId, context.signal); check(context)
            if (!captured || 'text' in payload && captured.url === payload.text) return invalid('未取得当前网页30秒内的原拖图，原封面保留。')
            const current = await resolve(payload, context)
            if (!same(binding(current), binding(resolved))) return invalid('原专辑读取已变化，请重新拖入。')
            imported = await remote(captured.url)
          }
          if (!imported.ok) throw imported.error
          input = imported.captured.bytes; privateSource = imported.captured.source
        }
        const normalized = normalizeImportedLocalArtwork(input, options.decode)
        requireAvailable(available.artworkImportFormats.find(item => item.mime === normalized.input.mime)?.availability, '此图片格式尚未取得实际解码资格。')
        if (mime !== null && normalized.input.mime !== mime) return invalid('声明图片格式与实际输入不一致。')
        const item = entry(resolved, normalized, { origin: 'manual', label: request.payload.label, sourceLabel: '拖放或粘贴导入',
          licenseLabel: '用户提供的图片；来源授权未核实', ...(privateSource ? { privateSource } : {}) })
        const fresh = await resolve(request.payload, context); if (!same(binding(fresh), binding(resolved))) return invalid()
        remember([item], 'artwork'); return item.public
      }
      case 'localWorkbench.artwork.preview': {
        requireAvailable((await capability(context)).capabilities['artwork-preview'], '封面预览尚未接入。')
        const resolved = await resolve(request.payload, context); requireOnline(resolved)
        const item = boundArtwork(request.payload.candidateId, resolved), prepared = await owner.read.prepareArtworkPreview({ resolved, artwork: structuredClone(item.private.artwork) }, context)
        check(context); checkPlanCapture(prepared, [resolved])
        if (prepared.draft.kind !== 'artwork' || !same(prepared.capture.artwork, [item.private.artwork])) return invalid('封面计划没有冻结实际选中的同一图片。')
        return issuePlan(prepared,context)
      }
      case 'localWorkbench.ai.suggest': {
        const available = await capability(context); requireAvailable(available.capabilities['ai-preview'], '名称建议尚未接入。')
        requireAvailable(available.aiBackends.find(item => item.id === request.payload.backend)?.availability, '所选名称后端没有实际配置。')
        const resolved = await resolve(request.payload, context); requireOnline(resolved)
        const prepared = await owner.read.prepareNameSuggestion(request.payload, context)
        if (!dto.isLocalWorkbenchIdentity(prepared.preparationId) || prepared.backend !== request.payload.backend) return invalid('名称准备身份与所选后端不一致。')
        try {
          const operation=options.names.suggest({backend:prepared.backend,systemPrompt:prepared.systemPrompt,userPrompt:prepared.userPrompt},context.signal)
          const content=await physical(operation,resolved.capture.rootId,context,()=>isTrackedLocalNameTransport(options.names)?options.names.join(operation):Promise.reject(new Error('原NAME物理作者未知。')),
            ()=>isTrackedLocalNameTransport(options.names)?options.names.cancelOriginal(operation):Promise.reject(new Error('原NAME物理作者未知。')))
          check(context)
          const parsed = await owner.read.completeNameSuggestion(prepared.preparationId, content, context); check(context)
          if (parsed.status !== 'ready') return invalid(parsed.publicMessage)
          const fresh = await resolve(request.payload, context)
          if (!same(binding(fresh), binding(resolved)) || !dto.isLocalAiNameCandidate(parsed.candidate, resolved.capture.albumId)
            || parsed.proposal.albumId !== resolved.capture.albumId || parsed.proposal.captureRevision !== resolved.capture.revision
            || parsed.proposal.readToken !== resolved.capture.readToken || parsed.proposal.candidateId !== parsed.candidate.candidateId) return invalid('名称候选没有绑定同一原字段捕获。')
          const name: NameEntry = { binding: binding(resolved), candidate: structuredClone(parsed.candidate), expiresAt: now() + ttl,
            bytes: Buffer.byteLength(JSON.stringify([binding(resolved), parsed.candidate]), 'utf8') }
          // 同一捕获及同一模型结果可以重复返回，身份不变；不占额外预算。
          prune(); const previous = names.get(name.candidate.candidateId)
          if (previous) { if (!same(previous.binding, name.binding) || !same(previous.candidate, name.candidate)) return invalid(); names.set(name.candidate.candidateId, name) }
          else remember([name], 'name')
          return { albumId: resolved.capture.albumId, candidates: [name.candidate] }
        } finally { await owner.read.cancelNamePreparation(prepared.preparationId) }
      }
      case 'localWorkbench.ai.preview': {
        requireAvailable((await capability(context)).capabilities['ai-preview'], '名称变化预览尚未接入。')
        prune(); const resolved: Readonly<LocalWorkbenchResolvedReadCapture>[] = []
        for (const selection of request.payload.selections) {
          const reference = request.payload.captures.find(item => item.albumId === selection.albumId)!
          const fresh = await resolve({ datasetId: request.payload.datasetId, capture: reference }, context); requireOnline(fresh)
          const item = names.get(selection.candidateId)
          if (!item || !same(item.binding, binding(fresh))) return invalid('名称候选已过期或原读取已变化，请重新建议。')
          resolved.push(fresh)
        }
        const prepared = await owner.read.prepareNamePreview(request.payload, context); check(context); checkPlanCapture(prepared, resolved)
        if (prepared.draft.kind !== 'ai' || !same(prepared.draft.candidateIds, request.payload.selections.map(item => item.candidateId))) return invalid('名称预览没有冻结原选中候选。')
        return issuePlan(prepared,context)
      }
      case 'localWorkbench.cue.target': {
        requireAvailable((await capability(context)).capabilities['cue-preview'], '独立分轨目标入口尚未接入。')
        const directoryUiToken=await options.directoryAuthorization?.enter(request,context)
        const directoryContext={...context,...(directoryUiToken?{directoryUiToken}:{})}
        const permission = await options.nativeChooser.chooseCueTarget(directoryContext)
        if (permission === null) return null
        if (context.signal.aborted || readsClosed || closed) { await permission.close(); throw aborted() }
        if (!dto.isLocalCueOutputTarget(permission.target) || !dto.isLocalWorkbenchIdentity(permission.revision) || !permission.assertCurrent || !permission.withDirectory || !permission.close
          || targets.has(permission.target.choiceId) || targets.size >= 32) { await permission.close(); return invalid('目标选择未取得完整的独立目录许可。') }
        try { await permission.assertCurrent(context); check(context) }
        catch (error) { await permission.close(); throw error }
        targets.set(permission.target.choiceId, { datasetId: context.datasetId, permission, expiresAt: now() + ttl })
        return structuredClone(permission.target)
      }
      case 'localWorkbench.cue.preview': {
        const available = await capability(context); requireAvailable(available.capabilities['cue-preview'], 'CUE 变化预览尚未接入。')
        requireAvailable(available.cueFormats.find(item => item.id === request.payload.outputFormat)?.availability, '所选输出格式尚未通过实际编码回读资格。')
        const selected = targets.get(request.payload.target.choiceId)
        if (!selected || selected.datasetId !== context.datasetId || selected.expiresAt <= now() || !same(selected.permission.target, request.payload.target)) return invalid('独立输出目标已过期或不属于原工作库，请重新选择。')
        await selected.permission.assertCurrent(context); check(context)
        const resolved: Readonly<LocalWorkbenchResolvedReadCapture>[] = []
        for (const choice of request.payload.cueSelections) {
          const reference = request.payload.captures.find(item => item.albumId === choice.albumId)!
          const fresh = await resolve({ datasetId: request.payload.datasetId, capture: reference }, context); requireOnline(fresh); resolved.push(fresh)
        }
        await options.directoryAuthorization?.enter(request,context,request.payload.target.choiceId)
        const prepared = await owner.prepareCuePreview(request.payload, selected.permission, context); check(context); checkPlanCapture(prepared, resolved)
        if (prepared.draft.kind !== 'cue' || !same(prepared.draft.target, request.payload.target)
          || !same(prepared.capture.target, { ...request.payload.target, revision: selected.permission.revision })
          || prepared.capture.format?.formatId !== request.payload.outputFormat
          || !same(prepared.capture.cueSheets?.map(item => [item.albumId, item.cueId]), request.payload.cueSelections.map(item => [item.albumId, item.cueId]))) return invalid('CUE 预览未冻结同一来源、格式和独立目标。')
        return issuePlan(prepared,context)
      }
      case 'localWorkbench.plan.apply': {
        const plan = await originalPlan(request.payload)
        if(plan.kind==='cue')await options.directoryAuthorization?.enter(request,context,plan.target.choiceId)
        const receipt = await owner.registry.apply(request.payload)
        if (!dto.isLocalWorkbenchReceipt(receipt, request.payload, plan)) return invalid('原应用回执与冻结计划条目不一致。')
        return receipt
      }
      case 'localWorkbench.plan.receipt': {
        const plan = await originalPlan(request.payload), receipt = await owner.registry.readOriginalReceipt(request.payload)
        if (receipt !== null && !dto.isLocalWorkbenchReceipt(receipt, request.payload, plan)) return invalid('原查询回执与冻结计划条目不一致。')
        return receipt
      }
      case 'localWorkbench.plan.cancel': {
        const plan = await originalPlan(request.payload.original), receipt = await owner.registry.cancel(request.payload)
        if (!dto.isLocalWorkbenchReceipt(receipt, request.payload.original, plan)) return invalid('原任务取消回执与冻结计划不一致。')
        return receipt
      }
      case 'localWorkbench.existing.open': return owner.openExisting(request.payload, context)
    }
  }
  function track<T>(context:LocalWorkbenchMainContext,operation:(context:LocalWorkbenchMainContext)=>Promise<T>,references:readonly dto.LocalWorkbenchCapture[]=[],rootHints:readonly string[]=[],forceBinding=false):Promise<T>{
    check(context)
    if(active.size>=24||failedFlights.size>=24)return Promise.reject(new Error('整理读取达到现有原资源预算。'))
    if(rootHints.some(root=>retiredLibraries.has(root)))return Promise.reject(new Error('原库新读取已封。'))
    const controller=new AbortController(),forward=()=>controller.abort()
    context.signal.addEventListener('abort',forward,{once:true});if(context.signal.aborted)forward()
    let resolveAssociation!:()=>void,rejectAssociation!:()=>void
    const associated=new Promise<void>((resolve,reject)=>{resolveAssociation=resolve;rejectAssociation=()=>reject(new Error('原读取库归属未知，保留原任务。'))});void associated.catch(()=>{})
    const required=new Set(references.map(capture=>captureKey(context.datasetId,capture))),roots=new Set<string>()
    for(const key of [...required]){const root=captureRoots.get(key);if(root){roots.add(root);required.delete(key)}}
    const scoped={...context,signal:controller.signal}
    let flight!:LibraryReadFlight
    const task=Promise.resolve().then(()=>operation(scoped)).catch(error=>{throw safeError(error,scoped.signal)}).finally(()=>{
      if(!flight.bound){flight.failAssociation();failedFlights.add(flight)}
      if(flight.physicalFailure)failedFlights.add(flight)
      active.delete(flight);context.signal.removeEventListener('abort',forward)
    })
    flight={datasetId:context.datasetId,controller,task,required,roots,associated,bound:false,physicalFailure:false,
      associate(){if(!flight.bound){flight.bound=true;resolveAssociation()}},failAssociation:rejectAssociation}
    flightBySignal.set(controller.signal,flight);active.add(flight)
    if(!required.size&&!rootHints.length&&!forceBinding)flight.associate()
    if([...roots].some(root=>retiredLibraries.has(root)))controller.abort()
    return task
  }
  function requestReferences(request:LocalWorkbenchMainRequest):dto.LocalWorkbenchCapture[]{
    const payload=request.payload as unknown as {capture?:dto.LocalWorkbenchCapture;captures?:readonly dto.LocalWorkbenchCapture[]}
    return payload.capture?[payload.capture]:payload.captures?[...payload.captures]:[]
  }
  function request(request: LocalWorkbenchMainRequest, context: LocalWorkbenchMainContext): Promise<Result> {
    if (closed || closing) return Promise.reject(new Error('整理服务已关闭，不再接受新命令。'))
    if (!isLocalWorkbenchDataRecord(request, ['command', 'payload']) || !dto.isLocalWorkbenchCommand(request.command)
      || !dto.isLocalWorkbenchCommandPayload(request.command, request.payload) || !dto.isCommandOutboxDatasetId(context.datasetId)
      || 'datasetId' in request.payload && request.payload.datasetId !== context.datasetId
      || request.command === 'localWorkbench.plan.cancel' && request.payload.original.datasetId !== context.datasetId) return Promise.reject(new Error('整理请求不符合当前工作库闭集合同。'))
    const captured = structuredClone(request)
    if(dto.isLocalWorkbenchReadCommand(captured.command))return track(context,async scoped=>result(captured,await run(captured,scoped),scoped),requestReferences(captured),captured.command==='localWorkbench.read'?captured.payload.albums.map(album=>album.rootId).filter((root):root is string=>root!==undefined):[],captured.command==='localWorkbench.read')
    if (closed) return Promise.reject(new Error('整理服务已关闭。'))
    // 应用、原回执和显式任务取消不共享面板读取的取消信号。
    const independent = { ...context, signal: new AbortController().signal }
    const task = Promise.resolve().then(async () => result(captured, await run(captured, independent), independent))
      .catch(error => { throw safeError(error, independent.signal) }).finally(() => writes.delete(task))
    const planId=captured.command==='localWorkbench.plan.apply'?captured.payload.planId:captured.command==='localWorkbench.plan.cancel'?captured.payload.original.planId:null
    writeRoots.set(task,{datasetId:context.datasetId,roots:planId?planRoots.get(planId)??null:new Set()});void task.finally(()=>writeRoots.delete(task)).catch(()=>{})
    writes.add(task); return task
  }
  /** 只有父 Main 的受控浏览器/手动 URL 转交可调用；不增加公开任意 URL IPC。 */
  function importRemoteSource(request: LocalWorkbenchRemoteSourceRequest, context: LocalWorkbenchMainContext): Promise<dto.LocalWorkbenchArtworkCandidate> {
    if (!dto.isLocalWorkbenchCommandPayload('localWorkbench.artwork.local', { datasetId: request.datasetId, capture: request.capture })
      || request.datasetId !== context.datasetId) return Promise.reject(new Error('远程图片导入捕获无效。'))
    return track(context, async scoped => {
      requireAvailable((await capability(scoped,'artwork-only')).capabilities['artwork-drop'], '手动图片导入尚未接入。')
      const resolved = await resolve(request, scoped); requireOnline(resolved)
      requireAvailable(await artworkCallable('remote-import',scoped), '原远程图片transport尚未确认可调用。')
      const candidate = await artworkOperation(options.artwork.importRemoteSource(request.source, scoped.signal),resolved.capture.rootId,scoped)
      const captured = await artworkOperation(options.artwork.readCandidate(candidate.candidateId, scoped.signal),resolved.capture.rootId,scoped); check(scoped)
      const normalized = normalizeImportedLocalArtwork(captured.bytes, options.decode)
      if (!same(normalized.image, captured.normalized)) return invalid('远程候选与规范副本不一致。')
      const item = entry(resolved, normalized, { origin: 'manual', label: candidate.label, sourceLabel: candidate.sourceLabel,
        licenseLabel: candidate.licenseLabel, privateSource: captured.source })
      const fresh = await resolve(request, scoped); if (!same(binding(fresh), binding(resolved))) return invalid()
      remember([item], 'artwork'); return structuredClone(item.public)
    },[request.capture])
  }
  function navigateWebSource(request: LocalWorkbenchWebSourceRequest, context: LocalWorkbenchMainContext): Promise<LocalArtworkNavigationResult> {
    if (!dto.isLocalWorkbenchCommandPayload('localWorkbench.artwork.search', { datasetId: request.datasetId, capture: request.capture, sourceId: request.sourceId, query: request.query })
      || request.datasetId !== context.datasetId) return Promise.reject(new Error('网页搜索捕获无效。'))
    return track(context, async scoped => {
      const available = await capability(scoped,'artwork-only')
      requireAvailable(available.capabilities[transportOwnerInstances.has(owner)?'artwork-drop':'artwork-search'], '网页来源读取或图片格式尚未就绪。')
      const resolved = await resolve(request, scoped); requireOnline(resolved)
      const route = Object.hasOwn(options.artworkSources, request.sourceId) ? options.artworkSources[request.sourceId] : undefined
      if (route?.kind !== 'web') return invalid('所选来源没有受控网页 adapter。')
      // 原内嵌导航与显式外部启动分开核，不借navigate状态拒绝已配置的external端口。
      requireAvailable(await webpageCallable(request.external===true?'openExternal':'navigate',route.source,scoped), '所选网页端口尚未确认可调用。')
      const input: LocalArtworkWebRequest = { source: route.source, query: request.query, originalCaptureKey: binding(resolved).fingerprint,
        hostIdentity: JSON.stringify([resolved.datasetId, resolved.capture.albumId, resolved.capture.readToken]) }
      return navigationOperation(request.external===true?options.navigation.openExternal(input,scoped.signal):options.navigation.navigate(input,scoped.signal),resolved.capture.rootId,scoped)
    },[request.capture])
  }
  async function restorePrivateArtwork(input: { datasetId: string; candidateId: string; planId?: string },flight:PrivateArtworkFlight): Promise<LocalWorkbenchPrivateArtwork> {
    if (closed || !dto.isCommandOutboxDatasetId(input.datasetId) || !dto.isLocalWorkbenchIdentity(input.candidateId)) return invalid('原封面私有副本已失效，请重新选择。')
    if (input.planId !== undefined) {
      if (!dto.isLocalWorkbenchIdentity(input.planId)) return invalid()
      const frozen = await owner.registry.readArtworkCapture({ datasetId: input.datasetId, planId: input.planId, candidateId: input.candidateId })
      const plan = await owner.registry.getPlan(input.planId)
      if (!frozen || !dto.isLocalWorkbenchPlan(plan) || plan.kind !== 'artwork' || plan.datasetId !== input.datasetId
        || frozen.datasetId !== input.datasetId || frozen.planId !== input.planId || frozen.planHash !== plan.planHash
        || frozen.contextFingerprint !== plan.contextFingerprint || !isLocalWorkbenchAlbumCapture(frozen.capture)
        || !isLocalWorkbenchArtworkCapture(frozen.artwork) || frozen.artwork.candidateId !== input.candidateId
        || frozen.artwork.albumId !== frozen.capture.albumId || !plan.albumIds.includes(frozen.capture.albumId)) return invalid('原封面持久捕获与冻结计划不一致。')
      flight.associate(frozen.capture.rootId);if(retiredLibraries.has(frozen.capture.rootId))return invalid('原库新私有图读取已封。')
      // 恢复只读副本，不重签计划、不下载图片，也不用较小 display 冒充原图。
      const bytes = Buffer.from(frozen.artwork.originalBase64, 'base64')
      const normalized = normalizeImportedLocalArtwork(bytes, options.decode)
      if (!same(normalized.image.original, frozen.artwork.image.original)) return invalid('原封面持久字节与原图身份不一致。')
      return { datasetId: frozen.datasetId, datasetRevision: frozen.datasetRevision,
        capture: { albumId: frozen.capture.albumId, readToken: frozen.capture.readToken }, captureRevision: frozen.capture.revision,
        artwork: structuredClone(frozen.artwork), compatibleOriginalBytes: new Uint8Array(bytes) }
    }
    prune(); const item = artworks.get(input.candidateId)
    if (!item || item.binding.datasetId !== input.datasetId) return invalid('原封面私有副本已失效，请按原计划读取持久捕获。')
    flight.associate(item.binding.rootId);if(retiredLibraries.has(item.binding.rootId))return invalid('原库新私有图读取已封。')
    return copyPrivate(item.private)
  }
  function readPrivateArtwork(input: { datasetId: string; candidateId: string; planId?: string }): Promise<LocalWorkbenchPrivateArtwork> {
    if (closed || privateReadsClosed) return Promise.reject(new Error('整理服务已关闭，不再接受私有原图读取。'))
    // Main原writer可在已受理应用收口期间读取原图；关闭面板读取不会取消该任务。
    let resolve!:()=>void,reject!:()=>void,flight!:PrivateArtworkFlight
    const associated=new Promise<void>((done,fail)=>{resolve=done;reject=()=>fail(new Error('原私有图读取库归属未知。'))});void associated.catch(()=>{})
    const task=Promise.resolve().then(()=>restorePrivateArtwork({...input},flight)).finally(()=>{if(flight.rootId===null){flight.failAssociation();failedPrivateArtworkFlights.add(flight)}privateArtworkReads.delete(task);privateArtworkFlights.delete(flight)})
    flight={datasetId:input.datasetId,rootId:null,associated,task,associate(rootId){if(flight.rootId!==null&&flight.rootId!==rootId)return invalid('原私有图库归属漂移。');flight.rootId=rootId;resolve()},failAssociation:reject}
    const warm=artworks.get(input.candidateId);if(input.planId===undefined&&warm?.binding.datasetId===input.datasetId)flight.associate(warm.binding.rootId)
    privateArtworkFlights.add(flight);privateArtworkReads.add(task);return task
  }
  function stopLibraryReaders(original:LocalWorkbenchLibraryRemovalReference,libraryId:string):Promise<void>{
    if(closed||closing||!dto.isCommandOutboxDatasetId(original.datasetId)||!dto.isLocalLibraryManagementPayload('library.remove',{commandId:original.commandId,libraryIds:[...original.libraryIds]})
      ||!original.libraryIds.includes(libraryId)||!dto.isLocalLyricsId(original.ownerEpoch)||!/^[0-9a-f]{64}$/u.test(original.originalSha256)
      ||original.originalSha256!==localLibraryManagementDigest({command:'library.remove',request:{commandId:original.commandId,libraryIds:[...original.libraryIds]}}))return Promise.reject(new Error('原库撤销意图未闭合。'))
    const key=original.commandId+':'+libraryId,prior=removalStops.get(key)
    if(prior){if(!same(prior.original,original))return Promise.reject(new Error('原撤销command/body不能变更。'));return prior.promise}
    if(removalStops.size>=512)return Promise.reject(new Error('原库撤销记录达到现有预算。'))
    retiredLibraries.add(libraryId)
    const originalFlights=[...active].filter(flight=>flight.datasetId===original.datasetId),privateFlights=[...privateArtworkFlights].filter(flight=>flight.datasetId===original.datasetId)
    const stopped=(async()=>{
      await Promise.all([...originalFlights.map(flight=>flight.associated),...privateFlights.map(flight=>flight.associated)])
      if([...failedPrivateArtworkFlights].some(flight=>flight.datasetId===original.datasetId&&flight.rootId===null))throw new Error('原私有图库归属未知，不能用空Map授关闭。')
      if([...failedFlights].some(flight=>flight.datasetId===original.datasetId&&(!flight.bound||flight.roots.has(libraryId))))throw new Error('原库读者FD或原归属仍未知。')
      const selected=originalFlights.filter(flight=>flight.roots.has(libraryId))
      if(selected.some(flight=>[...flight.roots].some(root=>!original.libraryIds.includes(root))))throw new Error('原读取跨库共享，不能取消乙库。')
      const owned=[...physicalReads].filter(record=>record.datasetId===original.datasetId&&record.rootId===libraryId)
      for(const flight of selected)flight.controller.abort()
      const cancels=owned.map(record=>record.cancel())
      const sourceWrites=[...writeRoots].filter(([,value])=>value.datasetId===original.datasetId)
      if(sourceWrites.some(([,value])=>value.roots===null))throw new Error('原已受理写者库归属未知。')
      const writesHere=sourceWrites.filter(([,value])=>value.roots!.has(libraryId))
      if(writesHere.some(([,value])=>[...value.roots!].some(root=>!original.libraryIds.includes(root))))throw new Error('原写者跨库，不能停乙库。')
      const joined=await Promise.allSettled([...selected.map(flight=>flight.task),...privateFlights.filter(flight=>flight.rootId===libraryId).map(flight=>flight.task),...owned.map(record=>record.quiet),...cancels,...writesHere.map(([task])=>task)])
      if(owned.some(record=>!record.closed||record.failed)||selected.some(flight=>flight.physicalFailure)
        ||joined.slice(selected.length+privateFlights.filter(flight=>flight.rootId===libraryId).length,selected.length+privateFlights.filter(flight=>flight.rootId===libraryId).length+owned.length+cancels.length).some(result=>result.status==='rejected')
        ||[...physicalReads].some(record=>record.datasetId===original.datasetId&&record.rootId===libraryId&&!record.closed))throw new Error('原库producer/body/FD物理闭口未确认。')
      if(isTrackedLocalArtworkProviders(options.artwork))options.artwork.retireLibrary({datasetId:original.datasetId,libraryId})
      const keep=new Set([...planArtworkRefs.values()].flatMap(refs=>[...refs]))
      for(const [id,entry]of artworks)if(entry.binding.datasetId===original.datasetId&&entry.binding.rootId===libraryId&&!keep.has(id))artworks.delete(id)
      const keepNames=new Set([...planNameRefs.values()].flatMap(refs=>[...refs]))
      for(const [id,entry]of names)if(entry.binding.datasetId===original.datasetId&&entry.binding.rootId===libraryId&&!keepNames.has(id))names.delete(id)
    })();removalStops.set(key,{original:structuredClone(original),promise:stopped});void stopped.catch(()=>{});return stopped
  }
  function closeReadResources(): Promise<void> {
    if (closingReads) return closingReads
    readsClosed = true
    for (const pending of active) pending.controller.abort()
    const providerCleanup=Promise.allSettled([Promise.resolve().then(()=>options.artwork.close()),Promise.resolve().then(()=>options.navigation.close())])
    closingReads = (async () => {
      const cleanup = Promise.allSettled([options.names.stop(), options.nativeChooser.closeReadResources()])
      await Promise.allSettled([...active].map(item => item.task))
      const outcomes=[...await cleanup,...await providerCleanup,...await Promise.allSettled([...physicalReads].map(record=>record.quiet))]
      if([...failedFlights].some(flight=>flight.physicalFailure)||outcomes.some(item => item.status === 'rejected')) throw new Error('整理读取资源关闭尚未确认。')
    })()
    return closingReads
  }
  function close(): Promise<void> {
    if (closingService) return closingService
    // 先关闭命令受理，再收口原已受理写；私有副本和目标许可留到原写结束。
    closing = true
    closingService = (async () => {
      await closeReadResources(); await Promise.allSettled([...writes])
      privateReadsClosed = true
      await Promise.allSettled([...privateArtworkReads])
      const outcomes = await Promise.allSettled([...targets.values()].map(item => item.permission.close()).concat(options.names.close()))
      if (outcomes.some(item => item.status === 'rejected')) throw new Error('整理目标许可关闭尚未确认。')
      closed = true; artworks.clear(); names.clear(); targets.clear()
    })()
    return closingService
  }
  return { request, importRemoteSource, navigateWebSource, readPrivateArtwork, stopLibraryReaders, closeReadResources, close,
    inspectLibraryReaders:(libraryId:string)=>({retired:retiredLibraries.has(libraryId),active:[...active].filter(flight=>flight.roots.has(libraryId)).length,physical:[...physicalReads].filter(record=>record.rootId===libraryId).length,unknown:[...physicalReads].some(record=>record.rootId===libraryId&&record.failed)||[...failedFlights].some(flight=>!flight.bound||flight.roots.has(libraryId))||[...failedPrivateArtworkFlights].some(flight=>flight.rootId===null||flight.rootId===libraryId)}),
    inspect: () => ({ artworkCandidates: artworks.size, nameCandidates: names.size, candidateBytes: [...artworks.values(), ...names.values()].reduce((total, item) => total + item.bytes, 0),
      targets: targets.size, reads: active.size, writes: writes.size, privateArtworkReads: privateArtworkReads.size }) }
}
export type LocalWorkbenchService = ReturnType<typeof createLocalWorkbenchService>

const ownResult = (value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || localBoundaryNodeTypes.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value)
  return required.every(key => descriptors[key] !== undefined) && keys.every(key => typeof key === 'string' && [...required, ...optional].includes(key) && descriptors[key]?.enumerable === true && 'value' in descriptors[key]!)
}
const arrayResult = (value: unknown, max: number): value is unknown[] => !localBoundaryNodeTypes.isProxy(value) && Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype
  && value.length <= max && Reflect.ownKeys(value).length === value.length + 1
  && Array.from({ length: value.length }, (_, i) => Object.getOwnPropertyDescriptor(value, String(i))).every(d => d?.enumerable === true && 'value' in d)
const idsResult = (value: unknown): value is string[] => arrayResult(value, 10000) && value.every(dto.isLocalLyricsId) && new Set(value).size === value.length
const naturalResult = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
const stateResult = (value: unknown, allowed: readonly string[]): boolean => typeof value === 'string' && allowed.includes(value)
function publicDataResult(value: unknown, ancestors = new Set<object>(), depth = 0): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || localBoundaryNodeTypes.isProxy(value) || depth > 16 || ancestors.has(value)) return false
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value)
  if (prototype !== (array ? Array.prototype : Object.prototype) && (array || prototype !== null)) return false
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value)
  if (keys.some(key => typeof key !== 'string' || !('value' in descriptors[key]!) || key !== 'length' && descriptors[key]?.enumerable !== true)) return false
  ancestors.add(value)
  try { return keys.every(key => array && key === 'length' || publicDataResult(descriptors[key as string]!.value, ancestors, depth + 1)) }
  finally { ancestors.delete(value) }
}
const equalScope = (a: dto.LocalLyricsScope, b: dto.LocalLyricsScope) => a.datasetId === b.datasetId && a.libraryId === b.libraryId && a.albumId === b.albumId && a.captureId === b.captureId
const equalLibrary = (a: dto.LocalLyricsLibraryRequest, b: dto.LocalLyricsLibraryRequest) => a.datasetId === b.datasetId && a.libraryId === b.libraryId && a.captureId === b.captureId
function lyricsReceiptResult(value: unknown): value is dto.LocalLyricsSaveReceipt {
  if (!ownResult(value, ['commandId', 'sessionId', 'state', 'cover', 'tracks', 'snapshot']) || !dto.isLocalLyricsId(value.commandId) || !dto.isLocalLyricsId(value.sessionId)
    || !stateResult(value.state, ['running','complete','partial','unknown','cancelled','failed']) || !stateResult(value.snapshot, ['not-requested','pending','saved','failed']) || !arrayResult(value.tracks,10000)) return false
  const states = ['not-requested','pending','saved','existing','failed','unknown','cancelled']
  return stateResult(value.cover, states) && value.tracks.every(row => ownResult(row,['trackId','lrc','embed']) && dto.isLocalLyricsId(row.trackId) && stateResult(row.lrc,states) && stateResult(row.embed,states))
    && new Set(value.tracks.map(row => (row as dto.LocalLyricsTrackReceipt).trackId)).size === value.tracks.length
}
function lyricsSessionResult(value: unknown): value is dto.LocalLyricsSession {
  if (!ownResult(value,['sessionId','scope','state','tracks','candidates'],['pendingOperations']) || !dto.isLocalLyricsId(value.sessionId) || !dto.isLocalLyricsScope(value.scope)
    || !stateResult(value.state,['querying','ready','cancelled','stale']) || !arrayResult(value.tracks,10000) || !arrayResult(value.candidates,dto.LOCAL_LYRICS_LIMITS.sessionBodyBytes)) return false
  if (!value.candidates.every(candidate => dto.isLocalLyricsCandidateDetail({candidate,body:'核验候选'}))) return false
  const candidates = value.candidates as unknown as dto.LocalLyricsCandidate[]
  if (new Set(candidates.map(row => row.candidateId)).size !== candidates.length || !value.tracks.every(track => {
    if (!ownResult(track,['trackId','title','presence','match','candidateIds','selectedCandidateId','sources']) || !dto.isLocalLyricsId(track.trackId) || !dto.isLocalLyricsSafeText(track.title,2048)
      || !stateResult(track.presence,['unknown','false','true']) || !stateResult(track.match,['existing','whole-track','recommended','review','not-found','failed','unknown']) || !idsResult(track.candidateIds)
      || track.selectedCandidateId !== null && (!dto.isLocalLyricsId(track.selectedCandidateId) || !track.candidateIds.includes(track.selectedCandidateId)) || !arrayResult(track.sources,5)) return false
    return track.candidateIds.every(id => candidates.some(row => row.candidateId === id && row.trackId === track.trackId))
      && track.sources.every(source => ownResult(source,['source','state']) && dto.LOCAL_LYRICS_SOURCES.includes(source.source as dto.LocalLyricsSource) && stateResult(source.state,['ok','failed','unavailable','budget','cancelled']))
      && new Set(track.sources.map(source => (source as dto.LocalLyricsSourceResult).source)).size === track.sources.length
  })) return false
  const tracks = value.tracks as unknown as dto.LocalLyricsTrackView[]
  if (new Set(tracks.map(row => row.trackId)).size !== tracks.length || candidates.some(row => !tracks.some(track => track.trackId === row.trackId))) return false
  if (Object.hasOwn(value,'pendingOperations') && (!arrayResult(value.pendingOperations,10000) || !value.pendingOperations.every(row => ownResult(row,['request','receipt'])
    && dto.isLocalLyricsCommandPayload('localLyrics.save',row.request) && lyricsReceiptResult(row.receipt)
    && row.receipt.commandId === (row.request as dto.LocalLyricsSaveRequest).commandId && row.receipt.sessionId === (row.request as dto.LocalLyricsSaveRequest).sessionId)
    || new Set((value.pendingOperations as { request: dto.LocalLyricsSaveRequest }[]).map(row=>row.request.commandId)).size !== (value.pendingOperations as unknown[]).length)) return false
  return true
}
function lyricsJobResult(value: unknown, datasetId: string): value is dto.LocalLyricsJobSnapshot {
  if (!ownResult(value,['jobId','library','state','totalAlbums','processedAlbums','savedAlbums','reviewAlbumIds','failedAlbumIds','unknownAlbumIds','sidecars','embedded','inspectionFailures','revision'],['originalEntry'])
    || !dto.isLocalLyricsId(value.jobId) || !dto.isLocalLyricsLibraryRequest(value.library) || value.library.datasetId !== datasetId
    || !stateResult(value.state,['queued','running','stopped','complete','partial','unknown','failed'])
    || !['totalAlbums','processedAlbums','savedAlbums','sidecars','embedded','inspectionFailures','revision'].every(key=>naturalResult(value[key]))
    || Number(value.processedAlbums)>Number(value.totalAlbums) || Number(value.savedAlbums)>Number(value.processedAlbums)
    || !idsResult(value.reviewAlbumIds) || !idsResult(value.failedAlbumIds) || !idsResult(value.unknownAlbumIds)) return false
  const ids = [...value.reviewAlbumIds,...value.failedAlbumIds,...value.unknownAlbumIds]
  return new Set(ids).size === ids.length && ids.length <= Number(value.totalAlbums)
    && (!Object.hasOwn(value,'originalEntry') || value.originalEntry === null
      || dto.isLocalLyricsJobOriginalEntry(value.originalEntry) && value.originalEntry.scope.datasetId === datasetId && value.originalEntry.scope.libraryId === value.library.libraryId)
}
/** public只消费闭集结果；不从候选正文或源URL构造路径/许可。 */
export function isLocalWorkbenchLyricsMainResult<C extends dto.LocalLyricsCommand>(command: C, value: unknown, payload: dto.LocalLyricsCommandPayloads[C], datasetId: string): value is dto.LocalLyricsCommandResults[C] {
  try {
    if (!dto.isLocalLyricsCommandPayload(command,payload) || !publicDataResult(value) || new TextEncoder().encode(JSON.stringify(value)).byteLength > dto.LOCAL_LYRICS_LIMITS.sessionBodyBytes) return false
    if (command === 'localLyrics.detail') return dto.isLocalLyricsCandidateDetail(value) && value.candidate.candidateId === (payload as dto.LocalLyricsDetailRequest).candidateId
    if (command === 'localLyrics.query') return lyricsSessionResult(value) && equalScope(value.scope,(payload as dto.LocalLyricsQueryRequest).scope) && value.scope.datasetId === datasetId
    if (['localLyrics.session.read','localLyrics.select','localLyrics.cancel'].includes(command) || command === 'localLyrics.discard' && !('commandId' in payload)) {
      if (!lyricsSessionResult(value) || value.scope.datasetId !== datasetId || value.sessionId !== (payload as dto.LocalLyricsSessionRequest).sessionId) return false
      if (command === 'localLyrics.select') { const p=payload as dto.LocalLyricsSelectionRequest; return value.tracks.some(row=>row.trackId===p.trackId && row.selectedCandidateId===p.candidateId) }
      return true
    }
    if (['localLyrics.save','localLyrics.receipt','localLyrics.save.retry','localLyrics.snapshot.retry','localLyrics.discard'].includes(command)) {
      if (value === null) return command === 'localLyrics.receipt'
      const p=payload as dto.LocalLyricsReceiptRequest
      return lyricsReceiptResult(value) && value.sessionId===p.sessionId && value.commandId===p.commandId
    }
    if (command === 'localLyrics.inventory') {
      const p=payload as dto.LocalLyricsInventoryRequest
      return ownResult(value,['total','offset','rows','watermark']) && naturalResult(value.total) && value.offset===p.offset && dto.isLocalLyricsSafeText(value.watermark,2048) && (value.watermark as string).length>0
        && arrayResult(value.rows,p.limit) && value.rows.every(row=>ownResult(row,['albumId','presence']) && dto.isLocalLyricsId(row.albumId) && stateResult(row.presence,['unknown','false','true']))
        && new Set(value.rows.map(row=>(row as dto.LocalLyricsInventoryRow).albumId)).size===value.rows.length && value.rows.length===Math.min(p.limit,Math.max(0,Number(value.total)-p.offset)) && (p.filter!=='missingLyrics' || value.rows.every(row=>(row as dto.LocalLyricsInventoryRow).presence==='false'))
    }
    if (value === null) return command === 'localLyrics.job.read'
    if (!lyricsJobResult(value,datasetId)) return false
    if (command === 'localLyrics.job.read') {
      const p = payload as dto.LocalLyricsJobReadRequest
      return value.jobId === p.jobId && (Object.hasOwn(p,'albumId')
        ? Object.hasOwn(value,'originalEntry') && (value.originalEntry === null || value.originalEntry !== undefined && value.originalEntry.scope.albumId === p.albumId)
        : !Object.hasOwn(value,'originalEntry'))
    }
    if (Object.hasOwn(value,'originalEntry')) return false
    if (command === 'localLyrics.job.start') { const p=payload as dto.LocalLyricsJobStartRequest;return value.jobId===p.commandId && equalLibrary(value.library,p.library) }
    return value.jobId === (payload as dto.LocalLyricsJobRequest).jobId
  } catch { return false }
}



/** 仅供Root真实Owner装配；这些身份由原Owner签发，不从公开payload或新UUID生成。 */
export interface LocalWorkbenchRootAuthorBinding {
  readonly datasetId: string
  readonly ownerEpoch: string
  readonly childGeneration: number
  readonly authorityRef: object
}
export type LocalWorkbenchRootMainRequest =
  | { [C in dto.LocalLibraryManagementCommand]: { family: 'management'; command: C; payload: dto.LocalLibraryManagementPayloads[C] } }[dto.LocalLibraryManagementCommand]
  | { [C in dto.LocalNameSettingsCommand]: { family: 'nameSettings'; command: C; payload: dto.LocalNameSettingsPayloads[C] } }[dto.LocalNameSettingsCommand]
  | { [C in dto.LocalLyricsCommand]: { family: 'lyrics'; command: C; payload: dto.LocalLyricsCommandPayloads[C] } }[dto.LocalLyricsCommand]
export type LocalWorkbenchRootMainResult = dto.LocalLibraryManagementResults[dto.LocalLibraryManagementCommand]
  | dto.LocalNameSettingsResults[dto.LocalNameSettingsCommand] | dto.LocalLyricsCommandResults[dto.LocalLyricsCommand]
export interface LocalWorkbenchRootMainContext {
  readonly binding: Readonly<LocalWorkbenchRootAuthorBinding>
  readonly signal: AbortSignal
  /** 单次Main响应原2000ms绝对期限；写入仍按原command/body持久化，不因响应超时重发。 */
  readonly deadlineAtMs: number
}
export interface LocalWorkbenchRootMainAuthor {
  readonly binding: Readonly<LocalWorkbenchRootAuthorBinding>
  /** 必须实查同一Owner identity/epoch及实际Utility generation；不能返回固定scope Promise。 */
  assertCurrent(binding: Readonly<LocalWorkbenchRootAuthorBinding>): Promise<void>
  request(request: LocalWorkbenchRootMainRequest, context: LocalWorkbenchRootMainContext): Promise<LocalWorkbenchRootMainResult>
  requestOwner<C extends DatasetWorkbenchOwnerCommand>(command: C, payload: DatasetWorkbenchOwnerPayloads[C], context: LocalWorkbenchRootMainContext): Promise<DatasetWorkbenchOwnerResults[C]>
}
type LocalWorkbenchMainManagedRequest = LocalWorkbenchRootMainRequest | { family: 'management'; command: 'library.import.cancel'; payload: dto.LocalLibraryManagementMainPayloads['library.import.cancel'] }
type LocalWorkbenchMainManagedResult = LocalWorkbenchRootMainResult | dto.LocalLibraryManagementMainResults['library.import.cancel']
export interface LocalWorkbenchManagementBoundaryOptions<E> {
  assertTrusted(event: E): void
  isAccepting(): boolean
  /** Root须在实际Owner prepare/commit与Main onReady后提供；缺口返回未就绪，不造能力。 */
  currentAuthor(): LocalWorkbenchRootMainAuthor | undefined
  /** 三个设置命令只到Main本地文件与独立safeStorage保险库。 */
  nameSettings?: Pick<ReturnType<typeof createLocalNameSettings>, 'read' | 'save' | 'securityPrompt'>
  /** 人工目录选择/原许可登记在有限Owner请求起点之前完成。 */
  prepareLibraryImport?(context: LocalWorkbenchMainPreparationContext): Promise<dto.LocalLibraryImportChoice | null>
  /** 仅Main原临时choice的物理撤销；不派发Owner第40条命令。 */
  cancelLibraryImport?(request: dto.LocalLibraryManagementMainPayloads['library.import.cancel'], context: LocalWorkbenchMainPreparationContext): Promise<dto.LocalLibraryManagementMainResults['library.import.cancel']>
  /** 仅实际trusted请求受理记录；不是DTO→写许可。 */
  acceptDirectoryRequest?(request:LocalWorkbenchRootMainRequest,context:LocalWorkbenchMainPreparationContext):Promise<object|undefined>
  acceptLyricsRequest?(request: Extract<LocalWorkbenchRootMainRequest, { family: 'lyrics' }>, context: LocalWorkbenchMainPreparationContext): Promise<void>
  observeLyricsResult?(request: Extract<LocalWorkbenchRootMainRequest, { family: 'lyrics' }>, result: LocalWorkbenchRootMainResult, context: LocalWorkbenchMainPreparationContext): Promise<void>
  acceptNameRequest?(request: LocalWorkbenchRootMainRequest, context: LocalWorkbenchMainPreparationContext): Promise<object | undefined>
  observeNameResult?(request: LocalWorkbenchRootMainRequest, result: LocalWorkbenchRootMainResult, context: LocalWorkbenchMainPreparationContext): Promise<void>
  closeMainResources?(): Promise<void>
}
export interface LocalWorkbenchMainPreparationContext {
  directoryUiToken?:object
  nameUiToken?:object
  readonly binding: Readonly<LocalWorkbenchRootAuthorBinding>
  readonly signal: AbortSignal
  assertCurrent(): Promise<void>
}
export class LocalWorkbenchMainBoundaryError extends Error {
  constructor(readonly code: 'INVALID_IPC_REQUEST' | 'INVALID_IPC_RESPONSE' | 'OUTBOX_SCOPE_MISMATCH' | 'NOT_READY' | 'TIMEOUT', message: string) {
    super(`[${code}] ${message}`)
    this.name = 'LocalWorkbenchMainBoundaryError'
  }
}
const mainBoundaryFailure = (code: ConstructorParameters<typeof LocalWorkbenchMainBoundaryError>[0], message: string): never => {
  throw new LocalWorkbenchMainBoundaryError(code, message)
}
const mainBindingEqual = (left: Readonly<LocalWorkbenchRootAuthorBinding>, right: Readonly<LocalWorkbenchRootAuthorBinding>): boolean =>
  left.datasetId === right.datasetId && left.ownerEpoch === right.ownerEpoch && left.childGeneration === right.childGeneration && left.authorityRef === right.authorityRef
function mainAuthorBinding(value: unknown): value is Readonly<LocalWorkbenchRootAuthorBinding> {
  return ownResult(value, ['datasetId', 'ownerEpoch', 'childGeneration', 'authorityRef']) && dto.isCommandOutboxDatasetId(value.datasetId)
    && dto.isLocalLyricsId(value.ownerEpoch) && Number.isSafeInteger(value.childGeneration) && Number(value.childGeneration) > 0
    && value.authorityRef !== null && typeof value.authorityRef === 'object'
}
function mainFamilyRequest(family: LocalWorkbenchRootMainRequest['family'], value: unknown): { datasetId: string; request: LocalWorkbenchMainManagedRequest } {
  if (!ownResult(value, ['datasetId', 'command', 'payload']) || !dto.isCommandOutboxDatasetId(value.datasetId) || !publicDataResult(value.payload)) return mainBoundaryFailure('INVALID_IPC_REQUEST', '整理边界请求无效。')
  const valid = family === 'management' ? dto.isLocalLibraryManagementMainCommand(value.command) && dto.isLocalLibraryManagementMainPayload(value.command, value.payload)
    : family === 'nameSettings' ? dto.isLocalNameSettingsCommand(value.command) && dto.isLocalNameSettingsPayload(value.command, value.payload)
      : (dto.LOCAL_LYRICS_COMMANDS as readonly unknown[]).includes(value.command) && dto.isLocalLyricsCommandPayload(value.command as dto.LocalLyricsCommand, value.payload)
  if (!valid) return mainBoundaryFailure('INVALID_IPC_REQUEST', '整理命令或原正文无效。')
  // 在任何await之前保存原command/body；不把回复时的表单状态当原意图。
  const request = structuredClone({ family, command: value.command, payload: value.payload }) as LocalWorkbenchMainManagedRequest
  const mainOnlyCancel = request.family === 'management' && request.command === 'library.import.cancel'
  if (!mainOnlyCancel && !isDatasetWorkbenchRequest(request)) return mainBoundaryFailure('INVALID_IPC_REQUEST', '整理命令不在当前39闭集。')
  if (request.family === 'lyrics' && ('scope' in request.payload && request.payload.scope.datasetId !== value.datasetId || 'library' in request.payload && request.payload.library.datasetId !== value.datasetId))
    return mainBoundaryFailure('OUTBOX_SCOPE_MISMATCH', '原歌词请求不属于当前工作库。')
  return { datasetId: value.datasetId, request }
}
function mainFamilyResult(request: LocalWorkbenchMainManagedRequest, value: unknown, datasetId: string): value is LocalWorkbenchMainManagedResult {
  if (!publicDataResult(value)) return false
  if (request.family === 'management' && request.command === 'library.import.cancel') return dto.isLocalLibraryManagementMainResult(request.command, value, request.payload)
  if (!isDatasetWorkbenchResult(request,value,datasetId)) return false
  if (request.family === 'management') return dto.isLocalLibraryManagementResult(request.command, value, request.payload)
    && (value === null || typeof value !== 'object' || !('datasetId' in value) || value.datasetId === datasetId)
  if (request.family === 'nameSettings') return dto.isLocalNameSettingsResult(request.command, value, request.payload)
  return isLocalWorkbenchLyricsMainResult(request.command, value, request.payload, datasetId)
}
/** Main只接受三个有限族。超时撤回响应资格；实际任务保留至settle，close不冒充物理退出。 */
export function createLocalWorkbenchManagementBoundary<E>(options: LocalWorkbenchManagementBoundaryOptions<E>) {
  type Flight = { controller: AbortController; rejectRevoked(error: LocalWorkbenchMainBoundaryError): void; task: Promise<LocalWorkbenchMainManagedResult> }
  const flights = new Set<Flight>()
  let closing = false, closure: Promise<void> | undefined
  function trusted(event: E): void {
    options.assertTrusted(event)
    if (closing || !options.isAccepting()) return mainBoundaryFailure('NOT_READY', '整理作者已退出或正在恢复，请只核对原回执。')
  }
  function inspect(event: E, author: LocalWorkbenchRootMainAuthor, binding: Readonly<LocalWorkbenchRootAuthorBinding>, deadline: number, controller: AbortController): void {
    trusted(event)
    if (controller.signal.aborted || performance.now() >= deadline) return mainBoundaryFailure('TIMEOUT', '原操作响应期限已到，请按原command/body核对回执。')
    if (options.currentAuthor() !== author || !mainAuthorBinding(author.binding) || !mainBindingEqual(author.binding, binding))
      return mainBoundaryFailure('OUTBOX_SCOPE_MISMATCH', '原Owner或Utility身份已改变，请核对原回执。')
  }
  async function dispatch(event: E, family: LocalWorkbenchRootMainRequest['family'], value: unknown,
    droppedPreparation?: (context: LocalWorkbenchMainPreparationContext) => Promise<dto.LocalLibraryImportChoice | null>): Promise<LocalWorkbenchMainManagedResult> {
    trusted(event)
    const original = mainFamilyRequest(family, value), author = options.currentAuthor()
    if (!author || !mainAuthorBinding(author.binding)) return mainBoundaryFailure('NOT_READY', '真实整理Owner接口尚未绑定。')
    const binding = Object.freeze({ ...author.binding })
    if (binding.datasetId !== original.datasetId) return mainBoundaryFailure('OUTBOX_SCOPE_MISMATCH', '原操作不属于当前Owner工作库。')
    if (flights.size >= 24) return mainBoundaryFailure('NOT_READY', '当前整理请求已达预算，请等待原回执。')
    const human = original.request.family === 'nameSettings' && original.request.command === 'name.settings.securityPrompt'
      || original.request.family === 'management' && original.request.command === 'library.import.prepare' && !droppedPreparation
    const controller = new AbortController()
    let deadlineAtMs = human ? Number.POSITIVE_INFINITY : performance.now() + 2_000
    let rejectRevoked!: (error: LocalWorkbenchMainBoundaryError) => void, rejectTimeout!: (error: LocalWorkbenchMainBoundaryError) => void
    const revoked = new Promise<never>((_resolve, reject) => { rejectRevoked = reject })
    const timeout = new Promise<never>((_resolve, reject) => { rejectTimeout = reject })
    let timer: ReturnType<typeof setTimeout> | undefined
    const armDeadline = () => { timer = setTimeout(() => { controller.abort(); rejectTimeout(new LocalWorkbenchMainBoundaryError('TIMEOUT', '原操作尚未确认，请按原session/command/body只读核对。')) }, Math.max(1, deadlineAtMs - performance.now())) }
    if (!human) armDeadline()
    const assertCurrent = async () => {
      inspect(event, author, binding, deadlineAtMs, controller)
      await author.assertCurrent(binding)
      inspect(event, author, binding, deadlineAtMs, controller)
    }
    const prepared: LocalWorkbenchMainPreparationContext = { binding, signal: controller.signal, assertCurrent }
    const task = Promise.resolve().then(async () => {
      await assertCurrent()
      const request = structuredClone(original.request)
      let result: LocalWorkbenchMainManagedResult
      if (request.family === 'management' && request.command === 'library.import.cancel') {
        if (!options.cancelLibraryImport) return mainBoundaryFailure('NOT_READY', '原临时目录取消作者尚未装配。')
        result = await options.cancelLibraryImport(request.payload, prepared)
      } else {
      const directoryUiToken=await options.acceptDirectoryRequest?.(request,prepared);if(directoryUiToken)prepared.directoryUiToken=directoryUiToken
      const nameUiToken=await options.acceptNameRequest?.(request,prepared);if(nameUiToken)prepared.nameUiToken=nameUiToken
      if (request.family === 'nameSettings') {
        const settings = options.nameSettings
        if (!settings) return mainBoundaryFailure('NOT_READY', 'Main本地名称设置与独立安全保险库尚未装配。')
        const context = { signal: controller.signal, assertCurrent }
        switch (request.command) {
          case 'name.settings.read': result = await settings.read(context); break
          case 'name.settings.save': result = await settings.save(request.payload, context); break
          case 'name.settings.securityPrompt': result = await settings.securityPrompt(request.payload, context); break
        }
      } else if (request.family === 'management' && request.command === 'library.import.prepare') {
        const prepare = droppedPreparation ?? options.prepareLibraryImport
        if (!prepare) return mainBoundaryFailure('NOT_READY', '原生目录选择与原Owner许可登记尚未装配。')
        result = await prepare(prepared)
      } else {
        if (request.family === 'lyrics') await options.acceptLyricsRequest?.(request, prepared)
        result = await author.request(request, { binding, signal: controller.signal, deadlineAtMs })
      }
      }
      // 人工等待不计入Owner的原2000ms；只有选择/输入实际结束且原身份仍有效才开始最终回核。
      if (human) { deadlineAtMs = performance.now() + 2_000; armDeadline() }
      await assertCurrent()
      if (!mainFamilyResult(original.request, result, binding.datasetId)) return mainBoundaryFailure('INVALID_IPC_RESPONSE', '原整理结果身份或公开字段无效。')
      if (request.family === 'lyrics') await options.observeLyricsResult?.(request, result as LocalWorkbenchRootMainResult, prepared)
      if (!(request.family === 'management' && request.command === 'library.import.cancel')) await options.observeNameResult?.(request,result as LocalWorkbenchRootMainResult,prepared)
      inspect(event, author, binding, deadlineAtMs, controller)
      return structuredClone(result)
    })
    const flight: Flight = { controller, rejectRevoked, task }; flights.add(flight)
    void task.then(() => flights.delete(flight), () => flights.delete(flight))
    try { return await Promise.race([task, timeout, revoked]) }
    catch (error) {
      if (error instanceof LocalWorkbenchMainBoundaryError) throw error
      const code = error instanceof Error ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined
      if (['INVALID_IPC_REQUEST','INVALID_IPC_RESPONSE','OUTBOX_SCOPE_MISMATCH','NOT_READY','TIMEOUT'].includes(String(code)))
        throw new LocalWorkbenchMainBoundaryError(code as ConstructorParameters<typeof LocalWorkbenchMainBoundaryError>[0], '原整理请求未完成，请按原命令核对结果。')
      throw new LocalWorkbenchMainBoundaryError('NOT_READY', '原整理结果尚未确认，请核对原回执。')
    } finally { if (timer) clearTimeout(timer) }
  }
  function revoke(): void {
    for (const flight of flights) {
      flight.controller.abort()
      flight.rejectRevoked(new LocalWorkbenchMainBoundaryError('NOT_READY', '原整理Owner已撤销，请核对原回执。'))
    }
  }
  return {
    management: (event: E, value: unknown) => dispatch(event, 'management', value),
    /** 仅Main私有drop handler；原公开prepare仍严格{}，不能由Renderer注入callback或路径。 */
    prepareDroppedLibrary(event: E, datasetId: string, prepare: (context: LocalWorkbenchMainPreparationContext) => Promise<dto.LocalLibraryImportChoice | null>): Promise<dto.LocalLibraryImportChoice | null> {
      if (typeof prepare !== 'function') return Promise.reject(new LocalWorkbenchMainBoundaryError('INVALID_IPC_REQUEST', '原生目录drop接点无效。'))
      return dispatch(event, 'management', { datasetId, command: 'library.import.prepare', payload: {} }, prepare) as Promise<dto.LocalLibraryImportChoice | null>
    },
    nameSettings: (event: E, value: unknown) => dispatch(event, 'nameSettings', value),
    lyrics: (event: E, value: unknown) => dispatch(event, 'lyrics', value),
    revoke,
    /** 只封新受理/取消响应，不销毁同epoch实际资源。 */
    seal():void{closing=true;revoke()},
    close(): Promise<void> {
      if (!closure) { closing = true; revoke(); const resources = Promise.resolve().then(() => options.closeMainResources?.()); closure = Promise.allSettled([resources, ...[...flights].map(flight => flight.task)]).then(results => { if (results[0]?.status === 'rejected') throw results[0].reason }) }
      return closure
    },
    pending(): number { return flights.size },
  }
}


/** 原18项Main OwnerPorts的有限装配；Provider/Native writer仍须由Root安装真实作者。 */
export function createLocalWorkbenchTransportOwner(author: LocalWorkbenchRootMainAuthor): LocalWorkbenchOwnerPorts {
  if(!mainAuthorBinding(author.binding)||typeof author.requestOwner!=='function')return mainBoundaryFailure('NOT_READY','原整理Owner端点未安装。')
  const binding=author.binding
  async function call<C extends DatasetWorkbenchOwnerCommand>(command:C,payload:DatasetWorkbenchOwnerPayloads[C],context?:{signal?:AbortSignal;datasetId?:string},deadlineAtMs=performance.now()+2000):Promise<DatasetWorkbenchOwnerResults[C]> {
    if(!mainBindingEqual(binding,author.binding)||context?.datasetId!==undefined&&context.datasetId!==binding.datasetId)return mainBoundaryFailure('OUTBOX_SCOPE_MISMATCH','原整理Owner身份已改变。')
    const signal=context?.signal??new AbortController().signal
    if(signal.aborted||performance.now()>=deadlineAtMs)return mainBoundaryFailure('TIMEOUT','原整理请求尚未确认。')
    if(!isDatasetWorkbenchOwnerRequest({command,payload}))return mainBoundaryFailure('INVALID_IPC_REQUEST','原整理端点请求无效。')
    // requestOwner实际进入当前Utility端口，并在原Owner前后重验；不把固定scope Promise当准入。
    const result=await author.requestOwner(command,structuredClone(payload),{binding,signal,deadlineAtMs})
    if(signal.aborted||performance.now()>=deadlineAtMs)return mainBoundaryFailure('TIMEOUT','原整理回复已迟到。')
    if(!mainBindingEqual(binding,author.binding)||!isDatasetWorkbenchOwnerResult(command,result,payload,binding.datasetId))return mainBoundaryFailure('INVALID_IPC_RESPONSE','原整理回复不属于同一请求。')
    return result
  }
  const owner:LocalWorkbenchOwnerPorts={
    read:{
      readAlbums:(request,context={})=>call('read.albums',request,context),
      resolveCapture:(request,context={})=>call('read.resolveCapture',request,context),
      prepareNameSuggestion:(request,context={})=>call('read.prepareNameSuggestion',request,context),
      completeNameSuggestion:(preparationId,response,context={})=>call('read.completeNameSuggestion',{preparationId,response},context),
      prepareNamePreview:(request,context={})=>call('read.prepareNamePreview',request,context),
      prepareArtworkPreview:(input,context={})=>call('read.prepareArtworkPreview',{reference:{datasetId:input.resolved.datasetId,capture:{albumId:input.resolved.capture.albumId,readToken:input.resolved.capture.readToken}},artwork:input.artwork},context),
      cancelNamePreparation:preparationId=>call('read.cancelNamePreparation',{preparationId}),
    },
    registry:{
      issuePlan:(draft,capture)=>call('registry.issuePlan',{draft,capture}),
      apply:request=>call('registry.apply',request),
      readOriginalReceipt:request=>call('registry.readOriginalReceipt',request),
      cancel:request=>call('registry.cancel',request),
      getPlan:planId=>call('registry.getPlan',{planId}),
      readArtworkCapture:request=>call('registry.readArtworkCapture',request),
      operations:()=>call('registry.operations',{}),
    },
    readCapabilities:context=>call('capabilities.read',{},context),
    readLocalArtwork:(resolved,context)=>call('artwork.readLocal',{datasetId:resolved.datasetId,capture:{albumId:resolved.capture.albumId,readToken:resolved.capture.readToken}},context),
    async prepareCuePreview(request,target,context){
      const deadlineAtMs=performance.now()+2000
      // 方法仅在Main持有真实对象；wire只能传原descriptor，绝不传函数或路径。
      if(typeof target.assertCurrent!=='function'||typeof target.withDirectory!=='function'||typeof target.close!=='function')return mainBoundaryFailure('NOT_READY','独立目标未取得实际原生许可。')
      await target.assertCurrent(context)
      const result=await call('cue.preparePreview',{request,target:{target:structuredClone(target.target),revision:target.revision}},context,deadlineAtMs)
      await target.assertCurrent(context)
      if(performance.now()>=deadlineAtMs||context.signal.aborted)return mainBoundaryFailure('TIMEOUT','原分轨预览回复已迟到。')
      return result
    },
    openExisting:(request,context)=>call('existing.open',request,context),
  }
  transportOwnerInstances.add(owner);return owner
}


/** Main每代资源只绑定原真实作者；source许可仍由专用端口及原Owner账本核收。 */
export interface LocalWorkbenchMainResources {
  service: LocalWorkbenchService
  nameTransport?: TrackedLocalNameTransport
  names: Pick<ReturnType<typeof createLocalNameSettings>, 'read' | 'save' | 'securityPrompt'>
  close(): Promise<void>
}
export function createLocalWorkbenchMainAssembly(options: {
  currentAuthor(): LocalWorkbenchRootMainAuthor | undefined
  createResources(author: LocalWorkbenchRootMainAuthor): LocalWorkbenchMainResources | Promise<LocalWorkbenchMainResources>
}) {
  let current: { author: LocalWorkbenchRootMainAuthor; resources: LocalWorkbenchMainResources } | undefined
  let closed = false, readsClosed = false, closingReads: Promise<void> | undefined, serial: Promise<void> = Promise.resolve()
  const retiring = new Set<Promise<void>>()
  let shutdownFailure: unknown
  const libraryRemovals=new Map<string,{author:LocalWorkbenchRootMainAuthor;binding:Readonly<LocalWorkbenchRootAuthorBinding>;original:LocalWorkbenchLibraryRemovalReference}>()
  const retire = (resources: LocalWorkbenchMainResources): Promise<void> => {
    const task = Promise.resolve().then(() => resources.close()).catch(error => { shutdownFailure = error; throw error }).finally(() => retiring.delete(task))
    retiring.add(task); void task.catch(() => undefined); return task
  }
  function original() {
    const item = current
    if (closed || readsClosed || !item || options.currentAuthor() !== item.author) return mainBoundaryFailure('NOT_READY', '当前Main整理资源尚未绑定真实Owner。')
    return item
  }
  async function captureAuthor(datasetId: string): Promise<() => Promise<void>> {
    const item = original(), binding = item.author.binding
    if (binding.datasetId !== datasetId) return mainBoundaryFailure('OUTBOX_SCOPE_MISMATCH', '原Main整理资源不属于该工作库。')
    const check = async () => {
      if (closed || current !== item || options.currentAuthor() !== item.author || !mainBindingEqual(binding,item.author.binding)) return mainBoundaryFailure('OUTBOX_SCOPE_MISMATCH', '原Main整理资源已换代。')
      await item.author.assertCurrent(binding)
      if (closed || current !== item || options.currentAuthor() !== item.author || !mainBindingEqual(binding,item.author.binding)) return mainBoundaryFailure('OUTBOX_SCOPE_MISMATCH', '原Main整理资源已换代。')
    }
    await check(); return check
  }
  return {
    activate(author: LocalWorkbenchRootMainAuthor): Promise<void> {
      const task = serial.then(async () => {
        if (closed || readsClosed || options.currentAuthor() !== author || !mainAuthorBinding(author.binding)) return mainBoundaryFailure('NOT_READY', '真实Main整理作者已撤销。')
        if (current?.author === author) return
        const previous = current; current = undefined
        if (previous) await retire(previous.resources)
        await Promise.allSettled([...retiring]); if (shutdownFailure) throw shutdownFailure
        await author.assertCurrent(author.binding)
        if (closed || readsClosed || options.currentAuthor() !== author) return mainBoundaryFailure('NOT_READY', '真实Main整理作者已撤销。')
        const resources = await options.createResources(author)
        if (closed || readsClosed || options.currentAuthor() !== author) { await retire(resources); return mainBoundaryFailure('NOT_READY', '真实Main整理作者已撤销。') }
        try { await author.assertCurrent(author.binding) }
        catch (error) { await retire(resources); throw error }
        if (closed || readsClosed || options.currentAuthor() !== author) { await retire(resources); return mainBoundaryFailure('NOT_READY', '真实Main整理作者已撤销。') }
        current = { author, resources }
      })
      serial = task.then(() => undefined, () => undefined); return task
    },
    captureAuthor,
    async registerLibraryRemovalIntent(request:LocalWorkbenchRootMainRequest,context:LocalWorkbenchMainPreparationContext):Promise<LocalWorkbenchLibraryRemovalReference|undefined>{
      if(request.family!=='management'||request.command!=='library.remove')return undefined
      await context.assertCurrent();const item=original()
      if(!mainBindingEqual(context.binding,item.author.binding)||!dto.isLocalLibraryManagementPayload('library.remove',request.payload))return mainBoundaryFailure('OUTBOX_SCOPE_MISMATCH','原库撤销Main意图与作者不匹配。')
      const ref:LocalWorkbenchLibraryRemovalReference={datasetId:context.binding.datasetId,ownerEpoch:context.binding.ownerEpoch,commandId:request.payload.commandId,libraryIds:[...request.payload.libraryIds],originalSha256:localLibraryManagementDigest({command:request.command,request:request.payload})}
      const prior=libraryRemovals.get(ref.commandId)
      if(prior&&(prior.author!==item.author||!mainBindingEqual(prior.binding,context.binding)||!same(prior.original,ref)))return mainBoundaryFailure('INVALID_IPC_REQUEST','原库撤销command/body不能变更。')
      if(!prior&&libraryRemovals.size>=512)return mainBoundaryFailure('NOT_READY','原库撤销意图达到现有预算。')
      libraryRemovals.set(ref.commandId,{author:item.author,binding:Object.freeze({...context.binding}),original:structuredClone(ref)});await context.assertCurrent();return structuredClone(ref)
    },
    async stopLibraryReaders(input:LocalWorkbenchLibraryReadersFence,binding:Readonly<LocalWorkbenchRootAuthorBinding>):Promise<void>{
      if(!ownResult(input,['commandId','originalSha256','libraryId','datasetId','ownerEpoch'])||!publicDataResult(input)
        ||!dto.isCommandOutboxDatasetId(input.datasetId)||!dto.isLocalLyricsId(input.ownerEpoch)||!dto.isLocalLyricsId(input.libraryId)
        ||!dto.isLocalLyricsId(input.commandId)||!/^[0-9a-f]{64}$/u.test(input.originalSha256))return mainBoundaryFailure('INVALID_IPC_REQUEST','原库读者fence正文不在闭集。')
      const item=original(),prior=libraryRemovals.get(input.commandId)
      if(!prior||prior.author!==item.author||!mainAuthorBinding(binding)||!mainBindingEqual(binding,item.author.binding)||!mainBindingEqual(prior.binding,binding)
        ||input.datasetId!==binding.datasetId||input.ownerEpoch!==binding.ownerEpoch||prior.original.datasetId!==input.datasetId||prior.original.ownerEpoch!==input.ownerEpoch
        ||prior.original.originalSha256!==input.originalSha256||!prior.original.libraryIds.includes(input.libraryId))return mainBoundaryFailure('NOT_READY','原Owner撤销尚无匹配Main意图，保留UNKNOWN。')
      await item.author.assertCurrent(binding)
      if(current!==item||options.currentAuthor()!==item.author||!mainBindingEqual(binding,item.author.binding))return mainBoundaryFailure('OUTBOX_SCOPE_MISMATCH','原库读者关闭前Main作者已换代。')
      await item.resources.service.stopLibraryReaders(prior.original,input.libraryId)
      if(current!==item||options.currentAuthor()!==item.author||!mainBindingEqual(binding,item.author.binding))return mainBoundaryFailure('OUTBOX_SCOPE_MISMATCH','原库读者关闭时Main作者已换代。')
      await item.author.assertCurrent(binding)
    },
    async nameTransport(binding: Readonly<LocalWorkbenchRootAuthorBinding>): Promise<TrackedLocalNameTransport> {
      const item=original()
      if(!mainBindingEqual(binding,item.author.binding))return mainBoundaryFailure('OUTBOX_SCOPE_MISMATCH','名称后端不属于原Main作者。')
      await item.author.assertCurrent(binding)
      if(current!==item||options.currentAuthor()!==item.author||!isTrackedLocalNameTransport(item.resources.nameTransport))return mainBoundaryFailure('NOT_READY','原Main名称后端未实际装配。')
      return item.resources.nameTransport
    },
    async request(request: LocalWorkbenchMainRequest, context: LocalWorkbenchMainContext) {
      const item = original(), assertCurrent = context.assertCurrent ?? await captureAuthor(context.datasetId)
      await assertCurrent(); const result = await item.resources.service.request(request,{...context,assertCurrent}); await assertCurrent(); return result
    },
    nameSettings: {
      async read(context: Parameters<ReturnType<typeof createLocalNameSettings>['read']>[0]) { const item=original(); await context?.assertCurrent(); const result=await item.resources.names.read(context); await context?.assertCurrent(); if(current!==item)return mainBoundaryFailure('OUTBOX_SCOPE_MISMATCH','原名称设置作者已撤销。');return result },
      async save(request: dto.LocalNameSettingsPayloads['name.settings.save'], context: Parameters<ReturnType<typeof createLocalNameSettings>['save']>[1]) { const item=original(); await context.assertCurrent(); const result=await item.resources.names.save(request,context); await context.assertCurrent(); if(current!==item)return mainBoundaryFailure('OUTBOX_SCOPE_MISMATCH','原名称设置作者已撤销。');return result },
      async securityPrompt(request: dto.LocalNameSettingsPayloads['name.settings.securityPrompt'], context: Parameters<ReturnType<typeof createLocalNameSettings>['securityPrompt']>[1]) { const item=original(); await context.assertCurrent(); const result=await item.resources.names.securityPrompt(request,context); await context.assertCurrent(); if(current!==item)return mainBoundaryFailure('OUTBOX_SCOPE_MISMATCH','原安全输入作者已撤销。');return result },
    },
    /** 封新页面/设置输入并停止本代HTTP读取，批准FD与写作者留给原Owner清理。 */
    closeReadResources():Promise<void>{if(!closingReads){readsClosed=true;closingReads=(async()=>{await serial;await current?.resources.service.closeReadResources()})();}return closingReads},
    revoke(): void { const previous=current;current=undefined;if(previous)void retire(previous.resources).catch(()=>undefined) },
    async close(): Promise<void> { closed=true; const previous=current;current=undefined;if(previous)void retire(previous.resources).catch(()=>undefined);await serial;await Promise.allSettled([...retiring]);if(shutdownFailure)throw shutdownFailure },
  }
}


interface NameAcceptedJob {
  author:LocalWorkbenchRootMainAuthor;binding:Readonly<LocalWorkbenchRootAuthorBinding>;
  jobId:string;original:dto.LocalLibraryManagementPayloads['library.ai.start']|null;captureId:string|null;backend:dto.LocalAiBackend|null;sha256:string|null;attempt:number;
  accepted:Promise<void>;accept():void;reject(error:unknown):void;settled:boolean;
  used:Map<string,{sha256:string;bodySha256:string;expiresAtMs:number;attempt:number}>;
}
interface NameOperation {
  start:DatasetNameProviderStart;sha256:string;job:NameAcceptedJob;binding:Readonly<LocalWorkbenchRootAuthorBinding>;
  controller:AbortController;timer:ReturnType<typeof setTimeout>;transport:TrackedLocalNameTransport;
  operation:Promise<LocalNamePrivateContent>;physical:Promise<void>;state:DatasetNameProviderState;
  raw:Buffer|null;failure:DatasetNameProviderFailure|null;joined:boolean;
}
/** 只等待原响应期限；底层任务保留原身份继续收口，不能以race成功冒充join。 */
function nameReceiptWait<T>(work:Promise<T>,context:LocalWorkbenchRootMainContext):Promise<T>{
  if(context.signal.aborted||!Number.isFinite(context.deadlineAtMs)||context.deadlineAtMs<=performance.now())return Promise.reject(new DatasetNameProviderBridgeError('TIMEOUT'))
  return new Promise((resolve,reject)=>{
    const stop=()=>reject(new DatasetNameProviderBridgeError('TIMEOUT'))
    const timer=setTimeout(stop,Math.max(1,Math.min(DATASET_WORKBENCH_BOUNDS.requestMs,context.deadlineAtMs-performance.now())))
    context.signal.addEventListener('abort',stop,{once:true})
    void work.then(resolve,reject).finally(()=>{clearTimeout(timer);context.signal.removeEventListener('abort',stop)})
    if(context.signal.aborted)stop()
  })
}
function nameFailure(error:unknown):DatasetNameProviderFailure{
  if(error instanceof DatasetNameProviderBridgeError)return error.code
  const code=error instanceof LocalProviderError?error.code:''
  return code==='cancelled'?'CANCELLED':code==='timeout'?'TIMEOUT':code==='budget'?'BUDGET':code==='transport'?'NETWORK':code==='status'?'HTTP_STATUS':code==='response'?'INVALID_RESPONSE':'NOT_READY'
}
/** Main保存真正受理的原UI请求及Owner回执；queued DTO和Mock actor都不能构造此桥的许可。 */
export function createLocalWorkbenchNameMainBridge(options:{
  currentAuthor():LocalWorkbenchRootMainAuthor|undefined;
  getTransport(binding:Readonly<LocalWorkbenchRootAuthorBinding>):Promise<TrackedLocalNameTransport>|TrackedLocalNameTransport;
}){
  if(!isLocalWorkbenchDataRecord(options,['currentAuthor','getTransport'])||Reflect.ownKeys(options).length!==2||typeof options.currentAuthor!=='function'||typeof options.getTransport!=='function')throw new DatasetNameProviderBridgeError('INVALID_INPUT')
  const jobs=new Map<string,NameAcceptedJob>(),operations=new Map<string,NameOperation>()
  const ui=new WeakMap<object,{job:NameAcceptedJob;request:LocalWorkbenchRootMainRequest;context:LocalWorkbenchMainPreparationContext}>()
  const starting=new Map<string,{sha256:string;binding:Readonly<LocalWorkbenchRootAuthorBinding>;task:Promise<NameOperation>}>()
  const sequences=new WeakMap<object,number>(),revoked=new WeakSet<object>(),sealed=new WeakSet<object>()
  let closed=false
  const actual=async(binding:Readonly<LocalWorkbenchRootAuthorBinding>,signal?:AbortSignal):Promise<LocalWorkbenchRootMainAuthor>=>{
    const author=options.currentAuthor()
    if(closed||sealed.has(binding.authorityRef)||revoked.has(binding.authorityRef)||signal?.aborted||!author||!mainBindingEqual(binding,author.binding))throw new DatasetNameProviderBridgeError('NOT_READY')
    await author.assertCurrent(binding)
    if(closed||sealed.has(binding.authorityRef)||revoked.has(binding.authorityRef)||signal?.aborted||options.currentAuthor()!==author||!mainBindingEqual(binding,author.binding))throw new DatasetNameProviderBridgeError('NOT_READY')
    return author
  }
  const preparedJob=(jobId:string,original:dto.LocalLibraryManagementPayloads['library.ai.start']|null,author:LocalWorkbenchRootMainAuthor,previous?:NameAcceptedJob):NameAcceptedJob=>{
    let accept!:()=>void,reject!:(error:unknown)=>void
    const accepted=new Promise<void>((resolve,fail)=>{accept=resolve;reject=fail});void accepted.catch(()=>undefined)
    return {jobId,original:original?structuredClone(original):null,captureId:original?.captureId??previous?.captureId??null,backend:original?.backend??previous?.backend??null,author,binding:author.binding,sha256:original?datasetNameOriginalStartSha256(original):previous?.sha256??null,attempt:(previous?.attempt??0)+1,accepted,accept,reject,settled:false,used:previous?.used??new Map()}
  }
  const startOperation=async(start:DatasetNameProviderStart,context:LocalWorkbenchRootMainContext):Promise<NameOperation>=>{
    const author=await actual(context.binding,context.signal),job=jobs.get(start.jobId)
    if(!job||job.author!==author||!mainBindingEqual(job.binding,context.binding))throw new DatasetNameProviderBridgeError('NOT_READY')
    await nameReceiptWait(job.accepted,context)
    await actual(context.binding,context.signal)
    if(jobs.get(start.jobId)!==job||job.captureId!==start.captureId||job.sha256!==null&&job.sha256!==start.originalStartSha256||job.backend!==null&&job.backend!==start.backend
      ||job.original?.selection==='selected'&&!job.original.albumIds.includes(start.albumId))throw new DatasetNameProviderBridgeError('NOT_READY')
    // cold的正文/expandedSelection只由唯一Root同SQL读取；此处只绑定受认证原Owner wire的首个元组。
    if(job.sha256===null){job.sha256=start.originalStartSha256;job.backend=start.backend}
    const previous=job.used.get(start.operationId),sha256=datasetWorkbenchSha(datasetWorkbenchJson(start))
    const {preparationId:_preparation,expiresAtMs:_expiry,...originalBody}=start,bodySha256=datasetWorkbenchSha(datasetWorkbenchJson(originalBody))
    // 新准备引用只可来自实际受理的新attempt；原正文保持完整，原期限不能延长。
    if(previous&&(previous.bodySha256!==bodySha256||start.expiresAtMs>previous.expiresAtMs||previous.attempt===job.attempt))throw new DatasetNameProviderBridgeError('INVALID_INPUT')
    if(!Number.isSafeInteger(start.expiresAtMs)||start.expiresAtMs<=Date.now()||start.expiresAtMs-Date.now()>900_000)throw new DatasetNameProviderBridgeError('TIMEOUT')
    const transport=await options.getTransport(context.binding)
    if(!isTrackedLocalNameTransport(transport)||!await nameReceiptWait(transport.configured(start.backend,context.signal),context))throw new DatasetNameProviderBridgeError('NOT_READY')
    await actual(context.binding,context.signal)
    if(jobs.get(start.jobId)!==job||operations.size>=DATASET_WORKBENCH_BOUNDS.pending)throw new DatasetNameProviderBridgeError('BUDGET')
    if(start.expiresAtMs<=Date.now())throw new DatasetNameProviderBridgeError('TIMEOUT')
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort('provider-timeout'),start.expiresAtMs-Date.now())
    const operation=transport.suggest({backend:start.backend,systemPrompt:start.systemPrompt,userPrompt:start.userPrompt},controller.signal)
    const row:NameOperation={start:structuredClone(start),sha256,job,binding:context.binding,controller,timer,transport,operation,physical:Promise.resolve(),state:'running',raw:null,failure:null,joined:false}
    job.used.set(start.operationId,{sha256,bodySha256,expiresAtMs:start.expiresAtMs,attempt:job.attempt});operations.set(start.operationId,row)
    // 真正transport join结束前不暴露complete，也不从迟到正文生成proposal。
    let physicalJoined=false
    row.physical=(async()=>{
      let content:LocalNamePrivateContent|undefined,error:unknown
      try{content=await operation}catch(cause){error=cause}
      await transport.join(operation);physicalJoined=true
      if(controller.signal.aborted||Date.now()>=start.expiresAtMs){row.state='cancelled';row.failure=controller.signal.reason==='provider-timeout'?'TIMEOUT':'CANCELLED';return}
      await actual(row.binding)
      if(error!==undefined){row.state='failed';row.failure=nameFailure(error);return}
      if(!content||content.backend!==start.backend||typeof content.content!=='string'||!content.content.trim()||Buffer.byteLength(content.content,'utf8')>256*1024||Buffer.from(content.content,'utf8').toString('utf8')!==content.content)throw new DatasetNameProviderBridgeError('INVALID_RESPONSE')
      const raw=Buffer.from(datasetWorkbenchJson(content));if(raw.byteLength>DATASET_NAME_PROVIDER_CONTENT_BYTES)throw new DatasetNameProviderBridgeError('BUDGET')
      row.raw=raw;row.state='complete';row.failure=null
    })().catch(error=>{row.raw=null;row.state=controller.signal.aborted?'cancelled':'failed';row.failure=nameFailure(error);if(!physicalJoined)throw error}).finally(()=>clearTimeout(timer))
    void row.physical.catch(()=>undefined)
    return row
  }
  return {
    async accept(request:LocalWorkbenchRootMainRequest,context:LocalWorkbenchMainPreparationContext):Promise<object|undefined>{
      if(request.family!=='management'||!['library.ai.start','library.job.resume','library.job.retry'].includes(request.command))return undefined
      await context.assertCurrent();const author=await actual(context.binding,context.signal)
      let previous:NameAcceptedJob|undefined,original:dto.LocalLibraryManagementPayloads['library.ai.start']|null,jobId:string
      if(request.command==='library.ai.start'){
        original=structuredClone(request.payload as dto.LocalLibraryManagementPayloads['library.ai.start'])
        jobId=original.commandId;previous=jobs.get(jobId)
        if(previous&&(previous.author!==author||previous.sha256!==null&&previous.sha256!==datasetNameOriginalStartSha256(original)))throw new DatasetNameProviderBridgeError('INVALID_INPUT')
      }else{
        jobId=(request.payload as {jobId:string}).jobId;previous=jobs.get(jobId)
        if(previous&&(previous.author!==author||!mainBindingEqual(previous.binding,context.binding)))throw new DatasetNameProviderBridgeError('NOT_READY')
        original=previous?.original??null
      }
      if(!previous&&jobs.size>=DATASET_WORKBENCH_BOUNDS.pending)throw new DatasetNameProviderBridgeError('BUDGET')
      if(original){const transport=await options.getTransport(context.binding)
        if(!isTrackedLocalNameTransport(transport)||!await transport.configured(original.backend,context.signal))throw new DatasetNameProviderBridgeError('NOT_READY')}
      await context.assertCurrent();await actual(context.binding,context.signal)
      const job=preparedJob(jobId,original,author,previous),token=Object.freeze({})
      if(request.command==='library.ai.start'&&previous)job.attempt=previous.attempt
      jobs.set(jobId,job);ui.set(token,{job,request:structuredClone(request),context})
      const abort=()=>{if(!job.settled){job.settled=true;job.reject(new DatasetNameProviderBridgeError('NOT_READY'));if(jobs.get(jobId)===job)jobs.delete(jobId)}}
      context.signal.addEventListener('abort',abort,{once:true})
      void job.accepted.then(()=>context.signal.removeEventListener('abort',abort),()=>context.signal.removeEventListener('abort',abort))
      if(context.signal.aborted)abort()
      return token
    },
    async observe(request:LocalWorkbenchRootMainRequest,result:LocalWorkbenchRootMainResult,context:LocalWorkbenchMainPreparationContext):Promise<void>{
      if(request.family!=='management')return
      if(context.nameUiToken){
        const accepted=ui.get(context.nameUiToken)
        if(!accepted||accepted.context!==context||datasetWorkbenchSha(datasetWorkbenchJson(accepted.request))!==datasetWorkbenchSha(datasetWorkbenchJson(request)))throw new DatasetNameProviderBridgeError('INVALID_INPUT')
        const {job}=accepted;await context.assertCurrent();await actual(context.binding,context.signal)
        if(jobs.get(job.jobId)!==job||job.settled||!dto.isLocalLibraryManagementResult(request.command,result,request.payload))throw new DatasetNameProviderBridgeError('INVALID_RESPONSE')
        const page=result as dto.LocalLibraryBatchPage
        if(page.jobId!==job.jobId||job.captureId!==null&&page.captureId!==job.captureId||job.original!==null&&page.kind!=='ai')throw new DatasetNameProviderBridgeError('INVALID_RESPONSE')
        if(page.kind!=='ai'||['failed','unknown','stopped'].includes(page.state)){
          job.settled=true;job.reject(new DatasetNameProviderBridgeError('NOT_READY'));ui.delete(context.nameUiToken)
          if(page.kind!=='ai')jobs.delete(job.jobId)
          return
        }
        job.captureId=page.captureId;job.settled=true;job.accept();ui.delete(context.nameUiToken)
      }
      if(['library.job.stop','library.job.read'].includes(request.command)&&result&&typeof result==='object'&&'jobId'in result&&'state'in result){
        const page=result as dto.LocalLibraryBatchPage
        if(page.state==='stopped')for(const row of operations.values())if(row.start.jobId===page.jobId&&mainBindingEqual(row.binding,context.binding))row.controller.abort('provider-cancelled')
        if(['complete','partial','failed','unknown'].includes(page.state)&&![...operations.values()].some(row=>row.start.jobId===page.jobId))jobs.delete(page.jobId)
      }
    },
    async execute(request:DatasetNameProviderRequest,context:LocalWorkbenchRootMainContext):Promise<DatasetProjectionCommandResults[DatasetNameProviderCommand]>{
      const q=captureDatasetNameProviderRequest(request),cleanup=q.command==='nameProviderCancel'||q.command==='nameProviderJoin'
      if(q.epoch!==context.binding.ownerEpoch||q.datasetId!==context.binding.datasetId||!mainAuthorBinding(context.binding)||q.sequence<=(sequences.get(context.binding.authorityRef)??0))throw new DatasetNameProviderBridgeError('INVALID_INPUT')
      sequences.set(context.binding.authorityRef,q.sequence)
      // draining时只复用已登记原operation及原binding读回，不重取Main作者。
      const original=operations.get(q.payload.operationId)
      const author=options.currentAuthor()
      const originalRead=q.command==='nameProviderRead'&&!closed&&!revoked.has(context.binding.authorityRef)
        &&!context.signal.aborted&&Number.isFinite(context.deadlineAtMs)&&performance.now()<context.deadlineAtMs
        &&sealed.has(context.binding.authorityRef)&&author!==undefined&&mainBindingEqual(author.binding,context.binding)
        &&original!==undefined&&mainBindingEqual(original.binding,context.binding)
      if(!cleanup&&!originalRead)await actual(context.binding,context.signal)
      if(q.command==='nameProviderStart'&&sealed.has(context.binding.authorityRef))throw new DatasetNameProviderBridgeError('NOT_READY')
      if(q.command==='nameProviderStart'){
        const start=q.payload as DatasetNameProviderStart,sha256=datasetWorkbenchSha(datasetWorkbenchJson(start)),existing=operations.get(start.operationId)
        if(existing){if(existing.sha256!==sha256||!mainBindingEqual(existing.binding,context.binding))throw new DatasetNameProviderBridgeError('INVALID_INPUT');return{operationId:start.operationId,state:existing.state}}
        let entry=starting.get(start.operationId)
        if(entry&&entry.sha256!==sha256)throw new DatasetNameProviderBridgeError('INVALID_INPUT')
        if(!entry){if(starting.size>=DATASET_WORKBENCH_BOUNDS.pending)throw new DatasetNameProviderBridgeError('BUDGET');const task=startOperation(start,context);entry={sha256,binding:context.binding,task};starting.set(start.operationId,entry);void task.finally(()=>starting.delete(start.operationId)).catch(()=>undefined)}
        const row=await nameReceiptWait(entry.task,context);return{operationId:start.operationId,state:row.state}
      }
      const row=operations.get(q.payload.operationId)
      if(!row||!mainBindingEqual(row.binding,context.binding))throw new DatasetNameProviderBridgeError('NOT_READY')
      if(q.command==='nameProviderCancel'){row.controller.abort('provider-cancelled');return{operationId:row.start.operationId,cancelRequested:true}}
      if(q.command==='nameProviderJoin'){
        await nameReceiptWait(row.physical,context)
        row.joined=true;operations.delete(row.start.operationId)
        return{operationId:row.start.operationId,physicalClosed:true}
      }
      const offset=(q.payload as {offset:number}).offset
      if(row.state!=='complete')return{operationId:row.start.operationId,state:row.state,totalBytes:null,sha256:null,offset,bytes:new Uint8Array(),eof:false,failure:row.failure} satisfies DatasetNameProviderRead
      if(!row.raw||offset>row.raw.byteLength)throw new DatasetNameProviderBridgeError('INVALID_INPUT')
      const bytes=Uint8Array.from(row.raw.subarray(offset,offset+60*1024))
      return{operationId:row.start.operationId,state:'complete',totalBytes:row.raw.byteLength,sha256:datasetWorkbenchSha(row.raw),offset,bytes,eof:offset+bytes.byteLength===row.raw.byteLength,failure:null} satisfies DatasetNameProviderRead
    },
    /** warm只封新任务并等待原operation的实际HTTP；保留原记录供Owner read/cancel/join。 */
    async sealOwner(binding:Readonly<LocalWorkbenchRootAuthorBinding>):Promise<void>{
      if(!mainAuthorBinding(binding))throw new DatasetNameProviderBridgeError('INVALID_INPUT')
      const author=options.currentAuthor()
      if(closed||revoked.has(binding.authorityRef)||!author||!mainBindingEqual(author.binding,binding))throw new DatasetNameProviderBridgeError('NOT_READY')
      sealed.add(binding.authorityRef)
      const pending=[...starting.values()].filter(row=>mainBindingEqual(row.binding,binding))
      for(const row of operations.values())if(mainBindingEqual(row.binding,binding))row.controller.abort('provider-cancelled')
      for(const job of jobs.values())if(mainBindingEqual(job.binding,binding)&&!job.settled){job.settled=true;job.reject(new DatasetNameProviderBridgeError('NOT_READY'))}
      await Promise.allSettled(pending.map(row=>row.task))
      const own=[...operations.values()].filter(row=>mainBindingEqual(row.binding,binding))
      for(const row of own)row.controller.abort('provider-cancelled')
      // transport也供原代Legacy使用；此阶段只中止并join本binding的原operation。
      const physical=await Promise.allSettled(own.map(row=>row.physical))
      if(physical.some(result=>result.status==='rejected'))throw new DatasetNameProviderBridgeError('NOT_READY')
      // 不删jobs/operations；原Owner Join实际消费后，最终revoke/close才销毁。
    },
    async revokeOwner(binding:Readonly<LocalWorkbenchRootAuthorBinding>):Promise<void>{
      revoked.add(binding.authorityRef)
      const pending=[...starting.values()].filter(row=>mainBindingEqual(row.binding,binding))
      for(const row of operations.values())if(mainBindingEqual(row.binding,binding))row.controller.abort('provider-cancelled')
      for(const[jobId,job]of jobs)if(mainBindingEqual(job.binding,binding)){if(!job.settled){job.settled=true;job.reject(new DatasetNameProviderBridgeError('NOT_READY'))}jobs.delete(jobId)}
      await Promise.allSettled(pending.map(row=>row.task))
      const own=[...operations.values()].filter(row=>mainBindingEqual(row.binding,binding));for(const row of own)row.controller.abort('provider-cancelled')
      const results=await Promise.allSettled(own.map(row=>row.physical));if(results.some(result=>result.status==='rejected'))throw new DatasetNameProviderBridgeError('NOT_READY')
      for(const row of own)operations.delete(row.start.operationId)
    },
    pending(){return operations.size+starting.size},
    async close():Promise<void>{closed=true;for(const job of jobs.values())if(!job.settled){job.settled=true;job.reject(new DatasetNameProviderBridgeError('NOT_READY'))}
      for(const row of operations.values())row.controller.abort('provider-cancelled')
      await Promise.allSettled([...starting.values()].map(row=>row.task));for(const row of operations.values())row.controller.abort('provider-cancelled')
      const physical=await Promise.allSettled([...operations.values()].map(row=>row.physical));if(physical.some(result=>result.status==='rejected'))throw new DatasetNameProviderBridgeError('NOT_READY')
      jobs.clear();operations.clear()
    },
  }
}
