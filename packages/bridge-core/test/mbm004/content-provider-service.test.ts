import assert from 'node:assert/strict';
import test from 'node:test';
import { MOBILE_OPERATION_TABLE } from '@music-bridge/contracts';
import type { MobileContentReadContext, MobileRequestMap } from '@music-bridge/contracts';
import { createMobileContentProviderService, type MobileNeteaseContentProviderPort } from '../../src/mobile/content-provider-service.js';
import type { MobileContentScope } from '../../src/mobile/content-types.js';
import { MobileServiceError } from '../../src/mobile/types.js';

// 仅可信注入端口行为，不是真实网易云账号、HTTP 或手机播放证据。
const scope: Readonly<MobileContentScope> = Object.freeze({ serverId:'server-1',datasetId:'dataset-1',deviceId:'device-1',deviceEpoch:1,
  accessGeneration:1,ownerEpoch:'owner-1',accountDomain:'account-1',providerEpoch:'provider-1' });
const context = (revision='feed-1',limit=20,pageOffset=0): MobileContentReadContext => ({serverId:scope.serverId,deviceId:scope.deviceId,accountDomain:scope.accountDomain,source:'netease',revision,limit,pageOffset});
function request(query: Record<string,string|number> = {}): MobileRequestMap['listNeteaseCharts'] {
  return {path:'/mobile/v1/ui/netease/charts',pathParameters:{},query,body:null};
}
function fixture() {
  let current = true, calls = 0;
  const offsets: number[] = [];
  const provider: MobileNeteaseContentProviderPort = { async read(input) {
    calls++; offsets.push(input.offset);
    return {account:{accountDomain:'account-1',providerEpoch:'provider-1'},body:{accountDomain:'account-1',feedRevision:'feed-1',items:[{
      id:`chart-${input.offset}`,kind:'chart',title:'合成榜单',artworkId:null,trackCount:0,collectionRevision:'collection-1',
    }],nextCursor:null},context:context('feed-1',input.limit,input.offset),nextOffset:input.offset===0?1:null};
  }};
  const service = createMobileContentProviderService({provider,cursorKey:new Uint8Array(32).fill(7),async assertCurrent(s) {
    if (!current || s.accountDomain!==scope.accountDomain || s.providerEpoch!==scope.providerEpoch) throw new MobileServiceError(409,'SOURCE_CHANGED');
  }});
  return {service,provider,offsets,calls:()=>calls,change:()=>{current=false;}};
}
test('Provider 分页签入完整设备账户范围，第二页读取真实 offset，其他设备游标拒绝',async()=>{
  const f=fixture(),signal=new AbortController().signal;
  const first=await f.service.dispatch({operation:'listNeteaseCharts',request:request({limit:1}),scope,signal});
  assert.equal(first.reply.status,200); const token=first.reply.body.nextCursor; assert.equal(typeof token,'string');
  const second=await f.service.dispatch({operation:'listNeteaseCharts',request:request({limit:1,cursor:token!}),scope,signal});
  assert.deepEqual(f.offsets,[0,1]); assert.equal(second.reply.body.nextCursor,null); assert.equal(second.reply.body.items[0]!.id,'chart-1');
  await assert.rejects(f.service.dispatch({operation:'listNeteaseCharts',request:request({limit:1,cursor:token!}),scope:{...scope,deviceId:'device-2'},signal}),
    (e:unknown)=>e instanceof MobileServiceError&&e.code==='CURSOR_INVALID');
  assert.equal(f.calls(),2);
});
test('Provider 迟到回复和发送前账户撤换都拒绝，不把失效回复当成功空页',async()=>{
  const f=fixture(),signal=new AbortController().signal;
  const first=await f.service.dispatch({operation:'listNeteaseCharts',request:request({limit:1}),scope,signal});
  f.change(); await assert.rejects(first.beforeSend(),(e:unknown)=>e instanceof MobileServiceError&&e.code==='SOURCE_CHANGED');
  const g=fixture(),read=g.provider.read;
  g.provider.read=async input=>{const r=await read(input);g.change();return r;};
  await assert.rejects(g.service.dispatch({operation:'listNeteaseCharts',request:request(),scope,signal}),/移动服务/);
});
test('Provider 独立上下文与正文 revision 必须一致，不能用正文授权另一账户',async()=>{
  const f=fixture();f.provider.read=async()=>({account:{accountDomain:'account-1',providerEpoch:'provider-1'},body:{accountDomain:'account-2',feedRevision:'feed-2',items:[],nextCursor:null},context:context(),nextOffset:null});
  await assert.rejects(f.service.dispatch({operation:'listNeteaseCharts',request:request(),scope,signal:new AbortController().signal}),
    (e:unknown)=>e instanceof MobileServiceError&&e.code==='SOURCE_CHANGED');
});
test('Provider abort 不返回迟到数据，未知操作及上游游标不转发',async()=>{
  const f=fixture(),controller=new AbortController();
  f.provider.read=async()=>{controller.abort();return {account:{accountDomain:'account-1',providerEpoch:'provider-1'},body:{accountDomain:'account-1',feedRevision:'feed-1',items:[],nextCursor:null},context:context(),nextOffset:null};};
  await assert.rejects(f.service.dispatch({operation:'listNeteaseCharts',request:request(),scope,signal:controller.signal}));
  const g=fixture();g.provider.read=async()=>({account:{accountDomain:'account-1',providerEpoch:'provider-1'},body:{accountDomain:'account-1',feedRevision:'feed-1',items:[],nextCursor:'upstream-secret'},context:context(),nextOffset:1});
  await assert.rejects(g.service.dispatch({operation:'listNeteaseCharts',request:request(),scope,signal:new AbortController().signal}),/移动服务/);
});
test('Provider 出站只保留合同字段，真实空页与服务失败分开',async()=>{
  const f=fixture();f.provider.read=async()=>({account:{accountDomain:'account-1',providerEpoch:'provider-1'},body:{accountDomain:'account-1',feedRevision:'feed-1',items:[],nextCursor:null},context:context(),nextOffset:null});
  const value=await f.service.dispatch({operation:'listNeteaseCharts',request:request(),scope,signal:new AbortController().signal});
  assert.deepEqual(Object.keys(value.reply.body).sort(),['accountDomain','feedRevision','items','nextCursor']);assert.equal(value.reply.body.items.length,0);
  f.provider.read=async()=>{throw new Error('私有端口失败，不应公开这个正文');};
  await assert.rejects(f.service.dispatch({operation:'listNeteaseCharts',request:request(),scope,signal:new AbortController().signal}),
    (e:unknown)=>e instanceof MobileServiceError&&e.code==='BUSY'&&!e.message.includes('私有端口'));
});
test('Provider 独立叶逐操作约束推荐/榜单 kind，不依赖后续编排补校验',async()=>{
 const f=fixture();f.provider.read=async()=>({account:{accountDomain:'account-1',providerEpoch:'provider-1'},body:{accountDomain:'account-1',feedRevision:'feed-1',items:[{id:'playlist-1',kind:'playlist',title:'合成集合',artworkId:null,trackCount:0,collectionRevision:'collection-1'}],nextCursor:null},context:context(),nextOffset:null});
 await assert.rejects(f.service.dispatch({operation:'listNeteaseCharts',request:request(),scope,signal:new AbortController().signal}));
 const g=fixture();await assert.rejects(g.service.dispatch({operation:'listNeteaseRecommendedPlaylists',request:{path:MOBILE_OPERATION_TABLE.listNeteaseRecommendedPlaylists.path,pathParameters:{},query:{},body:null},scope,signal:new AbortController().signal}));
});
