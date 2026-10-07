import assert from 'node:assert/strict';
import test from 'node:test';
import { validateIpcRequest, validateIpcResponseForCommand } from '../../src/validator.js';
import type { IpcCommand } from '../../src/ipc.js';
import {isLocalLibraryQueryPage,isLocalLibraryTrackDetail} from '../../src/local-catalog.js';
const id = '11111111-1111-4111-8111-111111111111';
const request = (payload: unknown, command = 'localCatalog.queryTracks') => validateIpcRequest({ version: 1, id, command, payload, expectedDatasetId: id });
test('009有界搜索接受中文、字面通配符及256码点，分页不改旧合同', () => {
  for (const query of ['', '天空 %_\' OR 1=1 --', '曲'.repeat(256)]) assert.equal(request({ query, rootId: null, offset: 0, limit: 200 }).ok, true);
});
test('009搜索拒绝越界文本、分页、未知和隐藏私有字段', () => {
  const base = { query: '', rootId: null, offset: 0, limit: 100 };
  for (const payload of [{ ...base, query: '曲'.repeat(257) }, { ...base, limit: 201 }, { ...base, offset: -1 }, { ...base, path: '/private' }, Object.defineProperty({ ...base }, 'url', { value: 'private' })]) assert.equal(request(payload).ok, false);
});
test('009单项详情只接受逻辑曲目身份', () => {
  assert.equal(request({ trackId: id }, 'localCatalog.trackDetail').ok, true);
  assert.equal(request({ trackId: id, assetId: id }, 'localCatalog.trackDetail').ok, false);
});
test('009当前播放目标是nullable闭集，仅core与zone', () => {
  assert.equal(request({}, 'playback.localTarget').ok, true);
  for (const result of [null, { core_id: 'core', zone_id: 'zone' }]) assert.equal(validateIpcResponseForCommand({ version: 1, id, ok: true, result }, 'playback.localTarget' as IpcCommand).ok, true);
  for (const result of [{ core_id: 'core', zone_id: 'zone', session_id: 'private' }, { core_id: '', zone_id: 'zone' }]) assert.equal(validateIpcResponseForCommand({ version: 1, id, ok: true, result }, 'playback.localTarget' as IpcCommand).ok, false);
});
test('009结果投影拒绝稀疏页、隐藏参数路径与不一致生效信息',()=>{
 const track={id,assetId:id,selectionRevision:'1',segment:null},asset={id,libraryRootId:id,sourceRootId:id,rootRevision:'1',fileRevision:'1',locationRevision:'1',sampleFrames:null,timebaseHz:null},metadata={title:'原始'},summary={track,asset,metadata,versionTokens:[]};
 const page={query:'',rootId:null,offset:0,limit:100,total:1,hasMore:false,items:[summary]};assert.equal(isLocalLibraryQueryPage(page),true)
 const sparse:any[]=new Array(1);(sparse as any).path='禁止';assert.equal(isLocalLibraryQueryPage({...page,items:sparse}),false)
 const detail={track,asset,metadata:{raw:metadata,override:null,effective:metadata},editions:[],versionTokens:[],fileParameters:null};assert.equal(isLocalLibraryTrackDetail(detail),true);assert.equal(isLocalLibraryTrackDetail({...detail,metadata:{...detail.metadata,effective:{title:'假信息'}}}),false)
 const parameters={container:'WAVE',codec:'PCM',lossless:true,sampleRateHz:48000,channels:2,bitsPerSample:16,durationMs:null,evidence:'bounded-parser-reported'};assert.equal(isLocalLibraryTrackDetail({...detail,fileParameters:Object.defineProperty(parameters,'path',{value:'/禁止私有'})}),false)
});
