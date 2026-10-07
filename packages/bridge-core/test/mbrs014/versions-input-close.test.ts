import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { preparationFixture } from '../helpers/preparation-fixture.js';
import { physicalResourceLocks } from '../../src/stream/physical-resource-locks.js';

test('014 freeze 输入关闭：已接纳 snapshot 等待必须 join，close 后不能 start/launch', async t => {
  const f = await preparationFixture(t), proposal = await f.proposal(), commandId = randomUUID();
  let entered!: () => void, resume!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { resume = resolve; });
  const snapshot = f.sources.snapshot;
  t.mock.method(f.sources, 'snapshot', async (...args: Parameters<typeof snapshot>) => {
    const result = await snapshot(...args); entered(); await held; return result;
  });
  const freezing = f.versions.freeze({ commandId, planId: f.plan.id, sampleRate: 96000, proposalFingerprint: proposal.proposalFingerprint, userConfirmed: true }).then(value => ({ value, error: null }), error => ({ value: null, error }));
  await waiting;
  let returned = false;
  const closing = f.versions.close().then(() => { returned = true; });
  await setImmediate(); const returnedBeforeInputQuiet = returned;
  resume(); const result = await freezing; await closing;
  // 先使真实输入安静再断言，RED 也不留下悬挂 promise/真实 FD。
  assert.equal(returnedBeforeInputQuiet, false, 'close 必须等待已接纳的 freeze 输入，而非只有 active 发布');
  assert.equal(result.value, null, '关闭后的输入不得新建 job'); assert.ok(result.error);
  assert.equal(f.repository.versions.job(commandId), undefined);
  assert.equal(f.repository.versions.list(f.draft.draftId).masters.length, 0);
  assert.equal(physicalResourceLocks.snapshot().resources, 0);
});

test('014 freeze 并发输入：两项预算在 await 前后成立，第三项不能越过准入窗口', async t => {
  const f = await preparationFixture(t), proposal = await f.proposal();
  let entered!: () => void, resume!: () => void, count = 0;
  const waiting = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { resume = resolve; });
  const snapshot = f.sources.snapshot;
  t.mock.method(f.sources, 'snapshot', async (...args: Parameters<typeof snapshot>) => {
    const result = await snapshot(...args); if (++count >= 2) entered(); await held; return result;
  });
  const request = () => ({ commandId: randomUUID(), planId: f.plan.id, sampleRate: 96000, proposalFingerprint: proposal.proposalFingerprint, userConfirmed: true as const });
  const first = f.versions.freeze(request()), second = f.versions.freeze(request());
  await waiting; let acceptedThird = false, rejectedThird = false;
  const third = f.versions.freeze(request()).then(() => { acceptedThird = true; }, () => { rejectedThird = true; });
  await setImmediate(); const rejectedWhileHeld = rejectedThird;
  resume(); await Promise.allSettled([first, second, third]); await f.versions.idle();
  assert.equal(rejectedWhileHeld, true, '已接纳的异步输入也须占两项冻结预算');
  assert.equal(acceptedThird, false);
  assert.equal(physicalResourceLocks.snapshot().resources, 0);
});
