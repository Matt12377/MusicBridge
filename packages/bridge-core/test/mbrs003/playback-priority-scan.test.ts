import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { fstatSync } from 'node:fs';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { audioFixture, loadFreshMetadataReader, closeFreshMetadataReaderPool, assertRustMetadataReadsQuiet, sha256 } from '../helpers/mbrs003-audio-fixtures.js';
import { authorizeSourceDirectory } from '../../src/recording/source-files.js';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { createLocalScanCoordinator } from '../../src/collection/local-scan-coordinator.js';
import { createScanReadAdmission, type ScanReadAdmission } from '../../src/library/scan-read-admission.js';
import { setTimeout as delay } from 'node:timers/promises';
import { createPlaybackPriorityRuntime } from './playback-priority-runtime-fixture.js';
import { SCAN_STABLE_PLAYBACK_QUIET_MS } from '../../src/library/scan-playback-budget.js';
import type { LocalPlayRequest } from '@music-bridge/contracts';
import type { DatasetProjectionPort, DatasetProjectionCommand, DatasetProjectionCommandPayloads, DatasetProjectionCommandResults } from '../../src/collection/dataset-owner-protocol.js';
import type { MetadataReaderLifecycle, MetadataReaderPort, MetadataReadInput } from '../../src/library/metadata-reader-types.js';

test.after(closeFreshMetadataReaderPool);
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function beforeGate(gate: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>(resolve => {
    const done = (): void => { signal?.removeEventListener('abort', done); resolve(); };
    signal?.addEventListener('abort', done, { once: true }); void gate.then(done, done); if (signal?.aborted) done();
  });
}

/** 实际fresh compiled Rust Reader、原Coordinator/SQL/Source/票据；策略输入受控，不冒充设备或真实音频。 */
async function fixture(t: test.TestContext, count: number, hooks: {
  beforeRead?(input: MetadataReadInput, index: number, signal?: AbortSignal): Promise<void>;
  lifecycle?(event: MetadataReaderLifecycle): void;
  actualConcurrency?: 1 | 2 | 8;
} = {}) {
  const original = await audioFixture(t), directory = path.join(original.directory, 'playback-priority-media');
  await mkdir(directory, { mode: 0o700 }); const bytes = await original.bytes('core-flac'), digest = sha256(bytes), files: string[] = [];
  for (let index = 0; index < count; ++index) {
    const relative = `controlled-${String(index).padStart(4, '0')}.flac`; files.push(relative);
    await writeFile(path.join(directory, relative), bytes, { flag: 'wx', mode: 0o600 });
  }
  const repository = createCollectionRepository({ filePath: path.join(original.directory, 'playback-priority.sqlite') }), datasetId = randomUUID();
  const cap = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(directory));
  const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: cap.id, role: 'library' });
  const events: MetadataReaderLifecycle[] = [], live = new Set<number>(); let observationError: unknown, maximumFds = 0, maximumReads = 0, active = 0, reads = 0;
  const actual = (await loadFreshMetadataReader()).createMetadataReader({ concurrency: hooks.actualConcurrency ?? 8, maxPending: 8, onLifecycle(event) {
    events.push(event);
    try {
      if (event.type === 'lease-acquired') { assert.equal(live.has(event.fd), false); live.add(event.fd); maximumFds = Math.max(maximumFds, live.size); }
      if (event.type === 'lease-released') { assert.equal(live.delete(event.fd), true); assert.throws(() => fstatSync(event.fd), { code: 'EBADF' }); }
      hooks.lifecycle?.(event);
    } catch (error) { observationError ??= error; }
  } });
  const reader: MetadataReaderPort = { async read(input, signal) {
    ++active; maximumReads = Math.max(maximumReads, active); const index = ++reads;
    try { await hooks.beforeRead?.(input, index, signal); return await actual.read(input, signal); }
    finally { --active; }
  }, close: () => actual.close() };
  let limit: 0 | 1 | 2 | 8 = 1, grants = 0, deferredAcquires = 0;
  let admission = createScanReadAdmission({ concurrency: 8, isBusy: () => limit === 0, getScanConcurrency: () => limit }), externalCore = false;
  const scope = { epoch: randomUUID(), datasetId };
  const projection: DatasetProjectionPort = { async call<K extends DatasetProjectionCommand>(command: K, payload: DatasetProjectionCommandPayloads[K]): Promise<DatasetProjectionCommandResults[K]> {
    let value: unknown;
    switch (command) {
      case 'scanReadBudget': value = admission.budget(scope); break;
      case 'scanReadAcquire': {
        const result = admission.acquire(scope); if (result.status === 'granted') ++grants; else ++deferredAcquires; value = result; break;
      }
      case 'scanReadWatchRevocation': value = await admission.watchRevocation(scope, (payload as { permitId: string }).permitId); break;
      case 'scanReadRelease':
        if (!externalCore) assert.equal(live.size, 0, '本一槽资格测试必须在实际源FD关闭后才交还Core票据');
        value = admission.release(scope, (payload as { permitId: string }).permitId); break;
      default: throw new Error('本合成扫描只接原扫描预算与逐读许可。');
    }
    return value as DatasetProjectionCommandResults[K];
  } };
  const coordinator = createLocalScanCoordinator({ repository, datasetId, assertCurrent() { repository.list({ offset: 0, limit: 1 }); },
    projection, reader, localScanReadProfile: 'bulk-v2', corePlaybackBudget: true });
  let closed = false;
  t.after(async () => {
    if (!closed) { await coordinator.close(); admission.close(); repository.close(); closed = true; }
    assert.equal(live.size, 0); assert.equal(active, 0);
    assert.deepEqual(admission.resourceCounts(), { permits: 0, revoked: 0, watches: 0, timers: 0, closed: true });
    for (const relative of files) {
      const file = path.join(directory, relative), info = await lstat(file);
      assert.equal(info.isFile() && !info.isSymbolicLink(), true); assert.equal(info.nlink, 1); assert.equal(info.mode & 0o777, 0o600);
      assert.equal(sha256(await readFile(file)), digest);
    }
    if (observationError) throw observationError;
  });
  return { repository, root, events, coordinator, sourceBytes: bytes.length, identity: scope, get admission() { return admission; },
    useCoreAdmission(value: ScanReadAdmission) {
      assert.equal(reads, 0); assert.equal(active, 0); assert.equal(admission.resourceCounts().permits, 0);
      admission.close(); admission = value; externalCore = true;
    },
    start: () => coordinator.start({ commandId: randomUUID(), libraryRootId: root.id, expectedRootRevision: root.revision }),
    setBudget(value: 0 | 1 | 2 | 8) { assert.equal(externalCore, false, '原runtime资格不得由测试busy布尔覆盖'); limit = value; admission.observe(); },
    inspect: () => ({ reads, active, maximumReads, maximumFds, grants, deferredAcquires, openFds: live.size }),
    quiet() { if (observationError) throw observationError; assertRustMetadataReadsQuiet(events); assert.equal(live.size, 0); assert.equal(admission.resourceCounts().permits, 0); },
  };
}

test('播放预算真实Rust：原冻结八槽按一槽持续提交，128项尾部未读完时已有可查事实且不自取消', { timeout: 60_000 }, async t => {
  const entered = deferred(), tail = deferred();
  const f = await fixture(t, 128, { async beforeRead(_input, index, signal) { if (index === 96) { entered.resolve(); await beforeGate(tail.promise, signal); } } });
  const job = f.start();
  try {
    await entered.promise;
    const partial = f.coordinator.get(job.jobId), visible = f.repository.localCatalog.pageTracks({ offset: 0, limit: 100 });
    assert.equal(partial.phase, 'running'); assert.ok(Number(partial.progress.accepted) >= 64 && Number(partial.progress.accepted) < 128);
    assert.ok(visible.total >= 64 && visible.total < 128); assert.ok(visible.items.length > 0);
    assert.equal(f.coordinator.privateFrozenSettings(job.jobId)?.readerConcurrency, 8, '运行时提示不重写冻结资格');
    assert.deepEqual([f.inspect().maximumReads, f.inspect().maximumFds, f.inspect().deferredAcquires], [1, 1, 0]);
  } finally { tail.resolve(); }
  await f.coordinator.privateWait(job.jobId);
  const completed = f.coordinator.get(job.jobId); assert.equal(completed.phase, 'completed');
  assert.deepEqual(completed.progress, { visited: '128', accepted: '128', rejected: '0' });
  assert.equal(f.inspect().grants, 128); assert.equal(f.inspect().deferredAcquires, 0);
  assert.equal(f.events.filter(event => event.type === 'metadata-phase' && event.stage === 'parse' && event.state === 'start').length, 128);
  f.quiet();
});

test('播放预算真实Rust：Native已请求并读取源字节后撤权，settled/EBADF后归票；忙时恢复不写revision，空闲重读成功', { timeout: 60_000 }, async t => {
  let interrupted = false, nativeSliceReads = 0, physicalBytesBeforeRevocation = 0;
  const f = await fixture(t, 12);
  const workers = await import(new URL('../../dist/library/rust-media-worker.js', import.meta.url).href) as typeof import('../../src/library/rust-media-worker.js');
  const pool = workers.getRustMediaWorkerPool(), readMetadata = pool.readMetadata.bind(pool);
  // parse/start仅为调用阶段诊断，不能证明Native已经在途；这里等真实Rust提出有界字节请求，且原FD实际read完成才撤权。
  t.mock.method(pool, 'readMetadata', (...[input, signal]: Parameters<typeof pool.readMetadata>) => readMetadata({ ...input, async read(offset, length) {
    const bytes = await input.read(offset, length); ++nativeSliceReads;
    if (!interrupted) {
      assert.equal(f.inspect().openFds, 1); assert.ok(bytes.byteLength > 0);
      interrupted = true; physicalBytesBeforeRevocation = bytes.byteLength; f.setBudget(0);
    }
    return bytes;
  } }, signal));
  const job = f.start(); await f.coordinator.privateWait(job.jobId);
  const paused = f.coordinator.get(job.jobId); assert.equal(interrupted, true); assert.ok(nativeSliceReads > 0 && physicalBytesBeforeRevocation > 0); assert.equal(paused.phase, 'paused');
  assert.equal(paused.progress.accepted, '0'); assert.equal(paused.progress.rejected, '0'); assert.equal(f.repository.localCatalog.pageTracks({ offset: 0, limit: 100 }).total, 0);
  t.diagnostic(JSON.stringify({ synthetic: true, actualNativeRequestedSourceBytesBeforeRevocation: true, physicalBytesBeforeRevocation }));
  f.quiet(); await f.coordinator.privateRecoverAvailable(); assert.deepEqual(f.coordinator.get(job.jobId), paused, '预算0不得反复resume→pause改事实');
  f.setBudget(1); await f.coordinator.privateRecoverAvailable(); await f.coordinator.privateWait(job.jobId);
  assert.deepEqual(f.coordinator.get(job.jobId).progress, { visited: '12', accepted: '12', rejected: '0' });
  assert.equal(f.coordinator.get(job.jobId).phase, 'completed'); f.quiet();
});

test('原runtime合成合格起播：真实Rust首批/loopback先完成，稳定原播放下一槽扫完尾部；seek/NEXT及失观测撤销预算', { timeout: 60_000 }, async t => {
  const entered = deferred(), tail = deferred(); let resuming = false, resumedMaximumReads = 0, activeReads = () => 0;
  // 本计时场景把尾部停在新FD之前；真实Native在途撤权/EBADF由上一个独立Gate核验，不混称发声或80k端到端。
  const f = await fixture(t, 128, { actualConcurrency: 1, async beforeRead(_input, index, signal) {
    if (resuming) resumedMaximumReads = Math.max(resumedMaximumReads, activeReads());
    if (index >= 65) { entered.resolve(); await beforeGate(tail.promise, signal); }
  } });
  activeReads = () => f.inspect().active;
  const core = await createPlaybackPriorityRuntime(f.repository, f.identity), runtime = core.runtime;
  const admission = runtime.getDatasetScanReadAdmission?.(); let heldPermit: string | undefined;
  try {
    assert.ok(admission); f.useCoreAdmission(admission);
    assert.deepEqual(admission.budget(f.identity), { concurrency: 8 });
    const job = f.start(); await entered.promise;
    const visible = f.repository.localCatalog.pageTracks({ offset: 0, limit: 100 }).items; assert.ok(visible.length >= 2);
    assert.equal(f.coordinator.get(job.jobId).progress.accepted, '64'); assert.equal(f.coordinator.get(job.jobId).phase, 'running');
    const request = (index: number, action: LocalPlayRequest['action'] = 'PLAY_NOW'): LocalPlayRequest => {
      const track = visible[index]!; return { schema_version: '1.2', request_id: randomUUID(), route: 'roon_audio_input', source_kind: 'local_file',
        local_track_id: track.id, asset_id: track.assetId, expected_asset_revision: f.repository.localCatalog.asset(track.assetId).fileRevision,
        target: { core_id: 'synthetic-core', zone_id: 'synthetic-zone' }, action };
    };
    const playbackRequested = true, began = performance.now(), playing = runtime.playbackPlayLocal!(request(0));
    assert.deepEqual(admission.budget(f.identity), { concurrency: 0 }, '受理当步就关闭预算，不等原SDK/FD/HTTP');
    const accepted = await playing, firstQualifiedPlayMs = performance.now() - began;
    assert.equal(accepted.status, 'accepted'); assert.equal(runtime.getPlaybackState().local?.phase, 'PLAYING');
    assert.equal(core.sessions.length, 1); assert.deepEqual(core.transferBytes, [f.sourceBytes]);
    assert.ok(firstQualifiedPlayMs < 5000, '合成合格起播不等待整库完成；不是实际音频延迟阈值');
    await f.coordinator.privateWait(job.jobId);
    const interrupted = f.coordinator.get(job.jobId); assert.equal(interrupted.phase, 'paused');
    assert.ok(Number(interrupted.progress.accepted) < 128); assert.equal(interrupted.progress.rejected, '0');
    assert.equal(admission.resourceCounts().permits, 0); assert.equal(f.inspect().openFds, 0);
    t.diagnostic(JSON.stringify({ synthetic: true, playbackRequested, firstQualifiedPlayMs, fixtureItems: 128,
      acceptedBeforeRequest: 64, acceptedAtQualified: Number(interrupted.progress.accepted), scanPhaseAtQualified: interrupted.phase,
      bodyBytes: core.transferBytes[0], actualLoopbackBodyCompleted: true, actualAudio: false, ownerAcceptance: false }));

    await runtime.playbackPlayLocal!(request(1, 'APPEND_MB_QUEUE'));
    await delay(SCAN_STABLE_PLAYBACK_QUIET_MS + 100);
    assert.deepEqual(admission.budget(f.identity), { concurrency: 1 });
    const acquired = admission.acquire(f.identity); assert.ok(acquired.status === 'granted'); heldPermit = acquired.permitId;
    assert.deepEqual(admission.acquire(f.identity), { status: 'deferred' });
    const revocation = admission.watchRevocation(f.identity, heldPermit), seeking = runtime.seekPlayback(0);
    assert.deepEqual(admission.budget(f.identity), { concurrency: 0 }); assert.deepEqual(await revocation, { reason: 'media-busy' });
    assert.equal(admission.resourceCounts().permits, 1, '纯票据测试未附Source，撤销仍不提前扣槽');
    admission.release(f.identity, heldPermit); heldPermit = undefined; await seeking;
    assert.deepEqual(admission.budget(f.identity), { concurrency: 0 }, '零票据期间也必须重建同代稳定窗');
    await delay(SCAN_STABLE_PLAYBACK_QUIET_MS + 100); assert.deepEqual(admission.budget(f.identity), { concurrency: 1 });
    resuming = true; tail.resolve(); await f.coordinator.privateRecoverAvailable(); await f.coordinator.privateWait(job.jobId); resuming = false;
    assert.equal(f.coordinator.get(job.jobId).phase, 'completed');
    assert.deepEqual(f.coordinator.get(job.jobId).progress, { visited: '128', accepted: '128', rejected: '0' });
    assert.equal(resumedMaximumReads, 1, '原runtime稳定预算必须实际驱动原Scanner一槽读完，而非只返回漂亮提示');
    assert.equal(f.events.filter(event => event.type === 'metadata-phase' && event.stage === 'parse' && event.state === 'start').length, 128);
    assert.equal(runtime.getPlaybackState().local?.phase, 'PLAYING'); assert.equal(core.sessions.length, 1); f.quiet();
    t.diagnostic(JSON.stringify({ synthetic: true, runtimeQualifiedStableScanResumed: true, resumedMaximumReads,
      acceptedAtCompleted: 128, originalPlaybackSessionsStill: 1, actualAudio: false }));
    const next = runtime.playbackNext(); assert.deepEqual(admission.budget(f.identity), { concurrency: 0 }); await next;
    assert.equal(core.sessions.length, 2); assert.deepEqual(core.transferBytes, [f.sourceBytes, f.sourceBytes]);
    assert.equal(runtime.getPlaybackState().queue.items.length, 2);
    await runtime.playbackStop(); assert.deepEqual(admission.budget(f.identity), { concurrency: 0 }, '未收到Zone stopped不能借idle重开扫描');
    core.emitZone('stopped'); assert.deepEqual(admission.budget(f.identity), { concurrency: 8 });
    core.unpair(); assert.deepEqual(admission.budget(f.identity), { concurrency: 0 }, '有活动后失观测一律封闭');
  } finally {
    tail.resolve(); if (heldPermit) admission?.release(f.identity, heldPermit);
    const errors: unknown[] = [];
    for (const close of [() => f.coordinator.close(), () => core.close()]) try { await close(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, '原runtime合成资格Gate必须确认扫描与播放两侧资源都已关闭。', { cause: errors[0] });
  }
});

for (const action of ['pause', 'cancel'] as const) test(`播放预算真实Rust：原手动${action}优先，自动恢复和预算恢复不能覆盖`, { timeout: 60_000 }, async t => {
  const entered = deferred(), tail = deferred();
  const f = await fixture(t, 4, { async beforeRead(_input, index, signal) { if (index === 1) { entered.resolve(); await beforeGate(tail.promise, signal); } } });
  const job = f.start(); await entered.promise;
  const current = f.coordinator.get(job.jobId), manual = await f.coordinator[action]({ commandId: randomUUID(), jobId: job.jobId, expectedRevision: current.jobRevision });
  assert.equal(manual.phase, action === 'pause' ? 'paused' : 'cancelled'); f.setBudget(1);
  await f.coordinator.privateRecoverAvailable(); assert.deepEqual(f.coordinator.get(job.jobId), manual);
  assert.equal(f.inspect().openFds, 0); assert.equal(f.inspect().active, 0); assert.equal(f.admission.resourceCounts().permits, 0);
  tail.resolve();
  if (action === 'pause') {
    f.coordinator.resume({ commandId: randomUUID(), jobId: job.jobId, expectedRevision: manual.jobRevision });
    await f.coordinator.privateWait(job.jobId); assert.equal(f.coordinator.get(job.jobId).phase, 'completed'); f.quiet();
  } else assert.throws(() => f.coordinator.resume({ commandId: randomUUID(), jobId: job.jobId, expectedRevision: manual.jobRevision }));
});
