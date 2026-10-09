import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyHeaders, encode, exerciseFixture, fixtureJson, loadFreshMobileContracts, loadMobileFixtures, plain, readFixtureBody, requestContext, responseContext } from './fixture-helpers.js';
import type { MobileLyricsContent, MobilePersonalPlaylistTrackPage, MobilePersonalPlaylistRecord, MobileFavoriteAlbumRecord, MobileFavoriteAlbumTrackPage, MobileContentCursorFacts } from '../../src/mobile-content.js';
import type { MobileTrackPage, MobileCursorFacts } from '../../src/mobile-catalog.js';

const m = await loadFreshMobileContracts('packages/contracts/test/mbm000/content-revision.test.ts');
const fixtures = loadMobileFixtures();
const lyricRow = fixtures.cases.find(row => row.id === 'getExactTrackLyrics--success-200')!; assert(lyricRow);
const lyrics = fixtureJson<Extract<MobileLyricsContent,{status:'ready'}>>(lyricRow.response.body);

test('移动内容whole body：空/缺失/首曲封面/CAS/201与opaque身份负例完整消费',() => {
  const rows = fixtures.cases.filter(row => ['getExactTrackLyrics','listRecentlyAddedAlbums','getNeteaseDailyRecommendations','getNeteaseLikedPlaylist','listNeteaseLikedPlaylistTracks','listFavoriteAlbums','getFavoriteAlbumState','setAlbumFavorite','listFavoriteAlbumTracks','setTrackFavorite','listPersonalPlaylists','createPersonalPlaylist','listPersonalPlaylistTracks','addPersonalPlaylistTrack','listNeteaseRecommendedPlaylists','listNeteaseNewAlbums','listNeteaseCharts','getNeteaseDiscoveryCollectionTracks','getNeteasePersonalFM'].includes(row.operationId)); assert(rows.length >= 60); rows.forEach(row => exerciseFixture(m,fixtures,row));
});
test('移动歌词上限：2000行/每列4096UTF8保留，whole2MiB超限不截断',() => {
  for (const text of ['a'.repeat(4096),'界'.repeat(1365)+'a','😀'.repeat(1024)]) assert.equal(m.content.mobileContentResponseSnapshot('lyrics',{...lyrics,lines:[{id:'line.1',text,startMs:0}]}).ok,true);
  for (const text of ['a'.repeat(4097),'界'.repeat(1366),'😀'.repeat(1025)]) { assert.equal(m.content.mobileContentResponseSnapshot('lyrics',{...lyrics,lines:[{id:'line.1',text,startMs:0}]}).ok,false); assert.equal(m.content.mobileContentResponseSnapshot('lyrics',{...lyrics,lines:[{id:'line.1',text:'原文',secondaryText:text,startMs:0}]}).ok,false); }
  const lines = Array.from({length:2000},(_,index) => ({id:`line.${index}`,text:'词',startMs:index}));
  const complete = m.content.mobileContentResponseSnapshot('lyrics',{...lyrics,lines}); assert(complete.ok); assert.equal(complete.value.lines.length,2000);
  assert.equal(m.content.mobileContentResponseSnapshot('lyrics',{...lyrics,lines:[...lines,{id:'line.2000',text:'词',startMs:2000}]}).ok,false);
  const huge = {...lyrics,lines:Array.from({length:600},(_,index) => ({id:`line.${index}`,text:'a'.repeat(4096),startMs:index}))}; const bytes = encode(huge); assert(bytes.length > m.common.MOBILE_API_RESPONSE_MAX_BYTES);
  const result = m.wire.decodeMobileResponse('getExactTrackLyrics',{status:200,headers:bodyHeaders(lyricRow.response.headers,bytes),body:bytes,finalUrl:lyricRow.response.finalUrl},responseContext(fixtures,lyricRow)); assert.equal(result.ok,false); if (!result.ok) assert.equal(result.issue.code,'LIMIT_EXCEEDED');
  const mapped = m.content.mapMobileLyrics(huge); assert.equal(mapped.ok,false); if (!mapped.ok) assert.equal(mapped.issue.code,'LIMIT_EXCEEDED');
});
test('移动歌词身份与时间：旧版本/旧revision/不同来源/重复行不能覆盖当前选择',() => {
  const ctx = responseContext(fixtures,lyricRow).content!;
  assert.equal(m.content.validateMobileContentIdentity('lyrics',lyrics,ctx).ok,true);
  for (const changed of [{...lyrics,versionId:'old.version'},{...lyrics,contentRevision:'old.rev'},{...lyrics,source:'netease' as const}]) assert.equal(m.content.validateMobileContentIdentity('lyrics',changed,ctx).ok,false);
  assert.equal(m.content.mobileContentResponseSnapshot('lyrics',{...lyrics,lines:[{id:'same',text:'a',startMs:0},{id:'same',text:'b',startMs:1}]}).ok,false);
  assert.equal(m.content.mobileContentResponseSnapshot('lyrics',{...lyrics,lines:[{id:'line.1',text:'a',startMs:10},{id:'line.2',text:'b',startMs:9}]}).ok,false);
  assert.equal(m.content.mobileContentResponseSnapshot('lyrics',{...lyrics,lines:[{id:'line.1',text:'a',startMs:null}]}).ok,false);
  for (const status of ['missing','instrumental'] as const) { const raw = {trackId:lyrics.trackId,source:lyrics.source,versionId:lyrics.versionId,contentRevision:lyrics.contentRevision,status,synchronized:false,lines:[]}; assert.equal(m.content.mobileContentResponseSnapshot('lyrics',raw).ok,true); assert.equal(m.content.mobileContentResponseSnapshot('lyrics',{...raw,lines:[{id:'line.1',text:'伪空内容'}]}).ok,false); }
});
test('移动内容CAS：原请求旧rev与新响应rev独立，foreign账户/选择/额外键拒绝',() => {
  for (const id of ['setAlbumFavorite--success-200','setTrackFavorite--success-200','createPersonalPlaylist--success-201','addPersonalPlaylistTrack--success-200']) {
    const row = fixtures.cases.find(item => item.id === id)!; assert(row); const ctx = requestContext(fixtures,row); assert(ctx.contentMutation);
    const request = {method:row.method,path:row.path,headers:row.request.headers,query:row.request.query,body:readFixtureBody(row.request.body)};
    assert.equal(m.wire.decodeMobileRequest(row.operationId,request,ctx).ok,true);
    assert.equal(m.wire.decodeMobileRequest(row.operationId,request,{...ctx,contentMutation:{...ctx.contentMutation,revision:'stale.rev'}}).ok,false);
    assert.equal(m.wire.decodeMobileRequest(row.operationId,request,{...ctx,contentMutation:{...ctx.contentMutation,accountDomain:'other.account'}}).ok,false);
    const body = fixtureJson<Record<string,unknown>>(row.request.body!); body.rawActor = 'synthetic-private'; const bytes = encode(body);
    assert.equal(m.wire.decodeMobileRequest(row.operationId,{...request,headers:bodyHeaders(row.request.headers,bytes),body:bytes},ctx).ok,false);
  }
  const row = fixtures.cases.find(item => item.id === 'setTrackFavorite--success-200')!; const ctx = requestContext(fixtures,row);
  const body = fixtureJson<Record<string,unknown>>(row.request.body!); body.versionId = 'old.version'; const bytes = encode(body);
  assert.equal(m.wire.decodeMobileRequest('setTrackFavorite',{method:row.method,path:row.path,headers:bodyHeaders(row.request.headers,bytes),query:row.request.query,body:bytes},ctx).ok,false);
});
test('移动歌单首曲：空集不能封面，未知事实可解码，首曲缺图不能找后曲回填',() => {
  const row = fixtures.cases.find(item => item.id === 'listPersonalPlaylistTracks--success-200')!; const page = fixtureJson<MobilePersonalPlaylistTrackPage>(row.response.body); const ctx = responseContext(fixtures,row).content!;
  const optionalContext = {...ctx}; delete optionalContext.playlistFirstTracks;
  assert.equal(m.content.validateMobileContentIdentity('personalPlaylistTrackPage',page,optionalContext).ok,true);
  const first = plain(page.items[0]!); delete first.artworkId; const later = page.items[1]!; assert(later.artworkId);
  const mapped = m.content.mapMobilePersonalPlaylist({playlist:page.playlist,firstTrack:first}); assert(mapped.ok); assert.equal(mapped.value.coverArtworkId,null);
  const wrong = {...page,playlist:{...page.playlist,coverArtworkId:later.artworkId}}; assert.equal(m.content.validateMobileContentIdentity('personalPlaylistTrackPage',wrong,{...ctx,playlistFirstTracks:{[page.playlist.playlistId]:first}}).ok,false);
  const empty:MobilePersonalPlaylistRecord = {...page.playlist,trackCount:0,coverArtworkId:null}; assert.equal(m.content.mobileContentResponseSnapshot('personalPlaylist',empty).ok,true); assert.equal(m.content.mobileContentResponseSnapshot('personalPlaylist',{...empty,coverArtworkId:'artwork.later'}).ok,false);
  assert.equal(m.content.mapMobilePersonalPlaylist({playlist:empty,firstTrack:first}).ok,false); assert.equal(m.content.mapMobilePersonalPlaylist({playlist:page.playlist,firstTrack:null}).ok,false);
  const draft = m.content.mapMobilePersonalPlaylistDraft({title:'  合成歌单  ',icon:'heart.fill',description:'  说明  '}); assert(draft.ok); assert.equal(draft.value.title,'合成歌单'); assert.equal(draft.value.description,'说明');
});
test('移动收藏：album共同身份和完整track归属不能被oneOf/空枝绕过',() => {
  const row = fixtures.cases.find(item => item.id === 'listFavoriteAlbumTracks--success-200')!; const page = fixtureJson<MobileFavoriteAlbumTrackPage>(row.response.body); assert(page.favorite);
  const favorite:MobileFavoriteAlbumRecord = page.favorite;
  assert.equal(m.content.mobileContentResponseSnapshot('favoriteAlbumRecord',favorite).ok,true);
  assert.equal(m.content.mobileContentResponseSnapshot('favoriteAlbumRecord',{albumFavorite:true}).ok,false);
  assert.equal(m.content.mobileContentResponseSnapshot('favoriteAlbumRecord',{...favorite,albumFavorite:false,favoriteTracks:[]}).ok,false);
  assert.equal(m.content.mobileContentResponseSnapshot('favoriteAlbumRecord',{...favorite,favoriteTracks:[{...favorite.favoriteTracks[0]!,source:'netease'}]}).ok,false);
  assert.equal(m.content.mobileContentResponseSnapshot('favoriteAlbumRecord',{...favorite,favoriteTracks:[favorite.favoriteTracks[0]!,favorite.favoriteTracks[0]!]}).ok,false);
  const mismatch = {...page,identity:{...page.identity,albumId:'other.album'}}; assert.equal(m.content.mobileContentResponseSnapshot('favoriteAlbumTrackPage',mismatch).ok,false);
  const foreign = plain(page); foreign.items[0]!.albumId = 'other.album'; assert.equal(m.content.mobileContentResponseSnapshot('favoriteAlbumTrackPage',foreign).ok,false);
});
test('移动分页：同账户/来源/修订/过滤游标事实及去重/空尾页必须同时相符',() => {
  const row = fixtures.cases.find(item => item.id === 'listTracks--success-200')!; const page = fixtureJson<MobileTrackPage>(row.response.body); const ctx = responseContext(fixtures,row).catalog!;
  const facts:MobileCursorFacts = {serverId:ctx.serverId,deviceId:ctx.deviceId,accountDomain:ctx.accountDomain,source:ctx.source,libraryRevision:ctx.libraryRevision,sort:ctx.sort,filter:ctx.filter,albumId:ctx.albumId};
  assert.equal(m.catalog.validateMobileCatalogPage(page,{...ctx,cursorFacts:facts}).ok,true);
  for (const [key,value] of [['deviceId','another.device'],['accountDomain','another.account'],['libraryRevision','old.rev'],['source','netease'],['filter','changed'],['sort','changed']] as const) assert.equal(m.catalog.validateMobileCatalogPage(page,{...ctx,cursorFacts:{...facts,[key]:value}}).ok,false,key);
  assert.equal(m.catalog.validateMobileCatalogPage({...page,items:[],nextCursor:'cursor.next'},ctx).ok,false);
  assert.equal(m.catalog.validateMobileCatalogPage({...page,items:[page.items[0]!,page.items[0]!]},ctx).ok,false);
  assert.equal(m.catalog.validateMobileCatalogPage(page,{...ctx,previousIds:[`local:${page.items[0]!.id}`]}).ok,false);
  const contentRow = fixtures.cases.find(item => item.id === 'listPersonalPlaylistTracks--success-200')!; const contentPage = fixtureJson<MobilePersonalPlaylistTrackPage>(contentRow.response.body); const contentCtx = responseContext(fixtures,contentRow).content!;
  const contentFacts:MobileContentCursorFacts = {serverId:contentCtx.serverId,deviceId:contentCtx.deviceId,accountDomain:contentCtx.accountDomain,revision:contentCtx.revision!,sort:'sequence',parentId:contentPage.playlist.playlistId,source:'all'};
  assert.equal(m.content.validateMobileContentIdentity('personalPlaylistTrackPage',contentPage,{...contentCtx,sort:'sequence',cursorFacts:contentFacts}).ok,true);
  assert.equal(m.content.validateMobileContentIdentity('personalPlaylistTrackPage',contentPage,{...contentCtx,sort:'sequence',cursorFacts:{...contentFacts,revision:'old.rev'}}).ok,false);
  assert.equal(m.content.validateMobileContentIdentity('personalPlaylistTrackPage',contentPage,{...contentCtx,pageOffset:1}).ok,false);
});
test('移动cap可选分支：缺失unsupported，null位深/错误版本/坏时区不能制造能力',() => {
  const raw = {version:'1.0.0',addedAlbums:'ready',neteaseDailyRecommendations:'unavailable',lyrics:'ready'};
  const caps = m.content.mobileContentResponseSnapshot('uiCapabilities',raw); assert(caps.ok); assert.equal(m.content.mobileUIFeature(caps.value,'personalPlaylists'),'unsupported');
  const resource = fixtures.cases.find(row => row.id === 'createResource--success-201')!; const basis = responseContext(fixtures,resource).resource!;
  const inferred = m.content.mobileResourceContextFromCapabilities(basis.scope,raw,{capabilitySnapshotIdentity:basis.capabilitySnapshotIdentity,responseOrigin:basis.responseOrigin,now:basis.now}); assert(inferred.ok); assert.equal(inferred.value.resourceFormatBitDepth,false);
  assert.equal(m.content.mobileContentResponseSnapshot('uiCapabilities',{...raw,resourceFormatBitDepth:null}).ok,false);
  assert.equal(m.content.mobileContentResponseSnapshot('uiCapabilities',{...raw,version:'0.1.0'}).ok,false);
  const daily = fixtures.cases.find(item => item.id === 'getNeteaseDailyRecommendations--success-200')!; const body = fixtureJson<Record<string,unknown>>(daily.response.body); body.timeZone = 'Not/A_Real_Zone'; assert.equal(m.content.mobileContentResponseSnapshot('dailyRecommendationFeed',body).ok,false);
});
