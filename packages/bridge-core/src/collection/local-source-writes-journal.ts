import { createHash } from 'node:crypto';
import * as dto from '@music-bridge/contracts';
import type { RootCapability } from '../recording/source-files.js';
import type { SourceFileAttributes, SourceBackupFact, SourcePublisherJournalFact } from './source-writes-publisher.js';
import type { SourceWriteFileObservation } from './source-write-verify.js';

export const SOURCE_WRITES_OPERATION='SOURCE_WRITES_V1';
export class SourceWritesError extends Error {constructor(readonly code:dto.LocalSourceWritesIssue){super(`源写操作拒绝：${code}。`);}}
export const sourceWritesFail=(issue:dto.LocalSourceWritesIssue):never=>{throw new SourceWritesError(issue);};
export const sourceWritesCanonical=(v:unknown,bytes=2097152):string=>dto.localSourceWritesCanonical(v,bytes,65536,2048,100);
export const sourceWritesHash=(v:unknown):string=>createHash('sha256').update(sourceWritesCanonical(v),'utf8').digest('hex');
export const sourceWritesRequestFingerprint=<C extends dto.LocalSourceWritesCommand>(command:C,payload:dto.LocalSourceWritesCommandPayloads[C]):string=>createHash('sha256').update(dto.localSourceWritesRequestCanonical(command,payload),'utf8').digest('hex');
const equal=(a:unknown,b:unknown):boolean=>sourceWritesCanonical(a)===sourceWritesCanonical(b);
const corrupt=():never=>sourceWritesFail('RECOVERY_REQUIRED');
export type SourceStoredObservation=Omit<SourceWriteFileObservation,'prefix'>;
export interface SourceWriteCapture {
  root:RootCapability; asset:dto.AudioAsset; track:dto.LocalTrack; libraryRoot:dto.LibraryRoot; relative:string;
  observation:SourceStoredObservation; attributes:SourceFileAttributes; fieldsBefore:Partial<Record<dto.LocalSourceWritesField,string[]>>;
  scan:{jobId:string;batchId:string;data:string}; protectionFingerprint:string; storageFingerprint:string;
  affectedTracks:dto.LocalTrack[]; parentPhysical:{dev:string;ino:string}; rootObservationFingerprint:string;
  directoryTarget:string|null; directoryBefore:{sha256:string;bytes:number;signature:string;physical:{dev:string;ino:string};permissionMode:string;birthtimeNs:string}|null;
  directoryAttributes:SourceFileAttributes|null;
  sourceAbsent:boolean; recoverySource:{root:RootCapability;relative:string;expectedSignature:string}|null;
  inverse:{originPlanId:string;originOperationId:string;backup:SourceBackupFact;expectedAfterSha256:string|null;removeTarget:boolean;restoreAttributes?:SourceFileAttributes|null}|null;
  sharedSources:{asset:dto.AudioAsset;relative:string;tracks:dto.LocalTrack[];signature:string;physical:{dev:string;ino:string}}[];
}
export interface SourceWritePrivateItem {item:dto.LocalSourceWritesItem;operation:dto.OrganizerFrozenOperation;capture:SourceWriteCapture}
export interface SourceWritesReadyBody {frozenHeader:Omit<dto.OrganizerFrozenBody,'operations'>;ownerEpoch:string;contextNonce:string;selectionFingerprint:string;itemContextHashes:string[]}
export interface SourceWriteFileFact {
  operationId:string; beforeAsset:dto.AudioAsset; afterAsset:dto.AudioAsset; fullRaw:dto.LocalMetadata;
  affectedTrackIds:string[]; observation:SourceStoredObservation; scanBefore:string;scanAfter:string;
  scanJobId:string;scanBatchId:string;replaceCommandId:string;backup:SourceBackupFact;
  rawProof:{parserVersion:string;sourceSha256:string;signature:string;fileRevision:string;fingerprint:string};
}
export interface SourceWriteDirectoryFact {operationId:string;relative:string;beforeSha256:string|null;after:import('./source-writes-publisher.js').SourcePublishedBlob|null;backup:SourceBackupFact}
interface Base {version:1;eventId:string;datasetId:string;planId:string|null;occurredAt:string;eventHash:string}
export type SourceWritesEvent=Base & (
  {kind:'receipt';command:dto.LocalSourceWritesReceiptCommand;request:dto.LocalSourceWritesCommandPayloads[dto.LocalSourceWritesReceiptCommand];requestFingerprint:string;receipt:dto.LocalSourceWritesReceipt;header:dto.LocalSourceWritesPlan|null;intent:dto.LocalSourceWritesIntent|null;ownerEpoch:string;policy:dto.LocalSourceWritesPolicy|null}
  | {kind:'item';index:number;value:SourceWritePrivateItem}
  | {kind:'ready';ready:SourceWritesReadyBody;planHash:string;contextFingerprint:string;readyAt:string;expiresAt:string;resources:number;backupBytes:string}
  | {kind:'state';state:dto.LocalSourceWritesState;issues:dto.LocalSourceWritesIssue[]}
  | {kind:'phase';fact:SourcePublisherJournalFact;item:dto.LocalSourceWritesItem}
  | {kind:'facts';fact:SourceWriteFileFact;item:dto.LocalSourceWritesItem}
  | {kind:'directory-facts';fact:SourceWriteDirectoryFact;item:dto.LocalSourceWritesItem}
  | {kind:'policy-quiet';policy:dto.LocalSourceWritesPolicy}
  | {kind:'recovery-resolved';recoveryPlanId:string;operationIds:string[]}
  | {kind:'protection-closed';operationIds:string[]}
  | {kind:'original';commandId:string;requestFingerprint:string;target:dto.LocalArtworkTarget;candidateId:string;original:dto.LocalArtworkImageInfo;contentRef:string;file:string}
);
export interface SourceStoredPlan {plan:dto.LocalSourceWritesPlan;intent:dto.LocalSourceWritesIntent;ownerEpoch:string;items:SourceWritePrivateItem[];ready:SourceWritesReadyBody|null;events:SourceWritesEvent[];phaseCounts:Map<string,number>}
/** 解决事件逐项闭合；一个成功恢复不能替没有处理的operation声明quiet。 */
export function sourceWritesUnresolvedOperations(stored:SourceStoredPlan):string[]{
  const resolved=new Set(stored.events.flatMap(e=>e.kind==='recovery-resolved'?e.operationIds:[]));
  const closed=new Set(stored.events.flatMap(e=>e.kind==='protection-closed'?e.operationIds:[]));
  // 恢复作业可在移交后、自己尚未移动文件时失败；它仍承担已认证根计划的持有义务。
  // 普通冷READY/PREVIEWING没有这份来源，不据UNKNOWN字符串伪造发布材料。
  const inherited=stored.plan.recoveryOf!==null&&stored.ready!==null&&stored.plan.state==='RECOVERY_REQUIRED';
  if(!inherited&&!stored.events.some(e=>e.kind==='phase'&&['CAPTURE_INTENT','CAPTURED','PUBLISH_INTENT','PUBLISHED','CLEANUP','VERIFIED','FACTS_COMMITTED'].includes(e.fact.phase)))return [];
  return stored.items.filter(item=>{
    const id=item.item.operationId;if(resolved.has(id))return false;
    const events=stored.events.filter((e):e is Extract<SourceWritesEvent,{kind:'phase'}>=>e.kind==='phase'&&e.fact.operationId===id);
    if(!inherited&&stored.plan.state!=='RECOVERY_REQUIRED'&&!events.some(e=>['CAPTURE_INTENT','CAPTURED','PUBLISH_INTENT','PUBLISHED','CLEANUP','VERIFIED','FACTS_COMMITTED','UNKNOWN'].includes(e.fact.phase)))return false;
    return stored.plan.state==='RECOVERY_REQUIRED'||item.item.state==='unknown'||events.at(-1)?.fact.phase!=='QUIET'||stored.plan.state==='COMPLETED'&&!closed.has(id);
  }).map(item=>item.item.operationId);
}
/** 公开恢复仍指唯一根计划；物理token的直接父链不是新的业务原件来源。 */
export function sourceWritesRecoveryRoot(projection:SourceWritesProjection,stored:SourceStoredPlan):SourceStoredPlan{
  if(!stored.plan.recoveryOf)return stored;const root=projection.plans.get(stored.plan.recoveryOf);
  if(!root||root.plan.recoveryOf||root.plan.datasetId!==stored.plan.datasetId||!root.ready)return corrupt();return root;
}
export function sourceWritesRootOperationId(stored:SourceStoredPlan,root:SourceStoredPlan,operationId:string):string{
  const item=stored.items.find(i=>i.item.operationId===operationId);if(!item)return corrupt();if(stored.plan.planId===root.plan.planId)return operationId;
  const inverse=item.capture.inverse,original=inverse?root.items.find(i=>i.item.operationId===inverse.originOperationId):undefined;
  if(stored.plan.recoveryOf!==root.plan.planId||!inverse||inverse.originPlanId!==root.plan.planId||!original||stored.plan.range!==root.plan.range
    ||item.item.assetId!==original.item.assetId||item.item.trackId!==original.item.trackId||item.capture.root.id!==original.capture.root.id||item.capture.root.path!==original.capture.root.path
    ||item.capture.relative!==original.capture.relative||item.capture.directoryTarget!==original.capture.directoryTarget||item.operation.kind!==original.operation.kind)return corrupt();
  const backed=root.events.find((e):e is Extract<SourceWritesEvent,{kind:'phase'}>=>e.kind==='phase'&&e.fact.operationId===original.item.operationId&&e.fact.phase==='BACKUP');
  const bytes=original.capture.directoryTarget?original.capture.directoryBefore?.bytes??0:original.capture.observation.bytes,hash=original.capture.directoryTarget?original.capture.directoryBefore?.sha256??createHash('sha256').update(Buffer.alloc(0)).digest('hex'):original.capture.observation.sha256;
  const originalAttributes=original.capture.directoryTarget?original.capture.directoryAttributes:original.capture.attributes;
  if(!backed||inverse.backup.path!==backed.fact.backup||inverse.backup.sha256!==hash||inverse.backup.bytes!==bytes||inverse.removeTarget!==(!!original.capture.directoryTarget&&original.capture.directoryBefore===null)
    ||Object.hasOwn(inverse,'restoreAttributes')&&!equal(inverse.restoreAttributes,originalAttributes)
    ||backed.fact.backupAttributes&&!equal(inverse.backup.attributes,backed.fact.backupAttributes))return corrupt();return original.item.operationId;
}
/** 原始完整捕获也计入 context；item 的 Hash 不是其字节预算的替身。 */
export function sourceWritesPlanContext(stored:Pick<SourceStoredPlan,'plan'|'items'>,ready:SourceWritesReadyBody,expiresAt:string){return {datasetId:stored.plan.datasetId,planId:stored.plan.planId,range:stored.plan.range,policyRevision:stored.plan.policyRevision,expiresAt,ready,captures:stored.items.map(i=>i.capture),publicItems:stored.items.map(i=>i.item)};}
export interface SourceWritesProjection {
  events:SourceWritesEvent[];plans:Map<string,SourceStoredPlan>;receipts:Map<string,Extract<SourceWritesEvent,{kind:'receipt'}>>;
  policy:Map<string,dto.LocalSourceWritesPolicy>; originals:Map<string,Extract<SourceWritesEvent,{kind:'original'}>>;
  fullRaw:Map<string,{fields:dto.LocalMetadata;ledgerOrdinal:number}>; scanFacts:Map<string,{fact:SourceWriteFileFact;ledgerOrdinal:number}>;
  ids:Set<string>;bytes:number;highWater:number;fingerprint:string;
}
export interface SourceWritesReadView {readonly projection:SourceWritesProjection;receipt(commandId:string,fingerprint:string):SourceWritesEvent|null}
export interface SourceWritesWriteView extends SourceWritesReadView {append(event:SourceWritesEvent):void;finalize(event:Extract<SourceWritesEvent,{kind:'facts'}>):dto.AudioAsset}
export const emptySourceWritesProjection=():SourceWritesProjection=>({events:[],plans:new Map(),receipts:new Map(),policy:new Map(),originals:new Map(),fullRaw:new Map(),scanFacts:new Map(),ids:new Set(),bytes:0,highWater:0,fingerprint:sourceWritesHash({domain:SOURCE_WRITES_OPERATION,empty:true})});
export function copySourceWritesProjection(p:SourceWritesProjection):SourceWritesProjection{
  return {...p,events:[...p.events],plans:new Map([...p.plans].map(([key,value])=>[key,{...value,plan:structuredClone(value.plan),items:structuredClone(value.items),events:[...value.events],phaseCounts:new Map(value.phaseCounts)}])),receipts:new Map(p.receipts),policy:new Map(p.policy),originals:new Map(p.originals),fullRaw:new Map(p.fullRaw),scanFacts:new Map(p.scanFacts),ids:new Set(p.ids)};
}
export const sourceWritesPolicy=(p:SourceWritesProjection,datasetId:string):dto.LocalSourceWritesPolicy=>structuredClone(p.policy.get(datasetId)??dto.LOCAL_SOURCE_WRITES_DEFAULT_POLICY);
export function sourceWritesEvent<T extends Omit<SourceWritesEvent,'eventHash'>>(body:T):T&{eventHash:string}{return {...body,eventHash:sourceWritesHash(body)};}
function observation(v:unknown):v is SourceStoredObservation{
  if(!dto.localSourceWritesRecord(v,['sha256','bytes','audioStart','audioPayloadSha256','signature','birthtimeNs','permissionMode','physical','profile']))return false;
  return [v.sha256,v.audioPayloadSha256].every(dto.isLocalSourceWritesHash)&&Number.isSafeInteger(v.bytes)&&Number(v.bytes)>0&&Number(v.bytes)<=268435456&&Number.isSafeInteger(v.audioStart)&&Number(v.audioStart)>0&&Number(v.audioStart)<Number(v.bytes)&&typeof v.signature==='string'&&v.signature.length<=256&&typeof v.birthtimeNs==='string'&&typeof v.permissionMode==='string'&&dto.localSourceWritesRecord(v.physical,['dev','ino'])&&[v.physical.dev,v.physical.ino].every(x=>typeof x==='string'&&/^\d{1,32}$/u.test(x))&&(dto.LOCAL_SOURCE_WRITES_PROFILES as readonly unknown[]).includes(v.profile);
}
function capture(v:unknown):v is SourceWriteCapture{
  if(!dto.localSourceWritesRecord(v,['root','asset','track','libraryRoot','relative','observation','attributes','fieldsBefore','scan','protectionFingerprint','storageFingerprint','affectedTracks','parentPhysical','rootObservationFingerprint','directoryTarget','directoryBefore','directoryAttributes','sourceAbsent','recoverySource','inverse','sharedSources']))return false;
  const c=v as unknown as SourceWriteCapture;
  return dto.isAudioAsset(c.asset)&&dto.isLocalTrack(c.track)&&dto.isLibraryRoot(c.libraryRoot)&&c.track.assetId===c.asset.id&&c.asset.libraryRootId===c.libraryRoot.id&&root(c.root)&&c.asset.sourceRootId===c.root.id&&relative(c.relative)&&observation(c.observation)
    &&[c.protectionFingerprint,c.storageFingerprint,c.rootObservationFingerprint].every(dto.isLocalSourceWritesHash)&&Array.isArray(c.affectedTracks)&&c.affectedTracks.length>=1&&c.affectedTracks.length<=100&&c.affectedTracks.every(t=>dto.isLocalTrack(t)&&t.assetId===c.asset.id&&t.segment===null)
    &&attributes(c.attributes)&&physical(c.parentPhysical)&&dto.localSourceWritesRecord(c.scan,['jobId','batchId','data'])&&[c.scan.jobId,c.scan.batchId].every(dto.isCollectionId)&&typeof c.scan.data==='string'&&Buffer.byteLength(c.scan.data)<=16384
    &&dto.localSourceWritesRecord(c.fieldsBefore,[],dto.LOCAL_SOURCE_WRITES_FIELDS)&&Object.values(c.fieldsBefore).every(values=>Array.isArray(values)&&values.length<=2048&&values.every(x=>typeof x==='string'&&x.length<=1024))
    &&(c.directoryTarget===null||relative(c.directoryTarget))&&(c.directoryBefore===null||blob(c.directoryBefore))&&(c.directoryAttributes===null||attributes(c.directoryAttributes))
    &&typeof c.sourceAbsent==='boolean'&&(!c.sourceAbsent||c.recoverySource!==null&&c.inverse!==null&&c.directoryTarget===null)&&(!c.recoverySource||dto.localSourceWritesRecord(c.recoverySource,['root','relative','expectedSignature'])&&root(c.recoverySource.root)&&relative(c.recoverySource.relative)&&typeof c.recoverySource.expectedSignature==='string'&&c.recoverySource.expectedSignature.length<=256)
    &&(c.inverse===null||dto.localSourceWritesRecord(c.inverse,['originPlanId','originOperationId','backup','expectedAfterSha256','removeTarget'],['restoreAttributes'])&&[c.inverse.originPlanId,c.inverse.originOperationId].every(dto.isCollectionId)&&backup(c.inverse.backup)&&(c.inverse.expectedAfterSha256===null||dto.isLocalSourceWritesHash(c.inverse.expectedAfterSha256))&&typeof c.inverse.removeTarget==='boolean'
      &&(!Object.hasOwn(c.inverse,'restoreAttributes')||(c.inverse.restoreAttributes===null?c.inverse.removeTarget:!c.inverse.removeTarget&&attributes(c.inverse.restoreAttributes))))
    &&Array.isArray(c.sharedSources)&&c.sharedSources.length<=200&&c.sharedSources.every(s=>dto.localSourceWritesRecord(s,['asset','relative','tracks','signature','physical'])&&dto.isAudioAsset(s.asset)&&relative(s.relative)&&typeof s.signature==='string'&&s.signature.length<=256&&physical(s.physical)&&Array.isArray(s.tracks)&&s.tracks.length<=200&&s.tracks.every(t=>dto.isLocalTrack(t)&&t.assetId===s.asset.id&&t.segment===null));
}
const relative=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=4096&&!v.startsWith('/')&&!/[\u0000-\u001f\u007f\\:]/u.test(v)&&v.split('/').every(p=>p&&p!=='.'&&p!=='..');
function root(v:unknown):v is RootCapability{return dto.localSourceWritesRecord(v,['id','path','dev','ino','authorized','label'])&&dto.isCollectionId(v.id)&&typeof v.path==='string'&&v.path.startsWith('/')&&v.path.length<=4096&&!v.path.includes('\0')&&[v.dev,v.ino].every(x=>typeof x==='string'&&/^(0|[1-9][0-9]{0,31})$/u.test(x))&&v.authorized===true&&typeof v.label==='string'&&v.label.length<=240;}
function attributes(v:unknown):v is SourceFileAttributes{
  if(!dto.localSourceWritesRecord(v,['mode','uid','gid','proof'],['provenance'])||![v.mode,v.uid,v.gid].every(x=>typeof x==='string'&&/^(0|[1-9][0-9]{0,15})$/u.test(x))||Number(v.mode)>4095)return false;
  if(v.proof==='MACOS_PROVENANCE_ONLY_ACL_FLAGS_V1')return dto.localSourceWritesRecord(v,['mode','uid','gid','proof','provenance'])&&dto.localSourceWritesRecord(v.provenance,['bytes','sha256'])&&v.provenance.bytes===11&&dto.isLocalSourceWritesHash(v.provenance.sha256);
  return dto.localSourceWritesRecord(v,['mode','uid','gid','proof'])&&(v.proof==='MACOS_EMPTY_XATTR_ACL_FLAGS_V1'||v.proof==='LINUX_EMPTY_XATTR_ACL_FLAGS_V1');
}
export function isSourceWritesEvent(input:unknown):input is SourceWritesEvent{
  try{
    const v=dto.localSourceWritesDataSnapshot(input,65536,12000,2048,100);if(!dto.localSourceWritesRecord(v,['version','kind','eventId','datasetId','planId','occurredAt','eventHash'],['command','request','requestFingerprint','receipt','header','intent','ownerEpoch','policy','index','value','ready','planHash','contextFingerprint','readyAt','expiresAt','resources','backupBytes','state','issues','fact','item','commandId','target','candidateId','original','contentRef','file','recoveryPlanId','operationIds']))return false;
    if(v.version!==1||!dto.isCollectionId(v.eventId)||!dto.isLocalSourceWritesDatasetId(v.datasetId)||!(v.planId===null||dto.isCollectionId(v.planId))||typeof v.occurredAt!=='string'||new Date(v.occurredAt).toISOString()!==v.occurredAt||!dto.isLocalSourceWritesHash(v.eventHash))return false;
    const base=['version','kind','eventId','datasetId','planId','occurredAt','eventHash'];
    const variants:Record<string,string[]>={receipt:['command','request','requestFingerprint','receipt','header','intent','ownerEpoch','policy'],item:['index','value'],ready:['ready','planHash','contextFingerprint','readyAt','expiresAt','resources','backupBytes'],state:['state','issues'],phase:['fact','item'],facts:['fact','item'],'directory-facts':['fact','item'],'policy-quiet':['policy'],original:['commandId','requestFingerprint','target','candidateId','original','contentRef','file'],'recovery-resolved':['recoveryPlanId','operationIds'],'protection-closed':['operationIds']};
    if(typeof v.kind!=='string'||!Object.hasOwn(variants,v.kind)||!dto.localSourceWritesRecord(v,[...base,...variants[v.kind]!]))return false;
    if(v.kind==='receipt'){
      if(!dto.isLocalSourceWritesCommand(v.command)||!dto.isLocalSourceWritesCommandPayload(v.command,v.request)||!dto.isLocalSourceWritesReceipt(v.receipt)||v.receipt.command!==v.command||v.receipt.requestFingerprint!==v.requestFingerprint||v.receipt.datasetId!==v.datasetId||v.receipt.planId!==v.planId||sourceWritesRequestFingerprint(v.command,v.request as never)!==v.requestFingerprint||!dto.isCollectionId(v.ownerEpoch))return false;
      if(v.header!==null&&(!dto.isLocalSourceWritesPlan(v.header)||v.header.state!=='PREVIEWING'||v.header.items.length||v.header.planId!==v.planId||!dto.isLocalSourceWritesIntent(v.intent)))return false;
      if(v.header!==null&&v.command!=='localSourceWrites.preview'&&v.command!=='localSourceWrites.undo'||v.receipt.outcome==='accepted'&&(v.command==='localSourceWrites.confirm'||v.command==='localSourceWrites.cancel')&&v.planId!==(v.request as dto.ConfirmLocalSourceWrites).planId)return false;
      if(v.policy!==null&&!dto.isLocalSourceWritesPolicy(v.policy))return false;
    }else if(v.kind==='item'){
      if(!Number.isSafeInteger(v.index)||Number(v.index)<0||Number(v.index)>=100||!dto.localSourceWritesRecord(v.value,['item','operation','capture'])||!capture(v.value.capture)||!dto.isOrganizerFrozenOperation(v.value.operation))return false;
    }else if(v.kind==='ready'){
      if(!dto.localSourceWritesRecord(v.ready,['frozenHeader','ownerEpoch','contextNonce','selectionFingerprint','itemContextHashes'])||!dto.isCollectionId(v.ready.ownerEpoch)||![v.ready.contextNonce,v.ready.selectionFingerprint].every(dto.isLocalSourceWritesHash)||!Array.isArray(v.ready.itemContextHashes)||!v.ready.itemContextHashes.every(dto.isLocalSourceWritesHash)||!dto.isLocalSourceWritesHash(v.planHash)||!dto.isLocalSourceWritesHash(v.contextFingerprint)||typeof v.readyAt!=='string'||typeof v.expiresAt!=='string'||Date.parse(v.expiresAt)-Date.parse(v.readyAt)!==600000||!Number.isSafeInteger(v.resources)||Number(v.resources)<1||typeof v.backupBytes!=='string')return false;
    }else if(v.kind==='state'){
      if(!(dto.LOCAL_SOURCE_WRITES_STATES as readonly unknown[]).includes(v.state)||!Array.isArray(v.issues)||!v.issues.every(dto.isLocalSourceWritesIssue))return false;
    }else if(v.kind==='phase'){
      if(!dto.localSourceWritesRecord(v.fact,['operationId','phase','backup','quarantine','stage','beforeSha256','afterSha256'],['backupAttributes'])||!dto.isCollectionId(v.fact.operationId)||typeof v.fact.phase!=='string'||!['BACKUP','STAGED','CAPTURE_INTENT','CAPTURED','PUBLISH_INTENT','PUBLISHED','CLEANUP','VERIFIED','FACTS_COMMITTED','QUIET','UNKNOWN'].includes(v.fact.phase)||![v.fact.backup,v.fact.quarantine,v.fact.stage].every(p=>typeof p==='string'&&p.startsWith('/')&&p.length<=4096&&!p.includes('\0'))||![v.fact.beforeSha256,v.fact.afterSha256].every(h=>h===null||dto.isLocalSourceWritesHash(h))||Object.hasOwn(v.fact,'backupAttributes')&&(v.fact.phase!=='BACKUP'||!attributes(v.fact.backupAttributes)||v.fact.backupAttributes.mode!==String(0o600)))return false;
    }else if(v.kind==='facts'){
      if(!dto.localSourceWritesRecord(v.fact,['operationId','beforeAsset','afterAsset','fullRaw','affectedTrackIds','observation','scanBefore','scanAfter','scanJobId','scanBatchId','replaceCommandId','backup','rawProof'])||!dto.isCollectionId(v.fact.operationId)||!dto.isAudioAsset(v.fact.beforeAsset)||!dto.isAudioAsset(v.fact.afterAsset)||!dto.isLocalMetadata(v.fact.fullRaw)||!observation(v.fact.observation)||!Array.isArray(v.fact.affectedTrackIds)||!v.fact.affectedTrackIds.every(dto.isCollectionId)||typeof v.fact.scanBefore!=='string'||typeof v.fact.scanAfter!=='string'||!backup(v.fact.backup)||!dto.localSourceWritesRecord(v.fact.rawProof,['parserVersion','sourceSha256','signature','fileRevision','fingerprint']))return false;
    }else if(v.kind==='directory-facts'){
      if(!dto.localSourceWritesRecord(v.fact,['operationId','relative','beforeSha256','after','backup'])||!dto.isCollectionId(v.fact.operationId)||typeof v.fact.relative!=='string'||!(v.fact.beforeSha256===null||dto.isLocalSourceWritesHash(v.fact.beforeSha256))||!backup(v.fact.backup)||v.fact.after!==null&&!blob(v.fact.after))return false;
    }else if(v.kind==='policy-quiet'){
      if(v.planId!==null||!dto.isLocalSourceWritesPolicy(v.policy)||v.policy.enabled||v.policy.draining)return false;
    }else if(v.kind==='recovery-resolved'){
      if(!dto.isCollectionId(v.recoveryPlanId)||!Array.isArray(v.operationIds)||!v.operationIds.length||v.operationIds.length>100||!v.operationIds.every(dto.isCollectionId)||new Set(v.operationIds).size!==v.operationIds.length)return false;
    }else if(v.kind==='protection-closed'){
      if(!Array.isArray(v.operationIds)||!v.operationIds.length||v.operationIds.length>100||!v.operationIds.every(dto.isCollectionId)||new Set(v.operationIds).size!==v.operationIds.length)return false;
    }else if(v.kind==='original'){
      if(![v.commandId,v.candidateId,v.contentRef].every(dto.isCollectionId)||!dto.isLocalArtworkTarget(v.target)||!dto.isLocalSourceWritesHash(v.requestFingerprint)||typeof v.file!=='string'||v.file.length>4096||!dto.localSourceWritesRecord(v.original,['mime','bytes','sha256','width','height'])||!['image/png','image/jpeg'].includes(String(v.original.mime))||!dto.isLocalSourceWritesHash(v.original.sha256)||!Number.isSafeInteger(v.original.bytes)||Number(v.original.bytes)<1||Number(v.original.bytes)>4194304||!Number.isSafeInteger(v.original.width)||!Number.isSafeInteger(v.original.height)||Number(v.original.width)<1||Number(v.original.height)<1||Number(v.original.width)>4096||Number(v.original.height)>4096||Number(v.original.width)*Number(v.original.height)>16777216)return false;
    }else return false;
    const {eventHash,...body}=v;return sourceWritesHash(body)===eventHash;
  }catch{return false;}
}
function backup(v:unknown):v is SourceBackupFact{return dto.localSourceWritesRecord(v,['path','sha256','bytes','physical'],['attributes'])&&typeof v.path==='string'&&v.path.length<=4096&&dto.isLocalSourceWritesHash(v.sha256)&&Number.isSafeInteger(v.bytes)&&Number(v.bytes)>=0&&Number(v.bytes)<=268435456&&physical(v.physical)&&(!Object.hasOwn(v,'attributes')||attributes(v.attributes)&&v.attributes.mode===String(0o600));}
function physical(v:unknown):boolean{return dto.localSourceWritesRecord(v,['dev','ino'])&&[v.dev,v.ino].every(x=>typeof x==='string'&&/^(0|[1-9][0-9]{0,31})$/u.test(x));}
function blob(v:unknown):boolean{return dto.localSourceWritesRecord(v,['sha256','bytes','signature','physical','permissionMode','birthtimeNs'])&&dto.isLocalSourceWritesHash(v.sha256)&&Number.isSafeInteger(v.bytes)&&Number(v.bytes)>0&&Number(v.bytes)<=4194304&&typeof v.signature==='string'&&v.signature.length<=256&&physical(v.physical)&&typeof v.permissionMode==='string'&&typeof v.birthtimeNs==='string';}
export const sourceWritesLedgerId=(e:SourceWritesEvent):string=>e.kind==='receipt'?e.request.commandId:e.kind==='original'?e.commandId:e.eventId;
export const sourceWritesLedgerFingerprint=(e:SourceWritesEvent):string=>e.kind==='receipt'||e.kind==='original'?e.requestFingerprint:e.eventHash;
export function sourceWritesLedgerRow(e:SourceWritesEvent):Record<string,string>{
  if(!isSourceWritesEvent(e))return sourceWritesFail('INVALID_REQUEST');const row={command_id:sourceWritesLedgerId(e),fingerprint:sourceWritesLedgerFingerprint(e),operation:SOURCE_WRITES_OPERATION,request:sourceWritesCanonical(e),result:sourceWritesCanonical({version:1,eventId:e.eventId,eventHash:e.eventHash}),created_at:e.occurredAt};
  if(!dto.localSourceWritesJournalTextWithinBudget(row,e.kind==='phase'||e.kind==='state'||e.kind==='protection-closed'?'phase':e.kind==='item'?'item':'header'))return sourceWritesFail('BUDGET_EXCEEDED');return row;
}
export function readSourceWritesEvent(row:Record<string,unknown>):SourceWritesEvent{
  try{if(row.operation!==SOURCE_WRITES_OPERATION||typeof row.request!=='string')return corrupt();const event:unknown=JSON.parse(row.request);if(!isSourceWritesEvent(event))return corrupt();const expected=sourceWritesLedgerRow(event);if(Object.keys(expected).some(k=>row[k]!==expected[k]))return corrupt();return event;}catch{return corrupt();}
}
function bump(plan:dto.LocalSourceWritesPlan):void{const revision=(BigInt(plan.viewRevision)+1n).toString(),sequence=(BigInt(plan.journalSequence)+1n).toString();if(!dto.isLocalCatalogRevision(revision)||!dto.isLocalCatalogRevision(sequence))return sourceWritesFail('REVISION_EXHAUSTED');plan.viewRevision=revision;plan.journalSequence=sequence;}
export function projectSourceWritesEvent(p:SourceWritesProjection,e:SourceWritesEvent,ordinal:number):void{
  if(p.ids.has(e.eventId)||ordinal<=p.highWater)return corrupt();const row=sourceWritesLedgerRow(e),bytes=Object.values(row).reduce((n,v)=>n+Buffer.byteLength(v),0);if(p.bytes+bytes>67108864)return sourceWritesFail('BUDGET_EXCEEDED');
  if(e.kind==='receipt'){
    if(p.receipts.has(e.request.commandId))return corrupt();p.receipts.set(e.request.commandId,e);
    if(e.policy){const old=sourceWritesPolicy(p,e.datasetId);if(e.command!=='localSourceWrites.setPolicy'||!('expectedPolicyRevision'in e.request)||e.request.expectedPolicyRevision!==old.revision||BigInt(e.policy.revision)!==BigInt(old.revision)+1n)return corrupt();p.policy.set(e.datasetId,structuredClone(e.policy));}
    if(e.header){if(p.plans.has(e.header.planId)||e.intent===null)return corrupt();p.plans.set(e.header.planId,{plan:structuredClone(e.header),intent:structuredClone(e.intent),ownerEpoch:e.ownerEpoch,items:[],ready:null,events:[],phaseCounts:new Map()});}
  }else if(e.kind==='policy-quiet'){
    const old=sourceWritesPolicy(p,e.datasetId);if(!old.draining||old.enabled||e.policy.revision!==old.revision)return corrupt();p.policy.set(e.datasetId,structuredClone(e.policy));
  }else if(e.kind==='original'){
    if(p.originals.has(e.contentRef))return corrupt();p.originals.set(e.contentRef,e);
  }else {
    const stored=e.planId?p.plans.get(e.planId):undefined;if(!stored||stored.plan.datasetId!==e.datasetId||stored.events.length>=4096)return corrupt();
    if(e.kind==='item'){if(stored.plan.state!=='PREVIEWING'||e.index!==stored.items.length||stored.items.some(i=>i.item.operationId===e.value.item.operationId))return corrupt();stored.items.push(structuredClone(e.value));stored.plan.items.push(structuredClone(e.value.item));}
    else if(e.kind==='ready'){
      if(stored.ready||stored.plan.state!=='PREVIEWING'||!stored.items.length||stored.items.length!==e.ready.itemContextHashes.length)return corrupt();const body={...e.ready.frozenHeader,operations:stored.items.map(i=>i.operation)};
      if(!dto.isOrganizerFrozenBody(body)||sourceWritesHash(body)!==e.planHash||stored.items.some((i,n)=>sourceWritesHash(i.capture)!==e.ready.itemContextHashes[n]))return corrupt();
      const context=sourceWritesPlanContext(stored,e.ready,e.expiresAt);if(sourceWritesHash(context)!==e.contextFingerprint)return corrupt();const proposed={...stored.plan,readyAt:e.readyAt,expiresAt:e.expiresAt,planHash:e.planHash,contextFingerprint:e.contextFingerprint,state:'READY' as const,resourceSummary:{resources:e.resources,sharedTargets:new Set(stored.items.flatMap(i=>[...i.capture.affectedTracks.map(t=>t.id),...i.capture.sharedSources.flatMap(s=>s.tracks.map(t=>t.id))])).size,backupBytes:e.backupBytes,spaceVerified:true,protection:'verified' as const}};if(!dto.localSourceWritesCompletePlanWithinBudget({body,context,projection:proposed}))return corrupt();stored.ready=structuredClone(e.ready);Object.assign(stored.plan,proposed);
    }else if(e.kind==='recovery-resolved'){
      const root=sourceWritesRecoveryRoot(p,stored),recovered=p.plans.get(e.recoveryPlanId);
      if(!recovered||recovered.plan.datasetId!==e.datasetId||recovered.plan.recoveryOf!==root.plan.planId||recovered.plan.state!=='COMPLETED'||!recovered.ready||recovered.plan.planId===stored.plan.planId)return corrupt();
      const restored=new Set<string>();for(const item of recovered.items){const id=sourceWritesRootOperationId(recovered,root,item.item.operationId),original=root.items.find(i=>i.item.operationId===id)!;
        if(item.item.state!=='applied'||restored.has(id))return corrupt();const quiet=[...recovered.events].reverse().find(v=>v.kind==='phase'&&v.fact.operationId===item.item.operationId);if(quiet?.kind!=='phase'||quiet.fact.phase!=='QUIET')return corrupt();
        const facts=[...recovered.events].reverse().find((v):v is Extract<SourceWritesEvent,{kind:'facts'|'directory-facts'}>=>(v.kind==='facts'||v.kind==='directory-facts')&&v.fact.operationId===item.item.operationId);
        if(original.capture.directoryTarget){if(facts?.kind!=='directory-facts'||(facts.fact.after?.sha256??null)!==(original.capture.directoryBefore?.sha256??null))return corrupt();}
        else if(facts?.kind!=='facts'||facts.fact.observation.sha256!==original.capture.observation.sha256)return corrupt();restored.add(id);
      }
      if(e.operationIds.some(id=>!restored.has(sourceWritesRootOperationId(stored,root,id))))return corrupt();
      if(stored.events.some(v=>v.kind==='recovery-resolved'&&v.operationIds.some(id=>e.operationIds.includes(id))))return corrupt();
      const remaining=sourceWritesUnresolvedOperations(stored).filter(id=>!e.operationIds.includes(id));if(e.operationIds.some(id=>!sourceWritesUnresolvedOperations(stored).includes(id)))return corrupt();
      // 原计划的未知或已应用项保留历史事实；另一计划恢复原件不等于原计划零效应取消。
      stored.plan.summary=remaining.length?'部分原件已明确恢复，其他发布仍待核对':'原计划已中断，原件已由明确恢复计划恢复；保护收尾依真实终结记录核对';stored.plan.issues=remaining.length?['RECOVERY_REQUIRED']:[];stored.plan.recoveryChoices=[];stored.plan.state=remaining.length?'RECOVERY_REQUIRED':'FAILED';
    }else if(e.kind==='protection-closed'){
      if(!stored.ready||stored.events.some(v=>v.kind==='protection-closed'&&v.operationIds.some(id=>e.operationIds.includes(id))))return corrupt();
      for(const id of e.operationIds){const item=stored.items.find(i=>i.item.operationId===id),quiet=[...stored.events].reverse().find(v=>v.kind==='phase'&&v.fact.operationId===id);
        if(!item||!['applied','not-written'].includes(item.item.state)||quiet?.kind!=='phase'||quiet.fact.phase!=='QUIET'
          ||item.item.state==='applied'&&!stored.events.some(v=>(v.kind==='facts'||v.kind==='directory-facts')&&v.fact.operationId===id))return corrupt();}
    }else if(e.kind==='state'){
      if(stored.plan.state==='COMPLETED'&&e.state!=='RECOVERY_REQUIRED')return corrupt();stored.plan.state=e.state;stored.plan.issues=[...e.issues];
    }else{
      const id=e.fact.operationId,index=stored.items.findIndex(i=>i.item.operationId===id);if(index<0)return corrupt();const count=(stored.phaseCounts.get(id)??0)+1;if(count>32)return sourceWritesFail('BUDGET_EXCEEDED');stored.phaseCounts.set(id,count);
      const proposed=structuredClone(e.item),old=stored.items[index]!;const fixed=({state:_,phase:_p,currentFileRevision:_r,backup:_b,verification:_v,issue:_i,...identity}:dto.LocalSourceWritesItem)=>identity;if(!equal(fixed(proposed),fixed(old.item)))return corrupt();stored.items[index]!.item=proposed;stored.plan.items[index]=structuredClone(proposed);
      if(e.kind==='facts'||e.kind==='directory-facts'){
        const backed=stored.events.find((v):v is Extract<SourceWritesEvent,{kind:'phase'}>=>v.kind==='phase'&&v.fact.operationId===id&&v.fact.phase==='BACKUP');
        // 旧四/七键仍可只读投影；新属性事实必须与同项BACKUP的真实证明一致。
        if((e.fact.backup.attributes||backed?.fact.backupAttributes)&&(!backed||e.fact.backup.path!==backed.fact.backup||!equal(e.fact.backup.attributes,backed.fact.backupAttributes)))return corrupt();
      }
      if(e.kind==='facts'){
        const f=e.fact,c=old.capture;if(!equal(f.beforeAsset,c.asset)||f.afterAsset.id!==f.beforeAsset.id||BigInt(f.afterAsset.fileRevision)!==BigInt(f.beforeAsset.fileRevision)+1n||f.afterAsset.locationRevision!==f.beforeAsset.locationRevision||f.afterAsset.libraryRootId!==f.beforeAsset.libraryRootId||f.scanBefore!==c.scan.data||f.scanJobId!==c.scan.jobId||f.scanBatchId!==c.scan.batchId||!equal(f.affectedTrackIds,c.affectedTracks.map(t=>t.id)))return corrupt();
        const {fingerprint,...proof}=f.rawProof;if(proof.parserVersion!=='music-metadata-11.15.0/source-writes-full-v1'||proof.sourceSha256!==f.observation.sha256||proof.signature!==f.observation.signature||proof.fileRevision!==f.afterAsset.fileRevision||fingerprint!==sourceWritesHash({proof,fullRaw:f.fullRaw}))return corrupt();
        const scan=JSON.parse(f.scanAfter) as Record<string,unknown>;if(scan.signature!==f.observation.signature||scan.assetId!==f.afterAsset.id||scan.relative!==c.relative||scan.libraryRootId!==f.afterAsset.libraryRootId)return corrupt();
        for(const trackId of f.affectedTrackIds)p.fullRaw.set(trackId,{fields:structuredClone(f.fullRaw),ledgerOrdinal:ordinal});p.scanFacts.set(`${f.afterAsset.libraryRootId}/${c.relative}`,{fact:structuredClone(f),ledgerOrdinal:ordinal});
      }else if(e.kind==='directory-facts'){
        if(stored.plan.range!=='DIRECTORY_COVER'||e.fact.relative!==old.capture.directoryTarget||e.fact.beforeSha256!==(old.capture.directoryBefore?.sha256??null)||proposed.currentFileRevision!==old.item.expectedFileRevision)return corrupt();
      }
    }
    stored.events.push(e);bump(stored.plan);stored.plan.journalFingerprint=sourceWritesHash({previous:stored.plan.journalFingerprint,eventHash:e.eventHash});
    if(!dto.isLocalSourceWritesPlan(stored.plan))return corrupt();
  }
  p.ids.add(e.eventId);p.events.push(e);p.bytes+=bytes;p.highWater=ordinal;p.fingerprint=sourceWritesHash({previous:p.fingerprint,eventHash:e.eventHash,ordinal});
}
