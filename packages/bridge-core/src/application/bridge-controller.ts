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
} from '@music-bridge/contracts';
import { MAX_PLAYBACK_QUEUE_ITEMS } from '@music-bridge/contracts';
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
  play(reference: string, zoneId: string, track: TrackSummary): Promise<RoonPlaybackObservation>;
  stop(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  seek?(positionMs: number): Promise<void>;
}
export type PlaybackChangedListener = (snapshot: PlaybackSnapshot) => void;

const SKIPPABLE_QUEUE_ERRORS = new Set([
  'TRACK_UNAVAILABLE',
  'TRACK_PREVIEW_ONLY',
]);
const MAX_QUEUE_ITEMS = MAX_PLAYBACK_QUEUE_ITEMS;
const QUEUE_HYDRATION_BATCH_SIZE = 20;

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

function freezeQueuePublication(queue: PlaybackQueueSnapshot): PlaybackQueueSnapshot {
  for (const item of queue.items) {
    if (item.track) {
      Object.freeze(item.track.artists);
      Object.freeze(item.track);
    }
    Object.freeze(item);
  }
  Object.freeze(queue.items);
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
  private queueHydrationGeneration = 0;
  private nextPreparation: {
    item: QueueItem;
    quality: QualityLevel;
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
    },
  ) {
    this.dependencies.roon.setTerminalHandler((reason) => {
      if (this.activeToken && !this.activePlayback) {
        this.pendingTerminalReason = reason;
      }
      void this.enqueue(async () => {
        const playbackWasPlaying = this.activePlayback !== undefined;
        if (!this.activeToken && !this.activePlayback) return;

        this.clearActiveResources();
        if (reason !== 'ended' || !playbackWasPlaying) {
          this.nextPreparation = undefined;
          this.playbackState = reason === 'stopped' ? 'idle' : 'error';
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
        await this.startQueueIndex(nextIndex, true);
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
    listener(snapshot);
    return () => this.playbackListeners.delete(listener);
  }

  getPlaybackState(): PlaybackSnapshot {
    return this.playbackSnapshot(this.projectQueueSnapshot());
  }

  private projectQueueSnapshot(): PlaybackQueueSnapshot {
    const hasQueue = this.queue.length > 0;
    const hasNext = hasQueue && this.queueIndex >= 0 && this.queueIndex < this.queue.length - 1;
    const hasPrevious = hasQueue && this.queueIndex > 0;
    return {
      items: this.queue.map((item, index) => ({
        trackId: item.trackId,
        qualityPreference: item.qualityPreference,
        ...(item.track ? { track: cloneTrackSummary(item.track) } : {}),
        ...(item.preferredSource ? { preferredSource: item.preferredSource } : {}),
        ...(item.resolvedSource ? { resolvedSource: item.resolvedSource } : {}),
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
    return this.enqueue(async () => {
      await this.stopActive();
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

  async replaceRoonQueue(inputs: readonly NativeRoonQueueInput[], startIndex: number): Promise<BridgeState> {
    if (inputs.length === 0 || inputs.length > MAX_QUEUE_ITEMS
      || !Number.isSafeInteger(startIndex) || startIndex < 0 || startIndex >= inputs.length) {
      throw new BridgeError('BAD_REQUEST', '本地播放队列或起始位置无效', { httpStatus: 400 });
    }
    // 在停止现有播放前验证整个上下文，避免无效请求破坏当前队列。
    const items = inputs.map(normalizeNativeRoonQueueItem);
    return this.enqueue(async () => {
      ++this.queueHydrationGeneration;
      await this.stopActive();
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

    return this.enqueue(async () => {
      const hydrationGeneration = ++this.queueHydrationGeneration;
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
        this.queue = normalizedItems;
        this.queueIndex = startIndex;
        this.queueProjectionDirty = true;
        this.clearPlaybackIssue();
        this.notifyPlaybackChanged();
        this.scheduleQueueHydration(normalizedItems, hydrationGeneration);
        return this.getState();
      }

      await this.stopActive();
      this.queue = normalizedItems;
      this.queueIndex = startIndex;
      this.queueProjectionDirty = true;
      this.clearPlaybackIssue();
      // 当前歌曲等待 Roon SessionBegan/Playing 时，先并行填充后续队列；
      // 这样 Next 与队列内容不再被 Core 启动延迟串行阻塞。
      this.scheduleQueueHydration(
        normalizedItems.filter((_item, index) => index !== startIndex),
        hydrationGeneration,
      );
      await this.startQueueIndex(startIndex, true);
      return this.getState();
    });
  }

  async appendQueue(
    items: readonly QueueInput[],
  ): Promise<BridgeState> {
    const normalizedItems = items.map((item) => normalizeQueueItem(item));
    if (normalizedItems.length === 0) return this.getState();

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

      const hydrationGeneration = ++this.queueHydrationGeneration;
      const shouldHydrateInline = acceptedItems.length <= QUEUE_HYDRATION_BATCH_SIZE;
      if (shouldHydrateInline) await this.hydrateQueueItems(acceptedItems);
      this.queue.push(...acceptedItems);
      this.queueProjectionDirty = true;
      this.notifyPlaybackChanged();
      if (!shouldHydrateInline) {
        this.scheduleQueueHydration(acceptedItems, hydrationGeneration);
      }
      return this.getState();
    });
  }

  async appendRoon(input: NativeRoonQueueInput): Promise<BridgeState> {
    const item = normalizeNativeRoonQueueItem(input);
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

      const hydrationGeneration = ++this.queueHydrationGeneration;
      const shouldHydrateInline = acceptedItems.length <= QUEUE_HYDRATION_BATCH_SIZE;
      if (shouldHydrateInline) await this.hydrateQueueItems(acceptedItems);
      const insertionIndex = this.nextInsertionQueueIndex === this.queueIndex && this.nextInsertionCursor !== undefined
        ? this.nextInsertionCursor
        : this.queueIndex >= 0 ? this.queueIndex + 1 : 0;
      this.queue.splice(insertionIndex, 0, ...acceptedItems);
      this.queueProjectionDirty = true;
      this.nextInsertionQueueIndex = this.queueIndex;
      this.nextInsertionCursor = insertionIndex + acceptedItems.length;
      this.notifyPlaybackChanged();
      if (!shouldHydrateInline) {
        this.scheduleQueueHydration(acceptedItems, hydrationGeneration);
      }
      return this.getState();
    });
  }

  async insertNextRoon(input: NativeRoonQueueInput): Promise<BridgeState> {
    const item = normalizeNativeRoonQueueItem(input);
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
    return this.enqueue(async () => {
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
    return this.enqueue(async () => {
      this.syncNativeRoonTrack();
      if (this.activeRoonPlayback && this.queueIndex <= 0) return this.navigateNativeRoon('previous');
      if (this.queueIndex <= 0) return this.getState();
      const previousIndex = this.queueIndex - 1;
      await this.stopActive();
      await this.startQueueIndex(previousIndex, true);
      return this.getState();
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
    await this.dependencies.roon.control!(direction);
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
    return this.enqueue(async () => {
      if (index >= this.queue.length) {
        throw new BridgeError('BAD_REQUEST', 'Playback queue index is invalid', {
          httpStatus: 400,
        });
      }
      if (
        index === this.queueIndex &&
        (this.activePlayback !== undefined || this.activeRoonPlayback !== undefined)
      ) {
        return this.getState();
      }
      await this.stopActive();
      await this.startQueueIndex(index, true);
      return this.getState();
    });
  }

  async stop(): Promise<BridgeState> {
    return this.enqueue(async () => {
      this.nextPreparation = undefined;
      await this.stopActive();
      return this.getState();
    });
  }

  async pause(): Promise<BridgeState> {
    return this.enqueue(async () => {
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
        if (this.activeRoonPlayback) await this.dependencies.roonLibrary?.pause();
        else await this.dependencies.roon.pause();
        const changed = this.getPlaybackState().state !== 'paused'
          || this.lastPlaybackError !== undefined
          || this.lastPlaybackIssue !== undefined;
        this.playbackState = 'paused';
        this.lastPlaybackError = undefined;
        this.lastPlaybackIssue = undefined;
        if (changed) this.notifyPlaybackChanged();
        return this.getState();
      } catch (error) {
        this.playbackState = this.observedTransportPlaybackState('playing');
        this.setPlaybackError(error);
        this.notifyPlaybackChanged();
        throw error;
      }
    });
  }

  async stopRoonTransport(): Promise<BridgeState> {
    return this.enqueue(async () => {
      this.nextPreparation = undefined;
      if (this.activeToken !== undefined || this.activePlayback !== undefined || this.activeRoonPlayback !== undefined) {
        await this.stopActive();
      } else {
        await this.dependencies.roonLibrary?.stop();
      }
      return this.getState();
    });
  }

  async resume(): Promise<BridgeState> {
    return this.enqueue(async () => {
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
        if (this.activeRoonPlayback) await this.dependencies.roonLibrary?.resume();
        else await this.dependencies.roon.resume();
        const changed = this.getPlaybackState().state !== 'playing'
          || this.lastPlaybackError !== undefined
          || this.lastPlaybackIssue !== undefined;
        this.playbackState = 'playing';
        this.lastPlaybackError = undefined;
        this.lastPlaybackIssue = undefined;
        if (changed) this.notifyPlaybackChanged();
        return this.getState();
      } catch (error) {
        this.playbackState = this.observedTransportPlaybackState('paused');
        this.setPlaybackError(error);
        this.notifyPlaybackChanged();
        throw error;
      }
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
    return this.enqueue(async () => {
      const roonLibrary = this.dependencies.roonLibrary;
      if (this.activeRoonPlayback && roonLibrary?.seek) {
        await roonLibrary.seek(positionMs);
        return this.getState();
      }
      if (this.activePlayback && this.dependencies.roon.seek) {
        await this.dependencies.roon.seek(positionMs);
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
    this.nextPreparation = undefined;
    this.clearPlaybackIssue();
    this.lastPositionPublishedAt = this.now();
    this.notifyPlaybackChanged();
  }

  async clearQueue(): Promise<BridgeState> {
    return this.enqueue(async () => {
      this.nextPreparation = undefined;
      this.queueHydrationGeneration += 1;
      await this.stopActive();
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
    await this.enqueue(async () => {
      this.nextPreparation = undefined;
      this.queueHydrationGeneration += 1;
      await this.stopActive();
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
    const now = this.now();
    if (now - this.lastPositionPublishedAt < 250) return true;
    this.lastPositionPublishedAt = now;
    this.notifyPlaybackChanged('position');
    return true;
  }

  handleRoonPlaybackState(state: RoonNativePlaybackState | undefined): void {
    const previous = this.lastNativeRoonPlaybackState;
    this.lastNativeRoonPlaybackState = state;
    if (
      state !== 'stopped' ||
      (previous !== 'playing' && previous !== 'loading') ||
      this.nativeRoonStopRequested ||
      this.activeRoonPlayback === undefined
    ) {
      return;
    }

    const generation = this.playbackGeneration;
    void this.enqueue(async () => {
      if (this.nativeRoonStopRequested || this.activeRoonPlayback === undefined
        || generation !== this.playbackGeneration) return;
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
      await this.startQueueIndex(nextIndex, true);
    }).catch((error: unknown) => {
      const bridgeError = asBridgeError(error);
      this.dependencies.logger.warn('queue_advance_failed', { code: bridgeError.code });
    });
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

  private async startQueueIndex(
    index: number,
    skipUnavailable: boolean,
    startupTrace?: PlaybackStartupTrace,
  ): Promise<void> {
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
      try {
        await this.startItem(item, startupTrace);
        if (skippedError) {
          this.lastPlaybackError = skippedError.code;
          this.lastPlaybackIssue = this.issueForError(skippedError);
        }
        this.notifyPlaybackChanged();
        return;
      } catch (error) {
        const bridgeError = asBridgeError(error);
        if (!skipUnavailable || !isSkippableQueueError(error)) {
          this.playbackState = 'error';
          this.setPlaybackError(bridgeError);
          this.notifyPlaybackChanged();
          throw error;
        }
        skippedError = bridgeError;
        candidate += 1;
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
    startupTrace?: PlaybackStartupTrace,
  ): Promise<void> {
    if (item.preferredSource === 'roon' || item.roonReference) {
      await this.startRoonItem(item);
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
    const candidate = preparation?.item === item && preparation.quality === requestedQuality
      ? await preparation.result : undefined;
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
        : await this.dependencies.netease.getTrack(item.trackId);
      this.reportStartupStage(startupTrace, 'metadata-ready');
    } else {
      const metadataRequest: Promise<TrackMetadata> = item.track
        ? Promise.resolve({ ...item.track, artists: [...item.track.artists] })
        : this.dependencies.netease.getTrack(item.trackId);
      [metadata, initialStream] = await Promise.all([
        metadataRequest.then((value) => {
          this.reportStartupStage(startupTrace, 'metadata-ready');
          return value;
        }),
        this.dependencies.netease.resolveStream(item.trackId, requestedQuality).then((value) => {
          this.reportStartupStage(startupTrace, 'stream-url-ready');
          return value;
        }),
      ]);
    }
    item.track = toTrackSummary(metadata);
    this.queueProjectionDirty = true;
    if (item.preferredSource === 'smart' && this.dependencies.resolveSmartSource) {
      const resolution = await this.dependencies.resolveSmartSource(item.track);
      if (resolution) {
        item.roonReference = resolution.reference;
        item.roonZoneId = resolution.zoneId;
        try {
          await this.startRoonItem(item);
          return;
        } catch (error) {
          this.dependencies.logger.warn('smart_roon_fallback', {
            code: asBridgeError(error).code,
          });
          // A failed native start can be ambiguous at the transport boundary.
          // Stop it before starting the V1 Provider path to prevent overlap.
          await this.dependencies.roonLibrary?.stop();
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
      initialStream = await this.dependencies.netease.resolveStream(
        item.trackId,
        requestedQuality,
      );
      this.reportStartupStage(startupTrace, 'stream-url-ready');
    }
    if (!prepared) await this.dependencies.gateway.preflight(initialStream);
    this.reportStartupStage(startupTrace, 'gateway-preflight-ready');

    const resolver = this.createRefreshingResolver(
      item.trackId,
      requestedQuality,
      initialStream,
      prepared?.resolvedAtMs,
    );
    const registration = this.dependencies.registry.register({
      metadata,
      requestedQuality,
      resolve: resolver,
      ttlMs: Math.max((metadata.durationMs ?? 0) + 60 * 60 * 1000, 2 * 60 * 60 * 1000),
    });

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
      await this.dependencies.roon.play({
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
      this.pendingTerminalReason = undefined;
      this.clearActiveResources();
      throw error;
    }
  }

  private async startRoonItem(item: QueueItem): Promise<void> {
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
      const observation = await roonLibrary.play(reference, zoneId, track);
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
      this.activeRoonPlayback = undefined;
      delete item.resolvedSource;
      this.queueProjectionDirty = true;
      throw error;
    }
  }

  private async stopActive(): Promise<void> {
    const hasActivePlayback =
      this.activeToken !== undefined ||
      this.activePlayback !== undefined ||
      this.activeRoonPlayback !== undefined;
    if (!hasActivePlayback) {
      if (this.playbackState !== 'idle') {
        this.playbackState = 'idle';
        this.notifyPlaybackChanged();
      }
      return;
    }

    this.playbackState = 'stopping';
    this.positionMs = 0;
    this.playbackGeneration += 1;
    this.lastPositionPublishedAt = this.now();
    this.notifyPlaybackChanged();
    try {
      if (this.activeRoonPlayback) {
        this.nativeRoonStopRequested = true;
        try {
          await this.dependencies.roonLibrary?.stop();
        } finally {
          this.nativeRoonStopRequested = false;
        }
      } else {
        await this.dependencies.roon.stop();
      }
    } finally {
      this.clearActiveResources();
      this.playbackState = 'idle';
      this.clearPlaybackIssue();
      this.notifyPlaybackChanged();
    }
  }

  private async hydrateQueueItems(items: readonly QueueItem[]): Promise<void> {
    for (let start = 0; start < items.length; start += QUEUE_HYDRATION_BATCH_SIZE) {
      const batch = items.slice(start, start + QUEUE_HYDRATION_BATCH_SIZE);
      await Promise.all(batch.map(async (item) => {
        if (item.track) return;
        try {
          item.track = toTrackSummary(await this.dependencies.netease.getTrack(item.trackId));
          // 分批 hydration 的 await 间隙可能穿插进度回报。
          this.queueProjectionDirty = true;
        } catch {
          // 元数据不可用时，构建队列仍保持非破坏性；歌曲成为当前项时再重新确认。
        }
      }));
    }
  }

  private scheduleQueueHydration(
    items: readonly QueueItem[],
    generation: number,
  ): void {
    void this.hydrateQueueItems(items).then(() => {
      if (generation === this.queueHydrationGeneration) this.notifyPlaybackChanged();
    });
  }

  private clearActiveResources(): void {
    if (this.activeToken) {
      this.dependencies.gateway.clearStageObserver(this.activeToken);
      this.dependencies.registry.revoke(this.activeToken);
    }
    this.activeToken = undefined;
    this.activePlayback = undefined;
    this.activeRoonPlayback = undefined;
    this.queueProjectionDirty = true;
    this.positionContext = undefined;
    this.positionMs = 0;
    this.playbackGeneration += 1;
    this.lastPositionPublishedAt = this.now();
  }

  private notifyPlaybackChanged(kind: 'full' | 'position' = 'full'): void {
    this.scheduleNextPreparation();
    const snapshot = this.playbackPublication(kind);
    this.publishPlayback(snapshot);
  }

  private notifyPlaybackChangedIfDifferent(): void {
    const snapshot = this.playbackPublication('full');
    if (this.lastPublishedPlayback && isDeepStrictEqual(this.lastPublishedPlayback, snapshot)) return;
    this.scheduleNextPreparation();
    this.publishPlayback(snapshot);
  }

  private publishPlayback(snapshot: PlaybackSnapshot): void {
    this.lastPublishedPlayback = snapshot;
    for (const listener of this.playbackListeners) {
      try {
        listener(snapshot);
      } catch {
        this.dependencies.logger.warn('playback_listener_failed', {});
      }
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operationTail.then(operation);
    this.operationTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** 仅提前解析紧邻下一首的短期URL和响应头，不下载音频、不注册流或占用Roon会话。 */
  private scheduleNextPreparation(): void {
    if (!this.activePlayback || this.playbackState !== 'playing' || !this.dependencies.netease.configured) return;
    const item = this.queue[this.queueIndex + 1];
    if (!item || item.roonReference || item.preferredSource === 'roon' || item.preferredSource === 'smart') {
      this.nextPreparation = undefined;
      return;
    }
    const quality = resolveQualityPreference(item.qualityPreference);
    if (this.preparationInFlight || this.nextPreparation?.item === item && this.nextPreparation.quality === quality) return;
    this.preparationInFlight = true;
    const result = (async () => {
      try {
        const resolvedAtMs = this.now();
        const [metadata, stream] = await Promise.all([
          item.track ? Promise.resolve({ ...item.track, artists: [...item.track.artists] }) : this.dependencies.netease.getTrack(item.trackId),
          this.dependencies.netease.resolveStream(item.trackId, quality),
        ]);
        await this.dependencies.gateway.preflight(stream);
        const expiresAtMs = resolvedAtMs + Math.max(0, (stream.expiresInSeconds ?? 120) * 1000 - 30_000);
        return { metadata, stream, resolvedAtMs, expiresAtMs };
      } catch {
        // 预解析失败不改变当前歌曲、登录状态或队列；真正播放时走正常错误路径。
        return undefined;
      } finally {
        this.preparationInFlight = false;
        // 队列可能在请求期间被替换，只为当前紧邻下一首调度后继请求。
        if (this.queue[this.queueIndex + 1] !== item) queueMicrotask(() => this.scheduleNextPreparation());
      }
    })();
    this.nextPreparation = { item, quality, result };
  }

  private createRefreshingResolver(
    trackId: string,
    quality: QualityLevel,
    initial: ResolvedAudioStream,
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
        cached = await this.dependencies.netease.resolveStream(trackId, quality);
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
