import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { randomBytes } from 'node:crypto';
import { createMobileAuthCrypto } from '../../src/mobile/auth-crypto.js';
import { createMobilePlaybackService } from '../../src/mobile/playback-service.js';
import { encodePlaybackStorage, decodePlaybackStorage, readPlaybackStorageRejectionBoundary } from '../../src/mobile/playback-state-codec.js';
import { capturePlaybackState, playbackCopy } from '../../src/mobile/playback-state.js';
import { MOBILE_PLAYBACK_DEFAULT_LIMITS, MOBILE_PLAYBACK_STATE_LOGICAL_NODE_LIMIT, MobilePlaybackError, type MobilePlaybackSourcePort } from '../../src/mobile/playback-types.js';
import type { MobileAuthPersistence, MobileSealedState } from '../../src/mobile/types.js';
import { capacityHistory, capacityLogicalBoundary, capacityNodes, capacityPrincipal, CAPACITY_SERVER as SERVER, CAPACITY_DATASET as DATASET, CAPACITY_ORIGIN as ORIGIN, CAPACITY_NOW as NOW } from './playback-state-capacity-fixture.js';
import { capacityDigest } from './playback-state-capacity-fixture.js';

const limits = MOBILE_PLAYBACK_DEFAULT_LIMITS;
const signal = () => new AbortController().signal;
const noSource: MobilePlaybackSourcePort = { async prepare() { throw new Error('不执行历史来源准备'); }, async verify() {}, async renew() {},
  async read() { throw new Error('不读取媒体'); }, async closeRead() {}, async release() {} };

test('逻辑容量：36会话559资源1139回执完整迁移后新增会话，并保全全部原键和授权围栏', { timeout: 60_000 }, async t => {
  const state = capacityHistory();
  // 旧合法账本恰在旧逻辑边界内；新增会话及回执使候选越过200k。
  assert.equal(capacityNodes(state), 199_992);
  const started = performance.now(), packed = encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, limits);
  t.diagnostic(JSON.stringify({ synthetic: true, logicalNodes: capacityNodes(state), physicalNodes: capacityNodes(JSON.parse(packed.canonical)),
    physicalBytes: packed.bytes.length, encodeMs: Math.round(performance.now() - started) }));
  assert.ok(packed.bytes.length <= limits.stateBytes); assert.ok(capacityNodes(JSON.parse(packed.canonical)) <= 200_000);
  const key = randomBytes(32), crypto = createMobileAuthCrypto(key); key.fill(0);
  const aad = (revision: number) => Buffer.from(JSON.stringify(['MBM002_PLAYBACK_STATE_V1', SERVER, DATASET, revision]));
  let row: MobileSealedState = { kind: 'sealed', datasetId: DATASET, revision: state.revision, commitId: state.commitId!, sealed: crypto.seal(packed.bytes, aad(state.revision)) };
  let saves = 0, revoked = false;
  const persistence: MobileAuthPersistence = {
    async load() { return structuredClone(row); },
    async save(request) {
      assert.equal(request.expectedRevision, row.revision); saves++;
      row = { kind: 'sealed', datasetId: DATASET, revision: request.expectedRevision + 1, commitId: request.commitId, sealed: new Uint8Array(request.sealed) };
      return { kind: 'saved', datasetId: DATASET, revision: row.revision, commitId: row.commitId };
    },
  };
  const create = () => createMobilePlaybackService({ serverId: SERVER, datasetId: DATASET, responseOrigin: ORIGIN, persistence, crypto,
    sourcePort: noSource, nowMs: () => NOW, auth: { async assertDeviceCurrent() { if (revoked) throw new MobilePlaybackError(401, 'DEVICE_REVOKED'); } } });
  const actor = create(); t.after(() => actor.close());
  const request = { path: '/mobile/v1/sessions', pathParameters: {}, query: {}, body: { clientInstanceId: 'capacity.new.client' }, idempotencyKey: 'capacity.new.original-key' };
  const fresh = capacityPrincipal('capacity.synthetic.new');
  const first = await actor.control('createSession', request, fresh, signal()); assert.equal(first.status, 201); await first.beforeSend();
  assert.equal(saves, 1);
  assert.equal(row.kind, 'sealed'); if (row.kind !== 'sealed') throw new Error('合成回执未持久化');
  const plain = crypto.open(row.sealed, aad(row.revision));
  try {
    const after = decodePlaybackStorage(plain, SERVER, DATASET, ORIGIN, limits).state;
    assert.equal(after.sessions.length, 37); assert.equal(after.resources.length, 559); assert.equal(after.receipts.length, 1140);
    assert.deepEqual(after.sessions.slice(0, state.sessions.length), state.sessions); assert.deepEqual(after.resources, state.resources);
    assert.deepEqual(after.receipts.slice(0, state.receipts.length), state.receipts);
  } finally { plain.fill(0); }
  await actor.close(); const cold = create(); t.after(() => cold.close());
  const replay = await cold.control('createSession', request, fresh, signal()); assert.equal(replay.status, first.status); assert.deepEqual(replay.body, first.body);
  for (const receipt of state.receipts) {
    const old = await cold.control(receipt.operation, receipt.request, capacityPrincipal(), signal());
    assert.equal(old.status, receipt.reply!.status); assert.deepEqual(old.body, receipt.reply!.body);
  }
  assert.equal(saves, 1); revoked = true;
  await assert.rejects(replay.beforeSend(), e => e instanceof MobilePlaybackError && e.code === 'DEVICE_REVOKED');
});

test('逻辑容量：4096条终态历史和20格式共享请求仍保留，物理2MiB及200k节点不变', { timeout: 60_000 }, t => {
  const state = capacityHistory({ sessions: 1, resources: 1, receipts: 4096, formats: 20, errors: true });
  const nodes = capacityNodes(state); assert.ok(nodes > 500_000 && nodes <= 1_000_000);
  const started = performance.now(), encoded = encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, limits);
  const physicalNodes = capacityNodes(JSON.parse(encoded.canonical));
  assert.ok(encoded.bytes.length <= 2 * 1024 * 1024); assert.ok(physicalNodes <= 200_000);
  assert.deepEqual(decodePlaybackStorage(encoded.bytes, SERVER, DATASET, ORIGIN, limits).state, state);
  t.diagnostic(JSON.stringify({ synthetic: true, receipts: state.receipts.length, logicalNodes: nodes, physicalNodes,
    physicalBytes: encoded.bytes.length, encodeDecodeMs: Math.round(performance.now() - started) }));
});

test('逻辑容量：合法共享模板逐次计费，超1m在复制或语义展开前拒绝；终态仍预留未来节点', { timeout: 60_000 }, t => {
  const { inside, next } = capacityLogicalBoundary();
  const encoded = encodePlaybackStorage(inside, SERVER, DATASET, ORIGIN, limits);
  assert.ok(capacityNodes(inside) <= MOBILE_PLAYBACK_STATE_LOGICAL_NODE_LIMIT);
  assert.equal(encoded.format, 'v5');
  assert.deepEqual(decodePlaybackStorage(encoded.bytes, SERVER, DATASET, ORIGIN, limits).state, inside);
  const outside = playbackCopy(inside); outside.receipts.push(next); outside.revision++;
  assert.ok(capacityNodes(outside) > MOBILE_PLAYBACK_STATE_LOGICAL_NODE_LIMIT);
  capturePlaybackState(outside, SERVER, DATASET, ORIGIN, limits);
  assert.throws(() => encodePlaybackStorage(outside, SERVER, DATASET, ORIGIN, limits), error => error instanceof MobilePlaybackError
    && error.code === 'RESOURCE_BUSY' && readPlaybackStorageRejectionBoundary(error) === 'worker-raw');

  // 给真正可解析的v4报文追加一个合法模板引用；物理预算内，展开后才越过新逻辑上限。
  const packed = JSON.parse(encoded.canonical) as { shapes: string[][]; strings: string[]; root: unknown[] };
  const position = (tuple: unknown[], key: string) => packed.shapes[(tuple[0] as number) - 1]!.indexOf(key) + 1;
  const receipts = packed.root[position(packed.root, 'receipts')] as unknown[][];
  const last = playbackCopy(receipts.at(-1)!);
  const storeString = (value: string): string => { const id = packed.strings.length; packed.strings.push(value); return '~' + id.toString(36).padStart(4, '0'); };
  last[position(last, 'id')] = storeString(next.id); last[position(last, 'keyHash')] = storeString(next.keyHash);
  const request = last[position(last, 'request')] as unknown[];
  request[position(request, 'idempotencyKey')] = storeString(next.request.idempotencyKey!);
  receipts.push(last); packed.root[position(packed.root, 'revision')] = outside.revision;
  const fanout = new Uint8Array(Buffer.from(JSON.stringify(packed)));
  assert.ok(fanout.length <= limits.stateBytes); assert.ok(capacityNodes(packed) <= 200_000);
  assert.throws(() => decodePlaybackStorage(fanout, SERVER, DATASET, ORIGIN, limits), error => error instanceof MobilePlaybackError && error.code === 'BUSY');

  const reserved = playbackCopy(inside), pending = reserved.receipts.at(-1)!;
  pending.state = 'UNKNOWN'; pending.reply = null; pending.resourceContext = null;
  const resource = reserved.resources[0]!;
  const tickets = Math.floor((MOBILE_PLAYBACK_STATE_LOGICAL_NODE_LIMIT - capacityNodes(reserved)) / 4);
  for (let i = 0; i < tickets; i++) resource.tickets.push({ hash: i.toString(16).padStart(64, 'b'), expiresAt: resource.hardExpiresAt, runtimeEpoch: resource.runtimeEpoch });
  assert.ok(capacityNodes(reserved) <= MOBILE_PLAYBACK_STATE_LOGICAL_NODE_LIMIT);
  capturePlaybackState(reserved, SERVER, DATASET, ORIGIN, limits);
  assert.throws(() => encodePlaybackStorage(reserved, SERVER, DATASET, ORIGIN, limits), error => error instanceof MobilePlaybackError
    && error.code === 'RESOURCE_BUSY' && readPlaybackStorageRejectionBoundary(error) === 'terminal-logical');
  t.diagnostic(JSON.stringify({ synthetic: true, insideNodes: capacityNodes(inside), outsideNodes: capacityNodes(outside),
    physicalNodes: capacityNodes(JSON.parse(encoded.canonical)), physicalBytes: encoded.bytes.length, reservedNodes: capacityNodes(reserved) }));
});

test('物理预算：逻辑仍在1m以内且v4小于2MiB时，物理超过200k依然拒绝', { timeout: 60_000 }, t => {
  const state = capacityHistory(), encoded = encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, limits);
  assert.ok(['v3', 'v5'].includes(encoded.format));
  const packed = JSON.parse(encoded.canonical) as { schema: string; shapes: string[][]; strings: string[]; root: unknown[] };
  if (encoded.format === 'v3') {
    packed.schema = 'mbm002.playback-compact-state.v4'; packed.strings = [];
    const ids = new Map<string, number>();
    const intern = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(intern);
      if (typeof value !== 'string' || !value.startsWith('~') && Buffer.byteLength(JSON.stringify(value)) < 16) return value;
      let id = ids.get(value); if (id === undefined) { id = packed.strings.length; packed.strings.push(value); ids.set(value, id); }
      return '~' + id.toString(36).padStart(4, '0');
    };
    packed.root = intern(packed.root) as unknown[];
  }
  // 变异前完整报文可读，后续拒绝只由物理节点上限触发。
  assert.deepEqual(decodePlaybackStorage(new Uint8Array(Buffer.from(JSON.stringify(packed))), SERVER, DATASET, ORIGIN, limits).state, state);
  const position = (tuple: unknown[], key: string) => packed.shapes[(tuple[0] as number) - 1]!.indexOf(key) + 1;
  const rows = packed.root[position(packed.root, 'receipts')] as unknown[][], template = state.receipts.at(-1)!;
  const wireTemplate = rows.at(-1)!, dictionary = new Map(packed.strings.map((value, i) => [value, i]));
  const storeString = (value: string): string => {
    // 保持v4原有短字符串内联规则及长字符串唯一字典。
    if (!value.startsWith('~') && Buffer.byteLength(JSON.stringify(value)) < 16) return value;
    let id = dictionary.get(value);
    if (id === undefined) { id = packed.strings.length; packed.strings.push(value); dictionary.set(value, id); }
    return '~' + id.toString(36).padStart(4, '0');
  };
  // 每条增量节点固定；最后一次只略过200k，保持物理字节远低于2MiB。
  let currentNodes = capacityNodes(packed);
  for (let i = 0; currentNodes <= 200_000; i++) {
    assert.ok(state.receipts.length < limits.maxReceipts);
    const oldStrings = packed.strings.length;
    const next = playbackCopy(template), wire = playbackCopy(wireTemplate);
    next.id = `physical.${i}`; next.request.idempotencyKey = `physical-key.${i}`;
    next.keyHash = capacityDigest('key', [next.deviceId, next.deviceEpoch, next.request.idempotencyKey]);
    wire[position(wire, 'id')] = storeString(next.id); wire[position(wire, 'keyHash')] = storeString(next.keyHash);
    const request = wire[position(wire, 'request')] as unknown[];
    request[position(request, 'idempotencyKey')] = storeString(next.request.idempotencyKey);
    rows.push(wire); state.receipts.push(next); state.revision++;
    currentNodes += capacityNodes(wire) + packed.strings.length - oldStrings;
  }
  packed.root[position(packed.root, 'revision')] = state.revision;
  const bytes = new Uint8Array(Buffer.from(JSON.stringify(packed))), logicalNodes = capacityNodes(state), physicalNodes = capacityNodes(packed);
  assert.ok(logicalNodes < MOBILE_PLAYBACK_STATE_LOGICAL_NODE_LIMIT); assert.ok(physicalNodes > 200_000);
  assert.ok(bytes.length < limits.stateBytes); capturePlaybackState(state, SERVER, DATASET, ORIGIN, limits);
  assert.throws(() => decodePlaybackStorage(bytes, SERVER, DATASET, ORIGIN, limits), error => error instanceof MobilePlaybackError && error.code === 'BUSY');
  const repacked = encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, limits);
  assert.ok(capacityNodes(JSON.parse(repacked.canonical)) <= 200_000);
  assert.deepEqual(decodePlaybackStorage(repacked.bytes, SERVER, DATASET, ORIGIN, limits).state, state);
  t.diagnostic(JSON.stringify({ synthetic: true, logicalNodes, physicalNodes, physicalBytes: bytes.length,
    selectedFormat: repacked.format, selectedPhysicalNodes: capacityNodes(JSON.parse(repacked.canonical)) }));
});
