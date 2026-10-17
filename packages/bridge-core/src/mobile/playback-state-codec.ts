import { types } from 'node:util';
import { MOBILE_CODEC_LIMITS, mobileCanonicalJson, mobileDataSnapshot, parseMobileJson, type MobileJsonValue } from '@music-bridge/contracts';
import { MOBILE_PLAYBACK_DEFAULT_LIMITS, type MobilePlaybackLimits } from './playback-types.js';
import { PLAYBACK_STATE_SCHEMA, capturePlaybackState, decodePlaybackState, playbackCanonical, playbackFailure, playbackInteger, type PlaybackState } from './playback-state.js';

export const PLAYBACK_COMPACT_SCHEMA = 'mbm002.playback-compact-state.v2';
export const PLAYBACK_SHARED_BYTES_PER_RECEIPT = 8 * 1024;
const NODE_LIMIT = 200_000, DEPTH_LIMIT = 24;
const stateKeys = ['schema', 'serverId', 'datasetId', 'revision', 'commitId', 'clockFloor', 'sessions', 'resources', 'receipts'];
const receiptKeys = ['id', 'operation', 'deviceId', 'deviceEpoch', 'keyHash', 'fingerprint', 'scopeHash', 'request', 'createdAt', 'sessionId', 'resourceId', 'state', 'reply', 'resourceContext'];
const requestKeys = ['path', 'pathParameters', 'query', 'body'];
const contextKeys = ['scope', 'capabilitySnapshotIdentity', 'responseOrigin', 'resourceFormatBitDepth', 'capabilityVersion', 'request', 'source', 'sourceAudio', 'expectedResourceId', 'hlsAllowed'];
type Data = Record<string, unknown>;
interface Stats { nodes: number; bytes: number; height: number }
interface RefPlan { value: unknown; stats: Stats; sharedBytes: number; materialize(): unknown }
function bad(): never { return playbackFailure(503, 'BUSY'); }
function full(): never { return playbackFailure(429, 'RESOURCE_BUSY'); }
const json = (v: unknown) => mobileCanonicalJson(v as MobileJsonValue);
const textBytes = (s: string) => Buffer.byteLength(JSON.stringify(s));
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
function within(s: Stats, maximum: number, reject: () => never): Stats {
  if (!playbackInteger(s.nodes, 1, NODE_LIMIT) || !playbackInteger(s.bytes, 1, maximum) || !playbackInteger(s.height, 0, DEPTH_LIMIT)) reject();
  return s;
}
function objectStats(fields: readonly [string, Stats][], maximum: number, reject: () => never): Stats {
  const s = { nodes: 1, bytes: 2, height: 0 };
  for (const [i, [k, v]] of fields.entries()) {
    s.nodes += v.nodes; s.bytes += textBytes(k) + 1 + v.bytes + Number(i > 0); s.height = Math.max(s.height, 1 + v.height);
    within(s, maximum, reject);
  }
  return s;
}
function arrayStats(values: readonly Stats[], maximum: number, reject: () => never): Stats {
  const s = { nodes: 1, bytes: 2, height: 0 };
  for (const [i, v] of values.entries()) {
    s.nodes += v.nodes; s.bytes += v.bytes + Number(i > 0); s.height = Math.max(s.height, 1 + v.height); within(s, maximum, reject);
  }
  return s;
}
/** 描述符读取及累计预算在任何逻辑展开/语义复制之前完成，重复引用仍逐次计数。 */
function measure(raw: unknown, maximum: number, reject: () => never) {
  const cache = new WeakMap<object, Stats>(), active = new Set<object>(); let work = 0;
  function walk(v: unknown, depth: number): Stats {
    if (++work > NODE_LIMIT || depth > DEPTH_LIMIT) reject();
    if (v === null || typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') {
      if (typeof v === 'number' && (!Number.isFinite(v) || Number.isInteger(v) && !Number.isSafeInteger(v))) bad();
      const encoded = JSON.stringify(v); if (encoded === undefined) bad();
      return within({ nodes: 1, bytes: Buffer.byteLength(encoded), height: 0 }, maximum, reject);
    }
    if (!v || typeof v !== 'object' || types.isProxy(v) || active.has(v)) bad();
    const array = Array.isArray(v); if (array ? Object.getPrototypeOf(v) !== Array.prototype : !object(v)) bad();
    active.add(v);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(v), keys = Reflect.ownKeys(descriptors);
      if (keys.some(k => typeof k !== 'string')) bad();
      let result: Stats;
      if (array) {
        const length = descriptors.length?.value as unknown;
        if (!playbackInteger(length, 0, NODE_LIMIT) || keys.length !== length + 1) bad();
        const rows: Stats[] = [];
        for (let i = 0; i < length; i++) { const d = descriptors[String(i)]; if (!d?.enumerable || !Object.hasOwn(d, 'value')) bad(); rows.push(walk(d.value, depth + 1)); }
        result = arrayStats(rows, maximum, reject);
      } else {
        const rows: [string, Stats][] = [];
        for (const key of keys as string[]) { const d = descriptors[key]; if (!d?.enumerable || !Object.hasOwn(d, 'value')) bad(); rows.push([key, walk(d.value, depth + 1)]); }
        result = objectStats(rows, maximum, reject);
      }
      cache.set(v, result); return result;
    } finally { active.delete(v); }
  }
  const root = walk(raw, 0);
  return { root, stats(v: unknown): Stats {
    if (v && typeof v === 'object') return cache.get(v) ?? bad();
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

export interface DecodedPlaybackStorage { state: PlaybackState; canonical: string; format: 'v1' | 'v2' }
export interface EncodedPlaybackStorage extends DecodedPlaybackStorage { bytes: Uint8Array }

export function encodePlaybackStorage(raw: unknown, serverId: string, datasetId: string, origin: string,
  limits: Readonly<MobilePlaybackLimits>): EncodedPlaybackStorage {
  configuration(limits); if (!closed(raw, stateKeys)) bad(); arrays(raw, limits);
  measure(raw, bound(limits), full);
  const state = capturePlaybackState(raw, serverId, datasetId, origin, limits);
  const logical = measure(state, bound(limits), full);
  const requestCounts = new Map<string, number>(), contextCounts = new Map<string, number>();
  const candidates = state.receipts.map(r => {
    const request = selection(r.request as unknown as Data, requestKeys), context = r.resourceContext === null ? null : contextTemplate(r.resourceContext as unknown as Data);
    const rq = json(request), rc = context === null ? null : json(context);
    if (Buffer.byteLength(rq) <= PLAYBACK_SHARED_BYTES_PER_RECEIPT) requestCounts.set(rq, (requestCounts.get(rq) ?? 0) + 1);
    if (rc !== null && Buffer.byteLength(rc) <= PLAYBACK_SHARED_BYTES_PER_RECEIPT) contextCounts.set(rc, (contextCounts.get(rc) ?? 0) + 1);
    return { request, context, rq, rc };
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
  const checked = mobileDataSnapshot(packed, { ...MOBILE_CODEC_LIMITS, responseBytes: limits.stateBytes, nodes: NODE_LIMIT, depth: DEPTH_LIMIT });
  const v1 = (): EncodedPlaybackStorage => {
    const canonical = playbackCanonical(state); return { state, canonical, format: 'v1', bytes: new Uint8Array(Buffer.from(canonical)) };
  };
  if (!checked.ok) { if (checked.issue.code !== 'LIMIT_EXCEEDED') bad(); if (logical.root.bytes <= limits.stateBytes) return v1(); return full(); }
  const canonical = mobileCanonicalJson(checked.value);
  if (logical.root.bytes <= limits.stateBytes && Buffer.byteLength(canonical) >= logical.root.bytes) return v1();
  return { state, canonical, format: 'v2', bytes: new Uint8Array(Buffer.from(canonical)) };
}

export function decodePlaybackStorage(plain: Uint8Array, serverId: string, datasetId: string, origin: string,
  limits: Readonly<MobilePlaybackLimits>): DecodedPlaybackStorage {
  configuration(limits);
  if (!(plain instanceof Uint8Array) || plain.byteLength < 1 || plain.byteLength > limits.stateBytes) bad();
  const parsed = parseMobileJson(plain, { ...MOBILE_CODEC_LIMITS, responseBytes: limits.stateBytes, nodes: NODE_LIMIT, depth: DEPTH_LIMIT });
  if (!parsed.ok || !object(parsed.value)) bad(); const raw = parsed.value;
  if (raw.schema === PLAYBACK_STATE_SCHEMA) {
    const state = decodePlaybackState(plain, serverId, datasetId, origin, limits);
    return { state, canonical: playbackCanonical(state), format: 'v1' };
  }
  if (raw.schema !== PLAYBACK_COMPACT_SCHEMA || !closed(raw, [...stateKeys, 'requestTemplates', 'contextTemplates'])
    || raw.serverId !== serverId || raw.datasetId !== datasetId) bad();
  arrays(raw, limits);
  if (!dense(raw.requestTemplates, limits.maxReceipts) || !dense(raw.contextTemplates, limits.maxReceipts)) bad();
  const requests = raw.requestTemplates, contexts = raw.contextTemplates;
  for (const entry of requests) if (!closed(entry, requestKeys)) bad();
  for (const entry of contexts) if (!object(entry) || !closed(entry, [...contextKeys, ...(Object.hasOwn(entry, 'resourceDsdToPcm') ? ['resourceDsdToPcm'] : [])])) bad();
  const physical = measure(raw, limits.stateBytes, bad), maximum = bound(limits), usedRequests = new Set<number>(), usedContexts = new Set<number>();
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
  const state = capturePlaybackState(expanded, serverId, datasetId, origin, limits);
  return { state, canonical: mobileCanonicalJson(parsed.value), format: 'v2' };
}
