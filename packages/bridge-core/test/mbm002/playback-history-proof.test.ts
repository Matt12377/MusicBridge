import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { historyLookupKey, historyNodeHash, updatePlaybackHistoryProof, verifyPlaybackHistoryProof } from '../../src/mobile/playback-history-index.js';
import type { PlaybackHistoryNode, PlaybackHistoryNodeRecord, PlaybackHistoryRoot } from '../../src/mobile/playback-history-types.js';
const SERVER = 'history.synthetic.server', DATASET = '60000000-0000-4000-8000-000000000001';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const bit = (key: string, position: number) => (Number.parseInt(key.slice(Math.floor(position / 4), Math.floor(position / 4) + 1), 16) >> (3 - position % 4)) & 1;
/** 模拟不可信Owner传输，只按指针取节点；认证与非成员判定必须由生产verifier完成。 */
function transport(root: PlaybackHistoryRoot, key: string, nodes: ReadonlyMap<string, PlaybackHistoryNodeRecord>): PlaybackHistoryNodeRecord[] {
  const proof: PlaybackHistoryNodeRecord[] = [], visited = new Set<string>(); let current = root;
  while (current !== null) {
    assert.ok(!visited.has(current)); assert.ok(proof.length <= 256); visited.add(current);
    const value = nodes.get(current); assert.ok(value, '合成传输缺节点，不能伪造空proof。'); proof.push(structuredClone(value));
    if (value.node.kind === 'leaf') break;
    current = bit(key, value.node.bit) ? value.node.one : value.node.zero;
  }
  return proof;
}
function append(root: PlaybackHistoryRoot, key: string, valueHash: string, nodes: Map<string, PlaybackHistoryNodeRecord>) {
  const result = updatePlaybackHistoryProof(root, key, valueHash, transport(root, key, nodes));
  for (const record of result.nodes) {
    assert.equal(historyNodeHash(record.node), record.hash);
    const prior = nodes.get(record.hash); if (prior) assert.deepEqual(prior, record);
    nodes.set(record.hash, structuredClone(record));
  }
  return result;
}

test('历史索引：所有原键与未出现键有有界成员/非成员证明，旧root始终保全原映射', () => {
  const keys = [...Array.from({ length: 48 }, (_, index) => digest(`history.proof.key.${index}`)),
    '0'.repeat(64), '0'.repeat(63) + '1', '8' + '0'.repeat(63), 'f'.repeat(64)];
  const nodes = new Map<string, PlaybackHistoryNodeRecord>(), expected = new Map<string, string>();
  const snapshots: { root: PlaybackHistoryRoot; entries: Map<string, string> }[] = [{ root: null, entries: new Map() }];
  let root: PlaybackHistoryRoot = null;
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]!, valueHash = digest(`history.proof.value.${index}`);
    assert.deepEqual(verifyPlaybackHistoryProof(root, key, transport(root, key, nodes)), { kind: 'absent' });
    root = append(root, key, valueHash, nodes).root; expected.set(key, valueHash);
    if (index % 8 === 7 || index === keys.length - 1) snapshots.push({ root, entries: new Map(expected) });
  }
  for (const snapshot of snapshots) {
    for (const key of [...keys, digest('history.proof.never-created')]) {
      const proof = transport(snapshot.root, key, nodes); assert.ok(proof.length <= 257);
      const found = snapshot.entries.get(key);
      assert.deepEqual(verifyPlaybackHistoryProof(snapshot.root, key, proof),
        found === undefined ? { kind: 'absent' } : { kind: 'present', valueHash: found });
    }
  }
  assert.equal(expected.size, keys.length);
});

test('历史索引：相同key只准相同value重用，不能用新locator覆盖原历史', () => {
  const key = digest('history.immutable.key'), value = digest('history.immutable.value');
  const nodes = new Map<string, PlaybackHistoryNodeRecord>(), first = append(null, key, value, nodes);
  const proof = transport(first.root, key, nodes);
  assert.deepEqual(updatePlaybackHistoryProof(first.root, key, value, proof), { root: first.root, nodes: [] });
  assert.throws(() => updatePlaybackHistoryProof(first.root, key, digest('history.replacement.value'), proof));
  assert.deepEqual(verifyPlaybackHistoryProof(first.root, key, proof), { kind: 'present', valueHash: value });
});

test('历史索引：真实256层路径成员proof为257节点，最深追加不损失任意旧键', () => {
  const zero = '0'.repeat(64), nodes = new Map<string, PlaybackHistoryNodeRecord>();
  let root: PlaybackHistoryRoot = append(null, zero, digest('history.deep.zero'), nodes).root;
  const keys = [zero];
  for (let position = 0; position < 256; position++) {
    const digits = Array.from({ length: 64 }, () => '0');
    digits[Math.floor(position / 4)] = (1 << (3 - position % 4)).toString(16);
    const key = digits.join(''), result = append(root, key, digest(`history.deep.${position}`), nodes);
    if (position === 255) assert.equal(result.nodes.length, 257, '合法最深追加必须由adapter分帧，不能增单stage帽。');
    root = result.root; keys.push(key);
  }
  const proof = transport(root, zero, nodes); assert.equal(proof.length, 257);
  assert.deepEqual(verifyPlaybackHistoryProof(root, zero, proof), { kind: 'present', valueHash: digest('history.deep.zero') });
  for (const position of [0, 1, 127, 254, 255]) {
    const key = keys[position + 1]!;
    assert.deepEqual(verifyPlaybackHistoryProof(root, key, transport(root, key, nodes)),
      { kind: 'present', valueHash: digest(`history.deep.${position}`) });
  }
  assert.throws(() => verifyPlaybackHistoryProof(root, zero, [...proof, proof.at(-1)!]));
});

test('历史索引：缺节点、错root、错hash、删尾和拼接proof都不能成为合法absence', () => {
  const keys = ['0'.repeat(64), '0'.repeat(63) + '1', '8' + '0'.repeat(63)], nodes = new Map<string, PlaybackHistoryNodeRecord>();
  let root: PlaybackHistoryRoot = null;
  for (const [index, key] of keys.entries()) root = append(root, key, digest(`history.integrity.${index}`), nodes).root;
  const key = keys[0]!, proof = transport(root, key, nodes); assert.ok(proof.length >= 3);
  assert.throws(() => verifyPlaybackHistoryProof(root, key, []));
  assert.throws(() => verifyPlaybackHistoryProof(root, key, proof.slice(1)));
  assert.throws(() => verifyPlaybackHistoryProof(root, key, proof.slice(0, -1)));
  assert.throws(() => verifyPlaybackHistoryProof(digest('history.wrong.root'), key, proof));
  const wrongHash = structuredClone(proof); wrongHash[0] = { ...wrongHash[0]!, hash: digest('history.wrong.hash') };
  assert.throws(() => verifyPlaybackHistoryProof(root, key, wrongHash));
  const changed = structuredClone(proof), last = changed.at(-1)!; assert.equal(last.node.kind, 'leaf');
  changed[changed.length - 1] = { hash: last.hash, node: { kind: 'leaf', key, valueHash: digest('history.wrong.value') } };
  assert.throws(() => verifyPlaybackHistoryProof(root, key, changed));
  assert.throws(() => verifyPlaybackHistoryProof(root, key, [...proof, proof.at(-1)!]));
  const other = transport(root, keys[2]!, nodes);
  assert.throws(() => verifyPlaybackHistoryProof(root, key, [...proof, ...other]));
  assert.deepEqual(verifyPlaybackHistoryProof(root, digest('history.valid.absence'), transport(root, digest('history.valid.absence'), nodes)), { kind: 'absent' });
});

test('历史索引：分支bit必须严格递增，256bit/节点与字节硬界不能用畸形树绕过', () => {
  const leaf = (key: string): PlaybackHistoryNodeRecord => {
    const node: PlaybackHistoryNode = { kind: 'leaf', key, valueHash: digest(`history.leaf.${key}`) };
    return { hash: historyNodeHash(node), node };
  };
  const zero = leaf('0'.repeat(64)), one = leaf('f'.repeat(64)), other = leaf('8' + '0'.repeat(63));
  assert.throws(() => {
    const child: PlaybackHistoryNode = { kind: 'branch', bit: 4, zero: zero.hash, one: one.hash };
    const branch: PlaybackHistoryNode = { kind: 'branch', bit: 5, zero: historyNodeHash(child), one: other.hash };
    verifyPlaybackHistoryProof(historyNodeHash(branch), '0'.repeat(64), [
      { hash: historyNodeHash(branch), node: branch }, { hash: historyNodeHash(child), node: child }, zero,
    ]);
  });
  for (const position of [-1, 256, Number.MAX_SAFE_INTEGER])
    assert.throws(() => historyNodeHash({ kind: 'branch', bit: position, zero: zero.hash, one: one.hash }));
  assert.throws(() => verifyPlaybackHistoryProof(zero.hash, '0'.repeat(64), Array.from({ length: 258 }, () => zero)));
  assert.throws(() => verifyPlaybackHistoryProof(zero.hash, '0'.repeat(64), [
    { hash: zero.hash, node: { kind: 'leaf', key: '0'.repeat(128 * 1024), valueHash: digest('history.large') } },
  ]));
  const left: PlaybackHistoryNode = { kind: 'branch', bit: 0, zero: zero.hash, one: one.hash };
  assert.notEqual(historyNodeHash(left), historyNodeHash({ ...left, zero: left.one, one: left.zero }));
  assert.notEqual(historyNodeHash(left), historyNodeHash({ ...left, bit: 1 }));
});

test('历史索引：receipt保持跨operation全局键，device/epoch/server/dataset与记录种类严格隔离', () => {
  const identity = { deviceId: 'history.proof.device', deviceEpoch: 1, keyHash: digest('history.original.idempotency.key') };
  const key = historyLookupKey('receipt', SERVER, DATASET, identity);
  assert.match(key, /^[a-f0-9]{64}$/u);
  const keys = [key, historyLookupKey('receipt', SERVER, DATASET, { ...identity, deviceId: 'history.proof.other' }),
    historyLookupKey('receipt', SERVER, DATASET, { ...identity, deviceEpoch: 2 }),
    historyLookupKey('receipt', 'history.other.server', DATASET, identity),
    historyLookupKey('receipt', SERVER, 'history.other.dataset', identity),
    historyLookupKey('session', SERVER, DATASET, { id: 'history.proof.same-id' }),
    historyLookupKey('resource', SERVER, DATASET, { id: 'history.proof.same-id' })];
  assert.equal(new Set(keys).size, keys.length);
  // session只按原ID点中；归属与旧epoch由原service helper判定，不能在索引负查时变404。
  assert.equal(historyLookupKey('session', SERVER, DATASET, { id: 'history.proof.same-id' }), keys[5]);
  assert.throws(() => historyLookupKey('receipt', SERVER, DATASET, { ...identity, operation: 'createSession' } as typeof identity));
  let calls = 0;
  const getter = Object.defineProperty({}, 'id', { enumerable: true, get() { calls++; return 'history.proof.same-id'; } });
  assert.throws(() => historyLookupKey('session', SERVER, DATASET, getter as { id: string }));
  assert.equal(calls, 0);
});
