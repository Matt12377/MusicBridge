import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import * as dto from '@music-bridge/contracts';
import { matchSpreadsheetRows, normalizeSpreadsheetRow, spreadsheetCanonical, spreadsheetFingerprint } from './spreadsheet-import-rows.js';

const tables = {
  spreadsheet_sources: 'CREATE TABLE spreadsheet_sources(id TEXT PRIMARY KEY,workbook_hash TEXT NOT NULL UNIQUE,bytes BLOB NOT NULL,data TEXT NOT NULL) STRICT',
  spreadsheet_source_rows: 'CREATE TABLE spreadsheet_source_rows(source_id TEXT NOT NULL REFERENCES spreadsheet_sources(id),sheet_name TEXT NOT NULL,row_index INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(source_id,sheet_name,row_index)) STRICT',
  spreadsheet_revisions: 'CREATE TABLE spreadsheet_revisions(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES spreadsheet_sources(id),sheet_name TEXT NOT NULL,previous_id TEXT REFERENCES spreadsheet_revisions(id),lineage_id TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(source_id,sheet_name)) STRICT',
  spreadsheet_heads: 'CREATE TABLE spreadsheet_heads(lineage_id TEXT PRIMARY KEY,current_id TEXT NOT NULL REFERENCES spreadsheet_revisions(id)) STRICT',
  spreadsheet_rows: 'CREATE TABLE spreadsheet_rows(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES spreadsheet_revisions(id),row_index INTEGER NOT NULL,effect_id TEXT REFERENCES spreadsheet_effects(id),data TEXT NOT NULL,UNIQUE(revision_id,row_index)) STRICT',
  spreadsheet_effects: 'CREATE TABLE spreadsheet_effects(id TEXT PRIMARY KEY,lot_id TEXT NOT NULL UNIQUE REFERENCES inventory_lots(id),model_id TEXT NOT NULL REFERENCES collection_models(id),command_id TEXT NOT NULL UNIQUE REFERENCES inventory_ledger(command_id),quantity INTEGER NOT NULL,legacy INTEGER NOT NULL,unknown INTEGER NOT NULL) STRICT',
  spreadsheet_adjustments: 'CREATE TABLE spreadsheet_adjustments(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES spreadsheet_revisions(id),row_id TEXT NOT NULL REFERENCES spreadsheet_rows(id),effect_id TEXT NOT NULL REFERENCES spreadsheet_effects(id),legacy_delta INTEGER NOT NULL,unknown_delta INTEGER NOT NULL,data TEXT NOT NULL) STRICT',
  spreadsheet_ledger: 'CREATE TABLE spreadsheet_ledger(command_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,kind TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL) STRICT',
} as const;
const immutable = Object.keys(tables).filter(table => table !== 'spreadsheet_heads');
const triggers = immutable.flatMap(table => ['UPDATE', 'DELETE'].map(action => `CREATE TRIGGER ${table}_no_${action.toLowerCase()} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'immutable spreadsheet import'); END`));
export const spreadsheetImportMigration = `
CREATE TABLE inventory_lots_v16 (
 id TEXT PRIMARY KEY,sku_id TEXT NOT NULL REFERENCES collection_skus(id),
 acquired INTEGER NOT NULL CHECK(acquired BETWEEN 1 AND 10000),
 sealed INTEGER NOT NULL CHECK(sealed>=0),opened INTEGER NOT NULL CHECK(opened>=0),
 legacy INTEGER NOT NULL CHECK(legacy>=0),unknown INTEGER NOT NULL CHECK(unknown>=0),
 quantity_adjustment INTEGER NOT NULL DEFAULT 0 CHECK(quantity_adjustment BETWEEN -1000000 AND 1000000),
 CHECK(acquired+quantity_adjustment BETWEEN 0 AND 1000000),
 CHECK(sealed+opened+legacy+unknown<=acquired+quantity_adjustment)
) STRICT;
INSERT INTO inventory_lots_v16(id,sku_id,acquired,sealed,opened,legacy,unknown) SELECT id,sku_id,acquired,sealed,opened,legacy,unknown FROM inventory_lots;
DROP TABLE inventory_lots;
ALTER TABLE inventory_lots_v16 RENAME TO inventory_lots;
CREATE INDEX inventory_lots_sku ON inventory_lots(sku_id);
CREATE TRIGGER spreadsheet_acquired_immutable BEFORE UPDATE OF acquired ON inventory_lots WHEN NEW.acquired<>OLD.acquired BEGIN SELECT RAISE(ABORT,'immutable acquired quantity'); END;
${[...Object.values(tables), ...triggers, 'CREATE INDEX spreadsheet_rows_revision ON spreadsheet_rows(revision_id)', 'CREATE INDEX spreadsheet_rows_effect ON spreadsheet_rows(effect_id)', 'CREATE INDEX spreadsheet_revisions_lineage ON spreadsheet_revisions(lineage_id)', 'CREATE INDEX spreadsheet_adjustments_effect ON spreadsheet_adjustments(effect_id)', 'PRAGMA user_version=16'].join(';\n')};
`;
export const SPREADSHEET_STORAGE_LIMITS = { totalBytes: 256 * 1024 * 1024, rowBytes: 8 * 1024 * 1024, sources: 1000, rows: 1_000_000, historyRecords: 100_000 } as const;
class SpreadsheetCapacityError extends Error { constructor() { super('导入资料容量达到上限，已有历史不会删除。'); } }
const corrupt = (): never => { throw new Error('导入资料缺失或损坏。'); };
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const same = (a: unknown, b: unknown): boolean => spreadsheetCanonical(a) === spreadsheetCanonical(b);
function json<T>(value: unknown, guard: (value: unknown) => value is T): T {
  if (typeof value !== 'string' || Buffer.byteLength(value) > SPREADSHEET_STORAGE_LIMITS.rowBytes) return corrupt();
  const parsed: unknown = JSON.parse(value); return guard(parsed) ? parsed : corrupt();
}
function budget(db: DatabaseSync): void {
  let bytes = 0, rows = 0, historyRecords = 0;
  for (const table of Object.keys(tables)) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().filter(c => c.type === 'TEXT' || c.type === 'BLOB').map(c => `COALESCE(length(CAST(${c.name} AS BLOB)),0)`);
    const amount = db.prepare(`SELECT count(*) n,COALESCE(sum(${columns.join('+')}),0) bytes,COALESCE(max(${columns.join('+')}),0) largest FROM ${table}`).get()!;
    bytes += Number(amount.bytes); rows += Number(amount.n);
    if (['spreadsheet_revisions', 'spreadsheet_effects', 'spreadsheet_adjustments'].includes(table)) historyRecords += Number(amount.n);
    if (bytes > SPREADSHEET_STORAGE_LIMITS.totalBytes || rows > SPREADSHEET_STORAGE_LIMITS.rows || Number(amount.largest) > SPREADSHEET_STORAGE_LIMITS.rowBytes + 65536
      || table === 'spreadsheet_sources' && Number(amount.n) > SPREADSHEET_STORAGE_LIMITS.sources || historyRecords > SPREADSHEET_STORAGE_LIMITS.historyRecords) throw new SpreadsheetCapacityError();
  }
}
function sourceData(db: DatabaseSync, id: string): dto.SpreadsheetWorkbookSource {
  const row = db.prepare('SELECT id,workbook_hash,data FROM spreadsheet_sources WHERE id=?').get(id); if (!row) return corrupt();
  const data = json(row.data, dto.isSpreadsheetWorkbookSource); if (data.id !== row.id || data.workbookHash !== row.workbook_hash) return corrupt(); return data;
}
function revisionData(db: DatabaseSync, id: string): dto.SpreadsheetImportRevision {
  const row = db.prepare('SELECT * FROM spreadsheet_revisions WHERE id=?').get(id); if (!row) return corrupt();
  const data = json(row.data, dto.isSpreadsheetImportRevision);
  if (data.id !== row.id || data.sourceId !== row.source_id || data.sheetName !== row.sheet_name || data.previousRevisionId !== row.previous_id) return corrupt(); return data;
}
function importedRows(db: DatabaseSync, id: string): dto.SpreadsheetImportedRow[] {
  return db.prepare('SELECT id,row_index,data FROM spreadsheet_rows WHERE revision_id=? ORDER BY row_index').all(id).map(row => {
    const data = json(row.data, dto.isSpreadsheetImportedRow); if (data.id !== row.id || data.rowIndex !== row.row_index) return corrupt(); return data;
  });
}
function page<T>(items: readonly T[], request: dto.SpreadsheetPageRequest): dto.Page<T> {
  return { items: items.slice(request.offset, request.offset + request.limit), total: items.length, ...request, hasMore: request.offset + Math.min(request.limit, Math.max(0, items.length - request.offset)) < items.length };
}
function databasePage<T>(db: DatabaseSync, table: string, where: string, values: SQLInputValue[], request: dto.SpreadsheetPageRequest, guard: (v: unknown) => v is T): dto.Page<T> {
  const total = Number(db.prepare(`SELECT count(*) n FROM ${table} ${where}`).get(...values)?.n);
  const items = db.prepare(`SELECT data FROM ${table} ${where} ORDER BY rowid LIMIT ? OFFSET ?`).all(...values, request.limit, request.offset).map(row => json(row.data, guard));
  return { items, total, ...request, hasMore: request.offset + items.length < total };
}
export interface RegisterSpreadsheetSourceInput { commandId: string; bytes: Uint8Array; displayName: string; workbook: dto.ParsedSpreadsheetWorkbook }
export interface SpreadsheetImportStore {
  registerSource(request: RegisterSpreadsheetSourceInput): dto.SpreadsheetWorkbookSource;
  sourceReceipt(request: dto.ChooseSpreadsheetWorkbookRequest): dto.SpreadsheetWorkbookReceipt;
  sources(request: dto.SpreadsheetPageRequest): dto.SpreadsheetSourcePage;
  source(request: dto.SpreadsheetIdRequest): dto.SpreadsheetWorkbookSource;
  sourceRows(request: dto.SpreadsheetSourceRowsRequest): dto.SpreadsheetSourceRowsPage;
  preview(request: dto.PreviewSpreadsheetImportRequest): dto.SpreadsheetImportPreview;
  apply(request: dto.ApplySpreadsheetImportRequest): dto.SpreadsheetImportResult;
  revision(request: dto.SpreadsheetImportRevisionRequest): dto.SpreadsheetImportRevisionDetail;
  history(request: dto.SpreadsheetPageRequest): dto.SpreadsheetImportHistory;
  adjustmentPreview(request: dto.SpreadsheetAdjustmentPreviewRequest): dto.SpreadsheetAdjustmentBalance;
  adjust(request: dto.AdjustSpreadsheetInventoryRequest): dto.SpreadsheetInventoryAdjustment;
  adjustments(request: dto.SpreadsheetAdjustmentsRequest): dto.SpreadsheetAdjustmentsPage;
}
export function createSpreadsheetImportStore(options: {
  read<T>(operation: (db: DatabaseSync) => T): T;
  conflict(message: string): never;
  receive(db: DatabaseSync, request: dto.CollectionReceiveRequest, privateIdentity: string): { result: dto.CollectionMutationResult; evidence: unknown };
  beforeCommit?: (action: string) => void;
}): SpreadsheetImportStore {
  const valid = (condition: boolean): void => { if (!condition) options.conflict('导入请求无效，请检查输入。'); };
  function transaction<T>(kind: string, commandId: string, fingerprint: string, guard: (v: unknown) => v is T, operation: (db: DatabaseSync) => T): T {
    return options.read(db => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const prior = db.prepare('SELECT * FROM spreadsheet_ledger WHERE command_id=?').get(commandId);
        let result: T;
        if (prior) {
          if (prior.kind !== kind || prior.fingerprint !== fingerprint) return options.conflict('同一操作编号不能用于不同导入内容。');
          result = json(prior.result, guard);
        } else {
          result = operation(db); if (!guard(result)) return corrupt();
          db.prepare('INSERT INTO spreadsheet_ledger VALUES (?,?,?,?,?)').run(commandId, fingerprint, kind, JSON.stringify(result), new Date().toISOString());
          budget(db); options.beforeCommit?.(kind);
        }
        db.exec('COMMIT'); return result;
      } catch (error) { db.exec('ROLLBACK'); if (error instanceof SpreadsheetCapacityError) return options.conflict(error.message); throw error; }
    });
  }
  function previewData(db: DatabaseSync, plan: dto.SpreadsheetImportPlan) {
    const source = sourceData(db, plan.sourceId);
    if (!source.sheets.some(sheet => sheet.name === plan.sheetName)) return options.conflict('来源工作表不存在。');
    let previous: dto.SpreadsheetImportedRow[] = [], lineageId: string | null = null, sequence = 1;
    if (plan.previousRevisionId !== null) {
      const prior = revisionData(db, plan.previousRevisionId);
      const relation = db.prepare('SELECT lineage_id FROM spreadsheet_revisions WHERE id=?').get(prior.id)!;
      lineageId = String(relation.lineage_id);
      if (db.prepare('SELECT current_id FROM spreadsheet_heads WHERE lineage_id=?').get(lineageId)?.current_id !== prior.id) return options.conflict('导入版本基线已改变，请重新预览。');
      if (prior.format !== plan.format || prior.sheetName !== plan.sheetName) return options.conflict('后续导入必须对应相同介质和工作表。');
      previous = importedRows(db, prior.id); sequence = prior.sequence + 1;
    }
    const rows = db.prepare('SELECT data FROM spreadsheet_source_rows WHERE source_id=? AND sheet_name=? AND row_index>? ORDER BY row_index').all(source.id, plan.sheetName, plan.headerRow).map(row => json(row.data, dto.isSpreadsheetSourceRow)).filter(row => row.cells.some(cell => cell.type !== 'blank' || cell.formula !== undefined));
    const rowIndices = new Set(rows.map(row => row.rowIndex));
    if (plan.decisions.some(decision => !rowIndices.has(decision.rowIndex))) return options.conflict('人工决策引用了不存在的数据行。');
    const entries = matchSpreadsheetRows(rows, plan, previous, source.dateSystem);
    if (plan.catalogRevisionId) {
      const catalog = db.prepare('SELECT data FROM reference_catalog_revisions WHERE id=?').get(plan.catalogRevisionId);
      if (!catalog) return options.conflict('参考目录版本不存在。');
      const revision = json(catalog.data, dto.isCatalogRevision);
      for (const row of entries) if (row.normalized.descriptor.brand && row.normalized.descriptor.name) {
        const normalize = (text: string) => text.normalize('NFKC').trim().toLowerCase();
        row.candidates = revision.items.filter(item => normalize(item.brand) === normalize(row.normalized.descriptor.brand) && normalize(item.model) === normalize(row.normalized.descriptor.name)).map(item => ({ revisionId: revision.id, referenceId: item.referenceId }));
      }
    }
    const matched = new Set(entries.map(row => row.previousRowId));
    const removed = previous.filter(row => !matched.has(row.id)).map(row => ({ previousRowId: row.id, rowIndex: row.rowIndex, lotId: row.lotId, modelId: row.modelId }));
    const summary: dto.SpreadsheetImportSummary = { totalRows: entries.length, newRows: 0, matchedRows: 0, changedRows: 0, ambiguousRows: 0, skippedRows: 0, invalidRows: 0, removedRows: removed.length, newQuantity: 0, legacyUsed: 0, unclassified: 0 };
    const keys = { new: 'newRows', matched: 'matchedRows', changed: 'changedRows', ambiguous: 'ambiguousRows', skipped: 'skippedRows', invalid: 'invalidRows' } as const;
    for (const row of entries) {
      summary[keys[row.match]]++;
      if (row.match === 'new' && row.ready) { const quantity = row.normalized.quantity!, used = row.normalized.used ?? 0; summary.newQuantity += quantity; summary.legacyUsed += used; summary.unclassified += quantity - used; }
    }
    const baselineFingerprint = spreadsheetFingerprint({ plan, workbookHash: source.workbookHash, previous, entries, summary });
    return { entries, removed, summary, baselineFingerprint, previous, lineageId, sequence };
  }
  function balance(db: DatabaseSync, request: dto.SpreadsheetAdjustmentPreviewRequest): dto.SpreadsheetAdjustmentBalance {
    const row = db.prepare('SELECT * FROM spreadsheet_rows WHERE id=? AND revision_id=?').get(request.rowId, request.revisionId);
    if (!row?.effect_id) return options.conflict('该导入行没有可更正的实际库存批次。');
    const lot = db.prepare('SELECT l.*,e.model_id FROM spreadsheet_effects e JOIN inventory_lots l ON l.id=e.lot_id WHERE e.id=?').get(row.effect_id);
    if (!lot || lot.sealed !== 0 || lot.opened !== 0) return corrupt();
    const copies = db.prepare('SELECT physical_id,revision,usage,available,packaging FROM physical_copies WHERE lot_id=? ORDER BY physical_id').all(lot.id!);
    const fields = { ...request, lotId: String(lot.id), modelId: String(lot.model_id), legacyUsed: Number(lot.legacy), unclassified: Number(lot.unknown), quantityAcquired: Number(lot.acquired), quantityAdjustment: Number(lot.quantity_adjustment), materializedCount: copies.length };
    const value = { ...fields, balanceFingerprint: spreadsheetFingerprint({ ...fields, copies }) };
    if (!dto.isSpreadsheetAdjustmentBalance(value)) return corrupt(); return value;
  }
  return {
    registerSource(request) {
      valid(dto.isCollectionId(request.commandId) && request.bytes instanceof Uint8Array && request.bytes.byteLength > 0 && request.bytes.byteLength <= dto.MAX_SPREADSHEET_BYTES && typeof request.displayName === 'string' && dto.isParsedSpreadsheetWorkbook(request.workbook));
      const bytes = Buffer.from(request.bytes), workbook = structuredClone(request.workbook), workbookHash = sha(bytes);
      const source: dto.SpreadsheetWorkbookSource = { id: randomUUID(), displayName: request.displayName, workbookHash, fileFormat: workbook.fileFormat, parserVersion: workbook.parserVersion, dateSystem: workbook.dateSystem, byteLength: bytes.length, createdAt: new Date().toISOString(), sheets: workbook.sheets.map(sheet => ({ name: sheet.name, rowCount: sheet.rows.length, nonEmptyCellCount: sheet.rows.reduce((sum, row) => sum + row.cells.filter(cell => cell.type !== 'blank' || cell.formula !== undefined).length, 0) })) };
      valid(dto.isSpreadsheetWorkbookSource(source));
      return transaction('register-spreadsheet-source', request.commandId, spreadsheetFingerprint({ workbookHash, displayName: request.displayName, workbook }), dto.isSpreadsheetWorkbookSource, db => {
        const prior = db.prepare('SELECT id FROM spreadsheet_sources WHERE workbook_hash=?').get(workbookHash);
        if (prior) {
          const existing = sourceData(db, String(prior.id));
          const oldRows = db.prepare('SELECT data FROM spreadsheet_source_rows WHERE source_id=? ORDER BY sheet_name,row_index').all(existing.id).map(row => json(row.data, dto.isSpreadsheetSourceRow));
          const expected = workbook.sheets.flatMap(sheet => sheet.rows.map(row => ({ sourceId: existing.id, sheetName: sheet.name, rowIndex: row.rowIndex, rawRowHash: spreadsheetFingerprint(row.cells), cells: row.cells }))).sort((a, b) => a.sheetName < b.sheetName ? -1 : a.sheetName > b.sheetName ? 1 : a.rowIndex - b.rowIndex);
          if (existing.fileFormat !== workbook.fileFormat || existing.parserVersion !== workbook.parserVersion || existing.dateSystem !== workbook.dateSystem || !same(oldRows, expected)) return options.conflict('相同原文件不能登记不同解析内容。');
          return existing;
        }
        db.prepare('INSERT INTO spreadsheet_sources VALUES (?,?,?,?)').run(source.id, workbookHash, bytes, JSON.stringify(source));
        const insert = db.prepare('INSERT INTO spreadsheet_source_rows VALUES (?,?,?,?)');
        for (const sheet of workbook.sheets) for (const row of sheet.rows) {
          const data: dto.SpreadsheetSourceRow = { sourceId: source.id, sheetName: sheet.name, rowIndex: row.rowIndex, rawRowHash: spreadsheetFingerprint(row.cells), cells: row.cells };
          insert.run(source.id, sheet.name, row.rowIndex, JSON.stringify(data));
        }
        return source;
      });
    },
    sourceReceipt(request) { valid(dto.isChooseSpreadsheetWorkbookRequest(request)); return options.read(db => { const prior = db.prepare("SELECT result FROM spreadsheet_ledger WHERE command_id=? AND kind='register-spreadsheet-source'").get(request.commandId); return { source: prior ? json(prior.result, dto.isSpreadsheetWorkbookSource) : null }; }); },
    sources(request) { valid(dto.isSpreadsheetPageRequest(request)); return options.read(db => databasePage(db, 'spreadsheet_sources', '', [], request, dto.isSpreadsheetWorkbookSource)); },
    source(request) { valid(dto.isSpreadsheetIdRequest(request)); return options.read(db => sourceData(db, request.id)); },
    sourceRows(request) { valid(dto.isSpreadsheetSourceRowsRequest(request)); return options.read(db => { const source = sourceData(db, request.sourceId); if (!source.sheets.some(sheet => sheet.name === request.sheetName)) return options.conflict('工作表不存在。'); return databasePage(db, 'spreadsheet_source_rows', 'WHERE source_id=? AND sheet_name=?', [request.sourceId, request.sheetName], request.page, dto.isSpreadsheetSourceRow); }); },
    preview(request) {
      valid(dto.isPreviewSpreadsheetImportRequest(request)); const { page: pagination, ...plan } = request;
      return options.read(db => { const result = previewData(db, plan); return { sourceId: plan.sourceId, sheetName: plan.sheetName, previousRevisionId: plan.previousRevisionId, baselineFingerprint: result.baselineFingerprint, summary: result.summary, rows: page(result.entries, pagination), removedRows: page(result.removed, pagination) }; });
    },
    apply(request) {
      valid(dto.isApplySpreadsheetImportRequest(request));
      return transaction('apply-spreadsheet-import', request.commandId, spreadsheetFingerprint(request), dto.isSpreadsheetImportResult, db => {
        const prior = db.prepare('SELECT id FROM spreadsheet_revisions WHERE source_id=? AND sheet_name=?').get(request.sourceId, request.sheetName);
        if (prior) return { revision: revisionData(db, String(prior.id)), duplicate: true };
        const { commandId: _commandId, baselineFingerprint, userConfirmed: _confirmed, ...plan } = request;
        const preview = previewData(db, plan);
        if (preview.baselineFingerprint !== baselineFingerprint) return options.conflict('预览基线已改变，请重新确认。');
        if (preview.entries.some(row => row.match !== 'skipped' && (row.match === 'ambiguous' || row.match === 'new' && !row.ready || row.issues.some(issue => issue.code === 'FORMULA_REVIEW_REQUIRED')))) return options.conflict('仍有歧义对应或新增行、公式数量未确认。');
        const source = sourceData(db, plan.sourceId), id = randomUUID(), createdAt = new Date().toISOString();
        const revision: dto.SpreadsheetImportRevision = { id, sourceId: source.id, workbookHash: source.workbookHash, sheetName: plan.sheetName, format: plan.format, headerRow: plan.headerRow, columns: plan.columns, previousRevisionId: plan.previousRevisionId, ...(plan.catalogRevisionId ? { catalogRevisionId: plan.catalogRevisionId } : {}), sequence: preview.sequence, createdAt, summary: preview.summary };
        const lineageId = preview.lineageId ?? id;
        db.prepare('INSERT INTO spreadsheet_revisions VALUES (?,?,?,?,?,?)').run(id, source.id, plan.sheetName, plan.previousRevisionId, lineageId, JSON.stringify(revision));
        const previous = new Map(preview.previous.map(row => [row.id, row]));
        for (const row of preview.entries) {
          const rowId = randomUUID(); let effectId: string | null = null, lotId: string | null = null, modelId: string | null = null;
          let action: dto.SpreadsheetImportedRow['action'] = row.match === 'skipped' ? 'skipped' : row.match === 'invalid' ? 'invalid' : row.match === 'changed' ? 'suggested' : 'linked';
          if (row.match === 'new' && row.ready) {
            const quantity = row.normalized.quantity!, legacy = row.normalized.used ?? 0, inventoryCommandId = randomUUID(); effectId = randomUUID();
            const receive: dto.CollectionReceiveRequest = { commandId: inventoryCommandId, model: row.normalized.descriptor, lengthMinutes: row.normalized.lengthMinutes, quantities: { sealedBlank: 0, openedBlank: 0, legacyUsed: legacy, unclassified: quantity - legacy } };
            const received = options.receive(db, receive, `spreadsheet:${source.id}:${plan.sheetName}:${row.rowIndex}`);
            lotId = received.result.lotId!; modelId = received.result.modelId;
            db.prepare('INSERT INTO inventory_ledger VALUES (?,?,?,?,?,?)').run(inventoryCommandId, spreadsheetFingerprint(receive), 'spreadsheet-receive', JSON.stringify(received.result), JSON.stringify({ ...received.evidence as object, sourceId: source.id, revisionId: id, rowId, effectId }), createdAt);
            db.prepare('INSERT INTO spreadsheet_effects VALUES (?,?,?,?,?,?,?)').run(effectId, lotId, modelId, inventoryCommandId, quantity, legacy, quantity - legacy); action = 'created';
          } else if (row.previousRowId && row.match !== 'skipped' && row.match !== 'invalid') {
            const old = previous.get(row.previousRowId)!; lotId = old.lotId; modelId = old.modelId;
            effectId = db.prepare('SELECT effect_id FROM spreadsheet_rows WHERE id=?').get(old.id)?.effect_id as string | null;
          }
          const data: dto.SpreadsheetImportedRow = { ...row, id: rowId, action, lotId, modelId };
          if (!dto.isSpreadsheetImportedRow(data)) return corrupt();
          db.prepare('INSERT INTO spreadsheet_rows VALUES (?,?,?,?,?)').run(rowId, id, row.rowIndex, effectId, JSON.stringify(data));
        }
        db.prepare('INSERT INTO spreadsheet_heads VALUES (?,?) ON CONFLICT(lineage_id) DO UPDATE SET current_id=excluded.current_id').run(lineageId, id);
        return { revision, duplicate: false };
      });
    },
    revision(request) { valid(dto.isSpreadsheetImportRevisionRequest(request)); return options.read(db => ({ revision: revisionData(db, request.revisionId), rows: databasePage(db, 'spreadsheet_rows', 'WHERE revision_id=?', [request.revisionId], request.page, dto.isSpreadsheetImportedRow) })); },
    history(request) { valid(dto.isSpreadsheetPageRequest(request)); return options.read(db => databasePage(db, 'spreadsheet_revisions', '', [], request, dto.isSpreadsheetImportRevision)); },
    adjustmentPreview(request) { valid(dto.isSpreadsheetAdjustmentPreviewRequest(request)); return options.read(db => balance(db, request)); },
    adjust(request) {
      valid(dto.isAdjustSpreadsheetInventoryRequest(request));
      return transaction('adjust-spreadsheet-import', request.commandId, spreadsheetFingerprint(request), dto.isSpreadsheetInventoryAdjustment, db => {
        const location = { revisionId: request.revisionId, rowId: request.rowId }, before = balance(db, location);
        if (before.lotId !== request.lotId || before.balanceFingerprint !== request.expectedBalanceFingerprint) return options.conflict('库存余额已改变，请重新预览数量更正。');
        const legacy = before.legacyUsed + request.legacyUsedDelta, unknown = before.unclassified + request.unclassifiedDelta;
        if (legacy < 0 || unknown < 0 || legacy + unknown + before.materializedCount > 1_000_000) return options.conflict('更正后的数量余额不能为负或超出上限。');
        db.prepare('UPDATE inventory_lots SET legacy=?,unknown=?,quantity_adjustment=quantity_adjustment+? WHERE id=?').run(legacy, unknown, request.legacyUsedDelta + request.unclassifiedDelta, before.lotId);
        const after = balance(db, location), id = randomUUID();
        const result: dto.SpreadsheetInventoryAdjustment = { id, ...location, lotId: before.lotId, before, after, createdAt: new Date().toISOString() };
        const effect = db.prepare('SELECT effect_id FROM spreadsheet_rows WHERE id=?').get(request.rowId)!;
        db.prepare('INSERT INTO spreadsheet_adjustments VALUES (?,?,?,?,?,?,?)').run(id, request.revisionId, request.rowId, effect.effect_id!, request.legacyUsedDelta, request.unclassifiedDelta, JSON.stringify(result));
        return result;
      });
    },
    adjustments(request) { valid(dto.isSpreadsheetAdjustmentsRequest(request)); return options.read(db => databasePage(db, 'spreadsheet_adjustments', `WHERE revision_id=?${request.rowId ? ' AND row_id=?' : ''}`, [request.revisionId, ...(request.rowId ? [request.rowId] : [])], request.page, dto.isSpreadsheetInventoryAdjustment)); },
  };
}

/** 备份只读核验：先预算，再验证原文件、行、修订和库存效果；绝不迁移或修复。 */
export function verifySpreadsheetImportDatabase(db: DatabaseSync): void {
  for (const [name, sql] of Object.entries(tables)) if (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name)?.sql !== sql) return corrupt();
  for (const sql of triggers) { const name = sql.split(' ')[2]!; if (db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name)?.sql !== sql) return corrupt(); }
  budget(db);
  for (const row of db.prepare('SELECT * FROM spreadsheet_sources').iterate()) {
    const source = sourceData(db, String(row.id));
    if (!(row.bytes instanceof Uint8Array) || row.bytes.length !== source.byteLength || sha(row.bytes) !== source.workbookHash) return corrupt();
    const grouped = new Map(source.sheets.map(sheet => [sheet.name, { rows: 0, cells: 0 }]));
    for (const raw of db.prepare('SELECT * FROM spreadsheet_source_rows WHERE source_id=?').iterate(source.id)) {
      const data = json(raw.data, dto.isSpreadsheetSourceRow), counts = grouped.get(data.sheetName);
      if (data.sourceId !== source.id || data.sheetName !== raw.sheet_name || data.rowIndex !== raw.row_index || spreadsheetFingerprint(data.cells) !== data.rawRowHash || !counts) return corrupt();
      counts.rows++; counts.cells += data.cells.filter(cell => cell.type !== 'blank' || cell.formula !== undefined).length;
    }
    for (const sheet of source.sheets) if (grouped.get(sheet.name)?.rows !== sheet.rowCount || grouped.get(sheet.name)?.cells !== sheet.nonEmptyCellCount) return corrupt();
  }
  for (const row of db.prepare('SELECT * FROM spreadsheet_revisions').iterate()) {
    const revision = revisionData(db, String(row.id)), source = sourceData(db, revision.sourceId), entries = importedRows(db, revision.id);
    if (revision.workbookHash !== source.workbookHash || !source.sheets.some(sheet => sheet.name === revision.sheetName) || revision.summary.totalRows !== entries.length) return corrupt();
    if (revision.previousRevisionId) { const previous = revisionData(db, revision.previousRevisionId), prior = db.prepare('SELECT lineage_id FROM spreadsheet_revisions WHERE id=?').get(previous.id)!; if (previous.sequence + 1 !== revision.sequence || prior.lineage_id !== row.lineage_id) return corrupt(); }
    else if (revision.sequence !== 1 || row.lineage_id !== revision.id) return corrupt();
    const plan: dto.SpreadsheetImportPlan = { sourceId: source.id, sheetName: revision.sheetName, format: revision.format, headerRow: revision.headerRow, columns: revision.columns, sourceRelationship: revision.previousRevisionId ? 'revision' : 'independent', previousRevisionId: revision.previousRevisionId, decisions: [] };
    const priorRows = revision.previousRevisionId ? new Map(importedRows(db, revision.previousRevisionId).map(entry => [entry.id, entry])) : new Map<string, dto.SpreadsheetImportedRow>();
    const referenced = new Set<string>();
    const derived = { totalRows: entries.length, newRows: 0, matchedRows: 0, changedRows: 0, ambiguousRows: 0, skippedRows: 0, invalidRows: 0, removedRows: 0, newQuantity: 0, legacyUsed: 0, unclassified: 0 };
    const summaryKeys = { new: 'newRows', matched: 'matchedRows', changed: 'changedRows', ambiguous: 'ambiguousRows', skipped: 'skippedRows', invalid: 'invalidRows' } as const;
    for (const entry of entries) {
      derived[summaryKeys[entry.match]]++;
      if (entry.previousRowId) { if (!priorRows.has(entry.previousRowId) || referenced.has(entry.previousRowId)) return corrupt(); referenced.add(entry.previousRowId); }
      const raw = db.prepare('SELECT data FROM spreadsheet_source_rows WHERE source_id=? AND sheet_name=? AND row_index=?').get(source.id, revision.sheetName, entry.rowIndex);
      if (!raw || entry.rowIndex <= revision.headerRow) return corrupt();
      const original = json(raw.data, dto.isSpreadsheetSourceRow), normalized = normalizeSpreadsheetRow(original, plan, source.dateSystem, true);
      if (original.rawRowHash !== entry.rawRowHash || !same(normalized.normalized, entry.normalized) || normalized.normalizedSignature !== entry.normalizedSignature) return corrupt();
      const effect = db.prepare('SELECT e.* FROM spreadsheet_rows r LEFT JOIN spreadsheet_effects e ON e.id=r.effect_id WHERE r.id=?').get(entry.id)!;
      if ((effect.lot_id ?? null) !== entry.lotId || (effect.model_id ?? null) !== entry.modelId) return corrupt();
      if (entry.action === 'created') {
        if (entry.match !== 'new' || !entry.ready || !normalized.valid || effect.quantity !== entry.normalized.quantity || effect.legacy !== (entry.normalized.used ?? 0) || entry.previousRowId !== null) return corrupt();
        derived.newQuantity += Number(effect.quantity); derived.legacyUsed += Number(effect.legacy); derived.unclassified += Number(effect.unknown);
      } else if (entry.action === 'linked' || entry.action === 'suggested') {
        const previous = priorRows.get(entry.previousRowId ?? '');
        if (!previous || previous.lotId !== entry.lotId || previous.modelId !== entry.modelId || entry.action === 'linked' && entry.match !== 'matched' || entry.action === 'suggested' && entry.match !== 'changed') return corrupt();
      } else if (entry.lotId !== null || entry.modelId !== null) return corrupt();
    }
    derived.removedRows = priorRows.size - referenced.size;
    if (!same(derived, revision.summary)) return corrupt();
    if (!db.prepare('SELECT 1 FROM spreadsheet_heads WHERE lineage_id=?').get(row.lineage_id!)) return corrupt();
  }
  for (const head of db.prepare('SELECT * FROM spreadsheet_heads').iterate()) {
    const latest = db.prepare("SELECT id FROM spreadsheet_revisions WHERE lineage_id=? ORDER BY CAST(json_extract(data,'$.sequence') AS INTEGER) DESC LIMIT 1").get(head.lineage_id!);
    if (latest?.id !== head.current_id) return corrupt();
  }
  for (const effect of db.prepare('SELECT * FROM spreadsheet_effects').iterate()) {
    const lot = db.prepare('SELECT l.*,s.model_id FROM inventory_lots l JOIN collection_skus s ON s.id=l.sku_id WHERE l.id=?').get(effect.lot_id!);
    const delta = db.prepare('SELECT COALESCE(sum(legacy_delta+unknown_delta),0) n FROM spreadsheet_adjustments WHERE effect_id=?').get(effect.id!);
    const copies = Number(db.prepare('SELECT count(*) n FROM physical_copies WHERE lot_id=?').get(effect.lot_id!)?.n);
    if (Number(db.prepare("SELECT count(*) n FROM spreadsheet_rows WHERE effect_id=? AND json_extract(data,'$.action')='created'").get(effect.id!)?.n) !== 1) return corrupt();
    if (!lot || lot.model_id !== effect.model_id || lot.acquired !== effect.quantity || Number(effect.legacy) + Number(effect.unknown) !== effect.quantity || lot.quantity_adjustment !== delta?.n || Number(lot.legacy) + Number(lot.unknown) + copies !== Number(lot.acquired) + Number(lot.quantity_adjustment)) return corrupt();
    const receipt = db.prepare('SELECT result,action FROM inventory_ledger WHERE command_id=?').get(effect.command_id!);
    if (!receipt || receipt.action !== 'spreadsheet-receive' || json(receipt.result, dto.isCollectionMutationResult).lotId !== effect.lot_id) return corrupt();
  }
  for (const row of db.prepare('SELECT * FROM spreadsheet_adjustments').iterate()) {
    const data = json(row.data, dto.isSpreadsheetInventoryAdjustment);
    const owner = db.prepare('SELECT r.revision_id,r.effect_id,e.lot_id,e.model_id FROM spreadsheet_rows r JOIN spreadsheet_effects e ON e.id=r.effect_id WHERE r.id=?').get(row.row_id!);
    if (!owner || owner.revision_id !== row.revision_id || owner.effect_id !== row.effect_id || owner.lot_id !== data.lotId || owner.model_id !== data.before.modelId || data.after.quantityAdjustment - data.before.quantityAdjustment !== Number(row.legacy_delta) + Number(row.unknown_delta)) return corrupt();
    if (data.id !== row.id || data.revisionId !== row.revision_id || data.rowId !== row.row_id || data.after.legacyUsed - data.before.legacyUsed !== row.legacy_delta || data.after.unclassified - data.before.unclassified !== row.unknown_delta) return corrupt();
  }
  for (const row of db.prepare('SELECT * FROM spreadsheet_ledger').iterate()) {
    if (!dto.isCollectionId(row.command_id) || typeof row.fingerprint !== 'string' || !/^[0-9a-f]{64}$/u.test(row.fingerprint)) return corrupt();
    if (row.kind === 'register-spreadsheet-source') { const result = json(row.result, dto.isSpreadsheetWorkbookSource); if (!same(result, sourceData(db, result.id))) return corrupt(); }
    else if (row.kind === 'apply-spreadsheet-import') { const result = json(row.result, dto.isSpreadsheetImportResult); if (!same(result.revision, revisionData(db, result.revision.id))) return corrupt(); }
    else if (row.kind === 'adjust-spreadsheet-import') { const result = json(row.result, dto.isSpreadsheetInventoryAdjustment), stored = db.prepare('SELECT data FROM spreadsheet_adjustments WHERE id=?').get(result.id); if (!stored || !same(result, json(stored.data, dto.isSpreadsheetInventoryAdjustment))) return corrupt(); }
    else return corrupt();
  }
  if (db.prepare('PRAGMA foreign_key_check').get()) return corrupt();
}
