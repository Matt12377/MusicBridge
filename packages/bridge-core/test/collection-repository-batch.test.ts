import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { PerformanceTraceRecorder, type CollectionReceiveRequest } from '@music-bridge/contracts';
import { CollectionError, createCollectionRepository } from '../src/collection/repository.js';
import { withPerformanceContext } from '../src/diagnostics/performance-trace.js';

const temporaryRoot = os.tmpdir();
const page = { offset: 0, limit: 100 };
const receipt = (overrides: Partial<CollectionReceiveRequest> = {}): CollectionReceiveRequest => ({
  commandId: randomUUID(),
  model: { brand: 'TDK', name: 'SA', edition: '1990', year: 1990, format: 'cassette', tapeType: 'II', identification: 'verified' },
  lengthMinutes: 90, quantities: { sealedBlank: 8, openedBlank: 0, legacyUsed: 0, unclassified: 0 }, ...overrides,
});

async function fixture(t: test.TestContext) {
  const externalRoot = '/Volumes/LifeWeave/Developer/CommandLine/tmp';
  if (process.platform === 'darwin' && path.resolve(temporaryRoot) !== externalRoot && !path.resolve(temporaryRoot).startsWith(`${externalRoot}/`)) {
    throw new Error('本机库存测试必须使用LifeWeave外置TMPDIR。');
  }
  const directory = await mkdtemp(path.join(temporaryRoot, 'musicbridge-repository-batch-'));
  const filePath = path.join(directory, 'collection.sqlite');
  const repository = createCollectionRepository({ filePath });
  // 合成库保留在外置卷，便于失败归因；连接在每个用例结束时关闭。
  t.after(() => repository.close());
  t.diagnostic(`合成证据目录：${directory}`);
  return { repository, filePath };
}

test('批列表 SQL 按50型号分块，合法跨块分页保持原rowid顺序与总数', async t => {
  const oldTrace = process.env.MUSIC_BRIDGE_PERFORMANCE_TRACE;
  process.env.MUSIC_BRIDGE_PERFORMANCE_TRACE = '1';
  t.after(() => {
    if (oldTrace === undefined) delete process.env.MUSIC_BRIDGE_PERFORMANCE_TRACE;
    else process.env.MUSIC_BRIDGE_PERFORMANCE_TRACE = oldTrace;
  });
  const { repository } = await fixture(t);
  const received: string[] = [];
  const descriptor = receipt().model;
  for (let i = 0; i < 101; i++) received.push(repository.receive(receipt({ model: { ...descriptor, edition: `合成版次-${i}` } })).modelId);
  const expected = received.toReversed();
  const measured = (offset: number, limit: number) => {
    const recorder = new PerformanceTraceRecorder({ component: 'core', enabled: true });
    const result = withPerformanceContext(recorder, recorder.context(), () => repository.list({ offset, limit }));
    return { result, sqlCount: recorder.snapshot().counters.sqlCount };
  };
  for (const limit of [25, 1, 50, 51, 100]) {
    const { result, sqlCount } = measured(0, limit);
    assert.deepEqual(result.items.map(model => model.id), expected.slice(0, limit));
    assert.equal(result.total, 101); assert.equal(result.hasMore, true);
    assert.equal(sqlCount, 2 + 4 * Math.ceil(limit / 50), `${limit}项的SQL数必须只随参数块增长`);
  }
  for (const offset of [26, 76, 100, 101, 102]) {
    const { result, sqlCount } = measured(offset, 25);
    assert.deepEqual(result.items.map(model => model.id), expected.slice(offset, offset + 25));
    assert.equal(result.total, 101);
    assert.equal(result.hasMore, offset + result.items.length < 101);
    assert.equal(sqlCount, result.items.length ? 6 : 2);
  }
  for (const model of repository.list(page).items) assert.deepEqual(model, repository.detail(model.id, page).model);
});

test('批列表分别汇总多SKU多批次与实体，预留和不可用仍持有且不产生JOIN倍增', async t => {
  const { repository } = await fixture(t);
  const a = receipt();
  const first = repository.receive(receipt({ quantities: { sealedBlank: 3, openedBlank: 2, legacyUsed: 2, unclassified: 2 } }));
  const second = repository.receive(receipt({ lengthMinutes: 60, quantities: { sealedBlank: 1, openedBlank: 2, legacyUsed: 0, unclassified: 0 } }));
  repository.receive(receipt({ lengthMinutes: null, quantities: { sealedBlank: 0, openedBlank: 0, legacyUsed: 0, unclassified: 1 } }));
  const reserve = repository.materialize({ commandId: randomUUID(), lotId: first.lotId!, bucket: 'sealedBlank', action: 'identify' });
  repository.updateCopy({ commandId: randomUUID(), physicalId: reserve.physicalId!, expectedRevision: 1, action: 'reserve' });
  const unavailable = repository.materialize({ commandId: randomUUID(), lotId: second.lotId!, bucket: 'openedBlank', action: 'identify' });
  repository.updateCopy({ commandId: randomUUID(), physicalId: unavailable.physicalId!, expectedRevision: 1, action: 'mark-unavailable' });
  repository.materialize({ commandId: randomUUID(), lotId: first.lotId!, bucket: 'legacyUsed', action: 'register-legacy' });
  repository.materialize({ commandId: randomUUID(), lotId: first.lotId!, bucket: 'unclassified', action: 'identify' });
  const candidate = repository.receive(receipt({ model: { ...a.model, edition: '未确认', year: null, identification: 'candidate' }, quantities: { sealedBlank: 0, openedBlank: 1, legacyUsed: 0, unclassified: 0 } }));
  repository.materialize({ commandId: randomUUID(), lotId: candidate.lotId!, bucket: 'openedBlank', action: 'identify' });
  repository.setPolicy({ commandId: randomUUID(), modelId: first.modelId, expectedRevision: 1, collectorPolicy: 'preserve-sealed', minimumSealedReserve: 2 });
  const listed = repository.list(page);
  assert.deepEqual(listed.items.map(model => model.id), [candidate.modelId, first.modelId]);
  const model = listed.items[1]!;
  assert.deepEqual(model.lengths, [null, 60, 90]);
  assert.deepEqual(model.counts, { total: 13, sealedBlank: 3, openedBlank: 3, legacyUsed: 1, unknown: 3, recorded: 1, reserved: 1, unavailable: 1 });
  assert.equal(model.collectorPolicy, 'preserve-sealed'); assert.equal(model.minimumSealedReserve, 2); assert.equal(model.revision, 2);
  assert.equal(model.photoCount, 0); assert.equal(model.featuredPhoto, undefined);
  assert.equal(listed.items[0]!.identification, 'candidate'); assert.equal(listed.items[0]!.year, null);
  assert.deepEqual(listed.items[0]!.counts, { total: 1, sealedBlank: 0, openedBlank: 1, legacyUsed: 0, unknown: 0, recorded: 0, reserved: 0, unavailable: 0 });
  for (const entry of listed.items) assert.deepEqual(entry, repository.detail(entry.id, page).model);
});

test('批列表照片保持featured优先与最早rowid回退，实体归属和零照片字段保留', async t => {
  const { repository } = await fixture(t);
  const stock = repository.receive(receipt());
  const physical = repository.materialize({ commandId: randomUUID(), lotId: stock.lotId!, bucket: 'sealedBlank', action: 'identify' });
  const image = { dataUrl: 'data:image/jpeg;base64,/9j/2Q==', width: 1, height: 1 };
  const first = repository.addPhoto({ commandId: randomUUID(), modelId: stock.modelId, image });
  const second = repository.addPhoto({ commandId: randomUUID(), modelId: stock.modelId, physicalId: physical.physicalId!, image });
  const otherPhysical = repository.materialize({ commandId: randomUUID(), lotId: stock.lotId!, bucket: 'sealedBlank', action: 'identify' });
  const third = repository.addPhoto({ commandId: randomUUID(), modelId: stock.modelId, physicalId: otherPhysical.physicalId!, image });
  const current = () => {
    const result = repository.list(page).items[0]!;
    assert.deepEqual(result, repository.detail(stock.modelId, page).model);
    assert.equal(result.counts.total, 8);
    return result;
  };
  assert.equal(current().photoCount, 3); assert.equal(current().featuredPhoto?.id, first.photoId);
  repository.changePhoto({ commandId: randomUUID(), modelId: stock.modelId, photoId: second.photoId!, expectedRevision: current().revision, action: 'feature' });
  assert.equal(current().featuredPhoto?.id, second.photoId); assert.equal(current().featuredPhoto?.physicalId, physical.physicalId);
  repository.changePhoto({ commandId: randomUUID(), modelId: stock.modelId, photoId: second.photoId!, expectedRevision: current().revision, action: 'remove' });
  assert.equal(current().photoCount, 2); assert.equal(current().featuredPhoto?.id, first.photoId);
  repository.changePhoto({ commandId: randomUUID(), modelId: stock.modelId, photoId: first.photoId!, expectedRevision: current().revision, action: 'remove' });
  assert.equal(current().featuredPhoto?.id, third.photoId);
  repository.changePhoto({ commandId: randomUUID(), modelId: stock.modelId, photoId: third.photoId!, expectedRevision: current().revision, action: 'remove' });
  assert.equal(current().photoCount, 0); assert.equal(Object.hasOwn(current(), 'featuredPhoto'), false);
});

test('批列表保留分页前联合筛选、NULL年代、字面百分号与库存状态分类', async t => {
  const { repository } = await fixture(t);
  const blank: string[] = [];
  const descriptor = receipt().model;
  const legacy = repository.receive(receipt({ model: { ...descriptor, name: 'SA 100%', edition: '已用' }, quantities: { sealedBlank: 0, openedBlank: 0, legacyUsed: 2, unclassified: 0 } }));
  const unknown = repository.receive(receipt({ model: { ...descriptor, brand: 'Sony', year: null, identification: 'unidentified' }, quantities: { sealedBlank: 0, openedBlank: 0, legacyUsed: 0, unclassified: 1 } }));
  for (let i = 0; i < 55; i++) blank.push(repository.receive(receipt({ model: { ...descriptor, edition: `空白-${i}` } })).modelId);
  const filter = { brand: ' tdk ', query: 'SA', decade: 1990, stockState: 'blank' as const };
  const first = repository.list({ offset: 0, limit: 51 }, filter), last = repository.list({ offset: 51, limit: 51 }, filter);
  assert.deepEqual([...first.items, ...last.items].map(model => model.id), blank.toReversed());
  assert.equal(first.total, 55); assert.equal(first.hasMore, true); assert.equal(last.total, 55); assert.equal(last.hasMore, false);
  assert.deepEqual(repository.list(page, { query: '%' }).items.map(model => model.id), [legacy.modelId]);
  assert.deepEqual(repository.list(page, { decade: 'unknown', stockState: 'needs-review' }).items.map(model => model.id), [unknown.modelId]);
  assert.deepEqual(repository.list(page, { stockState: 'recorded' }).items.map(model => model.id), [legacy.modelId]);
  assert.equal(repository.list(page, { stockState: 'identified' }).total, 56);
});

test('批列表每次读取重新组装，合法变更立即可见、跨连接与重开一致且close后拒绝', async t => {
  const { repository, filePath } = await fixture(t);
  const stock = repository.receive(receipt());
  const initial = repository.list(page).items[0]!;
  const second = createCollectionRepository({ filePath });
  t.after(() => second.close());
  assert.deepEqual(second.list(page).items[0], initial);
  second.receive(receipt({ lengthMinutes: 60 }));
  const copy = second.materialize({ commandId: randomUUID(), lotId: stock.lotId!, bucket: 'sealedBlank', action: 'open' });
  second.updateCopy({ commandId: randomUUID(), physicalId: copy.physicalId!, expectedRevision: 1, action: 'reserve' });
  const changed = repository.list(page).items[0]!;
  assert.deepEqual(changed.lengths, [60, 90]); assert.equal(changed.counts.total, 16); assert.equal(changed.counts.reserved, 1); assert.equal(changed.counts.sealedBlank, 15);
  assert.deepEqual(initial.lengths, [90]); assert.equal(initial.counts.total, 8);
  assert.deepEqual(changed, second.list(page).items[0]);
  repository.close();
  assert.throws(() => repository.list(page), error => error instanceof CollectionError && error.code === 'INVENTORY_UNAVAILABLE');
  const reopened = createCollectionRepository({ filePath });
  try { assert.deepEqual(reopened.list(page).items[0], changed); } finally { reopened.close(); }
});

test('批列表仍完整校验型号DTO，合成损坏被拒绝且不删除库存或账本', async t => {
  const { repository, filePath } = await fixture(t);
  const stock = repository.receive(receipt());
  repository.close();
  const db = new DatabaseSync(filePath);
  try {
    const prior = db.prepare('SELECT descriptor FROM collection_models WHERE id=?').get(stock.modelId)!;
    const descriptor = JSON.parse(String(prior.descriptor)) as Record<string, unknown>;
    db.prepare('UPDATE collection_models SET descriptor=? WHERE id=?').run(JSON.stringify({ ...descriptor, identification: '合成损坏值' }), stock.modelId);
  } finally { db.close(); }
  const damaged = createCollectionRepository({ filePath });
  try {
    assert.throws(() => damaged.list(page), error => error instanceof CollectionError && error.code === 'INVENTORY_UNAVAILABLE');
  } finally { damaged.close(); }
  const preserved = new DatabaseSync(filePath, { readOnly: true });
  try {
    assert.equal(preserved.prepare('SELECT COUNT(*) n FROM collection_models').get()?.n, 1);
    assert.equal(preserved.prepare('SELECT SUM(sealed) n FROM inventory_lots').get()?.n, 8);
    assert.equal(preserved.prepare('SELECT COUNT(*) n FROM inventory_ledger').get()?.n, 1);
  } finally { preserved.close(); }
});

test('批列表非法分页或筛选仍在建库前拒绝，空库和越界页不查询空IN', async t => {
  const { repository, filePath } = await fixture(t);
  assert.throws(() => repository.list({ offset: 0, limit: 101 }), error => error instanceof CollectionError && error.code === 'INVENTORY_CONFLICT');
  assert.throws(() => repository.list(page, { decade: 1991 }), error => error instanceof CollectionError && error.code === 'INVENTORY_CONFLICT');
  await assert.rejects(stat(filePath), { code: 'ENOENT' });
  assert.deepEqual(repository.list(page), { items: [], offset: 0, limit: 100, total: 0, hasMore: false });
  assert.deepEqual(repository.list({ offset: 100, limit: 25 }), { items: [], offset: 100, limit: 25, total: 0, hasMore: false });
});
