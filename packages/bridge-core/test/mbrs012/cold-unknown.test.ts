import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {copyFile,lstat,readFile,writeFile} from 'node:fs/promises';
import {MessageChannel} from 'node:worker_threads';
import path from 'node:path';
import * as dto from '@music-bridge/contracts';
import {createCollectionRepository} from '../../src/collection/repository.js';
import {createLocalSourceWritesService} from '../../src/collection/local-source-writes-service.js';
import {createSourceWritesMainActor} from '../../src/collection/source-writes-authority.js';
import {createLocalSourceWritesStore} from '../../src/collection/local-source-writes-store.js';
import {SourceWritesError,sourceWritesUnresolvedOperations} from '../../src/collection/local-source-writes-journal.js';
import {physicalResourceLocks,PhysicalResourceBusy} from '../../src/stream/physical-resource-locks.js';
import {openLocalPlaybackReadonlySource,withCheckedReadonlyMetadataSource,withVerifiedReadonlySource} from '../../src/recording/source-files.js';
import {loadFreshMetadataReader} from '../helpers/mbrs003-audio-fixtures.js';
import {sourceServiceFixture,hash} from './service-fixture.js';
import {sourceOwner} from './owner-fixture.js';

const currentSignature=async(file:string):Promise<string>=>{const info=await lstat(file,{bigint:true});return [info.dev,info.ino,info.size,info.mtimeNs,info.ctimeNs].join(':');};

test('012 真事实COMMIT后ACK未知：新Owner/SAB仅阻涉事新读取，原修订不伪改，显式恢复后重新可读',async t=>{
  const sourceName='owned-stereo-fixed-tags.flac',unaffectedName='owned-unaffected.flac';
  const f=await sourceServiceFixture(t,{files:[sourceName],aliases:[{ownedFile:sourceName,relative:unaffectedName}]}),track=f.tracks.find(v=>f.relative(v)===sourceName),other=f.tracks.find(v=>f.relative(v)===unaffectedName);assert.ok(track&&other);
  const target=f.target(f.tracks.indexOf(track)),file=path.join(f.media,sourceName),original=await readFile(file),otherFile=path.join(f.media,unaffectedName),otherBytes=await readFile(otherFile),oldAsset=f.repository.localCatalog.asset(track.assetId);await f.close();
  // 旧Owner线程使用自己的SAB。实际线程退出后，新协调器必须从持久journal安装隔离。
  assert.equal(physicalResourceLocks.combinedSnapshot().resources,0);const state=new SharedArrayBuffer(4),words=new Int32Array(state),o=sourceOwner(f,{commitUnknown:true,state});
  try{
    await o.boot();await o.request('localSourceWrites.setPolicy',{datasetId:f.datasetId,commandId:randomUUID(),expectedPolicyRevision:'1',enabled:true});
    const receipt=await o.request('localSourceWrites.preview',{datasetId:f.datasetId,commandId:randomUUID(),intent:{kind:'tags',target,fields:{title:{action:'set',value:'真实COMMIT但结果未知'}}}});assert.ok(receipt.planId);
    const p=await o.waitPlan(receipt.planId,v=>v.state!=='PREVIEWING');assert.equal(p.state,'READY');await o.confirm(p);
    const deadline=Date.now()+10000;while(Atomics.load(words,0)===0){if(Date.now()>=deadline)assert.fail('未发生真实facts COMMIT后丢ACK');await new Promise<void>(resolve=>setTimeout(resolve,10));}await o.worker.terminate();
    assert.equal(physicalResourceLocks.combinedSnapshot().resources,0);
    const repository=createCollectionRepository({filePath:f.filePath}),channel=new MessageChannel(),actor=createSourceWritesMainActor(channel.port1),api=createLocalSourceWritesService({repository,datasetId:f.datasetId,ownerEpoch:randomUUID(),assertCurrent(){repository.localCatalog.root(f.root.id);}});
    await api.prepareRecoveryProtection();
    const lifecycle:string[]=[],reader=(await loadFreshMetadataReader()).createMetadataReader({onLifecycle(event){lifecycle.push(event.type);}});
    const plan=(planId:string):dto.LocalSourceWritesPlan=>{const value=api.get({datasetId:f.datasetId,selector:{kind:'plan',planId}});assert.ok(value.kind==='plan'&&value.plan);assert.ok(dto.isLocalSourceWritesPlan(value.plan));return value.plan;};
    const wait=async(planId:string,predicate:(value:dto.LocalSourceWritesPlan)=>boolean):Promise<dto.LocalSourceWritesPlan>=>{const end=Date.now()+30000;for(;;){const value=plan(planId);if(predicate(value))return value;if(Date.now()>=end)assert.fail(`恢复状态未闭合：${value.state}/${value.issues.join(',')}`);await new Promise<void>(resolve=>setTimeout(resolve,10));}};
    try{
      const asset=repository.localCatalog.asset(track.assetId);assert.equal(asset.id,oldAsset.id);assert.equal(asset.fileRevision,(BigInt(oldAsset.fileRevision)+1n).toString());
      const current=await readFile(file);assert.notEqual(hash(current),hash(original));assert.equal(repository.localCatalog.trackDetail(track.id).metadata.raw.title,'真实COMMIT但结果未知');
      const unresolved=plan(p.planId);assert.equal(unresolved.state,'RECOVERY_REQUIRED');assert.ok(unresolved.recoveryChoices.length);
      const root=repository.sources.root(f.source.id),beforeRead=repository.localCatalog.asset(track.assetId),scanBefore=repository.localScan.privateCurrentFileState(f.root.id,sourceName),sourceBefore=repository.sources.roots();
      const blocked=api.preview({datasetId:f.datasetId,commandId:randomUUID(),intent:{kind:'tags',target,fields:{title:{action:'set',value:'禁止普通新写'}}}});assert.equal(blocked.outcome,'rejected');assert.equal(blocked.issue,'RECOVERY_REQUIRED');
      // 目标确实存在、签名是本轮当前事实，错误必须来自同SAB恢复保护，而非过时URL或格式门禁。
      const signature=await currentSignature(file);let opened=false,metadataConsumed=false,recordingConsumed=false;
      await assert.rejects(async()=>{const lease=await openLocalPlaybackReadonlySource(root,sourceName,signature);try{opened=true;}finally{await lease.close();}},PhysicalResourceBusy);assert.equal(opened,false);
      await assert.rejects(()=>withCheckedReadonlyMetadataSource(root,sourceName,signature,new AbortController().signal,async()=>{metadataConsumed=true;}),PhysicalResourceBusy);assert.equal(metadataConsumed,false);
      lifecycle.length=0;const parsed=await reader.read({root,relative:sourceName,expectedSignature:signature});assert.equal(parsed.status,'failure');assert.ok(parsed.status==='failure');assert.equal(parsed.code,'IO_ERROR');assert.equal(lifecycle.filter(v=>v==='worker-start').length,0);assert.equal(lifecycle.filter(v=>v==='lease-acquired').length,0);
      await assert.rejects(()=>withVerifiedReadonlySource(root,sourceName,{sha256:hash(current),size:current.length},new AbortController().signal,async()=>{recordingConsumed=true;}),PhysicalResourceBusy);assert.equal(recordingConsumed,false);
      assert.deepEqual(repository.localCatalog.asset(track.assetId),beforeRead);assert.deepEqual(repository.localScan.privateCurrentFileState(f.root.id,sourceName),scanBefore);assert.deepEqual(repository.sources.roots(),sourceBefore);assert.deepEqual(await readFile(file),current);
      const unrelated=await reader.read({root,relative:unaffectedName,expectedSignature:await currentSignature(otherFile)});assert.equal(unrelated.status,'ok');const unrelatedLease=await openLocalPlaybackReadonlySource(root,unaffectedName,await currentSignature(otherFile));await unrelatedLease.verify();await unrelatedLease.close();assert.deepEqual(await readFile(otherFile),otherBytes);
      // OFF与ON只改变策略代际。旧恢复材料在排空后仍挡普通入口；恢复需要新READY及新私有grant。
      const context=api.get({datasetId:f.datasetId,selector:{kind:'context',target:null}});assert.ok(context.kind==='context');const off=api.setPolicy({datasetId:f.datasetId,commandId:randomUUID(),expectedPolicyRevision:context.context.policy.revision,enabled:false});assert.equal(off.outcome,'accepted');assert.ok(off.policy);
      const on=api.setPolicy({datasetId:f.datasetId,commandId:randomUUID(),expectedPolicyRevision:off.policy.revision,enabled:true});assert.equal(on.outcome,'accepted');assert.equal(on.policy?.draining,false);
      const stillBlocked=api.preview({datasetId:f.datasetId,commandId:randomUUID(),intent:{kind:'tags',target,fields:{title:{action:'set',value:'恢复前仍禁止新写'}}}});assert.equal(stillBlocked.issue,'RECOVERY_REQUIRED');
      const origin=plan(p.planId),choice=origin.recoveryChoices[0];assert.ok(choice);const recovery=api.preview({datasetId:f.datasetId,commandId:randomUUID(),intent:{kind:'recovery',originPlanId:origin.planId,expectedOriginViewRevision:origin.viewRevision,choiceId:choice.choiceId,recoveryFingerprint:choice.recoveryFingerprint}});assert.equal(recovery.outcome,'accepted');assert.ok(recovery.planId);
      const ready=await wait(recovery.planId,v=>v.state!=='PREVIEWING');assert.equal(ready.state,'READY',ready.issues.join(','));assert.equal(ready.recoveryOf,origin.planId);assert.ok(ready.planHash&&ready.contextFingerprint);
      const confirm:dto.ConfirmLocalSourceWrites={datasetId:f.datasetId,commandId:randomUUID(),planId:ready.planId,expectedViewRevision:ready.viewRevision,scope:'SOURCE_FILES',range:ready.range,planHash:ready.planHash,contextFingerprint:ready.contextFingerprint},challenge=api.challenge({datasetId:f.datasetId,confirm},actor),accepted=api.executeGranted({datasetId:f.datasetId,confirm,grant:challenge.grant},actor);assert.equal(accepted.outcome,'accepted');
      const restored=await wait(ready.planId,v=>['COMPLETED','FAILED','RECOVERY_REQUIRED'].includes(v.state));assert.equal(restored.state,'COMPLETED',restored.issues.join(','));assert.deepEqual(await readFile(file),original);assert.equal(plan(origin.planId).state,'FAILED');assert.equal(physicalResourceLocks.combinedSnapshot().resources,0);
      const fresh=await reader.read({root,relative:sourceName,expectedSignature:await currentSignature(file)});assert.equal(fresh.status,'ok');const freshLease=await openLocalPlaybackReadonlySource(root,sourceName,await currentSignature(file));await freshLease.verify();await freshLease.close();
      const preWrite=f.preWriteSources.get(track.id);assert.ok(preWrite?.file&&preWrite.originalStat);const beforeRecovery=path.join(f.directory,'committed-before-cold-recovery.flac');await writeFile(beforeRecovery,current,{flag:'wx',mode:0o600});const retainedRestored=path.join(f.directory,'cold-explicit-restored.flac');await copyFile(file,retainedRestored);
      const manifest=path.join(f.directory,'cold-unknown-evidence.json');await writeFile(manifest,JSON.stringify({owned:true,sourceRoot:f.media,safetyRoot:path.join(f.directory,'source-writes','safety'),before:preWrite.file,originalStat:preWrite.originalStat,originalAttributes:preWrite.originalAttributes,backup:path.join(f.directory,'source-writes','safety',p.items[0]!.operationId,'backup'),target:file,after:beforeRecovery,restored:retainedRestored,currentFile:file,committedSha256:hash(current),committedRevision:asset.fileRevision,originalPlanId:p.planId,recoveryPlanId:restored.planId,restoredSha256:hash(original),unaffectedFile:otherFile,newReadsBlockedBeforeRecovery:true,freshReadAfterRecovery:true},null,2)+'\n',{flag:'wx',mode:0o600});t.diagnostic(`Source真实COMMIT_UNKNOWN/冷保护/独立备份恢复材料：${manifest}`);
    }finally{await reader.close();await api.close();channel.port1.close();channel.port2.close();repository.close();}
  }finally{await o.close().catch(()=>undefined);}assert.equal(physicalResourceLocks.combinedSnapshot().resources,0);
});

test('012 真实closure COMMIT完成后ACK未知：实际guards已经释放不retain复活，冷读取核marker与新事实且不补grant重放',async t=>{
  const input='owned-stereo-fixed-tags.flac',f=await sourceServiceFixture(t,{files:[input]}),file=path.join(f.media,input),track=f.tracks[0]!,original=await readFile(file),asset=f.repository.localCatalog.asset(track.assetId);await f.close();
  const state=new SharedArrayBuffer(8),words=new Int32Array(state),o=sourceOwner(f,{closureCommitUnknown:true,state});
  try{
    await o.boot();await o.request('localSourceWrites.setPolicy',{datasetId:f.datasetId,commandId:randomUUID(),expectedPolicyRevision:'1',enabled:true});const accepted=await o.request('localSourceWrites.preview',{datasetId:f.datasetId,commandId:randomUUID(),intent:{kind:'tags',target:f.target(),fields:{title:{action:'set',value:'真实闭合COMMIT后丢ACK'}}}});assert.ok(accepted.planId);const ready=await o.waitPlan(accepted.planId,v=>v.state!=='PREVIEWING');assert.equal(ready.state,'READY',ready.issues.join(','));const executed=await o.confirm(ready);
    const deadline=Date.now()+30000;while(Atomics.load(words,0)===0){if(Date.now()>=deadline)assert.fail('closure真实COMMIT后ACK未知窗口未到达。');await new Promise<void>(resolve=>setTimeout(resolve,10));}
    assert.equal(Atomics.load(words,1),0,'故障发生于真实physical/names释放之后，不能把旧token重新称为held。');await o.worker.terminate();assert.equal(physicalResourceLocks.combinedSnapshot().resources,0);
    const repository=createCollectionRepository({filePath:f.filePath}),storage=createLocalSourceWritesStore(repository.localCatalog),channel=new MessageChannel(),actor=createSourceWritesMainActor(channel.port1),api=createLocalSourceWritesService({repository,datasetId:f.datasetId,ownerEpoch:randomUUID(),assertCurrent(){repository.localCatalog.root(f.root.id);}});
    try{
      await api.prepareRecoveryProtection();const privatePlan=storage.plan(f.datasetId,ready.planId);assert.equal(privatePlan.plan.state,'RUNNING');assert.equal(privatePlan.events.filter(e=>e.kind==='protection-closed').length,1);assert.deepEqual(sourceWritesUnresolvedOperations(privatePlan),[]);assert.equal(physicalResourceLocks.combinedSnapshot().resources,0);
      const current=await readFile(file);assert.notDeepEqual(current,original);assert.equal(repository.localCatalog.asset(asset.id).fileRevision,(BigInt(asset.fileRevision)+1n).toString());assert.equal(repository.localCatalog.trackDetail(track.id).metadata.raw.title,'真实闭合COMMIT后丢ACK');
      const view=api.get({datasetId:f.datasetId,selector:{kind:'plan',planId:ready.planId}});assert.ok(view.kind==='plan'&&view.plan);assert.equal(view.plan.state,'BLOCKED');assert.deepEqual(view.plan.issues,['GRANT_MISMATCH']);assert.deepEqual(view.plan.recoveryChoices,[]);
      const receipt=api.get({datasetId:f.datasetId,selector:{kind:'command',commandId:executed.confirm.commandId,expectedCommand:'localSourceWrites.confirm',requestFingerprint:executed.accepted.requestFingerprint}});assert.ok(receipt.kind==='command');assert.deepEqual(receipt.receipt,structuredClone(executed.accepted));
      assert.throws(()=>api.challenge({datasetId:f.datasetId,confirm:executed.confirm},actor),(error:unknown)=>error instanceof SourceWritesError&&error.code==='GRANT_CONSUMED');assert.deepEqual(api.confirm(executed.confirm),structuredClone(executed.accepted));assert.deepEqual(await readFile(file),current);
      const lease=await openLocalPlaybackReadonlySource(repository.sources.root(f.source.id),input,await currentSignature(file));try{const read=Buffer.alloc(current.length);assert.equal((await lease.handle.read(read,0,read.length,0)).bytesRead,current.length);assert.deepEqual(read,current);await lease.verify();}finally{await lease.close();}
      const preWrite=f.preWriteSources.get(track.id);assert.ok(preWrite?.file&&preWrite.originalStat);const after=path.join(f.directory,'closure-commit-unknown-written.flac');await copyFile(file,after);const manifest=path.join(f.directory,'closure-commit-unknown-evidence.json');await writeFile(manifest,JSON.stringify({owned:true,sourceRoot:f.media,safetyRoot:path.join(f.directory,'source-writes','safety'),before:preWrite.file,originalStat:preWrite.originalStat,originalAttributes:preWrite.originalAttributes,backup:path.join(f.directory,'source-writes','safety',ready.items[0]!.operationId,'backup'),target:file,after,planId:ready.planId,closureCommitExecuted:true,actualResourcesAtLostAck:Atomics.load(words,1),coldReadsVerified:true,commandReceipt:executed.accepted},null,2)+'\n',{flag:'wx',mode:0o600});t.diagnostic(`Source真实closure COMMIT_ACK_UNKNOWN材料：${manifest}`);
    }finally{await api.close();storage.close();channel.port1.close();channel.port2.close();repository.close();}
  }finally{await o.close().catch(()=>undefined);}assert.equal(physicalResourceLocks.combinedSnapshot().resources,0);
});
