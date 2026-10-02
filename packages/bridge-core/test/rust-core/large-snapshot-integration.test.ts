import assert from 'node:assert/strict';
import childProcess, { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import type { CollectionFilter, CollectionModel, IpcRequest, Page } from '@music-bridge/contracts';
import { createDatasetOwnerClient } from '../../src/collection/dataset-owner-client.js';
import { DatasetOwnerTransportError, type DatasetOwnerLargeSnapshotEndpoint,
  type DatasetVersionedCollectionSnapshot } from '../../src/collection/dataset-owner-protocol.js';
import { createRustReadonlyCollectionRouter } from '../../src/rust-core/readonly-router.js';
import { createRustReadonlyDatasetEndpoint, createRustReadonlyDatasetEndpointFromOwner, RustSidecarError } from '../../src/rust-core/readonly-sidecar.js';
import { seedRustCollection } from '../helpers/rust-core-collection-fixture.js';

const binary = { path: process.env.MUSIC_BRIDGE_RUST_BINARY ?? '', sha256: process.env.MUSIC_BRIDGE_RUST_SHA256 ?? '' };
assert.ok(path.isAbsolute(binary.path) && /^[a-f0-9]{64}$/.test(binary.sha256), '实际大快照 Gate 必须提供本轮固定 Rust 二进制，不能条件跳过。');
const code = (expected: string) => (error: unknown) => error instanceof RustSidecarError && error.code === expected;
const request = (command: IpcRequest['command'], payload: unknown, datasetId: string): IpcRequest =>
  ({ version: 1, id: randomUUID(), command, payload, expectedDatasetId: datasetId });
const list = (datasetId: string, filter: CollectionFilter = {}, page = { offset: 0, limit: 100 }) =>
  request('collection.list', { filter, page }, datasetId);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }

async function fixture(t: test.TestContext, options: { directory?: string; crashAfterReceive?: boolean } = {}) {
  const root = path.resolve(os.tmpdir()), external = '/Volumes/LifeWeave/Developer/CommandLine/tmp';
  const hosted = process.env.GITHUB_ACTIONS === 'true' && Boolean(process.env.RUNNER_TEMP);
  if (process.platform === 'darwin' && !hosted && root !== external && !root.startsWith(external + path.sep)) throw new Error('本机大快照 Gate 必须使用外置 TMPDIR。');
  const directory = options.directory ?? await mkdtemp(path.join(root, 'rust-large-owner-'));
  const worker = new Worker(new URL('../helpers/dataset-owner-domain-fixture.ts', import.meta.url), {
    execArgv: ['--import', 'tsx'], workerData: { dataDirectory: directory, ...(options.crashAfterReceive ? { crashAfterReceive: true } : {}) },
  });
  const reasons: string[] = [], owner = createDatasetOwnerClient({ worker, onFatal: reason => reasons.push(reason) });
  let exited: number | undefined;
  worker.once('exit', value => { exited = value; });
  t.after(async () => { if (exited === undefined) await owner.close(); });
  const identity = await owner.prepare(); await owner.commitBoot();
  t.diagnostic('合成两库证据目录：' + directory);
  return { owner, worker, identity, reasons, directory, database: path.join(directory, 'collection.v1.sqlite'),
    async close() { const exit = once(worker, 'exit'); await owner.close(); assert.deepEqual(await exit, [0]); assert.deepEqual(reasons, []); },
  };
}
function observedOwner(owner: DatasetOwnerLargeSnapshotEndpoint) {
  const calls = { prepare: 0, boot: 0, close: 0, version: 0, export: 0, dispatch: 0 };
  let captured: DatasetVersionedCollectionSnapshot | undefined, exportMs = 0;
  const source: DatasetOwnerLargeSnapshotEndpoint = {
    ...owner,
    prepare() { calls.prepare++; return owner.prepare(); },
    commitBoot() { calls.boot++; return owner.commitBoot(); },
    close() { calls.close++; return owner.close(); },
    getCollectionSnapshotVersion() { calls.version++; return owner.getCollectionSnapshotVersion(); },
    async exportLargeVersionedCollectionSnapshot() {
      calls.export++; const tick = performance.now(); captured = await owner.exportLargeVersionedCollectionSnapshot(); exportMs = performance.now() - tick; return captured;
    },
    dispatch(input) { calls.dispatch++; return owner.dispatch(input); },
  };
  return { source, calls, get captured() { return captured; }, get exportMs() { return exportMs; } };
}
/** 观察真实进程的输入帧与退出，保持原管道和二进制工作。 */
function observedChildren(t: test.TestContext) {
  const original = childProcess.spawn;
  const children: ChildProcessWithoutNullStreams[] = [];
  const exits: { code: number | null; signal: NodeJS.Signals | null }[] = [];
  const frames: { operation: string; bytes: number; chunkIndex?: number; modelCount?: number; tick: number }[] = [];
  const firstAppend = deferred<ChildProcessWithoutNullStreams>();
  let live = 0, peak = 0;
  t.mock.method(childProcess, 'spawn', (...args: Parameters<typeof childProcess.spawn>) => {
    assert.equal(args[0], binary.path);
    const child = original(...args) as ChildProcessWithoutNullStreams;
    children.push(child); live++; peak = Math.max(peak, live);
    child.once('close', (exitCode, signal) => { live--; exits.push({ code: exitCode, signal }); });
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = ((...input: Parameters<typeof child.stdin.write>) => {
      const buffer = Buffer.isBuffer(input[0]) ? input[0] : Buffer.from(String(input[0]));
      const frame = JSON.parse(buffer.toString()) as { operation: string; payload: { chunkIndex?: number; models?: unknown[] } };
      frames.push({ operation: frame.operation, bytes: buffer.length, tick: performance.now(),
        ...(frame.operation === 'appendSnapshot' ? { chunkIndex: frame.payload.chunkIndex!, modelCount: frame.payload.models!.length } : {}) });
      if (frame.operation === 'appendSnapshot') firstAppend.resolve(child);
      return write(...input);
    }) as typeof child.stdin.write;
    return child;
  });
  return { children, exits, frames, firstAppend: firstAppend.promise, get live() { return live; }, get peak() { return peak; } };
}
function collectionFacts(database: string): string {
  const db = new DatabaseSync(database, { readOnly: true }), hash = createHash('sha256');
  try {
    for (const table of ['collection_models', 'collection_skus', 'inventory_lots', 'physical_copies', 'collection_photos']) {
      hash.update(table); hash.update(JSON.stringify(db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()));
    }
    return hash.digest('hex');
  } finally { db.close(); }
}

test('真实两库5000型号分40块完整上传，50全页与108筛选页一致并记录多工作量成本', { timeout: 90_000 }, async t => {
  const f = await fixture(t), ids = seedRustCollection(f.database, 5_000), facts = collectionFacts(f.database);
  const observed = observedOwner(f.owner), processState = observedChildren(t);
  const router = await createRustReadonlyCollectionRouter({ binary, owner: observed.source, snapshotProfile: 'v3-5000', startupTimeoutMs: 30_000 });
  t.after(() => router.close()); assert.equal(router.getStatus().phase, 'node'); assert.equal(processState.children.length, 0);
  const tick = performance.now(); await router.refresh(); const refreshMs = performance.now() - tick;
  assert.equal(router.getStatus().phase, 'rust'); assert.deepEqual(observed.captured!.snapshot.models.map(model => model.id), ids);
  const uploads = processState.frames.filter(frame => frame.operation === 'appendSnapshot');
  assert.equal(uploads.length, 40); assert.deepEqual(uploads.map(frame => frame.chunkIndex), Array.from({ length: 40 }, (_, index) => index));
  assert.deepEqual(uploads.map(frame => frame.modelCount), [...Array<number>(39).fill(128), 8]);
  assert.ok(uploads.every(frame => frame.bytes <= 1024 * 1024));
  const uploadBytes = uploads.reduce((sum, frame) => sum + frame.bytes, 0); assert.ok(uploadBytes <= 8 * 1024 * 1024 + 64 * 1024);
  let completePages = 0, differentialPages = 0;
  for (let offset = 0; offset < 5_000; offset += 100) {
    const ipc = list(f.identity.datasetId, {}, { offset, limit: 100 });
    const page = await router.dispatch(ipc) as Page<CollectionModel>;
    assert.deepEqual(page, await f.owner.dispatch(ipc)); assert.deepEqual(page.items, observed.captured!.snapshot.models.slice(offset, offset + 100)); completePages++;
  }
  const filters: CollectionFilter[] = [
    {}, { query: ' ' }, { query: '　ＳＡ　９０％　' }, { query: 'A_B%' }, { query: '%' }, { query: '_' },
    { query: '中文品牌🎵' }, { query: 'É' }, { query: 'Straße' }, { query: 'İSTANBUL' }, { query: 'Ｆ' },
    { brand: '　ＴＤＫ　' }, { brand: 'É' }, { brand: 'é' }, { brand: 'Sony%_' }, { brand: '　' },
    { decade: 'unknown' }, { decade: 1900 }, { decade: 1990 }, { decade: 2200 },
    { stockState: 'identified' }, { stockState: 'needs-review' }, { stockState: 'blank' }, { stockState: 'recorded' },
    { brand: 'TDK', decade: 1990, stockState: 'blank' }, { query: 'A_B%', stockState: 'recorded' },
    { brand: '不存在', query: 'SA', decade: 1990, stockState: 'identified' },
  ];
  for (const filter of filters) for (const page of [{ offset: 0, limit: 100 }, { offset: 99, limit: 3 }, { offset: 4999, limit: 100 }, { offset: 5000, limit: 1 }]) {
    const ipc = list(f.identity.datasetId, filter, page); assert.deepEqual(await router.dispatch(ipc), await f.owner.dispatch(ipc), JSON.stringify({ filter, page })); differentialPages++;
  }
  const workloads = [
    { name: 'unfiltered', filter: {} }, { name: 'selective-brand-stock', filter: { brand: 'TDK', stockState: 'blank' } },
    { name: 'literal-percent-underscore', filter: { query: 'A_B%' } }, { name: 'unicode', filter: { query: '中文品牌🎵' } },
    { name: 'decade', filter: { decade: 1990 } }, { name: 'empty-result', filter: { brand: '不存在' } },
  ] satisfies { name: string; filter: CollectionFilter }[];
  const measured = [], versionStart = observed.calls.version;
  for (const workload of workloads) {
    const nodeQueryRoundtripMs: number[] = [], rustQueryWithVersionProbesMs: number[] = [];
    for (let sample = 0; sample < 10; sample++) {
      const ipc = list(f.identity.datasetId, workload.filter);
      let now = performance.now(); const node = await f.owner.dispatch(ipc); nodeQueryRoundtripMs.push(performance.now() - now);
      now = performance.now(); const rust = await router.dispatch(ipc); rustQueryWithVersionProbesMs.push(performance.now() - now); assert.deepEqual(rust, node);
    }
    measured.push({ ...workload, nodeQueryRoundtripMs, rustQueryWithVersionProbesMs });
  }
  assert.equal(observed.calls.version - versionStart, 120);
  const closing = performance.now(); await router.close(); const closeMs = performance.now() - closing;
  assert.equal(processState.live, 0); assert.equal(processState.peak, 1); assert.deepEqual(processState.exits, [{ code: 0, signal: null }]);
  assert.deepEqual([observed.calls.prepare, observed.calls.boot, observed.calls.close], [0, 0, 0]); assert.equal(observed.calls.export, 1);
  assert.equal(collectionFacts(f.database), facts);
  const cost = { schemaVersion: 1, task: 'RUST-004', models: 5_000, completePages, differentialPages,
    binarySha256: binary.sha256, nodeVersion: process.version, platform: process.platform, architecture: process.arch,
    data: 'synthetic-real-two-database-Node-owner-to-pinned-Rust-v3-router', cacheState: 'warm-Node-owner-and-OS-cache-not-controlled',
    snapshotProfile: 'v3-5000', exportRoundtripMs: observed.exportMs, refreshMs, closeMs,
    snapshotJsonBytes: Buffer.byteLength(JSON.stringify(observed.captured!.snapshot)), uploadBytes,
    uploadChunks: uploads.length, maximumChunkFrameBytes: Math.max(...uploads.map(frame => frame.bytes)), workloads: measured,
    counts: { refreshExports: observed.calls.export, warmVersionRoundtrips: 120, warmRustQueries: 60, rustChildren: 1, peakLiveRustChildren: processState.peak,
      naturalRustExits: processState.exits, borrowedOwnerPrepare: 0, borrowedOwnerBoot: 0, borrowedOwnerClose: 0 },
    protectedFactsSha256: facts, realServices: 'NOT_RUN', productionDefault: 'Node',
    costScope: 'Node含线程RPC和响应验证；Rust含前后Node版本RPC、真实进程往返和完整TS事实核验。差分assert在计时之外。',
    costLimitations: '6种工作量每种固定10次warm合成样本，OS缓存未控制；没有冷盘、真实用户库、真实设备或硬内存上限证据。' };
  const output = process.env.MUSIC_BRIDGE_RUST_LARGE_COST_REPORT;
  if (output) { assert.ok(path.isAbsolute(output)); await writeFile(output, JSON.stringify(cost, null, 2) + '\n'); }
  t.diagnostic(JSON.stringify(cost)); await f.close();
});

test('实际5000库默认v2仍拒绝，显式v3通过；5001完整拒绝且没有启动child', { timeout: 30_000 }, async t => {
  const f = await fixture(t); seedRustCollection(f.database, 5_000); const processes = observedChildren(t);
  await assert.rejects(createRustReadonlyDatasetEndpointFromOwner({ binary, owner: f.owner }), code('SNAPSHOT_UNAVAILABLE'));
  assert.equal(processes.children.length, 0);
  const rust = await createRustReadonlyDatasetEndpointFromOwner({ binary, owner: f.owner, snapshotProfile: 'v3-5000' });
  t.after(() => rust.close()); assert.equal((await rust.dispatch(list(f.identity.datasetId)) as Page<CollectionModel>).total, 5_000);
  await rust.close(); seedRustCollection(f.database, 1, 5_000);
  await assert.rejects(createRustReadonlyDatasetEndpointFromOwner({ binary, owner: f.owner, snapshotProfile: 'v3-5000' }), code('SNAPSHOT_UNAVAILABLE'));
  assert.equal(processes.children.length, 1); assert.equal((await f.owner.dispatch(list(f.identity.datasetId)) as Page<CollectionModel>).total, 5_001);
  await f.close();
});

test('真实5000库Node写后版本使旧v3失效，显式刷新反映完整新事实且最多一个child', { timeout: 30_000 }, async t => {
  const f = await fixture(t); seedRustCollection(f.database, 5_000); const observed = observedOwner(f.owner), processes = observedChildren(t);
  const router = await createRustReadonlyCollectionRouter({ binary, owner: observed.source, snapshotProfile: 'v3-5000' }); t.after(() => router.close());
  await router.refresh(); const first = observed.captured!.snapshot.models[0]!, oldId = router.getStatus().snapshotId;
  await f.owner.dispatch(request('collection.setPolicy', { commandId: randomUUID(), modelId: first.id, expectedRevision: first.revision,
    collectorPolicy: 'collector', minimumSealedReserve: 1 }, f.identity.datasetId));
  const ipc = list(f.identity.datasetId), live = await f.owner.dispatch(ipc);
  assert.deepEqual(await router.dispatch(ipc), live); assert.equal(router.getStatus().phase, 'stale');
  await router.refresh(); assert.notEqual(router.getStatus().snapshotId, oldId); assert.deepEqual(await router.dispatch(ipc), live);
  assert.equal(observed.captured!.snapshot.models[0]!.revision, 2); assert.equal(processes.peak, 1);
  await router.close(); assert.equal(processes.live, 0); assert.deepEqual(processes.exits, [{ code: 0, signal: null }, { code: 0, signal: null }]);
  assert.deepEqual([observed.calls.prepare, observed.calls.boot, observed.calls.close], [0, 0, 0]); await f.close();
});

test('实际v3在首块上传时close停止后续39块，部分集合不能boot且ACK后自然退出', { timeout: 30_000 }, async t => {
  const f = await fixture(t); seedRustCollection(f.database, 5_000); const { snapshot } = await f.owner.exportLargeVersionedCollectionSnapshot();
  const processes = observedChildren(t), rust = createRustReadonlyDatasetEndpoint({ binary, snapshot, snapshotProfile: 'v3-5000' });
  const preparing = rust.prepare(); void preparing.catch(() => {}); await processes.firstAppend; await rust.close();
  await assert.rejects(preparing, code('CLOSING')); await assert.rejects(rust.commitBoot(), code('CLOSING'));
  assert.equal(processes.frames.filter(frame => frame.operation === 'appendSnapshot').length, 1);
  assert.equal(processes.frames.filter(frame => frame.operation === 'commitBoot').length, 0);
  assert.equal(processes.live, 0); assert.deepEqual(processes.exits, [{ code: 0, signal: null }]);
  assert.equal((await f.owner.dispatch(list(f.identity.datasetId)) as Page<CollectionModel>).total, 5_000); await f.close();
});

test('实际v3首块后进程崩溃不能发布或伪称自然关闭，Node来源继续可用', { timeout: 30_000 }, async t => {
  const f = await fixture(t); seedRustCollection(f.database, 5_000); const { snapshot } = await f.owner.exportLargeVersionedCollectionSnapshot();
  const processes = observedChildren(t), rust = createRustReadonlyDatasetEndpoint({ binary, snapshot, snapshotProfile: 'v3-5000' });
  const preparing = rust.prepare(); void preparing.catch(() => {}); const child = await processes.firstAppend;
  const closed = once(child, 'close'); assert.ok(child.kill('SIGKILL')); await assert.rejects(preparing, code('PROCESS_EXIT')); await closed;
  await assert.rejects(rust.close(), code('PROCESS_EXIT')); assert.equal(processes.live, 0);
  assert.deepEqual(processes.exits, [{ code: null, signal: 'SIGKILL' }]);
  assert.equal(processes.frames.filter(frame => frame.operation === 'commitBoot').length, 0);
  assert.equal((await f.owner.dispatch(list(f.identity.datasetId)) as Page<CollectionModel>).total, 5_000); await f.close();
});

test('实际v3空库零上传与合法v7工作库5000身份保持', { timeout: 30_000 }, async t => {
  const first = await fixture(t), processes = observedChildren(t);
  const empty = await createRustReadonlyDatasetEndpointFromOwner({ binary, owner: first.owner, snapshotProfile: 'v3-5000' });
  assert.deepEqual(await empty.dispatch(list(first.identity.datasetId)), await first.owner.dispatch(list(first.identity.datasetId)));
  assert.equal(processes.frames.filter(frame => frame.operation === 'appendSnapshot').length, 0); await empty.close(); await first.close();
  const datasetId = '22222222-2222-7222-8222-222222222222';
  const db = new DatabaseSync(path.join(first.directory, 'backup-maintenance.v1.sqlite'));
  try { db.prepare("UPDATE dataset_identities SET dataset_id=? WHERE slot='default'").run(datasetId); } finally { db.close(); }
  const f = await fixture(t, { directory: first.directory }); assert.equal(f.identity.datasetId, datasetId); seedRustCollection(f.database, 5_000);
  const rust = await createRustReadonlyDatasetEndpointFromOwner({ binary, owner: f.owner, snapshotProfile: 'v3-5000' }); t.after(() => rust.close());
  assert.deepEqual(await rust.prepare(), f.identity); const ipc = list(datasetId, { stockState: 'recorded' });
  assert.deepEqual(await rust.dispatch(ipc), await f.owner.dispatch(ipc)); await rust.close(); await f.close();
});

test('真实5000库v3已发布后的Node写入unknown只受理一次，原命令冷启动可查', { timeout: 30_000 }, async t => {
  const f = await fixture(t, { crashAfterReceive: true }); seedRustCollection(f.database, 5_000);
  const observed = observedOwner(f.owner), processes = observedChildren(t);
  const router = await createRustReadonlyCollectionRouter({ binary, owner: observed.source, snapshotProfile: 'v3-5000' });
  t.after(() => router.close());
  await router.refresh(); const model = observed.captured!.snapshot.models[0]!, commandId = randomUUID();
  const receive = request('collection.receive', { commandId, model: { brand: model.brand, name: model.name, edition: model.edition,
    year: model.year, format: model.format, tapeType: model.tapeType, identification: model.identification }, lengthMinutes: 90,
    quantities: { sealedBlank: 1, openedBlank: 0, legacyUsed: 0, unclassified: 0 } }, f.identity.datasetId);
  const crashed = once(f.worker, 'exit');
  await assert.rejects(router.dispatch(receive), (error: unknown) => error instanceof DatasetOwnerTransportError && error.outcome === 'unknown' && error.requestId === receive.id);
  assert.deepEqual(await crashed, [19]); assert.equal(observed.calls.dispatch, 1); await router.close(); assert.equal(processes.live, 0);
  const restored = await fixture(t, { directory: f.directory });
  const result = await restored.owner.dispatch(receive); assert.ok(result); assert.equal(restored.identity.datasetId, f.identity.datasetId);
  const db = new DatabaseSync(restored.database, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM inventory_ledger WHERE command_id=?').get(commandId)!.n, 1);
    const receipt = db.prepare('SELECT result FROM inventory_ledger WHERE command_id=?').get(commandId)!;
    assert.deepEqual(result, JSON.parse(String(receipt.result)));
  } finally { db.close(); }
  await restored.close();
});
