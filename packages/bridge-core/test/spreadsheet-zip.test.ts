import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateRawSync, crc32 } from 'node:zlib';

function zip(entries: Array<{ name: string; bytes: Buffer; declared?: number; flags?: number }>): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), data = deflateRawSync(entry.bytes), local = Buffer.alloc(30), dir = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(entry.flags ?? 0, 6); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(entry.bytes), 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(entry.declared ?? entry.bytes.length, 22); local.writeUInt16LE(name.length, 26);
    dir.writeUInt32LE(0x02014b50); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(entry.flags ?? 0, 8); dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(crc32(entry.bytes), 16); dir.writeUInt32LE(data.length, 20); dir.writeUInt32LE(entry.declared ?? entry.bytes.length, 24); dir.writeUInt16LE(name.length, 28); dir.writeUInt32LE(offset, 42);
    locals.push(local, name, data); central.push(dir, name); offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

async function api() {
  const loaded = await import('../src/collection/spreadsheet-zip.js').catch(() => ({}));
  assert.ok('validateSpreadsheetZip' in loaded, '缺少实际展开预算校验');
  return (loaded as typeof import('../src/collection/spreadsheet-zip.js')).validateSpreadsheetZip;
}
test('XLSX压缩预检按实际展开计数，不信声明大小，CRC与中央目录必须一致', async () => {
  const validate = await api();
  const good = zip([{ name: '[Content_Types].xml', bytes: Buffer.from('<Types/>') }]);
  assert.equal(validate(good).entryCount, 1);
  assert.throws(() => validate(zip([{ name: 'xl/worksheets/sheet1.xml', bytes: Buffer.alloc(17 * 1024 * 1024, 65), declared: 1 }])));
  assert.throws(() => validate(zip([{ name: 'xl/workbook.xml', bytes: Buffer.from('123456'), declared: 2 }])));
  const corrupt = Buffer.from(good); corrupt.writeUInt32LE(123, 14); assert.throws(() => validate(corrupt));
});
test('XLSX拒绝重复、危险路径、加密、尾随内容、重叠及过多ZIP条目', async () => {
  const validate = await api(), bytes = Buffer.from('合成');
  for (const name of ['../x', '/x', 'x\\y', 'x/./y', 'x/../y', 'x\0y']) assert.throws(() => validate(zip([{ name, bytes }])));
  assert.throws(() => validate(zip([{ name: 'xl/a', bytes }, { name: 'xl/a', bytes }])));
  assert.throws(() => validate(zip([{ name: 'xl/a', bytes, flags: 1 }])));
  assert.throws(() => validate(Buffer.concat([zip([{ name: 'xl/a', bytes }]), Buffer.from('trailer')])));
  assert.throws(() => validate(zip(Array.from({ length: 2049 }, (_, i) => ({ name: `xl/${i}`, bytes: Buffer.alloc(0) })))));
  const overlap = zip([{ name: 'xl/a', bytes }, { name: 'xl/b', bytes }]);
  const end = overlap.length - 22, dir = overlap.readUInt32LE(end + 16); overlap.writeUInt32LE(0, dir + 46 + 4 + 42);
  assert.throws(() => validate(overlap));
});
test('XLSX实际总展开量超过64MiB被拒绝，压缩声明未溢出也不能放行', async () => {
  const validate = await api();
  assert.throws(() => validate(zip(Array.from({ length: 5 }, (_, i) => ({ name: `xl/${i}`, bytes: Buffer.alloc(14 * 1024 * 1024, 65) })))));
});
