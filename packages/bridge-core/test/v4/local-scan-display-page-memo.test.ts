import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { ScanPreparedBatch } from '../../src/collection/local-scan-store.js';
import { DISPLAY_EXPECTED, displayBatchParses, displayMemoFixture, displayReads } from './scan-display-page-memo-fixture.js';

test('详情页解析帧：100行仍100次batch/origin/ledger实读，同一整批只解析一次且下页重核', async t => {
  const f = await displayMemoFixture(t, 100), parses = displayBatchParses(t, f.batch.batchId), reads = displayReads(t, f.db);
  const before = f.db.prepare('SELECT total_changes() n').get()!.n;
  f.page(() => { for (let index = 0; index < 100; index++) assert.deepEqual(f.read(index), DISPLAY_EXPECTED); });
  assert.deepEqual(reads.counts, { batch: 100, origin: 100, ledger: 100 });
  assert.equal(parses.count(), 1);
  f.page(() => { assert.deepEqual(f.read(), DISPLAY_EXPECTED); });
  assert.equal(parses.count(), 2);
  assert.equal(f.db.prepare('SELECT total_changes() n').get()!.n, before);
});

test('详情页解析帧：无页scope的单次调用仍核current与origin，只去重同原文解析', async t => {
  const f = await displayMemoFixture(t), parses = displayBatchParses(t, f.batch.batchId), reads = displayReads(t, f.db);
  assert.deepEqual(f.read(), DISPLAY_EXPECTED); assert.equal(parses.count(), 1);
  assert.deepEqual(f.read(), DISPLAY_EXPECTED); assert.equal(parses.count(), 2);
  assert.deepEqual(reads.counts, { batch: 2, origin: 2, ledger: 2 });
});

test('移动目录同步映射：原100项内容不变，真实projection在页内采用解析帧', async t => {
  const f = await displayMemoFixture(t, 100); await f.projection.refresh();
  const parses = displayBatchParses(t, f.batch.batchId), reads = displayReads(t, f.db);
  const result = f.projection.catalog({ operation: 'listTracks', serverId: 'server.synthetic-page', offset: 0, limit: 100,
    q: '', albumId: null, itemId: null, expectedRevision: null, catalogPlaybackEnabled: false });
  assert.equal(result.items.length, 100); assert.equal(result.total, 100);
  assert.deepEqual(reads.counts, { batch: 100, origin: 100, ledger: 100 }); assert.equal(parses.count(), 1);
});

test('详情页解析帧：完整原文变化必须重新guard，相同批ID或相同JSON结构不能代替文本相等', async t => {
  const f = await displayMemoFixture(t), parses = displayBatchParses(t, f.batch.batchId);
  let variant = 0; const reads = displayReads(t, f.db, raw => raw + ' '.repeat(variant));
  f.page(() => {
    assert.deepEqual(f.read(0), DISPLAY_EXPECTED); assert.equal(parses.count(), 1);
    variant = 1; assert.deepEqual(f.read(1), DISPLAY_EXPECTED); assert.equal(parses.count(), 2);
    variant = 0; assert.deepEqual(f.read(2), DISPLAY_EXPECTED); assert.equal(parses.count(), 2);
  });
  assert.deepEqual(reads.counts, { batch: 3, origin: 3, ledger: 3 });
});

test('详情页解析帧：行间真实撤销仍在下一行拒绝，不缓存Source授权或成功参数', async t => {
  const f = await displayMemoFixture(t), parses = displayBatchParses(t, f.batch.batchId);
  const root = f.repository.sources.root; let sourceReads = 0;
  t.mock.method(f.repository.sources, 'root', (id: string) => { sourceReads++; return root(id); });
  f.page(() => {
    assert.deepEqual(f.read(0), DISPLAY_EXPECTED);
    f.repository.sources.revoke({ commandId: randomUUID(), id: f.source.id });
    assert.equal(f.read(1), null);
  });
  assert.ok(sourceReads >= 2); assert.equal(parses.count(), 1);
});

test('详情页解析帧：每行仍实读ledger，原null不变且失败后的好行重新解析', async t => {
  const f = await displayMemoFixture(t), parses = displayBatchParses(t, f.batch.batchId), reads = displayReads(t, f.db);
  f.page(() => {
    assert.deepEqual(f.read(0), DISPLAY_EXPECTED); assert.equal(parses.count(), 1);
    reads.missingLedger(true); assert.equal(f.read(1), null);
    reads.missingLedger(false); assert.deepEqual(f.read(2), DISPLAY_EXPECTED); assert.equal(parses.count(), 2);
  });
  assert.ok(reads.counts.batch === 3 && reads.counts.ledger >= 3);
});

for (const invalid of ['schema', 'json'] as const) test(`详情页解析帧：${invalid}异常不缓存，保留throw且修复原文后重新核验`, async t => {
  const f = await displayMemoFixture(t), parses = displayBatchParses(t, f.batch.batchId); let bad = false;
  displayReads(t, f.db, raw => bad ? invalid === 'schema' ? '{"unknownField":true,' + raw.slice(1) : '{' + raw : raw);
  f.page(() => {
    assert.deepEqual(f.read(), DISPLAY_EXPECTED); assert.equal(parses.count(), 1);
    bad = true; assert.throws(() => f.read()); assert.throws(() => f.read()); assert.equal(parses.count(), 3);
    bad = false; assert.deepEqual(f.read(), DISPLAY_EXPECTED); assert.equal(parses.count(), 4);
  });
});

test('详情页解析帧：私有解析树递归冻结，返回DTO始终新建且不能污染下一行', async t => {
  const f = await displayMemoFixture(t), parses = displayBatchParses(t, f.batch.batchId);
  f.page(() => {
    const first = f.read(); assert.ok(first); first.durationMs = 9999;
    const parsed = parses.parsed[0] as ScanPreparedBatch;
    assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.items) && Object.isFrozen(parsed.items[0]!.fields)
      && Object.isFrozen(parsed.items[0]!.readFacts!.technical));
    assert.throws(() => { parsed.items[0]!.signature = '不得写入私有片段'; }, TypeError);
    const second = f.read(); assert.deepEqual(second, DISPLAY_EXPECTED); assert.notEqual(second, first); assert.equal(parses.count(), 1);
  });
});

test('详情页解析帧：嵌套帧及异常退出严格隔离，finally恢复外层且下一页不复用', async t => {
  const f = await displayMemoFixture(t), parses = displayBatchParses(t, f.batch.batchId), failure = new Error('合成嵌套异常');
  assert.throws(() => f.page(() => {
    assert.deepEqual(f.read(0), DISPLAY_EXPECTED); assert.equal(parses.count(), 1);
    assert.throws(() => f.page(() => { assert.deepEqual(f.read(1), DISPLAY_EXPECTED); throw failure; }), error => error === failure);
    assert.equal(parses.count(), 2); assert.deepEqual(f.read(2), DISPLAY_EXPECTED); assert.equal(parses.count(), 2);
    throw failure;
  }), error => error === failure);
  f.page(() => { assert.deepEqual(f.read(3), DISPLAY_EXPECTED); }); assert.equal(parses.count(), 3);
});

test('详情页解析帧：SQL同步重入独立核验，不借外层进行中的调用帧', async t => {
  const f = await displayMemoFixture(t), parses = displayBatchParses(t, f.batch.batchId), reads = displayReads(t, f.db);
  f.page(() => {
    assert.deepEqual(f.read(0), DISPLAY_EXPECTED); assert.equal(parses.count(), 1);
    reads.beforeBatch(() => { assert.deepEqual(f.read(1), DISPLAY_EXPECTED); });
    assert.deepEqual(f.read(2), DISPLAY_EXPECTED); assert.equal(parses.count(), 2);
  });
  assert.deepEqual(reads.counts, { batch: 3, origin: 3, ledger: 3 });
});

test('详情页解析帧：Promise返回当场拒绝，await后的调用不会保留页内片段', async t => {
  const f = await displayMemoFixture(t), parses = displayBatchParses(t, f.batch.batchId);
  let resume!: () => void, pending!: Promise<void>;
  const paused = new Promise<void>(resolve => { resume = resolve; });
  assert.throws(() => f.page(() => {
    pending = (async () => { assert.deepEqual(f.read(0), DISPLAY_EXPECTED); await paused;
      assert.deepEqual(f.read(1), DISPLAY_EXPECTED); assert.deepEqual(f.read(2), DISPLAY_EXPECTED); })();
    return pending;
  }));
  assert.equal(parses.count(), 1); resume(); await pending; assert.equal(parses.count(), 3);
});

test('详情页解析帧：64条LRU有界，超出只淘汰解析片段且不减少逐行证明', async t => {
  const f = await displayMemoFixture(t, 1), parses = displayBatchParses(t, f.batch.batchId); let variant = 0;
  const reads = displayReads(t, f.db, raw => raw + ' '.repeat(variant));
  f.page(() => {
    for (variant = 0; variant < 65; variant++) assert.deepEqual(f.read(), DISPLAY_EXPECTED);
    assert.equal(parses.count(), 65); variant = 0; assert.deepEqual(f.read(), DISPLAY_EXPECTED); assert.equal(parses.count(), 66);
  });
  assert.deepEqual(reads.counts, { batch: 66, origin: 66, ledger: 66 });
});

test('详情页解析帧：合法大原文超过留存估算时沿原解析路径，不改变8MiB输入预算或业务结果', async t => {
  const f = await displayMemoFixture(t, 1), parses = displayBatchParses(t, f.batch.batchId);
  const padding = ' '.repeat(2 * 1024 * 1024); const reads = displayReads(t, f.db, raw => padding + raw);
  f.page(() => { assert.deepEqual(f.read(), DISPLAY_EXPECTED); assert.deepEqual(f.read(), DISPLAY_EXPECTED); });
  assert.equal(parses.count(), 4); assert.deepEqual(reads.counts, { batch: 2, origin: 2, ledger: 2 });
});

test('详情页解析帧：嵌套活动帧共用留存上限，子帧超限回原路径并保留父帧', async t => {
  const f = await displayMemoFixture(t, 1), parses = displayBatchParses(t, f.batch.batchId);
  const padding = ' '.repeat(1024 * 1024); displayReads(t, f.db, raw => padding + raw);
  f.page(() => {
    assert.deepEqual(f.read(), DISPLAY_EXPECTED); assert.equal(parses.count(), 1);
    f.page(() => { assert.deepEqual(f.read(), DISPLAY_EXPECTED); }); assert.equal(parses.count(), 3);
    assert.deepEqual(f.read(), DISPLAY_EXPECTED); assert.equal(parses.count(), 3);
  });
});

test('详情页解析帧：原8MiB批次输入边界保留，超限拒绝后不能沿用旧片段', async t => {
  const f = await displayMemoFixture(t, 1), parses = displayBatchParses(t, f.batch.batchId); let oversize = false;
  const padding = ' '.repeat(8 * 1024 * 1024); displayReads(t, f.db, raw => oversize ? padding + raw : raw);
  f.page(() => {
    assert.deepEqual(f.read(), DISPLAY_EXPECTED); assert.equal(parses.count(), 1);
    oversize = true; assert.throws(() => f.read()); assert.equal(parses.count(), 1);
    oversize = false; assert.deepEqual(f.read(), DISPLAY_EXPECTED); assert.equal(parses.count(), 2);
  });
});
