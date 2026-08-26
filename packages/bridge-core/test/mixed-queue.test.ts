import assert from 'node:assert/strict';
import test from 'node:test';
import { planMixedQueueTransition, resolveMixedQueueSource } from '../src/matching/mixed-queue.js';

function transition(from: 'roon' | 'netease', to: 'roon' | 'netease') {
  return planMixedQueueTransition({ activeSource: from, nextSource: to });
}

test('混合队列的四条 source transition 都先锁定当前曲目，再单一启动下一来源', () => {
  for (const [from, to] of [
    ['roon', 'roon'],
    ['roon', 'netease'],
    ['netease', 'roon'],
    ['netease', 'netease'],
  ] as const) {
    assert.deepEqual(transition(from, to), {
      stopActiveBeforeStart: true,
      nextSource: to,
    });
  }
});

test('队列项一旦开始就不因后台匹配结果变化而中途换源', () => {
  const locked = planMixedQueueTransition({ activeSource: 'netease', nextSource: 'roon' });
  assert.equal(locked.stopActiveBeforeStart, true);
  assert.equal(locked.nextSource, 'roon');
});

test('Smart 只有确认的 Roon candidate 才选择本地，否则回退网易云', () => {
  assert.equal(
    resolveMixedQueueSource('smart', {
      state: 'CONFIRMED',
      candidate: { reference: 'r', kind: 'track', title: 't' },
    }, true),
    'roon',
  );
  assert.equal(resolveMixedQueueSource('smart', { state: 'POSSIBLE' }, true), 'netease');
  assert.equal(resolveMixedQueueSource('smart', { state: 'CONFIRMED' }, false), 'netease');
  assert.equal(resolveMixedQueueSource('roon-only', { state: 'POSSIBLE' }, true), 'unavailable');
});
