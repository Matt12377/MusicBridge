import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {MessageChannel,Worker} from 'node:worker_threads';
import * as dto from '@music-bridge/contracts';
import {createDatasetOwnerClient} from '../../src/collection/dataset-owner-client.js';
import {physicalResourceLocks} from '../../src/stream/physical-resource-locks.js';
import type {SourceServiceFixture} from './service-fixture.js';

export function sourceOwner(f:SourceServiceFixture,options:{sharedLocks?:boolean;faultPhase?:string;commitUnknown?:boolean;closureCommitUnknown?:boolean;rollbackFacts?:boolean;state?:SharedArrayBuffer;publicationGate?:SharedArrayBuffer}={}){
  const channel=new MessageChannel(),worker=new Worker(new URL('./source-owner-worker.ts',import.meta.url),{execArgv:['--import','tsx'],workerData:{filePath:f.filePath,datasetId:f.datasetId,sourceWritesPort:channel.port1,...(options.sharedLocks?{physicalResourceBuffer:physicalResourceLocks.buffer}:{}),...(options.faultPhase?{faultPhase:options.faultPhase}:{}),...(options.commitUnknown?{commitUnknown:true}:{}),...(options.closureCommitUnknown?{closureCommitUnknown:true}:{}),...(options.rollbackFacts?{rollbackFacts:true}:{}),...(options.state?{state:options.state}:{}),...(options.publicationGate?{publicationGate:options.publicationGate}:{})},transferList:[channel.port1]});
  const client=createDatasetOwnerClient({worker});let sequence=0;
  const waiting=new Map<string,{command:dto.LocalSourceWritesPrivateCommand;resolve(value:unknown):void;reject(error:unknown):void;timer:ReturnType<typeof setTimeout>}>();
  channel.port2.on('message',(raw:unknown)=>{let response:dto.SourceWritesMainResponse;try{assert.ok(raw&&typeof raw==='object');const id=Object.getOwnPropertyDescriptor(raw,'requestId')?.value;assert.equal(typeof id,'string');const current=waiting.get(id);assert.ok(current);response=dto.localSourceWritesMainResponseSnapshot(raw,current.command);waiting.delete(id);clearTimeout(current.timer);if(response.ok)current.resolve(response.result);else current.reject(Object.assign(new Error(response.failure.error.message),{failure:response.failure}));}catch(error){for(const task of waiting.values()){clearTimeout(task.timer);task.reject(error);}waiting.clear();}});
  channel.port2.start();
  const main=<C extends dto.LocalSourceWritesPrivateCommand>(command:C,payload:dto.LocalSourceWritesPrivateCommandPayloads[C]):Promise<dto.LocalSourceWritesPrivateCommandResults[C]>=>{
    const requestId=randomUUID(),request=dto.localSourceWritesMainRequestSnapshot({version:1,type:'source-writes-request',requestId,sequence:++sequence,command,payload});
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{waiting.delete(requestId);reject(new Error('自建Source专用物理port请求超时。'));},10000);waiting.set(requestId,{command,resolve:value=>resolve(value as dto.LocalSourceWritesPrivateCommandResults[C]),reject,timer});channel.port2.postMessage(request);});
  };
  const request=<C extends dto.LocalSourceWritesCommand>(command:C,payload:dto.LocalSourceWritesCommandPayloads[C]):Promise<dto.LocalSourceWritesCommandResults[C]>=>client.dispatch({version:1,id:randomUUID(),expectedDatasetId:f.datasetId,command,payload}) as Promise<dto.LocalSourceWritesCommandResults[C]>;
  async function plan(planId:string):Promise<dto.LocalSourceWritesPlan>{const result=await request('localSourceWrites.get',{datasetId:f.datasetId,selector:{kind:'plan',planId}});assert.ok(result.kind==='plan'&&result.plan);return result.plan;}
  async function waitPlan(planId:string,predicate:(p:dto.LocalSourceWritesPlan)=>boolean):Promise<dto.LocalSourceWritesPlan>{const deadline=Date.now()+30000;for(;;){const p=await plan(planId);if(predicate(p))return p;if(Date.now()>=deadline)assert.fail(`真实Owner Source状态未到界：${p.state}`);await new Promise<void>(resolve=>setTimeout(resolve,10));}}
  async function confirm(p:dto.LocalSourceWritesPlan){assert.ok(p.planHash&&p.contextFingerprint);const confirm:dto.ConfirmLocalSourceWrites={datasetId:f.datasetId,commandId:randomUUID(),planId:p.planId,expectedViewRevision:p.viewRevision,scope:'SOURCE_FILES',range:p.range,planHash:p.planHash,contextFingerprint:p.contextFingerprint},challenge=await main('localSourceWrites.challenge',{datasetId:f.datasetId,confirm});return {confirm,challenge,accepted:await main('localSourceWrites.executeGranted',{datasetId:f.datasetId,confirm,grant:challenge.grant})};}
  async function close():Promise<void>{try{if(worker.threadId!==-1)await client.close();}finally{channel.port2.close();for(const task of waiting.values()){clearTimeout(task.timer);task.reject(new Error('自建Source端口关闭。'));}waiting.clear();if(worker.threadId!==-1)await worker.terminate();}}
  return {worker,client,main,request,plan,waitPlan,confirm,close,async boot(){const identity=await client.prepare();assert.equal(identity.datasetId,f.datasetId);await client.commitBoot();return identity;}};
}
