import assert from 'node:assert/strict';
import { createHash, hkdfSync, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test, { type TestContext } from 'node:test';
import {
  IPC_VERSION, MOBILE_OPERATION_TABLE, MOBILE_RESOURCE_SCHEMAS, decodeMobileRequest, decodeMobileResponse,
  isMobileResource, isMobileUIContentCapabilities, mobileCanonicalJson, mobileDataSnapshot, mobileSchemaSnapshot,
  type MobileContentReadContext, type MobileDecodedRequest, type MobileHeaderPairs, type MobileOperationId,
  type MobileReplyMap, type MobileResourceRequest, type MobileSession, type MobileWireCodecContext,
} from '@music-bridge/contracts';
import { createMobileBackend } from '../src/main/mobile-backend.js';
import { createMainMobileContentPort } from '../src/main/mobile-content-port.js';
import type { MobileContentBackendReply } from '../src/main/mobile-content-backend.js';
import { CoreSupervisor, type CoreChildProcess, type CoreMessagePort } from '../src/main/core-supervisor.js';
import { createMobileContentRpcPort } from '../../../packages/bridge-core/src/mobile/content-rpc-port.js';
import { mobileContentRpcFailure, type MobileContentCoreRequest,
  type MobileContentMainPrincipal } from '../../../packages/bridge-core/src/mobile/content-rpc.js';
import { captureMobileContentReply } from '../../../packages/bridge-core/src/mobile/content-protocol.js';
import { MobileContentPersistenceError } from '../../../packages/bridge-core/src/mobile/content-owner-store.js';
import { MOBILE_CONTENT_OPERATIONS, type MobileContentOperation, type MobileContentPort,
  type MobileContentScope, type MobileContentServiceInput } from '../../../packages/bridge-core/src/mobile/content-types.js';
import { isMobileOwnerPrivateRequest, isMobileOwnerPrivateResult } from '../../../packages/bridge-core/src/mobile/owner-protocol.js';
import { MobileAuthPersistenceError, MobileServiceError, type MobileOwnerPrivateRequest,
  type MobileOwnerPrivateResult, type MobileSealedState } from '../../../packages/bridge-core/src/mobile/types.js';
import type { Mobile002BackendReply, Mobile002Operation } from '../src/main/mobile-playback-backend.js';

const SERVER = 'server.fixture.1', DATASET = 'dataset.fixture.1', ORIGIN = 'https://127.0.0.1:9443';
const ACCOUNT = 'account.fixture.1';
interface BodyFile { fileName: string; bytes: number; sha256: string }
interface Row { operationId: string; role: string; context: string; method: string; path: string;
  request: { headers: MobileHeaderPairs; query: MobileHeaderPairs; body: BodyFile | null }; response: { status: number; body: BodyFile } }
const directory = new URL('../../../packages/contracts/mobile/fixtures/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', directory), 'utf8')) as { cases: Row[]; contexts: Record<string, MobileWireCodecContext> };
const paged = new Set<MobileContentOperation>(['listRecentlyAddedAlbums', 'listNeteaseLikedPlaylistTracks', 'listFavoriteAlbums',
  'listFavoriteAlbumTracks', 'listPersonalPlaylists', 'listPersonalPlaylistTracks', 'listNeteaseRecommendedPlaylists',
  'listNeteaseNewAlbums', 'listNeteaseCharts', 'getNeteaseDiscoveryCollectionTracks']);
const signal = () => new AbortController().signal;
const base = () => ({ type: 'mobile-content-core-request' as const, id: randomUUID() });
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
function canonical(value: unknown): string { const captured = mobileDataSnapshot(value); assert.ok(captured.ok); return mobileCanonicalJson(captured.value); }
function whole(file: BodyFile | null): Uint8Array {
  if (!file) return new Uint8Array();
  assert.match(file.fileName, /^bodies\/[A-Za-z0-9_.-]+$/u);
  const bytes = new Uint8Array(readFileSync(new URL(file.fileName, directory)));
  assert.equal(bytes.byteLength, file.bytes); assert.equal(hash(bytes), file.sha256); return bytes;
}
function contentFixture<O extends MobileContentOperation>(operation: O, scope: Readonly<MobileContentScope>) {
  const row = manifest.cases.find(value => value.operationId === operation && value.role === 'DECLARED_SUCCESS'); assert.ok(row);
  const context = manifest.contexts[row.context]; assert.ok(context?.content);
  const request = decodeMobileRequest(operation, { method: row.method, path: row.path, headers: row.request.headers,
    query: row.request.query, body: whole(row.request.body) }, context); assert.ok(request.ok);
  const trusted: MobileContentReadContext = { ...structuredClone(context.content), serverId: scope.serverId,
    deviceId: scope.deviceId, accountDomain: scope.accountDomain, ...(paged.has(operation) ? { pageOffset: 0 } : {}),
    ...(operation === 'listNeteaseRecommendedPlaylists' || operation === 'listNeteaseCharts' ? { source: 'netease' as const } : {}),
    ...(operation === 'setTrackFavorite' ? { selection: { trackId: 'local:track.1', source: 'local' as const, versionId: 'local:version.1', contentRevision: 'rev.1' } }
      : operation === 'addPersonalPlaylistTrack' ? { selection: { trackId: 'local:track.2', source: 'local' as const, versionId: 'local:version.2', contentRevision: 'rev.1' } } : {}) };
  return { request: request.value, ...captureMobileContentReply(operation, request.value, scope,
    { status: row.response.status, category: 'success', body: JSON.parse(new TextDecoder().decode(whole(row.response.body))) as unknown }, trusted) };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function refuses(promise: Promise<unknown>, status: number, code: string, outcome?: string) {
  return assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof MobileServiceError); assert.equal(error.status, status); assert.equal(error.code, code);
    if (outcome !== undefined) assert.equal(Object.getOwnPropertyDescriptor(error, 'outcome')?.value, outcome);
    assert.equal(Object.hasOwn(error, 'commitId'), false); assert.equal(Object.hasOwn(error, 'cause'), false); return true;
  });
}

/** 真Main/auth/actor/私有RPC/完整codec；Owner持久化与来源事实为受控内存端口，不声称FD或Provider。 */
async function fixture(t: TestContext, enableContent = true) {
  const key = new Uint8Array(32).fill(73), keys: Uint8Array[] = [], rpcCalls: MobileContentCoreRequest[] = [];
  const scopes = new Map<string, Readonly<MobileContentScope>>(), revoked = new Map<string, number>();
  const stored: { auth: MobileSealedState; playback: MobileSealedState } = {
    auth: { kind: 'missing', datasetId: DATASET, revision: 0 }, playback: { kind: 'missing', datasetId: DATASET, revision: 0 } };
  const state = { accountDomain: ACCOUNT, providerEpoch: 'provider.fixture.1', ownerEpoch: 'owner.fixture.1',
    qualified: true, initCalls: 0, dispatches: 0, verifies: 0, begins: 0, releases: 0,
    effect: undefined as ((input: MobileContentServiceInput) => void | Promise<void>) | undefined,
    invalidationWait: undefined as Promise<void> | undefined };
  const enteredInvalidation = deferred(), releaseHooks = new Set<() => void>(), sourceScopes: Readonly<MobileContentScope>[] = [];
  const mediaBytes = new Uint8Array([102, 76, 97, 67, ...Array.from({ length: 92 }, (_, i) => i)]);
  const audio = { codec: 'flac', container: 'flac', sampleRateHz: 44_100, bitsPerSample: 16, channels: 2 };
  const content: MobileContentPort = { async dispatch<O extends MobileContentOperation>(input: MobileContentServiceInput<O>) {
    state.dispatches++; await state.effect?.(input); const facts = contentFixture(input.operation, input.scope);
    return { operation: input.operation, scope: input.scope, reply: facts.reply, context: facts.context, beforeSend: async () => { state.verifies++; } };
  } };
  const rpc = createMobileContentRpcPort({ initialize: async input => { state.initCalls++; keys.push(input.key);
    assert.equal(hash(input.key), hash(new Uint8Array(hkdfSync('sha256', key, new Uint8Array(), 'MusicBridge:MBM004:CONTENT_ROOT:1', 32)))); },
    invalidateDevice: async input => { revoked.set(input.deviceId, input.deviceEpoch); enteredInvalidation.resolve(); await state.invalidationWait; },
    resolveScope: async principal => { const scope = { ...principal, ownerEpoch: state.ownerEpoch,
      accountDomain: state.accountDomain, providerEpoch: state.providerEpoch }; scopes.set(principal.deviceId, scope); return scope; },
    assertScope: (scope, stage) => {
      const latest = scopes.get(scope.deviceId);
      if (!latest || (revoked.get(scope.deviceId) ?? 0) >= scope.deviceEpoch) throw new MobileServiceError(401, 'UNAUTHORIZED');
      if (scope.accountDomain !== state.accountDomain || scope.providerEpoch !== state.providerEpoch || scope.ownerEpoch !== state.ownerEpoch
        || stage === 'acquire' && latest.accessGeneration !== scope.accessGeneration) throw new MobileServiceError(409, 'SOURCE_CHANGED');
    }, content, neteasePlaybackQualified: async () => state.qualified,
    source: async (scope, request) => {
      sourceScopes.push(scope);
      if (request.operation === 'prepare') { state.begins++; return { source: 'netease', result: { kind: 'mobile-source-prepared', source: {
        handle: request.selection.resourceId, sourceAudio: audio, actualAudio: audio, processing: { mode: 'direct', reason: '当前 Provider 精确来源的直接只读传输。', fromPreparedCache: false },
        contentType: 'audio/flac', size: mediaBytes.byteLength, durationMs: 1000, seekable: true } } }; }
      if (request.operation === 'read') return { source: 'netease', result: { kind: 'mobile-source-read', handle: request.handle,
        readId: request.readId, start: request.start, bytes: new Uint8Array(mediaBytes.subarray(request.start, request.start + request.maxBytes)) } };
      if (request.operation === 'status' || request.operation === 'capabilities') throw new MobileServiceError(409, 'UNSUPPORTED_FORMAT');
      if (request.operation === 'release') state.releases++;
      return { source: 'netease', result: { kind: 'mobile-source-ack', operation: request.operation, handle: request.handle,
        readId: request.operation === 'close-read' ? request.readId : null, quiet: true } };
    } });
  async function owner(request: MobileOwnerPrivateRequest): Promise<MobileOwnerPrivateResult> {
    assert.equal(isMobileOwnerPrivateRequest(request), true); let reply: MobileOwnerPrivateResult;
    if (request.kind === 'load' || request.kind === 'playback-load') reply = structuredClone(stored[request.kind === 'load' ? 'auth' : 'playback']);
    else if (request.kind === 'save' || request.kind === 'playback-save') {
      const name = request.kind === 'save' ? 'auth' : 'playback', prior = stored[name];
      if (prior.revision !== request.request.expectedRevision) reply = { kind: 'conflict', datasetId: DATASET, currentRevision: prior.revision };
      else { stored[name] = { kind: 'sealed', datasetId: DATASET, revision: prior.revision + 1,
        commitId: request.request.commitId, sealed: new Uint8Array(request.request.sealed) };
        reply = { kind: 'saved', datasetId: DATASET, revision: prior.revision + 1, commitId: request.request.commitId }; }
    } else throw new MobileServiceError(409, 'UNSUPPORTED_FORMAT');
    assert.equal(isMobileOwnerPrivateResult(reply, request), true); return reply;
  }
  const service = createMobileBackend({ serverId: SERVER, datasetId: DATASET, authKey: key, displayName: '合成004组合', environment: 'development',
    requestOwner: owner, assertCurrent: () => undefined, resizeArtwork: () => { throw new MobileServiceError(404, 'INVALID_REQUEST'); },
    enablePlayback: true, ...(enableContent ? { enableContent: true } : {}), requestContentRpc: async (request, parent) => {
      rpcCalls.push(request); return rpc.request(request, parent);
    } });
  service.activatePlayback(ORIGIN);
  const permit = await service.auth.issuePairing(), pair = await service.auth.claim({ pairingSecret: permit.pairingSecret,
    installationId: 'installation.rpc-main', deviceName: '合成设备' }, 'claim.rpc-main');
  t.after(async () => { for (const release of releaseHooks) release(); await service.close(); await rpc.close(); key.fill(0);
    for (const value of Object.values(stored)) if (value.kind === 'sealed') value.sealed.fill(0); });
  const currentScope = async (token = pair.accessToken): Promise<Readonly<MobileContentScope>> => {
    const p = await service.auth.authenticate(token); return { serverId: p.serverId, datasetId: p.datasetId, deviceId: p.deviceId,
      deviceEpoch: p.deviceEpoch, accessGeneration: p.generation, ownerEpoch: state.ownerEpoch,
      accountDomain: state.accountDomain, providerEpoch: state.providerEpoch };
  };
  async function request<O extends MobileOperationId>(operation: O, path: string, body?: unknown, idempotencyKey?: string, token = pair.accessToken): Promise<MobileDecodedRequest<unknown>> {
    const bytes = body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(body));
    const headers: [string, string][] = body === undefined ? [] : [['Content-Type', 'application/json'], ['Content-Length', String(bytes.byteLength)]];
    if (idempotencyKey) headers.push(['Idempotency-Key', idempotencyKey]); headers.push(['Authorization', `Bearer ${token}`]);
    const capabilities = operation === 'createResource' ? await service.playbackBackend!.resourceCapabilities(token, path.split('/')[4]!, ORIGIN, signal()) : undefined;
    const decoded = decodeMobileRequest(operation, { method: MOBILE_OPERATION_TABLE[operation].method, path, query: [], headers, body: bytes },
      { responseOrigin: ORIGIN, requestPath: path, ...(capabilities ? { resourceCapabilities: capabilities } : {}) });
    assert.ok(decoded.ok); return decoded.value;
  }
  async function control(operation: Mobile002Operation, path: string, body?: unknown, idempotencyKey?: string, token = pair.accessToken) {
    return service.playbackBackend!.dispatch({ operation, request: await request(operation, path, body, idempotencyKey, token),
      accessToken: token, signal: signal(), origin: ORIGIN, headers: [['Authorization', `Bearer ${token}`]] });
  }
  const input = async <O extends MobileContentOperation>(operation: O, token = pair.accessToken, parent = signal()) => ({ operation,
    request: contentFixture(operation, await currentScope(token)).request, accessToken: token, signal: parent, origin: ORIGIN });
  return { service, rpc, pair, keys, rpcCalls, state, enteredInvalidation, sourceScopes, mediaBytes, currentScope, input, request, control,
    barrier() { const entered = deferred(), release = deferred(); releaseHooks.add(release.resolve); return { entered, release }; } };
}
function decode<O extends MobileOperationId>(operation: O, path: string, reply: { status: number; headers: MobileHeaderPairs; body: Uint8Array;
  resourceContext?: import('@music-bridge/contracts').MobileResourceSemanticContext; contentContext?: MobileContentReadContext }): MobileReplyMap[O] {
  const result = decodeMobileResponse(operation, { status: reply.status, headers: reply.headers, body: new Uint8Array(reply.body), finalUrl: ORIGIN + path },
    { responseOrigin: ORIGIN, requestPath: path, ...(reply.resourceContext ? { resource: reply.resourceContext } : {}),
      ...(reply.contentContext ? { content: reply.contentContext } : {}) }); assert.ok(result.ok); return result.value;
}
function buffered(reply: Mobile002BackendReply): asserts reply is Extract<Mobile002BackendReply, { kind: 'buffered' }> { assert.equal(reply.kind, 'buffered'); }

test('显式004装载同原Auth并仅初始化一次；十九whole HTTP经真实RPC及发送前重验，旧组合不挂内容', async t => {
  const legacy = await fixture(t, false); assert.equal(legacy.service.contentBackend, undefined); assert.equal(legacy.rpcCalls.length, 0);
  const h = await fixture(t); assert.ok(h.service.contentBackend);
  for (const operation of MOBILE_CONTENT_OPERATIONS) {
    const input = await h.input(operation), original = contentFixture(operation, await h.currentScope());
    const reply: MobileContentBackendReply = await h.service.contentBackend.dispatch(input); await reply.beforeSend();
    const decoded: ReturnType<typeof decode> = decode(operation, input.request.path, reply); assert.equal(decoded.category, 'success');
    assert.equal(reply.status, original.reply.status); assert.equal(canonical(decoded.body), canonical(original.reply.body));
  }
  assert.equal(h.state.dispatches, 19); assert.equal(h.state.verifies, 19); assert.equal(h.state.initCalls, 1);
  assert.equal(h.rpcCalls.filter(call => call.action === 'dispatch').length, 19);
  assert.equal(h.keys.every(key => key.every(byte => byte === 0)), true);
  for (const call of h.rpcCalls) assert.equal(Object.hasOwn(call, 'accessToken'), false);
  const ui = await h.service.dsdBackend!.dispatch({ operation: 'getUIContentCapabilities', request: await h.request('getUIContentCapabilities', '/mobile/v1/ui/capabilities'),
    accessToken: h.pair.accessToken, signal: signal(), origin: ORIGIN }); await ui.beforeSend?.();
  const decodedUi = decode('getUIContentCapabilities', '/mobile/v1/ui/capabilities', ui); assert.equal(decodedUi.category, 'success');
  assert.ok(isMobileUIContentCapabilities(decodedUi.body));
  assert.equal(decodedUi.body.addedAlbums, 'ready'); assert.equal(decodedUi.body.resourceDsdToPcm, false);
});

test('实际Auth撤销等原epoch ACK和Provider静止；取消迟到结果及旧epoch不能重新登记', async t => {
  const h = await fixture(t), held = h.barrier(), ack = h.barrier(); h.state.invalidationWait = ack.release.promise;
  h.state.effect = async () => { held.entered.resolve(); await held.release.promise; };
  const pending = h.service.contentBackend!.dispatch(await h.input('getNeteaseDailyRecommendations'));
  const failed = assert.rejects(pending, MobileServiceError); await held.entered.promise;
  let revoked = false; const revocation = h.service.auth.revokeDevice(h.pair.deviceId).then(() => { revoked = true; });
  await h.enteredInvalidation.promise; await Promise.resolve(); assert.equal(revoked, false);
  ack.release.resolve(); await Promise.resolve(); assert.equal(revoked, false);
  held.release.resolve(); await failed; await revocation; assert.equal(h.state.dispatches, 1);
  const old = h.rpcCalls.find(call => call.action === 'scope'); assert.ok(old?.action === 'scope');
  const response = await h.rpc.request({ ...base(), action: 'scope', principal: old.principal }, signal());
  assert.ok('kind' in response && response.kind === 'error'); assert.equal(response.code, 'UNAUTHORIZED');
  assert.equal(h.rpcCalls.filter(call => call.action === 'invalidate-device').length, 1);
});

test('可信账号切换与提交后logout只拒发送；持久化UNKNOWN保留原分类且不暴露commit或再dispatch', async t => {
  const h = await fixture(t), input = await h.input('createPersonalPlaylist');
  const reply = await h.service.contentBackend!.dispatch(input); assert.equal(reply.status, 201);
  h.state.providerEpoch = 'provider.next'; await refuses(reply.beforeSend(), 409, 'SOURCE_CHANGED'); assert.equal(h.state.dispatches, 1);
  h.state.providerEpoch = 'provider.fixture.1';
  h.state.effect = () => { throw new MobileContentPersistenceError('unknown', randomUUID()); };
  await refuses(h.service.contentBackend!.dispatch(input), 503, 'BUSY', 'unknown'); assert.equal(h.state.dispatches, 2);
  assert.equal(h.rpcCalls.filter(call => call.action === 'dispatch').length, 2);
  h.state.effect = undefined;
  const committed = await h.service.contentBackend!.dispatch(await h.input('setAlbumFavorite'));
  const principal = await h.service.auth.authenticate(h.pair.accessToken); await h.service.auth.logout(principal);
  await assert.rejects(committed.beforeSend(), MobileServiceError); assert.equal(h.state.dispatches, 3);
});

test('Main私有回应错绑定拒绝；原取消等待真实quiet，关闭超时不释放挂起工作或假报成功', async t => {
  const scope: Readonly<MobileContentScope> = { serverId: SERVER, datasetId: DATASET, deviceId: 'device.fixture.1', deviceEpoch: 1,
    accessGeneration: 1, ownerEpoch: 'owner.fixture.1', accountDomain: ACCOUNT, providerEpoch: null };
  const principal: MobileContentMainPrincipal = { serverId: SERVER, datasetId: DATASET, deviceId: scope.deviceId, deviceEpoch: 1, accessGeneration: 1 };
  const wrong = createMainMobileContentPort({ serverId: SERVER, datasetId: DATASET, key: new Uint8Array(32), assertCurrent: () => undefined,
    requestRpc: async call => call.action === 'initialize' ? { type: 'mobile-content-core-response', id: call.id, action: 'initialize', ok: true }
      : call.action === 'cancel' ? { type: 'mobile-content-core-response', id: call.id, action: 'cancel', kind: 'cancelled',
        requestId: call.requestId, snapshotId: call.snapshotId, quiet: true }
        : { type: 'mobile-content-core-response', id: randomUUID(), action: 'scope', kind: 'scope', scope, neteasePlayback: false } });
  await refuses(wrong.scopeForIdentity(principal, signal()), 503, 'BUSY', 'unknown'); await wrong.close();
  const entered = deferred(), release = deferred(), quiet = deferred(); let calls = 0, cancellations = 0;
  const main = createMainMobileContentPort({ serverId: SERVER, datasetId: DATASET, key: new Uint8Array(32).fill(9), assertCurrent: () => undefined,
    requestMs: 20, closeMs: 20, requestRpc: async call => {
      if (call.action === 'initialize') return { type: 'mobile-content-core-response', id: call.id, action: 'initialize', ok: true };
      if (call.action === 'cancel') { cancellations++; await quiet.promise; return { type: 'mobile-content-core-response', id: call.id, action: 'cancel',
        kind: 'cancelled', requestId: call.requestId, snapshotId: call.snapshotId, quiet: true }; }
      calls++; entered.resolve(); await release.promise; quiet.resolve();
      return { type: 'mobile-content-core-response', id: call.id, action: 'scope', kind: 'scope', scope, neteasePlayback: false };
    } });
  t.after(() => { release.resolve(); quiet.resolve(); });
  const pending = main.scopeForIdentity(principal, signal()); await entered.promise;
  await refuses(pending, 503, 'BUSY', 'unknown'); assert.equal(calls, 1); assert.equal(cancellations, 1);
  try { await assert.rejects(main.close(), (error: unknown) => error instanceof MobileAuthPersistenceError
    || error instanceof MobileServiceError && Object.getOwnPropertyDescriptor(error, 'outcome')?.value === 'unknown'); }
  finally { release.resolve(); quiet.resolve(); }
  assert.equal(calls, 1);
});

test('真Main播放actor原资源绑定完整Scope；refresh续原lease，logout回收并阻旧ticket，不用Ready重写Catalog事实', async t => {
  const h = await fixture(t), sessionPath = '/mobile/v1/sessions';
  const sessionReply = await h.control('createSession', sessionPath, { clientInstanceId: 'client.rpc-fixture' }, 'session.rpc');
  buffered(sessionReply); const decodedSession = decode('createSession', sessionPath, sessionReply);
  assert.equal(decodedSession.category, 'success');
  const session = mobileSchemaSnapshot<MobileSession>(MOBILE_RESOURCE_SCHEMAS.Session!, decodedSession.body, MOBILE_RESOURCE_SCHEMAS); assert.ok(session.ok);
  const request: MobileResourceRequest = { trackId: 'nt:fixture:track.1', versionId: 'nv:fixture:track.1', contentRevision: 'rev.fixture.1',
    quality: { profile: 'lossless', allowLossyFallback: false, preferredTransport: 'file' },
    formats: [{ codec: 'flac', container: 'flac', maxSampleRateHz: 192_000, maxChannels: 2, maxBitsPerSample: 24 }] };
  const resourcePath = `/mobile/v1/sessions/${session.value.id}/resources`;
  const created = await h.control('createResource', resourcePath, request, 'resource.rpc'); buffered(created); await created.beforeSend?.();
  const first = decode('createResource', resourcePath, created); assert.ok(isMobileResource(first.body)); let resource = first.body;
  if (created.status !== 201) {
    assert.equal(created.status, 202); const deadline = Date.now() + 4000, path = `${resourcePath}/${resource.id}`;
    while (resource.state === 'preparing' && Date.now() < deadline) {
      const followup = await h.control('getResource', path); buffered(followup);
      const decoded = decode('getResource', path, followup); assert.ok(isMobileResource(decoded.body)); resource = decoded.body;
      if (resource.state === 'preparing') await new Promise<void>(resolve => setImmediate(resolve));
    }
  }
  assert.equal(resource.state, 'ready'); assert.ok(resource.state === 'ready');
  assert.equal(h.state.begins, 1); assert.equal(created.resourceContext?.source, 'netease');
  const bound = h.sourceScopes[0]; assert.ok(bound); assert.equal(bound.accessGeneration, 1);
  const refreshed = await h.service.auth.refresh({ refreshToken: h.pair.refreshToken }, 'refresh.rpc-lease');
  const renewed = await h.control('renewResource', `${resourcePath}/${resource.id}/renew`, {}, 'renew.rpc', refreshed.accessToken);
  buffered(renewed); await renewed.beforeSend?.(); assert.equal(renewed.status, 200);
  assert.equal(h.sourceScopes.every(scope => canonical(scope) === canonical(bound)), true);
  assert.equal(h.state.begins, 1);
  const ticket = new URL(resource.media.url), mediaRequest = decodeMobileRequest('getMediaAsset', { method: 'GET', path: ticket.pathname,
    headers: [], query: [...ticket.searchParams.entries()], body: new Uint8Array() }, { responseOrigin: ORIGIN, requestPath: ticket.pathname }); assert.ok(mediaRequest.ok);
  const p = await h.service.auth.authenticate(refreshed.accessToken); await h.service.auth.logout(p);
  await assert.rejects(h.service.playbackBackend!.dispatch({ operation: 'getMediaAsset', request: mediaRequest.value, accessToken: null,
    signal: signal(), origin: ORIGIN, headers: [] }), MobileServiceError); assert.equal(h.state.begins, 1); assert.equal(h.state.releases, 1);
});

/** 受控进程/端口只验证实际Supervisor收发归属，不代表utilityProcess或App。 */
class Port implements CoreMessagePort {
  readonly sent: unknown[] = []; readonly listeners: ((event: { data: unknown }) => void)[] = [];
  on(_event: 'message', callback: (event: { data: unknown }) => void): void { this.listeners.push(callback); }
  postMessage(value: unknown): void { this.sent.push(value); }
  start(): void {} close(): void {}
  receive(value: unknown): void { for (const listener of this.listeners) listener({ data: value }); }
}
class Child implements CoreChildProcess {
  readonly exits: ((code: number) => void)[] = [];
  postMessage(): void {} once(_event: 'exit', callback: (code: number) => void): void { this.exits.push(callback); }
  kill(): boolean { this.exit(0); return true; } exit(code: number): void { for (const listener of this.exits.splice(0)) listener(code); }
}
test('实际Supervisor只按原id/action/generation回应；UNKNOWN占位直至原quiet ACK，不继承重启nonce', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const channels: { port1: Port; port2: Port }[] = [], children: Child[] = [];
  const supervisor = new CoreSupervisor({ entryPath: '/Volumes/LifeWeave/Developer/CommandLine/tmp/mobile-content-fixture-entry.js',
    cwd: '/Volumes/LifeWeave/Developer/CommandLine/tmp', startupTimeoutMs: 20, dependencies: {
      createChannel: () => { const channel = { port1: new Port(), port2: new Port() }; channels.push(channel); return channel; },
      fork: () => { const child = new Child(); children.push(child); return child; } } });
  t.after(async () => { t.mock.timers.reset(); await supervisor.shutdown(); });
  const ready = () => channels.at(-1)!.port2.receive({ version: IPC_VERSION, event: 'core.ready', payload: { state: {
    runtime: 'ready', roon: 'disconnected', provider: 'missing', activeStreamCount: 0, activePlaybackPresent: false } } });
  const starting = supervisor.start(); ready(); await starting;
  const principal = { serverId: SERVER, datasetId: DATASET, deviceId: 'device.fixture.1', deviceEpoch: 1, accessGeneration: 1 };
  const request: MobileContentCoreRequest = { ...base(), action: 'scope', principal };
  const pending = supervisor.requestMobileContentMain(request, signal());
  const reported = mobileContentRpcFailure(request, new MobileAuthPersistenceError('unknown'));
  // Supervisor 交付原安全信封，Main client 才抛错误；UNKNOWN 的 nonce 仍未 quiet。
  const port = channels[0]!.port2; port.receive(reported); assert.deepEqual(await pending, reported);
  await assert.rejects(supervisor.requestMobileContentMain(request, signal()), MobileAuthPersistenceError); assert.equal(port.sent.length, 1);
  const cancel: MobileContentCoreRequest = { ...base(), action: 'cancel', requestId: request.id, snapshotId: null, scope: null };
  const cancelling = supervisor.requestMobileContentMain(cancel, signal());
  const quiet = { type: 'mobile-content-core-response', id: cancel.id, action: 'cancel', kind: 'cancelled', requestId: request.id, snapshotId: null, quiet: true };
  port.receive(quiet); assert.deepEqual(await cancelling, quiet); assert.equal(port.sent.length, 2);
  const next = { ...base(), action: 'scope' as const, principal }, waiting = supervisor.requestMobileContentMain(next, signal());
  const waitingFailed = assert.rejects(waiting, MobileAuthPersistenceError); children[0]!.exit(1); await waitingFailed;
  await new Promise<void>(resolve => setImmediate(resolve)); ready(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(supervisor.status, 'ready'); assert.equal(channels.length, 2); assert.equal(channels[1]!.port2.sent.length, 0);
  port.receive(mobileContentRpcFailure(next, new MobileAuthPersistenceError('not-sent'))); assert.equal(channels[1]!.port2.sent.length, 0);
});
