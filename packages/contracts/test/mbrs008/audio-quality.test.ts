import assert from 'node:assert/strict';
import test from 'node:test';
import { isFileAudioParameters } from '../../src/audio-quality.js';
import { validateIpcEvent } from '../../src/validator.js';
import { snapshot } from '../mbrs006/fixture.js';
const parameters = {container:'WAVE' as const,codec:'PCM',lossless:true,sampleRateHz:96000,channels:2,bitsPerSample:24,durationMs:1000,evidence:'bounded-parser-reported' as const};
const event=(state:unknown)=>({version:1,event:'playback.changed',payload:{state}});
test('008实际IPC快照消费可选安全文件参数；旧无参数快照保持兼容',()=>{
 const state=snapshot();assert.equal(validateIpcEvent(event(state)).ok,true);assert.equal(validateIpcEvent(event({...state,local:{...state.local,file_parameters:parameters}})).ok,true);
});
test('008安全参数闭合，path/URL/session/token/SAB和未知字段不进入公开快照',()=>{
 const state=snapshot();for(const field of ['path','url','session_id','token','buffer','unknown'])assert.equal(validateIpcEvent(event({...state,local:{...state.local,file_parameters:{...parameters,[field]:field==='buffer'?new SharedArrayBuffer(16):'private'}}})).ok,false);
 for(const codec of ['/Volumes/private.wav','http://secret','secret\\path','PCM\n'])assert.equal(isFileAudioParameters({...parameters,codec}),false);
});
test('008文件参数必须是有限解析事实，24/96不修改四轴未测值',()=>{
 for(const patch of [{sampleRateHz:NaN},{sampleRateHz:0},{sampleRateHz:Infinity},{channels:65},{bitsPerSample:0},{durationMs:-1},{evidence:'bit-perfect'},{container:'DSF'}])assert.equal(isFileAudioParameters({...parameters,...patch}),false);
 assert.equal(isFileAudioParameters({...parameters,bitsPerSample:null,durationMs:null,lossless:null}),true);
 const state=snapshot();assert.equal(validateIpcEvent(event({...state,local:{...state.local,file_parameters:parameters,quality:{...state.local!.quality,bitPerfect:true}}})).ok,false);
});
