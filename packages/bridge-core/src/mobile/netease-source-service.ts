import { randomUUID } from 'node:crypto';
import { mobileCanonicalJson, mobileCatalogResponseSnapshot, mobileDataSnapshot, mobileInteger, mobileRecord, mobileTrackSelectionEquals } from '@music-bridge/contracts';
import type { MobileTrack, MobileTrackSelection } from '@music-bridge/contracts';
import { captureMobileNeteaseSelection } from './netease-catalog-service.js';
import { readMobileNeteaseAudioFacts } from './netease-audio-facts.js';
import { isMobileOwnerSourceRequest } from './source-protocol.js';
import { assertMobileNeteaseAccount, captureMobileNeteaseAccount, captureMobileNeteaseScope, mobileNeteaseId, MOBILE_NETEASE_DURATION_TOLERANCE_MS } from './netease-source-types.js';
import type { MobileNeteaseAccountPort, MobileNeteaseCatalogResolver, MobileNeteaseFence, MobileNeteaseScope, MobileNeteaseSourceLimits, MobileNeteaseSourceService, MobileNeteaseStreamLease, MobileNeteaseStreamPort } from './netease-source-types.js';
import type { MobilePlaybackPreparedSource, MobilePlaybackSourceRequest } from './source-types.js';
import { MobilePlaybackError, type MobilePlaybackErrorCode } from './playback-types.js';
import { MobileServiceError } from './types.js';

const defaults: Readonly<MobileNeteaseSourceLimits> = Object.freeze({liveResources:8,storedResources:2048,readers:32,resourceReaders:4,readIds:4096,
  prepareMs:10000,readMs:5000,releaseMs:10000,leaseMs:300000,maxLifetimeMs:43200000});
const leaseKeys = ['account','selection','sourceIdentity','size','expiresAtMs','rangeSupported','verify','renew','read','closeRead','release'] as const;
const methods = ['verify','renew','read','closeRead','release'] as const;
type LeaseFunctions = Pick<MobileNeteaseStreamLease, typeof methods[number]>;
interface LeaseBinding { metadata: string; expiresAtMs: number; functions: Readonly<LeaseFunctions>; size: number }
interface Reader { id:string;controller:AbortController;offset:number|null;pending:Promise<Uint8Array>|null;closed:boolean;closing:Promise<void>|null }
interface Resource {
  id:string;scope:MobileNeteaseScope;selection:Readonly<MobileTrackSelection>|null;fingerprint:string|null;
  state:'preparing'|'active'|'releasing'|'released';failure:MobilePlaybackError|null;quietFailure:MobilePlaybackError|null;controller:AbortController;
  created:number;expires:number;lease:MobileNeteaseStreamLease|null;cleanup:MobileNeteaseStreamLease['release']|null;binding:LeaseBinding|null;prepared:MobilePlaybackPreparedSource|null;
  preparation:Promise<MobilePlaybackPreparedSource>|null;closing:Promise<void>|null;readers:Map<string,Reader>;ops:Set<Promise<unknown>>;
}
const fail = (status:MobilePlaybackError['status'],code:MobilePlaybackErrorCode):never => {
  throw new MobilePlaybackError(status,code,code==='RESOURCE_BUSY'||code==='BUSY',code==='RESOURCE_BUSY'||code==='BUSY'?1000:undefined);
};
function sameOwner(a:MobileNeteaseScope,b:MobileNeteaseScope):boolean {
  return ['serverId','datasetId','deviceId','deviceEpoch','ownerEpoch','accountDomain','providerEpoch'].every(k=>a[k as keyof MobileNeteaseScope]===b[k as keyof MobileNeteaseScope]);
}
function asError(e:unknown):MobilePlaybackError {
  if(e instanceof MobilePlaybackError)return e;
  if(e instanceof MobileServiceError){const code=e.code;
    if(code==='CONTENT_LIMIT_EXCEEDED'||code==='CURSOR_INVALID')return new MobilePlaybackError(503,'BUSY',true,1000);
    return new MobilePlaybackError(e.status===413?503:e.status,code,e.retryable,e.retryAfterMs);
  }
  return new MobilePlaybackError(503,'BUSY',true,1000);
}
function exactBytes(raw:unknown,n:number):Uint8Array {
  if(!(raw instanceof Uint8Array)||![Uint8Array.prototype,Buffer.prototype].includes(Object.getPrototypeOf(raw))
    ||!(raw.buffer instanceof ArrayBuffer)||raw.byteLength!==n)return fail(409,'SOURCE_CHANGED');
  return new Uint8Array(raw);
}
function limits(raw:Partial<MobileNeteaseSourceLimits>|undefined):Readonly<MobileNeteaseSourceLimits> {
  const value={...defaults};if(raw){const c=mobileDataSnapshot(raw);if(!c.ok||!mobileRecord(c.value))return fail(400,'INVALID_REQUEST');
    for(const key of Reflect.ownKeys(c.value)){
      if(typeof key!=='string'||!Object.hasOwn(defaults,key))return fail(400,'INVALID_REQUEST');
      const k=key as keyof MobileNeteaseSourceLimits,n=c.value[k];
      if(!mobileInteger(n,1,defaults[k]))return fail(400,'INVALID_REQUEST');value[k]=n;
    }
  }return Object.freeze(value);
}
function frozen<T>(value:T):T {
  if(value&&typeof value==='object'){for(const child of Object.values(value))frozen(child);Object.freeze(value);}return value;
}
/** 可信流适配器的逻辑资源作者；不打开文件池，也不接触 Provider 凭据/URL。 */
export function createMobileNeteaseSourceService(options:{account:MobileNeteaseAccountPort;catalog:MobileNeteaseCatalogResolver;
  streams:MobileNeteaseStreamPort;assertCurrent:MobileNeteaseFence;isQualified?:()=>boolean;nowMs?:()=>number;limits?:Partial<MobileNeteaseSourceLimits>}):MobileNeteaseSourceService {
  const cap=limits(options.limits),now=options.nowMs??Date.now,records=new Map<string,Resource>(),readerOwners=new Map<string,Resource>();
  let closed=false,fatal=false,closing:Promise<void>|null=null;
  const qualified=():boolean=>!closed&&!fatal&&options.isQualified?.()===true;
  function clock(){const n=now();return mobileInteger(n)?n:fail(503,'BUSY');}
  function live(){let n=0;for(const r of records.values())if(r.state!=='released')n++;return n;}
  function requestValid(raw:unknown):boolean{return isMobileOwnerSourceRequest(raw);}
  function resource(scope:MobileNeteaseScope,id:string):Resource {
    if(!mobileNeteaseId(id)||!requestValid({operation:'verify',handle:id}))return fail(400,'INVALID_REQUEST');
    const r=records.get(id);if(!r||!sameOwner(scope,r.scope))return fail(404,'INVALID_REQUEST');return r;
  }
  function make(id:string,scope:MobileNeteaseScope,selection:Readonly<MobileTrackSelection>|null,fingerprint:string|null,state:Resource['state']):Resource {
    const time=clock(),r:Resource={id,scope,selection,fingerprint,state,failure:null,quietFailure:null,controller:new AbortController(),created:time,
      expires:time+cap.leaseMs,lease:null,cleanup:null,binding:null,prepared:null,preparation:null,closing:null,readers:new Map(),ops:new Set()};
    records.set(id,r);return r;
  }
  function local(r:Resource,preparing=false){
    if(r.failure)throw r.failure;
    if(r.state==='released'||r.state==='releasing'||r.controller.signal.aborted)return fail(410,'RESOURCE_RELEASED');
    if(!qualified())return fail(503,'BUSY');
    if(r.state!=='active'&&!(preparing&&r.state==='preparing'))return fail(410,'RESOURCE_RELEASED');
    if(clock()>=r.expires||clock()-r.created>=cap.maxLifetimeMs)return fail(410,'RESOURCE_EXPIRED');
  }
  async function scopeCurrent(scope:MobileNeteaseScope,stage:'acquire'|'lease',signal:AbortSignal){
    try{signal.throwIfAborted();await options.assertCurrent(scope,stage);signal.throwIfAborted();
      assertMobileNeteaseAccount(scope,await options.account.current(signal));signal.throwIfAborted();
      await options.assertCurrent(scope,stage);signal.throwIfAborted();
    }catch(e){throw asError(e);}
  }
  function leaseValues(lease:MobileNeteaseStreamLease):Record<typeof leaseKeys[number],unknown> {
    if(!lease||typeof lease!=='object')return fail(409,'SOURCE_CHANGED');const ds=Object.getOwnPropertyDescriptors(lease);
    if(!leaseKeys.every(k=>ds[k]&&Object.hasOwn(ds[k]!,'value')))return fail(409,'SOURCE_CHANGED');
    return Object.fromEntries(leaseKeys.map(k=>[k,ds[k]!.value])) as Record<typeof leaseKeys[number],unknown>;
  }
  function leaseMetadata(r:Resource,values:ReturnType<typeof leaseValues>):string {
    const account=captureMobileNeteaseAccount(values.account),selection=captureMobileNeteaseSelection(values.selection);
    assertMobileNeteaseAccount(r.scope,account);
    if(!r.selection||!mobileTrackSelectionEquals(r.selection,selection)||!mobileNeteaseId(values.sourceIdentity)
      ||!mobileInteger(values.size,1)||values.rangeSupported!==true)return fail(409,'SOURCE_CHANGED');
    return mobileCanonicalJson({account,selection,sourceIdentity:values.sourceIdentity,size:values.size,rangeSupported:true});
  }
  function checkLease(r:Resource,renewExpires?:number):void {
    if(!r.lease||!r.binding)return fail(409,'SOURCE_CHANGED');
    try{const values=leaseValues(r.lease);
      if(leaseMetadata(r,values)!==r.binding.metadata||!methods.every(k=>values[k]===r.binding!.functions[k])
        ||values.expiresAtMs!==r.binding.expiresAtMs&&(renewExpires===undefined||values.expiresAtMs!==renewExpires))return fail(409,'SOURCE_CHANGED');
      if(renewExpires!==undefined)r.binding.expiresAtMs=values.expiresAtMs as number;
    }catch(e){if(e instanceof MobilePlaybackError&&e.code==='SOURCE_CHANGED')throw e;return fail(409,'SOURCE_CHANGED');}
  }
  function captureLease(r:Resource,lease:MobileNeteaseStreamLease):void {
    const cleanup=lease&&typeof lease==='object'?Object.getOwnPropertyDescriptor(lease,'release'):undefined;
    if(!cleanup||!Object.hasOwn(cleanup,'value')||typeof cleanup.value!=='function')throw quietFailure(r,new MobilePlaybackError(503,'BUSY',true,1000));
    r.cleanup=cleanup.value as MobileNeteaseStreamLease['release'];
    const values=leaseValues(lease);
    if(!mobileInteger(values.expiresAtMs,clock()+1,clock()+cap.leaseMs)||!methods.every(k=>typeof values[k]==='function'))return fail(409,'SOURCE_CHANGED');
    if(values.rangeSupported!==true)return fail(409,'UNSUPPORTED_FORMAT');
    r.binding={metadata:leaseMetadata(r,values),expiresAtMs:values.expiresAtMs,size:values.size as number,
      functions:Object.freeze(Object.fromEntries(methods.map(k=>[k,values[k]])) as unknown as LeaseFunctions)};
    r.expires=Math.min(r.created+cap.maxLifetimeMs,values.expiresAtMs);
  }
  async function current(r:Resource,preparing=false){local(r,preparing);if(r.binding)checkLease(r);await scopeCurrent(r.scope,'lease',r.controller.signal);
    local(r,preparing);if(r.binding)checkLease(r);}
  function deadline<T>(task:Promise<T>,ms:number,controller:AbortController):Promise<T> {
    let timer:ReturnType<typeof setTimeout>|undefined,listener:(()=>void)|undefined;
    const refusal=new Promise<never>((_,reject)=>{listener=()=>reject(new MobilePlaybackError(410,'RESOURCE_RELEASED'));
      controller.signal.addEventListener('abort',listener,{once:true});if(controller.signal.aborted)listener();
      timer=setTimeout(()=>{reject(new MobilePlaybackError(503,'BUSY',true,1000));controller.abort();},ms);});
    return Promise.race([task,refusal]).finally(()=>{if(timer)clearTimeout(timer);if(listener)controller.signal.removeEventListener('abort',listener);});
  }
  async function operation<T>(r:Resource,run:()=>Promise<T>):Promise<T>{const p=run();r.ops.add(p);try{return await p;}finally{r.ops.delete(p);}}
  function bindAbort(signal:AbortSignal,controller:AbortController):()=>void {
    const abort=()=>controller.abort();signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();return()=>signal.removeEventListener('abort',abort);
  }
  function quietFailure(r:Resource,e:unknown):MobilePlaybackError{fatal=true;r.quietFailure??=asError(e);return r.quietFailure;}
  function awaitQuiet(r:Resource,task:Promise<void>):Promise<void> {
    if(r.quietFailure)return Promise.reject(r.quietFailure);let timer:ReturnType<typeof setTimeout>|undefined;
    const refusal=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(quietFailure(r,new MobilePlaybackError(503,'BUSY',true,1000))),cap.releaseMs);});
    return Promise.race([task,refusal]).finally(()=>{if(timer)clearTimeout(timer);});
  }
  function retire(r:Resource,e:unknown):void{r.failure??=asError(e);r.controller.abort();void release(r).catch(()=>undefined);}
  async function verify(r:Resource,preparing=false){await current(r,preparing);
    await operation(r,()=>r.binding!.functions.verify.call(r.lease,r.controller.signal));await current(r,preparing);}
  function closeReader(r:Resource,read:Reader):Promise<void> {
    if(read.closing)return read.closing;read.closed=true;read.controller.abort();
    read.closing=(async()=>{if(read.pending)await Promise.allSettled([read.pending]);
      if(r.lease&&r.binding)await r.binding.functions.closeRead.call(r.lease,read.id);
    })().catch(e=>{throw quietFailure(r,e);});return read.closing;
  }
  function release(r:Resource):Promise<void> {
    if(r.closing)return r.closing;if(r.state==='released')return Promise.resolve();r.state='releasing';r.controller.abort();
    for(const read of r.readers.values())read.controller.abort();
    r.closing=(async()=>{
      // 原 open/read/verify/renew 的真实完成先于 quiet，迟到 lease 仍归原 resource。
      if(r.preparation)await Promise.allSettled([r.preparation]);
      await Promise.all([...r.readers.values()].map(read=>closeReader(r,read)));
      while(r.ops.size)await Promise.allSettled([...r.ops]);
      if(r.quietFailure)throw r.quietFailure;
      if(r.lease){if(!r.cleanup)throw quietFailure(r,new MobilePlaybackError(503,'BUSY',true,1000));await r.cleanup.call(r.lease);}
      if(r.quietFailure)throw r.quietFailure;
      r.lease=null;r.cleanup=null;r.binding=null;r.prepared=null;r.state='released';
    })().catch(e=>{throw quietFailure(r,e);});return r.closing;
  }
  function reader(r:Resource,id:string):Reader {
    const owner=readerOwners.get(id);if(owner&&owner!==r)return fail(409,'INVALID_REQUEST');const prior=r.readers.get(id);if(prior)return prior;
    if(readerOwners.size>=cap.readIds)return fail(429,'RESOURCE_BUSY');
    const read:Reader={id,controller:new AbortController(),offset:null,pending:null,closed:false,closing:null};
    readerOwners.set(id,r);r.readers.set(id,read);return read;
  }
  function audioMatches(track:Readonly<MobileTrack>,source:MobilePlaybackPreparedSource['sourceAudio']):boolean {
    return ['codec','container','sampleRateHz','bitsPerSample','channels'].every(k=>track.audio[k as keyof typeof track.audio]===source[k as keyof typeof source]);
  }
  async function prepare(r:Resource):Promise<MobilePlaybackPreparedSource> {
    const rawTrack=await options.catalog.resolveTrack(r.scope,r.selection!,r.controller.signal),captured=mobileCatalogResponseSnapshot('track',rawTrack);
    if(!captured.ok)return fail(409,'SOURCE_CHANGED');const track=frozen(captured.value);
    if(track.source!=='netease'||track.availability!=='available'||!mobileTrackSelectionEquals(r.selection!,{trackId:track.id,source:track.source,versionId:track.versionId,contentRevision:track.contentRevision}))return fail(409,'SOURCE_CHANGED');
    await current(r,true);
    const lease=await options.streams.open({scope:r.scope,resourceId:r.id,selection:r.selection!},r.controller.signal);r.lease=lease;
    // 即使 open 迟到/已取消，也先捕获原 cleanup 方法，不以取消丢掉真实 lease。
    captureLease(r,lease);local(r,true);await verify(r,true);
    const probeId=randomUUID();let facts:Awaited<ReturnType<typeof readMobileNeteaseAudioFacts>>;
    try{facts=await readMobileNeteaseAudioFacts(r.binding!.size,(start,n,signal)=>operation(r,()=>r.binding!.functions.read.call(lease,probeId,start,n,signal)),r.controller.signal);}
    finally{try{await r.binding!.functions.closeRead.call(lease,probeId);}catch(e){throw quietFailure(r,e);}}
    await verify(r,true);
    if(!audioMatches(track,facts.audio)||facts.durationMs!==null&&Math.abs(facts.durationMs-track.durationMs)>MOBILE_NETEASE_DURATION_TOLERANCE_MS)return fail(409,'SOURCE_CHANGED');
    const source:MobilePlaybackPreparedSource=Object.freeze({handle:r.id,sourceAudio:facts.audio,actualAudio:facts.audio,
      processing:Object.freeze({mode:'direct',reason:'当前 Provider 精确来源的直接只读传输。',fromPreparedCache:false}),
      size:r.binding!.size,contentType:facts.contentType,durationMs:facts.durationMs??track.durationMs,seekable:true});
    r.prepared=source;r.state='active';await current(r);return source;
  }
  return{
    get qualified(){return qualified();},
    bind(rawScope){const scope=captureMobileNeteaseScope(rawScope);return{
      async prepare(rawRequest:MobilePlaybackSourceRequest,signal:AbortSignal){
        signal.throwIfAborted();if(!qualified())return fail(409,'UNSUPPORTED_FORMAT');
        if(!requestValid({operation:'prepare',selection:rawRequest})||!mobileNeteaseId(rawRequest.resourceId))return fail(400,'INVALID_REQUEST');
        const c=mobileDataSnapshot(rawRequest,undefined,'request');if(!c.ok||!mobileRecord(c.value))return fail(400,'INVALID_REQUEST');const req=c.value;
        const selection=captureMobileNeteaseSelection({trackId:req.trackId,source:'netease',versionId:req.versionId,contentRevision:req.contentRevision});
        await scopeCurrent(scope,'acquire',signal);const id=req.resourceId as string,fingerprint=mobileCanonicalJson(req);let r=records.get(id);
        if(r){if(!sameOwner(scope,r.scope))return fail(404,'INVALID_REQUEST');local(r,true);
          if(r.fingerprint!==fingerprint)return fail(409,'IDEMPOTENCY_CONFLICT');if(r.prepared){await verify(r);return r.prepared;}
          if(r.preparation){const remaining=cap.prepareMs-(clock()-r.created);if(remaining<=0){const e=new MobilePlaybackError(503,'BUSY',true,1000);retire(r,e);throw e;}
            return deadline(r.preparation,remaining,r.controller);}
        }else{if(records.size>=cap.storedResources||live()>=cap.liveResources)return fail(429,'RESOURCE_BUSY');r=make(id,scope,selection,fingerprint,'preparing');}
        const record=r,unbind=bindAbort(signal,record.controller);record.preparation=prepare(record);void record.preparation.catch(e=>retire(record,e));
        try{return await deadline(record.preparation,cap.prepareMs,record.controller);}catch(e){retire(record,e);throw asError(e);}finally{unbind();}
      },
      async verify(handle){const r=resource(scope,handle);try{await verify(r);}catch(e){retire(r,e);throw asError(e);}},
      async renew(handle){const r=resource(scope,handle);try{await verify(r);
        const raw=await operation(r,()=>r.binding!.functions.renew.call(r.lease,r.controller.signal)),c=mobileDataSnapshot(raw);
        if(!c.ok||!mobileRecord(c.value)||Reflect.ownKeys(c.value).length!==1||!mobileInteger(c.value.expiresAtMs,clock()+1,clock()+cap.leaseMs))return fail(409,'SOURCE_CHANGED');
        local(r);checkLease(r,c.value.expiresAtMs);await scopeCurrent(r.scope,'lease',r.controller.signal);local(r);checkLease(r);
        r.expires=Math.min(r.created+cap.maxLifetimeMs,c.value.expiresAtMs);
      }catch(e){retire(r,e);throw asError(e);}},
      async read(handle,readId,start,maxBytes,signal){const r=resource(scope,handle);signal.throwIfAborted();
        if(!requestValid({operation:'read',handle,readId,start,maxBytes})||!mobileNeteaseId(readId))return fail(400,'INVALID_REQUEST');
        await current(r);if(!r.prepared||start>=r.prepared.size)return fail(400,'INVALID_REQUEST');
        const previous=r.readers.get(readId);if(previous?.closed)return fail(410,'RESOURCE_RELEASED');if(previous?.pending)return fail(429,'RESOURCE_BUSY');
        if(!previous){let active=0,total=0;for(const item of records.values())for(const v of item.readers.values())if(!v.closed){active++;if(item===r)total++;}
          if(active>=cap.readers||total>=cap.resourceReaders)return fail(429,'RESOURCE_BUSY');}
        const read=reader(r,readId);if(read.offset!==null&&read.offset!==start)return fail(400,'INVALID_REQUEST');
        const offResource=bindAbort(r.controller.signal,read.controller),offCaller=bindAbort(signal,read.controller),length=Math.min(maxBytes,r.prepared.size-start);
        const p=(async()=>{await verify(r);read.controller.signal.throwIfAborted();
          const raw=await operation(r,()=>r.binding!.functions.read.call(r.lease,read.id,start,length,read.controller.signal));
          await verify(r);read.controller.signal.throwIfAborted();if(read.closed)return fail(410,'RESOURCE_RELEASED');
          const bytes=exactBytes(raw,length);read.offset=start+length;return bytes;
        })();read.pending=p;void p.catch(()=>undefined);
        try{return await deadline(p,cap.readMs,read.controller);}catch(e){if(!signal.aborted&&!read.controller.signal.aborted)retire(r,e);throw asError(e);}
        finally{void p.finally(()=>{read.pending=null;offResource();offCaller();}).catch(()=>undefined);}
      },
      async closeRead(handle,readId){const r=resource(scope,handle);
        if(!requestValid({operation:'close-read',handle,readId})||!mobileNeteaseId(readId))return fail(400,'INVALID_REQUEST');
        await awaitQuiet(r,closeReader(r,reader(r,readId)));},
      async release(handle){if(!requestValid({operation:'release',handle})||!mobileNeteaseId(handle))return fail(400,'INVALID_REQUEST');
        let r=records.get(handle);if(!r){if(records.size>=cap.storedResources)return fail(429,'RESOURCE_BUSY');r=make(handle,scope,null,null,'released');}
        if(!sameOwner(scope,r.scope))return fail(404,'INVALID_REQUEST');await awaitQuiet(r,release(r));},
    };},
    async revokeDevice(deviceId,deviceEpoch){if(!mobileNeteaseId(deviceId)||!mobileInteger(deviceEpoch,1))return fail(400,'INVALID_REQUEST');
      const selected=[...records.values()].filter(r=>r.scope.deviceId===deviceId&&r.scope.deviceEpoch===deviceEpoch&&r.state!=='released');
      for(const r of selected){r.failure??=new MobilePlaybackError(403,'DEVICE_REVOKED');r.controller.abort();}
      await Promise.all(selected.map(r=>awaitQuiet(r,release(r))));},
    close(){if(closing)return closing;closed=true;for(const r of records.values())r.controller.abort();
      closing=Promise.all([...records.values()].map(r=>awaitQuiet(r,release(r)))).then(()=>undefined);return closing;},
    resourceSnapshot(){let readers=0,pending=0;for(const r of records.values()){if(r.state==='preparing')pending++;pending+=r.ops.size;
      for(const read of r.readers.values())if(!read.closed)readers++;}
      return Object.freeze({resources:records.size,live:live(),readers,pending,fatal});},
  };
}
