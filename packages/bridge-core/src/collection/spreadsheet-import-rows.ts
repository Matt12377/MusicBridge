import { createHash } from 'node:crypto';
import { MAX_SPREADSHEET_CELL_BYTES } from '@music-bridge/contracts';
import type { SpreadsheetCell, SpreadsheetImportPlan, SpreadsheetNormalizedRow, SpreadsheetPreviewRow, SpreadsheetSourceRow } from '@music-bridge/contracts';

export function spreadsheetCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(spreadsheetCanonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${spreadsheetCanonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export const spreadsheetFingerprint = (value: unknown): string => createHash('sha256').update(spreadsheetCanonical(value)).digest('hex');
const normalizedText = (value: string): string => value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
const text = (cell: SpreadsheetCell | null): string => cell === null || cell.value === null || cell.type === 'error' ? '' : normalizedText(String(cell.value));
const number = (cell: SpreadsheetCell | null): number | null => {
  if (cell?.type === 'number' && typeof cell.value === 'number') return cell.value;
  const value = cell?.type === 'string' ? text(cell) : '';
  return /^[+]?[0-9]+(?:\.0+)?$/u.test(value) ? Number(value) : null;
};
type Field = keyof SpreadsheetImportPlan['columns'];
type Issue = SpreadsheetPreviewRow['issues'][number];
export interface StoredSpreadsheetImportRow extends SpreadsheetPreviewRow {
  id: string; action: 'created' | 'linked' | 'suggested' | 'skipped' | 'invalid'; lotId: string | null; modelId: string | null;
}

export function normalizeSpreadsheetRow(row: SpreadsheetSourceRow, plan: SpreadsheetImportPlan, dateSystem: '1900' | '1904', formulaConfirmed: boolean) {
  const byColumn = new Map(row.cells.map(cell => [cell.columnIndex, cell]));
  const get = (field: Field): SpreadsheetCell | null => { const column = plan.columns[field]; return column === null ? null : byColumn.get(column) ?? null; };
  const issues: Issue[] = [];
  const issue = (code: Issue['code'], field?: Field) => { if (!issues.some(value => value.code === code && value.field === field)) issues.push({ code, ...(field ? { field } : {}) }); };
  for (const field of Object.keys(plan.columns) as Field[]) {
    const cell = get(field); if (cell?.type === 'error') issue('CELL_ERROR', field);
    if ((field === 'quantity' || field === 'used') && cell?.formula !== undefined) {
      if (cell.type === 'blank' || cell.type === 'error' || cell.value === null) issue('FORMULA_CACHE_MISSING', field);
      else if (!formulaConfirmed) issue('FORMULA_REVIEW_REQUIRED', field);
    }
  }
  // 不将无法成为有效型号的原文截断入库；原始单元格仍由来源账本完整保存。
  const metadata = (field: 'brand' | 'model' | 'edition' | 'notes'): string => {
    const sourceCell = get(field);
    // 先检查原文，避免 trim/空白折叠把品牌型号中的控制字符变成合法空格。
    if ((field === 'brand' || field === 'model') && typeof sourceCell?.value === 'string' && /[\u0000-\u001f\u007f]/u.test(sourceCell.value)) { issue('INVALID_METADATA', field); return ''; }
    const value = text(sourceCell);
    if ((field === 'brand' || field === 'model') && (value.length > 120 || /[\u0000-\u001f\u007f]/u.test(value)) || Buffer.byteLength(value) > MAX_SPREADSHEET_CELL_BYTES) { issue('INVALID_METADATA', field); return ''; }
    return value;
  };
  const brand = metadata('brand'), name = metadata('model'), versionCandidate = metadata('edition'), notes = metadata('notes');
  if (!brand) issue('UNKNOWN_METADATA', 'brand'); if (!name) issue('UNKNOWN_METADATA', 'model'); if (!versionCandidate) issue('UNKNOWN_METADATA', 'edition');
  let year = number(get('year')); if (year !== null && (!Number.isInteger(year) || year < 1900 || year > 2200) || text(get('year')) && year === null) { year = null; issue('INVALID_YEAR', 'year'); }
  let lengthMinutes = number(get('length')); if (lengthMinutes !== null && (!Number.isInteger(lengthMinutes) || lengthMinutes < 1 || lengthMinutes > 360) || text(get('length')) && lengthMinutes === null) { lengthMinutes = null; issue('INVALID_LENGTH', 'length'); }
  let quantity = number(get('quantity')), used = number(get('used'));
  if (quantity === null || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 10_000) { quantity = null; issue('INVALID_QUANTITY', 'quantity'); }
  if (used !== null && (!Number.isSafeInteger(used) || used < 0 || quantity === null || used > quantity) || text(get('used')) && used === null) { used = null; issue('INVALID_USED', 'used'); }
  const date = get('purchaseDate');
  if (date && date.value !== null) {
    if (date.type === 'number') {
      if (typeof date.value !== 'number' || date.value < 0 || date.value > (dateSystem === '1900' ? 2_958_465 : 2_957_003) || dateSystem === '1900' && Math.floor(date.value) === 60) issue('INVALID_DATE', 'purchaseDate');
    } else if (date.type === 'string') {
      const value = text(date), parsed = /^\d{4}-\d{2}-\d{2}$/u.test(value) ? new Date(`${value}T00:00:00.000Z`) : null;
      if (!parsed || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) issue('INVALID_DATE', 'purchaseDate');
    } else issue('INVALID_DATE', 'purchaseDate');
  }
  const iec = text(get('iec')).toUpperCase(), tapeType = plan.format === 'dat' ? 'dat' : ['I', 'II', 'III', 'IV'].includes(iec) ? iec as 'I' | 'II' | 'III' | 'IV' : 'unknown';
  const normalized: SpreadsheetNormalizedRow = {
    descriptor: { brand, name, edition: '', year, format: plan.format, tapeType, identification: brand || name ? 'partial' : 'unidentified' },
    versionCandidate, lengthMinutes, quantity, used, price: structuredClone(get('price')), purchaseDate: structuredClone(date), notes,
  };
  // 对应签名只表达规范后的内容；行号、来源ID和人工决策不参与内容身份。
  const signatureValue = { ...normalized, descriptor: { ...normalized.descriptor, brand: brand.toLowerCase(), name: name.toLowerCase() }, versionCandidate: versionCandidate.toLowerCase() };
  return { normalized, issues, normalizedSignature: spreadsheetFingerprint(signatureValue), valid: !issues.some(value => value.code !== 'UNKNOWN_METADATA') };
}

/** 唯一内容只能给出一对一对应；重复行即使重排后剩一个候选，也不自动消除原来的歧义。 */
export function matchSpreadsheetRows(rows: readonly SpreadsheetSourceRow[], plan: SpreadsheetImportPlan, previous: readonly StoredSpreadsheetImportRow[], dateSystem: '1900' | '1904'): SpreadsheetPreviewRow[] {
  const decisions = new Map(plan.decisions.map(value => [value.rowIndex, value]));
  const normalized = rows.map(row => ({ row, ...normalizeSpreadsheetRow(row, plan, dateSystem, decisions.get(row.rowIndex)?.formulaConfirmed === true) }));
  const group = <T>(values: readonly T[], key: (value: T) => string) => { const result = new Map<string, T[]>(); for (const value of values) { const k = key(value), entries = result.get(k); if (entries) entries.push(value); else result.set(k, [value]); } return result; };
  const oldById = new Map(previous.map(value => [value.id, value]));
  const oldRaw = group(previous, value => value.rawRowHash), oldNormal = group(previous, value => value.normalizedSignature);
  const newRaw = group(normalized, value => value.row.rawRowHash), newNormal = group(normalized, value => value.normalizedSignature);
  const reserved = new Set(plan.decisions.filter(value => value.action === 'match').map(value => value.previousRowId));
  return normalized.map(value => {
    const { row, ...facts } = value, decision = decisions.get(row.rowIndex);
    let match: SpreadsheetPreviewRow['match'] = 'new', previousRow: StoredSpreadsheetImportRow | undefined;
    if (decision?.action === 'skip') match = 'skipped';
    else if (decision?.action === 'match') {
      previousRow = oldById.get(decision.previousRowId!);
      if (!previousRow) throw new Error('导入对应关系不存在。');
      match = previousRow.normalizedSignature === facts.normalizedSignature ? 'matched' : 'changed';
    } else if (decision?.action !== 'new') {
      const raw = oldRaw.get(row.rawRowHash) ?? [], normal = oldNormal.get(facts.normalizedSignature) ?? [];
      if (raw.length === 1 && newRaw.get(row.rawRowHash)?.length === 1 && !reserved.has(raw[0]!.id)) previousRow = raw[0];
      else if (normal.length === 1 && newNormal.get(facts.normalizedSignature)?.length === 1 && !reserved.has(normal[0]!.id)) previousRow = normal[0];
      if (previousRow) { match = previousRow.normalizedSignature === facts.normalizedSignature ? 'matched' : 'changed'; reserved.add(previousRow.id); }
      else if (raw.length || normal.length) { match = 'ambiguous'; facts.issues.push({ code: 'AMBIGUOUS_ROW' }); }
      else facts.issues.push({ code: 'UNCONFIRMED_NEW_ROW' });
    }
    if (!facts.valid && match !== 'skipped') match = 'invalid';
    const ready = match === 'skipped' || facts.valid && (match === 'matched' || match === 'changed' || match === 'new' && decision?.action === 'new');
    return { rowIndex: row.rowIndex, rawRowHash: row.rawRowHash, normalizedSignature: facts.normalizedSignature, normalized: facts.normalized, match, previousRowId: previousRow?.id ?? null, issues: facts.issues, ready, candidates: [] };
  });
}
