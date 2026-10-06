import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {queueFixture} from './queue-fixture.js';
import {eventually} from '../mbrs005/fixture.js';
import {tick} from '../mbrs006/adapter-fixture.js';
import {createCollectionRepository} from '../../src/collection/repository.js';
import {createLocalSourceTickets} from '../../src/collection/local-source-tickets.js';
import path from 'node:path';
import {BridgeController} from '../../src/application/bridge-controller.js';
import {silentLogger} from '../mbrs006/adapter-fixture.js';
import type {NeteasePort} from '../../src/netease/types.js';

for(const action of ['REORDER','REMOVE'] as const)test(`007 R1稳定entry在播放命令等待期间${action}后拒绝，零错误entry派发`,async t=>{
 const f=await queueFixture(t,30);await f.controller.playLocal(f.request(0,'APPEND_MB_QUEUE'));await f.controller.playLocal(f.request(1,'APPEND_MB_QUEUE'));
 let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);t.after(()=>release());
 const held=(f.controller as any).enqueuePlayback(()=>gate);await tick();const q=f.controller.getPlaybackState().queue;
 const play=f.controller.playQueueEntry({queueId:q.queueId!,expectedRevision:q.revision!,entryId:q.items[0]!.entryId!});const outcome=play.then(()=>false,()=>true);
 await f.controller.editLogicalQueue({queueId:q.queueId!,expectedRevision:q.revision!,action,entryIds:action==='REMOVE'?[q.items[0]!.entryId!]:q.items.map(item=>item.entryId!).reverse()});
 release();await held;assert.equal(await outcome,true);assert.equal(f.sessions.length,0);assert.equal(f.sends.length,0);
});
test('007 R1稳定entry在stop await期间revision变化拒绝，不执行晚派发',async t=>{
 const f=await queueFixture(t,30);await f.start();await f.controller.playLocal(f.request(1,'APPEND_MB_QUEUE'));
 let release!:()=>void,entered=false;const gate=new Promise<void>(resolve=>release=resolve);t.after(()=>release());const stop=f.adapter.stop.bind(f.adapter);
 t.mock.method(f.adapter,'stop',async(...args:Parameters<typeof stop>)=>{entered=true;await gate;return stop(...args);});
 const q=f.controller.getPlaybackState().queue,play=f.controller.playQueueEntry({queueId:q.queueId!,expectedRevision:q.revision!,entryId:q.items[1]!.entryId!}),outcome=play.then(()=>false,()=>true);
 await eventually(()=>entered,'原Adapter stop实际等待');await f.controller.editLogicalQueue({queueId:q.queueId!,expectedRevision:q.revision!,action:'REORDER',entryIds:q.items.map(item=>item.entryId!).reverse()});
 release();assert.equal(await outcome,true);assert.equal(f.sessions.length,1);assert.equal(f.sends.length,1);
});
async function restoredEdition(t:test.TestContext){
 const f=await queueFixture(t,30),catalog=f.repository.localCatalog,edition=catalog.createEdition({commandId:randomUUID(),title:'1989',edition:'日本版 混音'});
 catalog.linkEditionTrack({commandId:randomUUID(),editionId:edition.id,trackId:f.tracks[0]!.id,disc:1,trackNumber:1,sequence:1});await f.controller.queueLocalEdition({editionId:edition.id,expectedRevision:edition.revision,action:'APPEND_MB_QUEUE'});
 f.repository.close();const repository=createCollectionRepository({filePath:path.join(f.directory,'collection.sqlite')});t.after(()=>repository.close());
 const tickets=createLocalSourceTickets(repository,f.epoch,f.datasetId,()=>repository.list({offset:0,limit:1}));
 f.localSources.loadMBQueue=async()=>repository.mbQueue.load(f.datasetId);f.localSources.saveMBQueue=async request=>repository.mbQueue.save(request);
 f.localSources.dispatch=async request=>request.command==='localCatalog.edition'?repository.localCatalog.edition((request.payload as {editionId:string}).editionId):undefined;
 let coldCaptures=0;f.localSources.captureLocalSource=async request=>{coldCaptures++;return tickets.capture(request);};f.localSources.revalidateLocalSource=async id=>tickets.revalidate(id);f.localSources.releaseLocalSource=async id=>tickets.release(id);
 const controller=new BridgeController({roon:f.adapter,registry:f.registry,gateway:f.gateway,logger:silentLogger,localSources:f.localSources,netease:{configured:false} as NeteasePort});t.after(()=>controller.shutdown());
 await controller.restoreLogicalQueue();assert.equal(f.sessions.length,0);assert.equal(f.pool.resourceSnapshot().openLeases,0);assert.equal(controller.getPlaybackState().state,'idle');return {...f,controller,repository,edition,coldCaptures:()=>coldCaptures};
}
test('007 R1真实SQLite冷开恢复明确版次，点击后保留version且Boot零FD/SDK',async t=>{
 const f=await restoredEdition(t);let sentVersion:string|undefined;const send=f.adapter.play.bind(f.adapter);t.mock.method(f.adapter,'play',async (request:import('../../src/roon/types.js').RoonPlayRequest)=>{sentVersion=request.metadata.version;return send(request);});const q=f.controller.getPlaybackState().queue,work=f.controller.playQueueEntry({queueId:q.queueId!,expectedRevision:q.revision!,entryId:q.items[0]!.entryId!});
 await eventually(()=>f.sessions.length===1,'显式点击后begin');f.sessions[0]!('SessionBegan',{session_id:'restored-edition'});await work;
 assert.equal(sentVersion,'日本版 混音');assert.equal(f.controller.getPlaybackState().currentTrack?.version,'日本版 混音');assert.equal(f.controller.getPlaybackState().queue.items[0]!.edition?.edition,'日本版 混音');
});
for(const missing of [false,true])test(`007 R1恢复版次${missing?'缺失':'revision不一致'}明确拒绝且零FD/SDK`,async t=>{
 const f=await restoredEdition(t);const dispatch=f.localSources.dispatch;
 f.localSources.dispatch=async request=>{if(request.command==='localCatalog.edition'){if(missing)throw new Error('受控Owner版次已不可用');const result=await dispatch(request);return {...result as object,revision:'2'};}return dispatch(request);};
 const q=f.controller.getPlaybackState().queue;await assert.rejects(f.controller.playQueueEntry({queueId:q.queueId!,expectedRevision:q.revision!,entryId:q.items[0]!.entryId!}),/LOCAL_EDITION_NEEDS_REVALIDATION/u);assert.equal(f.coldCaptures(),0);assert.equal(f.sessions.length,0);assert.equal(f.sends.length,0);assert.equal(f.pool.resourceSnapshot().openLeases,0);
});

test('007 R1稳定entry自己的cursor save ACK等待期间Stop封口，晚ACK不得SDK派发',async t=>{
 const f=await queueFixture(t,30);await f.controller.playLocal(f.request(0,'APPEND_MB_QUEUE'));await f.controller.playLocal(f.request(1,'APPEND_MB_QUEUE'));const captures=f.captures();
 let release!:()=>void,entered=false;const gate=new Promise<void>(resolve=>release=resolve);t.after(()=>release());const save=f.localSources.saveMBQueue!;
 f.localSources.saveMBQueue=async request=>{const result=await save(request);entered=true;await gate;return result;};
 const q=f.controller.getPlaybackState().queue,work=f.controller.playQueueEntry({queueId:q.queueId!,expectedRevision:q.revision!,entryId:q.items[1]!.entryId!}),outcome=work.then(()=>false,()=>true);
 await eventually(()=>entered,'真实SQLite已提交cursor，ACK等待');await f.controller.stop();release();assert.equal(await outcome,true);assert.equal(f.sessions.length,0);assert.equal(f.sends.length,0);assert.equal(f.pool.resourceSnapshot().openLeases,0);assert.equal(f.captures(),captures);const saved=f.repository.mbQueue.load(f.datasetId) as import('@music-bridge/contracts').MBQueueRecord;const state=f.controller.getPlaybackState();assert.equal(saved.currentEntryId,q.items[1]!.entryId);assert.equal(state.queue.revision,saved.revision);assert.equal(state.queue.index,1);assert.equal(state.queue.items[state.queue.index]!.entryId,saved.currentEntryId);assert.equal(state.state,'idle');
});
test('007 R1稳定entry捕获await期间REORDER ACK使资格失效，零SDK派发',async t=>{
 const f=await queueFixture(t,30);await f.controller.playLocal(f.request(0,'APPEND_MB_QUEUE'));await f.controller.playLocal(f.request(1,'APPEND_MB_QUEUE'));
 let release!:()=>void,entered=false;const gate=new Promise<void>(resolve=>release=resolve);t.after(()=>release());const capture=f.localSources.captureLocalSource!;
 f.localSources.captureLocalSource=async request=>{entered=true;await gate;return capture(request);};
 const initial=f.controller.getPlaybackState().queue,work=f.controller.playQueueEntry({queueId:initial.queueId!,expectedRevision:initial.revision!,entryId:initial.items[0]!.entryId!}),outcome=work.then(()=>false,()=>true);
 await eventually(()=>entered,'实际本地capture等待');const q=f.controller.getPlaybackState().queue;await f.controller.editLogicalQueue({queueId:q.queueId!,expectedRevision:q.revision!,action:'REORDER',entryIds:q.items.map(item=>item.entryId!).reverse()});
 release();assert.equal(await outcome,true);assert.equal(f.sessions.length,0);assert.equal(f.sends.length,0);assert.equal(f.pool.resourceSnapshot().openLeases,0);
});
