import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { PhysicalRecordingDispositionIntent, PreviewPhysicalRecordingDispositionRequest } from '@music-bridge/contracts';
import { recordingAttemptFixture } from './helpers/recording-attempt-fixture.js';

const page = { offset: 0, limit: 25 };
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
async function completed(t: test.TestContext, cleanup = true) {
  const f = await recordingAttemptFixture(t), initial = await f.attempts.begin(f.beginRequest());
  const current = () => f.attempts.get({ attemptId: initial.id }).attempt!;
  for (let index = 0; index < initial.sides.length; ++index) {
    const driver = f.starts[index]!, side = current().sides[index]!;
    const identity = { side: side.side, runId: driver.runId, at: new Date().toISOString() };
    driver.onEvent({ ...identity, type: 'progress', sourceFramesRead: side.frameCount, submittedFrames: side.frameCount, consumedFrames: side.frameCount });
    driver.onEvent({ ...identity, type: 'source-eof' });
    driver.onEvent({ ...identity, type: 'engine-cutoff' });
    if (cleanup) driver.onEvent({ ...identity, type: 'cleanup-quiescent' });
    else driver.onEvent({ ...identity, type: 'stop-ack' });
    driver.onEvent({ ...identity, type: 'backend-drained' });
    await turn();
    await f.attempts.confirm({ commandId: randomUUID(), attemptId: initial.id, expectedRevision: current().revision, kind: 'physical-stop', side: side.side, userConfirmed: true });
    if (index + 1 < initial.sides.length) {
      await f.attempts.confirm({ commandId: randomUUID(), attemptId: initial.id, expectedRevision: current().revision, kind: 'flip', userConfirmed: true });
      await f.attempts.beginSide({ commandId: randomUUID(), attemptId: initial.id, expectedRevision: current().revision, side: 'B', userConfirmed: true });
    }
  }
  await f.attempts.confirm({ commandId: randomUUID(), attemptId: initial.id, expectedRevision: current().revision, kind: 'physical-recording', userConfirmed: true });
  const attempt = await f.attempts.confirm({ commandId: randomUUID(), attemptId: initial.id, expectedRevision: current().revision, kind: 'final-verification', userConfirmed: true });
  assert.equal(attempt.status, 'completed');
  return { ...f, attempt };
}
async function fixture(t: test.TestContext, cleanup = true) {
  const f = await completed(t, cleanup);
  const { createRecordingRecordStore } = await import('../src/recording/record-store.js');
  const { createRecordingRecordCoordinator } = await import('../src/recording/record-coordinator.js');
  const db = new DatabaseSync(f.filePath); db.exec('PRAGMA foreign_keys=ON'); t.after(() => db.close());
  let failCommit = false, idle = true, scope = true;
  const store = createRecordingRecordStore({ read: fn => fn(db), beforeCommit() { if (failCommit) throw new Error('合成处置提交失败'); } });
  const records = createRecordingRecordCoordinator({ store, assertCurrent() { if (!scope) throw new Error('合成旧数据集'); }, assertExecutionIdle() { if (!idle) throw new Error('合成执行槽仍在关闭'); } });
  t.after(() => records.close());
  const request = (intent: PhysicalRecordingDispositionIntent): PreviewPhysicalRecordingDispositionRequest => {
    const state = records.history({ physicalId: f.attempt.physicalId, page }).state;
    return { physicalId: state.physicalId, expectedPhysicalRevision: state.physicalRevision, expectedContentRevision: state.revision, expectedAttempt: state.latestAttempt ? { id: state.latestAttempt.id, revision: state.latestAttempt.revision } : null, intent };
  };
  const apply = (intent: PhysicalRecordingDispositionIntent) => {
    const proposal = records.previewDisposition(request(intent));
    return records.applyDisposition({ ...proposal.request, proposalFingerprint: proposal.proposalFingerprint, commandId: randomUUID(), userConfirmed: true });
  };
  return { ...f, records, store, db, request, apply, setFail(value: boolean) { failCommit = value; }, setIdle(value: boolean) { idle = value; }, setScope(value: boolean) { scope = value; } };
}
function facts(db: DatabaseSync) {
  return ['physical_copies', 'inventory_lots', 'inventory_ledger', 'media_plans', 'media_reservations', 'recording_attempts', 'recording_attempt_events', 'recording_attempt_receipts', 'recording_record_current', 'recording_record_events', 'recording_record_permits', 'recording_record_receipts'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]);
}

test('Completed正式记录从同一实体进入双库，不改变origin或数量且不走旧录音编辑', async t => {
  const f = await completed(t), entries = f.repository.music.list(page);
  assert.equal(entries.total, 1, '正式Completed目前尚未进入实体音乐库');
  const entry = entries.items[0]!;
  assert.equal(entry.id, f.attempt.physicalId); assert.equal(entry.quantity, 1); assert.equal(entry.contentStatus, 'formal');
  const detail = f.repository.music.detail(entry.id);
  assert.ok(detail.formal); assert.equal(detail.recording, undefined); assert.equal(detail.release, undefined);
  const copy = f.repository.detail(entry.modelId!, page).copies.items.find(value => value.physicalId === entry.id)!;
  assert.equal(copy.origin, f.frozenPlan.physicalCopy.origin); assert.deepEqual(copy.recordingState, entry.recordingState);
  assert.throws(() => f.repository.music.saveLegacy({ commandId: randomUUID(), physicalId: entry.id, expectedRevision: entry.revision, content: { title: '不可重写正式历史', artist: '合成', tracks: [] } }));
});

test('只读执行槽检查在真正关闭前拒绝，检查本身不停止或启动', async t => {
  const f = await recordingAttemptFixture(t);
  assert.equal(typeof f.attempts.assertExecutionIdle, 'function');
  f.attempts.assertExecutionIdle(); const attempt = await f.attempts.begin(f.beginRequest());
  assert.throws(() => f.attempts.assertExecutionIdle());
  await f.attempts.stop({ commandId: randomUUID(), attemptId: attempt.id }); await turn();
  f.attempts.assertExecutionIdle(); assert.equal(f.starts.length, 1);
});

test('unknown处置只新增认知历史，原档案可检索但两库不泄露旧标题', async t => {
  const f = await fixture(t), before = f.records.list({ page }).items[0]!, inventory = f.repository.list(page).items[0]!.counts;
  const old = f.records.get({ id: before.id }).record!;
  const changed = f.apply({ action: 'mark-content-unknown' });
  assert.equal(changed.state.knowledge.state, 'unknown');
  const music = f.repository.music.detail(f.attempt.physicalId);
  assert.equal(music.entry.contentStatus, 'formal-current-unknown'); assert.notEqual(music.entry.title, before.title); assert.equal(music.entry.artist, '');
  assert.equal(f.repository.detail(before.modelId, page).copies.items.find(value => value.physicalId === before.physicalId)?.recordingTitle, undefined);
  assert.deepEqual(f.records.get({ id: before.id }).record!.record, old.record);
  assert.deepEqual(f.repository.list(page).items[0]!.counts, inventory);
  assert.equal(f.records.list({ page, filter: { master: before.title } }).total, 1);
  f.apply({ action: 'confirm-current-recording', recordingId: before.id });
  assert.equal(f.repository.music.detail(before.physicalId).entry.title, before.title);
});

test('处置需精确CAS和原预览且同命令永久回原回执，跨scope拒绝', async t => {
  const f = await fixture(t), proposal = f.records.previewDisposition(f.request({ action: 'mark-content-unknown' }));
  const request = { ...proposal.request, proposalFingerprint: proposal.proposalFingerprint, commandId: randomUUID(), userConfirmed: true as const };
  const result = f.records.applyDisposition(request), after = facts(f.db);
  assert.deepEqual(f.records.applyDisposition(request), result); assert.deepEqual(facts(f.db), after);
  assert.throws(() => f.records.applyDisposition({ ...request, intent: { action: 'confirm-erased' } }));
  assert.throws(() => f.records.applyDisposition({ ...request, commandId: randomUUID() }));
  f.setScope(false); assert.throws(() => f.records.applyDisposition(request)); assert.deepEqual(facts(f.db), after);
});

test('无静止证明或执行槽仍占用不能处置；ACK不替代cleanup', async t => {
  const incomplete = await fixture(t, false), before = facts(incomplete.db);
  assert.equal(incomplete.attempt.sides[0]!.stopAcknowledged, true); assert.equal(incomplete.attempt.sides[0]!.cleanupQuiescent, false);
  assert.throws(() => incomplete.records.previewDisposition(incomplete.request({ action: 'mark-content-unknown' })));
  assert.deepEqual(facts(incomplete.db), before);
  const f = await fixture(t); f.setIdle(false);
  assert.throws(() => f.records.previewDisposition(f.request({ action: 'confirm-erased' })));
});

test('prepare重录选明确新规划，同盘预留；cancel只回原内容不加库存', async t => {
  const f = await fixture(t), before = f.repository.list(page).items[0]!.counts;
  const preview = await f.media.preview({ draftId: f.attempt.draftId, spec: f.layout.spec, page });
  const target = await f.media.save({ commandId: randomUUID(), draftId: f.attempt.draftId, expectedDraftRevision: preview.draftRevision, inputFingerprint: preview.inputFingerprint, spec: f.layout.spec });
  const prepared = f.apply({ action: 'prepare-rerecord', mediaPlanId: target.id, expectedMediaPlanRevision: target.revision });
  assert.equal(prepared.state.activeRerecordPermit?.state, 'available'); assert.equal(prepared.mediaPlan!.reservation!.physicalId, f.attempt.physicalId);
  const row = f.db.prepare('SELECT * FROM physical_copies WHERE physical_id=?').get(f.attempt.physicalId)!;
  assert.equal(row.usage, 'reserved'); assert.equal(row.reserved_from, 'recorded');
  assert.equal(f.repository.list(page).items[0]!.counts.total, before.total); assert.equal(f.starts.length, 2);
  assert.throws(() => f.repository.media.release({ commandId: randomUUID(), planId: prepared.mediaPlan!.id, expectedRevision: prepared.mediaPlan!.revision, userConfirmed: true }));
  const cancelled = f.apply({ action: 'cancel-rerecord', permitId: prepared.state.activeRerecordPermit!.id });
  assert.equal(cancelled.state.activeRerecordPermit, null); assert.equal(cancelled.mediaPlan!.reservation, undefined);
  assert.equal(f.db.prepare('SELECT usage FROM physical_copies WHERE physical_id=?').get(f.attempt.physicalId)!.usage, 'recorded');
  assert.deepEqual(f.repository.list(page).items[0]!.counts, before); assert.equal(f.starts.length, 2);
});

test('处置提交故障回滚许可/实体/规划/认知/回执，重试原DTO才成功', async t => {
  const f = await fixture(t), proposal = f.records.previewDisposition(f.request({ action: 'confirm-erased' }));
  const request = { ...proposal.request, proposalFingerprint: proposal.proposalFingerprint, commandId: randomUUID(), userConfirmed: true as const }, before = facts(f.db);
  f.setFail(true); assert.throws(() => f.records.applyDisposition(request)); assert.deepEqual(facts(f.db), before);
  f.setFail(false); const result = f.records.applyDisposition(request);
  assert.equal(result.state.knowledge.state, 'erased'); assert.equal(f.db.prepare('SELECT usage FROM physical_copies WHERE physical_id=?').get(f.attempt.physicalId)!.usage, 'erased');
});

test('六API只读链：编号别名/冻结元数据/日期分页及不存在附件不伪成功', async t => {
  const f = await fixture(t), record = f.records.list({ page }).items[0]!;
  for (const query of [record.physicalId, record.physicalId.replace('MB-', '').replace(/-0+/, '-'), String(Number(record.physicalId.split('-').at(-1)))]) assert.equal(f.records.list({ page, filter: { query } }).total, 1);
  assert.equal(f.records.list({ page: { offset: 20, limit: 1 }, filter: { physicalId: record.physicalId } }).total, 1);
  assert.equal(f.records.list({ page: { offset: 20, limit: 1 } }).items.length, 0);
  assert.equal(f.records.list({ page, filter: { completedFrom: '2099-01-01T00:00:00.000Z' } }).total, 0);
  assert.equal(f.records.get({ id: randomUUID() }).record, null);
  assert.throws(() => f.records.visual({ recordingId: record.id, attachmentId: randomUUID() }));
  assert.equal(f.records.history({ physicalId: record.physicalId, page }).entries.items[0]!.kind, 'attempt');
  assert.equal(f.records.get({ id: record.id }).record!.record.completion.status, 'completed');
});


test('真实迟到close句柄没有释放时idle检查仍拒绝，检查不重复stop', async t => {
  const f = await recordingAttemptFixture(t), { createRecordingAttemptCoordinator } = await import('../src/recording/attempt-coordinator.js');
  let release!: () => void, stops = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const attempts = createRecordingAttemptCoordinator({ store: f.repository.recordingAttempts, admissionProvider: {
    async authorize() {}, async start() { return { async stop() { ++stops; }, close: () => held }; },
  } });
  t.after(async () => { release(); await attempts.close(); });
  const current = await attempts.begin(f.beginRequest());
  await attempts.stop({ commandId: randomUUID(), attemptId: current.id }); await turn();
  assert.throws(() => attempts.assertExecutionIdle()); assert.equal(stops, 1);
  release(); await turn(); attempts.assertExecutionIdle(); assert.equal(stops, 1);
});

test('无Attempt旧录音可明确处置但不造Record，空白实体不获得同样入口', async t => {
  const f = await fixture(t);
  const stock = f.repository.receive({ commandId: randomUUID(), model: { brand: '合成品牌', name: '处置独立批次', edition: '合成版次', year: null, format: 'cassette', tapeType: 'I', identification: 'verified' }, lengthMinutes: 60, quantities: { sealedBlank: 0, openedBlank: 1, legacyUsed: 1, unclassified: 0 } });
  const legacy = f.repository.materialize({ commandId: randomUUID(), lotId: stock.lotId!, bucket: 'legacyUsed', action: 'register-legacy' });
  const blank = f.repository.materialize({ commandId: randomUUID(), lotId: stock.lotId!, bucket: 'openedBlank', action: 'identify' });
  const state = f.records.history({ physicalId: legacy.physicalId!, page }).state;
  assert.equal(state.revision, 0); assert.equal(state.latestAttempt, null);
  const request: PreviewPhysicalRecordingDispositionRequest = { physicalId: state.physicalId, expectedPhysicalRevision: state.physicalRevision, expectedContentRevision: 0, expectedAttempt: null, intent: { action: 'mark-content-unknown' } };
  const preview = f.records.previewDisposition(request);
  f.records.applyDisposition({ ...request, commandId: randomUUID(), proposalFingerprint: preview.proposalFingerprint, userConfirmed: true });
  assert.equal(f.repository.music.detail(legacy.physicalId!).entry.contentStatus, 'formal-current-unknown');
  assert.equal(f.records.list({ page, filter: { physicalId: legacy.physicalId! } }).total, 0);
  assert.throws(() => f.records.previewDisposition({ ...request, physicalId: blank.physicalId!, expectedPhysicalRevision: 1 }));
  const current = f.records.history({ physicalId: legacy.physicalId!, page }).state;
  assert.throws(() => f.records.previewDisposition({ ...request, expectedContentRevision: current.revision, intent: { action: 'confirm-current-recording', recordingId: f.records.list({ page }).items[0]!.id } }));
});


test('重录预览持有型号保护基线：预览后变保护拒绝且未写许可或改占用', async t => {
  const f = await fixture(t), preview = await f.media.preview({ draftId: f.attempt.draftId, spec: f.layout.spec, page });
  const target = await f.media.save({ commandId: randomUUID(), draftId: f.attempt.draftId, expectedDraftRevision: preview.draftRevision, inputFingerprint: preview.inputFingerprint, spec: f.layout.spec });
  const proposal = f.records.previewDisposition(f.request({ action: 'prepare-rerecord', mediaPlanId: target.id, expectedMediaPlanRevision: target.revision }));
  const model = f.repository.detail(f.layout.reservation.modelId, page).model;
  f.repository.setPolicy({ commandId: randomUUID(), modelId: model.id, expectedRevision: model.revision, collectorPolicy: 'collector', minimumSealedReserve: model.minimumSealedReserve });
  const before = facts(f.db);
  assert.throws(() => f.records.applyDisposition({ ...proposal.request, proposalFingerprint: proposal.proposalFingerprint, commandId: randomUUID(), userConfirmed: true }));
  assert.deepEqual(facts(f.db), before); assert.equal(f.starts.length, 2);
});

test('未知内容准备重录再取消保持unknown，已有许可不接受其它认知处置', async t => {
  const f = await fixture(t); f.apply({ action: 'mark-content-unknown' });
  const preview = await f.media.preview({ draftId: f.attempt.draftId, spec: f.layout.spec, page });
  const target = await f.media.save({ commandId: randomUUID(), draftId: f.attempt.draftId, expectedDraftRevision: preview.draftRevision, inputFingerprint: preview.inputFingerprint, spec: f.layout.spec });
  const prepared = f.apply({ action: 'prepare-rerecord', mediaPlanId: target.id, expectedMediaPlanRevision: target.revision });
  assert.equal(f.db.prepare('SELECT reserved_from FROM physical_copies WHERE physical_id=?').get(f.attempt.physicalId)!.reserved_from, 'unknown');
  assert.throws(() => f.records.previewDisposition(f.request({ action: 'mark-content-unknown' })));
  const cancelled = f.apply({ action: 'cancel-rerecord', permitId: prepared.state.activeRerecordPermit!.id });
  assert.equal(cancelled.state.knowledge.state, 'unknown');
  assert.equal(f.db.prepare('SELECT usage FROM physical_copies WHERE physical_id=?').get(f.attempt.physicalId)!.usage, 'unknown');
  assert.equal(f.repository.music.list(page).total, 1); assert.equal(f.repository.list(page).items[0]!.counts.total, 3);
});


for (const action of ['mark-content-unknown', 'confirm-current-recording'] as const) test(`已擦除的盘明确改为${action}后撤销erased资格，不可再被普通预留选中`, async t => {
  const f = await fixture(t), recordingId = f.records.list({ page }).items[0]!.id;
  const erased = f.apply({ action: 'confirm-erased' });
  const intent: PhysicalRecordingDispositionIntent = action === 'confirm-current-recording' ? { action, recordingId } : { action };
  const proposal = f.records.previewDisposition(f.request(intent));
  const request = { ...proposal.request, proposalFingerprint: proposal.proposalFingerprint, commandId: randomUUID(), userConfirmed: true as const };
  const changed = f.records.applyDisposition(request);
  assert.equal(f.db.prepare('SELECT usage FROM physical_copies WHERE physical_id=?').get(f.attempt.physicalId)!.usage, action === 'mark-content-unknown' ? 'unknown' : 'recorded');
  assert.equal(changed.state.physicalRevision, erased.state.physicalRevision + 1);
  const after = facts(f.db); assert.deepEqual(f.records.applyDisposition(request), changed); assert.deepEqual(facts(f.db), after);
  assert.throws(() => f.records.applyDisposition({ ...request, commandId: randomUUID() }));
  const preview = await f.media.preview({ draftId: f.attempt.draftId, spec: f.layout.spec, page });
  assert.equal(preview.candidates.items[0]!.availableCount, 2, '已撤销擦除认知的实体不计入空白候选');
  const target = await f.media.save({ commandId: randomUUID(), draftId: f.attempt.draftId, expectedDraftRevision: preview.draftRevision, inputFingerprint: preview.inputFingerprint, spec: f.layout.spec });
  const reserved = await f.media.reserve({ commandId: randomUUID(), planId: target.id, expectedRevision: target.revision, skuId: f.layout.reservation.skuId, packaging: 'opened', userConfirmed: true });
  assert.notEqual(reserved.reservation!.physicalId, f.attempt.physicalId);
});
