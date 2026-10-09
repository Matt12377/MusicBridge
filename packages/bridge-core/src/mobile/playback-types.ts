import type {
  MobileDecodedRequest, MobileErrorEnvelope, MobileHeaderPairs,
  MobileObservationReceipt, MobileResource, MobileResourceSemanticContext, MobileSession,
} from '@music-bridge/contracts';
import type { MobileAuthCrypto, MobileAuthPersistence, MobilePrincipal } from './types.js';
import type { MobilePlaybackSourcePort } from './source-types.js';
export type { MobilePlaybackSourceRequest, MobilePlaybackPreparedSource, MobilePlaybackSourcePort } from './source-types.js';

export const MOBILE002_CONTROL_OPERATIONS = [
  'createSession', 'getSession', 'closeSession', 'reportObservation',
  'createResource', 'getResource', 'releaseResource', 'renewResource',
] as const;
export type MobilePlaybackControlOperation = typeof MOBILE002_CONTROL_OPERATIONS[number];
export type MobilePlaybackMediaOperation = 'getMediaAsset' | 'headMediaAsset';
export type MobilePlaybackErrorCode =
  | 'INVALID_REQUEST' | 'UNAUTHORIZED' | 'IDEMPOTENCY_CONFLICT' | 'REVISION_CONFLICT' | 'BUSY'
  | 'SESSION_EXPIRED' | 'SESSION_CLOSED' | 'RESOURCE_EXPIRED' | 'RESOURCE_RELEASED'
  | 'RESOURCE_REVOKED' | 'DEVICE_REVOKED' | 'TICKET_EXPIRED' | 'TICKET_INVALID'
  | 'TICKET_REVOKED' | 'SERVICE_RESTARTED' | 'RESOURCE_BUSY' | 'SOURCE_CHANGED' | 'UNSUPPORTED_FORMAT';

/** 只有闭集安全码；不携带路径、票据、底层异常或内部堆栈。 */
export class MobilePlaybackError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 429 | 503,
    readonly code: MobilePlaybackErrorCode, readonly retryable = false, readonly retryAfterMs?: number) {
    super('移动播放当前无法完成请求。');
  }
}

export interface MobilePlaybackAuthPort {
  /** access refresh 不改变该授权；撤销或重新配对改变 deviceEpoch。 */
  assertDeviceCurrent(deviceId: string, deviceEpoch: number): Promise<void>;
}
export interface MobilePlaybackLimits {
  sessionTtlMs: number; resourceTtlMs: number; ticketTtlMs: number; maximumResourceLifetimeMs: number;
  orphanResourceMs: number; prepareTimeoutMs: number; readyWaitMs: number;
  mediaEstablishmentMs: number; mediaIdleMs: number; releaseConfirmationMs: number;
  maxSessionsPerDevice: number; maxLiveSessions: number; maxLiveResources: number;
  maxReads: number; maxReadsPerResource: number;
  maxStoredSessions: number; maxStoredResources: number; maxReceipts: number;
  stateBytes: number; sealedBytes: number;
}
export const MOBILE_PLAYBACK_DEFAULT_LIMITS: Readonly<MobilePlaybackLimits> = Object.freeze({
  sessionTtlMs: 1_800_000, resourceTtlMs: 300_000, ticketTtlMs: 60_000, maximumResourceLifetimeMs: 43_200_000,
  orphanResourceMs: 300_000, prepareTimeoutMs: 10_000, readyWaitMs: 25,
  mediaEstablishmentMs: 10_000, mediaIdleMs: 5_000, releaseConfirmationMs: 10_000,
  maxSessionsPerDevice: 2, maxLiveSessions: 64, maxLiveResources: 8, maxReads: 32, maxReadsPerResource: 4,
  maxStoredSessions: 512, maxStoredResources: 2_048, maxReceipts: 4_096,
  stateBytes: 2 * 1024 * 1024, sealedBytes: 4 * 1024 * 1024,
});
export interface MobilePlaybackServiceOptions {
  serverId: string; datasetId: string; responseOrigin: string;
  auth: MobilePlaybackAuthPort; persistence: MobileAuthPersistence; crypto: MobileAuthCrypto;
  sourcePort: MobilePlaybackSourcePort;
  nowMs?: () => number; randomToken?: () => string;
  /** 只可向下收紧；不扩旧 005 Pool/Reader 或认证域预算。 */
  limits?: Partial<MobilePlaybackLimits>;
}
export interface MobilePlaybackControlReply {
  status: 200 | 201 | 202 | 204 | MobilePlaybackError['status']; headers: MobileHeaderPairs;
  body: MobileSession | MobileResource | MobileObservationReceipt | MobileErrorEnvelope | null;
  /** 仅可信组合层使用，供原 wire codec 核验来源、格式及设备资源 scope。 */
  resourceContext?: MobileResourceSemanticContext;
  /** 实际 HTTP 发正文前再次核验本域 fence，不进行第二次执行。 */
  beforeSend(): Promise<void>;
}
export interface MobilePlaybackReader extends AsyncIterable<Uint8Array> {
  readonly readId: string;
  read(maxBytes?: number): Promise<Uint8Array>;
  close(): Promise<void>;
}
export interface MobilePlaybackMediaReply {
  status: 200 | 206 | 400 | 416; headers: MobileHeaderPairs;
  totalBytes: number; start: number | null; end: number | null;
  ticketExpiresAtMs: number; resourceAbortSignal: AbortSignal;
  reader: MobilePlaybackReader | null;
  beforeSend(): Promise<void>;
  close(): Promise<void>;
}
export interface MobilePlaybackSnapshot {
  liveSessions: number; liveResources: number; preparing: number; readers: number;
  releasing: number; receipts: number; pendingPersistence: boolean; closing: boolean;
}
export interface MobilePlaybackService {
  control(operation: MobilePlaybackControlOperation, request: MobileDecodedRequest<unknown>, principal: MobilePrincipal,
    signal: AbortSignal): Promise<MobilePlaybackControlReply>;
  openMedia(operation: MobilePlaybackMediaOperation, request: MobileDecodedRequest<unknown>, signal: AbortSignal,
    headers?: Readonly<{ range?: string; ifRange?: string }>): Promise<MobilePlaybackMediaReply>;
  revokeDevice(deviceId: string): Promise<void>;
  close(): Promise<void>;
  resourceSnapshot(): MobilePlaybackSnapshot;
}
export type MobilePlaybackFailureBody = MobileErrorEnvelope;
