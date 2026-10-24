import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { types } from 'node:util';

const SCHEMA = 'mb.mobile-range-window.v1' as const;
const CONTINUOUS_SCHEMA = 'mb.mobile-range-window.v2' as const;
export const MOBILE_RANGE_WINDOW_STAGES = ['http.arrival', 'http.abort', 'http.terminal',
  'main.open.task', 'main.open.queue', 'main.open.execute', 'auth.queue', 'auth.execute', 'auth.owner-load.composite',
  'source.verify.composite', 'source.read.composite', 'source.read.authority.before', 'source.read.authority.after',
  'read.authority.before', 'read.authority.after', 'content.rpc.composite', 'content.rpc.retained', 'reader.close', 'reader.close.wait',
  'cleanup.close-read.composite', 'sender.initial-authority', 'sender.before-write-authority', 'sender.read', 'sender.write',
  'sender.close', 'sender.close.wait', 'sender.failure', 'core.source.scope.before', 'core.source.execute',
  'core.source.scope.after', 'core.source.ticket-facts.composite', 'core.owner-source.rpc',
  'owner.source.dispatch', 'owner.source.named-fd.verify', 'owner.source.fd.read'] as const;
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
const MAX_TOTAL_REQUESTS = 4096;
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
const hasClosedShape = (value: unknown, keys: readonly string[]): boolean => closed(value, keys);
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
  ordinal: number; requestSha256: string; epochMs: number | null; offset: number; length: 65536 | 262144;
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
export interface MobileRangeContinuousSnapshot extends Omit<MobileRangeWindowSnapshot, 'schema'> {
  schema: typeof CONTINUOUS_SCHEMA;
  observedRequests: number; retiredRequests: number; suppressedRequests: number;
  counterLimitReached: boolean; observerClosed: boolean;
}
export interface MobileRangeWindowContext { readonly requestSha256: string; readonly ordinal: number }
interface Context extends MobileRangeWindowContext { state: State; row: RequestSnapshot; origin: number | null; last: number | null; aggregates: Map<string, MobileRangeWindowRecord>; aggregateErrors: Map<string, Code>; terminalRole: Role;
  httpPublished: boolean; latePublished: boolean; coreCalls: number; coreRecords: Map<string, Map<string, MobileRangeWindowRecord>>;
  coreKind?: SourceKind; coreNonce?: string; retired?: boolean; coreSeed?: MobileRangeWindowSeed; ownerFlush?: (error?: unknown) => void;
  coreNotes?: Map<string, { received: boolean; rpcSettled: boolean; pending: number; holding: boolean }> }
interface Lane { pending: number; active: Kind; previous: Kind; activeSince: number | null; previousDurationMs: number | null; previousSettled: number | null }
interface State {
  snapshot: MobileRangeWindowSnapshot; contexts: Set<Context>; lanes: Record<'open' | 'auth', Lane>;
  now: () => number; epochNow: () => number; sink?: (record: Readonly<MobileRangeWindowRecord>) => void;
  windowSink?: (snapshot: MobileRangeWindowSnapshot, reason: WindowReason, ordinal: number) => void;
  continuity?: { observed: number; retired: number; suppressed: number; closed: boolean;
    windowSink?: (snapshot: MobileRangeContinuousSnapshot, reason: WindowReason | 'budget', ordinal: number) => void };
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
  if (!c.state.snapshot.enabled || c.retired || c.state.continuity?.closed) return;
  try { c.state.sink?.(Object.freeze({ ...row })); } catch { fault(c.state); }
  if (c.httpPublished && !c.latePublished && c.row.pendingSpans === 0) {
    c.latePublished = true; publishWindow(c, 'late-settled');
  }
}
type WindowReason = 'claim' | 'http-terminal' | 'late-settled';
function snapshotForExport(snapshot: MobileRangeWindowSnapshot): MobileRangeWindowSnapshot {
  const copy = { ...snapshot, truncated: snapshot.overflowRequests > 0 || snapshot.requests.some(r => r.droppedRecords > 0),
    requests: snapshot.requests.map(r => ({ ...r, records: r.records.map(v => ({ ...v })),
      firstBusinessFailure: r.firstBusinessFailure ? { ...r.firstBusinessFailure } : null,
      firstCleanupFailure: r.firstCleanupFailure ? { ...r.firstCleanupFailure } : null })) };
  while (windowBytes(copy) > 262144) {
    const row = [...copy.requests].reverse().find(r => r.records.length > 0); if (!row) break;
    row.records.pop(); row.droppedRecords = bump(row.droppedRecords); copy.truncated = true;
  }
  return copy;
}
function continuousSnapshot(state: State): MobileRangeContinuousSnapshot {
  const continuity = state.continuity!;
  const copy: MobileRangeContinuousSnapshot = { ...snapshotForExport(state.snapshot), schema: CONTINUOUS_SCHEMA,
    observedRequests: continuity.observed, retiredRequests: continuity.retired, suppressedRequests: continuity.suppressed,
    counterLimitReached: continuity.observed === MAX_TOTAL_REQUESTS, observerClosed: continuity.closed };
  while (windowBytes(copy) > 262144) {
    const row = [...copy.requests].reverse().find(value => value.records.length > 0); if (!row) break;
    row.records.pop(); row.droppedRecords = bump(row.droppedRecords); copy.truncated = true;
  }
  return copy;
}
function publishWindow(c: Context, reason: WindowReason): void {
  if (!c.state.snapshot.enabled || c.retired || c.state.continuity?.closed) return;
  if (c.state.continuity) {
    try { c.state.continuity.windowSink?.(continuousSnapshot(c.state), reason, c.ordinal); } catch { fault(c.state); }
    return;
  }
  if (!c.state.windowSink) return;
  try { c.state.windowSink(snapshotForExport(c.state.snapshot), reason, c.ordinal); } catch { fault(c.state); }
}
function begin(c: Context | undefined, stage: MobileRangeWindowStage, role: Role, kind = 'none', nonceSha256: string | null = null,
  predecessorKind: Kind = 'none', queueAhead = 0): Span | undefined {
  try {
    if (!c || !c.state.snapshot.enabled || c.retired || c.state.continuity?.closed) return undefined;
    const n = clock(c);
    const row: MobileRangeWindowRecord = { stage, role, phase: 'pending', atMs: n === null || c.origin === null ? null : Math.floor(n - c.origin),
      durationMs: null, code: 'NONE', kind: kindOf(kind), predecessorKind, queueAhead, nonceSha256, count: 1, settledCount: 0, pendingCount: 1, maxDurationMs: null,
      occupantKind: predecessorKind, occupantElapsedMs: null, predecessorDurationMs: null, predecessorAgeMs: null };
    c.row.pendingSpans = bump(c.row.pendingSpans);
    const aggregate = ['auth.queue', 'auth.execute', 'auth.owner-load.composite', 'read.authority.before', 'read.authority.after',
      'source.read.authority.before', 'source.read.authority.after', 'sender.read', 'sender.write', 'sender.before-write-authority',
      'core.source.scope.before', 'core.source.execute', 'core.source.scope.after', 'core.source.ticket-facts.composite',
      'core.owner-source.rpc', 'owner.source.dispatch', 'owner.source.named-fd.verify', 'owner.source.fd.read'].includes(stage);
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
    const c = span.context;
    if (!c.state.snapshot.enabled || c.retired || c.state.continuity?.closed) return;
    const n = clock(c), row = span.row;
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
function settleCoreNote(c: Context, nonce: string): void {
  const note = c.coreNotes?.get(nonce);
  if (note?.holding && note.received && note.rpcSettled && note.pending === 0) {
    note.holding = false; c.row.pendingSpans = Math.max(0, c.row.pendingSpans - 1);
  }
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
    if (!state.snapshot.enabled) return work();
    lane.pending = Math.max(0, lane.pending - 1);
    let began: number | null = null;
    try { const n = state.now(); if (Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER) began = n; else throw new Error(); } catch { if (c) { c.row.clockFault = true; state.snapshot.clockFaults = bump(state.snapshot.clockFaults); } }
    if (queued) { queued.row.predecessorKind = lane.previous; queued.row.predecessorDurationMs = lane.previousDurationMs;
      queued.row.predecessorAgeMs = began === null || lane.previousSettled === null ? null : Math.max(0, Math.floor(began - lane.previousSettled)); }
    end(queued); lane.active = mapped; lane.activeSince = began;
    const executing = begin(c, laneName === 'open' ? 'main.open.execute' : 'auth.execute', 'business', mapped);
    const settled = (rejected = false, error?: unknown): void => {
      if (!state.snapshot.enabled) return;
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
  const c = storage.getStore(); if (!c || !c.state.snapshot.enabled) return undefined;
  let expected: string;
  try {
    if (!UUID.test(nonce)) { c.state.snapshot.malformedFrames = bump(c.state.snapshot.malformedFrames); return undefined; }
    expected = createHash('sha256').update('MusicBridge:range-window:content:1\0' + nonce).digest('hex');
  } catch { fault(c.state); return undefined; }
  const span = begin(c, stage, role, kind, expected);
  let coreSeed: MobileRangeWindowSeed | undefined, coreRevision = 0;
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
  const malformed = () => { c.state.snapshot.malformedFrames = bump(c.state.snapshot.malformedFrames); };
  return { acceptFrame, malformed,
    seed(): MobileRangeWindowSeed | undefined {
      if (c.retired || c.state.continuity?.closed || (!c.state.windowSink && !c.state.continuity?.windowSink)
        || stage !== 'content.rpc.retained' || !choice(kind, SOURCE_KINDS)) return undefined;
      if (coreSeed) return coreSeed;
      if (c.coreNotes?.has(expected)) { c.state.snapshot.unmatchedFrames = bump(c.state.snapshot.unmatchedFrames); return undefined; }
      if (c.coreCalls >= 16) { c.row.droppedRecords = bump(c.row.droppedRecords); return undefined; }
      c.coreCalls++;
      if (c.state.continuity) {
        // 旁注的原RPC与Core真实迟到工作都已收口，才能撤下这一额外保留围栏。
        c.coreNotes!.set(expected, { received: false, rpcSettled: false, pending: 0, holding: true });
        c.row.pendingSpans++;
      }
      coreSeed = Object.freeze({ type: 'mobile-range-window-seed', schema: c.state.continuity ? 2 : 1, id: nonce,
        requestSha256: c.requestSha256, ordinal: c.ordinal, operation: kind,
        ...(c.state.continuity ? { retainedOrdinals: Object.freeze(c.state.snapshot.requests.map(row => row.ordinal)) } : {}) });
      return coreSeed;
    },
    coreFrame(raw: unknown): void {
      if (c.retired || c.state.continuity?.closed) return;
      const frame = copyMobileRangeWindowCoreFrame(raw);
      if (!frame) { malformed(); return; }
      if (!coreSeed || frame.id !== nonce || frame.requestSha256 !== c.requestSha256 || frame.ordinal !== c.ordinal
        || frame.schema !== coreSeed.schema || frame.operation !== coreSeed.operation
        || JSON.stringify(frame.retainedOrdinals) !== JSON.stringify(coreSeed.retainedOrdinals)
        || frame.revision !== coreRevision + 1 || coreRevision >= 2) {
        c.state.snapshot.unmatchedFrames = bump(c.state.snapshot.unmatchedFrames); return;
      }
      const previous = c.coreRecords.get(expected);
      if (previous && [...previous.values()].some(row => {
        const next = frame.records.find(value => value.stage === row.stage);
        return !next || next.count < row.count || next.settledCount < row.settledCount
          || row.durationMs !== null && (next.durationMs === null || next.durationMs < row.durationMs);
      })) { malformed(); return; }
      coreRevision = frame.revision;
      const note = c.coreNotes?.get(expected);
      if (note) { note.received = true; note.pending = frame.pendingSpans; settleCoreNote(c, expected); }
      importCoreFrame(c, expected, frame);
      if (c.httpPublished && !c.latePublished && c.row.pendingSpans === 0) {
        c.latePublished = true; publishWindow(c, 'late-settled');
      }
    },
    settle(id: string, rejected = false, error?: unknown) {
      if (coreSeed && coreRevision === 0) malformed();
      if (coreSeed && id === nonce) { const note = c.coreNotes?.get(expected); if (note) note.rpcSettled = true; settleCoreNote(c, expected); }
      acceptFrame({ nonce: id, phase: rejected ? 'reject' : 'ok', code: rejected ? safeCode(error) : 'NONE' });
    } };
}
interface ProbeOptions {
  enabled?: boolean; now?: () => number; epochNow?: () => number;
  sink?: (record: Readonly<MobileRangeWindowRecord>) => void;
}
interface LegacyProbeOptions extends ProbeOptions {
  continuous?: false;
  windowSink?: (snapshot: MobileRangeWindowSnapshot, reason: WindowReason, ordinal: number) => void;
}
interface ContinuousProbeOptions extends ProbeOptions {
  continuous: true;
  windowSink?: (snapshot: MobileRangeContinuousSnapshot, reason: WindowReason | 'budget', ordinal: number) => void;
}
type ClaimInput = { arrival?: { monotonicMs: number | null; epochMs: number | null }; requestId: string; method: string;
  operation: string; range?: string | undefined; ifRange?: string | undefined };
export interface MobileRangeWindowProbe {
  markArrival(): { monotonicMs: number | null; epochMs: number | null };
  claim(input: ClaimInput): MobileRangeWindowContext | undefined;
  abort(input: MobileRangeWindowContext | undefined): void;
  finish(input: MobileRangeWindowContext | undefined, result: { status: number | null; finished: boolean; failed: boolean; error?: unknown }): void;
  snapshot(): MobileRangeWindowSnapshot | MobileRangeContinuousSnapshot;
  close(): void;
}
export function createMobileRangeWindowProbe(options: ContinuousProbeOptions): Omit<MobileRangeWindowProbe, 'snapshot'> & { snapshot(): MobileRangeContinuousSnapshot };
export function createMobileRangeWindowProbe(options?: LegacyProbeOptions): Omit<MobileRangeWindowProbe, 'snapshot'> & { snapshot(): MobileRangeWindowSnapshot };
export function createMobileRangeWindowProbe(options: LegacyProbeOptions | ContinuousProbeOptions = {}): MobileRangeWindowProbe {
  const snapshot: MobileRangeWindowSnapshot = { schema: SCHEMA, enabled: options.enabled === true, ownerDetail: 'not-observable-current-channel',
    maxRequests: 8, maxRecordsPerRequest: 64, maxRecords: 512, maxSerializedBytes: 262144, overflowRequests: 0, ineligibleRequests: 0,
    malformedFrames: 0, unmatchedFrames: 0, observerFaults: 0, clockFaults: 0, truncated: false, requests: [] };
  const state: State = { snapshot, contexts: new Set(), now: options.now ?? (() => performance.now()), epochNow: options.epochNow ?? Date.now,
    lanes: { open: { pending: 0, active: 'none', previous: 'none', activeSince: null, previousDurationMs: null, previousSettled: null }, auth: { pending: 0, active: 'none', previous: 'none', activeSince: null, previousDurationMs: null, previousSettled: null } },
    ...(options.sink ? { sink: options.sink } : {}) };
  if (options.continuous) state.continuity = { observed: 0, retired: 0, suppressed: 0, closed: false,
    ...(options.enabled === true && options.windowSink ? { windowSink: options.windowSink } : {}) };
  else if (options.enabled === true && options.windowSink) state.windowSink = options.windowSink;
  if (snapshot.enabled) processState = state;
  return {
    markArrival(): { monotonicMs: number | null; epochMs: number | null } {
      if (!snapshot.enabled) return { monotonicMs: null, epochMs: null };
      let monotonicMs: number | null = null, epochMs: number | null = null;
      try { const n = state.now(); if (!Number.isFinite(n) || n < 0 || n > Number.MAX_SAFE_INTEGER) throw new Error(); monotonicMs = n; } catch { snapshot.clockFaults = bump(snapshot.clockFaults); }
      try { const n = state.epochNow(); if (!integer(n)) throw new Error(); epochMs = n; } catch { snapshot.clockFaults = bump(snapshot.clockFaults); }
      return { monotonicMs, epochMs };
    },
    claim(input: ClaimInput): MobileRangeWindowContext | undefined {
      if (!snapshot.enabled) return undefined;
      try {
        if (input.method !== 'GET' || input.operation !== 'getMediaAsset' || input.ifRange !== undefined || !UUID.test(input.requestId)) {
          snapshot.ineligibleRequests = bump(snapshot.ineligibleRequests); return undefined;
        }
        const match = typeof input.range === 'string' && /^bytes=(0|[1-9][0-9]*)-(0|[1-9][0-9]*)$/u.exec(input.range);
        const offset = match ? Number(match[1]) : -1, endOffset = match ? Number(match[2]) : -1;
        const length = endOffset - offset + 1;
        if (!integer(offset) || !integer(endOffset) || length !== 65536 && length !== 262144) {
          snapshot.ineligibleRequests = bump(snapshot.ineligibleRequests); return undefined;
        }
        const continuity = state.continuity;
        const suppress = (): undefined => {
          snapshot.overflowRequests = bump(snapshot.overflowRequests);
          if (continuity) {
            continuity.suppressed = bump(continuity.suppressed);
            try { continuity.windowSink?.(continuousSnapshot(state), 'budget', continuity.observed); } catch { fault(state); }
          }
          return undefined;
        };
        if (continuity?.observed === MAX_TOTAL_REQUESTS) return suppress();
        const requestSha256 = createHash('sha256').update('MusicBridge:range-window:http:1\0' + input.requestId).digest('hex');
        if (snapshot.requests.some(r => r.requestSha256 === requestSha256)) { snapshot.unmatchedFrames = bump(snapshot.unmatchedFrames); return undefined; }
        if (snapshot.requests.length >= MAX_REQUESTS) {
          if (!continuity) return suppress();
          const retired = [...state.contexts].find(c => c.row.httpTerminal && c.row.pendingSpans === 0 && c.latePublished
            && [...c.coreNotes?.values() ?? []].every(note => note.received && note.rpcSettled && note.pending === 0 && !note.holding));
          if (!retired) return suppress();
          retired.retired = true; state.contexts.delete(retired);
          snapshot.requests.splice(snapshot.requests.indexOf(retired.row), 1);
          retired.aggregates.clear(); retired.aggregateErrors.clear(); retired.coreRecords.clear(); retired.coreNotes?.clear();
          continuity.retired++;
        }
        const ordinal = continuity ? ++continuity.observed : snapshot.requests.length + 1;
        const row: RequestSnapshot = { ordinal, requestSha256, epochMs: null, offset, length,
          httpTerminal: false, httpStatus: null, responseFinished: false, aborted: false, pendingSpans: 0, clockFault: false, droppedRecords: 0,
          firstBusinessFailure: null, firstCleanupFailure: null, records: [] };
        const c: Context = { state, row, requestSha256, ordinal: row.ordinal, origin: null, last: null, aggregates: new Map(), aggregateErrors: new Map(), terminalRole: 'business',
          httpPublished: false, latePublished: false, coreCalls: 0, coreRecords: new Map(), ...(continuity ? { coreNotes: new Map() } : {}) };
        c.origin = input.arrival ? input.arrival.monotonicMs : clock(c); c.last = c.origin;
        if (c.origin === null) row.clockFault = true;
        try { const epoch = input.arrival ? input.arrival.epochMs : state.epochNow(); if (!integer(epoch)) throw new Error(); row.epochMs = epoch; }
        catch { row.clockFault = true; snapshot.clockFaults = bump(snapshot.clockFaults); }
        state.contexts.add(c); snapshot.requests.push(row);
        const arrival = begin(c, 'http.arrival', 'business'); if (arrival) { end(arrival); arrival.row.phase = 'event'; arrival.row.atMs = c.origin === null ? null : 0; arrival.row.durationMs = c.origin === null || arrival.started === null ? null : 0; arrival.row.maxDurationMs = arrival.row.durationMs; }
        publishWindow(c, 'claim');
        return c;
      } catch { fault(state); return undefined; }
    },
    abort(input: MobileRangeWindowContext | undefined): void {
      const c = input as Context | undefined; if (!snapshot.enabled || !c || !state.contexts.has(c) || c.row.aborted) return;
      c.row.aborted = true; event(c, 'http.abort');
    },
    finish(input: MobileRangeWindowContext | undefined, result: { status: number | null; finished: boolean; failed: boolean; error?: unknown }): void {
      try {
        const c = input as Context | undefined; if (!snapshot.enabled || !c || !state.contexts.has(c) || c.row.httpTerminal) return;
        c.row.httpTerminal = true; c.row.httpStatus = result.status; c.row.responseFinished = result.finished;
        const span = begin(c, 'http.terminal', c.terminalRole); end(span, result.failed, result.error);
        c.httpPublished = true; c.latePublished = c.row.pendingSpans === 0;
        publishWindow(c, 'http-terminal');
      } catch { fault(state); }
    },
    snapshot(): MobileRangeWindowSnapshot | MobileRangeContinuousSnapshot {
      return state.continuity ? continuousSnapshot(state) : snapshotForExport(snapshot);
    },
    close(): void { if (state.continuity) state.continuity.closed = true; snapshot.enabled = false; if (processState === state) processState = undefined; },
  };
}
const windowBytes = (s: MobileRangeWindowSnapshot | MobileRangeContinuousSnapshot): number => Buffer.byteLength(JSON.stringify({ privateEvidence: { mobileRangeWindow: s } }, null, 2), 'utf8');
function record(v: unknown): v is MobileRangeWindowRecord {
  return closed(v, ['stage', 'role', 'phase', 'atMs', 'durationMs', 'code', 'kind', 'predecessorKind', 'queueAhead', 'nonceSha256', 'count', 'settledCount', 'pendingCount', 'maxDurationMs', 'occupantKind', 'occupantElapsedMs', 'predecessorDurationMs', 'predecessorAgeMs'])
    && choice(v.stage, MOBILE_RANGE_WINDOW_STAGES) && choice(v.role, ['business', 'cleanup']) && choice(v.phase, ['pending', 'ok', 'reject', 'event'])
    && (v.atMs === null || integer(v.atMs)) && (v.durationMs === null || integer(v.durationMs))
    && integer(v.count) && v.count >= 1 && v.count <= COUNTER_MAX && integer(v.settledCount) && integer(v.pendingCount) && v.settledCount + v.pendingCount === v.count
    && [v.maxDurationMs, v.occupantElapsedMs, v.predecessorDurationMs, v.predecessorAgeMs].every(n => n === null || integer(n)) && choice(v.occupantKind, kinds)
    && choice(v.code, codes) && (v.phase === 'reject') === (v.code !== 'NONE') && (v.phase !== 'pending' || v.pendingCount > 0 && (v.settledCount > 0 || v.durationMs === null))
    && (v.phase === 'pending' || v.pendingCount === 0)
    && choice(v.kind, kinds) && choice(v.predecessorKind, kinds) && integer(v.queueAhead) && v.queueAhead <= COUNTER_MAX
    && (v.nonceSha256 === null || typeof v.nonceSha256 === 'string' && SHA.test(v.nonceSha256));
}
function arrayData(v: unknown, max: number): unknown[] | null {
  try {
    if (!Array.isArray(v) || types.isProxy(v) || Object.getPrototypeOf(v) !== Array.prototype) return null;
    const d = Object.getOwnPropertyDescriptors(v), length = Object.getOwnPropertyDescriptor(v, 'length');
    if (!length || !Object.hasOwn(length, 'value') || !integer(length.value) || length.value > max || Reflect.ownKeys(d).length !== length.value + 1) return null;
    const values: unknown[] = [];
    for (let index = 0; index < length.value; index++) {
      const field = d[String(index)]; if (!field?.enumerable || !Object.hasOwn(field, 'value')) return null;
      values.push(field.value);
    }
    return values;
  } catch { return null; }
}
function copyRetainedOrdinals(raw: unknown): number[] | null {
  const values = arrayData(raw, MAX_REQUESTS); if (!values) return null;
  const copied: number[] = [];
  for (const value of values) {
    if (!integer(value) || value < 1 || value > MAX_TOTAL_REQUESTS || value <= (copied.at(-1) ?? 0)) return null;
    copied.push(value);
  }
  return copied;
}

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
    const requests = arrayValues(raw.requests, MAX_REQUESTS); if (!requests) return null;
    const rows: RequestSnapshot[] = [], hashes = new Set<string>();
    let anyDropped = false;
    for (let index = 0; index < requests.length; index++) {
      const r = requests[index];
      if (!closed(r, ['ordinal', 'requestSha256', 'epochMs', 'offset', 'length', 'httpTerminal', 'httpStatus', 'responseFinished', 'aborted', 'pendingSpans',
        'clockFault', 'droppedRecords', 'firstBusinessFailure', 'firstCleanupFailure', 'records']) || r.ordinal !== rows.length + 1
        || typeof r.requestSha256 !== 'string' || !SHA.test(r.requestSha256) || hashes.has(r.requestSha256)
        || !(r.epochMs === null || integer(r.epochMs)) || !integer(r.offset) || r.length !== 65536 && r.length !== 262144
        || !Number.isSafeInteger(r.offset + (r.length as number) - 1)
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

/** v2只放宽全局ordinal的单调子序列；每一行仍交给原v1安全边界完整校验。 */
export function copyMobileRangeContinuousSnapshot(raw: unknown): MobileRangeContinuousSnapshot | null {
  try {
    const top = ['schema', 'enabled', 'ownerDetail', 'maxRequests', 'maxRecordsPerRequest', 'maxRecords', 'maxSerializedBytes',
      'overflowRequests', 'ineligibleRequests', 'malformedFrames', 'unmatchedFrames', 'observerFaults', 'clockFaults', 'truncated', 'requests',
      'observedRequests', 'retiredRequests', 'suppressedRequests', 'counterLimitReached', 'observerClosed'];
    if (!closed(raw, top) || raw.schema !== CONTINUOUS_SCHEMA || !integer(raw.observedRequests) || raw.observedRequests > MAX_TOTAL_REQUESTS
      || !integer(raw.retiredRequests) || raw.retiredRequests > raw.observedRequests
      || !integer(raw.suppressedRequests) || raw.suppressedRequests > COUNTER_MAX || raw.suppressedRequests !== raw.overflowRequests
      || raw.counterLimitReached !== (raw.observedRequests === MAX_TOTAL_REQUESTS) || typeof raw.observerClosed !== 'boolean'
      || raw.observerClosed && raw.enabled !== false) return null;
    const values = arrayData(raw.requests, MAX_REQUESTS); if (!values || raw.observedRequests !== raw.retiredRequests + values.length) return null;
    const rows: RequestSnapshot[] = [], ordinals: number[] = [];
    for (const value of values) {
      const row = copyTraceRequest(value, MAX_TOTAL_REQUESTS);
      if (!row || row.ordinal <= (ordinals.at(-1) ?? 0) || row.ordinal > raw.observedRequests) return null;
      rows.push({ ...row, ordinal: rows.length + 1 }); ordinals.push(row.ordinal);
    }
    if ((ordinals.at(-1) ?? 0) !== raw.observedRequests) return null;
    const legacy = copyMobileRangeWindowSnapshot({ schema: SCHEMA, enabled: raw.enabled, ownerDetail: raw.ownerDetail,
      maxRequests: raw.maxRequests, maxRecordsPerRequest: raw.maxRecordsPerRequest, maxRecords: raw.maxRecords,
      maxSerializedBytes: raw.maxSerializedBytes, overflowRequests: raw.overflowRequests, ineligibleRequests: raw.ineligibleRequests,
      malformedFrames: raw.malformedFrames, unmatchedFrames: raw.unmatchedFrames, observerFaults: raw.observerFaults,
      clockFaults: raw.clockFaults, truncated: raw.truncated, requests: rows });
    if (!legacy) return null;
    const copied: MobileRangeContinuousSnapshot = { ...legacy, schema: CONTINUOUS_SCHEMA,
      requests: legacy.requests.map((row, index) => ({ ...row, ordinal: ordinals[index]! })),
      observedRequests: raw.observedRequests, retiredRequests: raw.retiredRequests, suppressedRequests: raw.suppressedRequests,
      counterLimitReached: raw.counterLimitReached as boolean, observerClosed: raw.observerClosed };
    return windowBytes(copied) <= 262144 ? copied : null;
  } catch { return null; }
}

const SOURCE_KINDS = ['read', 'verify', 'close-read'] as const;
const CORE_STAGES = ['core.source.scope.before', 'core.source.execute', 'core.source.scope.after', 'core.source.ticket-facts.composite',
  'core.owner-source.rpc', 'owner.source.dispatch', 'owner.source.named-fd.verify', 'owner.source.fd.read'] as const;
type SourceKind = typeof SOURCE_KINDS[number];
type CoreStage = typeof CORE_STAGES[number];
export interface MobileRangeWindowSeed {
  type: 'mobile-range-window-seed'; schema: 1 | 2; id: string; requestSha256: string; ordinal: number; operation: SourceKind;
  retainedOrdinals?: readonly number[];
}
interface CoreFrame extends Omit<MobileRangeWindowSeed, 'type'> {
  type: 'mobile-range-window-core'; revision: number; epochMs: number | null; clockFault: boolean; pendingSpans: number; records: MobileRangeWindowRecord[];
}
export function copyMobileRangeWindowSeed(raw: unknown): MobileRangeWindowSeed | null {
  const keys = ['type', 'schema', 'id', 'requestSha256', 'ordinal', 'operation'];
  const continuous = hasClosedShape(raw, [...keys, 'retainedOrdinals']);
  if (!closed(raw, continuous ? [...keys, 'retainedOrdinals'] : keys)
    || raw.type !== 'mobile-range-window-seed' || (continuous ? raw.schema !== 2 : raw.schema !== 1)
    || typeof raw.id !== 'string' || !UUID.test(raw.id) || typeof raw.requestSha256 !== 'string' || !SHA.test(raw.requestSha256)
    || !integer(raw.ordinal) || raw.ordinal < 1 || raw.ordinal > (continuous ? MAX_TOTAL_REQUESTS : MAX_REQUESTS)
    || !choice(raw.operation, SOURCE_KINDS)) return null;
  const retained = continuous ? copyRetainedOrdinals(raw.retainedOrdinals) : undefined;
  if (continuous && (!retained || !retained.includes(raw.ordinal))) return null;
  return { type: 'mobile-range-window-seed', schema: continuous ? 2 : 1, id: raw.id,
    requestSha256: raw.requestSha256, ordinal: raw.ordinal, operation: raw.operation,
    ...(retained ? { retainedOrdinals: retained } : {}) };
}
export function copyMobileRangeWindowCoreFrame(raw: unknown): CoreFrame | null {
  try {
    const keys = ['type', 'schema', 'id', 'requestSha256', 'ordinal', 'operation', 'revision', 'epochMs', 'clockFault', 'pendingSpans', 'records'];
    const continuous = hasClosedShape(raw, [...keys, 'retainedOrdinals']);
    if (!closed(raw, continuous ? [...keys, 'retainedOrdinals'] : keys)
      || raw.type !== 'mobile-range-window-core' || (continuous ? raw.schema !== 2 : raw.schema !== 1)) return null;
    const seed = copyMobileRangeWindowSeed({ type: 'mobile-range-window-seed', schema: raw.schema, id: raw.id,
      requestSha256: raw.requestSha256, ordinal: raw.ordinal, operation: raw.operation,
      ...(continuous ? { retainedOrdinals: raw.retainedOrdinals } : {}) });
    const records = arrayData(raw.records, CORE_STAGES.length);
    if (!seed || !records || ![1, 2].includes(raw.revision as number) || !(raw.epochMs === null || integer(raw.epochMs))
      || typeof raw.clockFault !== 'boolean' || raw.epochMs === null && !raw.clockFault || !integer(raw.pendingSpans) || raw.pendingSpans > COUNTER_MAX) return null;
    const stages = new Set<string>(), copied: MobileRangeWindowRecord[] = [];
    const nonce = createHash('sha256').update('MusicBridge:range-window:content:1\0' + seed.id).digest('hex');
    let pending = 0;
    for (const row of records) {
      if (!record(row) || !choice(row.stage, CORE_STAGES) || stages.has(row.stage) || row.kind !== seed.operation
        || row.phase === 'event'
        || row.role !== (seed.operation === 'close-read' ? 'cleanup' : 'business') || row.nonceSha256 !== nonce
        || row.count > 4096 || [row.atMs, row.durationMs, row.maxDurationMs].some(n => n !== null && n > COUNTER_MAX)
        || !raw.clockFault && (row.atMs === null || row.settledCount > 0 && row.durationMs === null)) return null;
      pending += row.pendingCount; stages.add(row.stage); copied.push({ ...row });
    }
    if (pending !== raw.pendingSpans || raw.revision === 2 && pending !== 0) return null;
    return { ...seed, type: 'mobile-range-window-core', revision: raw.revision as number, epochMs: raw.epochMs as number | null,
      clockFault: raw.clockFault, pendingSpans: pending, records: copied };
  } catch { return null; }
}
function importCoreFrame(c: Context, nonce: string, frame: CoreFrame): void {
  try {
    const previous = c.coreRecords.get(nonce), next = new Map<string, MobileRangeWindowRecord>();
    const shift = frame.epochMs === null || c.row.epochMs === null ? null : frame.epochMs - c.row.epochMs;
    if (frame.clockFault || shift === null || shift < 0) c.row.clockFault = true;
    for (const value of frame.records) {
      const atMs = shift === null || shift < 0 || value.atMs === null ? null : shift + value.atMs;
      const row = { ...value, atMs };
      if (row.phase === 'reject') {
        const key = row.role === 'business' ? 'firstBusinessFailure' : 'firstCleanupFailure';
        c.row[key] ??= { ...row };
      }
      next.set(row.stage, row);
    }
    c.coreRecords.set(nonce, next);
    c.row.pendingSpans = Math.max(0, c.row.pendingSpans - [...previous?.values() ?? []].reduce((n, row) => n + row.pendingCount, 0)
      + frame.pendingSpans);
    const changed: MobileRangeWindowRecord[] = [];
    for (const stage of CORE_STAGES) {
      const records = [...c.coreRecords.values()].map(rows => rows.get(stage)).filter((row): row is MobileRangeWindowRecord => row?.kind === frame.operation);
      if (!records.length) continue;
      const key = stage + ':' + frame.operation;
      let target = c.aggregates.get(key);
      if (!target) { target = { ...records[0]! }; c.aggregates.set(key, target); if (!retain(c, target)) continue; }
      target.count = records.reduce((n, row) => n + row.count, 0);
      target.settledCount = records.reduce((n, row) => n + row.settledCount, 0);
      target.pendingCount = records.reduce((n, row) => n + row.pendingCount, 0);
      target.durationMs = records.some(row => row.settledCount > 0 && row.durationMs === null) ? null : records.reduce((n, row) => n + (row.durationMs ?? 0), 0);
      if (target.settledCount === 0) target.durationMs = null;
      target.maxDurationMs = records.reduce<number | null>((n, row) => row.maxDurationMs === null ? n : Math.max(n ?? 0, row.maxDurationMs), null);
      target.atMs = records.some(row => row.atMs === null) ? null : Math.min(...records.map(row => row.atMs!));
      target.nonceSha256 = c.coreNonce ?? (records.length === 1 ? records[0]!.nonceSha256 : null);
      const rejected = records.find(row => row.phase === 'reject');
      target.phase = target.pendingCount > 0 ? 'pending' : rejected ? 'reject' : 'ok';
      target.code = target.phase === 'reject' ? rejected!.code : 'NONE'; changed.push(target);
    }
    // 先替换同一nonce的完整贡献，再发布；不能在部分字段更新时宣称所有旁注已结算。
    for (const row of changed) publish(c, row);
  } catch { fault(c.state); }
}
const coreStorage = new AsyncLocalStorage<Context>();
export function mobileRangeWindowCoreObserve<T>(stage: CoreStage, work: () => Promise<T>): Promise<T> {
  let c: Context | undefined;
  try { c = coreStorage.getStore(); } catch { return work(); }
  if (!c) return work();
  const span = begin(c, stage, c.terminalRole, c.coreKind ?? 'source', c.coreNonce ?? null);
  try { const original = work(); try { void original.then(() => end(span), error => end(span, true, error)); } catch { fault(c.state); } return original; }
  catch (error) { end(span, true, error); throw error; }
}
/** 只量原ticket复验的同步合成段；包含双facts SQL，绝不代表纯SQL，也不复用权限。 */
export function mobileRangeWindowCoreFacts<T>(work: () => T): T {
  let c: Context | undefined;
  try { c = coreStorage.getStore(); } catch { return work(); }
  if (!c) return work();
  const span = begin(c, 'core.source.ticket-facts.composite', c.terminalRole, c.coreKind ?? 'source', c.coreNonce ?? null);
  try { const result = work(); end(span); return result; } catch (error) { end(span, true, error); throw error; }
}
/** 同一原Main port的有界旁注；不创建业务任务、计时器、槽位或授权结果缓存。 */
export function createMobileRangeWindowCoreReceiver(options: { sink(frame: CoreFrame): void; now?: () => number; epochNow?: () => number; owner?: boolean }) {
  type Window = { schema: 1 | 2; ordinal: number; calls: number; awaiting: number; contexts: Set<Context>; nonces: Set<string> };
  const seeds = new Map<string, MobileRangeWindowSeed>(), windows = new Map<string, Window>();
  let accepted = 0, highWater = 0, retainedHighWater = 0, closedReceiver = false, mode: 1 | 2 | undefined;
  let retained: number[] = [];
  const quiet = (window: Window): boolean => window.awaiting === 0 && window.contexts.size === 0;
  return {
    acceptSeed(raw: unknown): boolean {
      if (closedReceiver) return false;
      const seed = copyMobileRangeWindowSeed(raw);
      if (!seed || mode !== undefined && seed.schema !== mode || seeds.has(seed.id) || seeds.size >= 16
        || [...windows.values()].some(window => window.nonces.has(seed.id))) return false;
      if (seed.schema === 1 && accepted >= 128) return false;
      if (seed.schema === 2) {
        const next = seed.retainedOrdinals!, nextHighWater = next.at(-1)!;
        if (nextHighWater < retainedHighWater || nextHighWater === retainedHighWater && JSON.stringify(next) !== JSON.stringify(retained)) return false;
        // 只接受Main本次明确保留列表；本地仍有seed、原任务或迟到旁注的窗一律不回收。
        for (const [hash, window] of windows) if (!next.includes(window.ordinal) && quiet(window)) windows.delete(hash);
        if (nextHighWater > retainedHighWater) { retainedHighWater = nextHighWater; retained = [...next]; }
      }
      const window = windows.get(seed.requestSha256);
      if (!window && windows.size >= MAX_REQUESTS || window && (window.schema !== seed.schema || window.ordinal !== seed.ordinal || window.calls >= 16)
        || !window && [...windows.values()].some(row => row.ordinal === seed.ordinal)
        || seed.schema === 2 && !window && seed.ordinal <= highWater) return false;
      const owner = window ?? { schema: seed.schema, ordinal: seed.ordinal, calls: 0, awaiting: 0, contexts: new Set<Context>(), nonces: new Set<string>() };
      owner.calls++; owner.awaiting++; owner.nonces.add(seed.id);
      windows.set(seed.requestSha256, owner); seeds.set(seed.id, seed); accepted++; mode = seed.schema;
      highWater = Math.max(highWater, seed.ordinal);
      return true;
    },
    run<T>(id: string, operation: string | undefined, work: () => Promise<T>): Promise<T> {
      const seed = seeds.get(id); seeds.delete(id);
      const owner = seed ? windows.get(seed.requestSha256) : undefined;
      if (owner) owner.awaiting = Math.max(0, owner.awaiting - 1);
      if (closedReceiver || !seed || !owner || seed.operation !== operation) return work();
      const now = options.now ?? (() => performance.now());
      let epoch: number | null = null; try { const n = (options.epochNow ?? Date.now)(); if (integer(n)) epoch = n; } catch { /* 只丢诊断时钟。 */ }
      const snapshot = emptyWindowSnapshot();
      const row: RequestSnapshot = { ordinal: seed.ordinal, requestSha256: seed.requestSha256, epochMs: epoch, offset: 0, length: 65536,
        httpTerminal: false, httpStatus: null, responseFinished: false, aborted: false, pendingSpans: 0, clockFault: epoch === null,
        droppedRecords: 0, firstBusinessFailure: null, firstCleanupFailure: null, records: [] };
      let published = false, revision = 0, settled = false;
      const state: State = { snapshot, contexts: new Set(), lanes: { open: emptyLane(), auth: emptyLane() }, now, epochNow: () => epoch ?? 0,
        sink() { if (published && row.pendingSpans === 0) emit(); } };
      const c: Context = { state, row, requestSha256: seed.requestSha256, ordinal: seed.ordinal, origin: null, last: null,
        aggregates: new Map(), aggregateErrors: new Map(), terminalRole: seed.operation === 'close-read' ? 'cleanup' : 'business',
        httpPublished: false, latePublished: false, coreCalls: 0, coreRecords: new Map() };
      owner.contexts.add(c); c.origin = clock(c);
      const nonce = createHash('sha256').update('MusicBridge:range-window:content:1\0' + seed.id).digest('hex');
      c.coreKind = seed.operation; c.coreNonce = nonce; c.coreSeed = seed;
      function emit(): void {
        if (closedReceiver || revision >= 2) return;
        revision++;
        // 首帧或迟到帧确实为零后，先关闭本地诊断context，再允许Main据回执退休。
        if (row.pendingSpans === 0) { owner!.contexts.delete(c); c.retired = true; }
        const frame: CoreFrame = { ...seed!, type: 'mobile-range-window-core', revision, epochMs: epoch, clockFault: row.clockFault,
          pendingSpans: row.pendingSpans, records: row.records.map(record => ({ ...record })) };
        try { options.sink(frame); } catch { /* 旁注post失败不改变原返回。 */ }
      }
      const finish = (): void => {
        if (settled) return;
        settled = true; published = true; emit();
      };
      if (options.owner) c.ownerFlush = finish;
      try {
        const original = coreStorage.run(c, work);
        void original.then(finish, finish);
        return original;
      } catch (error) { finish(); throw error; }
    },
    close(): void {
      closedReceiver = true; seeds.clear();
      for (const window of windows.values()) for (const context of window.contexts) { context.retired = true; context.state.snapshot.enabled = false; }
      windows.clear(); retained = [];
    },
  };
}

export interface MobileRangeWindowOwnerSeed {
  type: 'mobile-range-window-owner-seed'; epoch: string; parentId: string; seed: MobileRangeWindowSeed;
}
export interface MobileRangeWindowOwnerFrame {
  type: 'mobile-range-window-owner'; epoch: string; parentId: string; frame: CoreFrame;
}
const OWNER_STAGES = ['owner.source.dispatch', 'owner.source.named-fd.verify', 'owner.source.fd.read',
  'core.source.ticket-facts.composite'] as const;
/** 只窥看数据属性；Proxy、访问器及未知消息仍交原业务边界，不执行旁注字段代码。 */
export function isMobileRangeWindowOwnerWire(raw: unknown, type: MobileRangeWindowOwnerSeed['type'] | MobileRangeWindowOwnerFrame['type']): boolean {
  try { return !!raw && typeof raw === 'object' && !types.isProxy(raw)
    && Object.getOwnPropertyDescriptor(raw, 'type')?.value === type; } catch { return false; }
}
export function copyMobileRangeWindowOwnerSeed(raw: unknown): MobileRangeWindowOwnerSeed | null {
  try {
    if (!closed(raw, ['type', 'epoch', 'parentId', 'seed']) || raw.type !== 'mobile-range-window-owner-seed'
      || typeof raw.epoch !== 'string' || !UUID.test(raw.epoch) || typeof raw.parentId !== 'string' || !UUID.test(raw.parentId)) return null;
    const seed = copyMobileRangeWindowSeed(raw.seed);
    return seed ? { type: raw.type, epoch: raw.epoch, parentId: raw.parentId, seed } : null;
  } catch { return null; }
}
export function copyMobileRangeWindowOwnerFrame(raw: unknown): MobileRangeWindowOwnerFrame | null {
  try {
    if (!closed(raw, ['type', 'epoch', 'parentId', 'frame']) || raw.type !== 'mobile-range-window-owner'
      || typeof raw.epoch !== 'string' || !UUID.test(raw.epoch) || typeof raw.parentId !== 'string' || !UUID.test(raw.parentId)) return null;
    const frame = copyMobileRangeWindowCoreFrame(raw.frame);
    if (!frame || frame.revision !== 1 || frame.pendingSpans !== 0
      || frame.records.some(row => !choice(row.stage, OWNER_STAGES)
        || row.stage === 'owner.source.fd.read' && frame.operation !== 'read')) return null;
    return { type: raw.type, epoch: raw.epoch, parentId: raw.parentId, frame };
  } catch { return null; }
}
/** 原Core→Owner往返的只读旁注；缺Owner帧不补零、不持有原业务Promise或增加timer。 */
export function captureMobileRangeWindowOwnerHop(epoch: string, id: string, operation: string) {
  let c: Context | undefined;
  try { c = coreStorage.getStore(); } catch { return undefined; }
  if (!c || !c.coreSeed || c.ownerFlush || c.retired || !choice(operation, SOURCE_KINDS)) return undefined;
  try {
    if (!UUID.test(epoch) || !UUID.test(id) || c.coreKind !== operation) return undefined;
    const parent = c.coreSeed;
    const seed: MobileRangeWindowOwnerSeed = { type: 'mobile-range-window-owner-seed', epoch, parentId: parent.id,
      seed: { ...parent, id, ...(parent.retainedOrdinals ? { retainedOrdinals: [...parent.retainedOrdinals] } : {}) } };
    let span: Span | undefined, started = false;
    let active = true, received = false;
    return {
      seed,
      start(): void {
        if (!active || started) return;
        started = true; span = begin(c, 'core.owner-source.rpc', c.terminalRole, operation, c.coreNonce ?? null);
      },
      accept(raw: unknown): void {
        try {
          if (!active || c.retired) return;
          const value = copyMobileRangeWindowOwnerFrame(raw), frame = value?.frame;
          if (!value || !frame) { c.state.snapshot.malformedFrames = bump(c.state.snapshot.malformedFrames); return; }
          if (received || value.epoch !== epoch || value.parentId !== parent.id || frame.id !== id
            || frame.requestSha256 !== parent.requestSha256 || frame.ordinal !== parent.ordinal || frame.schema !== parent.schema
            || frame.operation !== operation || JSON.stringify(frame.retainedOrdinals) !== JSON.stringify(parent.retainedOrdinals)) {
            c.state.snapshot.unmatchedFrames = bump(c.state.snapshot.unmatchedFrames); return;
          }
          received = true;
          importCoreFrame(c, id, frame);
        } catch { fault(c.state); }
      },
      settle(rejected = false, error?: unknown): void {
        if (!active) return;
        active = false; end(span, rejected, error);
      },
    };
  } catch { fault(c.state); return undefined; }
}
/** 仅原已启用Range的同代旁注可安装Owner ALS；沿原8窗/每窗16hop及总4096预算。 */
export function createMobileRangeWindowOwnerReceiver(options: { sink(frame: MobileRangeWindowOwnerFrame): void; now?: () => number; epochNow?: () => number }) {
  const bindings = new Map<string, MobileRangeWindowOwnerSeed>();
  let closedReceiver = false;
  const receiver = createMobileRangeWindowCoreReceiver({ ...options, owner: true, sink(frame) {
    const binding = bindings.get(frame.id);
    if (!binding) return;
    bindings.delete(frame.id);
    const value: MobileRangeWindowOwnerFrame = { type: 'mobile-range-window-owner', epoch: binding.epoch, parentId: binding.parentId, frame };
    if (!copyMobileRangeWindowOwnerFrame(value)) return;
    try { options.sink(value); } catch { /* 旁注失败不得封业务port、改变原返回或等待quiet。 */ }
  } });
  return {
    acceptSeed(raw: unknown, epoch: string | undefined): void {
      if (closedReceiver || !epoch || bindings.size >= 16) return;
      const seed = copyMobileRangeWindowOwnerSeed(raw);
      if (!seed || seed.epoch !== epoch || !receiver.acceptSeed(seed.seed)) return;
      bindings.set(seed.seed.id, seed);
    },
    run<T>(epoch: string, id: string, operation: string | undefined, work: () => Promise<T>): Promise<T> {
      const binding = bindings.get(id);
      let result: { ok: true; value: Promise<T> } | { ok: false; error: unknown } | undefined;
      const once = () => {
        if (result) { if (result.ok) return result.value; throw result.error; }
        try { const value = work(); result = { ok: true, value }; return value; }
        catch (error) { result = { ok: false, error }; throw error; }
      };
      try {
        const matched = !closedReceiver && binding?.epoch === epoch && binding.seed.operation === operation;
        if (!matched) bindings.delete(id);
        return receiver.run(id, matched ? operation : undefined, once);
      } catch { return once(); }
    },
    close(): void { closedReceiver = true; bindings.clear(); receiver.close(); },
  };
}
/** Owner原业务回包前尽力收口；不等待旁注，不把缺失记录伪造成零。 */
export function flushMobileRangeWindowOwner(): void {
  try { coreStorage.getStore()?.ownerFlush?.(); } catch { /* 旁注不可替换原reply/reject。 */ }
}
function emptyLane(): Lane { return { pending: 0, active: 'none', previous: 'none', activeSince: null, previousDurationMs: null, previousSettled: null }; }
function emptyWindowSnapshot(): MobileRangeWindowSnapshot {
  return { schema: SCHEMA, enabled: true, ownerDetail: 'not-observable-current-channel', maxRequests: 8, maxRecordsPerRequest: 64, maxRecords: 512,
    maxSerializedBytes: 262144, overflowRequests: 0, ineligibleRequests: 0, malformedFrames: 0, unmatchedFrames: 0, observerFaults: 0, clockFaults: 0, truncated: false, requests: [] };
}

export const MOBILE_RANGE_WINDOW_TRACE_PREFIX = 'MUSICBRIDGE_MOBILE_RANGE_WINDOW_TRACE ';
interface WindowTraceFrame {
  schema: 'mb.mobile-range-window-trace.v1'; sequence: number; reason: WindowReason | 'budget';
  observation: 'open' | 'terminal-pending' | 'terminal-settled' | 'incomplete' | 'budget-exhausted';
  maxFrames: 25; maxRecords: 512; maxSerializedBytes: 262144; emittedRecords: number; droppedFrames: number;
  truncated: boolean; malformedFrames: number; unmatchedFrames: number; observerFaults: number;
  request: RequestSnapshot | null;
}
const requestKeys = ['ordinal', 'requestSha256', 'epochMs', 'offset', 'length', 'httpTerminal', 'httpStatus', 'responseFinished', 'aborted',
  'pendingSpans', 'clockFault', 'droppedRecords', 'firstBusinessFailure', 'firstCleanupFailure', 'records'];
function copyTraceRequest(raw: unknown, maxOrdinal = MAX_REQUESTS): RequestSnapshot | null {
  if (!closed(raw, requestKeys) || !integer(raw.ordinal) || raw.ordinal < 1 || raw.ordinal > maxOrdinal) return null;
  const snapshot = emptyWindowSnapshot();
  snapshot.requests = [{ ...raw, ordinal: 1 } as unknown as RequestSnapshot];
  snapshot.truncated = typeof raw.droppedRecords === 'number' && raw.droppedRecords > 0;
  const copy = copyMobileRangeWindowSnapshot(snapshot)?.requests[0];
  return copy ? { ...copy, ordinal: raw.ordinal } : null;
}
function observation(request: RequestSnapshot | null, truncated: boolean, faults: number): WindowTraceFrame['observation'] {
  if (!request) return 'budget-exhausted';
  if (!request.httpTerminal) return 'open';
  if (request.pendingSpans > 0) return 'terminal-pending';
  return request.clockFault || request.droppedRecords > 0 || truncated || faults > 0 ? 'incomplete' : 'terminal-settled';
}
/** 每行仍走原snapshot/record闭集guard；settled只指已观测旁注，不证明完整body或Owner物理quiet。 */
export function copyMobileRangeWindowTraceFrame(raw: unknown): WindowTraceFrame | null {
  try {
    if (!closed(raw, ['schema', 'sequence', 'reason', 'observation', 'maxFrames', 'maxRecords', 'maxSerializedBytes', 'emittedRecords',
      'droppedFrames', 'truncated', 'malformedFrames', 'unmatchedFrames', 'observerFaults', 'request'])
      || raw.schema !== 'mb.mobile-range-window-trace.v1' || raw.maxFrames !== 25 || raw.maxRecords !== 512 || raw.maxSerializedBytes !== 262144
      || !integer(raw.sequence) || raw.sequence < 1 || raw.sequence > 25 || !integer(raw.emittedRecords) || raw.emittedRecords > 512
      || !integer(raw.droppedFrames) || raw.droppedFrames > COUNTER_MAX || typeof raw.truncated !== 'boolean'
      || !['malformedFrames', 'unmatchedFrames', 'observerFaults'].every(key => integer(raw[key]) && (raw[key] as number) <= COUNTER_MAX)
      || !choice(raw.reason, ['claim', 'http-terminal', 'late-settled', 'budget'])) return null;
    const request = raw.request === null ? null : copyTraceRequest(raw.request);
    if (raw.request !== null && !request || raw.reason === 'budget' !== (request === null)
      || raw.reason === 'budget' && (!raw.truncated || raw.droppedFrames < 1)
      || request && raw.emittedRecords < request.records.length || request && (raw.reason === 'claim' ? request.httpTerminal : !request.httpTerminal)
      || raw.reason === 'late-settled' && request?.pendingSpans !== 0
      || raw.observation !== observation(request, raw.truncated, Number(raw.malformedFrames) + Number(raw.unmatchedFrames) + Number(raw.observerFaults))) return null;
    const copy = { ...raw, request } as unknown as WindowTraceFrame;
    return Buffer.byteLength(MOBILE_RANGE_WINDOW_TRACE_PREFIX + JSON.stringify(copy) + '\n') <= 262144 ? copy : null;
  } catch { return null; }
}
export interface MobileRangeContinuousTraceFrame {
  schema: 'mb.mobile-range-window-trace.v2'; sequence: number; reason: WindowReason | 'budget';
  observation: WindowTraceFrame['observation'] | 'suppressed';
  maxRequests: 8; maxRecordsPerRequest: 64; maxRecords: 512; maxSerializedBytes: 262144; maxObservedRequests: 4096;
  observedRequests: number; retiredRequests: number; suppressedRequests: number; counterLimitReached: boolean; observerClosed: boolean;
  retainedOrdinals: number[]; retainedRecords: number; droppedFrames: number; truncated: boolean;
  malformedFrames: number; unmatchedFrames: number; observerFaults: number; clockFaults: number;
  request: RequestSnapshot | null;
}
const MAX_CONTINUOUS_FRAMES = MAX_TOTAL_REQUESTS * 4 + 1;
/** 新私有行协议只承载本次窗口与有界索引，不把全部历史快照积在App RAM。 */
export function copyMobileRangeContinuousTraceFrame(raw: unknown): MobileRangeContinuousTraceFrame | null {
  try {
    const keys = ['schema', 'sequence', 'reason', 'observation', 'maxRequests', 'maxRecordsPerRequest', 'maxRecords', 'maxSerializedBytes',
      'maxObservedRequests', 'observedRequests', 'retiredRequests', 'suppressedRequests', 'counterLimitReached', 'observerClosed',
      'retainedOrdinals', 'retainedRecords', 'droppedFrames', 'truncated', 'malformedFrames', 'unmatchedFrames', 'observerFaults', 'clockFaults', 'request'];
    if (!closed(raw, keys) || raw.schema !== 'mb.mobile-range-window-trace.v2' || raw.maxRequests !== 8 || raw.maxRecordsPerRequest !== 64
      || raw.maxRecords !== 512 || raw.maxSerializedBytes !== 262144 || raw.maxObservedRequests !== MAX_TOTAL_REQUESTS
      || !integer(raw.sequence) || raw.sequence < 1 || raw.sequence > MAX_CONTINUOUS_FRAMES
      || !integer(raw.observedRequests) || raw.observedRequests > MAX_TOTAL_REQUESTS || !integer(raw.retiredRequests)
      || !integer(raw.retainedRecords) || raw.retainedRecords > 512
      || !['suppressedRequests', 'droppedFrames', 'malformedFrames', 'unmatchedFrames', 'observerFaults', 'clockFaults'].every(key => integer(raw[key]) && (raw[key] as number) <= COUNTER_MAX)
      || raw.counterLimitReached !== (raw.observedRequests === MAX_TOTAL_REQUESTS) || typeof raw.observerClosed !== 'boolean'
      || typeof raw.truncated !== 'boolean' || !choice(raw.reason, ['claim', 'http-terminal', 'late-settled', 'budget'])) return null;
    const retained = copyRetainedOrdinals(raw.retainedOrdinals);
    if (!retained || raw.observedRequests !== raw.retiredRequests + retained.length || (retained.at(-1) ?? 0) !== raw.observedRequests) return null;
    const request = raw.request === null ? null : copyTraceRequest(raw.request, MAX_TOTAL_REQUESTS);
    if (raw.request !== null && !request || (raw.reason === 'budget') !== (request === null)
      || raw.reason === 'budget' && (!raw.truncated || raw.suppressedRequests === 0 || raw.droppedFrames === 0)
      || Number(raw.suppressedRequests) > 0 && !raw.truncated
      || request && (!retained.includes(request.ordinal) || request.records.length > raw.retainedRecords
        || request.droppedRecords > 0 && !raw.truncated || (raw.reason === 'claim' ? request.httpTerminal : !request.httpTerminal))
      || raw.reason === 'late-settled' && request?.pendingSpans !== 0) return null;
    const faults = Number(raw.malformedFrames) + Number(raw.unmatchedFrames) + Number(raw.observerFaults);
    const expected = request ? observation(request, raw.truncated, faults) : raw.counterLimitReached ? 'budget-exhausted' : 'suppressed';
    if (raw.observation !== expected) return null;
    const copied = { ...raw, retainedOrdinals: retained, request } as unknown as MobileRangeContinuousTraceFrame;
    return Buffer.byteLength(MOBILE_RANGE_WINDOW_TRACE_PREFIX + JSON.stringify(copied) + '\n') <= 262144 ? copied : null;
  } catch { return null; }
}
function continuousTraceWriter(options: { enabled: boolean; sink(line: string): void }) {
  let sequence = 0, lastBudgetOrdinal = -1;
  const phases = new Map<number, Set<WindowReason>>();
  return (snapshot: MobileRangeContinuousSnapshot, reason: WindowReason | 'budget', ordinal: number): void => {
    if (!options.enabled || !snapshot.enabled || sequence >= MAX_CONTINUOUS_FRAMES) return;
    const retained = snapshot.requests.map(row => row.ordinal);
    for (const key of phases.keys()) if (!retained.includes(key)) phases.delete(key);
    const request = reason === 'budget' ? null : snapshot.requests.find(row => row.ordinal === ordinal) ?? null;
    if (reason === 'budget' ? lastBudgetOrdinal === snapshot.observedRequests : !request || phases.get(ordinal)?.has(reason)) return;
    const frame: MobileRangeContinuousTraceFrame = { schema: 'mb.mobile-range-window-trace.v2', sequence: sequence + 1, reason,
      observation: request ? observation(request, snapshot.truncated, snapshot.malformedFrames + snapshot.unmatchedFrames + snapshot.observerFaults)
        : snapshot.counterLimitReached ? 'budget-exhausted' : 'suppressed',
      maxRequests: 8, maxRecordsPerRequest: 64, maxRecords: 512, maxSerializedBytes: 262144, maxObservedRequests: MAX_TOTAL_REQUESTS,
      observedRequests: snapshot.observedRequests, retiredRequests: snapshot.retiredRequests, suppressedRequests: snapshot.suppressedRequests,
      counterLimitReached: snapshot.counterLimitReached, observerClosed: snapshot.observerClosed, retainedOrdinals: retained,
      retainedRecords: snapshot.requests.reduce((sum, row) => sum + row.records.length, 0), droppedFrames: snapshot.suppressedRequests,
      truncated: snapshot.truncated, malformedFrames: snapshot.malformedFrames, unmatchedFrames: snapshot.unmatchedFrames,
      observerFaults: snapshot.observerFaults, clockFaults: snapshot.clockFaults, request };
    if (!copyMobileRangeContinuousTraceFrame(frame)) return;
    sequence++;
    if (reason === 'budget') lastBudgetOrdinal = snapshot.observedRequests;
    else { const seen = phases.get(ordinal) ?? new Set<WindowReason>(); seen.add(reason); phases.set(ordinal, seen); }
    try { options.sink(MOBILE_RANGE_WINDOW_TRACE_PREFIX + JSON.stringify(frame) + '\n'); } catch { /* 消耗此旁注，绝不重放业务。 */ }
  };
}

/** 独立总预算包括重复终态/迟到更新：最多24个窗口帧＋1个耗尽帧、512条序列化记录、256KiB。 */
export function createMobileRangeWindowTraceWriter(options: { enabled: boolean; sink(line: string): void }) {
  let sequence = 0, bytes = 0, records = 0, droppedFrames = 0, exhausted = false;
  const phases = new Map<number, Set<WindowReason>>();
  const sendContinuous = continuousTraceWriter(options);
  const send = (frame: WindowTraceFrame): void => {
    const line = MOBILE_RANGE_WINDOW_TRACE_PREFIX + JSON.stringify(frame) + '\n'; bytes += Buffer.byteLength(line); sequence = frame.sequence;
    try { options.sink(line); } catch { /* 写失败仍消耗本次预算，绝不重放原工作。 */ }
  };
  return (raw: unknown, reason: WindowReason | 'budget', ordinal: number): void => {
    if (!options.enabled) return;
    try {
      const continuous = copyMobileRangeContinuousSnapshot(raw);
      if (continuous) { if (choice(reason, ['claim', 'http-terminal', 'late-settled', 'budget'])) sendContinuous(continuous, reason, ordinal); return; }
      if (exhausted) return;
      const snapshot = copyMobileRangeWindowSnapshot(raw);
      if (!snapshot?.enabled || !choice(reason, ['claim', 'http-terminal', 'late-settled']) || !integer(ordinal) || ordinal < 1 || ordinal > 8) return;
      const request = snapshot.requests[ordinal - 1]; if (!request || phases.get(ordinal)?.has(reason)) return;
      const frame: WindowTraceFrame = { schema: 'mb.mobile-range-window-trace.v1', sequence: sequence + 1, reason,
        observation: observation(request, snapshot.truncated, snapshot.malformedFrames + snapshot.unmatchedFrames + snapshot.observerFaults),
        maxFrames: 25, maxRecords: 512, maxSerializedBytes: 262144, emittedRecords: records + request.records.length, droppedFrames,
        truncated: snapshot.truncated, malformedFrames: snapshot.malformedFrames, unmatchedFrames: snapshot.unmatchedFrames,
        observerFaults: snapshot.observerFaults, request };
      const lineBytes = Buffer.byteLength(MOBILE_RANGE_WINDOW_TRACE_PREFIX + JSON.stringify(frame) + '\n');
      if (sequence >= 24 || frame.emittedRecords > 512 || bytes + lineBytes > 262144 - 1024) {
        exhausted = true; droppedFrames = bump(droppedFrames);
        send({ ...frame, reason: 'budget', observation: 'budget-exhausted', request: null, emittedRecords: records, droppedFrames, truncated: true });
        return;
      }
      if (!copyMobileRangeWindowTraceFrame(frame)) return;
      const seen = phases.get(ordinal) ?? new Set<WindowReason>(); seen.add(reason); phases.set(ordinal, seen);
      records = frame.emittedRecords; send(frame);
    } catch { /* 任何坏诊断输入都不能改变HTTP、授权或清理。 */ }
  };
}
