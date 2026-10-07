import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { fstatSync } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import type { LocalArtworkImage, LocalArtworkSourceCopies, LocalArtworkTarget } from '@music-bridge/contracts';
import { createCollectionRepository } from '../src/collection/repository.js';
import { createLocalArtworkService } from '../src/collection/local-artwork-service.js';
import type { DatasetProjectionCommand, DatasetProjectionCommandPayloads, DatasetProjectionCommandResults, DatasetProjectionPort } from '../src/collection/dataset-owner-protocol.js';
import { authorizeSourceDirectory } from '../src/recording/source-files.js';
import { createScanReadAdmission } from '../src/library/scan-read-admission.js';
import { PhysicalResourceBusy, physicalResourceLocks } from '../src/stream/physical-resource-locks.js';

const hash = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const portableRoot = new URL('./fixtures/mbrs003/audio/', import.meta.url);
type Copy = LocalArtworkSourceCopies['items'][number];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function eventually(check: () => boolean, message: string): Promise<void> {
  const end = performance.now() + 2000;
  while (!check() && performance.now() < end) await delay(5);
  assert.equal(check(), true, message);
}
/** 复用已封的真实合成 FLAC/WAV/PNG；不启动旧 Reader 或重放旧 003 Gate。 */
async function portableBytes(id: string): Promise<Buffer> {
  const raw = await readFile(new URL('manifest.json', portableRoot));
  assert.equal(hash(raw), '5e4157b8fa3428a82def6c128e5e60dce3cc90186b804d835c9be8e957c8feb1');
  const manifest = JSON.parse(raw.toString('utf8')) as { synthetic: boolean; files: Array<{ id: string; file: string; bytes: number; sha256: string }> };
  assert.equal(manifest.synthetic, true);
  const entry = manifest.files.find(value => value.id === id); assert.ok(entry);
  assert.match(entry.file, /^(?:fixtures|inputs)\/[A-Za-z0-9.-]+$/u);
  const bytes = await readFile(new URL(entry.file, portableRoot));
  assert.equal(bytes.length, entry.bytes); assert.equal(hash(bytes), entry.sha256);
  return bytes;
}
/** 仅替代可信 Main 的展示副本输入，不把此小载荷称为完整图像解码证据。 */
function trustedImage(original: Uint8Array): LocalArtworkImage {
  const display = Buffer.from([255, 216, 7, 255, 217]);
  return { original: { mime: 'image/png', bytes: original.length, sha256: hash(original), width: 16, height: 16 },
    display: { mime: 'image/jpeg', bytes: display.length, sha256: hash(display), width: 1, height: 1, dataUrl: `data:image/jpeg;base64,${display.toString('base64')}` } };
}
function persisted(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return { selections: db.prepare('SELECT data FROM local_artwork_selections ORDER BY edition_id').all().map(row => JSON.parse(String(row.data)) as unknown),
      candidates: Number(db.prepare('SELECT count(*) n FROM local_artwork_candidates').get()!.n),
      editions: Number(db.prepare('SELECT count(*) n FROM local_catalog_editions').get()!.n),
      intents: Number(db.prepare('SELECT count(*) n FROM local_artwork_create_intents').get()!.n) };
  } finally { db.close(); }
}

async function fixture(t: test.TestContext, options: { independent?: boolean; audio?: string; beforeCommit?: (action: string) => void } = {}) {
  const temporary = process.env.TMPDIR;
  if (typeof temporary !== 'string' || !path.isAbsolute(temporary) || (process.platform === 'darwin' && !(process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted') && !temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'))) {
    throw new Error('本机合成源与 SQLite 必须在外置任务临时根');
  }
  const directory = await mkdtemp(path.join(temporary, 'artwork-service-')), media = path.join(directory, 'media');
  await mkdir(media, { mode: 0o700 });
  const audioBytes = await portableBytes(options.audio ?? 'core-flac'), coverBytes = await portableBytes('cover-small');
  const audioPath = path.join(media, 'track.bin'), coverPath = path.join(media, 'cover.png');
  await writeFile(audioPath, audioBytes, { flag: 'wx', mode: 0o600 });
  if (options.independent) await writeFile(coverPath, coverBytes, { flag: 'wx', mode: 0o600 });
  const file = path.join(directory, 'library.sqlite');
  const repository = createCollectionRepository({ filePath: file, ...(options.beforeCommit ? { beforeCommit: options.beforeCommit } : {}) });
  const catalog = repository.localCatalog, source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media));
  const library = catalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' });
  const asset = catalog.registerAsset({ commandId: randomUUID(), libraryRootId: library.id, expectedRootRevision: library.revision,
    relative: 'track.bin', sha256: null, sampleFrames: null, timebaseHz: null });
  const track = catalog.createTrack({ commandId: randomUUID(), assetId: asset.id, segment: null });
  const edition = catalog.createEdition({ commandId: randomUUID(), title: '合成独立发行', edition: '' });
  catalog.linkEditionTrack({ commandId: randomUUID(), editionId: edition.id, trackId: track.id, disc: 1, trackNumber: 1, sequence: 1 });
  const request = { trackId: track.id, editionId: edition.id }, target = repository.localArtwork.context(request).target!;
  const scope = { epoch: randomUUID(), datasetId: randomUUID() }, calls: string[] = [], statuses: string[] = [], reasons: string[] = [];
  let busy = false, onRelease = (): void => {};
  const admission = createScanReadAdmission({ isBusy: () => busy });
  const projection: DatasetProjectionPort = { async call<K extends DatasetProjectionCommand>(command: K, payload: DatasetProjectionCommandPayloads[K]): Promise<DatasetProjectionCommandResults[K]> {
    calls.push(command); let result: unknown;
    if (command === 'scanReadAcquire') { result = admission.acquire(scope); statuses.push((result as { status: string }).status); }
    else if (command === 'scanReadWatchRevocation') {
      result = await admission.watchRevocation(scope, (payload as { permitId: string }).permitId); reasons.push((result as { reason: string }).reason);
    } else if (command === 'scanReadRelease') { onRelease(); result = admission.release(scope, (payload as { permitId: string }).permitId); }
    else throw new Error('封面测试只允许真实低优先级扫描准入');
    return result as DatasetProjectionCommandResults[K];
  } };
  const service = createLocalArtworkService({ repository, projection, assertCurrent: () => { repository.list({ offset: 0, limit: 1 }); } });
  const beforeClose: Array<() => void> = [], extraClose: Array<() => Promise<void>> = [];
  t.after(async () => {
    for (const release of beforeClose) release();
    try { await service.close(); } finally {
      for (const close of extraClose) await close();
      admission.close(); repository.close(); await rm(directory, { recursive: true, force: true });
    }
  });
  const info = await stat(audioPath, { bigint: true }), resource = { dev: String(info.dev), ino: String(info.ino) };
  function quiet(): void {
    assert.deepEqual(admission.resourceCounts(), { permits: 0, revoked: 0, watches: 0, timers: 0, closed: false });
    assert.deepEqual(physicalResourceLocks.snapshot(), { readers: 0, writers: 0, resources: 0 });
  }
  const copies = () => service.readCandidates({ target: { ...target }, lookupId: randomUUID() });
  const stageBody = (copy: Copy, at: LocalArtworkTarget = target) => ({ target: { ...at }, origin: copy.origin,
    sourceIdentity: copy.sourceIdentity, sourceLabel: copy.sourceLabel, image: trustedImage(Buffer.from(copy.base64, 'base64')) });
  async function manual() {
    const view = await service.stage({ target: { ...target }, origin: 'manual', sourceIdentity: hash('合成人工来源'), sourceLabel: '合成手选', image: trustedImage(coverBytes) });
    return service.apply({ commandId: randomUUID(), target: { ...target }, candidateId: view.candidates.find(value => value.origin === 'manual')!.id, expectedSelectionRevision: null });
  }
  return { directory, file, media, repository, catalog, source, library, asset, track, edition, request, target, resource,
    service, admission, projection, calls, statuses, reasons, beforeClose, extraClose, audioPath, audioBytes, coverPath, coverBytes, quiet, copies, stageBody, manual,
    setBusy(value: boolean) { busy = value; admission.observe(); }, onRelease(value: () => void) { onRelease = value; } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
interface ObservedFd { handle: FileHandle; fd: number; inode: string }
/** 只改变测试自有 FD 的消费时序；SourceRoot、实际 read/close 和物理读保护均保持产品实现。 */
async function observeFd(t: test.TestContext, f: Fixture, options: { pauseRead?: boolean; pauseClose?: boolean; failRead?: boolean } = {}) {
  const probe = await open(f.audioPath, 'r'), prototype = Object.getPrototypeOf(probe) as { read: FileHandle['read'] }; await probe.close();
  const original = prototype.read, reads: Array<{ fd: number; position: number; length: number }> = [], handles = new Map<FileHandle, ObservedFd>();
  const readEntered = deferred<ObservedFd>(), closeEntered = deferred<ObservedFd>(), finishRead = deferred<void>(), finishClose = deferred<void>();
  const resources = new Set([f.resource.dev + ':' + f.resource.ino]);
  if (await stat(f.coverPath).then(() => true, () => false)) {
    const cover = await stat(f.coverPath, { bigint: true }); resources.add(`${cover.dev}:${cover.ino}`);
  }
  if (!options.pauseRead) finishRead.resolve(); if (!options.pauseClose) finishClose.resolve();
  f.beforeClose.push(() => { finishRead.resolve(); finishClose.resolve(); });
  t.mock.method(prototype, 'read', async function(this: FileHandle, buffer: Buffer, offset: number, length: number, position: number) {
    const info = fstatSync(this.fd, { bigint: true }), inode = `${info.dev}:${info.ino}`;
    if (!resources.has(inode)) return Reflect.apply(original, this, [buffer, offset, length, position]) as ReturnType<FileHandle['read']>;
    let observed = handles.get(this);
    if (!observed) {
      observed = { handle: this, fd: this.fd, inode }; handles.set(this, observed);
      const held = observed, close = this.close.bind(this);
      this.close = async () => { closeEntered.resolve(held); await finishClose.promise; await close(); };
    }
    assert.equal(Number.isSafeInteger(position), true); assert.ok(length <= 64 * 1024);
    assert.equal(physicalResourceLocks.snapshot().writers, 0, '封面读取不得取得音频排他锁');
    reads.push({ fd: this.fd, position, length });
    const result = await Reflect.apply(original, this, [buffer, offset, length, position]) as { bytesRead: number; buffer: Buffer };
    readEntered.resolve(observed); await finishRead.promise;
    if (options.failRead) throw new Error('合成 FD 消费失败');
    return result;
  });
  f.onRelease(() => {
    for (const fd of handles.values()) {
      assert.equal(fd.handle.fd, -1, 'scanReadRelease 前借用句柄必须关闭');
      assert.throws(() => fstatSync(fd.fd), (error: unknown) => (error as NodeJS.ErrnoException).code === 'EBADF', '许可释放必须有真实 EBADF 证据');
    }
    assert.equal(physicalResourceLocks.snapshot().writers, 0);
    assert.equal(physicalResourceLocks.snapshot().readers, 0);
  });
  return { reads, handles, readEntered, closeEntered, finishRead: () => finishRead.resolve(), finishClose: () => finishClose.resolve() };
}

test('服务通过真实 FD 返回独立/内嵌原图，SQLite staging 与 apply 保持分离', async t => {
  const f = await fixture(t, { independent: true }), spy = await observeFd(t, f), before = f.catalog.asset(f.asset.id);
  const copies = await f.copies(); assert.equal(copies.status, 'ready');
  assert.deepEqual(copies.items.map(item => item.origin), ['local-independent', 'embedded']);
  for (const copy of copies.items) assert.deepEqual(Buffer.from(copy.base64, 'base64'), f.coverBytes);
  assert.equal(new Set(copies.items.map(item => item.sourceIdentity)).size, 2, '同图片不同来源不能合并');
  assert.equal(persisted(f.file).candidates, 0); assert.deepEqual(persisted(f.file).selections, []);
  for (const copy of [...copies.items].reverse()) await f.service.stage(f.stageBody(copy));
  const staged = f.service.context(f.request); assert.equal(staged.selection, null);
  assert.deepEqual(staged.candidates.map(item => item.origin), ['local-independent', 'embedded']); assert.equal(persisted(f.file).candidates, 2);
  const selected = await f.service.apply({ commandId: randomUUID(), target: { ...f.target }, candidateId: null, expectedSelectionRevision: null });
  assert.equal(selected.mode, 'local-default'); assert.equal(selected.candidate!.origin, 'local-independent');
  assert.deepEqual(persisted(f.file).selections, [selected]); assert.ok(spy.reads.length > 1);
  assert.deepEqual(f.catalog.asset(f.asset.id), before); assert.deepEqual(await readFile(f.audioPath), f.audioBytes); assert.deepEqual(await readFile(f.coverPath), f.coverBytes);
  f.quiet();
});

test('缺独立图时提取内嵌；无内嵌的真实 WAV 返回缺图且不创建选择', async t => {
  const embedded = await fixture(t), spy = await observeFd(t, embedded), copies = await embedded.copies();
  assert.equal(copies.status, 'ready'); assert.equal(copies.items.length, 1); assert.equal(copies.items[0]!.origin, 'embedded');
  assert.deepEqual(Buffer.from(copies.items[0]!.base64, 'base64'), embedded.coverBytes); assert.ok(spy.reads.length > 0); embedded.quiet();
  const missing = await fixture(t, { audio: 'core-wav' });
  assert.deepEqual(await missing.copies(), { status: 'ready', items: [] }, '已成功读取但无图，不能误报来源不可用');
  assert.deepEqual(missing.statuses, ['granted']);
  assert.equal(missing.service.context(missing.request).status, 'missing');
  assert.equal(missing.service.context(missing.request).selection, null); assert.equal(persisted(missing.file).candidates, 0); missing.quiet();
});

test('真实准入媒体忙时 deferred 不读 FD，不改变已有手选', async t => {
  const f = await fixture(t, { independent: true }), selected = await f.manual(), spy = await observeFd(t, f);
  f.setBusy(true); assert.deepEqual(await f.copies(), { status: 'source-unavailable', items: [] });
  assert.deepEqual(f.statuses, ['deferred']); assert.deepEqual(f.calls, ['scanReadAcquire']); assert.equal(spy.reads.length, 0);
  assert.deepEqual(f.service.context(f.request).selection, selected); assert.deepEqual(persisted(f.file).selections, [selected]); f.quiet();
});

test('取消等待真实 FD 消费与 close，关闭前 scanRead 许可和共享读保护仍占用', async t => {
  const f = await fixture(t), selected = await f.manual(), spy = await observeFd(t, f, { pauseRead: true, pauseClose: true });
  const lookupId = randomUUID(), pending = f.service.readCandidates({ target: { ...f.target }, lookupId });
  const rejected = assert.rejects(pending, /取消|CANCELLED/u); const held = await spy.readEntered.promise;
  assert.equal(f.service.cancelLookup(lookupId).cancelled, true); await delay(20);
  assert.equal(f.calls.includes('scanReadRelease'), false); assert.equal(f.admission.resourceCounts().permits, 1); assert.ok(fstatSync(held.fd).isFile());
  const anotherReader = physicalResourceLocks.acquireRead([f.resource]); assert.equal(physicalResourceLocks.snapshot().readers, 2); await anotherReader.release();
  assert.throws(() => physicalResourceLocks.acquireWrite([f.resource]), PhysicalResourceBusy);
  spy.finishRead(); await spy.closeEntered.promise;
  assert.ok(fstatSync(held.fd).isFile()); assert.equal(f.admission.resourceCounts().permits, 1); assert.equal(f.calls.includes('scanReadRelease'), false);
  spy.finishClose(); await rejected; assert.equal(held.handle.fd, -1); assert.equal(f.service.cancelLookup(lookupId).cancelled, false);
  assert.deepEqual(f.service.context(f.request).selection, selected); assert.deepEqual(persisted(f.file).selections, [selected]); f.quiet();
  const writer = physicalResourceLocks.acquireWrite([f.resource]); await writer.release();
});

test('在途媒体忙通知撤销真实许可，仍等 FD quiet，保留已有手选', async t => {
  const f = await fixture(t), selected = await f.manual(), spy = await observeFd(t, f, { pauseRead: true, pauseClose: true });
  const pending = f.copies(), rejected = assert.rejects(pending, /取消|CANCELLED/u); await spy.readEntered.promise;
  f.setBusy(true); await eventually(() => f.reasons.includes('media-busy'), '实际 revocation watch 必须收到媒体忙');
  assert.equal(f.admission.resourceCounts().revoked, 1); assert.equal(f.admission.resourceCounts().permits, 1);
  spy.finishRead(); await spy.closeEntered.promise; assert.equal(f.calls.includes('scanReadRelease'), false);
  spy.finishClose(); await rejected; assert.deepEqual(f.service.context(f.request).selection, selected); f.quiet();
});

test('catalog 源修订变化拒绝旧 stage/apply；相同发行的已存手选仍保留', async t => {
  const f = await fixture(t, { independent: true }), selected = await f.manual(), copy = (await f.copies()).items[0]!;
  const staged = await f.service.stage(f.stageBody(copy)), candidate = staged.candidates.find(value => value.origin === 'local-independent')!;
  f.catalog.replaceAsset({ commandId: randomUUID(), assetId: f.asset.id, libraryRootId: f.library.id, expectedRootRevision: f.library.revision,
    expectedFileRevision: f.asset.fileRevision, expectedLocationRevision: f.asset.locationRevision, relative: 'track.bin', sha256: null, sampleFrames: null, timebaseHz: null });
  const fresh = f.service.context(f.request).target!; assert.notEqual(fresh.expectedSourceRevision, f.target.expectedSourceRevision);
  for (const at of [f.target, fresh]) {
    await assert.rejects(f.service.stage(f.stageBody(copy, at)), /改变|失效/u);
    await assert.rejects(f.service.apply({ commandId: randomUUID(), target: { ...at }, candidateId: candidate.id, expectedSelectionRevision: selected.revision }), /改变/u);
  }
  assert.deepEqual(f.service.context(f.request).selection, selected); assert.deepEqual(persisted(f.file).selections, [selected]); f.quiet();
});

test('独立封面原子替换即使字节相同，也拒绝旧 stage/apply 并保留手选', async t => {
  const f = await fixture(t, { independent: true }), selected = await f.manual(), copy = (await f.copies()).items[0]!;
  const candidate = (await f.service.stage(f.stageBody(copy))).candidates.find(value => value.origin === 'local-independent')!;
  const before = await stat(f.coverPath, { bigint: true }), replacement = path.join(f.media, '合成替换.png');
  await writeFile(replacement, f.coverBytes, { flag: 'wx' }); await rename(replacement, f.coverPath);
  assert.notEqual((await stat(f.coverPath, { bigint: true })).ino, before.ino);
  await assert.rejects(f.service.stage(f.stageBody(copy)), /改变/u);
  await assert.rejects(f.service.apply({ commandId: randomUUID(), target: { ...f.target }, candidateId: candidate.id, expectedSelectionRevision: selected.revision }), /改变/u);
  assert.deepEqual(persisted(f.file).selections, [selected]); f.quiet();
});

test('SourceRoot 撤销后不读取候选且拒绝旧 stage/apply，已存手选保留', async t => {
  const f = await fixture(t, { independent: true }), selected = await f.manual(), copy = (await f.copies()).items[0]!;
  const candidate = (await f.service.stage(f.stageBody(copy))).candidates.find(value => value.origin === 'local-independent')!;
  f.repository.sources.revoke({ commandId: randomUUID(), id: f.source.id });
  const spy = await observeFd(t, f);
  assert.deepEqual(await f.copies(), { status: 'source-unavailable', items: [] }); assert.equal(spy.reads.length, 0);
  await assert.rejects(f.service.stage(f.stageBody(copy)), /改变/u);
  await assert.rejects(f.service.apply({ commandId: randomUUID(), target: { ...f.target }, candidateId: candidate.id, expectedSelectionRevision: selected.revision }), /改变/u);
  assert.deepEqual(persisted(f.file).selections, [selected]); f.quiet();
});

test('音频源原子替换即使字节相同，也拒绝此前独立图的旧 stage/apply', async t => {
  const f = await fixture(t, { independent: true }), selected = await f.manual(), copy = (await f.copies()).items[0]!;
  const candidate = (await f.service.stage(f.stageBody(copy))).candidates.find(value => value.origin === 'local-independent')!;
  const before = await stat(f.audioPath, { bigint: true }), replacement = path.join(f.media, '合成替换音频.bin');
  await writeFile(replacement, f.audioBytes, { flag: 'wx' }); await rename(replacement, f.audioPath);
  assert.notEqual((await stat(f.audioPath, { bigint: true })).ino, before.ino);
  // 新查找也不能以同一个来源键覆盖旧 capture，使旧 stage/apply 重新获得许可。
  const fresh = (await f.copies()).items.find(item => item.origin === 'local-independent')!; assert.ok(fresh);
  const staged = await Promise.allSettled([f.service.stage(f.stageBody(copy))]);
  const applied = await Promise.allSettled([f.service.apply({ commandId: randomUUID(), target: { ...f.target }, candidateId: candidate.id, expectedSelectionRevision: selected.revision })]);
  t.diagnostic(`音频同字节替换后：旧 stage=${staged[0]!.status}，旧 apply=${applied[0]!.status}`);
  assert.notEqual(fresh.sourceIdentity, copy.sourceIdentity, '音频来源身份变化必须进入新候选来源键');
  assert.equal(staged[0]!.status, 'rejected', '实际音频源身份变化后旧独立图暂存必须拒绝');
  assert.equal(applied[0]!.status, 'rejected', '实际音频源身份变化后旧候选应用必须拒绝');
  assert.deepEqual(persisted(f.file).selections, [selected]); f.quiet();
});

test('服务 FD 消费失败仍真实关闭句柄与许可，不留音频排他锁或改变手选', async t => {
  const f = await fixture(t, { independent: true }), selected = await f.manual(), spy = await observeFd(t, f, { failRead: true });
  await assert.rejects(f.copies(), /合成 FD 消费失败/u); assert.ok(spy.reads.length > 0);
  assert.deepEqual(f.service.context(f.request).selection, selected); assert.deepEqual(persisted(f.file).selections, [selected]); f.quiet();
  await f.service.close(); assert.throws(() => f.service.context(f.request), /停止/u);
  const writer = physicalResourceLocks.acquireWrite([f.resource]); await writer.release();
});

test('服务 close 等实际 FD close；停止后入口拒绝，既有选择和音频事实保留', async t => {
  const f = await fixture(t), selected = await f.manual(), before = f.catalog.asset(f.asset.id), spy = await observeFd(t, f, { pauseRead: true, pauseClose: true });
  const pending = f.copies(), rejected = assert.rejects(pending, /停止|取消|CANCELLED/u); const held = await spy.readEntered.promise;
  let closed = false; const closing = f.service.close().then(() => { closed = true; }); await delay(20);
  assert.equal(closed, false); assert.ok(fstatSync(held.fd).isFile()); assert.equal(f.admission.resourceCounts().permits, 1);
  spy.finishRead(); await spy.closeEntered.promise; assert.equal(closed, false); assert.equal(f.calls.includes('scanReadRelease'), false);
  spy.finishClose(); await rejected; await closing; assert.equal(closed, true); f.quiet();
  assert.throws(() => f.service.context(f.request), /停止/u);
  await assert.rejects(f.service.stage({ target: { ...f.target }, origin: 'manual', sourceIdentity: hash('关闭后合成来源'), sourceLabel: '合成图片', image: trustedImage(f.coverBytes) }), /停止/u);
  assert.deepEqual(persisted(f.file).selections, [selected]); assert.deepEqual(f.catalog.asset(f.asset.id), before); assert.deepEqual(await readFile(f.audioPath), f.audioBytes);
});

test('partial create 在真实 SQLite 重启后重放完整请求，改修订拒绝且不重复建立发行', async t => {
  let failLink = false, failures = 0;
  const f = await fixture(t, { beforeCommit(action) { if (failLink && action === 'local-catalog:link-edition-track') { failures++; throw new Error('合成链接提交失败'); } } });
  const request = { commandId: randomUUID(), trackId: f.track.id, expectedTrackRevision: f.track.selectionRevision, title: '合成新发行' };
  failLink = true; assert.throws(() => f.service.createEdition(request), /库存暂时不可用/u); assert.equal(failures, 1);
  assert.equal(persisted(f.file).editions, 2); assert.equal(persisted(f.file).intents, 1); assert.equal(f.catalog.trackDetail(f.track.id).editions.length, 1);
  await f.service.close(); f.repository.close();
  const cold = createCollectionRepository({ filePath: f.file });
  const service = createLocalArtworkService({ repository: cold, projection: f.projection, assertCurrent: () => { cold.list({ offset: 0, limit: 1 }); } });
  f.extraClose.push(async () => { await service.close(); cold.close(); });
  assert.throws(() => service.createEdition({ ...request, expectedTrackRevision: '2' }), /同一操作编号/u);
  assert.throws(() => service.createEdition({ ...request, title: '改变后的合成标题' }), /同一操作编号/u);
  assert.equal(persisted(f.file).editions, 2);
  const completed = service.createEdition({ ...request }); assert.equal(completed.title, request.title);
  assert.deepEqual(service.createEdition({ ...request }), completed); assert.equal(persisted(f.file).editions, 2);
  assert.equal(cold.localCatalog.trackDetail(f.track.id).editions.length, 2);
  assert.throws(() => service.createEdition({ ...request, expectedTrackRevision: '2' }), /同一操作编号/u);
  assert.deepEqual(persisted(f.file).selections, []); f.quiet();
});
