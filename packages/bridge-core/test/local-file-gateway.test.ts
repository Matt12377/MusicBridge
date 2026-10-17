import './mbrs005/lifecycle.test.js';
import './mbrs005/http.test.js';
import './mbrs005/locks.test.js';
import './mbrs005/config-integration.test.js';
import './mbrs005/observation-binding.test.js';

import assert from 'node:assert/strict';
import test from 'node:test';
import {request as evidenceHttpRequest} from 'node:http';
import {open as evidenceOpen} from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import type {Logger} from '../src/shared/logger.js';
import type {RoonGatewayStage} from '../src/roon/types.js';
import type {StreamGateway} from '../src/stream/gateway.js';
import {physicalResourceLocks} from '../src/stream/physical-resource-locks.js';
import {gatewayFixture,authority,captureOwnedFileObservation,eventually} from './mbrs005/fixture.js';

type MediaEvidenceFields=Record<string,unknown>;
type TestMediaDiagnostic={diagnosticId:string;isCurrent():boolean;isOwned():boolean};
const mediaEvidenceFields=(records:unknown[]):MediaEvidenceFields[]=>
  (records as {event:string;fields:MediaEvidenceFields}[]).filter(record=>record.event==='local_playback_media_evidence').map(record=>record.fields);
function evidenceLocalUrl(gateway:StreamGateway,token:string,diagnostic:TestMediaDiagnostic,onStage?:(stage:RoonGatewayStage)=>void):string {
  // 保持RED可执行：原实现可忽略新增私有参数，行为断言必须捕获缺失证据。
  const localUrl=gateway.localStreamUrl as (token:string,onStage?:(stage:RoonGatewayStage)=>void,diagnostic?:TestMediaDiagnostic)=>string;
  return localUrl.call(gateway,token,onStage,diagnostic);
}
function assertSafeMediaRecords(records:MediaEvidenceFields[],forbidden:string[]):void {
  const encoded=JSON.stringify(records);
  for(const value of forbidden)assert.equal(encoded.includes(value),false,'私有媒体证据不得泄露原身份、路径或地址');
  assert.doesNotMatch(encoded,/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/iu);
  for(const fields of records){
    assert.match(String(fields.diagnosticId),/^diag-local-[a-f0-9]{64}$/u);
    assert.equal(typeof fields.currentOwned,'boolean');assert.equal(typeof fields.staleCallback,'boolean');
    for(const [key,value] of Object.entries(fields))if(typeof value==='number')assert.ok(Number.isSafeInteger(value) && value>=0 && value<=Number.MAX_SAFE_INTEGER,`${key}必须为有界非负整数`);
    for(const key of ['request_id','session_id','token','url','path','title','artist','album','message','stack'])assert.equal(Object.hasOwn(fields,key),false);
  }
}

test('安全媒体证据：自有loopback GET/Range完成量、HEAD零body和原FD租约保持',async t=>{
  const f=await gatewayFixture(t),diagnosticId='diag-local-'+ 'a'.repeat(64);
  const url=evidenceLocalUrl(f.gateway,f.token,{diagnosticId,isCurrent:()=>true,isOwned:()=>true});
  const cases=[{method:'GET',range:undefined,size:f.bytes.length,status:200},
    {method:'GET',range:'bytes=0-3',size:4,status:206},{method:'GET',range:'bytes=-17',size:17,status:206},
    {method:'HEAD',range:'bytes=0-3',size:0,status:200}] as const;
  for(const [index,input] of cases.entries()){
    const response=await fetch(url,{method:input.method,...(input.range?{headers:{Range:input.range}}:{})});
    assert.equal(response.status,input.status);const body=Buffer.from(await response.arrayBuffer());assert.equal(body.length,input.size);
    if(index===0)assert.deepEqual(body,f.bytes);
    if(index===1)assert.deepEqual(body,f.bytes.subarray(0,4));
    if(index===2)assert.deepEqual(body,f.bytes.subarray(-17));
    await eventually(()=>mediaEvidenceFields(f.events).some(fields=>fields.stage==='transfer-terminal' && fields.requestSequence===index+1),'同请求安全终态必须自然出现');
    const records=mediaEvidenceFields(f.events).filter(fields=>fields.requestSequence===index+1);
    assert.equal(records.length,2);assert.equal(records[0]!.stage,'request');const terminal=records[1]!;
    assert.equal(terminal.diagnosticId,diagnosticId);assert.equal(terminal.method,input.method);assert.equal(terminal.statusCode,input.status);
    assert.equal(terminal.pipelineBodyBytesObserved,input.size);assert.equal(terminal.observedBytesCapped,false);
    if(input.method==='HEAD'){assert.equal(terminal.outcome,'head-ended');assert.equal(Object.hasOwn(terminal,'completedPipelineBodyBytes'),false);}
    else {assert.equal(terminal.outcome,'body-completed');assert.equal(terminal.responseFinished,true);assert.equal(terminal.completedPipelineBodyBytes,body.length);}
  }
  assert.equal(f.fetches(),0);assert.equal(f.lease.state,'PREPARED');assert.deepEqual(f.lease.resourceSnapshot(),{activeRequests:0,activeIo:0,timer:1});
  assertSafeMediaRecords(mediaEvidenceFields(f.events),[f.token,f.url,url,f.absolute,f.descriptor.request_id,f.descriptor.target.core_id,f.descriptor.target.zone_id]);
  await f.gateway.stop();assert.equal(f.lease.state,'CLOSED');assert.deepEqual(f.lease.resourceSnapshot(),{activeRequests:0,activeIo:0,timer:0});
  const lock=physicalResourceLocks.acquireWrite([f.resource]);await lock.release();
});

test('安全媒体证据：受控断连仅记pipeline观察量，不伪completed或远端收到',async t=>{
  const f=await gatewayFixture(t);await f.registry.revokeLocal(f.token);
  const sparse=await evidenceOpen(f.absolute,'r+');await sparse.truncate(128*1024*1024);await sparse.close();
  f.descriptor.facts.asset.fileRevision='3';await captureOwnedFileObservation(f.descriptor,f.absolute);
  const registration=await f.registry.registerLocalSource(f.descriptor,authority(1,'synthetic-evidence-abort'),'wav'),lease=registration.lease;
  const handle=(lease as unknown as {file:{handle:FileHandle}}).file.handle,original=handle.read.bind(handle);
  let releaseRead!:()=>void,readCalls=0;const readGate=new Promise<void>(resolve=>{releaseRead=resolve;});t.after(()=>releaseRead());
  handle.read=(async(buffer:Buffer,offset:number,length:number,position:number)=>{if(++readCalls===2)await readGate;return original(buffer,offset,length,position);}) as FileHandle['read'];
  const url=evidenceLocalUrl(f.gateway,registration.token,{diagnosticId:'diag-local-'+ 'b'.repeat(64),isCurrent:()=>true,isOwned:()=>false});
  let receivedBytes=0;
  await new Promise<void>((resolve,reject)=>{
    let deadline:ReturnType<typeof setTimeout>;
    const req=evidenceHttpRequest(url,response=>{
      try{assert.equal(response.statusCode,200);}catch(error){releaseRead();clearTimeout(deadline);response.destroy();reject(error);return;}
      response.once('data',(chunk:Buffer)=>{receivedBytes=chunk.length;response.pause();response.destroy();releaseRead();clearTimeout(deadline);resolve();});
      response.on('error',()=>undefined);
    });
    req.on('error',error=>{releaseRead();clearTimeout(deadline);reject(error);});
    deadline=setTimeout(()=>{releaseRead();req.destroy();reject(new Error('受控断连未自然退出'));},3000);t.after(()=>{clearTimeout(deadline);req.destroy();});req.end();
  });
  await eventually(()=>mediaEvidenceFields(f.events).some(fields=>fields.stage==='transfer-terminal'),'断连必须留下安全终态');
  const terminal=mediaEvidenceFields(f.events).find(fields=>fields.stage==='transfer-terminal')!;
  assert.equal(terminal.outcome,'aborted');assert.equal(terminal.responseFinished,false);assert.equal(Object.hasOwn(terminal,'completedPipelineBodyBytes'),false);
  assert.ok(receivedBytes>0);assert.ok(Number(terminal.pipelineBodyBytesObserved)>=receivedBytes);assert.ok(Number(terminal.pipelineBodyBytesObserved)<lease.size);
  await eventually(()=>lease.resourceSnapshot().activeRequests===0 && lease.resourceSnapshot().activeIo===0,'断连仅关闭request，原租约FD仍归原所有者');
  assert.equal(lease.state,'PREPARED');assertSafeMediaRecords(mediaEvidenceFields(f.events),[registration.token,url,f.absolute,f.descriptor.request_id]);
  await f.gateway.stop();assert.equal(lease.state,'CLOSED');assert.equal(handle.fd,-1);assert.deepEqual(lease.resourceSnapshot(),{activeRequests:0,activeIo:0,timer:0});
});

test('安全媒体证据：16请求双记录、一次截断、stale不签owned和绑定释放',async t=>{
  const f=await gatewayFixture(t);let current=true;
  const url=evidenceLocalUrl(f.gateway,f.token,{diagnosticId:'diag-local-'+ 'c'.repeat(64),isCurrent:()=>current,isOwned:()=>true});
  for(let sequence=1;sequence<=18;sequence++){
    if(sequence===9)current=false;
    const response=await fetch(url,{method:'HEAD'});assert.equal(response.status,200);assert.equal((await response.arrayBuffer()).byteLength,0);
    if(sequence<=16)await eventually(()=>mediaEvidenceFields(f.events).some(fields=>fields.stage==='transfer-terminal' && fields.requestSequence===sequence),'有界请求终态必须关联正确序号');
  }
  const records=mediaEvidenceFields(f.events),requests=records.filter(fields=>fields.stage==='request'),terminals=records.filter(fields=>fields.stage==='transfer-terminal');
  assert.equal(requests.length,16);assert.equal(terminals.length,16);assert.equal(records.length,33);
  assert.deepEqual(requests.map(fields=>fields.requestSequence),Array.from({length:16},(_,i)=>i+1));assert.deepEqual(terminals.map(fields=>fields.requestSequence),Array.from({length:16},(_,i)=>i+1));
  assert.deepEqual(records.filter(fields=>fields.stage==='truncated').map(fields=>[fields.requestSequence,fields.requestLimit]),[[17,16]]);
  for(const fields of records.filter(fields=>Number(fields.requestSequence)>=9)){assert.equal(fields.staleCallback,true);assert.equal(fields.currentOwned,false);}
  assertSafeMediaRecords(records,[f.token,url,f.absolute,f.descriptor.request_id]);
  assert.equal(f.gateway.getDiagnosticResourceCounters().listenerCount,1);f.gateway.clearStageObserver(f.token);assert.equal(f.gateway.getDiagnosticResourceCounters().listenerCount,0);
  const after=await fetch(url,{method:'HEAD'});assert.equal(after.status,200);await after.arrayBuffer();assert.equal(mediaEvidenceFields(f.events).length,33);
  await f.gateway.stop();assert.equal(f.lease.state,'CLOSED');assert.deepEqual(f.lease.resourceSnapshot(),{activeRequests:0,activeIo:0,timer:0});
});

test('安全媒体证据：observer或Logger抛异常仍输出原body并关闭自有lease',async t=>{
  for(const injected of ['stage','current','owned','logger','legacy-logger'] as const)await t.test(injected,async child=>{
    const f=await gatewayFixture(child);let called=0;
    const fail=():never=>{called++;throw new Error('受控诊断失败，不改变传输');};
    if(injected==='logger' || injected==='legacy-logger'){
      const logger=(f.gateway as unknown as {options:{logger:Logger}}).options.logger;child.mock.method(logger,'info',fail);
    }
    const url=injected==='legacy-logger'?f.url:evidenceLocalUrl(f.gateway,f.token,{diagnosticId:'diag-local-'+ 'd'.repeat(64),
      isCurrent:injected==='current'?fail:()=>true,isOwned:injected==='owned'?fail:()=>true},injected==='stage'?fail:undefined);
    const response=await fetch(url);assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),f.bytes);
    await eventually(()=>f.lease.resourceSnapshot().activeRequests===0 && f.lease.resourceSnapshot().activeIo===0,'诊断异常后request必须自然释放');
    assert.ok(called>0,'受控异常接点必须实际被触发');assert.equal(f.lease.state,'PREPARED');assert.equal(f.fetches(),0);
    await f.gateway.stop();assert.equal(f.lease.state,'CLOSED');assert.deepEqual(f.lease.resourceSnapshot(),{activeRequests:0,activeIo:0,timer:0});
  });
});
