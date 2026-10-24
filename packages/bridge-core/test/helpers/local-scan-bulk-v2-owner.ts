import assert from 'node:assert/strict';
import { fstatSync } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { MessagePort, parentPort, workerData } from 'node:worker_threads';
import { attachDatasetOwnerWorkerPort } from '../../src/collection/dataset-owner-worker.js';
import { prepareOwnedDatasetDomain } from '../../src/collection/dataset-domain.js';
import { createMetadataReader } from '../../src/library/metadata-reader.js';
import { configureSharedRustMediaWorkerPool, getRustMediaWorkerPool, closeRustMediaWorkerPool } from '../../src/library/rust-media-worker.js';

if (!parentPort || !(workerData.control instanceof MessagePort) || !(workerData.signals instanceof SharedArrayBuffer)) throw new Error('合成八槽 Owner 缺少独立控制端口。');
const control: MessagePort = workerData.control, signals = new Int32Array(workerData.signals);
configureSharedRustMediaWorkerPool(8);
configureSharedRustMediaWorkerPool(8); // 同一可信容量可幂等，不能切换到其它容量。
assert.throws(() => configureSharedRustMediaWorkerPool(2));

let release!: () => void;
const held = new Promise<void>(resolve => { release = resolve; });
control.on('message', value => { if (value === 'release') release(); });
control.start();

// 仅此测试环境延迟原 FileHandle.read 的完成；身份检查、FD、Rust RPC 和 close 全走生产链。
const sample = await open(workerData.sample, 'r');
const prototype = Object.getPrototypeOf(sample) as { read: (this: FileHandle, ...args: unknown[]) => Promise<unknown> };
const originalRead = prototype.read;
await sample.close();
const sourceFds = new Set<number>(), enteredFds = new Set<number>();
prototype.read = async function(this: FileHandle, ...args: unknown[]): Promise<unknown> {
  if (sourceFds.has(this.fd)) {
    if (!enteredFds.has(this.fd)) {
      enteredFds.add(this.fd); Atomics.add(signals, 2, 1);
      if (enteredFds.size === 8) control.postMessage({ event: 'holding', fds: [...sourceFds] });
    }
    await held;
  }
  return Reflect.apply(originalRead, this, args);
};
const reader = createMetadataReader({ concurrency: 8, maxPending: 0, onLifecycle(event) {
  if (event.type === 'lease-acquired') { sourceFds.add(event.fd); Atomics.add(signals, 0, 1); }
  else if (event.type === 'lease-released') {
    try { fstatSync(event.fd); Atomics.add(signals, 4, 1); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EBADF') Atomics.add(signals, 4, 1); }
    sourceFds.delete(event.fd); Atomics.add(signals, 1, 1);
  }
} });

attachDatasetOwnerWorkerPort(parentPort, {
  async prepare(epoch, projection) {
    const domain = await prepareOwnedDatasetDomain({ dataDirectory: workerData.dataDirectory, epoch, projection,
      testMode: true, localScanReadProfile: 'bulk-v2', scanMetadataReader: reader });
    return { ...domain, async close(beforeConnectionClose) {
      try {
        await domain.close(beforeConnectionClose);
        assert.equal(sourceFds.size, 0); assert.equal(Atomics.load(signals, 0), Atomics.load(signals, 1));
        assert.throws(() => configureSharedRustMediaWorkerPool(2), '实际 close 后也不能把本环境改为其它容量');
        configureSharedRustMediaWorkerPool(8);
        getRustMediaWorkerPool(); await closeRustMediaWorkerPool();
        Atomics.store(signals, 3, 1); control.postMessage({ event: 'closed' });
      } finally { prototype.read = originalRead; control.close(); }
    } };
  },
});
