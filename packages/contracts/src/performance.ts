import { IPC_COMMANDS, IPC_EVENTS, type IpcCommand, type IpcEvent } from './ipc-names.js';

export const PERFORMANCE_SCHEMA_VERSION = 1 as const;
export const PERFORMANCE_RING_LIMIT = 512;
export const PERFORMANCE_MAX_INFLIGHT = 128;

export const PERFORMANCE_OPERATIONS = [
  'lifecycle', 'ipc', 'library', 'provider', 'sql', 'queue', 'event', 'render',
  'playback', 'cancellation', 'event-loop',
] as const;
export const PERFORMANCE_PHASES = [
  'instant', 'start', 'end', 'cancel', 'sample',
  'bootstrap-start', 'data-prepared', 'core-spawn', 'core-ready-received',
  'onready-complete', 'supervisor-ready', 'core-exit', 'ui-loaded', 'before-quit',
  'remote-stop-start', 'remote-stop-end', 'core-shutdown-start', 'core-shutdown-end',
  'outbox-close-start', 'outbox-close-end', 'outbox-close-timeout',
  'app-quit-reissued', 'will-quit',
  'renderer-click', 'main-received', 'core-received', 'metadata-ready',
  'stream-url-ready', 'gateway-preflight-ready', 'roon-session-began', 'roon-playing',
  'first-render', 'page-ready', 'queue-ready', 'queue-enter', 'queue-start',
  'provider-dispatch', 'provider-response', 'response-sent',
] as const;
export const PERFORMANCE_COUNTERS = [
  'sqlCount', 'providerCallCount', 'pageCount', 'rowCount', 'eventCount',
  'estimatedBytes', 'cancellationCount', 'completedCount', 'failedCount',
  'cancelledCount', 'cancelResidualMs', 'queueWaitMs', 'providerDurationMs',
  'sqlDurationMs', 'renderDurationMs',
] as const;
export const PERFORMANCE_GAUGES = [
  'queueItemCount', 'listenerCount', 'timerCount', 'rssBytes', 'heapUsedBytes',
  'eventLoopDelayMeanMs', 'eventLoopDelayP95Ms', 'eventLoopDelayMaxMs',
  'eventLoopUtilization', 'activeRequestCount',
] as const;

export type PerformanceComponent = 'main' | 'core' | 'renderer';
export type PerformanceOperation = (typeof PERFORMANCE_OPERATIONS)[number];
export type PerformancePhase = (typeof PERFORMANCE_PHASES)[number];
export type PerformanceCounter = (typeof PERFORMANCE_COUNTERS)[number];
export type PerformanceGauge = (typeof PERFORMANCE_GAUGES)[number];
export type PerformanceOutcome = 'ok' | 'error' | 'cancelled';
export type PerformanceMetrics = Partial<Record<PerformanceCounter | PerformanceGauge, number>>;

/** 身份只允许随机 UUID；不能用曲目、账号、路径或 Provider 令牌作为关联身份。 */
export interface PerformanceTraceContext {
  traceId: string;
  requestId: string;
  parentRequestId?: string;
}

export interface PerformanceLabels {
  command?: IpcCommand;
  eventName?: IpcEvent;
}

export interface PerformanceTraceEvent extends PerformanceLabels {
  sequence: number;
  component: PerformanceComponent;
  clockId: string;
  atMs: number;
  operation: PerformanceOperation;
  phase: PerformancePhase;
  context?: PerformanceTraceContext;
  durationMs?: number;
  outcome?: PerformanceOutcome;
  metrics: PerformanceMetrics;
}

export interface PerformanceTraceSnapshot {
  schemaVersion: typeof PERFORMANCE_SCHEMA_VERSION;
  component: PerformanceComponent;
  /** atMs/durationMs 仅属于此时钟；禁止跨 clockId 相减。 */
  clock: { kind: 'process-monotonic'; id?: string };
  enabled: boolean;
  disposed: boolean;
  limit: number;
  maxInflight: number;
  overwrittenEventCount: number;
  droppedSpanCount: number;
  inflightCount: number;
  cancelResidualCount: number;
  counters: Record<PerformanceCounter, number>;
  gauges: Partial<Record<PerformanceGauge, number>>;
  events: readonly PerformanceTraceEvent[];
}

export interface PerformanceSpan {
  readonly context: PerformanceTraceContext | undefined;
  add(metrics: PerformanceMetrics): void;
  cancel(): void;
  end(outcome?: PerformanceOutcome, metrics?: PerformanceMetrics): void;
}

export interface PerformanceTraceOptions {
  component: PerformanceComponent;
  enabled?: boolean;
  limit?: number;
  maxInflight?: number;
  now?: () => number;
  id?: () => string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const operations: ReadonlySet<string> = new Set(PERFORMANCE_OPERATIONS);
const phases: ReadonlySet<string> = new Set(PERFORMANCE_PHASES);
const commands: ReadonlySet<string> = new Set(IPC_COMMANDS);
const eventNames: ReadonlySet<string> = new Set(IPC_EVENTS);
const counters: ReadonlySet<string> = new Set(PERFORMANCE_COUNTERS);
const gauges: ReadonlySet<string> = new Set(PERFORMANCE_GAUGES);
const metricKeys = [...PERFORMANCE_COUNTERS, ...PERFORMANCE_GAUGES];

function uuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function copyMetrics(input: PerformanceMetrics): PerformanceMetrics {
  const output: PerformanceMetrics = {};
  for (const key of metricKeys) {
    const value = input[key];
    if (finite(value) && (key !== 'eventLoopUtilization' || value <= 1)) output[key] = value;
  }
  return output;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** 不运行 IPC 输入上的 getter，也不读取未知字段。 */
function field(input: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor) return undefined;
  if (!('value' in descriptor)) throw new Error('诊断数据不接受访问器');
  return descriptor.value;
}

export function copyPerformanceTraceContext(value: unknown): PerformanceTraceContext | undefined {
  try {
    const input = object(value);
    if (!input) return undefined;
    const traceId = field(input, 'traceId'), requestId = field(input, 'requestId'), parentRequestId = field(input, 'parentRequestId');
    if (!uuid(traceId) || !uuid(requestId) || (parentRequestId !== undefined && !uuid(parentRequestId))) return undefined;
    return { traceId, requestId, ...(parentRequestId === undefined ? {} : { parentRequestId }) };
  } catch { return undefined; }
}

export function isPerformanceTraceContext(value: unknown): value is PerformanceTraceContext {
  return copyPerformanceTraceContext(value) !== undefined;
}

const copyContext = copyPerformanceTraceContext;

function copyLabels(input: PerformanceLabels): PerformanceLabels {
  const record = object(input);
  if (!record) return {};
  const command = field(record, 'command'), eventName = field(record, 'eventName');
  return {
    ...(typeof command === 'string' && commands.has(command) ? { command: command as IpcCommand } : {}),
    ...(typeof eventName === 'string' && eventNames.has(eventName) ? { eventName: eventName as IpcEvent } : {}),
  };
}

function copyEvent(input: PerformanceTraceEvent): PerformanceTraceEvent {
  return { ...input, ...(input.context ? { context: { ...input.context } } : {}), metrics: { ...input.metrics } };
}

function zeroCounters(): Record<PerformanceCounter, number> {
  return Object.fromEntries(PERFORMANCE_COUNTERS.map((key) => [key, 0])) as Record<PerformanceCounter, number>;
}

/** 诊断 IPC 的不可信输入只能通过此函数复制后导出；未知字段一律不进入结果。 */
export function copyPerformanceTraceSnapshot(value: unknown): PerformanceTraceSnapshot | undefined {
  try {
    const input = object(value);
    if (!input || field(input, 'schemaVersion') !== PERFORMANCE_SCHEMA_VERSION) return undefined;
    const component = field(input, 'component');
    if (component !== 'main' && component !== 'core' && component !== 'renderer') return undefined;
    const enabled = field(input, 'enabled'), disposed = field(input, 'disposed');
    if (typeof enabled !== 'boolean' || typeof disposed !== 'boolean' || (enabled && disposed)) return undefined;
    const clockInput = object(field(input, 'clock'));
    if (!clockInput || field(clockInput, 'kind') !== 'process-monotonic') return undefined;
    const clockId = field(clockInput, 'id');
    if (clockId !== undefined && !uuid(clockId)) return undefined;
    const limit = field(input, 'limit'), maxInflight = field(input, 'maxInflight');
    if (!finite(limit) || !Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) return undefined;
    if (!finite(maxInflight) || !Number.isSafeInteger(maxInflight) || maxInflight < 1 || maxInflight > 10_000) return undefined;
    const overwrittenEventCount = field(input, 'overwrittenEventCount'), droppedSpanCount = field(input, 'droppedSpanCount');
    const inflightCount = field(input, 'inflightCount'), cancelResidualCount = field(input, 'cancelResidualCount');
    for (const count of [overwrittenEventCount, droppedSpanCount, inflightCount, cancelResidualCount]) {
      if (!finite(count) || !Number.isSafeInteger(count)) return undefined;
    }
    if ((inflightCount as number) > maxInflight || (cancelResidualCount as number) > (inflightCount as number)) return undefined;
    const counterInput = object(field(input, 'counters')), gaugeInput = object(field(input, 'gauges'));
    if (!counterInput || !gaugeInput) return undefined;
    const safeCounters = zeroCounters();
    const safeGauges: Partial<Record<PerformanceGauge, number>> = {};
    for (const key of PERFORMANCE_COUNTERS) {
      const counter = field(counterInput, key);
      if (!finite(counter)) return undefined;
      safeCounters[key] = counter;
    }
    for (const key of PERFORMANCE_GAUGES) {
      const gauge = field(gaugeInput, key);
      if (gauge === undefined) continue;
      if (!finite(gauge) || (key === 'eventLoopUtilization' && gauge > 1)) return undefined;
      safeGauges[key] = gauge;
    }
    const eventInput = field(input, 'events');
    // 超界输入直接拒绝，不复制或遍历超出合同容量的队列。
    if (!Array.isArray(eventInput) || eventInput.length > limit) return undefined;
    if (eventInput.length > 0 && clockId === undefined) return undefined;
    const events: PerformanceTraceEvent[] = [];
    let lastSequence = 0, lastAt = 0;
    for (let index = 0; index < eventInput.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(eventInput, String(index));
      if (!descriptor || !('value' in descriptor)) return undefined;
      const entry = object(descriptor.value);
      if (!entry || field(entry, 'component') !== component || field(entry, 'clockId') !== clockId) return undefined;
      const sequence = field(entry, 'sequence'), atMs = field(entry, 'atMs');
      const operation = field(entry, 'operation'), phase = field(entry, 'phase');
      if (!finite(sequence) || !Number.isSafeInteger(sequence) || sequence <= lastSequence || !finite(atMs) || atMs < lastAt) return undefined;
      if (typeof operation !== 'string' || !operations.has(operation) || typeof phase !== 'string' || !phases.has(phase)) return undefined;
      const durationMs = field(entry, 'durationMs'), outcome = field(entry, 'outcome');
      if (durationMs !== undefined && !finite(durationMs)) return undefined;
      if (outcome !== undefined && outcome !== 'ok' && outcome !== 'error' && outcome !== 'cancelled') return undefined;
      const contextInput = field(entry, 'context'), context = copyContext(contextInput);
      if (contextInput !== undefined && !context) return undefined;
      const metricsInput = object(field(entry, 'metrics'));
      if (!metricsInput) return undefined;
      const metrics: PerformanceMetrics = {};
      for (const key of metricKeys) {
        const metric = field(metricsInput, key);
        if (metric === undefined) continue;
        if (!finite(metric) || (key === 'eventLoopUtilization' && metric > 1)) return undefined;
        metrics[key] = metric;
      }
      const command = field(entry, 'command'), eventName = field(entry, 'eventName');
      if (command !== undefined && (typeof command !== 'string' || !commands.has(command))) return undefined;
      if (eventName !== undefined && (typeof eventName !== 'string' || !eventNames.has(eventName))) return undefined;
      events.push({
        sequence, component, clockId: clockId as string, atMs,
        operation: operation as PerformanceOperation, phase: phase as PerformancePhase,
        ...(durationMs === undefined ? {} : { durationMs }), ...(outcome === undefined ? {} : { outcome }),
        ...(context ? { context } : {}), metrics,
        ...(command === undefined ? {} : { command: command as IpcCommand }),
        ...(eventName === undefined ? {} : { eventName: eventName as IpcEvent }),
      });
      lastSequence = sequence;
      lastAt = atMs;
    }
    return {
      schemaVersion: PERFORMANCE_SCHEMA_VERSION, component,
      clock: { kind: 'process-monotonic', ...(clockId === undefined ? {} : { id: clockId }) },
      enabled, disposed, limit, maxInflight,
      overwrittenEventCount: overwrittenEventCount as number, droppedSpanCount: droppedSpanCount as number,
      inflightCount: inflightCount as number, cancelResidualCount: cancelResidualCount as number,
      counters: safeCounters, gauges: safeGauges, events,
    };
  } catch { return undefined; }
}

export function isPerformanceTraceSnapshot(value: unknown): value is PerformanceTraceSnapshot {
  return copyPerformanceTraceSnapshot(value) !== undefined;
}

const NO_SPAN: PerformanceSpan = Object.freeze({
  context: undefined,
  add: () => undefined,
  cancel: () => undefined,
  end: () => undefined,
});

interface ActiveSpan {
  startedAt: number;
  cancelledAt?: number;
  context: PerformanceTraceContext;
  operation: PerformanceOperation;
  labels: PerformanceLabels;
  metrics: PerformanceMetrics;
}

/** 固定容量、常数成本记录；只有 snapshot/export 才复制或序列化整个 ring。 */
export class PerformanceTraceRecorder {
  private readonly component: PerformanceComponent;
  private readonly limit: number;
  private readonly maxInflight: number;
  private readonly now: () => number;
  private readonly id: () => string;
  private readonly ring: (PerformanceTraceEvent | undefined)[];
  private readonly active = new Map<symbol, ActiveSpan>();
  private totals = zeroCounters();
  private latest: Partial<Record<PerformanceGauge, number>> = {};
  private cursor = 0;
  private size = 0;
  private sequence = 0;
  private overwrittenEventCount = 0;
  private droppedSpanCount = 0;
  private clockId: string | undefined;
  private origin: number | undefined;
  private lastTime = 0;
  private enabled = false;
  private disposed = false;

  constructor(options: PerformanceTraceOptions) {
    this.component = ['main', 'core', 'renderer'].includes(options.component) ? options.component : 'core';
    const limit = options.limit ?? PERFORMANCE_RING_LIMIT;
    const maxInflight = options.maxInflight ?? PERFORMANCE_MAX_INFLIGHT;
    this.limit = Number.isSafeInteger(limit) && limit >= 1 && limit <= 10_000 ? limit : PERFORMANCE_RING_LIMIT;
    this.maxInflight = Number.isSafeInteger(maxInflight) && maxInflight >= 1 && maxInflight <= 10_000 ? maxInflight : PERFORMANCE_MAX_INFLIGHT;
    this.now = options.now ?? (() => globalThis.performance.now());
    this.id = options.id ?? (() => globalThis.crypto.randomUUID());
    this.ring = new Array(this.limit);
    this.setEnabled(options.enabled ?? false);
  }

  isEnabled(): boolean { return this.enabled && !this.disposed; }

  setEnabled(enabled: boolean): void {
    if (this.disposed) return;
    this.enabled = enabled === true;
    if (!this.enabled) this.active.clear();
  }

  context(input: Partial<PerformanceTraceContext> = {}): PerformanceTraceContext | undefined {
    if (!this.isEnabled()) return undefined;
    try {
      const traceId = input.traceId ?? this.id();
      const requestId = input.requestId ?? this.id();
      return copyContext({ traceId, requestId, ...(input.parentRequestId === undefined ? {} : { parentRequestId: input.parentRequestId }) });
    } catch { return undefined; }
  }

  childContext(parent: PerformanceTraceContext): PerformanceTraceContext | undefined {
    if (!this.isEnabled()) return undefined;
    try {
      const safe = copyContext(parent);
      return safe ? this.context({ traceId: safe.traceId, parentRequestId: safe.requestId }) : undefined;
    } catch { return undefined; }
  }

  private time(): number | undefined {
    try {
      const value = this.now();
      if (!finite(value)) return undefined;
      if (this.origin === undefined) {
        const clockId = this.id();
        if (!uuid(clockId)) return undefined;
        this.origin = value;
        this.clockId = clockId;
      }
      const elapsed = value - this.origin;
      if (!finite(elapsed) || elapsed < this.lastTime) return undefined;
      this.lastTime = elapsed;
      return elapsed;
    } catch { return undefined; }
  }

  private append(input: Omit<PerformanceTraceEvent, 'sequence' | 'component' | 'clockId'>): void {
    if (!this.clockId) return;
    this.ring[this.cursor] = { ...input, component: this.component, clockId: this.clockId, sequence: ++this.sequence };
    this.cursor = (this.cursor + 1) % this.limit;
    if (this.size < this.limit) this.size++;
    else this.overwrittenEventCount++;
  }

  private account(input: PerformanceMetrics): void {
    for (const key of PERFORMANCE_COUNTERS) {
      const value = input[key];
      if (value !== undefined) this.totals[key] = Math.min(Number.MAX_SAFE_INTEGER, this.totals[key] + value);
    }
    for (const key of PERFORMANCE_GAUGES) if (input[key] !== undefined) this.latest[key] = input[key];
  }

  increment(counter: PerformanceCounter, amount = 1): void {
    if (!this.isEnabled() || !counters.has(counter) || !finite(amount)) return;
    this.account({ [counter]: amount });
  }

  setGauge(gauge: PerformanceGauge, value: number): void {
    if (!this.isEnabled() || !gauges.has(gauge) || !finite(value) || (gauge === 'eventLoopUtilization' && value > 1)) return;
    this.latest[gauge] = value;
  }

  mark(operation: PerformanceOperation, phase: PerformancePhase, context?: PerformanceTraceContext, metrics: PerformanceMetrics = {}, labels: PerformanceLabels = {}): void {
    if (!this.isEnabled() || !operations.has(operation) || !phases.has(phase)) return;
    try {
      const safeContext = copyContext(context);
      if (context !== undefined && !safeContext) return;
      const safeMetrics = copyMetrics(metrics);
      const safeLabels = copyLabels(labels);
      const atMs = this.time();
      if (atMs === undefined) return;
      this.account(safeMetrics);
      this.append({ operation, phase, atMs, ...(safeContext ? { context: safeContext } : {}), metrics: safeMetrics, ...safeLabels });
    } catch { /* 观测输入或时钟异常不能影响业务。 */ }
  }

  start(operation: PerformanceOperation, context?: PerformanceTraceContext, metrics: PerformanceMetrics = {}, labels: PerformanceLabels = {}): PerformanceSpan {
    if (!this.isEnabled() || !operations.has(operation)) return NO_SPAN;
    if (this.active.size >= this.maxInflight) { this.droppedSpanCount++; return NO_SPAN; }
    try {
      const safeContext = context === undefined ? this.context() : copyContext(context);
      if (!safeContext) return NO_SPAN;
      const safeMetrics = copyMetrics(metrics);
      const safeLabels = copyLabels(labels);
      const atMs = this.time();
      if (atMs === undefined) return NO_SPAN;
      const key = Symbol();
      const span: ActiveSpan = { operation, context: safeContext, startedAt: atMs, metrics: safeMetrics, labels: safeLabels };
      this.active.set(key, span);
      this.account(safeMetrics);
      this.append({ operation, phase: 'start', atMs, context: { ...safeContext }, metrics: { ...safeMetrics }, ...safeLabels });
      const active = (): boolean => this.isEnabled() && this.active.get(key) === span;
      const add = (input: PerformanceMetrics): void => {
        if (!active()) return;
        try {
          const values = copyMetrics(input);
          this.account(values);
          for (const metric of metricKeys) {
            const value = values[metric];
            if (value !== undefined) span.metrics[metric] = counters.has(metric)
              ? Math.min(Number.MAX_SAFE_INTEGER, (span.metrics[metric] ?? 0) + value) : value;
          }
        } catch { /* 观测不能改变业务。 */ }
      };
      return {
        context: { ...safeContext },
        add,
        cancel: () => {
          if (!active() || span.cancelledAt !== undefined) return;
          const now = this.time();
          if (now === undefined) return;
          span.cancelledAt = now;
          this.increment('cancellationCount');
          this.append({ operation, phase: 'cancel', atMs: now, context: { ...safeContext }, durationMs: now - atMs, metrics: {}, ...safeLabels });
        },
        end: (outcome = 'ok', input = {}) => {
          if (!active()) return;
          if (!['ok', 'error', 'cancelled'].includes(outcome)) return;
          add(input);
          const now = this.time();
          // 时钟失效仍要释放 slot，不能让观测残留成为业务内存泄漏。
          this.active.delete(key);
          this.increment('completedCount');
          if (outcome === 'error') this.increment('failedCount');
          if (outcome === 'cancelled') this.increment('cancelledCount');
          if (now === undefined) return;
          if (span.cancelledAt !== undefined) {
            const residual = now - span.cancelledAt;
            this.increment('cancelResidualMs', residual);
            span.metrics.cancelResidualMs = residual;
          }
          this.append({ operation, phase: 'end', atMs: now, context: { ...safeContext }, durationMs: now - atMs, outcome, metrics: { ...span.metrics }, ...safeLabels });
        },
      };
    } catch { return NO_SPAN; }
  }

  snapshot(): PerformanceTraceSnapshot {
    const events: PerformanceTraceEvent[] = [];
    const first = (this.cursor - this.size + this.limit) % this.limit;
    for (let index = 0; index < this.size; index++) {
      const event = this.ring[(first + index) % this.limit];
      if (event) events.push(copyEvent(event));
    }
    let cancelResidualCount = 0;
    for (const span of this.active.values()) if (span.cancelledAt !== undefined) cancelResidualCount++;
    return {
      schemaVersion: PERFORMANCE_SCHEMA_VERSION, component: this.component,
      clock: { kind: 'process-monotonic', ...(this.clockId ? { id: this.clockId } : {}) },
      enabled: this.isEnabled(), disposed: this.disposed, limit: this.limit, maxInflight: this.maxInflight,
      overwrittenEventCount: this.overwrittenEventCount, droppedSpanCount: this.droppedSpanCount,
      inflightCount: this.active.size, cancelResidualCount, counters: { ...this.totals }, gauges: { ...this.latest }, events,
    };
  }

  export(): string { return JSON.stringify(this.snapshot()); }

  dispose(): void {
    this.enabled = false;
    this.disposed = true;
    this.active.clear();
  }
}
