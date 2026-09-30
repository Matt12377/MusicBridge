import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCollectionRepository } from '../src/collection/repository.js';
import { createRecordingAttemptCoordinator, type RecordingAttemptDriverRequest } from '../src/recording/attempt-coordinator.js';
import { OutputCheckError } from '../src/recording/output-error.js';
import { migrateOutputRunBarriers, settleOutputRunBarrier, verifyOutputRunBarrierDatabase } from '../src/recording/output-run-barrier.js';
import type { RecordingOutputInput, RecordingOutputInputLease } from '../src/recording/output-input.js';
import { recordingAttemptFixture } from './helpers/recording-attempt-fixture.js';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() > deadline) assert.fail('等待受控run状态超时');
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
}
function upgrade(filePath: string) {
  const db = new DatabaseSync(filePath, { enableForeignKeyConstraints: true });
  try {
    const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
    if (version < 25) {
      assert.equal(version, 24);
      db.exec('BEGIN IMMEDIATE');
      try { migrateOutputRunBarriers(db); db.exec('PRAGMA user_version=25; COMMIT'); }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    verifyOutputRunBarrierDatabase(db);
  } finally { db.close(); }
}
function inspect(filePath: string, attemptId: string) {
  const db = new DatabaseSync(filePath, { readOnly: true });
  try { return db.prepare('SELECT phase,reason FROM output_run_barrier_events WHERE attempt_id=? ORDER BY phase').all(attemptId)
    .map(row => ({ phase: String(row.phase), reason: row.reason === null ? null : String(row.reason) })); }
  finally { db.close(); }
}
function emitted(request: RecordingAttemptDriverRequest, frames: number) {
  const identity = { side: request.side, runId: request.runId, at: new Date().toISOString() };
  request.onEvent({ ...identity, type: 'progress', sourceFramesRead: frames, submittedFrames: frames, consumedFrames: frames });
  request.onEvent({ ...identity, type: 'source-eof' });
  request.onEvent({ ...identity, type: 'engine-cutoff' });
  request.onEvent({ ...identity, type: 'backend-drained' });
}
function syntheticLease(input: RecordingOutputInput, signal: AbortSignal,
  release: () => Promise<'verified' | 'cancelled'>): RecordingOutputInputLease {
  return { signal, provider: {
    signal, audio: input.receipt.audio, format: input.plan.profileSnapshot.settings.format,
    consumer: { descriptor: { dataOffset: input.receipt.audio.dataOffset, frameCount: input.receipt.audio.frameCount,
      channelCount: input.plan.profileSnapshot.settings.format.channelCount, sampleFormat: input.plan.profileSnapshot.settings.format.outputSampleFormat },
    async readFrames() { throw new Error('本例不读取合成帧'); } }, checkOperation() {},
  }, release };
}

test('MBR002：正常EOF驱动cleanup不提前收尾，drained后等待输入释放才发布静止', async t => {
  const f = await recordingAttemptFixture(t, 'dat'); upgrade(f.filePath);
  let request!: RecordingAttemptDriverRequest, closes = 0, releases = 0;
  const entered = deferred<void>(), gate = deferred<'verified' | 'cancelled'>();
  const coordinator = createRecordingAttemptCoordinator({ store: f.repository.recordingAttempts,
    acquireInputLease: async (input, signal) => syntheticLease(input, signal, () => { ++releases; entered.resolve(); return gate.promise; }),
    admissionProvider: { async authorize() {}, async start(value) {
      request = value; return { async stop() {}, async close() { ++closes; } };
    } },
  });
  f.registerDependentCleanup(async () => { gate.resolve('cancelled'); await coordinator.close(); });
  const attempt = await coordinator.begin(f.beginRequest()), frames = attempt.sides[0]!.frameCount;
  const identity = { side: request.side, runId: request.runId, at: new Date().toISOString() };
  request.onEvent({ ...identity, type: 'progress', sourceFramesRead: frames, submittedFrames: frames, consumedFrames: frames });
  request.onEvent({ ...identity, type: 'source-eof' });
  request.onEvent({ ...identity, type: 'engine-cutoff' });
  request.onEvent({ ...identity, type: 'stop-ack' });
  request.onEvent({ ...identity, type: 'cleanup-quiescent' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closes, 0); assert.equal(releases, 0, '正式provider仍需完成最终drained核验');
  assert.equal(coordinator.get({ attemptId: attempt.id }).attempt!.sides[0]!.cleanupQuiescent, false);
  request.onEvent({ ...identity, type: 'backend-drained', at: new Date().toISOString() });
  await entered.promise;
  assert.equal(closes, 1); assert.equal(releases, 1);
  assert.equal(coordinator.get({ attemptId: attempt.id }).attempt!.sides[0]!.cleanupQuiescent, false);
  gate.resolve('verified');
  await until(() => coordinator.get({ attemptId: attempt.id }).attempt!.sides[0]!.cleanupQuiescent);
  coordinator.assertExecutionIdle();
  assert.deepEqual(inspect(f.filePath, attempt.id).map(row => row.phase), ['pending', 'verified']);
});

test('schema25私有barrier迁移可审计；真实provider视图运行时不含FD/release', async t => {
  const f = await recordingAttemptFixture(t, 'dat'); upgrade(f.filePath);
  const attempt = await f.attempts.begin(f.beginRequest()), input = f.starts[0]!.input;
  assert.deepEqual(Reflect.ownKeys(input).sort(), ['audio', 'checkOperation', 'consumer', 'format', 'signal']);
  assert.deepEqual(Reflect.ownKeys(input.consumer).sort(), ['descriptor', 'readFrames']);
  assert.equal('handle' in input || 'release' in input || 'revoke' in input.consumer, false);
  assert.deepEqual(inspect(f.filePath, attempt.id).map(row => row.phase), ['pending']);
  await f.attempts.stop({ commandId: randomUUID(), attemptId: attempt.id });
  await until(() => inspect(f.filePath, attempt.id).length === 2);
  const db = new DatabaseSync(f.filePath, { readOnly: true });
  try { verifyOutputRunBarrierDatabase(db); } finally { db.close(); }
});

test('DAT最终确认在迟到driver.close与末Hash期间拒绝，精确verified后才提交', async t => {
  const f = await recordingAttemptFixture(t, 'dat'); upgrade(f.filePath);
  const closeEntered = deferred<void>(), closeGate = deferred<void>(), releaseEntered = deferred<void>(), releaseGate = deferred<'verified' | 'cancelled'>();
  let request!: RecordingAttemptDriverRequest;
  const coordinator = createRecordingAttemptCoordinator({ store: f.repository.recordingAttempts,
    acquireInputLease: async (input, signal): Promise<RecordingOutputInputLease> => ({ signal, provider: {
      signal, audio: input.receipt.audio, format: input.plan.profileSnapshot.settings.format,
      consumer: { descriptor: { dataOffset: input.receipt.audio.dataOffset, frameCount: input.receipt.audio.frameCount,
        channelCount: input.plan.profileSnapshot.settings.format.channelCount, sampleFormat: input.plan.profileSnapshot.settings.format.outputSampleFormat },
      async readFrames() { throw new Error('本例不读取合成帧'); } }, checkOperation() {},
    }, release() { releaseEntered.resolve(); return releaseGate.promise; } }),
    admissionProvider: { async authorize() {}, async start(value) { request = value; return { async stop() {}, async close() { closeEntered.resolve(); await closeGate.promise; } }; } },
  });
  f.registerDependentCleanup(async () => { closeGate.resolve(); releaseGate.resolve('cancelled'); await coordinator.close(); });
  const attempt = await coordinator.begin(f.beginRequest()), frames = attempt.sides[0]!.frameCount;
  emitted(request, frames); await closeEntered.promise;
  let state = coordinator.get({ attemptId: attempt.id }).attempt!;
  state = await coordinator.confirm({ commandId: randomUUID(), attemptId: attempt.id, expectedRevision: state.revision, kind: 'physical-stop', side: 'Program', userConfirmed: true });
  state = await coordinator.confirm({ commandId: randomUUID(), attemptId: attempt.id, expectedRevision: state.revision, kind: 'physical-recording', userConfirmed: true });
  const final = { commandId: randomUUID(), attemptId: attempt.id, expectedRevision: state.revision, kind: 'final-verification' as const, userConfirmed: true as const };
  await assert.rejects(coordinator.confirm(final), { code: 'INVALID_TRANSITION' });
  const directEvent = { type: 'confirm' as const, kind: 'final-verification' as const, at: state.updatedAt };
  assert.throws(() => f.repository.recordingAttempts.command('confirm', final, directEvent), { code: 'INVALID_TRANSITION' });
  assert.throws(() => f.repository.recordingAttempts.event(attempt.id, directEvent), { code: 'INVALID_TRANSITION' });
  closeGate.resolve(); await releaseEntered.promise;
  await assert.rejects(coordinator.confirm({ ...final, commandId: randomUUID() }), { code: 'INVALID_TRANSITION' });
  releaseGate.resolve('verified');
  await until(() => { try { coordinator.assertExecutionIdle(); return true; } catch { return false; } });
  await assert.rejects(coordinator.confirm(final), { code: 'VERSION_MISMATCH' });
  const latest = coordinator.get({ attemptId: attempt.id }).attempt!;
  assert.ok(latest.revision > final.expectedRevision, 'close与输入释放新增软件静止事实，关闭前的CAS不能复用');
  assert.equal(latest.sides[0]!.cleanupQuiescent, true);
  assert.equal((await coordinator.confirm({ ...final, commandId: randomUUID(), expectedRevision: latest.revision })).status, 'completed');
  assert.deepEqual(inspect(f.filePath, attempt.id).map(row => row.phase), ['pending', 'verified']);
});

test('driver直接失败后即使输入末Hash成功也不得写verified；失败冷启仍Interrupted', async t => {
  const f = await recordingAttemptFixture(t, 'dat'); upgrade(f.filePath);
  let request!: RecordingAttemptDriverRequest;
  const coordinator = createRecordingAttemptCoordinator({ store: f.repository.recordingAttempts,
    acquireInputLease: async (input, signal): Promise<RecordingOutputInputLease> => ({ signal, provider: {
      signal, audio: input.receipt.audio, format: input.plan.profileSnapshot.settings.format,
      consumer: { descriptor: { dataOffset: input.receipt.audio.dataOffset, frameCount: input.receipt.audio.frameCount,
        channelCount: input.plan.profileSnapshot.settings.format.channelCount, sampleFormat: input.plan.profileSnapshot.settings.format.outputSampleFormat },
      async readFrames() { throw new Error('本例不读取合成帧'); } }, checkOperation() {},
    }, async release() { return 'verified'; } }),
    admissionProvider: { async authorize() {}, async start(value) { request = value; return { async stop() {}, async close() {} }; } },
  });
  f.registerDependentCleanup(() => coordinator.close());
  const attempt = await coordinator.begin(f.beginRequest());
  request.onEvent({ type: 'interrupt', reason: 'device-lost', side: request.side, runId: request.runId, at: new Date().toISOString() });
  await until(() => inspect(f.filePath, attempt.id).length === 2);
  assert.deepEqual(inspect(f.filePath, attempt.id).map(row => row.phase), ['failed', 'pending']);
  assert.equal(coordinator.get({ attemptId: attempt.id }).attempt?.status, 'interrupted');
  const cold = createCollectionRepository({ filePath: f.filePath });
  try { assert.equal(cold.recordingAttempts.get({ attemptId: attempt.id }).attempt?.status, 'interrupted'); }
  finally { cold.close(); }
});

test('末Hash失败持久failed后拒绝完成，原请求重试也不能把失败改写verified', async t => {
  const f = await recordingAttemptFixture(t, 'dat'); upgrade(f.filePath);
  const release = deferred<'verified' | 'cancelled'>(); let request!: RecordingAttemptDriverRequest;
  const coordinator = createRecordingAttemptCoordinator({ store: f.repository.recordingAttempts,
    acquireInputLease: async (input, signal): Promise<RecordingOutputInputLease> => ({ signal, provider: {
      signal, audio: input.receipt.audio, format: input.plan.profileSnapshot.settings.format,
      consumer: { descriptor: { dataOffset: input.receipt.audio.dataOffset, frameCount: input.receipt.audio.frameCount,
        channelCount: input.plan.profileSnapshot.settings.format.channelCount, sampleFormat: input.plan.profileSnapshot.settings.format.outputSampleFormat },
      async readFrames() { throw new Error('本例不读取合成帧'); } }, checkOperation() {},
    }, release: () => release.promise }),
    admissionProvider: { async authorize() {}, async start(value) { request = value; return { async stop() {}, async close() {} }; } },
  });
  f.registerDependentCleanup(async () => { release.resolve('cancelled'); await assert.rejects(coordinator.close(), { code: 'INPUT_CHANGED' }); });
  const attempt = await coordinator.begin(f.beginRequest()); emitted(request, attempt.sides[0]!.frameCount);
  let state = coordinator.get({ attemptId: attempt.id }).attempt!;
  state = await coordinator.confirm({ commandId: randomUUID(), attemptId: attempt.id, expectedRevision: state.revision, kind: 'physical-stop', side: 'Program', userConfirmed: true });
  state = await coordinator.confirm({ commandId: randomUUID(), attemptId: attempt.id, expectedRevision: state.revision, kind: 'physical-recording', userConfirmed: true });
  const final = { commandId: randomUUID(), attemptId: attempt.id, expectedRevision: state.revision, kind: 'final-verification' as const, userConfirmed: true as const };
  await assert.rejects(coordinator.confirm(final), { code: 'INVALID_TRANSITION' });
  release.reject(new OutputCheckError('INPUT_CHANGED'));
  await until(() => inspect(f.filePath, attempt.id).length === 2);
  assert.deepEqual(inspect(f.filePath, attempt.id), [{ phase: 'failed', reason: 'INPUT_CHANGED' }, { phase: 'pending', reason: null }]);
  await assert.rejects(coordinator.confirm(final));
  const failed = coordinator.get({ attemptId: attempt.id }).attempt!;
  assert.equal(failed.status, 'interrupted'); assert.equal(failed.sides[0]!.cleanupQuiescent, false);
  assert.throws(() => coordinator.assertExecutionIdle(), { code: 'BACKEND_FAILURE' });
  await assert.rejects(coordinator.begin(f.beginRequest()), { code: 'BACKEND_FAILURE' });
  assert.deepEqual(inspect(f.filePath, attempt.id), [{ phase: 'failed', reason: 'INPUT_CHANGED' }, { phase: 'pending', reason: null }]);
});

test('A面末核验未完成时直接command/event均不得开始B面，verified后可由协调器开始', async t => {
  const f = await recordingAttemptFixture(t, 'cassette'); upgrade(f.filePath);
  const releaseEntered = deferred<void>(), releaseGate = deferred<'verified' | 'cancelled'>();
  let request!: RecordingAttemptDriverRequest;
  const coordinator = createRecordingAttemptCoordinator({ store: f.repository.recordingAttempts,
    acquireInputLease: async (input, signal) => syntheticLease(input, signal, () => { releaseEntered.resolve(); return releaseGate.promise; }),
    admissionProvider: { async authorize() {}, async start(value) { request = value; return { async stop() {}, async close() {} }; } },
  });
  f.registerDependentCleanup(async () => { releaseGate.resolve('cancelled'); await coordinator.close(); });
  const attempt = await coordinator.begin(f.beginRequest());
  emitted(request, attempt.sides[0]!.frameCount); await releaseEntered.promise;
  let state = coordinator.get({ attemptId: attempt.id }).attempt!;
  state = await coordinator.confirm({ commandId: randomUUID(), attemptId: attempt.id, expectedRevision: state.revision, kind: 'physical-stop', side: 'A', userConfirmed: true });
  state = await coordinator.confirm({ commandId: randomUUID(), attemptId: attempt.id, expectedRevision: state.revision, kind: 'flip', userConfirmed: true });
  const beginB = { commandId: randomUUID(), attemptId: attempt.id, expectedRevision: state.revision, side: 'B' as const, userConfirmed: true as const };
  const directEvent = { type: 'begin-side' as const, side: 'B' as const, runId: randomUUID(), at: state.updatedAt };
  assert.throws(() => f.repository.recordingAttempts.command('beginSide', beginB, directEvent), { code: 'INVALID_TRANSITION' });
  assert.throws(() => f.repository.recordingAttempts.event(attempt.id, directEvent), { code: 'INVALID_TRANSITION' });
  releaseGate.resolve('verified');
  await until(() => { try { coordinator.assertExecutionIdle(); return true; } catch { return false; } });
  await assert.rejects(coordinator.beginSide(beginB), { code: 'VERSION_MISMATCH' });
  const latest = coordinator.get({ attemptId: attempt.id }).attempt!;
  assert.ok(latest.revision > beginB.expectedRevision, 'A面软件静止新增revision，开始B面需读取最新权威状态');
  assert.equal(latest.sides[0]!.cleanupQuiescent, true);
  const startedB = await coordinator.beginSide({ ...beginB, commandId: randomUUID(), expectedRevision: latest.revision });
  assert.equal(startedB.activeSide, 'B');
  assert.deepEqual(inspect(f.filePath, attempt.id).map(row => row.phase), ['pending', 'pending', 'verified']);
  await coordinator.stop({ commandId: randomUUID(), attemptId: attempt.id });
});

test('schema25迁移保留旧Completed原命令回执，不为旧历史伪造barrier', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'musicbridge-output-legacy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'collection.sqlite');
  const legacy = new DatabaseSync(filePath);
  try {
    legacy.exec(await readFile(new URL('fixtures/collection-schema20-completed.sql', import.meta.url), 'utf8'));
    assert.equal(legacy.prepare('PRAGMA user_version').get()!.user_version, 20);
  } finally { legacy.close(); }
  const repository = createCollectionRepository({ filePath });
  t.after(() => repository.close());
  const db = new DatabaseSync(filePath, { readOnly: true });
  const receipt = (() => {
    try {
      return db.prepare('SELECT request FROM recording_attempt_receipts').all()
        .map(row => JSON.parse(String(row.request)) as { action: string; request: Record<string, unknown>; event: Record<string, unknown> })
        .find(row => row.action === 'confirm' && row.event.kind === 'final-verification');
    } finally { db.close(); }
  })();
  assert.ok(receipt);
  const completed = repository.recordingAttempts.get({ attemptId: String(receipt.request.attemptId) }).attempt!;
  assert.equal(completed.status, 'completed');
  upgrade(filePath);
  assert.deepEqual(repository.recordingAttempts.command('confirm', receipt.request as Parameters<typeof repository.recordingAttempts.command>[1],
    receipt.event as Parameters<typeof repository.recordingAttempts.command>[2]), completed);
  assert.deepEqual(inspect(filePath, completed.id), []);
});

test('登记后系统时钟回拨时terminal时间不早于pending', async t => {
  const f = await recordingAttemptFixture(t, 'dat'); upgrade(f.filePath);
  const store = f.repository.recordingAttempts, runId = randomUUID();
  const input = store.capture(f.frozenPlan.id, f.frozenPlan.contentHash, 'Program');
  let state = store.begin(f.beginRequest(), input, runId);
  const future = new Date(Date.now() + 60_000).toISOString();
  const db = new DatabaseSync(f.filePath, { enableForeignKeyConstraints: true });
  try {
    // 模拟pending登记时的时钟走快，随后系统时钟恢复；原行受不可变触发器保护。
    db.prepare('INSERT INTO output_run_barrier_events VALUES(?,?,?,?,?,?,?,?)')
      .run(state.id, 'Program', runId, 'pending', state.planContentHash, state.sides[0]!.audioSha256, future, null);
    for (const event of [
      { type: 'progress' as const, side: 'Program' as const, runId, at: state.updatedAt,
        sourceFramesRead: state.sides[0]!.frameCount, submittedFrames: state.sides[0]!.frameCount, consumedFrames: state.sides[0]!.frameCount },
      ...(['source-eof', 'backend-drained'] as const).map(type => ({ type, side: 'Program' as const, runId, at: state.updatedAt })),
    ]) state = store.event(state.id, event);
    db.exec('BEGIN IMMEDIATE');
    try { settleOutputRunBarrier(db, state.id, 'Program', runId, 'verified'); db.exec('COMMIT'); }
    catch (error) { db.exec('ROLLBACK'); throw error; }
    const terminal = db.prepare("SELECT at FROM output_run_barrier_events WHERE attempt_id=? AND phase='verified'").get(state.id);
    assert.equal(terminal?.at, future);
    verifyOutputRunBarrierDatabase(db);
  } finally { db.close(); }
});

test('冷开全审拒绝未EOF/未排空却伪造verified的输出行', async t => {
  const f = await recordingAttemptFixture(t, 'dat'); upgrade(f.filePath);
  const store = f.repository.recordingAttempts, runId = randomUUID();
  const input = store.capture(f.frozenPlan.id, f.frozenPlan.contentHash, 'Program');
  const attempt = store.begin(f.beginRequest(), input, runId);
  store.registerOutputRun(attempt, 'Program', runId);
  const db = new DatabaseSync(f.filePath, { enableForeignKeyConstraints: true });
  try {
    verifyOutputRunBarrierDatabase(db);
    const pending = db.prepare("SELECT * FROM output_run_barrier_events WHERE attempt_id=? AND phase='pending'").get(attempt.id)!;
    db.prepare('INSERT INTO output_run_barrier_events VALUES(?,?,?,?,?,?,?,?)')
      .run(attempt.id, 'Program', runId, 'verified', String(pending.plan_content_hash), String(pending.audio_sha256), String(pending.at), null);
    assert.throws(() => verifyOutputRunBarrierDatabase(db), { code: 'IO_ERROR' });
  } finally { db.close(); }
});

test('冷开全审拒绝未开始B面上登记的假pending', async t => {
  const f = await recordingAttemptFixture(t, 'cassette'); upgrade(f.filePath);
  const store = f.repository.recordingAttempts, runId = randomUUID();
  const input = store.capture(f.frozenPlan.id, f.frozenPlan.contentHash, 'A');
  const attempt = store.begin(f.beginRequest(), input, runId);
  store.registerOutputRun(attempt, 'A', runId);
  const db = new DatabaseSync(f.filePath, { enableForeignKeyConstraints: true });
  try {
    verifyOutputRunBarrierDatabase(db);
    assert.equal(attempt.sides[1]!.runId, undefined);
    db.prepare('INSERT INTO output_run_barrier_events VALUES(?,?,?,?,?,?,?,?)')
      .run(attempt.id, 'B', randomUUID(), 'pending', attempt.planContentHash, attempt.sides[1]!.audioSha256, attempt.updatedAt, null);
    assert.throws(() => verifyOutputRunBarrierDatabase(db), { code: 'IO_ERROR' });
  } finally { db.close(); }
});

test('driver.close拒绝时保留FD与执行slot，不能以末Hash成功收口', async t => {
  const f = await recordingAttemptFixture(t, 'dat'); upgrade(f.filePath);
  let request!: RecordingAttemptDriverRequest, releases = 0;
  const coordinator = createRecordingAttemptCoordinator({ store: f.repository.recordingAttempts,
    acquireInputLease: async (input, signal) => syntheticLease(input, signal, async () => { ++releases; return 'verified'; }),
    admissionProvider: { async authorize() {}, async start(value) { request = value; return { async stop() {}, async close() { throw new Error('受控close失败'); } }; } },
  });
  f.registerDependentCleanup(() => assert.rejects(coordinator.close(), /受控close失败/u));
  const attempt = await coordinator.begin(f.beginRequest());
  emitted(request, attempt.sides[0]!.frameCount);
  await until(() => inspect(f.filePath, attempt.id).length === 2);
  assert.deepEqual(inspect(f.filePath, attempt.id).map(row => row.phase), ['failed', 'pending']);
  assert.equal(releases, 0);
  assert.equal(coordinator.get({ attemptId: attempt.id }).attempt?.status, 'interrupted');
  assert.throws(() => coordinator.assertExecutionIdle(), { code: 'BACKEND_FAILURE' });
});

test('只读输入租期撤销无需下一次readFrames也立即停止驱动', async t => {
  const f = await recordingAttemptFixture(t, 'dat'); upgrade(f.filePath);
  const leaseSignal = new AbortController();
  let stops = 0, closes = 0, reads = 0;
  const coordinator = createRecordingAttemptCoordinator({ store: f.repository.recordingAttempts,
    acquireInputLease: async (input) => {
      const lease = syntheticLease(input, leaseSignal.signal, async () => 'cancelled');
      return { ...lease, provider: { ...lease.provider, consumer: {
        ...lease.provider.consumer, async readFrames() { ++reads; throw new Error('不应读取'); },
      } } };
    },
    admissionProvider: { async authorize() {}, async start() { return { async stop() { ++stops; }, async close() { ++closes; } }; } },
  });
  f.registerDependentCleanup(() => coordinator.close());
  const attempt = await coordinator.begin(f.beginRequest());
  leaseSignal.abort(new Error('受控租期撤销'));
  await until(() => inspect(f.filePath, attempt.id).length === 2);
  assert.equal(reads, 0);
  assert.equal(stops, 1);
  assert.equal(closes, 1);
  assert.deepEqual(inspect(f.filePath, attempt.id).map(row => row.phase), ['failed', 'pending']);
  assert.equal(coordinator.get({ attemptId: attempt.id }).attempt?.status, 'interrupted');
});
