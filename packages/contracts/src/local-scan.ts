import { isCollectionId } from './collection.js';
import { isLocalCatalogRevision, isLocalMetadata, type LocalCatalogRevision } from './local-catalog.js';
import { isScanJobRecord, type ScanJobRecord } from './local-domain-references.js';

/** 公开扫描入口只含逻辑身份；路径、stat观察和解析事实始终由Node owner捕获。 */
export interface LocalScanStartRequest { commandId: string; libraryRootId: string; expectedRootRevision: LocalCatalogRevision }
export interface LocalScanTransitionRequest { commandId: string; jobId: string; expectedRevision: LocalCatalogRevision }
export interface LocalScanGetRequest { jobId: string }
export interface LocalScanPageRequest { offset: number; limit: number }
export interface LocalScanReceiptRequest { commandId: string }
export type LocalScanPublicOperation = 'start' | 'pause' | 'resume' | 'cancel';
export interface LocalScanReceipt { commandId: string; jobId: string; operation: LocalScanPublicOperation | 'prepare-batch' | 'commit-batch' | 'recover'; fingerprint: string; result: ScanJobRecord }
export interface LocalScanPage { offset: number; limit: number; total: number; hasMore: boolean; items: ScanJobRecord[] }
const record = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const prototype = Object.getPrototypeOf(v); return prototype === Object.prototype || prototype === null;
};
const closed = (v: Record<string, unknown>, names: readonly string[]): boolean => {
  const actual = Reflect.ownKeys(v); return actual.length === names.length && actual.every(k => typeof k === 'string'
    && names.includes(k) && Object.prototype.propertyIsEnumerable.call(v, k)) && names.every(k => Object.hasOwn(v, k));
};
export function isLocalScanStartRequest(v: unknown): v is LocalScanStartRequest {
  return record(v) && closed(v, ['commandId', 'libraryRootId', 'expectedRootRevision'])
    && isCollectionId(v.commandId) && isCollectionId(v.libraryRootId) && isLocalCatalogRevision(v.expectedRootRevision);
}
export function isLocalScanTransitionRequest(v: unknown): v is LocalScanTransitionRequest {
  return record(v) && closed(v, ['commandId', 'jobId', 'expectedRevision'])
    && isCollectionId(v.commandId) && isCollectionId(v.jobId) && isLocalCatalogRevision(v.expectedRevision);
}
export function isLocalScanGetRequest(v: unknown): v is LocalScanGetRequest {
  return record(v) && closed(v, ['jobId']) && isCollectionId(v.jobId);
}
export function isLocalScanPageRequest(v: unknown): v is LocalScanPageRequest {
  return record(v) && closed(v, ['offset', 'limit']) && typeof v.offset === 'number' && Number.isSafeInteger(v.offset) && v.offset >= 0
    && typeof v.limit === 'number' && Number.isSafeInteger(v.limit) && v.limit >= 1 && v.limit <= 200;
}
export function isLocalScanReceiptRequest(v: unknown): v is LocalScanReceiptRequest {
  return record(v) && closed(v, ['commandId']) && isCollectionId(v.commandId);
}
export function isLocalScanReceipt(v: unknown): v is LocalScanReceipt {
  return record(v) && closed(v, ['commandId', 'jobId', 'operation', 'fingerprint', 'result']) && isCollectionId(v.commandId) && isCollectionId(v.jobId)
    && typeof v.operation === 'string' && ['start', 'pause', 'resume', 'cancel', 'prepare-batch', 'commit-batch', 'recover'].includes(v.operation)
    && typeof v.fingerprint === 'string' && /^[a-f0-9]{64}$/u.test(v.fingerprint) && isScanJobRecord(v.result) && v.result.jobId === v.jobId;
}
export function isLocalScanPage(v: unknown): v is LocalScanPage {
  return record(v) && closed(v, ['offset', 'limit', 'total', 'hasMore', 'items']) && isLocalScanPageRequest({ offset: v.offset, limit: v.limit })
    && typeof v.total === 'number' && Number.isSafeInteger(v.total) && v.total >= 0 && scanArray(v.items,200)
    && v.items.length === Math.min(v.limit as number, Math.max(0, v.total - (v.offset as number))) && v.items.every(isScanJobRecord) && typeof v.hasMore === 'boolean'
    && v.hasMore === ((v.offset as number) + v.items.length < v.total);
}

/** 可信批内容只是schema校验；真实stat/Reader/SourceStore事实仍由owner产生并重核。 */
export interface LocalScanPrepareBatchRequest { commandId: string; jobId: string; batch: unknown }
export interface LocalScanCommitBatchRequest { commandId: string; jobId: string; batchId: string; expectedRevision: LocalCatalogRevision }
export interface LocalScanCommandPayloads {
  'localScan.start': LocalScanStartRequest;
  'localScan.pause': LocalScanTransitionRequest;
  'localScan.resume': LocalScanTransitionRequest;
  'localScan.cancel': LocalScanTransitionRequest;
  'localScan.get': LocalScanGetRequest;
  'localScan.page': LocalScanPageRequest;
  'localScan.receipt': LocalScanReceiptRequest;
  'localScan.prepareBatch': LocalScanPrepareBatchRequest;
  'localScan.commitBatch': LocalScanCommitBatchRequest;
}
export interface LocalScanCommandResults {
  'localScan.start': ScanJobRecord; 'localScan.pause': ScanJobRecord; 'localScan.resume': ScanJobRecord; 'localScan.cancel': ScanJobRecord;
  'localScan.get': ScanJobRecord; 'localScan.page': LocalScanPage; 'localScan.receipt': LocalScanReceipt | null;
  'localScan.prepareBatch': ScanJobRecord; 'localScan.commitBatch': ScanJobRecord;
}
export const LOCAL_SCAN_COMMANDS = ['localScan.start','localScan.pause','localScan.resume','localScan.cancel','localScan.get','localScan.page','localScan.receipt','localScan.prepareBatch','localScan.commitBatch'] as const;
export type LocalScanCommand = typeof LOCAL_SCAN_COMMANDS[number];
export type LocalScanInternalCommand = 'localScan.prepareBatch' | 'localScan.commitBatch';
export const isLocalScanCommand = (v: unknown): v is LocalScanCommand => typeof v === 'string' && (LOCAL_SCAN_COMMANDS as readonly string[]).includes(v);
export const isLocalScanInternalCommand = (v: unknown): v is LocalScanInternalCommand => v === 'localScan.prepareBatch' || v === 'localScan.commitBatch';
const scanArray = (v: unknown, maximum: number): v is unknown[] => Array.isArray(v) && Object.getPrototypeOf(v) === Array.prototype
  && v.length <= maximum && Reflect.ownKeys(v).length === v.length + 1 && Reflect.ownKeys(v).every(k => k === 'length'
    || typeof k === 'string' && /^(0|[1-9][0-9]*)$/u.test(k) && Number(k) < v.length && Object.prototype.propertyIsEnumerable.call(v,k));
const scanText = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(v);
const scanRelative = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 4096
  && !/[\u0000-\u001f\u007f\\:]/u.test(v) && !v.startsWith('/') && v.split('/').every(p => p !== '' && p !== '.' && p !== '..');
const nonnegative = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
function scanFacts(v: unknown): boolean {
  if (!record(v) || !closed(v,['technical','coverEvidence','readEvidence']) || !record(v.technical)
    || !closed(v.technical,['container','codec','lossless','sampleRateHz','channels','bitsPerSample','durationSeconds','evidence'])
    || !['FLAC','MPEG','MP4','WAVE','AIFF'].includes(String(v.technical.container)) || !scanText(v.technical.codec)
    || !(v.technical.lossless === null || typeof v.technical.lossless === 'boolean')
    || !nonnegative(v.technical.sampleRateHz) || v.technical.sampleRateHz === 0 || !nonnegative(v.technical.channels) || v.technical.channels === 0
    || !(v.technical.bitsPerSample === null || nonnegative(v.technical.bitsPerSample))
    || !(v.technical.durationSeconds === null || nonnegative(v.technical.durationSeconds)) || v.technical.evidence !== 'bounded-parser-reported'
    || !scanArray(v.coverEvidence,8) || !record(v.readEvidence)
    || !closed(v.readEvidence,['bytesRead','readCalls','maxReadBytes','allocationBytes','elapsedMs','wholeAudioHash','wholeAudioDecode'])) return false;
  for (const cover of v.coverEvidence) if (!record(cover) || !closed(cover,['mime','bytes','sha256','evidence'])
    || !(cover.mime === 'image/png' || cover.mime === 'image/jpeg') || typeof cover.bytes !== 'number' || !Number.isSafeInteger(cover.bytes)
    || cover.bytes < 1 || cover.bytes > 4*1024*1024 || typeof cover.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(cover.sha256)
    || cover.evidence !== 'encoded-bytes-magic-and-digest') return false;
  const e=v.readEvidence;
  for (const k of ['bytesRead','readCalls','maxReadBytes','allocationBytes']) if (typeof e[k] !== 'number' || !Number.isSafeInteger(e[k]) || (e[k] as number)<0) return false;
  return (e.bytesRead as number)<=32*1024*1024 && (e.maxReadBytes as number)<=8*1024*1024 && (e.allocationBytes as number)<=64*1024*1024
    && nonnegative(e.elapsedMs) && e.wholeAudioHash === false && e.wholeAudioDecode === false;
}
function scanItem(v: unknown): boolean {
  if (!record(v) || !closed(v,['relative','signature','parserVersion','outcome','fields','failureCode','reused','readFacts'])
    || !scanRelative(v.relative) || !scanText(v.signature) || !scanText(v.parserVersion) || typeof v.reused !== 'boolean'
    || !(v.readFacts === null || scanFacts(v.readFacts))) return false;
  if (v.outcome === 'rejected') return !v.reused && v.fields === null && scanText(v.failureCode);
  return v.outcome === 'accepted' && v.failureCode === null && record(v.fields)
    && Reflect.ownKeys(v.fields).every(k => typeof k === 'string' && ['title','artist','album','year','disc','track'].includes(k) && Object.prototype.propertyIsEnumerable.call(v.fields,k))
    && isLocalMetadata(v.fields) && (v.reused ? Object.keys(v.fields).length === 0 && v.readFacts === null : scanFacts(v.readFacts));
}
/** CUE仅保留声明与owner快照，不是精确asset segment或播放许可。 */
export interface LocalCueAssetReference { assetId:string; libraryRootId:string; sourceRootId:string; rootRevision:string; fileRevision:string; locationRevision:string; relative:string; signature:string }
export interface LocalCueTrackFact { trackNumber:number; fileOrdinal:number; assetReference:LocalCueAssetReference; timebase:'cue-cd-frames'; framesPerSecond:75; index00Frames:number|null; index01Frames:number; endFrames:null; title?:string; performer?:string; evidence:'cue-text-declared'; playback:'NOT_VERIFIED' }
export interface LocalCueResult { status:'ok'; albumTitle?:string; albumPerformer?:string; tracks:LocalCueTrackFact[] }
export interface LocalCuePreparedItem { relative:string; signature:string; parserVersion:string; outcome:'accepted'|'rejected'; failureCode:string|null; reused:boolean; previousSnapshotId:string|null; result:LocalCueResult|null }
function cueText(v:unknown):v is string {
  if(typeof v !== 'string' || v.length>4096) return false;
  for(let i=0;i<v.length;i++){const c=v.charCodeAt(i);if(c<32 && c!==9 || c===127) return false;
    if(c>=0xd800 && c<=0xdbff){const next=v.charCodeAt(++i);if(!(next>=0xdc00 && next<=0xdfff)) return false;}
    else if(c>=0xdc00 && c<=0xdfff) return false;
  }
  return new TextEncoder().encode(v).length<=4096;
}
function cueKeys(v:Record<string,unknown>,required:readonly string[],optional:readonly string[]):boolean {
  return Reflect.ownKeys(v).every(k=>typeof k === 'string' && [...required,...optional].includes(k) && Object.prototype.propertyIsEnumerable.call(v,k)) && required.every(k=>Object.hasOwn(v,k));
}
export function isLocalCueAssetReference(v:unknown):v is LocalCueAssetReference {
  return record(v) && closed(v,['assetId','libraryRootId','sourceRootId','rootRevision','fileRevision','locationRevision','relative','signature'])
    && ['assetId','libraryRootId','sourceRootId'].every(k=>isCollectionId(v[k])) && ['rootRevision','fileRevision','locationRevision'].every(k=>isLocalCatalogRevision(v[k]))
    && scanRelative(v.relative) && scanText(v.signature);
}
export function isLocalCueResult(v:unknown):v is LocalCueResult {
  if(!record(v) || !cueKeys(v,['status','tracks'],['albumTitle','albumPerformer']) || v.status !== 'ok' || !scanArray(v.tracks,99) || v.tracks.length<1
    || ['albumTitle','albumPerformer'].some(k=>Object.hasOwn(v,k) && !cueText(v[k]))) return false;
  let previous=0,fileOrdinal=0,lastIndex=-1,reference:LocalCueAssetReference|undefined,textBytes=0;
  for(const key of ['albumTitle','albumPerformer']) if(typeof v[key] === 'string') textBytes+=new TextEncoder().encode(v[key] as string).length;
  for(const item of v.tracks) {
    if(!record(item) || !cueKeys(item,['trackNumber','fileOrdinal','assetReference','timebase','framesPerSecond','index00Frames','index01Frames','endFrames','evidence','playback'],['title','performer'])
      || typeof item.trackNumber !== 'number' || !Number.isSafeInteger(item.trackNumber) || item.trackNumber<=previous || item.trackNumber>99
      || typeof item.fileOrdinal !== 'number' || !Number.isSafeInteger(item.fileOrdinal) || item.fileOrdinal<1 || item.fileOrdinal>32
      || !isLocalCueAssetReference(item.assetReference) || item.timebase !== 'cue-cd-frames' || item.framesPerSecond !== 75 || item.endFrames !== null
      || typeof item.index01Frames !== 'number' || !Number.isSafeInteger(item.index01Frames) || item.index01Frames<0 || item.index01Frames>4_499_999
      || !(item.index00Frames === null || typeof item.index00Frames === 'number' && Number.isSafeInteger(item.index00Frames) && item.index00Frames>=0 && item.index00Frames<=item.index01Frames)
      || item.evidence !== 'cue-text-declared' || item.playback !== 'NOT_VERIFIED' || ['title','performer'].some(k=>Object.hasOwn(item,k) && !cueText(item[k]))) return false;
    const nextReference=item.assetReference;
    if(item.fileOrdinal !== fileOrdinal) {if(item.fileOrdinal !== fileOrdinal+1) return false;fileOrdinal=item.fileOrdinal;lastIndex=-1;reference=nextReference;}
    else if(reference && (['assetId','libraryRootId','sourceRootId','rootRevision','fileRevision','locationRevision','relative','signature'] as const).some(k=>reference![k] !== nextReference[k])) return false;
    if(item.index01Frames<=lastIndex || item.index00Frames !== null && item.index00Frames<lastIndex) return false;
    lastIndex=item.index01Frames;for(const key of ['title','performer']) if(typeof item[key] === 'string') textBytes+=new TextEncoder().encode(item[key] as string).length;
    previous=item.trackNumber;
  }
  return textBytes<=65536; // 所有闭集字段/数组已有限；整个批仍受原8MiB持久JSON边界保护。
}
export function isLocalCuePreparedItem(v:unknown):v is LocalCuePreparedItem {
  return record(v) && closed(v,['relative','signature','parserVersion','outcome','failureCode','reused','previousSnapshotId','result'])
    && scanRelative(v.relative) && /\.cue$/iu.test(v.relative) && scanText(v.signature) && v.parserVersion === 'cue-text-75fps/mbrs003-v1'
    && typeof v.reused === 'boolean' && (v.previousSnapshotId === null || isCollectionId(v.previousSnapshotId))
    && (v.outcome === 'accepted' ? v.failureCode === null && isLocalCueResult(v.result) && (!v.reused || v.previousSnapshotId !== null)
      : v.outcome === 'rejected' && !v.reused && v.result === null && scanText(v.failureCode));
}
export function isLocalScanPreparedBatch(v: unknown): boolean {
  if(record(v) && Object.hasOwn(v,'kind')) return closed(v,['batchId','jobId','expectedJobRevision','checkpointBefore','items','frontier','completed','kind','cueItems'])
    && v.kind === 'cue-sidecars-v1' && isCollectionId(v.batchId) && isCollectionId(v.jobId) && isLocalCatalogRevision(v.expectedJobRevision)
    && (v.checkpointBefore === null || isCollectionId(v.checkpointBefore)) && scanArray(v.items,200) && v.items.every(scanItem)
    && new Set(v.items.map(item => (item as Record<string,unknown>).relative)).size === v.items.length && scanArray(v.cueItems,1) && v.cueItems.every(isLocalCuePreparedItem) && !(v.items.length && v.cueItems.length)
    && scanArray(v.frontier,200) && v.frontier.every(p=>p === '' || scanRelative(p)) && new Set(v.frontier).size === v.frontier.length
    && typeof v.completed === 'boolean' && (!v.completed || v.frontier.length === 0);

  return record(v) && closed(v,['batchId','jobId','expectedJobRevision','checkpointBefore','items','frontier','completed'])
    && isCollectionId(v.batchId) && isCollectionId(v.jobId) && isLocalCatalogRevision(v.expectedJobRevision)
    && (v.checkpointBefore === null || isCollectionId(v.checkpointBefore)) && scanArray(v.items,200) && v.items.every(scanItem)
    && new Set(v.items.map(item => (item as Record<string,unknown>).relative)).size === v.items.length
    && scanArray(v.frontier,200) && v.frontier.every(p => p === '' || scanRelative(p)) && new Set(v.frontier).size === v.frontier.length
    && typeof v.completed === 'boolean' && (!v.completed || v.frontier.length === 0);
}
export function isLocalScanCommandPayload(command: LocalScanCommand,v: unknown): boolean {
  switch(command) {
    case 'localScan.start': return isLocalScanStartRequest(v);
    case 'localScan.pause': case 'localScan.resume': case 'localScan.cancel': return isLocalScanTransitionRequest(v);
    case 'localScan.get': return isLocalScanGetRequest(v);
    case 'localScan.page': return isLocalScanPageRequest(v);
    case 'localScan.receipt': return isLocalScanReceiptRequest(v);
    case 'localScan.prepareBatch': return record(v) && closed(v,['commandId','jobId','batch']) && isCollectionId(v.commandId) && isCollectionId(v.jobId)
      && isLocalScanPreparedBatch(v.batch) && record(v.batch) && v.batch.jobId === v.jobId;
    case 'localScan.commitBatch': return record(v) && closed(v,['commandId','jobId','batchId','expectedRevision']) && isCollectionId(v.commandId)
      && isCollectionId(v.jobId) && isCollectionId(v.batchId) && isLocalCatalogRevision(v.expectedRevision);
  }
}
export function isLocalScanCommandResult(command: LocalScanCommand,v: unknown): boolean {
  return command === 'localScan.page' ? isLocalScanPage(v) : command === 'localScan.receipt' ? v === null || isLocalScanReceipt(v) : isScanJobRecord(v);
}
