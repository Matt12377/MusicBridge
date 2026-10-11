import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MOBILE_OPERATION_TABLE, type MobileRequestMap, type MobileTrack } from '@music-bridge/contracts';
import { createMobileContentRuntime } from '../../src/mobile/content-runtime.js';
import { captureMobileContentRequest } from '../../src/mobile/content-protocol.js';
import type { MobileContentScope, MobileContentOperation } from '../../src/mobile/content-types.js';
import type { MobileContentCoreRequest, MobileContentCoreResponse } from '../../src/mobile/content-rpc.js';
import type { NeteaseMobileReadPort } from '../../src/netease/types.js';
import type { GatewayFetch } from '../../src/stream/upstream-policy.js';
import { MobileServiceError } from '../../src/mobile/types.js';
import { makeContentRuntimeOwnerFixture, selected } from './content-owner-fixture.js';

// 原SQLite/Scanner/新鲜Reader + 实际runtime/RPC/Provider适配器；SDK/HTTP端口受控，不声称真实账号或物理Worker。
const signal = () => new AbortController().signal;
const base = () => ({ type: 'mobile-content-core-request' as const, id: randomUUID() });
const offline: NeteaseMobileReadPort = { configured: false, async mobileAccount() { throw new MobileServiceError(401, 'UNAUTHORIZED'); },
  async mobileRead() { throw new MobileServiceError(401, 'UNAUTHORIZED'); }, onMobileAccountInvalidated: () => () => undefined,
  async awaitMobileQuiet() {} };
async function runtimeFixture(t: TestContext, client = offline, streamFetch?: GatewayFetch) {
  const owner = await makeContentRuntimeOwnerFixture(t), key = new Uint8Array(randomBytes(32));
  let runtime = createMobileContentRuntime({ owner: owner.ownerEndpoint, netease: client, assertCurrent: owner.assertCurrent,
    ...(streamFetch ? { streamFetch } : {}) });
  const initialize = () => runtime.request({ ...base(), action: 'initialize', serverId: owner.serverId, datasetId: owner.datasetId,
    key: new Uint8Array(key) }, signal());
  const initialized = await initialize(); assert.ok('ok' in initialized && initialized.ok);
  t.after(async () => { await runtime.close(); key.fill(0); });
  const rpc = (request: MobileContentCoreRequest) => runtime.request(request, signal());
  async function scope(deviceId = 'runtime.device.1', accessGeneration = 1, deviceEpoch = 1): Promise<Readonly<MobileContentScope>> {
    const response = await rpc({ ...base(), action: 'scope', principal: { serverId: owner.serverId, datasetId: owner.datasetId,
      deviceId, deviceEpoch, accessGeneration } });
    assert.ok('kind' in response && response.kind === 'scope'); return response.scope;
  }
  async function dispatch<O extends MobileContentOperation>(operation: O, ownScope: Readonly<MobileContentScope>, input: {
    pathParameters?: Record<string,string>; query?: Record<string,string|number>; body?: unknown; key?: string;
  } = {}, send = true) {
    const pathParameters = input.pathParameters ?? {}; let target: string = MOBILE_OPERATION_TABLE[operation].path;
    for (const [name,value] of Object.entries(pathParameters)) target = target.replace(`{${name}}`, encodeURIComponent(value));
    const request = captureMobileContentRequest(operation, { path: target, pathParameters, query: input.query ?? {}, body: input.body ?? null,
      ...(input.key ? { idempotencyKey: input.key } : {}) });
    const response = await rpc({ ...base(), action: 'dispatch', operation, scope: ownScope,
      request: request as MobileRequestMap[MobileContentOperation] });
    assert.ok('kind' in response && response.kind === 'snapshot', `原 ${operation} 必须产生真实组合快照。${'kind' in response && response.kind === 'error' ? ` ${response.status}/${response.code}` : ''}`);
    if (send) { const check = await rpc({ ...base(), action: 'revalidate', snapshotId: response.snapshotId, scope: ownScope });
      assert.ok('kind' in check && check.kind === 'validated'); }
    return response;
  }
  return { owner, scope, dispatch, rpc, key, get runtime() { return runtime; },
    async restart() { await runtime.close(); await owner.restartRuntimeOwner();
      runtime = createMobileContentRuntime({ owner: owner.ownerEndpoint, netease: client, assertCurrent: owner.assertCurrent,
        ...(streamFetch ? { streamFetch } : {}) }); return initialize(); } };
}
function body<T>(response: MobileContentCoreResponse): T {
  assert.ok('kind' in response && response.kind === 'snapshot'); return response.reply.body as T;
}
test('实际runtime沿原Owner登记scope、本地读取完整投影并拒绝伪造线程请求', async t => {
  const f = await runtimeFixture(t), scope = await f.scope();
  assert.equal(scope.ownerEpoch, f.owner.ownerEpoch); assert.equal(scope.accountDomain, `local:${f.owner.datasetId}`);
  const page = await f.dispatch('listRecentlyAddedAlbums', scope, { query: { limit: 100 } });
  assert.equal(body<{items:unknown[]}>(page).items.length, 1);
  await assert.rejects(f.runtime.request({ ...base(), action: 'scope', principal: { ...scope, fakeGrant: true } }, signal()),
    (error: unknown) => error instanceof MobileServiceError && error.status === 400 && error.code === 'INVALID_REQUEST');
  assert.deepEqual(await readFile(f.owner.file), f.owner.original);
});
test('两个设备共享内容与CAS，refresh只撤销旧快照，设备撤销不能靠更高generation复活', async t => {
  const f = await runtimeFixture(t), first = await f.scope(), second = await f.scope('runtime.device.2');
  const read = (s: Readonly<MobileContentScope>) => f.dispatch('getFavoriteAlbumState', s,
    { pathParameters: { albumId: f.owner.track.albumId }, query: { source: 'local' } });
  const initial = body<{favoritesRevision:string}>(await read(first));
  await f.dispatch('setAlbumFavorite', first, { pathParameters: { albumId: f.owner.track.albumId }, key: 'runtime.album.once',
    body: { source: 'local', isFavorite: true, accountDomain: first.accountDomain, expectedRevision: initial.favoritesRevision } });
  assert.equal(body<{favorite:{albumFavorite:boolean}}>(await read(second)).favorite.albumFavorite, true);
  const held = await f.dispatch('listPersonalPlaylists', first, {}, false), refreshed = await f.scope(first.deviceId, 2);
  const stale = await f.rpc({ ...base(), action: 'revalidate', snapshotId: held.snapshotId, scope: first });
  assert.ok('kind' in stale && stale.kind === 'error');
  await f.dispatch('listPersonalPlaylists', refreshed);
  assert.ok('ok' in await f.rpc({ ...base(), action: 'invalidate-device', serverId: first.serverId,
    datasetId: first.datasetId, deviceId: first.deviceId, deviceEpoch: first.deviceEpoch }));
  const resurrected = await f.rpc({ ...base(), action: 'scope', principal: { serverId: first.serverId, datasetId: first.datasetId,
    deviceId: first.deviceId, deviceEpoch: first.deviceEpoch, accessGeneration: 3 } });
  assert.ok('kind' in resurrected && resurrected.kind === 'error');
  await read(second);
});
test('歌单首曲原子写入，冷重开仍只读同key完整回执并保护源媒体', async t => {
  const f = await runtimeFixture(t), ownScope = await f.scope();
  const initial = body<{collectionRevision:string}>(await f.dispatch('listPersonalPlaylists', ownScope));
  const input = { key: 'runtime.playlist.once', body: { accountDomain: ownScope.accountDomain,
    expectedCollectionRevision: initial.collectionRevision, draft: { title: '原子首曲', description: '自有夹具', icon: 'music.note' },
    initialTrack: selected(f.owner.track) } };
  const first = await f.dispatch('createPersonalPlaylist', ownScope, input);
  const playlist = body<{playlist:{playlistId:string;playlistRevision:string;trackCount:number;coverArtworkId:string|null}}>(first).playlist;
  assert.equal(playlist.trackCount, 1); assert.equal(playlist.coverArtworkId, f.owner.track.artworkId ?? null);
  const file = path.join(f.owner.directory, 'mobile-content/content-state.v1.sealed.json'), persisted = await readFile(file);
  const initialized = await f.restart(); assert.ok('ok' in initialized);
  const fresh = await f.scope();
  assert.deepEqual((await f.dispatch('createPersonalPlaylist', fresh, input)).reply, first.reply);
  assert.deepEqual(await readFile(file), persisted);
  const tracks = await f.dispatch('listPersonalPlaylistTracks', fresh, { pathParameters: { playlistId: playlist.playlistId },
    query: { accountDomain: fresh.accountDomain, playlistRevision: playlist.playlistRevision } });
  assert.deepEqual(body<{items:MobileTrack[]}>(tracks).items, [f.owner.track]);
  assert.deepEqual(await readFile(f.owner.file), f.owner.original);
});
test('精确本地侧车完整歌词通过原FD读取，发送前正文变化阻断旧结果', async t => {
  const f = await runtimeFixture(t), scope = await f.scope(), lyricsFile = path.join(f.owner.disc, 'source.lrc');
  await writeFile(lyricsFile, '[00:00.000]第一行\n[00:00.500]末行', { flag: 'wx', mode: 0o600 });
  const input = { pathParameters: { trackId: f.owner.selection.trackId }, query: { source: 'local',
    versionId: f.owner.selection.versionId, contentRevision: f.owner.selection.contentRevision } };
  const response = await f.dispatch('getExactTrackLyrics', scope, input, false);
  assert.equal(body<{lines:unknown[]}>(response).lines.length, 2);
  await writeFile(lyricsFile, '[00:00.000]第一行\n[00:00.500]新的末行');
  const stale = await f.rpc({ ...base(), action: 'revalidate', snapshotId: response.snapshotId, scope });
  assert.ok('kind' in stale && stale.kind === 'error');
});
test('101首单曲收藏跨页revision保持一致，已提交网易云回执不再查临时失效Provider', async t => {
  const audio = Buffer.alloc(150000); audio.write('fLaC'); audio[4]=0x80; audio.writeUIntBE(34,5,3);
  audio.writeUInt16BE(4096,8); audio.writeUInt16BE(4096,10); audio.writeBigUInt64BE(192000n<<44n|1n<<41n|23n<<36n|192000n,18);
  const songs = Array.from({length:101},(_,i)=>({ id:String(i+1),name:`合成曲${i+1}`,ar:[{name:'合成艺人'}],
    al:{id:'5',name:'合成发行'},dt:1000,alia:['原发行'] }));
  let failProvider=false, providerCalls=0;
  const client: NeteaseMobileReadPort = { configured: true, async mobileAccount() { return { accountId:'700',providerEpoch:'provider.runtime.1' }; },
    async mobileRead(request) { providerCalls++; if(failProvider)throw new MobileServiceError(503,'BUSY');
      let response: unknown;
      if(request.operation==='song-detail')response={code:200,songs:request.ids.map(id=>songs.find(s=>s.id===id))};
      else if(request.operation==='stream')response={code:200,data:[{id:request.id,code:200,md5:'a'.repeat(32),size:audio.length,expi:300,
        url:`https://synthetic.invalid/${request.id}.flac`,level:'hires',type:'flac',br:9216000}]};
      else if(request.operation==='album')response={code:200,album:{id:'5',name:'合成发行',artists:[{name:'合成艺人'}],size:101},songs};
      else if(request.operation==='playlist-detail')response={code:200,playlist:{id:'9',name:'合成集合',trackCount:101,updateTime:7,trackIds:songs.map(s=>({id:s.id}))}};
      else if(request.operation==='recommended-playlists')response={code:200,result:[{id:'9'}]};
      else throw new Error('未声明的受控SDK读取。');
      return { providerEpoch:'provider.runtime.1',response }; }, onMobileAccountInvalidated:()=>()=>undefined,async awaitMobileQuiet(){} };
  const streamFetch: GatewayFetch = async (_url,init) => { const range=new Headers(init.headers).get('range'); const match=/^bytes=(\d+)-(\d+)$/u.exec(range??'');assert.ok(match);
    const start=Number(match[1]),end=Number(match[2]); return new Response(Uint8Array.from(audio.subarray(start,end+1)),{status:206,
      headers:{'content-range':`bytes ${start}-${end}/${audio.length}`,'content-length':String(end-start+1),etag:'"owned-runtime-source"'}}); };
  const f=await runtimeFixture(t,client,streamFetch),scope=await f.scope();
  const feed=body<{items:{id:string;collectionRevision:string}[]}>(await f.dispatch('listNeteaseRecommendedPlaylists',scope));
  const collection=feed.items[0];assert.ok(collection);
  const page=(cursor?:string)=>f.dispatch('getNeteaseDiscoveryCollectionTracks',scope,{pathParameters:{collectionId:collection.id},query:{kind:'playlist',
    accountDomain:scope.accountDomain,collectionRevision:collection.collectionRevision,limit:100,...(cursor?{cursor}:{})}});
  const firstPage=body<{items:MobileTrack[];nextCursor:string}>(await page());f.owner.advance(16000);
  const secondPage=body<{items:MobileTrack[]}>(await page(firstPage.nextCursor));f.owner.advance(16000);
  const tracks=[...firstPage.items,...secondPage.items];assert.equal(tracks.length,101);
  const albumId=tracks[0]!.albumId;assert.ok(albumId.startsWith('na:'));assert.notEqual(albumId,'na:5');
  assert.ok(tracks.every(track=>track.albumId===albumId));
  let revision=body<{favoritesRevision:string}>(await f.dispatch('getFavoriteAlbumState',scope,{pathParameters:{albumId},query:{source:'netease'}})).favoritesRevision;
  f.owner.advance(16000);let original: {pathParameters:Record<string,string>;key:string;body:unknown}|undefined,firstReply:unknown;
  for(const track of tracks){const input={pathParameters:{trackId:track.id},key:`runtime.favorite.${track.sourceItemId}`,body:{source:'netease',isFavorite:true,
    accountDomain:scope.accountDomain,expectedRevision:revision,albumId:track.albumId,versionId:track.versionId,contentRevision:track.contentRevision}};
    const reply=await f.dispatch('setTrackFavorite',scope,input);if(!original){original=input;firstReply=reply.reply;}
    revision=body<{favoritesRevision:string}>(reply).favoritesRevision;f.owner.advance(16000);}
  const favorites=(cursor?:string)=>f.dispatch('listFavoriteAlbumTracks',scope,{pathParameters:{albumId},query:{source:'netease',accountDomain:scope.accountDomain,
    favoritesRevision:revision,limit:100,...(cursor?{cursor}:{})}});
  const one=body<{items:MobileTrack[];nextCursor:string}>(await favorites());assert.equal(one.items.length,100);f.owner.advance(16000);
  const two=body<{items:MobileTrack[];nextCursor:null}>(await favorites(one.nextCursor));assert.equal(two.items.length,1);assert.equal(two.nextCursor,null);f.owner.advance(16000);
  assert.ok(original);failProvider=true;const prior=providerCalls;
  assert.deepEqual((await f.dispatch('setTrackFavorite',scope,original)).reply,firstReply);assert.equal(providerCalls,prior);
});

test('网易云歌单发送前核精确来源，历史可播放结果阻断而原提交回执保留', async t => {
  const audio = Buffer.alloc(150000); audio.write('fLaC'); audio[4]=0x80; audio.writeUIntBE(34,5,3);
  audio.writeUInt16BE(4096,8); audio.writeUInt16BE(4096,10); audio.writeBigUInt64BE(192000n<<44n|1n<<41n|23n<<36n|192000n,18);
  let title='原始曲名',providerCalls=0;
  const song=()=>({id:'1',name:title,ar:[{name:'合成艺人'}],al:{id:'5',name:'合成发行'},dt:1000,alia:['原发行']});
  const client: NeteaseMobileReadPort = { configured:true,async mobileAccount(){return{accountId:'700',providerEpoch:'provider.runtime.1'};},
    async mobileRead(request){providerCalls++;let response:unknown;
      if(request.operation==='song-detail')response={code:200,songs:[song()]};
      else if(request.operation==='stream')response={code:200,data:[{id:'1',code:200,md5:'a'.repeat(32),size:audio.length,expi:300,
        url:'https://synthetic.invalid/1.flac',level:'hires',type:'flac',br:9216000}]};
      else if(request.operation==='playlist-detail')response={code:200,playlist:{id:'9',name:'合成集合',trackCount:1,updateTime:7,trackIds:[{id:'1'}]}};
      else if(request.operation==='recommended-playlists')response={code:200,result:[{id:'9'}]};
      else throw new Error('未声明的受控SDK读取。');
      return{providerEpoch:'provider.runtime.1',response};},onMobileAccountInvalidated:()=>()=>undefined,async awaitMobileQuiet(){}};
  const streamFetch:GatewayFetch=async(_url,init)=>{const match=/^bytes=(\d+)-(\d+)$/u.exec(new Headers(init.headers).get('range')??'');assert.ok(match);
    const start=Number(match[1]),end=Number(match[2]);return new Response(Uint8Array.from(audio.subarray(start,end+1)),{status:206,
      headers:{'content-range':`bytes ${start}-${end}/${audio.length}`,'content-length':String(end-start+1),etag:'"owned-playlist-source"'}});};
  const f=await runtimeFixture(t,client,streamFetch),scope=await f.scope();
  const feed=body<{items:{id:string;collectionRevision:string}[]}>(await f.dispatch('listNeteaseRecommendedPlaylists',scope)),collection=feed.items[0]!;
  const discovery=body<{items:MobileTrack[]}>(await f.dispatch('getNeteaseDiscoveryCollectionTracks',scope,{pathParameters:{collectionId:collection.id},
    query:{kind:'playlist',accountDomain:scope.accountDomain,collectionRevision:collection.collectionRevision}})),track=discovery.items[0]!;
  const initial=body<{collectionRevision:string}>(await f.dispatch('listPersonalPlaylists',scope));
  const input={key:'runtime.net.playlist.once',body:{accountDomain:scope.accountDomain,expectedCollectionRevision:initial.collectionRevision,
    draft:{title:'来源围栏歌单',description:'自有夹具',icon:'music.note'},initialTrack:selected(track)}};
  const committed=await f.dispatch('createPersonalPlaylist',scope,input);
  const playlist=body<{playlist:{playlistId:string;playlistRevision:string}}>(committed).playlist;
  const query={pathParameters:{playlistId:playlist.playlistId},query:{accountDomain:scope.accountDomain,playlistRevision:playlist.playlistRevision}};
  assert.deepEqual(body<{items:MobileTrack[]}>(await f.dispatch('listPersonalPlaylistTracks',scope,query)).items,[track]);
  await f.dispatch('listPersonalPlaylists',scope);
  const oldTracks=await f.dispatch('listPersonalPlaylistTracks',scope,query,false),oldList=await f.dispatch('listPersonalPlaylists',scope,{},false);
  const file=path.join(f.owner.directory,'mobile-content/content-state.v1.sealed.json'),persisted=await readFile(file);
  title='同账户上游曲名已变化';
  for(const held of [oldTracks,oldList]){const stale=await f.rpc({...base(),action:'revalidate',snapshotId:held.snapshotId,scope});
    assert.ok('kind' in stale&&stale.kind==='error','历史网易云来源不能发布为当前可播放事实。');
    assert.equal(stale.status,409);assert.equal(stale.code,'SOURCE_CHANGED');}
  const prior=providerCalls;assert.deepEqual((await f.dispatch('createPersonalPlaylist',scope,input)).reply,committed.reply);
  assert.equal(providerCalls,prior);assert.deepEqual(await readFile(file),persisted);
});
