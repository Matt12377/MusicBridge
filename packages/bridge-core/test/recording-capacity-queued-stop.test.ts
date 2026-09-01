import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

async function queuedFixture(t: TestContext, label: string) {
  const { recordingAttemptFixture } = await import('./helpers/recording-attempt-fixture.js');
  const { createCapacityClone, hashCapacityFile } = await import('./helpers/recording-capacity-fixture.js');
  const fixture = await recordingAttemptFixture(t), seed = path.join(fixture.directory, `queue-seed-${randomUUID()}.sqlite`);
  const source = new DatabaseSync(fixture.filePath);
  try { source.prepare('VACUUM INTO ?').run(seed); } finally { source.close(); }
  const seedHash = hashCapacityFile(seed), clone = createCapacityClone(fixture.directory, label, seed);
  return { fixture, seed, seedHash, clone };
}

test('排队Stop：真实新Node在完整审计及Begin后按同一IPC顺序处理progress与Stop', { timeout: 30_000 }, async t => {
  const { hashCapacityFile } = await import('./helpers/recording-capacity-fixture.js');
  const { runCapacityQueuedStop } = await import('./helpers/recording-capacity-process.js');
  const { fixture, seed, seedHash, clone } = await queuedFixture(t, 'queued-stop-child');

  const result = await runCapacityQueuedStop({ clone, planId: fixture.frozenPlan.id, planHash: fixture.frozenPlan.contentHash });

  assert.equal(result.outcome, 'ok', JSON.stringify(result));
  assert.notEqual(result.childPid, process.pid); assert.ok(result.childPid! > 0);
  assert.equal(result.closed, true); assert.equal(result.code, 0); assert.equal(result.signal, null);
  assert.ok(result.processGroup); assert.equal(result.processGroup.managed, true); assert.equal(result.processGroup.pgid, result.childPid);
  assert.equal(result.processGroup.groupEmpty, true); assert.deepEqual(result.cleanup, { termSent: false, killSent: false });
  assert.equal(result.result?.kind, 'queue'); if (result.result?.kind !== 'queue') return;
  assert.deepEqual(result.result.order, ['progress', 'stop']);
  assert.equal(result.result.progressFrames, 1);
  assert.equal(result.result.abortObserved, true);
  assert.equal(result.result.driverStopInvoked, true);
  assert.equal(result.result.driverStopAcknowledged, true);
  assert.equal(result.result.driverCloseInvoked, true);
  assert.equal(result.result.driverCloseResolved, true);
  assert.ok(result.result.progressMs >= 0);
  assert.ok(result.result.stopReceivedToAbortMs >= 0);
  assert.ok(result.result.stopReceivedToDriverStopInvokedMs >= 0);
  assert.ok(result.result.stopReceivedToDriverStopAckMs >= result.result.stopReceivedToDriverStopInvokedMs);
  assert.ok(result.result.stopReceivedToReceiptMs >= 0);
  assert.ok(result.result.stopReceivedToDriverCloseInvokedMs >= 0);
  assert.ok(result.result.stopReceivedToDriverCloseResolvedMs >= result.result.stopReceivedToDriverCloseInvokedMs);
  assert.ok(result.timings.sendStopToReceiptMs! >= 0);
  assert.ok(result.timings.receiptToChildCloseMs! >= 0);
  assert.equal(result.timings.clock, 'parent-relative');
  assert.ok(result.result.progressMs <= 100);
  assert.ok(result.result.stopReceivedToAbortMs <= 100);
  assert.ok(result.result.stopReceivedToDriverStopInvokedMs <= 100);
  assert.ok(result.result.stopReceivedToDriverStopAckMs <= 100);
  assert.ok(result.result.stopReceivedToReceiptMs <= 500);
  assert.ok(result.result.stopReceivedToDriverCloseResolvedMs <= 250);
  assert.ok(result.timings.sendStopToReceiptMs! <= 2_000);
  t.diagnostic(JSON.stringify({ classification: 'functional-queued-stop/non-performance', childPid: result.childPid,
    child: { fullAuditMs: result.result.fullAuditMs, beginMs: result.result.beginMs, progressMs: result.result.progressMs,
      stopReceivedToAbortMs: result.result.stopReceivedToAbortMs, stopReceivedToDriverStopInvokedMs: result.result.stopReceivedToDriverStopInvokedMs,
      stopReceivedToDriverStopAckMs: result.result.stopReceivedToDriverStopAckMs, stopReceivedToReceiptMs: result.result.stopReceivedToReceiptMs,
      stopReceivedToDriverCloseInvokedMs: result.result.stopReceivedToDriverCloseInvokedMs, stopReceivedToDriverCloseResolvedMs: result.result.stopReceivedToDriverCloseResolvedMs },
    parent: { sendStopToReceiptMs: result.timings.sendStopToReceiptMs, receiptToChildCloseMs: result.timings.receiptToChildCloseMs },
    deviceOpened: false, formalReady: false, gateB: 'NOT_RUN' }));
  assert.equal(hashCapacityFile(seed), seedHash, '父子测试不打开或改写原关闭seed');
  assert.equal(existsSync(clone.filePath), true, '监督器不自动删除样本clone');
  const database = new DatabaseSync(clone.filePath, { readOnly: true });
  try {
    assert.equal(database.prepare("SELECT count(*) n FROM recording_attempt_events WHERE json_extract(data,'$.event.type')='progress'").get()!.n, 1);
    assert.equal(database.prepare("SELECT count(*) n FROM recording_attempts WHERE status='aborted'").get()!.n, 1);
  } finally { database.close(); }
});

test('排队Stop协议：父侧aggregate guard不进入固定child clone合同', async t => {
  const { runCapacityQueuedStop } = await import('./helpers/recording-capacity-process.js');
  const { fixture, clone } = await queuedFixture(t, 'queued-stop-aggregate-boundary');
  clone.aggregateGuard = {
    parent: clone.parent, snapshotBytes: 1, limitBytes: 2, stopped: false,
    groupForLabel: () => 'queued-stop',
    check: () => ({ sequence: 1, outputBytesBefore: 0, outputBytesAfter: 0, plannedBytes: 0, limitBytes: 2 }),
  };
  let launched = false;
  const result = await runCapacityQueuedStop({ clone, planId: fixture.frozenPlan.id, planHash: fixture.frozenPlan.contentHash }, {
    launch: () => { launched = true; throw new Error('受控launch停止'); },
  });
  assert.equal(launched, true, '父侧预算guard不得使child task在preflight被拒绝');
  assert.equal(result.phase, 'spawned');
  assert.equal(result.failure, 'SPAWN_FAILED');
});

test('排队Stop监督：原回执及cleanup到达后仍等待自然close，父子时钟分栏', { timeout: 10_000 }, async t => {
  const { runCapacityQueuedStop } = await import('./helpers/recording-capacity-process.js');
  const { fixture, clone } = await queuedFixture(t, 'queued-stop-transport');
  const childFile = path.join(fixture.directory, 'queued-stop-transport.mjs');
  writeFileSync(childFile, `
    process.once('message', init => {
      const base = { version: 1, requestId: init.requestId, childPid: process.pid };
      process.send({ ...base, type: 'ready' });
      const order = [];
      process.on('message', message => {
        order.push(message.type);
        if (message.type !== 'stop') return;
        if (order.join(',') !== 'progress,stop') process.exit(7);
        process.send({ ...base, type: 'receipt', result: {
          kind: 'queue', planId: init.task.planId, planHash: init.task.planHash, attemptId: '00000000-0000-4000-8000-000000000001',
          order, progressFrames: 1, fullAuditMs: 1, beginMs: 1, progressMs: 1,
          abortObserved: true, driverStopInvoked: true, driverStopAcknowledged: true,
          stopReceivedToAbortMs: 1, stopReceivedToDriverStopInvokedMs: 2, stopReceivedToDriverStopAckMs: 3, stopReceivedToReceiptMs: 4,
          childMeasuredMs: 7, clock: 'child-relative', deviceOpened: false, formalReady: false, gateB: 'NOT_RUN'
        } });
        process.send({ ...base, type: 'cleanup', result: { driverCloseInvoked: true, driverCloseResolved: true,
          stopReceivedToDriverCloseInvokedMs: 5, stopReceivedToDriverCloseResolvedMs: 6 } });
        setTimeout(() => { process.exitCode = 0; process.disconnect(); }, 120);
      });
    });
  `);
  let child: ReturnType<typeof fork> | undefined, closed = false;
  const launch: typeof fork = (_file, args) => {
    child = fork(childFile, Array.isArray(args) ? args : [], { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.once('close', () => { closed = true; }); return child;
  };
  t.after(async () => { if (child && !closed) await once(child, 'close'); });
  const result = await runCapacityQueuedStop({ clone, planId: fixture.frozenPlan.id, planHash: fixture.frozenPlan.contentHash }, { launch });
  assert.equal(result.outcome, 'ok', JSON.stringify(result)); assert.equal(closed, true);
  assert.equal(result.result?.kind, 'queue'); assert.equal(result.result?.clock, 'child-relative');
  assert.equal(result.timings.clock, 'parent-relative');
  assert.ok(result.timings.sendStopToReceiptMs! >= 0);
  assert.ok(result.timings.receiptToChildCloseMs! >= 100, JSON.stringify(result.timings));
  assert.ok(result.forkToCloseMs > result.timings.receiptMs!);
});

test('排队Stop监督：执行超时升级TERM/KILL且不把ready冒充成功', { timeout: 10_000 }, async t => {
  const { runCapacityQueuedStop } = await import('./helpers/recording-capacity-process.js');
  const { fixture, clone } = await queuedFixture(t, 'queued-stop-timeout');
  const childFile = path.join(fixture.directory, 'queued-stop-timeout.mjs');
  writeFileSync(childFile, `
    process.on('SIGTERM', () => {});
    process.once('message', init => {
      process.send({ version: 1, requestId: init.requestId, childPid: process.pid, type: 'ready' });
      process.on('message', () => {}); setInterval(() => {}, 1000);
    });
  `);
  let child: ReturnType<typeof fork> | undefined, closed = false;
  const launch: typeof fork = (_file, args) => {
    child = fork(childFile, Array.isArray(args) ? args : [], { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.once('close', () => { closed = true; }); return child;
  };
  t.after(async () => { if (child && !closed) await once(child, 'close'); });
  const result = await runCapacityQueuedStop({ clone, planId: fixture.frozenPlan.id, planHash: fixture.frozenPlan.contentHash },
    { launch, executionTimeoutMs: 100, killGraceMs: 20, closeTimeoutMs: 100 });
  assert.equal(result.outcome, 'timeout'); assert.equal(result.failure, 'TIMEOUT'); assert.equal(result.result, undefined);
  assert.deepEqual(result.cleanup, { termSent: true, killSent: true }); assert.equal(result.closed, true);
  assert.equal(existsSync(clone.directory), true, '失败样本由上层保留，不在监督器内删除');
});

test('排队Stop协议：固定sequence、frames、commandId并拒绝未知字段', async () => {
  const api = await import('./helpers/recording-capacity-process.js'), requestId = randomUUID(), commandId = randomUUID();
  const progress = { version: 1, requestId, type: 'progress', sequence: 1, frames: 1 };
  const stop = { version: 1, requestId, type: 'stop', sequence: 2, commandId };
  assert.equal(api.isCapacityQueueProgress(progress, requestId), true);
  assert.equal(api.isCapacityQueueStop(stop, requestId), true);
  assert.equal(api.isCapacityQueueProgress({ ...progress, frames: 2 }, requestId), false);
  assert.equal(api.isCapacityQueueProgress({ ...progress, unexpected: true }, requestId), false);
  assert.equal(api.isCapacityQueueStop({ ...stop, sequence: 1 }, requestId), false);
  assert.equal(api.isCapacityQueueStop({ ...stop, commandId: commandId + '\n' }, requestId), false);
});

test('排队Stop监督：正式路径要求PGID时身份未知必须失败关闭而非降级PID成功', { timeout: 10_000 }, async t => {
  const { runCapacityQueuedStop } = await import('./helpers/recording-capacity-process.js');
  const { fixture, clone } = await queuedFixture(t, 'queued-stop-group-unknown');
  const childFile = path.join(fixture.directory, 'queued-stop-group-unknown.mjs');
  writeFileSync(childFile, `
    process.once('message', init => {
      const base = { version: 1, requestId: init.requestId, childPid: process.pid }; process.send({ ...base, type: 'ready' }); const order = [];
      process.on('message', message => { order.push(message.type); if (message.type !== 'stop') return;
        process.send({ ...base, type: 'receipt', result: { kind: 'queue', planId: init.task.planId, planHash: init.task.planHash,
          attemptId: '00000000-0000-4000-8000-000000000001', order, progressFrames: 1, fullAuditMs: 1, beginMs: 1, progressMs: 1,
          abortObserved: true, driverStopInvoked: true, driverStopAcknowledged: true, stopReceivedToAbortMs: 1,
          stopReceivedToDriverStopInvokedMs: 2, stopReceivedToDriverStopAckMs: 3, stopReceivedToReceiptMs: 4,
          childMeasuredMs: 7, clock: 'child-relative', deviceOpened: false, formalReady: false, gateB: 'NOT_RUN' } });
        process.send({ ...base, type: 'cleanup', result: { driverCloseInvoked: true, driverCloseResolved: true,
          stopReceivedToDriverCloseInvokedMs: 5, stopReceivedToDriverCloseResolvedMs: 6 } }); process.disconnect();
      });
    });
  `);
  const launch = ((_file: string | URL, args?: readonly string[]) =>
    fork(childFile, Array.isArray(args) ? args : [], { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })) as typeof fork;
  const result = await runCapacityQueuedStop({ clone, planId: fixture.frozenPlan.id, planHash: fixture.frozenPlan.contentHash },
    { launch, requireManagedProcessGroup: true });
  assert.equal(result.outcome, 'failed', JSON.stringify(result));
  assert.equal(result.failure, 'PROCESS_GROUP_UNKNOWN'); assert.equal(result.result, undefined);
  assert.equal(result.processGroup?.managed, false); assert.equal(existsSync(clone.directory), true);
});

test('排队Stop监督：自然code0留下同组进程必须失败并清空本轮PGID', { timeout: 10_000 }, async t => {
  const { runCapacityQueuedStop } = await import('./helpers/recording-capacity-process.js');
  const { fixture, clone } = await queuedFixture(t, 'queued-stop-leftover-group');
  const childFile = path.join(fixture.directory, 'queued-stop-leftover-group.mjs'), pidFile = path.join(fixture.directory, 'leftover.pid');
  writeFileSync(childFile, `
    import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs';
    process.once('message', init => {
      const base = { version: 1, requestId: init.requestId, childPid: process.pid }; process.send({ ...base, type: 'ready' }); const order = [];
      process.on('message', message => { order.push(message.type); if (message.type !== 'stop') return;
        process.send({ ...base, type: 'receipt', result: { kind: 'queue', planId: init.task.planId, planHash: init.task.planHash,
          attemptId: '00000000-0000-4000-8000-000000000001', order, progressFrames: 1, fullAuditMs: 1, beginMs: 1, progressMs: 1,
          abortObserved: true, driverStopInvoked: true, driverStopAcknowledged: true, stopReceivedToAbortMs: 1,
          stopReceivedToDriverStopInvokedMs: 2, stopReceivedToDriverStopAckMs: 3, stopReceivedToReceiptMs: 4,
          childMeasuredMs: 7, clock: 'child-relative', deviceOpened: false, formalReady: false, gateB: 'NOT_RUN' } });
        process.send({ ...base, type: 'cleanup', result: { driverCloseInvoked: true, driverCloseResolved: true,
          stopReceivedToDriverCloseInvokedMs: 5, stopReceivedToDriverCloseResolvedMs: 6 } });
        const descendant = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
        writeFileSync(__PID_FILE__, String(descendant.pid)); descendant.unref(); process.disconnect();
      });
    });
  `.replace('__PID_FILE__', JSON.stringify(pidFile)));
  let child: ReturnType<typeof fork> | undefined, closed = false;
  const launch = ((_file: string | URL, args?: readonly string[], options?: import('node:child_process').ForkOptions) => {
    child = fork(childFile, Array.isArray(args) ? args : [], { ...options, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.once('close', () => { closed = true; }); return child;
  }) as typeof fork;
  t.after(async () => {
    if (child && !closed) await once(child, 'close');
    if (existsSync(pidFile)) try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  });
  const result = await runCapacityQueuedStop({ clone, planId: fixture.frozenPlan.id, planHash: fixture.frozenPlan.contentHash }, { launch });
  assert.equal(result.outcome, 'failed', JSON.stringify(result)); assert.equal(result.failure, 'LEFTOVER_PROCESSES');
  assert.equal(result.result, undefined); assert.ok(result.processGroup); assert.equal(result.processGroup.managed, true); assert.equal(result.processGroup.groupEmpty, true);
  assert.equal(result.cleanup.termSent, true);
});

test('排队Stop监督：child乱序阶段时间不能通过receipt与cleanup拼接', { timeout: 10_000 }, async t => {
  const { runCapacityQueuedStop } = await import('./helpers/recording-capacity-process.js');
  const { fixture, clone } = await queuedFixture(t, 'queued-stop-timing-order');
  const childFile = path.join(fixture.directory, 'queued-stop-timing-order.mjs');
  writeFileSync(childFile, `
    process.once('message', init => {
      const base = { version: 1, requestId: init.requestId, childPid: process.pid }; process.send({ ...base, type: 'ready' }); const order = [];
      process.on('message', message => { order.push(message.type); if (message.type !== 'stop') return;
        process.send({ ...base, type: 'receipt', result: { kind: 'queue', planId: init.task.planId, planHash: init.task.planHash,
          attemptId: '00000000-0000-4000-8000-000000000001', order, progressFrames: 1, fullAuditMs: 1, beginMs: 1, progressMs: 1,
          abortObserved: true, driverStopInvoked: true, driverStopAcknowledged: true, stopReceivedToAbortMs: 4,
          stopReceivedToDriverStopInvokedMs: 2, stopReceivedToDriverStopAckMs: 3, stopReceivedToReceiptMs: 5,
          childMeasuredMs: 7, clock: 'child-relative', deviceOpened: false, formalReady: false, gateB: 'NOT_RUN' } });
        process.send({ ...base, type: 'cleanup', result: { driverCloseInvoked: true, driverCloseResolved: true,
          stopReceivedToDriverCloseInvokedMs: 6, stopReceivedToDriverCloseResolvedMs: 7 } }); process.disconnect();
      });
    });
  `);
  const launch = ((_file: string | URL, args?: readonly string[], options?: import('node:child_process').ForkOptions) =>
    fork(childFile, Array.isArray(args) ? args : [], { ...options, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })) as typeof fork;
  const result = await runCapacityQueuedStop({ clone, planId: fixture.frozenPlan.id, planHash: fixture.frozenPlan.contentHash }, { launch });
  assert.equal(result.outcome, 'failed', JSON.stringify(result)); assert.equal(result.failure, 'INVALID_PROTOCOL'); assert.equal(result.result, undefined);
});
