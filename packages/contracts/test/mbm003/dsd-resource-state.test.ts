import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyJson, encode, exerciseFixture, fixtureCase, fixtureGroup, fixtureJson, jsonHeaders, loadDsdFixtures, loadFreshMobileContracts, plain, responseInput } from './fixture-helpers.js';
import type { MobileReadyResource, MobileResource } from '../../src/mobile-resource.js';

const m = await loadFreshMobileContracts('packages/contracts/test/mbm003/dsd-resource-state.test.ts');
const fixtures = loadDsdFixtures();
const base = fixtureCase(fixtures,'base-opt-in');
const context = base.context.resource!;

test('MBM003真实规格闭集：八MHz时钟两容器六声道完整HTTP源产物分离',() => {
  const rows = fixtureGroup(fixtures,'source-valid'); assert.equal(rows.length,96);
  const clocks = new Set<number>(), containers = new Set<string>(), channels = new Set<number>();
  for (const row of rows) {
    exerciseFixture(m,row);
    const body = fixtureJson<MobileReadyResource>(row.response.body);
    assert.equal(m.resource.isMobileDsdSourceAudio(body.sourceAudio),true,row.id);
    assert.equal(body.sourceAudio.bitsPerSample,1); assert.equal(body.media.actualAudio.sampleRateHz,48000);
    assert.equal(body.media.actualAudio.bitsPerSample,24); assert.equal(body.media.actualAudio.channels,body.sourceAudio.channels);
    clocks.add(body.sourceAudio.sampleRateHz!); containers.add(body.sourceAudio.container); channels.add(body.sourceAudio.channels!);
  }
  assert.deepStrictEqual([...clocks].sort((a,b) => a-b),[2822400,3072000,5644800,6144000,11289600,12288000,22579200,24576000]);
  assert.deepStrictEqual([...containers].sort(),['dff','dsf']); assert.deepStrictEqual([...channels].sort((a,b) => a-b),[1,2,3,4,5,6]);
  // 全部音频事实为独立合成codec输入；没有把MHz数值当真实FD或转换器产物证明。
});

test('MBM003源事实拒绝：PCM率别名DST未知时钟缺轴或七声道不冒充DSD',() => {
  for (const group of ['source-invalid','source-missing']) for (const row of fixtureGroup(fixtures,group)) {
    exerciseFixture(m,row);
    assert.equal(m.resource.isMobileDsdSourceAudio(fixtureJson<MobileResource>(row.response.body).sourceAudio),false,row.id);
  }
  const source = bodyJson<MobileReadyResource>(fixtures,'dsd-ready').sourceAudio;
  let called = 0;
  const getter = Object.defineProperty(plain(source),'sampleRateHz',{enumerable:true,get:() => {called++; return 2822400;}});
  assert.equal(m.resource.isMobileDsdSourceAudio(getter),false); assert.equal(called,0);
});

test('MBM003实际产物拒绝：FLAC固定48k24bit同声道且三轴必须齐全',() => {
  for (const group of ['actual-invalid','actual-missing']) for (const row of fixtureGroup(fixtures,group)) {
    exerciseFixture(m,row);
    assert.equal(m.resource.mobileDsdProcessingAllowed(fixtureJson<MobileResource>(row.response.body),row.context.resource!),false,row.id);
  }
  const accepted = m.wire.decodeMobileResponse('createResource',responseInput(base),base.context);
  assert(accepted.ok); assert.equal(accepted.value.category,'success');
  const resource = accepted.value.body as MobileReadyResource;
  assert.deepStrictEqual(Object.keys(resource.media.actualAudio).sort(),['bitsPerSample','channels','codec','container','sampleRateHz']);
  assert.deepStrictEqual({...resource.media.actualAudio},{codec:'flac',container:'flac',sampleRateHz:48000,bitsPerSample:24,channels:2});
});

test('MBM003模式真实分工：DSD旧mode及非DSD新mode双向禁止',() => {
  const rows = fixtureGroup(fixtures,'wrong-mode'); assert.equal(rows.length,6);
  for (const row of rows) {
    exerciseFixture(m,row);
    const body = fixtureJson<MobileResource>(row.response.body);
    assert.equal(m.common.mobileCommonResponseSnapshot('processing',body.processing).ok,true,row.id);
    assert.equal(m.resource.mobileDsdProcessingAllowed(body,row.context.resource!),false,row.id);
  }
});

test('MBM003处理解释：固定reason不写无损原生DSD或把缓存命中换成原因',() => {
  fixtureGroup(fixtures,'reason-invalid').forEach(row => exerciseFixture(m,row));
  const ready = bodyJson<MobileReadyResource>(fixtures,'dsd-ready');
  assert.equal(ready.processing.reason,'DSD整曲转换为24-bit/48kHz PCM并编码独立FLAC。');
  assert.equal(ready.processing.reason,m.resource.MOBILE_DSD_PCM_PROCESSING_REASON);
  for (const cache of [false,true]) {
    const whole = {...ready,processing:{...ready.processing,fromPreparedCache:cache}};
    const bytes = encode(whole);
    const decoded = m.wire.decodeMobileResponse('createResource',{status:201,headers:jsonHeaders(bytes),body:bytes,finalUrl:base.response.finalUrl},base.context);
    assert(decoded.ok); assert.equal((decoded.value.body as MobileReadyResource).processing.fromPreparedCache,cache);
  }
  for (const cache of [null,1,'true']) {
    const whole = {...ready,processing:{...ready.processing,fromPreparedCache:cache}};
    assert.equal(m.resource.mobileResourceResponseSnapshot(whole).ok,false);
  }
});

test('MBM003HTTP状态：201仅ready202仅preparing而GET可保留完整failed',() => {
  fixtureGroup(fixtures,'create-state').forEach(row => exerciseFixture(m,row));
  fixtureGroup(fixtures,'create-state-invalid').forEach(row => exerciseFixture(m,row));
  for (const row of fixtureGroup(fixtures,'all-states')) {
    const decoded = m.wire.decodeMobileResponse('getResource',responseInput(row),row.context);
    assert(decoded.ok); assert.equal(decoded.value.category,'success');
    assert.equal((decoded.value.body as MobileResource).state,fixtureJson<MobileResource>(row.response.body).state);
  }
  const failed = bodyJson<MobileResource>(fixtures,'dsd-failed'); assert.equal(failed.state,'failed');
  if (failed.state === 'failed') assert.deepStrictEqual({...failed.failure.error},{code:'UNSUPPORTED_FORMAT',message:'合成材料：DSD转换未取得合格产物。',requestId:'request.synthetic.003',retryable:false});
});

test('MBM003准备态诚实：preparing无media且failure仅failed必有完整嵌套error',() => {
  fixtureGroup(fixtures,'no-premature-media').forEach(row => exerciseFixture(m,row));
  for (const name of ['dsd-preparing','dsd-failed']) assert.equal(Object.hasOwn(bodyJson<MobileResource>(fixtures,name),'media'),false,name);
  const ready = bodyJson<MobileResource>(fixtures,'dsd-ready'); assert.equal(Object.hasOwn(ready,'failure'),false);
  const preparing = bodyJson<MobileResource>(fixtures,'dsd-preparing'); assert.equal(Object.hasOwn(preparing,'failure'),false);
});

test('MBM003固定媒体：允许HLS上下文也不能将DSD固定file或seekable放宽',() => {
  fixtureGroup(fixtures,'fixed-media').forEach(row => exerciseFixture(m,row));
  const ready = bodyJson<MobileReadyResource>(fixtures,'dsd-ready');
  assert.equal(ready.media.transport,'file'); assert.equal(ready.media.seekable,true);
  const wrong = {...ready,media:{...ready.media,actualAudio:{...ready.media.actualAudio,sampleRateHz:ready.sourceAudio.sampleRateHz}}};
  const bytes = encode(wrong);
  assert.equal(m.wire.decodeMobileResponse('createResource',{status:201,headers:jsonHeaders(bytes),body:bytes,finalUrl:base.response.finalUrl},base.context).ok,false);
});

test('MBM003原会话观察释放：完整body和原key要求不被DSD合同替换',() => {
  const origin = context.responseOrigin, scope = context.scope;
  const sessionPath = '/mobile/v1/sessions', sessionContext = {requestPath:sessionPath,responseOrigin:origin,session:scope};
  const body = encode(bodyJson<unknown>(fixtures,'session-request'));
  const incoming = {method:'POST',path:sessionPath,headers:[...jsonHeaders(body),['Idempotency-Key','key.synthetic.session.003'] as [string,string]],query:[],body};
  assert.equal(m.wire.decodeMobileRequest('createSession',incoming,sessionContext).ok,true);
  assert.equal(m.wire.decodeMobileRequest('createSession',{...incoming,headers:jsonHeaders(body)},sessionContext).ok,false);
  const reply = encode(bodyJson<unknown>(fixtures,'session-reply'));
  assert.equal(m.wire.decodeMobileResponse('createSession',{status:201,headers:jsonHeaders(reply),body:reply,finalUrl:origin+sessionPath},sessionContext).ok,true);
  const observationPath = `${sessionPath}/${scope.sessionId}/observation`, observation = encode(bodyJson<unknown>(fixtures,'observation-request'));
  const observationContext = {requestPath:observationPath,responseOrigin:origin};
  assert.equal(m.wire.decodeMobileRequest('reportObservation',{method:'PUT',path:observationPath,headers:jsonHeaders(observation),query:[],body:observation},observationContext).ok,true);
  const acknowledgement = encode(bodyJson<unknown>(fixtures,'observation-reply'));
  assert.equal(m.wire.decodeMobileResponse('reportObservation',{status:200,headers:jsonHeaders(acknowledgement),body:acknowledgement,finalUrl:origin+observationPath},observationContext).ok,true);
  const resourcePath = `${sessionPath}/${scope.sessionId}/resources/resource.synthetic.003`, resourceContext = {requestPath:resourcePath,responseOrigin:origin};
  assert.equal(m.wire.decodeMobileRequest('releaseResource',{method:'DELETE',path:resourcePath,headers:[],query:[],body:new Uint8Array()},resourceContext).ok,true);
  assert.equal(m.wire.decodeMobileResponse('releaseResource',{status:204,headers:[],body:new Uint8Array(),finalUrl:origin+resourcePath},resourceContext).ok,true);
  assert.equal(m.wire.decodeMobileResponse('releaseResource',{status:204,headers:[],body:encode({}),finalUrl:origin+resourcePath},resourceContext).ok,false);
  // 这些断言仍是纯HTTP合同；不声称执行了Owner session/release或真实FD关闭。
});
