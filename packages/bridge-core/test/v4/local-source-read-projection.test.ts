import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, writeFile, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { createLocalSourceReadProjection } from '../../src/collection/local-source-read-projection.js';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { createLocalScanCoordinator } from '../../src/collection/local-scan-coordinator.js';
import { authorizeSourceDirectory, SourceFileError, withCheckedReadonlyMetadataSource } from '../../src/recording/source-files.js';
import { createScanReadAdmission } from '../../src/library/scan-read-admission.js';
import { RUST_MEDIA_METADATA_PARSER_VERSION, type MetadataReaderPort } from '../../src/library/metadata-reader-types.js';
import type { DatasetProjectionPort } from '../../src/collection/dataset-owner-protocol.js';

const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function observe<T>(promise: Promise<T>): Promise<T> { void promise.catch(() => {}); return promise; }

function fixture(t: TestContext, datasetId = randomUUID(), concurrency: 1 | 2 | 8 = 2) {
  const gate = createScanReadAdmission({ isBusy: () => busy, isDisplayBusy: () => false, concurrency });
  const context = { epoch: randomUUID(), datasetId }, held = new Set<string>();
  let busy = false, current = true, peak = 0, grants = 0, releaseCalls = 0, failRelease = false;
  let afterGrant: (() => Promise<void>) | undefined;
  const projection: DatasetProjectionPort = { async call(command, payload) {
    if (command === 'scanReadAcquire') {
      const value = gate.acquire(context, Object.hasOwn(payload, 'purpose') ? 'local-album-display' : 'scan');
      if (value.status === 'granted') { held.add(value.permitId); grants++; peak = Math.max(peak, gate.resourceCounts().permits); await afterGrant?.(); }
      return value as never;
    }
    if (command === 'scanReadWatchRevocation') return gate.watchRevocation(context, (payload as { permitId: string }).permitId) as never;
    if (command === 'scanReadRelease') {
      releaseCalls++; if (failRelease) throw new Error('合成真实释放失败。');
      const id = (payload as { permitId: string }).permitId, value = gate.release(context, id); held.delete(id); return value as never;
    }
    assert.equal(command, 'browseAlbumCandidates'); return { passthrough: true } as never;
  } };
  const turn = createLocalSourceReadProjection({ projection, concurrency, assertCurrent() { if (!current) throw new Error('合成旧代次已失效。'); } });
  t.after(() => { turn.seal(); gate.close(); for (const id of held) gate.release(context, id); assert.equal(gate.resourceCounts().permits, 0); assert.equal(gate.resourceCounts().watches, 0); });
  const acquire = (signal?: AbortSignal, deadlineAtMs?: number, display = false) => observe(turn.port.call('scanReadAcquire', display ? { purpose: 'local-album-display' } : {},
    { ...(signal ? { signal } : {}), ...(deadlineAtMs === undefined ? {} : { deadlineAtMs }) }));
  const release = (value: Awaited<ReturnType<typeof acquire>>) => { assert.equal(value.status, 'granted'); if (value.status !== 'granted') assert.fail('合成许可必须已授予。'); return turn.port.call('scanReadRelease', { permitId: value.permitId }); };
  return { gate, turn, acquire, release, peak: () => peak, grants: () => grants, releaseCalls: () => releaseCalls,
    busy(value: boolean) { busy = value; gate.observe(); }, stale() { current = false; },
    delayGrant(action: (() => Promise<void>) | undefined) { afterGrant = action; }, failRelease() { failRelease = true; } };
}

test('Owner 来源 FIFO：两个元数据许可已满时封面等待，先于后续扫描取得下一槽且总许可不超过二', async t => {
  const f = fixture(t), first = await f.acquire(), second = await f.acquire();
  let coverSettled = false;
  const cover = f.acquire().then(value => { coverSettled = true; return value; });
  const laterScan = f.acquire(); await nextTurn();
  assert.equal(coverSettled, false, '容量繁忙不能立即伪装来源不可用。');
  assert.equal(f.turn.inspect().pending, 2); assert.equal(f.gate.resourceCounts().permits, 2);
  await f.release(first); const coverPermit = await cover;
  assert.equal(coverPermit.status, 'granted'); assert.equal(f.grants(), 3); assert.equal(f.turn.inspect().pending, 1);
  await f.release(second); const laterPermit = await laterScan; assert.equal(laterPermit.status, 'granted');
  await Promise.all([f.release(coverPermit), f.release(laterPermit)]);
  assert.equal(f.peak(), 2); assert.equal(f.turn.inspect().active, 0); await f.turn.close();
});

test('bulk-v2 来源 FIFO：八槽已满时显示等待原下一槽，后来的扫描不越队，排队预算仍三十二', async t => {
  const f = fixture(t, randomUUID(), 8), originals = await Promise.all(Array.from({ length: 8 }, () => f.acquire()));
  const display = f.acquire(undefined, undefined, true), laterScan = f.acquire(), controls = Array.from({ length: 30 }, () => new AbortController());
  const cancelled = controls.map(controller => f.acquire(controller.signal));
  assert.equal(f.turn.inspect().pending, 32); await assert.rejects(f.acquire(), { code: 'SOURCE_READ_QUEUE_FULL' });
  assert.equal(f.gate.resourceCounts().permits, 8); await f.release(originals[0]!);
  const shown = await display; assert.equal(shown.status, 'granted'); assert.equal(f.grants(), 9); assert.equal(f.turn.inspect().pending, 31);
  await f.release(originals[1]!); const next = await laterScan; assert.equal(next.status, 'granted');
  for (const controller of controls) controller.abort();
  for (const task of cancelled) await assert.rejects(task, { code: 'SOURCE_READ_CANCELLED' });
  await Promise.all([...originals.slice(2), shown, next].map(value => f.release(value)));
  assert.equal(f.peak(), 8); assert.equal(f.turn.inspect().active, 0); assert.equal(f.turn.inspect().pending, 0); await f.turn.close();
});

test('bulk-v2 来源 FIFO：八个迟到授予在取消或关停后全部收回，失败释放仍保留八个真实槽', async t => {
  for (const mode of ['cancel', 'close', 'stale'] as const) await t.test(mode, async child => {
    const f = fixture(child, randomUUID(), 8), reply = deferred<void>(), entered = deferred<void>(), controls = Array.from({ length: 8 }, () => new AbortController());
    let count = 0, settled = 0;
    f.delayGrant(async () => { if (++count === 8) entered.resolve(); await reply.promise; });
    const originals = controls.map(controller => f.acquire(controller.signal));
    for (const task of originals) void task.then(() => { settled++; }, () => { settled++; });
    await entered.promise;
    if (mode === 'cancel') for (const controller of controls) controller.abort();
    else if (mode === 'close') f.turn.seal(); else f.stale();
    await nextTurn(); assert.equal(settled, 0); assert.equal(f.gate.resourceCounts().permits, 8);
    reply.resolve();
    for (const task of originals) await assert.rejects(task, { code: mode === 'cancel' ? 'SOURCE_READ_CANCELLED' : mode === 'close' ? 'SOURCE_READ_CLOSED' : 'SOURCE_READ_STALE' });
    assert.equal(f.releaseCalls(), 8); assert.equal(f.gate.resourceCounts().permits, 0); assert.equal(f.turn.inspect().active, 0); await f.turn.close();
  });
  const failed = fixture(t, randomUUID(), 8), originals = await Promise.all(Array.from({ length: 8 }, () => failed.acquire())), waiting = failed.acquire();
  failed.failRelease(); await assert.rejects(failed.release(originals[0]!), { code: 'SOURCE_READ_RELEASE_FAILED' });
  await assert.rejects(waiting, { code: 'SOURCE_READ_RELEASE_FAILED' }); await assert.rejects(failed.turn.close(), { code: 'SOURCE_READ_RELEASE_FAILED' });
  assert.equal(failed.grants(), 8); assert.equal(failed.turn.inspect().active, 8); assert.equal(failed.gate.resourceCounts().permits, 8);
});

test('Owner 来源 FIFO：排队取消、期限与封口都不取得许可，队列最终为零', async t => {
  const f = fixture(t), first = await f.acquire(), second = await f.acquire(), controller = new AbortController();
  const cancelled = f.acquire(controller.signal), expired = f.acquire(undefined, performance.now() + 25), sealed = f.acquire();
  controller.abort(); await assert.rejects(cancelled, { code: 'SOURCE_READ_CANCELLED' });
  await assert.rejects(expired, { code: 'SOURCE_READ_DEADLINE' });
  assert.equal(f.grants(), 2); f.turn.seal(); await assert.rejects(sealed, { code: 'SOURCE_READ_CLOSED' });
  assert.equal(f.turn.inspect().pending, 0); assert.equal(f.gate.resourceCounts().permits, 2);
  await Promise.all([f.release(first), f.release(second)]); await f.turn.close();
  assert.equal(f.turn.inspect().active, 0);
});

test('Owner 来源 FIFO：Core 已授予但回复迟到时，取消必须等原票据收回后才结束', async t => {
  const f = fixture(t), entered = deferred<void>(), reply = deferred<void>(), controller = new AbortController();
  f.delayGrant(async () => { entered.resolve(); await reply.promise; });
  const pending = f.acquire(controller.signal); await entered.promise;
  let settled = false; void pending.finally(() => { settled = true; }).catch(() => {});
  controller.abort(); await nextTurn(); assert.equal(settled, false); assert.equal(f.gate.resourceCounts().permits, 1);
  reply.resolve(); await assert.rejects(pending, { code: 'SOURCE_READ_CANCELLED' });
  assert.equal(f.releaseCalls(), 1); assert.equal(f.gate.resourceCounts().permits, 0); assert.equal(f.turn.inspect().active, 0);
  await f.turn.close();
});

test('Owner 来源 FIFO：旧代次的排队请求不读源，真实释放失败保槽并阻断后续授予', async t => {
  const f = fixture(t), first = await f.acquire(), second = await f.acquire();
  const stale = f.acquire(); f.stale(); await f.release(first); await assert.rejects(stale, { code: 'SOURCE_READ_STALE' });
  await f.release(second); await f.turn.close(); assert.equal(f.grants(), 2);
  const failed = fixture(t), left = await failed.acquire(), right = await failed.acquire(), waiting = failed.acquire();
  failed.failRelease(); await assert.rejects(failed.release(left), { code: 'SOURCE_READ_RELEASE_FAILED' });
  await assert.rejects(waiting, { code: 'SOURCE_READ_RELEASE_FAILED' });
  await assert.rejects(failed.acquire(), { code: 'SOURCE_READ_RELEASE_FAILED' });
  assert.equal(failed.grants(), 2); assert.equal(failed.turn.inspect().active, 2); assert.equal(failed.gate.resourceCounts().permits, 2);
  await assert.rejects(failed.turn.close(), { code: 'SOURCE_READ_RELEASE_FAILED' });
  assert.equal(right.status, 'granted');
});

test('Owner 来源 FIFO：媒体忙仍拒绝后台，显示用途与其它投影沿原合同透传', async t => {
  const f = fixture(t); f.busy(true);
  assert.deepEqual(await f.acquire(), { status: 'deferred' }); assert.equal(f.turn.inspect().active, 0);
  const display = await f.acquire(undefined, undefined, true); assert.equal(display.status, 'granted');
  await f.release(display);
  assert.deepEqual(await f.turn.port.call('browseAlbumCandidates', { query: '合成', page: { offset: 0, limit: 1 } }), { passthrough: true });
  await f.turn.close();
});

test('Owner 来源 FIFO：最多三十二个排队者，溢出与批量取消不改变两个原许可', async t => {
  const f = fixture(t), first = await f.acquire(), second = await f.acquire();
  const controls = Array.from({ length: 32 }, () => new AbortController()), queued = controls.map(controller => f.acquire(controller.signal));
  assert.equal(f.turn.inspect().pending, 32); await assert.rejects(f.acquire(), { code: 'SOURCE_READ_QUEUE_FULL' });
  for (const controller of controls) controller.abort();
  for (const task of queued) await assert.rejects(task, { code: 'SOURCE_READ_CANCELLED' });
  assert.equal(f.turn.inspect().pending, 0); assert.equal(f.grants(), 2); assert.equal(f.gate.resourceCounts().permits, 2);
  await Promise.all([f.release(first), f.release(second)]); await f.turn.close();
});

test('Owner 来源 FIFO：授予在封口或代次变化后返回，必须收回原许可且不交给旧读者', async t => {
  for (const mode of ['close', 'stale'] as const) {
    const f = fixture(t), entered = deferred<void>(), reply = deferred<void>();
    f.delayGrant(async () => { entered.resolve(); await reply.promise; }); const pending = f.acquire(); await entered.promise;
    if (mode === 'close') f.turn.seal(); else f.stale();
    reply.resolve(); await assert.rejects(pending, { code: mode === 'close' ? 'SOURCE_READ_CLOSED' : 'SOURCE_READ_STALE' });
    assert.equal(f.releaseCalls(), 1); assert.equal(f.gate.resourceCounts().permits, 0); assert.equal(f.turn.inspect().active, 0);
    await f.turn.close();
  }
});

test('Owner 来源 FIFO：已提交前缀的真实扫描排队时封口，暂停后冷恢复同任务且 checkpoint 不跳过', { timeout: 20_000 }, async t => {
  const temporary = process.env.TMPDIR;
  assert.ok(temporary && path.isAbsolute(temporary));
  if (process.platform === 'darwin') assert.ok(temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'));
  const directory = await mkdtemp(path.join(temporary, 'musicbridge-fifo-scan-close-')), media = path.join(directory, 'media'), file = path.join(directory, 'collection.sqlite');
  await mkdir(path.join(media, '专辑'), { recursive: true });
  const relatives = Array.from({ length: 40 }, (_, index) => `专辑/曲目${String(index).padStart(2, '0')}.wav`);
  for (const relative of relatives) await writeFile(path.join(media, relative), Buffer.from('合成只读扫描文件'), { flag: 'wx' });
  const datasetId = randomUUID(), first = fixture(t, datasetId);
  let repository = createCollectionRepository({ filePath: file }); repository.localCatalog.roots();
  const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media));
  const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' });
  const prefixCommitted = deferred<void>(), sourceHandles = new Set<FileHandle>(), reads: string[] = [];
  let blockerFlight: Promise<Awaited<ReturnType<typeof first.acquire>>[]> | undefined;
  // 只隔离内容解析；真实 FD、原签名回核、持久批次与准入都由生产链路执行。
  const reader: MetadataReaderPort = { async read(input, signal) {
    reads.push(input.relative);
    try { return await withCheckedReadonlyMetadataSource(input.root, input.relative, input.expectedSignature, signal!, async handle => {
      sourceHandles.add(handle); const buffer = Buffer.alloc(8), value = await handle.read(buffer, 0, buffer.length, 0);
      return { status: 'ok' as const, parserVersion: RUST_MEDIA_METADATA_PARSER_VERSION, fields: { album: '合成专辑' },
        technical: { container: 'WAVE' as const, codec: 'PCM', lossless: true, sampleRateHz: 48000, channels: 2, bitsPerSample: 16, durationSeconds: 1, evidence: 'bounded-parser-reported' as const },
        coverEvidence: [], readEvidence: { bytesRead: value.bytesRead, readCalls: 1, maxReadBytes: buffer.length, allocationBytes: buffer.length,
          elapsedMs: 0, wholeAudioHash: false, wholeAudioDecode: false } };
    }); } catch (error) {
      if (signal?.aborted && error instanceof SourceFileError && error.code === 'CANCELLED') return { status: 'failure', code: 'CANCELLED', readEvidence: null };
      throw error;
    }
  }, async close() {} };
  let coordinator = createLocalScanCoordinator({ repository, datasetId, assertCurrent() {}, reader, projection: first.turn.port,
    onCommitted(job) {
      if (blockerFlight || BigInt(job.progress.visited) < 16n) return;
      // 先证实前缀已经持久提交，再排入占票者；不阻塞任何读者或提交回核。
      blockerFlight = observe(Promise.all([first.acquire(), first.acquire()])); prefixCommitted.resolve();
    } });
  const blockerHandles: FileHandle[] = [], blockerPermits: Awaited<ReturnType<typeof first.acquire>>[] = [];
  async function closeBlockers() {
    for (const handle of blockerHandles) if (handle.fd !== -1) await handle.close();
    for (const permit of blockerPermits.splice(0)) await first.release(permit);
  }
  t.after(async () => { await closeBlockers(); await coordinator.close(); repository.close(); });
  const started = coordinator.start({ commandId: randomUUID(), libraryRootId: root.id, expectedRootRevision: root.revision });
  await prefixCommitted.promise;
  assert.ok(BigInt(coordinator.get(started.jobId).progress.visited) >= 16n);
  assert.ok(blockerFlight); blockerPermits.push(...await blockerFlight);
  blockerHandles.push(await open(path.join(media, relatives[0]!), 'r'), await open(path.join(media, relatives[1]!), 'r'));
  const until = performance.now() + 1000;
  while (first.turn.inspect().pending === 0 && performance.now() < until) await new Promise<void>(resolve => setTimeout(resolve, 5));
  assert.ok(first.turn.inspect().pending > 0, '扫描必须真的在共享 FIFO 中排队。');
  const before = repository.localScan.privateCheckpoint(started.jobId); assert.ok(before);
  const retained = new Set(relatives.filter(relative => repository.localScan.privateCurrentFileState(root.id, relative)?.value.outcome === 'accepted'));
  const readsAtSeal = reads.length; first.turn.seal(); await coordinator.privateWait(started.jobId); await closeBlockers();
  assert.equal(coordinator.get(started.jobId).phase, 'paused', 'Owner 关闭是可恢复暂停，不应把容量排队任务写成 failed。');
  assert.equal(coordinator.get(started.jobId).failureCode, null); assert.deepEqual(repository.localScan.privateCheckpoint(started.jobId), before);
  assert.equal(reads.length, readsAtSeal); assert.ok([...sourceHandles].every(handle => handle.fd === -1));
  assert.equal(first.gate.resourceCounts().permits, 0); assert.equal(first.gate.resourceCounts().watches, 0); assert.equal(first.turn.inspect().active, 0);
  await coordinator.close(); await first.turn.close(); repository.close();
  repository = createCollectionRepository({ filePath: file }); repository.localCatalog.roots(); const cold = fixture(t, datasetId);
  coordinator = createLocalScanCoordinator({ repository, datasetId, assertCurrent() {}, reader, projection: cold.turn.port });
  const priorReads = reads.length; await coordinator.privateRecoverAvailable(); await coordinator.privateWait(started.jobId);
  const completed = coordinator.get(started.jobId); assert.equal(completed.phase, 'completed');
  assert.deepEqual(completed.progress, { visited: '40', accepted: '40', rejected: '0' });
  assert.equal(repository.localCatalog.pageTracks({ offset: 0, limit: 200 }).total, 40);
  assert.ok(reads.slice(priorReads).every(relative => !retained.has(relative))); assert.ok([...sourceHandles].every(handle => handle.fd === -1));
  assert.equal(cold.gate.resourceCounts().permits, 0); assert.equal(cold.turn.inspect().active, 0); await coordinator.close(); await cold.turn.close();
});
