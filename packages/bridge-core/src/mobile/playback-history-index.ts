import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { isMobileId } from '@music-bridge/contracts';
import { playbackCanonical, playbackFailure, playbackInteger } from './playback-state.js';
import { PLAYBACK_HISTORY_MAX_PROOF_BYTES, PLAYBACK_HISTORY_MAX_PROOF_NODES,
  type PlaybackHistoryNode, type PlaybackHistoryNodeRecord, type PlaybackHistoryRecordKind,
  type PlaybackHistoryRoot } from './playback-history-types.js';

const bad = (): never => playbackFailure(503, 'BUSY');
export const isPlaybackHistoryDigest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
function closed(raw: unknown, keys: readonly string[]): raw is Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || types.isProxy(raw)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  return Reflect.ownKeys(descriptors).length === keys.length
    && keys.every(key => descriptors[key]?.enumerable && Object.hasOwn(descriptors[key]!, 'value'));
}
export function capturePlaybackHistoryNode(raw: unknown): PlaybackHistoryNode {
  if (closed(raw, ['kind', 'key', 'valueHash']) && raw.kind === 'leaf'
    && isPlaybackHistoryDigest(raw.key) && isPlaybackHistoryDigest(raw.valueHash))
    return Object.freeze({ kind: 'leaf', key: raw.key, valueHash: raw.valueHash });
  if (closed(raw, ['kind', 'bit', 'zero', 'one']) && raw.kind === 'branch'
    && playbackInteger(raw.bit, 0, 255) && isPlaybackHistoryDigest(raw.zero) && isPlaybackHistoryDigest(raw.one)
    && raw.zero !== raw.one) return Object.freeze({ kind: 'branch', bit: raw.bit, zero: raw.zero, one: raw.one });
  return bad();
}
export function historyNodeHash(raw: unknown): string {
  const node = capturePlaybackHistoryNode(raw);
  return createHash('sha256').update(playbackCanonical(['MBM002_HISTORY_NODE_V1', node])).digest('hex');
}
export function capturePlaybackHistoryNodeRecord(raw: unknown): PlaybackHistoryNodeRecord {
  if (!closed(raw, ['hash', 'node']) || !isPlaybackHistoryDigest(raw.hash)) return bad();
  const node = capturePlaybackHistoryNode(raw.node);
  if (historyNodeHash(node) !== raw.hash) return bad();
  return Object.freeze({ hash: raw.hash, node });
}
export function historyLookupKey(kind: PlaybackHistoryRecordKind, serverId: string, datasetId: string, identity: unknown): string {
  if (!isMobileId(serverId) || !isMobileId(datasetId)) return bad();
  let value: unknown;
  if (kind === 'receipt') {
    if (!closed(identity, ['deviceId', 'deviceEpoch', 'keyHash']) || !isMobileId(identity.deviceId)
      || !playbackInteger(identity.deviceEpoch) || !isPlaybackHistoryDigest(identity.keyHash)) return bad();
    value = [identity.deviceId, identity.deviceEpoch, identity.keyHash];
  } else if (kind === 'session' || kind === 'resource') {
    // 旧session命中后仍由原helper裁决device/epoch，不能把旧epoch的403改成404。
    if (!closed(identity, ['id']) || !isMobileId(identity.id)) return bad();
    value = identity.id;
  } else return bad();
  return createHash('sha256').update(playbackCanonical(['MBM002_HISTORY_KEY_V1', serverId, datasetId, kind, value])).digest('hex');
}
const bit = (key: string, index: number): number => (parseInt(key[Math.floor(index / 4)]!, 16) >>> (3 - index % 4)) & 1;
function proofSnapshot(raw: unknown): readonly PlaybackHistoryNodeRecord[] {
  if (!Array.isArray(raw) || types.isProxy(raw) || Object.getPrototypeOf(raw) !== Array.prototype
    || raw.length > PLAYBACK_HISTORY_MAX_PROOF_NODES || Reflect.ownKeys(raw).length !== raw.length + 1) return bad();
  const result: PlaybackHistoryNodeRecord[] = [];
  for (let index = 0; index < raw.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return bad();
    result.push(capturePlaybackHistoryNodeRecord(descriptor.value));
  }
  if (Buffer.byteLength(playbackCanonical(result)) > PLAYBACK_HISTORY_MAX_PROOF_BYTES) return bad();
  return result;
}
export type PlaybackHistoryProofResult = Readonly<{ kind: 'present'; valueHash: string }> | Readonly<{ kind: 'absent' }>;
function checkedProof(root: PlaybackHistoryRoot, key: string, raw: unknown): {
  proof: readonly PlaybackHistoryNodeRecord[]; result: PlaybackHistoryProofResult;
} {
  if (root !== null && !isPlaybackHistoryDigest(root) || !isPlaybackHistoryDigest(key)) return bad();
  const proof = proofSnapshot(raw);
  if (root === null) {
    if (proof.length) return bad();
    return { proof, result: { kind: 'absent' } };
  }
  let expected = root, previousBit = -1;
  const branches: Extract<PlaybackHistoryNode, { kind: 'branch' }>[] = [], seen = new Set<string>();
  for (const [index, record] of proof.entries()) {
    if (record.hash !== expected || seen.has(record.hash)) return bad();
    seen.add(record.hash);
    const node = record.node;
    if (node.kind === 'leaf') {
      if (index !== proof.length - 1 || branches.some(branch => bit(node.key, branch.bit) !== bit(key, branch.bit))) return bad();
      return { proof, result: node.key === key ? { kind: 'present', valueHash: node.valueHash } : { kind: 'absent' } };
    }
    if (node.bit <= previousBit) return bad();
    previousBit = node.bit; branches.push(node);
    expected = bit(key, node.bit) ? node.one : node.zero;
  }
  // 非空认证树缺应有节点永远不是不存在，不能让旧幂等key重生。
  return bad();
}
export function verifyPlaybackHistoryProof(root: PlaybackHistoryRoot, key: string, proof: unknown): PlaybackHistoryProofResult {
  return checkedProof(root, key, proof).result;
}
/** Owner同连接点查及Main本次更新overlay共用；不扫描完整历史。 */
export function readPlaybackHistoryProof(root: PlaybackHistoryRoot, key: string,
  read: (hash: string) => unknown): readonly PlaybackHistoryNodeRecord[] {
  if (root !== null && !isPlaybackHistoryDigest(root) || !isPlaybackHistoryDigest(key) || typeof read !== 'function') return bad();
  const proof: PlaybackHistoryNodeRecord[] = [];
  let current = root;
  while (current !== null) {
    if (proof.length >= PLAYBACK_HISTORY_MAX_PROOF_NODES) return bad();
    const record = capturePlaybackHistoryNodeRecord(read(current));
    if (record.hash !== current) return bad();
    proof.push(record);
    if (record.node.kind === 'leaf') break;
    current = bit(key, record.node.bit) ? record.node.one : record.node.zero;
  }
  checkedProof(root, key, proof);
  return proof;
}
/** 专用不可变Patricia追加：同key同值幂等；任何改写原locator都拒绝。 */
export function updatePlaybackHistoryProof(root: PlaybackHistoryRoot, key: string, valueHash: string, raw: unknown): {
  root: string; nodes: readonly PlaybackHistoryNodeRecord[];
} {
  if (!isPlaybackHistoryDigest(valueHash)) return bad();
  const { proof, result } = checkedProof(root, key, raw);
  if (result.kind === 'present') {
    if (result.valueHash !== valueHash || root === null) return bad();
    return { root, nodes: [] };
  }
  const nodes: PlaybackHistoryNodeRecord[] = [];
  const append = (node: PlaybackHistoryNode): string => {
    const captured = capturePlaybackHistoryNode(node), hash = historyNodeHash(captured);
    nodes.push(Object.freeze({ hash, node: captured })); return hash;
  };
  const leaf = append({ kind: 'leaf', key, valueHash });
  if (root === null) return { root: leaf, nodes };
  const oldLeaf = proof.at(-1)!.node;
  if (oldLeaf.kind !== 'leaf') return bad();
  let split = 0;
  while (split < 256 && bit(key, split) === bit(oldLeaf.key, split)) split++;
  if (split === 256) return bad();
  let insertion = 0;
  while (insertion < proof.length && proof[insertion]!.node.kind === 'branch'
    && (proof[insertion]!.node as Extract<PlaybackHistoryNode, { kind: 'branch' }>).bit < split) insertion++;
  const sibling = proof[insertion]!.hash;
  let current = append({ kind: 'branch', bit: split, zero: bit(key, split) ? sibling : leaf, one: bit(key, split) ? leaf : sibling });
  for (let index = insertion - 1; index >= 0; index--) {
    const branch = proof[index]!.node;
    if (branch.kind !== 'branch') return bad();
    current = append({ ...branch, ...(bit(key, branch.bit) ? { one: current } : { zero: current }) });
  }
  return { root: current, nodes };
}
