import assert from 'node:assert/strict';
import test, { after, type TestContext } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { createBackupWorkflowStore } from '../../src/recording/backup-workflow-store.js';
import { authorizeSourceDirectory } from '../../src/recording/source-files.js';
import { createLocalScanCoordinator } from '../../src/collection/local-scan-coordinator.js';
import { createScanReadAdmission } from '../../src/library/scan-read-admission.js';
import type { DatasetProjectionPort, DatasetProjectionCommand, DatasetProjectionCommandResults, DatasetProjectionCommandPayloads } from '../../src/collection/dataset-owner-protocol.js';
import { RUST_MEDIA_METADATA_PARSER_VERSION, type MetadataReaderPort, type MetadataReaderLifecycle } from '../../src/library/metadata-reader-types.js';
import { loadFreshMetadataReader } from '../helpers/mbrs003-audio-fixtures.js';
import { createCompletedScanSnapshotView, verifyCompletedScanSnapshotDatabase, LOCAL_SCAN_SNAPSHOT_LIMITS } from '../../src/collection/local-scan-snapshot-view.js';
import { createScanReaderTurn, scheduleScanAlbums, LOCAL_SCAN_DEFAULT_SETTINGS } from '../../src/collection/local-scan-settings.js';

// 本文件使用本次编译的 Reader；测试进程结束时由原编译模块关闭其共享 Rust 池。
// 普通 Reader.close 只归还本 Reader 的资源，不能关闭其他读取者共享的进程。
after(async () => {
  const compiled = await import(new URL('../../dist/library/rust-media-worker.js', import.meta.url).href) as typeof import('../../src/library/rust-media-worker.js');
  await compiled.closeRustMediaWorkerPool();
});

const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
function wav(): Buffer {
  const value = Buffer.alloc(44 + 800); value.write('RIFF'); value.writeUInt32LE(value.length - 8, 4); value.write('WAVEfmt ', 8);
  value.writeUInt32LE(16, 16); value.writeUInt16LE(1, 20); value.writeUInt16LE(2, 22); value.writeUInt32LE(48000, 24);
  value.writeUInt32LE(192000, 28); value.writeUInt16LE(4, 32); value.writeUInt16LE(16, 34); value.write('data', 36); value.writeUInt32LE(800, 40); return value;
}
async function ownedRoot(): Promise<string> {
  const root = process.env.TMPDIR; assert.ok(root && path.isAbsolute(root)); const info = await lstat(root);
  assert.ok(info.isDirectory() && !info.isSymbolicLink() && info.mode % 512 === 0o700 && await realpath(root) === root);
  const value = await mkdtemp(path.join(root, 'musicbridge-scan-view-')); await mkdir(path.join(value, 'audio'), { mode: 0o700 }); return value;
}
function projection(datasetId: string) {
  const admission = createScanReadAdmission({ isBusy: () => false }), context = { datasetId, epoch: randomUUID() };
  const port: DatasetProjectionPort = { async call<K extends DatasetProjectionCommand>(command: K, payload: DatasetProjectionCommandPayloads[K]): Promise<DatasetProjectionCommandResults[K]> {
    let result: unknown;
    if (command === 'scanReadAcquire') result = admission.acquire(context);
    else if (command === 'scanReadWatchRevocation') result = await admission.watchRevocation(context, (payload as { permitId: string }).permitId);
    else if (command === 'scanReadRelease') result = admission.release(context, (payload as { permitId: string }).permitId);
    else throw new Error('本夹具不允许Provider或其它投影读取。');
    return result as DatasetProjectionCommandResults[K];
  } };
  return { admission, port };
}
async function fixture(t: TestContext, albums = 3, options: { fault?: () => void; limits?: { facts?: number; bytes?: number }; reader?: (actual: MetadataReaderPort) => MetadataReaderPort } = {}) {
  const directory = await ownedRoot(), media = path.join(directory, 'audio'), file = path.join(directory, 'collection.sqlite'), stateFile = path.join(directory, 'identity.sqlite');
  const sourceFiles: { file: string; bytes: number; sha256: string }[] = [];
  for (let index = 0; index < albums; index++) {
    const album = path.join(media, '专辑-' + index); await mkdir(album, { mode: 0o700 });
    for (let track = 0; track < 2; track++) { const target = path.join(album, track + '.wav'), bytes = wav(); await writeFile(target, bytes, { flag: 'wx', mode: 0o600 }); sourceFiles.push({ file: target, bytes: bytes.length, sha256: digest(bytes) }); }
  }
  const repository = createCollectionRepository({ filePath: file }), state = createBackupWorkflowStore({ filePath: stateFile });
  repository.localCatalog.roots(); const identity = state.datasetIdentities.bind('default', file, false);
  repository.localCatalog.privateBindWorkbenchDataset(identity); const settings = repository.localCatalog.privateScanSettingsStore(identity);
  const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media));
  const library = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' });
  const admitted = projection(identity.datasetId), events: MetadataReaderLifecycle[] = [];
  const actual = (await loadFreshMetadataReader()).createMetadataReader({ concurrency: 1, maxPending: 1, onLifecycle: event => events.push(event) });
  const reader = options.reader ? options.reader(actual) : actual;
  const view = createCompletedScanSnapshotView({ repository, identity, ...(options.fault ? { beforeCapture: options.fault } : {}), ...(options.limits ? { limits: options.limits } : {}) });
  let completionCalls = 0;
  const coordinator = createLocalScanCoordinator({ repository, identity, settings, datasetId: identity.datasetId, assertCurrent: () => identity.assertCurrent(), projection: admitted.port, reader,
    async onCompleted(job, context) {
      completionCalls++; assert.equal(coordinator.privateReaderTurn().occupied, false);
      assert.equal(events.filter(event => event.type === 'lease-acquired').length, events.filter(event => event.type === 'lease-released').length);
      if (context?.retry) view.retry(job.jobId); else view.captureCompleted(job.jobId);
    } });
  let closed = false;
  async function close() {
    if (closed) return; await coordinator.close(); view.close(); admitted.admission.close(); repository.close(); state.close(); closed = true;
    assert.throws(() => repository.localCatalog.roots()); assert.throws(() => state.overview());
    const starts = events.filter(event => event.type === 'worker-start'), exits = events.filter(event => event.type === 'worker-exit');
    assert.equal(starts.length, exits.length); assert.ok(exits.every(event => event.type === 'worker-exit' && event.exitCode === 0));
    assert.equal(events.filter(event => event.type === 'lease-acquired').length, events.filter(event => event.type === 'lease-released').length);
    for (const source of sourceFiles) { const bytes = await readFile(source.file), info = await lstat(source.file); assert.equal(bytes.length, source.bytes); assert.equal(digest(bytes), source.sha256); assert.equal(info.nlink, 1); }
  }
  t.after(close);
  function startLegacy() {
    // 历史一槽任务必须有原schema1冻结账本；不能把当前缺省两槽新任务冒充旧任务。
    const pending = repository.localScan.start({ commandId: randomUUID(), datasetId: identity.datasetId,
      libraryRootId: library.id, expectedRootRevision: library.revision, parserVersion: RUST_MEDIA_METADATA_PARSER_VERSION }).job;
    const current = settings.read(identity);
    settings.freeze(identity, { schema: 1, datasetId: identity.datasetId, eventId: randomUUID(), commandId: randomUUID(), kind: 'launch',
      frozen: { jobId: pending.jobId, settingsRevision: current.revision, albumConcurrency: current.albumConcurrency, readerConcurrency: 1 } });
    return coordinator.resume({ commandId: randomUUID(), jobId: pending.jobId, expectedRevision: pending.jobRevision });
  }
  return { directory, media, file, stateFile, source, sourceFiles, repository, state, identity, settings, library, admitted, events, view, coordinator, close,
    startLegacy,
    completionCalls: () => completionCalls,
    async scan() { const value = startLegacy(); await coordinator.privateWait(value.jobId); const completed = coordinator.get(value.jobId); assert.equal(completed.phase, 'completed'); return completed; } };
}
function settingsSave(f: Awaited<ReturnType<typeof fixture>>, concurrency: number) {
  const current = f.settings.read(f.identity);
  return f.settings.save(f.identity, { schema: 1, datasetId: f.identity.datasetId, eventId: randomUUID(), commandId: randomUUID(), kind: 'settings', expectedRevision: current.revision,
    settings: { revision: (BigInt(current.revision) + 1n).toString(), albumConcurrency: concurrency } });
}
function originalScanRows(file: string) {
  const db = new DatabaseSync(file, { readOnly: true, allowExtension: false });
  try { return Object.fromEntries(['local_scan_jobs', 'local_scan_batches', 'local_scan_checkpoints', 'local_scan_receipts', 'local_catalog_ledger'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])); }
  finally { db.close(); }
}

test('002扫描调度：实际同库身份默认12及1–24全范围持久设置，越界和同UUID另对象拒绝', { timeout: 30_000 }, async t => {
  const f = await fixture(t, 1); assert.deepEqual(f.settings.read(f.identity), LOCAL_SCAN_DEFAULT_SETTINGS);
  for (let concurrency = 1; concurrency <= 24; concurrency++) assert.equal(settingsSave(f, concurrency).albumConcurrency, concurrency);
  for (const invalid of [0, 25, 1.5, NaN]) assert.throws(() => settingsSave(f, invalid));
  const counterfeit = { datasetId: f.identity.datasetId, assertCurrent() {} };
  assert.throws(() => f.repository.localCatalog.privateScanSettingsStore(counterfeit));
  assert.throws(() => f.settings.read(counterfeit)); const done = await f.scan();
  assert.equal(f.coordinator.privateFrozenSettings(done.jobId)?.albumConcurrency, 24); assert.equal(f.view.load(f.library.id).status, 'ready');
});

test('bulk-v2 调度：单目录按冻结一/二/八槽滑窗，混合旧新任务仍受各 job 与 Owner 八槽约束', async () => {
  const relatives = Array.from({ length: 24 }, (_value, index) => `同一专辑/曲目${index}.wav`);
  for (const cap of [1, 2, 8] as const) {
    let active = 0, peak = 0;
    const values = await scheduleScanAlbums(relatives, 12, new AbortController().signal, async value => {
      active++; peak = Math.max(peak, active); await new Promise<void>(resolve => setImmediate(resolve)); active--; return value;
    }, undefined, cap);
    assert.deepEqual(values, relatives); assert.equal(peak, cap); assert.equal(active, 0);
  }
  const owner = createScanReaderTurn(8), jobs = [1, 2, 8].map(cap => ({ cap: cap as 1 | 2 | 8, turn: createScanReaderTurn(cap as 1 | 2 | 8), active: 0, peak: 0 }));
  let active = 0, peak = 0;
  await Promise.all(jobs.map(job => scheduleScanAlbums(relatives, 12, new AbortController().signal,
    (value, signal) => job.turn.consume(signal, () => owner.consume(signal, async () => {
      job.active++; active++; job.peak = Math.max(job.peak, job.active); peak = Math.max(peak, active);
      try { await new Promise<void>(resolve => setImmediate(resolve)); return value; } finally { job.active--; active--; }
    })), undefined, job.cap)));
  assert.equal(peak, 8); assert.equal(active, 0);
  for (const job of jobs) { assert.ok(job.peak <= job.cap); assert.equal(job.active, 0); job.turn.close(); }
  owner.close(); assert.equal(owner.inspect().active, 0); assert.equal(owner.inspect().waiting, 0);
});

test('bulk-v2 调度：单目录八个在途读取取消后全部 join，未完成读不能伪装完整批次', async () => {
  const controller = new AbortController(), relatives = Array.from({ length: 20 }, (_value, index) => `同一专辑/${index}.wav`);
  let entered = 0, joined = 0, reached!: () => void, release!: () => void, settled = false;
  const eight = new Promise<void>(resolve => { reached = resolve; }), quiet = new Promise<void>(resolve => { release = resolve; });
  const pending = scheduleScanAlbums(relatives, 12, controller.signal, async (_value, signal) => {
    if (++entered === 8) reached();
    try { await quiet; signal.throwIfAborted(); return '不应完成'; } finally { joined++; }
  }, undefined, 8);
  void pending.then(() => { settled = true; }, () => { settled = true; });
  await eight; controller.abort(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(settled, false); assert.equal(joined, 0); release(); await assert.rejects(pending);
  assert.equal(entered, 8); assert.equal(joined, 8); assert.equal(settled, true);
});

test('002扫描调度：历史冻结一槽的1/default12/24目录任务完整读取自有音频，Reader和FD峰值始终1', { timeout: 60_000 }, async t => {
  for (const concurrency of [1, 12, 24]) {
    const f = await fixture(t, 3); if (concurrency !== 12) settingsSave(f, concurrency);
    const done = await f.scan(); assert.deepEqual(done.progress, { visited: '6', accepted: '6', rejected: '0' });
    assert.deepEqual(f.coordinator.privateFrozenSettings(done.jobId), { jobId: done.jobId, settingsRevision: f.settings.read(f.identity).revision, albumConcurrency: concurrency, readerConcurrency: 1 });
    let running = 0, peak = 0;
    for (const event of f.events) { if (event.type === 'lease-acquired') { running++; peak = Math.max(peak, running); } else if (event.type === 'lease-released') running--; }
    assert.equal(peak, 1); assert.equal(running, 0); assert.equal(f.events.filter(event => event.type === 'lease-acquired').length, 6);
    const view = f.view.load(f.library.id); assert.equal(view.lastSuccess?.snapshot.members.length, 6); assert.equal(f.completionCalls(), 1); await f.close();
  }
});

test('002扫描调度：真实已冻结任务暂停冷恢复后不追随新24设置且Reader1不变', { timeout: 60_000 }, async t => {
  let entered!: () => void; const reached = new Promise<void>(resolve => { entered = resolve; });
  const f = await fixture(t, 2, { reader: actual => ({ async read(input, signal) {
    entered(); if (!signal?.aborted) await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }));
    return actual.read(input, signal);
  }, close: () => actual.close() }) });
  settingsSave(f, 1); const start = f.startLegacy();
  await reached; const paused = await f.coordinator.pause({ commandId: randomUUID(), jobId: start.jobId, expectedRevision: f.coordinator.get(start.jobId).jobRevision });
  const original = f.coordinator.privateFrozenSettings(start.jobId)!; assert.equal(original.albumConcurrency, 1); settingsSave(f, 24); await f.close();
  const repository = createCollectionRepository({ filePath: f.file }), state = createBackupWorkflowStore({ filePath: f.stateFile });
  repository.localCatalog.roots(); const identity = state.datasetIdentities.bind('default', f.file, false); assert.equal(identity.datasetId, f.identity.datasetId);
  repository.localCatalog.privateBindWorkbenchDataset(identity); const settings = repository.localCatalog.privateScanSettingsStore(identity), admission = projection(identity.datasetId);
  const reader = (await loadFreshMetadataReader()).createMetadataReader({ concurrency: 1, maxPending: 1 });
  const coordinator = createLocalScanCoordinator({ repository, identity, settings, datasetId: identity.datasetId, assertCurrent: () => identity.assertCurrent(), projection: admission.port, reader });
  try { assert.equal(settings.read(identity).albumConcurrency, 24); assert.deepEqual(settings.frozen(identity, start.jobId), original);
    coordinator.resume({ commandId: randomUUID(), jobId: start.jobId, expectedRevision: paused.jobRevision }); await coordinator.privateWait(start.jobId);
    assert.equal(coordinator.get(start.jobId).phase, 'completed'); assert.deepEqual(coordinator.privateFrozenSettings(start.jobId), original);
    assert.equal(coordinator.privateFrozenSettings(start.jobId)?.readerConcurrency, 1);
    assert.equal(coordinator.privateReaderTurn().readerConcurrency, 2, '当前Owner仍两槽，历史job的原一槽冻结不被扩大');
  } finally { await coordinator.close(); admission.admission.close(); repository.close(); state.close(); }
});

test('002扫描调度：1–24真实目录组完整join保持原顺序，取消失败仍join而不返回缺项', { timeout: 30_000 }, async t => {
  const f = await fixture(t, 1); await f.scan();
  const relatives = Array.from({ length: 30 }, (_, index) => 'album-' + index + '/track.wav');
  for (let concurrency = 1; concurrency <= 24; concurrency++) {
    let running = 0, peak = 0, completed = 0;
    const values = await scheduleScanAlbums(relatives, concurrency, new AbortController().signal, async relative => {
      running++; peak = Math.max(peak, running); await new Promise<void>(resolve => setImmediate(resolve)); running--; completed++; return relative;
    });
    assert.deepEqual(values, relatives); assert.equal(completed, 30); assert.equal(peak, concurrency); assert.equal(running, 0);
  }
  for (const bad of [0, 25, 1.1]) await assert.rejects(scheduleScanAlbums(relatives, bad, new AbortController().signal, async value => value));
  let running = 0, joined = 0;
  await assert.rejects(scheduleScanAlbums(relatives, 24, new AbortController().signal, async (value, signal) => {
    running++; try { await new Promise<void>(resolve => setImmediate(resolve)); if (value === relatives[0]) throw new Error('受控专辑失败'); signal.throwIfAborted(); return value; }
    finally { running--; joined++; }
  }));
  assert.equal(running, 0); assert.ok(joined >= 1); assert.ok(joined <= 24);
});
