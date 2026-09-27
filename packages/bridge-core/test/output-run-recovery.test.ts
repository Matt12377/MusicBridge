import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createCollectionRepository } from '../src/collection/repository.js';
import { createRecordingAttemptCoordinator } from '../src/recording/attempt-coordinator.js';
import { reconcileOutputRunRecovery } from '../src/recording/output-run-recovery.js';
import type { OutputRunRecoveryRow } from '../src/recording/output-run-barrier.js';
import type { PinnedDeviceOutputHelper } from '../src/recording/bundled-device-output-helper.js';
import { recordingAttemptFixture } from './helpers/recording-attempt-fixture.js';

async function until(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!check()) {
    if (performance.now() > deadline) assert.fail('持久运行屏障未在期限内结算');
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
}
const fakePin = (): PinnedDeviceOutputHelper => ({ path: '/Volumes/LifeWeave/synthetic-helper', sha256: 'a'.repeat(64),
  manifestPath: '/Volumes/LifeWeave/synthetic-manifest', manifestSha256: 'b'.repeat(64), sourceSha256: 'c'.repeat(64),
  drainAlgorithmId: 'hal-sample-zero-cover-v1' });
const row = (quietPersisted: boolean): OutputRunRecoveryRow => ({ attemptId: randomUUID(), side: 'Program', runId: randomUUID(),
  planContentSha256: 'a'.repeat(64), audioSha256: 'b'.repeat(64), pcmSha256: 'c'.repeat(64), quietPersisted });

test('冷启旧run无sidecar时只接受持久软件静止事实；缺事实保持设备阻断', async t => {
  const f = await recordingAttemptFixture(t, 'dat');
  const attempt = await f.attempts.begin(f.beginRequest());
  await f.attempts.stop({ commandId: randomUUID(), attemptId: attempt.id });
  await until(() => f.repository.recordingAttempts.outputRunRecoveryRows().length === 1);
  const cold = createCollectionRepository({ filePath: f.filePath }); t.after(() => cold.close());
  const rows = cold.recordingAttempts.outputRunRecoveryRows();
  assert.equal(rows.length, 1); assert.equal(rows[0]!.quietPersisted, false);
  assert.equal(rows[0]!.runId, attempt.sides[0]!.runId);
  const state = await reconcileOutputRunRecovery({ databaseFile: f.filePath, datasetId: randomUUID(), rows,
    assertCurrent() {}, probe: async () => 'absent' });
  assert.deepEqual(state, { safe: false, pendingRuns: 1, reason: 'OUTPUT_RUN_UNVERIFIED' });
});

test('冷启pre-spawn失败已有cutoff/quiescent，即使没建sidecar也不误锁；原Attempt仍失败', async t => {
  const f = await recordingAttemptFixture(t, 'dat');
  const coordinator = createRecordingAttemptCoordinator({ store: f.repository.recordingAttempts,
    admissionProvider: { async authorize() {}, async start(request) {
      const at = new Date().toISOString(), identity = { side: request.side, runId: request.runId, at };
      request.onEvent({ ...identity, type: 'engine-cutoff' });
      request.onEvent({ ...identity, type: 'cleanup-quiescent' });
      throw new Error('受控pre-spawn拒绝');
    } },
  });
  t.after(() => coordinator.close());
  const failedStart = await coordinator.begin(f.beginRequest());
  assert.equal(failedStart.status, 'failed', '已持久失败Attempt须回传真实记录，不再伪称无受理');
  const cold = createCollectionRepository({ filePath: f.filePath }); t.after(() => cold.close());
  const rows = cold.recordingAttempts.outputRunRecoveryRows();
  assert.equal(rows.length, 1); assert.equal(rows[0]!.quietPersisted, true);
  assert.deepEqual(await reconcileOutputRunRecovery({ databaseFile: f.filePath, datasetId: randomUUID(), rows,
    assertCurrent() {}, probe: async () => 'absent' }), { safe: true, pendingRuns: 1 });
});

test('所有pending run含verified均须撤销现存sidecar；占用或身份未证实时拒开新输出', async () => {
  const databaseFile = path.join(os.tmpdir(), 'synthetic-collection.sqlite'), datasetId = randomUUID();
  const first = row(true), second = row(true), pin = fakePin();
  const revoked: string[] = [];
  const options = { databaseFile, datasetId, rows: [first, second], pin, assertCurrent() {},
    probe: async () => 'present' as const,
    revoke: async (binding: { runId: string; datasetId: string }) => { revoked.push(binding.runId); assert.equal(binding.datasetId, datasetId); return true; } };
  assert.deepEqual(await reconcileOutputRunRecovery(options), { safe: true, pendingRuns: 2 });
  assert.deepEqual(revoked, [first.runId, second.runId]);
  assert.deepEqual(await reconcileOutputRunRecovery({ ...options, revoke: async () => false }),
    { safe: false, pendingRuns: 2, reason: 'OUTPUT_RUN_UNVERIFIED' }, '原生排他锁未取得或身份不符不能算静止');
  assert.deepEqual(await reconcileOutputRunRecovery({ databaseFile, datasetId, rows: [first, second],
    assertCurrent() {}, probe: options.probe, revoke: options.revoke }),
    { safe: false, pendingRuns: 2, reason: 'OUTPUT_RUN_UNVERIFIED' }, 'helper缺失不能撤销现存租约');
});

test('冷启精确撤销后两项软件静止事实分别持久化；原终态与硬件事实不被补造', async t => {
  const f = await recordingAttemptFixture(t, 'dat'), store = f.repository.recordingAttempts;
  const request = f.beginRequest(), input = store.capture(request.planVersionId, request.planContentHash), runId = randomUUID();
  const attempt = store.begin(request, input, runId), side = attempt.sides[0]!.side;
  store.registerOutputRun(attempt, side, runId);
  store.stop({ commandId: randomUUID(), attemptId: attempt.id }, { type: 'abort', reason: 'user-stop', at: new Date().toISOString() }, []);
  const cold = createCollectionRepository({ filePath: f.filePath }); t.after(() => cold.close());
  const rows = cold.recordingAttempts.outputRunRecoveryRows();
  assert.equal(rows.length, 1); assert.equal(rows[0]!.quietPersisted, false);
  let revoked = 0;
  const options = { databaseFile: f.filePath, datasetId: randomUUID(), rows, pin: fakePin(), assertCurrent() {},
    probe: async () => 'present' as const, revoke: async () => { ++revoked; return true; },
    persistQuiet: (row: OutputRunRecoveryRow) => cold.recordingAttempts.persistRevokedOutputRunQuiet(row) };
  assert.deepEqual(await reconcileOutputRunRecovery(options), { safe: true, pendingRuns: 1 });
  assert.equal(revoked, 1);
  assert.equal(cold.recordingAttempts.outputRunRecoveryRows()[0]!.quietPersisted, true);
  const after = cold.recordingAttempts.get({ attemptId: attempt.id }).attempt!;
  assert.equal(after.status, 'aborted');
  assert.equal(after.sides[0]!.engineStoppedSubmitting, true);
  assert.equal(after.sides[0]!.cleanupQuiescent, true);
  assert.equal(after.sides[0]!.stopAcknowledged, false);
  assert.equal(after.sides[0]!.sourceEof, false);
  assert.equal(after.sides[0]!.backendDrained, false);
  assert.equal(after.softwarePlaybackComplete, false);
  const db = new DatabaseSync(f.filePath, { readOnly: true });
  try {
    const events = db.prepare('SELECT kind FROM recording_attempt_events WHERE attempt_id=? ORDER BY revision').all(attempt.id);
    assert.deepEqual(events.slice(-2).map(event => event.kind), ['engine-cutoff', 'cleanup-quiescent']);
  } finally { db.close(); }
  assert.deepEqual(await reconcileOutputRunRecovery(options), { safe: true, pendingRuns: 1 }, '墓碑重读与已持久事实应幂等');
  assert.equal(cold.recordingAttempts.get({ attemptId: attempt.id }).attempt!.revision, after.revision);
  assert.throws(() => cold.recordingAttempts.persistRevokedOutputRunQuiet({ ...rows[0]!, runId: randomUUID() }));
});

test('撤销后仅部分事实落盘或持久化异常，冷启继续阻断且下次可按原run续写', async t => {
  const f = await recordingAttemptFixture(t, 'dat'), store = f.repository.recordingAttempts;
  const request = f.beginRequest(), input = store.capture(request.planVersionId, request.planContentHash), runId = randomUUID();
  const attempt = store.begin(request, input, runId), side = attempt.sides[0]!.side;
  store.registerOutputRun(attempt, side, runId);
  store.stop({ commandId: randomUUID(), attemptId: attempt.id }, { type: 'abort', reason: 'user-stop', at: new Date().toISOString() }, []);
  const cold = createCollectionRepository({ filePath: f.filePath }); t.after(() => cold.close());
  const rows = cold.recordingAttempts.outputRunRecoveryRows(), options = { databaseFile: f.filePath,
    datasetId: randomUUID(), rows, pin: fakePin(), assertCurrent() {}, probe: async () => 'present' as const,
    revoke: async () => true };
  assert.deepEqual(await reconcileOutputRunRecovery({ ...options, persistQuiet: row => {
    cold.recordingAttempts.event(row.attemptId, { type: 'engine-cutoff', side: row.side, runId: row.runId, at: new Date().toISOString() });
    throw new Error('合成第二笔持久化失败');
  } }), { safe: false, pendingRuns: 1, reason: 'OUTPUT_RUN_UNVERIFIED' });
  const partial = cold.recordingAttempts.get({ attemptId: attempt.id }).attempt!;
  assert.equal(partial.sides[0]!.engineStoppedSubmitting, true);
  assert.equal(partial.sides[0]!.cleanupQuiescent, false);
  assert.deepEqual(await reconcileOutputRunRecovery({ ...options, probe: async () => 'absent' }),
    { safe: false, pendingRuns: 1, reason: 'OUTPUT_RUN_UNVERIFIED' });
  assert.deepEqual(await reconcileOutputRunRecovery({ ...options,
    persistQuiet: row => cold.recordingAttempts.persistRevokedOutputRunQuiet(row) }), { safe: true, pendingRuns: 1 });
  const recovered = cold.recordingAttempts.get({ attemptId: attempt.id }).attempt!;
  assert.equal(recovered.revision, partial.revision + 1);
  assert.equal(recovered.sides[0]!.engineStoppedSubmitting, true);
  assert.equal(recovered.sides[0]!.cleanupQuiescent, true);
  assert.equal(recovered.sides[0]!.stopAcknowledged, false);
});
