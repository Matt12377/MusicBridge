import type { MobileAudioInfo, MobileTrack, MobileTrackSelection, MobileUIAlbumRecord } from '@music-bridge/contracts';
import { mobileDataSnapshot, mobileRecord } from '@music-bridge/contracts';
import { captureMobileContentScope, type MobileContentScope } from './content-types.js';
import type { MobilePlaybackSourcePort } from './source-types.js';
import { MobileServiceError } from './types.js';

/** 全部身份由当前可信 Provider 作者给出；不是 URL、标题或登录显示名的摘要。 */
export interface MobileNeteaseAccount { accountDomain: string; providerEpoch: string }
export interface MobileNeteaseAccountPort {
  current(signal: AbortSignal): Promise<Readonly<MobileNeteaseAccount> | null>;
}
export type MobileNeteaseScope = Readonly<MobileContentScope>;
export type MobileNeteaseFence = (scope: MobileNeteaseScope, stage: 'acquire' | 'lease') => Promise<void>;
export interface MobileNeteaseTrackFacts { account: MobileNeteaseAccount; track: MobileTrack }
export interface MobileNeteaseAlbumFacts { account: MobileNeteaseAccount; album: MobileUIAlbumRecord }
export interface MobileNeteaseCatalogPort {
  track(scope: MobileNeteaseScope, selection: MobileTrackSelection, signal: AbortSignal): Promise<MobileNeteaseTrackFacts>;
  album(scope: MobileNeteaseScope, albumId: string, signal: AbortSignal): Promise<MobileNeteaseAlbumFacts>;
}
export interface MobileNeteaseCatalogResolver {
  resolveTrack(scope: MobileNeteaseScope, selection: MobileTrackSelection, signal: AbortSignal): Promise<Readonly<MobileTrack>>;
  resolveAlbum(scope: MobileNeteaseScope, albumId: string, signal: AbortSignal): Promise<Readonly<MobileUIAlbumRecord>>;
}
export interface MobileNeteaseStreamRequest {
  scope: MobileNeteaseScope; resourceId: string; selection: Readonly<MobileTrackSelection>;
}
/** 该对象只在可信运行库中存在。具体 HTTP、重定向、账户和源身份由适配器核验。 */
export interface MobileNeteaseStreamLease {
  readonly account: Readonly<MobileNeteaseAccount>;
  readonly selection: Readonly<MobileTrackSelection>;
  readonly sourceIdentity: string;
  readonly size: number;
  readonly expiresAtMs: number;
  /** 适配器已验证实际独立 Range，不能由非零 size 推导可 seek。 */
  readonly rangeSupported: boolean;
  verify(signal: AbortSignal): Promise<void>;
  renew(signal: AbortSignal): Promise<Readonly<{ expiresAtMs: number }>>;
  read(readId: string, start: number, maxBytes: number, signal: AbortSignal): Promise<Uint8Array>;
  closeRead(readId: string): Promise<void>;
  /** 返回即证明该 lease 全部 I/O/HTTP 已 quiet；拒绝时保护及容量仍保留。 */
  release(): Promise<void>;
}
export interface MobileNeteaseStreamPort {
  open(request: MobileNeteaseStreamRequest, signal: AbortSignal): Promise<MobileNeteaseStreamLease>;
}
export interface MobileNeteaseSourceLimits {
  liveResources: number; storedResources: number; readers: number; resourceReaders: number; readIds: number;
  prepareMs: number; readMs: number; releaseMs: number; leaseMs: number; maxLifetimeMs: number;
}
export interface MobileNeteaseSourceService {
  readonly qualified: boolean;
  /** 原 SourcePort 没有设备字段；由可信组合根为每个当前设备绑定私有闭包。 */
  bind(scope: MobileNeteaseScope): MobilePlaybackSourcePort;
  revokeDevice(deviceId: string, deviceEpoch: number): Promise<void>;
  close(): Promise<void>;
  resourceSnapshot(): Readonly<{ resources: number; live: number; readers: number; pending: number; fatal: boolean }>;
}
export interface MobileNeteaseObservedAudio {
  audio: Readonly<MobileAudioInfo>; contentType: 'audio/flac' | 'audio/mpeg';
  size: number; durationMs: number | null; headerSha256: string;
}

/** Provider 的毫秒时长可量化；公开 FLAC 时长始终取真实 STREAMINFO 样本数。 */
export const MOBILE_NETEASE_DURATION_TOLERANCE_MS = 1_000;

export const mobileNeteaseId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,160}(?![\s\S])/u.test(v);
export function captureMobileNeteaseScope(raw: unknown): MobileNeteaseScope {
  const value = captureMobileContentScope(raw);
  if (!['serverId', 'datasetId', 'deviceId', 'ownerEpoch', 'accountDomain'].every(k => mobileNeteaseId(value[k as keyof MobileContentScope]))
    || !mobileNeteaseId(value.providerEpoch)) throw new MobileServiceError(401, 'UNAUTHORIZED');
  return value;
}
export function captureMobileNeteaseAccount(raw: unknown): Readonly<MobileNeteaseAccount> {
  const captured = mobileDataSnapshot(raw);
  if (!captured.ok || !mobileRecord(captured.value) || Reflect.ownKeys(captured.value).length !== 2
    || !mobileNeteaseId(captured.value.accountDomain) || !mobileNeteaseId(captured.value.providerEpoch)) {
    throw new MobileServiceError(503, 'BUSY');
  }
  return Object.freeze(captured.value as unknown as MobileNeteaseAccount);
}
export function assertMobileNeteaseAccount(scope: MobileNeteaseScope, raw: unknown): void {
  if (raw === null) throw new MobileServiceError(401, 'UNAUTHORIZED');
  const account = captureMobileNeteaseAccount(raw);
  if (scope.accountDomain !== account.accountDomain || scope.providerEpoch !== account.providerEpoch) {
    throw new MobileServiceError(409, 'SOURCE_CHANGED');
  }
}
