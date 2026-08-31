import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  isRegisterReferenceSourceRequest, isSourcePack, isReferenceSourceVersion,
  isCatalogIdRequest, isCatalogHistoryRequest, isReferenceSourceListRequest,
  isPreviewCatalogRevisionRequest, isPublishCatalogRevisionRequest, isSetCatalogMatchRequest,
  isCatalogRevision, isCatalogMatch, isCatalogSnapshot, isCatalogRevisionDetail,
  normalizeReferenceItems, MAX_REFERENCE_SOURCE_PACK_BYTES, MAX_CATALOG_MATCHES,
  type CanonicalReference, type ReferenceSourceVersion, type ReferenceSourceDetail,
  type RegisterReferenceSourceRequest, type PreviewCatalogRevisionRequest, type PublishCatalogRevisionRequest,
  type SetCatalogMatchRequest, type CatalogRevision, type CatalogMatch, type CatalogSnapshot,
  type CatalogSnapshotEntry, type CatalogCompletion, type CatalogRevisionDetail,
  type CatalogRevisionPreview, type CatalogHistory, type CollectionModel,
} from '@music-bridge/contracts';

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
export const REFERENCE_CATALOG_LIMITS = { rowBytes: 8 * 1024 * 1024, totalBytes: 128 * 1024 * 1024, rows: 20_000 } as const;
const budgetColumns = {
  reference_sources: ['id', 'book_id', 'pack_hash', 'raw_pack', 'data'],
  reference_catalog_revisions: ['id', 'book_id', 'source_id', 'previous_id', 'data'],
  reference_catalog_heads: ['book_id', 'current_revision_id'],
  reference_catalog_matches: ['revision_id', 'data'],
  reference_catalog_snapshots: ['id', 'revision_id', 'data'],
  reference_catalog_ledger: ['command_id', 'fingerprint', 'kind', 'result', 'created_at'],
} as const;
class CatalogCapacityError extends Error { constructor() { super('参考目录容量达到上限；现有资料和历史不会被删除。'); } }
function assertBudget(db: DatabaseSync): void {
  let rows = 0, bytes = 0;
  // 先让 SQLite 计算长度，不把不受信任的超大 TEXT/JSON 分配进 JavaScript。
  for (const [table, columns] of Object.entries(budgetColumns)) {
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
function sourceData(db: DatabaseSync, id: string): ReferenceSourceDetail {
  const row = db.prepare('SELECT * FROM reference_sources WHERE id=?').get(id); if (!row) return corrupt();
  const value = parse(row.data), rawPack = row.raw_pack;
  if (!isReferenceSourceVersion(value) || value.id !== row.id || value.bookId !== row.book_id || value.packHash !== row.pack_hash
    || typeof rawPack !== 'string' || Buffer.byteLength(rawPack) > MAX_REFERENCE_SOURCE_PACK_BYTES || Buffer.from(rawPack).toString('utf8') !== rawPack || sha(rawPack) !== value.packHash) return corrupt();
  const pack = parse(rawPack.replace(/^\uFEFF/u, ''));
  if (!isSourcePack(pack) || normalizeReferenceItems(pack.items)?.length !== value.itemCount || pack.bookId !== value.bookId || pack.title !== value.title || pack.sourceVersion !== value.sourceVersion) return corrupt();
  return { source: value, rawPack };
}
function revisionData(db: DatabaseSync, id: string): CatalogRevision {
  const row = db.prepare('SELECT * FROM reference_catalog_revisions WHERE id=?').get(id); if (!row) return corrupt();
  const value = parse(row.data);
  if (!isCatalogRevision(value) || value.id !== row.id || value.bookId !== row.book_id || value.sourceId !== row.source_id || value.sequence !== row.sequence || value.previousRevisionId !== row.previous_id || !same(normalizedItems(value.items), value.items)) return corrupt();
  return value;
}
function matchesData(db: DatabaseSync, revision: CatalogRevision): { matches: CatalogMatch[]; version: number } {
  const row = db.prepare('SELECT version,data FROM reference_catalog_matches WHERE revision_id=?').get(revision.id); if (!row) return corrupt();
  const matches = parse(row.data); const refs = new Set(revision.items.map(item => item.referenceId));
  if (!Array.isArray(matches) || matches.length > MAX_CATALOG_MATCHES || !Number.isSafeInteger(row.version) || Number(row.version) < 0 || !matches.every(value => isCatalogMatch(value) && refs.has(value.referenceId))) return corrupt();
  const keys = new Set<string>(), confirmed = new Set<string>();
  for (const match of matches as CatalogMatch[]) {
    const key = `${match.referenceId}:${match.modelId ?? ''}`;
    if (keys.has(key) || match.modelId && !db.prepare('SELECT id FROM collection_models WHERE id=?').get(match.modelId)) return corrupt();
    keys.add(key);
    if (match.status === 'confirmed' && match.modelId) { if (confirmed.has(match.modelId)) return corrupt(); confirmed.add(match.modelId); }
  }
  for (const ref of refs) {
    const related = (matches as CatalogMatch[]).filter(match => match.referenceId === ref);
    if (related.length === 0 || related.length > 500 || related.length > 1 && related.some(match => match.status === 'unmatched')) return corrupt();
  }
  return { matches: matches as CatalogMatch[], version: Number(row.version) };
}
function snapshotData(db: DatabaseSync, id: string): CatalogSnapshot {
  const row = db.prepare('SELECT * FROM reference_catalog_snapshots WHERE id=?').get(id); if (!row) return corrupt();
  const value = parse(row.data);
  if (!isCatalogSnapshot(value) || value.id !== row.id || value.revisionId !== row.revision_id || value.matchVersion !== row.match_version) return corrupt();
  const revision = revisionData(db, value.revisionId);
  if (value.bookId !== revision.bookId || !same(value.entries.map(entry => entry.referenceId), revision.items.map(item => item.referenceId))) return corrupt();
  for (const match of value.entries.flatMap(entry => entry.matches)) if (match.modelId && !db.prepare('SELECT id FROM collection_models WHERE id=?').get(match.modelId)) return corrupt();
  return value;
}

/** 备份校验只读复用；不迁移、不修复、不改变当前指针或快照。 */
export function verifyReferenceCatalogDatabase(db: DatabaseSync): void {
  for (const [name, sql] of Object.entries(tables)) if (db.prepare('SELECT sql FROM sqlite_master WHERE type=? AND name=?').get('table', name)?.sql !== sql) return corrupt();
  for (const sql of triggers) { const name = sql.split(' ')[2]!; if (db.prepare('SELECT sql FROM sqlite_master WHERE type=? AND name=?').get('trigger', name)?.sql !== sql) return corrupt(); }
  assertBudget(db);
  for (const row of db.prepare('SELECT id FROM reference_sources').iterate()) sourceData(db, String(row.id));
  for (const row of db.prepare('SELECT id FROM reference_catalog_revisions').iterate()) {
    const revision = revisionData(db, String(row.id)), source = sourceData(db, revision.sourceId).source;
    if (source.bookId !== revision.bookId || source.packHash !== revision.packHash) return corrupt();
    if (revision.previousRevisionId) { const previous = revisionData(db, revision.previousRevisionId); if (previous.bookId !== revision.bookId || previous.sequence + 1 !== revision.sequence) return corrupt(); }
    else if (revision.sequence !== 1 || revision.mappings.length) return corrupt();
    const state = matchesData(db, revision);
    const latest = db.prepare('SELECT id FROM reference_catalog_snapshots WHERE revision_id=? ORDER BY rowid DESC LIMIT 1').get(revision.id);
    if (!latest) return corrupt();
    const latestSnapshot = snapshotData(db, String(latest.id));
    const sortedMatches = (matches: readonly CatalogMatch[]) => [...matches].sort((a, b) => canonical(a).localeCompare(canonical(b)));
    if (latestSnapshot.matchVersion !== state.version || !same(sortedMatches(latestSnapshot.entries.flatMap(entry => entry.matches)), sortedMatches(state.matches))) return corrupt();
    const head = db.prepare('SELECT current_revision_id FROM reference_catalog_heads WHERE book_id=?').get(revision.bookId);
    if (!head || revisionData(db, String(head.current_revision_id)).sequence < revision.sequence) return corrupt();
  }
  for (const row of db.prepare('SELECT * FROM reference_catalog_heads').iterate()) if (revisionData(db, String(row.current_revision_id)).bookId !== row.book_id) return corrupt();
  for (const row of db.prepare('SELECT id FROM reference_catalog_snapshots').iterate()) snapshotData(db, String(row.id));
  for (const row of db.prepare('SELECT * FROM reference_catalog_ledger').iterate()) {
    if (!uuid(row.command_id) || typeof row.fingerprint !== 'string' || !/^[0-9a-f]{64}$/u.test(row.fingerprint) || typeof row.created_at !== 'string' || !Number.isFinite(Date.parse(row.created_at))) return corrupt();
    const result = parse(row.result);
    if (row.kind === 'source') { if (!isReferenceSourceVersion(result) || !same(result, sourceData(db, result.id).source)) return corrupt(); }
    else if (row.kind === 'publish' || row.kind === 'match') {
      if (!isCatalogRevisionDetail(result) || !same(result.revision, revisionData(db, result.revision.id)) || !same(result.snapshot, snapshotData(db, result.snapshot.id))) return corrupt();
    } else return corrupt();
  }
  if (db.prepare('PRAGMA foreign_key_check').all().length) return corrupt();
}

interface Access {
  read<T>(operation: (db: DatabaseSync) => T): T;
  model(db: DatabaseSync, id: string): CollectionModel;
  conflict(message: string): never;
  beforeCommit?: (action: string) => void;
}
export function createReferenceCatalogStore({ read: accessRead, model, conflict, beforeCommit }: Access) {
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
    if (kind === 'source' ? !isReferenceSourceVersion(result) : !isCatalogRevisionDetail(result)) return corrupt();
    return result as T;
  }
  function record(db: DatabaseSync, commandId: string, fp: string, kind: string, result: unknown): void {
    db.prepare('INSERT INTO reference_catalog_ledger VALUES(?,?,?,?,?)').run(commandId, fp, kind, JSON.stringify(result), new Date().toISOString());
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
  function transfer(items: CanonicalReference[], request: PreviewCatalogRevisionRequest, previous: CatalogRevision | null, prior: CatalogMatch[]): CatalogMatch[] {
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
  return {
    registerSource(request: RegisterReferenceSourceRequest): ReferenceSourceVersion {
      if (!isRegisterReferenceSourceRequest(request) || Buffer.from(request.rawPack).toString('utf8') !== request.rawPack || sha(request.rawPack) !== request.packHash) return invalid();
      const pack = parse(request.rawPack.replace(/^\uFEFF/u, ''));
      if (!isSourcePack(pack) || !normalizeReferenceItems(pack.items)) return invalid();
      return transaction('register-reference-source', db => {
        const fp = fingerprint(['source', request]), prior = receipt<ReferenceSourceVersion>(db, request.commandId, fp, 'source'); if (prior) return prior;
        const existing = db.prepare('SELECT id FROM reference_sources WHERE book_id=? AND pack_hash=?').get(pack.bookId, request.packHash);
        const value: ReferenceSourceVersion = existing ? sourceData(db, String(existing.id)).source : { id: randomUUID(), bookId: pack.bookId, title: pack.title, sourceVersion: pack.sourceVersion, packHash: request.packHash, itemCount: normalizeReferenceItems(pack.items)!.length, createdAt: new Date().toISOString() };
        if (!isReferenceSourceVersion(value)) return corrupt();
        if (!existing) db.prepare('INSERT INTO reference_sources VALUES(?,?,?,?,?)').run(value.id, value.bookId, value.packHash, request.rawPack, JSON.stringify(value));
        record(db, request.commandId, fp, 'source', value); return value;
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
        const revision: CatalogRevision = { id: randomUUID(), bookId: planned.source.bookId, sourceId: planned.source.id, packHash: planned.source.packHash, sequence: (planned.previous?.sequence ?? 0) + 1, previousRevisionId: planned.previous?.id ?? null, items: planned.items, mappings: structuredClone(request.mappings), createdAt: new Date().toISOString() };
        if (!isCatalogRevision(revision)) return corrupt();
        if (planned.previous) snapshot(db, planned.previous, planned.oldState.matches, planned.oldState.version);
        db.prepare('INSERT INTO reference_catalog_revisions VALUES(?,?,?,?,?,?)').run(revision.id, revision.bookId, revision.sourceId, revision.sequence, revision.previousRevisionId, JSON.stringify(revision));
        db.prepare('INSERT INTO reference_catalog_matches VALUES(?,?,?)').run(revision.id, 0, JSON.stringify(planned.matches));
        db.prepare('INSERT INTO reference_catalog_heads VALUES(?,?) ON CONFLICT(book_id) DO UPDATE SET current_revision_id=excluded.current_revision_id').run(revision.bookId, revision.id);
        snapshot(db, revision, planned.matches, 0);
        const result = detail(db, revision); record(db, request.commandId, fp, 'publish', result); return result;
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
