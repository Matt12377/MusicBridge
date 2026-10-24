import assert from 'node:assert/strict';
import test,{after,type TestContext} from 'node:test';
import threads,{type WorkerOptions} from 'node:worker_threads';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { MobileContentScope } from '../../../../packages/bridge-core/src/mobile/content-types.js';
import { MobileServiceError,type MobileAuthService,type MobileOwnerPrivateResult,type MobilePrincipal,type MobileSealedState } from '../../../../packages/bridge-core/src/mobile/types.js';
import type { MobileOwnerSourceRequest,MobileOwnerSourceResult } from '../../../../packages/bridge-core/src/mobile/source-protocol.js';
import type { createMainMobileContentPort } from '../../src/main/mobile-content-port.js';
import { captureCodecContext } from '../../src/main/mobile-playback-state-codec-protocol.js';
import { MOBILE_PLAYBACK_DEFAULT_LIMITS } from '../../../../packages/bridge-core/src/mobile/playback-types.js';

const entry=process.env.MUSIC_BRIDGE_PLAYBACK_CODEC_TEST_ENTRY;assert.ok(typeof entry==='string'&&entry.startsWith('/Volumes/LifeWeave/'));
const baseline=process.env.MUSIC_BRIDGE_PLAYBACK_MAIN_BASELINE;
if(baseline)assert.ok(baseline.includes('/mac33-source/apps/desktop/src/main/mobile-playback-backend.ts'));
let observeJob:((operation:string)=>void)|undefined;
const OriginalWorker=threads.Worker;let started=0,exited=0;const exitCodes:number[]=[];
// 仅测试把src工厂的缺省URL绑定Root构建entry；其资源上限、execArgv、env、协议及真实线程不变。
class EntryWorker extends OriginalWorker{
  constructor(filename:string|URL,options?:WorkerOptions){
    if(filename instanceof URL&&filename.pathname.endsWith('/src/main/mobile-playback-state-worker-entry.js')){
      assert.deepEqual(options?.resourceLimits,{maxOldGenerationSizeMb:512,maxYoungGenerationSizeMb:64,stackSizeMb:4});
      super(pathToFileURL(entry!),options);started++;this.once('exit',code=>{exited++;exitCodes.push(code);});
    }else super(filename,options);
  }
  override postMessage(value:unknown,transfer?:readonly import('node:worker_threads').TransferListItem[]){
    if(value&&typeof value==='object'&&'kind'in value&&value.kind==='job'&&'operation'in value)observeJob?.(String(value.operation));
    super.postMessage(value,transfer);
  }
}
const mutable=threads as unknown as {Worker:typeof OriginalWorker};mutable.Worker=EntryWorker;syncBuiltinESMExports();
after(()=>{mutable.Worker=OriginalWorker;syncBuiltinESMExports();assert.equal(started,exited);assert.ok(started>0);assert.ok(exitCodes.every(code=>code===0));});
const {createMobilePlaybackBackend}=await import(baseline?pathToFileURL(baseline).href:new URL('../../src/main/mobile-playback-backend.js',import.meta.url).href) as typeof import('../../src/main/mobile-playback-backend.js');
const SERVER='server.activity-main',DATASET='dataset.composed-main',ORIGIN='https://127.0.0.1:9443';
const principal:MobilePrincipal={serverId:SERVER,datasetId:DATASET,deviceId:'device.composed-main',deviceEpoch:1,generation:1,
  accountDomain:`local:${DATASET}`,accessTokenHash:'a'.repeat(64),accessExpiresAt:'2030-01-01T00:00:00Z'};
const gate=()=>{let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return{promise,resolve};};
async function turns(){for(let n=0;n<12;n++)await new Promise<void>(yes=>setImmediate(yes));}
function fixture(t:TestContext,source:'local'|'netease'='local'){
  let stored:MobileSealedState={kind:'missing',datasetId:DATASET,revision:0},authCalls=0,revoked=false,holdRead=false,changed=false;
  let holdBegin=false,holdSave=false,holdEnd=false,denyBegin=false;
  const activityEpoch='11111111-1111-4111-8111-111111111111',activityLease='22222222-2222-4222-8222-222222222222';
  const activity=new Set<string>(),activityCalls:string[]=[],candidates:{operation:string;active:number}[]=[],saveActivity:number[]=[];
  observeJob=operation=>candidates.push({operation,active:activity.size});t.after(()=>{observeJob=undefined;});
  const entered=gate(),released=gate(),data=Uint8Array.from({length:262144},(_,n)=>n%251),reads:Extract<MobileOwnerSourceRequest,{operation:'read'}>[]=[],watermarks:number[]=[0,0];
  const scope:Readonly<MobileContentScope>=Object.freeze({serverId:SERVER,datasetId:DATASET,deviceId:principal.deviceId,deviceEpoch:1,accessGeneration:1,
    ownerEpoch:'owner.composed-main',accountDomain:source==='local'?principal.accountDomain:'netease:synthetic',providerEpoch:source==='local'?null:'provider.composed-main'});
  const auth={async authenticate(){return{...principal};},async assertCurrent(p:MobilePrincipal){assert.equal(p.deviceId,principal.deviceId);if(revoked)throw new MobileServiceError(403,'DEVICE_REVOKED');},
    async assertDeviceCurrent(id:string,epoch:number){authCalls++;assert.equal(id,principal.deviceId);assert.equal(epoch,1);if(revoked)throw new MobileServiceError(403,'DEVICE_REVOKED');}} as unknown as MobileAuthService;
  const content={async scopeForIdentity(){return{scope,neteasePlayback:source==='netease'};},async source(actual:Readonly<MobileContentScope>,request:MobileOwnerSourceRequest,signal:AbortSignal){
    assert.deepEqual(actual,scope);let result:MobileOwnerSourceResult;
    if(request.operation==='prepare'){const audio={codec:'flac',container:'flac',sampleRateHz:48000,bitsPerSample:24,channels:2};result={kind:'mobile-source-prepared',source:{
      handle:request.selection.resourceId,sourceAudio:audio,actualAudio:{...audio},processing:{mode:'direct',reason:'合成原字节',fromPreparedCache:false},contentType:'audio/flac',size:data.length,durationMs:4000,seekable:true}};}
    else if(request.operation==='read'){watermarks[0]!++;if(changed)throw new MobileServiceError(409,'SOURCE_CHANGED');reads.push(structuredClone(request));
      if(holdRead){holdRead=false;entered.resolve();await released.promise;}signal.throwIfAborted();watermarks[1]!++;if(changed)throw new MobileServiceError(409,'SOURCE_CHANGED');
      result={kind:'mobile-source-read',handle:request.handle,readId:request.readId,start:request.start,bytes:data.slice(request.start,request.start+request.maxBytes)};}
    else if(request.operation==='capabilities')result={kind:'mobile-source-capabilities',resourceDsdToPcm:false};
    else if(request.operation==='status')throw new Error('本例没有DSD准备');
    else result={kind:'mobile-source-ack',operation:request.operation,handle:request.handle,readId:request.operation==='close-read'?request.readId:null,quiet:true};
    return{source,result};}} as unknown as ReturnType<typeof createMainMobileContentPort>;
  const handle=createMobilePlaybackBackend({serverId:SERVER,datasetId:DATASET,authKey:new Uint8Array(32).fill(27),auth,contentPort:content,assertCurrent(){},
    async requestOwner(request):Promise<MobileOwnerPrivateResult>{assert.equal(request.datasetId,DATASET);
      if(request.kind==='playback-activity'){
        activityCalls.push(request.request.operation);
        if(request.request.operation==='begin'){
          if(holdBegin){holdBegin=false;entered.resolve();await released.promise;}
          if(denyBegin)throw new Error('合成RAM提示不可用');
          activity.add(activityLease);return{kind:'playback-activity',datasetId:DATASET,ownerEpoch:activityEpoch,operation:'begin',leaseId:activityLease};}
        assert.equal(request.request.ownerEpoch,activityEpoch);assert.equal(request.request.leaseId,activityLease);activity.delete(activityLease);
        if(holdEnd){holdEnd=false;entered.resolve();await released.promise;}
        return{kind:'playback-activity',datasetId:DATASET,ownerEpoch:activityEpoch,operation:'end',leaseId:activityLease};
      }
      if(request.kind==='playback-load')return structuredClone(stored);
      assert.equal(request.kind,'playback-save');if(request.kind!=='playback-save')throw new Error('无关Owner操作');assert.equal(request.request.expectedRevision,stored.revision);
      saveActivity.push(activity.size);if(holdSave){holdSave=false;entered.resolve();await released.promise;}
      stored={kind:'sealed',datasetId:DATASET,revision:stored.revision+1,commitId:request.request.commitId,sealed:new Uint8Array(request.request.sealed)};
      return{kind:'saved',datasetId:DATASET,revision:stored.revision,commitId:stored.commitId};}});
  handle.activate(ORIGIN);t.after(async()=>{released.resolve();await handle.close();});
  const control=async(operation:'createSession'|'createResource',request:Parameters<typeof handle.backend.dispatch>[0]['request'],signal=new AbortController().signal)=>{
    const reply=await handle.backend.dispatch({operation,request,accessToken:'synthetic',origin:ORIGIN,signal,headers:[]});assert.equal(reply.kind,'buffered');
    if(reply.kind!=='buffered')throw new Error('控制必须返回有限正文');assert.equal(reply.status,201);return JSON.parse(Buffer.from(reply.body).toString('utf8')) as {id:string;media?:{url:string}};};
  return{handle,activity,activityCalls,candidates,saveActivity,
    session:(signal?:AbortSignal)=>control('createSession',{path:'/mobile/v1/sessions',pathParameters:{},query:{},body:{clientInstanceId:'main.activity'},idempotencyKey:'activity.session'},signal),
    holdBegin(){holdBegin=true;},holdSave(){holdSave=true;},holdEnd(){holdEnd=true;},denyBegin(){denyBegin=true;},revision:()=>stored.revision,
    auth:()=>authCalls,reset(){authCalls=0;},data,reads,watermarks,entered,released,hold(){holdRead=true;},revoke(){revoked=true;},change(){changed=true;},
    async media(){const s=await control('createSession',{path:'/mobile/v1/sessions',pathParameters:{},query:{},body:{clientInstanceId:'main.composed'},idempotencyKey:'main.session'});
      const r=await control('createResource',{path:`/mobile/v1/sessions/${s.id}/resources`,pathParameters:{sessionId:s.id},query:{},idempotencyKey:'main.resource',body:{trackId:'track.main',versionId:'version.main',contentRevision:'revision.main',
        quality:{profile:'lossless',allowLossyFallback:false,preferredTransport:'file'},formats:[{codec:'flac',container:'flac',maxSampleRateHz:48000,maxBitsPerSample:24,maxChannels:2}]}});
      assert.ok(r.media);const url=new URL(r.media.url);authCalls=0;const reply=await handle.backend.dispatch({operation:'getMediaAsset',request:{path:url.pathname,pathParameters:{resourceId:r.id,asset:'source'},query:{ticket:url.searchParams.get('ticket')!},body:null},
        accessToken:null,origin:ORIGIN,signal:new AbortController().signal,headers:[['Range','bytes=0-262143']]});assert.equal(reply.kind,'media');if(reply.kind!=='media')throw new Error('媒体必须流式');return reply;}};
}
test('Main控制活动覆盖真实Worker候选和Owner ACK，返回后只归还调度提示',async t=>{
  const f=fixture(t);await f.session();await turns();
  assert.deepEqual(f.activityCalls,['begin','end'],'真实控制必须先持Owner活动，候选/ACK后归还');
  assert.ok(f.candidates.length>0);assert.ok(f.candidates.every(v=>v.active===1));assert.deepEqual(f.saveActivity,[1]);assert.equal(f.activity.size,0);
});
test('真实resource的UNKNOWN与ready双候选/双ACK全被活动覆盖，媒体仍17次freshAuth/四片双水位',async t=>{
  const f=fixture(t),media=await f.media();await turns();
  assert.deepEqual(f.activityCalls,['begin','end','begin','end']);assert.deepEqual(f.saveActivity,[1,1,1]);
  assert.ok(f.candidates.some(v=>v.operation==='derive-patch'));assert.ok(f.candidates.every(v=>v.active===1));assert.equal(f.activity.size,0);
  await media.beforeSend();const blocks:Uint8Array[]=[];
  for(let n=0;n<4;n++){const block=await media.reader.read(65536,new AbortController().signal);assert.ok(block);blocks.push(block);await media.beforeSend();}
  assert.deepEqual(Buffer.concat(blocks),Buffer.from(f.data));assert.equal(f.auth(),17);assert.deepEqual(f.watermarks,[4,4]);await media.reader.close();
});
test('取消在Owner ACK仍未返回时归还RAM活动，原durable提交继续且不放行取消请求',async t=>{
  const f=fixture(t),controller=new AbortController();f.holdSave();
  const pending=f.session(controller.signal),rejected=assert.rejects(pending);await f.entered.promise;
  assert.equal(f.activity.size,1);assert.equal(f.revision(),0);controller.abort();await turns();
  assert.equal(f.activity.size,0);assert.deepEqual(f.activityCalls,['begin','end']);
  f.released.resolve();await rejected;assert.equal(f.revision(),1,'调度取消不能取消或重排已发送的Owner持久提交');
});
test('begin的迟到ACK遇取消/关闭立即按原Owner代次归还，不启动已取消业务',async t=>{
  for(const phase of ['abort','close']as const)await t.test(phase,async child=>{
    const f=fixture(child),controller=new AbortController();await turns();f.holdBegin();
    const pending=f.session(controller.signal),rejected=assert.rejects(pending);await f.entered.promise;
    if(phase==='abort')controller.abort();else await f.handle.close();
    await rejected;assert.equal(f.revision(),0);f.released.resolve();await turns();
    assert.deepEqual(f.activityCalls,['begin','end']);assert.equal(f.activity.size,0);assert.equal(f.candidates.length,0);
  });
});
test('授权撤销抛错也归还活动；RAM提示失败仍沿原freshAuth和Owner提交，不改业务结果',async t=>{
  for(const phase of ['revoke','hint']as const)await t.test(phase,async child=>{
    const f=fixture(child);
    if(phase==='revoke'){f.revoke();await assert.rejects(f.session());await turns();assert.deepEqual(f.activityCalls,['begin','end']);assert.equal(f.revision(),0);}
    else{f.denyBegin();await f.session();assert.equal(f.revision(),1);assert.deepEqual(f.saveActivity,[0]);}
    assert.equal(f.activity.size,0);
  });
});
test('RAM归还ACK迟到不延后已完成业务发布，Main close仍让真实Worker自然退出',async t=>{
  const f=fixture(t);f.holdEnd();const session=await f.session();await f.entered.promise;
  assert.ok(session.id);assert.equal(f.revision(),1);assert.equal(f.activity.size,0);
  f.released.resolve();await turns();await f.handle.close();
});
test('begin ACK失联只等待私有提示窗口，业务仍原样提交；结束后迟到租约立即归还',async t=>{
  const f=fixture(t);await turns();f.holdBegin();
  const pending=f.session();await f.entered.promise;const session=await pending;
  assert.ok(session.id);assert.equal(f.revision(),1);assert.deepEqual(f.saveActivity,[0]);assert.equal(f.activity.size,0);
  f.released.resolve();await turns();assert.deepEqual(f.activityCalls,['begin','end']);assert.equal(f.activity.size,0);
});
