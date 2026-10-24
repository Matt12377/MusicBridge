import assert from 'node:assert/strict';
import childProcess, { type ChildProcess } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import test, { type TestContext } from 'node:test';
import { deflateSync } from 'node:zlib';
import { DEFAULT_METADATA_READ_BUDGET, RUST_MEDIA_METADATA_PARSER_VERSION } from '../src/library/metadata-reader-types.js';
import { createRustMediaWorkerPool, resolveRustMediaWorkerBinary, type RustMediaWorkerPool,
  type RustMetadataReadResult, type RustImageVariant } from '../src/library/rust-media-worker.js';

const MiB = 1024 * 1024;

function checkpoint(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

function riffChunk(name: string, bytes: Buffer): Buffer {
  const header = Buffer.alloc(8); header.write(name, 0, 'ascii'); header.writeUInt32LE(bytes.length, 4);
  return Buffer.concat([header, bytes, Buffer.alloc(bytes.length % 2)]);
}

/** 自行生成有效 PCM 与 RIFF INFO，不依赖旧 JS Worker 的鲜编绑定或音频夹具。 */
function syntheticWav(title: string): { bytes: Buffer; fields: { title: string; artist: string; album: string; artists: string[]; albumArtists: string[] } } {
  const channels = 2, sampleRate = 44_100, frames = 4_410, bits = 16;
  const format = Buffer.alloc(16), blockAlign = channels * bits / 8;
  format.writeUInt16LE(1, 0); format.writeUInt16LE(channels, 2); format.writeUInt32LE(sampleRate, 4);
  format.writeUInt32LE(sampleRate * blockAlign, 8); format.writeUInt16LE(blockAlign, 12); format.writeUInt16LE(bits, 14);
  const pcm = Buffer.alloc(frames * blockAlign);
  for (let frame = 0; frame < frames; frame++) {
    const sample = frame % 32 < 16 ? 2_000 : -2_000;
    pcm.writeInt16LE(sample, frame * blockAlign); pcm.writeInt16LE(-sample, frame * blockAlign + 2);
  }
  const fields = { title, artist: 'Synthetic Artist', album: 'Synthetic Album', artists: ['Synthetic Artist'], albumArtists: [] };
  const info = Buffer.concat([Buffer.from('INFO', 'ascii'), ...[
    ['INAM', fields.title], ['IART', fields.artist], ['IPRD', fields.album],
  ].map(([name, text]) => riffChunk(name!, Buffer.from(`${text!}\0`, 'ascii')))]);
  const body = Buffer.concat([Buffer.from('WAVE', 'ascii'), riffChunk('fmt ', format), riffChunk('LIST', info), riffChunk('data', pcm)]);
  return { bytes: riffChunk('RIFF', body), fields };
}

function crc32(bytes: Buffer): number {
  let value = 0xffff_ffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = value >>> 1 ^ (value & 1 ? 0xedb8_8320 : 0);
  }
  return (value ^ 0xffff_ffff) >>> 0;
}
function pngChunk(name: string, bytes: Buffer): Buffer {
  const kind = Buffer.from(name, 'ascii'), header = Buffer.alloc(4), checksum = Buffer.alloc(4);
  header.writeUInt32BE(bytes.length); checksum.writeUInt32BE(crc32(Buffer.concat([kind, bytes])));
  return Buffer.concat([header, kind, bytes, checksum]);
}
/** 完整 CRC 与压缩像素的单帧 PNG，真实 Rust 解码器必须消费其内容。 */
function syntheticPng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const stride = width * 4 + 1, raster = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = y * stride + 1 + x * 4;
    raster[at] = x % 256; raster[at + 1] = y % 256; raster[at + 2] = (x + y) % 256; raster[at + 3] = 255;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raster)), pngChunk('IEND', Buffer.alloc(0))]);
}

/** 从实际 JPEG 的 SOF 核尺寸，避免只验证协议自报的宽高。 */
function jpegDimensions(input: Uint8Array): { width: number; height: number } {
  const bytes = Buffer.from(input);
  assert.deepEqual(bytes.subarray(0, 2), Buffer.from([255, 216]), '结果必须是完整 JPEG');
  assert.deepEqual(bytes.subarray(-2), Buffer.from([255, 217]), '结果必须包含 JPEG 结束标记');
  let at = 2;
  while (at + 4 <= bytes.length) {
    assert.equal(bytes[at], 255, 'JPEG 标记必须对齐');
    while (bytes[at] === 255) at++;
    const marker = bytes[at++]; assert.notEqual(marker, 0xda, 'JPEG 扫描之前必须有尺寸帧');
    const size = bytes.readUInt16BE(at); assert.ok(size >= 2 && at + size <= bytes.length, 'JPEG 段必须完整');
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      assert.ok(size >= 8, 'JPEG 尺寸帧必须完整');
      return { width: bytes.readUInt16BE(at + 5), height: bytes.readUInt16BE(at + 3) };
    }
    at += size;
  }
  assert.fail('JPEG 缺少尺寸帧');
}
function assertVariant(image: RustImageVariant, width: number, height: number, maximum: number): void {
  assert.equal(image.mime, 'image/jpeg'); assert.equal(image.width, width); assert.equal(image.height, height);
  assert.ok(image.bytes.length > 0 && image.bytes.length <= maximum, 'JPEG 字节必须在产品预算内');
  assert.deepEqual(jpegDimensions(image.bytes), { width, height });
}
function ok(result: RustMetadataReadResult): Extract<RustMetadataReadResult, { status: 'ok' }> {
  if (result.status !== 'ok') assert.fail(`真实媒体 Worker 未读出成功事实：${result.code}`);
  return result;
}
function memorySource(bytes: Buffer) {
  const calls: { offset: number; length: number }[] = []; let revoked = false;
  return {
    calls,
    revoke() { revoked = true; },
    input: {
      size: bytes.length, budget: { ...DEFAULT_METADATA_READ_BUDGET },
      async read(offset: number, length: number): Promise<Uint8Array> {
        assert.equal(revoked, false, '终态后不能再次调用已归还的只读借用');
        assert.ok(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(length) && length > 0);
        assert.ok(length <= 64 * 1024 && offset + length <= bytes.length, '每次 RPC 必须遵守源范围与分块上限');
        calls.push({ offset, length }); return bytes.subarray(offset, offset + length);
      },
    },
  };
}

interface ObservedChild { child: ChildProcess; closed: boolean; close: Promise<void> }
/** 旁路观察原生 spawn；二进制、管道、协议和真实 close 均使用生产实现。 */
async function withPool(t: TestContext, body: (pool: RustMediaWorkerPool, children: ObservedChild[]) => Promise<void>): Promise<void> {
  assert.equal(process.versions.node.split('.')[0], '22', '真实媒体 Worker 集成测试使用 Node.js 22');
  const binary = await resolveRustMediaWorkerBinary(); // 缺少本轮 binary/pin 必须失败，不条件跳过。
  const children: ObservedChild[] = [], originalSpawn = childProcess.spawn;
  const observedSpawn = t.mock.method(childProcess, 'spawn', (...args: Parameters<typeof childProcess.spawn>) => {
    assert.equal(args[0], binary, '只能启动固定摘要已核对的真实媒体 Worker');
    const child = originalSpawn(...args), closed = checkpoint();
    const observed: ObservedChild = { child, closed: false, close: closed.promise };
    children.push(observed); child.once('close', () => { observed.closed = true; closed.resolve(); });
    return child;
  });
  syncBuiltinESMExports();
  const pool = createRustMediaWorkerPool({ binaryPath: binary, concurrency: 1, maxPending: 2 });
  try { await body(pool, children); }
  finally {
    try { await pool.close(); }
    finally { observedSpawn.mock.restore(); syncBuiltinESMExports(); }
    assert.ok(children.every(child => child.closed), '关闭池必须等全部真实子进程 close');
  }
}

test('真实常驻 Worker 读取合成 WAV 标签与 PCM 技术信息', { timeout: 15_000 }, async t => {
  await withPool(t, async (pool, children) => {
    const first = syntheticWav('Synthetic First'), firstSource = memorySource(first.bytes);
    const firstResult = ok(await pool.readMetadata(firstSource.input)); firstSource.revoke();
    assert.equal(firstResult.parserVersion, RUST_MEDIA_METADATA_PARSER_VERSION); assert.deepEqual(firstResult.fields, first.fields);
    assert.deepEqual(firstResult.technical, { container: 'WAVE', codec: 'PCM', lossless: true, sampleRateHz: 44_100,
      channels: 2, bitsPerSample: 16, durationSeconds: 0.1, evidence: 'bounded-parser-reported' });
    assert.deepEqual(firstResult.coverEvidence, []);
    assert.equal(firstResult.readEvidence.wholeAudioDecode, false); assert.equal(firstResult.readEvidence.wholeAudioHash, false);
    assert.equal(firstResult.readEvidence.readCalls, firstSource.calls.length);
    assert.equal(firstResult.readEvidence.bytesRead, firstSource.calls.reduce((sum, call) => sum + call.length, 0));
    assert.ok(firstSource.calls.length > 0 && firstResult.readEvidence.maxReadBytes <= 64 * 1024);
    assert.ok(firstResult.performance && Object.values(firstResult.performance).every(value => Number.isFinite(value) && value >= 0));
    assert.equal(children.length, 1); const child = children[0]!;
    assert.ok(child.child.pid && child.child.pid > 0); assert.equal(child.closed, false, '健康成功不退出常驻进程');
  });
});

test('真实常驻 Worker 健康任务复用同一 pid，旧任务只读借用不再调用', { timeout: 15_000 }, async t => {
  await withPool(t, async (pool, children) => {
    const first = syntheticWav('Synthetic First'), second = syntheticWav('Synthetic Second');
    const firstSource = memorySource(first.bytes), secondSource = memorySource(second.bytes);
    const firstResult = ok(await pool.readMetadata(firstSource.input)); firstSource.revoke();
    assert.equal(children.length, 1); const child = children[0]!;
    assert.ok(child.child.pid && child.child.pid > 0);
    const firstReads = firstSource.calls.length, pid = child.child.pid;
    const secondResult = ok(await pool.readMetadata(secondSource.input)); secondSource.revoke();
    assert.deepEqual(secondResult.fields, second.fields); assert.deepEqual(secondResult.technical, firstResult.technical);
    await tick();
    assert.equal(children.length, 1, '第二任务必须复用原进程，不能逐文件启动');
    assert.equal(child.child.pid, pid); assert.equal(child.closed, false); assert.equal(firstSource.calls.length, firstReads);
  });
});

function wavePlaceholder(source: Buffer, kind: 'LIST' | 'JUNK', size: number): Buffer {
  let at = 12;
  while (at + 8 <= source.length && source.toString('ascii', at, at + 4) !== 'LIST') {
    const length = source.readUInt32LE(at + 4); at += 8 + length + length % 2;
  }
  assert.equal(source.toString('ascii', at, at + 4), 'LIST', '占位块后必须仍有真实 INFO 标签');
  return riffChunk('RIFF', Buffer.concat([source.subarray(8, at), riffChunk(kind, Buffer.alloc(size)), source.subarray(at)]));
}

test('真实常驻 Worker WAVE 空LIST占位仍读后续标签与技术信息，源字节保持原样', { timeout: 15_000 }, async t => {
  await withPool(t, async pool => {
    const source = syntheticWav('Synthetic Empty List');
    const baseline = ok(await pool.readMetadata(memorySource(source.bytes).input));
    for (const kind of ['LIST', 'JUNK'] as const) {
      const bytes = wavePlaceholder(source.bytes, kind, 0), before = Buffer.from(bytes), input = memorySource(bytes);
      const result = ok(await pool.readMetadata(input.input)); input.revoke();
      assert.deepEqual(result.fields, source.fields); assert.deepEqual(result.technical, baseline.technical);
      assert.deepEqual(bytes, before, '兼容视图不得改写调用者或源音频字节');
      assert.equal(result.readEvidence.wholeAudioHash, false); assert.equal(result.readEvidence.wholeAudioDecode, false);
      assert.equal(result.readEvidence.bytesRead, input.calls.reduce((total, call) => total + call.length, 0));
    }
  });
});

test('真实常驻 Worker WAVE 非空短LIST和越界块仍拒绝，不因空占位兼容放宽结构', { timeout: 15_000 }, async t => {
  await withPool(t, async pool => {
    const source = syntheticWav('Synthetic Invalid List');
    for (const size of [1, 2, 3]) {
      const bytes = wavePlaceholder(source.bytes, 'LIST', size), result = await pool.readMetadata(memorySource(bytes).input);
      assert.equal(result.status, 'failure'); if (result.status === 'failure') assert.equal(result.code, 'PARSE_FAILED');
    }
    const truncated = wavePlaceholder(source.bytes, 'LIST', 0);
    truncated.writeUInt32LE(truncated.length, 4);
    const result = await pool.readMetadata(memorySource(truncated).input);
    assert.equal(result.status, 'failure'); if (result.status === 'failure') assert.equal(result.code, 'PARSE_FAILED');
  });
});

test('真实常驻 Worker 单次 PNG 解码生成显示图与 grid，JPEG 结果可再次真实解码', { timeout: 15_000 }, async t => {
  await withPool(t, async (pool, children) => {
    const image = await pool.processImage({ bytes: syntheticPng(640, 320), maxEdge: 320, maxOutputBytes: 768 * 1024, gridSize: 128 });
    assert.deepEqual(image.original, { width: 640, height: 320, mime: 'image/png' });
    assertVariant(image, 320, 160, 768 * 1024); assert.ok(image.grid); assertVariant(image.grid, 128, 64, 256 * 1024);
    assert.equal(image.compatible, undefined); assert.ok(image.bytes.length + image.grid.bytes.length <= MiB);
    const roundTrip = await pool.processImage({ bytes: image.bytes, maxEdge: 160, maxOutputBytes: 768 * 1024, gridSize: false });
    assert.deepEqual(roundTrip.original, { width: 320, height: 160, mime: 'image/jpeg' });
    assertVariant(roundTrip, 160, 80, 768 * 1024); assert.equal(roundTrip.grid, undefined);
    assert.equal(children.length, 1); assert.equal(children[0]!.closed, false, '图像任务成功后仍复用同一健康进程');
  });
});

test('真实常驻 Worker 取消先等 close 与在途 read，之后才归还队列许可', { timeout: 15_000 }, async t => {
  await withPool(t, async (pool, children) => {
    const wav = syntheticWav('Synthetic Cancel'), source = memorySource(wav.bytes), nextSource = memorySource(wav.bytes);
    const entered = checkpoint(), releaseRead = checkpoint(), controller = new AbortController(), order: string[] = [];
    let inflight = 0, settled = false, queued: Promise<RustMetadataReadResult> | undefined;
    const current = pool.readMetadata({ ...source.input, async read(offset, length) {
      inflight++; order.push('read-start'); entered.resolve();
      try { await releaseRead.promise; return await source.input.read(offset, length); }
      finally { inflight--; order.push('read-end'); }
    } }, controller.signal);
    void current.then(() => { settled = true; order.push('job-settled'); });
    try {
      await Promise.race([entered.promise, current.then(() => assert.fail('取消检查点必须进入真实 readonly RPC'))]);
      assert.equal(children.length, 1); const cancelledChild = children[0]!;
      queued = pool.readMetadata(nextSource.input);
      controller.abort();
      await cancelledChild.close; order.push('child-close'); await tick();
      assert.equal(cancelledChild.closed, true); assert.equal(cancelledChild.child.killed, true);
      assert.equal(inflight, 1, 'SIGKILL 不会替代 Node 在途读取收口');
      assert.equal(settled, false, '真实进程已退出，仍须等只读回调结束才返回取消');
      assert.equal(children.length, 1, '在途读取结束前不能把进程许可借给下一任务');
      assert.equal(nextSource.calls.length, 0, '排队任务不能提前读源');
      releaseRead.resolve();
      const cancelled = await current;
      assert.equal(cancelled.status, 'failure');
      if (cancelled.status === 'failure') assert.equal(cancelled.code, 'CANCELLED');
      assert.equal(inflight, 0); source.revoke();
      assert.ok(order.indexOf('child-close') < order.indexOf('read-end'));
      assert.ok(order.indexOf('read-end') < order.indexOf('job-settled'));
      assert.deepEqual(ok(await queued).fields, wav.fields); nextSource.revoke();
      assert.equal(children.length, 2, '取消后的下一任务必须使用新的健康进程');
      assert.notEqual(children[1]!.child, cancelledChild.child); assert.equal(children[1]!.closed, false);
    } finally {
      controller.abort(); releaseRead.resolve();
      await Promise.allSettled([current, ...(queued ? [queued] : [])]);
    }
  });
});
