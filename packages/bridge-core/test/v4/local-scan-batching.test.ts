import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import fsp, { lstat, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import type { LibraryRoot, ScanJobRecord } from '@music-bridge/contracts';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { createLocalScanCoordinator } from '../../src/collection/local-scan-coordinator.js';
import type { ScanDiscovery, ScanPreparedBatch } from '../../src/collection/local-scan-store.js';
import { createBackupWorkflowStore } from '../../src/recording/backup-workflow-store.js';
import { authorizeSourceDirectory, type RootCapability } from '../../src/recording/source-files.js';
import { createScanReadAdmission } from '../../src/library/scan-read-admission.js';
import { RUST_MEDIA_METADATA_PARSER_VERSION, type MetadataReaderPort, type MetadataReadInput,
  type MetadataReadResult } from '../../src/library/metadata-reader-types.js';
import { readLibraryOperationLine } from '../../src/shared/library-operation-log.js';
import type { DatasetProjectionPort, DatasetProjectionCommand, DatasetProjectionCommandPayloads,
  DatasetProjectionCommandResults } from '../../src/collection/dataset-owner-protocol.js';

const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function until(check: () => boolean, message: string): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!check()) { assert.ok(performance.now() < deadline, message); await turn(); }
}
async function waitOrAbort(wait: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  let aborted!: () => void;
  const cancellation = new Promise<void>(resolve => { aborted = resolve; });
  signal?.addEventListener('abort', aborted, { once: true });
  try { if (!signal?.aborted) await Promise.race([wait, cancellation]); }
  finally { signal?.removeEventListener('abort', aborted); }
}
const metadata = (): MetadataReadResult => ({ status: 'ok', parserVersion: RUST_MEDIA_METADATA_PARSER_VERSION,
  fields: { album: '合成批次专辑' },
  technical: { container: 'WAVE', codec: 'PCM', lossless: true, sampleRateHz: 48_000, channels: 2,
    bitsPerSample: 16, durationSeconds: 1, evidence: 'bounded-parser-reported' },
  coverEvidence: [], readEvidence: { bytesRead: 0, readCalls: 0, maxReadBytes: 0, allocationBytes: 0,
    elapsedMs: 0, wholeAudioHash: false, wholeAudioDecode: false } });

/** 只替换内容解析port；真实授权、目录发现、stat、SQL、原读取许可和冻结账本均保留。 */
async function fixture(t: TestContext, counts = [64]) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const temporary = process.env.TMPDIR;
  assert.ok(temporary && path.isAbsolute(temporary));
  assert.ok(temporary === '/Volumes/LifeWeave/Developer/CommandLine/tmp'
    || temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'));
  assert.ok((await lstat(temporary)).isDirectory());
  assert.equal(await realpath(temporary), path.resolve(temporary));
  const directory = await mkdtemp(path.join(temporary, 'musicbridge-scan-batching-'));
  const database = path.join(directory, 'collection.sqlite');
  const repository = createCollectionRepository({ filePath: database });
  repository.localCatalog.roots();
  const state = createBackupWorkflowStore({ filePath: path.join(directory, 'identity.sqlite') });
  const identity = state.datasetIdentities.bind('default', database, false);
  repository.localCatalog.privateBindWorkbenchDataset(identity);
  const settings = repository.localCatalog.privateScanSettingsStore(identity);
  const roots: { media: string; source: RootCapability; library: LibraryRoot }[] = [];
  for (const [index, count] of counts.entries()) {
    const media = path.join(directory, `media-${index}`); await mkdir(media);
    for (let track = 0; track < count; track++) await writeFile(path.join(media, `${String(track).padStart(3, '0')}.wav`),
      Buffer.from('合成扫描占位文件'), { flag: 'wx' });
    const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media));
    const library = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' });
    roots.push({ media, source, library });
  }
  const gate = createScanReadAdmission({ isBusy: () => false, concurrency: 8 });
  const context = { datasetId: identity.datasetId, epoch: randomUUID() };
  const projection: DatasetProjectionPort = {
    async call<K extends DatasetProjectionCommand>(command: K, payload: DatasetProjectionCommandPayloads[K]): Promise<DatasetProjectionCommandResults[K]> {
      let value: unknown;
      if (command === 'scanReadAcquire') value = gate.acquire(context);
      else if (command === 'scanReadWatchRevocation') value = await gate.watchRevocation(context, (payload as { permitId: string }).permitId);
      else if (command === 'scanReadRelease') value = gate.release(context, (payload as { permitId: string }).permitId);
      else throw new Error('合成批次测试不调用外部服务。');
      return value as DatasetProjectionCommandResults[K];
    },
  };
  let activeReaders = 0, readCount = 0;
  let onRead: (input: MetadataReadInput, signal?: AbortSignal) => Promise<void> = async () => {};
  const reader: MetadataReaderPort = { async read(input, signal) {
    activeReaders++; readCount++;
    try {
      await onRead(input, signal);
      return signal?.aborted ? { status: 'failure', code: 'CANCELLED', readEvidence: null } : metadata();
    } finally { activeReaders--; }
  }, async close() {} };
  const prepared: ScanPreparedBatch[] = [], discoveries: ScanDiscovery[] = [], committed: number[] = [];
  let abandoned = 0;
  const prepare = repository.localScan.privatePrepareBatch, discover = repository.localScan.privateRecordDiscovery;
  const abandon = repository.localScan.privateAbandonBatch;
  t.mock.method(repository.localScan, 'privatePrepareBatch', (request: Parameters<typeof prepare>[0]) => {
    const result = prepare(request); prepared.push(request.batch); return result;
  });
  t.mock.method(repository.localScan, 'privateRecordDiscovery', (request: Parameters<typeof discover>[0]) => {
    const result = discover(request); discoveries.push(request.discovery); return result;
  });
  t.mock.method(repository.localScan, 'privateAbandonBatch', (request: Parameters<typeof abandon>[0]) => {
    const result = abandon(request); abandoned++; return result;
  });
  const jobs = new Map<string, number>(), rounds = new Map<string, number>(), validating = new Map<string, number>();
  t.mock.method(console, 'info', (...values: unknown[]) => {
    const event = typeof values[0] === 'string' ? readLibraryOperationLine(values[0]) : null;
    if (event?.action !== 'scan.revalidate' || !event.id) return;
    if (event.state === 'start') {
      const round = (rounds.get(event.id) ?? 0) + 1; rounds.set(event.id, round); validating.set(event.id, round);
    } else validating.delete(event.id);
  });
  const coordinator = createLocalScanCoordinator({ repository, identity, settings, datasetId: identity.datasetId,
    localScanReadProfile: 'bulk-v2', assertCurrent: () => identity.assertCurrent(), projection, reader,
    onCommitted(job) { committed.push(Number(job.progress.visited)); } });
  const releases = new Set<() => void>();
  t.after(async () => {
    for (const release of releases) release();
    await coordinator.close(); gate.close();
    assert.equal(activeReaders, 0);
    assert.equal(gate.resourceCounts().permits, 0); assert.equal(gate.resourceCounts().watches, 0);
    repository.close(); state.close();
  });
  function start(cap: 1 | 2 | 8 = 8, rootIndex = 0) {
    const root = roots[rootIndex]!.library;
    const request = { commandId: randomUUID(), libraryRootId: root.id, expectedRootRevision: root.revision };
    let job: ScanJobRecord;
    if (cap === 8) job = coordinator.start(request);
    else {
      const pending = repository.localScan.start({ ...request, datasetId: identity.datasetId, parserVersion: RUST_MEDIA_METADATA_PARSER_VERSION }).job;
      settings.freeze(identity, { schema: 1, datasetId: identity.datasetId, eventId: randomUUID(), commandId: randomUUID(), kind: 'launch',
        frozen: { jobId: pending.jobId, settingsRevision: settings.read(identity).revision, albumConcurrency: 12, readerConcurrency: cap } });
      job = coordinator.resume({ commandId: randomUUID(), jobId: pending.jobId, expectedRevision: pending.jobRevision });
    }
    jobs.set(job.jobId, rootIndex); return job;
  }
  function validationAt(file: string) {
    for (const [jobId, index] of jobs) {
      const round = validating.get(jobId), media = roots[index]!.media;
      if (round && file.startsWith(media + path.sep) && file.endsWith('.wav')) return { jobId, round };
    }
    return null;
  }
  return { roots, repository, coordinator, start, prepared, discoveries, committed, releases, rounds, validationAt,
    readers: () => activeReaders, reads: () => readCount, abandoned: () => abandoned,
    setReadHook(hook: typeof onRead) { onRead = hook; } };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
/** 只延迟真实叶文件lstat；不替换其身份结果，也不绕过SourceStore授权。 */
function validationProbe(t: TestContext, f: Fixture, block: (jobId: string, round: number) => boolean) {
  const original = fsp.lstat;
  let holding = true, active = 0, peak = 0, combinedPeak = 0;
  const checked = new Map<string, number>();
  const pending: { resolve(): void; fail: boolean }[] = [];
  const observed = t.mock.method(fsp, 'lstat', async (...args: Parameters<typeof fsp.lstat>) => {
    const file = String(args[0]), phase = f.validationAt(file);
    if (!phase) return Reflect.apply(original, fsp, args);
    active++; peak = Math.max(peak, active); combinedPeak = Math.max(combinedPeak, active + f.readers());
    checked.set(file, (checked.get(file) ?? 0) + 1);
    try {
      if (holding && block(phase.jobId, phase.round)) {
        const wait = deferred(), entry = { resolve: wait.resolve, fail: false }; pending.push(entry);
        await wait.promise;
        if (entry.fail) throw Object.assign(new Error('合成重核缺失。'), { code: 'ENOENT' });
      }
      return await Reflect.apply(original, fsp, args);
    } finally { active--; }
  });
  syncBuiltinESMExports();
  const release = () => { holding = false; for (const entry of pending.splice(0)) entry.resolve(); };
  f.releases.add(release);
  t.after(() => { release(); observed.mock.restore(); syncBuiltinESMExports(); });
  return { checked, active: () => active, peak: () => peak, combinedPeak: () => combinedPeak, release,
    failOne() { const entry = pending.shift(); assert.ok(entry); entry.fail = true; entry.resolve(); },
    releaseOne() { const entry = pending.shift(); assert.ok(entry); entry.resolve(); } };
}

test('bulk-v2按原冻结八槽提交64项，旧一/二槽仍每批16项', { timeout: 45_000 }, async t => {
  for (const cap of [8, 1, 2] as const) await t.test(`冻结${cap}槽`, async child => {
    const f = await fixture(child), job = f.start(cap);
    await f.coordinator.privateWait(job.jobId);
    assert.equal(f.coordinator.get(job.jobId).phase, 'completed');
    assert.equal(f.coordinator.get(job.jobId).progress.accepted, '64');
    assert.equal(f.coordinator.privateFrozenSettings(job.jobId)?.readerConcurrency, cap);
    const sizes = f.prepared.filter(batch => batch.items.length).map(batch => batch.items.length);
    if (cap === 8) assert.deepEqual(sizes, [64]);
    else {
      // 原实现提交期间若有新的连续结果，会及时保存不足16项的小批；冻结的是上限。
      assert.ok(sizes.every(size => size >= 1 && size <= 16));
      assert.ok(sizes.includes(16));
      assert.equal(sizes.reduce((sum, size) => sum + size, 0), 64);
    }
  });
});

test('bulk64保留250ms部分刷新，只提交未完成项前面的连续前缀', { timeout: 30_000 }, async t => {
  const f = await fixture(t), blocked = deferred(); f.releases.add(blocked.resolve);
  f.setReadHook(async (input, signal) => {
    if (input.relative === f.discoveries[0]?.entries[6]?.relative) await waitOrAbort(blocked.promise, signal);
  });
  const job = f.start();
  await until(() => f.reads() === 64 && f.readers() === 1, '应只阻断第七项，保留首六项连续结果。');
  t.mock.timers.tick(249); await turn(); assert.deepEqual(f.committed, []);
  t.mock.timers.tick(1);
  await until(() => f.committed.length > 0, '250ms时仍应持久提交不足64项的连续前缀。');
  assert.equal(f.committed[0], 6);
  assert.equal(f.prepared[0]?.items.length, 6);
  assert.equal(f.coordinator.get(job.jobId).progress.visited, '6');
  await f.coordinator.close();
});

test('两轮重核与另一job的读取共用八槽，每轮都重新检查真实stat', { timeout: 30_000 }, async t => {
  const f = await fixture(t, [64, 1]), other = deferred(); f.releases.add(other.resolve);
  f.setReadHook(async (input, signal) => {
    if (input.root.id === f.roots[1]!.source.id) await waitOrAbort(other.promise, signal);
  });
  f.start(8, 1); await until(() => f.readers() === 1, '另一job应占用一个原读取槽。');
  let selected = '';
  const probe = validationProbe(t, f, (jobId, round) => jobId === selected && round === 1);
  const job = f.start(); selected = job.jobId;
  await until(() => probe.active() >= 7, '首轮应并行进入其余七个共享槽。'); await turn();
  assert.equal(probe.active(), 7); assert.equal(f.readers(), 1);
  assert.equal(f.coordinator.privateReaderTurn().active, 8);
  probe.release(); await f.coordinator.privateWait(job.jobId);
  assert.equal(f.coordinator.get(job.jobId).phase, 'completed');
  assert.equal(probe.checked.size, 64);
  assert.ok([...probe.checked.values()].every(count => count === 2), '两轮必须各自重读，不能共享上轮stat。');
  assert.ok(probe.combinedPeak() <= 8, '另一job读取与重核总活动数不能超过八。');
  await f.coordinator.close();
});

test('重核取消必须等待在途stat，旧作业pause/close也不死锁', { timeout: 45_000 }, async t => {
  for (const cap of [8, 1, 2] as const) await t.test(`冻结${cap}槽的${cap === 2 ? 'close' : 'pause'}`, async child => {
    const f = await fixture(child); let selected = '';
    const probe = validationProbe(child, f, (jobId, round) => jobId === selected && round === 1);
    const job = f.start(cap); selected = job.jobId;
    await until(() => probe.active() >= (cap === 8 ? 8 : 1), '应停在真实重核stat中。');
    let stopped = false;
    const current = f.coordinator.get(job.jobId);
    const stop = cap === 2 ? f.coordinator.close() : f.coordinator.pause({ commandId: randomUUID(), jobId: job.jobId, expectedRevision: current.jobRevision });
    const joined = stop.then(() => { stopped = true; });
    await turn(); await turn(); assert.equal(stopped, false, '不能在尚有stat未结束时宣称quiet。');
    if (cap === 8) { probe.releaseOne(); await turn(); await turn(); assert.equal(stopped, false); assert.ok(probe.active() > 0); }
    probe.release(); await joined;
    assert.equal(probe.active(), 0); assert.equal(f.prepared.length, 1);
    assert.deepEqual(f.committed, []);
    if (cap !== 2) assert.equal(f.coordinator.get(job.jobId).phase, 'paused');
  });
});

test('一项重核缺失也等待其他在途stat后才弃批，之后可按原发现清单恢复', { timeout: 30_000 }, async t => {
  const f = await fixture(t); let selected = '';
  const probe = validationProbe(t, f, (jobId, round) => jobId === selected && round === 1);
  const job = f.start(); selected = job.jobId;
  await until(() => probe.active() === 8, '首轮八项stat必须都已进入。');
  probe.failOne(); await turn(); await turn();
  assert.equal(probe.active(), 7); assert.equal(f.abandoned(), 0); assert.deepEqual(f.committed, []);
  probe.release(); await f.coordinator.privateWait(job.jobId);
  assert.equal(probe.active(), 0); assert.equal(f.abandoned(), 1);
  assert.equal(f.coordinator.get(job.jobId).phase, 'completed');
  assert.equal(f.coordinator.get(job.jobId).progress.accepted, '64');
});
