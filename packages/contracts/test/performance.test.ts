import assert from 'node:assert/strict';
import test from 'node:test';

import { assertDiagnosticExportSafe } from '../src/diagnostics.js';
import {
  PerformanceTraceRecorder,
  PERFORMANCE_RING_LIMIT,
  PERFORMANCE_MAX_INFLIGHT,
  type PerformanceMetrics,
  type PerformanceLabels,
  type PerformanceOperation,
  type PerformanceTraceContext,
  copyPerformanceTraceContext,
  copyPerformanceTraceSnapshot,
  isPerformanceTraceContext,
  isPerformanceTraceSnapshot,
} from '../src/performance.js';

function ids(seed = 0): () => string {
  return () => `00000000-0000-4000-8000-${(++seed).toString(16).padStart(12, '0')}`;
}

const context: PerformanceTraceContext = {
  traceId: '00000000-0000-4000-8000-000000000001',
  requestId: '00000000-0000-4000-8000-000000000002',
};

test('默认关闭不读时钟、生成身份、读取业务字段或序列化数据', () => {
  let clockCalls = 0, identityCalls = 0, payloadCalls = 0;
  const trace = new PerformanceTraceRecorder({ component: 'core', now: () => { clockCalls++; return 0; }, id: () => { identityCalls++; return context.traceId; } });
  const payload = Object.defineProperty({}, 'providerCallCount', { get() { payloadCalls++; throw new Error('合成异常'); } }) as PerformanceMetrics;
  trace.context();
  trace.childContext(context);
  const span = trace.start('provider', context, payload);
  span.add(payload);
  span.cancel();
  span.end('error', payload);
  trace.mark('event', 'instant', context, payload);
  trace.increment('eventCount');
  trace.setGauge('queueItemCount', 10);
  assert.equal(span.context, undefined);
  assert.deepEqual([clockCalls, identityCalls, payloadCalls], [0, 0, 0]);
  assert.equal(trace.snapshot().events.length, 0);
  assert.equal(trace.snapshot().inflightCount, 0);
});

test('环形缓冲区覆盖最旧事件，快照和返回的身份不会回写内部数据', () => {
  let now = 100;
  const trace = new PerformanceTraceRecorder({ component: 'renderer', enabled: true, limit: 2, id: ids(), now: () => now++ });
  trace.mark('render', 'first-render', context, { rowCount: 10 });
  trace.mark('render', 'page-ready', context, { rowCount: 20 });
  trace.mark('queue', 'queue-ready', context, { queueItemCount: 30 });
  const snapshot = trace.snapshot();
  assert.deepEqual(snapshot.events.map((event) => event.sequence), [2, 3]);
  assert.deepEqual(snapshot.events.map((event) => event.atMs), [1, 2]);
  assert.equal(snapshot.overwrittenEventCount, 1);
  snapshot.events[0]!.metrics.rowCount = 999;
  snapshot.events[0]!.context!.traceId = '修改副本';
  snapshot.counters.rowCount = 999;
  snapshot.gauges.queueItemCount = 999;
  assert.equal(trace.snapshot().events[0]!.metrics.rowCount, 20);
  assert.equal(trace.snapshot().events[0]!.context!.traceId, context.traceId);
  assert.equal(trace.snapshot().counters.rowCount, 30);
  assert.equal(trace.snapshot().gauges.queueItemCount, 30);
});

test('跨层只传身份，每个进程的 duration 来自自身单调时钟', () => {
  let mainNow = 100, coreNow = 50_000;
  const main = new PerformanceTraceRecorder({ component: 'main', enabled: true, id: ids(20), now: () => mainNow });
  const core = new PerformanceTraceRecorder({ component: 'core', enabled: true, id: ids(50), now: () => coreNow });
  const first = main.start('ipc');
  const second = core.start('ipc', first.context);
  mainNow += 35;
  coreNow += 12;
  second.end();
  first.end();
  assert.deepEqual(main.snapshot().events[1]!.context, core.snapshot().events[1]!.context);
  assert.notEqual(main.snapshot().clock.id, core.snapshot().clock.id);
  assert.equal(main.snapshot().events[1]!.durationMs, 35);
  assert.equal(core.snapshot().events[1]!.durationMs, 12);
  assert.equal(main.snapshot().clock.kind, 'process-monotonic');
  const child = main.childContext(first.context!);
  assert.equal(child?.traceId, first.context?.traceId);
  assert.equal(child?.parentRequestId, first.context?.requestId);
  assert.notEqual(child?.requestId, first.context?.requestId);
});

test('严格字段白名单舍弃凭据、路径、SQL、业务数据和任意标签', () => {
  const trace = new PerformanceTraceRecorder({ component: 'core', enabled: true, id: ids(), now: () => 1 });
  let touched = 0;
  const unsafe = {
    sqlCount: 1, providerCallCount: 2, estimatedBytes: 100,
    queueWaitMs: 1.5, providerDurationMs: 8.5, sqlDurationMs: 2, renderDurationMs: 3,
    activeRequestCount: 4,
    cookie: '合成敏感值', url: 'https://example.invalid/private',
    sql: 'SELECT private FROM secret', trackId: 'private',
    toJSON() { throw new Error('不可序列化业务数据'); },
    get items() { touched++; throw new Error('不可遍历队列'); },
  };
  const labels = { command: 'playback.stop', eventName: 'playback.changed', title: '合成私密标题' } as PerformanceLabels;
  trace.mark('provider', 'provider-response', context, unsafe, labels);
  trace.mark('https://example.invalid' as PerformanceOperation, 'instant');
  trace.mark('sql', 'instant', context, { sqlCount: NaN, estimatedBytes: Infinity, rowCount: -1 });
  trace.mark('event', 'instant', context, {}, { command: 'Cookie: synthetic' } as unknown as PerformanceLabels);
  const serialized = trace.export();
  assertDiagnosticExportSafe(serialized);
  assert.doesNotMatch(serialized, /合成敏感值|example\.invalid|SELECT|private|\"sql\":|trackId|合成私密标题|Cookie/);
  assert.equal(touched, 0);
  const snapshot = trace.snapshot();
  assert.equal(snapshot.events.length, 3);
  assert.equal(snapshot.events[0]!.command, 'playback.stop');
  assert.equal(snapshot.events[0]!.metrics.activeRequestCount, 4);
  assert.equal(snapshot.counters.sqlCount, 1);
  assert.equal(snapshot.counters.queueWaitMs, 1.5);
  assert.equal(snapshot.counters.providerDurationMs, 8.5);
  assert.deepEqual(snapshot.events[1]!.metrics, {});
});

test('关联身份拒绝非 UUID 及 boxed 字符串，恶意 getter 不逸出', () => {
  const trace = new PerformanceTraceRecorder({ component: 'main', enabled: true, id: ids(), now: () => 0 });
  const boxed = new String(context.traceId);
  Object.assign(boxed, { token: '合成敏感值' });
  for (const traceId of ['account-private', 'https://example.invalid', boxed]) {
    const invalid = { traceId, requestId: context.requestId } as PerformanceTraceContext;
    assert.equal(trace.context(invalid), undefined);
    trace.mark('ipc', 'instant', invalid);
    assert.equal(trace.start('ipc', invalid).context, undefined);
  }
  const broken = Object.defineProperty({}, 'traceId', { get() { throw new Error('合成异常'); } }) as PerformanceTraceContext;
  assert.doesNotThrow(() => trace.mark('ipc', 'instant', broken));
  assert.doesNotThrow(() => trace.start('ipc', broken));
  let labelReads = 0;
  const unsafeLabels = Object.defineProperty({}, 'command', { get() { labelReads++; return labelReads < 3 ? 'playback.stop' : 'Cookie: synthetic'; } });
  assert.doesNotThrow(() => trace.mark('ipc', 'instant', context, {}, unsafeLabels));
  assert.equal(labelReads, 0);
  assert.equal(trace.snapshot().events.length, 0);
});

test('并发上限有界，取消残留与完成计数幂等，释放后可复用 slot', () => {
  let now = 10;
  const trace = new PerformanceTraceRecorder({ component: 'core', enabled: true, maxInflight: 2, id: ids(), now: () => now });
  const first = trace.start('provider', undefined, { providerCallCount: 1 });
  const second = trace.start('sql', undefined, { sqlCount: 1 });
  const dropped = trace.start('library');
  assert.equal(dropped.context, undefined);
  assert.equal(trace.snapshot().droppedSpanCount, 1);
  assert.equal(trace.snapshot().inflightCount, 2);
  now = 20;
  first.cancel();
  first.cancel();
  assert.equal(trace.snapshot().cancelResidualCount, 1);
  now = 35;
  first.end('cancelled', { providerDurationMs: 25 });
  first.end('cancelled', { providerCallCount: 99 });
  second.add({ sqlCount: 2, sqlDurationMs: 5 });
  second.end('error');
  const snapshot = trace.snapshot();
  assert.equal(snapshot.inflightCount, 0);
  assert.equal(snapshot.cancelResidualCount, 0);
  assert.equal(snapshot.counters.cancellationCount, 1);
  assert.equal(snapshot.counters.cancelledCount, 1);
  assert.equal(snapshot.counters.failedCount, 1);
  assert.equal(snapshot.counters.completedCount, 2);
  assert.equal(snapshot.counters.cancelResidualMs, 15);
  assert.equal(snapshot.counters.providerCallCount, 1);
  assert.equal(snapshot.counters.sqlCount, 3);
  assert.equal(snapshot.events.find((event) => event.outcome === 'cancelled')!.metrics.cancelResidualMs, 15);
  assert.notEqual(trace.start('library').context, undefined);
});

test('时钟回退或异常不输出虚假耗时，结束仍释放并发 slot', () => {
  let now = 100, fail = false;
  const trace = new PerformanceTraceRecorder({ component: 'core', enabled: true, id: ids(), now: () => { if (fail) throw new Error('合成时钟故障'); return now; } });
  const first = trace.start('ipc');
  now = 120;
  trace.mark('ipc', 'core-received', first.context);
  now = 110;
  first.end();
  assert.equal(trace.snapshot().inflightCount, 0);
  assert.equal(trace.snapshot().events.length, 2);
  now = 130;
  const second = trace.start('provider');
  fail = true;
  assert.doesNotThrow(() => second.end());
  assert.equal(trace.snapshot().inflightCount, 0);
  assert.equal(trace.snapshot().events.length, 3);
});

test('关闭与 dispose 撤销旧 span 的记录权限并保留可导出证据', () => {
  const trace = new PerformanceTraceRecorder({ component: 'main', enabled: true, id: ids(), now: () => 1 });
  const old = trace.start('ipc');
  trace.setEnabled(false);
  assert.equal(trace.snapshot().inflightCount, 0);
  trace.setEnabled(true);
  old.add({ providerCallCount: 10 });
  old.cancel();
  old.end();
  assert.equal(trace.snapshot().events.length, 1);
  const fresh = trace.start('library');
  trace.dispose();
  trace.dispose();
  fresh.end();
  trace.setEnabled(true);
  assert.equal(trace.snapshot().disposed, true);
  assert.equal(trace.snapshot().enabled, false);
  assert.equal(trace.snapshot().inflightCount, 0);
  assert.equal(trace.snapshot().events.length, 2);
  assertDiagnosticExportSafe(trace.export());
});

test('非法诊断容量回落到有界默认值，不让诊断参数阻断业务', () => {
  const trace = new PerformanceTraceRecorder({ component: 'core', limit: Number.MAX_SAFE_INTEGER, maxInflight: -1 });
  assert.equal(trace.snapshot().limit, PERFORMANCE_RING_LIMIT);
  assert.equal(trace.snapshot().maxInflight, PERFORMANCE_MAX_INFLIGHT);
  const brokenClock = new PerformanceTraceRecorder({ component: 'core', enabled: true, now: () => NaN, id: ids() });
  assert.equal(brokenClock.start('ipc').context, undefined);
  assert.doesNotThrow(() => brokenClock.mark('ipc', 'instant'));
  assert.equal(brokenClock.snapshot().events.length, 0);
});

test('有界 ring 在大量记录后保持原始顺序且不依赖业务 JSON', () => {
  let now = 0;
  const trace = new PerformanceTraceRecorder({ component: 'core', enabled: true, limit: 8, id: ids(), now: () => now++ });
  for (let index = 0; index < 2_000; index++) trace.mark('event', 'instant', undefined, { eventCount: 1, estimatedBytes: 8 });
  assert.deepEqual(trace.snapshot().events.map((event) => event.sequence), [1_993, 1_994, 1_995, 1_996, 1_997, 1_998, 1_999, 2_000]);
  assert.equal(trace.snapshot().counters.eventCount, 2_000);
  assert.equal(trace.snapshot().counters.estimatedBytes, 16_000);
  assert.equal(trace.snapshot().overwrittenEventCount, 1_992);
});

test('IPC 快照校验重建白名单，拒绝超界数组、坏数值及混用进程时钟', () => {
  const trace = new PerformanceTraceRecorder({ component: 'core', enabled: true, limit: 2, id: ids(), now: () => 1 });
  trace.mark('ipc', 'core-received', context, { estimatedBytes: 32 }, { command: 'playback.stop' });
  const snapshot = trace.snapshot();
  const contaminated = {
    ...snapshot, cookie: '合成敏感值', counters: { ...snapshot.counters, token: '合成敏感值' },
    events: snapshot.events.map((event) => ({ ...event, sql: '合成敏感值', metrics: { ...event.metrics, url: 'https://example.invalid' }, context: { ...event.context, profile: '合成敏感值' } })),
  };
  const copied = copyPerformanceTraceSnapshot(contaminated);
  assert.equal(isPerformanceTraceSnapshot(copied), true);
  assert.deepEqual(copied, snapshot);
  assertDiagnosticExportSafe(JSON.stringify(copied));
  assert.equal(isPerformanceTraceContext({ ...context, cookie: '合成敏感值' }), true);
  assert.deepEqual(copyPerformanceTraceContext({ ...context, cookie: '合成敏感值' }), context);
  copied!.events[0]!.metrics.estimatedBytes = 0;
  assert.equal(snapshot.events[0]!.metrics.estimatedBytes, 32);
  const invalid = [
    { ...snapshot, events: new Array(3).fill(snapshot.events[0]) },
    { ...snapshot, limit: 100_000 },
    { ...snapshot, inflightCount: 100_000 },
    { ...snapshot, schemaVersion: 99 },
    { ...snapshot, clock: { kind: 'process-monotonic', id: 'https://example.invalid' } },
    { ...snapshot, events: [{ ...snapshot.events[0], clockId: context.requestId }] },
    { ...snapshot, events: [{ ...snapshot.events[0], durationMs: NaN }] },
    { ...snapshot, events: [{ ...snapshot.events[0], metrics: { estimatedBytes: -1 } }] },
    { ...snapshot, events: [{ ...snapshot.events[0], command: 'Cookie: synthetic' }] },
  ];
  for (const value of invalid) assert.equal(copyPerformanceTraceSnapshot(value), undefined);
});

test('IPC 校验不运行已知字段或数组元素上的 getter，关闭快照同样有效', () => {
  const trace = new PerformanceTraceRecorder({ component: 'main' });
  assert.deepEqual(copyPerformanceTraceSnapshot(trace.snapshot()), trace.snapshot());
  let invoked = 0;
  const input = Object.defineProperty({ ...trace.snapshot() }, 'events', { get() { invoked++; throw new Error('合成访问器'); } });
  assert.equal(copyPerformanceTraceSnapshot(input), undefined);
  const contextInput = Object.defineProperty({ ...context }, 'traceId', { get() { invoked++; return context.traceId; } });
  assert.equal(copyPerformanceTraceContext(contextInput), undefined);
  assert.equal(isPerformanceTraceContext(contextInput), false);
  assert.equal(invoked, 0);
});
