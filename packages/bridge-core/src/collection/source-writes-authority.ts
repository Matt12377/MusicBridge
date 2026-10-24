import { MessagePort } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { sourceWritesFail } from './local-source-writes-journal.js';
import { captureLocalLyricsPhysicalBinding, lyricsPhysicalDigest, type LocalLyricsPhysicalBinding, type LocalLyricsPhysicalGrantFact } from '../library/lyrics-source-format.js';
import { localSourceWritesDataSnapshot, localSourceWritesRecord, isLocalLyricsId } from '@music-bridge/contracts';
import { LIBRARY_REMOVAL_REQUEST_MS } from '../shared/library-removal-budget.js';
import { isCanonicalNodeStatInode } from '../shared/filesystem-inode.js';

export interface SourceWritesMainActor {readonly authorityId:string;readonly active:boolean}
const actors=new WeakSet<object>();
/** 只在已转移的专用物理端口安装；普通命令 DTO 或 grant JSON 不能创建此对象身份。 */
export function createSourceWritesMainActor(port:MessagePort):SourceWritesMainActor {
  if(!(port instanceof MessagePort))return sourceWritesFail('GRANT_REQUIRED');let active=true;
  const actor=Object.freeze({authorityId:randomUUID(),get active(){return active;}});actors.add(actor);
  const lyricsState:LyricsActorState={port,sequence:0,pending:new Map(),seen:new WeakSet(),fatal:false,installed:false};lyricsActors.set(actor,lyricsState);installLyrics(actor,lyricsState);installWorkbenchDirectory(actor,port);installWorkbenchReaders(actor,port);
  port.once('close',()=>{active=false;});port.once('messageerror',()=>{active=false;});return actor;
}

/** 同原撤库命令的读取资源fence；只关闭已有读取，不签任何源写或目录许可。 */
export interface SourceWorkbenchReadersBinding {
  commandId:string;originalSha256:string;libraryId:string;datasetId:string;ownerEpoch:string;
}
export interface SourceWorkbenchReadersRequest {
  version:1;type:'workbench-readers-stop-request';purpose:'WORKBENCH_READERS';requestId:string;
  sequence:number;authorityId:string;expiresAtMs:number;binding:SourceWorkbenchReadersBinding;
}
export interface SourceWorkbenchReadersReply {
  version:1;type:'workbench-readers-stop-reply';purpose:'WORKBENCH_READERS';requestId:string;
  sequence:number;authorityId:string;requestSha256:string;binding:SourceWorkbenchReadersBinding;
  ok:boolean;physicalClosed:boolean;failure:null|'NOT_READY'|'TIMEOUT'|'UNKNOWN';
}
export function captureSourceWorkbenchReadersBinding(input:unknown):SourceWorkbenchReadersBinding {
  const v=localSourceWritesDataSnapshot(input,16384,1024);
  if(!localSourceWritesRecord(v,['commandId','originalSha256','libraryId','datasetId','ownerEpoch'])
    ||!uuid(v.commandId)||!sha(v.originalSha256)||!uuid(v.libraryId)||!uuid(v.datasetId)||!uuid(v.ownerEpoch))return sourceWritesFail('GRANT_MISMATCH');
  return v as unknown as SourceWorkbenchReadersBinding;
}
export function isSourceWorkbenchReadersWire(input:unknown,type:'request'|'reply'):boolean {
  if(!input||typeof input!=='object')return false;
  const d=Object.getOwnPropertyDescriptor(input,'type');
  return !!d&&'value'in d&&d.value===(type==='request'?'workbench-readers-stop-request':'workbench-readers-stop-reply');
}
export function captureSourceWorkbenchReadersRequest(input:unknown):SourceWorkbenchReadersRequest {
  const v=localSourceWritesDataSnapshot(input,16384,1024);
  if(!localSourceWritesRecord(v,['version','type','purpose','requestId','sequence','authorityId','expiresAtMs','binding'])
    ||v.version!==1||v.type!=='workbench-readers-stop-request'||v.purpose!=='WORKBENCH_READERS'
    ||!uuid(v.requestId)||!uuid(v.authorityId)||!positive(v.sequence)||!positive(v.expiresAtMs))return sourceWritesFail('GRANT_MISMATCH');
  return {...v,binding:captureSourceWorkbenchReadersBinding(v.binding)} as unknown as SourceWorkbenchReadersRequest;
}
export function captureSourceWorkbenchReadersReply(input:unknown):SourceWorkbenchReadersReply {
  const v=localSourceWritesDataSnapshot(input,16384,1024);
  if(!localSourceWritesRecord(v,['version','type','purpose','requestId','sequence','authorityId','requestSha256','binding','ok','physicalClosed','failure'])
    ||v.version!==1||v.type!=='workbench-readers-stop-reply'||v.purpose!=='WORKBENCH_READERS'
    ||!uuid(v.requestId)||!uuid(v.authorityId)||!positive(v.sequence)||!sha(v.requestSha256)||typeof v.ok!=='boolean'
    ||(v.ok?v.physicalClosed!==true||v.failure!==null:!['NOT_READY','TIMEOUT','UNKNOWN'].includes(String(v.failure))
      ||(v.failure==='TIMEOUT'?typeof v.physicalClosed!=='boolean':v.physicalClosed!==false)))return sourceWritesFail('GRANT_MISMATCH');
  return {...v,binding:captureSourceWorkbenchReadersBinding(v.binding)} as unknown as SourceWorkbenchReadersReply;
}
export function assertSourceWorkbenchReadersReplyForRequest(input:SourceWorkbenchReadersReply,original:SourceWorkbenchReadersRequest):void {
  const r=captureSourceWorkbenchReadersReply(input),q=captureSourceWorkbenchReadersRequest(original);
  if(r.requestId!==q.requestId||r.sequence!==q.sequence||r.authorityId!==q.authorityId
    ||r.requestSha256!==lyricsPhysicalDigest(q)||lyricsPhysicalDigest(r.binding)!==lyricsPhysicalDigest(q.binding))return sourceWritesFail('GRANT_MISMATCH');
}
interface ReadersPending {
  request:SourceWorkbenchReadersRequest;signal:AbortSignal;timer:ReturnType<typeof setTimeout>;expired:boolean;
  cancel():void;resolve():void;reject(reason:unknown):void;
}
interface ReadersActorState {port:MessagePort;sequence:number;fatal:boolean;seen:WeakSet<object>;pending:Map<string,ReadersPending>}
const readersActors=new WeakMap<object,ReadersActorState>();
function poisonReaders(s:ReadersActorState):void {
  if(s.fatal)return;s.fatal=true;
  for(const p of s.pending.values()){clearTimeout(p.timer);p.signal.removeEventListener('abort',p.cancel);p.reject(new Error('原按库读取资源关闭未知。'));}
  s.pending.clear();try{s.port.close();}catch{/* 原端口释放未知，不造新actor或closed回声。 */}
}
function installWorkbenchReaders(actor:SourceWritesMainActor,port:MessagePort):void {
  const s:ReadersActorState={port,sequence:0,fatal:false,seen:new WeakSet(),pending:new Map()};readersActors.set(actor,s);
  port.on('message',raw=>{
    if(!isSourceWorkbenchReadersWire(raw,'reply'))return;
    try{
      const r=captureSourceWorkbenchReadersReply(raw),p=s.pending.get(r.requestId);
      if(s.fatal||!actor.active||!p)return sourceWritesFail('GRANT_MISMATCH');
      assertSourceWorkbenchReadersReplyForRequest(r,p.request);
      clearTimeout(p.timer);p.signal.removeEventListener('abort',p.cancel);s.pending.delete(r.requestId);s.seen.add(raw as object);
      // 正常期限失效只退休完整匹配的原回声；不能延长期限或把迟到closed用于撤绑定。
      if(p.expired||p.signal.aborted||Date.now()>=p.request.expiresAtMs){p.reject(new Error('原撤库期限已到，资源关闭结果只保原查询。'));return;}
      if(!r.ok){p.reject(new Error('原按库读取资源关闭未确认。'));return;}p.resolve();
    }catch{poisonReaders(s);}
  });
  port.once('close',()=>poisonReaders(s));port.once('messageerror',()=>poisonReaders(s));
}
export function consumeSourceWorkbenchReadersReply(actor:SourceWritesMainActor,raw:unknown):boolean {
  if(!isSourceWorkbenchReadersWire(raw,'reply'))return false;
  const s=readersActors.get(actor);
  if(!s||s.fatal||!raw||typeof raw!=='object'||!s.seen.has(raw)){if(s)poisonReaders(s);return sourceWritesFail('GRANT_MISMATCH');}
  s.seen.delete(raw);return true;
}
export function requestSourceWorkbenchReadersStop(actor:SourceWritesMainActor,input:SourceWorkbenchReadersBinding,context:{signal:AbortSignal;deadlineAtMs:number}):Promise<void> {
  assertSourceWritesMainActor(actor);const s=readersActors.get(actor),binding=captureSourceWorkbenchReadersBinding(input);
  const remaining=Math.min(LIBRARY_REMOVAL_REQUEST_MS,Math.floor(context.deadlineAtMs-performance.now()));
  if(!s||s.fatal||context.signal.aborted||!Number.isFinite(remaining)||remaining<=0||s.pending.size>=4||s.sequence>=Number.MAX_SAFE_INTEGER)return Promise.reject(new Error('原撤库读取fence不可受理。'));
  const request=captureSourceWorkbenchReadersRequest({version:1,type:'workbench-readers-stop-request',purpose:'WORKBENCH_READERS',requestId:randomUUID(),sequence:++s.sequence,authorityId:actor.authorityId,expiresAtMs:Date.now()+remaining,binding});
  return new Promise((resolve,reject)=>{
    const cancel=()=>{const p=s.pending.get(request.requestId);if(!p||p.expired)return;clearTimeout(p.timer);p.signal.removeEventListener('abort',cancel);p.expired=true;reject(new Error('原撤库读取fence未确认，不重发原命令。'));};
    const timer=setTimeout(cancel,remaining);s.pending.set(request.requestId,{request,signal:context.signal,timer,expired:false,cancel,resolve,reject});context.signal.addEventListener('abort',cancel,{once:true});
    try{if(context.signal.aborted)cancel();else s.port.postMessage(request);}catch{poisonReaders(s);}
  });
}

export const SOURCE_WRITES_LYRICS_PURPOSE = 'LYRICS';
export const SOURCE_WRITES_LYRICS_REQUEST_TYPE = 'lyrics-source-grant-request';
export const SOURCE_WRITES_LYRICS_REPLY_TYPE = 'lyrics-source-grant-reply';
export interface SourceWritesLyricsGrantRequest {
  version:1;type:typeof SOURCE_WRITES_LYRICS_REQUEST_TYPE;purpose:'LYRICS';
  requestId:string;sequence:number;revision:number;authorityId:string;expiresAtMs:number;
  binding:LocalLyricsPhysicalBinding;bindingSha256:string;
}
export interface SourceWritesLyricsGrantReply {
  version:1;type:typeof SOURCE_WRITES_LYRICS_REPLY_TYPE;purpose:'LYRICS';
  requestId:string;sequence:number;revision:number;authorityId:string;requestSha256:string;
  binding:LocalLyricsPhysicalBinding;bindingSha256:string;decision:'granted'|'rejected';
  nonce:string|null;validUntilMs:number|null;
}
export interface SourceWritesLyricsGrant {readonly purpose:'LYRICS'}
export class SourceWritesLyricsGrantError extends Error {constructor(readonly code:'REJECTED'|'UNKNOWN'){super(code==='REJECTED'?'歌词原请求未得到Main实际许可。':'歌词专用物理许可状态未知。');}}
interface PendingLyrics {
  request:SourceWritesLyricsGrantRequest;resolve:(grant:SourceWritesLyricsGrant)=>void;reject:(reason:unknown)=>void;
  timer:ReturnType<typeof setTimeout>;signal:AbortSignal;cancel:()=>void;
}
interface LyricsActorState {port:MessagePort;sequence:number;pending:Map<string,PendingLyrics>;seen:WeakSet<object>;fatal:boolean;installed:boolean}
const lyricsActors=new WeakMap<object,LyricsActorState>();
const lyricsGrants=new WeakMap<object,{actor:SourceWritesMainActor;fact:LocalLyricsPhysicalGrantFact;binding:LocalLyricsPhysicalBinding}>();
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(v);
const sha=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v);
const positive=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0;
/** 仅检查封套类型；完整载荷必须捕获，类型getter仍由原fatal路径拒绝。 */
export function isSourceWritesLyricsGrantWire(input:unknown,type:'request'|'reply'):boolean {
  if(!input||typeof input!=='object')return false;
  const d=Object.getOwnPropertyDescriptor(input,'type');return !!d&&'value'in d&&d.value===(type==='request'?SOURCE_WRITES_LYRICS_REQUEST_TYPE:SOURCE_WRITES_LYRICS_REPLY_TYPE);
}
export function captureSourceWritesLyricsGrantRequest(input:unknown):SourceWritesLyricsGrantRequest {
  const v=localSourceWritesDataSnapshot(input,16384,1024);
  if(!localSourceWritesRecord(v,['version','type','purpose','requestId','sequence','revision','authorityId','expiresAtMs','binding','bindingSha256'])
    ||v.version!==1||v.type!==SOURCE_WRITES_LYRICS_REQUEST_TYPE||v.purpose!=='LYRICS'||!uuid(v.requestId)||!uuid(v.authorityId)
    ||!positive(v.sequence)||!positive(v.revision)||!positive(v.expiresAtMs)||!sha(v.bindingSha256))return sourceWritesFail('GRANT_MISMATCH');
  const binding=captureLocalLyricsPhysicalBinding(v.binding);if(lyricsPhysicalDigest(binding)!==v.bindingSha256)return sourceWritesFail('GRANT_MISMATCH');
  return {...v,binding} as unknown as SourceWritesLyricsGrantRequest;
}
export function captureSourceWritesLyricsGrantReply(input:unknown):SourceWritesLyricsGrantReply {
  const v=localSourceWritesDataSnapshot(input,16384,1024);
  if(!localSourceWritesRecord(v,['version','type','purpose','requestId','sequence','revision','authorityId','requestSha256','binding','bindingSha256','decision','nonce','validUntilMs'])
    ||v.version!==1||v.type!==SOURCE_WRITES_LYRICS_REPLY_TYPE||v.purpose!=='LYRICS'||!uuid(v.requestId)||!uuid(v.authorityId)
    ||!positive(v.sequence)||!positive(v.revision)||!sha(v.requestSha256)||!sha(v.bindingSha256)||!['granted','rejected'].includes(String(v.decision))
    ||(v.decision==='granted'? !uuid(v.nonce)||!positive(v.validUntilMs):v.nonce!==null||v.validUntilMs!==null))return sourceWritesFail('GRANT_MISMATCH');
  const binding=captureLocalLyricsPhysicalBinding(v.binding);if(lyricsPhysicalDigest(binding)!==v.bindingSha256)return sourceWritesFail('GRANT_MISMATCH');
  return {...v,binding} as unknown as SourceWritesLyricsGrantReply;
}
/** Utility与Main共用真实原请求匹配；不产生任何本地许可品牌。 */
export function assertSourceWritesLyricsGrantReplyForRequest(reply:SourceWritesLyricsGrantReply,request:SourceWritesLyricsGrantRequest):void {
  const q=captureSourceWritesLyricsGrantRequest(request),r=captureSourceWritesLyricsGrantReply(reply);
  if(r.requestId!==q.requestId||r.sequence!==q.sequence||r.revision!==q.revision||r.authorityId!==q.authorityId
    ||r.requestSha256!==lyricsPhysicalDigest(q)||r.bindingSha256!==q.bindingSha256||lyricsPhysicalDigest(r.binding)!==lyricsPhysicalDigest(q.binding))return sourceWritesFail('GRANT_MISMATCH');
}
function lyricsState(actor:SourceWritesMainActor):LyricsActorState {
  assertSourceWritesMainActor(actor);const s=lyricsActors.get(actor);if(!s||s.fatal)return sourceWritesFail('GRANT_REQUIRED');return s;
}
function poisonLyrics(s:LyricsActorState):void {
  if(s.fatal)return;s.fatal=true;
  for(const p of s.pending.values()){clearTimeout(p.timer);p.signal.removeEventListener('abort',p.cancel);p.reject(new SourceWritesLyricsGrantError('UNKNOWN'));}
  s.pending.clear();try{s.port.close();}catch{/* 原物理端口撤销失败不生成许可。 */}
}
function installLyrics(actor:SourceWritesMainActor,s:LyricsActorState):void {
  if(s.installed)return;s.installed=true;
  // 构造actor时先安装，必须在Owner普通source-writes监听之前消费同一个真实message对象。
  s.port.on('message',(raw:unknown)=>{
    if(!isSourceWritesLyricsGrantWire(raw,'reply'))return;
    try{
      const r=captureSourceWritesLyricsGrantReply(raw),pending=s.pending.get(r.requestId);
      if(s.fatal||!actor.active||!pending)return sourceWritesFail('GRANT_MISMATCH');
      assertSourceWritesLyricsGrantReplyForRequest(r,pending.request);
      if(Date.now()>=pending.request.expiresAtMs||pending.signal.aborted)return sourceWritesFail('GRANT_MISMATCH');
      if(r.decision==='granted'&&(r.validUntilMs!<=Date.now()||r.validUntilMs!>Date.now()+480000))return sourceWritesFail('GRANT_MISMATCH');
      clearTimeout(pending.timer);pending.signal.removeEventListener('abort',pending.cancel);s.pending.delete(r.requestId);s.seen.add(raw as object);
      if(r.decision==='rejected'){pending.reject(new SourceWritesLyricsGrantError('REJECTED'));return;}
      const grant=Object.freeze({purpose:'LYRICS' as const});
      const fact={requestId:r.requestId,sequence:r.sequence,revision:r.revision,authorityId:r.authorityId,bindingSha256:r.bindingSha256,requestSha256:r.requestSha256,nonce:r.nonce!,validUntilMs:r.validUntilMs!};
      lyricsGrants.set(grant,{actor,fact,binding:r.binding});pending.resolve(grant);
    }catch{poisonLyrics(s);}
  });
  s.port.once('close',()=>poisonLyrics(s));s.port.once('messageerror',()=>poisonLyrics(s));
}
/** 只识别已由真实端口监听消费过的同一对象；直接调用此函数不能签发grant。 */
export function consumeSourceWritesLyricsGrantReply(actor:SourceWritesMainActor,raw:unknown):boolean {
  if(!isSourceWritesLyricsGrantWire(raw,'reply'))return false;
  const s=lyricsState(actor);if(!raw||typeof raw!=='object'||!s.seen.has(raw)){poisonLyrics(s);return sourceWritesFail('GRANT_MISMATCH');}
  s.seen.delete(raw);return true;
}
export function requestSourceWritesLyricsGrant(actor:SourceWritesMainActor,input:LocalLyricsPhysicalBinding,revision:number,signal:AbortSignal):Promise<SourceWritesLyricsGrant> {
  const s=lyricsState(actor),binding=captureLocalLyricsPhysicalBinding(input);if(signal.aborted||s.pending.size>=4||!positive(revision)||s.sequence>=Number.MAX_SAFE_INTEGER)return Promise.reject(new Error('歌词原请求不再可受理。'));
  installLyrics(actor,s);
  const request=captureSourceWritesLyricsGrantRequest({version:1,type:SOURCE_WRITES_LYRICS_REQUEST_TYPE,purpose:'LYRICS',requestId:randomUUID(),sequence:++s.sequence,revision,authorityId:actor.authorityId,
    expiresAtMs:Date.now()+2000,binding,bindingSha256:lyricsPhysicalDigest(binding)});
  return new Promise((resolve,reject)=>{
    const cancel=():void=>poisonLyrics(s),timer=setTimeout(cancel,Math.max(1,request.expiresAtMs-Date.now()));
    s.pending.set(request.requestId,{request,resolve,reject,timer,signal,cancel});signal.addEventListener('abort',cancel,{once:true});
    try{if(signal.aborted)cancel();else s.port.postMessage(request);}catch{poisonLyrics(s);}
  });
}
export function assertSourceWritesLyricsGrant(grant:unknown,actor:SourceWritesMainActor,input:LocalLyricsPhysicalBinding,revision:number):LocalLyricsPhysicalGrantFact {
  lyricsState(actor);const actual=grant&&typeof grant==='object'?lyricsGrants.get(grant):undefined,binding=captureLocalLyricsPhysicalBinding(input);
  if(!actual||actual.actor!==actor||actual.fact.revision!==revision||actual.fact.validUntilMs<=Date.now()||actual.fact.bindingSha256!==lyricsPhysicalDigest(binding))return sourceWritesFail('GRANT_MISMATCH');
  return {...actual.fact};
}

export const SOURCE_WRITES_LYRICS_VERIFY_REQUEST_TYPE='lyrics-source-verify-request';
export const SOURCE_WRITES_LYRICS_VERIFY_REPLY_TYPE='lyrics-source-verify-reply';
export interface SourceWritesLyricsVerifyRequest {
  version:1;type:typeof SOURCE_WRITES_LYRICS_VERIFY_REQUEST_TYPE;purpose:'LYRICS';
  requestId:string;sequence:number;epoch:string;datasetId:string;grantRequest:SourceWritesLyricsGrantRequest;
}
export interface SourceWritesLyricsOriginalEvidence {
  originalBinding:LocalLyricsPhysicalBinding;request:{sessionId:string;commandId:string;embed:boolean};
  phase:'PREPARED'|'FAILED';revision:number;recordOwnerEpoch:string;currentOwnerEpoch:string;
  physicalClosed:boolean;protectionReleased:boolean;unresolved:false;ledgerSequence:number;
  originalIntentSha256:string;originalRequestSha256:string;groupCaptureSha256:string;protectionSha256:string;
  jobOrigin:null|{jobId:string;originalJobRequestSha256:string;library:{datasetId:string;libraryId:string;captureId:string};watermark:string;
    phase:'queued'|'running'|'stopped'|'complete'|'partial'|'unknown'|'failed'};
}
export interface SourceWritesLyricsVerifyReply {
  version:1;type:typeof SOURCE_WRITES_LYRICS_VERIFY_REPLY_TYPE;purpose:'LYRICS';
  requestId:string;sequence:number;epoch:string;datasetId:string;grantRequestId:string;
  authorityId:string;binding:LocalLyricsPhysicalBinding;bindingSha256:string;revision:number;result:SourceWritesLyricsOriginalEvidence;
}
export function isSourceWritesLyricsVerifyWire(input:unknown,type:'request'|'reply'):boolean {
  if(!input||typeof input!=='object')return false;const d=Object.getOwnPropertyDescriptor(input,'type');
  return !!d&&'value'in d&&d.value===(type==='request'?SOURCE_WRITES_LYRICS_VERIFY_REQUEST_TYPE:SOURCE_WRITES_LYRICS_VERIFY_REPLY_TYPE);
}
export function captureSourceWritesLyricsVerifyRequest(input:unknown):SourceWritesLyricsVerifyRequest {
  const v=localSourceWritesDataSnapshot(input,32768,2048);
  if(!localSourceWritesRecord(v,['version','type','purpose','requestId','sequence','epoch','datasetId','grantRequest'])
    ||v.version!==1||v.type!==SOURCE_WRITES_LYRICS_VERIFY_REQUEST_TYPE||v.purpose!=='LYRICS'||!uuid(v.requestId)||!positive(v.sequence)||!uuid(v.epoch)||!uuid(v.datasetId))return sourceWritesFail('GRANT_MISMATCH');
  const q=captureSourceWritesLyricsGrantRequest(v.grantRequest);if(q.binding.datasetId!==v.datasetId||q.binding.ownerEpoch!==v.epoch)return sourceWritesFail('GRANT_MISMATCH');
  return {...v,grantRequest:q} as unknown as SourceWritesLyricsVerifyRequest;
}
export function captureSourceWritesLyricsOriginalEvidence(input:unknown):SourceWritesLyricsOriginalEvidence {
  const v=localSourceWritesDataSnapshot(input,32768,2048);
  if(!localSourceWritesRecord(v,['originalBinding','request','phase','revision','recordOwnerEpoch','currentOwnerEpoch','physicalClosed','protectionReleased','unresolved','ledgerSequence','originalIntentSha256','originalRequestSha256','groupCaptureSha256','protectionSha256','jobOrigin'])
    ||!['PREPARED','FAILED'].includes(String(v.phase))||!positive(v.revision)||!positive(v.ledgerSequence)||!uuid(v.recordOwnerEpoch)||!uuid(v.currentOwnerEpoch)||v.unresolved!==false
    ||typeof v.physicalClosed!=='boolean'||typeof v.protectionReleased!=='boolean'
    ||!localSourceWritesRecord(v.request,['sessionId','commandId','embed'])||!isLocalLyricsId(v.request.sessionId)||!isLocalLyricsId(v.request.commandId)||typeof v.request.embed!=='boolean'
    ||['originalIntentSha256','originalRequestSha256','groupCaptureSha256','protectionSha256'].some(k=>!sha(v[k])))return sourceWritesFail('GRANT_MISMATCH');
  const originalBinding=captureLocalLyricsPhysicalBinding(v.originalBinding);
  const jobOrigin=v.jobOrigin;
  if(jobOrigin!==null){
    if(!localSourceWritesRecord(jobOrigin,['jobId','originalJobRequestSha256','library','watermark','phase'])||!isLocalLyricsId(jobOrigin.jobId)||!sha(jobOrigin.originalJobRequestSha256)
      ||typeof jobOrigin.watermark!=='string'||!jobOrigin.watermark||jobOrigin.watermark.length>512||/[\x00-\x1f\x7f]/u.test(jobOrigin.watermark)
      ||!['queued','running','stopped','complete','partial','unknown','failed'].includes(String(jobOrigin.phase))
      ||!localSourceWritesRecord(jobOrigin.library,['datasetId','libraryId','captureId'])||!uuid(jobOrigin.library.datasetId)||!isLocalLyricsId(jobOrigin.library.libraryId)||!isLocalLyricsId(jobOrigin.library.captureId))return sourceWritesFail('GRANT_MISMATCH');
    if(jobOrigin.library.datasetId!==originalBinding.datasetId||jobOrigin.library.libraryId!==originalBinding.libraryId)return sourceWritesFail('GRANT_MISMATCH');
  }
  if(originalBinding.commandId!==v.request.commandId||originalBinding.sessionId!==v.request.sessionId||lyricsPhysicalDigest(v.request)!==v.originalRequestSha256
    ||['originalIntentSha256','originalRequestSha256','groupCaptureSha256','protectionSha256'].some(k=>originalBinding[k as keyof typeof originalBinding]!==v[k])
    ||(v.phase==='FAILED'?!(v.physicalClosed&&v.protectionReleased):v.physicalClosed||v.protectionReleased))return sourceWritesFail('GRANT_MISMATCH');
  return {...v,originalBinding} as unknown as SourceWritesLyricsOriginalEvidence;
}
export function captureSourceWritesLyricsVerifyReply(input:unknown):SourceWritesLyricsVerifyReply {
  const v=localSourceWritesDataSnapshot(input,49152,3072);
  if(!localSourceWritesRecord(v,['version','type','purpose','requestId','sequence','epoch','datasetId','grantRequestId','authorityId','binding','bindingSha256','revision','result'])
    ||v.version!==1||v.type!==SOURCE_WRITES_LYRICS_VERIFY_REPLY_TYPE||v.purpose!=='LYRICS'||!['requestId','epoch','datasetId','grantRequestId','authorityId'].every(k=>uuid(v[k]))
    ||!positive(v.sequence)||!positive(v.revision)||!sha(v.bindingSha256))return sourceWritesFail('GRANT_MISMATCH');
  const binding=captureLocalLyricsPhysicalBinding(v.binding),result=captureSourceWritesLyricsOriginalEvidence(v.result);
  if(lyricsPhysicalDigest(binding)!==v.bindingSha256||binding.datasetId!==v.datasetId||binding.ownerEpoch!==v.epoch||result.currentOwnerEpoch!==v.epoch||result.revision!==v.revision)return sourceWritesFail('GRANT_MISMATCH');
  const {ownerEpoch:_a,...before}=result.originalBinding,{ownerEpoch:_b,...current}=binding;
  if(lyricsPhysicalDigest(before)!==lyricsPhysicalDigest(current))return sourceWritesFail('GRANT_MISMATCH');
  return {...v,binding,result} as unknown as SourceWritesLyricsVerifyReply;
}
export function assertSourceWritesLyricsVerifyReplyForRequest(reply:SourceWritesLyricsVerifyReply,request:SourceWritesLyricsVerifyRequest):void {
  const q=captureSourceWritesLyricsVerifyRequest(request),r=captureSourceWritesLyricsVerifyReply(reply),original=q.grantRequest;
  if(r.requestId!==q.requestId||r.sequence!==q.sequence||r.epoch!==q.epoch||r.datasetId!==q.datasetId||r.grantRequestId!==original.requestId
    ||r.authorityId!==original.authorityId||r.revision!==original.revision||r.bindingSha256!==original.bindingSha256||lyricsPhysicalDigest(r.binding)!==lyricsPhysicalDigest(original.binding))return sourceWritesFail('GRANT_MISMATCH');
}
/** 只读验证必须对应本actor已实际发出的那条在途grant；不能先query另一个save再借回包授写。 */
export function assertSourceWritesLyricsVerifyForPending(actor:SourceWritesMainActor,request:SourceWritesLyricsVerifyRequest):void {
  const q=captureSourceWritesLyricsVerifyRequest(request),s=lyricsState(actor),pending=s.pending.get(q.grantRequest.requestId);
  if(!pending||Date.now()>=pending.request.expiresAtMs||lyricsPhysicalDigest(pending.request)!==lyricsPhysicalDigest(q.grantRequest))return sourceWritesFail('GRANT_MISMATCH');
}
export function assertSourceWritesMainActor(actor:unknown):asserts actor is SourceWritesMainActor {
  if(!actor||typeof actor!=='object'||!actors.has(actor)||!(actor as SourceWritesMainActor).active)return sourceWritesFail('GRANT_REQUIRED');
}

/** 只属原SourceWrites物理端口的独立目录许可；不授SourceWrites enabled。 */
export const WORKBENCH_DIRECTORY_PURPOSE = 'WORKBENCH_DIRECTORY';
export type SourceWorkbenchDirectoryKind='library'|'cue';
export interface SourceWorkbenchDirectoryUi {
  family:'management'|'workbench';command:'library.import.prepare'|'library.import.confirm'|'library.cue.start'|'localWorkbench.cue.target'|'localWorkbench.cue.preview'|'localWorkbench.plan.apply';
  commandId:string|null;requestSha256:string;
}
export interface SourceWorkbenchDirectoryBinding {
  datasetId:string;ownerEpoch:string;childGeneration:number;kind:SourceWorkbenchDirectoryKind;choiceId:string;revision:string;
  issuedAtMs:number;expiresAtMs:number;originalUi:SourceWorkbenchDirectoryUi;
}
export interface SourceWorkbenchDirectoryPhysical {path:string;dev:string;ino:string;birthtimeNs:string;mode:string;uid:string;gid:string}
export interface SourceWorkbenchDirectoryRequest {
  version:1;type:'workbench-directory-request';purpose:'WORKBENCH_DIRECTORY';requestId:string;sequence:number;authorityId:string;
  command:'approve'|'revalidate'|'revoke';binding:SourceWorkbenchDirectoryBinding;ui:SourceWorkbenchDirectoryUi;expiresAtMs:number;
}
export interface SourceWorkbenchDirectoryReply {
  version:1;type:'workbench-directory-reply';purpose:'WORKBENCH_DIRECTORY';requestId:string;sequence:number;authorityId:string;
  command:'approve'|'revalidate'|'revoke';binding:SourceWorkbenchDirectoryBinding;ui:SourceWorkbenchDirectoryUi;requestSha256:string;
  decision:'approved'|'rejected'|'revoked';nonce:string|null;validUntilMs:number|null;physical:SourceWorkbenchDirectoryPhysical|null;
}
export interface SourceWorkbenchDirectoryApproval {readonly purpose:'WORKBENCH_DIRECTORY'}
export type SourceWorkbenchDirectoryRegistration={kind:'library';choice:import('@music-bridge/contracts').LocalLibraryImportChoice}|{kind:'cue';choiceId:string;revision:string};
export interface SourceWorkbenchDirectoryRegistrationRequest {
  version:1;type:'workbench-directory-registration-request';purpose:'WORKBENCH_DIRECTORY';requestId:string;sequence:number;
  command:'register'|'release';binding:SourceWorkbenchDirectoryBinding;expiresAtMs:number;
}
export type SourceWorkbenchDirectoryRegistrationReply={version:1;type:'workbench-directory-registration-reply';purpose:'WORKBENCH_DIRECTORY';requestId:string;sequence:number;command:'register'|'release';binding:SourceWorkbenchDirectoryBinding;requestSha256:string}&({ok:true;result:SourceWorkbenchDirectoryRegistration|{choiceId:string;revision:string;revoked:true;physicalClosed:true}}|{ok:false;failure:'NOT_READY'|'INVALID_INPUT'|'TIMEOUT'|'UNKNOWN'});
export interface SourceWorkbenchDirectoryOwnerDomain {
  registerWorkbenchDirectory(binding:SourceWorkbenchDirectoryBinding,context:{identity:Readonly<{epoch:string;datasetId:string}>;mainActor:SourceWritesMainActor;signal:AbortSignal;deadlineAtMs:number}):Promise<SourceWorkbenchDirectoryRegistration>;
  revokeWorkbenchDirectory(binding:SourceWorkbenchDirectoryBinding,context:{identity:Readonly<{epoch:string;datasetId:string}>;mainActor:SourceWritesMainActor;signal:AbortSignal;deadlineAtMs:number}):Promise<{choiceId:string;revision:string;revoked:true;physicalClosed:true}>;
}

const directoryUiCommands={management:['library.import.prepare','library.import.confirm','library.cue.start'],workbench:['localWorkbench.cue.target','localWorkbench.cue.preview','localWorkbench.plan.apply']} as const;
const decimal=(v:unknown):v is string=>typeof v==='string'&&/^(?:0|[1-9][0-9]{0,39})$/u.test(v);
export function captureSourceWorkbenchDirectoryUi(input:unknown):SourceWorkbenchDirectoryUi {
 const v=localSourceWritesDataSnapshot(input,4096,1024);
 if(!localSourceWritesRecord(v,['family','command','commandId','requestSha256'])||!['management','workbench'].includes(String(v.family))||!directoryUiCommands[v.family as keyof typeof directoryUiCommands].includes(v.command as never)||!sha(v.requestSha256)||!(v.commandId===null||isLocalLyricsId(v.commandId))
 ||(['library.import.prepare','localWorkbench.cue.target','localWorkbench.cue.preview'].includes(String(v.command))?v.commandId!==null:v.commandId===null))return sourceWritesFail('GRANT_MISMATCH');
 return v as unknown as SourceWorkbenchDirectoryUi;
}
export function captureSourceWorkbenchDirectoryBinding(input:unknown):SourceWorkbenchDirectoryBinding {
 const v=localSourceWritesDataSnapshot(input,8192,4096);
 if(!localSourceWritesRecord(v,['datasetId','ownerEpoch','childGeneration','kind','choiceId','revision','issuedAtMs','expiresAtMs','originalUi'])||!uuid(v.datasetId)||!uuid(v.ownerEpoch)||!positive(v.childGeneration)||!['library','cue'].includes(String(v.kind))||!uuid(v.choiceId)||!sha(v.revision)||!positive(v.issuedAtMs)||!positive(v.expiresAtMs)||Number(v.expiresAtMs)<=Number(v.issuedAtMs)||Number(v.expiresAtMs)-Number(v.issuedAtMs)>600000)return sourceWritesFail('GRANT_MISMATCH');
 const originalUi=captureSourceWorkbenchDirectoryUi(v.originalUi);if(originalUi.command!==(v.kind==='library'?'library.import.prepare':'localWorkbench.cue.target'))return sourceWritesFail('GRANT_MISMATCH');
 return {...v,originalUi} as unknown as SourceWorkbenchDirectoryBinding;
}
export function captureSourceWorkbenchDirectoryPhysical(input:unknown):SourceWorkbenchDirectoryPhysical {
 const v=localSourceWritesDataSnapshot(input,8192,4096);
 if(!localSourceWritesRecord(v,['path','dev','ino','birthtimeNs','mode','uid','gid'])||typeof v.path!=='string'||!v.path.startsWith('/')||v.path==='/'||/[\x00-\x1f\x7f]/u.test(v.path)||Buffer.from(v.path).toString('utf8')!==v.path||v.path.split('/').slice(1).some(x=>!x||x==='.'||x==='..')||!isCanonicalNodeStatInode(v.ino)||['dev','birthtimeNs','mode','uid','gid'].some(k=>!decimal(v[k])))return sourceWritesFail('GRANT_MISMATCH');
 return v as unknown as SourceWorkbenchDirectoryPhysical;
}
export function isSourceWorkbenchDirectoryWire(input:unknown,type:'request'|'reply'|'registration-request'|'registration-reply'):boolean {
 if(!input||typeof input!=='object')return false;return Object.getOwnPropertyDescriptor(input,'type')?.value===`workbench-directory-${type}`;
}
export function captureSourceWorkbenchDirectoryRequest(input:unknown):SourceWorkbenchDirectoryRequest {
 const v=localSourceWritesDataSnapshot(input,16384,4096);
 if(!localSourceWritesRecord(v,['version','type','purpose','requestId','sequence','authorityId','command','binding','ui','expiresAtMs'])||v.version!==1||v.type!=='workbench-directory-request'||v.purpose!==WORKBENCH_DIRECTORY_PURPOSE||!uuid(v.requestId)||!uuid(v.authorityId)||!positive(v.sequence)||!['approve','revalidate','revoke'].includes(String(v.command))||!positive(v.expiresAtMs))return sourceWritesFail('GRANT_MISMATCH');
 const binding=captureSourceWorkbenchDirectoryBinding(v.binding),ui=captureSourceWorkbenchDirectoryUi(v.ui);
 if(v.command==='approve'&&lyricsPhysicalDigest(ui)!==lyricsPhysicalDigest(binding.originalUi)||v.command==='revalidate'&&(binding.kind==='library'?ui.command!=='library.import.confirm':!['localWorkbench.cue.preview','localWorkbench.plan.apply','library.cue.start'].includes(ui.command)))return sourceWritesFail('GRANT_MISMATCH');
 return {...v,binding,ui} as unknown as SourceWorkbenchDirectoryRequest;
}
export function captureSourceWorkbenchDirectoryReply(input:unknown):SourceWorkbenchDirectoryReply {
 const v=localSourceWritesDataSnapshot(input,32768,4096);
 if(!localSourceWritesRecord(v,['version','type','purpose','requestId','sequence','authorityId','command','binding','ui','requestSha256','decision','nonce','validUntilMs','physical'])||!sha(v.requestSha256)||!['approved','rejected','revoked'].includes(String(v.decision)))return sourceWritesFail('GRANT_MISMATCH');
 const {requestSha256:_s,decision:_d,nonce:_n,validUntilMs:_t,physical:_p,...q}=v;captureSourceWorkbenchDirectoryRequest({...q,type:'workbench-directory-request',expiresAtMs:1});
 if(v.decision==='approved'?(!uuid(v.nonce)||!positive(v.validUntilMs)||v.physical===null||v.command==='revoke'):v.nonce!==null||v.validUntilMs!==null||v.physical!==null||v.decision==='revoked'&&v.command!=='revoke')return sourceWritesFail('GRANT_MISMATCH');
 return {...v,binding:captureSourceWorkbenchDirectoryBinding(v.binding),ui:captureSourceWorkbenchDirectoryUi(v.ui),physical:v.physical===null?null:captureSourceWorkbenchDirectoryPhysical(v.physical)} as unknown as SourceWorkbenchDirectoryReply;
}
export function assertSourceWorkbenchDirectoryReplyForRequest(input:SourceWorkbenchDirectoryReply,original:SourceWorkbenchDirectoryRequest):void {
 const r=captureSourceWorkbenchDirectoryReply(input),q=captureSourceWorkbenchDirectoryRequest(original);
 if(['requestId','sequence','authorityId','command'].some(k=>r[k as keyof typeof r]!==q[k as keyof typeof q])||r.requestSha256!==lyricsPhysicalDigest(q)||lyricsPhysicalDigest(r.binding)!==lyricsPhysicalDigest(q.binding)||lyricsPhysicalDigest(r.ui)!==lyricsPhysicalDigest(q.ui)||r.decision==='approved'&&r.validUntilMs!>q.binding.expiresAtMs)return sourceWritesFail('GRANT_MISMATCH');
}
export function captureSourceWorkbenchDirectoryRegistration(input:unknown,binding:SourceWorkbenchDirectoryBinding):SourceWorkbenchDirectoryRegistration {
 const v=localSourceWritesDataSnapshot(input,8192,4096);
 if(binding.kind==='cue'){if(!localSourceWritesRecord(v,['kind','choiceId','revision'])||v.kind!=='cue'||v.choiceId!==binding.choiceId||v.revision!==binding.revision)return sourceWritesFail('GRANT_MISMATCH');}
 else{if(!localSourceWritesRecord(v,['kind','choice'])||v.kind!=='library'||!localSourceWritesRecord(v.choice,['choiceId','label','suggestedRole','evidence'])||v.choice.choiceId!==binding.choiceId||typeof v.choice.label!=='string'||!v.choice.label||v.choice.label.startsWith('/')||typeof v.choice.suggestedRole!=='string'||!['catalog','artist','album','container'].includes(v.choice.suggestedRole)||!Array.isArray(v.choice.evidence)||v.choice.evidence.length>16||v.choice.evidence.some(x=>typeof x!=='string'||x.length>512||/[\x00-\x1f\x7f]/u.test(x)))return sourceWritesFail('GRANT_MISMATCH');}
 return v as unknown as SourceWorkbenchDirectoryRegistration;
}
export function captureSourceWorkbenchDirectoryRegistrationRequest(input:unknown):SourceWorkbenchDirectoryRegistrationRequest {
 const v=localSourceWritesDataSnapshot(input,16384,4096);
 if(!localSourceWritesRecord(v,['version','type','purpose','requestId','sequence','command','binding','expiresAtMs'])||v.version!==1||v.type!=='workbench-directory-registration-request'||v.purpose!==WORKBENCH_DIRECTORY_PURPOSE||!uuid(v.requestId)||!positive(v.sequence)||!['register','release'].includes(String(v.command))||!positive(v.expiresAtMs))return sourceWritesFail('GRANT_MISMATCH');
 return {...v,binding:captureSourceWorkbenchDirectoryBinding(v.binding)} as unknown as SourceWorkbenchDirectoryRegistrationRequest;
}
export function captureSourceWorkbenchDirectoryRegistrationReply(input:unknown):SourceWorkbenchDirectoryRegistrationReply {
 const v=localSourceWritesDataSnapshot(input,16384,4096);
 if(!localSourceWritesRecord(v,['version','type','purpose','requestId','sequence','command','binding','requestSha256','ok'],['result','failure'])||v.version!==1||v.type!=='workbench-directory-registration-reply'||v.purpose!==WORKBENCH_DIRECTORY_PURPOSE||!uuid(v.requestId)||!positive(v.sequence)||!['register','release'].includes(String(v.command))||!sha(v.requestSha256)||typeof v.ok!=='boolean'||(v.ok?Object.hasOwn(v,'failure'):Object.hasOwn(v,'result')||!['NOT_READY','INVALID_INPUT','TIMEOUT','UNKNOWN'].includes(String(v.failure))))return sourceWritesFail('GRANT_MISMATCH');
 const binding=captureSourceWorkbenchDirectoryBinding(v.binding);
 if(v.ok){if(v.command==='register')captureSourceWorkbenchDirectoryRegistration(v.result,binding);else if(!localSourceWritesRecord(v.result,['choiceId','revision','revoked','physicalClosed'])||v.result.choiceId!==binding.choiceId||v.result.revision!==binding.revision||v.result.revoked!==true||v.result.physicalClosed!==true)return sourceWritesFail('GRANT_MISMATCH');}
 return {...v,binding} as unknown as SourceWorkbenchDirectoryRegistrationReply;
}
export function assertSourceWorkbenchDirectoryRegistrationReplyForRequest(input:SourceWorkbenchDirectoryRegistrationReply,original:SourceWorkbenchDirectoryRegistrationRequest):void {
 const r=captureSourceWorkbenchDirectoryRegistrationReply(input),q=captureSourceWorkbenchDirectoryRegistrationRequest(original);
 if(['requestId','sequence','command'].some(k=>r[k as keyof typeof r]!==q[k as keyof typeof q])||r.requestSha256!==lyricsPhysicalDigest(q)||lyricsPhysicalDigest(r.binding)!==lyricsPhysicalDigest(q.binding))return sourceWritesFail('GRANT_MISMATCH');
}
interface DirectoryActorState {port:MessagePort;sequence:number;fatal:boolean;seen:WeakSet<object>;revoked:Set<string>;pending:Map<string,{request:SourceWorkbenchDirectoryRequest;signal:AbortSignal;timer:ReturnType<typeof setTimeout>;cancel():void;resolve(v:SourceWorkbenchDirectoryApproval):void;reject(e:unknown):void}>}
const directoryActors=new WeakMap<object,DirectoryActorState>(),directoryApprovals=new WeakMap<object,{actor:SourceWritesMainActor;request:SourceWorkbenchDirectoryRequest;reply:SourceWorkbenchDirectoryReply}>();
function poisonDirectory(s:DirectoryActorState):void{if(s.fatal)return;s.fatal=true;for(const p of s.pending.values()){clearTimeout(p.timer);p.signal.removeEventListener('abort',p.cancel);p.reject(new Error('目录物理许可未知。'));}s.pending.clear();s.port.close();}
function installWorkbenchDirectory(actor:SourceWritesMainActor,port:MessagePort):void {
 const s:DirectoryActorState={port,sequence:0,fatal:false,seen:new WeakSet(),revoked:new Set(),pending:new Map()};directoryActors.set(actor,s);
 port.on('message',raw=>{if(!isSourceWorkbenchDirectoryWire(raw,'reply'))return;try{const r=captureSourceWorkbenchDirectoryReply(raw),p=s.pending.get(r.requestId);if(s.fatal||!actor.active||!p||p.signal.aborted||Date.now()>=p.request.expiresAtMs)return sourceWritesFail('GRANT_MISMATCH');assertSourceWorkbenchDirectoryReplyForRequest(r,p.request);if(r.decision==='approved'&&r.validUntilMs!<=Date.now())return sourceWritesFail('GRANT_MISMATCH');clearTimeout(p.timer);p.signal.removeEventListener('abort',p.cancel);s.pending.delete(r.requestId);s.seen.add(raw);if(r.decision==='rejected'){p.reject(new Error('目录原请求被Main拒绝。'));return;}if(r.decision==='revoked')s.revoked.add(r.binding.choiceId);const approval=Object.freeze({purpose:WORKBENCH_DIRECTORY_PURPOSE});directoryApprovals.set(approval,{actor,request:p.request,reply:r});p.resolve(approval);}catch{poisonDirectory(s);}});
 port.once('close',()=>poisonDirectory(s));port.once('messageerror',()=>poisonDirectory(s));
}
export function consumeSourceWorkbenchDirectoryReply(actor:SourceWritesMainActor,raw:unknown):boolean {
 if(!isSourceWorkbenchDirectoryWire(raw,'reply'))return false;const s=directoryActors.get(actor);assertSourceWritesMainActor(actor);if(!s||s.fatal||!raw||typeof raw!=='object'||!s.seen.has(raw)){if(s)poisonDirectory(s);return sourceWritesFail('GRANT_MISMATCH');}s.seen.delete(raw);return true;
}
export function requestWorkbenchDirectoryApproval(actor:SourceWritesMainActor,command:SourceWorkbenchDirectoryRequest['command'],binding:SourceWorkbenchDirectoryBinding,ui:SourceWorkbenchDirectoryUi,signal:AbortSignal,deadlineAtMs=performance.now()+2000):Promise<SourceWorkbenchDirectoryApproval> {
 assertSourceWritesMainActor(actor);const s=directoryActors.get(actor),remaining=Math.min(2000,Math.floor(deadlineAtMs-performance.now()),command==='revoke'?2000:binding.expiresAtMs-Date.now());if(!s||s.fatal||s.pending.size>=4||signal.aborted||remaining<=0||s.revoked.has(binding.choiceId))return Promise.reject(new Error('目录原请求已撤销。'));
 const q=captureSourceWorkbenchDirectoryRequest({version:1,type:'workbench-directory-request',purpose:WORKBENCH_DIRECTORY_PURPOSE,requestId:randomUUID(),sequence:++s.sequence,authorityId:actor.authorityId,command,binding,ui,expiresAtMs:Date.now()+remaining});
 return new Promise((resolve,reject)=>{const cancel=()=>poisonDirectory(s),timer=setTimeout(cancel,remaining);s.pending.set(q.requestId,{request:q,signal,timer,cancel,resolve,reject});signal.addEventListener('abort',cancel,{once:true});try{if(signal.aborted)cancel();else s.port.postMessage(q);}catch{poisonDirectory(s);}});
}
export function assertSourceWorkbenchDirectoryApproval(approval:unknown,actor:SourceWritesMainActor,binding:SourceWorkbenchDirectoryBinding,ui:SourceWorkbenchDirectoryUi):Readonly<SourceWorkbenchDirectoryPhysical> {
 assertSourceWritesMainActor(actor);const s=directoryActors.get(actor),p=approval&&typeof approval==='object'?directoryApprovals.get(approval):undefined;
 if(!s||s.fatal||s.revoked.has(binding.choiceId)||!p||p.actor!==actor||p.reply.decision!=='approved'||p.reply.validUntilMs!<=Date.now()||lyricsPhysicalDigest(p.reply.binding)!==lyricsPhysicalDigest(binding)||lyricsPhysicalDigest(p.reply.ui)!==lyricsPhysicalDigest(ui)||!p.reply.physical)return sourceWritesFail('GRANT_MISMATCH');
 return Object.freeze({...p.reply.physical});
}
export function invalidateSourceWorkbenchDirectory(actor:SourceWritesMainActor,binding:SourceWorkbenchDirectoryBinding):void{assertSourceWritesMainActor(actor);const s=directoryActors.get(actor);if(!s||s.fatal)return sourceWritesFail('GRANT_REQUIRED');s.revoked.add(binding.choiceId);}
