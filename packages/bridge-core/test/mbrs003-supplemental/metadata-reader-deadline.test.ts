import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { fstatSync } from 'node:fs';
import type { MetadataReaderLifecycle, MetadataReadResult } from '../../src/library/metadata-reader-types.js';
import { readonlySourceCandidateMetadata } from '../../src/recording/source-files.js';
import { audioFixture, loadFreshMetadataReader } from '../helpers/mbrs003-audio-fixtures.js';

const { createMetadataReader } = await loadFreshMetadataReader();
type TimeoutOrigin = 'parent-start' | 'parent-read' | 'worker-check';
type TimeoutPhase = 'startup' | 'awaiting-result' | 'exit-wait' | 'dependency-load'
  | 'container-check' | 'parser-load' | 'parse' | 'output-check' | 'complete';
type TimeoutEvent = { type: 'worker-timeout'; fd: number; threadId: number;
  origin: TimeoutOrigin; phase: TimeoutPhase; elapsedMs: number | null; lateByMs: number | null;
  onlineObserved: boolean; resultMessageObserved: boolean; workerReportedTimeout: boolean };
type Event = MetadataReaderLifecycle | TimeoutEvent;
type Mode = 'start' | 'online' | 'observer' | 'worker';

function joined(events: Event[], result: MetadataReadResult): void {
  const starts = events.filter((e): e is Extract<MetadataReaderLifecycle,
    { type: 'worker-start' | 'worker-online' }> => e.type === 'worker-start');
  assert.equal(starts.length, 1);
  const start = starts[0]!;
  const exits = events.filter(e => e.type === 'worker-exit' && e.threadId === start.threadId);
  const releases = events.filter(e => e.type === 'lease-released' && e.fd === start.fd);
  const completions = events.filter(e => e.type === 'read-complete');
  assert.equal(exits.length, 1); assert.equal(releases.length, 1); assert.equal(completions.length, 1);
  assert.ok(events.indexOf(exits[0]!) < events.indexOf(releases[0]!));
  assert.ok(events.indexOf(releases[0]!) < events.indexOf(completions[0]!));
  assert.throws(() => fstatSync(start.fd), error => (error as NodeJS.ErrnoException).code === 'EBADF');
  const complete = completions[0]!;
  assert.equal(complete.type === 'read-complete' && complete.status === result.status, true);
}

function timeoutInfo(events: Event[], origin: TimeoutOrigin): void {
  const event = events.find((e): e is TimeoutEvent => e.type === 'worker-timeout' && e.origin === origin);
  assert.ok(event, 'GREEN必须具有对应真实超时来源诊断');
  const start = events.find(e => e.type === 'worker-start');
  assert.ok(start && start.type === 'worker-start');
  assert.equal(event.fd, start.fd); assert.equal(event.threadId, start.threadId);
  const phases = origin === 'worker-check'
    ? ['dependency-load', 'container-check', 'parser-load', 'parse', 'output-check', 'complete']
    : ['startup', 'awaiting-result', 'exit-wait'];
  assert.ok(phases.includes(event.phase));
  for (const value of [event.elapsedMs, event.lateByMs]) {
    assert.ok(value === null || typeof value === 'number' && Number.isFinite(value) && value >= 0);
  }
  for (const value of [event.onlineObserved, event.resultMessageObserved, event.workerReportedTimeout]) {
    assert.equal(typeof value, 'boolean');
  }
  if (origin === 'worker-check') {
    assert.equal(event.onlineObserved, true); assert.equal(event.resultMessageObserved, true);
    assert.equal(event.workerReportedTimeout, true);
  } else {
    assert.ok(typeof event.elapsedMs === 'number' && event.elapsedMs >= 4000);
    assert.ok(typeof event.lateByMs === 'number' && event.lateByMs >= 1000);
  }
}

async function runCase(t: TestContext, mode: Mode): Promise<void> {
  const f = await audioFixture(t), relative = f.entry('core-wav').file;
  const input = { root: f.root, relative,
    expectedSignature: (await readonlySourceCandidateMetadata(f.root, relative)).signature };
  const events: Event[] = [], realNow = performance.now.bind(performance);
  let offset = 0, clockChangeCount = 0;
  const fixed = realNow();
  const clock = mode === 'observer' ? undefined : t.mock.method(performance, 'now',
    mode === 'worker' ? () => fixed : () => realNow() + offset);
  const reader = createMetadataReader({
    ...(mode === 'worker' ? { trustedBudget: { timeoutMs: 1 } } : {}),
    onLifecycle(event) {
      events.push(event);
      if ((mode === 'start' && event.type === 'worker-start')
        || (mode === 'online' && event.type === 'worker-online')) {
        ++clockChangeCount; offset += 4000;
      }
      if (mode === 'observer') throw new Error('合成观察者故障：不得阻止读取或关闭');
    },
  });
  try {
    const result = await reader.read(input);
    // 首先断言故障码；旧实现的错误ok必须在此RED，不靠缺少诊断事件凑RED。
    if (mode === 'observer') assert.equal(result.status, 'ok');
    else {
      assert.equal(result.status, 'failure');
      if (result.status === 'failure') assert.equal(result.code,
        mode === 'start' ? 'WORKER_START_TIMEOUT' : 'TIMEOUT');
    }
    if (mode === 'start' || mode === 'online') assert.equal(clockChangeCount, 1);
    joined(events, result);
    // 只有上面的目标行为通过，才继续核GREEN诊断完整性。
    if (mode !== 'observer') timeoutInfo(events,
      mode === 'start' ? 'parent-start' : mode === 'online' ? 'parent-read' : 'worker-check');
    else assert.equal(events.some(e => e.type === 'worker-timeout'), false);
    await reader.close(); await reader.close();
  } finally {
    try { await reader.close(); } finally { clock?.mock.restore(); await f.assertUnchanged(); }
  }
}

test('MBRS003 deadline START_OFFSET_4000 默认启动原期限不能续时', { timeout: 20_000 },
  t => runCase(t, 'start'));
test('MBRS003 deadline ONLINE_OFFSET_4000 默认读取原期限不能续时', { timeout: 20_000 },
  t => runCase(t, 'online'));
test('MBRS003 deadline OBSERVER_THROW 合法WAV仍成功且真实关闭', { timeout: 20_000 },
  t => runCase(t, 'observer'));
test('MBRS003 deadline FROZEN_PARENT_CLOCK_1MS Worker自检超时仍真实关闭', { timeout: 20_000 },
  t => runCase(t, 'worker'));
