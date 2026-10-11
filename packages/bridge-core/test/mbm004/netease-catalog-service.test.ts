import assert from 'node:assert/strict';
import test from 'node:test';
import type { MobileTrack, MobileTrackSelection } from '@music-bridge/contracts';
import { createMobileNeteaseCatalogService } from '../../src/mobile/netease-catalog-service.js';
import type { MobileContentScope } from '../../src/mobile/content-types.js';
import type { MobileNeteaseCatalogPort } from '../../src/mobile/netease-source-types.js';
import { MobileServiceError } from '../../src/mobile/types.js';
import { createMobileNeteaseAccountMapper, captureMobileNeteaseSongSnapshot } from '../../src/netease/mobile-source-snapshot.js';

const scope: MobileContentScope={serverId:'server-1',datasetId:'dataset-1',deviceId:'device-1',deviceEpoch:1,accessGeneration:1,ownerEpoch:'owner-1',accountDomain:'account-1',providerEpoch:'epoch-1'};
const selection: MobileTrackSelection={trackId:'nt-1',source:'netease',versionId:'version-1',contentRevision:'content-1'};
const track: MobileTrack={id:'nt-1',source:'netease',sourceItemId:'song-1',albumId:'na-1',title:'同名合成曲',artists:['合成艺人'],versionId:'version-1',contentRevision:'content-1',editionLabel:'原发行',durationMs:1000,
  audio:{codec:'flac',container:'flac',sampleRateHz:192000,bitsPerSample:24,channels:2},availability:'available'};
function fixture(qualified=true){let active=true;const port:MobileNeteaseCatalogPort={async track(){return{account:{accountDomain:'account-1',providerEpoch:'epoch-1'},track:structuredClone(track)};},async album(){return{account:{accountDomain:'account-1',providerEpoch:'epoch-1'},album:{id:'na-1',source:'netease',title:'合成专辑',artists:['合成艺人'],editionLabel:'原发行',trackCount:1}};}};
 const service=createMobileNeteaseCatalogService({port,async assertCurrent(){if(!active)throw new MobileServiceError(409,'SOURCE_CHANGED');},playbackQualified:()=>qualified});return{service,port,change:()=>{active=false;}};}
test('精确网易云身份保留 sourceItem/version/revision/album 与 24/192 事实',async()=>{
 const f=fixture(),value=await f.service.resolveTrack(scope,selection,new AbortController().signal);
 assert.deepEqual(JSON.parse(JSON.stringify(value)),track);assert.ok(Object.isFrozen(value));
 const album=await f.service.resolveAlbum(scope,'na-1',new AbortController().signal);assert.equal(album.id,value.albumId);assert.equal(album.source,'netease');
});
test('同名不能替代来源/发行修订，旧 version 与新 content 明确拒绝',async()=>{
 const f=fixture();f.port.track=async()=>({account:{accountDomain:'account-1',providerEpoch:'epoch-1'},track:{...track,versionId:'version-2'}});
 await assert.rejects(f.service.resolveTrack(scope,selection,new AbortController().signal),(e:unknown)=>e instanceof MobileServiceError&&e.code==='SOURCE_CHANGED');
 await assert.rejects(f.service.resolveTrack(scope,{...selection,source:'local'},new AbortController().signal),(e:unknown)=>e instanceof MobileServiceError&&e.code==='INVALID_REQUEST');
});
test('跨账户及迟到撤销拒绝，不将 Provider 凭据扩展带到公开 Track',async()=>{
 const f=fixture();f.port.track=async()=>({account:{accountDomain:'account-2',providerEpoch:'epoch-1'},track});
 await assert.rejects(f.service.resolveTrack(scope,selection,new AbortController().signal),(e:unknown)=>e instanceof MobileServiceError&&e.code==='SOURCE_CHANGED');
 const g=fixture();g.port.track=async()=>{g.change();return{account:{accountDomain:'account-1',providerEpoch:'epoch-1'},track};};
 await assert.rejects(g.service.resolveTrack(scope,selection,new AbortController().signal));
 const h=fixture();h.port.track=async()=>({account:{accountDomain:'account-1',providerEpoch:'epoch-1'},track:{...track,upstreamUrl:'https://private.invalid'} as MobileTrack});
 await assert.rejects(h.service.resolveTrack(scope,selection,new AbortController().signal));
});
test('未接真实播放资格只投影 unavailable，缺音频事实不能伪造 available',async()=>{
 const f=fixture(false);const result=await f.service.resolveTrack(scope,selection,new AbortController().signal);assert.equal(result.availability,'unavailable');assert.deepEqual(JSON.parse(JSON.stringify(result.audio)),track.audio);
 const g=fixture();g.port.track=async()=>({account:{accountDomain:'account-1',providerEpoch:'epoch-1'},track:{...track,audio:{codec:'flac',container:'flac'}}});
 await assert.rejects(g.service.resolveTrack(scope,selection,new AbortController().signal));
});
test('取消、可执行 metadata getter 与超长标签拒绝且不执行 getter',async()=>{
 const f=fixture(),controller=new AbortController();controller.abort();await assert.rejects(f.service.resolveTrack(scope,selection,controller.signal));
 let calls=0;const raw={...track};Object.defineProperty(raw,'title',{enumerable:true,get(){calls++;return '不应调用';}});
 f.port.track=async()=>({account:{accountDomain:'account-1',providerEpoch:'epoch-1'},track:raw});
 await assert.rejects(f.service.resolveTrack(scope,selection,new AbortController().signal));assert.equal(calls,0);
 f.port.track=async()=>({account:{accountDomain:'account-1',providerEpoch:'epoch-1'},track:{...track,title:'字'.repeat(2000)}});await assert.rejects(f.service.resolveTrack(scope,selection,new AbortController().signal));
});
test('真实 account ID 稳定映射共享域，代际/库隔离且显示名不能替代 ID',()=>{
 const options={serverId:'server-1',datasetId:'dataset-1',key:new Uint8Array(32).fill(3)},mapper=createMobileNeteaseAccountMapper(options);
 const a=mapper.capture('123456','epoch-1'),b=mapper.capture(123456,'epoch-2');assert.equal(a.accountDomain,b.accountDomain);assert.notEqual(a.providerEpoch,b.providerEpoch);
 options.serverId='changed-server';options.datasetId='changed-dataset';options.key.fill(9);assert.equal(a.accountDomain,mapper.capture('123456','epoch-1').accountDomain);
 assert.notEqual(a.accountDomain,mapper.capture('123457','epoch-1').accountDomain);
 assert.notEqual(a.accountDomain,createMobileNeteaseAccountMapper({serverId:'server-1',datasetId:'dataset-2',key:new Uint8Array(32).fill(3)}).capture('123456','epoch-1').accountDomain);
 assert.throws(()=>mapper.capture('显示名','epoch-1'));assert.throws(()=>mapper.capture(9007199254740992,'epoch-1'));assert.throws(()=>mapper.capture('0123456','epoch-1'));
});
test('raw song_detail 只使用真实 id/ar/al/dt，缺字段不造 Unknown 元数据或 URL 身份',()=>{
 const binding={account:{accountDomain:'account-1',providerEpoch:'epoch-1'},selection,sourceItemId:'123',albumId:'na-1',providerAlbumId:'456',editionLabel:'原发行',
  observed:{audio:track.audio,contentType:'audio/flac' as const,size:1000,durationMs:1000,headerSha256:'a'.repeat(64)},availability:'available' as const};
 const song={id:123,name:'真实合成名称',ar:[{id:111,name:'真实合成艺人'}],al:{id:456,name:'真实合成专辑',picUrl:'https://private.invalid/art'},dt:1000};
 const facts=captureMobileNeteaseSongSnapshot(song,binding);assert.equal(facts.track.sourceItemId,'123');assert.equal(facts.track.albumId,'na-1');assert.equal(facts.track.title,song.name);assert.ok(!JSON.stringify(facts).includes('private.invalid'));
 assert.throws(()=>captureMobileNeteaseSongSnapshot({...song,al:{name:'同名专辑'}},binding));assert.throws(()=>captureMobileNeteaseSongSnapshot({...song,ar:[]},binding));
 assert.throws(()=>captureMobileNeteaseSongSnapshot({...song,id:124},binding));assert.throws(()=>captureMobileNeteaseSongSnapshot({...song,dt:2001},binding));
});
test('FLAC 毫秒量化小差采用实际样本时长，大差拒绝；MP3 仅保留可信 song.dt',()=>{
 const binding={account:{accountDomain:'account-1',providerEpoch:'epoch-1'},selection,sourceItemId:'123',albumId:'na-1',providerAlbumId:'456',editionLabel:'原发行',
  observed:{audio:track.audio,contentType:'audio/flac' as const,size:1000,durationMs:1000,headerSha256:'a'.repeat(64)},availability:'available' as const};
 const song={id:123,name:'合成曲',ar:[{id:1,name:'合成艺人'}],al:{id:456},dt:2000};
 const exact=captureMobileNeteaseSongSnapshot(song,binding);assert.equal(exact.track.durationMs,1000);assert.deepEqual(exact.track.audio,track.audio);
 assert.throws(()=>captureMobileNeteaseSongSnapshot({...song,dt:2001},binding),(e:unknown)=>e instanceof MobileServiceError&&e.code==='SOURCE_CHANGED');
 const mp3=captureMobileNeteaseSongSnapshot(song,{...binding,observed:{audio:{codec:'mp3',container:'mp3',sampleRateHz:44100,channels:2,bitrateKbps:128},contentType:'audio/mpeg',size:1000,durationMs:null,headerSha256:'a'.repeat(64)}});
 assert.equal(mp3.track.durationMs,2000);assert.equal(mp3.track.audio.bitsPerSample,undefined);
 assert.throws(()=>captureMobileNeteaseSongSnapshot(song,{...binding,observed:{...binding.observed,audio:{...track.audio,upstreamUrl:'https://private.invalid'} as typeof track.audio}}));
});
