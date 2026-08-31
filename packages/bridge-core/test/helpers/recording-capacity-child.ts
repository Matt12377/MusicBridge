import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { readBackupIndex } from '../../src/recording/backup-index.js';
import { verifyArchiveBackup } from '../../src/recording/backup-package.js';
import { restoreArchiveBackup, verifyRestoredArchive } from '../../src/recording/restore-package.js';
import { authorizeSourceDirectory } from '../../src/recording/source-files.js';
import { createRecordingAttemptCoordinator, type RecordingAttemptDriverRequest } from '../../src/recording/attempt-coordinator.js';
import { capacityJpeg, capacityPdf, hashCapacityFile, readCapacityBudget } from './recording-capacity-fixture.js';
import { capacityMessageBytes, isCapacityInit, isCapacityQueueProgress, isCapacityQueueStop, isCapacityRequestId, verifyCapacityTaskPaths,
  type CapacityChildTask, type CapacityChildReceipt, type CapacityChildPhase, type CapacityQueuedStopReceipt } from './recording-capacity-process.js';

// 此入口只服务测试父进程的固定IPC协议；不读取用户配置，也不创建输出provider。
const requestId = process.argv[3] ?? '', controller = new AbortController();
let accepted = false, finished = false, invalid = false, phase: CapacityChildPhase = 'protocol';
const started = performance.now();
const elapsed = () => performance.now() - started;
const evidence = () => ({ childMeasuredMs: elapsed(), clock: 'child-relative' as const, deviceOpened: false as const, formalReady: false as const, gateB: 'NOT_RUN' as const });

type QueueTask = Extract<CapacityChildTask, { kind: 'queue' }>;
type PrintWriteTask = Extract<CapacityChildTask, { kind: 'print-write' }>;
type CloneTask = Extract<CapacityChildTask, { kind: 'cold' | 'queue' | 'print-write' }>;
interface QueueContext {
  task: QueueTask; repository: ReturnType<typeof createCollectionRepository>; coordinator: ReturnType<typeof createRecordingAttemptCoordinator>;
  driver: RecordingAttemptDriverRequest; attemptId: string; fullAuditMs: number; beginMs: number; order: Array<'progress' | 'stop'>;
  progressMs?: number; stopReceivedAt?: number; abortAt?: number; stopInvokedAt?: number; stopAckAt?: number; receiptAt?: number; closeInvokedAt?: number; closeResolvedAt?: number;
  closeSettled: Promise<void>; resolveClose(): void;
}
let queue: QueueContext | undefined, queueSequence = 0;

function assertClosedSeed(task: CloneTask): void {
  const original = new DatabaseSync(task.clone.filePath, { readOnly: true, allowExtension: false });
  try {
    original.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;');
    if (original.prepare("SELECT 1 FROM recording_attempts WHERE status='in-progress' LIMIT 1").get()) throw new Error('排队Stop种子存在活动录音');
  } finally { original.close(); }
}

async function operatePrintWrite(task: PrintWriteTask): Promise<Extract<CapacityChildReceipt, { kind: 'print-write' }>> {
  verifyCapacityTaskPaths(task); controller.signal.throwIfAborted(); assertClosedSeed(task);
  const repository = createCollectionRepository({ filePath: task.clone.filePath });
  let coordinator: ReturnType<typeof createRecordingAttemptCoordinator> | undefined, driver: RecordingAttemptDriverRequest | undefined, coordinatorClosed = false;
  try {
    phase = 'audit';
    const { plan } = repository.recordingPlans.version({ id: task.planId });
    if (!plan || plan.contentHash !== task.planHash) throw new Error('冻结计划身份不符');
    readBackupIndex(task.clone.filePath); controller.signal.throwIfAborted();
    coordinator = createRecordingAttemptCoordinator({ store: repository.recordingAttempts, admissionProvider: {
      async authorize() {},
      async start(request) {
        driver = request;
        return { async stop() {}, async close() {} };
      },
    } });
    phase = 'begin';
    let attempt = await coordinator.begin({ commandId: randomUUID(), planVersionId: task.planId, planContentHash: task.planHash, userConfirmed: true });
    for (let index = 0; index < attempt.sides.length; ++index) {
      const side = attempt.sides[index]!, active = driver;
      if (!active || active.side !== side.side) throw new Error('fresh Completed驱动身份不符');
      const at = new Date().toISOString();
      active.onEvent({ type: 'progress', side: side.side, runId: active.runId, at, sourceFramesRead: side.frameCount, submittedFrames: side.frameCount, consumedFrames: side.frameCount });
      for (const type of ['source-eof', 'engine-cutoff', 'cleanup-quiescent', 'backend-drained'] as const) active.onEvent({ type, side: side.side, runId: active.runId, at });
      await new Promise<void>(resolve => setImmediate(resolve)); controller.signal.throwIfAborted();
      attempt = coordinator.get({ attemptId: attempt.id }).attempt!;
      attempt = await coordinator.confirm({ commandId: randomUUID(), attemptId: attempt.id, expectedRevision: attempt.revision, kind: 'physical-stop', side: side.side, userConfirmed: true });
      if (index + 1 < attempt.sides.length) {
        attempt = await coordinator.confirm({ commandId: randomUUID(), attemptId: attempt.id, expectedRevision: attempt.revision, kind: 'flip', userConfirmed: true });
        attempt = await coordinator.beginSide({ commandId: randomUUID(), attemptId: attempt.id, expectedRevision: attempt.revision, side: 'B', userConfirmed: true });
      }
    }
    phase = 'record-complete';
    for (const kind of ['physical-recording', 'final-verification'] as const) attempt = await coordinator.confirm({ commandId: randomUUID(), attemptId: attempt.id, expectedRevision: attempt.revision, kind, userConfirmed: true });
    if (attempt.status !== 'completed') throw new Error('fresh Completed未完成');
    await coordinator.close(); coordinatorClosed = true; coordinator = undefined;

    const db = new DatabaseSync(task.clone.filePath, { readOnly: true, allowExtension: false });
    let recordingId = '', pendingJobId = '', requestId = '', inputHash = '';
    try {
      const record = db.prepare('SELECT id FROM recording_records WHERE attempt_id=?').get(attempt.id);
      if (!record || typeof record.id !== 'string') throw new Error('fresh Completed未创建Record');
      const pending = db.prepare("SELECT j.id jobId,j.request_id requestId,json_extract(j.data,'$.request.inputHash') inputHash,json_extract(j.data,'$.state') state,json_extract(j.data,'$.revision') revision FROM recording_print_jobs j JOIN recording_print_requests r ON r.id=j.request_id WHERE r.recording_id=?").get(record.id);
      if (pending?.state !== 'pending' || pending.revision !== 1) throw new Error('fresh Completed未创建pending Print');
      recordingId = String(record.id); pendingJobId = String(pending.jobId); requestId = String(pending.requestId); inputHash = String(pending.inputHash);
    } finally { db.close(); }

    phase = 'claim'; const workerId = randomUUID(), claimAt = performance.now();
    const lease = repository.recordingPrints.claim({ workerId }).lease;
    const claimMs = performance.now() - claimAt;
    if (!lease || lease.jobId !== pendingJobId || lease.requestId !== requestId || lease.inputHash !== inputHash || lease.workerId !== workerId) throw new Error('Print lease身份不符');
    const pdfBytes = capacityPdf({ bytes: 4096, id: 'print-write-pdf' }), previewBytes = capacityJpeg({ bytes: 1024, id: 'print-write-preview' });
    const completeRequest = { jobId: lease.jobId, leaseId: lease.leaseId, workerId: lease.workerId, inputHash: lease.inputHash,
      pdfBase64: pdfBytes.toString('base64'), pdfSha256: createHash('sha256').update(pdfBytes).digest('hex'),
      preview: { dataUrl: `data:image/jpeg;base64,${previewBytes.toString('base64')}`, width: 1, height: 1 }, pageCount: 1 as const, rendererVersion: 'capacity-print-write-1' };
    phase = 'complete'; const completeAt = performance.now();
    const ready = repository.recordingPrints.complete(completeRequest), completeMs = performance.now() - completeAt;
    const countsBeforeReplay = new DatabaseSync(task.clone.filePath, { readOnly: true, allowExtension: false });
    const beforeReplay = countsBeforeReplay.prepare("SELECT (SELECT count(*) FROM recording_print_receipts WHERE id=?) receipts,(SELECT count(*) FROM recording_print_artifacts WHERE request_id=?) artifacts,(SELECT count(*) FROM recording_print_objects) objects").get(`lease:${lease.leaseId}`, requestId)!;
    countsBeforeReplay.close();
    const replay = repository.recordingPrints.complete(completeRequest);
    if (JSON.stringify(replay) !== JSON.stringify(ready)) throw new Error('Print complete非幂等');

    const evidenceDb = new DatabaseSync(task.clone.filePath, { readOnly: true, allowExtension: false });
    try {
      const request = evidenceDb.prepare('SELECT data FROM recording_print_requests WHERE id=?').get(requestId);
      const events = evidenceDb.prepare('SELECT revision,kind,data FROM recording_print_events WHERE job_id=? ORDER BY revision').all(pendingJobId) as Array<{ revision: number; kind: string; data: string }>;
      const receipt = evidenceDb.prepare("SELECT id,kind,fingerprint,request,result FROM recording_print_receipts WHERE id=? AND kind='complete'").get(`lease:${lease.leaseId}`);
      const artifactRow = evidenceDb.prepare('SELECT data FROM recording_print_artifacts WHERE id=? AND request_id=?').get(ready.artifactId, requestId);
      const afterReplay = evidenceDb.prepare("SELECT (SELECT count(*) FROM recording_print_receipts WHERE id=?) receipts,(SELECT count(*) FROM recording_print_artifacts WHERE request_id=?) artifacts,(SELECT count(*) FROM recording_print_objects) objects").get(`lease:${lease.leaseId}`, requestId)!;
      if (!request || !receipt || !artifactRow || JSON.stringify(beforeReplay) !== JSON.stringify(afterReplay)
        || events.length !== 3 || events.some((event, index) => event.revision !== index + 1 || event.kind !== ['create','claim','complete'][index])) throw new Error('Print持久链不完整');
      const eventValues = events.map(event => JSON.parse(String(event.data)) as { job: { id: string; request: { id: string; inputHash: string }; revision: number }; lease: null | { leaseId: string; workerId: string; jobId: string; requestId: string; inputHash: string } });
      if (eventValues.some((event, index) => event.job.id !== pendingJobId || event.job.request.id !== requestId || event.job.request.inputHash !== inputHash || event.job.revision !== index + 1)
        || eventValues[0]!.lease !== null || eventValues[2]!.lease !== null || JSON.stringify(eventValues[1]!.lease) !== JSON.stringify({ leaseId: lease.leaseId, workerId: lease.workerId, jobId: lease.jobId, requestId: lease.requestId, inputHash: lease.inputHash })) throw new Error('Print事件lease身份不符');
      const requestValue = JSON.parse(String(request.data)) as { id: string; recordingId: string; inputHash: string };
      const receiptRequest = JSON.parse(String(receipt.request)) as Record<string, unknown>, receiptResult = JSON.parse(String(receipt.result));
      const artifact = JSON.parse(String(artifactRow.data)) as { id: string; requestId: string; recordingId: string; inputHash: string; pdfSha256: string; previewSha256: string; size: number; previewSize: number; pageCount: number };
      if (requestValue.id !== requestId || requestValue.recordingId !== recordingId || requestValue.inputHash !== inputHash || JSON.stringify(receiptResult) !== JSON.stringify(ready)
        || ready.id !== pendingJobId || ready.request.id !== requestId || ready.request.inputHash !== inputHash || ready.state !== 'ready' || ready.revision !== 3 || ready.artifactId !== artifact.id
        || 'pdfBase64' in receiptRequest || 'preview' in receiptRequest || artifact.requestId !== requestId || artifact.recordingId !== recordingId || artifact.inputHash !== inputHash) throw new Error('Print回执或artifact身份不符');
      const pdf = evidenceDb.prepare('SELECT sha256,length(content) size,mime,width,height FROM recording_print_objects WHERE sha256=?').get(artifact.pdfSha256)!;
      const preview = evidenceDb.prepare('SELECT sha256,length(content) size,mime,width,height FROM recording_print_objects WHERE sha256=?').get(artifact.previewSha256)!;
      if (!pdf || !preview || pdf.sha256 !== artifact.pdfSha256 || pdf.mime !== 'application/pdf' || pdf.width !== null || pdf.height !== null || Number(pdf.size) !== artifact.size
        || preview.sha256 !== artifact.previewSha256 || preview.mime !== 'image/jpeg' || preview.width !== 1 || preview.height !== 1 || Number(preview.size) !== artifact.previewSize || artifact.pageCount !== 1) throw new Error('Print对象身份不符');
      phase = 'close'; controller.signal.throwIfAborted();
      return { kind: 'print-write', planId: task.planId, planHash: task.planHash, attemptId: attempt.id, recordingId, jobId: pendingJobId, requestId, inputHash,
        events: [{ revision: 1, kind: 'create' }, { revision: 2, kind: 'claim' }, { revision: 3, kind: 'complete' }],
        lease: { leaseId: lease.leaseId, workerId: lease.workerId, jobId: lease.jobId, requestId: lease.requestId, inputHash: lease.inputHash },
        job: { id: ready.id, requestId: ready.request.id, inputHash: ready.request.inputHash, state: 'ready', revision: 3, artifactId: ready.artifactId! },
        artifact: { id: artifact.id, requestId: artifact.requestId, recordingId: artifact.recordingId, inputHash: artifact.inputHash, pdfSha256: artifact.pdfSha256,
          previewSha256: artifact.previewSha256, size: artifact.size, previewSize: artifact.previewSize, pageCount: 1 },
        completeReceipt: { id: String(receipt.id), kind: 'complete', fingerprint: String(receipt.fingerprint) },
        pdf: { sha256: String(pdf.sha256), size: Number(pdf.size), mime: 'application/pdf', width: null, height: null },
        preview: { sha256: String(preview.sha256), size: Number(preview.size), mime: 'image/jpeg', width: 1, height: 1 },
        claimMs, completeMs, idempotent: true, ...evidence() };
    } finally { evidenceDb.close(); }
  } finally {
    if (!coordinatorClosed) try { await coordinator?.close(); } catch { /* 主失败分类不被测试清理覆盖。 */ }
    repository.close();
  }
}

async function prepareQueue(task: QueueTask): Promise<QueueContext> {
  verifyCapacityTaskPaths(task); controller.signal.throwIfAborted(); assertClosedSeed(task);
  const repository = createCollectionRepository({ filePath: task.clone.filePath });
  let coordinator: ReturnType<typeof createRecordingAttemptCoordinator> | undefined;
  try {
    phase = 'audit'; const auditAt = performance.now();
    const { plan } = repository.recordingPlans.version({ id: task.planId });
    if (!plan || plan.contentHash !== task.planHash) throw new Error('冻结计划身份不符');
    const fullAuditMs = performance.now() - auditAt;
    let driver: RecordingAttemptDriverRequest | undefined, abortAt: number | undefined, stopInvokedAt: number | undefined, stopAckAt: number | undefined;
    let closeInvokedAt: number | undefined, closeResolvedAt: number | undefined, resolveClose!: () => void;
    const closeSettled = new Promise<void>(resolve => { resolveClose = resolve; });
    const shell = {} as QueueContext;
    coordinator = createRecordingAttemptCoordinator({ store: repository.recordingAttempts, admissionProvider: {
      async authorize() {},
      async start(request) {
        driver = request;
        request.signal.addEventListener('abort', () => { abortAt ??= performance.now(); }, { once: true });
        return {
          async stop() {
            stopInvokedAt ??= performance.now();
            request.onEvent({ type: 'engine-cutoff', side: request.side, runId: request.runId, at: new Date().toISOString() });
            request.onEvent({ type: 'stop-ack', side: request.side, runId: request.runId, at: new Date().toISOString() });
            stopAckAt ??= performance.now();
          },
          async close() {
            closeInvokedAt ??= performance.now();
            request.onEvent({ type: 'cleanup-quiescent', side: request.side, runId: request.runId, at: new Date().toISOString() });
            closeResolvedAt ??= performance.now(); resolveClose();
          },
        };
      },
    } });
    phase = 'begin'; const beginAt = performance.now();
    const attempt = await coordinator.begin({ commandId: randomUUID(), planVersionId: task.planId, planContentHash: task.planHash, userConfirmed: true });
    const beginMs = performance.now() - beginAt;
    if (!driver) throw new Error('排队Stop驱动未建立');
    Object.assign(shell, { task, repository, coordinator, driver, attemptId: attempt.id, fullAuditMs, beginMs, order: [], closeSettled, resolveClose });
    Object.defineProperties(shell, {
      abortAt: { get: () => abortAt }, stopInvokedAt: { get: () => stopInvokedAt }, stopAckAt: { get: () => stopAckAt },
      closeInvokedAt: { get: () => closeInvokedAt }, closeResolvedAt: { get: () => closeResolvedAt },
    });
    return shell;
  } catch (error) {
    try { await coordinator?.close(); } finally { repository.close(); }
    throw error;
  }
}

async function operate(task: CapacityChildTask): Promise<CapacityChildReceipt> {
  verifyCapacityTaskPaths(task); controller.signal.throwIfAborted();
  if (task.kind === 'print-write') return operatePrintWrite(task);
  if (task.kind === 'cold') {
    // repository首次访问会恢复中断；先只读核前提，不能把活动种子改写成合格样本。
    phase = 'open';
    const original = new DatabaseSync(task.clone.filePath, { readOnly: true, allowExtension: false });
    try {
      original.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;');
      if (original.prepare("SELECT 1 FROM recording_attempts WHERE status='in-progress' LIMIT 1").get()) throw new Error('冷开种子存在活动录音');
    } finally { original.close(); }
    let database: DatabaseSync | undefined, budget: ReturnType<typeof readCapacityBudget> | undefined;
    const repository = createCollectionRepository({ filePath: task.clone.filePath });
    let repositoryOpenMs = 0, fullAuditMs = 0, databaseCloseMs = 0;
    try {
      phase = 'open'; let before = performance.now();
      const { plan } = repository.recordingPlans.version({ id: task.planId });
      if (!plan || plan.contentHash !== task.planHash) throw new Error('冻结计划身份不符');
      repositoryOpenMs = performance.now() - before; controller.signal.throwIfAborted();
      phase = 'audit'; before = performance.now();
      readBackupIndex(task.clone.filePath);
      database = new DatabaseSync(task.clone.filePath, { readOnly: true, allowExtension: false });
      database.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;');
      budget = readCapacityBudget(database);
      if (database.prepare("SELECT 1 FROM recording_attempts WHERE status='in-progress' LIMIT 1").get()) throw new Error('冷开种子存在活动录音');
      fullAuditMs = performance.now() - before;
    } finally {
      const before = performance.now();
      try { database?.close(); } finally { repository.close(); }
      databaseCloseMs = performance.now() - before;
    }
    phase = 'close'; controller.signal.throwIfAborted();
    return { kind: 'cold', planId: task.planId, planHash: task.planHash, budget: budget!, repositoryOpenMs, fullAuditMs, databaseCloseMs, ...evidence() };
  }
  if (task.kind === 'queue') throw new Error('排队Stop由有状态IPC分支执行');
  const capability = async (p: string) => ({ ...await authorizeSourceDirectory(p), id: randomUUID() });
  const backup = await capability(task.backupPath), destination = await capability(task.destinationPath);
  const protectedRoots = await Promise.all(task.protectedRootPaths.map(capability));
  phase = 'verify-backup'; let before = performance.now();
  const source = await verifyArchiveBackup(backup, controller.signal);
  if (source.mode !== 'archive-content' || !source.contentIncluded || source.incompleteOperationIds.length || source.id !== task.expected.id
    || hashCapacityFile(path.join(backup.path, 'Backup.json')) !== task.expected.manifestHash) throw new Error('完整备份身份不符');
  const verifyBackupMs = performance.now() - before;
  phase = 'restore'; before = performance.now();
  const restored = await restoreArchiveBackup({ backup, destination, protectedRoots, id: task.restoreId, userConfirmed: true, expectedBackupIdentity: task.expected, signal: controller.signal });
  const restoreMs = performance.now() - before;
  phase = 'verify-restored'; before = performance.now();
  const verified = await verifyRestoredArchive(restored.directory, controller.signal);
  if (verified.state !== 'isolated-pending-activation' || !verified.contentIncluded || verified.sourceBackupId !== task.expected.id
    || verified.sourceManifestHash !== task.expected.manifestHash || verified.id !== task.restoreId) throw new Error('隔离恢复身份不符');
  const verifyRestoredMs = performance.now() - before;
  controller.signal.throwIfAborted();
  return { kind: 'restore', id: verified.id, sourceBackupId: verified.sourceBackupId, sourceManifestHash: verified.sourceManifestHash,
    state: verified.state, contentIncluded: true, objectCount: verified.objects.length, objectBytes: verified.objects.reduce((n, v) => n + v.size, 0),
    databaseSha256: verified.database.sha256, verifyBackupMs, restoreMs, verifyRestoredMs, ...evidence() };
}
function disconnect() { if (process.connected) process.disconnect(); }
function send(value: object): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send || !process.connected) { reject(new Error('测试父进程已断开')); return; }
    process.send({ version: 1, requestId, childPid: process.pid, ...value }, error => error ? reject(new Error('测试消息发送失败')) : resolve());
  });
}
async function failed(code: 'INVALID_PROTOCOL' | 'AUDIT_FAILED' | 'RESTORE_FAILED' | 'QUEUE_FAILED' | 'PRINT_WRITE_FAILED' | 'CLEANUP_FAILED') {
  if (finished) return; finished = true; process.exitCode = 1;
  if (queue) {
    try { await queue.coordinator.close(); } catch { /* 原失败保持为主分类。 */ }
    try { queue.repository.close(); } catch { /* 原失败保持为主分类。 */ }
  }
  try { await send({ type: 'failed', code, phase, elapsedMs: elapsed() }); } catch { /* 固定错误，不打印路径或内部异常。 */ }
  disconnect();
}

function handleQueueProgress(value: unknown): void {
  if (!queue || queueSequence !== 0 || !isCapacityQueueProgress(value, requestId)) throw new Error('排队progress协议无效');
  phase = 'progress'; queueSequence = 1; queue.order.push('progress'); const before = performance.now();
  queue.driver.onEvent({ type: 'progress', side: queue.driver.side, runId: queue.driver.runId, at: new Date().toISOString(), sourceFramesRead: 1, submittedFrames: 1, consumedFrames: 1 });
  const current = queue.coordinator.get({ attemptId: queue.attemptId }).attempt;
  if (current?.sides.find(side => side.side === queue!.driver.side)?.consumedFrames !== 1) throw new Error('排队progress未持久化');
  queue.progressMs = performance.now() - before;
}

async function handleQueueStop(value: unknown): Promise<void> {
  if (!queue || queueSequence !== 1 || !isCapacityQueueStop(value, requestId)) throw new Error('排队Stop协议无效');
  phase = 'stop'; queueSequence = 2; queue.order.push('stop'); queue.stopReceivedAt = performance.now();
  const stopped = await queue.coordinator.stop({ commandId: value.commandId, attemptId: queue.attemptId });
  queue.receiptAt = performance.now();
  if (stopped.status !== 'aborted' || !queue.abortAt || !queue.stopInvokedAt || !queue.stopAckAt || queue.progressMs === undefined) throw new Error('排队Stop缺少原回执或驱动证据');
  const sinceStop = (at: number) => at - queue!.stopReceivedAt!;
  const receipt = {
    kind: 'queue' as const, planId: queue.task.planId, planHash: queue.task.planHash, attemptId: queue.attemptId,
    order: ['progress', 'stop'] as ['progress', 'stop'], progressFrames: 1 as const, fullAuditMs: queue.fullAuditMs, beginMs: queue.beginMs, progressMs: queue.progressMs,
    abortObserved: true as const, driverStopInvoked: true as const, driverStopAcknowledged: true as const,
    stopReceivedToAbortMs: sinceStop(queue.abortAt), stopReceivedToDriverStopInvokedMs: sinceStop(queue.stopInvokedAt),
    stopReceivedToDriverStopAckMs: sinceStop(queue.stopAckAt), stopReceivedToReceiptMs: sinceStop(queue.receiptAt), ...evidence(),
  } satisfies Omit<CapacityQueuedStopReceipt, 'driverCloseInvoked' | 'driverCloseResolved' | 'stopReceivedToDriverCloseInvokedMs' | 'stopReceivedToDriverCloseResolvedMs'>;
  await send({ type: 'receipt', result: receipt });
  phase = 'close';
  await queue.closeSettled; await queue.coordinator.close(); queue.repository.close();
  if (finished) return;
  if (!queue.closeInvokedAt || !queue.closeResolvedAt) throw new Error('排队Stop缺少关闭屏障');
  await send({ type: 'cleanup', result: { driverCloseInvoked: true, driverCloseResolved: true,
    stopReceivedToDriverCloseInvokedMs: sinceStop(queue.closeInvokedAt), stopReceivedToDriverCloseResolvedMs: sinceStop(queue.closeResolvedAt) } });
  finished = true; clearTimeout(timer); disconnect();
}

let timer: NodeJS.Timeout;
if (!process.send || process.argv.length !== 4 || process.argv[2] !== '--capacity-child' || !isCapacityRequestId(requestId)) {
  process.exitCode = 1; disconnect();
} else {
  timer = setTimeout(() => { invalid = true; controller.abort(); void failed('INVALID_PROTOCOL'); }, 50_000);
  process.on('disconnect', () => { clearTimeout(timer); controller.abort(); if (!finished) process.exitCode = 1; });
  process.on('message', value => {
    if (capacityMessageBytes(value) > 65_536) { invalid = true; controller.abort(); void failed('INVALID_PROTOCOL'); return; }
    if (accepted) {
      if (!queue || finished) { invalid = true; controller.abort(); void failed('INVALID_PROTOCOL'); return; }
      try {
        if (queueSequence === 0) handleQueueProgress(value);
        else if (queueSequence === 1) void handleQueueStop(value).catch(() => failed(phase === 'close' ? 'CLEANUP_FAILED' : 'QUEUE_FAILED'));
        else { invalid = true; controller.abort(); void failed('INVALID_PROTOCOL'); }
      } catch { invalid = true; controller.abort(); void failed('INVALID_PROTOCOL'); }
      return;
    }
    if (!isCapacityInit(value, requestId)) { invalid = true; controller.abort(); void failed('INVALID_PROTOCOL'); return; }
    accepted = true;
    void (async () => {
      try {
        if (value.task.kind === 'queue') {
          queue = await prepareQueue(value.task);
          await send({ type: 'ready' });
          return;
        }
        await send({ type: 'ready' });
        const result = await operate(value.task);
        // 给已到达IPC队列的重复init一次失效机会，不能在成功发送后忽略。
        await new Promise<void>(resolve => setImmediate(resolve));
        if (invalid) throw new Error('私有协议失效');
        await send({ type: 'receipt', result }); finished = true; clearTimeout(timer); disconnect();
      } catch {
        clearTimeout(timer); await failed(invalid ? 'INVALID_PROTOCOL' : value.task.kind === 'cold' ? 'AUDIT_FAILED' : value.task.kind === 'queue' ? 'QUEUE_FAILED' : value.task.kind === 'print-write' ? 'PRINT_WRITE_FAILED' : 'RESTORE_FAILED');
      }
    })();
  });
}
