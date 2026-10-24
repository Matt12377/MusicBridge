import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { fstatSync } from 'node:fs';
import fsp, { lstat, mkdir, mkdtemp, readFile, realpath, writeFile, type FileHandle } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import type { ScanJobRecord } from '@music-bridge/contracts';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { createLocalScanCoordinator } from '../../src/collection/local-scan-coordinator.js';
import type { ScanDiscovery, ScanPreparedBatch } from '../../src/collection/local-scan-store.js';
import { createBackupWorkflowStore } from '../../src/recording/backup-workflow-store.js';
import { authorizeSourceDirectory } from '../../src/recording/source-files.js';
import { createScanReadAdmission } from '../../src/library/scan-read-admission.js';
import { RUST_MEDIA_METADATA_PARSER_VERSION, type MetadataReaderPort } from '../../src/library/metadata-reader-types.js';
import type { CueSidecarBulkLifecycle } from '../../src/library/cue-sidecar-bulk-reader.js';
import type { CueSidecarLifecycle } from '../../src/library/cue-sidecar-reader.js';
import { readLibraryOperationLine } from '../../src/shared/library-operation-log.js';
import type { DatasetProjectionPort, DatasetProjectionCommand, DatasetProjectionCommandPayloads,
  DatasetProjectionCommandResults } from '../../src/collection/dataset-owner-protocol.js';
import { freshBulkCueReader, freshLegacyCueReader } from '../helpers/fresh-cue-bulk-reader.js';

const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
async function until(check: () => boolean, message: string): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!check()) { assert.ok(performance.now() < deadline, message); await turn(); }
}
type Lifecycle = CueSidecarBulkLifecycle | CueSidecarLifecycle;

/** 仅内容解析port使用合成音频事实；授权、CUE真实Worker/FD、持久发现、SQL、Core票据和冻结账本均为原实现。 */
async function fixture(t: TestContext, cap: 1 | 2 | 8 = 8, cues = 9) {
  const temporary = process.env.TMPDIR;
  assert.ok(temporary && path.isAbsolute(temporary) && (temporary === '/Volumes/LifeWeave/Developer/CommandLine/tmp'
    || temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/')));
  assert.ok((await lstat(temporary)).isDirectory()); assert.equal(await realpath(temporary), path.resolve(temporary));
  const directory = await mkdtemp(path.join(temporary, 'musicbridge-cue-prefetch-')), media = path.join(directory, 'media'); await mkdir(media);
  await writeFile(path.join(media, 'disc.wav'), Buffer.from('合成解析port输入'), { flag: 'wx', mode: 0o600 });
  const bytes = Buffer.from('FILE "disc.wav" WAVE\n TRACK 01 AUDIO\n INDEX 01 00:00:00\n');
  const relatives = Array.from({ length: cues }, (_, index) => `${String(index).padStart(2, '0')}.cue`);
  for (const relative of relatives) await writeFile(path.join(media, relative), bytes, { flag: 'wx', mode: 0o600 });
  const database = path.join(directory, 'collection.sqlite'), repository = createCollectionRepository({ filePath: database }); repository.localCatalog.roots();
  const state = createBackupWorkflowStore({ filePath: path.join(directory, 'identity.sqlite') }), identity = state.datasetIdentities.bind('default', database, false);
  repository.localCatalog.privateBindWorkbenchDataset(identity); const settings = repository.localCatalog.privateScanSettingsStore(identity);
  const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media));
  const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' });
  const gate = createScanReadAdmission({ isBusy: () => false, concurrency: 8 }), context = { datasetId: identity.datasetId, epoch: randomUUID() };
  let deferredAcquires = 0, audioActive = 0;
  let audioHook: (input: Parameters<MetadataReaderPort['read']>[0], signal?: AbortSignal) => Promise<void> = async () => {};
  const projection: DatasetProjectionPort = { async call<K extends DatasetProjectionCommand>(command: K, payload: DatasetProjectionCommandPayloads[K]): Promise<DatasetProjectionCommandResults[K]> {
    let result: unknown;
    if (command === 'scanReadAcquire') { const value = gate.acquire(context); if (value.status === 'deferred') deferredAcquires++; result = value; }
    else if (command === 'scanReadWatchRevocation') result = await gate.watchRevocation(context, (payload as { permitId: string }).permitId);
    else if (command === 'scanReadRelease') result = gate.release(context, (payload as { permitId: string }).permitId);
    else throw new Error('合成CUE测试不调用外部服务。'); return result as DatasetProjectionCommandResults[K];
  } };
  const reader: MetadataReaderPort = { async read(input, signal) { audioActive++; try { await audioHook(input, signal); return { status: 'ok', parserVersion: RUST_MEDIA_METADATA_PARSER_VERSION,
    fields: { album: '合成CUE预读' }, technical: { container: 'WAVE', codec: 'PCM', lossless: true, sampleRateHz: 44_100, channels: 2,
      bitsPerSample: 16, durationSeconds: 1, evidence: 'bounded-parser-reported' }, coverEvidence: [],
    readEvidence: { bytesRead: 0, readCalls: 0, maxReadBytes: 0, allocationBytes: 0, elapsedMs: 0, wholeAudioHash: false, wholeAudioDecode: false } }; } finally { audioActive--; } }, async close() {} };
  const events: Lifecycle[] = []; let hook: (event: Lifecycle) => void = () => {}, cueStarts = 0, rounds = 0, expectedFatal = false, validating = false, abandoned = 0;
  const observe = (event: Lifecycle): void => { events.push(event); hook(event); };
  const cueReader = cap === 8 ? (await freshBulkCueReader()).createCueSidecarBulkReader({ onLifecycle: observe })
    : (await freshLegacyCueReader()).createCueSidecarReader({ onLifecycle: observe });
  const prepared: ScanPreparedBatch[] = [], discoveries: ScanDiscovery[] = [], committed: number[] = [], releases = new Set<() => void>();
  const prepare = repository.localScan.privatePrepareBatch, discover = repository.localScan.privateRecordDiscovery, abandon = repository.localScan.privateAbandonBatch;
  t.mock.method(repository.localScan, 'privatePrepareBatch', (request: Parameters<typeof prepare>[0]) => { const result = prepare(request); prepared.push(request.batch); return result; });
  t.mock.method(repository.localScan, 'privateRecordDiscovery', (request: Parameters<typeof discover>[0]) => { const result = discover(request); discoveries.push(request.discovery); return result; });
  t.mock.method(repository.localScan, 'privateAbandonBatch', (request: Parameters<typeof abandon>[0]) => { const result = abandon(request); abandoned++; return result; });
  t.mock.method(console, 'info', (...values: unknown[]) => {
    const event = typeof values[0] === 'string' ? readLibraryOperationLine(values[0]) : null;
    if (event?.action === 'scan.cue' && event.state === 'start') cueStarts++;
    if (event?.action === 'scan.revalidate' && event.state === 'complete') rounds++;
    if (event?.action === 'scan.revalidate') validating = event.state === 'start';
  });
  const coordinator = createLocalScanCoordinator({ repository, identity, settings, datasetId: identity.datasetId, localScanReadProfile: 'bulk-v2',
    assertCurrent: () => identity.assertCurrent(), projection, reader, cueReader, onCommitted: job => { committed.push(Number(job.progress.visited)); } });
  t.after(async () => {
    for (const release of releases) release();
    await coordinator.close().catch(error => { if (!expectedFatal) throw error; });
    if (!expectedFatal) { assert.equal(gate.resourceCounts().permits, 0); assert.equal(gate.resourceCounts().watches, 0); }
    gate.close(); repository.close(); state.close();
    for (const relative of relatives) assert.deepEqual(await readFile(path.join(media, relative)), bytes);
  });
  function start(): ScanJobRecord {
    const request = { commandId: randomUUID(), libraryRootId: root.id, expectedRootRevision: root.revision };
    if (cap === 8) return coordinator.start(request);
    const pending = repository.localScan.start({ ...request, datasetId: identity.datasetId, parserVersion: RUST_MEDIA_METADATA_PARSER_VERSION }).job;
    settings.freeze(identity, { schema: 1, datasetId: identity.datasetId, eventId: randomUUID(), commandId: randomUUID(), kind: 'launch',
      frozen: { jobId: pending.jobId, settingsRevision: settings.read(identity).revision, albumConcurrency: 12, readerConcurrency: cap } });
    return coordinator.resume({ commandId: randomUUID(), jobId: pending.jobId, expectedRevision: pending.jobRevision });
  }
  return { repository, root, media, relatives, gate, coordinator, start, events, prepared, discoveries, committed, releases,
    cueStarts: () => cueStarts, rounds: () => rounds, validating: () => validating, abandoned: () => abandoned,
    deferredAcquires: () => deferredAcquires, audioActive: () => audioActive, setAudioHook(value: typeof audioHook) { audioHook = value; },
    setHook(value: typeof hook) { hook = value; }, expectFatal() { expectedFatal = true; } };
}

test('八槽预读最多八项且连续前缀逐项提交；旧一/二槽仍逐项发现和新建Worker', { timeout: 60_000 }, async t => {
  for (const cap of [8,1,2] as const) await t.test(`冻结${cap}槽`, async child => {
    const f = await fixture(child, cap), release = deferred(); f.releases.add(release.resolve);
    // 门闩绑定原持久发现首项；目录枚举和异步stat均不保证按文件名排列。
    const original = fsp.lstat; let entered = false, holding = true;
    const mocked = child.mock.method(fsp, 'lstat', async (...args: Parameters<typeof original>) => {
      const target = String(args[0]), head = f.discoveries.find(value => value.cueMode)?.entries[0]?.relative;
      if (head !== undefined && target === path.join(f.media, head) && holding) { entered = true; await release.promise; }
      return Reflect.apply(original, fsp, args);
    }); syncBuiltinESMExports(); child.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
    const job = f.start(); await until(() => entered, '原持久发现首项的真实CUE stat必须进入。');
    if (cap === 8) await until(() => f.events.filter(event => event.type === 'lease-released').length === 7, '后七项真实读取必须先落定。');
    assert.equal(f.cueStarts(), cap === 8 ? 8 : 1); assert.equal(f.repository.localScan.get(job.jobId).progress.visited, '1');
    assert.equal(f.prepared.filter(batch => batch.cueItems?.length).length, 0);
    for (const relative of f.relatives) assert.equal(f.repository.localScan.privateCueSnapshot(f.root.id, relative), null);
    assert.equal(f.discoveries.filter(value => value.cueMode).length, 1);
    assert.ok(f.discoveries.filter(value => value.cueMode).every(value => value.entries.length === 1));
    holding = false; release.resolve(); await f.coordinator.privateWait(job.jobId);
    const final = f.coordinator.get(job.jobId); assert.equal(final.phase, 'completed'); assert.equal(final.progress.accepted, '10'); assert.equal(final.progress.rejected, '0');
    const batches = f.prepared.filter(batch => batch.cueItems?.length); assert.equal(batches.length, 9);
    assert.ok(batches.every(batch => batch.items.length === 0 && batch.cueItems!.length === 1));
    assert.deepEqual(f.committed, Array.from({ length: 10 }, (_, index) => index + 1)); assert.equal(f.rounds(), 20);
    const starts = f.events.filter(event => event.type === 'worker-start').length;
    if (cap === 8) assert.ok(starts > 0 && starts <= 8); else assert.equal(starts, 9);
    for (const relative of f.relatives) assert.equal(f.repository.localScan.privateCueSnapshot(f.root.id, relative)?.item.outcome, 'accepted');
  });
});

test('预读窗口pause/close等待在途真实FD close后才quiet，未来项不变成持久checkpoint', { timeout: 45_000 }, async t => {
  for (const mode of ['pause','close'] as const) await t.test(mode, async child => {
    const f = await fixture(child), entered = deferred(), release = deferred(); f.releases.add(release.resolve);
    const original = fsp.open; let handleHeld: FileHandle | undefined;
    const mocked = child.mock.method(fsp, 'open', async (...args: Parameters<typeof original>) => {
      const handle = await original(...args);
      if (!handleHeld && String(args[0]).startsWith(f.media + path.sep) && String(args[0]).endsWith('.cue')) {
        handleHeld = handle; const close = handle.close.bind(handle);
        child.mock.method(handle, 'close', async () => { entered.resolve(); await release.promise; await close(); });
      } return handle;
    }); syncBuiltinESMExports(); child.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
    let job!: ScanJobRecord, control: Promise<unknown> | undefined, finished = false;
    f.setHook(event => { if (event.type === 'read-start' && !control) {
      control = mode === 'close' ? f.coordinator.close() : f.coordinator.pause({ commandId: randomUUID(), jobId: job.jobId, expectedRevision: f.coordinator.get(job.jobId).jobRevision });
      void control.then(() => { finished = true; }, () => { finished = true; });
    } });
    job = f.start(); await until(() => control !== undefined, '控制必须发生在真实Worker read-start之后。'); await entered.promise; await turn();
    assert.equal(finished, false); assert.ok(handleHeld); assert.equal(fstatSync(handleHeld.fd).isFile(), true); assert.ok(f.gate.resourceCounts().permits > 0);
    assert.equal(f.prepared.filter(batch => batch.cueItems?.length).length, 0); assert.equal(f.repository.localScan.get(job.jobId).progress.visited, '1');
    release.resolve(); await control; assert.equal(f.gate.resourceCounts().permits, 0); assert.equal(f.gate.resourceCounts().watches, 0);
    assert.equal(f.events.filter(event => event.type === 'worker-start').length, f.events.filter(event => event.type === 'worker-exit').length);
    for (const relative of f.relatives) assert.equal(f.repository.localScan.privateCueSnapshot(f.root.id, relative), null);
    const current = f.repository.localScan.get(job.jobId); assert.equal(current.progress.visited, '1');
    if (mode === 'pause') assert.equal(current.phase, 'paused'); else assert.notEqual(current.phase, 'completed');
  });
});

test('CUE预读与另一作业共享原全局八槽和Core许可，额外作业占一槽时CUE最多七槽', { timeout: 45_000 }, async t => {
  const f = await fixture(t), other = path.join(path.dirname(f.media), 'other-media'); await mkdir(other);
  await writeFile(path.join(other, 'held.wav'), Buffer.from('合成另一作业'), { flag: 'wx', mode: 0o600 });
  const source = f.repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(other));
  const root = f.repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' });
  const release = deferred(); f.releases.add(release.resolve);
  f.setAudioHook(async input => { if (input.root.id === source.id) await release.promise; });
  const otherJob = f.coordinator.start({ commandId: randomUUID(), libraryRootId: root.id, expectedRootRevision: root.revision });
  await until(() => f.audioActive() === 1, '另一作业必须先持有实际全局调度槽和Core许可。');
  const borrowed = new Set<number>(); let peak = 0, totalPeak = 0;
  f.setHook(event => {
    if (event.type === 'lease-acquired') { borrowed.add(event.fd); peak = Math.max(peak, borrowed.size); totalPeak = Math.max(totalPeak, borrowed.size + f.audioActive()); }
    if (event.type === 'lease-released') borrowed.delete(event.fd);
  });
  const job = f.start(); await f.coordinator.privateWait(job.jobId); assert.equal(f.coordinator.get(job.jobId).phase, 'completed');
  assert.ok(peak > 0 && peak <= 7); assert.ok(totalPeak <= 8); assert.equal(f.deferredAcquires(), 0);
  assert.equal(f.gate.resourceCounts().permits, 1); assert.equal(f.audioActive(), 1); assert.equal(borrowed.size, 0);
  release.resolve(); await f.coordinator.privateWait(otherJob.jobId); assert.equal(f.coordinator.get(otherJob.jobId).phase, 'completed');
  assert.equal(f.gate.resourceCounts().permits, 0);
});

test('CUE首项重核失配的ScanRetry先join未来FD再重建窗口，不跳过原单项checkpoint', { timeout: 45_000 }, async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(); f.releases.add(release.resolve);
  const originalOpen = fsp.open, originalStat = fsp.lstat; let held: FileHandle | undefined, failed = false;
  const currentCue = (): string | undefined => f.discoveries.find(value => value.cueMode)?.entries[0]?.relative;
  const opened = t.mock.method(fsp, 'open', async (...args: Parameters<typeof originalOpen>) => {
    const handle = await originalOpen(...args), target = String(args[0]);
    if (!held && currentCue() && target.startsWith(f.media + path.sep) && target.endsWith('.cue') && target !== path.join(f.media, currentCue()!)) {
      held = handle; const close = handle.close.bind(handle);
      t.mock.method(handle, 'close', async () => { entered.resolve(); await release.promise; await close(); });
    } return handle;
  });
  const observed = t.mock.method(fsp, 'lstat', async (...args: Parameters<typeof originalStat>) => {
    if (!failed && f.validating() && currentCue() && String(args[0]) === path.join(f.media, currentCue()!)) {
      failed = true; throw Object.assign(new Error('合成首项重核失配。'), { code: 'ENOENT' });
    } return Reflect.apply(originalStat, fsp, args);
  }); syncBuiltinESMExports(); t.after(() => { opened.mock.restore(); observed.mock.restore(); syncBuiltinESMExports(); });
  const job = f.start(); await entered.promise; await until(() => f.abandoned() === 1, '失配批必须先有原abandon回执。'); await turn();
  assert.ok(held); assert.equal(fstatSync(held.fd).isFile(), true); assert.ok(f.gate.resourceCounts().permits > 0);
  assert.equal(f.cueStarts(), 8); assert.equal(f.discoveries.filter(value => value.cueMode).length, 1);
  assert.equal(f.repository.localScan.get(job.jobId).progress.visited, '1');
  release.resolve(); await f.coordinator.privateWait(job.jobId);
  const final = f.coordinator.get(job.jobId); assert.equal(final.phase, 'completed'); assert.equal(final.progress.accepted, '10'); assert.equal(f.abandoned(), 1);
  assert.deepEqual(f.committed, Array.from({ length: 10 }, (_, index) => index + 1)); assert.equal(f.gate.resourceCounts().permits, 0);
  for (const relative of f.relatives) assert.equal(f.repository.localScan.privateCueSnapshot(f.root.id, relative)?.item.outcome, 'accepted');
});

test('新八槽CUE的LRF不释放Core票据、不提交snapshot或越过原checkpoint', { timeout: 30_000 }, async t => {
  const f = await fixture(t, 8, 1); f.expectFatal();
  const original = fsp.open; let held: FileHandle | undefined, realClose: (() => Promise<void>) | undefined;
  const mocked = t.mock.method(fsp, 'open', async (...args: Parameters<typeof original>) => {
    const handle = await original(...args);
    if (String(args[0]).startsWith(f.media + path.sep) && String(args[0]).endsWith('.cue')) {
      held = handle; realClose = handle.close.bind(handle); t.mock.method(handle, 'close', async () => { throw new Error('合成新八槽CUE FD close故障。'); });
    } return handle;
  }); syncBuiltinESMExports();
  try {
    const job = f.start(); await f.coordinator.privateWait(job.jobId); assert.ok(held && realClose); assert.equal(fstatSync(held.fd).isFile(), true);
    assert.equal(f.gate.resourceCounts().permits, 1); assert.equal(f.repository.localScan.privateCueSnapshot(f.root.id, f.relatives[0]!), null);
    assert.equal(f.repository.localScan.get(job.jobId).progress.visited, '1'); assert.throws(() => f.coordinator.get(job.jobId), /FD关闭未确认/u);
    await assert.rejects(() => f.coordinator.close()); assert.equal(f.events.some(event => event.type === 'lease-released'), false);
  } finally {
    if (held && realClose) { const fd = held.fd; await realClose(); assert.throws(() => fstatSync(fd), { code: 'EBADF' }); }
    mocked.mock.restore(); syncBuiltinESMExports(); await f.coordinator.close().catch(() => undefined);
  }
});
