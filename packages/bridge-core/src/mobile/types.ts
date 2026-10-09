import type {
  LocalLibraryTrackDetail, MobileAlbum, MobileCatalogIdentityBinding, MobileCatalogProjection,
  MobileDecodedRequest, MobileHeaderPairs, MobileOperationId, MobilePairingClaim,
  MobileRefreshRequest, MobileSafeErrorFacts, MobileServerInfo, MobileTokenPair, MobileTrack,
} from '@music-bridge/contracts';
import type { MobileOwnerSourceRequest, MobileOwnerSourceResult } from './source-protocol.js';

/** 本域私有端口；不是新增公开 HTTP 或普通 Renderer IPC。 */
export const MOBILE001_OPERATIONS = [
  'getServer', 'claimPairing', 'refreshToken', 'logout', 'getCapabilities',
  'listAlbums', 'getAlbum', 'listTracks', 'getTrack', 'getArtwork',
] as const satisfies readonly MobileOperationId[];
export type Mobile001Operation = typeof MOBILE001_OPERATIONS[number];
export const MOBILE_AUTH_STATE_MAX_BYTES = 2 * 1024 * 1024;
export const MOBILE_AUTH_SEALED_MAX_BYTES = 4 * 1024 * 1024;
export const MOBILE_AUTH_MAX_DEVICES = 32;
export const MOBILE_AUTH_MAX_PAIRINGS = 32;
export const MOBILE_AUTH_MAX_RECEIPTS = 4096;

export class MobileServiceError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 429 | 503,
    readonly code: MobileSafeErrorFacts['code'], readonly retryable = false, readonly retryAfterMs?: number) {
    super('移动服务当前无法完成请求。');
  }
}

/** 不确定提交只允许读取原记录；此错误不携带路径、正文或底层异常。 */
export class MobileAuthPersistenceError extends Error {
  constructor(readonly outcome: 'not-sent' | 'unknown') {
    super('移动认证存储结果尚未确认。');
  }
}

export type MobileSealedState =
  | { kind: 'missing'; datasetId: string; revision: 0 }
  | { kind: 'sealed'; datasetId: string; revision: number; commitId: string; sealed: Uint8Array };
export interface MobileSealedSave {
  datasetId: string; expectedRevision: number; commitId: string; sealed: Uint8Array;
}
export type MobileSealedSaveResult =
  | { kind: 'saved'; datasetId: string; revision: number; commitId: string }
  | { kind: 'conflict'; datasetId: string; currentRevision: number };
export interface MobileAuthPersistence {
  load(datasetId: string): Promise<MobileSealedState>;
  save(request: MobileSealedSave): Promise<MobileSealedSaveResult>;
}
export interface MobileAuthCrypto {
  seal(plain: Uint8Array, aad: Uint8Array): Uint8Array;
  open(sealed: Uint8Array, aad: Uint8Array): Uint8Array;
}
export interface MobilePrincipal {
  serverId: string; deviceId: string; datasetId: string; accountDomain: string;
  deviceEpoch: number; generation: number; accessTokenHash: string; accessExpiresAt: string;
}
export interface MobilePairingPermit { pairingSecret: string; expiresAt: string }
export interface MobileDeviceView { deviceId: string; deviceName: string; createdAt: string; revoked: boolean }
export interface MobileAuthService {
  serverInfo(): Promise<MobileServerInfo>;
  issuePairing(): Promise<MobilePairingPermit>;
  devices(): Promise<readonly MobileDeviceView[]>;
  revokeDevice(deviceId: string): Promise<void>;
  claim(body: MobilePairingClaim, idempotencyKey: string): Promise<MobileTokenPair>;
  refresh(body: MobileRefreshRequest, idempotencyKey: string): Promise<MobileTokenPair>;
  authenticate(accessToken: string): Promise<MobilePrincipal>;
  assertCurrent(principal: MobilePrincipal): Promise<void>;
  /** 仅可信媒体票据端口；正常access轮换不撤销设备epoch。 */
  assertDeviceCurrent(deviceId: string, deviceEpoch: number): Promise<void>;
  logout(principal: MobilePrincipal): Promise<void>;
  close(): Promise<void>;
}

export type MobileOwnerCatalogOperation = 'listAlbums' | 'getAlbum' | 'listTracks' | 'getTrack';
export interface MobileOwnerCatalogRequest {
  operation: MobileOwnerCatalogOperation; serverId: string;
  offset: number; limit: number; q: string; albumId: string | null; itemId: string | null;
  expectedRevision: string | null;
}
export interface MobileOwnerCatalogSnapshot {
  datasetId: string; ownerEpoch: string; libraryRevision: string;
  operation: MobileOwnerCatalogOperation; offset: number; limit: number; total: number;
  items: readonly (MobileAlbum | MobileTrack)[];
}
export interface MobileOwnerLocalTrackFacts {
  detail: LocalLibraryTrackDetail; binding: MobileCatalogIdentityBinding;
  projection: MobileCatalogProjection;
}
export interface MobileOwnerArtworkSnapshot {
  datasetId: string; ownerEpoch: string; libraryRevision: string;
  artworkId: string; selectionRevision: string;
  contentType: 'image/jpeg'; bytes: Uint8Array;
}
export interface MobileCatalogReadPort {
  read(request: MobileOwnerCatalogRequest): Promise<MobileOwnerCatalogSnapshot>;
  artwork(request: { serverId: string; artworkId: string }): Promise<MobileOwnerArtworkSnapshot>;
}
export type MobileOwnerPrivateRequest =
  | { kind: 'load'; datasetId: string }
  | { kind: 'playback-load'; datasetId: string }
  | { kind: 'save'; datasetId: string; request: MobileSealedSave }
  | { kind: 'playback-save'; datasetId: string; request: MobileSealedSave }
  | { kind: 'media-source'; datasetId: string; request: MobileOwnerSourceRequest }
  | { kind: 'catalog'; datasetId: string; request: MobileOwnerCatalogRequest }
  | { kind: 'artwork'; datasetId: string; request: { serverId: string; artworkId: string } };
export type MobileOwnerPrivateResult = MobileSealedState | MobileSealedSaveResult
  | MobileOwnerCatalogSnapshot | MobileOwnerArtworkSnapshot | MobileOwnerSourceResult | MobileOwnerPrivateFailure;
export interface MobileOwnerPrivateFailure {
  kind: 'mobile-error'; status: MobileServiceError['status']; code: MobileSafeErrorFacts['code'];
  retryable: boolean; outcome: 'not-sent' | 'unknown' | null;
}

export interface Mobile001BackendRequest {
  operation: Mobile001Operation; request: MobileDecodedRequest<unknown>;
  accessToken: string | null; signal: AbortSignal;
}
export interface Mobile001BackendReply {
  status: number; headers: MobileHeaderPairs; body: Uint8Array;
  /** 在实际发送前再次检查设备/工作库；回调只存在于可信 Main 内存。 */
  beforeSend?: () => Promise<void>;
}
export interface Mobile001Backend {
  dispatch(request: Mobile001BackendRequest): Promise<Mobile001BackendReply>;
}
