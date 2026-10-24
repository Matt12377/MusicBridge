import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { createMobileAuthCrypto } from '../../src/mobile/auth-crypto.js';
import { createMobilePlaybackService } from '../../src/mobile/playback-service.js';
import { MobilePlaybackError, type MobilePlaybackSourcePort } from '../../src/mobile/playback-types.js';
import type { MobileAuthPersistence, MobileSealedState } from '../../src/mobile/types.js';
import { encodePlaybackStorage, decodePlaybackStorage } from '../../src/mobile/playback-state-codec.js';
import { capturePlaybackState } from '../../src/mobile/playback-state.js';
import { MOBILE_PLAYBACK_DEFAULT_LIMITS as limits } from '../../src/mobile/playback-types.js';
import { capacityHistory, capacityNodes, CAPACITY_SERVER as SERVER, CAPACITY_DATASET as DATASET, CAPACITY_ORIGIN as ORIGIN, CAPACITY_NOW as NOW, capacityPrincipal } from './playback-state-capacity-fixture.js';

// 完全合成：不读取真实账本、票据、Provider或磁盘缓存。
function nearPhysicalHistory() {
  const state = capacityHistory({ sessions: 52, resources: 588, receipts: 1415 });
  const reason = '合成原字节'.repeat(10);
  for (const resource of state.resources) resource.source!.processing.reason = reason;
  for (const receipt of state.receipts) if (receipt.reply && receipt.reply.status < 400 && receipt.operation !== 'createSession')
    (receipt.reply.body as { processing: { reason: string } }).processing.reason = reason;
  return capturePlaybackState(state, SERVER, DATASET, ORIGIN, limits);
}
function roundtrip(state: ReturnType<typeof capacityHistory>, configuration = limits) {
  const encoded = encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, configuration);
  assert.ok(encoded.bytes.byteLength <= configuration.stateBytes);
  assert.ok(capacityNodes(JSON.parse(encoded.canonical)) <= 200_000);
  assert.deepEqual(decodePlaybackStorage(encoded.bytes, SERVER, DATASET, ORIGIN, configuration).state, state);
  return encoded;
}

test('选择性字符串：v3字节满且旧v4唯一串节点满时，全部历史无损写入原物理预算', { timeout: 60_000 }, () => {
  const state = nearPhysicalHistory();
  const encoded = roundtrip(state);
  assert.equal(encoded.format, 'v5');
  assert.equal(state.sessions.length, 52); assert.equal(state.resources.length, 588); assert.equal(state.receipts.length, 1415);
  assert.deepEqual(decodePlaybackStorage(encoded.bytes, SERVER, DATASET, ORIGIN, limits).state.receipts, state.receipts);
});

test('选择性字符串：物理临界UNKNOWN仍预留失败终态，原不可变回执完整保留', { timeout: 60_000 }, () => {
  const state = nearPhysicalHistory();
  const unknown = state.receipts.findLast(row => row.operation === 'createResource')!;
  unknown.state = 'UNKNOWN'; unknown.reply = null; unknown.resourceContext = null;
  const encoded = roundtrip(state);
  assert.equal(encoded.format, 'v5');
  const candidate = structuredClone(state), row = candidate.receipts.find(receipt => receipt.id === unknown.id)!;
  row.state = 'RECORDED'; row.reply = { status: 409, body: { error: { code: 'IDEMPOTENCY_CONFLICT',
    message: '服务暂时无法完成请求，请查询原记录。', requestId: '40000000-0000-4000-8000-000000000001',
    retryable: false, retryAfterMs: Number.MAX_SAFE_INTEGER } } };
  const resource = candidate.resources.find(value => value.id === row.resourceId)!;
  resource.state = 'failed'; resource.failure = 'IDEMPOTENCY_CONFLICT'; resource.media = null;
  candidate.revision = Number.MAX_SAFE_INTEGER; candidate.clockFloor = 8_640_000_000_000_000;
  candidate.commitId = '50000000-0000-4000-8000-000000000001';
  roundtrip(candidate);
  assert.deepEqual(candidate.receipts.filter(value => value.id !== unknown.id), state.receipts.filter(value => value.id !== unknown.id));
});


// 独立构造旧v4：全部长串共享，确保新reader仍能读取先前真实格式，不借新encoder生成旧样本。
function oldV4(state: ReturnType<typeof capacityHistory>) {
  const shapes: string[][] = [], shapeIds = new Map<string, number>();
  function shape(value: unknown): unknown {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return [0, ...value.map(shape)];
    const object = value as Record<string, unknown>, keys = Object.keys(object).sort(), signature = JSON.stringify(keys);
    let id = shapeIds.get(signature);
    if (id === undefined) { id = shapes.length; shapeIds.set(signature, id); shapes.push(keys); }
    return [id + 1, ...keys.map(key => shape(object[key]))];
  }
  const root = shape({ ...state, schema: 'mbm002.playback-compact-state.v2', requestTemplates: [], contextTemplates: [] });
  const strings: string[] = [], ids = new Map<string, number>();
  function intern(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(intern);
    if (typeof value !== 'string' || !value.startsWith('~') && Buffer.byteLength(JSON.stringify(value)) < 16) return value;
    let id = ids.get(value);
    if (id === undefined) { id = strings.length; ids.set(value, id); strings.push(value); }
    return '~' + id.toString(36).padStart(4, '0');
  }
  return { schema: 'mbm002.playback-compact-state.v4', shapes, strings, root: intern(root) as unknown[] };
}
const wireBytes = (value: unknown) => new Uint8Array(Buffer.from(JSON.stringify(value)));

test('选择性字符串：旧v4与合法长literal兼容，~转义和UTF8引号反斜线原样还原', () => {
  const state = capacityHistory({ sessions: 1, resources: 1, receipts: 3 });
  const reason = '汉字与"引号"和反斜线\\以及合法长文字';
  for (const resource of state.resources) resource.source!.processing.reason = reason;
  for (const receipt of state.receipts) if (receipt.reply && receipt.reply.status < 400 && receipt.operation !== 'createSession')
    (receipt.reply.body as { processing: { reason: string } }).processing.reason = reason;
  const old = oldV4(state);
  assert.deepEqual(decodePlaybackStorage(wireBytes(old), SERVER, DATASET, ORIGIN, limits).state, state);
  const position = old.shapes[(old.root[0] as number) - 1]!.indexOf('commitId') + 1;
  const marker = old.root[position] as string, index = Number.parseInt(marker.slice(1), 36);
  old.root[position] = state.commitId;
  // 移除被literal替代的唯一旧表项，并严格重编其余引用；未用字典仍不被允许。
  old.strings.splice(index, 1);
  function renumber(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(renumber);
    if (typeof value === 'string' && /^~[0-9a-z]{4}$/u.test(value)) {
      const previous = Number.parseInt(value.slice(1), 36);
      return '~' + (previous > index ? previous - 1 : previous).toString(36).padStart(4, '0');
    }
    return value;
  }
  old.root = renumber(old.root) as unknown[];
  assert.throws(() => decodePlaybackStorage(wireBytes(old), SERVER, DATASET, ORIGIN, limits), '旧v4语法仍拒长literal');
  old.schema = 'mbm002.playback-compact-state.v5';
  assert.deepEqual(decodePlaybackStorage(wireBytes(old), SERVER, DATASET, ORIGIN, limits).state, state);
  const escaped = capacityHistory({ sessions: 1, resources: 1, receipts: 3 });
  for (const resource of escaped.resources) resource.source!.processing.reason = '~0000';
  for (const receipt of escaped.receipts) if (receipt.reply && receipt.reply.status < 400 && receipt.operation !== 'createSession')
    (receipt.reply.body as { processing: { reason: string } }).processing.reason = '~0000';
  const escapedWire = oldV4(escaped);
  assert.ok(escapedWire.strings.includes('~0000'));
  assert.deepEqual(decodePlaybackStorage(wireBytes(escapedWire), SERVER, DATASET, ORIGIN, limits).state, escaped);
  for (const invalid of ['~zzzz', '~000', '~00000', '~ABCD', '~wat?', '~']) {
    const mutated = structuredClone(escapedWire); mutated.root[position] = invalid;
    assert.throws(() => decodePlaybackStorage(wireBytes(mutated), SERVER, DATASET, ORIGIN, limits));
  }
  for (const mutation of ['duplicate', 'unused', 'short', 'extra'] as const) {
    const mutated = structuredClone(escapedWire);
    if (mutation === 'duplicate') mutated.strings.push(mutated.strings[0]!);
    if (mutation === 'unused') mutated.strings.push('unused.synthetic.dictionary.entry');
    if (mutation === 'short') mutated.strings[0] = 'short';
    if (mutation === 'extra') Object.assign(mutated, { extra: null });
    assert.throws(() => decodePlaybackStorage(wireBytes(mutated), SERVER, DATASET, ORIGIN, limits));
  }
});

test('选择性字符串：旧v4数千索引、逐引用逻辑膨胀和物理预算仍按原规则校验', { timeout: 60_000 }, () => {
  // 直接复制旧production encoder生成的v3，再按旧规则完整intern，避免无模板版本超物理节点。
  const state = capacityHistory(), encoded = roundtrip(state);
  assert.equal(encoded.format, 'v3');
  const packed = JSON.parse(encoded.canonical) as { schema: string; shapes: string[][]; root: unknown; strings?: string[] };
  const strings: string[] = [], ids = new Map<string, number>();
  function walk(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(walk);
    if (typeof value !== 'string' || !value.startsWith('~') && Buffer.byteLength(JSON.stringify(value)) < 16) return value;
    let id = ids.get(value); if (id === undefined) { id = strings.length; ids.set(value, id); strings.push(value); }
    return '~' + id.toString(36).padStart(4, '0');
  }
  packed.root = walk(packed.root); packed.schema = 'mbm002.playback-compact-state.v4'; packed.strings = strings;
  assert.ok(strings.length > 36 * 36);
  assert.deepEqual(decodePlaybackStorage(wireBytes(packed), SERVER, DATASET, ORIGIN, limits).state, state);
  assert.throws(() => decodePlaybackStorage(wireBytes({ schema: packed.schema, shapes: [], strings: ['x'.repeat(8192)],
    root: [0, ...Array(6000).fill('~0000')] }), SERVER, DATASET, ORIGIN, limits));
  assert.throws(() => decodePlaybackStorage(new Uint8Array(limits.stateBytes + 1), SERVER, DATASET, ORIGIN, limits));
});

test('选择性字符串：临界2UNKNOWN的全部子集经真实seal持久化与冷decode，不丢任何原回执', { timeout: 120_000 }, () => {
  const state = nearPhysicalHistory(), pending = state.receipts.filter(receipt => receipt.operation === 'createResource').slice(-2);
  for (const row of pending) { row.state = 'UNKNOWN'; row.reply = null; row.resourceContext = null; }
  const initial = roundtrip(state); assert.equal(initial.format, 'v5');
  const key = randomBytes(32), crypto = createMobileAuthCrypto(key); key.fill(0);
  let writes = 0;
  for (let mask = 0; mask < 4; mask++) {
    const candidate = structuredClone(state); candidate.revision = Number.MAX_SAFE_INTEGER;
    candidate.clockFloor = 8_640_000_000_000_000; candidate.commitId = '50000000-0000-4000-8000-000000000001';
    for (let i = 0; i < 2; i++) if (mask & (1 << i)) {
      const row = candidate.receipts.find(receipt => receipt.id === pending[i]!.id)!;
      row.state = 'RECORDED'; row.reply = { status: 409, body: { error: { code: 'IDEMPOTENCY_CONFLICT',
        message: '服务暂时无法完成请求，请查询原记录。', requestId: `40000000-0000-4000-8000-${(mask * 2 + i).toString().padStart(12, '0')}`,
        retryable: false, ...(i % 2 ? { retryAfterMs: Number.MAX_SAFE_INTEGER } : {}) } } };
      const resource = candidate.resources.find(value => value.id === row.resourceId)!;
      resource.state = 'failed'; resource.failure = 'IDEMPOTENCY_CONFLICT'; resource.media = null;
    }
    const encoded = roundtrip(candidate), aad = Buffer.from(JSON.stringify(['MBM002_PLAYBACK_STATE_V1', SERVER, DATASET, candidate.revision]));
    const sealed = crypto.seal(encoded.bytes, aad), stored = new Uint8Array(sealed); writes++;
    const plain = crypto.open(stored, aad);
    try { assert.deepEqual(decodePlaybackStorage(plain, SERVER, DATASET, ORIGIN, limits).state, candidate); }
    finally { plain.fill(0); sealed.fill(0); stored.fill(0); }
    assert.deepEqual(candidate.receipts.filter(row => !pending.some(value => value.id === row.id)),
      state.receipts.filter(row => !pending.some(value => value.id === row.id)));
  }
  assert.equal(writes, 4);
});

test('选择性字符串：临界历史经真实服务新增及冷重开原键重放，撤销仍拒且不重prepare', { timeout: 60_000 }, async t => {
  const state = nearPhysicalHistory(), encoded = roundtrip(state), key = randomBytes(32), crypto = createMobileAuthCrypto(key); key.fill(0);
  const aad = (revision: number) => Buffer.from(JSON.stringify(['MBM002_PLAYBACK_STATE_V1', SERVER, DATASET, revision]));
  let stored: MobileSealedState = { kind: 'sealed', datasetId: DATASET, revision: state.revision, commitId: state.commitId!, sealed: crypto.seal(encoded.bytes, aad(state.revision)) };
  let writes = 0, prepares = 0, revoked = false;
  const source: MobilePlaybackSourcePort = { async prepare() { prepares++; throw new Error('不应再次准备旧来源'); }, async verify() {}, async renew() {},
    async read() { throw new Error('不读取媒体'); }, async closeRead() {}, async release() {} };
  const persistence: MobileAuthPersistence = { async load() { return structuredClone(stored); }, async save(request) {
    assert.equal(request.expectedRevision, stored.revision); writes++;
    stored = { kind: 'sealed', datasetId: DATASET, revision: stored.revision + 1, commitId: request.commitId, sealed: new Uint8Array(request.sealed) };
    return { kind: 'saved', datasetId: DATASET, revision: stored.revision, commitId: stored.commitId };
  } };
  const create = () => createMobilePlaybackService({ serverId: SERVER, datasetId: DATASET, responseOrigin: ORIGIN, crypto, persistence, sourcePort: source,
    nowMs: () => NOW, auth: { async assertDeviceCurrent() { if (revoked) throw new MobilePlaybackError(401, 'DEVICE_REVOKED'); } } });
  const actor = create(); t.after(() => actor.close());
  const request = { path: '/mobile/v1/sessions', pathParameters: {}, query: {}, body: { clientInstanceId: 'selective.new.client' }, idempotencyKey: 'selective.new.original-key' };
  const principal = capacityPrincipal('selective.synthetic.new');
  const first = await actor.control('createSession', request, principal, new AbortController().signal); assert.equal(first.status, 201); await first.beforeSend();
  await actor.close(); const cold = create(); t.after(() => cold.close());
  const replay = await cold.control('createSession', request, principal, new AbortController().signal);
  assert.equal(replay.status, first.status); assert.deepEqual(replay.body, first.body);
  for (const row of state.receipts) {
    const reply = await cold.control(row.operation, row.request, capacityPrincipal(), new AbortController().signal);
    assert.equal(reply.status, row.reply!.status); assert.deepEqual(reply.body, row.reply!.body);
  }
  assert.equal(writes, 1); assert.equal(prepares, 0); revoked = true;
  await assert.rejects(replay.beforeSend(), error => error instanceof MobilePlaybackError && error.code === 'DEVICE_REVOKED');
});

test('选择性字符串：未来错误与既有唯一串碰撞的16子集在最紧预留后均完整落盘', { timeout: 60_000 }, () => {
  const state = capacityHistory({ sessions: 1, resources: 4, receipts: 4, formats: 20, errors: true });
  const message = '服务暂时无法完成请求，请查询原记录。';
  state.resources[0]!.source!.processing.reason = 'IDEMPOTENCY_CONFLICT';
  state.resources[1]!.source!.processing.reason = message;
  state.receipts[0]!.id = '40000000-0000-4000-8000-000000000001';
  state.receipts[1]!.id = '50000000-0000-4000-8000-000000000001';
  for (const row of state.receipts) { row.state = 'UNKNOWN'; row.reply = null; row.resourceContext = null; }
  let low = 1, high = limits.stateBytes;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    try { encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, { ...limits, stateBytes: middle }); high = middle; }
    catch (error) { assert.ok(error instanceof MobilePlaybackError && error.code === 'RESOURCE_BUSY'); low = middle + 1; }
  }
  const tight = { ...limits, stateBytes: low };
  assert.equal(roundtrip(state, tight).format, 'v5');
  assert.throws(() => encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, { ...tight, stateBytes: low - 1 }),
    error => error instanceof MobilePlaybackError && error.code === 'RESOURCE_BUSY');
  const key = randomBytes(32), crypto = createMobileAuthCrypto(key); key.fill(0);
  for (let mask = 0; mask < 16; mask++) {
    const candidate = structuredClone(state); candidate.revision = Number.MAX_SAFE_INTEGER;
    candidate.clockFloor = 8_640_000_000_000_000; candidate.commitId = state.receipts[1]!.id;
    for (let i = 0; i < 4; i++) if (mask & (1 << i)) {
      const row = candidate.receipts[i]!; row.state = 'RECORDED';
      row.reply = { status: 409, body: { error: { code: 'IDEMPOTENCY_CONFLICT', message,
        requestId: state.receipts[0]!.id, retryable: false, retryAfterMs: Number.MAX_SAFE_INTEGER } } };
      const resource = candidate.resources.find(value => value.id === row.resourceId)!;
      resource.state = 'failed'; resource.failure = 'IDEMPOTENCY_CONFLICT'; resource.media = null;
    }
    const encoded = roundtrip(candidate, tight), aad = Buffer.from(JSON.stringify([SERVER, DATASET, candidate.revision]));
    const stored = new Uint8Array(crypto.seal(encoded.bytes, aad)), plain = crypto.open(stored, aad);
    try { assert.deepEqual(decodePlaybackStorage(plain, SERVER, DATASET, ORIGIN, tight).state, candidate); }
    finally { plain.fill(0); stored.fill(0); }
  }
});
