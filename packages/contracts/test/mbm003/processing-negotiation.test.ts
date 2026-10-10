import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyJson, encode, exerciseFixture, fixtureCase, fixtureGroup, jsonHeaders, loadDsdFixtures, loadFreshMobileContracts, plain, requestInput, sha256 } from './fixture-helpers.js';
import type { MobileJsonValue, MobileResourceCodecContext } from '../../src/mobile-common.js';
import type { MobileResourceRequest } from '../../src/mobile-resource.js';
import type { MobileMutationIdentity, MobileMutationScope } from '../../src/mobile-wire.js';

const m = await loadFreshMobileContracts('packages/contracts/test/mbm003/processing-negotiation.test.ts');
const fixtures = loadDsdFixtures();
const base = fixtureCase(fixtures,'base-opt-in');
const request = bodyJson<MobileResourceRequest>(fixtures,'dsd-base-request');
const context = base.context.resource!;

test('MBM003处理闭集：旧五mode保持可消费且未知mode不得入站',() => {
  for (const mode of ['direct','remux','lossless_conversion','lossy_transcode','resample','dsd_to_pcm']) {
    const raw = bodyJson<unknown>(fixtures,'processing-'+mode);
    const decoded = m.common.mobileCommonResponseSnapshot('processing',raw);
    assert(decoded.ok,mode); assert.equal(decoded.value.mode,mode);
  }
  for (const name of ['null','unknown','case','empty']) assert.equal(m.common.mobileCommonResponseSnapshot('processing',bodyJson<unknown>(fixtures,'processing-invalid-'+name)).ok,false,name);
});

test('MBM003请求分支：base与位深扩展均绑定显式mode且不混入私有字段',() => {
  fixtureGroup(fixtures,'request-branches').forEach(row => exerciseFixture(m,row));
  const baseReply = m.wire.decodeMobileRequest('createResource',requestInput(base),base.context);
  assert(baseReply.ok); assert.deepStrictEqual(Object.keys(baseReply.value.body).sort(),['acceptedProcessingModes','contentRevision','formats','quality','trackId','versionId']);
  assert.deepStrictEqual(baseReply.value.body.acceptedProcessingModes,['dsd_to_pcm']);
  assert.equal(Object.hasOwn(baseReply.value.body.formats[0]!,'maxBitsPerSample'),false);
  const withBits = fixtureCase(fixtures,'bitdepth-opt-in');
  const bitReply = m.wire.decodeMobileRequest('createResource',requestInput(withBits),withBits.context);
  assert(bitReply.ok); assert.equal(bitReply.value.body.formats[0]!.maxBitsPerSample,24);
});

test('MBM003显式采纳闭键：null空未知重复和路径grant均拒绝且getter不执行',() => {
  fixtureGroup(fixtures,'opt-in-invalid').forEach(row => exerciseFixture(m,row));
  fixtureGroup(fixtures,'request-closed').forEach(row => exerciseFixture(m,row));
  let called = 0;
  const getter = Object.defineProperty(plain(request),'acceptedProcessingModes',{enumerable:true,get:() => { called++; return ['dsd_to_pcm']; }});
  assert.equal(m.resource.mobileResourceRequestSnapshot(getter,context).ok,false);
  assert.equal(called,0);
});

test('MBM003能力独立：bitdepth false加DSD true接受固定24bit且不可伪造能力类型',() => {
  const basis = {capabilitySnapshotIdentity:context.capabilitySnapshotIdentity,responseOrigin:context.responseOrigin,now:context.now};
  const independent = m.content.mobileResourceContextFromCapabilities(context.scope,bodyJson<unknown>(fixtures,'ui-independent-cap'),basis);
  assert(independent.ok); assert.equal(independent.value.resourceFormatBitDepth,false); assert.equal(independent.value.resourceDsdToPcm,true);
  assert.equal(m.resource.mobileResourceRequestSnapshot(request,independent.value).ok,true);
  assert.equal(m.resource.validateMobileCreateResourceReply(201,bodyJson<unknown>(fixtures,'dsd-ready'),{...context,...independent.value}).ok,true);
  for (const name of ['absent','false']) {
    const caps = m.content.mobileResourceContextFromCapabilities(context.scope,bodyJson<unknown>(fixtures,'ui-dsd-cap-'+name),basis);
    assert(caps.ok); assert.equal(caps.value.resourceDsdToPcm,false);
  }
  for (const name of ['null','number','string']) assert.equal(m.content.mobileResourceContextFromCapabilities(context.scope,bodyJson<unknown>(fixtures,'ui-dsd-cap-'+name),basis).ok,false,name);
  fixtureGroup(fixtures,'context-invalid').forEach(row => exerciseFixture(m,row));
  const untrusted = {...context,resourceFormatBitDepth:false,resourceDsdToPcm:true,capabilityVersion:'base'} as MobileResourceCodecContext;
  assert.equal(m.resource.mobileResourceRequestSnapshot(request,untrusted).ok,false);
});

test('MBM003旧consumer围栏：缺cap或opt-in三态全拒且仅消费原409安全错误',() => {
  const denied = fixtureGroup(fixtures,'permission-missing');
  assert.equal(denied.length,9); denied.forEach(row => exerciseFixture(m,row));
  fixtureGroup(fixtures,'all-states').forEach(row => exerciseFixture(m,row));
  fixtureGroup(fixtures,'source-scope').forEach(row => exerciseFixture(m,row));
  const oldRequest = bodyJson<MobileResourceRequest>(fixtures,'legacy-no-opt-in-request');
  const legacyContext = {...context,request:oldRequest,resourceDsdToPcm:false};
  assert.equal(m.resource.mobileResourceRequestSnapshot(oldRequest,legacyContext).ok,true);
  const errorBytes = encode(bodyJson<unknown>(fixtures,'legacy-unsupported-error'));
  const safe = m.wire.decodeMobileResponse('createResource',{status:409,headers:jsonHeaders(errorBytes),body:errorBytes,finalUrl:base.response.finalUrl},{...base.context,resource:legacyContext,resourceCapabilities:legacyContext});
  assert(safe.ok); assert.equal(safe.value.category,'error');
  assert.equal((safe.value.body as {error:{code:string}}).error.code,'UNSUPPORTED_FORMAT');
  // 此处只证明旧consumer的HTTP兼容围栏，不冒充转换器调用数或真机验证。
});

test('MBM003目标组合：低采样声道显式位深及缺轴在全部资源态都拒绝',() => {
  const rows = fixtureGroup(fixtures,'format-invalid'); assert.equal(rows.length,15);
  rows.forEach(row => { exerciseFixture(m,row); assert.equal(m.resource.mobileResourceRequestSnapshot(row.context.resource!.request,row.context.resource!).ok,true,row.id); });
  fixtureGroup(fixtures,'format-missing').forEach(row => exerciseFixture(m,row));
  // 显式24/64位上限都能包住固定24位；base格式不隐式扩出位深字段。
  for (const bits of [24,64]) {
    const requested = {...request,formats:[{...request.formats[0]!,maxBitsPerSample:bits}]};
    const enabled = {...context,request:requested,resourceFormatBitDepth:true};
    assert.equal(m.resource.validateMobileCreateResourceReply(201,bodyJson<unknown>(fixtures,'dsd-ready'),enabled).ok,true);
    assert.equal(m.resource.mobileResourceRequestSnapshot(requested,{...enabled,resourceFormatBitDepth:false}).ok,false);
  }
});

test('MBM003质量许可：只有auto无有损回退及file可进入DSD新mode',() => {
  const rows = fixtureGroup(fixtures,'quality-invalid'); assert.equal(rows.length,18);
  rows.forEach(row => exerciseFixture(m,row));
  assert.equal(m.resource.mobileResourceRequestSnapshot(request,context).ok,true);
  assert.deepStrictEqual(request.quality,{profile:'auto',allowLossyFallback:false,preferredTransport:'file'});
});

test('MBM003原raw预算：显式mode不改变请求256KiB与响应2MiB边界',() => {
  const requestBytes = requestInput(base).body, replyBytes = encode(bodyJson<unknown>(fixtures,'dsd-ready'));
  for (const delta of [-1,0,1]) {
    const size = m.common.MOBILE_JSON_REQUEST_MAX_BYTES + delta, raw = new Uint8Array(size);
    raw.set(requestBytes); raw.fill(0x20,requestBytes.byteLength);
    const decoded = m.wire.decodeMobileRequest('createResource',{...requestInput(base),headers:[...jsonHeaders(raw),['Idempotency-Key','key.synthetic.budget.003']],body:raw},base.context);
    assert.equal(decoded.ok,delta <= 0); if (!decoded.ok) assert.equal(decoded.issue.code,'LIMIT_EXCEEDED');
  }
  for (const delta of [-1,0,1]) {
    const size = m.common.MOBILE_API_RESPONSE_MAX_BYTES + delta, raw = new Uint8Array(size);
    raw.set(replyBytes); raw.fill(0x20,replyBytes.byteLength);
    const decoded = m.wire.decodeMobileResponse('createResource',{status:201,headers:jsonHeaders(raw),body:raw,finalUrl:base.response.finalUrl},base.context);
    assert.equal(decoded.ok,delta <= 0); if (!decoded.ok) assert.equal(decoded.issue.code,'LIMIT_EXCEEDED');
  }
});

test('MBM003原幂等正文：mode采纳参与fingerprint且改许可或跨设备不得复用',() => {
  const scope:MobileMutationScope = {serverId:context.scope.serverId,deviceId:context.scope.deviceId,accountDomain:null,sessionId:context.scope.sessionId,targetId:null,method:'POST',path:base.request.path};
  const fingerprint = (body:MobileResourceRequest) => sha256(new TextEncoder().encode(m.wire.mobileMutationFingerprintInput('createResource',scope,body as unknown as MobileJsonValue)));
  const incoming:MobileMutationIdentity = {operation:'createResource',scope,key:'key.synthetic.same-intent.003',fingerprint:fingerprint(request)};
  const record = {identity:incoming,state:'UNKNOWN' as const,originalReceipt:null};
  assert.deepStrictEqual(m.wire.classifyMobileMutationReplay(record,incoming),{kind:'ORIGINAL_RECORD_LOOKUP_ONLY'});
  const oldRequest = bodyJson<MobileResourceRequest>(fixtures,'legacy-no-opt-in-request');
  assert.notEqual(fingerprint(oldRequest),incoming.fingerprint);
  for (const changed of [{...incoming,fingerprint:fingerprint(oldRequest)},{...incoming,key:'key.synthetic.new-intent.003'},{...incoming,scope:{...scope,deviceId:'device.synthetic.other'}}]) assert.deepStrictEqual(m.wire.classifyMobileMutationReplay(record,changed),{kind:'CONFLICT'});
  assert(request.acceptedProcessingModes);
  const reordered = {formats:request.formats,acceptedProcessingModes:request.acceptedProcessingModes,quality:request.quality,trackId:request.trackId,contentRevision:request.contentRevision,versionId:request.versionId};
  assert.equal(fingerprint(reordered),incoming.fingerprint);
});
