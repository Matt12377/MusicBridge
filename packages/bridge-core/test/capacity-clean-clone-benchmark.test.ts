import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLEAN_CLONE_OBJECTS_LIMIT_CONFIG,
  runCleanCloneObjectsLimitBenchmark,
  type CleanCloneSample,
} from './benchmarks/recording-capacity-clean-clone.js';

const sample = (index: number): CleanCloneSample => ({
  index,
  childProgressMs: 1,
  stopReceivedToAbortMs: 1,
  stopReceivedToDriverStopInvokedMs: 1,
  stopReceivedToDriverStopAckMs: 1,
  stopReceivedToReceiptMs: 1,
  parentSendStopToReceiptMs: 1,
  parentReceiptToChildCloseMs: 1,
  driverCloseInvokedMs: 1,
  driverCloseResolvedMs: 1,
});

test('clean clone正式seam固定objects-limit、5+100、50秒/900秒且串行105次', async () => {
  const calls: Array<{ index: number; active: number; config: unknown }> = [];
  let active = 0, maximum = 0, now = 0;
  const result = await runCleanCloneObjectsLimitBenchmark({
    prepare: async config => {
      assert.deepEqual(config, CLEAN_CLONE_OBJECTS_LIMIT_CONFIG);
      return { token: 'synthetic' };
    },
    sample: async (_prepared, index, config) => {
      ++active; maximum = Math.max(maximum, active); calls.push({ index, active, config }); --active;
      now += 10;
      return sample(index);
    },
    summarize: values => ({ passed: values.length === 100 }),
    cleanup: async () => {},
    now: () => now,
    log: () => {},
  });
  assert.equal(result, 'PASS');
  assert.equal(calls.length, 105);
  assert.equal(maximum, 1);
  assert.deepEqual(calls.map(value => value.index), Array.from({ length: 105 }, (_, index) => index + 1));
  assert.ok(calls.every(value => value.config === CLEAN_CLONE_OBJECTS_LIMIT_CONFIG));
});

test('已启动样本返回算法/断言失败或阈值失败时分类PRODUCT_BUG', async () => {
  for (const mode of ['sample', 'threshold'] as const) {
    let calls = 0;
    const result = await runCleanCloneObjectsLimitBenchmark({
      prepare: async () => ({ token: 'synthetic' }),
      sample: async (_prepared, index) => { ++calls; return mode === 'sample' && index === 6 ? undefined : sample(index); },
      summarize: () => ({ passed: mode !== 'threshold' }),
      cleanup: async () => {},
      now: () => 0,
      log: () => {},
    });
    assert.equal(result, 'PRODUCT_BUG');
    assert.equal(calls, mode === 'sample' ? 6 : 105);
  }
});

test('准备、执行异常或清理失败分类HARNESS_BUG，不伪装产品成绩', async () => {
  for (const mode of ['prepare', 'sample', 'cleanup'] as const) {
    const result = await runCleanCloneObjectsLimitBenchmark({
      prepare: async () => { if (mode === 'prepare') throw new Error('setup'); return { token: 'synthetic' }; },
      sample: async (_prepared, index) => { if (mode === 'sample') throw new Error('runner'); return sample(index); },
      summarize: () => ({ passed: true }),
      cleanup: async () => { if (mode === 'cleanup') throw new Error('cleanup'); },
      now: () => 0,
      log: () => {},
    });
    assert.equal(result, 'HARNESS_BUG');
  }
});

test('900秒窗口不足以安全开始下一轮时停止为PRODUCT_BUG且不追加样本', async () => {
  let now = 0, calls = 0;
  const result = await runCleanCloneObjectsLimitBenchmark({
    prepare: async () => ({ token: 'synthetic' }),
    sample: async (_prepared, index) => { ++calls; now = index === 1 ? 847_001 : now; return sample(index); },
    summarize: () => ({ passed: true }),
    cleanup: async () => {},
    now: () => now,
    log: () => {},
  });
  assert.equal(result, 'PRODUCT_BUG');
  assert.equal(calls, 1);
});

test('900秒总窗口包含准备阶段，准备耗尽预算时不启动任何样本', async () => {
  let now = 0, calls = 0;
  const result = await runCleanCloneObjectsLimitBenchmark({
    prepare: async () => { now = 847_001; return { token: 'synthetic' }; },
    sample: async (_prepared, index) => { ++calls; return sample(index); },
    summarize: () => ({ passed: true }),
    cleanup: async () => {},
    now: () => now,
    log: () => {},
  });
  assert.equal(result, 'PRODUCT_BUG');
  assert.equal(calls, 0);
});
