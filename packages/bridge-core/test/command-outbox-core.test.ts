import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { IpcResponse } from '@music-bridge/contracts';
import { attachCoreRuntimePort, type UtilityPort } from '../src/utility-main.js';
import { createTestBridgeRuntime } from '../src/runtime.js';
import { openCollectionDataset } from '../src/recording/restore-dataset-runtime.js';

class Port implements UtilityPort {
  messages: unknown[] = []; listener?: (event: { data: unknown }) => void;
  on(_event: 'message', listener: (event: { data: unknown }) => void) { this.listener = listener; }
  start() {} postMessage(message: unknown) { this.messages.push(message); }
  async rpc(command: string, payload: unknown, expectedDatasetId?: string): Promise<IpcResponse> {
    const id = randomUUID(); this.listener!({ data: { version: 1, id, command, payload, ...(expectedDatasetId ? { expectedDatasetId } : {}) } });
    for (let i = 0; i < 100; ++i) {
      const result = this.messages.find(m => typeof m === 'object' && m !== null && 'id' in m && m.id === id);
      if (result) return result as IpcResponse;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('合成 Core 命令未在期限内返回');
  }
}
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'musicbridge-outbox-'));
  const opened = await openCollectionDataset(directory);
  const runtime = createTestBridgeRuntime({ collectionRepository: opened.repository, backupWorkflowStore: opened.store,
    collectionDatasetIdentity: { datasetId: opened.datasetId, assertCurrent: () => opened.assertIdentity() } });
  t.after(async () => { await runtime.shutdown(); opened.close(); await rm(directory, { recursive: true, force: true }); });
  const port = new Port(); await attachCoreRuntimePort(port, runtime);
  const payload = { commandId: randomUUID(), model: { brand: '合成', name: 'outbox', edition: '测试', year: 1990, format: 'cassette', tapeType: 'II', identification: 'verified' }, lengthMinutes: 60, quantities: { openedBlank: 1, sealedBlank: 0, legacyUsed: 0, unclassified: 0 } };
  return { directory, opened, port, payload };
}
test('Core context使用实际repository身份，原DTO重复投递只入库一次', async t => {
  const f = await fixture(t), context = await f.port.rpc('commandOutbox.context', {});
  assert.equal(context.ok, true); if (!context.ok) return;
  assert.deepEqual(context.result, { datasetId: f.opened.datasetId });
  const envelope = { datasetId: f.opened.datasetId, command: 'collection.receive', payload: f.payload };
  const first = await f.port.rpc('commandOutbox.execute', envelope), second = await f.port.rpc('commandOutbox.execute', envelope);
  assert.equal(first.ok, true); assert.equal(second.ok, true);
  if (first.ok && second.ok) { assert.deepEqual(second.result, first.result); assert.equal((first.result as { command: string }).command, 'collection.receive'); }
  assert.equal(f.opened.repository.list({ offset: 0, limit: 1 }).total, 1);
  assert.equal(f.opened.repository.list({ offset: 0, limit: 1 }).items[0]?.counts.openedBlank, 1);
});

test('原生授权的Main检查后切库竞态由Core信封scope拒绝', async t => {
  const f = await fixture(t);
  const result = await f.port.rpc('recordingSources.authorize', { commandId: randomUUID(), absolutePath: f.directory }, randomUUID());
  assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, 'OUTBOX_SCOPE_MISMATCH');
  const roots = await f.port.rpc('recordingSources.roots', {});
  assert.equal(roots.ok, true); if (roots.ok) assert.deepEqual(roots.result, { roots: [] });
});
test('旧工作库scope及嵌套内部命令在Core最后边界拒绝，不产生业务写入', async t => {
  const f = await fixture(t);
  const result = await f.port.rpc('commandOutbox.execute', { datasetId: randomUUID(), command: 'collection.receive', payload: f.payload });
  assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, 'OUTBOX_SCOPE_MISMATCH');
  for (const command of ['commandOutbox.execute', 'recordingSources.authorize', 'playback.stop']) {
    const rejected = await f.port.rpc('commandOutbox.execute', { datasetId: f.opened.datasetId, command, payload: f.payload });
    assert.equal(rejected.ok, false); if (!rejected.ok) assert.equal(rejected.error.code, 'INVALID_IPC_REQUEST');
  }
  assert.equal(f.opened.repository.list({ offset: 0, limit: 1 }).total, 0);
});
test('context读取后实际数据库文件被替换也不能借相同datasetId发送', async t => {
  const f = await fixture(t);
  await rename(path.join(f.directory, 'collection.v1.sqlite'), path.join(f.directory, '移开的原库.sqlite'));
  const result = await f.port.rpc('commandOutbox.execute', { datasetId: f.opened.datasetId, command: 'collection.receive', payload: f.payload });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'OUTBOX_SCOPE_MISMATCH');
  assert.equal(f.opened.repository.list({ offset: 0, limit: 1 }).total, 0);
});

test('参考目录正式IPC浏览不写库存，source登记走原scope outbox且重复命令不新增版本', async t => {
  const f = await fixture(t);
  const empty = await f.port.rpc('referenceCatalog.sources', { offset: 0, limit: 20 });
  assert.equal(empty.ok, true, '参考目录读取必须接入实际Core路由');
  const rawPack = JSON.stringify({ schemaVersion: 1, bookId: 'synthetic-book', title: '合成目录', sourceVersion: '1', items: [{ referenceId: 'synthetic-model', bookId: 'synthetic-book', brand: '合成', series: '测试', edition: '第一版', model: '测试型号', lengths: [60, 90], iec: 'II', era: '1990', image: { kind: 'none' }, pages: ['1'], notes: '', confidence: 'high' }] });
  const request = { commandId: randomUUID(), rawPack, packHash: createHash('sha256').update(rawPack).digest('hex'), userConfirmed: true };
  const wrongScope = await f.port.rpc('commandOutbox.execute', { datasetId: randomUUID(), command: 'referenceCatalog.registerSource', payload: request });
  assert.equal(wrongScope.ok, false); if (!wrongScope.ok) assert.equal(wrongScope.error.code, 'OUTBOX_SCOPE_MISMATCH');
  assert.deepEqual(await f.port.rpc('referenceCatalog.sources', { offset: 0, limit: 20 }).then(reply => reply.ok ? reply.result : null), empty.ok ? empty.result : null);
  const envelope = { datasetId: f.opened.datasetId, command: 'referenceCatalog.registerSource', payload: request };
  const first = await f.port.rpc('commandOutbox.execute', envelope), second = await f.port.rpc('commandOutbox.execute', envelope);
  assert.equal(first.ok, true); assert.equal(second.ok, true);
  if (first.ok && second.ok) assert.deepEqual(first.result, second.result);
  const stored = await f.port.rpc('referenceCatalog.sources', { offset: 0, limit: 20 });
  assert.equal(stored.ok, true); if (stored.ok) assert.match(JSON.stringify(stored.result), new RegExp(request.packHash, 'u'));
  assert.equal(f.opened.repository.list({ offset: 0, limit: 20 }).total, 0);
});


test('完成度九IPC与三写outbox保留原scope，重复提交不写库存或复制求购快照', async t => {
  const f = await fixture(t), page = { offset: 0, limit: 25 };
  const read = async (command: string, payload: unknown) => { const reply = await f.port.rpc(command, payload); assert.equal(reply.ok, true, JSON.stringify(reply)); if (!reply.ok) throw new Error('合成IPC失败'); return reply.result as any; };
  const empty = await read('collectionProgress.wants', { page }); assert.equal(empty.total, 0);
  const item = { referenceId: 'wanted-model', bookId: 'wanted-book', brand: '合成', series: '测试', edition: '第一版', model: '测试型号', lengths: [60, 90], iec: 'II' as const, era: '1990', image: { kind: 'none' as const }, pages: ['1'], notes: '', confidence: 'high' as const };
  const catalog = f.opened.repository.catalog, rawPack = JSON.stringify({ schemaVersion: 1, bookId: item.bookId, title: '合成求购目录', sourceVersion: '1', items: [item] });
  const source = catalog.registerSource({ commandId: randomUUID(), rawPack, packHash: createHash('sha256').update(rawPack).digest('hex'), userConfirmed: true });
  const plan = { sourceId: source.id, expectedCurrentRevisionId: null, items: [item], mappings: [] }, preview = catalog.previewRevision(plan);
  const published = catalog.publishRevision({ ...plan, commandId: randomUUID(), baselineFingerprint: preview.baselineFingerprint, userConfirmed: true });
  const payload = { commandId: randomUUID(), id: null, expectedVersion: 0, revisionId: published.revision.id, referenceId: item.referenceId, priority: 'high', preferredCondition: '未拆封', notes: '仅合成资料', targetLengthMinutes: 90, packagingTarget: '', priceTarget: { currency: 'CNY', amount: '100.2500' }, userConfirmed: true };
  const wrong = await f.port.rpc('commandOutbox.execute', { datasetId: randomUUID(), command: 'collectionProgress.saveWant', payload });
  assert.equal(wrong.ok, false); if (!wrong.ok) assert.equal(wrong.error.code, 'OUTBOX_SCOPE_MISMATCH');
  assert.equal((await read('collectionProgress.wants', { page })).total, 0);
  const save = { datasetId: f.opened.datasetId, command: 'collectionProgress.saveWant', payload }, first = await read('commandOutbox.execute', save);
  assert.deepEqual(await read('commandOutbox.execute', save), first);
  assert.equal((await read('collectionProgress.wantHistory', { id: first.result.id, page })).total, 1);
  const current = await read('collectionProgress.current', { revisionId: published.revision.id, page });
  assert.equal(current.overall.wanted, 1); assert.equal(current.overall.owned, 0);
  const capture = { datasetId: f.opened.datasetId, command: 'collectionProgress.capture', payload: { commandId: randomUUID(), revisionId: published.revision.id, expectedFingerprint: current.fingerprint, userConfirmed: true } };
  const snap = await read('commandOutbox.execute', capture); assert.deepEqual(await read('commandOutbox.execute', capture), snap);
  assert.equal((await read('collectionProgress.snapshots', { page })).total, 1);
  assert.equal((await read('collectionProgress.snapshot', { id: snap.result.id, page })).entries.items[0].wantedTargets.length, 1);
  const cancel = { datasetId: f.opened.datasetId, command: 'collectionProgress.cancelWant', payload: { commandId: randomUUID(), id: first.result.id, expectedVersion: first.result.version, userConfirmed: true } };
  const cancelled = await read('commandOutbox.execute', cancel); assert.equal(cancelled.result.active, false); assert.deepEqual(await read('commandOutbox.execute', cancel), cancelled);
  assert.equal((await read('collectionProgress.snapshot', { id: snap.result.id, page })).entries.items[0].wantedTargets.length, 1);
  assert.equal(f.opened.repository.list(page).total, 0, 'Wanted不改库存');
  const received = f.opened.repository.receive({ ...f.payload, model: { ...f.payload.model, format: 'cassette', tapeType: 'II', identification: 'verified' } } as Parameters<typeof f.opened.repository.receive>[0]);
  assert.equal((await read('collectionProgress.modelLengths', { modelId: received.modelId })).total, 1);
});
