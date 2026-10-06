import { currentPerformanceContext, readPerformanceTime } from '../diagnostics/performance-trace.js';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
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

export type QueueItem = PlaybackQueueEntry & {
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
      items: this.queue.map((item, index) => ({
        trackId: item.trackId,
        qualityPreference: item.qualityPreference,
        ...(item.track ? { track: cloneTrackSummary(item.track) } : {}),
        ...(item.preferredSource ? { preferredSource: item.preferredSource } : {}),
        ...(item.resolvedSource ? { resolvedSource: item.resolvedSource } : {}),
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
      this.queue = [item];
      this.queueIndex = 0;
      this.queueProjectionDirty = true;
      this.clearPlaybackIssue();
      await this.startQueueIndex(0, false, input.startupTrace);
      return this.getState();
    });
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
        this.queue = items; this.queueIndex = selectedIndex;
        context.activate();
        this.queueProjectionDirty = true; this.clearPlaybackIssue();
        await this.startQueueIndex(this.queueIndex, false);
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
          const current = this.queue[this.queueIndex];
          if (direction === 'after') { this.queue.push(...items); context.after = cursor; context.afterComplete = complete; }
          else { this.queue.unshift(...items); context.before = offset; this.rebaseInsertion(items.length); }
          if (current) this.queueIndex = this.queue.indexOf(current);
          this.queueProjectionDirty = true; this.notifyPlaybackChanged();
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

  private editContextQueue(items: QueueItem[], insert: boolean): Promise<BridgeState> {
    const context = this.queueContext ?? [...this.pendingQueueContexts].at(-1);
    const epoch = this.commandEpoch;
    const result = this.queueEditTail.then(async () => {
      if (epoch !== this.commandEpoch) throw this.cancelled();
      if (!context) return this.commitQueueEdit(items, insert);
      await context.ready;
      return this.contextTask(context, async () => {
        this.assertQueueContext(context);
        this.contextCapacity(this.queue.length + items.length);
        const before: QueueItem[] = [], after: QueueItem[] = [];
        const originalBefore = context.before, originalAfter = context.after;
        let cursor = 0, reads = 0;
        while (cursor < originalBefore) {
          if (++reads > 128) throw new BridgeError('ROON_LIBRARY_REQUEST_FAILED', '播放上下文读取工作量超限', { httpStatus: 502 });
          const loaded = await this.readQueueContext(context, cursor, Math.min(100, originalBefore - cursor));
          before.push(...loaded.items); cursor = loaded.page.nextOffset;
          this.contextCapacity(this.queue.length + before.length + items.length);
          if (loaded.page.complete && cursor < originalBefore) throw this.cancelled();
        }
        cursor = originalAfter; let complete = context.afterComplete;
        while (!complete) {
          if (++reads > 128) throw new BridgeError('ROON_LIBRARY_REQUEST_FAILED', '播放上下文读取工作量超限', { httpStatus: 502 });
          const loaded = await this.readQueueContext(context, cursor, 100);
          after.push(...loaded.items); cursor = loaded.page.nextOffset; complete = loaded.page.complete;
          this.contextCapacity(this.queue.length + before.length + after.length + items.length);
        }
        return this.enqueue(async () => {
          this.assertQueueContext(context);
          if (epoch !== this.commandEpoch || context.before !== originalBefore || context.after !== originalAfter) throw this.cancelled();
          this.contextCapacity(this.queue.length + before.length + after.length + items.length);
          const current = this.queue[this.queueIndex];
          this.queue = [...before, ...this.queue, ...after];
          this.rebaseInsertion(before.length); if (current) this.queueIndex = this.queue.indexOf(current);
          context.before = 0; context.after = cursor; context.afterComplete = true;
          this.applyQueueEdit(items, insert);
          return this.getState();
        });
      });
    });
    this.queueEditTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private applyQueueEdit(items: QueueItem[], insert: boolean): void {
    const index = insert ? this.nextInsertionQueueIndex === this.queueIndex && this.nextInsertionCursor !== undefined
      ? this.nextInsertionCursor : this.queueIndex >= 0 ? this.queueIndex + 1 : 0 : this.queue.length;
    this.queue.splice(index, 0, ...items);
    if (insert) { this.nextInsertionQueueIndex = this.queueIndex; this.nextInsertionCursor = index + items.length; }
    const generation = this.cancelQueueHydration();
    this.queueProjectionDirty = true; this.notifyPlaybackChanged(); this.scheduleQueueHydration(items, generation);
  }

  private commitQueueEdit(items: QueueItem[], insert: boolean): Promise<BridgeState> {
    return this.enqueue(async () => { this.contextCapacity(this.queue.length + items.length); this.applyQueueEdit(items, insert); return this.getState(); });
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
      this.queue = items;
      this.queueIndex = startIndex;
      this.queueProjectionDirty = true;
      this.clearPlaybackIssue();
      await this.startQueueIndex(startIndex, false);
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
        if (this.owner && activeItem) this.owner.item = activeItem;
        this.queue = normalizedItems;
        this.queueIndex = startIndex;
        this.queueProjectionDirty = true;
        this.clearPlaybackIssue();
        this.notifyPlaybackChanged();
        this.scheduleQueueHydration(normalizedItems, hydrationGeneration);
        return this.getState();
      }

      await this.stopActive();
      this.guardCommand();
      this.queue = normalizedItems;
      this.queueIndex = startIndex;
      this.queueProjectionDirty = true;
      this.clearPlaybackIssue();
      await this.startQueueIndex(startIndex, true);
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
      const acceptedItems = normalizedItems.slice(0, availableSlots);
      if (acceptedItems.length === 0) return this.getState();

      const hydrationGeneration = this.cancelQueueHydration();
      const shouldHydrateInline = acceptedItems.length <= QUEUE_HYDRATION_INLINE_LIMIT;
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
      if (availableSlots === 0) return this.getState();
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
      const acceptedItems = normalizedItems.slice(0, availableSlots);
      if (acceptedItems.length === 0) return this.getState();

      const hydrationGeneration = this.cancelQueueHydration();
      const shouldHydrateInline = acceptedItems.length <= QUEUE_HYDRATION_INLINE_LIMIT;
      const insertionIndex = this.nextInsertionQueueIndex === this.queueIndex && this.nextInsertionCursor !== undefined
        ? this.nextInsertionCursor
        : this.queueIndex >= 0 ? this.queueIndex + 1 : 0;
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
      if (this.queue.length >= MAX_QUEUE_ITEMS) return this.getState();
      const insertionIndex = this.queueIndex >= 0 ? this.queueIndex + 1 : 0;
      this.queue.splice(insertionIndex, 0, item);
      this.queueProjectionDirty = true;
      this.notifyPlaybackChanged();
      return this.getState();
    });
  }

  async next(): Promise<BridgeState> {
    if (this.queueContext) return this.navigateQueueContext(this.queueContext, 1);
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
    if (this.queueContext) return this.navigateQueueContext(this.queueContext, -1);
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
    this.cancelQueueContext();
    ++this.commandEpoch;
    this.owner?.abort.abort();
    return this.enqueue(async () => {
      this.cancelNextPreparation();
      await this.stopActive(true);
      return this.getState();
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
    this.cancelQueueContext();
    const zoneId = this.dependencies.roon.getState().selectedZoneId;
    ++this.commandEpoch;
    this.owner?.abort.abort();
    return this.enqueue(async () => {
      this.cancelNextPreparation();
      if (this.hasPlaybackOwnership()) {
        await this.stopActive(true);
      } else {
        await this.device(() => this.dependencies.roonLibrary?.stop(zoneId ? { expectedZoneId: zoneId } : {}) ?? Promise.resolve());
      }
      return this.getState();
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
    return this.enqueueControl(async () => {
      const owner = this.owner;
      const generation = this.playbackGeneration;
      const options = this.ownerOptions(owner);
      const roonLibrary = this.dependencies.roonLibrary;
      if (this.activeRoonPlayback && roonLibrary?.seek) {
        await this.device(() => { this.guardControl(owner, generation); return roonLibrary.seek!(positionMs, options); });
        this.guardControl(owner, generation);
        this.notifyPlaybackChanged('full');
        return this.getState();
      }
      if (this.activePlayback && this.dependencies.roon.seek) {
        await this.device(() => { this.guardControl(owner, generation); return this.dependencies.roon.seek!(positionMs, options); });
        this.guardControl(owner, generation);
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
  }

  async shutdown(): Promise<void> {
    this.cancelQueueContext();
    ++this.commandEpoch;
    this.owner?.abort.abort();
    await this.enqueue(async () => {
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
    });
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
      ? 'netease'
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
        && positionContext.source === 'netease'
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
    this.positionMs = positionMs;
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
  ): Promise<void> {
    this.guardCommand();
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
        item, zoneId: item.roonZoneId ?? this.dependencies.roon.getState().selectedZoneId ?? '',
        source: item.roonReference || item.preferredSource === 'roon' ? 'roon' : 'netease',
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
        owner.preparing = false;
        if (skippedError) {
          this.lastPlaybackError = skippedError.code;
          this.lastPlaybackIssue = this.issueForError(skippedError);
        }
        this.notifyPlaybackChanged();
        return;
      } catch (error) {
        if (this.owner !== owner || owner.abort.signal.aborted) throw this.cancelled();
        this.cancelQueueHydration();
        if (!owner.dispatched && !this.stopUnknown) { owner.abort.abort(); this.owner = undefined; }
        const bridgeError = asBridgeError(error);
        if (!skipUnavailable || !isSkippableQueueError(error)) {
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
        if (item.track || !this.queue.includes(item) || item === this.owner?.item) continue;
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
    this.owner?.abort.abort();
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

  private guardCommand(): void {
    if (this.runningCommandEpoch !== this.commandEpoch
      || this.runningQueueReplacementGeneration !== this.queueReplacementGeneration) throw this.cancelled();
  }

  private cancelled(): BridgeError {
    return new BridgeError('BAD_REQUEST', '播放操作已取消', { httpStatus: 409, details: { reason: 'operation_cancelled' } });
  }

  private guardOwner(owner: PlaybackOwner): void {
    if (this.owner !== owner || owner.abort.signal.aborted || this.queue[this.queueIndex] !== owner.item
      || (this.dependencies.roon.getState().selectedZoneId ?? '') !== owner.zoneId
      || (owner.token !== undefined && this.activeToken !== owner.token)) throw this.cancelled();
  }

  private guardControl(owner: PlaybackOwner | undefined, generation: number): void {
    if (this.owner !== owner || this.playbackGeneration !== generation || owner?.abort.signal.aborted) throw this.cancelled();
  }

  private ownerOptions(owner: PlaybackOwner | undefined): RoonOperationOptions {
    return { ...(owner ? { signal: owner.abort.signal, expectedZoneId: owner.zoneId } : {}) };
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
    const result = this.deviceTail.then(operation);
    this.deviceTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private devicePlay<T>(operation: (onCompletion: (completion: Promise<void>) => void) => Promise<T>): Promise<T> {
    let completionRegistered = false;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
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
        if (epoch !== this.commandEpoch || replacementGeneration !== this.queueReplacementGeneration) throw this.cancelled();
        this.runningCommandEpoch = epoch;
        this.runningQueueReplacementGeneration = replacementGeneration;
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
    return this.enqueue(() => {
      const result = this.controlTail.then(() => {
        if (epoch !== this.commandEpoch) throw this.cancelled();
        return operation();
      });
      this.controlTail = result.then(() => undefined, () => undefined);
      return result;
    });
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
    this.nextPreparation?.abort.abort();
    this.nextPreparation = undefined;
  }

  private scheduleNextPreparation(): void {
    if (!this.activePlayback || this.playbackState !== 'playing' || !this.dependencies.netease.configured) return;
    const item = this.queue[this.queueIndex + 1];
    if (!item || item.roonReference || item.preferredSource === 'roon' || item.preferredSource === 'smart') {
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
