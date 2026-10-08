import { randomUUID, randomBytes, createHmac, timingSafeEqual, createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { open, lstat, realpath, opendir, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import * as dto from '@music-bridge/contracts';
import type { CollectionRepository } from './repository.js';
import { createSourceProtectionService, type SourceProtectionEvidence } from '../recording/source-protection.js';
import { sourceRootAvailability, readonlySourceCandidateMetadata, withCheckedReadonlyMetadataSource, SourceFileError, MetadataLeaseReleaseError, type RootCapability, type PublicationSource } from '../recording/source-files.js';
import { PhysicalResourceBusy } from '../stream/physical-resource-locks.js';
import { LocalFactsCommitFatal } from '../stream/local-source-fence.js';
import { assertRetainedPhysicalWriteClaims, physicalWriteClaimDescriptors, releaseRetainedPhysicalWriteClaims, type PhysicalWriteClaims } from '../stream/physical-resource-claims.js';
import { acquireSourceNamespaceWrite, assertSourceNamespaceHeld, captureSourceNamespace, delegateSourceNamespaceRecovery, retainSourceNamespaceWrite, resolveSourceNamespaceRecovery, resolveSourceNamespaceOrigin, type SourceNamespaceOriginBinding, type SourceNamespaceHeldObservation, type SourceNamespaceRecoveryToken, type SourceNamespaceOperation } from '../stream/source-namespace-claims.js';
import { createLocalSourceWritesStore } from './local-source-writes-store.js';
import { createSourceOriginalStore, inspectSourceOriginal } from './source-original-store.js';
import { createSourceSafetyRepository, publishSourceWrites, sourcePublisherNamespaceOperations, holdSourceRecoveryPhysicalFiles, reconcileSourcePublishedStage, observeSourceFileAttributes, observeSourceBackupAttributes, sameSourceFileAttributes, observeSourcePublishedBlob, SourcePublisherError, SourcePublicationRecoveryRequired, type PublisherTarget, type SourcePublishedBlob, type SourceBackupFact, type SourceFileAttributes, type SourcePublisherNamespaceProtection } from './source-writes-publisher.js';
import { inspectSourceTagRegion, writeSourceTagRegion, SourceWriteFormatError, type SourceRegionChange } from './source-write-format.js';
import { observeSourceWriteFile, SourceWriteVerificationError, type SourceWriteFileObservation } from './source-write-verify.js';
import { sourceWriteFieldValues, readSourceFullRaw, SOURCE_FULL_RAW_PARSER } from './source-write-metadata.js';
import { assertSourceWritesMainActor, type SourceWritesMainActor } from './source-writes-authority.js';
import { sourceWritesEvent, sourceWritesLedgerRow, sourceWritesHash, sourceWritesCanonical, sourceWritesPlanContext, sourceWritesUnresolvedOperations, sourceWritesRecoveryRoot, sourceWritesRootOperationId, sourceWritesFail, sourceWritesRequestFingerprint, SourceWritesError, type SourceWritesEvent, type SourceWritePrivateItem, type SourceWriteCapture, type SourceStoredPlan, type SourceStoredObservation, type SourceWriteFileFact, type SourceWritesProjection } from './local-source-writes-journal.js';

interface Options {repository:CollectionRepository;datasetId:string;ownerEpoch?:string;assertCurrent():void;assertRecoveryCurrent?():void;beforeMedia?():Promise<void>;now?:()=>number}
interface Running {controller:AbortController;done:Promise<void>}
const equal=(a:unknown,b:unknown):boolean=>sourceWritesCanonical(a)===sourceWritesCanonical(b);
const storedObservation=({prefix:_,...observation}:SourceWriteFileObservation):SourceStoredObservation=>observation;
function issue(error:unknown):dto.LocalSourceWritesIssue {
  if(error instanceof SourceWritesError)return error.code;
  if(error instanceof PhysicalResourceBusy)return 'ACTIVE_READER';
  if(error instanceof LocalFactsCommitFatal)return 'COMMIT_UNKNOWN';
  if(error instanceof MetadataLeaseReleaseError)return 'RELEASE_UNKNOWN';
  if(error instanceof SourceWriteFormatError)return error.issue==='INSUFFICIENT_PADDING'?'INSUFFICIENT_PADDING':'UNSUPPORTED_TAGS';
  if(error instanceof SourceWriteVerificationError)return error.issue==='SOURCE_CHANGED_DURING_READ'?'SOURCE_CHANGED':'UNSUPPORTED_FORMAT';
  if(error instanceof SourceFileError)return error.code==='REVOKED'?'SOURCE_REVOKED':error.code==='SOURCE_ROOT_OFFLINE'?'SOURCE_OFFLINE':error.code==='CONTENT_CHANGED'?'SOURCE_CHANGED':'UNKNOWN_PROTECTION';
  if(error instanceof SourcePublisherError&&dto.isLocalSourceWritesIssue(error.issue))return error.issue;
  return 'INVENTORY_UNAVAILABLE';
}
const phases=new Set<dto.LocalSourceWritesState>(['PREVIEWING','READY','QUEUED','RUNNING','CANCEL_REQUESTED']);
/** 唯一 Owner 的持久受理与后台 I/O；公开 schema、Outbox 或字符串 grant 都不能开启原文件写入。 */
function composeLocalSourceWritesService(options:Options,test?:{phase?(fact:import('./source-writes-publisher.js').SourcePublisherJournalFact):void}){
  const repository=options.repository,now=options.now??Date.now,ownerEpoch=options.ownerEpoch??randomUUID();
  const store=createLocalSourceWritesStore(repository.localCatalog,now),directory=repository.privateSourceWritesDirectory();
  const safety=directory?createSourceSafetyRepository(path.join(directory,'safety')):null;
  let closing=false,fatal:unknown,closed:Promise<void>|undefined;
  const runs=new Map<string,Running>(),pending=new Set<Promise<unknown>>(),uncertain=new Map<string,SourcePublicationRecoveryRequired>();
  const namespaces=new Map<string,SourcePublisherNamespaceProtection>();let recoveryPreparation:Promise<void>|undefined,recoveryPrepared=false;
  const key=randomBytes(32),grants=new Map<string,{challenge:dto.LocalSourceWritesChallenge;actor:SourceWritesMainActor;consumed:boolean}>();
  const check=():void=>{options.assertCurrent();if(closing||fatal||!recoveryPrepared)return sourceWritesFail('INVENTORY_UNAVAILABLE');};
  const protection=createSourceProtectionService({store:repository.sourceProtection,datasetId:options.datasetId,assertCurrent:options.assertCurrent,sourceWrites:true});
  const originals=createSourceOriginalStore({datasetId:options.datasetId,directory:directory?path.join(directory,'originals'):'',assertCurrent:check,artwork:repository.localArtwork,
    read:()=>store.read(v=>[...v.projection.originals.values()]),cached:(id,fp)=>store.read(v=>{const e=v.receipt(id,fp);if(e&&e.kind!=='original')return sourceWritesFail('COMMAND_ID_REUSED');return e;}),append:e=>store.append(e)});
  function captureRequest<C extends dto.LocalSourceWritesCommand>(command:C,raw:unknown):dto.LocalSourceWritesCommandPayloads[C]{
    check();let captured:unknown;try{captured=dto.localSourceWritesDataSnapshot(raw,65536,8192);}catch{return sourceWritesFail('INVALID_REQUEST');}
    if(!dto.isLocalSourceWritesCommandPayload(command,captured))return sourceWritesFail('INVALID_REQUEST');if(captured.datasetId!==options.datasetId)return sourceWritesFail('DATASET_SCOPE_MISMATCH');return captured;
  }
  const policy=():dto.LocalSourceWritesPolicy=>store.policy(options.datasetId);
  function writingPolicy(expected?:string):dto.LocalSourceWritesPolicy {const value=policy();if(!value.enabled)return sourceWritesFail(value.draining?'POLICY_DRAINING':'POLICY_DISABLED');if(expected!==undefined&&value.revision!==expected)return sourceWritesFail('POLICY_CHANGED');return value;}
  function requiresRecovery(stored:SourceStoredPlan,projection?:SourceWritesProjection):boolean{
    return stored.plan.recoveryOf?sourceWritesUnresolvedOperations(stored).length>0:rootUnresolvedOperations(stored,projection).length>0;
  }
  recoveryPrepared=!store.read(v=>[...v.projection.plans.values()].some(p=>p.plan.datasetId===options.datasetId&&requiresRecovery(p)));
  function hasPersistedRecovery():boolean{return store.read(v=>[...v.projection.plans.values()].some(p=>p.plan.datasetId===options.datasetId&&requiresRecovery(p)));}
  function recoveryRoot(stored:SourceStoredPlan):SourceStoredPlan{return store.read(v=>sourceWritesRecoveryRoot(v.projection,stored));}
  function rootUnresolvedOperations(root:SourceStoredPlan,projection?:SourceWritesProjection):string[]{
    const ids=new Set(sourceWritesUnresolvedOperations(root)),collect=(v:SourceWritesProjection):void=>{for(const p of v.plans.values())if(p.plan.datasetId===root.plan.datasetId&&p.plan.recoveryOf===root.plan.planId)for(const id of sourceWritesUnresolvedOperations(p))ids.add(sourceWritesRootOperationId(p,root,id));};
    if(projection)collect(projection);else store.read(v=>collect(v.projection));return root.items.filter(i=>ids.has(i.item.operationId)).map(i=>i.item.operationId);
  }
  function assertRecoveryFamilyIdle(rootId:string,exceptPlanId?:string):void{
    if(store.read(v=>[...v.projection.plans.values()].some(p=>p.plan.datasetId===options.datasetId&&p.plan.planId!==exceptPlanId
      &&(p.plan.planId===rootId||p.plan.recoveryOf===rootId)&&runs.has(p.plan.planId))))return sourceWritesFail('POLICY_DRAINING');
  }
  function latestLineageAsset(root:SourceStoredPlan,rootOperationId:string):dto.AudioAsset{
    const original=root.items.find(i=>i.item.operationId===rootOperationId);if(!original)return sourceWritesFail('BACKUP_INVALID');let asset=original.capture.asset;
    store.read(v=>{for(const event of v.projection.events){if(event.kind!=='facts'||!event.planId)continue;const plan=v.projection.plans.get(event.planId);if(!plan?.ready||plan.plan.planId!==root.plan.planId&&plan.plan.recoveryOf!==root.plan.planId)continue;if(sourceWritesRootOperationId(plan,root,event.fact.operationId)===rootOperationId)asset=event.fact.afterAsset;}});return asset;
  }
  function lineageContentHashes(root:SourceStoredPlan,rootOperationId:string):Set<string|null>{
    const original=root.items.find(i=>i.item.operationId===rootOperationId);if(!original)return sourceWritesFail('BACKUP_INVALID');const hashes=new Set<string|null>([original.capture.directoryTarget?original.capture.directoryBefore?.sha256??null:original.capture.observation.sha256]);
    store.read(v=>{for(const event of v.projection.events){if(!event.planId||!['facts','directory-facts','phase'].includes(event.kind))continue;const plan=v.projection.plans.get(event.planId);if(!plan?.ready||plan.plan.planId!==root.plan.planId&&plan.plan.recoveryOf!==root.plan.planId)continue;
      if(event.kind==='facts'&&sourceWritesRootOperationId(plan,root,event.fact.operationId)===rootOperationId)hashes.add(event.fact.observation.sha256);
      else if(event.kind==='directory-facts'&&sourceWritesRootOperationId(plan,root,event.fact.operationId)===rootOperationId)hashes.add(event.fact.after?.sha256??null);
      else if(event.kind==='phase'&&sourceWritesRootOperationId(plan,root,event.fact.operationId)===rootOperationId&&event.fact.afterSha256!==null)hashes.add(event.fact.afterSha256);
    }});return hashes;
  }
  function namespaceBinding(stored:SourceStoredPlan):SourceNamespaceOriginBinding{
    if(!stored.ready||!stored.plan.planHash||!stored.plan.contextFingerprint)return sourceWritesFail('RECOVERY_REQUIRED');
    return Object.freeze({datasetId:options.datasetId,originPlanId:stored.plan.planId,planHash:stored.plan.planHash,contextFingerprint:stored.plan.contextFingerprint,journalSequence:stored.plan.journalSequence,projectionFingerprint:store.read(v=>v.projection.fingerprint)});
  }
  async function captureNamespaceOperations(stored:SourceStoredPlan,ids:readonly string[]):Promise<SourceNamespaceOperation[]>{
    return sourcePublisherNamespaceOperations(stored.items.filter(i=>ids.includes(i.item.operationId)).map(({item,capture:c})=>({operationId:item.operationId,root:c.root,relative:c.directoryTarget??c.relative,protectedSources:c.sharedSources.map(s=>({root:c.root,relative:s.relative,signature:s.signature,physical:s.physical}))})));
  }
  function namespaceObservation(originPlanId:string,operationId:string,source:Pick<PublicationSource,'root'|'relative'>):SourceNamespaceHeldObservation|undefined{
    const origin=store.plan(options.datasetId,originPlanId),root=recoveryRoot(origin),rootId=sourceWritesRootOperationId(origin,root,operationId),absolute=path.join(source.root.path,source.relative);
    for(const value of [...namespaces.values()].reverse()){
      if(value.token.state==='released'||value.scope.originBinding.originPlanId!==root.plan.planId)continue;const current=store.plan(options.datasetId,value.scope.planId);
      const match=value.scope.operations.find(v=>v.name.absolute===absolute&&sourceWritesRootOperationId(current,root,v.operationId)===rootId);
      if(match)return {token:value.token,datasetId:options.datasetId,planId:value.scope.planId,originBinding:value.scope.originBinding,operationId:match.operationId};
    }return undefined;
  }
  async function assertNamespaceObservation(value:SourceNamespaceHeldObservation|undefined,root:RootCapability,relative:string):Promise<void>{
    if(value)assertSourceNamespaceHeld(value.token,{datasetId:value.datasetId,planId:value.planId,originBinding:value.originBinding,operations:[{operationId:value.operationId,name:await captureSourceNamespace(root,relative)}]});
  }
  async function recoveryPhysicalSources(plans:readonly SourceStoredPlan[]):Promise<{root:RootCapability;relative:string;allowMissing:boolean}[]>{
    if(!directory)return sourceWritesFail('RECOVERY_REQUIRED');const result=new Map<string,{root:RootCapability;relative:string;allowMissing:boolean}>();
    const add=(root:RootCapability,relative:string,allowMissing:boolean):void=>{const absolute=path.join(root.path,relative),old=result.get(absolute);result.set(absolute,{root,relative,allowMissing:allowMissing&&(old?.allowMissing??true)});};
    for(const stored of plans)for(const item of stored.items.filter(i=>(stored.plan.recoveryOf?sourceWritesUnresolvedOperations(stored):rootUnresolvedOperations(stored)).includes(i.item.operationId))){const c=item.capture,current=repository.sources.root(c.root.id);
      if(!current.authorized||current.path!==c.root.path||current.dev!==c.root.dev||current.ino!==c.root.ino)return sourceWritesFail('UNKNOWN_PROTECTION');
      add(current,c.directoryTarget??c.relative,true);if(c.directoryTarget)add(current,c.relative,false);for(const shared of c.sharedSources)add(current,shared.relative,false);
      const phases=stored.events.filter((e):e is Extract<SourceWritesEvent,{kind:'phase'}>=>e.kind==='phase'&&e.fact.operationId===item.item.operationId);
      const area=path.join(directory,'safety',item.item.operationId);let stat:BigIntStats;
      try{stat=await lstat(area,{bigint:true});}catch(error){if(!phases.length&&(error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
      if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(area)!==area||(stat.mode&0o777n)!==0o700n||typeof process.getuid!=='function'||stat.uid!==BigInt(process.getuid()))return sourceWritesFail('BACKUP_INVALID');
      const privateRoot:RootCapability={id:randomUUID(),path:area,dev:String(stat.dev),ino:String(stat.ino),authorized:true,label:'认证journal的保全目录'};
      for(const event of phases){if(event.fact.backup!==path.join(area,'backup')||event.fact.stage!==path.join(area,'stage')||event.fact.quarantine!==path.join(area,'quarantine'))return sourceWritesFail('BACKUP_INVALID');}
      add(privateRoot,'backup',!phases.some(e=>e.fact.phase==='BACKUP'));add(privateRoot,'stage',true);
      const originallyPresent=c.directoryTarget?c.directoryBefore!==null:!c.sourceAbsent;
      add(privateRoot,'quarantine',!(originallyPresent&&phases.some(e=>['CAPTURED','PUBLISH_INTENT','PUBLISHED','CLEANUP','VERIFIED','FACTS_COMMITTED'].includes(e.fact.phase))));
    }if(result.size>2048)return sourceWritesFail('BUDGET_EXCEEDED');return [...result.values()];
  }
  async function installRecoveryProtection():Promise<void>{
    const assert=():void=>{(options.assertRecoveryCurrent??options.assertCurrent)();if(closing||fatal)return sourceWritesFail('INVENTORY_UNAVAILABLE');};assert();
    const snapshot=store.read(v=>({fingerprint:v.projection.fingerprint,plans:[...v.projection.plans.values()].filter(p=>p.plan.datasetId===options.datasetId)}));
    const groups=new Map<string,{root:SourceStoredPlan;plans:SourceStoredPlan[];rootIds:Set<string>}>();
    for(const stored of snapshot.plans.filter(p=>requiresRecovery(p))){const root=recoveryRoot(stored),entry=groups.get(root.plan.planId)??{root,plans:[],rootIds:new Set<string>()};entry.plans.push(stored);for(const id of sourceWritesUnresolvedOperations(stored))entry.rootIds.add(sourceWritesRootOperationId(stored,root,id));groups.set(root.plan.planId,entry);}
    for(const group of groups.values()){
      assert();const operations=await captureNamespaceOperations(group.root,[...group.rootIds]),binding=namespaceBinding(group.root),token=await acquireSourceNamespaceWrite({...binding,operations});retainSourceNamespaceWrite(token);
      const base:SourcePublisherNamespaceProtection={token,scope:{datasetId:options.datasetId,planId:group.root.plan.planId,originBinding:binding,operations},recovery:false};namespaces.set(group.root.plan.planId,base);let parent:SourcePublisherNamespaceProtection=base;
      for(const child of group.plans.filter(p=>p.plan.planId!==group.root.plan.planId)){
        const ids=sourceWritesUnresolvedOperations(child),named=await captureNamespaceOperations(child,ids),mapping=named.map(value=>{const id=sourceWritesRootOperationId(child,group.root,value.operationId),parentPlan=store.plan(options.datasetId,parent.scope.planId),previous=parent.scope.operations.find(p=>p.name.absolute===value.name.absolute&&sourceWritesRootOperationId(parentPlan,group.root,p.operationId)===id);if(!previous)return sourceWritesFail('RECOVERY_REQUIRED');return {...value,originOperationId:previous.operationId};});
        const delegated=delegateSourceNamespaceRecovery(parent.token,{datasetId:options.datasetId,originPlanId:parent.scope.planId,recoveryPlanId:child.plan.planId,originBinding:binding,operations:mapping});retainSourceNamespaceWrite(delegated);
        parent={token:delegated,scope:{datasetId:options.datasetId,planId:child.plan.planId,originBinding:binding,operations:named},recovery:true};namespaces.set(child.plan.planId,parent);
      }
      const namespaceCount=new Set(operations.flatMap(o=>o.name.resources.map(r=>`${r.dev}\0${r.absolute}`))).size;
      const claims=await holdSourceRecoveryPhysicalFiles(await recoveryPhysicalSources(group.plans),namespaceCount);assert();
      for(const stored of group.plans){const protection=namespaces.get(stored.plan.planId)??base;uncertain.set(stored.plan.planId,new SourcePublicationRecoveryRequired({outcome:'unknown',issue:'RECOVERY_REQUIRED',applied:stored.plan.items.filter(i=>i.state==='applied').map(i=>i.operationId)},claims,[],undefined,protection));}
      if(!uncertain.has(group.root.plan.planId))uncertain.set(group.root.plan.planId,new SourcePublicationRecoveryRequired({outcome:'unknown',issue:'RECOVERY_REQUIRED',applied:[]},claims,[],undefined,base));
      const rootAlreadyResolved=[...group.rootIds].filter(id=>!sourceWritesUnresolvedOperations(group.root).includes(id));if(rootAlreadyResolved.length)await resolveSourceNamespaceOrigin(token,rootAlreadyResolved);
    }
    assert();if(store.read(v=>v.projection.fingerprint)!==snapshot.fingerprint)return sourceWritesFail('RECOVERY_REQUIRED');recoveryPrepared=true;
  }
  function admitOrdinary():void {if(uncertain.size||hasPersistedRecovery())return sourceWritesFail('RECOVERY_REQUIRED');}
  function selected(target:dto.LocalSourceWritesTarget):dto.LocalTrack[]{
    const ids=target.mode==='single'?[target.trackId]:target.mode==='batch'?target.trackIds:repository.localCatalog.editionTracks(target.editionId).filter(e=>e.active).map(e=>e.trackId);
    if(!ids.length||ids.length>100||new Set(ids).size!==ids.length)return sourceWritesFail('BUDGET_EXCEEDED');const tracks=ids.map(id=>repository.localCatalog.track(id));
    if(new Set(tracks.map(t=>t.assetId)).size!==tracks.length)return sourceWritesFail('SHARED_RESOURCE_UNKNOWN');if(tracks.some(t=>t.segment!==null))return sourceWritesFail('SEGMENTED_SOURCE');return tracks;
  }
  function scopeFingerprint(intent:dto.LocalSourceWritesIntent):string {if(intent.kind==='recovery')return sourceWritesHash(intent);return sourceWritesHash({target:intent.target,tracks:selected(intent.target),relations:intent.target.mode==='edition'?repository.localCatalog.editionTracks(intent.target.editionId):[]});}
  function material(ref:dto.LocalSourceWritesArtworkRef,trackId:string):void {
    const context=repository.localArtwork.context({trackId,editionId:ref.editionId}),selection=context.selection;
    if(!selection||selection.id!==ref.selectionId||selection.revision!==ref.expectedSelectionRevision||selection.candidate?.id!==ref.candidateId||selection.candidate.original.sha256!==ref.originalSha256)return sourceWritesFail('ARTWORK_CHANGED');
  }
  function evidence(v:SourceProtectionEvidence):void {if(v.datasetId!==options.datasetId)return sourceWritesFail('DATASET_SCOPE_MISMATCH');if(v.state==='PROTECTED')return sourceWritesFail('FROZEN_SOURCE');if(v.state==='BUSY')return sourceWritesFail('ACTIVE_READER');if(!v.complete||v.state!=='CLEAR')return sourceWritesFail('UNKNOWN_PROTECTION');}
  function checkCapture(c:SourceWriteCapture):void {
    options.assertCurrent();const root=repository.localCatalog.root(c.libraryRoot.id),capability=repository.sources.root(c.root.id);
    if(!capability.authorized)return sourceWritesFail('SOURCE_REVOKED');if(!equal(root,c.libraryRoot)||!equal(capability,c.root)||!equal(repository.localCatalog.asset(c.asset.id),c.asset)||!equal(repository.localCatalog.track(c.track.id),c.track)||repository.localCatalog.privateAssetLocator(c.asset.id).relative!==c.relative)return sourceWritesFail('REVISION_CHANGED');
    if(!equal(repository.localCatalog.privateSourceWriteTracks(c.asset.id),c.affectedTracks))return sourceWritesFail('SHARED_RESOURCE_UNKNOWN');
    const scan=repository.localScan.privateSourceWriteFileState(c.libraryRoot.id,c.relative);if(!scan||scan.jobId!==c.scan.jobId||scan.batchId!==c.scan.batchId||scan.data!==c.scan.data)return sourceWritesFail('REVISION_CHANGED');
    for(const shared of c.sharedSources){if(!equal(repository.localCatalog.asset(shared.asset.id),shared.asset)||repository.localCatalog.privateAssetLocator(shared.asset.id).relative!==shared.relative||!equal(repository.localCatalog.privateSourceWriteTracks(shared.asset.id),shared.tracks))return sourceWritesFail('SHARED_RESOURCE_UNKNOWN');}
  }
  async function rootFingerprint(root:RootCapability,relative:string):Promise<{fingerprint:string;parent:{dev:string;ino:string}}> {
    if(await sourceRootAvailability(root)!=='ONLINE')return sourceWritesFail(root.authorized?'SOURCE_OFFLINE':'SOURCE_REVOKED');let current=root.path;const values=[];
    for(const part of ['',...relative.split('/').slice(0,-1)]){if(part)current=path.join(current,part);const s=await lstat(current,{bigint:true});if(!s.isDirectory()||s.isSymbolicLink()||await realpath(current)!==current)return sourceWritesFail('NAMESPACE_CONFLICT');values.push({dev:String(s.dev),ino:String(s.ino),mode:String(s.mode),uid:String(s.uid),gid:String(s.gid),birth:String(s.birthtimeNs)});}
    const last=values.at(-1)!;return {fingerprint:sourceWritesHash(values),parent:{dev:last.dev,ino:last.ino}};
  }
  async function observedFile<T>(root:RootCapability,relative:string,signal:AbortSignal,consume:(fd:FileHandle)=>Promise<T>,claims?:PhysicalWriteClaims,namespace?:SourceNamespaceHeldObservation):Promise<T>{
    await assertNamespaceObservation(namespace,root,relative);
    const named=await readonlySourceCandidateMetadata(root,relative);
    if(!claims)return withCheckedReadonlyMetadataSource(root,relative,named.signature,signal,consume,()=>{check();writingPolicy();});
    // 只能消费原publisher登记的真实性claims；普通Reader和IPC都没有这个入口。
    assertRetainedPhysicalWriteClaims(claims,[]);const rootNamespace=await rootFingerprint(root,relative),fd=await open(path.join(root.path,relative),constants.O_RDONLY|constants.O_NOFOLLOW);
    try{const stat=await fd.stat({bigint:true}),physical={dev:String(stat.dev),ino:String(stat.ino)};assertRetainedPhysicalWriteClaims(claims,[physical]);
      if([stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':')!==named.signature||stat.nlink!==1n||signal.aborted)return sourceWritesFail('SOURCE_CHANGED');
      const result=await consume(fd),after=await readonlySourceCandidateMetadata(root,relative);assertRetainedPhysicalWriteClaims(claims,[physical]);
      if(after.signature!==named.signature||(await rootFingerprint(root,relative)).fingerprint!==rootNamespace.fingerprint||signal.aborted)return sourceWritesFail('SOURCE_CHANGED');await assertNamespaceObservation(namespace,root,relative);check();return result;
    }finally{try{await fd.close();}catch{claims.retain();throw new MetadataLeaseReleaseError();}}
  }
  async function privateMaterialSource(absolute:string):Promise<PublicationSource>{
    if(!directory||!absolute.startsWith(`${path.join(directory,'safety')}${path.sep}`)||await realpath(absolute)!==absolute)return sourceWritesFail('BACKUP_INVALID');
    const parent=path.dirname(absolute),stat=await lstat(parent,{bigint:true});if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o777n)!==0o700n||typeof process.getuid!=='function'||stat.uid!==BigInt(process.getuid()))return sourceWritesFail('BACKUP_INVALID');
    const root={id:randomUUID(),path:parent,dev:String(stat.dev),ino:String(stat.ino),authorized:true,label:'已核对的私有恢复原件'},relative=path.basename(absolute),named=await readonlySourceCandidateMetadata(root,relative);return {root,relative,expectedSignature:named.signature};
  }
  async function observeTrack(track:dto.LocalTrack,signal:AbortSignal,privateSource?:{capture:SourceWriteCapture;backup:SourceBackupFact;expectedSha256:string|null}):Promise<{capture:SourceWriteCapture;file:SourceWriteFileObservation}> {
    const asset=repository.localCatalog.asset(track.assetId),libraryRoot=repository.localCatalog.root(asset.libraryRootId),root=repository.sources.root(asset.sourceRootId),relative=repository.localCatalog.privateAssetLocator(asset.id).relative;
    if(!root.authorized)return sourceWritesFail('SOURCE_REVOKED');if(track.segment!==null)return sourceWritesFail('SEGMENTED_SOURCE');if(libraryRoot.role!=='library'||libraryRoot.revision!==asset.rootRevision)return sourceWritesFail('REVISION_CHANGED');
    const scan=repository.localScan.privateSourceWriteFileState(libraryRoot.id,relative);if(!scan||scan.value.outcome!=='accepted'||scan.value.assetId!==asset.id||scan.value.trackId!==track.id||!scan.value.readFacts||scan.value.relative!==relative)return sourceWritesFail('SHARED_RESOURCE_UNKNOWN');
    const job=repository.localScan.get(scan.jobId);if(job.datasetId!==options.datasetId||job.rootRevision!==libraryRoot.revision||job.sourceRootId!==root.id)return sourceWritesFail('REVISION_CHANGED');
    const affectedTracks=repository.localCatalog.privateSourceWriteTracks(asset.id);if(!affectedTracks.length||affectedTracks.length>100||affectedTracks.some(t=>t.segment!==null))return sourceWritesFail('SEGMENTED_SOURCE');
    const retained=privateSource?.capture.inverse?uncertain.get(privateSource.capture.inverse.originPlanId)?.claims??undefined:undefined;
    const absent=!!privateSource&&privateSource.expectedSha256===null;let recoverySource:PublicationSource|null=null;
    let value:{file:SourceWriteFileObservation;attributes:SourceWriteCapture['attributes']};
    if(absent){try{await lstat(path.join(root.path,relative),{bigint:true});return sourceWritesFail('UNDO_CONFLICT');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      const backup=await backupFile(privateSource!.backup,true,signal,restorationAttributes(privateSource!.capture.inverse!));if(!('audioStart'in backup))return sourceWritesFail('BACKUP_INVALID');value={file:backup as SourceWriteFileObservation,attributes:privateSource!.capture.attributes};
      const originalPhase=store.plan(options.datasetId,privateSource!.capture.inverse!.originPlanId).events.find((e):e is Extract<SourceWritesEvent,{kind:'phase'}>=>e.kind==='phase'&&e.fact.operationId===privateSource!.capture.inverse!.originOperationId&&e.fact.phase==='CAPTURE_INTENT');if(!originalPhase)return sourceWritesFail('BACKUP_INVALID');
      recoverySource=await privateMaterialSource(originalPhase.fact.quarantine);
    }else{const named=await readonlySourceCandidateMetadata(root,relative);if(named.signature!==scan.value.signature&&!privateSource)return sourceWritesFail('SOURCE_CHANGED');
      value=await observedFile(root,relative,signal,async fd=>({file:await observeSourceWriteFile(fd,signal),attributes:await observeSourceFileAttributes(path.join(root.path,relative),fd)}),retained,privateSource?.capture.inverse?namespaceObservation(privateSource.capture.inverse.originPlanId,privateSource.capture.inverse.originOperationId,{root,relative}):undefined);
    }
    if(privateSource&&!absent&&value.file.sha256!==privateSource.expectedSha256)return sourceWritesFail('UNDO_CONFLICT');
    const region=inspectSourceTagRegion(value.file.prefix,value.file.bytes);if(region.profile!==value.file.profile||region.audioStart!==value.file.audioStart)return sourceWritesFail('UNSUPPORTED_FORMAT');
    const rootFact=await rootFingerprint(root,relative),targets=[recoverySource??{root,relative,expectedSignature:value.file.signature}],guard=retained?await protection.inspectRetained(targets,retained,source=>privateSource?.capture.inverse?namespaceObservation(privateSource.capture.inverse.originPlanId,privateSource.capture.inverse.originOperationId,source):undefined):await protection.inspect(targets);evidence(guard);
    const {prefix:_prefix,...observation}=value.file;
    const c:SourceWriteCapture={root,asset,track,libraryRoot,relative,observation,attributes:value.attributes,fieldsBefore:absent?{}:sourceWriteFieldValues(value.file),scan:{jobId:scan.jobId,batchId:scan.batchId,data:scan.data},protectionFingerprint:guard.fingerprint,storageFingerprint:guard.storageFingerprint,affectedTracks,parentPhysical:rootFact.parent,rootObservationFingerprint:rootFact.fingerprint,directoryTarget:null,directoryBefore:null,directoryAttributes:null,sourceAbsent:absent,recoverySource:recoverySource as SourceWriteCapture['recoverySource'],inverse:privateSource?.capture.inverse??null,sharedSources:[]};
    checkCapture(c);value.file.prefix=Buffer.from(value.file.prefix.subarray(0,value.file.audioStart+4));return {capture:c,file:value.file};
  }
  async function directoryCapture(c:SourceWriteCapture,fileName:'cover.jpg'|'cover.png',signal:AbortSignal,retained?:PhysicalWriteClaims):Promise<void>{
    c.directoryTarget=path.posix.join(path.posix.dirname(c.relative),fileName);const absolute=path.join(c.root.path,c.directoryTarget),parent=path.dirname(absolute);
    const all=repository.localCatalog.privateSourceWriteDirectory(c.libraryRoot.id,path.posix.dirname(c.relative));let count=0;const entries=await opendir(parent);
    for await(const entry of entries){if(++count>2048)return sourceWritesFail('BUDGET_EXCEEDED');if(entry.isSymbolicLink())return sourceWritesFail('SHARED_RESOURCE_UNKNOWN');if(entry.isFile()&&/\.(?:flac|mp3|m4a|mp4|wav|aiff|aif|alac|ogg|opus|ape|wv|cue)$/iu.test(entry.name)&&!all.some(a=>path.posix.basename(a.relative)===entry.name))return sourceWritesFail('SHARED_RESOURCE_UNKNOWN');}
    if(all.flatMap(a=>a.tracks).length>200)return sourceWritesFail('SHARED_RESOURCE_UNKNOWN');
    for(const member of all){if(!member.tracks.length||member.tracks.some(t=>t.segment!==null))return sourceWritesFail('SEGMENTED_SOURCE');const fact=await readonlySourceCandidateMetadata(c.root,member.relative),scan=repository.localScan.privateSourceWriteFileState(c.libraryRoot.id,member.relative);if(!scan||scan.value.signature!==fact.signature||scan.value.assetId!==member.asset.id)return sourceWritesFail('SHARED_RESOURCE_UNKNOWN');const info=await lstat(path.join(c.root.path,member.relative),{bigint:true});if(info.nlink!==1n)return sourceWritesFail('HARD_LINKED_SOURCE');c.sharedSources.push({asset:member.asset,relative:member.relative,tracks:member.tracks,signature:fact.signature,physical:{dev:String(info.dev),ino:String(info.ino)}});}
    try{const s=await lstat(absolute,{bigint:true});if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1n)return sourceWritesFail('HARD_LINKED_SOURCE');const before=await observedFile(c.root,c.directoryTarget,signal,async fd=>({blob:await observeSourcePublishedBlob(fd,4194304,signal),attributes:await observeSourceFileAttributes(absolute,fd)}),retained,c.inverse?namespaceObservation(c.inverse.originPlanId,c.inverse.originOperationId,{root:c.root,relative:c.directoryTarget}):undefined);c.directoryBefore=before.blob;c.directoryAttributes=before.attributes;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const targets:PublicationSource[]=c.sharedSources.map(s=>({root:c.root,relative:s.relative,expectedSignature:s.signature}));if(c.directoryBefore)targets.push({root:c.root,relative:c.directoryTarget,expectedSignature:c.directoryBefore.signature});if(c.recoverySource)targets.push(c.recoverySource);const guard=retained?await protection.inspectRetained(targets,retained,source=>c.inverse?namespaceObservation(c.inverse.originPlanId,c.inverse.originOperationId,source):undefined):await protection.inspect(targets);evidence(guard);c.protectionFingerprint=guard.fingerprint;c.storageFingerprint=guard.storageFingerprint;
  }
  async function directoryMembership(c:SourceWriteCapture):Promise<void>{
    if(!c.directoryTarget)return;const members=repository.localCatalog.privateSourceWriteDirectory(c.libraryRoot.id,path.posix.dirname(c.relative));
    if(!equal(members,c.sharedSources.map(({asset,relative,tracks})=>({asset,relative,tracks}))))return sourceWritesFail('SHARED_RESOURCE_UNKNOWN');
    let count=0;const entries=await opendir(path.dirname(path.join(c.root.path,c.directoryTarget)));for await(const entry of entries){if(++count>2048)return sourceWritesFail('BUDGET_EXCEEDED');if(entry.isSymbolicLink()||entry.isFile()&&/\.(?:flac|mp3|m4a|mp4|wav|aiff|aif|alac|ogg|opus|ape|wv|cue)$/iu.test(entry.name)&&!members.some(m=>path.posix.basename(m.relative)===entry.name))return sourceWritesFail('SHARED_RESOURCE_UNKNOWN');}
  }
  function receipt<C extends dto.LocalSourceWritesReceiptCommand>(command:C,request:dto.LocalSourceWritesCommandPayloads[C],outcome:'accepted'|'rejected',plan:dto.LocalSourceWritesPlan|null,reason:dto.LocalSourceWritesIssue|null,policyValue:dto.LocalSourceWritesPolicy|null=null):dto.LocalSourceWritesReceipt {
    return {datasetId:options.datasetId,commandId:request.commandId,command,requestFingerprint:sourceWritesRequestFingerprint(command,request),planId:plan?.planId??null,jobId:plan?.jobId??null,outcome,policy:policyValue,issue:reason};
  }
  function saveReceipt<C extends dto.LocalSourceWritesReceiptCommand>(command:C,request:dto.LocalSourceWritesCommandPayloads[C],value:dto.LocalSourceWritesReceipt,header:dto.LocalSourceWritesPlan|null=null,intent:dto.LocalSourceWritesIntent|null=null,policyValue:dto.LocalSourceWritesPolicy|null=null):void {
    store.append(sourceWritesEvent({version:1 as const,eventId:randomUUID(),datasetId:options.datasetId,planId:value.planId,occurredAt:new Date(now()).toISOString(),kind:'receipt' as const,command,request,requestFingerprint:value.requestFingerprint,receipt:value,header,intent,ownerEpoch,policy:policyValue}));
  }
  function launch(planId:string,operation:(controller:AbortController)=>Promise<void>):void {
    const controller=new AbortController(),timer=setTimeout(()=>{controller.abort();try{const current=store.plan(options.datasetId,planId).plan;if(phases.has(current.state)&&current.state!=='CANCEL_REQUESTED')store.state(options.datasetId,planId,'CANCEL_REQUESTED',['CANCELLED'],true);}catch(error){fatal??=error;}},120000);const done=Promise.resolve().then(()=>operation(controller)).catch(error=>{
      if(error instanceof SourcePublicationRecoveryRequired){uncertain.set(planId,error);const namespace=error.namespaceProtection??namespaces.get(planId);if(namespace){if(namespace.token.state!=='released')retainSourceNamespaceWrite(namespace.token);namespaces.set(planId,namespace);uncertain.set(namespace.scope.originBinding.originPlanId,error);}try{store.state(options.datasetId,planId,'RECOVERY_REQUIRED',[dto.isLocalSourceWritesIssue(error.outcome.issue)?error.outcome.issue:'RECOVERY_REQUIRED'],true);}catch(persist){fatal=persist;}return;}
      if(error instanceof LocalFactsCommitFatal||error instanceof MetadataLeaseReleaseError){fatal=error;return;}
      const code=issue(error);try{const current=store.plan(options.datasetId,planId).plan;if(current.state==='PREVIEWING')store.state(options.datasetId,planId,controller.signal.aborted?'CANCELLED':'BLOCKED',[controller.signal.aborted?'CANCELLED':code],true);else if(current.state!=='COMPLETED'&&current.state!=='PARTIAL')store.state(options.datasetId,planId,controller.signal.aborted?'CANCELLED':'FAILED',[controller.signal.aborted?'CANCELLED':code],true);}catch(persist){fatal=persist;}
    }).finally(()=>{clearTimeout(timer);runs.delete(planId);pending.delete(done);settlePolicy();});runs.set(planId,{controller,done});pending.add(done);
  }
  function settlePolicy():void {try{const current=policy();if(!runs.size&&!uncertain.size&&!hasPersistedRecovery()&&current.draining)store.append(sourceWritesEvent({version:1 as const,eventId:randomUUID(),datasetId:options.datasetId,planId:null,occurredAt:new Date(now()).toISOString(),kind:'policy-quiet' as const,policy:{...current,draining:false}}),true);}catch(error){fatal??=error;}}
  function header(range:dto.LocalSourceWritesRange,count:number,undoOf:string|null=null,recoveryOf:string|null=null):dto.LocalSourceWritesPlan {
    const planId=randomUUID();return {version:1,datasetId:options.datasetId,planId,jobId:randomUUID(),viewRevision:'1',journalSequence:'1',scope:'SOURCE_FILES',range,state:'PREVIEWING',createdAt:new Date(now()).toISOString(),readyAt:null,expiresAt:null,policyRevision:policy().revision,planHash:null,contextFingerprint:null,journalFingerprint:sourceWritesHash({datasetId:options.datasetId,planId,empty:true}),summary:undoOf?'从验证备份恢复源文件':recoveryOf?'明确核对恢复材料后处理源文件':'预览具体源文件更改',items:[],issues:[],resourceSummary:{resources:0,sharedTargets:count,backupBytes:null,spaceVerified:false,protection:'unknown'},undoOf,recoveryOf,recoveryChoices:[]};
  }
  function accepted<C extends 'localSourceWrites.preview'|'localSourceWrites.undo'>(command:C,request:dto.LocalSourceWritesCommandPayloads[C],intent:dto.LocalSourceWritesIntent,inverses?:SourceWriteCapture['inverse'][],origin?:SourceStoredPlan,recoveryIds?:string[]):dto.LocalSourceWritesReceipt {
    if(intent.kind!=='recovery')admitOrdinary();if(runs.size>=2)return sourceWritesFail('BUDGET_EXCEEDED');if(!directory||!safety)return sourceWritesFail('BACKUP_UNAVAILABLE');const tracks=origin?origin.items.filter(i=>recoveryIds?.includes(i.item.operationId)||inverses?.some(v=>v?.originOperationId===i.item.operationId)).map(i=>repository.localCatalog.track(i.item.trackId)):intent.kind==='recovery'?[]:selected(intent.target);if(!tracks.length)return sourceWritesFail('INVALID_REQUEST');store.capacity(tracks.length);
    const range=origin?.plan.range??(intent.kind==='tags'?'TAGS':intent.kind==='embedded-cover'?'EMBEDDED_COVER':'DIRECTORY_COVER'),p=header(range,tracks.length,command==='localSourceWrites.undo'?origin!.plan.planId:null,intent.kind==='recovery'?origin!.plan.planId:null),value=receipt(command,request,'accepted',p,null);
    saveReceipt(command,request,value,p,intent);launch(p.planId,controller=>prepare(p.planId,tracks,controller,inverses,origin,recoveryIds));return value;
  }
  function targetsOf(item:SourceWritePrivateItem):PublicationSource[]{const c=item.capture;if(c.directoryTarget){const targets:PublicationSource[]=c.sharedSources.map(s=>({root:c.root,relative:s.relative,expectedSignature:s.signature}));if(c.directoryBefore)targets.push({root:c.root,relative:c.directoryTarget,expectedSignature:c.directoryBefore.signature});if(c.recoverySource)targets.push(c.recoverySource);return targets;}return [c.sourceAbsent?c.recoverySource!:{root:c.root,relative:c.relative,expectedSignature:c.observation.signature}];}
  function originalTargetAttributes(item:SourceWritePrivateItem):SourceFileAttributes|null{return item.capture.directoryTarget?item.capture.directoryAttributes:item.capture.attributes;}
  function originalBackupAttributes(origin:SourceStoredPlan,id:string):SourceFileAttributes{
    const backed=origin.events.find((e):e is Extract<SourceWritesEvent,{kind:'phase'}>=>e.kind==='phase'&&e.fact.operationId===id&&e.fact.phase==='BACKUP');
    if(!backed?.fact.backupAttributes)return sourceWritesFail('BACKUP_INVALID');return backed.fact.backupAttributes;
  }
  function restorationAttributes(inverse:NonNullable<SourceWriteCapture['inverse']>):SourceFileAttributes|null{
    const origin=store.plan(options.datasetId,inverse.originPlanId),item=origin.items.find(i=>i.item.operationId===inverse.originOperationId);
    if(origin.plan.recoveryOf||!item||!Object.hasOwn(inverse,'restoreAttributes'))return sourceWritesFail('BACKUP_INVALID');
    const expected=originalTargetAttributes(item),absence=!!item.capture.directoryTarget&&item.capture.directoryBefore===null;
    if(!equal(inverse.restoreAttributes,expected)||inverse.removeTarget!==absence||!inverse.backup.attributes||!sameSourceFileAttributes(inverse.backup.attributes,originalBackupAttributes(origin,item.item.operationId)))return sourceWritesFail('BACKUP_INVALID');
    return expected;
  }
  function expectedCurrentTargetAttributes(origin:SourceStoredPlan,item:SourceWritePrivateItem):SourceFileAttributes{
    const original=originalTargetAttributes(item);if(original)return original;
    // 首次创建已逐次核实stage/final与本次哨兵的属性证明相同；哨兵不是原cover。
    if(!item.capture.directoryTarget||item.capture.directoryBefore!==null)return sourceWritesFail('BACKUP_INVALID');
    return {...originalBackupAttributes(origin,item.item.operationId),mode:String(0o644)};
  }
  async function backupFile(fact:SourceBackupFact,audio:boolean,signal:AbortSignal,original:SourceFileAttributes|null):Promise<SourceWriteFileObservation|SourcePublishedBlob>{
    if(!directory||!fact.path.startsWith(`${path.join(directory,'safety')}${path.sep}`)||await realpath(fact.path)!==fact.path)return sourceWritesFail('BACKUP_INVALID');
    if(!fact.attributes)return sourceWritesFail('BACKUP_INVALID');const handle=await open(fact.path,constants.O_RDONLY|constants.O_NOFOLLOW);try{await observeSourceBackupAttributes(fact.path,handle,original,fact.attributes);const value=audio?await observeSourceWriteFile(handle,signal):await observeSourcePublishedBlob(handle,4194304,signal);if(value.sha256!==fact.sha256||value.bytes!==fact.bytes||!equal(value.physical,fact.physical))return sourceWritesFail('BACKUP_INVALID');return value;}finally{await handle.close();}
  }
  async function absenceBackup(fact:SourceBackupFact):Promise<void>{
    if(!directory||!fact.attributes||fact.bytes!==0||fact.sha256!==createHash('sha256').update(Buffer.alloc(0)).digest('hex')||!fact.path.startsWith(`${path.join(directory,'safety')}${path.sep}`)||await realpath(fact.path)!==fact.path)return sourceWritesFail('BACKUP_INVALID');
    const handle=await open(fact.path,constants.O_RDONLY|constants.O_NOFOLLOW);try{await observeSourceBackupAttributes(fact.path,handle,null,fact.attributes);const first=await handle.stat({bigint:true}),read=await handle.read(Buffer.alloc(1),0,1,0),last=await handle.stat({bigint:true});if(first.size!==0n||last.size!==0n||read.bytesRead!==0||first.dev!==last.dev||first.ino!==last.ino||first.ctimeNs!==last.ctimeNs||first.mtimeNs!==last.mtimeNs||!equal({dev:String(last.dev),ino:String(last.ino)},fact.physical))return sourceWritesFail('BACKUP_INVALID');}finally{await handle.close();}
  }
  function operation(item:dto.LocalSourceWritesItem,c:SourceWriteCapture,range:dto.LocalSourceWritesRange):dto.OrganizerFrozenOperation {
    const patch:dto.OrganizerFrozenOperation['field_patch']={};const fields={title:'title',artist:'artists',album:'album',year:'date',disc:'disc_number',track:'track_number'} as const;
    if(range==='TAGS')for(const change of item.changes){const value=change.action==='remove'?null:change.field==='artist'?change.after:change.field==='disc'||change.field==='track'?Number(change.after![0]):change.after![0];Object.assign(patch,{[fields[change.field]]:value});}
    else patch.artwork_selection_id=item.artwork?.selectionId??null;
    return {operation_id:item.operationId,kind:range==='TAGS'?'WRITE_TAGS':'WRITE_COVER',root_id:c.libraryRoot.id,target_asset_id:c.asset.id,expected_asset_revision:c.asset.fileRevision,source_relative_path:c.directoryTarget??c.relative,target_relative_path:c.directoryTarget??c.relative,field_patch:patch,backup_required:true};
  }
  async function prepare(planId:string,tracks:dto.LocalTrack[],controller:AbortController,inverses?:SourceWriteCapture['inverse'][],origin?:SourceStoredPlan,recoveryIds?:string[]):Promise<void>{
    check();await options.beforeMedia?.();check();const stored=store.plan(options.datasetId,planId),intent=origin?.intent??stored.intent,value=writingPolicy(stored.plan.policyRevision),signal=controller.signal,privateItems:SourceWritePrivateItem[]=[],targets:PublisherTarget[]=[];let io=0;
    const selection=intent.kind==='recovery'?sourceWritesHash(intent):scopeFingerprint(intent);
    for(const track of tracks){if(signal.aborted)return sourceWritesFail('CANCELLED');const originItem=origin?.items.find(o=>o.item.trackId===track.id),inverse=recoveryIds&&originItem?await recoveryInverse(origin!,originItem.item.operationId,signal):inverses?.find(i=>i?.originOperationId===originItem?.item.operationId)??null;
      const previous=inverse?origin!.items.find(i=>i.item.operationId===inverse.originOperationId)!:null;
      const retained=inverse?uncertain.get(inverse.originPlanId)?.claims??undefined:undefined;
      const observed=await observeTrack(track,signal,inverse?{capture:{...previous!.capture,inverse},backup:inverse.backup,expectedSha256:stored.plan.range==='DIRECTORY_COVER'?previous!.capture.observation.sha256:inverse.expectedAfterSha256}:undefined),c=observed.capture;io+=observed.file.bytes;if(io>2147483648)return sourceWritesFail('BUDGET_EXCEEDED');
      if(stored.plan.range!=='DIRECTORY_COVER'&&!dto.isLocalCatalogRevision((BigInt(c.asset.fileRevision)+1n).toString()))return sourceWritesFail('REVISION_EXHAUSTED');
      c.inverse=inverse;
      if(inverse){const restore=restorationAttributes(inverse);if(!c.directoryTarget&&stored.plan.range!=='DIRECTORY_COVER'&&!c.sourceAbsent&&(!restore||!sameSourceFileAttributes(c.attributes,restore)))return sourceWritesFail('UNDO_CONFLICT');}
      if(stored.plan.range==='DIRECTORY_COVER'&&inverse?.expectedAfterSha256===null&&!inverse.removeTarget)c.recoverySource=await privateMaterialSource(path.join(directory!,'safety',inverse.originOperationId,'quarantine')) as SourceWriteCapture['recoverySource'];
      if(stored.plan.range==='DIRECTORY_COVER')await directoryCapture(c,previous?.capture.directoryTarget?.endsWith('.jpg')?'cover.jpg':intent.kind==='directory-cover'?intent.fileName:'cover.png',signal,retained);
      const publicItem:dto.LocalSourceWritesItem={operationId:randomUUID(),resourceRef:randomUUID(),trackId:track.id,assetId:c.asset.id,label:`曲目 ${privateItems.length+1}`,profile:stored.plan.range==='DIRECTORY_COVER'?null:observed.file.profile,expectedFileRevision:c.asset.fileRevision,currentFileRevision:c.asset.fileRevision,expectedRootRevision:c.libraryRoot.revision,expectedLocationRevision:c.asset.locationRevision,expectedSelectionRevision:'1',changes:[],artwork:null,state:'planned',phase:'PLANNED',backup:{state:'not-created',bytes:null},verification:{audio:stored.plan.range==='DIRECTORY_COVER'?'not-applicable':'pending',unselectedMetadata:stored.plan.range==='DIRECTORY_COVER'?'not-applicable':'pending',content:'pending',reread:'pending'},issue:null};
      let change:SourceRegionChange|null=null,replacementBytes:Buffer|null=null;
      if(inverse){
        const restoration:dto.LocalSourceWritesRestoration={originPlanId:inverse.originPlanId,originOperationId:inverse.originOperationId,kind:stored.plan.range==='DIRECTORY_COVER'?(inverse.removeTarget?'remove-new-directory-cover':'restore-directory-cover'):'restore-audio-file',material:inverse.removeTarget?'verified-absence':'verified-backup',expectedOutputSha256:inverse.removeTarget?null:inverse.backup.sha256};publicItem.restoration=restoration;
        if(stored.plan.range==='TAGS')publicItem.changes=previous!.item.changes.map(selected=>{const after=previous!.capture.fieldsBefore[selected.field]??null;if(selected.field==='artist'&&after&&after.length>32)return sourceWritesFail('UNSUPPORTED_TAGS');return {field:selected.field,action:after===null?'remove':'set',before:c.fieldsBefore[selected.field]??null,after};});
        const restore=restorationAttributes(inverse);
        if(stored.plan.range==='DIRECTORY_COVER'){if((c.directoryBefore?.sha256??null)!==inverse.expectedAfterSha256||c.directoryBefore&&(!c.directoryAttributes||!sameSourceFileAttributes(c.directoryAttributes,expectedCurrentTargetAttributes(origin!,previous!))))return sourceWritesFail('UNDO_CONFLICT');if(inverse.removeTarget)await absenceBackup(inverse.backup);else await backupFile(inverse.backup,false,signal,restore);}
        else await backupFile(inverse.backup,true,signal,restore);
      }else if(intent.kind==='tags'){
        publicItem.changes=Object.entries(intent.fields).map(([field,action])=>{const key=field as dto.LocalSourceWritesField,before=c.fieldsBefore[key]??null;if(key==='artist'&&before&&before.length>32)return sourceWritesFail('UNSUPPORTED_TAGS');return {field:key,action:action.action,before,after:action.action==='set'?[action.value]:null};});
        change={fields:intent.fields};writeSourceTagRegion(observed.file.prefix,observed.file.bytes,change);
      }else if(intent.kind==='embedded-cover'||intent.kind==='directory-cover'){
        material(intent.artwork,track.id);const original=await originals.get(intent.artwork);publicItem.expectedSelectionRevision=intent.artwork.expectedSelectionRevision;publicItem.artwork={...intent.artwork,...{mime:original.original.mime,bytes:original.original.bytes,width:original.original.width,height:original.original.height},slot:stored.plan.range==='DIRECTORY_COVER'?'directory':'front'};
        if(intent.kind==='embedded-cover'){change={frontImage:{mime:original.original.mime,width:original.original.width,height:original.original.height,depth:original.depth,bytes:original.bytes}};writeSourceTagRegion(observed.file.prefix,observed.file.bytes,change);}else {if(intent.fileName.endsWith('.png')!==(original.original.mime==='image/png'))return sourceWritesFail('ARTWORK_CHANGED');replacementBytes=original.bytes;}
      }else return sourceWritesFail('INVALID_REQUEST');
      const record:SourceWritePrivateItem={item:publicItem,operation:operation(publicItem,c,stored.plan.range),capture:c};privateItems.push(record);
      targets.push({operationId:publicItem.operationId,root:c.root,libraryRootPath:c.root.path,relative:c.directoryTarget??c.relative,expected:c.directoryTarget?c.directoryBefore:c.sourceAbsent?null:observed.file,attributes:c.directoryTarget?c.directoryAttributes:c.attributes,change,replacementBytes,...(inverse?{...(!inverse.removeTarget?{restorationFile:inverse.backup.path}:{}),restorationSha256:inverse.backup.sha256,restorationBytes:inverse.backup.bytes,restorationAudio:!c.directoryTarget,removeTarget:inverse.removeTarget,restorationAttributes:restorationAttributes(inverse),restorationBackupAttributes:inverse.backup.attributes!}:{})});
      const latest=store.plan(options.datasetId,planId);if(latest.plan.state!=='PREVIEWING'||signal.aborted)return sourceWritesFail('CANCELLED');
    }
    if(new Set(targets.map(t=>`${t.root.id}/${t.relative}`)).size!==targets.length)return sourceWritesFail('SHARED_RESOURCE_UNKNOWN');
    for(const record of privateItems){const owned=path.join(directory!,'safety',record.item.operationId),maximalItem={...record.item,currentFileRevision:'18446744073709551615',phase:'UNKNOWN' as const,state:'unknown' as const,backup:{state:'retained' as const,bytes:'268435456'},verification:{audio:'unknown' as const,unselectedMetadata:'unknown' as const,content:'unknown' as const,reread:'unknown' as const},issue:'RECOVERY_REQUIRED' as const};sourceWritesLedgerRow(sourceWritesEvent({version:1 as const,eventId:randomUUID(),datasetId:options.datasetId,planId,occurredAt:new Date(now()).toISOString(),kind:'phase' as const,fact:{operationId:record.item.operationId,phase:'UNKNOWN' as const,backup:path.join(owned,'backup'),quarantine:path.join(owned,'quarantine'),stage:path.join(owned,'stage'),beforeSha256:record.capture.observation.sha256,afterSha256:record.capture.observation.sha256},item:maximalItem}));}
    const capacity=await safety!.preflight(targets);check();writingPolicy(value.revision);if(intent.kind!=='recovery'&&scopeFingerprint(intent)!==selection)return sourceWritesFail('REVISION_CHANGED');privateItems.forEach(i=>checkCapture(i.capture));
    const readyAt=new Date(now()).toISOString(),expiresAt=new Date(Date.parse(readyAt)+600000).toISOString();
    const mapping:Record<string,string>={};privateItems.forEach(i=>{mapping[i.capture.libraryRoot.id]=i.capture.libraryRoot.revision;});
    const frozenHeader={created_at:readyAt,scope:'SOURCE_FILES' as const,root_mapping_revisions:mapping,conflicts:[],resource_guards:{require_exclusive_asset_lock:true,defer_if_read_lease:true,protect_frozen_sources:true as const,recheck_at_execution:true as const}};
    const ready={frozenHeader,ownerEpoch,contextNonce:randomBytes(32).toString('hex'),selectionFingerprint:selection,itemContextHashes:privateItems.map(i=>sourceWritesHash(i.capture))},body={...frozenHeader,operations:privateItems.map(i=>i.operation)},context=sourceWritesPlanContext({plan:stored.plan,items:privateItems},ready,expiresAt);
    const physicalResources=new Set(privateItems.flatMap(i=>[`${i.capture.observation.physical.dev}:${i.capture.observation.physical.ino}`,`${i.capture.parentPhysical.dev}:${i.capture.parentPhysical.ino}`,...i.capture.sharedSources.map(s=>`${s.physical.dev}:${s.physical.ino}`),...(i.capture.directoryBefore?[`${i.capture.directoryBefore.physical.dev}:${i.capture.directoryBefore.physical.ino}`]:[]),...(i.capture.recoverySource?[i.capture.recoverySource.expectedSignature.split(':').slice(0,2).join(':')]:[]),...(i.capture.inverse?[`${i.capture.inverse.backup.physical.dev}:${i.capture.inverse.backup.physical.ino}`]:[])]));
    for(const item of privateItems){let cursor=item.capture.root.path;for(const part of ['',...item.capture.relative.split('/').slice(0,-1)]){if(part)cursor=path.join(cursor,part);const stat=await lstat(cursor,{bigint:true});if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(cursor)!==cursor)return sourceWritesFail('SOURCE_CHANGED');physicalResources.add(`${stat.dev}:${stat.ino}`);}}
    const namespaceOperations=await captureNamespaceOperations({...stored,items:privateItems},privateItems.map(i=>i.item.operationId)),namespaceCount=new Set(namespaceOperations.flatMap(i=>i.name.resources.map(r=>`${r.dev}\0${r.absolute}`))).size;
    // op目录/独立backup/stage是尚未创建的真实资源；预览预留，发布后仍以实际FD全集复核。
    const resourceCount=physicalResources.size+privateItems.length*3+namespaceCount;if(resourceCount>2048)return sourceWritesFail('BUDGET_EXCEEDED');
    const projection={...stored.plan,readyAt,expiresAt,planHash:sourceWritesHash(body),contextFingerprint:sourceWritesHash(context),state:'READY' as const,items:privateItems.map(i=>i.item),resourceSummary:{resources:resourceCount,sharedTargets:new Set(privateItems.flatMap(i=>[...i.capture.affectedTracks.map(t=>t.id),...i.capture.sharedSources.flatMap(s=>s.tracks.map(t=>t.id))])).size,backupBytes:String(capacity.bytes),spaceVerified:true,protection:'verified' as const}};
    if(!dto.localSourceWritesCompletePlanWithinBudget({body,context,projection}))return sourceWritesFail('BUDGET_EXCEEDED');
    // 完整捕获通过联合预算后再同事务发布所有 item/READY，不留“部分 READY”承诺。
    const readyEvents:SourceWritesEvent[]=[...privateItems.map((item,index)=>sourceWritesEvent({version:1 as const,eventId:randomUUID(),datasetId:options.datasetId,planId,occurredAt:readyAt,kind:'item' as const,index,value:item})),sourceWritesEvent({version:1 as const,eventId:randomUUID(),datasetId:options.datasetId,planId,occurredAt:readyAt,kind:'ready' as const,ready,planHash:projection.planHash,contextFingerprint:projection.contextFingerprint,readyAt,expiresAt,resources:resourceCount,backupBytes:String(capacity.bytes)})];
    store.capacity(0,readyEvents.reduce((bytes,event)=>bytes+Object.values(sourceWritesLedgerRow(event)).reduce((n,text)=>n+Buffer.byteLength(text),0),0));
    store.transaction(view=>readyEvents.forEach(event=>view.append(event)));
  }
  function checkedConfirm(request:dto.ConfirmLocalSourceWrites):SourceStoredPlan {
    const stored=store.plan(options.datasetId,request.planId),p=stored.plan;
    if(p.viewRevision!==request.expectedViewRevision)return sourceWritesFail('REVISION_CHANGED');
    if(p.state!=='READY'||!stored.ready||stored.ownerEpoch!==ownerEpoch||stored.ready.ownerEpoch!==ownerEpoch)return sourceWritesFail('GRANT_MISMATCH');
    if(p.scope!==request.scope||p.range!==request.range||p.planHash!==request.planHash||p.contextFingerprint!==request.contextFingerprint)return sourceWritesFail('PREVIEW_MISMATCH');
    if(!p.expiresAt||now()>=Date.parse(p.expiresAt))return sourceWritesFail('PLAN_EXPIRED');
    if(!p.recoveryOf)admitOrdinary();else assertRecoveryFamilyIdle(p.recoveryOf,p.planId);
    writingPolicy(p.policyRevision);stored.items.forEach(i=>checkCapture(i.capture));
    const body={...stored.ready.frozenHeader,operations:stored.items.map(i=>i.operation)},context=sourceWritesPlanContext(stored,stored.ready,p.expiresAt);
    if(sourceWritesHash(body)!==p.planHash||sourceWritesHash(context)!==p.contextFingerprint||!dto.localSourceWritesCompletePlanWithinBudget({body,context,projection:p}))return sourceWritesFail('PREVIEW_MISMATCH');
    return stored;
  }
  async function executionTargets(stored:SourceStoredPlan,signal:AbortSignal):Promise<PublisherTarget[]> {
    const targets:PublisherTarget[]=[];for(const record of stored.items){
      check();writingPolicy(stored.plan.policyRevision);checkCapture(record.capture);const c=record.capture;
      await directoryMembership(c);
      if((await rootFingerprint(c.root,c.relative)).fingerprint!==c.rootObservationFingerprint)return sourceWritesFail('SOURCE_CHANGED');
      const retained=c.inverse?uncertain.get(c.inverse.originPlanId)?.claims??undefined:undefined;
      let file:SourceWriteFileObservation;if(c.sourceAbsent){try{await lstat(path.join(c.root.path,c.relative),{bigint:true});return sourceWritesFail('UNDO_CONFLICT');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}const backup=await backupFile(c.inverse!.backup,true,signal,restorationAttributes(c.inverse!));if(!('audioStart'in backup))return sourceWritesFail('BACKUP_INVALID');file=backup as SourceWriteFileObservation;}
      else file=await observedFile(c.root,c.relative,signal,fd=>observeSourceWriteFile(fd,signal),retained,c.inverse?namespaceObservation(c.inverse.originPlanId,c.inverse.originOperationId,{root:c.root,relative:c.relative}):undefined);
      if(!equal(storedObservation(file),c.observation))return sourceWritesFail('SOURCE_CHANGED');
      let expected:SourceWriteFileObservation|SourcePublishedBlob|null=c.sourceAbsent?null:file,attributes:SourceWriteCapture['directoryAttributes']=c.attributes,change:SourceRegionChange|null=null,replacementBytes:Buffer|null=null;
      if(c.directoryTarget){expected=null;attributes=c.directoryAttributes;
        try{expected=await observedFile(c.root,c.directoryTarget,signal,fd=>observeSourcePublishedBlob(fd,4194304,signal),retained,c.inverse?namespaceObservation(c.inverse.originPlanId,c.inverse.originOperationId,{root:c.root,relative:c.directoryTarget}):undefined);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'&&!(error instanceof SourceFileError&&error.code==='MISSING'))throw error;}
        if(!equal(expected,c.directoryBefore))return sourceWritesFail('SOURCE_CHANGED');
      }
      if(c.inverse){if(record.item.restoration?.originPlanId!==c.inverse.originPlanId||record.item.restoration.originOperationId!==c.inverse.originOperationId)return sourceWritesFail('BACKUP_INVALID');const restore=restorationAttributes(c.inverse);if(c.inverse.removeTarget)await absenceBackup(c.inverse.backup);else await backupFile(c.inverse.backup,!c.directoryTarget,signal,restore);}
      else if(stored.intent.kind==='tags')change={fields:stored.intent.fields};
      else if(stored.intent.kind==='embedded-cover'||stored.intent.kind==='directory-cover'){
        material(stored.intent.artwork,c.track.id);const original=await originals.get(stored.intent.artwork);
        if(stored.intent.kind==='embedded-cover')change={frontImage:{mime:original.original.mime,width:original.original.width,height:original.original.height,depth:original.depth,bytes:original.bytes}};
        else replacementBytes=original.bytes;
      }else return sourceWritesFail('INVALID_REQUEST');
      const protectedSources=c.sharedSources.map(s=>({root:c.root,relative:s.relative,signature:s.signature,physical:s.physical}));if(c.recoverySource){const s=await lstat(path.join(c.recoverySource.root.path,c.recoverySource.relative),{bigint:true});protectedSources.push({root:c.recoverySource.root,relative:c.recoverySource.relative,signature:c.recoverySource.expectedSignature,physical:{dev:String(s.dev),ino:String(s.ino)}});}
      targets.push({operationId:record.item.operationId,root:c.root,libraryRootPath:c.root.path,relative:c.directoryTarget??c.relative,expected,attributes,change,replacementBytes,protectedSources,...(c.inverse?{...(!c.inverse.removeTarget?{restorationFile:c.inverse.backup.path}:{}),restorationSha256:c.inverse.backup.sha256,restorationBytes:c.inverse.backup.bytes,restorationAudio:!c.directoryTarget,removeTarget:c.inverse.removeTarget,restorationAttributes:restorationAttributes(c.inverse),restorationBackupAttributes:c.inverse.backup.attributes!}:{})});
    }return targets;
  }
  async function execute(planId:string,controller:AbortController,actor:SourceWritesMainActor):Promise<void> {
    check();assertSourceWritesMainActor(actor);await options.beforeMedia?.();check();assertSourceWritesMainActor(actor);const stored=store.plan(options.datasetId,planId);writingPolicy(stored.plan.policyRevision);
    if(stored.plan.state!=='QUEUED'||stored.ownerEpoch!==ownerEpoch||!stored.ready)return sourceWritesFail('GRANT_MISMATCH');
    if(now()>=Date.parse(stored.plan.expiresAt!))return sourceWritesFail('PLAN_EXPIRED');
    if(!stored.plan.undoOf&&!stored.plan.recoveryOf&&scopeFingerprint(stored.intent)!==stored.ready.selectionFingerprint)return sourceWritesFail('REVISION_CHANGED');
    const targets=await executionTargets(stored,controller.signal);check();writingPolicy(stored.plan.policyRevision);
    if(controller.signal.aborted)return sourceWritesFail('CANCELLED');
    let recoveryToken:SourceNamespaceRecoveryToken|undefined,physicalRecovery:Parameters<typeof publishSourceWrites>[0]['physicalRecovery'],binding=namespaceBinding(stored);
    if(stored.plan.recoveryOf){const root=store.plan(options.datasetId,stored.plan.recoveryOf),ids=stored.items.map(i=>i.capture.inverse?.originOperationId),expected=rootUnresolvedOperations(root);
      // 业务恢复仅服务器完整choice；整组physical保护不能因客户端传部分op而提前释放。
      if(root.plan.recoveryOf||ids.some(id=>!id)||new Set(ids).size!==ids.length||ids.length!==expected.length||expected.some(id=>!ids.includes(id))||stored.items.some(i=>i.capture.inverse?.originPlanId!==root.plan.planId))return sourceWritesFail('PREVIEW_MISMATCH');
      const parent=[...namespaces.values()].reverse().find(p=>p.token.state!=='released'&&p.scope.originBinding.originPlanId===root.plan.planId),previous=uncertain.get(root.plan.planId);
      if(!parent||!previous?.claims)return sourceWritesFail('RECOVERY_REQUIRED');assertRetainedPhysicalWriteClaims(previous.claims,[]);binding=parent.scope.originBinding;
      const operations=await sourcePublisherNamespaceOperations(targets),mapping=operations.map(operation=>{const rootId=sourceWritesRootOperationId(stored,root,operation.operationId),parentPlan=store.plan(options.datasetId,parent.scope.planId),old=parent.scope.operations.find(o=>o.name.absolute===operation.name.absolute&&sourceWritesRootOperationId(parentPlan,root,o.operationId)===rootId);if(!old)return sourceWritesFail('RECOVERY_REQUIRED');return {...operation,originOperationId:old.operationId};});
      recoveryToken=delegateSourceNamespaceRecovery(parent.token,{datasetId:options.datasetId,originPlanId:parent.scope.planId,recoveryPlanId:planId,originBinding:binding,operations:mapping});
      namespaces.set(planId,{token:recoveryToken,scope:{datasetId:options.datasetId,planId,originBinding:binding,operations},recovery:true});
      assertSourceWritesMainActor(actor);physicalRecovery={claims:previous.claims,handles:[...physicalWriteClaimDescriptors(previous.claims),...previous.additionalHandles]};
    }
    store.state(options.datasetId,planId,'RUNNING',[]);
    const committed=new Set<string>(),prepared=new Map<string,SourceWriteFileFact>();
    const phase=(fact:import('./source-writes-publisher.js').SourcePublisherJournalFact):void=>{
      const original=stored.items.find(i=>i.item.operationId===fact.operationId)!;const latest=store.plan(options.datasetId,planId).items.find(i=>i.item.operationId===fact.operationId)!.item;
      const publicItem=structuredClone(latest);publicItem.phase=fact.phase;
      if(fact.phase==='BACKUP'){publicItem.backup={state:'verified',bytes:String(original.capture.directoryTarget?original.capture.directoryBefore?.bytes??0:original.capture.observation.bytes)};}
      if(fact.phase==='VERIFIED'){publicItem.verification={audio:stored.plan.range==='DIRECTORY_COVER'?'not-applicable':'verified',unselectedMetadata:stored.plan.range==='DIRECTORY_COVER'?'not-applicable':'verified',content:'verified',reread:'verified'};}
      if(fact.phase==='QUIET'&&committed.has(fact.operationId)){publicItem.phase='TERMINAL';publicItem.state='applied';publicItem.issue=null;publicItem.backup.state='retained';}
      else if(fact.phase==='QUIET'){publicItem.phase='TERMINAL';publicItem.state='not-written';publicItem.issue=controller.signal.aborted?'CANCELLED':null;}
      if(fact.phase==='UNKNOWN'){publicItem.state='unknown';publicItem.issue='RECOVERY_REQUIRED';publicItem.backup.state='retained';}
      store.append(sourceWritesEvent({version:1 as const,eventId:randomUUID(),datasetId:options.datasetId,planId,occurredAt:new Date(now()).toISOString(),kind:'phase' as const,fact,item:publicItem}),fact.phase==='QUIET'||fact.phase==='UNKNOWN');
      test?.phase?.(fact);
    };
    const verifyProtection=async(claims:PhysicalWriteClaims):Promise<void>=>{
      try{
      check();assertSourceWritesMainActor(actor);writingPolicy(stored.plan.policyRevision);for(const item of stored.items){if(committed.has(item.item.operationId))continue;const c=item.capture;checkCapture(c);const guard=await protection.inspectHeld(targetsOf(item),claims,undefined,source=>namespaceObservation(planId,item.item.operationId,source));evidence(guard);if(guard.storageFingerprint!==c.storageFingerprint)return sourceWritesFail('UNKNOWN_PROTECTION');
        if(!committed.size&&guard.fingerprint!==c.protectionFingerprint)return sourceWritesFail('UNKNOWN_PROTECTION');
        if((await rootFingerprint(c.root,c.relative)).fingerprint!==c.rootObservationFingerprint)return sourceWritesFail('SOURCE_CHANGED');
        // 上一项rename仅改变目录时间；未完成项的完整文件/成员集合仍逐一核实。
        await directoryMembership(c);if(committed.size){for(const target of targetsOf(item)){const actual=await readonlySourceCandidateMetadata(target.root,target.relative);if(actual.signature!==target.expectedSignature)return sourceWritesFail('SOURCE_CHANGED');}}
      }
      }catch(error){
        // 服务端已核实的保护拒绝保留其公开原因，不能被发布器兜底误报为备份故障。
        if(error instanceof SourceWritesError||error instanceof SourceFileError||error instanceof PhysicalResourceBusy)throw new SourcePublisherError(issue(error));
        throw error;
      }
    };
    const outcome=await publishSourceWrites({targets,privateDirectory:directory!,signal:controller.signal,planId,namespaceBinding:binding,...(recoveryToken?{namespaceRecovery:recoveryToken}:{}),...(physicalRecovery?{physicalRecovery}:{}),namespaceHeld:value=>namespaces.set(planId,value),phase,verifyProtection,
      prepareCommit:async(target,after,backup)=>{
        // 本项已捕获/发布后，OFF只封后续准入；仍完成独立核验、事实登记与真实quiet。
        options.assertCurrent();if(fatal)throw fatal;const record=stored.items.find(i=>i.item.operationId===target.operationId)!,c=record.capture;checkCapture(c);
        if(repository.sourceProtection.sourceWritesSnapshot().storageFingerprint!==c.storageFingerprint)return sourceWritesFail('UNKNOWN_PROTECTION');
        if(c.directoryTarget)return;
        if(!after||!('audioStart'in after))return sourceWritesFail('REPLACEMENT_UNKNOWN');
        const before=JSON.parse(c.scan.data) as import('./local-scan-store.js').ScanFileState;
        if(!before.readFacts)return sourceWritesFail('SHARED_RESOURCE_UNKNOWN');const read=await readSourceFullRaw(after,before.readFacts);
        const afterAsset={...c.asset,fileRevision:(BigInt(c.asset.fileRevision)+1n).toString()};if(!dto.isAudioAsset(afterAsset))return sourceWritesFail('REVISION_EXHAUSTED');
        const proof={parserVersion:SOURCE_FULL_RAW_PARSER,sourceSha256:after.sha256,signature:after.signature,fileRevision:afterAsset.fileRevision};
        prepared.set(target.operationId,{operationId:target.operationId,beforeAsset:c.asset,afterAsset,fullRaw:read.fullRaw,affectedTrackIds:c.affectedTracks.map(t=>t.id),observation:storedObservation(after),scanBefore:c.scan.data,scanAfter:JSON.stringify({...before,signature:after.signature,readFacts:read.readFacts}),scanJobId:c.scan.jobId,scanBatchId:c.scan.batchId,replaceCommandId:randomUUID(),backup,rawProof:{...proof,fingerprint:sourceWritesHash({proof,fullRaw:read.fullRaw})}});
      },
      commit:(target,after,backup)=>{
        options.assertCurrent();if(fatal)throw fatal;const record=stored.items.find(i=>i.item.operationId===target.operationId)!,c=record.capture;checkCapture(c);
        const latest=store.plan(options.datasetId,planId).items.find(i=>i.item.operationId===target.operationId)!.item,item=structuredClone(latest);item.phase='FACTS_COMMITTED';item.backup={state:'verified',bytes:String(backup.bytes)};
        if(c.directoryTarget){store.append(sourceWritesEvent({version:1 as const,eventId:randomUUID(),datasetId:options.datasetId,planId,occurredAt:new Date(now()).toISOString(),kind:'directory-facts' as const,fact:{operationId:target.operationId,relative:c.directoryTarget,beforeSha256:c.directoryBefore?.sha256??null,after:after as SourcePublishedBlob|null,backup},item}));}
        else{const fact=prepared.get(target.operationId);if(!fact)return sourceWritesFail('REPLACEMENT_UNKNOWN');item.currentFileRevision=fact.afterAsset.fileRevision;store.transaction(view=>view.finalize(sourceWritesEvent({version:1 as const,eventId:randomUUID(),datasetId:options.datasetId,planId,occurredAt:new Date(now()).toISOString(),kind:'facts' as const,fact,item})));}
        committed.add(target.operationId);
      }},safety!);
    const current=store.plan(options.datasetId,planId),reason=outcome.issue&&dto.isLocalSourceWritesIssue(outcome.issue)?outcome.issue:null;
    if(outcome.outcome==='unknown')return sourceWritesFail('RECOVERY_REQUIRED');
    if(current.plan.items.every(i=>i.state==='applied')){
      const retained=outcome.outcome==='confirmed'?outcome.retainedProtection:null;
      try{if(!stored.plan.recoveryOf){store.append(sourceWritesEvent({version:1 as const,eventId:randomUUID(),datasetId:options.datasetId,planId,occurredAt:new Date(now()).toISOString(),kind:'protection-closed' as const,operationIds:stored.items.map(i=>i.item.operationId)}),true);store.state(options.datasetId,planId,'COMPLETED',[],true);}
      if(stored.plan.recoveryOf&&recoveryToken){if(!retained)return sourceWritesFail('RELEASE_UNKNOWN');const root=store.plan(options.datasetId,stored.plan.recoveryOf),covered=new Set(stored.items.map(i=>sourceWritesRootOperationId(stored,root,i.item.operationId))),family=store.read(v=>[...v.projection.plans.values()].filter(p=>p.plan.datasetId===options.datasetId&&(p.plan.planId===root.plan.planId||p.plan.recoveryOf===root.plan.planId)&&p.plan.planId!==planId));
        const events=family.flatMap(p=>{const operationIds=sourceWritesUnresolvedOperations(p).filter(id=>covered.has(sourceWritesRootOperationId(p,root,id)));return operationIds.length?[sourceWritesEvent({version:1 as const,eventId:randomUUID(),datasetId:options.datasetId,planId:p.plan.planId,occurredAt:new Date(now()).toISOString(),kind:'recovery-resolved' as const,recoveryPlanId:planId,operationIds})]:[];});
        const completed=sourceWritesEvent({version:1 as const,eventId:randomUUID(),datasetId:options.datasetId,planId,occurredAt:new Date(now()).toISOString(),kind:'state' as const,state:'COMPLETED' as const,issues:[]});
        // 全部对应计划的解决事实与本次真实完成一起持久，任何确定回滚均不提前清保护。
        store.transaction(view=>{view.append(completed);events.forEach(event=>view.append(event));});
        // 真实FD已quiet，整个COMPLETED/resolved持久确认后才释放物理guards；names最后逐义务消除。
        await releaseRetainedPhysicalWriteClaims(retained.claims);
        await resolveSourceNamespaceRecovery(recoveryToken,recoveryToken.operationIds);namespaces.delete(planId);
        for(const event of events){if(!event.planId)return sourceWritesFail('RECOVERY_REQUIRED');const value=namespaces.get(event.planId);if(!value)continue;if(value.recovery)await resolveSourceNamespaceRecovery(value.token,event.operationIds);else await resolveSourceNamespaceOrigin(value.token,event.operationIds);if(value.token.state==='released')namespaces.delete(event.planId);}
        store.append(sourceWritesEvent({version:1 as const,eventId:randomUUID(),datasetId:options.datasetId,planId,occurredAt:new Date(now()).toISOString(),kind:'protection-closed' as const,operationIds:stored.items.map(i=>i.item.operationId)}),true);
        for(const p of family)if(!sourceWritesUnresolvedOperations(store.plan(options.datasetId,p.plan.planId)).length)uncertain.delete(p.plan.planId);uncertain.delete(planId);
      }else namespaces.delete(planId);
      }catch(error){if(!retained)throw error;const held=retained.claims.state==='released'?null:retained.claims;held?.retain();throw new SourcePublicationRecoveryRequired({outcome:'unknown',issue:error instanceof LocalFactsCommitFatal?'COMMIT_UNKNOWN':'RELEASE_UNKNOWN',applied:outcome.applied},held,retained.files,error,retained.namespaceProtection);}
    }
    else store.state(options.datasetId,planId,committed.size?'PARTIAL':controller.signal.aborted?'CANCELLED':'FAILED',[reason??(controller.signal.aborted?'CANCELLED':'INVENTORY_UNAVAILABLE')],true);
  }
  function reject<C extends dto.LocalSourceWritesReceiptCommand>(command:C,request:dto.LocalSourceWritesCommandPayloads[C],error:unknown):dto.LocalSourceWritesReceipt {
    const value=receipt(command,request,'rejected',null,issue(error));saveReceipt(command,request,value);return value;
  }
  async function recoveryInverse(origin:SourceStoredPlan,id:string,signal:AbortSignal):Promise<NonNullable<SourceWriteCapture['inverse']>>{
    const item=origin.items.find(i=>i.item.operationId===id);if(!item)return sourceWritesFail('BACKUP_INVALID');
    if(origin.plan.recoveryOf||!rootUnresolvedOperations(origin).includes(id))return sourceWritesFail('UNDO_CONFLICT');
    const fact=[...origin.events].reverse().find((e):e is Extract<SourceWritesEvent,{kind:'facts'|'directory-facts'}>=>(e.kind==='facts'||e.kind==='directory-facts')&&e.fact.operationId===id);
    const phases=origin.events.filter((e):e is Extract<SourceWritesEvent,{kind:'phase'}>=>e.kind==='phase'&&e.fact.operationId===id),backed=phases.find(e=>e.fact.phase==='BACKUP');if(!backed)return sourceWritesFail('BACKUP_INVALID');
    const capture=item.capture,audio=!capture.directoryTarget,absence=!!capture.directoryTarget&&capture.directoryBefore===null,restoreAttributes=originalTargetAttributes(item),backupAttributes=originalBackupAttributes(origin,id);
    const sourceHash=audio?capture.observation.sha256:capture.directoryBefore?.sha256??createHash('sha256').update(Buffer.alloc(0)).digest('hex'),sourceBytes=audio?capture.observation.bytes:capture.directoryBefore?.bytes??0;
    const expectedAsset=latestLineageAsset(origin,id);if(!equal(repository.localCatalog.asset(capture.asset.id),expectedAsset)||(await rootFingerprint(capture.root,capture.relative)).fingerprint!==capture.rootObservationFingerprint)return sourceWritesFail('UNDO_CONFLICT');
    if(!directory||backed.fact.backup!==path.join(directory,'safety',id,'backup')||await realpath(backed.fact.backup)!==backed.fact.backup)return sourceWritesFail('BACKUP_INVALID');
    const handle=await open(backed.fact.backup,constants.O_RDONLY|constants.O_NOFOLLOW);let backup:SourceBackupFact;
    try{const info=await handle.stat({bigint:true});if(!info.isFile()||info.nlink!==1n||Number(info.size)!==sourceBytes)return sourceWritesFail('BACKUP_INVALID');
      const attributes=await observeSourceBackupAttributes(backed.fact.backup,handle,restoreAttributes,backupAttributes);
      const actual=sourceBytes?audio?await observeSourceWriteFile(handle,signal):await observeSourcePublishedBlob(handle,4194304,signal):{sha256:createHash('sha256').update(Buffer.alloc(0)).digest('hex'),bytes:0,physical:{dev:String(info.dev),ino:String(info.ino)}};
      if(actual.sha256!==sourceHash||sourceBytes&&equal(actual.physical,audio?capture.observation.physical:capture.directoryBefore!.physical))return sourceWritesFail('BACKUP_INVALID');backup={path:backed.fact.backup,sha256:actual.sha256,bytes:actual.bytes,physical:actual.physical,attributes};if(fact&&!equal(backup,fact.fact.backup))return sourceWritesFail('BACKUP_INVALID');
    }finally{await handle.close();}
    const retained=uncertain.get(origin.plan.planId)?.claims??undefined,target=capture.directoryTarget??capture.relative;let currentSha256:string|null;
    if(retained){
      const namespace=namespaceObservation(origin.plan.planId,id,{root:capture.root,relative:target});if(!namespace)return sourceWritesFail('RECOVERY_REQUIRED');
      // 最新失败后代也属于同一原始operation；仅认证日志的发布意图可解释私有stage别名。
      const candidates=store.read(v=>[...v.projection.plans.values()].filter(p=>p.ready&&p.plan.datasetId===options.datasetId&&(p.plan.planId===origin.plan.planId||p.plan.recoveryOf===origin.plan.planId)).flatMap(p=>p.items.filter(i=>sourceWritesRootOperationId(p,origin,i.item.operationId)===id).flatMap(i=>{
        const events=p.events.filter((e):e is Extract<SourceWritesEvent,{kind:'phase'}>=>e.kind==='phase'&&e.fact.operationId===i.item.operationId),published=[...events].reverse().find(e=>e.fact.phase==='PUBLISH_INTENT'),staged=events.find(e=>e.fact.phase==='STAGED');
        return published&&staged&&published.fact.afterSha256!==null&&published.fact.afterSha256===staged.fact.afterSha256?[published.fact]:[];
      })).reverse());
      for(const fact of candidates)await reconcileSourcePublishedStage({root:capture.root,relative:target,operationId:fact.operationId,privateDirectory:path.join(directory,'safety'),stage:fact.stage,sha256:fact.afterSha256!,claims:retained,namespace,signal});
    }
    try{const current=await observedFile(capture.root,target,signal,async fd=>({content:audio?await observeSourceWriteFile(fd,signal):await observeSourcePublishedBlob(fd,4194304,signal),attributes:await observeSourceFileAttributes(path.join(capture.root.path,target),fd)}),retained,namespaceObservation(origin.plan.planId,id,{root:capture.root,relative:target}));currentSha256=current.content.sha256;
      if(!lineageContentHashes(origin,id).has(currentSha256)||!sameSourceFileAttributes(current.attributes,expectedCurrentTargetAttributes(origin,item)))return sourceWritesFail('UNDO_CONFLICT');
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'&&!(error instanceof SourceFileError&&error.code==='MISSING'))throw error;currentSha256=null;
      if(!phases.some(e=>e.fact.phase==='CAPTURE_INTENT'))return sourceWritesFail('UNDO_CONFLICT');
      if(audio||!absence){const quarantine=await privateMaterialSource(path.join(directory,'safety',id,'quarantine')),fd=await open(path.join(quarantine.root.path,quarantine.relative),constants.O_RDONLY|constants.O_NOFOLLOW);
        try{const actual=await observeSourcePublishedBlob(fd,268435456,signal);if(actual.sha256!==sourceHash||!equal(actual.physical,audio?capture.observation.physical:capture.directoryBefore!.physical))return sourceWritesFail('BACKUP_INVALID');const attrs=await observeSourceFileAttributes(path.join(quarantine.root.path,quarantine.relative),fd);if(!equal(attrs,audio?capture.attributes:capture.directoryAttributes))return sourceWritesFail('FILE_ATTRIBUTES_UNPROVEN');}finally{await fd.close();}}
    }
    return {originPlanId:origin.plan.planId,originOperationId:id,backup,expectedAfterSha256:currentSha256,removeTarget:absence,restoreAttributes};
  }
  function inverseOf(origin:SourceStoredPlan,operationIds:string[]):NonNullable<SourceWriteCapture['inverse']>[] {
    const existing=store.read(v=>[...v.projection.plans.values()].some(p=>p.plan.undoOf===origin.plan.planId&&p.plan.state==='COMPLETED'&&p.items.some(i=>i.capture.inverse&&operationIds.includes(i.capture.inverse.originOperationId))));if(existing)return sourceWritesFail('UNDO_CONFLICT');
    return operationIds.map(id=>{
      const item=origin.items.find(i=>i.item.operationId===id);if(!item||item.item.state!=='applied')return sourceWritesFail('UNDO_CONFLICT');
      const event=[...origin.events].reverse().find((e):e is Extract<SourceWritesEvent,{kind:'facts'|'directory-facts'}>=>(e.kind==='facts'||e.kind==='directory-facts')&&e.fact.operationId===id);if(!event)return sourceWritesFail('BACKUP_INVALID');
      if(event.kind==='facts'&&!equal(repository.localCatalog.asset(item.capture.asset.id),event.fact.afterAsset))return sourceWritesFail('UNDO_CONFLICT');
      const inverse={originPlanId:origin.plan.planId,originOperationId:id,backup:event.fact.backup,expectedAfterSha256:event.kind==='facts'?event.fact.observation.sha256:event.fact.after?.sha256??null,removeTarget:event.kind==='directory-facts'&&event.fact.beforeSha256===null,restoreAttributes:originalTargetAttributes(item)};restorationAttributes(inverse);return inverse;
    });
  }
  function visibleState(stored:SourceStoredPlan,projection?:SourceWritesProjection):dto.LocalSourceWritesState{
    if(requiresRecovery(stored,projection)){if(stored.plan.state==='COMPLETED'&&runs.has(stored.plan.planId))return 'RUNNING';if(!runs.has(stored.plan.planId))return 'RECOVERY_REQUIRED';}
    return stored.ownerEpoch!==ownerEpoch&&phases.has(stored.plan.state)?'BLOCKED':stored.plan.state;
  }
  function publicPlan(stored:SourceStoredPlan):dto.LocalSourceWritesPlan {
    const result=structuredClone(stored.plan);result.state=visibleState(stored);if(result.state==='RECOVERY_REQUIRED'){result.issues=['RECOVERY_REQUIRED'];result.resourceSummary.protection='unknown';}else if(result.state==='BLOCKED'&&stored.ownerEpoch!==ownerEpoch&&phases.has(stored.plan.state)){result.issues=['GRANT_MISMATCH'];result.resourceSummary.protection='unknown';}
    if(result.recoveryOf){result.recoveryChoices=[];if(result.state==='RECOVERY_REQUIRED')result.summary='此恢复发布仍待核对，请返回原计划恢复最初原件';return result;}
    if(result.state==='RECOVERY_REQUIRED'){const ids=rootUnresolvedOperations(stored).filter(id=>stored.events.some(e=>e.kind==='phase'&&e.fact.operationId===id&&e.fact.phase==='BACKUP'));
      if(ids.length){const lineage=store.read(v=>[...v.projection.plans.values()].filter(p=>p.plan.recoveryOf===stored.plan.planId&&sourceWritesUnresolvedOperations(p).length).map(p=>({planId:p.plan.planId,journalFingerprint:p.plan.journalFingerprint,operations:sourceWritesUnresolvedOperations(p)}))),fp=sourceWritesHash({planId:result.planId,viewRevision:result.viewRevision,journalFingerprint:result.journalFingerprint,lineage,operations:ids,action:'restore-original'}),id=`${fp.slice(0,8)}-${fp.slice(8,12)}-4${fp.slice(13,16)}-8${fp.slice(17,20)}-${fp.slice(20,32)}`;result.recoveryChoices=[{choiceId:id,originPlanId:result.planId,expectedOriginViewRevision:result.viewRevision,recoveryFingerprint:fp,action:'restore-original',label:'核对原件与备份后预览恢复',operationIds:ids}];}
    }return result;
  }
  const api={
    /** 唯一Owner prepare阶段调用并真实join；不由公开get/boot后懒安装。 */
    prepareRecoveryProtection():Promise<void>{if(recoveryPreparation)return recoveryPreparation;const operation=recoveryPrepared?Promise.resolve():installRecoveryProtection();recoveryPreparation=operation.catch(error=>{fatal??=error;throw error;}).finally(()=>{if(recoveryPreparation)pending.delete(recoveryPreparation);});pending.add(recoveryPreparation);return recoveryPreparation;},
    preview(raw:dto.PreviewLocalSourceWrites):dto.LocalSourceWritesReceipt {const request=captureRequest('localSourceWrites.preview',raw),cached=store.receipt('localSourceWrites.preview',request);if(cached)return cached;try{if(request.intent.kind==='recovery'){
        const intent=request.intent,origin=store.plan(options.datasetId,intent.originPlanId);assertRecoveryFamilyIdle(origin.plan.planId);const view=publicPlan(origin),choice=view.recoveryChoices.find(c=>c.choiceId===intent.choiceId);
        if(view.state!=='RECOVERY_REQUIRED'||view.viewRevision!==request.intent.expectedOriginViewRevision||!choice||choice.recoveryFingerprint!==request.intent.recoveryFingerprint||choice.action!=='restore-original')return sourceWritesFail('PREVIEW_MISMATCH');
        return accepted('localSourceWrites.preview',request,request.intent,undefined,origin,choice.operationIds);
      }return accepted('localSourceWrites.preview',request,request.intent);}catch(error){return reject('localSourceWrites.preview',request,error);}},
    get(raw:dto.GetLocalSourceWrites):dto.LocalSourceWritesGetResult {
      const request=captureRequest('localSourceWrites.get',raw),selector=request.selector;
      if(selector.kind==='command'){const found=store.commandReceipt(options.datasetId,selector.commandId,selector.expectedCommand,selector.requestFingerprint);return {datasetId:options.datasetId,kind:'command',commandId:selector.commandId,expectedCommand:selector.expectedCommand,requestFingerprint:selector.requestFingerprint,receipt:found,issue:found?null:'NOT_FOUND'};}
      if(selector.kind==='plan'){try{return {datasetId:options.datasetId,kind:'plan',plan:publicPlan(store.plan(options.datasetId,selector.planId)),issue:null};}catch(error){if(error instanceof SourceWritesError&&error.code==='NOT_FOUND')return {datasetId:options.datasetId,kind:'plan',plan:null,issue:'NOT_FOUND'};throw error;}}
      const materials:dto.LocalSourceWritesMaterial[]=[];if(selector.target){for(const track of selected(selector.target)){const context=repository.localArtwork.context({trackId:track.id,editionId:null}),selection=context.selection;if(!selection||materials.some(m=>m.editionId===selection.editionId))continue;const candidate=selection.candidate,ref=candidate?originals.refs().find(e=>e.candidateId===candidate.id&&e.target.editionId===selection.editionId&&e.original.sha256===candidate.original.sha256):null;materials.push({editionId:selection.editionId,selectionId:selection.id,selectionRevision:selection.revision,candidateId:candidate?.id??null,availability:ref?'available':candidate?'reacquire-required':'unavailable',contentRef:ref?.contentRef??null,originalSha256:candidate?.original.sha256??null,issue:ref?null:'ARTWORK_UNAVAILABLE'});}}
      const supported=!!safety&&['darwin','linux'].includes(process.platform);return {datasetId:options.datasetId,kind:'context',context:{datasetId:options.datasetId,policy:policy(),capabilities:{publisherProfile:'NONATOMIC_QUARANTINE_LINK_V1',formats:dto.LOCAL_SOURCE_WRITES_PROFILES.map(profile=>({profile,qualified:supported,tags:supported,embeddedCover:supported,fields:[...dto.LOCAL_SOURCE_WRITES_FIELDS],issue:supported?null:'FORMAT_NOT_QUALIFIED'})),directoryCover:{qualified:supported,issue:supported?null:'FORMAT_NOT_QUALIFIED'}},materials}};
    },
    history(raw:dto.HistoryLocalSourceWrites):dto.LocalSourceWritesHistoryPage{return store.history(captureRequest('localSourceWrites.history',raw),visibleState);},
    confirm(raw:dto.ConfirmLocalSourceWrites):dto.LocalSourceWritesReceipt {const request=captureRequest('localSourceWrites.confirm',raw),cached=store.receipt('localSourceWrites.confirm',request);return cached??reject('localSourceWrites.confirm',request,new SourceWritesError('GRANT_REQUIRED'));},
    undo(raw:dto.UndoLocalSourceWrites):dto.LocalSourceWritesReceipt {const request=captureRequest('localSourceWrites.undo',raw),cached=store.receipt('localSourceWrites.undo',request);if(cached)return cached;try{const origin=store.plan(options.datasetId,request.planId);if(origin.plan.viewRevision!==request.expectedViewRevision||origin.plan.journalFingerprint!==request.journalFingerprint)return sourceWritesFail('REVISION_CHANGED');return accepted('localSourceWrites.undo',request,origin.intent,inverseOf(origin,request.operationIds),origin);}catch(error){return reject('localSourceWrites.undo',request,error);}},
    cancel(raw:dto.CancelLocalSourceWrites):dto.LocalSourceWritesReceipt {const request=captureRequest('localSourceWrites.cancel',raw),cached=store.receipt('localSourceWrites.cancel',request);if(cached)return cached;try{const stored=store.plan(options.datasetId,request.planId);if(stored.plan.viewRevision!==request.expectedViewRevision)return sourceWritesFail('REVISION_CHANGED');if(!phases.has(stored.plan.state))return sourceWritesFail('PREVIEW_MISMATCH');const value=receipt('localSourceWrites.cancel',request,'accepted',stored.plan,null);saveReceipt('localSourceWrites.cancel',request,value);const running=runs.get(request.planId);store.state(options.datasetId,request.planId,running?'CANCEL_REQUESTED':'CANCELLED',running?[]:['CANCELLED'],true);running?.controller.abort();return value;}catch(error){return reject('localSourceWrites.cancel',request,error);}},
    setPolicy(raw:dto.SetLocalSourceWritesPolicy):dto.LocalSourceWritesReceipt {const request=captureRequest('localSourceWrites.setPolicy',raw),cached=store.receipt('localSourceWrites.setPolicy',request);if(cached)return cached;try{const current=policy();if(current.revision!==request.expectedPolicyRevision)return sourceWritesFail('POLICY_CHANGED');if(request.enabled&&(runs.size>0||pending.size>0))return sourceWritesFail('POLICY_DRAINING');const next={enabled:request.enabled,revision:(BigInt(current.revision)+1n).toString(),draining:!request.enabled&&(runs.size>0||pending.size>0||uncertain.size>0||hasPersistedRecovery())};if(!dto.isLocalSourceWritesPolicy(next))return sourceWritesFail('REVISION_EXHAUSTED');const value=receipt('localSourceWrites.setPolicy',request,'accepted',null,null,next);saveReceipt('localSourceWrites.setPolicy',request,value,null,null,next);grants.clear();if(!request.enabled){for(const r of runs.values())r.controller.abort();for(const p of store.read(v=>[...v.projection.plans.values()]))if(p.plan.datasetId===options.datasetId&&p.plan.state==='READY')store.state(options.datasetId,p.plan.planId,'BLOCKED',['POLICY_DISABLED'],true);}return value;}catch(error){return reject('localSourceWrites.setPolicy',request,error);}},
    async attachOriginal(raw:dto.AttachLocalSourceWritesOriginal,actor:SourceWritesMainActor):Promise<dto.LocalSourceWritesOriginalReceipt>{check();assertSourceWritesMainActor(actor);return originals.attach(raw);},
    challenge(raw:dto.LocalSourceWritesChallengeRequest,actor:SourceWritesMainActor):dto.LocalSourceWritesChallenge {
      check();assertSourceWritesMainActor(actor);const captured=dto.localSourceWritesMainRequestSnapshot({version:1,type:'source-writes-request',requestId:randomUUID(),sequence:1,command:'localSourceWrites.challenge',payload:raw});if(captured.command!=='localSourceWrites.challenge')return sourceWritesFail('INVALID_REQUEST');raw=captured.payload;const confirm=captureRequest('localSourceWrites.confirm',raw.confirm);if(raw.datasetId!==options.datasetId)return sourceWritesFail('DATASET_SCOPE_MISMATCH');if(store.receipt('localSourceWrites.confirm',confirm))return sourceWritesFail('GRANT_CONSUMED');const stored=checkedConfirm(confirm);
      for(const[id,v]of grants)if(v.consumed||now()>=Date.parse(v.challenge.expiresAt)||!v.actor.active)grants.delete(id);if(grants.size>=128)return sourceWritesFail('BUDGET_EXCEEDED');
      const binding={datasetId:options.datasetId,commandId:confirm.commandId,planId:confirm.planId,expectedViewRevision:confirm.expectedViewRevision,range:confirm.range,planHash:confirm.planHash,contextFingerprint:confirm.contextFingerprint,policyRevision:stored.plan.policyRevision,requestFingerprint:sourceWritesRequestFingerprint('localSourceWrites.confirm',confirm),expiresAt:stored.plan.expiresAt!};
      const unsigned={challengeId:randomUUID(),ownerEpoch,nonce:randomBytes(32).toString('hex'),authorityId:actor.authorityId},signature=createHmac('sha256',key).update(sourceWritesCanonical({binding,unsigned}),'utf8').digest('hex'),challenge={...binding,grant:{...unsigned,signature}};grants.set(unsigned.challengeId,{challenge,actor,consumed:false});return structuredClone(challenge);
    },
    executeGranted(raw:dto.ExecuteGrantedLocalSourceWrites,actor:SourceWritesMainActor):dto.LocalSourceWritesReceipt {
      check();assertSourceWritesMainActor(actor);const captured=dto.localSourceWritesMainRequestSnapshot({version:1,type:'source-writes-request',requestId:randomUUID(),sequence:1,command:'localSourceWrites.executeGranted',payload:raw});if(captured.command!=='localSourceWrites.executeGranted')return sourceWritesFail('INVALID_REQUEST');raw=captured.payload;const confirm=captureRequest('localSourceWrites.confirm',raw.confirm);if(raw.datasetId!==options.datasetId)return sourceWritesFail('DATASET_SCOPE_MISMATCH');const cached=store.receipt('localSourceWrites.confirm',confirm);if(cached)return cached;
      const registered=grants.get(raw.grant.challengeId);if(!registered||registered.actor!==actor||registered.consumed||raw.grant.ownerEpoch!==ownerEpoch||raw.grant.authorityId!==actor.authorityId||!equal(raw.grant,registered.challenge.grant))return sourceWritesFail('GRANT_MISMATCH');
      const {grant,...binding}=registered.challenge,{signature,...unsigned}=grant,expected=createHmac('sha256',key).update(sourceWritesCanonical({binding,unsigned}),'utf8').digest();const actual=Buffer.from(signature,'hex');if(actual.length!==expected.length||!timingSafeEqual(actual,expected)||sourceWritesRequestFingerprint('localSourceWrites.confirm',confirm)!==binding.requestFingerprint)return sourceWritesFail('GRANT_MISMATCH');
      const stored=checkedConfirm(confirm);if(runs.size>=2)return sourceWritesFail('BUDGET_EXCEEDED');const value=receipt('localSourceWrites.confirm',confirm,'accepted',stored.plan,null),occurredAt=new Date(now()).toISOString();
      const events:SourceWritesEvent[]=[sourceWritesEvent({version:1 as const,eventId:randomUUID(),datasetId:options.datasetId,planId:confirm.planId,occurredAt,kind:'receipt' as const,command:'localSourceWrites.confirm' as const,request:confirm,requestFingerprint:value.requestFingerprint,receipt:value,header:null,intent:null,ownerEpoch,policy:null}),sourceWritesEvent({version:1 as const,eventId:randomUUID(),datasetId:options.datasetId,planId:confirm.planId,occurredAt,kind:'state' as const,state:'QUEUED' as const,issues:[]})];
      store.capacity(0,events.reduce((bytes,event)=>bytes+Object.values(sourceWritesLedgerRow(event)).reduce((n,text)=>n+Buffer.byteLength(text),0),0));registered.consumed=true;
      store.transaction(view=>events.forEach(event=>view.append(event)));launch(confirm.planId,c=>execute(confirm.planId,c,actor));return value;
    },
    close():Promise<void>{if(closed)return closed;closing=true;grants.clear();for(const r of runs.values())r.controller.abort();closed=(async()=>{await Promise.allSettled([...pending]);await originals.close();await protection.close();store.close();if(fatal)throw fatal;if(uncertain.size)return sourceWritesFail('RELEASE_UNKNOWN');})();return closed;},
  };
  return api;
}
export function createLocalSourceWritesService(options:Options){return composeLocalSourceWritesService(options);}
/** 只注入可归因的阶段故障/调度；实际FD、属性探针、Hash与原保护不替换。 */
export function createTestLocalSourceWritesService(options:Options,test:{phase?(fact:import('./source-writes-publisher.js').SourcePublisherJournalFact):void}){return composeLocalSourceWritesService(options,test);}
export type LocalSourceWritesService=ReturnType<typeof createLocalSourceWritesService>;
