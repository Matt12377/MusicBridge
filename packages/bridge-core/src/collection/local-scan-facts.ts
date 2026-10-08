import type { MetadataTechnical, MetadataCoverEvidence, MetadataReadEvidence } from '../library/metadata-reader-types.js';

/** 扫描与新源作者共用的私有只读事实叶类型；不依赖持久 store。 */
export interface ScanReadFacts {technical:MetadataTechnical;coverEvidence:MetadataCoverEvidence[];readEvidence:MetadataReadEvidence}
