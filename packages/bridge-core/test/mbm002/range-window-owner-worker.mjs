import { parentPort, workerData } from 'node:worker_threads';
import assert from 'node:assert/strict';
import { register } from 'tsx/esm/api';
register();
const { attachDatasetOwnerWorkerPort } = await import('../../src/collection/dataset-owner-worker.ts');
const { LocalFileSourcePool } = await import('../../src/stream/local-file-source.ts');
const { mobileRangeWindowCoreFacts } = await import('../../src/mobile/range-window-observer.ts');
const { responseFailure } = await import('../../src/shared/ipc-failure.ts');
const pool = new LocalFileSourcePool();
let lease;
attachDatasetOwnerWorkerPort(parentPort, { async prepare() {
  lease = await pool.prepare(workerData.descriptor, { ownerId: 'synthetic-real-owner-worker', attempt: 1, isCurrent: () => true });
  return { datasetId: workerData.datasetId, async dispatch() {}, commitBoot() {},
    async mobileMain(request) {
      assert.equal(request.kind, 'media-source'); const source = request.request;
      if (source.operation === 'verify') { await lease.verify(); return { kind: 'mobile-source-ack', operation: 'verify', handle: source.handle, readId: null, quiet: true }; }
      if (source.operation === 'close-read') return { kind: 'mobile-source-ack', operation: 'close-read', handle: source.handle, readId: source.readId, quiet: true };
      assert.equal(source.operation, 'read');
      mobileRangeWindowCoreFacts(() => undefined); await lease.verify();
      const iterator = lease.readSlice(source.start, source.start + source.maxBytes - 1, new AbortController().signal);
      let chunk; try { chunk = await iterator.next(); } finally { await iterator.return(undefined); }
      assert.equal(chunk.done, false); await lease.verify();
      return { kind: 'mobile-source-read', handle: source.handle, readId: source.readId, start: source.start, bytes: new Uint8Array(chunk.value) };
    },
    async close(before) { await before?.(); await pool.close();
      assert.equal(lease.state, 'CLOSED'); assert.equal(lease.resourceSnapshot().activeIo, 0);
      assert.equal(lease.file.handle.fd, -1); },
    failureForError(id) { return responseFailure(id, 'INTERNAL_ERROR', '合成真实Owner Worker受控失败'); },
  };
} });
