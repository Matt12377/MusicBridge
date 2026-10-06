import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Worker } from 'node:worker_threads';
import { fstatSync } from 'node:fs';
import type { MetadataReaderLifecycle, MetadataReadResult, MetadataWorkerResultMessage,
  MetadataReaderTimeoutLifecycle } from '../../src/library/metadata-reader-types.js';
import { readonlySourceCandidateMetadata } from '../../src/recording/source-files.js';
import { audioFixture, loadFreshMetadataReader } from '../helpers/mbrs003-audio-fixtures.js';

const { createMetadataReader } = await loadFreshMetadataReader();
type Mode = 'late-exit' | 'invalid' | 'duplicate' | 'worker-timeout-late-exit' | 'cancel-first';
const phases = ['dependency-load', 'container-check', 'parser-load', 'parse', 'output-check', 'complete'];
function packet(value: unknown): MetadataWorkerResultMessage | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
  const p = value as Record<string, unknown>;
  if (p.kind !== 'metadata-result' || typeof p.phase !== 'string' || !phases.includes(p.phase)
    || typeof p.result !== 'object' || p.result === null || Array.isArray(p.result)) return;
  const r = p.result as Record<string, unknown>;
  if (r.status === 'failure' && typeof r.code === 'string') return p as unknown as MetadataWorkerResultMessage;
  if (r.status === 'ok' && p.phase === 'complete'
    && typeof r.technical === 'object' && r.technical !== null) return p as unknown as MetadataWorkerResultMessage;
}
function joined(events: MetadataReaderLifecycle[], result: MetadataReadResult): void {
  const starts = events.filter((e): e is Extract<MetadataReaderLifecycle,
    { type: 'worker-start' | 'worker-online' }> => e.type === 'worker-start');
  assert.equal(starts.length, 1);
  const start = starts[0]!;
  const exits = events.filter(e => e.type === 'worker-exit' && e.threadId === start.threadId);
  const releases = events.filter(e => e.type === 'lease-released' && e.fd === start.fd);
  const completes = events.filter(e => e.type === 'read-complete');
  assert.equal(exits.length, 1); assert.equal(releases.length, 1); assert.equal(completes.length, 1);
  assert.ok(events.indexOf(exits[0]!) < events.indexOf(releases[0]!));
  assert.ok(events.indexOf(releases[0]!) < events.indexOf(completes[0]!));
  assert.throws(() => fstatSync(start.fd), error => (error as NodeJS.ErrnoException).code === 'EBADF');
  const complete = completes[0]!;
  assert.equal(complete.type === 'read-complete' && complete.status === result.status, true);
}
function diagnostics(events: MetadataReaderLifecycle[], mode: Mode): void {
  const timed = events.filter((e): e is MetadataReaderTimeoutLifecycle => e.type === 'worker-timeout');
  const late = mode === 'late-exit' || mode === 'worker-timeout-late-exit';
  assert.equal(timed.length, late ? 1 : 0);
  if (!late) return;
  const info = timed[0]!, start = events.find(e => e.type === 'worker-start');
  assert.ok(start && start.type === 'worker-start');
  assert.equal(info.fd, start.fd); assert.equal(info.threadId, start.threadId);
  assert.equal(info.origin, 'parent-read'); assert.equal(info.phase, 'exit-wait');
  assert.equal(info.onlineObserved, true); assert.equal(info.resultMessageObserved, true);
  assert.equal(info.workerReportedTimeout, mode === 'worker-timeout-late-exit');
  assert.ok(typeof info.elapsedMs === 'number' && Number.isFinite(info.elapsedMs) && info.elapsedMs >= 4000);
  assert.ok(typeof info.lateByMs === 'number' && Number.isFinite(info.lateByMs) && info.lateByMs >= 1000);
  const actualExit = events.findIndex(e => e.type === 'worker-exit');
  assert.ok(events.indexOf(info) < actualExit);
}

async function runCase(t: TestContext, mode: Mode): Promise<void> {
  const f = await audioFixture(t), relative = f.entry('core-wav').file;
  const input = { root: f.root, relative,
    expectedSignature: (await readonlySourceCandidateMetadata(f.root, relative)).signature };
  const events: MetadataReaderLifecycle[] = [], abort = new AbortController();
  const realNow = performance.now.bind(performance), fixed = realNow();
  let offset = 0, frozen = mode === 'worker-timeout-late-exit';
  let targetThreadId: number | undefined, target: Worker | undefined;
  let capturedAtOnline = false, actualMessages = 0, actualExitEvents = 0, injected = 0, cancelled = 0;
  let observed: MetadataWorkerResultMessage | undefined;
  const clock = t.mock.method(performance, 'now', () => frozen ? fixed : realNow() + offset);
  const originalEmit = Worker.prototype.emit;
  const transport = t.mock.method(Worker.prototype, 'emit', function (this: Worker,
    event: string | symbol, ...args: unknown[]): boolean {
    // 必须在真实online的分发前绑定本例实例；exit时不再用可能已经为-1的threadId猜身份。
    if (event === 'online' && target === undefined && targetThreadId !== undefined
      && this.threadId === targetThreadId) { target = this; capturedAtOnline = true; }
    if (this !== target) return originalEmit.call(this, event, ...args);
    if (event === 'message') {
      ++actualMessages;
      const valid = packet(args[0]);
      if (valid) observed = valid;
      if (valid && injected === 0 && mode === 'invalid') {
        ++injected; return originalEmit.call(this, event, { kind: 'invalid-envelope' });
      }
      if (valid && injected === 0 && mode === 'duplicate') {
        ++injected;
        const first = originalEmit.call(this, event, ...args);
        const second = originalEmit.call(this, event, ...args);
        return first || second;
      }
    }
    if (event === 'exit') {
      ++actualExitEvents;
      if (observed && injected === 0 && (mode === 'late-exit' || mode === 'worker-timeout-late-exit')) {
        ++injected; frozen = false; offset += 4000;
      }
    }
    // exit及其真实退出码原封不动分发；不制造退出、lease释放或read-complete。
    return originalEmit.call(this, event, ...args);
  });
  const reader = createMetadataReader({
    ...(mode === 'worker-timeout-late-exit' ? { trustedBudget: { timeoutMs: 1 } } : {}),
    onLifecycle(event) {
      events.push(event);
      if (event.type === 'worker-start') targetThreadId = event.threadId;
      if (event.type === 'worker-online' && mode === 'cancel-first') {
        ++cancelled; abort.abort(); offset += 4000;
      }
    },
  });
  try {
    const result = await reader.read(input, abort.signal);
    assert.equal(result.status, 'failure');
    if (result.status === 'failure') assert.equal(result.code,
      mode === 'invalid' || mode === 'duplicate' ? 'WORKER_FAILED'
        : mode === 'cancel-first' ? 'CANCELLED' : 'TIMEOUT');
    assert.equal(capturedAtOnline, true, '必须命中本例真实online实例，不能碰其他Worker');
    assert.equal(actualExitEvents, 1); assert.equal(targetThreadId !== undefined, true);
    if (mode === 'cancel-first') {
      assert.equal(cancelled, 1); assert.equal(injected, 0);
    } else {
      assert.equal(actualMessages, 1, '原始Worker仅发送一次最终消息；duplicate只加一次测试分发');
      assert.equal(injected, 1); assert.ok(observed, '注入前必须取得真实合法最终信封');
      if (mode === 'worker-timeout-late-exit') {
        assert.equal(observed.result.status, 'failure');
        if (observed.result.status === 'failure') assert.equal(observed.result.code, 'TIMEOUT');
        assert.ok(phases.includes(observed.phase));
      } else {
        assert.equal(observed.phase, 'complete'); assert.equal(observed.result.status, 'ok');
        if (observed.result.status === 'ok') assert.equal(observed.result.technical.container, 'WAVE');
      }
    }
    joined(events, result); diagnostics(events, mode);
    await reader.close(); await reader.close();
  } finally {
    try { await reader.close(); }
    finally { transport.mock.restore(); clock.mock.restore(); await f.assertUnchanged(); }
  }
}

test('MBRS003 protocol REAL_RESULT_THEN_LATE_EXIT 父期限在exit前仍有效', { timeout: 20_000 },
  t => runCase(t, 'late-exit'));
test('MBRS003 protocol INVALID_ENVELOPE 真实transport非法信封拒绝', { timeout: 20_000 },
  t => runCase(t, 'invalid'));
test('MBRS003 protocol DUPLICATE_FINAL_ENVELOPE 合法最终信封重复拒绝', { timeout: 20_000 },
  t => runCase(t, 'duplicate'));
test('MBRS003 protocol WORKER_TIMEOUT_THEN_LATE_EXIT 父来源保持子报告且只诊断一次', { timeout: 20_000 },
  t => runCase(t, 'worker-timeout-late-exit'));
test('MBRS003 protocol CANCEL_FIRST_THEN_LATE_CLOCK 首次取消不得改写或误报超时', { timeout: 20_000 },
  t => runCase(t, 'cancel-first'));
