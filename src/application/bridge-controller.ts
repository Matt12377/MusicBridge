import { BridgeError } from '../shared/errors.js';
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
import type { RoonPort, RoonState } from '../roon/types.js';
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

export class BridgeController {
  private activeToken: string | undefined;
  private activePlayback: ActivePlayback | undefined;

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
      if (this.activeToken) this.dependencies.registry.revoke(this.activeToken);
      this.activeToken = undefined;
      this.activePlayback = undefined;
      this.dependencies.logger.info('roon_session_terminal', { reason });
    });
  }

  async play(input: {
    trackId: unknown;
    quality: unknown;
  }): Promise<BridgeState> {
    const trackId = normalizeTrackId(input.trackId);
    const quality = parseQuality(input.quality);

    if (!this.dependencies.netease.configured) {
      throw new BridgeError(
        'NETEASE_NOT_CONFIGURED',
        'NETEASE_COOKIE is not configured',
        { httpStatus: 503 },
      );
    }

    await this.stop();

    const metadata = await this.dependencies.netease.getTrack(trackId);
    const initialStream = await this.dependencies.netease.resolveStream(
      trackId,
      quality,
    );
    await this.dependencies.gateway.preflight(initialStream);

    const resolver = this.createRefreshingResolver(
      trackId,
      quality,
      initialStream,
    );
    const registration = this.dependencies.registry.register({
      metadata,
      requestedQuality: quality,
      resolve: resolver,
      ttlMs: Math.max((metadata.durationMs ?? 0) + 60 * 60 * 1000, 2 * 60 * 60 * 1000),
    });

    this.activeToken = registration.token;
    const activePlayback: ActivePlayback = {
      track: metadata,
      requestedQuality: quality,
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
        mediaUrl: this.dependencies.gateway.streamUrl(registration.token),
        iconUrl: this.dependencies.gateway.iconUrl(),
        metadata,
      });
      if (this.activeToken !== registration.token) {
        throw new BridgeError(
          'ROON_MEDIA_ERROR',
          'Roon session ended while playback was starting',
          { httpStatus: 502 },
        );
      }
      this.activePlayback = activePlayback;
      this.dependencies.logger.info('bridge_playing', {
        trackId,
        title: metadata.title,
        requestedQuality: quality,
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
      return this.getState();
    } catch (error) {
      this.dependencies.registry.revoke(registration.token);
      this.activeToken = undefined;
      this.activePlayback = undefined;
      throw error;
    }
  }

  async stop(): Promise<BridgeState> {
    if (!this.activeToken && !this.activePlayback) {
      return this.getState();
    }

    try {
      await this.dependencies.roon.stop();
    } finally {
      if (this.activeToken) {
        this.dependencies.registry.revoke(this.activeToken);
      }
      this.activeToken = undefined;
      this.activePlayback = undefined;
    }
    return this.getState();
  }

  async shutdown(): Promise<void> {
    await this.stop();
    this.dependencies.registry.revokeAll();
  }

  getState(): BridgeState {
    return {
      neteaseConfigured: this.dependencies.netease.configured,
      roon: this.dependencies.roon.getState(),
      activeStreamCount: this.dependencies.registry.size,
      ...(this.activePlayback ? { activePlayback: this.activePlayback } : {}),
    };
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
