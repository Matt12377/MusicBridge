import assert from 'node:assert/strict';
import test from 'node:test';
import {Worker} from 'node:worker_threads';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import type {IpcCommand,IpcRequest,SourceRoot,LibraryRoot,ScanJobRecord,LocalTrack,LocalPlayRequest} from '@music-bridge/contracts';
import type {DatasetProjectionCommandResults} from '../../src/collection/dataset-owner-protocol.js';
import type {PreparedLocalSource} from '../../src/application/local-source-resolver.js';
import {createDatasetOwnerClient} from '../../src/collection/dataset-owner-client.js';
import {createScanReadAdmission} from '../../src/library/scan-read-admission.js';
import {LocalSourceFence} from '../../src/stream/local-source-fence.js';
import {LocalFileSourcePool} from '../../src/stream/local-file-source.js';
import {buildStoragePolicy} from '../../../../apps/desktop/scripts/build-storage-root.mjs';
import {eventually} from '../mbrs005/fixture.js';

test('006真实Owner Worker/SQLite/扫描→私有票据→固定FD链：同步selection撤销与Worker退出封票', {timeout:30_000}, async t=>{
 const storage=buildStoragePolicy(),directory=await mkdtemp(path.join(storage.check(process.env.TMPDIR!,{mustExist:true}),'mbrs006-worker-')),media=path.join(directory,'合成媒体');await mkdir(media);const bytes=Buffer.from('MBRS006 software-only synthetic bytes');await writeFile(path.join(media,'一.wav'),bytes);
 const worker=new Worker(new URL('./owner-worker.ts',import.meta.url),{execArgv:['--import','tsx'],workerData:{dataDirectory:path.join(directory,'data')}}),admission=createScanReadAdmission({isBusy:()=>false}),fatals:string[]=[],pool=new LocalFileSourcePool();
 const endpoint=createDatasetOwnerClient({worker,onFatal:reason=>fatals.push(reason),projection:async(command,payload,context)=>{
  const scope={epoch:context.epoch,datasetId:context.datasetId!};if(command==='scanReadAcquire')return admission.acquire(scope) as DatasetProjectionCommandResults[typeof command];if(command==='scanReadWatchRevocation')return await admission.watchRevocation(scope,(payload as {permitId:string}).permitId) as DatasetProjectionCommandResults[typeof command];if(command==='scanReadRelease')return admission.release(scope,(payload as {permitId:string}).permitId) as DatasetProjectionCommandResults[typeof command];throw new Error('本测试关闭AI/外部投影。');}});
 t.after(async()=>{await pool.close();await endpoint.close().catch(()=>worker.terminate());admission.close();await rm(directory,{recursive:true,force:true});});
 const identity=await endpoint.prepare();await endpoint.commitBoot();
 const request=(command:IpcCommand,payload:unknown):IpcRequest=>({version:1,id:randomUUID(),command,payload,expectedDatasetId:identity.datasetId});
 const source=await endpoint.dispatch(request('recordingSources.authorize',{commandId:randomUUID(),absolutePath:media})) as SourceRoot;
 const root=await endpoint.dispatchInternal!(request('localCatalog.registerRoot',{commandId:randomUUID(),sourceRootId:source.id,role:'library'})) as LibraryRoot;
 const started=await endpoint.dispatch(request('localScan.start',{commandId:randomUUID(),libraryRootId:root.id,expectedRootRevision:root.revision})) as ScanJobRecord;
 let job=started;const deadline=performance.now()+3000;while(job.phase!=='completed' && performance.now()<deadline){await new Promise(resolve=>setTimeout(resolve,10));job=await endpoint.dispatch(request('localScan.get',{jobId:job.jobId})) as ScanJobRecord;}assert.equal(job.phase,'completed');assert.equal(job.progress.accepted,'1');
 const tracks=await endpoint.dispatch(request('localCatalog.pageTracks',{offset:0,limit:1})) as {items:LocalTrack[]},track=tracks.items[0]!;
 const selection:LocalPlayRequest={schema_version:'1.2',request_id:randomUUID(),route:'roon_audio_input',source_kind:'local_file',local_track_id:track.id,asset_id:track.assetId,expected_asset_revision:'1',target:{core_id:'synthetic-core',zone_id:'synthetic-zone'},action:'PLAY_NOW'};
 const captured=await endpoint.captureLocalSource!(selection),fence=new LocalSourceFence(captured.buffer);assert.equal(fence.current,true);
 const descriptor:PreparedLocalSource={source_kind:'local_file',status:'prepared_descriptor',request_id:selection.request_id,action:selection.action,target:selection.target,facts:captured.facts};
 const lease=await pool.prepare(descriptor,{ownerId:'controlled-core',attempt:1,isCurrent:()=>fence.current&&endpoint.isLocalSourceCurrent!()});const chunks:Buffer[]=[];for await(const chunk of lease.readSlice(0,bytes.length-1,new AbortController().signal))chunks.push(chunk);assert.deepEqual(Buffer.concat(chunks),bytes);
 await endpoint.dispatch(request('localCatalog.selectAsset',{commandId:randomUUID(),trackId:track.id,expectedSelectionRevision:'1',assetId:track.assetId}));assert.equal(fence.current,false);await assert.rejects(async()=>{for await(const chunk of lease.readSlice(0,2,new AbortController().signal))assert.fail('撤销不读');});await lease.close();await endpoint.releaseLocalSource!(captured.ticketId);
 const fresh=await endpoint.captureLocalSource!({...selection,request_id:randomUUID()}),next=new LocalSourceFence(fresh.buffer);assert.equal(next.current,true);assert.equal(fresh.facts.track.selectionRevision,'2');await worker.terminate();await eventually(()=>fatals.length===1,'Worker退出已封口');assert.equal(next.current,false);assert.equal(endpoint.isLocalSourceCurrent!(),false);await assert.rejects(endpoint.captureLocalSource!(selection));assert.deepEqual(pool.resourceSnapshot(),{openLeases:0,reservations:0});
});
