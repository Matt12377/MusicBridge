import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import type { CollectionFilter, CollectionModel, IpcRequest, Page } from '@music-bridge/contracts';
import { createDatasetOwnerClient } from '../../src/collection/dataset-owner-client.js';
import type { DatasetCollectionSnapshot, DatasetOwnerSnapshotEndpoint } from '../../src/collection/dataset-owner-protocol.js';
import { createRustReadonlyDatasetEndpointFromOwner, RustSidecarError } from '../../src/rust-core/readonly-sidecar.js';
import { seedRustCollection } from '../helpers/rust-core-collection-fixture.js';

const binary = { path: process.env.MUSIC_BRIDGE_RUST_BINARY ?? '', sha256: process.env.MUSIC_BRIDGE_RUST_SHA256 ?? '' };
assert.ok(path.isAbsolute(binary.path) && /^[a-f0-9]{64}$/.test(binary.sha256), '实际差分 Gate 必须提供本轮 Rust 二进制，不能条件跳过。');
function request(command: IpcRequest['command'], payload: unknown, datasetId: string): IpcRequest {
  return { version: 1, id: randomUUID(), command, payload, expectedDatasetId: datasetId };
}
async function fixture(t: test.TestContext, existingDirectory?: string) {
  const root = path.resolve(os.tmpdir()), external = '/Volumes/LifeWeave/Developer/CommandLine/tmp';
  const hosted = process.env.GITHUB_ACTIONS === 'true' && Boolean(process.env.RUNNER_TEMP);
  if (process.platform === 'darwin' && !hosted && root !== external && !root.startsWith(external + path.sep)) throw new Error('本机实际快照 Gate 必须采用外置 TMPDIR。');
  const directory = existingDirectory ?? await mkdtemp(path.join(root, 'rust-atomic-owner-'));
  const worker = new Worker(new URL('../helpers/dataset-owner-domain-fixture.ts', import.meta.url), {
    execArgv: ['--import', 'tsx'], workerData: { dataDirectory: directory, signals: new SharedArrayBuffer(12) },
  });
  const reasons: string[] = [], owner = createDatasetOwnerClient({ worker, onFatal: reason => reasons.push(reason) });
  t.after(() => owner.close());
  const identity = await owner.prepare();
  return { owner, worker, identity, reasons, directory, database: path.join(directory, 'collection.v1.sqlite') };
}
const code = (expected: string) => (error: unknown) => error instanceof RustSidecarError && error.code === expected;

test('实际Node原子2000型号→Rust v2筛选分页与SQLite一致，记录完整成本', { timeout: 90_000 }, async t => {
  const f = await fixture(t); await f.owner.commitBoot();
  const ids = seedRustCollection(f.database, 2_000);
  let captured!: DatasetCollectionSnapshot, exportMs = 0;
  const source: DatasetOwnerSnapshotEndpoint = { ...f.owner, async exportCollectionSnapshot() {
    const started = performance.now(); captured = await f.owner.exportCollectionSnapshot(); exportMs = performance.now() - started; return captured;
  } };
  const started = performance.now();
  const rust = await createRustReadonlyDatasetEndpointFromOwner({ binary, owner: source, startupTimeoutMs: 30_000 });
  const startupMs = performance.now() - started; t.after(() => rust.close());
  assert.equal(captured.models.length, 2_000); assert.deepEqual(captured.models.map(model => model.id), ids);
  assert.equal(rust.snapshotId, captured.snapshotId);
  const filters: CollectionFilter[] = [
    {}, { query: ' ' }, { query: '　ＳＡ　９０％　' }, { query: 'A_B%' }, { query: '%' }, { query: '_' },
    { query: '中文品牌🎵' }, { query: 'É' }, { query: 'Straße' }, { query: 'İSTANBUL' }, { query: 'Ｆ' },
    { brand: '　ＴＤＫ　' }, { brand: 'É' }, { brand: 'é' }, { brand: 'Sony%_' }, { brand: '　' },
    { decade: 'unknown' }, { decade: 1900 }, { decade: 1990 }, { decade: 2200 },
    { stockState: 'identified' }, { stockState: 'needs-review' }, { stockState: 'blank' }, { stockState: 'recorded' },
    { brand: 'TDK', decade: 1990, stockState: 'blank' }, { query: 'A_B%', stockState: 'recorded' },
    { brand: '不存在', query: 'SA', decade: 1990, stockState: 'identified' },
  ];
  let differentialPages = 0;
  for (const filter of filters) {
    for (const page of [{ offset: 0, limit: 100 }, { offset: 99, limit: 3 }, { offset: 1999, limit: 100 }, { offset: 2000, limit: 1 }]) {
      const ipc = request('collection.list', { page, filter }, f.identity.datasetId);
      assert.deepEqual(await rust.dispatch(ipc), await f.owner.dispatch(ipc), JSON.stringify({ filter, page })); differentialPages++;
    }
  }
  const page = { offset: 0, limit: 100 }, liveTimes: number[] = [], rustTimes: number[] = [];
  for (let index = 0; index < 10; index++) {
    const ipc = request('collection.list', { page, filter: { brand: 'TDK', stockState: 'blank' } }, f.identity.datasetId);
    let tick = performance.now(); await f.owner.dispatch(ipc); liveTimes.push(performance.now() - tick);
    tick = performance.now(); await rust.dispatch(ipc); rustTimes.push(performance.now() - tick);
  }
  const closeStart = performance.now(); await rust.close(); const closeMs = performance.now() - closeStart;
  const cost = { schemaVersion: 1, task: 'RUST-002', models: 2_000, differentialPages,
    nodeVersion: process.version, platform: process.platform, architecture: process.arch, binarySha256: binary.sha256,
    data: 'synthetic-two-database-owner', cacheState: 'warm-Node-owner-and-OS-cache-not-controlled',
    exportRoundtripMs: exportMs, fromOwnerReadyMs: startupMs, remainingStartupMs: startupMs - exportMs,
    snapshotJsonBytes: Buffer.byteLength(JSON.stringify(captured)), closeAckAndNaturalExitMs: closeMs,
    nodeQueryRoundtripMs: liveTimes, rustQueryRoundtripIncludingTsValidationMs: rustTimes,
    realServices: 'NOT_RUN', productionDefault: 'Node' };
  const output = process.env.MUSIC_BRIDGE_RUST_COST_REPORT;
  if (output) { assert.ok(path.isAbsolute(output)); await writeFile(output, JSON.stringify(cost, null, 2) + '\n'); }
  t.diagnostic(JSON.stringify(cost));
  const exited = once(f.worker, 'exit'); await f.owner.close(); assert.deepEqual(await exited, [0]); assert.deepEqual(f.reasons, []);
});

test('实际Owner导出后写入仍由Node完成，旧快照保持，显式新快照才刷新', { timeout: 30_000 }, async t => {
  const f = await fixture(t); await f.owner.commitBoot(); seedRustCollection(f.database, 101);
  let captured!: DatasetCollectionSnapshot;
  const source: DatasetOwnerSnapshotEndpoint = { ...f.owner, async exportCollectionSnapshot() {
    captured = await f.owner.exportCollectionSnapshot();
    const first = captured.models[0]!;
    await f.owner.dispatch(request('collection.setPolicy', { commandId: randomUUID(), modelId: first.id,
      expectedRevision: first.revision, collectorPolicy: 'collector', minimumSealedReserve: 1 }, f.identity.datasetId));
    return captured;
  } };
  const old = await createRustReadonlyDatasetEndpointFromOwner({ binary, owner: source }); t.after(() => old.close());
  const ipc = request('collection.list', { page: { offset: 0, limit: 100 } }, f.identity.datasetId);
  const oldPage = await old.dispatch(ipc) as Page<CollectionModel>, livePage = await f.owner.dispatch(ipc) as Page<CollectionModel>;
  assert.deepEqual(oldPage.items, captured.models.slice(0, 100));
  assert.equal(oldPage.items[0]!.revision, 1); assert.equal(livePage.items[0]!.revision, 2);
  assert.equal(livePage.items[0]!.collectorPolicy, 'collector');
  const updated = await createRustReadonlyDatasetEndpointFromOwner({ binary, owner: f.owner }); t.after(() => updated.close());
  assert.notEqual(old.snapshotId, updated.snapshotId); assert.deepEqual(await updated.dispatch(ipc), livePage);
  await Promise.all([old.close(), updated.close()]);
  assert.deepEqual(await f.owner.dispatch(ipc), livePage);
  const exited = once(f.worker, 'exit'); await f.owner.close(); assert.deepEqual(await exited, [0]); assert.deepEqual(f.reasons, []);
});

test('实际未boot及2001型号源拒绝，工厂失败不关闭Node或截断成快照', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await assert.rejects(createRustReadonlyDatasetEndpointFromOwner({ binary, owner: f.owner }), code('SNAPSHOT_UNAVAILABLE'));
  await f.owner.commitBoot(); seedRustCollection(f.database, 2_001);
  await assert.rejects(createRustReadonlyDatasetEndpointFromOwner({ binary, owner: f.owner }), code('SNAPSHOT_UNAVAILABLE'));
  const ipc = request('collection.list', { page: { offset: 0, limit: 100 } }, f.identity.datasetId);
  const live = await f.owner.dispatch(ipc) as Page<CollectionModel>;
  assert.equal(live.total, 2_001); assert.equal(live.items.length, 100);
  const exited = once(f.worker, 'exit'); await f.owner.close(); assert.deepEqual(await exited, [0]); assert.deepEqual(f.reasons, []);
});

test('实际冷启动复用合法v7持久工作库身份，Node导出与Rust读取均保留原身份', { timeout: 30_000 }, async t => {
  const first = await fixture(t); await first.owner.commitBoot(); seedRustCollection(first.database, 101);
  const stopped = once(first.worker, 'exit'); await first.owner.close(); assert.deepEqual(await stopped, [0]);
  // 只在新合成库已关闭后装入合法历史身份，验证既有存储bind复用规则。
  const datasetId = '22222222-2222-7222-8222-222222222222';
  const db = new DatabaseSync(path.join(first.directory, 'backup-maintenance.v1.sqlite'));
  try { db.prepare("UPDATE dataset_identities SET dataset_id=? WHERE slot='default'").run(datasetId); }
  finally { db.close(); }
  const f = await fixture(t, first.directory); assert.equal(f.identity.datasetId, datasetId); await f.owner.commitBoot();
  const rust = await createRustReadonlyDatasetEndpointFromOwner({ binary, owner: f.owner }); t.after(() => rust.close());
  assert.deepEqual(await rust.prepare(), f.identity);
  const ipc = request('collection.list', { page: { offset: 0, limit: 100 }, filter: { stockState: 'recorded' } }, datasetId);
  assert.deepEqual(await rust.dispatch(ipc), await f.owner.dispatch(ipc));
  await rust.close(); const exited = once(f.worker, 'exit'); await f.owner.close(); assert.deepEqual(await exited, [0]);
  assert.deepEqual(first.reasons, []); assert.deepEqual(f.reasons, []);
});
