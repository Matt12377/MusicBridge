import {
  MAX_SPREADSHEET_CELL_BYTES, MAX_SPREADSHEET_CELLS, MAX_SPREADSHEET_COLUMNS,
  MAX_SPREADSHEET_PARSED_BYTES, MAX_SPREADSHEET_ROWS, SPREADSHEET_CSV_PARSER_VERSION,
  type ParsedSpreadsheetWorkbook, type SpreadsheetCell,
} from '@music-bridge/contracts';

const invalid = (): never => { throw new Error('CSV 格式无效或超过解析预算。'); };

/** CSV 没有单元格类型：所有非空字段始终是原文，不推断数字、日期或公式。 */
export function parseSpreadsheetCsv(bytes: Uint8Array): ParsedSpreadsheetWorkbook {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > 8 * 1024 * 1024) return invalid();
  let input: string;
  try { input = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return invalid(); }
  if (input.startsWith('\uFEFF')) input = input.slice(1);
  if (!input || input.includes('\u0000')) return invalid();

  const rows: ParsedSpreadsheetWorkbook['sheets'][number]['rows'] = [];
  let fields: string[] = [], field = '', quoted = false, closedQuote = false;
  let rowIndex = 1, totalCells = 0, fieldStarted = false;
  function finishField(): void {
    if (Buffer.byteLength(field, 'utf8') > MAX_SPREADSHEET_CELL_BYTES || fields.length >= MAX_SPREADSHEET_COLUMNS) return invalid();
    fields.push(field); field = ''; closedQuote = false; fieldStarted = false;
  }
  function finishRow(): void {
    finishField();
    if (rowIndex > MAX_SPREADSHEET_ROWS) return invalid();
    const cells: SpreadsheetCell[] = [];
    for (let index = 0; index < fields.length; index++) {
      if (fields[index] === '') continue;
      if (++totalCells > MAX_SPREADSHEET_CELLS) return invalid();
      cells.push({ columnIndex: index + 1, type: 'string', value: fields[index]! });
    }
    if (cells.length) rows.push({ rowIndex, cells });
    fields = []; rowIndex++;
  }

  for (let index = 0; index < input.length; index++) {
    const char = input[index]!;
    if (quoted) {
      if (char === '"') {
        if (input[index + 1] === '"') { field += '"'; index++; }
        else { quoted = false; closedQuote = true; }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      if (fieldStarted || closedQuote) return invalid();
      quoted = true; fieldStarted = true;
      continue;
    }
    if (char === ',') { finishField(); continue; }
    if (char === '\r' || char === '\n') {
      if (char === '\r') { if (input[index + 1] !== '\n') return invalid(); index++; }
      finishRow(); continue;
    }
    if (closedQuote) return invalid();
    field += char; fieldStarted = true;
  }
  if (quoted) return invalid();
  if (fieldStarted || closedQuote || fields.length) finishRow();
  if (!rows.length) return invalid();
  const result: ParsedSpreadsheetWorkbook = {
    fileFormat: 'csv', parserVersion: SPREADSHEET_CSV_PARSER_VERSION, dateSystem: '1900',
    sheets: [{ name: 'CSV', rows }],
  };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_SPREADSHEET_PARSED_BYTES) return invalid();
  return result;
}
