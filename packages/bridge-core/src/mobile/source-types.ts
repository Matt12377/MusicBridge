import type { MobileAudioInfo, MobileProcessing } from '@music-bridge/contracts';

/** Owner 源端口的共用数据类型；不依赖认证、播放 actor 或信封校验器。 */
export interface MobilePlaybackSourceRequest {
  resourceId: string; trackId: string; versionId: string; contentRevision: string;
}
/** 真实 Owner 的私有捕获结果；不是公开 JSON 能力，不传路径或数值 FD。 */
export interface MobilePlaybackPreparedSource {
  handle: string; sourceAudio: MobileAudioInfo; actualAudio: MobileAudioInfo;
  processing: MobileProcessing; contentType: string; size: number;
  durationMs: number; seekable: boolean;
}
export interface MobilePlaybackSourcePort {
  prepare(request: MobilePlaybackSourceRequest, signal: AbortSignal): Promise<MobilePlaybackPreparedSource>;
  verify(handle: string): Promise<void>;
  /** 本域真实会话作者确认并续租；不能用手机 observation 冒充 Roon 确认。 */
  renew(handle: string): Promise<void>;
  /** 每个 HTTP 独立 readId；同一 readId 的调用串行，块最多 64KiB。 */
  read(handle: string, readId: string, start: number, maxBytes: number, signal: AbortSignal): Promise<Uint8Array>;
  closeRead(handle: string, readId: string): Promise<void>;
  /** 只在真实 HTTP/I/O/FD/claims 排空后返回。 */
  release(handle: string): Promise<void>;
}
