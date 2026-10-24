import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import type { MobileDecodedRequest, MobileReadyResource, MobileSession } from '@music-bridge/contracts';
import { createMobileSealedStateStore } from '../../src/mobile/sealed-state-store.js';
import { createMobilePlaybackHistoryOwnerStore } from '../../src/mobile/playback-history-owner-store.js';
import { historyLookupKey, verifyPlaybackHistoryProof } from '../../src/mobile/playback-history-index.js';
import { playbackHistorySnapshotAad } from '../../src/mobile/playback-history-codec.js';
import { decodePlaybackStorage, encodePlaybackStorage } from '../../src/mobile/playback-state-codec.js';
import { MOBILE_PLAYBACK_DEFAULT_LIMITS, MobilePlaybackError, type MobilePlaybackControlOperation,
  type MobilePlaybackLimits } from '../../src/mobile/playback-types.js';
import { MobileAuthPersistenceError, type MobileAuthPersistence } from '../../src/mobile/types.js';
import { safeMobilePlaybackFailure } from '../../../../apps/desktop/src/main/mobile-playback-backend.js';
import type { MobilePlaybackHistoryPort, PlaybackHistoryReply, PlaybackHistoryRequest } from '../../src/mobile/playback-history-types.js';
import { HISTORY_SERVER as SERVER, HISTORY_DATASET as DATASET, HISTORY_ORIGIN as ORIGIN, historyAad, historyCall,
  historyCode, historyCreateSession, historyDeferred, historyFixture, historyPrincipal, historyReady,
  historyRequest, historyResourceRequest, historyUntil } from './playback-history-fixture.js';

function fixture(t: TestContext, limits: Partial<MobilePlaybackLimits> = {}) {
  const base = historyFixture(t, { maxReceipts: 3, maxStoredSessions: 2, maxLiveSessions: 2,
    maxStoredResources: 2, maxLiveResources: 2, ...limits });
  const directory = mkdtempSync(path.join(tmpdir(), 'musicbridge-history-archive-'));
  if (process.platform === 'darwin') assert.ok(directory.startsWith('/Volumes/LifeWeave/Developer/CommandLine/'));
  const legacy = createMobileSealedStateStore({ directory, datasetId: DATASET, namespace: 'playback', assertCurrent() {} });
  const persistence: MobileAuthPersistence = { async load(id) { return legacy.load(id); }, async save(value) { return legacy.save(value); } };
  let store: ReturnType<typeof createMobilePlaybackHistoryOwnerStore> | undefined;
  let intercept: ((request: Readonly<PlaybackHistoryRequest>, reply: PlaybackHistoryReply) => PlaybackHistoryReply) | undefined;
  const owner = () => store ??= createMobilePlaybackHistoryOwnerStore({ directory, datasetId: DATASET, assertCurrent() {} });
  const history: MobilePlaybackHistoryPort = { async dispatch(request) {
    const reply = owner().dispatch(request); return intercept ? intercept(request, structuredClone(reply)) : reply;
  } };
  base.afterActors.push(() => store?.close());
  return { ...base, directory, legacy, owner, history,
    createLegacy: () => base.create({ persistence }), create: () => base.create({ persistence, history }),
    reopenOwner() { store?.close(); store = undefined; },
    intercept(value: typeof intercept) { intercept = value; } };
}
interface OriginalReply { operation: MobilePlaybackControlOperation; request: MobileDecodedRequest<unknown>;
  status: number; body: unknown; context: unknown }
async function cycle(f: ReturnType<typeof fixture>, actor: ReturnType<ReturnType<typeof fixture>['create']>, serial: number) {
  const originals: OriginalReply[] = [];
  const sessionRequest = historyRequest('createSession', { clientInstanceId: 'history.cycle.client' }, undefined, undefined, `history.cycle.${serial}.session`);
  const created = await historyCall(actor, 'createSession', sessionRequest); assert.equal(created.status, 201); await created.beforeSend();
  const session = created.body as MobileSession;
  originals.push({ operation: 'createSession', request: sessionRequest, status: created.status,
    body: structuredClone(created.body), context: created.resourceContext });
  const resourceRequest = historyRequest('createResource', historyResourceRequest(), session.id, undefined, `history.cycle.${serial}.resource`);
  const prepared = await historyCall(actor, 'createResource', resourceRequest); assert.equal(prepared.status, 201); await prepared.beforeSend();
  const resource = prepared.body as MobileReadyResource;
  originals.push({ operation: 'createResource', request: resourceRequest, status: prepared.status,
    body: structuredClone(prepared.body), context: structuredClone(prepared.resourceContext) });
  const renewRequest = historyRequest('renewResource', {}, session.id, resource.id, `history.cycle.${serial}.renew`);
  const renewed = await historyCall(actor, 'renewResource', renewRequest); assert.equal(renewed.status, 200); await renewed.beforeSend();
  originals.push({ operation: 'renewResource', request: renewRequest, status: renewed.status,
    body: structuredClone(renewed.body), context: structuredClone(renewed.resourceContext) });
  const closed = await historyCall(actor, 'closeSession', historyRequest('closeSession', null, session.id));
  assert.equal(closed.status, 204); await closed.beforeSend(); assert.equal(f.sources.handles.size, 0);
  return { session, resource, originals };
}

test('历史归档：原活跃帽内多轮保全所有原status/body/context，冷重开不重prepare且旧DELETE仍204', async t => {
  const f = fixture(t), actor = f.create(), rounds: Awaited<ReturnType<typeof cycle>>[] = [];
  for (let index = 0; index < 5; index++) rounds.push(await cycle(f, actor, index));
  assert.equal(f.sources.prepares, 5); assert.ok(actor.resourceSnapshot().receipts <= 3);
  const head = f.owner().dispatch({ op: 'load', serverId: SERVER, datasetId: DATASET });
  assert.equal(head.kind, 'loaded'); if (head.kind !== 'loaded') throw new Error('缺少真实Owner头。');
  assert.equal(head.token.authority, 'journal'); assert.ok(head.token.indexRoot);
  await actor.close(); f.reopenOwner(); const cold = f.create(); await cold.initialize();
  const prepares = f.sources.prepares;
  for (const round of rounds) {
    for (const original of round.originals) {
      const replay = await historyCall(cold, original.operation, original.request);
      assert.equal(replay.status, original.status); assert.deepEqual(replay.body, original.body);
      assert.deepEqual(replay.resourceContext, original.context); await replay.beforeSend();
    }
    assert.equal((await historyCall(cold, 'closeSession', historyRequest('closeSession', null, round.session.id))).status, 204);
    assert.equal((await historyCall(cold, 'releaseResource', historyRequest('releaseResource', null, round.session.id, round.resource.id))).status, 204);
    await historyCode(historyCall(cold, 'getSession', historyRequest('getSession', null, round.session.id)), 'SESSION_CLOSED', 410);
  }
  assert.equal(f.sources.prepares, prepares); assert.equal(f.sources.handles.size, 0);
  assert.ok(cold.resourceSnapshot().receipts <= 3);
});

test('历史归档：固定30分钟scope自然过期后多轮回落，原回执仍可点查且新scope沿原热帽', async t => {
  const f = fixture(t), actor = f.create(), expired: Array<{ session: MobileSession; request: MobileDecodedRequest<unknown>; body: unknown }> = [];
  for (let serial = 0; serial < 4; serial++) {
    const request = historyRequest('createSession', { clientInstanceId: 'history.ttl.client' }, undefined, undefined, `history.ttl.${serial}`);
    const reply = await historyCall(actor, 'createSession', request); assert.equal(reply.status, 201); await reply.beforeSend();
    const session = reply.body as MobileSession; assert.equal(Date.parse(session.expiresAt) - Date.parse(session.createdAt), MOBILE_PLAYBACK_DEFAULT_LIMITS.sessionTtlMs);
    await historyReady(actor, session, `history.ttl.resource.${serial}`);
    expired.push({ session, request, body: structuredClone(reply.body) });
    f.advance(MOBILE_PLAYBACK_DEFAULT_LIMITS.sessionTtlMs + 1);
    await historyCode(historyCall(actor, 'getSession', historyRequest('getSession', null, session.id)), 'SESSION_EXPIRED', 410);
    await historyUntil(() => f.sources.handles.size === 0);
  }
  assert.ok(actor.resourceSnapshot().receipts <= 3); await actor.close(); f.reopenOwner();
  const cold = f.create(); await cold.initialize(); const prepares = f.sources.prepares;
  for (const row of expired) {
    const replay = await historyCall(cold, 'createSession', row.request); assert.equal(replay.status, 201); assert.deepEqual(replay.body, row.body);
    await historyCode(historyCall(cold, 'getSession', historyRequest('getSession', null, row.session.id)), 'SESSION_EXPIRED', 410);
    assert.equal((await historyCall(cold, 'closeSession', historyRequest('closeSession', null, row.session.id))).status, 204);
  }
  assert.equal(f.sources.prepares, prepares); assert.equal(f.sources.handles.size, 0);
});

test('历史归档：同key跨body/path/operation仍409，session旧epoch错误不变404，撤权beforeSend照常生效', async t => {
  const f = fixture(t), actor = f.create(), first = await cycle(f, actor, 10), second = await cycle(f, actor, 11);
  const active = await historyCreateSession(actor, 'history.scope.active');
  await historyCode(historyCall(actor, 'createSession', { ...first.originals[0]!.request,
    body: { clientInstanceId: 'history.changed.client' } }), 'IDEMPOTENCY_CONFLICT', 409);
  await historyCode(historyCall(actor, 'createResource', historyRequest('createResource', historyResourceRequest(), active.id,
    undefined, first.originals[0]!.request.idempotencyKey)), 'IDEMPOTENCY_CONFLICT', 409);
  await historyCode(historyCall(actor, 'createSession', historyRequest('createSession', { clientInstanceId: 'history.new.client' },
    undefined, undefined, second.originals[2]!.request.idempotencyKey)), 'IDEMPOTENCY_CONFLICT', 409);
  const p = historyPrincipal();
  await historyCode(historyCall(actor, 'createSession', first.originals[0]!.request, { ...p, datasetId: 'history.other.dataset' }), 'UNAUTHORIZED', 401);
  await historyCode(historyCall(actor, 'createSession', first.originals[0]!.request, { ...p, serverId: 'history.other.server' }), 'UNAUTHORIZED', 401);
  await historyCode(historyCall(actor, 'getSession', historyRequest('getSession', null, first.session.id), historyPrincipal('history.other.device')), 'INVALID_REQUEST', 404);
  const replay = await historyCall(actor, 'createSession', first.originals[0]!.request); await replay.beforeSend();
  f.devices.set(p.deviceId, 2);
  await historyCode(replay.beforeSend(), 'DEVICE_REVOKED', 403);
  await historyCode(historyCall(actor, 'getSession', historyRequest('getSession', null, first.session.id), historyPrincipal(p.deviceId, 2)), 'DEVICE_REVOKED', 403);
  assert.equal(f.sources.prepares, 2);
});

test('历史归档：冷UNKNOWN逐字段保留且永不重做，缺live资格不会从归档复活票据', async t => {
  const f = fixture(t), legacyActor = f.createLegacy(), session = await historyCreateSession(legacyActor, 'history.unknown.session');
  const intent = historyRequest('createResource', historyResourceRequest(), session.id, undefined, 'history.unknown.original');
  f.sources.failure = new MobilePlaybackError(409, 'SOURCE_CHANGED');
  const failed = await historyCall(legacyActor, 'createResource', intent); assert.equal(failed.status, 409);
  await historyCall(legacyActor, 'closeSession', historyRequest('closeSession', null, session.id)); await legacyActor.close();
  const saved = f.legacy.load(DATASET); assert.equal(saved.kind, 'sealed'); if (saved.kind !== 'sealed') throw new Error('缺少合成legacy状态。');
  const opened = f.crypto.open(saved.sealed, historyAad(saved.revision));
  const state = decodePlaybackStorage(opened, SERVER, DATASET, ORIGIN, MOBILE_PLAYBACK_DEFAULT_LIMITS).state; opened.fill(0);
  const receipt = state.receipts.find(value => value.operation === 'createResource')!;
  receipt.state = 'UNKNOWN'; receipt.reply = null; receipt.resourceContext = null;
  const unknown = structuredClone(receipt), resource = state.resources.find(value => value.id === receipt.resourceId)!;
  resource.state = 'terminal'; resource.failure = 'SERVICE_RESTARTED'; resource.media = null;
  state.revision++; state.commitId = randomUUID();
  const encoded = encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, MOBILE_PLAYBACK_DEFAULT_LIMITS);
  const sealed = f.crypto.seal(encoded.bytes, historyAad(state.revision)); encoded.bytes.fill(0);
  f.legacy.save({ datasetId: DATASET, expectedRevision: saved.revision, commitId: state.commitId, sealed }); sealed.fill(0);
  f.sources.failure = undefined;
  const actor = f.create(), next = await historyCreateSession(actor, 'history.unknown.next');
  await historyCall(actor, 'closeSession', historyRequest('closeSession', null, next.id));
  await historyCreateSession(actor, 'history.unknown.compact');
  const prepares = f.sources.prepares;
  for (let index = 0; index < 2; index++) await historyCode(historyCall(actor, 'createResource', intent), 'RESOURCE_BUSY', 503);
  assert.equal(f.sources.prepares, prepares);
  const loaded = f.owner().dispatch({ op: 'load', serverId: SERVER, datasetId: DATASET }); assert.equal(loaded.kind, 'loaded');
  if (loaded.kind !== 'loaded') throw new Error('缺少Owner头。');
  const key = historyLookupKey('receipt', SERVER, DATASET, { deviceId: receipt.deviceId, deviceEpoch: receipt.deviceEpoch, keyHash: receipt.keyHash });
  const proof = f.owner().dispatch({ op: 'lookup', serverId: SERVER, datasetId: DATASET, expected: loaded.token, key });
  assert.equal(proof.kind, 'proof'); if (proof.kind !== 'proof') throw new Error('缺少归档proof。');
  assert.equal(verifyPlaybackHistoryProof(loaded.token.indexRoot, key, proof.proof).kind, 'present'); assert.ok(proof.archive);
  const plain = f.crypto.open(proof.archive.sealed, playbackHistorySnapshotAad(SERVER, DATASET, proof.archive.snapshot.revision));
  try { const archived = decodePlaybackStorage(plain, SERVER, DATASET, ORIGIN, MOBILE_PLAYBACK_DEFAULT_LIMITS).state;
    assert.deepEqual(archived.receipts.find(value => value.id === unknown.id), unknown); }
  finally { plain.fill(0); }
});

test('历史归档：迟到prepare和真实release未quiet不归档，204前不能提前释放容量', async t => {
  const f = fixture(t, { prepareTimeoutMs: 15, readyWaitMs: 1 }), actor = f.create();
  const session = await historyCreateSession(actor, 'history.late.session');
  f.sources.prepareGate = historyDeferred(); f.sources.releaseGate = historyDeferred();
  const failed = await historyCall(actor, 'createResource', historyRequest('createResource', historyResourceRequest(), session.id, undefined, 'history.late.original'));
  assert.equal(failed.status, 429); assert.equal(f.sources.handles.size, 1);
  let closed = false;
  const closing = historyCall(actor, 'closeSession', historyRequest('closeSession', null, session.id)).then(value => { closed = true; return value; });
  const current = await historyCreateSession(actor, 'history.late.current');
  await historyCode(historyCreateSession(actor, 'history.late.full'), 'RESOURCE_BUSY', 429);
  assert.equal(closed, false);
  const before = f.owner().dispatch({ op: 'load', serverId: SERVER, datasetId: DATASET }); assert.equal(before.kind, 'loaded');
  if (before.kind !== 'loaded') throw new Error('缺少Owner头。'); assert.equal(before.token.indexRoot, null);
  f.sources.prepareGate.resolve(); await delay(5); assert.equal(closed, false); assert.equal(f.sources.handles.size, 1);
  f.sources.releaseGate.resolve(); assert.equal((await closing).status, 204); assert.equal(f.sources.handles.size, 0);
  const after = await historyCreateSession(actor, 'history.late.after-quiet');
  await historyCall(actor, 'closeSession', historyRequest('closeSession', null, current.id));
  await historyCall(actor, 'closeSession', historyRequest('closeSession', null, after.id));
  const head = f.owner().dispatch({ op: 'load', serverId: SERVER, datasetId: DATASET });
  assert.equal(head.kind, 'loaded'); if (head.kind === 'loaded') assert.ok(head.token.indexRoot);
});

test('历史归档：真实read迟回必须丢弃，reader关闭前旧组仍占热容量且DELETE不早ACK', async t => {
  const f = fixture(t, { maxReceipts: 2 }), actor = f.create(), session = await historyCreateSession(actor, 'history.read.session');
  const ready = await historyReady(actor, session, 'history.read.resource'), url = new URL(ready.media.url);
  const media = await actor.openMedia('getMediaAsset', { path: url.pathname, pathParameters: { resourceId: ready.id, asset: 'source' },
    query: { ticket: url.searchParams.get('ticket')! }, body: null }, new AbortController().signal);
  assert.ok(media.reader); f.sources.readGate = historyDeferred(); f.sources.closeReadGate = historyDeferred();
  const reading = media.reader.read(64).then(value => ({ value }), error => ({ error })); await historyUntil(() => f.sources.reads === 1);
  let closed = false;
  const closing = historyCall(actor, 'closeSession', historyRequest('closeSession', null, session.id)).then(value => { closed = true; return value; });
  await historyCode(historyCreateSession(actor, 'history.read.full'), 'RESOURCE_BUSY', 429);
  assert.equal(closed, false); assert.equal(f.sources.readers.size, 1);
  f.sources.readGate.resolve(); const outcome = await reading; assert.ok('error' in outcome, '撤销后的迟回bytes不能继续发送。');
  assert.equal(closed, false); assert.equal(f.sources.readers.size, 1); f.sources.closeReadGate.resolve();
  assert.equal((await closing).status, 204); await media.close(); assert.equal(f.sources.readers.size, 0); assert.equal(f.sources.handles.size, 0);
  await historyCreateSession(actor, 'history.read.after-quiet');
});

test('历史归档：活跃receipt/resource/session原帽不因有归档端口而放宽，静止后才可腾位', async t => {
  for (const kind of ['receipts', 'resources', 'sessions'] as const) await t.test(kind, async t => {
    const f = fixture(t, kind === 'sessions' ? { maxStoredSessions: 1, maxLiveSessions: 1, maxSessionsPerDevice: 1 }
      : kind === 'resources' ? { maxStoredResources: 1, maxLiveResources: 1 } : { maxReceipts: 2 });
    const actor = f.create(), session = await historyCreateSession(actor, `history.cap.${kind}.session`);
    if (kind === 'sessions') await historyCode(historyCreateSession(actor, 'history.cap.session.extra'), 'RESOURCE_BUSY', 429);
    else {
      await historyReady(actor, session, `history.cap.${kind}.resource`);
      if (kind === 'receipts') await historyCode(historyCreateSession(actor, 'history.cap.receipt.extra'), 'RESOURCE_BUSY', 429);
      else await historyCode(historyCall(actor, 'createResource', historyRequest('createResource', historyResourceRequest('history.new.track'),
        session.id, undefined, 'history.cap.resource.extra')), 'RESOURCE_BUSY', 429);
    }
    const count = f.sources.prepares; await historyCall(actor, 'closeSession', historyRequest('closeSession', null, session.id));
    await historyCreateSession(actor, `history.cap.${kind}.after-quiet`); assert.equal(f.sources.prepares, count);
  });
});

test('历史归档：缺proof/locator/密文或错scope不降格为absence，不重执行原create', async t => {
  const f = fixture(t), seed = f.create(), first = await cycle(f, seed, 30); await cycle(f, seed, 31); await seed.close();
  const prepares = f.sources.prepares;
  for (const mode of ['empty', 'missing-node', 'missing-locator', 'wrong-store', 'wrong-key', 'cipher', 'snapshot', 'lookup-lost'] as const) {
    const actor = f.create(); await actor.initialize();
    f.intercept((request, reply) => {
      if (request.op !== 'lookup' || reply.kind !== 'proof') return reply;
      if (mode === 'lookup-lost') throw new MobileAuthPersistenceError('unknown');
      if (mode === 'empty') return { ...reply, proof: [], locator: null, archive: null };
      if (mode === 'missing-node') return { ...reply, proof: reply.proof.slice(0, -1), locator: null, archive: null };
      if (mode === 'missing-locator') return { ...reply, locator: null, archive: null };
      if (mode === 'wrong-store') return { ...reply, token: { ...reply.token, storeId: randomUUID() } };
      if (mode === 'wrong-key') return { ...reply, key: 'f'.repeat(64) };
      assert.ok(reply.archive);
      if (mode === 'cipher') { reply.archive.sealed[0] = reply.archive.sealed[0]! ^ 1; return reply; }
      return { ...reply, archive: { ...reply.archive, snapshot: { ...reply.archive.snapshot, commitId: randomUUID() } } };
    });
    await historyCode(historyCall(actor, 'createSession', first.originals[0]!.request), 'BUSY', 503);
    assert.equal(f.sources.prepares, prepares); f.intercept(undefined); await actor.close();
  }
  const cold = f.create(), replay = await historyCall(cold, 'createSession', first.originals[0]!.request);
  assert.equal(replay.status, 201); assert.deepEqual(replay.body, first.originals[0]!.body); assert.equal(f.sources.prepares, prepares);
});

test('历史归档：NetEase原成功正文完整保存，但已关闭runtime和撤权都不能由历史重新授权', async t => {
  const f = fixture(t), actor = f.create(); f.sources.netease = true;
  const first = await cycle(f, actor, 40); await cycle(f, actor, 41);
  const original = first.originals[1]!, replay = await historyCall(actor, original.operation, original.request);
  assert.equal(replay.status, original.status); assert.deepEqual(replay.body, original.body); assert.deepEqual(replay.resourceContext, original.context);
  await historyCode(replay.beforeSend(), 'SOURCE_CHANGED', 409);
  f.devices.delete(historyPrincipal().deviceId); await historyCode(replay.beforeSend(), 'DEVICE_REVOKED', 403);
  assert.equal(f.sources.prepares, 2); assert.equal(f.sources.handles.size, 0);
});

test('历史归档：真实Owner提交丢ACK仅原attempt核对，未确认不发布且同key不重做', async t => {
  const f = fixture(t), actor = f.create(); await actor.initialize();
  const operations: string[] = []; let committed: Extract<PlaybackHistoryRequest, { op: 'commit' }> | undefined;
  let mode: 'lose-ack' | 'unconfirmed' | 'wrong-head' | 'confirm' = 'lose-ack';
  f.intercept((request, reply) => {
    operations.push(request.op);
    if (request.op === 'commit') {
      assert.equal(request.mode, 'advance'); assert.equal(committed, undefined, '丢ACK后不能另起或重发commit。');
      assert.equal(reply.kind, 'committed'); committed = request; throw new MobileAuthPersistenceError('unknown');
    }
    if (request.op === 'read-commit') {
      assert.ok(committed); assert.equal(request.attemptId, committed.attemptId);
      assert.deepEqual(request.expected, committed.expected); assert.deepEqual(request.next, committed.next.token);
      if (mode === 'unconfirmed') return { kind: 'unconfirmed', token: request.expected, attemptId: request.attemptId };
      if (mode === 'wrong-head') return { kind: 'committed', token: { ...request.next, storeId: randomUUID() }, attemptId: request.attemptId };
    }
    return reply;
  });
  const request = historyRequest('createSession', { clientInstanceId: 'history.ack.client' }, undefined, undefined, 'history.ack.original');
  await historyCode(historyCall(actor, 'createSession', request), 'BUSY', 503);
  assert.ok(committed); assert.equal(actor.resourceSnapshot().pendingPersistence, true);
  assert.equal(actor.resourceSnapshot().receipts, 0); assert.equal(f.sources.prepares, 0);
  const durable = f.owner().dispatch({ op: 'load', serverId: SERVER, datasetId: DATASET });
  assert.ok(durable.kind === 'loaded' && durable.hot.kind === 'sealed');
  const plain = f.crypto.open(durable.hot.sealed, historyAad(durable.hot.revision));
  let body: unknown;
  try { body = decodePlaybackStorage(plain, SERVER, DATASET, ORIGIN, MOBILE_PLAYBACK_DEFAULT_LIMITS).state.receipts[0]!.reply!.body; }
  finally { plain.fill(0); }
  for (const fault of ['unconfirmed', 'wrong-head'] as const) {
    mode = fault;
    await assert.rejects(historyCall(actor, 'createSession', request), error => {
      assert.ok(error instanceof MobileAuthPersistenceError);
      assert.equal(error.outcome, fault === 'unconfirmed' ? 'unknown' : 'not-sent');
      const publicFailure = safeMobilePlaybackFailure(error);
      assert.equal(publicFailure.status, 503); assert.equal(publicFailure.code, 'BUSY'); return true;
    });
    assert.equal(actor.resourceSnapshot().pendingPersistence, true); assert.equal(actor.resourceSnapshot().receipts, 0);
  }
  mode = 'confirm'; const replay = await historyCall(actor, 'createSession', request);
  assert.equal(replay.status, 201); assert.deepEqual(replay.body, body); await replay.beforeSend();
  assert.equal(actor.resourceSnapshot().pendingPersistence, false); assert.equal(actor.resourceSnapshot().receipts, 1);
  assert.equal(f.sources.prepares, 0); assert.deepEqual(operations, ['lookup', 'commit', 'read-commit', 'read-commit', 'read-commit', 'load']);
  f.intercept(undefined);
});
