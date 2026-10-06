import assert from 'node:assert/strict';
import test from 'node:test';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {roonTrackIdFromReference} from '@music-bridge/contracts';
import type {RoonPlaybackContextItem,RoonPlaybackContextLease,RoonPlaybackContextPage} from '../../src/roon/playback-context.js';
import type {LocalPlayRequest} from '@music-bridge/contracts';
import {validateIpcEvent} from '@music-bridge/contracts';
import {BridgeController} from '../../src/application/bridge-controller.js';
import {StreamGateway} from '../../src/stream/gateway.js';
import {LocalFileSourcePool} from '../../src/stream/local-file-source.js';
import {StreamRegistry} from '../../src/stream/registry.js';
import {createLyricsRequestContext} from '../../src/lyrics/coordinator.js';
import {createPlaybackEventPublisher} from '../../src/application/playback-event-publisher.js';
import type {DatasetOwnerEndpoint} from '../../src/collection/dataset-owner-protocol.js';
import type {NeteasePort} from '../../src/netease/types.js';
import {adapterFixture,silentLogger,tick} from './adapter-fixture.js';
import {catalogFixture} from './catalog-fixture.js';
import {eventually} from '../mbrs005/fixture.js';
async function fixture(t:test.TestContext,timeout=500,roonLibrary?:NonNullable<ConstructorParameters<typeof BridgeController>[0]['roonLibrary']>){
 const f=await catalogFixture(t),pool=new LocalFileSourcePool(),registry=new StreamRegistry({localSourcePool:pool}),gateway=new StreamGateway({host:'127.0.0.1',port:0,publicBaseUrl:'http://127.0.0.1:0',registry,logger:silentLogger});await gateway.start();const sdk=await adapterFixture(timeout,Number(new URL(gateway.iconUrl()).port));
 let alive=true,captures=0,gate:Promise<void>|undefined;
 const localSources:DatasetOwnerEndpoint={prepare:async()=>({epoch:f.epoch,datasetId:f.datasetId}),dispatch:async()=>undefined,commitBoot:async()=>{},close:async()=>{},isLocalSourceCurrent:()=>alive,sealLocalSources(){alive=false;f.tickets.seal();},captureLocalSource:async request=>{captures++;if(gate)await gate;return f.tickets.capture(request);},revalidateLocalSource:async ticket=>f.tickets.revalidate(ticket),releaseLocalSource:async ticket=>f.tickets.release(ticket)};
 const controller=new BridgeController({roon:sdk.adapter,registry,gateway,logger:silentLogger,localSources,...(roonLibrary?{roonLibrary}:{}),netease:new Proxy({configured:true},{get(target,key){if(key==='configured')return true;return ()=>{throw new Error('本地点播禁止调用云或隐式fallback');};}}) as NeteasePort});
 t.after(async()=>{await controller.shutdown();await sdk.adapter.shutdown();await gateway.stop();});
 const request=(i=0,action:LocalPlayRequest['action']='PLAY_NOW')=>({...f.requests[i]!,request_id:randomUUID(),action});
 const start=async(i=0)=>{const req=request(i),work=controller.playLocal(req);await eventually(()=>sdk.sessions.length>sdk.sends.length,'已发起唯一begin');sdk.sessions.at(-1)!('SessionBegan',{session_id:`controlled-${sdk.sessions.length}`});await work;return req;};
 return {...f,...sdk,controller,pool,registry,gateway,request,start,captures:()=>captures,setGate(value?:Promise<void>){gate=value;}};
}
test('006原Controller三动作与原字节HTTP：受理/确认/Playing分开，HTTP完成不推进队列或撤ACTIVE lease',async t=>{
 const f=await fixture(t),req=f.request(),work=f.controller.playLocal(req);await eventually(()=>f.sessions.length===1,'唯一begin');
 const before=f.controller.getPlaybackState();assert.equal(before.local?.phase,'AWAITING_ROON');assert.equal(before.state,'preparing');assert.equal(before.local?.delivery_state,'UNKNOWN');
 const body=await fetch(f.sends[0]?.media_url ?? (f.gateway.localStreamUrl((f.controller as any).activeToken))).then(r=>r.arrayBuffer());assert.deepEqual(Buffer.from(body),f.bytes);
 assert.equal(f.controller.getPlaybackState().local?.phase,'AWAITING_ROON');assert.equal(f.sessions.length,1);
 f.sessions[0]!('SessionBegan',{session_id:'controlled-session'});assert.deepEqual(await work,{status:'accepted',request_id:req.request_id,action:'PLAY_NOW'});
 const playing=f.controller.getPlaybackState();assert.equal(playing.local?.phase,'PLAYING');assert.equal(playing.source,'local_file');assert.ok(validateIpcEvent({version:1,event:'playback.changed',payload:{state:playing}}).ok);assert.equal(createLyricsRequestContext(playing,1)?.kind,'unavailable');
 assert.deepEqual(await f.controller.playLocal(req),await work);assert.equal(f.sessions.length,1);
 await f.controller.playLocal(f.request(1,'APPEND_MB_QUEUE'));await f.controller.playLocal(f.request(0,'PLAY_NEXT_MB_QUEUE'));assert.equal(f.controller.getPlaybackState().queue.items.length,3);assert.equal(f.sessions.length,1);
 await fetch(f.sends[0]!.media_url).then(r=>r.arrayBuffer());assert.equal(f.controller.getPlaybackState().local?.phase,'PLAYING');assert.equal(f.registry.getLocal((f.controller as any).activeToken)?.lease.state,'ACTIVE');
 const events:unknown[]=[];const publisher=createPlaybackEventPublisher(e=>events.push(e),{protocol:'compact-v1'});publisher(playing,{generation:1,kind:'full'});assert.ok(events.every(e=>validateIpcEvent(e).ok));assert.ok(!JSON.stringify(playing).includes(f.media));assert.ok(!JSON.stringify(playing).includes('controlled-session'));
});
test('006延迟A capture期间受理B，A零SDK派发、只B生效，合法追加不继承旧runningCommand',async t=>{
 const f=await fixture(t);let release!:()=>void;f.setGate(new Promise<void>(resolve=>release=resolve));
 const a=f.controller.playLocal(f.request(0));void a.catch(()=>undefined);await eventually(()=>f.captures()===1,'A进入Owner捕获');const b=f.controller.playLocal(f.request(1));release();f.setGate();
 await assert.rejects(a);await eventually(()=>f.sessions.length===1,'只有B开始会话');f.sessions[0]!('SessionBegan',{session_id:'only-B'});await b;assert.equal(f.sends.length,1);assert.equal(f.controller.getPlaybackState().currentTrack?.id,f.requests[1]!.local_track_id);
 await f.controller.stop();await f.controller.playLocal(f.request(0,'APPEND_MB_QUEUE'));assert.equal(f.controller.getPlaybackState().queue.items.length,2);
});
test('006已发送begin超时为UNKNOWN；晚确认仅调和本attempt，重复请求不重发begin/play/queue',async t=>{
 const f=await fixture(t,15),req=f.request();await f.controller.playLocal(req);assert.equal(f.controller.getPlaybackState().local?.phase,'SUBMISSION_UNKNOWN');assert.equal(f.sessions.length,1);assert.equal(f.sends.length,0);
 await f.controller.playLocal(req);assert.equal(f.sessions.length,1);f.sessions[0]!('SessionBegan',{session_id:'late-current'});await tick();assert.equal(f.controller.getPlaybackState().local?.phase,'PLAYING');assert.equal(f.sends.length,1);
 f.sessions[0]!('SessionBegan',{session_id:'duplicate'});assert.equal(f.sends.length,1);
});
test('006A晚回报只清A；B当前Playing不会被旧SessionEnded/Playing覆盖或停止',async t=>{
 const f=await fixture(t);await f.start(0);await f.start(1);const before=f.controller.getPlaybackState();
 f.sessions[0]!('SessionEnded',{});f.plays[0]!('Playing',{});await tick();assert.equal(f.controller.getPlaybackState().currentTrack?.id,before.currentTrack?.id);assert.equal(f.controller.getPlaybackState().local?.attempt_id,before.local?.attempt_id);assert.equal(f.controller.getPlaybackState().local?.phase,'PLAYING');
});
test('006相同owner的SQL撤销后晚Session/Playing安全收自有资源，不抛异步异常且不global stop',async t=>{
 const f=await fixture(t),req=f.request(),work=f.controller.playLocal(req);await eventually(()=>f.sessions.length===1,'begin sent');
 f.repository.localCatalog.selectAsset({commandId:randomUUID(),trackId:req.local_track_id,expectedSelectionRevision:'1',assetId:req.asset_id});
 assert.doesNotThrow(()=>f.sessions[0]!('SessionBegan',{session_id:'stale-facts'}));await assert.rejects(work);await eventually(()=>f.pool.resourceSnapshot().openLeases===0,'已join固定FD');assert.equal(f.sends.length,0);assert.equal(f.controls(),0);
});
test('006Core断连只失去本地所有权，停止不碰无关Zone Transport',async t=>{
 const f=await fixture(t);await f.start();f.unpair();await tick();assert.equal(f.controller.getPlaybackState().local?.phase,'OWNERSHIP_LOST');await f.controller.stop();assert.equal(f.controls(),0);await eventually(()=>f.pool.resourceSnapshot().openLeases===0,'断连FD静止');
});
test('006暂停/续播/seek复用原Adapter且只确认session续租，Core退出封票并join FD',async t=>{
 const f=await fixture(t);await f.start();const pause=f.controller.pause();await tick();f.plays[0]!('Paused',{});f.zoneCallback('Changed',{zones_changed:[{zone_id:'synthetic-zone',state:'paused',outputs:[{output_id:'synthetic-output'}],is_pause_allowed:true,is_play_allowed:true,is_seek_allowed:true,now_playing:{seek_position:0}}]});await pause;assert.equal(f.controller.getPlaybackState().local?.phase,'PAUSED');const resume=f.controller.resume();await tick();f.plays[0]!('Playing',{});f.zoneCallback('Changed',{zones_changed:[{zone_id:'synthetic-zone',state:'playing',outputs:[{output_id:'synthetic-output'}],is_pause_allowed:true,is_play_allowed:true,is_seek_allowed:true,now_playing:{seek_position:0}}]});await resume;const seek=f.controller.seek(500);await tick();f.zoneCallback('Changed',{zones_changed:[{zone_id:'synthetic-zone',state:'playing',outputs:[{output_id:'synthetic-output'}],is_pause_allowed:true,is_play_allowed:true,is_seek_allowed:true,now_playing:{seek_position:0.5}}]});await seek;assert.equal(f.sessions.length,1);
 await f.controller.shutdown();assert.equal(f.pool.resourceSnapshot().openLeases,0);assert.equal(f.tickets.size,0);assert.ok(f.ends()>0);
});

test('006整文件边界：CUE/segment显式unsupported，零FD与SDK派发',async t=>{
 const f=await fixture(t),request=f.request();const {LocalSourcePreparationError}=await import('../../src/application/local-source-resolver.js');t.mock.method(f.tickets,'capture',()=>{throw new LocalSourcePreparationError('SEGMENT_UNSUPPORTED');});
 assert.deepEqual(await f.controller.playLocal(request),{status:'unsupported',reason:'LOCAL_SEGMENT_UNSUPPORTED'});assert.equal(f.sessions.length,0);assert.deepEqual(f.pool.resourceSnapshot(),{openLeases:0,reservations:0});
});

for(const change of ['分组改变','Zone移除'] as const)test(`006${change}同步暂停后续本地派发、join自有FD且不global stop`,async t=>{
 const f=await fixture(t);await f.start();const before=f.sends.length;
 f.zoneCallback('Changed',change==='分组改变'?{zones_changed:[{zone_id:'synthetic-zone',outputs:[{output_id:'different-output'}]}]}:{zones_removed:['synthetic-zone']});
 await eventually(()=>f.pool.resourceSnapshot().openLeases===0,'目标变化已join自有FD');assert.equal(f.controls(),0);assert.equal(f.sends.length,before);assert.equal(f.controller.getPlaybackState().local?.phase,'OWNERSHIP_LOST');
});
test('006当前SessionEnded终结自有来源，不因外部会话终态自动开始MB下一首',async t=>{
 const f=await fixture(t);await f.start();await f.controller.playLocal(f.request(1,'APPEND_MB_QUEUE'));f.sessions[0]!('SessionEnded',{});
 await eventually(()=>f.pool.resourceSnapshot().openLeases===0,'终态FD已join');assert.equal(f.sessions.length,1);assert.equal(f.sends.length,1);assert.equal(f.controls(),0);assert.equal(f.controller.getPlaybackState().local?.phase,'ENDED');
});

for(const event of ['MediaError','StoppedUser','主动Stop'] as const)test(`006同attempt ${event}先投有限终态，再join资源，不能残留PLAYING/MB_OWNED`,async t=>{
 const f=await fixture(t);await f.start();const attempt=f.controller.getPlaybackState().local!.attempt_id;
 if(event==='主动Stop')await f.controller.stop();else f.plays[0]!(event,{});
 await eventually(()=>f.pool.resourceSnapshot().openLeases===0,'终态资源已join');const state=f.controller.getPlaybackState();assert.equal(state.local?.attempt_id,attempt);assert.equal(state.local?.phase,event==='MediaError'?'FAILED':'CANCELLED');assert.equal(state.local?.ownership,'NONE');assert.equal(state.local?.error_code,event==='MediaError'?'ROON_MEDIA_ERROR':null);assert.equal(validateIpcEvent({version:1,event:'playback.changed',payload:{state}}).ok,true);
});
test('006真实fixedFD prepare观察不匹配明确FAILED，未派发不伪UNKNOWN',async t=>{
 const f=await fixture(t),prepare=f.pool.prepare.bind(f.pool);t.mock.method(f.pool,'prepare',async(...args:Parameters<typeof prepare>)=>{await writeFile(path.join(f.media,args[0].facts.relative),Buffer.from('controlled replacement after trusted capture'));return prepare(...args);});
 await assert.rejects(f.controller.playLocal(f.request()));assert.equal(f.sessions.length,0);assert.equal(f.controller.getPlaybackState().local?.phase,'FAILED');assert.equal(f.controller.getPlaybackState().local?.ownership,'NONE');assert.ok(f.controller.getPlaybackState().local?.error_code);assert.equal(f.pool.resourceSnapshot().openLeases,0);
});
for(const change of ['删除再添加','分组改回'] as const)test(`006延迟capture跨目标${change}旧资格永不复活、零SDK派发`,async t=>{
 const f=await fixture(t);let release!:()=>void;f.setGate(new Promise<void>(resolve=>release=resolve));const work=f.controller.playLocal(f.request());void work.catch(()=>undefined);await eventually(()=>f.captures()===1,'已捕获目标、Owner读取等待');
 if(change==='删除再添加')f.zoneCallback('Changed',{zones_removed:['synthetic-zone']});else f.zoneCallback('Changed',{zones_changed:[{zone_id:'synthetic-zone',outputs:[{output_id:'other-output'}]}]});
 f.zoneCallback('Changed',{zones_added:[{zone_id:'synthetic-zone',outputs:[{output_id:'synthetic-output'}]}]});release();f.setGate();await assert.rejects(work);assert.equal(f.sessions.length,0);assert.equal(f.sends.length,0);
});
test('006延迟capture跨无关Zone和普通state/seek回报仍可派发，不采用全局zone stamp',async t=>{
 const f=await fixture(t);let release!:()=>void;f.setGate(new Promise<void>(resolve=>release=resolve));const work=f.controller.playLocal(f.request());await eventually(()=>f.captures()===1,'Owner读取等待');
 f.zoneCallback('Changed',{zones_added:[{zone_id:'unrelated-zone',outputs:[{output_id:'unrelated-output'}]}],zones_changed:[{zone_id:'synthetic-zone',outputs:[{output_id:'synthetic-output'}],state:'paused'}],zones_seek_changed:[{zone_id:'synthetic-zone',seek_position:2}]});release();f.setGate();await eventually(()=>f.sessions.length===1,'当前目标仍准入');f.sessions[0]!('SessionBegan',{session_id:'after-safe-time-report'});await work;assert.equal(f.sends.length,1);
});

async function nativeContext(t:test.TestContext){
 const values:RoonPlaybackContextItem[]=Array.from({length:6},(_,i)=>{const reference=`musicbridge-v2-entity-${(i+1).toString(16).padStart(8,'0')}-1111-4111-8111-111111111111`,track={id:roonTrackIdFromReference(reference),title:`合成native${i}`,artists:['合成'],album:'合成',durationMs:120000};return {reference,zoneId:'synthetic-zone',track,roonItem:{kind:'track',reference,title:track.title,artist:'合成',album:'合成',durationMs:120000}};});
 const nativePlays:string[]=[];const native:NonNullable<ConstructorParameters<typeof BridgeController>[0]['roonLibrary']>={async play(reference,zoneId,track,options){nativePlays.push(reference);options?.onDispatch?.();options?.onDispatchCompletion?.(Promise.resolve());return {zoneId,revision:nativePlays.length,state:'playing',positionMs:0,nowPlaying:{title:track.title,artist:track.artists[0]!,album:track.album,durationMs:120000}};},async stop(){},async pause(){},async resume(){}};
 const f=await fixture(t,500,native);let release!:()=>void,releases=0,reads=0;const gate=new Promise<void>(resolve=>release=resolve);const page=(offset:number,limit:number):RoonPlaybackContextPage=>({items:values.slice(offset,offset+limit),offset,nextOffset:Math.min(6,offset+limit),complete:offset+limit>=6});
 const lease:RoonPlaybackContextLease={initial:{...page(2,2),selectedIndex:0},isCurrent:()=>releases===0,async read(request){reads++;await gate;return page(request.offset,request.limit);},release(){releases++;}};await f.controller.replaceRoonContext(lease);await eventually(()=>reads===1,'实际native邻页在途');return {...f,nativePlays,release,releases:()=>releases,values};
}
test('006实际native分页context→本地PLAY_NOW受理即撤旧lease，在途旧页不覆盖local队列',async t=>{
 const f=await nativeContext(t),work=f.controller.playLocal(f.request());void work.catch(()=>undefined);
 try{assert.equal(f.releases(),1);await eventually(()=>f.sessions.length===1,'本地唯一begin');f.sessions[0]!('SessionBegan',{session_id:'local-after-native'});await work;f.release();await tick();assert.equal(f.controller.getPlaybackState().queue.context,undefined);assert.equal(f.controller.getPlaybackState().queue.items.length,1);assert.equal(f.controller.getPlaybackState().source,'local_file');await f.controller.next();await f.controller.previous();assert.equal(f.nativePlays.length,1);assert.equal(f.controller.getPlaybackState().queue.items[0]!.local?.local_track_id,f.requests[0]!.local_track_id);}
 finally{f.release();await work.catch(()=>undefined);}
});
for(const action of ['APPEND_MB_QUEUE','PLAY_NEXT_MB_QUEUE'] as const)test(`006实际native分页context→local ${action}先完整物化保序，不绕过既有分页编辑`,async t=>{
 const f=await nativeContext(t);let settled=false;const work=f.controller.playLocal(f.request(0,action));void work.then(()=>settled=true,()=>settled=true);await tick();await tick();
 try{assert.equal(settled,false,'原分页尚在途，编辑不能抢先承诺');f.release();await work;const queue=f.controller.getPlaybackState().queue;assert.equal(queue.items.length,7);assert.equal(queue.index,2);assert.equal(queue.items[action==='APPEND_MB_QUEUE'?6:3]!.trackId,f.requests[0]!.local_track_id);assert.equal(f.nativePlays.length,1);assert.equal(f.sessions.length,0);assert.equal(queue.context?.afterComplete,true);}
 finally{f.release();await work.catch(()=>undefined);}
});
