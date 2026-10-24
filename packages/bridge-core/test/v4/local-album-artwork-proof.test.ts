import assert from 'node:assert/strict';
import test, { after, type TestContext } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import fs, { type FileHandle } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import * as dto from '@music-bridge/contracts';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { createLocalAlbumArtworkReader } from '../../src/collection/local-album-browser/artwork-read-port.js';
import { LocalAlbumArtworkResourceError } from '../../src/collection/local-album-browser/artwork-resource-store.js';
import { createLocalAlbumOwnerRuntime } from '../../src/collection/local-album-browser/owner-runtime.js';
import type { DatasetProjectionPort, DatasetProjectionCommandResults } from '../../src/collection/dataset-owner-protocol.js';
import type { LocalAlbumArtworkReadContext } from '../../src/collection/local-album-browser/types.js';
import { authorizeSourceDirectory, sourceRootAvailability } from '../../src/recording/source-files.js';
import { createScanReadAdmission } from '../../src/library/scan-read-admission.js';
import { closeRustMediaWorkerPool, getRustMediaWorkerPool, RustMediaWorkerError } from '../../src/library/rust-media-worker.js';
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
  const directory = await fs.mkdtemp(path.join(temporary, 'musicbridge-artwork-proof-')), media = path.join(directory, 'media');
  await fs.mkdir(media, { mode: 0o700 });
  const png = picture(), audio = waveWithPicture(png), audioPath = path.join(media, 'song.wav');
  await fs.writeFile(audioPath, audio, { flag: 'wx', mode: 0o600 });
  const repository = createCollectionRepository({ filePath: path.join(directory, 'collection.sqlite') });
  const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media));
  const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' });
  const asset = repository.localCatalog.registerAsset({ commandId: randomUUID(), libraryRootId: root.id, expectedRootRevision: root.revision,
    relative: 'song.wav', sha256: null, sampleFrames: null, timebaseHz: null });
  const track = repository.localCatalog.createTrack({ commandId: randomUUID(), assetId: asset.id, segment: null });
  repository.localCatalog.observeMetadata({ commandId: randomUUID(), trackId: track.id, source: 'synthetic', parserVersion: 'artwork-proof-v1',
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
  t.after(async () => { await runtime.close(); gate.close(); repository.close(); await fs.rm(directory, { recursive: true, force: true }); });
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
  return { runtime, gate, watches, writes, audio, audioPath, png, target, repository, scope, media, source, root, filePath: path.join(directory, 'collection.sqlite') };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function assertQuiet(f: Fixture): void {
  assert.deepEqual(f.gate.resourceCounts(), { permits: 0, revoked: 0, watches: 0, timers: 0, closed: false });
  assert.ok(f.watches.length > 0 && f.watches.every(reason => reason === 'permit-released'));
}

/** 两张有效但不是固定名的图片；与内嵌16×8图不同，不能靠误选目录图让测试通过。 */
async function ambiguousPictures(f: Fixture): Promise<void> {
  const header = Buffer.alloc(13); header.writeUInt32BE(8); header.writeUInt32BE(8, 4); header[8] = 8; header[9] = 6;
  const raster = Buffer.alloc(33 * 8);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const at = y * 33 + 1 + x * 4;
    raster[at] = 160; raster[at + 1] = x * 20; raster[at + 2] = y * 20; raster[at + 3] = 255;
  }
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raster)), pngChunk('IEND', Buffer.alloc(0))]);
  await fs.writeFile(path.join(f.media, '自有唱片正面.png'), png);
  await fs.writeFile(path.join(f.media, '自有唱片背面.png'), png);
}
function plainWave(): Buffer {
  const format = Buffer.alloc(16); format.writeUInt16LE(1); format.writeUInt16LE(2, 2); format.writeUInt32LE(44_100, 4);
  format.writeUInt32LE(176_400, 8); format.writeUInt16LE(4, 12); format.writeUInt16LE(16, 14);
  return riffChunk('RIFF', Buffer.concat([Buffer.from('WAVE'), riffChunk('fmt ', format), riffChunk('data', Buffer.alloc(4 * 441))]));
}
/** 只在前台查询已返回且尚无Source flight时越过原100msquiet；不推进IO/FD/许可或伪造quiet。 */
function elapseForegroundQuiet(t: TestContext): void {
  const nativeNow = performance.now.bind(performance)
  t.mock.method(performance, 'now', () => nativeNow() + 101)
}
/** 所有成功落盘须发生在真实源句柄和原许可关闭之后；缓存编码器与SQLite照常运行。 */
async function observeProof(t: TestContext, f: Fixture, body: (seen: {
  events: LibraryOperationEvent[]; handles: FileHandle[];
  saved: Parameters<NonNullable<typeof f.repository.privateLocalAlbumArtworkResources>['put']>[1][]
}) => Promise<void>): Promise<void> {
  const handles: FileHandle[] = [], events: LibraryOperationEvent[] = [], originalOpen = fs.open;
  const store = f.repository.privateLocalAlbumArtworkResources!, originalPut = store.put.bind(store);
  const saved: Parameters<typeof store.put>[1][] = [];
  const opened = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (args[0] === f.audioPath) handles.push(handle);
    return handle;
  });
  syncBuiltinESMExports();
  const logged = t.mock.method(console, 'info', (...args: unknown[]) => {
    const event = readLibraryOperationLine(args.map(String).join(' ')); if (event) events.push(event);
  });
  const written = t.mock.method(store, 'put', (...args: Parameters<typeof store.put>) => {
    assertQuiet(f);
    assert.ok(handles.length > 0, '正证明必须来自真正读过的音频FD');
    assert.ok(handles.every(handle => handle.fd === -1), 'COMMIT前源FD已真实关闭');
    assert.ok(events.some(event => event.action === 'source.quiet' && event.state === 'complete'));
    originalPut(...args); saved.push(args[1]);
  });
  try {
    await body({ events, handles, saved });
    assertQuiet(f);
    assert.ok(handles.length > 0, '每项反例也必须走到实际内嵌读取');
    for (const handle of handles) {
      assert.equal(handle.fd, -1);
      await assert.rejects(handle.read(Buffer.alloc(1), 0, 1, 0), { code: 'EBADF' });
    }
    assert.equal(f.writes.includes('missing'), false, '未获负证明不能写缺图观察');
  } finally { written.mock.restore(); logged.mock.restore(); opened.mock.restore(); syncBuiltinESMExports(); }
}
function hasCode(events: LibraryOperationEvent[], action: string, code: string): boolean {
  return events.some(event => event.action === action && event.code === code);
}

for (const purpose of ['display', 'background'] as const) test(`封面正证明：完整非固定名多图与真实内嵌图，${purpose}在COMMIT和quiet之后才成功`, { timeout: 15_000 }, async t => {
  const f = await fixture(t); await ambiguousPictures(f);
  await observeProof(t, f, async seen => {
    const target = await f.target();
    if (purpose === 'display') {
      const result = await f.runtime.localAlbums.getArtwork(target.request);
      assert.equal(result.status, 'ready'); assert.ok(result.image); assert.ok(result.grid);
      assert.equal(result.image.original.sha256, hash(f.png), '不得任意挑选目录中的8×8图');
    } else {
      const background = f.runtime.background!;
      elapseForegroundQuiet(t); background.start(); await background.runPending(); await background.pause();
      assert.equal(background.inspect().complete, 1, '后台只有资源已COMMIT才完成原领取');
      assert.equal(background.inspect().pending, 0); assert.equal(background.inspect().running, 0);
    }
    assert.equal(seen.saved.length, 1); assert.ok(seen.saved[0]!.image);
    assert.equal(seen.saved[0]!.image!.original.sha256, hash(f.png));
    assert.equal(seen.saved[0]!.evidence.unresolved, false); assert.equal(seen.saved[0]!.evidence.embeddedConfirmed, true);
    assert.ok(seen.saved[0]!.evidence.embedded); assert.equal(seen.saved[0]!.evidence.independentOnly, false);
    assert.equal(seen.saved[0]!.evidence.independent.some(item => item.included), false);
    assert.ok(hasCode(seen.events, 'independent.discovery', 'NONPREFERRED_NAMES_AMBIGUOUS'));
    assert.equal(seen.events.some(event => event.action === 'artwork.display-proof'), false);
    assert.equal(seen.events.filter(event => event.action === 'artwork.resource-write' && event.state === 'complete').length, 1);
    assert.ok(f.writes.includes('available')); assert.deepEqual(await fs.readFile(f.audioPath), f.audio);
  });
});

test('封面正证明：非固定名多图的内嵌副本重开后本地命中，离线不读源也不再取许可', { timeout: 15_000 }, async t => {
  const f = await fixture(t); await ambiguousPictures(f);
  const target = await f.target(), { refresh: _refresh, ...request } = target.request;
  let image: dto.LocalArtworkImage | null = null;
  await observeProof(t, f, async seen => {
    const result = await f.runtime.localAlbums.getArtwork(target.request); image = result.image;
    assert.ok(image); assert.equal(seen.saved.length, 1);
  });
  await fs.rename(f.media, f.media + '-offline');
  const repository = createCollectionRepository({ filePath: f.filePath });
  const reader = createLocalAlbumArtworkReader({ repository, datasetId: f.scope.datasetId, assertCurrent() {} });
  const forbidden = t.mock.method(fs, 'lstat', async () => { throw new Error('本地资源命中不得访问源目录'); });
  syncBuiltinESMExports();
  try {
    const cached = reader.readCached(request);
    assert.ok(cached); assert.equal(cached.status, 'ready'); assert.deepEqual(cached.image, image);
    assert.ok(cached.grid); assert.equal(forbidden.mock.callCount(), 0);
  } finally { await reader.close(); repository.close(); forbidden.mock.restore(); syncBuiltinESMExports(); }
});

test('封面负证明：非固定名多图但真实WAV无内嵌图，不能写missing或完成后台领取', { timeout: 15_000 }, async t => {
  const f = await fixture(t); await ambiguousPictures(f); const audio = plainWave(); await fs.writeFile(f.audioPath, audio);
  await observeProof(t, f, async seen => {
    const background = f.runtime.background!;
    elapseForegroundQuiet(t); background.start(); await background.runPending(); await background.pause();
    assert.equal(background.inspect().complete, 0); assert.equal(background.inspect().pending, 1);
    assert.equal(background.inspect().running, 0); assert.equal(seen.saved.length, 0);
    assert.ok(hasCode(seen.events, 'independent.discovery', 'NONPREFERRED_NAMES_AMBIGUOUS'));
    assert.ok(hasCode(seen.events, 'artwork.background.item', 'SOURCE_UNAVAILABLE'));
    assert.deepEqual(f.writes, []); assert.equal(f.runtime.localAlbums.getCacheInfo().observationCount, 0);
    assert.deepEqual(await fs.readFile(f.audioPath), audio);
  });
});

for (const reason of ['DIRECTORY_TRUNCATED', 'DIRECTORY_UNAVAILABLE', 'PREFERRED_NAMES_AMBIGUOUS'] as const) test(`封面证明边界：${reason}即使读出真实内嵌图也不能获得正proof`, { timeout: 15_000 }, async t => {
  const f = await fixture(t); await ambiguousPictures(f);
  let restore = (): void => {};
  if (reason === 'DIRECTORY_TRUNCATED') {
    // 真实目录触及原512项上限，不提高发现预算。
    for (let base = 0; base < 512; base += 32) await Promise.all(Array.from({ length: 32 }, (_, index) =>
      fs.writeFile(path.join(f.media, `合成占位${base + index}.txt`), '只读目录项')));
  } else {
    const originalOpen = fs.opendir;
    const mocked = t.mock.method(fs, 'opendir', async (...args: Parameters<typeof fs.opendir>) => {
      if (args[0] !== f.media) return originalOpen(...args);
      if (reason === 'DIRECTORY_UNAVAILABLE') throw Object.assign(new Error('合成目录IO故障'), { code: 'EIO' });
      const directory = await originalOpen(...args), template = (await fs.readdir(f.media, { withFileTypes: true })).find(entry => entry.name.endsWith('.png'))!;
      const entries = ['COVER.JPG', 'Cover.JPG'].map(name => new Proxy(template, { get(entry, key) {
        if (key === 'name') return name;
        const value = Reflect.get(entry, key, entry); return typeof value === 'function' ? value.bind(entry) : value;
      } }));
      let index = 0;
      // 仅用受控目录项覆盖大小写敏感性差异；真实目录句柄仍必须关闭。
      return new Proxy(directory, { get(handle, key) {
        if (key === 'read') return async () => entries[index++] ?? null;
        const value = Reflect.get(handle, key, handle); return typeof value === 'function' ? value.bind(handle) : value;
      } });
    });
    syncBuiltinESMExports(); restore = () => { mocked.mock.restore(); syncBuiltinESMExports(); };
  }
  try {
    await observeProof(t, f, async seen => {
      const target = await f.target();
      await assert.rejects(f.runtime.artwork.readSources(target, randomUUID(), undefined, performance.now() + 10_000, 'background'), { code: 'ARTWORK_RECORD_INVALID' });
      assert.equal(seen.saved.length, 0); assert.deepEqual(f.writes, []);
      assert.ok(seen.events.some(event => event.action === 'normalize' && event.state === 'complete'));
      assert.ok(hasCode(seen.events, 'independent.discovery', reason));
      const code = reason === 'PREFERRED_NAMES_AMBIGUOUS' ? 'DISPLAY_PROOF_PREFERRED_AMBIGUOUS' : `DISPLAY_PROOF_${reason}`;
      assert.ok(hasCode(seen.events, 'artwork.display-proof', code));
      const { refresh: _refresh, ...request } = target.request;
      assert.equal(f.runtime.artwork.readCached(request), null);
    });
  } finally { restore(); }
});

test('封面证明边界：非固定名多图和内嵌提取成功但全部解码失败，不能取得正proof', { timeout: 15_000 }, async t => {
  const f = await fixture(t); await ambiguousPictures(f);
  const failed = t.mock.method(getRustMediaWorkerPool(), 'processImage', async () => { throw new RustMediaWorkerError('PARSE_FAILED'); });
  try {
    await observeProof(t, f, async seen => {
      const target = await f.target(), result = await f.runtime.localAlbums.getArtwork(target.request);
      assert.equal(result.status, 'source-unavailable'); assert.equal(result.image, null);
      assert.equal(seen.saved.length, 0); assert.deepEqual(f.writes, []);
      assert.equal(f.runtime.localAlbums.getCacheInfo().observationCount, 0);
    });
  } finally { failed.mock.restore(); }
});

for (const change of ['cancel', 'source-change'] as const) test(`封面证明边界：完整多图发现后${change}仍拒绝，源FD与许可闭合且不落盘`, { timeout: 15_000 }, async t => {
  const f = await fixture(t); await ambiguousPictures(f);
  const controller = new AbortController(), pool = getRustMediaWorkerPool(), original = pool.processImage.bind(pool);
  let entered = false;
  const changed = t.mock.method(pool, 'processImage', async (...args: Parameters<typeof pool.processImage>) => {
    const result = await original(...args); entered = true;
    if (change === 'cancel') controller.abort(); else await fs.appendFile(f.audioPath, Buffer.from([0]));
    return result;
  });
  try {
    await observeProof(t, f, async seen => {
      const target = await f.target();
      await assert.rejects(f.runtime.artwork.readSources(target, randomUUID(), controller.signal, performance.now() + 10_000, 'background'));
      assert.equal(entered, true); assert.equal(seen.saved.length, 0); assert.deepEqual(f.writes, []);
      const { refresh: _refresh, ...request } = target.request;
      assert.equal(f.runtime.artwork.readCached(request), null);
    });
  } finally { changed.mock.restore(); }
});

test('封面证明边界：真实正证明之后资源写失败仍失败，后台不能完成且不发布available', { timeout: 15_000 }, async t => {
  const f = await fixture(t); await ambiguousPictures(f);
  const store = f.repository.privateLocalAlbumArtworkResources!;
  const failed = t.mock.method(store, 'put', () => { assertQuiet(f); throw new LocalAlbumArtworkResourceError('ARTWORK_STORE_FULL'); });
  try {
    const background = f.runtime.background!;
    elapseForegroundQuiet(t); background.start(); await background.runPending(); await background.pause();
    assert.equal(failed.mock.callCount(), 1); assert.equal(background.inspect().complete, 0);
    assert.equal(background.inspect().pending, 1); assert.equal(background.inspect().running, 0);
    assert.deepEqual(f.writes, []); assert.equal(f.runtime.localAlbums.getCacheInfo().observationCount, 0); assertQuiet(f);
  } finally { failed.mock.restore(); }
});


test('封面负证明：完整目录无独立图且真实WAV无内嵌图，原missing仍须COMMIT后才完成后台', { timeout: 15_000 }, async t => {
  const f = await fixture(t), audio = plainWave(); await fs.writeFile(f.audioPath, audio);
  const target = await f.target(), { refresh: _refresh, ...request } = target.request;
  const background = f.runtime.background!;
  elapseForegroundQuiet(t); background.start(); await background.runPending(); await background.pause();
  assert.equal(background.inspect().complete, 1); assert.equal(background.inspect().pending, 0);
  assert.equal(background.inspect().running, 0); assertQuiet(f);
  assert.equal(f.runtime.artwork.persistedState(request), 'missing');
  assert.deepEqual(f.runtime.artwork.readCached(request), { image: null, status: 'ready' });
  assert.deepEqual(f.writes, ['missing']); assert.equal(f.runtime.localAlbums.getCacheInfo().observationCount, 1);
  assert.deepEqual(await fs.readFile(f.audioPath), audio);
});
