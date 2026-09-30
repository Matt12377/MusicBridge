import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { CollectionFilter, CollectionReceiveRequest } from '@music-bridge/contracts';
import { createCollectionRepository } from '../src/collection/repository.js';

const page = { offset: 0, limit: 24 };
const receipt = (overrides: Partial<CollectionReceiveRequest> = {}): CollectionReceiveRequest => ({
  commandId: randomUUID(), model: { brand: 'TDK', name: 'SA', edition: randomUUID(), year: 1990, format: 'cassette', tapeType: 'II', identification: 'verified' },
  lengthMinutes: 90, quantities: { sealedBlank: 0, openedBlank: 1, legacyUsed: 0, unclassified: 0 }, ...overrides,
});
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-collection-filter-'));
  const filePath = path.join(directory, 'collection.sqlite');
  const repository = createCollectionRepository({ filePath });
  t.after(async () => { repository.close(); await rm(directory, { recursive: true, force: true }); });
  return { repository, filePath };
}
const stock = (stockState: string): CollectionFilter => ({ stockState } as CollectionFilter);

test('状态筛选先于24项分页，跨页及总数基于完整库存，重开后保留', async t => {
  const { repository, filePath } = await fixture(t);
  const legacy = repository.receive(receipt({ quantities: { sealedBlank: 0, openedBlank: 0, legacyUsed: 2, unclassified: 0 } }));
  const blankIds: string[] = [];
  for (let i = 0; i < 30; i++) blankIds.push(repository.receive(receipt()).modelId);
  assert.equal(repository.list(page).items.some(model => model.id === legacy.modelId), false);
  assert.deepEqual(repository.list(page, stock('recorded')).items.map(model => model.id), [legacy.modelId]);
  assert.equal(repository.list(page, stock('recorded')).total, 1);
  const first = repository.list(page, stock('blank'));
  const second = repository.list({ ...page, offset: 24 }, stock('blank'));
  assert.equal(first.total, 30); assert.equal(first.items.length, 24); assert.equal(second.total, 30); assert.equal(second.items.length, 6);
  assert.deepEqual([...first.items, ...second.items].map(model => model.id), blankIds.reverse());
  assert.equal(repository.list({ ...page, offset: 30 }, stock('blank')).items.length, 0);
  repository.close();
  const reopened = createCollectionRepository({ filePath });
  try { assert.equal(reopened.list(page, stock('recorded')).total, 1); assert.equal(reopened.list(page, stock('blank')).total, 30); }
  finally { reopened.close(); }
});

test('库存状态与文字、品牌、年代联合且旧筛选结果保持', async t => {
  const { repository } = await fixture(t);
  const wanted = repository.receive(receipt());
  repository.receive(receipt({ model: { ...receipt().model, name: 'MA' } }));
  repository.receive(receipt({ model: { ...receipt().model, brand: 'Sony' } }));
  repository.receive(receipt({ model: { ...receipt().model, year: 2000 } }));
  repository.receive(receipt({ quantities: { sealedBlank: 0, openedBlank: 0, legacyUsed: 1, unclassified: 0 } }));
  const old = { query: 'SA', brand: 'TDK', decade: 1990 };
  assert.equal(repository.list(page, old).total, 2);
  const filtered = repository.list(page, { ...old, ...stock('blank') });
  assert.equal(filtered.total, 1); assert.deepEqual(filtered.items.map(model => model.id), [wanted.modelId]);
  const unknownYear = repository.receive(receipt({ model: { brand: 'TDK', name: 'SA', edition: '', year: null, format: 'cassette', tapeType: 'II', identification: 'unidentified' } }));
  assert.deepEqual(repository.list(page, { decade: 'unknown', ...stock('needs-review') }).items.map(model => model.id), [unknownYear.modelId]);
  assert.equal(repository.list(page, stock('identified')).total, 5);
});

test('未知不充空白，版次已确认与待核对可重叠，历史已用不冒充正式录音', async t => {
  const { repository } = await fixture(t);
  const unknown = repository.receive(receipt({ quantities: { sealedBlank: 0, openedBlank: 0, legacyUsed: 0, unclassified: 2 } }));
  const legacy = repository.receive(receipt({ quantities: { sealedBlank: 0, openedBlank: 0, legacyUsed: 1, unclassified: 0 } }));
  repository.materialize({ commandId: randomUUID(), lotId: unknown.lotId!, bucket: 'unclassified', action: 'identify' });
  repository.materialize({ commandId: randomUUID(), lotId: unknown.lotId!, bucket: 'unclassified', action: 'identify' });
  assert.equal(repository.list(page, stock('blank')).total, 0);
  assert.deepEqual(repository.list(page, stock('needs-review')).items.map(model => model.id), [unknown.modelId]);
  assert.equal(repository.list(page, stock('identified')).total, 2);
  const before = repository.list(page, stock('recorded'));
  assert.equal(before.total, 1); assert.equal(before.items[0]!.counts.recorded, 0); assert.equal(before.items[0]!.counts.legacyUsed, 1);
  const copy = repository.materialize({ commandId: randomUUID(), lotId: legacy.lotId!, bucket: 'legacyUsed', action: 'register-legacy' });
  const after = repository.list(page, stock('recorded'));
  assert.equal(after.total, 1); assert.equal(after.items[0]!.counts.legacyUsed, 0); assert.equal(after.items[0]!.counts.recorded, 1);
  assert.equal(repository.copy(copy.physicalId!).copy.origin, 'legacy-registration');
  assert.equal(repository.copy(copy.physicalId!).copy.recordingState, undefined);
});

test('空白只包含实时可用库存，实体预留和不可用遵循权威计数', async t => {
  const { repository } = await fixture(t);
  const received = repository.receive(receipt());
  const copy = repository.materialize({ commandId: randomUUID(), lotId: received.lotId!, bucket: 'openedBlank', action: 'identify' });
  assert.equal(repository.list(page, stock('blank')).total, 1);
  repository.updateCopy({ commandId: randomUUID(), physicalId: copy.physicalId!, expectedRevision: 1, action: 'reserve' });
  assert.equal(repository.list(page, stock('blank')).total, 0);
  repository.updateCopy({ commandId: randomUUID(), physicalId: copy.physicalId!, expectedRevision: 2, action: 'cancel-reservation' });
  assert.equal(repository.list(page, stock('blank')).total, 1);
  repository.updateCopy({ commandId: randomUUID(), physicalId: copy.physicalId!, expectedRevision: 3, action: 'mark-unavailable' });
  assert.equal(repository.list(page, stock('blank')).total, 0);
  assert.equal(repository.detail(received.modelId, page).model.counts.unavailable, 1);
  repository.updateCopy({ commandId: randomUUID(), physicalId: copy.physicalId!, expectedRevision: 4, action: 'mark-available' });
  const sealed = repository.receive(receipt({ quantities: { sealedBlank: 1, openedBlank: 0, legacyUsed: 0, unclassified: 0 } }));
  assert.equal(repository.list(page, stock('blank')).total, 2);
  repository.materialize({ commandId: randomUUID(), lotId: sealed.lotId!, bucket: 'sealedBlank', action: 'identify' });
  assert.equal(repository.list(page, stock('blank')).total, 2);
  assert.throws(() => repository.list(page, stock('bad')), /库存请求无效/u);
  assert.throws(() => repository.list(page, { ...stock('blank'), extra: true } as CollectionFilter), /库存请求无效/u);
});
