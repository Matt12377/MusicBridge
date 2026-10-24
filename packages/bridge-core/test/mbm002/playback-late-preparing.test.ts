import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createMobileAuthCrypto } from '../../src/mobile/auth-crypto.js';
import { createMobilePlaybackService } from '../../src/mobile/playback-service.js';
import { createPlaybackStorageActor, encodePlaybackStorage, decodePlaybackStorage, playbackStoragePatchReply } from '../../src/mobile/playback-state-codec.js';
import { MOBILE_PLAYBACK_DEFAULT_LIMITS, MobilePlaybackError, type MobilePlaybackStateCodecPort, type MobilePlaybackSourcePort } from '../../src/mobile/playback-types.js';
import { MobileAuthPersistenceError, type MobilePrincipal, type MobileSealedState } from '../../src/mobile/types.js';
import type { PlaybackState } from '../../src/mobile/playback-state.js';
import type { MobileDecodedRequest, MobileSession } from '@music-bridge/contracts';

const SERVER='late.synthetic',DATASET='late.dataset',ORIGIN='https://127.0.0.1:9443',NOW=Date.parse('2026-10-20T00:00:00Z');
const p:MobilePrincipal={serverId:SERVER,datasetId:DATASET,accountDomain:`local:${DATASET}`,deviceId:'device.synthetic',deviceEpoch:1,generation:1,
  accessTokenHash:'a'.repeat(64),accessExpiresAt:'2030-01-01T00:00:00.000Z'};
const gate=()=>{let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return{promise,resolve};};
async function until(predicate:()=>boolean){for(let n=0;n<1000&&!predicate();n++)await delay(2);assert.ok(predicate(),'受控事件未在有限等待内到达');}
function fixture(t:TestContext,incremental=false,smallPatch=false){
  const actor=createPlaybackStorageActor(),derivedEntered=gate(),derivedRelease=gate();
  const crypto=createMobileAuthCrypto(randomBytes(32)),verify=gate(),authEntered=gate(),authRelease=gate(),encodeEntered=gate(),encodeRelease=gate();
  let row:MobileSealedState={kind:'missing',datasetId:DATASET,revision:0},saves=0,authCalls=0,renews=0;
  let holdAuth=false,holdEncode=false,holdDerived=false,mutateCandidate=false,prepares=0,derives=0;let nextFault:'none'|'not-sent'|'unknown'='none';
  const states:PlaybackState[]=[];
  const preparingOwnerEntered=gate(),preparingOwnerRelease=gate();
  let holdPreparingOwner=false,holdPreparingDerived=false;
  const committed:PlaybackState[]=[];
  const codec:MobilePlaybackStateCodecPort={async encode(state,ctx){
    if(mutateCandidate){mutateCandidate=false;(state.receipts[0]!.reply!.body as {id:string}).id='unacknowledged.corruption';throw new MobilePlaybackError(503,'BUSY',true,1000);}
    const result=incremental?actor.encode(state,ctx):encodePlaybackStorage(state,SERVER,DATASET,ORIGIN,ctx.limits,ctx.terminalFailureBudget);states.push(result.state);
    if(holdEncode&&result.state.receipts.some(r=>r.operation==='createResource'&&r.reply?.status===202)&&!result.state.resources.some(r=>r.state==='ready')){
      holdEncode=false;encodeEntered.resolve();await encodeRelease.promise;
    }return result;
  },async decode(plain,ctx){return incremental?actor.decode(plain,ctx):decodePlaybackStorage(plain,SERVER,DATASET,ORIGIN,MOBILE_PLAYBACK_DEFAULT_LIMITS);},async close(){actor.close();}};
  if(incremental)Object.assign(codec,{async derive(base:unknown,patch:unknown,ctx:import('../../src/mobile/playback-types.js').MobilePlaybackStateCodecContext){derives++;const result=actor.derive(base,patch,ctx);states.push(result.state);if(holdDerived||holdPreparingDerived&&result.state.receipts.some(r=>r.operation==='createResource'&&r.reply?.status===202)){holdDerived=false;holdPreparingDerived=false;derivedEntered.resolve();await derivedRelease.promise;}return result;}});
  if(smallPatch)Object.assign(codec,{async derivePatch(base:unknown,patch:unknown,ctx:import('../../src/mobile/playback-types.js').MobilePlaybackStateCodecContext){
    derives++;const result=actor.derive(base,patch,ctx);states.push(result.state);
    if(holdPreparingDerived&&result.state.receipts.some(r=>r.operation==='createResource'&&r.reply?.status===202)){
      holdPreparingDerived=false;derivedEntered.resolve();await derivedRelease.promise;
    }
    return playbackStoragePatchReply(result,base,patch,ctx);
  }});
  const source:MobilePlaybackSourcePort={async prepare(request){prepares++;const audio={codec:'flac',container:'flac',sampleRateHz:44100,bitsPerSample:16,channels:2};
    return{handle:`handle.${request.resourceId}`,sourceAudio:audio,actualAudio:{...audio},processing:{mode:'direct',reason:'合成原字节',fromPreparedCache:false},
      contentType:'audio/flac',size:20000,durationMs:4000,seekable:true};},async verify(){await verify.promise;},async renew(){renews++;},
    async read(){return new Uint8Array();},async closeRead(){},async release(){}};
  const service=createMobilePlaybackService({serverId:SERVER,datasetId:DATASET,responseOrigin:ORIGIN,crypto,sourcePort:source,stateCodec:codec,nowMs:()=>NOW,
    auth:{async assertDeviceCurrent(){authCalls++;if(holdAuth&&authCalls===2){authEntered.resolve();await authRelease.promise;}}},
    persistence:{async load(){return structuredClone(row);},async save(request){assert.equal(request.expectedRevision,row.revision);
      const plain=crypto.open(request.sealed,Buffer.from(JSON.stringify(['MBM002_PLAYBACK_STATE_V1',SERVER,DATASET,request.expectedRevision+1])));
      let captured:PlaybackState;try{captured=decodePlaybackStorage(plain,SERVER,DATASET,ORIGIN,MOBILE_PLAYBACK_DEFAULT_LIMITS).state;}finally{plain.fill(0);}
      if(holdPreparingOwner&&captured.receipts.some(r=>r.operation==='createResource'&&r.reply?.status===202)){holdPreparingOwner=false;preparingOwnerEntered.resolve();await preparingOwnerRelease.promise;}
      saves++;const fault=nextFault;nextFault='none';if(fault==='not-sent')throw new MobileAuthPersistenceError('not-sent');
      row={kind:'sealed',datasetId:DATASET,revision:request.expectedRevision+1,commitId:request.commitId,sealed:new Uint8Array(request.sealed)};
      committed.push(captured);if(fault==='unknown')throw new MobileAuthPersistenceError('unknown');
      return{kind:'saved',datasetId:DATASET,revision:row.revision,commitId:row.commitId};}}});
  t.after(async()=>{verify.resolve();authRelease.resolve();encodeRelease.resolve();derivedRelease.resolve();preparingOwnerRelease.resolve();await service.close();});
  return{service,states,committed,preparingOwnerEntered,preparingOwnerRelease,armPreparingOwner(){holdPreparingOwner=true;},armPreparingDerive(){holdPreparingDerived=true;},verify,authEntered,authRelease,encodeEntered,encodeRelease,derivedEntered,derivedRelease,armDerive(){holdDerived=true;},saves:()=>saves,renews:()=>renews,prepares:()=>prepares,derives:()=>derives,failNext(fault:typeof nextFault){nextFault=fault;},
    mutateNextCandidate(){mutateCandidate=true;},armAuth(){holdAuth=true;authCalls=0;},armEncode(){holdEncode=true;}};
}
async function requests(f:ReturnType<typeof fixture>){
  const sessionRequest:MobileDecodedRequest<unknown>={path:'/mobile/v1/sessions',pathParameters:{},query:{},body:{clientInstanceId:'client.synthetic'},idempotencyKey:'session.synthetic'};
  const s=(await f.service.control('createSession',sessionRequest,p,new AbortController().signal)).body as MobileSession;
  const request:MobileDecodedRequest<unknown>={path:`/mobile/v1/sessions/${s.id}/resources`,pathParameters:{sessionId:s.id},query:{},idempotencyKey:'resource.synthetic',
    body:{trackId:'track.synthetic',versionId:'version.synthetic',contentRevision:'revision.synthetic',quality:{profile:'lossless',allowLossyFallback:false,preferredTransport:'file'},
      formats:[{codec:'flac',container:'flac',maxSampleRateHz:44100,maxChannels:2,maxBitsPerSample:16}]}};
  return request;
}
test('迟到preparing：授权enqueue等待期间verify及renew已成功，直接facts ready同ACK且原键201',async t=>{
  const f=fixture(t),request=await requests(f),before=f.saves();f.armAuth();
  const flight=f.service.control('createResource',request,p,new AbortController().signal);await f.authEntered.promise;
  f.verify.resolve();await until(()=>f.renews()===1);await delay(1);f.authRelease.resolve();
  const reply=await flight;assert.equal(reply.status,201);assert.equal(f.saves()-before,2);
  assert.equal(f.states.filter(s=>s.receipts.some(r=>r.operation==='createResource'&&r.reply?.status===202)).length,0);
  const replay=await f.service.control('createResource',request,p,new AbortController().signal);assert.equal(replay.status,201);assert.deepEqual(replay.body,reply.body);
});
test('迟到preparing：纯encode完成前verify及renew成功，未送Owner的202让给原键ready201',async t=>{
  const f=fixture(t),request=await requests(f),before=f.saves();f.armEncode();
  const flight=f.service.control('createResource',request,p,new AbortController().signal);await f.encodeEntered.promise;
  f.verify.resolve();await until(()=>f.renews()===1);f.encodeRelease.resolve();
  const reply=await flight;assert.equal(reply.status,201);
  const replay=await f.service.control('createResource',request,p,new AbortController().signal);assert.equal(replay.status,201);assert.deepEqual(replay.body,reply.body);
  assert.equal(f.saves()-before,2);
  assert.equal(f.committed.some(s=>s.receipts.some(r=>r.reply?.status===202)),false);
});

test('迟到preparing：增量derive期间成功也只UNKNOWN与ready两次持久化ACK',async t=>{
  const f=fixture(t,true),request=await requests(f),before=f.saves();f.armPreparingDerive();
  const flight=f.service.control('createResource',request,p,new AbortController().signal);await f.derivedEntered.promise;
  f.verify.resolve();await until(()=>f.renews()===1);f.derivedRelease.resolve();
  const reply=await flight;assert.equal(reply.status,201);assert.equal(f.saves()-before,2);
  assert.equal(f.committed.some(s=>s.receipts.some(r=>r.reply?.status===202)),false);
  const replay=await f.service.control('createResource',request,p,new AbortController().signal);assert.deepEqual(replay.body,reply.body);
  assert.equal(f.prepares(),1);
});

test('迟到preparing：202已经进入Owner后才验证成功，原202与幂等回执不得改写',async t=>{
  const f=fixture(t,true),request=await requests(f),before=f.saves();f.armPreparingOwner();
  const flight=f.service.control('createResource',request,p,new AbortController().signal);await f.preparingOwnerEntered.promise;
  f.verify.resolve();await until(()=>f.renews()===1);f.preparingOwnerRelease.resolve();
  const reply=await flight;assert.equal(reply.status,202);await until(()=>f.committed.some(s=>s.resources.some(r=>r.state==='ready')));
  const replay=await f.service.control('createResource',request,p,new AbortController().signal);assert.equal(replay.status,202);assert.deepEqual(replay.body,reply.body);
  assert.equal(f.saves()-before,3);assert.equal(f.prepares(),1);
});

test('迟到preparing：候选等待期间设备撤销，不能借已完成验证提交或回送201',async t=>{
  const f=fixture(t,true),request=await requests(f);f.armPreparingDerive();
  const flight=f.service.control('createResource',request,p,new AbortController().signal);const settled=flight.then(reply=>({status:reply.status}),()=>({status:null}));await f.derivedEntered.promise;
  f.verify.resolve();await until(()=>f.renews()===1);const revoked=f.service.revokeDevice(p.deviceId);f.derivedRelease.resolve();
  const result=await settled;await revoked;assert.notEqual(result.status,201);assert.notEqual(result.status,202);
  assert.equal(f.committed.some(s=>s.receipts.some(r=>r.reply?.status===202)),false);
});

test('增量actor ACK：新增session及resource复用已ACK base，每次ACK仍保存，原键不重prepare',async t=>{
  const f=fixture(t,true),request=await requests(f);f.verify.resolve();
  const session2={path:'/mobile/v1/sessions',pathParameters:{},query:{},body:{clientInstanceId:'client.second'},idempotencyKey:'session.second'};
  const second=await f.service.control('createSession',session2,p,new AbortController().signal);assert.equal(second.status,201);assert.equal(f.derives(),1);
  const before=f.saves(),reply=await f.service.control('createResource',request,p,new AbortController().signal);assert.equal(reply.status,201);assert.equal(f.saves()-before,2);assert.equal(f.derives(),3);
  await reply.beforeSend();assert.equal((await f.service.control('createResource',request,p,new AbortController().signal)).status,201);assert.equal(f.prepares(),1);assert.equal(f.saves()-before,2);
});
test('增量actor ACK：UNKNOWN未发送可原键重试，已提交丢ACK只精确重读且不外部prepare',async t=>{
  for(const fault of ['not-sent','unknown'] as const){const f=fixture(t,true),request=await requests(f);f.verify.resolve();f.failNext(fault);
    await assert.rejects(f.service.control('createResource',request,p,new AbortController().signal));assert.equal(f.prepares(),0);
    if(fault==='not-sent'){assert.equal((await f.service.control('createResource',request,p,new AbortController().signal)).status,201);assert.equal(f.prepares(),1);}
    else{await assert.rejects(f.service.control('createResource',request,p,new AbortController().signal));assert.equal(f.prepares(),0);assert.equal(f.saves(),2);}
  }
});

test('增量actor ACK：ready提交已落盘丢ACK只精确重读原201，不重准备或重保存',async t=>{
  const f=fixture(t,true),request=await requests(f),flight=f.service.control('createResource',request,p,new AbortController().signal);
  await until(()=>f.prepares()===1);f.failNext('unknown');f.verify.resolve();await assert.rejects(flight);
  const before=f.saves(),replay=await f.service.control('createResource',request,p,new AbortController().signal);assert.equal(replay.status,201);assert.equal(f.prepares(),1);assert.equal(f.saves(),before);
});
test('增量actor fence：derive已计算但未发Owner时撤销，迟到候选不能写入或外部prepare',async t=>{
  const f=fixture(t,true),request=await requests(f),before=f.saves();f.armDerive();
  const flight=f.service.control('createResource',request,p,new AbortController().signal),rejected=assert.rejects(flight);await f.derivedEntered.promise;
  const revoked=f.service.revokeDevice(p.deviceId);f.derivedRelease.resolve();await rejected;await revoked;
  assert.equal(f.saves()-before,1);assert.equal(f.prepares(),0);assert.equal(f.service.resourceSnapshot().pendingPersistence,false);
});

test('增量actor fallback：复杂全量操作未发送后丢弃旧handle，下一次原新intent全量重建仍可继续',async t=>{
  const f=fixture(t,true),request=await requests(f);f.verify.resolve();const made=await f.service.control('createResource',request,p,new AbortController().signal);
  const resource=made.body as {id:string;sessionId:string};f.failNext('not-sent');
  await assert.rejects(f.service.control('releaseResource',{path:`/mobile/v1/sessions/${resource.sessionId}/resources/${resource.id}`,pathParameters:{sessionId:resource.sessionId,resourceId:resource.id},query:{},body:null},p,new AbortController().signal));
  const next={...request,idempotencyKey:'next.after.full.failure'},before=f.derives();
  assert.equal((await f.service.control('createResource',next,p,new AbortController().signal)).status,201);assert.equal(f.prepares(),2);assert.equal(f.derives()-before,1);
});

test('无base旧codec隔离：拒绝前修改resource/session候选不能改变已ACK原回执或触发准备',async t=>{
  for(const operation of ['createResource','createSession'] as const)await t.test(operation,async child=>{
    const f=fixture(child),request=await requests(f),sessionId=request.pathParameters.sessionId,before=f.saves();f.mutateNextCandidate();
    const next=operation==='createResource'?request:{path:'/mobile/v1/sessions',pathParameters:{},query:{},body:{clientInstanceId:'new.client'},idempotencyKey:'new.session'};
    await assert.rejects(f.service.control(operation,next,p,new AbortController().signal));
    const original=await f.service.control('createSession',{path:'/mobile/v1/sessions',pathParameters:{},query:{},body:{clientInstanceId:'client.synthetic'},idempotencyKey:'session.synthetic'},p,new AbortController().signal);
    assert.equal((original.body as MobileSession).id,sessionId);assert.equal(f.saves(),before);assert.equal(f.prepares(),0);await original.beforeSend();
  });
});

test('迟到preparing：生产小patch回包跳过未发送202后仍以原已ACK base提交ready',async t=>{
  const f=fixture(t,true,true),request=await requests(f),before=f.saves();f.armPreparingDerive();
  const flight=f.service.control('createResource',request,p,new AbortController().signal);await f.derivedEntered.promise;
  f.verify.resolve();await until(()=>f.renews()===1);f.derivedRelease.resolve();
  const reply=await flight;assert.equal(reply.status,201);assert.equal(f.saves()-before,2);assert.equal(f.prepares(),1);
  assert.equal(f.committed.some(s=>s.receipts.some(r=>r.reply?.status===202)),false);
  const replay=await f.service.control('createResource',request,p,new AbortController().signal);assert.equal(replay.status,201);assert.deepEqual(replay.body,reply.body);
});
