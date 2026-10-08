import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {copyFile,link,lstat,readFile,rename,writeFile} from 'node:fs/promises';
import path from 'node:path';
import * as dto from '@music-bridge/contracts';
import {createCollectionRepository} from '../../src/collection/repository.js';
import {sourceServiceFixture,hash,type SourceServiceFixture} from './service-fixture.js';
import {sourceOwner} from './owner-fixture.js';

const input='owned-stereo-fixed-tags.flac';
async function interrupted(o:ReturnType<typeof sourceOwner>,f:SourceServiceFixture){
  await o.boot();await o.request('localSourceWrites.setPolicy',{datasetId:f.datasetId,commandId:randomUUID(),expectedPolicyRevision:'1',enabled:true});
  const accepted=await o.request('localSourceWrites.preview',{datasetId:f.datasetId,commandId:randomUUID(),intent:{kind:'tags',target:f.target(),fields:{title:{action:'set',value:'两条确名链接的真实发布'}}}});assert.ok(accepted.planId);
  const ready=await o.waitPlan(accepted.planId,v=>v.state!=='PREVIEWING');assert.equal(ready.state,'READY',ready.issues.join(','));await o.confirm(ready);
  const unknown=await o.waitPlan(ready.planId,v=>v.state==='RECOVERY_REQUIRED');assert.equal(unknown.items[0]!.state,'unknown');return unknown;
}
async function previewRecovery(o:ReturnType<typeof sourceOwner>,f:SourceServiceFixture,origin:dto.LocalSourceWritesPlan){
  const choice=origin.recoveryChoices[0];assert.ok(choice);const accepted=await o.request('localSourceWrites.preview',{datasetId:f.datasetId,commandId:randomUUID(),intent:{kind:'recovery',originPlanId:origin.planId,expectedOriginViewRevision:origin.viewRevision,choiceId:choice.choiceId,recoveryFingerprint:choice.recoveryFingerprint}});assert.ok(accepted.planId);return o.waitPlan(accepted.planId,v=>v.state!=='PREVIEWING');
}

test('012 冷启动认证PUBLISH_INTENT的真实两链接：只清私有stage，确认前源bytes不变，明确恢复后真实quiet',async t=>{
  const f=await sourceServiceFixture(t,{files:[input]}),target=path.join(f.media,input),original=await readFile(target);await f.close();
  const state=new SharedArrayBuffer(12),words=new Int32Array(state),old=sourceOwner(f,{faultPhase:'PUBLISHED',state});
  const origin=await interrupted(old,f),stage=path.join(f.directory,'source-writes','safety',origin.items[0]!.operationId,'stage'),published=await readFile(target),named=await lstat(target,{bigint:true}),alias=await lstat(stage,{bigint:true});
  assert.equal(named.nlink,2n);assert.equal(alias.ino,named.ino);assert.equal(alias.dev,named.dev);assert.notDeepEqual(published,original);assert.ok(Atomics.load(words,1)>0);
  // 原Owner保持UNKNOWN，关闭不能伪报quiet；此处明确终止自建Worker，模拟冷启动。
  await assert.rejects(old.close());
  const cold=sourceOwner(f);
  try{
    await cold.boot();const current=await cold.plan(origin.planId);assert.equal(current.state,'RECOVERY_REQUIRED');const ready=await previewRecovery(cold,f,current);assert.equal(ready.state,'READY',ready.issues.join(','));
    await assert.rejects(lstat(stage),{code:'ENOENT'});assert.equal((await lstat(target,{bigint:true})).nlink,1n);assert.deepEqual(await readFile(target),published,'预览只收尾私有别名，不能替代最终源恢复确认。');
    await cold.confirm(ready);const result=await cold.waitPlan(ready.planId,v=>['COMPLETED','FAILED','RECOVERY_REQUIRED'].includes(v.state));assert.equal(result.state,'COMPLETED',result.issues.join(','));assert.equal((await cold.plan(origin.planId)).state,'FAILED');assert.deepEqual(await readFile(target),original);
    const restored=path.join(f.directory,'cold-stage-restored.flac');await copyFile(target,restored);const pre=f.preWriteSources.get(f.tracks[0]!.id)!;
    const manifest=path.join(f.directory,'cold-stage-recovery-evidence.json');await writeFile(manifest,JSON.stringify({owned:true,coldWorkerTermination:true,sourceRoot:f.media,safetyRoot:path.join(f.directory,'source-writes','safety'),before:pre.file,originalStat:pre.originalStat,originalAttributes:pre.originalAttributes,target,restored,backup:path.join(path.dirname(stage),'backup'),quarantine:path.join(path.dirname(stage),'quarantine'),originalSha256:hash(original),originPlanId:origin.planId,recoveryPlanId:result.planId},null,2)+'\n',{flag:'wx',mode:0o600});t.diagnostic(`Source真实冷启动stage/备份/恢复材料：${manifest}`);
  }finally{await cold.close();}
});

for(const mutation of ['third-link','changed-content','replaced-stage'] as const)test(`012 已发布私有stage对账拒绝${mutation}：不去除可疑链接，不改变源bytes，不伪造quiet`,async t=>{
  const f=await sourceServiceFixture(t,{files:[input]}),target=path.join(f.media,input),original=await readFile(target),asset=f.repository.localCatalog.asset(f.tracks[0]!.assetId);await f.close();
  // 每个负例使用独立Worker的真实协调器；不清除或重置上一Owner的活动SAB。
  const state=new SharedArrayBuffer(12),words=new Int32Array(state),o=sourceOwner(f,{faultPhase:'PUBLISHED',state});
  try{
    const origin=await interrupted(o,f),stage=path.join(f.directory,'source-writes','safety',origin.items[0]!.operationId,'stage'),initial=await readFile(target);assert.equal((await lstat(target,{bigint:true})).nlink,2n);assert.ok(Atomics.load(words,1)>0);
    if(mutation==='third-link')await link(target,path.join(f.directory,'external-third-link.flac'));
    else if(mutation==='changed-content'){const changed=Buffer.from(initial),offset=changed.length-1;changed[offset]=changed[offset]!^1;await writeFile(target,changed);}
    else{await rename(stage,path.join(path.dirname(stage),'original-stage-retained'));await writeFile(stage,initial,{flag:'wx',mode:0o600});}
    const before=await readFile(target),stageBefore=await readFile(stage),named=await lstat(target,{bigint:true}),alias=await lstat(stage,{bigint:true});
    const blocked=await previewRecovery(o,f,await o.plan(origin.planId));assert.equal(blocked.state,'BLOCKED');assert.deepEqual(blocked.issues,['SOURCE_CHANGED']);assert.deepEqual(await readFile(target),before);assert.deepEqual(await readFile(stage),stageBefore);assert.equal((await lstat(target,{bigint:true})).ino,named.ino);assert.equal((await lstat(target,{bigint:true})).nlink,named.nlink);assert.equal((await lstat(stage,{bigint:true})).ino,alias.ino);assert.equal((await o.plan(origin.planId)).state,'RECOVERY_REQUIRED');
    const backup=path.join(path.dirname(stage),'backup'),quarantine=path.join(path.dirname(stage),'quarantine');assert.deepEqual(await readFile(backup),original);assert.deepEqual(await readFile(quarantine),original);
    const repository=createCollectionRepository({filePath:f.filePath});try{assert.deepEqual(repository.localCatalog.asset(asset.id),asset);}finally{repository.close();}
    const events=await o.request('localSourceWrites.history',{datasetId:f.datasetId,selector:{kind:'events',planId:origin.planId},cursor:null,limit:100});assert.ok(events.kind==='events');assert.equal(events.items.some(e=>e.phase==='QUIET'),false);
    t.diagnostic(`Source真实可疑stage材料保留：${f.directory}；旧Owner关闭拒绝后终止，不声明正常保护释放。`);
  }finally{await assert.rejects(o.close());}
});
