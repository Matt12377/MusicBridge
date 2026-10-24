import { types } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { constants as zlibConstants, deflateRawSync, inflateRawSync } from 'node:zlib';
import { MOBILE_CODEC_LIMITS, mobileCanonicalJson, mobileDataSnapshot, parseMobileJson, type MobileJsonValue } from '@music-bridge/contracts';
import { MOBILE_PLAYBACK_DEFAULT_LIMITS, MOBILE_PLAYBACK_STATE_LOGICAL_NODE_LIMIT, MOBILE_PLAYBACK_TERMINAL_FAILURE_BUDGET, MobilePlaybackError,
  type MobilePlaybackLimits, type MobilePlaybackTerminalFailureBudget, type MobilePlaybackStateCodecContext, type MobilePlaybackStateCodecPort } from './playback-types.js';
import { PLAYBACK_STATE_SCHEMA, capturePlaybackState, decodePlaybackState, playbackCanonical, playbackFailure, playbackInteger, type PlaybackState, type StoredPlaybackResource, type StoredPlaybackReceipt, type StoredPlaybackSession } from './playback-state.js';

export const PLAYBACK_COMPACT_SCHEMA = 'mbm002.playback-compact-state.v2';
export const PLAYBACK_SHAPE_SCHEMA = 'mbm002.playback-compact-state.v3';
export const PLAYBACK_STRING_SCHEMA = 'mbm002.playback-compact-state.v4';
export const PLAYBACK_SELECTIVE_STRING_SCHEMA = 'mbm002.playback-compact-state.v5';
export const PLAYBACK_BLOCK_SCHEMA = 'mbm002.playback-block-state.v6';
export const PLAYBACK_SHARED_BYTES_PER_RECEIPT = 8 * 1024;
// 物理报文/字典继续守200k；共享请求展开后的逻辑历史单独计费，不能由压缩或重复引用免除。
const PHYSICAL_NODE_LIMIT = 200_000, LOGICAL_NODE_LIMIT = MOBILE_PLAYBACK_STATE_LOGICAL_NODE_LIMIT, DEPTH_LIMIT = 24;
// 四位base36覆盖200k项；引用仍为一个标量，不增加节点或嵌套层。
const STRING_PREFIX = '~', STRING_WIDTH = 4, STRING_THRESHOLD = 16;
const STRING_REF_BYTES = 2 + STRING_PREFIX.length + STRING_WIDTH;
const internString = (value: string): boolean => value.startsWith(STRING_PREFIX) || textBytes(value) >= STRING_THRESHOLD;
const storedStringBytes = (value: string): number => internString(value) ? STRING_REF_BYTES : textBytes(value);
const futureStringBytes = (maximum: number): number => Math.max(STRING_REF_BYTES, Math.min(maximum, STRING_THRESHOLD - 1));
const stateKeys = ['schema', 'serverId', 'datasetId', 'revision', 'commitId', 'clockFloor', 'sessions', 'resources', 'receipts'];
const receiptKeys = ['id', 'operation', 'deviceId', 'deviceEpoch', 'keyHash', 'fingerprint', 'scopeHash', 'request', 'createdAt', 'sessionId', 'resourceId', 'state', 'reply', 'resourceContext'];
const requestKeys = ['path', 'pathParameters', 'query', 'body'];
const contextKeys = ['scope', 'capabilitySnapshotIdentity', 'responseOrigin', 'resourceFormatBitDepth', 'capabilityVersion', 'request', 'source', 'sourceAudio', 'expectedResourceId', 'hlsAllowed'];
type Data = Record<string, unknown>;
interface Stats { nodes: number; bytes: number; height: number }
interface Measurements {
  root: Stats; stringsWellFormed: boolean;
  known(value: object): Stats | undefined;
  stats(value: unknown): Stats;
}
interface RefPlan { value: unknown; stats: Stats; sharedBytes: number; materialize(): unknown }
function bad(): never { return playbackFailure(503, 'BUSY'); }
function full(): never { return playbackFailure(429, 'RESOURCE_BUSY'); }
export type PlaybackStorageRejectionBoundary = 'worker-raw' | 'worker-state' | 'terminal-logical' | 'v3-physical' | 'terminal-v3-reserve' | 'v4-physical' | 'terminal-v4-reserve';
const rejectionBoundaries = new WeakMap<object, PlaybackStorageRejectionBoundary>();
/** 仅可信Worker携回固定阶段；不向公开错误附加状态值、字段路径或原始对象。 */
export function readPlaybackStorageRejectionBoundary(error: unknown): PlaybackStorageRejectionBoundary | null {
  return error !== null && typeof error === 'object' ? rejectionBoundaries.get(error) ?? null : null;
}
function budgetBoundary<T>(boundary: PlaybackStorageRejectionBoundary, work: () => T): T {
  try { return work(); } catch (error) {
    if (error && typeof error === 'object' && !types.isProxy(error) && error instanceof MobilePlaybackError
      && error.status === 429 && error.code === 'RESOURCE_BUSY' && !rejectionBoundaries.has(error)) rejectionBoundaries.set(error, boundary);
    throw error;
  }
}
const json = (v: unknown) => mobileCanonicalJson(v as MobileJsonValue);
const textBytes = (s: string) => Buffer.byteLength(JSON.stringify(s));
const unpairedSurrogate = /[\ud800-\udfff]/u;
function object(v: unknown): v is Data {
  return !!v && typeof v === 'object' && !types.isProxy(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
}
function closed(v: unknown, keys: readonly string[]): v is Data {
  if (!object(v)) return false;
  const d = Object.getOwnPropertyDescriptors(v);
  return Reflect.ownKeys(d).length === keys.length && keys.every(k => d[k]?.enumerable && Object.hasOwn(d[k]!, 'value'));
}
function dense(v: unknown, max: number): v is unknown[] {
  if (!Array.isArray(v) || types.isProxy(v) || Object.getPrototypeOf(v) !== Array.prototype || v.length > max || Reflect.ownKeys(v).length !== v.length + 1) return false;
  for (let i = 0; i < v.length; i++) { const d = Object.getOwnPropertyDescriptor(v, String(i)); if (!d?.enumerable || !Object.hasOwn(d, 'value')) return false; }
  return true;
}
function configuration(limits: Readonly<MobilePlaybackLimits>): void {
  for (const k of ['stateBytes', 'maxStoredSessions', 'maxStoredResources', 'maxReceipts'] as const)
    if (!playbackInteger(limits[k], 1, MOBILE_PLAYBACK_DEFAULT_LIMITS[k])) bad();
}
function bound(limits: Readonly<MobilePlaybackLimits>): number {
  return limits.stateBytes + limits.maxReceipts * PLAYBACK_SHARED_BYTES_PER_RECEIPT;
}
function within(s: Stats, maximum: number, reject: () => never, nodeMaximum = LOGICAL_NODE_LIMIT): Stats {
  if (!playbackInteger(s.nodes, 1, nodeMaximum) || !playbackInteger(s.bytes, 1, maximum) || !playbackInteger(s.height, 0, DEPTH_LIMIT)) reject();
  return s;
}
function objectStats(fields: readonly [string, Stats][], maximum: number, reject: () => never, nodeMaximum = LOGICAL_NODE_LIMIT): Stats {
  const s = { nodes: 1, bytes: 2, height: 0 };
  for (const [i, [k, v]] of fields.entries()) {
    s.nodes += v.nodes; s.bytes += textBytes(k) + 1 + v.bytes + Number(i > 0); s.height = Math.max(s.height, 1 + v.height);
    within(s, maximum, reject, nodeMaximum);
  }
  return s;
}
function arrayStats(values: readonly Stats[], maximum: number, reject: () => never, nodeMaximum = LOGICAL_NODE_LIMIT): Stats {
  const s = { nodes: 1, bytes: 2, height: 0 };
  for (const [i, v] of values.entries()) {
    s.nodes += v.nodes; s.bytes += v.bytes + Number(i > 0); s.height = Math.max(s.height, 1 + v.height); within(s, maximum, reject, nodeMaximum);
  }
  return s;
}
/** 描述符读取及累计预算在任何逻辑展开/语义复制之前完成，重复引用仍逐次计数。 */
function measure(raw: unknown, maximum: number, reject: () => never, nodeMaximum = LOGICAL_NODE_LIMIT,
  trusted?: Measurements, checkText = trusted !== undefined): Measurements {
  const cache = new WeakMap<object, Stats>(), active = new Set<object>(); let work = 0;
  let stringsWellFormed = trusted?.stringsWellFormed ?? true;
  // Unicode模式把合法代理对视为一个码点；仅未配对代理字符留在此区间。
  const inspectText = (value: string) => { if (checkText && unpairedSurrogate.test(value)) stringsWellFormed = false; };
  function walk(v: unknown, depth: number): Stats {
    if (++work > nodeMaximum || depth > DEPTH_LIMIT) reject();
    if (v === null || typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') {
      if (typeof v === 'number' && (!Number.isFinite(v) || Number.isInteger(v) && !Number.isSafeInteger(v))) bad();
      if (typeof v === 'string') inspectText(v);
      const encoded = JSON.stringify(v); if (encoded === undefined) bad();
      return within({ nodes: 1, bytes: Buffer.byteLength(encoded), height: 0 }, maximum, reject, nodeMaximum);
    }
    if (!v || typeof v !== 'object' || types.isProxy(v) || active.has(v)) bad();
    const array = Array.isArray(v); if (array ? Object.getPrototypeOf(v) !== Array.prototype : !object(v)) bad();
    const previous = trusted?.known(v);
    if (previous) {
      // 仅来自本次同步encode自有中间树；每次引用都重新累计节点及相对深度。
      work += previous.nodes - 1;
      if (work > nodeMaximum || depth + previous.height > DEPTH_LIMIT) reject();
      cache.set(v, previous); return within(previous, maximum, reject, nodeMaximum);
    }
    active.add(v);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(v), keys = Reflect.ownKeys(descriptors);
      if (keys.some(k => typeof k !== 'string')) bad();
      let result: Stats;
      if (array) {
        const length = descriptors.length?.value as unknown;
        if (!playbackInteger(length, 0, nodeMaximum) || keys.length !== length + 1) bad();
        const rows: Stats[] = [];
        for (let i = 0; i < length; i++) { const d = descriptors[String(i)]; if (!d?.enumerable || !Object.hasOwn(d, 'value')) bad(); rows.push(walk(d.value, depth + 1)); }
        result = arrayStats(rows, maximum, reject, nodeMaximum);
      } else {
        const rows: [string, Stats][] = [];
        for (const key of keys as string[]) { const d = descriptors[key]; if (!d?.enumerable || !Object.hasOwn(d, 'value')) bad(); inspectText(key); rows.push([key, walk(d.value, depth + 1)]); }
        result = objectStats(rows, maximum, reject, nodeMaximum);
      }
      cache.set(v, result); return result;
    } finally { active.delete(v); }
  }
  const root = walk(raw, 0);
  const known = (value: object): Stats | undefined => cache.get(value) ?? trusted?.known(value);
  return { root, stringsWellFormed: checkText && stringsWellFormed, known, stats(v: unknown): Stats {
    if (v && typeof v === 'object') return known(v) ?? bad();
    if (v !== null && !['string', 'number', 'boolean'].includes(typeof v)) return bad();
    return { nodes: 1, bytes: Buffer.byteLength(JSON.stringify(v)), height: 0 };
  } };
}
function arrays(raw: Data, limits: Readonly<MobilePlaybackLimits>): void {
  if (!dense(raw.sessions, limits.maxStoredSessions) || !dense(raw.resources, limits.maxStoredResources) || !dense(raw.receipts, limits.maxReceipts)) bad();
}
function contextTemplate(v: Data): Data {
  return Object.fromEntries(Object.entries(v).filter(([key]) => key !== 'now'));
}
function selection(v: Data, keys: readonly string[]): Data { return Object.fromEntries(keys.map(k => [k, v[k]])); }

const failureShapes = [
  ['body', 'status'], ['error'], ['code', 'message', 'requestId', 'retryable'],
  ['code', 'message', 'requestId', 'retryAfterMs', 'retryable'],
] as const;
type ShapePacking = { schema: typeof PLAYBACK_SHAPE_SCHEMA; shapes: string[][]; root: unknown };
const atom = (bytes: number): Stats => ({ nodes: 1, bytes, height: 0 });
const maxStats = (a: Stats, b: Stats): Stats => ({ nodes: Math.max(a.nodes, b.nodes), bytes: Math.max(a.bytes, b.bytes), height: Math.max(a.height, b.height) });
function terminalBudget(raw: unknown): Readonly<MobilePlaybackTerminalFailureBudget> {
  if (raw === undefined) return MOBILE_PLAYBACK_TERMINAL_FAILURE_BUDGET;
  const keys = Object.keys(MOBILE_PLAYBACK_TERMINAL_FAILURE_BUDGET);
  if (!closed(raw, keys) || keys.some(k => raw[k] !== MOBILE_PLAYBACK_TERMINAL_FAILURE_BUDGET[k as keyof MobilePlaybackTerminalFailureBudget])) bad();
  return MOBILE_PLAYBACK_TERMINAL_FAILURE_BUDGET;
}
// 仅给下方同步私有构造器使用：输入已完整捕获并逐引用计量，输出不跨await、不暴露。
// 此处只汇总新建dense数组/固定对象的精确JSON统计；不是外部数据的资格入口。
interface PackingStats { value?: Stats }
function packingArrayStats(values: readonly Stats[]): Stats {
  const out: Stats = { nodes: 1, bytes: 2, height: 0 };
  for (let i = 0; i < values.length; i++) {
    const value = values[i]!;
    out.nodes += value.nodes; out.bytes += value.bytes + Number(i > 0); out.height = Math.max(out.height, 1 + value.height);
  }
  return out;
}
function packingObjectStats(fields: readonly [string, Stats][]): Stats {
  const out: Stats = { nodes: 1, bytes: 2, height: 0 };
  for (let i = 0; i < fields.length; i++) {
    const [key, value] = fields[i]!;
    out.nodes += value.nodes; out.bytes += textBytes(key) + 1 + value.bytes + Number(i > 0); out.height = Math.max(out.height, 1 + value.height);
  }
  return out;
}
function shapeTableStats(shapes: readonly string[][]): Stats {
  return packingArrayStats(shapes.map(keys => packingArrayStats(keys.map(key => atom(textBytes(key))))));
}
function packingFits(value: Stats, limits: Readonly<MobilePlaybackLimits>): boolean {
  return value.nodes <= PHYSICAL_NODE_LIMIT && value.bytes <= limits.stateBytes && value.height <= DEPTH_LIMIT;
}
/** 仅字典化键，v2的请求/context共享保持原样；数组显式0tag，标量（含null）不改。 */
function packShapes(raw: Data, prefix?: { pending: Set<object>; stableIds: Set<number> }, statistics?: PackingStats): ShapePacking {
  const shapes: string[][] = [], ids = new Map<string, number>(); let beforePending = true;
  let last: Stats = atom(4);
  function tuple(tag: number, values: readonly unknown[], read: (value: unknown) => unknown): unknown[] {
    const out: unknown[] = [tag];
    const size: Stats | undefined = statistics ? { nodes: 2, bytes: 2 + Buffer.byteLength(JSON.stringify(tag)), height: 1 } : undefined;
    for (const value of values) {
      out.push(read(value));
      if (size) { size.nodes += last.nodes; size.bytes += 1 + last.bytes; size.height = Math.max(size.height, 1 + last.height); }
    }
    if (size) last = size;
    return out;
  }
  function walk(v: unknown): unknown {
    if (v === null || typeof v !== 'object') { if (statistics) last = atom(Buffer.byteLength(JSON.stringify(v))); return v; }
    if (Array.isArray(v)) return tuple(0, v, walk);
    const row = v as Data, keys = Object.keys(row).sort(), signature = JSON.stringify(keys);
    let id = ids.get(signature);
    if (id === undefined) { id = shapes.length; ids.set(signature, id); shapes.push(keys); }
    if (prefix && beforePending) prefix.stableIds.add(id + 1);
    return tuple(id + 1, keys, key => {
      if (prefix && key === 'reply' && prefix.pending.has(row)) beforePending = false;
      return walk(row[key as string]);
    });
  }
  const root = walk(raw);
  if (statistics) statistics.value = packingObjectStats([
    ['schema', atom(textBytes(PLAYBACK_SHAPE_SCHEMA))], ['shapes', shapeTableStats(shapes)], ['root', last],
  ]);
  return { schema: PLAYBACK_SHAPE_SCHEMA, shapes, root };
}
/** 每层展开均先累计预算，再分配；形状不能引入字段遗漏、别名、原型赋值或隐含默认值。 */
function expandShapes(raw: Data, limits: Readonly<MobilePlaybackLimits>, strings?: { value(raw: string): string; complete(): void }): Data {
  if (!closed(raw, ['schema', 'shapes', 'root']) || raw.schema !== PLAYBACK_SHAPE_SCHEMA || !dense(raw.shapes, PHYSICAL_NODE_LIMIT)) bad();
  const shapes = raw.shapes, signatures = new Set<string>(), used = new Set<number>(), maximum = bound(limits);
  for (const entry of shapes) {
    if (!dense(entry, PHYSICAL_NODE_LIMIT)) bad();
    for (let i = 0; i < entry.length; i++) if (typeof entry[i] !== 'string' || i > 0 && (entry[i - 1] as string) >= (entry[i] as string)) bad();
    const signature = JSON.stringify(entry); if (signatures.has(signature)) bad(); signatures.add(signature);
  }
  function plan(v: unknown): Stats {
    if (!Array.isArray(v)) {
      if (v !== null && !['boolean', 'number', 'string'].includes(typeof v)) bad();
      const scalar = typeof v === 'string' && strings ? strings.value(v) : v;
      return atom(Buffer.byteLength(JSON.stringify(scalar)));
    }
    if (!dense(v, PHYSICAL_NODE_LIMIT) || !playbackInteger(v[0], 0, shapes.length)) bad();
    const tag = v[0];
    if (tag === 0) return arrayStats(v.slice(1).map(plan), maximum, bad, PHYSICAL_NODE_LIMIT);
    const index = tag - 1, shape = shapes[index] as string[];
    if (v.length !== shape.length + 1) bad(); used.add(index);
    return objectStats(shape.map((k, i) => [k, plan(v[i + 1])] as [string, Stats]), maximum, bad, PHYSICAL_NODE_LIMIT);
  }
  plan(raw.root); if (used.size !== shapes.length) bad(); strings?.complete();
  function materialize(v: unknown): unknown {
    if (!Array.isArray(v)) return typeof v === 'string' && strings ? strings.value(v) : v;
    if (v[0] === 0) return v.slice(1).map(materialize);
    const keys = shapes[(v[0] as number) - 1] as string[];
    return Object.fromEntries(keys.map((k, i) => [k, materialize(v[i + 1])]));
  }
  const value = materialize(raw.root); if (!object(value)) bad(); return value;
}

/** 只共享确有字节收益的重复标量；~字面量始终入表，表内值永不再解释为引用。 */
function packStrings(shape: ShapePacking, statistics?: PackingStats) {
  const strings: string[] = [], ids = new Map<string, number>(), counts = new Map<string, number>();
  function count(value: unknown): void {
    if (Array.isArray(value)) { for (const child of value) count(child); }
    else if (typeof value === 'string' && internString(value)) {
      const previous = counts.get(value);
      // 每个不同原值至少保有一个root标量节点；超过200k必不能满足原物理节点预算。
      if (previous === undefined && counts.size >= PHYSICAL_NODE_LIMIT) full();
      counts.set(value, (previous ?? 0) + 1);
    }
  }
  count(shape.root);
  let last: Stats = atom(4);
  function walk(value: unknown): unknown {
    if (Array.isArray(value)) {
      const out: unknown[] = [], size: Stats | undefined = statistics ? { nodes: 1, bytes: 2, height: 0 } : undefined;
      for (const child of value) {
        out.push(walk(child));
        if (size) { size.nodes += last.nodes; size.bytes += last.bytes + Number(out.length > 1); size.height = Math.max(size.height, 1 + last.height); }
      }
      if (size) last = size;
      return out;
    }
    if (statistics) last = atom(Buffer.byteLength(JSON.stringify(value)));
    if (typeof value !== 'string' || !internString(value)) return value;
    // 引用固定为7个JSON字节；为字典项另收1个逗号，保证选择性表示不大于全入表表示。
    const occurrences = counts.get(value)!;
    if (!value.startsWith(STRING_PREFIX) && (occurrences - 1) * textBytes(value) <= occurrences * STRING_REF_BYTES + 1) return value;
    let id = ids.get(value);
    if (id === undefined) {
      if (strings.length >= PHYSICAL_NODE_LIMIT) full();
      id = strings.length; ids.set(value, id); strings.push(value);
    }
    if (statistics) last = atom(STRING_REF_BYTES);
    return STRING_PREFIX + id.toString(36).padStart(STRING_WIDTH, '0');
  }
  const root = walk(shape.root);
  if (statistics) statistics.value = packingObjectStats([
    ['schema', atom(textBytes(PLAYBACK_SELECTIVE_STRING_SCHEMA))], ['shapes', shapeTableStats(shape.shapes)],
    ['strings', packingArrayStats(strings.map(value => atom(textBytes(value))))], ['root', last],
  ]);
  return { schema: PLAYBACK_SELECTIVE_STRING_SCHEMA, shapes: shape.shapes, strings, root };
}

function expandStrings(raw: Data, limits: Readonly<MobilePlaybackLimits>): Data {
  if (!closed(raw, ['schema', 'shapes', 'strings', 'root']) || ![PLAYBACK_STRING_SCHEMA, PLAYBACK_SELECTIVE_STRING_SCHEMA].includes(raw.schema as string) || !dense(raw.strings, PHYSICAL_NODE_LIMIT)) bad();
  const strings = raw.strings, unique = new Set<string>(), used = new Set<number>();
  for (const value of strings) {
    if (typeof value !== 'string' || !internString(value) || unique.has(value)) bad();
    unique.add(value);
  }
  return expandShapes({ schema: PLAYBACK_SHAPE_SCHEMA, shapes: raw.shapes, root: raw.root }, limits, {
    value(value) {
      if (!value.startsWith(STRING_PREFIX)) { if (raw.schema === PLAYBACK_STRING_SCHEMA && internString(value)) bad(); return value; }
      if (!/^~[0-9a-z]{4}$/u.test(value)) bad();
      const index = Number.parseInt(value.slice(1), 36);
      if (!playbackInteger(index, 0, strings.length - 1)) bad();
      used.add(index); return strings[index] as string;
    },
    complete() { if (used.size !== strings.length) bad(); },
  });
}

/**
 * 所有UNKNOWN的任意部分结算都被此正增量上界覆盖。
 * v3用所有有限错误shape的并集及统一最大tag宽度，不假设实际压缩大小单调。
 * revision/时钟按安全整数最大宽度预留；不改变任何已存回执或未知结果。
 */
function terminalAdmission(state: PlaybackState, packed: Data, limits: Readonly<MobilePlaybackLimits>, budget: Readonly<MobilePlaybackTerminalFailureBudget>,
  logicalMeasurements: Measurements, packedMeasurements?: Measurements) {
  const unknown = state.receipts.filter(r => r.operation === 'createResource' && r.state === 'UNKNOWN');
  if (!unknown.length) return { v1: true, v2: true, v3: () => true, v4: () => true };
  const maximum = bound(limits), affected = new Set(unknown.map(r => r.resourceId));
  const logicalFailure = objectStats([['status', atom(3)], ['body', objectStats([['error', objectStats([
    ['code', atom(budget.codeJsonBytes)], ['message', atom(budget.messageJsonBytes)], ['requestId', atom(budget.requestIdJsonBytes)],
    ['retryable', atom(5)], ['retryAfterMs', atom(budget.retryAfterJsonBytes)],
  ], maximum, full)]], maximum, full)]], maximum, full);
  type Changes = Map<object, Map<string, Stats>>;
  function changes(root: Data, failure: Stats, strings = false): Changes {
    const rows: Changes = new Map(), meta = new Map<string, Stats>(); rows.set(root, meta);
    meta.set('revision', atom(16)); meta.set('clockFloor', atom(16)); meta.set('commitId', atom(strings ? futureStringBytes(38) : 38));
    for (const r of root.resources as Data[]) if (affected.has(r.id as string)) rows.set(r, new Map([
      ['failure', atom(strings ? futureStringBytes(budget.codeJsonBytes) : budget.codeJsonBytes)], ['state', atom(textBytes('failed'))],
    ]));
    for (const r of root.receipts as Data[]) if (r.operation === 'createResource' && r.state === 'UNKNOWN') rows.set(r, new Map([
      ['state', atom(textBytes('RECORDED'))], ['reply', failure],
    ]));
    return rows;
  }
  type Reuse = { measurements: Measurements; dirty: Set<object> };
  function count(v: unknown, edits: Changes, nodeMaximum: number, shapeBytes?: (row: Data) => number, strings = false, reuse?: Reuse): Stats {
    if (v === null || typeof v !== 'object') return atom(typeof v === 'string' && strings ? storedStringBytes(v) : Buffer.byteLength(JSON.stringify(v)));
    if (reuse && !reuse.dirty.has(v)) {
      const previous = reuse.measurements.known(v);
      if (previous) return within(previous, maximum, full, nodeMaximum);
    }
    if (Array.isArray(v)) {
      const fields = v.map(x => count(x, edits, nodeMaximum, shapeBytes, strings, reuse));
      return arrayStats(shapeBytes === undefined ? fields : [atom(1), ...fields], maximum, full, nodeMaximum);
    }
    const row = v as Data, update = edits.get(row);
    const fields = Object.keys(row).sort().map(k => {
      const value = count(row[k], edits, nodeMaximum, shapeBytes, strings, reuse), replace = update?.get(k);
      return [k, replace ? maxStats(value, replace) : value] as [string, Stats];
    });
    return shapeBytes === undefined ? objectStats(fields, maximum, full, nodeMaximum)
      : arrayStats([atom(shapeBytes(row)), ...fields.map(([, value]) => value)], maximum, full, nodeMaximum);
  }
  function reserve(root: Data, nodeMaximum: number, measurements?: Measurements): Stats {
    const edits = changes(root, logicalFailure);
    // changes只改root元数据、资源标量及UNKNOWN回执；把两层容器和全部变更对象列为dirty。
    const reuse = measurements ? { measurements, dirty: new Set<object>([root, root.resources as object, root.receipts as object, ...edits.keys()]) } : undefined;
    return count(root, edits, nodeMaximum, undefined, false, reuse);
  }
  // 先核完整逻辑终态预算；不能借字典或共享绕过逐引用的1m/24/原逻辑字节上界。
  const logical = budgetBoundary('terminal-logical', () => reserve(state as unknown as Data, LOGICAL_NODE_LIMIT, logicalMeasurements));
  let v2 = false;
  try { v2 = reserve(packed, PHYSICAL_NODE_LIMIT, packedMeasurements).bytes <= limits.stateBytes; }
  catch (error) { if (!(error instanceof MobilePlaybackError) || error.status !== 429 || error.code !== 'RESOURCE_BUSY') throw error; }
  function shapeAdmission(strings: boolean): boolean {
    const scalarResourceChanges = state.resources.every(r => !affected.has(r.id) || r.media === null);
    const stableIds = new Set<number>(), pending = new Set((packed.receipts as Data[]).filter(r => r.operation === 'createResource' && r.state === 'UNKNOWN'));
    const shape = packShapes(packed, scalarResourceChanges ? { pending, stableIds } : undefined), union = [...shape.shapes], seen = new Set(union.map(v => JSON.stringify(v)));
    for (const keys of failureShapes) if (!seen.has(JSON.stringify(keys))) { union.push([...keys]); seen.add(JSON.stringify(keys)); }
    const digits = String(union.length).length;
    const originalIds = new Map(shape.shapes.map((keys, i) => [JSON.stringify(keys), i + 1]));
    // 此证明仅用于UNKNOWN失败结算：reply由null变错误对象，其余state/failure/revision等改动都是标量。
    // 第一个UNKNOWN.reply之前的首次shape顺序不变；后缀须连已存在但可提前的错误shape一起计入。
    // 仅四类错误shape可能新增或提前，每个旧tag至多右移四位，且不超过整个union的编号。
    const tagBytes = (row: Data): number => {
      // 旧合法UNKNOWN若已关联media对象，失败会移除子树，保留原全表位宽，不套用前缀证明。
      if (strings || !scalarResourceChanges) return digits;
      const id = originalIds.get(JSON.stringify(Object.keys(row).sort()));
      if (id === undefined) return bad();
      return String(stableIds.has(id) ? id : Math.min(union.length, id + failureShapes.length)).length;
    };
    const tuple = (values: Stats[]) => arrayStats([atom(digits), ...values], maximum, full, PHYSICAL_NODE_LIMIT);
    const failure = tuple([atom(3), tuple([tuple([
      atom(strings ? futureStringBytes(budget.codeJsonBytes) : budget.codeJsonBytes),
      atom(strings ? futureStringBytes(budget.messageJsonBytes) : budget.messageJsonBytes),
      atom(strings ? futureStringBytes(budget.requestIdJsonBytes) : budget.requestIdJsonBytes), atom(budget.retryAfterJsonBytes), atom(5),
    ])])]);
    const root = count(packed, changes(packed, failure, strings), PHYSICAL_NODE_LIMIT, tagBytes, strings);
    const table = measure(union, maximum, full, PHYSICAL_NODE_LIMIT).root;
    if (!strings) return objectStats([['schema', atom(textBytes(PLAYBACK_SHAPE_SCHEMA))], ['shapes', table], ['root', root]], maximum, full, PHYSICAL_NODE_LIMIT).bytes <= limits.stateBytes;
    // 全局commitId单列，不重复收取旧/新两项；任意子集再计算reserve不会因旧项已移除而膨胀。
    const dictionary = new Set<string>(), occurrences = new Map<string, number>(), stableOccurrences = new Map<string, number>();
    // 候选路径在任意部分结算前后固定，不把刚变为RECORDED的reply/source升级成可扣项。
    const resourceRows = new Set(packed.resources as object[]), receiptRows = new Set(packed.receipts as object[]);
    const sessionRows = new Set(packed.sessions as object[]);
    const sessionStable = new Set(['id', 'deviceId', 'deviceEpoch', 'clientInstanceId', 'createdAt']);
    const resourceStable = new Set(['id', 'sessionId', 'deviceId', 'deviceEpoch', 'request', 'createdAt']);
    const receiptStable = new Set(['id', 'operation', 'deviceId', 'deviceEpoch', 'keyHash', 'fingerprint', 'scopeHash',
      'request', 'createdAt', 'sessionId', 'resourceId']);
    function collect(v: unknown, stable = true): void {
      if (typeof v === 'string') {
        if (internString(v)) {
          dictionary.add(v); occurrences.set(v, (occurrences.get(v) ?? 0) + 1);
          if (stable) stableOccurrences.set(v, (stableOccurrences.get(v) ?? 0) + 1);
        }
        return;
      }
      if (Array.isArray(v)) { for (const child of v) collect(child, stable); return; }
      if (v && typeof v === 'object') for (const [key, child] of Object.entries(v)) {
        // 当前/未来commit碰撞统一由下方+1承担；不能先扣当前值再额外扣一次未来值。
        if (v === packed && key === 'commitId') continue;
        const allowed = sessionRows.has(v) ? sessionStable.has(key) : resourceRows.has(v) ? resourceStable.has(key)
          : receiptRows.has(v) ? receiptStable.has(key) : v !== packed || key !== 'contextTemplates';
        collect(child, stable && allowed);
      }
    }
    collect(packed);
    const entries = [...dictionary].map(value => atom(textBytes(value)));
    entries.push(atom(Math.max(38, typeof packed.commitId === 'string' ? textBytes(packed.commitId) : 0)));
    // 每个UNKNOWN至多新增reply的code/message/requestId及resource.failure四个字符串。
    for (let i = 0; i < unknown.length; i++) entries.push(atom(budget.codeJsonBytes), atom(budget.messageJsonBytes), atom(budget.requestIdJsonBytes), atom(budget.codeJsonBytes));
    const dictionaryStats = arrayStats(entries, maximum, full, PHYSICAL_NODE_LIMIT);
    // 任意UNKNOWN子集的新增/替换长串仅有：每个resource.failure，以及该回执
    // reply.body.error的code/message/requestId；root.commitId另1个。state为短常量，
    // status/revision/clock/retryAfter/retryable非字符串；media/context只移除，不作为幸存项。
    // 因而至多4U+1个固定候选唯一串会因当前/未来mutable值碰撞成为重复；root.commitId
    // 路径不参加频率或候选计数，已有其他真实重复仍完整计数。排除~后，余下每项
    // 必为literal：旧root引用7B + 字典原值B，改为root原值B，至少省7B及1个字典节点；
    // 不把可省的逗号计入下界。所有形状/逐引用逻辑/单root、table、dictionary原守门不变。
    const uniqueStable = [...stableOccurrences].filter(([value, n]) => n === 1 && occurrences.get(value) === 1
      && !value.startsWith(STRING_PREFIX)).length;
    const guaranteedLiterals = Math.max(0, uniqueStable - (4 * unknown.length + 1));
    // 仅纯数字估计先聚合：三个子树各已<=200k，再加根/schema，故上界600002。
    // 这不是输入/输出预算；扣可证下界后仍须重新满足原200k、2MiB及24层。
    const upper = objectStats([['schema', atom(textBytes(PLAYBACK_SELECTIVE_STRING_SCHEMA))], ['shapes', table], ['strings', dictionaryStats], ['root', root]],
      maximum, full, 3 * PHYSICAL_NODE_LIMIT + 2);
    return within({ nodes: upper.nodes - guaranteedLiterals, bytes: upper.bytes - guaranteedLiterals * STRING_REF_BYTES, height: upper.height },
      maximum, full, PHYSICAL_NODE_LIMIT).bytes <= limits.stateBytes;
  }
  return { v1: logical.nodes <= PHYSICAL_NODE_LIMIT && logical.bytes <= limits.stateBytes, v2, v3: () => shapeAdmission(false), v4: () => shapeAdmission(true) };
}

export interface DecodedPlaybackStorage { state: PlaybackState; canonical: string; format: 'v1' | 'v2' | 'v3' | 'v4' | 'v5' | 'v6' }
export interface EncodedPlaybackStorage extends DecodedPlaybackStorage { bytes: Uint8Array }

// v6固定八行块独立压缩；终态仅影响root及对应resource/receipt所在块，不假设全局压缩单调。
interface StorageBlock { encoding: 'raw' | 'deflate-raw'; count: number; rawBytes: number; digest: string; data: string }
const BLOCK_ROWS = 8;
interface BlockState { schema: typeof PLAYBACK_BLOCK_SCHEMA; root: StorageBlock; sessions: StorageBlock[]; resources: StorageBlock[]; receipts: StorageBlock[] }
interface BlockCache { groups: WeakMap<object, {rows: object[]; value: StorageBlock; segmentBytes: number[]}> }
export interface PlaybackStorageCapacityGroup {
  currentEncodedBytes: number; reserveBoundBytes: number; affectedBlocks: number; affectedRows: number;
  affectedRowMaxRawBytes: number; unchangedRowSegmentBytes: number;
}
export interface PlaybackStorageCapacityDiagnostic {
  schema: 'mb.playback-codec-capacity.v1'; phase: 'sample' | 'v4-physical' | 'terminal-v4-reserve';
  actualPhysicalBytes: number; futureBoundBytes: number; stateBytes: number;
  counts: { sessions: number; resources: number; receipts: number; unknown: number; tickets: number };
  groups: { root: PlaybackStorageCapacityGroup; sessions: PlaybackStorageCapacityGroup;
    resources: PlaybackStorageCapacityGroup; receipts: PlaybackStorageCapacityGroup };
}
export type PlaybackStorageCapacityObserver = (value: PlaybackStorageCapacityDiagnostic) => void;
type CapacityObservation = (phase: PlaybackStorageCapacityDiagnostic['phase'], measure: () => PlaybackStorageCapacityDiagnostic) => void;
const blockRootKeys = stateKeys.filter(key => !['sessions','resources','receipts'].includes(key));
const hashBytes = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const STORED_SEGMENT_MAX = 65_535, FINAL_STORED_SEGMENT = Buffer.from([1,0,0,255,255]);
function storedSegmentBytes(length: number): number { return length + 5 * Math.max(1,Math.ceil(length / STORED_SEGMENT_MAX)); }
/** 每段都非final且字节对齐；同一行超过LEN上限时拆成多个stored块。 */
function storedSegment(raw: Buffer): Buffer {
  const result = Buffer.allocUnsafe(storedSegmentBytes(raw.length)); let source = 0, target = 0;
  do {
    const length = Math.min(STORED_SEGMENT_MAX,raw.length-source);
    result[target] = 0; result.writeUInt16LE(length,target+1); result.writeUInt16LE(length ^ 0xffff,target+3);
    raw.copy(result,target+5,source,source+length); source += length; target += 5+length;
  } while (source < raw.length);
  return result;
}
function independentSegment(raw: Buffer): Buffer {
  // 每行创建新压缩器，不能让另一行的未来变化影响本行字典或编码。
  const compressed = deflateRawSync(raw,{level:1,finishFlush:zlibConstants.Z_SYNC_FLUSH}), stored = storedSegment(raw);
  return compressed.length < stored.length ? compressed : stored;
}
function storageBlock(values: readonly unknown[], cache?: BlockCache): StorageBlock {
  const first=values[0];
  if(first&&typeof first==='object'){
    const old=cache?.groups.get(first);
    if(old&&old.rows.length===values.length&&old.rows.every((row,i)=>row===values[i]))return old.value;
  }
  const texts=values.map(json),raw=Buffer.from(texts.join(',')),compressed=deflateRawSync(raw,{level:1});
  const segments=texts.map((text,i)=>independentSegment(Buffer.from((i?',':'')+text)));
  const base={count:values.length,rawBytes:raw.length,digest:hashBytes(raw)};
  const plain:StorageBlock={...base,encoding:'raw',data:raw.toString('base64')};
  const zipped:StorageBlock={...base,encoding:'deflate-raw',data:compressed.toString('base64')};
  const separate:StorageBlock={...base,encoding:'deflate-raw',data:Buffer.concat([...segments,FINAL_STORED_SEGMENT]).toString('base64')};
  const original=Buffer.byteLength(json(zipped))<Buffer.byteLength(json(plain))?zipped:plain;
  // 所有状态均保留此候选，包括最后一个UNKNOWN结算后；未来上界不依赖候选消失。
  const baseline=Buffer.byteLength(json(separate))<Buffer.byteLength(json(original))?separate:original;
  // 追加整块level6候选；比较完整封套，平手仍保留原候选。
  const denser:StorageBlock={...base,encoding:'deflate-raw',data:deflateRawSync(raw,{level:6}).toString('base64')};
  const result=Buffer.byteLength(json(denser))<Buffer.byteLength(json(baseline))?denser:baseline;
  if(first&&typeof first==='object')cache?.groups.set(first,{rows:[...values] as object[],value:result,segmentBytes:segments.map(segment=>segment.length)});
  return result;
}
function storageBlocks(values: readonly unknown[],cache?:BlockCache): StorageBlock[]{
  const blocks:StorageBlock[]=[];
  for(let i=0;i<values.length;i+=BLOCK_ROWS)blocks.push(storageBlock(values.slice(i,i+BLOCK_ROWS),cache));
  return blocks;
}
function blockStats(value:StorageBlock):Stats{return{nodes:6,height:1,bytes:Buffer.byteLength(json(value))};}
function sequenceStats(rows:readonly Stats[]):Stats{
  return {nodes:rows.reduce((sum,row)=>sum+row.nodes,0),height:Math.max(0,...rows.map(row=>row.height)),
    bytes:rows.reduce((sum,row)=>sum+row.bytes,Math.max(0,rows.length-1))};
}
function rawBlockBound(raw: Stats,count:number): Stats {
  return objectStats([['encoding',atom(textBytes('raw'))],['count',atom(String(count).length)],['rawBytes',atom(String(raw.bytes).length)],
    ['digest',atom(66)],['data',atom(2 + 4 * Math.ceil(raw.bytes / 3))]], Number.MAX_SAFE_INTEGER, full);
}
function independentBlockBound(raw: Stats,count:number,payloadBytes:number): Stats {
  return objectStats([['encoding',atom(textBytes('deflate-raw'))],['count',atom(String(count).length)],['rawBytes',atom(String(raw.bytes).length)],
    ['digest',atom(66)],['data',atom(2 + 4 * Math.ceil(payloadBytes / 3))]], Number.MAX_SAFE_INTEGER, full);
}
function blockFuture(state: PlaybackState, logical: Measurements, limits: Readonly<MobilePlaybackLimits>, budget: Readonly<MobilePlaybackTerminalFailureBudget>) {
  const maximum = bound(limits), unknown = new Set(state.receipts.filter(row => row.operation === 'createResource' && row.state === 'UNKNOWN'));
  const affected = new Set([...unknown].map(row => row.resourceId));
  const failure = objectStats([['status',atom(3)],['body',objectStats([['error',objectStats([
    ['code',atom(budget.codeJsonBytes)],['message',atom(budget.messageJsonBytes)],['requestId',atom(budget.requestIdJsonBytes)],
    ['retryable',atom(5)],['retryAfterMs',atom(budget.retryAfterJsonBytes)],
  ],maximum,full)]],maximum,full)]],maximum,full);
  function row(value: object, edits = new Map<string,Stats>()): Stats {
    return objectStats(Object.entries(value).map(([key, child]) => [key, edits.has(key) ? maxStats(logical.stats(child),edits.get(key)!) : logical.stats(child)]), maximum,full);
  }
  const root = selection(state as unknown as Data,blockRootKeys);
  const rootFuture = row(root,new Map([['revision',atom(16)],['clockFloor',atom(16)],['commitId',atom(38)]]));
  const sessions = state.sessions.map(value => row(value));
  const resources = state.resources.map(value => row(value, affected.has(value.id)
    ? new Map([['failure',atom(budget.codeJsonBytes)],['state',atom(textBytes('terminal'))]]) : undefined));
  const receipts = state.receipts.map(value => row(value, unknown.has(value)
    ? new Map([['state',atom(textBytes('RECORDED'))],['reply',failure]]) : undefined));
  // 同原terminal-logical：保留可能删除的media/context，不靠删除字段、压缩或共享免除原逐引用预算。
  if(unknown.size)budgetBoundary('terminal-logical',() => objectStats([...blockRootKeys.map(key => [key,
    key === 'revision' ? maxStats(logical.stats(state.revision),atom(16))
      : key === 'clockFloor' ? maxStats(logical.stats(state.clockFloor),atom(16))
      : key === 'commitId' ? maxStats(logical.stats(state.commitId),atom(38))
      : logical.stats((state as unknown as Data)[key])] as [string,Stats]),
    ['sessions',arrayStats(sessions,maximum,full)],['resources',arrayStats(resources,maximum,full)],['receipts',arrayStats(receipts,maximum,full)]],maximum,full));
  return { root,rootFuture,sessions,resources,receipts,unknown,affected };
}
function encodeBlockState(state: PlaybackState, logical: Measurements, limits: Readonly<MobilePlaybackLimits>,
  budget: Readonly<MobilePlaybackTerminalFailureBudget>, cache?: BlockCache, observeCapacity?: CapacityObservation): EncodedPlaybackStorage {
  const future = blockFuture(state,logical,limits,budget);
  // full encode也在本次调用内复用段长度；Actor仍沿原不可变行身份复用完整块。
  const blockCache=cache??{groups:new WeakMap<object,{rows:object[];value:StorageBlock;segmentBytes:number[]}>()};
  const archive: BlockState = { schema: PLAYBACK_BLOCK_SCHEMA,root:storageBlock([future.root]),
    sessions:storageBlocks(state.sessions,blockCache),resources:storageBlocks(state.resources,blockCache),receipts:storageBlocks(state.receipts,blockCache) };
  const physical = (root:Stats,sessions:Stats[],resources:Stats[],receipts:Stats[]) => objectStats([
    ['schema',atom(textBytes(PLAYBACK_BLOCK_SCHEMA))],['root',root],['sessions',arrayStats(sessions,limits.stateBytes,full,PHYSICAL_NODE_LIMIT)],
    ['resources',arrayStats(resources,limits.stateBytes,full,PHYSICAL_NODE_LIMIT)],['receipts',arrayStats(receipts,limits.stateBytes,full,PHYSICAL_NODE_LIMIT)],
  ],limits.stateBytes,full,PHYSICAL_NODE_LIMIT);
  // 原守门仍只执行一次；旁注在外层观察原错误，不把计量变成另一条准入路径。
  try { budgetBoundary('v4-physical',()=>physical(blockStats(archive.root),archive.sessions.map(blockStats),archive.resources.map(blockStats),archive.receipts.map(blockStats))); }
  catch (error) { reportCapacity('v4-physical'); throw error; }
  function reserved(blocks:StorageBlock[],rows:readonly object[],sizes:Stats[],affected:(row:object)=>boolean):Stats[]{
    return blocks.map((block,i)=>{
      const start=i*BLOCK_ROWS,part=rows.slice(start,start+BLOCK_ROWS);
      if(!part.some(affected))return blockStats(block);
      const partSizes=sizes.slice(start,start+BLOCK_ROWS),raw=sequenceStats(partSizes);
      let upper=rawBlockBound(raw,part.length);
      const cached=blockCache.groups.get(part[0]!);
      if(cached&&cached.value===block&&cached.rows.length===part.length&&cached.segmentBytes.length===part.length
        &&cached.rows.every((row,index)=>row===part[index])){
        // 不变行保留独立固定段；所有可能变化行预留raw stored，覆盖任意结算子集。
        const payload=part.reduce((bytes,row,index)=>bytes+(affected(row)
          ?storedSegmentBytes(partSizes[index]!.bytes+Number(index>0)):cached.segmentBytes[index]!),FINAL_STORED_SEGMENT.length);
        const independent=independentBlockBound(raw,part.length,payload);
        if(independent.bytes<upper.bytes)upper=independent;
      }
      return maxStats(blockStats(block),upper);
    });
  }
  if(future.unknown.size)try { budgetBoundary('terminal-v4-reserve',()=>physical(
    maxStats(blockStats(archive.root),rawBlockBound(future.rootFuture,1)),archive.sessions.map(blockStats),
    reserved(archive.resources,state.resources,future.resources,row=>future.affected.has((row as StoredPlaybackResource).id)),
    reserved(archive.receipts,state.receipts,future.receipts,row=>future.unknown.has(row as StoredPlaybackReceipt)))); }
  catch (error) { reportCapacity('terminal-v4-reserve'); throw error; }
  reportCapacity('sample');
  function reportCapacity(phase: PlaybackStorageCapacityDiagnostic['phase']): void {
    if (!observeCapacity) return;
    try {
      observeCapacity(phase, () => {
      // 完整safe sum不使用会在2MiB中途短路的within；不再次执行原准入守门。
      const sum = (values: readonly number[]): number => {
        let total = 0;
        for (const value of values) {
          if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(total += value)) throw new Error('旁注计量超界');
        }
        return total;
      };
      const arrayBytes = (values: readonly Stats[]): number => sum([2, Math.max(0, values.length - 1), ...values.map(value => value.bytes)]);
      const resourceAffected = (row: object): boolean => future.affected.has((row as StoredPlaybackResource).id);
      const receiptAffected = (row: object): boolean => future.unknown.has(row as StoredPlaybackReceipt);
      function group(blocks: StorageBlock[], rows: readonly object[], sizes: Stats[], affected: (row: object) => boolean): PlaybackStorageCapacityGroup {
        const currentEncodedBytes = arrayBytes(blocks.map(blockStats));
        const reserveBoundBytes = future.unknown.size ? arrayBytes(reserved(blocks, rows, sizes, affected)) : currentEncodedBytes;
        let affectedBlocks = 0, affectedRows = 0, affectedRowMaxRawBytes = 0, unchangedRowSegmentBytes = 0;
        for (const [i, block] of blocks.entries()) {
          const start = i * BLOCK_ROWS, part = rows.slice(start, start + BLOCK_ROWS);
          if (!part.some(affected)) continue;
          affectedBlocks++;
          const entry = blockCache.groups.get(part[0]!);
          for (const [index, row] of part.entries()) {
            if (affected(row)) { affectedRows++; affectedRowMaxRawBytes = Math.max(affectedRowMaxRawBytes, sizes[start + index]!.bytes); }
            else if (entry && entry.value === block && entry.rows.length === part.length && entry.segmentBytes.length === part.length
              && entry.rows.every((value, j) => value === part[j]))
              unchangedRowSegmentBytes = sum([unchangedRowSegmentBytes, entry.segmentBytes[index]!]);
          }
        }
        return { currentEncodedBytes, reserveBoundBytes, affectedBlocks, affectedRows, affectedRowMaxRawBytes, unchangedRowSegmentBytes };
      }
      const rootBytes = blockStats(archive.root).bytes;
      const root: PlaybackStorageCapacityGroup = { currentEncodedBytes: rootBytes,
        reserveBoundBytes: future.unknown.size ? maxStats(blockStats(archive.root), rawBlockBound(future.rootFuture, 1)).bytes : rootBytes,
        affectedBlocks: Number(future.unknown.size > 0), affectedRows: Number(future.unknown.size > 0),
        affectedRowMaxRawBytes: future.unknown.size ? future.rootFuture.bytes : 0, unchangedRowSegmentBytes: 0 };
      const sessions = group(archive.sessions, state.sessions, future.sessions, () => false);
      const resources = group(archive.resources, state.resources, future.resources, resourceAffected);
      const receipts = group(archive.receipts, state.receipts, future.receipts, receiptAffected);
      const total = (field: 'currentEncodedBytes' | 'reserveBoundBytes'): number => sum([
        2, textBytes('schema') + 1 + textBytes(PLAYBACK_BLOCK_SCHEMA),
        ...(['root', 'sessions', 'resources', 'receipts'] as const).map(key => 1 + textBytes(key) + 1 + ({ root, sessions, resources, receipts })[key][field]),
      ]);
      return { schema: 'mb.playback-codec-capacity.v1', phase, actualPhysicalBytes: total('currentEncodedBytes'),
        futureBoundBytes: total('reserveBoundBytes'), stateBytes: limits.stateBytes,
        counts: { sessions: state.sessions.length, resources: state.resources.length, receipts: state.receipts.length,
          unknown: future.unknown.size, tickets: sum(state.resources.map(row => row.tickets.length)) },
        groups: { root, sessions, resources, receipts } };
      });
    } catch { /* 旁注失败不替换原返回值、错误或持久化决定。 */ }
  }
  const canonical = json(archive);
  if (Buffer.byteLength(canonical)>limits.stateBytes) full();
  return { state,canonical,bytes:new Uint8Array(Buffer.from(canonical)),format:'v6' };
}
/** 只扫描语法/重复键/节点/深度再交JSON.parse；不能先分配超1M节点后才测预算。 */
function parseBlockJson(raw: Uint8Array, accounting: {nodes:number}, startDepth: number,count:number): unknown[] {
  let text: string; try { text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw); } catch { return bad(); }
  let at=0;
  const space=()=>{while(at<text.length&&/[\t\r\n ]/u.test(text[at]!))at++;};
  function string():string {
    const begin=at++;let escaped=false;
    while(at<text.length){const c=text[at++]!;if(!escaped&&c==='"'){
      let value:unknown;try{value=JSON.parse(text.slice(begin,at));}catch{return bad();}
      if(typeof value!=='string'||unpairedSurrogate.test(value))return bad();return value;
    }if(!escaped&&c==='\\')escaped=true;else escaped=false;}
    return bad();
  }
  function value(depth:number):void {
    if(++accounting.nodes>LOGICAL_NODE_LIMIT||depth>DEPTH_LIMIT)bad();space();const c=text[at];
    if(c==='"'){string();return;}
    if(c==='{'){at++;space();const keys=new Set<string>();if(text[at]==='}'){at++;return;}
      for(;;){space();if(text[at]!=='"')bad();const key=string();if(keys.has(key))bad();keys.add(key);space();if(text[at++]!==':')bad();value(depth+1);space();const end=text[at++];if(end==='}')return;if(end!==',')bad();}}
    if(c==='['){at++;space();if(text[at]===']'){at++;return;}for(;;){value(depth+1);space();const end=text[at++];if(end===']')return;if(end!==',')bad();}}
    for(const token of ['true','false','null'])if(text.startsWith(token,at)){at+=token.length;return;}
    const number=/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(text.slice(at));if(!number)bad();at+=number[0].length;
    const n=Number(number[0]);if(!Number.isFinite(n)||Number.isInteger(n)&&!Number.isSafeInteger(n))bad();
  }
  for(let i=0;i<count;i++){value(startDepth);space();if(i<count-1&&text[at++]!==',')bad();}
  if(at!==text.length)bad();
  let result:unknown[];try{result=JSON.parse('['+text+']') as unknown[];}catch{return bad();}
  if(result.length!==count)bad();
  // 私有v6块严格采用canonical文本，拒绝重复键、隐藏空白、非规范数字/escape别名。
  if(result.map(json).join(',')!==text)bad();return result;
}
function decodeBlockState(raw: Data, serverId:string,datasetId:string,origin:string,limits:Readonly<MobilePlaybackLimits>): PlaybackState {
  if(!closed(raw,['schema','root','sessions','resources','receipts'])||raw.schema!==PLAYBACK_BLOCK_SCHEMA
    ||!dense(raw.sessions,limits.maxStoredSessions)||!dense(raw.resources,limits.maxStoredResources)||!dense(raw.receipts,limits.maxReceipts))bad();
  const blocks=[raw.root,...raw.sessions,...raw.resources,...raw.receipts],maximum=bound(limits);let expandedBytes=0;
  for(const block of blocks){
    if(!closed(block,['encoding','count','rawBytes','digest','data'])||!['raw','deflate-raw'].includes(block.encoding as string)
      ||!playbackInteger(block.count,1,BLOCK_ROWS)||!playbackInteger(block.rawBytes,1,maximum)||typeof block.digest!=='string'||!/^([a-f0-9]{64})$/u.test(block.digest)
      ||typeof block.data!=='string'||block.data.length>4*Math.ceil(limits.stateBytes/3)||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(block.data))bad();
    expandedBytes+=block.rawBytes;if(expandedBytes>maximum)bad();
  }
  if((raw.root as Data).count!==1)bad();
  for(const [values,maximumRows]of [[raw.sessions,limits.maxStoredSessions],[raw.resources,limits.maxStoredResources],[raw.receipts,limits.maxReceipts]] as const){
    if(values.reduce<number>((sum,value)=>sum+Number((value as Data).count),0)>maximumRows
      ||values.some((value,i)=>i<values.length-1&&(value as Data).count!==BLOCK_ROWS))bad();
  }
  const accounting={nodes:3};
  function read(block:Data,depth:number):unknown[] {
    const payload=Buffer.from(block.data as string,'base64');let plain:Buffer|undefined;
    try{
      if(!payload.length||payload.length>limits.stateBytes||payload.toString('base64')!==block.data)bad();
      if(block.encoding==='raw')plain=payload;
      else{
        const inflated=inflateRawSync(payload,{maxOutputLength:block.rawBytes as number,info:true}) as unknown as {buffer:Buffer;engine:{bytesWritten:number}};
        if(!Buffer.isBuffer(inflated.buffer))bad();plain=inflated.buffer;
        if(inflated.engine.bytesWritten!==payload.length)bad();
      }
      if(!plain||plain.length!==block.rawBytes||hashBytes(plain)!==block.digest)bad();
      return parseBlockJson(plain,accounting,depth,block.count as number);
    }catch{return bad();}finally{if(plain&&plain!==payload)plain.fill(0);payload.fill(0);}
  }
  const root=read(raw.root as Data,0)[0];if(!closed(root,blockRootKeys))bad();
  const state={...root,sessions:raw.sessions.flatMap(block=>read(block as Data,2)),
    resources:raw.resources.flatMap(block=>read(block as Data,2)),receipts:raw.receipts.flatMap(block=>read(block as Data,2))};
  const measured=measure(state,maximum,bad,LOGICAL_NODE_LIMIT,undefined,true);if(!measured.stringsWellFormed)bad();
  const captured=captureCertifiedPlaybackState(state,serverId,datasetId,origin,limits);
  // UNKNOWN要按本版本确定编码重新证明未来原失败预算；不相信外来压缩器的偶然压缩率。
  if(captured.receipts.some(row=>row.operation==='createResource'&&row.state==='UNKNOWN')){
    try{encodeBlockState(captured,measure(captured,maximum,bad,LOGICAL_NODE_LIMIT,undefined,true),limits,terminalBudget(undefined));}catch{return bad();}
  }
  return captured;
}

interface ReceiptCertificate { key: string; captured: string }
interface ReceiptCertificates { binding: string; rows: Map<string, ReceiptCertificate> }
// 只保存纯校验的正向证明；不保存Owner读取、授权、水位、提交或整个解码结果。
// UTF-16字符及条目开销保守计费；超预算仅造成缓存未命中，不拒绝原本合法的账本。
const CERTIFICATE_BYTES = 32 * 1024 * 1024, CERTIFICATE_KEY_BYTES = 32 * 1024, CERTIFICATE_ROWS = MOBILE_PLAYBACK_DEFAULT_LIMITS.maxReceipts;
let receiptCertificates: ReceiptCertificates | undefined;
const framed = (values: readonly string[]) => values.map(value => `${value.length}:${value}`).join('');
function certificateInputs(raw: Data, serverId: string, datasetId: string, origin: string, limits: Readonly<MobilePlaybackLimits>) {
  // 调用前已经按描述符核过整个raw；这里不按引用身份判断值相等。
  // -0与0的JSON相同，但原整数规则可能不同；遇到负零直接退回原全量校验。
  let negativeZero = false;
  const exact = (value: unknown): string => {
    if (typeof value === 'number' && Object.is(value, -0)) negativeZero = true;
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(exact).join(',')}]`;
    const row = value as Data;
    return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${exact(row[key])}`).join(',')}}`;
  };
  if (!object(limits)) return null;
  const limitDescriptors = Object.getOwnPropertyDescriptors(limits);
  if (Reflect.ownKeys(limitDescriptors).some(key => typeof key !== 'string'
    || !Object.hasOwn(limitDescriptors[key]!, 'value') || typeof limitDescriptors[key]!.value !== 'number'
    || !Number.isFinite(limitDescriptors[key]!.value) || Object.is(limitDescriptors[key]!.value, -0))) return null;
  const binding = exact(['receipt-validation.v1', serverId, datasetId, origin,
    Object.entries(limitDescriptors).map(([key, value]) => [key, value.value]).sort(([a], [b]) => String(a).localeCompare(String(b)))]);
  const sessions = new Map<string, string>(), resources = new Map<string, string>(), ids = new Set<string>(), keys = new Set<string>();
  let parentBytes = 0, preparedBytes = 0;
  for (const [rows, target] of [[raw.sessions, sessions], [raw.resources, resources]] as const) {
    for (const row of rows as unknown[]) {
      if (!object(row) || typeof row.id !== 'string' || target.has(row.id)) return null;
      const value = exact(row); parentBytes += 2 * value.length;
      if (parentBytes > CERTIFICATE_BYTES) return null;
      target.set(row.id, value);
    }
  }
  const receipts: { id: string; raw: Data; key: string | null }[] = [];
  for (const row of raw.receipts as unknown[]) {
    if (!object(row) || typeof row.id !== 'string' || ids.has(row.id) || typeof row.deviceId !== 'string'
      || !playbackInteger(row.deviceEpoch, 1) || typeof row.keyHash !== 'string' || typeof row.sessionId !== 'string'
      || !(row.resourceId === null || typeof row.resourceId === 'string')) return null;
    ids.add(row.id);
    const unique = `${row.deviceId}:${row.deviceEpoch}:${row.keyHash}`;
    if (keys.has(unique)) return null;
    keys.add(unique);
    const session = sessions.get(row.sessionId), resource = row.resourceId === null ? '' : resources.get(row.resourceId);
    if (session === undefined || resource === undefined) return null;
    // 大父记录不能按回执次数拼接放大；超出纯缓存预算就交回原校验器。
    if (row.state !== 'RECORDED' || 2 * (session.length + resource.length) > CERTIFICATE_KEY_BYTES || preparedBytes >= CERTIFICATE_BYTES) {
      receipts.push({ id: row.id, raw: row, key: null }); continue;
    }
    const own = exact(row), size = 128 + 2 * (own.length + session.length + resource.length);
    if (size > CERTIFICATE_KEY_BYTES || preparedBytes + size > CERTIFICATE_BYTES) {
      receipts.push({ id: row.id, raw: row, key: null }); continue;
    }
    const key = framed([own, session, resource]); preparedBytes += 2 * key.length;
    receipts.push({ id: row.id, raw: row, key });
  }
  return negativeZero ? null : { binding, receipts };
}
function rememberReceiptCertificates(input: NonNullable<ReturnType<typeof certificateInputs>>, state: PlaybackState): void {
  const captured = new Map(state.receipts.map(row => [row.id, row])), rows = new Map<string, ReceiptCertificate>();
  let bytes = 0;
  for (const candidate of input.receipts) {
    // UNKNOWN始终交原校验器，终态预留也始终按当前完整账本重新计算。
    if (candidate.raw.state !== 'RECORDED' || candidate.key === null) continue;
    const value = captured.get(candidate.id); if (!value) return;
    const previous = receiptCertificates?.binding === input.binding ? receiptCertificates.rows.get(candidate.id) : undefined;
    const result = previous?.key === candidate.key ? previous.captured : JSON.stringify(value);
    const size = 128 + 2 * (candidate.id.length + candidate.key.length + result.length);
    if (rows.size >= CERTIFICATE_ROWS || bytes + size > CERTIFICATE_BYTES) continue;
    rows.set(candidate.id, { key: candidate.key, captured: result }); bytes += size;
  }
  receiptCertificates = { binding: input.binding, rows };
}
/**
 * 父记录、当前root和全局回执唯一性每次都核验；只复用完整输入及完整父记录精确相同的RECORDED正向证明。
 * 回执输出每次重新分配，缓存中的不可变字符串不会成为后续状态的可变别名。
 */
function captureCertifiedPlaybackState(raw: Data, serverId: string, datasetId: string, origin: string,
  limits: Readonly<MobilePlaybackLimits>): PlaybackState {
  const input = certificateInputs(raw, serverId, datasetId, origin, limits);
  if (!input) return capturePlaybackState(raw, serverId, datasetId, origin, limits);
  const cached = receiptCertificates?.binding === input.binding ? receiptCertificates.rows : undefined;
  const reused = new Map<string, string>(), pending: Data[] = [];
  for (const row of input.receipts) {
    const previous = row.raw.state === 'RECORDED' && row.key !== null ? cached?.get(row.id) : undefined;
    if (previous?.key === row.key) reused.set(row.id, previous.captured);
    else pending.push(row.raw);
  }
  const checked = capturePlaybackState(reused.size ? { ...raw, receipts: pending } : raw, serverId, datasetId, origin, limits);
  const fresh = new Map(checked.receipts.map(row => [row.id, row]));
  const state: PlaybackState = reused.size ? { ...checked, receipts: input.receipts.map(row => {
    const old = reused.get(row.id); return old === undefined ? fresh.get(row.id)! : JSON.parse(old) as PlaybackState['receipts'][number];
  }) } : checked;
  rememberReceiptCertificates(input, state); return state;
}

export function encodePlaybackStorage(raw: unknown, serverId: string, datasetId: string, origin: string,
  limits: Readonly<MobilePlaybackLimits>, rawBudget?: Readonly<MobilePlaybackTerminalFailureBudget>): EncodedPlaybackStorage {
  configuration(limits); const budget = terminalBudget(rawBudget); if (!closed(raw, stateKeys)) bad(); arrays(raw, limits);
  budgetBoundary('worker-raw', () => measure(raw, bound(limits), full));
  const state = budgetBoundary('worker-state', () => captureCertifiedPlaybackState(raw, serverId, datasetId, origin, limits));
  const logical = budgetBoundary('worker-state', () => measure(state, bound(limits), full, LOGICAL_NODE_LIMIT, undefined, true));
  return encodeCaptured(state, logical, limits, budget);
}
interface PackingCandidate { request: Data; context: Data | null; rq: string; rc: string | null }
function encodeCaptured(state: PlaybackState, logical: Measurements, limits: Readonly<MobilePlaybackLimits>,
  budget: Readonly<MobilePlaybackTerminalFailureBudget>, cache?: WeakMap<object, PackingCandidate>, blocks?: BlockCache, preferBlocks = false,
  observeCapacity?: CapacityObservation): EncodedPlaybackStorage {
  if (preferBlocks) return encodeBlockState(state,logical,limits,budget,blocks,observeCapacity);
  try { return encodeLegacyCaptured(state,logical,limits,budget,cache); }
  catch (error) {
    if (!(error instanceof MobilePlaybackError) || error.status!==429 || error.code!=='RESOURCE_BUSY'
      || !['v4-physical','terminal-v4-reserve'].includes(readPlaybackStorageRejectionBoundary(error) ?? '')) throw error;
    return encodeBlockState(state,logical,limits,budget,blocks,observeCapacity);
  }
}
function encodeLegacyCaptured(state: PlaybackState, logical: Measurements, limits: Readonly<MobilePlaybackLimits>,
  budget: Readonly<MobilePlaybackTerminalFailureBudget>, cache?: WeakMap<object, PackingCandidate>): EncodedPlaybackStorage {
  const requestCounts = new Map<string, number>(), contextCounts = new Map<string, number>();
  const candidates = state.receipts.map(r => {
    let value = cache?.get(r);
    if (!value) {
      const request = selection(r.request as unknown as Data, requestKeys), context = r.resourceContext === null ? null : contextTemplate(r.resourceContext as unknown as Data);
      value = { request, context, rq: json(request), rc: context === null ? null : json(context) }; cache?.set(r, value);
    }
    const { rq, rc } = value;
    if (Buffer.byteLength(rq) <= PLAYBACK_SHARED_BYTES_PER_RECEIPT) requestCounts.set(rq, (requestCounts.get(rq) ?? 0) + 1);
    if (rc !== null && Buffer.byteLength(rc) <= PLAYBACK_SHARED_BYTES_PER_RECEIPT) contextCounts.set(rc, (contextCounts.get(rc) ?? 0) + 1);
    return value;
  });
  const requestTemplates: Data[] = [], contextTemplates: Data[] = [], requestIds = new Map<string, number>(), contextIds = new Map<string, number>();
  function intern(key: string, value: Data, ids: Map<string, number>, table: Data[]): number {
    const found = ids.get(key); if (found !== undefined) return found;
    const id = table.length; ids.set(key, id); table.push(value); return id;
  }
  const receipts = state.receipts.map((r, i) => {
    const c = candidates[i]!, rqBytes = Buffer.byteLength(c.rq), rcBytes = c.rc === null ? 0 : Buffer.byteLength(c.rc);
    let rq = (requestCounts.get(c.rq) ?? 0) > 1 && rqBytes > 32, rc = c.rc !== null && (contextCounts.get(c.rc) ?? 0) > 1 && rcBytes > 32;
    if (rq && rc && rqBytes + rcBytes > PLAYBACK_SHARED_BYTES_PER_RECEIPT) { if (rqBytes >= rcBytes) rc = false; else rq = false; }
    return { ...r,
      request: rq ? { template: intern(c.rq, c.request, requestIds, requestTemplates), idempotencyKey: r.request.idempotencyKey } : r.request,
      resourceContext: rc ? { template: intern(c.rc!, c.context!, contextIds, contextTemplates), now: r.resourceContext!.now } : r.resourceContext };
  });
  const packed = { ...state, schema: PLAYBACK_COMPACT_SCHEMA, requestTemplates, contextTemplates, receipts };
  let physical: Measurements | undefined;
  if (logical.stringsWellFormed) try {
    // 仅复用本次完整捕获后且未再变更的深层值；新建的模板/引用/容器仍精确计量。
    physical = measure(packed, bound(limits), full, LOGICAL_NODE_LIMIT, logical);
  } catch (error) { if (!(error instanceof MobilePlaybackError) || error.status !== 429 || error.code !== 'RESOURCE_BUSY') throw error; }
  const admission = terminalAdmission(state, packed, limits, budget, logical, physical);
  const v1Potential = logical.root.nodes <= PHYSICAL_NODE_LIMIT && logical.root.bytes <= limits.stateBytes;
  // v1仍沿原snapshot检查；未取得完整字符串资格也走原路径，保留原数据错误优先级。
  const skipV2 = !v1Potential && physical && (physical.root.nodes > PHYSICAL_NODE_LIMIT || physical.root.bytes > limits.stateBytes);
  const checked = skipV2 ? null : mobileDataSnapshot(packed, { ...MOBILE_CODEC_LIMITS, responseBytes: limits.stateBytes, nodes: PHYSICAL_NODE_LIMIT, depth: DEPTH_LIMIT });
  const v1 = (): EncodedPlaybackStorage => {
    const canonical = playbackCanonical(state); return { state, canonical, format: 'v1', bytes: new Uint8Array(Buffer.from(canonical)) };
  };
  if (checked && !checked.ok && checked.issue.code !== 'LIMIT_EXCEEDED') bad();
  const canonical = checked?.ok ? mobileCanonicalJson(checked.value) : null;
  const v1Fits = v1Potential && admission.v1, v2Fits = canonical !== null && admission.v2;
  if (v1Fits && (!v2Fits || Buffer.byteLength(canonical!) >= logical.root.bytes)) return v1();
  if (v2Fits) return { state, canonical: canonical!, format: 'v2', bytes: new Uint8Array(Buffer.from(canonical!)) };
  // 非完整合法文本仍走原snapshot，不能让预算预判吞掉原INVALID_RESPONSE/BUSY优先级。
  const shapeStats: PackingStats = {}, shapes = packShapes(packed, undefined, logical.stringsWellFormed ? shapeStats : undefined);
  const shapeChecked = logical.stringsWellFormed ? null : mobileDataSnapshot(shapes,
    { ...MOBILE_CODEC_LIMITS, responseBytes: limits.stateBytes, nodes: PHYSICAL_NODE_LIMIT, depth: DEPTH_LIMIT });
  if (shapeChecked && !shapeChecked.ok && shapeChecked.issue.code !== 'LIMIT_EXCEEDED') bad();
  const shapeFits = shapeStats.value ? packingFits(shapeStats.value, limits) : shapeChecked?.ok === true;
  let v3Fits = false;
  if (shapeFits) try { v3Fits = admission.v3(); }
  catch (error) { if (!(error instanceof MobilePlaybackError) || error.status !== 429 || error.code !== 'RESOURCE_BUSY') throw error; }
  if (shapeFits && v3Fits) {
    const compact = mobileCanonicalJson((shapeChecked?.ok ? shapeChecked.value : shapes) as MobileJsonValue);
    if (shapeStats.value && Buffer.byteLength(compact) !== shapeStats.value.bytes) bad();
    return { state, canonical: compact, format: 'v3', bytes: new Uint8Array(Buffer.from(compact)) };
  }
  const stringStats: PackingStats = {};
  const dictionary = budgetBoundary('v4-physical', () => {
    const packedStrings = packStrings(shapes, logical.stringsWellFormed ? stringStats : undefined);
    if (stringStats.value) { within(stringStats.value, limits.stateBytes, full, PHYSICAL_NODE_LIMIT); return packedStrings; }
    const value = mobileDataSnapshot(packedStrings, { ...MOBILE_CODEC_LIMITS, responseBytes: limits.stateBytes, nodes: PHYSICAL_NODE_LIMIT, depth: DEPTH_LIMIT });
    if (!value.ok) { if (value.issue.code !== 'LIMIT_EXCEEDED') bad(); full(); }
    return value.value;
  });
  budgetBoundary('terminal-v4-reserve', () => { if (!admission.v4()) full(); });
  const compact = mobileCanonicalJson(dictionary as MobileJsonValue);
  if (stringStats.value && Buffer.byteLength(compact) !== stringStats.value.bytes) bad();
  return { state, canonical: compact, format: 'v5', bytes: new Uint8Array(Buffer.from(compact)) };
}

export function decodePlaybackStorage(plain: Uint8Array, serverId: string, datasetId: string, origin: string,
  limits: Readonly<MobilePlaybackLimits>): DecodedPlaybackStorage {
  configuration(limits);
  if (!(plain instanceof Uint8Array) || plain.byteLength < 1 || plain.byteLength > limits.stateBytes) bad();
  const parsed = parseMobileJson(plain, { ...MOBILE_CODEC_LIMITS, responseBytes: limits.stateBytes, nodes: PHYSICAL_NODE_LIMIT, depth: DEPTH_LIMIT });
  if (!parsed.ok || !object(parsed.value)) bad(); let raw: Data = parsed.value;
  if (raw.schema === PLAYBACK_BLOCK_SCHEMA) return {state:decodeBlockState(raw,serverId,datasetId,origin,limits),canonical:mobileCanonicalJson(parsed.value),format:'v6'};
  if (raw.schema === PLAYBACK_STATE_SCHEMA) {
    const state = decodePlaybackState(plain, serverId, datasetId, origin, limits);
    const input = certificateInputs(state as unknown as Data, serverId, datasetId, origin, limits);
    if (input) rememberReceiptCertificates(input, state);
    return { state, canonical: playbackCanonical(state), format: 'v1' };
  }
  const format = raw.schema === PLAYBACK_SELECTIVE_STRING_SCHEMA ? 'v5' : raw.schema === PLAYBACK_STRING_SCHEMA ? 'v4' : raw.schema === PLAYBACK_SHAPE_SCHEMA ? 'v3' : 'v2', canonical = mobileCanonicalJson(parsed.value);
  if (format === 'v4' || format === 'v5') raw = expandStrings(raw, limits);
  if (format === 'v3') raw = expandShapes(raw, limits);
  if (raw.schema !== PLAYBACK_COMPACT_SCHEMA || !closed(raw, [...stateKeys, 'requestTemplates', 'contextTemplates'])
    || raw.serverId !== serverId || raw.datasetId !== datasetId) bad();
  arrays(raw, limits);
  if (!dense(raw.requestTemplates, limits.maxReceipts) || !dense(raw.contextTemplates, limits.maxReceipts)) bad();
  const requests = raw.requestTemplates, contexts = raw.contextTemplates;
  for (const entry of requests) if (!closed(entry, requestKeys)) bad();
  for (const entry of contexts) if (!object(entry) || !closed(entry, [...contextKeys, ...(Object.hasOwn(entry, 'resourceDsdToPcm') ? ['resourceDsdToPcm'] : [])])) bad();
  const physical = measure(raw, format !== 'v2' ? bound(limits) : limits.stateBytes, bad, PHYSICAL_NODE_LIMIT), maximum = bound(limits), usedRequests = new Set<number>(), usedContexts = new Set<number>();
  function plan(value: unknown, context: boolean): RefPlan {
    if (!object(value) || !Object.hasOwn(value, 'template')) return { value, stats: physical.stats(value), sharedBytes: 0, materialize: () => value };
    const tail = context ? 'now' : 'idempotencyKey', table = context ? contexts : requests;
    if (!closed(value, ['template', tail]) || !playbackInteger(value.template, 0, table.length - 1) || typeof value[tail] !== 'string') bad();
    const index = value.template, entry = table[index] as Data, entryStats = physical.stats(entry);
    if (entryStats.bytes > PLAYBACK_SHARED_BYTES_PER_RECEIPT) bad();
    (context ? usedContexts : usedRequests).add(index);
    const fields = Object.entries(entry).map(([key, item]) => [key, physical.stats(item)] as [string, Stats]); fields.push([tail, physical.stats(value[tail])]);
    return { value, stats: objectStats(fields, maximum, bad), sharedBytes: entryStats.bytes,
      materialize: () => ({ ...entry, [tail]: value[tail] }) };
  }
  const plans: { row: Data; request: RefPlan; context: RefPlan; stats: Stats }[] = [];
  const receiptStats: Stats = { nodes: 1, bytes: 2, height: 0 };
  for (const row of raw.receipts as unknown[]) {
    if (!closed(row, receiptKeys)) bad();
    const request = plan(row.request, false), context = plan(row.resourceContext, true);
    if (request.sharedBytes + context.sharedBytes > PLAYBACK_SHARED_BYTES_PER_RECEIPT) bad();
    const fields = receiptKeys.map(key => [key, key === 'request' ? request.stats : key === 'resourceContext' ? context.stats : physical.stats(row[key])] as [string, Stats]);
    const stats = objectStats(fields, maximum, bad);
    receiptStats.nodes += stats.nodes; receiptStats.bytes += stats.bytes + Number(plans.length > 0);
    receiptStats.height = Math.max(receiptStats.height, 1 + stats.height); within(receiptStats, maximum, bad);
    plans.push({ row, request, context, stats });
  }
  if (usedRequests.size !== requests.length || usedContexts.size !== contexts.length) bad();
  objectStats(stateKeys.map(key => [key, key === 'schema' ? physical.stats(PLAYBACK_STATE_SCHEMA)
    : key === 'receipts' ? receiptStats : physical.stats(raw[key])] as [string, Stats]), maximum, bad);
  // 预算已逐引用计算；此后才分配逻辑request/context，原语义校验器保持逐条执行。
  const expanded = { ...selection(raw, stateKeys), schema: PLAYBACK_STATE_SCHEMA,
    receipts: plans.map(p => ({ ...p.row, request: p.request.materialize(), resourceContext: p.context.materialize() })) };
  const state = captureCertifiedPlaybackState(expanded, serverId, datasetId, origin, limits);
  return { state, canonical, format };
}


/** 仅私有Worker的闭集增量协议；handle选择已验证不可变值，不证明任意外部对象相等。 */
export interface PlaybackStorageBase { handle: string; revision: number; commitId: string | null }
export type PlaybackStoragePatch = {
  kind: 'createResource' | 'publishResource'; clockFloor: number;
  resource: StoredPlaybackResource; receipt: StoredPlaybackReceipt;
} | {kind:'createSession';clockFloor:number;session:StoredPlaybackSession;receipt:StoredPlaybackReceipt};
export type PlaybackStorageWithBase<T extends DecodedPlaybackStorage> = T & { base: PlaybackStorageBase };
export interface PlaybackStoragePatchReply {
  canonical: string; format: EncodedPlaybackStorage['format']; bytes: Uint8Array;
  base: PlaybackStorageBase; previousBase: PlaybackStorageBase; patch: PlaybackStoragePatch;
}
export interface IncrementalPlaybackStateCodecPort extends MobilePlaybackStateCodecPort {
  derive(base: PlaybackStorageBase, patch: PlaybackStoragePatch, context: MobilePlaybackStateCodecContext): Promise<PlaybackStorageWithBase<EncodedPlaybackStorage>>;
  derivePatch?(base: PlaybackStorageBase, patch: PlaybackStoragePatch, context: MobilePlaybackStateCodecContext): Promise<PlaybackStoragePatchReply>;
}
/** 无await的描述符/逻辑预算核验后复制闭集小片段；不借外部对象身份免验。 */
export function capturePlaybackStoragePatch(raw: unknown, context: MobilePlaybackStateCodecContext): PlaybackStoragePatch {
  const resource=closed(raw,['kind','clockFloor','resource','receipt'])&&(raw.kind==='createResource'||raw.kind==='publishResource');
  const session=closed(raw,['kind','clockFloor','session','receipt'])&&raw.kind==='createSession';
  if(!resource&&!session)return bad();
  const measured=measure(raw,bound(context.limits),full,LOGICAL_NODE_LIMIT,undefined,true);
  if(!measured.stringsWellFormed)return bad();
  return JSON.parse(json(raw)) as PlaybackStoragePatch;
}
/** 只投影本次actor已完整验证的结果，不把历史state送回Main。 */
export function playbackStoragePatchReply(result: PlaybackStorageWithBase<EncodedPlaybackStorage>, previousBase: unknown,
  rawPatch: unknown, context: MobilePlaybackStateCodecContext): PlaybackStoragePatchReply {
  const patch=capturePlaybackStoragePatch(rawPatch,context),receipt=result.state.receipts.find(row=>row.id===patch.receipt.id);
  if(!receipt)return bad();
  const changed=patch.kind==='createSession'?{session:result.state.sessions.find(row=>row.id===patch.session.id)}
    :{resource:result.state.resources.find(row=>row.id===patch.resource.id)};
  if(Object.values(changed).some(row=>!row))return bad();
  return {canonical:result.canonical,format:result.format,bytes:result.bytes,base:capturePlaybackStorageBase(result.base),
    previousBase:capturePlaybackStorageBase(previousBase),patch:{kind:patch.kind,clockFloor:result.state.clockFloor,...changed,receipt} as PlaybackStoragePatch};
}
export function capturePlaybackStorageBase(raw: unknown): PlaybackStorageBase {
  if (!closed(raw, ['handle', 'revision', 'commitId']) || typeof raw.handle !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/u.test(raw.handle)
    || !playbackInteger(raw.revision) || !(raw.revision === 0 ? raw.commitId === null : typeof raw.commitId === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/u.test(raw.commitId))) return bad();
  return { handle: raw.handle, revision: raw.revision, commitId: raw.commitId as string | null };
}
function storageBinding(context: MobilePlaybackStateCodecContext): string {
  if (!closed(context, ['serverId','datasetId','responseOrigin','generation','revision','commitId','limits',
    ...(object(context) && Object.hasOwn(context,'terminalFailureBudget') ? ['terminalFailureBudget'] : [])])) return bad();
  const keys = Object.keys(MOBILE_PLAYBACK_DEFAULT_LIMITS);
  if (!closed(context.limits, keys)) return bad();
  for (const key of keys as (keyof MobilePlaybackLimits)[]) if (!playbackInteger(context.limits[key], key === 'readyWaitMs' ? 0 : 1, MOBILE_PLAYBACK_DEFAULT_LIMITS[key])) return bad();
  if (!playbackInteger(context.revision) || !(context.revision === 0 ? context.commitId === null : typeof context.commitId === 'string')) return bad();
  return json([context.serverId,context.datasetId,context.responseOrigin,context.generation,context.limits,terminalBudget(context.terminalFailureBudget)]);
}
/**
 * 仅保存一个base及一个候选。完整入口先原样校验；derive只编辑经闭集捕获的新值。
 * 内部base递归冻结，Worker回包由postMessage复制，Main不持有内部可变别名。
 */
export function createPlaybackStorageActor(options: { observeCapacity?: PlaybackStorageCapacityObserver } = {}) {
  interface Base { state: PlaybackState; logical: Measurements; binding: string; depth: number; format: DecodedPlaybackStorage['format'] }
  const bases = new Map<string, Base>(), packing = new WeakMap<object, PackingCandidate>(), blocks:BlockCache={groups:new WeakMap()};
  const frozen = new WeakSet<object>();
  let capacitySampled = false, capacityFailures = 0;
  const observeCapacity: CapacityObservation | undefined = options.observeCapacity ? (phase, measure) => {
    if (phase === 'sample') { if (capacitySampled) return; capacitySampled = true; }
    else { if (capacityFailures >= 8) return; capacityFailures++; }
    try { options.observeCapacity?.(measure()); } catch { /* 可信旁注回调也不能改变原codec结果。 */ }
  } : undefined;
  function freeze(value: unknown): void {
    if (!value || typeof value !== 'object' || frozen.has(value)) return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value); frozen.add(value);
  }
  function remember<T extends DecodedPlaybackStorage>(result: T, logical: Measurements, context: MobilePlaybackStateCodecContext, depth = 0, keep?: string): PlaybackStorageWithBase<T> {
    freeze(result.state);
    if (!keep) bases.clear();
    else for (const key of bases.keys()) if (key !== keep) bases.delete(key);
    const base = { handle: `base.${randomUUID()}`, revision: result.state.revision, commitId: result.state.commitId };
    bases.set(base.handle, { state: result.state, logical, binding: storageBinding(context), depth, format:result.format });
    return { ...result, base };
  }
  function checkResult(state: PlaybackState, context: MobilePlaybackStateCodecContext): void {
    if (state.serverId !== context.serverId || state.datasetId !== context.datasetId || state.revision !== context.revision || state.commitId !== context.commitId) bad();
  }
  return {
    encode(raw: unknown, context: MobilePlaybackStateCodecContext): PlaybackStorageWithBase<EncodedPlaybackStorage> {
      storageBinding(context); bases.clear(); const { serverId,datasetId,responseOrigin,limits } = context;
      configuration(limits); const budget = terminalBudget(context.terminalFailureBudget);
      if (!closed(raw,stateKeys)) bad(); arrays(raw,limits);
      budgetBoundary('worker-raw',()=>measure(raw,bound(limits),full));
      const state = budgetBoundary('worker-state',()=>captureCertifiedPlaybackState(raw,serverId,datasetId,responseOrigin,limits));
      checkResult(state,context);
      const logical = budgetBoundary('worker-state',()=>measure(state,bound(limits),full,LOGICAL_NODE_LIMIT,undefined,true));
      const result = encodeCaptured(state,logical,limits,budget,packing,blocks,false,observeCapacity);
      return remember(result,logical,context);
    },
    decode(plain: Uint8Array, context: MobilePlaybackStateCodecContext): PlaybackStorageWithBase<DecodedPlaybackStorage> {
      storageBinding(context); bases.clear();
      const result = decodePlaybackStorage(plain,context.serverId,context.datasetId,context.responseOrigin,context.limits); checkResult(result.state,context);
      return remember(result,measure(result.state,bound(context.limits),bad,LOGICAL_NODE_LIMIT,undefined,true),context);
    },
    derive(rawBase: unknown, rawPatch: unknown, context: MobilePlaybackStateCodecContext): PlaybackStorageWithBase<EncodedPlaybackStorage> {
      const token = capturePlaybackStorageBase(rawBase), previous = bases.get(token.handle), binding = storageBinding(context);
      if (!previous || previous.binding !== binding || previous.state.revision !== token.revision || previous.state.commitId !== token.commitId
        || context.revision !== token.revision + 1 || context.commitId === null) return bad();
      const priorLogical=previous.logical,priorDepth=previous.depth,preferBlocks=previous.format==='v6';
      const resourcePatch=closed(rawPatch,['kind','clockFloor','resource','receipt']) && (rawPatch.kind==='createResource'||rawPatch.kind==='publishResource');
      const sessionPatch=closed(rawPatch,['kind','clockFloor','session','receipt']) && rawPatch.kind==='createSession';
      if (!resourcePatch && !sessionPatch) return bad();
      const limits = context.limits, maximum = bound(limits);
      budgetBoundary('worker-raw',()=>measure(rawPatch,maximum,full));
      const patch = rawPatch as unknown as PlaybackStoragePatch, before = previous.state;
      if (!playbackInteger(patch.clockFloor,before.clockFloor) || !object(patch.receipt)) return bad();
      function finish(state: PlaybackState): PlaybackStorageWithBase<EncodedPlaybackStorage> {
        arrays(state as unknown as Data,limits);
        // 全局唯一性每次核全表标量，不以局部schema代替全局ID/key围栏。
        for (const rows of [state.sessions,state.resources,state.receipts]) if (new Set(rows.map(row=>row.id)).size!==rows.length) return bad();
        const keys = state.receipts.map(row=>`${row.deviceId}:${row.deviceEpoch}:${row.keyHash}`); if (new Set(keys).size!==keys.length) return bad();
        // 证明链最多八代；折叠仅重算纯Stats，不改变任何历史内容或预算。
        const depth = priorDepth < 8 ? priorDepth+1 : 0;
        const logical = budgetBoundary('worker-state',()=>measure(state,maximum,full,LOGICAL_NODE_LIMIT,depth?priorLogical:undefined,true));
        const result = encodeCaptured(state,logical,limits,terminalBudget(context.terminalFailureBudget),packing,blocks,preferBlocks,observeCapacity);
        return remember(result,logical,context,depth,token.handle);
      }
      if (patch.kind==='createSession') {
        const checked=capturePlaybackState({...before,revision:context.revision,commitId:context.commitId,clockFloor:patch.clockFloor,
          sessions:[patch.session],resources:[],receipts:[patch.receipt]},context.serverId,context.datasetId,context.responseOrigin,limits);
        const session=checked.sessions[0]!,receipt=checked.receipts[0]!;
        if(session.terminal!==null||session.lastSequence!==0||session.playerGeneration!==null||session.currentQueueItemId!==null||session.currentResourceId!==null||session.observation!==null
          ||receipt.operation!=='createSession'||receipt.state!=='RECORDED'||receipt.reply?.status!==201||receipt.sessionId!==session.id) return bad();
        return finish({...before,revision:context.revision,commitId:context.commitId,clockFloor:patch.clockFloor,
          sessions:[...before.sessions,session],receipts:[...before.receipts,receipt]});
      }
      if (!object(patch.resource)) return bad();
      const oldResource = before.resources.find(row=>row.id===patch.resource.id), oldReceipt = before.receipts.find(row=>row.id===patch.receipt.id);
      const parent = before.sessions.find(row=>row.id===patch.resource.sessionId); if (!parent) return bad();
      // 原完整schema核新增/受影响资源及其全部历史回执；其余父子关系由不可变base保持。
      const related = before.receipts.filter(row=>row.resourceId===patch.resource.id && row.id!==patch.receipt.id);
      const observed = parent.observation === null ? undefined : before.resources.find(row=>row.id===parent.observation!.resourceId);
      const checked = capturePlaybackState({ ...before, revision:context.revision,commitId:context.commitId,clockFloor:patch.clockFloor,
        sessions:[parent],resources:[patch.resource,...(observed && observed.id!==patch.resource.id ? [observed] : [])],receipts:[...related,patch.receipt] },
        context.serverId,context.datasetId,context.responseOrigin,limits);
      const resource = checked.resources[0]!, receipt = checked.receipts.at(-1)!;
      if (receipt.operation!=='createResource' || receipt.resourceId!==resource.id || receipt.sessionId!==parent.id) return bad();
      if (patch.kind==='createResource') {
        if (oldResource || oldReceipt || resource.state!=='preparing' || resource.source!==null || resource.failure!==null || resource.media!==null || resource.tickets.length
          || receipt.state!=='UNKNOWN' || receipt.reply!==null || receipt.resourceContext!==null) return bad();
      } else {
        if (!oldResource || !oldReceipt || oldReceipt.resourceId!==resource.id || oldResource.state!=='preparing' || resource.source===null
          || !['preparing','ready'].includes(resource.state) || resource.failure!==null) return bad();
        if (Object.keys(oldResource).sort().join(',')!==Object.keys(resource).sort().join(',')) return bad();
        for (const key of Object.keys(oldResource) as (keyof StoredPlaybackResource)[]) if (!['state','failure','source','media','tickets'].includes(key)
          && json(oldResource[key])!==json(resource[key])) return bad();
        for (const key of receiptKeys) if (!['state','reply','resourceContext'].includes(key) && json((oldReceipt as unknown as Data)[key])!==json((receipt as unknown as Data)[key])) return bad();
        if (oldReceipt.state==='RECORDED' ? json(oldReceipt)!==json(receipt) || oldReceipt.reply?.status!==202
          : receipt.state!=='RECORDED' || receipt.reply?.status!==(resource.state==='ready'?201:202)) return bad();
      }
      const state: PlaybackState = { ...before, revision:context.revision,commitId:context.commitId,clockFloor:patch.clockFloor,
        resources:patch.kind==='createResource'?[...before.resources,resource]:before.resources.map(row=>row.id===resource.id?resource:row),
        receipts:patch.kind==='createResource'?[...before.receipts,receipt]:before.receipts.map(row=>row.id===receipt.id?receipt:row) };
      return finish(state);
    },
    close(): void { bases.clear(); },
  };
}
