import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createMobilePlaybackService } from '../../src/mobile/playback-service.js';
import { createMobileAuthCrypto } from '../../src/mobile/auth-crypto.js';
import { createPlaybackStorageActor, encodePlaybackStorage } from '../../src/mobile/playback-state-codec.js';
import { MOBILE_PLAYBACK_DEFAULT_LIMITS as limits, type MobilePlaybackSourcePort } from '../../src/mobile/playback-types.js';
import { MobileAuthPersistenceError, type MobileSealedState } from '../../src/mobile/types.js';
import { playbackCopy } from '../../src/mobile/playback-state.js';
import { capacityHistory,capacityPrincipal,CAPACITY_SERVER as serverId,CAPACITY_DATASET as datasetId,CAPACITY_ORIGIN as responseOrigin,CAPACITY_NOW as NOW } from './playback-state-capacity-fixture.js';

const gate=()=>{let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return{promise,resolve};};
async function until(check:()=>boolean){for(let n=0;n<1000&&!check();n++)await delay(2);assert.ok(check(),'受控工作未到达');}
function fixture(){
  const actor=createPlaybackStorageActor(),crypto=createMobileAuthCrypto(randomBytes(32)),release=gate();
  const state=capacityHistory({sessions:1,resources:1,receipts:2});state.sessions[0]!.terminal=null;
  Object.assign(state.resources[0]!,{state:'preparing',failure:null,source:null,media:null});
  Object.assign(state.receipts[1]!,{state:'UNKNOWN',reply:null,resourceContext:null});
  const encoded=encodePlaybackStorage(state,serverId,datasetId,responseOrigin,limits);
  let row:MobileSealedState={kind:'sealed',datasetId,revision:state.revision,commitId:state.commitId!,sealed:crypto.seal(encoded.bytes,Buffer.from(JSON.stringify(['MBM002_PLAYBACK_STATE_V1',serverId,datasetId,state.revision])))};
  encoded.bytes.fill(0);let loads=0,saves=0,auth=0,prepares=0,failLoad=false,hold=true,saveFault:'none'|'not-sent'|'unknown'='none';
  const seen:typeof state[]=[];
  const source:MobilePlaybackSourcePort={async prepare(){prepares++;throw new Error('预热不得准备来源');},async verify(){},async renew(){},async read(){return new Uint8Array();},async closeRead(){},async release(){}};
  const service=createMobilePlaybackService({serverId,datasetId,responseOrigin,crypto,sourcePort:source,nowMs:()=>NOW,
    auth:{async assertDeviceCurrent(){auth++;}},stateCodec:{async encode(s,c){const result=actor.encode(s,c);seen.push(playbackCopy(result.state));return result;},async decode(b,c){return actor.decode(b,c);},async close(){actor.close();}},
    persistence:{async load(){loads++;if(failLoad)throw new MobileAuthPersistenceError('not-sent');return structuredClone(row);},async save(request){saves++;if(hold)await release.promise;
      const fault=saveFault;saveFault='none';if(fault==='not-sent')throw new MobileAuthPersistenceError('not-sent');
      assert.equal(request.expectedRevision,row.revision);row={kind:'sealed',datasetId,revision:request.expectedRevision+1,commitId:request.commitId,sealed:new Uint8Array(request.sealed)};
      if(fault==='unknown')throw new MobileAuthPersistenceError('unknown');
      return{kind:'saved',datasetId,revision:row.revision,commitId:row.commitId};}}});
  return{service,state,seen,release,loads:()=>loads,saves:()=>saves,auth:()=>auth,prepares:()=>prepares,failLoad(){failLoad=true;},failSave(fault:typeof saveFault){saveFault=fault;},unblock(){hold=false;release.resolve();}};
}
test('私有预热：并发只冷读一次，恢复ACK前业务不得发布，保留UNKNOWN且不新建意图',async t=>{
  const f=fixture();t.after(async()=>{f.unblock();await f.service.close();});
  const first=f.service.initialize(),again=f.service.initialize();assert.equal(first,again);await until(()=>f.saves()===1);
  assert.equal(f.loads(),1);assert.equal(f.auth(),0);assert.equal(f.prepares(),0);assert.equal(f.seen[0]!.receipts.length,2);
  assert.deepEqual(f.seen[0]!.receipts,f.state.receipts);assert.equal(f.seen[0]!.resources[0]!.failure,'SERVICE_RESTARTED');
  let delivered=false;const command=f.service.control('createSession',{path:'/mobile/v1/sessions',pathParameters:{},query:{},body:{clientInstanceId:'warm.synthetic'},idempotencyKey:'warm.new'},capacityPrincipal(),new AbortController().signal).then(r=>{delivered=true;return r;});
  await delay(5);assert.equal(delivered,false);assert.equal(f.saves(),1);f.unblock();await first;const reply=await command;
  assert.equal(reply.status,201);assert.equal(f.loads(),1);assert.equal(f.saves(),2);assert.equal(f.prepares(),0);assert.ok(f.auth()>0);const auth=f.auth();await reply.beforeSend();assert.ok(f.auth()>auth);
  assert.deepEqual(f.seen.at(-1)!.receipts.slice(0,2),f.state.receipts);
});
test('私有预热：Owner尚未就绪的失败原样传播，重复initialize不重新读取，close仍实际收口',async()=>{
  const f=fixture();f.failLoad();const first=f.service.initialize();await assert.rejects(first,MobileAuthPersistenceError);
  assert.equal(f.service.initialize(),first);await assert.rejects(f.service.initialize(),MobileAuthPersistenceError);
  assert.equal(f.loads(),1);assert.equal(f.saves(),0);assert.equal(f.prepares(),0);f.unblock();await f.service.close();
});
test('私有预热：恢复写在途close必须等待真实ACK且不能再创建业务意图',async()=>{
  const f=fixture(),warm=f.service.initialize();await until(()=>f.saves()===1);let closed=false;
  const close=f.service.close().then(()=>{closed=true;});await delay(5);assert.equal(closed,false);f.unblock();await warm;await close;
  assert.equal(f.saves(),1);assert.equal(f.prepares(),0);await assert.rejects(f.service.control('createSession',{path:'/mobile/v1/sessions',pathParameters:{},query:{},body:{clientInstanceId:'late'},idempotencyKey:'late'},capacityPrincipal(),new AbortController().signal));
});
test('私有预热：恢复not-sent重读原状态，UNKNOWN仅精确核对原ACK，后台不自行重试',async t=>{
  for(const fault of ['not-sent','unknown']as const)await t.test(fault,async child=>{const f=fixture();f.failSave(fault);f.unblock();child.after(()=>f.service.close());
    const warm=f.service.initialize();await assert.rejects(warm);assert.equal(f.loads(),1);assert.equal(f.saves(),1);assert.equal(f.prepares(),0);assert.equal(f.auth(),0);
    await assert.rejects(f.service.initialize());assert.equal(f.loads(),1);assert.equal(f.saves(),1);
    const reply=await f.service.control('createSession',{path:'/mobile/v1/sessions',pathParameters:{},query:{},body:{clientInstanceId:'warm.recovered'},idempotencyKey:'warm.recovered'},capacityPrincipal(),new AbortController().signal);
    assert.equal(reply.status,201);assert.equal(f.loads(),2);assert.equal(f.saves(),fault==='not-sent'?3:2);assert.equal(f.prepares(),0);
    assert.deepEqual(f.seen.at(-1)!.receipts.slice(0,2),f.state.receipts);await reply.beforeSend();
  });
});
