import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { MOBILE_OPERATION_TABLE } from '@music-bridge/contracts';
import { createMobileContentRpcPort } from '../../src/mobile/content-rpc-port.js';
import { captureMobileContentRequest } from '../../src/mobile/content-protocol.js';
import type { MobileContentOperation, MobileContentPort } from '../../src/mobile/content-types.js';
import { mobileCapabilityRequestSha, snapshotMobileCapabilityTrace } from '../../src/mobile/capability-trace.js';
import { MobileServiceError } from '../../src/mobile/types.js';
import { BridgeError } from '../../src/shared/errors.js';

const scope={serverId:'server.diag',datasetId:'dataset.diag',deviceId:'device.diag',deviceEpoch:1,accessGeneration:1,
  ownerEpoch:'owner.diag',accountDomain:'nc:account.diag',providerEpoch:'provider.diag'};
const base=()=>({type:'mobile-content-core-request' as const,id:randomUUID()});
const signal=()=>new AbortController().signal;
const request=(operation:MobileContentOperation)=>captureMobileContentRequest(operation,{path:MOBILE_OPERATION_TABLE[operation].path,pathParameters:{},query:{},body:null});
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};};
function port(content:MobileContentPort){return createMobileContentRpcPort({initialize:async()=>{},invalidateDevice:async()=>{},
  resolveScope:async principal=>({...scope,...principal}),assertScope:()=>{},content,source:async()=>{throw new Error('此夹具不读取媒体');}});}

test('私有内容首因：默认关闭不采集，开启保原BridgeError闭集且RPC仍安全BUSY、不重演工作',async()=>{
  for(const enabled of [false,true]){
    let calls=0;const original=new BridgeError('NETEASE_REQUEST_FAILED','禁止正文 https://secret.invalid/ token');
    const rpc=port({async dispatch(){calls++;throw original;}});
    try{
      await rpc.request({...base(),action:'initialize',serverId:scope.serverId,datasetId:scope.datasetId,key:new Uint8Array(32).fill(1),
        ...(enabled?{privateProviderDiagnostics:true as const}:{})},signal());
      const call={...base(),action:'dispatch' as const,operation:'getNeteaseDailyRecommendations' as const,scope,request:request('getNeteaseDailyRecommendations')};
      const reply=await rpc.request(call,signal());assert.ok('kind' in reply&&reply.kind==='error');
      assert.equal(reply.status,503);assert.equal(reply.code,'BUSY');assert.equal(reply.outcome,null);assert.equal(calls,1);
      const sha=mobileCapabilityRequestSha('content',call.id);const snapshot=snapshotMobileCapabilityTrace();
      const rows=[...snapshot.records,...snapshot.firstBusinessFailures].filter(row=>row.component==='core'&&row.requestSha256===sha);
      if(!enabled)assert.deepEqual(rows,[]);
      else{
        assert.ok(rows.some(row=>row.stage==='core.dispatch.content'&&row.phase==='reject'&&row.code==='NETEASE_REQUEST_FAILED'&&row.name==='BridgeError'));
        assert.ok(rows.filter(row=>row.phase==='begin'||row.phase==='ok').length<=64);
        assert.doesNotMatch(JSON.stringify(rows),/禁止正文|secret\.invalid|token|message|stack/iu);
        const ids=[sha];
        for(let index=1;index<9;index++){
          const next={...call,id:randomUUID()};ids.push(mobileCapabilityRequestSha('content',next.id));
          const refused=await rpc.request(next,signal());assert.ok('kind' in refused&&refused.kind==='error');assert.equal(refused.code,'BUSY');
        }
        const observed=new Set(snapshotMobileCapabilityTrace().firstBusinessFailures.filter(row=>row.component==='core'&&ids.includes(row.requestSha256)).map(row=>row.requestSha256));
        assert.equal(observed.size,8);assert.equal(calls,9);
      }
    }finally{await rpc.close();}
  }
});

test('私有内容容量旁注：仍15个数据槽，取消输出不释放未静止工作，控制取消须等原flight',async()=>{
  const gate=deferred(),entered=deferred();let count=0;
  const rpc=port({async dispatch(){count++;if(count===15)entered.resolve();await gate.promise;throw new MobileServiceError(503,'BUSY');}});
  const controllers=Array.from({length:15},()=>new AbortController());let cancel:ReturnType<typeof rpc.request>|undefined;
  const calls=controllers.map(()=>({...base(),action:'dispatch' as const,operation:'getNeteaseLikedPlaylist' as const,scope,request:request('getNeteaseLikedPlaylist')}));
  const held:Array<ReturnType<typeof rpc.request>>=[];
  try{
    await rpc.request({...base(),action:'initialize',serverId:scope.serverId,datasetId:scope.datasetId,key:new Uint8Array(32).fill(1),privateProviderDiagnostics:true},signal());
    held.push(...calls.map((call,index)=>rpc.request(call,controllers[index]!.signal)));await entered.promise;
    const full={...base(),action:'dispatch' as const,operation:'getNeteaseDailyRecommendations' as const,scope,request:request('getNeteaseDailyRecommendations')};
    const refused=await rpc.request(full,signal());assert.ok('kind' in refused&&refused.kind==='error');assert.equal(refused.code,'BUSY');assert.equal(count,15);
    const sha=mobileCapabilityRequestSha('content',full.id);
    assert.ok(snapshotMobileCapabilityTrace().firstBusinessFailures.some(row=>row.requestSha256===sha&&row.stage==='core.dispatch.admission.active-full'));
    controllers[0]!.abort();await held[0];let finished=false;
    cancel=rpc.request({...base(),action:'cancel',requestId:calls[0]!.id,snapshotId:null,scope},signal()).then(reply=>{finished=true;return reply;});
    for(let index=0;index<40;index++)await Promise.resolve();assert.equal(finished,false);
    const stillFull=await rpc.request({...full,id:randomUUID()},signal());assert.ok('kind' in stillFull&&stillFull.kind==='error');assert.equal(stillFull.code,'BUSY');assert.equal(count,15);
    gate.resolve();const quiet=await cancel;assert.ok(quiet.action==='cancel'&&quiet.kind==='cancelled');assert.equal(quiet.quiet,true);
  }finally{gate.resolve();await Promise.allSettled(held);if(cancel)await cancel;await rpc.close();}
});
