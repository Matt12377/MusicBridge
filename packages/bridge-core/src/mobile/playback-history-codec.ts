import { types } from 'node:util';
import { isMobileId, MOBILE_CODEC_LIMITS, parseMobileJson } from '@music-bridge/contracts';
import { capturePlaybackState, playbackCanonical, playbackFailure, playbackInteger, type PlaybackState } from './playback-state.js';
import { decodePlaybackStorage } from './playback-state-codec.js';
import { isPlaybackHistoryDigest } from './playback-history-index.js';
import { PLAYBACK_HISTORY_HEAD_SCHEMA, PLAYBACK_HISTORY_LOCATOR_SCHEMA,
  type PlaybackHistoryAuthenticatedHead, type PlaybackHistoryAuthenticatedLocator, type PlaybackHistoryHeadToken } from './playback-history-types.js';
import { MOBILE_PLAYBACK_STATE_LOGICAL_NODE_LIMIT, type MobilePlaybackStateCodecContext } from './playback-types.js';

const bad = (): never => playbackFailure(503, 'BUSY');
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value);
const typedArray = Object.getPrototypeOf(Uint8Array.prototype) as object;
const byteLength = Object.getOwnPropertyDescriptor(typedArray, 'byteLength')!.get!;
const arrayBuffer = Object.getOwnPropertyDescriptor(typedArray, 'buffer')!.get!;
const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
function closed(raw: unknown, keys: readonly string[]): raw is Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || types.isProxy(raw)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  return Reflect.ownKeys(descriptors).length === keys.length
    && keys.every(key => descriptors[key]?.enumerable && Object.hasOwn(descriptors[key]!, 'value'));
}
export function copyPlaybackHistoryBytes(raw: unknown, maximum: number): Uint8Array {
  if (!types.isUint8Array(raw) || types.isProxy(raw)) return bad();
  const length = Reflect.apply(byteLength, raw, []) as number, buffer: unknown = Reflect.apply(arrayBuffer, raw, []);
  if (!playbackInteger(length, 1, maximum) || !types.isArrayBuffer(buffer)
    || resizable && Reflect.apply(resizable, buffer, []) !== false) return bad();
  const copy = new Uint8Array(length); Uint8Array.prototype.set.call(copy, raw); return copy;
}
export const playbackHistoryHeadAad = (serverId: string, datasetId: string, token: PlaybackHistoryHeadToken): Uint8Array =>
  Buffer.from(playbackCanonical(['MBM002_PLAYBACK_HISTORY_HEAD_V1', serverId, datasetId, token.storeId, token.revision, token.commitId]));
export const playbackHistoryLocatorAad = (serverId: string, datasetId: string, key: string): Uint8Array =>
  Buffer.from(playbackCanonical(['MBM002_PLAYBACK_HISTORY_LOCATOR_V1', serverId, datasetId, key]));
export const playbackHistorySnapshotAad = (serverId: string, datasetId: string, revision: number): Uint8Array =>
  Buffer.from(playbackCanonical(['MBM002_PLAYBACK_STATE_V1', serverId, datasetId, revision]));

export function capturePlaybackHistoryHead(raw: unknown): PlaybackHistoryAuthenticatedHead {
  if (!closed(raw, ['schema', 'serverId', 'datasetId', 'storeId', 'revision', 'commitId', 'hotSha256', 'indexRoot', 'legacyFileSha256'])
    || raw.schema !== PLAYBACK_HISTORY_HEAD_SCHEMA || !isMobileId(raw.serverId) || !isMobileId(raw.datasetId)
    || !uuid(raw.storeId) || !playbackInteger(raw.revision) || !(raw.revision === 0 ? raw.commitId === null : uuid(raw.commitId))
    || !isPlaybackHistoryDigest(raw.hotSha256) || raw.indexRoot !== null && !isPlaybackHistoryDigest(raw.indexRoot)
    || raw.legacyFileSha256 !== null && !isPlaybackHistoryDigest(raw.legacyFileSha256)) return bad();
  return Object.freeze({ schema: PLAYBACK_HISTORY_HEAD_SCHEMA, serverId: raw.serverId, datasetId: raw.datasetId,
    storeId: raw.storeId, revision: raw.revision, commitId: raw.commitId as string | null, hotSha256: raw.hotSha256,
    indexRoot: raw.indexRoot as string | null, legacyFileSha256: raw.legacyFileSha256 as string | null });
}
export function capturePlaybackHistoryLocator(raw: unknown): PlaybackHistoryAuthenticatedLocator {
  if (!closed(raw, ['schema', 'serverId', 'datasetId', 'kind', 'key', 'archiveId', 'snapshot', 'sessionId', 'recordId'])
    || raw.schema !== PLAYBACK_HISTORY_LOCATOR_SCHEMA || !isMobileId(raw.serverId) || !isMobileId(raw.datasetId)
    || !['receipt', 'session', 'resource'].includes(raw.kind as string) || !isPlaybackHistoryDigest(raw.key)
    || !uuid(raw.archiveId) || !isMobileId(raw.sessionId) || !isMobileId(raw.recordId)
    || !closed(raw.snapshot, ['revision', 'commitId', 'hotSha256']) || !playbackInteger(raw.snapshot.revision, 1)
    || !uuid(raw.snapshot.commitId) || !isPlaybackHistoryDigest(raw.snapshot.hotSha256)) return bad();
  return Object.freeze({ schema: PLAYBACK_HISTORY_LOCATOR_SCHEMA, serverId: raw.serverId, datasetId: raw.datasetId,
    kind: raw.kind as PlaybackHistoryAuthenticatedLocator['kind'], key: raw.key, archiveId: raw.archiveId,
    snapshot: Object.freeze({ revision: raw.snapshot.revision, commitId: raw.snapshot.commitId, hotSha256: raw.snapshot.hotSha256 }),
    sessionId: raw.sessionId, recordId: raw.recordId });
}
export function parsePlaybackHistorySmallJson(plain: Uint8Array): unknown {
  const parsed = parseMobileJson(plain, { ...MOBILE_CODEC_LIMITS, responseBytes: 16 * 1024, nodes: 128, depth: 8 });
  if (!parsed.ok) return bad();
  return parsed.value;
}
/** 与私有codec相同的逻辑展开预算；不把公开HTTP的2MiB边界改成存储展开边界。 */
function captureHistoryData(raw: unknown, context: MobilePlaybackStateCodecContext): unknown {
  if (!closed(raw, ['schema', 'serverId', 'datasetId', 'revision', 'commitId', 'clockFloor', 'sessions', 'resources', 'receipts'])) return bad();
  for (const [key, maximum] of [['sessions', 1], ['resources', context.limits.maxStoredResources],
    ['receipts', context.limits.maxReceipts]] as const) {
    const value = raw[key];
    if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) return bad();
    const length: unknown = Object.getOwnPropertyDescriptor(value, 'length')?.value;
    if (!playbackInteger(length, 0, maximum)) return bad();
  }
  const maximum = context.limits.stateBytes + context.limits.maxReceipts * 8192;
  let nodes = 0, bytes = 0; const active = new Set<object>();
  const count = (amount: number): void => { bytes += amount; if (bytes > maximum) return bad(); };
  function walk(value: unknown, depth: number): unknown {
    if (++nodes > MOBILE_PLAYBACK_STATE_LOGICAL_NODE_LIMIT || depth > 24) return bad();
    if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
      if (typeof value === 'number' && (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value))) return bad();
      if (typeof value === 'string' && value.length > maximum) return bad();
      count(Buffer.byteLength(JSON.stringify(value))); return value;
    }
    if (!value || typeof value !== 'object' || types.isProxy(value) || active.has(value)) return bad();
    const array = Array.isArray(value), prototype: unknown = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return bad();
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string') || keys.length > MOBILE_PLAYBACK_STATE_LOGICAL_NODE_LIMIT - nodes + Number(array)) return bad();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    active.add(value); count(2);
    try {
      if (array) {
        const length: unknown = descriptors.length?.value;
        if (!playbackInteger(length, 0, MOBILE_PLAYBACK_STATE_LOGICAL_NODE_LIMIT) || keys.length !== length + 1) return bad();
        const out: unknown[] = [];
        for (let index = 0; index < length; index++) {
          const descriptor = descriptors[String(index)];
          if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return bad();
          if (index) count(1); out.push(walk(descriptor.value, depth + 1));
        }
        return out;
      }
      const out = Object.create(null) as Record<string, unknown>;
      for (const [index, key] of (keys as string[]).entries()) {
        const descriptor = descriptors[key]!;
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || key.length > maximum) return bad();
        count(Buffer.byteLength(JSON.stringify(key)) + 1 + Number(index > 0));
        out[key] = walk(descriptor.value, depth + 1);
      }
      return out;
    } finally { active.delete(value); }
  }
  return walk(raw, 0);
}
/** Worker独立只读解码：仍完整审核一个原有界snapshot，不触hot actor的base/缓存。 */
export function decodePlaybackHistoryGroup(plain: Uint8Array, context: MobilePlaybackStateCodecContext, sessionId: string): PlaybackState {
  if (!isMobileId(sessionId)) return bad();
  const decoded = decodePlaybackStorage(plain, context.serverId, context.datasetId, context.responseOrigin, context.limits);
  if (decoded.state.revision !== context.revision || decoded.state.commitId !== context.commitId) return bad();
  const session = decoded.state.sessions.find(row => row.id === sessionId);
  if (!session?.terminal) return bad();
  const resources = decoded.state.resources.filter(row => row.sessionId === sessionId);
  if (resources.some(row => row.state !== 'terminal')) return bad();
  return capturePlaybackState({ ...decoded.state, sessions: [session], resources,
    receipts: decoded.state.receipts.filter(row => row.sessionId === sessionId) },
  context.serverId, context.datasetId, context.responseOrigin, context.limits);
}
/** 对真实Worker返回仍按原逻辑节点/展开字节与完整父子图捕获，不信任私有result自报资格。 */
export function capturePlaybackHistoryGroup(raw: unknown, context: MobilePlaybackStateCodecContext, sessionId: string): PlaybackState {
  const group = capturePlaybackState(captureHistoryData(raw, context), context.serverId, context.datasetId, context.responseOrigin, context.limits);
  if (group.revision !== context.revision || group.commitId !== context.commitId || group.sessions.length !== 1
    || group.sessions[0]!.id !== sessionId || !group.sessions[0]!.terminal
    || group.resources.some(row => row.sessionId !== sessionId || row.state !== 'terminal')
    || group.receipts.some(row => row.sessionId !== sessionId)) return bad();
  return group;
}
