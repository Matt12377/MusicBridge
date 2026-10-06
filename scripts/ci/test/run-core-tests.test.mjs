import test from 'node:test';
import assert from 'node:assert/strict';
import { coreTestPhases, runCoreTestPhases } from '../run-core-tests.mjs';

const isolated = 'recording-capacity-queued-stop.test.ts';
const phases = () => coreTestPhases(['b.test.ts', isolated, 'a.test.ts', 'helpers', 'README.md']);

test('Core 阶段保留全部原测试且恰好执行一次，排队 Stop 独立运行', () => {
  const result = phases();
  const files = result.flatMap(phase => phase.args.filter(arg => arg.startsWith('test/')));
  assert.deepEqual(files, ['test/a.test.ts', 'test/b.test.ts', `test/${isolated}`]);
  assert.equal(new Set(files).size, 3);
  assert.equal(result[0].args.some(arg => arg.startsWith('--test-concurrency')), false);
  assert.ok(result[1].args.includes('--test-concurrency=1'));
  assert.equal(result.some(phase => phase.args.some(arg => /pattern|skip/u.test(arg))), false);
});
test('缺失或重复排队 Stop 时明确失败，不默默减少清单', () => {
  for (const names of [[], ['a.test.ts'], [isolated, isolated, 'a.test.ts']]) {
    assert.throws(() => coreTestPhases(names), /清单不完整/u);
  }
});
test('原 Core 阶段失败时保留退出码并停止后续阶段', () => {
  let calls = 0;
  assert.equal(runCoreTestPhases(phases(), () => { calls += 1; return { status: 7 }; }, () => {}), 7);
  assert.equal(calls, 1);
});
test('排队 Stop 阶段失败不会被前一阶段成功覆盖', () => {
  const results = [{ status: 0 }, { status: 9 }];
  assert.equal(runCoreTestPhases(phases(), () => results.shift(), () => {}), 9);
  assert.equal(results.length, 0);
});
test('子进程启动错误或非自然结束不能成为成功', () => {
  for (const result of [{ status: null, signal: 'SIGTERM' }, { status: 0, error: new Error('启动失败') }, { status: null }]) {
    assert.equal(runCoreTestPhases(phases(), () => result, () => {}), 1);
  }
  assert.equal(runCoreTestPhases(phases(), () => ({ status: 0 }), () => {}), 0);
});
