import { randomBytes } from 'node:crypto';
import { BridgeError } from '../shared/errors.js';
import type { ResolvedAudioStream, TrackMetadata } from '../netease/types.js';

export type StreamResolver = () => Promise<ResolvedAudioStream>;

export interface StreamRegistration {
  token: string;
  metadata: TrackMetadata;
  requestedQuality: string;
  createdAtMs: number;
  expiresAtMs: number;
  resolve: StreamResolver;
}

export class StreamRegistry {
  private readonly registrations = new Map<string, StreamRegistration>();
  private readonly now: () => number;
  private readonly defaultTtlMs: number;

  constructor(options: { now?: () => number; defaultTtlMs?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.defaultTtlMs = options.defaultTtlMs ?? 8 * 60 * 60 * 1000;
  }

  register(input: {
    metadata: TrackMetadata;
    requestedQuality: string;
    resolve: StreamResolver;
    ttlMs?: number;
  }): StreamRegistration {
    this.sweepExpired();
    const token = randomBytes(32).toString('base64url');
    const createdAtMs = this.now();
    const ttlMs = input.ttlMs ?? this.defaultTtlMs;
    const registration: StreamRegistration = {
      token,
      metadata: input.metadata,
      requestedQuality: input.requestedQuality,
      createdAtMs,
      expiresAtMs: createdAtMs + ttlMs,
      resolve: input.resolve,
    };
    this.registrations.set(token, registration);
    return registration;
  }

  get(token: string): StreamRegistration {
    const registration = this.registrations.get(token);
    if (!registration || registration.expiresAtMs <= this.now()) {
      if (registration) this.registrations.delete(token);
      throw new BridgeError('STREAM_NOT_FOUND', 'Stream token is missing or expired', {
        httpStatus: 404,
      });
    }
    return registration;
  }

  revoke(token: string): void {
    this.registrations.delete(token);
  }

  revokeAll(): void {
    this.registrations.clear();
  }

  sweepExpired(): number {
    const now = this.now();
    let removed = 0;
    for (const [token, registration] of this.registrations.entries()) {
      if (registration.expiresAtMs <= now) {
        this.registrations.delete(token);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    this.sweepExpired();
    return this.registrations.size;
  }
}
