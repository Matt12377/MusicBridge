import assert from 'node:assert/strict';
import test, { after, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { fstatSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, writeFile, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type * as dto from '@music-bridge/contracts';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { createLocalSourceReadProjection } from '../../src/collection/local-source-read-projection.js';
import { createLocalAlbumArtworkReader } from '../../src/collection/local-album-browser/artwork-read-port.js';
import { createLocalAlbumOwnerService } from '../../src/collection/local-album-browser/owner-port.js';
import type { LocalAlbumArtworkReadContext } from '../../src/collection/local-album-browser/types.js';
import type { DatasetProjectionPort } from '../../src/collection/dataset-owner-protocol.js';
import { createScanReadAdmission } from '../../src/library/scan-read-admission.js';
import { closeRustMediaWorkerPool } from '../../src/library/rust-media-worker.js';
import { authorizeSourceDirectory } from '../../src/recording/source-files.js';

after(() => closeRustMediaWorkerPool());
const delay = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

async function fixture(t: TestContext) {
  const temporary = process.env.TMPDIR;
  assert.ok(temporary && path.isAbsolute(temporary));
  if (process.platform === 'darwin') assert.ok(temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'));
  const directory = await mkdtemp(path.join(temporary, 'musicbridge-source-budget-')), media = path.join(directory, 'media');
  const relative = '合成专辑/同名内层/song.wav', coverRelative = '合成专辑/同名内层/cover.png';
  await mkdir(path.dirname(path.join(media, relative)), { recursive: true });
  const audio = await readFile(new URL('../fixtures/mbrs003/audio/fixtures/core-wav.wav', import.meta.url));
  const png = await readFile(new URL('../fixtures/mbrs003/audio/inputs/cover-small.png', import.meta.url));
  await writeFile(path.join(media, relative), audio, { flag: 'wx' }); await writeFile(path.join(media, coverRelative), png, { flag: 'wx' });
  const repository = createCollectionRepository({ filePath: path.join(directory, 'collection.sqlite') });
  const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media));
  const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' });
  const asset = repository.localCatalog.registerAsset({ commandId: randomUUID(), libraryRootId: root.id, expectedRootRevision: root.revision,
    relative, sha256: null, sampleFrames: null, timebaseHz: null });
  const track = repository.localCatalog.createTrack({ commandId: randomUUID(), assetId: asset.id, segment: null });
  const gate = createScanReadAdmission({ isBusy: () => false }), scope = { datasetId: randomUUID(), epoch: randomUUID() };
  const held = new Set<string>(), tasks: Promise<unknown>[] = [], opened: FileHandle[] = [];
  let deferredAcquires = 0, releases = 0;
  const projection: DatasetProjectionPort = { async call(command, payload) {
    if (command === 'scanReadAcquire') {
      const value = gate.acquire(scope, Object.hasOwn(payload, 'purpose') ? 'local-album-display' : 'scan');
      if (value.status === 'granted') held.add(value.permitId); else deferredAcquires++;
      return value as never;
    }
    if (command === 'scanReadWatchRevocation') return gate.watchRevocation(scope, (payload as { permitId: string }).permitId) as never;
    if (command === 'scanReadRelease') {
      const id = (payload as { permitId: string }).permitId;
      // 真正来源关闭先于票据释放，排队/超时不能绕过此处。
      if (coverHandle) assert.equal(coverHandle.fd, -1);
      held.delete(id); releases++; return gate.release(scope, id) as never;
    }
    throw new Error('合成读图只调用原准入。');
  } };
  const shared = createLocalSourceReadProjection({ projection, assertCurrent() {} });
  const artwork = createLocalAlbumArtworkReader({ repository, datasetId: scope.datasetId, projection: shared.port, assertCurrent() {} });
  const albums = createLocalAlbumOwnerService({ repository, assertCurrent() {},
    readRootViews: async () => [{ root, label: '合成来源', availability: 'ONLINE' as const }],
    async readArtwork() { throw new Error('此夹具不替代真实读图。'); } });
  const page = await albums.queryAlbums({ rootId: root.id, query: '', filter: 'all', offset: 0, limit: 1 });
  const album = page.items[0]!; assert.equal(album.representativeTrackId, track.id);
  const detail = repository.localCatalog.trackDetail(track.id);
  const request: dto.LocalAlbumArtworkRequest = { albumKey: album.id, rootId: album.rootId, revision: album.revision,
    editionId: album.editionId, representativeTrackId: album.representativeTrackId };
  const context: LocalAlbumArtworkReadContext = { album, directory: path.posix.dirname(relative), representative: {
    relative, summary: { track: detail.track, asset: detail.asset, metadata: detail.metadata.effective, versionTokens: detail.versionTokens },
    rawMetadata: detail.metadata.raw, hasArtwork: false, artworkRevision: null } };
  const probe = await open(path.join(media, coverRelative), 'r'), prototype = Object.getPrototypeOf(probe), originalRead = prototype.read;
  await probe.close(); const identity = await lstat(path.join(media, coverRelative));
  const entered = deferred(), resume = deferred(); let coverHandle: FileHandle | undefined, coverFd = -1, hold = false, heldOnce = false;
  t.mock.method(prototype, 'read', async function(this: FileHandle, ...args: unknown[]) {
    const info = fstatSync(this.fd);
    if (hold && !heldOnce && info.dev === identity.dev && info.ino === identity.ino) {
      heldOnce = true; coverHandle = this; coverFd = this.fd; entered.resolve(); await resume.promise;
    }
    return Reflect.apply(originalRead, this, args);
  });
  t.after(async () => {
    resume.resolve(); for (const handle of opened) if (handle.fd !== -1) await handle.close();
    for (const id of [...held]) { await shared.port.call('scanReadRelease', { permitId: id }); }
    await artwork.close(); await Promise.allSettled(tasks); await shared.close(); albums.close(); gate.close(); repository.close();
    assert.equal(gate.resourceCounts().permits, 0); assert.equal(gate.resourceCounts().watches, 0);
    assert.deepEqual(await readFile(path.join(media, relative)), audio); assert.deepEqual(await readFile(path.join(media, coverRelative)), png);
  });
  function read(mode: 'display'|'background', deadlineAtMs?: number) {
    const task = artwork.readSources({ request, context }, randomUUID(), undefined, deadlineAtMs, mode);
    tasks.push(task); void task.catch(() => {}); return task;
  }
  async function metadataPermit() {
    const handle = await open(path.join(media, relative), 'r'); opened.push(handle);
    const value = await shared.port.call('scanReadAcquire', {}); assert.equal(value.status, 'granted');
    if (value.status !== 'granted') assert.fail('合成元数据票据未授予。');
    return { async close() { await handle.close(); await shared.port.call('scanReadRelease', { permitId: value.permitId }); } };
  }
  return { shared, gate, read, metadataPermit, entered, resume, hold() { hold = true; },
    fd: () => coverFd, handle: () => coverHandle, deferred: () => deferredAcquires, releases: () => releases };
}

test('Owner 真实封面：元数据占满两槽时后台排队，释放后同次请求读取两层目录封面', { timeout: 15_000 }, async t => {
  const f = await fixture(t), first = await f.metadataPermit(), second = await f.metadataPermit();
  const cover = f.read('background'), deadline = performance.now() + 1000;
  while (f.shared.inspect().pending === 0 && performance.now() < deadline) await delay(5);
  assert.equal(f.shared.inspect().pending, 1); assert.equal(f.gate.resourceCounts().permits, 2);
  await first.close(); const result = await cover;
  assert.equal(result.copies.status, 'ready'); assert.ok(result.image); assert.equal(f.deferred(), 0);
  await second.close(); assert.equal(f.gate.resourceCounts().permits, 0); assert.equal(f.shared.inspect().active, 0);
});

test('Owner 真实封面：后台源读取超过两秒仍在原十秒期限内成功，前台两秒仍取消', { timeout: 15_000 }, async t => {
  for (const mode of ['background', 'display'] as const) {
    const f = await fixture(t); f.hold(); const task = f.read(mode);
    await Promise.race([f.entered.promise, task.then(() => assert.fail('没有进入真实封面 FD。'))]);
    await delay(2150); f.resume.resolve();
    if (mode === 'background') { const result = await task; assert.equal(result.copies.status, 'ready'); assert.ok(result.image); }
    else await assert.rejects(task);
    // 数字 FD 可被后续资源库写入复用；原 FileHandle 的关闭和释放观察器才是同一来源证据。
    assert.equal(f.handle()!.fd, -1); assert.ok(f.releases() > 0);
    assert.equal(f.gate.resourceCounts().permits, 0); assert.equal(f.shared.inspect().active, 0);
  }
});

test('Owner 真实封面：原绝对期限到达仍等真实 FD quiet，不会提前释放 Core 或调度槽', { timeout: 10_000 }, async t => {
  const f = await fixture(t); f.hold(); const task = f.read('background', performance.now() + 200);
  let settled = false; void task.finally(() => { settled = true; }).catch(() => {});
  await Promise.race([f.entered.promise, task.then(() => assert.fail('没有进入真实封面 FD。'))]);
  await delay(250); assert.equal(settled, false); assert.ok(fstatSync(f.fd()).isFile());
  assert.equal(f.gate.resourceCounts().permits, 1); assert.equal(f.shared.inspect().active, 1);
  f.resume.resolve(); await assert.rejects(task);
  assert.equal(f.handle()!.fd, -1); assert.equal(f.gate.resourceCounts().permits, 0); assert.equal(f.shared.inspect().active, 0);
});
