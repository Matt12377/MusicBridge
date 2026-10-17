import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { MOBILE_CODEC_LIMITS, mobileCanonicalJson, mobileDataSnapshot, type MobileJsonValue, type MobileDecodedRequest, type MobileSession, type MobileReadyResource } from '@music-bridge/contracts';
import { createMobilePlaybackService } from '../../src/mobile/playback-service.js';
import { createMobileAuthCrypto } from '../../src/mobile/auth-crypto.js';
import { capturePlaybackState, decodePlaybackState, playbackCanonical, playbackCopy, type PlaybackState, type StoredPlaybackReceipt } from '../../src/mobile/playback-state.js';
import { encodePlaybackStorage, decodePlaybackStorage, PLAYBACK_COMPACT_SCHEMA, PLAYBACK_SHARED_BYTES_PER_RECEIPT } from '../../src/mobile/playback-state-codec.js';
import { MOBILE_PLAYBACK_DEFAULT_LIMITS, type MobilePlaybackSourcePort, type MobilePlaybackService } from '../../src/mobile/playback-types.js';
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
    const template = playbackCopy(baseline.receipts.find(r => r.operation === 'createResource')!);
    template.state = 'UNKNOWN'; template.reply = null; template.resourceContext = null;
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
    expectBusy(() => decodePlaybackStorage(text(fanout), SERVER, DATASET, ORIGIN, limits));
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
