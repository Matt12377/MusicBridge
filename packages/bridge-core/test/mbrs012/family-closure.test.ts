import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {copyFile,lstat,readFile,writeFile} from 'node:fs/promises';
import {MessageChannel} from 'node:worker_threads';
import path from 'node:path';
import * as dto from '@music-bridge/contracts';
import {createCollectionRepository} from '../../src/collection/repository.js';
import {createLocalSourceWritesService,type LocalSourceWritesService} from '../../src/collection/local-source-writes-service.js';
import {createLocalSourceWritesStore} from '../../src/collection/local-source-writes-store.js';
import {createSourceWritesMainActor} from '../../src/collection/source-writes-authority.js';
import {SourceWritesError,sourceWritesEvent,sourceWritesUnresolvedOperations} from '../../src/collection/local-source-writes-journal.js';
import {openLocalPlaybackReadonlySource} from '../../src/recording/source-files.js';
import {physicalResourceLocks,PhysicalResourceBusy} from '../../src/stream/physical-resource-locks.js';
import {sourceServiceFixture,hash,type SourceServiceFixture} from './service-fixture.js';

const input='owned-stereo-fixed-tags.flac';
const currentSignature=async(file:string):Promise<string>=>{const value=await lstat(file,{bigint:true});return [value.dev,value.ino,value.size,value.mtimeNs,value.ctimeNs].join(':');};
const rejectedClosure=(error:unknown):boolean=>error instanceof SourceWritesError&&error.code==='RECOVERY_REQUIRED';
async function recoveryReady(f:SourceServiceFixture,rootId:string):Promise<dto.LocalSourceWritesPlan>{
  const deadline=Date.now()+30000;
  for(;;){const root=f.plan(rootId),choice=root.recoveryChoices[0];assert.ok(choice);const accepted=f.api.preview({datasetId:f.datasetId,commandId:randomUUID(),intent:{kind:'recovery',originPlanId:rootId,expectedOriginViewRevision:root.viewRevision,choiceId:choice.choiceId,recoveryFingerprint:choice.recoveryFingerprint}});
    if(accepted.outcome==='accepted'){assert.ok(accepted.planId);const ready=await f.waitPlan(accepted.planId,v=>v.state!=='PREVIEWING');assert.equal(ready.state,'READY',ready.issues.join(','));await f.captureBefore(ready);return ready;}
    assert.equal(accepted.issue,'POLICY_DRAINING');if(Date.now()>=deadline)assert.fail('认证根family的真实执行尚未join。');await new Promise<void>(resolve=>setTimeout(resolve,10));
  }
}
function currentPlan(api:LocalSourceWritesService,datasetId:string,id:string):dto.LocalSourceWritesPlan{
  const result=api.get({datasetId,selector:{kind:'plan',planId:id}});assert.ok(result.kind==='plan'&&result.plan);assert.ok(dto.isLocalSourceWritesPlan(result.plan));return result.plan;
}
async function wait(api:LocalSourceWritesService,datasetId:string,id:string,predicate:(plan:dto.LocalSourceWritesPlan)=>boolean):Promise<dto.LocalSourceWritesPlan>{
  const deadline=Date.now()+30000;for(;;){const plan=currentPlan(api,datasetId,id);if(predicate(plan))return plan;if(Date.now()>=deadline)assert.fail(`冷family未收口：${plan.state}/${plan.issues.join(',')}`);await new Promise<void>(resolve=>setTimeout(resolve,10));}
}

test('012 R与恢复A再次QUIET未知：B仍恢复R原件；真实family resolved持久后才释放，缺B closure冷重建只闭合剩余后代',async t=>{
  let fixture:SourceServiceFixture|undefined,armed:1|2|0=1,observeCommit=false,closureArmed=false,closureRejected=false,observePlanId='',observationError:unknown,historySnapshot:dto.LocalSourceWritesHistoryPage|undefined;
  const f=await sourceServiceFixture(t,{phase(fact){
    if(fact.phase!=='QUIET')return;
    if(armed){armed=armed===1?2:0;throw new Error('自有R/A真实FDquiet之后、guards释放之前的单次故障。');}
    observeCommit=true;
  },beforeCommit(action){
    if(action!=='local-source-writes:append')return;
    if(closureArmed){closureArmed=false;closureRejected=true;assert.equal(physicalResourceLocks.combinedSnapshot().resources,0);throw new Error('自有B真实family resolved及释放之后，closure提交前确定ROLLBACK。');}
    if(!observeCommit)return;observeCommit=false;closureArmed=true;
    // actual COMMIT完成、投影发布后，真实physical release仍须join已登记FD。
    // 在该微任务观察持久COMPLETED与公开RUNNING，不伪改服务run或锁对象。
    queueMicrotask(()=>{try{assert.ok(fixture&&observePlanId);const storage=createLocalSourceWritesStore(fixture.repository.localCatalog);try{assert.equal(storage.plan(fixture.datasetId,observePlanId).plan.state,'COMPLETED');assert.equal(fixture.plan(observePlanId).state,'RUNNING');historySnapshot=fixture.api.history({datasetId:fixture.datasetId,selector:{kind:'plans',range:'all'},cursor:null,limit:1});assert.ok(historySnapshot.kind==='plans');}finally{storage.close();}}catch(error){observationError=error;}});
  }});fixture=f;f.enable();const track=f.tracks.find(v=>f.relative(v)===input),other=f.tracks.find(v=>f.relative(v)!==input);assert.ok(track&&other);const file=path.join(f.media,input),before=await readFile(file),beforeRevision=f.repository.localCatalog.asset(track.assetId).fileRevision;
  const unrelated=await f.ready({kind:'tags',target:{mode:'single',trackId:other.id},fields:{title:{action:'set',value:'另一根计划不得借B解决'}}});assert.equal(f.api.cancel({datasetId:f.datasetId,commandId:randomUUID(),planId:unrelated.planId,expectedViewRevision:unrelated.viewRevision}).outcome,'accepted');
  const rootReady=await f.ready({kind:'tags',target:{mode:'single',trackId:track.id},fields:{title:{action:'set',value:'R真实发布后需要恢复最初原件'}}});f.execute(rootReady);
  const rootUnknown=await f.waitPlan(rootReady.planId,v=>v.state==='RECOVERY_REQUIRED');assert.ok(physicalResourceLocks.combinedSnapshot().writers>0);const written=await f.retain('root-written-before-A',f.tracks.indexOf(track));assert.notDeepEqual(await readFile(written),before);
  const unaffectedFile=path.join(f.media,f.relative(other)),unaffected=await openLocalPlaybackReadonlySource(f.repository.sources.root(f.source.id),f.relative(other),await currentSignature(unaffectedFile));await unaffected.verify();await unaffected.close();
  const a=await recoveryReady(f,rootUnknown.planId);assert.equal(a.recoveryOf,rootUnknown.planId);assert.equal(a.items[0]!.restoration?.originPlanId,rootUnknown.planId);f.execute(a);
  const aUnknown=await f.waitPlan(a.planId,v=>v.state==='RECOVERY_REQUIRED');assert.equal(armed,0);assert.deepEqual(aUnknown.recoveryChoices,[]);assert.ok(aUnknown.summary.includes('原计划'));assert.deepEqual(await readFile(file),before);assert.ok(physicalResourceLocks.combinedSnapshot().writers>0);
  const storage=createLocalSourceWritesStore(f.repository.localCatalog),rootOperation=rootUnknown.items[0]!.operationId,aOperation=aUnknown.items[0]!.operationId;
  try{
    const root=f.plan(rootUnknown.planId),choice=root.recoveryChoices[0];assert.ok(choice);assert.deepEqual(choice.operationIds,[rootOperation]);
    const childChoice=f.api.preview({datasetId:f.datasetId,commandId:randomUUID(),intent:{kind:'recovery',originPlanId:aUnknown.planId,expectedOriginViewRevision:aUnknown.viewRevision,choiceId:choice.choiceId,recoveryFingerprint:choice.recoveryFingerprint}});assert.equal(childChoice.outcome,'rejected');assert.equal(childChoice.issue,'PREVIEW_MISMATCH');
    const previous=storage.read(v=>({fingerprint:v.projection.fingerprint,bytes:v.projection.bytes}));
    assert.throws(()=>storage.append(sourceWritesEvent({version:1 as const,eventId:randomUUID(),datasetId:f.datasetId,planId:root.planId,occurredAt:new Date().toISOString(),kind:'protection-closed' as const,operationIds:[randomUUID()]}),true),rejectedClosure);
    assert.deepEqual(storage.read(v=>({fingerprint:v.projection.fingerprint,bytes:v.projection.bytes})),previous);assert.ok(physicalResourceLocks.combinedSnapshot().writers>0);
    const b=await recoveryReady(f,root.planId),bOperation=b.items[0]!.operationId;observePlanId=b.planId;
    const privateB=storage.plan(f.datasetId,b.planId),rootBackup=path.join(f.directory,'source-writes','safety',rootOperation,'backup'),aBackup=path.join(f.directory,'source-writes','safety',aOperation,'backup');
    assert.equal(privateB.items[0]!.capture.inverse?.originPlanId,root.planId);assert.equal(privateB.items[0]!.capture.inverse?.originOperationId,rootOperation);assert.equal(privateB.items[0]!.capture.inverse?.backup.path,rootBackup);
    assert.equal(b.items[0]!.restoration?.expectedOutputSha256,hash(before));assert.notEqual(hash(await readFile(aBackup)),hash(await readFile(rootBackup)));
    f.execute(b);const missingClosure=await f.waitPlan(b.planId,v=>['COMPLETED','RECOVERY_REQUIRED','FAILED'].includes(v.state));assert.equal(missingClosure.state,'RECOVERY_REQUIRED',missingClosure.issues.join(','));assert.equal(closureRejected,true);assert.equal(observationError,undefined);assert.ok(historySnapshot?.kind==='plans'&&historySnapshot.cursor);
    let page=historySnapshot,seen:dto.LocalSourceWritesPlanSummary[]=[...page.items];while(page.hasMore){assert.ok(page.cursor);const next=f.api.history({datasetId:f.datasetId,selector:{kind:'plans',range:'all'},cursor:page.cursor,limit:1});assert.ok(next.kind==='plans');assert.equal(next.snapshotFingerprint,page.snapshotFingerprint);seen.push(...next.items);page=next;}
    assert.equal(seen.find(v=>v.planId===b.planId)?.state,'RUNNING');const freshHistory=f.api.history({datasetId:f.datasetId,selector:{kind:'plans',range:'all'},cursor:null,limit:100});assert.ok(freshHistory.kind==='plans');assert.equal(freshHistory.items.find(v=>v.planId===b.planId)?.state,'RECOVERY_REQUIRED');
    assert.deepEqual(await readFile(file),before);assert.equal(f.repository.localCatalog.asset(track.assetId).fileRevision,(BigInt(beforeRevision)+3n).toString());assert.equal(physicalResourceLocks.combinedSnapshot().resources,0);
    for(const planId of [root.planId,a.planId]){const resolvedPlan=storage.plan(f.datasetId,planId);assert.deepEqual(sourceWritesUnresolvedOperations(resolvedPlan),[]);assert.equal(resolvedPlan.plan.state,'FAILED');}
    const bSeed=storage.plan(f.datasetId,b.planId);assert.deepEqual(sourceWritesUnresolvedOperations(bSeed),[bOperation]);assert.equal(bSeed.events.some(event=>event.kind==='protection-closed'),false);assert.ok(bSeed.events.some(event=>event.kind==='facts'&&event.fact.operationId===bOperation));assert.ok(bSeed.events.some(event=>event.kind==='phase'&&event.fact.operationId===bOperation&&event.fact.phase==='QUIET'));
    const resolved=storage.read(v=>v.projection.events.filter(e=>e.kind==='recovery-resolved'&&e.recoveryPlanId===b.planId));assert.deepEqual(resolved.map(e=>e.planId).sort(),[root.planId,a.planId].sort());
    const unchanged=storage.read(v=>({fingerprint:v.projection.fingerprint,bytes:v.projection.bytes}));
    for(const event of [sourceWritesEvent({version:1 as const,eventId:randomUUID(),datasetId:f.datasetId,planId:root.planId,occurredAt:new Date().toISOString(),kind:'recovery-resolved' as const,recoveryPlanId:b.planId,operationIds:[rootOperation]}),sourceWritesEvent({version:1 as const,eventId:randomUUID(),datasetId:randomUUID(),planId:root.planId,occurredAt:new Date().toISOString(),kind:'recovery-resolved' as const,recoveryPlanId:b.planId,operationIds:[rootOperation]}),sourceWritesEvent({version:1 as const,eventId:randomUUID(),datasetId:f.datasetId,planId:unrelated.planId,occurredAt:new Date().toISOString(),kind:'recovery-resolved' as const,recoveryPlanId:b.planId,operationIds:[unrelated.items[0]!.operationId]})])assert.throws(()=>storage.append(event,true),rejectedClosure);
    assert.deepEqual(storage.read(v=>({fingerprint:v.projection.fingerprint,bytes:v.projection.bytes})),unchanged);
    const bRestored=await f.retain('B-restored-root-original',f.tracks.indexOf(track)),preWrite=f.beforeOperations.get(rootOperation);assert.ok(preWrite?.file&&preWrite.originalStat);await assert.rejects(()=>f.close(),(error:unknown)=>error instanceof SourceWritesError&&error.code==='RELEASE_UNKNOWN');assert.equal(physicalResourceLocks.combinedSnapshot().resources,0);
    // B的原件/facts/QUIET与R/A resolved已真实持久，closure事务确定回滚留下认证冷窗口。
    // 不删除marker、不停旧触发器、不重置SAB；新的C仍只使用同一根R原件。
    const repository=createCollectionRepository({filePath:f.filePath}),channel=new MessageChannel(),actor=createSourceWritesMainActor(channel.port1),api=createLocalSourceWritesService({repository,datasetId:f.datasetId,ownerEpoch:randomUUID(),assertCurrent(){repository.localCatalog.root(f.root.id);}}),coldStorage=createLocalSourceWritesStore(repository.localCatalog);
    try{
      await api.prepareRecoveryProtection();const rootCold=currentPlan(api,f.datasetId,root.planId);assert.equal(rootCold.state,'RECOVERY_REQUIRED');assert.equal(currentPlan(api,f.datasetId,b.planId).state,'RECOVERY_REQUIRED');assert.deepEqual(rootCold.recoveryChoices[0]?.operationIds,[rootOperation]);
      const capability=repository.sources.root(f.source.id),signature=await currentSignature(file);await assert.rejects(()=>openLocalPlaybackReadonlySource(capability,input,signature),PhysicalResourceBusy);
      const coldChoice=rootCold.recoveryChoices[0];assert.ok(coldChoice);const accepted=api.preview({datasetId:f.datasetId,commandId:randomUUID(),intent:{kind:'recovery',originPlanId:root.planId,expectedOriginViewRevision:rootCold.viewRevision,choiceId:coldChoice.choiceId,recoveryFingerprint:coldChoice.recoveryFingerprint}});assert.equal(accepted.outcome,'accepted');assert.ok(accepted.planId);
      const ready=await wait(api,f.datasetId,accepted.planId,v=>v.state!=='PREVIEWING');assert.equal(ready.state,'READY',ready.issues.join(','));assert.equal(ready.recoveryOf,root.planId);assert.ok(ready.planHash&&ready.contextFingerprint);const confirm:dto.ConfirmLocalSourceWrites={datasetId:f.datasetId,commandId:randomUUID(),planId:ready.planId,expectedViewRevision:ready.viewRevision,scope:'SOURCE_FILES',range:ready.range,planHash:ready.planHash,contextFingerprint:ready.contextFingerprint},challenge=api.challenge({datasetId:f.datasetId,confirm},actor);assert.equal(api.executeGranted({datasetId:f.datasetId,confirm,grant:challenge.grant},actor).outcome,'accepted');
      const final=await wait(api,f.datasetId,ready.planId,v=>['COMPLETED','RECOVERY_REQUIRED','FAILED'].includes(v.state));assert.equal(final.state,'COMPLETED',final.issues.join(','));assert.equal(physicalResourceLocks.combinedSnapshot().resources,0);assert.deepEqual(await readFile(file),before);
      for(const id of [root.planId,a.planId,b.planId,final.planId])assert.deepEqual(sourceWritesUnresolvedOperations(coldStorage.plan(f.datasetId,id)),[]);
      const nextResolved=coldStorage.read(v=>v.projection.events.filter(e=>e.kind==='recovery-resolved'&&e.recoveryPlanId===final.planId));assert.deepEqual(nextResolved.map(e=>e.planId),[b.planId]);assert.equal(currentPlan(api,f.datasetId,root.planId).state,'FAILED');
      // 缺B marker时补B闭合并非重复；重复闭合负例绑定实际已经闭合的C，仍须零账本变化。
      const closed=coldStorage.read(view=>({fingerprint:view.projection.fingerprint,bytes:view.projection.bytes}));assert.throws(()=>coldStorage.append(sourceWritesEvent({version:1 as const,eventId:randomUUID(),datasetId:f.datasetId,planId:final.planId,occurredAt:new Date().toISOString(),kind:'protection-closed' as const,operationIds:final.items.map(item=>item.operationId)}),true),rejectedClosure);assert.deepEqual(coldStorage.read(view=>({fingerprint:view.projection.fingerprint,bytes:view.projection.bytes})),closed);
      const lease=await openLocalPlaybackReadonlySource(capability,input,await currentSignature(file));await lease.verify();await lease.close();const restored=path.join(f.directory,'cold-C-restored-root-original.flac');await copyFile(file,restored);
      const manifest=path.join(f.directory,'family-closure-evidence.json');await writeFile(manifest,JSON.stringify({owned:true,coldInput:'B真实family resolved及释放之后，closure提交前确定ROLLBACK；未删除账本或重置SAB',sourceRoot:f.media,safetyRoot:path.join(f.directory,'source-writes','safety'),before:preWrite.file,originalStat:preWrite.originalStat,originalAttributes:preWrite.originalAttributes,backup:rootBackup,target:file,after:written,restored,rootPlanId:root.planId,aPlanId:a.planId,bPlanId:b.planId,cPlanId:final.planId,aBackup,bRestored,bClosureRolledBack:closureRejected,expectedOutputSha256:hash(before),actualResourcesAfterClosure:physicalResourceLocks.combinedSnapshot().resources},null,2)+'\n',{flag:'wx',mode:0o600});t.diagnostic(`Source根family/真实quiet/缺closure冷重建材料：${manifest}`);
    }finally{coldStorage.close();await api.close();channel.port1.close();channel.port2.close();repository.close();}
  }finally{storage.close();}
});
