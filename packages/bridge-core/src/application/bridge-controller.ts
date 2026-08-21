import type {
  PlaybackQueueItem,
  PlaybackQuality,
  PlaybackSnapshot,
  PlaybackState,
  TrackSummary,
} from '@music-bridge/contracts';
import { BridgeError, asBridgeError } from '../shared/errors.js';
import type { Logger } from '../shared/logger.js';
import {
  normalizeTrackId,
  parseQuality,
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
import type { StreamRegistry } from '../stream/registry.js';

export interface ActivePlayback {
  track: TrackMetadata;
  requestedQuality: QualityLevel;
  actualQuality: string;
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

export type QueueItem = PlaybackQueueItem;
export type PlaybackChangedListener = (snapshot: PlaybackSnapshot) => void;

const SKIPPABLE_QUEUE_ERRORS = new Set([
  'TRACK_UNAVAILABLE',
  'TRACK_PREVIEW_ONLY',
]);

function normalizeQueueItem(input: {
  trackId: unknown;
  quality: unknown;
}): QueueItem {
  return {
    trackId: normalizeTrackId(input.trackId),
    quality: parseQuality(input.quality) as PlaybackQuality,
  };
}

function isSkippableQueueError(error: unknown): boolean {
  return SKIPPABLE_QUEUE_ERRORS.has(asBridgeError(error).code);
}

export class BridgeController {
  private activeToken: string | undefined;
  private activePlayback: ActivePlayback | undefined;
  private queue: QueueItem[] = [];
  private queueIndex = -1;
  private playbackState: PlaybackState = 'idle';
  private lastPlaybackError: string | undefined;
  private pendingTerminalReason: RoonTerminalReason | undefined;
  private operationTail: Promise<void> = Promise.resolve();
  private readonly playbackListeners = new Set<PlaybackChangedListener>();

  constructor(
    private readonly dependencies: {
      netease: NeteasePort;
      roon: RoonPort;
      registry: StreamRegistry;
      gateway: StreamGateway;
      logger: Logger;
      now?: () => number;
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
          this.playbackState = reason === 'media_error' ? 'error' : 'idle';
          this.lastPlaybackError =
            reason === 'media_error'
              ? 'ROON_MEDIA_ERROR'
              : reason === 'zone_lost'
                ? 'ROON_ZONE_NOT_SELECTED'
                : undefined;
          this.notifyPlaybackChanged();
          this.dependencies.logger.info('roon_session_terminal', { reason });
          return;
        }

        const nextIndex = this.queueIndex + 1;
        if (nextIndex >= this.queue.length) {
          this.playbackState = 'idle';
          this.lastPlaybackError = undefined;
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
        items: this.queue.map((item) => ({ ...item })),
        index: this.queueIndex,
        hasNext,
        hasPrevious,
      },
      ...(currentTrack ? { currentTrack } : {}),
      ...(this.activePlayback
        ? {
            requestedQuality: this.activePlayback.requestedQuality,
            actualQuality: this.activePlayback.actualQuality,
            ...(this.activePlayback.format ? { format: this.activePlayback.format } : {}),
            ...(this.activePlayback.bitrate !== undefined
              ? { bitrate: this.activePlayback.bitrate }
              : {}),
          }
        : {}),
      ...(selectedZoneId ? { selectedZoneId } : {}),
      ...(this.lastPlaybackError ? { lastError: this.lastPlaybackError } : {}),
      canNext: hasNext,
      canPrevious: hasPrevious,
      canStop: this.activeToken !== undefined || this.activePlayback !== undefined,
    };
  }

  async play(input: {
    trackId: unknown;
    quality: unknown;
  }): Promise<BridgeState> {
    const item = normalizeQueueItem(input);
    return this.enqueue(async () => {
      await this.stopActive();
      this.queue = [item];
      this.queueIndex = 0;
      this.lastPlaybackError = undefined;
      await this.startQueueIndex(0, false);
      return this.getState();
    });
  }

  async replaceQueue(
    items: readonly { trackId: unknown; quality: unknown }[],
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
      await this.stopActive();
      this.queue = normalizedItems;
      this.queueIndex = startIndex;
      this.lastPlaybackError = undefined;
      await this.startQueueIndex(startIndex, true);
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

  async shutdown(): Promise<void> {
    await this.enqueue(async () => {
      await this.stopActive();
      this.queue = [];
      this.queueIndex = -1;
      this.playbackState = 'idle';
      this.lastPlaybackError = undefined;
      this.notifyPlaybackChanged();
      this.dependencies.registry.revokeAll();
    });
  }

  getState(): BridgeState {
    return {
      neteaseConfigured: this.dependencies.netease.configured,
      roon: this.dependencies.roon.getState(),
      activeStreamCount: this.dependencies.registry.size,
      ...(this.activePlayback ? { activePlayback: this.activePlayback } : {}),
    };
  }

  private async startQueueIndex(index: number, skipUnavailable: boolean): Promise<void> {
    let candidate = index;
    let skippedError: string | undefined;

    while (candidate < this.queue.length) {
      this.queueIndex = candidate;
      this.notifyPlaybackChanged();
      const item = this.queue[candidate];
      if (!item) {
        break;
      }
      try {
        await this.startItem(item);
        if (skippedError) this.lastPlaybackError = skippedError;
        this.notifyPlaybackChanged();
        return;
      } catch (error) {
        const bridgeError = asBridgeError(error);
        if (!skipUnavailable || !isSkippableQueueError(error)) {
          this.playbackState = 'error';
          this.lastPlaybackError = bridgeError.code;
          this.notifyPlaybackChanged();
          throw error;
        }
        skippedError = bridgeError.code;
        candidate += 1;
      }
    }

    this.queueIndex = this.queue.length > 0 ? this.queue.length - 1 : -1;
    this.clearActiveResources();
    this.playbackState = 'idle';
    this.lastPlaybackError = skippedError;
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
    this.lastPlaybackError = undefined;
    this.notifyPlaybackChanged();

    const metadata = await this.dependencies.netease.getTrack(item.trackId);
    const initialStream = await this.dependencies.netease.resolveStream(
      item.trackId,
      item.quality,
    );
    await this.dependencies.gateway.preflight(initialStream);

    const resolver = this.createRefreshingResolver(
      item.trackId,
      item.quality,
      initialStream,
    );
    const registration = this.dependencies.registry.register({
      metadata,
      requestedQuality: item.quality,
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
      requestedQuality: item.quality,
      actualQuality: initialStream.actualQuality,
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
      this.playbackState = 'playing';
      this.lastPlaybackError = undefined;
      this.dependencies.logger.info('bridge_playing', {
        trackId: item.trackId,
        title: metadata.title,
        requestedQuality: item.quality,
        actualQuality: initialStream.actualQuality,
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
      this.playbackState = 'error';
      this.lastPlaybackError = asBridgeError(error).code;
      this.notifyPlaybackChanged();
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
    this.notifyPlaybackChanged();
    try {
      await this.dependencies.roon.stop();
    } finally {
      this.clearActiveResources();
      this.playbackState = 'idle';
      this.notifyPlaybackChanged();
    }
  }

  private clearActiveResources(): void {
    if (this.activeToken) {
      this.dependencies.gateway.clearStageObserver(this.activeToken);
      this.dependencies.registry.revoke(this.activeToken);
    }
    this.activeToken = undefined;
    this.activePlayback = undefined;
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
  ): () => Promise<ResolvedAudioStream> {
    let cached = initial;
    let resolvedAtMs = this.now();

    return async (): Promise<ResolvedAudioStream> => {
      const advertisedTtlMs = (cached.expiresInSeconds ?? 120) * 1000;
      const refreshAfterMs = Math.max(10_000, advertisedTtlMs - 30_000);
      if (this.now() - resolvedAtMs < refreshAfterMs) return cached;

      cached = await this.dependencies.netease.resolveStream(trackId, quality);
      resolvedAtMs = this.now();
      return cached;
    };
  }

  private now(): number {
    return this.dependencies.now?.() ?? Date.now();
  }
}
