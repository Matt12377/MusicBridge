import { AsyncLocalStorage } from 'node:async_hooks';
import { types } from 'node:util';
import { copyMobileCapabilityTraceRecord, copyMobileCapabilityTraceSnapshot, selectMobileCapabilityTraceBranchDetails,
  snapshotMobileCapabilityTrace, type MobileCapabilityTraceRecord } from './capability-trace.js';

export const MOBILE_OWNER_LOAD_TRACE_TYPE = 'mobile-owner-load-trace' as const;
export const MOBILE_OWNER_LOAD_TRACE_PREFIX = 'MUSICBRIDGE_MOBILE_OWNER_LOAD_TRACE ';
export const MOBILE_OWNER_LOAD_TRACE_LIMITS = Object.freeze({ requests: 8, records: 64, ordinaryRecords: 40, bytes: 64 * 1024, recordBytes: 1024 });
export const MOBILE_OWNER_LOAD_TRACE_STAGES = [
  'http.receive', 'http.dispatch', 'http.capture', 'http.failure', 'http.before-send.alive', 'http.terminal',
  'main.auth', 'main.initial-qualification', 'main.encode', 'main.before-send.qualification', 'main.before-send.auth',
  'main.content.initialize', 'main.content.scope',
  'main.admission', 'main.post', 'main.timeout', 'main.receive', 'main.capture', 'main.close',
  'core.receive', 'core.capture', 'core.owner', 'core.result', 'core.post', 'core.close',
  'owner.client.post', 'owner.client.receive', 'owner.client.capture',
  'owner.receive', 'owner.dispatch', 'owner.load', 'owner.reply', 'owner.post', 'cleanup',
] as const;
export type MobileOwnerLoadTraceStage = typeof MOBILE_OWNER_LOAD_TRACE_STAGES[number];
export type MobileOwnerLoadTraceComponent = 'main' | 'core' | 'owner';
export type MobileOwnerLoadTraceRole = 'business' | 'cleanup';
const outcomes = ['begin', 'ok', 'error', 'not-sent', 'unknown', 'timeout', 'invalid', 'post-failed', 'closed', 'aborted'] as const;
export type MobileOwnerLoadTraceOutcome = typeof outcomes[number];
const statuses = [200, 201, 204, 400, 401, 403, 404, 409, 410, 413, 429, 503] as const;
export interface MobileOwnerLoadTraceCounts { readonly records: number; readonly bytes: number; readonly suppressed: number }
export interface MobileOwnerLoadTraceHttp {
  readonly status: typeof statuses[number] | null;
  readonly aborted: boolean;
  readonly headersSent: boolean;
  readonly writableFinished: boolean;
  /** Main的累计预算使用量，包含本行；不是对端收到响应的证明。 */
  readonly counts?: MobileOwnerLoadTraceCounts;
}
export interface MobileOwnerLoadTraceEvent {
  readonly ordinal: number;
  readonly component: MobileOwnerLoadTraceComponent;
  readonly stage: MobileOwnerLoadTraceStage;
  readonly outcome: MobileOwnerLoadTraceOutcome;
  readonly role: MobileOwnerLoadTraceRole;
  /** 时钟不可用时明确为null，不伪造时间或影响原工作。 */
  readonly atMs: number | null;
  readonly durationMs: number | null;
  readonly http?: MobileOwnerLoadTraceHttp;
}
export interface MobileOwnerLoadTraceFrame { readonly type: typeof MOBILE_OWNER_LOAD_TRACE_TYPE; readonly event: MobileOwnerLoadTraceEvent }
export interface MobileOwnerLoadCapabilityFrame { readonly type: 'mobile-owner-load-capability'; readonly ordinal: number; readonly record: MobileCapabilityTraceRecord }
export interface MobileOwnerLoadTraceContext { readonly ordinal: number; readonly emit: (event: Readonly<MobileOwnerLoadTraceEvent>) => void }
export interface MobileOwnerLoadTraceClock { now?: () => number; epochNow?: () => number }
const counterMaximum = 2_147_483_647;
const integer = (value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const nullableTime = (value: unknown): value is number | null => value === null || integer(value);
const choice = <T extends string>(value: unknown, values: readonly T[]): value is T => typeof value === 'string' && values.includes(value as T);

/** 先拒绝代理和任何额外键，再读取自有数据描述符；访问器不会被执行。 */
function dataRecord(raw: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> | null {
  try {
    if (!raw || typeof raw !== 'object' || types.isProxy(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return null;
    const keys = Reflect.ownKeys(raw);
    if (keys.length < required.length || keys.length > required.length + optional.length
      || keys.some(key => typeof key !== 'string' || !required.includes(key) && !optional.includes(key))) return null;
    const descriptors = Object.getOwnPropertyDescriptors(raw), result: Record<string, unknown> = Object.create(null);
    if (required.some(key => !Object.hasOwn(descriptors, key))) return null;
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      result[key] = descriptor.value;
    }
    return result;
  } catch { return null; }
}
function copyHttp(raw: unknown): MobileOwnerLoadTraceHttp | null {
  const value = dataRecord(raw, ['status', 'aborted', 'headersSent', 'writableFinished'], ['counts']);
  if (!value || value.status !== null && !statuses.includes(value.status as typeof statuses[number])
    || typeof value.aborted !== 'boolean' || typeof value.headersSent !== 'boolean' || typeof value.writableFinished !== 'boolean') return null;
  let counts: MobileOwnerLoadTraceCounts | undefined;
  if (Object.hasOwn(value, 'counts')) {
    const checked = dataRecord(value.counts, ['records', 'bytes', 'suppressed']);
    if (!checked || !integer(checked.records, MOBILE_OWNER_LOAD_TRACE_LIMITS.records)
      || !integer(checked.bytes, MOBILE_OWNER_LOAD_TRACE_LIMITS.bytes) || !integer(checked.suppressed, counterMaximum)) return null;
    counts = Object.freeze({ records: checked.records, bytes: checked.bytes, suppressed: checked.suppressed });
  }
  return Object.freeze({ status: value.status as MobileOwnerLoadTraceHttp['status'], aborted: value.aborted,
    headersSent: value.headersSent, writableFinished: value.writableFinished, ...(counts ? { counts } : {}) });
}
/** 校验不登记授权，也不读取或重放业务；原RPC身份只能由原pending检查。 */
export function copyMobileOwnerLoadTraceFrame(raw: unknown): MobileOwnerLoadTraceFrame | null {
  try {
  const frame = dataRecord(raw, ['type', 'event']);
  if (!frame || frame.type !== MOBILE_OWNER_LOAD_TRACE_TYPE) return null;
  const event = dataRecord(frame.event, ['ordinal', 'component', 'stage', 'outcome', 'role', 'atMs', 'durationMs'], ['http']);
  if (!event || !integer(event.ordinal, MOBILE_OWNER_LOAD_TRACE_LIMITS.requests) || event.ordinal < 1
    || !choice(event.component, ['main', 'core', 'owner']) || !choice(event.stage, MOBILE_OWNER_LOAD_TRACE_STAGES)
    || !choice(event.outcome, outcomes) || !choice(event.role, ['business', 'cleanup'])
    || !nullableTime(event.atMs) || !nullableTime(event.durationMs)) return null;
  const terminal = event.stage === 'http.terminal';
  if (terminal !== Object.hasOwn(event, 'http') || terminal && (event.component !== 'main' || event.role !== 'business')) return null;
  const http = terminal ? copyHttp(event.http) : undefined;
  if (terminal && !http) return null;
  return Object.freeze({ type: MOBILE_OWNER_LOAD_TRACE_TYPE, event: Object.freeze({ ordinal: event.ordinal,
    component: event.component, stage: event.stage, outcome: event.outcome, role: event.role, atMs: event.atMs,
    durationMs: event.durationMs, ...(http ? { http } : {}) }) });
  } catch { return null; }
}
export function isMobileOwnerLoadTraceFrame(raw: unknown): raw is MobileOwnerLoadTraceFrame { return copyMobileOwnerLoadTraceFrame(raw) !== null; }
/** 新旁注只复制原闭集安全record；不改旧trace帧校验，也不接纳代理、访问器或额外字段。 */
export function copyMobileOwnerLoadCapabilityFrame(raw: unknown): MobileOwnerLoadCapabilityFrame | null {
  try {
    const frame = dataRecord(raw, ['type', 'ordinal', 'record']);
    if (!frame || frame.type !== 'mobile-owner-load-capability'
      || !integer(frame.ordinal, MOBILE_OWNER_LOAD_TRACE_LIMITS.requests) || frame.ordinal < 1) return null;
    const record = copyMobileCapabilityTraceRecord(frame.record); if (!record) return null;
    return Object.freeze({ type: 'mobile-owner-load-capability', ordinal: frame.ordinal, record });
  } catch { return null; }
}

interface ContextState { now: () => number; epochNow: () => number; lastNow: number | null; lastAt: number | null; origin: number | null }
interface Point { now: number | null; atMs: number | null }
const storage = new AsyncLocalStorage<MobileOwnerLoadTraceContext>();
const contexts = new WeakMap<MobileOwnerLoadTraceContext, ContextState>();
function discardPromise(value: unknown): void {
  try { if (types.isPromise(value)) Promise.prototype.then.call(value, () => undefined, () => undefined); } catch { /* 诊断sink的异常不成为业务异常。 */ }
}
export function createMobileOwnerLoadTraceContext(ordinal: number, emit: MobileOwnerLoadTraceContext['emit'], clock: MobileOwnerLoadTraceClock = {}): MobileOwnerLoadTraceContext | undefined {
  try {
    if (!integer(ordinal, MOBILE_OWNER_LOAD_TRACE_LIMITS.requests) || ordinal < 1 || typeof emit !== 'function') return undefined;
    const now = clock.now ?? (() => performance.now()), epochNow = clock.epochNow ?? (() => Date.now());
    if (typeof now !== 'function' || typeof epochNow !== 'function') return undefined;
    const context = Object.freeze({ ordinal, emit });
    contexts.set(context, { now, epochNow, lastNow: null, lastAt: null, origin: null }); return context;
  } catch { return undefined; }
}
export function captureMobileOwnerLoadTrace(): MobileOwnerLoadTraceContext | undefined { try { return storage.getStore(); } catch { return undefined; } }
/** ALS或sink失效也不重新执行工作；保留同步返回、原Promise和原异常的身份。 */
export function withMobileOwnerLoadTrace<T>(context: MobileOwnerLoadTraceContext | undefined, work: () => T): T {
  if (!context || !contexts.has(context)) return work();
  let result: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
  const once = (): T => {
    if (result) { if (result.ok) return result.value; throw result.error; }
    try { const value = work(); result = { ok: true, value }; return value; }
    catch (error) { result = { ok: false, error }; throw error; }
  };
  try { return storage.run(context, once); } catch { return once(); }
}
function point(context: MobileOwnerLoadTraceContext): Point {
  const state = contexts.get(context); let now: number | null = null, atMs: number | null = null;
  if (!state) return { now, atMs };
  try {
    const value = state.now();
    if (Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER && (state.lastNow === null || value >= state.lastNow)) {
      now = value; state.lastNow = value; state.origin ??= value;
    }
  } catch { /* 用null标明时钟缺失，不改原工作。 */ }
  try {
    const value = state.epochNow();
    if (integer(value) && (state.lastAt === null || value >= state.lastAt)) { atMs = value; state.lastAt = value; }
  } catch { /* 墙钟与单调钟分别核验。 */ }
  return { now, atMs };
}
const elapsed = (start: number | null, end: number | null): number | null => start !== null && end !== null && end >= start && integer(Math.floor(end - start)) ? Math.floor(end - start) : null;
function emit(context: MobileOwnerLoadTraceContext, component: MobileOwnerLoadTraceComponent, stage: MobileOwnerLoadTraceStage,
  outcome: MobileOwnerLoadTraceOutcome, role: MobileOwnerLoadTraceRole, at: Point, durationMs: number | null, http?: MobileOwnerLoadTraceHttp): void {
  try {
    const frame = copyMobileOwnerLoadTraceFrame({ type: MOBILE_OWNER_LOAD_TRACE_TYPE, event: { ordinal: context.ordinal,
      component, stage, outcome, role, atMs: at.atMs, durationMs, ...(http === undefined ? {} : { http }) } });
    if (frame) discardPromise(context.emit(frame.event));
  } catch { /* 旁注最多丢失自身，不替换业务结果。 */ }
}
export function markMobileOwnerLoadTrace(component: MobileOwnerLoadTraceComponent, stage: MobileOwnerLoadTraceStage,
  outcome: MobileOwnerLoadTraceOutcome = 'ok', role: MobileOwnerLoadTraceRole = 'business', http?: MobileOwnerLoadTraceHttp): void {
  const context = captureMobileOwnerLoadTrace(); if (!context) return;
  const at = point(context), origin = contexts.get(context)?.origin ?? null;
  emit(context, component, stage, outcome, role, at, stage === 'http.terminal' ? elapsed(origin, at.now) : null, http);
}
function failureOutcome(error: unknown): MobileOwnerLoadTraceOutcome {
  try {
    if (error && typeof error === 'object' && !types.isProxy(error)) {
      const descriptors = Object.getOwnPropertyDescriptors(error), outcome = descriptors.outcome, code = descriptors.code;
      if (outcome && Object.hasOwn(outcome, 'value') && (outcome.value === 'not-sent' || outcome.value === 'unknown')) return outcome.value;
      if (code && Object.hasOwn(code, 'value')) {
        if (code.value === 'TIMEOUT') return 'timeout';
        if (code.value === 'INVALID_IPC_RESPONSE' || code.value === 'INVALID_IPC_REQUEST') return 'invalid';
        if (code.value === 'ABORT_ERR') return 'aborted';
      }
    }
  } catch { /* 不读异常message、stack或访问器。 */ }
  return 'error';
}
/** 只旁观原生Promise，不读取或同化任意thenable；返回值及拒绝原因均保持原身份。 */
export function observeMobileOwnerLoadTrace<T>(component: MobileOwnerLoadTraceComponent, stage: MobileOwnerLoadTraceStage,
  work: () => T, role: MobileOwnerLoadTraceRole = 'business'): T {
  const context = captureMobileOwnerLoadTrace(); if (!context) return work();
  const start = point(context); emit(context, component, stage, 'begin', role, start, start.now === null ? null : 0);
  const finish = (outcome: MobileOwnerLoadTraceOutcome): void => { const end = point(context); emit(context, component, stage, outcome, role, end, elapsed(start.now, end.now)); };
  let value: T;
  try { value = work(); } catch (error) { finish(failureOutcome(error)); throw error; }
  try {
    if (types.isPromise(value)) {
      try { discardPromise(Promise.prototype.then.call(value, () => finish('ok'), (error: unknown) => finish(failureOutcome(error)))); }
      catch { /* 无法挂旁观回调时不假报成功，也不重新调用工作。 */ }
      return value;
    }
  } catch { return value; }
  finish('ok'); return value;
}

export interface MobileOwnerLoadTraceProbeOptions extends MobileOwnerLoadTraceClock { enabled?: boolean; sink?: (line: string) => void }
export interface MobileOwnerLoadTraceProbeSnapshot extends MobileOwnerLoadTraceCounts { readonly enabled: boolean; readonly claimed: number; readonly ordinaryRecords: number }
export type MobileOwnerLoadTraceProbe = ReturnType<typeof createMobileOwnerLoadTraceProbe>;
/** 不改原阶段的执行及计时，只压缩重复成功行；失败仍交给原保留槽处理。 */
function keepOrdinarySuccess(event: MobileOwnerLoadTraceEvent): boolean {
  const { component, stage, outcome } = event;
  if (component === 'main') {
    if (stage === 'http.receive' || stage === 'http.dispatch' || stage === 'main.auth'
      || stage === 'http.before-send.alive' || stage === 'main.before-send.auth') return true;
    if (stage === 'main.initial-qualification' || stage === 'main.before-send.qualification'
      || stage === 'main.content.initialize' || stage === 'main.content.scope' || stage === 'main.post') return outcome === 'begin';
    return (stage === 'main.encode' || stage === 'main.capture') && outcome === 'ok';
  }
  if (component === 'core') return stage === 'owner.client.post' ? outcome === 'begin'
    : (stage === 'core.receive' || stage === 'core.post') && outcome === 'ok';
  return stage === 'owner.load' || stage === 'owner.receive' && outcome === 'ok';
}
/** 只有Main持有collector。40普通槽+每请求首业务失败/首cleanup失败/HTTP终态各8槽。 */
export function createMobileOwnerLoadTraceProbe(options: MobileOwnerLoadTraceProbeOptions = {}) {
  let enabled = false, sink: (line: string) => void = () => {}, clock: MobileOwnerLoadTraceClock = {};
  try {
    enabled = options.enabled === true;
    if (options.sink !== undefined) { if (typeof options.sink !== 'function') enabled = false; else sink = options.sink; }
    clock = { ...(options.now ? { now: options.now } : {}), ...(options.epochNow ? { epochNow: options.epochNow } : {}) };
  } catch { enabled = false; }
  const claims = new Map<number, { business: boolean; cleanup: boolean; terminal: boolean }>();
  const capabilityRoots = new Map<number, string>(), capabilityPublished = new Set<string>();
  const capabilityOmitted = new Map<number, number>();
  let capabilitySourceDropped = 0;
  let records = 0, bytes = 0, ordinaryRecords = 0, suppressed = 0;
  const suppress = (count = 1) => { suppressed = Math.min(counterMaximum, suppressed + count); };
  function accept(raw: unknown): boolean {
    if (!enabled) return false;
    const checked = copyMobileOwnerLoadTraceFrame(raw), row = checked ? claims.get(checked.event.ordinal) : undefined;
    if (!checked || !row) { suppress(); return false; }
    const event = checked.event, terminal = event.stage === 'http.terminal';
    const failure = event.outcome !== 'begin' && event.outcome !== 'ok';
    if (!terminal && !failure && !keepOrdinarySuccess(event)) { suppress(); return false; }
    const firstFailure = !terminal && failure && !row[event.role];
    // 已绑定分支时只分配28个普通槽给HTTP；原首错/cleanup/terminal槽和总预算不变。
    const ordinaryLimit = capabilityRoots.size ? MOBILE_OWNER_LOAD_TRACE_LIMITS.ordinaryRecords - 12 : MOBILE_OWNER_LOAD_TRACE_LIMITS.ordinaryRecords;
    if (terminal && row.terminal || !terminal && !firstFailure && ordinaryRecords >= ordinaryLimit) { suppress(); return false; }
    let line = '', length = 0;
    try {
      let frame = checked;
      if (terminal) {
        // bytes包含本终态行，十进制位数变化以有限不动点计算，不重复发送快照。
        let total = bytes;
        for (let turn = 0; turn < 8; turn++) {
          frame = { type: MOBILE_OWNER_LOAD_TRACE_TYPE, event: { ...event, http: { ...event.http!, counts: { records: records + 1, bytes: total, suppressed } } } };
          line = MOBILE_OWNER_LOAD_TRACE_PREFIX + JSON.stringify(frame) + '\n'; length = Buffer.byteLength(line);
          if (total === bytes + length) break;
          total = bytes + length;
        }
        if (frame.event.http?.counts?.bytes !== bytes + length) { suppress(); return false; }
      } else { line = MOBILE_OWNER_LOAD_TRACE_PREFIX + JSON.stringify(frame) + '\n'; length = Buffer.byteLength(line); }
    } catch { suppress(); return false; }
    if (length > MOBILE_OWNER_LOAD_TRACE_LIMITS.recordBytes || records >= MOBILE_OWNER_LOAD_TRACE_LIMITS.records || bytes + length > MOBILE_OWNER_LOAD_TRACE_LIMITS.bytes) { suppress(); return false; }
    // sink可能抛错或重入；先占用有界槽位，不能因输出失败反复重发原事件。
    records++; bytes += length;
    if (terminal) row.terminal = true; else if (firstFailure) row[event.role] = true; else ordinaryRecords++;
    try { discardPromise(sink(line)); } catch { suppress(); }
    return true;
  }
  function acceptCapability(ordinal: number, record: MobileCapabilityTraceRecord, mode: 'http' | 'close'): void {
    const frame = copyMobileOwnerLoadCapabilityFrame({ type: 'mobile-owner-load-capability', ordinal, record });
    const claim = frame ? claims.get(ordinal) : undefined;
    if (!frame || !claim || !capabilityRoots.has(ordinal)) { suppress(); return; }
    let line: string;
    try { line = MOBILE_OWNER_LOAD_TRACE_PREFIX + JSON.stringify(frame) + '\n'; } catch { suppress(); return; }
    if (capabilityPublished.has(line)) return;
    const firstFailure = record.phase === 'reject' && !claim[record.role];
    const length = Buffer.byteLength(line);
    const ordinaryLimit = MOBILE_OWNER_LOAD_TRACE_LIMITS.ordinaryRecords - (mode === 'http' ? 12 : 0);
    if (!firstFailure && ordinaryRecords >= ordinaryLimit
      || length > MOBILE_OWNER_LOAD_TRACE_LIMITS.recordBytes || records >= MOBILE_OWNER_LOAD_TRACE_LIMITS.records
      || bytes + length > MOBILE_OWNER_LOAD_TRACE_LIMITS.bytes) { suppress(); return; }
    // 两类帧共用原计数与失败保留槽；先占位去重，sink抛错或重入也不能补发。
    capabilityPublished.add(line); records++; bytes += length;
    if (firstFailure) claim[record.role] = true; else ordinaryRecords++;
    try { discardPromise(sink(line)); } catch { suppress(); }
  }
  return {
    claim(): MobileOwnerLoadTraceContext | undefined {
      if (!enabled) return undefined;
      if (claims.size >= MOBILE_OWNER_LOAD_TRACE_LIMITS.requests) { suppress(); return undefined; }
      const ordinal = claims.size + 1;
      const context = createMobileOwnerLoadTraceContext(ordinal, event => { accept({ type: MOBILE_OWNER_LOAD_TRACE_TYPE, event }); }, clock);
      if (!context) { suppress(); return undefined; }
      claims.set(ordinal, { business: false, cleanup: false, terminal: false }); return context;
    },
    accept,
    bindCapability(ordinal: number, rootSha256: string): boolean {
      if (!enabled) return false;
      if (!integer(ordinal, MOBILE_OWNER_LOAD_TRACE_LIMITS.requests) || ordinal < 1 || !claims.has(ordinal)
        || typeof rootSha256 !== 'string' || rootSha256.length !== 64 || !/^[a-f0-9]{64}$/u.test(rootSha256)) { suppress(); return false; }
      const previous = capabilityRoots.get(ordinal);
      if (previous !== undefined) { if (previous === rootSha256) return true; suppress(); return false; }
      if ([...capabilityRoots.values()].includes(rootSha256)) { suppress(); return false; }
      capabilityRoots.set(ordinal, rootSha256); return true;
    },
    publishCapabilities(mode: 'http' | 'close' = 'http'): void {
      if (!enabled || !capabilityRoots.size) return;
      if (mode !== 'http' && mode !== 'close') { suppress(); return; }
      try {
        const snapshot = copyMobileCapabilityTraceSnapshot(snapshotMobileCapabilityTrace());
        if (!snapshot) { suppress(); return; }
        if (snapshot.droppedRecords > capabilitySourceDropped) suppress(snapshot.droppedRecords - capabilitySourceDropped);
        capabilitySourceDropped = Math.max(capabilitySourceDropped, snapshot.droppedRecords);
        const candidates: { ordinal: number; record: MobileCapabilityTraceRecord; index: number; priority: number }[] = [];
        for (const [ordinal, root] of capabilityRoots) {
          const selected = selectMobileCapabilityTraceBranchDetails(snapshot, root, mode), previous = capabilityOmitted.get(ordinal) ?? 0;
          if (selected.omittedRecords > previous) suppress(selected.omittedRecords - previous);
          capabilityOmitted.set(ordinal, Math.max(previous, selected.omittedRecords));
          for (const record of selected.records) candidates.push({ ordinal, record, index: candidates.length,
            priority: mode === 'close' && record.component === 'main' && record.stage.startsWith('main.close.')
              ? record.phase === 'reject' ? 0 : 1 : 2 });
        }
        // 最多8×64条候选；跨HTTP分支也先发布关闭旁注，旧分支不能先吃掉保留的12槽。
        candidates.sort((left, right) => left.priority - right.priority || left.index - right.index);
        for (const candidate of candidates) acceptCapability(candidate.ordinal, candidate.record, mode);
      } catch { suppress(); }
    },
    snapshot(): Readonly<MobileOwnerLoadTraceProbeSnapshot> { return Object.freeze({ enabled, claimed: claims.size, records, bytes, ordinaryRecords, suppressed }); },
  };
}
