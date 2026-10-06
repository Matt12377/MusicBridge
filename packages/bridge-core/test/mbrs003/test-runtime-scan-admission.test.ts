import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createTestBridgeRuntime } from '../../src/runtime.js';
import type { ScanReadAdmission, ScanReadContext } from '../../src/library/scan-read-admission.js';

function acquire(admission: ScanReadAdmission, context: ScanReadContext): string {
  const result = admission.acquire(context);
  assert.equal(result.status, 'granted');
  if (result.status !== 'granted') assert.fail('安全合成runtime没有取得真实读取票据');
  return result.permitId;
}
test('MBRS003安全合成runtime：自身播放生命周期驱动真实admission busy/idle与shutdown，双槽和未quiet票据不伪归零', { timeout: 10_000 }, async t => {
  const runtime = createTestBridgeRuntime(); t.after(() => runtime.shutdown());
  const admission = runtime.getDatasetScanReadAdmission?.();
  assert.ok(admission, '安全CORE_TEST_MODE入口必须提供真实scan admission，不以解除测试模式连账号');
  assert.equal(runtime.getDatasetScanReadAdmission?.(), admission, '唯一runtime票据域不得每请求创造恒grant实例');
  const context = { epoch: randomUUID(), datasetId: randomUUID() };
  assert.deepEqual(admission.acquire(context), { status: 'deferred' }, '尚未ready必须拒读');
  await runtime.start();
  const first = acquire(admission, context), second = acquire(admission, context);
  assert.notEqual(first, second); assert.deepEqual(admission.acquire(context), { status: 'deferred' });
  const watch = admission.watchRevocation(context, first);
  const playing = runtime.playbackPlay('1000', 'lossless');
  assert.equal(runtime.getPlaybackState().state, 'playing');
  assert.deepEqual(await watch, { reason: 'media-busy' }); await playing;
  assert.deepEqual(admission.acquire(context), { status: 'deferred' });
  assert.deepEqual(admission.resourceCounts(), { permits: 2, revoked: 2, watches: 0, timers: 0, closed: false });
  await runtime.playbackPause(); assert.equal(runtime.getPlaybackState().state, 'paused');
  assert.deepEqual(admission.acquire(context), { status: 'deferred' }, 'paused仍由合成媒体状态持有busy');
  await runtime.playbackResume(); assert.equal(runtime.getPlaybackState().state, 'playing');
  assert.deepEqual(admission.acquire(context), { status: 'deferred' });
  await runtime.playbackStop(); assert.equal(runtime.getPlaybackState().state, 'idle');
  assert.deepEqual(admission.acquire(context), { status: 'deferred' }, 'idle不能替代原票据quiet确认；两撤销槽仍占用');
  admission.release(context, first); admission.release(context, second);
  assert.deepEqual(admission.resourceCounts(), { permits: 0, revoked: 0, watches: 0, timers: 0, closed: false });
  const afterStop = acquire(admission, context); admission.release(context, afterStop);
  // clear/logout自身reset也回到idle；不注入busy布尔值，不伪造生产controller/provider。
  for (const reset of [() => runtime.clearProviderCredential(), () => runtime.logoutProvider()]) {
    const id = acquire(admission, context), revocation = admission.watchRevocation(context, id);
    await runtime.playbackPlay('1001', 'lossless');
    assert.deepEqual(await revocation, { reason: 'media-busy' });
    await reset(); assert.equal(runtime.getPlaybackState().state, 'idle');
    admission.release(context, id); const afterReset = acquire(admission, context); admission.release(context, afterReset);
  }
  const last = acquire(admission, context), closingWatch = admission.watchRevocation(context, last);
  await runtime.shutdown();
  assert.deepEqual(await closingWatch, { reason: 'admission-closed' });
  assert.equal(runtime.getState().runtime, 'stopped');
  assert.deepEqual(admission.resourceCounts(), { permits: 1, revoked: 1, watches: 0, timers: 0, closed: true });
  assert.deepEqual(admission.acquire(context), { status: 'deferred' });
  admission.release(context, last);
  assert.deepEqual(admission.resourceCounts(), { permits: 0, revoked: 0, watches: 0, timers: 0, closed: true });
  // 本测试没有Worker/FD，release只测真实票据本体；不能作为Reader quiet、生产媒体优先级或App证据。
});
