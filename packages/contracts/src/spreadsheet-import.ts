import type { Page } from './library.js';
import { isCollectionId, isImportedCollectionDescriptor, type CollectionDescriptor, type CollectionFormat } from './collection.js';

export const MAX_SPREADSHEET_BYTES = 8 * 1024 * 1024;
export const MAX_SPREADSHEET_PARSED_BYTES = 16 * 1024 * 1024;
export const MAX_SPREADSHEET_CELL_BYTES = 32 * 1024;
export const MAX_SPREADSHEET_SHEETS = 32;
export const MAX_SPREADSHEET_ROWS = 20_000;
export const MAX_SPREADSHEET_COLUMNS = 64;
export const MAX_SPREADSHEET_CELLS = 250_000;
export const SPREADSHEET_PARSER_VERSION = 'sheetjs-ce-0.20.3' as const;
export interface SpreadsheetCell {
  columnIndex: number;
  type: 'blank' | 'string' | 'number' | 'boolean' | 'error';
  value: null | string | number | boolean;
  formula?: string;
  numberFormat?: string;
  displayText?: string;
}
/** 仅 Core 内部解析结果；日期仍保留原数字或文本，不执行公式。 */
export interface ParsedSpreadsheetWorkbook {
  fileFormat: 'xlsx' | 'xls';
  parserVersion: typeof SPREADSHEET_PARSER_VERSION;
  dateSystem: '1900' | '1904';
  sheets: Array<{ name: string; rows: Array<{ rowIndex: number; cells: SpreadsheetCell[] }> }>;
}
export interface SpreadsheetWorkbookSource {
  id: string; displayName: string; workbookHash: string;
  fileFormat: 'xlsx' | 'xls'; parserVersion: typeof SPREADSHEET_PARSER_VERSION;
  dateSystem: '1900' | '1904'; byteLength: number; createdAt: string;
  sheets: Array<{ name: string; rowCount: number; nonEmptyCellCount: number }>;
}
export interface SpreadsheetSourceRow { sourceId: string; sheetName: string; rowIndex: number; rawRowHash: string; cells: SpreadsheetCell[] }
export const SPREADSHEET_IMPORT_FIELDS = ['brand', 'model', 'edition', 'year', 'iec', 'length', 'quantity', 'price', 'purchaseDate', 'used', 'notes'] as const;
export type SpreadsheetImportField = typeof SPREADSHEET_IMPORT_FIELDS[number];
export type SpreadsheetColumnMapping = Record<SpreadsheetImportField, number | null>;
export interface SpreadsheetRowDecision { rowIndex: number; action: 'new' | 'match' | 'skip'; previousRowId?: string; formulaConfirmed?: true }
export interface SpreadsheetImportPlan {
  sourceId: string; sheetName: string; format: CollectionFormat;
  /** 用户明确声明独立来源或承接旧修订，不能由空旧修订默认推断。 */
  sourceRelationship: 'independent' | 'revision';
  /** 0 表示无表头；其余值表示忽略该行及之前的行。 */
  headerRow: number; columns: SpreadsheetColumnMapping; previousRevisionId: string | null;
  decisions: SpreadsheetRowDecision[]; catalogRevisionId?: string;
}
export interface SpreadsheetPageRequest { offset: number; limit: number }
export interface SpreadsheetIdRequest { id: string }
export interface ChooseSpreadsheetWorkbookRequest { commandId: string }
/** 只允许 Main 原生选择后发往 Core；不进入公开 outbox DTO。 */
export interface RegisterSpreadsheetWorkbookRequest extends ChooseSpreadsheetWorkbookRequest { absolutePath: string }
export interface SpreadsheetWorkbookReceipt { source: SpreadsheetWorkbookSource | null }
export interface SpreadsheetSourceRowsRequest { sourceId: string; sheetName: string; page: SpreadsheetPageRequest }
export interface PreviewSpreadsheetImportRequest extends SpreadsheetImportPlan { page: SpreadsheetPageRequest }
export interface ApplySpreadsheetImportRequest extends SpreadsheetImportPlan { commandId: string; baselineFingerprint: string; userConfirmed: true }
export interface SpreadsheetImportRevisionRequest { revisionId: string; page: SpreadsheetPageRequest }
export interface SpreadsheetAdjustmentPreviewRequest { revisionId: string; rowId: string }
export interface SpreadsheetAdjustmentsRequest { revisionId: string; rowId?: string; page: SpreadsheetPageRequest }
export interface SpreadsheetNormalizedRow {
  descriptor: CollectionDescriptor; versionCandidate: string; lengthMinutes: number | null;
  quantity: number | null; used: number | null; price: SpreadsheetCell | null; purchaseDate: SpreadsheetCell | null; notes: string;
}
export const SPREADSHEET_IMPORT_ISSUE_CODES = ['UNKNOWN_METADATA', 'INVALID_METADATA', 'INVALID_QUANTITY', 'INVALID_USED', 'INVALID_LENGTH', 'INVALID_YEAR', 'INVALID_DATE', 'FORMULA_REVIEW_REQUIRED', 'FORMULA_CACHE_MISSING', 'CELL_ERROR', 'AMBIGUOUS_ROW', 'UNCONFIRMED_NEW_ROW'] as const;
export type SpreadsheetImportIssueCode = typeof SPREADSHEET_IMPORT_ISSUE_CODES[number];
export interface SpreadsheetImportIssue { code: SpreadsheetImportIssueCode; field?: SpreadsheetImportField }
export interface SpreadsheetPreviewRow {
  rowIndex: number; rawRowHash: string; normalizedSignature: string; normalized: SpreadsheetNormalizedRow;
  match: 'new' | 'matched' | 'changed' | 'ambiguous' | 'skipped' | 'invalid'; previousRowId: string | null;
  issues: SpreadsheetImportIssue[]; ready: boolean; candidates: Array<{ revisionId: string; referenceId: string }>;
}
export interface SpreadsheetImportSummary {
  totalRows: number; newRows: number; matchedRows: number; changedRows: number; ambiguousRows: number;
  skippedRows: number; invalidRows: number; removedRows: number; newQuantity: number; legacyUsed: number; unclassified: number;
}
export interface SpreadsheetRemovedRow { previousRowId: string; rowIndex: number; lotId: string | null; modelId: string | null }
export interface SpreadsheetImportPreview {
  sourceId: string; sheetName: string; previousRevisionId: string | null; baselineFingerprint: string;
  summary: SpreadsheetImportSummary; rows: Page<SpreadsheetPreviewRow>; removedRows: Page<SpreadsheetRemovedRow>;
}
export interface SpreadsheetImportRevision {
  id: string; sourceId: string; workbookHash: string; sheetName: string; format: CollectionFormat;
  headerRow: number; columns: SpreadsheetColumnMapping; previousRevisionId: string | null; catalogRevisionId?: string;
  sequence: number; createdAt: string; summary: SpreadsheetImportSummary;
}
export interface SpreadsheetImportResult { revision: SpreadsheetImportRevision; duplicate: boolean }
export interface SpreadsheetImportedRow extends SpreadsheetPreviewRow {
  id: string; action: 'created' | 'linked' | 'suggested' | 'skipped' | 'invalid'; lotId: string | null; modelId: string | null;
}
export interface SpreadsheetImportRevisionDetail { revision: SpreadsheetImportRevision; rows: Page<SpreadsheetImportedRow> }
export interface SpreadsheetAdjustmentBalance {
  revisionId: string; rowId: string; lotId: string; modelId: string; legacyUsed: number; unclassified: number;
  quantityAcquired: number; quantityAdjustment: number; materializedCount: number; balanceFingerprint: string;
}
export interface AdjustSpreadsheetInventoryRequest {
  commandId: string; revisionId: string; rowId: string; lotId: string; expectedBalanceFingerprint: string;
  legacyUsedDelta: number; unclassifiedDelta: number; userConfirmed: true;
}
export interface SpreadsheetInventoryAdjustment {
  id: string; revisionId: string; rowId: string; lotId: string;
  before: SpreadsheetAdjustmentBalance; after: SpreadsheetAdjustmentBalance; createdAt: string;
}
export type SpreadsheetSourcePage = Page<SpreadsheetWorkbookSource>;
export type SpreadsheetSourceRowsPage = Page<SpreadsheetSourceRow>;
export type SpreadsheetImportHistory = Page<SpreadsheetImportRevision>;
export type SpreadsheetAdjustmentsPage = Page<SpreadsheetInventoryAdjustment>;
export interface SpreadsheetImportPublicApi {
  chooseSpreadsheetWorkbook(request: ChooseSpreadsheetWorkbookRequest): Promise<SpreadsheetWorkbookSource | null>;
  listSpreadsheetSources(request: SpreadsheetPageRequest): Promise<SpreadsheetSourcePage>;
  getSpreadsheetSource(request: SpreadsheetIdRequest): Promise<SpreadsheetWorkbookSource>;
  getSpreadsheetSourceRows(request: SpreadsheetSourceRowsRequest): Promise<SpreadsheetSourceRowsPage>;
  previewSpreadsheetImport(request: PreviewSpreadsheetImportRequest): Promise<SpreadsheetImportPreview>;
  applySpreadsheetImport(request: ApplySpreadsheetImportRequest): Promise<SpreadsheetImportResult>;
  getSpreadsheetImportRevision(request: SpreadsheetImportRevisionRequest): Promise<SpreadsheetImportRevisionDetail>;
  listSpreadsheetImportHistory(request: SpreadsheetPageRequest): Promise<SpreadsheetImportHistory>;
  previewSpreadsheetAdjustment(request: SpreadsheetAdjustmentPreviewRequest): Promise<SpreadsheetAdjustmentBalance>;
  adjustSpreadsheetInventory(request: AdjustSpreadsheetInventoryRequest): Promise<SpreadsheetInventoryAdjustment>;
  listSpreadsheetAdjustments(request: SpreadsheetAdjustmentsRequest): Promise<SpreadsheetAdjustmentsPage>;
}

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]) => Object.keys(v).every(k => allowed.includes(k));
const integer = (v: unknown, min = 0, max = 1_000_000): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const oneOf = <T extends string>(v: unknown, options: readonly T[]): v is T => typeof v === 'string' && options.includes(v as T);
const utf8 = new TextEncoder();
const cellText = (v: unknown): v is string => typeof v === 'string' && !/[\uD800-\uDFFF]/u.test(v) && utf8.encode(v).byteLength <= MAX_SPREADSHEET_CELL_BYTES;
const label = (v: unknown, max = 128): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\uD800-\uDFFF]/u.test(v) && !/[\u0000-\u001f\u007f]/u.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/u.test(v);
const isSourcePrivatePath = (v: unknown): v is string => typeof v === 'string' && v.startsWith('/') && v.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(v);
const nullableId = (v: unknown): v is string | null => v === null || isCollectionId(v);
const timestamp = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const jsonBudget = (v: unknown): boolean => { try { return utf8.encode(JSON.stringify(v)).byteLength <= MAX_SPREADSHEET_PARSED_BYTES; } catch { return false; } };
const unique = <T>(items: readonly T[]) => new Set(items).size === items.length;
const rowIndex = (v: unknown): v is number => integer(v, 1, MAX_SPREADSHEET_ROWS);
const cells = (v: unknown): v is SpreadsheetCell[] => Array.isArray(v) && v.length <= MAX_SPREADSHEET_COLUMNS && v.every(isSpreadsheetCell) && unique(v.map(c => c.columnIndex));

export function isSpreadsheetCell(v: unknown): v is SpreadsheetCell {
  if (!record(v) || !keys(v, ['columnIndex', 'type', 'value', 'formula', 'numberFormat', 'displayText']) || !integer(v.columnIndex, 1, MAX_SPREADSHEET_COLUMNS)) return false;
  if (![v.formula, v.numberFormat, v.displayText].every(x => x === undefined || cellText(x))) return false;
  return (v.type === 'blank' && v.value === null) || ((v.type === 'string' || v.type === 'error') && cellText(v.value))
    || (v.type === 'number' && typeof v.value === 'number' && Number.isFinite(v.value)) || (v.type === 'boolean' && typeof v.value === 'boolean');
}
export function isParsedSpreadsheetWorkbook(v: unknown): v is ParsedSpreadsheetWorkbook {
  if (!record(v) || !keys(v, ['fileFormat', 'parserVersion', 'dateSystem', 'sheets']) || !oneOf(v.fileFormat, ['xlsx', 'xls']) || v.parserVersion !== SPREADSHEET_PARSER_VERSION || !oneOf(v.dateSystem, ['1900', '1904']) || !Array.isArray(v.sheets) || v.sheets.length < 1 || v.sheets.length > MAX_SPREADSHEET_SHEETS) return false;
  let count = 0;
  for (const sheet of v.sheets) {
    if (!record(sheet) || !keys(sheet, ['name', 'rows']) || !label(sheet.name) || !Array.isArray(sheet.rows) || sheet.rows.length > MAX_SPREADSHEET_ROWS) return false;
    const seen = new Set<number>();
    for (const row of sheet.rows) {
      if (!record(row) || !keys(row, ['rowIndex', 'cells']) || !rowIndex(row.rowIndex) || seen.has(row.rowIndex) || !cells(row.cells)) return false;
      seen.add(row.rowIndex);
      count += row.cells.filter(c => c.type !== 'blank' || c.formula !== undefined).length;
      if (count > MAX_SPREADSHEET_CELLS) return false;
    }
  }
  return unique(v.sheets.map(s => (s as { name: string }).name)) && jsonBudget(v);
}
export function isSpreadsheetWorkbookSource(v: unknown): v is SpreadsheetWorkbookSource {
  return record(v) && keys(v, ['id', 'displayName', 'workbookHash', 'fileFormat', 'parserVersion', 'dateSystem', 'byteLength', 'createdAt', 'sheets'])
    && isCollectionId(v.id) && label(v.displayName, 255) && !/[\\/]/u.test(v.displayName) && !['.', '..'].includes(v.displayName)
    && hash(v.workbookHash) && oneOf(v.fileFormat, ['xlsx', 'xls']) && v.parserVersion === SPREADSHEET_PARSER_VERSION && oneOf(v.dateSystem, ['1900', '1904'])
    && integer(v.byteLength, 1, MAX_SPREADSHEET_BYTES) && timestamp(v.createdAt) && Array.isArray(v.sheets) && v.sheets.length > 0 && v.sheets.length <= MAX_SPREADSHEET_SHEETS
    && v.sheets.every(s => record(s) && keys(s, ['name', 'rowCount', 'nonEmptyCellCount']) && label(s.name) && integer(s.rowCount, 0, MAX_SPREADSHEET_ROWS) && integer(s.nonEmptyCellCount, 0, MAX_SPREADSHEET_CELLS) && s.nonEmptyCellCount <= s.rowCount * MAX_SPREADSHEET_COLUMNS)
    && unique(v.sheets.map(s => s.name)) && v.sheets.reduce((n, s) => n + s.nonEmptyCellCount, 0) <= MAX_SPREADSHEET_CELLS;
}
export function isSpreadsheetSourceRow(v: unknown): v is SpreadsheetSourceRow {
  return record(v) && keys(v, ['sourceId', 'sheetName', 'rowIndex', 'rawRowHash', 'cells']) && isCollectionId(v.sourceId) && label(v.sheetName) && rowIndex(v.rowIndex) && hash(v.rawRowHash) && cells(v.cells);
}
export function isSpreadsheetColumnMapping(v: unknown): v is SpreadsheetColumnMapping {
  return record(v) && keys(v, SPREADSHEET_IMPORT_FIELDS) && SPREADSHEET_IMPORT_FIELDS.every(k => v[k] === null || integer(v[k], 1, MAX_SPREADSHEET_COLUMNS));
}
export function isSpreadsheetRowDecision(v: unknown): v is SpreadsheetRowDecision {
  return record(v) && keys(v, ['rowIndex', 'action', 'previousRowId', 'formulaConfirmed']) && rowIndex(v.rowIndex) && oneOf(v.action, ['new', 'match', 'skip'])
    && (v.action === 'match' ? isCollectionId(v.previousRowId) : v.previousRowId === undefined)
    && (v.formulaConfirmed === undefined || (v.formulaConfirmed === true && v.action !== 'skip'));
}
const planKeys = ['sourceId', 'sheetName', 'format', 'sourceRelationship', 'headerRow', 'columns', 'previousRevisionId', 'decisions', 'catalogRevisionId'];
function planFields(v: Record<string, unknown>): boolean {
  return isCollectionId(v.sourceId) && label(v.sheetName) && oneOf(v.format, ['cassette', 'dat']) && integer(v.headerRow, 0, MAX_SPREADSHEET_ROWS - 1)
    && isSpreadsheetColumnMapping(v.columns) && (v.sourceRelationship === 'independent' ? v.previousRevisionId === null : v.sourceRelationship === 'revision' && isCollectionId(v.previousRevisionId)) && (v.catalogRevisionId === undefined || isCollectionId(v.catalogRevisionId))
    && Array.isArray(v.decisions) && v.decisions.length <= MAX_SPREADSHEET_ROWS && v.decisions.every(isSpreadsheetRowDecision)
    && v.decisions.every(d => d.rowIndex > (v.headerRow as number) && (d.action !== 'match' || v.previousRevisionId !== null))
    && unique(v.decisions.map(d => d.rowIndex)) && unique(v.decisions.filter(d => d.action === 'match').map(d => d.previousRowId));
}
export function isSpreadsheetPageRequest(v: unknown): v is SpreadsheetPageRequest { return record(v) && keys(v, ['offset', 'limit']) && integer(v.offset) && integer(v.limit, 1, 25); }
export function isSpreadsheetImportPlan(v: unknown): v is SpreadsheetImportPlan { return record(v) && keys(v, planKeys) && planFields(v); }
export function isSpreadsheetIdRequest(v: unknown): v is SpreadsheetIdRequest { return record(v) && keys(v, ['id']) && isCollectionId(v.id); }
export function isChooseSpreadsheetWorkbookRequest(v: unknown): v is ChooseSpreadsheetWorkbookRequest { return record(v) && keys(v, ['commandId']) && isCollectionId(v.commandId); }
export function isRegisterSpreadsheetWorkbookRequest(v: unknown): v is RegisterSpreadsheetWorkbookRequest { return record(v) && keys(v, ['commandId', 'absolutePath']) && isCollectionId(v.commandId) && isSourcePrivatePath(v.absolutePath); }
export function isSpreadsheetWorkbookReceipt(v: unknown): v is SpreadsheetWorkbookReceipt { return record(v) && keys(v, ['source']) && (v.source === null || isSpreadsheetWorkbookSource(v.source)); }
export function isSpreadsheetSourceRowsRequest(v: unknown): v is SpreadsheetSourceRowsRequest { return record(v) && keys(v, ['sourceId', 'sheetName', 'page']) && isCollectionId(v.sourceId) && label(v.sheetName) && isSpreadsheetPageRequest(v.page); }
export function isPreviewSpreadsheetImportRequest(v: unknown): v is PreviewSpreadsheetImportRequest { return record(v) && keys(v, [...planKeys, 'page']) && planFields(v) && isSpreadsheetPageRequest(v.page); }
export function isApplySpreadsheetImportRequest(v: unknown): v is ApplySpreadsheetImportRequest { return record(v) && keys(v, [...planKeys, 'commandId', 'baselineFingerprint', 'userConfirmed']) && planFields(v) && isCollectionId(v.commandId) && hash(v.baselineFingerprint) && v.userConfirmed === true; }
export function isSpreadsheetImportRevisionRequest(v: unknown): v is SpreadsheetImportRevisionRequest { return record(v) && keys(v, ['revisionId', 'page']) && isCollectionId(v.revisionId) && isSpreadsheetPageRequest(v.page); }
export function isSpreadsheetAdjustmentPreviewRequest(v: unknown): v is SpreadsheetAdjustmentPreviewRequest { return record(v) && keys(v, ['revisionId', 'rowId']) && isCollectionId(v.revisionId) && isCollectionId(v.rowId); }
export function isSpreadsheetAdjustmentsRequest(v: unknown): v is SpreadsheetAdjustmentsRequest { return record(v) && keys(v, ['revisionId', 'rowId', 'page']) && isCollectionId(v.revisionId) && (v.rowId === undefined || isCollectionId(v.rowId)) && isSpreadsheetPageRequest(v.page); }
export function isSpreadsheetNormalizedRow(v: unknown): v is SpreadsheetNormalizedRow {
  return record(v) && keys(v, ['descriptor', 'versionCandidate', 'lengthMinutes', 'quantity', 'used', 'price', 'purchaseDate', 'notes']) && isImportedCollectionDescriptor(v.descriptor)
    && v.descriptor.identification !== 'verified' && cellText(v.versionCandidate) && (v.lengthMinutes === null || integer(v.lengthMinutes, 1, 360))
    && (v.quantity === null || integer(v.quantity, 0, 10_000)) && (v.used === null || integer(v.used, 0, 10_000))
    && (v.price === null || isSpreadsheetCell(v.price)) && (v.purchaseDate === null || isSpreadsheetCell(v.purchaseDate)) && cellText(v.notes);
}
export function isSpreadsheetImportIssue(v: unknown): v is SpreadsheetImportIssue { return record(v) && keys(v, ['code', 'field']) && oneOf(v.code, SPREADSHEET_IMPORT_ISSUE_CODES) && (v.field === undefined || oneOf(v.field, SPREADSHEET_IMPORT_FIELDS)); }
const previewRowKeys = ['rowIndex', 'rawRowHash', 'normalizedSignature', 'normalized', 'match', 'previousRowId', 'issues', 'ready', 'candidates'];
function previewRowFields(v: Record<string, unknown>): boolean {
  return rowIndex(v.rowIndex) && hash(v.rawRowHash) && hash(v.normalizedSignature) && isSpreadsheetNormalizedRow(v.normalized)
    && oneOf(v.match, ['new', 'matched', 'changed', 'ambiguous', 'skipped', 'invalid']) && nullableId(v.previousRowId)
    && Array.isArray(v.issues) && v.issues.length <= 64 && v.issues.every(isSpreadsheetImportIssue) && typeof v.ready === 'boolean'
    && Array.isArray(v.candidates) && v.candidates.length <= 500 && v.candidates.every(c => record(c) && keys(c, ['revisionId', 'referenceId']) && isCollectionId(c.revisionId) && typeof c.referenceId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/u.test(c.referenceId));
}
export function isSpreadsheetPreviewRow(v: unknown): v is SpreadsheetPreviewRow { return record(v) && keys(v, previewRowKeys) && previewRowFields(v); }
const summaryKeys = ['totalRows', 'newRows', 'matchedRows', 'changedRows', 'ambiguousRows', 'skippedRows', 'invalidRows', 'removedRows', 'newQuantity', 'legacyUsed', 'unclassified'] as const;
export function isSpreadsheetImportSummary(v: unknown): v is SpreadsheetImportSummary {
  if (!record(v) || !keys(v, summaryKeys) || !summaryKeys.every(k => integer(v[k], 0, ['newQuantity', 'legacyUsed', 'unclassified'].includes(k) ? MAX_SPREADSHEET_ROWS * 10_000 : MAX_SPREADSHEET_ROWS))) return false;
  const s = v as unknown as SpreadsheetImportSummary;
  return s.totalRows === s.newRows + s.matchedRows + s.changedRows + s.ambiguousRows + s.skippedRows + s.invalidRows && s.newQuantity === s.legacyUsed + s.unclassified;
}
export function isSpreadsheetRemovedRow(v: unknown): v is SpreadsheetRemovedRow { return record(v) && keys(v, ['previousRowId', 'rowIndex', 'lotId', 'modelId']) && isCollectionId(v.previousRowId) && rowIndex(v.rowIndex) && nullableId(v.lotId) && nullableId(v.modelId); }
function page<T>(v: unknown, guard: (v: unknown) => v is T): v is Page<T> {
  return record(v) && keys(v, ['items', 'total', 'offset', 'limit', 'hasMore']) && integer(v.total) && integer(v.offset) && integer(v.limit, 1, 25)
    && Array.isArray(v.items) && v.items.length <= v.limit && v.items.length <= v.total && v.items.every(guard) && v.hasMore === (v.offset + v.items.length < v.total) && jsonBudget(v);
}
export function isSpreadsheetImportPreview(v: unknown): v is SpreadsheetImportPreview { return record(v) && keys(v, ['sourceId', 'sheetName', 'previousRevisionId', 'baselineFingerprint', 'summary', 'rows', 'removedRows']) && isCollectionId(v.sourceId) && label(v.sheetName) && nullableId(v.previousRevisionId) && hash(v.baselineFingerprint) && isSpreadsheetImportSummary(v.summary) && page(v.rows, isSpreadsheetPreviewRow) && page(v.removedRows, isSpreadsheetRemovedRow); }
export function isSpreadsheetImportRevision(v: unknown): v is SpreadsheetImportRevision {
  return record(v) && keys(v, ['id', 'sourceId', 'workbookHash', 'sheetName', 'format', 'headerRow', 'columns', 'previousRevisionId', 'catalogRevisionId', 'sequence', 'createdAt', 'summary'])
    && isCollectionId(v.id) && isCollectionId(v.sourceId) && hash(v.workbookHash) && label(v.sheetName) && oneOf(v.format, ['cassette', 'dat']) && integer(v.headerRow, 0, MAX_SPREADSHEET_ROWS - 1) && isSpreadsheetColumnMapping(v.columns)
    && nullableId(v.previousRevisionId) && (v.catalogRevisionId === undefined || isCollectionId(v.catalogRevisionId)) && integer(v.sequence, 1) && timestamp(v.createdAt) && isSpreadsheetImportSummary(v.summary);
}
export function isSpreadsheetImportResult(v: unknown): v is SpreadsheetImportResult { return record(v) && keys(v, ['revision', 'duplicate']) && isSpreadsheetImportRevision(v.revision) && typeof v.duplicate === 'boolean'; }
export function isSpreadsheetImportedRow(v: unknown): v is SpreadsheetImportedRow { return record(v) && keys(v, [...previewRowKeys, 'id', 'action', 'lotId', 'modelId']) && previewRowFields(v) && isCollectionId(v.id) && oneOf(v.action, ['created', 'linked', 'suggested', 'skipped', 'invalid']) && nullableId(v.lotId) && nullableId(v.modelId) && (v.action !== 'created' || (isCollectionId(v.lotId) && isCollectionId(v.modelId))); }
export function isSpreadsheetImportRevisionDetail(v: unknown): v is SpreadsheetImportRevisionDetail { return record(v) && keys(v, ['revision', 'rows']) && isSpreadsheetImportRevision(v.revision) && page(v.rows, isSpreadsheetImportedRow); }
export function isSpreadsheetAdjustmentBalance(v: unknown): v is SpreadsheetAdjustmentBalance {
  return record(v) && keys(v, ['revisionId', 'rowId', 'lotId', 'modelId', 'legacyUsed', 'unclassified', 'quantityAcquired', 'quantityAdjustment', 'materializedCount', 'balanceFingerprint'])
    && ['revisionId', 'rowId', 'lotId', 'modelId'].every(k => isCollectionId(v[k])) && integer(v.legacyUsed) && integer(v.unclassified) && integer(v.quantityAcquired, 1)
    && integer(v.quantityAdjustment, -1_000_000, 1_000_000) && integer(v.materializedCount) && hash(v.balanceFingerprint)
    && v.quantityAcquired + v.quantityAdjustment === v.legacyUsed + v.unclassified + v.materializedCount;
}
export function isAdjustSpreadsheetInventoryRequest(v: unknown): v is AdjustSpreadsheetInventoryRequest {
  return record(v) && keys(v, ['commandId', 'revisionId', 'rowId', 'lotId', 'expectedBalanceFingerprint', 'legacyUsedDelta', 'unclassifiedDelta', 'userConfirmed'])
    && ['commandId', 'revisionId', 'rowId', 'lotId'].every(k => isCollectionId(v[k])) && hash(v.expectedBalanceFingerprint)
    && integer(v.legacyUsedDelta, -10_000, 10_000) && integer(v.unclassifiedDelta, -10_000, 10_000) && (v.legacyUsedDelta !== 0 || v.unclassifiedDelta !== 0) && v.userConfirmed === true;
}
export function isSpreadsheetInventoryAdjustment(v: unknown): v is SpreadsheetInventoryAdjustment {
  return record(v) && keys(v, ['id', 'revisionId', 'rowId', 'lotId', 'before', 'after', 'createdAt']) && ['id', 'revisionId', 'rowId', 'lotId'].every(k => isCollectionId(v[k]))
    && isSpreadsheetAdjustmentBalance(v.before) && isSpreadsheetAdjustmentBalance(v.after) && timestamp(v.createdAt)
    && v.before.revisionId === v.revisionId && v.after.revisionId === v.revisionId && v.before.rowId === v.rowId && v.after.rowId === v.rowId && v.before.lotId === v.lotId && v.after.lotId === v.lotId
    && v.before.modelId === v.after.modelId && v.before.quantityAcquired === v.after.quantityAcquired && v.before.materializedCount === v.after.materializedCount;
}
export function isSpreadsheetSourcePage(v: unknown): v is SpreadsheetSourcePage { return page(v, isSpreadsheetWorkbookSource); }
export function isSpreadsheetSourceRowsPage(v: unknown): v is SpreadsheetSourceRowsPage { return page(v, isSpreadsheetSourceRow); }
export function isSpreadsheetImportHistory(v: unknown): v is SpreadsheetImportHistory { return page(v, isSpreadsheetImportRevision); }
export function isSpreadsheetAdjustmentsPage(v: unknown): v is SpreadsheetAdjustmentsPage { return page(v, isSpreadsheetInventoryAdjustment); }
