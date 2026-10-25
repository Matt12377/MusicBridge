import { verifyCompletedScanSnapshotDatabase } from './local-scan-snapshot-view.js';
import { createHash, randomUUID } from 'node:crypto';
import { albumScanRevision } from './local-album-browser/owner-store.js';
import { beginLocalAlbumScanDelta, recordLocalAlbumScanWrites, recordLocalAlbumScanDirectory, approveLocalAlbumScanDelta, publishLocalAlbumScanDelta, discardLocalAlbumScanDelta, localAlbumScanPoint, localAlbumScanPath } from './local-album-browser/scan-delta.js';
import path from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import * as dto from '@music-bridge/contracts';
import type { MetadataTechnical, MetadataCoverEvidence, MetadataReadEvidence } from '../library/metadata-reader-types.js';
import { LocalCatalogBudgetError, sourceWritesProjectionForDatabase, relocationProjectionForDatabase, lyricsPhysicalPublicationsForDatabase } from './local-catalog-store.js';
import type { RelocationProjection, RelocationLocationFact } from './local-relocation-journal.js';
import { installSourceWriteScanPort } from './source-write-scan-port.js';
import { installRelocationScanPort, type RelocationScanAuthor, type RelocationScanMapping,
  type RelocationScanReadRequest, type RelocationCatalogCommitContext, type RelocationScanDelta,
  type RelocationBoundScanFact } from './source-relocation-scan-port.js';
import type { RelocationReadAccess } from './source-relocation-verify.js';
import type { ScanReadFacts, ScanFileState } from './local-scan-facts.js';
import { METADATA_PARSER_VERSION, RUST_MEDIA_METADATA_PARSER_VERSION, CUE_HEADER_METADATA_PARSER_VERSION, CUE_INPUT_SCAN_VERSION } from '../library/metadata-reader-types.js';
import { logLibraryOperation } from '../shared/library-operation-log.js';
import { createScanOriginIndex, currentScanOriginIndex, ownsScanOriginIndex, discardScanOriginIndex, addScanOriginBatch, publishScanOriginIndex, stageScanOriginIndex, scanOriginPositions, continueReadonlyQueueScanOrigins } from './local-scan-origin-index.js';
import type { LocalWorkbenchDirectoryFactsRequest, LocalWorkbenchDirectoryFacts } from './local-library-workbench/read-service.js';
import { catalogFileParametersBranch, type CatalogFileParametersBranchStage } from '../mobile/catalog-private-trace.js';
export type { ScanReadFacts, ScanFileState } from './local-scan-facts.js';

// 只复用原连接的只读语句；每次仍执行SQLite，不缓存扫描事实、路径许可或文件状态。
const scanReadStatements = new WeakMap<DatabaseSync, Map<string, StatementSync>>();
function scanReadStatement(db: DatabaseSync, sql: string): StatementSync {
  let statements = scanReadStatements.get(db);
  if (!statements) { statements = new Map(); scanReadStatements.set(db, statements); }
  const saved = statements.get(sql);
  if (saved) return saved;
  const statement = db.prepare(sql);
  if (statements.size >= 32) statements.delete(statements.keys().next().value!);
  statements.set(sql, statement);
  return statement;
}

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
  const found=Object.keys(cueTables).map(name=>scanReadStatement(db, "SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name));
  if(found.every(row=>row === undefined)) {
    for(const sql of [...cueIndexes,...cueTriggers]) if(scanReadStatement(db, 'SELECT name FROM sqlite_master WHERE name=?').get(sql.split(' ')[2]!)) return corrupt();
    return false;
  }
  if(found.some(row=>row === undefined)) return corrupt();
  for(const [name,sql] of Object.entries(cueTables)) if(scanReadStatement(db, "SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name)?.sql !== sql) return corrupt();
  for(const [type,list] of [['index',cueIndexes],['trigger',cueTriggers]] as const) for(const sql of list)
    if(scanReadStatement(db, 'SELECT sql FROM sqlite_master WHERE type=? AND name=?').get(type,sql.split(' ')[2]!)?.sql !== sql) return corrupt();
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
export type ScanReceiptOperation = 'start' | 'pause' | 'resume' | 'cancel' | 'prepare-batch' | 'commit-batch' | 'recover' | 'abandon-batch' | 'fail' | 'discover';
export type ScanAutomaticPauseCause = 'media-busy' | 'admission-closed' | 'deferred' | 'source-offline';
export interface ScanPreparedItem {
  relative: string; signature: string; parserVersion: string;
  outcome: 'accepted' | 'rejected'; fields: dto.LocalMetadata | null; failureCode: string | null; reused: boolean; readFacts: ScanReadFacts | null;
}
/** 仅原coordinator真实Reader私有准备闭包可产生；不进入公开DTO或Main消息。 */
export interface RelocationPreparedScanRead { mapping: RelocationScanMapping; item: ScanPreparedItem; primaryTrackId: string }
export interface ScanPreparedBatch {
  batchId: string; jobId: string; expectedJobRevision: string; checkpointBefore: string | null;
  items: ScanPreparedItem[]; frontier: string[]; completed: boolean;
  kind?: 'cue-sidecars-v1'; cueItems?: dto.LocalCuePreparedItem[];
}
export interface ScanCheckpoint {
  checkpointId: string; jobId: string; batchId: string; sequence: string;
  frontier: string[]; progress: dto.ScanJobProgress;
}
/** 有界发现清单先记入原不可变收据；部分提交后仍能沿每项的真实目录游标续读。 */
export interface ScanDiscovery {
  discoveryId: string; jobId: string; checkpointBefore: string | null;
  entries: { relative: string; frontier: string[] }[]; frontier: string[];
  cueRelatives: string[]; cueAware: boolean; cueMode: boolean;
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
  && ['title', 'artist', 'album', 'year', 'disc', 'track', 'albumArtist', 'artists', 'albumArtists'].includes(key) && Object.prototype.propertyIsEnumerable.call(v, key)) && dto.isLocalMetadata(v);
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
export function isScanDiscovery(v: unknown): v is ScanDiscovery {
  return record(v) && closed(v, ['discoveryId','jobId','checkpointBefore','entries','frontier','cueRelatives','cueAware','cueMode'])
    && dto.isCollectionId(v.discoveryId) && dto.isCollectionId(v.jobId) && nullableId(v.checkpointBefore)
    && array(v.entries, 200) && v.entries.every(entry => record(entry) && closed(entry, ['relative','frontier']) && scanRelativePath(entry.relative) && frontier(entry.frontier))
    && new Set(v.entries.map(entry => (entry as Row).relative)).size === v.entries.length && frontier(v.frontier)
    && array(v.cueRelatives, 2000) && v.cueRelatives.every(value => scanRelativePath(value) && /\.cue$/iu.test(value))
    && new Set(v.cueRelatives).size === v.cueRelatives.length && typeof v.cueAware === 'boolean' && typeof v.cueMode === 'boolean'
    && (!v.cueMode || v.entries.length <= 1 && v.cueRelatives.length === 0) && Buffer.byteLength(JSON.stringify(v)) <= 4 * 1024 * 1024;
}
const progress = (v: unknown): v is dto.ScanJobProgress => record(v) && closed(v, ['visited', 'accepted', 'rejected'])
  && dto.isLocalExactInteger(v.visited) && dto.isLocalExactInteger(v.accepted) && dto.isLocalExactInteger(v.rejected)
  && BigInt(v.accepted) + BigInt(v.rejected) === BigInt(v.visited);
const finiteNonnegative = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
export function isScanReadFacts(v: unknown): v is ScanReadFacts {
  if (!record(v) || !closed(v, ['technical', 'coverEvidence', 'readEvidence']) || !record(v.technical)
    || !closed(v.technical, ['container', 'codec', 'lossless', 'sampleRateHz', 'channels', 'bitsPerSample', 'durationSeconds', 'evidence'])
    || typeof v.technical.container !== 'string' || !['FLAC', 'MPEG', 'MP4', 'WAVE', 'AIFF', 'DSF', 'DFF', 'OGG', 'WAVPACK', 'APE', 'TTA', 'MPC', 'TAK'].includes(v.technical.container)
    || !text(v.technical.codec) || !(v.technical.lossless === null || typeof v.technical.lossless === 'boolean')
    || !finiteNonnegative(v.technical.sampleRateHz) || v.technical.sampleRateHz === 0 || !finiteNonnegative(v.technical.channels) || v.technical.channels === 0
    || !(v.technical.bitsPerSample === null || finiteNonnegative(v.technical.bitsPerSample))
    || !(v.technical.durationSeconds === null || finiteNonnegative(v.technical.durationSeconds)) || v.technical.evidence !== 'bounded-parser-reported'
    || !array(v.coverEvidence, 8) || !record(v.readEvidence)
    || !closed(v.readEvidence, ['bytesRead', 'readCalls', 'maxReadBytes', 'allocationBytes', 'elapsedMs', 'wholeAudioHash', 'wholeAudioDecode'])) return false;
  if (['DSF','DFF'].includes(v.technical.container) && (v.technical.codec !== 'DSD' || v.technical.lossless !== true
    || v.technical.bitsPerSample !== 1 || ![2822400,3072000,5644800,6144000,11289600,12288000,22579200,24576000].includes(v.technical.sampleRateHz as number)
    || !Number.isSafeInteger(v.technical.channels) || (v.technical.channels as number) > 6
    || !finiteNonnegative(v.technical.durationSeconds) || v.technical.durationSeconds === 0)) return false;
  for (const cover of v.coverEvidence) if (!record(cover) || !closed(cover, ['mime', 'bytes', 'sha256', 'evidence'])
    || !(cover.mime === 'image/png' || cover.mime === 'image/jpeg') || typeof cover.bytes !== 'number' || !Number.isSafeInteger(cover.bytes)
    || cover.bytes < 1 || cover.bytes > 4 * 1024 * 1024 || !hash(cover.sha256) || cover.evidence !== 'encoded-bytes-magic-and-digest') return false;
  const evidence = v.readEvidence;
  for (const key of ['bytesRead', 'readCalls', 'maxReadBytes', 'allocationBytes']) if (typeof evidence[key] !== 'number' || !Number.isSafeInteger(evidence[key]) || (evidence[key] as number) < 0) return false;
  return (evidence.bytesRead as number) <= 32 * 1024 * 1024 && (evidence.maxReadBytes as number) <= 8 * 1024 * 1024
    && (evidence.allocationBytes as number) <= 64 * 1024 * 1024 && finiteNonnegative(evidence.elapsedMs)
    && evidence.wholeAudioHash === false && evidence.wholeAudioDecode === false;
}
/** job标识扫描合同，item保真实解析器版本；只有显式CUE输入合同允许限定混族，旧job不扩族。 */
function scanItemMatchesParser(item: ScanPreparedItem, parserVersion: unknown): boolean {
  const container = item.readFacts?.technical.container;
  if (parserVersion !== CUE_INPUT_SCAN_VERSION) {
    return (item.parserVersion === parserVersion || [METADATA_PARSER_VERSION, RUST_MEDIA_METADATA_PARSER_VERSION].includes(String(parserVersion) as typeof METADATA_PARSER_VERSION | typeof RUST_MEDIA_METADATA_PARSER_VERSION) && [METADATA_PARSER_VERSION, RUST_MEDIA_METADATA_PARSER_VERSION].includes(item.parserVersion as typeof METADATA_PARSER_VERSION | typeof RUST_MEDIA_METADATA_PARSER_VERSION))
      && (container === undefined || ['FLAC', 'MPEG', 'MP4', 'WAVE', 'AIFF', 'DSF', 'DFF'].includes(container));
  }
  if (![METADATA_PARSER_VERSION, RUST_MEDIA_METADATA_PARSER_VERSION, CUE_HEADER_METADATA_PARSER_VERSION].includes(item.parserVersion as typeof METADATA_PARSER_VERSION | typeof CUE_HEADER_METADATA_PARSER_VERSION | typeof RUST_MEDIA_METADATA_PARSER_VERSION)) return false;
  // 拒收没有成功解析事实；复用仍由原签名、原parser和同SQL资产原件独立核验。
  if (container === undefined) return item.readFacts === null;
  return ['TTA', 'TAK'].includes(container) ? item.parserVersion === CUE_HEADER_METADATA_PARSER_VERSION
    : item.parserVersion === METADATA_PARSER_VERSION || item.parserVersion === RUST_MEDIA_METADATA_PARSER_VERSION;
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
    case 'discover': return closed(v, ['commandId','jobId','expectedRevision','discovery']) && dto.isLocalCatalogRevision(v.expectedRevision)
      && isScanDiscovery(v.discovery) && v.discovery.jobId === v.jobId;
    case 'commit-batch': return closed(v, ['commandId', 'jobId', 'batchId', 'expectedRevision']) && dto.isCollectionId(v.batchId) && dto.isLocalCatalogRevision(v.expectedRevision);
    case 'abandon-batch': return closed(v, ['commandId','jobId','batchId','expectedRevision','reason']) && dto.isCollectionId(v.batchId) && dto.isLocalCatalogRevision(v.expectedRevision) && v.reason === 'CONTENT_CHANGED';
    case 'fail': return closed(v,['commandId','jobId','expectedRevision','code']) && dto.isLocalCatalogRevision(v.expectedRevision) && ['ROOT_UNAVAILABLE','ROOT_REVISION_CHANGED','SCAN_READ_FAILED','CHECKPOINT_INVALID'].includes(String(v.code));
    case 'recover': return closed(v, ['commandId', 'jobId', 'expectedRevision', 'cause']) && dto.isLocalCatalogRevision(v.expectedRevision) && (v.cause === 'cold-open' || v.cause === 'restore');
    case 'pause': return dto.isLocalCatalogRevision(v.expectedRevision) && (closed(v, ['commandId','jobId','expectedRevision'])
      || closed(v, ['commandId','jobId','expectedRevision','cause']) && ['media-busy','admission-closed','deferred','source-offline'].includes(String(v.cause)));
    case 'resume': case 'cancel': return closed(v, ['commandId', 'jobId', 'expectedRevision']) && dto.isLocalCatalogRevision(v.expectedRevision);
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
/** 只续接隔离Actor已核的队列写；不改变冷开、扫描及数据完整性核验。 */
export function continueReadonlyQueueScanAudit(db: DatabaseSync, previousVersion: number): void {
  const previous = scanAudits.get(db)
  if (!previous || previous.dataVersion !== previousVersion || !db.isTransaction
    || db.prepare('PRAGMA query_only').get()?.query_only !== 1 || db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1) return corrupt()
  continueReadonlyQueueScanOrigins(db, previousVersion)
  scanAudits.set(db, { ...previous, dataVersion: Number(db.prepare('PRAGMA data_version').get()?.data_version) })
}
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
  const originIndex = currentScanOriginIndex(db, true), originPoint = localAlbumScanPoint(db);
  const changedBatches = new Map<string, Row>();
  const rows = new Map(previous.rows); let bytes = previous.bytes, writes = 0;
  return {
    replace(table: Table, before: Row | null, after: Row): void {
      writes++;
      if (table === 'local_scan_batches') changedBatches.set(String(after.id), after);
      const afterBytes = scanRowBytes(after); checkScanBudget(`${table}单行文本字节`, afterBytes, 16 * 1024 * 1024);
      const count = (rows.get(table) ?? 0) + (before ? 0 : 1); checkScanBudget(`${table}行数`, count, budgets[table]); rows.set(table, count);
      bytes += afterBytes - (before ? scanRowBytes(before) : 0); checkScanBudget('全域文本字节', bytes, 64 * 1024 * 1024 * 1024);
    },
    writes(): number { return writes; },
    publish(): void {
      if (scanDataVersion(db) !== previous.dataVersion) return corrupt();
      scanAudits.set(db, { rows, bytes, dataVersion: previous.dataVersion });
    },
    publishOrigins(): void {
      const actual = localAlbumScanPoint(db);
      // 仅扫描表的精确写数，或原scan/catalog联合写fence已认可并真实COMMIT的完整段，才可续接。
      if (!originIndex || !ownsScanOriginIndex(db, originIndex) || !originPoint || !actual || db.isTransaction || actual.version !== originPoint.version || actual.schema !== originPoint.schema
        || actual.changes !== originPoint.changes + writes && !localAlbumScanPath(db, originPoint, actual)) { discardScanOriginIndex(db); return; }
      try {
        for (const row of changedBatches.values()) if (row.phase === 'committed') {
          const batch = parse(row.request, isScanPreparedBatch), result = parse(row.result, isScanCommittedBatch);
          const job = parse(db.prepare('SELECT data FROM local_scan_jobs WHERE id=?').get(batch.jobId)?.data, dto.isScanJobRecord);
          const ordinal = Number(db.prepare('SELECT rowid n FROM local_scan_batches WHERE id=?').get(batch.batchId)?.n);
          if (!Number.isSafeInteger(ordinal) || ordinal < 1) { discardScanOriginIndex(db); return; }
          addScanOriginBatch(originIndex, { ordinal, batchId: batch.batchId, jobId: batch.jobId }, job.libraryRootId, batch.items, result.files);
        }
        publishScanOriginIndex(db, originIndex);
      } catch { discardScanOriginIndex(db); }
    },
  };
}
type ScanAudit = ReturnType<typeof scanAuditFor>;
const originRebuilds = new WeakMap<DatabaseSync, Promise<void>>();
// 只记住本连接这个实际SQL点的预算失败，不是候选索引，也不证明任何文件事实。
const originOverflowPoints = new WeakMap<DatabaseSync, string>();
/** 仅后台重建纯候选位置；逐段让出事件循环，首末SQL点不同便完整丢弃，绝不续用未知写入前缀。 */
function rebuildScanOrigins(db: DatabaseSync, read: ScanAccess['read']): Promise<void> {
  if (db.isTransaction || currentScanOriginIndex(db)) return Promise.resolve();
  const saved = originRebuilds.get(db); if (saved) return saved;
  const initial = localAlbumScanPoint(db);
  if (!initial) return Promise.resolve();
  const initialPoint = JSON.stringify(initial);
  if (originOverflowPoints.get(db) === initialPoint) return Promise.resolve();
  originOverflowPoints.delete(db);
  const started = performance.now(), index = createScanOriginIndex();
  const same = (): boolean => !db.isTransaction && JSON.stringify(localAlbumScanPoint(db)) === initialPoint;
  let processed = 0;
  const work = (async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
    const roots = read(current => {
      if (current !== db || !same()) throw new Error('扫描候选读取已过期。');
      scanAuditFor(db);
      const rows = db.prepare('SELECT id,library_root_id FROM local_scan_jobs ORDER BY id').all();
      const result = new Map<string, string>();
      for (const row of rows) {
        if (!dto.isCollectionId(row.id) || !dto.isCollectionId(row.library_root_id)) return corrupt();
        result.set(row.id, row.library_root_id); index.bytes += (row.id.length + row.library_root_id.length) * 2 + 128;
      }
      if (index.bytes > 32 * 1024 * 1024) { index.overflow = true; throw new Error('扫描候选超过内存预算。'); }
      return result;
    });
    let cursor = 0;
    while (!index.overflow) {
      const rows = read(current => {
        if (current !== db || !same()) throw new Error('扫描候选读取已过期。');
        // 每次关闭原语句后再让出；不跨异步边界保留SQLite游标或事务。
        return db.prepare("SELECT rowid AS ordinal,id,job_id,request,result FROM local_scan_batches WHERE rowid>? AND phase='committed' ORDER BY rowid LIMIT 16").all(cursor);
      });
      if (!rows.length) break;
      read(current => {
        if (current !== db || !same()) throw new Error('扫描候选读取已过期。');
        for (const row of rows) {
          const batch = parse(row.request, isScanPreparedBatch), result = parse(row.result, isScanCommittedBatch), rootId = roots.get(String(row.job_id));
          const ordinal = Number(row.ordinal);
          if (!rootId || row.id !== batch.batchId || row.job_id !== batch.jobId || !Number.isSafeInteger(ordinal) || ordinal <= cursor) return corrupt();
          // 原合法批每relative唯一；未知写造成的重复/错位files不能折叠成较少候选，绕过原200行预算。
          if (result.files.length !== batch.items.length || result.job.jobId !== batch.jobId || result.files.some((file, itemIndex) => {
            const item = batch.items[itemIndex]!;
            return file.libraryRootId !== rootId || file.relative !== item.relative || file.signature !== item.signature || file.parserVersion !== item.parserVersion
              || file.outcome !== item.outcome || file.failureCode !== item.failureCode || !item.reused && !equal(file.readFacts, item.readFacts);
          })) return corrupt();
          addScanOriginBatch(index, { ordinal, batchId: batch.batchId, jobId: batch.jobId }, rootId, batch.items, result.files);
          cursor = ordinal; processed++;
        }
      });
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    read(current => {
      if (current !== db || !same() || index.overflow) throw new Error('扫描候选读取已过期或超过预算。');
      scanAuditFor(db); publishScanOriginIndex(db, index);
    });
    logLibraryOperation('cache', 'scan.origin-rebuild', 'complete', { elapsedMs: performance.now() - started, count: index.entries.size, visited: processed, bytes: index.bytes });
  })().catch(() => {
    // 预算失败的首末物理水位仍须完全闭合；READ_CHANGED、未闭合事务及未知写入不能留下抑制重试的记录。
    if (index.overflow && same()) originOverflowPoints.set(db, initialPoint);
    logLibraryOperation('cache', 'scan.origin-rebuild', 'cancelled', { elapsedMs: performance.now() - started, visited: processed, code: index.overflow ? 'BUDGET_EXCEEDED' : 'READ_CHANGED' });
  }).finally(() => { if (originRebuilds.get(db) === work) originRebuilds.delete(db); });
  originRebuilds.set(db, work); return work;
}
/** 新源作者只更新真实已存文件行，原job/batch外键和冻结历史保留；外围真实COMMIT后才发布计数证书。 */
export function updateSourceWriteScanFacts(db:DatabaseSync,rootId:string,relative:string,jobId:string,batchId:string,before:string,after:string):()=>void{
  const row=db.prepare('SELECT * FROM local_scan_file_state WHERE library_root_id=? AND relative=?').get(rootId,relative);if(!row||row.job_id!==jobId||row.batch_id!==batchId||row.data!==before)return corrupt();
  const first=parse(before,isScanFileState,65536),next=parse(after,isScanFileState,65536);if(next.libraryRootId!==rootId||next.relative!==relative||next.assetId!==first.assetId||next.trackId!==first.trackId||next.parserVersion!==first.parserVersion||next.outcome!=='accepted'||next.failureCode!==null||!next.readFacts)return corrupt();
  const audit=scanAuditFor(db);const changed=db.prepare('UPDATE local_scan_file_state SET data=? WHERE library_root_id=? AND relative=? AND job_id=? AND batch_id=? AND data=?').run(after,rootId,relative,jobId,batchId,before);if(changed.changes!==1)return corrupt();audit.replace('local_scan_file_state',row,db.prepare('SELECT * FROM local_scan_file_state WHERE library_root_id=? AND relative=?').get(rootId,relative)!);return ()=>audit.publish();
}
function sourceUpdatedScanState(db:DatabaseSync,row:Row,initial:ScanFileState):ScanFileState|null{
  const projection=sourceWritesProjectionForDatabase(db);let previous=initial,found=false;
  const updates:{before:string;after:string;sequence:number}[]=[];
  for(const event of projection?.events??[]){if(event.kind!=='facts'||event.fact.scanJobId!==row.job_id||event.fact.scanBatchId!==row.batch_id)continue;
    const f=event.fact,next=parse(f.scanAfter,isScanFileState,65536);if(next.libraryRootId!==row.library_root_id||next.relative!==row.relative)continue;
    const ordinal=Number(db.prepare('SELECT rowid n FROM local_catalog_ledger WHERE command_id=?').get(event.eventId)?.n);if(!Number.isSafeInteger(ordinal)||ordinal<1)return corrupt();updates.push({before:f.scanBefore,after:f.scanAfter,sequence:ordinal});
  }
  for(const item of lyricsPhysicalPublicationsForDatabase(db)){const scan=item.publication.scan;if(!scan||scan.jobId!==row.job_id||scan.batchId!==row.batch_id||scan.rootId!==row.library_root_id||scan.relative!==row.relative)continue;updates.push({before:scan.before,after:scan.after,sequence:item.sequence});}
  for(const update of updates.sort((a,b)=>a.sequence-b.sequence)){const next=parse(update.after,isScanFileState,65536),before=parse(update.before,isScanFileState,65536);if(!equal(before,previous)||next.assetId!==initial.assetId||next.trackId!==initial.trackId||next.parserVersion!==initial.parserVersion)return corrupt();previous=next;found=true;}
  return found?previous:null;
}
const relocationOriginIndexes = new WeakMap<DatabaseSync, { projection: RelocationProjection; origins: ReadonlyMap<string, RelocationLocationFact> }>();
function relocationOriginFact(db: DatabaseSync, jobId: string, batchId: string, index: number): RelocationLocationFact | null {
  const projection = relocationProjectionForDatabase(db); if (!projection) return null;
  let cache = relocationOriginIndexes.get(db);
  if (!cache || cache.projection !== projection) {
    const origins = new Map<string, RelocationLocationFact>();
    for (const event of projection.events) if (event.kind === 'location-facts') {
      const fact = event.fact, key = `${fact.scan.origin.job.jobId}/${fact.scan.origin.batchId}/${fact.scan.origin.itemIndex}`;
      if (origins.has(key)) return corrupt(); origins.set(key, fact);
    }
    cache = { projection, origins }; relocationOriginIndexes.set(db, cache);
  }
  return cache.origins.get(`${jobId}/${batchId}/${index}`) ?? null;
}
/** 只接目录已认证013事件，再逐一核原四张receipt、batch和真实Reader事实；不补造register子账本。 */
function verifyRelocationOrigin(db: DatabaseSync, job: dto.ScanJobRecord, batch: ScanPreparedBatch, index: number, file: ScanFileState): RelocationLocationFact | null {
  const fact = relocationOriginFact(db, job.jobId, batch.batchId, index); if (!fact) return null;
  const origin = fact.scan.origin, item = batch.items[index];
  if (!item || item.reused || item.outcome !== 'accepted' || !equal(item.fields, {}) || !isScanReadFacts(item.readFacts)
    || !equal(origin.job, job) || !equal(fact.scan.state, file) || file.libraryRootId !== fact.target.libraryRootId
    || file.relative !== fact.target.relative || file.signature !== fact.targetObservation.signature
    || file.assetId !== fact.afterAsset.id || !fact.tracks.some(track => track.id === file.trackId)
    || !equal(file.readFacts, item.readFacts) || batch.expectedJobRevision !== '2' || batch.checkpointBefore !== null
    || !batch.completed || batch.frontier.length || origin.job.checkpointRef !== origin.checkpointId) return corrupt();
  const receipts = [
    ['start', origin.startCommandId, origin.startFingerprint], ['resume', origin.resumeCommandId, origin.resumeFingerprint],
    ['prepare-batch', origin.prepareCommandId, origin.prepareFingerprint], ['commit-batch', origin.commitCommandId, origin.commitFingerprint],
  ] as const;
  for (const [operation, commandId, fingerprint] of receipts) {
    const row = db.prepare('SELECT * FROM local_scan_receipts WHERE command_id=? AND job_id=? AND operation=?').get(commandId, job.jobId, operation);
    if (!row || row.fingerprint !== fingerprint) return corrupt();
    const request = parse(row.request, (value): value is Row & { commandId: string; jobId: string } => isScanReceiptRequest(operation, value));
    if (request.commandId !== commandId || request.jobId !== job.jobId || scanFingerprint(operation, request) !== fingerprint) return corrupt();
    const result = parse(row.result, dto.isScanJobRecord, 65_536);
    if (operation === 'prepare-batch' && (!equal(request.batch, batch) || result.jobRevision !== '2' || result.phase !== 'running')
      || operation === 'commit-batch' && (request.batchId !== batch.batchId || !equal(result, origin.job))) return corrupt();
  }
  const checkpoint = db.prepare('SELECT data FROM local_scan_checkpoints WHERE id=? AND job_id=? AND batch_id=?').get(origin.checkpointId, job.jobId, batch.batchId);
  if (!checkpoint || !equal(parse(checkpoint.data, isScanCheckpoint).progress, job.progress)) return corrupt();
  return fact;
}

/** 冷开、迁移及隔离备份/恢复全量流式核验；热批提交不调用此函数。 */
export function verifyLocalScanDatabase(db: DatabaseSync): void {
  // 只保留本次完整核验的最多32条语句；每次仍实读SQLite，不缓存行或跨调用续用。
  const statements = new Map<string, StatementSync>();
  const prepare = (sql: string): StatementSync => {
    const saved = statements.get(sql);
    if (saved) return saved;
    const statement = db.prepare(sql);
    if (statements.size >= 32) statements.delete(statements.keys().next().value!);
    statements.set(sql, statement);
    return statement;
  };
  scanAudits.delete(db); discardScanOriginIndex(db);
  const originIndex = createScanOriginIndex(), originStartedAtMs = performance.now();
  const initialVersion = scanDataVersion(db); const counts = new Map<Table, number>(); let bytes = 0;
  if (prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' || prepare('PRAGMA foreign_key_check').get()) return corrupt();
  for (const [name, sql] of Object.entries(tables)) if (prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name)?.sql !== sql) return corrupt();
  for (const [type, statements] of [['index', indexes], ['trigger', triggers]] as const) for (const sql of statements) {
    const name = sql.split(' ')[2]!; if (prepare('SELECT sql FROM sqlite_master WHERE type=? AND name=?').get(type, name)?.sql !== sql) return corrupt();
  }
  const hasCue=cueSchema(db);
  for (const table of [...Object.keys(tables),...(hasCue ? Object.keys(cueTables):[])] as Table[]) {
    const count = Number(prepare(`SELECT count(*) n FROM ${table}`).get()?.n); checkScanBudget(`${table}行数`, count, budgets[table]); counts.set(table, count);
    const columns = prepare(`PRAGMA table_info(${table})`).all().filter(c => c.type === 'TEXT').map(c => String(c.name));
    const size = columns.map(c => `COALESCE(length(CAST(${c} AS BLOB)),0)`).join('+');
    const resources = prepare(`SELECT COALESCE(max(${size}),0) largest,COALESCE(sum(${size}),0) bytes FROM ${table}`).get()!;
    checkScanBudget(`${table}单行文本字节`, Number(resources.largest), 16 * 1024 * 1024); bytes += Number(resources.bytes);
  }
  checkScanBudget('全域文本字节', bytes, 64 * 1024 * 1024 * 1024);
  const jobs = new Map<string, dto.ScanJobRecord>();
  const latest = new Map<string, dto.ScanJobRecord>();
  for (const row of prepare('SELECT * FROM local_scan_jobs ORDER BY rowid').iterate()) {
    const job = parse(row.data, dto.isScanJobRecord, 65_536);
    if (row.id !== job.jobId || row.dataset_id !== job.datasetId || row.library_root_id !== job.libraryRootId
      || row.source_root_id !== job.sourceRootId || !text(row.parser_version)) return corrupt();
    // 历史任务不要求来源仍授权；当前根可以已重关联，恢复不能复活旧许可。
    if (!prepare('SELECT id FROM local_catalog_roots WHERE id=?').get(job.libraryRootId)
      || !prepare('SELECT id FROM source_roots WHERE id=?').get(job.sourceRootId)) return corrupt();
    jobs.set(job.jobId, job);
  }
  for (const row of prepare('SELECT * FROM local_scan_receipts ORDER BY rowid').iterate()) {
    const operation = row.operation as ScanReceiptOperation;
    const request = parse(row.request, (v): v is Row & { commandId: string; jobId: string } => isScanReceiptRequest(operation, v));
    const result = parse(row.result, dto.isScanJobRecord, 65_536), current = jobs.get(result.jobId), previous = latest.get(result.jobId);
    if (row.command_id !== request.commandId || row.job_id !== request.jobId || result.jobId !== request.jobId
      || !hash(row.fingerprint) || row.fingerprint !== scanFingerprint(operation, request) || !current
      || result.datasetId !== current.datasetId || result.libraryRootId !== current.libraryRootId || result.sourceRootId !== current.sourceRootId
      || result.rootRevision !== current.rootRevision || !text(row.created_at) || !Number.isFinite(Date.parse(row.created_at))) return corrupt();
    if (!previous) {
      if (operation !== 'start' || result.jobRevision !== '1' || result.phase !== 'pending' || result.checkpointRef !== null) return corrupt();
    } else if ((operation === 'prepare-batch' || operation === 'abandon-batch' || operation === 'discover')) {
      if (!equal(previous, result)) return corrupt();
    } else if (BigInt(result.jobRevision) !== BigInt(previous.jobRevision) + 1n) return corrupt();
    if (previous && operation !== 'prepare-batch' && operation !== 'start' && request.expectedRevision !== previous.jobRevision) return corrupt();
    if (operation === 'start' && (request.datasetId !== result.datasetId || request.libraryRootId !== result.libraryRootId || request.expectedRootRevision !== result.rootRevision)) return corrupt();
    if (operation === 'prepare-batch' && record(request.batch) && request.batch.expectedJobRevision !== result.jobRevision) return corrupt();
    if (operation === 'discover' && (!isScanDiscovery(request.discovery) || request.discovery.checkpointBefore !== result.checkpointRef || result.phase !== 'running')) return corrupt();
    if (operation === 'pause' && result.phase !== 'paused' || operation === 'resume' && result.phase !== 'running'
      || operation === 'cancel' && result.phase !== 'cancelled' || operation === 'recover' && result.phase !== 'paused'
      || operation === 'fail' && (result.phase !== 'failed' || result.failureCode !== request.code)) return corrupt();
    if (operation === 'abandon-batch') {
      if (!dto.isCollectionId(request.batchId)) return corrupt();
      const abandoned = prepare("SELECT request FROM local_scan_batches WHERE id=? AND job_id=? AND phase='prepared'").get(request.batchId,result.jobId);
      if (!abandoned || parse(abandoned.request,isScanPreparedBatch).checkpointBefore !== result.checkpointRef) return corrupt();
    }
    latest.set(result.jobId, result);
  }
  for (const [id, job] of jobs) if (!equal(job, latest.get(id))) return corrupt();
  for (const row of prepare('SELECT rowid AS _origin_ordinal,* FROM local_scan_batches ORDER BY rowid').iterate()) {
    const batch = parse(row.request, isScanPreparedBatch), job = jobs.get(batch.jobId);
    if(batch.kind === 'cue-sidecars-v1' && !hasCue) return corrupt();
    const parserVersion = job ? prepare('SELECT parser_version FROM local_scan_jobs WHERE id=?').get(job.jobId)?.parser_version : undefined;
    if (!job || row.id !== batch.batchId || row.job_id !== batch.jobId || row.fingerprint !== scanFingerprint('batch', batch)
      || batch.items.some(item => !scanItemMatchesParser(item, parserVersion))) return corrupt();
    if (batch.checkpointBefore !== null && !prepare('SELECT id FROM local_scan_checkpoints WHERE id=? AND job_id=?').get(batch.checkpointBefore, job.jobId)) return corrupt();
    const prepared = prepare("SELECT request FROM local_scan_receipts WHERE job_id=? AND operation='prepare-batch' AND json_extract(request,'$.batch.batchId')=?").get(job.jobId, batch.batchId);
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
        const registered = prepare('SELECT request,result FROM local_catalog_ledger WHERE command_id=? AND operation=?').get(childCommand(batch.batchId, index, 'register-asset'), 'register-asset');
        const replaced = prepare('SELECT request,result FROM local_catalog_ledger WHERE command_id=? AND operation=?').get(childCommand(batch.batchId, index, 'replace-asset'), 'replace-asset');
        const relocated = verifyRelocationOrigin(db, job, batch, index, file);
        if (relocated && (registered || replaced || prepare('SELECT command_id FROM local_catalog_ledger WHERE command_id IN (?,?)').get(childCommand(batch.batchId, index, 'create-track'), childCommand(batch.batchId, index, 'observe-metadata')))) return corrupt();
        if (registered || replaced) {
          const child = registered ?? replaced!; const childRequest = JSON.parse(String(child.request)) as Row;
          const childAsset = parse(child.result, dto.isAudioAsset);
          if (item.outcome !== 'accepted' || item.reused || childAsset.id !== file.assetId || childRequest.libraryRootId !== job.libraryRootId
            || childRequest.expectedRootRevision !== job.rootRevision || childRequest.relative !== item.relative || childRequest.sha256 !== null
            || childRequest.sampleFrames !== null || childRequest.timebaseHz !== null) return corrupt();
          if (registered) {
            const created = prepare('SELECT result FROM local_catalog_ledger WHERE command_id=? AND operation=?').get(childCommand(batch.batchId, index, 'create-track'), 'create-track');
            if (!created) return corrupt(); const track = parse(created.result, dto.isLocalTrack);
            if (track.id !== file.trackId || track.assetId !== file.assetId || track.segment !== null) return corrupt();
          }
        }
        const observed = prepare('SELECT result FROM local_catalog_ledger WHERE command_id=? AND operation=?').get(childCommand(batch.batchId, index, 'observe-metadata'), 'observe-metadata');
        if (observed) { const value = parse(observed.result, dto.isLocalMetadataObservation);
          if (item.outcome !== 'accepted' || item.reused || value.trackId !== file.trackId || value.source !== 'tag'
            || value.parserVersion !== item.parserVersion || !equal(value.fields, item.fields)) return corrupt();
        }
      }
      const checkpoint = prepare('SELECT * FROM local_scan_checkpoints WHERE batch_id=? AND job_id=?').get(batch.batchId, batch.jobId);
      if (!checkpoint || result.jobId !== batch.jobId || result.checkpointRef !== checkpoint.id
        || batch.completed !== (result.phase === 'completed')) return corrupt();
      const committed = prepare("SELECT request,result FROM local_scan_receipts WHERE job_id=? AND operation='commit-batch' AND json_extract(request,'$.batchId')=?").get(batch.jobId, batch.batchId);
      if (!committed || !equal(parse(committed.result, dto.isScanJobRecord), result)) return corrupt();
      const committedRequest = parse(committed.request, (v): v is Row & { commandId: string; jobId: string } => isScanReceiptRequest('commit-batch', v));
      if (BigInt(result.jobRevision) !== BigInt(String(committedRequest.expectedRevision)) + 1n) return corrupt();
      addScanOriginBatch(originIndex, { ordinal: Number(row._origin_ordinal), batchId: batch.batchId, jobId: batch.jobId }, job.libraryRootId, batch.items, committedBatch.files);
    } else return corrupt();
  }
  for (const row of prepare('SELECT * FROM local_scan_checkpoints ORDER BY rowid').iterate()) {
    const checkpoint = parse(row.data, isScanCheckpoint);
    const batchRow = prepare("SELECT request,result FROM local_scan_batches WHERE id=? AND job_id=? AND phase='committed'").get(checkpoint.batchId, checkpoint.jobId);
    if (!batchRow || row.id !== checkpoint.checkpointId || row.job_id !== checkpoint.jobId || row.batch_id !== checkpoint.batchId) return corrupt();
    const batch = parse(batchRow.request, isScanPreparedBatch), result = parse(batchRow.result, isScanCommittedBatch).job;
    if (!equal(batch.frontier, checkpoint.frontier) || !equal(result.progress, checkpoint.progress) || result.checkpointRef !== checkpoint.checkpointId) return corrupt();
    const prior = batch.checkpointBefore === null ? null : prepare('SELECT data FROM local_scan_checkpoints WHERE id=?').get(batch.checkpointBefore);
    const previous = prior ? parse(prior.data, isScanCheckpoint) : null;
    const counted=batchCount(batch), accepted = BigInt(counted.filter(item => item.outcome === 'accepted').length), rejected = BigInt(counted.length) - accepted;
    if (BigInt(checkpoint.sequence) !== (previous ? BigInt(previous.sequence) : 0n) + 1n
      || BigInt(checkpoint.progress.visited) !== (previous ? BigInt(previous.progress.visited) : 0n) + BigInt(counted.length)
      || BigInt(checkpoint.progress.accepted) !== (previous ? BigInt(previous.progress.accepted) : 0n) + accepted
      || BigInt(checkpoint.progress.rejected) !== (previous ? BigInt(previous.progress.rejected) : 0n) + rejected) return corrupt();
  }
  for (const job of jobs.values()) if (job.checkpointRef !== null) {
    const checkpoint = prepare('SELECT data FROM local_scan_checkpoints WHERE id=? AND job_id=?').get(job.checkpointRef, job.jobId);
    if (!checkpoint || !equal(parse(checkpoint.data, isScanCheckpoint).progress, job.progress)) return corrupt();
  }
  // 仅本次同步冷核有效。每行仍实读原batch，原始文本完全一致才复用已通过原guard的对象。
  const fileBatchMemo = new Map<string, { request: string; result: string; batch: ScanPreparedBatch; committed: ScanCommittedBatch; bytes: number; allocation: number }>();
  const memoMaxEntries = 64, memoMaxBytes = 4 * 1024 * 1024, memoMaxAllocation = 32 * 1024 * 1024;
  let memoBytes = 0, memoAllocation = 0, peakMemoAllocation = 0, peakMemoEntries = 0, parsedFileBatches = 0, uncachedFileBatches = 0, verifiedFileRows = 0;
  const fileStateStarted = performance.now();
  for (const row of prepare('SELECT * FROM local_scan_file_state ORDER BY rowid').iterate()) {
    const state = parse(row.data, isScanFileState, 65_536), job = jobs.get(String(row.job_id));
    const batchRow = prepare("SELECT request,result FROM local_scan_batches WHERE id=? AND job_id=? AND phase='committed'").get(String(row.batch_id), String(row.job_id));
    if (!job || !batchRow || row.library_root_id !== state.libraryRootId || state.libraryRootId !== job.libraryRootId
      || row.relative !== state.relative || row.asset_id !== state.assetId || row.track_id !== state.trackId) return corrupt();
    const memoKey = JSON.stringify([row.job_id, row.batch_id]);
    let memo = fileBatchMemo.get(memoKey);
    if (memo && (memo.request !== batchRow.request || memo.result !== batchRow.result)) {
      fileBatchMemo.delete(memoKey); memoBytes -= memo.bytes; memoAllocation -= memo.allocation; memo = undefined;
    }
    const committed = memo?.committed ?? parse(batchRow.result, isScanCommittedBatch);
    const committedFile = committed.files.find(file => file.relative === state.relative);
    if (!committedFile || !equal(committedFile, state)&&!equal(sourceUpdatedScanState(db,row,committedFile),state)) return corrupt();
    const batch = memo?.batch ?? parse(batchRow.request, isScanPreparedBatch);
    const item = batch.items.find(item => item.relative === state.relative);
    if (!item || item.signature !== committedFile.signature || item.parserVersion !== state.parserVersion || item.outcome !== state.outcome || item.failureCode !== state.failureCode) return corrupt();
    if (memo) { fileBatchMemo.delete(memoKey); fileBatchMemo.set(memoKey, memo); }
    else {
      parsedFileBatches++;
      // 原parse已核两份string和各自8MiB上限；估算同时覆盖UTF16文本、解析树与Map条目，不扩大原JSON预算。
      const textBytes = Buffer.byteLength(String(batchRow.request)) + Buffer.byteLength(String(batchRow.result));
      const keyBytes = Buffer.byteLength(memoKey), bytes = textBytes + keyBytes, allocation = textBytes * 16 + keyBytes * 2 + 4096;
      if (bytes <= memoMaxBytes && allocation <= memoMaxAllocation) {
        while (fileBatchMemo.size && (fileBatchMemo.size >= memoMaxEntries || memoBytes + bytes > memoMaxBytes || memoAllocation + allocation > memoMaxAllocation)) {
          const oldest = fileBatchMemo.keys().next().value!, prior = fileBatchMemo.get(oldest)!;
          fileBatchMemo.delete(oldest); memoBytes -= prior.bytes; memoAllocation -= prior.allocation;
        }
        fileBatchMemo.set(memoKey, { request: String(batchRow.request), result: String(batchRow.result), batch, committed, bytes, allocation });
        memoBytes += bytes; memoAllocation += allocation;
        peakMemoAllocation = Math.max(peakMemoAllocation, memoAllocation); peakMemoEntries = Math.max(peakMemoEntries, fileBatchMemo.size);
      } else uncachedFileBatches++;
    }
    if (state.outcome === 'accepted') {
      const asset = prepare('SELECT root_id,relative FROM local_catalog_assets WHERE id=?').get(state.assetId!);
      const track = prepare('SELECT asset_id FROM local_catalog_tracks WHERE id=?').get(state.trackId!);
      // 后续人工选择/重定位不会改写扫描历史；仅核稳定实体仍存在。
      if (!asset || !track) return corrupt();
    }
    verifiedFileRows++;
  }
  fileBatchMemo.clear();
  if (verifiedFileRows) logLibraryOperation('cache', 'scan.verify-file-state.memo', 'complete', { code: 'BOUNDED_BATCH_JSON', count: parsedFileBatches,
    total: verifiedFileRows, bytes: peakMemoAllocation, active: peakMemoEntries, elapsedMs: performance.now() - fileStateStarted });
  if (uncachedFileBatches) logLibraryOperation('cache', 'scan.verify-file-state.memo', 'skipped', { code: 'CAPACITY', count: uncachedFileBatches, total: parsedFileBatches });
  if(hasCue) {
    const priorCue=new Map<string,CueSnapshot>();
    for(const row of prepare('SELECT * FROM local_cue_sources ORDER BY rowid').iterate()) {
      const snapshot=parse(row.data,isCueSnapshot),parent=prepare("SELECT request,result FROM local_scan_batches WHERE id=? AND phase='committed'").get(String(row.batch_id));
      if(!parent || snapshot.id !== row.id || snapshot.sidecarId !== row.sidecar_id || snapshot.libraryRootId !== row.library_root_id || snapshot.item.relative !== row.relative) return corrupt();
      const key=scanCanonical([snapshot.libraryRootId,snapshot.item.relative]),prior=priorCue.get(key);
      if(snapshot.item.previousSnapshotId !== (prior?.id ?? null) || prior && snapshot.sidecarId !== prior.sidecarId || snapshot.item.reused) return corrupt();priorCue.set(key,snapshot);
      const batch=parse(parent.request,isScanPreparedBatch),result=parse(parent.result,isScanCommittedBatch),job=jobs.get(batch.jobId);
      if(!job || batch.kind !== 'cue-sidecars-v1' || !result.cueSnapshotIds?.includes(snapshot.id)) return corrupt();verifyCueBatch(db,batch,result,job);
      if(snapshot.item.result?.tracks.some(track=>track.assetReference.libraryRootId !== snapshot.libraryRootId || track.assetReference.sourceRootId !== snapshot.sourceRootId || track.assetReference.rootRevision !== snapshot.rootRevision)) return corrupt();
    }
    for(const row of prepare('SELECT * FROM local_cue_tracks ORDER BY rowid').iterate()) {
      const source=prepare('SELECT data FROM local_cue_sources WHERE id=?').get(String(row.snapshot_id));if(!source) return corrupt();
      const tracks=parse(source.data,isCueSnapshot).item.result?.tracks ?? [];
      if(typeof row.ordinal !== 'number' || !Number.isSafeInteger(row.ordinal) || row.ordinal<0 || row.ordinal>=tracks.length
        || row.asset_id !== tracks[row.ordinal]!.assetReference.assetId || !equal(JSON.parse(String(row.data)),tracks[row.ordinal])) return corrupt();
    }
  }
  for (const event of relocationProjectionForDatabase(db)?.events ?? []) if (event.kind === 'location-facts') {
    const fact = event.fact, job = jobs.get(fact.scan.origin.job.jobId);
    const row = prepare("SELECT request,result FROM local_scan_batches WHERE id=? AND job_id=? AND phase='committed'").get(fact.scan.origin.batchId, fact.scan.origin.job.jobId);
    if (!job || !row) return corrupt();
    const batch = parse(row.request, isScanPreparedBatch), files = parse(row.result, isScanCommittedBatch).files;
    const file = files[fact.scan.origin.itemIndex]; if (!file || !verifyRelocationOrigin(db, job, batch, fact.scan.origin.itemIndex, file)) return corrupt();
  }
  verifyCompletedScanSnapshotDatabase(db);
  if (scanDataVersion(db) !== initialVersion) return corrupt();
  scanAudits.set(db, { rows: counts, bytes, dataVersion: initialVersion });
  stageScanOriginIndex(db, originIndex);
  logLibraryOperation('cache', 'scan.origin-index', originIndex.overflow ? 'skipped' : 'complete', {
    elapsedMs: performance.now() - originStartedAtMs, count: originIndex.entries.size, bytes: originIndex.bytes,
    ...(originIndex.overflow ? { code: 'BUDGET_EXCEEDED' } : {}),
  });
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
  return () => { audit.publish(); audit.publishOrigins(); };
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
/** 复用原扫描当前位置解析；只在原Owner的guarded连接中调用。 */
interface ResolvedCurrentScanFileState { row: Row; state: ScanFileState }
function resolveCurrentScanFileState(db: DatabaseSync, libraryRootId: string, relative: string, conflict: (message: string) => never): ResolvedCurrentScanFileState | null {
    const locators = scanReadStatement(db, 'SELECT id FROM local_catalog_assets WHERE root_id=? AND relative=? LIMIT 2').all(libraryRootId,relative);
    if(locators.length>1) return conflict('当前位置有多个独立资产，不能根据同名或路径自动合并。');
    const direct = scanReadStatement(db, 'SELECT * FROM local_scan_file_state WHERE library_root_id=? AND relative=?').get(libraryRootId, relative);
    if (direct) {
      const state = parse(direct.data, isScanFileState, 65_536);
      if (state.assetId === null) return { row: direct, state };
      const locator = scanReadStatement(db, 'SELECT root_id,relative FROM local_catalog_assets WHERE id=?').get(state.assetId);
      if (locator?.root_id === libraryRootId && locator.relative === relative) return { row: direct, state };
    }
    if (locators.length === 0) return null;
    // 两行sentinel拒歧义；root/relative及asset_id均为私有索引，不能每个新path全库回放。
    const rows = scanReadStatement(db, `SELECT s.* FROM local_catalog_assets a JOIN local_scan_file_state s ON s.asset_id=a.id
      WHERE a.root_id=? AND a.relative=? AND s.library_root_id=? AND s.track_id IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM local_scan_file_state newer WHERE newer.asset_id=s.asset_id AND newer.track_id=s.track_id AND newer.rowid>s.rowid)
      ORDER BY s.rowid DESC LIMIT 2`).all(libraryRootId, relative, libraryRootId);
    if (rows.length > 1) return conflict('当前文件位置存在多个独立资产或曲目候选，不能自动合并。');
    if (!rows[0]) return null;
    const state = parse(rows[0].data, isScanFileState, 65_536);
    if (state.libraryRootId !== libraryRootId || state.assetId === null || state.trackId === null) return corrupt();
    return { row: rows[0], state };
}
// 旧扫描入口仍只取得原row；解析对象仅在这次同步调用栈内返回，不保留到下次读取。
function currentScanFileStateRow(db: DatabaseSync, libraryRootId: string, relative: string, conflict: (message: string) => never): Row | null {
  return resolveCurrentScanFileState(db, libraryRootId, relative, conflict)?.row ?? null;
}
export function readLocalAlbumScanState(db: DatabaseSync, libraryRootId: string, relative: string, conflict: (message: string) => never): ScanFileState | null {
  return resolveCurrentScanFileState(db, libraryRootId, relative, conflict)?.state ?? null;
}
/** 同一原SQL投影只消除常见direct路径的嵌套JS查询；历史位置仍由原resolver完整解析。 */
export function readLocalAlbumScanStateProjected(db: DatabaseSync, libraryRootId: string, relative: string,
  directData: unknown, locatorCount: unknown, assetRootId: unknown, assetRelative: unknown,
  conflict: (message: string) => never): ScanFileState | null {
  if (locatorCount !== 0 && locatorCount !== 1 && locatorCount !== 2) return readLocalAlbumScanState(db, libraryRootId, relative, conflict);
  // 原resolver在读取/解析direct前拒绝同位置资产歧义，投影快路必须保持相同先后次序。
  if (locatorCount > 1) return conflict('当前位置有多个独立资产，不能根据同名或路径自动合并。');
  if (directData !== null && directData !== undefined) {
    const state = parse(directData, isScanFileState, 65_536);
    if (state.assetId === null || assetRootId === libraryRootId && assetRelative === relative) return state;
  }
  return readLocalAlbumScanState(db, libraryRootId, relative, conflict);
}
export function readLocalAlbumCueSnapshot(raw: unknown): CueSnapshot { return parse(raw, isCueSnapshot, 65_536); }
export function createLocalScanStore(access: ScanAccess) {
  let relocationAuthor: RelocationScanAuthor | undefined;
  interface DisplayBatchMemo { batch: ScanPreparedBatch; textBytes: number; allocationBytes: number }
  interface DisplayReadFrame { db: DatabaseSync | null; busy: boolean; batches: Map<string, DisplayBatchMemo> }
  let displayFrame: DisplayReadFrame | undefined;
  let displayEntries = 0, displayTextBytes = 0, displayAllocationBytes = 0;
  const displayEntryLimit = 64, displayTextLimit = 4 * 1024 * 1024, displayAllocationLimit = 32 * 1024 * 1024;
  function removeDisplayBatch(frame: DisplayReadFrame, key: string): void {
    const saved = frame.batches.get(key); if (!saved) return;
    frame.batches.delete(key); displayEntries--; displayTextBytes -= saved.textBytes; displayAllocationBytes -= saved.allocationBytes;
  }
  function clearDisplayFrame(frame: DisplayReadFrame): void {
    for (const key of frame.batches.keys()) removeDisplayBatch(frame, key);
  }
  function withDisplayFrame<T>(db: DatabaseSync | null, read: (frame: DisplayReadFrame) => T): T {
    const previous = displayFrame, frame: DisplayReadFrame = { db, busy: false, batches: new Map() };
    displayFrame = frame;
    try { return read(frame); }
    finally { clearDisplayFrame(frame); displayFrame = previous; }
  }
  function displayRead<T>(read: (frame: DisplayReadFrame) => T): T {
    const run = (frame: DisplayReadFrame): T => {
      frame.busy = true;
      try { return read(frame); } finally { frame.busy = false; }
    };
    // 重入不是同页下一行，不能借用进行中的调用帧；每次退出都恢复原同步栈。
    return displayFrame && !displayFrame.busy ? run(displayFrame) : withDisplayFrame(null, run);
  }
  function displayBatch(frame: DisplayReadFrame, db: DatabaseSync, raw: unknown): ScanPreparedBatch {
    if (typeof raw !== 'string') return corrupt();
    const textBytes = Buffer.byteLength(raw); if (textBytes > 8 * 1024 * 1024) return corrupt();
    if (frame.db === null) frame.db = db;
    if (frame.db !== db) return parse(raw, isScanPreparedBatch);
    const saved = frame.batches.get(raw);
    if (saved) { frame.batches.delete(raw); frame.batches.set(raw, saved); return saved.batch; }
    const batch = parse(raw, isScanPreparedBatch);
    // 只保留本函数从完整原文新解析并通过原guard的私有树；不接收调用者对象或外露内部片段。
    const allocationBytes = textBytes * 18 + 4096;
    if (textBytes > displayTextLimit || allocationBytes > displayAllocationLimit) return batch;
    while (frame.batches.size && (displayEntries >= displayEntryLimit || displayTextBytes + textBytes > displayTextLimit
      || displayAllocationBytes + allocationBytes > displayAllocationLimit)) removeDisplayBatch(frame, frame.batches.keys().next().value!);
    // 全部活动嵌套帧共用上限；子帧不能驱逐父帧或突破上限，超出时沿原完整解析路径。
    if (displayEntries >= displayEntryLimit || displayTextBytes + textBytes > displayTextLimit
      || displayAllocationBytes + allocationBytes > displayAllocationLimit) return batch;
    const pending: object[] = [batch];
    while (pending.length) {
      const value = pending.pop()!;
      for (const child of Object.values(value)) if (typeof child === 'object' && child !== null) pending.push(child);
      Object.freeze(value);
    }
    frame.batches.set(raw, { batch, textBytes, allocationBytes }); displayEntries++;
    displayTextBytes += textBytes; displayAllocationBytes += allocationBytes;
    return batch;
  }
  const get = (db: DatabaseSync, jobId: string): dto.ScanJobRecord => {
    if (!dto.isCollectionId(jobId)) return access.conflict('扫描任务身份无效。');
    const row = scanReadStatement(db, 'SELECT data FROM local_scan_jobs WHERE id=?').get(jobId);
    return row ? parse(row.data, dto.isScanJobRecord, 65_536) : access.conflict('扫描任务不存在。');
  };
  /** 原扫描与专辑读取共用同一位置解析，重定位后保留原事实身份。 */
  function currentFileState(db: DatabaseSync, libraryRootId: string, relative: string): Row | null {
    return currentScanFileStateRow(db, libraryRootId, relative, access.conflict);
  }
  function current(job: dto.ScanJobRecord): dto.LibraryRoot {
    if(!access.catalog.privateLibraryManagementRootAvailable(job.libraryRootId))return access.conflict('原库已持久撤销或正在撤销，原scan批保留，不能迟到提交。');
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
      const delta = beginLocalAlbumScanDelta(db);
      db.exec('BEGIN IMMEDIATE');
      try {
        const audit = scanAuditFor(db), result = body(db, audit); if (result instanceof Promise) return corrupt();
        recordLocalAlbumScanWrites(delta, audit.writes());
        access.beforeCommit?.(`local-scan:${operation}`);
        approveLocalAlbumScanDelta(db, delta);
        db.exec('COMMIT'); audit.publish(); publishLocalAlbumScanDelta(db, delta); audit.publishOrigins(); return result;
      } catch (error) { discardLocalAlbumScanDelta(delta); db.exec('ROLLBACK'); throw error; }
    });
  }
  function transition(operation: 'pause' | 'resume' | 'cancel', request: ScanTransition & { cause?: ScanAutomaticPauseCause }): dto.ScanJobRecord {
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
    /** 同连接安装原Scanner作者；外层catalog短事务才可消费真实Reader准备的私有ticket。 */
    privateInstallRelocationScanAuthor(
      prepare: (request: RelocationScanReadRequest, readAccess: RelocationReadAccess, signal: AbortSignal) => Promise<unknown>,
      consume: (context: RelocationCatalogCommitContext, prepared: unknown) => readonly RelocationPreparedScanRead[],
    ): void {
      access.read(db => {
        if (relocationAuthor) return access.conflict('原移动扫描作者已经安装，不允许替换。');
        relocationAuthor = {
          prepare,
          commit(context, prepared): RelocationScanDelta {
            const reads = consume(context, prepared);
            if (!Array.isArray(reads) || reads.length !== context.mappings.length || reads.length === 0 || reads.length > 100
              || context.afterAssets.length !== reads.length || new Set(reads.map(read => read.mapping.beforeAsset.id)).size !== reads.length) return corrupt();
            const audit = scanAuditFor(db), beforeChanges = Number(db.prepare('SELECT total_changes() n').get()!.n);
            const groups = new Map<string, { read: RelocationPreparedScanRead; asset: dto.AudioAsset }[]>();
            for (const [index, read] of reads.entries()) {
              const mapping = context.mappings[index]!, afterAsset = context.afterAssets[index]!;
              if (!equal(read.mapping, mapping) || !isScanPreparedItem(read.item) || read.item.reused || read.item.outcome !== 'accepted'
                || !read.item.readFacts || read.item.relative !== mapping.destination.relative
                || !mapping.tracks.some(track => track.id === read.primaryTrackId) || !dto.isAudioAsset(afterAsset)
                || afterAsset.id !== mapping.beforeAsset.id || afterAsset.libraryRootId !== mapping.destination.libraryRootId
                || afterAsset.sourceRootId !== mapping.destination.sourceRootId || afterAsset.rootRevision !== mapping.destination.rootRevision
                || afterAsset.fileRevision !== mapping.beforeAsset.fileRevision || !equal(access.catalog.asset(afterAsset.id), afterAsset)) return corrupt();
              const locator = access.catalog.privateAssetLocator(afterAsset.id);
              if (locator.relative !== read.item.relative) return corrupt();
              for (const track of mapping.tracks) if (!dto.isLocalTrack(track) || track.assetId !== afterAsset.id
                || !equal(access.catalog.track(track.id), track)) return corrupt();
              const key = mapping.destination.libraryRootId, group = groups.get(key) ?? [];
              group.push({ read, asset: afterAsset }); groups.set(key, group);
            }
            const factsByResource = new Map<string, RelocationBoundScanFact>();
            for (const [rootId, group] of groups) {
              const root = access.catalog.root(rootId), firstParser = group[0]!.read.item.parserVersion;
              // 原私有移动读取仍保每件实际parser；新增输入族与混parser的job只记录明确扫描合同。
              const parser = group.every(({ read }) => scanItemMatchesParser(read.item, firstParser)) ? firstParser
                : group.every(({ read }) => scanItemMatchesParser(read.item, CUE_INPUT_SCAN_VERSION)) ? CUE_INPUT_SCAN_VERSION : corrupt();
              if (group.some(({ read }) => read.mapping.destination.sourceRootId !== root.sourceRootId
                || read.mapping.destination.rootRevision !== root.revision || !scanItemMatchesParser(read.item, parser))) return corrupt();
              if (!access.sources.root(root.sourceRootId).authorized) return access.conflict('移动目的根许可已撤销。');
              const jobId = randomUUID(), batchId = randomUUID(), startCommandId = randomUUID(), resumeCommandId = randomUUID(),
                prepareCommandId = randomUUID(), commitCommandId = randomUUID(), checkpointId = randomUUID();
              const startRequest = { commandId: startCommandId, jobId, datasetId: context.datasetId,
                libraryRootId: root.id, expectedRootRevision: root.revision, parserVersion: parser };
              const pending: dto.ScanJobRecord = { schemaVersion: '1.2', jobId, datasetId: context.datasetId,
                libraryRootId: root.id, sourceRootId: root.sourceRootId, rootRevision: root.revision, jobRevision: '1',
                checkpointRef: null, progress: { visited: '0', accepted: '0', rejected: '0' }, phase: 'pending', failureCode: null };
              db.prepare('INSERT INTO local_scan_jobs VALUES(?,?,?,?,?,?)').run(jobId, pending.datasetId, root.id, root.sourceRootId, parser, JSON.stringify(pending));
              audit.replace('local_scan_jobs', null, db.prepare('SELECT * FROM local_scan_jobs WHERE id=?').get(jobId)!);
              putReceipt(db, 'start', startRequest, pending, audit);
              const resumeRequest = { commandId: resumeCommandId, jobId, expectedRevision: '1' };
              const running: dto.ScanJobRecord = { ...pending, jobRevision: '2', phase: 'running' };
              let previousJobRow = db.prepare('SELECT * FROM local_scan_jobs WHERE id=?').get(jobId)!;
              db.prepare('UPDATE local_scan_jobs SET data=? WHERE id=?').run(JSON.stringify(running), jobId);
              audit.replace('local_scan_jobs', previousJobRow, db.prepare('SELECT * FROM local_scan_jobs WHERE id=?').get(jobId)!);
              putReceipt(db, 'resume', resumeRequest, running, audit);
              const batch: ScanPreparedBatch = { batchId, jobId, expectedJobRevision: '2', checkpointBefore: null,
                items: group.map(({ read }) => read.item), frontier: [], completed: true };
              const prepareRequest = { commandId: prepareCommandId, jobId, batch };
              if (!isScanPreparedBatch(batch)) return corrupt();
              db.prepare('INSERT INTO local_scan_batches VALUES(?,?,?,?,?,?)').run(batchId, jobId, scanFingerprint('batch', batch), JSON.stringify(batch), 'prepared', null);
              audit.replace('local_scan_batches', null, db.prepare('SELECT * FROM local_scan_batches WHERE id=?').get(batchId)!);
              putReceipt(db, 'prepare-batch', prepareRequest, running, audit);
              const count = String(group.length), completed: dto.ScanJobRecord = { ...running, jobRevision: '3', checkpointRef: checkpointId,
                progress: { visited: count, accepted: count, rejected: '0' }, phase: 'completed' };
              const files: ScanFileState[] = group.map(({ read, asset }) => ({ libraryRootId: root.id, relative: read.item.relative,
                signature: read.item.signature, parserVersion: read.item.parserVersion, outcome: 'accepted', assetId: asset.id,
                trackId: read.primaryTrackId, failureCode: null, readFacts: read.item.readFacts }));
              const committedBatch: ScanCommittedBatch = { job: completed, files };
              if (!isScanCommittedBatch(committedBatch)) return corrupt();
              const beforeBatch = db.prepare('SELECT * FROM local_scan_batches WHERE id=?').get(batchId)!;
              db.prepare("UPDATE local_scan_batches SET phase='committed',result=? WHERE id=? AND phase='prepared'").run(JSON.stringify(committedBatch), batchId);
              audit.replace('local_scan_batches', beforeBatch, db.prepare('SELECT * FROM local_scan_batches WHERE id=?').get(batchId)!);
              const checkpoint: ScanCheckpoint = { checkpointId, jobId, batchId, sequence: '1', frontier: [], progress: completed.progress };
              db.prepare('INSERT INTO local_scan_checkpoints VALUES(?,?,?,?)').run(checkpointId, jobId, batchId, JSON.stringify(checkpoint));
              audit.replace('local_scan_checkpoints', null, db.prepare('SELECT * FROM local_scan_checkpoints WHERE id=?').get(checkpointId)!);
              previousJobRow = db.prepare('SELECT * FROM local_scan_jobs WHERE id=?').get(jobId)!;
              db.prepare('UPDATE local_scan_jobs SET data=? WHERE id=?').run(JSON.stringify(completed), jobId);
              audit.replace('local_scan_jobs', previousJobRow, db.prepare('SELECT * FROM local_scan_jobs WHERE id=?').get(jobId)!);
              const commitRequest = { commandId: commitCommandId, jobId, batchId, expectedRevision: '2' };
              putReceipt(db, 'commit-batch', commitRequest, completed, audit);
              for (const [itemIndex, state] of files.entries()) {
                const before = db.prepare('SELECT * FROM local_scan_file_state WHERE library_root_id=? AND relative=?').get(root.id, state.relative) ?? null;
                if (before && parse(before.data, isScanFileState, 65536).assetId !== state.assetId) return access.conflict('目的位置已登记另一独立文件，不能覆盖。');
                db.prepare('INSERT INTO local_scan_file_state VALUES(?,?,?,?,?,?,?) ON CONFLICT(library_root_id,relative) DO UPDATE SET job_id=excluded.job_id,batch_id=excluded.batch_id,asset_id=excluded.asset_id,track_id=excluded.track_id,data=excluded.data')
                  .run(root.id, state.relative, jobId, batchId, state.assetId, state.trackId, JSON.stringify(state));
                audit.replace('local_scan_file_state', before, db.prepare('SELECT * FROM local_scan_file_state WHERE library_root_id=? AND relative=?').get(root.id, state.relative)!);
                const mapping = group[itemIndex]!.read.mapping;
                factsByResource.set(mapping.resourceId, { operationId: mapping.operationId, resourceId: mapping.resourceId,
                  origin: { job: completed, batchId, startCommandId, startFingerprint: scanFingerprint('start', startRequest),
                    resumeCommandId, resumeFingerprint: scanFingerprint('resume', resumeRequest), prepareCommandId,
                    prepareFingerprint: scanFingerprint('prepare-batch', prepareRequest), commitCommandId,
                    commitFingerprint: scanFingerprint('commit-batch', commitRequest), checkpointId, itemIndex }, state });
              }
            }
            const facts = context.mappings.map(mapping => factsByResource.get(mapping.resourceId)!);
            if (facts.some(fact => !fact)) return corrupt();
            return { facts, changedRows: Number(db.prepare('SELECT total_changes() n').get()!.n) - beforeChanges,
              publish: () => audit.publish() };
          },
        };
        installRelocationScanPort(db, relocationAuthor);
      });
    },
    start(request: StartScan): { job: dto.ScanJobRecord; created: boolean } {
      if (!record(request) || !closed(request, ['commandId', 'datasetId', 'libraryRootId', 'expectedRootRevision', 'parserVersion'])
        || !dto.isCollectionId(request.commandId) || !dto.isCollectionId(request.datasetId) || !dto.isCollectionId(request.libraryRootId)
        || !dto.isLocalCatalogRevision(request.expectedRootRevision) || !text(request.parserVersion)) return access.conflict('扫描创建请求无效。');
      return transaction('start', (db, audit) => {
        const previous = db.prepare('SELECT request FROM local_scan_receipts WHERE command_id=?').get(request.commandId);
        const jobId = previous ? parse(previous.request, (v): v is Row & { commandId: string; jobId: string } => isScanReceiptRequest('start', v)).jobId : randomUUID();
        const full = { ...request, jobId }, saved = savedReceipt(db, 'start', full); if (saved) return { job: saved, created: false };
        if(!access.catalog.privateLibraryManagementRootAvailable(request.libraryRootId))return access.conflict('原库已持久撤销或正在撤销，不能创建新扫描。');
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
    /** 扫描器只读原持久job的解析合同，不从公开DTO或当前开关猜旧任务版本。 */
    privateJobParserVersion(jobId: string): string {
      if (!dto.isCollectionId(jobId)) return access.conflict('扫描任务身份无效。');
      return access.read(db => {
        const job = get(db, jobId), version = db.prepare('SELECT parser_version FROM local_scan_jobs WHERE id=?').get(job.jobId)?.parser_version;
        return text(version) ? version : corrupt();
      });
    },
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
    /** 公开 pause 无 cause，始终代表 Owner 手动暂停；内部让路/离线另留不可变原因。 */
    privatePause(request: ScanTransition & { cause: ScanAutomaticPauseCause }) { return transition('pause', request); },
    resume(request: ScanTransition) { return transition('resume', request); },
    cancel(request: ScanTransition) { return transition('cancel', request); },
    /** 只恢复可证明由系统中断的任务；原手动 pause 收据没有 cause，绝不按 paused 一概恢复。 */
    privateAutomaticResumePage(datasetId: string, afterRow = 0, limit = 200): { items: dto.ScanJobRecord[]; nextRow: number; hasMore: boolean } {
      if (!dto.isCollectionId(datasetId) || !Number.isSafeInteger(afterRow) || afterRow < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200)
        return access.conflict('扫描恢复清单范围无效。');
      return access.read(db => {
        const rows = db.prepare(`SELECT j.rowid AS ordinal,j.data FROM local_scan_jobs j
          JOIN local_scan_receipts r ON r.rowid=(SELECT max(rowid) FROM local_scan_receipts WHERE job_id=j.id)
          WHERE j.dataset_id=? AND j.rowid>? AND (json_extract(j.data,'$.phase') IN ('pending','running')
            OR json_extract(j.data,'$.phase')='paused' AND (r.operation='recover' OR r.operation='pause' AND json_extract(r.request,'$.cause') IN ('media-busy','admission-closed','deferred','source-offline')))
          ORDER BY j.rowid LIMIT ?`).all(datasetId, afterRow, limit + 1);
        const selected = rows.slice(0, limit);
        return { items: selected.map(row => parse(row.data, dto.isScanJobRecord, 65_536)), nextRow: selected.length ? Number(selected.at(-1)!.ordinal) : afterRow, hasMore: rows.length > limit };
      });
    },
    privateRecordDiscovery(request: { commandId: string; jobId: string; expectedRevision: string; discovery: ScanDiscovery }): void {
      if (!isScanReceiptRequest('discover', request)) return access.conflict('扫描发现清单无效。');
      transaction('discover', (db, audit) => {
        if (savedReceipt(db, 'discover', request)) return;
        const job = get(db, request.jobId); current(job);
        if (job.phase !== 'running' || job.jobRevision !== request.expectedRevision || request.discovery.checkpointBefore !== job.checkpointRef)
          return access.conflict('扫描发现清单的任务修订或游标已改变。');
        putReceipt(db, 'discover', request, job, audit);
      });
    },
    /** 已提交前缀用原 checkpoint.frontier 对齐；没有关系证明的清单不复用。 */
    privatePendingDiscovery(jobId: string): { discovery: ScanDiscovery; consumed: number } | null {
      return access.read(db => {
        const job = get(db, jobId), row = db.prepare("SELECT request FROM local_scan_receipts WHERE job_id=? AND operation='discover' ORDER BY rowid DESC LIMIT 1").get(jobId);
        if (!row) return null;
        const request = parse(row.request, (v): v is Row & { commandId: string; jobId: string } => isScanReceiptRequest('discover', v));
        const discovery = request.discovery as ScanDiscovery;
        if (discovery.checkpointBefore === job.checkpointRef) return { discovery, consumed: 0 };
        if (job.checkpointRef === null) return null;
        const checkpointRow = db.prepare('SELECT data FROM local_scan_checkpoints WHERE id=? AND job_id=?').get(job.checkpointRef, jobId);
        if (!checkpointRow) return corrupt();
        const checkpoint = parse(checkpointRow.data, isScanCheckpoint);
        if (equal(checkpoint.frontier, discovery.frontier)) return null;
        const consumed = discovery.entries.findIndex(entry => equal(entry.frontier, checkpoint.frontier)) + 1;
        return consumed > 0 ? { discovery, consumed } : null;
      });
    },
    /** CUE 路径直接复用音频发现清单；不再重走完整目录树，也不根据 FILE 文本创建资产。 */
    privateDiscoveredCuePage(jobId: string, cursor: { rowId: number; index: number }, limit = 1): { relatives: string[]; hasMore: boolean; next: { rowId: number; index: number } } {
      if (!record(cursor) || !closed(cursor,['rowId','index']) || !Number.isSafeInteger(cursor.rowId) || cursor.rowId < 0
        || !Number.isSafeInteger(cursor.index) || cursor.index < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) return access.conflict('CUE发现清单分页无效。');
      return access.read(db => {
        get(db, jobId);
        // rowid/keyset 游标只读后续原收据，避免每个CUE都对整份JSON清单GROUP BY/OFFSET。
        const rows = db.prepare(`SELECT e.value AS relative,r.rowid AS discovered,e.key AS ordinal FROM local_scan_receipts r,json_each(r.request,'$.discovery.cueRelatives') e
          WHERE r.job_id=? AND r.operation='discover' AND r.rowid>=? AND (r.rowid>? OR e.key>=?)
          ORDER BY r.rowid,e.key LIMIT ?`).all(jobId, cursor.rowId, cursor.rowId, cursor.index, limit + 1);
        const selected=rows.slice(0,limit),relatives = selected.map(row => row.relative);
        if (!relatives.every(scanRelativePath)) return corrupt();
        const last=selected.at(-1),next=last ? {rowId:Number(last.discovered),index:Number(last.ordinal)+1}:cursor;
        if(!Number.isSafeInteger(next.rowId) || next.rowId<0 || !Number.isSafeInteger(next.index) || next.index<0)return corrupt();
        return { relatives, hasMore: rows.length > limit, next };
      });
    },
    /** 旧CUE-aware checkpoint没有完整发现清单，必须保留原二阶段目录恢复，不能漏掉早先已走过的CUE。 */
    privateUseCueDiscoveryManifest(jobId: string): boolean {
      return access.read(db => {
        const job=get(db,jobId),first=db.prepare("SELECT request FROM local_scan_receipts WHERE job_id=? AND operation='discover' ORDER BY rowid LIMIT 1").get(jobId);
        const checkpointRef=first ? (parse(first.request,(v):v is Row & {commandId:string;jobId:string}=>isScanReceiptRequest('discover',v)).discovery as ScanDiscovery).checkpointBefore:job.checkpointRef;
        if(checkpointRef===null)return true;
        const row=db.prepare('SELECT b.request FROM local_scan_checkpoints c JOIN local_scan_batches b ON b.id=c.batch_id WHERE c.id=? AND c.job_id=?').get(checkpointRef,jobId);
        if(!row)return corrupt();return parse(row.request,isScanPreparedBatch).kind!=='cue-sidecars-v1';
      });
    },
    receipt(commandId: string): dto.LocalScanReceipt | null {
      if (!dto.isCollectionId(commandId)) return access.conflict('扫描回执身份无效。');
      return access.read(db => {
        const row = db.prepare('SELECT * FROM local_scan_receipts WHERE command_id=?').get(commandId); if (!row) return null;
        const operation = row.operation as ScanReceiptOperation;
        // 私有故障/弃批回执只供同owner冷核验和内部重试，不扩公开回执operation。
        if (operation === 'abandon-batch' || operation === 'fail' || operation === 'discover') return null;
        const request = parse(row.request, (v): v is Row & { commandId: string; jobId: string } => isScanReceiptRequest(operation, v));
        const result = savedReceipt(db, operation, request);
        const receipt = { commandId, jobId: request.jobId, operation, fingerprint: String(row.fingerprint), result };
        return dto.isLocalScanReceipt(receipt) ? receipt : corrupt();
      });
    },
    /** 只读消费现有扫描/CUE事实；数量和字节超过范围时拒绝，不制造一次扫描。 */
    privateAlbumBrowserRevision(): string { return access.read(db => albumScanRevision(db)); },
    /** 整理捕获只读指定目录的完整当前事实；未生成track的拒收文件仍保留真实签名。 */
    privateWorkbenchDirectoryFacts(request: LocalWorkbenchDirectoryFactsRequest): LocalWorkbenchDirectoryFacts {
      if (!record(request) || !closed(request, ['expectedRevision','libraryRootId','directories','maxFiles','maxBytes'])
        || !/^[a-f0-9]{64}$/u.test(request.expectedRevision) || !dto.isCollectionId(request.libraryRootId)
        || !Array.isArray(request.directories) || !request.directories.length || request.directories.length > 100
        || new Set(request.directories).size !== request.directories.length || !request.directories.every(value => value === '' || scanRelativePath(value))
        || !Number.isSafeInteger(request.maxFiles) || request.maxFiles < 1 || request.maxFiles > 10_000
        || !Number.isSafeInteger(request.maxBytes) || request.maxBytes < 1 || request.maxBytes > 32 * 1024 * 1024) return access.conflict('整理目录捕获范围无效。');
      return access.read(db => {
        const revision = albumScanRevision(db);
        if (revision !== request.expectedRevision) return access.conflict('整理扫描事实已变化，请重新读取。');
        const libraryRoot = access.catalog.root(request.libraryRootId);
        const bindings = { root: request.libraryRootId, directories: JSON.stringify(request.directories) };
        const directories = `dirs AS (SELECT CASE WHEN value='' THEN '' ELSE value||'/' END prefix,
          CASE WHEN value='' THEN NULL ELSE value||'0' END ceiling FROM json_each(@directories))`;
        // 非根目录先走现有(root_id,relative)/(library_root_id,relative)索引。
        // '/'的下一字节是'0'，范围精确覆盖原目录前缀；通配符与Unicode目录均不改语义。
        // accepted仍按当前asset位置，rejected仍按原scan位置，随后共用原歧义与事实校核。
        const current = `WITH ${directories},current_files AS (
          SELECT s.rowid,s.library_root_id,a.relative FROM dirs CROSS JOIN local_catalog_assets a CROSS JOIN local_scan_file_state s
            WHERE prefix<>'' AND a.root_id=@root AND a.relative>=prefix AND a.relative<ceiling
              AND s.asset_id=a.id AND s.library_root_id=@root
          UNION ALL
          SELECT s.rowid,s.library_root_id,s.relative FROM dirs CROSS JOIN local_scan_file_state s
            WHERE prefix<>'' AND s.library_root_id=@root AND s.asset_id IS NULL AND s.relative>=prefix AND s.relative<ceiling
          UNION ALL
          SELECT s.rowid,s.library_root_id,CASE WHEN s.asset_id IS NULL THEN s.relative ELSE a.relative END relative
            FROM local_scan_file_state s LEFT JOIN local_catalog_assets a ON a.id=s.asset_id
            WHERE s.library_root_id=@root AND (s.asset_id IS NULL OR a.root_id=@root) AND EXISTS(SELECT 1 FROM dirs WHERE prefix='')
          ),members AS (
          SELECT relative FROM current_files WHERE EXISTS(SELECT 1 FROM dirs WHERE substr(relative,1,length(prefix))=prefix
            AND instr(substr(relative,length(prefix)+1),'/')=0) GROUP BY relative)`;
        const count = Number(scanReadStatement(db, `${current} SELECT count(*) n FROM members`).get(bindings)!.n);
        if (count > request.maxFiles) throw new LocalCatalogBudgetError('整理完整目录文件', count, request.maxFiles);
        const result: LocalWorkbenchDirectoryFacts = { revision, files: [], cues: [] };
        const files: LocalWorkbenchDirectoryFacts['files'][number][] = [], cues: LocalWorkbenchDirectoryFacts['cues'][number][] = [];
        let bytes = 0;
        const account = (value: unknown): void => {
          bytes += Buffer.byteLength(JSON.stringify(value), 'utf8');
          if (bytes > request.maxBytes) throw new LocalCatalogBudgetError('整理完整目录事实字节', bytes, request.maxBytes);
        };
        for (const locator of scanReadStatement(db, `${current} SELECT relative FROM members ORDER BY relative LIMIT @limit`).iterate({ ...bindings, limit: request.maxFiles + 1 })) {
          if (typeof locator.relative !== 'string' || !scanRelativePath(locator.relative)) return corrupt();
          const row = currentFileState(db, request.libraryRootId, locator.relative);
          if (!row) return access.conflict('整理当前文件事实未获确认，请重新读取。');
          const value = parse(row.data, isScanFileState, 65_536), job = get(db, String(row.job_id));
          if (value.libraryRootId !== request.libraryRootId || job.libraryRootId !== request.libraryRootId) return corrupt();
          const item = { jobId: job.jobId, rootRevision: libraryRoot.revision, sourceRootId: libraryRoot.sourceRootId, currentRelative: locator.relative, value };
          account(item); files.push(item);
        }
        if (files.length !== count) return access.conflict('整理完整目录成员未获确认。');
        if (cueSchema(db)) {
          const query = `WITH ${directories},latest AS (SELECT max(rowid) ordinal FROM local_cue_sources WHERE library_root_id=@root GROUP BY relative)
            SELECT s.data FROM local_cue_sources s JOIN latest l ON s.rowid=l.ordinal WHERE EXISTS(SELECT 1 FROM dirs
            WHERE substr(s.relative,1,length(prefix))=prefix AND instr(substr(s.relative,length(prefix)+1),'/')=0)`;
          const cueCount = Number(scanReadStatement(db, `SELECT count(*) n FROM (${query})`).get(bindings)!.n);
          if (cueCount + count > request.maxFiles) throw new LocalCatalogBudgetError('整理完整目录扫描/CUE事实', cueCount + count, request.maxFiles);
          for (const row of scanReadStatement(db, `${query} ORDER BY s.rowid LIMIT @limit`).iterate({ ...bindings, limit: request.maxFiles + 1 })) {
            const item = parse(row.data, isCueSnapshot, 65_536); account(item); cues.push(item);
          }
          if (cues.length !== cueCount) return access.conflict('整理完整CUE事实未获确认。');
        }
        if (revision !== albumScanRevision(db)) return access.conflict('整理事实在捕获时已改变，请重新读取。');
        return { ...result, files, cues };
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
    privateRetainedSource(datasetId: string, libraryRootId: string, sourceRootId: string, rootRevision: string, relative: string) {
      if (!dto.isLocalRelocationPlanDatasetId(datasetId) || !dto.isCollectionId(libraryRootId) || !dto.isCollectionId(sourceRootId)
        || !dto.isLocalCatalogRevision(rootRevision) || !scanRelativePath(relative)) return access.conflict('保留源位置身份无效。');
      return access.read(db => {
        const projection = relocationProjectionForDatabase(db), retained = projection?.retainedSources.get(`${datasetId}/${sourceRootId}/${relative}`);
        if (!retained || retained.source.libraryRootId !== libraryRootId || retained.source.expectedRootRevision !== rootRevision) return null;
        const plan = projection!.plans.get(retained.planId), resource = plan?.resources.find(value => value.frozen.resourceId === retained.resourceId);
        if (!plan?.ready || !resource || plan.plan.planHash !== retained.planHash || !resource.frozen.operationIds.includes(retained.operationId)
          || !equal(resource.sourceObservation, retained.observation) || resource.frozen.source.relative !== relative || resource.sourceRoot.id !== sourceRootId) return corrupt();
        return structuredClone(retained);
      });
    },
    privateCurrentFileState(libraryRootId: string, relative: string): { jobId: string; value: ScanFileState } | null {
      if (!dto.isCollectionId(libraryRootId) || !scanRelativePath(relative)) return access.conflict('扫描文件状态身份无效。');
      return access.read(db => {
        const row = currentFileState(db, libraryRootId, relative);
        return row ? { jobId: String(row.job_id), value: parse(row.data, isScanFileState, 65_536) } : null;
      });
    },
    /** 只预备详情候选索引，不读取音频或封面；关闭/SQL变化会让后台整件弃。 */
    privateWarmDisplayFileParameters(): Promise<void> { return access.read(db => rebuildScanOrigins(db, access.read)); },
    /** 仅同步页内按完整原文复用批次解析；不保存权限、参数结果或逐行来源证明。 */
    privateWithDisplayFileParametersRead<T>(read: () => T): T {
      return withDisplayFrame(null, () => {
        const result = read();
        if (result !== null && (typeof result === 'object' || typeof result === 'function')
          && typeof (result as { then?: unknown }).then === 'function') return access.conflict('详情参数读取帧只支持同步读取。');
        return result;
      });
    },
    /** 详情只读当前已证明的解析参数；不分配FD、媒体票据或排他锁。移动词汇投影也不能跳过原修订证明。 */
    privateDisplayFileParameters(trackId: string, asset: dto.AudioAsset, displayMode?: 'mobile-catalog'): dto.FileAudioParameters | null {
      return displayRead(frame => {
      const absent = (stage: CatalogFileParametersBranchStage): null => { clearDisplayFrame(frame); catalogFileParametersBranch(stage); return null; };
      let exception: CatalogFileParametersBranchStage = 'owner.item.file-parameters.throw.input';
      try {
      if (!dto.isCollectionId(trackId) || !dto.isAudioAsset(asset) || displayMode !== undefined && displayMode !== 'mobile-catalog') return access.conflict('详情参数逻辑身份无效。');
      exception = 'owner.item.file-parameters.throw.binding';
      const selected = access.catalog.track(trackId), locator = access.catalog.privateAssetLocator(asset.id), root = access.catalog.root(asset.libraryRootId), source = access.sources.root(root.sourceRootId);
      if (selected.assetId !== asset.id || !equal(locator.asset, asset) || root.revision !== asset.rootRevision || root.sourceRootId !== asset.sourceRootId || source.authorized !== true) return absent('owner.item.file-parameters.null.binding');
      // 只在下方完整来源证明通过后调用；原扫描codec和所有默认调用的返回词汇保持原样。
      const projectedCodec = (technical: MetadataTechnical): string => displayMode === 'mobile-catalog'
        && technical.container === 'MP4' && technical.lossless !== true && technical.codec === 'MPEG-4/AAC' ? 'aac' : technical.codec;
      exception = 'owner.item.file-parameters.throw.scan-state';
      return access.read(db => {
        const row = currentFileState(db, root.id, locator.relative); if (!row) return absent('owner.item.file-parameters.null.state-missing');
        const state = parse(row.data, isScanFileState);
        exception = 'owner.item.file-parameters.throw.scan-job';
        const job = get(db, String(row.job_id));
        if (state.outcome !== 'accepted' || state.assetId !== asset.id || state.trackId !== trackId || state.relative !== locator.relative || state.libraryRootId !== root.id) return absent('owner.item.file-parameters.null.state-binding');
        if (job.rootRevision !== root.revision || job.sourceRootId !== source.id) return absent('owner.item.file-parameters.null.job-binding');
        if (!state.readFacts) return absent('owner.item.file-parameters.null.read-facts');
        exception = 'owner.item.file-parameters.throw.source-proof';
        const sourceFact=sourceWritesProjectionForDatabase(db)?.scanFacts.get(`${root.id}/${locator.relative}`)?.fact;
        const lyricFact=lyricsPhysicalPublicationsForDatabase(db).find(item=>item.publication.scan?.rootId===root.id&&item.publication.scan.relative===locator.relative&&item.publication.scan.after===row.data
          &&equal(item.publication.replace?.after,asset)&&item.record.original.members.some(m=>m.trackId===trackId&&m.fileId===asset.id));
        if(sourceFact&&sourceFact.scanAfter===row.data&&equal(sourceFact.afterAsset,asset)&&sourceFact.affectedTrackIds.includes(trackId)||lyricFact){
          const technical=state.readFacts.technical,parameters={container:technical.container,codec:projectedCodec(technical),lossless:technical.lossless,sampleRateHz:technical.sampleRateHz,channels:technical.channels,bitsPerSample:technical.bitsPerSample,durationMs:technical.durationSeconds===null?null:Math.round(technical.durationSeconds*1000),evidence:technical.evidence};return dto.isFileAudioParameters(parameters)?parameters:absent('owner.item.file-parameters.null.source-dto');
        }
        exception = 'owner.item.file-parameters.throw.batch';
        const batchRow = db.prepare("SELECT request FROM local_scan_batches WHERE id=? AND phase='committed'").get(String(row.batch_id));
        if (!batchRow) return absent('owner.item.file-parameters.null.batch-missing');
        const batch = displayBatch(frame, db, batchRow.request), index = batch.items.findIndex(item => item.relative === locator.relative), item = batch.items[index];
        if (!item) return absent('owner.item.file-parameters.null.batch-item');
        if (item.signature !== state.signature) return absent('owner.item.file-parameters.null.batch-signature');
        if (!item.reused && !equal(item.readFacts, state.readFacts)) return absent('owner.item.file-parameters.null.batch-read-facts');
        const originSql = `SELECT b.request,j.data AS job_data FROM local_scan_batches b
          JOIN local_scan_jobs j ON j.id=b.job_id JOIN json_each(b.result,'$.files') f
          WHERE b.phase='committed' AND j.library_root_id=@root
            AND json_extract(f.value,'$.assetId')=@asset AND json_extract(f.value,'$.trackId')=@track
            AND json_extract(f.value,'$.relative')=@relative AND json_extract(f.value,'$.signature')=@signature
            AND json_extract(b.request,'$.items[' || f.key || '].reused')=0`;
        const originBindings = {root:root.id,asset:asset.id,track:trackId,relative:locator.relative,signature:state.signature};
        // 只保存最后一个被拒候选的固定分类；成功后不输出，失败也只输出一次，不断言它是唯一根因。
        let originFailure: CatalogFileParametersBranchStage = 'owner.item.file-parameters.null.origin-none';
        exception = 'owner.item.file-parameters.throw.origin';
        const provesOrigin = (origin: Row): boolean => {
          const original = displayBatch(frame, db, origin.request), originalJob = parse(origin.job_data, dto.isScanJobRecord);
          if (originalJob.rootRevision !== root.revision || originalJob.sourceRootId !== source.id) { originFailure = 'owner.item.file-parameters.null.origin-job-binding'; return false; }
          const originalIndex = original.items.findIndex(v => v.relative === locator.relative && v.signature === state.signature);
          if (originalIndex < 0) { originFailure = 'owner.item.file-parameters.null.origin-item'; return false; }
          const relocation = relocationOriginFact(db, originalJob.jobId, original.batchId, originalIndex);
          if (relocation && equal(relocation.afterAsset, asset) && relocation.tracks.some(track => track.id === trackId)
            && equal(relocation.scan.state.readFacts, state.readFacts)) {
            verifyRelocationOrigin(db, originalJob, original, originalIndex, relocation.scan.state); return true;
          }
          const created = db.prepare('SELECT result FROM local_catalog_ledger WHERE command_id IN (?,?)').all(childCommand(original.batchId, originalIndex, 'register-asset'), childCommand(original.batchId, originalIndex, 'replace-asset'));
          if (created.length !== 1) { originFailure = 'owner.item.file-parameters.null.origin-ledger-count'; return false; }
          const proven = parse(created[0]!.result, dto.isAudioAsset);
          const matches = equal(proven, asset);
          if (!matches) originFailure = 'owner.item.file-parameters.null.origin-ledger-asset';
          return matches;
        };
        let provenCurrent = false;
        // 新鲜当前批已持久绑定此state，先按原batch主键读取同一origin候选；仍实读原job、JSON和逐行账本证明。
        // 不保留跨调用事实，也不把当前batch身份本身当作技术参数证明。
        if (!item.reused) {
          // 仅原冷核证书仍有效的同连接可借作者的原子state→batch绑定；外部提交或约束变化立即拒绝。
          scanAuditFor(db);
          const direct = db.prepare(`${originSql} AND b.id=@batch AND b.job_id=@job ORDER BY b.rowid DESC LIMIT 200`)
            .iterate({...originBindings,batch:String(row.batch_id),job:String(row.job_id)});
          for (const origin of direct) if (provesOrigin(origin)) { provenCurrent = true; break; }
        }
        // 无变化的增量批没有新资产作者；点读不证明也沿原顺序/原200候选上限追溯，不能借其它文件的参数。
        if (!provenCurrent) {
          scanAuditFor(db);
          const index = currentScanOriginIndex(db);
          if (index) {
            // 索引只缩小候选位置；仍由原SQL全部谓词、真实job和原子账本作证明。
            for (const position of scanOriginPositions(index, root.id, asset.id, trackId, locator.relative, state.signature)) {
              const origin = db.prepare(`${originSql} AND b.id=@batch AND b.job_id=@job AND b.rowid=@ordinal`).get({ ...originBindings,
                batch: position.batchId, job: position.jobId, ordinal: position.ordinal });
              if (origin && provesOrigin(origin)) { provenCurrent = true; break; }
            }
          } else {
            void rebuildScanOrigins(db, access.read);
            const origins = db.prepare(`${originSql} ORDER BY b.rowid DESC LIMIT 200`).iterate(originBindings);
            for (const origin of origins) if (provesOrigin(origin)) { provenCurrent = true; break; }
          }
        }
        if (!provenCurrent) return absent(originFailure);
        exception = 'owner.item.file-parameters.throw.parameters';
        const technical = state.readFacts.technical;
        const parameters = { container: technical.container, codec: projectedCodec(technical), lossless: technical.lossless, sampleRateHz: technical.sampleRateHz, channels: technical.channels,
          bitsPerSample: technical.bitsPerSample, durationMs: technical.durationSeconds === null ? null : Math.round(technical.durationSeconds * 1000), evidence: technical.evidence };
        return dto.isFileAudioParameters(parameters) ? parameters : absent('owner.item.file-parameters.null.parameters');
      });
      } catch (error) { clearDisplayFrame(frame); catalogFileParametersBranch(exception); throw error; }
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
        if (batch.items.some(item => !scanItemMatchesParser(item, parserVersion))) return access.conflict('扫描批解析器身份不一致。');
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
      return access.read(deltaDb => {
      const delta = beginLocalAlbumScanDelta(deltaDb);
      try {
      const committed = access.catalog.privateBatch((db, mutate) => {
        const audit = scanAuditFor(db);
        const saved = savedReceipt(db, 'commit-batch', request); if (saved) return { result: saved, audit };
        const job = get(db, request.jobId); current(job);
        const row = db.prepare("SELECT * FROM local_scan_batches WHERE id=? AND job_id=? AND phase='prepared'").get(request.batchId, job.jobId);
        if (!row || db.prepare("SELECT command_id FROM local_scan_receipts WHERE job_id=? AND operation='abandon-batch' AND json_extract(request,'$.batchId')=?").get(job.jobId,request.batchId)) return access.conflict('扫描批尚未准备、已放弃或已由其他请求提交。');
        const batch = parse(row.request, isScanPreparedBatch);
        if (job.phase !== 'running' || job.jobRevision !== request.expectedRevision || batch.checkpointBefore !== job.checkpointRef) return access.conflict('扫描批任务修订或checkpoint已改变。');
        const states: { value: ScanFileState; before: Row | null }[] = [];
        const dirty = (relative: string, cue = false): void => recordLocalAlbumScanDirectory(delta, {
          rootId: job.libraryRootId, sourceRootId: job.sourceRootId, rootRevision: job.rootRevision,
          directory: relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '',
        }, cue ? relative : undefined);
        for (const [index, item] of batch.items.entries()) {
          dirty(item.relative);
          const previousRow = db.prepare('SELECT * FROM local_scan_file_state WHERE library_root_id=? AND relative=?').get(job.libraryRootId, item.relative);
          const candidateRow = currentFileState(db, job.libraryRootId, item.relative);
          const previous = candidateRow ? parse(candidateRow.data, isScanFileState, 65_536) : null;
          if (previous) dirty(previous.relative);
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
            dirty(item.relative, true);
            for (const track of item.result?.tracks ?? []) dirty(track.assetReference.relative);
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
        recordLocalAlbumScanWrites(delta, audit.writes());
        return { result, audit };
      }, 'local-scan:commit-batch', delta);
      committed.audit.publish(); publishLocalAlbumScanDelta(deltaDb, delta); committed.audit.publishOrigins(); return committed.result;
      } catch (error) { discardLocalAlbumScanDelta(delta); throw error; }
      });
    },
  };
}
export type LocalScanStore = ReturnType<typeof createLocalScanStore>;
