import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {copyFile,lstat,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import * as dto from '@music-bridge/contracts';
import {createCollectionRepository} from '../../src/collection/repository.js';
import {physicalResourceLocks} from '../../src/stream/physical-resource-locks.js';
import {sourceServiceFixture,hash,type SourceServiceFixture} from './service-fixture.js';
import {sourceOwner} from './owner-fixture.js';

const input='owned-stereo-fixed-tags.flac';
async function start(o:ReturnType<typeof sourceOwner>,f:SourceServiceFixture){
  await o.boot();await o.request('localSourceWrites.setPolicy',{datasetId:f.datasetId,commandId:randomUUID(),expectedPolicyRevision:'1',enabled:true});
  const receipt=await o.request('localSourceWrites.preview',{datasetId:f.datasetId,commandId:randomUUID(),intent:{kind:'tags',target:f.target(),fields:{title:{action:'set',value:'阶段故障的真实写后标题'}}}});assert.equal(receipt.outcome,'accepted');assert.ok(receipt.planId);
  const plan=await o.waitPlan(receipt.planId,v=>v.state!=='PREVIEWING');assert.equal(plan.state,'READY',plan.issues.join(','));const executed=await o.confirm(plan);assert.equal(executed.accepted.outcome,'accepted');return {plan,executed};
}
async function recover(o:ReturnType<typeof sourceOwner>,f:SourceServiceFixture,origin:dto.LocalSourceWritesPlan){
  const choice=origin.recoveryChoices[0];assert.ok(choice);const request:dto.PreviewLocalSourceWrites={datasetId:f.datasetId,commandId:randomUUID(),intent:{kind:'recovery',originPlanId:origin.planId,expectedOriginViewRevision:origin.viewRevision,choiceId:choice.choiceId,recoveryFingerprint:choice.recoveryFingerprint}};
  const accepted=await o.request('localSourceWrites.preview',request);assert.equal(accepted.outcome,'accepted');assert.ok(accepted.planId);const ready=await o.waitPlan(accepted.planId,v=>v.state!=='PREVIEWING');assert.equal(ready.state,'READY',ready.issues.join(','));assert.equal(ready.recoveryOf,origin.planId);assert.equal(ready.items[0]!.restoration!.originOperationId,origin.items[0]!.operationId);
  await o.confirm(ready);const result=await o.waitPlan(ready.planId,v=>['COMPLETED','FAILED','RECOVERY_REQUIRED'].includes(v.state));assert.equal(result.state,'COMPLETED',result.issues.join(','));assert.equal((await o.plan(origin.planId)).state,'FAILED');return result;
}

for(const phase of ['BACKUP','STAGED','CAPTURE_INTENT'] as const)test(`012 ${phase}真实阶段故障：移动之前源bytes/inode/Asset不变且可以正常关闭`,async t=>{
  const f=await sourceServiceFixture(t,{files:[input]}),file=path.join(f.media,input),original=await readFile(file),before=await lstat(file,{bigint:true}),asset=f.repository.localCatalog.asset(f.tracks[0]!.assetId);await f.close();const state=new SharedArrayBuffer(12),words=new Int32Array(state),o=sourceOwner(f,{sharedLocks:true,faultPhase:phase,state});
  try{
    const {plan}=await start(o,f),failed=await o.waitPlan(plan.planId,v=>['FAILED','CANCELLED','RECOVERY_REQUIRED','COMPLETED'].includes(v.state));assert.equal(failed.state,'FAILED');assert.equal(Atomics.load(words,0),1);assert.ok(Atomics.load(words,1)>0);assert.ok(Atomics.load(words,2)>0,'QUIET落盘时真实guards仍在；结束后才核释放');
    assert.deepEqual(await readFile(file),original);const current=await lstat(file,{bigint:true});assert.equal(current.dev,before.dev);assert.equal(current.ino,before.ino);const repository=createCollectionRepository({filePath:f.filePath});try{assert.deepEqual(repository.localCatalog.asset(asset.id),asset);}finally{repository.close();}
    const backup=path.join(f.directory,'source-writes','safety',plan.items[0]!.operationId,'backup');assert.deepEqual(await readFile(backup),original);const info=await lstat(backup,{bigint:true});assert.notEqual(`${info.dev}:${info.ino}`,`${before.dev}:${before.ino}`);await assert.rejects(lstat(path.join(path.dirname(backup),'quarantine')),{code:'ENOENT'});
  }finally{await o.close();}assert.equal(physicalResourceLocks.combinedSnapshot().resources,0);
});

for(const phase of ['CAPTURED','PUBLISH_INTENT','PUBLISHED','CLEANUP','VERIFIED'] as const)test(`012 ${phase}真实阶段故障：捕获后保全独立backup/quarantine，旧accepted不重写，新明确恢复核实quiet`,async t=>{
  const f=await sourceServiceFixture(t,{files:[input]}),file=path.join(f.media,input),original=await readFile(file),before=await lstat(file,{bigint:true}),asset=f.repository.localCatalog.asset(f.tracks[0]!.assetId);await f.close();const state=new SharedArrayBuffer(12),words=new Int32Array(state),o=sourceOwner(f,{sharedLocks:true,faultPhase:phase,state});
  try{
    const {plan,executed}=await start(o,f),unknown=await o.waitPlan(plan.planId,v=>['RECOVERY_REQUIRED','FAILED','COMPLETED'].includes(v.state));assert.equal(unknown.state,'RECOVERY_REQUIRED');assert.equal(unknown.items[0]!.state,'unknown');assert.equal(Atomics.load(words,0),1);assert.ok(Atomics.load(words,1)>0);
    const operationId=plan.items[0]!.operationId,privateDirectory=path.join(f.directory,'source-writes','safety',operationId),backup=path.join(privateDirectory,'backup'),quarantine=path.join(privateDirectory,'quarantine');assert.deepEqual(await readFile(backup),original);assert.deepEqual(await readFile(quarantine),original);
    const captured=await lstat(quarantine,{bigint:true}),copy=await lstat(backup,{bigint:true});assert.equal(captured.dev,before.dev);assert.equal(captured.ino,before.ino);assert.notEqual(`${copy.dev}:${copy.ino}`,`${captured.dev}:${captured.ino}`);
    const repository=createCollectionRepository({filePath:f.filePath});try{assert.deepEqual(repository.localCatalog.asset(asset.id),asset);}finally{repository.close();}
    let after:string|null=null;if(phase==='CAPTURED'||phase==='PUBLISH_INTENT')await assert.rejects(lstat(file),{code:'ENOENT'});else{after=path.join(f.directory,`${phase}-published-before-recovery.flac`);await copyFile(file,after);assert.notEqual(hash(await readFile(file)),hash(original));}
    const immutable=await o.main('localSourceWrites.executeGranted',{datasetId:f.datasetId,confirm:executed.confirm,grant:executed.challenge.grant});assert.deepEqual(immutable,executed.accepted);assert.equal((await o.plan(plan.planId)).journalFingerprint,unknown.journalFingerprint);
    const refused=await o.request('localSourceWrites.preview',{datasetId:f.datasetId,commandId:randomUUID(),intent:{kind:'tags',target:f.target(),fields:{title:{action:'set',value:'未知期间禁止普通计划'}}}});assert.equal(refused.issue,'RECOVERY_REQUIRED');
    const restored=await recover(o,f,unknown);assert.deepEqual(await readFile(file),original);assert.ok(Atomics.load(words,2)>0);assert.equal(physicalResourceLocks.combinedSnapshot().resources,0);const undo=path.join(f.directory,`${phase}-restored.flac`);await copyFile(file,undo);const preWrite=f.preWriteSources.get(f.tracks[0]!.id);assert.ok(preWrite?.file&&preWrite.originalStat);assert.deepEqual(await readFile(preWrite.file),original);
    const manifest=path.join(f.directory,`${phase}-publication-evidence.json`);await writeFile(manifest,JSON.stringify({owned:true,faultPhase:phase,sourceRoot:f.media,safetyRoot:path.join(f.directory,'source-writes','safety'),before:preWrite.file,originalStat:preWrite.originalStat,originalAttributes:preWrite.originalAttributes,after,undo,restored:undo,target:file,backup,quarantine,originPlanId:plan.planId,recoveryPlanId:restored.planId,beforeSha256:hash(original),restoredSha256:hash(await readFile(file))},null,2)+'\n',{flag:'wx',mode:0o600});t.diagnostic(`Source真实故障/写前/备份/恢复材料：${manifest}`);
  }finally{await o.close().catch(()=>undefined);}assert.equal(physicalResourceLocks.combinedSnapshot().resources,0);
});

test('012 文件已发布而facts事务确定ROLLBACK：旧catalog/scan保留，文件不能标伪失败或自动回退，明确恢复新事实',async t=>{
  const f=await sourceServiceFixture(t,{files:[input]}),file=path.join(f.media,input),original=await readFile(file),asset=f.repository.localCatalog.asset(f.tracks[0]!.assetId),scan=f.repository.localScan.privateCurrentFileState(f.root.id,input);await f.close();const state=new SharedArrayBuffer(12),words=new Int32Array(state),o=sourceOwner(f,{sharedLocks:true,rollbackFacts:true,state});
  try{
    const {plan}=await start(o,f),unknown=await o.waitPlan(plan.planId,v=>['RECOVERY_REQUIRED','FAILED','COMPLETED'].includes(v.state));assert.equal(Atomics.load(words,0),1);assert.equal(unknown.state,'RECOVERY_REQUIRED');assert.notDeepEqual(await readFile(file),original);const repository=createCollectionRepository({filePath:f.filePath});try{assert.deepEqual(repository.localCatalog.asset(asset.id),asset);assert.deepEqual(repository.localScan.privateCurrentFileState(f.root.id,input),scan);}finally{repository.close();}
    await recover(o,f,unknown);assert.deepEqual(await readFile(file),original);assert.ok(Atomics.load(words,2)>0);assert.equal(physicalResourceLocks.combinedSnapshot().resources,0);
  }finally{await o.close().catch(()=>undefined);}assert.equal(physicalResourceLocks.combinedSnapshot().resources,0);
});

for(const phase of ['FACTS_COMMITTED','QUIET'] as const)test(`012 ${phase}后真实诊断异常：已落事实不回滚，immutable受理不再发布，实际FDquiet记录不伪造`,async t=>{
  const f=await sourceServiceFixture(t,{files:[input]}),file=path.join(f.media,input),original=await readFile(file),asset=f.repository.localCatalog.asset(f.tracks[0]!.assetId);await f.close();const state=new SharedArrayBuffer(12),words=new Int32Array(state),o=sourceOwner(f,{sharedLocks:true,faultPhase:phase,state});
  try{
    const {plan,executed}=await start(o,f),ended=await o.waitPlan(plan.planId,v=>['COMPLETED','FAILED','RECOVERY_REQUIRED'].includes(v.state));assert.equal(Atomics.load(words,0),1);assert.equal(ended.state,phase==='QUIET'?'RECOVERY_REQUIRED':'COMPLETED');const written=await readFile(file);assert.notDeepEqual(written,original);
    const repository=createCollectionRepository({filePath:f.filePath});try{assert.equal(repository.localCatalog.asset(asset.id).fileRevision,(BigInt(asset.fileRevision)+1n).toString());assert.equal(repository.localCatalog.trackDetail(f.tracks[0]!.id).metadata.raw.title,'阶段故障的真实写后标题');}finally{repository.close();}
    assert.deepEqual(await o.main('localSourceWrites.executeGranted',{datasetId:f.datasetId,confirm:executed.confirm,grant:executed.challenge.grant}),executed.accepted);assert.deepEqual(await readFile(file),written);assert.equal((await o.plan(plan.planId)).journalFingerprint,ended.journalFingerprint);assert.ok(Atomics.load(words,2)>0);
    if(phase==='QUIET'){assert.ok(physicalResourceLocks.combinedSnapshot().writers>0);await recover(o,f,ended);assert.deepEqual(await readFile(file),original);}assert.equal(physicalResourceLocks.combinedSnapshot().resources,0);
  }finally{await o.close().catch(()=>undefined);}assert.equal(physicalResourceLocks.combinedSnapshot().resources,0);
});
