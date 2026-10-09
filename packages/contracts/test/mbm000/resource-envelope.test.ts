import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyHeaders, encode, exerciseFixture, fixtureJson, loadFreshMobileContracts, loadMobileFixtures, plain, readFixtureBody, requestContext, responseContext, sha256 } from './fixture-helpers.js';
import type { MobileResourceCodecContext, MobileCodecLimits, MobileJsonValue } from '../../src/mobile-common.js';
import type { MobileResourceRequest, MobilePreparingResource } from '../../src/mobile-resource.js';
import type { MobileMutationIdentity, MobileMutationRecord, MobileMutationScope } from '../../src/mobile-wire.js';

const m = await loadFreshMobileContracts('packages/contracts/test/mbm000/resource-envelope.test.ts');
const fixtures = loadMobileFixtures();
const row = fixtures.cases.find(item => item.id === 'createResource--success-201')!; assert(row);
const request = fixtureJson<MobileResourceRequest>(row.request.body!);
const context = requestContext(fixtures,row).resourceCapabilities!;

test('移动资源whole envelope：原位深/能力/重试提示各完整HTTP分支',() => {
  const rows = fixtures.cases.filter(item => ['createResource','getResource','renewResource','getUIContentCapabilities'].includes(item.operationId)); assert(rows.length >= 30); rows.forEach(item => exerciseFixture(m,fixtures,item));
  const raw = fixtureJson<Record<string,unknown>>(row.response.body); raw.future = '可见扩展'; const bytes = encode(raw), budget = new TextEncoder().encode('"future":'+JSON.stringify(raw.future)).length;
  for (const delta of [-1,0,1]) assert.equal(m.wire.decodeMobileResponse('createResource',{status:201,headers:bodyHeaders(row.response.headers,bytes),body:bytes,finalUrl:row.response.finalUrl},{...responseContext(fixtures,row),limits:{...m.common.MOBILE_CODEC_LIMITS,extensionBytes:budget+delta}}).ok,delta >= 0);
});
test('移动资源闭键：五键正文/quality/format不能携带源路径或私有能力',() => {
  assert.deepEqual(Object.keys(request).sort(),['contentRevision','formats','quality','trackId','versionId']); assert.equal(m.resource.mobileResourceRequestSnapshot(request,context).ok,true);
  for (const key of ['source','commandId','path','fd','actor','grant','scanBefore','targetRootId']) assert.equal(m.resource.mobileResourceRequestSnapshot({...request,[key]:'synthetic-private'},context).ok,false,key);
  assert.equal(m.resource.mobileResourceRequestSnapshot({...request,quality:{...request.quality,confirmed:true}},context).ok,false);
  assert.equal(m.resource.mobileResourceRequestSnapshot({...request,formats:[{...request.formats[0]!,targetRootId:'root.1'}]},context).ok,false);
  let invoked = 0; const getter = Object.defineProperty({...request},'trackId',{enumerable:true,get:() => {invoked++;return request.trackId;}});
  assert.equal(m.resource.mobileResourceRequestSnapshot(getter,context).ok,false); assert.equal(invoked,0);
});
test('移动资源位深：完整base可与captrue兼容，扩展仅可信true且1至64',() => {
  const enabled:MobileResourceCodecContext = {...context,resourceFormatBitDepth:true,capabilityVersion:'1.0.0'};
  assert.equal(m.resource.mobileResourceRequestSnapshot(request,enabled).ok,true);
  for (const bits of [1,24,64]) { const body = {...request,formats:[{...request.formats[0]!,maxBitsPerSample:bits}]}; assert.equal(m.resource.mobileResourceRequestSnapshot(body,enabled).ok,true); assert.equal(m.resource.mobileResourceRequestSnapshot(body,context).ok,false); }
  for (const bits of [null,false,0,65,1.5]) assert.equal(m.resource.mobileResourceRequestSnapshot({...request,formats:[{...request.formats[0]!,maxBitsPerSample:bits}]},enabled).ok,false);
  for (const trusted of [null,undefined,1,'true']) assert.equal(m.resource.mobileResourceRequestSnapshot(request,{...context,resourceFormatBitDepth:trusted} as unknown as MobileResourceCodecContext).ok,false);
  assert.equal(m.resource.mobileResourceRequestSnapshot(request,{...enabled,capabilityVersion:'base'}).ok,false);
  for (const [field,good,bad] of [['maxSampleRateHz',8000,7999],['maxSampleRateHz',768000,768001],['maxChannels',32,33]] as const) { assert.equal(m.resource.mobileResourceRequestSnapshot({...request,formats:[{...request.formats[0]!,[field]:good}]},context).ok,true); assert.equal(m.resource.mobileResourceRequestSnapshot({...request,formats:[{...request.formats[0]!,[field]:bad}]},context).ok,false); }
  assert.equal(m.resource.mobileResourceRequestSnapshot({...request,formats:Array.from({length:20},() => plain(request.formats[0]!))},context).ok,true);
  assert.equal(m.resource.mobileResourceRequestSnapshot({...request,formats:Array.from({length:21},() => plain(request.formats[0]!))},context).ok,false);
});
test('移动原请求预算：262144原始UTF8字节B减一/B/B加一不靠重编码缩短',() => {
  const original = readFixtureBody(row.request.body!); const cap = m.common.MOBILE_JSON_REQUEST_MAX_BYTES;
  for (const size of [cap-1,cap,cap+1]) { const bytes = new Uint8Array(size); bytes.set(original); bytes.fill(0x20,original.length); const result = m.wire.decodeMobileRequest('createResource',{method:row.method,path:row.path,headers:bodyHeaders(row.request.headers,bytes),query:row.request.query,body:bytes},requestContext(fixtures,row)); assert.equal(result.ok,size <= cap); if (!result.ok) assert.equal(result.issue.code,'LIMIT_EXCEEDED'); }
  const noncanonical = new TextEncoder().encode(new TextDecoder().decode(original).replace('local:track.1','local:\\u0074rack.1'));
  assert.equal(m.wire.decodeMobileRequest('createResource',{method:row.method,path:row.path,headers:bodyHeaders(row.request.headers,noncanonical),query:row.request.query,body:noncanonical},requestContext(fixtures,row)).ok,true);
});
test('移动原响应预算：2097152完整raw正文B边界及独立depth/nodes仍拒越界',() => {
  const server = fixtures.cases.find(item => item.id === 'getServer--success-200')!; const original = readFixtureBody(server.response.body), cap = m.common.MOBILE_API_RESPONSE_MAX_BYTES;
  for (const size of [cap-1,cap,cap+1]) { const bytes = new Uint8Array(size); bytes.set(original); bytes.fill(0x20,original.length); const result = m.wire.decodeMobileResponse('getServer',{status:200,headers:bodyHeaders(server.response.headers,bytes),body:bytes,finalUrl:server.response.finalUrl},responseContext(fixtures,server)); assert.equal(result.ok,size <= cap); }
  let nested:MobileJsonValue = null; for (let i=0;i<65;i++) nested = [nested]; assert.equal(m.common.mobileDataSnapshot(nested).ok,false);
  assert.equal(m.common.parseMobileJson(encode([1,2]),{...m.common.MOBILE_CODEC_LIMITS,nodes:2}).ok,false);
  assert.equal(m.common.parseMobileJson(encode([1,2]),{...m.common.MOBILE_CODEC_LIMITS,nodes:3}).ok,true);
});
test('移动编码预算：只按实际正文收费而不把私有wrapper计入B',() => {
  const decoded = m.wire.decodeMobileRequest('createResource',{method:row.method,path:row.path,headers:row.request.headers,query:row.request.query,body:readFixtureBody(row.request.body)},requestContext(fixtures,row)); assert(decoded.ok);
  const bytes = new TextEncoder().encode(m.common.mobileCanonicalJson(decoded.value.body as unknown as MobileJsonValue));
  const limits:MobileCodecLimits = {...m.common.MOBILE_CODEC_LIMITS,requestBytes:bytes.byteLength};
  const encoded = m.wire.encodeMobileRequest('createResource',decoded.value,{...requestContext(fixtures,row),limits}); assert(encoded.ok); assert.equal(encoded.value.body.byteLength,bytes.byteLength);
  assert.equal(m.wire.encodeMobileRequest('createResource',decoded.value,{...requestContext(fixtures,row),limits:{...limits,requestBytes:bytes.byteLength-1}}).ok,false);
  const server = fixtures.cases.find(item => item.id === 'getServer--success-200')!;
  const reply = m.wire.decodeMobileResponse('getServer',{status:200,headers:server.response.headers,body:readFixtureBody(server.response.body),finalUrl:server.response.finalUrl},responseContext(fixtures,server)); assert(reply.ok);
  const responseBytes = new TextEncoder().encode(m.common.mobileCanonicalJson(reply.value.body as unknown as MobileJsonValue)).length;
  const outgoing = m.wire.encodeMobileJsonReply('getServer',reply.value,{...responseContext(fixtures,server),limits:{...m.common.MOBILE_CODEC_LIMITS,responseBytes}}); assert(outgoing.ok); assert.equal(outgoing.value.body.length,responseBytes);
});
test('移动提示上界：大于24h仍可消费，safe normalizer钳制但不重放',() => {
  const prep = fixtures.cases.find(item => item.id === 'createResource--success-202')!; const body = fixtureJson<MobilePreparingResource>(prep.response.body);
  for (const delay of [0,86_400_000,86_400_001]) { const changed = {...body,retryAfterMs:delay}; const bytes = encode(changed); const accepted = m.wire.decodeMobileResponse('createResource',{status:202,headers:bodyHeaders(prep.response.headers,bytes),body:bytes,finalUrl:prep.response.finalUrl},responseContext(fixtures,prep)); assert(accepted.ok); assert.equal((accepted.value.body as MobilePreparingResource).retryAfterMs,delay); assert.equal(m.common.normalizeMobileRetryHint(delay),Math.min(delay,86_400_000)); }
  for (const raw of [null,false,-1,1.5,Infinity]) assert.equal(m.common.normalizeMobileRetryHint(raw),null);
});
test('移动UNKNOWN：同key/body只查原receipt，原202不会变201或新意图',() => {
  const scope:MobileMutationScope = {serverId:'server.fixture.1',deviceId:'device.fixture.1',accountDomain:null,sessionId:'session.fixture.1',targetId:null,method:'POST',path:row.path};
  const input = m.wire.mobileMutationFingerprintInput('createResource',scope,request as unknown as MobileJsonValue);
  const incoming:MobileMutationIdentity = {operation:'createResource',scope,key:'key.fixture.1',fingerprint:sha256(new TextEncoder().encode(input))};
  const prep = fixtures.cases.find(item => item.id === 'createResource--success-202')!; const body = fixtureJson<MobileJsonValue>(prep.response.body);
  const unknown:MobileMutationRecord = {identity:incoming,state:'UNKNOWN',originalReceipt:null};
  assert.deepEqual(m.wire.classifyMobileMutationReplay(unknown,incoming),{kind:'ORIGINAL_RECORD_LOOKUP_ONLY'});
  const recorded:MobileMutationRecord = {...unknown,state:'RECORDED',originalReceipt:{status:202,body}};
  // 独立复制完整fixture，只统一安全数据原型；不投影字段、不重新编码正文。
  const expectedClone = (value:MobileJsonValue):MobileJsonValue => {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(expectedClone);
    const copy = Object.create(null) as {[key:string]:MobileJsonValue};
    for (const [key,child] of Object.entries(value)) copy[key] = expectedClone(child);
    return copy;
  };
  const expectedReceipt = Object.assign(Object.create(null) as {status:number;body:MobileJsonValue},{status:202,body:expectedClone(body)});
  const recovered = m.wire.classifyMobileMutationReplay(recorded,incoming);
  assert.equal(recovered.kind,'RETURN_ORIGINAL_RECEIPT');
  if (recovered.kind === 'RETURN_ORIGINAL_RECEIPT') { assert.equal(Object.getPrototypeOf(recovered.receipt),null); assert.notEqual(recovered.receipt,recorded.originalReceipt); assert.notEqual(recovered.receipt.body,body); }
  assert.deepStrictEqual(recovered,{kind:'RETURN_ORIGINAL_RECEIPT',receipt:expectedReceipt});
  assert.deepStrictEqual(body,fixtureJson<MobileJsonValue>(prep.response.body));
  for (const changed of [{...incoming,key:'new.key'},{...incoming,fingerprint:'different-body'},{...incoming,scope:{...scope,deviceId:'another.device'}},{...incoming,scope:{...scope,path:'/mobile/v1/sessions/other/resources'}}]) assert.deepEqual(m.wire.classifyMobileMutationReplay(unknown,changed),{kind:'CONFLICT'});
  assert.deepEqual(m.wire.classifyMobileMutationReplay(null,incoming),{kind:'NEW'});
  assert.deepEqual(m.wire.classifyMobileMutationReplay(null,{...incoming,scope:{...scope,method:'GET'}}),{kind:'CONFLICT'});
  assert.equal(input,m.wire.mobileMutationFingerprintInput('createResource',scope,{formats:request.formats,quality:request.quality,trackId:request.trackId,contentRevision:request.contentRevision,versionId:request.versionId} as unknown as MobileJsonValue));
});
