import {parentPort,workerData,type MessagePort} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {createCollectionRepository} from '../../src/collection/repository.js';
import {createTestDatasetDomain} from '../../src/collection/dataset-domain.js';
import {createTestLocalSourceWritesService} from '../../src/collection/local-source-writes-service.js';
import {attachDatasetOwnerWorkerPort} from '../../src/collection/dataset-owner-worker.js';
import {installPhysicalResourceCoordinator,physicalResourceLocks} from '../../src/stream/physical-resource-locks.js';
import {SOURCE_WRITES_OPERATION} from '../../src/collection/local-source-writes-journal.js';
import type {OwnedDatasetDomain} from '../../src/collection/dataset-owner-protocol.js';

if(!parentPort)throw new Error('Source自建Owner线程缺少原端口。');
if(workerData.physicalResourceBuffer)installPhysicalResourceCoordinator(workerData.physicalResourceBuffer);
const sourcePort=workerData.sourceWritesPort as MessagePort,state=workerData.state?new Int32Array(workerData.state as SharedArrayBuffer):undefined;
let commitArmed=false,closureArmed=false,injectCommit=false,faultInjected=false,closureInjected=false;
const originalExec=DatabaseSync.prototype.exec;
if(workerData.commitUnknown||workerData.closureCommitUnknown)DatabaseSync.prototype.exec=function(sql:string){
  if(sql==='COMMIT'&&closureArmed&&workerData.closureCommitUnknown&&!closureInjected){const latest=this.prepare('SELECT request FROM local_catalog_ledger WHERE operation=? ORDER BY rowid DESC LIMIT 1').get(SOURCE_WRITES_OPERATION);if(typeof latest?.request==='string'&&JSON.parse(latest.request).kind==='protection-closed'){
      closureInjected=true;originalExec.call(this,sql);if(state){if(state.length>1)Atomics.store(state,1,physicalResourceLocks.combinedSnapshot().resources);Atomics.store(state,0,1);Atomics.notify(state,0);}throw new Error('自建Source真实释放后的closure COMMIT完成但ACK丢失');}}
  if(sql==='COMMIT'&&injectCommit){injectCommit=false;originalExec.call(this,sql);if(state){Atomics.store(state,0,1);Atomics.notify(state,0);}throw new Error('自建Source facts真实COMMIT完成后ACK丢失');}return originalExec.call(this,sql);
};
attachDatasetOwnerWorkerPort(parentPort,{privateSourceWritesPort:sourcePort,async prepare(epoch,projection){
  const repository=createCollectionRepository({filePath:String(workerData.filePath),beforeCommit(action){if(commitArmed&&action==='local-source-writes:append'){if(workerData.rollbackFacts&&!faultInjected){faultInjected=true;if(state){Atomics.store(state,0,1);Atomics.notify(state,0);}throw new Error('自建Source facts同步COMMIT之前确定ROLLBACK');}if(workerData.commitUnknown)injectCommit=true;}}});
  const domain=createTestDatasetDomain({collectionRepository:repository,collectionDatasetIdentity:{datasetId:String(workerData.datasetId),assertCurrent(){repository.list({offset:0,limit:1});}},localSourceEpoch:epoch,closeConnections:()=>repository.close()});
  await domain.localSourceWrites.close();
  const service=createTestLocalSourceWritesService({repository,datasetId:domain.datasetId,ownerEpoch:epoch,assertCurrent(){repository.list({offset:0,limit:1});},beforeMedia:()=>domain.localScan.yieldForMedia()},{phase(fact){
    if(fact.phase==='VERIFIED'&&(workerData.commitUnknown||workerData.rollbackFacts))commitArmed=true;
    if(fact.phase==='QUIET'&&state&&state.length>2)Atomics.store(state,2,physicalResourceLocks.combinedSnapshot().resources);
    if(workerData.faultPhase===fact.phase&&!faultInjected){faultInjected=true;if(state){if(state.length>1)Atomics.store(state,1,physicalResourceLocks.combinedSnapshot().resources);Atomics.store(state,0,1);Atomics.notify(state,0);}throw new Error(`自建Source阶段故障：${fact.phase}`);}
    if(workerData.publicationGate&&fact.phase==='CAPTURED'){const gate=new Int32Array(workerData.publicationGate as SharedArrayBuffer);Atomics.store(gate,0,1);Atomics.notify(gate,0);Atomics.wait(gate,1,0,10000);if(Atomics.load(gate,1)!==1)throw new Error('自建Source publication调度到界。');}
  }});
  await service.prepareRecoveryProtection();
  domain.localSourceWrites=service;
  const wrapped:OwnedDatasetDomain={...domain,dispatchSourceWritesMain(request,actor){return Promise.resolve().then<unknown>(()=>{switch(request.command){case 'localSourceWrites.attachOriginal':return service.attachOriginal(request.payload,actor);case 'localSourceWrites.challenge':return service.challenge(request.payload,actor);case 'localSourceWrites.executeGranted':return service.executeGranted(request.payload,actor);}});},async close(beforeConnectionClose){await service.close();await domain.close(beforeConnectionClose);}};
  // 真实domain和service准备完成后、Owner准备ACK之前才启用；不探测旧schema初始化COMMIT。
  if(workerData.closureCommitUnknown)closureArmed=true;
  return wrapped;
}});
