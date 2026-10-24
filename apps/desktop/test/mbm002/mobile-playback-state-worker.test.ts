import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { mobileCanonicalJson, type MobileJsonValue, type MobileDecodedRequest, type MobileSession, type MobileReadyResource } from '../../../../packages/contracts/src/index.js';
import { createMobilePlaybackService, readMobilePlaybackCloseFailures } from '../../../../packages/bridge-core/src/mobile/playback-service.js';
import { createMobileAuthCrypto } from '../../../../packages/bridge-core/src/mobile/auth-crypto.js';
import { createMobileAuthService } from '../../../../packages/bridge-core/src/mobile/auth-service.js';
import { capturePlaybackState, playbackCanonical, playbackCopy, type PlaybackState, type StoredPlaybackReceipt } from '../../../../packages/bridge-core/src/mobile/playback-state.js';
import { encodePlaybackStorage, decodePlaybackStorage } from '../../../../packages/bridge-core/src/mobile/playback-state-codec.js';
import { MOBILE_PLAYBACK_DEFAULT_LIMITS, MOBILE_PLAYBACK_STATE_LOGICAL_NODE_LIMIT, MOBILE_PLAYBACK_TERMINAL_FAILURE_BUDGET, MobilePlaybackError, type MobilePlaybackAuthPort, type MobilePlaybackStateCodecContext, type MobilePlaybackStateCodecPort, type MobilePlaybackSourcePort } from '../../../../packages/bridge-core/src/mobile/playback-types.js';
import { MobileAuthPersistenceError, type MobileAuthPersistence, type MobileSealedState, type MobilePrincipal, type MobileAuthCrypto } from '../../../../packages/bridge-core/src/mobile/types.js';
import { createMobilePlaybackStateCodec } from '../../src/main/mobile-playback-state-codec-client.js';
import { createMobileCapabilityContext, createMobileCapabilityTraceReader, withMobileCapabilityContext, type MobileCapabilityTraceRecord } from '../../../../packages/bridge-core/src/mobile/capability-trace.js';
import { PLAYBACK_CODEC_PROTOCOL, PLAYBACK_CODEC_REJECTION_BOUNDARIES, readCodecRejectionBoundary } from '../../src/main/mobile-playback-state-codec-protocol.js';

// Root先编译真实生产entry；不准以旧Core dist或同步口补位。材料全为内存合成数据。
const SERVER = 'budget.synthetic.server', DATASET = '30000000-0000-4000-8000-000000000001';
const ORIGIN = 'https://127.0.0.1:9443', NOW = Date.parse('2026-10-16T00:00:00.000Z');
const limits = MOBILE_PLAYBACK_DEFAULT_LIMITS, signal = () => new AbortController().signal;
const principal = (deviceId: string): MobilePrincipal => Object.freeze({ serverId: SERVER, datasetId: DATASET,
  accountDomain: `local:${DATASET}`, deviceId, deviceEpoch: 1, generation: 1, accessTokenHash: 'a'.repeat(64), accessExpiresAt: '2030-01-01T00:00:00.000Z' });
const oldPrincipal = principal('device.synthetic.history'), currentPrincipal = principal('device.synthetic.new');
const sessionRequest = (key = 'new-session.synthetic.original-key'): MobileDecodedRequest<unknown> => ({
  path: '/mobile/v1/sessions', pathParameters: {}, query: {}, body: { clientInstanceId: 'client.synthetic.new' }, idempotencyKey: key });
const resourceBody = { trackId: 'track.' + 't'.repeat(140), versionId: 'version.' + 'v'.repeat(140), contentRevision: 'revision.' + 'r'.repeat(140),
  quality: { profile: 'lossless', allowLossyFallback: false, preferredTransport: 'file' },
  formats: [{ codec: 'flac', container: 'flac', maxSampleRateHz: 192_000, maxChannels: 2, maxBitsPerSample: 24 }] };
const resourceRequest = (sessionId: string, key = 'resource.synthetic.original-key'): MobileDecodedRequest<unknown> => ({
  path: `/mobile/v1/sessions/${sessionId}/resources`, pathParameters: { sessionId }, query: {}, body: resourceBody, idempotencyKey: key });
const canonical = (value: unknown) => mobileCanonicalJson(value as MobileJsonValue);
const digest = (domain: string, value: unknown) => createHash('sha256').update(playbackCanonical(['MBM002_PLAYBACK_V1', SERVER, DATASET, domain, value])).digest('hex');
const aad = (revision: number) => Buffer.from(JSON.stringify(['MBM002_PLAYBACK_STATE_V1', SERVER, DATASET, revision]));
const context = (state: PlaybackState): MobilePlaybackStateCodecContext => ({ serverId: SERVER, datasetId: DATASET,
  responseOrigin: ORIGIN, generation: 'generation.synthetic.1', revision: state.revision, commitId: state.commitId, limits });
const errorCode = (code: string) => (error: unknown) => error instanceof MobilePlaybackError && error.code === code;
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
const nodes = (value: unknown): number => value === null || typeof value !== 'object' ? 1
  : 1 + (Array.isArray(value) ? value : Object.values(value)).reduce<number>((n, child) => n + nodes(child), 0);
function cryptoPort(): MobileAuthCrypto { const key = randomBytes(32), crypto = createMobileAuthCrypto(key); key.fill(0); return crypto; }
function realCodec(): MobilePlaybackStateCodecPort {
  const file = process.env.MUSIC_BRIDGE_PLAYBACK_CODEC_TEST_ENTRY;
  assert.ok(typeof file === 'string' && file.startsWith('/Volumes/LifeWeave/'), '必须采用Root在外置卷编译的真实生产Worker入口');
  return createMobilePlaybackStateCodec({ workerUrl: pathToFileURL(file) });
}
function empty(): PlaybackState { return { schema: 'musicbridge.mobile002.playback-state.v1', serverId: SERVER, datasetId: DATASET,
  revision: 0, commitId: null, clockFloor: 0, sessions: [], resources: [], receipts: [] }; }
function memoryStore(crypto: MobileAuthCrypto, initial?: PlaybackState) {
  const packed = initial ? encodePlaybackStorage(initial, SERVER, DATASET, ORIGIN, limits) : undefined;
  let row: MobileSealedState = packed ? { kind: 'sealed', datasetId: DATASET, revision: packed.state.revision,
    commitId: packed.state.commitId!, sealed: crypto.seal(packed.bytes, aad(packed.state.revision)) }
    : { kind: 'missing', datasetId: DATASET, revision: 0 };
  packed?.bytes.fill(0); const writes: MobileSealedState[] = [];
  const port: MobileAuthPersistence = {
    async load() { return structuredClone(row); },
    async save(request) {
      assert.equal(request.expectedRevision, row.revision);
      row = { kind: 'sealed', datasetId: DATASET, revision: request.expectedRevision + 1, commitId: request.commitId, sealed: new Uint8Array(request.sealed) };
      writes.push(row);
      return { kind: 'saved', datasetId: DATASET, revision: row.revision, commitId: row.commitId };
    },
  };
  // 仅在测量区间之外调用；Owner save回调没有同步解密、解码或observer重校验。
  const snapshot = () => {
    assert.equal(row.kind, 'sealed'); if (row.kind !== 'sealed') throw new Error('合成状态未保存');
    const plain = crypto.open(row.sealed, aad(row.revision));
    try { return decodePlaybackStorage(plain, SERVER, DATASET, ORIGIN, limits).state; } finally { plain.fill(0); }
  };
  return { port, writes, snapshot };
}
function sourcePort() {
  const handles = new Set<string>(); let prepares = 0, reads = 0;
  let verification: Promise<void> | undefined;
  const port: MobilePlaybackSourcePort = {
    async prepare(selection, abort) {
      abort.throwIfAborted(); prepares++; const handle = `handle.${selection.resourceId}`; handles.add(handle);
      const audio = { codec: 'flac', container: 'flac', sampleRateHz: 192_000, bitsPerSample: 24, channels: 2 };
      return { handle, sourceAudio: audio, actualAudio: { ...audio }, processing: { mode: 'direct', reason: '合成原字节', fromPreparedCache: false },
        contentType: 'audio/flac', size: 46_020_414, durationMs: 180_000, seekable: true };
    },
    async verify(handle) { assert.ok(handles.has(handle)); await verification; },
    async renew(handle) { assert.ok(handles.has(handle)); },
    async read(handle, _readId, _start, maxBytes, abort) { assert.ok(handles.has(handle)); abort.throwIfAborted(); reads++; return new Uint8Array(maxBytes); },
    async closeRead() {}, async release(handle) { assert.ok(handles.delete(handle)); },
  };
  return { port, prepares: () => prepares, reads: () => reads, holdVerification(value?: Promise<void>) { verification = value; } };
}
function fixture(t: TestContext, initial?: PlaybackState, suppliedCodec?: MobilePlaybackStateCodecPort, authority?: MobilePlaybackAuthPort, clock = () => NOW) {
  const crypto = cryptoPort(), store = memoryStore(crypto, initial), source = sourcePort(), encoded: PlaybackState[] = [];
  const actual = suppliedCodec ?? realCodec(), observers = new Set<(state: PlaybackState) => void>(); let authCalls = 0, expectedCloseFailure = false;
  let expectedCloseIdentity = false, closeIdentity: unknown = undefined;
  const stateCodec: MobilePlaybackStateCodecPort = {
    async encode(state, ctx) { const result = await actual.encode(state, ctx); encoded.push(result.state); for (const observer of observers) observer(result.state); return result; },
    decode: (plain, ctx) => actual.decode(plain, ctx), close: () => actual.close(),
  };
  const auth = { async assertDeviceCurrent(device: string, epoch: number) {
    authCalls++;
    if (authority) await authority.assertDeviceCurrent(device, epoch);
    else { assert.ok([oldPrincipal.deviceId, currentPrincipal.deviceId].includes(device)); assert.equal(epoch, 1); }
  } };
  const service = createMobilePlaybackService({ serverId: SERVER, datasetId: DATASET, responseOrigin: ORIGIN,
    auth, persistence: store.port, crypto, sourcePort: source.port, stateCodec, nowMs: clock });
  t.after(async () => {
    if (expectedCloseIdentity) await assert.rejects(service.close(), error => Object.is(error, closeIdentity));
    else if (expectedCloseFailure) await assert.rejects(service.close(), errorCode('BUSY'));
    else await service.close();
  });
  return { service, crypto, store, source, encoded, authCalls: () => authCalls,
    expectCloseFailure() { expectedCloseFailure = true; },
    expectCloseIdentity(error: unknown) { expectedCloseIdentity = true; closeIdentity = error; },
    observe(callback: (state: PlaybackState) => void) { observers.add(callback); return () => observers.delete(callback); } };
}
async function readyIntent(f: ReturnType<typeof fixture>, request: MobileDecodedRequest<unknown>, p: MobilePrincipal) {
  const computed = deferred<void>();
  const remove = f.observe(s => {
    const receipt = s.receipts.find(r => r.deviceId === p.deviceId && r.request.idempotencyKey === request.idempotencyKey);
    if (receipt && s.resources.find(r => r.id === receipt.resourceId)?.state === 'ready') computed.resolve();
  });
  try {
    const original = await f.service.control('createResource', request, p, signal());
    assert.ok(original.status === 201 || original.status === 202);
    if (original.status === 201) return { original, current: original };
    await computed.promise;
    const resource = original.body as { id: string }, sessionId = request.pathParameters.sessionId!;
    const current = await f.service.control('getResource', { path: `/mobile/v1/sessions/${sessionId}/resources/${resource.id}`,
      pathParameters: { sessionId, resourceId: resource.id }, query: {}, body: null }, p, signal());
    assert.equal((current.body as MobileReadyResource).state, 'ready'); return { original, current };
  } finally { remove(); }
}
async function seed(t: TestContext): Promise<PlaybackState> {
  const f = fixture(t), created = await f.service.control('createSession', sessionRequest('history.session'), oldPrincipal, signal());
  const session = created.body as MobileSession;
  const ready = await readyIntent(f, resourceRequest(session.id, 'history.resource'), oldPrincipal);
  const resource = ready.current.body as MobileReadyResource;
  await f.service.control('renewResource', { path: `/mobile/v1/sessions/${session.id}/resources/${resource.id}/renew`,
    pathParameters: { sessionId: session.id, resourceId: resource.id }, query: {}, body: {}, idempotencyKey: 'history.renew.seed' }, oldPrincipal, signal());
  const state = f.store.snapshot();
  for (const s of state.sessions) s.terminal = 'SESSION_CLOSED';
  for (const r of state.resources) { r.state = 'terminal'; r.failure = 'SERVICE_RESTARTED'; r.media = null; }
  await f.service.close();
  return capturePlaybackState(state, SERVER, DATASET, ORIGIN, limits);
}
function history(base: PlaybackState, near = false): PlaybackState {
  const state = playbackCopy(base), template = state.receipts.find(r => r.operation === 'renewResource')!; let size = Buffer.byteLength(canonical(state));
  for (let i = 0; i < limits.maxReceipts - 2; i++) {
    const r = playbackCopy(template); r.id = `history.synthetic.receipt.${i}`; r.request.idempotencyKey = `history.synthetic.renew.${i}`;
    r.keyHash = digest('key', [r.deviceId, r.deviceEpoch, r.request.idempotencyKey]);
    const delta = Buffer.byteLength(canonical(r)) + 1 + String(state.revision + 1).length - String(state.revision).length;
    if (near ? size + delta > limits.stateBytes - 16_384 : i === 8) break;
    state.receipts.push(r); state.revision++; size += delta;
  }
  if (near) { assert.ok(size > limits.stateBytes * 0.98); assert.ok(state.receipts.length >= 550 && state.receipts.length <= 650); }
  return capturePlaybackState(state, SERVER, DATASET, ORIGIN, limits);
}

test('播放Worker：原编解码字节状态等价且传输所有权和各层拒绝保持', { timeout: 60_000 }, async t => {
  const port = realCodec(); t.after(() => port.close());
  const base = await seed(t), state = history(base);
  for (const input of [empty(), state]) {
    const expected = encodePlaybackStorage(input, SERVER, DATASET, ORIGIN, limits);
    const encoded = await port.encode(input, context(input));
    assert.equal(encoded.canonical, expected.canonical); assert.equal(encoded.format, expected.format);
    assert.deepEqual(encoded.bytes, expected.bytes); assert.deepEqual(encoded.state, expected.state);
    const plain = new Uint8Array(encoded.bytes), decodedFlight = port.decode(plain, context(input)); plain.fill(0);
    const decoded = await decodedFlight; assert.equal(decoded.canonical, expected.canonical); assert.deepEqual(decoded.state, expected.state);
    encoded.bytes.fill(0); expected.bytes.fill(0);
  }
  const owned = playbackCopy(state), expected = canonical(owned), flight = port.encode(owned, context(owned));
  owned.receipts.at(-1)!.fingerprint = '0'.repeat(64);
  const result = await flight; assert.equal(canonical(result.state), expected); result.bytes.fill(0);
  for (const change of [
    (r: StoredPlaybackReceipt) => { r.fingerprint = '0'.repeat(64); },
    (r: StoredPlaybackReceipt) => { r.resourceContext!.scope.serverId = 'wrong.server'; },
    (r: StoredPlaybackReceipt) => { (r.reply!.body as MobileReadyResource).sourceAudio.bitsPerSample = 16; },
  ]) {
    const bad = playbackCopy(state); change(bad.receipts.at(-1)!);
    assert.throws(() => encodePlaybackStorage(bad, SERVER, DATASET, ORIGIN, limits), errorCode('BUSY'));
    await assert.rejects(port.encode(bad, context(bad)), errorCode('BUSY'));
  }
  let called = 0;
  const getter = Object.defineProperty(playbackCopy(state), 'receipts', { enumerable: true, get() { called++; return []; } });
  const proxy = new Proxy(state, { getPrototypeOf() { called++; throw new Error('不得运行'); } });
  await assert.rejects(port.encode(getter, context(state)), errorCode('BUSY'));
  await assert.rejects(port.encode(proxy, context(state)), errorCode('BUSY')); assert.equal(called, 0);
  const packed = encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, limits), wrong = JSON.parse(packed.canonical);
  wrong.receipts.at(-1).request.template = -1;
  const raw = new Uint8Array(Buffer.from(canonical(wrong)));
  assert.throws(() => decodePlaybackStorage(raw, SERVER, DATASET, ORIGIN, limits), errorCode('BUSY'));
  await assert.rejects(port.decode(raw, context(state)), errorCode('BUSY'));
  await assert.rejects(port.decode(new Uint8Array(limits.stateBytes + 1), context(state)), errorCode('BUSY'));
  // 保留原200k边界夹具，迁移后共享引用仍完整往返；新1m拒绝由容量回归另行覆盖。
  const expanded = playbackCopy(state), resource = expanded.resources[0]!;
  resource.request.formats = Array.from({ length: 20 }, () => playbackCopy(resource.request.formats[0]!));
  for (const r of expanded.receipts) if (r.resourceId === resource.id) {
    if (r.resourceContext) r.resourceContext.request = playbackCopy(resource.request);
    if (r.operation === 'createResource') { r.request.body = playbackCopy(resource.request); r.fingerprint = digest('request', [r.scopeHash, r.request.body]); }
  }
  const template = playbackCopy(expanded.receipts.find(r => r.operation === 'createResource')!);
  // 精确当前节点预算使用已记录回执；UNKNOWN还要为未来终态保留节点。
  const count = Math.floor((200_000 - nodes(expanded)) / nodes(template));
  const make = (i: number) => { const r = playbackCopy(template); r.id = `node.receipt.${i}`; r.request.idempotencyKey = `node.key.${i}`;
    r.keyHash = digest('key', [r.deviceId, r.deviceEpoch, r.request.idempotencyKey]); r.request.body = template.request.body; return r; };
  for (let i = 0; i < count; i++) expanded.receipts.push(make(i));
  expanded.revision += count;
  const inside = await port.encode(expanded, context(expanded)); assert.ok(nodes(expanded) <= 200_000);
  const extra = make(count); expanded.receipts.push(extra); expanded.revision++;
  assert.ok(nodes(expanded) > 200_000);
  const beyondOld = await port.encode(expanded, context(expanded));
  assert.deepEqual(beyondOld.state, expanded); beyondOld.bytes.fill(0);
  const fanout = JSON.parse(inside.canonical), last = playbackCopy(fanout.receipts.at(-1));
  assert.ok(Number.isInteger(last.request.template));
  last.id = extra.id; last.request.idempotencyKey = extra.request.idempotencyKey; last.keyHash = extra.keyHash; fanout.receipts.push(last); fanout.revision++;
  const fanoutBytes = new Uint8Array(Buffer.from(canonical(fanout)));
  assert.deepEqual(decodePlaybackStorage(fanoutBytes, SERVER, DATASET, ORIGIN, limits).state, expanded);
  assert.deepEqual((await port.decode(fanoutBytes, context(expanded))).state, expanded);
  // 真正超过新逻辑上限，仍须在Main复制及Worker原始校验阶段拒绝，不能只测旧200k。
  const excessive = playbackCopy(state); excessive.receipts[0]!.request.body = new Array(MOBILE_PLAYBACK_STATE_LOGICAL_NODE_LIMIT).fill(null);
  assert.throws(() => encodePlaybackStorage(excessive, SERVER, DATASET, ORIGIN, limits), errorCode('RESOURCE_BUSY'));
  await assert.rejects(port.encode(excessive, context(excessive)), errorCode('RESOURCE_BUSY'));
  inside.bytes.fill(0); packed.bytes.fill(0); raw.fill(0); fanoutBytes.fill(0);
  const draining = realCodec(), late = draining.encode(state, context(state));
  const rejected = assert.rejects(late, errorCode('BUSY')), closed = draining.close();
  await rejected; await closed;
  await assert.rejects(draining.encode(state, context(state)), errorCode('BUSY'));
});

test('播放Worker：近满旧账本迁v3字节一致、预算闭集与自然关闭保持', { timeout: 60_000 }, async t => {
  const base = await seed(t), state = playbackCopy(base), template = state.receipts.find(r => r.operation === 'renewResource')!;
  for (let i = 0; i < 1230; i++) {
    const row = playbackCopy(template); row.id = `dense.worker.receipt.${i}`; row.request.idempotencyKey = `dense.worker.key.${i}`;
    row.keyHash = digest('key', [row.deviceId, row.deviceEpoch, row.request.idempotencyKey]);
    (row.reply!.body as MobileReadyResource).media.url = `${ORIGIN}/mobile/v1/media/${row.resourceId}/source?ticket=${i.toString(16).padStart(64, 'a')}`;
    row.resourceContext!.now = new Date(NOW + i).toISOString(); state.receipts.push(row);
  }
  const expected = encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, limits); assert.equal(expected.format, 'v3');
  const port = realCodec(); t.after(() => port.close());
  const encoded = await port.encode(state, { ...context(state), terminalFailureBudget: MOBILE_PLAYBACK_TERMINAL_FAILURE_BUDGET });
  assert.equal(encoded.format, 'v3'); assert.equal(encoded.canonical, expected.canonical); assert.deepEqual(encoded.bytes, expected.bytes);
  const decoded = await port.decode(encoded.bytes, context(state)); assert.equal(decoded.canonical, expected.canonical); assert.deepEqual(decoded.state, state);
  for (const field of Object.keys(MOBILE_PLAYBACK_TERMINAL_FAILURE_BUDGET)) {
    const budget = { ...MOBILE_PLAYBACK_TERMINAL_FAILURE_BUDGET, [field]: 0 };
    await assert.rejects(port.encode(state, { ...context(state), terminalFailureBudget: budget }), errorCode('BUSY'));
  }
  let called = 0;
  const getter = Object.defineProperty({ ...MOBILE_PLAYBACK_TERMINAL_FAILURE_BUDGET }, 'messageJsonBytes', { enumerable: true, get() { called++; return 56; } });
  await assert.rejects(port.encode(state, { ...context(state), terminalFailureBudget: getter }), errorCode('BUSY')); assert.equal(called, 0);
  const after = await port.encode(empty(), context(empty())); assert.equal(after.format, 'v1');
  await port.close(); await assert.rejects(port.encode(empty(), context(empty())), errorCode('BUSY'));
  expected.bytes.fill(0); encoded.bytes.fill(0); after.bytes.fill(0);
});

class FakeWorker extends EventEmitter {
  readonly jobs: any[] = [];
  postMessage(message: any): void {
    if (message.kind === 'close') { queueMicrotask(() => this.emit('exit', 0)); return; }
    this.jobs.push(message); this.emit('posted', message);
  }
  async terminate(): Promise<number> { queueMicrotask(() => this.emit('exit', 1)); return 1; }
}
function reply(fake: FakeWorker, state = empty(), change: Record<string, unknown> = {}) {
  const job = fake.jobs.at(-1), result = encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, limits);
  const packet = { protocol: PLAYBACK_CODEC_PROTOCOL, kind: 'result', id: job.id, operation: job.operation, binding: job.binding, result, ...change };
  fake.emit('message', packet); return packet;
}
test('播放Worker：有界队列错包错误超时重复及关闭迟到结果均不重发', { timeout: 60_000 }, async t => {
  for (const mode of ['wrong-id', 'wrong-binding', 'wrong-revision', 'error', 'timeout', 'duplicate', 'close'] as const) {
    const fake = new FakeWorker(), port = createMobilePlaybackStateCodec({ workerFactory: () => fake as unknown as Worker, timeoutMs: mode === 'timeout' ? 10 : 1_000 });
    const first = port.encode(empty(), context(empty()));
    if (mode === 'duplicate') {
      const packet = reply(fake); (await first).bytes.fill(0); fake.emit('message', packet);
      await assert.rejects(port.encode(empty(), context(empty())), errorCode('BUSY'));
      await assert.rejects(port.close(), errorCode('BUSY'));
    } else if (mode === 'close') {
      const queued = port.encode(empty(), context(empty()));
      await assert.rejects(port.encode(empty(), context(empty())), errorCode('BUSY'));
      const rejected = [assert.rejects(first, errorCode('BUSY')), assert.rejects(queued, errorCode('BUSY'))];
      const closed = port.close(), packet = reply(fake);
      await Promise.all(rejected); await closed;
      assert.equal(packet.result.bytes.every((v: number) => v === 0), true); assert.equal(fake.jobs.length, 1);
    } else {
      const rejected = assert.rejects(first, errorCode('BUSY'));
      if (mode === 'wrong-id') reply(fake, empty(), { id: 999 });
      if (mode === 'wrong-binding') reply(fake, empty(), { binding: 'wrong.generation' });
      if (mode === 'wrong-revision') reply(fake, { ...empty(), revision: 1, commitId: 'commit.synthetic.wrong' });
      if (mode === 'error') fake.emit('error', new Error('合成线程故障'));
      await rejected; await assert.rejects(port.close(), errorCode('BUSY')); assert.equal(fake.jobs.length, 1);
    }
  }
  for (const mode of ['wrong-id', 'error', 'timeout'] as const) {
    const fake = new FakeWorker(), posted = deferred<void>(); fake.once('posted', () => posted.resolve());
    const port = createMobilePlaybackStateCodec({ workerFactory: () => fake as unknown as Worker, timeoutMs: mode === 'timeout' ? 10 : 1_000 });
    const f = fixture(t, undefined, port); f.expectCloseFailure();
    const rejected = assert.rejects(f.service.control('createSession', sessionRequest(), currentPrincipal, signal()), errorCode('BUSY'));
    await posted.promise;
    if (mode === 'wrong-id') reply(fake, empty(), { id: 999 });
    if (mode === 'error') fake.emit('error', new Error('合成故障'));
    await rejected; assert.equal(f.store.writes.length, 0); assert.equal(fake.jobs.length, 1);
    assert.equal(f.service.resourceSnapshot().pendingPersistence, false);
  }
});

test('播放Worker：异步口保留二或自然三保存历史冷启UNKNOWN及关闭撤销fence', { timeout: 60_000 }, async t => {
  const initial = history(await seed(t)), historyText = canonical(initial.receipts), f = fixture(t, initial);
  const session = (await f.service.control('createSession', sessionRequest(), currentPrincipal, signal())).body as MobileSession;
  const before = f.store.writes.length, encodedBefore = f.encoded.length, request = resourceRequest(session.id);
  const settled = await readyIntent(f, request, currentPrincipal), ready = settled.current; await ready.beforeSend();
  // 来源事实与202或ready终态共一次ACK；外部prepare之前的UNKNOWN仍独立durable。
  const count = f.store.writes.length - before; assert.ok(count === 2 || count === 3);
  const phases = f.encoded.slice(encodedBefore).map(s => {
    const r = s.resources.find(r => r.sessionId === session.id)!, receipt = s.receipts.find(v => v.operation === 'createResource' && v.resourceId === r.id)!;
    return [r.state, r.source === null, receipt.state, receipt.reply?.status ?? null];
  });
  assert.equal(phases.length, count);
  assert.deepEqual(phases[0], ['preparing', true, 'UNKNOWN', null]);
  if (count === 3) assert.deepEqual(phases[1], ['preparing', false, 'RECORDED', 202]);
  assert.deepEqual(phases.at(-1), ['ready', false, 'RECORDED', count === 2 ? 201 : 202]);
  assert.equal(settled.original.status, count === 2 ? 201 : 202);
  const resource = ready.body as MobileReadyResource; assert.equal(resource.media.actualAudio.sampleRateHz, 192_000); assert.equal(resource.media.actualAudio.bitsPerSample, 24);
  const state = f.store.snapshot(); assert.equal(canonical(state.receipts.slice(0, initial.receipts.length)), historyText);
  await f.service.close();
  const cold = fixture(t, state), replay = await cold.service.control('createResource', request, currentPrincipal, signal());
  assert.deepEqual(replay.body, settled.original.body); assert.equal(replay.status, settled.original.status);
  assert.equal(cold.source.prepares(), 0); assert.equal(cold.store.writes.length, 1);
  await cold.service.control('createResource', request, currentPrincipal, signal()); assert.equal(cold.store.writes.length, 1);
  await cold.service.close();

  const natural = fixture(t), naturalSession = (await natural.service.control('createSession', sessionRequest(), currentPrincipal, signal())).body as MobileSession;
  const verify = deferred<void>(), finished = deferred<void>(); natural.source.holdVerification(verify.promise);
  natural.observe(s => { if (s.resources.some(r => r.state === 'ready')) finished.resolve(); });
  const savedBefore = natural.store.writes.length, naturalRequest = resourceRequest(naturalSession.id);
  const preparing = await natural.service.control('createResource', naturalRequest, currentPrincipal, signal());
  assert.equal(preparing.status, 202); verify.resolve(); await finished.promise;
  const preparingResource = preparing.body as { id: string };
  const observed = await natural.service.control('getResource', { path: `/mobile/v1/sessions/${naturalSession.id}/resources/${preparingResource.id}`,
    pathParameters: { sessionId: naturalSession.id, resourceId: preparingResource.id }, query: {}, body: null }, currentPrincipal, signal());
  assert.equal((observed.body as MobileReadyResource).state, 'ready'); assert.equal(natural.store.writes.length - savedBefore, 3);
  assert.deepEqual((await natural.service.control('createResource', naturalRequest, currentPrincipal, signal())).body, preparing.body);
  await natural.service.close();

  const unknownState = playbackCopy(initial), unknownReceipt = unknownState.receipts.at(-1)!;
  unknownReceipt.state = 'UNKNOWN'; unknownReceipt.reply = null; unknownReceipt.resourceContext = null;
  const unknown = fixture(t, unknownState);
  await assert.rejects(unknown.service.control(unknownReceipt.operation, unknownReceipt.request, oldPrincipal, signal()), errorCode('RESOURCE_BUSY'));
  assert.equal(unknown.store.writes.length, 0);
  await unknown.service.close();
  for (const mode of ['committed', 'missing', 'conflict'] as const) {
    const sample = fixture(t, initial), save = sample.store.port.save; let attempts = 0;
    sample.store.port.save = async request => { attempts++;
      if (mode === 'conflict') return { kind: 'conflict', datasetId: DATASET, currentRevision: request.expectedRevision + 1 };
      if (mode === 'committed') await save(request); throw new MobileAuthPersistenceError('unknown'); };
    await assert.rejects(sample.service.control('createSession', sessionRequest(), currentPrincipal, signal()), errorCode(mode === 'conflict' ? 'REVISION_CONFLICT' : 'BUSY'));
    if (mode === 'committed') assert.equal((await sample.service.control('createSession', sessionRequest(), currentPrincipal, signal())).status, 201);
    if (mode === 'missing') await assert.rejects(sample.service.control('createSession', sessionRequest(), currentPrincipal, signal()), errorCode('BUSY'));
    assert.equal(attempts, 1);
    await sample.service.close();
  }
  for (const mode of ['close', 'revoke'] as const) {
    const actual = realCodec(), computed = deferred<void>(), release = deferred<void>(); let hold = true;
    const wrapped: MobilePlaybackStateCodecPort = { async encode(state, ctx) {
      const result = await actual.encode(state, ctx);
      if (hold) { hold = false; computed.resolve(); await release.promise; }
      return result;
    }, decode: (bytes, ctx) => actual.decode(bytes, ctx), close: () => actual.close() };
    const late = fixture(t, undefined, wrapped), creation = late.service.control('createSession', sessionRequest(), currentPrincipal, signal());
    const rejected = assert.rejects(creation, errorCode(mode === 'close' ? 'SERVICE_RESTARTED' : 'BUSY'));
    await computed.promise;
    const closing = mode === 'close' ? late.service.close() : late.service.revokeDevice(currentPrincipal.deviceId);
    release.resolve(); await rejected; await closing;
    // 撤销自身原操作可保存一次空终态；迟到createSession没有写入或发布。
    assert.equal(late.store.writes.length, mode === 'close' ? 0 : 1);
    if (mode === 'revoke') assert.equal(late.store.snapshot().sessions.length, 0);
    await late.service.close();
  }
});

test('播放Worker：近六百历史正常预取时Main事件循环已有reader与权威auth可推进', { timeout: 60_000 }, async t => {
  const initial = history(await seed(t), true), actual = realCodec(), posted = deferred<void>(), readyComputed = deferred<void>();
  let observing = false, pending = 0, markerInCompute = false;
  const wrapped: MobilePlaybackStateCodecPort = {
    async encode(state, ctx) {
      const task = actual.encode(state, ctx); if (observing) { pending++; posted.resolve(); }
      try {
        const result = await task;
        if (observing && result.state.resources.at(-1)?.state === 'ready') readyComputed.resolve();
        return result;
      } finally { if (observing) pending--; }
    }, decode: (bytes, ctx) => actual.decode(bytes, ctx), close: () => actual.close(),
  };
  const authCrypto = cryptoPort(), authStore = memoryStore(authCrypto); let authorityLoads = 0;
  const load = authStore.port.load; authStore.port.load = async dataset => { authorityLoads++; return await load(dataset); };
  const authority = createMobileAuthService({ persistence: authStore.port, crypto: authCrypto, serverId: SERVER, datasetId: DATASET,
    displayName: '合成Worker鉴权', environment: 'development', now: () => NOW }); t.after(() => authority.close());
  const permit = await authority.issuePairing(), pair = await authority.claim({ pairingSecret: permit.pairingSecret,
    installationId: 'installation.synthetic.worker', deviceName: '合成设备' }, 'claim.synthetic.worker');
  const p = await authority.authenticate(pair.accessToken), f = fixture(t, initial, wrapped, authority);
  const session = (await f.service.control('createSession', sessionRequest(), p, signal())).body as MobileSession;
  const first = await readyIntent(f, resourceRequest(session.id, 'resource.already.ready'), p);
  const ready = first.current.body as MobileReadyResource, url = new URL(ready.media.url);
  const media = await f.service.openMedia('getMediaAsset', { path: url.pathname, pathParameters: { resourceId: ready.id, asset: 'source' },
    query: { ticket: url.searchParams.get('ticket')! }, body: null }, signal(), { range: 'bytes=0-65535' });
  assert.ok(media.reader);
  const authBefore = f.authCalls(), loadsBefore = authorityLoads, writesBefore = f.store.writes.length, historyText = canonical(initial.receipts);
  observing = true; const started = performance.now(), cpu = process.cpuUsage();
  const creation = f.service.control('createResource', resourceRequest(session.id, 'resource.normal.prefetch'), p, signal());
  await posted.promise;
  const marker = new Promise<number>(resolve => setImmediate(() => { markerInCompute = pending > 0; resolve(performance.now() - started); }));
  const readAt = performance.now(), bytes = await media.reader.read(65_536), readMs = performance.now() - readAt, authorityFinishedDuringCompute = pending > 0;
  const markerMs = await marker, response = await creation;
  assert.ok(response.status === 201 || response.status === 202);
  if (response.status === 202) {
    await readyComputed.promise;
    const preparing = response.body as { id: string };
    const readyReply = await f.service.control('getResource', { path: `/mobile/v1/sessions/${session.id}/resources/${preparing.id}`,
      pathParameters: { sessionId: session.id, resourceId: preparing.id }, query: {}, body: null }, p, signal());
    assert.equal((readyReply.body as MobileReadyResource).state, 'ready');
  }
  const wallMs = performance.now() - started;
  const cpuUsed = process.cpuUsage(cpu); observing = false;
  assert.equal(bytes.length, 65_536); assert.ok(f.authCalls() > authBefore);
  assert.ok(markerInCompute, '真实Worker计算未结算时Main marker必须已推进');
  assert.ok(authorityFinishedDuringCompute && authorityLoads > loadsBefore, '原AuthService及Owner内存load必须在Worker计算期间完成真实权威校验');
  assert.ok(markerMs < wallMs); assert.ok(readMs < wallMs);
  assert.equal(f.source.prepares(), 2); assert.equal(f.source.reads(), 1);
  assert.equal(f.store.writes.length - writesBefore, response.status === 201 ? 2 : 3);
  // 所有重校验与历史解密在计时结束之后；不在Owner保存回调中做同步observer。
  assert.equal(canonical(f.store.snapshot().receipts.slice(0, initial.receipts.length)), historyText);
  console.log(JSON.stringify({ kind: 'playback-worker-responsive', historicalReceipts: initial.receipts.length,
    logicalBytes: Buffer.byteLength(canonical(initial)), wallMs, markerMs, readMs, markerInCompute,
    processCpuMicros: cpuUsed.user + cpuUsed.system, ownerSaves: f.store.writes.length - writesBefore,
    readyWaitMs: limits.readyWaitMs, responseStatus: response.status, authAdvanced: f.authCalls() > authBefore,
    authorityFinishedDuringCompute, authorityLoads: authorityLoads - loadsBefore, sourcePrepares: f.source.prepares() }));
  await media.close(); await f.service.close();
});

test('播放Worker R2：原一秒巡检被撤销失效不假fatal且真实后台故障仍拒绝', { timeout: 30_000 }, async t => {
  for (const mode of ['revoke', 'worker-failure'] as const) {
    const file = process.env.MUSIC_BRIDGE_PLAYBACK_CODEC_TEST_ENTRY;
    assert.ok(typeof file === 'string' && file.startsWith('/Volumes/LifeWeave/'));
    let armed = false, at = NOW, releases = 0;
    const evidence: { worker?: Worker; discarded?: Uint8Array; sourceAbort?: AbortSignal; workerExited: boolean } = { workerExited: false };
    const actual = createMobilePlaybackStateCodec({ workerFactory: () => {
      evidence.worker = new Worker(pathToFileURL(file), { execArgv: [], env: {}, name: 'mobile-playback-codec',
        resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64, stackSizeMb: 4 } });
      return evidence.worker;
    } });
    const entered = deferred<void>(), release = deferred<void>();
    const wrapped: MobilePlaybackStateCodecPort = {
      async encode(state, ctx) {
        if (armed && state.resources.some(r => r.state === 'terminal' && r.failure === 'RESOURCE_EXPIRED')) {
          armed = false;
          if (mode === 'worker-failure') {
            assert.ok(evidence.worker); await evidence.worker.terminate(); evidence.workerExited = true; entered.resolve();
            // 生产client真实收到Worker exit后的BUSY，绝不是内部失效品牌。
            return await actual.encode(state, ctx);
          }
          const result = await actual.encode(state, ctx);
          evidence.discarded = result.bytes; entered.resolve(); await release.promise; return result;
        }
        return await actual.encode(state, ctx);
      },
      decode: (plain, ctx) => actual.decode(plain, ctx), close: () => actual.close(),
    };
    const f = fixture(t, undefined, wrapped, undefined, () => at);
    if (mode === 'worker-failure') f.expectCloseFailure();
    const prepare = f.source.port.prepare, originalRelease = f.source.port.release;
    f.source.port.prepare = async (selection, abort) => { evidence.sourceAbort = abort; return await prepare(selection, abort); };
    f.source.port.release = async handle => { releases++; await originalRelease(handle); };
    const session = (await f.service.control('createSession', sessionRequest(), currentPrincipal, signal())).body as MobileSession;
    const ready = await readyIntent(f, resourceRequest(session.id), currentPrincipal), resource = ready.current.body as MobileReadyResource;
    const before = f.store.writes.length, receipts = canonical(f.store.snapshot().receipts);
    armed = true; at = NOW + limits.resourceTtlMs;
    // 等产品原1秒interval自然触发，不调用控制接口促成expire，也不改timer/时钟边界。
    await entered.promise;
    assert.equal(f.store.writes.length, before);
    if (mode === 'revoke') {
      const revoked = f.service.revokeDevice(currentPrincipal.deviceId); release.resolve(); await revoked;
      assert.equal(f.store.writes.length, before + 1);
      const saved = f.store.snapshot();
      assert.equal(saved.sessions.find(s => s.id === session.id)!.terminal, 'DEVICE_REVOKED');
      const terminal = saved.resources.find(r => r.id === resource.id)!;
      assert.equal(terminal.state, 'terminal'); assert.equal(terminal.failure, 'DEVICE_REVOKED'); assert.equal(terminal.media, null);
      assert.equal(canonical(saved.receipts), receipts);
      assert.equal(releases, 1); assert.equal(evidence.sourceAbort?.aborted, true); assert.equal(f.service.resourceSnapshot().liveResources, 0);
      assert.ok(evidence.discarded); assert.ok(evidence.discarded.every(v => v === 0));
      assert.equal(f.service.resourceSnapshot().pendingPersistence, false);
      // 独立设备的新正常操作仍可继续，证明未被后台catch永久置fatal。
      assert.equal((await f.service.control('createSession', sessionRequest('after.revoke'), oldPrincipal, signal())).status, 201);
      await f.service.close();
    } else {
      await assert.rejects(f.service.control('getSession', { path: `/mobile/v1/sessions/${session.id}`,
        pathParameters: { sessionId: session.id }, query: {}, body: null }, currentPrincipal, signal()), errorCode('SERVICE_RESTARTED'));
      assert.equal(f.store.writes.length, before); assert.equal(evidence.workerExited, true);
      await assert.rejects(f.service.close(), errorCode('BUSY'));
    }
  }
});

test('播放Worker R2：关闭双失败保首因和次错快照并等待真实Worker退出', { timeout: 30_000 }, async t => {
  for (const mode of ['double', 'worker-only', 'worker-undefined'] as const) {
    const actual = realCodec(), primary = new MobilePlaybackError(429, 'RESOURCE_BUSY', true, 1_000);
    const secondary = mode === 'worker-undefined' ? undefined : new MobilePlaybackError(503, 'BUSY', true, 1_000);
    let workerExited = false, closeCalls = 0;
    const wrapped: MobilePlaybackStateCodecPort = {
      encode: (state, ctx) => actual.encode(state, ctx), decode: (plain, ctx) => actual.decode(plain, ctx),
      async close() { closeCalls++; await actual.close(); workerExited = true; throw secondary; },
    };
    const f = fixture(t, undefined, wrapped), expected = mode === 'double' ? primary : secondary;
    f.expectCloseIdentity(expected);
    const session = (await f.service.control('createSession', sessionRequest(), currentPrincipal, signal())).body as MobileSession;
    if (mode === 'double') {
      await readyIntent(f, resourceRequest(session.id), currentPrincipal);
      f.source.port.release = async () => { throw primary; };
    }
    const first = f.service.close(), again = f.service.close(); assert.equal(first, again);
    let rejected = false, reason: unknown = undefined;
    try { await first; } catch (error) { rejected = true; reason = error; }
    assert.equal(rejected, true); assert.equal(reason, expected); assert.equal(workerExited, true); assert.equal(closeCalls, 1);
    assert.equal(f.service.close(), first);
    const facts = readMobilePlaybackCloseFailures(f.service);
    assert.ok(Object.isFrozen(facts)); assert.ok(facts.every(Object.isFrozen));
    assert.deepEqual(facts, mode === 'double'
      ? [{ stage: 'drain', status: 429, code: 'RESOURCE_BUSY' }, { stage: 'codec-close', status: 503, code: 'BUSY' }]
      : [{ stage: 'codec-close', status: 503, code: 'BUSY' }]);
    for (const fact of facts) assert.deepEqual(Object.keys(fact).sort(), ['code', 'stage', 'status']);
  }
});


function denseDefaultHistory(base: PlaybackState, number: number): PlaybackState {
  const state = playbackCopy(base), template = state.receipts.find(r => r.operation === 'renewResource')!;
  for (let i = 0; i < number; i++) {
    const row = playbackCopy(template); row.id = `dense.synthetic.receipt.${i.toString().padStart(4, '0')}`;
    row.request.idempotencyKey = `dense.synthetic.key.${i.toString().padStart(4, '0')}`;
    row.keyHash = digest('key', [row.deviceId, row.deviceEpoch, row.request.idempotencyKey]);
    (row.reply!.body as MobileReadyResource).media.url = `${ORIGIN}/mobile/v1/media/${row.resourceId}/source?ticket=${i.toString(16).padStart(64, 'a')}`;
    row.resourceContext!.now = new Date(NOW + i).toISOString(); state.receipts.push(row);
  }
  return state;
}

test('默认预算近满v3：shape编号预留不误拒，真实Worker保留source失败及原键回执', { timeout: 60_000 }, async t => {
  const state = denseDefaultHistory(await seed(t), 1590);
  assert.equal(limits.stateBytes, 2_097_152); assert.ok(nodes(state) < 200_000);
  const before = encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, limits);
  assert.equal(before.format, 'v3'); assert.ok(before.bytes.length > limits.stateBytes * 0.99); before.bytes.fill(0);
  const f = fixture(t, state), prepare = f.source.port.prepare;
  f.source.port.prepare = async (selection, abort) => {
    const value = await prepare(selection, abort); await f.source.port.release(value.handle);
    throw new MobilePlaybackError(409, 'SOURCE_CHANGED', false);
  };
  const session = await f.service.control('createSession', sessionRequest(), currentPrincipal, signal());
  assert.equal(session.status, 201);
  const request = resourceRequest((session.body as MobileSession).id);
  const failed = await f.service.control('createResource', request, currentPrincipal, signal());
  assert.equal(failed.status, 409); assert.equal(f.source.prepares(), 1);
  const saved = f.store.snapshot(), receipt = saved.receipts.find(r => r.request.idempotencyKey === request.idempotencyKey)!;
  assert.equal(receipt.state, 'RECORDED'); assert.equal(receipt.reply!.status, 409); assert.equal(saved.receipts.some(r => r.state === 'UNKNOWN'), false);
  assert.deepEqual(saved.receipts.slice(0, state.receipts.length), state.receipts);
  const writes = f.store.writes.length, replay = await f.service.control('createResource', request, currentPrincipal, signal());
  assert.equal(replay.status, 409); assert.deepEqual(replay.body, receipt.reply!.body);
  assert.equal(f.source.prepares(), 1); assert.equal(f.store.writes.length, writes);
});


test('默认预算v3物理满后v4：真实Worker继续ready201，旧回执及原键保全', { timeout: 120_000 }, async t => {
  const base = await seed(t);
  for (const count of [1590, 1595]) {
    const state = denseDefaultHistory(base, count), f = fixture(t, state);
    const session = await f.service.control('createSession', sessionRequest(), currentPrincipal, signal()); assert.equal(session.status, 201);
    const request = resourceRequest((session.body as MobileSession).id);
    const made = await readyIntent(f, request, currentPrincipal); assert.equal(made.original.status, 201); await made.current.beforeSend();
    assert.equal(f.source.prepares(), 1); const saved = f.store.snapshot();
    assert.deepEqual(saved.receipts.slice(0, state.receipts.length), state.receipts);
    assert.equal(saved.resources.at(-1)!.state, 'ready'); assert.equal(saved.receipts.some(r => r.state === 'UNKNOWN'), false);
    const afterWrites = f.store.writes.length, replay = await f.service.control('createResource', request, currentPrincipal, signal());
    assert.equal(replay.status, 201); assert.deepEqual(replay.body, made.original.body); assert.equal(f.source.prepares(), 1); assert.equal(f.store.writes.length, afterWrites);
    if (count === 1595) {
      const port = realCodec(); t.after(() => port.close());
      const packed = await port.encode(saved, context(saved)); assert.equal(packed.format, 'v5');
      const decoded = await port.decode(packed.bytes, context(saved)); assert.equal(decoded.format, 'v5'); assert.deepEqual(decoded.state, saved);
    }
    await f.service.close();
  }
});

test('播放Worker预算诊断v4：最终物理及终态reserve拒绝映射真实stage，后续及关闭正常', async t => {
  const port = realCodec(); t.after(() => port.close());
  const state = await seed(t), template = state.receipts.find(r => r.operation === 'createResource')!;
  for (let i = 0; i < 8; i++) {
    const r = playbackCopy(template); r.id = `worker-reserve.unknown.${i}`; r.request.idempotencyKey = `worker-reserve.key.${i}`;
    r.keyHash = digest('key', [r.deviceId, r.deviceEpoch, r.request.idempotencyKey]);
    r.state = 'UNKNOWN'; r.reply = null; r.resourceContext = null; state.receipts.push(r);
  }
  let low = 1, high = limits.stateBytes;
  while (low < high) { const middle = Math.floor((low + high) / 2);
    try { encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, { ...limits, stateBytes: middle }); high = middle; }
    catch (error) { assert.ok(errorCode('RESOURCE_BUSY')(error)); low = middle + 1; }
  }
  const admitted = encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, { ...limits, stateBytes: low });
  assert.equal(admitted.format, 'v5'); assert.ok(admitted.bytes.length <= low - 1);
  for (const [input, stateBytes, boundary] of [[empty(), 128, 'v4-physical'], [state, low - 1, 'terminal-v4-reserve']] as const) {
    const records: MobileCapabilityTraceRecord[] = [], reader = createMobileCapabilityTraceReader(record => records.push(record));
    const diagnostic = createMobileCapabilityContext('40000000-0000-4000-8000-000000000001', 'main', 'http', null, signal(), reader)!;
    diagnostic.preparation = true; diagnostic.preparationLimit = 192; diagnostic.resourcePreparation = true; diagnostic.privateContentDiagnostic = true;
    await assert.rejects(withMobileCapabilityContext(diagnostic, () => port.encode(input, { ...context(input), limits: { ...limits, stateBytes } })), error =>
      errorCode('RESOURCE_BUSY')(error) && readCodecRejectionBoundary(error) === boundary);
    const first = records.find(row => row.phase === 'reject' && row.role === 'business');
    assert.equal(first?.stage, `preparation.playback.codec.${boundary}`); assert.equal(first?.code, 'RESOURCE_BUSY');
    assert.ok(records.every(row => Object.keys(row).length === 15)); assert.equal(JSON.stringify(records).includes(ORIGIN), false);
  }
  assert.equal((await port.encode(empty(), context(empty()))).format, 'v1');
});

test('播放Worker预算诊断：严格闭集、不可信错包不入trace、Main准入先于post且默认关闭', async () => {
  for (const boundary of [...PLAYBACK_CODEC_REJECTION_BOUNDARIES, 'unknown', null]) {
    const fake = new FakeWorker(), port = createMobilePlaybackStateCodec({ workerFactory: () => fake as unknown as Worker });
    const flight = port.encode(empty(), context(empty())), job = fake.jobs.at(-1);
    const valid = boundary !== 'unknown' && boundary !== null;
    const rejected = assert.rejects(flight, error => errorCode(valid ? 'RESOURCE_BUSY' : 'BUSY')(error)
      && readCodecRejectionBoundary(error) === (valid ? boundary : null));
    fake.emit('message', { protocol: PLAYBACK_CODEC_PROTOCOL, kind: 'failure', id: job.id, operation: job.operation, binding: job.binding,
      error: { status: 429, code: 'RESOURCE_BUSY', retryable: true, retryAfterMs: 1_000, budgetBoundary: boundary } });
    await rejected;
    if (valid) await port.close(); else await assert.rejects(port.close(), errorCode('BUSY'));
  }
  const fake = new FakeWorker(), port = createMobilePlaybackStateCodec({ workerFactory: () => fake as unknown as Worker });
  const oversized = empty(); (oversized as any).receipts = [{ request: { body: 'x'.repeat(limits.stateBytes + limits.maxReceipts * 8192 + 1) } }];
  const records: MobileCapabilityTraceRecord[] = [], reader = createMobileCapabilityTraceReader(record => records.push(record));
  const diagnostic = createMobileCapabilityContext('40000000-0000-4000-8000-000000000002', 'main', 'http', null, signal(), reader)!;
  // 普通能力上下文没有preparation授权，不出现新增准备旁注。
  await assert.rejects(withMobileCapabilityContext(diagnostic, () => port.encode(oversized, context(empty()))), errorCode('RESOURCE_BUSY'));
  assert.equal(records.length, 0); diagnostic.preparation = true;
  await assert.rejects(withMobileCapabilityContext(diagnostic, () => port.encode(oversized, context(empty()))), errorCode('RESOURCE_BUSY'));
  assert.equal(records.find(row => row.phase === 'reject')?.stage, 'preparation.playback.codec.main-capture');
  assert.equal(fake.jobs.length, 0); await port.close();
});
