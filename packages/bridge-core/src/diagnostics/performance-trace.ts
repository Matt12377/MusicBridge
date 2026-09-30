import { monitorEventLoopDelay, performance, type EventLoopUtilization } from 'node:perf_hooks';
import { AsyncLocalStorage } from 'node:async_hooks';

import {
  PerformanceTraceRecorder,
  copyPerformanceTraceContext,
  type PerformanceTraceContext,
  type PerformanceTraceOptions,
  type PerformanceMetrics,
} from '@music-bridge/contracts';

export interface ActivePerformanceContext {
  recorder: PerformanceTraceRecorder;
  context: PerformanceTraceContext;
}

const requestContext = new AsyncLocalStorage<ActivePerformanceContext>();

/** 诊断时钟失效只使耗时未知，不阻止原业务继续或落定。 */
export function readPerformanceTime(): number | undefined {
  try {
    const value = performance.now();
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  } catch { return undefined; }
}

/** 异步请求隔离身份；不包装或替换业务 Promise 的错误。 */
export function withPerformanceContext<T>(recorder: PerformanceTraceRecorder, context: PerformanceTraceContext | undefined, operation: () => T): T {
  if (!recorder.isEnabled()) return requestContext.exit(operation);
  const safe = copyPerformanceTraceContext(context);
  if (!safe) return requestContext.exit(operation);
  return requestContext.run({ recorder, context: safe }, operation);
}

export function currentPerformanceContext(): ActivePerformanceContext | undefined {
  const current = requestContext.getStore();
  if (!current?.recorder.isEnabled()) return undefined;
  return { recorder: current.recorder, context: { ...current.context } };
}

export interface PerformanceEventLoopHistogram {
  readonly count: number;
  readonly mean: number;
  readonly max: number;
  percentile(value: number): number;
  reset(): void;
  enable(): unknown;
  disable(): unknown;
}

export interface PerformanceSampleTimer { unref(): unknown }

/** 可注入合成监测器；生产默认使用 perf_hooks，不接触业务数据。 */
export interface NodePerformanceDependencies {
  histogram(resolution: number): PerformanceEventLoopHistogram;
  timer(callback: () => void, intervalMs: number): PerformanceSampleTimer;
  clearTimer(timer: PerformanceSampleTimer): void;
  utilization(current?: EventLoopUtilization, previous?: EventLoopUtilization): EventLoopUtilization;
  memory(): { rss: number; heapUsed: number };
}

export interface NodePerformanceTraceOptions extends PerformanceTraceOptions {
  monitorEventLoop?: boolean;
  resolutionMs?: number;
  sampleIntervalMs?: number;
  dependencies?: NodePerformanceDependencies;
}

const defaultDependencies: NodePerformanceDependencies = {
  histogram: (resolution) => monitorEventLoopDelay({ resolution }),
  timer: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearTimer: (timer) => clearInterval(timer as NodeJS.Timeout),
  utilization: (current, previous) => performance.eventLoopUtilization(current, previous),
  memory: () => process.memoryUsage(),
};

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
}

/** 采样 timer 不保活；histogram 与 timer 均只在明确启用时创建，关闭及退出时释放。 */
export function createNodePerformanceTrace(options: NodePerformanceTraceOptions) {
  const recorder = new PerformanceTraceRecorder(options);
  const dependencies = options.dependencies ?? defaultDependencies;
  const resolution = bounded(options.resolutionMs, 20, 1, 1_000);
  const interval = bounded(options.sampleIntervalMs, 1_000, 100, 60_000);
  let histogram: PerformanceEventLoopHistogram | undefined;
  let timer: PerformanceSampleTimer | undefined;
  let previousUtilization: EventLoopUtilization | undefined;
  let disposed = false;

  const stopMonitoring = (): void => {
    const oldTimer = timer;
    const oldHistogram = histogram;
    timer = undefined;
    histogram = undefined;
    previousUtilization = undefined;
    try { if (oldTimer) dependencies.clearTimer(oldTimer); } catch { /* 关闭诊断不能阻断退出。 */ }
    try { oldHistogram?.disable(); } catch { /* 不泄露内部错误。 */ }
  };

  const sample = (): void => {
    if (disposed || !recorder.isEnabled()) { stopMonitoring(); return; }
    if (!histogram) return;
    try {
      const metrics: PerformanceMetrics = {};
      // 未采到样本时 mean 是 NaN；不将空窗口伪装成零延迟。
      if (histogram.count > 0) {
        metrics.eventLoopDelayMeanMs = histogram.mean / 1_000_000;
        metrics.eventLoopDelayP95Ms = histogram.percentile(95) / 1_000_000;
        metrics.eventLoopDelayMaxMs = histogram.max / 1_000_000;
      }
      const current = dependencies.utilization();
      if (previousUtilization) metrics.eventLoopUtilization = dependencies.utilization(current, previousUtilization).utilization;
      previousUtilization = current;
      const memory = dependencies.memory();
      metrics.rssBytes = memory.rss;
      metrics.heapUsedBytes = memory.heapUsed;
      recorder.mark('event-loop', 'sample', undefined, metrics);
      histogram.reset();
    } catch { /* 诊断异常不能改变业务调度。 */ }
  };

  const startMonitoring = (): boolean => {
    if (disposed || !recorder.isEnabled()) return false;
    if (histogram && timer) return true;
    try {
      histogram = dependencies.histogram(resolution);
      histogram.enable();
      previousUtilization = dependencies.utilization();
      timer = dependencies.timer(sample, interval);
      timer.unref();
      return true;
    } catch {
      stopMonitoring();
      return false;
    }
  };

  const setEnabled = (enabled: boolean): void => {
    recorder.setEnabled(enabled);
    if (!recorder.isEnabled()) stopMonitoring();
    else if (options.monitorEventLoop) startMonitoring();
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    stopMonitoring();
    recorder.dispose();
  };

  if (options.monitorEventLoop) startMonitoring();
  return { recorder, startMonitoring, stopMonitoring, sample, setEnabled, dispose,
    isMonitoring: (): boolean => histogram !== undefined && timer !== undefined };
}
