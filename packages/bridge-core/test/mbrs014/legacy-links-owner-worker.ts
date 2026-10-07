import {parentPort,workerData} from 'node:worker_threads';
import {attachDatasetOwnerWorkerPort} from '../../src/collection/dataset-owner-worker.js';
import {createTestDatasetDomain} from '../../src/collection/dataset-domain.js';
import {createCollectionRepository} from '../../src/collection/repository.js';
import {installPhysicalResourceCoordinator} from '../../src/stream/physical-resource-locks.js';

if(!parentPort)throw new Error('自建关联 worker 缺少父端口。');
if(workerData.physicalResourceBuffer)installPhysicalResourceCoordinator(workerData.physicalResourceBuffer);
attachDatasetOwnerWorkerPort(parentPort,{prepare:async epoch=>{
  const repository=createCollectionRepository({filePath:workerData.filePath,...(workerData.publicationBarrier?{beforeCommit:(action:string)=>{
    const gate=new Int32Array(workerData.publicationBarrier);
    if(action==='local-legacy-links:append'&&Atomics.load(gate,1)===0){Atomics.store(gate,0,1);Atomics.notify(gate,0);Atomics.wait(gate,1,0,10000);if(Atomics.load(gate,1)!==1)throw new Error('自建 publication 围栏到期。');}
  }}:{})});
  return createTestDatasetDomain({collectionRepository:repository,localSourceEpoch:epoch,collectionDatasetIdentity:{datasetId:workerData.datasetId,assertCurrent:()=>{repository.list({offset:0,limit:1});}},closeConnections:()=>repository.close()});
}});
