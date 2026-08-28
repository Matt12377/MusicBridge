import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
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
