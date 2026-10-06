import { parentPort, workerData } from 'node:worker_threads';
import { stat } from 'node:fs/promises';
import { installPhysicalResourceCoordinator, physicalResourceLocks } from '../../dist/stream/physical-resource-locks.js';
import { withCheckedReadonlyMetadataSource, readonlySourceCandidateMetadata } from '../../dist/recording/source-files.js';
installPhysicalResourceCoordinator(workerData.buffer);
const controller = new AbortController();
let release;
const wait = new Promise(resolve => { release = resolve; });
parentPort.on('message', command => { if (command === 'cancel') controller.abort(); if (command === 'release') release(); });
try {
  if (workerData.mode === 'write') {
    const info = await stat(workerData.absolute, { bigint: true });
    const guard = physicalResourceLocks.acquireWrite([{ dev: String(info.dev), ino: String(info.ino) }]);
    parentPort.postMessage({ status: 'held' }); await wait; await guard.release();
  } else {
    const observed = await readonlySourceCandidateMetadata(workerData.root, workerData.relative);
    await withCheckedReadonlyMetadataSource(workerData.root, workerData.relative, observed.signature, controller.signal, async handle => {
      const bytes = Buffer.alloc(4); await handle.read(bytes, 0, 4, 0); parentPort.postMessage({ status: 'held', bytes: [...bytes] }); await wait;
    });
  }
  parentPort.postMessage({ status: 'released' });
} catch (error) { parentPort.postMessage({ status: 'rejected', code: error.code ?? error.name }); }
finally { parentPort.close(); }
