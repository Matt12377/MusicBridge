import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Worker, MessageChannel } from 'node:worker_threads';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { IpcRequest, RecordingAttempt, RecordingAttemptReceipt, StopRecordingAttemptRequest, CollectionProgress, CollectionProgressSnapshotDetail } from '@music-bridge/contracts';
import { createDatasetOwnerClient } from '../src/collection/dataset-owner-client.js';
import type { DatasetOwnerFatalReason } from '../src/collection/dataset-owner-protocol.js';
import { createDatasetOwnerRecordingFixture, type RecordingObserverEvent, type RecordingWorkerData } from './helpers/dataset-owner-recording-fixture.js';

interface WorkerAudit {
  datasetId: string; starts: number; inputErrors: string[]; databaseClosed: boolean; maintenanceClosed: boolean;
  writesAtClose: number[]; writesAfterClose: number[]; quiet: { quietPersisted: boolean; attemptId: string; runId: string }[];
  natives: { scope: { runId: string; datasetId: string; attemptId: string; leaseFile: string }; closed: boolean; writes: { at: number; frames: number }[] }[];
  events: RecordingObserverEvent[]; recovery: { safe: boolean; pendingRuns: number; reason?: string };
}
function launch(data: Omit<RecordingWorkerData, 'fixture' | 'observer'>) {
  const channel = new MessageChannel(), events: RecordingObserverEvent[] = [], listeners = new Set<() => void>();
  channel.port1.on('message', (event: RecordingObserverEvent) => { events.push(event); for (const listener of [...listeners]) listener(); });
  const worker = new Worker(new URL('./helpers/dataset-owner-recording-fixture.ts', import.meta.url), {
    workerData: { ...data, fixture: 'dataset-owner-recording', observer: channel.port2 }, transferList: [channel.port2],
    execArgv: ['--import', new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).href],
  });
  const reasons: DatasetOwnerFatalReason[] = [], endpoint = createDatasetOwnerClient({ worker, onFatal: reason => reasons.push(reason) });
  function wait(predicate: (events: RecordingObserverEvent[]) => boolean): Promise<void> {
    if (predicate(events)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { listeners.delete(check); reject(new Error(`受控worker录音观测超过5秒：${JSON.stringify(events.slice(-12))}`)); }, 5000);
      const check = () => { if (predicate(events)) { clearTimeout(timer); listeners.delete(check); resolve(); } };
      listeners.add(check);
    });
  }
  async function close() { await endpoint.close(); channel.port1.close(); assert.equal(worker.threadId, -1, 'close必须等待真实worker自然退出'); assert.deepEqual(reasons, []); }
  async function cleanup() { if (worker.threadId === -1) return; try { await close(); } catch (error) { await writeFile(`${data.auditFile}.failure.json`, JSON.stringify({ failedCleanup: true, events, reasons }, null, 2)); await worker.terminate(); channel.port1.close(); throw error; } }
  return { worker, endpoint, events, wait, close, cleanup };
}
function request(command: IpcRequest['command'], payload: unknown, datasetId: string): IpcRequest { return { version: 1, id: randomUUID(), command, payload, expectedDatasetId: datasetId } as IpcRequest; }
function gaps(values: readonly { at: number }[]) { return values.slice(1).map((value, index) => value.at - values[index]!.at); }
async function audit(file: string): Promise<WorkerAudit> { return JSON.parse(await readFile(file, 'utf8')) as WorkerAudit; }
function assertQuiet(result: WorkerAudit, attemptId: string, starts = 1) {
  assert.equal(result.starts, starts); assert.equal(result.databaseClosed, true); assert.equal(result.maintenanceClosed, true);
  assert.deepEqual(result.writesAfterClose, result.writesAtClose); assert.ok(result.natives.every(native => native.closed));
  assert.ok(result.inputErrors.every(code => code === 'LEASE_CLOSED'), '真实输入consumer必须在租期释放后封住读取');
  const run = result.quiet.find(row => row.attemptId === attemptId); assert.ok(run); assert.equal(run.quietPersisted, true);
  if (starts) { assert.equal(result.inputErrors.length, starts); assert.ok(result.natives[0]!.writes.length >= 3); assert.equal(result.natives[0]!.scope.datasetId, result.datasetId); }
}

// 默认实际执行单计划worker生命周期；显式提供闭合2000样本时，同一用例升级为容量并发实验，无新增skip。
test('真实owner Worker在录音供帧中停止、关闭与重启核对原回执，容量读取影响按实际样本记录', { timeout: 60_000 }, async t => {
  const fixture = await createDatasetOwnerRecordingFixture(t), results: unknown[] = [];
  const modes = fixture.book ? ['current', 'snapshot'] as const : ['single-plan'] as const;
  for (const mode of modes) {
    const files = await fixture.clone(mode), run = launch({ ...files, plan: fixture.plan, pin: fixture.pin });
    t.after(() => run.cleanup());
    const identity = await run.endpoint.prepare(); await run.endpoint.commitBoot();
    const beginPayload = { commandId: randomUUID(), planVersionId: fixture.plan.id, planContentHash: fixture.plan.contentHash, userConfirmed: true as const };
    const attempt = await run.endpoint.dispatch(request('recordingAttempts.begin', beginPayload, identity.datasetId)) as RecordingAttempt;
    await run.wait(events => events.filter(event => event.event === 'pcm-write').length >= 4);
    const baselineWrites = run.events.filter(event => event.event === 'pcm-write');
    const stopPayload: StopRecordingAttemptRequest = { commandId: randomUUID(), attemptId: attempt.id };
    const samples: { command: string; parentRoundTripMs: number; ownerSyncSpanMs: number }[] = [];
    let overlap: { readId: string; readEnteredAt: number; readLeftAt: number; stopSentDuringRead: boolean; stopEnteredAfterRead: boolean } | undefined;
    let stopSentAt = 0, stopped: RecordingAttempt;
    if (fixture.book && mode !== 'single-plan') {
      const command = mode === 'current' ? 'collectionProgress.current' : 'collectionProgress.snapshot';
      const payload = mode === 'current' ? { revisionId: fixture.book.revisionId, page: { offset: 0, limit: 25 } } : { id: fixture.book.snapshotId, page: { offset: 0, limit: 25 } };
      for (let repeat = 0; repeat < 3; ++repeat) {
        const read = request(command, payload, identity.datasetId), sent = performance.now(), pending = run.endpoint.dispatch(read);
        await run.wait(events => events.some(event => event.event === 'dispatch-enter' && event.id === read.id));
        let stop: Promise<unknown> | undefined;
        if (repeat === 2) { stopSentAt = performance.now(); stop = run.endpoint.dispatch(request('recordingAttempts.stop', stopPayload, identity.datasetId)); }
        const value = await pending as CollectionProgress | CollectionProgressSnapshotDetail;
        assert.equal(('overall' in value ? value.overall : value.snapshot.overall).total, 2000, '保持实际2000 reference与原分页/保护，不能缩小payload来达标');
        const end = performance.now(), enter = run.events.find(event => event.event === 'dispatch-enter' && event.id === read.id)!;
        await run.wait(events => events.some(event => event.event === 'dispatch-leave' && event.id === read.id));
        const leave = run.events.find(event => event.event === 'dispatch-leave' && event.id === read.id)!;
        samples.push({ command, parentRoundTripMs: end - sent, ownerSyncSpanMs: leave.at - enter.at });
        if (stop) {
          stopped = await stop as RecordingAttempt;
          const stopEnter = run.events.find(event => event.event === 'dispatch-enter' && event.command === 'recordingAttempts.stop')!;
          overlap = { readId: read.id, readEnteredAt: enter.at, readLeftAt: leave.at, stopSentDuringRead: stopSentAt >= enter.at && stopSentAt < leave.at, stopEnteredAfterRead: stopEnter.at >= leave.at };
          assert.equal(overlap.stopSentDuringRead, true, '必须证明Stop确实在同步容量读取尚未结束时发送');
          assert.equal(overlap.stopEnteredAfterRead, true, '观测原owner派发次序，明确同线程阻塞而非native拒绝Stop');
        }
      }
    } else { stopSentAt = performance.now(); stopped = await run.endpoint.dispatch(request('recordingAttempts.stop', stopPayload, identity.datasetId)) as RecordingAttempt; }
    const stopReplyAt = performance.now(); assert.equal(stopped!.status, 'aborted');
    await run.wait(events => events.some(event => event.event === 'native-close'));
    await run.wait(events => events.some(event => event.event === 'stop-state'));
    const stopState = run.events.find(event => event.event === 'stop-state')!;
    assert.equal(typeof stopState.quiet, 'boolean');
    assert.deepEqual(await run.endpoint.dispatch(request('recordingAttempts.stop', stopPayload, identity.datasetId)), stopped!);
    const receipt = await run.endpoint.dispatch(request('recordingAttempts.receipt', { action: 'stop', request: stopPayload }, identity.datasetId)) as RecordingAttemptReceipt;
    assert.equal(receipt.status, 'accepted');
    const stopEnter = run.events.find(event => event.event === 'dispatch-enter' && event.command === 'recordingAttempts.stop')!;
    const nativeStop = run.events.find(event => event.event === 'native-stop')!, nativeClose = run.events.find(event => event.event === 'native-close')!;
    await run.close(); const closed = await audit(files.auditFile); assertQuiet(closed, attempt.id);
    const restartFiles = { ...files, auditFile: path.join(path.dirname(files.auditFile), 'restart-audit.json') }, restart = launch({ ...restartFiles, plan: fixture.plan, pin: fixture.pin });
    t.after(() => restart.cleanup());
    const reopened = await restart.endpoint.prepare(); assert.equal(reopened.datasetId, identity.datasetId); await restart.endpoint.commitBoot();
    assert.deepEqual(await restart.endpoint.dispatch(request('recordingAttempts.stop', stopPayload, reopened.datasetId)), stopped!);
    const recovered = await restart.endpoint.dispatch(request('recordingAttempts.receipt', { action: 'stop', request: stopPayload }, reopened.datasetId)) as RecordingAttemptReceipt;
    assert.equal(recovered.status, 'accepted');
    await restart.close(); const restarted = await audit(restartFiles.auditFile); assertQuiet(restarted, attempt.id, 0);
    assert.equal(restarted.recovery.safe, false, 'Fake sidecar墓碑不自动取得真实helper排他核验资格'); assert.equal(restarted.recovery.reason, 'OUTPUT_RUN_UNVERIFIED');
    const chunks = closed.natives[0]!.writes;
    results.push({ mode, referenceCount: fixture.book ? 2000 : 0, samples, overlap, baselineGapsMs: gaps(baselineWrites), pcmGapsMs: gaps(chunks), maxPcmGapMs: Math.max(...gaps(chunks)), stopRoundTripMs: stopReplyAt - stopSentAt, stopOwnerQueueMs: stopEnter.at - stopSentAt, stopToNativeDispatchMs: nativeStop.at - stopSentAt, stopToNativeCloseMs: nativeClose.at - stopSentAt, quietAtStopReceipt: stopState.quiet, quietPersistedBeforeCloseAck: true, consumerRevokedBeforeCloseAck: true, noPcmAfterClose: true, naturalWorkerExit: true, restartIdentityMatched: true, cachedStopReplayedWithoutProviderStart: true, realOutputRecovery: 'BLOCKED_NO_REAL_HELPER_VERIFICATION' });
  }
  const output = { classification: 'synthetic-real-worker-behavior/no-real-device', sourceHash: fixture.sourceHash, referenceCount: fixture.book ? 2000 : 0, capacityMeasured: !!fixture.book, thresholdsChanged: false, payloadPage: { offset: 0, limit: 25 }, results };
  await writeFile(path.join(fixture.directory, 'stop-and-pcm-result.json'), JSON.stringify(output, null, 2)); console.log(JSON.stringify({ recordingEvidence: fixture.directory, ...output }));
});

test('真实owner Worker关闭正在供帧的录音，输入与native scope静止后才确认关闭，两库自然释放', { timeout: 60_000 }, async t => {
  const fixture = await createDatasetOwnerRecordingFixture(t), files = await fixture.clone('close-active'), run = launch({ ...files, plan: fixture.plan, pin: fixture.pin });
  t.after(() => run.cleanup());
  const identity = await run.endpoint.prepare(); await run.endpoint.commitBoot();
  const attempt = await run.endpoint.dispatch(request('recordingAttempts.begin', { commandId: randomUUID(), planVersionId: fixture.plan.id, planContentHash: fixture.plan.contentHash, userConfirmed: true }, identity.datasetId)) as RecordingAttempt;
  await run.wait(events => events.filter(event => event.event === 'pcm-write').length >= 4);
  const closeSentAt = performance.now(); await run.close(); const closeMs = performance.now() - closeSentAt;
  const result = await audit(files.auditFile); assertQuiet(result, attempt.id);
  const nativeStop = result.events.find(event => event.event === 'native-stop')!, nativeClose = result.events.find(event => event.event === 'native-close')!;
  await writeFile(path.join(fixture.directory, 'close-active-result.json'), JSON.stringify({ classification: 'synthetic-real-worker-behavior/no-real-device', referenceCount: fixture.book ? 2000 : 0, closeMs, closeToNativeStopMs: nativeStop.at - closeSentAt, closeToNativeCloseMs: nativeClose.at - closeSentAt, quietPersisted: true, consumerRevoked: true, noPcmAfterClose: true, naturalWorkerExit: true }, null, 2));
  console.log(JSON.stringify({ recordingCloseEvidence: fixture.directory, referenceCount: fixture.book ? 2000 : 0, closeMs }));
});
