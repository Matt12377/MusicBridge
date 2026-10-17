import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {queueFixture} from './queue-fixture.js';
import {eventually} from '../mbrs005/fixture.js';
import {isMBEditionQueueSnapshot,validateIpcEvent} from '@music-bridge/contracts';
import {materializeMBEdition} from '../../src/collection/mb-queue-materializer.js';
import {writeFile,stat} from 'node:fs/promises';
import path from 'node:path';
import type {LocalPlayRequest,LocalAlbumSummary,LocalLibraryPublicApi,CommandOutboxPublicApi} from '@music-bridge/contracts';
import {isMBQueueRecord} from '@music-bridge/contracts';
import {createLocalAlbumOwnerService} from '../../src/collection/local-album-browser/owner-port.js';
import {sourceRootAvailability} from '../../src/recording/source-files.js';
import {LocalAlbumReadError} from '../../src/collection/local-album-browser/grouping.js';
import {useLocalLibrary} from '../../../../apps/desktop/src/renderer/src/composables/application/useLocalLibrary.js';
import {parserVersion,readFacts} from '../mbrs006/catalog-fixture.js';
import type {ScanPreparedBatch} from '../../src/collection/local-scan-store.js';

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

// 合成标签/readFacts沿原组件夹具；真实Repository/SQL/Source签名/Controller/Adapter/FD，不是真实Roon听感。
async function albumQueue950(t:test.TestContext,count=3){
 const f=await queueFixture(t),names=['一.wav','二.wav'];
 for(let index=2;index<count;index++){const name=`增补${String(index).padStart(3,'0')}.wav`;await writeFile(path.join(f.media,name),f.bytes,{mode:0o600});names.push(name);}
 const scanBatchSizes:number[]=[];
 if(names.length<=200){(await f.commit(names)).apply();scanBatchSizes.push(names.length);}
 else{
  // 只扩本有限跨页夹具；同一原scan job逐批提交，不改每批200或成员读取预算。
  const started=f.repository.localScan.start({commandId:randomUUID(),datasetId:f.datasetId,libraryRootId:f.root.id,
   expectedRootRevision:f.repository.localCatalog.root(f.root.id).revision,parserVersion}).job;
  let job=f.repository.localScan.resume({commandId:randomUUID(),jobId:started.jobId,expectedRevision:started.jobRevision});
  for(let offset=0;offset<names.length;offset+=200){
   const members=names.slice(offset,offset+200),completed=offset+members.length===names.length;
   const items=await Promise.all(members.map(async relative=>{const value=await stat(path.join(f.media,relative),{bigint:true});
    return {relative,signature:[value.dev,value.ino,value.size,value.mtimeNs,value.ctimeNs].join(':'),parserVersion,
     outcome:'accepted' as const,fields:{title:relative,artist:'合成作者'},failureCode:null,reused:false,readFacts};}));
   const batch:ScanPreparedBatch={batchId:randomUUID(),jobId:job.jobId,expectedJobRevision:job.jobRevision,
    checkpointBefore:job.checkpointRef,items,frontier:completed?[]:[''],completed};
   f.repository.localScan.privatePrepareBatch({commandId:randomUUID(),jobId:job.jobId,batch});
   job=f.repository.localScan.privateCommitBatch({commandId:randomUUID(),jobId:job.jobId,batchId:batch.batchId,expectedRevision:job.jobRevision});
   scanBatchSizes.push(items.length);assert.equal(job.phase,completed?'completed':'running');
  }
  assert.equal(job.progress.accepted,String(count));
 }
 const readRoots=async()=>[{root:f.repository.localCatalog.root(f.root.id),label:'自有队列目录',availability:await sourceRootAvailability(f.repository.sources.root(f.source.id))}];
 const albums=createLocalAlbumOwnerService({repository:f.repository,assertCurrent(){f.repository.list({offset:0,limit:1});},readRootViews:readRoots,async readArtwork(){return {image:null,status:'source-unavailable'};}});
 t.after(()=>albums.close());
 let selected:LocalAlbumSummary|null=(await albums.queryAlbums({query:'',rootId:f.root.id,filter:'all',offset:0,limit:60})).items[0]!;
 const page=await albums.queryAlbumTracks({albumKey:selected.id,rootId:selected.rootId,offset:0,limit:200});assert.equal(page.total,count);
 let materializations=0;
 f.localSources.readLocalAlbum=async request=>{
  if(request.command==='localAlbum.materializeQueue'){
   materializations++;
   // 只在新版真实私有请求到达后加载新物化器；旧入口RED不会因缺新export而加载失败。
   const {materializeLocalAlbumQueue}=await import('../../src/collection/mb-queue-materializer.js');
   return materializeLocalAlbumQueue(f.repository,albums,request.payload.selection,f.datasetId,request.payload.expiresAtMs,()=>{if(!f.localSources.isLocalSourceCurrent?.())throw new Error('原Owner已失权');});
  }
  switch(request.command){case 'localAlbum.query':return albums.queryAlbums(request.payload);case 'localAlbum.tracks':return albums.queryAlbumTracks(request.payload);case 'localAlbum.artwork':return albums.getArtwork(request.payload);}
 };
 const unavailable=async():Promise<never>=>{throw new Error('本组件不做元数据/搬迁写入');};
 const api:LocalLibraryPublicApi&Pick<CommandOutboxPublicApi,'getCommandOutbox'>={
  queryLocalLibraryTracks:async request=>f.repository.localCatalog.queryTracks(request),getLocalLibraryTrackDetail:async id=>f.repository.localCatalog.trackDetail(id),
  getLocalLibraryPlaybackTarget:async()=>f.controller.getLocalPlaybackTarget(),listLocalLibraryRoots:readRoots,
  overrideLocalLibraryMetadata:unavailable,chooseLocalRelocationCandidates:async()=>null,confirmLocalRelocation:unavailable,
  playLocalLibraryTrack:unavailable,chooseLocalLibraryRoot:unavailable,relinkLocalLibraryRoot:unavailable,localLibraryScan:unavailable,
  listLocalLibraryTracks:unavailable,getLocalLibraryAsset:unavailable,getLocalLibraryMetadata:unavailable,
  getCommandOutbox:async()=>({datasetId:f.datasetId,entries:[]}),
 };
 const model=useLocalLibrary({api,getSelectedZone:()=>({zoneId:'synthetic-zone',displayName:'自有Zone',selected:true}),
  getPlaybackAlbum:()=>selected,play:request=>f.controller.playLocal(request)});
 t.after(()=>model.dispose());await model.activate();
 const request=(index=1):LocalPlayRequest=>{const detail=page.items[index]!.facts;return {...f.request(),local_track_id:detail.track.id,asset_id:detail.asset.id,expected_asset_revision:detail.asset.fileRevision,
  album:{datasetId:f.datasetId,albumKey:selected!.id,rootId:selected!.rootId,revision:selected!.revision,kind:selected!.kind,editionId:selected!.editionId,trackCount:selected!.trackCount}};};
 return {...f,model,albums,page,scanBatchSizes,requestAlbum:request,setAlbum(value:LocalAlbumSummary|null){selected=value;},materializations:()=>materializations};
}

test('LP950 普通专辑旧入口从中间曲保完整有序队列和前后文，同UUID仅回原受理',async t=>{
 const f=await albumQueue950(t),middle=f.page.items[1]!.facts.track.id,work=f.model.playTrack(middle);
 await eventually(()=>f.sessions.length===1,'原普通入口确已到SDK begin');f.sessions[0]!('SessionBegan',{session_id:'queue950-middle'});await work;
 const state=f.controller.getPlaybackState(),ids=f.page.items.map(item=>item.facts.track.id);
 assert.equal(state.state,'playing');assert.equal(state.local?.phase,'PLAYING');assert.equal(f.sends.length,1);
 assert.equal(state.queue.items.length,3);assert.deepEqual(state.queue.items.map(item=>item.trackId),ids);assert.equal(state.queue.index,1);
 assert.equal(state.currentTrack?.id,middle);assert.equal(state.canPrevious,true);assert.equal(state.canNext,true);assert.equal(f.materializations(),1);
 assert.ok(state.queue.items.every(item=>item.edition===undefined));
 const original=f.model.lastPlay.value!.request,revision=state.queue.revision;
 assert.equal(f.controller.getLocalPlayReceipt(original).status,'received');await f.controller.playLocal(original);
 assert.equal(f.controller.getPlaybackState().queue.revision,revision);assert.equal(f.sessions.length,1);assert.equal(f.materializations(),1);
 const previous=f.controller.previous();await eventually(()=>f.sessions.length===2,'原previous只提交前曲');f.sessions[1]!('SessionBegan',{session_id:'queue950-previous'});await previous;
 assert.equal(f.controller.getPlaybackState().currentTrack?.id,ids[0]);
 const next=f.controller.next();await eventually(()=>f.sessions.length===3,'原next回到中曲');f.sessions[2]!('SessionBegan',{session_id:'queue950-next'});await next;
 assert.equal(f.controller.getPlaybackState().currentTrack?.id,middle);assert.equal(f.controller.getPlaybackState().queue.items.length,3);
 const saved=f.repository.mbQueue.load(f.datasetId);assert.ok(isMBQueueRecord(saved));assert.equal(saved.entries.length,3);
 assert.ok(!JSON.stringify(saved).includes(f.media));assert.ok(f.tickets.size<=2);
 await f.controller.shutdown();assert.equal(f.tickets.size,0);assert.deepEqual(f.pool.resourceSnapshot(),{openLeases:0,reservations:0});
});

test('LP950 Owner完整物化拒过期错库错根错成员与修订变化，零队列写和SDK',async t=>{
 const f=await albumQueue950(t),request=f.requestAlbum(),{materializeLocalAlbumQueue}=await import('../../src/collection/mb-queue-materializer.js');
 const read=(value:LocalPlayRequest,expires=Date.now()+2000)=>materializeLocalAlbumQueue(f.repository,f.albums,value,f.datasetId,expires,()=>{});
 const original=await read(request);assert.equal(original.startIndex,1);assert.deepEqual(original.sources.map(source=>source.snapshot.trackId),f.page.items.map(item=>item.facts.track.id));
 for(const value of [{...request,album:{...request.album!,datasetId:randomUUID()}},{...request,album:{...request.album!,rootId:randomUUID()}},
  {...request,album:{...request.album!,trackCount:2}},{...request,local_track_id:randomUUID()},{...request,asset_id:randomUUID()}])await assert.rejects(read(value));
 await assert.rejects(read(request,Date.now()-1));
 f.repository.localCatalog.overrideMetadata({commandId:randomUUID(),trackId:request.local_track_id,expectedRevision:null,fields:{album:'同Owner真实修订变化'}});
 await assert.rejects(read(request));
 assert.equal(f.repository.mbQueue.load(f.datasetId),null);assert.equal(f.sessions.length,0);assert.equal(f.captures(),0);assert.equal(f.tickets.size,0);
});

test('LP950 完整17曲不截原16票上限且不预持全专辑，仍只当前与紧邻NEXT开票',async t=>{
 const f=await albumQueue950(t,17),work=f.model.playTrack(f.page.items[8]!.facts.track.id);
 await eventually(()=>f.sessions.length===1,'完整组只发一个begin');f.sessions[0]!('SessionBegan',{session_id:'queue950-seventeen'});await work;
 const state=f.controller.getPlaybackState();assert.equal(state.queue.items.length,17);assert.equal(state.queue.index,8);
 assert.deepEqual(state.queue.items.map(item=>item.trackId),f.page.items.map(item=>item.facts.track.id));
 await eventually(()=>f.pool.resourceSnapshot().openLeases===2,'仅当前和紧邻NEXT两份真实FD');
 assert.ok(f.captures()<=3);assert.equal(f.tickets.size,2);assert.equal(f.sessions.length,1);
 await f.controller.shutdown();assert.equal(f.tickets.size,0);assert.deepEqual(f.pool.resourceSnapshot(),{openLeases:0,reservations:0});
});

test('LP950 真edition按Owner当前盘轨顺序复用原物化来源，点击中曲保版本且不冒目录发行',async t=>{
 const f=await albumQueue950(t),catalog=f.repository.localCatalog,edition=catalog.createEdition({commandId:randomUUID(),title:'自有多碟专辑',edition:'明确原版本'});
 for(const [index,member]of f.page.items.entries())catalog.linkEditionTrack({commandId:randomUUID(),editionId:edition.id,trackId:member.facts.track.id,disc:index===0?2:1,trackNumber:index===0?1:index,sequence:index+1});
 const summary=(await f.albums.queryAlbums({query:'',rootId:f.root.id,filter:'all',offset:0,limit:60})).items.find(item=>item.editionId===edition.id)!;
 assert.ok(summary);f.setAlbum(summary);const page=await f.albums.queryAlbumTracks({albumKey:summary.id,rootId:summary.rootId,offset:0,limit:200});
 const work=f.model.playTrack(page.items[1]!.facts.track.id);await eventually(()=>f.sessions.length===1,'真发行中曲唯一begin');f.sessions[0]!('SessionBegan',{session_id:'queue950-edition'});await work;
 const state=f.controller.getPlaybackState();assert.equal(state.queue.index,1);assert.deepEqual(state.queue.items.map(item=>item.trackId),page.items.map(item=>item.facts.track.id));
 assert.ok(state.queue.items.every(item=>item.edition?.id===edition.id&&item.edition.revision===edition.revision));assert.equal(state.currentTrack?.version,'明确原版本');
 const selectedTrack=page.items[1]!.facts.track.id;
 catalog.linkEditionTrack({commandId:randomUUID(),editionId:edition.id,trackId:selectedTrack,disc:3,trackNumber:1,sequence:4});
 // 原浏览作者不发布重复成员摘要；保该强门，不虚构一个可展示的新revision。
 await assert.rejects(f.albums.queryAlbums({query:'',rootId:f.root.id,filter:'all',offset:0,limit:60}),error=>error instanceof LocalAlbumReadError&&error.code==='UNAVAILABLE');
 const facts=catalog.trackDetail(selectedTrack),selection:LocalPlayRequest={...f.request(),local_track_id:selectedTrack,asset_id:facts.asset.id,expected_asset_revision:facts.asset.fileRevision,
  album:{datasetId:f.datasetId,albumKey:summary.id,rootId:summary.rootId,revision:summary.revision,kind:summary.kind,editionId:summary.editionId,trackCount:summary.trackCount}};
 const {materializeLocalAlbumQueue}=await import('../../src/collection/mb-queue-materializer.js');
 await assert.rejects(materializeLocalAlbumQueue(f.repository,f.albums,selection,f.datasetId,Date.now()+2000,()=>{}),error=>error instanceof LocalAlbumReadError&&error.code==='UNAVAILABLE');
 assert.equal(f.sessions.length,1);assert.equal(f.controller.getPlaybackState().queue.items.length,3);
});

test('LP950 本地PREPARING和真实AWAITING_ROON超时UNKNOWN均零SDK seek',async t=>{
 const f=await queueFixture(t,30);let seeks=0,release!:()=>void,entered=false;const gate=new Promise<void>(resolve=>{release=resolve;});
 const register=f.registry.registerLocalSource.bind(f.registry);
 t.mock.method(f.registry,'registerLocalSource',async(...args:Parameters<typeof register>)=>{entered=true;await gate;return register(...args);});t.after(()=>release());
 t.mock.method(f.core.services.RoonApiTransport,'seek',(_zone:unknown,_how:unknown,_seconds:unknown,callback:(error:false)=>void)=>{seeks++;callback(false);});
 const work=f.controller.playLocal(f.request());void work.catch(()=>undefined);await eventually(()=>entered,'原PREPARING等待真实FD注册');
 assert.equal(f.controller.getPlaybackState().local?.phase,'PREPARING');await assert.rejects(f.controller.seek(500));assert.equal(seeks,0);
 release();await eventually(()=>f.sessions.length===1,'原begin在途');
 f.zoneCallback('Changed',{zones_changed:[{zone_id:'synthetic-zone',state:'playing',outputs:[{output_id:'synthetic-output'}],is_seek_allowed:true,now_playing:{seek_position:0}}]});
 assert.equal(f.controller.getPlaybackState().local?.phase,'AWAITING_ROON');await assert.rejects(f.controller.seek(500));assert.equal(seeks,0);
 await work;assert.equal(f.controller.getPlaybackState().local?.phase,'SUBMISSION_UNKNOWN');
 const denied=f.controller.seek(500);void denied.catch(()=>undefined);
 // 同步收到原attempt的晚确认，不能替已经在UNKNOWN时调用的seek补发资格。
 f.sessions[0]!('SessionBegan',{session_id:'queue950-late-original'});await assert.rejects(denied);assert.equal(seeks,0);
 assert.equal(f.controller.getPlaybackState().local?.phase,'PLAYING');
});

test('LP950 本地confirmed PLAYING和PAUSED可seek，派发前失去owned或Zone则零额外SDK',async t=>{
 const f=await queueFixture(t);let seeks=0;
 t.mock.method(f.core.services.RoonApiTransport,'seek',(_zone:unknown,_how:unknown,_seconds:unknown,callback:(error:false)=>void)=>{seeks++;callback(false);});
 const report=(state:'playing'|'paused',ms:number)=>f.zoneCallback('Changed',{zones_changed:[{zone_id:'synthetic-zone',state,outputs:[{output_id:'synthetic-output'}],is_pause_allowed:true,is_play_allowed:true,is_seek_allowed:true,now_playing:{seek_position:ms/1000}}]});
 await f.start();report('playing',0);
 const playing=f.controller.seek(500);await new Promise(resolve=>setImmediate(resolve));report('playing',500);await playing;assert.equal(seeks,1);
 f.plays[0]!('Paused',{});report('paused',500);assert.equal(f.controller.getPlaybackState().local?.phase,'PAUSED');
 const paused=f.controller.seek(250);await new Promise(resolve=>setImmediate(resolve));report('paused',250);await paused;assert.equal(seeks,2);
 let release!:()=>void,entered=false;const gate=new Promise<void>(resolve=>{release=resolve;}),seek=f.adapter.seek.bind(f.adapter);t.after(()=>release());
 t.mock.method(f.adapter,'seek',async(...args:Parameters<typeof seek>)=>{entered=true;await gate;return seek(...args);});
 const stale=f.controller.seek(750);void stale.catch(()=>undefined);await eventually(()=>entered,'在原device进入后等待SDK前');
 const owner=(f.controller as unknown as {owner:{local:{isOwned:()=>boolean}}}).owner,owned=owner.local.isOwned;assert.equal(owned(),true);
 try{owner.local.isOwned=()=>false;release();await assert.rejects(stale);assert.equal(seeks,2);}finally{owner.local.isOwned=owned;}
 f.zoneCallback('Changed',{zones_changed:[{zone_id:'synthetic-zone',outputs:[{output_id:'changed-output'}]}]});
 await assert.rejects(f.controller.seek(900));assert.equal(seeks,2);
});


test('LP950 完整205曲跨原200成员页保持Owner顺序与中曲锚点，仅当前和NEXT持票',async t=>{
 const f=await albumQueue950(t,205);
 assert.deepEqual(f.scanBatchSizes,[200,5]);assert.equal(f.page.total,205);assert.equal(f.page.items.length,200);assert.equal(f.page.hasMore,true);
 const rest=await f.albums.queryAlbumTracks({albumKey:f.page.albumKey,rootId:f.page.rootId,offset:200,limit:200});
 assert.equal(rest.total,205);assert.equal(rest.items.length,5);assert.equal(rest.hasMore,false);assert.equal(rest.album.revision,f.page.album.revision);
 const members=[...f.page.items,...rest.items],ids=members.map(item=>item.facts.track.id),middle=102;
 assert.equal(new Set(ids).size,205);assert.equal(f.captures(),0);assert.equal(f.tickets.size,0);
 const work=f.model.playTrack(members[middle]!.facts.track.id);
 await eventually(()=>f.sessions.length===1,'205成员普通入口只发一个真实begin');f.sessions[0]!('SessionBegan',{session_id:'queue950-two-pages'});await work;
 const state=f.controller.getPlaybackState();assert.equal(f.model.actionError.value,'');assert.equal(state.state,'playing');assert.equal(state.local?.phase,'PLAYING');
 assert.equal(state.queue.items.length,205);assert.deepEqual(state.queue.items.map(item=>item.trackId),ids);assert.equal(state.queue.index,middle);
 assert.equal(state.currentTrack?.id,ids[middle]);assert.equal(state.canPrevious,true);assert.equal(state.canNext,true);assert.equal(f.materializations(),1);
 assert.ok(state.queue.items.every(item=>item.edition===undefined));assert.equal(f.sessions.length,1);assert.equal(f.sends.length,1);
 await eventually(()=>f.pool.resourceSnapshot().openLeases===2,'205逻辑成员仍只当前/NEXT两张实际FD票');
 assert.ok(f.captures()<=3);assert.equal(f.tickets.size,2);assert.equal(f.pool.resourceSnapshot().openLeases,2);
 const saved=f.repository.mbQueue.load(f.datasetId);assert.ok(isMBQueueRecord(saved));assert.equal(saved.entries.length,205);
 assert.ok(!JSON.stringify(saved).includes(f.media));
 await f.controller.shutdown();assert.equal(f.tickets.size,0);assert.deepEqual(f.pool.resourceSnapshot(),{openLeases:0,reservations:0});
});
