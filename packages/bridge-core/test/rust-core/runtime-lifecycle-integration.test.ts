import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MessageChannel, Worker } from 'node:worker_threads';
import { validateIpcResponseForCommand, type CollectionFilter, type CollectionModel, type IpcRequest, type IpcResponse, type Page } from '@music-bridge/contracts';
import type { DatasetOwnerIdentity } from '../../src/collection/dataset-owner-protocol.js';
import type { RustUtilityFixtureConfig, RustUtilityObservation } from '../helpers/rust-core-utility-fixture.js';

const binary = { path: process.env.MUSIC_BRIDGE_RUST_BINARY ?? '', sha256: process.env.MUSIC_BRIDGE_RUST_SHA256 ?? '' };
assert.ok(path.isAbsolute(binary.path) && /^[a-f0-9]{64}$/.test(binary.sha256), '实际 Core Gate 必须提供冻结二进制路径与摘要，不能条件跳过。');
assert.equal(createHash('sha256').update(readFileSync(binary.path)).digest('hex'), binary.sha256);
const reports: Record<string, unknown>[] = [];
function request(command: IpcRequest['command'], payload: unknown = {}, datasetId?: string): IpcRequest {
  return { version: 1, id: randomUUID(), command, payload, ...(datasetId ? { expectedDatasetId: datasetId } : {}) };
}
const list = (datasetId: string, filter: CollectionFilter = {}, page = { offset: 0, limit: 100 }) => request('collection.list', { filter, page }, datasetId);
async function until(check: () => boolean, description: string) {
  const deadline = performance.now() + 30_000;
  while (!check()) { if (performance.now() > deadline) throw new Error(`实际集成未到达观察点：${description}`); await new Promise<void>(resolve => setTimeout(resolve, 5)); }
}
async function fixture(t: test.TestContext, settings: Omit<RustUtilityFixtureConfig, 'directory' | 'binary'> & { pin?: string }) {
  const root = realpathSync(os.tmpdir()), external = '/Volumes/LifeWeave/Developer/CommandLine/tmp';
  const hosted = process.env.GITHUB_ACTIONS === 'true' && Boolean(process.env.RUNNER_TEMP);
  if (process.platform === 'darwin' && !hosted) {
    assert.ok(root === external || root.startsWith(external + path.sep), '本机实际 Core Gate 必须采用真实外置 TMPDIR。');
    assert.notEqual((await stat('/Volumes/LifeWeave')).dev, (await stat('/')).dev, '外置卷必须真实挂载。');
  }
  const directory = await mkdtemp(path.join(root, 'rust-runtime-'));
  const observations: RustUtilityObservation[] = [], responses: IpcResponse[] = [], messages: unknown[] = [];
  const ports = new MessageChannel(); let exitCode: number | undefined, installed = false, ready = false;
  const worker = new Worker(new URL('../helpers/rust-core-utility-fixture.ts', import.meta.url), {
    execArgv: ['--import', 'tsx'], workerData: { ...settings, directory, binary: { ...binary, sha256: settings.pin ?? binary.sha256 } },
  });
  let workerError: Error | undefined;
  worker.on('error', error => { workerError = error; });
  worker.on('message', value => {
    messages.push(value);
    if (value.type === 'fixture.installed') installed = true;
    if (value.type === 'observation') observations.push(value as RustUtilityObservation);
  });
  worker.once('exit', code => { exitCode = code; });
  ports.port1.on('message', value => { if (value.event === 'core.ready') ready = true; if (typeof value.id === 'string') responses.push(value as IpcResponse); });
  await until(() => installed || exitCode !== undefined, 'Core入口安装'); assert.equal(workerError, undefined); assert.equal(installed, true);
  worker.postMessage({ type: 'fixture.bind', port: ports.port2 }, [ports.port2]);
  const count = (event: string) => observations.filter(value => value.event === event).length;
  async function rpc(input: IpcRequest) {
    ports.port1.postMessage(input);
    await until(() => responses.some(value => value.id === input.id) || exitCode !== undefined, `公共${input.command}回执`);
    const response = responses.find(value => value.id === input.id); assert.ok(response, 'Core退出不能冒充公共成功回执。');
    assert.equal(validateIpcResponseForCommand(response, input.command).ok, true); return response;
  }
  async function oracle(input: IpcRequest) {
    const id = randomUUID(); worker.postMessage({ type: 'fixture.oracle', id, request: input });
    await until(() => messages.some(value => (value as { type?: string; id?: string }).type === 'oracle' && (value as { id?: string }).id === id), '真实SQLite oracle');
    const result = messages.find(value => (value as { id?: string }).id === id) as { result: unknown; failed?: boolean }; assert.equal(result.failed, undefined); return result.result;
  }
  async function close() {
    const response = await rpc(request('core.shutdown')); assert.equal(response.ok, true);
    await until(() => exitCode !== undefined, 'Core正常退出'); assert.equal(exitCode, 0); assert.equal(workerError, undefined);
  }
  t.after(async () => {
    if (exitCode === undefined) { try { await close(); } catch { await worker.terminate(); } }
    ports.port1.close();
  });
  t.diagnostic(`真实Core/Node/Rust合成证据目录：${directory}`);
  return { directory, worker, observations, responses, count, rpc, oracle, close,
    get ready() { return ready; }, get exitCode() { return exitCode; },
    get identity() { return observations.find(value => value.event === 'node.prepared')!.identity as DatasetOwnerIdentity; },
    async waitReady() { await until(() => ready || exitCode !== undefined, 'Core ready'); assert.equal(ready, true); },
    async waitExit() { await until(() => exitCode !== undefined, 'Core失败退出'); assert.equal(workerError, undefined); return exitCode; },
  };
}
function naturalResources(f: Awaited<ReturnType<typeof fixture>>, children: number) {
  assert.equal(f.count('node.prepare'), 1); assert.equal(f.count('node.boot'), 1); assert.equal(f.count('node.close'), 1); assert.equal(f.count('node.closed'), 1);
  assert.deepEqual(f.observations.filter(value => value.event === 'node.exit').map(value => value.code), [0]);
  assert.equal(f.count('rust.spawn'), children);
  assert.equal(f.count('rust.exit'), children);
  assert.ok(f.observations.filter(value => value.event === 'rust.spawn').every(value => value.liveChildren === 1));
  assert.ok(f.observations.filter(value => value.event === 'rust.exit').every(value => value.code === 0 && value.signal === null));
}

test('真实Core默认Node路径零导出/零Rust子进程，公共控制请求不进入领域Owner', { timeout: 60_000 }, async t => {
  const f = await fixture(t, { rust: false, models: 100 }); await f.waitReady();
  const input = list(f.identity.datasetId), response = await f.rpc(input); assert.equal(response.ok, true);
  if (response.ok) assert.deepEqual(response.result, await f.oracle(input));
  const before = f.count('node.dispatch');
  for (const command of ['core.ping', 'core.getHealth', 'core.getState', 'core.getDiagnostics'] as const) assert.equal((await f.rpc(request(command))).ok, true);
  assert.equal(f.count('node.dispatch'), before); assert.equal(f.count('node.version'), 0);
  assert.equal(f.count('node.export') + f.count('node.exportLarge') + f.count('node.exportPlain'), 0);
  await f.close(); naturalResources(f, 0);
  reports.push({ scenario: 'legacy-node', models: 100, directory: f.directory, coreExit: f.exitCode, observations: f.observations });
});

for (const models of [0, 100, 2_000, 5_000]) {
  test(`真实Core显式Rust ${models}型号在完整ACK后ready，公共筛选分页等同SQLite且写后不自动重建`, { timeout: 120_000 }, async t => {
    const f = await fixture(t, { rust: true, models, large: models === 5_000, holdBoot: true });
    await until(() => f.count('node.bootSeeded') > 0, 'Node实际boot完成后受控暂挂');
    assert.equal(f.ready, false); assert.equal(f.count('rust.spawn'), 0);
    const early = await f.rpc(list(f.identity.datasetId)); assert.equal(early.ok, false);
    if (!early.ok) assert.equal(early.error.code, 'INTERNAL_ERROR', '组合内部NOT_READY沿用现有公开安全映射，不扩展错误合同。');
    assert.equal(f.count('node.dispatch'), 0, 'ready前领域请求不得绕过组合boot准入。');
    const earlyControl = await f.rpc(request('core.ping')); assert.equal(earlyControl.ok, true);
    f.worker.postMessage({ type: 'fixture.releaseBoot' }); await f.waitReady();
    const readySequence = f.observations.find(value => value.event === 'core.ready')!.sequence;
    const bootAck = f.observations.find(value => value.event === 'rust.frame' && value.operation === 'commitBoot' && value.ok === true);
    assert.ok(bootAck && bootAck.sequence < readySequence); assert.equal(f.count('node.boot'), 1);
    const uploadAcks = f.observations.filter(value => value.event === 'rust.frame' && value.operation === 'appendSnapshot');
    assert.equal(uploadAcks.length, models === 5_000 ? 40 : 0);
    assert.ok(uploadAcks.every(value => value.ok === true && value.sequence < bootAck.sequence));
    assert.equal(f.count('node.export') + f.count('node.exportLarge'), 1);
    assert.equal(f.observations.find(value => value.event === 'node.exportComplete')!.models, models);
    assert.ok((await stat(path.join(f.directory, 'backup-maintenance.v1.sqlite'))).isFile());
    const filters: CollectionFilter[] = [{}, { query: '　ＳＡ　９０％　' }, { query: 'A_B%' }, { query: '中文品牌🎵' },
      { brand: '　ＴＤＫ　' }, { decade: 'unknown' }, { stockState: 'recorded' }, { brand: 'TDK', decade: 1990, stockState: 'blank' }];
    const pages = [{ offset: 0, limit: 100 }, { offset: 99, limit: 3 }, { offset: Math.max(0, models - 1), limit: 100 }, { offset: models, limit: 1 }];
    let differentialPages = 0; const queryRoundtripMs: number[] = [], versions = f.count('node.version');
    for (const filter of filters) for (const page of pages) {
      const input = list(f.identity.datasetId, filter, page), expected = await f.oracle(input), tick = performance.now(), response = await f.rpc(input);
      queryRoundtripMs.push(performance.now() - tick); assert.equal(response.ok, true);
      if (response.ok) assert.deepEqual(response.result, expected, JSON.stringify({ filter, page })); differentialPages++;
    }
    assert.equal(differentialPages, 32); assert.equal(f.count('node.dispatch'), 0); assert.equal(f.count('node.version') - versions, differentialPages * 2);
    assert.equal(f.observations.filter(value => value.event === 'rust.frame' && value.operation === 'dispatch').length, differentialPages);
    const beforeControl = f.observations.length;
    for (const command of ['core.ping', 'core.getHealth', 'core.getState', 'core.getDiagnostics'] as const) assert.equal((await f.rpc(request(command))).ok, true);
    assert.equal(f.observations.slice(beforeControl).filter(value => value.event.startsWith('node.') || value.event === 'rust.frame').length, 0);
    {
      const writing = request('collection.receive', { commandId: randomUUID(),
        model: { brand: '合成库存', name: 'Core单次入库', edition: '测试', year: 1990, format: 'cassette', tapeType: 'II', identification: 'verified' },
        lengthMinutes: 60, quantities: { openedBlank: 1, sealedBlank: 0, legacyUsed: 0, unclassified: 0 } }, f.identity.datasetId);
      assert.equal((await f.rpc(writing)).ok, true);
      const input = list(f.identity.datasetId), expected = await f.oracle(input), updated = await f.rpc(input); assert.equal(updated.ok, true);
      if (updated.ok) assert.deepEqual(updated.result, expected);
      assert.equal((expected as Page<CollectionModel>).total, models + 1, '真实入库增加一个型号，旧Rust快照不可再次交付。');
      assert.equal(f.count('node.dispatch'), 2); assert.equal(f.observations.filter(value => value.event === 'node.dispatch' && value.requestId === writing.id).length, 1);
      assert.equal(f.count('node.export') + f.count('node.exportLarge'), 1); assert.equal(f.count('rust.spawn'), 1);
      assert.equal(f.observations.filter(value => value.event === 'rust.frame' && value.operation === 'dispatch').length, differentialPages);
    }
    await f.close(); naturalResources(f, 1);
    reports.push({ scenario: 'explicit-rust', models, differentialPages, directory: f.directory, coreExit: f.exitCode,
      queryRoundtripMs, observations: f.observations });
  });
}

test('真实Core在ready前收到shutdown封闭启动，自然exit0且不导出或启动Rust', { timeout: 60_000 }, async t => {
  const f = await fixture(t, { rust: true, models: 100, holdBoot: true });
  await until(() => f.count('node.bootSeeded') > 0, 'Node实际boot完成但原bootPromise尚未释放');
  assert.equal(f.count('node.bootComplete'), 0); assert.equal(f.ready, false);
  // 不发送fixture.releaseBoot；关闭的seal消费原在途Promise，不能另造成功boot。
  await f.close(); naturalResources(f, 0);
  assert.equal(f.ready, false); assert.equal(f.count('core.ready'), 0); assert.equal(f.count('node.bootComplete'), 0);
  assert.equal(f.count('node.version'), 0); assert.equal(f.count('node.dispatch'), 0);
  assert.equal(f.count('node.export') + f.count('node.exportLarge') + f.count('node.exportPlain'), 0);
  reports.push({ scenario: 'early-shutdown-before-ready', models: 100, directory: f.directory,
    coreExit: f.exitCode, observations: f.observations });
});

for (const scenario of ['bad-pin', 'missing-capabilities', 'capacity'] as const) {
  test(`真实Core显式启动${scenario}失败不ready并自然关闭已创建Node资源`, { timeout: 60_000 }, async t => {
    const f = await fixture(t, { rust: true, models: scenario === 'capacity' ? 2_001 : 100,
      ...(scenario === 'bad-pin' ? { pin: '0'.repeat(64) } : {}), missingCapabilities: scenario === 'missing-capabilities' });
    assert.equal(await f.waitExit(), 1); assert.equal(f.ready, false); assert.equal(f.count('rust.spawn'), 0);
    assert.equal(f.count('node.close'), 1); assert.equal(f.count('node.closed'), 1);
    assert.deepEqual(f.observations.filter(value => value.event === 'node.exit').map(value => value.code), [0]);
    assert.equal(f.count('node.boot'), scenario === 'missing-capabilities' ? 0 : 1);
    reports.push({ scenario, directory: f.directory, coreExit: f.exitCode, observations: f.observations });
  });
}

test('真实Core候选SIGKILL后关闭回执失败，退出不能冒称自然关闭成功', { timeout: 60_000 }, async t => {
  const f = await fixture(t, { rust: true, models: 100 }); await f.waitReady();
  const pid = f.observations.find(value => value.event === 'rust.spawn')!.pid; assert.ok(Number.isSafeInteger(pid));
  f.worker.postMessage({ type: 'fixture.killRust', pid }); await until(() => f.count('rust.exit') > 0, 'Rust实际SIGKILL退出');
  const response = await f.rpc(request('core.shutdown')); assert.equal(response.ok, false);
  assert.equal(f.exitCode, undefined); assert.equal(f.count('node.close'), 1); assert.equal(f.count('node.closed'), 1);
  assert.deepEqual(f.observations.filter(value => value.event === 'rust.exit').map(value => [value.code, value.signal]), [[null, 'SIGKILL']]);
  // 产品拒绝退出；仅测试收尾终止失去正常退出能力的 Core，证据明确记为受控终止。
  const terminated = await f.worker.terminate(); await f.waitExit();
  reports.push({ scenario: 'real-rust-sigkill-close-failure', directory: f.directory, coreExit: terminated,
    forcedTestCleanup: true, observations: f.observations });
});

test('保存真实Core生命周期的安全合成报告', async () => {
  assert.equal(reports.length, 10, '报告必须含所有真实生命周期场景。');
  const output = process.env.MUSIC_BRIDGE_RUST_RUNTIME_REPORT;
  if (output) {
    assert.ok(path.isAbsolute(output));
    if (process.platform === 'darwin' && process.env.GITHUB_ACTIONS !== 'true') assert.ok(realpathSync(path.dirname(output)).startsWith('/Volumes/LifeWeave/Developer/CommandLine/'));
    await writeFile(output, JSON.stringify({ schemaVersion: 1, task: 'RUST-006', binarySha256: binary.sha256,
      nodeVersion: process.version, data: 'synthetic-real-Core-worker-Node-two-database-owner-pinned-Rust', scenarios: reports,
      scope: '实际Node worker与子进程、真实公共IPC和合成SQLite差分；控制面采用createTestBridgeRuntime。',
      costLimitations: '公共读取计时包含IPC、前后Node版本RPC、Rust往返与TS验证；固定合成工作量，OS缓存未控制，不能推导真实媒体库性能。',
      electron: 'NOT_RUN', realServices: 'NOT_RUN', productionDefault: 'Node' }, null, 2) + '\n');
  }
});
