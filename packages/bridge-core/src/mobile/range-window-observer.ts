import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { types } from 'node:util';

const SCHEMA = 'mb.mobile-range-window.v1' as const;
export const MOBILE_RANGE_WINDOW_STAGES = ['http.arrival', 'http.abort', 'http.terminal',
  'main.open.task', 'main.open.queue', 'main.open.execute', 'auth.queue', 'auth.execute', 'auth.owner-load.composite',
  'source.verify.composite', 'source.read.composite', 'source.read.authority.before', 'source.read.authority.after',
  'read.authority.before', 'read.authority.after', 'content.rpc.composite', 'content.rpc.retained', 'reader.close', 'reader.close.wait',
  'cleanup.close-read.composite', 'sender.initial-authority', 'sender.before-write-authority', 'sender.read', 'sender.write',
  'sender.close', 'sender.close.wait', 'sender.failure'] as const;
export type MobileRangeWindowStage = typeof MOBILE_RANGE_WINDOW_STAGES[number];
type Role = 'business' | 'cleanup';
const kinds = ['none', 'getMediaAsset', 'headMediaAsset', 'createResource', 'createSession', 'deleteResource', 'deleteSession',
  'control-other', 'expire', 'auth-current', 'auth-device', 'auth-other', 'read', 'verify', 'close-read', 'source', 'cancel'] as const;
type Kind = typeof kinds[number];
const codes = ['NONE', 'UNKNOWN', 'ABORTED', 'BUSY', 'SOURCE_CHANGED', 'RESOURCE_BUSY', 'RESOURCE_RELEASED', 'RESOURCE_REVOKED',
  'TICKET_EXPIRED', 'TICKET_REVOKED', 'UNAUTHORIZED', 'DEVICE_REVOKED', 'INVALID_REQUEST', 'TIMEOUT', 'RELEASE_TIMEOUT',
  'RELEASE_FAILED', 'PEER_CLOSED', 'ESTABLISH_TIMEOUT', 'IDLE_TIMEOUT', 'READER_FAILED', 'WRITE_FAILED', 'ABORT_ERR', 'SERVICE_RESTARTED'] as const;
type Code = typeof codes[number];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const MAX_REQUESTS = 8, MAX_RECORDS = 64, COUNTER_MAX = 2_147_483_647;
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const choice = <T extends string>(v: unknown, values: readonly T[]): v is T => typeof v === 'string' && values.includes(v as T);
const bump = (n: number): number => Math.min(COUNTER_MAX, n + 1);
function closed(v: unknown, keys: readonly string[]): v is Record<string, unknown> {
  try {
    if (!v || typeof v !== 'object' || types.isProxy(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return false;
    const d = Object.getOwnPropertyDescriptors(v);
    return Reflect.ownKeys(d).length === keys.length && keys.every(k => d[k]?.enumerable === true && Object.hasOwn(d[k]!, 'value'));
  } catch { return false; }
}
const kindOf = (v: string): Kind => choice(v, kinds) ? v : 'control-other';
function safeCode(error: unknown): Code {
  try {
    if (error && typeof error === 'object' && !types.isProxy(error)) {
      const d = Object.getOwnPropertyDescriptor(error, 'code');
      if (d && Object.hasOwn(d, 'value') && choice(d.value, codes) && d.value !== 'NONE') return d.value;
    }
  } catch { /* 不读取异常正文或访问器。 */ }
  return 'UNKNOWN';
}
export interface MobileRangeWindowRecord {
  stage: MobileRangeWindowStage; role: Role; phase: 'pending' | 'ok' | 'reject' | 'event';
  atMs: number | null; durationMs: number | null; code: Code; kind: Kind; predecessorKind: Kind;
  queueAhead: number; nonceSha256: string | null; count: number; settledCount: number; pendingCount: number; maxDurationMs: number | null;
  occupantKind: Kind; occupantElapsedMs: number | null; predecessorDurationMs: number | null; predecessorAgeMs: number | null;
}
interface RequestSnapshot {
  ordinal: number; requestSha256: string; epochMs: number | null; offset: number; length: 262144;
  httpTerminal: boolean; httpStatus: number | null; responseFinished: boolean; aborted: boolean;
  pendingSpans: number; clockFault: boolean; droppedRecords: number;
  firstBusinessFailure: MobileRangeWindowRecord | null; firstCleanupFailure: MobileRangeWindowRecord | null;
  records: MobileRangeWindowRecord[];
}
export interface MobileRangeWindowSnapshot {
  schema: typeof SCHEMA; enabled: boolean; ownerDetail: 'not-observable-current-channel';
  maxRequests: 8; maxRecordsPerRequest: 64; maxRecords: 512; maxSerializedBytes: 262144;
  overflowRequests: number; ineligibleRequests: number; malformedFrames: number; unmatchedFrames: number;
  observerFaults: number; clockFaults: number; truncated: boolean; requests: RequestSnapshot[];
}
export interface MobileRangeWindowContext { readonly requestSha256: string; readonly ordinal: number }
interface Context extends MobileRangeWindowContext { state: State; row: RequestSnapshot; origin: number | null; last: number | null; aggregates: Map<string, MobileRangeWindowRecord>; aggregateErrors: Map<string, Code>; terminalRole: Role }
interface Lane { pending: number; active: Kind; previous: Kind; activeSince: number | null; previousDurationMs: number | null; previousSettled: number | null }
interface State {
  snapshot: MobileRangeWindowSnapshot; contexts: Set<Context>; lanes: Record<'open' | 'auth', Lane>;
  now: () => number; epochNow: () => number; sink?: (record: Readonly<MobileRangeWindowRecord>) => void;
}
interface Span { context: Context; row: MobileRangeWindowRecord; started: number | null; done: boolean; retained: boolean; summary?: MobileRangeWindowRecord }
const storage = new AsyncLocalStorage<Context>();
let processState: State | undefined;
const fault = (s: State): void => { s.snapshot.observerFaults = bump(s.snapshot.observerFaults); };
function clock(c: Context): number | null {
  try {
    const n = c.state.now();
    if (!Number.isFinite(n) || n < 0 || n > Number.MAX_SAFE_INTEGER || c.last !== null && n < c.last) throw new Error();
    c.last = n; return n;
  } catch { c.row.clockFault = true; c.state.snapshot.clockFaults = bump(c.state.snapshot.clockFaults); return null; }
}
function retain(c: Context, row: MobileRangeWindowRecord): boolean {
  if (c.row.records.length >= MAX_RECORDS) { c.row.droppedRecords = bump(c.row.droppedRecords); return false; }
  c.row.records.push(row); return true;
}
function publish(c: Context, row: MobileRangeWindowRecord): void {
  try { c.state.sink?.(Object.freeze({ ...row })); } catch { fault(c.state); }
}
function begin(c: Context | undefined, stage: MobileRangeWindowStage, role: Role, kind = 'none', nonceSha256: string | null = null,
  predecessorKind: Kind = 'none', queueAhead = 0): Span | undefined {
  try {
    if (!c) return undefined;
    const n = clock(c);
    const row: MobileRangeWindowRecord = { stage, role, phase: 'pending', atMs: n === null || c.origin === null ? null : Math.floor(n - c.origin),
      durationMs: null, code: 'NONE', kind: kindOf(kind), predecessorKind, queueAhead, nonceSha256, count: 1, settledCount: 0, pendingCount: 1, maxDurationMs: null,
      occupantKind: predecessorKind, occupantElapsedMs: null, predecessorDurationMs: null, predecessorAgeMs: null };
    c.row.pendingSpans = bump(c.row.pendingSpans);
    const aggregate = ['auth.queue', 'auth.execute', 'auth.owner-load.composite', 'read.authority.before', 'read.authority.after',
      'source.read.authority.before', 'source.read.authority.after', 'sender.read', 'sender.write', 'sender.before-write-authority'].includes(stage);
    if (aggregate) {
      const key = stage + ':' + row.kind, previous = c.aggregates.get(key);
      if (previous) { previous.count = bump(previous.count); previous.pendingCount = bump(previous.pendingCount); previous.phase = 'pending'; previous.code = 'NONE';
        return { context: c, row, started: n, done: false, retained: false, summary: previous }; }
      const summary = { ...row }; c.aggregates.set(key, summary);
      return { context: c, row, started: n, done: false, retained: retain(c, summary), summary };
    }
    return { context: c, row, started: n, done: false, retained: retain(c, row) };
  } catch { if (c) fault(c.state); return undefined; }
}
function end(span: Span | undefined, rejected = false, error?: unknown, explicitCode?: Code): void {
  try {
    if (!span || span.done) return; span.done = true;
    const c = span.context, n = clock(c), row = span.row;
    c.row.pendingSpans = Math.max(0, c.row.pendingSpans - 1);
    row.settledCount = 1; row.pendingCount = 0;
    row.phase = rejected ? 'reject' : 'ok'; row.code = rejected ? explicitCode ?? safeCode(error) : 'NONE';
    row.durationMs = n === null || span.started === null ? null : Math.floor(n - span.started);
    row.maxDurationMs = row.durationMs;
    if (rejected) {
      const key = row.role === 'business' ? 'firstBusinessFailure' : 'firstCleanupFailure';
      if (c.row[key] === null) c.row[key] = { ...row };
    }
    if (span.summary) {
      const summary = span.summary, first = summary.settledCount === 0;
      summary.settledCount = bump(summary.settledCount); summary.pendingCount = Math.max(0, summary.pendingCount - 1);
      summary.durationMs = row.durationMs === null || !first && summary.durationMs === null ? null : (summary.durationMs ?? 0) + row.durationMs;
      if (summary.durationMs !== null && !Number.isSafeInteger(summary.durationMs)) { summary.durationMs = null; c.row.clockFault = true; c.state.snapshot.clockFaults = bump(c.state.snapshot.clockFaults); }
      summary.maxDurationMs = row.durationMs === null ? summary.maxDurationMs : Math.max(summary.maxDurationMs ?? 0, row.durationMs);
      if (first || (row.durationMs ?? -1) >= (summary.maxDurationMs ?? 0)) {
        summary.predecessorKind = row.predecessorKind; summary.queueAhead = row.queueAhead;
        summary.occupantKind = row.occupantKind; summary.occupantElapsedMs = row.occupantElapsedMs;
        summary.predecessorDurationMs = row.predecessorDurationMs; summary.predecessorAgeMs = row.predecessorAgeMs;
      }
      const key = summary.stage + ':' + summary.kind;
      if (rejected && !c.aggregateErrors.has(key)) c.aggregateErrors.set(key, row.code);
      summary.phase = summary.pendingCount > 0 ? 'pending' : c.aggregateErrors.has(key) ? 'reject' : 'ok';
      summary.code = summary.phase === 'reject' ? c.aggregateErrors.get(key)! : 'NONE';
      publish(c, summary);
    } else if (span.retained) publish(c, row);
  } catch { if (span) fault(span.context.state); }
}
function event(c: Context | undefined, stage: MobileRangeWindowStage): void {
  const span = begin(c, stage, 'business'); if (!span) return;
  end(span); span.row.phase = 'event';
}
/** 原sender捕获点明确区分业务与清理；不根据HTTP终态倒猜来源。 */
export function mobileRangeWindowFailure(error: unknown, role: Role): void {
  const c = storage.getStore(); if (!c) return;
  c.terminalRole = role; end(begin(c, 'sender.failure', role), true, error);
}
export const mobileRangeWindowCapture = (): MobileRangeWindowContext | undefined => storage.getStore();
/** ALS失效也不重复原工作。进程正常构建未安装probe时直接走原函数。 */
export function withMobileRangeWindowContext<T>(input: MobileRangeWindowContext | undefined, work: () => T): T {
  if (!input) return work();
  const c = input as Context; if (!c.state.contexts.has(c)) return work();
  let result: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
  const once = (): T => {
    if (result) { if (result.ok) return result.value; throw result.error; }
    try { const value = work(); result = { ok: true, value }; return value; }
    catch (error) { result = { ok: false, error }; throw error; }
  };
  try { return storage.run(c, once); } catch { if (!result) fault(c.state); return once(); }
}
/** 只在原后台timer创建点退出range ALS；memo-once保持原返回、异常与执行次数。 */
export function withoutMobileRangeWindowContext<T>(work: () => T): T {
  let current: Context | undefined;
  try { current = storage.getStore(); } catch { /* 无可用旁注上下文时执行原work。 */ }
  if (!current) return work();
  let result: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
  const once = (): T => {
    if (result) { if (result.ok) return result.value; throw result.error; }
    try { const value = work(); result = { ok: true, value }; return value; }
    catch (error) { result = { ok: false, error }; throw error; }
  };
  try { return storage.exit(once); } catch { return once(); }
}
/** 附加旁注后仍返回原Promise；HTTP取消不会替原任务结算。 */
export function mobileRangeWindowObserve<T>(stage: MobileRangeWindowStage, work: () => Promise<T>, role: Role = 'business', kind = 'none'): Promise<T> {
  const c = storage.getStore(); if (!c) return work();
  const span = begin(c, stage, role, kind);
  try { const original = work();
    try { void original.then(() => end(span), error => end(span, true, error)); } catch { fault(c.state); }
    return original; }
  catch (error) { end(span, true, error); throw error; }
}
export function mobileRangeWindowSync<T>(stage: MobileRangeWindowStage, work: () => T, role: Role = 'business', kind = 'none'): T {
  const c = storage.getStore(); if (!c) return work();
  const span = begin(c, stage, role, kind);
  try { const original = work(); end(span); return original; } catch (error) { end(span, true, error); throw error; }
}
/** 所有原tail任务仅更新固定lane的闭集标量；只有选中HTTP保留记录，包含正常预取占用。 */
export function mobileRangeWindowQueued<T>(laneName: 'open' | 'auth', kind: string, work: () => T): () => T {
  const c = storage.getStore(), state = c?.state ?? processState;
  if (!state?.snapshot.enabled) return work;
  const lane = state.lanes[laneName], mapped = kindOf(kind), ahead = Math.min(COUNTER_MAX, lane.pending + (lane.active === 'none' ? 0 : 1));
  const queued = begin(c, laneName === 'open' ? 'main.open.queue' : 'auth.queue', 'business', mapped, null, lane.active, ahead);
  if (queued) {
    const at = clock(queued.context);
    queued.row.occupantElapsedMs = at === null || lane.activeSince === null ? null : Math.max(0, Math.floor(at - lane.activeSince));
  }
  lane.pending = bump(lane.pending);
  return () => {
    lane.pending = Math.max(0, lane.pending - 1);
    let began: number | null = null;
    try { const n = state.now(); if (Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER) began = n; else throw new Error(); } catch { if (c) { c.row.clockFault = true; state.snapshot.clockFaults = bump(state.snapshot.clockFaults); } }
    if (queued) { queued.row.predecessorKind = lane.previous; queued.row.predecessorDurationMs = lane.previousDurationMs;
      queued.row.predecessorAgeMs = began === null || lane.previousSettled === null ? null : Math.max(0, Math.floor(began - lane.previousSettled)); }
    end(queued); lane.active = mapped; lane.activeSince = began;
    const executing = begin(c, laneName === 'open' ? 'main.open.execute' : 'auth.execute', 'business', mapped);
    const settled = (rejected = false, error?: unknown): void => {
      let at: number | null = null; try { const n = state.now(); if (Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER) at = n; else throw new Error(); } catch { if (c) { c.row.clockFault = true; state.snapshot.clockFaults = bump(state.snapshot.clockFaults); } }
      lane.active = 'none'; lane.previous = mapped; lane.activeSince = null; lane.previousSettled = at;
      lane.previousDurationMs = at === null || began === null || at < began ? null : Math.floor(at - began);
      end(executing, rejected, error);
    };
    try {
      const result = work();
      if (result instanceof Promise) void result.then(() => settled(), error => settled(true, error)); else settled();
      return result;
    } catch (error) { settled(true, error); throw error; }
  };
}
/** 仅Main内部原RPC回包旁注，不是新增IPC帧，也不代表Core/Owner物理quiet。 */
export function mobileRangeWindowRpc(nonce: string, kind = 'source', role: Role = 'business', stage: 'content.rpc.composite' | 'content.rpc.retained' = 'content.rpc.composite') {
  const c = storage.getStore(); if (!c) return undefined;
  let expected: string;
  try {
    if (!UUID.test(nonce)) { c.state.snapshot.malformedFrames = bump(c.state.snapshot.malformedFrames); return undefined; }
    expected = createHash('sha256').update('MusicBridge:range-window:content:1\0' + nonce).digest('hex');
  } catch { fault(c.state); return undefined; }
  const span = begin(c, stage, role, kind, expected);
  const acceptFrame = (raw: unknown): void => {
    try {
      if (!closed(raw, ['nonce', 'phase', 'code']) || typeof raw.nonce !== 'string' || !UUID.test(raw.nonce)
        || !choice(raw.phase, ['ok', 'reject']) || !choice(raw.code, codes) || (raw.phase === 'ok') !== (raw.code === 'NONE')) {
        c.state.snapshot.malformedFrames = bump(c.state.snapshot.malformedFrames); return;
      }
      const actual = createHash('sha256').update('MusicBridge:range-window:content:1\0' + raw.nonce).digest('hex');
      if (actual !== expected || span?.done) { c.state.snapshot.unmatchedFrames = bump(c.state.snapshot.unmatchedFrames); return; }
      end(span, raw.phase === 'reject', undefined, raw.code);
    } catch { fault(c.state); }
  };
  return { acceptFrame, malformed() { c.state.snapshot.malformedFrames = bump(c.state.snapshot.malformedFrames); }, settle(id: string, rejected = false, error?: unknown) { acceptFrame({ nonce: id, phase: rejected ? 'reject' : 'ok', code: rejected ? safeCode(error) : 'NONE' }); } };
}
export function createMobileRangeWindowProbe(options: { enabled?: boolean; now?: () => number; epochNow?: () => number;
  sink?: (record: Readonly<MobileRangeWindowRecord>) => void } = {}) {
  const snapshot: MobileRangeWindowSnapshot = { schema: SCHEMA, enabled: options.enabled === true, ownerDetail: 'not-observable-current-channel',
    maxRequests: 8, maxRecordsPerRequest: 64, maxRecords: 512, maxSerializedBytes: 262144, overflowRequests: 0, ineligibleRequests: 0,
    malformedFrames: 0, unmatchedFrames: 0, observerFaults: 0, clockFaults: 0, truncated: false, requests: [] };
  const state: State = { snapshot, contexts: new Set(), now: options.now ?? (() => performance.now()), epochNow: options.epochNow ?? Date.now,
    lanes: { open: { pending: 0, active: 'none', previous: 'none', activeSince: null, previousDurationMs: null, previousSettled: null }, auth: { pending: 0, active: 'none', previous: 'none', activeSince: null, previousDurationMs: null, previousSettled: null } },
    ...(options.sink ? { sink: options.sink } : {}) };
  if (snapshot.enabled) processState = state;
  return {
    markArrival(): { monotonicMs: number | null; epochMs: number | null } {
      let monotonicMs: number | null = null, epochMs: number | null = null;
      try { const n = state.now(); if (!Number.isFinite(n) || n < 0 || n > Number.MAX_SAFE_INTEGER) throw new Error(); monotonicMs = n; } catch { snapshot.clockFaults = bump(snapshot.clockFaults); }
      try { const n = state.epochNow(); if (!integer(n)) throw new Error(); epochMs = n; } catch { snapshot.clockFaults = bump(snapshot.clockFaults); }
      return { monotonicMs, epochMs };
    },
    claim(input: { arrival?: { monotonicMs: number | null; epochMs: number | null }; requestId: string; method: string; operation: string; range?: string | undefined; ifRange?: string | undefined }): MobileRangeWindowContext | undefined {
      if (!snapshot.enabled) return undefined;
      try {
        if (input.method !== 'GET' || input.operation !== 'getMediaAsset' || input.ifRange !== undefined || !UUID.test(input.requestId)) {
          snapshot.ineligibleRequests = bump(snapshot.ineligibleRequests); return undefined;
        }
        const match = typeof input.range === 'string' && /^bytes=(0|[1-9][0-9]*)-(0|[1-9][0-9]*)$/u.exec(input.range);
        const offset = match ? Number(match[1]) : -1, endOffset = match ? Number(match[2]) : -1;
        if (!integer(offset) || !integer(endOffset) || endOffset - offset + 1 !== 262144) {
          snapshot.ineligibleRequests = bump(snapshot.ineligibleRequests); return undefined;
        }
        if (snapshot.requests.length >= MAX_REQUESTS) { snapshot.overflowRequests = bump(snapshot.overflowRequests); return undefined; }
        const requestSha256 = createHash('sha256').update('MusicBridge:range-window:http:1\0' + input.requestId).digest('hex');
        if (snapshot.requests.some(r => r.requestSha256 === requestSha256)) { snapshot.unmatchedFrames = bump(snapshot.unmatchedFrames); return undefined; }
        const row: RequestSnapshot = { ordinal: snapshot.requests.length + 1, requestSha256, epochMs: null, offset, length: 262144,
          httpTerminal: false, httpStatus: null, responseFinished: false, aborted: false, pendingSpans: 0, clockFault: false, droppedRecords: 0,
          firstBusinessFailure: null, firstCleanupFailure: null, records: [] };
        const c: Context = { state, row, requestSha256, ordinal: row.ordinal, origin: null, last: null, aggregates: new Map(), aggregateErrors: new Map(), terminalRole: 'business' };
        c.origin = input.arrival ? input.arrival.monotonicMs : clock(c); c.last = c.origin;
        if (c.origin === null) row.clockFault = true;
        try { const epoch = input.arrival ? input.arrival.epochMs : state.epochNow(); if (!integer(epoch)) throw new Error(); row.epochMs = epoch; }
        catch { row.clockFault = true; snapshot.clockFaults = bump(snapshot.clockFaults); }
        state.contexts.add(c); snapshot.requests.push(row);
        const arrival = begin(c, 'http.arrival', 'business'); if (arrival) { end(arrival); arrival.row.phase = 'event'; arrival.row.atMs = c.origin === null ? null : 0; arrival.row.durationMs = c.origin === null || arrival.started === null ? null : 0; arrival.row.maxDurationMs = arrival.row.durationMs; }
        return c;
      } catch { fault(state); return undefined; }
    },
    abort(input: MobileRangeWindowContext | undefined): void {
      const c = input as Context | undefined; if (!c || !state.contexts.has(c) || c.row.aborted) return;
      c.row.aborted = true; event(c, 'http.abort');
    },
    finish(input: MobileRangeWindowContext | undefined, result: { status: number | null; finished: boolean; failed: boolean; error?: unknown }): void {
      try {
        const c = input as Context | undefined; if (!c || !state.contexts.has(c) || c.row.httpTerminal) return;
        c.row.httpTerminal = true; c.row.httpStatus = result.status; c.row.responseFinished = result.finished;
        const span = begin(c, 'http.terminal', c.terminalRole); end(span, result.failed, result.error);
      } catch { fault(state); }
    },
    snapshot(): MobileRangeWindowSnapshot {
      const copy = { ...snapshot, truncated: snapshot.overflowRequests > 0 || snapshot.requests.some(r => r.droppedRecords > 0),
        requests: snapshot.requests.map(r => ({ ...r, records: r.records.map(v => ({ ...v })),
          firstBusinessFailure: r.firstBusinessFailure ? { ...r.firstBusinessFailure } : null,
          firstCleanupFailure: r.firstCleanupFailure ? { ...r.firstCleanupFailure } : null })) };
      // 以实际普通诊断缩进层级核算新字段；超界只丢旁注，pending和首错保留。
      while (windowBytes(copy) > 262144) {
        const row = [...copy.requests].reverse().find(r => r.records.length > 0); if (!row) break;
        row.records.pop(); row.droppedRecords = bump(row.droppedRecords); copy.truncated = true;
      }
      return copy;
    },
  };
}
export type MobileRangeWindowProbe = ReturnType<typeof createMobileRangeWindowProbe>;
const windowBytes = (s: MobileRangeWindowSnapshot): number => Buffer.byteLength(JSON.stringify({ privateEvidence: { mobileRangeWindow: s } }, null, 2), 'utf8');

/** 普通私有文件导出采用闭集副本；非数据属性、超界数组及伪完成记录整件拒绝。 */
export function copyMobileRangeWindowSnapshot(raw: unknown): MobileRangeWindowSnapshot | null {
  try {
    const top = ['schema', 'enabled', 'ownerDetail', 'maxRequests', 'maxRecordsPerRequest', 'maxRecords', 'maxSerializedBytes', 'overflowRequests', 'ineligibleRequests',
      'malformedFrames', 'unmatchedFrames', 'observerFaults', 'clockFaults', 'truncated', 'requests'];
    if (!closed(raw, top) || raw.schema !== SCHEMA || typeof raw.enabled !== 'boolean' || raw.ownerDetail !== 'not-observable-current-channel'
      || typeof raw.truncated !== 'boolean' || raw.maxRequests !== 8 || raw.maxRecordsPerRequest !== 64 || raw.maxRecords !== 512 || raw.maxSerializedBytes !== 262144
      || !['overflowRequests', 'ineligibleRequests', 'malformedFrames', 'unmatchedFrames', 'observerFaults', 'clockFaults'].every(k => integer(raw[k]) && (raw[k] as number) <= COUNTER_MAX)) return null;
    // 输入数组只读已验证的own data descriptor；不调用其方法或迭代器。
    const arrayValues = (v: unknown, max: number): unknown[] | null => {
      if (!Array.isArray(v) || types.isProxy(v) || Object.getPrototypeOf(v) !== Array.prototype) return null;
      const descriptors = Object.getOwnPropertyDescriptors(v), length = Object.getOwnPropertyDescriptor(v, 'length');
      if (!length || !Object.hasOwn(length, 'value') || !integer(length.value) || length.value > max
        || Reflect.ownKeys(descriptors).length !== length.value + 1) return null;
      const values: unknown[] = [];
      for (let index = 0; index < length.value; index++) {
        const key = String(index);
        if (!Object.hasOwn(descriptors, key)) return null;
        const field = descriptors[key];
        if (!field || field.enumerable !== true || !Object.hasOwn(field, 'value')) return null;
        values.push(field.value);
      }
      return values;
    };
    const record = (v: unknown): v is MobileRangeWindowRecord => closed(v, ['stage', 'role', 'phase', 'atMs', 'durationMs', 'code', 'kind', 'predecessorKind', 'queueAhead', 'nonceSha256', 'count', 'settledCount', 'pendingCount', 'maxDurationMs', 'occupantKind', 'occupantElapsedMs', 'predecessorDurationMs', 'predecessorAgeMs'])
      && choice(v.stage, MOBILE_RANGE_WINDOW_STAGES) && choice(v.role, ['business', 'cleanup']) && choice(v.phase, ['pending', 'ok', 'reject', 'event'])
      && (v.atMs === null || integer(v.atMs)) && (v.durationMs === null || integer(v.durationMs))
      && integer(v.count) && v.count >= 1 && v.count <= COUNTER_MAX && integer(v.settledCount) && integer(v.pendingCount) && v.settledCount + v.pendingCount === v.count
      && [v.maxDurationMs, v.occupantElapsedMs, v.predecessorDurationMs, v.predecessorAgeMs].every(n => n === null || integer(n)) && choice(v.occupantKind, kinds)
      && choice(v.code, codes) && (v.phase === 'reject') === (v.code !== 'NONE') && (v.phase !== 'pending' || v.pendingCount > 0 && (v.settledCount > 0 || v.durationMs === null))
      && (v.phase === 'pending' || v.pendingCount === 0)
      && choice(v.kind, kinds) && choice(v.predecessorKind, kinds) && integer(v.queueAhead) && v.queueAhead <= COUNTER_MAX
      && (v.nonceSha256 === null || typeof v.nonceSha256 === 'string' && SHA.test(v.nonceSha256));
    const requests = arrayValues(raw.requests, MAX_REQUESTS); if (!requests) return null;
    const rows: RequestSnapshot[] = [], hashes = new Set<string>();
    let anyDropped = false;
    for (let index = 0; index < requests.length; index++) {
      const r = requests[index];
      if (!closed(r, ['ordinal', 'requestSha256', 'epochMs', 'offset', 'length', 'httpTerminal', 'httpStatus', 'responseFinished', 'aborted', 'pendingSpans',
        'clockFault', 'droppedRecords', 'firstBusinessFailure', 'firstCleanupFailure', 'records']) || r.ordinal !== rows.length + 1
        || typeof r.requestSha256 !== 'string' || !SHA.test(r.requestSha256) || hashes.has(r.requestSha256)
        || !(r.epochMs === null || integer(r.epochMs)) || !integer(r.offset) || !Number.isSafeInteger(r.offset + 262143) || r.length !== 262144
        || typeof r.httpTerminal !== 'boolean' || typeof r.responseFinished !== 'boolean' || typeof r.aborted !== 'boolean' || typeof r.clockFault !== 'boolean'
        || !(r.httpStatus === null || integer(r.httpStatus) && r.httpStatus >= 100 && r.httpStatus <= 599)
        || !integer(r.pendingSpans) || r.pendingSpans > COUNTER_MAX || !integer(r.droppedRecords) || r.droppedRecords > COUNTER_MAX) return null;
      const recordValues = arrayValues(r.records, MAX_RECORDS); if (!recordValues) return null;
      const records: MobileRangeWindowRecord[] = [];
      let pending = 0;
      for (let ordinal = 0; ordinal < recordValues.length; ordinal++) {
        const value = recordValues[ordinal]; if (!record(value)) return null;
        if (!r.clockFault && (value.atMs === null || value.settledCount > 0 && value.durationMs === null)) return null;
        pending += value.pendingCount; records.push({ ...value });
      }
      if (r.firstBusinessFailure !== null && (!record(r.firstBusinessFailure) || r.firstBusinessFailure.role !== 'business' || r.firstBusinessFailure.phase !== 'reject')
        || r.firstCleanupFailure !== null && (!record(r.firstCleanupFailure) || r.firstCleanupFailure.role !== 'cleanup' || r.firstCleanupFailure.phase !== 'reject')) return null;
      if (r.epochMs === null && !r.clockFault || pending > r.pendingSpans) return null;
      hashes.add(r.requestSha256); if (r.droppedRecords > 0) anyDropped = true;
      rows.push({ ...r, records, firstBusinessFailure: r.firstBusinessFailure ? { ...r.firstBusinessFailure } : null,
        firstCleanupFailure: r.firstCleanupFailure ? { ...r.firstCleanupFailure } : null } as RequestSnapshot);
    }
    const copy = { ...raw, requests: rows } as unknown as MobileRangeWindowSnapshot;
    if (copy.truncated !== (copy.overflowRequests > 0 || anyDropped)) return null;
    return windowBytes(copy) <= 262144 ? copy : null;
  } catch { return null; }
}
