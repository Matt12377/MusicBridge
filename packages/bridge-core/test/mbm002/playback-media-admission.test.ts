import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { MobileDecodedRequest, MobileReadyResource, MobileSession, MobileObservation } from '@music-bridge/contracts';
import { createMobilePlaybackService } from '../../src/mobile/playback-service.js';
import { createMobileAuthCrypto } from '../../src/mobile/auth-crypto.js';
import { encodePlaybackStorage, decodePlaybackStorage } from '../../src/mobile/playback-state-codec.js';
import { MobileAuthPersistenceError, type MobileAuthPersistence, type MobilePrincipal, type MobileSealedState } from '../../src/mobile/types.js';
import { MobilePlaybackError, type MobilePlaybackControlOperation, type MobilePlaybackPreparedSource, type MobilePlaybackSourcePort,
  type MobilePlaybackLimits, type MobilePlaybackStateCodecPort } from '../../src/mobile/playback-types.js';
import type { PlaybackState } from '../../src/mobile/playback-state.js';

const SERVER='server.media-admission', DATASET='dataset.media-admission', ORIGIN='https://127.0.0.1:9443';
const device: MobilePrincipal=Object.freeze({serverId:SERVER,datasetId:DATASET,deviceId:'device.one',deviceEpoch:1,generation:1,
  accountDomain:`local:${DATASET}`,accessTokenHash:'a'.repeat(64),accessExpiresAt:'2030-01-01T00:00:00.000Z'});
function deferred<T>() { let resolve!:(value:T|PromiseLike<T>)=>void; const promise=new Promise<T>(yes=>{resolve=yes;}); return {promise,resolve}; }
function gate() { return {entered:deferred<void>(),release:deferred<void>()}; }
async function turns(count=12) { for(let i=0;i<count;i++)await new Promise<void>(resolve=>setImmediate(resolve)); }
const signal=()=>new AbortController().signal;
const requestBody={trackId:'track.one',versionId:'version.one',contentRevision:'content.one',quality:{profile:'lossless',allowLossyFallback:false,preferredTransport:'file'},
  formats:[{codec:'pcm_s16le',container:'wav',maxSampleRateHz:48_000,maxBitsPerSample:16,maxChannels:2}]} as const;
function request(operation:MobilePlaybackControlOperation,sessionId?:string,resourceId?:string,body:unknown=null,key?:string):MobileDecodedRequest<unknown>{
  const base='/mobile/v1/sessions';
  const resource=['getResource','releaseResource','renewResource'].includes(operation);
  const path=operation==='createSession'?base:operation==='reportObservation'?`${base}/${sessionId}/observation`
    :operation==='createResource'?`${base}/${sessionId}/resources`:resource?`${base}/${sessionId}/resources/${resourceId}${operation==='renewResource'?'/renew':''}`:`${base}/${sessionId}`;
  return {path,pathParameters:operation==='createSession'?{}:resource?{sessionId:sessionId!,resourceId:resourceId!}:{sessionId:sessionId!},query:{},body,...(key?{idempotencyKey:key}:{})};
}
function mediaRequest(resource:{id:string;media:{url:string}}):MobileDecodedRequest<unknown>{const url=new URL(resource.media.url);
  return {path:url.pathname,pathParameters:{resourceId:resource.id,asset:'source'},query:{ticket:url.searchParams.get('ticket')!},body:null};}

/** 合成Main作者、Owner提交和原文件端口；不读取真实账户、媒体或运行态。 */
function fixture(t:TestContext,limits?:Partial<MobilePlaybackLimits>){
  let now=Date.parse('2026-10-20T00:00:00.000Z'),stored:MobileSealedState={kind:'missing',datasetId:DATASET,revision:0};
  let encodeGate:ReturnType<typeof gate>|undefined,saveGate:ReturnType<typeof gate>|undefined,verifyGate:ReturnType<typeof gate>|undefined,authGate:ReturnType<typeof gate>|undefined;
  let onCandidate:((state:PlaybackState)=>void)|undefined;
  let saveFault:'not-sent'|'unknown-before'|'unknown-after'|'conflict'|'malformed'|undefined,revoked=false;
  const gates=new Set<ReturnType<typeof gate>>(),handles=new Map<string,MobilePlaybackPreparedSource>(),verifying=new Map<string,Set<Promise<void>>>();
  const counts={saves:0,loads:0,encodes:0,reads:0,closes:0,releases:0,verifies:0};
  const data=Uint8Array.from({length:262_144},(_,i)=>i%251);
  const persistence:MobileAuthPersistence={async load(){counts.loads++;return structuredClone(stored);},async save(input){
    counts.saves++;const held=saveGate;saveGate=undefined;const fault=saveFault;saveFault=undefined;
    held?.entered.resolve();if(held)await held.release.promise;
    if(fault==='not-sent')throw new MobileAuthPersistenceError('not-sent');
    if(fault==='unknown-before')throw new MobileAuthPersistenceError('unknown');
    if(fault==='conflict')return {kind:'conflict',datasetId:DATASET,currentRevision:input.expectedRevision+1};
    assert.equal(input.expectedRevision,stored.revision);
    stored={kind:'sealed',datasetId:DATASET,revision:input.expectedRevision+1,commitId:input.commitId,sealed:new Uint8Array(input.sealed)};
    if(fault==='unknown-after')throw new MobileAuthPersistenceError('unknown');
    return {kind:'saved',datasetId:DATASET,revision:stored.revision,commitId:fault==='malformed'?'wrong-commit':input.commitId};
  }};
  const codec:MobilePlaybackStateCodecPort={async encode(input,context){counts.encodes++;onCandidate?.(input);const held=encodeGate;encodeGate=undefined;
    held?.entered.resolve();if(held)await held.release.promise;return encodePlaybackStorage(input,SERVER,DATASET,ORIGIN,context.limits,context.terminalFailureBudget);},
    async decode(input,context){return decodePlaybackStorage(input,SERVER,DATASET,ORIGIN,context.limits);},async close(){}};
  const source:MobilePlaybackSourcePort={async prepare(input){const result:MobilePlaybackPreparedSource={handle:`handle.${input.resourceId}`,
    sourceAudio:{codec:'pcm_s16le',container:'wav',sampleRateHz:44_100,bitsPerSample:16,channels:2},
    actualAudio:{codec:'pcm_s16le',container:'wav',sampleRateHz:44_100,bitsPerSample:16,channels:2},
    processing:{mode:'direct',reason:'合成原字节',fromPreparedCache:false},contentType:'audio/wav',size:data.length,durationMs:4_000,seekable:true};
    handles.set(result.handle,result);return structuredClone(result);},
    async verify(handle){counts.verifies++;const held=verifyGate;verifyGate=undefined;
      const work=(async()=>{held?.entered.resolve();if(held)await held.release.promise;if(!handles.has(handle))throw new MobilePlaybackError(409,'SOURCE_CHANGED');})();
      const flights=verifying.get(handle)??new Set<Promise<void>>();flights.add(work);verifying.set(handle,flights);
      try{await work;}finally{flights.delete(work);if(!flights.size)verifying.delete(handle);}},
    async renew(handle){assert.ok(handles.has(handle));},async read(handle,_readId,start,maxBytes){assert.ok(handles.has(handle));counts.reads++;return data.slice(start,start+maxBytes);},
    async closeRead(){counts.closes++;},async release(handle){await Promise.allSettled([...(verifying.get(handle)??[])]);if(handles.delete(handle))counts.releases++;}};
  const service=createMobilePlaybackService({serverId:SERVER,datasetId:DATASET,responseOrigin:ORIGIN,persistence,
    crypto:createMobileAuthCrypto(new Uint8Array(32).fill(17)),sourcePort:source,stateCodec:codec,nowMs:()=>now,
    auth:{async assertDeviceCurrent(){const held=authGate;authGate=undefined;held?.entered.resolve();if(held)await held.release.promise;if(revoked)throw new Error('合成设备撤销');}},...(limits?{limits}:{})});
  const hold=(kind:'encode'|'save'|'verify'|'auth')=>{const held=gate();gates.add(held);if(kind==='encode')encodeGate=held;else if(kind==='save')saveGate=held;else if(kind==='auth')authGate=held;else verifyGate=held;return held;};
  t.after(async()=>{for(const held of gates)held.release.resolve();await service.close();assert.equal(handles.size,0);});
  const call=(operation:MobilePlaybackControlOperation,input:MobileDecodedRequest<unknown>)=>service.control(operation,input,device,signal());
  const observe=(session:MobileSession,resource:MobileReadyResource,sequence=1)=>{const body:MobileObservation={sequence,playerGeneration:1,queueItemId:'queue.one',
    resourceId:resource.id,trackId:resource.trackId,positionMs:100,state:'playing'};return call('reportObservation',request('reportObservation',session.id,undefined,body));};
  return {service,call,observe,hold,counts,data,handles,onCandidate:(value:typeof onCandidate)=>{onCandidate=value;},advance:(ms:number)=>{now+=ms;},revoke:()=>{revoked=true;},fault:(value:typeof saveFault)=>{saveFault=value;},
    async ready(label='one'){const session=(await call('createSession',request('createSession',undefined,undefined,{clientInstanceId:`client.${label}`},`session.${label}`))).body as MobileSession;
      const initial=await call('createResource',request('createResource',session.id,undefined,requestBody,`resource.${label}`));
      const resource=initial.body as MobileReadyResource;assert.equal(initial.status,201);assert.equal(resource.state,'ready');return {session,resource};}};
}

test('媒体打开：已提交原票据不被ahead控制的blocked codec占用',async t=>{
  const f=fixture(t),{session,resource}=await f.ready(),held=f.hold('encode');
  const observation=f.observe(session,resource);await held.entered.promise;
  let mediaSettled=false;const opening=f.service.openMedia('getMediaAsset',mediaRequest(resource),signal(),{range:'bytes=0-65535'}).then(value=>{mediaSettled=true;return value;});
  await turns();const progressedBeforeControl=mediaSettled;
  held.release.resolve();const result=await observation,reply=await opening;await reply.close();
  assert.equal(progressedBeforeControl,true,'Range应在控制编码仍挂起时完成已提交资源的准入');
  assert.deepEqual(result.body,{acceptedSequence:1,accepted:true});
});

test('媒体打开：当前Owner提交未ACK时不越过发布屏障，observation也不提前接受',async t=>{
  const f=fixture(t),{session,resource}=await f.ready(),held=f.hold('save');
  let observed=false;const observation=f.observe(session,resource).then(value=>{observed=true;return value;});await held.entered.promise;
  const before=f.counts.verifies;let settled=false;
  const opening=f.service.openMedia('getMediaAsset',mediaRequest(resource),signal()).then(value=>{settled=true;return value;});
  await turns();assert.equal(settled,false);assert.equal(observed,false);assert.equal(f.counts.verifies,before);
  held.release.resolve();await observation;const media=await opening;await media.beforeSend();assert.equal(media.status,200);await media.close();
});

test('媒体打开：排队的release/close先占对应scope，不能从控制计算旁边穿过',async t=>{
  for(const operation of ['releaseResource','closeSession'] as const)await t.test(operation,async sub=>{
    const f=fixture(sub),{session,resource}=await f.ready(),held=f.hold('encode');
    const observation=f.observe(session,resource);await held.entered.promise;
    const closing=f.call(operation,request(operation,session.id,resource.id));
    const before=f.counts.verifies;let granted=false;
    const opening=f.service.openMedia('getMediaAsset',mediaRequest(resource),signal()).then(value=>{granted=true;return {value};},error=>({error}));
    await turns();assert.equal(granted,false);assert.equal(f.counts.verifies,before);
    held.release.resolve();await observation;assert.equal((await closing).status,204);
    const result=await opening;assert.ok('error' in result);assert.equal(f.service.resourceSnapshot().readers,0);
  });
});

test('媒体打开：终止scope不扩大到另一会话，原作者写入仍完整完成',async t=>{
  const f=fixture(t),one=await f.ready(),other=await f.ready('other'),held=f.hold('encode');
  const observation=f.observe(one.session,one.resource);await held.entered.promise;
  const closing=f.call('closeSession',request('closeSession',one.session.id));
  let granted=false;const opening=f.service.openMedia('headMediaAsset',mediaRequest(other.resource),signal()).then(value=>{granted=true;return value;});
  await turns();const beforeRelease=granted;held.release.resolve();await observation;await closing;
  const media=await opening;assert.equal(beforeRelease,true);assert.equal(media.status,200);assert.equal(media.reader,null);await media.close();
});

test('媒体打开：未知提交及冲突拒绝迟到准入，不借旧state发出新reader',async t=>{
  for(const fault of ['unknown-before','unknown-after','conflict','malformed'] as const)await t.test(fault,async sub=>{
    const f=fixture(sub),{session,resource}=await f.ready(),held=f.hold('save');f.fault(fault);
    const observation=f.observe(session,resource).then(value=>({value}),error=>({error}));await held.entered.promise;
    const opening=f.service.openMedia('getMediaAsset',mediaRequest(resource),signal()).then(value=>({value}),error=>({error}));
    await turns();held.release.resolve();assert.ok('error' in await observation);assert.ok('error' in await opening);
    assert.equal(f.service.resourceSnapshot().readers,0);assert.equal(f.counts.reads,0);
  });
});

test('媒体打开：明确not-sent保留旧已提交票据，不能把失败observation当接受',async t=>{
  const f=fixture(t),{session,resource}=await f.ready(),held=f.hold('save');f.fault('not-sent');
  const observation=f.observe(session,resource).then(value=>({value}),error=>({error}));await held.entered.promise;
  const opening=f.service.openMedia('getMediaAsset',mediaRequest(resource),signal(),{range:'bytes=5-15'});
  held.release.resolve();assert.ok('error' in await observation);const media=await opening;
  assert.deepEqual(await media.reader!.read(),f.data.slice(5,16));await media.close();assert.equal(f.service.resourceSnapshot().pendingPersistence,false);
});

test('媒体打开：UNKNOWN恢复换controller后原迟到打开仍失效，新请求才可取已核原记录',async t=>{
  const f=fixture(t),{session,resource}=await f.ready(),held=f.hold('verify');
  const opening=f.service.openMedia('getMediaAsset',mediaRequest(resource),signal()).then(value=>({value}),error=>({error}));await held.entered.promise;
  f.fault('unknown-after');const observation=await f.observe(session,resource).then(value=>({value}),error=>({error}));assert.ok('error' in observation);
  assert.equal(f.service.resourceSnapshot().pendingPersistence,true);
  await f.call('getSession',request('getSession',session.id));assert.equal(f.service.resourceSnapshot().pendingPersistence,false);
  held.release.resolve();assert.ok('error' in await opening);
  const fresh=await f.service.openMedia('getMediaAsset',mediaRequest(resource),signal(),{range:'bytes=0-15'});
  assert.deepEqual(await fresh.reader!.read(),f.data.slice(0,16));await fresh.close();
});

test('媒体打开：verify期间撤销、终止和绝对到期均挡住晚回包',async t=>{
  for(const mode of ['revoke','release','session-close','ticket-expiry'] as const)await t.test(mode,async sub=>{
    const f=fixture(sub),{session,resource}=await f.ready(),held=f.hold('verify');
    const opening=f.service.openMedia('getMediaAsset',mediaRequest(resource),signal()).then(value=>({value}),error=>({error}));await held.entered.promise;
    let termination:Promise<unknown>|undefined;
    if(mode==='revoke'){f.revoke();termination=f.service.revokeDevice(device.deviceId);}
    if(mode==='release')termination=f.call('releaseResource',request('releaseResource',session.id,resource.id));
    if(mode==='session-close')termination=f.call('closeSession',request('closeSession',session.id));
    if(mode==='ticket-expiry')f.advance(60_001);
    await turns();held.release.resolve();await termination;assert.ok('error' in await opening);
    assert.equal(f.service.resourceSnapshot().readers,0);assert.equal(f.counts.reads,0);
  });
});

test('媒体打开：原并发上限计入在途准入，超时不偷释放实际Owner工作',async t=>{
  const f=fixture(t,{maxReads:1,maxReadsPerResource:1,mediaEstablishmentMs:10}),{resource}=await f.ready(),held=f.hold('verify');
  const opening=f.service.openMedia('getMediaAsset',mediaRequest(resource),signal());const failed=assert.rejects(opening);await held.entered.promise;await failed;
  const before=f.counts.verifies;await assert.rejects(f.service.openMedia('getMediaAsset',mediaRequest(resource),signal()),
    (error:unknown)=>error instanceof MobilePlaybackError&&error.code==='RESOURCE_BUSY');assert.equal(f.counts.verifies,before);
  let closed=false;const closing=f.service.close().then(()=>{closed=true;});await turns();assert.equal(closed,false);
  held.release.resolve();await closing;assert.equal(f.service.resourceSnapshot().readers,0);
});

test('媒体打开：shutdown等待原verify实际静止，取消者没有晚建reader',async t=>{
  const f=fixture(t),{resource}=await f.ready(),held=f.hold('verify'),controller=new AbortController();
  const opening=f.service.openMedia('getMediaAsset',mediaRequest(resource),controller.signal).then(value=>({value}),error=>({error}));await held.entered.promise;
  controller.abort();assert.ok('error' in await opening);let closed=false;const closing=f.service.close().then(()=>{closed=true;});
  await turns();assert.equal(closed,false);assert.equal(f.counts.releases,0);held.release.resolve();await closing;
  assert.equal(f.counts.releases,1);assert.equal(f.service.resourceSnapshot().readers,0);
});

test('媒体打开：HEAD/400/416仍有源资格检查，零body不创建或拉取reader',async t=>{
  const f=fixture(t),{resource}=await f.ready(),before=f.counts.verifies;
  for(const [operation,range,status] of [['headMediaAsset',undefined,200],['getMediaAsset','bytes=invalid',400],['getMediaAsset','bytes=999999-1000000',416]] as const){
    const media=await f.service.openMedia(operation,mediaRequest(resource),signal(),range?{range}:{});assert.equal(media.status,status);assert.equal(media.reader,null);
    await media.beforeSend();await media.close();
  }
  assert.equal(f.counts.verifies,before+3);assert.equal(f.counts.reads,0);
});

test('媒体打开：定时清理未排到时也同步拒绝orphan',async t=>{
  const f=fixture(t,{orphanResourceMs:1000}),{resource}=await f.ready();f.advance(1001);
  await assert.rejects(f.service.openMedia('getMediaAsset',mediaRequest(resource),signal()),
    (error:unknown)=>error instanceof MobilePlaybackError&&error.code==='RESOURCE_EXPIRED');assert.equal(f.counts.reads,0);
});

test('媒体打开：preparing时先排终止，finalize发布后仍不能越过真实scope',async t=>{
  for(const operation of ['closeSession','releaseResource'] as const)await t.test(operation,async sub=>{
    const f=fixture(sub),session=(await f.call('createSession',request('createSession',undefined,undefined,{clientInstanceId:'client.one'},'session.one'))).body as MobileSession;
    const reached=deferred<{held:ReturnType<typeof gate>;resourceId:string}>();
    f.onCandidate(state=>{const resource=state.resources.find(r=>r.state==='ready');if(resource){f.onCandidate(undefined);reached.resolve({held:f.hold('encode'),resourceId:resource.id});}});
    const creating=f.call('createResource',request('createResource',session.id,undefined,requestBody,'resource.one'));
    const {held:readyGate,resourceId}=await reached.promise;await readyGate.entered.promise;
    const closing=f.call(operation,request(operation,session.id,resourceId));
    const auth=f.hold('auth');readyGate.release.resolve();await auth.entered.promise;
    const resource=(await creating).body as MobileReadyResource;assert.equal(resource.state,'ready');
    let granted=false;const opening=f.service.openMedia('getMediaAsset',mediaRequest(resource),signal()).then(value=>{granted=true;return {value};},error=>({error}));
    await turns();const overtook=granted;auth.release.resolve();const result=await opening;if('value'in result)await result.value.close();await closing;
    assert.equal(overtook,false,'入队时preparing也必须由原scope保护其后来ready状态');
    assert.ok('error'in result);assert.equal(f.service.resourceSnapshot().readers,0);
  });
});

test('媒体打开：reader槽已满不改变HEAD和错误Range的零reader准入',async t=>{
  const f=fixture(t,{maxReads:1,maxReadsPerResource:1}),{resource}=await f.ready();
  const existing=await f.service.openMedia('getMediaAsset',mediaRequest(resource),signal(),{range:'bytes=0-15'});await turns();
  for(const [operation,range,status] of [['headMediaAsset',undefined,200],['getMediaAsset','bytes=invalid',400],['getMediaAsset','bytes=999999-1000000',416]] as const){
    const reply=await f.service.openMedia(operation,mediaRequest(resource),signal(),range?{range}:{});
    assert.equal(reply.status,status);assert.equal(reply.reader,null);await reply.close();await turns();
  }
  assert.equal(f.service.resourceSnapshot().readers,1);await existing.close();
});

test('媒体打开：candidate已有ready票据但Owner未ACK时不能观察新grant',async t=>{
  const f=fixture(t),session=(await f.call('createSession',request('createSession',undefined,undefined,{clientInstanceId:'client.one'},'session.one'))).body as MobileSession;
  const reached=deferred<{held:ReturnType<typeof gate>;resource:{id:string;media:{url:string}}}>();
  f.onCandidate(state=>{const resource=state.resources.find(r=>r.state==='ready'&&r.media!==null);if(resource?.media){f.onCandidate(undefined);
    reached.resolve({held:f.hold('save'),resource:{id:resource.id,media:{url:resource.media.url}}});}});
  const creating=f.call('createResource',request('createResource',session.id,undefined,requestBody,'resource.one'));
  const {held,resource}=await reached.promise;await held.entered.promise;
  await assert.rejects(f.service.openMedia('getMediaAsset',mediaRequest(resource),signal()),
    (error:unknown)=>error instanceof MobilePlaybackError&&error.code==='TICKET_INVALID');assert.equal(f.counts.reads,0);
  held.release.resolve();const committed=(await creating).body as MobileReadyResource;
  const media=await f.service.openMedia('getMediaAsset',mediaRequest(committed),signal(),{range:'bytes=0-15'});
  assert.deepEqual(await media.reader!.read(),f.data.slice(0,16));await media.close();
});

test('媒体打开：已登记reader保持原并行读语义，后续UNKNOWN立即撤销原signal',async t=>{
  const f=fixture(t),{session,resource}=await f.ready();
  const media=await f.service.openMedia('getMediaAsset',mediaRequest(resource),signal(),{range:'bytes=0-31'});
  const held=f.hold('save');f.fault('unknown-after');let accepted=false;
  const observation=f.observe(session,resource).then(value=>{accepted=true;return {value};},error=>({error}));await held.entered.promise;
  await media.beforeSend();assert.deepEqual(await media.reader!.read(16),f.data.slice(0,16));assert.equal(accepted,false);
  held.release.resolve();assert.ok('error'in await observation);assert.equal(media.resourceAbortSignal.aborted,true);
  await assert.rejects(media.reader!.read(16));assert.equal(f.counts.reads,1);await media.close();
});
