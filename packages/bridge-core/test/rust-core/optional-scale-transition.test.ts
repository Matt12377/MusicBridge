import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { CollectionModel, IpcRequest, Page } from '@music-bridge/contracts';
import type { DatasetOwnerVersionedSnapshotEndpoint } from '../../src/collection/dataset-owner-protocol.js';
import { createOptionalRustReadonlyManager } from '../../src/rust-core/optional-readonly-manager.js';
import type { RustSidecarObservation } from '../../src/rust-core/readonly-sidecar.js';
import { createScaleOwner, exactScalePrepareFrame, scaleList, scaleRequest } from '../helpers/optional-scale-fixture.js';

for (const limit of [2_000, 5_000]) test(`实际原Node receive ${limit}→${limit + 1}写后撤权/整体拒绝，闭库合成恢复后冷Core可开启`, { timeout: 60_000 }, async t => {
  const f = await createScaleOwner(t, limit, { trustedLarge: limit === 5_000 });
  assert.equal((await f.manager.setEnabled(true)).mode, 'rust'); const before = await f.complete();
  const commandId = randomUUID(), receive = scaleRequest('collection.receive', { commandId,
    model: { brand: '跨界合成品牌', name: '唯一跨界型号', edition: '一版', year: 2000, format: 'cassette', tapeType: 'II', identification: 'verified' },
    lengthMinutes: 90, quantities: { sealedBlank: 1, openedBlank: 0, legacyUsed: 0, unclassified: 0 },
  }, f.identity.datasetId);
  const result = await f.endpoint.dispatch(receive) as { modelId: string };
  assert.deepEqual(await f.endpoint.dispatch({ ...receive, id: randomUUID() }), result);
  assert.equal(f.manager.getStatus().mode, 'node'); assert.equal(f.manager.getStatus().state, 'stale');
  const after = await f.complete(); assert.equal(after.items.length, limit + 1); assert.equal(after.total, limit + 1);
  assert.deepEqual(after.items.filter(model => model.id !== result.modelId), before.items);
  assert.equal((await f.manager.refresh()).refreshed, false); assert.equal(f.manager.getStatus().state, 'failed');
  await f.manager.setEnabled(false); assert.equal((await f.manager.setEnabled(true)).mode, 'node');
  assert.equal(f.manager.getStatus().state, 'failed'); assert.equal((await f.complete()).total, limit + 1);
  await f.close();
  const exits = f.observations.filter(value => value.event === 'exit'); assert.equal(exits.length, 1);
  assert.ok(exits.every(value => value.event === 'exit' && value.closeAcknowledged && value.pendingRequests === 0 && value.code === 0 && value.signal === null));
  // 没有产品删除型号 API：只在原Core自然退出后修复本测试新合成库，保留原receive回执。
  // 这是冷Core预算恢复 fixture，不能冒充同一运行Core中的生产删除或Rust写库。
  const db = new DatabaseSync(f.database);
  try {
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM collection_models').get() as { n: number }).n, limit + 1);
    db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
    db.prepare('DELETE FROM physical_copies WHERE lot_id IN (SELECT id FROM inventory_lots WHERE sku_id IN (SELECT id FROM collection_skus WHERE model_id=?))').run(result.modelId);
    db.prepare('DELETE FROM inventory_lots WHERE sku_id IN (SELECT id FROM collection_skus WHERE model_id=?)').run(result.modelId);
    db.prepare('DELETE FROM collection_skus WHERE model_id=?').run(result.modelId);
    db.prepare('DELETE FROM collection_models WHERE id=?').run(result.modelId); db.exec('COMMIT');
  } finally { db.close(); }
  const restored = await createScaleOwner(t, limit, { directory: f.directory, trustedLarge: limit === 5_000 });
  assert.deepEqual(await restored.complete(), before); assert.equal((await restored.manager.setEnabled(true)).mode, 'rust');
  assert.deepEqual(await restored.complete(), before); await restored.close();
  t.diagnostic(JSON.stringify({ profile: limit === 2_000 ? 'normal-v2-2000' : 'trusted-comparison-v3-5000', initialCount: limit,
    afterOriginalNodeReceive: limit + 1, wholeSnapshotRejected: true, receiveCommandId: commandId, duplicateDeliveryLogicalWrite: 1,
    recovery: 'SYNTHETIC_CLOSED_FIXTURE_REPAIR_THEN_NEW_COLD_CORE', normalNativeExits: exits, restoredNativeExits: restored.observations.filter(value => value.event === 'exit'), App: 'NOT_RUN' }));
});

test('同进程受控合法版本Owner的已知帧拒绝可恢复，同Core真实native正常收口，异步观察异常隔离', { timeout: 30_000 }, async t => {
  let snapshot = exactScalePrepareFrame(4_194_305), revision = randomUUID();
  const identity = { epoch: snapshot.epoch, datasetId: snapshot.datasetId }, calls = { prepare: 0, boot: 0, close: 0 };
  const owner: DatasetOwnerVersionedSnapshotEndpoint = {
    async prepare() { calls.prepare++; return identity; }, async commitBoot() { calls.boot++; }, async close() { calls.close++; },
    async getCollectionSnapshotVersion() { return { ...identity, revision }; },
    async exportCollectionSnapshot() { return snapshot; },
    async exportVersionedCollectionSnapshot() { return { snapshot, version: { ...identity, revision } }; },
    async dispatch(input: IpcRequest) {
      const page = (input.payload as { page: { offset: number; limit: number } }).page;
      return { ...page, total: snapshot.models.length, items: snapshot.models.slice(page.offset, page.offset + page.limit), hasMore: page.offset + Math.min(page.limit, snapshot.models.length - page.offset) < snapshot.models.length };
    },
  };
  const observations: RustSidecarObservation[] = [];
  const manager = createOptionalRustReadonlyManager({ onCostObservation: async () => { throw new Error('受控异步诊断故障'); }, createOptions: async () => ({
    binary: { path: process.env.MUSIC_BRIDGE_RUST_BINARY!, sha256: process.env.MUSIC_BRIDGE_RUST_SHA256! }, snapshotProfile: 'v2-2000', onObservation: value => observations.push(value),
  }) });
  const endpoint = manager.decorate(owner); await endpoint.prepare(); await endpoint.commitBoot(); t.after(() => endpoint.close().catch(() => {}));
  assert.equal((await manager.setEnabled(true)).state, 'failed'); assert.equal(manager.getStatus().mode, 'node'); assert.equal(observations.length, 0);
  assert.equal((await endpoint.dispatch(scaleList(identity.datasetId)) as Page<CollectionModel>).total, 2_000);
  const small = exactScalePrepareFrame(4_194_303); snapshot = { ...small, ...identity }; revision = randomUUID();
  const work = manager.refresh(); assert.equal(work, manager.refresh()); assert.equal((await work).refreshed, true);
  assert.equal(manager.getStatus().mode, 'rust');
  assert.deepEqual(await endpoint.dispatch(scaleList(identity.datasetId)), await owner.dispatch(scaleList(identity.datasetId)));
  await endpoint.close(); const exits = observations.filter(value => value.event === 'exit'); assert.equal(exits.length, 1);
  assert.ok(exits.every(value => value.event === 'exit' && value.code === 0 && value.signal === null && value.closeAcknowledged && value.pendingRequests === 0));
  assert.deepEqual(calls, { prepare: 1, boot: 1, close: 1 });
  t.diagnostic(JSON.stringify({ scope: 'CONTROLLED_SAME_PROCESS_VERSIONED_OWNER_WITH_ACTUAL_SIGNED_NATIVE_NOT_NORMAL_WORKER', localCapacityFailureSpawn: 0, recoverySameCore: true, cachedCloseCalls: 1, exits }));
});
