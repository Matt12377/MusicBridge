import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { type IpcRequest, type LocalPlayRequest, isLocalSourceUnsupported } from '@music-bridge/contracts';
import { createDatasetOwnerClient } from '../../src/collection/dataset-owner-client.js';
import { DatasetOwnerTransportError, isDatasetOwnerResponse, ownerRecord, type DatasetOwnerRequest, type DatasetOwnerResponse } from '../../src/collection/dataset-owner-protocol.js';
import { dispatchDatasetCommand } from '../../src/collection/dataset-dispatch.js';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { createDatasetCommandBoundary } from '../../src/recording/dataset-identity.js';
import { buildStoragePolicy } from '../../../../apps/desktop/scripts/build-storage-root.mjs';
const payload:LocalPlayRequest={schema_version:'1.2',request_id:'合成准备',route:'roon_audio_input',source_kind:'local_file',local_track_id:'合成未登记曲目',asset_id:'合成未登记资产',expected_asset_revision:'0',target:{core_id:'合成Core',zone_id:'合成Zone'},action:'PLAY_NOW'};
function request(body:unknown=payload,expectedDatasetId?:string):IpcRequest{return {version:1,id:randomUUID(),command:'localCatalog.prepare',payload:body,...(expectedDatasetId===undefined?{}:{expectedDatasetId})};}
async function directory(t:test.TestContext):Promise<string>{const storage=buildStoragePolicy(),tmp=storage.check(process.env.TMPDIR!,{mustExist:true}),parent=await mkdtemp(path.join(tmp,'musicbridge-local-prepare-owner-'));storage.check(parent,{mustExist:true});await chmod(parent,0o700);t.after(()=>rm(parent,{recursive:true,force:true}));return parent;}
function dump(file:string):unknown{const db=new DatabaseSync(file,{readOnly:true});try{return db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>({name:row.name,sql:row.sql,rows:db.prepare(`SELECT * FROM "${String(row.name).replaceAll('"','""')}" ORDER BY rowid`).all()}));}finally{db.close();}}
function worker(dataDirectory:string){return new Worker(new URL('../helpers/dataset-owner-domain-fixture.ts',import.meta.url),{execArgv:['--import','tsx'],workerData:{dataDirectory}});}
test('MBRS002 B3 owner：真实Worker三个动作均unsupported，普通注入与旧库scope拒绝，关闭不发送', {timeout:30_000},async t=>{
  const parent=await directory(t),w=worker(parent),fatal:string[]=[],endpoint=createDatasetOwnerClient({worker:w,onFatal:r=>fatal.push(r)});
  t.after(async()=>{if(w.threadId!==-1)await endpoint.close().catch(()=>w.terminate());});
  const identity=await endpoint.prepare(),file=path.join(parent,'collection.v1.sqlite'),before=dump(file);
  for(const action of ['PLAY_NOW','APPEND_MB_QUEUE','PLAY_NEXT_MB_QUEUE'] as const){const result=await endpoint.dispatch(request({...payload,action},identity.datasetId));assert.ok(isLocalSourceUnsupported(result));}
  for(const bad of [request(),request(payload,randomUUID()),request({...payload,path:'合成私有位置'},identity.datasetId),request({...payload,intent_generation:'1',attempt_id:'合成'},identity.datasetId)])await assert.rejects(endpoint.dispatch(bad));
  await assert.rejects(endpoint.dispatch({version:1,id:randomUUID(),command:'commandOutbox.execute',payload:{commandId:randomUUID(),datasetId:identity.datasetId,command:'localCatalog.prepare',payload},expectedDatasetId:identity.datasetId}));
  assert.deepEqual(dump(file),before);assert.deepEqual(fatal,[]);
  const closing=endpoint.close();await assert.rejects(endpoint.dispatch(request(payload,identity.datasetId)),e=>e instanceof DatasetOwnerTransportError && e.outcome==='not-sent');await closing;
  assert.equal(w.threadId,-1);assert.deepEqual(dump(file),before);
});
test('MBRS002 B3 dispatcher：原scope边界及真实Repository assertOpen先于unsupported，不把公开target提升权威',async t=>{
  const parent=await directory(t),collection=createCollectionRepository({filePath:path.join(parent,'collection.sqlite')});t.after(()=>collection.close());
  collection.list({offset:0,limit:1});
  const identity={datasetId:randomUUID(),assertCurrent(){collection.list({offset:0,limit:1});}},boundary=createDatasetCommandBoundary(identity);let closed=false;
  const runtime={collection,commandOutbox:boundary,assertOpen(){if(closed)throw new Error('合成owner已关闭');}};
  const before=dump(path.join(parent,'collection.sqlite'));assert.deepEqual(await dispatchDatasetCommand(runtime,request(payload,identity.datasetId)),{status:'unsupported',reason:'TARGET_AUTHORITY_UNAVAILABLE'});
  for(const bad of [request(),request(payload,randomUUID()),request({...payload,authorized:true},identity.datasetId),{...request(payload,identity.datasetId),trusted:true}])await assert.rejects(dispatchDatasetCommand(runtime,bad));
  closed=true;await assert.rejects(dispatchDatasetCommand(runtime,request(payload,identity.datasetId)),/已关闭/u);assert.deepEqual(dump(path.join(parent,'collection.sqlite')),before);
});
function rawRpc(worker: Worker, message: DatasetOwnerRequest): Promise<DatasetOwnerResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(deadline); worker.off('message', receive); worker.off('error', failed); worker.off('exit', exited);
    };
    const fail = (detail: string) => { if (settled) return; settled = true; cleanup(); reject(new Error(`合成owner ${message.operation}请求失败：${detail}`)); };
    const receive = (value: unknown) => {
      if (!ownerRecord(value) || value.epoch !== message.epoch) return;
      if (value.type === 'fatal') { fail('当前epoch报告fatal'); return; }
      if (value.type !== 'response' || value.requestId !== message.requestId) return;
      if (!isDatasetOwnerResponse(value) || value.operation !== message.operation) { fail('当前请求回执协议无效'); return; }
      if (settled) return; settled = true; cleanup(); resolve(value);
    };
    const failed = () => fail('实际Worker error事件');
    const exited = (code: number) => fail(`实际Worker在回执前退出，code=${code}`);
    // 请求期限只作失败收口；不以sleep、轮询或时间长短证明业务行为。
    const deadline = setTimeout(() => fail('有界请求期限到达，未收到回执'), 10_000);
    worker.on('message', receive); worker.on('error', failed); worker.on('exit', exited);
    if (worker.threadId === -1) { fail('实际Worker已退出，未发送'); return; }
    try { worker.postMessage(message); } catch { fail('实际Worker发送失败'); }
  });
}

test('MBRS002 B3 epoch：实际旧epoch9000prepare被忽略，当前序列完整且仍unsupported无业务写', {timeout:30_000},async t=>{
  const parent=await directory(t),w=worker(parent);t.after(async()=>{if(w.threadId!==-1)await w.terminate();});
  const epoch=randomUUID();let sequence=0;
  const envelope=(operation:DatasetOwnerRequest['operation'],req?:IpcRequest):DatasetOwnerRequest=>({version:1,epoch,type:'request',requestId:randomUUID(),sequence:++sequence,operation,...(req?{request:req}:{})});
  const ready=await rawRpc(w,envelope('prepare'));assert.equal(ready.ok,true);if(!ready.ok)assert.fail('owner准备失败');assert.ok(ownerRecord(ready.result));assert.equal(typeof ready.result.datasetId,'string');const datasetId=String(ready.result.datasetId),before=dump(path.join(parent,'collection.v1.sqlite'));
  const oldEpoch=randomUUID(),stale:DatasetOwnerRequest={version:1,epoch:oldEpoch,type:'request',requestId:randomUUID(),sequence:9000,operation:'dispatch',request:request(payload,datasetId)};
  const staleResponses:unknown[]=[];const watch=(value:unknown)=>{if(ownerRecord(value)&&value.epoch===oldEpoch)staleResponses.push(value);};w.on('message',watch);t.after(()=>w.off('message',watch));w.postMessage(stale);
  const fresh=envelope('dispatch',request(payload,datasetId));assert.equal(fresh.sequence,2);const response=await rawRpc(w,fresh);assert.equal(response.ok,true);if(!response.ok)assert.fail('当前epochprepare失败');assert.ok(isLocalSourceUnsupported(response.result));assert.deepEqual(staleResponses,[]);assert.deepEqual(dump(path.join(parent,'collection.v1.sqlite')),before);
  const exit=once(w,'exit');const closed=await rawRpc(w,envelope('close'));assert.equal(closed.ok,true);assert.deepEqual(await exit,[0]);
});
