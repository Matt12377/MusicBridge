import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { createCollectionRepository } from '../src/collection/repository.js';
import { verifySpreadsheetImportDatabase } from '../src/collection/spreadsheet-import-store.js';
import type { ParsedSpreadsheetWorkbook, SpreadsheetImportPlan, SpreadsheetCell } from '@music-bridge/contracts';

const page = { offset: 0, limit: 25 };
async function fixture(t: test.TestContext, beforeCommit?: (action: string) => void) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-sheet-import-'));
  const filePath = path.join(directory, 'collection.sqlite'), db = new DatabaseSync(filePath);
  db.exec(await readFile(new URL('./fixtures/collection-schema15.sql', import.meta.url), 'utf8')); db.close();
  const repository = createCollectionRepository({ filePath, ...(beforeCommit ? { beforeCommit } : {}) });
  t.after(async () => { repository.close(); await rm(directory, { recursive: true, force: true }); });
  return { repository, filePath };
}
function preserved(db: DatabaseSync) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'recording_plan*' AND name NOT GLOB 'recording_attempt*' AND name NOT GLOB 'recording_record*' AND name NOT GLOB 'recording_print*' AND name NOT GLOB 'master_artwork*' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB 'spreadsheet_*' AND name NOT GLOB 'collection_progress_*' AND name NOT GLOB 'collection_want*' ORDER BY name").all().map(({ name }) => [name, db.prepare(name === 'inventory_lots' ? 'SELECT id,sku_id,acquired,sealed,opened,legacy,unknown FROM inventory_lots ORDER BY rowid' : `SELECT * FROM ${name} ORDER BY rowid`).all()]);
}
test('固定schema15迁移21保留原库存/实体/照片/目录快照，新增调整额为0且外键恢复开启', async t => {
  const { repository, filePath } = await fixture(t), before = new DatabaseSync(filePath, { readOnly: true });
  const history = preserved(before); assert.equal(before.prepare('PRAGMA user_version').get()?.user_version, 15); before.close();
  const exec = DatabaseSync.prototype.exec, restored: number[] = [];
  DatabaseSync.prototype.exec = function(sql: string) { exec.call(this, sql); if (/foreign_keys\s*=\s*ON/iu.test(sql)) restored.push(Number(this.prepare('PRAGMA foreign_keys').get()?.foreign_keys)); };
  try { assert.equal(repository.list(page).items[0]?.counts.total, 5); } finally { DatabaseSync.prototype.exec = exec; repository.close(); }
  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 21); assert.deepEqual(preserved(db), history);
    assert.equal(db.prepare('SELECT SUM(quantity_adjustment) n FROM inventory_lots').get()?.n, 0);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []); assert.ok(restored.includes(1));
  } finally { db.close(); }
});
test('迁移提交故障回滚到真正15且恢复FK；冷开再迁移不丢原账本', async t => {
  const { repository, filePath } = await fixture(t, action => { if (action === 'migrate-spreadsheet-imports') throw new Error('合成迁移故障'); });
  const before = new DatabaseSync(filePath, { readOnly: true }), history = preserved(before); before.close();
  const exec = DatabaseSync.prototype.exec, restored: number[] = [];
  DatabaseSync.prototype.exec = function(sql: string) { exec.call(this, sql); if (/foreign_keys\s*=\s*ON/iu.test(sql)) restored.push(Number(this.prepare('PRAGMA foreign_keys').get()?.foreign_keys)); };
  try { assert.throws(() => repository.list(page), /库存暂时不可用/u); } finally { DatabaseSync.prototype.exec = exec; repository.close(); }
  const old = new DatabaseSync(filePath, { readOnly: true });
  try { assert.equal(old.prepare('PRAGMA user_version').get()?.user_version, 15); assert.deepEqual(preserved(old), history); assert.ok(restored.includes(1)); } finally { old.close(); }
  const cold = createCollectionRepository({ filePath }); try { assert.equal(cold.list(page).items[0]?.counts.total, 5); } finally { cold.close(); }
});

const cell = (columnIndex: number, value: string | number | null, extra: Partial<SpreadsheetCell> = {}): SpreadsheetCell => ({ columnIndex, type: value === null ? 'blank' : typeof value === 'number' ? 'number' : 'string', value, ...extra });
const workbook = (rows: readonly SpreadsheetCell[][]): ParsedSpreadsheetWorkbook => ({ fileFormat: 'xlsx', parserVersion: 'sheetjs-ce-0.20.3', dateSystem: '1900', sheets: [{ name: '库存', rows: rows.map((cells, i) => ({ rowIndex: i + 1, cells })) }] });
const cells = (name = 'SA', quantity = 10, used: number | null = 3) => [cell(1, 'TDK'), cell(2, name), cell(3, '1990候选'), cell(4, 90), cell(5, quantity), cell(6, used), cell(7, '保留备注')];
const columns = { brand: 1, model: 2, edition: 3, year: null, iec: null, length: 4, quantity: 5, used: 6, price: null, purchaseDate: null, notes: 7 };
function register(repository: ReturnType<typeof createCollectionRepository>, rows: SpreadsheetCell[][], token = randomUUID()) {
  const bytes = Buffer.from('合成原文件字节:' + token), parsed = workbook(rows);
  const request = { commandId: randomUUID(), bytes, displayName: 'synthetic.xlsx', workbook: parsed };
  return { source: repository.spreadsheetImports.registerSource(request), request };
}
function plan(sourceId: string, overrides: Partial<SpreadsheetImportPlan> = {}): SpreadsheetImportPlan { return { sourceId, sheetName: '库存', format: 'cassette', headerRow: 0, columns, sourceRelationship: 'independent', previousRevisionId: null, decisions: [], ...overrides }; }
function apply(repository: ReturnType<typeof createCollectionRepository>, input: SpreadsheetImportPlan) {
  const preview = repository.spreadsheetImports.preview({ ...input, page });
  const command = { ...input, commandId: randomUUID(), baselineFingerprint: preview.baselineFingerprint, userConfirmed: true as const };
  return { preview, command, value: repository.spreadsheetImports.apply(command) };
}
test('实际原字节Hash/typed rows持久，预览不写库存；10/Used3只建Legacy3+Unknown7且不分配实体', async t => {
  const { repository, filePath } = await fixture(t), before = repository.list(page).items.reduce((n, m) => n + m.counts.total, 0);
  const input = register(repository, [cells()]);
  assert.equal(input.source.workbookHash, createHash('sha256').update(input.request.bytes).digest('hex'));
  assert.deepEqual(repository.spreadsheetImports.registerSource(input.request), input.source);
  const rowPage = repository.spreadsheetImports.sourceRows({ sourceId: input.source.id, sheetName: '库存', page });
  assert.deepEqual(rowPage.items[0]?.cells, cells());
  const draft = plan(input.source.id, { decisions: [{ rowIndex: 1, action: 'new' }] });
  const preview = repository.spreadsheetImports.preview({ ...draft, page });
  assert.equal(preview.summary.newQuantity, 10); assert.equal(preview.summary.legacyUsed, 3); assert.equal(preview.summary.unclassified, 7);
  assert.equal(repository.list(page).items.reduce((n, m) => n + m.counts.total, 0), before);
  const result = apply(repository, draft), imported = repository.spreadsheetImports.revision({ revisionId: result.value.revision.id, page }).rows.items[0]!;
  const detail = repository.detail(imported.modelId!, page); assert.equal(detail.model.counts.total, 10); assert.equal(detail.model.counts.legacyUsed, 3); assert.equal(detail.model.counts.unknown, 7);
  assert.equal(detail.copies.total, 0); assert.equal(detail.model.edition, ''); assert.equal(imported.normalized.versionCandidate, '1990候选');
  repository.close(); const cold = createCollectionRepository({ filePath });
  try { assert.deepEqual(cold.spreadsheetImports.apply(result.command), result.value); assert.equal(cold.detail(imported.modelId!, page).model.counts.total, 10); } finally { cold.close(); }
});
test('同文件同Sheet换commandId不会加数量，Unknown品牌型号保持空值且每原行私有身份隔离', async t => {
  const { repository } = await fixture(t);
  const unknown = cells().map(c => c.columnIndex <= 2 ? cell(c.columnIndex, null) : c);
  const input = register(repository, [unknown, unknown]);
  const result = apply(repository, plan(input.source.id, { decisions: [{ rowIndex: 1, action: 'new' }, { rowIndex: 2, action: 'new' }] }));
  const rows = repository.spreadsheetImports.revision({ revisionId: result.value.revision.id, page }).rows.items;
  assert.notEqual(rows[0]?.modelId, rows[1]?.modelId); assert.notEqual(rows[0]?.lotId, rows[1]?.lotId);
  for (const row of rows) { const model = repository.detail(row.modelId!, page).model; assert.equal(model.brand, ''); assert.equal(model.name, ''); assert.equal(model.edition, ''); assert.equal(model.counts.total, 10); }
  const again = repository.spreadsheetImports.apply({ ...result.command, commandId: randomUUID() });
  assert.equal(again.duplicate, true); assert.equal(again.revision.id, result.value.revision.id);
  assert.equal(repository.list({ offset: 0, limit: 100 }).items.reduce((n, m) => n + m.counts.total, 0), 25);
  assert.throws(() => repository.receive({ commandId: randomUUID(), model: rows[0]!.normalized.descriptor, lengthMinutes: 90, quantities: { sealedBlank: 1, openedBlank: 0, legacyUsed: 0, unclassified: 0 } }), /库存请求无效/u);
});
test('重排行唯一匹配不加量，修改行保留建议，插入只有明确new才增加；过期基线拒绝', async t => {
  const { repository } = await fixture(t), first = register(repository, [cells('A'), cells('B')]);
  const original = apply(repository, plan(first.source.id, { decisions: [{ rowIndex: 1, action: 'new' }, { rowIndex: 2, action: 'new' }] })).value;
  const prior = repository.spreadsheetImports.revision({ revisionId: original.revision.id, page }).rows.items;
  const second = register(repository, [cells('B'), cells('A', 12), cells('C')]);
  const next = plan(second.source.id, { sourceRelationship: 'revision', previousRevisionId: original.revision.id, decisions: [{ rowIndex: 2, action: 'match', previousRowId: prior[0]!.id }, { rowIndex: 3, action: 'new' }] });
  const result = apply(repository, next);
  assert.equal(result.preview.summary.matchedRows, 1); assert.equal(result.preview.summary.changedRows, 1); assert.equal(result.preview.summary.newQuantity, 10);
  const rows = repository.spreadsheetImports.revision({ revisionId: result.value.revision.id, page }).rows.items;
  assert.equal(rows[0]?.lotId, prior[1]?.lotId); assert.equal(rows[1]?.lotId, prior[0]?.lotId);
  assert.equal(repository.detail(prior[0]!.modelId!, page).model.counts.total, 10);
  assert.equal(repository.list({ offset: 0, limit: 100 }).items.reduce((n, m) => n + m.counts.total, 0), 35);
  assert.throws(() => repository.spreadsheetImports.preview({ ...next, sourceId: register(repository, [cells('D')]).source.id, page }), /版本|基线|改变/u);
});
test('重复行歧义必须人工对应；missing Used保持Unknown；公式缓存不能自动当确认数量', async t => {
  const { repository } = await fixture(t), first = register(repository, [cells(), cells()]);
  const original = apply(repository, plan(first.source.id, { decisions: [{ rowIndex: 1, action: 'new' }, { rowIndex: 2, action: 'new' }] })).value;
  const second = register(repository, [cells(), cells()]);
  const ambiguous = plan(second.source.id, { sourceRelationship: 'revision', previousRevisionId: original.revision.id });
  const preview = repository.spreadsheetImports.preview({ ...ambiguous, page }); assert.equal(preview.summary.ambiguousRows, 2);
  assert.throws(() => repository.spreadsheetImports.apply({ ...ambiguous, commandId: randomUUID(), baselineFingerprint: preview.baselineFingerprint, userConfirmed: true }), /对应|确认|歧义/u);
  const formula = cells().map(c => c.columnIndex === 5 ? { ...c, formula: 'SUM(A1:A2)' } : c);
  const cached = register(repository, [formula]);
  const unchecked = plan(cached.source.id, { decisions: [{ rowIndex: 1, action: 'new' }] });
  assert.equal(repository.spreadsheetImports.preview({ ...unchecked, page }).rows.items[0]?.ready, false);
  const uncheckedPreview = repository.spreadsheetImports.preview({ ...unchecked, page });
  assert.throws(() => repository.spreadsheetImports.apply({ ...unchecked, commandId: randomUUID(), baselineFingerprint: uncheckedPreview.baselineFingerprint, userConfirmed: true }), /公式数量未确认/u);
  const checked = apply(repository, { ...unchecked, decisions: [{ rowIndex: 1, action: 'new', formulaConfirmed: true }] }); assert.equal(checked.value.revision.summary.newQuantity, 10);
  const noUsed = register(repository, [cells('未分类', 10, null)]);
  const noUsedResult = apply(repository, plan(noUsed.source.id, { decisions: [{ rowIndex: 1, action: 'new' }] }));
  assert.equal(noUsedResult.preview.rows.items[0]?.normalized.used, null); assert.equal(noUsedResult.value.revision.summary.unclassified, 10);
});
test('apply提交前中断不留下半批Lot/row/effect或库存账本，原命令可明确重试', async t => {
  let fail = true;
  const { repository, filePath } = await fixture(t, action => { if (fail && action === 'apply-spreadsheet-import') throw new Error('合成事务中断'); });
  const input = register(repository, [cells('A'), cells('B')]), draft = plan(input.source.id, { decisions: [{ rowIndex: 1, action: 'new' }, { rowIndex: 2, action: 'new' }] });
  const preview = repository.spreadsheetImports.preview({ ...draft, page }), command = { ...draft, commandId: randomUUID(), baselineFingerprint: preview.baselineFingerprint, userConfirmed: true as const };
  assert.throws(() => repository.spreadsheetImports.apply(command), /库存暂时不可用/u);
  assert.equal(repository.list({ offset: 0, limit: 100 }).items.reduce((n, m) => n + m.counts.total, 0), 5);
  const db = new DatabaseSync(filePath, { readOnly: true }); try { assert.equal(db.prepare('SELECT count(*) n FROM inventory_ledger').get()?.n, 3); } finally { db.close(); }
  fail = false; const result = repository.spreadsheetImports.apply(command); assert.equal(result.revision.summary.newQuantity, 20);
});

test('混合批次允许明确跳过缓存公式行，保留原值和审核问题且只为有效新增行记账', async t => {
  const { repository, filePath } = await fixture(t);
  const formula = cells('跳过的公式行').map(c => c.columnIndex === 5 ? { ...c, formula: 'SUM(5,5)' } : c);
  const input = register(repository, [cells('明确新增', 4, 1), formula]);
  const rawBefore = repository.spreadsheetImports.sourceRows({ sourceId: input.source.id, sheetName: '库存', page });
  const before = repository.list(page).items.reduce((n, model) => n + model.counts.total, 0);
  const inspection = new DatabaseSync(filePath, { readOnly: true });
  const ledgerBefore = Number(inspection.prepare('SELECT count(*) n FROM inventory_ledger').get()?.n);
  const lotsBefore = Number(inspection.prepare('SELECT count(*) n FROM inventory_lots').get()?.n);
  inspection.close();
  const draft = plan(input.source.id, { decisions: [{ rowIndex: 1, action: 'new' }, { rowIndex: 2, action: 'skip' }] });
  const preview = repository.spreadsheetImports.preview({ ...draft, page });
  assert.equal(preview.rows.items[1]?.match, 'skipped'); assert.equal(preview.rows.items[1]?.ready, true);
  assert.ok(preview.rows.items[1]?.issues.some(issue => issue.code === 'FORMULA_REVIEW_REQUIRED'));
  const imported = apply(repository, draft).value;
  const rows = repository.spreadsheetImports.revision({ revisionId: imported.revision.id, page }).rows.items;
  assert.equal(imported.revision.summary.newQuantity, 4); assert.equal(imported.revision.summary.skippedRows, 1);
  assert.equal(rows[0]?.action, 'created'); assert.equal(rows[1]?.action, 'skipped');
  assert.equal(rows[1]?.lotId, null); assert.equal(rows[1]?.modelId, null);
  assert.equal(rows[1]?.normalized.quantity, 10); assert.deepEqual(rows[1]?.issues, preview.rows.items[1]?.issues);
  assert.deepEqual(repository.spreadsheetImports.sourceRows({ sourceId: input.source.id, sheetName: '库存', page }), rawBefore);
  assert.equal(repository.list(page).items.reduce((n, model) => n + model.counts.total, 0), before + 4);
  repository.close();
  const after = new DatabaseSync(filePath, { readOnly: true });
  try {
    assert.doesNotThrow(() => verifySpreadsheetImportDatabase(after));
    assert.equal(after.prepare('SELECT count(*) n FROM inventory_ledger').get()?.n, ledgerBefore + 1);
    assert.equal(after.prepare('SELECT count(*) n FROM inventory_lots').get()?.n, lotsBefore + 1);
  } finally { after.close(); }
});

test('独立数量更正绑定当前余额，原acquired不改；已物化实体/照片/原行不被消耗', async t => {
  const { repository, filePath } = await fixture(t), input = register(repository, [cells()]);
  const imported = apply(repository, plan(input.source.id, { decisions: [{ rowIndex: 1, action: 'new' }] })).value;
  const row = repository.spreadsheetImports.revision({ revisionId: imported.revision.id, page }).rows.items[0]!;
  const balanceRequest = { revisionId: imported.revision.id, rowId: row.id };
  const stale = repository.spreadsheetImports.adjustmentPreview(balanceRequest);
  const copy = repository.materialize({ commandId: randomUUID(), lotId: row.lotId!, bucket: 'legacyUsed', action: 'register-legacy' });
  assert.ok(copy.physicalId);
  repository.addPhoto({ commandId: randomUUID(), modelId: row.modelId!, physicalId: copy.physicalId, image: { dataUrl: 'data:image/jpeg;base64,/9j/2Q==', width: 1, height: 1 } });
  const command = { ...balanceRequest, commandId: randomUUID(), lotId: row.lotId!, expectedBalanceFingerprint: stale.balanceFingerprint, legacyUsedDelta: -2, unclassifiedDelta: -7, userConfirmed: true as const };
  assert.throws(() => repository.spreadsheetImports.adjust(command), /余额|改变|指纹/u);
  const before = repository.spreadsheetImports.adjustmentPreview(balanceRequest);
  const result = repository.spreadsheetImports.adjust({ ...command, expectedBalanceFingerprint: before.balanceFingerprint });
  assert.equal(result.after.quantityAcquired, 10); assert.equal(result.after.quantityAdjustment, -9);
  assert.equal(result.after.materializedCount, 1); assert.equal(result.after.legacyUsed, 0); assert.equal(result.after.unclassified, 0);
  const detail = repository.detail(row.modelId!, page); assert.equal(detail.model.counts.total, 1); assert.equal(detail.copies.items[0]?.physicalId, copy.physicalId); assert.equal(detail.photos?.length, 1);
  assert.equal(repository.spreadsheetImports.revision({ revisionId: imported.revision.id, page }).rows.items[0]?.normalized.quantity, 10);
  assert.throws(() => repository.spreadsheetImports.adjust({ ...command, commandId: randomUUID(), expectedBalanceFingerprint: result.after.balanceFingerprint, legacyUsedDelta: -1, unclassifiedDelta: 0 }), /余额|负|数量/u);
  const db = new DatabaseSync(filePath, { readOnly: true }); try { assert.equal(db.prepare('SELECT acquired,quantity_adjustment FROM inventory_lots WHERE id=?').get(row.lotId!)?.acquired, 10); } finally { db.close(); }
});

test('全池数量可明确更正到0后增加，独立更正幂等且提交中断完整回滚', async t => {
  let fail = false;
  const { repository, filePath } = await fixture(t, action => { if (fail && action === 'adjust-spreadsheet-import') throw new Error('合成更正故障'); });
  const input = register(repository, [cells()]), imported = apply(repository, plan(input.source.id, { decisions: [{ rowIndex: 1, action: 'new' }] })).value;
  const row = repository.spreadsheetImports.revision({ revisionId: imported.revision.id, page }).rows.items[0]!;
  const location = { revisionId: imported.revision.id, rowId: row.id }, before = repository.spreadsheetImports.adjustmentPreview(location);
  const command = { ...location, commandId: randomUUID(), lotId: row.lotId!, expectedBalanceFingerprint: before.balanceFingerprint, legacyUsedDelta: -3, unclassifiedDelta: -7, userConfirmed: true as const };
  fail = true; assert.throws(() => repository.spreadsheetImports.adjust(command), /库存暂时不可用/u);
  assert.deepEqual(repository.spreadsheetImports.adjustmentPreview(location), before);
  fail = false; const zero = repository.spreadsheetImports.adjust(command);
  assert.equal(repository.detail(row.modelId!, page).model.counts.total, 0);
  assert.equal(zero.after.quantityAcquired, 10); assert.equal(zero.after.quantityAdjustment, -10);
  assert.deepEqual(repository.spreadsheetImports.adjust(command), zero);
  const increase = repository.spreadsheetImports.adjust({ ...command, commandId: randomUUID(), expectedBalanceFingerprint: zero.after.balanceFingerprint, legacyUsedDelta: 2, unclassifiedDelta: 10 });
  assert.equal(increase.after.quantityAdjustment, 2); assert.equal(repository.detail(row.modelId!, page).model.counts.total, 12);
  repository.close(); const cold = createCollectionRepository({ filePath });
  try { assert.deepEqual(cold.spreadsheetImports.adjust(command), zero); assert.equal(cold.detail(row.modelId!, page).model.counts.total, 12); } finally { cold.close(); }
});

test('只读核验接受完整来源/修订/更正；拒绝原字节、规范化事实和遗失当前指针，不修复现场', async t => {
  const { repository, filePath } = await fixture(t), input = register(repository, [cells()]);
  const result = apply(repository, plan(input.source.id, { decisions: [{ rowIndex: 1, action: 'new' }] })).value;
  const row = repository.spreadsheetImports.revision({ revisionId: result.revision.id, page }).rows.items[0]!;
  const location = { revisionId: result.revision.id, rowId: row.id }, before = repository.spreadsheetImports.adjustmentPreview(location);
  repository.spreadsheetImports.adjust({ ...location, commandId: randomUUID(), lotId: row.lotId!, expectedBalanceFingerprint: before.balanceFingerprint, legacyUsedDelta: 1, unclassifiedDelta: 0, userConfirmed: true });
  repository.close(); const db = new DatabaseSync(filePath); t.after(() => db.close());
  assert.doesNotThrow(() => verifySpreadsheetImportDatabase(db));
  const sourceTrigger = String(db.prepare("SELECT sql FROM sqlite_master WHERE name='spreadsheet_sources_no_update'").get()?.sql);
  const original = db.prepare('SELECT bytes FROM spreadsheet_sources WHERE id=?').get(input.source.id)!.bytes;
  db.exec('DROP TRIGGER spreadsheet_sources_no_update'); db.prepare('UPDATE spreadsheet_sources SET bytes=? WHERE id=?').run(Buffer.from('篡改字节'), input.source.id); db.exec(sourceTrigger);
  assert.throws(() => verifySpreadsheetImportDatabase(db), /损坏/u);
  assert.deepEqual(db.prepare('SELECT bytes FROM spreadsheet_sources WHERE id=?').get(input.source.id)?.bytes, new Uint8Array(Buffer.from('篡改字节')));
  db.exec('DROP TRIGGER spreadsheet_sources_no_update'); db.prepare('UPDATE spreadsheet_sources SET bytes=? WHERE id=?').run(original!, input.source.id); db.exec(sourceTrigger);
  const rowTrigger = String(db.prepare("SELECT sql FROM sqlite_master WHERE name='spreadsheet_rows_no_update'").get()?.sql);
  db.exec('DROP TRIGGER spreadsheet_rows_no_update');
  db.prepare('UPDATE spreadsheet_rows SET data=? WHERE id=?').run(JSON.stringify({ ...row, normalized: { ...row.normalized, quantity: 999 } }), row.id); db.exec(rowTrigger);
  assert.throws(() => verifySpreadsheetImportDatabase(db), /损坏/u);
  db.exec('DROP TRIGGER spreadsheet_rows_no_update'); db.prepare('UPDATE spreadsheet_rows SET data=? WHERE id=?').run(JSON.stringify(row), row.id); db.exec(rowTrigger);
  db.prepare('DELETE FROM spreadsheet_heads').run();
  assert.throws(() => verifySpreadsheetImportDatabase(db), /损坏/u);
  assert.equal(db.prepare('SELECT count(*) n FROM spreadsheet_heads').get()?.n, 0);
});

test('原文件同hash解析结果冲突拒绝且来源登记中断不留部分行；分页不改变基线', async t => {
  let fail = false;
  const { repository, filePath } = await fixture(t, action => { if (fail && action === 'register-spreadsheet-source') throw new Error('合成来源中断'); });
  const input = register(repository, [cells()]);
  assert.throws(() => repository.spreadsheetImports.registerSource({ ...input.request, commandId: randomUUID(), workbook: workbook([cells('改写')]) }), /解析内容/u);
  const request = { ...input.request, commandId: randomUUID(), bytes: Buffer.from('第二份合成源'), workbook: workbook([cells('B'), cells('C')]) };
  fail = true; assert.throws(() => repository.spreadsheetImports.registerSource(request), /库存暂时不可用/u);
  assert.equal(repository.spreadsheetImports.sources(page).total, 1); assert.deepEqual(repository.spreadsheetImports.sourceReceipt({ commandId: request.commandId }), { source: null });
  fail = false; const source = repository.spreadsheetImports.registerSource(request);
  const draft = plan(source.id, { decisions: [{ rowIndex: 1, action: 'new' }, { rowIndex: 2, action: 'new' }] });
  assert.equal(repository.spreadsheetImports.preview({ ...draft, page }).baselineFingerprint, repository.spreadsheetImports.preview({ ...draft, page: { offset: 1, limit: 1 } }).baselineFingerprint);
  const preview = repository.spreadsheetImports.preview({ ...draft, page });
  assert.throws(() => repository.spreadsheetImports.apply({ ...draft, columns: { ...draft.columns, used: null }, commandId: randomUUID(), baselineFingerprint: preview.baselineFingerprint, userConfirmed: true }), /基线/u);
  const db = new DatabaseSync(filePath, { readOnly: true }); try { assert.equal(db.prepare('SELECT count(*) n FROM spreadsheet_revisions').get()?.n, 0); } finally { db.close(); }
});

test('无效数量/日期原单元格完整保留，记录无effect；删除只是建议且目录候选不改快照', async t => {
  const { repository, filePath } = await fixture(t);
  const catalogHistory = repository.catalog.history({ bookId: 'synthetic-book', offset: 0, limit: 25 });
  const catalogId = catalogHistory.currentRevisionId!;
  const candidate = repository.catalog.revision({ id: catalogId }).revision.items[0]!;
  const raw = cells(candidate.model).map(c => c.columnIndex === 1 ? cell(1, candidate.brand) : c);
  const first = register(repository, [raw, cells('将删除')]);
  const original = apply(repository, plan(first.source.id, { catalogRevisionId: catalogId, decisions: [{ rowIndex: 1, action: 'new' }, { rowIndex: 2, action: 'new' }] })).value;
  const originalRows = repository.spreadsheetImports.revision({ revisionId: original.revision.id, page }).rows.items;
  assert.ok(originalRows[0]!.candidates.some(c => c.referenceId === candidate.referenceId));
  const invalid = raw.map(c => c.columnIndex === 5 ? cell(5, -2.5) : c);
  const second = register(repository, [raw, invalid]);
  const next = plan(second.source.id, { sourceRelationship: 'revision', previousRevisionId: original.revision.id, decisions: [{ rowIndex: 2, action: 'skip' }] });
  const changed = apply(repository, next);
  assert.equal(changed.preview.summary.removedRows, 1); assert.equal(changed.value.revision.summary.newQuantity, 0);
  assert.equal(repository.detail(originalRows[1]!.modelId!, page).model.counts.total, 10);
  assert.deepEqual(repository.catalog.history({ bookId: 'synthetic-book', offset: 0, limit: 25 }), catalogHistory);
  const negative = register(repository, [cells().map(c => c.columnIndex === 5 ? cell(5, -2.5) : c), [...cells(), cell(8, 60)]]);
  const bad = apply(repository, plan(negative.source.id, { columns: { ...columns, purchaseDate: 8 }, decisions: [{ rowIndex: 1, action: 'new' }, { rowIndex: 2, action: 'new' }] }));
  assert.equal(bad.value.revision.summary.invalidRows, 2); assert.equal(bad.preview.rows.items[0]!.normalized.quantity, null);
  assert.ok(bad.preview.rows.items[1]!.issues.some(i => i.code === 'INVALID_DATE'));
  assert.equal(repository.spreadsheetImports.sourceRows({ sourceId: negative.source.id, sheetName: '库存', page }).items[0]!.cells.find(c => c.columnIndex === 5)?.value, -2.5);
  repository.close(); const db = new DatabaseSync(filePath, { readOnly: true }); try { assert.doesNotThrow(() => verifySpreadsheetImportDatabase(db)); } finally { db.close(); }
});

test('更正历史必须关联原行的实际effect，离线调换关联即使金额相同也被只读核验拒绝', async t => {
  const { repository, filePath } = await fixture(t), input = register(repository, [cells('A'), cells('B')]);
  const result = apply(repository, plan(input.source.id, { decisions: [{ rowIndex: 1, action: 'new' }, { rowIndex: 2, action: 'new' }] })).value;
  const rows = repository.spreadsheetImports.revision({ revisionId: result.revision.id, page }).rows.items;
  for (const row of rows) { const location = { revisionId: result.revision.id, rowId: row.id }, before = repository.spreadsheetImports.adjustmentPreview(location); repository.spreadsheetImports.adjust({ ...location, commandId: randomUUID(), lotId: row.lotId!, expectedBalanceFingerprint: before.balanceFingerprint, legacyUsedDelta: 1, unclassifiedDelta: 0, userConfirmed: true }); }
  repository.close(); const db = new DatabaseSync(filePath); t.after(() => db.close());
  const changes = db.prepare('SELECT id,effect_id FROM spreadsheet_adjustments ORDER BY rowid').all();
  const trigger = String(db.prepare("SELECT sql FROM sqlite_master WHERE name='spreadsheet_adjustments_no_update'").get()?.sql);
  db.exec('DROP TRIGGER spreadsheet_adjustments_no_update');
  db.prepare('UPDATE spreadsheet_adjustments SET effect_id=? WHERE id=?').run(changes[1]!.effect_id!, changes[0]!.id!);
  db.prepare('UPDATE spreadsheet_adjustments SET effect_id=? WHERE id=?').run(changes[0]!.effect_id!, changes[1]!.id!); db.exec(trigger);
  assert.throws(() => verifySpreadsheetImportDatabase(db), /损坏/u);
});

test('持久source容量满时明确拒绝新增且不清历史；只读核验先拒绝超大原文', async t => {
  const { repository, filePath } = await fixture(t); register(repository, [cells()]);
  const db = new DatabaseSync(filePath); t.after(() => db.close());
  const row = db.prepare('SELECT * FROM spreadsheet_sources LIMIT 1').get()!;
  const insert = db.prepare('INSERT INTO spreadsheet_sources VALUES (?,?,?,?)');
  db.exec('BEGIN'); for (let i = 1; i < 1000; i++) insert.run(randomUUID(), i.toString(16).padStart(64, '0'), row.bytes!, row.data!); db.exec('COMMIT');
  assert.throws(() => register(repository, [cells('超限')]), /容量|上限/u);
  assert.equal(db.prepare('SELECT count(*) n FROM spreadsheet_sources').get()?.n, 1000);
  const id = randomUUID(); insert.run(id, 'f'.repeat(64), Buffer.alloc(8 * 1024 * 1024 + 65537), '{}');
  assert.throws(() => verifySpreadsheetImportDatabase(db), /容量|上限/u);
  assert.equal(db.prepare('SELECT count(*) n FROM spreadsheet_sources').get()?.n, 1001);
});

test('合法长文本与控制字符源单元格保留，非法型号字段置Unknown并明确invalid，不能截断入库', async t => {
  const { repository, filePath } = await fixture(t);
  const raw = cells().map(c => c.columnIndex === 1 ? cell(1, '牌'.repeat(121)) : c.columnIndex === 2 ? cell(2, '型号\u0000保留原文') : c);
  const input = register(repository, [raw]), draft = plan(input.source.id, { decisions: [{ rowIndex: 1, action: 'new' }] });
  const preview = repository.spreadsheetImports.preview({ ...draft, page }), row = preview.rows.items[0]!;
  assert.equal(row.match, 'invalid'); assert.equal(row.ready, false); assert.equal(row.normalized.descriptor.brand, ''); assert.equal(row.normalized.descriptor.name, '');
  assert.ok(row.issues.some(issue => issue.code === 'INVALID_METADATA' && issue.field === 'brand'));
  assert.ok(row.issues.some(issue => issue.code === 'INVALID_METADATA' && issue.field === 'model'));
  assert.equal(apply(repository, draft).value.revision.summary.newQuantity, 0);
  assert.deepEqual(repository.spreadsheetImports.sourceRows({ sourceId: input.source.id, sheetName: '库存', page }).items[0]!.cells, raw);
  assert.equal(repository.list(page).items.reduce((sum, model) => sum + model.counts.total, 0), 5);
  repository.close(); const db = new DatabaseSync(filePath, { readOnly: true }); try { assert.doesNotThrow(() => verifySpreadsheetImportDatabase(db)); } finally { db.close(); }
});

test('NFKC展开后的版次候选/Notes超预算时整行invalid，原始文本不截断', async t => {
  const { repository, filePath } = await fixture(t), text = '㍿'.repeat(3000);
  const raw = cells().map(c => c.columnIndex === 3 || c.columnIndex === 7 ? cell(c.columnIndex, text) : c);
  const input = register(repository, [raw]), draft = plan(input.source.id, { decisions: [{ rowIndex: 1, action: 'new' }] });
  const preview = repository.spreadsheetImports.preview({ ...draft, page }), row = preview.rows.items[0]!;
  assert.equal(row.match, 'invalid'); assert.equal(row.normalized.versionCandidate, ''); assert.equal(row.normalized.notes, '');
  assert.ok(row.issues.some(issue => issue.code === 'INVALID_METADATA' && issue.field === 'edition'));
  assert.ok(row.issues.some(issue => issue.code === 'INVALID_METADATA' && issue.field === 'notes'));
  assert.equal(apply(repository, draft).value.revision.summary.newQuantity, 0);
  assert.deepEqual(repository.spreadsheetImports.sourceRows({ sourceId: input.source.id, sheetName: '库存', page }).items[0]!.cells, raw);
  repository.close(); const db = new DatabaseSync(filePath, { readOnly: true }); try { assert.doesNotThrow(() => verifySpreadsheetImportDatabase(db)); } finally { db.close(); }
});

test('品牌型号原文的换行制表回车不得被规范化洗掉，备注换行与正常全半角仍可导入', async t => {
  const { repository, filePath } = await fixture(t);
  const invalid = ([1, 2] as const).flatMap(column => ['\n', '\t', '\r'].map(control => cells().map(c => c.columnIndex === column ? cell(column, `ＴＤＫ${control}ＳＡ`) : c)));
  const notes = '第一行\n第二行\t尾段\r结束';
  const valid = cells('ＳＡ', 2, 0).map(c => c.columnIndex === 1 ? cell(1, '　ＴＤＫ　') : c.columnIndex === 7 ? cell(7, notes) : c);
  const raw = [...invalid, valid], input = register(repository, raw);
  const draft = plan(input.source.id, { decisions: raw.map((_, index) => ({ rowIndex: index + 1, action: 'new' })) });
  const preview = repository.spreadsheetImports.preview({ ...draft, page });
  for (let index = 0; index < invalid.length; index++) {
    const row = preview.rows.items[index]!, field = index < 3 ? 'brand' : 'model';
    assert.equal(row.match, 'invalid'); assert.equal(row.ready, false);
    assert.equal(row.normalized.descriptor[field === 'brand' ? 'brand' : 'name'], '');
    assert.ok(row.issues.some(issue => issue.code === 'INVALID_METADATA' && issue.field === field));
  }
  const normal = preview.rows.items[6]!;
  assert.equal(normal.ready, true); assert.equal(normal.normalized.descriptor.brand, 'TDK'); assert.equal(normal.normalized.descriptor.name, 'SA');
  assert.equal(normal.normalized.notes, '第一行 第二行 尾段 结束');
  assert.ok(!normal.issues.some(issue => issue.code === 'INVALID_METADATA'));
  const imported = apply(repository, draft).value;
  assert.equal(imported.revision.summary.invalidRows, 6); assert.equal(imported.revision.summary.newQuantity, 2);
  const rows = repository.spreadsheetImports.revision({ revisionId: imported.revision.id, page }).rows.items;
  for (const row of rows.slice(0, 6)) { assert.equal(row.action, 'invalid'); assert.equal(row.lotId, null); assert.equal(row.modelId, null); }
  assert.deepEqual(repository.spreadsheetImports.sourceRows({ sourceId: input.source.id, sheetName: '库存', page }).items.map(row => row.cells), raw);
  assert.equal(repository.list(page).items.reduce((sum, model) => sum + model.counts.total, 0), 7);
  repository.close(); const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT count(*) n FROM spreadsheet_effects').get()?.n, 1);
    assert.doesNotThrow(() => verifySpreadsheetImportDatabase(db));
  } finally { db.close(); }
});
