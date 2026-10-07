import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { LocalArtworkContext } from '@music-bridge/contracts';
import { createLocalArtworkClient } from '../src/preload/local-artwork-client.js';

const id=randomUUID(),datasetId=randomUUID(),target={trackId:id,editionId:id,expectedEditionRevision:'1',expectedTrackRevision:'1',expectedSourceRevision:'a'.repeat(64)};
const view:LocalArtworkContext={trackId:id,trackRevision:'1',target,editions:[{id,title:'独立发行',edition:'',revision:'1'}],selection:null,candidates:[],remoteProvider:'commons-cc0-v1',sourceFilesWrite:'OFF',status:'missing'};
test('preload始终固定工作库，选图读通道不能转发URL或泛用Core命令',async()=>{
  const calls:Array<{channel:string;value:any}>=[],client=createLocalArtworkClient(async(channel,value)=>{calls.push({channel,value});return view;},async()=>datasetId,{apply:async()=>{throw 0},create:async()=>{throw 0}});
  await client.getLocalArtworkContext({trackId:id,editionId:id});await client.searchLocalArtworkCandidates({target,query:'天空'});
  assert.deepEqual(calls.map(c=>c.channel),['localArtwork:context','localArtwork:search']);assert.ok(calls.every(c=>c.value.datasetId===datasetId));
  let invoked=0;const bad=Object.defineProperty({...target},'expectedSourceRevision',{enumerable:true,get(){invoked++;return 'a'.repeat(64);}});
  await assert.rejects(()=>client.findLocalArtworkCandidates(bad));assert.equal(invoked,0);
  await assert.rejects(()=>client.searchLocalArtworkCandidates({target,query:'https://localhost/a'}));assert.equal(calls.length,2);
});
test('预加载复制拖入字节，拒绝错发行回执和shared buffer',async()=>{
  let received:any;const client=createLocalArtworkClient(async(_channel,value)=>{received=value;return view;},async()=>datasetId,{apply:async()=>{throw 0},create:async()=>{throw 0}}),bytes=new Uint8Array([1,2,3,4]);
  await client.importLocalArtworkBytes({target,bytes});bytes[0]=99;assert.deepEqual([...received.bytes],[1,2,3,4]);
  await assert.rejects(()=>client.importLocalArtworkBytes({target,bytes:new Uint8Array(new SharedArrayBuffer(4))}));
  const wrong=createLocalArtworkClient(async()=>({...view,target:{...target,editionId:randomUUID()}}),async()=>datasetId,{apply:async()=>{throw 0},create:async()=>{throw 0}});await assert.rejects(()=>wrong.findLocalArtworkCandidates(target));
});
test('保存仅走既有持久outbox接口，unknown没有自动重发或读当写',async()=>{
  const writes:any[]=[],client=createLocalArtworkClient(async()=>{throw new Error('写操作不能invoke')},async()=>datasetId,{apply:async request=>{writes.push(request);throw new Error('unknown');},create:async()=>{throw 0}}),request={commandId:randomUUID(),target,candidateId:null,expectedSelectionRevision:null};
  await assert.rejects(()=>client.applyLocalArtworkSelection(request));assert.equal(writes.length,1);assert.deepEqual(writes[0],request);assert.notEqual(writes[0],request);
});
