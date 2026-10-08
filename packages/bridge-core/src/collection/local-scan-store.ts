import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import * as dto from '@music-bridge/contracts';
import type { MetadataTechnical, MetadataCoverEvidence, MetadataReadEvidence } from '../library/metadata-reader-types.js';
import { LocalCatalogBudgetError, sourceWritesProjectionForDatabase } from './local-catalog-store.js';
import { installSourceWriteScanPort } from './source-write-scan-port.js';
import type { ScanReadFacts } from './local-scan-facts.js';
export type { ScanReadFacts } from './local-scan-facts.js';

/** 扫描状态与目录实体在原业务连接中持久化；这些表不赋予文件系统授权。 */
const tables = {
  local_scan_jobs: 'CREATE TABLE local_scan_jobs(id TEXT PRIMARY KEY,dataset_id TEXT NOT NULL,library_root_id TEXT NOT NULL REFERENCES local_catalog_roots(id),source_root_id TEXT NOT NULL REFERENCES source_roots(id),parser_version TEXT NOT NULL,data TEXT NOT NULL) STRICT',
  local_scan_batches: "CREATE TABLE local_scan_batches(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES local_scan_jobs(id),fingerprint TEXT NOT NULL,request TEXT NOT NULL,phase TEXT NOT NULL CHECK(phase IN ('prepared','committed')),result TEXT) STRICT",
  local_scan_checkpoints: 'CREATE TABLE local_scan_checkpoints(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES local_scan_jobs(id),batch_id TEXT NOT NULL UNIQUE REFERENCES local_scan_batches(id),data TEXT NOT NULL) STRICT',
  local_scan_file_state: 'CREATE TABLE local_scan_file_state(library_root_id TEXT NOT NULL REFERENCES local_catalog_roots(id),relative TEXT NOT NULL,job_id TEXT NOT NULL REFERENCES local_scan_jobs(id),batch_id TEXT NOT NULL REFERENCES local_scan_batches(id),asset_id TEXT REFERENCES local_catalog_assets(id),track_id TEXT REFERENCES local_catalog_tracks(id),data TEXT NOT NULL,PRIMARY KEY(library_root_id,relative)) STRICT',
  local_scan_receipts: 'CREATE TABLE local_scan_receipts(command_id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES local_scan_jobs(id),operation TEXT NOT NULL,fingerprint TEXT NOT NULL,request TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL) STRICT',
} as const;
const indexes = [
  'CREATE INDEX local_scan_catalog_locator ON local_catalog_assets(root_id,relative)',
  'CREATE INDEX local_scan_state_asset ON local_scan_file_state(asset_id)',
  'CREATE INDEX local_scan_jobs_dataset ON local_scan_jobs(dataset_id)',
  'CREATE INDEX local_scan_batches_job ON local_scan_batches(job_id)',
  'CREATE INDEX local_scan_checkpoints_job ON local_scan_checkpoints(job_id)',
  'CREATE INDEX local_scan_receipts_job ON local_scan_receipts(job_id)',
  "CREATE INDEX local_scan_receipts_prepared ON local_scan_receipts(job_id,operation,json_extract(request,'$.batch.batchId'))",
  "CREATE INDEX local_scan_receipts_committed ON local_scan_receipts(job_id,operation,json_extract(request,'$.batchId'))",
];
const triggers = Object.keys(tables).map(name => `CREATE TRIGGER ${name}_no_delete BEFORE DELETE ON ${name} BEGIN SELECT RAISE(ABORT,'扫描持久事实保留'); END`);
for (const name of ['local_scan_checkpoints', 'local_scan_receipts']) triggers.push(`CREATE TRIGGER ${name}_no_update BEFORE UPDATE ON ${name} BEGIN SELECT RAISE(ABORT,'扫描历史不可改写'); END`);
triggers.push("CREATE TRIGGER local_scan_batches_immutable BEFORE UPDATE ON local_scan_batches WHEN OLD.phase<>'prepared' OR NEW.phase<>'committed' OR NEW.id<>OLD.id OR NEW.job_id<>OLD.job_id OR NEW.fingerprint<>OLD.fingerprint OR NEW.request<>OLD.request OR OLD.result IS NOT NULL OR NEW.result IS NULL BEGIN SELECT RAISE(ABORT,'扫描批请求不可改写'); END");
export const localScanMigration = [...Object.values(tables), ...indexes, ...triggers, 'PRAGMA user_version=32'].join(';\n') + ';';

/** schema32的可选原子扩展：无CUE的旧五表32继续有效，partial结构永不补修。 */
const cueTables = {
  local_cue_sources:'CREATE TABLE local_cue_sources(id TEXT PRIMARY KEY,sidecar_id TEXT NOT NULL,library_root_id TEXT NOT NULL REFERENCES local_catalog_roots(id),relative TEXT NOT NULL,batch_id TEXT NOT NULL REFERENCES local_scan_batches(id),data TEXT NOT NULL) STRICT',
  local_cue_tracks:'CREATE TABLE local_cue_tracks(snapshot_id TEXT NOT NULL REFERENCES local_cue_sources(id),ordinal INTEGER NOT NULL,asset_id TEXT NOT NULL REFERENCES local_catalog_assets(id),data TEXT NOT NULL,PRIMARY KEY(snapshot_id,ordinal)) STRICT',
} as const;
const cueIndexes=['CREATE INDEX local_cue_current ON local_cue_sources(library_root_id,relative)'];
const cueTriggers=Object.keys(cueTables).flatMap(name=>[
  `CREATE TRIGGER ${name}_no_delete BEFORE DELETE ON ${name} BEGIN SELECT RAISE(ABORT,'CUE声明历史保留'); END`,
  `CREATE TRIGGER ${name}_no_update BEFORE UPDATE ON ${name} BEGIN SELECT RAISE(ABORT,'CUE声明历史不可改写'); END`,
]);
function cueSchema(db:DatabaseSync):boolean {
  const found=Object.keys(cueTables).map(name=>db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name));
  if(found.every(row=>row === undefined)) {
    for(const sql of [...cueIndexes,...cueTriggers]) if(db.prepare('SELECT name FROM sqlite_master WHERE name=?').get(sql.split(' ')[2]!)) return corrupt();
    return false;
  }
  if(found.some(row=>row === undefined)) return corrupt();
  for(const [name,sql] of Object.entries(cueTables)) if(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name)?.sql !== sql) return corrupt();
  for(const [type,list] of [['index',cueIndexes],['trigger',cueTriggers]] as const) for(const sql of list)
    if(db.prepare('SELECT sql FROM sqlite_master WHERE type=? AND name=?').get(type,sql.split(' ')[2]!)?.sql !== sql) return corrupt();
  return true;
}
function ensureCueSchema(db:DatabaseSync):void {if(!cueSchema(db)) db.exec([...Object.values(cueTables),...cueIndexes,...cueTriggers].join(';')+';');}
export interface CueSnapshot {id:string;sidecarId:string;libraryRootId:string;sourceRootId:string;rootRevision:string;item:dto.LocalCuePreparedItem}
function isCueSnapshot(v:unknown):v is CueSnapshot {return record(v) && closed(v,['id','sidecarId','libraryRootId','sourceRootId','rootRevision','item'])
  && ['id','sidecarId','libraryRootId','sourceRootId'].every(k=>dto.isCollectionId(v[k])) && dto.isLocalCatalogRevision(v.rootRevision) && dto.isLocalCuePreparedItem(v.item);}
const batchCount=(batch:ScanPreparedBatch)=>batch.kind === 'cue-sidecars-v1' ? [...batch.items,...(batch.cueItems ?? [])]:batch.items;
function cueLatest(db:DatabaseSync,rootId:string,relative:string):CueSnapshot|null {
  if(!cueSchema(db)) return null;
  const row=db.prepare('SELECT data FROM local_cue_sources WHERE library_root_id=? AND relative=? ORDER BY rowid DESC LIMIT 1').get(rootId,relative);
  return row ? parse(row.data,isCueSnapshot):null;
}
function verifyCueBatch(db:DatabaseSync,batch:ScanPreparedBatch,committed:ScanCommittedBatch,job:dto.ScanJobRecord):void {
  if(!cueSchema(db) || committed.kind !== 'cue-sidecars-v1' || committed.cueSnapshotIds?.length !== batch.cueItems?.length) return corrupt();
  for(const [index,item] of (batch.cueItems ?? []).entries()) {
    const id=committed.cueSnapshotIds![index]!,row=db.prepare('SELECT * FROM local_cue_sources WHERE id=?').get(id);
    if(!row) return corrupt();const snapshot=parse(row.data,isCueSnapshot);
    if(snapshot.id !== id || snapshot.libraryRootId !== job.libraryRootId || snapshot.sourceRootId !== job.sourceRootId || snapshot.rootRevision !== job.rootRevision
      || row.sidecar_id !== snapshot.sidecarId || row.library_root_id !== snapshot.libraryRootId || row.relative !== item.relative) return corrupt();
    if(item.reused) {
      if(item.previousSnapshotId !== id || snapshot.item.signature !== item.signature || snapshot.item.parserVersion !== item.parserVersion || !equal(snapshot.item.result,item.result)) return corrupt();
    } else if(row.batch_id !== batch.batchId || !equal(snapshot.item,item)) return corrupt();
    const trackRows=db.prepare('SELECT * FROM local_cue_tracks WHERE snapshot_id=? ORDER BY ordinal LIMIT 100').all(id),tracks=snapshot.item.result?.tracks ?? [];
    if(trackRows.length !== tracks.length) return corrupt();
    for(const [ordinal,track] of tracks.entries()) {
      const selected=trackRows[ordinal]!;if(selected.ordinal !== ordinal || selected.asset_id !== track.assetReference.assetId || !equal(JSON.parse(String(selected.data)),track)
        || !db.prepare('SELECT id FROM local_catalog_assets WHERE id=?').get(track.assetReference.assetId)) return corrupt();
    }
  }
}

type Row = Record<string, unknown>;
type Table = keyof typeof tables | keyof typeof cueTables;
export type ScanReceiptOperation = 'start' | 'pause' | 'resume' | 'cancel' | 'prepare-batch' | 'commit-batch' | 'recover' | 'abandon-batch' | 'fail';
export interface ScanPreparedItem {
  relative: string; signature: string; parserVersion: string;
  outcome: 'accepted' | 'rejected'; fields: dto.LocalMetadata | null; failureCode: string | null; reused: boolean; readFacts: ScanReadFacts | null;
}
export interface ScanPreparedBatch {
  batchId: string; jobId: string; expectedJobRevision: string; checkpointBefore: string | null;
  items: ScanPreparedItem[]; frontier: string[]; completed: boolean;
  kind?: 'cue-sidecars-v1'; cueItems?: dto.LocalCuePreparedItem[];
}
export interface ScanCheckpoint {
  checkpointId: string; jobId: string; batchId: string; sequence: string;
  frontier: string[]; progress: dto.ScanJobProgress;
}
export interface ScanFileState {
  libraryRootId: string; relative: string; signature: string; parserVersion: string;
  outcome: 'accepted' | 'rejected'; assetId: string | null; trackId: string | null; failureCode: string | null; readFacts: ScanReadFacts | null;
}
const corrupt = (): never => { throw new Error('扫描持久结构或历史损坏，保留现有数据。'); };
const record = (v: unknown): v is Row => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const prototype = Object.getPrototypeOf(v); return prototype === Object.prototype || prototype === null;
};
const closed = (v: Row, names: readonly string[]): boolean => {
  const actual = Reflect.ownKeys(v); return actual.length === names.length && actual.every(k => typeof k === 'string'
    && names.includes(k) && Object.prototype.propertyIsEnumerable.call(v, k)) && names.every(k => Object.hasOwn(v, k));
};
const array = (v: unknown, maximum: number): v is unknown[] => {
  if (!Array.isArray(v) || Object.getPrototypeOf(v) !== Array.prototype || v.length > maximum) return false;
  const keys = Reflect.ownKeys(v); return keys.length === v.length + 1 && keys.every(key => key === 'length'
    || typeof key === 'string' && /^(0|[1-9][0-9]*)$/u.test(key) && Number(key) < v.length
      && Object.prototype.propertyIsEnumerable.call(v, key));
};
const scanMetadata = (v: unknown): v is dto.LocalMetadata => record(v) && Reflect.ownKeys(v).every(key => typeof key === 'string'
  && ['title', 'artist', 'album', 'year', 'disc', 'track'].includes(key) && Object.prototype.propertyIsEnumerable.call(v, key)) && dto.isLocalMetadata(v);
export const scanRelativePath = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 4096
  && !/[\u0000-\u001f\u007f\\:]/u.test(v) && !path.posix.isAbsolute(v) && v.split('/').every(p => p !== '' && p !== '.' && p !== '..');
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
export function scanCanonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(scanCanonical).join(',')}]`;
  if (record(v)) return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${scanCanonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
export const scanFingerprint = (operation: string, request: unknown): string => createHash('sha256').update(scanCanonical([operation, request])).digest('hex');
const equal = (a: unknown, b: unknown): boolean => scanCanonical(a) === scanCanonical(b);
const nullableId = (v: unknown): boolean => v === null || dto.isCollectionId(v);
const frontier = (v: unknown): v is string[] => array(v, 200) && v.every(p => p === '' || scanRelativePath(p)) && new Set(v).size === v.length;
const progress = (v: unknown): v is dto.ScanJobProgress => record(v) && closed(v, ['visited', 'accepted', 'rejected'])
  && dto.isLocalExactInteger(v.visited) && dto.isLocalExactInteger(v.accepted) && dto.isLocalExactInteger(v.rejected)
  && BigInt(v.accepted) + BigInt(v.rejected) === BigInt(v.visited);
const finiteNonnegative = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
export function isScanReadFacts(v: unknown): v is ScanReadFacts {
  if (!record(v) || !closed(v, ['technical', 'coverEvidence', 'readEvidence']) || !record(v.technical)
    || !closed(v.technical, ['container', 'codec', 'lossless', 'sampleRateHz', 'channels', 'bitsPerSample', 'durationSeconds', 'evidence'])
    || typeof v.technical.container !== 'string' || !['FLAC', 'MPEG', 'MP4', 'WAVE', 'AIFF'].includes(v.technical.container)
    || !text(v.technical.codec) || !(v.technical.lossless === null || typeof v.technical.lossless === 'boolean')
    || !finiteNonnegative(v.technical.sampleRateHz) || v.technical.sampleRateHz === 0 || !finiteNonnegative(v.technical.channels) || v.technical.channels === 0
    || !(v.technical.bitsPerSample === null || finiteNonnegative(v.technical.bitsPerSample))
    || !(v.technical.durationSeconds === null || finiteNonnegative(v.technical.durationSeconds)) || v.technical.evidence !== 'bounded-parser-reported'
    || !array(v.coverEvidence, 8) || !record(v.readEvidence)
    || !closed(v.readEvidence, ['bytesRead', 'readCalls', 'maxReadBytes', 'allocationBytes', 'elapsedMs', 'wholeAudioHash', 'wholeAudioDecode'])) return false;
  for (const cover of v.coverEvidence) if (!record(cover) || !closed(cover, ['mime', 'bytes', 'sha256', 'evidence'])
    || !(cover.mime === 'image/png' || cover.mime === 'image/jpeg') || typeof cover.bytes !== 'number' || !Number.isSafeInteger(cover.bytes)
    || cover.bytes < 1 || cover.bytes > 4 * 1024 * 1024 || !hash(cover.sha256) || cover.evidence !== 'encoded-bytes-magic-and-digest') return false;
  const evidence = v.readEvidence;
  for (const key of ['bytesRead', 'readCalls', 'maxReadBytes', 'allocationBytes']) if (typeof evidence[key] !== 'number' || !Number.isSafeInteger(evidence[key]) || (evidence[key] as number) < 0) return false;
  return (evidence.bytesRead as number) <= 32 * 1024 * 1024 && (evidence.maxReadBytes as number) <= 8 * 1024 * 1024
    && (evidence.allocationBytes as number) <= 64 * 1024 * 1024 && finiteNonnegative(evidence.elapsedMs)
    && evidence.wholeAudioHash === false && evidence.wholeAudioDecode === false;
}
export function isScanPreparedItem(v: unknown): v is ScanPreparedItem {
  return record(v) && closed(v, ['relative', 'signature', 'parserVersion', 'outcome', 'fields', 'failureCode', 'reused', 'readFacts'])
    && scanRelativePath(v.relative) && text(v.signature) && text(v.parserVersion)
    && typeof v.reused === 'boolean' && (v.readFacts === null || isScanReadFacts(v.readFacts))
    && (v.outcome === 'accepted' ? scanMetadata(v.fields) && v.failureCode === null
      && (v.reused ? Object.keys(v.fields).length === 0 && v.readFacts === null : isScanReadFacts(v.readFacts))
      : v.outcome === 'rejected' && !v.reused && v.fields === null && text(v.failureCode));
}
export function isScanPreparedBatch(v: unknown): v is ScanPreparedBatch {
  if(record(v) && Object.hasOwn(v,'kind')) return dto.isLocalScanPreparedBatch(v);
  return record(v) && closed(v, ['batchId', 'jobId', 'expectedJobRevision', 'checkpointBefore', 'items', 'frontier', 'completed'])
    && dto.isCollectionId(v.batchId) && dto.isCollectionId(v.jobId) && dto.isLocalCatalogRevision(v.expectedJobRevision)
    && nullableId(v.checkpointBefore) && array(v.items, 200) && v.items.every(isScanPreparedItem)
    && new Set(v.items.map(item => item.relative)).size === v.items.length && frontier(v.frontier) && typeof v.completed === 'boolean'
    && (!v.completed || v.frontier.length === 0);
}
export function isScanCheckpoint(v: unknown): v is ScanCheckpoint {
  return record(v) && closed(v, ['checkpointId', 'jobId', 'batchId', 'sequence', 'frontier', 'progress'])
    && dto.isCollectionId(v.checkpointId) && dto.isCollectionId(v.jobId) && dto.isCollectionId(v.batchId)
    && dto.isLocalCatalogRevision(v.sequence) && frontier(v.frontier) && progress(v.progress);
}
export function isScanFileState(v: unknown): v is ScanFileState {
  return record(v) && closed(v, ['libraryRootId', 'relative', 'signature', 'parserVersion', 'outcome', 'assetId', 'trackId', 'failureCode', 'readFacts'])
    && dto.isCollectionId(v.libraryRootId) && scanRelativePath(v.relative) && text(v.signature) && text(v.parserVersion)
    && (v.readFacts === null || isScanReadFacts(v.readFacts))
    && (v.outcome === 'accepted' ? dto.isCollectionId(v.assetId) && dto.isCollectionId(v.trackId) && v.failureCode === null && isScanReadFacts(v.readFacts)
      : v.outcome === 'rejected' && nullableId(v.assetId) && nullableId(v.trackId) && (v.assetId === null) === (v.trackId === null) && text(v.failureCode));
}
export interface ScanCommittedBatch { job: dto.ScanJobRecord; files: ScanFileState[]; kind?: 'cue-sidecars-v1'; cueSnapshotIds?: string[] }
export function isScanCommittedBatch(v: unknown): v is ScanCommittedBatch {
  if(record(v) && Object.hasOwn(v,'kind')) return closed(v,['job','files','kind','cueSnapshotIds']) && v.kind === 'cue-sidecars-v1' && dto.isScanJobRecord(v.job)
    && array(v.files,200) && v.files.every(isScanFileState) && new Set(v.files.map(file=>file.relative)).size === v.files.length && array(v.cueSnapshotIds,1) && v.cueSnapshotIds.every(dto.isCollectionId);
  return record(v) && closed(v, ['job', 'files']) && dto.isScanJobRecord(v.job) && array(v.files, 200)
    && v.files.every(isScanFileState) && new Set(v.files.map(file => file.relative)).size === v.files.length;
}
export function isScanReceiptRequest(operation: ScanReceiptOperation, v: unknown): v is Row & { commandId: string; jobId: string } {
  if (!record(v) || !dto.isCollectionId(v.commandId) || !dto.isCollectionId(v.jobId)) return false;
  switch (operation) {
    case 'start': return closed(v, ['commandId', 'jobId', 'datasetId', 'libraryRootId', 'expectedRootRevision', 'parserVersion'])
      && dto.isCollectionId(v.datasetId) && dto.isCollectionId(v.libraryRootId) && dto.isLocalCatalogRevision(v.expectedRootRevision) && text(v.parserVersion);
    case 'prepare-batch': return closed(v, ['commandId', 'jobId', 'batch']) && isScanPreparedBatch(v.batch) && v.batch.jobId === v.jobId;
    case 'commit-batch': return closed(v, ['commandId', 'jobId', 'batchId', 'expectedRevision']) && dto.isCollectionId(v.batchId) && dto.isLocalCatalogRevision(v.expectedRevision);
    case 'abandon-batch': return closed(v, ['commandId','jobId','batchId','expectedRevision','reason']) && dto.isCollectionId(v.batchId) && dto.isLocalCatalogRevision(v.expectedRevision) && v.reason === 'CONTENT_CHANGED';
    case 'fail': return closed(v,['commandId','jobId','expectedRevision','code']) && dto.isLocalCatalogRevision(v.expectedRevision) && ['ROOT_UNAVAILABLE','ROOT_REVISION_CHANGED','SCAN_READ_FAILED','CHECKPOINT_INVALID'].includes(String(v.code));
    case 'recover': return closed(v, ['commandId', 'jobId', 'expectedRevision', 'cause']) && dto.isLocalCatalogRevision(v.expectedRevision) && (v.cause === 'cold-open' || v.cause === 'restore');
    case 'pause': case 'resume': case 'cancel': return closed(v, ['commandId', 'jobId', 'expectedRevision']) && dto.isLocalCatalogRevision(v.expectedRevision);
    default: return false;
  }
}
function parse<T>(v: unknown, guard: (v: unknown) => v is T, limit = 8 * 1024 * 1024): T {
  if (typeof v !== 'string' || Buffer.byteLength(v) > limit) return corrupt();
  const value: unknown = JSON.parse(v); return guard(value) ? value : corrupt();
}
const budgets: Readonly<Record<Table, number>> = { local_scan_jobs: 100_000, local_scan_batches: 3_000_000,
  local_scan_checkpoints: 3_000_000, local_scan_file_state: 600_000, local_scan_receipts: 12_000_000, local_cue_sources: 3_000_000, local_cue_tracks: 12_000_000 };

interface ScanAuditCertificate { rows: ReadonlyMap<Table, number>; bytes: number; dataVersion: number }
const scanAudits = new WeakMap<DatabaseSync, ScanAuditCertificate>();
const scanDataVersion = (db: DatabaseSync): number => Number(db.prepare('PRAGMA data_version').get()?.data_version);
const scanRowBytes = (row: Row): number => Object.values(row).reduce<number>((n, v) => n + (typeof v === 'string' ? Buffer.byteLength(v) : 0), 0);
const checkScanBudget = (domain: string, actual: number, limit: number): void => {
  if (!Number.isSafeInteger(actual) || actual < 0) return corrupt();
  if (actual > limit) throw new LocalCatalogBudgetError(`扫描${domain}`, actual, limit);
};
/** 只累计受影响行的资源变化；候选certificate仅在外围事务真实COMMIT后发布。 */
function scanAuditFor(db: DatabaseSync) {
  const previous = scanAudits.get(db);
  if (!previous || previous.dataVersion !== scanDataVersion(db) || db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1) return corrupt();
  const rows = new Map(previous.rows); let bytes = previous.bytes;
  return {
    replace(table: Table, before: Row | null, after: Row): void {
      const afterBytes = scanRowBytes(after); checkScanBudget(`${table}单行文本字节`, afterBytes, 16 * 1024 * 1024);
      const count = (rows.get(table) ?? 0) + (before ? 0 : 1); checkScanBudget(`${table}行数`, count, budgets[table]); rows.set(table, count);
      bytes += afterBytes - (before ? scanRowBytes(before) : 0); checkScanBudget('全域文本字节', bytes, 64 * 1024 * 1024 * 1024);
    },
    publish(): void { if (scanDataVersion(db) !== previous.dataVersion) return corrupt(); scanAudits.set(db, { rows, bytes, dataVersion: previous.dataVersion }); },
  };
}
type ScanAudit = ReturnType<typeof scanAuditFor>;
/** 新源作者只更新真实已存文件行，原job/batch外键和冻结历史保留；外围真实COMMIT后才发布计数证书。 */
export function updateSourceWriteScanFacts(db:DatabaseSync,rootId:string,relative:string,jobId:string,batchId:string,before:string,after:string):()=>void{
  const row=db.prepare('SELECT * FROM local_scan_file_state WHERE library_root_id=? AND relative=?').get(rootId,relative);if(!row||row.job_id!==jobId||row.batch_id!==batchId||row.data!==before)return corrupt();
  const first=parse(before,isScanFileState,65536),next=parse(after,isScanFileState,65536);if(next.libraryRootId!==rootId||next.relative!==relative||next.assetId!==first.assetId||next.trackId!==first.trackId||next.parserVersion!==first.parserVersion||next.outcome!=='accepted'||next.failureCode!==null||!next.readFacts)return corrupt();
  const audit=scanAuditFor(db);const changed=db.prepare('UPDATE local_scan_file_state SET data=? WHERE library_root_id=? AND relative=? AND job_id=? AND batch_id=? AND data=?').run(after,rootId,relative,jobId,batchId,before);if(changed.changes!==1)return corrupt();audit.replace('local_scan_file_state',row,db.prepare('SELECT * FROM local_scan_file_state WHERE library_root_id=? AND relative=?').get(rootId,relative)!);return ()=>audit.publish();
}
function sourceUpdatedScanState(db:DatabaseSync,row:Row,initial:ScanFileState):ScanFileState|null{
  const projection=sourceWritesProjectionForDatabase(db);if(!projection)return null;let previous=initial,found=false;
  for(const event of projection.events){if(event.kind!=='facts'||event.fact.scanJobId!==row.job_id||event.fact.scanBatchId!==row.batch_id)continue;const f=event.fact,next=parse(f.scanAfter,isScanFileState,65536),before=parse(f.scanBefore,isScanFileState,65536);if(next.libraryRootId!==row.library_root_id||next.relative!==row.relative)continue;if(!equal(before,previous)||next.assetId!==initial.assetId||next.trackId!==initial.trackId||next.parserVersion!==initial.parserVersion)return corrupt();previous=next;found=true;}
  return found?previous:null;
}

/** 冷开、迁移及隔离备份/恢复全量流式核验；热批提交不调用此函数。 */
export function verifyLocalScanDatabase(db: DatabaseSync): void {
  scanAudits.delete(db); const initialVersion = scanDataVersion(db); const counts = new Map<Table, number>(); let bytes = 0;
  if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').get()) return corrupt();
  for (const [name, sql] of Object.entries(tables)) if (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name)?.sql !== sql) return corrupt();
  for (const [type, statements] of [['index', indexes], ['trigger', triggers]] as const) for (const sql of statements) {
    const name = sql.split(' ')[2]!; if (db.prepare('SELECT sql FROM sqlite_master WHERE type=? AND name=?').get(type, name)?.sql !== sql) return corrupt();
  }
  const hasCue=cueSchema(db);
  for (const table of [...Object.keys(tables),...(hasCue ? Object.keys(cueTables):[])] as Table[]) {
    const count = Number(db.prepare(`SELECT count(*) n FROM ${table}`).get()?.n); checkScanBudget(`${table}行数`, count, budgets[table]); counts.set(table, count);
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().filter(c => c.type === 'TEXT').map(c => String(c.name));
    const size = columns.map(c => `COALESCE(length(CAST(${c} AS BLOB)),0)`).join('+');
    const resources = db.prepare(`SELECT COALESCE(max(${size}),0) largest,COALESCE(sum(${size}),0) bytes FROM ${table}`).get()!;
    checkScanBudget(`${table}单行文本字节`, Number(resources.largest), 16 * 1024 * 1024); bytes += Number(resources.bytes);
  }
  checkScanBudget('全域文本字节', bytes, 64 * 1024 * 1024 * 1024);
  const jobs = new Map<string, dto.ScanJobRecord>();
  const latest = new Map<string, dto.ScanJobRecord>();
  for (const row of db.prepare('SELECT * FROM local_scan_jobs ORDER BY rowid').iterate()) {
    const job = parse(row.data, dto.isScanJobRecord, 65_536);
    if (row.id !== job.jobId || row.dataset_id !== job.datasetId || row.library_root_id !== job.libraryRootId
      || row.source_root_id !== job.sourceRootId || !text(row.parser_version)) return corrupt();
    // 历史任务不要求来源仍授权；当前根可以已重关联，恢复不能复活旧许可。
    if (!db.prepare('SELECT id FROM local_catalog_roots WHERE id=?').get(job.libraryRootId)
      || !db.prepare('SELECT id FROM source_roots WHERE id=?').get(job.sourceRootId)) return corrupt();
    jobs.set(job.jobId, job);
  }
  for (const row of db.prepare('SELECT * FROM local_scan_receipts ORDER BY rowid').iterate()) {
    const operation = row.operation as ScanReceiptOperation;
    const request = parse(row.request, (v): v is Row & { commandId: string; jobId: string } => isScanReceiptRequest(operation, v));
    const result = parse(row.result, dto.isScanJobRecord, 65_536), current = jobs.get(result.jobId), previous = latest.get(result.jobId);
    if (row.command_id !== request.commandId || row.job_id !== request.jobId || result.jobId !== request.jobId
      || !hash(row.fingerprint) || row.fingerprint !== scanFingerprint(operation, request) || !current
      || result.datasetId !== current.datasetId || result.libraryRootId !== current.libraryRootId || result.sourceRootId !== current.sourceRootId
      || result.rootRevision !== current.rootRevision || !text(row.created_at) || !Number.isFinite(Date.parse(row.created_at))) return corrupt();
    if (!previous) {
      if (operation !== 'start' || result.jobRevision !== '1' || result.phase !== 'pending' || result.checkpointRef !== null) return corrupt();
    } else if ((operation === 'prepare-batch' || operation === 'abandon-batch')) {
      if (!equal(previous, result)) return corrupt();
    } else if (BigInt(result.jobRevision) !== BigInt(previous.jobRevision) + 1n) return corrupt();
    if (previous && operation !== 'prepare-batch' && operation !== 'start' && request.expectedRevision !== previous.jobRevision) return corrupt();
    if (operation === 'start' && (request.datasetId !== result.datasetId || request.libraryRootId !== result.libraryRootId || request.expectedRootRevision !== result.rootRevision)) return corrupt();
    if (operation === 'prepare-batch' && record(request.batch) && request.batch.expectedJobRevision !== result.jobRevision) return corrupt();
    if (operation === 'pause' && result.phase !== 'paused' || operation === 'resume' && result.phase !== 'running'
      || operation === 'cancel' && result.phase !== 'cancelled' || operation === 'recover' && result.phase !== 'paused'
      || operation === 'fail' && (result.phase !== 'failed' || result.failureCode !== request.code)) return corrupt();
    if (operation === 'abandon-batch') {
      if (!dto.isCollectionId(request.batchId)) return corrupt();
      const abandoned = db.prepare("SELECT request FROM local_scan_batches WHERE id=? AND job_id=? AND phase='prepared'").get(request.batchId,result.jobId);
      if (!abandoned || parse(abandoned.request,isScanPreparedBatch).checkpointBefore !== result.checkpointRef) return corrupt();
    }
    latest.set(result.jobId, result);
  }
  for (const [id, job] of jobs) if (!equal(job, latest.get(id))) return corrupt();
  for (const row of db.prepare('SELECT * FROM local_scan_batches ORDER BY rowid').iterate()) {
    const batch = parse(row.request, isScanPreparedBatch), job = jobs.get(batch.jobId);
    if(batch.kind === 'cue-sidecars-v1' && !hasCue) return corrupt();
    const parserVersion = job ? db.prepare('SELECT parser_version FROM local_scan_jobs WHERE id=?').get(job.jobId)?.parser_version : undefined;
    if (!job || row.id !== batch.batchId || row.job_id !== batch.jobId || row.fingerprint !== scanFingerprint('batch', batch)
      || batch.items.some(item => item.parserVersion !== parserVersion)) return corrupt();
    if (batch.checkpointBefore !== null && !db.prepare('SELECT id FROM local_scan_checkpoints WHERE id=? AND job_id=?').get(batch.checkpointBefore, job.jobId)) return corrupt();
    const prepared = db.prepare("SELECT request FROM local_scan_receipts WHERE job_id=? AND operation='prepare-batch' AND json_extract(request,'$.batch.batchId')=?").get(job.jobId, batch.batchId);
    if (!prepared || !equal(parse(prepared.request, (v): v is Row & { commandId: string; jobId: string } => isScanReceiptRequest('prepare-batch', v)).batch, batch)) return corrupt();
    if (row.phase === 'prepared') { if (row.result !== null) return corrupt(); }
    else if (row.phase === 'committed') {
      const committedBatch = parse(row.result, isScanCommittedBatch), result = committedBatch.job;
      if(batch.kind === 'cue-sidecars-v1') verifyCueBatch(db,batch,committedBatch,job);
      else if(committedBatch.kind !== undefined) return corrupt();
      if (committedBatch.files.length !== batch.items.length) return corrupt();
      for (const [index, item] of batch.items.entries()) {
        const file = committedBatch.files[index]!;
        if (file.libraryRootId !== job.libraryRootId || file.relative !== item.relative || file.signature !== item.signature
          || file.parserVersion !== item.parserVersion || file.outcome !== item.outcome || file.failureCode !== item.failureCode
          || !item.reused && !equal(file.readFacts, item.readFacts)) return corrupt();
        const registered = db.prepare('SELECT request,result FROM local_catalog_ledger WHERE command_id=? AND operation=?').get(childCommand(batch.batchId, index, 'register-asset'), 'register-asset');
        const replaced = db.prepare('SELECT request,result FROM local_catalog_ledger WHERE command_id=? AND operation=?').get(childCommand(batch.batchId, index, 'replace-asset'), 'replace-asset');
        if (registered || replaced) {
          const child = registered ?? replaced!; const childRequest = JSON.parse(String(child.request)) as Row;
          const childAsset = parse(child.result, dto.isAudioAsset);
          if (item.outcome !== 'accepted' || item.reused || childAsset.id !== file.assetId || childRequest.libraryRootId !== job.libraryRootId
            || childRequest.expectedRootRevision !== job.rootRevision || childRequest.relative !== item.relative || childRequest.sha256 !== null
            || childRequest.sampleFrames !== null || childRequest.timebaseHz !== null) return corrupt();
          if (registered) {
            const created = db.prepare('SELECT result FROM local_catalog_ledger WHERE command_id=? AND operation=?').get(childCommand(batch.batchId, index, 'create-track'), 'create-track');
            if (!created) return corrupt(); const track = parse(created.result, dto.isLocalTrack);
            if (track.id !== file.trackId || track.assetId !== file.assetId || track.segment !== null) return corrupt();
          }
        }
        const observed = db.prepare('SELECT result FROM local_catalog_ledger WHERE command_id=? AND operation=?').get(childCommand(batch.batchId, index, 'observe-metadata'), 'observe-metadata');
        if (observed) { const value = parse(observed.result, dto.isLocalMetadataObservation);
          if (item.outcome !== 'accepted' || item.reused || value.trackId !== file.trackId || value.source !== 'tag'
            || value.parserVersion !== item.parserVersion || !equal(value.fields, item.fields)) return corrupt();
        }
      }
      const checkpoint = db.prepare('SELECT * FROM local_scan_checkpoints WHERE batch_id=? AND job_id=?').get(batch.batchId, batch.jobId);
      if (!checkpoint || result.jobId !== batch.jobId || result.checkpointRef !== checkpoint.id
        || batch.completed !== (result.phase === 'completed')) return corrupt();
      const committed = db.prepare("SELECT request,result FROM local_scan_receipts WHERE job_id=? AND operation='commit-batch' AND json_extract(request,'$.batchId')=?").get(batch.jobId, batch.batchId);
      if (!committed || !equal(parse(committed.result, dto.isScanJobRecord), result)) return corrupt();
      const committedRequest = parse(committed.request, (v): v is Row & { commandId: string; jobId: string } => isScanReceiptRequest('commit-batch', v));
      if (BigInt(result.jobRevision) !== BigInt(String(committedRequest.expectedRevision)) + 1n) return corrupt();
    } else return corrupt();
  }
  for (const row of db.prepare('SELECT * FROM local_scan_checkpoints ORDER BY rowid').iterate()) {
    const checkpoint = parse(row.data, isScanCheckpoint);
    const batchRow = db.prepare("SELECT request,result FROM local_scan_batches WHERE id=? AND job_id=? AND phase='committed'").get(checkpoint.batchId, checkpoint.jobId);
    if (!batchRow || row.id !== checkpoint.checkpointId || row.job_id !== checkpoint.jobId || row.batch_id !== checkpoint.batchId) return corrupt();
    const batch = parse(batchRow.request, isScanPreparedBatch), result = parse(batchRow.result, isScanCommittedBatch).job;
    if (!equal(batch.frontier, checkpoint.frontier) || !equal(result.progress, checkpoint.progress) || result.checkpointRef !== checkpoint.checkpointId) return corrupt();
    const prior = batch.checkpointBefore === null ? null : db.prepare('SELECT data FROM local_scan_checkpoints WHERE id=?').get(batch.checkpointBefore);
    const previous = prior ? parse(prior.data, isScanCheckpoint) : null;
    const counted=batchCount(batch), accepted = BigInt(counted.filter(item => item.outcome === 'accepted').length), rejected = BigInt(counted.length) - accepted;
    if (BigInt(checkpoint.sequence) !== (previous ? BigInt(previous.sequence) : 0n) + 1n
      || BigInt(checkpoint.progress.visited) !== (previous ? BigInt(previous.progress.visited) : 0n) + BigInt(counted.length)
      || BigInt(checkpoint.progress.accepted) !== (previous ? BigInt(previous.progress.accepted) : 0n) + accepted
      || BigInt(checkpoint.progress.rejected) !== (previous ? BigInt(previous.progress.rejected) : 0n) + rejected) return corrupt();
  }
  for (const job of jobs.values()) if (job.checkpointRef !== null) {
    const checkpoint = db.prepare('SELECT data FROM local_scan_checkpoints WHERE id=? AND job_id=?').get(job.checkpointRef, job.jobId);
    if (!checkpoint || !equal(parse(checkpoint.data, isScanCheckpoint).progress, job.progress)) return corrupt();
  }
  for (const row of db.prepare('SELECT * FROM local_scan_file_state ORDER BY rowid').iterate()) {
    const state = parse(row.data, isScanFileState, 65_536), job = jobs.get(String(row.job_id));
    const batchRow = db.prepare("SELECT request,result FROM local_scan_batches WHERE id=? AND job_id=? AND phase='committed'").get(String(row.batch_id), String(row.job_id));
    if (!job || !batchRow || row.library_root_id !== state.libraryRootId || state.libraryRootId !== job.libraryRootId
      || row.relative !== state.relative || row.asset_id !== state.assetId || row.track_id !== state.trackId) return corrupt();
    const committedFile = parse(batchRow.result, isScanCommittedBatch).files.find(file => file.relative === state.relative);
    if (!committedFile || !equal(committedFile, state)&&!equal(sourceUpdatedScanState(db,row,committedFile),state)) return corrupt();
    const item = parse(batchRow.request, isScanPreparedBatch).items.find(item => item.relative === state.relative);
    if (!item || item.signature !== committedFile.signature || item.parserVersion !== state.parserVersion || item.outcome !== state.outcome || item.failureCode !== state.failureCode) return corrupt();
    if (state.outcome === 'accepted') {
      const asset = db.prepare('SELECT root_id,relative FROM local_catalog_assets WHERE id=?').get(state.assetId!);
      const track = db.prepare('SELECT asset_id FROM local_catalog_tracks WHERE id=?').get(state.trackId!);
      // 后续人工选择/重定位不会改写扫描历史；仅核稳定实体仍存在。
      if (!asset || !track) return corrupt();
    }
  }
  if(hasCue) {
    const priorCue=new Map<string,CueSnapshot>();
    for(const row of db.prepare('SELECT * FROM local_cue_sources ORDER BY rowid').iterate()) {
      const snapshot=parse(row.data,isCueSnapshot),parent=db.prepare("SELECT request,result FROM local_scan_batches WHERE id=? AND phase='committed'").get(String(row.batch_id));
      if(!parent || snapshot.id !== row.id || snapshot.sidecarId !== row.sidecar_id || snapshot.libraryRootId !== row.library_root_id || snapshot.item.relative !== row.relative) return corrupt();
      const key=scanCanonical([snapshot.libraryRootId,snapshot.item.relative]),prior=priorCue.get(key);
      if(snapshot.item.previousSnapshotId !== (prior?.id ?? null) || prior && snapshot.sidecarId !== prior.sidecarId || snapshot.item.reused) return corrupt();priorCue.set(key,snapshot);
      const batch=parse(parent.request,isScanPreparedBatch),result=parse(parent.result,isScanCommittedBatch),job=jobs.get(batch.jobId);
      if(!job || batch.kind !== 'cue-sidecars-v1' || !result.cueSnapshotIds?.includes(snapshot.id)) return corrupt();verifyCueBatch(db,batch,result,job);
      if(snapshot.item.result?.tracks.some(track=>track.assetReference.libraryRootId !== snapshot.libraryRootId || track.assetReference.sourceRootId !== snapshot.sourceRootId || track.assetReference.rootRevision !== snapshot.rootRevision)) return corrupt();
    }
    for(const row of db.prepare('SELECT * FROM local_cue_tracks ORDER BY rowid').iterate()) {
      const source=db.prepare('SELECT data FROM local_cue_sources WHERE id=?').get(String(row.snapshot_id));if(!source) return corrupt();
      const tracks=parse(source.data,isCueSnapshot).item.result?.tracks ?? [];
      if(typeof row.ordinal !== 'number' || !Number.isSafeInteger(row.ordinal) || row.ordinal<0 || row.ordinal>=tracks.length
        || row.asset_id !== tracks[row.ordinal]!.assetReference.assetId || !equal(JSON.parse(String(row.data)),tracks[row.ordinal])) return corrupt();
    }
  }
  if (scanDataVersion(db) !== initialVersion) return corrupt();
  scanAudits.set(db, { rows: counts, bytes, dataVersion: initialVersion });
}

/** 冷恢复只把未完成的 running 暂停；保留批、checkpoint、实体与全部旧回执。调用者持有原事务。 */
export function recoverLocalScanJobs(db: DatabaseSync, cause: 'cold-open' | 'restore'): () => void {
  const audit = scanAuditFor(db);
  for (const row of db.prepare("SELECT * FROM local_scan_jobs WHERE json_extract(data,'$.phase')='running' ORDER BY rowid").iterate()) {
    const previous = parse(row.data, dto.isScanJobRecord, 65_536);
    const revision = (BigInt(previous.jobRevision) + 1n).toString();
    if (!dto.isLocalCatalogRevision(revision)) return corrupt();
    const result: dto.ScanJobRecord = { ...previous, jobRevision: revision, phase: 'paused', failureCode: null };
    const request = { commandId: randomUUID(), jobId: previous.jobId, expectedRevision: previous.jobRevision, cause };
    db.prepare('UPDATE local_scan_jobs SET data=? WHERE id=?').run(JSON.stringify(result), previous.jobId);
    db.prepare('INSERT INTO local_scan_receipts(command_id,job_id,operation,fingerprint,request,result,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(request.commandId, previous.jobId, 'recover', scanFingerprint('recover', request), JSON.stringify(request), JSON.stringify(result), new Date().toISOString());
    audit.replace('local_scan_jobs', row, db.prepare('SELECT * FROM local_scan_jobs WHERE id=?').get(previous.jobId)!);
    audit.replace('local_scan_receipts', null, db.prepare('SELECT * FROM local_scan_receipts WHERE command_id=?').get(request.commandId)!);
  }
  return () => audit.publish();
}

interface ScanAccess {
  read<T>(operation: (db: DatabaseSync) => T): T;
  catalog: import('./local-catalog-store.js').LocalCatalogStore;
  sources: Pick<import('../recording/source-store.js').SourceStore, 'root'>;
  conflict(message: string): never;
  beforeCommit?: (action: string) => void;
}
interface ScanTransition { commandId: string; jobId: string; expectedRevision: string }
interface StartScan { commandId: string; datasetId: string; libraryRootId: string; expectedRootRevision: string; parserVersion: string }
const childCommand = (batchId: string, index: number, operation: string): string => {
  const digest = createHash('sha256').update(scanCanonical(['mbrs003-subcommand-v1', batchId, index, operation])).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
};
export function createLocalScanStore(access: ScanAccess) {
  const get = (db: DatabaseSync, jobId: string): dto.ScanJobRecord => {
    if (!dto.isCollectionId(jobId)) return access.conflict('扫描任务身份无效。');
    const row = db.prepare('SELECT data FROM local_scan_jobs WHERE id=?').get(jobId);
    return row ? parse(row.data, dto.isScanJobRecord, 65_536) : access.conflict('扫描任务不存在。');
  };
  /** 旧路径事实保留；只有当前catalog locator与既有file-state共同指向唯一对象才复用稳定ID。 */
  function currentFileState(db: DatabaseSync, libraryRootId: string, relative: string): Row | null {
    const locators = db.prepare('SELECT id FROM local_catalog_assets WHERE root_id=? AND relative=? LIMIT 2').all(libraryRootId,relative);
    if(locators.length>1) return access.conflict('当前位置有多个独立资产，不能根据同名或路径自动合并。');
    const direct = db.prepare('SELECT * FROM local_scan_file_state WHERE library_root_id=? AND relative=?').get(libraryRootId, relative);
    if (direct) {
      const state = parse(direct.data, isScanFileState, 65_536);
      if (state.assetId === null) return direct;
      const locator = db.prepare('SELECT root_id,relative FROM local_catalog_assets WHERE id=?').get(state.assetId);
      if (locator?.root_id === libraryRootId && locator.relative === relative) return direct;
    }
    if (locators.length === 0) return null;
    // 两行sentinel拒歧义；root/relative及asset_id均为私有索引，不能每个新path全库回放。
    const rows = db.prepare(`SELECT s.* FROM local_catalog_assets a JOIN local_scan_file_state s ON s.asset_id=a.id
      WHERE a.root_id=? AND a.relative=? AND s.library_root_id=? AND s.track_id IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM local_scan_file_state newer WHERE newer.asset_id=s.asset_id AND newer.track_id=s.track_id AND newer.rowid>s.rowid)
      ORDER BY s.rowid DESC LIMIT 2`).all(libraryRootId, relative, libraryRootId);
    if (rows.length > 1) return access.conflict('当前文件位置存在多个独立资产或曲目候选，不能自动合并。');
    if (!rows[0]) return null;
    const state = parse(rows[0].data, isScanFileState, 65_536);
    if (state.libraryRootId !== libraryRootId || state.assetId === null || state.trackId === null) return corrupt();
    return rows[0];
  }
  function current(job: dto.ScanJobRecord): dto.LibraryRoot {
    const root = access.catalog.root(job.libraryRootId);
    if (root.revision !== job.rootRevision || root.sourceRootId !== job.sourceRootId) return access.conflict('扫描根关联已改变，现有checkpoint和目录数据保留。');
    if (!access.sources.root(root.sourceRootId).authorized) return access.conflict('扫描来源许可已撤销，现有目录数据保留。');
    return root;
  }
  function savedReceipt(db: DatabaseSync, operation: ScanReceiptOperation, request: Row & { commandId: string; jobId: string }): dto.ScanJobRecord | null {
    const row = db.prepare('SELECT * FROM local_scan_receipts WHERE command_id=?').get(request.commandId);
    if (!row) return null;
    if (row.job_id !== request.jobId || row.operation !== operation || row.fingerprint !== scanFingerprint(operation, request)
      || !equal(parse(row.request, (v): v is Row & { commandId: string; jobId: string } => isScanReceiptRequest(operation, v)), request)) return access.conflict('同一操作编号不能复用于不同扫描请求。');
    const result = parse(row.result, dto.isScanJobRecord, 65_536); if (result.jobId !== request.jobId) return corrupt(); return result;
  }
  function putReceipt(db: DatabaseSync, operation: ScanReceiptOperation, request: Row & { commandId: string; jobId: string }, result: dto.ScanJobRecord, audit: ScanAudit): void {
    if (!isScanReceiptRequest(operation, request) || !dto.isScanJobRecord(result) || result.jobId !== request.jobId) return corrupt();
    db.prepare('INSERT INTO local_scan_receipts(command_id,job_id,operation,fingerprint,request,result,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(request.commandId, request.jobId, operation, scanFingerprint(operation, request), JSON.stringify(request), JSON.stringify(result), new Date().toISOString());
    audit.replace('local_scan_receipts', null, db.prepare('SELECT * FROM local_scan_receipts WHERE command_id=?').get(request.commandId)!);
    const actual = savedReceipt(db, operation, request); if (!equal(actual, result)) return corrupt();
  }
  const revision = (job: dto.ScanJobRecord): string => {
    const value = (BigInt(job.jobRevision) + 1n).toString(); return dto.isLocalCatalogRevision(value) ? value : corrupt();
  };
  function transaction<T>(operation: string, body: (db: DatabaseSync, audit: ScanAudit) => T): T {
    return access.read(db => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const audit = scanAuditFor(db), result = body(db, audit); if (result instanceof Promise) return corrupt();
        access.beforeCommit?.(`local-scan:${operation}`); db.exec('COMMIT'); audit.publish(); return result;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    });
  }
  function transition(operation: 'pause' | 'resume' | 'cancel', request: ScanTransition): dto.ScanJobRecord {
    if (!isScanReceiptRequest(operation, request)) return access.conflict('扫描状态请求无效。');
    return transaction(operation, (db, audit) => {
      const previous = savedReceipt(db, operation, request); if (previous) return previous;
      const job = get(db, request.jobId);
      if (job.jobRevision !== request.expectedRevision) return access.conflict('扫描任务修订已改变。');
      if (job.phase === 'completed' || job.phase === 'cancelled' || job.phase === 'failed') return access.conflict('终态扫描任务不能继续改变状态。');
      if (operation === 'resume') current(job);
      const result: dto.ScanJobRecord = { ...job, jobRevision: revision(job), phase: operation === 'pause' ? 'paused' : operation === 'cancel' ? 'cancelled' : 'running', failureCode: null };
      const before = db.prepare('SELECT * FROM local_scan_jobs WHERE id=?').get(job.jobId)!;
      db.prepare('UPDATE local_scan_jobs SET data=? WHERE id=?').run(JSON.stringify(result), job.jobId);
      audit.replace('local_scan_jobs', before, db.prepare('SELECT * FROM local_scan_jobs WHERE id=?').get(job.jobId)!);
      putReceipt(db, operation, request, result, audit); return result;
    });
  }
  return {
    start(request: StartScan): { job: dto.ScanJobRecord; created: boolean } {
      if (!record(request) || !closed(request, ['commandId', 'datasetId', 'libraryRootId', 'expectedRootRevision', 'parserVersion'])
        || !dto.isCollectionId(request.commandId) || !dto.isCollectionId(request.datasetId) || !dto.isCollectionId(request.libraryRootId)
        || !dto.isLocalCatalogRevision(request.expectedRootRevision) || !text(request.parserVersion)) return access.conflict('扫描创建请求无效。');
      return transaction('start', (db, audit) => {
        const previous = db.prepare('SELECT request FROM local_scan_receipts WHERE command_id=?').get(request.commandId);
        const jobId = previous ? parse(previous.request, (v): v is Row & { commandId: string; jobId: string } => isScanReceiptRequest('start', v)).jobId : randomUUID();
        const full = { ...request, jobId }, saved = savedReceipt(db, 'start', full); if (saved) return { job: saved, created: false };
        const root = access.catalog.root(request.libraryRootId);
        if (root.revision !== request.expectedRootRevision || !access.sources.root(root.sourceRootId).authorized) return access.conflict('扫描根修订或许可已改变。');
        const job: dto.ScanJobRecord = { schemaVersion: '1.2', jobId, datasetId: request.datasetId, libraryRootId: root.id,
          sourceRootId: root.sourceRootId, rootRevision: root.revision, jobRevision: '1', checkpointRef: null,
          progress: { visited: '0', accepted: '0', rejected: '0' }, phase: 'pending', failureCode: null };
        db.prepare('INSERT INTO local_scan_jobs VALUES(?,?,?,?,?,?)').run(jobId, job.datasetId, root.id, root.sourceRootId, request.parserVersion, JSON.stringify(job));
        audit.replace('local_scan_jobs', null, db.prepare('SELECT * FROM local_scan_jobs WHERE id=?').get(jobId)!);
        putReceipt(db, 'start', full, job, audit); return { job, created: true };
      });
    },
    get(jobId: string): dto.ScanJobRecord { return access.read(db => get(db, jobId)); },
    page(datasetId: string, page: dto.PageRequest): dto.Page<dto.ScanJobRecord> {
      if (!dto.isCollectionId(datasetId) || !record(page) || !closed(page, ['offset', 'limit']) || !Number.isSafeInteger(page.offset)
        || page.offset < 0 || !Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 200) return access.conflict('扫描分页请求无效。');
      return access.read(db => {
        const total = Number(db.prepare('SELECT count(*) n FROM local_scan_jobs WHERE dataset_id=?').get(datasetId)?.n);
        const items = db.prepare('SELECT data FROM local_scan_jobs WHERE dataset_id=? ORDER BY rowid LIMIT ? OFFSET ?').all(datasetId, page.limit, page.offset).map(row => parse(row.data, dto.isScanJobRecord, 65_536));
        return { ...page, total, items, hasMore: page.offset + items.length < total };
      });
    },
    pause(request: ScanTransition) { return transition('pause', request); },
    resume(request: ScanTransition) { return transition('resume', request); },
    cancel(request: ScanTransition) { return transition('cancel', request); },
    receipt(commandId: string): dto.LocalScanReceipt | null {
      if (!dto.isCollectionId(commandId)) return access.conflict('扫描回执身份无效。');
      return access.read(db => {
        const row = db.prepare('SELECT * FROM local_scan_receipts WHERE command_id=?').get(commandId); if (!row) return null;
        const operation = row.operation as ScanReceiptOperation;
        // 私有故障/弃批回执只供同owner冷核验和内部重试，不扩公开回执operation。
        if (operation === 'abandon-batch' || operation === 'fail') return null;
        const request = parse(row.request, (v): v is Row & { commandId: string; jobId: string } => isScanReceiptRequest(operation, v));
        const result = savedReceipt(db, operation, request);
        const receipt = { commandId, jobId: request.jobId, operation, fingerprint: String(row.fingerprint), result };
        return dto.isLocalScanReceipt(receipt) ? receipt : corrupt();
      });
    },
    privateCheckpoint(jobId: string): ScanCheckpoint | null {
      return access.read(db => {
        const job = get(db, jobId); if (job.checkpointRef === null) return null;
        const row = db.prepare('SELECT data FROM local_scan_checkpoints WHERE id=? AND job_id=?').get(job.checkpointRef, jobId);
        return row ? parse(row.data, isScanCheckpoint) : corrupt();
      });
    },
    privateFileState(libraryRootId: string, relative: string): { jobId: string; value: ScanFileState } | null {
      if (!dto.isCollectionId(libraryRootId) || !scanRelativePath(relative)) return access.conflict('扫描文件状态身份无效。');
      return access.read(db => {
        const row = db.prepare('SELECT job_id,data FROM local_scan_file_state WHERE library_root_id=? AND relative=?').get(libraryRootId, relative);
        return row ? { jobId: String(row.job_id), value: parse(row.data, isScanFileState, 65_536) } : null;
      });
    },
    /** 新作者只消费真实原行及原 job/batch 身份，不能伪造扫描任务。 */
    privateSourceWriteFileState(libraryRootId:string,relative:string):{jobId:string;batchId:string;data:string;value:ScanFileState}|null{
      if(!dto.isCollectionId(libraryRootId)||!scanRelativePath(relative))return access.conflict('源写扫描身份无效。');
      return access.read(db=>{installSourceWriteScanPort(db,(...args)=>updateSourceWriteScanFacts(db,...args));const row=currentFileState(db,libraryRootId,relative);if(!row)return null;return {jobId:String(row.job_id),batchId:String(row.batch_id),data:String(row.data),value:parse(row.data,isScanFileState)};});
    },
    /** 增量读取资格与原path历史事实查询分开；只此接点受当前locator约束。 */
    privateCurrentFileState(libraryRootId: string, relative: string): { jobId: string; value: ScanFileState } | null {
      if (!dto.isCollectionId(libraryRootId) || !scanRelativePath(relative)) return access.conflict('扫描文件状态身份无效。');
      return access.read(db => {
        const row = currentFileState(db, libraryRootId, relative);
        return row ? { jobId: String(row.job_id), value: parse(row.data, isScanFileState, 65_536) } : null;
      });
    },
    /** 详情只读当前已证明的解析参数；不分配FD、媒体票据或排他锁。修订无法证明时返回未知。 */
    privateDisplayFileParameters(trackId: string, asset: dto.AudioAsset): dto.FileAudioParameters | null {
      if (!dto.isCollectionId(trackId) || !dto.isAudioAsset(asset)) return access.conflict('详情参数逻辑身份无效。');
      const selected = access.catalog.track(trackId), locator = access.catalog.privateAssetLocator(asset.id), root = access.catalog.root(asset.libraryRootId), source = access.sources.root(root.sourceRootId);
      if (selected.assetId !== asset.id || !equal(locator.asset, asset) || root.revision !== asset.rootRevision || root.sourceRootId !== asset.sourceRootId || source.authorized !== true) return null;
      return access.read(db => {
        const row = currentFileState(db, root.id, locator.relative); if (!row) return null;
        const state = parse(row.data, isScanFileState), job = get(db, String(row.job_id));
        if (state.outcome !== 'accepted' || state.assetId !== asset.id || state.trackId !== trackId || state.relative !== locator.relative || state.libraryRootId !== root.id
          || job.rootRevision !== root.revision || job.sourceRootId !== source.id || !state.readFacts) return null;
        const sourceFact=sourceWritesProjectionForDatabase(db)?.scanFacts.get(`${root.id}/${locator.relative}`)?.fact;
        if(sourceFact&&sourceFact.scanAfter===row.data&&equal(sourceFact.afterAsset,asset)&&sourceFact.affectedTrackIds.includes(trackId)){
          const technical=state.readFacts.technical,parameters={container:technical.container,codec:technical.codec,lossless:technical.lossless,sampleRateHz:technical.sampleRateHz,channels:technical.channels,bitsPerSample:technical.bitsPerSample,durationMs:technical.durationSeconds===null?null:Math.round(technical.durationSeconds*1000),evidence:technical.evidence};return dto.isFileAudioParameters(parameters)?parameters:null;
        }
        const batchRow = db.prepare("SELECT request FROM local_scan_batches WHERE id=? AND phase='committed'").get(String(row.batch_id));
        if (!batchRow) return null;
        const batch = parse(batchRow.request, isScanPreparedBatch), index = batch.items.findIndex(item => item.relative === locator.relative), item = batch.items[index];
        if (!item || item.signature !== state.signature || !item.reused && !equal(item.readFacts, state.readFacts)) return null;
        // 无变化的增量批不会重建资产。沿有界已提交批核对最初绑定的资产修订，不能借用另一个文件的参数。
        const origins = db.prepare(`SELECT b.request,j.data AS job_data FROM local_scan_batches b
          JOIN local_scan_jobs j ON j.id=b.job_id JOIN json_each(b.result,'$.files') f
          WHERE b.phase='committed' AND j.library_root_id=@root
            AND json_extract(f.value,'$.assetId')=@asset AND json_extract(f.value,'$.trackId')=@track
            AND json_extract(f.value,'$.relative')=@relative AND json_extract(f.value,'$.signature')=@signature
            AND json_extract(b.request,'$.items[' || f.key || '].reused')=0
          ORDER BY b.rowid DESC LIMIT 200`).iterate({root:root.id,asset:asset.id,track:trackId,relative:locator.relative,signature:state.signature});
        let provenCurrent = false;
        for (const origin of origins) {
          const original = parse(origin.request, isScanPreparedBatch), originalJob = parse(origin.job_data, dto.isScanJobRecord);
          if (originalJob.rootRevision !== root.revision || originalJob.sourceRootId !== source.id) continue;
          const originalIndex = original.items.findIndex(v => v.relative === locator.relative && v.signature === state.signature);
          if (originalIndex < 0) continue;
          const created = db.prepare('SELECT result FROM local_catalog_ledger WHERE command_id IN (?,?)').all(childCommand(original.batchId, originalIndex, 'register-asset'), childCommand(original.batchId, originalIndex, 'replace-asset'));
          if (created.length !== 1) continue;
          const proven = parse(created[0]!.result, dto.isAudioAsset);
          if (equal(proven, asset)) { provenCurrent = true; break; }
        }
        if (!provenCurrent) return null;
        const technical = state.readFacts.technical;
        const parameters = { container: technical.container, codec: technical.codec, lossless: technical.lossless, sampleRateHz: technical.sampleRateHz, channels: technical.channels,
          bitsPerSample: technical.bitsPerSample, durationMs: technical.durationSeconds === null ? null : Math.round(technical.durationSeconds * 1000), evidence: technical.evidence };
        return dto.isFileAudioParameters(parameters) ? parameters : null;
      });
    },
    privateCueAwareCheckpoint(jobId:string):boolean {
      return access.read(db=>{const job=get(db,jobId);if(job.checkpointRef === null) return false;
        const row=db.prepare("SELECT b.* FROM local_scan_checkpoints c JOIN local_scan_batches b ON b.id=c.batch_id WHERE c.id=? AND c.job_id=? AND b.job_id=? AND b.phase='committed'").get(job.checkpointRef,jobId,jobId);
        if(!row) return corrupt();const batch=parse(row.request,isScanPreparedBatch),result=parse(row.result,isScanCommittedBatch);
        if(batch.kind !== 'cue-sidecars-v1') return false;
        const prepared=db.prepare("SELECT request,fingerprint FROM local_scan_receipts WHERE job_id=? AND operation='prepare-batch' AND json_extract(request,'$.batch.batchId')=?").get(jobId,batch.batchId);
        const committed=db.prepare("SELECT request,result,fingerprint FROM local_scan_receipts WHERE job_id=? AND operation='commit-batch' AND json_extract(request,'$.batchId')=?").get(jobId,batch.batchId);
        if(!prepared || !committed || result.kind !== 'cue-sidecars-v1' || result.job.checkpointRef !== job.checkpointRef || result.job.jobId !== jobId) return corrupt();
        const prepareRequest=parse(prepared.request,(v):v is Row & {commandId:string;jobId:string}=>isScanReceiptRequest('prepare-batch',v));
        const commitRequest=parse(committed.request,(v):v is Row & {commandId:string;jobId:string}=>isScanReceiptRequest('commit-batch',v));
        if(!equal(prepareRequest.batch,batch) || prepared.fingerprint !== scanFingerprint('prepare-batch',prepareRequest)
          || committed.fingerprint !== scanFingerprint('commit-batch',commitRequest) || !equal(parse(committed.result,dto.isScanJobRecord),result.job)) return corrupt();return true;});
    },
    privateCueAssociation(libraryRootId:string,relative:string):{status:'bound';reference:dto.LocalCueAssetReference}|{status:'unbound'|'ambiguous'} {
      if(!dto.isCollectionId(libraryRootId) || !scanRelativePath(relative)) return access.conflict('CUE关联身份无效。');
      return access.read<{status:'bound';reference:dto.LocalCueAssetReference}|{status:'unbound'|'ambiguous'}>(db=>{
        const locators=db.prepare('SELECT id FROM local_catalog_assets WHERE root_id=? AND relative=? LIMIT 2').all(libraryRootId,relative);
        if(locators.length>1) return {status:'ambiguous'};
        if(locators.length===0) return {status:'unbound'};
        const state=currentFileState(db,libraryRootId,relative);
        if(!state) return {status:'unbound'};
        const observed=parse(state.data,isScanFileState);
        if(observed.outcome !== 'accepted' || observed.assetId !== locators[0]!.id) return {status:'unbound'};
        const locator=access.catalog.privateAssetLocator(observed.assetId!),asset=locator.asset;
        const reference:dto.LocalCueAssetReference={assetId:asset.id,libraryRootId:asset.libraryRootId,sourceRootId:asset.sourceRootId,rootRevision:asset.rootRevision,
          fileRevision:asset.fileRevision,locationRevision:asset.locationRevision,relative:locator.relative,signature:observed.signature};
        return {status:'bound',reference};
      });
    },
    privateCueSnapshot(libraryRootId:string,relative:string):CueSnapshot|null {
      if(!dto.isCollectionId(libraryRootId) || !scanRelativePath(relative)) return access.conflict('CUE来源身份无效。');
      return access.read(db=>cueLatest(db,libraryRootId,relative));
    },
    privatePrepareBatch(request: { commandId: string; jobId: string; batch: ScanPreparedBatch }): dto.ScanJobRecord {
      if (!isScanReceiptRequest('prepare-batch', request)) return access.conflict('扫描批准备请求无效。');
      return transaction('prepare-batch', (db, audit) => {
        const saved = savedReceipt(db, 'prepare-batch', request); if (saved) return saved;
        const job = get(db, request.jobId), batch = request.batch; current(job);
        if(batch.kind === 'cue-sidecars-v1') ensureCueSchema(db);
        if (job.phase !== 'running' || job.jobRevision !== batch.expectedJobRevision || job.checkpointRef !== batch.checkpointBefore) return access.conflict('扫描批状态或checkpoint已改变。');
        const parserVersion = db.prepare('SELECT parser_version FROM local_scan_jobs WHERE id=?').get(job.jobId)?.parser_version;
        if (batch.items.some(item => item.parserVersion !== parserVersion)) return access.conflict('扫描批解析器身份不一致。');
        db.prepare('INSERT INTO local_scan_batches VALUES(?,?,?,?,?,?)').run(batch.batchId, job.jobId, scanFingerprint('batch', batch), JSON.stringify(batch), 'prepared', null);
        audit.replace('local_scan_batches', null, db.prepare('SELECT * FROM local_scan_batches WHERE id=?').get(batch.batchId)!);
        putReceipt(db, 'prepare-batch', request, job, audit); return job;
      });
    },
    privatePreparedBatches(jobId: string): ScanPreparedBatch[] {
      return access.read(db => {
        get(db, jobId);
        const rows = db.prepare("SELECT request FROM local_scan_batches WHERE job_id=? AND phase='prepared' AND NOT EXISTS(SELECT 1 FROM local_scan_receipts r WHERE r.job_id=local_scan_batches.job_id AND r.operation='abandon-batch' AND json_extract(r.request,'$.batchId')=local_scan_batches.id) ORDER BY rowid LIMIT 201").all(jobId);
        if (rows.length > 200) return access.conflict('扫描准备批读取超出有限预算。');
        return rows.map(row => parse(row.request, isScanPreparedBatch));
      });
    },
    privateAbandonBatch(request: { commandId: string; jobId: string; batchId: string; expectedRevision: string; reason: 'CONTENT_CHANGED' }): dto.ScanJobRecord {
      if (!isScanReceiptRequest('abandon-batch',request)) return access.conflict('扫描弃批请求无效。');
      return transaction('abandon-batch',(db,audit) => {
        const saved=savedReceipt(db,'abandon-batch',request); if(saved) return saved;
        const job=get(db,request.jobId); current(job);
        const row=db.prepare("SELECT request FROM local_scan_batches WHERE id=? AND job_id=? AND phase='prepared'").get(request.batchId,job.jobId);
        if (job.jobRevision !== request.expectedRevision || job.phase !== 'running' || !row
          || parse(row.request,isScanPreparedBatch).checkpointBefore !== job.checkpointRef
          || db.prepare("SELECT command_id FROM local_scan_receipts WHERE job_id=? AND operation='abandon-batch' AND json_extract(request,'$.batchId')=?").get(job.jobId,request.batchId)) return access.conflict('扫描弃批状态、修订或checkpoint已改变。');
        // 旧prepared行和完整body绝不改写；追加收据只取消该批未来提交资格。
        putReceipt(db,'abandon-batch',request,job,audit); return job;
      });
    },
    privateFail(request: {commandId:string;jobId:string;expectedRevision:string;code:dto.ScanJobFailureCode}): dto.ScanJobRecord {
      if (!isScanReceiptRequest('fail',request)) return access.conflict('扫描失败请求无效。');
      return transaction('fail',(db,audit)=>{
        const saved=savedReceipt(db,'fail',request); if(saved) return saved;
        const job=get(db,request.jobId);
        if(job.jobRevision !== request.expectedRevision || ['completed','cancelled','failed'].includes(job.phase)) return access.conflict('扫描任务修订或终态已改变。');
        const result:dto.ScanJobRecord={...job,jobRevision:revision(job),phase:'failed',failureCode:request.code};
        const before=db.prepare('SELECT * FROM local_scan_jobs WHERE id=?').get(job.jobId)!;
        db.prepare('UPDATE local_scan_jobs SET data=? WHERE id=?').run(JSON.stringify(result),job.jobId);
        audit.replace('local_scan_jobs',before,db.prepare('SELECT * FROM local_scan_jobs WHERE id=?').get(job.jobId)!);
        putReceipt(db,'fail',request,result,audit);return result;
      });
    },
    privateCommitBatch(request: { commandId: string; jobId: string; batchId: string; expectedRevision: string }): dto.ScanJobRecord {
      if (!isScanReceiptRequest('commit-batch', request)) return access.conflict('扫描批提交请求无效。');
      const committed = access.catalog.privateBatch((db, mutate) => {
        const audit = scanAuditFor(db);
        const saved = savedReceipt(db, 'commit-batch', request); if (saved) return { result: saved, audit };
        const job = get(db, request.jobId); current(job);
        const row = db.prepare("SELECT * FROM local_scan_batches WHERE id=? AND job_id=? AND phase='prepared'").get(request.batchId, job.jobId);
        if (!row || db.prepare("SELECT command_id FROM local_scan_receipts WHERE job_id=? AND operation='abandon-batch' AND json_extract(request,'$.batchId')=?").get(job.jobId,request.batchId)) return access.conflict('扫描批尚未准备、已放弃或已由其他请求提交。');
        const batch = parse(row.request, isScanPreparedBatch);
        if (job.phase !== 'running' || job.jobRevision !== request.expectedRevision || batch.checkpointBefore !== job.checkpointRef) return access.conflict('扫描批任务修订或checkpoint已改变。');
        const states: { value: ScanFileState; before: Row | null }[] = [];
        for (const [index, item] of batch.items.entries()) {
          const previousRow = db.prepare('SELECT * FROM local_scan_file_state WHERE library_root_id=? AND relative=?').get(job.libraryRootId, item.relative);
          const candidateRow = currentFileState(db, job.libraryRootId, item.relative);
          const previous = candidateRow ? parse(candidateRow.data, isScanFileState, 65_536) : null;
          let assetId: string | null = previous?.assetId ?? null, trackId: string | null = previous?.trackId ?? null;
          if (item.reused && (!previous || previous.outcome !== 'accepted' || previous.signature !== item.signature || previous.parserVersion !== item.parserVersion)) return access.conflict('复用扫描结果的原签名或解析器已改变。');
          if (item.outcome === 'accepted') {
            if (previous?.assetId && previous.trackId) {
              assetId = previous.assetId; trackId = previous.trackId;
              const asset = access.catalog.asset(assetId!);
              if (previous.signature !== item.signature || previous.parserVersion !== item.parserVersion
                || asset.sourceRootId !== job.sourceRootId || asset.rootRevision !== job.rootRevision) {
                if (item.reused) return access.conflict('根重关联后的文件需要新可信读取事实。');
                const replacement = { commandId: childCommand(batch.batchId, index, 'replace-asset'), libraryRootId: job.libraryRootId,
                  expectedRootRevision: job.rootRevision, relative: item.relative, sha256: null, sampleFrames: null, timebaseHz: null,
                  assetId: asset.id, expectedFileRevision: asset.fileRevision, expectedLocationRevision: asset.locationRevision };
                const result = mutate('replace-asset', replacement); if (!dto.isAudioAsset(result) || result.id !== assetId) return corrupt();
              }
            } else {
              const registration = { commandId: childCommand(batch.batchId, index, 'register-asset'), libraryRootId: job.libraryRootId,
                expectedRootRevision: job.rootRevision, relative: item.relative, sha256: null, sampleFrames: null, timebaseHz: null };
              const asset = mutate('register-asset', registration); if (!dto.isAudioAsset(asset)) return corrupt(); assetId = asset.id;
              const track = mutate('create-track', { commandId: childCommand(batch.batchId, index, 'create-track'), assetId, segment: null });
              if (!dto.isLocalTrack(track)) return corrupt(); trackId = track.id;
            }
            if (Object.keys(item.fields!).length && (previous?.signature !== item.signature || previous?.parserVersion !== item.parserVersion)) {
              const observation = { commandId: childCommand(batch.batchId, index, 'observe-metadata'), trackId: trackId!, source: 'tag' as const, parserVersion: item.parserVersion, fields: item.fields! };
              if (!dto.isLocalMetadataObservation(mutate('observe-metadata', observation))) return corrupt();
            }
          }
          const state: ScanFileState = { libraryRootId: job.libraryRootId, relative: item.relative, signature: item.signature,
            parserVersion: item.parserVersion, outcome: item.outcome, assetId, trackId, failureCode: item.failureCode,
            readFacts: item.reused ? previous!.readFacts : item.readFacts };
          if (!isScanFileState(state)) return corrupt(); states.push({ value: state, before: previousRow ?? null });
        }
        const cueSnapshotIds:string[]=[];
        if(batch.kind === 'cue-sidecars-v1') {
          if(!cueSchema(db)) return corrupt();
          for(const item of batch.cueItems ?? []) {
            const prior=cueLatest(db,job.libraryRootId,item.relative);
            if((prior?.id ?? null) !== item.previousSnapshotId) return access.conflict('CUE来源snapshot已改变。');
            for(const track of item.result?.tracks ?? []) {
              const ref=track.assetReference,locator=access.catalog.privateAssetLocator(ref.assetId),asset=locator.asset;
              if(asset.libraryRootId !== job.libraryRootId || asset.sourceRootId !== job.sourceRootId || asset.rootRevision !== job.rootRevision
                || ref.libraryRootId !== asset.libraryRootId || ref.sourceRootId !== asset.sourceRootId || ref.rootRevision !== asset.rootRevision
                || ref.fileRevision !== asset.fileRevision || ref.locationRevision !== asset.locationRevision || ref.relative !== locator.relative) return access.conflict('CUE关联资产修订或位置已改变。');
              const state=currentFileState(db,job.libraryRootId,ref.relative);
              if(!state || parse(state.data,isScanFileState).signature !== ref.signature || parse(state.data,isScanFileState).assetId !== ref.assetId) return access.conflict('CUE关联真实扫描签名已改变。');
            }
            if(item.reused) {
              if(!prior || prior.item.outcome !== 'accepted' || prior.item.signature !== item.signature || prior.item.parserVersion !== item.parserVersion || !equal(prior.item.result,item.result)) return access.conflict('CUE复用事实已改变。');
              cueSnapshotIds.push(prior.id);continue;
            }
            const snapshot:CueSnapshot={id:randomUUID(),sidecarId:prior?.sidecarId ?? randomUUID(),libraryRootId:job.libraryRootId,sourceRootId:job.sourceRootId,rootRevision:job.rootRevision,item};
            if(!isCueSnapshot(snapshot)) return corrupt();
            db.prepare('INSERT INTO local_cue_sources VALUES(?,?,?,?,?,?)').run(snapshot.id,snapshot.sidecarId,snapshot.libraryRootId,item.relative,batch.batchId,JSON.stringify(snapshot));
            audit.replace('local_cue_sources',null,db.prepare('SELECT * FROM local_cue_sources WHERE id=?').get(snapshot.id)!);
            for(const [ordinal,track] of (item.result?.tracks ?? []).entries()) {
              db.prepare('INSERT INTO local_cue_tracks VALUES(?,?,?,?)').run(snapshot.id,ordinal,track.assetReference.assetId,JSON.stringify(track));
              audit.replace('local_cue_tracks',null,db.prepare('SELECT * FROM local_cue_tracks WHERE snapshot_id=? AND ordinal=?').get(snapshot.id,ordinal)!);
            }
            cueSnapshotIds.push(snapshot.id);
          }
        }
        const counted=batchCount(batch);
        const checkpointId = randomUUID(), previous = job.checkpointRef === null ? null : db.prepare('SELECT data FROM local_scan_checkpoints WHERE id=?').get(job.checkpointRef);
        const checkpoint: ScanCheckpoint = { checkpointId, jobId: job.jobId, batchId: batch.batchId,
          sequence: previous ? (BigInt(parse(previous.data, isScanCheckpoint).sequence) + 1n).toString() : '1', frontier: batch.frontier,
          progress: { visited: (BigInt(job.progress.visited) + BigInt(counted.length)).toString(),
            accepted: (BigInt(job.progress.accepted) + BigInt(counted.filter(item => item.outcome === 'accepted').length)).toString(),
            rejected: (BigInt(job.progress.rejected) + BigInt(counted.filter(item => item.outcome === 'rejected').length)).toString() } };
        if (!isScanCheckpoint(checkpoint)) return corrupt();
        const result: dto.ScanJobRecord = { ...job, jobRevision: revision(job), checkpointRef: checkpointId, progress: checkpoint.progress,
          phase: batch.completed ? 'completed' : 'running', failureCode: null };
        if (!dto.isScanJobRecord(result)) return corrupt();
        db.prepare('UPDATE local_scan_batches SET phase=?,result=? WHERE id=?').run('committed', JSON.stringify({ job: result, files: states.map(entry => entry.value),...(batch.kind === 'cue-sidecars-v1' ? {kind:batch.kind,cueSnapshotIds}:{}) } satisfies ScanCommittedBatch), batch.batchId);
        audit.replace('local_scan_batches', row, db.prepare('SELECT * FROM local_scan_batches WHERE id=?').get(batch.batchId)!);
        db.prepare('INSERT INTO local_scan_checkpoints VALUES(?,?,?,?)').run(checkpointId, job.jobId, batch.batchId, JSON.stringify(checkpoint));
        audit.replace('local_scan_checkpoints', null, db.prepare('SELECT * FROM local_scan_checkpoints WHERE id=?').get(checkpointId)!);
        for (const entry of states) { const state = entry.value;
          db.prepare('INSERT INTO local_scan_file_state VALUES(?,?,?,?,?,?,?) ON CONFLICT(library_root_id,relative) DO UPDATE SET job_id=excluded.job_id,batch_id=excluded.batch_id,asset_id=excluded.asset_id,track_id=excluded.track_id,data=excluded.data')
            .run(state.libraryRootId, state.relative, job.jobId, batch.batchId, state.assetId, state.trackId, JSON.stringify(state));
          audit.replace('local_scan_file_state', entry.before, db.prepare('SELECT * FROM local_scan_file_state WHERE library_root_id=? AND relative=?').get(state.libraryRootId, state.relative)!);
        }
        const beforeJob = db.prepare('SELECT * FROM local_scan_jobs WHERE id=?').get(job.jobId)!;
        db.prepare('UPDATE local_scan_jobs SET data=? WHERE id=?').run(JSON.stringify(result), job.jobId);
        audit.replace('local_scan_jobs', beforeJob, db.prepare('SELECT * FROM local_scan_jobs WHERE id=?').get(job.jobId)!);
        putReceipt(db, 'commit-batch', request, result, audit);
        if (!equal(get(db, job.jobId), result)) return corrupt();
        return { result, audit };
      });
      committed.audit.publish(); return committed.result;
    },
  };
}
export type LocalScanStore = ReturnType<typeof createLocalScanStore>;
