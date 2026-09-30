import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createRecordingAttemptCoordinator, type RecordingAttemptDriver, type RecordingAttemptDriverRequest } from '../src/recording/attempt-coordinator.js';
import { outputAttemptAuditFixture, deferred } from './helpers/output-attempt-audit-fixture.js';

const page = { offset: 0, limit: 20 };

test('外审 C 输出 Attempt：启动拒绝保存 Failed、取消租期且重复 Begin 不重启', async t => {
  const f = await outputAttemptAuditFixture(t); let starts = 0;
  const coordinator = createRecordingAttemptCoordinator({ store: f.repository.recordingAttempts, acquireInputLease: f.acquireInputLease,
    admissionProvider: { async authorize() {}, async start() { ++starts; throw new Error('合成启动拒绝'); } } });
  f.registerDependentCleanup(() => coordinator.close());
  const command = f.request(), failed = await coordinator.begin(command);
  assert.equal(failed.status, 'failed'); assert.equal(failed.reason, 'backend-start-failed');
  assert.deepEqual(f.lifecycle, ['lease-acquired', 'lease-released']);
  assert.equal(f.barrier(failed.id).at(-1)?.phase, 'failed');
  const replay = await coordinator.begin(command);
  assert.equal(replay.id, failed.id); assert.equal(replay.revision, 1, '重放开始边界的原始回执，不把后来失败回填');
  assert.deepEqual(coordinator.get({ attemptId: failed.id }).attempt, failed);
  await assert.rejects(coordinator.begin(f.request()), { code: 'BACKEND_FAILURE' });
  assert.equal(starts, 1);
});

test('外审 C 输出 Attempt：准入超时后迟到 authorize 不得创建 Attempt 或启动驱动', async t => {
  const f = await outputAttemptAuditFixture(t), entered = deferred<void>(), admitted = deferred<void>(); let starts = 0;
  const coordinator = createRecordingAttemptCoordinator({ store: f.repository.recordingAttempts, acquireInputLease: f.acquireInputLease,
    operationTimeoutMs: 500, closeTimeoutMs: 100,
    admissionProvider: { async authorize() { entered.resolve(); await admitted.promise; }, async start() { ++starts; assert.fail('超时准入不得启动'); } } });
  f.registerDependentCleanup(async () => { admitted.resolve(); await coordinator.close(); });
  const rejected = assert.rejects(coordinator.begin(f.request()), { code: 'NOT_ACCEPTED', causeCode: 'BACKEND_FAILURE' });
  await entered.promise; await rejected;
  admitted.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(coordinator.list({ page }).total, 0); assert.equal(starts, 0); assert.deepEqual(f.lifecycle, []);
  assert.doesNotThrow(() => coordinator.assertExecutionIdle());
});

test('外审 C 输出 Attempt：start 超时锁存 Interrupted，迟到 handle 关闭后才释放租期', async t => {
  const f = await outputAttemptAuditFixture(t), entered = deferred<void>(), handle = deferred<RecordingAttemptDriver>();
  let driverRequest!: RecordingAttemptDriverRequest;
  const coordinator = createRecordingAttemptCoordinator({ store: f.repository.recordingAttempts, acquireInputLease: f.acquireInputLease,
    operationTimeoutMs: 500, closeTimeoutMs: 100,
    admissionProvider: { async authorize() {}, start(request) { driverRequest = request; entered.resolve(); return handle.promise; } } });
  const lateHandle = { async stop() { f.lifecycle.push('driver-stop'); }, async close() { f.lifecycle.push('driver-close'); } };
  f.registerDependentCleanup(async () => { handle.resolve(lateHandle); await coordinator.close(); });
  const pending = coordinator.begin(f.request()); await entered.promise;
  const interrupted = await pending;
  assert.equal(interrupted.status, 'interrupted'); assert.equal(interrupted.reason, 'backend-timeout');
  assert.equal(driverRequest.signal.aborted, true); assert.deepEqual(f.lifecycle, ['lease-acquired']);
  assert.equal(f.barrier(interrupted.id).at(-1)?.phase, 'pending');
  await assert.rejects(coordinator.begin(f.request()), { code: 'ATTEMPT_CONFLICT' });
  handle.resolve(lateHandle); await f.waitUntil(() => f.barrier(interrupted.id).at(-1)?.phase === 'failed');
  driverRequest.onEvent({ type: 'backend-drained', side: driverRequest.side, runId: driverRequest.runId, at: new Date().toISOString() });
  const final = coordinator.get({ attemptId: interrupted.id }).attempt!;
  assert.equal(final.reason, 'backend-timeout'); assert.equal(final.softwarePlaybackComplete, false);
  assert.deepEqual(f.lifecycle, ['lease-acquired', 'driver-stop', 'driver-close', 'lease-released']);
});

test('外审 C 输出 Attempt：Stop 与迟到 start 竞争只清理一次，用户终因不被成功事件覆盖', async t => {
  const f = await outputAttemptAuditFixture(t), entered = deferred<void>(), handle = deferred<RecordingAttemptDriver>();
  let driverRequest!: RecordingAttemptDriverRequest;
  const coordinator = createRecordingAttemptCoordinator({ store: f.repository.recordingAttempts, acquireInputLease: f.acquireInputLease,
    admissionProvider: { async authorize() {}, start(request) { driverRequest = request; entered.resolve(); return handle.promise; } } });
  const lateHandle = { async stop() { f.lifecycle.push('driver-stop'); }, async close() { f.lifecycle.push('driver-close'); } };
  f.registerDependentCleanup(async () => { handle.resolve(lateHandle); await coordinator.close(); });
  const begin = f.request(), pending = coordinator.begin(begin); await entered.promise;
  const attempt = coordinator.list({ page }).items[0]!, stop = { commandId: randomUUID(), attemptId: attempt.id };
  const aborted = await coordinator.stop(stop);
  assert.equal(aborted.status, 'aborted'); assert.equal(aborted.reason, 'user-stop');
  assert.deepEqual(f.lifecycle, ['lease-acquired']);
  handle.resolve(lateHandle); const receipt = await pending;
  await f.waitUntil(() => f.barrier(attempt.id).at(-1)?.phase === 'failed');
  const identity = { side: driverRequest.side, runId: driverRequest.runId, at: new Date().toISOString() };
  driverRequest.onEvent({ ...identity, type: 'source-eof' }); driverRequest.onEvent({ ...identity, type: 'backend-drained' });
  assert.deepEqual(await coordinator.stop(stop), aborted);
  assert.deepEqual(await coordinator.begin(begin), receipt, '历史 Begin 回执不冒充当前状态');
  const current = coordinator.get({ attemptId: attempt.id }).attempt!;
  assert.equal(current.status, 'aborted'); assert.equal(current.reason, 'user-stop'); assert.equal(current.softwarePlaybackComplete, false);
  assert.deepEqual(f.lifecycle, ['lease-acquired', 'driver-stop', 'driver-close', 'lease-released']);
});

test('外审 C 输出 Attempt：driver.close 拒绝必须保留租期、失败屏障并阻断下一次输出', async t => {
  const f = await outputAttemptAuditFixture(t), closeFailure = new Error('合成驱动关闭拒绝');
  const coordinator = createRecordingAttemptCoordinator({ store: f.repository.recordingAttempts, acquireInputLease: f.acquireInputLease,
    admissionProvider: { async authorize() {}, async start() { return {
      async stop() { f.lifecycle.push('driver-stop'); }, async close() { f.lifecycle.push('driver-close'); throw closeFailure; },
    }; } } });
  f.registerDependentCleanup(async () => { await assert.rejects(coordinator.close(), error => error === closeFailure); });
  const attempt = await coordinator.begin(f.request());
  await coordinator.stop({ commandId: randomUUID(), attemptId: attempt.id });
  await f.waitUntil(() => f.barrier(attempt.id).at(-1)?.reason === 'DRIVER_CLOSE_FAILED');
  assert.deepEqual(f.lifecycle, ['lease-acquired', 'driver-stop', 'driver-close']);
  assert.throws(() => coordinator.assertExecutionIdle(), { code: 'BACKEND_FAILURE' });
  await assert.rejects(coordinator.begin(f.request()), { code: 'BACKEND_FAILURE' });
  const current = coordinator.get({ attemptId: attempt.id }).attempt!;
  assert.equal(current.status, 'aborted'); assert.equal(current.sides[0]!.cleanupQuiescent, false);
  assert.equal(current.sides[0]!.backendDrained, false); assert.equal(current.softwarePlaybackComplete, false);
});

test('外审 C 输出 Attempt：关闭超时有界失败，迟到 close 只在真正完成后释放租期', async t => {
  const f = await outputAttemptAuditFixture(t), allowClose = deferred<void>();
  const coordinator = createRecordingAttemptCoordinator({ store: f.repository.recordingAttempts, acquireInputLease: f.acquireInputLease, closeTimeoutMs: 100,
    admissionProvider: { async authorize() {}, async start() { return {
      async stop() { f.lifecycle.push('driver-stop'); }, async close() { f.lifecycle.push('driver-close-entered'); await allowClose.promise; f.lifecycle.push('driver-close-finished'); },
    }; } } });
  f.registerDependentCleanup(async () => { allowClose.resolve(); await coordinator.close().catch(() => undefined); });
  const attempt = await coordinator.begin(f.request());
  await assert.rejects(coordinator.close(), { code: 'BACKEND_FAILURE' });
  assert.deepEqual(f.lifecycle, ['lease-acquired', 'driver-stop', 'driver-close-entered']);
  assert.equal(f.barrier(attempt.id).at(-1)?.phase, 'pending');
  const interrupted = f.repository.recordingAttempts.get({ attemptId: attempt.id }).attempt!;
  assert.equal(interrupted.status, 'interrupted'); assert.equal(interrupted.sides[0]!.cleanupQuiescent, false);
  allowClose.resolve(); await f.waitUntil(() => f.barrier(attempt.id).at(-1)?.phase === 'failed');
  assert.deepEqual(f.lifecycle, ['lease-acquired', 'driver-stop', 'driver-close-entered', 'driver-close-finished', 'lease-released']);
  await assert.rejects(coordinator.close(), { code: 'BACKEND_FAILURE' });
});

test('外审 C 输出 Attempt：并发重复 Begin 共用 Promise，冲突身份拒绝且 Stop 回执不重复清理', async t => {
  const f = await outputAttemptAuditFixture(t), entered = deferred<void>(), handle = deferred<RecordingAttemptDriver>(); let starts = 0;
  const coordinator = createRecordingAttemptCoordinator({ store: f.repository.recordingAttempts, acquireInputLease: f.acquireInputLease,
    admissionProvider: { async authorize() {}, start() { ++starts; entered.resolve(); return handle.promise; } } });
  const controlledHandle = { async stop() { f.lifecycle.push('driver-stop'); }, async close() { f.lifecycle.push('driver-close'); } };
  f.registerDependentCleanup(async () => { handle.resolve(controlledHandle); await coordinator.close(); });
  const command = f.request(), first = coordinator.begin(command), duplicate = coordinator.begin(command);
  assert.equal(first, duplicate); await entered.promise;
  await assert.rejects(coordinator.begin({ ...command, planContentHash: 'a'.repeat(64) }), { code: 'COMMAND_CONFLICT' });
  await assert.rejects(coordinator.begin(f.request()), { code: 'ATTEMPT_CONFLICT' });
  handle.resolve(controlledHandle); const attempt = await first; assert.deepEqual(await duplicate, attempt);
  const stop = { commandId: randomUUID(), attemptId: attempt.id }, stopped = await coordinator.stop(stop);
  await f.waitUntil(() => f.barrier(attempt.id).at(-1)?.phase === 'failed');
  assert.deepEqual(await coordinator.stop(stop), stopped); assert.deepEqual(await coordinator.begin(command), attempt);
  assert.equal(starts, 1); assert.deepEqual(f.lifecycle, ['lease-acquired', 'driver-stop', 'driver-close', 'lease-released']);
});
