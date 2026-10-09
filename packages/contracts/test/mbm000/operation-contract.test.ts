import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { CHECKOUT, bodyHeaders, encode, exerciseFixture, loadFreshMobileContracts, loadMobileFixtures, plain, readFixtureBody, readWholeFile, responseContext } from './fixture-helpers.js';

const m = await loadFreshMobileContracts('packages/contracts/test/mbm000/operation-contract.test.ts');
const fixtures = loadMobileFixtures();

test('移动40操作：原method/path闭集及各成功码完整消费whole body',() => {
  const lock = JSON.parse(readWholeFile(join(CHECKOUT,'docs/postrust/MBM-000/INPUT_LOCK.json')).bytes.toString('utf8')) as {operations:{operationId:keyof typeof m.wire.MOBILE_OPERATION_TABLE;method:string;path:string;successStatusCodes:string[]}[]};
  assert.equal(lock.operations.length,40); assert.deepEqual(Object.keys(m.wire.MOBILE_OPERATION_TABLE).sort(),lock.operations.map(op => op.operationId).sort());
  for (const op of lock.operations) {
    const entry = m.wire.MOBILE_OPERATION_TABLE[op.operationId]; assert.equal(entry.method,op.method); assert.equal(entry.path,op.path);
    const statuses = op.operationId === 'headMediaAsset' ? [200] : op.successStatusCodes.map(Number); assert.deepEqual(m.wire.mobileExpectedResponseStatuses(op.operationId),statuses);
    for (const status of statuses) { const rows = fixtures.cases.filter(row => row.operationId === op.operationId && row.response.status === status && row.expected.wireRequest && row.expected.wireResponse); assert(rows.length > 0,`${op.operationId}/${status} 缺原完整body`); rows.forEach(row => exerciseFixture(m,fixtures,row)); }
  }
  // 包含全部真实完整正／负 HTTP fixture，不能只消费成功投影。
  fixtures.cases.forEach(row => exerciseFixture(m,fixtures,row));
});
test('移动40操作：每条原default错误保留安全嵌套/HEAD零实体',() => {
  for (const operation of Object.keys(m.wire.MOBILE_OPERATION_TABLE)) { const rows = fixtures.cases.filter(row => row.operationId === operation && row.response.status >= 400 && row.expected.wireResponse); assert(rows.length > 0,`${operation} 缺default whole reply`); rows.forEach(row => exerciseFixture(m,fixtures,row)); }
});
test('移动路由：错误方法、41st命令及Roon控制不能进入本域',() => {
  assert.equal(m.wire.resolveMobileOperation('POST',['mobile','v1','tracks','track.1']).ok,false);
  assert.equal(m.wire.resolveMobileOperation('GET',['mobile','v1','commands','command.1']).ok,false);
  assert.equal(m.wire.resolveMobileOperation('POST',['mobile','v1','roon','pause']).ok,false);
  for (const path of [['mobile','v1','tracks','..'],['mobile','v1','tracks','x/y'],['mobile','v1','tracks','x%2Fy']]) assert.equal(m.wire.resolveMobileOperation('GET',path).ok,false);
});
test('移动公共版本：HTTP真实入口只收base0.1且UI仍1.0',() => {
  for (const operation of ['getServer','getCapabilities'] as const) {
    const row = fixtures.cases.find(row => row.operationId === operation && row.response.status === 200 && row.expected.wireResponse)!; assert(row);
    const body = JSON.parse(new TextDecoder().decode(readFixtureBody(row.response.body))) as Record<string,unknown>;
    for (const version of ['1.0.0','1.6.0','0.2.0']) { body.contractVersion = version; const bytes = encode(body); assert.equal(m.wire.decodeMobileResponse(operation,{status:200,headers:bodyHeaders(row.response.headers,bytes),body:bytes,finalUrl:row.response.finalUrl},responseContext(fixtures,row)).ok,false); }
    body.contractVersion = '0.1.0'; const bytes = encode(body); assert.equal(m.wire.decodeMobileResponse(operation,{status:200,headers:bodyHeaders(row.response.headers,bytes),body:bytes,finalUrl:row.response.finalUrl},responseContext(fixtures,row)).ok,true);
  }
});
test('移动HTTP：204非空、重复关键头、错误来源及非合同2xx拒绝',() => {
  const empty = fixtures.cases.find(row => row.response.status === 204 && row.expected.wireResponse)!; assert(empty);
  assert.equal(m.wire.decodeMobileResponse(empty.operationId,{status:204,headers:empty.response.headers,body:encode({}),finalUrl:empty.response.finalUrl},responseContext(fixtures,empty)).ok,false);
  const row = fixtures.cases.find(row => row.operationId === 'getServer' && row.response.status === 200)!; assert(row);
  for (const headers of [[...row.response.headers,['content-type','application/json'] as [string,string]]]) assert.equal(m.wire.decodeMobileResponse(row.operationId,{status:200,headers,body:readFixtureBody(row.response.body),finalUrl:row.response.finalUrl},responseContext(fixtures,row)).ok,false);
  assert.equal(m.wire.decodeMobileResponse(row.operationId,{status:200,headers:row.response.headers,body:readFixtureBody(row.response.body),finalUrl:'https://other.invalid/mobile/v1/server'},responseContext(fixtures,row)).ok,false);
  assert.equal(m.wire.decodeMobileResponse(row.operationId,{status:201,headers:row.response.headers,body:readFixtureBody(row.response.body),finalUrl:row.response.finalUrl},responseContext(fixtures,row)).ok,false);
});
test('移动原始JSON：重复键、尾随值、坏UTF8及孤立代理均拒绝',() => {
  for (const text of ['{"x":1,"x":2}','{"x":1,"\\u0078":2}','{} true','{"x":"\\ud800"}','[1,]','01','9007199254740993']) assert.equal(m.common.parseMobileJson(new TextEncoder().encode(text)).ok,false,text);
  assert.equal(m.common.parseMobileJson(new Uint8Array([0xc0,0xaf])).ok,false);
  assert.equal(m.common.parseMobileJson(new TextEncoder().encode('{"x":"😀","y":null}')).ok,true);
});
test('移动snapshot：getter不调用、Symbol/洞/循环/undefined拒绝',() => {
  let calls = 0; const getter = Object.defineProperty({},'x',{enumerable:true,get:() => {calls++;return 1;}});
  assert.equal(m.common.mobileDataSnapshot(getter).ok,false); assert.equal(calls,0);
  const cycle:Record<string,unknown> = {}; cycle.x = cycle;
  for (const raw of [{x:undefined},{[Symbol('x')]:1},new Array(1),cycle,{toJSON:() => ({})},Object.create({x:1}),NaN,Infinity]) assert.equal(m.common.mobileDataSnapshot(raw).ok,false);
});
test('移动出站白名单及实际扩展预算：有界入站保留而不反射',() => {
  const row = fixtures.cases.find(row => row.operationId === 'getServer' && row.response.status === 200 && row.expected.wireResponse)!;
  const raw = JSON.parse(new TextDecoder().decode(readFixtureBody(row.response.body))) as Record<string,unknown>; raw.future = {rawStack:'synthetic-private-value'};
  const bytes = encode(raw); const result = m.wire.decodeMobileResponse('getServer',{status:200,headers:bodyHeaders(row.response.headers,bytes),body:bytes,finalUrl:row.response.finalUrl},responseContext(fixtures,row)); assert(result.ok);
  const outgoing = m.wire.encodeMobileJsonReply('getServer',result.value,responseContext(fixtures,row)); assert(outgoing.ok); assert.equal(Object.hasOwn(JSON.parse(new TextDecoder().decode(outgoing.value.body)),'future'),false);
  const extensionBytes = new TextEncoder().encode('"future":'+JSON.stringify(raw.future)).length;
  for (const delta of [-1,0,1]) assert.equal(m.common.mobileCommonResponseSnapshot('serverInfo',plain(raw),{...m.common.MOBILE_CODEC_LIMITS,extensionBytes:extensionBytes+delta}).ok,delta >= 0);
  for (const key of ['depth','nodes','extensionBytes','requestBytes','responseBytes'] as const) assert.equal(m.common.mobileDataSnapshot({}, {...m.common.MOBILE_CODEC_LIMITS,[key]:m.common.MOBILE_CODEC_LIMITS[key]+1}).ok,false);
});
test('移动opaque身份：真实HTTP正文拒绝LF/CR/NUL/LS及路径编码绕过',() => {
  const row = fixtures.cases.find(item => item.id === 'getServer--success-200')!; assert(row);
  const body = JSON.parse(new TextDecoder().decode(readFixtureBody(row.response.body))) as Record<string,unknown>;
  for (const suffix of ['\n','\r','\u0000','\u2028']) {
    const bytes = encode({...body,serverId:`server.fixture.1${suffix}`});
    assert.equal(m.wire.decodeMobileResponse('getServer',{status:200,headers:bodyHeaders(row.response.headers,bytes),body:bytes,finalUrl:row.response.finalUrl},responseContext(fixtures,row)).ok,false);
    assert.equal(m.wire.resolveMobileOperation('GET',['mobile','v1','tracks',`local:track.1${suffix}`]).ok,false);
  }
});
test('移动D8：既有同意图七项有限取回与UNKNOWN只查原记录明确分开',() => {
  interface Recovery {operationId:keyof typeof m.wire.MOBILE_OPERATION_TABLE;method:string;maximumAdditionalAttemptsPerCall:number;trigger:string[];sameOriginalPath:boolean;sameOriginalBody:boolean;sameOriginalIdempotencyKey:boolean;keyRequired:boolean;newKeyAllowed:boolean;newBodyAllowed:boolean;newIntentAllowed:boolean;responseStatusReplay:boolean;redirectReplay:boolean}
  interface Policy {automaticNewIntentReplay:string;boundedOriginalIntentRecovery:Recovery[];noLostReplyReplayOperationIds:string[];pendingRefreshIntentPreserved:boolean;newQueryOperation:boolean;reSignOrNewKeyOnUnknownOutcome:boolean;preparingOriginalReceiptRemains202:boolean;definitiveUnauthorizedRecovery:{status:number;maximumOriginalRequestRetry:number;existingSingleFlightRefreshPreserved:boolean;sameBusinessKeyAndBody:boolean;notAnUnknownWriteOutcome:boolean}}
  const canonical = JSON.parse(readWholeFile(join(CHECKOUT,'packages/contracts/mobile/openapi.json')).bytes.toString('utf8')) as {'x-musicbridge-adoption':{unknownCommandOutcome:Policy}};
  const p = canonical['x-musicbridge-adoption'].unknownCommandOutcome;
  assert.deepEqual(p.boundedOriginalIntentRecovery.map(row => row.operationId),['claimPairing','refreshToken','createSession','createResource','renewResource','closeSession','releaseResource']);
  for (const row of p.boundedOriginalIntentRecovery) {
    assert.equal(row.method,m.wire.MOBILE_OPERATION_TABLE[row.operationId].method); assert.equal(row.maximumAdditionalAttemptsPerCall,1); assert.deepEqual(row.trigger,['timedOut','interrupted']);
    for (const key of ['sameOriginalPath','sameOriginalBody'] as const) assert.equal(row[key],true);
    for (const key of ['newKeyAllowed','newBodyAllowed','newIntentAllowed','responseStatusReplay','redirectReplay'] as const) assert.equal(row[key],false);
    assert.equal(row.keyRequired,row.method === 'POST'); assert.equal(row.sameOriginalIdempotencyKey,row.method === 'POST');
  }
  assert.deepEqual(p.noLostReplyReplayOperationIds,['logout','reportObservation','setAlbumFavorite','setTrackFavorite','createPersonalPlaylist','addPersonalPlaylistTrack']);
  assert.equal(p.automaticNewIntentReplay,'NONE'); assert.equal(p.newQueryOperation,false); assert.equal(p.reSignOrNewKeyOnUnknownOutcome,false); assert.equal(p.pendingRefreshIntentPreserved,true); assert.equal(p.preparingOriginalReceiptRemains202,true);
  assert.deepEqual(p.definitiveUnauthorizedRecovery,{status:401,existingSingleFlightRefreshPreserved:true,maximumOriginalRequestRetry:1,sameBusinessKeyAndBody:true,notAnUnknownWriteOutcome:true});
  assert.deepEqual(fixtures.unknownCommandPolicy,p);
});
