import assert from 'node:assert/strict';
import childProcess, { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import type { CollectionDetail, CollectionFilter, CollectionModel, CollectionMutationResult, IpcRequest, Page } from '@music-bridge/contracts';
import { createDatasetOwnerClient } from '../../src/collection/dataset-owner-client.js';
import type { DatasetOwnerLargeSnapshotEndpoint, DatasetVersionedCollectionSnapshot } from '../../src/collection/dataset-owner-protocol.js';
import { createCollectionSnapshotQueryIndex, filterCollectionSnapshot } from '../../src/rust-core/collection-query.js';
import { createRustReadonlyCollectionRouter, type RustReadonlyCollectionRouter } from '../../src/rust-core/readonly-router.js';
import { seedRustCollection } from '../helpers/rust-core-collection-fixture.js';

const binary = { path: process.env.MUSIC_BRIDGE_RUST_BINARY ?? '', sha256: process.env.MUSIC_BRIDGE_RUST_SHA256 ?? '' };
assert.ok(path.isAbsolute(binary.path) && /^[a-f0-9]{64}$/.test(binary.sha256), '实际索引 Gate 必须提供本轮固定 Rust 二进制，不能条件跳过。');
const evidenceRoot = '/Volumes/LifeWeave/Developer/CommandLine/tmp';
const baselineBaseCommit = 'd2676884a537bf3d232ed2cc957fef11b6d5cfeb';
const baselineBinarySha256 = '1e2b5164591204772196f987009ae254bda2fcb807471f5ff917ec65b5c105ea';
const baselineModulePins = [
  { name: 'readonly-router.ts', sha256: '51e648e6920b08c2b25f263509c8868f408a27a6ed5ea2d547e2e9ebd02dd8c6' },
  { name: 'readonly-sidecar.ts', sha256: 'bd826746375fc15945b397efec9ec1e4fe5156c846cc943aab3fb05c90e84d02' },
  { name: 'collection-query.ts', sha256: '42a61da3f44484b64ad1f68ba7f1fdcf972df5d6d628cdd4865339a2f1e73a5b' },
] as const;
const request = (command: IpcRequest['command'], payload: unknown, datasetId: string): IpcRequest =>
  ({ version: 1, id: randomUUID(), command, payload, expectedDatasetId: datasetId });
const list = (datasetId: string, filter: CollectionFilter = {}, page = { offset: 0, limit: 100 }) =>
  request('collection.list', { filter, page }, datasetId);
const hashFile = async (file: string | URL) => createHash('sha256').update(await readFile(file)).digest('hex');
const isExternalEvidence = (file: string) => file === evidenceRoot || file.startsWith(evidenceRoot + path.sep);

async function fixture(t: test.TestContext) {
  const root = path.resolve(os.tmpdir());
  const hosted = process.env.GITHUB_ACTIONS === 'true' && Boolean(process.env.RUNNER_TEMP);
  if (process.platform === 'darwin' && !hosted) {
    assert.ok(isExternalEvidence(root), '本机索引 Gate 必须使用外置 TMPDIR。');
    assert.ok(isExternalEvidence(await realpath(root)), '外置 TMPDIR 不能经符号链接回落到本机目录。');
  }
  const directory = await mkdtemp(path.join(root, 'rust-index-owner-'));
  const worker = new Worker(new URL('../helpers/dataset-owner-domain-fixture.ts', import.meta.url), {
    execArgv: ['--import', 'tsx'], workerData: { dataDirectory: directory },
  });
  const reasons: string[] = [], owner = createDatasetOwnerClient({ worker, onFatal: reason => reasons.push(reason) });
  let exited = false;
  worker.once('exit', () => { exited = true; });
  t.after(async () => { if (!exited) await owner.close(); });
  const identity = await owner.prepare(); await owner.commitBoot();
  return { owner, identity, directory, database: path.join(directory, 'collection.v1.sqlite'),
    async close() { const exit = once(worker, 'exit'); await owner.close(); assert.deepEqual(await exit, [0]); assert.deepEqual(reasons, []); },
  };
}

function observedOwner(owner: DatasetOwnerLargeSnapshotEndpoint) {
  const calls = { prepare: 0, boot: 0, close: 0, version: 0, export: 0, dispatch: 0 };
  const exports: { snapshotId: string; revision: string; elapsedMs: number; models: number; jsonBytes: number }[] = [];
  let captured: DatasetVersionedCollectionSnapshot | undefined;
  const source: DatasetOwnerLargeSnapshotEndpoint = {
    ...owner,
    prepare() { calls.prepare++; return owner.prepare(); },
    commitBoot() { calls.boot++; return owner.commitBoot(); },
    close() { calls.close++; return owner.close(); },
    getCollectionSnapshotVersion() { calls.version++; return owner.getCollectionSnapshotVersion(); },
    async exportVersionedCollectionSnapshot() {
      calls.export++; const tick = performance.now(); captured = await owner.exportVersionedCollectionSnapshot();
      exports.push({ snapshotId: captured.snapshot.snapshotId, revision: captured.version.revision, elapsedMs: performance.now() - tick,
        models: captured.snapshot.models.length, jsonBytes: Buffer.byteLength(JSON.stringify(captured.snapshot)) });
      return captured;
    },
    async exportLargeVersionedCollectionSnapshot() {
      calls.export++; const tick = performance.now(); captured = await owner.exportLargeVersionedCollectionSnapshot();
      exports.push({ snapshotId: captured.snapshot.snapshotId, revision: captured.version.revision, elapsedMs: performance.now() - tick,
        models: captured.snapshot.models.length, jsonBytes: Buffer.byteLength(JSON.stringify(captured.snapshot)) });
      return captured;
    },
    dispatch(input) { calls.dispatch++; return owner.dispatch(input); },
  };
  return { source, calls, exports, get captured() { assert.ok(captured); return captured; } };
}

/** 仅观察真实 child，完整旧路径与本期路径都继续使用原来的管道。 */
function observedChildren(t: test.TestContext, paths: readonly string[]) {
  const original = childProcess.spawn;
  const children: ChildProcessWithoutNullStreams[] = [];
  const exits: { code: number | null; signal: NodeJS.Signals | null }[] = [];
  let live = 0, peak = 0;
  t.mock.method(childProcess, 'spawn', (...args: Parameters<typeof childProcess.spawn>) => {
    assert.ok(paths.includes(String(args[0])), '只能启动本期或固定旧基线二进制。');
    assert.equal(live, 0, '阶段切换与刷新必须等旧 child 完整退出。');
    const child = original(...args) as ChildProcessWithoutNullStreams;
    children.push(child); live++; peak = Math.max(peak, live);
    child.once('close', (code, signal) => { live--; exits.push({ code, signal }); });
    return child;
  });
  return { children, exits, get live() { return live; }, get peak() { return peak; } };
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
const workloads = [
  { name: 'unfiltered', filter: {} }, { name: 'selective-brand-stock', filter: { brand: 'TDK', stockState: 'blank' } },
  { name: 'literal-percent-underscore', filter: { query: 'A_B%' } }, { name: 'unicode', filter: { query: '中文品牌🎵' } },
  { name: 'decade', filter: { decade: 1990 } }, { name: 'empty-result', filter: { brand: '不存在' } },
] satisfies { name: string; filter: CollectionFilter }[];

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freezeDeep(child); Object.freeze(value); }
  return value;
}
function expectedPage(models: readonly CollectionModel[], filter: CollectionFilter, page: { offset: number; limit: number }): Page<CollectionModel> {
  const matched = filterCollectionSnapshot(models, filter);
  return { items: matched.slice(page.offset, page.offset + page.limit), total: matched.length,
    offset: page.offset, limit: page.limit, hasMore: page.offset + page.limit < matched.length };
}

async function differential(f: Awaited<ReturnType<typeof fixture>>, router: RustReadonlyCollectionRouter,
  models: readonly CollectionModel[], ids: readonly string[]) {
  assert.deepEqual(models.map(model => model.id), ids, '真实导出保持原 rowid ordinal。');
  let completePages = 0, differentialPages = 0;
  for (let offset = 0; offset < Math.max(models.length, 1); offset += 100) {
    const page = { offset, limit: 100 }, ipc = list(f.identity.datasetId, {}, page);
    assert.deepEqual(await router.dispatch(ipc), expectedPage(models, {}, page));
    assert.deepEqual(await router.dispatch(ipc), await f.owner.dispatch(ipc)); completePages++;
  }
  const index = createCollectionSnapshotQueryIndex(models);
  for (const filter of filters) {
    assert.deepEqual(index.filter(filter), filterCollectionSnapshot(models, filter));
    for (const page of [{ offset: 0, limit: 100 }, { offset: 99, limit: 3 }, { offset: Math.max(0, models.length - 1), limit: 100 }, { offset: models.length, limit: 1 }]) {
      const ipc = list(f.identity.datasetId, filter, page), rust = await router.dispatch(ipc);
      assert.deepEqual(rust, await f.owner.dispatch(ipc), JSON.stringify({ filter, page }));
      assert.deepEqual(rust, expectedPage(models, filter, page)); differentialPages++;
    }
  }
  if (models.length) {
    assert.ok(filterCollectionSnapshot(models, { decade: 'unknown' }).length > 0);
    assert.ok(filterCollectionSnapshot(models, { decade: 2200 }).length > 0);
    assert.ok(models.some(model => (['identified', 'needs-review', 'blank', 'recorded'] as const).filter(stockState =>
      filterCollectionSnapshot([model], { stockState }).length).length > 1), '实际快照覆盖库存状态重叠。');
    assert.ok(filterCollectionSnapshot(models, { query: 'A_B%' }).length > 0);
    const normalizedUpper = filterCollectionSnapshot(models, { brand: 'É' });
    assert.ok(normalizedUpper.length > 0);
    assert.ok(normalizedUpper.every(model => model.brand === 'é'), '查询Unicode lower不能改变行端仅ASCII lower的不对称。');
  }
  return { completePages, differentialPages, filters: filters.length, compared: '完整DTO、total、offset、limit、hasMore、导出ordinal' };
}

async function warmCost(f: Awaited<ReturnType<typeof fixture>>, router: RustReadonlyCollectionRouter,
  observed: ReturnType<typeof observedOwner>) {
  // 两个阶段都先运行相同六种未计时调用，避免把旧阶段的第一笔当作warm。
  for (const workload of workloads) {
    const ipc = list(f.identity.datasetId, workload.filter);
    assert.deepEqual(await router.dispatch(ipc), await f.owner.dispatch(ipc));
  }
  const measured = [], versionStart = observed.calls.version, dispatchStart = observed.calls.dispatch;
  for (const workload of workloads) {
    const nodeQueryRoundtripMs: number[] = [], rustQueryWithVersionProbesMs: number[] = [];
    for (let sample = 0; sample < 10; sample++) {
      const ipc = list(f.identity.datasetId, workload.filter);
      let now = performance.now(); const node = await f.owner.dispatch(ipc); nodeQueryRoundtripMs.push(performance.now() - now);
      now = performance.now(); const rust = await router.dispatch(ipc); rustQueryWithVersionProbesMs.push(performance.now() - now);
      assert.deepEqual(rust, node);
    }
    measured.push({ ...workload, nodeQueryRoundtripMs, rustQueryWithVersionProbesMs });
  }
  assert.equal(observed.calls.version - versionStart, 120);
  assert.equal(observed.calls.dispatch - dispatchStart, 0, 'warm Rust调用不得回落到Node查询。');
  return { workloads: measured, counts: { nodeQueries: 60, rustQueries: 60, versionRoundtrips: 120, nodeFallbackQueries: 0,
    untimedWarmupNodeQueries: 6, untimedWarmupRustQueries: 6, untimedWarmupVersionRoundtrips: 12 } };
}

function pureTsCost(models: readonly CollectionModel[]) {
  const buildMs: number[] = [];
  for (let sample = 0; sample < 10; sample++) { const now = performance.now(); createCollectionSnapshotQueryIndex(models); buildMs.push(performance.now() - now); }
  const index = createCollectionSnapshotQueryIndex(models), measured = [];
  for (const workload of workloads) {
    assert.deepEqual(index.filter(workload.filter), filterCollectionSnapshot(models, workload.filter));
    const linearFilterMs: number[] = [], indexedFilterMs: number[] = [];
    for (let sample = 0; sample < 10; sample++) {
      let now = performance.now(); const linear = filterCollectionSnapshot(models, workload.filter); linearFilterMs.push(performance.now() - now);
      now = performance.now(); const indexed = index.filter(workload.filter); indexedFilterMs.push(performance.now() - now);
      assert.deepEqual(indexed, linear);
    }
    measured.push({ ...workload, linearFilterMs, indexedFilterMs });
  }
  return { buildMs, workloads: measured, scope: '只计衍生索引建立或纯filter调用，均返回完整匹配数组；不含JSON深拷贝、freeze、分页、线程/进程、DTO校验或assert。' };
}

/** 真实写命令改变筛选集合；非空库保持型号数，避免5000刷新越界。 */
async function writeAndRefresh(f: Awaited<ReturnType<typeof fixture>>, router: RustReadonlyCollectionRouter,
  observed: ReturnType<typeof observedOwner>) {
  const before = freezeDeep(structuredClone(observed.captured.snapshot.models)), oldSnapshotId = router.getStatus().snapshotId;
  let targetId: string;
  if (!before.length) {
    const receipt = await f.owner.dispatch(request('collection.receive', { commandId: randomUUID(),
      model: { brand: '写后品牌', name: 'A_B%', edition: '一版', year: 2200, format: 'cassette', tapeType: 'II', identification: 'candidate' },
      lengthMinutes: 90, quantities: { sealedBlank: 1, openedBlank: 1, legacyUsed: 1, unclassified: 1 } }, f.identity.datasetId)) as CollectionMutationResult;
    targetId = receipt.modelId;
  } else {
    const target = before.find(model => model.counts.sealedBlank === 2 && model.counts.openedBlank === 0)!;
    assert.ok(target, '合成库应提供一份lot封存空白与一份实体封存空白。'); targetId = target.id;
    const detail = await f.owner.dispatch(request('collection.detail', { modelId: target.id, page: { offset: 0, limit: 100 } }, f.identity.datasetId)) as CollectionDetail;
    const copy = detail.copies.items.find(item => item.usage === 'blank' && item.available)!; assert.ok(copy);
    await f.owner.dispatch(request('collection.updateCopy', { commandId: randomUUID(), physicalId: copy.physicalId,
      expectedRevision: copy.revision, action: 'reserve' }, f.identity.datasetId));
    const materialized = await f.owner.dispatch(request('collection.materialize', { commandId: randomUUID(), lotId: copy.lotId,
      bucket: 'sealedBlank', action: 'identify' }, f.identity.datasetId)) as CollectionMutationResult;
    assert.ok(materialized.physicalId);
    await f.owner.dispatch(request('collection.updateCopy', { commandId: randomUUID(), physicalId: materialized.physicalId,
      expectedRevision: 1, action: 'reserve' }, f.identity.datasetId));
  }
  const blank = list(f.identity.datasetId, { stockState: 'blank' }), live = await f.owner.dispatch(blank) as Page<CollectionModel>;
  assert.deepEqual(await router.dispatch(blank), live); assert.equal(router.getStatus().phase, 'stale');
  const oldIds = filterCollectionSnapshot(before, { stockState: 'blank' }).map(model => model.id);
  if (before.length) assert.ok(oldIds.includes(targetId)); else assert.equal(oldIds.length, 0);
  router.invalidate(); const tick = performance.now(); await router.refresh(); const refreshMs = performance.now() - tick;
  assert.notEqual(router.getStatus().snapshotId, oldSnapshotId);
  const after = freezeDeep(structuredClone(observed.captured.snapshot.models));
  assert.equal(after.length, before.length || 1);
  const oldIndex = createCollectionSnapshotQueryIndex(before), newIndex = createCollectionSnapshotQueryIndex(after);
  assert.deepEqual(oldIndex.filter({ stockState: 'blank' }).map(model => model.id), oldIds);
  const target = after.find(model => model.id === targetId)!; assert.ok(target);
  if (before.length) { assert.equal(target.counts.sealedBlank + target.counts.openedBlank, 0); assert.equal(target.counts.reserved, 2); }
  else assert.ok(target.counts.legacyUsed > 0 && target.counts.unknown > 0 && target.counts.sealedBlank > 0);
  let pages = 0;
  for (const stockState of ['identified', 'needs-review', 'blank', 'recorded'] as const) {
    const filter = { stockState }, ipc = list(f.identity.datasetId, filter), rust = await router.dispatch(ipc);
    assert.deepEqual(newIndex.filter(filter), filterCollectionSnapshot(after, filter));
    assert.deepEqual(rust, await f.owner.dispatch(ipc)); assert.deepEqual(rust, expectedPage(after, filter, { offset: 0, limit: 100 })); pages++;
  }
  assert.equal(newIndex.filter({ stockState: 'blank' }).some(model => model.id === targetId), !before.length);
  return { pages, refreshMs, beforeSnapshotId: oldSnapshotId, afterSnapshotId: router.getStatus().snapshotId,
    beforeModels: before.length, afterModels: after.length, changedModelId: targetId, operation: before.length ? 'materialize-and-reserve-removes-blank-posting' : 'receive-adds-overlapping-stock-postings' };
}

async function baselineIdentity() {
  const routerPath = process.env.MUSIC_BRIDGE_RUST_BASELINE_ROUTER;
  const binaryPath = process.env.MUSIC_BRIDGE_RUST_BASELINE_BINARY;
  const sha256 = process.env.MUSIC_BRIDGE_RUST_BASELINE_SHA256;
  if (!routerPath && !binaryPath && !sha256) return undefined;
  assert.ok(routerPath && binaryPath && sha256, '旧完整路径对照必须同时提供router、binary和SHA。');
  assert.ok(path.isAbsolute(routerPath) && path.isAbsolute(binaryPath) && /^[a-f0-9]{64}$/.test(sha256));
  assert.equal(sha256, baselineBinarySha256, '旧完整路径只能使用已提交RUST-004固定二进制身份。');
  assert.equal(await hashFile(binaryPath), sha256, '旧004二进制必须符合固定SHA。');
  const directory = path.dirname(routerPath);
  assert.equal(path.basename(routerPath), 'readonly-router.ts');
  const sourceModules = await Promise.all(baselineModulePins.map(async pin => {
    const modulePath = path.join(directory, pin.name), actual = await hashFile(modulePath);
    assert.equal(actual, pin.sha256, '旧004模块必须对应固定基线提交：' + pin.name);
    return { name: pin.name, path: modulePath, sha256: actual };
  }));
  const module = await import(pathToFileURL(routerPath).href) as { createRustReadonlyCollectionRouter: typeof createRustReadonlyCollectionRouter };
  assert.equal(typeof module.createRustReadonlyCollectionRouter, 'function');
  return { factory: module.createRustReadonlyCollectionRouter, binary: { path: binaryPath, sha256 }, sourceModules,
    async verifyAfterComparison() {
      assert.equal(await hashFile(binaryPath), baselineBinarySha256, '旧004对照结束后的二进制身份不能改变。');
      for (const source of sourceModules) assert.equal(await hashFile(source.path), source.sha256, '旧004对照结束后的同一模块不能改变：' + source.name);
    } };
}

test('RUST-005真实两库四规模索引差分、写后换代与六工作量完整调用成本', { timeout: 180_000 }, async t => {
  assert.equal(await hashFile(binary.path), binary.sha256);
  const baseline = await baselineIdentity(), processes = observedChildren(t, [binary.path, ...(baseline ? [baseline.binary.path] : [])]);
  const scales = [];
  let baselineSnapshot: DatasetVersionedCollectionSnapshot | undefined;
  let baselineReport: unknown = { status: 'NOT_RUN', reason: '未配置本机已提交RUST-004模块与固定二进制；本期真实差分和成本继续完整执行。' };
  for (const models of [0, 100, 2_000, 5_000]) {
    const f = await fixture(t), ids = seedRustCollection(f.database, models);
    if (models === 5_000 && baseline) {
      const observed = observedOwner(f.owner);
      const router = await baseline.factory({ binary: baseline.binary, owner: observed.source, snapshotProfile: 'v3-5000', startupTimeoutMs: 30_000 });
      t.after(() => router.close());
      const tick = performance.now(); await router.refresh(); const refreshMs = performance.now() - tick;
      assert.equal(router.getStatus().phase, 'rust'); assert.deepEqual(observed.captured.snapshot.models.map(model => model.id), ids);
      baselineSnapshot = observed.captured;
      const cost = await warmCost(f, router, observed), closing = performance.now(); await router.close(); const closeMs = performance.now() - closing;
      assert.equal(processes.live, 0); assert.deepEqual([observed.calls.prepare, observed.calls.boot, observed.calls.close], [0, 0, 0]);
      baselineReport = { status: 'RUN', baseCommit: baselineBaseCommit, phase: 'old-004-before-candidate-005-on-same-owner-and-database', models, directory: f.directory,
        binary: baseline.binary, binarySha256: baseline.binary.sha256, routerPath: baseline.sourceModules[0]!.path,
        sourceModules: baseline.sourceModules, refreshMs, closeMs, exports: observed.exports, calls: observed.calls, ...cost };
    }
    const observed = observedOwner(f.owner), router = await createRustReadonlyCollectionRouter({ binary, owner: observed.source,
      snapshotProfile: models > 2_000 ? 'v3-5000' : 'v2-2000', startupTimeoutMs: 30_000 });
    t.after(() => router.close());
    assert.equal(router.getStatus().phase, 'node');
    const tick = performance.now(); await router.refresh(); const refreshMs = performance.now() - tick;
    assert.equal(router.getStatus().phase, 'rust');
    const snapshot = observed.captured;
    if (models === 5_000 && baselineSnapshot) {
      assert.equal(snapshot.version.revision, baselineSnapshot.version.revision, '分阶段成本对照必须使用同一Node版本。');
      assert.notEqual(snapshot.snapshot.snapshotId, baselineSnapshot.snapshot.snapshotId);
      assert.deepEqual(snapshot.snapshot.models, baselineSnapshot.snapshot.models, '旧新完整路径使用完全相同事实。');
    }
    const frozen = freezeDeep(structuredClone(snapshot.snapshot.models));
    const compared = await differential(f, router, frozen, ids);
    const pureTs = pureTsCost(frozen);
    const cost = models === 5_000 ? await warmCost(f, router, observed) : undefined;
    const written = await writeAndRefresh(f, router, observed);
    const closing = performance.now(); await router.close(); const closeMs = performance.now() - closing;
    assert.equal(processes.live, 0); assert.deepEqual([observed.calls.prepare, observed.calls.boot, observed.calls.close], [0, 0, 0]);
    scales.push({ models, directory: f.directory, snapshotProfile: models > 2_000 ? 'v3-5000' : 'v2-2000', snapshotId: snapshot.snapshot.snapshotId,
      refreshMs, closeMs, exports: observed.exports, calls: observed.calls, ...compared, pureTs, ...(cost ? { fullRouterWarmCost: cost } : {}), ...(written ? { writeAndRefresh: written } : {}) });
    await f.close();
  }
  assert.equal(processes.peak, 1); assert.equal(processes.live, 0);
  assert.equal(processes.exits.length, processes.children.length);
  assert.ok(processes.exits.every(exit => exit.code === 0 && exit.signal === null), '所有真实Rust child必须自然退出0。');
  await baseline?.verifyAfterComparison();
  const sourceModules = await Promise.all(['readonly-router.ts', 'readonly-sidecar.ts', 'collection-query.ts'].map(async name =>
    ({ name, sha256: await hashFile(new URL('../../src/rust-core/' + name, import.meta.url)) })));
  const largest = scales.find(scale => scale.models === 5_000)!;
  assert.ok(largest.fullRouterWarmCost);
  const report = { schemaVersion: 1, task: 'RUST-005', models: 5_000, binary, binarySha256: binary.sha256,
    workloads: largest.fullRouterWarmCost.workloads, refreshMs: largest.refreshMs, closeMs: largest.closeMs,
    tsIndexBuildMs: largest.pureTs.buildMs, tsPureWorkloads: largest.pureTs.workloads,
    sourceModules, nodeVersion: process.version, platform: process.platform,
    architecture: process.arch, data: 'synthetic-real-two-database-Node-owner-to-pinned-Rust-router', scales, baseline: baselineReport,
    counts: { rustChildren: processes.children.length, peakLiveRustChildren: processes.peak, naturalRustExits: processes.exits,
      borrowedOwnerPrepare: 0, borrowedOwnerBoot: 0, borrowedOwnerClose: 0 },
    costScope: 'Node计线程RPC与响应验证；完整Router计两次Node版本RPC、真实Rust往返及TS完整DTO核验；export、refresh、close单列；assert在计时外。',
    costLimitations: '六工作量各10次warm样本；旧004与本期005分阶段使用同一Owner/库但snapshotId不同，先旧后新；OS缓存、GC、调度未控制，不能代表冷盘、真实用户库、硬RSS上限或普遍性能结论。',
    productionDefault: 'Node', realServices: 'NOT_RUN' };
  const output = process.env.MUSIC_BRIDGE_RUST_INDEX_COST_REPORT;
  if (output) {
    assert.ok(path.isAbsolute(output));
    if (process.platform === 'darwin' && process.env.GITHUB_ACTIONS !== 'true') {
      assert.ok(isExternalEvidence(output));
      assert.ok(isExternalEvidence(await realpath(path.dirname(output))), '成本输出父目录不能经符号链接回落到本机目录。');
      try { assert.ok(isExternalEvidence(await realpath(output)), '成本输出不能经符号链接回落到本机文件。'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  }
  t.diagnostic(JSON.stringify({ task: report.task, binarySha256: report.binarySha256, reportPath: output ?? 'NOT_WRITTEN',
    scales: scales.map(scale => ({ models: scale.models, completePages: scale.completePages, differentialPages: scale.differentialPages,
      writeAndRefresh: scale.writeAndRefresh })), counts: report.counts,
    baseline: baseline ? 'RUN' : 'NOT_RUN', warmSamplesPerWorkload: 10, workloads: workloads.map(workload => workload.name) }));
});
