import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {createMBQueueClient} from '../src/preload/mb-queue-client.js';
import type {PlaybackSnapshot} from '@music-bridge/contracts';
const snapshot:PlaybackSnapshot={state:'idle',queue:{items:[],index:-1,hasNext:false,hasPrevious:false},positionMs:0,canNext:false,canPrevious:false,canStop:false,canPause:false,canResume:false};
test('007生产preload队列入口仅具名闭合身份，私有path/URL/session/SAB及未知action零invoke',async()=>{
 const calls:unknown[]=[],client=createMBQueueClient(async(channel,payload)=>{calls.push({channel,payload});return snapshot;});
 const request={queueId:randomUUID(),expectedRevision:'1',entryId:randomUUID()};await client.playQueueEntry(request);assert.equal(calls.length,1);
 for(const key of ['path','url','session','buffer','lane','oid'])await assert.rejects(client.playQueueEntry({...request,[key]:key==='buffer'?new SharedArrayBuffer(16):'私有'}));
 await assert.rejects(client.editPlaybackQueue({queueId:request.queueId,expectedRevision:'1',entryIds:[request.entryId],action:'UNKNOWN' as never}));assert.equal(calls.length,1);
 await client.editPlaybackQueue({queueId:request.queueId,expectedRevision:'1',entryIds:[request.entryId],action:'REMOVE'});
 await client.queueLocalEdition({editionId:randomUUID(),expectedRevision:'1',action:'PLAY_NEXT_MB_QUEUE'});assert.equal(calls.length,3);
 assert.deepEqual((calls as any[]).map(c=>c.channel),['playback:play-queue-entry','playback:edit-queue','playback:queue-local-edition']);
});
test('007生产preload拒绝损坏队列回执和私有leaf，不能靠cast入Renderer',async()=>{
 const request={queueId:randomUUID(),expectedRevision:'1',entryId:randomUUID()};
 for(const result of [{...snapshot,path:'/私有'},{...snapshot,queue:{...snapshot.queue,buffer:new SharedArrayBuffer(16)}},{...snapshot,queue:{...snapshot.queue,revision:'9007199254740993.0'}}]){
  await assert.rejects(createMBQueueClient(async()=>result).playQueueEntry(request));
 }
});
