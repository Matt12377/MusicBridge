import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, symlink, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

async function api() {
  const module = await import('../src/collection/spreadsheet-files.js').catch(() => ({}));
  assert.ok('readSpreadsheetFile' in module, '缺少有界只读工作簿读取入口');
  return (module as typeof import('../src/collection/spreadsheet-files.js')).readSpreadsheetFile;
}
test('显式工作簿选择只读原字节并返回basename，拒绝链接、目录、伪扩展与超限文件', async t => {
  const read = await api(), dir = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-excel-file-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bytes = Buffer.from([0x50, 0x4b, 3, 4, 1, 2, 3, 4]), file = path.join(dir, '合成.xlsx'); await writeFile(file, bytes);
  assert.deepEqual(await read(file), { bytes, displayName: '合成.xlsx', fileFormat: 'xlsx' });
  assert.deepEqual(await readFile(file), bytes);
  const alias = path.join(dir, '链接.xlsx'); await symlink(file, alias); await assert.rejects(read(alias));
  await assert.rejects(read(dir)); await assert.rejects(read('relative.xlsx'));
  const fake = path.join(dir, '伪装.xls'); await writeFile(fake, bytes); await assert.rejects(read(fake));
  const html = path.join(dir, '伪装.xlsx'); await writeFile(html, '<html>合成</html>'); await assert.rejects(read(html));
  const large = path.join(dir, '过大.xlsx'); await writeFile(large, Buffer.alloc(8 * 1024 * 1024 + 1)); await assert.rejects(read(large));
  const old = path.join(dir, '合成.XLS'), ole = Buffer.from('d0cf11e0a1b11ae1', 'hex'); await writeFile(old, ole);
  assert.equal((await read(old)).fileFormat, 'xls');
});
test('读取失败使用固定错误，不泄露路径或底层异常', async () => {
  const read = await api(); await assert.rejects(read('/synthetic/不得泄露/缺失.xlsx'), error => error instanceof Error && !error.message.includes('不得泄露') && !error.message.includes('ENOENT'));
});
