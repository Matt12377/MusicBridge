import assert from 'node:assert/strict';
import test, { after, type TestContext } from 'node:test';
import childProcess from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants, fstatSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { EMBEDDED_LYRICS_READ_BUDGET } from '../../src/library/metadata-reader-types.js';
import { createRustMediaWorkerPool, resolveRustMediaWorkerBinary, closeRustMediaWorkerPool, type RustMediaWorkerPool } from '../../src/library/rust-media-worker.js';
import { LocalSourceFence, LocalFactsFenceBusy } from '../../src/stream/local-source-fence.js';
import { catalogFixture } from '../mbrs006/catalog-fixture.js';
import { wave, uslt, sylt, id3Frame, syntheticLrc } from '../helpers/embedded-lyrics-fixture.js';

after(closeRustMediaWorkerPool);
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; };

async function actualPool(t: TestContext) {
  const binary = await resolveRustMediaWorkerBinary(), pool = createRustMediaWorkerPool({ binaryPath: binary, concurrency: 1, maxPending: 1 });
  t.after(async () => { await pool.close(); }); return pool;
}
async function read(pool: RustMediaWorkerPool, source: ReturnType<typeof wave>, budget: Partial<typeof EMBEDDED_LYRICS_READ_BUDGET> = {}) {
  const before = Buffer.from(source.bytes), calls: { offset: number; length: number }[] = []; let settled = false;
  try {
    const result = await pool.readEmbeddedLyrics({ size: source.bytes.length, deadlineAtMs: performance.now() + 2000, budget,
      async read(offset, length) {
        assert.equal(settled, false); assert.ok(length > 0 && length <= 65536); assert.ok(offset >= 0 && offset + length <= source.bytes.length);
        for (const span of source.forbidden) assert.ok(offset + length <= span.start || offset >= span.end, '真实Worker不得为歌词读取PCM或APIC payload');
        calls.push({ offset, length }); return source.bytes.subarray(offset, offset + length);
      },
    });
    assert.equal(result.readEvidence.bytesRead, calls.reduce((sum, value) => sum + value.length, 0));
    assert.equal(result.readEvidence.readCalls, calls.length); assert.equal(result.readEvidence.wholeAudioDecode, false); assert.equal(result.readEvidence.wholeAudioHash, false);
    return result;
  } finally { settled = true; assert.deepEqual(source.bytes, before); }
}

test('真实Rust嵌词：规范USLT/SYLT、有界拒绝和原WAV兼容，始终跳PCM/APIC正文', { timeout: 30_000 }, async t => {
  const pool = await actualPool(t), lines = [{ startMs: 1000, text: '同步第一行' }, { startMs: 3000, text: '同步第二行' }];
  await t.test('UTF8 USLT嵌LRC与大APIC共存，精确范围读取不跟随封面', async () => {
    const source = wave([id3Frame('USLT', uslt()), id3Frame('APIC', Buffer.alloc(691_783, 0x61))]);
    const result = await read(pool, source);
    assert.deepEqual(result.items, [{ kind: 'uslt', text: syntheticLrc }]); assert.ok(result.readEvidence.bytesRead < 16 * 1024);
  });
  for (const encoding of [1, 2] as const) await t.test(`UTF16 encoding${encoding}正文完整解码`, async () => {
    assert.deepEqual((await read(pool, wave([id3Frame('USLT', uslt(syntheticLrc, encoding))]))).items, [{ kind: 'uslt', text: syntheticLrc }]);
  });
  await t.test('v2.2 ULT和v2.3 USLT同样只返回原正文', async () => {
    assert.deepEqual((await read(pool, wave([id3Frame('ULT', uslt(syntheticLrc, 1), 2)], { version: 2 }))).items, [{ kind: 'uslt', text: syntheticLrc }]);
    assert.deepEqual((await read(pool, wave([id3Frame('USLT', uslt(syntheticLrc, 3), 3)], { version: 3 }))).items, [{ kind: 'uslt', text: syntheticLrc }]);
  });
  await t.test('SYLT毫秒歌词保持原事件，不能把MPEG帧时间当毫秒', async () => {
    assert.deepEqual((await read(pool, wave([id3Frame('SYLT', sylt(lines))]))).items, [{ kind: 'sylt', lines }]);
    await assert.rejects(read(pool, wave([id3Frame('SYLT', sylt(lines, 1))])), { code: 'UNSUPPORTED' });
  });
  await t.test('末奇数chunk缺pad沿原已核兼容，大小写ID3都可读', async () => {
    const source = wave([id3Frame('USLT', uslt('[00:01.00]ab'))], { missingTailPad: true, id3Name: 'ID3 ' });
    assert.equal((source.bytes.length - source.tagStart) % 2, 1, '确实构造末奇数缺pad');
    assert.equal((await read(pool, source)).items.length, 1);
  });
  await t.test('坏UTF8、截断frame和错误PCM结构仍拒绝', async () => {
    await assert.rejects(read(pool, wave([id3Frame('USLT', Buffer.from([3, 101, 110, 103, 0, 255]))])), { code: 'PARSE_FAILED' });
    const frame = id3Frame('USLT', uslt()); frame[7] = 127;
    await assert.rejects(read(pool, wave([frame])), { code: 'PARSE_FAILED' });
    const pcm = wave(); pcm.bytes.writeUInt16LE(6, 32);
    await assert.rejects(read(pool, pcm), { code: 'PARSE_FAILED' });
    const riff = wave(); riff.bytes.writeUInt32LE(riff.bytes.length - 9, 4);
    await assert.rejects(read(pool, riff), { code: 'PARSE_FAILED' });
  });
  await t.test('原读取/正文/候选/同步事件预算均整体失败，不截取成功前缀', async () => {
    await assert.rejects(read(pool, wave(), { totalReadBytes: 16 }), { code: 'BUDGET_EXCEEDED' });
    await assert.rejects(read(pool, wave([id3Frame('USLT', uslt('x'.repeat(65537)))])), { code: 'BUDGET_EXCEEDED' });
    await assert.rejects(read(pool, wave(Array.from({ length: 9 }, () => id3Frame('USLT', uslt())))), { code: 'BUDGET_EXCEEDED' });
    await assert.rejects(read(pool, wave([id3Frame('SYLT', sylt(Array.from({ length: 501 }, (_, i) => ({ startMs: i, text: 'x' }))))])), { code: 'BUDGET_EXCEEDED' });
  });
  await t.test('不支持的压缩/整tag unsync不猜测，普通COMM不冒充歌词', async () => {
    await assert.rejects(read(pool, wave([id3Frame('USLT', uslt(), 3, 128)], { version: 3 })), { code: 'UNSUPPORTED' });
    await assert.rejects(read(pool, wave([id3Frame('USLT', uslt(), 3)], { version: 3, flags: 128 })), { code: 'UNSUPPORTED' });
    assert.deepEqual((await read(pool, wave([id3Frame('COMM', uslt())]))).items, []);
  });
});

async function owner(t: TestContext, source: ReturnType<typeof wave> = wave()) {
  const f = await catalogFixture(t);
  await fsp.writeFile(path.join(f.media, '一.wav'), source.bytes); await fsp.writeFile(path.join(f.media, '二.wav'), source.bytes);
  (await f.commit(['一.wav', '二.wav'])).apply();
  const state = f.repository.localScan.privateCurrentFileState(f.root.id, '一.wav')!.value;
  const selection = { ...f.requests[0]!, request_id: randomUUID(), local_track_id: state.trackId!, asset_id: state.assetId!,
    expected_asset_revision: f.repository.localCatalog.asset(state.assetId!).fileRevision };
  const capture = f.tickets.capture(selection), fence = new LocalSourceFence(capture.buffer);
  t.after(async () => { f.tickets.seal(); await f.tickets.joinLyrics(); if (f.tickets.size) f.tickets.release(capture.ticketId); });
  return { ...f, capture, fence, waveSource: source };
}
function observe(t: TestContext, media: string, hold = false) {
  const opened: { relative: string; fd: number; flags: string | number | undefined; bytes: number; closed: boolean }[] = [];
  const entered = deferred(), release = deferred(), original = fsp.open; let held = false;
  t.mock.method(fsp, 'open', async (...args: Parameters<typeof fsp.open>) => {
    const handle = await original(...args); if (!String(args[0]).startsWith(media + path.sep)) return handle;
    const row = { relative: path.relative(media, String(args[0])), fd: handle.fd, flags: args[1], bytes: 0, closed: false }; opened.push(row);
    const realRead = handle.read.bind(handle) as (...values: any[]) => Promise<{ bytesRead: number; buffer: any }>, close = handle.close.bind(handle);
    t.mock.method(handle, 'read', async (...values: any[]) => { const result = await realRead(...values); row.bytes += result.bytesRead;
      if (hold && !held && row.relative.endsWith('.wav')) { held = true; entered.resolve(); await release.promise; } return result; });
    t.mock.method(handle, 'close', async () => { await close(); row.closed = true; }); return handle;
  });
  syncBuiltinESMExports(); t.after(() => { release.resolve(); t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { opened, entered: entered.promise, release: release.resolve };
}
function quiet(rows: ReturnType<typeof observe>['opened']) {
  assert.ok(rows.length > 0);
  for (const row of rows) { assert.equal(row.closed, true); assert.equal(Number(row.flags) & 3, constants.O_RDONLY); assert.ok(Number(row.flags) & constants.O_NOFOLLOW);
    assert.throws(() => fstatSync(row.fd), (error: any) => error.code === 'EBADF'); }
}

test('真实Owner ticket：无旁置时同一个音频FD读USLT，原UUID/签名/fence及日志不带云来源', async t => {
  const f = await owner(t), files = observe(t, f.media), result = await f.tickets.readLyrics(f.capture.ticketId);
  assert.equal(result.status, 'ready'); assert.deepEqual(result.lines, [{ startMs: 1000, endMs: 3000, text: '第一行' }, { startMs: 3000, text: '第二行' }]);
  assert.equal(result.source, undefined); assert.equal(f.capture.facts.track.id, f.capture.metadata.id);
  assert.equal(files.opened.length, 1, 'fallback复用原audio FD，不另外开音频或邻曲'); assert.ok(files.opened[0]!.bytes > 0); quiet(files.opened);
  assert.equal(f.fence.references, 0); assert.equal(f.fence.current, true);
});

test('真实Owner ticket：有效旁置优先且音频零内容读；坏旁置闭合后才回原FD内嵌', async t => {
  const f = await owner(t); await fsp.writeFile(path.join(f.media, '一.lrc'), '[00:02.00]旁置优先');
  const files = observe(t, f.media), result = await f.tickets.readLyrics(f.capture.ticketId);
  assert.equal(result.lines[0]?.text, '旁置优先'); assert.equal(files.opened.find(row => row.relative.endsWith('.wav'))!.bytes, 0); quiet(files.opened);
  await fsp.writeFile(path.join(f.media, '一.lrc'), Buffer.from([255]));
  const result2 = await f.tickets.readLyrics(f.capture.ticketId);
  assert.equal(result2.lines[0]?.text, '第一行'); assert.equal(f.fence.references, 0);
  quiet(files.opened);
});

test('真实Owner ticket：SYLT毫秒正文闭合；纯USLT没有同步时序不能伪造ready', async t => {
  const timed = await owner(t, wave([id3Frame('SYLT', sylt([{ startMs: 1000, text: '实际同步' }, { startMs: 3000, text: '后续' }]))]));
  assert.deepEqual((await timed.tickets.readLyrics(timed.capture.ticketId)).lines, [{ startMs: 1000, endMs: 3000, text: '实际同步' }, { startMs: 3000, text: '后续' }]);
  const plain = await owner(t, wave([id3Frame('USLT', uslt('没有时间戳的原始正文'))]));
  const result = await plain.tickets.readLyrics(plain.capture.ticketId); assert.equal(result.status, 'unavailable'); assert.deepEqual(result.lines, []);
});

test('真实Owner ticket：多份互异内嵌同步词不任取，完全相同可去重', async t => {
  const duplicate = await owner(t, wave([id3Frame('USLT', uslt()), id3Frame('USLT', uslt())]));
  assert.equal((await duplicate.tickets.readLyrics(duplicate.capture.ticketId)).status, 'ready');
  const ambiguous = await owner(t, wave([id3Frame('USLT', uslt()), id3Frame('USLT', uslt('[00:01.00]另一份同步正文'))]));
  assert.equal((await ambiguous.tickets.readLyrics(ambiguous.capture.ticketId)).status, 'unavailable');
});

for (const stop of ['seal', 'deadline', 'mutation'] as const) test(`真实Owner embedded ${stop}：在途RPC真实settled前不得close FD或宣布quiet`, { timeout: 10_000 }, async t => {
  const f = await owner(t), files = observe(t, f.media, true);
  if (stop === 'deadline') t.mock.timers.enable({ apis: ['setTimeout'] });
  const current = f.tickets.readLyrics(f.capture.ticketId); let settled = false, joined = false;
  void current.then(() => { settled = true; });
  try {
    await files.entered; assert.equal(f.tickets.readLyrics(f.capture.ticketId), current); assert.equal(f.fence.references, 1);
    if (stop === 'seal') f.tickets.seal();
    else if (stop === 'deadline') t.mock.timers.tick(2000);
    else assert.throws(() => f.repository.localCatalog.selectAsset({ commandId: randomUUID(), trackId: f.capture.facts.track.id,
      expectedSelectionRevision: f.capture.facts.track.selectionRevision, assetId: f.capture.facts.asset.id }), LocalFactsFenceBusy);
    const joining = f.tickets.joinLyrics().then(() => { joined = true; });
    for (let i = 0; i < 5; i++) await tick();
    assert.equal(settled, false); assert.equal(joined, false); assert.equal(f.fence.references, 1); assert.ok(files.opened.every(row => !row.closed));
    files.release(); assert.equal((await current).status, 'unavailable'); await joining; assert.equal(f.fence.references, 0); quiet(files.opened);
  } finally { files.release(); await current.catch(() => undefined); if (stop === 'deadline') t.mock.timers.reset(); }
});

test('真实Owner embedded：撤权/未知ticket不能读，音频途中变化不能发布已读歌词', async t => {
  const revoked = await owner(t), files = observe(t, revoked.media);
  assert.equal((await revoked.tickets.readLyrics(randomUUID())).status, 'unavailable');
  revoked.repository.sources.revoke({ commandId: randomUUID(), id: revoked.source.id });
  assert.equal((await revoked.tickets.readLyrics(revoked.capture.ticketId)).status, 'unavailable'); assert.equal(files.opened.length, 0);
  const changed = await owner(t), held = observe(t, changed.media, true), current = changed.tickets.readLyrics(changed.capture.ticketId);
  try { await held.entered; await fsp.appendFile(path.join(changed.media, '一.wav'), Buffer.from([0])); held.release();
    assert.equal((await current).status, 'unavailable'); quiet(held.opened); }
  finally { held.release(); await current.catch(() => undefined); }
});


test('真实Rust绝对期限：ready消耗的启动时间不续期，超时仍等待child close和在途read真实join', { timeout: 10_000 }, async t => {
  const binary = await resolveRustMediaWorkerBinary(), source = wave(), entered = deferred(), release = deferred(), exited = deferred();
  let now = 1000, startupObserved = false, settled = false, childClosed = false, startupBytes = '';
  const spawn = childProcess.spawn;
  t.mock.method(performance, 'now', () => now);
  t.mock.method(childProcess, 'spawn', (...args: any[]) => {
    const child = Reflect.apply(spawn, childProcess, args) as ReturnType<typeof childProcess.spawn>;
    // 真实ready字节先于MediaProcess监听到达；只控制单调钟，不伪造ready或Worker结果。
    child.stdout?.on('data', (bytes: Buffer) => {
      if (startupObserved) return;
      startupBytes += bytes.toString('utf8');
      if (startupBytes.includes('\n')) {
        const first: unknown = JSON.parse(startupBytes.slice(0, startupBytes.indexOf('\n')));
        assert.equal((first as { kind?: unknown }).kind, 'ready'); startupObserved = true; now += 200; startupBytes = '';
      }
    });
    child.once('close', () => { childClosed = true; exited.resolve(); }); return child;
  });
  syncBuiltinESMExports(); t.mock.timers.enable({ apis: ['setTimeout'] });
  const pool = createRustMediaWorkerPool({ binaryPath: binary, concurrency: 1, maxPending: 0 });
  const current = pool.readEmbeddedLyrics({ size: source.bytes.length, deadlineAtMs: 1300,
    async read(offset, length) { entered.resolve(); await release.promise; return source.bytes.subarray(offset, offset + length); },
  });
  const result = current.then(() => { settled = true; return { code: 'UNEXPECTED_SUCCESS' }; }, (error: unknown) => {
    settled = true; return { code: error instanceof Error && 'code' in error ? String(error.code) : 'UNKNOWN_FAILURE' };
  });
  try {
    await entered.promise; assert.equal(startupObserved, true); assert.equal(now, 1200);
    now = 1299; t.mock.timers.tick(99); await tick(); assert.equal(settled, false); assert.equal(childClosed, false);
    now = 1301; t.mock.timers.tick(2); await exited.promise;
    assert.equal(childClosed, true); assert.equal(settled, false, '真实进程退出也不能越过尚未返回的FD回调');
    release.resolve(); assert.equal((await result).code, 'TIMEOUT');
  } finally {
    release.resolve(); await result; await pool.close(); t.mock.timers.reset(); t.mock.restoreAll(); syncBuiltinESMExports();
  }
});
