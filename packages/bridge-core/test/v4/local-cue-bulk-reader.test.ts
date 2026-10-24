import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { closeSync, fstatSync, openSync } from 'node:fs';
import fsp, { lstat, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { authorizeSourceDirectory, readonlySourceCandidateMetadata } from '../../src/recording/source-files.js';
import type { CueSidecarBulkLifecycle } from '../../src/library/cue-sidecar-bulk-reader.js';
import { freshBulkCueReader, freshLegacyCueReader } from '../helpers/fresh-cue-bulk-reader.js';

async function fixture(t: TestContext) {
  const temporary = process.env.TMPDIR;
  assert.ok(temporary && path.isAbsolute(temporary) && (temporary === '/Volumes/LifeWeave/Developer/CommandLine/tmp'
    || temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/')));
  assert.ok((await lstat(temporary)).isDirectory()); assert.equal(await realpath(temporary), path.resolve(temporary));
  const directory = await mkdtemp(path.join(temporary, 'musicbridge-cue-bulk-'));
  const root = { ...await authorizeSourceDirectory(directory), id: randomUUID() };
  async function source(relative: string, bytes: Uint8Array) {
    await writeFile(path.join(directory, relative), bytes, { flag: 'wx', mode: 0o600 });
    let signature: string;
    if (bytes.length === 0) {
      await assert.rejects(() => readonlySourceCandidateMetadata(root, relative), { code: 'LIMIT_EXCEEDED' });
      const raw = await lstat(path.join(directory, relative), { bigint: true });
      signature = [raw.dev, raw.ino, raw.size, raw.mtimeNs, raw.ctimeNs].join(':');
    } else signature = (await readonlySourceCandidateMetadata(root, relative)).signature;
    t.after(async () => { assert.deepEqual(await fsp.readFile(path.join(directory, relative)), Buffer.from(bytes)); });
    return { root, relative, expectedSignature: signature };
  }
  return { directory, source };
}

test('常驻CUE Worker复用同一线程；settled后旧FD可被占用，下一项仍读其真实新FD', async t => {
  const f = await fixture(t), a = await f.source('first.cue', Buffer.from('REM first\n'));
  const body = Buffer.from('REM second, independent bytes\n'), b = await f.source('second.cue', body);
  const decoy = path.join(f.directory, 'decoy.cue'); await writeFile(decoy, 'REM decoy\n', { flag: 'wx', mode: 0o600 });
  const events: CueSidecarBulkLifecycle[] = [], occupied: number[] = [];
  let captured = -1;
  const reader = (await freshBulkCueReader()).createCueSidecarBulkReader({ onLifecycle(event) {
    events.push(event);
    if (event.type !== 'lease-released' || captured !== -1) return;
    captured = event.fd;
    // 真实close之后立即用合成只读文件占住旧FD号，避免把下一次仍读旧FD误当正确复用。
    for (let index = 0; index < 64; index++) { const fd = openSync(decoy, 'r'); occupied.push(fd); if (fd >= captured) break; }
  } });
  t.after(async () => { await reader.close(); for (const fd of occupied) closeSync(fd); });
  assert.equal((await reader.read(a)).status, 'ok'); assert.ok(occupied.includes(captured), '必须真实占住已释放的原FD号。');
  const result = await reader.read(b); assert.equal(result.status, 'ok');
  if (result.status === 'ok') { assert.deepEqual(result.bytes, new Uint8Array(body)); assert.ok(result.readCalls >= 1 && result.readCalls <= 64); }
  const starts = events.filter(event => event.type === 'worker-start');
  const reads = events.filter((event): event is Extract<CueSidecarBulkLifecycle, { requestId: string }> => event.type === 'read-start');
  assert.equal(starts.length, 1); assert.equal(reads.length, 2);
  const firstRead = reads[0]!, secondRead = reads[1]!;
  assert.equal(firstRead.threadId, secondRead.threadId); assert.notEqual(firstRead.requestId, secondRead.requestId); assert.notEqual(secondRead.fd, captured);
  assert.deepEqual(events.map(event => event.type), ['lease-acquired','worker-start','read-start','read-settled','lease-released',
    'lease-acquired','read-start','read-settled','lease-released']);
  assert.throws(() => fstatSync(secondRead.fd), { code: 'EBADF' });
  await reader.close(); assert.equal(events.at(-1)!.type, 'worker-exit');
  assert.deepEqual(await reader.read(a), { status: 'failure', code: 'CLOSED' });
});

test('CUE真实池最多八个FD和八个Worker，每线程单call，第二轮复用而不增加线程', async t => {
  const f = await fixture(t), body = Buffer.alloc(65_536, 32), inputs: Awaited<ReturnType<typeof f.source>>[] = [];
  for (let index = 0; index < 9; index++) inputs.push(await f.source(`${index}.cue`, body));
  const borrowed = new Set<number>(), inThread = new Set<number>(), threads = new Set<number>();
  let peak = 0, overlap = false, exits = 0;
  const reader = (await freshBulkCueReader()).createCueSidecarBulkReader({ onLifecycle(event) {
    if (event.type === 'lease-acquired') { borrowed.add(event.fd); peak = Math.max(peak, borrowed.size); }
    if (event.type === 'lease-released') borrowed.delete(event.fd);
    if (event.type === 'worker-start') threads.add(event.threadId);
    if (event.type === 'worker-exit') { exits++; inThread.delete(event.threadId); }
    if (event.type === 'read-start') { if (inThread.has(event.threadId)) overlap = true; inThread.add(event.threadId); }
    if (event.type === 'read-settled') inThread.delete(event.threadId);
  } }); t.after(() => reader.close());
  const first = inputs.slice(0, 8).map(input => reader.read(input));
  assert.deepEqual(await reader.read(inputs[8]!), { status: 'failure', code: 'QUEUE_FULL' });
  for (const result of await Promise.all(first)) { assert.equal(result.status, 'ok'); if (result.status === 'ok') assert.deepEqual(result.bytes, new Uint8Array(body)); }
  assert.equal(threads.size, 8); assert.ok(peak <= 8); assert.equal(borrowed.size, 0); assert.equal(inThread.size, 0); assert.equal(overlap, false);
  for (const result of await Promise.all(inputs.slice(0, 8).map(input => reader.read(input)))) assert.equal(result.status, 'ok');
  assert.equal(threads.size, 8); await reader.close(); assert.equal(exits, 8); assert.equal(borrowed.size, 0);
});

test('真实零字节保Source下限分类；65537字节保CUE预算且不开Worker', async t => {
  const f = await fixture(t), empty = await f.source('empty.cue', new Uint8Array()), large = await f.source('large.cue', Buffer.alloc(65_537, 32));
  const bulkEvents: CueSidecarBulkLifecycle[] = [], bulk = (await freshBulkCueReader()).createCueSidecarBulkReader({ onLifecycle: event => bulkEvents.push(event) });
  const legacy = (await freshLegacyCueReader()).createCueSidecarReader(); t.after(async () => { await bulk.close(); await legacy.close(); });
  for (const reader of [bulk, legacy]) {
    assert.deepEqual(await reader.read(empty), { status: 'failure', code: 'LIMIT_EXCEEDED' });
    assert.deepEqual(await reader.read(large), { status: 'failure', code: 'BUDGET_EXCEEDED' });
  }
  assert.deepEqual(bulkEvents.map(event => event.type), ['lease-acquired','lease-released']);
});

test('未settled的取消与close必须实际Worker exit后才释放Source租期', async t => {
  for (const mode of ['abort','close'] as const) await t.test(mode, async child => {
    const f = await fixture(child), input = await f.source('cancel.cue', Buffer.alloc(65_536, 32)), events: CueSidecarBulkLifecycle[] = [];
    const controller = new AbortController(); let closing: Promise<void> | undefined;
    const reader = (await freshBulkCueReader()).createCueSidecarBulkReader({ onLifecycle(event) {
      events.push(event); if (event.type === 'read-start') { if (mode === 'abort') controller.abort(); else closing = reader.close(); }
    } }); child.after(() => reader.close());
    assert.deepEqual(await reader.read(input, controller.signal), { status: 'failure', code: 'CANCELLED' });
    await closing; await reader.close();
    assert.deepEqual(events.map(event => event.type), ['lease-acquired','worker-start','read-start','worker-exit','lease-released']);
    assert.throws(() => fstatSync(events[0]!.fd), { code: 'EBADF' });
  });
});

test('实际FD close故障保持LRF fatal；常驻线程退出不能替代源句柄关闭', async t => {
  const f = await fixture(t), input = await f.source('fatal.cue', Buffer.from('REM finite\n')), target = path.join(f.directory, input.relative);
  const originalOpen = fsp.open, events: CueSidecarBulkLifecycle[] = []; let owned: FileHandle | undefined, realClose: (() => Promise<void>) | undefined;
  const mocked = t.mock.method(fsp, 'open', async (...args: Parameters<typeof originalOpen>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === target) { owned = handle; realClose = handle.close.bind(handle); t.mock.method(handle, 'close', async () => { throw new Error('合成真实FD close失败。'); }); }
    return handle;
  }); syncBuiltinESMExports();
  const reader = (await freshBulkCueReader()).createCueSidecarBulkReader({ onLifecycle: event => events.push(event) });
  try {
    assert.deepEqual(await reader.read(input), { status: 'failure', code: 'LEASE_RELEASE_FAILED' }); assert.ok(owned && realClose);
    assert.equal(fstatSync(owned.fd).isFile(), true); assert.equal(events.some(event => event.type === 'lease-released'), false);
    assert.deepEqual(await reader.read(input), { status: 'failure', code: 'LEASE_RELEASE_FAILED' });
    await assert.rejects(() => reader.close(), /句柄关闭未确认/u); assert.equal(events.at(-1)!.type, 'worker-exit');
    assert.equal(fstatSync(owned.fd).isFile(), true);
  } finally {
    if (owned && realClose) { const fd = owned.fd; await realClose(); assert.throws(() => fstatSync(fd), { code: 'EBADF' }); }
    mocked.mock.restore(); syncBuiltinESMExports(); await reader.close().catch(() => undefined);
  }
});
