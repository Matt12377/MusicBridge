import { isCommandOutboxExecute } from '@music-bridge/contracts';
import assert from 'node:assert/strict';
import { parentPort, workerData } from 'node:worker_threads';
import { attachDatasetOwnerWorkerPort } from '../../src/collection/dataset-owner-worker.js';
import { prepareOwnedDatasetDomain } from '../../src/collection/dataset-domain.js';

if (!parentPort) throw new Error('合成所有者缺少父端口。');
const signals = workerData.signals instanceof SharedArrayBuffer ? new Int32Array(workerData.signals) : undefined;
attachDatasetOwnerWorkerPort(parentPort, {
  async prepare(epoch, projection) {
    const domain = await prepareOwnedDatasetDomain({ dataDirectory: workerData.dataDirectory, epoch, testMode: true, projection });
    return {
      datasetId: domain.datasetId,
      failureForError: domain.failureForError,
      commitBoot: () => domain.commitBoot(),
      exportCollectionModels: () => domain.exportCollectionModels!(),
      exportLargeCollectionModels: () => domain.exportLargeCollectionModels!(),
      readonlySnapshotStamp: () => domain.readonlySnapshotStamp!(),
      dispatchInternal: request => domain.dispatchInternal!(request),
      async dispatch(request) {
        const observed = ['collection.list', 'collectionProgress.current', 'collectionProgress.snapshot'].includes(request.command);
        if (observed && signals) Atomics.add(signals, 0, 1);
        // 仅此测试入口可制造确定性CPU争用；正式入口没有这个开关。
        if (observed && workerData.syntheticBusyMs) {
          const deadline = performance.now() + workerData.syntheticBusyMs;
          while (performance.now() < deadline) { /* 合成CPU负载 */ }
        }
        try {
          const result = await domain.dispatch(request);
          // 合成断链发生在实际持久写入之后、公开回执之前，不能伪称未受理。
          if (workerData.crashAfterLocalCommand === request.command || request.command === 'commandOutbox.execute' && isCommandOutboxExecute(request.payload) && workerData.crashAfterLocalCommand === request.payload.command) process.exit(19);
          if (workerData.crashAfterReceive && request.command === 'collection.receive') process.exit(19);
          return result;
        } finally { if (observed && signals) Atomics.add(signals, 1, 1); }
      },
      async close(beforeConnectionClose) {
        await domain.close(async () => {
          await beforeConnectionClose?.();
          assert.doesNotThrow(() => domain.collection.list({ offset: 0, limit: 1 }));
          if (signals) Atomics.store(signals, 2, 1);
        });
        assert.throws(() => domain.collection.list({ offset: 0, limit: 1 }));
        if (signals) Atomics.store(signals, 2, 2);
      },
    };
  },
});
