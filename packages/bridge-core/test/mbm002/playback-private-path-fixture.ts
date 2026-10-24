import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import * as playback from '../../src/mobile/playback-service.js';
import { createMobileAuthCrypto } from '../../src/mobile/auth-crypto.js';
import { decodePlaybackStorage, encodePlaybackStorage } from '../../src/mobile/playback-state-codec.js';
import { MOBILE_PLAYBACK_DEFAULT_LIMITS, MobilePlaybackError, type MobilePlaybackAuthPort, type MobilePlaybackLimits, type MobilePlaybackPreparedSource,
  type MobilePlaybackReadComposition, type MobilePlaybackReadComposer, type MobilePlaybackServiceOptions, type MobilePlaybackSourcePort } from '../../src/mobile/playback-types.js';
import { MobileAuthPersistenceError, type MobilePrincipal, type MobileSealedState } from '../../src/mobile/types.js';
import type { PlaybackState } from '../../src/mobile/playback-state.js';
import { MOBILE_DSD_PCM_PROCESSING_REASON, type MobileDecodedRequest, type MobileReadyResource, type MobileSession } from '@music-bridge/contracts';

export const SERVER='server.private-read',DATASET='dataset.private-read',ORIGIN='https://127.0.0.1:9443';
export const principal:MobilePrincipal={serverId:SERVER,datasetId:DATASET,deviceId:'device.private-read',deviceEpoch:1,generation:1,
  accountDomain:`local:${DATASET}`,accessTokenHash:'a'.repeat(64),accessExpiresAt:'2030-01-01T00:00:00.000Z'};
export const gate=()=>{let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return{promise,resolve};};
export async function turns(count=12){for(let n=0;n<count;n++)await new Promise<void>(yes=>setImmediate(yes));}
const signal=()=>new AbortController().signal;
export function mediaRequest(resource:MobileReadyResource):MobileDecodedRequest<unknown>{const u=new URL(resource.media.url);
  return{path:u.pathname,pathParameters:{resourceId:resource.id,asset:'source'},query:{ticket:u.searchParams.get('ticket')!},body:null};}

/** 只使用合成账本、真实codec/密封和受控Main式端口；不读取媒体、账号或运行态。 */
export function privatePathFixture(t:TestContext,options:{composition?:'registered'|'bare'|'wrong-auth'|'wrong-source';
  sequence?:'normal'|'omit-before'|'omit-after'|'twice-before'|'after-first';dsd?:boolean;limits?:Partial<MobilePlaybackLimits>}={}){
  const crypto=createMobileAuthCrypto(new Uint8Array(32).fill(27)),verifyEntered=gate(),verifyReleased=gate(),readEntered=gate(),readReleased=gate(),authEntered=gate(),authReleased=gate(),saveEntered=gate(),saveReleased=gate();
  let stored:MobileSealedState={kind:'missing',datasetId:DATASET,revision:0},holdVerify=false,holdRead=false,holdAuthAt=0,holdSave=false,revoked=false;
  let fault:'none'|'unknown'|'conflict'='none',verificationFailure:'none'|'verify'|'renew'='none',authCalls=0,prepares=0,renews=0,sourceBefore=0,sourceAfter=0;
  const data=Uint8Array.from({length:262144},(_,n)=>n%251),saved:PlaybackState[]=[],reads:{readId:string;start:number;maxBytes:number}[]=[],events:string[]=[];
  const handles=new Set<string>(),verifications=new Set<Promise<void>>();let capturedBoundary:Parameters<MobilePlaybackReadComposer>[1]|undefined;
  const auth:MobilePlaybackAuthPort={async assertDeviceCurrent(device,epoch){assert.equal(device,principal.deviceId);assert.equal(epoch,principal.deviceEpoch);authCalls++;events.push('auth');
    if(holdAuthAt===authCalls){holdAuthAt=0;authEntered.resolve();await authReleased.promise;}if(revoked)throw new Error('合成撤销');}};
  const rawRead:MobilePlaybackSourcePort['read']=async(handle,readId,start,maxBytes,abort)=>{assert.ok(handles.has(handle));assert.ok(maxBytes>0&&maxBytes<=65536);
    sourceBefore++;events.push('source.before');reads.push({readId,start,maxBytes});if(holdRead){holdRead=false;readEntered.resolve();await readReleased.promise;}
    abort.throwIfAborted();sourceAfter++;events.push('source.after');return data.slice(start,start+maxBytes);};
  const source:MobilePlaybackSourcePort={async capabilities(){return{resourceDsdToPcm:options.dsd===true};},async prepare(request){prepares++;const audio={codec:'flac',container:'flac',sampleRateHz:48000,bitsPerSample:24,channels:2};
    const value:MobilePlaybackPreparedSource={handle:`handle.${request.resourceId}`,sourceAudio:options.dsd?{codec:'dsd',container:'dsf',sampleRateHz:2822400,bitsPerSample:1,channels:2}:audio,
      actualAudio:{...audio},processing:options.dsd?{mode:'dsd_to_pcm',reason:MOBILE_DSD_PCM_PROCESSING_REASON,fromPreparedCache:true}:{mode:'direct',reason:'合成原字节',fromPreparedCache:false},
      contentType:'audio/flac',size:data.length,durationMs:4000,seekable:true};handles.add(value.handle);return value;},
    async verify(handle){assert.ok(handles.has(handle));const work=(async()=>{await auth.assertDeviceCurrent(principal.deviceId,principal.deviceEpoch);
      if(holdVerify){holdVerify=false;verifyEntered.resolve();await verifyReleased.promise;}
      if(verificationFailure==='verify'){verificationFailure='none';throw new MobilePlaybackError(409,'SOURCE_CHANGED');}
      await auth.assertDeviceCurrent(principal.deviceId,principal.deviceEpoch);})();verifications.add(work);try{await work;}finally{verifications.delete(work);}},async renew(){renews++;
      if(verificationFailure==='renew'){verificationFailure='none';throw new MobilePlaybackError(409,'SOURCE_CHANGED');}},
    async read(handle,readId,start,maxBytes,abort){await auth.assertDeviceCurrent(principal.deviceId,principal.deviceEpoch);const bytes=await rawRead(handle,readId,start,maxBytes,abort);
      await auth.assertDeviceCurrent(principal.deviceId,principal.deviceEpoch);return bytes;},async closeRead(){},async release(handle){await Promise.allSettled([...verifications]);handles.delete(handle);}};
  const compose:MobilePlaybackReadComposer=async(request,boundary)=>{capturedBoundary=boundary;assert.equal(request.deviceId,principal.deviceId);assert.equal(request.deviceEpoch,principal.deviceEpoch);
    if(options.sequence==='after-first')await boundary.after();
    if(options.sequence!=='omit-before')await boundary.before();if(options.sequence==='twice-before')await boundary.before();
    const bytes=await rawRead(request.handle,request.readId,request.start,request.maxBytes,request.signal);if(options.sequence!=='omit-after')await boundary.after();return bytes;};
  // 旧实现缺少工厂时仍真实走原读路径，RED断言落在次数与字节行为，不以缺API为失败。
  const factory=(playback as typeof playback&{createMobilePlaybackReadComposition?:(auth:MobilePlaybackAuthPort,source:MobilePlaybackSourcePort,read:MobilePlaybackReadComposer)=>MobilePlaybackReadComposition}).createMobilePlaybackReadComposition;
  const mode=options.composition??'registered';const readComposition=mode==='bare'||!factory?{} as MobilePlaybackReadComposition
    :factory(mode==='wrong-auth'?{async assertDeviceCurrent(){throw new Error('错误auth不应调用');}}:auth,mode==='wrong-source'?{...source}:source,compose);
  const serviceOptions:MobilePlaybackServiceOptions={serverId:SERVER,datasetId:DATASET,responseOrigin:ORIGIN,auth,crypto,sourcePort:source,readComposition,nowMs:()=>Date.parse('2026-10-21T00:00:00Z'),
    stateCodec:{async encode(state,c){return encodePlaybackStorage(state,SERVER,DATASET,ORIGIN,c.limits,c.terminalFailureBudget);},async decode(bytes,c){return decodePlaybackStorage(bytes,SERVER,DATASET,ORIGIN,c.limits);},async close(){}},
    persistence:{async load(){return structuredClone(stored);},async save(request){const mode=fault;fault='none';if(holdSave){holdSave=false;saveEntered.resolve();await saveReleased.promise;}
      if(mode==='conflict')return{kind:'conflict',datasetId:DATASET,currentRevision:request.expectedRevision+1};
      assert.equal(request.expectedRevision,stored.revision);const plain=crypto.open(request.sealed,Buffer.from(JSON.stringify(['MBM002_PLAYBACK_STATE_V1',SERVER,DATASET,request.expectedRevision+1])));
      saved.push(decodePlaybackStorage(plain,SERVER,DATASET,ORIGIN,{...MOBILE_PLAYBACK_DEFAULT_LIMITS,...options.limits}).state);plain.fill(0);
      stored={kind:'sealed',datasetId:DATASET,revision:request.expectedRevision+1,commitId:request.commitId,sealed:new Uint8Array(request.sealed)};
      if(mode==='unknown')throw new MobileAuthPersistenceError('unknown');return{kind:'saved',datasetId:DATASET,revision:stored.revision,commitId:stored.commitId};}},...(options.limits?{limits:options.limits}:{})};
  const service=playback.createMobilePlaybackService(serviceOptions);t.after(async()=>{verifyReleased.resolve();readReleased.resolve();authReleased.resolve();saveReleased.resolve();await service.close();assert.equal(handles.size,0);});
  const sessionRequest={path:'/mobile/v1/sessions',pathParameters:{},query:{},body:{clientInstanceId:'client.private'},idempotencyKey:'session.private'};
  const makeResource=(sessionId:string)=>({path:`/mobile/v1/sessions/${sessionId}/resources`,pathParameters:{sessionId},query:{},idempotencyKey:'resource.private',body:{trackId:'track.private',versionId:'version.private',contentRevision:'revision.private',
    quality:{profile:options.dsd?'auto':'lossless',allowLossyFallback:false,preferredTransport:'file'},formats:[{codec:'flac',container:'flac',maxSampleRateHz:48000,maxBitsPerSample:24,maxChannels:2}],...(options.dsd?{acceptedProcessingModes:['dsd_to_pcm']}: {})}});
  return{service,data,saved,reads,events,verifyEntered,verifyReleased,readEntered,readReleased,authEntered,authReleased,saveEntered,saveReleased,auth:()=>authCalls,prepares:()=>prepares,renews:()=>renews,watermarks:()=>[sourceBefore,sourceAfter],
    reset(){authCalls=0;events.length=0;},holdVerify(){holdVerify=true;},failVerification(stage:typeof verificationFailure){verificationFailure=stage;},holdRead(){holdRead=true;},holdAuth(n=1){holdAuthAt=authCalls+n;},holdSave(mode:typeof fault='none'){fault=mode;holdSave=true;},revoke(){revoked=true;},
    boundary:()=>capturedBoundary,async session(){return(await service.control('createSession',sessionRequest,principal,signal())).body as MobileSession;},
    resource(sessionId:string){return service.control('createResource',makeResource(sessionId),principal,signal());},
    async ready(){const session=await this.session(),reply=await this.resource(session.id);assert.equal(reply.status,201);return{session,resource:reply.body as MobileReadyResource};}};
}
