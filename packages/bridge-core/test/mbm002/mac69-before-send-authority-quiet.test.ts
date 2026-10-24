import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createMobilePlaybackService, createMobilePlaybackReadComposition } from '../../src/mobile/playback-service.js';
import { createMobileAuthCrypto } from '../../src/mobile/auth-crypto.js';
import { decodePlaybackStorage, encodePlaybackStorage } from '../../src/mobile/playback-state-codec.js';
import { MobilePlaybackError, type MobilePlaybackAuthPort, type MobilePlaybackSourcePort, type MobilePlaybackLimits } from '../../src/mobile/playback-types.js';
import { type MobilePrincipal, type MobileSealedState } from '../../src/mobile/types.js';
import type { MobileDecodedRequest, MobileReadyResource, MobileSession } from '@music-bridge/contracts';

const SERVER = 'server.authority-boundary', DATASET = 'dataset.authority-boundary';
const ORIGIN = 'https://127.0.0.1:9443';
const principal: MobilePrincipal = { serverId: SERVER, datasetId: DATASET, deviceId: 'device.authority-boundary',
  deviceEpoch: 1, generation: 1, accountDomain: `local:${DATASET}`, accessTokenHash: 'b'.repeat(64),
  accessExpiresAt: '2030-01-01T00:00:00.000Z' };
const signal = () => new AbortController().signal;

/** 真正经过Core会话、资源、票据、组合读和密封账本；故障仅注入只读授权端口。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve };
}
const turns = async () => { for (let n = 0; n < 2; n++) await new Promise<void>(yes => setImmediate(yes)); };

// 门闩仅位于真实授权端口；Service/票据/reader及密封账本仍走原实现。
function fixture(t: TestContext, limits: Partial<MobilePlaybackLimits> = {}) {
  const crypto = createMobileAuthCrypto(new Uint8Array(32).fill(38));
  let stored: MobileSealedState = { kind: 'missing', datasetId: DATASET, revision: 0 };
  let authorizationCalls = 0, nextHold: { entered: ReturnType<typeof deferred<void>>; done: ReturnType<typeof deferred<void>> } | undefined;
  const allHolds: { entered: ReturnType<typeof deferred<void>>; done: ReturnType<typeof deferred<void>> }[] = [];
  let closeReads = 0, releases = 0;
  const reads: { readId: string; start: number; maxBytes: number }[] = [];
  const handles = new Set<string>();
  const data = Uint8Array.from({ length: 262144 }, (_, n) => n % 251);
  const auth: MobilePlaybackAuthPort = { async assertDeviceCurrent(device, epoch) {
    assert.equal(device, principal.deviceId); assert.equal(epoch, principal.deviceEpoch);
    authorizationCalls++;
    const hold = nextHold; nextHold = undefined;
    if (hold) { hold.entered.resolve(); await hold.done.promise; }
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
    async closeRead() { closeReads++; },
    async release(handle) { releases++; handles.delete(handle); },
  };
  const readComposition = createMobilePlaybackReadComposition(auth, source, async (request, authority) => {
    await authority.before();
    const bytes = await source.read(request.handle, request.readId, request.start, request.maxBytes, request.signal);
    await authority.after(); return bytes;
  });
  const service = createMobilePlaybackService({ serverId: SERVER, datasetId: DATASET, responseOrigin: ORIGIN,
    auth, crypto, sourcePort: source, readComposition, nowMs: () => Date.parse('2026-10-21T00:00:00Z'),
    limits,
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
  t.after(async () => { for (const hold of allHolds) hold.done.resolve(); await service.close(); assert.equal(handles.size, 0); });
  return { service, data, reads, authCalls: () => authorizationCalls, closeReads: () => closeReads, releases: () => releases,
    holdAuthorization() {
      assert.equal(nextHold, undefined);
      const hold = { entered: deferred<void>(), done: deferred<void>() }; allHolds.push(hold); nextHold = hold;
      return { entered: hold.entered.promise, release: () => hold.done.resolve() };
    },
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
    open(resource: MobileReadyResource, abort = signal()) {
      const url = new URL(resource.media.url);
      const request: MobileDecodedRequest<unknown> = { path: url.pathname, pathParameters: { resourceId: resource.id, asset: 'source' },
        query: { ticket: url.searchParams.get('ticket')! }, body: null };
      return service.openMedia('getMediaAsset', request, abort, { range: 'bytes=0-262143' });
    },
  };
}


test('beforeSend授权未静止时reply.close不得先完成或归还reader槽', { timeout: 3000 }, async t => {
  const f = fixture(t), media = await f.open(await f.ready()), hold = f.holdAuthorization();
  let authorized = false, closed = false;
  const authorizing = media.beforeSend().then(() => { authorized = true; });
  await hold.entered;
  const closing = media.close().then(() => { closed = true; });
  try {
    await turns();
    assert.equal(authorized, false, '门闩必须仍持有原授权调用');
    assert.equal(closed, false, '原授权仍在途，不得先宣称整个reader quiet');
    assert.equal(f.service.resourceSnapshot().readers, 1, '原reader槽必须占到授权与FD均真实静止');
    assert.equal(f.reads.length, 0, '取消期间没有媒体字节');
  } finally { hold.release(); await Promise.allSettled([authorizing, closing]); }
  assert.equal(closed, true); assert.equal(f.service.resourceSnapshot().readers, 0);
  assert.equal(f.closeReads(), 1, '原closeRead只调用一次'); assert.equal(f.reads.length, 0);
});

test('beforeSend授权未静止时releaseResource不得先释放源或报告完成', { timeout: 3000 }, async t => {
  const f = fixture(t), resource = await f.ready(), media = await f.open(resource), hold = f.holdAuthorization();
  const authorizing = media.beforeSend();
  // 立即消费拒绝分支：资源撤销后旧授权不得成为晚到成功字节。
  const authorizationResult = authorizing.then(() => 'authorized', () => 'rejected');
  await hold.entered;
  let released = false;
  const releasing = f.service.control('releaseResource', {
    path: `/mobile/v1/sessions/${resource.sessionId}/resources/${resource.id}`,
    pathParameters: { sessionId: resource.sessionId, resourceId: resource.id }, query: {}, body: null,
    idempotencyKey: 'release.before-send-authority',
  }, principal, signal()).then(value => { released = true; return value; });
  try {
    await turns();
    assert.equal(released, false, '终止写回不能把仍在授权中的reader说成quiet');
    assert.equal(f.releases(), 0, '真实source.release必须等原reader所有工作结束');
    assert.equal(f.reads.length, 0);
  } finally { hold.release(); await Promise.allSettled([authorizationResult, releasing]); }
  assert.equal(await authorizationResult, 'rejected');
  assert.equal((await releasing).status, 204); assert.equal(f.releases(), 1); assert.equal(f.closeReads(), 1);
});

test('HTTP取消后原beforeSend仍在途时close保持占槽，迟到授权不发字节', { timeout: 3000 }, async t => {
  const f = fixture(t), controller = new AbortController(), media = await f.open(await f.ready(), controller.signal);
  const hold = f.holdAuthorization();
  const authorizationResult = media.beforeSend().then(() => 'authorized', () => 'rejected');
  await hold.entered; controller.abort();
  let quiet = false;
  const closing = media.close().then(() => { quiet = true; });
  try {
    await turns();
    assert.equal(quiet, false, 'abort只撤销使用资格，不能伪造原授权工作已结束');
    assert.equal(f.service.resourceSnapshot().readers, 1); assert.equal(f.reads.length, 0);
  } finally { hold.release(); await Promise.allSettled([authorizationResult, closing]); }
  assert.equal(await authorizationResult, 'rejected'); assert.equal(quiet, true);
  assert.equal(f.closeReads(), 1); assert.equal(f.service.resourceSnapshot().readers, 0); assert.equal(f.reads.length, 0);
});

test('active beforeSend授权超过小idle注入值不属于客户端停顿', { timeout: 3000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, { mediaIdleMs: 20 }), media = await f.open(await f.ready()), hold = f.holdAuthorization();
  const authorizationResult = media.beforeSend().then(() => 'authorized', () => 'rejected');
  await hold.entered;
  try {
    t.mock.timers.tick(21); await turns();
    assert.equal(f.closeReads(), 0, '活动授权等待不能触发5秒idle对应的自动关闭');
    assert.equal(f.service.resourceSnapshot().readers, 1); assert.equal(f.reads.length, 0);
  } finally { hold.release(); }
  assert.equal(await authorizationResult, 'authorized');
  assert.deepEqual(await media.reader!.read(16), f.data.slice(0, 16)); await media.close();
});
