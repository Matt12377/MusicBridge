import { parentPort, workerData } from 'node:worker_threads';
import { attachDatasetOwnerWorkerPort } from '../../src/collection/dataset-owner-worker.js';
import { prepareOwnedDatasetDomain } from '../../src/collection/dataset-domain.js';

if (!parentPort) throw new Error('合成版本所有者缺少父端口。');
attachDatasetOwnerWorkerPort(parentPort, {
  prepare: (epoch, projection) => prepareOwnedDatasetDomain({ dataDirectory: workerData.dataDirectory, epoch, testMode: true, projection }),
});
