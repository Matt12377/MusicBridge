import { types } from 'node:util';
import { MOBILE_PLAYBACK_DEFAULT_LIMITS, MobilePlaybackError, type MobilePlaybackStateCodecContext } from '../../../../packages/bridge-core/src/mobile/playback-types.js';

export const PLAYBACK_CODEC_PROTOCOL = 'musicbridge.playback-codec-worker.v1';
export const PLAYBACK_CODEC_MAX_JOBS = 2;
export const PLAYBACK_CODEC_TIMEOUT_MS = 10_000;
const NODES = 200_000, DEPTH = 24, SHARED_BYTES = 8 * 1024;
export const codecBusy = (): MobilePlaybackError => new MobilePlaybackError(503, 'BUSY', true, 1_000);
const full = (): never => { throw new MobilePlaybackError(429, 'RESOURCE_BUSY', true, 1_000); };
const bad = (): never => { throw codecBusy(); };
export function dataRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !types.isProxy(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
export function closedData(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!dataRecord(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(descriptors).length === keys.length
    && keys.every(key => descriptors[key]?.enumerable && Object.hasOwn(descriptors[key]!, 'value'));
}
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/u.test(value);
export function captureCodecContext(raw: unknown): MobilePlaybackStateCodecContext {
  if (!closedData(raw, ['serverId', 'datasetId', 'responseOrigin', 'generation', 'revision', 'commitId', 'limits'])
    || !id(raw.serverId) || !id(raw.datasetId) || !id(raw.generation) || !integer(raw.revision)
    || !(raw.revision === 0 ? raw.commitId === null : id(raw.commitId)) || typeof raw.responseOrigin !== 'string') return bad();
  try { const url = new URL(raw.responseOrigin); if (url.protocol !== 'https:' || url.origin !== raw.responseOrigin || url.username || url.password) return bad(); }
  catch { return bad(); }
  const keys = Object.keys(MOBILE_PLAYBACK_DEFAULT_LIMITS);
  if (!closedData(raw.limits, keys)) return bad();
  const limits = {} as Record<string, number>;
  for (const key of keys as (keyof typeof MOBILE_PLAYBACK_DEFAULT_LIMITS)[]) {
    const n = raw.limits[key];
    if (!integer(n) || n < (key === 'readyWaitMs' ? 0 : 1) || n > MOBILE_PLAYBACK_DEFAULT_LIMITS[key]) return bad();
    limits[key] = n;
  }
  return { serverId: raw.serverId, datasetId: raw.datasetId, responseOrigin: raw.responseOrigin, generation: raw.generation,
    revision: raw.revision, commitId: raw.commitId as string | null, limits: limits as unknown as MobilePlaybackStateCodecContext['limits'] };
}
export const codecBinding = (context: MobilePlaybackStateCodecContext): string => JSON.stringify(context);
/**
 * 仅传输副本与结构预算，不执行业务schema、摘要、压缩或canonical。
 * 必须在postMessage前拒绝Proxy/getter；重复引用逐次复制并逐次计数。
 */
export function captureCodecData(raw: unknown, context: MobilePlaybackStateCodecContext): unknown {
  // 与原encode最前置的根闭集/三数组准入一致，尚不触及逐条业务校验。
  if (!closedData(raw, ['schema', 'serverId', 'datasetId', 'revision', 'commitId', 'clockFloor', 'sessions', 'resources', 'receipts'])) return bad();
  for (const [key, maximum] of [['sessions', context.limits.maxStoredSessions], ['resources', context.limits.maxStoredResources],
    ['receipts', context.limits.maxReceipts]] as const) {
    const value = raw[key];
    if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) return bad();
    const descriptors = Object.getOwnPropertyDescriptors(value), length = Object.getOwnPropertyDescriptor(value, 'length')?.value as unknown;
    if (!integer(length) || length > maximum || Reflect.ownKeys(descriptors).length !== length + 1) return bad();
    for (let i = 0; i < length; i++) if (!descriptors[String(i)]?.enumerable || !Object.hasOwn(descriptors[String(i)]!, 'value')) return bad();
  }
  const maximum = context.limits.stateBytes + context.limits.maxReceipts * SHARED_BYTES;
  let nodes = 0, bytes = 0; const active = new Set<object>();
  const count = (size: number) => { bytes += size; if (bytes > maximum) full(); };
  function walk(value: unknown, depth: number): unknown {
    if (++nodes > NODES || depth > DEPTH) full();
    if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
      if (typeof value === 'number' && (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value))) return bad();
      // 预判大字符串，避免先分配超过原逻辑预算的JSON转义字符串。
      if (typeof value === 'string' && value.length > maximum) full();
      count(Buffer.byteLength(JSON.stringify(value))); return value;
    }
    if (!value || typeof value !== 'object' || types.isProxy(value) || active.has(value)) return bad();
    const array = Array.isArray(value);
    if (array ? Object.getPrototypeOf(value) !== Array.prototype : !dataRecord(value)) return bad();
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string')) return bad();
    if (keys.length > NODES - nodes + Number(array)) full();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    active.add(value); count(2);
    try {
      if (array) {
        const length = descriptors.length?.value as unknown;
        if (!integer(length) || length > NODES || keys.length !== length + 1) return bad();
        const out: unknown[] = [];
        for (let i = 0; i < length; i++) {
          const descriptor = descriptors[String(i)];
          if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return bad();
          if (i) count(1); out.push(walk(descriptor.value, depth + 1));
        }
        return out;
      }
      const out = Object.create(null) as Record<string, unknown>;
      for (const [i, key] of (keys as string[]).entries()) {
        const descriptor = descriptors[key]!;
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return bad();
        if (key.length > maximum) full();
        count(Buffer.byteLength(JSON.stringify(key)) + 1 + Number(i > 0));
        out[key] = walk(descriptor.value, depth + 1);
      }
      return out;
    } finally { active.delete(value); }
  }
  return walk(raw, 0);
}
const typedArray = Object.getPrototypeOf(Uint8Array.prototype) as object;
const byteLength = Object.getOwnPropertyDescriptor(typedArray, 'byteLength')!.get!;
export function codecByteLength(value: unknown): number {
  if (!value || typeof value !== 'object' || types.isProxy(value) || !types.isUint8Array(value)) return bad();
  return Reflect.apply(byteLength, value, []) as number;
}
export function copyCodecBytes(raw: unknown, maximum: number): Uint8Array {
  const length = codecByteLength(raw); if (!length || length > maximum) return bad();
  const out = new Uint8Array(length); Uint8Array.prototype.set.call(out, raw as Uint8Array); return out;
}
export function wipeCodecReply(raw: unknown): void {
  if (!closedData(raw, ['protocol', 'kind', 'id', 'operation', 'binding', 'result']) || !dataRecord(raw.result)) return;
  const d = Object.getOwnPropertyDescriptor(raw.result, 'bytes');
  if (d && Object.hasOwn(d, 'value') && types.isUint8Array(d.value) && !types.isProxy(d.value)) Uint8Array.prototype.fill.call(d.value, 0);
}
