import assert from 'node:assert/strict';
import test from 'node:test';
import {Worker} from 'node:worker_threads';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import * as dto from '@music-bridge/contracts';
import {legacyLinksFixture,executeLegacy} from './legacy-links-fixture.js';
import {createDatasetOwnerClient} from '../../src/collection/dataset-owner-client.js';
import {DatasetOwnerDispatchError} from '../../src/collection/dataset-owner-protocol.js';
import {failureForError} from '../../src/shared/ipc-failure.js';
import {LegacyLinksError} from '../../src/collection/local-legacy-links-journal.js';
import {lstat} from 'node:fs/promises';
import {physicalResourceLocks,PhysicalResourceBusy} from '../../src/stream/physical-resource-locks.js';

test('014 唯一真实 Node owner：六命令经原端口，跨线程闭集错误中文且零私有路径',async t=>{
  const f=await legacyLinksFixture(t),request=f.linkRequest();await f.api.close();await f.sources.close();await f.versions.close();f.repository.close();
  const worker=new Worker(new URL('./legacy-links-owner-worker.ts',import.meta.url),{execArgv:['--import','tsx'],workerData:{filePath:f.filePath,datasetId:f.datasetId}}),exit=once(worker,'exit'),client=createDatasetOwnerClient({worker});f.registerDependentCleanup(()=>client.close());
  assert.equal((await client.prepare()).datasetId,f.datasetId);await client.commitBoot();
  const dispatch=(command:dto.LocalLegacyLinksCommand,payload:unknown)=>client.dispatch({version:dto.IPC_VERSION,id:randomUUID(),command,payload,expectedDatasetId:f.datasetId});
  const p=await dispatch('localLegacyLinks.preview',request);assert.ok(dto.isLocalLegacyLinksCommandResult('localLegacyLinks.preview',p));
  await assert.rejects(dispatch('localLegacyLinks.preview',{...request,reason:'跨线程同命令改参'}),error=>error instanceof DatasetOwnerDispatchError&&error.failure.error.code==='INVENTORY_CONFLICT'&&error.failure.error.message==='本地旧库关联未获确认。[COMMAND_ID_REUSED]');
  let gets=0;const raw=f.read,proxy=new Proxy(raw,{get:(target,key)=>{gets++;return key==='limit'?1.25:Reflect.get(target,key);}}),read=await dispatch('localLegacyLinks.read',proxy);assert.ok(dto.isLocalLegacyLinksCommandResult('localLegacyLinks.read',read));assert.equal(read.limit,20);assert.equal(gets,0);
  const active=await dispatch('localLegacyLinks.confirm',executeLegacy(p));assert.ok(dto.isLocalLegacyLinksCommandResult('localLegacyLinks.confirm',active));assert.equal(active.outcome,'applied');
  const revoke=await dispatch('localLegacyLinks.preview',{datasetId:f.datasetId,commandId:randomUUID(),reason:'真实线程解除',intent:{action:'revoke',linkId:active.link!.linkId,expectedLinkRevision:'1'}});assert.ok(dto.isLocalLegacyLinksCommandResult('localLegacyLinks.preview',revoke));
  const removed=await dispatch('localLegacyLinks.revoke',executeLegacy(revoke));assert.ok(dto.isLocalLegacyLinksCommandResult('localLegacyLinks.revoke',removed));assert.equal(removed.outcome,'applied');
  const undo=await dispatch('localLegacyLinks.preview',{datasetId:f.datasetId,commandId:randomUUID(),reason:'真实线程恢复边',intent:{action:'undo',linkId:removed.link!.linkId,expectedLinkRevision:'2',undoTransitionEventId:removed.transitionEventId!}});assert.ok(dto.isLocalLegacyLinksCommandResult('localLegacyLinks.preview',undo));
  const restored=await dispatch('localLegacyLinks.undo',executeLegacy(undo));assert.ok(dto.isLocalLegacyLinksCommandResult('localLegacyLinks.undo',restored));assert.equal(restored.outcome,'applied');
  const history=await dispatch('localLegacyLinks.history',{datasetId:f.datasetId,linkId:active.link!.linkId,cursor:null,limit:20});assert.ok(dto.isLocalLegacyLinksCommandResult('localLegacyLinks.history',history));assert.equal(history.items.length,3);
  await client.close();assert.deepEqual(await exit,[0]);
});

test('014 错误清洗：不发送私有 exception message/stack，伪 code 归恢复问题',()=>{
  for(const issue of dto.LOCAL_LEGACY_LINKS_ISSUES){const error=new LegacyLinksError(issue);error.message='/private/user/secret.sqlite bearer=private';error.stack=error.message;const result=failureForError('id',error,'localLegacyLinks.preview');assert.equal(result.error.message,`本地旧库关联未获确认。[${issue}]`);assert.doesNotMatch(JSON.stringify(result),/secret|bearer|private/);}
  const error=new LegacyLinksError('INVALID_REQUEST');Object.defineProperty(error,'code',{value:'/secret/path'});assert.equal(failureForError('id',error,'localLegacyLinks.preview').error.message,'本地旧库关联未获确认。[RECOVERY_REQUIRED]');
});

test('014 原 SAB 真跨线程：Owner 双 FD 发布事务持读 claim，Core writer 在 COMMIT 前被拒', {timeout:10000},async t=>{
  const f=await legacyLinksFixture(t),asset=f.asset(),track=f.repository.localCatalog.createTrack({commandId:randomUUID(),assetId:asset.id,segment:null}),root=f.repository.localCatalog.root(asset.libraryRootId),binding=f.repository.sources.linked(f.draft.draftId,f.draft.trackIds[0]!)!;
  const request:dto.PreviewLocalLegacyLink={datasetId:f.datasetId,commandId:randomUUID(),reason:'跨线程同物理资源协调',intent:{action:'link',choice:{kind:'draft-source-track',draftId:f.draft.draftId,draftTrackId:f.draft.trackIds[0]!,expectedDraftRevision:f.repository.drafts.detail(f.draft.draftId).revision,sourceBindingId:binding.id,localTrackId:track.id,assetId:asset.id,expectedSelectionRevision:track.selectionRevision,expectedLibraryRootRevision:root.revision,expectedFileRevision:asset.fileRevision,expectedLocationRevision:asset.locationRevision,expectedSegment:null,expectedSlot:{activeLinkId:null,lastTransitionEventId:null}}}};
  await f.api.close();await f.sources.close();await f.versions.close();f.repository.close();
  const publicationBarrier=new SharedArrayBuffer(8),gate=new Int32Array(publicationBarrier),worker=new Worker(new URL('./legacy-links-owner-worker.ts',import.meta.url),{execArgv:['--import','tsx'],workerData:{filePath:f.filePath,datasetId:f.datasetId,physicalResourceBuffer:physicalResourceLocks.buffer,publicationBarrier}}),exit=once(worker,'exit'),client=createDatasetOwnerClient({worker});f.registerDependentCleanup(()=>client.close());
  await client.prepare();await client.commitBoot();
  const pending=client.dispatch({version:dto.IPC_VERSION,id:randomUUID(),command:'localLegacyLinks.preview',payload:request,expectedDatasetId:f.datasetId});void pending.catch(()=>{});
  try{
    const deadline=performance.now()+5000;while(Atomics.load(gate,0)===0&&performance.now()<deadline)await new Promise<void>(resolve=>setTimeout(resolve,5));assert.equal(Atomics.load(gate,0),1);
    const info=await lstat(f.file,{bigint:true}),physical={dev:String(info.dev),ino:String(info.ino)};assert.equal(physicalResourceLocks.inspect([physical]).readers,1);assert.throws(()=>physicalResourceLocks.acquireWrite([physical]),PhysicalResourceBusy);
    Atomics.store(gate,1,1);Atomics.notify(gate,1);
    const preview=await pending;assert.ok(dto.isLocalLegacyLinksCommandResult('localLegacyLinks.preview',preview));assert.equal(physicalResourceLocks.inspect([physical]).readers,0);await physicalResourceLocks.acquireWrite([physical]).release();
  }finally{Atomics.store(gate,1,1);Atomics.notify(gate,1);await client.close();}
  assert.deepEqual(await exit,[0]);
});
