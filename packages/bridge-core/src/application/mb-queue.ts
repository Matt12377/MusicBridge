import type { MBQueueLogicalSource, PlaybackQualityPreference, MBQueueLogicalEntry } from '@music-bridge/contracts';
import { randomUUID } from 'node:crypto';
/** native引用是临时身份，保存前丢弃，恢复不会暗换来源。 */
export function logicalQueueEntry(item: { entryId?: string; logicalSource?: MBQueueLogicalSource; preferredSource?: 'netease'|'smart'|'roon'; trackId:string; qualityPreference:PlaybackQualityPreference }): MBQueueLogicalEntry {
  return {entryId:item.entryId ??= randomUUID(),entryRevision:'1',quality:item.qualityPreference,
    source:structuredClone(item.logicalSource ?? (item.preferredSource==='roon'?{kind:'roon',restore:'UNSUPPORTED_NATIVE_RESTORE'}:{kind:item.preferredSource ?? 'netease',trackId:item.trackId}))};
}

export function localQueueIdentity(source:Extract<MBQueueLogicalSource,{kind:'local_file'}>): import('@music-bridge/contracts').LocalQueueIdentity {
 const s=source.snapshot;return {local_track_id:s.trackId,asset_id:s.assetId,asset_revision:s.fileRevision,selection_revision:s.selectionRevision,location_revision:s.locationRevision,root_revision:s.rootRevision};
}
