import { types } from 'node:util';
import { isMobileId } from '@music-bridge/contracts';
import { allocateOwnedSealedBytes, ownedSealedByteLength } from './owned-sealed-bytes.js';
import { capturePlaybackHistoryNodeRecord, isPlaybackHistoryDigest, verifyPlaybackHistoryProof } from './playback-history-index.js';
import { MOBILE_AUTH_SEALED_MAX_BYTES, MobileAuthPersistenceError } from './types.js';
import {
  PLAYBACK_HISTORY_MAX_PROOF_BYTES, PLAYBACK_HISTORY_MAX_PROOF_NODES, PLAYBACK_HISTORY_MAX_STAGE_BYTES,
  PLAYBACK_HISTORY_MAX_STAGE_LOCATORS, PLAYBACK_HISTORY_MAX_STAGE_NODES,
  type PlaybackHistoryHeadToken, type PlaybackHistoryHotState, type PlaybackHistoryRequest,
  type PlaybackHistoryReply, type PlaybackHistorySealedLocator, type PlaybackHistorySnapshotIdentity,
} from './playback-history-types.js';

const bad = (): never => { throw new MobileAuthPersistenceError('not-sent'); };
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
function closed(v: unknown, keys: readonly string[]): v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || types.isProxy(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return false;
  const fields = Object.getOwnPropertyDescriptors(v);
  return Reflect.ownKeys(fields).length === keys.length
    && keys.every(key => fields[key]?.enumerable === true && Object.hasOwn(fields[key]!, 'value'));
}
function array(v: unknown, max: number): unknown[] {
  if (!Array.isArray(v) || types.isProxy(v) || Object.getPrototypeOf(v) !== Array.prototype
    || v.length > max || Reflect.ownKeys(v).length !== v.length + 1) return bad();
  for (let i = 0; i < v.length; i++) {
    const field = Object.getOwnPropertyDescriptor(v, String(i));
    if (!field?.enumerable || !Object.hasOwn(field, 'value')) return bad();
  }
  return v;
}
const typed = Object.getPrototypeOf(Uint8Array.prototype) as object;
const lengthOf = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!;
const bufferOf = Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!;
const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
function sealed(v: unknown, maximum = MOBILE_AUTH_SEALED_MAX_BYTES): Uint8Array {
  if (!v || typeof v !== 'object' || types.isProxy(v)) return bad();
  let length = ownedSealedByteLength(v, maximum);
  if (length === null) {
    if (!types.isUint8Array(v) || Object.getPrototypeOf(v) !== Uint8Array.prototype) return bad();
    length = Reflect.apply(lengthOf, v, []) as number;
    const buffer: unknown = Reflect.apply(bufferOf, v, []);
    if (!Number.isSafeInteger(length) || length < 1 || length > maximum || !types.isArrayBuffer(buffer)
      || resizable && Reflect.apply(resizable, buffer, []) !== false
      || Reflect.ownKeys(v).some(key => typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length!)) return bad();
  }
  const copy = allocateOwnedSealedBytes(length);
  Uint8Array.prototype.set.call(copy, v as Uint8Array);
  return copy;
}
export function capturePlaybackHistoryToken(v: unknown): PlaybackHistoryHeadToken {
  if (!closed(v, ['authority', 'storeId', 'revision', 'commitId', 'hotSha256', 'headSha256', 'indexRoot'])
    || !integer(v.revision) || (v.commitId !== null && !uuid(v.commitId))
    || (v.hotSha256 !== null && !isPlaybackHistoryDigest(v.hotSha256))
    || (v.headSha256 !== null && !isPlaybackHistoryDigest(v.headSha256))
    || (v.indexRoot !== null && !isPlaybackHistoryDigest(v.indexRoot))) return bad();
  if (v.authority === 'legacy') {
    if (v.storeId !== null || v.headSha256 !== null || v.indexRoot !== null
      || (v.revision === 0 ? v.commitId !== null || v.hotSha256 !== null : v.commitId === null || v.hotSha256 === null)) return bad();
  } else if (v.authority !== 'journal' || !uuid(v.storeId) || v.hotSha256 === null || v.headSha256 === null
    || (v.revision === 0 ? v.commitId !== null : v.commitId === null)) return bad();
  return Object.freeze({ ...v }) as unknown as PlaybackHistoryHeadToken;
}
export const samePlaybackHistoryToken = (a: PlaybackHistoryHeadToken, b: PlaybackHistoryHeadToken): boolean =>
  a.authority === b.authority && a.storeId === b.storeId && a.revision === b.revision && a.commitId === b.commitId
  && a.hotSha256 === b.hotSha256 && a.headSha256 === b.headSha256 && a.indexRoot === b.indexRoot;
function snapshot(v: unknown): PlaybackHistorySnapshotIdentity {
  if (!closed(v, ['revision', 'commitId', 'hotSha256']) || !integer(v.revision) || v.revision < 1
    || !uuid(v.commitId) || !isPlaybackHistoryDigest(v.hotSha256)) return bad();
  return Object.freeze({ revision: v.revision, commitId: v.commitId, hotSha256: v.hotSha256 });
}
function locator(v: unknown): PlaybackHistorySealedLocator {
  if (!closed(v, ['valueHash', 'archiveId', 'sealed']) || !isPlaybackHistoryDigest(v.valueHash) || !uuid(v.archiveId)) return bad();
  return Object.freeze({ valueHash: v.valueHash, archiveId: v.archiveId, sealed: sealed(v.sealed, PLAYBACK_HISTORY_MAX_STAGE_BYTES) });
}
function tokenHot(v: unknown, datasetId: string, token: PlaybackHistoryHeadToken): PlaybackHistoryHotState {
  if (closed(v, ['kind', 'datasetId', 'revision']) && v.kind === 'missing' && v.datasetId === datasetId
    && v.revision === 0 && token.authority === 'legacy' && token.hotSha256 === null) return { kind: 'missing', datasetId, revision: 0 };
  if (!closed(v, ['kind', 'datasetId', 'revision', 'commitId', 'sealed']) || v.kind !== 'sealed'
    || v.datasetId !== datasetId || v.revision !== token.revision || v.commitId !== token.commitId || token.hotSha256 === null) return bad();
  return { kind: 'sealed', datasetId, revision: token.revision, commitId: token.commitId, sealed: sealed(v.sealed) } as PlaybackHistoryHotState;
}
/** 原入站闭集先核验，再复制每个密文view；不借用外来buffer跨await。 */
export function capturePlaybackHistoryRequest(raw: unknown): PlaybackHistoryRequest {
  if (!raw || typeof raw !== 'object' || types.isProxy(raw)) return bad();
  const op = Object.getOwnPropertyDescriptor(raw, 'op')?.value as unknown;
  const fields = op === 'load' ? ['op', 'serverId', 'datasetId']
    : op === 'lookup' ? ['op', 'serverId', 'datasetId', 'expected', 'key']
    : op === 'stage' ? ['op', 'serverId', 'datasetId', 'expected', 'attemptId', 'nodes', 'locators']
    : op === 'commit' ? ['op', 'serverId', 'datasetId', 'expected', 'attemptId', 'mode', 'next', 'archiveCurrent']
    : op === 'read-commit' ? ['op', 'serverId', 'datasetId', 'expected', 'attemptId', 'next'] : [];
  if (!fields.length || !closed(raw, fields) || !isMobileId(raw.serverId) || !isMobileId(raw.datasetId)) return bad();
  const scope = { serverId: raw.serverId, datasetId: raw.datasetId };
  if (op === 'load') return { op, ...scope };
  const expected = capturePlaybackHistoryToken(raw.expected);
  if (op === 'lookup') {
    if (!isPlaybackHistoryDigest(raw.key)) return bad();
    return { op, ...scope, expected, key: raw.key };
  }
  if (!uuid(raw.attemptId)) return bad();
  const base = { ...scope, expected, attemptId: raw.attemptId };
  if (op === 'read-commit') return { op, ...base, next: capturePlaybackHistoryToken(raw.next) };
  if (op === 'stage') {
    const nodes = array(raw.nodes, PLAYBACK_HISTORY_MAX_STAGE_NODES).map(capturePlaybackHistoryNodeRecord);
    const locators = array(raw.locators, PLAYBACK_HISTORY_MAX_STAGE_LOCATORS).map(locator);
    const metadata = JSON.stringify({ ...base, op, nodes, locators: locators.map(({ valueHash, archiveId }) => ({ valueHash, archiveId })) });
    if (Buffer.byteLength(metadata) + locators.reduce((sum, item) => sum + item.sealed.byteLength, 0) > PLAYBACK_HISTORY_MAX_STAGE_BYTES) return bad();
    return { op, ...base, nodes, locators };
  }
  if (op !== 'commit' || !['activate', 'advance'].includes(raw.mode as string)
    || !closed(raw.next, ['token', 'sealedHead', 'hot'])) return bad();
  const token = capturePlaybackHistoryToken(raw.next.token);
  if (token.authority !== 'journal' || (raw.mode === 'activate'
    ? expected.authority !== 'legacy' || token.revision !== expected.revision || token.commitId !== expected.commitId || token.indexRoot !== null
    : expected.authority !== 'journal' || token.storeId !== expected.storeId || expected.revision >= Number.MAX_SAFE_INTEGER
      || token.revision !== expected.revision + 1 || token.commitId === expected.commitId)) return bad();
  let hot: Readonly<{ kind: 'reuse-current' }> | Readonly<{ kind: 'sealed'; sealed: Uint8Array }>;
  if (closed(raw.next.hot, ['kind']) && raw.next.hot.kind === 'reuse-current') {
    if (raw.mode !== 'activate' || expected.hotSha256 === null || token.hotSha256 !== expected.hotSha256) return bad();
    hot = { kind: 'reuse-current' };
  } else if (closed(raw.next.hot, ['kind', 'sealed']) && raw.next.hot.kind === 'sealed') hot = { kind: 'sealed', sealed: sealed(raw.next.hot.sealed) };
  else return bad();
  let archiveCurrent = null;
  if (raw.archiveCurrent !== null) {
    if (raw.mode !== 'advance' || !closed(raw.archiveCurrent, ['id', 'snapshot', 'sessionIds']) || !uuid(raw.archiveCurrent.id)) return bad();
    const identity = snapshot(raw.archiveCurrent.snapshot);
    const sessionIds = array(raw.archiveCurrent.sessionIds, 512).map(id => { if (!isMobileId(id)) return bad(); return id; });
    if (!sessionIds.length || new Set(sessionIds).size !== sessionIds.length || identity.revision !== expected.revision
      || identity.commitId !== expected.commitId || identity.hotSha256 !== expected.hotSha256) return bad();
    archiveCurrent = { id: raw.archiveCurrent.id, snapshot: identity, sessionIds };
  }
  return { op, ...base, mode: raw.mode as 'activate' | 'advance', archiveCurrent,
    next: { token, sealedHead: sealed(raw.next.sealedHead, PLAYBACK_HISTORY_MAX_STAGE_BYTES), hot } };
}
/** request缺省只供真实port listener验证形状；业务消费必须附本次原request。 */
export function capturePlaybackHistoryReply(raw: unknown, request?: PlaybackHistoryRequest): PlaybackHistoryReply {
  if (!raw || typeof raw !== 'object' || types.isProxy(raw)) return bad();
  const kind = Object.getOwnPropertyDescriptor(raw, 'kind')?.value as unknown;
  const keys = kind === 'loaded' ? ['kind', 'token', 'hot', 'sealedHead', 'legacyFileSha256']
    : kind === 'proof' ? ['kind', 'token', 'key', 'proof', 'locator', 'archive']
    : ['staged', 'committed', 'unconfirmed'].includes(kind as string) ? ['kind', 'token', 'attemptId']
    : kind === 'conflict' ? ['kind', 'token'] : [];
  if (!keys.length || !closed(raw, keys)) return bad();
  const token = capturePlaybackHistoryToken(raw.token);
  if (kind === 'conflict') return { kind, token };
  if (kind === 'loaded') {
    if (request && request.op !== 'load' || raw.legacyFileSha256 !== null && !isPlaybackHistoryDigest(raw.legacyFileSha256)
      || token.authority === 'legacy' && raw.sealedHead !== null || token.authority === 'journal' && raw.sealedHead === null) return bad();
    if (!raw.hot || typeof raw.hot !== 'object' || types.isProxy(raw.hot)) return bad();
    const datasetId = request?.datasetId ?? Object.getOwnPropertyDescriptor(raw.hot, 'datasetId')?.value as unknown;
    if (!isMobileId(datasetId)) return bad();
    return { kind, token, hot: tokenHot(raw.hot, datasetId, token), sealedHead: raw.sealedHead === null ? null
      : sealed(raw.sealedHead, PLAYBACK_HISTORY_MAX_STAGE_BYTES), legacyFileSha256: raw.legacyFileSha256 as string | null };
  }
  if (kind === 'proof') {
    if (!isPlaybackHistoryDigest(raw.key) || request && (request.op !== 'lookup' || request.key !== raw.key || !samePlaybackHistoryToken(token, request.expected))) return bad();
    const proof = array(raw.proof, PLAYBACK_HISTORY_MAX_PROOF_NODES).map(capturePlaybackHistoryNodeRecord);
    if (Buffer.byteLength(JSON.stringify(proof)) > PLAYBACK_HISTORY_MAX_PROOF_BYTES) return bad();
    const presence = verifyPlaybackHistoryProof(token.indexRoot, raw.key, proof);
    if (presence.kind === 'absent') {
      if (raw.locator !== null || raw.archive !== null) return bad();
      return { kind, token, key: raw.key, proof, locator: null, archive: null };
    }
    const found = locator(raw.locator);
    if (found.valueHash !== presence.valueHash || !closed(raw.archive, ['id', 'snapshot', 'sealed']) || raw.archive.id !== found.archiveId) return bad();
    return { kind, token, key: raw.key, proof, locator: found,
      archive: { id: found.archiveId, snapshot: snapshot(raw.archive.snapshot), sealed: sealed(raw.archive.sealed) } };
  }
  if (!uuid(raw.attemptId) || request && (!('attemptId' in request) || raw.attemptId !== request.attemptId)) return bad();
  if (kind === 'staged') {
    if (request && (request.op !== 'stage' || !samePlaybackHistoryToken(token, request.expected))) return bad();
    return { kind, token, attemptId: raw.attemptId };
  }
  if (kind === 'unconfirmed') {
    if (request && (request.op !== 'read-commit' || !samePlaybackHistoryToken(token, request.expected))) return bad();
    return { kind, token, attemptId: raw.attemptId };
  }
  if (kind !== 'committed' || request && (request.op !== 'commit' && request.op !== 'read-commit'
    || !samePlaybackHistoryToken(token, request.op === 'commit' ? request.next.token : request.next))) return bad();
  return { kind, token, attemptId: raw.attemptId };
}
export function isPlaybackHistoryRequest(raw: unknown): raw is PlaybackHistoryRequest {
  try { capturePlaybackHistoryRequest(raw); return true; } catch { return false; }
}
export function isPlaybackHistoryReply(raw: unknown, request?: PlaybackHistoryRequest): raw is PlaybackHistoryReply {
  try { capturePlaybackHistoryReply(raw, request); return true; } catch { return false; }
}
