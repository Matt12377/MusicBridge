import assert from 'node:assert/strict';
import { MOBILE_RESOURCE_CAPACITY_FLAG, mobileResourceCapacityFailure } from '../../src/mobile/resource-capacity-trace.js';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test, { type TestContext } from 'node:test';
import { decodeMobileRequest, mobileCanonicalJson, type MobileContentReadContext, type MobileHeaderPairs, type MobileWireCodecContext, type MobileJsonValue } from '@music-bridge/contracts';
import type { MobileTrack } from '@music-bridge/contracts';
import { captureMobileContentReply } from '../../src/mobile/content-protocol.js';
import { captureMobileContentCoreRequest, captureMobileContentCoreResponse, mobileContentRpcFailure, type MobileContentCoreRequest,
  type MobileContentCoreResponse } from '../../src/mobile/content-rpc.js';
import { createMobileContentRpcPort, type MobileContentRpcPortOptions } from '../../src/mobile/content-rpc-port.js';
import type { MobileContentOperation, MobileContentPort, MobileContentScope, MobileContentServiceInput, MobileContentSnapshot } from '../../src/mobile/content-types.js';
import { MobileAuthPersistenceError, MobileServiceError } from '../../src/mobile/types.js';
import { MobileContentPersistenceError } from '../../src/mobile/content-owner-store.js';
import { MobilePlaybackError } from '../../src/mobile/playback-types.js';
import { captureMobileCapabilityContext, mobileCapabilityReject, mobileCapabilityRequestSha,
  snapshotMobileCapabilityTrace } from '../../src/mobile/capability-trace.js';

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
function requestFixture<O extends MobileContentOperation>(operation: O) {
  const row = manifest.cases.find(value => value.operationId === operation && value.role === 'DECLARED_SUCCESS'); assert.ok(row);
  const context = manifest.contexts[row.context]; assert.ok(context?.content);
  const decoded = decodeMobileRequest(operation, { method: row.method, path: row.path, headers: row.request.headers,
    query: row.request.query, body: whole(row.request.body) }, context); assert.ok(decoded.ok);
  return { row, context, request: decoded.value };
}
function fixture<O extends MobileContentOperation>(operation: O, actualScope = scope) {
  const { row, context, request } = requestFixture(operation);
  assert.ok(context.content);
  const trusted: MobileContentReadContext = { ...structuredClone(context.content), serverId: actualScope.serverId,
    deviceId: actualScope.deviceId, accountDomain: actualScope.accountDomain,
    ...(operation === 'listPersonalPlaylists' ? { pageOffset: 0 } : {}) };
  return { request, ...captureMobileContentReply(operation, request, actualScope,
    { status: row.response.status, category: 'success', body: JSON.parse(new TextDecoder().decode(whole(row.response.body))) as unknown }, trusted) };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const base = () => ({ type: 'mobile-content-core-request' as const, id: randomUUID() });
const signal = () => new AbortController().signal;

test('显式本地容量flag让第九次Core来源首拒可见，默认关闭且原RPC错误不变', async t => {
  for (const enabled of [false, true]) {
    if (enabled) process.argv.push(MOBILE_RESOURCE_CAPACITY_FLAG);
    const building = harness(t, { source: async () => mobileResourceCapacityFailure('capacity.core.active-bindings-full', () => {
      throw new MobileServiceError(429, 'RESOURCE_BUSY');
    }) }, enabled);
    if (enabled) assert.equal(process.argv.pop(), MOBILE_RESOURCE_CAPACITY_FLAG);
    const h = await building;
    for (let index = 0; index < 9; index++) {
      const input: MobileContentCoreRequest = { ...base(), action: 'source', scope, request: { operation: 'prepare', selection: {
        resourceId: randomUUID(), trackId: 'nt:synthetic-track', versionId: 'nv:synthetic-version', contentRevision: 'nr:synthetic-content',
      } } };
      const result = await h.rpc.request(input, signal()); failure(result, 'RESOURCE_BUSY');
      assert.ok('status' in result); assert.equal(result.status, 429);
      const hash = mobileCapabilityRequestSha('content', input.id);
      const recorded = snapshotMobileCapabilityTrace().records.filter(row => row.requestSha256 === hash && row.stage === 'capacity.core.active-bindings-full');
      assert.equal(recorded.length, enabled ? 1 : 0);
    }
  }
});
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
async function harness(t: TestContext, extra: Partial<MobileContentRpcPortOptions> = {}, privateDiagnostics = false) {
  let initCalls = 0;
  const rpc = createMobileContentRpcPort({ initialize: async input => {
    initCalls++; assert.equal(input.serverId, scope.serverId); assert.equal(input.datasetId, scope.datasetId); assert.equal(input.key.byteLength, 32);
  }, invalidateDevice: async () => undefined, content: port(), resolveScope: async identity => ({ ...scope, ...identity }),
    assertScope: () => undefined, source: async () => { throw new MobileServiceError(409, 'UNSUPPORTED_FORMAT'); }, ...extra });
  const key = new Uint8Array(32).fill(19);
  const initialized = await rpc.request({ ...base(), action: 'initialize', serverId: scope.serverId, datasetId: scope.datasetId, key,
    ...(privateDiagnostics ? { privateProviderDiagnostics: true as const } : {}) }, signal());
  assert.ok(initialized.action === 'initialize' && 'ok' in initialized && initialized.ok);
  t.after(() => rpc.close());
  return { rpc, key, initCalls: () => initCalls,
    dispatch: (operation: MobileContentOperation, parent = signal(), actualScope = scope) => {
      const request: MobileContentCoreRequest = { ...base(), action: 'dispatch', operation, scope: actualScope, request: requestFixture(operation).request };
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

const observedTrack:MobileTrack={id:'nt:fixture:1',source:'netease',sourceItemId:'1',albumId:'na:fixture:1',title:'合成真实探测',artists:['合成艺人'],
  versionId:'nv:fixture',contentRevision:'nr:fixture',editionLabel:'',durationMs:1000,availability:'available',audio:{codec:'flac',container:'flac',sampleRateHz:192000,bitsPerSample:24,channels:2}};
const trackRequest=()=>({...base(),action:'track' as const,operation:'read' as const,scope,trackId:observedTrack.id,expectedSelection:null,expectedFingerprint:null});
test('R10_TRACK 私有track严格绑定请求和完整已探测DTO，未知音频或额外字段不能过界',async t=>{
  const h=await harness(t,{readTrack:async()=>structuredClone(observedTrack)});
  const request=captureMobileContentCoreRequest(trackRequest()),result=await h.rpc.request(request,signal());
  assert.ok(result.action==='track'&&result.kind==='track');assert.equal(result.track.audio.codec,'flac');
  const selected={trackId:result.track.id,source:'netease' as const,versionId:result.track.versionId,contentRevision:result.track.contentRevision};
  const validate={...trackRequest(),id:randomUUID(),operation:'revalidate' as const,expectedSelection:selected,expectedFingerprint:result.fingerprint};
  const ack=await h.rpc.request(validate,signal());assert.ok(ack.action==='track'&&ack.kind==='track-validated');
  for(const raw of [{...trackRequest(),token:'禁止凭据'}, {...trackRequest(),expectedSelection:selected},
    {...validate,expectedSelection:{...selected,trackId:'nt:fixture:2'}}, {...validate,expectedFingerprint:'bad'}])assert.throws(()=>captureMobileContentCoreRequest(raw));
  for(const raw of [{...result,track:{...result.track,audio:{codec:'unknown',container:'unknown'}}},
    {...result,track:{...result.track,audio:{...result.track.audio,bitsPerSample:undefined}}},
    {...result,track:{...result.track,url:'https://禁止来源.invalid'}},{...result,scope:{...scope,accountDomain:'other'}},{...result,fingerprint:'f'.repeat(64)}])assert.throws(()=>captureMobileContentCoreResponse(raw,request));
});

test('R10_TRACK 原track取消先封输出，原底层未完不能ACKquiet且控制槽保留',async t=>{
  const entered=deferred(),release=deferred();let done=false;
  const h=await harness(t,{maxInflight:2,readTrack:async()=>{entered.resolve();await release.promise;return structuredClone(observedTrack);}});
  const original=trackRequest(),parent=new AbortController(),reading=h.rpc.request(original,parent.signal);
  try{
    await entered.promise;failure(await h.rpc.request(trackRequest(),signal()),'BUSY');parent.abort();await reading;
    const cancelling=h.rpc.request({...base(),action:'cancel',requestId:original.id,snapshotId:null,scope},signal()).then(result=>{done=true;return result;});
    for(let i=0;i<80;i++)await Promise.resolve();assert.equal(done,false);
    release.resolve();const result=await cancelling;assert.ok(result.action==='cancel'&&result.kind==='cancelled'&&result.quiet);
  }finally{release.resolve();await reading;}
});

test('R10_TRACK 两种诊断桶各八次，默认关闭与重复初始化不提升且第九次业务仍执行',async t=>{
  for(const enabled of [false,true])await t.test(String(enabled),async child=>{
    const seen:boolean[]=[],h=await harness(child,{readTrack:async()=>{seen.push(captureMobileCapabilityContext()?.privateContentDiagnostic===true);return structuredClone(observedTrack);}},enabled);
    const reinit=await h.rpc.request({...base(),action:'initialize',serverId:scope.serverId,datasetId:scope.datasetId,key:h.key,privateProviderDiagnostics:true},signal());
    assert.ok('ok' in reinit&&reinit.ok);assert.equal(h.initCalls(),1);
    const expectedSelection={trackId:observedTrack.id,source:'netease' as const,versionId:observedTrack.versionId,contentRevision:observedTrack.contentRevision};
    const expectedFingerprint=createHash('sha256').update(mobileCanonicalJson(observedTrack as unknown as MobileJsonValue)).digest('hex');
    for(const operation of ['read','revalidate'] as const){seen.length=0;
      for(let i=0;i<9;i++){const result=await h.rpc.request({...trackRequest(),operation,
        expectedSelection:operation==='read'?null:expectedSelection,expectedFingerprint:operation==='read'?null:expectedFingerprint},signal());
        assert.ok(result.action==='track'&&(result.kind==='track'||result.kind==='track-validated'));}
      assert.deepEqual(seen,Array.from({length:9},(_,i)=>enabled&&i<8));
    }
  });
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

const diagnosticOperations = ['getNeteaseDailyRecommendations', 'getNeteasePersonalFM', 'listNeteaseNewAlbums',
  'listNeteaseCharts', 'listNeteaseRecommendedPlaylists', 'getNeteaseLikedPlaylist', 'listNeteaseLikedPlaylistTracks',
  'getNeteaseDiscoveryCollectionTracks'] as const;
const diagnosticFields = ['schema', 'component', 'requestSha256', 'parentSha256', 'relatedSha256', 'epochMs',
  'elapsedMs', 'stage', 'phase', 'role', 'name', 'code', 'outcome', 'aborted', 'initState'].sort();
const privateMarker = 'synthetic-r8-private-content';
function diagnosticFailure() {
  const error = new MobileServiceError(409, 'SOURCE_CHANGED');
  Object.defineProperty(error, 'privateData', { value: privateMarker });
  mobileCapabilityReject('provider.content.collection.count-mismatch', error);
  throw error;
}
function diagnosticRows(id: string) {
  const sha = mobileCapabilityRequestSha('content', id); assert.ok(sha);
  const snapshot = snapshotMobileCapabilityTrace();
  return { records: snapshot.records.filter(row => row.component === 'core' && row.requestSha256 === sha),
    first: snapshot.firstBusinessFailures.filter(row => row.component === 'core' && row.requestSha256 === sha) };
}

for (const operation of ['getNeteaseLikedPlaylist', 'listNeteaseLikedPlaylistTracks', 'getNeteaseDiscoveryCollectionTracks'] as const) {
  test('R8_DIAGNOSTICS ' + operation + '保留原Provider首拒且不泄露附加字段', async t => {
    let calls = 0, observed = false;
    const h = await harness(t, { content: port(() => {
      calls++; observed = captureMobileCapabilityContext()?.privateContentDiagnostic === true;
      diagnosticFailure();
    }) }, true);
    const request = h.dispatch(operation); failure(await request.promise, 'SOURCE_CHANGED');
    assert.equal(calls, 1); assert.equal(observed, true);
    const trace = diagnosticRows(request.request.id); assert.equal(trace.first.length, 1);
    assert.equal(trace.first[0]!.stage, 'provider.content.collection.count-mismatch');
    assert.equal(trace.first[0]!.code, 'SOURCE_CHANGED');
    assert.deepEqual(Object.keys(trace.first[0]!).sort(), diagnosticFields);
    assert.equal(JSON.stringify(trace).includes(privateMarker), false);
  });
}

test('R8_DIAGNOSTICS 某发现方法用满八次仍不消耗其他方法的首拒额度', async t => {
  let calls = 0;
  const h = await harness(t, { content: port(() => { calls++; diagnosticFailure(); }) }, true);
  for (let index = 0; index < 8; index++) failure(await h.dispatch('getNeteaseDailyRecommendations').promise, 'SOURCE_CHANGED');
  for (const operation of ['listNeteaseCharts', 'getNeteaseLikedPlaylist', 'getNeteaseDiscoveryCollectionTracks'] as const) {
    const request = h.dispatch(operation); failure(await request.promise, 'SOURCE_CHANGED');
    assert.equal(diagnosticRows(request.request.id).first[0]?.stage, 'provider.content.collection.count-mismatch');
  }
  assert.equal(calls, 11);
});

test('R8_DIAGNOSTICS 默认关闭且不为其他内容操作增加上下文', async t => {
  let contexts = 0, calls = 0;
  const content = port(() => { calls++; if (captureMobileCapabilityContext()) contexts++; diagnosticFailure(); });
  const ordinary = await harness(t, { content });
  for (const operation of diagnosticOperations) {
    const request = ordinary.dispatch(operation); failure(await request.promise, 'SOURCE_CHANGED');
    assert.equal(diagnosticRows(request.request.id).first.length, 0);
  }
  const privatePort = await harness(t, { content }, true);
  const unrelated = privatePort.dispatch('listPersonalPlaylists'); failure(await unrelated.promise, 'SOURCE_CHANGED');
  assert.equal(diagnosticRows(unrelated.request.id).first.length, 0);
  assert.equal(contexts, 0); assert.equal(calls, 9);
});

test('R8_DIAGNOSTICS 其他七方法各八次，红心分页第九次仍保留上下文', async t => {
  let contexts = 0, calls = 0;
  const retained: string[] = [];
  const h = await harness(t, { content: port(() => {
    calls++; if (captureMobileCapabilityContext()?.privateContentDiagnostic === true) contexts++;
    diagnosticFailure();
  }) }, true);
  for (const operation of diagnosticOperations) {
    for (let index = 0; index < 9; index++) {
      const request = h.dispatch(operation); failure(await request.promise, 'SOURCE_CHANGED');
      const trace = diagnosticRows(request.request.id);
      const captured = index < 8 || operation === 'listNeteaseLikedPlaylistTracks';
      assert.equal(trace.first.length, captured ? 1 : 0);
      if (captured) {
        retained.push(request.request.id);
        assert.equal(trace.first[0]!.stage, 'provider.content.collection.count-mismatch');
        assert.ok(trace.records.length <= 64);
      }
    }
  }
  assert.equal(contexts, 65); assert.equal(calls, 72);
  // 环已被后续事件覆盖，独立首错表仍只保存最近六十四个请求。
  assert.ok(snapshotMobileCapabilityTrace().droppedRecords > 0);
  assert.equal(diagnosticRows(retained[0]!).first.length, 0);
  for (const id of retained.slice(-64)) assert.equal(diagnosticRows(id).first.length, 1);
});

test('R8_DIAGNOSTICS 新增详情上下文保留原abort和真实quiet，关闭后不再执行', async t => {
  const entered = deferred(), release = deferred(); let calls = 0, observed = false;
  t.after(() => release.resolve());
  const h = await harness(t, { content: port(async input => {
    calls++; observed = captureMobileCapabilityContext()?.privateContentDiagnostic === true;
    entered.resolve(); await release.promise; input.signal.throwIfAborted();
  }) }, true);
  const controller = new AbortController(), request = h.dispatch('getNeteaseDiscoveryCollectionTracks', controller.signal);
  await entered.promise; controller.abort(); failure(await request.promise, 'BUSY', 'unknown');
  let quiet = false;
  const cancelled = h.rpc.request({ ...base(), action: 'cancel', requestId: request.request.id, snapshotId: null, scope }, signal())
    .then(value => { quiet = true; return value; });
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(quiet, false);
  release.resolve(); const ack = await cancelled;
  assert.ok(ack.action === 'cancel' && 'kind' in ack && ack.kind === 'cancelled' && ack.quiet);
  assert.equal(observed, true); assert.equal(calls, 1);
  const first = diagnosticRows(request.request.id).first[0];
  assert.ok(first); assert.equal(first.stage, 'core.rpc.failure');
  assert.equal(first.code, 'UNKNOWN'); assert.equal(first.outcome, 'unknown'); assert.equal(first.aborted, true);
  await h.rpc.close(); failure(await h.dispatch('getNeteaseDiscoveryCollectionTracks').promise);
  assert.equal(calls, 1);
});

const resourceDiagnosticKinds = ['source.prepare', 'artwork.read', 'artwork.revalidate'] as const;
type ResourceDiagnosticKind = typeof resourceDiagnosticKinds[number];
function resourceDiagnosticRequest(kind: ResourceDiagnosticKind): MobileContentCoreRequest {
  return kind === 'source.prepare'
    ? { ...base(), action: 'source', scope, request: { operation: 'prepare', selection: {
      resourceId: randomUUID(), trackId: 'nt:synthetic-track', versionId: 'nv:synthetic-version', contentRevision: 'nr:synthetic-content',
    } } }
    : { ...base(), action: 'artwork', scope, operation: kind === 'artwork.read' ? 'read' : 'revalidate',
      artworkId: 'naw:synthetic-artwork', expectedRevision: kind === 'artwork.read' ? null : 'art-revision:expected' };
}
function resourceDiagnosticFailure(): never {
  const error = new MobileServiceError(409, 'SOURCE_CHANGED');
  Object.defineProperty(error, 'privateData', { value: 'synthetic-r9-hidden-source-or-artwork' });
  throw error;
}

for (const kind of resourceDiagnosticKinds) {
  test('R9_RESOURCE_DIAGNOSTICS ' + kind + '在原业务拒绝处保留首错与十五字段闭集', async t => {
    let calls = 0, observed = false;
    const reject = () => { calls++; observed = captureMobileCapabilityContext()?.privateContentDiagnostic === true; return resourceDiagnosticFailure(); };
    const h = await harness(t, { source: async () => reject(), readArtwork: async () => reject(), assertArtwork: async () => reject() }, true);
    const request = resourceDiagnosticRequest(kind), result = await h.rpc.request(request, signal());
    failure(result, 'SOURCE_CHANGED'); assert.ok('status' in result); assert.equal(result.status, 409);
    assert.equal(calls, 1); assert.equal(observed, true);
    const trace = diagnosticRows(request.id); assert.equal(trace.first.length, 1);
    assert.equal(trace.first[0]!.stage, 'core.provider.read'); assert.equal(trace.first[0]!.code, 'SOURCE_CHANGED');
    assert.deepEqual(Object.keys(trace.first[0]!).sort(), diagnosticFields);
    assert.equal(JSON.stringify(trace).includes('synthetic-r9-hidden-source-or-artwork'), false);
  });
}

test('R9_RESOURCE_DIAGNOSTICS artwork重验原版本不匹配保留专属首拒且仍返回409', async t => {
  let reads = 0;
  const h = await harness(t, { assertArtwork: async () => { reads++; return 'art-revision:actual'; } }, true);
  const request = resourceDiagnosticRequest('artwork.revalidate'), result = await h.rpc.request(request, signal());
  failure(result, 'SOURCE_CHANGED'); assert.ok('status' in result); assert.equal(result.status, 409); assert.equal(reads, 1);
  const trace = diagnosticRows(request.id); assert.equal(trace.first.length, 1);
  assert.equal(trace.first[0]!.stage, 'provider.artwork.revision-changed');
  assert.equal(trace.first[0]!.code, 'SOURCE_CHANGED'); assert.deepEqual(Object.keys(trace.first[0]!).sort(), diagnosticFields);
});

test('R9_RESOURCE_DIAGNOSTICS 缺省初始化及重复开关不启用，普通source读与释放不消费私有上下文', async t => {
  let calls = 0, contexts = 0;
  const reject = () => { calls++; if (captureMobileCapabilityContext()?.privateContentDiagnostic === true) contexts++; return resourceDiagnosticFailure(); };
  const extra = { source: async () => reject(), readArtwork: async () => reject(), assertArtwork: async () => reject() };
  const ordinary = await harness(t, extra);
  // 已初始化的普通端口不能靠重复initialize提升私有观察权限。
  const repeated = await ordinary.rpc.request({ ...base(), action: 'initialize', serverId: scope.serverId, datasetId: scope.datasetId,
    key: ordinary.key, privateProviderDiagnostics: true }, signal());
  assert.ok(repeated.action === 'initialize' && 'ok' in repeated && repeated.ok);
  for (const kind of resourceDiagnosticKinds) {
    const request = resourceDiagnosticRequest(kind); failure(await ordinary.rpc.request(request, signal()), 'SOURCE_CHANGED');
    assert.equal(diagnosticRows(request.id).first.length, 0);
  }
  const privatePort = await harness(t, extra, true);
  const handle = randomUUID(), readId = randomUUID();
  const requests: MobileContentCoreRequest[] = [
    { ...base(), action: 'source', scope, request: { operation: 'read', handle, readId, start: 0, maxBytes: 4 } },
    ...(['verify', 'renew', 'status', 'release'] as const).map(operation => ({ ...base(), action: 'source' as const, scope, request: { operation, handle } })),
    { ...base(), action: 'source', scope, request: { operation: 'close-read', handle, readId } },
  ];
  for (const request of requests) {
    failure(await privatePort.rpc.request(request, signal()), 'SOURCE_CHANGED');
    assert.equal(diagnosticRows(request.id).records.length, 0); assert.equal(diagnosticRows(request.id).first.length, 0);
  }
  assert.equal(calls, 9); assert.equal(contexts, 0);
});

test('R9_RESOURCE_DIAGNOSTICS 九轮红心保留九次、其余十桶各八次，99次业务照常', async t => {
  const calls = new Map<string, number>(), contexts = new Map<string, number>();
  const observe = (key: string) => {
    calls.set(key, (calls.get(key) ?? 0) + 1);
    if (captureMobileCapabilityContext()?.privateContentDiagnostic === true) contexts.set(key, (contexts.get(key) ?? 0) + 1);
  };
  const h = await harness(t, {
    content: port(input => { observe(input.operation); diagnosticFailure(); }),
    source: async () => { observe('source.prepare'); return resourceDiagnosticFailure(); },
    readArtwork: async () => { observe('artwork.read'); return resourceDiagnosticFailure(); },
    assertArtwork: async () => { observe('artwork.revalidate'); return resourceDiagnosticFailure(); },
  }, true);
  for (const operation of diagnosticOperations) {
    for (let index = 0; index < 9; index++) {
      const request = h.dispatch(operation); failure(await request.promise, 'SOURCE_CHANGED');
      assert.equal(diagnosticRows(request.request.id).first.length, index < 8 || operation === 'listNeteaseLikedPlaylistTracks' ? 1 : 0);
    }
  }
  for (const kind of resourceDiagnosticKinds) {
    for (let index = 0; index < 9; index++) {
      const request = resourceDiagnosticRequest(kind); failure(await h.rpc.request(request, signal()), 'SOURCE_CHANGED');
      const trace = diagnosticRows(request.id); assert.equal(trace.first.length, index < 8 ? 1 : 0);
      if (index < 8) { assert.equal(trace.first[0]!.stage, 'core.provider.read'); assert.ok(trace.records.length <= 64); }
    }
  }
  assert.equal(calls.size, 11); assert.equal(contexts.size, 11);
  assert.equal([...calls.values()].reduce((sum, count) => sum + count, 0), 99);
  assert.equal([...contexts.values()].reduce((sum, count) => sum + count, 0), 89);
  for (const key of [...diagnosticOperations, ...resourceDiagnosticKinds]) {
    assert.equal(calls.get(key), 9); assert.equal(contexts.get(key), key === 'listNeteaseLikedPlaylistTracks' ? 9 : 8);
  }
});

for (const kind of resourceDiagnosticKinds) {
  test('R9_RESOURCE_DIAGNOSTICS ' + kind + '取消只封输出，原flight退出才关闭上下文并确认quiet', async t => {
    const entered = deferred(), release = deferred(); let calls = 0;
    let observed: ReturnType<typeof captureMobileCapabilityContext>;
    t.after(() => release.resolve());
    const wait = async (owned: AbortSignal): Promise<never> => {
      calls++; observed = captureMobileCapabilityContext(); entered.resolve(); await release.promise;
      owned.throwIfAborted(); return resourceDiagnosticFailure();
    };
    const h = await harness(t, {
      source: (_scope, _request, owned) => wait(owned), readArtwork: (_scope, _id, owned) => wait(owned),
      assertArtwork: (_scope, _id, owned) => wait(owned), maxInflight: 2,
    }, true);
    const controller = new AbortController(), request = resourceDiagnosticRequest(kind), pending = h.rpc.request(request, controller.signal);
    await entered.promise; controller.abort(); failure(await pending, 'BUSY', 'unknown');
    assert.ok(observed?.privateContentDiagnostic); assert.equal(observed.closed, false);
    failure(await h.rpc.request(resourceDiagnosticRequest(kind), signal())); assert.equal(calls, 1);
    let quiet = false;
    const cancelled = h.rpc.request({ ...base(), action: 'cancel', requestId: request.id, snapshotId: null, scope }, signal())
      .then(value => { quiet = true; return value; });
    await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(quiet, false); assert.equal(observed.closed, false);
    release.resolve(); const ack = await cancelled;
    assert.ok(ack.action === 'cancel' && 'kind' in ack && ack.kind === 'cancelled' && ack.quiet);
    assert.equal(observed.closed, true); assert.equal(calls, 1);
    const first = diagnosticRows(request.id).first[0]; assert.ok(first);
    assert.equal(first.code, 'UNKNOWN'); assert.equal(first.outcome, 'unknown'); assert.equal(first.aborted, true);
    await h.rpc.close(); failure(await h.rpc.request(resourceDiagnosticRequest(kind), signal())); assert.equal(calls, 1);
  });
}
