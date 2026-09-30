import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { PerformanceTraceRecorder } from '@music-bridge/contracts';
import { withPerformanceContext } from '../src/diagnostics/performance-trace.js';
import { traceDatabase, traceProviderApi } from '../src/diagnostics/performance-instrumentation.js';

test('SQL 观测保留连接、绑定、事务和结果，只记录数量与耗时', () => {
  const recorder = new PerformanceTraceRecorder({ component: 'core', enabled: true });
  const original = new DatabaseSync(':memory:');
  const db = traceDatabase(original);
  try {
    withPerformanceContext(recorder, recorder.context(), () => {
      db.exec('CREATE TABLE private_data(value TEXT); BEGIN');
      const statement = db.prepare('INSERT INTO private_data VALUES (?)');
      assert.equal(statement.run('私人合成绑定').changes, 1);
      assert.equal(db.prepare('SELECT value FROM private_data').get()?.value, '私人合成绑定');
      db.exec('ROLLBACK');
      assert.equal(db.prepare('SELECT COUNT(*) n FROM private_data').get()?.n, 0);
    });
    assert.equal(recorder.snapshot().events.filter(event => event.operation === 'sql' && event.phase === 'end').length, 5);
    assert.doesNotMatch(recorder.export(), /private_data|私人合成绑定|SELECT|INSERT|CREATE/);
  } finally { db.close(); }
});

test('Provider 观测保留同步值、this 与异步错误，不导出请求或返回内容', async () => {
  const recorder = new PerformanceTraceRecorder({ component: 'core', enabled: true });
  const failure = new Error('合成上游失败');
  const api = { value: 3, sync() { return this.value; }, async read(_secret: string) { return { value: this.value }; }, async fail() { throw failure; } };
  const observed = traceProviderApi(api);
  await withPerformanceContext(recorder, recorder.context(), async () => {
    assert.equal(observed.sync(), 3);
    assert.deepEqual(await observed.read('私人合成令牌'), { value: 3 });
    await assert.rejects(observed.fail(), error => error === failure);
  });
  assert.equal(recorder.snapshot().events.filter(event => event.operation === 'provider' && event.phase === 'end').length, 3);
  assert.equal(recorder.snapshot().inflightCount, 0);
  assert.doesNotMatch(recorder.export(), /私人合成令牌|合成上游失败/);
});

for (const failedRead of ['开始', '结束'] as const) {
  test(`Provider ${failedRead}诊断时钟故障不改变同步与异步调用的次数、结果或原错误`, async context => {
    const recorder = new PerformanceTraceRecorder({ component: 'core', enabled: true, now: () => 0 });
    const result = { value: '合成结果' }, failure = new Error('原上游错误');
    let clockReads = 0, calls = 0;
    context.mock.method(globalThis.performance, 'now', () => {
      clockReads++;
      if (failedRead === '开始' || clockReads > 1) throw new Error('合成诊断时钟故障');
      return 20;
    });
    const observed = traceProviderApi({
      sync() { calls++; return result; },
      async read() { calls++; return result; },
      fail() { calls++; throw failure; },
      async reject() { calls++; throw failure; },
    });
    await withPerformanceContext(recorder, recorder.context(), async () => {
      clockReads = 0;
      assert.equal(observed.sync(), result);
      clockReads = 0;
      assert.equal(await observed.read(), result);
      clockReads = 0;
      assert.throws(() => observed.fail(), error => error === failure);
      clockReads = 0;
      await assert.rejects(observed.reject(), error => error === failure);
    });
    assert.equal(calls, 4);
    const snapshot = recorder.snapshot();
    assert.equal(snapshot.inflightCount, 0);
    assert.equal(snapshot.counters.providerCallCount, 4);
    assert.deepEqual(snapshot.events.filter(event => event.phase === 'end').map(event => event.outcome), ['ok', 'ok', 'error', 'error']);
    assert.ok(snapshot.events.filter(event => event.phase === 'end').every(event => event.metrics.providerDurationMs === undefined));
    assert.equal(snapshot.counters.providerDurationMs, 0);
  });

  test(`SQL ${failedRead}诊断时钟故障不改变执行次数、持久结果或原错误`, context => {
    const recorder = new PerformanceTraceRecorder({ component: 'core', enabled: true, now: () => 0 });
    const original = new DatabaseSync(':memory:');
    let clockReads = 0, calls = 0;
    let businessError: unknown;
    try {
      original.exec('CREATE TABLE safe_result(value INTEGER)');
      const execute = original.exec.bind(original);
      context.mock.method(original, 'exec', (sql: string) => {
        calls++;
        try { return execute(sql); } catch (error) { businessError = error; throw error; }
      });
      context.mock.method(globalThis.performance, 'now', () => {
        clockReads++;
        if (failedRead === '开始' || clockReads > 1) throw new Error('合成诊断时钟故障');
        return 20;
      });
      const observed = traceDatabase(original);
      withPerformanceContext(recorder, recorder.context(), () => {
        clockReads = 0;
        assert.equal(observed.exec('INSERT INTO safe_result VALUES (7)'), undefined);
        clockReads = 0;
        assert.throws(() => observed.exec('SELECT * FROM missing_synthetic_table'), error => error === businessError);
      });
      assert.equal(calls, 2);
      assert.equal(original.prepare('SELECT COUNT(*) n FROM safe_result').get()?.n, 1);
      assert.ok(businessError instanceof Error);
      const snapshot = recorder.snapshot();
      assert.equal(snapshot.inflightCount, 0);
      assert.equal(snapshot.counters.sqlCount, 2);
      assert.deepEqual(snapshot.events.filter(event => event.phase === 'end').map(event => event.outcome), ['ok', 'error']);
      assert.ok(snapshot.events.filter(event => event.phase === 'end').every(event => event.metrics.sqlDurationMs === undefined));
      assert.equal(snapshot.counters.sqlDurationMs, 0);
    } finally { original.close(); }
  });
}

test('关闭诊断时 Provider 与 SQL 均不读取诊断时钟', async context => {
  const recorder = new PerformanceTraceRecorder({ component: 'core', now: () => { throw new Error('关闭时不得读取记录器时钟'); } });
  let clockReads = 0, calls = 0;
  context.mock.method(globalThis.performance, 'now', () => { clockReads++; throw new Error('关闭时不得读取诊断时钟'); });
  const observed = traceProviderApi({ async read() { calls++; return 3; } });
  const original = new DatabaseSync(':memory:');
  try {
    const db = traceDatabase(original);
    await withPerformanceContext(recorder, undefined, async () => {
      assert.equal(await observed.read(), 3);
      db.exec('CREATE TABLE safe_result(value INTEGER)');
      assert.equal(db.prepare('INSERT INTO safe_result VALUES (?)').run(7).changes, 1);
    });
    assert.equal(calls, 1);
    assert.equal(clockReads, 0);
    assert.equal(recorder.snapshot().events.length, 0);
  } finally { original.close(); }
});
