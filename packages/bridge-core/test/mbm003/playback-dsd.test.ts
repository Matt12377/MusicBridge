import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { decodeMobileResponse, MOBILE_DSD_PCM_PROCESSING_REASON, type MobileDecodedRequest, type MobileResourceRequest,
  type MobileSession, type MobileReadyResource } from '@music-bridge/contracts';
import { createMobilePlaybackService } from '../../src/mobile/playback-service.js';
import { MobilePlaybackError, type MobilePlaybackControlOperation, type MobilePlaybackControlReply, type MobilePlaybackService } from '../../src/mobile/playback-types.js';
import type { MobilePlaybackSourcePort, MobilePlaybackSourceRequest, MobilePlaybackPreparingSource, MobilePlaybackPreparedSource } from '../../src/mobile/source-types.js';
import type { MobileAuthCrypto, MobileAuthPersistence, MobilePrincipal, MobileSealedSave, MobileSealedState } from '../../src/mobile/types.js';

// 本文件只证明逻辑 actor、真实 AES 和正式 raw codec；受控 SourcePort 不冒充 native 转换、文件或手机。
const ORIGIN = 'https://127.0.0.1:43123', SERVER = 'server-003', DATASET = 'dataset-003';
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) { assert.ok(Date.now() < deadline, '必须在原有限等待内得到端口事件。'); await delay(2); }
}
function cryptoPort(): MobileAuthCrypto {
  const key = randomBytes(32);
  return { seal(plain, aad) { const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(aad);
    return Buffer.concat([nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]); },
  open(sealed, aad) { const b = Buffer.from(sealed), decipher = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
    decipher.setAAD(aad); decipher.setAuthTag(b.subarray(-16)); return Buffer.concat([decipher.update(b.subarray(12, -16)), decipher.final()]); } };
}
class Persistence implements MobileAuthPersistence {
  value: MobileSealedState = { kind: 'missing', datasetId: DATASET, revision: 0 };
  async load() { return structuredClone(this.value); }
  async save(r: MobileSealedSave) {
    assert.equal(r.datasetId, DATASET);
    if (r.expectedRevision !== this.value.revision) return { kind: 'conflict' as const, datasetId: DATASET, currentRevision: this.value.revision };
    this.value = { kind: 'sealed', datasetId: DATASET, revision: r.expectedRevision + 1, commitId: r.commitId, sealed: new Uint8Array(r.sealed) };
    return { kind: 'saved' as const, datasetId: DATASET, revision: this.value.revision, commitId: r.commitId };
  }
}
class Sources implements MobilePlaybackSourcePort {
  qualified = true; preparing = false; fromCache = false; direct = false;
  prepares = 0; conversions = 0; statuses = 0; renews = 0; releases = 0;
  readonly requests: MobilePlaybackSourceRequest[] = [];
  readonly handles = new Map<string, MobilePlaybackPreparedSource>();
  readonly reads = new Set<string>();
  readonly bytes = Uint8Array.from({ length: 257 }, (_, i) => i < 4 ? [102, 76, 97, 67][i]! : i % 251);
  statusGate: ReturnType<typeof deferred> | undefined;
  releaseGate: ReturnType<typeof deferred> | undefined;
  async capabilities() { return { resourceDsdToPcm: this.qualified }; }
  short(source: MobilePlaybackPreparedSource): MobilePlaybackPreparingSource {
    return { handle: source.handle, preparing: true, sourceAudio: { ...source.sourceAudio }, processing: { ...source.processing, fromPreparedCache: false }, durationMs: source.durationMs, seekable: true };
  }
  async prepare(request: MobilePlaybackSourceRequest) {
    this.prepares++; this.requests.push(structuredClone(request));
    if (!this.direct && (request.acceptedProcessingModes?.[0] !== 'dsd_to_pcm' || !request.preparationWindow
      || !request.dsdTarget?.accepts24Bit48KhzFlac || request.dsdTarget.maxChannels < 2)) throw new MobilePlaybackError(409, 'UNSUPPORTED_FORMAT');
    if (!this.direct) this.conversions++;
    const source: MobilePlaybackPreparedSource = { handle: `handle-${request.resourceId}`,
      sourceAudio: this.direct ? { codec: 'flac', container: 'flac', sampleRateHz: 192000, bitsPerSample: 24, channels: 2 }
        : { codec: 'dsd', container: 'dsf', sampleRateHz: 2822400, bitsPerSample: 1, channels: 2 },
      actualAudio: { codec: 'flac', container: 'flac', sampleRateHz: this.direct ? 192000 : 48000, bitsPerSample: 24, channels: 2 },
      processing: this.direct ? { mode: 'direct', reason: '受控端口的原样字节', fromPreparedCache: false }
        : { mode: 'dsd_to_pcm', reason: MOBILE_DSD_PCM_PROCESSING_REASON, fromPreparedCache: this.fromCache },
      contentType: 'audio/flac', size: this.bytes.length, durationMs: 4000, seekable: true };
    this.handles.set(source.handle, source); return this.preparing ? this.short(source) : structuredClone(source);
  }
  async status(handle: string) {
    this.statuses++; if (this.statusGate) await this.statusGate.promise;
    const value = this.handles.get(handle); assert.ok(value); return this.preparing ? this.short(value) : structuredClone(value);
  }
  async verify(handle: string) { assert.ok(this.handles.has(handle)); }
  async renew(handle: string) { assert.ok(this.handles.has(handle)); this.renews++; }
  async read(handle: string, readId: string, start: number, maxBytes: number) {
    assert.ok(this.handles.has(handle)); assert.ok(maxBytes > 0 && maxBytes <= 65536); this.reads.add(readId); return this.bytes.slice(start, start + maxBytes);
  }
  async closeRead(_handle: string, readId: string) { this.reads.delete(readId); }
  async release(handle: string) { if (this.releaseGate) await this.releaseGate.promise; if (this.handles.delete(handle)) this.releases++; }
}
const principal: MobilePrincipal = Object.freeze({ serverId: SERVER, deviceId: 'device-003', datasetId: DATASET, accountDomain: `local:${DATASET}`,
  deviceEpoch: 1, generation: 1, accessTokenHash: 'a'.repeat(64), accessExpiresAt: '2030-01-01T00:00:00.000Z' });
function fixture(t: TestContext) {
  let now = Date.parse('2026-10-10T00:00:00.000Z');
  const sources = new Sources(), persistence = new Persistence(), crypto = cryptoPort(), actors: MobilePlaybackService[] = [];
  const create = () => {
    const service = createMobilePlaybackService({ serverId: SERVER, datasetId: DATASET, responseOrigin: ORIGIN, persistence, crypto, sourcePort: sources,
      auth: { async assertDeviceCurrent(id, epoch) { assert.equal(id, principal.deviceId); assert.equal(epoch, principal.deviceEpoch); } }, nowMs: () => now });
    actors.push(service); return service;
  };
  const actor = create(); t.after(async () => { sources.statusGate?.resolve(); sources.releaseGate?.resolve(); for (const a of actors) await a.close();
    assert.equal(sources.handles.size, 0); assert.equal(sources.reads.size, 0); });
  return { actor, create, sources, advance(ms: number) { now += ms; } };
}
function request(op: MobilePlaybackControlOperation, body: unknown = null, sessionId?: string, resourceId?: string, key?: string): MobileDecodedRequest<unknown> {
  const base = '/mobile/v1/sessions';
  const path = op === 'createSession' ? base : op === 'createResource' ? `${base}/${sessionId}/resources`
    : ['getResource', 'renewResource', 'releaseResource'].includes(op) ? `${base}/${sessionId}/resources/${resourceId}${op === 'renewResource' ? '/renew' : ''}` : `${base}/${sessionId}`;
  const pathParameters: Record<string, string> = op === 'createSession' ? {} : ['getResource', 'renewResource', 'releaseResource'].includes(op) ? { sessionId: sessionId!, resourceId: resourceId! } : { sessionId: sessionId! };
  return { path, pathParameters, query: {}, body, ...(key ? { idempotencyKey: key } : {}) };
}
const body = (): MobileResourceRequest => ({ trackId: 'track-003', versionId: 'version-003', contentRevision: 'content-003',
  quality: { profile: 'auto', allowLossyFallback: false, preferredTransport: 'file' }, formats: [{ codec: 'flac', container: 'flac', maxSampleRateHz: 48000, maxChannels: 2, maxBitsPerSample: 24 }], acceptedProcessingModes: ['dsd_to_pcm'] });
const call = (actor: MobilePlaybackService, op: MobilePlaybackControlOperation, r: MobileDecodedRequest<unknown>) => actor.control(op, r, principal, new AbortController().signal);
async function session(actor: MobilePlaybackService) { const value = await call(actor, 'createSession', request('createSession', { clientInstanceId: 'client-003' }, undefined, undefined, 'session-003'));
  assert.equal(value.status, 201); return value.body as MobileSession; }
function checkedWire(op: 'createResource' | 'renewResource', reply: MobilePlaybackControlReply) {
  assert.ok(reply.resourceContext); const r = reply.resourceContext, path = `/mobile/v1/sessions/${r.scope.sessionId}/resources${op === 'renewResource' ? `/${r.expectedResourceId}/renew` : ''}`;
  const value = decodeMobileResponse(op, { status: reply.status, headers: [['Content-Type', 'application/json']], body: new TextEncoder().encode(JSON.stringify(reply.body)), finalUrl: ORIGIN + path },
    { responseOrigin: ORIGIN, requestPath: path, resource: r }); assert.equal(value.ok, true, value.ok ? undefined : JSON.stringify(value.issue));
}
function media(r: MobileReadyResource): MobileDecodedRequest<unknown> { const url = new URL(r.media.url); return { path: url.pathname,
  pathParameters: { resourceId: r.id, asset: 'source' }, query: { ticket: url.searchParams.get('ticket')! }, body: null }; }
async function code(p: Promise<unknown>, expected: string, status: number) { await assert.rejects(p, e => e instanceof MobilePlaybackError && e.code === expected && e.status === status); }

test('MBM003 actor准入：能力与opt-in独立，旧请求和不完整FLAC24/48/声道及quality在转换前拒绝', async t => {
  const f = fixture(t), s = await session(f.actor); f.sources.qualified = false;
  await code(call(f.actor, 'createResource', request('createResource', body(), s.id, undefined, 'absent')), 'UNSUPPORTED_FORMAT', 409);
  assert.equal(f.sources.prepares, 0); f.sources.qualified = true;
  const old = body(); delete old.acceptedProcessingModes;
  const requests = [old, { ...body(), quality: { profile: 'lossless' as const, allowLossyFallback: false, preferredTransport: 'file' as const } },
    { ...body(), formats: [{ codec: 'flac', container: 'flac', maxSampleRateHz: 44100, maxChannels: 2, maxBitsPerSample: 24 }] },
    { ...body(), formats: [{ codec: 'flac', container: 'flac', maxSampleRateHz: 48000, maxChannels: 2, maxBitsPerSample: 16 }] },
    { ...body(), formats: [{ codec: 'flac', container: 'flac', maxSampleRateHz: 48000, maxChannels: 1, maxBitsPerSample: 24 }] }];
  for (const [i, input] of requests.entries()) { const reply = await call(f.actor, 'createResource', request('createResource', input, s.id, undefined, `invalid-${i}`));
    assert.equal(reply.status, 409); assert.ok(reply.body && 'error' in reply.body); assert.equal(reply.body.error.code, 'UNSUPPORTED_FORMAT'); }
  await until(() => f.actor.resourceSnapshot().preparing === 0); assert.equal(f.sources.conversions, 0); assert.equal(f.sources.handles.size, 0);
});

test('MBM003 actor异步回执：短preparing没有actual/media，ready仍保持原202与原时间并只begin一次', async t => {
  const f = fixture(t), s = await session(f.actor); f.sources.preparing = true; f.sources.statusGate = deferred();
  const intent = request('createResource', body(), s.id, undefined, 'original-202'), first = await call(f.actor, 'createResource', intent);
  assert.equal(first.status, 202); checkedWire('createResource', first); assert.ok(first.body && 'state' in first.body && first.body.state === 'preparing');
  assert.equal('media' in first.body, false); assert.equal('actualAudio' in first.body, false); assert.equal(first.body.sourceAudio?.bitsPerSample, 1);
  assert.equal(first.body.processing?.mode, 'dsd_to_pcm'); assert.equal(first.resourceContext?.resourceDsdToPcm, true);
  await until(() => f.sources.statuses === 1); const capturedWindow = structuredClone(f.sources.requests[0]!.preparationWindow);
  f.sources.preparing = false; f.sources.statusGate.resolve(); await until(() => f.actor.resourceSnapshot().preparing === 0);
  const current = await call(f.actor, 'getResource', request('getResource', null, s.id, first.body.id));
  assert.ok(current.body && 'state' in current.body && current.body.state === 'ready'); assert.equal(current.body.media.actualAudio.bitsPerSample, 24);
  f.advance(61_000); const replay = await call(f.actor, 'createResource', intent); checkedWire('createResource', replay);
  assert.equal(replay.status, 202); assert.deepEqual(replay.body, first.body); assert.deepEqual(replay.resourceContext, first.resourceContext);
  assert.equal(f.sources.prepares, 1); assert.equal(f.sources.conversions, 1); assert.deepEqual(f.sources.requests[0]!.preparationWindow, capturedWindow);
});

test('MBM003 actor原样FLAC：24-bit/192kHz不采DSD仍原201和全bytes，不被转换目标限制', async t => {
  const f = fixture(t), s = await session(f.actor); f.sources.direct = true; f.sources.qualified = false;
  const input = body(); delete input.acceptedProcessingModes; input.quality.profile = 'lossless'; input.formats[0]!.maxSampleRateHz = 192000;
  const reply = await call(f.actor, 'createResource', request('createResource', input, s.id, undefined, 'direct-192'));
  assert.equal(reply.status, 201); checkedWire('createResource', reply); const r = reply.body as MobileReadyResource;
  assert.deepEqual(r.sourceAudio, r.media.actualAudio); assert.equal(r.media.actualAudio.sampleRateHz, 192000); assert.equal(r.media.actualAudio.bitsPerSample, 24);
  assert.equal(r.processing.mode, 'direct'); assert.equal(f.sources.conversions, 0);
  const response = await f.actor.openMedia('getMediaAsset', media(r), new AbortController().signal), parts: Uint8Array[] = [];
  for await (const chunk of response.reader!) parts.push(chunk); assert.deepEqual(Buffer.concat(parts), Buffer.from(f.sources.bytes));
});

test('MBM003 actor已ready跨240秒：同产物正常renew，新票续原TTL，cache事实与原回执不改写', async t => {
  const f = fixture(t), s = await session(f.actor); f.sources.fromCache = true;
  const input = body(); delete input.formats[0]!.maxBitsPerSample;
  const intent = request('createResource', input, s.id, undefined, 'ready-cache'), first = await call(f.actor, 'createResource', intent);
  assert.equal(first.status, 201); checkedWire('createResource', first); const original = first.body as MobileReadyResource;
  assert.equal(original.processing.fromPreparedCache, true); f.advance(240_001);
  const renew = request('renewResource', {}, s.id, original.id, 'after-240'), reply = await call(f.actor, 'renewResource', renew);
  assert.equal(reply.status, 200); checkedWire('renewResource', reply); const current = reply.body as MobileReadyResource;
  assert.deepEqual(current.sourceAudio, original.sourceAudio); assert.deepEqual(current.media.actualAudio, original.media.actualAudio); assert.deepEqual(current.processing, original.processing);
  assert.notEqual(current.media.url, original.media.url); assert.equal(Date.parse(current.media.expiresAt) - Date.parse(reply.resourceContext!.now), 60_000);
  await code(f.actor.openMedia('headMediaAsset', media(original), new AbortController().signal), 'TICKET_EXPIRED', 401);
  await (await f.actor.openMedia('headMediaAsset', media(current), new AbortController().signal)).close();
  const replay = await call(f.actor, 'createResource', intent); checkedWire('createResource', replay); assert.equal(replay.status, 201);
  assert.deepEqual(replay.body, first.body); assert.deepEqual(replay.resourceContext, first.resourceContext); assert.equal(f.sources.prepares, 1);
});

test('MBM003 actor意外preparing：原240秒耗尽后renew拒绝并quiet释放，不调用第二begin或延长窗口', async t => {
  const f = fixture(t), s = await session(f.actor), first = await call(f.actor, 'createResource', request('createResource', body(), s.id, undefined, 'unexpected'));
  assert.equal(first.status, 201); const original = first.body as MobileReadyResource, window = structuredClone(f.sources.requests[0]!.preparationWindow);
  f.advance(240_001); f.sources.preparing = true;
  await code(call(f.actor, 'renewResource', request('renewResource', {}, s.id, original.id, 'no-second-window')), 'RESOURCE_EXPIRED', 410);
  assert.equal(f.sources.prepares, 1); assert.deepEqual(f.sources.requests[0]!.preparationWindow, window); assert.equal(f.sources.releases, 1); assert.equal(f.sources.handles.size, 0);
  await code(call(f.actor, 'getResource', request('getResource', null, s.id, original.id)), 'RESOURCE_EXPIRED', 410);
});

test('MBM003 actor冷恢复与取消：原DSD回执可编码但不重开FD，release等待preparing status实际退出', async t => {
  const f = fixture(t), s = await session(f.actor), intent = request('createResource', body(), s.id, undefined, 'cold-003');
  const first = await call(f.actor, 'createResource', intent); assert.equal(first.status, 201); await f.actor.close();
  f.sources.qualified = false; const cold = f.create(), replay = await call(cold, 'createResource', intent);
  checkedWire('createResource', replay); assert.deepEqual(replay.body, first.body); assert.deepEqual(replay.resourceContext, first.resourceContext);
  await code(call(cold, 'getResource', request('getResource', null, s.id, (first.body as MobileReadyResource).id)), 'SERVICE_RESTARTED', 503);
  assert.equal(f.sources.prepares, 1); assert.equal(f.sources.handles.size, 0);
  f.sources.qualified = true; f.sources.preparing = true; f.sources.statusGate = deferred(); f.sources.releaseGate = deferred();
  const pending = await call(cold, 'createResource', request('createResource', body(), s.id, undefined, 'cancel-003')); assert.equal(pending.status, 202);
  await until(() => f.sources.statuses > 0); let finished = false;
  const closing = call(cold, 'releaseResource', request('releaseResource', null, s.id, (pending.body as MobileReadyResource).id)).then(r => { finished = true; return r; });
  await delay(2); assert.equal(finished, false); assert.equal(f.sources.handles.size, 1);
  f.sources.statusGate.resolve(); await delay(2); assert.equal(finished, false); f.sources.releaseGate.resolve();
  assert.equal((await closing).status, 204); await until(() => cold.resourceSnapshot().preparing === 0); assert.equal(f.sources.handles.size, 0);
});
