import { parentPort, workerData } from 'node:worker_threads';
import * as XLSX from 'xlsx';
import * as cpexcel from 'xlsx/dist/cpexcel.full.mjs';
import type { ParsedSpreadsheetWorkbook, SpreadsheetCell } from '@music-bridge/contracts';
import { validateSpreadsheetZip } from './spreadsheet-zip.js';

const fail = (): never => { throw new Error('工作簿格式无效或超过解析预算。'); };
const text = (value: unknown): string => { if (typeof value !== 'string' || Buffer.byteLength(value) > 32768) return fail(); return value; };

function parse(input: unknown): ParsedSpreadsheetWorkbook {
  const { bytes: raw, fileFormat } = input as { bytes: Uint8Array; fileFormat: 'xlsx' | 'xls' };
  if (!(raw instanceof Uint8Array) || raw.byteLength < 8 || raw.byteLength > 8 * 1024 * 1024 || !['xlsx', 'xls'].includes(fileFormat)) return fail();
  const bytes = Buffer.from(raw);
  if (fileFormat === 'xlsx') { validateSpreadsheetZip(bytes); }
  else if (!bytes.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))) return fail();
  // 静态导入使生产Worker包含完整解析器及旧BIFF编码表；不使用readFile或HTML输出。
  XLSX.set_cptable(cpexcel);
  const book = XLSX.read(bytes, { type: 'buffer', cellFormula: true, cellNF: true, cellText: true, cellDates: false, sheetStubs: true, bookVBA: false, bookDeps: false, cellHTML: false });
  if (!book.SheetNames.length || book.SheetNames.length > 32 || new Set(book.SheetNames).size !== book.SheetNames.length) return fail();
  let totalCells = 0;
  const result: ParsedSpreadsheetWorkbook = { fileFormat, parserVersion: 'sheetjs-ce-0.20.3', dateSystem: book.Workbook?.WBProps?.date1904 ? '1904' : '1900', sheets: [] };
  for (const name of book.SheetNames) {
    if (!name || name.length > 255 || /[\x00-\x1f\x7f]/u.test(name)) return fail();
    const sheet = book.Sheets[name]; if (!sheet) return fail();
    if (sheet['!ref']) { const range = XLSX.utils.decode_range(sheet['!ref']); if (range.s.r < 0 || range.s.c < 0 || range.e.r >= 20000 || range.e.c >= 64) return fail(); }
    const rows = new Map<number, SpreadsheetCell[]>();
    for (const [address, rawCell] of Object.entries(sheet)) {
      if (address.startsWith('!')) continue;
      if (!/^[A-Z]+[1-9][0-9]*$/u.test(address)) return fail();
      const position = XLSX.utils.decode_cell(address), cell = rawCell as XLSX.CellObject;
      if (position.r >= 20000 || position.c >= 64 || !cell || typeof cell !== 'object') return fail();
      let type: SpreadsheetCell['type'], value: SpreadsheetCell['value'];
      if (cell.v === undefined || cell.v === null || cell.t === 'z') { type = 'blank'; value = null; }
      else if (cell.t === 'n' && typeof cell.v === 'number' && Number.isFinite(cell.v)) { type = 'number'; value = cell.v; }
      else if (cell.t === 'b' && typeof cell.v === 'boolean') { type = 'boolean'; value = cell.v; }
      else if (cell.t === 's') { type = 'string'; value = text(cell.v); }
      else if (cell.t === 'e') { type = 'error'; value = text(String(cell.w ?? cell.v)); }
      else return fail();
      const formula = cell.f === undefined ? undefined : text(cell.f), numberFormat = cell.z === undefined ? undefined : text(cell.z), displayText = cell.w === undefined ? undefined : text(cell.w);
      // 样式空格不膨胀成虚构数据行；有公式但无缓存的单元格必须保留。
      if (type === 'blank' && formula === undefined) continue;
      if (++totalCells > 250000) return fail();
      const rowIndex = position.r + 1, cells = rows.get(rowIndex) ?? [];
      cells.push({ columnIndex: position.c + 1, type, value, ...(formula === undefined ? {} : { formula }), ...(numberFormat === undefined ? {} : { numberFormat }), ...(displayText === undefined ? {} : { displayText }) });
      rows.set(rowIndex, cells);
    }
    result.sheets.push({ name, rows: [...rows].sort(([a], [b]) => a - b).map(([rowIndex, cells]) => ({ rowIndex, cells: cells.sort((a, b) => a.columnIndex - b.columnIndex) })) });
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 16 * 1024 * 1024) return fail();
  return result;
}

try { parentPort?.postMessage({ ok: true, value: parse(workerData) }); }
catch { parentPort?.postMessage({ ok: false }); }
