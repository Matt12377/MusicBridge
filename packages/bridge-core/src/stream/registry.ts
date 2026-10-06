import { randomBytes } from 'node:crypto';
import { BridgeError } from '../shared/errors.js';
import type { TrackMetadata } from '../netease/types.js';
import type { StreamResolver } from './resolver-types.js';
export type { StreamResolveRequest, StreamResolver } from './resolver-types.js';
import { LocalFileSourcePool, type AssetLease, type LocalLeaseAuthority } from './local-file-source.js';
import type { PreparedLocalSource } from '../application/local-source-resolver.js';

export interface StreamRegistration {
  token: string;
  metadata: TrackMetadata;
  requestedQuality: string;
  createdAtMs: number;
  expiresAtMs: number;
  resolve: StreamResolver;
}

export class StreamRegistry {
  private readonly localRegistrations = new Map<string, { lease: AssetLease; format?: string }>();
  private readonly localSourcePool: LocalFileSourcePool;
  private localClosing = false;
  private readonly registrations = new Map<string, StreamRegistration>();
  private readonly now: () => number;
  private readonly defaultTtlMs: number;

  constructor(options: { now?: () => number; defaultTtlMs?: number; localSourcePool?: LocalFileSourcePool } = {}) {
    this.now = options.now ?? Date.now;
    this.defaultTtlMs = options.defaultTtlMs ?? 8 * 60 * 60 * 1000;
    this.localSourcePool = options.localSourcePool ?? new LocalFileSourcePool();
  }

  /** 仅Core私有调用，能力secret没有公开IPC字段或落盘序列化。 */
  async registerLocalSource(descriptor: PreparedLocalSource, authority: LocalLeaseAuthority, format?: string): Promise<{ token: string; lease: AssetLease }> {
    if (this.localClosing) throw new BridgeError('STREAM_NOT_FOUND', '本地租约已关闭', { httpStatus: 404 });
    for (const [token, value] of this.localRegistrations) if (value.lease.state === 'CLOSED') this.localRegistrations.delete(token);
    if (this.localRegistrations.size >= 16) throw new BridgeError('BAD_REQUEST', '本地租约容量已满', { httpStatus: 429 });
    const lease = await this.localSourcePool.prepare(descriptor, authority), token = randomBytes(32).toString('base64url');
    if (this.localClosing) { await lease.close(); throw new BridgeError('STREAM_NOT_FOUND', '本地租约已关闭', { httpStatus: 404 }); }
    this.localRegistrations.set(token, { lease, ...(format ? { format } : {}) }); return { token, lease };
  }
  getLocal(token: string): { lease: AssetLease; format?: string } | undefined { const value = this.localRegistrations.get(token); return value && value.lease.state !== 'CLOSING' && value.lease.state !== 'CLOSED' ? value : undefined; }
  async revokeLocal(token: string): Promise<void> { const registration = this.localRegistrations.get(token); if (registration) { this.localRegistrations.delete(token); await registration.lease.close(); } }
  async closeLocal(): Promise<void> { this.localClosing = true; this.localRegistrations.clear(); await this.localSourcePool.close(); }

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
