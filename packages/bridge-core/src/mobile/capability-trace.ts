import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { writeSync } from 'node:fs';
import { types } from 'node:util';

export const MOBILE_CAPABILITY_TRACE_PREFIX = 'MUSICBRIDGE_MOBILE_CAPABILITY_TRACE ';
export const MOBILE_CAPABILITY_TRACE_SCHEMA = 'mb.mobile-capability-trace.v1';
const discoveryNames = ['ui', 'artwork', 'tracks', 'daily', 'recommended', 'albums', 'charts', 'fm'] as const;
const discoveryStatuses = [200, 400, 401, 403, 404, 409, 410, 413, 429, 503, 'not-sent', 'failure-unknown'] as const;
export type MobileDiscoveryFailureStage = `http.discovery.${typeof discoveryNames[number]}.${typeof discoveryStatuses[number]}`;
const discoveryFailureStages = discoveryNames.flatMap(name => discoveryStatuses.map(status => `http.discovery.${name}.${status}` as MobileDiscoveryFailureStage));
export const MOBILE_CAPABILITY_STAGES = [
  ...discoveryFailureStages,
  'http.receive', 'http.send', 'http.failure', 'main.current', 'main.auth', 'main.initial-qualification', 'main.encode',
  'http.status.200', 'http.status.400', 'http.status.401', 'http.status.403', 'http.status.404',
  'http.status.409', 'http.status.410', 'http.status.413', 'http.status.429', 'http.status.503',
  'main.beforeSend.alive', 'main.beforeSend.qualification', 'main.beforeSend.auth',
  'content.initialize.cache', 'content.initialize.wait', 'content.rpc.initialize', 'content.rpc.scope', 'content.rpc.cancel', 'content.rpc.other',
  'content.rpc.dispatch', 'content.rpc.revalidate', 'content.rpc.artwork', 'content.rpc.source',
  'core.dispatch.admission', 'core.dispatch.admission.active-full', 'core.dispatch.admission.snapshots-full',
  'core.dispatch.scope.before', 'core.dispatch.content', 'core.dispatch.scope.after', 'core.dispatch.snapshot.capture', 'core.dispatch.reply.capture',
  'core.content.failure', 'core.content.capture', 'core.provider.read', 'core.provider.capture',
  'main.catalog.tracks.owner', 'main.catalog.tracks.snapshot', 'main.catalog.tracks.read',
  'main.catalog.tracks.beforeSend', 'main.catalog.tracks.auth',
  'core.rpc.failure', 'core.rpc.initialize.cache', 'core.rpc.initialize.wait', 'core.rpc.scope.resolve',
  'core.rpc.scope.assert.before', 'core.rpc.scope.qualified', 'core.rpc.scope.assert.after',
  'core.initialize.owner.prepare', 'core.initialize.owner.initialize', 'core.initialize.assemble',
  'core.scope.provider-tail', 'core.scope.account.first', 'core.scope.queue', 'core.scope.account.second',
  'core.scope.owner.update', 'core.scope.assert', 'core.assert.account',
  'provider.account.ready', 'provider.account.auth-expired', 'provider.account.not-configured',
  'provider.account.timeout', 'provider.account.shape', 'provider.account.unknown',
  'provider.content.feed', 'provider.content.mapping', 'provider.content.song-detail', 'provider.content.stream', 'provider.content.audio-probe',
  'owner.rpc.link', 'owner.rpc.receive', 'owner.rpc.failure', 'owner.content.initialize',
  'owner.content.store.create', 'owner.content.store.load', 'owner.store.directory', 'owner.store.file.open',
  'owner.store.file.read', 'owner.store.envelope', 'owner.store.decrypt', 'owner.store.state', 'owner.store.read',
  'owner.store.file.close', 'owner.store.directory.close', 'owner.store.load.map',
  'preparation.http.identity', 'preparation.http.session', 'preparation.http.body', 'preparation.http.decode',
  'preparation.http.intent',
  'preparation.http.dispatch', 'preparation.http.capture', 'preparation.http.beforeSend', 'preparation.http.terminal',
  'preparation.main.service', 'preparation.main.auth', 'preparation.main.control', 'preparation.main.encode',
  'preparation.main.beforeSend.current', 'preparation.main.beforeSend.auth', 'preparation.main.beforeSend.reply',
  'preparation.auth.admission', 'preparation.auth.queued-admission', 'preparation.auth.owner-load',
  'preparation.auth.envelope', 'preparation.auth.decrypt', 'preparation.auth.capture', 'preparation.auth.pending',
  'preparation.playback.open', 'preparation.playback.owner-load', 'preparation.playback.envelope',
  'preparation.playback.decrypt', 'preparation.playback.state', 'preparation.playback.pending',
  'preparation.playback.recovery-save', 'preparation.playback.expire-save', 'preparation.playback.session-save',
  'preparation.playback.save-admission', 'preparation.playback.candidate', 'preparation.playback.seal',
  'preparation.playback.owner-save', 'preparation.playback.ack', 'preparation.playback.published',
  'preparation.playback.device',
] as const;
export type MobileCapabilityStage = typeof MOBILE_CAPABILITY_STAGES[number];
export type MobileCapabilityRole = 'business' | 'cleanup';
export type MobileCapabilityComponent = 'main' | 'core' | 'owner';
export type MobileCapabilityIdKind = 'http' | 'content' | 'owner';
export type MobileCapabilityInitState = 'none' | 'new-pending' | 'reuse-pending' | 'reuse-fulfilled' | 'reuse-rejected' | 'fulfilled' | 'rejected';
const phases = ['begin', 'ok', 'reject', 'link', 'cache'] as const;
const states: readonly MobileCapabilityInitState[] = ['none', 'new-pending', 'reuse-pending', 'reuse-fulfilled', 'reuse-rejected', 'fulfilled', 'rejected'];
const codes = ['OK', 'UNKNOWN', 'BUSY', 'INVALID_REQUEST', 'UNAUTHORIZED', 'FORBIDDEN', 'SOURCE_CHANGED', 'RESOURCE_REVOKED',
  'CONTENT_LIMIT_EXCEEDED', 'IDEMPOTENCY_CONFLICT', 'REVISION_CONFLICT', 'CURSOR_INVALID', 'RESOURCE_BUSY', 'RESOURCE_RELEASED', 'DEVICE_REVOKED', 'SERVICE_RESTARTED',
  'UNSUPPORTED_FORMAT', 'NOT_READY', 'TIMEOUT', 'INVALID_IPC_RESPONSE', 'INTERNAL_ERROR', 'ABORT_ERR',
  'ENOENT', 'EACCES', 'EPERM', 'EIO', 'ENOSPC', 'EBADF', 'EMFILE', 'ENFILE', 'ERR_OSSL_BAD_DECRYPT',
  'NETEASE_REQUEST_FAILED', 'NETEASE_NOT_CONFIGURED', 'AUTH_EXPIRED'] as const;
const names = ['UNKNOWN', 'Error', 'TypeError', 'RangeError', 'AbortError', 'MobileServiceError', 'MobileAuthPersistenceError',
  'MobileContentPersistenceError', 'MobilePlaybackError', 'DatasetOwnerTransportError', 'DatasetOwnerDispatchError', 'CoreIpcError', 'BridgeError'] as const;
const fields = ['schema', 'component', 'requestSha256', 'parentSha256', 'relatedSha256', 'epochMs', 'elapsedMs',
  'stage', 'phase', 'role', 'name', 'code', 'outcome', 'aborted', 'initState'] as const;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const sha = /^[a-f0-9]{64}$/u;
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const choice = <T extends string>(value: unknown, values: readonly T[]): value is T => typeof value === 'string' && values.includes(value as T);
const nullableSha = (value: unknown): value is string | null => value === null || typeof value === 'string' && sha.test(value);
export interface MobileCapabilityTraceRecord {
  schema: typeof MOBILE_CAPABILITY_TRACE_SCHEMA; component: MobileCapabilityComponent;
  requestSha256: string; parentSha256: string | null; relatedSha256: string | null;
  epochMs: number; elapsedMs: number; stage: MobileCapabilityStage; phase: typeof phases[number]; role: MobileCapabilityRole;
  name: typeof names[number]; code: typeof codes[number]; outcome: 'not-sent' | 'unknown' | null;
  aborted: boolean | null; initState: MobileCapabilityInitState;
}
export interface MobileCapabilityTraceSnapshot {
  schema: typeof MOBILE_CAPABILITY_TRACE_SCHEMA; records: MobileCapabilityTraceRecord[];
  firstBusinessFailures: MobileCapabilityTraceRecord[]; cleanupFailures: MobileCapabilityTraceRecord[]; droppedRecords: number;
}
function closed(raw: unknown, keys: readonly string[]): raw is Record<string, unknown> {
  try {
    if (!raw || typeof raw !== 'object' || types.isProxy(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return false;
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    return Reflect.ownKeys(descriptors).length === keys.length && keys.every(key => descriptors[key]?.enumerable === true && Object.hasOwn(descriptors[key]!, 'value'));
  } catch { return false; }
}
/** 只接收数据属性及闭集分类；未知字段、代理、getter、正文或异常文本整条拒收。 */
export function copyMobileCapabilityTraceRecord(raw: unknown): MobileCapabilityTraceRecord | null {
  try {
    if (!closed(raw, fields) || raw.schema !== MOBILE_CAPABILITY_TRACE_SCHEMA || !choice(raw.component, ['main', 'core', 'owner'])
      || typeof raw.requestSha256 !== 'string' || !sha.test(raw.requestSha256) || !nullableSha(raw.parentSha256) || !nullableSha(raw.relatedSha256)
      || !integer(raw.epochMs) || !integer(raw.elapsedMs) || !choice(raw.stage, MOBILE_CAPABILITY_STAGES) || !choice(raw.phase, phases)
      || !choice(raw.role, ['business', 'cleanup']) || !choice(raw.name, names) || !choice(raw.code, codes)
      || raw.outcome !== null && !choice(raw.outcome, ['not-sent', 'unknown']) || raw.aborted !== null && typeof raw.aborted !== 'boolean'
      || !choice(raw.initState, states)) return null;
    return Object.freeze(Object.fromEntries(fields.map(key => [key, raw[key]]))) as unknown as MobileCapabilityTraceRecord;
  } catch { return null; }
}
export function createMobileCapabilityTraceCollector() {
  const records: MobileCapabilityTraceRecord[] = [], first = new Map<string, MobileCapabilityTraceRecord>(), cleanup = new Map<string, MobileCapabilityTraceRecord>();
  let droppedRecords = 0;
  function retain(map: Map<string, MobileCapabilityTraceRecord>, key: string, record: MobileCapabilityTraceRecord): void {
    if (map.has(key)) return;
    if (map.size >= 64) { map.delete(map.keys().next().value!); droppedRecords++; }
    map.set(key, record);
  }
  return {
    record(raw: unknown): void {
      const record = copyMobileCapabilityTraceRecord(raw); if (!record) { droppedRecords++; return; }
      records.push(record); if (records.length > 256) { records.shift(); droppedRecords++; }
      if (record.phase === 'reject') {
        const key = `${record.component}:${record.requestSha256}`;
        retain(record.role === 'business' ? first : cleanup, record.role === 'business' ? key : `${key}:${record.stage}`, record);
      }
    },
    snapshot(): MobileCapabilityTraceSnapshot {
      return { schema: MOBILE_CAPABILITY_TRACE_SCHEMA, records: records.map(row => ({ ...row })),
        firstBusinessFailures: [...first.values()].map(row => ({ ...row })), cleanupFailures: [...cleanup.values()].map(row => ({ ...row })), droppedRecords };
    },
  };
}
export function copyMobileCapabilityTraceSnapshot(raw: unknown): MobileCapabilityTraceSnapshot | null {
  try {
    if (!closed(raw, ['schema', 'records', 'firstBusinessFailures', 'cleanupFailures', 'droppedRecords'])
      || raw.schema !== MOBILE_CAPABILITY_TRACE_SCHEMA || !integer(raw.droppedRecords)) return null;
    const read = (value: unknown, maximum: number): MobileCapabilityTraceRecord[] | null => {
      if (!Array.isArray(value) || types.isProxy(value) || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) return null;
      const rows: MobileCapabilityTraceRecord[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
        const row = copyMobileCapabilityTraceRecord(descriptor.value); if (!row) return null; rows.push(row);
      }
      return rows;
    };
    const records = read(raw.records, 256), firstBusinessFailures = read(raw.firstBusinessFailures, 64), cleanupFailures = read(raw.cleanupFailures, 64);
    if (!records || !firstBusinessFailures || !cleanupFailures || firstBusinessFailures.some(row => row.role !== 'business' || row.phase !== 'reject')
      || cleanupFailures.some(row => row.role !== 'cleanup' || row.phase !== 'reject')) return null;
    return { schema: MOBILE_CAPABILITY_TRACE_SCHEMA, records, firstBusinessFailures, cleanupFailures, droppedRecords: raw.droppedRecords };
  } catch { return null; }
}
/** 每个原child独立保半行；不转发其他stdout，过长行丢到下一换行，不保无界缓存。 */
export function createMobileCapabilityTraceReader(accept: (record: MobileCapabilityTraceRecord) => void): (chunk: string) => void {
  let partial = '', discarding = false;
  return chunk => {
    try {
      if (typeof chunk !== 'string' || chunk.length > 1024 * 1024) { partial = ''; discarding = true; return; }
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf('\n', offset), end = newline < 0 ? chunk.length : newline, segment = chunk.slice(offset, end);
        if (!discarding) {
          if (Buffer.byteLength(partial) + Buffer.byteLength(segment) > 4096) { partial = ''; discarding = true; }
          else partial += segment;
        }
        if (newline < 0) return;
        if (!discarding && partial.startsWith(MOBILE_CAPABILITY_TRACE_PREFIX)) {
          try {
            const raw: unknown = JSON.parse(partial.slice(MOBILE_CAPABILITY_TRACE_PREFIX.length)), record = copyMobileCapabilityTraceRecord(raw);
            if (record) { try { accept(record); } catch { /* 诊断接收失败不影响原stdout和业务。 */ } }
          } catch { /* 单行损坏只丢本行，同chunk后续闭集记录继续读取。 */ }
        }
        partial = ''; discarding = false; offset = newline + 1;
      }
    } catch { partial = ''; discarding = false; }
  };
}
const processCollector = createMobileCapabilityTraceCollector();
export function collectMobileCapabilityTrace(raw: unknown): void { try { processCollector.record(raw); } catch { /* 私有旁注不影响原请求。 */ } }
export const snapshotMobileCapabilityTrace = (): MobileCapabilityTraceSnapshot => processCollector.snapshot();
export interface MobileCapabilityContext {
  readonly requestSha256: string; readonly parentSha256: string | null; readonly component: MobileCapabilityComponent;
  readonly startedAtMs: number; readonly signal?: AbortSignal; readonly sink: (line: string) => void;
  records: number; closed: boolean; firstBusiness: boolean; firstCleanup: boolean;
  /** 仅私有HTTP探针使用；总量仍64，给HTTP终态留下16槽。成功feed的旁注不入全局环。 */
  httpTerminalReserve?: boolean; deferredRecords?: MobileCapabilityTraceRecord[];
  /** 仅可信私有诊断组合根设置，不序列化到HTTP或RPC。 */
  privateContentDiagnostic?: true;
  preparation?: boolean; droppedRecords?: number; clockFault?: boolean;
  preparationLimit?: 64 | 192;
  preparationIntentSha256?: string;
  lastAtMs?: number;
  pendingOperations?: number; closeRequested?: boolean;
  now?: () => number; epochNow?: () => number;
}
const storage = new AsyncLocalStorage<MobileCapabilityContext>();
export const captureMobileCapabilityContext = (): MobileCapabilityContext | undefined => storage.getStore();
/** ID只来自原受控信封；分域散列不包含身份/账号/路径，也不生成新nonce。 */
export function mobileCapabilityRequestSha(kind: MobileCapabilityIdKind, id: string): string | null {
  try { return choice(kind, ['http', 'content', 'owner']) && typeof id === 'string' && uuid.test(id)
    ? createHash('sha256').update(`MusicBridge:capability:${kind}:1\0${id}`, 'utf8').digest('hex') : null; }
  catch { return null; }
}
export function createMobileCapabilityContext(id: string, component: MobileCapabilityComponent, kind: MobileCapabilityIdKind,
  parentSha256: string | null = storage.getStore()?.requestSha256 ?? null, signal?: AbortSignal,
  sink: (line: string) => void = line => { writeSync(1, line); },
  clock?: { now?: () => number; epochNow?: () => number }): MobileCapabilityContext | undefined {
  try {
    const requestSha256 = mobileCapabilityRequestSha(kind, id);
    if (!requestSha256 || !choice(component, ['main', 'core', 'owner']) || !nullableSha(parentSha256)) return undefined;
    const startedAtMs = clock?.now ? clock.now() : performance.now();
    if (!Number.isFinite(startedAtMs) || startedAtMs < 0) return undefined;
    return { requestSha256, parentSha256, component, startedAtMs, ...(signal ? { signal } : {}), sink,
      ...(clock?.now ? { now: clock.now } : {}), ...(clock?.epochNow ? { epochNow: clock.epochNow } : {}),
      records: 0, closed: false, firstBusiness: false, firstCleanup: false };
  } catch { return undefined; }
}
/** 即使ALS本身失败，原工作最多执行一次；已有原返回/异常不被诊断重放替换。 */
export function withMobileCapabilityContext<T>(context: MobileCapabilityContext | undefined, work: () => T): T {
  if (!context) return work();
  let result: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
  const once = (): T => {
    if (result) { if (result.ok) return result.value; throw result.error; }
    try { const value = work(); result = { ok: true, value }; return value; }
    catch (error) { result = { ok: false, error }; throw error; }
  };
  try { return storage.run(context, once); } catch { return once(); }
}
function own(error: unknown, key: string): unknown {
  try {
    if (!error || typeof error !== 'object' || types.isProxy(error)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(error, key); return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch { return undefined; }
}
function emit(stage: MobileCapabilityStage, phase: MobileCapabilityTraceRecord['phase'], role: MobileCapabilityRole = 'business', error?: unknown,
  relatedSha256: string | null = null, initState: MobileCapabilityInitState = 'none'): void {
  try {
    const context = storage.getStore(); if (!context || context.closed && role !== 'cleanup') return;
    const first = phase === 'reject' && (role === 'business' ? !context.firstBusiness : !context.firstCleanup);
    // 准备链保留原多次认证的完整顺序；两种旁注均为首拒预留四槽。
    const originalMaximum = context.preparationLimit ?? 64;
    const maximum = context.httpTerminalReserve && !stage.startsWith('http.') ? Math.min(48, originalMaximum) : originalMaximum;
    if (context.records >= maximum || context.records >= maximum - 4 && !first && !(phase === 'reject' && role === 'cleanup')) {
      if (context.preparation) context.droppedRecords = (context.droppedRecords ?? 0) + 1;
      return;
    }
    const code = own(error, 'code'), name = own(error, 'name'), outcome = own(error, 'outcome');
    let at: number, epoch: number;
    try {
      at = context.now ? context.now() : performance.now(); epoch = context.epochNow ? context.epochNow() : Date.now();
      if (!Number.isFinite(at) || at < (context.lastAtMs ?? context.startedAtMs) || !integer(epoch)) throw new Error();
      context.lastAtMs = at;
    } catch {
      if (context.preparation) { context.clockFault = true; context.droppedRecords = (context.droppedRecords ?? 0) + 1; }
      return;
    }
    const record = copyMobileCapabilityTraceRecord({ schema: MOBILE_CAPABILITY_TRACE_SCHEMA, component: context.component,
      requestSha256: context.requestSha256, parentSha256: context.parentSha256,
      relatedSha256: relatedSha256 ?? context.preparationIntentSha256 ?? null,
      epochMs: epoch, elapsedMs: Math.floor(at - context.startedAtMs), stage, phase, role,
      name: choice(name, names) ? name : 'UNKNOWN', code: phase !== 'reject' ? 'OK' : choice(code, codes) ? code : 'UNKNOWN',
      outcome: choice(outcome, ['not-sent', 'unknown']) ? outcome : null,
      aborted: context.signal ? context.signal.aborted : null, initState });
    if (!record) return;
    if (phase === 'reject') { if (role === 'business') context.firstBusiness = true; else context.firstCleanup = true; }
    context.records++;
    if (context.deferredRecords) { if (context.deferredRecords.length < 64) context.deferredRecords.push(record); return; }
    collectMobileCapabilityTrace(record);
    const line = MOBILE_CAPABILITY_TRACE_PREFIX + JSON.stringify(record) + '\n';
    if (Buffer.byteLength(line) <= 4096) context.sink(line);
  } catch { /* 白名单提取、sink或计时失败都不能替换原返回/异常，不能读取私密异常正文。 */ }
}
/** 每类最多八次需求，只保首个代表成功和首个失败；成功不会消耗失败槽。 */
export function createMobileContentSampleSelector() {
  const names = { getUIContentCapabilities: 'ui', getArtwork: 'artwork', listTracks: 'tracks', getNeteaseDailyRecommendations: 'daily',
    listNeteaseRecommendedPlaylists: 'recommended', listNeteaseNewAlbums: 'albums', listNeteaseCharts: 'charts', getNeteasePersonalFM: 'fm' } as const;
  const states = new Map<string, { attempts: number; completed: number; success: boolean; failure: boolean; exhausted: boolean }>();
  return { claim(operation: string) {
    if (!Object.hasOwn(names, operation)) return undefined;
    const name = names[operation as keyof typeof names];
    const state = states.get(name) ?? { attempts: 0, completed: 0, success: false, failure: false, exhausted: false };
    states.set(name, state);
    if (state.attempts >= 8 || state.success && state.failure) return undefined;
    state.attempts++; let settled = false;
    return { finish(context: MobileCapabilityContext | undefined, status: number | undefined, failed: boolean, finished: boolean): void {
      if (settled) return; settled = true; state.completed++;
      const isFailure = failed || !finished || status !== 200 || context?.firstBusiness === true;
      const publish = isFailure ? !state.failure : !state.success;
      if (isFailure) state.failure = true; else state.success = true;
      const unknown = state.completed >= 8 && !state.failure && !state.exhausted;
      if (unknown) state.exhausted = true;
      const value = typeof status === 'number' && [200,400,401,403,404,409,410,413,429,503].includes(status) ? status : 'not-sent';
      publishMobileDiscoveryFailure(context, `http.discovery.${name}.${value}` as MobileDiscoveryFailureStage, publish, isFailure,
        unknown ? `http.discovery.${name}.failure-unknown` : undefined);
    } };
  } };
}
/** 发布时仍不超过原64条，保原首错及HTTP末段；未捕获失败明确为UNKNOWN。 */
export function publishMobileDiscoveryFailure(context: MobileCapabilityContext | undefined, stage: MobileDiscoveryFailureStage,
  publish = true, failed = true, unknownStage?: MobileDiscoveryFailureStage): void {
  try {
    if (!context?.deferredRecords) return;
    const rows = context.deferredRecords; delete context.deferredRecords;
    const first = rows.find(row => row.phase === 'reject' && row.role === 'business');
    const representative = failed ? first ?? rows.at(-1) : rows.at(-1);
    if (!representative) return;
    const summary = publish ? copyMobileCapabilityTraceRecord({ ...representative, stage,
      ...(failed && !first ? { phase: 'reject', code: 'UNKNOWN', outcome: 'unknown' } : {}) }) : null;
    const unknown = unknownStage ? copyMobileCapabilityTraceRecord({ ...representative, stage: unknownStage, phase: 'cache', code: 'UNKNOWN', outcome: 'unknown' }) : null;
    const prefix = [...(summary ? [summary] : []), ...(unknown ? [unknown] : []), ...(publish && first ? [first] : [])];
    if (!prefix.length) return;
    const output = [...prefix, ...(publish ? rows.slice(-(64 - prefix.length)) : [])];
    for (const raw of output) {
      const row = copyMobileCapabilityTraceRecord(raw); if (!row) continue;
      collectMobileCapabilityTrace(row); const line = MOBILE_CAPABILITY_TRACE_PREFIX + JSON.stringify(row) + '\n';
      if (Buffer.byteLength(line) <= 4096) { try { context.sink(line); } catch { /* 旁注不改变原请求。 */ } }
    }
  } catch { /* 发布/校验失败不替换原异常，也不重演HTTP请求。 */ }
}
export function mobileCapabilityReject(stage: MobileCapabilityStage, error: unknown, role: MobileCapabilityRole = 'business'): void { emit(stage, 'reject', role, error); }
/** 新内容旁注必须同时有可信开关所建上下文；缺省直接执行原工作一次。 */
function privateContentDiagnosticEnabled(): boolean {
  try { return storage.getStore()?.privateContentDiagnostic === true; } catch { return false; }
}
export function mobileContentDiagnosticSync<T>(stage: MobileCapabilityStage, work: () => T): T {
  return privateContentDiagnosticEnabled() ? mobileCapabilitySync(stage, work) : work();
}
export function mobileContentDiagnosticAsync<T>(stage: MobileCapabilityStage, work: () => Promise<T>): Promise<T> {
  return privateContentDiagnosticEnabled() ? mobileCapabilityAsync(stage, work) : work();
}
export function mobileContentDiagnosticReject(stage: MobileCapabilityStage, error: unknown): void {
  if (privateContentDiagnosticEnabled()) mobileCapabilityReject(stage, error);
}
export function mobileCapabilitySync<T>(stage: MobileCapabilityStage, work: () => T, role: MobileCapabilityRole = 'business'): T {
  emit(stage, 'begin', role);
  try { const value = work(); emit(stage, 'ok', role); return value; }
  catch (error) { mobileCapabilityReject(stage, error, role); throw error; }
}
export async function mobileCapabilityAsync<T>(stage: MobileCapabilityStage, work: () => Promise<T>, role: MobileCapabilityRole = 'business'): Promise<T> {
  emit(stage, 'begin', role);
  try { const value = await work(); emit(stage, 'ok', role); return value; }
  catch (error) { mobileCapabilityReject(stage, error, role); throw error; }
}
export function mobileCapabilityCache(stage: MobileCapabilityStage, state: Exclude<MobileCapabilityInitState, 'none'>, relatedSha256: string | null): void {
  emit(stage, 'cache', 'business', undefined, relatedSha256, state);
}
export function mobileCapabilityLink(kind: MobileCapabilityIdKind, id: string, stage: MobileCapabilityStage): string | null {
  const hash = mobileCapabilityRequestSha(kind, id); if (hash) emit(stage, 'link', 'business', undefined, hash); return hash;
}
export function closeMobileCapabilityContext(context: MobileCapabilityContext | undefined): void {
  if (!context) return;
  if (context.preparation && (context.pendingOperations ?? 0) > 0) context.closeRequested = true;
  else context.closed = true;
}

/** 新旁注只在获准的准备窗口工作；普通能力诊断及默认构建保留原调用。 */
function preparationContext(): MobileCapabilityContext | undefined {
  try { const context = storage.getStore(); return context?.preparation && !context.closed ? context : undefined; }
  catch { return undefined; }
}
/** 原后台timer仅脱离准备旁注；普通能力上下文及原work执行次数不变。 */
export function withoutMobilePreparationContext<T>(work: () => T): T {
  let preparation = false;
  try { preparation = storage.getStore()?.preparation === true; } catch { /* 无诊断上下文时执行原work。 */ }
  if (!preparation) return work();
  let result: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
  const once = (): T => {
    if (result) { if (result.ok) return result.value; throw result.error; }
    try { const value = work(); result = { ok: true, value }; return value; }
    catch (error) { result = { ok: false, error }; throw error; }
  };
  try { return storage.exit(once); } catch { return once(); }
}
export function mobilePreparationSync<T>(stage: MobileCapabilityStage, work: () => T): T {
  return preparationContext() ? mobileCapabilitySync(stage, work) : work();
}
export function mobilePreparationAsync<T>(stage: MobileCapabilityStage, work: () => Promise<T>): Promise<T> {
  const context = preparationContext(); if (!context) return work();
  context.pendingOperations = (context.pendingOperations ?? 0) + 1;
  const settled = () => {
    context.pendingOperations = (context.pendingOperations ?? 1) - 1;
    if (context.closeRequested && context.pendingOperations === 0) context.closed = true;
  };
  return mobileCapabilityAsync(stage, work).then(value => { settled(); return value; }, error => { settled(); throw error; });
}

const PREPARATION_SCHEMA = 'mb.mobile-preparation-evidence.v1' as const;
type PreparationOperation = 'getServer' | 'createSession';
interface PreparationScope {
  operation: PreparationOperation; requestSha256: string; intentSha256: string | null;
  terminal: 'pending' | 'ok' | 'reject' | 'incomplete' | 'intermediate';
  httpStatus: number | null; responseFinished: boolean; clockFault: boolean; workPending: boolean; trace: MobileCapabilityTraceSnapshot;
}
export interface MobilePreparationSnapshot {
  schema: typeof PREPARATION_SCHEMA; armed: boolean; identityClaims: number; identityDropped: number;
  identitiesStopped: boolean; sessionClaimed: boolean; sessionClaims: number; sessionDropped: number; sessionIntentSha256: string | null;
  discardedScopes: number; contextFaults: number; truncated: boolean; scopes: PreparationScope[];
}
export interface MobilePreparationProbe {
  arm(): void;
  claim(operation: string, requestId: string, signal: AbortSignal): MobileCapabilityContext | undefined;
  associateSession(context: MobileCapabilityContext | undefined, key: unknown): void;
  finish(context: MobileCapabilityContext | undefined, result: { failed: boolean; finished: boolean; httpStatus: number | null }): void;
  snapshot(): MobilePreparationSnapshot;
}
/** 八个原身份确认及同一会话意图最多两次原HTTP；401刷新重放不生成新业务。 */
export function createMobilePreparationProbe(options: {
  enabled?: boolean; now?: () => number; epochNow?: () => number; sink?: (record: Readonly<MobileCapabilityTraceRecord>) => void;
} = {}): MobilePreparationProbe {
  let armed = false, identityClaims = 0, identityDropped = 0, identitiesStopped = false, sessionClaims = 0, contextFaults = 0;
  let sessionDropped = 0, sessionIntentSha256: string | null = null, discardedScopes = 0, sessionStopped = false, retryEligible = false;
  const scopes = new Map<MobileCapabilityContext, { scope: PreparationScope; collector: ReturnType<typeof createMobileCapabilityTraceCollector> }>();
  return {
    arm() { try { if (options.enabled === true) armed = true; } catch { /* 诊断选项不影响原回包。 */ } },
    claim(operation, requestId, signal) {
      try {
        if (options.enabled !== true || !armed || operation !== 'getServer' && operation !== 'createSession') return undefined;
        if (operation === 'getServer') {
          if (identitiesStopped || identityClaims >= 8) { identityDropped = Math.min(Number.MAX_SAFE_INTEGER, identityDropped + 1); return undefined; }
          identityClaims++;
        } else {
          if (sessionStopped || sessionClaims >= 2 || sessionClaims === 1 && !retryEligible) {
            sessionDropped = Math.min(Number.MAX_SAFE_INTEGER, sessionDropped + 1); return undefined;
          }
          sessionClaims++; retryEligible = false;
        }
        const collector = createMobileCapabilityTraceCollector();
        const reader = createMobileCapabilityTraceReader(record => { collector.record(record); options.sink?.(record); });
        const context = createMobileCapabilityContext(requestId, 'main', 'http', null, signal, reader, options);
        if (!context) { contextFaults++; return undefined; }
        context.preparation = true; context.preparationLimit = operation === 'createSession' ? 192 : 64;
        context.droppedRecords = 0; context.clockFault = false;
        scopes.set(context, { collector, scope: { operation, requestSha256: context.requestSha256, intentSha256: null, terminal: 'pending',
          httpStatus: null, responseFinished: false, clockFault: false, workPending: false, trace: collector.snapshot() } });
        return context;
      } catch { contextFaults = Math.min(10, contextFaults + 1); return undefined; }
    },
    associateSession(context, key) {
      try {
        if (!context) return;
        const entry = scopes.get(context); if (!entry || entry.scope.operation !== 'createSession') return;
        if (typeof key !== 'string' || key.length < 1 || key.length > 256) {
          contextFaults++; scopes.delete(context); sessionStopped = true; closeMobileCapabilityContext(context); return;
        }
        const hash = createHash('sha256').update(`MusicBridge:preparation:session-intent:1\0${key}`, 'utf8').digest('hex');
        if (sessionIntentSha256 !== null && hash !== sessionIntentSha256) {
          discardedScopes++; sessionDropped++; scopes.delete(context); sessionStopped = true;
          closeMobileCapabilityContext(context); return;
        }
        sessionIntentSha256 = hash; entry.scope.intentSha256 = hash; context.preparationIntentSha256 = hash;
        withMobileCapabilityContext(context, () => emit('preparation.http.intent', 'link', 'business', undefined, hash));
      } catch {
        if (context && scopes.delete(context)) { contextFaults++; sessionStopped = true; closeMobileCapabilityContext(context); }
      }
    },
    finish(context, result) {
      try {
        if (!context) return;
        const entry = scopes.get(context); if (!entry || entry.scope.terminal !== 'pending') return;
        withMobileCapabilityContext(context, () => mobileCapabilitySync('preparation.http.terminal', () => undefined));
        const intermediate = result.finished && entry.scope.operation === 'createSession' && result.httpStatus === 401
          && sessionClaims === 1 && entry.scope.intentSha256 !== null;
        entry.scope.terminal = !result.finished ? 'incomplete' : intermediate ? 'intermediate' : result.failed ? 'reject' : 'ok';
        entry.scope.httpStatus = result.httpStatus;
        entry.scope.responseFinished = result.finished;
        if (entry.scope.operation === 'createSession') { retryEligible = intermediate; sessionStopped = !intermediate; }
        if (entry.scope.operation === 'getServer' && result.failed || entry.scope.operation === 'createSession' && !intermediate) identitiesStopped = true;
      } catch { /* 领取及落定均是旁注，不改变原业务。 */ }
    },
    snapshot() {
      const captured = [...scopes.entries()].map(([context, { scope, collector }]) => {
        const trace = collector.snapshot(); trace.droppedRecords += context.droppedRecords ?? 0;
        return { ...scope, clockFault: context.clockFault === true, workPending: (context.pendingOperations ?? 0) > 0, trace };
      });
      return { schema: PREPARATION_SCHEMA, armed, identityClaims, identityDropped, identitiesStopped, sessionClaimed: sessionClaims > 0,
        sessionClaims, sessionDropped, sessionIntentSha256, discardedScopes, contextFaults,
        truncated: identityDropped > 0 || sessionDropped > 0 || contextFaults > 0 || captured.some(row => row.clockFault || row.trace.droppedRecords > 0), scopes: captured };
    },
  };
}
/** 仅复制有界闭集和安全分类；不执行访问器，也不接受正文或未知字段。 */
export function copyMobilePreparationSnapshot(raw: unknown): MobilePreparationSnapshot | null {
  try {
    if (!closed(raw, ['schema', 'armed', 'identityClaims', 'identityDropped', 'identitiesStopped', 'sessionClaimed',
      'sessionClaims', 'sessionDropped', 'sessionIntentSha256', 'discardedScopes', 'contextFaults', 'truncated', 'scopes'])
      || raw.schema !== PREPARATION_SCHEMA || typeof raw.armed !== 'boolean' || !integer(raw.identityClaims) || raw.identityClaims > 8
      || !integer(raw.identityDropped) || typeof raw.identitiesStopped !== 'boolean' || typeof raw.sessionClaimed !== 'boolean'
      || !integer(raw.sessionClaims) || raw.sessionClaims > 2 || raw.sessionClaimed !== (raw.sessionClaims > 0)
      || !integer(raw.sessionDropped) || !nullableSha(raw.sessionIntentSha256) || !integer(raw.discardedScopes) || raw.discardedScopes > 1
      || !integer(raw.contextFaults) || raw.contextFaults > 10 || typeof raw.truncated !== 'boolean' || !Array.isArray(raw.scopes) || types.isProxy(raw.scopes)
      || raw.scopes.length > 10 || Reflect.ownKeys(raw.scopes).length !== raw.scopes.length + 1) return null;
    const scopes: PreparationScope[] = [], hashes = new Set<string>();
    for (let index = 0; index < raw.scopes.length; index++) {
      const field = Object.getOwnPropertyDescriptor(raw.scopes, String(index));
      if (!field?.enumerable || !Object.hasOwn(field, 'value')) return null;
      const row: unknown = field.value;
      if (!closed(row, ['operation', 'requestSha256', 'intentSha256', 'terminal', 'httpStatus', 'responseFinished', 'clockFault', 'workPending', 'trace'])
        || !choice(row.operation, ['getServer', 'createSession']) || typeof row.requestSha256 !== 'string' || !sha.test(row.requestSha256)
        || hashes.has(row.requestSha256) || !nullableSha(row.intentSha256)
        || row.intentSha256 !== null && (row.operation !== 'createSession' || row.intentSha256 !== raw.sessionIntentSha256)
        || !choice(row.terminal, ['pending', 'ok', 'reject', 'incomplete', 'intermediate'])
        || row.httpStatus !== null && (!integer(row.httpStatus) || row.httpStatus < 100 || row.httpStatus > 599)
        || typeof row.responseFinished !== 'boolean' || typeof row.clockFault !== 'boolean' || typeof row.workPending !== 'boolean') return null;
      if (row.terminal === 'intermediate' && (row.operation !== 'createSession' || row.httpStatus !== 401 || row.intentSha256 === null)) return null;
      const trace = copyMobileCapabilityTraceSnapshot(row.trace);
      if (!trace || trace.records.length > (row.operation === 'createSession' ? 192 : 64) || trace.firstBusinessFailures.length > 1
        || [...trace.records, ...trace.firstBusinessFailures, ...trace.cleanupFailures].some(record =>
          record.component !== 'main' || record.requestSha256 !== row.requestSha256 || record.parentSha256 !== null
          || record.relatedSha256 !== null && record.relatedSha256 !== row.intentSha256)) return null;
      hashes.add(row.requestSha256);
      scopes.push({ operation: row.operation, requestSha256: row.requestSha256, intentSha256: row.intentSha256 as string | null, terminal: row.terminal,
        httpStatus: row.httpStatus as number | null, responseFinished: row.responseFinished, clockFault: row.clockFault, workPending: row.workPending, trace });
    }
    if (scopes.filter(row => row.operation === 'getServer').length > raw.identityClaims
      || scopes.filter(row => row.operation === 'createSession').length > raw.sessionClaims
      || scopes.length + raw.contextFaults + raw.discardedScopes !== raw.identityClaims + raw.sessionClaims
      || raw.truncated !== (raw.identityDropped > 0 || raw.sessionDropped > 0 || raw.contextFaults > 0 || scopes.some(row => row.clockFault || row.trace.droppedRecords > 0))
      || !raw.armed && (raw.identityClaims !== 0 || raw.sessionClaimed || raw.contextFaults !== 0 || raw.identityDropped !== 0 || raw.identitiesStopped || raw.sessionDropped !== 0)) return null;
    return { schema: PREPARATION_SCHEMA, armed: raw.armed, identityClaims: raw.identityClaims, identityDropped: raw.identityDropped,
      identitiesStopped: raw.identitiesStopped, sessionClaimed: raw.sessionClaimed, sessionClaims: raw.sessionClaims, sessionDropped: raw.sessionDropped,
      sessionIntentSha256: raw.sessionIntentSha256 as string | null, discardedScopes: raw.discardedScopes,
      contextFaults: raw.contextFaults, truncated: raw.truncated, scopes };
  } catch { return null; }
}
