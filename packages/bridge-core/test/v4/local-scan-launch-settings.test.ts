import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LibraryRoot } from '@music-bridge/contracts';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { createLocalScanCoordinator } from '../../src/collection/local-scan-coordinator.js';
import { createCompletedScanSnapshotView } from '../../src/collection/local-scan-snapshot-view.js';
import type { LocalScanFrozenSettings } from '../../src/collection/local-scan-settings.js';
import { createBackupWorkflowStore } from '../../src/recording/backup-workflow-store.js';
import { authorizeSourceDirectory } from '../../src/recording/source-files.js';
import { createScanReadAdmission } from '../../src/library/scan-read-admission.js';
import { createMetadataReader } from '../../src/library/metadata-reader.js';
import { closeRustMediaWorkerPool } from '../../src/library/rust-media-worker.js';
import { RUST_MEDIA_METADATA_PARSER_VERSION, type MetadataReaderPort } from '../../src/library/metadata-reader-types.js';
import type { DatasetProjectionPort, DatasetProjectionCommand, DatasetProjectionCommandPayloads, DatasetProjectionCommandResults } from '../../src/collection/dataset-owner-protocol.js';

function wav(): Buffer {
  const bytes = Buffer.alloc(44 + 800);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22); bytes.writeUInt32LE(48000, 24);
  bytes.writeUInt32LE(192000, 28); bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(800, 40);
  return bytes;
}
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

function projection(datasetId: string, bulkV2 = false) {
  const gate = createScanReadAdmission({ isBusy: () => false, concurrency: bulkV2 ? 8 : 2 }), context = { datasetId, epoch: randomUUID() };
  const port: DatasetProjectionPort = {
    async call<K extends DatasetProjectionCommand>(command: K, payload: DatasetProjectionCommandPayloads[K]): Promise<DatasetProjectionCommandResults[K]> {
      let value: unknown;
      if (command === 'scanReadAcquire') value = gate.acquire(context);
      else if (command === 'scanReadWatchRevocation') value = await gate.watchRevocation(context, (payload as { permitId: string }).permitId);
      else if (command === 'scanReadRelease') value = gate.release(context, (payload as { permitId: string }).permitId);
      else throw new Error('合成扫描只允许原读取许可。');
      return value as DatasetProjectionCommandResults[K];
    },
  };
  return { gate, port };
}

async function fixture(t: TestContext, holdReads = false, options: { bulkV2?: boolean; tracks?: number } = {}) {
  const temporary = process.env.TMPDIR;
  assert.ok(temporary && path.isAbsolute(temporary));
  if (process.platform === 'darwin') assert.ok(temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'));
  const info = await lstat(temporary); assert.ok(info.isDirectory() && !info.isSymbolicLink());
  assert.equal(await realpath(temporary), path.resolve(temporary));
  const directory = await mkdtemp(path.join(temporary, 'musicbridge-scan-launch-settings-')), media = path.join(directory, 'audio');
  await mkdir(media, { mode: 0o700 });
  const bytes = wav(), files = Array.from({ length: options.tracks ?? 2 }, (_value, index) => path.join(media, `曲目${index}.wav`));
  for (const file of files) await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
  const database = path.join(directory, 'collection.sqlite'), stateDatabase = path.join(directory, 'identity.sqlite');
  let root: LibraryRoot | undefined, originalDatasetId: string | undefined, blocked = holdReads, nativeReads = 0, active = 0, peak = 0;
  const unblock = new Set<() => void>();
  let reached!: () => void;
  const firstRead = new Promise<void>(resolve => { reached = resolve; });
  async function open() {
    const repository = createCollectionRepository({ filePath: database }), state = createBackupWorkflowStore({ filePath: stateDatabase });
    repository.localCatalog.roots();
    const identity = state.datasetIdentities.bind('default', database, false);
    if (originalDatasetId) assert.equal(identity.datasetId, originalDatasetId);
    originalDatasetId = identity.datasetId;
    repository.localCatalog.privateBindWorkbenchDataset(identity);
    const settings = repository.localCatalog.privateScanSettingsStore(identity);
    if (!root) {
      const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media));
      root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' });
    }
    const admitted = projection(identity.datasetId, options.bulkV2), actual = createMetadataReader({ concurrency: options.bulkV2 ? 8 : 2, maxPending: 4 });
    const reader: MetadataReaderPort = { async read(input, signal) {
      active++; peak = Math.max(peak, active); reached();
      try {
        if (blocked && !signal?.aborted) await new Promise<void>(resolve => {
          const done = () => { signal?.removeEventListener('abort', done); unblock.delete(done); resolve(); };
          unblock.add(done); signal?.addEventListener('abort', done, { once: true }); if (signal?.aborted) done();
        });
        if (signal?.aborted) return { status: 'failure', code: 'CANCELLED', readEvidence: null };
        nativeReads++;
        return await actual.read(input, signal);
      } finally { active--; }
    }, close: () => actual.close() };
    const coordinator = createLocalScanCoordinator({ repository, identity, settings, datasetId: identity.datasetId,
      ...(options.bulkV2 ? { localScanReadProfile: 'bulk-v2' as const } : {}),
      assertCurrent: () => identity.assertCurrent(), projection: admitted.port, reader });
    return { repository, state, identity, settings, admitted, coordinator };
  }
  let current = await open();
  async function close() {
    await current.coordinator.close(); current.admitted.gate.close(); await closeRustMediaWorkerPool();
    current.repository.close(); current.state.close();
    const counts = current.admitted.gate.resourceCounts();
    assert.equal(counts.permits, 0); assert.equal(counts.watches, 0); assert.equal(counts.timers, 0);
  }
  t.after(async () => {
    await close();
    for (const file of files) assert.equal(digest(await readFile(file)), digest(bytes));
  });
  return {
    root: root!, firstRead, current: () => current, nativeReads: () => nativeReads,
    active: () => active, peak: () => peak,
    releaseReads() { blocked = false; for (const done of [...unblock]) done(); },
    async cold() { await close(); blocked = false; current = await open(); },
  };
}

test('V4：持久设置的新扫描冻结两槽；系统暂停冷恢复后完成原合成音频任务', { timeout: 30_000 }, async t => {
  const f = await fixture(t, true), before = f.current(), commandId = randomUUID();
  let jobId: string;
  try {
    jobId = before.coordinator.start({ commandId, libraryRootId: f.root.id, expectedRootRevision: f.root.revision }).jobId;
  } catch (cause) {
    // 回归特征：start/resume已提交，但freeze拒绝导致尚未创建执行作者。
    const receipt = before.coordinator.receipt(commandId); assert.ok(receipt);
    const persisted = before.coordinator.get(receipt.jobId);
    assert.equal(persisted.phase, 'running'); assert.deepEqual(persisted.progress, { visited: '0', accepted: '0', rejected: '0' });
    assert.equal(before.settings.frozen(before.identity, receipt.jobId), null);
    throw new Error('扫描已持久为running/进度0，冻结两槽设置却失败，不能向界面返回未确认操作。', { cause });
  }
  await f.firstRead;
  const original = before.settings.frozen(before.identity, jobId); assert.ok(original);
  assert.equal(original.readerConcurrency, 2);
  await before.coordinator.yieldForMedia();
  assert.equal(before.coordinator.get(jobId).phase, 'paused');
  await f.cold();
  const cold = f.current(); assert.deepEqual(cold.settings.frozen(cold.identity, jobId), original);
  await cold.coordinator.privateRecoverAvailable(); await cold.coordinator.privateWait(jobId);
  const completed = cold.coordinator.get(jobId);
  assert.equal(completed.phase, 'completed'); assert.deepEqual(completed.progress, { visited: '2', accepted: '2', rejected: '0' });
  assert.deepEqual(cold.coordinator.privateFrozenSettings(jobId), original); assert.equal(f.nativeReads(), 2);
  assert.equal(cold.repository.localCatalog.pageTracks({ offset: 0, limit: 10 }).total, 2);
  await f.cold(); const final = f.current();
  assert.equal(final.coordinator.get(jobId).phase, 'completed'); assert.deepEqual(final.settings.frozen(final.identity, jobId), original);
});

test('bulk-v2：仅新建任务冻结八路，单目录填满八槽，完成快照与冷回读绑定原 v2 launch', { timeout: 30_000 }, async t => {
  const f = await fixture(t, true, { bulkV2: true, tracks: 16 }), first = f.current();
  const jobId = first.coordinator.start({ commandId: randomUUID(), libraryRootId: f.root.id, expectedRootRevision: f.root.revision }).jobId;
  const deadline = performance.now() + 5_000;
  while (f.active() < 8) { assert.ok(performance.now() < deadline, '单目录应实际并行进入八个原读取'); await new Promise<void>(resolve => setImmediate(resolve)); }
  assert.equal(first.coordinator.privateReaderTurn().readerConcurrency, 8); assert.equal(f.peak(), 8);
  assert.equal(first.settings.frozen(first.identity, jobId)?.readerConcurrency, 8);
  const rows = () => first.repository.localCatalog.privateRead(db => db.prepare("SELECT request,fingerprint FROM local_catalog_ledger WHERE operation='local-scan-settings-v1' AND json_extract(request,'$.kind')='launch'").all());
  const original = rows(); assert.equal(original.length, 1); assert.equal(JSON.parse(String(original[0]!.request)).schema, 2);
  f.releaseReads(); await first.coordinator.privateWait(jobId);
  assert.equal(first.coordinator.get(jobId).phase, 'completed'); assert.equal(f.nativeReads(), 16); assert.equal(f.peak(), 8);
  const view = createCompletedScanSnapshotView({ repository: first.repository, identity: first.identity });
  const captured = view.captureCompleted(jobId); assert.equal(captured.status, 'ready'); assert.equal(captured.lastSuccess?.snapshot.frozen.readerConcurrency, 8); view.close();
  await f.cold(); const cold = f.current(), coldView = createCompletedScanSnapshotView({ repository: cold.repository, identity: cold.identity });
  assert.deepEqual(coldView.load(f.root.id), captured); coldView.close();
  assert.deepEqual(cold.repository.localCatalog.privateRead(db => db.prepare("SELECT request,fingerprint FROM local_catalog_ledger WHERE operation='local-scan-settings-v1' AND json_extract(request,'$.kind')='launch'").all()), original);
});

test('bulk-v2：旧一槽/两槽 launch 原字节及指纹跨冷恢复不变，缺原 launch 的旧任务仍冻结 v1 两槽', { timeout: 45_000 }, async t => {
  for (const concurrency of [1, 2, null] as const) await t.test(`旧任务 ${concurrency ?? '未冻结'}`, async child => {
    const f = await fixture(child, false, { bulkV2: true, tracks: 12 }), first = f.current();
    const pending = first.repository.localScan.start({ commandId: randomUUID(), datasetId: first.identity.datasetId,
      libraryRootId: f.root.id, expectedRootRevision: f.root.revision, parserVersion: RUST_MEDIA_METADATA_PARSER_VERSION }).job;
    let original: { request: string; fingerprint: string } | undefined;
    if (concurrency !== null) {
      const event = { schema: 1 as const, datasetId: first.identity.datasetId, eventId: randomUUID(), commandId: randomUUID(), kind: 'launch' as const,
        frozen: { jobId: pending.jobId, settingsRevision: '1', albumConcurrency: 12, readerConcurrency: concurrency } };
      first.settings.freeze(first.identity, event);
      original = { request: JSON.stringify(event), fingerprint: digest(Buffer.from(JSON.stringify(event))) };
    }
    await f.cold(); const cold = f.current(); await cold.coordinator.privateRecoverAvailable(); await cold.coordinator.privateWait(pending.jobId);
    assert.equal(cold.coordinator.get(pending.jobId).phase, 'completed'); assert.equal(cold.coordinator.privateFrozenSettings(pending.jobId)?.readerConcurrency, concurrency ?? 2);
    assert.equal(f.peak(), concurrency ?? 2, '八槽 Owner 不能放大旧任务上限');
    const row = cold.repository.localCatalog.privateRead(db => db.prepare("SELECT request,fingerprint FROM local_catalog_ledger WHERE operation='local-scan-settings-v1' AND json_extract(request,'$.frozen.jobId')=?").get(pending.jobId));
    assert.ok(row); assert.equal(JSON.parse(String(row.request)).schema, 1);
    if (original) assert.deepEqual({ request: row.request, fingerprint: row.fingerprint }, original);
  });
});

test('bulk-v2：schema1 不接收八槽，schema2 只接收八槽，拒绝不落账且不改变原设置', { timeout: 30_000 }, async t => {
  const f = await fixture(t), current = f.current();
  const original = current.repository.localCatalog.privateRead(db => db.prepare('SELECT request,fingerprint FROM local_catalog_ledger ORDER BY rowid').all());
  for (const [schema, readerConcurrency] of [[1, 8], [2, 1], [2, 2], [2, 3], [3, 8]] as const) {
    const event = { schema, datasetId: current.identity.datasetId, eventId: randomUUID(), commandId: randomUUID(), kind: 'launch',
      frozen: { jobId: randomUUID(), settingsRevision: '1', albumConcurrency: 12, readerConcurrency } };
    assert.throws(() => current.settings.freeze(current.identity, event as never));
  }
  assert.deepEqual(current.repository.localCatalog.privateRead(db => db.prepare('SELECT request,fingerprint FROM local_catalog_ledger ORDER BY rowid').all()), original);
  assert.deepEqual(current.settings.read(current.identity), { revision: '1', albumConcurrency: 12 });
});

test('V4：历史已冻结的一槽设置跨冷恢复保持原值并完成扫描', { timeout: 30_000 }, async t => {
  const f = await fixture(t), first = f.current();
  const pending = first.repository.localScan.start({ commandId: randomUUID(), datasetId: first.identity.datasetId,
    libraryRootId: f.root.id, expectedRootRevision: f.root.revision, parserVersion: RUST_MEDIA_METADATA_PARSER_VERSION }).job;
  const original: LocalScanFrozenSettings = { jobId: pending.jobId, settingsRevision: '1', albumConcurrency: 12, readerConcurrency: 1 };
  assert.deepEqual(first.settings.freeze(first.identity, { schema: 1, datasetId: first.identity.datasetId,
    eventId: randomUUID(), commandId: randomUUID(), kind: 'launch', frozen: original }), original);
  await f.cold(); const cold = f.current(); assert.deepEqual(cold.settings.frozen(cold.identity, pending.jobId), original);
  await cold.coordinator.privateRecoverAvailable(); await cold.coordinator.privateWait(pending.jobId);
  assert.equal(cold.coordinator.get(pending.jobId).phase, 'completed');
  assert.equal(cold.coordinator.get(pending.jobId).progress.accepted, '2');
  assert.deepEqual(cold.coordinator.privateFrozenSettings(pending.jobId), original); assert.equal(f.nativeReads(), 2);
  await f.cold(); const final = f.current(); assert.deepEqual(final.settings.frozen(final.identity, pending.jobId), original);
});

test('V4：持久冻结拒绝三槽，失败不留下设置事件且不污染冷恢复', { timeout: 30_000 }, async t => {
  const f = await fixture(t), first = f.current(), jobId = randomUUID();
  const invalid = { jobId, settingsRevision: '1', albumConcurrency: 12, readerConcurrency: 3 } as unknown as LocalScanFrozenSettings;
  assert.throws(() => first.settings.freeze(first.identity, { schema: 1, datasetId: first.identity.datasetId,
    eventId: randomUUID(), commandId: randomUUID(), kind: 'launch', frozen: invalid }));
  assert.equal(first.settings.frozen(first.identity, jobId), null);
  await f.cold(); const cold = f.current(); assert.equal(cold.settings.frozen(cold.identity, jobId), null);
  assert.deepEqual(cold.settings.read(cold.identity), { revision: '1', albumConcurrency: 12 }); assert.equal(f.nativeReads(), 0);
});
