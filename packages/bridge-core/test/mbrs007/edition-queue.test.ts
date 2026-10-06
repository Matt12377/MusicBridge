import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {queueFixture} from './queue-fixture.js';
import {eventually} from '../mbrs005/fixture.js';
import {isMBEditionQueueSnapshot,validateIpcEvent} from '@music-bridge/contracts';
import {materializeMBEdition} from '../../src/collection/mb-queue-materializer.js';

test('007生产Owner发行快照按数值盘轨/序号排序只取active；Controller整发行与三动作保留明确version',async t=>{
 const f=await queueFixture(t),catalog=f.repository.localCatalog,edition=catalog.createEdition({commandId:randomUUID(),title:'1989',edition:'日本版 混音'});
 const add=(i:number,disc:number,trackNumber:number,sequence:number)=>catalog.linkEditionTrack({commandId:randomUUID(),editionId:edition.id,trackId:f.tracks[i]!.id,disc,trackNumber,sequence});
 add(0,2,1,1);add(1,1,10,2);add(0,1,2,3);const removed=add(1,1,1,4);catalog.removeEditionTrack({commandId:randomUUID(),id:removed.id,expectedRevision:removed.revision});
 const request={editionId:edition.id,expectedRevision:edition.revision,action:'PLAY_NOW' as const},snapshot=materializeMBEdition(f.repository,request);
 assert.equal(isMBEditionQueueSnapshot(snapshot),true);assert.deepEqual(snapshot.sources.map(s=>s.snapshot.trackId),[f.tracks[0]!.id,f.tracks[1]!.id,f.tracks[0]!.id]);
 const work=f.controller.queueLocalEdition(request);await eventually(()=>f.sessions.length===1,'整发行唯一当前begin');f.sessions[0]!('SessionBegan',{session_id:'album-A'});await work;
 const state=f.controller.getPlaybackState();assert.equal(state.queue.items.length,3);assert.equal(state.currentTrack?.version,'日本版 混音');assert.equal(state.queue.items[0]!.edition!.edition,'日本版 混音');assert.ok(validateIpcEvent({version:1,event:'playback.changed',payload:{state}}).ok);
 await f.controller.queueLocalEdition({...request,action:'APPEND_MB_QUEUE'});await f.controller.queueLocalEdition({...request,action:'PLAY_NEXT_MB_QUEUE'});assert.equal(f.controller.getPlaybackState().queue.items.length,9);assert.equal(f.sessions.length,1);
});
test('007发行5000正例与5001明确容量错误；旧公开editionTracks仍200上限且无副作用',async t=>{
 const f=await queueFixture(t),catalog=f.repository.localCatalog,edition=catalog.createEdition({commandId:randomUUID(),title:'合成容量专辑',edition:''});
 for(let i=1;i<=5000;i++)catalog.linkEditionTrack({commandId:randomUUID(),editionId:edition.id,trackId:f.tracks[0]!.id,disc:1,trackNumber:i,sequence:i});
 const request={editionId:edition.id,expectedRevision:edition.revision,action:'APPEND_MB_QUEUE' as const};
 assert.throws(()=>catalog.editionTracks(edition.id));const snapshot=materializeMBEdition(f.repository,request);assert.equal(snapshot.sources.length,5000);
 await f.controller.queueLocalEdition(request);assert.equal(f.controller.getPlaybackState().queue.items.length,5000);assert.equal(f.sessions.length,0);assert.equal(f.pool.resourceSnapshot().openLeases,0);
 catalog.linkEditionTrack({commandId:randomUUID(),editionId:edition.id,trackId:f.tracks[0]!.id,disc:1,trackNumber:5001,sequence:5001});
 await assert.rejects(f.controller.queueLocalEdition(request));assert.equal(f.controller.getPlaybackState().queue.items.length,5000);assert.equal(f.sessions.length,0);
});

test('007 CUE片段发行拒绝，不隐式替换整文件，零队列写/FD/SDK副作用',async t=>{
 const f=await queueFixture(t),catalog=f.repository.localCatalog,edition=catalog.createEdition({commandId:randomUUID(),title:'片段专辑',edition:'明确片段'});
 const asset=catalog.registerAsset({commandId:randomUUID(),libraryRootId:f.root.id,expectedRootRevision:catalog.root(f.root.id).revision,relative:'片段.wav',sha256:null,sampleFrames:'48000',timebaseHz:48000});
 const track=catalog.createTrack({commandId:randomUUID(),assetId:asset.id,segment:{startFrame:'0',endFrameExclusive:'100',timebaseHz:48000}});
 catalog.linkEditionTrack({commandId:randomUUID(),editionId:edition.id,trackId:track.id,disc:1,trackNumber:1,sequence:1});
 for(const action of ['PLAY_NOW','APPEND_MB_QUEUE','PLAY_NEXT_MB_QUEUE'] as const)await assert.rejects(f.controller.queueLocalEdition({editionId:edition.id,expectedRevision:edition.revision,action}),/LOCAL_SEGMENT_UNSUPPORTED/u);
 assert.equal(f.repository.mbQueue.load(f.datasetId),null);assert.equal(f.controller.getPlaybackState().queue.items.length,0);assert.equal(f.captures(),0);assert.equal(f.pool.resourceSnapshot().openLeases,0);assert.equal(f.sessions.length,0);
});
test('007持久逻辑来源selection修订改变且fileRevision不变，旧entry重解析明确拒绝且零SDK',async t=>{
 const f=await queueFixture(t,30),catalog=f.repository.localCatalog,edition=catalog.createEdition({commandId:randomUUID(),title:'修订专辑',edition:''}),track=f.tracks[0]!;
 catalog.linkEditionTrack({commandId:randomUUID(),editionId:edition.id,trackId:track.id,disc:1,trackNumber:1,sequence:1});await f.controller.queueLocalEdition({editionId:edition.id,expectedRevision:edition.revision,action:'APPEND_MB_QUEUE'});
 catalog.selectAsset({commandId:randomUUID(),trackId:track.id,expectedSelectionRevision:track.selectionRevision,assetId:track.assetId});
 const q=f.controller.getPlaybackState().queue;await assert.rejects(f.controller.playQueueEntry({queueId:q.queueId!,expectedRevision:q.revision!,entryId:q.items[0]!.entryId!}));assert.equal(f.sessions.length,0);assert.equal(f.sends.length,0);assert.equal(f.pool.resourceSnapshot().openLeases,0);
});
