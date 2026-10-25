import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import * as dto from '@music-bridge/contracts';
import type { DatasetIdentity } from '../recording/dataset-identity.js';
import type { CollectionRepository } from './repository.js';
import { isLocalScanSettingsEvent, type LocalScanFrozenSettings } from './local-scan-settings.js';

/** 完成扫描的派生只读快照；不携带来源路径、文件授权、Reader或Provider。 */
export const LOCAL_SCAN_SNAPSHOT_LIMITS = Object.freeze({ facts: 10_000, bytes: 32 * 1024 * 1024,
  chunkBytes: 64 * 1024, commits: 100_000, chunks: 3_000_000, totalBytes: 1024 * 1024 * 1024, ownerMs: 2000 });
const tables = {
  local_scan_snapshot_commits: 'CREATE TABLE local_scan_snapshot_commits(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES local_scan_jobs(id),data TEXT NOT NULL) STRICT',
  local_scan_snapshot_chunks: 'CREATE TABLE local_scan_snapshot_chunks(snapshot_id TEXT NOT NULL REFERENCES local_scan_snapshot_commits(id) DEFERRABLE INITIALLY DEFERRED,ordinal INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(snapshot_id,ordinal)) STRICT',
} as const;
const indexes = ['CREATE INDEX local_scan_snapshot_job ON local_scan_snapshot_commits(job_id)'];
const triggers = Object.keys(tables).flatMap(name => ['UPDATE', 'DELETE'].map(operation =>
  `CREATE TRIGGER ${name}_no_${operation.toLowerCase()} BEFORE ${operation} ON ${name} BEGIN SELECT RAISE(ABORT,'完成扫描快照原件保留'); END`));
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const codes = ['INVALID', 'UNAVAILABLE', 'CHANGED', 'LIMIT_EXCEEDED', 'TIMEOUT', 'CAPTURE_FAILED'] as const;
type FailureCode = typeof codes[number];
export class LocalScanSnapshotError extends Error {
  constructor(readonly code: FailureCode) { super('完成扫描快照暂不可用；原扫描和最近成功快照保留。'); }
}
const fail = (code: FailureCode): never => { throw new LocalScanSnapshotError(code); };
const corrupt = (): never => { throw new Error('完成扫描快照结构或完整历史损坏，保留原工作库。'); };
function object(value: unknown, names: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Reflect.ownKeys(value).length === names.length && names.every(name => {
      const field = Object.getOwnPropertyDescriptor(value, name); return field?.enumerable === true && Object.hasOwn(field, 'value');
    });
}
function dense(value: unknown, maximum: number): value is unknown[] {
  return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length <= maximum
    && Reflect.ownKeys(value).length === value.length + 1 && value.every((_item, index) => Object.hasOwn(value, index));
}
export function completedScanCanonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(completedScanCanonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(key =>
    JSON.stringify(key) + ':' + completedScanCanonical((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value);
}
const same = (a: unknown, b: unknown): boolean => completedScanCanonical(a) === completedScanCanonical(b);
function frozen(value: unknown): value is LocalScanFrozenSettings {
  return object(value, ['jobId', 'settingsRevision', 'albumConcurrency', 'readerConcurrency']) && dto.isCollectionId(value.jobId)
    && dto.isLocalCatalogRevision(value.settingsRevision) && Number.isSafeInteger(value.albumConcurrency)
    && Number(value.albumConcurrency) >= 1 && Number(value.albumConcurrency) <= 24 && (value.readerConcurrency === 1 || value.readerConcurrency === 2 || value.readerConcurrency === 8);
}
export interface CompletedScanMember {
  asset: dto.AudioAsset; track: dto.LocalTrack; rawMetadata: dto.LocalMetadata; effectiveMetadata: dto.LocalMetadata;
}
export interface CompletedScanSnapshot {
  schema: 1; job: dto.ScanJobRecord; frozen: LocalScanFrozenSettings;
  batches: { batchId: string; request: string; result: string }[]; members: CompletedScanMember[];
}
interface Attempt {
  schema: 1; attemptId: string; jobId: string; datasetId: string; libraryRootId: string; sourceRootId: string; rootRevision: string;
  jobHash: string; jobWatermark: number; previousAttemptId: string | null; attempt: number; frozen: LocalScanFrozenSettings;
  status: 'ready' | 'failed'; failureCode: FailureCode | null; bytes: number; sha256: string | null; chunks: number; facts: number;
}
export interface CompletedScanSnapshotLoad {
  status: 'empty' | 'ready' | 'failed' | 'unavailable';
  latestAttempt: Readonly<Attempt> | null;
  lastSuccess: { attempt: Readonly<Attempt>; snapshot: CompletedScanSnapshot } | null;
  retryJobId: string | null;
}
function attempt(value: unknown): value is Attempt {
  return object(value, ['schema', 'attemptId', 'jobId', 'datasetId', 'libraryRootId', 'sourceRootId', 'rootRevision', 'jobHash', 'jobWatermark',
    'previousAttemptId', 'attempt', 'frozen', 'status', 'failureCode', 'bytes', 'sha256', 'chunks', 'facts'])
    && value.schema === 1 && [value.attemptId, value.jobId, value.datasetId, value.libraryRootId, value.sourceRootId].every(dto.isCollectionId)
    && dto.isLocalCatalogRevision(value.rootRevision) && hash(value.jobHash) && Number.isSafeInteger(value.jobWatermark) && Number(value.jobWatermark) > 0
    && (value.previousAttemptId === null || dto.isCollectionId(value.previousAttemptId)) && Number.isSafeInteger(value.attempt) && Number(value.attempt) > 0
    && frozen(value.frozen) && value.frozen.jobId === value.jobId && Number.isSafeInteger(value.facts) && Number(value.facts) >= 0
    && Number(value.facts) <= LOCAL_SCAN_SNAPSHOT_LIMITS.facts
    && (value.status === 'ready' ? value.failureCode === null && Number.isSafeInteger(value.bytes) && Number(value.bytes) > 0
      && Number(value.bytes) <= LOCAL_SCAN_SNAPSHOT_LIMITS.bytes && hash(value.sha256) && Number.isSafeInteger(value.chunks)
      && value.chunks === Math.ceil(Number(value.bytes) / LOCAL_SCAN_SNAPSHOT_LIMITS.chunkBytes)
      : value.status === 'failed' && codes.includes(value.failureCode as FailureCode) && value.bytes === 0 && value.sha256 === null && value.chunks === 0 && value.facts === 0);
}
function parse<T>(raw: unknown, guard: (value: unknown) => value is T, cap: number): T {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > cap) return corrupt();
  const value: unknown = JSON.parse(raw); return guard(value) ? value : corrupt();
}
function schema(db: DatabaseSync): boolean {
  const allowed = new Set([...Object.keys(tables), ...indexes.map(sql => sql.split(' ')[2]!), ...triggers.map(sql => sql.split(' ')[2]!)]);
  for (const row of db.prepare("SELECT name FROM sqlite_master WHERE name GLOB 'local_scan_snapshot_*'").iterate())
    if (typeof row.name !== 'string' || !allowed.has(row.name)) return corrupt();
  const found = Object.keys(tables).map(name => db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name));
  if (found.every(row => row === undefined)) {
    for (const sql of [...indexes, ...triggers]) if (db.prepare('SELECT name FROM sqlite_master WHERE name=?').get(sql.split(' ')[2]!)) return corrupt();
    return false;
  }
  if (found.some(row => row === undefined)) return corrupt();
  for (const [name, sql] of Object.entries(tables)) if (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name)?.sql !== sql) return corrupt();
  for (const [type, statements] of [['index', indexes], ['trigger', triggers]] as const) for (const sql of statements)
    if (db.prepare('SELECT sql FROM sqlite_master WHERE type=? AND name=?').get(type, sql.split(' ')[2]!)?.sql !== sql) return corrupt();
  return true;
}
function ensureSchema(db: DatabaseSync): void { if (!schema(db)) db.exec([...Object.values(tables), ...indexes, ...triggers].join(';') + ';'); }
function readFrozen(db: DatabaseSync, datasetId: string, jobId: string): LocalScanFrozenSettings {
  const rows = db.prepare("SELECT request FROM local_catalog_ledger WHERE operation='local-scan-settings-v1' AND json_extract(request,'$.kind')='launch' AND json_extract(request,'$.datasetId')=? AND json_extract(request,'$.frozen.jobId')=? LIMIT 2").all(datasetId, jobId);
  if (rows.length !== 1) return corrupt();
  const event = parse(rows[0]!.request, isLocalScanSettingsEvent, 65536);
  if (event.kind !== 'launch' || event.datasetId !== datasetId || event.frozen.jobId !== jobId) return corrupt();
  return event.frozen;
}
function job(db: DatabaseSync, id: string): { job: dto.ScanJobRecord; raw: string; watermark: number } {
  const row = db.prepare('SELECT rowid ordinal,data FROM local_scan_jobs WHERE id=?').get(id);
  if (!row || typeof row.data !== 'string' || !Number.isSafeInteger(row.ordinal) || Number(row.ordinal) <= 0) return corrupt();
  const value = parse(row.data, dto.isScanJobRecord, 65536);
  if (value.jobId !== id || value.phase !== 'completed') return corrupt();
  return { job: value, raw: row.data, watermark: Number(row.ordinal) };
}
function batches(db: DatabaseSync, jobId: string, current?: () => void): CompletedScanSnapshot['batches'] {
  const result: CompletedScanSnapshot['batches'] = []; let bytes = 0;
  for (const row of db.prepare("SELECT id,request,result FROM local_scan_batches WHERE job_id=? AND phase='committed' ORDER BY rowid").iterate(jobId)) {
    current?.();
    if (typeof row.id !== 'string' || typeof row.request !== 'string' || typeof row.result !== 'string') return corrupt();
    const value = { batchId: row.id, request: row.request, result: row.result };
    bytes += Buffer.byteLength(completedScanCanonical(value));
    if (bytes > LOCAL_SCAN_SNAPSHOT_LIMITS.bytes) return fail('LIMIT_EXCEEDED');
    result.push(value);
    if (result.length > LOCAL_SCAN_SNAPSHOT_LIMITS.facts + 1) return fail('LIMIT_EXCEEDED');
  }
  if (!result.length) return corrupt();
  return result;
}
function batchFacts(parts: CompletedScanSnapshot['batches'], current?: () => void): { count: number; targets: { assetId: string; trackId: string }[] } {
  let count = 0; const targets = new Map<string, { assetId: string; trackId: string }>();
  for (const part of parts) {
    current?.();
    const request = JSON.parse(part.request) as { batchId: string; items: unknown[]; cueItems?: dto.LocalCuePreparedItem[] };
    const result = JSON.parse(part.result) as { files: { outcome: string; assetId: string | null; trackId: string | null }[] };
    if (request.batchId !== part.batchId || !Array.isArray(request.items) || !Array.isArray(result.files) || request.items.length !== result.files.length) return corrupt();
    count += result.files.length;
    for (const cue of request.cueItems ?? []) { current?.(); count += Math.max(1, cue.result?.tracks.length ?? 0); }
    for (const file of result.files) {
      current?.();
      if (file.outcome === 'accepted') {
        if (!dto.isCollectionId(file.assetId) || !dto.isCollectionId(file.trackId)) return corrupt();
        const value = { assetId: file.assetId, trackId: file.trackId }; targets.set(value.assetId + '/' + value.trackId, value);
      }
    }
  }
  return { count, targets: [...targets.values()] };
}
function isSnapshot(value: unknown): value is CompletedScanSnapshot {
  return object(value, ['schema', 'job', 'frozen', 'batches', 'members']) && value.schema === 1 && dto.isScanJobRecord(value.job)
    && value.job.phase === 'completed' && frozen(value.frozen) && value.frozen.jobId === value.job.jobId
    && dense(value.batches, LOCAL_SCAN_SNAPSHOT_LIMITS.facts + 1) && value.batches.every(part => object(part, ['batchId', 'request', 'result'])
      && dto.isCollectionId(part.batchId) && typeof part.request === 'string' && typeof part.result === 'string')
    && new Set(value.batches.map(part => object(part, ['batchId', 'request', 'result']) ? part.batchId : null)).size === value.batches.length
    && dense(value.members, LOCAL_SCAN_SNAPSHOT_LIMITS.facts) && value.members.every(member => object(member, ['asset', 'track', 'rawMetadata', 'effectiveMetadata'])
      && dto.isAudioAsset(member.asset) && dto.isLocalTrack(member.track) && member.track.assetId === member.asset.id
      && dto.isLocalMetadata(member.rawMetadata) && dto.isLocalMetadata(member.effectiveMetadata));
}
function readWhole(db: DatabaseSync, record: Attempt, current?: () => void): CompletedScanSnapshot {
  current?.();
  const parts: Buffer[] = []; let index = 0, size = 0;
  for (const row of db.prepare('SELECT ordinal,data FROM local_scan_snapshot_chunks WHERE snapshot_id=? ORDER BY ordinal').iterate(record.attemptId)) {
    current?.();
    if (row.ordinal !== index || typeof row.data !== 'string' || row.data.length > Math.ceil(LOCAL_SCAN_SNAPSHOT_LIMITS.chunkBytes / 3) * 4
      || /[^A-Za-z0-9+/=]/u.test(row.data) || row.data.length % 4 !== 0) return corrupt();
    const bytes = Buffer.from(row.data, 'base64');
    if (!bytes.length || bytes.length > LOCAL_SCAN_SNAPSHOT_LIMITS.chunkBytes || bytes.toString('base64') !== row.data
      || index < record.chunks - 1 && bytes.length !== LOCAL_SCAN_SNAPSHOT_LIMITS.chunkBytes) return corrupt();
    size += bytes.length; if (size > record.bytes || ++index > record.chunks) return corrupt(); parts.push(bytes);
  }
  current?.();
  const bytes = Buffer.concat(parts);
  if (index !== record.chunks || size !== record.bytes || digest(bytes) !== record.sha256) return corrupt();
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes), snapshot = parse(raw, isSnapshot, LOCAL_SCAN_SNAPSHOT_LIMITS.bytes);
  if (completedScanCanonical(snapshot) !== raw) return corrupt();
  current?.();
  const source = job(db, record.jobId), originalBatches = batches(db, record.jobId, current), facts = batchFacts(snapshot.batches, current);
  if (!same(snapshot.job, source.job) || digest(source.raw) !== record.jobHash || source.watermark !== record.jobWatermark
    || !same(snapshot.frozen, record.frozen) || !same(record.frozen, readFrozen(db, record.datasetId, record.jobId))
    || !same(snapshot.batches, originalBatches) || facts.count !== record.facts || facts.count > LOCAL_SCAN_SNAPSHOT_LIMITS.facts) return corrupt();
  const members = new Map(snapshot.members.map(member => { current?.(); return [member.asset.id + '/' + member.track.id, member] as const; }));
  if (members.size !== snapshot.members.length || members.size !== facts.targets.length || facts.targets.some(target => {
    current?.();
    const member = members.get(target.assetId + '/' + target.trackId);
    return !member || member.asset.libraryRootId !== record.libraryRootId || member.asset.sourceRootId !== record.sourceRootId || member.asset.rootRevision !== record.rootRevision;
  })) return corrupt();
  current?.(); return snapshot;
}
function resources(db: DatabaseSync): { commits: number; chunks: number; bytes: number } {
  const commits = Number(db.prepare('SELECT count(*) n FROM local_scan_snapshot_commits').get()!.n);
  const chunks = Number(db.prepare('SELECT count(*) n FROM local_scan_snapshot_chunks').get()!.n);
  const bytes = Number(db.prepare('SELECT (SELECT coalesce(sum(length(CAST(data AS BLOB))),0) FROM local_scan_snapshot_commits)+(SELECT coalesce(sum(length(CAST(data AS BLOB))),0) FROM local_scan_snapshot_chunks) n').get()!.n);
  if (![commits, chunks, bytes].every(value => Number.isSafeInteger(value) && value >= 0)) return corrupt();
  if (commits > LOCAL_SCAN_SNAPSHOT_LIMITS.commits || chunks > LOCAL_SCAN_SNAPSHOT_LIMITS.chunks || bytes > LOCAL_SCAN_SNAPSHOT_LIMITS.totalBytes) return fail('LIMIT_EXCEEDED');
  return { commits, chunks, bytes };
}
/** 原scan冷核之后完整消费本可选域；未创建两表的旧schema32仍有效，partial禁止自动修补。 */
export function verifyCompletedScanSnapshotDatabase(db: DatabaseSync, current?: () => void): void {
  current?.();
  if (!schema(db)) return;
  current?.();
  resources(db); const previous = new Map<string, Attempt>(); let chunkCount = 0;
  for (const row of db.prepare('SELECT * FROM local_scan_snapshot_commits ORDER BY rowid').iterate()) {
    current?.();
    const record = parse(row.data, attempt, 65536), source = job(db, record.jobId), prior = previous.get(record.jobId);
    if (row.id !== record.attemptId || row.job_id !== record.jobId || record.datasetId !== source.job.datasetId
      || record.libraryRootId !== source.job.libraryRootId || record.sourceRootId !== source.job.sourceRootId || record.rootRevision !== source.job.rootRevision
      || record.jobHash !== digest(source.raw) || record.jobWatermark !== source.watermark || record.attempt !== (prior?.attempt ?? 0) + 1
      || record.previousAttemptId !== (prior?.attemptId ?? null) || !same(record.frozen, readFrozen(db, record.datasetId, record.jobId))) return corrupt();
    if (record.status === 'ready') { readWhole(db, record, current); chunkCount += record.chunks; }
    else if (db.prepare('SELECT 1 FROM local_scan_snapshot_chunks WHERE snapshot_id=?').get(record.attemptId)) return corrupt();
    previous.set(record.jobId, record);
  }
  if (Number(db.prepare('SELECT count(*) n FROM local_scan_snapshot_chunks').get()!.n) !== chunkCount
    || db.prepare('SELECT 1 FROM local_scan_snapshot_chunks c LEFT JOIN local_scan_snapshot_commits s ON s.id=c.snapshot_id WHERE s.id IS NULL LIMIT 1').get()) return corrupt();
  current?.();
}
export interface CompletedScanSnapshotOptions {
  repository: CollectionRepository; identity: DatasetIdentity;
  /** 只允许收紧原整组预算；不改变生产Owner2000ms。 */
  limits?: { facts?: number; bytes?: number };
  /** 仅可信故障测试；不传入新源、页或库存内容。 */
  beforeCapture?(): void;
}
export function createCompletedScanSnapshotView(options: CompletedScanSnapshotOptions) {
  const { repository, identity } = options, access = repository.privateMobileCatalogAccess;
  if (typeof access !== 'function') return fail('UNAVAILABLE');
  // 不在此处bind、生成UUID或打开新数据库；只能消费原domain已绑定的同一对象。
  const settings = repository.localCatalog.privateScanSettingsStore(identity);
  const connection = repository.localCatalog.privateRead(db => db);
  if (access(db => db) !== connection) return fail('INVALID');
  const maxFacts = options.limits?.facts ?? LOCAL_SCAN_SNAPSHOT_LIMITS.facts, maxBytes = options.limits?.bytes ?? LOCAL_SCAN_SNAPSHOT_LIMITS.bytes;
  if (!Number.isSafeInteger(maxFacts) || maxFacts < 1 || maxFacts > LOCAL_SCAN_SNAPSHOT_LIMITS.facts
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > LOCAL_SCAN_SNAPSHOT_LIMITS.bytes) return fail('INVALID');
  let closed = false, fatal = false;
  function check(deadline?: number): void {
    if (closed || fatal) return fail('UNAVAILABLE'); identity.assertCurrent(); settings.read(identity);
    if (deadline !== undefined && performance.now() >= deadline) return fail('TIMEOUT');
  }
  function read<T>(operation: (db: DatabaseSync, current: () => void) => T, deadline = performance.now() + LOCAL_SCAN_SNAPSHOT_LIMITS.ownerMs): T {
    check(deadline);
    const result = access!<{ ok: true; value: T } | { ok: false; code: FailureCode }>(db => {
      try { if (db !== connection) return fail('INVALID'); return { ok: true, value: operation(db, () => check(deadline)) }; }
      catch (error) { if (!(error instanceof LocalScanSnapshotError)) throw error; return { ok: false, code: error.code }; }
    });
    check(deadline); if (!result.ok) return fail(result.code); return result.value;
  }
  function activeRoot(rootId: string, captured?: dto.ScanJobRecord,writing=false): boolean {
    const root = repository.localCatalog.root(rootId), source = repository.sources.root(root.sourceRootId);
    return (writing?repository.localCatalog.privateLibraryManagementRootAvailable(rootId):repository.localCatalog.privateLibraryManagementRootVisible(rootId)) && root.role === 'library' && source.authorized && (!captured || root.revision === captured.rootRevision && root.sourceRootId === captured.sourceRootId);
  }
  function load(rootId: string, deadline = performance.now() + LOCAL_SCAN_SNAPSHOT_LIMITS.ownerMs): CompletedScanSnapshotLoad {
    if (!dto.isCollectionId(rootId)) return fail('INVALID');
    return read((db, current) => {
      current(); if (!schema(db)) return { status: activeRoot(rootId) ? 'empty' : 'unavailable', latestAttempt: null, lastSuccess: null, retryJobId: null };
      const records = db.prepare('SELECT s.data FROM local_scan_snapshot_commits s JOIN local_scan_jobs j ON j.id=s.job_id WHERE j.dataset_id=? AND j.library_root_id=? ORDER BY j.rowid DESC,s.rowid DESC').iterate(identity.datasetId, rootId);
      let latest: Attempt | null = null, success: Attempt | null = null;
      for (const row of records) { current(); const value = parse(row.data, attempt, 65536); latest ??= value; if (value.status === 'ready') { success = value; break; } }
      if (latest && !activeRoot(rootId, job(db, latest.jobId).job) || !latest && !activeRoot(rootId))
        return { status: 'unavailable', latestAttempt: latest, lastSuccess: null, retryJobId: null };
      const lastSuccess = success ? { attempt: success, snapshot: readWhole(db, success, current) } : null;
      if (lastSuccess && !activeRoot(rootId, lastSuccess.snapshot.job)) return { status: 'unavailable', latestAttempt: latest, lastSuccess: null, retryJobId: null };
      current(); return { status: latest?.status ?? 'empty', latestAttempt: latest, lastSuccess, retryJobId: latest?.status === 'failed' ? latest.jobId : null };
    }, deadline);
  }
  // 只保留本view实际全核后产生的primitive证明；不保存或接收逃逸snapshot/授权对象。
  const headerProofs = new Map<string, { barrier: string; evidence: string; attemptId: string }>();
  function headerBarrier(db: DatabaseSync): string {
    const row = db.prepare('SELECT total_changes() AS changes,(SELECT data_version FROM pragma_data_version) AS version,(SELECT schema_version FROM pragma_schema_version) AS schema,(SELECT coalesce(max(rowid),0) FROM local_catalog_ledger) AS ledger').get();
    const values = [row?.changes, row?.version, row?.schema, row?.ledger];
    if (!values.every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) || typeof db.isTransaction !== 'boolean') return corrupt();
    return JSON.stringify([...values, db.isTransaction]);
  }
  function headerEvidence(db: DatabaseSync, record: Attempt, readyRaw: string, latestRaw: string, current: () => void): string {
    // 即使命中也逐件消费真实SQL全chunk，不用header自述SHA充当实际正文。
    const parts: Buffer[] = []; let index = 0, size = 0;
    for (const row of db.prepare('SELECT ordinal,data FROM local_scan_snapshot_chunks WHERE snapshot_id=? ORDER BY ordinal').iterate(record.attemptId)) {
      current();
      if (row.ordinal !== index || typeof row.data !== 'string' || row.data.length > Math.ceil(LOCAL_SCAN_SNAPSHOT_LIMITS.chunkBytes / 3) * 4
        || /[^A-Za-z0-9+/=]/u.test(row.data) || row.data.length % 4 !== 0) return corrupt();
      const bytes = Buffer.from(row.data, 'base64');
      if (!bytes.length || bytes.length > LOCAL_SCAN_SNAPSHOT_LIMITS.chunkBytes || bytes.toString('base64') !== row.data
        || index < record.chunks - 1 && bytes.length !== LOCAL_SCAN_SNAPSHOT_LIMITS.chunkBytes) return corrupt();
      size += bytes.length; if (size > record.bytes || ++index > record.chunks) return corrupt(); parts.push(bytes);
    }
    const bytes = Buffer.concat(parts), actualSha256 = digest(bytes);
    if (index !== record.chunks || size !== record.bytes || actualSha256 !== record.sha256) return corrupt();
    const source = job(db, record.jobId), originalBatches = batches(db, record.jobId), actualFrozen = readFrozen(db, record.datasetId, record.jobId);
    // 原frozen launch全文也是证明依赖，不只比较其对外字段。
    const launches = db.prepare("SELECT request FROM local_catalog_ledger WHERE operation='local-scan-settings-v1' AND json_extract(request,'$.kind')='launch' AND json_extract(request,'$.datasetId')=? AND json_extract(request,'$.frozen.jobId')=? LIMIT 2").all(record.datasetId, record.jobId);
    if (launches.length !== 1 || typeof launches[0]?.request !== 'string') return corrupt();
    current();
    return JSON.stringify([Buffer.byteLength(readyRaw), digest(readyRaw), Buffer.byteLength(latestRaw), digest(latestRaw), size, actualSha256,
      Buffer.byteLength(source.raw), digest(source.raw), source.watermark, digest(launches[0].request),
      digest(completedScanCanonical(actualFrozen)), digest(completedScanCanonical(originalBatches))]);
  }
  function privateLastSuccessId(rootId: string, deadline = performance.now() + LOCAL_SCAN_SNAPSHOT_LIMITS.ownerMs): string | null {
    if (!dto.isCollectionId(rootId)) return fail('INVALID');
    return read((db, current) => {
      current(); const before = headerBarrier(db);
      if (!schema(db)) { activeRoot(rootId); headerProofs.delete(rootId); current(); if (headerBarrier(db) !== before) return fail('CHANGED'); return null; }
      const records = db.prepare('SELECT s.data FROM local_scan_snapshot_commits s JOIN local_scan_jobs j ON j.id=s.job_id WHERE j.dataset_id=? AND j.library_root_id=? ORDER BY j.rowid DESC,s.rowid DESC').iterate(identity.datasetId, rootId);
      let latest: Attempt | null = null, success: Attempt | null = null, latestRaw = '', readyRaw = '';
      for (const row of records) {
        current(); const value = parse(row.data, attempt, 65536);
        if (!latest) { latest = value; latestRaw = String(row.data); }
        if (value.status === 'ready') { success = value; readyRaw = String(row.data); break; }
      }
      if (latest && !activeRoot(rootId, job(db, latest.jobId).job) || !latest && !activeRoot(rootId) || !success) {
        headerProofs.delete(rootId); current(); if (headerBarrier(db) !== before) return fail('CHANGED'); return null;
      }
      const previous = headerProofs.get(rootId);
      let evidence: string;
      if (previous?.barrier === before && previous.attemptId === success.attemptId) {
        evidence = headerEvidence(db, success, readyRaw, latestRaw, current);
        if (evidence !== previous.evidence) {
          // 正文相异不能借旧证明；沿原完整语义路径裁决。
          headerProofs.delete(rootId); readWhole(db, success, current);
          evidence = headerEvidence(db, success, readyRaw, latestRaw, current);
        }
      } else {
        // 任何同连接写/水位/状态变化均失效；首次只能原readWhole完整核建证。
        headerProofs.delete(rootId); readWhole(db, success, current);
        evidence = headerEvidence(db, success, readyRaw, latestRaw, current);
      }
      if (!activeRoot(rootId, job(db, success.jobId).job)) { headerProofs.delete(rootId); return null; }
      current(); if (headerBarrier(db) !== before) { headerProofs.delete(rootId); return fail('CHANGED'); }
      if (!headerProofs.has(rootId) && headerProofs.size >= 100) headerProofs.delete(headerProofs.keys().next().value!);
      headerProofs.set(rootId, { barrier: before, evidence, attemptId: success.attemptId });
      return success.attemptId;
    }, deadline);
  }
  function capture(jobId: string, retry: boolean): CompletedScanSnapshotLoad {
    if (!dto.isCollectionId(jobId)) return fail('INVALID');
    // 捕获与最终load共用原Owner绝对期限，不能每段重新取得2000ms。
    const deadline = performance.now() + LOCAL_SCAN_SNAPSHOT_LIMITS.ownerMs;
    const rootId = read((db, current) => {
      current(); const source = job(db, jobId); if (source.job.datasetId !== identity.datasetId) return fail('INVALID');
      if (!activeRoot(source.job.libraryRootId, source.job,true)) return fail('CHANGED');
      const frozenSettings = settings.frozen(identity, jobId); if (!frozenSettings || !same(frozenSettings, readFrozen(db, identity.datasetId, jobId))) return fail('INVALID');
      let prior: Attempt | null = null;
      if (schema(db)) {
        const row = db.prepare('SELECT data FROM local_scan_snapshot_commits WHERE job_id=? ORDER BY rowid DESC LIMIT 1').get(jobId);
        prior = row ? parse(row.data, attempt, 65536) : null;
      }
      if (prior && !retry) return source.job.libraryRootId;
      if (retry && prior?.status !== 'failed') return fail('INVALID');
      const base = { schema: 1 as const, attemptId: randomUUID(), jobId, datasetId: identity.datasetId, libraryRootId: source.job.libraryRootId,
        sourceRootId: source.job.sourceRootId, rootRevision: source.job.rootRevision, jobHash: digest(source.raw), jobWatermark: source.watermark,
        previousAttemptId: prior?.attemptId ?? null, attempt: (prior?.attempt ?? 0) + 1, frozen: frozenSettings };
      let record: Attempt, raw: Buffer | null = null;
      try {
        try { options.beforeCapture?.(); } catch { return fail('CAPTURE_FAILED'); } current();
        const fullBatches = batches(db, jobId), facts = batchFacts(fullBatches);
        if (facts.count > maxFacts) return fail('LIMIT_EXCEEDED');
        let memberBytes = Buffer.byteLength(completedScanCanonical({ schema: 1, job: source.job, frozen: frozenSettings, batches: fullBatches, members: [] }));
        const members = facts.targets.map(target => {
          current(); const asset = repository.localCatalog.asset(target.assetId), track = repository.localCatalog.track(target.trackId), metadata = repository.localCatalog.metadata(target.trackId);
          if (asset.libraryRootId !== source.job.libraryRootId || asset.sourceRootId !== source.job.sourceRootId || asset.rootRevision !== source.job.rootRevision || track.assetId !== asset.id) return fail('CHANGED');
          const member = { asset, track, rawMetadata: metadata.raw, effectiveMetadata: metadata.effective };
          memberBytes += Buffer.byteLength(completedScanCanonical(member)) + 1;
          if (memberBytes > maxBytes) return fail('LIMIT_EXCEEDED');
          return member;
        });
        const value: CompletedScanSnapshot = { schema: 1, job: source.job, frozen: frozenSettings, batches: fullBatches, members };
        if (!isSnapshot(value)) return corrupt();
        raw = Buffer.from(completedScanCanonical(value)); if (raw.length > maxBytes) return fail('LIMIT_EXCEEDED'); current();
        record = { ...base, status: 'ready', failureCode: null, bytes: raw.length, sha256: digest(raw),
          chunks: Math.ceil(raw.length / LOCAL_SCAN_SNAPSHOT_LIMITS.chunkBytes), facts: facts.count };
      } catch (error) {
        // 只有本派生捕获的可恢复失败成为独立attempt；身份/未知SQL异常不冒充可重试成功。
        if (!(error instanceof LocalScanSnapshotError)) throw error;
        const code = error.code;
        record = { ...base, status: 'failed', failureCode: code, bytes: 0, sha256: null, chunks: 0, facts: 0 }; raw = null;
      }
      current(); db.exec('BEGIN IMMEDIATE'); let committed = false;
      try {
        ensureSchema(db); current();
        const previous = db.prepare('SELECT data FROM local_scan_snapshot_commits WHERE job_id=? ORDER BY rowid DESC LIMIT 1').get(jobId);
        if (!same(previous ? parse(previous.data, attempt, 65536) : null, prior)) return fail('CHANGED');
        const budget = resources(db), commitRaw = completedScanCanonical(record), encodedBytes = raw ? 4 * Math.ceil(raw.length / 3) + record.chunks * 4 : 0;
        if (budget.commits + 1 > LOCAL_SCAN_SNAPSHOT_LIMITS.commits || budget.chunks + record.chunks > LOCAL_SCAN_SNAPSHOT_LIMITS.chunks
          || budget.bytes + Buffer.byteLength(commitRaw) + encodedBytes > LOCAL_SCAN_SNAPSHOT_LIMITS.totalBytes) return fail('LIMIT_EXCEEDED');
        db.prepare('INSERT INTO local_scan_snapshot_commits VALUES(?,?,?)').run(record.attemptId, jobId, commitRaw);
        if (raw) for (let index = 0; index < record.chunks; index++) {
          current(); db.prepare('INSERT INTO local_scan_snapshot_chunks VALUES(?,?,?)').run(record.attemptId, index,
            raw.subarray(index * LOCAL_SCAN_SNAPSHOT_LIMITS.chunkBytes, (index + 1) * LOCAL_SCAN_SNAPSHOT_LIMITS.chunkBytes).toString('base64'));
        }
        current(); if (!activeRoot(source.job.libraryRootId, source.job,true) || !same(job(db, jobId), source)) return fail('CHANGED');
        db.exec('COMMIT'); committed = true;
      } catch (error) {
        if (committed) { fatal = true; throw error; }
        try { db.exec('ROLLBACK'); } catch { fatal = true; }
        throw error;
      }
      return source.job.libraryRootId;
    }, deadline);
    return load(rootId, deadline);
  }
  return { load: (rootId: string) => load(rootId), privateLastSuccessId: (rootId: string) => privateLastSuccessId(rootId), captureCompleted: (jobId: string) => capture(jobId, false), retry: (jobId: string) => capture(jobId, true), close() { closed = true; headerProofs.clear(); } };
}
export type CompletedScanSnapshotView = ReturnType<typeof createCompletedScanSnapshotView>;
