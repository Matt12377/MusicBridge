import type { LocalTrack, AudioAsset, LibraryRoot } from '@music-bridge/contracts';
import type { RootCapability } from '../recording/source-files.js';

/** 唯一Owner扫描stat证据与本次逻辑选择的绑定；只在Node私有通路流动。 */
export interface LocalSourceObservation {
  signature: string; assetId: string; trackId: string; libraryRootId: string; sourceRootId: string;
  fileRevision: string; rootRevision: string; locationRevision: string; selectionRevision: string;
}
export interface LocalSourceFacts { track: LocalTrack; asset: AudioAsset; root: LibraryRoot; sourceRoot: RootCapability; relative: string; observation?: LocalSourceObservation }
