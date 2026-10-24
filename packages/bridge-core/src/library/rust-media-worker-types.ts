import type { MetadataReadBudget, MetadataReadEvidence, MetadataReadResult, MetadataEmbeddedLyricsCandidate } from './metadata-reader-types.js';

/** 只限 Node 私有调用者：回调必须借用已核源、已持有只读许可的打开句柄。 */
export interface RustMediaReadonlyInput {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}
export interface RustMetadataReadInput extends RustMediaReadonlyInput {
  budget: MetadataReadBudget;
  dsdMetadataEnabled?: boolean;
  cueInputMetadataEnabled?: boolean;
  /** 同目录已有封面证据时可信扫描器可关闭；空 coverEvidence 此时不代表缺图。 */
  includeEmbeddedArtwork?: boolean;
}
export interface RustMediaPerformance { readMs: number; parseMs: number; queueWaitMs: number }
/** 计时留在私有层；调用者入库前剥离，原 readEvidence 闭集不变。 */
export type RustMetadataReadResult = MetadataReadResult & { performance?: RustMediaPerformance };
export interface RustEmbeddedArtworkInput extends RustMediaReadonlyInput { budget?: Partial<MetadataReadBudget> }
export interface RustEmbeddedArtworkResult {
  items: { bytes: Uint8Array; pictureIndex: number; mime: 'image/jpeg' | 'image/png' }[];
  readEvidence: MetadataReadEvidence;
  performance: RustMediaPerformance;
}
export interface RustEmbeddedLyricsInput extends RustMediaReadonlyInput {
  budget?: Partial<MetadataReadBudget>;
  /** 原调用入口的绝对单调期限，排队/启动/解包都不能重置。 */
  deadlineAtMs: number;
}
export interface RustEmbeddedLyricsResult {
  items: MetadataEmbeddedLyricsCandidate[];
  readEvidence: MetadataReadEvidence;
  performance: RustMediaPerformance;
}
export interface RustProcessImageInput {
  bytes: Uint8Array;
  maxEdge: number;
  maxOutputBytes: number;
  /** 同一次解码生成网格缓存；默认 336px，false 可禁用。 */
  gridSize?: number | false;
}
export interface RustImageVariant { bytes: Uint8Array; mime: 'image/jpeg'; width: number; height: number }
export interface RustProcessImageResult extends RustImageVariant {
  original: { width: number; height: number; mime: 'image/jpeg' | 'image/png' | 'image/tiff' | 'image/webp' };
  /** TIFF/WebP 的全尺寸兼容 JPEG，最多 4MiB，不允许为此缩小尺寸。 */
  compatible?: RustImageVariant;
  grid?: RustImageVariant;
  performance: RustMediaPerformance;
}
export type RustMediaFailure = 'BUDGET_EXCEEDED' | 'PARSE_FAILED' | 'UNSUPPORTED' | 'TIMEOUT'
  | 'WORKER_START_TIMEOUT' | 'CANCELLED' | 'CLOSED' | 'QUEUE_FULL' | 'WORKER_FAILED' | 'IO_ERROR';
export interface RustMediaDiagnostic {
  jobId: string;
  stage: string;
  elapsedMs: number;
  queueWaitMs: number;
  slowThresholdMs: number;
  slow: boolean;
  message: string;
  code?: RustMediaFailure;
  readMs?: number;
  parseMs?: number;
}
export interface RustMediaWorkerPoolOptions {
  /** Node bootstrap 的可信部署配置，不能从 Renderer DTO 传入。 */
  binaryPath?: string;
  binarySha256?: string;
  resourcesPath?: string;
  concurrency?: 1 | 2 | 8;
  maxPending?: number;
  onDiagnostic?: (event: RustMediaDiagnostic) => void;
}
export interface RustMediaWorkerPool {
  readMetadata(input: RustMetadataReadInput, signal?: AbortSignal): Promise<RustMetadataReadResult>;
  readEmbeddedArtwork(input: RustEmbeddedArtworkInput, signal?: AbortSignal): Promise<RustEmbeddedArtworkResult>;
  readEmbeddedLyrics(input: RustEmbeddedLyricsInput, signal?: AbortSignal): Promise<RustEmbeddedLyricsResult>;
  processImage(input: RustProcessImageInput, signal?: AbortSignal): Promise<RustProcessImageResult>;
  /** 等待每个真实子进程 close 和全部在途 readonly 回调收口。 */
  close(): Promise<void>;
}
