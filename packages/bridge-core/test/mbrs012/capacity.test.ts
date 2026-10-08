import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import * as dto from '@music-bridge/contracts';
import {createCollectionRepository} from '../../src/collection/repository.js';
import {createLocalSourceWritesStore} from '../../src/collection/local-source-writes-store.js';
import {SOURCE_WRITES_OPERATION,SourceWritesError,sourceWritesEvent,sourceWritesLedgerRow,sourceWritesRequestFingerprint,sourceWritesUnresolvedOperations,type SourceWritesEvent} from '../../src/collection/local-source-writes-journal.js';
import {physicalResourceLocks} from '../../src/stream/physical-resource-locks.js';
import {sourceServiceFixture} from './service-fixture.js';
import {stagedSourceArtwork} from './artwork-fixture.js';

const rowBytes=(event:SourceWritesEvent):number=>Object.values(sourceWritesLedgerRow(event)).reduce((bytes,text)=>bytes+Buffer.byteLength(text),0);
const exhausted=(error:unknown):boolean=>error instanceof SourceWritesError&&error.code==='BUDGET_EXCEEDED';

test('012 真实publisher QUIET与facts后的COMPLETED缺closure容量输入仍预留4/op+16/plan：拒绝/original回执不能吃掉终结空间',async t=>{
  let closureArmed=false,closureRejected=false;
  const f=await sourceServiceFixture(t,{files:['owned-stereo-fixed-tags.flac'],phase(fact){if(fact.phase==='QUIET')closureArmed=true;},beforeCommit(action){if(closureArmed&&!closureRejected&&action==='local-source-writes:append'){closureArmed=false;closureRejected=true;throw new Error('自建容量夹具的protection-closed提交前确定ROLLBACK。');}}}),staged=await stagedSourceArtwork(f,'owned-cover-16.jpg');
  f.enable();const ready=await f.ready({kind:'tags',target:f.target(),fields:{title:{action:'set',value:'容量测试的真实已发布事实'}}});f.execute(ready);const p=await f.waitPlan(ready.planId,v=>['COMPLETED','FAILED','RECOVERY_REQUIRED'].includes(v.state));assert.equal(closureRejected,true);assert.equal(p.state,'RECOVERY_REQUIRED');assert.equal(physicalResourceLocks.combinedSnapshot().resources,0);await assert.rejects(f.close(),error=>error instanceof SourceWritesError&&error.code==='RELEASE_UNKNOWN');
  // QUIET持久后仅使实际closure事务确定回滚，不删除/改写原账本或停用保留触发器。
  // 冷存储随后用既有typed state构造COMPLETED缺marker容量输入；不是成功写回的业务结论。
  const repository=createCollectionRepository({filePath:f.filePath}),store=createLocalSourceWritesStore(repository.localCatalog),at=new Date().toISOString(),operationId=p.items[0]!.operationId,terminalReserve=(4+16)*65536;
  const totals=():number=>store.read(v=>v.projection.bytes);
  function rejection(large:boolean):SourceWritesEvent{
    if(large){const request:dto.PreviewLocalSourceWrites={datasetId:f.datasetId,commandId:randomUUID(),intent:{kind:'tags',target:{mode:'batch',trackIds:Array.from({length:100},()=>randomUUID())},fields:{title:{action:'set',value:'x'.repeat(512)},artist:{action:'set',value:'y'.repeat(512)},album:{action:'set',value:'z'.repeat(512)}}}};
      const receipt:dto.LocalSourceWritesReceipt={datasetId:f.datasetId,commandId:request.commandId,command:'localSourceWrites.preview',requestFingerprint:sourceWritesRequestFingerprint('localSourceWrites.preview',request),planId:null,jobId:null,outcome:'rejected',policy:null,issue:'BUDGET_EXCEEDED'};
      return sourceWritesEvent({version:1 as const,eventId:randomUUID(),datasetId:f.datasetId,planId:null,occurredAt:at,kind:'receipt' as const,command:'localSourceWrites.preview' as const,request,requestFingerprint:receipt.requestFingerprint,receipt,header:null,intent:null,ownerEpoch:f.epoch,policy:null});}
    const request:dto.SetLocalSourceWritesPolicy={datasetId:f.datasetId,commandId:randomUUID(),expectedPolicyRevision:'1',enabled:true},receipt:dto.LocalSourceWritesReceipt={datasetId:f.datasetId,commandId:request.commandId,command:'localSourceWrites.setPolicy',requestFingerprint:sourceWritesRequestFingerprint('localSourceWrites.setPolicy',request),planId:null,jobId:null,outcome:'rejected',policy:null,issue:'BUDGET_EXCEEDED'};
    return sourceWritesEvent({version:1 as const,eventId:randomUUID(),datasetId:f.datasetId,planId:null,occurredAt:at,kind:'receipt' as const,command:'localSourceWrites.setPolicy' as const,request,requestFingerprint:receipt.requestFingerprint,receipt,header:null,intent:null,ownerEpoch:f.epoch,policy:null});
  }
  try{
    const published=store.plan(f.datasetId,p.planId);assert.equal(published.items[0]!.item.state,'applied');assert.ok(published.events.some(event=>event.kind==='facts'&&event.fact.operationId===operationId));assert.ok(published.events.some(event=>event.kind==='phase'&&event.fact.operationId===operationId&&event.fact.phase==='QUIET'));assert.equal(published.events.some(event=>event.kind==='protection-closed'),false);
    store.state(f.datasetId,p.planId,'COMPLETED',[],true);assert.equal(store.plan(f.datasetId,p.planId).plan.state,'COMPLETED');
    assert.deepEqual(sourceWritesUnresolvedOperations(store.plan(f.datasetId,p.planId)),[operationId]);
    const limit=67108864-terminalReserve;
    for(const large of [true,false])for(;;){const batch:SourceWritesEvent[]=[];let bytes=totals();for(let i=0;i<100;i++){const event=rejection(large),encoded=rowBytes(event);if(bytes+encoded>limit)break;batch.push(event);bytes+=encoded;}if(!batch.length)break;store.transaction(view=>batch.forEach(event=>view.append(event)));}
    const occupied=totals();assert.ok(occupied>60*1024*1024);assert.ok(occupied+terminalReserve<=67108864);
    const readonly=new DatabaseSync(f.filePath);try{const actual=readonly.prepare('SELECT SUM(length(CAST(command_id AS BLOB))+length(CAST(fingerprint AS BLOB))+length(CAST(operation AS BLOB))+length(CAST(request AS BLOB))+length(CAST(result AS BLOB))+length(CAST(created_at AS BLOB))) AS bytes FROM local_catalog_ledger WHERE operation=?').get(SOURCE_WRITES_OPERATION);assert.equal(Number(actual!.bytes),occupied);}finally{readonly.close();}
    // 真实已编码的大拒绝回执及original事件共用相同append围栏；并发调用不能改变余量。
    // target/candidate/原图信息来自真实Artwork stage；此拒绝行的长file仅作私有六TEXT容量输入，
    // append被围栏拒绝，绝不声称该不存在的路径已写入/附加原件成功。
    const rejected=rejection(true),original=sourceWritesEvent({version:1 as const,eventId:randomUUID(),datasetId:f.datasetId,planId:null,occurredAt:at,kind:'original' as const,commandId:randomUUID(),requestFingerprint:'a'.repeat(64),target:staged.target,candidateId:staged.candidate.id,original:staged.original,contentRef:randomUUID(),file:`/${'p'.repeat(4000)}`});
    assert.ok(rowBytes(rejected)>limit-occupied);assert.ok(rowBytes(original)>limit-occupied);
    const attempts=await Promise.allSettled([Promise.resolve().then(()=>store.append(rejected)),Promise.resolve().then(()=>store.append(original))]);assert.equal(attempts.length,2);for(const result of attempts){assert.equal(result.status,'rejected');if(result.status==='rejected')assert.equal(exhausted(result.reason),true);}
    assert.equal(totals(),occupied);
    store.state(f.datasetId,p.planId,'RECOVERY_REQUIRED',['RELEASE_UNKNOWN'],true);
    // 原实际publisher已真实quiet且已释放，closure事务先前确定回滚；真实终结空间仍可写。
    store.append(sourceWritesEvent({version:1 as const,eventId:randomUUID(),datasetId:f.datasetId,planId:p.planId,occurredAt:at,kind:'protection-closed' as const,operationIds:[operationId]}),true);store.state(f.datasetId,p.planId,'COMPLETED',[],true);
    assert.deepEqual(sourceWritesUnresolvedOperations(store.plan(f.datasetId,p.planId)),[]);assert.ok(totals()<=67108864);store.capacity(0,0);
    t.diagnostic(`Source真实六TEXT容量私有副本：${f.filePath}；已占${occupied}，终结保留${terminalReserve}，未提升phase16KiB。`);
  }finally{store.close();repository.close();}
});
