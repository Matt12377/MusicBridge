import { DatabaseSync } from 'node:sqlite';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { prepareOwnedDatasetDomain } from '../../src/collection/dataset-domain.js';
import { attachDatasetOwnerWorkerPort } from '../../src/collection/dataset-owner-worker.js';

/** 合法字段的孤立代理项在 JSON 中转义，用合成库覆盖完整字节预算。 */
export function widenLargeSnapshotModels(filePath: string, amount: number): void {
  const db = new DatabaseSync(filePath), text = '\ud800'.repeat(amount);
  try { db.prepare('UPDATE collection_models SET descriptor=?').run(JSON.stringify({ brand: text, name: text, edition: text, year: 1990,
    format: 'cassette', tapeType: 'II', identification: 'verified' })); }
  finally { db.close(); }
}

if (!isMainThread) {
  if (!parentPort) throw new Error('合成大快照所有者缺少父端口。');
  attachDatasetOwnerWorkerPort(parentPort, {
    prepare: (epoch, projection) => prepareOwnedDatasetDomain({ dataDirectory: workerData.dataDirectory, epoch, testMode: true, projection }),
  });
}
