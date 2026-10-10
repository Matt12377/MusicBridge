import { isFileAudioParameters, type FileAudioParameters, isAudioAsset, isLibraryRoot, isLocalTrack, isLocalPlayRequest, type LocalPlayRequest } from '@music-bridge/contracts';
import type { LocalSourceFacts } from '../application/local-source-facts.js';
import type { TrackMetadata } from '../netease/types.js';
import { LocalSourceFence } from '../stream/local-source-fence.js';
import path from 'node:path';
export interface LocalSourceCaptureResult {
  ticketId: string; epoch: string; datasetId: string; buffer: SharedArrayBuffer;
  facts: LocalSourceFacts; metadata: TrackMetadata; format?: string; fileParameters?: FileAudioParameters;
}
export type LocalSourcePrivatePayload = { selection: LocalPlayRequest } | { ticketId: string };
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const closed = (v: Record<string, unknown>, required: string[], optional: string[] = []) => required.every(k => Object.hasOwn(v,k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const text = (v: unknown, max = 512): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/u.test(v);
export function isLocalSourcePrivatePayload(operation: string, v: unknown): v is LocalSourcePrivatePayload {
  return record(v) && (operation === 'captureLocalSource' ? closed(v,['selection']) && isLocalPlayRequest(v.selection) : closed(v,['ticketId']) && text(v.ticketId));
}
/** 私有响应也是闭合合同，不能靠cast把未认证快照升级为读取资格。 */
export function isLocalSourceCaptureResult(v: unknown): v is LocalSourceCaptureResult {
  if (!record(v) || !closed(v,['ticketId','epoch','datasetId','buffer','facts','metadata'],['format','fileParameters']) || !text(v.ticketId) || !text(v.epoch) || !text(v.datasetId)) return false;
  try { new LocalSourceFence(v.buffer as SharedArrayBuffer); } catch { return false; }
  try { if (Buffer.byteLength(JSON.stringify({...v,buffer:undefined}), 'utf8') > 64 * 1024) return false; } catch { return false; }
  if (v.fileParameters !== undefined && !isFileAudioParameters(v.fileParameters)) return false;
  const f = v.facts;
  if (!record(f) || !closed(f,['track','asset','root','sourceRoot','relative','observation']) || !isLocalTrack(f.track) || f.track.segment !== null || !isAudioAsset(f.asset) || !isLibraryRoot(f.root)
    || !text(f.relative,4096) || path.isAbsolute(f.relative) || f.relative.split(/[\\/]/u).some(p => !p || p === '.' || p === '..')) return false;
  const s = f.sourceRoot, o = f.observation;
  if (!record(s) || !closed(s,['id','path','dev','ino','authorized','label']) || !text(s.id) || !text(s.path,4096) || !path.isAbsolute(s.path) || s.authorized !== true
    || typeof s.dev !== 'string' || !/^(0|[1-9]\d{0,31}|-[1-9]\d{0,30})$/u.test(s.dev) || typeof s.ino !== 'string' || !/^(0|[1-9]\d{0,31}|-[1-9]\d{0,30})$/u.test(s.ino) || typeof s.label !== 'string' || s.label.length > 256 || !record(o)
    || !closed(o,['signature','assetId','trackId','libraryRootId','sourceRootId','fileRevision','rootRevision','locationRevision','selectionRevision']) || !text(o.signature,256) || !/^(0|[1-9]\d{0,31}|-[1-9]\d{0,30}):(0|[1-9]\d{0,31}|-[1-9]\d{0,30}):(0|[1-9]\d{0,31}):-?\d{1,24}:-?\d{1,24}$/u.test(o.signature)) return false;
  if (f.track.assetId !== f.asset.id || f.asset.libraryRootId !== f.root.id || f.root.sourceRootId !== s.id || f.asset.sourceRootId !== s.id || f.asset.rootRevision !== f.root.revision
    || o.assetId !== f.asset.id || o.trackId !== f.track.id || o.libraryRootId !== f.root.id || o.sourceRootId !== s.id || o.fileRevision !== f.asset.fileRevision
    || o.rootRevision !== f.root.revision || o.locationRevision !== f.asset.locationRevision || o.selectionRevision !== f.track.selectionRevision) return false;
  const m = v.metadata;
  return record(m) && closed(m,['id','title','artists','album'],['durationMs','version']) && m.id === f.track.id && text(m.title) && typeof m.album === 'string' && m.album.length <= 512
    && Array.isArray(m.artists) && m.artists.length <= 32 && m.artists.every(a => text(a)) && (m.durationMs === undefined || typeof m.durationMs === 'number' && Number.isSafeInteger(m.durationMs) && m.durationMs >= 0)
    && (m.version === undefined || text(m.version)) && (v.format === undefined || typeof v.format === 'string' && /^[a-z0-9]{1,8}$/u.test(v.format));
}
