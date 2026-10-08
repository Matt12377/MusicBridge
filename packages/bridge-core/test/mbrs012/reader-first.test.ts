import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {lstat,readFile} from 'node:fs/promises';
import path from 'node:path';
import * as dto from '@music-bridge/contracts';
import {prepareLocalSourceReadonly} from '../../src/application/local-source-resolver.js';
import {LocalFileSourcePool,type AssetLease} from '../../src/stream/local-file-source.js';
import {physicalResourceLocks} from '../../src/stream/physical-resource-locks.js';
import {openLocalPlaybackReadonlySource,withVerifiedReadonlySource} from '../../src/recording/source-files.js';
import {createCollectionRepository} from '../../src/collection/repository.js';
import {sourceServiceFixture,hash} from './service-fixture.js';
import {sourceOwner} from './owner-fixture.js';

for(const context of ['active','paused','prefetch','recording'] as const)test(`012 reader-first ${context}：真实租约先持有，同SAB Owner最终确认不能发布，原读继续原bytes且OFF不拒普通读`,async t=>{
  const input='owned-stereo-fixed-tags.flac',other='owned-unaffected.flac';
  const f=await sourceServiceFixture(t,{files:[input],aliases:[{ownedFile:input,relative:other}]}),track=f.tracks.find(v=>f.relative(v)===input);assert.ok(track);
  const file=path.join(f.media,input),before=await readFile(file),beforeStat=await lstat(file,{bigint:true}),asset=f.repository.localCatalog.asset(track.assetId),scan=f.repository.localScan.privateCurrentFileState(f.root.id,input),root=f.repository.sources.root(f.source.id);
  const target={core_id:'owned-core',zone_id:'owned-zone'},request:dto.LocalPlayRequest={schema_version:'1.2',request_id:randomUUID(),route:'roon_audio_input',source_kind:'local_file',local_track_id:track.id,asset_id:asset.id,expected_asset_revision:asset.fileRevision,target,action:'PLAY_NOW'};
  const descriptor=prepareLocalSourceReadonly(request,f.repository,{captureCurrentTarget:()=>({target,isCurrent:()=>true})});assert.equal(descriptor.status,'prepared_descriptor');if(descriptor.status!=='prepared_descriptor')assert.fail('生产resolver未返回已扫描的真实本地描述符。');
  await f.close();const o=sourceOwner(f,{sharedLocks:true}),pool=new LocalFileSourcePool();let lease:AssetLease|undefined,releaseRecording:(()=>void)|undefined,recording:Promise<void>|undefined;
  try{
    await o.boot();await o.request('localSourceWrites.setPolicy',{datasetId:f.datasetId,commandId:randomUUID(),expectedPolicyRevision:'1',enabled:true});
    const accepted=await o.request('localSourceWrites.preview',{datasetId:f.datasetId,commandId:randomUUID(),intent:{kind:'tags',target:{mode:'single',trackId:track.id},fields:{title:{action:'set',value:'已有读租约时不得写入'}}}});assert.ok(accepted.planId);
    const p=await o.waitPlan(accepted.planId,v=>v.state!=='PREVIEWING');assert.equal(p.state,'READY',p.issues.join(','));
    if(context==='recording'){
      let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;}),hold=new Promise<void>(resolve=>{releaseRecording=resolve;});
      recording=withVerifiedReadonlySource(root,input,{sha256:hash(before),size:before.length},new AbortController().signal,async fd=>{entered();await hold;const actual=Buffer.alloc(before.length);assert.equal((await fd.read(actual,0,actual.length,0)).bytesRead,before.length);assert.deepEqual(actual,before);});
      await started;
    }else{
      lease=await pool.prepare(descriptor,{ownerId:`owned-${context}`,attempt:1,isCurrent:()=>true});
      const session={attempt:1,sessionId:`owned-${context}`,isConfirmed:()=>true};if(context!=='prefetch')lease.confirmSession(session);if(context==='paused')lease.pause(session);
      assert.equal(lease.state,context==='active'?'ACTIVE':context==='paused'?'PAUSED':'PREPARED');
    }
    const physical={dev:String(beforeStat.dev),ino:String(beforeStat.ino)};assert.ok(physicalResourceLocks.inspect([physical]).readers>0);
    const confirmed=await o.confirm(p);assert.equal(confirmed.accepted.outcome,'accepted');const blocked=await o.waitPlan(p.planId,v=>['FAILED','COMPLETED','RECOVERY_REQUIRED'].includes(v.state));assert.equal(blocked.state,'FAILED');assert.deepEqual(blocked.issues,['ACTIVE_READER']);
    const history=await o.request('localSourceWrites.history',{datasetId:f.datasetId,selector:{kind:'events',planId:p.planId},cursor:null,limit:100});assert.ok(history.kind==='events');assert.equal(history.items.some(v=>['BACKUP','CAPTURE_INTENT','CAPTURED','PUBLISHED'].includes(v.phase)),false);
    await assert.rejects(lstat(path.join(f.directory,'source-writes','safety',p.items[0]!.operationId,'backup')),{code:'ENOENT'});
    assert.deepEqual(await readFile(file),before);const current=await lstat(file,{bigint:true});assert.equal(current.dev,beforeStat.dev);assert.equal(current.ino,beforeStat.ino);assert.ok(physicalResourceLocks.inspect([physical]).readers>0);
    const repository=createCollectionRepository({filePath:f.filePath});try{assert.deepEqual(repository.localCatalog.asset(asset.id),asset);assert.deepEqual(repository.localScan.privateCurrentFileState(f.root.id,input),scan);}finally{repository.close();}
    if(lease){const chunks:Buffer[]=[];for await(const chunk of lease.readSlice(0,lease.size-1,new AbortController().signal))chunks.push(chunk);assert.deepEqual(Buffer.concat(chunks),before);}
    const policy=await o.request('localSourceWrites.get',{datasetId:f.datasetId,selector:{kind:'context',target:null}});assert.ok(policy.kind==='context');const off=await o.request('localSourceWrites.setPolicy',{datasetId:f.datasetId,commandId:randomUUID(),expectedPolicyRevision:policy.context.policy.revision,enabled:false});assert.equal(off.outcome,'accepted');
    const untouched=await lstat(path.join(f.media,other),{bigint:true}),otherLease=await openLocalPlaybackReadonlySource(root,other,[untouched.dev,untouched.ino,untouched.size,untouched.mtimeNs,untouched.ctimeNs].join(':'));
    try{const actual=Buffer.alloc(before.length);assert.equal((await otherLease.handle.read(actual,0,actual.length,0)).bytesRead,before.length);assert.deepEqual(actual,before);await otherLease.verify();}finally{await otherLease.close();}
    if(recording){releaseRecording?.();await recording;recording=undefined;}
  }finally{releaseRecording?.();if(recording)await recording;await pool.close();await o.close();}
  assert.equal(physicalResourceLocks.combinedSnapshot().resources,0);
});
