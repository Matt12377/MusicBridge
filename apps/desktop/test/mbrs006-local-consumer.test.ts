import assert from 'node:assert/strict';
import test from 'node:test';
import type {PlaybackSnapshot,TypedIpcEvent} from '@music-bridge/contracts';
import {validateIpcEvent} from '@music-bridge/contracts';
import type {MusicBridgePublicApi} from '../src/preload/api.js';
import {usePlaybackSession} from '../src/renderer/src/composables/application/usePlaybackSession.js';
import {projectPlaybackSnapshot} from '../src/renderer/src/composables/application/playbackSnapshot.js';
import {createPlaybackEventPublisher} from '../../../packages/bridge-core/src/application/playback-event-publisher.js';
import {snapshot} from '../../../packages/contracts/test/mbrs006/fixture.js';
const local='local-safe-uuid';
test('006实际compact publisher→validator→Renderer session：local身份不触云歌词/收藏/最近数字重播',async t=>{
 let cloud=0,likes=0,replays=0;const errors:unknown[]=[],events:TypedIpcEvent[]=[];
 const api={getLyrics:async()=>{cloud++;throw new Error('本地不得走云歌词');},getTrackLikeStatus:async()=>{likes++;throw new Error('本地不得查云收藏');},likeTrack:async()=>{likes++;throw new Error('本地不得写云收藏');},play:async()=>{replays++;throw new Error('本地不得数字重播');}} as unknown as MusicBridgePublicApi;
 const session=usePlaybackSession({api,getSelectedZone:()=>({zoneId:'zone-safe',displayName:'合成',selected:true}),getZoneLifecycleStatus:()=> 'selected',getSelectedQuality:()=> 'auto',getMatchResult:()=>undefined,getPendingMatch:()=>undefined,onMatchTracks:()=>{},getRoonPlaybackContext:()=>undefined,resolveFavoriteDescriptor:()=>{throw new Error('本地无Roon描述符，不可进入native收藏');},onEnterNowPlaying:()=>{},clearActionError:()=>{},onActionMessage:()=>{},onError:e=>errors.push(e),onToast:()=>{}});t.after(()=>session.dispose());
 const publisher=createPlaybackEventPublisher(event=>{events.push(event);assert.equal(validateIpcEvent(event).ok,true);if(event.event==='playback.snapshot'||event.event==='playback.state'||event.event==='playback.progress')session.acceptPlaybackStreamEvent(event);},{protocol:'compact-v1'});
 session.acceptPlaybackReady(publisher.getProtocol()!);publisher(snapshot(),{generation:1,kind:'full'});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(session.currentTrack.value?.id,local);assert.equal(session.playbackSource.value,'local_file');assert.equal(session.recentTracks.value.length,0);await session.toggleTrackLike();assert.equal(cloud,0);assert.equal(likes,0);assert.equal(replays,0);assert.deepEqual(errors,[]);
 const next=snapshot();next.local!.delivery_state='BYTES_SENT';publisher(next,{generation:1,kind:'full'});assert.equal(session.playbackState.value?.local?.delivery_state,'BYTES_SENT');assert.equal(session.playbackState.value?.local?.quality.http_bytes,'NOT_TESTED');assert.ok(events.length>=2);
});
test('006Renderer结构共享：只有身份叶或selection修订改变也必须投影新事实',()=>{
 const a=snapshot(),b=structuredClone(a);b.local!.session_epoch='new-opaque';const changed=projectPlaybackSnapshot(a,b);assert.notEqual(changed,a);assert.equal(changed.local!.session_epoch,'new-opaque');
 const c=structuredClone(b);c.queue.items[0]!.local!.selection_revision='5';assert.notEqual(projectPlaybackSnapshot(b,c).queue,b.queue);
});

test('006Main/preload固定三动作点播：scope与九字段保留，path/URL/session/隐藏键在发送前拒绝',async()=>{
 const {createLocalLibraryClient}=await import('../src/preload/local-library-client.js'),{installLocalLibraryHandlers}=await import('../src/main/local-library-ipc.js');const calls:unknown[]=[],datasetId='11111111-1111-4111-8111-111111111111',handlers=new Map<string,(event:{trusted:boolean},value?:unknown)=>unknown>();
 installLocalLibraryHandlers({handle:(name,handler)=>handlers.set(name,handler),requireTrusted:(e:{trusted:boolean})=>{if(!e.trusted)throw new Error('不可信Renderer');},supervisor:{request:async(command:any,payload:any,scope:any)=>{calls.push({command,payload,scope});return {status:'accepted',request_id:payload.request_id,action:payload.action};},requestInternal:async()=>{throw new Error('点播不可调用内部路径入口');}} as any,pick:async()=>{throw new Error('点播不弹picker');}});
 const client=createLocalLibraryClient(async(channel,value)=>handlers.get(channel)!({trusted:true},value),async()=>datasetId,{chooseRoot:async()=>null,confirm:async()=>{throw new Error('无源写');},relink:async()=>{throw new Error('无源写');}}),base={schema_version:'1.2',request_id:'public-request',route:'roon_audio_input',source_kind:'local_file',local_track_id:'local-safe',asset_id:'asset-safe',expected_asset_revision:'1',target:{core_id:'core-safe',zone_id:'zone-safe'},action:'PLAY_NOW'} as const;
 for(const action of ['PLAY_NOW','APPEND_MB_QUEUE','PLAY_NEXT_MB_QUEUE'] as const){const request={...base,request_id:action,action};assert.deepEqual(await client.playLocalLibraryTrack(request),{status:'accepted',request_id:action,action});}
 assert.equal(calls.length,3);for(const name of ['path','url','session_id'])await assert.rejects(client.playLocalLibraryTrack({...base,[name]:'private'}));
 await assert.rejects(client.playLocalLibraryTrack(Object.defineProperty({...base},'path',{value:'/private',enumerable:false})));await assert.rejects(async()=>handlers.get('localLibrary:request')!({trusted:false},{datasetId,command:'localCatalog.prepare',payload:base}));assert.equal(calls.length,3);
});
