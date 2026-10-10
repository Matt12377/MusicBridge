import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  isRegisterReferenceSourceRequest, isSourcePack, isReferenceSourceVersion,
  isCatalogIdRequest, isCatalogHistoryRequest, isReferenceSourceListRequest,
  isPreviewCatalogRevisionRequest, isPublishCatalogRevisionRequest, isSetCatalogMatchRequest,
  isPreviewReferenceArchiveCatalogRequest, isImportReferenceArchiveCatalogRequest, parseReferenceSourcePack,
  isCatalogRevision, isCatalogMatch, isCatalogSnapshot, isCatalogRevisionDetail,
  isPreviewReferenceSourceZipRequest, isRegisterReferenceSourceZipRequest,
  isReferenceSourceZipReceiptListRequest, isReferenceSourceZipReceipt, isRegisterReferenceSourceZipResult,
  normalizeReferenceItems, MAX_REFERENCE_SOURCE_PACK_BYTES, MAX_CATALOG_MATCHES,
  type CanonicalReference, type ReferenceSourceVersion, type ReferenceSourceDetail,
  type RegisterReferenceSourceRequest, type PreviewCatalogRevisionRequest, type PublishCatalogRevisionRequest,
  type PreviewReferenceArchiveCatalogRequest, type ImportReferenceArchiveCatalogRequest, type SourcePack, type CatalogMapping,
  type SetCatalogMatchRequest, type CatalogRevision, type CatalogMatch, type CatalogSnapshot,
  type CatalogSnapshotEntry, type CatalogCompletion, type CatalogRevisionDetail,
  type CatalogRevisionPreview, type CatalogHistory, type CollectionModel,
  type PreviewReferenceSourceZipRequest, type ReferenceSourceZipPreview,
  type RegisterReferenceSourceZipRequest, type RegisterReferenceSourceZipResult,
  type ReferenceSourceZipReceipt, type ReferenceSourceZipReceiptListRequest, type ReferenceSourceZipReceiptPage,
} from '@music-bridge/contracts';
import { parseReferenceSourceZip, ReferenceSourceZipError } from './reference-source-zip.js';

const tables = {
  reference_sources: 'CREATE TABLE reference_sources(id TEXT PRIMARY KEY,book_id TEXT NOT NULL,pack_hash TEXT NOT NULL,raw_pack TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(book_id,pack_hash)) STRICT',
  reference_catalog_revisions: 'CREATE TABLE reference_catalog_revisions(id TEXT PRIMARY KEY,book_id TEXT NOT NULL,source_id TEXT NOT NULL REFERENCES reference_sources(id),sequence INTEGER NOT NULL,previous_id TEXT REFERENCES reference_catalog_revisions(id),data TEXT NOT NULL,UNIQUE(book_id,sequence)) STRICT',
  reference_catalog_heads: 'CREATE TABLE reference_catalog_heads(book_id TEXT PRIMARY KEY,current_revision_id TEXT NOT NULL REFERENCES reference_catalog_revisions(id)) STRICT',
  reference_catalog_matches: 'CREATE TABLE reference_catalog_matches(revision_id TEXT PRIMARY KEY REFERENCES reference_catalog_revisions(id),version INTEGER NOT NULL CHECK(version>=0),data TEXT NOT NULL) STRICT',
  reference_catalog_snapshots: 'CREATE TABLE reference_catalog_snapshots(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES reference_catalog_revisions(id),match_version INTEGER NOT NULL CHECK(match_version>=0),data TEXT NOT NULL) STRICT',
  reference_catalog_ledger: 'CREATE TABLE reference_catalog_ledger(command_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,kind TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL) STRICT',
} as const;
const immutableTables = ['reference_sources', 'reference_catalog_revisions', 'reference_catalog_snapshots', 'reference_catalog_ledger'] as const;
const triggers = immutableTables.flatMap(table => ['UPDATE', 'DELETE'].map(action => `CREATE TRIGGER ${table}_no_${action.toLowerCase()} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'immutable reference catalog'); END`));
export const referenceCatalogMigration = [...Object.values(tables), ...triggers, 'PRAGMA user_version=15'].join(';\n') + ';';
const zipReceiptTable = 'CREATE TABLE reference_source_zip_receipts(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES reference_sources(id),zip_hash TEXT NOT NULL,zip_bytes INTEGER NOT NULL,entry_name TEXT NOT NULL,raw_pack_hash TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(source_id,zip_hash)) STRICT';
const zipReceiptTriggers = ['UPDATE', 'DELETE'].map(action =>
  `CREATE TRIGGER reference_source_zip_receipts_no_${action.toLowerCase()} BEFORE ${action} ON reference_source_zip_receipts BEGIN SELECT RAISE(ABORT,'immutable reference catalog zip'); END`);
export const referenceCatalogZipMigration = [zipReceiptTable, ...zipReceiptTriggers, 'PRAGMA user_version=28'].join(';\n') + ';';
export const REFERENCE_CATALOG_LIMITS = { rowBytes: 8 * 1024 * 1024, totalBytes: 128 * 1024 * 1024, rows: 20_000 } as const;
const budgetColumns = {
  reference_sources: ['id', 'book_id', 'pack_hash', 'raw_pack', 'data'],
  reference_catalog_revisions: ['id', 'book_id', 'source_id', 'previous_id', 'data'],
  reference_catalog_heads: ['book_id', 'current_revision_id'],
  reference_catalog_matches: ['revision_id', 'data'],
  reference_catalog_snapshots: ['id', 'revision_id', 'data'],
  reference_catalog_ledger: ['command_id', 'fingerprint', 'kind', 'result', 'created_at'],
  reference_source_zip_receipts: ['id', 'source_id', 'zip_hash', 'zip_bytes', 'entry_name', 'raw_pack_hash', 'created_at'],
} as const;
class CatalogCapacityError extends Error { constructor() { super('参考目录容量达到上限；现有资料和历史不会被删除。'); } }
function assertBudget(db: DatabaseSync): void {
  let rows = 0, bytes = 0;
  // 先让 SQLite 计算长度，不把不受信任的超大 TEXT/JSON 分配进 JavaScript。
  for (const [table, columns] of Object.entries(budgetColumns)) {
    // schema 15 的独立历史测试尚没有 C11 表；新库迁移后必须把容器回执计入总预算。
    if (table === 'reference_source_zip_receipts' && !db.prepare('SELECT name FROM sqlite_master WHERE type=? AND name=?').get('table', table)) continue;
    const expression = columns.map(column => `COALESCE(length(CAST(${column} AS BLOB)),0)`).join('+');
    const amount = db.prepare(`SELECT count(*) rows,COALESCE(sum(${expression}),0) bytes,COALESCE(max(${expression}),0) largest FROM ${table}`).get()!;
    rows += Number(amount.rows); bytes += Number(amount.bytes);
    if (rows > REFERENCE_CATALOG_LIMITS.rows || bytes > REFERENCE_CATALOG_LIMITS.totalBytes || Number(amount.largest) > REFERENCE_CATALOG_LIMITS.rowBytes) throw new CatalogCapacityError();
  }
}
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(v);
const sha = (v: string): string => createHash('sha256').update(v).digest('hex');
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object') return `{${Object.entries(v).filter(([, value]) => value !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, value]) => `${JSON.stringify(k)}:${canonical(value)}`).join(',')}}`;
  return JSON.stringify(v);
}
const fingerprint = (v: unknown): string => sha(canonical(v));
const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
const corrupt = (): never => { throw new Error('参考目录记录缺失或损坏。'); };
function parse(value: unknown): unknown { if (typeof value !== 'string') return corrupt(); if (Buffer.byteLength(value) > REFERENCE_CATALOG_LIMITS.rowBytes) throw new CatalogCapacityError(); try { return JSON.parse(value); } catch { return corrupt(); } }
function normalizedItems(value: readonly CanonicalReference[]): CanonicalReference[] {
  const normalized = normalizeReferenceItems(value); if (!normalized) return corrupt(); return normalized;
}
interface VerificationContext {
  sources: Map<string, ReferenceSourceDetail>;
  revisions: Map<string, CatalogRevision>;
  snapshots: Map<string, CatalogSnapshot>;
  zipReceipts: Map<string, ReferenceSourceZipReceipt>;
  modelIds: Set<string>;
}
function verificationContext(): VerificationContext {
  // 仅本次完整只读校验持有；公开读写不复用，下一 owner/operation 重新读取所有事实。
  return { sources: new Map(), revisions: new Map(), snapshots: new Map(), zipReceipts: new Map(), modelIds: new Set() };
}
function modelExists(db: DatabaseSync, id: string, context?: VerificationContext): void {
  if (context) { context.modelIds.add(id); return; }
  if (!db.prepare('SELECT id FROM collection_models WHERE id=?').get(id)) return corrupt();
}
function verifyModels(db: DatabaseSync, context: VerificationContext): void {
  const ids = [...context.modelIds];
  for (let start = 0; start < ids.length; start += 50) {
    const block = ids.slice(start, start + 50);
    const found = new Set(db.prepare(`SELECT id FROM collection_models WHERE id IN (${block.map(() => '?').join(',')})`).all(...block).map(row => String(row.id)));
    if (block.some(id => !found.has(id))) return corrupt();
  }
}
function sourceData(db: DatabaseSync, id: string, context?: VerificationContext): ReferenceSourceDetail {
  const cached = context?.sources.get(id); if (cached) return cached;
  const row = db.prepare('SELECT * FROM reference_sources WHERE id=?').get(id); if (!row) return corrupt();
  const value = parse(row.data), rawPack = row.raw_pack;
  if (!isReferenceSourceVersion(value) || value.id !== row.id || value.bookId !== row.book_id || value.packHash !== row.pack_hash
    || typeof rawPack !== 'string' || Buffer.byteLength(rawPack) > MAX_REFERENCE_SOURCE_PACK_BYTES || Buffer.from(rawPack).toString('utf8') !== rawPack || sha(rawPack) !== value.packHash) return corrupt();
  const pack = parse(rawPack.replace(/^\uFEFF/u, ''));
  if (!isSourcePack(pack) || normalizeReferenceItems(pack.items)?.length !== value.itemCount || pack.bookId !== value.bookId || pack.title !== value.title || pack.sourceVersion !== value.sourceVersion) return corrupt();
  const result = { source: value, rawPack };
  context?.sources.set(id, result); return result;
}
function sourceZipReceiptData(db: DatabaseSync, id: string, context?: VerificationContext): ReferenceSourceZipReceipt {
  const cached = context?.zipReceipts.get(id); if (cached) return cached;
  const row = db.prepare('SELECT * FROM reference_source_zip_receipts WHERE id=?').get(id); if (!row) return corrupt();
  const value: ReferenceSourceZipReceipt = {
    id: String(row.id), sourceId: String(row.source_id), zipSha256: String(row.zip_hash), zipBytes: Number(row.zip_bytes),
    entryName: String(row.entry_name) as ReferenceSourceZipReceipt['entryName'],
    rawPackHash: String(row.raw_pack_hash), createdAt: String(row.created_at),
  };
  if (!isReferenceSourceZipReceipt(value) || sourceData(db, value.sourceId, context).source.packHash !== value.rawPackHash) return corrupt();
  context?.zipReceipts.set(id, value); return value;
}
function revisionData(db: DatabaseSync, id: string, context?: VerificationContext): CatalogRevision {
  const cached = context?.revisions.get(id); if (cached) return cached;
  const row = db.prepare('SELECT * FROM reference_catalog_revisions WHERE id=?').get(id); if (!row) return corrupt();
  const value = parse(row.data);
  if (!isCatalogRevision(value) || value.id !== row.id || value.bookId !== row.book_id || value.sourceId !== row.source_id || value.sequence !== row.sequence || value.previousRevisionId !== row.previous_id || !same(normalizedItems(value.items), value.items)) return corrupt();
  context?.revisions.set(id, value); return value;
}
function matchesData(db: DatabaseSync, revision: CatalogRevision, context?: VerificationContext): { matches: CatalogMatch[]; version: number } {
  const row = db.prepare('SELECT version,data FROM reference_catalog_matches WHERE revision_id=?').get(revision.id); if (!row) return corrupt();
  const matches = parse(row.data); const refs = new Set(revision.items.map(item => item.referenceId));
  if (!Array.isArray(matches) || matches.length > MAX_CATALOG_MATCHES || !Number.isSafeInteger(row.version) || Number(row.version) < 0 || !matches.every(value => isCatalogMatch(value) && refs.has(value.referenceId))) return corrupt();
  const keys = new Set<string>(), confirmed = new Set<string>();
  const groups = context ? new Map<string, { count: number; unmatched: boolean }>() : undefined;
  for (const match of matches as CatalogMatch[]) {
    const key = `${match.referenceId}:${match.modelId ?? ''}`;
    if (keys.has(key)) return corrupt();
    if (match.modelId) modelExists(db, match.modelId, context);
    keys.add(key);
    if (match.status === 'confirmed' && match.modelId) { if (confirmed.has(match.modelId)) return corrupt(); confirmed.add(match.modelId); }
    if (groups) {
      const group = groups.get(match.referenceId) ?? { count: 0, unmatched: false };
      group.count++; group.unmatched ||= match.status === 'unmatched'; groups.set(match.referenceId, group);
    }
  }
  for (const ref of refs) {
    if (groups) {
      const group = groups.get(ref);
      if (!group || group.count > 500 || group.count > 1 && group.unmatched) return corrupt();
    } else {
      const related = (matches as CatalogMatch[]).filter(match => match.referenceId === ref);
      if (related.length === 0 || related.length > 500 || related.length > 1 && related.some(match => match.status === 'unmatched')) return corrupt();
    }
  }
  return { matches: matches as CatalogMatch[], version: Number(row.version) };
}
function snapshotData(db: DatabaseSync, id: string, context?: VerificationContext): CatalogSnapshot {
  const cached = context?.snapshots.get(id); if (cached) return cached;
  const row = db.prepare('SELECT * FROM reference_catalog_snapshots WHERE id=?').get(id); if (!row) return corrupt();
  const value = parse(row.data);
  if (!isCatalogSnapshot(value) || value.id !== row.id || value.revisionId !== row.revision_id || value.matchVersion !== row.match_version) return corrupt();
  const revision = revisionData(db, value.revisionId, context);
  if (value.bookId !== revision.bookId || !same(value.entries.map(entry => entry.referenceId), revision.items.map(item => item.referenceId))) return corrupt();
  for (const match of value.entries.flatMap(entry => entry.matches)) if (match.modelId) modelExists(db, match.modelId, context);
  context?.snapshots.set(id, value); return value;
}

/** 备份校验只读复用；不迁移、不修复、不改变当前指针或快照。 */
export function verifyReferenceCatalogDatabase(db: DatabaseSync): void {
  const context = verificationContext(); verifyDatabase(db, context); verifyModels(db, context);
  if (db.prepare('PRAGMA foreign_key_check').all().length) return corrupt();
}
function verifyDatabase(db: DatabaseSync, context: VerificationContext): void {
  for (const [name, sql] of Object.entries(tables)) if (db.prepare('SELECT sql FROM sqlite_master WHERE type=? AND name=?').get('table', name)?.sql !== sql) return corrupt();
  for (const sql of triggers) { const name = sql.split(' ')[2]!; if (db.prepare('SELECT sql FROM sqlite_master WHERE type=? AND name=?').get('trigger', name)?.sql !== sql) return corrupt(); }
  assertBudget(db);
  for (const row of db.prepare('SELECT id FROM reference_sources').iterate()) sourceData(db, String(row.id), context);
  for (const row of db.prepare('SELECT id FROM reference_catalog_revisions').iterate()) {
    const revision = revisionData(db, String(row.id), context), source = sourceData(db, revision.sourceId, context).source;
    if (source.bookId !== revision.bookId || source.packHash !== revision.packHash) return corrupt();
    if (revision.previousRevisionId) { const previous = revisionData(db, revision.previousRevisionId, context); if (previous.bookId !== revision.bookId || previous.sequence + 1 !== revision.sequence) return corrupt(); }
    else if (revision.sequence !== 1 || revision.mappings.length) return corrupt();
    const state = matchesData(db, revision, context);
    const latest = db.prepare('SELECT id FROM reference_catalog_snapshots WHERE revision_id=? ORDER BY rowid DESC LIMIT 1').get(revision.id);
    if (!latest) return corrupt();
    const latestSnapshot = snapshotData(db, String(latest.id), context);
    const sortedMatches = (matches: readonly CatalogMatch[]) => [...matches].sort((a, b) => canonical(a).localeCompare(canonical(b)));
    if (latestSnapshot.matchVersion !== state.version || !same(sortedMatches(latestSnapshot.entries.flatMap(entry => entry.matches)), sortedMatches(state.matches))) return corrupt();
    const head = db.prepare('SELECT current_revision_id FROM reference_catalog_heads WHERE book_id=?').get(revision.bookId);
    if (!head || revisionData(db, String(head.current_revision_id), context).sequence < revision.sequence) return corrupt();
  }
  for (const row of db.prepare('SELECT * FROM reference_catalog_heads').iterate()) if (revisionData(db, String(row.current_revision_id), context).bookId !== row.book_id) return corrupt();
  for (const row of db.prepare('SELECT id FROM reference_catalog_snapshots').iterate()) snapshotData(db, String(row.id), context);
  for (const row of db.prepare('SELECT * FROM reference_catalog_ledger').iterate()) {
    if (!uuid(row.command_id) || typeof row.fingerprint !== 'string' || !/^[0-9a-f]{64}$/u.test(row.fingerprint) || typeof row.created_at !== 'string' || !Number.isFinite(Date.parse(row.created_at))) return corrupt();
    const result = parse(row.result);
    if (row.kind === 'source') { if (!isReferenceSourceVersion(result) || !same(result, sourceData(db, result.id, context).source)) return corrupt(); }
    else if (row.kind === 'source-zip') {
      if (!isRegisterReferenceSourceZipResult(result) || !same(result.source, sourceData(db, result.source.id, context).source)
        || !same(result.receipt, sourceZipReceiptData(db, result.receipt.id, context))) return corrupt();
    }
    else if (row.kind === 'publish' || row.kind === 'match' || row.kind === 'archive-import') {
      if (!isCatalogRevisionDetail(result) || !same(result.revision, revisionData(db, result.revision.id, context)) || !same(result.snapshot, snapshotData(db, result.snapshot.id, context))) return corrupt();
      if (row.kind === 'archive-import') {
        const pack = parseReferenceSourcePack(sourceData(db, result.revision.sourceId, context).rawPack);
        const archiveSha256 = result.revision.items[0]?.archive?.sha256;
        if (!pack || !archiveSha256 || !same(normalizedItems(pack.items), result.revision.items)
          || result.revision.items.some(item => item.archive?.sha256 !== archiveSha256)) return corrupt();
      }
    } else return corrupt();
  }
}

/** C11 容器回执只读校验；原 ZIP 不归档，也不能由缺失原 ZIP 推断来源无效。 */
export function verifyReferenceCatalogZipDatabase(db: DatabaseSync): void {
  if (db.prepare('SELECT sql FROM sqlite_master WHERE type=? AND name=?').get('table', 'reference_source_zip_receipts')?.sql !== zipReceiptTable) return corrupt();
  for (const sql of zipReceiptTriggers) {
    const name = sql.split(' ')[2]!;
    if (db.prepare('SELECT sql FROM sqlite_master WHERE type=? AND name=?').get('trigger', name)?.sql !== sql) return corrupt();
  }
  const context = verificationContext(); verifyDatabase(db, context);
  for (const row of db.prepare('SELECT id FROM reference_source_zip_receipts').iterate()) sourceZipReceiptData(db, String(row.id), context);
  verifyModels(db, context);
  if (db.prepare('PRAGMA foreign_key_check').all().length) return corrupt();
}

interface Access {
  read<T>(operation: (db: DatabaseSync) => T): T;
  model(db: DatabaseSync, id: string): CollectionModel;
  conflict(message: string): never;
  beforeCommit?: (action: string) => void;
  stagingRoot?: string;
}
export function createReferenceCatalogStore({ read: accessRead, model, conflict, beforeCommit, stagingRoot }: Access) {
  const invalid = (): never => conflict('参考资料或目录请求无效，请重新预览。');
  function read<T>(operation: (db: DatabaseSync) => T): T {
    return accessRead(db => { try { assertBudget(db); return operation(db); } catch (error) { if (error instanceof CatalogCapacityError) return conflict(error.message); throw error; } });
  }
  function transaction<T>(action: string, operation: (db: DatabaseSync) => T): T {
    return read(db => { db.exec('BEGIN IMMEDIATE'); try { const result = operation(db); assertBudget(db); beforeCommit?.(action); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } });
  }
  function id(value: unknown): string { if (!uuid(value)) return invalid(); return value; }
  function page(request: { offset: number; limit: number }): void { if (!Number.isSafeInteger(request.offset) || request.offset < 0 || request.offset > 1_000_000 || !Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 25) invalid(); }
  function receipt<T>(db: DatabaseSync, commandId: string, fp: string, kind: string): T | undefined {
    const row = db.prepare('SELECT fingerprint,kind,result FROM reference_catalog_ledger WHERE command_id=?').get(commandId);
    if (!row) return undefined;
    if (row.fingerprint !== fp || row.kind !== kind) return conflict('同一操作编号不能用于不同的参考目录内容。');
    const result = parse(row.result);
    if (kind === 'source' ? !isReferenceSourceVersion(result)
      : kind === 'source-zip' ? !isRegisterReferenceSourceZipResult(result) : !isCatalogRevisionDetail(result)) return corrupt();
    return result as T;
  }
  function record(db: DatabaseSync, commandId: string, fp: string, kind: string, result: unknown): void {
    db.prepare('INSERT INTO reference_catalog_ledger VALUES(?,?,?,?,?)').run(commandId, fp, kind, JSON.stringify(result), new Date().toISOString());
  }
  async function zipInput(zipBase64: string) {
    if (!stagingRoot) return conflict('资料包暂存目录未配置，原 ZIP 未被登记。');
    try { return await parseReferenceSourceZip(zipBase64, stagingRoot); }
    catch (error) {
      if (error instanceof ReferenceSourceZipError) {
        if (error.code === 'INVALID_BASE64') return conflict('ZIP 编码或大小无效；最多接受 4 MiB 原容器。');
        if (error.code === 'INVALID_SOURCE') return conflict('ZIP 内的 schemaVersion 1 JSON 无效；外部图片路径或未定义字段不能登记。');
        if (error.code === 'STAGING_UNAVAILABLE' || error.code === 'STAGING_CLEANUP_FAILED') return conflict('资料包暂存不可用或未能安全清理；原 ZIP 未被登记。');
      }
      return conflict('ZIP 必须仅含根目录 catalog.json 或 source.json，且通过完整 CRC、SHA 与路径校验。');
    }
  }
  function current(db: DatabaseSync, bookId: string): CatalogRevision | null {
    const row = db.prepare('SELECT current_revision_id FROM reference_catalog_heads WHERE book_id=?').get(bookId);
    return row ? revisionData(db, String(row.current_revision_id)) : null;
  }
  function completion(db: DatabaseSync, revision: Pick<CatalogRevision, 'items'>, matches: CatalogMatch[]) {
    const evidence = new Map<string, unknown>();
    const entries: CatalogSnapshotEntry[] = revision.items.map(item => {
      const related = matches.filter(match => match.referenceId === item.referenceId);
      let stockCount = 0;
      for (const match of related) if (match.modelId) {
        const stock = model(db, match.modelId);
        evidence.set(match.modelId, { id: stock.id, revision: stock.revision, counts: stock.counts, lengths: stock.lengths });
        if (match.status === 'confirmed') stockCount += stock.counts.total;
      }
      const state = stockCount > 0 ? 'owned' : related.some(match => match.status === 'unmatched' && match.availability === 'missing') ? 'missing' : 'unknown';
      return { referenceId: item.referenceId, state, stockCount, matches: structuredClone(related) };
    });
    const counts: CatalogCompletion = { total: entries.length, owned: 0, missing: 0, unknown: 0, candidate: 0, needsReview: 0 };
    for (const entry of entries) {
      counts[entry.state]++;
      if (entry.state === 'unknown' && entry.matches.some(match => match.status === 'candidate')) counts.candidate++;
      if (entry.state === 'unknown' && entry.matches.some(match => match.status === 'needs-review')) counts.needsReview++;
    }
    return { entries, counts, evidence: [...evidence.entries()].sort(([a], [b]) => a.localeCompare(b)) };
  }
  function snapshot(db: DatabaseSync, revision: CatalogRevision, matches: CatalogMatch[], version: number): CatalogSnapshot {
    const value = completion(db, revision, matches);
    const result: CatalogSnapshot = { id: randomUUID(), bookId: revision.bookId, revisionId: revision.id, matchVersion: version, createdAt: new Date().toISOString(), counts: value.counts, entries: value.entries };
    if (!isCatalogSnapshot(result)) return corrupt();
    db.prepare('INSERT INTO reference_catalog_snapshots VALUES(?,?,?,?)').run(result.id, revision.id, version, JSON.stringify(result)); return result;
  }
  function detail(db: DatabaseSync, revision: CatalogRevision): CatalogRevisionDetail {
    const state = matchesData(db, revision), value = completion(db, revision, state.matches);
    const latest = db.prepare('SELECT id FROM reference_catalog_snapshots WHERE revision_id=? ORDER BY rowid DESC LIMIT 1').get(revision.id);
    if (!latest) return corrupt();
    const result = { revision, matches: state.matches, matchVersion: state.version, snapshot: snapshotData(db, String(latest.id)), currentCounts: value.counts, currentEntries: value.entries };
    if (!isCatalogRevisionDetail(result)) return corrupt(); return result;
  }
  const unmatched = (referenceId: string, availability: 'missing' | 'unknown' = 'unknown'): CatalogMatch => ({ referenceId, modelId: null, status: 'unmatched', availability });
  function transfer(items: CanonicalReference[], request: Pick<PreviewCatalogRevisionRequest, 'mappings'>, previous: CatalogRevision | null, prior: CatalogMatch[]): CatalogMatch[] {
    const oldRefs = new Set(previous?.items.map(item => item.referenceId) ?? []), newRefs = new Set(items.map(item => item.referenceId));
    if (!previous && request.mappings.length) return invalid();
    const output = new Map<string, CatalogMatch[]>();
    for (const mapping of request.mappings) {
      if (mapping.fromReferenceIds.some(ref => !oldRefs.has(ref)) || mapping.toReferenceIds.some(ref => !newRefs.has(ref))) return conflict('目录映射引用不存在，请重新预览。');
      const from = prior.filter(match => mapping.fromReferenceIds.includes(match.referenceId));
      for (const ref of mapping.toReferenceIds) {
        const related = new Map<string, CatalogMatch>();
        for (const match of from) if (match.modelId) {
          const next = { ...match, referenceId: ref, ...(mapping.toReferenceIds.length > 1 ? { status: 'needs-review' as const } : {}) };
          const existing = related.get(match.modelId);
          if (!existing || next.status === 'confirmed' || existing.status === 'candidate') related.set(match.modelId, next);
        }
        const allMissing = mapping.toReferenceIds.length === 1 && from.length > 0 && from.every(match => match.availability === 'missing');
        output.set(ref, related.size ? [...related.values()] : [unmatched(ref, allMissing ? 'missing' : 'unknown')]);
      }
    }
    const result = items.flatMap(item => output.get(item.referenceId) ?? [unmatched(item.referenceId)]);
    if (result.length > MAX_CATALOG_MATCHES || items.some(item => result.filter(match => match.referenceId === item.referenceId).length > 500)) return conflict('目录关联数量已超过有界范围，请拆分整理。');
    const models = result.filter(match => match.status === 'confirmed').map(match => match.modelId);
    if (new Set(models).size !== models.length) return conflict('同一库存型号不能确认贡献两个目录项目。');
    return result;
  }
  function preview(db: DatabaseSync, request: PreviewCatalogRevisionRequest) {
    const source = sourceData(db, request.sourceId).source, previous = current(db, source.bookId);
    if ((previous?.id ?? null) !== request.expectedCurrentRevisionId) return conflict('当前目录版本已改变，请重新预览。');
    const items = normalizedItems(request.items);
    if (items.some(item => item.bookId !== source.bookId)) return conflict('目录项目必须属于同一本书籍或参考集合。');
    const oldState = previous ? matchesData(db, previous) : { matches: [], version: 0 };
    const matches = transfer(items, request, previous, oldState.matches), after = completion(db, { items }, matches);
    const before = previous ? completion(db, previous, oldState.matches) : null;
    const oldRefs = new Set(previous?.items.map(item => item.referenceId) ?? []), newRefs = new Set(items.map(item => item.referenceId));
    const delta = { addedReferenceIds: [...newRefs].filter(ref => !oldRefs.has(ref)), removedReferenceIds: [...oldRefs].filter(ref => !newRefs.has(ref)), retainedReferenceIds: [...newRefs].filter(ref => oldRefs.has(ref)), merged: request.mappings.filter(mapping => mapping.fromReferenceIds.length > 1).length, split: request.mappings.filter(mapping => mapping.toReferenceIds.length > 1).length, before: before?.counts ?? null, after: after.counts };
    const baselineFingerprint = fingerprint({ source, previous, oldState, before, items, mappings: request.mappings, after });
    const result: CatalogRevisionPreview = { baselineFingerprint, expectedCurrentRevisionId: request.expectedCurrentRevisionId, counts: after.counts, entries: after.entries, delta };
    return { result, source, previous, oldState, items, matches };
  }
  function registerSourceData(db: DatabaseSync, pack: SourcePack, rawPack: string, packHash: string): ReferenceSourceVersion {
    const existing = db.prepare('SELECT id FROM reference_sources WHERE book_id=? AND pack_hash=?').get(pack.bookId, packHash);
    const value: ReferenceSourceVersion = existing ? sourceData(db, String(existing.id)).source : {
      id: randomUUID(), bookId: pack.bookId, title: pack.title, sourceVersion: pack.sourceVersion,
      packHash, itemCount: normalizedItems(pack.items).length, createdAt: new Date().toISOString(),
    };
    if (!isReferenceSourceVersion(value)) return corrupt();
    if (!existing) db.prepare('INSERT INTO reference_sources VALUES(?,?,?,?,?)').run(value.id, value.bookId, value.packHash, rawPack, JSON.stringify(value));
    return value;
  }
  function publishRevisionData(db: DatabaseSync, source: ReferenceSourceVersion, previous: CatalogRevision | null,
    items: CanonicalReference[], mappings: readonly CatalogMapping[], matches: CatalogMatch[], oldState: { matches: CatalogMatch[]; version: number }): CatalogRevisionDetail {
    const revision: CatalogRevision = {
      id: randomUUID(), bookId: source.bookId, sourceId: source.id, packHash: source.packHash,
      sequence: (previous?.sequence ?? 0) + 1, previousRevisionId: previous?.id ?? null,
      items, mappings: structuredClone(mappings), createdAt: new Date().toISOString(),
    };
    if (!isCatalogRevision(revision)) return corrupt();
    if (previous) snapshot(db, previous, oldState.matches, oldState.version);
    db.prepare('INSERT INTO reference_catalog_revisions VALUES(?,?,?,?,?,?)').run(revision.id, revision.bookId, revision.sourceId, revision.sequence, revision.previousRevisionId, JSON.stringify(revision));
    db.prepare('INSERT INTO reference_catalog_matches VALUES(?,?,?)').run(revision.id, 0, JSON.stringify(matches));
    db.prepare('INSERT INTO reference_catalog_heads VALUES(?,?) ON CONFLICT(book_id) DO UPDATE SET current_revision_id=excluded.current_revision_id').run(revision.bookId, revision.id);
    snapshot(db, revision, matches, 0);
    return detail(db, revision);
  }
  function archiveInput(archiveSha256: string, rawPack: string) {
    const pack = parseReferenceSourcePack(rawPack);
    if (!pack || pack.items.some(item => item.archive?.sha256 !== archiveSha256)) return conflict('档案目录与完整 ZIP 身份不一致，原资料和资产未被登记。');
    return { pack, rawPack, packHash: sha(rawPack), items: normalizedItems(pack.items) };
  }
  function archiveIdentity(item: CanonicalReference): string {
    return canonical([item.bookId, item.brand, item.series, item.edition, item.model, item.iec, item.era]
      .map(value => typeof value === 'string' ? value.normalize('NFKC').trim().toLowerCase() : value));
  }
  function previewArchive(db: DatabaseSync, request: PreviewReferenceArchiveCatalogRequest, input: ReturnType<typeof archiveInput>) {
    const previous = current(db, input.pack.bookId), items = input.items;
    if ((previous?.id ?? null) !== request.expectedCurrentRevisionId) return conflict('当前目录版本已改变，请重新预览档案。');
    const byId = new Map(items.map(item => [item.referenceId, item]));
    for (const old of previous?.items ?? []) {
      const next = byId.get(old.referenceId);
      if (!next) return conflict('档案缺少旧目录编号；导入不能重编号、合并或拆分现有项目。');
      if (archiveIdentity(old) !== archiveIdentity(next)) return conflict('相同目录编号的型号或版次身份发生改变；导入已停止，旧关联保持原值。');
    }
    const published = db.prepare("SELECT id FROM reference_catalog_revisions WHERE book_id=? AND json_extract(data,'$.items[0].archive.sha256')=? LIMIT 1")
      .get(input.pack.bookId, request.archiveSha256);
    const reuse = Boolean(published && previous && previous.packHash === input.packHash && same(previous.items, items));
    if (published && !reuse) return conflict('这份档案已经导入，当前目录随后发生修改；不能用旧档案覆盖现有修订。');
    const mappings: CatalogMapping[] = (previous?.items ?? []).map(item => ({ fromReferenceIds: [item.referenceId], toReferenceIds: [item.referenceId] }));
    const oldState = previous ? matchesData(db, previous) : { matches: [], version: 0 };
    const matches = transfer(items, { mappings }, previous, oldState.matches), after = completion(db, { items }, matches);
    const before = previous ? completion(db, previous, oldState.matches) : null;
    const oldRefs = new Set(previous?.items.map(item => item.referenceId) ?? []);
    // 档案绑定另由完整 SHA 展示；其余资料字段的改变必须在保留项目差异中可见。
    const updatedReferenceIds = (previous?.items ?? []).filter(old => !same({ ...old, archive: undefined }, { ...byId.get(old.referenceId)!, archive: undefined })).map(item => item.referenceId);
    const delta = {
      addedReferenceIds: items.filter(item => !oldRefs.has(item.referenceId)).map(item => item.referenceId),
      removedReferenceIds: [], retainedReferenceIds: items.filter(item => oldRefs.has(item.referenceId)).map(item => item.referenceId),
      updatedReferenceIds, merged: 0, split: 0, before: before?.counts ?? null, after: after.counts,
    };
    const baselineFingerprint = fingerprint({ archiveSha256: request.archiveSha256, expectedDatasetId: request.expectedDatasetId, packHash: input.packHash, previous, oldState, before, items, mappings, after });
    const result: CatalogRevisionPreview = { baselineFingerprint, expectedCurrentRevisionId: request.expectedCurrentRevisionId, counts: after.counts, entries: after.entries, delta };
    return { result, previous, oldState, items, mappings, matches, reuse };
  }
  return {
    registerSource(request: RegisterReferenceSourceRequest): ReferenceSourceVersion {
      if (!isRegisterReferenceSourceRequest(request) || Buffer.from(request.rawPack).toString('utf8') !== request.rawPack || sha(request.rawPack) !== request.packHash) return invalid();
      const pack = parse(request.rawPack.replace(/^\uFEFF/u, ''));
      if (!isSourcePack(pack) || !normalizeReferenceItems(pack.items)) return invalid();
      return transaction('register-reference-source', db => {
        const fp = fingerprint(['source', request]), prior = receipt<ReferenceSourceVersion>(db, request.commandId, fp, 'source'); if (prior) return prior;
        const value = registerSourceData(db, pack, request.rawPack, request.packHash);
        record(db, request.commandId, fp, 'source', value); return value;
      });
    },
    /** rawPack 只能由 Core 从已校验的自有档案读取，不能来自公开请求或 Renderer 路径。 */
    previewArchiveCatalog(request: PreviewReferenceArchiveCatalogRequest, rawPack: string): CatalogRevisionPreview {
      if (!isPreviewReferenceArchiveCatalogRequest(request)) return invalid();
      const input = archiveInput(request.archiveSha256, rawPack);
      return read(db => previewArchive(db, request, input).result);
    },
    /** 来源、修订、完整自映射、快照和回执使用同一个事务，不创建任何个人库存。 */
    importArchiveCatalog(request: ImportReferenceArchiveCatalogRequest, rawPack: string): CatalogRevisionDetail {
      if (!isImportReferenceArchiveCatalogRequest(request)) return invalid();
      const input = archiveInput(request.archiveSha256, rawPack);
      return transaction('import-reference-archive-catalog', db => {
        const fp = fingerprint(['archive-import', request, input.packHash]);
        const prior = receipt<CatalogRevisionDetail>(db, request.commandId, fp, 'archive-import');
        if (prior) return prior;
        const planned = previewArchive(db, request, input);
        if (planned.result.baselineFingerprint !== request.baselineFingerprint) return conflict('档案预览基线已改变，请重新核对后确认。');
        const result = planned.reuse && planned.previous ? detail(db, planned.previous) : publishRevisionData(db,
          registerSourceData(db, input.pack, input.rawPack, input.packHash), planned.previous,
          planned.items, planned.mappings, planned.matches, planned.oldState);
        record(db, request.commandId, fp, 'archive-import', result);
        return result;
      });
    },
    async previewSourceZip(request: PreviewReferenceSourceZipRequest): Promise<ReferenceSourceZipPreview> {
      if (!isPreviewReferenceSourceZipRequest(request)) return invalid();
      return (await zipInput(request.zipBase64)).preview;
    },
    async registerSourceZip(request: RegisterReferenceSourceZipRequest): Promise<RegisterReferenceSourceZipResult> {
      if (!isRegisterReferenceSourceZipRequest(request)) return invalid();
      const parsed = await zipInput(request.zipBase64);
      if (parsed.preview.zipSha256 !== request.expectedZipSha256
        || parsed.preview.rawPackHash !== request.expectedRawPackHash) return conflict('ZIP 或 JSON 字节与确认时预览不一致；请重新预览原文件。');
      return transaction('register-reference-source-zip', db => {
        const fp = fingerprint(['source-zip', request.commandId, parsed.preview.zipSha256, parsed.preview.rawPackHash]);
        const prior = receipt<RegisterReferenceSourceZipResult>(db, request.commandId, fp, 'source-zip');
        if (prior) return prior;
        const existing = db.prepare('SELECT id FROM reference_sources WHERE book_id=? AND pack_hash=?').get(parsed.pack.bookId, parsed.preview.rawPackHash);
        const source: ReferenceSourceVersion = existing ? sourceData(db, String(existing.id)).source : {
          id: randomUUID(), bookId: parsed.pack.bookId, title: parsed.pack.title,
          sourceVersion: parsed.pack.sourceVersion, packHash: parsed.preview.rawPackHash,
          itemCount: parsed.preview.itemCount, createdAt: new Date().toISOString(),
        };
        if (!isReferenceSourceVersion(source)) return corrupt();
        if (!existing) db.prepare('INSERT INTO reference_sources VALUES(?,?,?,?,?)').run(source.id, source.bookId, source.packHash, parsed.rawPack, JSON.stringify(source));
        const priorReceipt = db.prepare('SELECT id FROM reference_source_zip_receipts WHERE source_id=? AND zip_hash=?').get(source.id, parsed.preview.zipSha256);
        const zipReceipt: ReferenceSourceZipReceipt = priorReceipt ? sourceZipReceiptData(db, String(priorReceipt.id)) : {
          id: randomUUID(), sourceId: source.id, zipSha256: parsed.preview.zipSha256,
          zipBytes: parsed.preview.zipBytes, entryName: parsed.preview.entryName,
          rawPackHash: parsed.preview.rawPackHash, createdAt: new Date().toISOString(),
        };
        if (!isReferenceSourceZipReceipt(zipReceipt) || zipReceipt.zipBytes !== parsed.preview.zipBytes
          || zipReceipt.entryName !== parsed.preview.entryName || zipReceipt.rawPackHash !== parsed.preview.rawPackHash) return corrupt();
        if (!priorReceipt) db.prepare('INSERT INTO reference_source_zip_receipts VALUES(?,?,?,?,?,?,?)').run(
          zipReceipt.id, zipReceipt.sourceId, zipReceipt.zipSha256, zipReceipt.zipBytes,
          zipReceipt.entryName, zipReceipt.rawPackHash, zipReceipt.createdAt);
        const result = { source, receipt: zipReceipt };
        record(db, request.commandId, fp, 'source-zip', result);
        return result;
      });
    },
    sourceZipReceipts(request: ReferenceSourceZipReceiptListRequest): ReferenceSourceZipReceiptPage {
      if (!isReferenceSourceZipReceiptListRequest(request)) return invalid(); page(request);
      return read(db => {
        sourceData(db, request.sourceId);
        const total = Number(db.prepare('SELECT count(*) n FROM reference_source_zip_receipts WHERE source_id=?').get(request.sourceId)?.n);
        const items = db.prepare('SELECT id FROM reference_source_zip_receipts WHERE source_id=? ORDER BY rowid DESC LIMIT ? OFFSET ?')
          .all(request.sourceId, request.limit, request.offset).map(row => sourceZipReceiptData(db, String(row.id)));
        return { items, total, offset: request.offset, limit: request.limit };
      });
    },
    sources(request: { bookId?: string; offset: number; limit: number }) {
      if (!isReferenceSourceListRequest(request)) return invalid(); page(request);
      return read(db => {
        const where = request.bookId ? ' WHERE book_id=?' : '', args = request.bookId ? [request.bookId] : [];
        const total = Number(db.prepare('SELECT count(*) n FROM reference_sources' + where).get(...args)?.n);
        return { items: db.prepare('SELECT id FROM reference_sources' + where + ' ORDER BY rowid DESC LIMIT ? OFFSET ?').all(...args, request.limit, request.offset).map(row => sourceData(db, String(row.id)).source), total, offset: request.offset, limit: request.limit };
      });
    },
    source(request: { id: string }): ReferenceSourceDetail { if (!isCatalogIdRequest(request)) return invalid(); return read(db => sourceData(db, id(request.id))); },
    previewRevision(request: PreviewCatalogRevisionRequest): CatalogRevisionPreview {
      if (!isPreviewCatalogRevisionRequest(request)) return invalid(); return read(db => preview(db, request).result);
    },
    publishRevision(request: PublishCatalogRevisionRequest): CatalogRevisionDetail {
      if (!isPublishCatalogRevisionRequest(request)) return invalid();
      return transaction('publish-reference-catalog', db => {
        const fp = fingerprint(['publish', request]), prior = receipt<CatalogRevisionDetail>(db, request.commandId, fp, 'publish'); if (prior) return prior;
        const planned = preview(db, request);
        if (planned.result.baselineFingerprint !== request.baselineFingerprint) return conflict('目录预览基线已改变，请重新核对后确认。');
        const result = publishRevisionData(db, planned.source, planned.previous, planned.items, request.mappings, planned.matches, planned.oldState);
        record(db, request.commandId, fp, 'publish', result); return result;
      });
    },
    revision(request: { id: string }): CatalogRevisionDetail { if (!isCatalogIdRequest(request)) return invalid(); return read(db => detail(db, revisionData(db, id(request.id)))); },
    setMatch(request: SetCatalogMatchRequest): CatalogRevisionDetail {
      if (!isSetCatalogMatchRequest(request)) return invalid();
      return transaction('set-reference-catalog-match', db => {
        const fp = fingerprint(['match', request]), prior = receipt<CatalogRevisionDetail>(db, request.commandId, fp, 'match'); if (prior) return prior;
        const revision = revisionData(db, request.revisionId), state = matchesData(db, revision);
        if (current(db, revision.bookId)?.id !== revision.id) return conflict('历史目录不能改写匹配，请在当前版本确认。');
        if (state.version !== request.expectedMatchVersion) return conflict('目录匹配版本已改变，请刷新后确认。');
        if (!revision.items.some(item => item.referenceId === request.match.referenceId)) return invalid();
        if (request.match.modelId) model(db, request.match.modelId);
        const matches = state.matches.filter(match => match.referenceId !== request.match.referenceId);
        if (request.match.status === 'confirmed' && matches.some(match => match.status === 'confirmed' && match.modelId === request.match.modelId)) return conflict('同一库存型号不能确认贡献两个目录项目。');
        matches.push(structuredClone(request.match));
        db.prepare('UPDATE reference_catalog_matches SET version=?,data=? WHERE revision_id=?').run(state.version + 1, JSON.stringify(matches), revision.id);
        snapshot(db, revision, matches, state.version + 1);
        const result = detail(db, revision); record(db, request.commandId, fp, 'match', result); return result;
      });
    },
    snapshot(request: { id: string }): CatalogSnapshot { if (!isCatalogIdRequest(request)) return invalid(); return read(db => snapshotData(db, id(request.id))); },
    history(request: { bookId: string; offset: number; limit: number }): CatalogHistory {
      if (!isCatalogHistoryRequest(request)) return invalid(); page(request);
      return read(db => {
        const revisions = db.prepare('SELECT id FROM reference_catalog_revisions WHERE book_id=? ORDER BY sequence DESC LIMIT ? OFFSET ?').all(request.bookId, request.limit, request.offset).map(row => revisionData(db, String(row.id)));
        const snapshots = revisions.flatMap(revision => {
          const ids = db.prepare('SELECT id FROM reference_catalog_snapshots WHERE revision_id=? AND rowid IN (SELECT min(rowid) FROM reference_catalog_snapshots WHERE revision_id=? UNION SELECT max(rowid) FROM reference_catalog_snapshots WHERE revision_id=?) ORDER BY rowid').all(revision.id, revision.id, revision.id);
          return ids.map(row => { const { entries: _, ...summary } = snapshotData(db, String(row.id)); return summary; });
        });
        return { bookId: request.bookId, currentRevisionId: current(db, request.bookId)?.id ?? null, revisions: revisions.map(({ items, mappings: _, ...value }) => ({ ...value, itemCount: items.length })), snapshots, total: Number(db.prepare('SELECT count(*) n FROM reference_catalog_revisions WHERE book_id=?').get(request.bookId)?.n), offset: request.offset, limit: request.limit };
      });
    },
  };
}
export type ReferenceCatalogStore = ReturnType<typeof createReferenceCatalogStore>;
