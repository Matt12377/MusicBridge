import { isCollectionId } from './collection.js';
import { isAlbumEdition, isLocalCatalogRevision, type AlbumEdition } from './local-catalog.js';
import { isLocalQueueSourceSnapshot, type LocalQueueSourceSnapshot } from './local-domain-references.js';

export const MAX_MB_QUEUE_ENTRIES = 5000;
export const MAX_MB_QUEUE_JSON_BYTES = 16 * 1024 * 1024;
/** 仅逻辑来源。恢复必须重新解析，不保存媒体地址或运行期授权。 */
export type MBQueueLogicalSource =
  | { kind: 'local_file'; snapshot: LocalQueueSourceSnapshot; edition: { id: string; revision: string } | null }
  | { kind: 'netease' | 'smart'; trackId: string }
  | { kind: 'roon'; restore: 'UNSUPPORTED_NATIVE_RESTORE' };
export interface MBQueueLogicalEntry {
  entryId: string;
  entryRevision: string;
  source: MBQueueLogicalSource;
  quality: 'auto' | 'standard' | 'exhigh' | 'lossless' | 'hires';
}
export interface MBQueueRecord {
  schemaVersion: '1.2';
  datasetId: string;
  queueId: string;
  revision: string;
  currentEntryId: string | null;
  entries: readonly MBQueueLogicalEntry[];
  restartPolicy: { reResolve: true; autoplay: false };
}
export interface MBQueueSaveRequest { expectedRevision: string; queue: MBQueueRecord }
export interface MBQueueEditRequest { queueId: string; expectedRevision: string; entryIds: readonly string[]; action: 'REMOVE' | 'REORDER' }
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const closed = (v: Record<string, unknown>, names: readonly string[]) => Reflect.ownKeys(v).length === names.length
  && names.every(k => Object.prototype.propertyIsEnumerable.call(v, k));
const text = (v: unknown): v is string => typeof v === 'string' && v.length <= 128 && /^\d+$/u.test(v) && v !== '0';
export function isMBQueueLogicalSource(v: unknown): v is MBQueueLogicalSource {
  if (!record(v)) return false;
  if (v.kind === 'local_file') return closed(v, ['kind', 'snapshot', 'edition']) && isLocalQueueSourceSnapshot(v.snapshot)
    && (v.edition === null || record(v.edition) && closed(v.edition, ['id', 'revision']) && isCollectionId(v.edition.id) && isLocalCatalogRevision(v.edition.revision));
  if(v.kind === 'roon') return closed(v,['kind','restore']) && v.restore === 'UNSUPPORTED_NATIVE_RESTORE';
  return closed(v, ['kind', 'trackId']) && ['netease', 'smart'].includes(String(v.kind)) && text(v.trackId);
}
export function isMBQueueLogicalEntry(v: unknown): v is MBQueueLogicalEntry {
  return record(v) && closed(v, ['entryId', 'entryRevision', 'source', 'quality']) && isCollectionId(v.entryId)
    && isLocalCatalogRevision(v.entryRevision) && isMBQueueLogicalSource(v.source)
    && ['auto', 'standard', 'exhigh', 'lossless', 'hires'].includes(String(v.quality));
}
export function mbQueueSerializedBytes(v: unknown): number { try { return new TextEncoder().encode(JSON.stringify(v)).byteLength; } catch { return Infinity; } }
export function isMBQueueRecord(v: unknown): v is MBQueueRecord {
  if (!record(v) || !closed(v, ['schemaVersion', 'datasetId', 'queueId', 'revision', 'currentEntryId', 'entries', 'restartPolicy'])
    || v.schemaVersion !== '1.2' || !isCollectionId(v.datasetId) || !isCollectionId(v.queueId) || !isLocalCatalogRevision(v.revision)
    || !Array.isArray(v.entries) || v.entries.length > MAX_MB_QUEUE_ENTRIES || !v.entries.every(isMBQueueLogicalEntry)
    || !record(v.restartPolicy) || !closed(v.restartPolicy, ['reResolve', 'autoplay']) || v.restartPolicy.reResolve !== true || v.restartPolicy.autoplay !== false) return false;
  const ids = new Set(v.entries.map(entry => entry.entryId));
  return ids.size === v.entries.length && (v.currentEntryId === null || isCollectionId(v.currentEntryId) && ids.has(v.currentEntryId))
    && mbQueueSerializedBytes(v) <= MAX_MB_QUEUE_JSON_BYTES;
}
export function isMBQueueSaveRequest(v: unknown): v is MBQueueSaveRequest {
  return record(v) && closed(v, ['expectedRevision', 'queue']) && (v.expectedRevision === '0' || isLocalCatalogRevision(v.expectedRevision))
    && isMBQueueRecord(v.queue) && BigInt(v.queue.revision) === BigInt(v.expectedRevision) + 1n;
}
export function isMBQueueEditRequest(v: unknown): v is MBQueueEditRequest {
  return record(v) && closed(v, ['queueId', 'expectedRevision', 'entryIds', 'action']) && isCollectionId(v.queueId)
    && isLocalCatalogRevision(v.expectedRevision) && ['REMOVE', 'REORDER'].includes(String(v.action))
    && Array.isArray(v.entryIds) && v.entryIds.length <= MAX_MB_QUEUE_ENTRIES && v.entryIds.every(isCollectionId)
    && new Set(v.entryIds).size === v.entryIds.length;
}

export interface MBEditionQueueRequest { editionId:string; expectedRevision:string; action:'PLAY_NOW'|'APPEND_MB_QUEUE'|'PLAY_NEXT_MB_QUEUE' }
export interface MBEditionQueueSnapshot { edition:AlbumEdition; sources:readonly Extract<MBQueueLogicalSource,{kind:'local_file'}>[] }
export function isMBEditionQueueRequest(v:unknown):v is MBEditionQueueRequest {
 return record(v)&&closed(v,['editionId','expectedRevision','action'])&&isCollectionId(v.editionId)&&isLocalCatalogRevision(v.expectedRevision)
  && ['PLAY_NOW','APPEND_MB_QUEUE','PLAY_NEXT_MB_QUEUE'].includes(String(v.action));
}
export function isMBEditionQueueSnapshot(v:unknown):v is MBEditionQueueSnapshot {
 if(!record(v)||!isAlbumEdition(v.edition))return false;const edition=v.edition;
 return record(v)&&closed(v,['edition','sources'])&&isAlbumEdition(v.edition)&&Array.isArray(v.sources)&&v.sources.length<=MAX_MB_QUEUE_ENTRIES
  && v.sources.every(source=>isMBQueueLogicalSource(source)&&source.kind==='local_file'&&source.edition?.id===edition.id&&source.edition?.revision===edition.revision)
  && mbQueueSerializedBytes(v)<=MAX_MB_QUEUE_JSON_BYTES;
}

export interface MBQueuePlayEntryRequest { queueId:string; expectedRevision:string; entryId:string }
export function isMBQueuePlayEntryRequest(v:unknown):v is MBQueuePlayEntryRequest {
 return record(v)&&closed(v,['queueId','expectedRevision','entryId'])&&isCollectionId(v.queueId)&&isLocalCatalogRevision(v.expectedRevision)&&isCollectionId(v.entryId);
}
export interface MBQueuePublicApi {
 editPlaybackQueue(request:MBQueueEditRequest):Promise<import('./playback.js').PlaybackSnapshot>;
 playQueueEntry(request:MBQueuePlayEntryRequest):Promise<import('./playback.js').PlaybackSnapshot>;
 queueLocalEdition(request:MBEditionQueueRequest):Promise<import('./playback.js').PlaybackSnapshot>;
}
