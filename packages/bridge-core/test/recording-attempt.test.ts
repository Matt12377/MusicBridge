import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createCollectionRepository } from '../src/collection/repository.js';
import { createRecordingAttemptCoordinator } from '../src/recording/attempt-coordinator.js';
import { verifyRecordingAttemptDatabase } from '../src/recording/attempt-integrity.js';
import { recordingAttemptFixture as fixture } from './helpers/recording-attempt-fixture.js';
import type { RecordingAttemptDriver } from '../src/recording/attempt-coordinator.js';
import { createRecordingAttemptStore } from '../src/recording/attempt-store.js';

const page = { offset: 0, limit: 25 };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function rows(filePath: string) {
  const db = new DatabaseSync(filePath, { readOnly: true });
  try { return ['recording_attempts', 'recording_attempt_events', 'recording_attempt_receipts', 'physical_copies', 'inventory_lots', 'inventory_ledger'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]); }
  finally { db.close(); }
}

test('生产未认证Begin固定拒绝，正式历史/账本/库存均不写且不调用驱动', async t => {
  const f = await fixture(t), coordinator = createRecordingAttemptCoordinator({ store: f.repository.recordingAttempts });
  t.after(() => coordinator.close()); const before = rows(f.filePath);
  await assert.rejects(coordinator.begin(f.beginRequest()), { code: 'BACKEND_NOT_CERTIFIED' });
  assert.deepEqual(rows(f.filePath), before); assert.equal(f.starts.length, 0);
});

test('同命令同body返回原回执且不重启输出，异body拒绝；并发Begin只准一个', async t => {
  const f = await fixture(t), request = f.beginRequest();
  const [a, b] = await Promise.all([f.attempts.begin(request), f.attempts.begin(request)]);
  assert.deepEqual(a, b); assert.equal(f.starts.length, 1);
  await assert.rejects(f.attempts.begin({ ...request, planContentHash: 'a'.repeat(64) }), { code: 'COMMAND_CONFLICT' });
  await assert.rejects(f.attempts.begin(f.beginRequest()), { code: 'ATTEMPT_CONFLICT' });
  const stopped = await f.attempts.stop({ commandId: randomUUID(), attemptId: a.id });
  assert.equal(stopped.status, 'aborted');
  assert.deepEqual(await f.attempts.begin(request), a, '原命令永久返回原结果，不把后来终态回填到开始回执');
  assert.equal(f.starts.length, 1);
});

test('停止回执不伪造驱动ACK/排空，迟到成功和旧runId不能覆盖首个终态', async t => {
  const f = await fixture(t), a = await f.attempts.begin(f.beginRequest()), driver = f.starts[0]!;
  const request = { commandId: randomUUID(), attemptId: a.id }, stopped = await f.attempts.stop(request);
  assert.equal(stopped.sides[0]!.stopAcknowledged, false); assert.equal(stopped.sides[0]!.backendDrained, false);
  driver.onEvent({ type: 'backend-drained', side: 'A', runId: driver.runId, at: new Date().toISOString() });
  driver.onEvent({ type: 'interrupt', reason: 'device-lost', side: 'A', runId: randomUUID(), at: new Date().toISOString() });
  assert.deepEqual(await f.attempts.stop(request), stopped);
  assert.equal(f.attempts.get({ attemptId: a.id }).attempt!.reason, 'user-stop');
  assert.equal(f.attempts.get({ attemptId: a.id }).attempt!.softwarePlaybackComplete, false);
});

test('命令确认CAS与事务提交故障不留下孤立event/head/receipt', async t => {
  const f = await fixture(t), a = await f.attempts.begin(f.beginRequest());
  await assert.rejects(f.attempts.confirm({ commandId: randomUUID(), attemptId: a.id, expectedRevision: a.revision + 1, kind: 'physical-stop', side: 'A', userConfirmed: true }), { code: 'VERSION_MISMATCH' });
  const repository = createCollectionRepository({ filePath: f.filePath, beforeCommit(action) { if (action === 'attempt-stop') throw new Error('合成提交故障'); } });
  t.after(() => repository.close());
  // 新连接先执行冷启中断；此后的命令事务仍须完全回滚。
  repository.recordingAttempts.list({ page }); const before = rows(f.filePath);
  assert.throws(() => repository.recordingAttempts.command('stop', { commandId: randomUUID(), attemptId: a.id }, { type: 'abort', reason: 'user-stop', at: new Date().toISOString() }));
  assert.deepEqual(rows(f.filePath), before);
});

test('冷启将未结束Attempt仅中断一次，恢复不调用任何driver且不伪造cleanup', async t => {
  const f = await fixture(t), a = await f.attempts.begin(f.beginRequest());
  const first = createCollectionRepository({ filePath: f.filePath });
  const recovered = first.recordingAttempts.get({ attemptId: a.id }).attempt!;
  assert.equal(recovered.status, 'interrupted'); assert.equal(recovered.reason, 'app-restarted');
  assert.equal(recovered.sides[0]!.cleanupQuiescent, false); first.close();
  const second = createCollectionRepository({ filePath: f.filePath }); t.after(() => second.close());
  assert.deepEqual(second.recordingAttempts.get({ attemptId: a.id }).attempt, recovered);
  assert.equal(f.starts.length, 1);
});

test('开始后的实体不能从规划或手工释放为空白，库存数量不变', async t => {
  const f = await fixture(t), before = f.repository.list(page).items[0]!.counts;
  const a = await f.attempts.begin(f.beginRequest()); await f.attempts.stop({ commandId: randomUUID(), attemptId: a.id });
  assert.throws(() => f.repository.media.release({ commandId: randomUUID(), planId: f.plan.id, expectedRevision: f.plan.revision, userConfirmed: true }));
  assert.throws(() => f.repository.updateCopy({ commandId: randomUUID(), physicalId: a.physicalId, expectedRevision: f.frozenPlan.physicalCopy.revision, action: 'cancel-reservation' }));
  assert.deepEqual(f.repository.list(page).items[0]!.counts, before);
});

test('只读完整性核验拒绝篡改head，冷启不得把坏历史修成合法Interrupted', async t => {
  const f = await fixture(t), a = await f.attempts.begin(f.beginRequest());
  const db = new DatabaseSync(f.filePath); t.after(() => db.close()); verifyRecordingAttemptDatabase(db);
  db.prepare("UPDATE recording_attempts SET data=json_set(data,'$.revision',99) WHERE id=?").run(a.id);
  assert.throws(() => verifyRecordingAttemptDatabase(db)); const before = rows(f.filePath);
  const invalid = createCollectionRepository({ filePath: f.filePath }); t.after(() => invalid.close());
  assert.throws(() => invalid.recordingAttempts.list({ page })); assert.deepEqual(rows(f.filePath), before);
});

test('DAT独立Program身份固定；分页与越界保留正确total', async t => {
  const f = await fixture(t, 'dat'), a = await f.attempts.begin(f.beginRequest());
  assert.deepEqual(a.sides.map(side => side.side), ['Program']); assert.equal(f.starts[0]!.side, 'Program');
  const result = f.attempts.list({ page: { offset: 10, limit: 1 }, draftId: a.draftId });
  assert.deepEqual(result, { items: [], offset: 10, limit: 1, total: 1, hasMore: false });
  await assert.rejects(f.attempts.beginSide({ commandId: randomUUID(), attemptId: a.id, expectedRevision: a.revision, side: 'B', userConfirmed: true }));
});

test('已打开库中合法形状的head篡改也必须拒读，不能仅靠DTO结构校验', async t => {
  const f = await fixture(t), a = await f.attempts.begin(f.beginRequest());
  const db = new DatabaseSync(f.filePath); t.after(() => db.close());
  db.prepare("UPDATE recording_attempts SET data=json_set(data,'$.updatedAt','2099-01-01T00:00:00.000Z') WHERE id=?").run(a.id);
  assert.throws(() => f.attempts.get({ attemptId: a.id }));
});

test('close先到后start迟到成功必须拒绝原Promise，并关闭该迟到handle', async t => {
  const f = await fixture(t), entered = deferred<void>(), handle = deferred<RecordingAttemptDriver>();
  let stops = 0, closes = 0;
  const coordinator = createRecordingAttemptCoordinator({ store: f.repository.recordingAttempts, admissionProvider: { async authorize() {}, start() { entered.resolve(); return handle.promise; } } });
  const pending = coordinator.begin(f.beginRequest()); await entered.promise;
  const rejected = assert.rejects(pending, { code: 'CLOSED' }), closing = coordinator.close();
  handle.resolve({ async stop() { ++stops; }, async close() { ++closes; } });
  await rejected; await closing; assert.equal(stops, 1); assert.equal(closes, 1);
  assert.equal(f.repository.recordingAttempts.list({ page }).items[0]!.status, 'interrupted');
});

test('stop先到不遗失晚返回handle，terminal但close未完成仍阻断新Begin', async t => {
  const f = await fixture(t), entered = deferred<void>(), handle = deferred<RecordingAttemptDriver>(), closedHandle = deferred<void>();
  let stops = 0, closes = 0;
  const coordinator = createRecordingAttemptCoordinator({ store: f.repository.recordingAttempts, admissionProvider: { async authorize() {}, start() { entered.resolve(); return handle.promise; } } });
  t.after(() => coordinator.close());
  const pending = coordinator.begin(f.beginRequest()); await entered.promise;
  const a = coordinator.list({ page }).items[0]!;
  await coordinator.stop({ commandId: randomUUID(), attemptId: a.id });
  handle.resolve({ async stop() { ++stops; }, async close() { ++closes; await closedHandle.promise; } });
  await pending;
  await assert.rejects(coordinator.begin(f.beginRequest()), { code: 'ATTEMPT_CONFLICT' });
  closedHandle.resolve(); await coordinator.close(); assert.equal(stops, 1); assert.equal(closes, 1);
});

test('准入期间切库或close使迟到成功失效，不留Attempt且零driver调用', async t => {
  for (const mode of ['scope', 'close'] as const) {
    const f = await fixture(t), entered = deferred<void>(), admitted = deferred<void>(); let current = true, starts = 0;
    const coordinator = createRecordingAttemptCoordinator({ store: f.repository.recordingAttempts, assertCurrent() { if (!current) throw new Error('合成旧工作库'); }, admissionProvider: {
      async authorize() { entered.resolve(); await admitted.promise; }, async start() { ++starts; return { async stop() {}, async close() {} }; },
    } });
    const pending = coordinator.begin(f.beginRequest()); await entered.promise;
    const rejected = assert.rejects(pending); let closing: Promise<void> | undefined;
    if (mode === 'scope') current = false; else closing = coordinator.close();
    admitted.resolve(); await rejected; await closing; await coordinator.close();
    assert.equal(starts, 0); assert.equal(f.repository.recordingAttempts.list({ page }).total, 0);
  }
});

test('start未产生进度即失败保存Failed，不能与已输出中断混淆', async t => {
  const f = await fixture(t), coordinator = createRecordingAttemptCoordinator({ store: f.repository.recordingAttempts, admissionProvider: { async authorize() {}, async start() { throw new Error('合成启动失败'); } } });
  await assert.rejects(coordinator.begin(f.beginRequest()), { code: 'BACKEND_FAILURE' });
  const a = f.repository.recordingAttempts.list({ page }).items[0]!;
  assert.equal(a.status, 'failed'); assert.equal(a.reason, 'backend-start-failed');
  await coordinator.close().catch(() => undefined);
});

test('时钟回拨不能挡住明确Stop，安全事件时间不得早于既有事实', async t => {
  const f = await fixture(t), a = await f.attempts.begin(f.beginRequest()), driver = f.starts[0]!;
  driver.onEvent({ type: 'progress', side: 'A', runId: driver.runId, at: '2099-01-01T00:00:00.000Z', sourceFramesRead: 1, submittedFrames: 1, consumedFrames: 0 });
  const stopped = await f.attempts.stop({ commandId: randomUUID(), attemptId: a.id });
  assert.equal(stopped.status, 'aborted'); assert.equal(stopped.updatedAt, '2099-01-01T00:00:00.000Z');
});

test('停止写入故障也必须停止自建driver，不能因事务失败继续输出', async t => {
  const f = await fixture(t); let failStop = false, stops = 0;
  const repository = createCollectionRepository({ filePath: f.filePath, beforeCommit(action) { if (failStop && action === 'attempt-stop') throw new Error('合成停止写入故障'); } });
  t.after(() => repository.close());
  const coordinator = createRecordingAttemptCoordinator({ store: repository.recordingAttempts, admissionProvider: { async authorize() {}, async start() { return { async stop() { ++stops; }, async close() {} }; } } });
  t.after(() => coordinator.close()); const a = await coordinator.begin(f.beginRequest()); failStop = true;
  await assert.rejects(coordinator.stop({ commandId: randomUUID(), attemptId: a.id }));
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(stops, 1);
  assert.equal(coordinator.get({ attemptId: a.id }).attempt!.status, 'interrupted');
});

test('旧Attempt终态仍保护同一实体，新Begin不能无核实重录', async t => {
  const f = await fixture(t), a = await f.attempts.begin(f.beginRequest());
  await f.attempts.stop({ commandId: randomUUID(), attemptId: a.id });
  await new Promise<void>(resolve => setImmediate(resolve));
  await assert.rejects(f.attempts.begin(f.beginRequest()), { code: 'COPY_UNAVAILABLE' }); assert.equal(f.starts.length, 1);
});

test('只向下收紧存储预算，进度耗尽时仍保留一次安全Interrupted空间', async t => {
  const f = await fixture(t), db = new DatabaseSync(f.filePath); t.after(() => db.close());
  const store = createRecordingAttemptStore({ read: fn => fn(db), databaseBudgetBytes: 80 * 1024 });
  const coordinator = createRecordingAttemptCoordinator({ store, admissionProvider: f.provider }); t.after(() => coordinator.close());
  const a = await coordinator.begin(f.beginRequest()), driver = f.starts[0]!;
  for (let frame = 1; frame < 100 && store.get({ attemptId: a.id }).attempt!.status === 'in-progress'; ++frame) driver.onEvent({ type: 'progress', side: 'A', runId: driver.runId, at: new Date().toISOString(), sourceFramesRead: frame, submittedFrames: frame, consumedFrames: frame });
  const final = store.get({ attemptId: a.id }).attempt!;
  assert.equal(final.status, 'interrupted'); assert.equal(final.softwarePlaybackComplete, false);
  verifyRecordingAttemptDatabase(db); assert.equal(store.list({ page }).total, 1);
});

test('driver close永不完成时close有界失败，历史不伪造静止或排空', async t => {
  const f = await fixture(t), never = new Promise<void>(() => {});
  const coordinator = createRecordingAttemptCoordinator({ store: f.repository.recordingAttempts, closeTimeoutMs: 25, admissionProvider: { async authorize() {}, async start() { return { async stop() {}, close: () => never }; } } });
  const a = await coordinator.begin(f.beginRequest()); await assert.rejects(coordinator.close(), { code: 'BACKEND_FAILURE' });
  const after = f.repository.recordingAttempts.get({ attemptId: a.id }).attempt!;
  assert.equal(after.status, 'interrupted'); assert.equal(after.sides[0]!.cleanupQuiescent, false); assert.equal(after.sides[0]!.backendDrained, false);
  await assert.rejects(coordinator.begin(f.beginRequest()), { code: 'CLOSED' });
});

test('真实A/B冻结资产到三层完成的持久链：翻面确认不输出，B必须新边界', async t => {
  const f = await fixture(t), initial = await f.attempts.begin(f.beginRequest());
  assert.deepEqual(initial.sides.map(side => side.side), ['A', 'B']);
  async function completeSide(index: number) {
    const driver = f.starts[index]!, side = driver.attempt.sides.find(value => value.side === driver.side)!;
    const identity = { side: driver.side, runId: driver.runId, at: new Date().toISOString() };
    driver.onEvent({ ...identity, type: 'progress', sourceFramesRead: side.frameCount, submittedFrames: side.frameCount, consumedFrames: side.frameCount });
    driver.onEvent({ ...identity, type: 'source-eof' });
    assert.equal(f.attempts.get({ attemptId: initial.id }).attempt!.status, 'in-progress');
    driver.onEvent({ ...identity, type: 'engine-cutoff' }); driver.onEvent({ ...identity, type: 'backend-drained' });
    await new Promise<void>(resolve => setImmediate(resolve));
    const current = f.attempts.get({ attemptId: initial.id }).attempt!;
    return f.attempts.confirm({ commandId: randomUUID(), attemptId: current.id, expectedRevision: current.revision, kind: 'physical-stop', side: driver.side, userConfirmed: true });
  }
  const a = await completeSide(0); assert.equal(a.phase, 'awaiting-flip'); assert.equal(f.starts.length, 1);
  const flip = await f.attempts.confirm({ commandId: randomUUID(), attemptId: a.id, expectedRevision: a.revision, kind: 'flip', userConfirmed: true });
  assert.equal(f.starts.length, 1);
  await f.attempts.beginSide({ commandId: randomUUID(), attemptId: a.id, expectedRevision: flip.revision, side: 'B', userConfirmed: true });
  assert.equal(f.starts.length, 2); assert.notEqual(f.starts[0]!.runId, f.starts[1]!.runId);
  const b = await completeSide(1); assert.equal(b.softwarePlaybackComplete, true); assert.equal(b.status, 'in-progress');
  const physical = await f.attempts.confirm({ commandId: randomUUID(), attemptId: b.id, expectedRevision: b.revision, kind: 'physical-recording', userConfirmed: true });
  assert.equal(physical.status, 'in-progress');
  const final = await f.attempts.confirm({ commandId: randomUUID(), attemptId: b.id, expectedRevision: physical.revision, kind: 'final-verification', userConfirmed: true });
  assert.equal(final.status, 'completed');
  const db = new DatabaseSync(f.filePath, { readOnly: true }); t.after(() => db.close()); verifyRecordingAttemptDatabase(db);
});

test('持久化开始边界失败零driver；start同步事件到达时头和原命令回执已经存在', async t => {
  const f = await fixture(t); let failBegin = true, starts = 0;
  const repository = createCollectionRepository({ filePath: f.filePath, beforeCommit(action) { if (failBegin && action === 'attempt-begin') throw new Error('合成开始提交故障'); } });
  t.after(() => repository.close());
  const coordinator = createRecordingAttemptCoordinator({ store: repository.recordingAttempts, admissionProvider: { async authorize() {}, async start(request) {
    ++starts; assert.equal(repository.recordingAttempts.get({ attemptId: request.attempt.id }).attempt!.revision, 1);
    request.onEvent({ type: 'progress', side: request.side, runId: request.runId, at: new Date().toISOString(), sourceFramesRead: 1, submittedFrames: 1, consumedFrames: 0 });
    return { async stop() {}, async close() {} };
  } } });
  t.after(() => coordinator.close()); const request = f.beginRequest();
  await assert.rejects(coordinator.begin(request)); assert.equal(starts, 0); assert.equal(repository.recordingAttempts.list({ page }).total, 0);
  failBegin = false; const result = await coordinator.begin(request);
  assert.equal(starts, 1); assert.equal(result.revision, 1); assert.equal(repository.recordingAttempts.get({ attemptId: result.id }).attempt!.revision, 2);
  assert.deepEqual(await coordinator.begin(request), result);
});

test('只锁活动Attempt所选规划，其他实体仍可规划预留，终态不永久锁草稿编辑', async t => {
  const f = await fixture(t), a = await f.attempts.begin(f.beginRequest());
  const preview = await f.media.preview({ draftId: a.draftId, spec: f.layout.spec, page });
  const request = { draftId: a.draftId, expectedDraftRevision: preview.draftRevision, inputFingerprint: preview.inputFingerprint, spec: f.layout.spec };
  await assert.rejects(f.media.save({ ...request, commandId: randomUUID(), planId: f.plan.id, expectedRevision: f.plan.revision }));
  const other = await f.media.save({ ...request, commandId: randomUUID() });
  const reserved = await f.media.reserve({ commandId: randomUUID(), planId: other.id, expectedRevision: other.revision, skuId: f.plan.reservation!.skuId, packaging: 'opened', userConfirmed: true });
  assert.notEqual(reserved.reservation!.physicalId, a.physicalId);
  await f.attempts.stop({ commandId: randomUUID(), attemptId: a.id });
  const edited = await f.media.save({ ...request, commandId: randomUUID(), planId: f.plan.id, expectedRevision: f.plan.revision });
  assert.equal(edited.revision, f.plan.revision + 1); assert.equal(edited.reservation!.physicalId, a.physicalId);
});
