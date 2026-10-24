import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {createCatalogHttpObservation,registerCatalogHttpNonce} from '../src/mobile/catalog-http-observation.js';
import {catalogTraceEvent,withCatalogTrace,emitCatalogTraceMarker,copyCatalogTraceMarker,MOBILE_CATALOG_MARKER_PREFIX,MOBILE_CATALOG_TRACE_PREFIX,type CatalogTraceSeed,type CatalogTraceRecord} from '../src/mobile/catalog-private-trace.js';
// @ts-expect-error 独立严格ESM reader；运行时导入真实闭集收口实现。
import {createCatalogPrivateReader as createContinuousReader} from '../../../scripts/diagnostics/mobile/catalog-http-sidecar-reader.mjs';
// @ts-expect-error 旧reader选择合同保留，不能因producer连续采样改变首错选择。
import {createCatalogPrivateReader as createLegacyReader} from '../../../scripts/diagnostics/mobile/catalog-http-sidecar-reader-legacy-v28.mjs';

const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
type Lease=NonNullable<ReturnType<ReturnType<typeof createCatalogHttpObservation>['begin']>>;
type Summary={schema:string;requestSha256:string;selection:string;complete:boolean;truncated:boolean;nonceCount:number;scopes:Array<{records:number;closes:Array<{expected:number;received:number;forwarded:number;dropped:number}>}>};

function harness(){
  const current:unknown[]=[],legacy:unknown[]=[],pending:string[]=[],leases:Lease[]=[];
  const reader=createContinuousReader({onRecord:(row:unknown)=>current.push(row)}),old=createLegacyReader({onRecord:(row:unknown)=>legacy.push(row)});
  const currentStreams=[reader.createStream(),reader.createStream()],oldStreams=[old.createStream(),old.createStream()];
  const send=(line:string,index=0)=>{currentStreams[index]!.write(line);oldStreams[index]!.write(line);};
  const observer=createCatalogHttpObservation(true,line=>send(line));
  const summaries=()=>current.filter((row:any)=>row.schema==='mb.catalog-http-sample.v1') as Summary[];
  function page(n:number,status:number|null,failed=false,finished=true,holdOwner=false){
    const requestSha256=hash('m48-http-'+n),lease=observer.begin(requestSha256);
    assert.ok(lease,'首个失败后合法新请求仍须取得私有观察scope');leases.push(lease);
    for(let nonce=0;nonce<2;nonce++){
      const seed:CatalogTraceSeed={schema:1,requestSha256,nonceSha256:hash('m48-nonce-'+n+'-'+nonce),offset:n*100,limit:100};
      registerCatalogHttpNonce(seed);
      for(const component of ['main','core','owner'] as const){
        let count=0;
        const sink=(line:string)=>{if(line.startsWith(MOBILE_CATALOG_TRACE_PREFIX))count++;if(component==='owner'&&holdOwner)pending.push(line);else send(line,component==='owner'?1:0);};
        withCatalogTrace(seed,component,()=>{
          catalogTraceEvent(component==='main'?'main.request':component==='core'?'core.receive':'owner.receive','begin');
          if(component==='owner'&&failed){
            catalogTraceEvent('owner.reply','reject',{error:{code:'BUSY'}});
            catalogTraceEvent('owner.item.close-proof','reject',{error:{code:'BUSY'},role:'cleanup'});
          }
        },sink);
        emitCatalogTraceMarker({...seed,schema:'mb.catalog-marker.v1',component,kind:'scope-close',epochMs:Date.now(),status:null,failed:false,finished:false,count,forwarded:count,dropped:0},sink);
      }
    }
    lease.finish(status,failed,finished);return requestSha256;
  }
  return{current,legacy,reader,old,observer,page,summaries,flush(){for(const line of pending.splice(0))send(line,1);},close(){for(const lease of leases)lease.finish(null,true,false);for(const stream of [...currentStreams,...oldStreams])stream.end();}};
}

test('M48首次timeout失败后success继续闭合，迟到Owner close不拼接下一页且旧首错选择不变',()=>{
  const h=harness();try{
    const first=h.page(1,200),failure=h.page(2,null,true,false,true);
    assert.equal(h.summaries().length,1);
    const after=h.page(3,200);
    assert.deepEqual(h.summaries().map(row=>row.requestSha256),[first,after]);
    h.flush();
    const samples=h.summaries();assert.equal(samples.length,3);assert.ok(samples.every(row=>row.complete&&!row.truncated&&row.nonceCount===2));
    for(const sample of samples)for(const scope of sample.scopes)for(const close of scope.closes){assert.equal(close.expected,close.received);assert.equal(close.received,close.forwarded);assert.equal(close.dropped,0);}
    assert.equal(samples.find(row=>row.requestSha256===failure)?.selection,'failure');
    const old=h.legacy.filter((row:any)=>row.schema==='mb.catalog-http-sample.v1') as Summary[];
    assert.equal(old.length,2);assert.equal(old.find(row=>row.selection==='first-failure')?.requestSha256,failure);
    assert.ok(old.every(row=>row.complete));
    const failures=h.current.filter((row:any)=>row.requestSha256===failure&&row.phase==='reject') as CatalogTraceRecord[];
    assert.equal(failures.filter(row=>row.role==='business').length,2);assert.equal(failures.filter(row=>row.role==='cleanup').length,2);
    assert.equal(h.reader.snapshot().invalidRecords,0);assert.equal(h.reader.snapshot().nonceCount,0);assert.equal(h.reader.snapshot().httpCount,0);
    assert.doesNotMatch(JSON.stringify(h.current),/token|cookie|credential|title|path|url|stack/iu);
  }finally{h.close();}
});

test('M48显式HTTP503/409失败仍各自收口且后续成功不被永久抑制',()=>{
  const h=harness();try{
    const requests=[h.page(11,503,true),h.page(12,200),h.page(13,409,true),h.page(14,200)];
    assert.deepEqual(h.summaries().map(row=>row.requestSha256),requests);
    assert.deepEqual(h.summaries().map(row=>row.selection),['failure','success','failure','success']);
    assert.ok(h.summaries().every(row=>row.complete&&!row.truncated));
    assert.equal(h.reader.snapshot().failureRequestsPublished,2);assert.equal(h.reader.snapshot().successRequestsPublished,2);
  }finally{h.close();}
});

test('M48观察总量严格4096个准入，非法/重复/并发拒绝不消耗配额，finish不重置或重复输出',()=>{
  let begins=0,terminals=0;
  const observer=createCatalogHttpObservation(true,line=>{const row=copyCatalogTraceMarker(JSON.parse(line.slice(MOBILE_CATALOG_MARKER_PREFIX.length)));assert.ok(row);if(row.kind==='http-begin')begins++;if(row.kind==='http-terminal')terminals++;});
  const leases:Lease[]=[];try{
    for(let i=0;i<16;i++){const lease=observer.begin(hash('cap-active-'+i));assert.ok(lease);leases.push(lease);}
    for(let i=0;i<100;i++){assert.equal(observer.begin(hash('cap-overlap-'+i)),undefined);assert.equal(observer.begin(hash('cap-active-0')),undefined);assert.equal(observer.begin('private-invalid'),undefined);}
    assert.equal(begins,16);for(const lease of leases){lease.finish(200,false,true);lease.finish(200,false,true);}
    for(let i=16;i<4096;i++){const lease=observer.begin(hash('cap-sequential-'+i));assert.ok(lease);leases.push(lease);lease.finish(200,false,true);}
    const excess=observer.begin(hash('cap-excess'));if(excess)leases.push(excess);
    assert.equal(excess,undefined,'4097号观察必须拒绝，不影响业务继续执行');
    assert.equal(begins,4096);assert.equal(terminals,4096);assert.equal(observer.begin(hash('cap-still-excess')),undefined);
  }finally{for(const lease of leases)lease.finish(null,true,false);}
});

test('M48HTTP结束或abort释放16个活动槽，独立observer不能突破共享活动上限',()=>{
  const first=createCatalogHttpObservation(true,()=>{}),second=createCatalogHttpObservation(true,()=>{}),leases:Lease[]=[];
  try{
    for(let i=0;i<16;i++){const lease=first.begin(hash('shared-'+i));assert.ok(lease);leases.push(lease);}
    assert.equal(second.begin(hash('shared-over')),undefined);leases[0]!.finish(null,true,false);
    const admitted=second.begin(hash('shared-after-abort'));assert.ok(admitted);leases.push(admitted);admitted.finish(200,false,true);
    const resumed=first.begin(hash('same-observer-after-abort'));assert.ok(resumed);leases.push(resumed);resumed.finish(200,false,true);
  }finally{for(const lease of leases)lease.finish(null,true,false);}
});

test('M48每HTTP nonce仍最多32，溢出显式dropped且不伪称完整',()=>{
  const lines:string[]=[],observer=createCatalogHttpObservation(true,line=>lines.push(line)),requestSha256=hash('nonce-cap'),lease=observer.begin(requestSha256);assert.ok(lease);
  try{
    for(let i=0;i<33;i++)registerCatalogHttpNonce({schema:1,requestSha256,nonceSha256:hash('nonce-cap-'+i),offset:0,limit:100});
    lease.finish(200,false,true);const terminal=lines.map(line=>copyCatalogTraceMarker(JSON.parse(line.slice(MOBILE_CATALOG_MARKER_PREFIX.length)))).find(row=>row?.kind==='http-terminal');
    assert.ok(terminal);assert.equal(terminal.count,32);assert.equal(terminal.dropped,1);
  }finally{lease.finish(null,true,false);}
});

test('M48默认关闭零产物；sink异常与重复finish不改变原工作返回或冻结后续scope',()=>{
  let writes=0,calls=0;const off=createCatalogHttpObservation(false,()=>writes++);assert.equal(off.begin(hash('off')),undefined);assert.equal(writes,0);
  const observer=createCatalogHttpObservation(true,()=>{writes++;throw new Error('合成输出失败');}),first=observer.begin(hash('broken-first'));assert.ok(first);
  const result=(()=>{calls++;first.finish(503,true,true);first.finish(503,true,true);return 7;})();assert.equal(result,7);assert.equal(calls,1);assert.equal(writes,2);
  const after=observer.begin(hash('broken-after'));assert.ok(after);after.finish(200,false,true);assert.equal(writes,4);
});
