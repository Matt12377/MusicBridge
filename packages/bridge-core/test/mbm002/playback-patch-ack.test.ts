import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import { randomBytes } from 'node:crypto';
import { createMobilePlaybackService } from '../../src/mobile/playback-service.js';
import { createMobileAuthCrypto } from '../../src/mobile/auth-crypto.js';
import { createPlaybackStorageActor,playbackStoragePatchReply,decodePlaybackStorage,type IncrementalPlaybackStateCodecPort } from '../../src/mobile/playback-state-codec.js';
import { MOBILE_PLAYBACK_DEFAULT_LIMITS as limits,MobilePlaybackError,type MobilePlaybackSourcePort } from '../../src/mobile/playback-types.js';
import { MobileAuthPersistenceError,type MobileSealedState } from '../../src/mobile/types.js';
import type { PlaybackState } from '../../src/mobile/playback-state.js';
import type { MobileSession } from '@music-bridge/contracts';
import { capacityPrincipal,CAPACITY_SERVER as serverId,CAPACITY_DATASET as datasetId,CAPACITY_ORIGIN as responseOrigin,CAPACITY_NOW as NOW } from './playback-state-capacity-fixture.js';

const gate=()=>{let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return{promise,resolve};};
function fixture(t:TestContext){
  const actor=createPlaybackStorageActor(),crypto=createMobileAuthCrypto(randomBytes(32));let row:MobileSealedState={kind:'missing',datasetId,revision:0};
  const entered=gate(),released=gate();let hold=false;
  let full=0,small=0,saves=0,prepares=0,loads=0,auth=0,fault:'none'|'ready-unknown'='none',bad:'none'|'patch'|'previous'|'extra'|'getter'|'proxy'|'null'='none',getters=0;
  const saved:PlaybackState[]=[];
  const codec:IncrementalPlaybackStateCodecPort={async encode(s,c){full++;return actor.encode(s,c);},async decode(b,c){return actor.decode(b,c);},async close(){actor.close();},
    async derive(){throw new Error('生产小回包不应退回旧整树derive');},async derivePatch(base,patch,c){small++;const result=actor.derive(base,patch,c),reply=structuredClone(playbackStoragePatchReply(result,base,patch,c));
      const mode=bad;bad='none';if(mode==='patch')reply.patch.receipt.deviceEpoch++;if(mode==='previous')reply.previousBase.handle='other.scope.base';
      if(mode==='extra')Object.assign(reply.patch,{unexpected:true});if(mode==='getter')Object.defineProperty(reply.patch.receipt,'deviceEpoch',{enumerable:true,get(){getters++;return 1;}});
      if(hold){hold=false;entered.resolve();await released.promise;}
      if(mode==='proxy')return new Proxy(reply,{getPrototypeOf(target){getters++;return Reflect.getPrototypeOf(target);}});
      if(mode==='null')return null as unknown as typeof reply;
      return reply;}};
  const source:MobilePlaybackSourcePort={async prepare(r){prepares++;const a={codec:'flac',container:'flac',sampleRateHz:44100,bitsPerSample:16,channels:2};
    return{handle:r.resourceId,sourceAudio:a,actualAudio:{...a},processing:{mode:'direct',reason:'合成原字节',fromPreparedCache:false},contentType:'audio/flac',size:20000,durationMs:4000,seekable:true};},async verify(){},async renew(){},async read(){return new Uint8Array();},async closeRead(){},async release(){}};
  const service=createMobilePlaybackService({serverId,datasetId,responseOrigin,crypto,sourcePort:source,stateCodec:codec,nowMs:()=>NOW,
    auth:{async assertDeviceCurrent(){auth++;}},persistence:{async load(){loads++;return structuredClone(row);},async save(request){saves++;
      assert.equal(request.expectedRevision,row.revision);const plain=crypto.open(request.sealed,Buffer.from(JSON.stringify(['MBM002_PLAYBACK_STATE_V1',serverId,datasetId,request.expectedRevision+1])));
      const state=decodePlaybackStorage(plain,serverId,datasetId,responseOrigin,limits).state;plain.fill(0);saved.push(state);
      row={kind:'sealed',datasetId,revision:request.expectedRevision+1,commitId:request.commitId,sealed:new Uint8Array(request.sealed)};
      if(fault==='ready-unknown'&&state.resources.some(r=>r.state==='ready')){fault='none';throw new MobileAuthPersistenceError('unknown');}
      return{kind:'saved',datasetId,revision:row.revision,commitId:row.commitId};}}});
  t.after(async()=>{released.resolve();await service.close();});return{service,saved,entered,released,hold(){hold=true;},full:()=>full,small:()=>small,saves:()=>saves,prepares:()=>prepares,loads:()=>loads,auth:()=>auth,getters:()=>getters,bad(mode:typeof bad){bad=mode;},unknown(){fault='ready-unknown';}};
}
const sessionRequest={path:'/mobile/v1/sessions',pathParameters:{},query:{},body:{clientInstanceId:'patch.synthetic'},idempotencyKey:'patch.session'};
async function start(f:ReturnType<typeof fixture>){const reply=await f.service.control('createSession',sessionRequest,capacityPrincipal(),new AbortController().signal),s=reply.body as MobileSession;
  return{path:`/mobile/v1/sessions/${s.id}/resources`,pathParameters:{sessionId:s.id},query:{},idempotencyKey:'patch.resource',body:{trackId:'track.synthetic',versionId:'version.synthetic',contentRevision:'revision.synthetic',
    quality:{profile:'lossless',allowLossyFallback:false,preferredTransport:'file'},formats:[{codec:'flac',container:'flac',maxSampleRateHz:44100,maxChannels:2,maxBitsPerSample:16}]}};}
test('小回包ACK：Main只从自己已ACK冻结mirror重建，UNKNOWN和ready逐次真实保存，原键不重准备',async t=>{
  const f=fixture(t),request=await start(f),reply=await f.service.control('createResource',request,capacityPrincipal(),new AbortController().signal);
  assert.equal(reply.status,201);assert.equal(f.full(),1);assert.equal(f.small(),2);assert.equal(f.saves(),3);assert.equal(f.prepares(),1);
  assert.equal(f.saved[1]!.receipts.at(-1)!.state,'UNKNOWN');assert.equal(f.saved[2]!.receipts.at(-1)!.reply!.status,201);
  assert.deepEqual(f.saved[2]!.receipts[0],f.saved[0]!.receipts[0]);const auth=f.auth();await reply.beforeSend();assert.ok(f.auth()>auth);
  await f.service.control('createResource',request,capacityPrincipal(),new AbortController().signal);assert.equal(f.saves(),3);assert.equal(f.prepares(),1);
});
test('小回包ACK：ready提交已落盘但ACK丢失，只精确重读恢复原201，不能重保存/准备',async t=>{
  const f=fixture(t),request=await start(f);f.unknown();await assert.rejects(f.service.control('createResource',request,capacityPrincipal(),new AbortController().signal));
  const saves=f.saves(),loads=f.loads();const reply=await f.service.control('createResource',request,capacityPrincipal(),new AbortController().signal);
  assert.equal(reply.status,201);assert.equal(f.saves(),saves);assert.equal(f.loads(),loads+1);assert.equal(f.prepares(),1);await reply.beforeSend();
});
test('小回包ACK：错scope/坏patch/额外字段/getter/proxy/null均不得发Owner或触发prepare，原session回执保持',async t=>{
  for(const mode of ['patch','previous','extra','getter','proxy','null']as const)await t.test(mode,async child=>{const f=fixture(child),request=await start(f);f.bad(mode);
    await assert.rejects(f.service.control('createResource',request,capacityPrincipal(),new AbortController().signal),e=>e instanceof MobilePlaybackError&&e.code==='BUSY');
    assert.equal(f.saves(),1);assert.equal(f.prepares(),0);assert.equal(f.getters(),0);const replay=await f.service.control('createSession',sessionRequest,capacityPrincipal(),new AbortController().signal);
    assert.equal((replay.body as MobileSession).id,request.pathParameters.sessionId);});
});
test('小回包fence：已计算未发Owner时撤销或close，迟到结果不能持久化或准备来源',async t=>{
  for(const action of ['revoke','close']as const)await t.test(action,async child=>{const f=fixture(child),request=await start(f);f.hold();
    const flight=f.service.control('createResource',request,capacityPrincipal(),new AbortController().signal),rejected=assert.rejects(flight);await f.entered.promise;
    const terminal=action==='revoke'?f.service.revokeDevice(capacityPrincipal().deviceId):f.service.close();f.released.resolve();await rejected;await terminal;
    assert.equal(f.saves(),action==='revoke'?2:1);assert.equal(f.prepares(),0);assert.equal(f.service.resourceSnapshot().pendingPersistence,false);
  });
});
