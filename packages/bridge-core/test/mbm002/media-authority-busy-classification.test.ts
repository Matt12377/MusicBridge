import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createMobilePlaybackService, createMobilePlaybackReadComposition } from '../../src/mobile/playback-service.js';
import { createMobileAuthCrypto } from '../../src/mobile/auth-crypto.js';
import { decodePlaybackStorage, encodePlaybackStorage } from '../../src/mobile/playback-state-codec.js';
import { MobilePlaybackError, type MobilePlaybackAuthPort, type MobilePlaybackSourcePort } from '../../src/mobile/playback-types.js';
import { MobileAuthPersistenceError, MobileServiceError, type MobilePrincipal, type MobileSealedState } from '../../src/mobile/types.js';
import type { MobileDecodedRequest, MobileReadyResource, MobileSession } from '@music-bridge/contracts';

const SERVER = 'server.authority-boundary', DATASET = 'dataset.authority-boundary';
const ORIGIN = 'https://127.0.0.1:9443';
const principal: MobilePrincipal = { serverId: SERVER, datasetId: DATASET, deviceId: 'device.authority-boundary',
  deviceEpoch: 1, generation: 1, accountDomain: `local:${DATASET}`, accessTokenHash: 'b'.repeat(64),
  accessExpiresAt: '2030-01-01T00:00:00.000Z' };
const signal = () => new AbortController().signal;

/** 真正经过Core会话、资源、票据、组合读和密封账本；故障仅注入只读授权端口。 */
function fixture(t: TestContext) {
  const crypto = createMobileAuthCrypto(new Uint8Array(32).fill(38));
  let stored: MobileSealedState = { kind: 'missing', datasetId: DATASET, revision: 0 };
  let authorizationCalls = 0, failAt = 0, injected: unknown;
  const reads: { readId: string; start: number; maxBytes: number }[] = [];
  const handles = new Set<string>();
  const data = Uint8Array.from({ length: 262144 }, (_, n) => n % 251);
  const auth: MobilePlaybackAuthPort = { async assertDeviceCurrent(device, epoch) {
    assert.equal(device, principal.deviceId); assert.equal(epoch, principal.deviceEpoch);
    authorizationCalls++;
    if (authorizationCalls === failAt) { failAt = 0; throw injected; }
  } };
  const source: MobilePlaybackSourcePort = {
    async prepare(selection) {
      const handle = `handle.${selection.resourceId}`; handles.add(handle);
      const audio = { codec: 'flac' as const, container: 'flac' as const, sampleRateHz: 48000, bitsPerSample: 24, channels: 2 };
      return { handle, sourceAudio: audio, actualAudio: audio,
        processing: { mode: 'direct', reason: '合成原字节', fromPreparedCache: false },
        contentType: 'audio/flac', size: data.length, durationMs: 4000, seekable: true };
    },
    async verify(handle) { assert.ok(handles.has(handle)); },
    async renew(handle) { assert.ok(handles.has(handle)); },
    async read(handle, readId, start, maxBytes, abort) {
      assert.ok(handles.has(handle)); abort.throwIfAborted();
      reads.push({ readId, start, maxBytes }); return data.slice(start, start + maxBytes);
    },
    async closeRead() {},
    async release(handle) { handles.delete(handle); },
  };
  const readComposition = createMobilePlaybackReadComposition(auth, source, async (request, authority) => {
    await authority.before();
    const bytes = await source.read(request.handle, request.readId, request.start, request.maxBytes, request.signal);
    await authority.after(); return bytes;
  });
  const service = createMobilePlaybackService({ serverId: SERVER, datasetId: DATASET, responseOrigin: ORIGIN,
    auth, crypto, sourcePort: source, readComposition, nowMs: () => Date.parse('2026-10-21T00:00:00Z'),
    stateCodec: {
      async encode(state, context) { return encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, context.limits, context.terminalFailureBudget); },
      async decode(bytes, context) { return decodePlaybackStorage(bytes, SERVER, DATASET, ORIGIN, context.limits); },
      async close() {},
    },
    persistence: {
      async load() { return structuredClone(stored); },
      async save(request) {
        assert.equal(request.expectedRevision, stored.revision);
        stored = { kind: 'sealed', datasetId: DATASET, revision: request.expectedRevision + 1,
          commitId: request.commitId, sealed: new Uint8Array(request.sealed) };
        return { kind: 'saved', datasetId: DATASET, revision: stored.revision, commitId: stored.commitId };
      },
    },
  });
  t.after(async () => { failAt = 0; await service.close(); assert.equal(handles.size, 0); });
  return { service, data, reads, authCalls: () => authorizationCalls,
    fail(error: unknown, relativeCall = 1) { injected = error; failAt = authorizationCalls + relativeCall; },
    async ready() {
      const sessionReply = await service.control('createSession', { path: '/mobile/v1/sessions', pathParameters: {}, query: {},
        body: { clientInstanceId: 'client.authority-boundary' }, idempotencyKey: 'session.authority-boundary' }, principal, signal());
      assert.equal(sessionReply.status, 201); const session = sessionReply.body as MobileSession;
      const reply = await service.control('createResource', { path: `/mobile/v1/sessions/${session.id}/resources`,
        pathParameters: { sessionId: session.id }, query: {}, idempotencyKey: 'resource.authority-boundary',
        body: { trackId: 'track.authority-boundary', versionId: 'version.authority-boundary', contentRevision: 'revision.authority-boundary',
          quality: { profile: 'lossless', allowLossyFallback: false, preferredTransport: 'file' },
          formats: [{ codec: 'flac', container: 'flac', maxSampleRateHz: 48000, maxBitsPerSample: 24, maxChannels: 2 }] } }, principal, signal());
      assert.equal(reply.status, 201); return reply.body as MobileReadyResource;
    },
    open(resource: MobileReadyResource) {
      const url = new URL(resource.media.url);
      const request: MobileDecodedRequest<unknown> = { path: url.pathname, pathParameters: { resourceId: resource.id, asset: 'source' },
        query: { ticket: url.searchParams.get('ticket')! }, body: null };
      return service.openMedia('getMediaAsset', request, signal(), { range: 'bytes=0-262143' });
    },
  };
}

const temporary = () => new MobileServiceError(503, 'BUSY', true);
function temporaryRejected(error: unknown): boolean {
  assert.ok(error instanceof MobileServiceError || error instanceof MobilePlaybackError);
  assert.equal(error.status, 503); assert.equal(error.code, 'BUSY'); assert.equal(error.retryable, true); return true;
}
function revokedRejected(error: unknown): boolean {
  assert.ok(error instanceof MobilePlaybackError); assert.equal(error.status, 403);
  assert.equal(error.code, 'DEVICE_REVOKED'); assert.equal(error.retryable, false); return true;
}

test('媒体读授权：初次open的精确暂态BUSY保留503而非伪造设备撤销', async t => {
  const f = fixture(t), resource = await f.ready(); f.fail(temporary());
  await assert.rejects(f.open(resource), temporaryRejected); assert.equal(f.reads.length, 0);
});

test('媒体读授权：逐片beforeSend的精确暂态BUSY拒绝字节但保留503', async t => {
  const f = fixture(t), media = await f.open(await f.ready()); f.fail(temporary());
  await assert.rejects(media.beforeSend(), temporaryRejected); assert.equal(f.reads.length, 0); await media.close();
});

test('媒体读授权：组合read前暂态BUSY不得冒充撤销或进入实际读', async t => {
  const f = fixture(t), media = await f.open(await f.ready()); await media.beforeSend(); f.fail(temporary());
  let published = false;
  await assert.rejects(async () => { await media.reader!.read(65536); published = true; }, temporaryRejected);
  assert.equal(published, false); assert.equal(f.reads.length, 0); await media.close();
});

test('媒体读授权：组合read后暂态BUSY不得把已读字节交出或伪造撤销', async t => {
  const f = fixture(t), media = await f.open(await f.ready()); await media.beforeSend(); f.fail(temporary(), 2);
  let published = false;
  await assert.rejects(async () => { await media.reader!.read(65536); published = true; }, temporaryRejected);
  assert.equal(published, false); assert.equal(f.reads.length, 1); await media.close();
});

test('媒体读授权：真实设备撤销在写前及读前后仍拒绝且没有迟到字节', async t => {
  for (const phase of ['write', 'before', 'after'] as const) {
    const f = fixture(t), media = await f.open(await f.ready()); await media.beforeSend();
    f.fail(new MobileServiceError(403, 'DEVICE_REVOKED'), phase === 'after' ? 2 : 1);
    let published = false;
    await assert.rejects(async () => {
      if (phase === 'write') await media.beforeSend(); else await media.reader!.read(65536);
      published = true;
    }, revokedRejected);
    assert.equal(published, false); assert.equal(f.reads.length, phase === 'after' ? 1 : 0); await media.close();
  }
});

test('媒体读授权：不可重试BUSY及未分类UNKNOWN和伪typed错误保持原拒绝', async t => {
  for (const error of [new MobileServiceError(503, 'BUSY', false), new MobileAuthPersistenceError('unknown'),
    Object.assign(new Error('合成未认证错误'), { status: 503, code: 'BUSY', retryable: true })]) {
    const f = fixture(t), media = await f.open(await f.ready()); f.fail(error);
    await assert.rejects(media.beforeSend(), revokedRejected); assert.equal(f.reads.length, 0); await media.close();
  }
});

test('媒体读授权：服务close后的旧beforeSend仍锁闭且不再读授权或源', async t => {
  const f = fixture(t), media = await f.open(await f.ready()); await f.service.close(); const calls = f.authCalls();
  f.fail(temporary()); await assert.rejects(media.beforeSend(), error => {
    assert.ok(error instanceof MobilePlaybackError); assert.equal(error.status, 503); assert.equal(error.code, 'SERVICE_RESTARTED'); return true;
  });
  assert.equal(f.authCalls(), calls); assert.equal(f.reads.length, 0);
});
