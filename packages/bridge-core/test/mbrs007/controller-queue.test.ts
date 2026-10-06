import {tick} from '../mbrs006/adapter-fixture.js';
import {DatabaseSync} from 'node:sqlite';
import {createCollectionRepository} from '../../src/collection/repository.js';
import {readBackupIndex} from '../../src/recording/backup-index.js';
import {randomUUID} from 'node:crypto';
import type {FileHandle} from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
import {queueFixture} from './queue-fixture.js';
import {eventually} from '../mbrs005/fixture.js';
import {roonTrackIdFromReference,validateIpcEvent} from '@music-bridge/contracts';
import {BridgeController} from '../../src/application/bridge-controller.js';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';

test('007紧邻NEXT与ACTIVE并存：预备零SDK、A字节仍可读，晋升保存B真实lease/ticket',async t=>{
 const f=await queueFixture(t);await f.start(0);const a=(f.controller as any).activeToken,aAttempt=f.controller.getPlaybackState().local!.attempt_id;await f.controller.playLocal(f.request(1,'APPEND_MB_QUEUE'));
 await eventually(()=>f.pool.resourceSnapshot().openLeases===2,'NEXT固定FD打开');const next=(f.controller as any).localNext;await next.work;
 const b=next.owner.local.lease,ticket=next.owner.local.capture.ticketId;assert.equal(b.state,'PREPARED');assert.equal(f.sessions.length,1);
 assert.deepEqual(Buffer.from(await fetch(f.gateway.localStreamUrl(a)).then(r=>r.arrayBuffer()) as ArrayBuffer),f.bytes);
 const work=f.controller.next();await eventually(()=>f.sessions.length===2,'晋升B才begin');f.sessions[1]!('SessionBegan',{session_id:'B-session'});await work;
 assert.equal((f.controller as any).owner.local.lease,b);assert.equal((f.controller as any).owner.local.capture.ticketId,ticket);assert.equal(b.state,'ACTIVE');
 assert.equal(f.sends.length,2);assert.notEqual(f.controller.getPlaybackState().local!.attempt_id,aAttempt);assert.equal(f.controller.getPlaybackState().queue.items[1]!.entryId,next.item.entryId);
});
test('007按entryId重排/移除仅取消旧NEXT，重复track仍有独立entry，过期revision零编辑',async t=>{
 const f=await queueFixture(t);await f.start();await f.controller.playLocal(f.request(1,'APPEND_MB_QUEUE'));await f.controller.playLocal(f.request(1,'APPEND_MB_QUEUE'));
 await eventually(()=>!!(f.controller as any).localNext?.owner.local?.lease,'B预备');const b=(f.controller as any).localNext.owner.local.lease;
 const q=f.controller.getPlaybackState().queue,ids=q.items.map(i=>i.entryId!);assert.equal(new Set(ids).size,3);
 await f.controller.editLogicalQueue({queueId:q.queueId!,expectedRevision:q.revision!,action:'REMOVE',entryIds:[ids[1]!]});await eventually(()=>b.state==='CLOSED','被移除B实际close');
 assert.equal(f.controller.getPlaybackState().local?.phase,'PLAYING');assert.equal(f.sessions.length,1);
 await assert.rejects(f.controller.editLogicalQueue({queueId:q.queueId!,expectedRevision:q.revision!,action:'REORDER',entryIds:[ids[2]!,ids[0]!]}));
 const current=f.controller.getPlaybackState().queue;await f.controller.editLogicalQueue({queueId:current.queueId!,expectedRevision:current.revision!,action:'REORDER',entryIds:current.items.map(i=>i.entryId!).reverse()});
 assert.equal(f.controller.getPlaybackState().queue.index,1);assert.equal(f.sessions.length,1);
});
test('00730秒PREPARED过期后一次重捕获，不借A会话续B，不复活旧token',async t=>{
 const f=await queueFixture(t);await f.start();await f.controller.playLocal(f.request(1,'APPEND_MB_QUEUE'));await eventually(()=>!!(f.controller as any).localNext?.owner.local?.lease,'B预备');
 const b=(f.controller as any).localNext.owner.local.lease,oldToken=(f.controller as any).localNext.owner.token;f.advance(30_001);
 const work=f.controller.next();await eventually(()=>f.sessions.length===2,'过期重新捕获后派发');f.sessions[1]!('SessionBegan',{session_id:'new-B'});await work;
 assert.equal(b.state,'CLOSED');assert.notEqual((f.controller as any).activeToken,oldToken);assert.equal(f.registry.getLocal(oldToken),undefined);
});
test('007普通SessionEnded不推进；自然结束仅一次推进，旧A迟到不清B',async t=>{
 const f=await queueFixture(t);await f.start();await f.controller.playLocal(f.request(1,'APPEND_MB_QUEUE'));f.plays[0]!('EndedNaturally',{});
 await eventually(()=>f.sessions.length===2,'自然结束提交B');f.sessions[1]!('SessionBegan',{session_id:'B'});await eventually(()=>f.controller.getPlaybackState().local?.phase==='PLAYING','B确认');
 f.plays[0]!('EndedNaturally',{});f.sessions[0]!('SessionEnded',{});await new Promise(resolve=>setImmediate(resolve));assert.equal(f.sessions.length,2);assert.equal(f.controller.getPlaybackState().queue.index,1);
 f.sessions[1]!('SessionEnded',{});await eventually(()=>f.controller.getPlaybackState().state==='idle','普通终态闲置');assert.equal(f.sessions.length,2);
});
test('007下一曲替换坏文件有明确预检失败，当前A不被扫描后项替代',async t=>{
 const f=await queueFixture(t);await f.start();await writeFile(path.join(f.media,'二.wav'),'replacement');await f.controller.playLocal(f.request(1,'APPEND_MB_QUEUE'));
 await eventually(()=>(f.controller as any).localNext?.failed,'坏曲预检失败');assert.equal(f.sessions.length,1);assert.equal(f.controller.getPlaybackState().local?.phase,'PLAYING');
 await assert.rejects(f.controller.next());assert.equal(f.sessions.length,1);assert.equal(f.controller.getPlaybackState().queue.index,1);
});
test('007真实逻辑队列恢复到idle，不捕获票据/FD/会话；显式用户点击重新解析',async t=>{
 const f=await queueFixture(t);await f.start();await f.controller.playLocal(f.request(1,'APPEND_MB_QUEUE'));const before=f.captures();
 const restored=new BridgeController((f.controller as any).dependencies);t.after(()=>restored.shutdown());await restored.restoreLogicalQueue();
 assert.equal(restored.getPlaybackState().state,'idle');assert.ok(validateIpcEvent({version:1,event:'playback.changed',payload:{state:restored.getPlaybackState()}}).ok);assert.equal(restored.getPlaybackState().queue.persistence,'NEEDS_REVALIDATION');assert.equal(f.captures(),before);assert.equal(f.sessions.length,1);
 assert.ok(!JSON.stringify(f.repository.mbQueue.load(f.datasetId)).includes(f.media));
});

test('007已保存队列替换分配新queueId，durable revision递增且旧编辑拒绝',async t=>{
 const f=await queueFixture(t);await f.start();const old=f.controller.getPlaybackState().queue;
 await f.start(1);const fresh=f.controller.getPlaybackState().queue;assert.notEqual(fresh.queueId,old.queueId);assert.ok(BigInt(fresh.revision!)>BigInt(old.revision!));
 assert.equal((f.repository.mbQueue.load(f.datasetId) as any).queueId,fresh.queueId);await assert.rejects(f.controller.editLogicalQueue({queueId:old.queueId!,expectedRevision:old.revision!,action:'REMOVE',entryIds:[old.items[0]!.entryId!]}));
 assert.equal(f.controller.getPlaybackState().queue.items[0]!.trackId,f.requests[1]!.local_track_id);
});
test('007超过16次顺序本地播放只复用2lane历史身份，当前session不受NEXT attempt挤出',async t=>{
 const f=await queueFixture(t);await f.start();for(let i=0;i<18;i++)await f.controller.playLocal(f.request(i%2,'APPEND_MB_QUEUE'));
 for(let i=1;i<=18;i++){
  await eventually(()=>!!(f.controller as any).localNext?.owner.local?.lease || (f.controller as any).localNext?.failed,'只邻项预备');
  const work=f.controller.next();await eventually(()=>f.sessions.length===i+1,'顺序提交下一项');f.sessions[i]!('SessionBegan',{session_id:'session-'+i});await work;
  assert.equal(f.controller.getPlaybackState().local?.phase,'PLAYING');assert.ok(f.pool.resourceSnapshot().openLeases<=2);
 }
 assert.equal(((f.pool as any).attempts as Map<string,number>).size,2);assert.equal(f.sends.length,19);
});

test('007逻辑保存失败不能发布未持久追加；真实SQLite回滚后原条目/revision保持',async t=>{
 const f=await queueFixture(t);await f.start();const old=f.controller.getPlaybackState().queue;f.setSaveFailure(true);
 await assert.rejects(f.controller.playLocal(f.request(1,'APPEND_MB_QUEUE')));const after=f.controller.getPlaybackState().queue;
 assert.deepEqual(after.items.map(i=>i.entryId),old.items.map(i=>i.entryId));assert.equal(after.revision,old.revision);assert.equal((f.repository.mbQueue.load(f.datasetId) as any).entries.length,1);assert.equal(f.sessions.length,1);
});

test('007实际Owner save阻塞期间公开队列/Time回报保持durable旧队列，ACK后才安装候选',async t=>{
 const f=await queueFixture(t);await f.start();const old=f.controller.getPlaybackState().queue;let release!:()=>void;
 const gate=new Promise<void>(resolve=>release=resolve),save=f.localSources.saveMBQueue!;let entered=false;
 f.localSources.saveMBQueue=async request=>{entered=true;await gate;return save(request);};
 const events:any[]=[],unsubscribe=f.controller.subscribe(snapshot=>events.push(snapshot));t.after(unsubscribe);
 const work=f.controller.playLocal(f.request(1,'APPEND_MB_QUEUE'));await eventually(()=>entered,'save进入阻塞');
 assert.deepEqual(f.controller.getPlaybackState().queue.items.map(i=>i.entryId),old.items.map(i=>i.entryId));assert.equal(f.controller.getPlaybackState().queue.revision,old.revision);
 f.controller.updateRoonTime(1000);assert.ok(events.every(e=>e.queue.items.length===1));assert.equal(f.pool.resourceSnapshot().openLeases,1);
 release();await work;assert.equal(f.controller.getPlaybackState().queue.items.length,2);assert.ok(BigInt(f.controller.getPlaybackState().queue.revision!)>BigInt(old.revision!));
});

test('007取消NEXT必须join实际FD read后才复用lane，不因close意图提前释放资源',async t=>{
 const f=await queueFixture(t);await f.start();await f.controller.playLocal(f.request(1,'APPEND_MB_QUEUE'));await eventually(()=>!!(f.controller as any).localNext?.owner.local?.lease,'NEXT已开FD');
 const next=(f.controller as any).localNext,lease=next.owner.local.lease,handle=(lease as any).file.handle as FileHandle,original=handle.read.bind(handle);let release!:()=>void,entered=false;
 const gate=new Promise<void>(resolve=>release=resolve);t.after(()=>release());handle.read=(async(buffer:Buffer,offset:number,length:number,position:number)=>{entered=true;await gate;return original(buffer,offset,length,position);}) as FileHandle['read'];
 const read=(async()=>{for await(const _chunk of lease.readSlice(0,4,new AbortController().signal)){}})();void read.catch(()=>undefined);await eventually(()=>entered,'真正FD read阻塞');
 const q=f.controller.getPlaybackState().queue;await f.controller.editLogicalQueue({queueId:q.queueId!,expectedRevision:q.revision!,action:'REMOVE',entryIds:[q.items[1]!.entryId!]});
 await f.controller.playLocal(f.request(0,'APPEND_MB_QUEUE'));assert.notEqual(lease.state,'CLOSED');assert.equal((f.controller as any).localLaneBusy[next.owner.local.lane],true);assert.equal(f.sessions.length,1);
 release();await read.catch(()=>undefined);await eventually(()=>lease.state==='CLOSED','旧FD quiet后CLOSED');await eventually(()=>!!(f.controller as any).localNext?.owner.local?.lease,'quiet后才能复用lane');
 assert.equal(((f.pool as any).attempts as Map<string,number>).size,2);assert.ok(f.pool.resourceSnapshot().openLeases<=2);
});
test('007NEXT准备期间外部接管封口，晚capture只清旧NEXT且重连零自动派发',async t=>{
 const f=await queueFixture(t);await f.start();let release!:()=>void,entered=false;const gate=new Promise<void>(resolve=>release=resolve),capture=f.localSources.captureLocalSource!;
 let reads=0;f.localSources.captureLocalSource=async request=>{if(++reads===2){entered=true;await gate;}return capture(request);};t.after(()=>release());
 await f.controller.playLocal(f.request(1,'APPEND_MB_QUEUE'));await eventually(()=>entered,'NEXT进入capture等待');f.unpair();f.controller.syncRoonTransportState();
 release();await eventually(()=>f.pool.resourceSnapshot().openLeases===0,'断链收当前与NEXT');f.pair();f.zoneCallback('Subscribed',{zones:[{zone_id:'synthetic-zone',display_name:'受控Zone',outputs:[{output_id:'synthetic-output'}]}]});f.adapter.selectZone('synthetic-zone');f.controller.syncRoonTransportState();await tick();assert.equal(f.sessions.length,1);assert.equal(f.sends.length,1);
});

test('007旧dataset队列仅需核对摘要且零捕获；用户新意图以准确旧revision CAS替换，不自动重绑来源',async t=>{
 const f=await queueFixture(t),oldDataset=randomUUID(),oldQueue=randomUUID();
 const old={schemaVersion:'1.2' as const,datasetId:oldDataset,queueId:oldQueue,revision:'1',currentEntryId:null,restartPolicy:{reResolve:true as const,autoplay:false as const},entries:[{entryId:randomUUID(),entryRevision:'1',source:{kind:'netease' as const,trackId:'123'},quality:'auto' as const}]};
 f.repository.mbQueue.save({expectedRevision:'0',queue:old});await f.controller.restoreLogicalQueue();
 const snapshot=f.controller.getPlaybackState();assert.equal(snapshot.state,'idle');assert.equal(snapshot.queue.items.length,0);assert.equal(snapshot.queue.persistence,'NEEDS_REVALIDATION');assert.equal(snapshot.queue.revision,'1');assert.notEqual(snapshot.queue.queueId,oldQueue);
 assert.deepEqual(f.repository.mbQueue.load(oldDataset),old);assert.equal(f.captures(),0);assert.equal(f.sessions.length,0);assert.equal(f.pool.resourceSnapshot().openLeases,0);assert.ok(validateIpcEvent({version:1,event:'playback.changed',payload:{state:snapshot}}).ok);
 await f.start();const fresh=f.repository.mbQueue.load(f.datasetId) as any;assert.equal(fresh.datasetId,f.datasetId);assert.notEqual(fresh.queueId,oldQueue);assert.equal(fresh.revision,'2');assert.equal(fresh.entries[0].source.kind,'local_file');assert.ok(f.captures()>0);assert.equal(f.sessions.length,1);
});
test('007native临时引用不落库；恢复明确unsupported且不能云或native隐式重播',async t=>{
 const f=await queueFixture(t);const reference='musicbridge-v2-entity-00000001-1111-4111-8111-111111111111';await f.controller.appendRoon({reference,zoneId:'synthetic-zone',track:{id:roonTrackIdFromReference(reference),title:'受控native',artists:['受控'],album:'受控'}});const saved=f.repository.mbQueue.load(f.datasetId) as any;
 assert.deepEqual(saved.entries[0].source,{kind:'roon',restore:'UNSUPPORTED_NATIVE_RESTORE'});assert.ok(!JSON.stringify(saved).includes(reference));
 const restored=new BridgeController((f.controller as any).dependencies);t.after(()=>restored.shutdown());await restored.restoreLogicalQueue();const snapshot=restored.getPlaybackState();
 assert.equal(snapshot.queue.items[0]!.preflight?.reason,'UNSUPPORTED_NATIVE_RESTORE');assert.ok(validateIpcEvent({version:1,event:'playback.changed',payload:{state:snapshot}}).ok);
 await assert.rejects(restored.playQueueEntry({queueId:snapshot.queue.queueId!,expectedRevision:snapshot.queue.revision!,entryId:snapshot.queue.items[0]!.entryId!}));assert.equal(f.sessions.length,0);assert.equal(f.sends.length,0);
});

test('007当前与NEXT独立：暂停/续播/前后seek只控制当前session，顺序切换不宣称gapless',async t=>{
 const f=await queueFixture(t);await f.start();await f.controller.playLocal(f.request(1,'APPEND_MB_QUEUE'));await eventually(()=>!!(f.controller as any).localNext?.owner.local?.lease,'NEXT预备');const lease=(f.controller as any).localNext.owner.local.lease;
 const report=(state:string,position:number)=>f.zoneCallback('Changed',{zones_changed:[{zone_id:'synthetic-zone',state,outputs:[{output_id:'synthetic-output'}],is_pause_allowed:true,is_play_allowed:true,is_seek_allowed:true,now_playing:{seek_position:position}}]});
 const paused=f.controller.pause();await new Promise(resolve=>setImmediate(resolve));f.plays[0]!('Paused',{});report('paused',0);await paused;assert.equal(f.controller.getPlaybackState().local?.phase,'PAUSED');assert.equal(lease.state,'PREPARED');
 const resumed=f.controller.resume();await new Promise(resolve=>setImmediate(resolve));f.plays[0]!('Playing',{});report('playing',0);await resumed;
 for(const ms of [750,250]){const seek=f.controller.seek(ms);await new Promise(resolve=>setImmediate(resolve));report('playing',ms/1000);await seek;}
 assert.equal(f.sessions.length,1);assert.equal(f.sends.length,1);assert.equal(lease.state,'PREPARED');assert.equal(f.controller.getPlaybackState().local?.quality.gapless,'NOT_TESTED');
});
test('007生产Controller显式local/native混排保来源；NEXT不提前native提交，返回local重新核资格',async t=>{
 const nativeCalls:string[]=[],native:NonNullable<ConstructorParameters<typeof BridgeController>[0]['roonLibrary']>={async play(reference,zoneId,track,options){nativeCalls.push(reference);options?.onDispatch?.();options?.onDispatchCompletion?.(Promise.resolve());return {zoneId,revision:nativeCalls.length,state:'playing',positionMs:0,nowPlaying:{title:track.title,artist:track.artists[0]!,album:track.album,durationMs:1000}};},async stop(){},async pause(){},async resume(){}};
 const f=await queueFixture(t,500,native);await f.start();const reference='musicbridge-v2-entity-00000002-1111-4111-8111-111111111111';
 await f.controller.appendRoon({reference,zoneId:'synthetic-zone',track:{id:roonTrackIdFromReference(reference),title:'显式native',artists:['合成'],album:'合成'}});
 assert.equal(nativeCalls.length,0);assert.equal(f.sessions.length,1);assert.equal(f.pool.resourceSnapshot().openLeases,1);await f.controller.next();assert.deepEqual(nativeCalls,[reference]);assert.equal(f.controller.getPlaybackState().source,'roon');
 const previous=f.controller.previous();await eventually(()=>f.sessions.length===2,'重新提交本地前曲');f.sessions[1]!('SessionBegan',{session_id:'local-return'});await previous;
 assert.equal(f.controller.getPlaybackState().source,'local_file');assert.equal(nativeCalls.length,1);assert.equal(f.controller.getPlaybackState().queue.items.length,2);assert.ok(!JSON.stringify(f.repository.mbQueue.load(f.datasetId)).includes(reference));
});

test('007仅逻辑row损坏保持Boot idle/UNAVAILABLE且零capture；新意图也不能猜revision覆写原件',async t=>{
 const f=await queueFixture(t),file=path.join(f.directory,'collection.sqlite');f.repository.mbQueue.load(f.datasetId);f.repository.close();
 const raw=new DatabaseSync(file),broken='{"不可恢复":"没有可信revision"}';raw.prepare('INSERT INTO mb_playback_queue VALUES(1,?,?,?,?)').run(f.datasetId,randomUUID(),'未知',broken);raw.close();
 const reopened=createCollectionRepository({filePath:file});t.after(()=>reopened.close());f.localSources.loadMBQueue=async()=>reopened.mbQueue.load(f.datasetId);f.localSources.saveMBQueue=async request=>reopened.mbQueue.save(request);
 await f.controller.restoreLogicalQueue();const state=f.controller.getPlaybackState();assert.equal(state.state,'idle');assert.equal(state.queue.persistence,'UNAVAILABLE');assert.equal(state.queue.items.length,0);assert.equal(f.captures(),0);assert.equal(f.sessions.length,0);assert.equal(f.pool.resourceSnapshot().openLeases,0);
 const reference='musicbridge-v2-entity-00000004-1111-4111-8111-111111111111';await assert.rejects(f.controller.appendRoon({reference,zoneId:'synthetic-zone',track:{id:roonTrackIdFromReference(reference),title:'新意图',artists:['合成'],album:'合成'}}));
 const verify=new DatabaseSync(file,{readOnly:true});assert.equal(verify.prepare('SELECT data FROM mb_playback_queue').get()!.data,broken);verify.close();assert.throws(()=>readBackupIndex(file));assert.equal(f.controller.getPlaybackState().queue.items.length,0);
});
test('007两个并发APPEND在阻塞ACK期间保旧投影，逐个重建候选并保存，durable与公开稳定entry完全一致',async t=>{
 const f=await queueFixture(t);await f.start();let release!:()=>void,entered=false;const gate=new Promise<void>(resolve=>release=resolve),save=f.localSources.saveMBQueue!;
 f.localSources.saveMBQueue=async request=>{entered=true;await gate;return save(request);};t.after(()=>release());
 const first=f.controller.playLocal(f.request(1,'APPEND_MB_QUEUE'));await eventually(()=>entered,'首个保存阻塞');const second=f.controller.playLocal(f.request(0,'APPEND_MB_QUEUE'));
 await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));assert.equal(f.controller.getPlaybackState().queue.items.length,1);release();await Promise.all([first,second]);
 const publicQueue=f.controller.getPlaybackState().queue,saved=f.repository.mbQueue.load(f.datasetId) as any;assert.equal(publicQueue.items.length,3);assert.deepEqual(saved.entries.map((entry:any)=>entry.entryId),publicQueue.items.map(entry=>entry.entryId));assert.equal(saved.revision,publicQueue.revision);assert.equal(f.sessions.length,1);
});
test('007保存ACK与Stop交错：已提交逻辑条目仍与公开durable投影一致，零迟到SDK',async t=>{
 const f=await queueFixture(t);await f.start();let release!:()=>void,entered=false;const gate=new Promise<void>(resolve=>release=resolve),save=f.localSources.saveMBQueue!;
 f.localSources.saveMBQueue=async request=>{entered=true;await gate;return save(request);};t.after(()=>release());const append=f.controller.playLocal(f.request(1,'APPEND_MB_QUEUE'));void append.catch(()=>undefined);await eventually(()=>entered,'保存等待ACK');await f.controller.stop();release();await append.catch(()=>undefined);
 const q=f.controller.getPlaybackState().queue,saved=f.repository.mbQueue.load(f.datasetId) as any;assert.deepEqual(q.items.map(i=>i.entryId),saved.entries.map((i:any)=>i.entryId));assert.equal(q.revision,saved.revision);assert.equal(f.sessions.length,1);assert.equal(f.controller.getPlaybackState().state,'idle');
});
