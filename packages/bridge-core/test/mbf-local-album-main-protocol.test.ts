import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { isLocalAlbumMainRequest, isLocalAlbumMainResponse, localAlbumMainFailure, type LocalAlbumMainRequest } from '../src/collection/local-album-browser/main-protocol.js'

const call = (): LocalAlbumMainRequest => ({ version: 1, type: 'local-album-main-request', id: randomUUID(), datasetId: randomUUID(),
  request: { command: 'localAlbum.query', payload: { query: '', rootId: null, filter: 'all', offset: 0, limit: 60 } } })
test('专辑Main私有通道：三命令闭集先检查原属性，未知操作与getter不进入克隆或执行', () => {
  const request = call(); assert.ok(isLocalAlbumMainRequest(request))
  assert.equal(isLocalAlbumMainRequest({ ...request, request: { command: 'localAlbum.apply', payload: {} } }), false)
  assert.equal(isLocalAlbumMainRequest({ ...request, actor: '并非实际许可' }), false)
  let invoked = 0
  const hidden = { ...request }; Object.defineProperty(hidden, 'request', { enumerable: true, get() { invoked++; return request.request } })
  assert.equal(isLocalAlbumMainRequest(hidden), false); assert.equal(invoked, 0)
})
test('专辑Main私有通道：回复必须绑定原调用/工作库/命令及分页条件，失败仅固定中文闭集', () => {
  const request = call(), failure = localAlbumMainFailure(request, 'SNAPSHOT_CHANGED')
  assert.ok(isLocalAlbumMainResponse(failure, request))
  for (const changed of [{ id: randomUUID() }, { datasetId: randomUUID() }, { command: 'localAlbum.tracks' }])
    assert.equal(isLocalAlbumMainResponse({ ...failure, ...changed }, request), false)
  assert.equal(isLocalAlbumMainResponse({ ...failure, error: { code: 'UNAVAILABLE', message: '内部任意错误信息' } }, request), false)
  assert.equal(isLocalAlbumMainResponse({ ...failure, error: { ...(failure.ok ? {} : failure.error), stack: '内部栈' } }, request), false)
  const result = { query: '', rootId: null, filter: 'all', offset: 0, limit: 60, total: 0, hasMore: false, items: [],
    counts: { all: 0, 'missing-artwork': 0, 'has-artwork': 0, 'cue-unsplit': 0, 'metadata-issue': 0, 'parse-failed': 0, 'loose-audio': 0, 'track-named-audio': 0, 'missing-lyrics': 0 } }
  const success = { version: 1, type: 'local-album-main-response', id: request.id, datasetId: request.datasetId,
    command: request.request.command, ok: true, result }
  assert.ok(isLocalAlbumMainResponse(success, request))
  const { ['missing-lyrics']: _lyricsCount, ...legacyCounts } = result.counts
  assert.equal(isLocalAlbumMainResponse({ ...success, result: { ...result, counts: legacyCounts } }, request), false)
  assert.equal(isLocalAlbumMainResponse({ ...success, result: { ...result, counts: { ...result.counts, 'missing-lyrics': 1 } } }, request), false)
  assert.equal(isLocalAlbumMainResponse({ ...success, result: { ...result, offset: 60 } }, request), false)
})

import {createHash as context755Hash} from 'node:crypto'
import {EventEmitter as Context755Emitter} from 'node:events'
import {MessageChannel as Context755Channel,type Worker as Context755Worker} from 'node:worker_threads'
import {attachCoreRuntimePort as context755Attach,type UtilityPort as Context755Port} from '../src/utility-main.js'
import {createTestBridgeRuntime as context755Runtime} from '../src/runtime.js'
import {createDatasetOwnerClient as context755Client} from '../src/collection/dataset-owner-client.js'
import {attachDatasetOwnerWorkerPort as context755Worker} from '../src/collection/dataset-owner-worker.js'
import {datasetWorkbenchFrames as context755Frames,datasetWorkbenchControl as context755Control,datasetWorkbenchJson as context755Json,datasetWorkbenchSha as context755Sha,
  isDatasetWorkbenchFrame as context755Frame,DatasetWorkbenchWireError as Context755Error,type DatasetWorkbenchMeta as Context755Meta,
  type DatasetWorkbenchOwnerRequest as Context755OwnerRequest,type OwnedDatasetDomain as Context755Domain} from '../src/collection/dataset-owner-protocol.js'
import {LOCAL_ALBUM_TRACE_PREFIX as context755Prefix,copyLocalAlbumSafeTrace as context755Safe,type LocalAlbumSafeTrace as Context755Trace} from '../src/shared/library-read-trace.js'
import {responseFailure as context755Failure} from '../src/shared/ipc-failure.js'

/** 实际三端函数与受控内存端口；不宣称真实Worker进程、数据库、普通App或747首因。 */
test('辅助context772：慢owner仍在途时32个顺序context逐个释放槽位，原24预算与失败安全关联保留',{timeout:10000},async t=>{
  const channel=new Context755Channel(),events=new Context755Emitter(),rawIds:string[]=[],fatal:string[]=[],traces:Context755Trace[]=[];
  const sha=(id:string)=>context755Hash('sha256').update(id).digest('hex');
  t.mock.method(console,'info',(line:unknown)=>{if(typeof line==='string'&&line.startsWith(context755Prefix)){const safe=context755Safe(JSON.parse(line.slice(context755Prefix.length)));assert.ok(safe);traces.push(safe)}});
  const worker=new Context755Emitter() as Context755Emitter&{postMessage(value:unknown):void};
  worker.postMessage=value=>{if(context755Frame(value))rawIds.push(value.id);channel.port1.postMessage(value)};
  channel.port1.on('message',value=>worker.emit('message',value));
  channel.port1.on('close',()=>worker.emit('exit',0));
  const endpoint=context755Client({worker:worker as unknown as Context755Worker,onFatal:reason=>fatal.push(reason)});
  const datasetId=randomUUID();let ownerEntered!:()=>void,releaseOwner!:()=>void,closed=0,contextFailure:unknown;
  const entered=new Promise<void>(resolve=>{ownerEntered=resolve}),held=new Promise<void>(resolve=>{releaseOwner=resolve});
  context755Worker(channel.port2,{async prepare(epoch){
    const domain:Context755Domain={datasetId,async dispatch(){return null},commitBoot(){},
      async workbenchContext(){if(contextFailure!==undefined)throw contextFailure;return {epoch,datasetId,ready:true}},
      async dispatchWorkbench(){throw new Error('本夹具只允许context和受控慢owner')},
      async dispatchWorkbenchOwner(){ownerEntered();await held;throw new Error('受控慢owner释放后原失败收口')},
      async closeWorkbench(){},async close(before){await before?.();closed++},
      failureForError:id=>context755Failure(id,'INTERNAL_ERROR','受控领域失败')};
    return domain;
  }});
  const identity=await endpoint.prepare(),runtime=context755Runtime({datasetOwnerEndpoint:endpoint});
  let listener:((event:{data:unknown})=>void)|undefined;
  const port:Context755Port={on(_event,receive){listener=receive},start(){},postMessage(value){events.emit('response',value)}};
  t.after(async()=>{releaseOwner();try{await runtime.shutdown()}finally{channel.port1.close();channel.port2.close();events.removeAllListeners()}});
  await context755Attach(port,runtime,{beforeReady:()=>endpoint.commitBoot()});
  const slowRequest:Context755OwnerRequest={command:'read.albums',payload:{albums:[{albumId:'owned-context-album',rootId:randomUUID(),title:'自有合成专辑',artist:'自有合成作者',trackIds:[randomUUID()]}]}};
  const slow=endpoint.dispatchWorkbenchOwner!(slowRequest,{identity,signal:new AbortController().signal,deadlineAtMs:performance.now()+2000});
  let slowFinished=false;
  const slowRejected=assert.rejects(slow,error=>error instanceof Context755Error&&error.code==='NOT_READY').then(()=>{slowFinished=true});
  await entered;
  let sequence=0;
  async function context(){
    const body={},meta:Context755Meta={id:randomUUID(),epoch:identity.epoch,datasetId,sequence:++sequence,kind:'context',requestSha256:context755Sha(context755Json(body)),expiresAtMs:Date.now()+2000};
    rawIds.push(meta.id);
    const response=new Promise<{kind:string;part:string;code?:string}>(resolve=>{
      const receive=(value:unknown)=>{if(context755Frame(value)&&value.id===meta.id&&value.lane==='response'&&(value.part==='end'||value.part==='failure')){events.off('response',receive);resolve(value)}};
      events.on('response',receive);
    });
    for(const frame of context755Frames(meta,'request',body))listener!({data:frame});
    return {meta,result:await response};
  }
  for(let index=0;index<32;index++){assert.equal((await context()).result.part,'end');assert.equal(slowFinished,false,'短context不得等无关慢owner，原慢owner仍在途');}
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(slowFinished,false);
  assert.deepEqual(traces,[] as Context755Trace[],'成功辅助context不能输出begin、ok或link');
  // 真实未完成的begin仍占原24槽；不以顺序成功context的历史累计冒当前在途数。
  const unassembled:Context755Meta[]=[];
  for(let index=0;index<24;index++){
    const body={},meta:Context755Meta={id:randomUUID(),epoch:identity.epoch,datasetId,sequence:++sequence,kind:'context',requestSha256:context755Sha(context755Json(body)),expiresAtMs:Date.now()+2000};
    rawIds.push(meta.id);unassembled.push(meta);const begin=[...context755Frames(meta,'request',body)][0];assert.ok(begin);listener!({data:begin});
  }
  assert.deepEqual(traces,[] as Context755Trace[],'24项在途应全部被接受');
  const capped=await context();assert.equal(capped.result.part,'failure');assert.equal(capped.result.code,'NOT_READY');
  assert.equal(traces.length,1);assert.equal(traces[0]!.traceSha256,sha(capped.meta.id));assert.equal(traces[0]!.firstStage,'context.utility.budget');assert.equal(traces[0]!.mappedCode,'NOT_READY');
  for(const meta of unassembled)listener!({data:context755Control(meta,'cancel')});
  const budgetAndCancelRecords=traces.length;assert.equal(slowFinished,false);
  assert.equal((await context()).result.part,'end');assert.equal(traces.length,budgetAndCancelRecords);
  releaseOwner();await slowRejected;await endpoint.joinWorkbench!();
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal((await context()).result.part,'end');assert.equal(traces.length,budgetAndCancelRecords);
  let getterCalls=0;
  contextFailure=Object.defineProperties(new Error('context755不得泄露的原message'),{name:{get(){getterCalls++;return '非法name'}},code:{get(){getterCalls++;return '非法code'}}});
  const failed=await context();assert.equal(failed.result.part,'failure');assert.equal(failed.result.code,'NOT_READY');
  const owner=traces.find(value=>value.firstStage==='context.worker.owner');assert.ok(owner);assert.equal(owner.name,'UNKNOWN');assert.equal(owner.code,'UNKNOWN');assert.equal(owner.mappedCode,'NOT_READY');
  const client=traces.find(value=>value.firstStage==='context.client.response'&&value.traceSha256===owner.traceSha256);assert.ok(client);assert.equal(client.parentSha256,sha(failed.meta.id));
  assert.ok(traces.some(value=>value.traceSha256===sha(failed.meta.id)&&value.firstStage==='context.utility.owner'));
  assert.equal(getterCalls,0);
  const serialized=JSON.stringify(traces);for(const id of [...rawIds,datasetId,identity.epoch])assert.equal(serialized.includes(id),false);
  assert.equal(serialized.includes('context755不得泄露的原message'),false);assert.equal(serialized.includes('stack'),false);
  contextFailure=undefined;await endpoint.joinWorkbench!();await runtime.shutdown();assert.equal(closed,1);assert.deepEqual(fatal,[]);
});
