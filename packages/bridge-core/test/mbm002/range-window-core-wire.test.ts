import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { captureMobileContentCoreResponse } from '../../src/mobile/content-rpc.js';
import { createMobileRangeWindowProbe, mobileRangeWindowRpc, withMobileRangeWindowContext,
  copyMobileRangeWindowSnapshot, copyMobileRangeWindowCoreFrame } from '../../src/mobile/range-window-observer.js';
import { SOURCE_CALL, sourceBytes } from './source-byte-pipeline-fixture.js';

test('M32 默认512MiB真实Worker原utility/Core/source完整边界：旁注先于原业务回包，完整guard且自然close', { timeout: 15_000 }, async t => {
  const worker = new Worker(new URL('./range-window-core-worker.mjs', import.meta.url), {
    execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64, stackSizeMb: 4 },
  });
  t.after(() => worker.terminate());
  const exit = once(worker, 'exit');
  const ready = once(worker, 'message'); assert.equal((await ready)[0].event, 'core.ready');
  const probe = createMobileRangeWindowProbe({ enabled: true, windowSink() {} });
  const context = probe.claim({ requestId: '40000000-0000-4000-8000-000000000001', method: 'GET', operation: 'getMediaAsset', range: 'bytes=0-65535' });
  assert.ok(context);
  const transport = withMobileRangeWindowContext(context, () => mobileRangeWindowRpc(SOURCE_CALL.id, 'read', 'business', 'content.rpc.retained'))!;
  const seed = transport.seed(); assert.ok(seed);
  const messages: unknown[] = [];
  const completed = new Promise<void>((resolve, reject) => {
    worker.on('error', reject);
    worker.on('message', raw => {
      try {
        messages.push(raw);
        if (raw.type === 'mobile-range-window-core') { assert.ok(copyMobileRangeWindowCoreFrame(raw)); transport.coreFrame(raw); }
        if (raw.type === 'mobile-content-core-response') {
          const response = captureMobileContentCoreResponse(raw, SOURCE_CALL);
          assert.ok(response.action === 'source' && response.kind === 'source' && response.result.kind === 'mobile-source-read');
          assert.deepEqual(response.result.bytes, sourceBytes()); transport.settle(SOURCE_CALL.id);
        }
        if (raw.type === 'test.stats') { assert.deepEqual(raw, { type: 'test.stats', auth: 2, facts: 15, calls: 1 }); resolve(); }
      } catch (error) { reject(error); }
    });
  });
  worker.postMessage(seed); worker.postMessage(SOURCE_CALL); await completed;
  assert.deepEqual(messages.map(raw => (raw as { type: string }).type), ['mobile-range-window-core', 'mobile-content-core-response', 'test.stats']);
  probe.finish(context, { status: 206, finished: true, failed: false });
  const snapshot = probe.snapshot(); assert.ok(copyMobileRangeWindowSnapshot(snapshot));
  assert.equal(snapshot.malformedFrames, 0); assert.equal(snapshot.unmatchedFrames, 0);
  assert.equal(snapshot.requests[0]!.pendingSpans, 0);
  assert.equal(snapshot.requests[0]!.records.find(row => row.stage === 'core.source.ticket-facts.composite')!.count, 15);
  assert.equal(snapshot.requests[0]!.records.find(row => row.stage === 'core.source.scope.before')!.count, 1);
  assert.equal(snapshot.requests[0]!.records.find(row => row.stage === 'core.source.scope.after')!.count, 1);
  worker.postMessage({ type: 'test.close' }); assert.deepEqual(await exit, [0]); assert.equal(worker.threadId, -1);
});
