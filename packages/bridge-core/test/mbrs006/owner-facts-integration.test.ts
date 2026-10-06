import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {catalogFixture} from './catalog-fixture.js';
import {LocalSourceFence,LocalFactsFenceBusy,LocalFactsCommitFatal,withLocalFactsMutation} from '../../src/stream/local-source-fence.js';
import {captureLocalFactsReadonly,LocalSourcePreparationError} from '../../src/application/local-source-resolver.js';
import {authorizeSourceDirectory} from '../../src/recording/source-files.js';
import {isLocalSourceCaptureResult} from '../../src/collection/local-source-ticket-types.js';

test('006提交围栏：扫描accepted变rejected而catalogRevision不变，也在COMMIT前永久撤销旧观察',async t=>{
 const f=await catalogFixture(t),capture=f.tickets.capture(f.requests[0]!),fence=new LocalSourceFence(capture.buffer),before=f.repository.localCatalog.asset(capture.facts.asset.id).fileRevision;
 const pending=await f.commit([capture.facts.relative],true);pending.apply();
 assert.equal(f.repository.localCatalog.asset(capture.facts.asset.id).fileRevision,before);assert.equal(fence.current,false);assert.equal(f.tickets.revalidate(capture.ticketId),false);assert.throws(()=>f.tickets.capture(f.requests[0]!));
});
test('006提交围栏：无关asset/元数据/库存提交不撤销当前票据，相关location变化同步撤销',async t=>{
 const f=await catalogFixture(t),c=f.tickets.capture(f.requests[0]!),fence=new LocalSourceFence(c.buffer),other=f.requests[1]!;
 f.repository.localCatalog.overrideMetadata({commandId:randomUUID(),trackId:c.facts.track.id,expectedRevision:null,fields:{title:'人工名称'}});
 f.repository.localCatalog.selectAsset({commandId:randomUUID(),trackId:other.local_track_id,expectedSelectionRevision:'1',assetId:other.asset_id});
 f.repository.receive({commandId:randomUUID(),model:{brand:'TDK',name:'SA',edition:'1990',year:1990,format:'cassette',tapeType:'II',identification:'verified'},lengthMinutes:90,quantities:{sealedBlank:8,openedBlank:0,legacyUsed:0,unclassified:0}});
 f.repository.localCatalog.createEdition({commandId:randomUUID(),title:'无关专辑关联',edition:'合成'});
 assert.equal(fence.current,true);
 const asset=c.facts.asset;f.repository.localCatalog.moveAsset({commandId:randomUUID(),assetId:asset.id,expectedLocationRevision:asset.locationRevision,expectedRootRevision:asset.rootRevision,relative:'新位置.wav'});
 assert.equal(fence.current,false);assert.equal(f.tickets.revalidate(c.ticketId),false);
});
test('006真实Worker claim阻止相关SQLite COMMIT，回滚后有限等待quiet，旧票不复活、新捕获新绑定',async t=>{
 const f=await catalogFixture(t),c=f.tickets.capture(f.requests[0]!),fence=new LocalSourceFence(c.buffer),signal=new SharedArrayBuffer(4);
 const worker=new Worker(new URL('./claim-worker.ts',import.meta.url),{execArgv:['--import','tsx'],workerData:{buffer:c.buffer,signal}});t.after(()=>worker.terminate());
 assert.equal((await once(worker,'message'))[0],'claimed');
 const track=c.facts.track,request={commandId:randomUUID(),trackId:track.id,expectedSelectionRevision:track.selectionRevision,assetId:track.assetId};
 let busy:unknown;try{f.repository.localCatalog.selectAsset(request);}catch(error){busy=error;}
 assert.ok(busy instanceof LocalFactsFenceBusy);assert.equal(busy.canRetry,true);assert.equal(fence.current,false);assert.equal(fence.references,1);assert.deepEqual(f.repository.localCatalog.track(track.id),track);
 const quiet=once(worker,'message');Atomics.store(new Int32Array(signal),0,1);Atomics.notify(new Int32Array(signal),0);await quiet;
 await withLocalFactsMutation(()=>f.repository.localCatalog.selectAsset(request));assert.equal(fence.references,0);assert.equal(f.tickets.revalidate(c.ticketId),false);
 const next=f.tickets.capture({...f.requests[0]!,request_id:randomUUID()});assert.notEqual(next.ticketId,c.ticketId);assert.notEqual(next.facts.track.selectionRevision,c.facts.track.selectionRevision);assert.equal(new LocalSourceFence(next.buffer).current,true);
});
test('006来源撤权同步封票；容量/释放/Owner seal不重新复活',async t=>{
 const f=await catalogFixture(t),captures=Array.from({length:16},()=>f.tickets.capture(f.requests[0]!));assert.throws(()=>f.tickets.capture(f.requests[0]!));
 f.tickets.release(captures.pop()!.ticketId);f.tickets.capture(f.requests[0]!);
 f.repository.sources.revoke({commandId:randomUUID(),id:f.source.id});assert.ok(captures.every(c=>!new LocalSourceFence(c.buffer).current));f.tickets.seal();assert.throws(()=>f.tickets.capture(f.requests[0]!));
});
for(const failure of ['COMMIT','ROLLBACK'] as const)test(`006实际SQLite ${failure}故障后Owner永久封票，不把未知提交当可重试业务失败`,async t=>{
 let forceRollback=false;const f=await catalogFixture(t,action=>{if(forceRollback && action==='local-catalog:select-asset')throw new Error('受控业务失败');}),c=f.tickets.capture(f.requests[0]!),fence=new LocalSourceFence(c.buffer);
 const original=DatabaseSync.prototype.exec;DatabaseSync.prototype.exec=function(sql:string){if(sql===failure)throw new Error(`受控${failure} IO故障`);return original.call(this,sql);};
 forceRollback=failure==='ROLLBACK';try{assert.throws(()=>f.repository.localCatalog.selectAsset({commandId:randomUUID(),trackId:c.facts.track.id,expectedSelectionRevision:c.facts.track.selectionRevision,assetId:c.facts.asset.id}),LocalFactsCommitFatal);}finally{DatabaseSync.prototype.exec=original;}
 assert.equal(fence.current,false);assert.throws(()=>f.tickets.capture(f.requests[0]!));assert.throws(()=>f.repository.localCatalog.track(c.facts.track.id),LocalFactsCommitFatal);
});
test('006私有捕获闭集拒reserved位/假buffer/非数字物理身份/交叉绑定',async t=>{
 const f=await catalogFixture(t),c=f.tickets.capture(f.requests[0]!);assert.equal(isLocalSourceCaptureResult(c),true);
 for(const mutate of [(v:any)=>v.buffer=new ArrayBuffer(16),(v:any)=>Atomics.store(new Int32Array(v.buffer),2,1),(v:any)=>v.facts.sourceRoot.dev='NaN',(v:any)=>v.facts.observation.assetId=randomUUID(),(v:any)=>v.extra='public']){const copy=structuredClone(c);if(copy.buffer instanceof SharedArrayBuffer)copy.buffer=LocalSourceFence.create().buffer;mutate(copy);assert.equal(isLocalSourceCaptureResult(copy),false);}
});

for(const kind of ['fileRevision','rootRevision'] as const)test(`006真实目录${kind}提交撤销对应票据，不依赖全库stamp`,async t=>{
 const f=await catalogFixture(t),c=f.tickets.capture(f.requests[0]!),fence=new LocalSourceFence(c.buffer),a=c.facts.asset;
 if(kind==='fileRevision')f.repository.localCatalog.replaceAsset({commandId:randomUUID(),assetId:a.id,expectedFileRevision:a.fileRevision,expectedLocationRevision:a.locationRevision,libraryRootId:a.libraryRootId,expectedRootRevision:a.rootRevision,relative:c.facts.relative,sha256:null,sampleFrames:null,timebaseHz:null});
 else {const source=f.repository.sources.authorize(randomUUID(),await authorizeSourceDirectory(f.media));f.repository.localCatalog.relinkRoot({commandId:randomUUID(),rootId:c.facts.root.id,expectedRevision:c.facts.root.revision,sourceRootId:source.id,role:'library'});}
 assert.equal(fence.current,false);assert.equal(f.tickets.revalidate(c.ticketId),false);assert.throws(()=>f.tickets.capture(f.requests[0]!));
});
test('006真实Owner目录CUE/segment明确unsupported，不当整文件观察读取',async t=>{
 const f=await catalogFixture(t),asset=f.repository.localCatalog.registerAsset({commandId:randomUUID(),libraryRootId:f.root.id,expectedRootRevision:f.root.revision,relative:'逻辑片段.flac',sha256:'c'.repeat(64),sampleFrames:'96000',timebaseHz:48000}),track=f.repository.localCatalog.createTrack({commandId:randomUUID(),assetId:asset.id,segment:{startFrame:'48000',endFrameExclusive:'96000',timebaseHz:48000}});
 assert.throws(()=>captureLocalFactsReadonly({...f.requests[0]!,request_id:randomUUID(),local_track_id:track.id,asset_id:asset.id,expected_asset_revision:asset.fileRevision},f.repository),error=>error instanceof LocalSourcePreparationError && error.code==='SEGMENT_UNSUPPORTED');
});
