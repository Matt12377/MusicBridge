import type { MetadataTechnical, MetadataCoverEvidence, MetadataReadEvidence } from '../library/metadata-reader-types.js';

/** 扫描与新源作者共用的私有只读事实叶类型；不依赖持久 store。 */
export interface ScanReadFacts {technical:MetadataTechnical;coverEvidence:MetadataCoverEvidence[];readEvidence:MetadataReadEvidence}

/** 私有扫描状态与事实共用叶类型；原store继续重导出，不反向依赖持久作者。 */
export interface ScanFileState {
  libraryRootId: string; relative: string; signature: string; parserVersion: string;
  outcome: 'accepted' | 'rejected'; assetId: string | null; trackId: string | null; failureCode: string | null; readFacts: ScanReadFacts | null;
}
