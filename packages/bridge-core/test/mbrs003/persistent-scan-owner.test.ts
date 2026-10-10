import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Worker} from 'node:worker_threads';
import {isScanJobRecord,type ScanJobRecord,type IpcCommand,type IpcRequest,type LibraryRoot,type SourceRoot,type LocalTrack} from '@music-bridge/contracts';
import {audioFixture,loadFreshMetadataReader,coreAudioIds} from '../helpers/mbrs003-audio-fixtures.js';
import {authorizeSourceDirectory,readonlySourceCandidateMetadata} from '../../src/recording/source-files.js';
import {createCollectionRepository} from '../../src/collection/repository.js';
import {createLocalScanCoordinator,admitScanFields} from '../../src/collection/local-scan-coordinator.js';
import {createDatasetOwnerClient} from '../../src/collection/dataset-owner-client.js';
import {createScanReadAdmission} from '../../src/library/scan-read-admission.js';
import {isDatasetOwnerResponse,ownerRecord,type DatasetOwnerResponse,type DatasetProjectionPort,type DatasetProjectionCommand,type DatasetProjectionCommandResults,type DatasetOwnerRequest} from '../../src/collection/dataset-owner-protocol.js';
import type {ScanPreparedBatch} from '../../src/collection/local-scan-store.js';
import type {MetadataReaderPort,MetadataReaderLifecycle} from '../../src/library/metadata-reader-types.js';

async function media(t:test.TestContext,ids:readonly string[]=coreAudioIds) {
  const f=await audioFixture(t),directory=path.join(f.directory,'owner-media');await mkdir(directory,{mode:0o700});
  for(const id of ids) await writeFile(path.join(directory,path.basename(f.entry(id).file)),await f.bytes(id),{flag:'wx',mode:0o600});
  return {...f,mediaDirectory:directory,relative:(id:string)=>path.basename(f.entry(id).file)};
}
function projection(datasetId:string,epoch:string=randomUUID()) {
  let busy=false;const context={epoch,datasetId},admission=createScanReadAdmission({isBusy:()=>busy});
  const port:DatasetProjectionPort={async call<K extends DatasetProjectionCommand>(command:K,payload:import('../../src/collection/dataset-owner-protocol.js').DatasetProjectionCommandPayloads[K]):Promise<DatasetProjectionCommandResults[K]> {
    let result:unknown;
    if(command === 'scanReadAcquire') result=admission.acquire(context);
    else if(command === 'scanReadWatchRevocation') result=await admission.watchRevocation(context,(payload as {permitId:string}).permitId);
    else if(command === 'scanReadRelease') result=admission.release(context,(payload as {permitId:string}).permitId);
    else throw new Error('本夹具只接真实扫描准入本体，不能替代Roon metadata projection。');
    return result as DatasetProjectionCommandResults[K];
  }};
  return {port,admission,busy(value:boolean){busy=value;admission.observe();}};
}
async function unit(t:test.TestContext,ids:readonly string[]=coreAudioIds,reader?:MetadataReaderPort) {
  const f=await media(t,ids),datasetId=randomUUID(),file=path.join(f.directory,'scan.sqlite');
  const repo=createCollectionRepository({filePath:file}),cap=repo.sources.authorize(randomUUID(),await authorizeSourceDirectory(f.mediaDirectory));
  const root=repo.localCatalog.registerRoot({commandId:randomUUID(),sourceRootId:cap.id,role:'library'}),p=projection(datasetId);
  const actual=reader ?? (await loadFreshMetadataReader()).createMetadataReader();
  const coordinator=createLocalScanCoordinator({repository:repo,datasetId,assertCurrent:()=>{repo.list({offset:0,limit:1});},projection:p.port,reader:actual});
  t.after(async()=>{await coordinator.close().catch(()=>undefined);p.admission.close();repo.close();});
  return {...f,file,datasetId,repo,root,p,coordinator};
}
function tables(file:string) {
  const db=new DatabaseSync(file,{readOnly:true,allowExtension:false});
  try{return Object.fromEntries(['local_scan_jobs','local_scan_batches','local_scan_checkpoints','local_scan_file_state','local_scan_receipts','local_catalog_assets','local_catalog_tracks','local_catalog_ledger'].map(name=>[name,db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));}finally{db.close();}
}
const request=(command:IpcCommand,payload:unknown,datasetId?:string):IpcRequest=>({version:1,id:randomUUID(),command,payload,...(datasetId ? {expectedDatasetId:datasetId}:{})});
function workerOwner(t:test.TestContext,directory:string,lifecycle?:SharedArrayBuffer,crashAfterScanCommand?:string) {
  const worker=new Worker(new URL('../helpers/dataset-owner-fixture.ts',import.meta.url),{execArgv:['--import','tsx'],workerData:{mode:'scan-real',dataDirectory:directory,...(lifecycle ? {lifecycle}:{}),...(crashAfterScanCommand ? {crashAfterScanCommand}:{})}});
  let datasetId:string|undefined;let admitted:ReturnType<typeof projection>|undefined;let projectionEpoch:string|undefined;
  const endpoint=createDatasetOwnerClient({worker,onFatal:()=>{},async projection(command,payload,context) {
    assert.equal(context.datasetId,datasetId);assert.ok(context.epoch);
    if(!admitted){projectionEpoch=context.epoch;admitted=projection(context.datasetId!,context.epoch);}
    assert.equal(context.epoch,projectionEpoch);return admitted.port.call(command,payload);
  }});
  t.after(async()=>{admitted?.admission.close();if(worker.threadId !== -1) await endpoint.close().catch(()=>worker.terminate());});
  return {worker,endpoint,async prepare(){const identity=await endpoint.prepare();datasetId=identity.datasetId;await endpoint.commitBoot();return identity;}};
}
async function seededWorker(t:test.TestContext,lifecycle?:SharedArrayBuffer,crash?:string) {
  const f=await media(t,['core-wav']),data=path.join(f.directory,'dataset');await mkdir(data,{mode:0o700});
  const o=workerOwner(t,data,lifecycle,crash),identity=await o.prepare();
  const source=await o.endpoint.dispatch(request('recordingSources.authorize',{commandId:randomUUID(),absolutePath:f.mediaDirectory},identity.datasetId)) as SourceRoot;
  const root=await o.endpoint.dispatchInternal!(request('localCatalog.registerRoot',{commandId:randomUUID(),sourceRootId:source.id,role:'library'},identity.datasetId)) as LibraryRoot;
  return {...f,...o,data,identity,root};
}

function rawOwner(t:test.TestContext,dataDirectory:string) {
  const worker=new Worker(new URL('../helpers/dataset-owner-fixture.ts',import.meta.url),{execArgv:['--import','tsx'],workerData:{mode:'scan-real',dataDirectory}});
  const epoch=randomUUID();let sequence=0;t.after(async()=>{if(worker.threadId !== -1) await worker.terminate();});
  return {worker,epoch,rpc(operation:DatasetOwnerRequest['operation'],request?:IpcRequest):Promise<DatasetOwnerResponse> {
    const requestId=randomUUID();return new Promise((resolve,reject)=>{
      const cleanup=()=>{clearTimeout(timer);worker.off('message',message);worker.off('error',error);worker.off('exit',exit);};
      const error=(e:Error)=>{cleanup();reject(e);};const exit=(code:number)=>{cleanup();reject(new Error(`真实Worker在RPC前退出:${code}`));};
      const message=(value:unknown)=>{if(ownerRecord(value) && value.type === 'fatal' && value.epoch === epoch){cleanup();reject(new Error('真实Worker fatal'));}
        else if(isDatasetOwnerResponse(value) && value.epoch === epoch && value.requestId === requestId){cleanup();resolve(value);}};
      const timer=setTimeout(()=>{cleanup();reject(new Error('真实Worker RPC诊断期限5秒，不能无限等待'));},5000);
      worker.on('message',message);worker.once('error',error);worker.once('exit',exit);
      worker.postMessage({version:1,epoch,type:'request',requestId,sequence:++sequence,operation,...(request ? {request}:{})});
    });
  }};
}

test('MBRS003 coordinator：六种真实格式首扫和增量跳过解析保留稳定ID、raw与人工覆盖及null精确事实',{timeout:60_000},async t=>{
  const events:MetadataReaderLifecycle[]=[];const actual=(await loadFreshMetadataReader()).createMetadataReader({onLifecycle:e=>events.push(e)});
  const f=await unit(t,coreAudioIds,actual),start={commandId:randomUUID(),libraryRootId:f.root.id,expectedRootRevision:f.root.revision};
  const original=f.coordinator.start(start);assert.equal(original.phase,'pending');await f.coordinator.privateWait(original.jobId);
  const done=f.coordinator.get(original.jobId);assert.equal(done.phase,'completed');assert.deepEqual(done.progress,{visited:'6',accepted:'6',rejected:'0'});
  const tracks=f.repo.localCatalog.pageTracks({offset:0,limit:200});assert.equal(tracks.total,6);assert.equal(events.filter(e=>e.type === 'worker-start').length,6);
  assert.equal(events.filter(e=>e.type === 'worker-exit').length,6);assert.equal(events.filter(e=>e.type === 'lease-released').length,6);
  for(const track of tracks.items){const asset=f.repo.localCatalog.asset(track.assetId);assert.equal(asset.sampleFrames,null);assert.equal(asset.timebaseHz,null);assert.equal(track.segment,null);}
  const selected=tracks.items[0]!;f.repo.localCatalog.overrideMetadata({commandId:randomUUID(),trackId:selected.id,expectedRevision:null,fields:{title:'人工名称'}});
  const before=tables(f.file);const again=f.coordinator.start({commandId:randomUUID(),libraryRootId:f.root.id,expectedRootRevision:f.root.revision});await f.coordinator.privateWait(again.jobId);
  assert.equal(f.coordinator.get(again.jobId).phase,'completed');assert.equal(events.filter(e=>e.type === 'worker-start').length,6,'相同签名/parser确实未再解析');
  assert.deepEqual(f.repo.localCatalog.pageTracks({offset:0,limit:200}),tracks);
  assert.deepEqual(tables(f.file).local_catalog_ledger,before.local_catalog_ledger);assert.equal(f.repo.localCatalog.metadata(selected.id).effective.title,'人工名称');
  assert.deepEqual(f.coordinator.start(start),original,'同完整start原回执不改变且不重新启动');
});

test('MBRS003 owner：实际client/validator/dispatcher/Worker拒普通可信批、缺scope、旧dataset和旧epoch，关闭后拒入口',{timeout:60_000},async t=>{
  const f=await seededWorker(t),body={commandId:randomUUID(),libraryRootId:f.root.id,expectedRootRevision:f.root.revision};
  await assert.rejects(f.endpoint.dispatch(request('localScan.start',body)));
  await assert.rejects(f.endpoint.dispatch(request('localScan.start',{...body,path:'/禁止'},f.identity.datasetId)));
  await assert.rejects(f.endpoint.dispatch(request('localScan.start',body,randomUUID())));
  await assert.rejects(f.endpoint.dispatch(request('localScan.commitBatch',{commandId:randomUUID(),jobId:randomUUID(),batchId:randomUUID(),expectedRevision:'1'},f.identity.datasetId)));
  const stale:DatasetOwnerRequest={version:1,epoch:randomUUID(),type:'request',requestId:randomUUID(),sequence:9000,operation:'dispatch',request:request('localScan.page',{offset:0,limit:200},f.identity.datasetId)};
  f.worker.postMessage(stale);
  assert.deepEqual(await f.endpoint.dispatch(request('localScan.page',{offset:0,limit:200},f.identity.datasetId)),{offset:0,limit:200,total:0,hasMore:false,items:[]});
  await f.endpoint.close();assert.equal(f.worker.threadId,-1);await assert.rejects(f.endpoint.dispatch(request('localScan.page',{offset:0,limit:1},f.identity.datasetId)));
  const database=path.join(f.data,'collection.v1.sqlite'),repo=createCollectionRepository({filePath:database});
  const other=repo.localScan.start({commandId:randomUUID(),datasetId:randomUUID(),libraryRootId:f.root.id,expectedRootRevision:f.root.revision,parserVersion:'music-metadata-11.15.0/mbrs003-v1'}).job;repo.close();
  const next=workerOwner(t,f.data);const identity=await next.prepare();assert.equal(identity.datasetId,f.identity.datasetId);
  await assert.rejects(next.endpoint.dispatch(request('localScan.get',{jobId:other.jobId},identity.datasetId)));
  await next.endpoint.close();
  const raw=rawOwner(t,f.data),prepared=await raw.rpc('prepare');assert.equal(prepared.ok,true);assert.equal((await raw.rpc('commitBoot')).ok,true);
  const trusted={commandId:randomUUID(),jobId:other.jobId,batchId:randomUUID(),expectedRevision:'1'};
  const rejected=await raw.rpc('dispatch',request('localScan.commitBatch',trusted,identity.datasetId));assert.equal(rejected.ok,false,'实际Worker普通入口拒内部批');
  const malformed=await raw.rpc('dispatchInternal',request('localScan.prepareBatch',{commandId:randomUUID(),jobId:other.jobId,batch:{path:'/越权'}},identity.datasetId));assert.equal(malformed.ok,false);
  raw.worker.postMessage({version:1,epoch:randomUUID(),type:'request',requestId:randomUUID(),sequence:9000,operation:'dispatch',request:request('localScan.get',{jobId:other.jobId},identity.datasetId)});
  const fresh=await raw.rpc('dispatch',request('localScan.page',{offset:0,limit:200},identity.datasetId));assert.equal(fresh.ok,true,'旧epoch9000不推进当前sequence');
  assert.equal((await raw.rpc('close')).ok,true);

});

test('MBRS003 owner：UNKNOWN实际提交后冷开零自动执行，同body原receipt与显式resume只建一份文件实体',{timeout:60_000},async t=>{
  const f=await seededWorker(t,undefined,'localScan.start'),body={commandId:randomUUID(),libraryRootId:f.root.id,expectedRootRevision:f.root.revision};
  await assert.rejects(f.endpoint.dispatch(request('localScan.start',body,f.identity.datasetId)));
  const next=workerOwner(t,f.data),identity=await next.prepare();
  const page=await next.endpoint.dispatch(request('localScan.page',{offset:0,limit:200},identity.datasetId)) as {items:ScanJobRecord[]};assert.equal(page.items.length,1);const paused=page.items[0]!;assert.equal(paused.phase,'paused');
  assert.equal((await next.endpoint.dispatch(request('localCatalog.pageTracks',{offset:0,limit:200},identity.datasetId)) as {total:number}).total,0);
  const original=await next.endpoint.dispatch(request('localScan.start',body,identity.datasetId)) as ScanJobRecord;assert.equal(original.phase,'pending');assert.equal(original.jobId,paused.jobId);
  assert.equal((await next.endpoint.dispatch(request('localScan.get',{jobId:paused.jobId},identity.datasetId)) as ScanJobRecord).phase,'paused');
  await next.endpoint.dispatch(request('localScan.resume',{commandId:randomUUID(),jobId:paused.jobId,expectedRevision:paused.jobRevision},identity.datasetId));
  // wait是有限状态观察；不sleep、不同command反复执行，也不把UNKNOWN自动重试成成功。
  let current=paused;const deadline=performance.now()+15_000;for(let n=0;n<10_000 && performance.now()<deadline && current.phase !== 'completed';n++) current=await next.endpoint.dispatch(request('localScan.get',{jobId:paused.jobId},identity.datasetId)) as ScanJobRecord;
  assert.equal(current.phase,'completed');assert.equal((await next.endpoint.dispatch(request('localCatalog.pageTracks',{offset:0,limit:200},identity.datasetId)) as {total:number}).total,1);
  await next.endpoint.close();const facts=tables(path.join(f.data,'collection.v1.sqlite'));assert.equal(facts.local_scan_jobs!.length,1);assert.equal(facts.local_scan_file_state!.length,1);assert.equal(facts.local_catalog_tracks!.length,1);
});

test('MBRS003 coordinator：暂停和取消等真实worker退出及FD关闭后才回执，cancel终态不resume',{timeout:60_000},async t=>{
  let entered!:()=>void;let first=true;const ready=new Promise<void>(r=>{entered=r;});const events:MetadataReaderLifecycle[]=[];
  const reader=(await loadFreshMetadataReader()).createMetadataReader({onLifecycle:e=>{events.push(e);if(first && e.type === 'worker-start'){first=false;entered();}}});
  const f=await unit(t,['core-wav'],reader),created=f.coordinator.start({commandId:randomUUID(),libraryRootId:f.root.id,expectedRootRevision:f.root.revision});
  await ready;const running=f.coordinator.get(created.jobId);const paused=await f.coordinator.pause({commandId:randomUUID(),jobId:running.jobId,expectedRevision:running.jobRevision});
  assert.equal(paused.phase,'paused');assert.equal(events.filter(e=>e.type === 'worker-start').length,events.filter(e=>e.type === 'worker-exit').length);
  assert.equal(events.filter(e=>e.type === 'lease-acquired').length,events.filter(e=>e.type === 'lease-released').length);assert.equal(tables(f.file).local_scan_file_state!.length,0);
  const cancelled=await f.coordinator.cancel({commandId:randomUUID(),jobId:paused.jobId,expectedRevision:paused.jobRevision});assert.equal(cancelled.phase,'cancelled');
  assert.throws(()=>f.coordinator.resume({commandId:randomUUID(),jobId:cancelled.jobId,expectedRevision:cancelled.jobRevision}));
  const second=f.coordinator.start({commandId:randomUUID(),libraryRootId:f.root.id,expectedRootRevision:f.root.revision});await f.coordinator.privateWait(second.jobId);assert.equal(f.coordinator.get(second.jobId).phase,'completed');
});

test('MBRS003 coordinator：真实准入撤销取消真实Reader后释放票据，媒体yield不写bad-file',{timeout:60_000},async t=>{
  let entered!:()=>void;const ready=new Promise<void>(r=>{entered=r;}),events:MetadataReaderLifecycle[]=[];
  const reader=(await loadFreshMetadataReader()).createMetadataReader({onLifecycle:e=>{events.push(e);if(e.type === 'worker-start') entered();}});
  const f=await unit(t,['core-wav'],reader),job=f.coordinator.start({commandId:randomUUID(),libraryRootId:f.root.id,expectedRootRevision:f.root.revision});
  await ready;f.p.busy(true);await f.coordinator.privateWait(job.jobId);
  const paused=f.coordinator.get(job.jobId);assert.equal(paused.phase,'paused');assert.equal(tables(f.file).local_scan_file_state!.length,0);assert.deepEqual(paused.progress,{visited:'0',accepted:'0',rejected:'0'});
  assert.equal(events.filter(e=>e.type === 'worker-start').length,events.filter(e=>e.type === 'worker-exit').length);assert.equal(events.filter(e=>e.type === 'lease-acquired').length,events.filter(e=>e.type === 'lease-released').length);
  assert.equal(f.p.admission.resourceCounts().permits,0);f.p.busy(false);
  f.coordinator.resume({commandId:randomUUID(),jobId:paused.jobId,expectedRevision:paused.jobRevision});await f.coordinator.privateWait(job.jobId);assert.equal(f.coordinator.get(job.jobId).phase,'completed');
});

test('MBRS003 coordinator：LRF受控port故障fatal保留票据和连接、不落bad-file；raw512按字段拒绝不截断',{timeout:30_000},async t=>{
  const port:MetadataReaderPort={async read(){return {status:'failure',code:'LEASE_RELEASE_FAILED',readEvidence:null};},async close(){throw new Error('受控LRF关闭失败');}};
  const f=await unit(t,['core-wav'],port),job=f.coordinator.start({commandId:randomUUID(),libraryRootId:f.root.id,expectedRootRevision:f.root.revision});await f.coordinator.privateWait(job.jobId);
  assert.throws(()=>f.coordinator.get(job.jobId),/关闭未确认/u);await assert.rejects(f.coordinator.close());assert.equal(f.p.admission.resourceCounts().permits,1);
  assert.equal(f.repo.localScan.get(job.jobId).phase,'running');assert.equal(tables(f.file).local_scan_file_state!.length,0);
  assert.deepEqual(admitScanFields({title:'字'.repeat(512)}),{status:'accepted',fields:{title:'字'.repeat(512)}});
  assert.deepEqual(admitScanFields({title:'字'.repeat(513)}),{status:'rejected',code:'CATALOG_FIELD_INVALID_TITLE'});
  assert.deepEqual(admitScanFields({artist:'x\n'}),{status:'rejected',code:'CATALOG_FIELD_INVALID_ARTIST'});
  const g=await unit(t,['tag-limit']),rawJob=g.coordinator.start({commandId:randomUUID(),libraryRootId:g.root.id,expectedRootRevision:g.root.revision});await g.coordinator.privateWait(rawJob.jobId);
  const rawDone=g.coordinator.get(rawJob.jobId);assert.equal(rawDone.phase,'completed');assert.deepEqual(rawDone.progress,{visited:'1',accepted:'0',rejected:'1'});
  const state=g.repo.localScan.privateFileState(g.root.id,g.relative('tag-limit'))!.value;assert.equal(state.failureCode,'CATALOG_FIELD_INVALID_TITLE');assert.equal(state.assetId,null);assert.equal(state.trackId,null);
  assert.ok(state.readFacts && state.readFacts.readEvidence.bytesRead>0,'真实Reader4096边界成立后由catalog512分类拒绝');assert.equal(g.repo.localCatalog.pageTracks({offset:0,limit:200}).total,0);

});

test('MBRS003 coordinator：冷prepared真实签名变化显式弃旧原件并重读同逻辑file，稳定ID和人工覆盖保留',{timeout:60_000},async t=>{
  const f=await unit(t,['core-wav']),first=f.coordinator.start({commandId:randomUUID(),libraryRootId:f.root.id,expectedRootRevision:f.root.revision});await f.coordinator.privateWait(first.jobId);
  const track=f.repo.localCatalog.pageTracks({offset:0,limit:1}).items[0]!,asset=f.repo.localCatalog.asset(track.assetId);
  f.repo.localCatalog.overrideMetadata({commandId:randomUUID(),trackId:track.id,expectedRevision:null,fields:{title:'人工保留'}});
  const job=f.repo.localScan.start({commandId:randomUUID(),datasetId:f.datasetId,libraryRootId:f.root.id,expectedRootRevision:f.root.revision,parserVersion:'music-metadata-11.15.0/mbrs003-v2'}).job;
  const running=f.repo.localScan.resume({commandId:randomUUID(),jobId:job.jobId,expectedRevision:job.jobRevision});
  const cap=f.repo.sources.root(f.root.sourceRootId),relative=f.relative('core-wav'),stat=await readonlySourceCandidateMetadata(cap,relative);
  const actual=(await loadFreshMetadataReader()).createMetadataReader(),read=await actual.read({root:cap,relative,expectedSignature:stat.signature});await actual.close();assert.equal(read.status,'ok');if(read.status !== 'ok') throw new Error('真实Reader正控制失败');
  const batch:ScanPreparedBatch={batchId:randomUUID(),jobId:job.jobId,expectedJobRevision:running.jobRevision,checkpointBefore:null,items:[{relative,signature:stat.signature,parserVersion:read.parserVersion,outcome:'accepted',fields:read.fields,failureCode:null,reused:false,readFacts:{technical:read.technical,coverEvidence:read.coverEvidence,readEvidence:read.readEvidence}}],frontier:[],completed:true};
  f.repo.localScan.privatePrepareBatch({commandId:randomUUID(),jobId:job.jobId,batch});const original=tables(f.file).local_scan_batches!.find(r=>r.id === batch.batchId)!;
  await f.coordinator.close();f.repo.close();
  await writeFile(path.join(f.mediaDirectory,relative),await f.bytes('core-flac'));
  const cold=createCollectionRepository({filePath:f.file}),p=projection(f.datasetId),reader=(await loadFreshMetadataReader()).createMetadataReader();
  const coordinator=createLocalScanCoordinator({repository:cold,datasetId:f.datasetId,assertCurrent:()=>{cold.list({offset:0,limit:1});},projection:p.port,reader});
  t.after(async()=>{await coordinator.close();p.admission.close();cold.close();});const paused=cold.localScan.get(job.jobId);assert.equal(paused.phase,'paused');assert.equal(cold.localCatalog.asset(asset.id).fileRevision,asset.fileRevision);
  coordinator.resume({commandId:randomUUID(),jobId:job.jobId,expectedRevision:paused.jobRevision});await coordinator.privateWait(job.jobId);assert.equal(coordinator.get(job.jobId).phase,'completed');
  const facts=tables(f.file);assert.deepEqual(facts.local_scan_batches!.find(r=>r.id === batch.batchId),original,'原prepared body/fingerprint/phase保留');
  assert.equal(facts.local_scan_receipts!.filter(r=>r.operation === 'abandon-batch').length,1);assert.equal(cold.localCatalog.pageTracks({offset:0,limit:200}).total,1);assert.equal(cold.localCatalog.track(track.id).assetId,asset.id);
  assert.equal(cold.localCatalog.asset(asset.id).fileRevision,'2');assert.equal(cold.localCatalog.metadata(track.id).effective.title,'人工保留');
  await coordinator.close();cold.close();const verified=createCollectionRepository({filePath:f.file});try{assert.equal(verified.localScan.get(job.jobId).phase,'completed');}finally{verified.close();}
});


test('MBRS003 store-owner：私有abandon与fail提交故障全回滚、同body幂等且公开receipt不扩operation',{timeout:60_000},async t=>{
  const f=await unit(t,['core-wav']),first=f.coordinator.start({commandId:randomUUID(),libraryRootId:f.root.id,expectedRootRevision:f.root.revision});await f.coordinator.privateWait(first.jobId);
  await f.coordinator.close();f.repo.close();let fault:string|null=null;
  const repo=createCollectionRepository({filePath:f.file,beforeCommit(action){if(action === fault) throw new Error('合成私有收据提交故障');}});t.after(()=>repo.close());
  const job=repo.localScan.start({commandId:randomUUID(),datasetId:f.datasetId,libraryRootId:f.root.id,expectedRootRevision:f.root.revision,parserVersion:'music-metadata-11.15.0/mbrs003-v1'}).job;
  const running=repo.localScan.resume({commandId:randomUUID(),jobId:job.jobId,expectedRevision:job.jobRevision});
  const relative=f.relative('core-wav'),stat=await readonlySourceCandidateMetadata(repo.sources.root(f.root.sourceRootId),relative);
  const batch:ScanPreparedBatch={batchId:randomUUID(),jobId:job.jobId,expectedJobRevision:running.jobRevision,checkpointBefore:null,items:[{relative,signature:stat.signature,parserVersion:'music-metadata-11.15.0/mbrs003-v1',outcome:'accepted',fields:{},failureCode:null,reused:true,readFacts:null}],frontier:[],completed:true};
  repo.localScan.privatePrepareBatch({commandId:randomUUID(),jobId:job.jobId,batch});const before=tables(f.file);
  const abandoned={commandId:randomUUID(),jobId:job.jobId,batchId:batch.batchId,expectedRevision:running.jobRevision,reason:'CONTENT_CHANGED' as const};
  fault='local-scan:abandon-batch';assert.throws(()=>repo.localScan.privateAbandonBatch(abandoned));assert.deepEqual(tables(f.file),before);
  fault=null;assert.deepEqual(repo.localScan.privateAbandonBatch(abandoned),running);assert.deepEqual(repo.localScan.privateAbandonBatch(abandoned),running);
  assert.equal(repo.localScan.receipt(abandoned.commandId),null);assert.equal(repo.localScan.privatePreparedBatches(job.jobId).length,0);
  assert.throws(()=>repo.localScan.privateCommitBatch({commandId:randomUUID(),jobId:job.jobId,batchId:batch.batchId,expectedRevision:running.jobRevision}));
  const beforeFail=tables(f.file),failed={commandId:randomUUID(),jobId:job.jobId,expectedRevision:running.jobRevision,code:'SCAN_READ_FAILED' as const};
  fault='local-scan:fail';assert.throws(()=>repo.localScan.privateFail(failed));assert.deepEqual(tables(f.file),beforeFail);
  fault=null;const result=repo.localScan.privateFail(failed);assert.equal(result.phase,'failed');assert.equal(result.failureCode,'SCAN_READ_FAILED');assert.deepEqual(repo.localScan.privateFail(failed),result);
  assert.equal(repo.localScan.receipt(failed.commandId),null);repo.close();
  const cold=createCollectionRepository({filePath:f.file});try{assert.deepEqual(cold.localScan.get(job.jobId),result);assert.equal(cold.localCatalog.pageTracks({offset:0,limit:200}).total,1);}finally{cold.close();}
});
