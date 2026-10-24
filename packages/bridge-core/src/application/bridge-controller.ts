import { logLibraryOperation } from '../shared/library-operation-log.js';
import type { LocalFileLyricsContext } from '../lyrics/coordinator.js';
import { emptyLyricsSnapshot } from '../netease/lyrics.js';
import type { LyricsSnapshot } from '@music-bridge/contracts';
import { safeFileParameters, untestedAudioQuality } from './audio-quality-evidence.js';
import {isMBQueueNeedsReview,isMBQueueUnavailable} from '../collection/mb-queue-owner-types.js';
import { logicalQueueEntry, localQueueIdentity } from './mb-queue.js';
import { isAlbumEdition, isMBQueueEditRequest, type MBQueueRecord, type MBQueueLogicalSource, isMBEditionQueueRequest, type MBEditionQueueRequest, type MBQueueEditRequest } from '@music-bridge/contracts';
import {LocalSourcePreparationError} from './local-source-resolver.js';
import {DatasetOwnerDispatchError} from '../collection/dataset-owner-protocol.js';
import { isLocalPlayRequest, isLocalPlayTarget, type LocalPlayTarget, type LocalPlayRequest, type LocalPlayAccepted, type LocalPlaybackObservationLeaf } from '@music-bridge/contracts';
import type { DatasetOwnerEndpoint } from '../collection/dataset-owner-protocol.js';
import { LocalSourceFence } from '../stream/local-source-fence.js';
import type { LocalSourceCaptureResult } from '../collection/local-source-ticket-types.js';
import { LocalSourcePrepareInterrupted, type AssetLease, type ConfirmedLocalSession, type LocalSourcePrepareControl } from '../stream/local-file-source.js';
import { currentPerformanceContext, readPerformanceTime } from '../diagnostics/performance-trace.js';
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual, types as nodeTypes } from 'node:util';
import { isLocalAlbumQueueSnapshot, type LocalSelectionQueueSnapshot } from '../collection/local-album-browser/owner-protocol.js';
import type {
  DiagnosticResourceCounters,
  PlaybackQueueEntry,
  PlaybackQueueSnapshot,
  PlaybackIssue,
  PlaybackIssueCode,
  PlaybackQualityPreference,
  PlaybackActualQuality,
  PlaybackRecoveryAction,
  PlaybackSnapshot,
  PlaybackState,
  PlaybackResolvedSource,
  PlaybackSourcePreference,
  TrackSummary,
  RoonLibraryItem,
} from '@music-bridge/contracts';
import { MAX_PLAYBACK_QUEUE_ITEMS, roonTrackIdFromReference } from '@music-bridge/contracts';
import type { RoonPlaybackContextLease, RoonPlaybackContextItem, RoonPlaybackContextPage } from '../roon/playback-context.js';
import { BridgeError, asBridgeError } from '../shared/errors.js';
import type { Logger } from '../shared/logger.js';
import {
  normalizeTrackId,
  normalizeActualQuality,
  parseQualityPreference,
  resolveQualityPreference,
  isQualityDowngrade,
} from '../netease/policy.js';
import type {
  NeteasePort,
  QualityLevel,
  ResolvedAudioStream,
  TrackMetadata,
  TransportSecurity,
} from '../netease/types.js';
import type {
  RoonOperationOptions,
  RoonGatewayStage,
  RoonNativePlaybackState,
  RoonNowPlayingIdentity,
  RoonPlaybackObservation,
  RoonPort,
  RoonState,
  RoonTerminalReason,
  RoonTimeEvent,
} from '../roon/types.js';
import type { StreamGateway } from '../stream/gateway.js';
import type { StreamRegistry, StreamResolveRequest } from '../stream/registry.js';

export interface ActivePlayback {
  track: TrackMetadata;
  qualityPreference: PlaybackQualityPreference;
  requestedQuality: QualityLevel;
  actualQuality: PlaybackActualQuality;
  transportSecurity?: TransportSecurity;
  format?: string;
  bitrate?: number;
  sizeBytes?: number;
  startedAt: string;
}

export interface BridgeState {
  neteaseConfigured: boolean;
  roon: RoonState;
  activePlayback?: ActivePlayback;
  /** 原生 Roon 曲目仅用于内部活动状态判断，不进入公开 BridgeState。 */
  activeRoonPlayback?: TrackSummary;
  activeStreamCount: number;
}

type LocalPlaybackEvidenceFields =
  | {stage:'roon-phase';phase:LocalPlaybackObservationLeaf['phase']}
  | {stage:'position';sampleSequence:1|2;source:'audio-input'|'zone';positionMs:number;positionAdvanced:boolean};
interface LocalPlaybackEvidenceState {
  diagnosticId:string;startedAtMs:number;phases:Set<LocalPlaybackObservationLeaf['phase']>;
  positionSamples:0|1|2;firstPositionMs?:number;
}
type LocalGuardStage = 'REQUEST_GATE'|'INTENT'|'TARGET_CAPTURE'|'ALBUM_MATERIALIZE'|'ALBUM_VALIDATE'|'SOURCE_CAPTURE'|'SOURCE_VALIDATE'|'SELECTED_SNAPSHOT'|'STOP_ACTIVE'|'PERSIST_QUEUE'|'RELEASE_CAPTURE'|'START_QUEUE'|'EDITION_RESOLVE'|'SECOND_CAPTURE'|'SECOND_FACTS'|'LEASE_REGISTER'|'SOURCE_NAMESPACE_CAPTURE'|'SOURCE_NAMESPACE_ACQUIRE'|'SOURCE_NAMED_CHECK'|'SOURCE_FD_OPEN'|'SOURCE_FD_STAT'|'SOURCE_FD_VERIFY'|'SOURCE_CLEANUP'|'SDK_SUBMIT'|'COMPLETED';
type LocalGuardMatch = 'not-checked'|'match'|'mismatch';
type LocalGuardMatches = Record<'intentMatch'|'targetMatch'|'sourceMatch'|'fenceMatch'|'snapshotMatch'|'factsMatch',LocalGuardMatch>;
type LocalGuardPriority = 'first-business'|'final-rejection'|'first-cleanup'|'terminal';
interface LocalGuardTrace {
  diagnosticId:string;requestFingerprintSha256:string;startedAtMs:number;operationStage:LocalGuardStage;firstStage:LocalGuardStage|'NONE';
  matches:LocalGuardMatches;differenceMask:number;closed:boolean;lastError?:unknown;hasError:boolean;failureStage?:LocalGuardStage;
  budget:{ordinary:number;reserved:Set<LocalGuardPriority>};
}
type LocalPlayWork = Promise<LocalPlayAccepted | import('@music-bridge/contracts').LocalSourceUnsupported>;
interface LocalPlayRequestEntry {fingerprint:string;work:LocalPlayWork;receipt:import('@music-bridge/contracts').LocalPlayReceipt;guardTrace:LocalGuardTrace|undefined}
const localGuardCodes = new Set(['NONE','UNKNOWN','BAD_REQUEST','INTERNAL_ERROR','ROON_ZONE_NOT_SELECTED','ROON_NOT_PAIRED','ROON_CORE_NOT_CONNECTED','ROON_TIMEOUT','ROON_MEDIA_ERROR','QUEUE_CONFLICT','INVENTORY_CONFLICT','INVALID_IPC_REQUEST','UNAVAILABLE','NOT_READY','LOCAL_SOURCE_CHANGED','INVALID_REQUEST','TARGET_CHANGED','FACTS_CHANGED','UNAUTHORIZED_ROOT','SEGMENT_UNSUPPORTED','READ_CANCELLED','READ_DEADLINE','ROON_TRANSPORT_UNAVAILABLE','INVENTORY_UNAVAILABLE']);
const localGuardStatuses = new Set([0,400,401,403,404,409,412,415,422,429,500,503,504]);
const emptyLocalGuardMatches = ():LocalGuardMatches => ({intentMatch:'not-checked',targetMatch:'not-checked',sourceMatch:'not-checked',fenceMatch:'not-checked',snapshotMatch:'not-checked',factsMatch:'not-checked'});
/** 诊断只读own data；不触发错误getter、代理或message/stack。 */
function localGuardOwn(value:unknown,key:string):unknown {
  if(!value||typeof value!=='object'||nodeTypes.isProxy(value))return undefined;
  try {const descriptor=Object.getOwnPropertyDescriptor(value,key);return descriptor&&Object.hasOwn(descriptor,'value')?descriptor.value:undefined;}catch{return undefined;}
}
/** 仅早于原JSON正文生成的拒绝使用；非普通纯data对象不作诊断序列化。 */
function localGuardJson(value:unknown,depth=0):unknown {
  if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return value;
  if(!value||typeof value!=='object'||depth>3||nodeTypes.isProxy(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new Error('诊断正文不属于普通data。');
  const keys=Reflect.ownKeys(value);if(keys.length>32)throw new Error('诊断正文超出有限字段。');
  const result:Record<string,unknown>={};
  for(const key of keys){const descriptor=Object.getOwnPropertyDescriptor(value,key);if(typeof key!=='string'||!descriptor?.enumerable||!Object.hasOwn(descriptor,'value'))throw new Error('诊断正文不是own data。');Object.defineProperty(result,key,{value:localGuardJson(descriptor.value,depth+1),enumerable:true,configurable:true,writable:true});}
  return result;
}
interface LocalOwnerResources {
  capture: LocalSourceCaptureResult; fence: LocalSourceFence; lease?: AssetLease; session?: ConfirmedLocalSession;
  timer?: ReturnType<typeof setInterval>; renewing?: Promise<void>; disposing?: Promise<void>; lyricsFlight?: Promise<LyricsSnapshot>; preparationQuiet?: Promise<void>;
  isOwned?: () => boolean; nextRenewal?: number; evidence?:LocalPlaybackEvidenceState;
  lane?: number; poolAttempt?: number;
  target: NonNullable<ReturnType<NonNullable<RoonPort['captureLocalTarget']>>>;
}
export type QueueItem = PlaybackQueueEntry & {
  localSelection?: LocalPlayRequest;
  logicalSource?: MBQueueLogicalSource;
  edition?: import('@music-bridge/contracts').AlbumEdition;
  preflight?: {state:'NEEDS_REVALIDATION'|'PREPARED'|'FAILED';reason:'SOURCE_UNAVAILABLE'|'SEGMENT_UNSUPPORTED'|'UNSUPPORTED_NATIVE_RESTORE'|null};
  localExpected?: LocalSourceCaptureResult['facts'];
  localTarget?: LocalOwnerResources['target'];
  /** 运行期引用只存在 Core 内存中，绝不进入公开队列快照。 */
  roonReference?: string;
  roonZoneId?: string;
};
type QueueInput = {
  trackId: unknown;
  qualityPreference?: unknown;
  /** 兼容旧控制请求；公开 IPC 快照不再输出此字段。 */
  quality?: unknown;
  preferredSource?: unknown;
};
export interface NativeRoonQueueInput {
  reference: string;
  zoneId: string;
  track: TrackSummary;
}
export interface SmartRoonResolution {
  reference: string;
  zoneId: string;
}
export type PlaybackStartupStage =
  | 'metadata-ready'
  | 'stream-url-ready'
  | 'gateway-preflight-ready'
  | 'roon-session-began'
  | 'roon-playing';
export interface PlaybackStartupTrace {
  startedAtMs: number;
  onStage(stage: PlaybackStartupStage, elapsedMs: number): void;
}
interface NativeRoonPlaybackPort {
  resolveArtwork?(imageKey: string): string | undefined;
  play(reference: string, zoneId: string, track: TrackSummary, options?: RoonOperationOptions & {
    onDispatch?: () => void;
    onDispatchCompletion?: (completion: Promise<void>) => void;
  }): Promise<RoonPlaybackObservation>;
  stop(options?: RoonOperationOptions): Promise<void>;
  pause(options?: RoonOperationOptions): Promise<void>;
  resume(options?: RoonOperationOptions): Promise<void>;
  seek?(positionMs: number, options?: RoonOperationOptions): Promise<void>;
}
interface PlaybackOwner {
  /** 稳定entry入口在准备期间的队列资格；进入Playing后不阻止合法队列编辑。 */
  queueAdmission?: () => void;
  /** 仅表示此旧owner已受理停止；原停止回执仍是终态依据。 */
  localStopRequested?: boolean;
  local?: LocalOwnerResources;
  item: QueueItem;
  zoneId: string;
  source: PlaybackResolvedSource;
  abort: AbortController;
  preparing: boolean;
  dispatched: boolean;
  token?: string;
}
interface QueueHydration {
  generation: number;
  owner: PlaybackOwner | undefined;
  abort: AbortController;
}
interface QueueContext {
  lease: RoonPlaybackContextLease;
  generation: number;
  zoneId: string;
  abort: AbortController;
  before: number;
  after: number;
  afterComplete: boolean;
  loading: number;
  error?: 'retryable' | 'expired' | 'capacity';
  tail: Promise<void>;
  ready: Promise<void>;
  activate(): void;
}
export interface PlaybackChangeMetadata { readonly kind: 'full' | 'position' }
export type PlaybackChangedListener = (snapshot: PlaybackSnapshot, metadata?: PlaybackChangeMetadata) => void;

const SKIPPABLE_QUEUE_ERRORS = new Set([
  'TRACK_UNAVAILABLE',
  'TRACK_PREVIEW_ONLY',
]);
const MAX_QUEUE_ITEMS = MAX_PLAYBACK_QUEUE_ITEMS;
const QUEUE_HYDRATION_INLINE_LIMIT = 20;
const QUEUE_HYDRATION_CONCURRENCY = 2;

function normalizeQueueItem(input: QueueInput): QueueItem {
  const preferenceInput = input.qualityPreference ?? input.quality;
  const qualityPreference = parseQualityPreference(preferenceInput);
  const preferredSource: PlaybackSourcePreference = input.preferredSource === 'smart' || input.preferredSource === 'roon'
    ? input.preferredSource
    : 'netease';
  return {
    entryId: randomUUID(),
    trackId: normalizeTrackId(input.trackId),
    qualityPreference,
    ...(preferredSource !== 'netease' ? { preferredSource } : {}),
  };
}

function normalizeNativeRoonQueueItem(input: NativeRoonQueueInput): QueueItem {
  if (
    input.reference.trim().length === 0 ||
    input.reference.length > 128 ||
    input.zoneId.trim().length === 0 ||
    input.zoneId.length > 128
  ) {
    throw new BridgeError('BAD_REQUEST', 'Roon queue reference is invalid', { httpStatus: 400 });
  }
  return {
    entryId: randomUUID(),
    trackId: normalizeTrackId(input.track.id),
    qualityPreference: 'auto',
    preferredSource: 'roon',
    track: cloneTrackSummary(input.track),
    roonReference: input.reference,
    roonZoneId: input.zoneId,
  };
}

function toTrackSummary(track: TrackMetadata): TrackSummary {
  return {
    id: track.id,
    title: track.title,
    artists: [...track.artists],
    album: track.album,
    ...(track.durationMs !== undefined ? { durationMs: track.durationMs } : {}),
    ...(track.version !== undefined ? { version: track.version } : {}),
    ...(track.artworkUrl ? { artworkUrl: track.artworkUrl } : {}),
  };
}

function cloneTrackSummary(track: TrackSummary): TrackSummary {
  return {
    id: track.id,
    title: track.title,
    artists: [...track.artists],
    album: track.album,
    ...(track.durationMs !== undefined ? { durationMs: track.durationMs } : {}),
    ...(track.version ? { version: track.version } : {}),
    ...(track.bitrate !== undefined ? { bitrate: track.bitrate } : {}),
    ...(track.format ? { format: track.format } : {}),
    ...(track.artworkUrl ? { artworkUrl: track.artworkUrl } : {}),
    ...(track.artworkReference ? { artworkReference: track.artworkReference } : {}),
  };
}

function cloneRoonItem(item: RoonLibraryItem): RoonLibraryItem {
  // 只复制公开标量，不让内部SDK字段进入队列响应。
  const output: RoonLibraryItem = { kind: item.kind, reference: item.reference, title: item.title };
  for (const key of ['subtitle', 'artist', 'album', 'albumCount', 'durationMs', 'bitrate', 'format', 'trackNumber', 'discNumber', 'year', 'version', 'artworkReference'] as const) {
    const value = item[key];
    if (value !== undefined) Object.assign(output, { [key]: value });
  }
  return output;
}

function normalizeContextItem(input: RoonPlaybackContextItem, zoneId: string): QueueItem {
  if (input.zoneId !== zoneId || input.roonItem.kind !== 'track' || input.roonItem.reference !== input.reference
    || roonTrackIdFromReference(input.reference) !== input.track.id) {
    throw new BridgeError('BAD_REQUEST', '播放上下文曲目身份无效', { httpStatus: 400 });
  }
  return { ...normalizeNativeRoonQueueItem(input), roonItem: cloneRoonItem(input.roonItem) };
}

function freezeQueuePublication(queue: PlaybackQueueSnapshot): PlaybackQueueSnapshot {
  for (const item of queue.items) {
    if (item.track) {
      Object.freeze(item.track.artists);
      Object.freeze(item.track);
    }
    if (item.roonItem) Object.freeze(item.roonItem);
    Object.freeze(item);
  }
  Object.freeze(queue.items);
  if (queue.context) Object.freeze(queue.context);
  return Object.freeze(queue);
}

function freezePlaybackPublication(snapshot: PlaybackSnapshot): PlaybackSnapshot {
  if (snapshot.currentTrack) {
    Object.freeze(snapshot.currentTrack.artists);
    Object.freeze(snapshot.currentTrack);
  }
  if (snapshot.lastIssue) Object.freeze(snapshot.lastIssue);
  if (snapshot.qualityNotice) Object.freeze(snapshot.qualityNotice);
  return Object.freeze(snapshot);
}

function normalizedPlaybackIdentity(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLocaleLowerCase('en-US')
    .replace(/^\d{1,3}\s*(?:[.．、:：)]|[-–—])\s+/u, '');
}

function timeEventMatchesTrack(event: Pick<RoonTimeEvent, 'nowPlaying'>, track: TrackSummary): boolean {
  const nowPlaying = event.nowPlaying;
  if (!nowPlaying?.title) return false;
  if (normalizedPlaybackIdentity(nowPlaying.title) !== normalizedPlaybackIdentity(track.title)) {
    return false;
  }
  if (nowPlaying.durationMs !== undefined && track.durationMs !== undefined) {
    return Math.abs(nowPlaying.durationMs - track.durationMs) <= 2_000;
  }
  return true;
}

function isSkippableQueueError(error: unknown): boolean {
  return SKIPPABLE_QUEUE_ERRORS.has(asBridgeError(error).code);
}

function playbackIssueCode(error: BridgeError): PlaybackIssueCode {
  switch (error.code) {
    case 'NETEASE_NOT_CONFIGURED':
      return 'AUTH_REQUIRED';
    case 'AUTH_EXPIRED':
      return 'AUTH_EXPIRED';
    case 'TRACK_UNAVAILABLE':
      return 'TRACK_UNAVAILABLE';
    case 'TRACK_PREVIEW_ONLY':
      return 'TRACK_PREVIEW_ONLY';
    case 'STREAM_URL_EXPIRED':
      return 'STREAM_URL_EXPIRED';
    case 'NETEASE_REQUEST_FAILED':
    case 'STREAM_UPSTREAM_FAILED':
      return 'UPSTREAM_HTTP_ERROR';
    case 'ROON_NOT_PAIRED':
      return 'ROON_NOT_PAIRED';
    case 'ROON_ZONE_NOT_SELECTED':
      return 'ROON_ZONE_NOT_SELECTED';
    case 'ROON_MEDIA_ERROR':
      return 'ROON_MEDIA_ERROR';
    case 'ROON_TIMEOUT':
      return 'ROON_TIMEOUT';
    case 'STREAM_NOT_FOUND':
    case 'UNSAFE_UPSTREAM':
      return 'GATEWAY_NOT_REACHABLE';
    default:
      return 'INTERNAL_ERROR';
  }
}

function playbackIssueMessage(code: PlaybackIssueCode): {
  message: string;
  retryable: boolean;
  action: PlaybackRecoveryAction;
} {
  switch (code) {
    case 'AUTH_REQUIRED':
      return { message: '请先扫码登录 Provider', retryable: false, action: 'reauthenticate' };
    case 'AUTH_EXPIRED':
      return { message: '登录已过期，请重新扫码登录', retryable: false, action: 'reauthenticate' };
    case 'TRACK_UNAVAILABLE':
      return { message: '当前歌曲暂不可播放', retryable: false, action: 'none' };
    case 'TRACK_PREVIEW_ONLY':
      return { message: '当前账号仅获得试听片段', retryable: false, action: 'none' };
    case 'STREAM_URL_EXPIRED':
      return { message: '播放地址已过期，刷新后仍不可用', retryable: true, action: 'retry' };
    case 'UPSTREAM_HTTP_ERROR':
      return { message: '音频服务暂时不可用，请重试', retryable: true, action: 'retry' };
    case 'ROON_NOT_PAIRED':
      return { message: 'Roon Core 尚未配对', retryable: false, action: 'restart_core' };
    case 'ROON_ZONE_NOT_SELECTED':
      return { message: '请先选择 Roon Zone', retryable: false, action: 'select_zone' };
    case 'ROON_ZONE_LOST':
      return { message: 'Roon Zone 已丢失，请重新选择 Zone', retryable: false, action: 'select_zone' };
    case 'ROON_MEDIA_ERROR':
      return { message: 'Roon 报告媒体错误，请重试', retryable: true, action: 'retry' };
    case 'ROON_TIMEOUT':
      return { message: 'Roon 播放响应超时，请重试', retryable: true, action: 'retry' };
    case 'GATEWAY_NOT_REACHABLE':
      return { message: '本地音频网关不可用，请重试', retryable: true, action: 'retry' };
    case 'INTERNAL_ERROR':
      return { message: '播放失败，请重试', retryable: true, action: 'retry' };
    case 'QUALITY_DOWNGRADED':
      return { message: '请求音质与实际音质不同', retryable: false, action: 'none' };
  }
}

function makePlaybackIssue(
  code: PlaybackIssueCode,
  diagnosticId: string,
): PlaybackIssue {
  const detail = playbackIssueMessage(code);
  return { code, ...detail, diagnosticId };
}

function makeTerminalIssue(
  reason: RoonTerminalReason,
  diagnosticId: string,
): PlaybackIssue | undefined {
  switch (reason) {
    case 'media_error':
      return makePlaybackIssue('ROON_MEDIA_ERROR', diagnosticId);
    case 'zone_lost':
      return makePlaybackIssue('ROON_ZONE_LOST', diagnosticId);
    default:
      return undefined;
  }
}

export class BridgeController {
  private activeToken: string | undefined;
  private activePlayback: ActivePlayback | undefined;
  private activeRoonPlayback: {
    track: TrackSummary;
    reference?: string;
    zoneId: string;
    observedIdentity?: RoonNowPlayingIdentity;
  } | undefined;
  private readonly localPoolOwner = randomUUID();
  private readonly localLaneIds=[randomUUID(),randomUUID()];
  private readonly localLaneAttempts=[0,0];
  private readonly localLaneBusy=[false,false];
  private readonly localLaneQuiet:Promise<void>[]=[Promise.resolve(),Promise.resolve()];
  private localNext: {item:QueueItem;owner:PlaybackOwner;created:number;promoted?:PlaybackOwner;work:Promise<void>;failed:boolean} | undefined;
  private queueId: string = randomUUID();
  private logicalRevision = '0';
  private queueDatasetId: string | undefined;
  private queuePersistence: 'SAVED' | 'UNAVAILABLE' | 'NEEDS_REVALIDATION' = 'UNAVAILABLE';
  private queueSaveTail: Promise<void> = Promise.resolve();
  private localAttempt = 0;
  private localClosing = false;
  private localObservation: LocalPlaybackObservationLeaf | undefined;
  private readonly localTasks = new Set<Promise<unknown>>();
  private readonly localRequests = new Map<string,LocalPlayRequestEntry>();
  private readonly localGuardContext = new AsyncLocalStorage<LocalGuardTrace>();
  private queue: QueueItem[] = [];
  private queueIndex = -1;
  private playbackState: PlaybackState = 'idle';
  private lastPlaybackError: string | undefined;
  private lastPlaybackIssue: PlaybackIssue | undefined;
  private qualityNotice: PlaybackIssue | undefined;
  private positionMs = 0;
  private playbackGeneration = 0;
  private positionContext: {
    generation: number;
    trackId: string;
    zoneId: string;
    source: PlaybackResolvedSource;
    playbackEpoch?: number;
    minimumRevision?: number;
  } | undefined;
  private lastPositionPublishedAt = Number.NEGATIVE_INFINITY;
  private pendingTerminalReason: RoonTerminalReason | undefined;
  private nativeRoonStopRequested = false;
  private lastNativeRoonPlaybackState: RoonNativePlaybackState | undefined;
  private operationTail: Promise<void> = Promise.resolve();
  private playbackCommandTail: Promise<void> = Promise.resolve();
  private deviceTail: Promise<void> = Promise.resolve();
  private controlTail: Promise<void> = Promise.resolve();
  private pendingPlaybackCommands = 0;
  private readonly displayReadPriorityOperations = new Set<object>();
  private readonly displayReadUnconfirmedRoonStops = new Set<string | undefined>();
  private commandEpoch = 0;
  private runningCommandEpoch = 0;
  private queueReplacementGeneration = 0;
  private runningQueueReplacementGeneration = 0;
  private owner: PlaybackOwner | undefined;
  private stopFlight: Promise<void> | undefined;
  private stopUnknown = false;
  private readonly externalTasks = new Set<Promise<unknown>>();
  private queueHydrationGeneration = 0;
  private queueHydration: QueueHydration | undefined;
  private queueContextGeneration = 0;
  private queueContext: QueueContext | undefined;
  private readonly pendingQueueContexts = new Set<QueueContext>();
  private queueEditTail: Promise<void> = Promise.resolve();
  private lastContextPlaying: { item: QueueItem; generation: number; at: number; revision: number; positionMs: number } | undefined;
  private nextPreparation: {
    item: QueueItem;
    quality: QualityLevel;
    abort: AbortController;
    result: Promise<{ metadata: TrackMetadata; stream: ResolvedAudioStream; resolvedAtMs: number; expiresAtMs: number } | undefined>;
  } | undefined;
  private preparationInFlight = false;
  private nextInsertionQueueIndex: number | undefined;
  private nextInsertionCursor: number | undefined;
  private readonly playbackListeners = new Set<PlaybackChangedListener>();
  private publishedQueue: PlaybackQueueSnapshot | undefined;
  private lastPublishedPlayback: PlaybackSnapshot | undefined;
  private queueProjectionDirty = false;

  constructor(
    private readonly dependencies: {
      localSources?: DatasetOwnerEndpoint;
      localPlaybackDiagnostics?: () => (event: import('@music-bridge/contracts').LocalRoonStartupDiagnostic) => void;
      isLocalPlaybackAllowed?: () => boolean;
      netease: NeteasePort;
      roon: RoonPort;
      registry: StreamRegistry;
      gateway: StreamGateway;
      logger: Logger;
      roonLibrary?: NativeRoonPlaybackPort;
      resolveSmartSource?: (track: TrackSummary) => Promise<SmartRoonResolution | undefined>;
      now?: () => number;
      diagnosticId?: () => string;
      onProviderAuthExpired?: () => void;
      /** 仅通知同Core私有扫描准入；原Controller仍是播放所有权真相。 */
      onReadPriorityChanged?: () => void;
    },
  ) {
    this.dependencies.roon.setTerminalHandler((reason) => {
      const token = this.activeToken;
      const generation = this.playbackGeneration;
      if (token === undefined) return;
      // 捕获事件到达时的身份与停止意图，不能在排队后重新认领另一首歌曲。
      const playbackWasPlaying = this.activePlayback !== undefined
        && this.playbackState !== 'stopping'
        && this.playbackState !== 'error';
      if (!this.activePlayback) {
        this.pendingTerminalReason = reason;
      }
      void this.enqueue(async () => {
        if (this.stopFlight) await this.stopFlight.catch(() => undefined);
        if (generation !== this.playbackGeneration || token !== this.activeToken) return;

        if(this.owner?.local){
          if(reason==='media_error')this.localTerminal(this.owner,'FAILED','ROON_MEDIA_ERROR','ERROR');
          else if(reason==='zone_lost')this.localPhase(this.owner,'OWNERSHIP_LOST','UNKNOWN');
          else if(reason==='ended')this.localTerminal(this.owner,'ENDED',null,'ENDED');
          else if(this.localObservation?.phase!=='ENDED')this.localTerminal(this.owner,'CANCELLED');
        }
        this.clearActiveResources();
        if (reason !== 'ended' || !playbackWasPlaying) {
          this.cancelNextPreparation();
          this.playbackState = reason === 'stopped' || reason === 'ended' ? 'idle' : 'error';
          this.lastPlaybackError = reason === 'media_error'
            ? 'ROON_MEDIA_ERROR'
            : reason === 'zone_lost'
              ? 'ROON_ZONE_LOST'
              : undefined;
          this.lastPlaybackIssue = makeTerminalIssue(reason, this.newDiagnosticId());
          this.qualityNotice = undefined;
          this.notifyPlaybackChanged();
          this.dependencies.logger.info('roon_session_terminal', { reason });
          return;
        }

        const nextIndex = this.queueIndex + 1;
        if (nextIndex >= this.queue.length) {
          this.playbackState = 'idle';
          this.lastPlaybackError = undefined;
          this.lastPlaybackIssue = undefined;
          this.qualityNotice = undefined;
          this.notifyPlaybackChanged();
          this.dependencies.logger.info('roon_session_terminal', { reason });
          return;
        }

        this.dependencies.logger.info('roon_session_terminal', { reason });
        await this.startAutomaticQueueIndex(nextIndex);
      }).catch((error: unknown) => {
        const bridgeError = asBridgeError(error);
        this.dependencies.logger.warn('queue_advance_failed', {
          code: bridgeError.code,
        });
      });
    });
  }

  subscribe(listener: PlaybackChangedListener): () => void {
    const wasUnobserved = this.playbackListeners.size === 0;
    this.playbackListeners.add(listener);
    const snapshot = this.playbackPublication('full');
    // 后来的订阅者读取现态，不替已有订阅者确认尚未广播的变化。
    if (wasUnobserved) this.lastPublishedPlayback = snapshot;
    listener(snapshot, { kind: 'full' });
    return () => this.playbackListeners.delete(listener);
  }

  getPlaybackState(): PlaybackSnapshot {
    return this.playbackSnapshot(this.projectQueueSnapshot());
  }

  /** 仅供同进程出版/采样；返回不可变且内容相同则引用稳定的队列。 */
  getPlaybackPublication(): PlaybackSnapshot {
    return this.playbackPublication('full');
  }

  private projectQueueSnapshot(): PlaybackQueueSnapshot {
    const hasQueue = this.queue.length > 0;
    const context = this.queueContext;
    const hasNext = hasQueue && this.queueIndex >= 0 && (this.queueIndex < this.queue.length - 1 || Boolean(context && !context.afterComplete));
    const hasPrevious = hasQueue && (this.queueIndex > 0 || Boolean(context && context.before > 0));
    return {
      queueId: this.queueId, revision: this.logicalRevision, persistence: this.queuePersistence,
      items: this.queue.map((item, index) => ({
        entryId: item.entryId!,
        ...(item.edition?{edition:{...item.edition}}:{}),
        ...(item.preflight?{preflight:{...item.preflight}}:{}),
        trackId: item.trackId,
        qualityPreference: item.qualityPreference,
        ...(item.track ? { track: cloneTrackSummary(item.track) } : {}),
        ...(item.preferredSource ? { preferredSource: item.preferredSource } : {}),
        ...(item.resolvedSource ? { resolvedSource: item.resolvedSource } : {}),
        ...(item.local ? {local:{...item.local}} : {}),
        ...(item.roonItem ? { roonItem: Object.freeze(cloneRoonItem(item.roonItem)) } : {}),
        ...(index === this.queueIndex && this.activePlayback
          ? {
              requestedQuality: this.activePlayback.requestedQuality,
              actualQuality: this.activePlayback.actualQuality,
            }
          : {}),
      })),
      index: this.queueIndex,
      hasNext,
      hasPrevious,
      ...(context ? { context: { beforeComplete: context.before === 0, afterComplete: context.afterComplete,
        loading: context.loading > 0, ...(context.error ? { error: context.error } : {}) } } : {}),
    };
  }

  private playbackSnapshot(queue: PlaybackQueueSnapshot): PlaybackSnapshot {
    const roonState = this.dependencies.roon.getState();
    const selectedZoneId = roonState.selectedZoneId;
    const effectiveState = this.playbackState;
    const currentTrack = this.activePlayback
      ? cloneTrackSummary(toTrackSummary(this.activePlayback.track))
      : this.activeRoonPlayback
        ? cloneTrackSummary(this.activeRoonPlayback.track)
        : undefined;
    const hasNext = queue.hasNext;
    const hasPrevious = queue.hasPrevious;
    const activeItem = this.queue[this.queueIndex];
    const source: PlaybackResolvedSource | undefined = this.activeRoonPlayback
      ? 'roon' : this.activePlayback ? activeItem?.resolvedSource : undefined;

    return {
      state: effectiveState,
      ...(this.localObservation ? {local:structuredClone(this.localObservation)} : {}),
      queue,
      ...(currentTrack ? { currentTrack } : {}),
      ...(source ? { source } : {}),
      ...(this.activePlayback
        ? {
            qualityPreference: this.activePlayback.qualityPreference,
            requestedQuality: this.activePlayback.requestedQuality,
            actualQuality: this.activePlayback.actualQuality,
            ...(this.activePlayback.format ? { format: this.activePlayback.format } : {}),
            ...(this.activePlayback.bitrate !== undefined
              ? { bitrate: this.activePlayback.bitrate }
              : {}),
          }
        : this.activeRoonPlayback
          ? {
              actualQuality: 'unknown' as const,
              ...(this.activeRoonPlayback.track.format
                ? { format: this.activeRoonPlayback.track.format }
                : {}),
              ...(this.activeRoonPlayback.track.bitrate !== undefined
                ? { bitrate: this.activeRoonPlayback.track.bitrate }
                : {}),
            }
          : {}),
      positionMs: this.positionMs,
      ...(selectedZoneId ? { selectedZoneId } : {}),
      ...(this.lastPlaybackError ? { lastError: this.lastPlaybackError } : {}),
      ...(this.lastPlaybackIssue ? { lastIssue: { ...this.lastPlaybackIssue } } : {}),
      ...(this.qualityNotice ? { qualityNotice: { ...this.qualityNotice } } : {}),
      canNext: hasNext || this.canNavigateNativeRoon('next'),
      canPrevious: hasPrevious || this.canNavigateNativeRoon('previous'),
      canStop:
        this.hasPlaybackOwnership() ||
        this.activeToken !== undefined ||
        this.activePlayback !== undefined ||
        this.activeRoonPlayback !== undefined,
      canPause:
        (this.activePlayback !== undefined || this.activeRoonPlayback !== undefined) &&
        effectiveState === 'playing' &&
        roonState.canPause === true,
      canResume:
        (this.activePlayback !== undefined || this.activeRoonPlayback !== undefined) &&
        effectiveState === 'paused' &&
        roonState.canResume === true,
    };
  }

  private playbackPublication(kind: 'full' | 'position'): PlaybackSnapshot {
    let queue = this.publishedQueue;
    if (kind === 'full' || !queue || this.queueProjectionDirty) {
      const projected = this.projectQueueSnapshot();
      if (!queue || !isDeepStrictEqual(queue, projected)) {
        queue = freezeQueuePublication(projected);
        this.publishedQueue = queue;
      }
      this.queueProjectionDirty = false;
    }
    return freezePlaybackPublication(this.playbackSnapshot(queue!));
  }

  async play(input: {
    trackId: unknown;
    qualityPreference?: unknown;
    quality?: unknown;
    startupTrace?: PlaybackStartupTrace;
  }): Promise<BridgeState> {
    const item = normalizeQueueItem(input);
    this.cancelQueueContext();
    return this.enqueuePlayback(async () => {
      await this.stopActive();
      this.guardCommand();
      const replacementId=randomUUID();await this.persistQueue([item],0,replacementId);
      this.queueId=replacementId;this.queue = [item];
      this.queueIndex = 0;
      this.queueProjectionDirty = true;this.guardCommand();
      this.clearPlaybackIssue();
      await this.startQueueIndex(0, false, input.startupTrace,true);
      return this.getState();
    });
  }

  /** Boot之后只恢复逻辑队列；不打开FD、不begin_session。 */
  async restoreLogicalQueue(): Promise<void> {
    const port=this.dependencies.localSources;
    if (!port?.loadMBQueue || this.localClosing) return;
    const identity=await port.prepare();if(this.localClosing || !port.isLocalSourceCurrent?.())throw this.cancelled();
    this.queueDatasetId=identity.datasetId;const saved=await port.loadMBQueue();
    if(this.localClosing || !port.isLocalSourceCurrent?.())throw this.cancelled();
    if(!saved)return;
    if(isMBQueueUnavailable(saved)){this.queuePersistence='UNAVAILABLE';this.queueProjectionDirty=true;this.playbackState='idle';this.notifyPlaybackChanged();return;}
    if(isMBQueueNeedsReview(saved)){this.logicalRevision=saved.revision;this.queuePersistence='NEEDS_REVALIDATION';this.queueProjectionDirty=true;this.playbackState='idle';this.notifyPlaybackChanged();return;}
    this.queueId=saved.queueId;this.logicalRevision=saved.revision;
    this.queue=saved.entries.map(entry=>({entryId:entry.entryId,logicalSource:structuredClone(entry.source),trackId:entry.source.kind==='local_file'?entry.source.snapshot.trackId:entry.source.kind==='roon'?'0':entry.source.trackId,
      qualityPreference:entry.quality,...(entry.source.kind==='local_file'?{resolvedSource:'local_file' as const,local:localQueueIdentity(entry.source)}:entry.source.kind==='roon'?{preferredSource:'roon' as const,preflight:{state:'FAILED' as const,reason:'UNSUPPORTED_NATIVE_RESTORE' as const}}:{preferredSource:entry.source.kind})}));
    this.queueIndex=saved.currentEntryId?this.queue.findIndex(entry=>entry.entryId===saved.currentEntryId):-1;
    this.queuePersistence='NEEDS_REVALIDATION';this.playbackState='idle';this.queueProjectionDirty=true;this.notifyPlaybackChanged();
  }
  private persistQueue(items:QueueItem[]=this.queue,index:number=this.queueIndex,queueId:string=this.queueId): Promise<void> {
    const candidate=[...items],acceptedRevision=this.logicalRevision;
    const port=this.dependencies.localSources;if(!port?.saveMBQueue)return Promise.resolve();
    const work=this.queueSaveTail.then(async()=>{
      if(this.localGuardRejects('intentMatch',this.localClosing) || this.localGuardRejects('sourceMatch',!port.isLocalSourceCurrent?.()))throw this.cancelled();
      if(!this.queueDatasetId){const identity=await port.prepare();this.queueDatasetId=identity.datasetId;}
      if(this.localGuardRejects('intentMatch',this.localClosing) || this.localGuardRejects('sourceMatch',!port.isLocalSourceCurrent?.()))throw this.cancelled();
      if(this.localGuardRejects('snapshotMatch',this.logicalRevision!==acceptedRevision && queueId===this.queueId))throw this.cancelled();
      const expectedRevision=this.logicalRevision;
      const queue:MBQueueRecord={schemaVersion:'1.2',datasetId:this.queueDatasetId!,queueId,revision:String(BigInt(expectedRevision)+1n),
        currentEntryId:candidate[index]?.entryId ?? null,restartPolicy:{reResolve:true,autoplay:false},
        entries:candidate.map(logicalQueueEntry)};
      const result=await port.saveMBQueue!({expectedRevision,queue});
      if(this.localGuardRejects('intentMatch',this.localClosing) || this.localGuardRejects('sourceMatch',!port.isLocalSourceCurrent?.()) || this.localGuardRejects('snapshotMatch',result.revision!==queue.revision) || this.localGuardRejects('snapshotMatch',result.queueId!==queue.queueId))throw this.cancelled();
      this.logicalRevision=result.revision;this.queuePersistence='SAVED';this.queueProjectionDirty=true;
    });
    this.queueSaveTail=work.catch(()=>{this.queuePersistence='UNAVAILABLE';this.queueProjectionDirty=true;});return work;
  }
  getLocalPlaybackTarget(): LocalPlayTarget | null {
    if (this.localClosing) return null;
    const captured = this.dependencies.roon.captureLocalTarget?.();
    if (!captured?.isCurrent() || !isLocalPlayTarget(captured.target)) return null;
    return { core_id: captured.target.core_id, zone_id: captured.target.zone_id };
  }
  queueLocalEdition(request:MBEditionQueueRequest):Promise<BridgeState> {
    if(!isMBEditionQueueRequest(request))return Promise.reject(this.cancelled());
    if(request.action==='PLAY_NOW')this.cancelQueueContext();
    const epoch=this.commandEpoch,replacement=this.queueReplacementGeneration,target=this.dependencies.roon.captureLocalTarget?.();
    const current=()=>{if(this.localClosing||epoch!==this.commandEpoch||request.action!=='PLAY_NOW'&&replacement!==this.queueReplacementGeneration||!target?.isCurrent())throw this.cancelled();if(request.action==='PLAY_NOW')this.guardCommand();};
    const run=async()=>{
      current();const port=this.dependencies.localSources;if(!port?.materializeMBEdition)throw this.cancelled();
      const snapshot=await port.materializeMBEdition(request);current();
      if(snapshot.edition.id!==request.editionId||snapshot.edition.revision!==request.expectedRevision||snapshot.sources.length===0||snapshot.sources.length>MAX_QUEUE_ITEMS)throw this.cancelled();
      if(snapshot.sources.some(source=>source.snapshot.segment!==null))throw new BridgeError('BAD_REQUEST','LOCAL_SEGMENT_UNSUPPORTED',{httpStatus:409});
      const items:QueueItem[]=snapshot.sources.map(source=>({entryId:randomUUID(),trackId:source.snapshot.trackId,qualityPreference:'auto',resolvedSource:'local_file',local:localQueueIdentity(source),logicalSource:structuredClone(source),edition:{...snapshot.edition},preflight:{state:'NEEDS_REVALIDATION',reason:null}}));
      if(request.action==='PLAY_NOW'){
        await this.stopActive();current();const replacementId=randomUUID();await this.persistQueue(items,0,replacementId);this.queueId=replacementId;this.queue=items;this.queueIndex=0;this.queueProjectionDirty=true;current();await this.startQueueIndex(0,false,undefined,true);current();
      }else if(this.queueContext||this.pendingQueueContexts.size)await this.editContextQueue(items,request.action==='PLAY_NEXT_MB_QUEUE',current);
      else await this.commitQueueEdit(items,request.action==='PLAY_NEXT_MB_QUEUE',current);
      current();return this.getState();
    };
    return request.action==='PLAY_NOW'?this.enqueuePlayback(run,true):run();
  }
  playQueueEntry(request:{queueId:string;expectedRevision:string;entryId:string}):Promise<BridgeState>{
    const target=this.queue.find(item=>item.entryId===request.entryId);
    let revision=request.expectedRevision;const contextGeneration=this.queueContextGeneration;
    const current=()=>{if(contextGeneration!==this.queueContextGeneration || !target || request.queueId!==this.queueId || revision!==this.logicalRevision || !this.queue.includes(target))throw this.cancelled();};
    try{current();}catch(error){return Promise.reject(error);}
    return this.enqueuePlayback(async()=>{
      current();this.guardCommand();
      if(target===this.queue[this.queueIndex] && (this.activePlayback || this.activeRoonPlayback))return this.getState();
      await this.stopActive();current();this.guardCommand();
      const candidate=this.queue,index=candidate.indexOf(target!);
      // 本次cursor保存也经CAS；只接受本次ACK推进的一个revision，不能自证其它编辑。
      const committedRevision=this.dependencies.localSources?.saveMBQueue?String(BigInt(revision)+1n):revision;
      await this.persistQueue(candidate,index);revision=committedRevision;
      // ACK先安装已持久的逻辑cursor；Stop只封派发，不能让公开cursor落后于磁盘。
      // 新成员/替换/另一ACK已安装时，旧命令不得回退覆盖它们。
      if(request.queueId===this.queueId && revision===this.logicalRevision && this.queue===candidate && candidate[index]===target){
        this.queueIndex=index;this.queueProjectionDirty=true;this.notifyPlaybackChanged();
      }
      current();this.guardCommand();
      await this.startQueueIndex(index,false,undefined,true,current);current();return this.getState();
    });
  }

  editLogicalQueue(request:MBQueueEditRequest):Promise<BridgeState> {
    if(!isMBQueueEditRequest(request))return Promise.reject(this.cancelled());
    const epoch=this.commandEpoch;return this.enqueue(async()=>{
      if(epoch!==this.commandEpoch || request.queueId!==this.queueId || request.expectedRevision!==this.logicalRevision || this.queueContext)throw this.cancelled();
      const current=this.queue[this.queueIndex],old=this.queue;
      const ids=new Set(request.entryIds);if(request.entryIds.some(id=>!old.some(item=>item.entryId===id)))throw this.cancelled();
      const next=request.action==='REMOVE'?old.filter(item=>!ids.has(item.entryId!)):request.entryIds.map(id=>old.find(item=>item.entryId===id)!);
      if(request.action==='REORDER' && next.length!==old.length)throw this.cancelled();
      const index=current?next.indexOf(current):-1;
      await this.persistQueue(next,index);
      this.cancelNextPreparation();this.queue=next;this.queueIndex=index;this.queueProjectionDirty=true;this.notifyPlaybackChanged();
      if(epoch!==this.commandEpoch)throw this.cancelled();
      if(current && !next.includes(current)){await this.stopActive(true);this.playbackState='idle';}
      this.queueProjectionDirty=true;this.notifyPlaybackChanged();this.scheduleNextPreparation();return this.getState();
    });
  }

  private createLocalGuardTrace(request:unknown,fingerprint?:string):LocalGuardTrace|undefined {
    try {
      const id=localGuardOwn(request,'request_id');if(typeof id!=='string'||id.length>512)return undefined;
      const body=fingerprint??JSON.stringify(localGuardJson(request));if(typeof body!=='string'||Buffer.byteLength(body)>65536)return undefined;
      return {diagnosticId:'diag-local-'+createHash('sha256').update('musicbridge-local-request-guard-v1\0').update(id).digest('hex'),
        requestFingerprintSha256:createHash('sha256').update('musicbridge-local-request-fingerprint-v1\0').update(body).digest('hex'),
        startedAtMs:performance.now(),operationStage:'REQUEST_GATE',firstStage:'NONE',matches:emptyLocalGuardMatches(),differenceMask:0,closed:false,hasError:false,
        budget:{ordinary:0,reserved:new Set<LocalGuardPriority>()}};
    } catch {return undefined;}
  }
  private withLocalGuardTrace<T>(trace:LocalGuardTrace|undefined,operation:()=>T):T {
    if(!trace)return operation();
    let outcome:{ok:true;value:T}|{ok:false;error:unknown}|undefined;
    const once=():T=>{if(outcome){if(outcome.ok)return outcome.value;throw outcome.error;}try{const value=operation();outcome={ok:true,value};return value;}catch(error){outcome={ok:false,error};throw error;}};
    try{return this.localGuardContext.run(trace,once);}catch{return once();}
  }
  private emitLocalGuard(trace:LocalGuardTrace,operationStage:LocalGuardStage,phase:'started'|'succeeded'|'failed'|'cleanup-failed',error?:unknown,priority?:LocalGuardPriority):void {
    try {
      if(trace.closed)return;
      if(priority){if(trace.budget.reserved.has(priority))return;trace.budget.reserved.add(priority);}
      else {if(trace.budget.ordinary>=60)return;++trace.budget.ordinary;}
      const failed=phase==='failed'||phase==='cleanup-failed';
      const rawCode=localGuardOwn(error,'code')??localGuardOwn(localGuardOwn(localGuardOwn(error,'failure'),'error'),'code'),rawStatus=localGuardOwn(error,'httpStatus'),details=localGuardOwn(error,'details');
      const code=!failed?'NONE':typeof rawCode==='string'&&localGuardCodes.has(rawCode)?rawCode:'UNKNOWN';
      const errorClass=!failed?'NONE':!error||typeof error!=='object'||nodeTypes.isProxy(error)?'OTHER'
        :error instanceof BridgeError?'BridgeError':error instanceof DatasetOwnerDispatchError?'DatasetOwnerDispatchError'
        :error instanceof LocalSourcePreparationError?'LocalSourcePreparationError':nodeTypes.isNativeError(error)?'Error':'OTHER';
      this.dependencies.logger.info('local_play_request_guard_evidence',{schemaVersion:1,component:'controller',diagnosticId:trace.diagnosticId,
        requestFingerprintSha256:trace.requestFingerprintSha256,stage:'request-guard',operationStage,firstStage:trace.firstStage,phase,
        elapsedMs:Math.min(86400000,Math.max(0,Math.floor(performance.now()-trace.startedAtMs))),code,errorClass,
        httpStatus:typeof rawStatus==='number'&&localGuardStatuses.has(rawStatus)?rawStatus:0,
        cancelled:localGuardOwn(details,'reason')==='operation_cancelled'?'yes':'not-observed',...trace.matches,differenceMask:trace.differenceMask});
    } catch { /* 私有诊断失败不影响原命令、错误或清理。 */ }
  }
  private localGuardEnter(stage:LocalGuardStage):void {
    try {const trace=this.localGuardContext.getStore();if(!trace||trace.closed)return;trace.operationStage=stage;trace.matches=emptyLocalGuardMatches();trace.differenceMask=0;this.emitLocalGuard(trace,stage,'started');}catch{}
  }
  private localGuardSuccess(stage:LocalGuardStage):void {
    try {const trace=this.localGuardContext.getStore();if(trace)this.emitLocalGuard(trace,stage,'succeeded');}catch{}
  }
  /** 只消费原表达式本次已算出的拒绝布尔；后续短路项仍不求值。 */
  private localGuardRejects(key:keyof LocalGuardMatches,rejects:boolean,bit?:number):boolean {
    try {const trace=this.localGuardContext.getStore();if(trace&&!trace.closed){if(rejects)trace.matches[key]='mismatch';else if(trace.matches[key]!=='mismatch')trace.matches[key]='match';if(rejects&&bit!==undefined)trace.differenceMask|=1<<bit;}}catch{}
    return rejects;
  }
  private localGuardFailure(stage:LocalGuardStage,error:unknown,cleanup=false):void {
    try {
      const trace=this.localGuardContext.getStore();if(!trace||trace.closed)return;
      const same=trace.hasError&&trace.lastError===error;
      if(!same){trace.lastError=error;trace.hasError=true;trace.failureStage=stage;}
      if(cleanup){this.emitLocalGuard(trace,stage,'cleanup-failed',error,'first-cleanup');return;}
      if(trace.firstStage==='NONE'){trace.firstStage=stage;this.emitLocalGuard(trace,stage,'failed',error,'first-business');}
      else if(!same)this.emitLocalGuard(trace,stage,'failed',error);
    }catch{}
  }
  private localGuardCaught(error:unknown):void {
    try {const trace=this.localGuardContext.getStore();if(trace&&!(trace.hasError&&trace.lastError===error))this.localGuardFailure(trace.operationStage,error);}catch{}
  }
  private localGuardSync<T>(stage:LocalGuardStage,operation:()=>T):T {
    this.localGuardEnter(stage);try{const value=operation();this.localGuardSuccess(stage);return value;}catch(error){this.localGuardFailure(stage,error);throw error;}
  }
  private finishLocalGuard(trace:LocalGuardTrace|undefined,error?:unknown,failed=false):void {
    if(!trace)return;
    this.withLocalGuardTrace(trace,()=>{
      try {
        if(failed){if(!trace.hasError)this.localGuardCaught(error);this.emitLocalGuard(trace,trace.failureStage??trace.operationStage,'failed',error,'final-rejection');}
        this.emitLocalGuard(trace,'COMPLETED',failed?'failed':'succeeded',error,'terminal');
      }finally{trace.closed=true;}
    });
  }
  private rejectedLocalGuard(trace:LocalGuardTrace|undefined,error:unknown):LocalPlayWork {
    this.withLocalGuardTrace(trace,()=>{this.localGuardFailure('REQUEST_GATE',error);this.finishLocalGuard(trace,error,true);});
    return Promise.reject(error);
  }

  /** 九字段公开请求进入原队列；重复requestId只回同一受理结果。 */
  playLocal(request: LocalPlayRequest): Promise<LocalPlayAccepted | import('@music-bridge/contracts').LocalSourceUnsupported> {
    if(!isLocalPlayRequest(request) || this.localClosing) return this.rejectedLocalGuard(this.createLocalGuardTrace(request),this.cancelled());
    request=structuredClone(request);
    const fingerprint=JSON.stringify(request), prior=this.localRequests.get(request.request_id);
    if(prior)return prior.fingerprint===fingerprint?prior.work:Promise.reject(this.cancelled());
    const trace=this.createLocalGuardTrace(request,fingerprint);
    return this.withLocalGuardTrace(trace,()=>this.playLocalTraced(request,fingerprint,trace));
  }
  private playLocalTraced(request:LocalPlayRequest,fingerprint:string,trace:LocalGuardTrace|undefined):LocalPlayWork {
    this.localGuardEnter('REQUEST_GATE');
    if(this.localRequests.size>=256) return this.rejectedLocalGuard(trace,new BridgeError('BAD_REQUEST','本地请求回执达到有限容量。',{httpStatus:429}));
    this.localGuardSuccess('REQUEST_GATE');
    if(request.action==='PLAY_NOW')this.cancelQueueContext();
    const acceptedEpoch=this.commandEpoch,acceptedReplacement=this.queueReplacementGeneration;
    const guardIntent=()=>this.localGuardSync('INTENT',()=>{if(this.localGuardRejects('intentMatch',this.localClosing) || this.localGuardRejects('intentMatch',acceptedEpoch!==this.commandEpoch) || (request.action!=='PLAY_NOW' && this.localGuardRejects('intentMatch',acceptedReplacement!==this.queueReplacementGeneration)))throw this.cancelled();if(request.action==='PLAY_NOW')this.guardCommand();});
    const run=async()=>{
      try {
      guardIntent();this.localGuardEnter('TARGET_CAPTURE');const port=this.dependencies.localSources!,target=this.dependencies.roon.captureLocalTarget?.()!;
      if(this.localGuardRejects('sourceMatch',!port?.captureLocalSource) || this.localGuardRejects('sourceMatch',!port.releaseLocalSource) || this.localGuardRejects('sourceMatch',!port.isLocalSourceCurrent?.()) || this.localGuardRejects('targetMatch',!target?.isCurrent())
        || this.localGuardRejects('targetMatch',target.target.core_id!==request.target.core_id) || this.localGuardRejects('targetMatch',target.target.zone_id!==request.target.zone_id)) throw this.cancelled();
      this.localGuardSuccess('TARGET_CAPTURE');
      let albumQueue:LocalSelectionQueueSnapshot|undefined;
      if(request.album||request.context){
        this.localGuardEnter('ALBUM_MATERIALIZE');
        if(!port.readLocalAlbum)throw this.cancelled();
        const expiresAtMs=Date.now()+2000;
        let value:Awaited<ReturnType<NonNullable<typeof port.readLocalAlbum>>>;
        try {value=await port.readLocalAlbum({command:'localAlbum.materializeQueue',payload:{selection:request,expiresAtMs}});}
        catch(error){this.localGuardFailure('ALBUM_MATERIALIZE',error);throw error;}
        this.localGuardSuccess('ALBUM_MATERIALIZE');
        guardIntent();
        this.localGuardSync('ALBUM_VALIDATE',()=>{if(Date.now()>=expiresAtMs||this.localGuardRejects('targetMatch',!target.isCurrent())||this.localGuardRejects('sourceMatch',!port.isLocalSourceCurrent?.())||this.localGuardRejects('snapshotMatch',!isLocalAlbumQueueSnapshot(value,request)))throw this.cancelled();});
        if((value as LocalSelectionQueueSnapshot).sources.some(source=>source.snapshot.segment!==null))return {status:'unsupported' as const,reason:'LOCAL_SEGMENT_UNSUPPORTED' as const};
        albumQueue=value as LocalSelectionQueueSnapshot;
      }
      // 票据仍只接收点击曲的原九字段；整组仅保存逻辑快照，按当前/下一曲原上限解析。
      const {album:_album,context:_context,...sourceSelection}=request;
      let playbackIndex=0;
      let capture:LocalSourceCaptureResult;
      this.localGuardEnter('SOURCE_CAPTURE');
      try{capture=request.action==='PLAY_NOW' ? await port.captureLocalSource!(sourceSelection) : await this.enqueue(()=>{guardIntent();this.localGuardEnter('SOURCE_CAPTURE');return port.captureLocalSource!(sourceSelection);});}catch(error){this.localGuardFailure('SOURCE_CAPTURE',error);guardIntent();if(error instanceof LocalSourcePreparationError && error.code==='SEGMENT_UNSUPPORTED' || error instanceof DatasetOwnerDispatchError && error.failure.error.code==='INVALID_IPC_REQUEST' && error.failure.error.message.startsWith('[LOCAL_SEGMENT_UNSUPPORTED]'))return {status:'unsupported' as const,reason:'LOCAL_SEGMENT_UNSUPPORTED' as const};throw error;}
      this.localGuardSuccess('SOURCE_CAPTURE');
      const fence=this.localGuardSync('SOURCE_VALIDATE',()=>new LocalSourceFence(capture.buffer));
      try {
        guardIntent();this.localGuardSync('SOURCE_VALIDATE',()=>{if(this.localGuardRejects('intentMatch',this.localClosing) || this.localGuardRejects('targetMatch',!target.isCurrent()) || this.localGuardRejects('sourceMatch',!port.isLocalSourceCurrent?.()) || this.localGuardRejects('fenceMatch',!fence.current)) throw this.cancelled();});
        const item:QueueItem={entryId:randomUUID(),logicalSource:{kind:'local_file',snapshot:{sourceKind:'local_file',trackId:capture.facts.track.id,assetId:capture.facts.asset.id,libraryRootId:capture.facts.root.id,sourceRootId:capture.facts.sourceRoot.id,rootRevision:capture.facts.root.revision,fileRevision:capture.facts.asset.fileRevision,locationRevision:capture.facts.asset.locationRevision,selectionRevision:capture.facts.track.selectionRevision,segment:capture.facts.track.segment},edition:null},trackId:request.local_track_id,qualityPreference:'auto',resolvedSource:'local_file',track:toTrackSummary(capture.metadata),localSelection:structuredClone(sourceSelection),localExpected:capture.facts,localTarget:target,
          local:{local_track_id:request.local_track_id,asset_id:request.asset_id,asset_revision:request.expected_asset_revision,selection_revision:capture.facts.track.selectionRevision,location_revision:capture.facts.asset.locationRevision,root_revision:capture.facts.root.revision}};
        if(request.action==='PLAY_NOW') {
          let items=[item];
          if(albumQueue){
            const originalAlbum=albumQueue,selected=originalAlbum.sources[originalAlbum.startIndex]!;
            this.localGuardSync('SELECTED_SNAPSHOT',()=>{if(this.localGuardRejects('snapshotMatch',item.logicalSource?.kind!=='local_file'||!isDeepStrictEqual(selected.snapshot,item.logicalSource.snapshot)))throw this.cancelled();});
            items=originalAlbum.sources.map((source):QueueItem=>({entryId:randomUUID(),trackId:source.snapshot.trackId,qualityPreference:'auto',resolvedSource:'local_file',
              logicalSource:structuredClone(source),local:localQueueIdentity(source),...(originalAlbum.edition?{edition:{...originalAlbum.edition}}:{}),preflight:{state:'NEEDS_REVALIDATION',reason:null}}));
            playbackIndex=originalAlbum.startIndex;
            items[playbackIndex]={...items[playbackIndex]!,track:toTrackSummary(capture.metadata),localSelection:structuredClone(sourceSelection),localExpected:capture.facts,localTarget:target};
          }
          this.localGuardEnter('STOP_ACTIVE');
          try{await this.stopActive();}catch(error){this.localGuardFailure('STOP_ACTIVE',error);throw error;}
          this.localGuardSuccess('STOP_ACTIVE');guardIntent();this.localGuardSync('SOURCE_VALIDATE',()=>{if(this.localGuardRejects('targetMatch',!target.isCurrent()) || this.localGuardRejects('fenceMatch',!fence.current)) throw this.cancelled();});
          const replacementId=randomUUID();this.localGuardEnter('PERSIST_QUEUE');
          try{await this.persistQueue(items,playbackIndex,replacementId);}catch(error){this.localGuardFailure('PERSIST_QUEUE',error);throw error;}
          this.localGuardSuccess('PERSIST_QUEUE');this.queueId=replacementId;this.queue=items;this.queueIndex=playbackIndex;this.queueProjectionDirty=true;guardIntent();
        } else {
          const current=()=>{guardIntent();this.localGuardSync('SOURCE_VALIDATE',()=>{if(this.localGuardRejects('targetMatch',!target.isCurrent()) || this.localGuardRejects('sourceMatch',!port.isLocalSourceCurrent?.()) || this.localGuardRejects('fenceMatch',!fence.current))throw this.cancelled();});};
          const insert=request.action==='PLAY_NEXT_MB_QUEUE';
          this.localGuardEnter('PERSIST_QUEUE');
          try {
            if(this.queueContext || this.pendingQueueContexts.size)await this.editContextQueue([item],insert,current);
            else await this.commitQueueEdit([item],insert,current);
          }catch(error){this.localGuardFailure('PERSIST_QUEUE',error);throw error;}
          this.localGuardSuccess('PERSIST_QUEUE');
          current();
        }
      } catch(error){this.localGuardCaught(error);throw error;}
      finally {
        this.localGuardEnter('RELEASE_CAPTURE');
        try{fence.revoke();await port.releaseLocalSource!(capture.ticketId);}catch(error){this.localGuardFailure('RELEASE_CAPTURE',error,true);throw error;}
        this.localGuardSuccess('RELEASE_CAPTURE');
      }
      guardIntent();
      if(request.action==='PLAY_NOW') {this.localGuardEnter('START_QUEUE');await this.startQueueIndex(playbackIndex,false,undefined,true);this.localGuardSuccess('START_QUEUE');}
      return {status:'accepted',request_id:request.request_id,action:request.action} as LocalPlayAccepted;
      }catch(error){this.localGuardCaught(error);throw error;}
    };
    const work=request.action==='PLAY_NOW' ? this.enqueuePlayback(run,true) : run();
    const entry = {fingerprint,work,guardTrace:trace,receipt:{status:'pending',request_id:request.request_id,action:request.action} as import('@music-bridge/contracts').LocalPlayReceipt};
    this.localRequests.set(request.request_id,entry);
    void work.then(result => {
      entry.receipt={status:'received',request_id:request.request_id,action:request.action,result:structuredClone(result)};
      this.finishLocalGuard(trace);
    }, error => {
      this.finishLocalGuard(trace,error,true);
      const code=asBridgeError(error).code;
      const reason:import('@music-bridge/contracts').LocalPlayRejection = code==='ROON_ZONE_NOT_SELECTED' || code==='ROON_NOT_PAIRED' ? 'TARGET_UNAVAILABLE'
        : code==='ROON_MEDIA_ERROR' ? 'MEDIA_ERROR' : code==='ROON_TIMEOUT' ? 'ROON_TIMEOUT'
        : error instanceof LocalSourcePrepareInterrupted ? code==='READ_CANCELLED' ? 'REQUEST_REJECTED' : 'SOURCE_UNAVAILABLE'
        : error instanceof LocalSourcePreparationError || error instanceof DatasetOwnerDispatchError ? 'SOURCE_UNAVAILABLE'
        : code==='BAD_REQUEST' ? 'REQUEST_REJECTED' : 'INTERNAL_ERROR';
      entry.receipt={status:'rejected',request_id:request.request_id,action:request.action,reason};
    });
    return work;
  }
  /** 不捕获来源、不更改队列、不调用 SDK；Core 重启后的 missing 仍保留未确认。 */
  getLocalPlayReceipt(request:LocalPlayRequest):import('@music-bridge/contracts').LocalPlayReceipt {
    if(!isLocalPlayRequest(request))throw this.cancelled();
    const prior=this.localRequests.get(request.request_id);
    if(!prior)return {status:'missing',request_id:request.request_id,action:request.action};
    if(prior.fingerprint!==JSON.stringify(request))throw this.cancelled();
    return structuredClone(prior.receipt);
  }
  /** 只按实际本地owner/attempt读取，不接受Provider匹配或Renderer提供的Source路径。 */
  isCurrentLocalLyrics(context: LocalFileLyricsContext): boolean {
    const owner = this.owner, observation = this.localObservation, facts = owner?.local?.capture.facts;
    return !!owner && owner.source === 'local_file' && this.localCurrent(owner) && !!facts && !!observation
      && !['idle','stopping','error'].includes(this.playbackState) && context.playbackGeneration === this.playbackGeneration
      && facts.track.id === context.localTrackId && facts.asset.id === context.assetId && facts.asset.fileRevision === context.assetRevision
      && observation.local_track_id === context.localTrackId && observation.asset_id === context.assetId
      && observation.asset_revision === context.assetRevision && observation.attempt_id === context.attemptId;
  }
  async readLocalLyrics(context: LocalFileLyricsContext): Promise<LyricsSnapshot> {
    if (!this.isCurrentLocalLyrics(context)) return emptyLyricsSnapshot('unavailable');
    const local = this.owner!.local!, port = this.dependencies.localSources;
    if (!port?.readLocalSourceLyrics) return emptyLyricsSnapshot('unavailable');
    if (!local.lyricsFlight) {
      const flight = Promise.resolve().then(() => port.readLocalSourceLyrics!(local.capture.ticketId));
      local.lyricsFlight = flight; this.trackLocalCleanup(flight);
      void flight.finally(() => { if (local.lyricsFlight === flight) delete local.lyricsFlight; }).catch(() => undefined);
    }
    const started = performance.now(); logLibraryOperation('metadata', 'lyrics.local.core', 'start');
    try {
      const result = await local.lyricsFlight, current = this.isCurrentLocalLyrics(context);
      logLibraryOperation('metadata', 'lyrics.local.core', current ? 'complete' : 'cancelled', { code: current ? result.status === 'ready' ? 'READY' : 'UNAVAILABLE' : 'STALE_ATTEMPT', count: current ? result.lines.length : 0, elapsedMs: performance.now() - started });
      return current ? result : emptyLyricsSnapshot('unavailable');
    } catch (error) {
      const current = this.isCurrentLocalLyrics(context);
      logLibraryOperation('metadata', 'lyrics.local.core', current ? 'error' : 'cancelled', { code: current ? 'OWNER_READ_FAILED' : 'STALE_ATTEMPT', elapsedMs: performance.now() - started });
      if (!current) return emptyLyricsSnapshot('unavailable'); throw error;
    }
  }
  private localCurrent(owner:PlaybackOwner):boolean {
    try{owner.queueAdmission?.();this.assertLocalProtocol();}catch{return false;}
    return !this.localClosing && this.owner===owner && !owner.abort.signal.aborted && this.queue[this.queueIndex]===owner.item
      && !!owner.local?.fence.current && owner.local.target.isCurrent() && this.dependencies.localSources?.isLocalSourceCurrent?.()===true;
  }
  private assertLocal(owner:PlaybackOwner):void {if(!this.localCurrent(owner))throw this.cancelled();}
  private logLocalEvidence(owner:PlaybackOwner,fields:LocalPlaybackEvidenceFields):void {
    try {
      const evidence=owner.local?.evidence;if(!evidence)return;
      const current=this.localCurrent(owner),confirmed=owner.local?.session?.isConfirmed()===true;
      this.dependencies.logger.info('local_playback_evidence',{schemaVersion:1,component:'controller',diagnosticId:evidence.diagnosticId,
        ...fields,elapsedMs:Math.min(86_400_000,Math.max(0,Math.floor(performance.now()-evidence.startedAtMs))),
        sessionConfirmed:confirmed,currentOwned:current && confirmed && owner.local?.isOwned?.()===true,staleCallback:!current});
    } catch { /* 日志和只读诊断谓词不改变原状态、预算或失败回执。 */ }
  }
  private recordLocalPositionEvidence(owner:PlaybackOwner,event:RoonTimeEvent|undefined):void {
    try {
      const evidence=owner.local?.evidence;
      if(!evidence || evidence.positionSamples===2 || !event || !Number.isSafeInteger(event.revision) || event.revision<0
        || (event.source!=='audio-input' && event.source!=='zone') || !this.localCurrent(owner)
        || owner.local?.session?.isConfirmed()!==true || owner.local.isOwned?.()!==true)return;
      const positionAdvanced=evidence.firstPositionMs!==undefined && event.positionMs>evidence.firstPositionMs;
      if(evidence.positionSamples===1 && !positionAdvanced)return;
      evidence.firstPositionMs ??= event.positionMs;evidence.positionSamples=evidence.positionSamples===0?1:2;
      this.logLocalEvidence(owner,{stage:'position',sampleSequence:evidence.positionSamples,source:event.source,positionMs:event.positionMs,positionAdvanced});
    } catch { /* 最多首个确认位置和后续一次推进；不创建定时器或每Time输出。 */ }
  }
  private localPhase(owner:PlaybackOwner,phase:LocalPlaybackObservationLeaf['phase'],event:LocalPlaybackObservationLeaf['roon_observation']['event']='NONE'):void {
    if(this.owner!==owner || !this.localObservation) return;
    const confirmed=owner.local?.session?.isConfirmed()===true;
    this.localObservation={...this.localObservation,phase,ownership:phase==='PLAYING'||phase==='PAUSED'?'MB_OWNED':phase==='OWNERSHIP_LOST'?'UNKNOWN':phase==='SUBMISSION_UNKNOWN'?'UNKNOWN':phase==='ENDED'||phase==='FAILED'||phase==='CANCELLED'?'NONE':'MB_PENDING',
      roon_observation:{event,observed:event!=='NONE'&&event!=='UNKNOWN',correlation:confirmed?'ATTEMPT_CONFIRMED':'UNKNOWN'}};
    try {
      const evidence=owner.local?.evidence;
      if(evidence && !evidence.phases.has(phase)){evidence.phases.add(phase);this.logLocalEvidence(owner,{stage:'roon-phase',phase});}
    } catch { /* 每个固定phase最多一次，UNKNOWN只作为观测，不取得重发许可。 */ }
  }
  private localTerminal(owner:PlaybackOwner,phase:'FAILED'|'CANCELLED'|'ENDED',errorCode:string|null=null,event:LocalPlaybackObservationLeaf['roon_observation']['event']='NONE'):void {
    if(this.owner!==owner || !this.localObservation)return;
    this.localPhase(owner,phase,event);this.localObservation={...this.localObservation!,error_code:errorCode};
  }
  private markLocalStopRequested(owner:PlaybackOwner|undefined=this.owner):void {
    if(owner?.local)owner.localStopRequested=true;
  }
  private isOnlyLocalStopCancellation(owner:PlaybackOwner):boolean {
    const local=owner.local;
    if(!owner.localStopRequested || !local || this.owner!==owner || this.queue[this.queueIndex]!==owner.item)return false;
    try {
      const observation=this.localObservation,lane=local.lane,attempt=local.poolAttempt,facts=local.capture.facts;
      const laneId=lane===undefined?undefined:this.localLaneIds[lane];
      // 只绑定该owner原NOT_STARTED观测；不能借新意图取消此前其它owner的未知提交。
      if(owner.dispatched===false && observation && local.session===undefined && local.isOwned===undefined
        && lane!==undefined && attempt!==undefined && laneId!==undefined
        && this.localLaneBusy[lane]===true && this.localLaneAttempts[lane]===attempt
        && observation.attempt_id===`${laneId}_${attempt}` && observation.delivery_state==='NOT_STARTED'
        && (observation.phase==='PREPARING' || observation.phase==='SUBMITTING')
        && observation.ownership==='MB_PENDING' && observation.queue_owner==='MB'
        && observation.session_epoch===null && observation.roon_observation.event==='NONE' && observation.roon_observation.observed===false
        && observation.local_track_id===facts.track.id && observation.asset_id===facts.asset.id && observation.asset_revision===facts.asset.fileRevision
        && (!owner.item.localSelection || observation.request_id===owner.item.localSelection.request_id))return true;
      this.assertLocalProtocol();
      if(!local.fence.current || !local.target.isCurrent() || this.dependencies.localSources?.isLocalSourceCurrent?.()!==true)return false;
      const lease=local.lease,failure=lease?.failureCode,state=lease?.state;
      if(failure!==undefined && failure!==null || state==='CLOSING' || state==='CLOSED') {
        // 原lease的authority也包含取消意图；只识别同lane/attempt由此留下的STALE_ATTEMPT。
        return failure==='STALE_ATTEMPT' && local.lane!==undefined && local.poolAttempt!==undefined
          && this.localLaneBusy[local.lane]===true && this.localLaneAttempts[local.lane]===local.poolAttempt;
      }
      return true;
    } catch { return false; }
  }
  private loseLocal(owner:PlaybackOwner,definiteLoss=false):void {
    if(this.owner!==owner || !definiteLoss && this.isOnlyLocalStopCancellation(owner))return;
    this.localPhase(owner,'OWNERSHIP_LOST','UNKNOWN');this.clearActiveResources();this.playbackState='error';this.cancelNextPreparation();this.notifyPlaybackChanged();
  }
  private trackLocalCleanup(work:Promise<unknown>):void {this.localTasks.add(work);void work.finally(()=>this.localTasks.delete(work)).catch(()=>undefined);}
  private localPreparationControl(owner:PlaybackOwner):LocalSourcePrepareControl {
    const trace=this.localGuardContext.getStore();
    return {signal:owner.abort.signal,deadlineAtMs:performance.now()+30_000,
      onQuiet:quiet=>{if(owner.local)owner.local.preparationQuiet=quiet;},
      onStage:(stage,phase,error)=>this.withLocalGuardTrace(trace,()=>{
        // 每个子阶段只记开始及失败；正常完成由下一阶段或 LEASE_REGISTER 证明，保持原 64 条预算。
        if(stage==='SOURCE_CLEANUP'){
          if(phase==='started'&&trace)this.emitLocalGuard(trace,stage,'started');
          else if(phase==='failed')this.localGuardFailure(stage,error,true);
        }else if(phase==='started')this.localGuardEnter(stage);
        else if(phase==='failed')this.localGuardFailure(stage,error);
      })};
  }
  private waitLocalLane(owner:PlaybackOwner):Promise<void> {
    const quiet=Promise.allSettled(this.localLaneQuiet).then(()=>undefined);
    return new Promise<void>((resolve,reject)=>{
      let settled=false;
      const finish=(error?:unknown):void=>{if(settled)return;settled=true;clearTimeout(timer);owner.abort.signal.removeEventListener('abort',cancel);if(error===undefined)resolve();else reject(error);};
      const cancel=():void=>finish(new LocalSourcePrepareInterrupted('READ_CANCELLED',quiet));
      const timer=setTimeout(()=>finish(new LocalSourcePrepareInterrupted('READ_DEADLINE',quiet)),30_000);timer.unref();
      owner.abort.signal.addEventListener('abort',cancel,{once:true});if(owner.abort.signal.aborted)cancel();
      void quiet.then(()=>finish(),error=>finish(error));
    });
  }
  private disposeLocal(owner:PlaybackOwner):Promise<void> {
    const local=owner.local;if(!local) return Promise.resolve();
    if(local.disposing)return local.disposing;
    const quiet=local.disposing = (async()=>{local.fence.revoke();if(local.timer)clearInterval(local.timer);await local.renewing?.catch(()=>undefined);
      // 原歌词读取返回前仍持有同ticket fence；先join真实FD，不能让releaseLocalSource提前报quiet。
      await local.lyricsFlight?.catch(()=>undefined);
      await local.preparationQuiet;
      if(owner.token){this.dependencies.gateway.clearStageObserver(owner.token);await this.dependencies.registry.revokeLocal(owner.token);}else await local.lease?.close();
      await this.dependencies.localSources?.releaseLocalSource?.(local.capture.ticketId);
      if(local.lane!==undefined){this.localLaneBusy[local.lane]=false;queueMicrotask(()=>this.scheduleNextPreparation());}
    })();
    try {
      const trace=this.localGuardContext.getStore();
      if(trace){this.localGuardEnter('RELEASE_CAPTURE');void quiet.then(()=>this.emitLocalGuard(trace,'RELEASE_CAPTURE','succeeded'),error=>{
        this.withLocalGuardTrace(trace,()=>this.localGuardFailure('RELEASE_CAPTURE',error,true));
      }).catch(()=>{});}
    }catch{ /* 只观察原quiet，不替换原Promise或关闭结果。 */ }
    if(local.lane!==undefined)this.localLaneQuiet[local.lane]=quiet;return quiet;
  }
  private assertLogicalLocalFacts(item:QueueItem,capture:LocalSourceCaptureResult):void {
    const source=item.logicalSource;if(source?.kind!=='local_file')return;
    const expected=source.snapshot,f=capture.facts;
    if(this.localGuardRejects('factsMatch',expected.trackId!==f.track.id,1) || this.localGuardRejects('factsMatch',expected.assetId!==f.asset.id,2) || this.localGuardRejects('factsMatch',expected.libraryRootId!==f.root.id,3) || this.localGuardRejects('factsMatch',expected.sourceRootId!==f.sourceRoot.id,4)
      || this.localGuardRejects('factsMatch',expected.fileRevision!==f.asset.fileRevision,6) || this.localGuardRejects('factsMatch',expected.rootRevision!==f.root.revision,5) || this.localGuardRejects('factsMatch',expected.locationRevision!==f.asset.locationRevision,7)
      || this.localGuardRejects('factsMatch',expected.selectionRevision!==f.track.selectionRevision,8) || this.localGuardRejects('factsMatch',!isDeepStrictEqual(expected.segment,f.track.segment),9)) {
      throw new BridgeError('BAD_REQUEST','本地队列来源修订已变化，请明确重新点播。',{httpStatus:409});
    }
  }
  private assertLocalProtocol():void {
    if(this.dependencies.isLocalPlaybackAllowed?.()===false)throw new BridgeError('BAD_REQUEST','LOCAL_PLAYBACK_PROTOCOL_UNSUPPORTED',{httpStatus:409});
  }
  private async resolveQueueEdition(item:QueueItem):Promise<void> {
    const source=item.logicalSource;if(source?.kind!=='local_file' || !source.edition)return;
    const expectedDatasetId=this.queueDatasetId;
    if(expectedDatasetId===undefined)throw new BridgeError('BAD_REQUEST','LOCAL_EDITION_NEEDS_REVALIDATION',{httpStatus:409});
    let result:unknown;
    try{result=await this.dependencies.localSources!.dispatch({version:1,id:randomUUID(),command:'localCatalog.edition',payload:{editionId:source.edition.id},expectedDatasetId});}
    catch{throw new BridgeError('BAD_REQUEST','LOCAL_EDITION_NEEDS_REVALIDATION',{httpStatus:409});}
    if(!isAlbumEdition(result) || result.id!==source.edition.id || result.revision!==source.edition.revision)throw new BridgeError('BAD_REQUEST','LOCAL_EDITION_NEEDS_REVALIDATION',{httpStatus:409});
    item.edition={id:result.id,revision:result.revision,title:result.title,edition:result.edition};
    this.queueProjectionDirty=true;
  }
  private localRequest(item:QueueItem):LocalPlayRequest {
    this.assertLocalProtocol();
    if(item.localSelection)return item.localSelection;
    const source=item.logicalSource,target=this.dependencies.roon.captureLocalTarget?.();
    if(source?.kind!=='local_file' || source.snapshot.segment!==null || !target?.isCurrent())throw this.cancelled();
    return {schema_version:'1.2',request_id:randomUUID(),route:'roon_audio_input',source_kind:'local_file',local_track_id:source.snapshot.trackId,asset_id:source.snapshot.assetId,
      expected_asset_revision:source.snapshot.fileRevision,target:{...target.target},action:'PLAY_NOW'};
  }
  private cancelLocalNext():void {
    const next=this.localNext;if(!next)return;this.localNext=undefined;next.owner.abort.abort();
    const quiet=next.work.catch(()=>undefined).then(()=>this.disposeLocal(next.owner));this.trackLocalCleanup(quiet);
  }
  private scheduleLocalNext(item:QueueItem):void {
    if(this.localNext?.item===item)return;
    this.cancelLocalNext();if(this.localClosing || this.playbackState!=='playing' || this.dependencies.isLocalPlaybackAllowed?.()===false)return;
    const lane=this.localLaneBusy.findIndex(busy=>!busy);if(lane<0)return;
    const port=this.dependencies.localSources;if(!port?.captureLocalSource || !port.releaseLocalSource)return;
    const target=this.dependencies.roon.captureLocalTarget?.();if(!target?.isCurrent())return;
    const owner:PlaybackOwner={item,zoneId:target.target.zone_id,source:'local_file',abort:new AbortController(),preparing:true,dispatched:false};
    this.localLaneBusy[lane]=true;const attempt=++this.localLaneAttempts[lane]!;
    const next:{item:QueueItem;owner:PlaybackOwner;created:number;promoted?:PlaybackOwner;work:Promise<void>;failed:boolean}={item,owner,created:this.now(),work:Promise.resolve(),failed:false};
    const current=()=>next.promoted?this.owner===next.promoted && !next.promoted.abort.signal.aborted && this.queue[this.queueIndex]===item && target.isCurrent() && !!owner.local?.fence.current && port.isLocalSourceCurrent?.()===true:this.localNext===next && !owner.abort.signal.aborted && this.queue[this.queueIndex+1]===item
      && target.isCurrent() && !!owner.local?.fence.current && port.isLocalSourceCurrent?.()===true;
    this.localNext=next;
    next.work=(async()=>{
      try {
        const request=this.localRequest(item);await this.resolveQueueEdition(item);
        if(this.localNext!==next || owner.abort.signal.aborted || this.queue[this.queueIndex+1]!==item || !target.isCurrent())throw this.cancelled();
        this.assertLocalProtocol();const capture=await port.captureLocalSource!(request),fence=new LocalSourceFence(capture.buffer);
        owner.local={capture,fence,target,lane,poolAttempt:attempt};
        this.assertLogicalLocalFacts(item,capture);
        if(!current())throw this.cancelled();
        const registration=await this.dependencies.registry.registerLocalSource({source_kind:'local_file',status:'prepared_descriptor',request_id:request.request_id,action:request.action,target:request.target,facts:capture.facts},
          {ownerId:this.localLaneIds[lane]!,attempt,isCurrent:current},capture.format,this.localPreparationControl(owner));
        owner.token=registration.token;owner.local.lease=registration.lease;
        if(!current())throw this.cancelled();item.preflight={state:'PREPARED',reason:null};this.queueProjectionDirty=true;this.notifyPlaybackChanged();
      } catch(error) {
        next.failed=true;item.preflight={state:'FAILED',reason:'SOURCE_UNAVAILABLE'};this.queueProjectionDirty=true;
        const quiet=this.disposeLocal(owner);if(error instanceof LocalSourcePrepareInterrupted)this.trackLocalCleanup(quiet);else await quiet;
        if(!owner.local)this.localLaneBusy[lane]=false;if(!this.localClosing)this.notifyPlaybackChanged();
        // 明确失败，当前entry保留；不扫描后面的曲目，也不循环重开。
      }
    })();this.trackLocalCleanup(next.work);
  }

  private async startLocalItem(item:QueueItem,owner:PlaybackOwner):Promise<void> {
    try {
    this.localGuardEnter('TARGET_CAPTURE');
    const request=this.localRequest(item),port=this.dependencies.localSources!,target=(item.localTarget ?? this.dependencies.roon.captureLocalTarget?.())!;
    if(this.localGuardRejects('targetMatch',!target?.isCurrent()) || this.localGuardRejects('sourceMatch',!port.captureLocalSource) || this.localGuardRejects('sourceMatch',!port.releaseLocalSource)) throw this.cancelled();
    this.localGuardSuccess('TARGET_CAPTURE');
    this.guardOwner(owner);this.localGuardEnter('EDITION_RESOLVE');
    try{await this.resolveQueueEdition(item);}catch(error){this.localGuardFailure('EDITION_RESOLVE',error);throw error;}
    this.localGuardSuccess('EDITION_RESOLVE');this.guardOwner(owner);this.assertLocalProtocol();if(this.localGuardRejects('targetMatch',!target.isCurrent()))throw this.cancelled();++this.localAttempt;
    let registration:{token:string;lease:AssetLease}|undefined;
    const prepared=this.localNext;
    this.localGuardEnter('SECOND_FACTS');
    if(prepared?.item===item){
      prepared.promoted=owner;
      await prepared.work;this.guardOwner(owner);
      if(prepared.failed)throw new BridgeError('BAD_REQUEST','下一曲预检失败，请明确重新点播。',{httpStatus:409});
      if(this.now()-prepared.created>=30_000 || prepared.owner.local?.lease?.state!=='PREPARED'){
        this.cancelLocalNext();await this.disposeLocal(prepared.owner);this.guardOwner(owner);
      }else{
        if(!await port.revalidateLocalSource?.(prepared.owner.local!.capture.ticketId)){this.cancelLocalNext();throw this.cancelled();}
        this.guardOwner(owner);if(!target.isCurrent() || !prepared.owner.local!.fence.current)throw this.cancelled();
        owner.local=prepared.owner.local;owner.token=prepared.owner.token!;prepared.promoted=owner;this.localNext=undefined;
        registration={token:owner.token!,lease:owner.local!.lease!};
      }
    }
    if(!owner.local){
      const lane=this.localLaneBusy.findIndex(busy=>!busy);if(lane<0){await this.waitLocalLane(owner);this.guardOwner(owner);}
      const available=this.localLaneBusy.findIndex(busy=>!busy);if(available<0)throw this.cancelled();
      this.localLaneBusy[available]=true;const poolAttempt=++this.localLaneAttempts[available]!;
      this.localGuardEnter('SECOND_CAPTURE');
      let capture:LocalSourceCaptureResult;try{capture=await port.captureLocalSource!(request);}catch(error){this.localGuardFailure('SECOND_CAPTURE',error);this.localLaneBusy[available]=false;throw error;}
      this.localGuardSuccess('SECOND_CAPTURE');this.localGuardEnter('SECOND_FACTS');
      const fence=new LocalSourceFence(capture.buffer);owner.local={capture,fence,target,lane:available,poolAttempt};
      if(this.localGuardRejects('intentMatch',this.owner!==owner) || this.localGuardRejects('intentMatch',owner.abort.signal.aborted) || this.localGuardRejects('targetMatch',!target.isCurrent()) || this.localGuardRejects('fenceMatch',!fence.current) || item.localExpected && this.localGuardRejects('factsMatch',JSON.stringify(capture.facts)!==JSON.stringify(item.localExpected))) {
        // 原取消Error仍在原cleanup之后创建；此行只保存已发生的拒绝决定。
        this.localGuardFailure('SECOND_FACTS',undefined);
        await this.disposeLocal(owner);this.localGuardEnter('SECOND_FACTS');throw this.cancelled();
      }
      try{this.assertLogicalLocalFacts(item,capture);}catch(error){this.localGuardFailure('SECOND_FACTS',error);await this.disposeLocal(owner);throw error;}
    }
    this.localGuardSuccess('SECOND_FACTS');
    const {capture,fence}=owner.local,attempt=owner.local.poolAttempt!;
    const metadata={...capture.metadata,...(item.edition?.edition?{version:item.edition.edition}:{})};
    const fileParameters=safeFileParameters(capture.fileParameters);
    this.localObservation={schema_version:'1.2',request_id:request.request_id,attempt_id:`${this.localLaneIds[owner.local.lane!]!}_${attempt}`,intent_generation:String(this.playbackGeneration),route:'roon_audio_input',local_track_id:request.local_track_id,asset_id:request.asset_id,asset_revision:request.expected_asset_revision,target:{...request.target},session_epoch:null,
      phase:'PREPARING',ownership:'MB_PENDING',queue_owner:'MB',delivery_state:'NOT_STARTED',roon_observation:{event:'NONE',observed:false,correlation:'UNKNOWN'},position_ms:null,
      quality:untestedAudioQuality(),...(fileParameters?{file_parameters:fileParameters}:{}),error_code:null};
    this.playbackState='preparing';this.notifyPlaybackChanged();
    try {
      this.localGuardEnter('LEASE_REGISTER');
      registration ??= await this.dependencies.registry.registerLocalSource({source_kind:'local_file',status:'prepared_descriptor',request_id:request.request_id,action:request.action,target:request.target,facts:capture.facts},{ownerId:this.localLaneIds[owner.local.lane!]!,attempt,isCurrent:()=>this.localCurrent(owner)},capture.format,this.localPreparationControl(owner));
      owner.token=registration.token;owner.local.lease=registration.lease;
      this.assertLocal(owner);this.activeToken=registration.token;
      this.activePlayback={track:metadata,qualityPreference:'auto',requestedQuality:'standard',actualQuality:'unknown',...(capture.format?{format:capture.format}:{}),sizeBytes:registration.lease.size,startedAt:new Date(this.now()).toISOString()};
      const local=owner.local;
      try {
        local.evidence={diagnosticId:'diag-local-'+createHash('sha256').update('musicbridge-local-playback-evidence-v1\0').update(request.request_id)
          .update('\0'+String(this.playbackGeneration)+'\0'+String(attempt)).digest('hex'),
          startedAtMs:performance.now(),phases:new Set(),positionSamples:0};
        const trace=this.localGuardContext.getStore();if(trace&&!trace.closed)trace.diagnosticId=local.evidence.diagnosticId;
      } catch { /* 私有绑定不可用时保持原播放链；不输出原request UUID。 */ }
      local.timer=setInterval(()=>{
        if(!this.localCurrent(owner) || local.lease?.state==='CLOSED'){this.loseLocal(owner);return;}
        if(!local.session || local.renewing || this.now() < (local.nextRenewal ?? 0)) return;local.nextRenewal=this.now()+30_000;
        let step:'source'|'current'|'lease'='source';
        const work=(async()=>{if(!await port.revalidateLocalSource?.(capture.ticketId))throw this.cancelled();step='current';this.assertLocal(owner);step='lease';local.lease!.renew(local.session!);})();
        local.renewing=work;void work.catch(()=>this.loseLocal(owner,step!=='current')).finally(()=>{delete local.renewing;});
      },250);local.timer.unref();
      item.preflight={state:'PREPARED',reason:null};this.queueProjectionDirty=true;
      this.localPhase(owner,'SUBMITTING');this.notifyPlaybackChanged();
      this.localGuardSuccess('LEASE_REGISTER');
      let gatewayStage:RoonGatewayStage='none';
      this.localGuardEnter('SDK_SUBMIT');
      await this.device(()=>{this.assertLocal(owner);return this.dependencies.roon.play({...this.ownerOptions(owner),mediaUrl:this.dependencies.gateway.localStreamUrl(registration!.token,stage=>{gatewayStage=stage;},
        local.evidence?{diagnosticId:local.evidence.diagnosticId,isCurrent:()=>this.localCurrent(owner),isOwned:()=>local.session?.isConfirmed()===true && local.isOwned?.()===true}:undefined),iconUrl:this.dependencies.gateway.iconUrl(),metadata,
        ...(this.dependencies.localPlaybackDiagnostics ? {onLocalDiagnostic:this.dependencies.localPlaybackDiagnostics()} : {}),
        gatewayStage:()=>gatewayStage,
        onDispatch:()=>{this.assertLocal(owner);owner.dispatched=true;this.localObservation={...this.localObservation!,delivery_state:'UNKNOWN'};this.localPhase(owner,'AWAITING_ROON');},
        onLocalSession:observation=>{
          if(this.owner!==owner)return;
          if(observation.event==='OWNERSHIP_LOST'){
            if(!owner.abort.signal.aborted)local.isOwned=observation.isOwned;
            let definiteLoss=true;
            if(owner.localStopRequested)try{definiteLoss=observation.isOwned()!==true;}catch{/* 明确会话事实无法读取时仍保守拒绝。 */}
            this.loseLocal(owner,definiteLoss);return;
          }
          if(owner.abort.signal.aborted)return;
          local.isOwned=observation.isOwned;
          if(observation.event==='DISPATCHED')return;
          if(!this.localCurrent(owner)){this.loseLocal(owner);return;}
          if(observation.event==='UNKNOWN'){this.localPhase(owner,'SUBMISSION_UNKNOWN','UNKNOWN');this.playbackState='error';this.notifyPlaybackChanged();return;}
          this.assertLocal(owner);
          if(observation.event==='SESSION' && observation.sessionId){
            local.isOwned=observation.isOwned;local.session={attempt,sessionId:observation.sessionId,isConfirmed:observation.isConfirmed};local.lease!.confirmSession(local.session);
            this.localObservation={...this.localObservation!,session_epoch:randomUUID()};
            this.positionContext={generation:this.playbackGeneration,trackId:metadata.id,zoneId:owner.zoneId,source:'local_file',playbackEpoch:observation.generation};
          } else if(observation.event==='PLAYING'){if(!local.session?.isConfirmed())return;local.lease!.renew(local.session);this.localPhase(owner,'PLAYING','PLAYING');this.playbackState='playing';owner.preparing=false;}
          else if(observation.event==='PAUSED'){if(!local.session?.isConfirmed())return;local.lease!.pause(local.session);this.localPhase(owner,'PAUSED','PAUSED');this.playbackState='paused';owner.preparing=false;}
          else if(observation.event==='ENDED')this.localPhase(owner,'ENDED','SESSION_ENDED');
          this.notifyPlaybackChanged();
        }});});
      this.assertLocal(owner);
      this.localGuardSuccess('SDK_SUBMIT');
    } catch(error) {
      this.localGuardCaught(error);
      item.preflight={state:'FAILED',reason:'SOURCE_UNAVAILABLE'};this.queueProjectionDirty=true;
      if(!owner.dispatched || !this.localCurrent(owner) || asBridgeError(error).code==='ROON_MEDIA_ERROR'){
        if(this.localObservation?.phase!=='OWNERSHIP_LOST')this.localTerminal(owner,owner.abort.signal.aborted?'CANCELLED':'FAILED',owner.abort.signal.aborted?null:asBridgeError(error).code,asBridgeError(error).code==='ROON_MEDIA_ERROR'?'ERROR':'NONE');
        const quiet=this.disposeLocal(owner);if(error instanceof LocalSourcePrepareInterrupted)this.trackLocalCleanup(quiet);else await quiet;
        throw error;
      }
      this.localPhase(owner,'SUBMISSION_UNKNOWN','UNKNOWN');this.playbackState='error';this.notifyPlaybackChanged();
      // 已发送只能调和本次会话；返回受理结果不会重复begin/play或入队。
    }
    }catch(error){this.localGuardCaught(error);throw error;}
  }
  async playRoon(input: NativeRoonQueueInput): Promise<BridgeState> {
    return this.replaceRoonQueue([input], 0);
  }

  async replaceRoonContext(lease: RoonPlaybackContextLease): Promise<BridgeState> {
    let items: QueueItem[], zoneId: string, selectedIndex: number;
    try {
      const initial = lease.initial;
      zoneId = initial.items[initial.selectedIndex]?.zoneId ?? '';
      this.validateContextPage(initial, initial.offset);
      if (!Number.isSafeInteger(initial.selectedIndex) || initial.selectedIndex < 0 || initial.selectedIndex >= initial.items.length
        || initial.items.length > MAX_QUEUE_ITEMS || !lease.isCurrent()
        || zoneId !== this.dependencies.roon.getState().selectedZoneId) throw this.cancelled();
      items = initial.items.map(value => normalizeContextItem(value, zoneId));
      selectedIndex = initial.selectedIndex;
    } catch (error) { lease.release(); throw error; }
    this.cancelQueueContext();
    let activate!: () => void;
    const ready = new Promise<void>(resolve => { activate = resolve; });
    const context: QueueContext = { lease, generation: this.queueContextGeneration, zoneId,
      abort: new AbortController(), before: lease.initial.offset, after: lease.initial.nextOffset,
      afterComplete: lease.initial.complete, loading: 0, tail: Promise.resolve(), ready, activate };
    this.pendingQueueContexts.add(context);
    try {
      return await this.enqueuePlayback(async () => {
        this.assertQueueContext(context, true);
        await this.stopActive();
        this.guardCommand(); this.assertQueueContext(context, true);
        this.pendingQueueContexts.delete(context);
        this.queueContext = context;
        ++this.queueHydrationGeneration;
        const replacementId=randomUUID();await this.persistQueue(items,selectedIndex,replacementId);
        this.queueId=replacementId;this.queue = items; this.queueIndex = selectedIndex;this.queueProjectionDirty=true;this.guardCommand();this.assertQueueContext(context);
        context.activate();
        this.queueProjectionDirty = true; this.clearPlaybackIssue();
        await this.startQueueIndex(this.queueIndex, false,undefined,true);
        this.assertQueueContext(context);
        // Transport 确认后只预取一页；读页不进入设备链或播放命令链。
        if (!context.afterComplete) void this.expandQueueContext(context, 'after', false).catch(() => undefined);
        return this.getState();
      });
    } finally {
      if (this.pendingQueueContexts.delete(context)) { context.abort.abort(); context.activate(); lease.release(); }
    }
  }

  private cancelQueueContext(): void {
    this.cancelQueueHydration();
    this.cancelNextPreparation();
    ++this.queueContextGeneration;
    const contexts = new Set(this.pendingQueueContexts);
    if (this.queueContext) contexts.add(this.queueContext);
    this.pendingQueueContexts.clear(); this.queueContext = undefined; this.lastContextPlaying = undefined;
    for (const context of contexts) { context.abort.abort(); context.activate(); context.lease.release(); }
    if (contexts.size) this.queueProjectionDirty = true;
  }

  private assertQueueContext(context: QueueContext, pending = false): void {
    if (context.abort.signal.aborted || context.generation !== this.queueContextGeneration
      || (this.queueContext !== context && !(pending && this.pendingQueueContexts.has(context)))) throw this.cancelled();
    if (!context.lease.isCurrent() || this.dependencies.roon.getState().selectedZoneId !== context.zoneId) {
      throw new BridgeError('ROON_LIBRARY_INVALID_REFERENCE', '播放上下文已失效，请重新选择', { httpStatus: 409 });
    }
  }

  private validateContextPage(page: RoonPlaybackContextPage, offset: number, limit?: number): void {
    if (!Number.isSafeInteger(page.offset) || page.offset !== offset || page.offset < 0
      || !Number.isSafeInteger(page.nextOffset) || page.nextOffset < offset
      || (limit !== undefined && page.nextOffset > offset + limit)
      || typeof page.complete !== 'boolean' || (!page.complete && page.nextOffset === offset)
      || page.items.length > page.nextOffset - offset) {
      throw new BridgeError('ROON_LIBRARY_REQUEST_FAILED', '播放上下文页游标无效', { httpStatus: 502 });
    }
  }

  private contextCapacity(length: number): void {
    if (length > MAX_QUEUE_ITEMS) throw new BridgeError('BAD_REQUEST', '播放队列容量已满', { httpStatus: 413, details: { capacity: MAX_QUEUE_ITEMS } });
  }

  private async readQueueContext(context: QueueContext, offset: number, limit: number): Promise<{ page: RoonPlaybackContextPage; items: QueueItem[] }> {
    this.assertQueueContext(context);
    const work = context.lease.read({ offset, limit }, { signal: context.abort.signal,
      isCurrent: () => this.queueContext === context && context.generation === this.queueContextGeneration
        && !context.abort.signal.aborted && context.lease.isCurrent()
        && this.dependencies.roon.getState().selectedZoneId === context.zoneId });
    const page = await new Promise<RoonPlaybackContextPage>((resolve, reject) => {
      const cancel = () => { context.abort.signal.removeEventListener('abort', cancel); reject(this.cancelled()); };
      context.abort.signal.addEventListener('abort', cancel, { once: true });
      void work.then(resolve, reject).finally(() => context.abort.signal.removeEventListener('abort', cancel));
      if (context.abort.signal.aborted) cancel();
    });
    this.assertQueueContext(context);
    this.validateContextPage(page, offset, limit);
    return { page, items: page.items.map(value => normalizeContextItem(value, context.zoneId)) };
  }

  private contextTask<T>(context: QueueContext, operation: () => Promise<T>): Promise<T> {
    const result = context.tail.then(async () => {
      context.loading++; delete context.error;
      this.queueProjectionDirty = true; this.notifyPlaybackChanged();
      try { this.assertQueueContext(context); return await operation(); }
      catch (error) {
        if (this.queueContext === context && !context.abort.signal.aborted) {
          context.error = asBridgeError(error).httpStatus === 413 ? 'capacity'
            : !context.lease.isCurrent() || this.dependencies.roon.getState().selectedZoneId !== context.zoneId ? 'expired' : 'retryable';
        }
        throw error;
      } finally {
        context.loading--;
        if (this.queueContext === context && !context.abort.signal.aborted) { this.queueProjectionDirty = true; this.notifyPlaybackChanged(); }
      }
    });
    context.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private expandQueueContext(context: QueueContext, direction: 'before' | 'after', requireTrack: boolean): Promise<void> {
    return this.contextTask(context, async () => {
      let attempts = 0;
      while (++attempts <= 128) {
        this.assertQueueContext(context);
        // 等待同一gate期间，既有预取或drain可能已经补出邻项。
        if (requireTrack && this.queue[this.queueIndex + (direction === 'after' ? 1 : -1)]) return;
        if (direction === 'after' && context.afterComplete || direction === 'before' && context.before === 0) return;
        const before = context.before, after = context.after;
        const offset = direction === 'after' ? after : Math.max(0, before - 100);
        let cursor = offset; const items: QueueItem[] = []; let complete = false;
        do {
          const loaded = await this.readQueueContext(context, cursor, direction === 'after' ? 100 : before - cursor);
          items.push(...loaded.items); cursor = loaded.page.nextOffset; complete = loaded.page.complete;
          this.contextCapacity(this.queue.length + items.length);
          if (direction === 'before' && complete && cursor < before) throw this.cancelled();
        } while (direction === 'before' && cursor < before);
        await this.enqueue(async () => {
          this.assertQueueContext(context);
          if (context.before !== before || context.after !== after) throw this.cancelled();
          this.contextCapacity(this.queue.length + items.length);
          const original=this.queue,current = original[this.queueIndex];
          const candidate=direction==='after'?[...original,...items]:[...items,...original];
          const selected=current?candidate.indexOf(current):this.queueIndex;
          await this.persistQueue(candidate,selected);
          this.queue=candidate;this.queueIndex=selected;
          if (direction === 'after') { context.after = cursor; context.afterComplete = complete; }
          else { context.before = offset; this.rebaseInsertion(items.length); }
          this.queueProjectionDirty = true; this.notifyPlaybackChanged();this.assertQueueContext(context);
        });
        if (!requireTrack || items.length) return;
      }
      throw new BridgeError('ROON_LIBRARY_REQUEST_FAILED', '播放上下文读取工作量超限', { httpStatus: 502 });
    });
  }

  private rebaseInsertion(prefix: number): void {
    if (this.nextInsertionQueueIndex !== undefined) this.nextInsertionQueueIndex += prefix;
    if (this.nextInsertionCursor !== undefined) this.nextInsertionCursor += prefix;
  }

  private editContextQueue(items: QueueItem[], insert: boolean, assertCurrent:()=>void=()=>undefined): Promise<BridgeState> {
    const context = this.queueContext ?? [...this.pendingQueueContexts].at(-1);
    const epoch = this.commandEpoch;
    const result = this.queueEditTail.then(async () => {
      assertCurrent();
      if (epoch !== this.commandEpoch) throw this.cancelled();
      if (!context) return this.commitQueueEdit(items, insert,assertCurrent);
      await context.ready;assertCurrent();
      return this.contextTask(context, async () => {
        assertCurrent();this.assertQueueContext(context);
        this.contextCapacity(this.queue.length + items.length);
        const before: QueueItem[] = [], after: QueueItem[] = [];
        const originalBefore = context.before, originalAfter = context.after;
        let cursor = 0, reads = 0;
        while (cursor < originalBefore) {
          if (++reads > 128) throw new BridgeError('ROON_LIBRARY_REQUEST_FAILED', '播放上下文读取工作量超限', { httpStatus: 502 });
          const loaded = await this.readQueueContext(context, cursor, Math.min(100, originalBefore - cursor));
          assertCurrent();before.push(...loaded.items); cursor = loaded.page.nextOffset;
          this.contextCapacity(this.queue.length + before.length + items.length);
          if (loaded.page.complete && cursor < originalBefore) throw this.cancelled();
        }
        cursor = originalAfter; let complete = context.afterComplete;
        while (!complete) {
          if (++reads > 128) throw new BridgeError('ROON_LIBRARY_REQUEST_FAILED', '播放上下文读取工作量超限', { httpStatus: 502 });
          const loaded = await this.readQueueContext(context, cursor, 100);
          assertCurrent();after.push(...loaded.items); cursor = loaded.page.nextOffset; complete = loaded.page.complete;
          this.contextCapacity(this.queue.length + before.length + after.length + items.length);
        }
        return this.enqueue(async () => {
          assertCurrent();this.assertQueueContext(context);
          if (epoch !== this.commandEpoch || context.before !== originalBefore || context.after !== originalAfter) throw this.cancelled();
          this.contextCapacity(this.queue.length + before.length + after.length + items.length);
          const original=this.queue,current = original[this.queueIndex],materialized=[...before,...original,...after];
          const selected=current?materialized.indexOf(current):-1;
          const slot=insert?this.nextInsertionQueueIndex===this.queueIndex&&this.nextInsertionCursor!==undefined?this.nextInsertionCursor+before.length:selected>=0?selected+1:0:materialized.length;
          const candidate=[...materialized.slice(0,slot),...items,...materialized.slice(slot)];
          await this.persistQueue(candidate,selected);
          this.queue=candidate;this.queueIndex=selected;this.queueProjectionDirty=true;this.notifyPlaybackChanged();assertCurrent();this.assertQueueContext(context);
          this.queue=materialized;this.rebaseInsertion(before.length);this.queueIndex=selected;
          context.before = 0; context.after = cursor; context.afterComplete = true;
          this.applyQueueEdit(items,insert);this.notifyPlaybackChanged();
          return this.getState();
        });
      });
    });
    this.queueEditTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private applyQueueEdit(items: QueueItem[], insert: boolean): void {
    this.cancelNextPreparation();
    const index = insert ? this.nextInsertionQueueIndex === this.queueIndex && this.nextInsertionCursor !== undefined
      ? this.nextInsertionCursor : this.queueIndex >= 0 ? this.queueIndex + 1 : 0 : this.queue.length;
    this.queue.splice(index, 0, ...items);
    if (insert) { this.nextInsertionQueueIndex = this.queueIndex; this.nextInsertionCursor = index + items.length; }
    const generation = this.cancelQueueHydration();
    this.queueProjectionDirty = true; this.scheduleQueueHydration(items, generation);
  }

  private commitQueueEdit(items: QueueItem[], insert: boolean, assertCurrent:()=>void=()=>undefined): Promise<BridgeState> {
    const result=this.queueEditTail.then(()=>this.enqueue(async () => {
      assertCurrent();this.contextCapacity(this.queue.length + items.length);
      const old=this.queue,index=this.queueIndex;
      const slot=insert?this.nextInsertionQueueIndex===index&&this.nextInsertionCursor!==undefined?this.nextInsertionCursor:index>=0?index+1:0:old.length;
      const candidate=[...old.slice(0,slot),...items,...old.slice(slot)];
      await this.persistQueue(candidate,index);
      this.queue=candidate;this.queueIndex=index;this.cancelNextPreparation();
      if(insert){this.nextInsertionQueueIndex=index;this.nextInsertionCursor=slot+items.length;}
      this.queueProjectionDirty=true;this.notifyPlaybackChanged();assertCurrent();
      const generation=this.cancelQueueHydration();this.scheduleQueueHydration(items,generation);return this.getState();
    }));
    this.queueEditTail=result.then(()=>undefined,()=>undefined);return result;
  }

  async replaceRoonQueue(inputs: readonly NativeRoonQueueInput[], startIndex: number): Promise<BridgeState> {
    if (inputs.length === 0 || inputs.length > MAX_QUEUE_ITEMS
      || !Number.isSafeInteger(startIndex) || startIndex < 0 || startIndex >= inputs.length) {
      throw new BridgeError('BAD_REQUEST', '本地播放队列或起始位置无效', { httpStatus: 400 });
    }
    // 在停止现有播放前验证整个上下文，避免无效请求破坏当前队列。
    const items = inputs.map(normalizeNativeRoonQueueItem);
    this.cancelQueueContext();
    return this.enqueuePlayback(async () => {
      ++this.queueHydrationGeneration;
      await this.stopActive();
      this.guardCommand();
      const replacementId=randomUUID();await this.persistQueue(items,startIndex,replacementId);
      this.queueId=replacementId;this.queue = items;
      this.queueIndex = startIndex;
      this.queueProjectionDirty = true;this.guardCommand();
      this.clearPlaybackIssue();
      await this.startQueueIndex(startIndex, false,undefined,true);
      return this.getState();
    });
  }

  async replaceQueue(
    items: readonly QueueInput[],
    startIndex = 0,
  ): Promise<BridgeState> {
    if (items.length === 0) {
      throw new BridgeError('BAD_REQUEST', 'Queue must contain at least one item', {
        httpStatus: 400,
      });
    }
    if (items.length > MAX_QUEUE_ITEMS) {
      throw new BridgeError('BAD_REQUEST', 'Playback queue capacity exceeded', {
        httpStatus: 413,
        details: { capacity: MAX_QUEUE_ITEMS },
      });
    }
    if (!Number.isSafeInteger(startIndex) || startIndex < 0 || startIndex >= items.length) {
      throw new BridgeError('BAD_REQUEST', 'Queue start index is invalid', {
        httpStatus: 400,
      });
    }
    const normalizedItems = items.map((item) => normalizeQueueItem(item));
    this.cancelQueueContext();

    return this.enqueuePlayback(async () => {
      const hydrationGeneration = this.cancelQueueHydration();
      const activePlayback = this.activePlayback;
      const preserveActivePlayback = activePlayback !== undefined &&
        this.playbackState === 'playing' &&
        normalizedItems[startIndex]?.trackId === activePlayback.track.id &&
        normalizedItems[startIndex]?.qualityPreference === activePlayback.qualityPreference;

      if (preserveActivePlayback && activePlayback) {
        const activeItem = normalizedItems[startIndex];
        if (activeItem) {
          activeItem.track = toTrackSummary(activePlayback.track);
          activeItem.requestedQuality = activePlayback.requestedQuality;
          activeItem.actualQuality = activePlayback.actualQuality;
        }
        const replacementId=randomUUID();await this.persistQueue(normalizedItems,startIndex,replacementId);
        if (this.owner && activeItem) this.owner.item = activeItem;
        this.queueId=replacementId;this.queue = normalizedItems;
        this.queueIndex = startIndex;
        this.queueProjectionDirty = true;this.guardCommand();
        this.clearPlaybackIssue();
        this.notifyPlaybackChanged();
        this.scheduleQueueHydration(normalizedItems, hydrationGeneration);
        return this.getState();
      }

      await this.stopActive();
      this.guardCommand();
      const replacementId=randomUUID();await this.persistQueue(normalizedItems,startIndex,replacementId);
      this.queueId=replacementId;this.queue = normalizedItems;
      this.queueIndex = startIndex;
      this.queueProjectionDirty = true;this.guardCommand();
      this.clearPlaybackIssue();
      await this.startQueueIndex(startIndex, true,undefined,true);
      return this.getState();
    }, true);
  }

  async appendQueue(
    items: readonly QueueInput[],
  ): Promise<BridgeState> {
    const normalizedItems = items.map((item) => normalizeQueueItem(item));
    if (normalizedItems.length === 0) return this.getState();
    if (this.queueContext || this.pendingQueueContexts.size) return this.editContextQueue(normalizedItems, false);

    return this.enqueue(async () => {
      const availableSlots = Math.max(0, MAX_QUEUE_ITEMS - this.queue.length);
      if (normalizedItems.length > availableSlots) {
        throw new BridgeError('BAD_REQUEST', 'Playback queue capacity exceeded', {
          httpStatus: 413,
          details: { capacity: MAX_QUEUE_ITEMS },
        });
      }
      if(normalizedItems.length>availableSlots)throw new BridgeError('BAD_REQUEST','队列容量超过5000，未追加任何条目。',{httpStatus:413});
      const acceptedItems = normalizedItems;
      if (acceptedItems.length === 0) return this.getState();

      const hydrationGeneration = this.cancelQueueHydration();
      const shouldHydrateInline = acceptedItems.length <= QUEUE_HYDRATION_INLINE_LIMIT;
      await this.persistQueue([...this.queue,...acceptedItems],this.queueIndex);
      this.queue.push(...acceptedItems);
      this.queueProjectionDirty = true;
      this.notifyPlaybackChanged();
      if (shouldHydrateInline) {
        await this.hydrateQueueItems(acceptedItems, hydrationGeneration);
        if (hydrationGeneration === this.queueHydrationGeneration) this.notifyPlaybackChanged();
      } else this.scheduleQueueHydration(acceptedItems, hydrationGeneration);
      return this.getState();
    });
  }

  async appendRoon(input: NativeRoonQueueInput): Promise<BridgeState> {
    const item = normalizeNativeRoonQueueItem(input);
    if (this.queueContext || this.pendingQueueContexts.size) return this.editContextQueue([item], false);
    return this.enqueue(async () => {
      const availableSlots = Math.max(0, MAX_QUEUE_ITEMS - this.queue.length);
      if(availableSlots===0)throw new BridgeError('BAD_REQUEST','队列容量超过5000。',{httpStatus:413});
      await this.persistQueue([...this.queue,item],this.queueIndex);
      this.queue.push(item);
      this.queueProjectionDirty = true;
      this.notifyPlaybackChanged();
      return this.getState();
    });
  }

  async insertNext(
    items: readonly QueueInput[],
  ): Promise<BridgeState> {
    const normalizedItems = items.map((item) => normalizeQueueItem(item));
    if (normalizedItems.length === 0) return this.getState();
    if (this.queueContext || this.pendingQueueContexts.size) return this.editContextQueue(normalizedItems, true);

    return this.enqueue(async () => {
      const availableSlots = Math.max(0, MAX_QUEUE_ITEMS - this.queue.length);
      if (normalizedItems.length > availableSlots) {
        throw new BridgeError('BAD_REQUEST', 'Playback queue capacity exceeded', {
          httpStatus: 413,
          details: { capacity: MAX_QUEUE_ITEMS },
        });
      }
      if(normalizedItems.length>availableSlots)throw new BridgeError('BAD_REQUEST','队列容量超过5000，未追加任何条目。',{httpStatus:413});
      const acceptedItems = normalizedItems;
      if (acceptedItems.length === 0) return this.getState();

      const hydrationGeneration = this.cancelQueueHydration();
      const shouldHydrateInline = acceptedItems.length <= QUEUE_HYDRATION_INLINE_LIMIT;
      const insertionIndex = this.nextInsertionQueueIndex === this.queueIndex && this.nextInsertionCursor !== undefined
        ? this.nextInsertionCursor
        : this.queueIndex >= 0 ? this.queueIndex + 1 : 0;
      await this.persistQueue([...this.queue.slice(0,insertionIndex),...acceptedItems,...this.queue.slice(insertionIndex)],this.queueIndex);
      this.queue.splice(insertionIndex, 0, ...acceptedItems);
      this.queueProjectionDirty = true;
      this.nextInsertionQueueIndex = this.queueIndex;
      this.nextInsertionCursor = insertionIndex + acceptedItems.length;
      this.notifyPlaybackChanged();
      if (shouldHydrateInline) {
        await this.hydrateQueueItems(acceptedItems, hydrationGeneration);
        if (hydrationGeneration === this.queueHydrationGeneration) this.notifyPlaybackChanged();
      } else this.scheduleQueueHydration(acceptedItems, hydrationGeneration);
      return this.getState();
    });
  }

  async insertNextRoon(input: NativeRoonQueueInput): Promise<BridgeState> {
    const item = normalizeNativeRoonQueueItem(input);
    if (this.queueContext || this.pendingQueueContexts.size) return this.editContextQueue([item], true);
    return this.enqueue(async () => {
      if (this.queue.length >= MAX_QUEUE_ITEMS)throw new BridgeError('BAD_REQUEST','队列容量超过5000。',{httpStatus:413});
      const insertionIndex = this.queueIndex >= 0 ? this.queueIndex + 1 : 0;
      await this.persistQueue([...this.queue.slice(0,insertionIndex),item,...this.queue.slice(insertionIndex)],this.queueIndex);
      this.queue.splice(insertionIndex, 0, item);
      this.queueProjectionDirty = true;
      this.notifyPlaybackChanged();
      return this.getState();
    });
  }

  async next(): Promise<BridgeState> {
    const context = this.queueContext;
    if (context) return this.withDisplayReadPriority(() => this.navigateQueueContext(context, 1));
    return this.enqueuePlayback(async () => {
      this.syncNativeRoonTrack();
      if (this.activeRoonPlayback && (this.queueIndex < 0 || this.queueIndex >= this.queue.length - 1)) {
        return this.navigateNativeRoon('next');
      }
      if (this.queueIndex < 0) return this.getState();
      const nextIndex = this.queueIndex + 1;
      await this.stopActive();
      if (nextIndex >= this.queue.length) {
        this.playbackState = 'idle';
        this.notifyPlaybackChanged();
        return this.getState();
      }
      await this.startQueueIndex(nextIndex, true);
      return this.getState();
    });
  }

  async previous(): Promise<BridgeState> {
    const context = this.queueContext;
    if (context) return this.withDisplayReadPriority(() => this.navigateQueueContext(context, -1));
    return this.enqueuePlayback(async () => {
      this.syncNativeRoonTrack();
      if (this.activeRoonPlayback && this.queueIndex <= 0) return this.navigateNativeRoon('previous');
      if (this.queueIndex <= 0) return this.getState();
      const previousIndex = this.queueIndex - 1;
      await this.stopActive();
      await this.startQueueIndex(previousIndex, true);
      return this.getState();
    });
  }

  private async navigateQueueContext(context: QueueContext, direction: 1 | -1): Promise<BridgeState> {
    this.assertQueueContext(context);
    const epoch = this.commandEpoch;
    const anchor = this.queue[this.queueIndex];
    let waited = false;
    const needsPage = direction === 1 ? this.queueIndex === this.queue.length - 1 && !context.afterComplete
      : this.queueIndex === 0 && context.before > 0;
    if (needsPage) { waited = true; await this.expandQueueContext(context, direction === 1 ? 'after' : 'before', true); }
    if (epoch !== this.commandEpoch) throw this.cancelled();
    return this.enqueuePlayback(async () => {
      this.assertQueueContext(context);
      if (waited && this.queue[this.queueIndex] !== anchor) throw this.cancelled();
      const target = this.queue[this.queueIndex + direction];
      if (!target) return this.getState();
      await this.stopActive(); this.guardCommand(); this.assertQueueContext(context);
      const index = this.queue.indexOf(target);
      if (index < 0) throw this.cancelled();
      await this.startQueueIndex(index, true); return this.getState();
    });
  }

  private canNavigateNativeRoon(direction: 'next' | 'previous'): boolean {
    const active = this.activeRoonPlayback;
    const observation = this.dependencies.roon.getSelectedZonePlaybackObservation?.();
    return Boolean(active && this.dependencies.roon.control && !this.nativeRoonStopRequested
      && (this.playbackState === 'playing' || this.playbackState === 'paused')
      && observation?.zoneId === active.zoneId
      && this.dependencies.roon.getState().selectedZoneId === active.zoneId
      && (observation?.state === 'playing' || observation?.state === 'paused')
      && (direction === 'next' ? observation.canNext : observation.canPrevious) === true);
  }

  private async navigateNativeRoon(direction: 'next' | 'previous'): Promise<BridgeState> {
    if (!this.canNavigateNativeRoon(direction)) return this.getState();
    // 不先 stop，也不伪造队列索引；实际曲目与封面由后续 Transport 观测确认。
    const owner = this.owner;
    const generation = this.playbackGeneration;
    await this.device(() => { this.guardControl(owner, generation); return this.dependencies.roon.control!(direction, this.ownerOptions(owner)); });
    this.guardControl(owner, generation);
    this.syncRoonTransportState();
    return this.getState();
  }

  private applyNativeArtwork(track: TrackSummary, observation: RoonPlaybackObservation): boolean {
    if (!observation.imageKey || !this.dependencies.roonLibrary?.resolveArtwork) return false;
    try {
      const reference = this.dependencies.roonLibrary.resolveArtwork(observation.imageKey);
      if (!reference || track.artworkReference === reference) return false;
      track.artworkReference = reference;
      delete track.artworkUrl;
      return true;
    } catch {
      // 封面不可用不阻断播放，原始图片键与内部错误不进入日志或公开状态。
      return false;
    }
  }

  async playQueueIndex(index: number): Promise<BridgeState> {
    if (!Number.isSafeInteger(index) || index < 0 || index >= MAX_QUEUE_ITEMS) {
      throw new BridgeError('BAD_REQUEST', 'Playback queue index is invalid', {
        httpStatus: 400,
      });
    }
    const contextGeneration = this.queueContextGeneration;
    // 活跃上下文的数字索引只属于受理时窗口；prefix可以在命令链等待期间提交。
    // 没有已安装上下文时，保留legacy在实际执行时读取新队列的语义。
    const acceptedTarget = this.queueContext ? this.queue[index] : undefined;
    if (this.queueContext && !acceptedTarget) throw new BridgeError('BAD_REQUEST', 'Playback queue index is invalid', { httpStatus: 400 });
    return this.enqueuePlayback(async () => {
      if (contextGeneration !== this.queueContextGeneration) throw this.cancelled();
      const target = acceptedTarget ?? this.queue[index];
      if (!target || !this.queue.includes(target)) {
        throw new BridgeError('BAD_REQUEST', 'Playback queue index is invalid', {
          httpStatus: 400,
        });
      }
      if (
        target === this.queue[this.queueIndex] &&
        (this.activePlayback !== undefined || this.activeRoonPlayback !== undefined)
      ) {
        return this.getState();
      }
      await this.stopActive();
      this.guardCommand();
      if (contextGeneration !== this.queueContextGeneration) throw this.cancelled();
      const currentIndex = this.queue.indexOf(target);
      if (currentIndex < 0) throw this.cancelled();
      await this.startQueueIndex(currentIndex, true);
      return this.getState();
    });
  }

  async stop(): Promise<BridgeState> {
    return this.withDisplayReadPriority(() => {
      this.markLocalStopRequested();
      this.cancelQueueContext();
      ++this.commandEpoch;
      this.owner?.abort.abort();
      return this.enqueue(async () => {
        this.cancelNextPreparation();
        await this.stopActive(true);
        return this.getState();
      });
    });
  }

  async pause(): Promise<BridgeState> {
    return this.enqueueControl(async () => {
      const owner = this.owner;
      const generation = this.playbackGeneration;
      const options = this.ownerOptions(owner);
      const snapshot = this.getPlaybackState();
      if (
        (!this.activePlayback && !this.activeRoonPlayback) ||
        snapshot.state !== 'playing' ||
        !snapshot.canPause
      ) {
        throw new BridgeError('BAD_REQUEST', 'Roon pause is not currently available', {
          httpStatus: 409,
          details: { reason: 'pause_unsupported', ownerDecision: 'OWNER_DECISION_REQUIRED' },
        });
      }
      this.playbackState = 'pausing';
      this.notifyPlaybackChanged();
      try {
        if (this.activeRoonPlayback) await this.device(() => { this.guardControl(owner, generation); return this.dependencies.roonLibrary?.pause(options) ?? Promise.resolve(); });
        else await this.device(() => { this.guardControl(owner, generation); return this.dependencies.roon.pause(options); });
        this.guardControl(owner, generation);
        const changed = this.getPlaybackState().state !== 'paused'
          || this.lastPlaybackError !== undefined
          || this.lastPlaybackIssue !== undefined;
        this.playbackState = 'paused';
        this.lastPlaybackError = undefined;
        this.lastPlaybackIssue = undefined;
        if (changed) this.notifyPlaybackChanged();
        return this.getState();
      } catch (error) {
        this.guardControl(owner, generation);
        this.playbackState = this.observedTransportPlaybackState('playing');
        this.setPlaybackError(error);
        this.notifyPlaybackChanged();
        throw error;
      }
    });
  }

  async stopRoonTransport(): Promise<BridgeState> {
    return this.withDisplayReadPriority(() => {
      this.markLocalStopRequested();
      this.cancelQueueContext();
      const zoneId = this.dependencies.roon.getState().selectedZoneId;
      ++this.commandEpoch;
      this.owner?.abort.abort();
      return this.enqueue(async () => {
        this.cancelNextPreparation();
        if (this.hasPlaybackOwnership()) {
          await this.stopActive(true);
        } else {
          try {
            await this.device(() => this.dependencies.roonLibrary?.stop(zoneId ? { expectedZoneId: zoneId } : {}) ?? Promise.resolve());
            this.displayReadUnconfirmedRoonStops.delete(zoneId);
          } catch (error) {
            this.displayReadUnconfirmedRoonStops.add(zoneId);
            throw error;
          }
        }
        return this.getState();
      });
    });
  }

  async resume(): Promise<BridgeState> {
    return this.enqueueControl(async () => {
      const owner = this.owner;
      const generation = this.playbackGeneration;
      const options = this.ownerOptions(owner);
      const snapshot = this.getPlaybackState();
      if (
        (!this.activePlayback && !this.activeRoonPlayback) ||
        snapshot.state !== 'paused' ||
        !snapshot.canResume
      ) {
        throw new BridgeError('BAD_REQUEST', 'Roon resume is not currently available', {
          httpStatus: 409,
          details: { reason: 'resume_unsupported', ownerDecision: 'OWNER_DECISION_REQUIRED' },
        });
      }
      this.playbackState = 'resuming';
      this.notifyPlaybackChanged();
      try {
        if (this.activeRoonPlayback) await this.device(() => { this.guardControl(owner, generation); return this.dependencies.roonLibrary?.resume(options) ?? Promise.resolve(); });
        else await this.device(() => { this.guardControl(owner, generation); return this.dependencies.roon.resume(options); });
        this.guardControl(owner, generation);
        const changed = this.getPlaybackState().state !== 'playing'
          || this.lastPlaybackError !== undefined
          || this.lastPlaybackIssue !== undefined;
        this.playbackState = 'playing';
        this.lastPlaybackError = undefined;
        this.lastPlaybackIssue = undefined;
        if (changed) this.notifyPlaybackChanged();
        return this.getState();
      } catch (error) {
        this.guardControl(owner, generation);
        this.playbackState = this.observedTransportPlaybackState('paused');
        this.setPlaybackError(error);
        this.notifyPlaybackChanged();
        throw error;
      }
    });
  }

  async seekRoonTransport(positionMs: number): Promise<BridgeState> {
    if (!Number.isSafeInteger(positionMs) || positionMs < 0 || positionMs > 24 * 60 * 60 * 1_000) {
      throw new BridgeError('BAD_REQUEST', 'Roon seek position is invalid', { httpStatus: 400 });
    }
    const zoneId = this.dependencies.roon.getState().selectedZoneId;
    const epoch = this.commandEpoch;
    return this.enqueueControl(async () => {
      if (this.stopUnknown) throw new BridgeError('ROON_TRANSPORT_UNAVAILABLE', '停止尚未确认，请重试停止', { httpStatus: 409 });
      if (!this.dependencies.roon.seek) throw new BridgeError('ROON_TRANSPORT_UNAVAILABLE', 'Roon seek is unavailable', { httpStatus: 409 });
      await this.device(() => {
        if (epoch !== this.commandEpoch) throw this.cancelled();
        if (this.stopUnknown) throw new BridgeError('ROON_TRANSPORT_UNAVAILABLE', '停止尚未确认，请重试停止', { httpStatus: 409 });
        return this.dependencies.roon.seek!(positionMs, zoneId ? { expectedZoneId: zoneId } : {});
      });
      return this.getState();
    });
  }

  async seek(positionMs: number): Promise<BridgeState> {
    if (
      !Number.isSafeInteger(positionMs) ||
      positionMs < 0 ||
      positionMs > 24 * 60 * 60 * 1_000
    ) {
      throw new BridgeError('BAD_REQUEST', 'Roon seek position is invalid', { httpStatus: 400 });
    }
    const acceptedOwner=this.owner,acceptedGeneration=this.playbackGeneration;
    const acceptedLocal=acceptedOwner?.source==='local_file'||acceptedOwner?.local!==undefined;
    if(acceptedLocal)this.guardLocalSeek(acceptedOwner,acceptedGeneration);
    return this.enqueueControl(async () => {
      if(!acceptedLocal&&(this.owner?.source==='local_file'||this.owner?.local!==undefined))throw this.cancelled();
      const owner = acceptedLocal?acceptedOwner:this.owner;
      const generation = acceptedLocal?acceptedGeneration:this.playbackGeneration;
      const current=()=>this.guardLocalSeek(owner,generation);
      const options:RoonOperationOptions=owner?.local ? {...this.ownerOptions(owner),assertCurrent:current,
        withDispatch:<T>(send:()=>T)=>owner.local!.fence.dispatch(send,current)} : this.ownerOptions(owner);
      const roonLibrary = this.dependencies.roonLibrary;
      if (this.activeRoonPlayback && roonLibrary?.seek) {
        await this.device(() => { current(); return roonLibrary.seek!(positionMs, options); });
        current();
        this.notifyPlaybackChanged('full');
        return this.getState();
      }
      if (this.activePlayback && this.dependencies.roon.seek) {
        const capturePaused = () => owner?.local && this.playbackState === 'paused' ? {
          local: owner.local, session: owner.local.session, sessionEpoch: this.localObservation?.session_epoch,
          positionContext: this.positionContext, adapterEpoch: this.dependencies.roon.getActivePlaybackEpoch?.(),
          observation: this.dependencies.roon.getSelectedZonePlaybackObservation?.(),
        } : null;
        const captured: { paused: ReturnType<typeof capturePaused> } = { paused: null };
        await this.device(() => { current(); captured.paused = capturePaused(); return this.dependencies.roon.seek!(positionMs, options); });
        current();
        const paused = captured.paused, observed = paused ? this.dependencies.roon.getSelectedZonePlaybackObservation?.() : undefined;
        const observedPosition = observed?.positionMs;
        // 普通暂停Time仍拒绝；只消费本次成功seek后同会话的新Zone实际位置，不用请求值补造进度。
        if (paused?.session && paused.sessionEpoch && paused.positionContext && paused.observation
          && owner?.local === paused.local && owner.local.session === paused.session
          && this.localObservation?.session_epoch === paused.sessionEpoch && this.localObservation.phase === 'PAUSED'
          && this.positionContext === paused.positionContext && paused.positionContext.source === 'local_file'
          && typeof paused.adapterEpoch === 'number' && Number.isSafeInteger(paused.adapterEpoch)
          && paused.positionContext.playbackEpoch === paused.adapterEpoch
          && this.dependencies.roon.getActivePlaybackEpoch?.() === paused.adapterEpoch
          && this.playbackState === 'paused' && this.dependencies.roon.getState().transportState === 'paused'
          && paused.observation.state === 'paused' && paused.observation.zoneId === owner.zoneId
          && Number.isSafeInteger(paused.observation.revision) && paused.observation.revision >= 0
          && observed?.state === 'paused' && observed.zoneId === owner.zoneId
          && Number.isSafeInteger(observed.revision) && observed.revision > paused.observation.revision
          && typeof observedPosition === 'number' && Number.isSafeInteger(observedPosition)
          && observedPosition >= 0 && observedPosition <= 24 * 60 * 60 * 1000 && Math.abs(observedPosition - positionMs) <= 1000) {
          this.localObservation = { ...this.localObservation, position_ms: observedPosition };
          this.positionMs = observedPosition;
        }
        this.notifyPlaybackChanged('full');
        return this.getState();
      }
      throw new BridgeError(
        'ROON_TRANSPORT_UNAVAILABLE',
        'Seek is unavailable for the active playback source',
        { httpStatus: 409 },
      );
    });
  }

  syncRoonTransportState(): void {
    if (!this.activePlayback && !this.activeRoonPlayback) return;
    if(this.owner?.local){ if(!this.localCurrent(this.owner)) this.loseLocal(this.owner); return; }
    this.syncNativeRoonTrack();
    const transportState = this.dependencies.roon.getState().transportState;
    if (
      transportState === 'paused'
      && (this.playbackState === 'playing'
        || this.playbackState === 'pausing'
        || this.playbackState === 'resuming')
    ) {
      this.playbackState = 'paused';
      this.notifyPlaybackChanged();
    } else if (
      transportState === 'playing'
      && (this.playbackState === 'paused' || this.playbackState === 'resuming')
    ) {
      this.playbackState = 'playing';
      this.notifyPlaybackChanged();
    } else if (this.activeRoonPlayback) {
      // 曲目未变化也可能更新原生上一首/下一首能力。
      // 仅发布公开投影中真实可见的变化，包含迟到的封面和导航能力。
      this.notifyPlaybackChangedIfDifferent();
    }
  }

  private syncNativeRoonTrack(): void {
    const active = this.activeRoonPlayback;
    const context = this.positionContext;
    const observation = this.dependencies.roon.getSelectedZonePlaybackObservation?.();
    const identity = observation?.nowPlaying;
    if (!active || !context || !observation || !identity?.title
      || (this.playbackState !== 'playing' && this.playbackState !== 'paused')
      || (observation.state !== 'playing' && observation.state !== 'paused')
      || this.nativeRoonStopRequested
      || context.generation !== this.playbackGeneration
      || observation.zoneId !== active.zoneId
      || observation.zoneId !== this.dependencies.roon.getState().selectedZoneId
      || observation.revision <= (context.minimumRevision ?? -1)) return;

    const previousIdentity = active.observedIdentity;
    const metadataChanged = previousIdentity !== undefined && (['artist', 'album'] as const).some(key =>
      previousIdentity[key] && identity[key]
      && normalizedPlaybackIdentity(previousIdentity[key]) !== normalizedPlaybackIdentity(identity[key]));
    if (timeEventMatchesTrack(observation, active.track) && !metadataChanged) {
      active.observedIdentity = { ...previousIdentity, ...identity };
      context.minimumRevision = observation.revision;
      this.applyNativeArtwork(active.track, observation);
      return;
    }

    // Roon 原生队列可以直接从 playing 切到另一首 playing，不会先发 stopped。
    // 唯一匹配已有队列项时复用其引用；队列外仅跟随观测，不伪造可播放引用。
    const matches = this.queue.flatMap((item, index) => item.roonReference && item.roonZoneId === observation.zoneId
      && item.track && timeEventMatchesTrack(observation, item.track)
      && (!identity.artist || item.track.artists.some(artist => normalizedPlaybackIdentity(artist) === normalizedPlaybackIdentity(identity.artist!)))
      && (!identity.album || normalizedPlaybackIdentity(item.track.album) === normalizedPlaybackIdentity(identity.album))
      ? [index] : []);
    const index = matches.length === 1 ? matches[0]! : -1;
    const item = this.queue[index];
    if (this.queueContext && !item) this.cancelQueueContext();
    const track: TrackSummary = item?.track ? cloneTrackSummary(item.track) : {
      id: BigInt(`0x${randomUUID().replaceAll('-', '')}`).toString(),
      title: identity.title,
      artists: identity.artist ? [identity.artist.slice(0, 256)] : [],
      album: identity.album || '未知专辑',
      ...(identity.durationMs !== undefined ? { durationMs: identity.durationMs } : {}),
    };
    this.applyNativeArtwork(track, observation);
    this.queueIndex = index;
    if (item) item.resolvedSource = 'roon';
    this.queueProjectionDirty = true;
    this.activeRoonPlayback = { track, zoneId: observation.zoneId, observedIdentity: { ...identity },
      ...(item?.roonReference ? { reference: item.roonReference } : {}) };
    this.playbackGeneration += 1;
    this.positionContext = { generation: this.playbackGeneration, trackId: track.id,
      zoneId: observation.zoneId, source: 'roon', minimumRevision: observation.revision };
    this.positionMs = observation.positionMs !== undefined && Number.isSafeInteger(observation.positionMs)
      && observation.positionMs >= 0 && observation.positionMs <= 24 * 60 * 60 * 1000 ? observation.positionMs : 0;
    this.playbackState = observation.state;
    this.cancelNextPreparation();
    this.clearPlaybackIssue();
    this.lastPositionPublishedAt = this.now();
    this.notifyPlaybackChanged();
  }

  async clearQueue(): Promise<BridgeState> {
    return this.withDisplayReadPriority(() => {
      this.markLocalStopRequested();
      this.cancelQueueContext();
      ++this.commandEpoch;
      this.owner?.abort.abort();
      return this.enqueue(async () => {
        this.cancelNextPreparation();
        this.queueHydrationGeneration += 1;
        await this.stopActive(true);
        this.queue = [];
        this.queueIndex = -1;
        this.queueProjectionDirty = true;
        this.playbackState = 'idle';
        this.clearPlaybackIssue();
        this.notifyPlaybackChanged();
        return this.getState();
      });
    });
  }

  async shutdown(): Promise<void> {
    this.markLocalStopRequested();
    this.localClosing=true;
    try { this.notifyReadPriorityChanged(); } catch { /* 关闭意图仍保持。 */ }
    this.dependencies.localSources?.sealLocalSources?.();
    this.cancelQueueContext();
    ++this.commandEpoch;
    this.owner?.abort.abort();
    try { await this.enqueue(async () => {
      this.cancelNextPreparation();
      this.queueHydrationGeneration += 1;
      await this.stopActive(true);
      this.queue = [];
      this.queueIndex = -1;
      this.queueProjectionDirty = true;
      this.playbackState = 'idle';
      this.clearPlaybackIssue();
      this.notifyPlaybackChanged();
      this.dependencies.registry.revokeAll();
    }); } finally {
      if(this.owner?.local)this.clearActiveResources();
      await Promise.allSettled([...this.localTasks,this.queueSaveTail]);
      await this.dependencies.registry.closeLocal();
    }
  }

  updateRoonTime(
    eventOrPosition: RoonTimeEvent | number,
    generation = this.playbackGeneration,
  ): boolean {
    const positionContext = this.positionContext;
    const selectedZoneId = this.dependencies.roon.getState().selectedZoneId;
    const event = typeof eventOrPosition === 'number' ? undefined : eventOrPosition;
    const positionMs = typeof eventOrPosition === 'number'
      ? eventOrPosition
      : eventOrPosition.positionMs;
    const activeTrack = this.activePlayback
      ? toTrackSummary(this.activePlayback.track)
      : this.activeRoonPlayback?.track;
    const activeSource: PlaybackResolvedSource | undefined = this.activePlayback
      ? (this.owner?.local ? 'local_file' : 'netease')
      : this.activeRoonPlayback
        ? 'roon'
        : undefined;
    if (
      generation !== this.playbackGeneration ||
      !positionContext ||
      positionContext.generation !== generation ||
      !activeTrack ||
      activeTrack.id !== positionContext.trackId ||
      activeSource !== positionContext.source ||
      selectedZoneId !== positionContext.zoneId ||
      (this.activePlayback === undefined && this.activeRoonPlayback === undefined) ||
      this.playbackState !== 'playing' ||
      this.dependencies.roon.getState().transportState !== 'playing' ||
      (event !== undefined && event.zoneId !== positionContext.zoneId) ||
      (event !== undefined
        && positionContext.minimumRevision !== undefined
        && event.revision < positionContext.minimumRevision) ||
      (event !== undefined
        && (positionContext.source === 'netease' || positionContext.source === 'local_file')
        && ((event.source !== 'audio-input' && event.source !== 'zone')
          || event.playbackEpoch !== positionContext.playbackEpoch)) ||
      (event !== undefined
        && positionContext.source === 'roon'
        && (event.source !== 'zone' || !timeEventMatchesTrack(event, activeTrack))) ||
      !Number.isSafeInteger(positionMs) ||
      positionMs < 0 ||
      positionMs > 24 * 60 * 60 * 1000
    ) {
      return false;
    }
    if(this.owner?.local){if(!this.localCurrent(this.owner))return false;this.localObservation={...this.localObservation!,position_ms:positionMs};}
    this.positionMs = positionMs;
    if(this.owner?.local)this.recordLocalPositionEvidence(this.owner,event);
    if (event && this.queueContext && positionContext.source === 'roon') this.recordContextPlaying(event);
    const now = this.now();
    if (now - this.lastPositionPublishedAt < 250) return true;
    this.lastPositionPublishedAt = now;
    this.notifyPlaybackChanged('position');
    return true;
  }

  handleRoonPlaybackState(state: RoonNativePlaybackState | undefined): void {
    const previous = this.lastNativeRoonPlaybackState;
    this.lastNativeRoonPlaybackState = state;
    const active = this.activeRoonPlayback;
    if (!active || this.nativeRoonStopRequested || this.playbackState === 'error') return;
    const unavailable = state === undefined;
    const stoppedFromPaused = state === 'stopped'
      && (previous === 'paused' || this.playbackState === 'paused');
    const ended = state === 'stopped' && (previous === 'playing' || previous === 'loading');
    if (this.queueContext && state === 'playing') {
      const observed = this.dependencies.roon.getSelectedZonePlaybackObservation?.();
      if (observed?.state === 'playing' && observed.positionMs !== undefined) this.recordContextPlaying({ ...observed, positionMs: observed.positionMs });
    }
    if (this.queueContext && state === 'stopped' && (previous === 'playing' || previous === 'paused' || previous === 'loading')) {
      this.handleContextStopped(this.queueContext, active, previous === 'playing');
      return;
    }
    if (!unavailable && !stoppedFromPaused && !ended) return;
    const stoppedObservation = stoppedFromPaused ? this.freshNativeStoppedObservation() : undefined;
    if (stoppedFromPaused && !stoppedObservation) return;
    const generation = this.playbackGeneration;
    void this.enqueue(async () => {
      if (this.nativeRoonStopRequested || this.playbackState === 'error' || this.activeRoonPlayback !== active
        || generation !== this.playbackGeneration) return;
      if (unavailable) {
        // 缺少观测不能证明停止或自然结束；冻结现态并保留再次停止的身份。
        this.playbackGeneration += 1;
        this.cancelNextPreparation();
        this.playbackState = 'error';
        this.lastPlaybackError = 'ROON_TRANSPORT_UNAVAILABLE';
        this.lastPlaybackIssue = {
          ...makePlaybackIssue('INTERNAL_ERROR', this.newDiagnosticId()),
          message: 'Roon 播放状态暂不可确认，请重新连接后重试停止',
        };
        this.qualityNotice = undefined;
        this.notifyPlaybackChanged();
        return;
      }
      if (stoppedObservation) {
        const current = this.freshNativeStoppedObservation();
        if (!current || current.revision < stoppedObservation.revision
          || this.lastNativeRoonPlaybackState !== 'stopped') return;
        // 暂停后确认停止不代表歌曲自然播完，不自动开启下一首。
        this.clearActiveResources();
        this.cancelNextPreparation();
        this.playbackState = 'idle';
        this.clearPlaybackIssue();
        this.notifyPlaybackChanged();
        this.dependencies.logger.info('roon_native_terminal', { reason: 'stopped' });
        return;
      }
      this.dependencies.logger.info('roon_native_terminal', { reason: 'ended' });
      const nextIndex = this.queueIndex >= 0 ? this.queueIndex + 1 : this.queue.length;
      this.clearActiveResources();
      if (nextIndex >= this.queue.length) {
        this.playbackState = 'idle';
        this.lastPlaybackError = undefined;
        this.lastPlaybackIssue = undefined;
        this.qualityNotice = undefined;
        this.notifyPlaybackChanged();
        return;
      }
      await this.startAutomaticQueueIndex(nextIndex);
    }).catch((error: unknown) => {
      const bridgeError = asBridgeError(error);
      this.dependencies.logger.warn('queue_advance_failed', { code: bridgeError.code });
    });
  }

  private contextIdentityMatches(observation: Pick<RoonPlaybackObservation, 'nowPlaying'>, track: TrackSummary, requireDuration = true): boolean {
    const identity = observation.nowPlaying;
    return Boolean(identity?.title && identity.artist && identity.album && track.artists.length > 0
      && normalizedPlaybackIdentity(identity.title) === normalizedPlaybackIdentity(track.title)
      && track.artists.some(artist => normalizedPlaybackIdentity(artist) === normalizedPlaybackIdentity(identity.artist!))
      && normalizedPlaybackIdentity(identity.album) === normalizedPlaybackIdentity(track.album)
      && (identity.durationMs !== undefined && track.durationMs !== undefined
        ? Math.abs(identity.durationMs - track.durationMs) <= 1_000 : !requireDuration));
  }

  private recordContextPlaying(event: Pick<RoonPlaybackObservation, 'revision' | 'zoneId' | 'nowPlaying'> & { positionMs: number }): void {
    const context = this.queueContext, item = this.queue[this.queueIndex], active = this.activeRoonPlayback;
    if (!context || !item || !active || event.zoneId !== context.zoneId || event.zoneId !== active.zoneId
      || !this.contextIdentityMatches(event, active.track) || !Number.isSafeInteger(event.positionMs) || event.positionMs < 0
      || !Number.isSafeInteger(event.revision) || event.revision < (this.positionContext?.minimumRevision ?? Infinity)) return;
    this.lastContextPlaying = { item, generation: this.playbackGeneration, at: this.now(), revision: event.revision, positionMs: event.positionMs };
  }

  private handleContextStopped(context: QueueContext, active: NonNullable<BridgeController['activeRoonPlayback']>, wasPlaying: boolean): void {
    const observed = this.freshNativeStoppedObservation(), anchor = this.queue[this.queueIndex];
    if (!observed || !anchor || !this.contextIdentityMatches(observed, active.track, false)) return;
    const generation = this.playbackGeneration, epoch = this.commandEpoch, recent = this.lastContextPlaying;
    const duration = active.track.durationMs;
    // Transport没有权威ended；仅近期同曲到尾部的位置支持保守的自然结束推断。
    const ended = wasPlaying && this.contextIdentityMatches(observed, active.track) && this.pendingPlaybackCommands === 0 && recent?.item === anchor
      && recent.generation === generation && recent.revision < observed.revision
      && this.now() - recent.at >= 0 && this.now() - recent.at <= 2_000
      && duration !== undefined && recent.positionMs >= duration - 1_000 && recent.positionMs <= duration + 1_000;
    void this.enqueue(async () => {
      this.assertQueueContext(context);
      if (this.activeRoonPlayback !== active || generation !== this.playbackGeneration || epoch !== this.commandEpoch
        || this.nativeRoonStopRequested || this.lastNativeRoonPlaybackState !== 'stopped') return;
      const current = this.freshNativeStoppedObservation();
      if (!current || current.revision !== observed.revision || !this.contextIdentityMatches(current, active.track, false)) return;
      this.clearActiveResources(); this.playbackState = 'idle'; this.clearPlaybackIssue(); this.notifyPlaybackChanged();
      if (!ended || this.pendingPlaybackCommands) return;
      const terminalGeneration = this.playbackGeneration;
      const index = this.queue.indexOf(anchor);
      if (index === this.queue.length - 1 && !context.afterComplete) await this.expandQueueContext(context, 'after', true);
      this.assertQueueContext(context);
      if (epoch !== this.commandEpoch || terminalGeneration !== this.playbackGeneration || this.pendingPlaybackCommands
        || this.queue[this.queueIndex] !== anchor) return;
      const target = this.queue[this.queue.indexOf(anchor) + 1];
      if (!target) return;
      await this.enqueuePlayback(async () => {
        this.assertQueueContext(context);
        if (epoch !== this.commandEpoch || terminalGeneration !== this.playbackGeneration || this.queue[this.queueIndex] !== anchor) return;
        const targetIndex = this.queue.indexOf(target); if (targetIndex < 0) return;
        await this.startQueueIndex(targetIndex, true);
      });
    }).catch(error => {
      if (this.queueContext === context && !context.abort.signal.aborted) this.dependencies.logger.warn('queue_advance_failed', { code: asBridgeError(error).code });
    });
  }

  private freshNativeStoppedObservation(): RoonPlaybackObservation | undefined {
    const active = this.activeRoonPlayback;
    const context = this.positionContext;
    const observation = this.dependencies.roon.getSelectedZonePlaybackObservation?.();
    if (!active || !context || context.generation !== this.playbackGeneration
      || context.source !== 'roon' || observation?.state !== 'stopped'
      || observation.zoneId !== active.zoneId
      || observation.zoneId !== this.dependencies.roon.getState().selectedZoneId
      || context.minimumRevision === undefined
      || !Number.isSafeInteger(observation.revision)
      || observation.revision <= context.minimumRevision) return undefined;
    return observation;
  }

  getPlaybackGeneration(): number {
    return this.playbackGeneration;
  }

  getState(): BridgeState {
    return {
      neteaseConfigured: this.dependencies.netease.configured,
      roon: this.dependencies.roon.getState(),
      activeStreamCount: this.dependencies.registry.size,
      ...(this.activePlayback ? { activePlayback: this.activePlayback } : {}),
      ...(this.activeRoonPlayback ? { activeRoonPlayback: cloneTrackSummary(this.activeRoonPlayback.track) } : {}),
    };
  }

  getDiagnosticResourceCounters(): DiagnosticResourceCounters {
    return {
      queueItemCount: this.queue.length,
      activeStreamCount: this.dependencies.registry.size,
      activePlaybackCount: this.activePlayback || this.activeRoonPlayback ? 1 : 0,
      activeSessionCount: this.activeToken ? 1 : 0,
      activeTokenCount: this.activeToken ? 1 : 0,
      listenerCount: this.playbackListeners.size,
      timerCount: 0,
    };
  }

  private startAutomaticQueueIndex(index: number): Promise<void> {
    const generation = this.playbackGeneration;
    const item = this.queue[index];
    return this.enqueuePlayback(async () => {
      if (generation !== this.playbackGeneration || item !== this.queue[index]) return;
      await this.startQueueIndex(index, true);
    });
  }

  private async startQueueIndex(
    index: number,
    skipUnavailable: boolean,
    startupTrace?: PlaybackStartupTrace,
    alreadySaved=false,
    queueAdmission?:()=>void,
  ): Promise<void> {
    queueAdmission?.();this.guardCommand();
    if(!alreadySaved)await this.persistQueue(this.queue,index);this.guardCommand();
    this.nextInsertionQueueIndex = undefined;
    this.nextInsertionCursor = undefined;
    let candidate = index;
    let skippedError: BridgeError | undefined;

    while (candidate < this.queue.length) {
      this.queueIndex = candidate;
      this.queueProjectionDirty = true;
      this.playbackGeneration += 1;
      this.positionMs = 0;
      this.lastPositionPublishedAt = this.now();
      this.notifyPlaybackChanged();
      const item = this.queue[candidate];
      if (!item) {
        break;
      }
      const owner: PlaybackOwner = {
        ...(queueAdmission?{queueAdmission}:{}),item, zoneId: item.roonZoneId ?? this.dependencies.roon.getState().selectedZoneId ?? '',
        source: item.localSelection || item.logicalSource?.kind==='local_file' ? 'local_file' : item.roonReference || item.preferredSource === 'roon' ? 'roon' : 'netease',
        abort: new AbortController(), preparing: true, dispatched: false,
      };
      this.owner = owner;
      try {
        this.cancelQueueHydration();
        // 先派发当前曲的元数据/URL，再补全队列；不等待 Roon 启动确认。
        const starting = this.startItem(item, owner, startupTrace);
        this.scheduleQueueHydration(
          this.queue.filter(value => value !== item), this.queueHydrationGeneration, owner,
        );
        await starting;
        this.guardOwner(owner);
        owner.preparing = false;delete owner.queueAdmission;
        if (skippedError) {
          this.lastPlaybackError = skippedError.code;
          this.lastPlaybackIssue = this.issueForError(skippedError);
        }
        this.notifyPlaybackChanged();
        return;
      } catch (error) {
        this.localGuardCaught(error);
        if (this.localGuardRejects('intentMatch',this.owner !== owner) || this.localGuardRejects('intentMatch',owner.abort.signal.aborted)) {const cancelled=error instanceof LocalSourcePrepareInterrupted&&error.code==='READ_CANCELLED'?error:this.cancelled();this.localGuardFailure('START_QUEUE',cancelled);throw cancelled;}
        this.cancelQueueHydration();
        if (!owner.dispatched && !this.stopUnknown) { owner.abort.abort(); this.owner = undefined; }
        const bridgeError = asBridgeError(error);
        if (item.localSelection || item.logicalSource?.kind==='local_file' || !skipUnavailable || !isSkippableQueueError(error)) {
          this.playbackState = 'error';
          this.setPlaybackError(bridgeError);
          this.notifyPlaybackChanged();
          throw error;
        }
        skippedError = bridgeError;
        candidate = this.queue.indexOf(item) + 1;
      }
    }

    this.queueIndex = this.queue.length > 0 ? this.queue.length - 1 : -1;
    this.queueProjectionDirty = true;
    this.clearActiveResources();
    this.playbackState = 'idle';
    this.lastPlaybackError = skippedError?.code;
    this.lastPlaybackIssue = skippedError ? this.issueForError(skippedError) : undefined;
    this.qualityNotice = undefined;
    this.notifyPlaybackChanged();
  }

  private async startItem(
    item: QueueItem,
    owner: PlaybackOwner,
    startupTrace?: PlaybackStartupTrace,
  ): Promise<void> {
    if (item.logicalSource?.kind==='roon') throw new BridgeError('BAD_REQUEST','UNSUPPORTED_NATIVE_RESTORE',{httpStatus:409});
    if (item.localSelection || item.logicalSource?.kind==='local_file') {
      const task=this.startLocalItem(item,owner);this.localTasks.add(task);
      try {await task;} catch(error){item.preflight={state:'FAILED',reason:'SOURCE_UNAVAILABLE'};this.queueProjectionDirty=true;throw error;} finally {this.localTasks.delete(task);}
      return;
    }
    this.localObservation=undefined;
    if (item.preferredSource === 'roon' || item.roonReference) {
      await this.startRoonItem(item, owner);
      return;
    }

    if (!this.dependencies.netease.configured) {
      throw new BridgeError(
        'NETEASE_NOT_CONFIGURED',
        'NETEASE_COOKIE is not configured',
        { httpStatus: 503 },
      );
    }

    this.playbackState = 'resolving';
    this.clearPlaybackIssue();
    this.notifyPlaybackChanged();

    const requestedQuality = resolveQualityPreference(item.qualityPreference);
    const preparation = this.nextPreparation;
    let candidate: Awaited<NonNullable<typeof preparation>['result']>;
    if (preparation?.item === item && preparation.quality === requestedQuality) {
      // Next 可以接管已准备的下一首，但接管后仍须响应新 Owner 的撤销。
      const cancel = () => preparation.abort.abort();
      owner.abort.signal.addEventListener('abort', cancel, { once: true });
      try { candidate = await this.waitOwned(owner, preparation.result); }
      finally { owner.abort.signal.removeEventListener('abort', cancel); }
    } else {
      this.cancelNextPreparation();
      candidate = undefined;
    }
    if (this.nextPreparation === preparation) this.nextPreparation = undefined;
    const prepared = candidate && candidate.expiresAtMs > this.now() ? candidate : undefined;
    let metadata: TrackMetadata;
    let initialStream: ResolvedAudioStream | undefined;
    if (prepared) {
      metadata = prepared.metadata;
      initialStream = prepared.stream;
      this.reportStartupStage(startupTrace, 'metadata-ready');
      this.reportStartupStage(startupTrace, 'stream-url-ready');
    } else if (item.preferredSource === 'smart') {
      metadata = item.track
        ? { ...item.track, artists: [...item.track.artists] }
        : await this.waitOwned(owner, this.dependencies.netease.getTrack(item.trackId, {
          signal: owner.abort.signal, priority: 'playback',
        }));
      this.reportStartupStage(startupTrace, 'metadata-ready');
    } else {
      const metadataRequest: Promise<TrackMetadata> = item.track
        ? Promise.resolve({ ...item.track, artists: [...item.track.artists] })
        : this.dependencies.netease.getTrack(item.trackId, { signal: owner.abort.signal, priority: 'playback' });
      [metadata, initialStream] = await this.waitOwned(owner, Promise.all([
        metadataRequest.then((value) => {
          this.reportStartupStage(startupTrace, 'metadata-ready');
          return value;
        }),
        this.dependencies.netease.resolveStream(item.trackId, requestedQuality, {
          signal: owner.abort.signal, priority: 'playback',
        }).then((value) => {
          this.reportStartupStage(startupTrace, 'stream-url-ready');
          return value;
        }),
      ]));
    }
    this.guardOwner(owner);
    item.track = toTrackSummary(metadata);
    this.queueProjectionDirty = true;
    if (item.preferredSource === 'smart' && this.dependencies.resolveSmartSource) {
      const resolution = await this.waitOwned(owner, this.dependencies.resolveSmartSource(item.track));
      this.guardOwner(owner);
      if (resolution) {
        if (resolution.zoneId !== owner.zoneId) throw this.cancelled();
        owner.source = 'roon';
        item.roonReference = resolution.reference;
        item.roonZoneId = resolution.zoneId;
        try {
          await this.startRoonItem(item, owner);
          return;
        } catch (error) {
          this.guardOwner(owner);
          this.dependencies.logger.warn('smart_roon_fallback', {
            code: asBridgeError(error).code,
          });
          // A failed native start can be ambiguous at the transport boundary.
          // Stop it before starting the V1 Provider path to prevent overlap.
          try {
            await this.device(() => this.dependencies.roonLibrary?.stop({ expectedZoneId: owner.zoneId }) ?? Promise.resolve());
          } catch (stopError) {
            this.stopUnknown = true;
            throw stopError;
          }
          this.guardOwner(owner);
          owner.dispatched = false;
          owner.source = 'netease';
          delete item.roonReference;
          delete item.roonZoneId;
          delete item.resolvedSource;
          this.queueProjectionDirty = true;
        }
      }
    }
    item.resolvedSource = 'netease';
    this.queueProjectionDirty = true;
    if (!initialStream) {
      initialStream = await this.waitOwned(owner, this.dependencies.netease.resolveStream(
        item.trackId, requestedQuality, { signal: owner.abort.signal, priority: 'playback' },
      ));
      this.reportStartupStage(startupTrace, 'stream-url-ready');
    }
    if (!prepared) await this.waitOwned(owner, this.dependencies.gateway.preflight(initialStream, owner.abort.signal));
    this.guardOwner(owner);
    this.reportStartupStage(startupTrace, 'gateway-preflight-ready');

    const resolver = this.createRefreshingResolver(
      item.trackId,
      requestedQuality,
      initialStream,
      owner,
      prepared?.resolvedAtMs,
    );
    const registration = this.dependencies.registry.register({
      metadata,
      requestedQuality,
      resolve: resolver,
      ttlMs: Math.max((metadata.durationMs ?? 0) + 60 * 60 * 1000, 2 * 60 * 60 * 1000),
    });

    owner.token = registration.token;
    this.activeToken = registration.token;
    this.pendingTerminalReason = undefined;
    this.playbackState = 'preparing';
    this.notifyPlaybackChanged();
    let gatewayStage: RoonGatewayStage = 'none';
    const activePlayback: ActivePlayback = {
      track: metadata,
      qualityPreference: item.qualityPreference,
      requestedQuality,
      actualQuality: normalizeActualQuality(initialStream.actualQuality),
      ...(initialStream.transportSecurity
        ? { transportSecurity: initialStream.transportSecurity }
        : {}),
      startedAt: new Date(this.now()).toISOString(),
      ...(initialStream.format ? { format: initialStream.format } : {}),
      ...(initialStream.bitrate !== undefined
        ? { bitrate: initialStream.bitrate }
        : {}),
      ...(initialStream.sizeBytes !== undefined
        ? { sizeBytes: initialStream.sizeBytes }
        : {}),
    };

    try {
      await this.device(() => {
        this.guardOwner(owner);
        return this.dependencies.roon.play({
        ...this.ownerOptions(owner),
        onDispatch: () => { owner.dispatched = true; },
        mediaUrl: this.dependencies.gateway.streamUrl(
          registration.token,
          initialStream.format,
          (stage) => {
            gatewayStage = stage;
          },
        ),
        iconUrl: this.dependencies.gateway.iconUrl(),
        metadata,
        gatewayStage: () => gatewayStage,
        ...(startupTrace
          ? {
              onStartupStage: (stage) => this.reportStartupStage(startupTrace, stage),
            }
          : {}),
      });
      });
      this.guardOwner(owner);
      if (this.pendingTerminalReason) {
        const reason = this.pendingTerminalReason;
        this.pendingTerminalReason = undefined;
        throw new BridgeError(
          'ROON_MEDIA_ERROR',
          'Roon session ended while playback was starting',
          { httpStatus: 502, details: { reason } },
        );
      }
      if (this.activeToken !== registration.token) {
        throw new BridgeError(
          'ROON_MEDIA_ERROR',
          'Roon session ended while playback was starting',
          { httpStatus: 502 },
        );
      }
      this.activePlayback = activePlayback;
      const selectedZoneId = this.dependencies.roon.getState().selectedZoneId;
      if (!selectedZoneId) {
        throw new BridgeError('ROON_ZONE_NOT_SELECTED', 'Roon Zone confirmation is unavailable', {
          httpStatus: 409,
        });
      }
      const playbackEpoch = this.dependencies.roon.getActivePlaybackEpoch?.();
      const observationRevision =
        this.dependencies.roon.getSelectedZonePlaybackObservation?.()?.revision;
      this.positionContext = {
        generation: this.playbackGeneration,
        trackId: metadata.id,
        zoneId: selectedZoneId,
        source: 'netease',
        ...(playbackEpoch !== undefined ? { playbackEpoch } : {}),
        ...(observationRevision !== undefined ? { minimumRevision: observationRevision } : {}),
      };
      item.requestedQuality = requestedQuality;
      item.actualQuality = activePlayback.actualQuality;
      this.queueProjectionDirty = true;
      this.playbackState = 'playing';
      this.lastPlaybackError = undefined;
      this.lastPlaybackIssue = undefined;
      this.qualityNotice = item.qualityPreference !== 'auto' && isQualityDowngrade(requestedQuality, activePlayback.actualQuality)
        ? {
            ...makePlaybackIssue('QUALITY_DOWNGRADED', this.newDiagnosticId()),
            message: `请求 ${requestedQuality}，实际 ${activePlayback.actualQuality}`,
          }
        : undefined;
      this.dependencies.logger.info('bridge_playing', {
        trackId: item.trackId,
        title: metadata.title,
        requestedQuality,
        actualQuality: activePlayback.actualQuality,
        ...(initialStream.transportSecurity
          ? { transportSecurity: initialStream.transportSecurity }
          : {}),
        ...(initialStream.transportSecurity === 'https-upgraded'
          ? { providerHostClass: 'netease-cdn' }
          : {}),
        format: initialStream.format,
        bitrate: initialStream.bitrate,
      });
      this.notifyPlaybackChanged();
    } catch (error) {
      if (this.owner === owner && !owner.abort.signal.aborted) {
        this.pendingTerminalReason = undefined;
        if (!owner.dispatched && owner.token !== undefined) {
          this.dependencies.gateway.clearStageObserver(owner.token);
          this.dependencies.registry.revoke(owner.token);
          if (this.activeToken === owner.token) this.activeToken = undefined;
          delete owner.token;
        }
      }
      throw error;
    }
  }

  private async startRoonItem(item: QueueItem, owner: PlaybackOwner): Promise<void> {
    const reference = item.roonReference;
    const zoneId = item.roonZoneId;
    const roonLibrary = this.dependencies.roonLibrary;
    if (!reference || !zoneId || !roonLibrary || !item.track) {
      throw new BridgeError('ROON_LIBRARY_UNAVAILABLE', 'Roon native playback is unavailable', {
        httpStatus: 503,
      });
    }

    this.playbackState = 'resolving';
    this.clearPlaybackIssue();
    this.notifyPlaybackChanged();
    const track = cloneTrackSummary(item.track);
    try {
      const observation = await this.devicePlay((onDispatchCompletion) => {
        this.guardOwner(owner);
        return roonLibrary.play(reference, zoneId, track, {
          ...this.ownerOptions(owner), onDispatch: () => { owner.dispatched = true; }, onDispatchCompletion,
        });
      });
      this.guardOwner(owner);
      const confirmedTrack = track.durationMs === undefined
        && observation.nowPlaying?.durationMs !== undefined
        ? { ...track, durationMs: observation.nowPlaying.durationMs }
        : track;
      this.applyNativeArtwork(confirmedTrack, observation);
      this.activeRoonPlayback = { track: confirmedTrack, reference, zoneId,
        ...(observation.nowPlaying ? { observedIdentity: { ...observation.nowPlaying } } : {}) };
      item.track = cloneTrackSummary(confirmedTrack);
      this.queueProjectionDirty = true;
      if (
        observation.positionMs !== undefined
        && Number.isSafeInteger(observation.positionMs)
        && observation.positionMs >= 0
        && observation.positionMs <= 24 * 60 * 60 * 1_000
      ) {
        this.positionMs = observation.positionMs;
      }
      this.positionContext = {
        generation: this.playbackGeneration,
        trackId: confirmedTrack.id,
        zoneId,
        source: 'roon',
        minimumRevision: observation.revision,
      };
      item.resolvedSource = 'roon';
      this.queueProjectionDirty = true;
      this.playbackState = 'playing';
      this.lastPlaybackError = undefined;
      this.lastPlaybackIssue = undefined;
      this.qualityNotice = undefined;
      this.dependencies.logger.info('roon_native_playing', {
        trackId: item.trackId,
        title: confirmedTrack.title,
      });
      this.notifyPlaybackChanged();
    } catch (error) {
      if (this.owner !== owner || owner.abort.signal.aborted) throw this.cancelled();
      this.activeRoonPlayback = undefined;
      delete item.resolvedSource;
      this.queueProjectionDirty = true;
      throw error;
    }
  }

  private stopActive(retryUnknown = false): Promise<void> {
    if (this.stopFlight) return this.stopFlight;
    if (this.stopUnknown && !retryUnknown) return Promise.reject(new BridgeError(
      'ROON_TRANSPORT_UNAVAILABLE', '停止尚未确认，请重试停止', { httpStatus: 409 },
    ));
    const owner = this.owner;
    this.markLocalStopRequested(owner);
    owner?.abort.abort();
    const hasActive = this.activeToken !== undefined || this.activePlayback !== undefined || this.activeRoonPlayback !== undefined;
    if (!hasActive && !owner) {
      if (this.playbackState !== 'idle') { this.playbackState = 'idle'; this.notifyPlaybackChanged(); }
      return Promise.resolve();
    }
    const confirmedActive = this.activePlayback !== undefined || this.activeRoonPlayback !== undefined;
    const needsStop = owner ? owner.dispatched || confirmedActive || this.stopUnknown : hasActive;
    const native = owner?.source === 'roon' || this.activeRoonPlayback !== undefined;
    const zoneId = owner?.zoneId ?? this.activeRoonPlayback?.zoneId ?? this.dependencies.roon.getState().selectedZoneId;
    this.playbackState = 'stopping';
    ++this.playbackGeneration;
    this.lastPositionPublishedAt = this.now();
    if (native && needsStop) this.nativeRoonStopRequested = true;
    this.notifyPlaybackChanged();
    const closing = (async () => {
      try {
        if (needsStop) await this.device(() => {
          if (native) {
            if (!this.dependencies.roonLibrary) throw new BridgeError('ROON_LIBRARY_UNAVAILABLE', '本地 Roon 停止不可用', { httpStatus: 503 });
            return this.dependencies.roonLibrary.stop({ ...(zoneId ? { expectedZoneId: zoneId } : {}) });
          }
          if(owner?.local) {
            const targetCurrent=owner.local.target.isCurrent();
            if(!targetCurrent || !owner.local.isOwned?.()) {
              if(owner.dispatched)this.loseLocal(owner,true);
              return Promise.resolve();
            }
          }
          return this.dependencies.roon.stop({ ...(zoneId ? { expectedZoneId: zoneId } : {}) });
        });
      } catch (error) {
        this.stopUnknown = true;
        this.cancelNextPreparation();
        this.playbackState = 'error';
        this.lastPlaybackError = asBridgeError(error).code;
        this.lastPlaybackIssue = { ...this.issueForError(error), message: '停止尚未确认，请重试停止', retryable: true, action: 'retry' };
        this.qualityNotice = undefined;
        this.notifyPlaybackChanged();
        throw error;
      }
      this.stopUnknown = false;
      this.clearActiveResources();
      this.playbackState = 'idle';
      this.clearPlaybackIssue();
      this.notifyPlaybackChanged();
    })();
    this.stopFlight = closing;
    const settleStop = () => {
      if (this.stopFlight !== closing) return;
      this.stopFlight = undefined;
      // 关闭请求本身也占有停止能力；实际结算后同步发布释放，失败仍保留未知停止锁。
      this.notifyPlaybackChangedIfDifferent();
    };
    void closing.then(settleStop, settleStop);
    return closing;
  }

  private cancelQueueHydration(): number {
    this.queueHydration?.abort.abort();
    this.queueHydration = undefined;
    return ++this.queueHydrationGeneration;
  }

  private hydrationIsCurrent(hydration: QueueHydration): boolean {
    return this.queueHydration === hydration && hydration.generation === this.queueHydrationGeneration
      && !hydration.abort.signal.aborted && this.owner === hydration.owner
      && !hydration.owner?.abort.signal.aborted;
  }

  private async hydrateQueueItems(
    items: readonly QueueItem[],
    generation: number,
    owner = this.owner,
  ): Promise<void> {
    if (generation !== this.queueHydrationGeneration) return;
    this.queueHydration?.abort.abort();
    const hydration: QueueHydration = { generation, owner, abort: new AbortController() };
    this.queueHydration = hydration;
    const cancel = () => hydration.abort.abort();
    owner?.abort.signal.addEventListener('abort', cancel, { once: true });
    if (owner?.abort.signal.aborted) cancel();
    let cursor = 0;
    const worker = async () => {
      while (this.hydrationIsCurrent(hydration)) {
        const item = items[cursor++];
        if (!item) return;
        if (item.localSelection || item.logicalSource || item.track || !this.queue.includes(item) || item === this.owner?.item) continue;
        try {
          const track = toTrackSummary(await this.dependencies.netease.getTrack(item.trackId, {
            signal: hydration.abort.signal, priority: 'background',
          }));
          if (!this.hydrationIsCurrent(hydration) || !this.queue.includes(item)) return;
          item.track = track;
          // worker 的 await 间隙可能穿插进度回报，写回后立即使投影失效。
          this.queueProjectionDirty = true;
        } catch {
          // 补全失败不破坏队列；成为当前项时再通过播放请求确认。
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(QUEUE_HYDRATION_CONCURRENCY, items.length) }, worker));
    } finally {
      owner?.abort.signal.removeEventListener('abort', cancel);
      if (this.queueHydration === hydration) this.queueHydration = undefined;
    }
  }

  private scheduleQueueHydration(
    items: readonly QueueItem[],
    generation: number,
    owner = this.owner,
  ): void {
    void this.hydrateQueueItems(items, generation, owner).then(() => {
      if (generation === this.queueHydrationGeneration) this.notifyPlaybackChanged();
    });
  }

  private clearActiveResources(): void {
    this.cancelQueueHydration();
    const localOwner=this.owner;
    if(localOwner?.local && this.localObservation && !['ENDED','FAILED','CANCELLED','OWNERSHIP_LOST'].includes(this.localObservation.phase))this.localTerminal(localOwner,'CANCELLED');
    this.owner?.abort.abort();
    if(localOwner?.local) this.trackLocalCleanup(this.disposeLocal(localOwner));
    this.owner = undefined;
    this.stopUnknown = false;
    if (this.activeToken) {
      this.dependencies.gateway.clearStageObserver(this.activeToken);
      this.dependencies.registry.revoke(this.activeToken);
    }
    this.activeToken = undefined;
    this.activePlayback = undefined;
    this.activeRoonPlayback = undefined;
    this.nativeRoonStopRequested = false;
    this.queueProjectionDirty = true;
    this.positionContext = undefined;
    this.positionMs = 0;
    this.playbackGeneration += 1;
    this.lastPositionPublishedAt = this.now();
  }

  private notifyReadPriorityChanged(): void {
    try { this.dependencies.onReadPriorityChanged?.(); }
    catch { this.dependencies.logger.warn('scan_read_priority_listener_failed', {}); }
  }

  private notifyPlaybackChanged(kind: 'full' | 'position' = 'full'): void {
    this.notifyReadPriorityChanged();
    this.scheduleNextPreparation();
    const snapshot = this.playbackPublication(kind);
    this.publishPlayback(snapshot, kind);
  }

  private notifyPlaybackChangedIfDifferent(): void {
    this.notifyReadPriorityChanged();
    const snapshot = this.playbackPublication('full');
    if (this.lastPublishedPlayback && isDeepStrictEqual(this.lastPublishedPlayback, snapshot)) return;
    this.scheduleNextPreparation();
    this.publishPlayback(snapshot);
  }

  private publishPlayback(snapshot: PlaybackSnapshot, kind: 'full' | 'position' = 'full'): void {
    this.lastPublishedPlayback = snapshot;
    for (const listener of this.playbackListeners) {
      try {
        listener(snapshot, { kind });
      } catch {
        this.dependencies.logger.warn('playback_listener_failed', {});
      }
    }
  }

  hasPlaybackOwnership(): boolean {
    return Boolean(this.pendingPlaybackCommands || this.owner || this.stopFlight || this.stopUnknown || this.activeToken || this.activePlayback || this.activeRoonPlayback);
  }

  /** 同进程显示读口：只读取原播放事实，稳定所有权仍保留原停止能力。 */
  hasDisplayReadPriorityBlocker(): boolean {
    try {
      if (this.localClosing || this.pendingPlaybackCommands || this.displayReadPriorityOperations.size || this.displayReadUnconfirmedRoonStops.size
        || this.stopFlight || this.stopUnknown || this.nativeRoonStopRequested) return true;
      const owner = this.owner;
      if (owner?.preparing || owner?.abort.signal.aborted) return true;
      if (!owner && !this.activeToken && !this.activePlayback && !this.activeRoonPlayback) return this.playbackState !== 'idle';
      if (this.playbackState !== 'playing' && this.playbackState !== 'paused' || owner && !owner.dispatched) return true;
      const position = this.positionContext, zoneId = this.dependencies.roon.getState().selectedZoneId;
      if (!position || position.generation !== this.playbackGeneration || !zoneId || position.zoneId !== zoneId) return true;
      if (owner && (owner.source === 'local_file' || owner.local)) {
        const local = owner.local, observed = this.localObservation;
        return !local || !this.localCurrent(owner) || local.disposing !== undefined || !local.session
          || local.session.attempt !== local.poolAttempt || local.session.isConfirmed() !== true || local.isOwned?.() !== true
          || !this.activePlayback || !this.activeToken || owner.token !== this.activeToken
          || position.source !== 'local_file' || position.trackId !== this.activePlayback.track.id
          || !observed || observed.intent_generation !== String(this.playbackGeneration) || observed.session_epoch === null
          || observed.local_track_id !== local.capture.facts.track.id || observed.asset_id !== local.capture.facts.asset.id
          || observed.asset_revision !== local.capture.facts.asset.fileRevision || observed.ownership !== 'MB_OWNED'
          || observed.queue_owner !== 'MB' || observed.roon_observation.correlation !== 'ATTEMPT_CONFIRMED'
          || !(this.playbackState === 'playing' && observed.phase === 'PLAYING' || this.playbackState === 'paused' && observed.phase === 'PAUSED');
      }
      if (this.activeRoonPlayback) return position.source !== 'roon' || position.trackId !== this.activeRoonPlayback.track.id
        || position.zoneId !== this.activeRoonPlayback.zoneId;
      if (this.activePlayback && owner) return owner.source !== 'netease' || owner.zoneId !== zoneId
        || this.queue[this.queueIndex] !== owner.item || owner.token !== this.activeToken || !this.activeToken
        || position.source !== 'netease' || position.trackId !== this.activePlayback.track.id;
      return true;
    } catch { return true; }
  }

  /** 每个原操作只释放自己的标记；通知异常不改变原Promise或原错误。 */
  private beginDisplayReadPriority(): () => void {
    const marker = {};
    this.displayReadPriorityOperations.add(marker);
    const notify = (): void => { try { this.notifyReadPriorityChanged(); } catch { /* 保持原操作。 */ } };
    notify();
    return () => { if (this.displayReadPriorityOperations.delete(marker)) notify(); };
  }

  private withDisplayReadPriority<T>(operation: () => Promise<T>): Promise<T> {
    const release = this.beginDisplayReadPriority();
    try {
      const result = operation();
      void result.then(release, release);
      return result;
    } catch (error) { release(); throw error; }
  }

  private guardCommand(): void {
    if (this.localGuardRejects('intentMatch',this.runningCommandEpoch !== this.commandEpoch)
      || this.localGuardRejects('intentMatch',this.runningQueueReplacementGeneration !== this.queueReplacementGeneration)) throw this.cancelled();
  }

  private cancelled(): BridgeError {
    return new BridgeError('BAD_REQUEST', '播放操作已取消', { httpStatus: 409, details: { reason: 'operation_cancelled' } });
  }

  private guardOwner(owner: PlaybackOwner): void {
    owner.queueAdmission?.();
    if (this.localGuardRejects('intentMatch',this.owner !== owner) || this.localGuardRejects('intentMatch',owner.abort.signal.aborted) || this.localGuardRejects('intentMatch',this.queue[this.queueIndex] !== owner.item)
      || this.localGuardRejects('targetMatch',(this.dependencies.roon.getState().selectedZoneId ?? '') !== owner.zoneId)
      || (owner.token !== undefined && this.localGuardRejects('intentMatch',this.activeToken !== owner.token))) throw this.cancelled();
  }

  private guardControl(owner: PlaybackOwner | undefined, generation: number): void {
    if (this.owner !== owner || this.playbackGeneration !== generation || owner?.abort.signal.aborted) throw this.cancelled();
    if(owner?.local) this.assertLocal(owner);
  }

  private guardLocalSeek(owner: PlaybackOwner | undefined, generation: number): void {
    this.guardControl(owner,generation);
    if(owner?.source!=='local_file'&&!owner?.local)return;
    const local=owner?.local,observation=this.localObservation;
    if(!local||!local.session?.isConfirmed()||local.isOwned?.()!==true||!observation||observation.ownership!=='MB_OWNED'||observation.queue_owner!=='MB'
      ||!(this.playbackState==='playing'&&observation.phase==='PLAYING'||this.playbackState==='paused'&&observation.phase==='PAUSED'))throw this.cancelled();
  }

  private ownerOptions(owner: PlaybackOwner | undefined): RoonOperationOptions {
    return { ...(owner ? { signal: owner.abort.signal, expectedZoneId: owner.zoneId,assertCurrent:()=>this.guardOwner(owner) } : {}),...(owner?.local ? {assertCurrent:()=>this.assertLocal(owner),withDispatch:<T>(send:()=>T)=>owner.local!.fence.dispatch(send,()=>this.assertLocal(owner))} : {}) };
  }

  private waitOwned<T>(owner: PlaybackOwner, work: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const cancel = () => {
        owner.abort.signal.removeEventListener('abort', cancel);
        reject(this.cancelled());
      };
      owner.abort.signal.addEventListener('abort', cancel, { once: true });
      work.then(value => {
        try { this.guardOwner(owner); resolve(value); } catch (error) { reject(error); }
      }, reject).finally(() => owner.abort.signal.removeEventListener('abort', cancel));
      if (owner.abort.signal.aborted) cancel();
    });
  }

  private device<T>(operation: () => Promise<T>): Promise<T> {
    const releasePriority = this.beginDisplayReadPriority();
    const result = this.deviceTail.then(operation);
    this.deviceTail = result.then(() => undefined, () => undefined);
    void result.then(releasePriority, releasePriority);
    return result;
  }

  private devicePlay<T>(operation: (onCompletion: (completion: Promise<void>) => void) => Promise<T>): Promise<T> {
    const releasePriority = this.beginDisplayReadPriority();
    let completionRegistered = false;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    void barrier.then(releasePriority, releasePriority);
    const result = this.deviceTail.then(() => operation(value => {
      completionRegistered = true;
      // 写入真实结算即释放控制链，不等待独立的 Transport 确认。
      void value.then(release, release);
    }));
    void result.then(() => { if (!completionRegistered) release(); }, () => { if (!completionRegistered) release(); });
    this.deviceTail = barrier;
    return result;
  }

  private enqueuePlayback<T>(operation: () => Promise<T>, replacesQueue = false): Promise<T> {
    // 受理新意图即停止旧补全，不能等到命令实际执行或最终 notify。
    this.cancelQueueHydration();
    const epoch = this.commandEpoch;
    // 队列替换只保留最后已受理意图；Stop与Zone仍使用独立的命令失效域。
    const replacementGeneration = replacesQueue ? ++this.queueReplacementGeneration : this.queueReplacementGeneration;
    if (this.owner?.preparing) this.owner.abort.abort();
    ++this.pendingPlaybackCommands;
    this.notifyReadPriorityChanged();
    const result = this.enqueue(() => {
      const result = this.playbackCommandTail.then(() => {
        this.localGuardSync('INTENT',()=>{
          if (this.localGuardRejects('intentMatch',epoch !== this.commandEpoch) || this.localGuardRejects('intentMatch',replacementGeneration !== this.queueReplacementGeneration)) throw this.cancelled();
          this.runningCommandEpoch = epoch;
          this.runningQueueReplacementGeneration = replacementGeneration;
        });
        return operation();
      });
      this.playbackCommandTail = result.then(() => undefined, () => undefined);
      return result;
    });
    return result.finally(() => {
      --this.pendingPlaybackCommands;
      this.notifyReadPriorityChanged();
      // 最后意图结算后同步公开能力，避免取消准备留下过期的可停止状态。
      if (this.pendingPlaybackCommands === 0) this.notifyPlaybackChangedIfDifferent();
    });
  }

  private enqueueControl<T>(operation: () => Promise<T>): Promise<T> {
    const epoch = this.commandEpoch;
    return this.withDisplayReadPriority(() => this.enqueue(() => {
      const result = this.controlTail.then(() => {
        if (epoch !== this.commandEpoch) throw this.cancelled();
        return operation();
      });
      this.controlTail = result.then(() => undefined, () => undefined);
      return result;
    }));
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const trace = currentPerformanceContext();
    const span = trace?.recorder.start('queue', trace.context);
    const enteredAt = trace ? readPerformanceTime() : undefined;
    trace?.recorder.mark('queue', 'queue-enter', trace.context);
    const accepted = this.operationTail.then(() => {
      const executingAt = trace ? readPerformanceTime() : undefined;
      if (enteredAt !== undefined && executingAt !== undefined) span?.add({ queueWaitMs: Math.max(0, executingAt - enteredAt) });
      trace?.recorder.mark('queue', 'queue-start', trace.context);
      try {
        const result = operation();
        this.externalTasks.add(result);
        void result.then(() => { this.externalTasks.delete(result); }, () => { this.externalTasks.delete(result); });
        span?.end('ok');
        // 包装 Promise 句柄，mailbox 不会 adoption 外部工作。
        return { result };
      } catch (error) { span?.end('error'); throw error; }
    });
    this.operationTail = accepted.then(() => undefined, () => undefined);
    return accepted.then(handle => handle.result);
  }

  /** 仅提前解析紧邻下一首的短期URL和响应头，不下载音频、不注册流或占用Roon会话。 */
  private cancelNextPreparation(): void {
    this.cancelLocalNext();
    this.nextPreparation?.abort.abort();
    this.nextPreparation = undefined;
  }

  private scheduleNextPreparation(): void {
    if (!this.activePlayback || this.playbackState !== 'playing') return;
    const item = this.queue[this.queueIndex + 1];
    if(item && (item.localSelection || item.logicalSource?.kind==='local_file')){this.nextPreparation?.abort.abort();this.nextPreparation=undefined;this.scheduleLocalNext(item);return;}
    this.cancelLocalNext();if(!this.dependencies.netease.configured)return;
    if (!item || item.localSelection || item.roonReference || item.preferredSource === 'roon' || item.preferredSource === 'smart') {
      this.cancelNextPreparation();
      return;
    }
    const quality = resolveQualityPreference(item.qualityPreference);
    if (this.nextPreparation?.item === item && this.nextPreparation.quality === quality
      && !this.nextPreparation.abort.signal.aborted) return;
    this.cancelNextPreparation();
    if (this.preparationInFlight) return;
    const abort = new AbortController();
    const isCurrent = () => !abort.signal.aborted && this.queue.includes(item)
      && (this.nextPreparation?.abort === abort || this.owner?.item === item);
    this.preparationInFlight = true;
    const result = (async () => {
      try {
        const resolvedAtMs = this.now();
        const [metadata, stream] = await Promise.all([
          item.track ? Promise.resolve({ ...item.track, artists: [...item.track.artists] })
            : this.dependencies.netease.getTrack(item.trackId, { signal: abort.signal, priority: 'background' }),
          this.dependencies.netease.resolveStream(item.trackId, quality, { signal: abort.signal, priority: 'background' }),
        ]);
        if (!isCurrent()) return undefined;
        await this.dependencies.gateway.preflight(stream, abort.signal);
        if (!isCurrent()) return undefined;
        const expiresAtMs = resolvedAtMs + Math.max(0, (stream.expiresInSeconds ?? 120) * 1000 - 30_000);
        return { metadata, stream, resolvedAtMs, expiresAtMs };
      } catch {
        // 预解析失败不改变当前歌曲、登录状态或队列；真正播放时走正常错误路径。
        return undefined;
      } finally {
        this.preparationInFlight = false;
        // 队列可能在请求期间被替换，只为当前紧邻下一首调度后继请求。
        if (abort.signal.aborted || this.queue[this.queueIndex + 1] !== item) queueMicrotask(() => this.scheduleNextPreparation());
      }
    })();
    this.nextPreparation = { item, quality, abort, result };
  }

  private createRefreshingResolver(
    trackId: string,
    quality: QualityLevel,
    initial: ResolvedAudioStream,
    owner: PlaybackOwner,
    initialResolvedAtMs = this.now(),
  ): (request?: StreamResolveRequest) => Promise<ResolvedAudioStream> {
    let cached = initial;
    let resolvedAtMs = initialResolvedAtMs;
    let refreshUsed = false;

    return async (request?: StreamResolveRequest): Promise<ResolvedAudioStream> => {
      const advertisedTtlMs = (cached.expiresInSeconds ?? 120) * 1000;
      const refreshAfterMs = Math.max(10_000, advertisedTtlMs - 30_000);
      const forcedByUpstream = request?.reason === 'upstream_expired';
      if (!forcedByUpstream && this.now() - resolvedAtMs < refreshAfterMs) return cached;
      if (refreshUsed) {
        throw new BridgeError(
          'STREAM_URL_EXPIRED',
          'Audio stream URL expired after one refresh',
          { httpStatus: 502, details: { refreshAttempted: true } },
        );
      }

      refreshUsed = true;
      try {
        this.guardOwner(owner);
        cached = await this.dependencies.netease.resolveStream(trackId, quality, {
          signal: owner.abort.signal, priority: 'playback',
        });
      } catch (error) {
        const bridgeError = asBridgeError(error);
        if (bridgeError.code === 'AUTH_EXPIRED') throw error;
        throw new BridgeError(
          'STREAM_URL_EXPIRED',
          'Audio stream URL expired after one refresh',
          { httpStatus: 502, cause: error, details: { refreshAttempted: true } },
        );
      }
      resolvedAtMs = this.now();
      return cached;
    };
  }

  private issueForError(error: unknown): PlaybackIssue {
    const bridgeError = asBridgeError(error);
    if(error instanceof LocalSourcePrepareInterrupted&&error.code==='READ_DEADLINE')return {...makePlaybackIssue('INTERNAL_ERROR',this.newDiagnosticId()),message:'本地音乐文件准备超时，请检查来源是否可访问后重试。'};
    const reason = bridgeError.details?.reason;
    const code = reason === 'zone_lost'
      ? 'ROON_ZONE_LOST'
      : playbackIssueCode(bridgeError);
    return makePlaybackIssue(code, this.newDiagnosticId());
  }

  private setPlaybackError(error: unknown): void {
    const bridgeError = asBridgeError(error);
    this.lastPlaybackError = bridgeError.code;
    this.lastPlaybackIssue = this.issueForError(bridgeError);
    if (bridgeError.code === 'AUTH_EXPIRED') {
      try {
        this.dependencies.onProviderAuthExpired?.();
      } catch {
        this.dependencies.logger.warn('provider_expired_handler_failed', {});
      }
    }
  }

  private clearPlaybackIssue(): void {
    this.lastPlaybackError = undefined;
    this.lastPlaybackIssue = undefined;
    this.qualityNotice = undefined;
  }

  private observedTransportPlaybackState(
    fallback: 'playing' | 'paused',
  ): 'playing' | 'paused' {
    const transportState = this.dependencies.roon.getState().transportState;
    if (transportState === 'paused') return 'paused';
    if (transportState === 'playing' || transportState === 'loading') return 'playing';
    return fallback;
  }

  private newDiagnosticId(): string {
    return this.dependencies.diagnosticId?.() ?? `diag-${randomUUID()}`;
  }

  private reportStartupStage(
    trace: PlaybackStartupTrace | undefined,
    stage: PlaybackStartupStage,
  ): void {
    if (!trace) return;
    try {
      trace.onStage(stage, Math.max(0, this.now() - trace.startedAtMs));
    } catch {
      // 受控诊断绝不能改变播放结果。
    }
  }

  private now(): number {
    return this.dependencies.now?.() ?? Date.now();
  }
}
