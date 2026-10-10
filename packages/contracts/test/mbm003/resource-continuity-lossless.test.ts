import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyJson, encode, exerciseFixture, fixtureCase, fixtureGroup, fixtureJson, jsonHeaders, loadDsdFixtures, loadFreshMobileContracts, plain, responseInput, safeClone, sha256 } from './fixture-helpers.js';
import type { MobileJsonValue } from '../../src/mobile-common.js';
import type { MobileReadyResource, MobileResource, MobileResourceRequest } from '../../src/mobile-resource.js';
import type { MobileMutationIdentity, MobileMutationRecord, MobileMutationScope } from '../../src/mobile-wire.js';

const m = await loadFreshMobileContracts('packages/contracts/test/mbm003/resource-continuity-lossless.test.ts');
const fixtures = loadDsdFixtures();
const base = fixtureCase(fixtures,'base-opt-in');
const context = base.context.resource!;
const ready = bodyJson<MobileReadyResource>(fixtures,'dsd-ready');

test('MBM003同产物连续性：GET及ready renew可换票据到期和准确缓存事实',() => {
  for (const row of fixtureGroup(fixtures,'continuity-valid')) {
    exerciseFixture(m,row);
    const next = fixtureJson<MobileReadyResource>(row.response.body);
    assert.equal(m.resource.mobileResourceStableFactsMatch(ready,next),true,row.id);
    assert.deepStrictEqual(next.sourceAudio,ready.sourceAudio); assert.deepStrictEqual(next.media.actualAudio,ready.media.actualAudio);
    assert.equal(next.processing.mode,ready.processing.mode); assert.equal(next.processing.reason,ready.processing.reason);
    assert.equal(next.media.durationMs,ready.media.durationMs); assert.equal(next.media.seekable,ready.media.seekable);
    assert.equal(next.processing.fromPreparedCache,true); assert.notEqual(next.media.url,ready.media.url); assert.notEqual(next.media.expiresAt,ready.media.expiresAt);
  }
  const renewed = bodyJson<MobileReadyResource>(fixtures,'dsd-ready-renewed');
  const extended = {...renewed,media:{...renewed.media,expiresAt:'2030-01-01T00:05:00Z'}};
  const row = fixtureCase(fixtures,'stable-renewResource'), bytes = encode(extended);
  const afterFirstWindow = {...row.context,resource:{...row.context.resource!,now:'2030-01-01T00:04:01Z'}};
  const accepted = m.wire.decodeMobileResponse('renewResource',{...responseInput(row),headers:jsonHeaders(bytes),body:bytes},afterFirstWindow);
  assert(accepted.ok); assert.equal((accepted.value.body as MobileReadyResource).state,'ready');
  // ready后的正常renew沿原TTL；纯codec不拥有entry首次准备计时器，不据此证明Core deadline。
});

test('MBM003来源稳定：同resource换时钟容器声道或已知码率即使新context匹配仍拒',() => {
  const rows = fixtureGroup(fixtures,'continuity-source-drift'); assert.equal(rows.length,8);
  for (const row of rows) {
    exerciseFixture(m,row);
    const changed = fixtureJson<MobileResource>(row.response.body);
    assert.equal(m.resource.mobileResourceStableFactsMatch(ready,changed),false,row.id);
    assert.deepStrictEqual(changed.sourceAudio,row.context.resource!.sourceAudio);
  }
});

test('MBM003实际音频稳定：GET与renew均不能借原resource换采样位深声道容器',() => {
  const rows = fixtureGroup(fixtures,'continuity-actual-drift'); assert.equal(rows.length,8);
  for (const row of rows) { exerciseFixture(m,row); assert.equal(m.resource.mobileResourceStableFactsMatch(ready,fixtureJson<MobileResource>(row.response.body)),false,row.id); }
});

test('MBM003处理稳定：缓存命中不授权替换mode或DSD解释reason',() => {
  const rows = fixtureGroup(fixtures,'continuity-processing-drift'); assert.equal(rows.length,4);
  for (const row of rows) { exerciseFixture(m,row); assert.equal(m.resource.mobileResourceStableFactsMatch(ready,fixtureJson<MobileResource>(row.response.body)),false,row.id); }
  const cached = bodyJson<MobileReadyResource>(fixtures,'dsd-ready-renewed');
  assert.equal(m.resource.mobileResourceStableFactsMatch(ready,cached),true);
  assert.equal(cached.processing.fromPreparedCache,true); assert.equal(cached.processing.reason,ready.processing.reason);
});

test('MBM003已知媒体稳定：duration和seekable不能在GET或renew漂移',() => {
  const rows = fixtureGroup(fixtures,'continuity-media-drift'); assert.equal(rows.length,4);
  for (const row of rows) { exerciseFixture(m,row); assert.equal(m.resource.mobileResourceStableFactsMatch(ready,fixtureJson<MobileResource>(row.response.body)),false,row.id); }
  const plainCopy = plain(ready); assert.equal(m.resource.mobileResourceStableFactsMatch(ready,plainCopy),true);
});

test('MBM003首次ready事实：preparing可补实际产物但GET与renew不得新加旧资源许可',() => {
  const before = bodyJson<MobileResource>(fixtures,'dsd-preparing');
  assert.equal(Object.hasOwn(before,'media'),false);
  for (const row of fixtureGroup(fixtures,'continuity-discovery')) {
    exerciseFixture(m,row);
    const after = fixtureJson<MobileResource>(row.response.body); assert.equal(after.state,'ready');
    assert.equal(m.resource.mobileResourceStableFactsMatch(before,after),true);
    assert.deepStrictEqual(after.sourceAudio,before.sourceAudio);
  }
  fixtureGroup(fixtures,'continuity-permission').forEach(row => exerciseFixture(m,row));
  fixtureGroup(fixtures,'renew-body').forEach(row => exerciseFixture(m,row));
  const row = fixtureCase(fixtures,'renew-empty-original'), empty = encode({});
  assert.equal(m.wire.decodeMobileRequest('renewResource',{method:'POST',path:row.request.path,headers:jsonHeaders(empty),query:[],body:empty},row.context).ok,false);
});

test('MBM003旧FLAC兼容：24bit192k16bit44k1及24bit44k1原三轴与旧无损mode保留',() => {
  const direct = fixtureGroup(fixtures,'lossless-valid'); assert.equal(direct.length,3);
  for (const row of [...direct,...fixtureGroup(fixtures,'lossless-old-modes')]) {
    exerciseFixture(m,row);
    const body = fixtureJson<MobileReadyResource>(row.response.body), req = row.context.resource!.request;
    assert.equal(req.quality.profile,'lossless'); assert.equal(req.quality.allowLossyFallback,false);
    assert.equal(req.acceptedProcessingModes,undefined); assert.equal(body.processing.fromPreparedCache,false);
    assert.notEqual(body.processing.mode,'dsd_to_pcm'); assert.equal(m.resource.isMobileDsdSourceAudio(body.sourceAudio),false);
    for (const axis of ['sampleRateHz','bitsPerSample','channels'] as const) { assert.notEqual(body.sourceAudio[axis],undefined); assert.equal(body.media.actualAudio[axis],body.sourceAudio[axis]); }
    assert.equal(m.resource.mobileDsdProcessingAllowed(body,row.context.resource!),true);
  }
  const specs = direct.map(row => {const b = fixtureJson<MobileReadyResource>(row.response.body); return [b.sourceAudio.bitsPerSample,b.sourceAudio.sampleRateHz];});
  assert.deepStrictEqual(specs,[[24,192000],[16,44100],[24,44100]]);
});

test('MBM003旧无损守卫：采样位深声道缺失或有损回退不因DSD声明放宽',() => {
  for (const group of ['lossless-drift','lossless-missing']) fixtureGroup(fixtures,group).forEach(row => exerciseFixture(m,row));
  const row = fixtureCase(fixtures,'flac-24-192000'), original = fixtureJson<MobileReadyResource>(row.response.body);
  for (const quality of [{profile:'auto' as const,allowLossyFallback:false,preferredTransport:'file' as const},{profile:'lossless' as const,allowLossyFallback:true,preferredTransport:'file' as const}]) {
    const request:MobileResourceRequest = {...row.context.resource!.request,quality,acceptedProcessingModes:['dsd_to_pcm']};
    assert.equal(m.resource.validateMobileCreateResourceReply(201,original,{...row.context.resource!,request,resourceDsdToPcm:true}).ok,false);
  }
  for (const mode of ['lossy_transcode','resample','dsd_to_pcm'] as const) {
    const changed = {...original,processing:{...original.processing,mode}};
    assert.equal(m.resource.validateMobileCreateResourceReply(201,changed,row.context.resource!).ok,false,mode);
  }
});

test('MBM003原202不可升级：UNKNOWN只查原命令且回执完整body和同key许可不丢',() => {
  const request = bodyJson<MobileResourceRequest>(fixtures,'dsd-base-request');
  const scope:MobileMutationScope = {serverId:context.scope.serverId,deviceId:context.scope.deviceId,accountDomain:null,sessionId:context.scope.sessionId,targetId:null,method:'POST',path:base.request.path};
  const fingerprint = sha256(new TextEncoder().encode(m.wire.mobileMutationFingerprintInput('createResource',scope,request as unknown as MobileJsonValue)));
  const incoming:MobileMutationIdentity = {operation:'createResource',scope,key:'key.synthetic.original-202.003',fingerprint};
  const preparing = bodyJson<MobileJsonValue>(fixtures,'dsd-preparing');
  const unknown:MobileMutationRecord = {identity:incoming,state:'UNKNOWN',originalReceipt:null};
  assert.deepStrictEqual(m.wire.classifyMobileMutationReplay(unknown,incoming),{kind:'ORIGINAL_RECORD_LOOKUP_ONLY'});
  const recorded:MobileMutationRecord = {...unknown,state:'RECORDED',originalReceipt:{status:202,body:preparing}};
  const replay = m.wire.classifyMobileMutationReplay(recorded,incoming);
  assert.equal(replay.kind,'RETURN_ORIGINAL_RECEIPT');
  assert.deepStrictEqual(replay,{kind:'RETURN_ORIGINAL_RECEIPT',receipt:safeClone(recorded.originalReceipt)});
  if (replay.kind === 'RETURN_ORIGINAL_RECEIPT') {
    assert.equal(replay.receipt.status,202); assert.equal(Object.getPrototypeOf(replay.receipt),null);
    assert.notEqual(replay.receipt,recorded.originalReceipt); assert.notEqual(replay.receipt.body,preparing);
    assert.deepStrictEqual(replay.receipt.body,safeClone(preparing));
  }
  assert.deepStrictEqual(preparing,bodyJson<MobileJsonValue>(fixtures,'dsd-preparing'));
  const get = fixtureCase(fixtures,'preparing-to-ready-getResource');
  assert.equal(m.wire.decodeMobileResponse('getResource',responseInput(get),get.context).ok,true);
  assert.deepStrictEqual(m.wire.classifyMobileMutationReplay(recorded,incoming),replay);
  const removed = bodyJson<MobileResourceRequest>(fixtures,'legacy-no-opt-in-request');
  const changed = sha256(new TextEncoder().encode(m.wire.mobileMutationFingerprintInput('createResource',scope,removed as unknown as MobileJsonValue)));
  assert.notEqual(changed,fingerprint);
  assert.deepStrictEqual(m.wire.classifyMobileMutationReplay(recorded,{...incoming,fingerprint:changed}),{kind:'CONFLICT'});
  // 原receipt读取与当前GET可同时成立；不把纯函数当服务端持久化或重新执行证明。
});
