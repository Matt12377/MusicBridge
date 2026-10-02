import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MessageChannel, Worker } from 'node:worker_threads';
import { validateIpcResponseForCommand, type CatalogHistory, type CatalogRevisionDetail, type CollectionDetail,
  type CollectionFilter, type CollectionModel, type IpcRequest, type IpcResponse, type Page, type ReferenceSourcePage } from '@music-bridge/contracts';
import type { DatasetOwnerIdentity } from '../../src/collection/dataset-owner-protocol.js';
import type { RustReadonlyCoreDatasetOwnerStatus } from '../../src/rust-core/core-dataset-owner.js';
import type { RustUtilityFixtureConfig, RustUtilityObservation } from '../helpers/rust-core-utility-fixture.js';

const binary = { path: process.env.MUSIC_BRIDGE_RUST_BINARY ?? '', sha256: process.env.MUSIC_BRIDGE_RUST_SHA256 ?? '' };
assert.ok(path.isAbsolute(binary.path) && /^[a-f0-9]{64}$/.test(binary.sha256), '实际主机 Gate 必须提供冻结二进制，不能条件跳过。');
assert.equal(createHash('sha256').update(readFileSync(binary.path)).digest('hex'), binary.sha256);
const reports: Record<string, unknown>[] = [];
const request = (command: IpcRequest['command'], payload: unknown = {}, datasetId?: string): IpcRequest =>
  ({ version: 1, id: randomUUID(), command, payload, ...(datasetId ? { expectedDatasetId: datasetId } : {}) });
const list = (datasetId: string, filter: CollectionFilter = {}, page = { offset: 0, limit: 100 }) => request('collection.list', { filter, page }, datasetId);
async function until(check: () => boolean, description: string) {
  const deadline = performance.now() + 30_000;
  while (!check()) { if (performance.now() > deadline) throw new Error(`实际主机集成未到达：${description}`); await new Promise<void>(resolve => setTimeout(resolve, 5)); }
}
interface HostReply { type: 'hostControl'; id: string; ok: boolean; status?: RustReadonlyCoreDatasetOwnerStatus; code?: string }
interface OracleReply { type: 'oracle'; id: string; result?: unknown; failed?: boolean; failure?: { ok: false; error: unknown } }
async function fixture(t: test.TestContext, settings: Omit<RustUtilityFixtureConfig, 'directory' | 'binary'>) {
  const root = realpathSync(os.tmpdir()), external = '/Volumes/LifeWeave/Developer/CommandLine/tmp';
  if (process.platform === 'darwin' && process.env.GITHUB_ACTIONS !== 'true') {
    assert.ok(root === external || root.startsWith(external + path.sep), '本机 Gate 必须使用外置 TMPDIR。');
    assert.notEqual((await stat('/Volumes/LifeWeave')).dev, (await stat('/')).dev, '外置卷必须真实挂载。');
  }
  const directory = await mkdtemp(path.join(root, 'rust-host-007-'));
  const observations: RustUtilityObservation[] = [], responses: IpcResponse[] = [], messages: Record<string, unknown>[] = [];
  const ports = new MessageChannel(); let installed = false, ready = false, exitCode: number | undefined, workerError: Error | undefined;
  let forcedTestCleanup = false;
  const worker = new Worker(new URL('../helpers/rust-core-utility-fixture.ts', import.meta.url), {
    execArgv: ['--import', 'tsx'], workerData: { ...settings, directory, binary },
  });
  worker.on('error', error => { workerError = error; });
  worker.on('message', value => {
    messages.push(value);
    if (value.type === 'fixture.installed') installed = true;
    if (value.type === 'observation') observations.push(value);
  });
  worker.once('exit', code => { exitCode = code; });
  ports.port1.on('message', value => { if (value.event === 'core.ready') ready = true; if (typeof value.id === 'string') responses.push(value); });
  await until(() => installed || exitCode !== undefined, '入口安装'); assert.equal(workerError, undefined); assert.equal(installed, true);
  worker.postMessage({ type: 'fixture.bind', port: ports.port2 }, [ports.port2]);
  const count = (event: string) => observations.filter(value => value.event === event).length;
  async function rpc(input: IpcRequest) {
    ports.port1.postMessage(input);
    await until(() => responses.some(value => value.id === input.id) || exitCode !== undefined, `公共 ${input.command} 回执`);
    const response = responses.find(value => value.id === input.id); assert.ok(response, '退出不能替代公共回执。');
    assert.equal(validateIpcResponseForCommand(response, input.command).ok, true); return response;
  }
  async function oracle(input: IpcRequest) {
    const id = randomUUID(); worker.postMessage({ type: 'fixture.oracle', id, request: input });
    await until(() => messages.some(value => value.type === 'oracle' && value.id === id), '真实 SQLite 参照');
    return messages.find(value => value.type === 'oracle' && value.id === id) as unknown as OracleReply;
  }
  async function host(operation: 'status' | 'refresh' | 'invalidate', extra: Record<string, unknown> = {}) {
    const id = randomUUID(); worker.postMessage({ type: 'fixture.hostControl', id, operation, ...extra });
    await until(() => messages.some(value => value.type === 'hostControl' && value.id === id) || exitCode !== undefined, `私有主机 ${operation} 回执`);
    const result = messages.find(value => value.type === 'hostControl' && value.id === id) as unknown as HostReply;
    assert.ok(result, '主机调用必须有明确结果。'); return result;
  }
  async function status() { const result = await host('status'); assert.equal(result.ok, true); assert.ok(result.status); return result.status; }
  async function close() {
    assert.equal((await rpc(request('core.shutdown'))).ok, true);
    await until(() => exitCode !== undefined, 'Core 自然退出'); assert.equal(exitCode, 0); assert.equal(workerError, undefined);
  }
  t.after(async () => {
    if (exitCode === undefined) { try { await close(); } catch { forcedTestCleanup = true; await worker.terminate(); } }
    ports.port1.close();
    assert.equal(forcedTestCleanup, false, '本 Gate 不允许强制清理冒充自然退出。');
  });
  t.diagnostic(`真实主机合成证据目录：${directory}`);
  return { directory, worker, observations, responses, count, rpc, oracle, host, status, close,
    get ready() { return ready; }, get exitCode() { return exitCode; },
    get identity() { return observations.find(value => value.event === 'node.prepared')!.identity as DatasetOwnerIdentity; },
    async waitReady() { await until(() => ready || exitCode !== undefined, 'Core ready'); assert.equal(ready, true); },
    async waitExit() { await until(() => exitCode !== undefined, 'Core 失败自然退出'); assert.equal(workerError, undefined); return exitCode; },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function natural(f: Fixture, children: number, prepared = true, largeModels?: number) {
  assert.equal(f.count('node.prepare'), prepared ? 1 : 0); assert.equal(f.count('node.boot'), prepared ? 1 : 0);
  assert.equal(f.count('node.close'), 1); assert.equal(f.count('node.closed'), 1);
  assert.deepEqual(f.observations.filter(value => value.event === 'node.exit').map(value => value.code), [0]);
  assert.equal(f.count('rust.spawn'), children); assert.equal(f.count('rust.exit'), children);
  assert.ok(f.observations.filter(value => value.event === 'rust.spawn').every(value => value.liveChildren === 1));
  assert.ok(f.observations.filter(value => value.event === 'rust.exit').every(value => value.code === 0 && value.signal === null && value.liveChildren === 0));
  assert.equal(f.observations.filter(value => value.event === 'rust.frame' && value.operation === 'close' && value.ok).length, children);
  const childResources = f.observations.filter(value => value.event === 'rust.spawn').map(spawn => {
    const frames = f.observations.filter(value => value.event === 'rust.frame' && value.pid === spawn.pid);
    const acks = (operation: string) => frames.filter(value => value.operation === operation && value.ok);
    assert.equal(acks('prepare').length, 1); assert.equal(acks('commitBoot').length, 1); assert.equal(acks('close').length, 1);
    assert.equal(acks('appendSnapshot').length, largeModels === undefined ? 0 : Math.ceil(largeModels / 128));
    const boot = acks('commitBoot')[0]!, close = acks('close')[0]!;
    assert.ok(acks('prepare')[0]!.sequence < boot.sequence);
    assert.ok(acks('appendSnapshot').every(value => value.sequence < boot.sequence));
    const exit = f.observations.find(value => value.event === 'rust.exit' && value.pid === spawn.pid)!;
    assert.ok(boot.sequence < close.sequence && close.sequence < exit.sequence);
    return { pid: spawn.pid, prepareAcks: 1, appendAcks: acks('appendSnapshot').length, bootAcks: 1,
      closeAcks: 1, exitCode: exit.code, signal: exit.signal, spawnSequence: spawn.sequence, bootSequence: boot.sequence,
      closeSequence: close.sequence, exitSequence: exit.sequence };
  });
  return { nodePrepare: f.count('node.prepare'), nodeBoot: f.count('node.boot'), nodeClose: f.count('node.close'), nodeExit0: 1,
    rustSpawn: children, rustCloseAck: children, rustExit0: children, coreExit: f.exitCode, forcedTestCleanup: false, childResources };
}
async function differential(f: Fixture, input: IpcRequest) {
  const expected = await f.oracle(input), response = await f.rpc(input);
  if (expected.failed) { assert.equal(response.ok, false); assert.ok(expected.failure); if (!response.ok) assert.deepEqual(response.error, expected.failure.error); }
  else { assert.equal(response.ok, true); if (response.ok) assert.deepEqual(response.result, expected.result); }
  return response;
}
function result<T>(response: IpcResponse): T { assert.equal(response.ok, true); assert.ok(response.ok); return response.result as T; }
function assertClosedCapability(f: Fixture) {
  assert.equal(f.count('host.closedStatus'), 1);
  assert.equal((f.observations.find(value => value.event === 'host.closedStatus')!.status as RustReadonlyCoreDatasetOwnerStatus).phase, 'closed');
  assert.equal(f.count('host.refreshAfterCloseAccepted'), 0);
  assert.equal(f.observations.find(value => value.event === 'host.refreshAfterCloseRejected')?.code, 'CLOSING');
}

test('实际主机默认 Node 与伪造环境变量均零 child/零导出，公共 IPC 无刷新能力', { timeout: 60_000 }, async t => {
  const f = await fixture(t, { rust: false, models: 100, spoofEnv: true }); await f.waitReady();
  await differential(f, list(f.identity.datasetId));
  assert.equal((await f.host('refresh')).code, 'NOT_READY'); assert.equal(f.count('host.delivered'), 0);
  for (const command of ['rust.refresh', 'rust.invalidate', 'rust.getStatus']) {
    const response = await f.rpc({ version: 1, id: randomUUID(), command, payload: {} } as unknown as IpcRequest);
    assert.equal(response.ok, false);
  }
  assert.equal(f.count('node.export') + f.count('node.exportLarge') + f.count('node.exportPlain'), 0);
  await f.close();
  reports.push({ scenario: 'legacy-node-env-public-non-admission', models: 100, directory: f.directory, resources: natural(f, 0), observations: f.observations });
});

for (const models of [100, 2_000, 5_000]) {
  test(`实际主机 ${models} 型号混合初始化保留 Rust，单次 Node 写入后仅可信刷新恢复`, { timeout: 120_000 }, async t => {
    const f = await fixture(t, { rust: true, hostControl: true, seedReference: true, holdBoot: true, models, large: models === 5_000 });
    await until(() => f.count('node.bootSeeded') === 1, 'Node boot 合成库存和参考目录已准备');
    const delivered = f.observations.find(value => value.event === 'host.delivered')!;
    assert.equal(f.count('host.delivered'), 1); assert.equal(delivered.frozen, true);
    assert.deepEqual(delivered.keys, ['refresh', 'invalidate', 'getStatus']);
    assert.equal((delivered.status as RustReadonlyCoreDatasetOwnerStatus).phase, 'new');
    assert.ok(delivered.sequence < f.observations.find(value => value.event === 'node.prepare')!.sequence);
    assert.equal((await f.host('refresh')).code, 'NOT_READY'); assert.equal(f.count('rust.spawn'), 0); assert.equal(f.ready, false);
    f.worker.postMessage({ type: 'fixture.releaseBoot' }); await f.waitReady();
    const initial = await f.status(); assert.equal(initial.phase, 'ready'); assert.equal(initial.router?.phase, 'rust');
    const readySequence = f.observations.find(value => value.event === 'core.ready')!.sequence;
    assert.ok(f.observations.find(value => value.event === 'rust.frame' && value.operation === 'commitBoot')!.sequence < readySequence);
    const pureNodeReadCounts: Record<string, number> = {};
    const pureRead = async (input: IpcRequest) => {
      const before = f.count('node.dispatch'), frames = f.observations.filter(value => value.event === 'rust.frame' && value.operation === 'dispatch').length;
      const response = await differential(f, input);
      assert.equal(f.count('node.dispatch') - before, 1); pureNodeReadCounts[input.command] = (pureNodeReadCounts[input.command] ?? 0) + 1;
      assert.equal(f.observations.filter(value => value.event === 'rust.frame' && value.operation === 'dispatch').length, frames);
      const current = await f.status(); assert.deepEqual(current, initial, '审定纯 Node 读取不应撤销快照或改变 generation。');
      assert.equal(f.count('rust.spawn'), 1); assert.equal(f.count('rust.exit'), 0); return response;
    };
    // 正式页面初始化顺序：sources → history → revision → 列表/待复核 → 详情。
    const sources = result<ReferenceSourcePage>(await pureRead(request('referenceCatalog.sources', { offset: 0, limit: 25 }, f.identity.datasetId)));
    assert.equal(sources.total, 1); assert.equal(sources.items[0]!.bookId, 'rust007-reference');
    const history = result<CatalogHistory>(await pureRead(request('referenceCatalog.history', { bookId: sources.items[0]!.bookId, offset: 0, limit: 1 }, f.identity.datasetId)));
    assert.equal(history.total, 1); assert.ok(history.currentRevisionId);
    const revision = result<CatalogRevisionDetail>(await pureRead(request('referenceCatalog.revision', { id: history.currentRevisionId }, f.identity.datasetId)));
    assert.equal(revision.revision.items.length, 1); assert.equal(revision.revision.sourceId, sources.items[0]!.id);
    const first = result<Page<CollectionModel>>(await differential(f, list(f.identity.datasetId))); assert.equal(first.total, models);
    await differential(f, list(f.identity.datasetId, { stockState: 'needs-review' }));
    const detail = result<CollectionDetail>(await pureRead(request('collection.detail', { modelId: first.items[0]!.id, page: { offset: 0, limit: 100 } }, f.identity.datasetId)));
    assert.ok(detail.copies.items[0]);
    await pureRead(request('collection.copy', { physicalId: detail.copies.items[0]!.physicalId }, f.identity.datasetId));
    // 合法格式的不存在照片，公开领域失败仍与原 Node 回执一致且不得失效。
    const missingPhoto = await pureRead(request('collection.photo', { photoId: randomUUID() }, f.identity.datasetId)); assert.equal(missingPhoto.ok, false);
    const filters: CollectionFilter[] = [{}, { query: '　ＳＡ　９０％　' }, { query: 'A_B%' }, { query: '中文品牌🎵' },
      { brand: '　ＴＤＫ　' }, { decade: 'unknown' }, { stockState: 'recorded' }, { stockState: 'needs-review' }, { brand: 'TDK', decade: 1990, stockState: 'blank' }];
    const pages = [{ offset: 0, limit: 100 }, { offset: 99, limit: 3 }, { offset: models - 1, limit: 100 }, { offset: models, limit: 1 }];
    const queryRoundtripMs: number[] = []; let differentialPages = 2;
    const dispatchBefore = f.count('node.dispatch');
    for (const filter of filters) for (const page of pages) {
      const tick = performance.now(); await differential(f, list(f.identity.datasetId, filter, page)); queryRoundtripMs.push(performance.now() - tick); differentialPages++;
    }
    assert.equal(differentialPages, 38); assert.equal(f.count('node.dispatch'), dispatchBefore);
    assert.equal(f.observations.filter(value => value.event === 'rust.frame' && value.operation === 'dispatch').length, differentialPages);
    assert.deepEqual(await f.status(), initial);
    const write = request('collection.setPolicy', { commandId: randomUUID(), modelId: detail.model.id, expectedRevision: detail.model.revision,
      collectorPolicy: 'collector', minimumSealedReserve: 1 }, f.identity.datasetId);
    assert.equal((await f.rpc(write)).ok, true);
    const stale = await f.status(); assert.equal(stale.router?.phase, 'stale'); assert.ok(stale.router!.generation > initial.router!.generation);
    const freshNode = result<Page<CollectionModel>>(await differential(f, list(f.identity.datasetId))); assert.equal(freshNode.total, models);
    assert.equal(f.observations.filter(value => value.event === 'node.dispatch' && value.requestId === write.id).length, 1);
    assert.equal(f.count('node.export') + f.count('node.exportLarge'), 1); assert.equal(f.count('rust.spawn'), 1, '写后不应自动导出、自动重建或重放写命令。');
    const refreshTick = performance.now(); const refreshed = await Promise.all([f.host('refresh'), f.host('refresh')]);
    assert.ok(refreshed.every(value => value.ok)); assert.deepEqual(refreshed[0]!.status, refreshed[1]!.status);
    assert.equal(refreshed[0]!.status!.router?.phase, 'rust'); assert.equal(f.count('rust.spawn'), 2);
    const spawns = f.observations.filter(value => value.event === 'rust.spawn'), exits = f.observations.filter(value => value.event === 'rust.exit');
    assert.ok(exits[0]!.sequence < spawns[1]!.sequence, '旧 Rust 自然退出必须先于新 child 创建。');
    const secondPid = spawns[1]!.pid, secondBoot = f.observations.find(value => value.event === 'rust.frame' && value.operation === 'commitBoot' && value.pid === secondPid)!;
    assert.ok(secondBoot.ok); assert.ok(secondBoot.sequence < f.observations.find(value => value.event === 'host.controlComplete' && value.operation === 'refresh')!.sequence);
    const refreshRoundtripMs = performance.now() - refreshTick;
    await differential(f, list(f.identity.datasetId));
    assert.equal(f.count('node.export') + f.count('node.exportLarge'), 2);
    assert.equal((await f.host('invalidate')).status?.router?.phase, 'stale');
    await differential(f, list(f.identity.datasetId));
    assert.equal((await f.host('refresh')).status?.router?.phase, 'rust'); assert.equal(f.count('rust.spawn'), 3);
    await differential(f, list(f.identity.datasetId));
    assert.equal(f.count('node.export') + f.count('node.exportLarge'), 3);
    assert.equal(f.observations.filter(value => value.event === 'node.dispatch' && value.requestId === write.id).length, 1);
    assert.equal((await f.host('refresh', { injected: true })).code, 'INVALID_REQUEST'); assert.equal(f.count('rust.spawn'), 3);
    await f.close(); assertClosedCapability(f);
    reports.push({ scenario: 'mixed-read-write-trusted-refresh', models, directory: f.directory, differentialPages, pureNodeReadCounts,
      referenceSourceCount: sources.total, referenceRevisionCount: history.total, missingPhoto: 'original-safe-Node-error',
      initialStatus: initial, staleStatus: stale, concurrentRefresh: refreshed.map(value => value.status), queryRoundtripMs, refreshRoundtripMs,
      resources: natural(f, 3, true, models === 5_000 ? models : undefined), observations: f.observations });
  });
}

test('实际大快照刷新在途关闭阻止迟到 boot 候选 ready，所有 child 与 Node 自然退出', { timeout: 120_000 }, async t => {
  const f = await fixture(t, { rust: true, hostControl: true, models: 100, large: true, holdRefreshBoot: true }); await f.waitReady();
  const initial = await f.status(), refresh = f.host('refresh');
  await until(() => f.count('rust.commitBootHeld') === 1, '第二个真实 child commitBoot 已在途暂挂');
  const inflight = await f.status(); assert.equal(inflight.router?.phase, 'refreshing'); assert.equal(f.count('rust.spawn'), 2);
  const shutdown = f.rpc(request('core.shutdown'));
  let closing: RustReadonlyCoreDatasetOwnerStatus;
  do { closing = await f.status(); } while (closing.phase !== 'closing');
  f.worker.postMessage({ type: 'fixture.releaseRefreshBoot' });
  const refreshReply = await refresh; assert.equal(refreshReply.ok, false); assert.ok(['CLOSING', 'STALE_SNAPSHOT'].includes(refreshReply.code!));
  assert.equal((await shutdown).ok, true); assert.equal(await f.waitExit(), 0);
  assertClosedCapability(f); assert.equal(f.count('core.ready'), 1);
  const secondPid = f.observations.filter(value => value.event === 'rust.spawn')[1]!.pid;
  const lateBoot = f.observations.find(value => value.event === 'rust.frame' && value.operation === 'commitBoot' && value.pid === secondPid)!;
  assert.equal(lateBoot.ok, true); assert.ok(lateBoot.sequence > f.observations.find(value => value.event === 'rust.releaseHeldBoot')!.sequence);
  assert.equal(f.observations.filter(value => value.event === 'host.controlComplete' && value.operation === 'refresh').length, 0);
  reports.push({ scenario: 'real-inflight-refresh-shutdown-late-boot', models: 100, directory: f.directory, initialStatus: initial,
    inflightStatus: inflight, closingStatus: closing, refreshRejectedCode: refreshReply.code, resources: natural(f, 2, true, 100), observations: f.observations });
});

test('实际可信主机回调抛错在 prepare 前失败并自然关闭 Node，不启动 Rust', { timeout: 60_000 }, async t => {
  const f = await fixture(t, { rust: true, hostControl: true, throwHostCallback: true, models: 100 });
  assert.equal(await f.waitExit(), 1); assert.equal(f.ready, false); assert.equal(f.count('host.delivered'), 1);
  reports.push({ scenario: 'host-callback-throw', directory: f.directory, resources: natural(f, 0, false), observations: f.observations });
});

test('实际父启动载荷不能取得或启用主机 capability', { timeout: 60_000 }, async t => {
  const f = await fixture(t, { rust: false, models: 100, startupData: { type: 'musicbridge.core.port', hostControl: true, rustReadonlyCollection: { enabled: true } } });
  assert.equal(await f.waitExit(), 1); assert.equal(f.ready, false); assert.equal(f.count('host.delivered'), 0);
  assert.equal(f.count('node.spawn'), 0); assert.equal(f.count('rust.spawn'), 0);
  reports.push({ scenario: 'parent-payload-non-admission', directory: f.directory, resources: { nodeSpawn: 0, rustSpawn: 0, coreExit: f.exitCode, forcedTestCleanup: false }, observations: f.observations });
});

test('保存实际主机刷新与混合读取的冻结合成报告', async () => {
  assert.equal(reports.length, 7, '报告必须包含每项实际主机场景。');
  const output = process.env.MUSIC_BRIDGE_RUST_HOST_REPORT;
  if (output) {
    assert.ok(path.isAbsolute(output));
    if (process.platform === 'darwin' && process.env.GITHUB_ACTIONS !== 'true') assert.ok(realpathSync(path.dirname(output)).startsWith('/Volumes/LifeWeave/Developer/CommandLine/'));
    await writeFile(output, JSON.stringify({ schemaVersion: 1, task: 'RUST-007', binaryPath: binary.path, binarySha256: binary.sha256,
      nodeVersion: process.version, data: 'synthetic-real-Core-Node-owner-pinned-Rust', scenarios: reports,
      scope: '真实 Core worker、Node SQLite sole writer、Rust 子进程、公共合成 IPC 和私有可信主机控制；无真实服务。',
      costLimitations: '5ms 观察轮询与合成 SQLite oracle 均计入成本，刷新含自然排空/导出/上传/校验；不是精确 Core 性能，也不推导真实媒体库性能。',
      electron: 'NOT_RUN', realServices: 'NOT_RUN', ownerAcceptance: 'NOT_RUN', productionDefault: 'Node' }, null, 2) + '\n');
  }
});
