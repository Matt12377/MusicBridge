import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import type * as SheetJS from 'xlsx';

const XLSX: typeof SheetJS = createRequire(import.meta.url)('xlsx');
function bytes(fileFormat: 'xlsx' | 'xls' = 'xlsx', date1904 = false): Buffer {
  const book = XLSX.utils.book_new(), sheet = XLSX.utils.aoa_to_sheet([['品牌', '数量', '备注'], ['合成中文磁带', 10, '=HYPERLINK("https://invalid.example")']]);
  sheet['B3'] = { t: 'n', f: 'SUM(5,5)', v: 10 }; sheet['B4'] = { t: 'n', f: 'NOW()' }; sheet['C3'] = { t: 'e', v: 7 };
  sheet['A4'] = { t: 'n', v: 60, z: 'yyyy-mm-dd' }; sheet['!ref'] = 'A1:C4';
  XLSX.utils.book_append_sheet(book, sheet, '合成库存'); book.Workbook = { WBProps: { date1904 } };
  return XLSX.write(book, { type: 'buffer', bookType: fileFormat === 'xlsx' ? 'xlsx' : 'biff8', compression: true });
}
async function api() {
  const module = await import('../src/collection/spreadsheet-parser.js').catch(() => ({}));
  assert.ok('parseSpreadsheetWorkbook' in module, '缺少独立可终止的工作簿解析Worker');
  return (module as typeof import('../src/collection/spreadsheet-parser.js')).parseSpreadsheetWorkbook;
}
for (const format of ['xlsx', 'xls'] as const) test(`${format}真实合成工作簿在Worker解析，保留中文、原行、数值与日期系统`, async () => {
  const parse = await api();
  const parsed = await parse(bytes(format, true), format);
  assert.equal(parsed.fileFormat, format); assert.equal(parsed.parserVersion, 'sheetjs-ce-0.20.3'); assert.equal(parsed.dateSystem, '1904');
  assert.equal(parsed.sheets[0]?.name, '合成库存');
  assert.equal(parsed.sheets[0]?.rows.find(row => row.rowIndex === 2)?.cells.find(cell => cell.columnIndex === 1)?.value, '合成中文磁带');
  assert.equal(parsed.sheets[0]?.rows.find(row => row.rowIndex === 2)?.cells.find(cell => cell.columnIndex === 2)?.value, 10);
});
test('公式不执行，缓存缺失/错误和Excel日期序号保留供上层显式核对', async () => {
  const parse = await api(), parsed = await parse(bytes(), 'xlsx');
  const cells = parsed.sheets[0]!.rows;
  assert.equal(cells.find(row => row.rowIndex === 3)?.cells.find(c => c.columnIndex === 2)?.formula, 'SUM(5,5)');
  assert.equal(cells.find(row => row.rowIndex === 3)?.cells.find(c => c.columnIndex === 2)?.value, 10);
  assert.equal(cells.find(row => row.rowIndex === 4)?.cells.find(c => c.columnIndex === 2)?.formula, 'NOW()');
  assert.equal(cells.find(row => row.rowIndex === 4)?.cells.find(c => c.columnIndex === 2)?.value, null);
  assert.equal(cells.find(row => row.rowIndex === 3)?.cells.find(c => c.columnIndex === 3)?.type, 'error');
  assert.equal(cells.find(row => row.rowIndex === 4)?.cells.find(c => c.columnIndex === 1)?.value, 60);
});
test('工作簿范围、文本、输入与格式超预算整份拒绝，不截断', async () => {
  const parse = await api();
  for (const ref of ['A1:BM2', 'A1:A20001']) {
    const book = XLSX.utils.book_new(), sheet = XLSX.utils.aoa_to_sheet([['合成']]); sheet['!ref'] = ref;
    XLSX.utils.book_append_sheet(book, sheet, '库存');
    await assert.rejects(parse(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }), 'xlsx'));
  }
  await assert.rejects(parse(Buffer.alloc(8 * 1024 * 1024 + 1), 'xlsx'));
  await assert.rejects(parse(Buffer.from('<html><table><tr><td>伪工作簿</td></tr></table></html>'), 'xlsx'));
  await assert.rejects(parse(bytes('xlsx'), 'xls'));
});
test('解析超时终止Worker，宿主事件循环仍能工作且后续解析可继续', async () => {
  const parse = await api(); let ticks = 0; const timer = setInterval(() => ticks++, 1);
  try { await assert.rejects(parse(bytes(), 'xlsx', { timeoutMs: 1 })); } finally { clearInterval(timer); }
  assert.ok(ticks > 0); assert.equal((await parse(bytes(), 'xlsx')).sheets.length, 1);
});
test('单Core同一时刻仅启动一个解析Worker，并发请求明确拒绝且释放后可再解析', async () => {
  const parse = await api(), input = bytes(), first = parse(input, 'xlsx');
  try { await assert.rejects(parse(input, 'xlsx')); } finally { await first; }
  assert.equal((await parse(input, 'xlsx')).sheets.length, 1);
});
