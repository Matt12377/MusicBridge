import assert from 'node:assert/strict';
import { createHash, hkdfSync, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test, { type TestContext } from 'node:test';
import {
  IPC_VERSION, MOBILE_OPERATION_TABLE, MOBILE_RESOURCE_SCHEMAS, decodeMobileRequest, decodeMobileResponse,
  isMobileResource, isMobileUIContentCapabilities, mobileCanonicalJson, mobileDataSnapshot, mobileSchemaSnapshot,
  type MobileContentReadContext, type MobileDecodedRequest, type MobileHeaderPairs, type MobileOperationId,
  type MobileReplyMap, type MobileResourceRequest, type MobileSession, type MobileWireCodecContext,
  type MobileTrack,
} from '@music-bridge/contracts';
import { createMobileBackend } from '../src/main/mobile-backend.js';
import { createTestMobilePlaybackHistoryOwner } from './mobile-test-playback-history-owner.js';
import { installTestMobilePlaybackCodecWorker } from './mobile-test-playback-codec-worker.js';
import { createMainMobileContentPort, type MobileContentCancelRecheck } from '../src/main/mobile-content-port.js';
import type { MobileContentBackendReply } from '../src/main/mobile-content-backend.js';
import { CoreSupervisor, CoreIpcError, type CoreChildProcess, type CoreMessagePort } from '../src/main/core-supervisor.js';
import { safeMobilePlaybackFailure } from '../src/main/mobile-playback-backend.js';
import { BridgeError } from '../../../packages/bridge-core/src/shared/errors.js';
import { createMobileCapabilityContext, createMobilePreparationProbe, copyMobilePreparationSnapshot, mobileCapabilitySync, mobileCapabilityReject,
  withMobileCapabilityContext, closeMobileCapabilityContext, MOBILE_CAPABILITY_TRACE_PREFIX,
  createMobileContentSampleSelector, createMobileCapabilityTraceCollector, copyMobileCapabilityTraceRecord,
  mobileCapabilityRequestSha, snapshotMobileCapabilityTrace, selectMobileCapabilityTraceBranchDetails } from '../../../packages/bridge-core/src/mobile/capability-trace.js';
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

installTestMobilePlaybackCodecWorker();

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

test('Main内容初始化：私有Provider诊断仅在明确开启时透传原Core协议，默认关闭且复用初始化', async () => {
  const scope: MobileContentScope = { serverId: SERVER, datasetId: DATASET, deviceId: 'diagnostic.init.device', deviceEpoch: 1,
    accessGeneration: 1, ownerEpoch: 'diagnostic.init.owner', accountDomain: ACCOUNT, providerEpoch: null };
  const principal: MobileContentMainPrincipal = { serverId: SERVER, datasetId: DATASET, deviceId: scope.deviceId, deviceEpoch: 1, accessGeneration: 1 };
  for (const enabled of [undefined, false, true]) {
    const requests: MobileContentCoreRequest[] = [], initialized: (true | undefined)[] = [];
    const rpc = createMobileContentRpcPort({ initialize: async input => { initialized.push(input.privateProviderDiagnostics); },
      resolveScope: async () => scope, assertScope() {}, invalidateDevice: async () => {},
      source: async () => { throw new Error('初始化诊断测试不能请求媒体。'); },
      content: { async dispatch() { throw new Error('初始化诊断测试不能派发内容。'); } } });
    const main = createMainMobileContentPort({ serverId: SERVER, datasetId: DATASET, key: new Uint8Array(32).fill(47), assertCurrent() {},
      ...(enabled === undefined ? {} : { privateProviderDiagnostics: enabled }),
      requestRpc: async (request, parent) => { requests.push(request); return rpc.request(request, parent); } });
    try {
      assert.equal(canonical((await main.scopeForIdentity(principal, signal())).scope), canonical(scope));
      assert.equal(canonical((await main.scopeForIdentity(principal, signal())).scope), canonical(scope));
      const calls = requests.filter(request => request.action === 'initialize'); assert.equal(calls.length, 1);
      assert.equal(Object.hasOwn(calls[0]!, 'privateProviderDiagnostics'), enabled === true);
      assert.deepEqual(initialized, [enabled === true ? true : undefined]);
    } finally { await main.close(); await rpc.close(); }
  }
});

/** 真Main/auth/actor/私有RPC/完整codec；Auth与来源事实受控，history沿外置合成Owner，不声称真实曲库、FD或Provider。 */
async function fixture(t: TestContext, enableContent = true, privateDiagnostics = false) {
  const key = new Uint8Array(32).fill(73), keys: Uint8Array[] = [], rpcCalls: MobileContentCoreRequest[] = [];
  const historyOwner = createTestMobilePlaybackHistoryOwner(DATASET);
  const scopes = new Map<string, Readonly<MobileContentScope>>(), revoked = new Map<string, number>();
  const stored: { auth: MobileSealedState; playback: MobileSealedState } = {
    auth: { kind: 'missing', datasetId: DATASET, revision: 0 }, playback: { kind: 'missing', datasetId: DATASET, revision: 0 } };
  const state = { accountDomain: ACCOUNT, providerEpoch: 'provider.fixture.1' as string | null, ownerEpoch: 'owner.fixture.1',
    qualified: true, initCalls: 0, dispatches: 0, verifies: 0, begins: 0, releases: 0,
    scopeError: undefined as MobileServiceError | undefined, artworkRevision: 'nar:fixture', imageReads: 0, imageValidates: 0,
    imageError: undefined as MobileServiceError | undefined, catalogError: undefined as Error | undefined, catalogReads: 0,
    trackReads: 0, trackError: undefined as MobileServiceError | undefined,
    observedTrack: { id: 'nt:fixture:1', source: 'netease', sourceItemId: '1', albumId: 'na:fixture:5', title: '合成已探测曲目', artists: ['合成艺人'],
      versionId: 'nv:fixture', contentRevision: 'nr:fixture', editionLabel: '', durationMs: 1000,
      audio: { codec: 'flac', container: 'flac', sampleRateHz: 192000, bitsPerSample: 24, channels: 2 }, availability: 'available' } as MobileTrack,
    resized: new Uint8Array([255,216,1,2,3,4,255,217]),
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
    resolveScope: async principal => { if (state.scopeError) throw state.scopeError; const scope = { ...principal, ownerEpoch: state.ownerEpoch,
      accountDomain: state.accountDomain, providerEpoch: state.providerEpoch }; scopes.set(principal.deviceId, scope); return scope; },
    assertScope: (scope, stage) => {
      const latest = scopes.get(scope.deviceId);
      if (!latest || (revoked.get(scope.deviceId) ?? 0) >= scope.deviceEpoch) throw new MobileServiceError(401, 'UNAUTHORIZED');
      if (scope.accountDomain !== state.accountDomain || scope.providerEpoch !== state.providerEpoch || scope.ownerEpoch !== state.ownerEpoch
        || stage === 'acquire' && latest.accessGeneration !== scope.accessGeneration) throw new MobileServiceError(409, 'SOURCE_CHANGED');
    }, content, neteasePlaybackQualified: async () => state.qualified,
    readArtwork: async (_scope, artworkId) => { state.imageReads++; if (state.imageError) throw state.imageError; return { artworkId, revision: state.artworkRevision,
      contentType: 'image/jpeg', bytes: new Uint8Array([255,216,1,2,3,4,255,217]) }; },
    assertArtwork: async () => { state.imageValidates++; return state.artworkRevision; },
    readTrack: async () => { state.trackReads++; if (state.trackError) throw state.trackError; return structuredClone(state.observedTrack); },
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
    } else if (request.kind === 'playback-history') reply = historyOwner.dispatch(request.request);
    else if(request.kind==='catalog'&&(request.request.operation==='listTracks'||request.request.operation==='getTrack')){
      state.catalogReads++;if(state.catalogError)throw state.catalogError;
      // 001目录Owner使用UUID；004 scope的合成MobileId不能代替它。
      const detail=request.request.operation==='getTrack';
      if(detail&&request.request.itemId!.startsWith('nt:'))throw new MobileServiceError(404,'SOURCE_CHANGED');
      reply={datasetId:DATASET,ownerEpoch:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',libraryRevision:'library.fixture.1',operation:request.request.operation,
        offset:request.request.offset,limit:request.request.limit,total:detail?1:0,items:detail?[{...state.observedTrack,id:request.request.itemId!,source:'local',albumId:'la:fixture:1'}]:[]};
    } else throw new MobileServiceError(409, 'UNSUPPORTED_FORMAT');
    assert.equal(isMobileOwnerPrivateResult(reply, request), true); return reply;
  }
  const service = createMobileBackend({ serverId: SERVER, datasetId: DATASET, authKey: key, displayName: '合成004组合', environment: 'development',
    privateProviderDiagnostics: privateDiagnostics,
    requestOwner: owner, assertCurrent: () => undefined, resizeArtwork: (_bytes, size, providerInput) => {
      assert.equal(providerInput, true); assert.ok([96, 256, 512].includes(size)); return state.resized;
    },
    enablePlayback: true, ...(enableContent ? { enableContent: true } : {}), requestContentRpc: async (request, parent) => {
      rpcCalls.push(request); return rpc.request(request, parent);
    } });
  service.activatePlayback(ORIGIN);
  const permit = await service.auth.issuePairing(), pair = await service.auth.claim({ pairingSecret: permit.pairingSecret,
    installationId: 'installation.rpc-main', deviceName: '合成设备' }, 'claim.rpc-main');
  t.after(async () => {
    for (const release of releaseHooks) release();
    const failures: unknown[] = [];
    for (const close of [() => service.close(), () => rpc.close(), () => historyOwner.close()]) {
      try { await close(); } catch (error) { failures.push(error); }
    }
    key.fill(0); for (const value of Object.values(stored)) if (value.kind === 'sealed') value.sealed.fill(0);
    if (failures.length) throw new AggregateError(failures, '合成Main内容与history Owner未完整关闭。');
  });
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
test('私有legacy歌曲诊断：开关默认关闭，真实001读取与发送前同页复核保原错误且公开仍BUSY',async t=>{
  for(const enabled of [false,true])for(const stage of ['read','beforeSend'] as const)await t.test(`${enabled}-${stage}`,async child=>{
    const h=await fixture(child,true,enabled),lines:string[]=[];
    const context=createMobileCapabilityContext(randomUUID(),'main','http',null,signal(),line=>lines.push(line));assert.ok(context);context.privateContentDiagnostic=true;
    const original=new CoreIpcError('INVALID_IPC_RESPONSE','禁止本地原始正文 https://secret.invalid/ token');
    const input={operation:'listTracks' as const,request:await h.request('listTracks','/mobile/v1/tracks'),accessToken:h.pair.accessToken,signal:signal(),origin:ORIGIN};
    try{await withMobileCapabilityContext(context,async()=>{
      if(stage==='read'){h.state.catalogError=original;await assert.rejects(h.service.backend.dispatch(input),error=>error===original);}
      else{const reply=await h.service.backend.dispatch(input);h.state.catalogError=original;await assert.rejects(reply.beforeSend!(),error=>error===original);}
    });}finally{closeMobileCapabilityContext(context);}
    const safe=safeMobilePlaybackFailure(original);assert.equal(safe.status,503);assert.equal(safe.code,'BUSY');
    const rows=lines.map(line=>JSON.parse(line.slice(MOBILE_CAPABILITY_TRACE_PREFIX.length)) as {stage:string;phase:string;code:string});
    const local=rows.filter(row=>row.stage.startsWith('main.catalog.tracks.'));
    if(!enabled)assert.deepEqual(local,[]);
    else{
      assert.ok(local.some(row=>row.stage==='main.catalog.tracks.owner'&&row.phase==='reject'&&row.code==='INVALID_IPC_RESPONSE'));
      assert.ok(local.some(row=>row.stage==='main.catalog.tracks.auth'&&row.phase==='ok'));
      if(stage==='beforeSend')assert.ok(local.some(row=>row.stage==='main.catalog.tracks.beforeSend'&&row.phase==='reject'));
    }
    assert.equal(h.state.catalogReads,stage==='read'?1:2);assert.doesNotMatch(lines.join(''),/禁止本地|secret\.invalid|token|message|stack/iu);
  });
});

test('私有Main内容RPC诊断：真实dispatch明确action且Core安全BUSY不误记为scope或other',async t=>{
  const h=await fixture(t,true,true),lines:string[]=[];
  h.state.effect=()=>{throw new BridgeError('NETEASE_REQUEST_FAILED','禁止的Provider正文');};
  const context=createMobileCapabilityContext(randomUUID(),'main','http',null,signal(),line=>lines.push(line));assert.ok(context);context.privateContentDiagnostic=true;
  try{const input=await h.input('getNeteaseDailyRecommendations');await withMobileCapabilityContext(context,()=>assert.rejects(h.service.contentBackend!.dispatch(input),error=>error instanceof MobileServiceError&&error.status===503&&error.code==='BUSY'));}
  finally{closeMobileCapabilityContext(context);}
  const rows=lines.map(line=>JSON.parse(line.slice(MOBILE_CAPABILITY_TRACE_PREFIX.length)) as {stage:string;phase:string;code:string});
  assert.ok(rows.some(row=>row.stage==='content.rpc.dispatch'&&row.phase==='reject'&&row.code==='BUSY'));
  assert.equal(h.state.dispatches,1);assert.doesNotMatch(lines.join(''),/禁止的Provider正文/u);
});

test('R18_COLLECTION_DETAILS 原Main和Core dispatch首拒沿原请求连回HTTP，时间相同的无父链错误不加入', async t => {
  const h = await fixture(t, true, true), selector = createMobileContentSampleSelector(), lines: string[] = [];
  const original = new MobileServiceError(409, 'SOURCE_CHANGED');
  h.state.effect = input => { assert.equal(input.operation, 'getNeteaseDiscoveryCollectionTracks');
    mobileCapabilityReject('provider.content.stream.item-status', original); throw original; };
  const input = await h.input('getNeteaseDiscoveryCollectionTracks');
  const sample = selector.claim(input.operation); assert.ok(sample);
  const context = createMobileCapabilityContext(randomUUID(), 'main', 'http', null, input.signal, line => lines.push(line)); assert.ok(context);
  context.deferredRecords = []; context.httpTerminalReserve = true; context.privateContentDiagnostic = true;
  try {
    await withMobileCapabilityContext(context, async () => {
      mobileCapabilitySync('http.receive', () => undefined);
      try { await h.service.contentBackend!.dispatch(input); assert.fail('原Core拒绝不能变成目录成功。'); }
      catch (error) { assert.ok(error instanceof MobileServiceError); assert.equal(error.status, 409); assert.equal(error.code, 'SOURCE_CHANGED');
        mobileCapabilityReject('http.failure', error); }
      mobileCapabilitySync('http.status.409', () => undefined); mobileCapabilitySync('http.send', () => undefined);
    });
    sample.finish(context, 409, true, true);
  } finally { closeMobileCapabilityContext(context); }
  const dispatches = h.rpcCalls.filter(request => request.action === 'dispatch' && request.operation === input.operation);
  assert.equal(dispatches.length, 1); assert.equal(h.state.dispatches, 1); assert.equal(h.state.begins, 0);
  const childSha = mobileCapabilityRequestSha('content', dispatches[0]!.id); assert.ok(childSha);
  const first = snapshotMobileCapabilityTrace().firstBusinessFailures.find(row => row.component === 'core' && row.requestSha256 === childSha);
  assert.ok(first); assert.equal(first.stage, 'provider.content.stream.item-status'); assert.equal(first.code, 'SOURCE_CHANGED');
  const collector = createMobileCapabilityTraceCollector();
  for (const line of lines) { const row = copyMobileCapabilityTraceRecord(JSON.parse(line.slice(MOBILE_CAPABILITY_TRACE_PREFIX.length))); assert.ok(row); collector.record(row); }
  collector.record(first);
  collector.record({ ...first, requestSha256: 'f'.repeat(64), parentSha256: null, relatedSha256: null });
  const selected = selectMobileCapabilityTraceBranchDetails(collector.snapshot(), context.requestSha256).records;
  assert.ok(selected.some(row => row.component === 'main' && row.requestSha256 === childSha && row.parentSha256 === context.requestSha256
    && row.stage === 'content.rpc.dispatch' && row.phase === 'reject'));
  assert.ok(selected.some(row => row.component === 'core' && row.requestSha256 === childSha && row.stage === first.stage));
  assert.ok(selected.some(row => row.requestSha256 === context.requestSha256 && row.stage === 'http.discovery.collection-tracks.409'));
  assert.equal(selected.some(row => row.requestSha256 === 'f'.repeat(64)), false);
  assert.ok(selected.filter(row => row.requestSha256 === context.requestSha256).length <= 64);
  assert.doesNotMatch(lines.join(''), /collectionId|sourceItemId|credential|cookie|message|stack|https?:/iu);
});

test('手机发现能力：BUSY只降unavailable，已确认未登录用loginRequired，真正mobile401不吞', async t => {
  const h = await fixture(t), path = '/mobile/v1/ui/capabilities';
  const input = { operation: 'getUIContentCapabilities' as const, request: await h.request('getUIContentCapabilities', path),
    accessToken: h.pair.accessToken, signal: signal(), origin: ORIGIN };
  h.state.scopeError = new MobileServiceError(503, 'BUSY');
  const unavailable = await h.service.dsdBackend!.dispatch(input); await unavailable.beforeSend?.();
  const first = decode('getUIContentCapabilities', path, unavailable); assert.equal(first.category, 'success');
  assert.ok(isMobileUIContentCapabilities(first.body));
  assert.equal(first.body.neteaseDailyRecommendations, 'unavailable'); assert.equal(first.body.addedAlbums, 'unavailable');
  h.state.scopeError = undefined; h.state.providerEpoch = null; h.state.accountDomain = `local:${DATASET}`;
  const loggedOut = await h.service.dsdBackend!.dispatch(input); await loggedOut.beforeSend?.();
  const second = decode('getUIContentCapabilities', path, loggedOut); assert.equal(second.category, 'success');
  assert.ok(isMobileUIContentCapabilities(second.body));
  assert.equal(second.body.neteaseDailyRecommendations, 'loginRequired'); assert.equal(second.body.addedAlbums, 'ready');
  assert.ok(await h.service.auth.authenticate(h.pair.accessToken));
  await assert.rejects(h.service.dsdBackend!.dispatch({ ...input, accessToken: 'invalid.mobile.token' }),
    error => error instanceof MobileServiceError && error.status === 401);
  h.state.scopeError = new MobileServiceError(401, 'UNAUTHORIZED');
  await assert.rejects(h.service.dsdBackend!.dispatch(input), error => error instanceof MobileServiceError && error.status === 401);
});

test('手机发现发送前：账号scope改变/临时503仍拒旧ready，不伪造更新后的200能力', async t => {
  const h = await fixture(t), input = { operation: 'getUIContentCapabilities' as const,
    request: await h.request('getUIContentCapabilities', '/mobile/v1/ui/capabilities'), accessToken: h.pair.accessToken, signal: signal(), origin: ORIGIN };
  const ready = await h.service.dsdBackend!.dispatch(input); h.state.providerEpoch = 'provider.replaced';
  await assert.rejects(ready.beforeSend!(), error => error instanceof MobileServiceError && error.status === 409);
  const next = await h.service.dsdBackend!.dispatch(input); h.state.scopeError = new MobileServiceError(503, 'BUSY');
  await assert.rejects(next.beforeSend!(), error => error instanceof MobileServiceError && error.status === 503);
  assert.ok(await h.service.auth.authenticate(h.pair.accessToken));
});

test('手机展示缓存只接收本次Provider scope的账号域，失效能力不携带旧域', async t => {
  const h = await fixture(t), path = '/mobile/v1/ui/capabilities';
  const input = { operation: 'getUIContentCapabilities' as const,
    request: await h.request('getUIContentCapabilities', path), accessToken: h.pair.accessToken, signal: signal(), origin: ORIGIN };
  const ready = await h.service.dsdBackend!.dispatch(input); await ready.beforeSend!();
  const body = JSON.parse(new TextDecoder().decode(ready.body)) as Record<string, unknown>;
  assert.equal(body.neteaseAccountDomain, ACCOUNT);
  assert.notEqual(body.neteaseAccountDomain, (await h.service.auth.authenticate(h.pair.accessToken)).accountDomain);
  h.state.providerEpoch = null; h.state.accountDomain = `local:${DATASET}`;
  const missing = await h.service.dsdBackend!.dispatch(input); await missing.beforeSend!();
  assert.equal(Object.hasOwn(JSON.parse(new TextDecoder().decode(missing.body)) as object, 'neteaseAccountDomain'), false);
  h.state.scopeError = new MobileServiceError(503, 'BUSY');
  const unavailable = await h.service.dsdBackend!.dispatch(input); await unavailable.beforeSend!();
  assert.equal(Object.hasOwn(JSON.parse(new TextDecoder().decode(unavailable.body)) as object, 'neteaseAccountDomain'), false);
});

test('手机图片认证链：现有getArtwork实际Main到Core读取再验证，限制1MiB且拒旧scope/修订', async t => {
  const h = await fixture(t), path = '/mobile/v1/artwork/naw%3Amain.fixture';
  const input = { operation: 'getArtwork' as const, request: await h.request('getArtwork', path),
    accessToken: h.pair.accessToken, signal: signal(), origin: ORIGIN };
  const first = await h.service.backend.dispatch(input); assert.equal(first.status, 200); assert.equal(first.body.length, 8);
  await first.beforeSend?.(); assert.equal(h.state.imageReads, 1); assert.equal(h.state.imageValidates, 1);
  assert.ok(h.rpcCalls.some(call => call.action === 'artwork' && call.operation === 'read'));
  const stale = await h.service.backend.dispatch(input); h.state.artworkRevision = 'nar:changed';
  await assert.rejects(stale.beforeSend!(), error => error instanceof MobileServiceError && error.status === 409);
  const replaced = await h.service.backend.dispatch(input); h.state.providerEpoch = 'provider.new';
  await assert.rejects(replaced.beforeSend!(), error => error instanceof MobileServiceError && error.status === 409);
  h.state.resized = new Uint8Array(1024 * 1024 + 1);
  await assert.rejects(h.service.backend.dispatch(input), error => error instanceof MobileServiceError && error.code === 'CONTENT_LIMIT_EXCEEDED');
  h.state.imageError = new MobileServiceError(404, 'RESOURCE_REVOKED');
  await assert.rejects(h.service.backend.dispatch(input), error => error instanceof MobileServiceError && error.status === 404);
  h.state.imageError = new MobileServiceError(503, 'BUSY');
  await assert.rejects(h.service.backend.dispatch(input), error => error instanceof MobileServiceError && error.status === 503);
  assert.ok(await h.service.auth.authenticate(h.pair.accessToken));
  await assert.rejects(h.service.backend.dispatch({ ...input, accessToken: 'invalid.mobile.token' }), error => error instanceof MobileServiceError && error.status === 401);
});

function decode<O extends MobileOperationId>(operation: O, path: string, reply: { status: number; headers: MobileHeaderPairs; body: Uint8Array;
  resourceContext?: import('@music-bridge/contracts').MobileResourceSemanticContext; contentContext?: MobileContentReadContext }): MobileReplyMap[O] {
  const result = decodeMobileResponse(operation, { status: reply.status, headers: reply.headers, body: new Uint8Array(reply.body), finalUrl: ORIGIN + path },
    { responseOrigin: ORIGIN, requestPath: path, ...(reply.resourceContext ? { resource: reply.resourceContext } : {}),
      ...(reply.contentContext ? { content: reply.contentContext } : {}) }); assert.ok(result.ok); return result.value;
}
function buffered(reply: Mobile002BackendReply): asserts reply is Extract<Mobile002BackendReply, { kind: 'buffered' }> { assert.equal(reply.kind, 'buffered'); }

test('R10_TRACK 公开nt详情沿同鉴权私有RPC读取真实audio，发送前原selection重验且不创建资源', async t => {
  const h=await fixture(t), path='/mobile/v1/tracks/'+h.state.observedTrack.id;
  const input={operation:'getTrack' as const,request:await h.request('getTrack',path),accessToken:h.pair.accessToken,signal:signal(),origin:ORIGIN};
  const reply=await h.service.backend.dispatch(input);assert.equal(reply.status,200);await reply.beforeSend!();
  const result=decode('getTrack',path,reply);assert.ok(result.body&&'audio'in result.body);assert.equal(result.body.audio.codec,'flac');assert.equal(result.body.source,'netease');
  assert.equal(h.state.catalogReads,0);assert.equal(h.state.trackReads,2);assert.equal(h.state.begins,0);assert.equal(h.state.releases,0);
  assert.deepEqual(h.rpcCalls.filter(row=>row.action==='track').map(row=>row.operation),['read','revalidate']);
  assert.doesNotMatch(new TextDecoder().decode(reply.body),/cookie|credential|https?:|sourceIdentity/u);
  const localPath='/mobile/v1/tracks/lt:fixture:1:1';
  const local=await h.service.backend.dispatch({...input,request:await h.request('getTrack',localPath)});await local.beforeSend!();
  assert.equal(h.state.catalogReads,2);assert.equal(h.state.trackReads,2);
});

test('R10_TRACK 发送前账户scope、精确selection或完整DTO变化均拒绝，关闭内容不回落本地',async t=>{
  for(const change of ['scope','selection','metadata','abort','revoke'] as const)await t.test(change,async child=>{
    const h=await fixture(child),path='/mobile/v1/tracks/'+h.state.observedTrack.id,controller=new AbortController();
    const input={operation:'getTrack' as const,request:await h.request('getTrack',path),accessToken:h.pair.accessToken,signal:controller.signal,origin:ORIGIN};
    const reply=await h.service.backend.dispatch(input);
    if(change==='scope')h.state.providerEpoch='provider.changed';
    if(change==='selection')h.state.observedTrack.versionId='nv:changed';
    if(change==='metadata')h.state.observedTrack.title='合成变化';
    if(change==='abort')controller.abort();
    if(change==='revoke')await h.service.auth.revokeDevice(h.pair.deviceId);
    await assert.rejects(reply.beforeSend!());assert.equal(h.state.begins,0);assert.equal(h.state.catalogReads,0);
  });
  const off=await fixture(t,false),path='/mobile/v1/tracks/nt:fixture:1';
  await refuses(off.service.backend.dispatch({operation:'getTrack',request:await off.request('getTrack',path),accessToken:off.pair.accessToken,signal:signal()}),404,'RESOURCE_REVOKED');
  assert.equal(off.rpcCalls.length,0);assert.equal(off.state.catalogReads,0);
});

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
  postMessage(value: unknown): void {
    this.sent.push(value);
    const request = value as { version?: unknown; id?: unknown; command?: unknown };
    // 只补原Core控制关闭合同；mobile-content UNKNOWN/quiet回声仍逐件手动构造。
    if (request.version === IPC_VERSION && request.command === 'core.shutdown' && typeof request.id === 'string') queueMicrotask(() => this.receive({ version: IPC_VERSION, id: request.id, ok: true, result: { stopped: true } }));
  }
  start(): void {} close(): void {}
  receive(value: unknown): void { for (const listener of this.listeners) listener({ data: value }); }
}
class Child implements CoreChildProcess {
  readonly exits: ((code: number) => void)[] = [];
  readonly stdout = {
    listeners: [] as ((chunk: { toString(): string }) => void)[],
    on(_event: 'data', listener: (chunk: { toString(): string }) => void) { this.listeners.push(listener); },
    send(text: string) { for (const listener of this.listeners) listener({ toString: () => text }); },
  };
  postMessage(): void {} once(_event: 'exit', callback: (code: number) => void): void { this.exits.push(callback); }
  kill(): boolean { this.exit(0); return true; } exit(code: number): void { for (const listener of this.exits.splice(0)) listener(code); }
}
test('Supervisor仅将当前Core闭集记录交独立resource槽；毒字段、旧child及回调异常不改变收发', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const channels: { port1: Port; port2: Port }[] = [], children: Child[] = [], rows: string[] = [];
  const probe = createMobilePreparationProbe({ enabled: true }); probe.arm();
  const resource = probe.claim('createResource', randomUUID(), signal()); assert.ok(resource);
  const id = randomUUID(), main = createMobileCapabilityContext(id, 'main', 'content', resource.requestSha256, signal(), resource.sink); assert.ok(main);
  withMobileCapabilityContext(main, () => mobileCapabilitySync('content.rpc.source', () => undefined));
  const core = createMobileCapabilityContext(id, 'core', 'content', null, signal(), line => rows.push(line)); assert.ok(core);
  withMobileCapabilityContext(core, () => mobileCapabilityReject('provider.source.prepare.catalog', new MobileServiceError(409, 'SOURCE_CHANGED')));
  withMobileCapabilityContext(core, () => mobileCapabilityReject('provider.source.prepare.audio-read', new MobileServiceError(409, 'SOURCE_CHANGED')));
  let callbacks = 0;
  const supervisor = new CoreSupervisor({ entryPath: '/Volumes/LifeWeave/Developer/CommandLine/tmp/mobile-resource-core-fixture.js',
    cwd: '/Volumes/LifeWeave/Developer/CommandLine/tmp', startupTimeoutMs: 20,
    onMobileCapabilityTrace(record) { callbacks++; probe.acceptCoreTrace(record); if (callbacks === 1) throw new Error('合成旁注接收故障'); },
    dependencies: { createChannel: () => { const channel = { port1: new Port(), port2: new Port() }; channels.push(channel); return channel; },
      fork: () => { const child = new Child(); children.push(child); return child; } } });
  t.after(async () => { t.mock.timers.reset(); await supervisor.shutdown(); });
  const ready = () => channels.at(-1)!.port2.receive({ version: IPC_VERSION, event: 'core.ready', payload: { state: {
    runtime: 'ready', roon: 'disconnected', provider: 'missing', activeStreamCount: 0, activePlaybackPresent: false } } });
  const starting = supervisor.start(); ready(); await starting;
  const raw = JSON.parse(rows[0]!.slice(MOBILE_CAPABILITY_TRACE_PREFIX.length));
  children[0]!.stdout.send(MOBILE_CAPABILITY_TRACE_PREFIX + JSON.stringify({ ...raw, unknownPayload: '私密正文' }) + '\n'); assert.equal(callbacks, 0);
  children[0]!.stdout.send(rows.join('')); assert.equal(callbacks, 2); assert.equal(supervisor.status, 'ready');
  const first = probe.snapshot().resourceScopes[0]!.trace.firstBusinessFailures.find(row => row.component === 'core');
  assert.equal(first?.stage, 'provider.source.prepare.catalog'); assert.equal(first?.code, 'SOURCE_CHANGED');
  children[0]!.exit(1); await new Promise<void>(resolve => setImmediate(resolve)); ready(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(children.length, 2); assert.equal(supervisor.status, 'ready');
  children[0]!.stdout.send(rows.join('')); assert.equal(callbacks, 2);
  children[1]!.stdout.send(rows.join('')); assert.equal(callbacks, 4);
  assert.ok(copyMobilePreparationSnapshot(probe.snapshot()));
});
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

test('关闭复核的Supervisor守卫：同代原cancel nonce与目标全同才可发送，换代或错目标不发送', async t => {
  const turn = () => new Promise<void>(resolve => setImmediate(resolve));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const channels: { port1: Port; port2: Port }[] = [], children: Child[] = [];
  const supervisor = new CoreSupervisor({ entryPath: '/Volumes/LifeWeave/Developer/CommandLine/tmp/mobile-close-recheck-fixture.js',
    cwd: '/Volumes/LifeWeave/Developer/CommandLine/tmp', dependencies: {
      createChannel: () => { const value = { port1: new Port(), port2: new Port() }; channels.push(value); return value; },
      fork: () => { const value = new Child(); children.push(value); return value; } } });
  t.after(async () => { t.mock.timers.reset(); await supervisor.shutdown(); });
  const ready = () => channels.at(-1)!.port2.receive({ version: IPC_VERSION, event: 'core.ready', payload: { state: {
    runtime: 'ready', roon: 'disconnected', provider: 'missing', activeStreamCount: 0, activePlaybackPresent: false } } });
  const starting = supervisor.start(); ready(); await starting;
  const port = channels[0]!.port2;
  const original: MobileContentCoreRequest = { ...base(), action: 'scope', principal: {
    serverId: SERVER, datasetId: DATASET, deviceId: 'quiet.original.device', deviceEpoch: 1, accessGeneration: 1 } };
  const first = supervisor.requestMobileContentMain(original, signal());
  port.receive(mobileContentRpcFailure(original, new MobileAuthPersistenceError('unknown'))); await first;
  const cancel: Extract<MobileContentCoreRequest, { action: 'cancel' }> = { ...base(), action: 'cancel', requestId: original.id, snapshotId: null, scope: null };
  const pending = supervisor.requestMobileContentMain(cancel, signal());
  port.receive(mobileContentRpcFailure(cancel, new MobileAuthPersistenceError('unknown'))); await pending;
  const metadata = { previousCancelId: cancel.id };
  // UNKNOWN占位不能让调用者换目标；拒绝必须发生在postMessage之前。
  const wrong = { ...cancel, id: randomUUID(), requestId: randomUUID() };
  let sentBefore = port.sent.length;
  const wrongAttempt = supervisor.requestMobileContentMain(wrong, signal(), metadata);
  port.receive({ type: 'mobile-content-core-response', id: wrong.id, action: 'cancel', kind: 'cancelled', requestId: wrong.requestId, snapshotId: null, quiet: true });
  await assert.rejects(wrongAttempt, MobileAuthPersistenceError);
  assert.equal(port.sent.length, sentBefore);
  const recheck = { ...cancel, id: randomUUID() };
  const checking = supervisor.requestMobileContentMain(recheck, signal(), metadata);
  port.receive({ type: 'mobile-content-core-response', id: recheck.id, action: 'cancel', kind: 'cancelled',
    requestId: original.id, snapshotId: null, quiet: true });
  assert.equal((await checking).action, 'cancel');
  children[0]!.exit(1); await turn(); ready(); await turn();
  assert.equal(supervisor.status, 'ready');
  const nextPort = channels[1]!.port2; sentBefore = nextPort.sent.length;
  const stale = { ...cancel, id: randomUUID() }, staleAttempt = supervisor.requestMobileContentMain(stale, signal(), metadata);
  nextPort.receive({ type: 'mobile-content-core-response', id: stale.id, action: 'cancel', kind: 'cancelled', requestId: stale.requestId, snapshotId: null, quiet: true });
  await assert.rejects(staleAttempt, MobileAuthPersistenceError);
  assert.equal(nextPort.sent.length, sentBefore, '新Core对空nonce的ACK不能证明旧Core已quiet。');
});

test('关闭复核：迟到snapshot独立保留原绑定，等待两类取消目标真实ACK且不再dispatch', async t => {
  const scope: Readonly<MobileContentScope> = { serverId: SERVER, datasetId: DATASET, deviceId: 'late.snapshot.device', deviceEpoch: 1,
    accessGeneration: 1, ownerEpoch: 'late.snapshot.owner', accountDomain: ACCOUNT, providerEpoch: null };
  const operation = 'listRecentlyAddedAlbums' as const, facts = contentFixture(operation, scope);
  const entered = deferred(), release = deferred(), controller = new AbortController(), snapshotId = randomUUID();
  const calls: { request: MobileContentCoreRequest; recheck: MobileContentCancelRecheck | undefined }[] = [];
  const main = createMainMobileContentPort({ serverId: SERVER, datasetId: DATASET, key: new Uint8Array(32).fill(41), assertCurrent() {},
    requestRpc: async (request, _signal, recheck) => {
      calls.push({ request, recheck });
      if (request.action === 'initialize') return { type: 'mobile-content-core-response', id: request.id, action: 'initialize', ok: true };
      if (request.action === 'dispatch') {
        entered.resolve(); await release.promise;
        return { type: 'mobile-content-core-response', id: request.id, action: 'dispatch', kind: 'snapshot',
          operation, scope, snapshotId, reply: facts.reply, context: facts.context };
      }
      if (request.action !== 'cancel') throw new Error('本例不再发送业务请求。');
      if (!recheck) return mobileContentRpcFailure(request, new MobileAuthPersistenceError('unknown'));
      const previous = calls.find(value => value.request.id === recheck.previousCancelId)?.request;
      assert.ok(previous?.action === 'cancel'); assert.equal(previous.requestId, request.requestId);
      assert.equal(previous.snapshotId, request.snapshotId); assert.deepEqual(previous.scope, request.scope);
      return { type: 'mobile-content-core-response', id: request.id, action: 'cancel', kind: 'cancelled',
        requestId: request.requestId, snapshotId: request.snapshotId, quiet: true };
    } });
  t.after(() => release.resolve());
  const pending = main.content.dispatch({ operation, scope, request: facts.request, signal: controller.signal });
  await entered.promise; controller.abort(); await refuses(pending, 503, 'BUSY', 'unknown');
  const closing = main.close(); release.resolve(); await closing;
  assert.equal(calls.filter(value => value.request.action === 'dispatch').length, 1);
  const cancellations = calls.filter(value => value.request.action === 'cancel');
  assert.equal(cancellations.length, 4);
  assert.equal(cancellations.filter(value => value.request.action === 'cancel' && value.request.snapshotId === snapshotId).length, 2);
  assert.equal(cancellations.filter(value => value.recheck !== undefined).length, 2);
  await refuses(pending, 503, 'BUSY', 'unknown');
  assert.equal(main.close(), closing);
});
