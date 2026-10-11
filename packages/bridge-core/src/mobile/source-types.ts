import type { MobileAudioInfo, MobileProcessing } from '@music-bridge/contracts';

/** Owner 源端口的共用数据类型；不依赖认证、播放 actor 或信封校验器。 */
export interface MobilePlaybackSourceRequest {
  resourceId: string; trackId: string; versionId: string; contentRevision: string;
  acceptedProcessingModes?: readonly ['dsd_to_pcm'];
  preparationWindow?: MobilePlaybackPreparationWindow;
  /** 由原 quality/formats 算出；Owner 仍须核实际源声道，不能只核一个 bool。 */
  dsdTarget?: Readonly<{ maxChannels: number; accepts24Bit48KhzFlac: boolean }>;
}
/** 从原 resource 创建窗口扣除；短 begin/status 不能重新发放 240 秒。 */
export interface MobilePlaybackPreparationWindow {
  resourceCreatedAtMs: number; resourceExpiresAtMs: number; sessionExpiresAtMs: number; remainingPreparationMs: number;
}
export interface MobilePlaybackPreparingSource {
  handle: string; preparing: true; sourceAudio: MobileAudioInfo;
  processing: MobileProcessing; durationMs: number; seekable: true;
}
/** 真实 Owner 的私有捕获结果；不是公开 JSON 能力，不传路径或数值 FD。 */
export interface MobilePlaybackPreparedSource {
  handle: string; sourceAudio: MobileAudioInfo; actualAudio: MobileAudioInfo;
  processing: MobileProcessing; contentType: string; size: number;
  durationMs: number; seekable: boolean;
  /** 004可信来源适配器的私有身份；旧存档缺省为local，不进入公开正文。 */
  catalogSource?: 'local' | 'netease';
  providerBinding?: Readonly<{ accountDomain: string; providerEpoch: string; ownerEpoch: string }>;
}
export interface MobilePlaybackSourcePort {
  prepare(request: MobilePlaybackSourceRequest, signal: AbortSignal): Promise<MobilePlaybackPreparedSource | MobilePlaybackPreparingSource>;
  /** 原认证principal五轴中的设备身份，由播放actor传给可信组合端口。 */
  prepareBound?(request: MobilePlaybackSourceRequest,
    device: Readonly<{ deviceId: string; deviceEpoch: number; accessGeneration: number }>,
    signal: AbortSignal): Promise<MobilePlaybackPreparedSource | MobilePlaybackPreparingSource>;
  /** 原 fake/direct port 可省略；真实 Owner 回报资格，Main 不以环境变量授予能力。 */
  capabilities?(): Promise<Readonly<{ resourceDsdToPcm: boolean }>>;
  status?(handle: string, signal: AbortSignal): Promise<MobilePlaybackPreparedSource | MobilePlaybackPreparingSource>;
  verify(handle: string): Promise<void>;
  /** 本域真实会话作者确认并续租；不能用手机 observation 冒充 Roon 确认。 */
  renew(handle: string): Promise<void>;
  /** 每个 HTTP 独立 readId；同一 readId 的调用串行，块最多 64KiB。 */
  read(handle: string, readId: string, start: number, maxBytes: number, signal: AbortSignal): Promise<Uint8Array>;
  closeRead(handle: string, readId: string): Promise<void>;
  /** 只在真实 HTTP/I/O/FD/claims 排空后返回。 */
  release(handle: string): Promise<void>;
}
