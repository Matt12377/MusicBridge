import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createScanPlaybackBudget, SCAN_STABLE_PLAYBACK_QUIET_MS, type ScanPlaybackObservation } from '../src/library/scan-playback-budget.js';
import { createScanReadAdmission } from '../src/library/scan-read-admission.js';

function fixture(idleConcurrency: 1 | 2 | 8 = 8) {
  let time = 0, observation: ScanPlaybackObservation = { mode: 'idle' }, throws = false;
  const budget = createScanPlaybackBudget({ idleConcurrency, now: () => time, observe: () => {
    if (throws) throw new Error('controlled observation loss'); return observation;
  } });
  return { budget, set: (value: ScanPlaybackObservation) => { observation = value; }, time: (value: number) => { time = value; }, fail: (value: boolean) => { throws = value; } };
}
const context = () => ({ datasetId: randomUUID(), epoch: randomUUID() });

test('扫描预算：空闲保留原1/2/8上限，前台与未知活动始终为零', () => {
  for (const maximum of [1, 2, 8] as const) {
    const f = fixture(maximum); assert.equal(f.budget.read(), maximum);
    f.set({ mode: 'blocked' }); assert.equal(f.budget.read(), 0);
    f.time(100_000); assert.equal(f.budget.read(), 0);
    f.set({ mode: 'idle' }); assert.equal(f.budget.read(), maximum);
  }
});

test('扫描预算：只在同一合格原播放代经过完整稳定窗后最多一槽', () => {
  const f = fixture(); assert.equal(SCAN_STABLE_PLAYBACK_QUIET_MS, 2000);
  f.set({ mode: 'stable-owned', generation: 4 }); assert.equal(f.budget.read(), 0);
  f.time(1999); assert.equal(f.budget.read(), 0);
  f.time(2000); assert.equal(f.budget.read(), 1);
  f.time(99_000); assert.equal(f.budget.read(), 1);
  f.set({ mode: 'stable-owned', generation: 5 }); assert.equal(f.budget.read(), 0);
  f.time(100_999); assert.equal(f.budget.read(), 0);
  f.time(101_000); assert.equal(f.budget.read(), 1);
});

test('扫描预算：seek/起播/停止不确定及媒体新请求会重新封闭稳定窗', () => {
  const f = fixture(); f.set({ mode: 'stable-owned', generation: 7 }); f.budget.read(); f.time(2000);
  assert.equal(f.budget.read(), 1);
  f.set({ mode: 'blocked' }); assert.equal(f.budget.read(), 0);
  f.set({ mode: 'stable-owned', generation: 7 }); assert.equal(f.budget.read(), 0);
  f.time(4000); assert.equal(f.budget.read(), 1);
  f.budget.interrupt(); assert.equal(f.budget.read(), 0);
  f.time(5999); assert.equal(f.budget.read(), 0);
  f.time(6000); assert.equal(f.budget.read(), 1);
});

test('扫描预算：失观测、无效代次、时钟回退/非数都fail closed且重建稳定窗', () => {
  const f = fixture(); f.set({ mode: 'stable-owned', generation: 1 }); f.budget.read(); f.time(2000);
  assert.equal(f.budget.read(), 1); f.fail(true); assert.equal(f.budget.read(), 0);
  f.fail(false); assert.equal(f.budget.read(), 0); f.time(4000); assert.equal(f.budget.read(), 1);
  for (const generation of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    f.set({ mode: 'stable-owned', generation }); assert.equal(f.budget.read(), 0);
  }
  f.set({ mode: 'stable-owned', generation: 2 }); f.time(NaN); assert.equal(f.budget.read(), 0);
  f.time(5000); assert.equal(f.budget.read(), 0); f.time(7000); assert.equal(f.budget.read(), 1);
  f.time(6999); assert.equal(f.budget.read(), 0); f.time(7000); assert.equal(f.budget.read(), 0);
});

test('扫描准入：零票据期间也采样前台转换，不能错借旧稳定窗', () => {
  const f = fixture(), scope = context(); f.set({ mode: 'stable-owned', generation: 2 });
  const admission = createScanReadAdmission({ concurrency: 8, isBusy: () => false, getScanConcurrency: () => f.budget.read() });
  admission.observe(); f.time(2000); assert.deepEqual(admission.budget(scope), { concurrency: 1 });
  f.set({ mode: 'blocked' }); admission.observe(); assert.equal(admission.resourceCounts().permits, 0);
  f.set({ mode: 'stable-owned', generation: 2 }); f.time(2001); admission.observe();
  assert.deepEqual(admission.budget(scope), { concurrency: 0 }); f.time(4001);
  assert.deepEqual(admission.budget(scope), { concurrency: 1 }); admission.close();
});

test('扫描准入：预算收缩撤销原scan但不伪造quiet，显示不冒扫描许可', async () => {
  let concurrency: 0 | 1 | 2 | 8 = 8; const scope = context();
  const admission = createScanReadAdmission({ concurrency: 8, isBusy: () => false, isDisplayBusy: () => false, getScanConcurrency: () => concurrency });
  const a = admission.acquire(scope), b = admission.acquire(scope); assert.ok(a.status === 'granted' && b.status === 'granted');
  const watched = [admission.watchRevocation(scope, a.permitId), admission.watchRevocation(scope, b.permitId)];
  concurrency = 1; admission.observe(); assert.deepEqual(await Promise.all(watched), [{ reason: 'media-busy' }, { reason: 'media-busy' }]);
  assert.equal(admission.resourceCounts().permits, 2); assert.deepEqual(admission.budget(scope), { concurrency: 1 });
  assert.deepEqual(admission.status(scope), { status: 'deferred' }, '上限提示不冒充撤销票据已quiet或空闲');
  assert.deepEqual(admission.acquire(scope), { status: 'deferred' });
  admission.release(scope, a.permitId); admission.release(scope, b.permitId);
  const scan = admission.acquire(scope); assert.ok(scan.status === 'granted');
  assert.deepEqual(admission.acquire(scope), { status: 'deferred' });
  const display = admission.acquire(scope, 'local-album-display'); assert.ok(display.status === 'granted');
  concurrency = 0; admission.observe();
  assert.deepEqual(await admission.watchRevocation(scope, scan.permitId), { reason: 'media-busy' });
  assert.equal(admission.resourceCounts().revoked, 1);
  admission.release(scope, scan.permitId); admission.release(scope, display.permitId); admission.close();
  assert.deepEqual(admission.resourceCounts(), { permits: 0, revoked: 0, watches: 0, timers: 0, closed: true });
});

test('扫描准入：非授权预算提示受原总槽和冻结最大值约束，不发票、不释放票', () => {
  const scope = context(), admission = createScanReadAdmission({ concurrency: 2, isBusy: () => false, getScanConcurrency: () => 8 });
  assert.deepEqual(admission.budget(scope), { concurrency: 2 });
  assert.equal(admission.resourceCounts().permits, 0);
  const display = admission.acquire(scope, 'local-album-display'); assert.ok(display.status === 'granted');
  assert.deepEqual(admission.budget(scope), { concurrency: 2 }, '窗口最大值不受自己在途读瞬态影响，不能诱发批提交自取消');
  assert.deepEqual(admission.status(scope), { status: 'ready' });
  admission.release(scope, display.permitId); admission.close(); assert.deepEqual(admission.budget(scope), { concurrency: 0 });
});
