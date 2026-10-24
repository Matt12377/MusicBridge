import assert from 'node:assert/strict';
import { parentPort, workerData } from 'node:worker_threads';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { register } from 'tsx/esm/api';

register();
const { ownedSourceByteLength } = await import('../../src/mobile/owned-source-bytes.ts');
const { captureMobileContentCoreResponse } = await import('../../src/mobile/content-rpc.ts');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const scans = async work => {
  const original = Reflect.ownKeys; let count = 0;
  Reflect.ownKeys = value => { if (value instanceof Uint8Array) count++; return original(value); };
  try { return { value: await work(), count }; } finally { Reflect.ownKeys = original; }
};

if (workerData.role === 'main') {
  parentPort.on('message', async packet => {
    if (packet.kind === 'close') { parentPort.close(); return; }
    try {
      const before = ownedSourceByteLength(packet.response.result.bytes, 65536);
      const result = await scans(() => {
        let value = captureMobileContentCoreResponse(packet.response, packet.call);
        value = captureMobileContentCoreResponse(value, packet.call);
        return value;
      });
      assert.equal(result.value.action, 'source'); assert.equal(result.value.kind, 'source');
      parentPort.postMessage({ kind: 'main-read', before, after: ownedSourceByteLength(result.value.result.bytes, 65536),
        scans: result.count, sha256: hash(result.value.result.bytes), length: result.value.result.bytes.byteLength });
    } catch (error) { parentPort.postMessage({ kind: 'failed', message: error.message }); }
  });
  parentPort.postMessage({ kind: 'ready' });
} else {
  const { createMobileOwnerSourceService } = await import('../../src/mobile/source-service.ts');
  const { LocalFileSourcePool } = await import('../../src/stream/local-file-source.ts');
  const { LocalSourceFence } = await import('../../src/stream/local-source-fence.ts');
  const { isLocalSourceCaptureResult } = await import('../../src/collection/local-source-ticket-types.ts');
  const { isLocalLibraryTrackDetail } = await import('@music-bridge/contracts');
  const scope = new AsyncLocalStorage(), fence = new LocalSourceFence(workerData.capture.buffer);
  const leases = [], counters = kind => scope.getStore()?.push(kind);
  assert.equal(isLocalSourceCaptureResult(workerData.capture), true);
  assert.equal(isLocalLibraryTrackDetail(workerData.detail), true);
  // 只有测试旁注：原SourceService、原Pool及真实WAVE FD仍执行全部读取和验证。
  const originalPrepare = LocalFileSourcePool.prototype.prepare;
  LocalFileSourcePool.prototype.prepare = async function (...args) {
    const lease = await originalPrepare.apply(this, args), file = lease.file;
    const verify = file.verify.bind(file), read = file.handle.read.bind(file.handle);
    file.verify = async () => { counters('named'); return verify(); };
    file.handle.read = async (...arguments_) => { counters('read'); return read(...arguments_); };
    leases.push(lease); return lease;
  };
  const collection = { localCatalog: {
    privateMobileCandidates() { counters('selected'); return { total: 1, items: [{ trackId: workerData.detail.track.id, editionId: workerData.editionId }] }; },
    trackDetail() { return structuredClone(workerData.detail); },
    root() { return structuredClone(workerData.capture.facts.root); },
  } };
  const tickets = {
    captureMobile() { return structuredClone(workerData.capture); },
    revalidate() { counters('facts'); return fence.current; },
    release() { fence.revoke(); fence.assertQuiet(); },
  };
  const source = createMobileOwnerSourceService({ collection, tickets, datasetId: workerData.capture.datasetId,
    ownerEpoch: workerData.capture.epoch, assertCurrent() {} });
  const prepared = await source.dispatch({ operation: 'prepare', selection: workerData.selection });
  assert.equal(prepared.kind, 'mobile-source-prepared');
  parentPort.on('message', async packet => {
    if (packet.kind === 'close') {
      await source.close();
      assert.equal(source.resourceSnapshot().activeIo, 0); assert.equal(source.resourceSnapshot().retainedFences, 0);
      assert.equal(fence.references, 0);
      for (const lease of leases) { assert.equal(lease.state, 'CLOSED'); assert.equal(lease.file.handle.fd, -1); }
      parentPort.close(); return;
    }
    try {
      const events = [], result = await scope.run(events, () => scans(() => source.dispatch(packet.request)));
      parentPort.postMessage({ kind: 'owner-read', result: result.value, scans: result.count, events,
        owned: result.value.kind === 'mobile-source-read' ? ownedSourceByteLength(result.value.bytes, 65536) : null });
    } catch (error) { parentPort.postMessage({ kind: 'failed', message: error.message }); }
  });
  parentPort.postMessage({ kind: 'ready' });
}
