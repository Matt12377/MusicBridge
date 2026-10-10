import type { MobileAudioInfo } from '@music-bridge/contracts';
import type { RootCapability } from '../recording/source-files.js';
import type { MobilePlaybackPreparedSource, MobilePlaybackPreparingSource, MobilePlaybackPreparationWindow } from './source-types.js';

/** 新域独立限额；允许测试向下收紧，不能扩旧 Reader、RPC 或资源期限。 */
export const MOBILE_DSD_CACHE_LIMITS = Object.freeze({
  jobs: 1, waitingResources: 4, entries: 32, entryBytes: 2 * 1024 ** 3,
  totalBytes: 4 * 1024 ** 3, preparationMs: 240_000, quietReserveMs: 10_000,
});
export type MobileDsdCacheLimits = { -readonly [K in keyof typeof MOBILE_DSD_CACHE_LIMITS]: number };
export type MobileDsdFailureCode = 'UNSUPPORTED_FORMAT' | 'SOURCE_CHANGED' | 'RESOURCE_BUSY' | 'RESOURCE_RELEASED';
export class MobileDsdError extends Error {
  constructor(readonly code: MobileDsdFailureCode, readonly quiet = true) { super('DSD 准备当前无法完成。'); }
}
/** 只在 Owner 内生成；实际 FD 与读保护放在模块私有 WeakMap，不进入协议。 */
export interface MobileDsdSourceAccess { readonly identity: string; readonly sourceAudio: Readonly<MobileAudioInfo>; readonly durationMs: number }
export interface MobileDsdSourceInput {
  root: RootCapability; relative: string; signature: string; datasetId: string;
  /** 原 Asset/Track/root/location/file/selection 修订全集合的稳定 canonical 身份。 */
  identity: string; sourceAudio: MobileAudioInfo; assertCurrent(): void;
}
export interface MobileDsdDomainOptions {
  converterDirectory: string; converterManifestSha256: string; cacheDirectory: string;
}
export interface MobileDsdConverter {
  readonly identity: string;
  /** 输出仅本次新建 owned FD；cache 关闭写FD后另开只读FD调用完整 verifyOutput。 */
  convert(source: MobileDsdSourceAccess, output: import('node:fs/promises').FileHandle,
    check: () => void, maximumBytes: number): Promise<void>;
  verifyOutput(output: import('node:fs/promises').FileHandle, source: MobileDsdSourceAccess,
    check: () => void, maximumBytes: number): Promise<MobileDsdOutput>;
}
export interface MobileDsdOutput { size: number; sha256: string; actualAudio: Readonly<MobileAudioInfo>; samples: number }
export type MobileDsdCacheStatus = MobilePlaybackPreparedSource | MobilePlaybackPreparingSource;
export interface MobilePreparedCache {
  /** 只有固定后端、受控缓存根和真实源读取能力均合格才报告 true。 */
  readonly qualified: boolean;
  begin(request: { resourceId: string; source: MobileDsdSourceAccess; window: MobilePlaybackPreparationWindow }, signal: AbortSignal): Promise<MobileDsdCacheStatus>;
  status(resourceId: string): Promise<MobileDsdCacheStatus>;
  verify(resourceId: string): Promise<void>;
  renew(resourceId: string): Promise<void>;
  read(resourceId: string, start: number, maximumBytes: number, signal: AbortSignal): Promise<Uint8Array>;
  release(resourceId: string): Promise<void>;
  close(): Promise<void>;
  snapshot(): Readonly<{ jobs: number; waitingResources: number; entries: number; bytes: number; active: number; closing: boolean }>;
}
