import assert from 'node:assert/strict';
import { createMobileResourceCapacityProbe } from '../../src/mobile/resource-capacity-trace.js';
import { closeMobileCapabilityContext, withMobileCapabilityContext, MOBILE_CAPABILITY_TRACE_PREFIX } from '../../src/mobile/capability-trace.js';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import {
  decodeMobileResponse, type MobileDecodedRequest, type MobileObservation, type MobileReadyResource,
  type MobileResourceRequest, type MobileSession,
} from '@music-bridge/contracts';
import { createMobilePlaybackService } from '../../src/mobile/playback-service.js';
import { decodePlaybackStorage, encodePlaybackStorage } from '../../src/mobile/playback-state-codec.js';
import {
  MOBILE_PLAYBACK_DEFAULT_LIMITS, MOBILE_PLAYBACK_TERMINAL_FAILURE_BUDGET, MobilePlaybackError, type MobilePlaybackControlOperation, type MobilePlaybackControlReply,
  type MobilePlaybackLimits, type MobilePlaybackPreparedSource, type MobilePlaybackService, type MobilePlaybackSourcePort, type MobilePlaybackStateCodecPort,
} from '../../src/mobile/playback-types.js';
import { MobileAuthPersistenceError, type MobileAuthCrypto, type MobileAuthPersistence, type MobilePrincipal,
  type MobileSealedSave, type MobileSealedState } from '../../src/mobile/types.js';

// 本文件是逻辑 actor 的受控端口测试。AES 是真实算法；端口数据不是 Parser/FD/真机证据。
const ORIGIN = 'https://127.0.0.1:43123', SERVER = 'server-1', DATASET = 'dataset-1';

test('容量首拒旁注区分新scope遇到原回执满、历史resource满、live与迟到flight，不改业务拒绝', async t => {
  for (const kind of ['receipts', 'stored', 'live', 'flight'] as const) await t.test(kind, async t => {
    const f = fixture(t, kind === 'receipts' ? { maxReceipts: 2 } : kind === 'stored' ? { maxStoredResources: 1, maxLiveResources: 1 }
      : { maxLiveResources: 1, ...(kind === 'flight' ? { prepareTimeoutMs: 15, readyWaitMs: 1 } : {}) });
    const first = await createSession(f.actor);
    if (kind === 'stored' || kind === 'live') {
      const resource = await ready(f.actor, first);
      if (kind === 'stored') await call(f.actor, 'releaseResource', request('releaseResource', null, first.id, resource.id));
    } else if (kind === 'flight') {
      f.sources.prepareGate = deferred<void>();
      const failed = await call(f.actor, 'createResource', request('createResource', resourceRequest(), first.id, undefined, 'late-flight'));
      assert.equal(failed.status, 429); assert.equal(f.sources.handles.size, 1);
    }
    const second = await createSession(f.actor, 'new-scope');
    const lines: string[] = [], capacity = createMobileResourceCapacityProbe({ enabled: true, sink: line => lines.push(line) });
    const context = capacity.claim('11111111-1111-4111-8111-111111111111', 'main', 'http'); assert.ok(context);
    const prepares = f.sources.prepares;
    await code(withMobileCapabilityContext(context, () => call(f.actor, 'createResource',
      request('createResource', resourceRequest('new-track'), second.id, undefined, 'rejected-new-scope'))), 'RESOURCE_BUSY', 429);
    assert.equal(f.sources.prepares, prepares, '准确准入guard命中后不得调用来源');
    const records = lines.map(line => JSON.parse(line.slice(MOBILE_CAPABILITY_TRACE_PREFIX.length)));
    assert.deepEqual(records.map(row => row.stage), [{ receipts: 'capacity.actor.receipts-full', stored: 'capacity.actor.stored-resources-full',
      live: 'capacity.actor.live-resources-full', flight: 'capacity.actor.live-flights-full' }[kind]]);
    assert.equal(records[0].code, 'RESOURCE_BUSY'); closeMobileCapabilityContext(context);
  });
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) { assert.ok(Date.now() < deadline, '有限等待没有得到实际端口事件'); await delay(2); }
}
function controlledCrypto(): MobileAuthCrypto {
  const key = randomBytes(32);
  return {
    seal(plain, aad) { const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(aad);
      return Buffer.concat([nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]); },
    open(sealed, aad) { const b = Buffer.from(sealed), decipher = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
      decipher.setAAD(aad); decipher.setAuthTag(b.subarray(-16)); return Buffer.concat([decipher.update(b.subarray(12, -16)), decipher.final()]); },
  };
}
class ControlledPersistence implements MobileAuthPersistence {
  value: MobileSealedState = { kind: 'missing', datasetId: DATASET, revision: 0 };
  saves = 0; loads = 0;
  next: 'none' | 'not-sent' | 'unknown-committed' | 'unknown-missing' = 'none';
  async load(datasetId: string): Promise<MobileSealedState> {
    this.loads++; assert.equal(datasetId, DATASET);
    return this.value.kind === 'missing' ? { ...this.value } : { ...this.value, sealed: new Uint8Array(this.value.sealed) };
  }
  async save(request: MobileSealedSave) {
    this.saves++; assert.equal(request.datasetId, DATASET);
    const fault = this.next; this.next = 'none';
    if (fault === 'not-sent') throw new MobileAuthPersistenceError('not-sent');
    if (fault === 'unknown-missing') throw new MobileAuthPersistenceError('unknown');
    if (request.expectedRevision !== this.value.revision) return { kind: 'conflict' as const, datasetId: DATASET, currentRevision: this.value.revision };
    this.value = { kind: 'sealed', datasetId: DATASET, revision: request.expectedRevision + 1, commitId: request.commitId, sealed: new Uint8Array(request.sealed) };
    if (fault === 'unknown-committed') throw new MobileAuthPersistenceError('unknown');
    return { kind: 'saved' as const, datasetId: DATASET, revision: this.value.revision, commitId: request.commitId };
  }
}
class ControlledSources implements MobilePlaybackSourcePort {
  readonly data = Uint8Array.from({ length: 200_017 }, (_, i) => i % 251);
  readonly handles = new Map<string, MobilePlaybackPreparedSource>();
  readonly reads = new Map<string, { handle: string; offsets: number[] }>();
  prepares = 0; verifies = 0; renews = 0; releases = 0; readCalls = 0; closeReads = 0;
  prepareGate: ReturnType<typeof deferred<void>> | undefined;
  verifyGate: ReturnType<typeof deferred<void>> | undefined;
  readGate: ReturnType<typeof deferred<void>> | undefined;
  releaseGate: ReturnType<typeof deferred<void>> | undefined;
  prepareFailure: unknown;
  changed = false;
  async prepare(request: { resourceId: string; trackId: string; versionId: string; contentRevision: string }, _signal: AbortSignal) {
    this.prepares++; assert.equal(request.versionId, 'version-1'); assert.equal(request.contentRevision, 'content-1');
    if (this.prepareFailure !== undefined) throw this.prepareFailure;
    const source: MobilePlaybackPreparedSource = { handle: `handle-${request.resourceId}`,
      sourceAudio: { codec: 'pcm_s16le', container: 'wav', sampleRateHz: 44_100, bitsPerSample: 16, channels: 2 },
      actualAudio: { codec: 'pcm_s16le', container: 'wav', sampleRateHz: 44_100, bitsPerSample: 16, channels: 2 },
      processing: { mode: 'direct', reason: '受控端口的原样字节', fromPreparedCache: false },
      contentType: 'audio/wav', size: this.data.length, durationMs: 4_000, seekable: true };
    this.handles.set(source.handle, source); if (this.prepareGate) await this.prepareGate.promise;
    return structuredClone(source);
  }
  async verify(handle: string) {
    this.verifies++; if (this.verifyGate) await this.verifyGate.promise;
    if (!this.handles.has(handle) || this.changed) throw new MobilePlaybackError(409, 'SOURCE_CHANGED');
  }
  async renew(handle: string) { assert.ok(this.handles.has(handle)); this.renews++; }
  async read(handle: string, readId: string, start: number, maxBytes: number, _signal: AbortSignal) {
    assert.ok(this.handles.has(handle)); assert.ok(maxBytes > 0 && maxBytes <= 65_536); this.readCalls++;
    const prior = this.reads.get(readId); if (prior) assert.equal(prior.handle, handle);
    const current = prior ?? { handle, offsets: [] }; current.offsets.push(start); this.reads.set(readId, current);
    // 特意允许晚回包，以证明 actor 在收包后仍拒绝发送已撤销字节。
    if (this.readGate) await this.readGate.promise;
    return this.data.slice(start, start + maxBytes);
  }
  async closeRead(_handle: string, readId: string) { this.closeReads++; this.reads.delete(readId); }
  async release(handle: string) {
    if (this.releaseGate) await this.releaseGate.promise;
    assert.equal([...this.reads.values()].filter(v => v.handle === handle).length, 0);
    if (this.handles.delete(handle)) this.releases++;
  }
}
function principal(deviceId = 'device-1', epoch = 1, generation = 1): MobilePrincipal {
  return Object.freeze({ serverId: SERVER, deviceId, datasetId: DATASET, accountDomain: `local:${DATASET}`,
    deviceEpoch: epoch, generation, accessTokenHash: 'a'.repeat(64), accessExpiresAt: '2030-01-01T00:00:00.000Z' });
}
function fixture(t: TestContext, limits?: Partial<MobilePlaybackLimits>, stateCodec?: MobilePlaybackStateCodecPort) {
  let now = Date.parse('2026-10-09T00:00:00.000Z');
  const persistence = new ControlledPersistence(), crypto = controlledCrypto(), sources = new ControlledSources();
  const devices = new Map([['device-1', 1], ['device-2', 1]]), actors: MobilePlaybackService[] = [];
  const create = () => {
    const actor = createMobilePlaybackService({ serverId: SERVER, datasetId: DATASET, responseOrigin: ORIGIN,
      auth: { async assertDeviceCurrent(deviceId, epoch) { if (devices.get(deviceId) !== epoch) throw new Error('受控设备已撤销'); } },
      persistence, crypto, sourcePort: sources, nowMs: () => now, ...(limits ? { limits } : {}), ...(stateCodec ? { stateCodec } : {}) }); actors.push(actor); return actor;
  };
  const actor = create();
  t.after(async () => { sources.prepareGate?.resolve(); sources.verifyGate?.resolve(); sources.readGate?.resolve(); sources.releaseGate?.resolve();
    for (const a of actors) await a.close(); assert.equal(sources.handles.size, 0); assert.equal(sources.reads.size, 0); });
  return { actor, create, persistence, crypto, sources, devices, now: () => now, advance: (ms: number) => { now += ms; } };
}
const resourceRequest = (trackId = 'track-1'): MobileResourceRequest => ({ trackId, versionId: 'version-1', contentRevision: 'content-1',
  quality: { profile: 'lossless', allowLossyFallback: false, preferredTransport: 'file' },
  formats: [{ codec: 'pcm_s16le', container: 'wav', maxSampleRateHz: 48_000, maxChannels: 2, maxBitsPerSample: 16 }] });
function request(operation: MobilePlaybackControlOperation, body: unknown = null, sessionId?: string, resourceId?: string, key?: string): MobileDecodedRequest<unknown> {
  const base = '/mobile/v1/sessions';
  const path = operation === 'createSession' ? base : operation === 'reportObservation' ? `${base}/${sessionId}/observation`
    : operation === 'createResource' ? `${base}/${sessionId}/resources`
      : ['getResource', 'releaseResource', 'renewResource'].includes(operation)
        ? `${base}/${sessionId}/resources/${resourceId}${operation === 'renewResource' ? '/renew' : ''}` : `${base}/${sessionId}`;
  const pathParameters: Record<string, string> = operation === 'createSession' ? {} : ['getResource', 'releaseResource', 'renewResource'].includes(operation)
    ? { sessionId: sessionId!, resourceId: resourceId! } : { sessionId: sessionId! };
  return { path, pathParameters, query: {}, body, ...(key ? { idempotencyKey: key } : {}) };
}
function mediaRequest(resource: MobileReadyResource): MobileDecodedRequest<unknown> {
  const url = new URL(resource.media.url);
  return { path: url.pathname, pathParameters: { resourceId: resource.id, asset: 'source' }, query: { ticket: url.searchParams.get('ticket')! }, body: null };
}
const call = (a: MobilePlaybackService, operation: MobilePlaybackControlOperation, r: MobileDecodedRequest<unknown>, p = principal()) =>
  a.control(operation, r, p, new AbortController().signal);
async function createSession(a: MobilePlaybackService, key = 'session-key', p = principal()): Promise<MobileSession> {
  const result = await call(a, 'createSession', request('createSession', { clientInstanceId: `client-${p.deviceId}` }, undefined, undefined, key), p);
  assert.equal(result.status, 201); assert.ok(result.body && 'deviceId' in result.body); return result.body as MobileSession;
}
async function ready(a: MobilePlaybackService, s: MobileSession, key = 'resource-key', p = principal()): Promise<MobileReadyResource> {
  const result = await call(a, 'createResource', request('createResource', resourceRequest(), s.id, undefined, key), p);
  assert.equal(result.status, 201); assert.ok(result.body && 'state' in result.body && result.body.state === 'ready'); return result.body as MobileReadyResource;
}
async function code(promise: Promise<unknown>, expected: string, status: number): Promise<void> {
  await assert.rejects(promise, error => error instanceof MobilePlaybackError && error.code === expected && error.status === status);
}
function checkedWire(operation: 'createResource' | 'renewResource', reply: MobilePlaybackControlReply): void {
  // 与生产 encodeMobileJsonReply 一致：wire 只收普通 Uint8Array，Node Buffer 子类仍拒绝。
  assert.ok(reply.resourceContext); const body = new TextEncoder().encode(JSON.stringify(reply.body));
  const result = decodeMobileResponse(operation, { status: reply.status, headers: [['Content-Type', 'application/json']], body,
    finalUrl: `${ORIGIN}${operation === 'createResource' ? `/mobile/v1/sessions/${reply.resourceContext.scope.sessionId}/resources`
      : `/mobile/v1/sessions/${reply.resourceContext.scope.sessionId}/resources/${reply.resourceContext.expectedResourceId}/renew`}` },
  { responseOrigin: ORIGIN, requestPath: operation === 'createResource' ? `/mobile/v1/sessions/${reply.resourceContext.scope.sessionId}/resources`
    : `/mobile/v1/sessions/${reply.resourceContext.scope.sessionId}/resources/${reply.resourceContext.expectedResourceId}/renew`, resource: reply.resourceContext });
  assert.equal(result.ok, true, result.ok ? undefined : JSON.stringify(result.issue));
  const invalidBytes = decodeMobileResponse(operation, { status: reply.status, headers: [['Content-Type', 'application/json']], body: Buffer.from(body),
    finalUrl: `${ORIGIN}${operation === 'createResource' ? `/mobile/v1/sessions/${reply.resourceContext.scope.sessionId}/resources`
      : `/mobile/v1/sessions/${reply.resourceContext.scope.sessionId}/resources/${reply.resourceContext.expectedResourceId}/renew`}` },
  { responseOrigin: ORIGIN, requestPath: operation === 'createResource' ? `/mobile/v1/sessions/${reply.resourceContext.scope.sessionId}/resources`
    : `/mobile/v1/sessions/${reply.resourceContext.scope.sessionId}/resources/${reply.resourceContext.expectedResourceId}/renew`, resource: reply.resourceContext });
  assert.equal(invalidBytes.ok, false);
  if (!invalidBytes.ok) assert.deepEqual(invalidBytes.issue, { code: 'INVALID_RESPONSE', field: 'response' });
}

function persistedPlayback(f: ReturnType<typeof fixture>) {
  const value = f.persistence.value;
  assert.equal(value.kind, 'sealed');
  if (value.kind !== 'sealed') throw new Error('受控播放状态尚未持久化');
  const plain = f.crypto.open(value.sealed, Buffer.from(JSON.stringify(['MBM002_PLAYBACK_STATE_V1', SERVER, DATASET, value.revision])));
  try { return decodePlaybackStorage(plain, SERVER, DATASET, ORIGIN, MOBILE_PLAYBACK_DEFAULT_LIMITS).state; }
  finally { plain.fill(0); }
}

test('expire零变化的控制与周期扫描不序列化整本历史，accepted观察仍逐次持久化', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture(t), s = await createSession(f.actor), r = await ready(f.actor, s);
  await until(() => f.actor.resourceSnapshot().preparing === 0);
  const original = JSON.stringify, before = structuredClone(f.persistence.value), saves = f.persistence.saves, loads = f.persistence.loads;
  let ledgerSerializations = 0;
  const observedStringify = function (value: unknown, ...rest: unknown[]) {
    if (value !== null && typeof value === 'object' && 'schema' in value
      && value.schema === 'musicbridge.mobile002.playback-state.v1') ledgerSerializations++;
    return Reflect.apply(original, JSON, [value, ...rest]);
  };
  t.mock.method(JSON, 'stringify', observedStringify);
  for (let i = 0; i < 3; i++) {
    f.advance(1); t.mock.timers.tick(1_000);
    assert.equal((await call(f.actor, 'getSession', request('getSession', null, s.id))).status, 200);
  }
  // 用确定的工作量计数代替耗时阈值；每次扫描均不得遍历序列化历史回执。
  assert.equal(ledgerSerializations, 0);
  assert.equal(f.persistence.saves, saves); assert.equal(f.persistence.loads, loads);
  assert.deepEqual(f.persistence.value, before);
  const observation: MobileObservation = { sequence: 1, playerGeneration: 1, queueItemId: 'expire-queue',
    resourceId: r.id, trackId: r.trackId, positionMs: 100, state: 'playing' };
  const observe = () => call(f.actor, 'reportObservation', request('reportObservation', observation, s.id));
  assert.deepEqual((await observe()).body, { acceptedSequence: 1, accepted: true });
  assert.equal(f.persistence.saves, saves + 1);
  const committed = persistedPlayback(f).sessions.find(value => value.id === s.id)!;
  assert.equal(committed.lastSequence, 1); assert.deepEqual(committed.observation, observation);
  ledgerSerializations = 0;
  assert.deepEqual((await observe()).body, { acceptedSequence: 1, accepted: false });
  assert.equal(ledgerSerializations, 0); assert.equal(f.persistence.saves, saves + 1);
});

test('expire会话精确到期优先终止资源，等待原保存ACK且保留原201回执', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture(t, { sessionTtlMs: 1_000, resourceTtlMs: 1_000, ticketTtlMs: 1_000,
    maximumResourceLifetimeMs: 1_000, orphanResourceMs: 1_000 });
  const intent = request('createSession', { clientInstanceId: 'expire-client' }, undefined, undefined, 'expire-session');
  const first = await call(f.actor, 'createSession', intent), s = first.body as MobileSession, r = await ready(f.actor, s);
  await until(() => f.actor.resourceSnapshot().preparing === 0);
  const media = await f.actor.openMedia('headMediaAsset', mediaRequest(r), new AbortController().signal); await media.close();
  const before = persistedPlayback(f), saves = f.persistence.saves;
  f.advance(999); assert.equal((await call(f.actor, 'getSession', request('getSession', null, s.id))).status, 200);
  assert.equal(f.persistence.saves, saves);
  const gate = deferred<void>(), save = f.persistence.save.bind(f.persistence);
  let posted = false, settled = false;
  t.mock.method(f.persistence, 'save', async (value: MobileSealedSave) => { posted = true; await gate.promise; return save(value); });
  f.advance(1);
  const expiring = call(f.actor, 'getSession', request('getSession', null, s.id))
    .then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
  try {
    await until(() => posted);
    assert.equal(settled, false, 'Owner尚未确认保存时不能结算本次到期请求');
    assert.equal(media.resourceAbortSignal.aborted, true);
    assert.deepEqual(persistedPlayback(f), before);
  } finally { gate.resolve(); }
  const outcome = await expiring;
  assert.ok('error' in outcome && outcome.error instanceof MobilePlaybackError
    && outcome.error.status === 410 && outcome.error.code === 'SESSION_EXPIRED');
  assert.equal(f.persistence.saves, saves + 1);
  const after = persistedPlayback(f);
  assert.equal(after.sessions.find(value => value.id === s.id)!.terminal, 'SESSION_EXPIRED');
  const terminal = after.resources.find(value => value.id === r.id)!;
  assert.equal(terminal.state, 'terminal'); assert.equal(terminal.failure, 'SESSION_EXPIRED');
  assert.equal(terminal.media, null); assert.deepEqual(after.receipts, before.receipts);
  assert.deepEqual((await call(f.actor, 'createSession', intent)).body, first.body);
  assert.equal(f.persistence.saves, saves + 1); await until(() => f.sources.handles.size === 0);
});

test('expire资源TTL、续期硬上限与runtime活动孤儿期限保持原精确边界', async t => {
  const scenarios: { name: string; limits: Partial<MobilePlaybackLimits>; edge: number; activity?: 'renew' | 'read' }[] = [
    { name: '资源TTL', limits: { resourceTtlMs: 1_000, ticketTtlMs: 1_000 }, edge: 1_000 },
    { name: '续期仍受硬上限约束', limits: { resourceTtlMs: 600, ticketTtlMs: 500, maximumResourceLifetimeMs: 1_000 }, edge: 1_000, activity: 'renew' },
    { name: '孤儿期限使用runtime新活动而非旧持久时间', limits: { orphanResourceMs: 1_000 }, edge: 1_500, activity: 'read' },
  ];
  for (const scenario of scenarios) await t.test(scenario.name, async child => {
    child.mock.timers.enable({ apis: ['setInterval'] });
    const f = fixture(child, scenario.limits), started = f.now(), s = await createSession(f.actor), r = await ready(f.actor, s);
    await until(() => f.actor.resourceSnapshot().preparing === 0);
    if (scenario.activity) {
      f.advance(500);
      if (scenario.activity === 'renew') {
        assert.equal((await call(f.actor, 'renewResource', request('renewResource', {}, s.id, r.id, 'expire-renew'))).status, 200);
        const stored = persistedPlayback(f).resources.find(value => value.id === r.id)!;
        assert.equal(stored.expiresAt, started + 1_000); assert.equal(stored.hardExpiresAt, started + 1_000);
      } else {
        const media = await f.actor.openMedia('getMediaAsset', mediaRequest(r), new AbortController().signal, { range: 'bytes=0-0' });
        assert.equal((await media.reader!.read()).byteLength, 1); await media.close();
        assert.equal(persistedPlayback(f).resources.find(value => value.id === r.id)!.lastActivityAt, started);
      }
    }
    const before = persistedPlayback(f), saves = f.persistence.saves;
    f.advance(started + scenario.edge - 1 - f.now());
    assert.equal((await call(f.actor, 'getResource', request('getResource', null, s.id, r.id))).status, 200);
    assert.equal(f.persistence.saves, saves);
    f.advance(1); await code(call(f.actor, 'getResource', request('getResource', null, s.id, r.id)), 'RESOURCE_EXPIRED', 410);
    assert.equal(f.persistence.saves, saves + 1);
    const after = persistedPlayback(f), terminal = after.resources.find(value => value.id === r.id)!;
    assert.equal(terminal.state, 'terminal'); assert.equal(terminal.failure, 'RESOURCE_EXPIRED'); assert.equal(terminal.media, null);
    assert.equal(after.sessions.find(value => value.id === s.id)!.terminal, null); assert.deepEqual(after.receipts, before.receipts);
    await code(call(f.actor, 'getResource', request('getResource', null, s.id, r.id)), 'RESOURCE_EXPIRED', 410);
    assert.equal(f.persistence.saves, saves + 1); await until(() => f.sources.handles.size === 0);
  });
});

test('会话原201完整回执保持，同key改body或scope拒绝，一设备只占两个会话', async t => {
  const f = fixture(t), firstRequest = request('createSession', { clientInstanceId: 'client-1' }, undefined, undefined, 'key-1');
  const first = await call(f.actor, 'createSession', firstRequest), again = await call(f.actor, 'createSession', firstRequest);
  assert.deepEqual(again.body, first.body); assert.equal(again.status, first.status); assert.equal(f.persistence.saves, 1);
  await code(call(f.actor, 'createSession', request('createSession', { clientInstanceId: 'client-2' }, undefined, undefined, 'key-1')), 'IDEMPOTENCY_CONFLICT', 409);
  const s = first.body as MobileSession; await createSession(f.actor, 'key-2');
  await code(createSession(f.actor, 'key-3'), 'RESOURCE_BUSY', 429);
  await code(call(f.actor, 'getSession', request('getSession', null, s.id), principal('device-2')), 'INVALID_REQUEST', 404);
  assert.equal((await call(f.actor, 'closeSession', request('closeSession', null, s.id))).status, 204);
  assert.equal((await call(f.actor, 'closeSession', request('closeSession', null, s.id))).status, 204);
  assert.deepEqual((await call(f.actor, 'createSession', firstRequest)).body, first.body);
  await code(call(f.actor, 'getSession', request('getSession', null, s.id)), 'SESSION_CLOSED', 410);
});

test('ready来源实际端口确认后才201，GET完整块和HEAD/Range有独立readId且全部关闭', async t => {
  const f = fixture(t), s = await createSession(f.actor), r = await ready(f.actor, s);
  assert.equal(f.sources.prepares, 1); assert.equal(f.sources.renews, 1);
  const head = await f.actor.openMedia('headMediaAsset', mediaRequest(r), new AbortController().signal, { range: 'bytes=2-4' });
  assert.equal(head.status, 200); assert.equal(head.reader, null); assert.equal(Object.fromEntries(head.headers)['Content-Length'], String(f.sources.data.length)); await head.close();
  const full = await f.actor.openMedia('getMediaAsset', mediaRequest(r), new AbortController().signal);
  await full.beforeSend(); const chunks: Uint8Array[] = []; for await (const chunk of full.reader!) { assert.ok(chunk.length <= 65_536); chunks.push(chunk); }
  assert.deepEqual(Buffer.concat(chunks), Buffer.from(f.sources.data));
  const range = await f.actor.openMedia('getMediaAsset', mediaRequest(r), new AbortController().signal, { range: 'bytes=51-128' });
  const rangeBytes: Uint8Array[] = []; for await (const chunk of range.reader!) rangeBytes.push(chunk);
  assert.equal(range.status, 206); assert.deepEqual(Buffer.concat(rangeBytes), Buffer.from(f.sources.data.slice(51, 129)));
  assert.notEqual(full.reader!.readId, range.reader!.readId);
  const invalid = await f.actor.openMedia('getMediaAsset', mediaRequest(r), new AbortController().signal, { range: 'bytes=0-1,4-5' }); assert.equal(invalid.status, 400); assert.equal(invalid.reader, null);
  const outside = await f.actor.openMedia('getMediaAsset', mediaRequest(r), new AbortController().signal, { range: `bytes=${f.sources.data.length}-` }); assert.equal(outside.status, 416);
  const fallback = await f.actor.openMedia('getMediaAsset', mediaRequest(r), new AbortController().signal, { range: 'bytes=0-1', ifRange: 'untrusted-etag' }); assert.equal(fallback.status, 200); await fallback.close();
  const allowedHeaders = new Set(['cache-control', 'accept-ranges', 'content-length', 'content-type', 'content-range']);
  for (const response of [head, full, range, invalid, outside, fallback]) {
    const names = response.headers.map(([name]) => name.toLowerCase());
    assert.ok(names.every(name => allowedHeaders.has(name))); assert.equal(new Set(names).size, names.length);
    assert.equal(names.includes('x-content-type-options'), false, 'nosniff 由正式 sender 添加，Core 不重复提供');
  }
  assert.equal((await call(f.actor, 'releaseResource', request('releaseResource', null, s.id, r.id))).status, 204);
  assert.equal(f.sources.handles.size, 0); assert.equal(f.actor.resourceSnapshot().readers, 0); assert.equal(f.actor.resourceSnapshot().liveResources, 0);
});

test('异步验证产生原202，完成后GET ready，但所有原回执字段仍原样且不二次prepare', async t => {
  const f = fixture(t); f.sources.verifyGate = deferred<void>(); const s = await createSession(f.actor);
  const r = request('createResource', resourceRequest(), s.id, undefined, 'async-key');
  const first = await call(f.actor, 'createResource', r); assert.equal(first.status, 202); checkedWire('createResource', first);
  assert.ok(first.body && 'id' in first.body); const id = first.body.id;
  f.sources.verifyGate.resolve(); await until(() => f.actor.resourceSnapshot().preparing === 0);
  const current = await call(f.actor, 'getResource', request('getResource', null, s.id, id)); assert.ok(current.body && 'state' in current.body && current.body.state === 'ready');
  f.advance(61_000); const replay = await call(f.actor, 'createResource', r); assert.equal(replay.status, 202); assert.deepEqual(replay.body, first.body);
  assert.deepEqual(replay.resourceContext, first.resourceContext); checkedWire('createResource', replay); assert.equal(f.sources.prepares, 1);
});

test('准备事实合并提交：直通仍先持久UNKNOWN，完整ready事实只随终态ACK发布', async t => {
  const f = fixture(t), s = await createSession(f.actor), before = f.persistence.saves;
  const originalPrepare = f.sources.prepare.bind(f.sources);
  t.mock.method(f.sources, 'prepare', async (input: Parameters<ControlledSources['prepare']>[0], signal: AbortSignal) => {
    const saved = persistedPlayback(f), receipt = saved.receipts.find(value => value.operation === 'createResource');
    assert.equal(receipt?.state, 'UNKNOWN'); assert.equal(receipt?.reply, null);
    assert.equal(saved.resources[0]?.source, null);
    return originalPrepare(input, signal);
  });
  const intent = request('createResource', resourceRequest(), s.id, undefined, 'combined-facts-ready');
  const first = await call(f.actor, 'createResource', intent); checkedWire('createResource', first);
  assert.equal(first.status, 201); assert.ok(first.body && 'state' in first.body && first.body.state === 'ready');
  const saved = persistedPlayback(f);
  assert.equal(saved.resources[0]?.state, 'ready'); assert.ok(saved.resources[0]?.source && 'actualAudio' in saved.resources[0].source);
  assert.equal(saved.receipts.at(-1)?.state, 'RECORDED');
  assert.equal(f.persistence.saves - before, 2, '同一成功准备只写UNKNOWN与包含完整来源事实的ready终态');
  const replay = await call(f.actor, 'createResource', intent);
  assert.equal(replay.status, first.status); assert.deepEqual(replay.body, first.body);
  assert.deepEqual(replay.resourceContext, first.resourceContext); assert.equal(f.sources.prepares, 1);
});

test('准备事实合并提交：慢验证的202包含已ACK事实，后续ready不改原幂等回执', async t => {
  const f = fixture(t), s = await createSession(f.actor), before = f.persistence.saves;
  f.sources.verifyGate = deferred<void>();
  const intent = request('createResource', resourceRequest(), s.id, undefined, 'combined-facts-preparing');
  const first = await call(f.actor, 'createResource', intent); checkedWire('createResource', first);
  assert.equal(first.status, 202);
  const preparing = persistedPlayback(f);
  assert.equal(preparing.resources[0]?.state, 'preparing'); assert.ok(preparing.resources[0]?.source && 'actualAudio' in preparing.resources[0].source);
  assert.equal(preparing.receipts.at(-1)?.state, 'RECORDED');
  assert.equal(f.persistence.saves - before, 2, '202与来源事实必须在同一次提交，不额外写事实');
  f.sources.verifyGate.resolve(); await until(() => f.actor.resourceSnapshot().preparing === 0);
  assert.equal(persistedPlayback(f).resources[0]?.state, 'ready');
  const replay = await call(f.actor, 'createResource', intent);
  assert.deepEqual(replay.body, first.body); assert.deepEqual(replay.resourceContext, first.resourceContext);
  assert.equal(replay.status, 202); assert.equal(f.sources.prepares, 1);
  assert.equal(f.persistence.saves - before, 3);
});

test('准备事实合并提交：验证或续期失败仍发布完整failed资源并保存原错误回执', async t => {
  for (const stage of ['verify', 'renew'] as const) await t.test(stage, async t => {
    const f = fixture(t), s = await createSession(f.actor);
    if (stage === 'verify') f.sources.changed = true;
    else t.mock.method(f.sources, 'renew', async () => { throw new MobilePlaybackError(409, 'SOURCE_CHANGED'); });
    const intent = request('createResource', resourceRequest(), s.id, undefined, `combined-failure-${stage}`);
    const first = await call(f.actor, 'createResource', intent);
    assert.equal(first.status, 409);
    await until(() => f.actor.resourceSnapshot().preparing === 0);
    const saved = persistedPlayback(f), resource = saved.resources[0]!;
    assert.equal(resource.state, 'failed'); assert.ok(resource.source && 'actualAudio' in resource.source);
    const observed = await call(f.actor, 'getResource', request('getResource', null, s.id, resource.id));
    assert.equal(observed.status, 200); assert.ok(observed.body && 'state' in observed.body && observed.body.state === 'failed');
    const replay = await call(f.actor, 'createResource', intent);
    assert.equal(replay.status, first.status); assert.deepEqual(replay.body, first.body);
    assert.equal(f.sources.prepares, 1); assert.equal(f.sources.handles.size, 0);
  });
});

test('准备事实合并提交：未发送的事实容量拒绝仍使用原UNKNOWN失败预留，不二次准备', async t => {
  let factCapacityRefusals = 0;
  const codec: MobilePlaybackStateCodecPort = {
    async encode(value, context) {
      if (value.resources.some(resource => resource.state === 'failed' && resource.source !== null)) {
        factCapacityRefusals++; throw new MobilePlaybackError(429, 'RESOURCE_BUSY');
      }
      return encodePlaybackStorage(value, context.serverId, context.datasetId, context.responseOrigin, context.limits, context.terminalFailureBudget);
    },
    async decode(value, context) { return decodePlaybackStorage(value, context.serverId, context.datasetId, context.responseOrigin, context.limits); },
    async close() {},
  };
  const f = fixture(t, undefined, codec), s = await createSession(f.actor), before = f.persistence.saves;
  f.sources.changed = true;
  const intent = request('createResource', resourceRequest(), s.id, undefined, 'combined-capacity-error');
  const first = await call(f.actor, 'createResource', intent); assert.equal(first.status, 409);
  await until(() => f.actor.resourceSnapshot().preparing === 0);
  assert.equal(factCapacityRefusals, 1); assert.equal(f.persistence.saves - before, 2);
  const saved = persistedPlayback(f);
  assert.equal(saved.resources[0]?.source, null); assert.equal(saved.resources[0]?.state, 'failed');
  assert.equal(saved.receipts.at(-1)?.state, 'RECORDED'); assert.equal(f.actor.resourceSnapshot().pendingPersistence, false);
  assert.equal(f.sources.prepares, 1); assert.equal(f.sources.handles.size, 0);
  const replay = await call(f.actor, 'createResource', intent);
  assert.equal(replay.status, first.status); assert.deepEqual(replay.body, first.body); assert.equal(factCapacityRefusals, 1);
});

test('renew持久后发新票，旧票到原绝对期限退场，refresh代际不退当前device epoch票', async t => {
  const f = fixture(t), s = await createSession(f.actor), r = await ready(f.actor, s); f.advance(30_000);
  const renewRequest = request('renewResource', {}, s.id, r.id, 'renew-1');
  const renewed = await call(f.actor, 'renewResource', renewRequest, principal('device-1', 1, 2)); checkedWire('renewResource', renewed);
  const next = renewed.body as MobileReadyResource; assert.notEqual(next.media.url, r.media.url);
  await (await f.actor.openMedia('headMediaAsset', mediaRequest(r), new AbortController().signal)).close();
  f.advance(30_001); await code(f.actor.openMedia('getMediaAsset', mediaRequest(r), new AbortController().signal), 'TICKET_EXPIRED', 401);
  const current = await f.actor.openMedia('getMediaAsset', mediaRequest(next), new AbortController().signal); await current.close();
  const replay = await call(f.actor, 'renewResource', renewRequest); assert.deepEqual(replay.body, renewed.body); assert.deepEqual(replay.resourceContext, renewed.resourceContext);
  f.advance(300_001); await code(call(f.actor, 'renewResource', request('renewResource', {}, s.id, r.id, 'renew-new')), 'RESOURCE_EXPIRED', 410);
  const originalAgain = await call(f.actor, 'renewResource', renewRequest); assert.deepEqual(originalAgain.body, renewed.body); checkedWire('renewResource', originalAgain);
});

test('原201即使票据到期及release终态仍逐字段可编码回放，当前GET和媒体不复活', async t => {
  const f = fixture(t), s = await createSession(f.actor), r = request('createResource', resourceRequest(), s.id, undefined, 'original-1');
  const first = await call(f.actor, 'createResource', r); checkedWire('createResource', first); const readyBody = first.body as MobileReadyResource;
  f.advance(61_000); const expiredTicketState = await call(f.actor, 'getResource', request('getResource', null, s.id, readyBody.id));
  assert.ok(expiredTicketState.body && 'state' in expiredTicketState.body && expiredTicketState.body.state === 'failed');
  const replayExpired = await call(f.actor, 'createResource', r); assert.deepEqual(replayExpired.body, first.body); checkedWire('createResource', replayExpired);
  const del = request('releaseResource', null, s.id, readyBody.id); assert.equal((await call(f.actor, 'releaseResource', del)).status, 204);
  assert.equal((await call(f.actor, 'releaseResource', del)).status, 204);
  const replayClosed = await call(f.actor, 'createResource', r); assert.deepEqual(replayClosed.body, first.body); assert.deepEqual(replayClosed.resourceContext, first.resourceContext); checkedWire('createResource', replayClosed);
  await code(call(f.actor, 'getResource', request('getResource', null, s.id, readyBody.id)), 'RESOURCE_RELEASED', 410);
  assert.equal(f.sources.prepares, 1); assert.equal(f.sources.releases, 1);
});

test('观察序号和代际及完整资源归属挡住旧歌晚回报，不续期也不关闭新资源', async t => {
  const f = fixture(t), s = await createSession(f.actor), one = await ready(f.actor, s, 'resource-one');
  const twoReply = await call(f.actor, 'createResource', request('createResource', resourceRequest('track-2'), s.id, undefined, 'resource-two'));
  const two = twoReply.body as MobileReadyResource;
  const observe = (value: MobileObservation) => call(f.actor, 'reportObservation', request('reportObservation', value, s.id));
  const initial: MobileObservation = { sequence: 1, playerGeneration: 7, queueItemId: 'queue-one', resourceId: one.id, trackId: one.trackId, positionMs: 100, state: 'playing' };
  assert.deepEqual((await observe(initial)).body, { acceptedSequence: 1, accepted: true });
  assert.deepEqual((await observe(initial)).body, { acceptedSequence: 1, accepted: false });
  const next = { ...initial, sequence: 2, playerGeneration: 8, queueItemId: 'queue-two', resourceId: two.id, trackId: two.trackId };
  assert.deepEqual((await observe(next)).body, { acceptedSequence: 2, accepted: true });
  assert.deepEqual((await observe({ ...initial, sequence: 9, state: 'ended' })).body, { acceptedSequence: 2, accepted: false });
  await code(observe({ ...next, sequence: 3, trackId: 'other-track' }), 'INVALID_REQUEST', 404);
  assert.deepEqual((await observe({ ...next, sequence: 3, state: 'ended' })).body, { acceptedSequence: 3, accepted: true });
  assert.deepEqual((await observe({ ...next, sequence: 4, state: 'playing' })).body, { acceptedSequence: 3, accepted: false });
  assert.equal(f.sources.releases, 0); assert.equal(f.sources.renews, 2);
});

test('每HTTP读身份独立，槽满不偷释放，seek取消只收读请求不DELETE资源', async t => {
  const f = fixture(t, { maxReads: 1, maxReadsPerResource: 1 }), s = await createSession(f.actor), r = await ready(f.actor, s);
  const first = await f.actor.openMedia('getMediaAsset', mediaRequest(r), new AbortController().signal, { range: 'bytes=80-100' });
  await code(f.actor.openMedia('getMediaAsset', mediaRequest(r), new AbortController().signal), 'RESOURCE_BUSY', 429);
  assert.deepEqual(await first.reader!.read(), f.sources.data.slice(80, 101)); await first.close(); assert.equal(f.sources.releases, 0);
  const controller = new AbortController(), second = await f.actor.openMedia('getMediaAsset', mediaRequest(r), controller.signal, { range: 'bytes=40-60' });
  assert.notEqual(first.reader!.readId, second.reader!.readId); controller.abort(); await second.close();
  assert.equal(f.sources.handles.size, 1); assert.equal(f.actor.resourceSnapshot().readers, 0);
  assert.ok((await call(f.actor, 'getResource', request('getResource', null, s.id, r.id))).body);
  const absolute = await f.actor.openMedia('getMediaAsset', mediaRequest(r), new AbortController().signal);
  f.sources.readGate = deferred<void>(); const late = absolute.reader!.read().then(value => ({ value }), error => ({ error }));
  await until(() => f.sources.readCalls === 2); f.advance(60_001); f.sources.readGate.resolve();
  const afterDeadline = await late; assert.ok('error' in afterDeadline); await absolute.close();
  assert.equal(f.sources.reads.size, 0); assert.equal(f.sources.handles.size, 1);
});

test('设备撤销同步封runtime signal，晚读回复无字节；另一设备和其资源不被释放', async t => {
  const f = fixture(t), s = await createSession(f.actor), one = await ready(f.actor, s);
  const otherPrincipal = principal('device-2'), otherSession = await createSession(f.actor, 'other-session', otherPrincipal), other = await ready(f.actor, otherSession, 'other-resource', otherPrincipal);
  const media = await f.actor.openMedia('getMediaAsset', mediaRequest(one), new AbortController().signal); f.sources.readGate = deferred<void>();
  const read = media.reader!.read().then(value => ({ value }), error => ({ error })); await until(() => f.sources.readCalls === 1);
  f.devices.delete('device-1'); const revoke = f.actor.revokeDevice('device-1'); assert.equal(media.resourceAbortSignal.aborted, true);
  f.sources.readGate.resolve(); const outcome = await read; assert.ok('error' in outcome); await revoke;
  await code(call(f.actor, 'getSession', request('getSession', null, s.id)), 'DEVICE_REVOKED', 403);
  // 同设备的新配对epoch仍看到准确撤销错误；另一设备始终不能探知这个会话。
  f.devices.set('device-1', 2);
  await code(call(f.actor, 'getSession', request('getSession', null, s.id), principal('device-1', 2)), 'DEVICE_REVOKED', 403);
  await code(call(f.actor, 'getSession', request('getSession', null, s.id), otherPrincipal), 'INVALID_REQUEST', 404);
  const retained = await f.actor.openMedia('headMediaAsset', mediaRequest(other), new AbortController().signal); assert.equal(retained.status, 200); await retained.close();
  assert.equal(f.sources.handles.size, 1); assert.equal(f.actor.resourceSnapshot().readers, 0);
});

test('UNKNOWN已提交仅load原commit取得原回执；UNKNOWN未提交不重save，not-sent可用原意图重试', async t => {
  const committed = fixture(t); committed.persistence.next = 'unknown-committed';
  const r = request('createSession', { clientInstanceId: 'unknown-client' }, undefined, undefined, 'unknown-key');
  await code(call(committed.actor, 'createSession', r), 'BUSY', 503); assert.equal(committed.actor.resourceSnapshot().pendingPersistence, true);
  const recovered = await call(committed.actor, 'createSession', r); assert.equal(recovered.status, 201); assert.equal(committed.persistence.saves, 1); assert.equal(committed.sources.prepares, 0);
  const absent = fixture(t); absent.persistence.next = 'unknown-missing'; await code(call(absent.actor, 'createSession', r), 'BUSY', 503);
  await code(call(absent.actor, 'createSession', r), 'BUSY', 503); assert.equal(absent.persistence.saves, 1); assert.equal(absent.sources.prepares, 0);
  const notSent = fixture(t); notSent.persistence.next = 'not-sent'; await code(call(notSent.actor, 'createSession', r), 'BUSY', 503);
  assert.equal(notSent.actor.resourceSnapshot().pendingPersistence, false); assert.equal((await call(notSent.actor, 'createSession', r)).status, 201);
});

test('冷重开只恢复逻辑与原201回执，原live资源SERVICE_RESTARTED且不重开handle或旧票', async t => {
  const f = fixture(t), s = await createSession(f.actor), original = request('createResource', resourceRequest(), s.id, undefined, 'cold-resource');
  const first = await call(f.actor, 'createResource', original), r = first.body as MobileReadyResource; await f.actor.close();
  const cold = f.create(); assert.equal((await call(cold, 'getSession', request('getSession', null, s.id))).status, 200);
  const replay = await call(cold, 'createResource', original); assert.deepEqual(replay.body, first.body); assert.deepEqual(replay.resourceContext, first.resourceContext); checkedWire('createResource', replay);
  await code(call(cold, 'getResource', request('getResource', null, s.id, r.id)), 'SERVICE_RESTARTED', 503);
  await code(cold.openMedia('getMediaAsset', mediaRequest(r), new AbortController().signal), 'SERVICE_RESTARTED', 503);
  assert.equal(f.sources.prepares, 1); assert.equal(f.sources.handles.size, 0); assert.equal(cold.resourceSnapshot().liveResources, 0);
});

test('释放204必须等待迟到prepare实际材料关闭，重复DELETE不撤销或重做原意图', async t => {
  const f = fixture(t); f.sources.verifyGate = deferred<void>(); const s = await createSession(f.actor);
  const first = await call(f.actor, 'createResource', request('createResource', resourceRequest(), s.id, undefined, 'closing-resource')); assert.equal(first.status, 202);
  const id = (first.body as MobileReadyResource).id; f.sources.releaseGate = deferred<void>();
  let deleted = false; const deleting = call(f.actor, 'releaseResource', request('releaseResource', null, s.id, id)).then(v => { deleted = true; return v; });
  await delay(2); assert.equal(deleted, false); assert.equal(f.sources.handles.size, 1); f.sources.verifyGate.resolve();
  await until(() => f.actor.resourceSnapshot().releasing > 0); assert.equal(deleted, false); f.sources.releaseGate.resolve();
  assert.equal((await deleting).status, 204); assert.equal(f.sources.handles.size, 0); assert.equal(f.actor.resourceSnapshot().preparing, 0);
  assert.deepEqual((await call(f.actor, 'createResource', request('createResource', resourceRequest(), s.id, undefined, 'closing-resource'))).body, first.body);
});

test('持久预算不驱逐原回执，拒绝额外键/跨dataset/损坏密文，失败仍有准确关闭资源', async t => {
  const f = fixture(t, { maxReceipts: 1 }); const s = await createSession(f.actor);
  await call(f.actor, 'closeSession', request('closeSession', null, s.id));
  await code(createSession(f.actor, 'later-key'), 'RESOURCE_BUSY', 429); assert.equal(f.actor.resourceSnapshot().receipts, 1);
  const extra = { ...request('getSession', null, s.id), unexpected: true } as MobileDecodedRequest<unknown>;
  await code(call(f.actor, 'getSession', extra), 'INVALID_REQUEST', 400);
  await code(call(f.actor, 'getSession', request('getSession', null, s.id), { ...principal(), datasetId: 'other-dataset' }), 'UNAUTHORIZED', 401);
  await f.actor.close(); assert.equal(f.persistence.value.kind, 'sealed');
  if (f.persistence.value.kind === 'sealed') f.persistence.value.sealed[0] = f.persistence.value.sealed[0]! ^ 1;
  const corrupt = f.create(); await assert.rejects(createSession(corrupt, 'corrupt-key')); assert.equal(f.sources.prepares, 0);
});

test('终态预留：近满create在写UNKNOWN和准备来源之前稳定拒绝，不遗留同key的503', async t => {
  const probe = fixture(t); probe.sources.prepareFailure = new MobilePlaybackError(409, 'SOURCE_CHANGED');
  const probeSession = await createSession(probe.actor);
  const failed = await call(probe.actor, 'createResource', request('createResource', resourceRequest(), probeSession.id, undefined, 'capacity-resource'));
  assert.equal(failed.status, 409); await until(() => probe.actor.resourceSnapshot().preparing === 0);
  const complete = probe.persistence.value; assert.equal(complete.kind, 'sealed');
  if (complete.kind !== 'sealed') throw new Error('受控失败回执未持久化');
  const plain = probe.crypto.open(complete.sealed, Buffer.from(JSON.stringify(['MBM002_PLAYBACK_STATE_V1', SERVER, DATASET, complete.revision])));
  const failedState = decodePlaybackStorage(plain, SERVER, DATASET, ORIGIN, MOBILE_PLAYBACK_DEFAULT_LIMITS).state;
  let minimum = 1, maximum = plain.byteLength; plain.fill(0);
  // 用实际codec寻找原失败回执的最小表示边界；不把某个旧格式的长度当成未来格式的下限。
  while (minimum < maximum) {
    const stateBytes = Math.floor((minimum + maximum) / 2);
    try {
      const encoded = encodePlaybackStorage(failedState, SERVER, DATASET, ORIGIN, { ...MOBILE_PLAYBACK_DEFAULT_LIMITS, stateBytes });
      encoded.bytes.fill(0); maximum = stateBytes;
    } catch (error) {
      if (!(error instanceof MobilePlaybackError) || error.code !== 'RESOURCE_BUSY' || error.status !== 429) throw error;
      minimum = stateBytes + 1;
    }
  }
  const stateBytes = minimum - 1;
  const f = fixture(t, { stateBytes }); f.sources.prepareFailure = new MobilePlaybackError(409, 'SOURCE_CHANGED');
  const s = await createSession(f.actor), before = structuredClone(f.persistence.value), saves = f.persistence.saves;
  const intent = request('createResource', resourceRequest(), s.id, undefined, 'capacity-resource');
  await code(call(f.actor, 'createResource', intent), 'RESOURCE_BUSY', 429);
  assert.equal(f.sources.prepares, 0, '可失败结算空间不足时不能先碰来源');
  assert.equal(f.persistence.saves, saves, '拒绝前不写UNKNOWN或失败占位记录');
  assert.deepEqual(f.persistence.value, before); assert.equal(f.actor.resourceSnapshot().preparing, 0);
  assert.equal(f.actor.resourceSnapshot().receipts, 1); assert.equal(f.actor.resourceSnapshot().pendingPersistence, false);
  await code(call(f.actor, 'createResource', intent), 'RESOURCE_BUSY', 429);
  assert.equal(f.sources.prepares, 0); assert.equal(f.persistence.saves, saves);
});

test('终态预留：并发准备期间普通session续期和observation写入也经过同一真实codec预算', async t => {
  const encoded: { unknown: number; sessions: number; receipts: number; observed: boolean }[] = [];
  const stateCodec: MobilePlaybackStateCodecPort = {
    async encode(value, context) {
      assert.deepEqual(context.terminalFailureBudget, MOBILE_PLAYBACK_TERMINAL_FAILURE_BUDGET);
      await Promise.resolve();
      const result = encodePlaybackStorage(value, context.serverId, context.datasetId, context.responseOrigin, context.limits, context.terminalFailureBudget);
      encoded.push({ unknown: result.state.receipts.filter(r => r.operation === 'createResource' && r.state === 'UNKNOWN').length,
        sessions: result.state.sessions.length, receipts: result.state.receipts.length,
        observed: result.state.sessions.some(s => s.observation !== null) });
      return result;
    },
    async decode(plain, context) {
      assert.deepEqual(context.terminalFailureBudget, MOBILE_PLAYBACK_TERMINAL_FAILURE_BUDGET);
      return decodePlaybackStorage(plain, context.serverId, context.datasetId, context.responseOrigin, context.limits);
    },
    async close() {},
  };
  const f = fixture(t, undefined, stateCodec), s = await createSession(f.actor), current = await ready(f.actor, s);
  f.sources.prepareGate = deferred<void>();
  const intent = request('createResource', resourceRequest('pending-track'), s.id, undefined, 'pending-key');
  const pending = call(f.actor, 'createResource', intent); await until(() => f.sources.prepares === 2);
  const before = encoded.length;
  await createSession(f.actor, 'peer-session', principal('device-2'));
  const renewed = await call(f.actor, 'renewResource', request('renewResource', {}, s.id, current.id, 'current-renew'));
  assert.equal(renewed.status, 200);
  const observation: MobileObservation = { sequence: 1, playerGeneration: 1, queueItemId: 'current-queue', resourceId: current.id,
    trackId: current.trackId, positionMs: 1, state: 'playing' };
  assert.equal((await call(f.actor, 'reportObservation', request('reportObservation', observation, s.id))).status, 200);
  const concurrent = encoded.slice(before); assert.equal(concurrent.length, 3);
  assert.ok(concurrent.every(row => row.unknown === 1 && row.sessions === 2));
  assert.equal(concurrent.at(-1)!.observed, true); assert.equal(concurrent.at(-1)!.receipts, concurrent[0]!.receipts + 1);
  f.sources.changed = true; f.sources.prepareGate.resolve();
  const failed = await pending; assert.equal(failed.status, 409); await until(() => f.actor.resourceSnapshot().preparing === 0);
  assert.equal(encoded.at(-1)!.unknown, 0); assert.equal(f.actor.resourceSnapshot().pendingPersistence, false);
  const replay = await call(f.actor, 'createResource', intent); assert.equal(replay.status, failed.status); assert.deepEqual(replay.body, failed.body);
  assert.equal(f.sources.prepares, 2);
});

test('终态预留：非法端口错误转为可编码闭集失败，合法最大retry提示与原回执保留', async t => {
  const f = fixture(t), s = await createSession(f.actor);
  const failures = [new MobilePlaybackError(503, 'BUSY', true, Number.MAX_SAFE_INTEGER + 1),
    new MobilePlaybackError(503, 'SOURCE_INTERNAL' as 'BUSY'), new MobilePlaybackError(418 as 503, 'BUSY')];
  for (const [index, failure] of failures.entries()) {
    f.sources.prepareFailure = failure;
    const intent = request('createResource', resourceRequest(), s.id, undefined, `malformed-error-${index}`);
    const first = await call(f.actor, 'createResource', intent);
    assert.equal(first.status, 503); assert.ok(first.body && 'error' in first.body);
    assert.equal(first.body.error.code, 'BUSY'); assert.equal(first.body.error.retryable, true); assert.equal(first.body.error.retryAfterMs, 1_000);
    const replay = await call(f.actor, 'createResource', intent); assert.equal(replay.status, 503); assert.deepEqual(replay.body, first.body);
  }
  f.sources.prepareFailure = new MobilePlaybackError(503, 'BUSY', false, Number.MAX_SAFE_INTEGER);
  const exact = await call(f.actor, 'createResource', request('createResource', resourceRequest(), s.id, undefined, 'valid-largest-hint'));
  assert.equal(exact.status, 503); assert.ok(exact.body && 'error' in exact.body);
  assert.equal(exact.body.error.retryable, false); assert.equal(exact.body.error.retryAfterMs, Number.MAX_SAFE_INTEGER);
  await until(() => f.actor.resourceSnapshot().preparing === 0);
  assert.equal(f.sources.prepares, failures.length + 1); assert.equal(f.actor.resourceSnapshot().pendingPersistence, false);
});

test('终态预留：冷启动只终止旧resource并保留原UNKNOWN，不重做来源或改写历史回执', async t => {
  const f = fixture(t); f.sources.prepareFailure = new MobilePlaybackError(409, 'SOURCE_CHANGED');
  const s = await createSession(f.actor), intent = request('createResource', resourceRequest(), s.id, undefined, 'historical-unknown');
  assert.equal((await call(f.actor, 'createResource', intent)).status, 409); await until(() => f.actor.resourceSnapshot().preparing === 0);
  await f.actor.close();
  const before = f.persistence.value; assert.equal(before.kind, 'sealed');
  if (before.kind !== 'sealed') throw new Error('受控历史缺少密文');
  const aad = Buffer.from(JSON.stringify(['MBM002_PLAYBACK_STATE_V1', SERVER, DATASET, before.revision]));
  const plain = f.crypto.open(before.sealed, aad), state = decodePlaybackStorage(plain, SERVER, DATASET, ORIGIN, MOBILE_PLAYBACK_DEFAULT_LIMITS).state;
  plain.fill(0); const receipt = state.receipts.find(r => r.operation === 'createResource')!, resource = state.resources.find(r => r.id === receipt.resourceId)!;
  resource.state = 'preparing'; resource.failure = null;
  receipt.state = 'UNKNOWN'; receipt.reply = null; receipt.resourceContext = null;
  const originalReceipt = structuredClone(receipt), encoded = encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, MOBILE_PLAYBACK_DEFAULT_LIMITS);
  f.persistence.value = { ...before, sealed: f.crypto.seal(encoded.bytes, aad) }; encoded.bytes.fill(0);
  const prepares = f.sources.prepares, cold = f.create();
  await code(call(cold, 'createResource', intent), 'RESOURCE_BUSY', 503);
  const current = f.persistence.value; assert.equal(current.kind, 'sealed');
  if (current.kind !== 'sealed') throw new Error('受控冷恢复缺少密文');
  const recoveredPlain = f.crypto.open(current.sealed, Buffer.from(JSON.stringify(['MBM002_PLAYBACK_STATE_V1', SERVER, DATASET, current.revision])));
  const recovered = decodePlaybackStorage(recoveredPlain, SERVER, DATASET, ORIGIN, MOBILE_PLAYBACK_DEFAULT_LIMITS).state; recoveredPlain.fill(0);
  assert.deepEqual(recovered.receipts.find(r => r.id === receipt.id), originalReceipt);
  const terminal = recovered.resources.find(r => r.id === resource.id)!;
  assert.equal(terminal.state, 'terminal'); assert.equal(terminal.failure, 'SERVICE_RESTARTED');
  const saves = f.persistence.saves; await code(call(cold, 'createResource', intent), 'RESOURCE_BUSY', 503);
  assert.equal(f.persistence.saves, saves); assert.equal(f.sources.prepares, prepares);
  assert.equal(cold.resourceSnapshot().preparing, 0); assert.equal(cold.resourceSnapshot().pendingPersistence, false);
});

test('prepare超时保存原失败回执，迟到handle保持原flight直到实际release静止，关闭不伪报成功', async t => {
  const f = fixture(t, { prepareTimeoutMs: 15, readyWaitMs: 1 });
  f.sources.prepareGate = deferred<void>(); f.sources.releaseGate = deferred<void>();
  const s = await createSession(f.actor), intent = request('createResource', resourceRequest(), s.id, undefined, 'timeout-resource');
  const failed = await call(f.actor, 'createResource', intent); assert.equal(failed.status, 429);
  assert.ok(failed.body && 'error' in failed.body); assert.equal(failed.body.error.code, 'RESOURCE_BUSY');
  assert.equal(f.sources.handles.size, 1); assert.equal(f.actor.resourceSnapshot().preparing, 1);
  const replay = await call(f.actor, 'createResource', intent); assert.equal(replay.status, failed.status); assert.deepEqual(replay.body, failed.body);
  assert.equal(f.sources.prepares, 1);
  let closed = false; const closing = f.actor.close().then(() => { closed = true; });
  await delay(2); assert.equal(closed, false); f.sources.prepareGate.resolve();
  await until(() => f.actor.resourceSnapshot().releasing === 1); assert.equal(closed, false); assert.equal(f.sources.handles.size, 1);
  f.sources.releaseGate.resolve(); await closing;
  assert.equal(f.sources.handles.size, 0); assert.equal(f.sources.releases, 1); assert.equal(f.actor.resourceSnapshot().preparing, 0);
});
