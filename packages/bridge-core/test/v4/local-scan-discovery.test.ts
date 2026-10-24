import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Dir } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { createLocalScanCoordinator } from '../../src/collection/local-scan-coordinator.js';
import { authorizeSourceDirectory } from '../../src/recording/source-files.js';
import { createScanReadAdmission } from '../../src/library/scan-read-admission.js';
import { RUST_MEDIA_METADATA_PARSER_VERSION, type MetadataReaderPort, type MetadataReadResult } from '../../src/library/metadata-reader-types.js';
import type { DatasetProjectionPort, DatasetProjectionCommand, DatasetProjectionCommandPayloads, DatasetProjectionCommandResults } from '../../src/collection/dataset-owner-protocol.js';
import type { ScanDiscovery } from '../../src/collection/local-scan-store.js';
import { readLibraryOperationLine } from '../../src/shared/library-operation-log.js';

function admission(datasetId: string) {
  const gate = createScanReadAdmission({ isBusy: () => false }), context = { datasetId, epoch: randomUUID() };
  const port: DatasetProjectionPort = {
    async call<K extends DatasetProjectionCommand>(command: K, payload: DatasetProjectionCommandPayloads[K]): Promise<DatasetProjectionCommandResults[K]> {
      let result: unknown;
      if (command === 'scanReadAcquire') result = gate.acquire(context);
      else if (command === 'scanReadWatchRevocation') result = await gate.watchRevocation(context, (payload as { permitId: string }).permitId);
      else if (command === 'scanReadRelease') result = gate.release(context, (payload as { permitId: string }).permitId);
      else throw new Error('目录发现夹具不调用真实服务。');
      return result as DatasetProjectionCommandResults[K];
    },
  };
  return { gate, port };
}

function directoryHandles(t: TestContext, failReadPath?: string) {
  const opened = new Set<Dir>(), active = new Set<Dir>(), counts = new Map<string, number>();
  const read = Dir.prototype.read, close = Dir.prototype.close;
  let peak = 0;
  t.mock.method(Dir.prototype, 'read', function(this: Dir, ...args: unknown[]) {
    if (!opened.has(this)) {
      opened.add(this); active.add(this); peak = Math.max(peak, active.size);
      counts.set(String(this.path), (counts.get(String(this.path)) ?? 0) + 1);
    }
    if (String(this.path) === failReadPath && args.length === 0)
      return Promise.reject(Object.assign(new Error('合成目录错误正文不得进入诊断。'), { code: 'EACCES', path: failReadPath }));
    return Reflect.apply(read, this, args);
  });
  t.mock.method(Dir.prototype, 'close', function(this: Dir, callback?: (error: NodeJS.ErrnoException | null) => void) {
    const finish = (error: NodeJS.ErrnoException | null) => { if (!error) active.delete(this); callback?.(error); };
    if (callback) return Reflect.apply(close, this, [finish]);
    return new Promise<void>((resolve, reject) => Reflect.apply(close, this, [(error: NodeJS.ErrnoException | null) => {
      finish(error); if (error) reject(error); else resolve();
    }]));
  });
  return { active, counts, peak: () => peak };
}

const metadata = (): MetadataReadResult => ({ status: 'ok', parserVersion: RUST_MEDIA_METADATA_PARSER_VERSION,
  fields: { album: '合成目录专辑' },
  technical: { container: 'WAVE', codec: 'PCM', lossless: true, sampleRateHz: 48000, channels: 2, bitsPerSample: 16, durationSeconds: 1, evidence: 'bounded-parser-reported' },
  coverEvidence: [], readEvidence: { bytesRead: 0, readCalls: 0, maxReadBytes: 0, allocationBytes: 0, elapsedMs: 0, wholeAudioHash: false, wholeAudioDecode: false } });

async function fixture(t: TestContext, relatives: string[], blockAfter = Infinity) {
  const temporary = process.env.TMPDIR;
  assert.ok(temporary && path.isAbsolute(temporary));
  if (process.platform === 'darwin') assert.ok(temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp'));
  assert.ok((await lstat(temporary)).isDirectory());
  const directory = await mkdtemp(path.join(temporary, 'musicbridge-scan-discovery-')), media = path.join(directory, 'media');
  await mkdir(media);
  // 目录枚举、签名检查与 SQL 入库都走生产代码；只替换文件内容解析器，避免把目录回归变成音频解码测试。
  const bytes = Buffer.from('合成只读扫描文件');
  for (const relative of relatives) {
    await mkdir(path.dirname(path.join(media, relative)), { recursive: true });
    await writeFile(path.join(media, relative), bytes, { flag: 'wx' });
  }
  const file = path.join(directory, 'collection.sqlite'), datasetId = randomUUID();
  let repository = createCollectionRepository({ filePath: file }); repository.localCatalog.roots();
  const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media));
  const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' });
  let admitted = admission(datasetId), blocked = true, holding = false;
  const reads: string[] = [], completedReads: string[] = [], committed: number[] = [], discoveries: ScanDiscovery[] = [];
  const unblockers = new Set<() => void>();
  const reader: MetadataReaderPort = { async read(input, signal) {
    reads.push(input.relative);
    // 只阻断一条未持久尾部，给乱序到达的前缀留一槽；本夹具验证断点，不制造双槽死锁。
    const inPrefix = discoveries[0]?.entries.slice(0, blockAfter).some(entry => entry.relative === input.relative) ?? false;
    if (blocked && Number.isFinite(blockAfter) && !inPrefix && !holding && !signal?.aborted) await new Promise<void>(resolve => {
      holding = true;
      const release = () => { unblockers.delete(release); signal?.removeEventListener('abort', release); resolve(); };
      unblockers.add(release); signal?.addEventListener('abort', release, { once: true });
    });
    if (signal?.aborted) return { status: 'failure', code: 'CANCELLED', readEvidence: null };
    completedReads.push(input.relative); return metadata();
  }, async close() {} };
  function observeDiscovery() {
    const record = repository.localScan.privateRecordDiscovery;
    t.mock.method(repository.localScan, 'privateRecordDiscovery', (request: Parameters<typeof record>[0]) => {
      discoveries.push(request.discovery); return record(request);
    });
  }
  observeDiscovery();
  const create = () => createLocalScanCoordinator({ repository, datasetId, assertCurrent() {}, reader, projection: admitted.port,
    onCommitted(job) { committed.push(Number(job.progress.visited)); } });
  let coordinator = create();
  t.after(async () => {
    await coordinator.close(); admitted.gate.close();
    assert.equal(admitted.gate.resourceCounts().permits, 0); assert.equal(admitted.gate.resourceCounts().watches, 0);
    repository.close();
    for (const relative of relatives) assert.deepEqual(await readFile(path.join(media, relative)), bytes);
  });
  async function reopen() {
    await coordinator.close(); admitted.gate.close(); repository.close();
    repository = createCollectionRepository({ filePath: file }); repository.localCatalog.roots();
    admitted = admission(datasetId); blocked = false; observeDiscovery(); coordinator = create();
  }
  async function partial(jobId: string) {
    const deadline = performance.now() + 10_000;
    while (performance.now() < deadline) {
      const job = coordinator.get(jobId);
      assert.notEqual(job.phase, 'failed', '宽目录应持续发现并提交首批，不能因子目录数量失败。');
      if (BigInt(job.progress.visited) >= 16n) return job;
      await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
    assert.fail('目录扫描没有在期限内提交首批。');
  }
  function unblock() { blocked = false; for (const release of [...unblockers]) release(); }
  return { media, datasetId, root, reads, completedReads, committed, discoveries, partial, reopen,
    unblock, coordinator: () => coordinator, repository: () => repository };
}

function assertDiscoveryBudget(discoveries: ScanDiscovery[]) {
  assert.ok(discoveries.length > 1);
  for (const discovery of discoveries) {
    assert.ok(discovery.entries.length <= 64);
    assert.ok(discovery.frontier.length <= 200);
    assert.ok(discovery.entries.every(entry => entry.frontier.length <= 200));
    assert.ok(Buffer.byteLength(JSON.stringify(discovery)) < 1024 * 1024);
  }
}

test('V4：233 个直接子目录逐步入库，父目录暖句柄只开一次且 frontier 保持有界', { timeout: 30_000 }, async t => {
  const relatives = Array.from({ length: 233 }, (_, index) => `专辑${String(index).padStart(3, '0')}/曲目.wav`);
  const f = await fixture(t, relatives), handles = directoryHandles(t);
  const started = f.coordinator().start({ commandId: randomUUID(), libraryRootId: f.root.id, expectedRootRevision: f.root.revision });
  await f.coordinator().privateWait(started.jobId);
  const completed = f.coordinator().get(started.jobId);
  assert.equal(completed.phase, 'completed', '233 个合法子目录不应触发旧 BFS 的 200 项 frontier 错误。');
  assert.deepEqual(completed.progress, { visited: '233', accepted: '233', rejected: '0' });
  assert.equal(f.repository().localCatalog.pageTracks({ offset: 0, limit: 200 }).total, 233);
  assert.deepEqual(f.completedReads.slice().sort(), relatives.slice().sort());
  assert.ok(f.committed.length >= 15); assert.ok(f.committed[0]! > 0 && f.committed[0]! < 233);
  assert.ok(f.committed.every((value, index) => index === 0 || value - f.committed[index - 1]! <= 16));
  assertDiscoveryBudget(f.discoveries);
  assert.equal(handles.counts.get(f.media), 1, '父目录不可为每个子目录重开重放。');
  assert.equal(handles.peak(), 2); assert.equal(handles.active.size, 0);
});

test('V4：宽目录与十二层目录混合，中断重开复用持久发现和提交前缀，所有目录 FD 收口', { timeout: 30_000 }, async t => {
  const relatives = Array.from({ length: 241 }, (_, index) => `专辑${String(index).padStart(3, '0')}/曲目.wav`);
  for (let depth = 1; depth <= 12; depth++) relatives.push(`${Array.from({ length: depth }, (_, index) => `层${index}`).join('/')}/曲目.wav`);
  const f = await fixture(t, relatives, 18), handles = directoryHandles(t);
  const started = f.coordinator().start({ commandId: randomUUID(), libraryRootId: f.root.id, expectedRootRevision: f.root.revision });
  const partial = await f.partial(started.jobId);
  assert.ok(BigInt(partial.progress.visited) < BigInt(relatives.length));
  await f.coordinator().yieldForMedia(); assert.equal(handles.active.size, 0);
  const before = f.repository().localScan.privatePendingDiscovery(partial.jobId); assert.ok(before && before.consumed >= 16);
  const retained = new Set([...relatives.filter(relative => f.repository().localScan.privateCurrentFileState(f.root.id, relative)?.value.outcome === 'accepted'),
    ...f.repository().localScan.privatePreparedBatches(partial.jobId).flatMap(batch => batch.items.map(item => item.relative))]);
  const uncommittedReads = f.completedReads.length - retained.size;
  await f.reopen(); assert.deepEqual(f.repository().localScan.privatePendingDiscovery(partial.jobId), before);
  const afterReopen = f.reads.length;
  await f.coordinator().privateRecoverAvailable(); await f.coordinator().privateWait(partial.jobId);
  assert.equal(f.coordinator().get(partial.jobId).phase, 'completed');
  assert.deepEqual(f.coordinator().get(partial.jobId).progress, { visited: '253', accepted: '253', rejected: '0' });
  assert.equal(f.repository().localCatalog.pageTracks({ offset: 0, limit: 200 }).total, 253);
  assert.deepEqual(f.reads.slice(afterReopen).sort(), relatives.filter(relative => !retained.has(relative)).sort());
  // 已返回但未进入持久批次的尾部允许重读；已提交、已准备的前缀必须复用。
  assert.deepEqual([...new Set(f.completedReads)].sort(), relatives.slice().sort());
  assert.ok(f.completedReads.length <= relatives.length + uncommittedReads);
  assertDiscoveryBudget(f.discoveries);
  assert.ok(handles.peak() <= 8); assert.equal(handles.active.size, 0);
});

test('V4：旧 BFS checkpoint 的多个待访问目录继续逐项完成，不更换旧游标解释', { timeout: 30_000 }, async t => {
  const relatives = ['甲/子目录/曲目.wav', '乙/曲目.wav', '丙/子目录/曲目.wav'];
  const f = await fixture(t, relatives), store = f.repository().localScan, handles = directoryHandles(t);
  const created = store.start({ commandId: randomUUID(), datasetId: f.datasetId, libraryRootId: f.root.id,
    expectedRootRevision: f.root.revision, parserVersion: RUST_MEDIA_METADATA_PARSER_VERSION }).job;
  const running = store.resume({ commandId: randomUUID(), jobId: created.jobId, expectedRevision: created.jobRevision });
  const batch = { batchId: randomUUID(), jobId: running.jobId, expectedJobRevision: running.jobRevision,
    checkpointBefore: null, items: [], frontier: ['甲', '乙', '丙'], completed: false };
  store.privatePrepareBatch({ commandId: randomUUID(), jobId: running.jobId, batch });
  const committed = store.privateCommitBatch({ commandId: randomUUID(), jobId: running.jobId, batchId: batch.batchId, expectedRevision: running.jobRevision });
  const paused = store.pause({ commandId: randomUUID(), jobId: running.jobId, expectedRevision: committed.jobRevision });
  f.coordinator().resume({ commandId: randomUUID(), jobId: paused.jobId, expectedRevision: paused.jobRevision });
  await f.coordinator().privateWait(paused.jobId);
  assert.equal(f.coordinator().get(paused.jobId).phase, 'completed');
  assert.deepEqual(f.completedReads.slice().sort(), relatives.slice().sort());
  assert.equal(f.repository().localCatalog.pageTracks({ offset: 0, limit: 200 }).total, 3);
  assert.equal(handles.active.size, 0); assert.ok(handles.peak() <= 8);
});

test('V4：目录签名改变只重开对应目录，保留父级暖句柄并发现新增文件', { timeout: 30_000 }, async t => {
  const relatives = Array.from({ length: 150 }, (_, index) => `专辑/曲目${String(index).padStart(3, '0')}.wav`);
  const f = await fixture(t, relatives, 18), handles = directoryHandles(t);
  const started = f.coordinator().start({ commandId: randomUUID(), libraryRootId: f.root.id, expectedRootRevision: f.root.revision });
  await f.partial(started.jobId);
  const added = '专辑/新增.wav'; await writeFile(path.join(f.media, added), Buffer.from('合成新增文件'), { flag: 'wx' });
  const changed = new Date(Date.now() + 2000); await utimes(path.join(f.media, '专辑'), changed, changed);
  f.unblock(); await f.coordinator().privateWait(started.jobId);
  assert.equal(f.coordinator().get(started.jobId).phase, 'completed');
  assert.equal(f.repository().localCatalog.pageTracks({ offset: 0, limit: 200 }).total, 151);
  assert.equal(f.repository().localScan.privateCurrentFileState(f.root.id, added)?.value.outcome, 'accepted');
  assert.deepEqual(f.completedReads.slice().sort(), [...relatives, added].sort());
  assert.equal(handles.counts.get(f.media), 1); assert.equal(handles.counts.get(path.join(f.media, '专辑')), 2);
  assert.equal(handles.active.size, 0); assert.ok(handles.peak() <= 8);
});

test('V4：旧满 200 项 frontier 遇新子层仍守原上限，诊断明确且不跳过未处理目录', { timeout: 30_000 }, async t => {
  const frontier = Array.from({ length: 200 }, (_, index) => `目录${String(index).padStart(3, '0')}`);
  const relatives = frontier.map((relative, index) => `${relative}/${index === 0 ? '子层/' : ''}曲目.wav`);
  const f = await fixture(t, relatives), store = f.repository().localScan, handles = directoryHandles(t);
  const logs: string[] = []; t.mock.method(console, 'info', (line: string) => logs.push(line));
  const created = store.start({ commandId: randomUUID(), datasetId: f.datasetId, libraryRootId: f.root.id,
    expectedRootRevision: f.root.revision, parserVersion: RUST_MEDIA_METADATA_PARSER_VERSION }).job;
  const running = store.resume({ commandId: randomUUID(), jobId: created.jobId, expectedRevision: created.jobRevision });
  const batch = { batchId: randomUUID(), jobId: running.jobId, expectedJobRevision: running.jobRevision,
    checkpointBefore: null, items: [], frontier, completed: false };
  store.privatePrepareBatch({ commandId: randomUUID(), jobId: running.jobId, batch });
  const committed = store.privateCommitBatch({ commandId: randomUUID(), jobId: running.jobId, batchId: batch.batchId, expectedRevision: running.jobRevision });
  const paused = store.pause({ commandId: randomUUID(), jobId: running.jobId, expectedRevision: committed.jobRevision });
  f.coordinator().resume({ commandId: randomUUID(), jobId: paused.jobId, expectedRevision: paused.jobRevision });
  await f.coordinator().privateWait(paused.jobId);
  assert.equal(f.coordinator().get(paused.jobId).phase, 'failed'); assert.equal(f.coordinator().get(paused.jobId).failureCode, 'SCAN_READ_FAILED');
  assert.deepEqual(store.privateCheckpoint(paused.jobId)?.frontier, frontier);
  assert.equal(f.reads.length, 0); assert.equal(f.repository().localCatalog.pageTracks({ offset: 0, limit: 200 }).total, 0);
  assert.ok(logs.map(readLibraryOperationLine).some(event => event?.action === 'scan.discovery' && event.state === 'error' && event.code === 'DISCOVERY_FRONTIER_LIMIT'));
  assert.ok(logs.every(line => !line.includes(f.media) && !line.includes('目录000')));
  assert.equal(handles.active.size, 0);
});

test('V4：目录 read 错误闭集归因，不泄露路径或错误正文，全部已开目录最终关闭', { timeout: 30_000 }, async t => {
  const f = await fixture(t, ['门禁/曲目.wav']), handles = directoryHandles(t, path.join(f.media, '门禁'));
  const logs: string[] = []; t.mock.method(console, 'info', (line: string) => logs.push(line));
  const started = f.coordinator().start({ commandId: randomUUID(), libraryRootId: f.root.id, expectedRootRevision: f.root.revision });
  await f.coordinator().privateWait(started.jobId);
  assert.equal(f.coordinator().get(started.jobId).phase, 'failed'); assert.equal(f.coordinator().get(started.jobId).failureCode, 'SCAN_READ_FAILED');
  assert.ok(logs.map(readLibraryOperationLine).some(event => event?.action === 'scan.discovery' && event.state === 'error' && event.code === 'DISCOVERY_DIRECTORY_READ_FAILED'));
  assert.ok(logs.every(line => !line.includes(f.media) && !line.includes('合成目录错误正文')));
  assert.equal(f.reads.length, 0); assert.equal(handles.peak(), 2); assert.equal(handles.active.size, 0);
});
