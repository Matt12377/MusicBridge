import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCatalogHttpObservation,registerCatalogHttpNonce } from '../src/mobile/catalog-http-observation.js';
import { catalogTraceEvent,withCatalogTraceScope,copyCatalogTraceMarker,createCatalogTraceRelay,MOBILE_CATALOG_MARKER_PREFIX,MOBILE_CATALOG_TRACE_PREFIX } from '../src/mobile/catalog-private-trace.js';
// @ts-expect-error 外置独立ESM strict reader，测试真实导入源码。
import {createCatalogPrivateReader,copyCatalogPrivateMarker} from '../../../scripts/diagnostics/mobile/catalog-http-sidecar-reader-legacy-v28.mjs';
const hash=(x:string)=>createHash('sha256').update(x).digest('hex');
const seed=(n:number,offset=0)=>({schema:1 as const,requestSha256:hash('http'+n),nonceSha256:hash('nonce'+n),offset,limit:100});
const marker=(s:ReturnType<typeof seed>,kind:string,component='main',count=0,failed=false)=>({schema:'mb.catalog-marker.v1',requestSha256:s.requestSha256,
 nonceSha256:kind.startsWith('http-')?null:s.nonceSha256,offset:kind.startsWith('http-')?null:s.offset,limit:kind.startsWith('http-')?null:s.limit,
 component,kind,epochMs:1,status:kind==='http-terminal'?failed?503:200:null,failed,finished:kind==='http-terminal',count,forwarded:kind==='scope-close'?count:0,dropped:0});
const record=(s:ReturnType<typeof seed>,component:string,sequence=1,fail=false,role='business')=>({...s,component,sequence,epochMs:1,elapsedMs:0,rowOrdinal:fail?14:null,
 stage:component==='owner'?'owner.item.title':component+'.result',phase:fail?'reject':'ok',role,code:fail?'BUSY':'OK',matched:null,count:null});
const mark=(s:any,x:any)=>s.write(MOBILE_CATALOG_MARKER_PREFIX+JSON.stringify(x)+'\n');
const row=(s:any,x:any)=>s.write(MOBILE_CATALOG_TRACE_PREFIX+JSON.stringify(x)+'\n');
function harness(){const out:any[]=[],reader=createCatalogPrivateReader({onRecord:(r:unknown)=>out.push(r)}),a=reader.createStream(),b=reader.createStream();return {out,reader,a,b};}
function page(h:ReturnType<typeof harness>,n:number,offset:number,fail=false){const s=seed(n,offset);mark(h.a,marker(s,'http-begin'));mark(h.a,marker(s,'nonce-register'));
 for(const c of ['main','core','owner']){row(h.b,record(s,c,1,fail&&c==='owner'));mark(h.b,marker(s,'scope-close',c,1));}
 mark(h.a,marker(s,'http-terminal','main',1,fail));return s;}
test('M28任意后页：1200成功页后offset120000首拒仍保留，成功不积累活动nonce',()=>{
 const h=harness();for(let n=0;n<1200;n++){page(h,n,n*100);assert.equal(h.reader.snapshot().nonceCount,0);assert.equal(h.reader.snapshot().bufferedRecords,0);}
 page(h,1200,120000,true);page(h,1201,120100,true);h.a.end();h.b.end();
 const samples=h.out.filter(x=>x.schema==='mb.catalog-http-sample.v1');assert.equal(samples.length,2);assert.ok(samples.every(x=>x.complete));
 assert.equal(samples[1].selection,'first-failure');assert.equal(samples[1].scopes[0].offset,120000);
 assert.ok(h.out.some(x=>x.stage==='owner.item.title'&&x.offset===120000));assert.equal(h.out.some(x=>x.offset===120100),false);
 assert.ok(h.reader.snapshot().acceptedRecords<20);
});
test('M28两stream乱序：terminal与close先到，迟到Owner首错/cleanup到齐才发布',()=>{
 const h=harness(),s=seed(2,2700);mark(h.a,marker(s,'http-begin'));mark(h.a,marker(s,'nonce-register'));
 for(const c of ['main','core','owner'])mark(h.a,marker(s,'scope-close',c,c==='owner'?2:1));
 mark(h.a,marker(s,'http-terminal','main',1,true));assert.equal(h.out.length,0);
 row(h.b,record(s,'main'));row(h.b,record(s,'core'));row(h.b,record(s,'owner',1,true));assert.equal(h.out.length,0);
 row(h.b,record(s,'owner',2,true,'cleanup'));assert.equal(h.out[0].complete,true);assert.equal(h.out.filter(x=>x.phase==='reject').length,2);h.a.end();h.b.end();
});
test('M28nonce/register与begin跨流晚到，以精确seed关联，不按到达时间拼接',()=>{
 const h=harness(),s=seed(3,9500);row(h.b,record(s,'owner',1,true));mark(h.b,marker(s,'scope-close','owner',1));
 mark(h.a,marker(s,'http-terminal','main',1,true));mark(h.a,marker(s,'nonce-register'));mark(h.a,marker(s,'http-begin'));
 for(const c of ['main','core']){row(h.a,record(s,c));mark(h.a,marker(s,'scope-close',c,1));}
 assert.equal(h.out[0].complete,true);h.a.end();h.b.end();
});
test('M28并发首失败选择与单HTTP双nonce read/beforeSend关联',()=>{
 const h=harness(),s=seed(4,4800),s2={...seed(5,4800),requestSha256:s.requestSha256},other=seed(6,4900);
 for(const x of [s,other])mark(h.a,marker(x,'http-begin'));
 for(const x of [s,s2,other])mark(h.a,marker(x,'nonce-register'));
 mark(h.a,marker(s,'http-terminal','main',2,true));mark(h.a,marker(other,'http-terminal','main',1,true));
 for(const x of [other,s2,s])for(const c of ['main','core','owner']){row(h.b,record(x,c,1,c==='owner'));mark(h.b,marker(x,'scope-close',c,1));}
 h.a.end();h.b.end();const sample=h.out.find(x=>x.schema==='mb.catalog-http-sample.v1');assert.equal(sample.nonceCount,2);assert.equal(sample.complete,true);assert.equal(h.out.some(x=>x.requestSha256===other.requestSha256),false);
});
test('M28退出缺close与缺sequence不伪造complete，不以看到BUSY推断Owner已关闭',()=>{
 for(const hole of [false,true]){const h=harness(),s=seed(7);mark(h.a,marker(s,'http-begin'));mark(h.a,marker(s,'nonce-register'));
 row(h.b,record(s,'owner',hole?2:1,true));mark(h.a,marker(s,'http-terminal','main',1,true));
 if(hole)for(const c of ['main','core','owner'])mark(h.a,marker(s,'scope-close',c,c==='owner'?1:0));
 assert.equal(h.out.length,0);h.a.end();h.b.end();assert.equal(h.out[0].complete,false);assert.equal(h.out[0].incompleteReason,'missing-close-or-records');}
});
test('M28有界容量：HTTP16/nonce32/2048条2MiB，normal不能占首business/cleanup槽',()=>{
 const h=harness();for(let i=0;i<100;i++){const s=seed(i);mark(h.a,marker(s,'http-begin'));mark(h.a,marker(s,'nonce-register'));}
 const state=h.reader.snapshot();assert.ok(state.httpCount<=16&&state.nonceCount<=32&&state.bufferedRecords<=2048&&state.bufferedBytes<=2*1024*1024);h.a.end();h.b.end();
 const g=harness(),s=seed(8);mark(g.a,marker(s,'http-begin'));mark(g.a,marker(s,'nonce-register'));
 for(let i=1;i<=60;i++)row(g.b,record(s,'owner',i));row(g.b,record(s,'owner',61,true));row(g.b,record(s,'owner',62,true,'cleanup'));
 for(const c of ['main','core','owner'])mark(g.a,marker(s,'scope-close',c,c==='owner'?62:0));mark(g.a,marker(s,'http-terminal','main',1,true));
 assert.equal(g.out[0].complete,false);assert.equal(g.out[0].truncated,true);assert.equal(g.out.filter(x=>x.phase==='reject').length,2);assert.ok(g.out.length<=65);g.a.end();g.b.end();
});
test('M28闭集schema/恶意seed/未知字段拒绝，异常sink不透传私密值',()=>{
 const s=seed(9),m=marker(s,'scope-close','owner',1);
 for(const x of [ {...m,credential:'禁止输出'}, {...m,requestSha256:'raw-private'}, {...m,status:200}, new Proxy(m,{}) ]){assert.equal(copyCatalogTraceMarker(x),null);assert.equal(copyCatalogPrivateMarker(x),null);}
 const h=harness();mark(h.a,{...m,token:'禁止输出'});row(h.b,{...record(s,'owner',1,true),url:'禁止输出'});h.a.end();h.b.end();assert.equal(h.out.length,0);assert.equal(h.reader.snapshot().invalidRecords,2);
 const reader=createCatalogPrivateReader({onRecord:()=>{throw new Error('禁止输出');}}),a=reader.createStream(),g={a,b:a};
 page(g as any,9,0,true);a.end();assert.ok(reader.snapshot().sinkFailures>0);
});
test('M28默认关闭零产物；单次finish与异常sink不影响原业务',async()=>{
 const lines:string[]=[],off=createCatalogHttpObservation(false,x=>lines.push(x));assert.equal(off.begin(hash('off')),undefined);assert.equal(lines.length,0);
 const observer=createCatalogHttpObservation(true,()=>{throw new Error('合成sink失败');}),scope=observer.begin(hash('sink'))!;assert.ok(scope);scope.finish(503,true,true);scope.finish(503,true,true);
 // 首次诊断失败只结束本scope，后续请求仍可观察；异常sink和重复finish不改变原工作。
 const after=observer.begin(hash('after'));assert.ok(after);after.finish(200,false,true);
 let calls=0;const result=await withCatalogTraceScope(undefined,'owner',async()=>{calls++;catalogTraceEvent('owner.receive','begin');return 7;});assert.equal(result,7);assert.equal(calls,1);
});
test('M28Main relay显式双close释放注册，连续1000nonce不再永远卡在首32',()=>{
 const out:string[]=[],relay=createCatalogTraceRelay(true,x=>out.push(x));
 for(let i=0;i<1000;i++){const s=seed(i);assert.equal(relay.register(s),true);relay.feed(MOBILE_CATALOG_TRACE_PREFIX+JSON.stringify(record(s,'owner',1,true))+'\n');
 for(const c of ['core','owner'])relay.feed(MOBILE_CATALOG_MARKER_PREFIX+JSON.stringify(marker(s,'scope-close',c,c==='owner'?1:0))+'\n');}
 assert.equal(out.filter(x=>x.startsWith(MOBILE_CATALOG_TRACE_PREFIX)).length,1000);
});
test('M28HTTP准入最多16，结束释放；nonce登记与terminal数量来自实际Main登记',()=>{
 const out:string[]=[],observer=createCatalogHttpObservation(true,x=>out.push(x)),leases=[];
 for(let i=0;i<16;i++)leases.push(observer.begin(seed(i).requestSha256));assert.ok(leases.every(Boolean));assert.equal(observer.begin(hash('17')),undefined);
 registerCatalogHttpNonce(seed(0));leases[0]!.finish(200,false,true);const newest=observer.begin(hash('new'));assert.ok(newest);newest.finish(200,false,true);
 for(const lease of leases)lease?.finish(200,false,true);
 const terminal=out.map(x=>JSON.parse(x.slice(MOBILE_CATALOG_MARKER_PREFIX.length))).find(x=>x.kind==='http-terminal');assert.equal(terminal.count,1);
 // 清理本test最后活动键，不保留测试诊断状态。
 const m=out.map(x=>JSON.parse(x.slice(MOBILE_CATALOG_MARKER_PREFIX.length))).find(x=>x.kind==='http-begin'&&x.requestSha256===hash('new'));assert.ok(m);
});

test('M28relay达到64时显式forwarded揭示丢行，收到close即可发布incomplete而不永久等缺行',()=>{
 const h=harness(),s=seed(1400,22000),relay=createCatalogTraceRelay(true,line=>h.b.write(line));
 mark(h.a,marker(s,'http-begin'));mark(h.a,marker(s,'nonce-register'));assert.equal(relay.register(s),true);
 for(const c of ['core','owner'])for(let i=1;i<=40;i++)relay.feed(MOBILE_CATALOG_TRACE_PREFIX+JSON.stringify(record(s,c,i,i===40))+'\n');
 for(const c of ['core','owner'])relay.feed(MOBILE_CATALOG_MARKER_PREFIX+JSON.stringify(marker(s,'scope-close',c,40))+'\n');
 mark(h.a,marker(s,'scope-close','main',0));mark(h.a,marker(s,'http-terminal','main',1,true));
 assert.ok(h.out.length>0);assert.equal(h.out[0].complete,false);assert.equal(h.out[0].truncated,true);assert.equal(h.out[0].incompleteReason,'capacity-or-producer-drop');
 assert.equal(h.out.filter(x=>x.phase==='reject').length,2);h.a.end();h.b.end();
});
