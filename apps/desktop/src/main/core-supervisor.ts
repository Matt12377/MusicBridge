import { mobileRangeWindowRpc } from '../../../../packages/bridge-core/src/mobile/range-window-observer.js'
import { createDesktopArtworkReader, collectDesktopArtwork } from '../../../../packages/bridge-core/src/shared/desktop-artwork-trace-node.js'
import { captureLocalAlbumContext, withLocalAlbumContext, localAlbumPhase, localAlbumMatch, localAlbumReject, localAlbumLink, emitLocalAlbumNodeTrace, collectLocalAlbumSafeTrace, snapshotLocalAlbumReadTrace, type LocalAlbumNodeContext } from '../../../../packages/bridge-core/src/shared/local-album-read-trace-node.js'
import { createLocalAlbumSafeTraceReader, type LocalAlbumTraceStage } from '../shared/library-read-trace.js'
import { createLocalPlaybackEvidenceCollector, writeLocalPlaybackGuardSync, type LocalPlaybackEvidenceRecord, type LocalPlaybackGuardSink } from './local-playback-evidence.js'
import { collectMobileCapabilityTrace, createMobileCapabilityTraceReader, snapshotMobileCapabilityTrace } from '../../../../packages/bridge-core/src/mobile/capability-trace.js'
import { responseFailure } from '../../../../packages/bridge-core/src/shared/ipc-failure.js'
import { captureDatasetNameProviderRequest, captureDatasetNameProviderReply, assertDatasetNameProviderReplyForRequest, DATASET_NAME_PROVIDER_FAILURES, type DatasetNameProviderFailure, type DatasetNameProviderRequest, type DatasetNameProviderCommand } from '../../../../packages/bridge-core/src/collection/dataset-owner-protocol.js'
import { isSourceWorkbenchDirectoryWire, captureSourceWorkbenchDirectoryRequest, captureSourceWorkbenchDirectoryReply, assertSourceWorkbenchDirectoryReplyForRequest, captureSourceWorkbenchDirectoryRegistrationRequest, captureSourceWorkbenchDirectoryRegistrationReply, assertSourceWorkbenchDirectoryRegistrationReplyForRequest, type SourceWorkbenchDirectoryRequest, type SourceWorkbenchDirectoryReply, type SourceWorkbenchDirectoryBinding, type SourceWorkbenchDirectoryRegistrationRequest, type SourceWorkbenchDirectoryRegistrationReply } from '../../../../packages/bridge-core/src/collection/source-writes-authority.js'
import { isSourceWritesLyricsGrantWire, isSourceWritesLyricsVerifyWire, captureSourceWritesLyricsGrantRequest, captureSourceWritesLyricsGrantReply, captureSourceWritesLyricsVerifyRequest, captureSourceWritesLyricsVerifyReply, assertSourceWritesLyricsGrantReplyForRequest, assertSourceWritesLyricsVerifyReplyForRequest, type SourceWritesLyricsGrantRequest, type SourceWritesLyricsGrantReply, type SourceWritesLyricsVerifyRequest, type SourceWritesLyricsVerifyReply } from '../../../../packages/bridge-core/src/collection/source-writes-authority.js'
import { lyricsPhysicalDigest } from '../../../../packages/bridge-core/src/library/lyrics-source-format.js'
import { isSourceWorkbenchReadersWire, captureSourceWorkbenchReadersRequest, captureSourceWorkbenchReadersReply, type SourceWorkbenchReadersRequest, type SourceWorkbenchReadersReply } from '../../../../packages/bridge-core/src/collection/source-writes-authority.js'
import { captureDatasetLyricsProviderRequest, captureDatasetLyricsProviderReply, assertDatasetLyricsProviderReplyForRequest, DATASET_LYRICS_PROVIDER_FAILURES, type DatasetLyricsProviderRequest, type DatasetLyricsProviderReply, type DatasetLyricsProviderFailure, type DatasetProjectionCommandResults, type DatasetLyricsProviderCommand, captureDatasetWorkbenchNativeConfiguration, type DatasetWorkbenchNativeConfiguration, isDatasetWorkbenchOwnerRequest, isDatasetWorkbenchOwnerResult, isDatasetWorkbenchOwnerScope, type DatasetWorkbenchOwnerRequest, type DatasetWorkbenchOwnerResult, type DatasetWorkbenchOwnerCommand, type DatasetWorkbenchOwnerPayloads, type DatasetWorkbenchOwnerResults, DATASET_WORKBENCH_BOUNDS, isDatasetWorkbenchContext, isDatasetWorkbenchRequest, isDatasetWorkbenchResult, isDatasetWorkbenchFrame, datasetWorkbenchMeta, sameDatasetWorkbenchMeta, datasetWorkbenchJson, datasetWorkbenchSha, datasetWorkbenchFrames, datasetWorkbenchControl, createDatasetWorkbenchAssembler, DatasetWorkbenchWireError, type DatasetWorkbenchMeta, type DatasetWorkbenchRequest, type DatasetWorkbenchResult, type DatasetWorkbenchContext } from '../../../../packages/bridge-core/src/collection/dataset-owner-protocol.js'
import { isLocalAlbumArtworkMainRequest, isLocalAlbumArtworkMainCancel, isLocalAlbumArtworkMainReply, type LocalAlbumArtworkMainRequest, type LocalAlbumArtworkMainReply, isLocalAlbumMainRequest, isLocalAlbumMainResponse, type LocalAlbumMainRequest, type LocalAlbumMainResponse } from '../../../../packages/bridge-core/src/collection/local-album-browser/main-protocol.js'
import { isLibraryReadCommand } from '@music-bridge/contracts'
import { localSourceWritesMainRequestSnapshot, localSourceWritesMainResponseSnapshot, localSourceWritesDataSnapshot, localSourceWritesRecord, type LocalSourceWritesPrivateCommand, type LocalSourceWritesPrivateCommandPayloads, type LocalSourceWritesPrivateCommandResults } from '@music-bridge/contracts'
import { localRelocationMainRequestSnapshot, localRelocationMainResponseSnapshot, localRelocationDataSnapshot, localRelocationRecord, type LocalRelocationMainCommand, type LocalRelocationMainCommandPayloads, type LocalRelocationMainCommandResults } from '@music-bridge/contracts'
import { randomUUID } from 'node:crypto'
import { isMobileOwnerPrivateRequest, type MobileCorePrivateCall } from '../../../../packages/bridge-core/src/mobile/owner-protocol.js'
import { captureMobileCorePrivateReply } from '../../../../packages/bridge-core/src/mobile/owner-boundary-capture.js'
import { MobileAuthPersistenceError, type MobileOwnerPrivateRequest, type MobileOwnerPrivateResult } from '../../../../packages/bridge-core/src/mobile/types.js'
import { captureMobileContentCoreRequest, captureMobileContentCoreResponse, MOBILE_CONTENT_RPC_BOUNDS,
  type MobileContentCoreRequest, type MobileContentCoreResponse } from '../../../../packages/bridge-core/src/mobile/content-rpc.js'
import { createLibraryReadTraceStreamReader, emitLibraryReadTrace, libraryReadTraceFailure, type LibraryReadTraceSink } from '../shared/library-read-trace.js'
import { createPlaybackFailureTraceStreamReader } from '../shared/playback-failure-trace.js'

import {
  IPC_VERSION,
  isActivateRestoredDataset,
  parseIpcRuntimeMessage,
  validateIpcInternalResponseForCommand,
  validateIpcResponseForCommand,
  validateIpcRequest,
  validateIpcInternalRequest,
  type IpcCommand,
  type IpcCommandPayloads,
  type IpcCommandResults,
  type IpcInternalCommand,
  type IpcInternalCommandResults,
  type PublicErrorCode,
  type TypedIpcEvent,
  type ActivateRestoredDataset,
  type RestoreActivationView,
  type PerformanceTraceRecorder,
  type PerformanceTraceContext,
  type PerformanceSpan,
  type PlaybackEventProtocol,
  type PlaybackEventProtocolAck,
  type PlaybackStreamSnapshot,
} from '@music-bridge/contracts'

export interface CoreMessagePort {
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown
  start(): void
  close(): void
  postMessage(message: unknown): void
}
export interface CoreRelocationMessagePort extends CoreMessagePort {
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown
  on(event: 'close' | 'messageerror', listener: () => void): unknown
}

export interface CoreChildProcess {
  postMessage(message: unknown, transfer?: CoreMessagePort[]): void
  once(event: 'exit', listener: (code: number) => void): unknown
  kill(): boolean
  stdout?: { on(event: 'data', listener: (chunk: { toString(): string }) => void): unknown } | null
  stderr?: { on(event: 'data', listener: (chunk: unknown) => void): unknown } | null
}

export interface CoreSupervisorDependencies {
  createChannel(): { port1: CoreMessagePort; port2: CoreMessagePort }
  /** 仅Main私有诊断输出注入；不扩公开IPC或来源权限，结果不决定owned准入。 */
  writeLocalPlaybackGuard?(row: LocalPlaybackEvidenceRecord): void
  /** 单独的可信 Main 能力端口，不装通用 Core 观察器。 */
  createSourceWritesChannel?(): { port1: CoreMessagePort; port2: CoreMessagePort }
  createRelocationChannel?(): { port1: CoreRelocationMessagePort; port2: CoreRelocationMessagePort }
  fork(
    entryPath: string,
    args: string[],
    options: {
      cwd: string
      env: NodeJS.ProcessEnv
      stdio: 'ignore' | 'pipe'
      serviceName: string
    },
  ): CoreChildProcess
}

export type CoreSupervisorStatus = 'stopped' | 'starting' | 'ready' | 'failed'

export type CoreSupervisorLifecycle =
  | { event: 'spawn' | 'ready' | 'restart' | 'failed' | 'stopped' }
  | { event: 'exit'; code: number }

export class CoreIpcError extends Error {
  constructor(
    readonly code: PublicErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'CoreIpcError'
  }
}

export interface CoreStartupClient {
  request: CoreSupervisor['request']
  requestInternal: CoreSupervisor['requestInternal']
  readonly playbackEvents: PlaybackEventProtocolAck | null
}
interface StartupAttempt {
  generation: number
  child: CoreChildProcess
  port: CoreMessagePort
  valid: boolean
  readyReceived: boolean
  playbackEvents: PlaybackEventProtocolAck | null
  /** 原 prepare/commit 已确认的私有作者对象；只供关闭期拒绝核身份，不授新能力。 */
  workbenchBinding?: Readonly<WorkbenchMainBinding>
  cancelStart(error: CoreIpcError): void
}

interface WorkbenchMainBinding {datasetId:string;ownerEpoch:string;childGeneration:number;authorityRef:object}
interface WorkbenchMainAuthor {
  readonly binding:Readonly<WorkbenchMainBinding>
  assertCurrent(binding:Readonly<WorkbenchMainBinding>):Promise<void>
  request(request:DatasetWorkbenchRequest,context:{binding:Readonly<WorkbenchMainBinding>;signal:AbortSignal;deadlineAtMs:number}):Promise<DatasetWorkbenchResult>
  requestOwner<C extends DatasetWorkbenchOwnerCommand>(command:C,payload:DatasetWorkbenchOwnerPayloads[C],context:{binding:Readonly<WorkbenchMainBinding>;signal:AbortSignal;deadlineAtMs:number}):Promise<DatasetWorkbenchOwnerResults[C]>
}

interface PendingRequest {
  rendererReadId?: string
  performanceSpan?: PerformanceSpan
  detachReadAbort?: () => void
  readDeadlineAtMs?: number
  cancelCoreRead?: () => void
  command: IpcCommand
  internal: boolean
  timer: NodeJS.Timeout
  reject(error: CoreIpcError): void
  resolve(value: unknown): void
  accept?: (value: unknown) => void
}

/** 位置tick不能触发托盘的全队列读取。 */
export function shouldRefreshTrayForCoreEvent(event: TypedIpcEvent): boolean {
  return event.event !== 'playback.progress'
}

const DEFAULT_REQUEST_TIMEOUT_MS = 2_000
const DEFAULT_STARTUP_TIMEOUT_MS = 60_000
// 两份 WAV 的完整 Hash 读取各自最多 15 分钟；撤销仍走短控制请求。
const PREPARED_FILE_REQUEST_TIMEOUT_MS = 35 * 60_000
const LIBRARY_REQUEST_TIMEOUT_MS = 10_000
const PLAYBACK_REQUEST_TIMEOUT_MS = 60_000
const RESTORE_ACTIVATION_TIMEOUT_MS = 30 * 60_000

export class CoreSupervisor {
  private startupGeneration = 0
  private startupAttempt: StartupAttempt | undefined
  private child: CoreChildProcess | undefined
  private childExit: { child: CoreChildProcess; promise: Promise<void> } | undefined
  private port: CoreMessagePort | undefined
  private sourceWritesPort: CoreMessagePort | undefined
  private sourceWritesSequence = 0
  private lyricsVerifySequence = 0
  private lyricsGrantSequence = 0
  private lyricsGrantAuthorityId: string | undefined
  private lyricsGrantProducer: ((request: SourceWritesLyricsGrantRequest, context: { signal: AbortSignal; deadlineAtMs: number }) => Promise<SourceWritesLyricsGrantReply>) | undefined
  private readonly lyricsVerifyPending = new Map<string, { route: StartupAttempt; port: CoreMessagePort; request: SourceWritesLyricsVerifyRequest; timer: ReturnType<typeof setTimeout>; deadlineAtMs: number; expired: boolean; signal: AbortSignal; abort(): void; resolve(value: SourceWritesLyricsVerifyReply): void; reject(error: CoreIpcError): void }>()
  private readonly lyricsGrantTasks = new Set<{ port: CoreMessagePort; controller: AbortController; task: Promise<void> }>()
  private lyricsProviderBridge: { execute(request: DatasetLyricsProviderRequest, context: { binding: Readonly<WorkbenchMainBinding>; signal: AbortSignal; deadlineAtMs: number }): Promise<DatasetProjectionCommandResults[DatasetLyricsProviderCommand]>; revokeOwner(binding: Readonly<WorkbenchMainBinding>): Promise<void> } | undefined
  private lyricsProviderSequence = 0
  private readonly lyricsProviderFlights = new Set<{ route: StartupAttempt; cleanup: boolean; controller: AbortController; task: Promise<void> }>()
  private readonly lyricsProviderBindings = new Map<StartupAttempt, Readonly<WorkbenchMainBinding>>()
  private readonly lyricsProviderRevoked = new Set<StartupAttempt>()
  private readonly lyricsProviderCleanups = new Set<Promise<void>>()
  private lyricsProviderCleanupFailed = false
  private nameProviderBridge: { execute(request: DatasetNameProviderRequest, context: { binding: Readonly<WorkbenchMainBinding>; signal: AbortSignal; deadlineAtMs: number }): Promise<DatasetProjectionCommandResults[DatasetNameProviderCommand]>; revokeOwner(binding: Readonly<WorkbenchMainBinding>): Promise<void> } | undefined
  private nameProviderSequence = 0
  private readonly nameProviderFlights = new Set<{ route: StartupAttempt; cleanup: boolean; controller: AbortController; task: Promise<void> }>()
  private readonly nameProviderBindings = new Map<StartupAttempt, { binding: Readonly<WorkbenchMainBinding>; authorityId: string }>()
  private readonly nameProviderRevoked = new Set<StartupAttempt>()
  private readonly nameProviderCleanups = new Set<Promise<void>>()
  private nameProviderCleanupFailed = false
  private readonly directoryAuthorRoutes=new WeakMap<object,StartupAttempt>()
  private directorySequence=0
  private directoryAuthorityId:string|undefined
  private directoryRegistrationSequence=0
  private directoryProducer:((request:SourceWorkbenchDirectoryRequest,context:{signal:AbortSignal;deadlineAtMs:number})=>Promise<SourceWorkbenchDirectoryReply>)|undefined
  private readonly directoryTasks=new Set<{port:CoreMessagePort;controller:AbortController;task:Promise<void>}>()
  private readonly directoryPending=new Map<string,{port:CoreMessagePort;route:StartupAttempt;request:SourceWorkbenchDirectoryRegistrationRequest;timer:ReturnType<typeof setTimeout>;detach():void;resolve(v:SourceWorkbenchDirectoryRegistrationReply):void;reject(e:unknown):void}>()
  private readersSequence=0
  private readersAuthorityId:string|undefined
  private readersProducer:((request:SourceWorkbenchReadersRequest,context:{binding:Readonly<WorkbenchMainBinding>;signal:AbortSignal;deadlineAtMs:number})=>Promise<void>)|undefined
  private readersCleanupUnknown=false
  private readonly readersTasks=new Set<{port:CoreMessagePort;controller:AbortController;task:Promise<void>}>()
  private relocationMainPort: CoreRelocationMessagePort | undefined
  private relocationSequence = 0
  private readonly relocationPending = new Map<string, { sequence: number; command: LocalRelocationMainCommand; timer: NodeJS.Timeout; resolve(value: unknown): void; reject(error: CoreIpcError): void }>()
  private readonly sourceWritesPending = new Map<string, { sequence: number; command: LocalSourceWritesPrivateCommand; timer: NodeJS.Timeout; resolve(value: unknown): void; reject(error: CoreIpcError): void }>()
  private startPromise: Promise<void> | undefined
  private restartPromise: Promise<void> | undefined
  private manualRestartPromise: Promise<void> | undefined
  private shutdownPromise: Promise<void> | undefined
  private readyTimeoutOverride: number | undefined
  private activationFlight: { request: ActivateRestoredDataset; expectedDatasetId: string | undefined; promise: Promise<RestoreActivationView> } | undefined
  private shuttingDown = false
  /** 公开停止/重启请求单调推进；复用原close也不能丢掉后来的停止意图。 */
  private lifecycleRequestGeneration = 0
  private restartCount = 0
  private readonly pending = new Map<string, PendingRequest>()
  private workbenchNativeConfiguration: Readonly<DatasetWorkbenchNativeConfiguration> | undefined
  private workbenchSequence=0
  private workbenchAuthorFlight:{route:StartupAttempt;promise:Promise<WorkbenchMainAuthor>}|undefined
  private readonly workbenchPending=new Map<string,{route:StartupAttempt;meta:DatasetWorkbenchMeta;trace?:LocalAlbumNodeContext;request:DatasetWorkbenchRequest|DatasetWorkbenchOwnerRequest|null;assembly:ReturnType<typeof createDatasetWorkbenchAssembler>;timer:NodeJS.Timeout;expired:boolean;detach():void;resolve(value:unknown):void;reject(error:unknown):void}>()
  private readonly workbenchRetired=new Set<string>()
  private albumArtworkNormalizer:((copies:unknown,context:{signal:AbortSignal;deadlineAtMs:number})=>Promise<DatasetProjectionCommandResults['normalizeLocalAlbumArtwork']>)|undefined
  private albumArtworkSequence=0
  private readonly albumArtworkFlights=new Set<{route:StartupAttempt;request:LocalAlbumArtworkMainRequest;controller:AbortController;task:Promise<void>}>()
  private readonly localPlaybackEvidence = createLocalPlaybackEvidenceCollector()
  getLocalAlbumReadTraceSnapshot() { return snapshotLocalAlbumReadTrace() }
  getLocalPlaybackEvidenceSnapshot() { return this.localPlaybackEvidence.snapshot() }
  getMobileCapabilityTraceSnapshot() { return snapshotMobileCapabilityTrace() }
  private readonly localAlbumPending = new Map<string, { trace?: LocalAlbumNodeContext; call: LocalAlbumMainRequest; generation: number; port: CoreMessagePort; timer: NodeJS.Timeout; resolve(value: LocalAlbumMainResponse): void; reject(error: CoreIpcError): void }>()
  private readonly mobilePending = new Map<string, { call: MobileCorePrivateCall; timer: NodeJS.Timeout; reject(error: MobileAuthPersistenceError): void; resolve(result: MobileOwnerPrivateResult): void }>()
  private readonly mobileContentPending = new Map<string, { call: MobileContentCoreRequest; generation: number;
    timer: NodeJS.Timeout; rangeTransport?: ReturnType<typeof mobileRangeWindowRpc>; detachAbort(): void; reject(error: MobileAuthPersistenceError): void; resolve(result: MobileContentCoreResponse): void }>()
  private _status: CoreSupervisorStatus = 'stopped'

  constructor(
    private readonly options: {
      entryPath: string
      cwd: string
      env?: NodeJS.ProcessEnv
      playbackEventProtocol?: PlaybackEventProtocol | null
      sourceWritesPort?: true
      relocationMainPort?: true
      dependencies: CoreSupervisorDependencies
      requestTimeoutMs?: number
      startupTimeoutMs?: number
      onEvent?: (event: TypedIpcEvent) => void
      onReady?: (client: CoreStartupClient) => Promise<void> | void
      onLifecycle?: (event: CoreSupervisorLifecycle) => void
      performance?: PerformanceTraceRecorder
      performanceContext?: () => PerformanceTraceContext | undefined
      libraryReadTrace?: LibraryReadTraceSink
    },
  ) {
    const timeout = options.startupTimeoutMs
    if (timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > DEFAULT_STARTUP_TIMEOUT_MS)) {
      throw new CoreIpcError('INVALID_IPC_REQUEST', 'Core 启动等待期限无效')
    }
  }

  /** 仅Main已编译metadata在首次start前配置；不扩大原构造器或公开IPC。 */
  configurePrivateWorkbenchNative(configuration: DatasetWorkbenchNativeConfiguration): void {
    if(this._status!=='stopped'||this.startupGeneration!==0||this.child!==undefined||this.workbenchNativeConfiguration!==undefined)throw new CoreIpcError('NOT_READY','原生资源配置只能在首次启动前固定')
    this.workbenchNativeConfiguration=captureDatasetWorkbenchNativeConfiguration(configuration)
  }

  configurePrivateWorkbenchReadersProducer(producer:NonNullable<CoreSupervisor['readersProducer']>):void {
    if(this._status!=='stopped'||this.startupGeneration!==0||this.child!==undefined||this.readersProducer||typeof producer!=='function')throw new CoreIpcError('NOT_READY','按库读取join作者只能在首次启动前固定')
    this.readersProducer=producer
  }
  private receiveWorkbenchReaders(raw:unknown,port:CoreMessagePort,route:StartupAttempt):void {
    const q=captureSourceWorkbenchReadersRequest(raw),binding=route.workbenchBinding
    const sameRoute=()=>route===this.startupAttempt&&route.generation===this.startupGeneration&&route.child===this.child&&route.port===this.port&&this.sourceWritesPort===port
    const originalBinding=()=>binding!==undefined&&binding.authorityRef===route&&binding.childGeneration===route.generation&&binding.datasetId===q.binding.datasetId&&binding.ownerEpoch===q.binding.ownerEpoch
    if(!sameRoute()||!originalBinding()||(!this.shuttingDown&&(!this.isCurrentRoute(route)||this._status!=='ready'))
      ||q.sequence!==this.readersSequence+1||q.expiresAtMs<=Date.now()||q.expiresAtMs>Date.now()+2000||this.readersTasks.size>=4
      ||this.readersAuthorityId!==undefined&&this.readersAuthorityId!==q.authorityId||this.lyricsGrantAuthorityId!==undefined&&this.lyricsGrantAuthorityId!==q.authorityId
      ||this.directoryAuthorityId!==undefined&&this.directoryAuthorityId!==q.authorityId)throw new CoreIpcError('INVALID_IPC_RESPONSE','按库读取fence不是同原物理actor与实际作者')
    this.readersSequence=q.sequence;this.readersAuthorityId??=q.authorityId
    const controller=new AbortController(),deadlineAtMs=performance.now()+Math.min(2000,q.expiresAtMs-Date.now());let closed=false,expired=false
    const task=Promise.resolve().then(async()=>{
      if(!this.readersProducer)throw new CoreIpcError('NOT_READY','按库读取join作者未装配')
      await this.readersProducer(q,{binding:binding!,signal:controller.signal,deadlineAtMs});closed=true
    }).catch(()=>{this.readersCleanupUnknown=true}).then(()=>{
      if(!sameRoute()||!originalBinding())return
      const timely=!expired&&!controller.signal.aborted&&Date.now()<q.expiresAtMs&&performance.now()<deadlineAtMs
      const reply:SourceWorkbenchReadersReply=captureSourceWorkbenchReadersReply({version:1,type:'workbench-readers-stop-reply',purpose:'WORKBENCH_READERS',requestId:q.requestId,
        sequence:q.sequence,authorityId:q.authorityId,binding:q.binding,requestSha256:lyricsPhysicalDigest(q),ok:closed&&timely,physicalClosed:closed,failure:closed&&timely?null:timely?'UNKNOWN':'TIMEOUT'})
      try{port.postMessage(reply)}catch{this.closeSourceWrites(port)}
    }).finally(()=>{clearTimeout(timer);this.readersTasks.delete(flight)})
    // abort不是物理join；原producer真实返回前保留任务，迟到回声不能放行原撤库。
    const timer=setTimeout(()=>{expired=true;controller.abort()},Math.max(1,deadlineAtMs-performance.now())),flight={port,controller,task};this.readersTasks.add(flight)
  }
  async joinPrivateWorkbenchReadersProducer():Promise<void>{
    while(this.readersTasks.size)await Promise.allSettled([...this.readersTasks].map(value=>value.task))
    if(this.readersCleanupUnknown)throw new CoreIpcError('NOT_READY','原按库读取资源关闭未确认')
  }

  /** 只能在首次启动前安装Main真实授权producer，不扩原构造器或公开dispatch。 */
  configurePrivateLyricsGrantProducer(producer: (request: SourceWritesLyricsGrantRequest, context: { signal: AbortSignal; deadlineAtMs: number }) => Promise<SourceWritesLyricsGrantReply>): void {
    if (this._status !== 'stopped' || this.startupGeneration !== 0 || this.child !== undefined || this.lyricsGrantProducer || typeof producer !== 'function') throw new CoreIpcError('NOT_READY', '歌词原作者只能在首次启动前固定')
    this.lyricsGrantProducer = producer
  }
  /** 当前实际SourceWrites物理端口；只读原在途grant，不能通过18/39通用命令替代。 */
  async verifyLyricsGrantOriginal(grantRequest: SourceWritesLyricsGrantRequest, binding: Readonly<WorkbenchMainBinding>, signal: AbortSignal, deadlineAtMs: number): Promise<SourceWritesLyricsVerifyReply> {
    const route = this.startupAttempt, port = this.sourceWritesPort, grant = captureSourceWritesLyricsGrantRequest(grantRequest)
    const check = () => {
      if (!route || !port || !this.isCurrentRoute(route) || this.sourceWritesPort !== port || this._status !== 'ready' || signal.aborted
        || binding.authorityRef !== route || binding.childGeneration !== route.generation || binding.datasetId !== grant.binding.datasetId || binding.ownerEpoch !== grant.binding.ownerEpoch) throw new CoreIpcError('OUTBOX_SCOPE_MISMATCH', '原歌词物理作者已经撤销')
    }
    check()
    const remaining = Math.min(2000, grant.expiresAtMs - Date.now(), Math.floor(deadlineAtMs - performance.now()))
    if (remaining <= 0 || this.lyricsVerifyPending.size >= 4 || this.lyricsVerifySequence >= Number.MAX_SAFE_INTEGER) throw new CoreIpcError('TIMEOUT', '原歌词核验期限已到或达到有限预算')
    const request = captureSourceWritesLyricsVerifyRequest({ version: 1, type: 'lyrics-source-verify-request', purpose: 'LYRICS', requestId: randomUUID(), sequence: ++this.lyricsVerifySequence, epoch: binding.ownerEpoch, datasetId: binding.datasetId, grantRequest: grant })
    const result = await new Promise<SourceWritesLyricsVerifyReply>((resolve, reject) => {
      // 超时只拒绝本次只读核验；保留有限原请求，供同端口的迟到回声核身后退休。
      const abort = () => { const pending = this.lyricsVerifyPending.get(request.requestId); if (!pending) return; clearTimeout(pending.timer); signal.removeEventListener('abort', abort); pending.expired = true; reject(new CoreIpcError('TIMEOUT', '原歌词只读核验未确认，不会重发')) }
      const timer = setTimeout(abort, remaining)
      this.lyricsVerifyPending.set(request.requestId, { route: route!, port: port!, request, timer, deadlineAtMs, expired: false, signal, abort, resolve, reject })
      signal.addEventListener('abort', abort, { once: true })
      try { check(); port!.postMessage(request) } catch { abort() }
    })
    check(); assertSourceWritesLyricsVerifyReplyForRequest(result, request)
    if (Date.now() >= grant.expiresAtMs || performance.now() >= deadlineAtMs) throw new CoreIpcError('TIMEOUT', '原歌词核验回执已迟到')
    return result
  }
  async joinPrivateLyricsGrantProducer(): Promise<void> { await Promise.allSettled([...this.lyricsGrantTasks].map(item => item.task)) }
  private receiveLyricsGrant(raw: unknown, port: CoreMessagePort, route: StartupAttempt): void {
    const request = captureSourceWritesLyricsGrantRequest(raw)
    const sameRoute = () => route === this.startupAttempt && route.generation === this.startupGeneration
      && route.child === this.child && route.port === this.port && this.sourceWritesPort === port
    const originalActor = () => {
      const binding = route.workbenchBinding, authorityId = this.lyricsGrantAuthorityId ?? this.directoryAuthorityId ?? this.readersAuthorityId
      return sameRoute() && binding !== undefined
        && binding.authorityRef === route && binding.childGeneration === route.generation
        && binding.datasetId === request.binding.datasetId && binding.ownerEpoch === request.binding.ownerEpoch
        && authorityId !== undefined && authorityId === request.authorityId
        && (this.directoryAuthorityId === undefined || this.directoryAuthorityId === request.authorityId)
    }
    const originalDrain = () => this.shuttingDown && originalActor()
    if ((!this.isCurrentRoute(route) || this._status !== 'ready') && !originalDrain() || !sameRoute()
      || request.expiresAtMs <= Date.now() || request.expiresAtMs > Date.now() + 2000
      || request.sequence <= this.lyricsGrantSequence || this.lyricsGrantAuthorityId !== undefined && this.lyricsGrantAuthorityId !== request.authorityId
      || this.directoryAuthorityId !== undefined && this.directoryAuthorityId !== request.authorityId || this.readersAuthorityId !== undefined && this.readersAuthorityId !== request.authorityId || this.lyricsGrantTasks.size >= 4) throw new CoreIpcError('INVALID_IPC_RESPONSE', '歌词物理请求不是当前原作者')
    this.lyricsGrantSequence = request.sequence
    if (!this.shuttingDown) this.lyricsGrantAuthorityId ??= request.authorityId
    const controller = new AbortController(), deadlineAtMs = performance.now() + Math.min(2000, request.expiresAtMs - Date.now())
    const fallback = captureSourceWritesLyricsGrantReply({ version: 1, type: 'lyrics-source-grant-reply', purpose: 'LYRICS', requestId: request.requestId, sequence: request.sequence, revision: request.revision, authorityId: request.authorityId, requestSha256: lyricsPhysicalDigest(request), binding: request.binding, bindingSha256: request.bindingSha256, decision: 'rejected', nonce: null, validUntilMs: null })
    let replied = false
    const rejectOriginal = () => {
      if (!originalActor()) throw new CoreIpcError('OUTBOX_SCOPE_MISMATCH', '原歌词拒绝没有原作者关联')
      if (!replied) { port.postMessage(fallback); replied = true }
    }
    const task = Promise.resolve().then(async () => {
      let produced: unknown = fallback
      // 晚到原请求只回原拒绝；既有 producer 的失权不关闭共享目录清理端口。
      if (this.shuttingDown) {
        if (!originalDrain()) throw new CoreIpcError('OUTBOX_SCOPE_MISMATCH', '原歌词拒绝没有原作者关联')
      } else if (this.lyricsGrantProducer) {
        try { produced = await this.lyricsGrantProducer(request, { signal: controller.signal, deadlineAtMs }) }
        catch (error) { if (!originalActor()) throw error }
      }
      // 捕获和匹配仍在 producer 错误处理之外；坏回包不因关闭期被吞掉。
      const reply = captureSourceWritesLyricsGrantReply(produced)
      assertSourceWritesLyricsGrantReplyForRequest(reply, request)
      if (reply.decision === 'granted' && (reply.validUntilMs! <= Date.now() || reply.validUntilMs! > Date.now() + 480000)) throw new CoreIpcError('INVALID_IPC_RESPONSE', '原歌词授权期限无效')
      if (!sameRoute()) throw new CoreIpcError('OUTBOX_SCOPE_MISMATCH', '原歌词响应资格已撤销')
      if (controller.signal.aborted || Date.now() >= request.expiresAtMs || performance.now() >= deadlineAtMs || this.shuttingDown) {
        rejectOriginal()
      } else {
        if (!this.isCurrentRoute(route) || this._status !== 'ready') throw new CoreIpcError('OUTBOX_SCOPE_MISMATCH', '原歌词响应资格已撤销')
        if (!replied) { port.postMessage(reply); replied = true }
      }
    }).catch(() => { this.closeSourceWrites(port) }).finally(() => { clearTimeout(timer); this.lyricsGrantTasks.delete(flight) })
    // 拒绝回声不代表 producer 已静止；flight 留到原 producer 真正结束，最终 join 仍等待它。
    const timer = setTimeout(() => { controller.abort(); try { rejectOriginal() } catch { this.closeSourceWrites(port) } }, Math.max(1, deadlineAtMs - performance.now()))
    const flight = { port, controller, task }; this.lyricsGrantTasks.add(flight)
  }

  /** 主port上的固定四项反向Provider，不复用SourceWrites许可端口或通用dispatch。 */
  configurePrivateLyricsProviderBridge(bridge: NonNullable<CoreSupervisor['lyricsProviderBridge']>): void {
    if (this._status !== 'stopped' || this.startupGeneration !== 0 || this.child !== undefined || this.lyricsProviderBridge || typeof bridge?.execute !== 'function' || typeof bridge?.revokeOwner !== 'function') throw new CoreIpcError('NOT_READY', '歌词来源桥只能在首次启动前固定')
    this.lyricsProviderBridge = bridge
  }
  private lyricsProviderRouteCurrent(route: StartupAttempt, cleanup: boolean): boolean {
    return route === this.startupAttempt && route.generation === this.startupGeneration && route.child === this.child && route.port === this.port
      && (cleanup && this.shuttingDown || this.isCurrentRoute(route) && this._status === 'ready')
  }
  private revokeLyricsProviderTasks(physicalExit = false): void {
    for (const flight of this.lyricsProviderFlights) if (physicalExit || !flight.cleanup) flight.controller.abort()
    for (const [route, binding] of this.lyricsProviderBindings) {
      if (!this.lyricsProviderRevoked.has(route)) {
        this.lyricsProviderRevoked.add(route)
        const work = Promise.resolve().then(() => this.lyricsProviderBridge?.revokeOwner(binding)).then(() => undefined, () => { this.lyricsProviderCleanupFailed = true })
        this.lyricsProviderCleanups.add(work)
        void work.finally(() => this.lyricsProviderCleanups.delete(work))
      }
      if (physicalExit) { this.lyricsProviderBindings.delete(route); this.lyricsProviderRevoked.delete(route) }
    }
  }
  async joinPrivateLyricsProviderBridge(): Promise<void> {
    while (this.lyricsProviderFlights.size || this.lyricsProviderCleanups.size) await Promise.allSettled([...this.lyricsProviderFlights].map(f => f.task).concat([...this.lyricsProviderCleanups]))
    if (this.lyricsProviderCleanupFailed) throw new CoreIpcError('NOT_READY', '原歌词来源资源未确认关闭')
  }
  private receiveLyricsProvider(raw: unknown, route: StartupAttempt): void {
    const request = captureDatasetLyricsProviderRequest(raw), cleanup = request.command === 'lyricsProviderCancel' || request.command === 'lyricsProviderJoin'
    if (!this.lyricsProviderRouteCurrent(route, cleanup) || request.sequence <= this.lyricsProviderSequence || request.expiresAtMs <= Date.now() || request.expiresAtMs > Date.now() + DATASET_WORKBENCH_BOUNDS.requestMs || this.lyricsProviderFlights.size + this.nameProviderFlights.size >= DATASET_WORKBENCH_BOUNDS.pending) throw new CoreIpcError('INVALID_IPC_RESPONSE', '歌词来源请求不是当前实际Owner')
    this.lyricsProviderSequence = request.sequence
    const controller = new AbortController(), deadlineAtMs = performance.now() + Math.min(DATASET_WORKBENCH_BOUNDS.requestMs, request.expiresAtMs - Date.now())
    const echo = { version: 1 as const, type: 'musicbridge.lyrics.provider-reply' as const, requestId: request.requestId, sequence: request.sequence, epoch: request.epoch, datasetId: request.datasetId, command: request.command, requestSha256: datasetWorkbenchSha(datasetWorkbenchJson(request)) }
    const task = Promise.resolve().then(async () => {
      if (!this.lyricsProviderBridge) return captureDatasetLyricsProviderReply({ ...echo, ok: false, failure: 'NOT_READY' })
      const known = this.lyricsProviderBindings.get(route)
      const author = cleanup && known ? undefined : await this.createWorkbenchRootMainAuthor()
      const binding = known ?? author?.binding
      if (!binding || !this.lyricsProviderRouteCurrent(route, cleanup) || binding.authorityRef !== route || binding.childGeneration !== route.generation || binding.ownerEpoch !== request.epoch || binding.datasetId !== request.datasetId) throw new CoreIpcError('OUTBOX_SCOPE_MISMATCH', '歌词来源原Owner身份已改变')
      if (!cleanup && this.lyricsProviderRevoked.has(route)) throw new CoreIpcError('NOT_READY', '原歌词来源已撤销')
      this.lyricsProviderBindings.set(route, binding)
      const result = await this.lyricsProviderBridge.execute(request, { binding, signal: controller.signal, deadlineAtMs })
      return captureDatasetLyricsProviderReply({ ...echo, ok: true, result })
    }).catch(error => {
      const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined
      const failure: DatasetLyricsProviderFailure = (DATASET_LYRICS_PROVIDER_FAILURES as readonly unknown[]).includes(code) ? code as DatasetLyricsProviderFailure : error instanceof CoreIpcError ? error.code === 'TIMEOUT' ? 'TIMEOUT' : 'NOT_READY' : 'INVALID_RESPONSE'
      return captureDatasetLyricsProviderReply({ ...echo, ok: false, failure })
    }).then(reply => {
      assertDatasetLyricsProviderReplyForRequest(reply, request)
      if (controller.signal.aborted || !this.lyricsProviderRouteCurrent(route, cleanup) || Date.now() >= request.expiresAtMs || performance.now() >= deadlineAtMs) return
      route.port.postMessage(reply)
    }).catch(() => { this.failLyricsProviderRoute(route) }).finally(() => { clearTimeout(timer); this.lyricsProviderFlights.delete(flight) })
    const timer = setTimeout(() => controller.abort(), Math.max(1, deadlineAtMs - performance.now()))
    const flight = { route, cleanup, controller, task }; this.lyricsProviderFlights.add(flight)
  }
  private failLyricsProviderRoute(route: StartupAttempt): void {
    if (route !== this.startupAttempt || route.child !== this.child || route.port !== this.port) return
    const error = new CoreIpcError('INVALID_IPC_RESPONSE', '歌词来源私有消息未通过闭集核验')
    route.cancelStart(error); this.rejectPending(error)
    try { route.child.kill() } catch { /* 原route已撤销；物理退出仍由shutdown核验。 */ }
  }

  configurePrivateNameProviderBridge(bridge: NonNullable<CoreSupervisor['nameProviderBridge']>): void {
    if (this._status !== 'stopped' || this.startupGeneration !== 0 || this.child !== undefined || this.nameProviderBridge || typeof bridge?.execute !== 'function' || typeof bridge?.revokeOwner !== 'function') throw new CoreIpcError('NOT_READY', '名称来源桥只能在首次启动前固定')
    this.nameProviderBridge = bridge
  }
  private nameProviderRouteCurrent(route: StartupAttempt, cleanup: boolean): boolean {
    return route === this.startupAttempt && route.generation === this.startupGeneration && route.child === this.child && route.port === this.port
      && (cleanup && this.shuttingDown || this.isCurrentRoute(route) && this._status === 'ready')
  }
  private revokeNameProviderTasks(physicalExit = false): void {
    for (const flight of this.nameProviderFlights) if (physicalExit || !flight.cleanup) flight.controller.abort()
    for (const [route, binding] of this.nameProviderBindings) {
      if (!this.nameProviderRevoked.has(route)) {
        this.nameProviderRevoked.add(route)
        const work = Promise.resolve().then(() => this.nameProviderBridge?.revokeOwner(binding.binding)).then(() => undefined, () => { this.nameProviderCleanupFailed = true })
        this.nameProviderCleanups.add(work)
        void work.finally(() => this.nameProviderCleanups.delete(work))
      }
      if (physicalExit) { this.nameProviderBindings.delete(route); this.nameProviderRevoked.delete(route) }
    }
  }
  async joinPrivateNameProviderBridge(): Promise<void> {
    while (this.nameProviderFlights.size || this.nameProviderCleanups.size) await Promise.allSettled([...this.nameProviderFlights].map(f => f.task).concat([...this.nameProviderCleanups]))
    if (this.nameProviderCleanupFailed) throw new CoreIpcError('NOT_READY', '原名称来源资源未确认关闭')
  }
  private receiveNameProvider(raw: unknown, route: StartupAttempt): void {
    const request = captureDatasetNameProviderRequest(raw), original = this.nameProviderBindings.get(route)
    const originalDrain = this.shuttingDown && original !== undefined
      && original.binding.authorityRef === route && original.binding.childGeneration === route.generation
      && original.binding.ownerEpoch === request.epoch && original.binding.datasetId === request.datasetId
      && (request.authorityId === original.authorityId && request.childGeneration === route.generation
        || request.command === 'nameProviderStart' && request.authorityId === null && request.childGeneration === null)
    const cleanup = request.command === 'nameProviderCancel' || request.command === 'nameProviderJoin'
      || request.command === 'nameProviderRead' && originalDrain
    // 首次Start可能尚无NAME关联；仅用原已prepare/commit作者pin核身份回拒绝。
    const originalBinding = route.workbenchBinding
    const initialDrain = this.shuttingDown && original === undefined && request.authorityId === null && request.childGeneration === null
      && originalBinding !== undefined && originalBinding.authorityRef === route && originalBinding.childGeneration === route.generation
      && originalBinding.ownerEpoch === request.epoch && originalBinding.datasetId === request.datasetId
    const refuseStart = request.command === 'nameProviderStart' && (originalDrain || initialDrain)
    if (!this.nameProviderRouteCurrent(route, cleanup || refuseStart) || request.sequence <= this.nameProviderSequence || request.expiresAtMs <= Date.now() || request.expiresAtMs > Date.now() + DATASET_WORKBENCH_BOUNDS.requestMs || this.nameProviderFlights.size + this.lyricsProviderFlights.size >= DATASET_WORKBENCH_BOUNDS.pending) throw new CoreIpcError('INVALID_IPC_RESPONSE', '名称来源请求不是当前实际Owner')
    this.nameProviderSequence = request.sequence
    const controller = new AbortController(), deadlineAtMs = performance.now() + Math.min(DATASET_WORKBENCH_BOUNDS.requestMs, request.expiresAtMs - Date.now())
    const echo = { version: 1 as const, type: 'musicbridge.name.provider-reply' as const, authorityId: request.authorityId, childGeneration: request.childGeneration, requestId: request.requestId, sequence: request.sequence, epoch: request.epoch, datasetId: request.datasetId, command: request.command, requestSha256: datasetWorkbenchSha(datasetWorkbenchJson(request)) }
    const task = Promise.resolve().then(async () => {
      if (!this.nameProviderBridge || this.shuttingDown && !cleanup) return captureDatasetNameProviderReply({ ...echo, ok: false, failure: 'NOT_READY' })
      if (this.shuttingDown && !originalDrain) throw new CoreIpcError('OUTBOX_SCOPE_MISMATCH', '原名称cleanup没有原Main关联')
      const known = this.nameProviderBindings.get(route)
      const author = cleanup && known ? undefined : await this.createWorkbenchRootMainAuthor()
      const binding = known?.binding ?? author?.binding
      if (!binding || !this.nameProviderRouteCurrent(route, cleanup) || binding.authorityRef !== route || binding.childGeneration !== route.generation || binding.ownerEpoch !== request.epoch || binding.datasetId !== request.datasetId) throw new CoreIpcError('OUTBOX_SCOPE_MISMATCH', '名称来源原Owner身份已改变')
      if (!cleanup && this.nameProviderRevoked.has(route)) throw new CoreIpcError('NOT_READY', '原名称来源已撤销')
      const authorityId=known?.authorityId??randomUUID()
      if(request.authorityId!==null&&(request.authorityId!==authorityId||request.childGeneration!==route.generation))throw new CoreIpcError('OUTBOX_SCOPE_MISMATCH','名称来源原Main关联已改变')
      if(request.authorityId===null&&request.command!=='nameProviderStart'&&!known)throw new CoreIpcError('NOT_READY','原名称operation尚未由Main受理')
      this.nameProviderBindings.set(route,{binding,authorityId})
      echo.authorityId=authorityId;echo.childGeneration=route.generation
      const result = await this.nameProviderBridge.execute(request, { binding, signal: controller.signal, deadlineAtMs })
      return captureDatasetNameProviderReply({ ...echo, ok: true, result })
    }).catch(error => {
      const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined
      const failure: DatasetNameProviderFailure = (DATASET_NAME_PROVIDER_FAILURES as readonly unknown[]).includes(code) ? code as DatasetNameProviderFailure : error instanceof CoreIpcError ? error.code === 'TIMEOUT' ? 'TIMEOUT' : 'NOT_READY' : 'INVALID_RESPONSE'
      return captureDatasetNameProviderReply({ ...echo, ok: false, failure })
    }).then(reply => {
      assertDatasetNameProviderReplyForRequest(reply, request)
      if (controller.signal.aborted || !this.nameProviderRouteCurrent(route, cleanup || refuseStart) || Date.now() >= request.expiresAtMs || performance.now() >= deadlineAtMs) return
      route.port.postMessage(reply)
    }).catch(() => { this.failNameProviderRoute(route) }).finally(() => { clearTimeout(timer); this.nameProviderFlights.delete(flight) })
    const timer = setTimeout(() => controller.abort(), Math.max(1, deadlineAtMs - performance.now()))
    const flight = { route, cleanup, controller, task }; this.nameProviderFlights.add(flight)
  }
  private failNameProviderRoute(route: StartupAttempt): void {
    if (route !== this.startupAttempt || route.child !== this.child || route.port !== this.port) return
    const error = new CoreIpcError('INVALID_IPC_RESPONSE', '名称来源私有消息未通过闭集核验')
    route.cancelStart(error); this.rejectPending(error)
    try { route.child.kill() } catch { /* 原route已撤销；物理退出仍由shutdown核验。 */ }
  }

  configurePrivateWorkbenchDirectoryProducer(producer:NonNullable<CoreSupervisor['directoryProducer']>):void {
    if(this.startupGeneration!==0||this._status!=='stopped'||this.child||this.directoryProducer||typeof producer!=='function')throw new CoreIpcError('NOT_READY','目录作者只能在首次启动前固定')
    this.directoryProducer=producer
  }
  async requestWorkbenchDirectoryRegistration(command:'register'|'release',binding:SourceWorkbenchDirectoryBinding,actual:Readonly<WorkbenchMainBinding>,signal:AbortSignal):Promise<SourceWorkbenchDirectoryRegistrationReply>{
    const route=this.startupAttempt,port=this.sourceWritesPort
    const check=()=>{if(!route||!port||this.directoryAuthorRoutes.get(actual)!==route||this.sourceWritesPort!==port||this.startupAttempt!==route||this.child!==route.child||this.port!==route.port||actual.authorityRef!==route||actual.childGeneration!==route.generation||binding.childGeneration!==route.generation||actual.datasetId!==binding.datasetId||actual.ownerEpoch!==binding.ownerEpoch||signal.aborted||command==='register'&&(!this.isCurrentRoute(route)||this._status!=='ready'))throw new CoreIpcError('OUTBOX_SCOPE_MISMATCH','目录原物理作者已撤销')}
    check();if(this.directoryPending.size>=4)throw new CoreIpcError('NOT_READY','目录登记已达原有限预算')
    const q=captureSourceWorkbenchDirectoryRegistrationRequest({version:1,type:'workbench-directory-registration-request',purpose:'WORKBENCH_DIRECTORY',requestId:randomUUID(),sequence:++this.directoryRegistrationSequence,command,binding,expiresAtMs:Date.now()+2000})
    const reply=await new Promise<SourceWorkbenchDirectoryRegistrationReply>((resolve,reject)=>{
      const abort=()=>{const p=this.directoryPending.get(q.requestId);if(!p)return;clearTimeout(p.timer);p.detach();this.directoryPending.delete(q.requestId);reject(new CoreIpcError('TIMEOUT','目录原操作未确认，不重发'));this.closeSourceWrites(port)}
      const timer=setTimeout(abort,2000),detach=()=>signal.removeEventListener('abort',abort);this.directoryPending.set(q.requestId,{port:port!,route:route!,request:q,timer,detach,resolve,reject});signal.addEventListener('abort',abort,{once:true});try{check();port!.postMessage(q)}catch{abort()}
    });check();assertSourceWorkbenchDirectoryRegistrationReplyForRequest(reply,q);if(Date.now()>=q.expiresAtMs)throw new CoreIpcError('TIMEOUT','目录原结果已迟到');return reply
  }
  async waitWorkbenchDirectoryOwnerClosed(actual:Readonly<WorkbenchMainBinding>):Promise<void>{
    const route=this.directoryAuthorRoutes.get(actual)
    if(!route||route!==actual.authorityRef||route.generation!==actual.childGeneration||!route.child)throw new CoreIpcError('NOT_READY','原目录child身份无效')
    if(this.child!==route.child&&this.childExit?.child!==route.child)return
    const exit=this.childExit?.child===route.child?this.childExit.promise:undefined;if(!exit)throw new CoreIpcError('NOT_READY','原目录Owner物理关闭未确认')
    let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([exit,new Promise<never>((_r,reject)=>{timer=setTimeout(()=>reject(new CoreIpcError('NOT_READY','原目录Owner仍未物理关闭')),2000)})])}finally{if(timer)clearTimeout(timer)}
    if(this.child===route.child||this.childExit?.child===route.child)throw new CoreIpcError('NOT_READY','原目录Owner仍未物理关闭')
  }
  private receiveWorkbenchDirectory(raw:unknown,port:CoreMessagePort,route:StartupAttempt):void{
    const q=captureSourceWorkbenchDirectoryRequest(raw)
    const current=q.command==='revoke'&&this.shuttingDown?this.startupAttempt===route&&this.child===route.child&&this.port===route.port:this.isCurrentRoute(route)&&this._status==='ready'
    if(!current||this.sourceWritesPort!==port||q.binding.childGeneration!==route.generation||q.sequence!==this.directorySequence+1||q.expiresAtMs<=Date.now()||q.expiresAtMs>Date.now()+2000||this.directoryTasks.size>=4||this.directoryAuthorityId!==undefined&&q.authorityId!==this.directoryAuthorityId||this.lyricsGrantAuthorityId!==undefined&&q.authorityId!==this.lyricsGrantAuthorityId||this.readersAuthorityId!==undefined&&q.authorityId!==this.readersAuthorityId)throw new CoreIpcError('INVALID_IPC_RESPONSE','目录原请求不是当前物理actor')
    this.directorySequence=q.sequence;this.directoryAuthorityId??=q.authorityId
    const controller=new AbortController(),deadlineAtMs=performance.now()+Math.min(2000,q.expiresAtMs-Date.now())
    const task=Promise.resolve().then(async()=>{
      const fallback:SourceWorkbenchDirectoryReply={version:1,type:'workbench-directory-reply',purpose:'WORKBENCH_DIRECTORY',requestId:q.requestId,sequence:q.sequence,authorityId:q.authorityId,command:q.command,binding:q.binding,ui:q.ui,requestSha256:lyricsPhysicalDigest(q),decision:'rejected',nonce:null,validUntilMs:null,physical:null}
      const reply=captureSourceWorkbenchDirectoryReply(this.directoryProducer?await this.directoryProducer(q,{signal:controller.signal,deadlineAtMs}):fallback);assertSourceWorkbenchDirectoryReplyForRequest(reply,q)
      if(controller.signal.aborted||this.startupAttempt!==route||this.child!==route.child||this.port!==route.port||q.command!=='revoke'&&!this.isCurrentRoute(route)||this.sourceWritesPort!==port||Date.now()>=q.expiresAtMs)throw new CoreIpcError('TIMEOUT','目录原许可已撤销或迟到');port.postMessage(reply)
    }).catch(()=>this.closeSourceWrites(port)).finally(()=>{clearTimeout(timer);this.directoryTasks.delete(flight)})
    const timer=setTimeout(()=>{controller.abort();this.closeSourceWrites(port)},Math.max(1,deadlineAtMs-performance.now())),flight={port,controller,task};this.directoryTasks.add(flight)
  }
  async joinPrivateWorkbenchDirectoryProducer():Promise<void>{await Promise.allSettled([...this.directoryTasks].map(v=>v.task))}

  get status(): CoreSupervisorStatus {
    return this._status
  }

  get restarts(): number {
    return this.restartCount
  }

  /** 可信 Main 的闭集移动能力；不在 Renderer 的通用 command 列表内。 */
  async requestMobileMain(input: MobileOwnerPrivateRequest): Promise<MobileOwnerPrivateResult> {
    const port = this.port, generation = this.startupGeneration
    if (!port || this._status !== 'ready' || this.shuttingDown || !isMobileOwnerPrivateRequest(input) || this.mobilePending.size >= 32) {
      throw new MobileAuthPersistenceError('not-sent')
    }
    const call: MobileCorePrivateCall = { type: 'mobile-main-request', id: randomUUID(), request: structuredClone(input) }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.mobilePending.delete(call.id); reject(new MobileAuthPersistenceError('unknown')) }, LIBRARY_REQUEST_TIMEOUT_MS)
      this.mobilePending.set(call.id, { call, timer, reject, resolve })
      try {
        if (this.port !== port || this.startupGeneration !== generation || this.shuttingDown) throw new Error('移动路由已撤销。')
        port.postMessage(call)
      } catch { clearTimeout(timer); this.mobilePending.delete(call.id); reject(new MobileAuthPersistenceError('unknown')) }
    })
  }
  private closeMobilePending(): void {
    for (const pending of this.mobilePending.values()) { clearTimeout(pending.timer); pending.reject(new MobileAuthPersistenceError('unknown')) }
    this.mobilePending.clear()
  }

  /** 004独立闭集的可信Main请求；不是Renderer/public command。未知工作仍占位至quiet或进程退出。 */
  async requestMobileContentMain(input: MobileContentCoreRequest, signal: AbortSignal): Promise<MobileContentCoreResponse> {
    const port = this.port, generation = this.startupGeneration;
    const call = captureMobileContentCoreRequest(input);
    const control = call.action === 'cancel' || call.action === 'invalidate-device' || call.action === 'revalidate'
      || call.action === 'source' && (call.request.operation === 'release' || call.request.operation === 'close-read');
    const maximum = control ? MOBILE_CONTENT_RPC_BOUNDS.inflight : MOBILE_CONTENT_RPC_BOUNDS.inflight - 1;
    if (!(signal instanceof AbortSignal) || signal.aborted || !port || this._status !== 'ready' || this.shuttingDown
      || this.mobileContentPending.has(call.id) || this.mobileContentPending.size >= maximum) {
      if (call.action === 'initialize') call.key.fill(0);
      throw new MobileAuthPersistenceError('not-sent');
    }
    return new Promise((resolve, reject) => {
      const cancel = () => reject(new MobileAuthPersistenceError('unknown'));
      const timer = setTimeout(cancel, MOBILE_CONTENT_RPC_BOUNDS.requestMs);
      signal.addEventListener('abort', cancel, { once: true });
      this.mobileContentPending.set(call.id, { call, generation, timer,
        rangeTransport: mobileRangeWindowRpc(call.id, call.action === 'source' ? call.request.operation : call.action, control ? 'cleanup' : 'business', 'content.rpc.retained'),
        detachAbort: () => signal.removeEventListener('abort', cancel), reject, resolve });
      try {
        if (signal.aborted || this.port !== port || this.startupGeneration !== generation || this.shuttingDown) throw new Error('内容路由已撤销。');
        port.postMessage(call);
      } catch {
        // 同步post失败的受理边界也不猜测；保留原nonce直到该Core确实退出。
        clearTimeout(timer); cancel();
      }
    });
  }
  private settleMobileContent(id: string, rejected = false, observationError?: unknown): void {
    const pending = this.mobileContentPending.get(id); if (!pending) return;
    pending.rangeTransport?.settle(id, rejected, observationError);
    clearTimeout(pending.timer); pending.detachAbort();
    if (pending.call.action === 'initialize') pending.call.key.fill(0);
    this.mobileContentPending.delete(id);
  }
  private closeMobileContentPending(exited = false): void {
    for (const [id, pending] of this.mobileContentPending) {
      clearTimeout(pending.timer); pending.detachAbort(); pending.reject(new MobileAuthPersistenceError('unknown'));
      if (exited) this.settleMobileContent(id, true, { code: 'SERVICE_RESTARTED' });
    }
  }

  /** 只交付可信 Main 源写路由；通用 requestInternal 不使用此端口。 */
  async requestSourceWrites<C extends LocalSourceWritesPrivateCommand>(command: C, payload: LocalSourceWritesPrivateCommandPayloads[C]): Promise<LocalSourceWritesPrivateCommandResults[C]> {
    const port = this.sourceWritesPort
    if (!port || this._status !== 'ready' || this.shuttingDown) throw new CoreIpcError('NOT_READY', '源写专用通道尚未就绪。')
    if (this.sourceWritesPending.size >= 128 || this.sourceWritesSequence >= Number.MAX_SAFE_INTEGER) throw new CoreIpcError('NOT_READY', '源写专用通道已达到安全预算。')
    const requestId = randomUUID(), sequence = ++this.sourceWritesSequence
    let request
    try { request = localSourceWritesMainRequestSnapshot({ version: 1, type: 'source-writes-request', requestId, sequence, command, payload }) }
    catch { throw new CoreIpcError('INVALID_IPC_REQUEST', '源写私有请求或原图材料无效。') }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.sourceWritesPending.delete(requestId); reject(new CoreIpcError('TIMEOUT', '源写受理结果未知；只能核对原请求。')) }, this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
      this.sourceWritesPending.set(requestId, { sequence, command, timer, resolve: value => resolve(value as LocalSourceWritesPrivateCommandResults[C]), reject })
      try { port.postMessage(request) }
      catch { clearTimeout(timer); this.sourceWritesPending.delete(requestId); reject(new CoreIpcError('INTERNAL_ERROR', '源写受理结果未知；不会重新发送。')) }
    })
  }

  private closeSourceWrites(port = this.sourceWritesPort): void {
    for(const flight of this.readersTasks)if(flight.port===port)flight.controller.abort()
    for(const flight of this.directoryTasks)if(flight.port===port)flight.controller.abort()
    for(const[id,pending]of this.directoryPending)if(pending.port===port){clearTimeout(pending.timer);pending.detach();this.directoryPending.delete(id);pending.reject(new CoreIpcError('NOT_READY','原目录物理端口已关闭'))}
    for (const task of this.lyricsGrantTasks) if (task.port === port) task.controller.abort()
    for (const [id, pending] of this.lyricsVerifyPending) if (pending.port === port) {
      clearTimeout(pending.timer); pending.signal.removeEventListener('abort', pending.abort); this.lyricsVerifyPending.delete(id); pending.reject(new CoreIpcError('NOT_READY', '原歌词物理核验端口已关闭'))
    }
    port?.close()
    if (this.sourceWritesPort !== port) return
    this.sourceWritesPort = undefined
    for (const pending of this.sourceWritesPending.values()) { clearTimeout(pending.timer); pending.reject(new CoreIpcError('NOT_READY', '源写通道已关闭；原请求只能读取核对。')) }
    this.sourceWritesPending.clear()
  }
  /** 013独立物理通道；原012端口、通用internal和Outbox都不能签本域具体能力。 */
  async requestRelocationMain<C extends LocalRelocationMainCommand>(command: C, payload: LocalRelocationMainCommandPayloads[C]): Promise<LocalRelocationMainCommandResults[C]> {
    const port = this.relocationMainPort
    if (!port || this._status !== 'ready' || this.shuttingDown) throw new CoreIpcError('NOT_READY', '搬迁专用通道尚未就绪。')
    if (this.relocationPending.size >= 4 || this.relocationSequence >= Number.MAX_SAFE_INTEGER) throw new CoreIpcError('NOT_READY', '搬迁专用通道已达到安全预算。')
    const requestId = randomUUID(), sequence = this.relocationSequence + 1
    let request
    try { request = localRelocationMainRequestSnapshot({ version: 1, type: 'relocation-main-request', requestId, sequence, command, payload }) }
    catch { throw new CoreIpcError('INVALID_IPC_REQUEST', '搬迁私有请求或具体计划无效。') }
    this.relocationSequence = sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.relocationPending.delete(requestId); reject(new CoreIpcError('TIMEOUT', '搬迁结果未知；只能核对原命令。')) }, this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
      this.relocationPending.set(requestId, { sequence, command, timer, resolve: value => resolve(value as LocalRelocationMainCommandResults[C]), reject })
      try { port.postMessage(request) }
      catch { this.closeRelocation(port) }
    })
  }
  private closeRelocation(port = this.relocationMainPort): void {
    if (this.relocationMainPort !== port) { port?.close(); return }
    this.relocationMainPort = undefined
    port?.close()
    for (const pending of this.relocationPending.values()) { clearTimeout(pending.timer); pending.reject(new CoreIpcError('NOT_READY', '搬迁通道已关闭；原命令只能读取核对。')) }
    this.relocationPending.clear()
  }

  async getPlaybackStreamSnapshot(): Promise<PlaybackStreamSnapshot | null> {
    const route = this.startupAttempt
    if (!route || !this.isCurrentRoute(route) || this._status !== 'ready') throw new CoreIpcError('NOT_READY', 'Core is not ready')
    if (!route.playbackEvents) return null
    const result = await this.request('playback.getStreamSnapshot', {})
    // 已resolve的旧回复也不能跨异步续体进入新route。
    if (!this.isCurrentRoute(route) || this._status !== 'ready') throw new CoreIpcError('NOT_READY', 'Core 播放流路由已撤销')
    this.assertStreamSnapshot(result, route)
    return result
  }

  private isCurrentRoute(route: StartupAttempt): boolean {
    return route.valid && route === this.startupAttempt && route.generation === this.startupGeneration && this.child === route.child && this.port === route.port && !this.shuttingDown
  }

  private assertStreamSnapshot(value: PlaybackStreamSnapshot | null, route: StartupAttempt): asserts value is PlaybackStreamSnapshot {
    if (!value || value.stamp.coreInstanceId !== route.playbackEvents?.coreInstanceId) throw new CoreIpcError('INVALID_IPC_RESPONSE', 'Core 播放流基准身份无效')
  }

  private workbenchCancel(item:{route:StartupAttempt;meta:DatasetWorkbenchMeta}):void{
    if(this.isCurrentRoute(item.route))try{item.route.port.postMessage(datasetWorkbenchControl(item.meta,'cancel'))}catch{/* 原取消发送未知，不重发原命令。 */}
  }
  private workbenchQuiet(id:string):void{
    const item=this.workbenchPending.get(id);if(!item)return
    clearTimeout(item.timer);item.detach();this.workbenchPending.delete(id);this.workbenchRetired.add(id)
    if(this.workbenchRetired.size>1024)this.workbenchRetired.delete(this.workbenchRetired.values().next().value!)
  }
  /** 只记录原localAlbum读取内的context首拒；成功不输出，诊断失败不改变原异常或Promise。 */
  private workbenchContextTraceFailure(trace:LocalAlbumNodeContext|undefined,stage:LocalAlbumTraceStage,error:unknown,meta?:DatasetWorkbenchMeta,mappedCode:unknown=null,routeMatched:boolean|null=null):void{
    if(!trace||meta&&meta.kind!=='context')return
    try{withLocalAlbumContext(trace,()=>{
      localAlbumPhase(stage);if(routeMatched!==null)localAlbumMatch('route',routeMatched)
      // 原meta只有真实失败才关联；不为成功context输出begin/ok或占用证据环。
      if(meta)localAlbumLink(meta.id,stage)
      localAlbumReject(error,mappedCode)
    })}catch{/* 旁路故障不得反向抛入原业务。 */}
  }
  private workbenchReceive(value:unknown,route:StartupAttempt):void{
    if(!isDatasetWorkbenchFrame(value)||value.lane!=='response')return
    const item=this.workbenchPending.get(value.id)
    if(!item||item.route!==route||!sameDatasetWorkbenchMeta(value,item.meta))return
    const currentRoute=this.isCurrentRoute(route)
    if(!currentRoute||this._status!=='ready'){item.expired=true;const error=new CoreIpcError('NOT_READY','原整理Utility已撤销');this.workbenchContextTraceFailure(item.trace,'context.supervisor.receive.route',error,item.meta,null,currentRoute);item.reject(error);return}
    if(value.part==='failure'){item.expired=true;const error=new CoreIpcError(value.code,'原整理请求未确认，请核对原command/body回执');this.workbenchContextTraceFailure(item.trace,'context.supervisor.receive.failure',error,item.meta,null,true);item.reject(error);return}
    if(value.part==='settled'){if(!item.expired){const error=new CoreIpcError('INVALID_IPC_RESPONSE','原整理响应未完整结束');this.workbenchContextTraceFailure(item.trace,'context.supervisor.response',error,item.meta,null,true);item.reject(error)}this.workbenchQuiet(value.id);return}
    try{
      const result=item.assembly.accept(value);if(result===undefined)return
      if(item.meta.kind==='context'){
        if(!isDatasetWorkbenchContext(result)||result.datasetId!==item.meta.datasetId||item.meta.epoch!==null&&result.epoch!==item.meta.epoch)throw new DatasetWorkbenchWireError('OUTBOX_SCOPE_MISMATCH')
      }else if(item.meta.kind==='owner'){if(!item.request||!isDatasetWorkbenchOwnerRequest(item.request)||!isDatasetWorkbenchOwnerResult(item.request.command,result,item.request.payload,item.meta.datasetId))throw new DatasetWorkbenchWireError('INVALID_IPC_RESPONSE')}
      else if(!item.request||!isDatasetWorkbenchRequest(item.request)||!isDatasetWorkbenchResult(item.request,result,item.meta.datasetId))throw new DatasetWorkbenchWireError('INVALID_IPC_RESPONSE')
      if(item.expired){this.workbenchQuiet(value.id);return}
      if(!this.isCurrentRoute(route)||Date.now()>=item.meta.expiresAtMs)throw new DatasetWorkbenchWireError('TIMEOUT')
      item.resolve(result);this.workbenchQuiet(value.id)
    }catch(error){item.expired=true;const code=error instanceof DatasetWorkbenchWireError?error.code:'INVALID_IPC_RESPONSE';this.workbenchContextTraceFailure(item.trace,'context.supervisor.dto',error,item.meta,code,true);item.reject(new CoreIpcError(code,'原整理响应未通过完整核验'));this.workbenchCancel(item)}
  }
  private workbenchRpc(route:StartupAttempt,datasetId:string,epoch:string|null,request:DatasetWorkbenchRequest|DatasetWorkbenchOwnerRequest|null,read?:{signal?:AbortSignal;deadlineAtMs?:number}):Promise<unknown>{
    const trace=request===null?captureLocalAlbumContext():undefined
    let guardStage:LocalAlbumTraceStage='context.supervisor.route'
    const currentRoute=this.isCurrentRoute(route)
    // 原route→ready→24→signal短路求值，每个原谓词仍只执行一次。
    if(!currentRoute||(guardStage='context.supervisor.ready',this._status!=='ready')||(guardStage='context.supervisor.budget',this.workbenchPending.size>=24)||(guardStage='context.supervisor.cancel',read?.signal?.aborted)){
      const error=new CoreIpcError('NOT_READY','当前整理Utility未就绪');this.workbenchContextTraceFailure(trace,guardStage,error,undefined,null,currentRoute);throw error
    }
    const remaining=Math.min(2000,Math.floor((read?.deadlineAtMs??performance.now()+2000)-performance.now()))
    if(remaining<=0){const error=new CoreIpcError('TIMEOUT','原整理响应期限已到');this.workbenchContextTraceFailure(trace,'context.supervisor.cancel',error);throw error}
    const body=request??{},meta:DatasetWorkbenchMeta={id:randomUUID(),epoch,datasetId,sequence:++this.workbenchSequence,kind:request?('family'in request?'execute':'owner'):'context',requestSha256:datasetWorkbenchSha(datasetWorkbenchJson(body)),expiresAtMs:Date.now()+remaining}
    return new Promise((resolve,reject)=>{
      const onAbort=()=>{const item=this.workbenchPending.get(meta.id);if(item&&!item.expired){item.expired=true;const error=new CoreIpcError('TIMEOUT','原整理请求尚未确认');this.workbenchContextTraceFailure(item.trace,'context.supervisor.cancel',error,item.meta);item.reject(error);this.workbenchCancel(item)}}
      const item={route,meta,...(trace?{trace}:{}),request:request?structuredClone(request):null,assembly:createDatasetWorkbenchAssembler(meta,'response'),timer:setTimeout(onAbort,remaining),expired:false,detach(){read?.signal?.removeEventListener('abort',onAbort)},resolve,reject}
      this.workbenchPending.set(meta.id,item);read?.signal?.addEventListener('abort',onAbort,{once:true})
      try{for(const frame of datasetWorkbenchFrames(meta,'request',body)){if(!this.isCurrentRoute(route)||this._status!=='ready')throw new Error('原路由撤销');route.port.postMessage(frame)}}
      catch(error){this.workbenchContextTraceFailure(trace,'context.supervisor.send',error,meta,'NOT_READY');reject(new CoreIpcError('NOT_READY','原整理请求未完成派发'));this.workbenchQuiet(meta.id)}
    })
  }
  /** authorityRef就是本次实际StartupAttempt；DTO/UUID不构成SourceFiles许可。 */
  async createWorkbenchRootMainAuthor():Promise<WorkbenchMainAuthor>{
    const route=this.startupAttempt
    if(!route||!this.isCurrentRoute(route)||this._status!=='ready')throw new CoreIpcError('NOT_READY','真实整理Utility尚未就绪')
    if(this.workbenchAuthorFlight?.route===route)return this.workbenchAuthorFlight.promise
    const promise=(async()=>{
      const current=await this.request('commandOutbox.context',{})
      if(!this.isCurrentRoute(route)||this._status!=='ready')throw new CoreIpcError('NOT_READY','原整理启动路由已撤销')
      const identity=await this.workbenchRpc(route,current.datasetId,null,null) as DatasetWorkbenchContext
      if(!isDatasetWorkbenchContext(identity)||!this.isCurrentRoute(route))throw new CoreIpcError('NOT_READY','真实整理Owner未完成prepare/commit')
      const binding=Object.freeze({datasetId:identity.datasetId,ownerEpoch:identity.epoch,childGeneration:route.generation,authorityRef:route})
      this.directoryAuthorRoutes.set(binding,route) // 只绑定实际prepare/commit后的原作者对象，不从DTO恢复。
      route.workbenchBinding=binding
      const check=(value:Readonly<WorkbenchMainBinding>)=>{
        if(value.authorityRef!==route||value.datasetId!==binding.datasetId||value.ownerEpoch!==binding.ownerEpoch||value.childGeneration!==route.generation||!this.isCurrentRoute(route)||this._status!=='ready')throw new CoreIpcError('OUTBOX_SCOPE_MISMATCH','原整理Owner或Utility已改变')
      }
      return {binding,
        assertCurrent:async(value:Readonly<WorkbenchMainBinding>)=>{check(value);const fresh=await this.workbenchRpc(route,binding.datasetId,binding.ownerEpoch,null);check(value);if(!isDatasetWorkbenchContext(fresh)||fresh.epoch!==binding.ownerEpoch||fresh.datasetId!==binding.datasetId)throw new CoreIpcError('OUTBOX_SCOPE_MISMATCH','原整理Owner身份已改变')},
        request:async(request:DatasetWorkbenchRequest,context:{binding:Readonly<WorkbenchMainBinding>;signal:AbortSignal;deadlineAtMs:number})=>{check(context.binding);if(!isDatasetWorkbenchRequest(request))throw new CoreIpcError('INVALID_IPC_REQUEST','整理命令不在39闭集');const result=await this.workbenchRpc(route,binding.datasetId,binding.ownerEpoch,structuredClone(request),context);check(context.binding);return result as DatasetWorkbenchResult},
        requestOwner:async<C extends DatasetWorkbenchOwnerCommand>(command:C,payload:DatasetWorkbenchOwnerPayloads[C],context:{binding:Readonly<WorkbenchMainBinding>;signal:AbortSignal;deadlineAtMs:number}):Promise<DatasetWorkbenchOwnerResults[C]>=>{
          check(context.binding);const request={command,payload}
          if(!isDatasetWorkbenchOwnerRequest(request)||!isDatasetWorkbenchOwnerScope(request,binding.datasetId))throw new CoreIpcError('INVALID_IPC_REQUEST','私有整理端点不在18闭集')
          const result=await this.workbenchRpc(route,binding.datasetId,binding.ownerEpoch,structuredClone(request),context);check(context.binding)
          if(!isDatasetWorkbenchOwnerResult(command,result,payload,binding.datasetId))throw new CoreIpcError('INVALID_IPC_RESPONSE','私有整理回复未通过原请求核验')
          return result
        },
      }
    })()
    this.workbenchAuthorFlight={route,promise}
    void promise.catch(()=>{if(this.workbenchAuthorFlight?.promise===promise)this.workbenchAuthorFlight=undefined})
    return promise
  }
  private revokeWorkbenchRequests(error:CoreIpcError,physicalExit=false):void{
    this.revokeLyricsProviderTasks(physicalExit)
    this.revokeNameProviderTasks(physicalExit)
    this.workbenchAuthorFlight=undefined
    for(const [id,item]of this.workbenchPending){item.expired=true;item.reject(error);this.workbenchCancel(item);if(physicalExit)this.workbenchQuiet(id)}
  }

  /** 三个明确只读命令走独立私有协议，不加入通用IPC dispatch。 */
  /** 仅 Main 在首次启动前固定已有只读图片 normalizer。 */
  configurePrivateLocalAlbumArtworkNormalizer(normalize:NonNullable<CoreSupervisor['albumArtworkNormalizer']>):void {
    if(this.startupGeneration!==0||this._status!=='stopped'||this.child||this.albumArtworkNormalizer||typeof normalize!=='function')throw new CoreIpcError('NOT_READY','专辑封面作者只能在首次启动前固定')
    this.albumArtworkNormalizer=normalize
  }
  async joinPrivateLocalAlbumArtworkNormalizer():Promise<void>{while(this.albumArtworkFlights.size)await Promise.allSettled([...this.albumArtworkFlights].map(f=>f.task))}
  private receiveLocalAlbumArtwork(raw:unknown,route:StartupAttempt):void {
    if(isLocalAlbumArtworkMainCancel(raw)){
      const original=[...this.albumArtworkFlights].find(f=>f.route===route&&f.request.id===raw.id)
      if(!original)return
      const q=original.request
      if(raw.sequence!==q.sequence||raw.datasetId!==q.datasetId||raw.epoch!==q.projection.epoch||raw.expiresAtMs!==q.expiresAtMs)throw new CoreIpcError('INVALID_IPC_RESPONSE','封面取消不是原请求')
      original.controller.abort();return
    }
    if(!isLocalAlbumArtworkMainRequest(raw)||!this.isCurrentRoute(route)||this._status!=='ready'||raw.sequence<=this.albumArtworkSequence
      ||raw.expiresAtMs>Date.now()+2000)throw new CoreIpcError('INVALID_IPC_RESPONSE','封面反向请求不是当前实际Owner')
    const q=structuredClone(raw);this.albumArtworkSequence=q.sequence
    const controller=new AbortController(),deadlineAtMs=performance.now()+Math.max(0,Math.min(2000,q.expiresAtMs-Date.now()))
    const echo={version:1 as const,type:'local-album-artwork-main-response' as const,id:q.id,sequence:q.sequence,datasetId:q.datasetId,expiresAtMs:q.expiresAtMs}
    const reply=(projection:LocalAlbumArtworkMainReply['projection'])=>{
      const response={...echo,projection}
      if(!isLocalAlbumArtworkMainReply(response,q))throw new CoreIpcError('INVALID_IPC_RESPONSE','专辑封面结果没有原请求关联')
      if(this.isCurrentRoute(route)&&this._status==='ready')route.port.postMessage(response)
    }
    const failure=(code:'NOT_READY'|'TIMEOUT'|'INVALID_IPC_RESPONSE')=>reply({version:1,type:'projection-response',epoch:q.projection.epoch,projectionRequestId:q.id,ok:false,failure:responseFailure(q.id,code,'原专辑封面规范化未确认。')})
    if(q.expiresAtMs<=Date.now()||this.albumArtworkFlights.size>=4){
      // 普通过期/背压只结束原读取；必须先核已建立的真实Owner绑定，不能由早退绕过身份检查。
      const binding=route.workbenchBinding
      if(!binding||binding.authorityRef!==route||binding.childGeneration!==route.generation||binding.datasetId!==q.datasetId||binding.ownerEpoch!==q.projection.epoch)
        throw new CoreIpcError('INVALID_IPC_RESPONSE','封面反向请求不是原真实Owner')
      failure(q.expiresAtMs<=Date.now()?'TIMEOUT':'NOT_READY');return
    }
    const task=Promise.resolve().then(async()=>{
      try{
        const author=await this.createWorkbenchRootMainAuthor(),binding=author.binding
        if(binding.authorityRef!==route||binding.childGeneration!==route.generation||binding.datasetId!==q.datasetId||binding.ownerEpoch!==q.projection.epoch)throw new CoreIpcError('INVALID_IPC_RESPONSE','专辑封面不是原真实Owner')
        if(controller.signal.aborted||Date.now()>=q.expiresAtMs||performance.now()>=deadlineAtMs)throw new CoreIpcError('TIMEOUT','原专辑封面已取消或迟到')
        if(!this.albumArtworkNormalizer)throw new CoreIpcError('NOT_READY','可信Main封面作者尚未配置')
        const result=await this.albumArtworkNormalizer((q.projection.payload as {copies:unknown}).copies,{signal:controller.signal,deadlineAtMs})
        if(controller.signal.aborted||Date.now()>=q.expiresAtMs||performance.now()>=deadlineAtMs)throw new CoreIpcError('TIMEOUT','原专辑封面已取消或迟到')
        if(!this.isCurrentRoute(route)||this._status!=='ready'||route.workbenchBinding!==binding)throw new CoreIpcError('NOT_READY','原专辑封面路由已经撤销')
        reply({version:1,type:'projection-response',epoch:q.projection.epoch,projectionRequestId:q.id,ok:true,result})
      }catch(error){failure(error instanceof CoreIpcError&&error.code==='TIMEOUT'?'TIMEOUT':error instanceof CoreIpcError&&error.code==='INVALID_IPC_RESPONSE'?'INVALID_IPC_RESPONSE':'NOT_READY')}
    }).catch(()=>this.failLocalAlbumArtworkRoute(route)).finally(()=>{clearTimeout(timer);this.albumArtworkFlights.delete(flight)})
    const timer=setTimeout(()=>controller.abort(),Math.max(1,deadlineAtMs-performance.now())),flight={route,request:q,controller,task};this.albumArtworkFlights.add(flight)
  }
  private failLocalAlbumArtworkRoute(route:StartupAttempt):void {
    if(route!==this.startupAttempt||route.child!==this.child||route.port!==this.port)return
    const error=new CoreIpcError('INVALID_IPC_RESPONSE','专辑封面反向消息未通过原闭集核验');route.cancelStart(error);this.rejectPending(error)
    try{route.child.kill()}catch{/* 原物理退出仍由 shutdown 核验。 */}
  }

  async readLocalAlbum(input: LocalAlbumMainRequest): Promise<LocalAlbumMainResponse> {
    localAlbumPhase('supervisor.dto')
    if (!isLocalAlbumMainRequest(input)) throw new CoreIpcError('INVALID_IPC_REQUEST','本地专辑私有请求无效')
    const call=structuredClone(input), port=this.port, route=this.startupAttempt, generation=this.startupGeneration, trace=captureLocalAlbumContext()
    localAlbumPhase('supervisor.route')
    if (!port || !route || !this.isCurrentRoute(route) || this._status!=='ready' || this.shuttingDown) throw new CoreIpcError('NOT_READY','本地专辑作者尚未就绪')
    if (this.localAlbumPending.has(call.id)) throw new CoreIpcError('INVALID_IPC_REQUEST','本地专辑读取身份重复')
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>withLocalAlbumContext(trace, () => { this.localAlbumPending.delete(call.id); localAlbumPhase('supervisor.timeout'); const error=new CoreIpcError('TIMEOUT','本地专辑读取暂未确认，请重新读取'); localAlbumReject(error); reject(error); }),Math.min(DEFAULT_REQUEST_TIMEOUT_MS,this.options.requestTimeoutMs??DEFAULT_REQUEST_TIMEOUT_MS))
      this.localAlbumPending.set(call.id,{call,generation,port,timer,...(trace ? {trace} : {}),
        resolve: value => withLocalAlbumContext(trace, () => { emitLocalAlbumNodeTrace('ok'); resolve(value); }),
        reject: error => withLocalAlbumContext(trace, () => { localAlbumReject(error); reject(error); }) })
      try {
        if (this.port!==port || !this.isCurrentRoute(route) || this.startupGeneration!==generation || this._status!=='ready' || this.shuttingDown) throw new Error('原读取路由已撤销')
        localAlbumMatch('route', true); localAlbumPhase('supervisor.send'); port.postMessage(call)
      } catch (error) { localAlbumReject(error, 'NOT_READY'); clearTimeout(timer);this.localAlbumPending.delete(call.id);reject(new CoreIpcError('NOT_READY','本地专辑读取路由已撤销'))}
    })
  }
  private closeLocalAlbumPending(error: CoreIpcError): void {
    for (const entry of this.localAlbumPending.values()) {clearTimeout(entry.timer);entry.reject(error)}
    this.localAlbumPending.clear()
  }

  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise
    if (this.restartPromise) {
      await this.restartPromise
      if (this._status !== 'ready' || this.shuttingDown) throw new CoreIpcError('INTERNAL_ERROR', 'Core 重启恢复未完成')
      return
    }
    if (this.shuttingDown) {
      throw new CoreIpcError('NOT_READY', 'Core supervisor is shutting down')
    }
    if (this._status === 'ready') return
    if (this.childExit) throw new CoreIpcError('NOT_READY', '旧 Core 未确认退出，禁止启动新进程')
    this.startPromise = this.startWithOneRetry()
    try {
      await this.startPromise
    } finally {
      this.startPromise = undefined
    }
  }

  async request<TCommand extends IpcCommand>(
    command: TCommand,
    payload: IpcCommandPayloads[TCommand],
    expectedDatasetId?: string,
    read?: { signal?: AbortSignal; deadlineAtMs?: number; cacheMode?: 'reload'; trace?: { rendererReadId: string } },
  ): Promise<IpcCommandResults[TCommand]> {
    const route = this.startupAttempt
    const result = await this.sendRequest(command, payload, false, expectedDatasetId, undefined, read)
    if (command.startsWith('playback.')) {
      if (!route || !this.isCurrentRoute(route) || this._status !== 'ready') throw new CoreIpcError('NOT_READY', 'Core 播放回执路由已撤销')
      if (route.playbackEvents && result && typeof result === 'object' && 'stream' in result) {
        const stream = result.stream as import('@music-bridge/contracts').PlaybackStreamStamp | undefined
        if (stream && stream.coreInstanceId !== route.playbackEvents.coreInstanceId) throw new CoreIpcError('INVALID_IPC_RESPONSE', 'Core 播放回执身份无效')
      }
    }
    return result as IpcCommandResults[TCommand]
  }

  async requestInternal<TCommand extends IpcInternalCommand>(
    command: TCommand,
    payload: IpcCommandPayloads[TCommand],
    expectedDatasetId?: string,
  ): Promise<IpcInternalCommandResults[TCommand]> {
    return (await this.sendRequest(command, payload, true, expectedDatasetId)) as IpcInternalCommandResults[TCommand]
  }

  private async sendRequest<TCommand extends IpcCommand>(
    command: TCommand,
    payload: IpcCommandPayloads[TCommand],
    internal: boolean,
    expectedDatasetId?: string,
    startup?: StartupAttempt,
    read?: { signal?: AbortSignal; deadlineAtMs?: number; cacheMode?: 'reload'; trace?: { rendererReadId: string } },
    accept?: (value: unknown) => void,
    closing?: Readonly<{ child: CoreChildProcess; port: CoreMessagePort; generation: number }>,
  ): Promise<unknown> {
    if (read && !isLibraryReadCommand(command)) throw new CoreIpcError('INVALID_IPC_REQUEST', '写命令不能使用读取取消协议')
    if (read?.deadlineAtMs !== undefined && (!Number.isSafeInteger(read.deadlineAtMs) || read.deadlineAtMs <= 0)) throw new CoreIpcError('INVALID_IPC_REQUEST', '读取期限无效')
    if (read?.cacheMode !== undefined && read.cacheMode !== 'reload') throw new CoreIpcError('INVALID_IPC_REQUEST', '读取刷新意图无效')
    if (read?.signal?.aborted) throw new CoreIpcError('CANCELLED', '读取已取消')
    // 关闭只复用被撤销前的原进程与端口；启动恢复未完成也须能请求其真实收口。
    const closingCurrent = (): boolean => closing !== undefined && command === 'core.shutdown' && !internal
      && startup === undefined && read === undefined && accept === undefined && expectedDatasetId === undefined
      && this.shuttingDown && closing.child === this.child && closing.port === this.port && closing.generation === this.startupGeneration
    const permitted = closing ? closingCurrent() : startup
      ? startup.valid && startup.readyReceived && startup.generation === this.startupGeneration && this.startupAttempt === startup && this.child === startup.child && this.port === startup.port && !this.shuttingDown
      : this._status === 'ready'
    if (!permitted || !this.port) {
      throw new CoreIpcError('NOT_READY', 'Core is not ready')
    }
    const id = randomUUID()
    const emitRead = (stage: string, fields: Record<string, unknown> = {}): void => {
      if (isLibraryReadCommand(command)) emitLibraryReadTrace(this.options.libraryReadTrace, { stage, command, coreReadId: id, ...(read?.trace ? { rendererReadId: read.trace.rendererReadId } : {}), ...fields })
    }
    const recorder = this.options.performance
    let parent: import('@music-bridge/contracts').PerformanceTraceContext | undefined
    if (recorder?.isEnabled()) {
      try { parent = this.options.performanceContext?.() } catch { /* 诊断回调不得阻止业务请求。 */ }
    }
    const traceContext = recorder?.context(parent ? { traceId: parent.traceId, requestId: id, parentRequestId: parent.requestId } : { requestId: id })
    const performanceSpan = recorder?.start('ipc', traceContext, {}, { command })
    const timedCommand = command === 'commandOutbox.execute' && 'command' in payload ? String(payload.command) : command
    const timeoutMs =
      ['recordingReplica.inspect', 'recordingOutput.check', 'recordingPlans.preview', 'recordingPlans.freeze', 'recordingPlans.preflight', 'recordingArchive.preview', 'recordingArchive.start', 'recordingArchive.verify', 'recordingArchive.initialize', 'recordingExecution.preview', 'recordingExecution.start', 'recordingExecution.verify', 'recordingPrepared.previewImport', 'recordingPrepared.startImport', 'recordingPrepared.review', 'recordingPrepared.freeze', 'recordingPreparationZip.preview', 'recordingPreparationZip.start'].includes(timedCommand)
      ? PREPARED_FILE_REQUEST_TIMEOUT_MS
      : command === 'localCatalog.prepare' || command.startsWith('playback.') || command === 'roon.library.play' || command === 'roon.library.queue'
        ? PLAYBACK_REQUEST_TIMEOUT_MS
      : command.startsWith('library.') ||
      command.startsWith('roon.library.') ||
      command.startsWith('roon.transport.')
      ? LIBRARY_REQUEST_TIMEOUT_MS
      : this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    const deadlineAtMs = isLibraryReadCommand(command) ? Math.min(Date.now() + timeoutMs, read?.deadlineAtMs ?? Infinity) : undefined
    if (deadlineAtMs !== undefined && deadlineAtMs <= Date.now()) { performanceSpan?.end('cancelled'); throw new CoreIpcError('TIMEOUT', '读取期限已到') }
    const request = { version: IPC_VERSION, id, command, payload, ...(deadlineAtMs === undefined ? {} : { readContext: { deadlineAtMs, ...(read?.cacheMode !== undefined ? { cacheMode: read.cacheMode } : {}) } }), ...(expectedDatasetId === undefined ? {} : { expectedDatasetId }), ...(traceContext ? { performanceTrace: traceContext } : {}) }
    const validated = internal ? validateIpcInternalRequest(request) : validateIpcRequest(request)
    if (!validated.ok) {
      performanceSpan?.end('error')
      throw new CoreIpcError(validated.error.code, validated.error.message)
    }
    const port = closing?.port ?? this.port
    const cancelCoreRead = (): void => { if (deadlineAtMs !== undefined) { try { port?.postMessage({ version: IPC_VERSION, kind: 'library.read.cancel', id }) } catch { /* 已退出的 Core 不再有存活读取。 */ } } }
    const response = await new Promise<unknown>((resolve, reject) => {
      const abort = (): void => {
        const pending = this.pending.get(id)
        if (!pending) return
        clearTimeout(pending.timer); this.removePending(id); cancelCoreRead()
        performanceSpan?.cancel(); performanceSpan?.end('cancelled')
        const failure = libraryReadTraceFailure(read?.signal?.reason)
        emitRead('main.cancel', { outcome: 'cancelled', reason: failure.reason ?? 'main-signal' })
        reject(Object.assign(new CoreIpcError('CANCELLED', '读取已取消'), { libraryReadSource: failure.reason ?? 'main-signal' }))
      }
      const timer = setTimeout(() => {
        this.removePending(id)
        cancelCoreRead()
        performanceSpan?.cancel()
        performanceSpan?.end('cancelled')
        emitRead('main.cancel', { outcome: 'timeout', reason: 'main-deadline' })
        reject(new CoreIpcError('TIMEOUT', 'Core request timed out'))
      }, deadlineAtMs === undefined ? timeoutMs : Math.max(1, deadlineAtMs - Date.now()))
      read?.signal?.addEventListener('abort', abort, { once: true })
      this.pending.set(id, { command, internal, timer, resolve, reject, ...(read?.trace ? { rendererReadId: read.trace.rendererReadId } : {}), ...(accept ? { accept } : {}), ...(deadlineAtMs === undefined ? {} : { readDeadlineAtMs: deadlineAtMs, cancelCoreRead }), ...(read?.signal ? { detachReadAbort: () => read.signal?.removeEventListener('abort', abort) } : {}), ...(performanceSpan ? { performanceSpan } : {}) })
      recorder?.setGauge('activeRequestCount', this.pending.size)
      try {
        if (closing && !closingCurrent()) {
          clearTimeout(timer); this.removePending(id); performanceSpan?.end('error')
          reject(new CoreIpcError('NOT_READY', '关闭时原 Core 路由已变化'))
          return
        }
        if (read?.signal?.aborted) { abort(); return }
        emitRead('main.dispatch')
        port?.postMessage(request)
      } catch {
        clearTimeout(timer)
        this.removePending(id)
        performanceSpan?.end('error')
        reject(new CoreIpcError('INTERNAL_ERROR', 'Core request could not be sent'))
      }
    })
    return response
  }

  async shutdown(): Promise<void> {
    this.lifecycleRequestGeneration += 1
    return this.closeCurrentCore()
  }

  private async closeCurrentCore(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    const work = this.shutdownInternal()
    this.shutdownPromise = work
    try { await work }
    catch (error) { if (this.shutdownPromise === work) this.shutdownPromise = undefined; throw error }
  }

  async restart(env?: NodeJS.ProcessEnv, options?: { readyTimeoutMs?: number }): Promise<void> {
    const timeout = options?.readyTimeoutMs
    if (timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > RESTORE_ACTIVATION_TIMEOUT_MS)) {
      throw new CoreIpcError('INVALID_IPC_REQUEST', 'Core 重启等待期限无效')
    }
    if (this.manualRestartPromise) return this.manualRestartPromise
    const requestGeneration = ++this.lifecycleRequestGeneration
    const restart = (async (): Promise<void> => {
      // 重启自有的关闭复用原工作，不新造一次会撤销自身的公开停止请求。
      await this.closeCurrentCore()
      if (this.lifecycleRequestGeneration !== requestGeneration) throw new CoreIpcError('NOT_READY', 'Core 重启已被后续关闭或重启请求撤销')
      if (env) this.options.env = { ...env }
      this.shutdownPromise = undefined
      this.shuttingDown = false
      this._status = 'stopped'
      this.readyTimeoutOverride = timeout
      try { await this.start() }
      finally { this.readyTimeoutOverride = undefined }
    })()
    this.manualRestartPromise = restart
    try {
      await restart
    } finally {
      if (this.manualRestartPromise === restart) this.manualRestartPromise = undefined
    }
  }

  /** 显式激活只复制并切换收藏工作库；账号恢复仍由既有 onReady 安全通道处理。 */
  async activateRestoredDataset(request: ActivateRestoredDataset, expectedDatasetId?: string): Promise<RestoreActivationView> {
    if (!isActivateRestoredDataset(request)) throw new CoreIpcError('INVALID_IPC_REQUEST', '激活必须明确确认停止播放和切换工作库')
    if (this.activationFlight) {
      const prior = this.activationFlight.request
      if (this.activationFlight.expectedDatasetId !== expectedDatasetId || prior.commandId !== request.commandId || prior.restoreJobId !== request.restoreJobId || prior.expectedActiveId !== request.expectedActiveId) {
        throw new CoreIpcError('INVENTORY_CONFLICT', '已有工作库切换正在处理')
      }
      return this.activationFlight.promise
    }
    const accepted = { ...request }
    const promise = this.activateRestoredDatasetInternal(accepted, expectedDatasetId)
    this.activationFlight = { request: accepted, expectedDatasetId, promise }
    try { return await promise }
    finally { if (this.activationFlight?.promise === promise) this.activationFlight = undefined }
  }

  private async activateRestoredDatasetInternal(request: ActivateRestoredDataset, expectedDatasetId?: string): Promise<RestoreActivationView> {
    const deadline = Date.now() + RESTORE_ACTIVATION_TIMEOUT_MS
    let result = await this.request('recordingBackups.activate', request, expectedDatasetId)
    const activationId = result.id
    if (result.restoreJobId !== request.restoreJobId) throw new CoreIpcError('INVENTORY_CONFLICT', '激活回执与请求的恢复任务不一致')
    const current = async (): Promise<RestoreActivationView> => {
      const view = (await this.request('recordingBackups.overview', {})).activations.find(item => item.id === activationId)
      if (!view || view.restoreJobId !== request.restoreJobId) throw new CoreIpcError('INVENTORY_CONFLICT', '激活回执与当前维护记录不一致')
      return view
    }
    while (result.state === 'preparing' || result.state === 'activating') {
      if (Date.now() >= deadline) throw new CoreIpcError('TIMEOUT', '激活准备超时；请刷新状态，不会自动重试')
      result = await current()
      if (result.state === 'preparing' || result.state === 'activating') await this.delay(250)
    }
    // 失回执重试直接返回持久终态；失败和回滚不再触发停止或重启。
    if (result.state !== 'prepared') return result
    await this.request('playback.stop', {})
    await this.restart(undefined, { readyTimeoutMs: RESTORE_ACTIVATION_TIMEOUT_MS })
    result = await current()
    if (result.state !== 'active' && result.state !== 'rolled-back') {
      throw new CoreIpcError('NOT_READY', 'Core 已重启，但尚未取得工作库切换终态')
    }
    return result
  }

  private async startWithOneRetry(): Promise<void> {
    const requestGeneration = this.lifecycleRequestGeneration
    const sameIntent = () => !this.shuttingDown && this.lifecycleRequestGeneration === requestGeneration
    this.restartCount = 0
    this._status = 'starting'
    while (true) {
      if (!sameIntent()) throw new CoreIpcError('NOT_READY', 'Core 启动已被后续关闭或重启请求撤销')
      try {
        await this.spawnAndAwaitReady()
        if (!sameIntent()) throw new CoreIpcError('NOT_READY', 'Core 启动已被后续关闭或重启请求撤销')
        this._status = 'ready'
        return
      } catch (error) {
        if (!sameIntent()) throw error
        // 启动超时或恢复 hook 失败后，旧 Core 必须确实退出才能试第二次。
        // 仅 kill() 返回不代表旧进程停止写库。
        if (this.childExit) {
          const exited = await this.exitWithin(this.childExit.promise, 250)
          if (!sameIntent()) throw error
          if (!exited) {
            this._status = 'failed'
            this.options.onLifecycle?.({ event: 'failed' })
            throw new CoreIpcError('NOT_READY', '旧 Core 未确认退出，禁止启动新进程')
          }
        }
        if (this.restartCount >= 1) {
          this._status = 'failed'
          this.options.onLifecycle?.({ event: 'failed' })
          throw error
        }
        this.restartCount += 1
        this._status = 'starting'
      }
    }
  }

  private spawnAndAwaitReady(): Promise<void> {
    const channel = this.options.dependencies.createChannel()
    const sourceChannel = this.options.sourceWritesPort ? this.options.dependencies.createSourceWritesChannel?.() : undefined
    if (this.options.sourceWritesPort && !sourceChannel) { channel.port2.close(); channel.port1.close(); throw new CoreIpcError('NOT_READY', '缺少可信 Main 源写专用通道。') }
    const relocationChannel = this.options.relocationMainPort ? this.options.dependencies.createRelocationChannel?.() : undefined
    const relocationPortSet = relocationChannel ? [channel.port1, channel.port2, ...(sourceChannel ? [sourceChannel.port1, sourceChannel.port2] : []), relocationChannel.port1, relocationChannel.port2] : []
    if (this.options.relocationMainPort && (!relocationChannel || new Set(relocationPortSet).size !== relocationPortSet.length)) {
      channel.port2.close(); channel.port1.close(); sourceChannel?.port1.close(); sourceChannel?.port2.close(); relocationChannel?.port1.close(); relocationChannel?.port2.close()
      throw new CoreIpcError('NOT_READY', '缺少独立可信Main搬迁专用通道。')
    }
    let child: CoreChildProcess
    try {
      child = this.options.dependencies.fork(
        this.options.entryPath,
        [],
        {
          cwd: this.options.cwd,
          env: { ...(this.options.env ?? {}) },
          stdio: 'pipe',
          serviceName: 'Music Bridge Core',
        },
      )
    } catch (failure) {
      channel.port1.close(); channel.port2.close(); sourceChannel?.port1.close(); sourceChannel?.port2.close(); relocationChannel?.port1.close(); relocationChannel?.port2.close()
      throw failure
    }
    const consumeLocalAlbum = createLocalAlbumSafeTraceReader(collectLocalAlbumSafeTrace)
    const consumeArtwork = createDesktopArtworkReader(row => { if (this.child === child) collectDesktopArtwork(row) })
    const consumeMobileCapability = createMobileCapabilityTraceReader(row => { if (this.child === child) collectMobileCapabilityTrace(row) })
    const writeLocalPlaybackGuard = this.options.dependencies.writeLocalPlaybackGuard ?? writeLocalPlaybackGuardSync
    const forwardLocalPlaybackGuard: LocalPlaybackGuardSink = row => {
      if (this.child !== child) return false
      writeLocalPlaybackGuard(row)
      return true
    }
    child.stdout?.on('data', chunk => { try { const text = chunk.toString(); consumeMobileCapability(text); consumeLocalAlbum(text); consumeArtwork(text); this.localPlaybackEvidence.consume(text,forwardLocalPlaybackGuard) } catch { /* 只消费闭schema行，不转发原stdout。 */ } })
    if (!this.options.libraryReadTrace) child.stderr?.on('data', () => { /* 消费原stderr以避免反压，不转发。 */ })
    if (this.options.libraryReadTrace) {
      const consume = createLibraryReadTraceStreamReader(this.options.libraryReadTrace)
      child.stdout?.on('data', chunk => { try { consume(chunk.toString()) } catch { /* 只允许封闭诊断行进入父终端。 */ } })
      const consumePlaybackFailure = createPlaybackFailureTraceStreamReader(line => { process.stderr.write(line) })
      child.stderr?.on('data', chunk => { try { consumePlaybackFailure(String(chunk)) } catch { /* 其他 SDK 输出和错误栈只消费、不转发。 */ } })
    }
    this.child = child
    this.port = channel.port2
    this.sourceWritesPort = sourceChannel?.port2
    this.sourceWritesSequence = 0
    this.readersSequence=0;this.readersAuthorityId=undefined;
    this.directorySequence=0;this.directoryAuthorityId=undefined;this.directoryRegistrationSequence=0;this.lyricsVerifySequence = 0; this.lyricsGrantSequence = 0; this.lyricsGrantAuthorityId = undefined; this.lyricsProviderSequence = 0; this.nameProviderSequence = 0
    this.relocationMainPort = relocationChannel?.port2
    this.relocationSequence = 0
    this._status = 'starting'
    this.options.onLifecycle?.({ event: 'spawn' })
    let confirmExit: () => void = () => undefined
    const exited = new Promise<void>(resolve => { confirmExit = resolve })
    this.childExit = { child, promise: exited }

    let settled = false
    let readyReceived = false
    let resolveReady: () => void = () => undefined
    let rejectReady: (error: CoreIpcError) => void = () => undefined
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    this.workbenchSequence=0;this.workbenchAuthorFlight=undefined;this.albumArtworkSequence=0;
    const attempt: StartupAttempt = {
      generation: ++this.startupGeneration, child, port: channel.port2, valid: true, readyReceived: false, playbackEvents: null,
      cancelStart: error => {
        clearTimeout(readyTimer)
        attempt.valid = false
        if (!settled) { settled = true; rejectReady(error) }
      },
    }
    this.startupAttempt = attempt
    let completedReady = false
    let portsTransferred = false
    const failStart = (error: CoreIpcError): void => {
      if (settled) return
      attempt.cancelStart(error)
      if (!portsTransferred) { channel.port1.close(); sourceChannel?.port1.close() }
      channel.port2.close()
      this.closeSourceWrites(sourceChannel?.port2)
      this.closeRelocation(relocationChannel?.port2)
      if (this.child === child) {
        this.port = undefined
        this.rejectPending(error)
      }
      try { child.kill() } catch { /* 启动已失败，不能让清理异常逸出计时器。 */ }
    }
    const readyTimer = setTimeout(() => {
      failStart(new CoreIpcError('TIMEOUT', 'Core 启动与恢复等待超时'))
    }, this.readyTimeoutOverride ?? this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS)
    const startupClient: CoreStartupClient = {
      get playbackEvents() { return attempt.playbackEvents },
      request: <C extends IpcCommand>(command: C, payload: IpcCommandPayloads[C], expectedDatasetId?: string) => this.sendRequest(command, payload, false, expectedDatasetId, attempt) as Promise<IpcCommandResults[C]>,
      requestInternal: <C extends IpcInternalCommand>(command: C, payload: IpcCommandPayloads[C], expectedDatasetId?: string) => this.sendRequest(command, payload, true, expectedDatasetId, attempt) as Promise<IpcInternalCommandResults[C]>,
    }
    const requestedProtocol = this.options.playbackEventProtocol === null || this.options.env?.MUSIC_BRIDGE_COMPACT_PLAYBACK_EVENTS === '0' ? undefined : 'compact-v1'
    const commitReady = (message: TypedIpcEvent, seed?: PlaybackStreamSnapshot): void => {
      if (settled || !this.isCurrentRoute(attempt)) throw new CoreIpcError('NOT_READY', 'Core 启动路由已撤销')
      this._status = 'ready'
      // 回调可同步shutdown/restart；每次广播前重核，不能续发旧seed。
      this.options.onLifecycle?.({ event: 'ready' })
      if (!this.isCurrentRoute(attempt)) throw new CoreIpcError('NOT_READY', 'Core 启动路由已撤销')
      this.options.onEvent?.(message)
      if (!this.isCurrentRoute(attempt)) throw new CoreIpcError('NOT_READY', 'Core 启动路由已撤销')
      if (seed) this.options.onEvent?.({ version: IPC_VERSION, event: 'playback.snapshot', payload: seed })
      if (!this.isCurrentRoute(attempt)) throw new CoreIpcError('NOT_READY', 'Core 启动路由已撤销')
      settled = true
      completedReady = true
      clearTimeout(readyTimer)
      resolveReady()
    }

    const handleExit = (code: number): void => {
      confirmExit()
      if (this.childExit?.child === child) this.childExit = undefined
      clearTimeout(readyTimer)
      attempt.valid = false
      if (this.child !== child) return
      this.options.onLifecycle?.({ event: 'exit', code })
      this.child = undefined
      this.port = undefined
      channel.port2.close()
      this.closeSourceWrites(sourceChannel?.port2)
      this.closeRelocation(relocationChannel?.port2)
      this.closeMobileContentPending(true)
      this.rejectPending(new CoreIpcError('INTERNAL_ERROR', 'Core process exited'), true)
      if (!settled) {
        settled = true
        rejectReady(
          new CoreIpcError('INTERNAL_ERROR', code === 0 ? 'Core stopped before ready' : 'Core crashed'),
        )
      }
      if (completedReady && !this.shuttingDown && !this.restartPromise) {
        this.restartPromise = this.restartAfterCrash(attempt)
        void this.restartPromise.finally(() => {
          this.restartPromise = undefined
        })
      }
    }

    child.once('exit', handleExit)
    channel.port2.on('message', (event) => {
      if (this.child !== child || this.port !== channel.port2) return
      if(event.data&&typeof event.data==='object'&&['local-album-artwork-main-request','local-album-artwork-main-cancel'].includes(String(Object.getOwnPropertyDescriptor(event.data,'type')?.value))){
        try{const ports=Object.getOwnPropertyDescriptor(event,'ports')?.value;if(ports!==undefined&&(!Array.isArray(ports)||ports.length!==0))throw new CoreIpcError('INVALID_IPC_RESPONSE','封面来源不得转移端口');this.receiveLocalAlbumArtwork(event.data,attempt)}catch{this.failLocalAlbumArtworkRoute(attempt)}
        return
      }
      if (event.data && typeof event.data === 'object' && Object.getOwnPropertyDescriptor(event.data, 'type')?.value === 'musicbridge.lyrics.provider-request') {
        try {
          const ports = Object.getOwnPropertyDescriptor(event, 'ports')?.value
          if (ports !== undefined && (!Array.isArray(ports) || ports.length !== 0)) throw new CoreIpcError('INVALID_IPC_RESPONSE', '歌词来源消息不得转移端口')
          this.receiveLyricsProvider(event.data, attempt)
        } catch { this.failLyricsProviderRoute(attempt) }
        return
      }
      if (event.data && typeof event.data === 'object' && Object.getOwnPropertyDescriptor(event.data, 'type')?.value === 'musicbridge.name.provider-request') {
        try {
          const ports=Object.getOwnPropertyDescriptor(event,'ports')?.value
          if(ports!==undefined&&(!Array.isArray(ports)||ports.length!==0))throw new CoreIpcError('INVALID_IPC_RESPONSE','名称来源消息不得转移端口')
          this.receiveNameProvider(event.data,attempt)
        }catch{this.failNameProviderRoute(attempt)}
        return
      }
      if(event.data&&typeof event.data==='object'&&Object.getOwnPropertyDescriptor(event.data,'type')?.value==='musicbridge.workbench.frame'){this.workbenchReceive(event.data,attempt);return;}
      if (event.data && typeof event.data === 'object' && Object.getOwnPropertyDescriptor(event.data,'type')?.value==='local-album-main-response') {
        const id=Object.getOwnPropertyDescriptor(event.data,'id')?.value, entry=typeof id==='string'?this.localAlbumPending.get(id):undefined
        if (!entry || entry.generation!==attempt.generation || entry.port!==channel.port2) return
        clearTimeout(entry.timer);this.localAlbumPending.delete(entry.call.id)
        withLocalAlbumContext(entry.trace, () => {
          localAlbumPhase('supervisor.response')
          if (!attempt.valid || this.shuttingDown || !this.isCurrentRoute(attempt) || this._status!=='ready') { localAlbumMatch('route', false); entry.reject(new CoreIpcError('NOT_READY','原本地专辑读取路由已撤销')); }
          else { localAlbumMatch('route', true); localAlbumPhase('supervisor.dto'); const responseValid = isLocalAlbumMainResponse(event.data,entry.call); localAlbumMatch('dto', responseValid);
            if (!responseValid) entry.reject(new CoreIpcError('INVALID_IPC_RESPONSE','本地专辑原读取结果身份无效')); else entry.resolve(structuredClone(event.data as LocalAlbumMainResponse)); }
        })
        return
      }
      if (event.data && typeof event.data === 'object' && Object.getOwnPropertyDescriptor(event.data, 'type')?.value === 'mobile-content-core-response') {
        const id = Object.getOwnPropertyDescriptor(event.data, 'id')?.value;
        const pending = typeof id === 'string' ? this.mobileContentPending.get(id) : undefined;
        if (!pending || pending.generation !== attempt.generation) return;
        try {
          const response = captureMobileContentCoreResponse(event.data, pending.call);
          const unknown = 'kind' in response && response.kind === 'error' && response.outcome === 'unknown';
          if (!unknown) this.settleMobileContent(pending.call.id, 'kind' in response && response.kind === 'error', response);
          if (response.action === 'cancel' && 'kind' in response && response.kind === 'cancelled') {
            const original = this.mobileContentPending.get(response.requestId);
            if (original?.generation === attempt.generation) {
              original.reject(new MobileAuthPersistenceError('unknown')); this.settleMobileContent(response.requestId, true, { code: 'ABORTED' });
            }
          }
          if (response.action === 'invalidate-device' && 'ok' in response && response.ok === true && pending.call.action === 'invalidate-device') {
            const revoked = pending.call;
            for (const [originalId, original] of this.mobileContentPending) {
              const input = original.call;
              const principal = input.action === 'scope' ? input.principal : 'scope' in input ? input.scope : null;
              if (principal && original.generation === attempt.generation && principal.serverId === revoked.serverId
                && principal.datasetId === revoked.datasetId && principal.deviceId === revoked.deviceId && principal.deviceEpoch === revoked.deviceEpoch) {
                original.reject(new MobileAuthPersistenceError('unknown')); this.settleMobileContent(originalId, true, { code: 'DEVICE_REVOKED' });
              }
            }
          }
          if (!attempt.valid || this.shuttingDown) pending.reject(new MobileAuthPersistenceError('unknown'));
          else pending.resolve(response);
        } catch { pending.rangeTransport?.malformed(); pending.reject(new MobileAuthPersistenceError('unknown')); }
        return;
      }
      if (event.data && typeof event.data === 'object' && Object.getOwnPropertyDescriptor(event.data, 'type')?.value === 'mobile-main-response') {
        const id = Object.getOwnPropertyDescriptor(event.data, 'id')?.value
        const pending = typeof id === 'string' ? this.mobilePending.get(id) : undefined
        if (!pending) return
        clearTimeout(pending.timer); this.mobilePending.delete(id)
        const reply = attempt.valid && !this.shuttingDown ? captureMobileCorePrivateReply(event.data, pending.call) : null
        if (!reply) pending.reject(new MobileAuthPersistenceError('unknown'))
        else pending.resolve(reply.result)
        return
      }
      const parsed = parseIpcRuntimeMessage(event.data)
      if (!parsed.ok) return
      const message = parsed.value
      if ('event' in message) {
        if (!attempt.valid) return
        if (message.event === 'core.ready') {
          if (!settled && !readyReceived) {
            const ack = message.payload.playbackEvents
            if (ack && !requestedProtocol) { failStart(new CoreIpcError('INVALID_IPC_RESPONSE', 'Core 未经请求启用播放流协议')); return }
            attempt.playbackEvents = ack ?? null
            readyReceived = true
            attempt.readyReceived = true
            void Promise.resolve().then(() => {
              if (!attempt.valid || settled || this.shuttingDown) return
              return this.options.onReady?.(startupClient)
            }).then(
              () => {
                if (settled || !attempt.valid || this.child !== child || this.shuttingDown) return
                if (!attempt.playbackEvents) { commitReady(message); return }
                // 专用响应处理器在reply调用栈提交；Promise续体只处理失败。
                void this.sendRequest('playback.getStreamSnapshot', {}, false, undefined, attempt, undefined, value => {
                  const seed = value as PlaybackStreamSnapshot | null
                  this.assertStreamSnapshot(seed, attempt)
                  commitReady(message, seed)
                }).catch(error => failStart(error instanceof CoreIpcError ? error : new CoreIpcError('INTERNAL_ERROR', 'Core 启动恢复未完成')))
              },
              () => failStart(new CoreIpcError('INTERNAL_ERROR', 'Core 启动恢复未完成')),
            ).catch(error => failStart(error instanceof CoreIpcError ? error : new CoreIpcError('INTERNAL_ERROR', 'Core 启动恢复未完成')))
          }
          return
        }
        // Core自己的ready不等于Main恢复完成；不把早到health转发成UI就绪。
        if (message.event === 'core.health' && !completedReady) return
        if (message.event === 'playback.snapshot' || message.event === 'playback.state' || message.event === 'playback.progress') {
          if (!completedReady || message.payload.stamp.coreInstanceId !== attempt.playbackEvents?.coreInstanceId) return
        }
        if (attempt.playbackEvents && (message.event === 'playback.changed' || message.event === 'queue.changed')) return
        this.options.onEvent?.(message)
        return
      }
      const pending = this.pending.get(message.id)
      if (!pending) return
      if (pending.readDeadlineAtMs !== undefined && Date.now() >= pending.readDeadlineAtMs) {
        clearTimeout(pending.timer)
        this.removePending(message.id)
        pending.cancelCoreRead?.()
        pending.performanceSpan?.cancel()
        pending.performanceSpan?.end('cancelled')
        pending.reject(new CoreIpcError('TIMEOUT', '读取期限已到'))
        return
      }
      const response = pending.internal
        ? validateIpcInternalResponseForCommand(
            message,
            pending.command as IpcInternalCommand,
          )
        : validateIpcResponseForCommand(message, pending.command)
      if (!response.ok) {
        clearTimeout(pending.timer)
        this.removePending(message.id)
        pending.performanceSpan?.end('error')
        pending.reject(new CoreIpcError(response.error.code, response.error.message))
        return
      }
      clearTimeout(pending.timer)
      this.removePending(message.id)
      pending.performanceSpan?.end(response.value.ok ? 'ok' : 'error')
      if (isLibraryReadCommand(pending.command)) emitLibraryReadTrace(this.options.libraryReadTrace, { stage: 'main.response', command: pending.command, coreReadId: message.id,
        ...(pending.rendererReadId ? { rendererReadId: pending.rendererReadId } : {}), ...(response.value.ok ? { outcome: 'ok' } : { ...libraryReadTraceFailure(response.value.error), reason: 'upstream-response' }) })
      if (response.value.ok) {
        try { pending.accept?.(response.value.result); pending.resolve(response.value.result) }
        catch (error) { pending.reject(error instanceof CoreIpcError ? error : new CoreIpcError('INTERNAL_ERROR', 'Core 启动恢复未完成')) }
      } else {
        pending.reject(new CoreIpcError(response.value.error.code, response.value.error.message))
      }
    })
    channel.port2.start()
    if (sourceChannel) {
      sourceChannel.port2.on('message', event => {
        if (this.child !== child || this.sourceWritesPort !== sourceChannel.port2) return
        try {
          const transferred = Object.getOwnPropertyDescriptor(event, 'ports')?.value
          if (transferred !== undefined && (!Array.isArray(transferred) || transferred.length !== 0)) throw new Error('源写专用回声不能转移额外物理端口')
          if(isSourceWorkbenchReadersWire(event.data,'request')){this.receiveWorkbenchReaders(event.data,sourceChannel.port2,attempt);return}
          if (isSourceWritesLyricsGrantWire(event.data, 'request')) { this.receiveLyricsGrant(event.data, sourceChannel.port2, attempt); return }
          if(isSourceWorkbenchDirectoryWire(event.data,'request')){this.receiveWorkbenchDirectory(event.data,sourceChannel.port2,attempt);return}
          if(isSourceWorkbenchDirectoryWire(event.data,'registration-reply')){
            const r=captureSourceWorkbenchDirectoryRegistrationReply(event.data),p=this.directoryPending.get(r.requestId);if(!p||p.port!==sourceChannel.port2||p.route!==attempt)throw new CoreIpcError('INVALID_IPC_RESPONSE','目录回包没有原登记请求');assertSourceWorkbenchDirectoryRegistrationReplyForRequest(r,p.request);if(Date.now()>=p.request.expiresAtMs)throw new CoreIpcError('TIMEOUT','目录原回包已迟到');clearTimeout(p.timer);p.detach();this.directoryPending.delete(r.requestId);p.resolve(r);return
          }
          if (isSourceWritesLyricsVerifyWire(event.data, 'reply')) {
            const reply = captureSourceWritesLyricsVerifyReply(event.data), pending = this.lyricsVerifyPending.get(reply.requestId)
            const binding = attempt.workbenchBinding
            const originalDrain = this.shuttingDown && pending !== undefined && binding !== undefined
              && this.startupAttempt === attempt && attempt.generation === this.startupGeneration && this.child === attempt.child && this.port === attempt.port && this.sourceWritesPort === sourceChannel.port2
              && binding.authorityRef === attempt && binding.childGeneration === attempt.generation && binding.datasetId === pending.request.datasetId && binding.ownerEpoch === pending.request.epoch
              && this.lyricsGrantAuthorityId === pending.request.grantRequest.authorityId && (this.directoryAuthorityId === undefined || this.directoryAuthorityId === pending.request.grantRequest.authorityId)
            // 只消费关闭前原已受理的核验回声；末尾作者失权仍由原verify flight语义拒绝。
            if (!pending || pending.port !== sourceChannel.port2 || pending.route !== attempt || (!this.isCurrentRoute(attempt) || this._status !== 'ready') && !originalDrain) throw new Error('原歌词核验回声不是当前物理请求')
            assertSourceWritesLyricsVerifyReplyForRequest(reply, pending.request)
            clearTimeout(pending.timer); pending.signal.removeEventListener('abort', pending.abort); this.lyricsVerifyPending.delete(reply.requestId)
            if (pending.expired || pending.signal.aborted || Date.now() >= pending.request.grantRequest.expiresAtMs || performance.now() >= pending.deadlineAtMs) {
              pending.reject(new CoreIpcError('TIMEOUT', '原歌词核验回执已迟到，不会继续授权')); return
            }
            pending.resolve(reply); return
          }
          const captured = localSourceWritesDataSnapshot(event.data, 16384)
          if (!localSourceWritesRecord(captured, ['version', 'type', 'requestId', 'sequence', 'ok'], ['result', 'failure']) || typeof captured.requestId !== 'string') throw new Error('源写私有回执无效。')
          const pending = this.sourceWritesPending.get(captured.requestId)
          if (!pending) return
          const response = localSourceWritesMainResponseSnapshot(captured, pending.command)
          if (response.sequence !== pending.sequence) throw new Error('源写私有回执序号无效。')
          clearTimeout(pending.timer); this.sourceWritesPending.delete(response.requestId)
          if (response.ok) pending.resolve(response.result)
          else pending.reject(new CoreIpcError(response.failure.error.code, response.failure.error.message))
        } catch { this.closeSourceWrites(sourceChannel.port2) }
      })
      sourceChannel.port2.start()
    }
    if (relocationChannel) {
      for (const event of ['close', 'messageerror'] as const) relocationChannel.port2.on(event, () => { if (this.relocationMainPort === relocationChannel.port2) this.closeRelocation(relocationChannel.port2) })
      relocationChannel.port2.on('message', event => {
        if (this.child !== child || this.relocationMainPort !== relocationChannel.port2) return
        try {
          const captured = localRelocationDataSnapshot(event.data, { maxBytes: 16_384, maxTextBytes: 16_384 })
          if (!localRelocationRecord(captured, ['version', 'type', 'requestId', 'sequence', 'ok'], ['result', 'failure']) || typeof captured.requestId !== 'string') throw new Error('搬迁私有回执无效。')
          const pending = this.relocationPending.get(captured.requestId)
          if (!pending) return
          const response = localRelocationMainResponseSnapshot(captured, pending.command)
          if (response.sequence !== pending.sequence) throw new Error('搬迁私有回执序号无效。')
          clearTimeout(pending.timer); this.relocationPending.delete(response.requestId)
          if (response.ok) pending.resolve(response.result)
          else pending.reject(new CoreIpcError(response.failure.error.code, response.failure.error.message))
        } catch { this.closeRelocation(relocationChannel.port2) }
      })
      relocationChannel.port2.start()
    }
    try {
      child.postMessage({ type: 'musicbridge.core.port', ...(this.workbenchNativeConfiguration ? { localWorkbenchNative: this.workbenchNativeConfiguration } : {}), ...(requestedProtocol ? { playbackEventProtocol: requestedProtocol } : {}), ...(relocationChannel ? { relocationMainPort: 'local-relocation-main-port-v1' } : {}) }, [channel.port1, ...(sourceChannel ? [sourceChannel.port1] : []), ...(relocationChannel ? [relocationChannel.port1] : [])])
      portsTransferred = true
    } catch {
      failStart(new CoreIpcError('INTERNAL_ERROR', 'Core process could not be started'))
    }
    return ready
  }

  private async restartAfterCrash(exited: StartupAttempt): Promise<void> {
    const requestGeneration = this.lifecycleRequestGeneration
    const sameIntent = () => !this.shuttingDown && this.lifecycleRequestGeneration === requestGeneration
    const sameExitedActor = () => this.startupAttempt === exited && this.startupGeneration === exited.generation && !exited.valid
      && this.child === undefined && this.childExit === undefined && this.port === undefined
    if (!sameIntent() || !sameExitedActor()) return
    if (this.restartCount >= 1) {
      this._status = 'failed'
      this.options.onLifecycle?.({ event: 'failed' })
      return
    }
    this.restartCount += 1
    this._status = 'starting'
    this.options.onLifecycle?.({ event: 'restart' })
    try {
      await this.joinPrivateLocalAlbumArtworkNormalizer()
      // 原exit只撤销读取；实际收尾后仍须核原actor和不可回退的停止意图，不能复活退出中的Core。
      if (!sameIntent() || !sameExitedActor()) return
      await this.spawnAndAwaitReady()
      if (!sameIntent()) return
      this._status = 'ready'
    } catch {
      if (!sameIntent()) return
      this._status = 'failed'
      this.options.onLifecycle?.({ event: 'failed' })
    }
  }

  private removePending(id: string): void {
    this.pending.get(id)?.detachReadAbort?.()
    this.pending.delete(id)
    this.options.performance?.setGauge('activeRequestCount', this.pending.size)
  }

  private rejectPending(error: CoreIpcError, physicalExit = false): void {
    this.revokeWorkbenchRequests(error,physicalExit)
    for(const flight of this.albumArtworkFlights)flight.controller.abort()
    this.closeLocalAlbumPending(error)
    this.closeMobilePending()
    this.closeMobileContentPending()
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.performanceSpan?.end('error')
      pending.reject(error)
      this.removePending(id)
    }
  }

  private async shutdownInternal(): Promise<void> {
    this.shuttingDown = true
    this.revokeWorkbenchRequests(new CoreIpcError('NOT_READY','整理主机正在关闭'))
    for(const flight of this.albumArtworkFlights)flight.controller.abort()
    this.closeLocalAlbumPending(new CoreIpcError('NOT_READY','本地专辑通道正在关闭'))
    this.closeMobilePending()
    this.closeMobileContentPending()
    this.startupAttempt?.cancelStart(new CoreIpcError('NOT_READY', 'Core supervisor is shutting down'))
    const child = this.child
    const port = this.port
    const generation = this.startupGeneration
    if (!child) {
      await this.joinPrivateLocalAlbumArtworkNormalizer()
      this._status = 'stopped'
      port?.close()
      this.closeSourceWrites()
      this.closeRelocation()
      this.options.onLifecycle?.({ event: 'stopped' })
      return
    }

    const exited = this.childExit?.child === child ? this.childExit.promise : Promise.resolve()
    try {
      if (!port) throw new CoreIpcError('NOT_READY', '原 Core 关闭端口已经撤销')
      await this.sendRequest('core.shutdown', {}, false, undefined, undefined, undefined, undefined, { child, port, generation })
    } catch (error) {
      // graceful清理失败不等于物理quiet；保留原child/port/claims，禁止按kill写成功。
      this._status = 'failed'
      this.options.onLifecycle?.({ event: 'failed' })
      throw error
    }
    await Promise.race([exited, this.delay(this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)])
    if (this.child === child) {
      child.kill()
      if (!await this.exitWithin(exited, 250)) {
        // 未见原child物理exit，保留原port以供核查，不撤claims。
        this._status = 'failed'
        this.rejectPending(new CoreIpcError('NOT_READY', '旧 Core 未确认退出'))
        throw new CoreIpcError('NOT_READY', '旧 Core 未确认退出，禁止重启或切换工作库')
      }
    }
    await this.joinPrivateLocalAlbumArtworkNormalizer()
    port?.close()
    this.closeSourceWrites()
    this.closeRelocation()
    this._status = 'stopped'
    this.options.onLifecycle?.({ event: 'stopped' })
    this.rejectPending(new CoreIpcError('NOT_READY', 'Core supervisor is stopped'))
  }

  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds))
  }

  private async exitWithin(exited: Promise<void>, milliseconds: number): Promise<boolean> {
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), milliseconds)
      void exited.then(() => { clearTimeout(timer); resolve(true) })
    })
  }
}
