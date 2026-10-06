import assert from 'node:assert/strict';
import test from 'node:test';
import {validateIpcEvent,validateIpcRequest,validateIpcResponseForCommand} from '../../src/validator.js';
import {snapshot} from './fixture.js';
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
