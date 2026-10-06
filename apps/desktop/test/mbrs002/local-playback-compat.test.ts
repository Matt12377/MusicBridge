import assert from 'node:assert/strict';
import test from 'node:test';
import { validateIpcEvent, type PlaybackSnapshot, type TypedIpcEvent } from '@music-bridge/contracts';
import { evaluateLocalPlaybackCompatibility, isLocalPlaybackObservationLeaf } from '../../../../packages/contracts/src/local-playback-compat.js';
import { createPlaybackEventPublisher } from '../../../../packages/bridge-core/src/application/playback-event-publisher.js';
import { createPlaybackStreamReducer } from '../../src/renderer/src/composables/application/playbackStreamReducer.js';
import { usePlaybackSession } from '../../src/renderer/src/composables/application/usePlaybackSession.js';
import type { MusicBridgePublicApi } from '../../src/preload/api.js';
function snapshot(source: 'roon' | 'netease', positionMs=12000): PlaybackSnapshot {
  return {state:'playing',source,selectedZoneId:'synthetic-zone',positionMs,
    currentTrack:{id:'1001',title:'合成旧曲',artists:['合成艺人'],album:'合成专辑',durationMs:180000},
    queue:{items:[{trackId:'1001',qualityPreference:'auto',preferredSource:source,resolvedSource:source}],index:0,hasNext:false,hasPrevious:false},
    canNext:false,canPrevious:false,canStop:true,canPause:true,canResume:false};
}
function compactHarness() {
  const reducer=createPlaybackStreamReducer(), events:TypedIpcEvent[]=[], rejected:string[]=[];
  const publisher=createPlaybackEventPublisher(event => {
    const checked=validateIpcEvent(event);
    if (!checked.ok) { rejected.push(event.event); return; }
    events.push(event);
    if (event.event==='playback.snapshot') reducer.full(event.payload);
    else if (event.event==='playback.state') reducer.delta({kind:'state',...event.payload});
    else if (event.event==='playback.progress') reducer.delta({kind:'progress',...event.payload});
  },{protocol:'compact-v1'});
  const ack=publisher.getProtocol(); assert.ok(ack); reducer.authorize(ack.coreInstanceId);
  return {reducer,events,rejected,publisher};
}
function legacyHarness() {
  const errors:unknown[]=[], accepted:TypedIpcEvent[]=[], rejected:string[]=[];
  const api={getLyrics:async()=>({status:'unavailable',lines:[],activeLineIndex:-1,timingSource:'static'}),getTrackLikeStatus:async()=>({liked:false}),checkFavorite:async()=>({favorite:false})} as unknown as MusicBridgePublicApi;
  const session=usePlaybackSession({api,getSelectedZone:()=>({zoneId:'synthetic-zone',displayName:'合成Zone',selected:true,seekAllowed:true}),getZoneLifecycleStatus:()=> 'selected',getSelectedQuality:()=> 'auto',getMatchResult:()=>undefined,getPendingMatch:()=>undefined,onMatchTracks:()=>undefined,getRoonPlaybackContext:()=>undefined,resolveFavoriteDescriptor:()=>{throw new Error('合成无roonItem，不应读取收藏描述符');},onEnterNowPlaying:()=>undefined,clearActionError:()=>undefined,onActionMessage:()=>undefined,onError:e=>errors.push(e),onToast:()=>undefined});
  const publisher=createPlaybackEventPublisher(event=> {
    const checked=validateIpcEvent(event);
    if (!checked.ok) {rejected.push(event.event);return;}
    accepted.push(event);
    if (event.event==='playback.changed') session.acceptPlaybackEvent(event.payload.state);
    // legacy queue.changed仍由原session完整snapshot内queue处理；不送compact reducer。
  });
  return {session,accepted,rejected,errors,publisher};
}
for (const source of ['roon','netease'] as const) {
  test(`MBRS002 B4 compact实际旧链：${source} publisher→validator→reducer全基准进度与暂停`,()=> {
    const h=compactHarness(), initial=snapshot(source);
    h.publisher(initial,{generation:3,kind:'full'});
    assert.equal(h.reducer.snapshot?.source,source); assert.equal(h.reducer.snapshot?.positionMs,12000);
    const queue=h.reducer.snapshot!.queue;
    h.publisher({...initial,positionMs:12500},{generation:3,kind:'position'});
    assert.equal(h.reducer.snapshot?.positionMs,12500); assert.equal(h.reducer.snapshot?.queue,queue);
    h.publisher({...initial,state:'paused',canPause:false,canResume:true,positionMs:12500},{generation:3,kind:'full'});
    assert.equal(h.reducer.snapshot?.state,'paused'); assert.equal(h.reducer.desynced,false); assert.equal(h.rejected.length,0);
    assert.deepEqual(h.events.map(e=>e.event),['playback.snapshot','playback.progress','playback.state']);
  });
  test(`MBRS002 B4 legacy实际旧consumer：${source} publisher→validator→原session保持来源及非零位置`,()=> {
    const h=legacyHarness();try {
      h.publisher(snapshot(source));
      assert.equal(h.session.playbackState.value?.source,source); assert.equal(h.session.playbackState.value?.positionMs,12000);
      h.publisher({...snapshot(source),state:'paused',canPause:false,canResume:true,positionMs:12500});
      assert.equal(h.session.playbackState.value?.state,'paused'); assert.equal(h.session.playbackState.value?.positionMs,12500);
      assert.equal(h.rejected.length,0); assert.equal(h.publisher.getProtocol(),null);
      assert.deepEqual(h.accepted.map(e=>e.event),['playback.changed','queue.changed','playback.changed','queue.changed']);
    }finally{h.session.dispose();}
  });
}
test('MBRS002 B4 local非法旧compact事件经publisher和validator拒绝，原reducer基准与位置不变',()=> {
  const h=compactHarness();h.publisher(snapshot('roon'),{generation:3,kind:'full'});const baseline=h.reducer.snapshot, stamp=h.reducer.stamp;
  h.publisher({...snapshot('roon'),source:'local_file',positionMs:null} as unknown as PlaybackSnapshot,{generation:4,kind:'full'});
  assert.equal(h.rejected.length,1);assert.equal(h.events.length,1);assert.equal(h.reducer.snapshot,baseline);assert.equal(h.reducer.stamp,stamp);assert.equal(h.reducer.snapshot?.positionMs,12000);
  // publisher本身非guard：拒绝发生在既有validateIpcEvent，不虚称publisher不会emit。
});
test('MBRS002 B4 local非法legacy经publisher和validator拒绝，原session不接假0或本地来源',()=> {
  const h=legacyHarness();try {
    h.publisher(snapshot('netease'));const baseline=h.session.playbackState.value;
    h.publisher({...snapshot('netease'),source:'local_file',positionMs:null} as unknown as PlaybackSnapshot);
    assert.ok(h.rejected.includes('playback.changed'));assert.equal(h.session.playbackState.value,baseline);assert.equal(h.session.playbackState.value?.positionMs,12000);
    for(const positionMs of [null,-1,1.5,Number.MAX_SAFE_INTEGER+1]) assert.equal(validateIpcEvent({version:1,event:'playback.changed',payload:{state:{...snapshot('roon'),positionMs}}}).ok,false);
  }finally{h.session.dispose();}
});
test('MBRS002/006 B4 legacy拒local，compact可用但仅合法身份叶进入现有事件',()=> {
  const leaf={"schema_version": "1.2", "request_id": "synthetic-request", "attempt_id": "synthetic-attempt", "intent_generation": "9007199254740993", "route": "roon_audio_input", "local_track_id": "synthetic-local", "asset_id": "synthetic-asset", "asset_revision": "1", "target": {"core_id": "synthetic-core", "zone_id": "synthetic-zone"}, "session_epoch": null, "phase": "PREPARING", "ownership": "MB_PENDING", "queue_owner": "NONE", "delivery_state": "NOT_STARTED", "roon_observation": {"event": "NONE", "observed": false, "correlation": "UNKNOWN"}, "position_ms": null, "quality": {"http_bytes": "NOT_TESTED", "signal_path": "NOT_TESTED", "digital_output": "NOT_TESTED", "gapless": "NOT_TESTED"}, "error_code": null};
  assert.equal(isLocalPlaybackObservationLeaf(leaf),true);assert.equal(leaf.position_ms,null);
  for(const protocol of ['legacy','compact-v1']) {
    let publisherCalls=0;const publisher=createPlaybackEventPublisher(()=>publisherCalls++,protocol==='compact-v1'?{protocol:'compact-v1'}:{});
    const gate=evaluateLocalPlaybackCompatibility(protocol,'local_file');
    assert.deepEqual(gate,protocol==='legacy'?{supported:false,code:'LOCAL_PLAYBACK_PROTOCOL_UNSUPPORTED'}:{supported:true,protocol:'compact-v1',source:'local_file'});assert.equal(publisherCalls,0);
  }
  assert.equal(validateIpcEvent({version:1,event:'playback.local',payload:leaf}).ok,false);
  assert.equal(leaf.phase,'PREPARING');
  // 此处gate由test显式连接，当前Controller未调用；006实际生产链保持PARTIAL。
});
