import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import * as dto from '@music-bridge/contracts';

const tables = {
  collection_wants: 'CREATE TABLE collection_wants(id TEXT PRIMARY KEY,version INTEGER NOT NULL CHECK(version>0),revision_id TEXT NOT NULL REFERENCES reference_catalog_revisions(id),data TEXT NOT NULL) STRICT',
  collection_want_events: 'CREATE TABLE collection_want_events(id TEXT NOT NULL REFERENCES collection_wants(id),version INTEGER NOT NULL CHECK(version>0),revision_id TEXT NOT NULL REFERENCES reference_catalog_revisions(id),command_id TEXT NOT NULL UNIQUE REFERENCES collection_progress_ledger(command_id) DEFERRABLE INITIALLY DEFERRED,data TEXT NOT NULL,PRIMARY KEY(id,version)) STRICT',
  collection_progress_snapshots: 'CREATE TABLE collection_progress_snapshots(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES reference_catalog_revisions(id),match_version INTEGER NOT NULL CHECK(match_version>=0),command_id TEXT NOT NULL UNIQUE REFERENCES collection_progress_ledger(command_id) DEFERRABLE INITIALLY DEFERRED,data TEXT NOT NULL) STRICT',
  collection_progress_ledger: 'CREATE TABLE collection_progress_ledger(command_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,kind TEXT NOT NULL,request TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL) STRICT',
} as const;
const immutable = ['collection_want_events', 'collection_progress_snapshots', 'collection_progress_ledger'] as const;
const triggers = immutable.flatMap(table => ['UPDATE', 'DELETE'].map(action => `CREATE TRIGGER ${table}_no_${action.toLowerCase()} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'immutable collection progress'); END`));
triggers.push("CREATE TRIGGER collection_wants_no_delete BEFORE DELETE ON collection_wants BEGIN SELECT RAISE(ABORT,'immutable want identity'); END");
export const collectionProgressMigration = [...Object.values(tables), ...triggers, 'PRAGMA user_version=17'].join(';\n') + ';';
export const COLLECTION_PROGRESS_LIMITS = { totalBytes: 128 * 1024 * 1024, jsonBytes: 8 * 1024 * 1024, wants: 10_000, history: 100_000, snapshots: 5_000 } as const;
class ProgressCapacityError extends Error { constructor() { super('收藏进度容量达到上限，现有目标和历史不会删除。'); } }
const corrupt = (): never => { throw new Error('收藏进度记录缺失或损坏。'); };
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, part]) => `${JSON.stringify(key)}:${canonical(part)}`).join(',')}}`;
  return JSON.stringify(value);
}
const fingerprint = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);
function parse<T>(raw: unknown, guard: (value: unknown) => value is T): T {
  if (typeof raw !== 'string') return corrupt(); if (Buffer.byteLength(raw) > COLLECTION_PROGRESS_LIMITS.jsonBytes) throw new ProgressCapacityError();
  const value: unknown = JSON.parse(raw); return guard(value) ? value : corrupt();
}
function budget(db: DatabaseSync): void {
  let totalBytes = 0, history = 0;
  for (const name of Object.keys(tables)) {
    const columns = db.prepare(`PRAGMA table_info(${name})`).all().filter(column => column.type === 'TEXT').map(column => String(column.name));
    const amount = db.prepare(`SELECT count(*) n,COALESCE(sum(${columns.map(column => `length(CAST(${column} AS BLOB))`).join('+')}),0) bytes FROM ${name}`).get()!;
    totalBytes += Number(amount.bytes);
    if (name === 'collection_want_events' || name === 'collection_progress_ledger') history += Number(amount.n);
    if (name === 'collection_wants' && Number(amount.n) > COLLECTION_PROGRESS_LIMITS.wants || name === 'collection_progress_snapshots' && Number(amount.n) > COLLECTION_PROGRESS_LIMITS.snapshots || totalBytes > COLLECTION_PROGRESS_LIMITS.totalBytes || history > COLLECTION_PROGRESS_LIMITS.history) throw new ProgressCapacityError();
    for (const column of columns.filter(column => ['data', 'request', 'result'].includes(column))) if (Number(db.prepare(`SELECT COALESCE(max(length(CAST(${column} AS BLOB))),0) n FROM ${name}`).get()?.n) > COLLECTION_PROGRESS_LIMITS.jsonBytes) throw new ProgressCapacityError();
  }
  // 输出合同同样有界：限制当前目标，取消不删除历史且可释放当前目标名额。
  if (db.prepare("SELECT 1 FROM collection_wants WHERE json_extract(data,'$.active')=1 GROUP BY revision_id,json_extract(data,'$.referenceId') HAVING count(*)>? LIMIT 1").get(dto.MAX_WANT_TARGETS_PER_REFERENCE)
    || db.prepare("SELECT 1 FROM collection_wants WHERE json_extract(data,'$.active')=1 GROUP BY revision_id HAVING count(*)>? LIMIT 1").get(dto.MAX_COLLECTION_PROGRESS_WANTS)) throw new ProgressCapacityError();
}
function revision(db: DatabaseSync, revisionId: string): dto.CatalogRevision {
  const row = db.prepare('SELECT * FROM reference_catalog_revisions WHERE id=?').get(revisionId); if (!row) return corrupt();
  const value = parse(row.data, dto.isCatalogRevision); if (value.id !== row.id || value.bookId !== row.book_id || value.sequence !== row.sequence) return corrupt(); return value;
}
function currentHead(db: DatabaseSync, bookId: string): string { const head = db.prepare('SELECT current_revision_id FROM reference_catalog_heads WHERE book_id=?').get(bookId); return typeof head?.current_revision_id === 'string' ? head.current_revision_id : corrupt(); }
function labels(db: DatabaseSync, value: dto.WantEntry): void {
  const catalog = revision(db, value.revisionId), reference = catalog.items.find(item => item.referenceId === value.referenceId);
  if (!reference || value.bookId !== catalog.bookId || !same([value.brand, value.series, value.model, value.edition], [reference.brand, reference.series, reference.model, reference.edition])) return corrupt();
}
function wantRow(db: DatabaseSync, id: string, version?: number): dto.WantEntry {
  const row = version === undefined ? db.prepare('SELECT * FROM collection_wants WHERE id=?').get(id) : db.prepare('SELECT * FROM collection_want_events WHERE id=? AND version=?').get(id, version); if (!row) return corrupt();
  const value = parse(row.data, dto.isWantEntry); if (value.id !== row.id || value.version !== row.version || value.revisionId !== row.revision_id) return corrupt(); labels(db, value); return value;
}
function activeWants(db: DatabaseSync, bookId: string): dto.WantEntry[] { return db.prepare("SELECT id FROM collection_wants WHERE json_extract(data,'$.bookId')=? AND json_extract(data,'$.active')=1 ORDER BY id").all(bookId).map(row => wantRow(db, String(row.id))); }
function target(entry: dto.WantEntry): dto.WantTargetSummary { return { id: entry.id, version: entry.version, priority: entry.priority, targetLengthMinutes: entry.targetLengthMinutes, preferredCondition: entry.preferredCondition, packagingTarget: entry.packagingTarget, priceTarget: entry.priceTarget }; }
function paginate<T>(items: readonly T[], page: dto.PageRequest): dto.Page<T> { const selected = items.slice(page.offset, page.offset + page.limit); return { ...page, items: selected, total: items.length, hasMore: page.offset + selected.length < items.length }; }
function counts(entries: readonly dto.CollectionProgressEntry[]): dto.CollectionProgressCounts {
  const value: dto.CollectionProgressCounts = { total: entries.length, owned: 0, missing: 0, unknown: 0, candidate: 0, needsReview: 0, wanted: 0, wantTargetCount: 0 };
  for (const entry of entries) { value[entry.state]++; if (entry.state === 'unknown' && entry.matches.some(match => match.status === 'candidate')) value.candidate++; if (entry.state === 'unknown' && entry.matches.some(match => match.status === 'needs-review')) value.needsReview++; if (entry.wantedTargets.length) value.wanted++; value.wantTargetCount += entry.wantedTargets.length; }
  return value;
}
function aggregate(entries: readonly dto.CollectionProgressEntry[]) {
  const brands = [...new Set(entries.map(entry => entry.brand))].sort().map(brand => ({ brand, counts: counts(entries.filter(entry => entry.brand === brand)) }));
  const groups = new Map<string, { brand: string; series: string }>(); for (const entry of entries) groups.set(canonical([entry.brand, entry.series]), { brand: entry.brand, series: entry.series });
  const series = [...groups.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, group]) => ({ ...group, counts: counts(entries.filter(entry => entry.brand === group.brand && entry.series === group.series)) }));
  return { overall: counts(entries), brands, series };
}
function modelLengths(db: DatabaseSync, modelId: string): dto.CollectionModelLengths {
  const model = db.prepare('SELECT revision FROM collection_models WHERE id=?').get(modelId); if (!model) return corrupt();
  // 剩余池和已物化实体分别加总；预留、不可用仍是在手实物，不按录音可用性扣除。
  const rows = db.prepare(`SELECT minutes,SUM(quantity) quantity FROM (
    SELECT s.minutes,l.sealed+l.opened+l.legacy+l.unknown quantity FROM inventory_lots l JOIN collection_skus s ON s.id=l.sku_id WHERE s.model_id=?
    UNION ALL SELECT s.minutes,1 quantity FROM physical_copies c JOIN inventory_lots l ON l.id=c.lot_id JOIN collection_skus s ON s.id=l.sku_id WHERE s.model_id=?
  ) GROUP BY minutes HAVING SUM(quantity)>0 ORDER BY minutes`).all(modelId, modelId);
  const value = { modelId, modelRevision: Number(model.revision), total: rows.reduce((n, row) => n + Number(row.quantity), 0), lengths: rows.filter(row => row.minutes !== 0).map(row => ({ lengthMinutes: Number(row.minutes), quantity: Number(row.quantity) })), unknownLengthQty: Number(rows.find(row => row.minutes === 0)?.quantity ?? 0) };
  if (!dto.isCollectionModelLengths(value)) return corrupt(); return value;
}
interface ProgressFacts { bookId: string; revisionId: string; catalogSequence: number; matchVersion: number; metricsVersion: 1; overall: dto.CollectionProgressCounts; brands: dto.CollectionProgress['brands']; series: dto.CollectionProgress['series']; historicalWantedCount: number; entries: dto.CollectionProgressEntry[]; wants: dto.WantEntry[] }
function currentFacts(db: DatabaseSync, catalog: dto.CatalogRevision): ProgressFacts {
  const matchRow = db.prepare('SELECT version,data FROM reference_catalog_matches WHERE revision_id=?').get(catalog.id); if (!matchRow) return corrupt();
  const matches = parse(matchRow.data, (value): value is dto.CatalogMatch[] => Array.isArray(value) && value.every(dto.isCatalogMatch));
  const wants = activeWants(db, catalog.bookId), models = new Map<string, dto.CollectionModelLengths>();
  const entries = catalog.items.map((reference): dto.CollectionProgressEntry => {
    const related = matches.filter(match => match.referenceId === reference.referenceId), quantities = new Map<number, number>();
    for (const match of related) if (match.modelId && match.status === 'confirmed') { let evidence = models.get(match.modelId); if (!evidence) { evidence = modelLengths(db, match.modelId); models.set(match.modelId, evidence); } for (const length of evidence.lengths) quantities.set(length.lengthMinutes, (quantities.get(length.lengthMinutes) ?? 0) + length.quantity); quantities.set(0, (quantities.get(0) ?? 0) + evidence.unknownLengthQty); }
    const lengths = [...quantities.entries()].filter(([length, quantity]) => length > 0 && quantity > 0).sort(([a], [b]) => a - b).map(([lengthMinutes, quantity]) => ({ lengthMinutes, quantity })), stockCount = [...quantities.values()].reduce((sum, value) => sum + value, 0);
    const state = stockCount > 0 ? 'owned' : related.some(match => match.status === 'unmatched' && match.availability === 'missing') ? 'missing' : 'unknown';
    return { referenceId: reference.referenceId, brand: reference.brand, series: reference.series, model: reference.model, edition: reference.edition, state, matches: related, stockCount, knownLengths: [...reference.lengths], ownedLengths: lengths.filter(length => reference.lengths.includes(length.lengthMinutes)), unknownLengthQty: quantities.get(0) ?? 0, extraLengths: lengths.filter(length => !reference.lengths.includes(length.lengthMinutes)), allKnownLengthsOwned: reference.lengths.length > 0 && reference.lengths.every(length => (quantities.get(length) ?? 0) > 0), wantedTargets: wants.filter(want => want.revisionId === catalog.id && want.referenceId === reference.referenceId).map(target) };
  });
  return { bookId: catalog.bookId, revisionId: catalog.id, catalogSequence: catalog.sequence, matchVersion: Number(matchRow.version), metricsVersion: 1, ...aggregate(entries), historicalWantedCount: wants.filter(want => want.revisionId !== catalog.id).length, entries, wants };
}
interface StoredSnapshot { snapshot: dto.CollectionProgressSnapshotSummary; entries: dto.CollectionProgressEntry[]; wantVersions: { id: string; version: number }[] }
function storedSnapshot(db: DatabaseSync, id: string): StoredSnapshot {
  const row = db.prepare('SELECT * FROM collection_progress_snapshots WHERE id=?').get(id); if (!row) return corrupt();
  const stored = parse(row.data, (value): value is StoredSnapshot => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const v = value as StoredSnapshot; return Object.keys(v).sort().join(',') === 'entries,snapshot,wantVersions' && dto.isCollectionProgressSnapshot({ ...v.snapshot, entries: v.entries }) && Array.isArray(v.entries) && Array.isArray(v.wantVersions) && v.wantVersions.every(want => want && dto.isCollectionId(want.id) && Number.isSafeInteger(want.version) && want.version > 0);
  });
  const summary = stored.snapshot, catalog = revision(db, summary.revisionId);
  if (summary.id !== row.id || summary.revisionId !== row.revision_id || summary.matchVersion !== row.match_version || summary.bookId !== catalog.bookId || summary.catalogSequence !== catalog.sequence || !same(aggregate(stored.entries), { overall: summary.overall, brands: summary.brands, series: summary.series }) || !same(stored.entries.map(entry => entry.referenceId), catalog.items.map(item => item.referenceId))) return corrupt();
  const wants = stored.wantVersions.map(want => wantRow(db, want.id, want.version));
  if (new Set(wants.map(want => want.id)).size !== wants.length || wants.some(want => !want.active || want.bookId !== catalog.bookId) || !same(wants.map(want => want.id), wants.map(want => want.id).sort()) || summary.historicalWantedCount !== wants.filter(want => want.revisionId !== catalog.id).length) return corrupt();
  for (const entry of stored.entries) {
    const reference = catalog.items.find(item => item.referenceId === entry.referenceId)!;
    if (!same([entry.brand, entry.series, entry.model, entry.edition, entry.knownLengths], [reference.brand, reference.series, reference.model, reference.edition, reference.lengths]) || !same(entry.wantedTargets, wants.filter(want => want.revisionId === catalog.id && want.referenceId === entry.referenceId).map(target))) return corrupt();
    for (const match of entry.matches) if (match.modelId && !db.prepare('SELECT id FROM collection_models WHERE id=?').get(match.modelId)) return corrupt();
  }
  const historicMatch = db.prepare('SELECT data FROM reference_catalog_snapshots WHERE revision_id=? AND match_version=?').get(catalog.id, summary.matchVersion);
  if (!historicMatch || !same(parse(historicMatch.data, dto.isCatalogSnapshot).entries.flatMap(entry => entry.matches), stored.entries.flatMap(entry => entry.matches))) return corrupt();
  const { id: ignoredId, createdAt: ignoredAt, fingerprint: expected, ...body } = summary;
  if (fingerprint({ ...body, entries: stored.entries, wants }) !== expected) return corrupt();
  return stored;
}

export interface CollectionProgressStore {
  wants(request: dto.ListWantEntriesRequest): dto.Page<dto.WantEntryView>;
  saveWant(request: dto.SaveWantEntryRequest): dto.WantEntry;
  cancelWant(request: dto.CancelWantEntryRequest): dto.WantEntry;
  wantHistory(request: dto.GetWantEntryHistoryRequest): dto.Page<dto.WantEntry>;
  current(request: dto.GetCollectionProgressRequest): dto.CollectionProgress;
  capture(request: dto.CaptureCollectionProgressRequest): dto.CollectionProgressSnapshotSummary;
  snapshots(request: dto.ListCollectionProgressSnapshotsRequest): dto.Page<dto.CollectionProgressSnapshotSummary>;
  snapshot(request: dto.GetCollectionProgressSnapshotRequest): dto.CollectionProgressSnapshotDetail;
  modelLengths(request: dto.GetCollectionModelLengthsRequest): dto.CollectionModelLengths;
}
export function createCollectionProgressStore(options: { read<T>(operation: (db: DatabaseSync) => T): T; conflict(message: string): never; beforeCommit?: (action: string) => void }): CollectionProgressStore {
  const valid = (condition: boolean): void => { if (!condition) options.conflict('收藏进度请求无效，请检查输入。'); };
  function read<T>(operation: (db: DatabaseSync) => T): T { return options.read(db => { try { budget(db); return operation(db); } catch (error) { if (error instanceof ProgressCapacityError) return options.conflict(error.message); throw error; } }); }
  function transaction<T>(kind: 'save' | 'cancel' | 'capture', request: { commandId: string }, guard: (v: unknown) => v is T, operation: (db: DatabaseSync) => T): T {
    return read(db => { db.exec('BEGIN IMMEDIATE'); try {
      const fp = fingerprint([kind, request]), prior = db.prepare('SELECT * FROM collection_progress_ledger WHERE command_id=?').get(request.commandId);
      if (prior) { if (prior.kind !== kind || prior.fingerprint !== fp) return options.conflict('同一操作编号不能用于不同收藏进度内容。'); const result = parse(prior.result, guard); db.exec('COMMIT'); return result; }
      const result = operation(db); if (!guard(result)) return corrupt();
      db.prepare('INSERT INTO collection_progress_ledger VALUES(?,?,?,?,?,?)').run(request.commandId, fp, kind, JSON.stringify(request), JSON.stringify(result), new Date().toISOString());
      budget(db); options.beforeCommit?.('collection-progress-' + kind); db.exec('COMMIT'); return result;
    } catch (error) { db.exec('ROLLBACK'); throw error; } });
  }
  function persistWant(db: DatabaseSync, entry: dto.WantEntry, commandId: string): dto.WantEntry {
    if (!dto.isWantEntry(entry)) return corrupt();
    db.prepare('INSERT INTO collection_wants VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,revision_id=excluded.revision_id,data=excluded.data').run(entry.id, entry.version, entry.revisionId, JSON.stringify(entry));
    db.prepare('INSERT INTO collection_want_events VALUES(?,?,?,?,?)').run(entry.id, entry.version, entry.revisionId, commandId, JSON.stringify(entry)); return entry;
  }
  return {
    saveWant(request) {
      valid(dto.isSaveWantEntryRequest(request));
      return transaction('save', request, dto.isWantEntry, db => {
        const catalog = revision(db, request.revisionId); if (currentHead(db, catalog.bookId) !== catalog.id) return options.conflict('求购目标只能保存到当前目录版本，请刷新后确认。');
        const reference = catalog.items.find(item => item.referenceId === request.referenceId); if (!reference) return options.conflict('参考型号不存在，请刷新目录。');
        const previous = request.id === null ? null : wantRow(db, request.id);
        if (previous && !previous.active) return options.conflict('已取消目标不可恢复，请创建新目标。');
        if ((previous?.version ?? 0) !== request.expectedVersion) return options.conflict('求购目标版本已改变，请刷新。');
        const now = new Date().toISOString();
        return persistWant(db, { id: previous?.id ?? randomUUID(), version: (previous?.version ?? 0) + 1, active: true, bookId: catalog.bookId, revisionId: catalog.id, referenceId: reference.referenceId, brand: reference.brand, series: reference.series, model: reference.model, edition: reference.edition, priority: request.priority, preferredCondition: request.preferredCondition, notes: request.notes, targetLengthMinutes: request.targetLengthMinutes, packagingTarget: request.packagingTarget, priceTarget: request.priceTarget, createdAt: previous?.createdAt ?? now, updatedAt: now }, request.commandId);
      });
    },
    cancelWant(request) {
      valid(dto.isCancelWantEntryRequest(request));
      return transaction('cancel', request, dto.isWantEntry, db => { const previous = wantRow(db, request.id); if (!previous.active) return options.conflict('求购目标已经取消。'); if (previous.version !== request.expectedVersion) return options.conflict('求购目标版本已改变，请刷新。'); return persistWant(db, { ...previous, version: previous.version + 1, active: false, updatedAt: new Date().toISOString() }, request.commandId); });
    },
    wants(request) {
      valid(dto.isListWantEntriesRequest(request));
      return read(db => {
        const clauses: string[] = [], params: SQLInputValue[] = [];
        for (const key of ['bookId', 'revisionId', 'referenceId', 'active'] as const) if (request[key] !== undefined) { clauses.push(`json_extract(data,'$.${key}')=?`); params.push(typeof request[key] === 'boolean' ? Number(request[key]) : request[key]!); }
        const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '', total = Number(db.prepare('SELECT count(*) n FROM collection_wants' + where).get(...params)?.n);
        const items = db.prepare('SELECT id FROM collection_wants' + where + ' ORDER BY rowid LIMIT ? OFFSET ?').all(...params, request.page.limit, request.page.offset).map(row => { const entry = wantRow(db, String(row.id)); return { entry, needsReview: currentHead(db, entry.bookId) !== entry.revisionId }; });
        return { ...request.page, items, total, hasMore: request.page.offset + items.length < total };
      });
    },
    wantHistory(request) { valid(dto.isGetWantEntryHistoryRequest(request)); return read(db => { wantRow(db, request.id); const total = Number(db.prepare('SELECT count(*) n FROM collection_want_events WHERE id=?').get(request.id)?.n), items = db.prepare('SELECT version FROM collection_want_events WHERE id=? ORDER BY version LIMIT ? OFFSET ?').all(request.id, request.page.limit, request.page.offset).map(row => wantRow(db, request.id, Number(row.version))); return { ...request.page, total, items, hasMore: request.page.offset + items.length < total }; }); },
    current(request) { valid(dto.isGetCollectionProgressRequest(request)); return read(db => { const facts = currentFacts(db, revision(db, request.revisionId)), { wants: ignored, entries, ...summary } = facts; return { ...summary, facts: 'current', isCurrentRevision: currentHead(db, facts.bookId) === facts.revisionId, fingerprint: fingerprint(facts), entries: paginate(entries, request.page) }; }); },
    modelLengths(request) { valid(dto.isGetCollectionModelLengthsRequest(request)); return read(db => modelLengths(db, request.modelId)); },
    capture(request) {
      valid(dto.isCaptureCollectionProgressRequest(request));
      return transaction('capture', request, dto.isCollectionProgressSnapshotSummary, db => {
        const catalog = revision(db, request.revisionId); if (currentHead(db, catalog.bookId) !== catalog.id) return options.conflict('只能为当前目录版本捕获进度，请刷新。');
        const facts = currentFacts(db, catalog), fp = fingerprint(facts); if (fp !== request.expectedFingerprint) return options.conflict('进度指纹已改变，请刷新后再次确认。');
        const { entries, wants, ...summary } = facts, snapshot: dto.CollectionProgressSnapshotSummary = { ...summary, id: randomUUID(), createdAt: new Date().toISOString(), fingerprint: fp };
        const stored: StoredSnapshot = { snapshot, entries, wantVersions: wants.map(want => ({ id: want.id, version: want.version })) };
        db.prepare('INSERT INTO collection_progress_snapshots VALUES(?,?,?,?,?)').run(snapshot.id, snapshot.revisionId, snapshot.matchVersion, request.commandId, JSON.stringify(stored)); return snapshot;
      });
    },
    snapshots(request) {
      valid(dto.isListCollectionProgressSnapshotsRequest(request));
      return read(db => {
        const clauses: string[] = [], params: SQLInputValue[] = [];
        if (request.revisionId) { clauses.push('revision_id=?'); params.push(request.revisionId); }
        if (request.bookId) { clauses.push("json_extract(data,'$.snapshot.bookId')=?"); params.push(request.bookId); }
        const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
        const total = Number(db.prepare('SELECT count(*) n FROM collection_progress_snapshots' + where).get(...params)?.n);
        const rows = db.prepare('SELECT id FROM collection_progress_snapshots' + where + ' ORDER BY rowid DESC LIMIT ? OFFSET ?').all(...params, request.page.limit, request.page.offset);
        const items: dto.CollectionProgressSnapshotSummary[] = [];
        let itemBytes = 0;
        // 每个完整摘要只计一次UTF-8字节；空数组信封保留数字、布尔值和标点的真实开销。
        const pageBytes = (count: number, bytes: number, limit: number) => Buffer.byteLength(JSON.stringify({ offset: request.page.offset, limit, total, items: [], hasMore: request.page.offset + count < total })) + bytes + Math.max(0, count - 1);
        for (const row of rows) {
          const snapshot = storedSnapshot(db, String(row.id)).snapshot;
          const bytes = Buffer.byteLength(JSON.stringify(snapshot)), count = items.length + 1;
          if (pageBytes(count, itemBytes + bytes, count) > dto.MAX_COLLECTION_PROGRESS_BYTES) {
            if (!items.length) throw new ProgressCapacityError();
            break;
          }
          items.push(snapshot); itemBytes += bytes;
        }
        const limit = items.length < rows.length || pageBytes(items.length, itemBytes, request.page.limit) > dto.MAX_COLLECTION_PROGRESS_BYTES ? items.length : request.page.limit;
        return { offset: request.page.offset, limit, total, items, hasMore: request.page.offset + items.length < total };
      });
    },
    snapshot(request) { valid(dto.isGetCollectionProgressSnapshotRequest(request)); return read(db => { const stored = storedSnapshot(db, request.id); return { snapshot: stored.snapshot, entries: paginate(stored.entries, request.page) }; }); },
  };
}

/** 仅检查schema17证据；备份调用方负责只读打开，不迁移或恢复当前事实。 */
export function verifyCollectionProgressDatabase(db: DatabaseSync): void {
  for (const [name, sql] of Object.entries(tables)) if (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name)?.sql !== sql) return corrupt();
  for (const sql of triggers) if (db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(sql.split(' ')[2]!)?.sql !== sql) return corrupt();
  budget(db);
  const events = new Map<string, dto.WantEntry>();
  let eventCount = 0, snapshotCount = 0;
  for (const row of db.prepare('SELECT * FROM collection_progress_ledger ORDER BY rowid').iterate()) {
    const kind = String(row.kind), guard = kind === 'save' ? dto.isSaveWantEntryRequest : kind === 'cancel' ? dto.isCancelWantEntryRequest : kind === 'capture' ? dto.isCaptureCollectionProgressRequest : null;
    if (!guard || !dto.isCollectionId(row.command_id) || typeof row.created_at !== 'string' || !Number.isFinite(Date.parse(row.created_at))) return corrupt();
    const request = parse(row.request, (value): value is dto.SaveWantEntryRequest | dto.CancelWantEntryRequest | dto.CaptureCollectionProgressRequest => guard(value));
    if (request.commandId !== row.command_id || fingerprint([kind, request]) !== row.fingerprint) return corrupt();
    if (kind === 'capture') {
      snapshotCount++;
      const result = parse(row.result, dto.isCollectionProgressSnapshotSummary), stored = storedSnapshot(db, result.id), command = request as dto.CaptureCollectionProgressRequest;
      if (!same(stored.snapshot, result) || result.revisionId !== command.revisionId || result.fingerprint !== command.expectedFingerprint || db.prepare('SELECT command_id FROM collection_progress_snapshots WHERE id=?').get(result.id)?.command_id !== row.command_id) return corrupt();
      const active = [...events.values()].filter(entry => entry.active && entry.bookId === result.bookId).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(entry => ({ id: entry.id, version: entry.version }));
      if (!same(active, stored.wantVersions)) return corrupt();
    } else {
      eventCount++;
      const result = parse(row.result, dto.isWantEntry), previous = events.get(result.id), command = request as dto.SaveWantEntryRequest | dto.CancelWantEntryRequest;
      if (!same(result, wantRow(db, result.id, result.version)) || db.prepare('SELECT command_id FROM collection_want_events WHERE id=? AND version=?').get(result.id, result.version)?.command_id !== row.command_id || result.version !== (previous?.version ?? 0) + 1 || previous && (!previous.active || previous.createdAt !== result.createdAt || Date.parse(previous.updatedAt) > Date.parse(result.updatedAt))) return corrupt();
      if (kind === 'save') { const save = command as dto.SaveWantEntryRequest; if (save.id !== (previous?.id ?? null) || save.expectedVersion !== (previous?.version ?? 0) || !result.active || !same([result.revisionId, result.referenceId, result.priority, result.preferredCondition, result.notes, result.targetLengthMinutes, result.packagingTarget, result.priceTarget], [save.revisionId, save.referenceId, save.priority, save.preferredCondition, save.notes, save.targetLengthMinutes, save.packagingTarget, save.priceTarget])) return corrupt(); }
      else if (!previous || command.id !== previous.id || command.expectedVersion !== previous.version || !same(result, { ...previous, version: previous.version + 1, active: false, updatedAt: result.updatedAt })) return corrupt();
      events.set(result.id, result);
    }
  }
  if (Number(db.prepare('SELECT count(*) n FROM collection_wants').get()?.n) !== events.size || Number(db.prepare('SELECT count(*) n FROM collection_want_events').get()?.n) !== eventCount || Number(db.prepare('SELECT count(*) n FROM collection_progress_snapshots').get()?.n) !== snapshotCount) return corrupt();
  for (const [id, latest] of events) if (!same(wantRow(db, id), latest)) return corrupt();
  if (db.prepare('PRAGMA foreign_key_check').get()) return corrupt();
}
