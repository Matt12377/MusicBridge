import { createHash } from 'node:crypto';
import type { MobileReadyResource, MobileResourceRequest } from '@music-bridge/contracts';
import { capturePlaybackState, playbackCanonical, playbackCopy, PLAYBACK_STATE_SCHEMA, type PlaybackState, type StoredPlaybackReceipt } from '../../src/mobile/playback-state.js';
import { MOBILE_PLAYBACK_DEFAULT_LIMITS, MOBILE_PLAYBACK_STATE_LOGICAL_NODE_LIMIT } from '../../src/mobile/playback-types.js';
import type { MobilePrincipal } from '../../src/mobile/types.js';

// 完全合成的业务关联；不读取磁盘、真实密钥或真实账本。
export const CAPACITY_SERVER = 'capacity.synthetic.server';
export const CAPACITY_DATASET = '40000000-0000-4000-8000-000000000001';
export const CAPACITY_ORIGIN = 'https://127.0.0.1:9443';
export const CAPACITY_NOW = Date.parse('2026-10-21T00:00:00.000Z');
export const capacityPrincipal = (deviceId = 'capacity.synthetic.history'): MobilePrincipal => ({
  serverId: CAPACITY_SERVER, datasetId: CAPACITY_DATASET, accountDomain: `local:${CAPACITY_DATASET}`,
  deviceId, deviceEpoch: 1, generation: 1, accessTokenHash: 'a'.repeat(64), accessExpiresAt: '2030-01-01T00:00:00.000Z',
});
export const capacityNodes = (value: unknown): number => value === null || typeof value !== 'object' ? 1
  : 1 + (Array.isArray(value) ? value : Object.values(value)).reduce<number>((total, child) => total + capacityNodes(child), 0);
export const capacityJson = (value: unknown): string => JSON.stringify(value);
export const capacityDigest = (domain: string, value: unknown): string => createHash('sha256')
  .update(playbackCanonical(['MBM002_PLAYBACK_V1', CAPACITY_SERVER, CAPACITY_DATASET, domain, value])).digest('hex');

export function capacityHistory(options: { sessions?: number; resources?: number; receipts?: number; formats?: number; errors?: boolean; creationReceipts?: boolean } = {}): PlaybackState {
  const sessionCount = options.sessions ?? 36, resourceCount = options.resources ?? 559, receiptCount = options.receipts ?? 1139;
  const deviceId = capacityPrincipal().deviceId, createdAt = CAPACITY_NOW - 60_000, expiresAt = CAPACITY_NOW + 1_740_000;
  const request: MobileResourceRequest = {
    trackId: 'capacity.synthetic.track', versionId: 'capacity.synthetic.version', contentRevision: 'capacity.synthetic.revision',
    quality: { profile: 'lossless', allowLossyFallback: false, preferredTransport: 'file' },
    formats: Array.from({ length: options.formats ?? 6 }, () => ({ codec: 'flac', container: 'flac', maxSampleRateHz: 48_000, maxChannels: 2, maxBitsPerSample: 24 })),
  };
  const audio = { codec: 'flac', container: 'flac', sampleRateHz: 48_000, bitsPerSample: 24, channels: 2 };
  const processing = { mode: 'direct' as const, reason: '合成原字节', fromPreparedCache: false };
  const sessions = Array.from({ length: sessionCount }, (_, i) => ({
    id: `capacity.session.${i}`, deviceId, deviceEpoch: 1, clientInstanceId: `capacity.client.${i}`,
    createdAt, expiresAt, terminal: 'SESSION_CLOSED' as const, lastSequence: 0, playerGeneration: null,
    currentQueueItemId: null, currentResourceId: null, observation: null,
  }));
  const resources = Array.from({ length: resourceCount }, (_, i) => ({
    id: `capacity.resource.${i}`, sessionId: sessions[i % sessions.length]!.id, deviceId, deviceEpoch: 1,
    request: { ...playbackCopy(request), formats: Array.from({ length: options.formats ?? (i < 121 || i >= resourceCount - 2 ? 7 : 6) }, () => playbackCopy(request.formats[0]!)) },
    createdAt, expiresAt: createdAt + 300_000, hardExpiresAt: createdAt + 300_000, lastActivityAt: createdAt,
    state: 'terminal' as const, failure: 'SERVICE_RESTARTED' as const,
    source: { sourceAudio: { ...audio }, actualAudio: { ...audio }, processing: { ...processing }, contentType: 'audio/flac',
      size: 46_020_414, durationMs: 180_000, seekable: true },
    media: null, runtimeEpoch: 'capacity.runtime', tickets: [],
  }));
  const receipts: StoredPlaybackReceipt[] = [];
  for (let i = 0; i < receiptCount; i++) {
    const sessionCreation = !options.errors && i < sessions.length;
    const resource = resources[Math.max(0, i - sessions.length) % resources.length]!;
    const session = sessionCreation ? sessions[i]! : sessions.find(s => s.id === resource.sessionId)!;
    const operation = sessionCreation ? 'createSession' : options.errors || options.creationReceipts || i < sessions.length + resources.length ? 'createResource' : 'renewResource';
    const path = sessionCreation ? '/mobile/v1/sessions' : `/mobile/v1/sessions/${session.id}/resources${operation === 'renewResource' ? `/${resource.id}/renew` : ''}`;
    const body = sessionCreation ? { clientInstanceId: session.clientInstanceId } : operation === 'createResource' ? playbackCopy(resource.request) : {};
    const pathParameters: Record<string, string> = sessionCreation ? {} : operation === 'createResource' ? { sessionId: session.id } : { sessionId: session.id, resourceId: resource.id };
    const idempotencyKey = `capacity.original-key.${i}`, scopeHash = capacityDigest('scope', [deviceId, 1, operation, 'POST', path]);
    const ready: MobileReadyResource = {
      id: resource.id, sessionId: session.id, trackId: resource.request.trackId, versionId: resource.request.versionId,
      contentRevision: resource.request.contentRevision, state: 'ready', sourceAudio: { ...audio }, processing: { ...processing },
      media: { url: `${CAPACITY_ORIGIN}/mobile/v1/media/${resource.id}/source?ticket=${i.toString(16).padStart(64, 'a')}`,
        transport: 'file', expiresAt: new Date(resource.expiresAt).toISOString(), durationMs: 180_000, seekable: true, actualAudio: { ...audio } },
    };
    receipts.push({
      id: `capacity.receipt.${i}`, operation, deviceId, deviceEpoch: 1, keyHash: capacityDigest('key', [deviceId, 1, idempotencyKey]),
      fingerprint: capacityDigest('request', [scopeHash, body]), scopeHash,
      request: { path, pathParameters, query: {}, body, idempotencyKey }, createdAt, sessionId: session.id,
      resourceId: sessionCreation ? null : resource.id, state: 'RECORDED',
      reply: options.errors ? { status: 503, body: { error: { code: 'SERVICE_RESTARTED', message: '播放服务已重新启动。', requestId: '40000000-0000-4000-8000-000000000002', retryable: true, retryAfterMs: 1000 } } }
        : sessionCreation ? { status: 201, body: { id: session.id, deviceId, createdAt: new Date(createdAt).toISOString(), expiresAt: new Date(expiresAt).toISOString() } }
          : { status: operation === 'createResource' ? 201 : 200, body: ready },
      resourceContext: sessionCreation || options.errors ? null : {
        scope: { serverId: CAPACITY_SERVER, deviceId, sessionId: session.id }, capabilitySnapshotIdentity: `mbm002:${CAPACITY_SERVER}`,
        responseOrigin: CAPACITY_ORIGIN, now: new Date(createdAt).toISOString(), resourceFormatBitDepth: true, capabilityVersion: '1.0.0',
        request: playbackCopy(resource.request), source: 'local', sourceAudio: { ...audio }, expectedResourceId: resource.id, hlsAllowed: false,
      },
    });
  }
  return capturePlaybackState({ schema: PLAYBACK_STATE_SCHEMA, serverId: CAPACITY_SERVER, datasetId: CAPACITY_DATASET,
    revision: receiptCount + 1, commitId: 'capacity.synthetic.commit', clockFloor: CAPACITY_NOW, sessions, resources, receipts },
  CAPACITY_SERVER, CAPACITY_DATASET, CAPACITY_ORIGIN, MOBILE_PLAYBACK_DEFAULT_LIMITS);
}

export function capacityLogicalBoundary(): { inside: PlaybackState; next: StoredPlaybackReceipt } {
  const seed = capacityHistory({ sessions: 1, resources: 1, receipts: 2, formats: 20, creationReceipts: true });
  const template = seed.receipts[1]!;
  const count = 2 + Math.floor((MOBILE_PLAYBACK_STATE_LOGICAL_NODE_LIMIT - capacityNodes(seed)) / capacityNodes(template));
  if (count + 1 > MOBILE_PLAYBACK_DEFAULT_LIMITS.maxReceipts) throw new Error('合成夹具超出回执条数预算');
  const inside = capacityHistory({ sessions: 1, resources: 1, receipts: count, formats: 20, creationReceipts: true });
  const next = playbackCopy(inside.receipts.at(-1)!);
  next.id = `capacity.receipt.${count}`; next.request.idempotencyKey = `capacity.original-key.${count}`;
  next.keyHash = capacityDigest('key', [next.deviceId, next.deviceEpoch, next.request.idempotencyKey]);
  return { inside, next };
}
