import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { fstatSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LocalScanTransitionRequest, ScanJobRecord } from '@music-bridge/contracts';
import { audioFixture, loadFreshMetadataReader } from '../helpers/mbrs003-audio-fixtures.js';
import { authorizeSourceDirectory } from '../../src/recording/source-files.js';
import { CollectionError, createCollectionRepository } from '../../src/collection/repository.js';
import { createLocalScanCoordinator } from '../../src/collection/local-scan-coordinator.js';
import { createScanReadAdmission } from '../../src/library/scan-read-admission.js';
import type { DatasetProjectionPort, DatasetProjectionCommand, DatasetProjectionCommandPayloads,
  DatasetProjectionCommandResults } from '../../src/collection/dataset-owner-protocol.js';
import type { MetadataReaderLifecycle, MetadataReaderPort, MetadataReadResult } from '../../src/library/metadata-reader-types.js';

type Control = 'pause' | 'cancel';
const conflict = (error: unknown): boolean => error instanceof CollectionError && error.code === 'INVENTORY_CONFLICT';

async function exercise(t: test.TestContext, operation: Control): Promise<void> {
  const original = await audioFixture(t);
  const fresh = await loadFreshMetadataReader();
  let number = 0;
  async function scenario() {
    const own = path.join(original.directory, `control-${++number}`); await mkdir(own, { mode: 0o700 });
    const media = path.join(own, 'media'); await mkdir(media, { mode: 0o700 });
    const relative = 'one.wav';
    await writeFile(path.join(media, relative), await original.bytes('core-wav'), { flag: 'wx', mode: 0o600 });
    const file = path.join(own, 'scan.sqlite'), datasetId = randomUUID();
    const repository = createCollectionRepository({ filePath: file });
    const cap = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media));
    const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: cap.id, role: 'library' });
    const context = { epoch: randomUUID(), datasetId };
    // 固定quiet仅供此控制场景；走实际admission三命令，不替代实际媒体繁忙信号/Owner/UI证据。
    const admission = createScanReadAdmission({ isBusy: () => false });
    const events: MetadataReaderLifecycle[] = [], results: MetadataReadResult[] = [], signals: AbortSignal[] = [];
    const order: string[] = []; let observationError: unknown, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const actual = fresh.createMetadataReader({ onLifecycle(event) {
      events.push(event); order.push(event.type);
      try {
        if (event.type === 'lease-released') assert.throws(() => fstatSync(event.fd), { code: 'EBADF' });
      } catch (error) { observationError ??= error; }
      if (event.type === 'worker-start') entered();
    } });
    // 透明装饰器只观察原signal/结果，所有读取都转交真正compiled Worker。
    const reader: MetadataReaderPort = { async read(input, signal) {
      assert.ok(signal); signals.push(signal);
      const result = await actual.read(input, signal); results.push(result); return result;
    }, close: () => actual.close() };
    let acquired = 0, released = 0;
    const projection: DatasetProjectionPort = { async call<K extends DatasetProjectionCommand>(name: K,
      payload: DatasetProjectionCommandPayloads[K]): Promise<DatasetProjectionCommandResults[K]> {
      let value: unknown;
      switch (name) {
        case 'scanReadAcquire': {
          value = admission.acquire(context); ++acquired; order.push('permit-acquired'); break;
        }
        case 'scanReadWatchRevocation':
          value = await admission.watchRevocation(context, (payload as { permitId: string }).permitId); break;
        case 'scanReadRelease': {
          const start = events.find(event => event.type === 'worker-start'); assert.ok(start && start.type === 'worker-start');
          const exit = events.findIndex(event => event.type === 'worker-exit' && event.threadId === start.threadId);
          const close = events.findIndex(event => event.type === 'lease-released' && event.fd === start.fd);
          assert.equal(exit >= 0 && close > exit, true, '真实exit与FD关闭之后才能归还票据');
          assert.throws(() => fstatSync(start.fd), { code: 'EBADF' });
          value = admission.release(context, (payload as { permitId: string }).permitId);
          ++released; order.push('permit-released'); break;
        }
        default: throw new Error('控制夹具仅接生产扫描admission三个私有接点。');
      }
      return value as DatasetProjectionCommandResults[K];
    } };
    const coordinator = createLocalScanCoordinator({ repository, datasetId, projection, reader,
      assertCurrent() { repository.list({ offset: 0, limit: 1 }); } });
    let closed = false;
    async function close() {
      if (closed) return;
      await coordinator.close(); admission.close();
      assert.deepEqual(admission.resourceCounts(), { permits: 0, revoked: 0, watches: 0, timers: 0, closed: true });
      repository.close(); closed = true;
    }
    t.after(close);
    function launch(): ScanJobRecord {
      return coordinator.start({ commandId: randomUUID(), libraryRootId: root.id, expectedRootRevision: root.revision });
    }
    async function completed(jobId: string): Promise<ScanJobRecord> {
      await coordinator.privateWait(jobId);
      const done = coordinator.get(jobId);
      // 固定业务目标：被拒绝或重放的请求不能停止有效扫描却把job留成running。
      assert.equal(done.phase, 'completed', `${operation}无效请求后原扫描必须自然完成`);
      assert.deepEqual(done.progress, { visited: '1', accepted: '1', rejected: '0' });
      assert.equal(repository.localCatalog.pageTracks({ offset: 0, limit: 200 }).total, 1);
      const state = repository.localScan.privateFileState(root.id, relative); assert.ok(state);
      assert.equal(state.value.outcome, 'accepted'); assert.equal(state.value.failureCode, null);
      assert.equal(signals.length, 1); assert.equal(signals[0]!.aborted, false);
      assert.equal(results.length, 1); assert.equal(results[0]!.status, 'ok');
      if (results[0]!.status === 'ok') {
        assert.equal(results[0]!.readEvidence.wholeAudioHash, false);
        assert.equal(results[0]!.readEvidence.wholeAudioDecode, false);
      }
      if (observationError) throw observationError;
      const starts = events.filter(event => event.type === 'worker-start'); assert.equal(starts.length, 1);
      const start = starts[0]!; assert.equal(start.type, 'worker-start');
      if (start.type !== 'worker-start') throw new Error('真实Worker-start正控制缺失。');
      const exit = events.findIndex(event => event.type === 'worker-exit' && event.threadId === start.threadId);
      const fdClose = events.findIndex(event => event.type === 'lease-released' && event.fd === start.fd);
      assert.equal(exit >= 0 && fdClose > exit, true);
      assert.equal(acquired, 1); assert.equal(released, 1);
      assert.equal(order.indexOf('lease-released') < order.indexOf('permit-released'), true);
      assert.deepEqual(admission.resourceCounts(), { permits: 0, revoked: 0, watches: 0, timers: 0, closed: false });
      const track = repository.localCatalog.pageTracks({ offset: 0, limit: 1 }).items[0]!;
      const asset = repository.localCatalog.asset(track.assetId);
      assert.equal(repository.localCatalog.privateAssetHasExactEvidence(asset.id), false); assert.equal(asset.sampleFrames, null); assert.equal(asset.timebaseHz, null);
      await close();
      const cold = createCollectionRepository({ filePath: file });
      try {
        assert.deepEqual(cold.localScan.get(jobId), done);
        assert.equal(cold.localCatalog.pageTracks({ offset: 0, limit: 1 }).total, 1);
      } finally { cold.close(); }
      return done;
    }
    return { repository, coordinator, root, datasetId, launch, started, completed };
  }

  // 1. 真实Worker已启动且CAS肯定陈旧；必须明确失败，原run仍自然完成。
  const stale = await scenario(), pending = stale.launch(); await stale.started;
  const running = stale.coordinator.get(pending.jobId);
  assert.equal(running.phase, 'running'); assert.notEqual(running.jobRevision, pending.jobRevision);
  const invalid: LocalScanTransitionRequest = { commandId: randomUUID(), jobId: running.jobId, expectedRevision: pending.jobRevision };
  assert.equal(stale.repository.localScan.receipt(invalid.commandId), null);
  await assert.rejects(stale.coordinator[operation](invalid), conflict);
  assert.equal(stale.repository.localScan.receipt(invalid.commandId), null);
  await stale.completed(running.jobId);

  // 2. 同nonce换成正在扫描的另一个job/body：沿原fingerprint拒绝，且不abort新run。
  const collision = await scenario();
  const seed = collision.repository.localScan.start({ commandId: randomUUID(), datasetId: collision.datasetId,
    libraryRootId: collision.root.id, expectedRootRevision: collision.root.revision,
    parserVersion: 'music-metadata-11.15.0/mbrs003-v1' }).job;
  const receiptBody: LocalScanTransitionRequest = { commandId: randomUUID(), jobId: seed.jobId, expectedRevision: seed.jobRevision };
  const originalResult = collision.repository.localScan[operation](receiptBody);
  const originalReceipt = collision.repository.localScan.receipt(receiptBody.commandId); assert.ok(originalReceipt);
  const next = collision.launch(); await collision.started;
  const nextRunning = collision.coordinator.get(next.jobId); assert.equal(nextRunning.phase, 'running');
  const changed = { ...receiptBody, jobId: nextRunning.jobId, expectedRevision: nextRunning.jobRevision };
  await assert.rejects(collision.coordinator[operation](changed), conflict);
  assert.deepEqual(collision.repository.localScan.receipt(receiptBody.commandId), originalReceipt);
  assert.deepEqual(await collision.coordinator[operation](receiptBody), originalResult, '原完整body回执精确重放');
  assert.deepEqual(collision.repository.localScan.receipt(receiptBody.commandId), originalReceipt);
  await collision.completed(nextRunning.jobId);

  // cancel是终态，不能在同job重新运行；pause则另证resume中的同job旧成功回执重放零abort。
  if (operation === 'pause') {
    const replay = await scenario();
    const seed = replay.repository.localScan.start({ commandId: randomUUID(), datasetId: replay.datasetId,
      libraryRootId: replay.root.id, expectedRootRevision: replay.root.revision,
      parserVersion: 'music-metadata-11.15.0/mbrs003-v1' }).job;
    const body = { commandId: randomUUID(), jobId: seed.jobId, expectedRevision: seed.jobRevision };
    const paused = replay.repository.localScan.pause(body), receipt = replay.repository.localScan.receipt(body.commandId);
    replay.coordinator.resume({ commandId: randomUUID(), jobId: seed.jobId, expectedRevision: paused.jobRevision });
    await replay.started; assert.equal(replay.coordinator.get(seed.jobId).phase, 'running');
    assert.deepEqual(await replay.coordinator.pause(body), paused);
    assert.deepEqual(replay.repository.localScan.receipt(body.commandId), receipt);
    await replay.completed(seed.jobId);
  }
  await original.assertUnchanged();
}

test('MBRS003 control preflight：stale pause明确冲突但原扫描自然完成，同nonce改body与旧成功回执重放零abort',
  { timeout: 60_000 }, async t => exercise(t, 'pause'));
test('MBRS003 control preflight：stale cancel明确冲突但原扫描自然完成，同nonce改body与旧成功回执重放零abort',
  { timeout: 60_000 }, async t => exercise(t, 'cancel'));
