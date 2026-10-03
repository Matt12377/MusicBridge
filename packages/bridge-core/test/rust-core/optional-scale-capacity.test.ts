import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { CollectionDetail, CollectionModel, Page } from '@music-bridge/contracts';
import { RustSidecarError } from '../../src/rust-core/readonly-sidecar.js';
import { createScaleOwner, scaleList, scaleRequest, scaleUntil } from '../helpers/optional-scale-fixture.js';

assert.equal(process.env.MUSIC_BRIDGE_RUST_SHA256, '2feb6d5fbe2d875228c5b0de26f016abe6377aee05a7e48977503ece899f21ef');
assert.equal(createHash('sha256').update(readFileSync(process.env.MUSIC_BRIDGE_RUST_BINARY!)).digest('hex'), process.env.MUSIC_BRIDGE_RUST_SHA256);
const filters = [{}, { brand: 'TDK', stockState: 'blank' }, { query: 'A_B%' }, { query: '中文品牌🎵' }, { decade: 1990 }, { query: '不存在' }] as const;

for (const amount of [0, 100, 2_000, 2_001, 5_000, 5_001]) test(`实际普通固定 factory ${amount} 完整规模、拒绝后原Node DTO/策略和冷启`, { timeout: 60_000 }, async t => {
  const f = await createScaleOwner(t, amount), before = await f.complete();
  assert.equal(before.items.length, amount); assert.equal(before.total, amount);
  assert.deepEqual({ factory: f.calls.factory, resource: f.calls.resource, export: f.calls.export, probe: f.calls.probe, native: f.observations.length, cost: f.costs.length }, { factory: 0, resource: 0, export: 0, probe: 0, native: 0, cost: 0 });
  const status = await f.manager.setEnabled(true);
  assert.deepEqual({ enabled: status.enabled, state: status.state, mode: status.mode }, { enabled: true, state: amount <= 2_000 ? 'ready' : 'failed', mode: amount <= 2_000 ? 'rust' : 'node' });
  assert.deepEqual(await f.complete(), before);
  for (const filter of filters) for (const offset of [0, 99, Math.max(0, amount - 1), amount]) {
    const request = scaleList(f.identity.datasetId, offset, filter);
    assert.deepEqual(await f.endpoint.dispatch(request), await f.source.dispatch(request));
  }
  if (amount) {
    for (const model of [before.items[0]!, before.items.at(-1)!]) {
      const request = scaleRequest('collection.detail', { modelId: model.id, page: { offset: 0, limit: 100 } }, f.identity.datasetId);
      assert.deepEqual(await f.endpoint.dispatch(request), await f.source.dispatch(request) as CollectionDetail);
    }
    const model = before.items[0]!, commandId = randomUUID(), request = scaleRequest('collection.setPolicy', { commandId, modelId: model.id, expectedRevision: model.revision, collectorPolicy: 'collector', minimumSealedReserve: 1 }, f.identity.datasetId);
    const result = await f.endpoint.dispatch(request); assert.deepEqual(await f.endpoint.dispatch({ ...request, id: randomUUID() }), result);
    assert.equal(f.manager.getStatus().mode, 'node');
    const page = await f.endpoint.dispatch(scaleList(f.identity.datasetId)) as Page<CollectionModel>;
    assert.equal(page.items[0]!.collectorPolicy, 'collector'); assert.equal(page.items[0]!.revision, 2);
  }
  const refresh = f.manager.refresh(); assert.equal(refresh, f.manager.refresh());
  assert.equal((await refresh).refreshed, amount <= 2_000);
  await f.manager.setEnabled(false); assert.equal(f.manager.getStatus().state, 'off');
  assert.equal((await f.manager.setEnabled(true)).mode, amount <= 2_000 ? 'rust' : 'node');
  const saved = await f.complete(); await f.close();
  assert.deepEqual({ prepare: f.calls.prepare, boot: f.calls.boot, close: f.calls.close }, { prepare: 1, boot: 1, close: 1 });
  const exits = f.observations.filter(value => value.event === 'exit');
  assert.ok(exits.every(value => value.event === 'exit' && value.code === 0 && value.signal === null && value.closeAcknowledged && value.pendingRequests === 0));
  if (amount > 2_000) assert.equal(f.observations.length, 0);
  const db = new DatabaseSync(f.database, { readOnly: true }); try {
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM collection_models').get() as { n: number }).n, amount);
    if (amount) assert.equal((db.prepare('SELECT revision FROM collection_models WHERE id=?').get(before.items[0]!.id) as { revision: number }).revision, 2);
  } finally { db.close(); }
  const cold = await createScaleOwner(t, amount, { directory: f.directory });
  assert.deepEqual(await cold.complete(), saved); assert.equal(cold.calls.factory, 0);
  assert.equal((await cold.manager.setEnabled(true)).mode, amount <= 2_000 ? 'rust' : 'node');
  assert.deepEqual(await cold.complete(), saved); await cold.close();
  t.diagnostic(JSON.stringify({ amount, profile: 'v2-2000', directory: f.directory, fullDtoCount: saved.items.length, freshNativeExits: exits, coldNativeExits: cold.observations.filter(value => value.event === 'exit'), costs: f.costs, nodeNaturalExit: f.nodeExit, coldNodeNaturalExit: cold.nodeExit, policyLogicalWrites: amount ? 1 : 0, App: 'NOT_RUN' }));
});

test('实际规模迟到导出OFF/newON与被动计时失败不改原收口', { timeout: 30_000 }, async t => {
  const f = await createScaleOwner(t, 100, { onCostObservation: () => { throw new Error('受控诊断写入失败'); } });
  const node = await f.complete(); assert.equal((await f.manager.setEnabled(true)).mode, 'rust');
  f.holdNextExport(); const old = f.manager.refresh(); await scaleUntil(() => f.exportEntered);
  const off = f.manager.setEnabled(false); assert.equal(f.manager.getStatus().mode, 'node');
  const on = f.manager.setEnabled(true); f.releaseExport(); assert.equal((await old).refreshed, false); await off;
  assert.equal((await on).mode, 'rust'); assert.deepEqual(await f.complete(), node); await f.close();
  assert.ok(f.costs.length > 0); assert.ok(f.costs.every(value => Number.isFinite(value.durationMs) && value.durationMs >= 0));
  for (const stage of ['versionProbe', 'snapshotExport', 'snapshotCopyFreeze', 'frameEncoding', 'nativeRpc', 'tsIndexBuild', 'routerDispatch', 'routerRefresh']) assert.ok(f.costs.some(value => value.stage === stage));
});

test('实际规模Rust首失败不重投，未知关闭永久blocked与缓存拒绝', { timeout: 30_000 }, async t => {
  const f = await createScaleOwner(t, 100, { killDispatch: true }); assert.equal((await f.manager.setEnabled(true)).mode, 'rust');
  const before = f.calls.dispatch;
  await assert.rejects(f.endpoint.dispatch(scaleList(f.identity.datasetId)), error => error instanceof RustSidecarError && error.code === 'PROCESS_EXIT');
  assert.equal(f.calls.dispatch, before); await scaleUntil(() => f.observations.some(value => value.event === 'exit'));
  assert.equal(f.manager.getStatus().state, 'blocked'); await f.manager.setEnabled(false); assert.equal((await f.manager.setEnabled(true)).state, 'blocked');
  assert.equal((await f.complete()).total, 100); const close = f.endpoint.close(); assert.equal(close, f.endpoint.close()); await assert.rejects(close); await assert.rejects(f.endpoint.close());
  await scaleUntil(() => f.nodeExit !== undefined); assert.equal(f.nodeExit, 0); assert.equal(f.calls.close, 1); assert.equal(f.calls.factory, 1);
  t.diagnostic(JSON.stringify({ controlledSigkill: true, firstRustFailure: 'PROCESS_EXIT', transparentNodeReplay: 0, blocked: true, naturalNodeExit: f.nodeExit, nativeExits: f.observations.filter(value => value.event === 'exit') }));
});
