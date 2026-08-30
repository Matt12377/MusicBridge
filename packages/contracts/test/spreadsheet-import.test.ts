import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import * as c from '../src/index.js';

const id = randomUUID(), commandId = randomUUID(), hash = 'a'.repeat(64);
const columns = { brand: 1, model: 2, edition: null, year: null, iec: null, length: 3, quantity: 4, price: null, purchaseDate: null, used: 5, notes: null };
const plan = { sourceId: id, sheetName: '库存', format: 'cassette', sourceRelationship: 'independent', headerRow: 1, columns, previousRevisionId: null, decisions: [{ rowIndex: 2, action: 'new' }] };
const source = { id, displayName: '合成.xlsx', workbookHash: hash, fileFormat: 'xlsx', parserVersion: 'sheetjs-ce-0.20.3', dateSystem: '1900', byteLength: 100, createdAt: '2026-08-28T00:00:00.000Z', sheets: [{ name: '库存', rowCount: 2, nonEmptyCellCount: 4 }] };
const unknown = { brand: '', name: '', edition: '', year: null, format: 'cassette', tapeType: 'unknown', identification: 'partial' };

test('超出库存元数据约束的原单元格可标记明确行错误，不伪装有效Unknown', () => {
  assert.equal(c.isSpreadsheetImportIssue({ code: 'INVALID_METADATA', field: 'brand' }), true);
  assert.equal(c.isSpreadsheetImportIssue({ code: 'INVALID_METADATA', field: 'model' }), true);
  assert.equal(c.isSpreadsheetImportIssue({ code: ['INVALID_METADATA'], field: 'brand' }), false);
});

test('来源关系必须明确声明且与旧修订一致，不能把空旧ID默认当首次导入', () => {
  const { sourceRelationship: _relationship, ...undeclared } = { ...plan, sourceRelationship: 'independent' };
  for (const guard of [c.isSpreadsheetImportPlan, c.isPreviewSpreadsheetImportRequest, c.isApplySpreadsheetImportRequest]) {
    const envelope = guard === c.isPreviewSpreadsheetImportRequest ? { page: { offset: 0, limit: 25 } } : guard === c.isApplySpreadsheetImportRequest ? { commandId, baselineFingerprint: hash, userConfirmed: true } : {};
    assert.equal(guard({ ...undeclared, ...envelope }), false, '缺少来源关系必须拒绝');
    assert.equal(guard({ ...undeclared, ...envelope, sourceRelationship: 'independent' }), true);
    assert.equal(guard({ ...undeclared, ...envelope, sourceRelationship: 'revision', previousRevisionId: id }), true);
    for (const invalid of [{ sourceRelationship: '' }, { sourceRelationship: ['independent'] }, { sourceRelationship: 'independent', previousRevisionId: id }, { sourceRelationship: 'revision', previousRevisionId: null }, { sourceRelationship: 'revision', previousRevisionId: 'not-a-revision' }]) {
      assert.equal(guard({ ...undeclared, ...envelope, ...invalid }), false);
    }
  }
});

test('工作簿原始单元格保留公式缓存和日期数字类型，拒绝越界及伪枚举', () => {
  const cell = { columnIndex: 1, type: 'number', value: 60, formula: 'SUM(A1:A2)', numberFormat: 'yyyy-mm-dd' };
  assert.equal(c.isSpreadsheetCell(cell), true);
  assert.equal(c.isSpreadsheetCell({ columnIndex: 1, type: 'blank', value: null, formula: 'A1' }), true);
  for (const invalid of [{ ...cell, type: ['number'] }, { ...cell, value: Infinity }, { ...cell, columnIndex: 65 }, { ...cell, formula: '中'.repeat(11000) }, { ...cell, url: 'https://example.invalid' }]) assert.equal(c.isSpreadsheetCell(invalid), false);
  const book = { fileFormat: 'xlsx', parserVersion: 'sheetjs-ce-0.20.3', dateSystem: '1904', sheets: [{ name: '库存', rows: [{ rowIndex: 1, cells: [cell] }] }] };
  assert.equal(c.isParsedSpreadsheetWorkbook(book), true);
  assert.equal(c.isParsedSpreadsheetWorkbook({ ...book, sheets: [{ ...book.sheets[0], rows: [{ rowIndex: 20001, cells: [cell] }] }] }), false);
  assert.equal(c.isParsedSpreadsheetWorkbook({ ...book, sheets: [book.sheets[0], book.sheets[0]] }), false);
});

test('公开来源只展示受限文件名与SHA，不携带私有路径或工作簿内容', () => {
  assert.equal(c.isSpreadsheetWorkbookSource(source), true);
  for (const displayName of ['/private/合成.xlsx', '..', 'a\\b.xls', 'a\0b.xls']) assert.equal(c.isSpreadsheetWorkbookSource({ ...source, displayName }), false);
  assert.equal(c.isSpreadsheetWorkbookSource({ ...source, absolutePath: '/private/合成.xlsx' }), false);
  assert.equal(c.isSpreadsheetWorkbookSource({ ...source, workbookHash: 'wrong' }), false);
});

test('导入Unknown可读且不伪造品牌，普通receive仍严格', () => {
  assert.equal(c.isImportedCollectionDescriptor(unknown), true);
  assert.equal(c.isCollectionDescriptor(unknown), false);
  assert.equal(c.isImportedCollectionDescriptor({ ...unknown, identification: 'verified', edition: '虚构' }), false);
  assert.equal(c.isCollectionReceiveRequest({ commandId, model: unknown, lengthMinutes: null, quantities: { sealedBlank: 0, openedBlank: 0, legacyUsed: 3, unclassified: 7 } }), false);
  for (const field of ['format', 'tapeType', 'identification'] as const) {
    const known = { ...unknown, brand: '合成', name: '合成', identification: 'unidentified' };
    assert.equal(c.isImportedCollectionDescriptor({ ...known, [field]: [known[field]] }), false);
  }
});

test('Lot读取兼容旧schema15，数量更正保留初始数与独立调整额', () => {
  const lot = { id, skuId: id, lengthMinutes: 60, quantityAcquired: 10, quantities: { sealedBlank: 0, openedBlank: 0, legacyUsed: 3, unclassified: 7 } };
  assert.equal(c.isCollectionLot(lot), true);
  assert.equal(c.isCollectionLot({ ...lot, quantityAdjustment: 2, quantities: { ...lot.quantities, unclassified: 9 } }), true);
  assert.equal(c.isCollectionLot({ ...lot, quantityAdjustment: -11 }), false);
  assert.equal(c.isCollectionLot({ ...lot, quantityAdjustment: 0.5 }), false);
  assert.equal(c.isCollectionLot({ ...lot, quantityAdjustment: 0, quantities: { ...lot.quantities, unclassified: 9 } }), false);
  const model = { ...unknown, id, collectorPolicy: 'normal', minimumSealedReserve: 0, revision: 1, lengths: [60], counts: { total: 10, sealedBlank: 0, openedBlank: 0, legacyUsed: 3, recorded: 0, reserved: 0, unavailable: 0, unknown: 7 } };
  assert.equal(c.isCollectionModel(model), true);
});

test('所有读取与内部回执响应严格校验，不把路径或完整原文写入outbox', () => {
  const summary = { totalRows: 1, newRows: 1, matchedRows: 0, changedRows: 0, ambiguousRows: 0, skippedRows: 0, invalidRows: 0, removedRows: 0, newQuantity: 10, legacyUsed: 3, unclassified: 7 };
  const revision = { id, sourceId: id, workbookHash: hash, sheetName: '库存', format: 'cassette', headerRow: 1, columns, previousRevisionId: null, sequence: 1, createdAt: source.createdAt, summary };
  const row = { rowIndex: 2, rawRowHash: hash, normalizedSignature: hash, normalized: { descriptor: unknown, versionCandidate: '', lengthMinutes: 60, quantity: 10, used: 3, price: null, purchaseDate: null, notes: '' }, match: 'new', previousRowId: null, issues: [{ code: 'UNKNOWN_METADATA' }], ready: true, candidates: [] };
  const page = <T>(items: T[]) => ({ items, offset: 0, limit: 25, total: items.length, hasMore: false });
  const preview = { sourceId: id, sheetName: '库存', previousRevisionId: null, baselineFingerprint: hash, summary, rows: page([row]), removedRows: page([]) };
  assert.equal(c.isSpreadsheetImportPreview(preview), true);
  assert.equal(c.isSpreadsheetImportPreview({ ...preview, summary: { ...summary, legacyUsed: 10 } }), false);
  assert.equal(c.isSpreadsheetImportPreview({ ...preview, rows: page([{ ...row, candidates: [{ revisionId: id, referenceId: 'ref-1', status: 'confirmed' }] }]) }), false);
  assert.equal(c.isSpreadsheetImportRevisionDetail({ revision, rows: page([{ ...row, id, action: 'created', lotId: id, modelId: id }]) }), true);
  const result = { revision, duplicate: false };
  assert.equal(c.isCommandOutboxDispatchResult({ command: 'spreadsheetImports.apply', result }), true);
  assert.equal(c.isCommandOutboxDispatchResult({ command: 'spreadsheetImports.apply', result: { ...result, rawWorkbook: 'synthetic' } }), false);
  assert.equal(c.isCommandOutboxDispatchResult({ command: 'spreadsheetImports.chooseWorkbook', result: null }), true);
  assert.equal(c.isCommandOutboxDispatchResult({ command: 'spreadsheetImports.chooseWorkbook', result: source }), true);
  for (const [command, value] of [['spreadsheetImports.registerWorkbook', source], ['spreadsheetImports.workbookReceipt', { source }]] as const) {
    const response = { version: 1, id, ok: true, result: value };
    assert.equal(c.validateIpcResponseForCommand(response, command).ok, false);
    assert.equal(c.validateIpcInternalResponseForCommand(response, command).ok, true);
    assert.equal(c.validateIpcInternalResponseForCommand({ ...response, result: { ...value, absolutePath: '/private/synthetic.xlsx' } }, command).ok, false);
  }
});

test('工作簿聚合预算与重复列身份不能被逐项合法值绕过', () => {
  const cell = { columnIndex: 1, type: 'string', value: 'x' };
  const book = { fileFormat: 'xlsx', parserVersion: 'sheetjs-ce-0.20.3', dateSystem: '1900', sheets: [{ name: '库存', rows: [{ rowIndex: 1, cells: [cell, cell] }] }] };
  assert.equal(c.isParsedSpreadsheetWorkbook(book), false);
  assert.equal(c.isSpreadsheetCell({ ...cell, value: '\uD800' }), false);
  assert.equal(c.isSpreadsheetCell({ ...cell, value: '😀\n\t' }), true);
  const largeRows = Array.from({ length: 10 }, (_, row) => ({ rowIndex: row + 1, cells: Array.from({ length: 64 }, (_, col) => ({ columnIndex: col + 1, type: 'string', value: 'x'.repeat(32768) })) }));
  assert.equal(c.isParsedSpreadsheetWorkbook({ ...book, sheets: [{ name: '库存', rows: largeRows }] }), false);
  assert.equal(c.isSpreadsheetPageRequest({ offset: 0, limit: 26 }), false);
  assert.equal(c.isApplySpreadsheetImportRequest({ ...plan, commandId, baselineFingerprint: hash, userConfirmed: true, decisions: [{ rowIndex: 2, action: 'match', previousRowId: id }] }), false);
});

test('计划必须显式逐行决定且人工对应一对一；不接受私有路径、重复行或同旧行多配', () => {
  assert.equal(c.isPreviewSpreadsheetImportRequest({ ...plan, page: { offset: 0, limit: 25 } }), true);
  const apply = { ...plan, commandId, baselineFingerprint: hash, userConfirmed: true };
  assert.equal(c.isApplySpreadsheetImportRequest(apply), true);
  for (const changed of [{ userConfirmed: false }, { baselineFingerprint: undefined }, { absolutePath: '/private/a' }, { columns: { ...columns, quantity: 65 } }, { decisions: [plan.decisions[0], plan.decisions[0]] }, { decisions: [{ rowIndex: 2, action: 'match' }] }, { decisions: [{ rowIndex: 2, action: 'match', previousRowId: id }, { rowIndex: 3, action: 'match', previousRowId: id }] }, { decisions: [{ rowIndex: 2, action: 'skip', formulaConfirmed: true }] }]) assert.equal(c.isApplySpreadsheetImportRequest({ ...apply, ...changed }), false);
});

test('普通outbox只有apply/adjust，原生选择special且回执内部受控', () => {
  const apply = { ...plan, commandId, baselineFingerprint: hash, userConfirmed: true };
  assert.equal(c.isCommandOutboxExecute({ datasetId: id, command: 'spreadsheetImports.apply', payload: apply }), true);
  assert.equal(c.isCommandOutboxRequest({ datasetId: id, command: 'spreadsheetImports.chooseWorkbook', payload: { commandId } }), true);
  assert.equal(c.isCommandOutboxExecute({ datasetId: id, command: 'spreadsheetImports.chooseWorkbook', payload: { commandId } }), false);
  assert.equal(c.validateIpcRequest({ version: 1, id, command: 'spreadsheetImports.preview', payload: { ...plan, page: { offset: 0, limit: 25 } } }).ok, true);
  assert.equal(c.validateIpcRequest({ version: 1, id, command: 'spreadsheetImports.registerWorkbook', payload: { commandId, absolutePath: '/private/synthetic.xlsx' } }).ok, true);
  const response = { version: 1, id, ok: true, result: source };
  assert.equal(c.validateIpcResponseForCommand(response, 'spreadsheetImports.registerWorkbook').ok, false);
});

test('独立数量更正要求Lot、余额指纹与确认，允许仅状态转移但不允许零更正', () => {
  const request = { commandId, revisionId: id, rowId: id, lotId: id, expectedBalanceFingerprint: hash, legacyUsedDelta: 1, unclassifiedDelta: -1, userConfirmed: true };
  assert.equal(c.isAdjustSpreadsheetInventoryRequest(request), true);
  for (const change of [{ userConfirmed: false }, { lotId: undefined }, { expectedBalanceFingerprint: undefined }, { legacyUsedDelta: 0, unclassifiedDelta: 0 }, { unclassifiedDelta: -10001 }, { legacyUsedDelta: 0.1 }]) assert.equal(c.isAdjustSpreadsheetInventoryRequest({ ...request, ...change }), false);
  const balance = { revisionId: id, rowId: id, lotId: id, modelId: id, legacyUsed: 3, unclassified: 9, quantityAcquired: 10, quantityAdjustment: 2, materializedCount: 0, balanceFingerprint: hash };
  assert.equal(c.isSpreadsheetAdjustmentBalance(balance), true);
  assert.equal(c.isSpreadsheetAdjustmentBalance({ ...balance, quantityAdjustment: 0 }), false);
});

test('两万行显式人工对应与公式复核可持久确认，只有apply获得3MiB预算', () => {
  const decisions = Array.from({ length: 20_000 }, (_, index) => ({ rowIndex: index + 1, action: 'match', previousRowId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, formulaConfirmed: true }));
  const payload = { ...plan, headerRow: 0, sourceRelationship: 'revision', previousRevisionId: id, decisions, commandId, baselineFingerprint: hash, userConfirmed: true };
  const request = { datasetId: id, command: 'spreadsheetImports.apply', payload };
  assert.equal(c.isApplySpreadsheetImportRequest(payload), true);
  assert.ok(Buffer.byteLength(JSON.stringify(request)) > c.MAX_COMMAND_OUTBOX_PAYLOAD_BYTES);
  assert.equal(c.MAX_COMMAND_OUTBOX_PAYLOAD_BYTES, 2 * 1024 * 1024);
  assert.equal(c.MAX_COMMAND_OUTBOX_SPREADSHEET_APPLY_BYTES, 3 * 1024 * 1024);
  assert.equal(c.MAX_COMMAND_OUTBOX_TOTAL_BYTES, 64 * 1024 * 1024);
  assert.equal(c.isCommandOutboxRequest(request), true);
  assert.equal(c.isCommandOutboxExecute(request), true);
  assert.equal(c.isCommandOutboxRequest({ ...request, payload: { ...payload, workbook: 'x'.repeat(3 * 1024 * 1024) } }), false);
  assert.equal(c.isCommandOutboxRequest({ ...request, payload: { ...payload, absolutePath: '/private/synthetic.xlsx' } }), false);
});
