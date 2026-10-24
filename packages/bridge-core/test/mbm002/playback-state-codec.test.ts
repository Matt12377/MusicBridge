import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { MOBILE_CODEC_LIMITS, mobileCanonicalJson, mobileDataSnapshot, type MobileJsonValue, type MobileDecodedRequest, type MobileSession, type MobileReadyResource } from '@music-bridge/contracts';
import { createMobilePlaybackService } from '../../src/mobile/playback-service.js';
import { createMobileAuthCrypto } from '../../src/mobile/auth-crypto.js';
import { capturePlaybackState, decodePlaybackState, playbackCanonical, playbackCopy, type PlaybackState, type StoredPlaybackReceipt } from '../../src/mobile/playback-state.js';
import { encodePlaybackStorage, decodePlaybackStorage, readPlaybackStorageRejectionBoundary, PLAYBACK_COMPACT_SCHEMA, PLAYBACK_SHARED_BYTES_PER_RECEIPT } from '../../src/mobile/playback-state-codec.js';
import { MOBILE_PLAYBACK_DEFAULT_LIMITS, type MobilePlaybackSourcePort, type MobilePlaybackService } from '../../src/mobile/playback-types.js';
import { MOBILE_PLAYBACK_TERMINAL_FAILURE_BUDGET } from '../../src/mobile/playback-types.js';
import type { MobileAuthPersistence, MobileSealedState, MobilePrincipal, MobileAuthCrypto } from '../../src/mobile/types.js';
import { MobileAuthPersistenceError } from '../../src/mobile/types.js';

// 合法关联模板的构造沿已经独立通过的near-budget复现；不import旧测试或脚本定义。
const SERVER = 'budget.synthetic.server', DATASET = '30000000-0000-4000-8000-000000000001';
const ORIGIN = 'https://127.0.0.1:9443', NOW = Date.parse('2026-10-16T00:00:00.000Z');
const limits = MOBILE_PLAYBACK_DEFAULT_LIMITS;
const codec = { ...MOBILE_CODEC_LIMITS, responseBytes: 2 * 1024 * 1024, nodes: 200_000, depth: 24 };
const scopePrincipal = (device: string): MobilePrincipal => Object.freeze({ serverId: SERVER, datasetId: DATASET,
  accountDomain: `local:${DATASET}`, deviceId: device, deviceEpoch: 1, generation: 1,
  accessTokenHash: 'a'.repeat(64), accessExpiresAt: '2030-01-01T00:00:00.000Z' });
const historyPrincipal = scopePrincipal('device.synthetic.history'), newPrincipal = scopePrincipal('device.synthetic.new');
const creationRequest: MobileDecodedRequest<unknown> = { path: '/mobile/v1/sessions', pathParameters: {}, query: {},
  body: { clientInstanceId: 'client.synthetic.new' }, idempotencyKey: 'new-session.synthetic.original-key' };
const signal = () => new AbortController().signal;
const canonicalBytes = (value: unknown) => Buffer.byteLength(mobileCanonicalJson(value as MobileJsonValue));
const nodeCount = (value: unknown): number => value === null || typeof value !== 'object' ? 1
  : 1 + (Array.isArray(value) ? value : Object.values(value)).reduce<number>((n, v) => n + nodeCount(v), 0);
const digest = (domain: string, value: unknown) => createHash('sha256')
  .update(playbackCanonical(['MBM002_PLAYBACK_V1', SERVER, DATASET, domain, value])).digest('hex');
const aad = (revision: number) => Buffer.from(JSON.stringify(['MBM002_PLAYBACK_STATE_V1', SERVER, DATASET, revision]));
function safeError(error: unknown) {
  const own = (key: string) => error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, key)?.value : undefined;
  const code = own('code'), status = own('status');
  return { code: typeof code === 'string' && ['BUSY', 'RESOURCE_BUSY', 'REVISION_CONFLICT', 'ERR_ASSERTION', 'IDEMPOTENCY_CONFLICT'].includes(code) ? code : 'UNKNOWN',
    status: typeof status === 'number' && [201, 400, 401, 403, 409, 410, 429, 503].includes(status) ? status : null };
}
function metrics(state: PlaybackState) {
  const checked = mobileDataSnapshot(state, codec);
  return { bytes: canonicalBytes(state), nodes: nodeCount(state), sessions: state.sessions.length,
    resources: state.resources.length, receipts: state.receipts.length,
    codec: checked.ok ? { ok: true, code: null, field: null } : { ok: false, code: checked.issue.code, field: checked.issue.field } };
}
function sourcePort(allowPreparation: boolean): MobilePlaybackSourcePort {
  return {
    async prepare(selection) {
      assert.ok(allowPreparation);
      const audio = { codec: 'pcm_s16le', container: 'wav', sampleRateHz: 44_100, bitsPerSample: 16, channels: 2 };
      return { handle: `handle.${selection.resourceId}`, sourceAudio: audio, actualAudio: { ...audio },
        processing: { mode: 'direct', reason: '合成原字节', fromPreparedCache: false },
        contentType: 'audio/wav', size: 200_017, durationMs: 4_000, seekable: true };
    },
    async verify() { assert.ok(allowPreparation); }, async renew() { assert.ok(allowPreparation); },
    async read() { throw new Error('合成复现不读取媒体'); }, async closeRead() {}, async release() {},
  };
}
const auth = { async assertDeviceCurrent(device: string, epoch: number) {
  assert.ok([historyPrincipal.deviceId, newPrincipal.deviceId].includes(device)); assert.equal(epoch, 1);
} };
function memoryStore(crypto: MobileAuthCrypto, initial?: PlaybackState) {
  let value: MobileSealedState = initial ? { kind: 'sealed', datasetId: DATASET, revision: initial.revision,
    commitId: initial.commitId!, sealed: crypto.seal(new Uint8Array(Buffer.from(playbackCanonical(initial))), aad(initial.revision)) }
    : { kind: 'missing', datasetId: DATASET, revision: 0 };
  let loads = 0, saves = 0;
  const port: MobileAuthPersistence = {
    async load(dataset) { assert.equal(dataset, DATASET); loads++; return structuredClone(value); },
    async save(request) {
      saves++; assert.equal(request.datasetId, DATASET); assert.equal(request.expectedRevision, value.revision);
      value = { kind: 'sealed', datasetId: DATASET, revision: request.expectedRevision + 1,
        commitId: request.commitId, sealed: new Uint8Array(request.sealed) };
      return { kind: 'saved', datasetId: DATASET, revision: value.revision, commitId: value.commitId };
    },
  };
  return { port, get: () => value, counts: () => ({ loads, saves }) };
}
async function seedHistory(crypto: MobileAuthCrypto): Promise<PlaybackState> {
  const store = memoryStore(crypto), service = createMobilePlaybackService({ serverId: SERVER, datasetId: DATASET,
    responseOrigin: ORIGIN, auth, persistence: store.port, crypto, sourcePort: sourcePort(true), nowMs: () => NOW });
  try {
    const created = await service.control('createSession', { ...creationRequest,
      body: { clientInstanceId: 'client.synthetic.history' }, idempotencyKey: 'history.session' }, historyPrincipal, signal());
    assert.equal(created.status, 201); const session = created.body as MobileSession;
    const request = { trackId: 'track.' + 't'.repeat(140), versionId: 'version.' + 'v'.repeat(140), contentRevision: 'revision.' + 'r'.repeat(140),
      quality: { profile: 'lossless', allowLossyFallback: false, preferredTransport: 'file' },
      formats: [{ codec: 'pcm_s16le', container: 'wav', maxSampleRateHz: 48_000, maxChannels: 2, maxBitsPerSample: 16 }] };
    const prepared = await service.control('createResource', { path: `/mobile/v1/sessions/${session.id}/resources`, pathParameters: { sessionId: session.id },
      query: {}, body: request, idempotencyKey: 'history.resource' }, historyPrincipal, signal());
    assert.equal(prepared.status, 201); const resource = prepared.body as MobileReadyResource;
    await service.control('renewResource', { path: `/mobile/v1/sessions/${session.id}/resources/${resource.id}/renew`,
      pathParameters: { sessionId: session.id, resourceId: resource.id }, query: {}, body: {}, idempotencyKey: 'history.renew.seed' }, historyPrincipal, signal());
    const sealed = store.get(); assert.equal(sealed.kind, 'sealed'); if (sealed.kind !== 'sealed') throw new Error();
    const plain = crypto.open(sealed.sealed, aad(sealed.revision));
    try {
      const state = decodePlaybackStorage(plain, SERVER, DATASET, ORIGIN, limits).state;
      // 保留合法的原资源与不可变renew回执关联，模拟自然结束后继续保留的历史。
      for (const s of state.sessions) s.terminal = 'SESSION_CLOSED';
      for (const r of state.resources) { r.state = 'terminal'; r.failure = 'SERVICE_RESTARTED'; r.media = null; }
      return capturePlaybackState(state, SERVER, DATASET, ORIGIN, limits);
    } finally { plain.fill(0); }
  } finally { await service.close(); }
}
function historyAt(base: PlaybackState, target: number): PlaybackState {
  const state = playbackCopy(base), template = state.receipts.find(r => r.operation === 'renewResource'); assert.ok(template);
  let bytes = canonicalBytes(state), serial = 0;
  const added: StoredPlaybackReceipt[] = [];
  while (state.receipts.length < limits.maxReceipts - 1) {
    const receipt = playbackCopy(template);
    receipt.id = `history.synthetic.receipt.${serial}`;
    receipt.request.idempotencyKey = `history.synthetic.renew.${serial}`;
    receipt.keyHash = digest('key', [receipt.deviceId, receipt.deviceEpoch, receipt.request.idempotencyKey]);
    const delta = canonicalBytes(receipt) + 1 + String(state.revision + 1).length - String(state.revision).length;
    if (bytes + delta > target) break;
    state.receipts.push(receipt); state.revision++; added.push(receipt); bytes += delta; serial++;
  }
  let gap = target - bytes;
  for (const receipt of added) {
    if (gap === 0) break;
    const key = receipt.request.idempotencyKey!, extra = Math.min(gap, 128 - key.length);
    receipt.request.idempotencyKey = key + 'x'.repeat(extra);
    receipt.keyHash = digest('key', [receipt.deviceId, receipt.deviceEpoch, receipt.request.idempotencyKey]); gap -= extra;
  }
  assert.equal(gap, 0); assert.equal(canonicalBytes(state), target);
  const captured = capturePlaybackState(state, SERVER, DATASET, ORIGIN, limits);
  const encoded = new Uint8Array(Buffer.from(playbackCanonical(captured)));
  const decoded = decodePlaybackState(encoded, SERVER, DATASET, ORIGIN, limits); encoded.fill(0);
  assert.ok(metrics(decoded).codec.ok); assert.ok(nodeCount(decoded) <= 200_000);
  return decoded;
}

async function fixture(t: TestContext, target = 256 * 1024) {
  const key = randomBytes(32), crypto = createMobileAuthCrypto(key); key.fill(0);
  const state = historyAt(await seedHistory(crypto), target), store = memoryStore(crypto, state), actors: MobilePlaybackService[] = [];
  const create = () => {
    const actor = createMobilePlaybackService({ serverId: SERVER, datasetId: DATASET, responseOrigin: ORIGIN,
      auth, persistence: store.port, crypto, sourcePort: sourcePort(false), nowMs: () => NOW }); actors.push(actor); return actor;
  };
  t.after(async () => { for (const actor of actors) await actor.close(); });
  const persisted = () => {
    const row = store.get(); assert.ok(row.kind === 'sealed');
    const plain = crypto.open(row.sealed, aad(row.revision));
    try { return decodePlaybackStorage(plain, SERVER, DATASET, ORIGIN, limits); } finally { plain.fill(0); }
  };
  return { state, crypto, store, create, persisted };
}
const call = (actor: MobilePlaybackService, request = creationRequest, p = newPrincipal) => actor.control('createSession', request, p, signal());
const expectBusy = (work: () => unknown) => assert.throws(work, error => safeError(error).code === 'BUSY');
const text = (v: unknown) => new Uint8Array(Buffer.from(jsonForTest(v)));
function jsonForTest(v: unknown): string { return mobileCanonicalJson(v as MobileJsonValue); }

test('紧凑播放账本：近界v1保全历史迁移后原创建成功，冷启原成功与终态逐字段重放', async t => {
  const f = await fixture(t, limits.stateBytes - 128), actor = f.create();
  assert.equal(f.persisted().format, 'v1'); assert.equal(f.store.counts().saves, 0);
  const first = await call(actor); assert.equal(first.status, 201); assert.equal(f.store.counts().saves, 1);
  const after = f.persisted(); assert.equal(after.format, 'v2');
  assert.ok(canonicalBytes(after.state) > limits.stateBytes);
  assert.ok(encodePlaybackStorage(after.state, SERVER, DATASET, ORIGIN, limits).bytes.length <= limits.stateBytes);
  assert.deepEqual(after.state.sessions.slice(0, f.state.sessions.length), f.state.sessions);
  assert.deepEqual(after.state.resources, f.state.resources);
  assert.deepEqual(after.state.receipts.slice(0, f.state.receipts.length), f.state.receipts);
  assert.deepEqual(after.state.resources[0]!.tickets, f.state.resources[0]!.tickets);
  await actor.close(); const cold = f.create(), replay = await call(cold);
  assert.equal(replay.status, first.status); assert.deepEqual(replay.body, first.body); assert.equal(f.store.counts().saves, 1);
  for (const operation of ['createSession', 'createResource', 'renewResource'] as const) {
    const receipt = f.state.receipts.find(r => r.operation === operation)!;
    const reply = await cold.control(operation, receipt.request, historyPrincipal, signal());
    assert.equal(reply.status, receipt.reply!.status); assert.deepEqual(reply.body, receipt.reply!.body);
  }
  await assert.rejects(cold.control('getSession', { path: `/mobile/v1/sessions/${f.state.sessions[0]!.id}`,
    pathParameters: { sessionId: f.state.sessions[0]!.id }, query: {}, body: null }, historyPrincipal, signal()), error => safeError(error).status === 410);
  assert.equal(f.store.counts().saves, 1);
});

test('紧凑播放账本：UNKNOWN与同commit持久化结果保留，冲突及冷启不补发', async t => {
  const original = await fixture(t), unknown = playbackCopy(original.state), receipt = unknown.receipts.at(-1)!;
  receipt.state = 'UNKNOWN'; receipt.reply = null; receipt.resourceContext = null;
  const encodedUnknown = encodePlaybackStorage(unknown, SERVER, DATASET, ORIGIN, limits);
  assert.equal(encodedUnknown.format, 'v2');
  const restoredUnknown = decodePlaybackStorage(encodedUnknown.bytes, SERVER, DATASET, ORIGIN, limits).state;
  assert.deepEqual(restoredUnknown, capturePlaybackState(unknown, SERVER, DATASET, ORIGIN, limits));
  const unknownStore = memoryStore(original.crypto, restoredUnknown), unknownRow = unknownStore.get(); assert.ok(unknownRow.kind === 'sealed');
  unknownRow.sealed = original.crypto.seal(encodedUnknown.bytes, aad(unknownRow.revision));
  const actualUnknownPlain = original.crypto.open(unknownRow.sealed, aad(unknownRow.revision));
  try { assert.equal(decodePlaybackStorage(actualUnknownPlain, SERVER, DATASET, ORIGIN, limits).format, 'v2'); }
  finally { actualUnknownPlain.fill(0); }
  const unknownActor = createMobilePlaybackService({
    serverId: SERVER, datasetId: DATASET, responseOrigin: ORIGIN, auth, persistence: unknownStore.port, crypto: original.crypto,
    sourcePort: sourcePort(false), nowMs: () => NOW }); t.after(() => unknownActor.close());
  await assert.rejects(unknownActor.control(receipt.operation, receipt.request, historyPrincipal, signal()), error => safeError(error).code === 'RESOURCE_BUSY');
  assert.equal(unknownStore.counts().saves, 0); assert.equal(unknownStore.counts().loads, 1);

  for (const mode of ['not-sent', 'unknown-committed', 'unknown-missing', 'conflict', 'unknown-altered'] as const) {
    const f = await fixture(t), save = f.store.port.save, before = structuredClone(f.store.get()); let attempts = 0;
    f.store.port.save = async request => {
      attempts++;
      if (mode === 'not-sent') throw new MobileAuthPersistenceError('not-sent');
      if (mode === 'unknown-missing') throw new MobileAuthPersistenceError('unknown');
      if (mode === 'conflict') return { kind: 'conflict', datasetId: DATASET, currentRevision: request.expectedRevision + 1 };
      await save(request); throw new MobileAuthPersistenceError('unknown');
    };
    const actor = f.create();
    await assert.rejects(call(actor), error => safeError(error).code === (mode === 'conflict' ? 'REVISION_CONFLICT' : 'BUSY'));
    assert.equal(attempts, 1);
    assert.equal(actor.resourceSnapshot().pendingPersistence, mode.startsWith('unknown'));
    if (mode === 'not-sent' || mode === 'unknown-missing' || mode === 'conflict') assert.deepEqual(f.store.get(), before);
    if (mode === 'unknown-altered') {
      const row = f.store.get(); assert.ok(row.kind === 'sealed');
      const state = f.persisted().state; state.clockFloor++;
      const changed = encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, limits);
      row.sealed = f.crypto.seal(changed.bytes, aad(row.revision));
    }
    if (mode === 'unknown-committed') {
      const expected = f.persisted().state.receipts.at(-1)!.reply!;
      const replay = await call(actor); assert.equal(replay.status, expected.status); assert.deepEqual(replay.body, expected.body);
      assert.equal(actor.resourceSnapshot().pendingPersistence, false);
    } else if (mode === 'unknown-missing' || mode === 'unknown-altered') {
      await assert.rejects(call(actor), error => safeError(error).code === 'BUSY');
      assert.equal(actor.resourceSnapshot().pendingPersistence, true);
    }
    assert.equal(attempts, 1);
  }
});

test('紧凑播放账本：坏版本引用与逻辑膨胀先拒绝，原字段及总预算上限不放宽', async t => {
  const f = await fixture(t), encoded = encodePlaybackStorage(f.state, SERVER, DATASET, ORIGIN, limits);
  assert.equal(encoded.format, 'v2');
  const original = JSON.parse(encoded.canonical) as Record<string, any>;
  const reject = (change: (v: Record<string, any>) => void) => { const v = playbackCopy(original); change(v); expectBusy(() => decodePlaybackStorage(text(v), SERVER, DATASET, ORIGIN, limits)); };
  reject(v => { v.schema = 'mbm002.playback-compact-state.v3'; });
  reject(v => { v.extra = '拒收'; });
  reject(v => { v.serverId = 'another.server'; });
  reject(v => { const r = v.receipts.find((r: any) => r.request.template !== undefined); r.request.template = -1; });
  reject(v => { const r = v.receipts.find((r: any) => r.request.template !== undefined); r.request.template = 0.5; });
  reject(v => { const r = v.receipts.find((r: any) => r.request.template !== undefined); r.request.extra = true; });
  reject(v => { [v.requestTemplates, v.contextTemplates] = [v.contextTemplates, v.requestTemplates]; });
  reject(v => { v.contextTemplates.push(playbackCopy(v.contextTemplates[0])); });
  reject(v => { v.receipts[0].keyHash = '0'.repeat(64); });
  reject(v => { v.contextTemplates[0].scope.serverId = 'another.server'; });
  reject(v => { v.contextTemplates[0].resourceDsdToPcm = true; });
  {
    // 格式/关联/摘要均有效，仅由共享引用的累计逻辑节点跨越默认预算。
    const baseline = playbackCopy(f.state), resource = baseline.resources[0]!;
    resource.request.formats = Array.from({ length: 20 }, () => playbackCopy(resource.request.formats[0]!));
    for (const receipt of baseline.receipts) if (receipt.resourceId === resource.id) {
      if (receipt.resourceContext) receipt.resourceContext.request = playbackCopy(resource.request);
      if (receipt.operation === 'createResource') {
        receipt.request.body = playbackCopy(resource.request);
        receipt.fingerprint = digest('request', [receipt.scopeHash, receipt.request.body]);
      }
    }
    capturePlaybackState(baseline, SERVER, DATASET, ORIGIN, limits);
    // 保留旧200k边界夹具：迁移后新增一条回执仍能读写；真正新逻辑边界另有放大回归。
    const template = playbackCopy(baseline.receipts.find(r => r.operation === 'createResource')!);
    function unknownReceipt(index: number): StoredPlaybackReceipt {
      const row = playbackCopy(template); row.id = `nodes.synthetic.receipt.${index}`;
      row.request.idempotencyKey = `nodes.synthetic.original-key.${index}`;
      row.keyHash = digest('key', [row.deviceId, row.deviceEpoch, row.request.idempotencyKey]); return row;
    }
    const increment = nodeCount(unknownReceipt(0)), count = Math.floor((200_000 - nodeCount(baseline)) / increment);
    assert.ok(count > 1 && count + baseline.receipts.length + 1 <= limits.maxReceipts);
    const inside = playbackCopy(baseline);
    for (let i = 0; i < count; i++) inside.receipts.push(unknownReceipt(i));
    inside.revision += count;
    const validInside = capturePlaybackState(inside, SERVER, DATASET, ORIGIN, limits);
    assert.ok(nodeCount(validInside) <= 200_000);
    const packedInside = encodePlaybackStorage(validInside, SERVER, DATASET, ORIGIN, limits); assert.equal(packedInside.format, 'v2');
    const restored = decodePlaybackStorage(packedInside.bytes, SERVER, DATASET, ORIGIN, limits).state;
    assert.equal(jsonForTest(restored), jsonForTest(validInside));
    const outside = playbackCopy(inside), next = unknownReceipt(count); outside.receipts.push(next); outside.revision++;
    capturePlaybackState(outside, SERVER, DATASET, ORIGIN, limits); assert.ok(nodeCount(outside) > 200_000);
    const fanout = JSON.parse(packedInside.canonical) as Record<string, any>;
    const last = playbackCopy(fanout.receipts.at(-1)); assert.ok(Number.isInteger(last.request.template));
    last.id = next.id; last.request.idempotencyKey = next.request.idempotencyKey; last.keyHash = next.keyHash; fanout.receipts.push(last); fanout.revision++;
    assert.ok(text(fanout).byteLength <= limits.stateBytes); assert.ok(nodeCount(fanout) <= 200_000);
    assert.ok(mobileDataSnapshot(fanout, codec).ok);
    for (const row of fanout.receipts) {
      const shared = (row.request.template === undefined ? 0 : canonicalBytes(fanout.requestTemplates[row.request.template]))
        + (row.resourceContext?.template === undefined ? 0 : canonicalBytes(fanout.contextTemplates[row.resourceContext.template]));
      assert.ok(shared <= PLAYBACK_SHARED_BYTES_PER_RECEIPT);
    }
    assert.equal(jsonForTest(decodePlaybackStorage(text(fanout), SERVER, DATASET, ORIGIN, limits).state), jsonForTest(outside));
    const beyondOld = encodePlaybackStorage(outside, SERVER, DATASET, ORIGIN, limits);
    assert.equal(jsonForTest(decodePlaybackStorage(beyondOld.bytes, SERVER, DATASET, ORIGIN, limits).state), jsonForTest(outside));
  }
  reject(v => { let body: any = null; for (let i = 0; i < 21; i++) body = { n: body }; v.requestTemplates[0].body = body; });
  for (const [key, maximum] of [['sessions', limits.maxStoredSessions], ['resources', limits.maxStoredResources], ['receipts', limits.maxReceipts]] as const)
    reject(v => { v[key] = Array.from({ length: maximum + 1 }, () => null); });
  expectBusy(() => decodePlaybackStorage(new Uint8Array(limits.stateBytes + 1), SERVER, DATASET, ORIGIN, limits));
  const duplicate = encoded.canonical.replace('"schema":', `"schema":"${PLAYBACK_COMPACT_SCHEMA}","schema":`);
  expectBusy(() => decodePlaybackStorage(new Uint8Array(Buffer.from(duplicate)), SERVER, DATASET, ORIGIN, limits));
  expectBusy(() => decodePlaybackStorage(encoded.bytes, SERVER, DATASET, ORIGIN, { ...limits, stateBytes: limits.stateBytes * 2 }));
  let getters = 0;
  const getter = Object.defineProperty(playbackCopy(f.state), 'receipts', { enumerable: true, get() { getters++; return []; } });
  expectBusy(() => encodePlaybackStorage(getter, SERVER, DATASET, ORIGIN, limits)); assert.equal(getters, 0);
  const proxy = new Proxy(f.state, { getPrototypeOf() { getters++; throw new Error('不执行代理'); } });
  expectBusy(() => encodePlaybackStorage(proxy, SERVER, DATASET, ORIGIN, limits)); assert.equal(getters, 0);
  const cycle = playbackCopy(f.state) as any; cycle.receipts[0].request.body = cycle;
  expectBusy(() => encodePlaybackStorage(cycle, SERVER, DATASET, ORIGIN, limits));
  // 原合同允许的较大技术字符串必须inline；不能把去重阈值当新的资料拒绝上限。
  const large = playbackCopy(f.state), resource = large.resources[0]!; assert.ok(resource.source);
  resource.request.quality.profile = 'auto'; resource.source.sourceAudio.codec = 'legacy.' + 'x'.repeat(9000);
  resource.source.processing.mode = 'remux';
  for (const receipt of large.receipts) if (receipt.operation !== 'createSession' && receipt.reply && receipt.reply.status < 400) {
    assert.ok(receipt.resourceContext);
    receipt.resourceContext.request = playbackCopy(resource.request);
    receipt.resourceContext.sourceAudio = playbackCopy(resource.source.sourceAudio);
    const reply = receipt.reply.body as MobileReadyResource;
    reply.sourceAudio = playbackCopy(resource.source.sourceAudio); reply.processing = playbackCopy(resource.source.processing);
    if (receipt.operation === 'createResource') {
      receipt.request.body = playbackCopy(resource.request);
      receipt.fingerprint = digest('request', [receipt.scopeHash, receipt.request.body]);
    }
  }
  const expectedLarge = capturePlaybackState(large, SERVER, DATASET, ORIGIN, limits);
  const inline = encodePlaybackStorage(expectedLarge, SERVER, DATASET, ORIGIN, limits);
  assert.deepEqual(decodePlaybackStorage(inline.bytes, SERVER, DATASET, ORIGIN, limits).state, expectedLarge);
  if (inline.format === 'v2') assert.equal(JSON.parse(inline.canonical).contextTemplates.length, 0);
  assert.equal(limits.stateBytes, 2_097_152); assert.equal(limits.maxReceipts, 4096); assert.equal(PLAYBACK_SHARED_BYTES_PER_RECEIPT, 8192);
});

async function denseStoredHistory(crypto: MobileAuthCrypto): Promise<PlaybackState> {
  const base = await seedHistory(crypto), state = playbackCopy(base);
  const template = base.receipts.find(r => r.operation === 'renewResource')!;
  for (let index = 0; index < 1230; index++) {
    const row = playbackCopy(template); row.id = `dense.synthetic.receipt.${index}`;
    row.request.idempotencyKey = `dense.synthetic.renew.${index}`;
    row.keyHash = digest('key', [row.deviceId, row.deviceEpoch, row.request.idempotencyKey]);
    const body = row.reply!.body as MobileReadyResource;
    body.media.url = `${ORIGIN}/mobile/v1/media/${row.resourceId}/source?ticket=${index.toString(16).padStart(64, 'a')}`;
    row.resourceContext!.now = new Date(NOW + index).toISOString(); state.receipts.push(row);
  }
  assert.ok(nodeCount(state) < 200_000 && canonicalBytes(state) > limits.stateBytes);
  return capturePlaybackState(state, SERVER, DATASET, ORIGIN, limits);
}

test('形状账本v3：原紧凑物理预算耗尽仍无损写入，冷启逐字段重放全部旧键与新键', async t => {
  const key = randomBytes(32), crypto = createMobileAuthCrypto(key); key.fill(0);
  const state = await denseStoredHistory(crypto), encoded = encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, limits);
  assert.equal(encoded.format, 'v3'); assert.ok(encoded.bytes.length <= limits.stateBytes);
  const restored = decodePlaybackStorage(encoded.bytes, SERVER, DATASET, ORIGIN, limits);
  assert.equal(restored.canonical, encoded.canonical); assert.deepEqual(restored.state, state);
  let row: MobileSealedState = { kind: 'sealed', datasetId: DATASET, revision: state.revision, commitId: state.commitId!,
    sealed: crypto.seal(encoded.bytes, aad(state.revision)) }, saves = 0;
  const persistence: MobileAuthPersistence = {
    async load() { return structuredClone(row); }, async save(request) {
      assert.equal(request.expectedRevision, row.revision); saves++;
      row = { kind: 'sealed', datasetId: DATASET, revision: row.revision + 1, commitId: request.commitId, sealed: new Uint8Array(request.sealed) };
      return { kind: 'saved', datasetId: DATASET, revision: row.revision, commitId: row.commitId }; },
  };
  const actors: MobilePlaybackService[] = [];
  const create = () => { const actor = createMobilePlaybackService({ serverId: SERVER, datasetId: DATASET, responseOrigin: ORIGIN,
    auth, persistence, crypto, sourcePort: sourcePort(false), nowMs: () => NOW }); actors.push(actor); return actor; };
  t.after(async () => { for (const actor of actors) await actor.close(); });
  const actor = create();
  for (const receipt of state.receipts) {
    const replay = await actor.control(receipt.operation, receipt.request, historyPrincipal, signal());
    assert.equal(replay.status, receipt.reply!.status); assert.deepEqual(replay.body, receipt.reply!.body);
    assert.deepEqual(replay.resourceContext ?? null, receipt.resourceContext); await replay.beforeSend();
  }
  assert.equal(saves, 0); const created = await call(actor); assert.equal(created.status, 201); assert.equal(saves, 1);
  await actor.close(); const cold = create(), replay = await call(cold);
  assert.equal(replay.status, created.status); assert.deepEqual(replay.body, created.body); assert.equal(saves, 1);
  assert.ok(row.kind === 'sealed'); const plain = crypto.open(row.sealed, aad(row.revision));
  try { assert.deepEqual(decodePlaybackStorage(plain, SERVER, DATASET, ORIGIN, limits).state.receipts.slice(0, state.receipts.length), state.receipts); }
  finally { plain.fill(0); }
});

test('形状账本v3：闭集tag/shape/arity与null缺值边界拒绝，终态预算不能缩小或插入getter', async t => {
  const key = randomBytes(32), crypto = createMobileAuthCrypto(key); key.fill(0);
  const state = await denseStoredHistory(crypto), encoded = encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, limits);
  assert.equal(encoded.format, 'v3'); const packed = JSON.parse(encoded.canonical) as Record<string, any>;
  const reject = (change: (v: Record<string, any>) => void) => { const value = playbackCopy(packed); change(value); expectBusy(() => decodePlaybackStorage(text(value), SERVER, DATASET, ORIGIN, limits)); };
  reject(v => { v.schema = 'mbm002.playback-compact-state.v4'; });
  reject(v => { v.extra = null; });
  for (const tag of [-1, 0.5, vTag(packed) + packed.shapes.length + 1]) reject(v => { v.root[0] = tag; });
  reject(v => { v.root.pop(); });
  reject(v => { v.root.push(null); });
  reject(v => { v.shapes.push(['unused']); });
  reject(v => { v.shapes.push(playbackCopy(v.shapes[0])); });
  reject(v => { v.shapes[0].push(v.shapes[0][0]); });
  reject(v => { v.shapes[0].reverse(); });
  reject(v => { v.shapes[0][0] = '__proto__'; });
  const restored = decodePlaybackStorage(encoded.bytes, SERVER, DATASET, ORIGIN, limits).state;
  assert.deepEqual(restored, state); assert.equal(restored.resources[0]!.media, null);
  for (const field of Object.keys(MOBILE_PLAYBACK_TERMINAL_FAILURE_BUDGET)) {
    const smaller = { ...MOBILE_PLAYBACK_TERMINAL_FAILURE_BUDGET, [field]: 0 };
    expectBusy(() => (encodePlaybackStorage as any)(state, SERVER, DATASET, ORIGIN, limits, smaller));
  }
  let invoked = 0;
  const getter = Object.defineProperty({ ...MOBILE_PLAYBACK_TERMINAL_FAILURE_BUDGET }, 'codeJsonBytes', { enumerable: true, get() { invoked++; return 22; } });
  expectBusy(() => (encodePlaybackStorage as any)(state, SERVER, DATASET, ORIGIN, limits, getter)); assert.equal(invoked, 0);
});
function vTag(value: Record<string, any>): number { return value.root[0] as number; }

test('终态预留：8个UNKNOWN的256种部分结算均可写，保持原字段及全预算且不靠压缩单调性', async () => {
  const key = randomBytes(32), crypto = createMobileAuthCrypto(key); key.fill(0);
  const state = await seedHistory(crypto), template = playbackCopy(state.receipts.find(r => r.operation === 'createResource')!);
  for (let i = 0; i < 8; i++) {
    const row = playbackCopy(template); row.id = `reservation.synthetic.${i}`; row.request.idempotencyKey = `reservation.key.${i}`;
    row.keyHash = digest('key', [row.deviceId, row.deviceEpoch, row.request.idempotencyKey]);
    row.state = 'UNKNOWN'; row.reply = null; row.resourceContext = null; state.receipts.push(row);
  }
  let low = 1, high = limits.stateBytes;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    try { const encoded = encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, { ...limits, stateBytes: middle }); if (encoded.format === 'v5') low = middle + 1; else high = middle; }
    catch (error) { assert.equal(safeError(error).code, 'RESOURCE_BUSY'); low = middle + 1; }
  }
  const tight = { ...limits, stateBytes: low };
  assert.equal(encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, { ...tight, stateBytes: low - 1 }).format, 'v5');
  assert.ok(encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, tight).bytes.length <= low);
  for (let mask = 0; mask < 256; mask++) {
    const candidate = playbackCopy(state); candidate.revision = Number.MAX_SAFE_INTEGER; candidate.clockFloor = 8_640_000_000_000_000;
    for (let i = 0; i < 8; i++) if (mask & 1 << i) {
      const row = candidate.receipts[state.receipts.length - 8 + i]!;
      row.state = 'RECORDED'; row.reply = { status: 409, body: { error: { code: 'IDEMPOTENCY_CONFLICT',
        message: '服务暂时无法完成请求，请查询原记录。', requestId: '40000000-0000-4000-8000-000000000001',
        retryable: false, retryAfterMs: Number.MAX_SAFE_INTEGER } } };
      const resource = candidate.resources.find(r => r.id === row.resourceId)!; resource.state = 'failed'; resource.failure = 'IDEMPOTENCY_CONFLICT'; resource.media = null;
    }
    const encoded = encodePlaybackStorage(candidate, SERVER, DATASET, ORIGIN, tight);
    assert.ok(encoded.bytes.length <= low); const decoded = decodePlaybackStorage(encoded.bytes, SERVER, DATASET, ORIGIN, tight);
    assert.deepEqual(decoded.state, candidate); assert.equal(decoded.canonical, encoded.canonical);
    assert.deepEqual(decoded.state.receipts.slice(0, state.receipts.length - 8), state.receipts.slice(0, state.receipts.length - 8));
  }
});


test('终态预留：后置已存在错误shape提前，8个UNKNOWN任意子集及9到10编号边界安全', async () => {
  const key = randomBytes(32), crypto = createMobileAuthCrypto(key); key.fill(0);
  const base = await seedHistory(crypto), state = playbackCopy(base), template = playbackCopy(base.receipts.find(r => r.operation === 'createResource')!);
  const unknown: StoredPlaybackReceipt[] = [];
  for (let i = 0; i < 8; i++) {
    const row = playbackCopy(template); row.id = `later-error.unknown.${i}`; row.request.idempotencyKey = `later-error.key.${i}`;
    row.keyHash = digest('key', [row.deviceId, row.deviceEpoch, row.request.idempotencyKey]);
    row.state = 'UNKNOWN'; row.reply = null; row.resourceContext = null; unknown.push(row);
  }
  const later = playbackCopy(template); later.id = 'later-error.recorded'; later.request.idempotencyKey = 'later-error.recorded.key';
  later.keyHash = digest('key', [later.deviceId, later.deviceEpoch, later.request.idempotencyKey]); later.state = 'RECORDED'; later.resourceContext = null;
  later.reply = { status: 409, body: { error: { code: 'SOURCE_CHANGED', message: '服务暂时无法完成请求，请查询原记录。',
    requestId: '40000000-0000-4000-8000-000000000001', retryable: false } } };
  state.receipts = [...unknown, ...base.receipts, later];
  let low = 1, high = limits.stateBytes;
  while (low < high) { const middle = Math.floor((low + high) / 2);
    try { const encoded = encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, { ...limits, stateBytes: middle }); if (encoded.format === 'v5') low = middle + 1; else high = middle; }
    catch (error) { assert.equal(safeError(error).code, 'RESOURCE_BUSY'); low = middle + 1; }
  }
  const tight = { ...limits, stateBytes: low }, initial = encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, tight);
  assert.equal(initial.format, 'v3'); const originalShapes = JSON.parse(initial.canonical).shapes as string[][]; let crossed = false;
  for (let mask = 0; mask < 256; mask++) {
    const candidate = playbackCopy(state); candidate.revision = Number.MAX_SAFE_INTEGER; candidate.clockFloor = 8_640_000_000_000_000;
    for (let i = 0; i < 8; i++) if (mask & 1 << i) {
      const row = candidate.receipts[i]!; row.state = 'RECORDED'; row.reply = { status: 409, body: { error: { code: 'IDEMPOTENCY_CONFLICT',
        message: '服务暂时无法完成请求，请查询原记录。', requestId: '40000000-0000-4000-8000-000000000001', retryable: false,
        ...(i % 2 ? { retryAfterMs: Number.MAX_SAFE_INTEGER } : {}) } } };
      const resource = candidate.resources.find(r => r.id === row.resourceId)!; resource.state = 'failed'; resource.failure = 'IDEMPOTENCY_CONFLICT'; resource.media = null;
    }
    const encoded = encodePlaybackStorage(candidate, SERVER, DATASET, ORIGIN, tight); assert.ok(encoded.bytes.length <= low);
    const decoded = decodePlaybackStorage(encoded.bytes, SERVER, DATASET, ORIGIN, tight); assert.deepEqual(decoded.state, candidate);
    assert.deepEqual(decoded.state.receipts.slice(8), state.receipts.slice(8));
    if (encoded.format === 'v3') {
      const shapes = JSON.parse(encoded.canonical).shapes as string[][];
      for (const [i, keys] of originalShapes.entries()) {
        const shifted = shapes.findIndex(shape => JSON.stringify(shape) === JSON.stringify(keys)) + 1;
        if (i + 1 < 10 && shifted >= 10) crossed = true;
      }
    }
  }
  assert.ok(crossed, '夹具必须真正覆盖既有shape从一位编号移到两位编号');
});


test('终态预留：合法UNKNOWN已有media对象时保守计费，256种部分结算仍保留旧回执', async () => {
  const key = randomBytes(32), crypto = createMobileAuthCrypto(key); key.fill(0);
  const state = await seedHistory(crypto), resource = state.resources[0]!, ready = state.receipts.find(r => r.operation === 'renewResource')!.reply!.body as MobileReadyResource;
  resource.state = 'ready'; resource.failure = null; resource.media = playbackCopy(ready.media);
  const historicalCount = state.receipts.length, template = state.receipts.find(r => r.operation === 'createResource')!;
  for (let i = 0; i < 8; i++) {
    const row = playbackCopy(template); row.id = `legacy-media.unknown.${i}`; row.request.idempotencyKey = `legacy-media.key.${i}`;
    row.keyHash = digest('key', [row.deviceId, row.deviceEpoch, row.request.idempotencyKey]); row.state = 'UNKNOWN'; row.reply = null; row.resourceContext = null;
    state.receipts.push(row);
  }
  assert.deepEqual(capturePlaybackState(state, SERVER, DATASET, ORIGIN, limits), state);
  let low = 1, high = limits.stateBytes;
  while (low < high) { const middle = Math.floor((low + high) / 2);
    try { const encoded = encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, { ...limits, stateBytes: middle }); if (encoded.format === 'v5') low = middle + 1; else high = middle; }
    catch (error) { assert.equal(safeError(error).code, 'RESOURCE_BUSY'); low = middle + 1; }
  }
  const tight = { ...limits, stateBytes: low }, initial = encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, tight); assert.equal(initial.format, 'v3');
  for (let mask = 0; mask < 256; mask++) {
    const candidate = playbackCopy(state); candidate.revision = Number.MAX_SAFE_INTEGER; candidate.clockFloor = 8_640_000_000_000_000;
    for (let i = 0; i < 8; i++) if (mask & 1 << i) {
      const row = candidate.receipts[historicalCount + i]!; row.state = 'RECORDED'; row.reply = { status: 409, body: { error: { code: 'IDEMPOTENCY_CONFLICT',
        message: '服务暂时无法完成请求，请查询原记录。', requestId: '40000000-0000-4000-8000-000000000001', retryable: false, retryAfterMs: Number.MAX_SAFE_INTEGER } } };
      candidate.resources[0]!.state = 'failed'; candidate.resources[0]!.failure = 'IDEMPOTENCY_CONFLICT'; candidate.resources[0]!.media = null;
    }
    const encoded = encodePlaybackStorage(candidate, SERVER, DATASET, ORIGIN, tight); assert.ok(encoded.bytes.length <= low);
    const decoded = decodePlaybackStorage(encoded.bytes, SERVER, DATASET, ORIGIN, tight); assert.deepEqual(decoded.state, candidate);
    assert.deepEqual(decoded.state.receipts.slice(0, historicalCount), state.receipts.slice(0, historicalCount));
  }
});

test('字符串账本v4：近满历史UNKNOWN终态预留后createSession成功，旧键与新键冷启无损', { timeout: 120_000 }, async t => {
  const key = randomBytes(32), crypto = createMobileAuthCrypto(key); key.fill(0);
  const state = await denseStoredHistory(crypto), template = state.receipts.find(r => r.operation === 'createResource')!;
  for (let i = 0; i < 8; i++) {
    const r = playbackCopy(template); r.id = `string-reserve.unknown.${i}`; r.request.idempotencyKey = `string-reserve.key.${i}`;
    r.keyHash = digest('key', [r.deviceId, r.deviceEpoch, r.request.idempotencyKey]);
    r.state = 'UNKNOWN'; r.reply = null; r.resourceContext = null; state.receipts.push(r);
  }
  const initial = encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, limits);
  assert.equal(initial.format, 'v3');
  const tight = { ...limits, stateBytes: initial.bytes.length + 32 };
  assert.ok(tight.stateBytes < limits.stateBytes && nodeCount(state) < 200_000);
  let row: MobileSealedState = { kind: 'sealed', datasetId: DATASET, revision: state.revision, commitId: state.commitId!,
    sealed: crypto.seal(initial.bytes, aad(state.revision)) }, saves = 0;
  const persistence: MobileAuthPersistence = {
    async load() { return structuredClone(row); },
    async save(request) {
      assert.equal(request.expectedRevision, row.revision); saves++;
      row = { kind: 'sealed', datasetId: DATASET, revision: row.revision + 1, commitId: request.commitId, sealed: new Uint8Array(request.sealed) };
      return { kind: 'saved', datasetId: DATASET, revision: row.revision, commitId: row.commitId };
    },
  };
  const actors: MobilePlaybackService[] = [];
  const create = (configuration = tight) => { const actor = createMobilePlaybackService({ serverId: SERVER, datasetId: DATASET, responseOrigin: ORIGIN,
    auth, persistence, crypto, sourcePort: sourcePort(false), limits: configuration, nowMs: () => NOW }); actors.push(actor); return actor; };
  t.after(async () => { for (const actor of actors) await actor.close(); });
  // 用同一合法候选在默认预算下的实际物理长度定位reserve，避免把物理满误称终态预留。
  const calibration = create(limits); assert.equal((await call(calibration)).status, 201); await calibration.close();
  assert.equal(row.kind, 'sealed'); if (row.kind !== 'sealed') throw new Error();
  const calibrated = crypto.open(row.sealed, aad(row.revision));
  try {
    const decoded = decodePlaybackStorage(calibrated, SERVER, DATASET, ORIGIN, limits);
    assert.equal(decoded.format, 'v3'); tight.stateBytes = calibrated.byteLength + 32;
    t.diagnostic(`合成近满候选v3=${JSON.stringify({ physicalBytes: calibrated.byteLength, physicalNodes: nodeCount(JSON.parse(Buffer.from(calibrated).toString('utf8'))),
      logicalBytes: canonicalBytes(decoded.state), logicalNodes: nodeCount(decoded.state), receipts: decoded.state.receipts.length })}`);
  }
  finally { calibrated.fill(0); }
  row = { kind: 'sealed', datasetId: DATASET, revision: state.revision, commitId: state.commitId!, sealed: crypto.seal(initial.bytes, aad(state.revision)) }; saves = 0;
  const actor = create();
  let created;
  try { created = await call(actor); } catch (error) {
    t.diagnostic(`近满会话候选首拒=${readPlaybackStorageRejectionBoundary(error) ?? 'UNKNOWN'}`); throw error;
  }
  assert.equal(created.status, 201); assert.equal(saves, 1);
  assert.equal(row.kind, 'sealed'); if (row.kind !== 'sealed') throw new Error();
  const plain = crypto.open(row.sealed, aad(row.revision));
  try {
    const decoded = decodePlaybackStorage(plain, SERVER, DATASET, ORIGIN, tight);
    assert.equal(decoded.format, 'v5'); assert.ok(plain.byteLength <= tight.stateBytes);
    t.diagnostic(`合成近满候选v4=${JSON.stringify({ physicalBytes: plain.byteLength, physicalNodes: nodeCount(JSON.parse(Buffer.from(plain).toString('utf8'))),
      logicalBytes: canonicalBytes(decoded.state), logicalNodes: nodeCount(decoded.state), receipts: decoded.state.receipts.length, stateBytes: tight.stateBytes })}`);
    assert.deepEqual(decoded.state.receipts.slice(0, state.receipts.length), state.receipts);
    assert.equal(decoded.state.receipts.filter(r => r.state === 'UNKNOWN').length, 8);
  } finally { plain.fill(0); }
  await actor.close();
  const cold = create(), replay = await call(cold);
  assert.equal(replay.status, created.status); assert.deepEqual(replay.body, created.body); assert.equal(saves, 1);
  const old = state.receipts.find(r => r.operation === 'renewResource')!;
  const oldReply = await cold.control(old.operation, old.request, historyPrincipal, signal());
  assert.equal(oldReply.status, old.reply!.status); assert.deepEqual(oldReply.body, old.reply!.body); await oldReply.beforeSend();
  const unknown = state.receipts.find(r => r.state === 'UNKNOWN')!;
  await assert.rejects(cold.control(unknown.operation, unknown.request, historyPrincipal, signal()), error => safeError(error).code === 'RESOURCE_BUSY');
  assert.equal(saves, 1);
});

async function stringReserveFixture(media = false) {
  const key = randomBytes(32), crypto = createMobileAuthCrypto(key); key.fill(0);
  const state = await seedHistory(crypto), template = state.receipts.find(r => r.operation === 'createResource')!;
  const resource = state.resources[0]!;
  // 标记碰撞必须是合法业务值；字典里的此字面量不能被递归当作另一条引用。
  resource.source!.processing.reason = '~0000';
  for (const r of state.receipts) if (r.reply && r.reply.status < 400 && r.operation !== 'createSession')
    (r.reply.body as MobileReadyResource).processing.reason = '~0000';
  if (media) { resource.state = 'ready'; resource.failure = null; resource.media = playbackCopy((template.reply!.body as MobileReadyResource).media); }
  for (let i = 0; i < 8; i++) {
    const r = playbackCopy(template); r.id = `string-subset.unknown.${i}`; r.request.idempotencyKey = `string-subset.key.${i}`;
    r.keyHash = digest('key', [r.deviceId, r.deviceEpoch, r.request.idempotencyKey]);
    r.state = 'UNKNOWN'; r.reply = null; r.resourceContext = null; state.receipts.unshift(r);
  }
  capturePlaybackState(state, SERVER, DATASET, ORIGIN, limits);
  let low = 1, high = limits.stateBytes;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    try { encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, { ...limits, stateBytes: middle }); high = middle; }
    catch (error) { assert.equal(safeError(error).code, 'RESOURCE_BUSY'); low = middle + 1; }
  }
  const tight = { ...limits, stateBytes: low }, encoded = encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, tight);
  assert.equal(encoded.format, 'v5'); assert.ok(encoded.bytes.length < low);
  assert.throws(() => encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, { ...tight, stateBytes: low - 1 }), error =>
    safeError(error).code === 'RESOURCE_BUSY' && readPlaybackStorageRejectionBoundary(error) === 'terminal-v4-reserve');
  return { state, tight, encoded };
}

test('字符串账本v4：两种media形态的8 UNKNOWN全部256子集可写，最大整数及新字符串保留', { timeout: 120_000 }, async () => {
  for (const media of [false, true]) {
    const { state, tight } = await stringReserveFixture(media);
    for (let mask = 0; mask < 256; mask++) {
      const candidate = playbackCopy(state); candidate.revision = Number.MAX_SAFE_INTEGER; candidate.clockFloor = 8_640_000_000_000_000;
      candidate.commitId = '50000000-0000-4000-8000-000000000001';
      for (let i = 0; i < 8; i++) if (mask & 1 << i) {
        const r = candidate.receipts[i]!; r.state = 'RECORDED'; r.reply = { status: 409, body: { error: {
          code: 'IDEMPOTENCY_CONFLICT', message: '服务暂时无法完成请求，请查询原记录。',
          requestId: `40000000-0000-4000-8000-${(mask * 8 + i).toString().padStart(12, '0')}`, retryable: false,
          ...(i % 2 ? { retryAfterMs: Number.MAX_SAFE_INTEGER } : {}),
        } } };
        const resource = candidate.resources.find(x => x.id === r.resourceId)!;
        resource.state = 'failed'; resource.failure = 'IDEMPOTENCY_CONFLICT'; resource.media = null;
      }
      const encoded = encodePlaybackStorage(candidate, SERVER, DATASET, ORIGIN, tight);
      assert.ok(encoded.bytes.length <= tight.stateBytes);
      const decoded = decodePlaybackStorage(encoded.bytes, SERVER, DATASET, ORIGIN, tight);
      assert.deepEqual(decoded.state, candidate); assert.deepEqual(decoded.state.receipts.slice(8), state.receipts.slice(8));
    }
  }
});

test('字符串账本v4：标记碰撞逐字还原，重复未用越界及非规范引用均拒绝', async () => {
  const { state, encoded } = await stringReserveFixture(), packed = JSON.parse(encoded.canonical) as Record<string, any>;
  assert.ok(packed.strings.includes('~0000'));
  assert.deepEqual(decodePlaybackStorage(encoded.bytes, SERVER, DATASET, ORIGIN, limits).state, state);
  const reject = (change: (v: Record<string, any>) => void) => { const value = playbackCopy(packed); change(value); expectBusy(() => decodePlaybackStorage(text(value), SERVER, DATASET, ORIGIN, limits)); };
  reject(v => { v.strings.push(v.strings[0]); });
  reject(v => { v.strings.push('unused.synthetic.dictionary.entry'); });
  reject(v => { v.strings[0] = {}; });
  reject(v => { v.strings[0] = 'short'; });
  reject(v => { v.extra = null; }); reject(v => { delete v.strings; });
  for (const marker of ['~zzzz', '~000', '~00000', '~ABCD', '~wat?', '~', 'long.synthetic.must.be.a.reference'])
    reject(v => { v.root[1] = marker; });
  // 6000个短引用不能在预算前展开为同一个8KiB值的约48MiB副本。
  expectBusy(() => decodePlaybackStorage(text({ schema: 'mbm002.playback-compact-state.v4', shapes: [],
    strings: ['x'.repeat(8192)], root: [0, ...Array(6000).fill('~0000')] }), SERVER, DATASET, ORIGIN, limits));
  expectBusy(() => decodePlaybackStorage(new Uint8Array(limits.stateBytes + 1), SERVER, DATASET, ORIGIN, limits));
});
