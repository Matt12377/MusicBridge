import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import type { EventLoopUtilization } from 'node:perf_hooks';
import { PerformanceTraceRecorder, type PerformanceTraceContext } from '@music-bridge/contracts';

import {
  createNodePerformanceTrace,
  withPerformanceContext,
  currentPerformanceContext,
  type NodePerformanceDependencies,
  type PerformanceEventLoopHistogram,
  type PerformanceSampleTimer,
} from '../src/diagnostics/performance-trace.js';

function fixture() {
  const calls = { histogram: 0, enabled: 0, disabled: 0, timer: 0, unref: 0, cleared: 0, reset: 0, memory: 0, utilization: 0 };
  let sample: (() => void) | undefined;
  let count = 2, seed = 0;
  const histogram: PerformanceEventLoopHistogram = {
    get count() { return count; },
    mean: 2_000_000, max: 8_000_000,
    percentile: () => 5_000_000,
    reset() { calls.reset++; },
    enable() { calls.enabled++; },
    disable() { calls.disabled++; },
  };
  const timer: PerformanceSampleTimer = { unref() { calls.unref++; } };
  const dependencies: NodePerformanceDependencies = {
    histogram: () => { calls.histogram++; return histogram; },
    timer: (callback) => { calls.timer++; sample = callback; return timer; },
    clearTimer: () => { calls.cleared++; },
    utilization: (current?: EventLoopUtilization) => { calls.utilization++; return { idle: 10, active: 5, utilization: current ? 0.5 : 0.25 }; },
    memory: () => { calls.memory++; return { rss: 1_000, heapUsed: 100 }; },
  };
  return {
    calls, dependencies, histogram,
    sample: () => sample?.(),
    noSamples: () => { count = 0; },
    id: () => `00000000-0000-4000-8000-${(++seed).toString(16).padStart(12, '0')}`,
  };
}

test('默认关闭时不创建 histogram、timer 或采样，dispose 幂等', () => {
  const fake = fixture();
  const trace = createNodePerformanceTrace({ component: 'core', dependencies: fake.dependencies, monitorEventLoop: true, now: () => { throw new Error('关闭时不能读时钟'); }, id: () => { throw new Error('关闭时不能生成身份'); } });
  assert.equal(trace.startMonitoring(), false);
  trace.sample();
  trace.dispose();
  trace.dispose();
  assert.deepEqual(Object.values(fake.calls), new Array(Object.keys(fake.calls).length).fill(0));
  assert.equal(trace.isMonitoring(), false);
  assert.equal(trace.recorder.snapshot().events.length, 0);
});

test('启用后仅创建一个 unref timer，按需采样有界数值，关闭释放资源', () => {
  const fake = fixture();
  const trace = createNodePerformanceTrace({ component: 'core', enabled: true, monitorEventLoop: true, dependencies: fake.dependencies, now: () => 100, id: fake.id });
  assert.equal(trace.isMonitoring(), true);
  assert.equal(trace.startMonitoring(), true);
  fake.sample();
  const snapshot = trace.recorder.snapshot();
  assert.equal(fake.calls.histogram, 1);
  assert.equal(fake.calls.timer, 1);
  assert.equal(fake.calls.unref, 1);
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0]!.operation, 'event-loop');
  assert.deepEqual(snapshot.events[0]!.metrics, {
    rssBytes: 1_000, heapUsedBytes: 100,
    eventLoopDelayMeanMs: 2, eventLoopDelayP95Ms: 5, eventLoopDelayMaxMs: 8,
    eventLoopUtilization: 0.5,
  });
  assert.equal(fake.calls.reset, 1);
  trace.setEnabled(false);
  trace.stopMonitoring();
  assert.equal(fake.calls.cleared, 1);
  assert.equal(fake.calls.disabled, 1);
  assert.equal(trace.isMonitoring(), false);
  fake.sample();
  assert.equal(trace.recorder.snapshot().events.length, 1);
  trace.setEnabled(true);
  assert.equal(trace.isMonitoring(), true);
  trace.dispose();
  assert.equal(fake.calls.cleared, 2);
  assert.equal(fake.calls.disabled, 2);
  assert.equal(trace.startMonitoring(), false);
});

test('没有延迟样本时保留未观测状态，不输出虚假零延迟', () => {
  const fake = fixture();
  fake.noSamples();
  const trace = createNodePerformanceTrace({ component: 'main', enabled: true, dependencies: fake.dependencies, now: () => 1, id: fake.id });
  trace.startMonitoring();
  trace.sample();
  assert.equal(trace.recorder.snapshot().events[0]!.metrics.eventLoopDelayMeanMs, undefined);
  assert.equal(trace.recorder.snapshot().gauges.eventLoopDelayMaxMs, undefined);
  trace.dispose();
});

test('监测器初始化异常安全收口，采样异常不逸出或记录内部错误', () => {
  const fake = fixture();
  const dependencies = { ...fake.dependencies, timer() { throw new Error('合成 timer 错误'); } };
  const trace = createNodePerformanceTrace({ component: 'core', enabled: true, dependencies, now: () => 1, id: fake.id });
  assert.equal(trace.startMonitoring(), false);
  assert.equal(fake.calls.disabled, 1);
  assert.equal(trace.isMonitoring(), false);
  trace.dispose();

  const sampleFailure = createNodePerformanceTrace({ component: 'core', enabled: true, dependencies: { ...fake.dependencies, memory() { throw new Error('合成内存观测错误'); } }, now: () => 1, id: fake.id });
  sampleFailure.startMonitoring();
  assert.doesNotThrow(() => sampleFailure.sample());
  assert.equal(sampleFailure.recorder.snapshot().events.length, 0);
  sampleFailure.dispose();
});

test('直接关闭 recorder 后下一次采样释放监测器，回调不新增事件', () => {
  const fake = fixture();
  const trace = createNodePerformanceTrace({ component: 'core', enabled: true, monitorEventLoop: true, dependencies: fake.dependencies, now: () => 1, id: fake.id });
  trace.recorder.setEnabled(false);
  fake.sample();
  assert.equal(trace.isMonitoring(), false);
  assert.equal(fake.calls.cleared, 1);
  assert.equal(fake.calls.disabled, 1);
  assert.equal(trace.recorder.snapshot().events.length, 0);
  trace.dispose();
});

test('真实 perf_hooks 监测保持原始导出，dispose 后不会继续采样', async () => {
  const trace = createNodePerformanceTrace({ component: 'core', enabled: true, limit: 4 });
  assert.equal(trace.startMonitoring(), true);
  await new Promise((resolve) => setTimeout(resolve, 45));
  trace.sample();
  const snapshot = trace.recorder.snapshot();
  assert.equal(snapshot.events.length, 1);
  assert.equal(Number.isFinite(snapshot.events[0]!.metrics.eventLoopDelayMeanMs), true);
  assert.equal(Number.isFinite(snapshot.gauges.rssBytes), true);
  trace.dispose();
  trace.sample();
  assert.equal(trace.recorder.snapshot().events.length, 1);
  assert.equal(trace.isMonitoring(), false);
});

test('未显式 dispose 的 unref 采样器和 perf_hooks 不延长独立 Node 进程寿命', () => {
  const moduleUrl = new URL('../src/diagnostics/performance-trace.ts', import.meta.url).href;
  const script = `import { createNodePerformanceTrace } from ${JSON.stringify(moduleUrl)}; const trace = createNodePerformanceTrace({ component: 'core', enabled: true, monitorEventLoop: true }); if (!trace.isMonitoring()) process.exitCode = 1;`;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: process.cwd(), timeout: 3_000, encoding: 'utf8',
    // 继承调用环境：本机由外置构建入口约束，hosted CI 使用 runner 临时目录。
    env: { ...process.env },
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
});

test('并发异步调用链保持各自身份，嵌套请求结束后恢复外层上下文', async () => {
  const recorder = new PerformanceTraceRecorder({ component: 'core', enabled: true });
  const first = recorder.context()!, second = recorder.context()!;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const observed: PerformanceTraceContext[] = [];
  const slow = withPerformanceContext(recorder, first, async () => {
    await gate;
    observed.push(currentPerformanceContext()!.context);
    const child = recorder.childContext(first)!;
    await withPerformanceContext(recorder, child, async () => {
      await Promise.resolve();
      assert.deepEqual(currentPerformanceContext()!.context, child);
    });
    assert.deepEqual(currentPerformanceContext()!.context, first);
  });
  const fast = withPerformanceContext(recorder, second, async () => {
    await Promise.resolve();
    const current = currentPerformanceContext()!;
    assert.equal(current.recorder, recorder);
    observed.push(current.context);
    current.context.traceId = '只改副本';
    assert.deepEqual(currentPerformanceContext()!.context, second);
    release!();
  });
  await Promise.all([slow, fast]);
  assert.equal(observed[0]!.requestId, second.requestId);
  assert.equal(observed[1]!.requestId, first.requestId);
  assert.equal(currentPerformanceContext(), undefined);
  recorder.dispose();
});

test('关闭或无效身份不读输入且不继承外层身份，业务异常原样透传', () => {
  const enabled = new PerformanceTraceRecorder({ component: 'core', enabled: true });
  const disabled = new PerformanceTraceRecorder({ component: 'core' });
  const parent = enabled.context()!;
  let read = 0;
  const unsafe = Object.defineProperty({}, 'traceId', { get() { read++; throw new Error('合成访问器'); } }) as PerformanceTraceContext;
  withPerformanceContext(enabled, parent, () => {
    assert.equal(withPerformanceContext(disabled, unsafe, () => currentPerformanceContext()), undefined);
    assert.equal(withPerformanceContext(enabled, undefined, () => currentPerformanceContext()), undefined);
    assert.deepEqual(currentPerformanceContext()!.context, parent);
    const businessError = new Error('合成业务失败');
    assert.throws(() => withPerformanceContext(enabled, parent, () => { throw businessError; }), (error) => error === businessError);
  });
  assert.equal(read, 0);
  assert.equal(currentPerformanceContext(), undefined);
  enabled.dispose();
});
