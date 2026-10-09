import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyHeaders, encode, exerciseFixture, fixtureJson, loadFreshMobileContracts, loadMobileFixtures, plain, readFixtureBody, responseContext } from './fixture-helpers.js';
import type { MobileReadyResource, MobileResource, MobileResourceSemanticContext } from '../../src/mobile-resource.js';
import type { LocalLibraryTrackDetail } from '../../src/local-catalog.js';
import type { MobileCatalogIdentityBinding } from '../../src/mobile-catalog.js';

const m = await loadFreshMobileContracts('packages/contracts/test/mbm000/audio-resource-state.test.ts');
const fixtures = loadMobileFixtures();
const readyRow = fixtures.cases.find(row => row.id === 'createResource--success-201')!; assert(readyRow);
const ready = fixtureJson<MobileReadyResource>(readyRow.response.body);
const context = responseContext(fixtures,readyRow).resource!;

test('移动资源状态：201仅ready/202仅preparing，GET三状态与nested failure完整消费',() => {
  for (const id of ['createResource--success-201','createResource--success-202','createResource--201-preparing','createResource--202-ready','createResource--201-failed','getResource--failed-resource','getResource--preparing-resource','getResource--ready-with-failure','getResource--preparing-with-failure','getResource--failed-with-media','getResource--ready-no-media','getResource--failed-no-failure']) { const row = fixtures.cases.find(item => item.id === id); assert(row,id); exerciseFixture(m,fixtures,row); }
  const failed = fixtures.cases.find(row => row.id === 'getResource--failed-resource')!; const body = fixtureJson<MobileResource>(failed.response.body); assert.equal(body.state,'failed'); if (body.state === 'failed') { assert.equal(typeof body.failure.error.code,'string'); assert.equal(Object.hasOwn(body.failure,'message'),false); }
});
test('移动FLAC：source/actual三轴独立相等，转换标签与不可seek不能伪装无损',() => {
  assert.equal(m.resource.validateMobileReadyAudio(ready,context.request,context).ok,true);
  for (const axis of ['sampleRateHz','bitsPerSample','channels'] as const) {
    const changed = plain(ready); changed.media.actualAudio[axis] = axis === 'sampleRateHz' ? 48000 : axis === 'bitsPerSample' ? 16 : 1;
    assert.equal(m.resource.validateMobileReadyAudio(changed,context.request,context).ok,false,axis);
    const missing = plain(ready); delete missing.sourceAudio[axis]; assert.equal(m.resource.validateMobileReadyAudio(missing,context.request,{...context,sourceAudio:missing.sourceAudio}).ok,false,`缺${axis}`);
  }
  for (const mode of ['lossy_transcode','resample'] as const) assert.equal(m.resource.validateMobileReadyAudio({...ready,processing:{...ready.processing,mode}},context.request,context).ok,false);
  assert.equal(m.resource.validateMobileReadyAudio({...ready,media:{...ready.media,seekable:false}},context.request,context).ok,false);
  const auto = {...context.request,quality:{...context.request.quality,profile:'auto' as const}}; assert.equal(m.resource.validateMobileReadyAudio(ready,auto,{...context,request:auto}).ok,false);
});
test('移动format组合：不能从另一codec行借rate/channel/bitDepth上限',() => {
  const crossed = {...context.request,formats:[{codec:'alac',container:'m4a',maxSampleRateHz:48000,maxChannels:2},{codec:'aac',container:'mp4',maxSampleRateHz:192000,maxChannels:8}]};
  assert.equal(m.resource.validateMobileReadyAudio(ready,crossed,{...context,request:crossed}).ok,false);
  const enabled:MobileResourceSemanticContext = {...context,resourceFormatBitDepth:true,request:{...context.request,formats:[{...context.request.formats[0]!,maxBitsPerSample:24}]}};
  assert.equal(m.resource.validateMobileReadyAudio(ready,enabled.request,enabled).ok,true);
  const tooShallow = {...enabled.request,formats:[{...enabled.request.formats[0]!,maxBitsPerSample:16}]}; assert.equal(m.resource.validateMobileReadyAudio(ready,tooShallow,{...enabled,request:tooShallow}).ok,false);
  const changedContainer = plain(ready); changedContainer.media.actualAudio.container = 'mp4'; assert.equal(m.resource.validateMobileReadyAudio(changedContainer,context.request,context).ok,false);
});
test('移动资源身份：来源/版本/会话/URLticket/过期实际事实逐一受限',() => {
  for (const id of ['getResource--source-mismatch','getResource--wrong-resource-id','getResource--wrong-session-id','getResource--wrong-version','getResource--media-cross-origin','getResource--media-short-ticket','getResource--media-expired','getResource--media-duplicate-ticket']) { const row = fixtures.cases.find(item => item.id === id); assert(row,id); exerciseFixture(m,fixtures,row); }
  const actual = new URL(ready.media.url), asset = actual.pathname.split('/').at(-1)!;
  const pathUrl = (path:string):string => `${actual.origin}${path}${actual.search}`;
  const traversal = pathUrl(`${actual.pathname.slice(0,actual.pathname.lastIndexOf('/'))}/../${asset}`);
  for (const url of [ready.media.url.replace('https://','http://'),traversal,ready.media.url+'#fragment',ready.media.url.replace('ticket=','token=')]) { assert.notEqual(url,ready.media.url); assert.equal(m.resource.validateMobileReadyAudio({...ready,media:{...ready.media,url}},context.request,context).ok,false); }
  const prefix = actual.pathname.split('/').slice(0,4).join('/'), id = 'resource:1';
  const colon = {...ready,id,media:{...ready.media,url:pathUrl(`${prefix}/${encodeURIComponent(id)}/${asset}`)}};
  const colonContext = {...context,expectedResourceId:id};
  assert.notEqual(colon.media.url,ready.media.url); assert.equal(m.resource.validateMobileReadyAudio(colon,context.request,colonContext).ok,true);
  for (const path of [`${prefix}/resource%253A1/${asset}`,`${prefix}/resource%3A1%2Fother/${asset}`,`${prefix}/${encodeURIComponent(id)}/%2Fmain`,`${prefix}/${encodeURIComponent(id)}/%2E%2E`,`${prefix}/${encodeURIComponent(id)}/other/../${asset}`,`${prefix}/${encodeURIComponent(id)}/%252E%252E`,`${prefix}/${encodeURIComponent(id)}/main%3Fprivate`,`${prefix}/${encodeURIComponent(id)}/%E0%A4`]) { const url = pathUrl(path); assert.notEqual(url,colon.media.url); assert.equal(m.resource.validateMobileReadyAudio({...colon,media:{...colon.media,url}},context.request,colonContext).ok,false); }
  assert.equal(m.resource.validateMobileReadyAudio(ready,context.request,{...context,expectedResourceId:'different.resource'}).ok,false);
});
test('移动媒体：HEAD忽略Range仅200全长零体，GET206/400/416真实元数据闭合',() => {
  const mediaRows = fixtures.cases.filter(row => ['headMediaAsset','getMediaAsset'].includes(row.operationId)); assert(mediaRows.length >= 12); mediaRows.forEach(row => exerciseFixture(m,fixtures,row));
  const full = fixtures.cases.find(row => row.id === 'getMediaAsset--success-200')!; const body = readFixtureBody(full.response.body);
  const bad = m.wire.decodeMobileResponse('getMediaAsset',{status:200,headers:bodyHeaders(full.response.headers,new Uint8Array(body.length-1)),body:new Uint8Array(body.length-1),finalUrl:full.response.finalUrl},responseContext(fixtures,full)); assert.equal(bad.ok,false);
  const head = fixtures.cases.find(row => row.id === 'headMediaAsset--success-200')!;
  assert.equal(m.wire.decodeMobileResponse('headMediaAsset',{status:200,headers:[...head.response.headers,['Content-Range','bytes 0-7/32']],body:new Uint8Array(),finalUrl:head.response.finalUrl},responseContext(fixtures,head)).ok,false);
});
test('移动源映射：纯位置/根修订保ID，file/selection/edition更改必须重新认证',() => {
  // 合成 Owner 已登记详情；只证明 mapper，不把它写成真实目录或音频读证据。
  const detail:LocalLibraryTrackDetail = {track:{id:'track.fixture.1',assetId:'asset.fixture.1',selectionRevision:'1',segment:null},asset:{id:'asset.fixture.1',libraryRootId:'library.fixture.1',sourceRootId:'source.fixture.1',rootRevision:'1',fileRevision:'1',locationRevision:'1',sampleFrames:null,timebaseHz:null},metadata:{raw:{title:'合成曲目'},override:null,effective:{title:'合成曲目'}},versionTokens:[],editions:[{id:'edition.fixture.1',title:'合成专辑',edition:'原版',revision:'1'}],fileParameters:{container:'FLAC',codec:'FLAC',lossless:true,sampleRateHz:96000,channels:2,bitsPerSample:24,durationMs:200000,evidence:'bounded-parser-reported'}};
  const binding:MobileCatalogIdentityBinding = {localTrackId:'track.fixture.1',assetId:'asset.fixture.1',fileRevision:'1',selectionRevision:'1',segmentId:null,editionId:'edition.fixture.1',editionRevision:'1',trackId:'local:track.1',sourceItemId:'local:item.1',albumId:'local:album.1',versionId:'local:version.1',contentRevision:'rev.1'};
  const projection = {title:'合成曲目',artists:['合成艺术家'],editionLabel:'原版',availability:'available' as const};
  const first = m.catalog.mapLocalDetailToMobileTrack(detail,binding,projection); assert(first.ok);
  const moved = plain(detail); moved.asset.locationRevision = '2'; moved.asset.rootRevision = '2'; moved.asset.libraryRootId = 'library.fixture.2'; moved.asset.sourceRootId = 'source.fixture.2';
  const after = m.catalog.mapLocalDetailToMobileTrack(moved,binding,projection); assert(after.ok); assert.deepEqual(after.value,first.value);
  for (const mutate of [(value:LocalLibraryTrackDetail) => {value.asset.fileRevision='2';},(value:LocalLibraryTrackDetail) => {value.track.selectionRevision='2';},(value:LocalLibraryTrackDetail) => {value.editions[0]!.revision='2';},(value:LocalLibraryTrackDetail) => {value.editions=[];},(value:LocalLibraryTrackDetail) => {value.fileParameters=null;}]) { const changed = plain(detail); mutate(changed); assert.equal(m.catalog.mapLocalDetailToMobileTrack(changed,binding,projection).ok,false); }
  assert.equal(Object.hasOwn(first.value,'locationRevision'),false); assert.equal(Object.hasOwn(first.value,'path'),false);
});
test('移动白名单audio mapper：源参数保持三轴，不输出Provider或Parser私有字段',() => {
  const file = {container:'FLAC' as const,codec:'FLAC',lossless:true,sampleRateHz:96000,channels:2,bitsPerSample:24,durationMs:200000,evidence:'bounded-parser-reported' as const};
  const result = m.common.mapMobileFileAudioParameters(file); assert(result.ok); assert.deepEqual({...result.value},{codec:'flac',container:'flac',sampleRateHz:96000,channels:2,bitsPerSample:24});
  const source = {...file,container:'flac',codec:'flac',sampleRate:96000,path:'synthetic-only-private',rawHeaders:'synthetic-only-private'};
  const withPrivate = m.common.mapMobileSourceTechnical(source); assert(withPrivate.ok); assert.equal(Object.hasOwn(withPrivate.value,'path'),false); assert.equal(Object.hasOwn(withPrivate.value,'rawHeaders'),false);
  const incomplete = m.common.mapMobileFileAudioParameters({...file,bitsPerSample:null}); assert(incomplete.ok); assert.equal(Object.hasOwn(incomplete.value,'bitsPerSample'),false);
  let calls = 0; const accessor = Object.defineProperty({...file},'codec',{enumerable:true,get:() => {calls++;return 'FLAC';}}); assert.equal(m.common.mapMobileFileAudioParameters(accessor).ok,false); assert.equal(calls,0);
});
