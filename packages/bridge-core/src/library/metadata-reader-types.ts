import type { RootCapability } from '../recording/source-files.js';

/** 真实解析器版本与扫描 job 版本分开；不进入公开 DTO 或 Native 资格。 */
export const METADATA_PARSER_VERSION = 'music-metadata-11.15.0/mbrs003-v4';
export const RUST_MEDIA_METADATA_PARSER_VERSION = 'musicbridge-rust-media/v1';
export const CUE_HEADER_METADATA_PARSER_VERSION = 'musicbridge-cue-header/mbrs003-v1';
export const CUE_INPUT_SCAN_VERSION = 'cue-input-scan/v39-v1';
export type MetadataParserVersion = typeof METADATA_PARSER_VERSION | typeof RUST_MEDIA_METADATA_PARSER_VERSION | typeof CUE_HEADER_METADATA_PARSER_VERSION;

/** Node 私有原始标签事实；不是公开 LocalMetadata 的真实性或512字符准入证明。 */
export interface MetadataRawFields { title?: string; artist?: string; album?: string; year?: string; disc?: string; track?: string; albumArtist?: string; artists?: string[]; albumArtists?: string[] }
export interface MetadataTechnical {
  container: 'FLAC' | 'MPEG' | 'MP4' | 'WAVE' | 'AIFF' | 'DSF' | 'DFF' | 'OGG' | 'WAVPACK' | 'APE' | 'TTA' | 'MPC' | 'TAK'; codec: string;
  lossless: boolean | null; sampleRateHz: number; channels: number;
  bitsPerSample: number | null; durationSeconds: number | null;
  evidence: 'bounded-parser-reported';
}
/** 只证明读到的编码封面字节与magic；不返回图像数据，不声明已解码或绘制。 */
export interface MetadataCoverEvidence { mime: 'image/png' | 'image/jpeg'; bytes: number; sha256: string; evidence: 'encoded-bytes-magic-and-digest' }
export interface MetadataReadEvidence { bytesRead: number; readCalls: number; maxReadBytes: number; allocationBytes: number; elapsedMs: number; wholeAudioHash: false; wholeAudioDecode: false }
export type MetadataReadFailure = 'REVOKED' | 'SOURCE_ROOT_OFFLINE' | 'OUTSIDE_ROOT' | 'MISSING' | 'CONTENT_CHANGED' | 'IO_ERROR'
  | 'BUDGET_EXCEEDED' | 'PARSE_FAILED' | 'UNSUPPORTED' | 'TIMEOUT' | 'WORKER_START_TIMEOUT' | 'CANCELLED'
  | 'CLOSED' | 'QUEUE_FULL' | 'WORKER_FAILED' | 'LEASE_RELEASE_FAILED' | 'ADMISSION_FAILED';
export type MetadataReadResult = { status: 'ok'; parserVersion: MetadataParserVersion; fields: MetadataRawFields; technical: MetadataTechnical; coverEvidence: MetadataCoverEvidence[]; readEvidence: MetadataReadEvidence }
  | { status: 'failure'; code: MetadataReadFailure; readEvidence: MetadataReadEvidence | null };
export interface MetadataReadInput {
  root: RootCapability; relative: string; expectedSignature: string;
  /** 同目录已有本轮可验证封面证据时可跳过重复内嵌图；空证据不能解释为已确认无图。 */
  includeEmbeddedArtwork?: boolean;
  /** SourceStore/root revision/dataset/epoch 的可信同步门禁；不进入worker。 */
  assertCurrent?: () => void;
}
export interface MetadataReadBudget {
  textFieldBytes: number; totalTextBytes: number; coverBytes: number;
  totalReadBytes: number; singleReadBytes: number; singleAllocationBytes: number; totalAllocationBytes: number;
  timeoutMs: number;
}
export const DEFAULT_METADATA_READ_BUDGET: Readonly<MetadataReadBudget> = Object.freeze({
  textFieldBytes: 4096, totalTextBytes: 64 * 1024, coverBytes: 4 * 1024 * 1024,
  totalReadBytes: 32 * 1024 * 1024, singleReadBytes: 8 * 1024 * 1024,
  singleAllocationBytes: 8 * 1024 * 1024, totalAllocationBytes: 64 * 1024 * 1024, timeoutMs: 3000,
});
/** 只记录实际检查点；阶段不是文件错误或底层延迟原因。 */
export type MetadataWorkerPhase = 'dependency-load' | 'container-check' | 'parser-load' | 'parse' | 'output-check' | 'complete';
/** 单次Worker的私有最终消息；父线程解包后仍返回原MetadataReadResult。 */
export interface MetadataWorkerResultMessage { kind: 'metadata-result'; result: MetadataReadResult; phase: MetadataWorkerPhase }
export interface MetadataReaderTimeoutLifecycle {
  type: 'worker-timeout'; fd: number; threadId: number;
  origin: 'parent-start' | 'parent-read' | 'worker-check';
  phase: 'startup' | 'awaiting-result' | 'exit-wait' | MetadataWorkerPhase;
  elapsedMs: number | null; lateByMs: number | null;
  onlineObserved: boolean; resultMessageObserved: boolean; workerReportedTimeout: boolean;
}
export type MetadataReaderLifecycle = { type: 'lease-acquired' | 'lease-released'; fd: number }
  | { type: 'worker-start' | 'worker-online'; fd: number; threadId: number }
  | { type: 'worker-exit'; fd: number; threadId: number; exitCode: number }
  | { type: 'read-complete'; status: MetadataReadResult['status'] }
  | { type: 'metadata-phase'; readId: string; stage: 'queue' | 'read' | 'parse'; state: 'start' | 'complete' | 'cancel' | 'error';
      backend: 'rust-media-worker'; queueWaitMs: number; readMs: number; parseMs: number; elapsedMs: number; slow: boolean; code?: MetadataReadFailure }
  | MetadataReaderTimeoutLifecycle;
export interface MetadataReaderOptions {
  /** 仅由同Owner的合格DSD后端与缓存开启；原Reader缺省继续不准入DSD。 */
  dsdMetadataEnabled?: boolean;
  /** 仅可信同 Owner 的 CUE 输入链显式开启；旧 Reader 缺省范围保持。 */
  cueInputMetadataEnabled?: boolean;
  concurrency?: 1 | 2 | 8; maxPending?: number;
  /** 只供可信Node测试降低预算，不接受Renderer传入，不允许提高产品上限。 */
  trustedBudget?: Partial<MetadataReadBudget>;
  onLifecycle?: (event: MetadataReaderLifecycle) => void;
  /** 可接owner共享媒体读取准入；本reader不创造第二套播放/SourceLock协调器。 */
  readAdmission?: { acquire(signal: AbortSignal): Promise<() => void | Promise<void>> };
}
export interface MetadataReaderPort { read(input: MetadataReadInput, signal?: AbortSignal): Promise<MetadataReadResult>; close(): Promise<void> }
/** worker只持有共享FD数值；所有关闭权保留父线程FileHandle。 */
export interface MetadataWorkerInput { fd: number; size: number; budget: MetadataReadBudget; dsdMetadataEnabled?: boolean; cueInputMetadataEnabled?: boolean; includeEmbeddedArtwork?: boolean }

/** 仅可信Worker歌词操作的原始候选；不进入LocalMetadata/扫描历史或公开歌词来源。 */
export type MetadataEmbeddedLyricsCandidate = { kind: 'uslt'; text: string }
  | { kind: 'sylt'; lines: { startMs: number; text: string }[] };
/** 专用只读歌词预算；原metadata字段4096B上限及其他操作均不扩大。 */
export const EMBEDDED_LYRICS_READ_BUDGET: Readonly<MetadataReadBudget> = Object.freeze({
  textFieldBytes: 4096, totalTextBytes: 64 * 1024, coverBytes: 1,
  totalReadBytes: 512 * 1024, singleReadBytes: 64 * 1024, singleAllocationBytes: 128 * 1024,
  totalAllocationBytes: 8 * 1024 * 1024, timeoutMs: 2000,
});
