import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test, { type TestContext } from 'node:test';
import { decodeMobileRequest, type MobileContentReadContext, type MobileHeaderPairs, type MobileWireCodecContext } from '@music-bridge/contracts';
import { captureMobileContentReply } from '../../src/mobile/content-protocol.js';
import { captureMobileContentCoreRequest, captureMobileContentCoreResponse, mobileContentRpcFailure, type MobileContentCoreRequest,
  type MobileContentCoreResponse } from '../../src/mobile/content-rpc.js';
import { createMobileContentRpcPort, type MobileContentRpcPortOptions } from '../../src/mobile/content-rpc-port.js';
import type { MobileContentOperation, MobileContentPort, MobileContentScope, MobileContentServiceInput, MobileContentSnapshot } from '../../src/mobile/content-types.js';
import { MobileAuthPersistenceError, MobileServiceError } from '../../src/mobile/types.js';
import { MobileContentPersistenceError } from '../../src/mobile/content-owner-store.js';
import { MobilePlaybackError } from '../../src/mobile/playback-types.js';

const scope: Readonly<MobileContentScope> = Object.freeze({ serverId: 'server.fixture.1', datasetId: 'dataset.fixture.1',
  deviceId: 'device.fixture.1', deviceEpoch: 1, accessGeneration: 1, ownerEpoch: 'owner.fixture.1',
  accountDomain: 'account.fixture.1', providerEpoch: 'provider.fixture.1' });
const principal = { serverId: scope.serverId, datasetId: scope.datasetId, deviceId: scope.deviceId,
  deviceEpoch: scope.deviceEpoch, accessGeneration: scope.accessGeneration };
interface Body { fileName: string; bytes: number; sha256: string }
interface Row { operationId: string; role: string; context: string; method: string; path: string;
  request: { headers: MobileHeaderPairs; query: MobileHeaderPairs; body: Body | null }; response: { status: number; body: Body } }
const directory = new URL('../../../contracts/mobile/fixtures/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', directory), 'utf8')) as { cases: Row[]; contexts: Record<string, MobileWireCodecContext> };
function whole(file: Body | null): Uint8Array {
  if (!file) return new Uint8Array();
  assert.match(file.fileName, /^bodies\/[A-Za-z0-9_.-]+$/u);
  const body = new Uint8Array(readFileSync(new URL(file.fileName, directory)));
  assert.equal(body.length, file.bytes); assert.equal(createHash('sha256').update(body).digest('hex'), file.sha256); return body;
}
function fixture<O extends MobileContentOperation>(operation: O, actualScope = scope) {
  const row = manifest.cases.find(value => value.operationId === operation && value.role === 'DECLARED_SUCCESS'); assert.ok(row);
  const context = manifest.contexts[row.context]; assert.ok(context?.content);
  const decoded = decodeMobileRequest(operation, { method: row.method, path: row.path, headers: row.request.headers,
    query: row.request.query, body: whole(row.request.body) }, context); assert.ok(decoded.ok);
  const trusted: MobileContentReadContext = { ...structuredClone(context.content), serverId: actualScope.serverId,
    deviceId: actualScope.deviceId, accountDomain: actualScope.accountDomain,
    ...(operation === 'listPersonalPlaylists' ? { pageOffset: 0 } : {}) };
  return { request: decoded.value, ...captureMobileContentReply(operation, decoded.value, actualScope,
    { status: row.response.status, category: 'success', body: JSON.parse(new TextDecoder().decode(whole(row.response.body))) as unknown }, trusted) };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const base = () => ({ type: 'mobile-content-core-request' as const, id: randomUUID() });
const signal = () => new AbortController().signal;
function failure(result: MobileContentCoreResponse, code = 'BUSY', outcome: 'unknown' | 'not-sent' | null = null): void {
  assert.ok('kind' in result && result.kind === 'error'); assert.equal(result.code, code); assert.equal(result.outcome, outcome);
  assert.equal(result.retryable, false); assert.deepEqual(Object.keys(result).sort(), ['type', 'id', 'action', 'kind', 'status', 'code', 'retryable', 'outcome'].sort());
}
function port(effect?: (input: MobileContentServiceInput) => void | Promise<void>): MobileContentPort {
  return { async dispatch<O extends MobileContentOperation>(input: MobileContentServiceInput<O>) {
    await effect?.(input); const facts = fixture(input.operation, input.scope);
    return { operation: input.operation, scope: input.scope, reply: facts.reply, context: facts.context, beforeSend: async () => undefined };
  } };
}
async function harness(t: TestContext, extra: Partial<MobileContentRpcPortOptions> = {}) {
  let initCalls = 0;
  const rpc = createMobileContentRpcPort({ initialize: async input => {
    initCalls++; assert.equal(input.serverId, scope.serverId); assert.equal(input.datasetId, scope.datasetId); assert.equal(input.key.byteLength, 32);
  }, invalidateDevice: async () => undefined, content: port(), resolveScope: async identity => ({ ...scope, ...identity }),
    assertScope: () => undefined, source: async () => { throw new MobileServiceError(409, 'UNSUPPORTED_FORMAT'); }, ...extra });
  const key = new Uint8Array(32).fill(19);
  const initialized = await rpc.request({ ...base(), action: 'initialize', serverId: scope.serverId, datasetId: scope.datasetId, key }, signal());
  assert.ok(initialized.action === 'initialize' && 'ok' in initialized && initialized.ok);
  t.after(() => rpc.close());
  return { rpc, key, initCalls: () => initCalls,
    dispatch: (operation: MobileContentOperation, parent = signal(), actualScope = scope) => {
      const request: MobileContentCoreRequest = { ...base(), action: 'dispatch', operation, scope: actualScope, request: fixture(operation, actualScope).request };
      return { request, promise: rpc.request(request, parent) };
    } };
}

test('可信初始化共用一次密钥投递，原五轴 Scope 闭集与真实资格分别返回', async t => {
  const h = await harness(t, { neteasePlaybackQualified: async () => true });
  const repeat = await h.rpc.request({ ...base(), action: 'initialize', serverId: scope.serverId, datasetId: scope.datasetId, key: h.key }, signal());
  assert.ok(repeat.action === 'initialize' && 'ok' in repeat && repeat.ok); assert.equal(h.initCalls(), 1);
  const result = await h.rpc.request({ ...base(), action: 'scope', principal }, signal());
  assert.ok(result.action === 'scope' && 'kind' in result && result.kind === 'scope');
  assert.deepEqual({ ...result.scope }, scope); assert.equal(result.neteasePlayback, true);
  const wrong = await h.rpc.request({ ...base(), action: 'initialize', serverId: scope.serverId, datasetId: scope.datasetId, key: new Uint8Array(32).fill(20) }, signal());
  failure(wrong, 'SOURCE_CHANGED'); assert.equal(h.initCalls(), 1);
});

test('私有请求与回应拒绝 token、getter、假状态类型、额外密钥和不匹配 id/action', async () => {
  let getters = 0;
  const request = { ...base(), action: 'scope', principal };
  for (const raw of [{ ...request, token: 'synthetic-private-token' }, { ...request, principal: { ...principal, accountDomain: scope.accountDomain } }]) {
    assert.throws(() => captureMobileContentCoreRequest(raw), MobileServiceError);
  }
  const accessor = { ...base() }; Object.defineProperty(accessor, 'action', { enumerable: true, get() { getters++; return 'scope'; } });
  assert.throws(() => captureMobileContentCoreRequest(accessor), MobileServiceError); assert.equal(getters, 0);
  const captured = captureMobileContentCoreRequest(request);
  const valid = { type: 'mobile-content-core-response', id: captured.id, action: 'scope', kind: 'scope', scope, neteasePlayback: false };
  for (const raw of [{ ...valid, key: new Uint8Array(32) }, { ...valid, id: randomUUID() }, { ...valid, action: 'dispatch' },
    { type: valid.type, id: valid.id, action: valid.action, kind: 'error', status: '503', code: 'BUSY', retryable: false, outcome: null }]) {
    assert.throws(() => captureMobileContentCoreResponse(raw, captured), MobileAuthPersistenceError);
  }
  const expired = mobileContentRpcFailure(captured, new MobilePlaybackError(410, 'RESOURCE_EXPIRED'));
  failure(expired, 'RESOURCE_EXPIRED'); assert.equal(expired.status, 410);
});

test('完整原回包发送前只读重验一次，外域 snapshot 和再用 nonce 不执行第二次写入', async t => {
  let dispatches = 0, verifies = 0;
  const content: MobileContentPort = { async dispatch<O extends MobileContentOperation>(input: MobileContentServiceInput<O>) {
    dispatches++; const data = fixture(input.operation, input.scope);
    return { operation: input.operation, scope: input.scope, reply: data.reply, context: data.context, beforeSend: async () => { verifies++; } };
  } };
  const h = await harness(t, { content }), result = await h.dispatch('setAlbumFavorite').promise;
  assert.ok(result.action === 'dispatch' && 'kind' in result && result.kind === 'snapshot');
  const wrong = await h.rpc.request({ ...base(), action: 'revalidate', snapshotId: result.snapshotId, scope: { ...scope, deviceId: 'other.device' } }, signal());
  failure(wrong, 'SOURCE_CHANGED'); assert.equal(verifies, 0);
  const ack = await h.rpc.request({ ...base(), action: 'revalidate', snapshotId: result.snapshotId, scope }, signal());
  assert.ok(ack.action === 'revalidate' && 'kind' in ack && ack.kind === 'validated');
  failure(await h.rpc.request({ ...base(), action: 'revalidate', snapshotId: result.snapshotId, scope }, signal()), 'SOURCE_CHANGED');
  assert.equal(dispatches, 1); assert.equal(verifies, 1);
});

test('候选完整正文、context或原校验回调被替换时快照不能发送', async t => {
  for (const mutation of ['context', 'callback'] as const) {
    let candidate: MobileContentSnapshot | undefined;
    const content: MobileContentPort = { async dispatch<O extends MobileContentOperation>(input: MobileContentServiceInput<O>) {
      const data = fixture(input.operation, input.scope);
      const snapshot: MobileContentSnapshot<O> = { operation: input.operation, scope: input.scope, reply: data.reply, context: data.context, beforeSend: async () => undefined };
      candidate = snapshot; return snapshot;
    } };
    const h = await harness(t, { content }); const result = await h.dispatch('listPersonalPlaylists').promise;
    assert.ok(result.action === 'dispatch' && 'kind' in result && result.kind === 'snapshot'); assert.ok(candidate);
    if (mutation === 'context') candidate.context = { ...candidate.context, pageOffset: 1 };
    else candidate.beforeSend = async () => undefined;
    failure(await h.rpc.request({ ...base(), action: 'revalidate', snapshotId: result.snapshotId, scope }, signal()));
  }
});

test('取消原id只封输出并等真实静止，迟到回包不能释放未quiet槽位或形成快照', async t => {
  const entered = deferred(), release = deferred(); let aborted = false, calls = 0;
  t.after(() => release.resolve());
  const h = await harness(t, { content: port(async input => {
    calls++; input.signal.addEventListener('abort', () => { aborted = true; }, { once: true }); entered.resolve(); await release.promise;
  }), maxInflight: 2 });
  const controller = new AbortController(), pending = h.dispatch('listPersonalPlaylists', controller.signal);
  await entered.promise; controller.abort(); failure(await pending.promise, 'BUSY', 'unknown');
  failure(await h.dispatch('listPersonalPlaylists').promise); assert.equal(calls, 1); assert.equal(aborted, true);
  let quiet = false;
  const cancelled = h.rpc.request({ ...base(), action: 'cancel', requestId: pending.request.id, snapshotId: null, scope }, signal()).then(value => { quiet = true; return value; });
  await Promise.resolve(); assert.equal(quiet, false);
  release.resolve(); const result = await cancelled;
  assert.ok(result.action === 'cancel' && 'kind' in result && result.kind === 'cancelled' && result.quiet); assert.equal(calls, 1);
});

test('设备撤销先建立 epoch tombstone，原 Provider 等待静止后 ACK且旧epoch永不重新登记', async t => {
  const entered = deferred(), release = deferred(), invalidated = deferred(); let writes = 0;
  t.after(() => release.resolve());
  const h = await harness(t, { content: port(async input => { entered.resolve(); await release.promise; if (!input.signal.aborted) writes++; }),
    invalidateDevice: async () => { invalidated.resolve(); } });
  const pending = h.dispatch('listPersonalPlaylists'); await entered.promise;
  const revocation = h.rpc.request({ ...base(), action: 'invalidate-device', ...principal,
    // action 的闭集不包含 accessGeneration。
  } as unknown, signal());
  await assert.rejects(revocation, MobileServiceError);
  const revoked = h.rpc.request({ ...base(), action: 'invalidate-device', serverId: scope.serverId, datasetId: scope.datasetId,
    deviceId: scope.deviceId, deviceEpoch: scope.deviceEpoch }, signal());
  await invalidated.promise;
  failure(await h.rpc.request({ ...base(), action: 'scope', principal }, signal()), 'UNAUTHORIZED');
  release.resolve(); const ack = await revoked; assert.ok(ack.action === 'invalidate-device' && 'ok' in ack && ack.ok);
  failure(await pending.promise, 'BUSY', 'unknown'); assert.equal(writes, 0);
  failure(await h.rpc.request({ ...base(), action: 'scope', principal }, signal()), 'UNAUTHORIZED');
});

test('Source原块守卫和外层来源精确保持，lease分支仍使用原Scope而不改accessGeneration', async t => {
  const handle = randomUUID(), readId = randomUUID(), leases: string[] = [];
  const h = await harness(t, { assertScope: (_scope, stage) => { leases.push(stage); }, source: async (_scope, request) => {
    assert.equal(_scope.accessGeneration, 1);
    if (request.operation !== 'read') throw new MobileServiceError(409, 'UNSUPPORTED_FORMAT');
    return { source: 'netease', result: { kind: 'mobile-source-read', handle: request.handle, readId: request.readId,
      start: request.start, bytes: new Uint8Array([2, 3, 5, 7]) } };
  } });
  const input = { ...base(), action: 'source' as const, scope,
    request: { operation: 'read' as const, handle, readId, start: 0, maxBytes: 4 } };
  const result = await h.rpc.request(input, signal());
  assert.ok(result.action === 'source' && 'kind' in result && result.kind === 'source' && result.result.kind === 'mobile-source-read');
  assert.equal(result.source, 'netease'); assert.deepEqual(result.result.bytes, new Uint8Array([2, 3, 5, 7])); assert.deepEqual(leases, ['lease', 'lease']);
  assert.throws(() => captureMobileContentCoreRequest({ ...input, request: { ...input.request, maxBytes: 65_537 } }), MobileServiceError);
  assert.throws(() => captureMobileContentCoreResponse({ ...result, result: { ...result.result, bytes: new Uint8Array(5) } }, input), MobileAuthPersistenceError);
});

test('UNKNOWN保存原四写结果分类且不重投，未quiet关闭和短期限不会冒充成功收口', async () => {
  const entered = deferred(), release = deferred(); let dispatches = 0;
  const rpc = createMobileContentRpcPort({ initialize: async () => undefined, invalidateDevice: async () => undefined,
    resolveScope: async () => scope, assertScope: () => undefined, source: async () => { throw new MobileServiceError(503, 'BUSY'); },
    content: port(async () => { dispatches++; entered.resolve(); await release.promise;
      throw new MobileContentPersistenceError('unknown', randomUUID());
    }), requestMs: 20, closeMs: 20, maxInflight: 1 });
  await rpc.request({ ...base(), action: 'initialize', serverId: scope.serverId, datasetId: scope.datasetId, key: new Uint8Array(32) }, signal());
  const mutation: MobileContentCoreRequest = { ...base(), action: 'dispatch', operation: 'setAlbumFavorite', scope, request: fixture('setAlbumFavorite').request };
  const pending = rpc.request(mutation, signal()); await entered.promise;
  failure(await pending, 'BUSY', 'unknown'); failure(await rpc.request(mutation, signal()), 'BUSY', 'unknown'); assert.equal(dispatches, 1);
  assert.equal(Object.hasOwn(await pending, 'commitId'), false);
  try { await assert.rejects(rpc.close(), MobileAuthPersistenceError); } finally { release.resolve(); }
  for (const options of [{ requestMs: 10_001 }, { closeMs: 10_001 }, { maxInflight: 17 }, { maxSnapshots: 17 }]) {
    assert.throws(() => createMobileContentRpcPort({ initialize: async () => undefined, invalidateDevice: async () => undefined,
      content: port(), resolveScope: async () => scope, assertScope: () => undefined, source: async () => { throw new MobileServiceError(503, 'BUSY'); }, ...options }), MobileServiceError);
  }
});
