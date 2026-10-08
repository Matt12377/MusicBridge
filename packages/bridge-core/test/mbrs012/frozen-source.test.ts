import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {lstat,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import type {MediaLayoutSpec} from '@music-bridge/contracts';
import {createSourceEvidenceService} from '../../src/recording/source-evidence.js';
import {createMediaPlanningCoordinator} from '../../src/recording/media-coordinator.js';
import {createMasterVersionsCoordinator} from '../../src/recording/versions-coordinator.js';
import {createSourceProtectionService} from '../../src/recording/source-protection.js';
import {openLocalPlaybackReadonlySource} from '../../src/recording/source-files.js';
import {physicalResourceLocks} from '../../src/stream/physical-resource-locks.js';
import {sourceServiceFixture,hash} from './service-fixture.js';

test('012 无AssetID旧binding真实发布Master后：既存READY执行与新预览均被Frozen保护拒绝，旧历史/音频与普通读保持',async t=>{
  const input='owned-stereo-fixed-tags.flac',f=await sourceServiceFixture(t,{files:[input]}),file=path.join(f.media,input),before=await readFile(file),track=f.tracks[0]!,asset=f.repository.localCatalog.asset(track.assetId),scan=f.repository.localScan.privateCurrentFileState(f.root.id,input);
  const sources=createSourceEvidenceService({store:f.repository.sources,drafts:f.repository.drafts}),draft=f.repository.drafts.append({commandId:randomUUID(),fingerprint:hash(Buffer.from('自有旧binding Frozen保护')),title:'无本地AssetID旧母版',programType:'compilation',metadata:[1,2,3].map(i=>({title:`旧录音曲目 ${i}`}))});
  let versions:ReturnType<typeof createMasterVersionsCoordinator>|undefined;
  const protection=createSourceProtectionService({store:f.repository.sourceProtection,datasetId:f.datasetId,assertCurrent(){f.repository.localCatalog.root(f.root.id);},sourceWrites:true});
  try{
    for(const trackId of draft.trackIds){
      const job=sources.start({commandId:randomUUID(),draftId:draft.draftId,trackId,rootId:f.source.id,acquisition:'userFileBind'},file);await sources.idle();assert.equal(sources.job(job.id).job?.state,'completed');
      const binding=f.repository.sources.linked(draft.draftId,trackId);assert.ok(binding);assert.equal(Object.hasOwn(binding,'assetId'),false);await sources.confirm({commandId:randomUUID(),id:binding.id,draftId:draft.draftId,trackId,userConfirmed:true});
    }
    f.repository.receive({commandId:randomUUID(),model:{brand:'TDK',name:'SA',edition:'自有Frozen保护',year:1990,format:'cassette',tapeType:'II',identification:'verified'},lengthMinutes:60,quantities:{openedBlank:3,sealedBlank:0,legacyUsed:0,unclassified:0}});
    const media=createMediaPlanningCoordinator({store:f.repository.media,drafts:f.repository.drafts,sources}),spec:MediaLayoutSpec={format:'cassette',splitAfter:2,leadInMs:1000,tailMs:1000,defaultGapMs:5000,rules:[],compatibility:{confirmed:true,cassetteTypes:['II'],dat:true}};
    const preview=await media.preview({draftId:draft.draftId,spec,page:{offset:0,limit:20}}),saved=await media.save({commandId:randomUUID(),draftId:draft.draftId,expectedDraftRevision:preview.draftRevision,inputFingerprint:preview.inputFingerprint,spec}),candidate=preview.candidates.items[0];assert.ok(candidate);
    const layout=await media.reserve({commandId:randomUUID(),planId:saved.id,expectedRevision:saved.revision,skuId:candidate.skuId,packaging:'opened',userConfirmed:true});
    versions=createMasterVersionsCoordinator({store:f.repository.versions,mediaStore:f.repository.media,media,drafts:f.repository.drafts,sourceStore:f.repository.sources,sources});
    f.enable();const ready=await f.ready({kind:'tags',target:f.target(),fields:{title:{action:'set',value:'Frozen发布前的明确源计划'}}}),proposal=await versions.preview({planId:layout.id,sampleRate:96000}),job=await versions.freeze({commandId:randomUUID(),planId:layout.id,sampleRate:96000,proposalFingerprint:proposal.proposalFingerprint,userConfirmed:true});await versions.idle();assert.equal(versions.job(job.id).job?.state,'completed');
    const history=f.repository.versions.list(draft.draftId);assert.equal(history.masters.length,1);assert.equal(history.masters[0]!.sourceEvidence.length,3);assert.ok(history.masters[0]!.sourceEvidence.every(v=>!Object.hasOwn(v.binding,'assetId')));
    const stat=await lstat(file,{bigint:true}),root=f.repository.sources.root(f.source.id),signature=[stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':'),evidence=await protection.inspect([{root,relative:input,expectedSignature:signature}]);assert.equal(evidence.state,'PROTECTED');assert.equal(evidence.complete,true);assert.ok(evidence.references.some(v=>v.kind==='MASTER'&&v.id===history.masters[0]!.id));assert.equal(evidence.sourceWriterReady,false);
    f.execute(ready);const rejected=await f.waitPlan(ready.planId,v=>['FAILED','RECOVERY_REQUIRED','COMPLETED'].includes(v.state));assert.equal(rejected.state,'FAILED');assert.deepEqual(rejected.issues,['FROZEN_SOURCE']);assert.equal(f.facts.filter(fact=>fact.phase!=='QUIET').length,0);assert.ok(f.facts.some(fact=>fact.phase==='QUIET'));const actualFacts=f.repository.localCatalog.privateSourceWritesRead(view=>view.projection.events.filter(event=>event.planId===ready.planId&&(event.kind==='facts'||event.kind==='directory-facts')).length);assert.equal(actualFacts,0);
    const accepted=f.api.preview({datasetId:f.datasetId,commandId:randomUUID(),intent:{kind:'tags',target:f.target(),fields:{title:{action:'set',value:'不能改Frozen引用源'}}}});assert.equal(accepted.outcome,'accepted');assert.ok(accepted.planId);const blocked=await f.waitPlan(accepted.planId,v=>v.state!=='PREVIEWING');assert.equal(blocked.state,'BLOCKED');assert.deepEqual(blocked.issues,['FROZEN_SOURCE']);
    assert.deepEqual(await readFile(file),before);assert.deepEqual(f.repository.localCatalog.asset(asset.id),asset);assert.deepEqual(f.repository.localScan.privateCurrentFileState(f.root.id,input),scan);assert.deepEqual(f.repository.versions.list(draft.draftId),history);assert.equal(physicalResourceLocks.combinedSnapshot().resources,0);
    const lease=await openLocalPlaybackReadonlySource(root,input,signature);try{const actual=Buffer.alloc(before.length);assert.equal((await lease.handle.read(actual,0,actual.length,0)).bytesRead,before.length);assert.deepEqual(actual,before);await lease.verify();}finally{await lease.close();}
    const backup=path.join(f.directory,'source-writes','safety',ready.items[0]!.operationId,'backup'),backupInfo=await lstat(backup,{bigint:true}),backupDirectory=await lstat(path.dirname(backup),{bigint:true});assert.ok(backupInfo.isFile()&&!backupInfo.isSymbolicLink());assert.equal(backupInfo.nlink,1n);assert.equal(backupInfo.size,0n);assert.equal(backupInfo.mode&0o7777n,0o600n);assert.notEqual(`${backupInfo.dev}:${backupInfo.ino}`,`${stat.dev}:${stat.ino}`);assert.deepEqual(await readFile(backup),Buffer.alloc(0));assert.ok(backupDirectory.isDirectory()&&!backupDirectory.isSymbolicLink());assert.equal(backupDirectory.mode&0o7777n,0o700n);assert.equal(f.facts.filter(fact=>fact.phase==='BACKUP').length,0);
    // 空私有预备文件不是已核验的原件备份；Frozen拒绝后仅有真实QUIET收尾。
    const previous=f.preWriteSources.get(track.id);assert.ok(previous?.file&&previous.originalStat);const manifest=path.join(f.directory,'legacy-no-asset-frozen-evidence.json');await writeFile(manifest,JSON.stringify({owned:true,sourceRoot:f.media,before:previous.file,originalStat:previous.originalStat,originalAttributes:previous.originalAttributes,target:file,draftId:draft.draftId,masterId:history.masters[0]!.id,sourceBindingIds:history.masters[0]!.sourceEvidence.map(v=>v.binding.id),actualProtection:evidence.state,writerFacts:actualFacts,writerPhases:f.facts.map(fact=>fact.phase),preparedBackup:{path:backup,bytes:String(backupInfo.size),dev:String(backupInfo.dev),ino:String(backupInfo.ino),verifiedSourceCopy:false},plainReaderVerified:true},null,2)+'\n',{flag:'wx',mode:0o600});t.diagnostic(`Source旧binding无AssetID/Frozen拒写与普通读取材料：${manifest}`);
  }finally{await protection.close();await versions?.close();await sources.close();}
});
