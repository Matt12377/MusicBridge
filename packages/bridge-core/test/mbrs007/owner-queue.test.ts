import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {Worker} from 'node:worker_threads';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {createDatasetOwnerClient} from '../../src/collection/dataset-owner-client.js';
import {isMBQueueRecord,type MBQueueRecord} from '@music-bridge/contracts';

test('007真实Owner Worker单save/load flight与5000行CAS；cold reopen换epoch而不自动播放',async t=>{
 const directory=await mkdtemp(path.join(process.env.TMPDIR!,'mbrs007-worker-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const open=()=>{const worker=new Worker(new URL('./queue-worker.ts',import.meta.url),{execArgv:['--import','tsx'],workerData:{dataDirectory:directory}});return {worker,endpoint:createDatasetOwnerClient({worker})};};
 let owner=open();const identity=await owner.endpoint.prepare();await owner.endpoint.commitBoot();assert.equal(await owner.endpoint.loadMBQueue!(),null);
 const q:MBQueueRecord={schemaVersion:'1.2',datasetId:identity.datasetId,queueId:randomUUID(),revision:'1',currentEntryId:null,restartPolicy:{reResolve:true,autoplay:false},entries:Array.from({length:5000},()=>({entryId:randomUUID(),entryRevision:'1',source:{kind:'netease',trackId:'42'},quality:'auto'}))};
 const save=owner.endpoint.saveMBQueue!({expectedRevision:'0',queue:q});await assert.rejects(owner.endpoint.saveMBQueue!({expectedRevision:'0',queue:q}));assert.deepEqual(await save,q);
 const load=owner.endpoint.loadMBQueue!();await assert.rejects(owner.endpoint.loadMBQueue!());assert.deepEqual(await load,q);
 await owner.endpoint.close();owner=open();const reopened=await owner.endpoint.prepare();await owner.endpoint.commitBoot();assert.notEqual(reopened.epoch,identity.epoch);assert.equal(reopened.datasetId,identity.datasetId);
 assert.deepEqual(await owner.endpoint.loadMBQueue!(),q);assert.equal(owner.endpoint.captureLocalSource===undefined,false);const next={...q,queueId:randomUUID(),revision:'2'};assert.deepEqual(await owner.endpoint.saveMBQueue!({expectedRevision:'1',queue:next}),next);
 await assert.rejects(owner.endpoint.saveMBQueue!({expectedRevision:'1',queue:next}));assert.equal(isMBQueueRecord(next),true);await owner.endpoint.close();
});

test('007真实Owner冷Boot只逻辑row损坏返回无revision UNAVAILABLE；数据库仍可读且save固定失败',async t=>{
 const directory=await mkdtemp(path.join(process.env.TMPDIR!,'mbrs007-corrupt-owner-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const open=()=>{const worker=new Worker(new URL('./queue-worker.ts',import.meta.url),{execArgv:['--import','tsx'],workerData:{dataDirectory:directory}});return createDatasetOwnerClient({worker});};
 let owner=open();t.after(()=>owner.close());const identity=await owner.prepare();await owner.commitBoot();await owner.close();const db=new DatabaseSync(path.join(directory,'collection.v1.sqlite')),broken='{broken';db.prepare('INSERT INTO mb_playback_queue VALUES(1,?,?,?,?)').run(identity.datasetId,randomUUID(),'未知',broken);db.close();
 owner=open();const next=await owner.prepare();await owner.commitBoot();assert.equal(next.datasetId,identity.datasetId);assert.deepEqual(await owner.loadMBQueue!(),{status:'UNAVAILABLE'});
 const queue:MBQueueRecord={schemaVersion:'1.2',datasetId:next.datasetId,queueId:randomUUID(),revision:'1',currentEntryId:null,restartPolicy:{reResolve:true,autoplay:false},entries:[]};await assert.rejects(owner.saveMBQueue!({expectedRevision:'0',queue}));assert.deepEqual(await owner.loadMBQueue!(),{status:'UNAVAILABLE'});await owner.close();
 const view=new DatabaseSync(path.join(directory,'collection.v1.sqlite'),{readOnly:true});assert.equal(view.prepare('SELECT data FROM mb_playback_queue').get()!.data,broken);view.close();
});
