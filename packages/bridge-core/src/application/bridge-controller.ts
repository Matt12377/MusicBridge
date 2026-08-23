import { randomUUID } from 'node:crypto';
import type {
  DiagnosticResourceCounters,
  PlaybackQueueEntry,
  PlaybackIssue,
  PlaybackIssueCode,
  PlaybackQualityPreference,
  PlaybackActualQuality,
  PlaybackRecoveryAction,
  PlaybackSnapshot,
  PlaybackState,
  TrackSummary,
} from '@music-bridge/contracts';
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
  RoonPort,
  RoonState,
  RoonTerminalReason,
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
  activeStreamCount: number;
}

export type QueueItem = PlaybackQueueEntry;
type QueueInput = {
  trackId: unknown;
  qualityPreference?: unknown;
  /** 兼容旧控制请求；公开 IPC 快照不再输出此字段。 */
  quality?: unknown;
};
export type PlaybackChangedListener = (snapshot: PlaybackSnapshot) => void;

const SKIPPABLE_QUEUE_ERRORS = new Set([
  'TRACK_UNAVAILABLE',
  'TRACK_PREVIEW_ONLY',
]);
const MAX_QUEUE_ITEMS = 500;
const QUEUE_HYDRATION_BATCH_SIZE = 20;

function normalizeQueueItem(input: QueueInput): QueueItem {
  const preferenceInput = input.qualityPreference ?? input.quality;
  const qualityPreference = parseQualityPreference(preferenceInput);
  return {
    trackId: normalizeTrackId(input.trackId),
    qualityPreference,
  };
}

function toTrackSummary(track: TrackMetadata): TrackSummary {
  return {
    id: track.id,
    title: track.title,
    artists: [...track.artists],
    album: track.album,
    ...(track.durationMs !== undefined ? { durationMs: track.durationMs } : {}),
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
    ...(track.artworkUrl ? { artworkUrl: track.artworkUrl } : {}),
  };
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
  private queue: QueueItem[] = [];
  private queueIndex = -1;
  private playbackState: PlaybackState = 'idle';
  private lastPlaybackError: string | undefined;
  private lastPlaybackIssue: PlaybackIssue | undefined;
  private qualityNotice: PlaybackIssue | undefined;
  private positionMs = 0;
  private playbackGeneration = 0;
  private lastPositionPublishedAt = Number.NEGATIVE_INFINITY;
  private pendingTerminalReason: RoonTerminalReason | undefined;
  private operationTail: Promise<void> = Promise.resolve();
  private queueHydrationGeneration = 0;
  private readonly playbackListeners = new Set<PlaybackChangedListener>();

  constructor(
    private readonly dependencies: {
      netease: NeteasePort;
      roon: RoonPort;
      registry: StreamRegistry;
      gateway: StreamGateway;
      logger: Logger;
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
    this.playbackListeners.add(listener);
    listener(this.getPlaybackState());
    return () => this.playbackListeners.delete(listener);
  }

  getPlaybackState(): PlaybackSnapshot {
    const hasQueue = this.queue.length > 0;
    const hasNext = hasQueue && this.queueIndex >= 0 && this.queueIndex < this.queue.length - 1;
    const hasPrevious = hasQueue && this.queueIndex > 0;
    const selectedZoneId = this.dependencies.roon.getState().selectedZoneId;
    const currentTrack: TrackSummary | undefined = this.activePlayback
      ? {
          id: this.activePlayback.track.id,
          title: this.activePlayback.track.title,
          artists: [...this.activePlayback.track.artists],
          album: this.activePlayback.track.album,
          ...(this.activePlayback.track.durationMs !== undefined
            ? { durationMs: this.activePlayback.track.durationMs }
            : {}),
          ...(this.activePlayback.track.artworkUrl
            ? { artworkUrl: this.activePlayback.track.artworkUrl }
            : {}),
        }
      : undefined;

    return {
      state: this.playbackState,
      queue: {
        items: this.queue.map((item, index) => ({
          trackId: item.trackId,
          qualityPreference: item.qualityPreference,
          ...(item.track ? { track: cloneTrackSummary(item.track) } : {}),
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
      },
      ...(currentTrack ? { currentTrack } : {}),
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
        : {}),
      positionMs: this.positionMs,
      ...(selectedZoneId ? { selectedZoneId } : {}),
      ...(this.lastPlaybackError ? { lastError: this.lastPlaybackError } : {}),
      ...(this.lastPlaybackIssue ? { lastIssue: this.lastPlaybackIssue } : {}),
      ...(this.qualityNotice ? { qualityNotice: this.qualityNotice } : {}),
      canNext: hasNext,
      canPrevious: hasPrevious,
      canStop: this.activeToken !== undefined || this.activePlayback !== undefined,
    };
  }

  async play(input: {
    trackId: unknown;
    qualityPreference?: unknown;
    quality?: unknown;
  }): Promise<BridgeState> {
    const item = normalizeQueueItem(input);
    return this.enqueue(async () => {
      await this.stopActive();
      this.queue = [item];
      this.queueIndex = 0;
      this.clearPlaybackIssue();
      await this.startQueueIndex(0, false);
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
      const shouldHydrateInline = !preserveActivePlayback && normalizedItems.length <= QUEUE_HYDRATION_BATCH_SIZE;
      if (shouldHydrateInline) await this.hydrateQueueItems(normalizedItems);

      if (preserveActivePlayback && activePlayback) {
        const activeItem = normalizedItems[startIndex];
        if (activeItem) {
          activeItem.track = toTrackSummary(activePlayback.track);
          activeItem.requestedQuality = activePlayback.requestedQuality;
          activeItem.actualQuality = activePlayback.actualQuality;
        }
        this.queue = normalizedItems;
        this.queueIndex = startIndex;
        this.clearPlaybackIssue();
        this.notifyPlaybackChanged();
        this.scheduleQueueHydration(normalizedItems, hydrationGeneration);
        return this.getState();
      }

      await this.stopActive();
      this.queue = normalizedItems;
      this.queueIndex = startIndex;
      this.clearPlaybackIssue();
      await this.startQueueIndex(startIndex, true);
      if (!shouldHydrateInline) {
        this.scheduleQueueHydration(normalizedItems, hydrationGeneration);
      }
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
      const acceptedItems = normalizedItems.slice(0, availableSlots);
      if (acceptedItems.length === 0) return this.getState();

      const hydrationGeneration = ++this.queueHydrationGeneration;
      const shouldHydrateInline = acceptedItems.length <= QUEUE_HYDRATION_BATCH_SIZE;
      if (shouldHydrateInline) await this.hydrateQueueItems(acceptedItems);
      this.queue.push(...acceptedItems);
      this.notifyPlaybackChanged();
      if (!shouldHydrateInline) {
        this.scheduleQueueHydration(acceptedItems, hydrationGeneration);
      }
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
      const acceptedItems = normalizedItems.slice(0, availableSlots);
      if (acceptedItems.length === 0) return this.getState();

      const hydrationGeneration = ++this.queueHydrationGeneration;
      const shouldHydrateInline = acceptedItems.length <= QUEUE_HYDRATION_BATCH_SIZE;
      if (shouldHydrateInline) await this.hydrateQueueItems(acceptedItems);
      const insertionIndex = this.queueIndex >= 0 ? this.queueIndex + 1 : 0;
      this.queue.splice(insertionIndex, 0, ...acceptedItems);
      this.notifyPlaybackChanged();
      if (!shouldHydrateInline) {
        this.scheduleQueueHydration(acceptedItems, hydrationGeneration);
      }
      return this.getState();
    });
  }

  async next(): Promise<BridgeState> {
    return this.enqueue(async () => {
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
      if (this.queueIndex <= 0) return this.getState();
      const previousIndex = this.queueIndex - 1;
      await this.stopActive();
      await this.startQueueIndex(previousIndex, true);
      return this.getState();
    });
  }

  async stop(): Promise<BridgeState> {
    return this.enqueue(async () => {
      await this.stopActive();
      return this.getState();
    });
  }

  async clearQueue(): Promise<BridgeState> {
    return this.enqueue(async () => {
      this.queueHydrationGeneration += 1;
      await this.stopActive();
      this.queue = [];
      this.queueIndex = -1;
      this.playbackState = 'idle';
      this.clearPlaybackIssue();
      this.notifyPlaybackChanged();
      return this.getState();
    });
  }

  async shutdown(): Promise<void> {
    await this.enqueue(async () => {
      this.queueHydrationGeneration += 1;
      await this.stopActive();
      this.queue = [];
      this.queueIndex = -1;
      this.playbackState = 'idle';
      this.clearPlaybackIssue();
      this.notifyPlaybackChanged();
      this.dependencies.registry.revokeAll();
    });
  }

  updateRoonTime(positionMs: number, generation = this.playbackGeneration): void {
    if (
      generation !== this.playbackGeneration ||
      this.activePlayback === undefined ||
      this.playbackState !== 'playing' ||
      !Number.isSafeInteger(positionMs) ||
      positionMs < 0 ||
      positionMs > 24 * 60 * 60 * 1000
    ) {
      return;
    }
    this.positionMs = positionMs;
    const now = this.now();
    if (now - this.lastPositionPublishedAt < 250) return;
    this.lastPositionPublishedAt = now;
    this.notifyPlaybackChanged();
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
    };
  }

  getDiagnosticResourceCounters(): DiagnosticResourceCounters {
    return {
      queueItemCount: this.queue.length,
      activeStreamCount: this.dependencies.registry.size,
      activePlaybackCount: this.activePlayback ? 1 : 0,
      activeSessionCount: this.activeToken ? 1 : 0,
      activeTokenCount: this.activeToken ? 1 : 0,
      listenerCount: this.playbackListeners.size,
      timerCount: 0,
    };
  }

  private async startQueueIndex(index: number, skipUnavailable: boolean): Promise<void> {
    let candidate = index;
    let skippedError: BridgeError | undefined;

    while (candidate < this.queue.length) {
      this.queueIndex = candidate;
      this.playbackGeneration += 1;
      this.positionMs = 0;
      this.lastPositionPublishedAt = this.now();
      this.notifyPlaybackChanged();
      const item = this.queue[candidate];
      if (!item) {
        break;
      }
      try {
        await this.startItem(item);
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
    this.clearActiveResources();
    this.playbackState = 'idle';
    this.lastPlaybackError = skippedError?.code;
    this.lastPlaybackIssue = skippedError ? this.issueForError(skippedError) : undefined;
    this.qualityNotice = undefined;
    this.notifyPlaybackChanged();
  }

  private async startItem(item: QueueItem): Promise<void> {
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

    const metadata: TrackMetadata = item.track
      ? { ...item.track, artists: [...item.track.artists] }
      : await this.dependencies.netease.getTrack(item.trackId);
    item.track = toTrackSummary(metadata);
    const requestedQuality = resolveQualityPreference(item.qualityPreference);
    const initialStream = await this.dependencies.netease.resolveStream(
      item.trackId,
      requestedQuality,
    );
    await this.dependencies.gateway.preflight(initialStream);

    const resolver = this.createRefreshingResolver(
      item.trackId,
      requestedQuality,
      initialStream,
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
      item.requestedQuality = requestedQuality;
      item.actualQuality = activePlayback.actualQuality;
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

  private async stopActive(): Promise<void> {
    const hasActivePlayback = this.activeToken !== undefined || this.activePlayback !== undefined;
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
      await this.dependencies.roon.stop();
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
    this.positionMs = 0;
    this.playbackGeneration += 1;
    this.lastPositionPublishedAt = this.now();
  }

  private notifyPlaybackChanged(): void {
    const snapshot = this.getPlaybackState();
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

  private createRefreshingResolver(
    trackId: string,
    quality: QualityLevel,
    initial: ResolvedAudioStream,
  ): (request?: StreamResolveRequest) => Promise<ResolvedAudioStream> {
    let cached = initial;
    let resolvedAtMs = this.now();
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

  private newDiagnosticId(): string {
    return this.dependencies.diagnosticId?.() ?? `diag-${randomUUID()}`;
  }

  private now(): number {
    return this.dependencies.now?.() ?? Date.now();
  }
}
