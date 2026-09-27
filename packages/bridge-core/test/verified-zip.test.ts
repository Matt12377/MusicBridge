import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { open, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { readVerifiedZipEntries, verifyVerifiedZip, writeVerifiedZip, type ZipBudget, type ZipEntrySource } from '../src/recording/verified-zip.js';

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const budget: ZipBudget = { maxEntries: 8, maxEntryBytes: 8 * 1024 * 1024, maxTotalBytes: 16 * 1024 * 1024, maxArchiveBytes: 24 * 1024 * 1024 };
const signal = (): AbortSignal => new AbortController().signal;
const source = (name: string, bytes: Buffer): ZipEntrySource => ({ name, kind: 'file', size: bytes.length, sha256: sha(bytes), open: async () => Readable.from([bytes]) });
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-verified-zip-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const absolute = path.join(root, 'output.zip');
  const handle = await open(absolute, 'wx+');
  t.after(() => handle.close());
  return { root, absolute, handle };
}

test('ZIP 独占句柄流式写入并重读每个条目的 CRC、SHA、尺寸和 ZIP64 结构', async t => {
  const { handle, absolute } = await fixture(t);
  const bytes = Buffer.alloc(2 * 1024 * 1024 + 7, 0x53);
  const entries: ZipEntrySource[] = [
    { name: 'Sources/', kind: 'directory', size: 0 },
    source('Sources/001.wav', bytes),
    { name: 'Bounce Targets/', kind: 'directory', size: 0 },
    { name: 'Bounce Targets/A/', kind: 'directory', size: 0 },
  ];
  const written = await writeVerifiedZip(handle, entries, budget, signal(), { forceZip64: true });
  const verified = await verifyVerifiedZip(handle, entries, budget, signal());
  assert.equal(verified.sha256, written.sha256);
  assert.equal(verified.size, written.size);
  assert.equal(verified.entries.find(entry => entry.name === 'Sources/001.wav')?.sha256, sha(bytes));
  const archive = await readFile(absolute);
  assert.ok(archive.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06])), '必须产生 ZIP64 End of Central Directory');
  assert.ok(archive.includes(Buffer.from([0x50, 0x4b, 0x06, 0x07])), '必须产生 ZIP64 locator');
});

test('ZIP 写入端拒绝遍历、别名、重复、文件父子冲突和输入漂移', async t => {
  const { handle } = await fixture(t);
  const bytes = Buffer.from('安全测试');
  for (const name of ['../outside', '/absolute', 'C:/drive', 'a\\b', 'a/./b', 'a//b', 'a/../b', 'a/.', 'CON.txt', 'a／b', 'a＼b', 'a/．']) {
    await assert.rejects(writeVerifiedZip(handle, [source(name, bytes)], budget, signal()), { code: 'ENTRY_INVALID' }, name);
  }
  await assert.rejects(writeVerifiedZip(handle, [source('A.txt', bytes), source('a.txt', bytes)], budget, signal()), { code: 'ENTRY_INVALID' });
  await assert.rejects(writeVerifiedZip(handle, [source('A.txt', bytes), source('Ａ.txt', bytes)], budget, signal()), { code: 'ENTRY_INVALID' });
  await assert.rejects(writeVerifiedZip(handle, [source('Straße.txt', bytes), source('STRASSE.txt', bytes)], budget, signal()), { code: 'ENTRY_INVALID' });
  await assert.rejects(writeVerifiedZip(handle, [source('dir', bytes), source('dir/file', bytes)], budget, signal()), { code: 'ENTRY_INVALID' });
  await assert.rejects(writeVerifiedZip(handle, [{ ...source('track.wav', bytes), sha256: '0'.repeat(64) }], budget, signal()), { code: 'CONTENT_CHANGED' });
});

test('ZIP 重读端不信任中心目录的 CRC 与文件名，且所有条目都要匹配期望', async t => {
  const { root, absolute, handle } = await fixture(t);
  const entries = [source('a.txt', Buffer.from('hello'))];
  await writeVerifiedZip(handle, entries, budget, signal());
  await assert.rejects(verifyVerifiedZip(handle, [source('b.txt', Buffer.from('hello'))], budget, signal()), { code: 'ENTRY_INVALID' });
  const original = await readFile(absolute);
  const central = original.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(central >= 0);
  const wrongCrc = Buffer.from(original);
  wrongCrc[central + 16] = wrongCrc[central + 16]! ^ 1;
  const crcPath = path.join(root, 'crc.zip'); await writeFile(crcPath, wrongCrc);
  const crcHandle = await open(crcPath, 'r'); t.after(() => crcHandle.close());
  await assert.rejects(verifyVerifiedZip(crcHandle, entries, budget, signal()), { code: 'CONTENT_CHANGED' });
  const traversal = Buffer.from(original);
  const fileName = central + 46;
  Buffer.from('../xx').copy(traversal, fileName);
  const traversalPath = path.join(root, 'traversal.zip'); await writeFile(traversalPath, traversal);
  const traversalHandle = await open(traversalPath, 'r'); t.after(() => traversalHandle.close());
  await assert.rejects(verifyVerifiedZip(traversalHandle, entries, budget, signal()));
});

test('ZIP 容器超预算及取消不产生已验证回执', async t => {
  const { handle } = await fixture(t);
  const bytes = Buffer.alloc(1024, 1);
  await assert.rejects(writeVerifiedZip(handle, [source('a.bin', bytes)], { ...budget, maxEntryBytes: 100 }, signal()), { code: 'BUDGET_EXCEEDED' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(writeVerifiedZip(handle, [source('a.bin', bytes)], budget, controller.signal), { code: 'CANCELLED' });
});

test('ZIP 在来源迟到打开时取消，等待迟到流关闭后才结束', async t => {
  const { handle } = await fixture(t);
  const bytes = Buffer.from('delayed');
  const controller = new AbortController();
  let openStarted!: () => void;
  const started = new Promise<void>(resolve => { openStarted = resolve; });
  let release!: (stream: Readable) => void;
  const delayed = new Promise<Readable>(resolve => { release = resolve; });
  let closed = false;
  const input = new Readable({ read() { this.push(bytes); this.push(null); }, destroy(_error, done) { setTimeout(() => { closed = true; done(); }, 25); } });
  const pending = writeVerifiedZip(handle, [{ name: 'late.bin', kind: 'file', size: bytes.length, sha256: sha(bytes), open: async () => { openStarted(); return delayed; } }], budget, controller.signal);
  await started;
  controller.abort();
  release(input);
  await assert.rejects(pending, { code: 'CANCELLED' });
  assert.equal(closed, true);
});

test('ZIP 拒绝来源超尺寸与目标写入错误，且关闭活动流', async t => {
  const oversized = await fixture(t);
  const bytes = Buffer.from('too long');
  let closed = false;
  const stream = Readable.from([bytes]);
  stream.once('close', () => { closed = true; });
  await assert.rejects(writeVerifiedZip(oversized.handle, [{ name: 'size.bin', kind: 'file', size: 1, sha256: sha(bytes.subarray(0, 1)), open: async () => stream }], budget, signal()), { code: 'CONTENT_CHANGED' });
  assert.equal(closed, true);
  const unwritable = await fixture(t);
  const broken = new Proxy(unwritable.handle, { get(target, key) {
    if (key === 'write') return async () => { throw Object.assign(new Error('合成目标写入失败'), { code: 'ENOSPC' }); };
    const value: unknown = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  await assert.rejects(writeVerifiedZip(broken, [source('a.bin', Buffer.alloc(1024, 1))], budget, signal()), { code: 'ENOSPC' });
});

test('ZIP 取消时等待在途目标写入真正结束后才交回句柄', async t => {
  const { handle } = await fixture(t);
  const controller = new AbortController();
  let started!: () => void;
  const writing = new Promise<void>(resolve => { started = resolve; });
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let settled = false;
  const slow = new Proxy(handle, { get(target, key) {
    if (key === 'write') return async () => { started(); await blocked; settled = true; throw Object.assign(new Error('合成写失败'), { code: 'ENOSPC' }); };
    const value: unknown = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const pending = writeVerifiedZip(slow, [source('a.bin', Buffer.alloc(1024, 1))], budget, controller.signal);
  await writing;
  controller.abort();
  let returned = false;
  void pending.then(() => { returned = true; }, () => { returned = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(returned, false);
  release();
  await assert.rejects(pending);
  assert.equal(settled, true);
});

test('ZIP 合法中文 NFC 条目完成写入和全量重读，分解式 Unicode 名称被拒绝', async t => {
  const { handle } = await fixture(t);
  const entries: ZipEntrySource[] = [
    { name: '音轨/', kind: 'directory', size: 0 },
    source('音轨/春天.wav', Buffer.from('用户授权的合成音频')),
  ];
  const written = await writeVerifiedZip(handle, entries, budget, signal());
  const verified = await verifyVerifiedZip(handle, entries, budget, signal());
  assert.equal(verified.sha256, written.sha256);
  assert.equal(verified.entries[1]?.name, '音轨/春天.wav');
  await assert.rejects(writeVerifiedZip(handle, [source('Cafe\u0301.txt', Buffer.from('x'))], budget, signal()), { code: 'ENTRY_INVALID' });
});

test('ZIP reader 中途取消会等待在途读取结束，不交出伪验证回执', async t => {
  const { handle } = await fixture(t);
  const largeBudget: ZipBudget = { maxEntries: 2, maxEntryBytes: 8 * 1024 * 1024, maxTotalBytes: 8 * 1024 * 1024, maxArchiveBytes: 9 * 1024 * 1024 };
  const entries = [source('合成录音.wav', Buffer.alloc(4 * 1024 * 1024, 0x43))];
  await writeVerifiedZip(handle, entries, largeBudget, signal());
  const controller = new AbortController();
  let entered!: () => void, release!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let paused = false;
  const slow = new Proxy(handle, { get(target, key) {
    if (key === 'read') return async (buffer: Buffer, offset: number, length: number, position: number) => {
      const result = await target.read(buffer, offset, length, position);
      if (length >= 256 * 1024 && !paused) { paused = true; entered(); await blocked; }
      return result;
    };
    const value: unknown = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const pending = verifyVerifiedZip(slow, entries, largeBudget, controller.signal);
  await reading;
  controller.abort();
  let returned = false;
  void pending.then(() => { returned = true; }, () => { returned = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(returned, false);
  release();
  await assert.rejects(pending, { code: 'CANCELLED' });
});

test('中立 ZIP 读端逐项交付完整流与摘要，拒绝未读完、CRC 漂移和超预算条目', async t => {
  const { root, absolute, handle } = await fixture(t);
  const bytes = Buffer.from('合成 ZIP 字节');
  const entries: ZipEntrySource[] = [{ name: '资料/', kind: 'directory', size: 0 }, source('资料/内容.txt', bytes)];
  const written = await writeVerifiedZip(handle, entries, budget, signal());
  const names: string[] = [], chunks: Buffer[] = [];
  const read = await readVerifiedZipEntries(handle, budget, signal(), async (entry, stream) => {
    names.push(entry.name);
    if (entry.kind === 'file') for await (const chunk of stream) chunks.push(chunk);
  });
  assert.deepEqual(names, ['资料/', '资料/内容.txt']);
  assert.deepEqual(Buffer.concat(chunks), bytes);
  assert.equal(read.sha256, written.sha256);
  assert.equal(read.entries[1]?.sha256, sha(bytes));
  await assert.rejects(readVerifiedZipEntries(handle, budget, signal(), async () => undefined), { code: 'ARCHIVE_INVALID' });
  await assert.rejects(readVerifiedZipEntries(handle, { ...budget, maxEntryBytes: 1 }, signal(), async () => undefined), { code: 'BUDGET_EXCEEDED' });
  const altered = Buffer.from(await readFile(absolute));
  const central = altered.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(central >= 0);
  altered[central + 16] = altered[central + 16]! ^ 1;
  const changedPath = path.join(root, 'changed.zip'); await writeFile(changedPath, altered);
  const changed = await open(changedPath, 'r'); t.after(() => changed.close());
  await assert.rejects(readVerifiedZipEntries(changed, budget, signal(), async (_entry, stream) => { for await (const _ of stream) { /* 读取全部。 */ } }), { code: 'CONTENT_CHANGED' });
});
