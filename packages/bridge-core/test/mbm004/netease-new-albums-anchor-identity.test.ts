import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import {MOBILE_OPERATION_TABLE} from '@music-bridge/contracts';
import {createActualMobileNeteasePorts} from '../../src/netease/mobile-actual-ports.js';
import {createMobileContentProviderService} from '../../src/mobile/content-provider-service.js';
import {captureMobileContentRequest} from '../../src/mobile/content-protocol.js';
import {projectMobileReadResponse} from '../../src/netease/mobile-read-response.js';
import {MobileServiceError} from '../../src/mobile/types.js';
import type { NeteaseMobileReadPort } from '../../src/netease/types.js';

async function fixture(t: TestContext) {
 let cover='https://p1.music.126.net/synthetic-album.jpg?other=stable&param=120y120';
 let statistic=0; let publishTime=Date.UTC(2026,0,1), title='合成新碟', total=125;
 const client: NeteaseMobileReadPort={configured:true,async mobileAccount(){return {accountId:'700',providerEpoch:'epoch1'};},onMobileAccountInvalidated(){return ()=>{};},async awaitMobileQuiet(){},
 async mobileRead(r){assert.equal(r.operation,'new-albums'); if(r.operation !== 'new-albums') throw new Error('未授权的合成操作');return {providerEpoch:'epoch1',response:projectMobileReadResponse({body:{code:200,total,albums:Array.from({length:Math.min(r.limit,total-r.offset)},(_,n)=>({id:String(r.offset+n+1),name:title+String(r.offset+n+1),artists:[{name:'合成艺人'}],size:10,publishTime,picUrl:cover,updateTime:++statistic,playCount:statistic}))}},'new-albums')};}};
 const actual=createActualMobileNeteasePorts({client,serverId:'server1',datasetId:'dataset1',ownerEpoch:'owner1',identityKey32:new Uint8Array(32).fill(23),now:()=>1700000000000,assertCurrent:async()=>{}});
 const account=await actual.account.current(new AbortController().signal);assert.ok(account);
 const scope={serverId:'server1',datasetId:'dataset1',ownerEpoch:'owner1',deviceId:'device1',deviceEpoch:1,accessGeneration:1,...account};
 const provider=createMobileContentProviderService({provider:actual.provider,cursorKey:new Uint8Array(32).fill(19),now:()=>1700000000000,assertCurrent:s=>actual.assertCurrent(s,'acquire',new AbortController().signal)});
 t.after(async()=>{provider.close();await actual.close();});
 const page=(cursor?: string | null)=>provider.dispatch({operation:'listNeteaseNewAlbums',scope,signal:new AbortController().signal,request:captureMobileContentRequest('listNeteaseNewAlbums',{path:MOBILE_OPERATION_TABLE.listNeteaseNewAlbums.path,pathParameters:{},query:{limit:50,...(cursor?{cursor}:{})},body:null})});
 return {page,setCover:(v: string)=>cover=v,setTime:(v: number)=>publishTime=v,setTitle:(v: string)=>title=v,setTotal:(v: number)=>total=v};
}

test('M25只改变实际被512缩图替换的param不应改变新碟分页anchor',async t=>{
 const f=await fixture(t),first=await f.page();
 f.setCover('https://p1.music.126.net/synthetic-album.jpg?other=stable&param=640y640');
 const next=await f.page(first.reply.body.nextCursor);
 assert.equal(next.reply.body.items.length,50);
 assert.equal(next.reply.body.feedRevision,first.reply.body.feedRevision);
});

test('M25已有规范化对CDN别名及同年日期/未知统计不误拒，真实标题和total变化仍拒',async t=>{
 const f=await fixture(t),first=await f.page(),cursor=first.reply.body.nextCursor;
 f.setCover('http://p7.music.126.net/synthetic-album.jpg?other=stable&param=120y120');
 f.setTime(Date.UTC(2026,8,1));
 const next=await f.page(cursor);assert.equal(next.reply.body.feedRevision,first.reply.body.feedRevision);
 f.setTitle('合成真实改名');
 await assert.rejects(f.page(cursor),e=>e instanceof MobileServiceError&&e.code==='SOURCE_CHANGED');
 f.setTitle('合成新碟');f.setTotal(126);
 await assert.rejects(f.page(cursor),e=>e instanceof MobileServiceError&&e.code==='SOURCE_CHANGED');
});
