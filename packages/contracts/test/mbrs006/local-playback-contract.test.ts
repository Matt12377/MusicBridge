import assert from 'node:assert/strict';
import test from 'node:test';
import {validateIpcEvent,validateIpcRequest,validateIpcResponseForCommand} from '../../src/validator.js';
import {snapshot} from './fixture.js';
import {isLocalPlayRequest} from '../../src/index.js';
// 行为验证只消费真实validator；不新增只重复DTO赋值的测试。
test('006公开local事件必须完整leaf+track/asset身份，UUID不会放宽网易云或通用队列数字合同',()=>{
 const state=snapshot(),event=(s:unknown)=>({version:1,event:'playback.changed',payload:{state:s}});
 assert.equal(validateIpcEvent(event(state)).ok,true);
 for(const bad of [{...state,local:undefined},{...state,currentTrack:{...state.currentTrack!,id:'other-local'}},{...state,source:'netease',local:undefined}, {...state,queue:{...state.queue,items:[{...state.queue.items[0],local:undefined}]}}, {...state,local:{...state.local,session_id:'private-session'}}])assert.equal(validateIpcEvent(event(bad)).ok,false);
 assert.equal(validateIpcRequest({version:1,id:'r',command:'playback.play',payload:{trackId:state.currentTrack!.id,qualityPreference:'auto'}}).ok,false);
});
test('006本地ACK闭集仅回受理身份，不回path/URL/session/SAB或伪Playing',()=>{
 const response=(result:unknown)=>({version:1,id:'r',ok:true,result});const ack={status:'accepted',request_id:'safe-request',action:'PLAY_NOW'};
 assert.equal(validateIpcResponseForCommand(response(ack),'localCatalog.prepare').ok,true);
 for(const extra of ['path','media_url','session_id','buffer','phase'])assert.equal(validateIpcResponseForCommand(response({...ack,[extra]:'private'}),'localCatalog.prepare').ok,false);
 assert.equal(validateIpcResponseForCommand(response({status:'unsupported',reason:'LOCAL_PLAYBACK_PROTOCOL_UNSUPPORTED'}),'localCatalog.prepare').ok,true);
});

test('LP950 普通专辑选择兼容原九字段且闭核整组身份，不接收成员页路径或队列能力',()=>{
 const local=snapshot().local!,request={schema_version:'1.2',request_id:local.request_id,route:'roon_audio_input',source_kind:'local_file',local_track_id:local.local_track_id,
  asset_id:local.asset_id,expected_asset_revision:local.asset_revision,target:{...local.target},action:'PLAY_NOW'};
 const album={datasetId:'95000000-0000-4000-8000-000000000001',albumKey:'directory:owned-950',rootId:'95000000-0000-4000-8000-000000000002',
  revision:'owned-revision-950',kind:'source-directory',editionId:null,trackCount:3};
 assert.equal(isLocalPlayRequest(request),true);assert.equal(Object.keys(request).length,9);
 assert.equal(isLocalPlayRequest({...request,album}),true);
 assert.equal(isLocalPlayRequest({...request,album:{...album,kind:'edition',editionId:'95000000-0000-4000-8000-000000000003'}}),true);
 for(const invalid of [{...album,trackCount:0},{...album,trackCount:5001},{...album,trackCount:3.5},{...album,datasetId:'not-dataset'},
  {...album,kind:'edition'},{...album,editionId:'95000000-0000-4000-8000-000000000003'},{...album,members:[]},{...album,path:'/private/source'},{...album,canNext:true}])assert.equal(isLocalPlayRequest({...request,album:invalid}),false);
 for(const action of ['APPEND_MB_QUEUE','PLAY_NEXT_MB_QUEUE']){assert.equal(isLocalPlayRequest({...request,action}),true);assert.equal(isLocalPlayRequest({...request,action,album}),false);}
 let getters=0;const accessor={...album};Object.defineProperty(accessor,'revision',{enumerable:true,get(){getters++;return album.revision;}});
 assert.equal(isLocalPlayRequest({...request,album:accessor}),false);assert.equal(getters,0);
 const hidden={...album};Object.defineProperty(hidden,'path',{value:'不得消失的附加键'});assert.equal(isLocalPlayRequest({...request,album:hidden}),false);
});
