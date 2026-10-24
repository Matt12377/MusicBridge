import assert from 'node:assert/strict';
import test, { after, type TestContext } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import fs, { type FileHandle } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import * as dto from '@music-bridge/contracts';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { createLocalAlbumOwnerRuntime } from '../../src/collection/local-album-browser/owner-runtime.js';
import type { DatasetProjectionPort, DatasetProjectionCommandResults } from '../../src/collection/dataset-owner-protocol.js';
import type { LocalAlbumArtworkReadContext } from '../../src/collection/local-album-browser/types.js';
import { authorizeSourceDirectory, sourceRootAvailability } from '../../src/recording/source-files.js';
import { createScanReadAdmission } from '../../src/library/scan-read-admission.js';
import { closeRustMediaWorkerPool, getRustMediaWorkerPool, RustMediaWorkerError, type RustMediaFailure, type RustMediaReadonlyInput } from '../../src/library/rust-media-worker.js';
import { readLibraryOperationLine, type LibraryOperationEvent } from '../../src/shared/library-operation-log.js';

// 成功用例运行真实常驻子进程；所有用例结束后统一关闭，不能留下共享池挂住测试进程。
after(() => closeRustMediaWorkerPool());

const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
function crc32(bytes: Buffer): number {
  let value = 0xffff_ffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = value >>> 1 ^ (value & 1 ? 0xedb8_8320 : 0);
  }
  return (value ^ 0xffff_ffff) >>> 0;
}
function pngChunk(name: string, bytes: Buffer): Buffer {
  const kind = Buffer.from(name, 'ascii'), size = Buffer.alloc(4), checksum = Buffer.alloc(4);
  size.writeUInt32BE(bytes.length); checksum.writeUInt32BE(crc32(Buffer.concat([kind, bytes])));
  return Buffer.concat([size, kind, bytes, checksum]);
}
function picture(): Buffer {
  const header = Buffer.alloc(13); header.writeUInt32BE(16); header.writeUInt32BE(8, 4); header[8] = 8; header[9] = 6;
  const raster = Buffer.alloc(65 * 8);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 16; x++) {
    const at = y * 65 + 1 + x * 4;
    raster[at] = x * 16; raster[at + 1] = y * 32; raster[at + 2] = 80; raster[at + 3] = 255;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raster)), pngChunk('IEND', Buffer.alloc(0))]);
}
function riffChunk(name: string, bytes: Buffer): Buffer {
  const header = Buffer.alloc(8); header.write(name, 0, 'ascii'); header.writeUInt32LE(bytes.length, 4);
  return Buffer.concat([header, bytes, Buffer.alloc(bytes.length % 2)]);
}
/** 自有静音 PCM 与 APIC 封面；不是只有标签头的假音频。 */
function waveWithPicture(png: Buffer): Buffer {
  const format = Buffer.alloc(16); format.writeUInt16LE(1); format.writeUInt16LE(2, 2); format.writeUInt32LE(44_100, 4);
  format.writeUInt32LE(176_400, 8); format.writeUInt16LE(4, 12); format.writeUInt16LE(16, 14);
  const apic = Buffer.concat([Buffer.from([0]), Buffer.from('image/png\0', 'ascii'), Buffer.from([3, 0]), png]);
  const frame = Buffer.alloc(10); frame.write('APIC'); frame.writeUInt32BE(apic.length, 4);
  const body = Buffer.concat([frame, apic]), size = body.length;
  const id3 = Buffer.concat([Buffer.from([73, 68, 51, 3, 0, 0, size >>> 21 & 127, size >>> 14 & 127, size >>> 7 & 127, size & 127]), body]);
  return riffChunk('RIFF', Buffer.concat([Buffer.from('WAVE'), riffChunk('fmt ', format),
    riffChunk('data', Buffer.alloc(4 * 441)), riffChunk('id3 ', id3)]));
}

async function fixture(t: TestContext) {
  const temporary = process.env.TMPDIR; assert.ok(temporary && path.isAbsolute(temporary));
  if (process.platform === 'darwin') assert.ok(temporary === '/Volumes/LifeWeave/Developer/CommandLine/tmp'
    || temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'), '本机合成资料必须使用外置临时目录');
  const directory = await fs.mkdtemp(path.join(temporary, 'musicbridge-artwork-failures-')), media = path.join(directory, 'media');
  await fs.mkdir(media, { mode: 0o700 });
  const png = picture(), audio = waveWithPicture(png), audioPath = path.join(media, 'song.wav');
  await fs.writeFile(audioPath, audio, { flag: 'wx', mode: 0o600 });
  const repository = createCollectionRepository({ filePath: path.join(directory, 'collection.sqlite') });
  const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media));
  const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' });
  const asset = repository.localCatalog.registerAsset({ commandId: randomUUID(), libraryRootId: root.id, expectedRootRevision: root.revision,
    relative: 'song.wav', sha256: null, sampleFrames: null, timebaseHz: null });
  const track = repository.localCatalog.createTrack({ commandId: randomUUID(), assetId: asset.id, segment: null });
  repository.localCatalog.observeMetadata({ commandId: randomUUID(), trackId: track.id, source: 'synthetic', parserVersion: 'artwork-failures-v1',
    fields: { title: '合成歌曲', artist: '合成艺人', album: '合成专辑' } });
  const scope = { epoch: randomUUID(), datasetId: randomUUID() }, gate = createScanReadAdmission({ isBusy: () => false, isDisplayBusy: () => false });
  const watches: string[] = [], writes: string[] = [];
  const projection: DatasetProjectionPort = { async call(command, payload) {
    let result: unknown;
    if (command === 'scanReadStatus') result = gate.status(scope);
    else if (command === 'scanReadAcquire') result = gate.acquire(scope, (payload as { purpose?: 'local-album-display' }).purpose ?? 'scan');
    else if (command === 'scanReadWatchRevocation') {
      const watched = await gate.watchRevocation(scope, (payload as { permitId: string }).permitId); watches.push(watched.reason); result = watched;
    } else if (command === 'scanReadRelease') result = gate.release(scope, (payload as { permitId: string }).permitId);
    else throw new Error('合成用例不得进入 Main 图片回退或其他服务。');
    return result as DatasetProjectionCommandResults[typeof command];
  } };
  const observations = repository.privateLocalAlbumArtworkObservations!;
  const put = observations.put.bind(observations);
  observations.put = (datasetId, fact) => { writes.push(fact.state); return put(datasetId, fact); };
  const runtime = createLocalAlbumOwnerRuntime({ repository, projection, datasetId: scope.datasetId, assertCurrent() {}, async readRootViews() {
    return [{ root: repository.localCatalog.root(root.id), label: '合成音乐库', availability: await sourceRootAvailability(repository.sources.root(root.sourceRootId)) }];
  } });
  t.after(async () => { await runtime.close(); gate.close(); repository.close(); });
  async function target() {
    const page = await runtime.localAlbums.queryAlbums({ query: '', rootId: null, filter: 'all', offset: 0, limit: 60 }), album = page.items[0]!;
    const detail = repository.localCatalog.trackDetail(album.representativeTrackId!), locator = repository.localCatalog.privateAssetLocator(detail.asset.id);
    const request: dto.LocalAlbumArtworkRequest = { albumKey: album.id, rootId: album.rootId, editionId: album.editionId,
      representativeTrackId: album.representativeTrackId, revision: album.revision, refresh: true };
    const context: LocalAlbumArtworkReadContext = { album, directory: '', representative: { relative: locator.relative,
      summary: { track: detail.track, asset: detail.asset, metadata: detail.metadata.effective, versionTokens: detail.versionTokens },
      rawMetadata: detail.metadata.raw, hasArtwork: true, artworkRevision: null } };
    return { request, context };
  }
  return { runtime, gate, watches, writes, audio, audioPath, png, target };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function assertQuiet(f: Fixture): void {
  assert.deepEqual(f.gate.resourceCounts(), { permits: 0, revoked: 0, watches: 0, timers: 0, closed: false });
  assert.ok(f.watches.length > 0 && f.watches.every(reason => reason === 'permit-released'));
}
async function injected(t: TestContext, f: Fixture, error: Error, body: (events: LibraryOperationEvent[]) => Promise<void>): Promise<void> {
  const handles: { handle: FileHandle; fd: number }[] = [], events: LibraryOperationEvent[] = [], lines: string[] = [], originalOpen = fs.open;
  const opened = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (args[0] === f.audioPath) handles.push({ handle, fd: handle.fd });
    return handle;
  });
  syncBuiltinESMExports();
  const logged = t.mock.method(console, 'info', (...args: unknown[]) => {
    const line = args.map(String).join(' '); lines.push(line);
    const event = readLibraryOperationLine(line); if (event) events.push(event);
  });
  const worker = t.mock.method(getRustMediaWorkerPool(), 'readEmbeddedArtwork', async (input: RustMediaReadonlyInput) => {
    assert.equal(f.gate.resourceCounts().permits, 1, '进入提取时必须持有原读取许可');
    const bytes = await input.read(0, Math.min(64, input.size)); assert.ok(bytes.byteLength > 0);
    assert.ok(handles.some(value => value.handle.fd === value.fd), '注入错误发生在真实源 FD 活动窗口');
    throw error;
  });
  try {
    await body(events);
    assert.ok(handles.length > 0);
    for (const { handle } of handles) {
      assert.equal(handle.fd, -1, '失败结算前必须关闭真实源 FD');
      // 裸 FD 编号可能被后续读取复用；检查原句柄已经失去读能力。
      await assert.rejects(handle.read(Buffer.alloc(1), 0, 1, 0), { code: 'EBADF' });
    }
    assert.ok(lines.every(line => !line.includes('合成私密路径') && !line.includes(error.message) && !line.includes(error.stack ?? '\n')), '安全日志不得输出底层异常原文或调用栈');
    assertQuiet(f); assert.equal(f.writes.includes('missing'), false, '失败不能记为确认缺图');
    assert.deepEqual(await fs.readFile(f.audioPath), f.audio, '读取失败不得修改源音频');
  } finally { worker.mock.restore(); logged.mock.restore(); opened.mock.restore(); syncBuiltinESMExports(); }
}

test('V4：内嵌 Worker 基础设施错误穿过原 Reader，Owner 拒绝而不确认缺图，FD 与许可均闭合', { timeout: 15_000 }, async t => {
  for (const code of ['WORKER_FAILED', 'QUEUE_FULL', 'CLOSED', 'IO_ERROR'] satisfies RustMediaFailure[]) {
    const f = await fixture(t), error = new RustMediaWorkerError(code);
    await injected(t, f, error, async events => {
      const target = await f.target();
      await assert.rejects(f.runtime.artwork.readSources(target, randomUUID(), undefined, undefined, 'display'), caught => caught === error);
      await assert.rejects(f.runtime.localAlbums.getArtwork(target.request), { code: 'UNAVAILABLE' });
      assert.ok(events.some(event => event.part === 'artwork' && event.action === 'album.read' && event.state === 'error' && event.code === code), '中文安全日志保留 Worker 细码');
      assert.equal(f.runtime.localAlbums.getCacheInfo().observationCount, 0);
    });
  }
});

test('V4：未知程序异常不吞为 source-unavailable，不向安全日志输出原文或调用栈', { timeout: 15_000 }, async t => {
  const f = await fixture(t), error = new TypeError('合成私密路径/封面.png：合成程序错误');
  await injected(t, f, error, async events => {
    const target = await f.target();
    await assert.rejects(f.runtime.artwork.readSources(target, randomUUID(), undefined, undefined, 'display'), caught => caught === error);
    await assert.rejects(f.runtime.localAlbums.getArtwork(target.request), { code: 'UNAVAILABLE' });
    assert.ok(events.some(event => event.part === 'artwork' && event.action === 'album.read' && event.state === 'error' && event.code === 'ARTWORK_READ_FAILED'));
    assert.equal(f.runtime.localAlbums.getCacheInfo().observationCount, 0);
  });
});

test('V4：仅明确媒体解析错误继续返回未知，不误写 missing，原 FD 与许可照常释放', { timeout: 15_000 }, async t => {
  for (const code of ['PARSE_FAILED', 'UNSUPPORTED', 'BUDGET_EXCEEDED'] satisfies RustMediaFailure[]) {
    const f = await fixture(t);
    await injected(t, f, new RustMediaWorkerError(code), async events => {
      const target = await f.target(), result = await f.runtime.localAlbums.getArtwork(target.request);
      assert.equal(result.status, 'source-unavailable'); assert.equal(result.image, null); assert.equal(result.grid, undefined);
      assert.ok(events.some(event => event.part === 'artwork' && event.action === 'embedded.unavailable' && event.code === code));
      assert.equal(f.runtime.localAlbums.getCacheInfo().observationCount, 0);
    });
  }
});

test('V4：同一原生产 Owner 成功读取自有 WAV 内嵌 PNG，正常释放不自取消且 image/grid DTO 可用', { timeout: 15_000 }, async t => {
  const f = await fixture(t), target = await f.target(), result = await f.runtime.localAlbums.getArtwork(target.request);
  assert.equal(result.status, 'ready'); assert.ok(result.image); assert.ok(result.grid);
  assert.equal(dto.isLocalAlbumArtworkReply(result, target.request), true);
  assert.equal(result.image.original.sha256, hash(f.png)); assert.equal(result.image.original.mime, 'image/png');
  assert.equal(result.image.original.width, 16); assert.equal(result.image.original.height, 8);
  assert.equal(f.writes.includes('missing'), false); assert.ok(f.writes.includes('available'));
  assertQuiet(f); assert.deepEqual(await fs.readFile(f.audioPath), f.audio);
});

test('V4：封面来源身份忽略对象键顺序，但真实 metadata 字段变化仍拒绝且资源闭合', { timeout: 15_000 }, async t => {
  const f = await fixture(t), target = await f.target(), reordered = structuredClone(target);
  const original = target.context.representative!, member = reordered.context.representative!;
  const reverseKeys = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).reverse()) as T;
  member.rawMetadata = reverseKeys(member.rawMetadata);
  member.summary.metadata = reverseKeys(member.summary.metadata);
  member.summary.track = reverseKeys(member.summary.track);
  member.summary.asset = reverseKeys(member.summary.asset);
  assert.deepEqual(reordered, target, '仅改变键顺序，所有字段与值均须保持相同');
  for (const [before, reversed] of [[original.rawMetadata, member.rawMetadata], [original.summary.metadata, member.summary.metadata],
    [original.summary.track, member.summary.track], [original.summary.asset, member.summary.asset]]) {
    assert.notDeepEqual(Object.keys(before!), Object.keys(reversed!), '夹具必须实际改变每个对象的键顺序');
  }
  const handles: FileHandle[] = [], originalOpen = fs.open;
  const opened = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (args[0] === f.audioPath) handles.push(handle);
    return handle;
  });
  syncBuiltinESMExports();
  try {
    await t.test('四个对象仅反转键顺序，真实生产 Reader 仍可读取 display 与 grid', async () => {
      const result = await f.runtime.artwork.readSources(reordered, randomUUID(), undefined, undefined, 'display');
      assert.equal(result.copies.status, 'ready'); assert.ok(result.image); assert.ok(result.grid);
      assert.equal(result.image.original.sha256, hash(f.png));
      assert.ok(handles.length > 0, '必须经过真实源 FD 与 Rust 读取链');
      for (const handle of handles) {
        assert.equal(handle.fd, -1);
        await assert.rejects(handle.read(Buffer.alloc(1), 0, 1, 0), { code: 'EBADF' });
      }
      assertQuiet(f);
    });
    await t.test('raw 与 effective metadata 的真实字段值变化分别拒绝，不申请许可或打开源 FD', async () => {
      for (const field of ['rawMetadata', 'effectiveMetadata'] as const) {
        const changed = structuredClone(reordered), changedMember = changed.context.representative!;
        if (field === 'rawMetadata') changedMember.rawMetadata.title = '已变化的合成歌曲';
        else changedMember.summary.metadata.title = '已变化的合成歌曲';
        const openCount = handles.length, watchCount = f.watches.length;
        await assert.rejects(f.runtime.artwork.readSources(changed, randomUUID(), undefined, undefined, 'display'), /专辑封面来源已改变/u);
        assert.equal(handles.length, openCount, '身份变化必须在打开源 FD 前拒绝');
        assert.equal(f.watches.length, watchCount, '身份变化不得取得新的源读取许可');
        assert.deepEqual(f.gate.resourceCounts(), { permits: 0, revoked: 0, watches: 0, timers: 0, closed: false });
      }
      assert.equal(f.writes.includes('missing'), false);
      assert.deepEqual(await fs.readFile(f.audioPath), f.audio);
    });
  } finally { opened.mock.restore(); syncBuiltinESMExports(); }
});
