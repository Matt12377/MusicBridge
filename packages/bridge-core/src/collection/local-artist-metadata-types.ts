import type { AudioAsset, LocalTrack } from '@music-bridge/contracts';

/** 仅可信Owner之间流转；相对位置与扫描签名不进入IPC、HTTP或用户日志。 */
export interface ArtistMetadataBackfillCandidate {
  ordinal: number;
  track: LocalTrack;
  asset: AudioAsset;
  relative: string;
  signature: string | null;
  scanJobId: string | null;
  complete: boolean;
}
export class ArtistMetadataBackfillDeferred extends Error {
  constructor() { super('艺人补读正在等待原媒体读取准入。'); this.name = 'ArtistMetadataBackfillDeferred'; }
}
