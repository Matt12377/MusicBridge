import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import type { CollectionFilter, CollectionModel, IpcRequest, Page } from '@music-bridge/contracts';
import { createDatasetOwnerClient } from '../../src/collection/dataset-owner-client.js';
import { DatasetOwnerDispatchError, DatasetOwnerTransportError, type DatasetOwnerVersionedSnapshotEndpoint,
  type DatasetVersionedCollectionSnapshot } from '../../src/collection/dataset-owner-protocol.js';
import { createRustReadonlyCollectionRouter } from '../../src/rust-core/readonly-router.js';
import { RustSidecarError } from '../../src/rust-core/readonly-sidecar.js';
import { seedRustCollection } from '../helpers/rust-core-collection-fixture.js';

const binary = { path: process.env.MUSIC_BRIDGE_RUST_BINARY ?? '', sha256: process.env.MUSIC_BRIDGE_RUST_SHA256 ?? '' };
assert.ok(path.isAbsolute(binary.path) && /^[a-f0-9]{64}$/.test(binary.sha256), '实际刷新 Gate 必须提供本轮 Rust 二进制路径及摘要，不能条件跳过。');
assert.equal(createHash('sha256').update(readFileSync(binary.path)).digest('hex'), binary.sha256, '实际刷新 Gate 的二进制必须匹配本轮固定摘要。');
const code = (expected: string) => (error: unknown) => error instanceof RustSidecarError && error.code === expected;
function request(command: IpcRequest['command'], payload: unknown, datasetId: string): IpcRequest {
  return { version: 1, id: randomUUID(), command, payload, expectedDatasetId: datasetId };
}
const listRequest = (datasetId: string, filter: CollectionFilter = {}, page = { offset: 0, limit: 100 }) =>
  request('collection.list', { page, filter }, datasetId);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function until(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error('实际进程未及时到达合成观察点。');
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}
async function fixture(t: test.TestContext, options: { directory?: string; crashAfterReceive?: boolean } = {}) {
  const root = path.resolve(os.tmpdir()), external = '/Volumes/LifeWeave/Developer/CommandLine/tmp';
  const hosted = process.env.GITHUB_ACTIONS === 'true' && Boolean(process.env.RUNNER_TEMP);
  if (process.platform === 'darwin' && !hosted && root !== external && !root.startsWith(external + path.sep)) throw new Error('本机实际刷新 Gate 必须采用外置 TMPDIR。');
  const directory = options.directory ?? await mkdtemp(path.join(root, 'rust-refresh-owner-'));
  const helper = options.crashAfterReceive ? '../helpers/dataset-owner-domain-fixture.ts' : '../helpers/dataset-owner-version-fixture.ts';
  const worker = new Worker(new URL(helper, import.meta.url), {
    execArgv: ['--import', 'tsx'], workerData: { dataDirectory: directory,
      ...(options.crashAfterReceive ? { crashAfterReceive: true } : {}) },
  });
  const reasons: string[] = [], owner = createDatasetOwnerClient({ worker, onFatal: reason => reasons.push(reason) });
  let ownerExit: number | undefined;
  worker.once('exit', value => { ownerExit = value; });
  t.after(async () => { if (ownerExit === undefined) await owner.close(); });
  const identity = await owner.prepare();
  t.diagnostic(`合成两库证据目录：${directory}`);
  return { owner, worker, identity, reasons, directory, database: path.join(directory, 'collection.v1.sqlite'),
    async close() { const exit = once(worker, 'exit'); await owner.close(); assert.deepEqual(await exit, [0]); assert.deepEqual(reasons, []); },
  };
}
/** 只统计借用边界；所有实际工作仍由原 Node 两库 Owner 执行。 */
function observedOwner(owner: DatasetOwnerVersionedSnapshotEndpoint) {
  const calls = { prepare: 0, boot: 0, close: 0, version: 0, export: 0, dispatch: [] as IpcRequest[] };
  let captured: DatasetVersionedCollectionSnapshot | undefined;
  const source: DatasetOwnerVersionedSnapshotEndpoint = {
    ...owner,
    prepare() { calls.prepare++; return owner.prepare(); },
    commitBoot() { calls.boot++; return owner.commitBoot(); },
    close() { calls.close++; return owner.close(); },
    getCollectionSnapshotVersion() { calls.version++; return owner.getCollectionSnapshotVersion(); },
    async exportVersionedCollectionSnapshot() { calls.export++; captured = await owner.exportVersionedCollectionSnapshot(); return captured; },
    dispatch(input) { calls.dispatch.push(input); return owner.dispatch(input); },
  };
  return { source, calls, get captured() { return captured; } };
}
/** 旁路观察真实 spawn/退出与 Rust 回复，不代替二进制、流或帧。 */
function observedChildren(t: test.TestContext) {
  const original = childProcess.spawn;
  const exits: { code: number | null; signal: NodeJS.Signals | null }[] = [];
  const responses: Record<string, unknown>[] = [];
  let live = 0, peak = 0;
  const spawn = t.mock.method(childProcess, 'spawn', (...args: Parameters<typeof childProcess.spawn>) => {
    assert.equal(args[0], binary.path);
    const child = original(...args);
    live++; peak = Math.max(peak, live);
    child.once('close', (exitCode, signal) => { live--; exits.push({ code: exitCode, signal }); });
    let buffered = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      buffered += chunk.toString();
      while (buffered.includes('\n')) {
        const end = buffered.indexOf('\n');
        responses.push(JSON.parse(buffered.slice(0, end)) as Record<string, unknown>);
        buffered = buffered.slice(end + 1);
      }
    });
    return child;
  });
  return { spawn, exits, responses, get live() { return live; }, get peak() { return peak; },
    get dispatches() { return responses.filter(frame => frame.operation === 'dispatch').length; },
    assertNatural() { assert.equal(live, 0); assert.ok(exits.length > 0); assert.ok(exits.every(exit => exit.code === 0 && exit.signal === null)); },
  };
}

test('实际2000型号Node两库→固定Rust路由筛选分页差分，完整前后版本探测成本与自然退出', { timeout: 90_000 }, async t => {
  const children = observedChildren(t), f = await fixture(t);
  await f.owner.commitBoot(); const ids = seedRustCollection(f.database, 2_000);
  assert.ok((await stat(path.join(f.directory, 'backup-maintenance.v1.sqlite'))).isFile());
  const s = observedOwner(f.owner), router = await createRustReadonlyCollectionRouter({ binary, owner: s.source, startupTimeoutMs: 30_000 });
  t.after(() => router.close());
  assert.equal(router.getStatus().phase, 'node');
  const first = listRequest(f.identity.datasetId);
  const firstPage = await f.owner.dispatch(first);
  assert.deepEqual(await router.dispatch(first), firstPage);
  assert.deepEqual(s.calls.dispatch, [first]); assert.equal(s.calls.export, 0); assert.equal(children.spawn.mock.callCount(), 0);
  const started = performance.now(), refresh = router.refresh();
  assert.equal(refresh, router.refresh(), '并发显式刷新必须共用同一在途Promise。');
  await refresh; const refreshMs = performance.now() - started;
  const status = router.getStatus(); assert.equal(status.phase, 'rust');
  assert.equal(status.epoch, f.identity.epoch); assert.equal(status.datasetId, f.identity.datasetId);
  assert.equal(s.calls.export, 1); assert.equal(children.spawn.mock.callCount(), 1);
  assert.equal(s.captured!.snapshot.models.length, 2_000); assert.deepEqual(s.captured!.snapshot.models.map(model => model.id), ids);
  assert.equal(status.snapshotId, s.captured!.snapshot.snapshotId); assert.equal(status.revision, s.captured!.version.revision);
  const filters: CollectionFilter[] = [{}, { query: '　ＳＡ　９０％　' }, { query: 'A_B%' }, { query: '中文品牌🎵' },
    { brand: '　ＴＤＫ　' }, { decade: 'unknown' }, { stockState: 'recorded' }, { brand: 'TDK', decade: 1990, stockState: 'blank' }];
  const pages = [{ offset: 0, limit: 100 }, { offset: 99, limit: 3 }, { offset: 1999, limit: 100 }, { offset: 2000, limit: 1 }];
  let differentialPages = 0;
  const versionsBefore = s.calls.version, nodeReadsBefore = s.calls.dispatch.length;
  for (const filter of filters) for (const page of pages) {
    const input = listRequest(f.identity.datasetId, filter, page);
    assert.deepEqual(await router.dispatch(input), await f.owner.dispatch(input), JSON.stringify({ filter, page }));
    differentialPages++;
  }
  assert.equal(differentialPages, 32); assert.equal(children.dispatches, 32);
  assert.equal(s.calls.version - versionsBefore, differentialPages * 2); assert.equal(s.calls.dispatch.length, nodeReadsBefore);
  const nodeQueryRoundtripMs: number[] = [], rustQueryWithVersionProbesMs: number[] = [];
  const warmProbeStart = s.calls.version, warmRustStart = children.dispatches;
  for (let index = 0; index < 10; index++) {
    const input = listRequest(f.identity.datasetId, { brand: 'TDK', stockState: 'blank' });
    let tick = performance.now(); const expected = await f.owner.dispatch(input); nodeQueryRoundtripMs.push(performance.now() - tick);
    tick = performance.now(); const actual = await router.dispatch(input); rustQueryWithVersionProbesMs.push(performance.now() - tick);
    assert.deepEqual(actual, expected);
  }
  assert.equal(s.calls.version - warmProbeStart, 20); assert.equal(children.dispatches - warmRustStart, 10);
  const contextual = { ...listRequest(f.identity.datasetId), readContext: { deadlineAtMs: Date.now() + 5_000 } };
  const childReadStart = children.dispatches;
  // 现有Node公开合同拒绝collection.list的readContext；路由必须转交并保留该失败。
  const contextualFailure: unknown = await f.owner.dispatch(contextual).catch((error: unknown) => error);
  assert.ok(contextualFailure instanceof DatasetOwnerDispatchError);
  await assert.rejects(router.dispatch(contextual), error => error instanceof DatasetOwnerDispatchError
    && JSON.stringify(error.failure) === JSON.stringify(contextualFailure.failure));
  assert.equal(s.calls.dispatch.at(-1), contextual); assert.equal(children.dispatches, childReadStart);
  const closingStarted = performance.now(), closing = router.close(); assert.equal(closing, router.close()); await closing;
  const closeMs = performance.now() - closingStarted;
  assert.equal(router.getStatus().phase, 'closed'); children.assertNatural(); assert.equal(children.peak, 1);
  assert.deepEqual({ prepare: s.calls.prepare, boot: s.calls.boot, close: s.calls.close }, { prepare: 0, boot: 0, close: 0 });
  assert.deepEqual(await f.owner.dispatch(first), firstPage, '关闭路由后借用的Node来源仍可调用。');
  const cost = { schemaVersion: 1, task: 'RUST-003', models: 2_000, differentialPages,
    binarySha256: binary.sha256, nodeVersion: process.version, platform: process.platform, architecture: process.arch,
    data: 'synthetic-real-two-database-Node-owner-to-pinned-Rust-router', cacheState: 'warm-Node-owner-and-OS-cache-not-controlled',
    refreshMs, closeMs, nodeQueryRoundtripMs, rustQueryWithVersionProbesMs,
    snapshotJsonBytes: Buffer.byteLength(JSON.stringify(s.captured!.snapshot)),
    counts: { refreshExports: s.calls.export, warmVersionRoundtrips: s.calls.version - warmProbeStart,
      warmRustQueries: children.dispatches - warmRustStart, rustChildren: children.spawn.mock.callCount(), peakLiveRustChildren: children.peak,
      naturalRustExits: children.exits, borrowedOwnerPrepare: s.calls.prepare, borrowedOwnerBoot: s.calls.boot, borrowedOwnerClose: s.calls.close },
    costScope: 'Node基线含线程RPC与Node响应验证；Rust计时含前后两次Node版本RPC、Rust往返、TS结果验证，差分assert在计时之外。',
    costLimitations: '固定10次warm合成样本；OS缓存未控制，无冷启动/真实库/真实设备证据，不据此承诺性能收益。',
    realServices: 'NOT_RUN', productionDefault: 'Node' };
  const output = process.env.MUSIC_BRIDGE_RUST_REFRESH_COST_REPORT;
  assert.ok(output && path.isAbsolute(output), '实际刷新成本Gate必须提供绝对报告路径。');
  await writeFile(output, JSON.stringify(cost, null, 2) + '\n'); t.diagnostic(JSON.stringify(cost));
  await f.close();
});

test('实际来源同连接写入与另一连接提交在查询前失效，本次只读Node一次，显式刷新恢复新事实', { timeout: 30_000 }, async t => {
  const children = observedChildren(t), f = await fixture(t); await f.owner.commitBoot(); seedRustCollection(f.database, 101);
  const s = observedOwner(f.owner), router = await createRustReadonlyCollectionRouter({ binary, owner: s.source }); t.after(() => router.close());
  await router.refresh(); const old = router.getStatus(), input = listRequest(f.identity.datasetId);
  const original = await f.owner.dispatch(input) as Page<CollectionModel>, first = original.items[0]!;
  await f.owner.dispatch(request('collection.setPolicy', { commandId: randomUUID(), modelId: first.id, expectedRevision: first.revision,
    collectorPolicy: 'collector', minimumSealedReserve: 1 }, f.identity.datasetId));
  assert.equal(router.getStatus().phase, 'rust', '按读取探测的路由不会伪称收到后台版本通知。');
  const rustReads = children.dispatches, nodeReads = s.calls.dispatch.length;
  const updated = await router.dispatch(input) as Page<CollectionModel>;
  assert.equal(updated.items[0]!.revision, 2); assert.equal(updated.items[0]!.collectorPolicy, 'collector');
  assert.deepEqual(updated, await f.owner.dispatch(input)); assert.equal(router.getStatus().phase, 'stale');
  assert.equal(children.dispatches, rustReads); assert.equal(s.calls.dispatch.length - nodeReads, 1);
  await router.refresh(); const fresh = router.getStatus();
  assert.notEqual(fresh.snapshotId, old.snapshotId); assert.notEqual(fresh.revision, old.revision);
  assert.deepEqual(await router.dispatch(input), updated); assert.equal(children.dispatches - rustReads, 1);
  const writer = new DatabaseSync(f.database);
  try { writer.prepare('UPDATE collection_models SET revision=revision+1 WHERE id=?').run(first.id); } finally { writer.close(); }
  const nextRustReads = children.dispatches, nextNodeReads = s.calls.dispatch.length;
  const external = await router.dispatch(input) as Page<CollectionModel>;
  assert.equal(external.items[0]!.revision, 3); assert.equal(router.getStatus().phase, 'stale');
  assert.equal(children.dispatches, nextRustReads); assert.equal(s.calls.dispatch.length - nextNodeReads, 1);
  await router.refresh(); assert.deepEqual(await router.dispatch(input), external);
  await router.close(); children.assertNatural(); assert.equal(children.peak, 1); assert.equal(children.exits.length, 3);
  assert.equal(s.calls.close, 0); assert.deepEqual(await f.owner.dispatch(input), external); await f.close();
});

test('真实Rust读取后末次版本探测注入实际Node写入，旧结果拒绝且不执行第二次公开读取', { timeout: 30_000 }, async t => {
  const children = observedChildren(t), f = await fixture(t); await f.owner.commitBoot(); seedRustCollection(f.database, 101);
  const s = observedOwner(f.owner), input = listRequest(f.identity.datasetId);
  const first = (await f.owner.dispatch(input) as Page<CollectionModel>).items[0]!;
  let inject = false, queryProbes = 0;
  const source = { ...s.source, async getCollectionSnapshotVersion() {
    if (inject && ++queryProbes === 2) {
      assert.equal(children.dispatches, 1, '只在真实Rust读取回执后、最终版本探测前注入合成写入。');
      await f.owner.dispatch(request('collection.setPolicy', { commandId: randomUUID(), modelId: first.id, expectedRevision: first.revision,
        collectorPolicy: 'collector', minimumSealedReserve: 1 }, f.identity.datasetId));
    }
    return s.source.getCollectionSnapshotVersion();
  } };
  const router = await createRustReadonlyCollectionRouter({ binary, owner: source }); t.after(() => router.close()); await router.refresh(); inject = true;
  await assert.rejects(router.dispatch(input), code('STALE_SNAPSHOT'));
  assert.equal(queryProbes, 2); assert.equal(children.dispatches, 1); assert.equal(s.calls.dispatch.length, 0);
  assert.equal(router.getStatus().phase, 'stale');
  assert.equal((await f.owner.dispatch(input) as Page<CollectionModel>).items[0]!.revision, 2);
  await router.close(); children.assertNatural(); await f.close();
});

test('真实候选已boot但最终版本探测迟到，关闭等待候选自然退出且禁止重新发布', { timeout: 30_000 }, async t => {
  const children = observedChildren(t), f = await fixture(t); await f.owner.commitBoot(); seedRustCollection(f.database, 101);
  const s = observedOwner(f.owner), release = deferred<void>(), entered = deferred<void>(); let probes = 0;
  const source = { ...s.source, async getCollectionSnapshotVersion() {
    const version = await s.source.getCollectionSnapshotVersion();
    if (++probes === 2) { entered.resolve(); await release.promise; }
    return version;
  } };
  const router = await createRustReadonlyCollectionRouter({ binary, owner: source }); t.after(() => router.close());
  const refresh = router.refresh(), refreshFailure = assert.rejects(refresh, code('STALE_SNAPSHOT'));
  await entered.promise;
  assert.equal(children.spawn.mock.callCount(), 1); assert.equal(children.live, 1);
  assert.ok(children.responses.some(frame => frame.operation === 'commitBoot' && frame.ok === true));
  let closed = false; const closing = router.close().then(() => { closed = true; });
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(closed, false); assert.equal(router.getStatus().phase, 'closed');
  release.resolve(); await refreshFailure; await closing;
  assert.equal(router.getStatus().phase, 'closed'); children.assertNatural(); assert.equal(s.calls.close, 0);
  assert.equal((await f.owner.dispatch(listRequest(f.identity.datasetId)) as Page<CollectionModel>).total, 101); await f.close();
});

test('实际未boot、来源关闭与超预算刷新均拒绝，来源不被路由boot或关闭', { timeout: 30_000 }, async t => {
  const children = observedChildren(t), f = await fixture(t), s = observedOwner(f.owner);
  await assert.rejects(createRustReadonlyCollectionRouter({ binary, owner: s.source }), code('SNAPSHOT_UNAVAILABLE'));
  assert.equal(children.spawn.mock.callCount(), 0); assert.equal(s.calls.boot, 0);
  await f.owner.commitBoot(); seedRustCollection(f.database, 2_001);
  const router = await createRustReadonlyCollectionRouter({ binary, owner: s.source }); t.after(() => router.close());
  await assert.rejects(router.refresh(), code('SNAPSHOT_UNAVAILABLE'));
  assert.equal(router.getStatus().phase, 'failed'); assert.equal(children.spawn.mock.callCount(), 0);
  const input = listRequest(f.identity.datasetId), page = await router.dispatch(input) as Page<CollectionModel>;
  assert.equal(page.total, 2_001); assert.equal(page.items.length, 100); assert.deepEqual(s.calls.dispatch, [input]);
  await router.close(); assert.equal(s.calls.close, 0); await f.close();
  await assert.rejects(createRustReadonlyCollectionRouter({ binary, owner: s.source }), code('SNAPSHOT_UNAVAILABLE'));
  assert.deepEqual({ prepare: s.calls.prepare, boot: s.calls.boot, close: s.calls.close }, { prepare: 0, boot: 0, close: 0 });
});

test('实际来源关闭后Rust前置探测失败可观察，不交付旧快照或Node成功fallback', { timeout: 30_000 }, async t => {
  const children = observedChildren(t), f = await fixture(t); await f.owner.commitBoot(); seedRustCollection(f.database, 101);
  const s = observedOwner(f.owner), router = await createRustReadonlyCollectionRouter({ binary, owner: s.source }); t.after(() => router.close());
  await router.refresh(); await f.close();
  await assert.rejects(router.dispatch(listRequest(f.identity.datasetId)), code('SNAPSHOT_UNAVAILABLE'));
  assert.equal(router.getStatus().phase, 'failed'); assert.equal(router.getStatus().errorCode, 'SNAPSHOT_UNAVAILABLE');
  assert.equal(children.dispatches, 0); assert.equal(s.calls.dispatch.length, 0);
  await router.close(); children.assertNatural(); assert.equal(s.calls.close, 0);
});

test('实际合成落库后断链保留unknown与命令身份，路由只发送一次，冷启证明一条收据', { timeout: 30_000 }, async t => {
  const children = observedChildren(t), f = await fixture(t, { crashAfterReceive: true }); await f.owner.commitBoot();
  const s = observedOwner(f.owner), router = await createRustReadonlyCollectionRouter({ binary, owner: s.source }); t.after(() => router.close()); await router.refresh();
  const commandId = randomUUID(), input = request('collection.receive', { commandId,
    model: { brand: '合成', name: '路由断链收据', edition: '测试', year: 1990, format: 'cassette', tapeType: 'II', identification: 'verified' },
    lengthMinutes: 60, quantities: { openedBlank: 1, sealedBlank: 0, legacyUsed: 0, unclassified: 0 } }, f.identity.datasetId);
  const exit = once(f.worker, 'exit'), writing = router.dispatch(input);
  assert.equal(router.getStatus().phase, 'stale'); await assert.rejects(router.refresh(), code('NOT_READY'));
  await assert.rejects(writing, error => error instanceof DatasetOwnerTransportError && error.outcome === 'unknown'
    && error.requestId === input.id && error.command === input.command);
  assert.deepEqual(await exit, [19]); assert.deepEqual(f.reasons, ['worker-exit']); assert.deepEqual(s.calls.dispatch, [input]);
  assert.equal((s.calls.dispatch[0]!.payload as { commandId: string }).commandId, commandId);
  await router.close(); children.assertNatural(); assert.equal(s.calls.close, 0); assert.equal(children.dispatches, 0);
  const reopened = await fixture(t, { directory: f.directory }); await reopened.owner.commitBoot(); assert.equal(reopened.identity.datasetId, f.identity.datasetId);
  const persisted = await reopened.owner.dispatch(listRequest(reopened.identity.datasetId)) as Page<CollectionModel>;
  assert.equal(persisted.total, 1); assert.equal(persisted.items[0]!.name, '路由断链收据');
  await until(() => children.live === 0); await reopened.close();
});
