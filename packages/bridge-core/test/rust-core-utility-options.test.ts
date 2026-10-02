import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess, { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough, Writable } from 'node:stream';
import type { IpcRequest, IpcResponse } from '@music-bridge/contracts';
import type { DatasetOwnerEndpoint, DatasetOwnerProjectionHandler, DatasetOwnerVersionedSnapshotEndpoint } from '../src/collection/dataset-owner-protocol.js';
import { runCoreUtilityProcess, type DatasetOwnerFactory, type UtilityPort } from '../src/utility-main.js';
import type { RustReadonlyCoreOptions } from '../src/rust-core/core-dataset-owner.js';
import { RustSidecarError } from '../src/rust-core/readonly-sidecar.js';
import { BridgeError } from '../src/shared/errors.js';

const binary = { path: process.execPath, sha256: createHash('sha256').update(readFileSync(process.execPath)).digest('hex') };
const page = { items: [], total: 0, offset: 0, limit: 25, hasMore: false };
const env = { NODE_ENV: 'test', MUSIC_BRIDGE_CORE_TEST_MODE: '1', MUSIC_BRIDGE_DATA_DIRECTORY: '/合成/Core数据目录' };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function until(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error('受控启动链未及时到达。');
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}
class Port implements UtilityPort {
  readonly messages: unknown[] = [];
  listener?: (event: { data: unknown }) => void;
  on(_event: 'message', listener: (event: { data: unknown }) => void) { this.listener = listener; }
  start() {}
  postMessage(message: unknown) { this.messages.push(message); }
  get ready() { return this.messages.some(message => (message as { event?: string }).event === 'core.ready'); }
  request(command: IpcRequest['command'], payload: unknown = {}) {
    const id = randomUUID();
    this.listener?.({ data: { version: 1, id, command, payload } });
    return id;
  }
  async response(id: string): Promise<IpcResponse> {
    await until(() => this.messages.some(message => (message as { id?: string }).id === id));
    return this.messages.find(message => (message as { id?: string }).id === id) as IpcResponse;
  }
}
function source(hooks: { prepare?: () => Promise<void>; boot?: () => Promise<void>; close?: () => Promise<void>; dispatch?: () => Promise<unknown>; export?: () => Promise<void> } = {}) {
  const identity = { epoch: randomUUID(), datasetId: randomUUID() }, revision = randomUUID();
  const requests: IpcRequest[] = [];
  const counts = { prepares: 0, boots: 0, closes: 0, probes: 0, exports: 0 };
  const owner: DatasetOwnerVersionedSnapshotEndpoint = {
    async prepare() { counts.prepares++; await hooks.prepare?.(); return identity; },
    async commitBoot() { counts.boots++; await hooks.boot?.(); },
    async close() { counts.closes++; await hooks.close?.(); },
    async dispatch(request) { requests.push(request); return hooks.dispatch ? hooks.dispatch() : page; },
    async getCollectionSnapshotVersion() { counts.probes++; return { ...identity, revision }; },
    async exportCollectionSnapshot() { throw new Error('不可绕过版本导出。'); },
    async exportVersionedCollectionSnapshot() {
      counts.exports++; await hooks.export?.();
      return { snapshot: { ...identity, snapshotId: randomUUID(), models: [] }, version: { ...identity, revision } };
    },
  };
  return { owner, identity, counts, requests };
}
function fakeRust(t: test.TestContext, hooks: { boot?: Promise<void>; badBoot?: boolean; badClose?: boolean } = {}) {
  const frames: Record<string, unknown>[] = [];
  let live = 0;
  const spawn = t.mock.method(childProcess, 'spawn', () => {
    const child = new EventEmitter(), stdout = new PassThrough(), stderr = new PassThrough();
    let buffered = '', closed = false;
    live++;
    child.on('close', () => { if (!closed) { closed = true; live--; } });
    const stdin = new Writable({ write(chunk: Buffer, _encoding, callback) {
      buffered += chunk.toString();
      while (buffered.includes('\n')) {
        const end = buffered.indexOf('\n'), frame = JSON.parse(buffered.slice(0, end)) as Record<string, unknown>;
        buffered = buffered.slice(end + 1); frames.push(frame);
        void (async () => {
          if (frame.operation === 'commitBoot') await hooks.boot;
          const { payload: _payload, ...identity } = frame;
          const result = frame.operation === 'prepare' ? { epoch: frame.epoch, datasetId: frame.datasetId, snapshotId: frame.snapshotId,
            readOnly: true, capabilities: ['collection.list'], modelCount: 0 } : frame.operation === 'dispatch' ? page : null;
          stdout.write(JSON.stringify({ ...identity, ok: true, result: frame.operation === 'commitBoot' && hooks.badBoot ? '错误回执' : result }) + '\n');
          if (frame.operation === 'close') setImmediate(() => child.emit('close', hooks.badClose ? 9 : 0, null));
        })();
      }
      callback();
    } });
    return Object.assign(child, { stdin, stdout, stderr, kill() { setImmediate(() => child.emit('close', null, 'SIGKILL')); return true; } }) as unknown as ChildProcessWithoutNullStreams;
  });
  return { frames, spawn, get live() { return live; } };
}
async function start(t: test.TestContext, factory?: DatasetOwnerFactory, options?: RustReadonlyCoreOptions, overrides: NodeJS.ProcessEnv = {}, message: unknown = { type: 'musicbridge.core.port' }) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'parentPort'), previousExitCode = process.exitCode;
  let listener!: (event: { data: unknown; ports: UtilityPort[] }) => void;
  const exits: (number | string | null | undefined)[] = [];
  t.mock.method(process, 'exit', ((code?: number | string | null) => { exits.push(code); }) as typeof process.exit);
  Object.defineProperty(process, 'parentPort', { configurable: true, value: { once(_event: string, callback: typeof listener) { listener = callback; } } });
  t.after(() => {
    if (descriptor) Object.defineProperty(process, 'parentPort', descriptor);
    else Reflect.deleteProperty(process, 'parentPort');
    process.exitCode = previousExitCode;
  });
  if (options === undefined) await runCoreUtilityProcess({ ...env, ...overrides }, undefined, undefined, undefined, undefined, factory);
  else await runCoreUtilityProcess({ ...env, ...overrides }, undefined, undefined, undefined, undefined, factory, options);
  const port = new Port();
  listener({ data: message, ports: [port] });
  return { port, exits };
}
async function shutdown(port: Port, exits: unknown[]) {
  const response = await port.response(port.request('core.shutdown'));
  assert.equal(response.ok, true);
  await until(() => exits.includes(0));
}

test('旧六参数默认链保留 legacy owner，无导出、探测与 Rust child', async t => {
  const s = source(), rust = fakeRust(t);
  const legacy: DatasetOwnerEndpoint = { prepare: s.owner.prepare, dispatch: s.owner.dispatch, commitBoot: s.owner.commitBoot, close: s.owner.close };
  const { port, exits } = await start(t, () => legacy);
  await until(() => port.ready);
  assert.equal((await port.response(port.request('collection.list', { page: { offset: 0, limit: 25 } }))).ok, true);
  await shutdown(port, exits);
  assert.deepEqual(s.counts, { prepares: 1, boots: 1, closes: 1, probes: 0, exports: 0 });
  assert.equal(s.requests.length, 1);
  assert.equal(rust.spawn.mock.callCount(), 0);
});

test('环境变量与 Renderer 请求不能启用 Rust，旧默认快照能力也不读取', async t => {
  const s = source(), rust = fakeRust(t);
  const { port, exits } = await start(t, () => s.owner, undefined, { MUSIC_BRIDGE_RUST_READONLY: '1', MUSIC_BRIDGE_RUST_BINARY: binary.path });
  await until(() => port.ready);
  const rejected = await port.response(port.request('core.ping', { rustReadonlyCollection: { binary } }));
  assert.equal(rejected.ok, false);
  await shutdown(port, exits);
  assert.equal(s.counts.probes, 0); assert.equal(s.counts.exports, 0); assert.equal(rust.spawn.mock.callCount(), 0);
});

test('父端口配置注入拒绝，不创建 Owner 或发送 ready', async t => {
  let factories = 0;
  const rust = fakeRust(t);
  const { port, exits } = await start(t, () => { factories++; return source().owner; }, undefined, {}, { type: 'musicbridge.core.port', rustReadonlyCollection: { binary } });
  await until(() => exits.includes(1));
  assert.equal(factories, 0); assert.equal(port.ready, false); assert.equal(rust.spawn.mock.callCount(), 0);
});

test('显式 Rust 必须有 DatasetOwnerFactory，不走旧本地库 fallback', async t => {
  const rust = fakeRust(t);
  const { port, exits } = await start(t, undefined, { binary });
  await until(() => exits.includes(1));
  assert.equal(port.ready, false); assert.equal(rust.spawn.mock.callCount(), 0);
});

for (const capability of ['exportCollectionSnapshot', 'getCollectionSnapshotVersion', 'exportVersionedCollectionSnapshot', 'exportLargeVersionedCollectionSnapshot'] as const) {
  test(`显式能力 ${capability} 缺失时清理已创建来源`, async t => {
    const s = source(), rust = fakeRust(t);
    const owner = { ...s.owner };
    Reflect.deleteProperty(owner, capability);
    const { port, exits } = await start(t, () => owner, { binary, ...(capability === 'exportLargeVersionedCollectionSnapshot' ? { snapshotProfile: 'v3-5000' as const } : {}) });
    await until(() => exits.includes(1));
    assert.equal(s.counts.closes, 1); assert.equal(port.ready, false); assert.equal(s.counts.exports, 0); assert.equal(rust.spawn.mock.callCount(), 0);
  });
}

test('显式完整启动链等待 Node boot 与 Rust ACK，早期领域请求封闭，控制面继续 Node', async t => {
  const nodeBoot = deferred(), rustBoot = deferred(), s = source({ boot: () => nodeBoot.promise }), rust = fakeRust(t, { boot: rustBoot.promise });
  const { port, exits } = await start(t, () => s.owner, { binary });
  await until(() => s.counts.boots === 1);
  assert.equal(port.ready, false);
  const early = await port.response(port.request('collection.list', { page: { offset: 0, limit: 25 } }));
  assert.deepEqual(early, { version: 1, id: early.id, ok: false, error: { code: 'INTERNAL_ERROR', message: 'Core request failed' } });
  assert.equal(s.requests.length, 0);
  const ping = await port.response(port.request('core.ping'));
  assert.deepEqual(ping, { version: 1, id: ping.id, ok: true, result: { pong: true } });
  nodeBoot.resolve();
  await until(() => rust.frames.some(frame => frame.operation === 'commitBoot'));
  assert.equal(port.ready, false);
  assert.equal((await port.response(port.request('collection.list', { page: { offset: 0, limit: 25 } }))).ok, false);
  assert.equal(s.requests.length, 0);
  rustBoot.resolve(); await until(() => port.ready);
  const listed = await port.response(port.request('collection.list', { page: { offset: 0, limit: 25 } }));
  assert.deepEqual(listed, { version: 1, id: listed.id, ok: true, result: page });
  assert.equal(s.requests.length, 0); assert.equal(s.counts.boots, 1); assert.equal(s.counts.exports, 1);
  assert.equal((await port.response(port.request('collection.detail', { id: randomUUID() }))).ok, true);
  assert.equal(s.requests.length, 1);
  await shutdown(port, exits);
  assert.equal(s.counts.closes, 1); assert.equal(rust.live, 0);
  assert.equal(rust.frames.filter(frame => frame.operation === 'close').length, 1);
  assert.equal(JSON.stringify(port.messages).includes(binary.path), false);
});

for (const stage of ['prepare', 'nodeBoot', 'export', 'pin', 'rustBoot'] as const) {
  test(`显式 ${stage} 启动失败不发送 ready，来源及候选清理`, async t => {
    const fail = async () => { throw new Error('私有路径 /合成/秘密，禁止发送到IPC'); };
    const s = source({ ...(stage === 'prepare' ? { prepare: fail } : {}), ...(stage === 'nodeBoot' ? { boot: fail } : {}), ...(stage === 'export' ? { export: fail } : {}) });
    const rust = fakeRust(t, { badBoot: stage === 'rustBoot' });
    const { port, exits } = await start(t, () => s.owner, { binary: stage === 'pin' ? { ...binary, sha256: '0'.repeat(64) } : binary });
    await until(() => exits.includes(1));
    // 失败端点已安排强制收口；退出码不冒充 child 的实际退出事件。
    await until(() => rust.live === 0);
    assert.equal(port.ready, false); assert.equal(s.counts.closes, 1); assert.equal(rust.live, 0);
    assert.equal(JSON.stringify(port.messages).includes('/合成/秘密'), false);
    assert.equal(rust.spawn.mock.callCount(), stage === 'rustBoot' ? 1 : 0);
  });
}

test('早期 shutdown 消费迟到 boot，不随后发布 ready 或建立 Rust child', async t => {
  const boot = deferred(), s = source({ boot: () => boot.promise }), rust = fakeRust(t);
  const { port, exits } = await start(t, () => s.owner, { binary });
  await until(() => s.counts.boots === 1);
  const request = port.request('core.shutdown');
  await until(() => s.counts.closes === 1);
  boot.resolve();
  assert.equal((await port.response(request)).ok, true);
  await until(() => exits.includes(0));
  assert.deepEqual(exits, [0], '已确认 stopped 的显式关闭不能再被启动 catch 改成失败退出。');
  assert.equal(port.ready, false); assert.equal(s.counts.closes, 1); assert.equal(rust.spawn.mock.callCount(), 0);
});

test('shutdown 关闭失败使用原安全 IPC failure，不伪称退出成功', async t => {
  const s = source({ close: async () => { throw new RustSidecarError('PROCESS_EXIT'); } }), rust = fakeRust(t);
  let projection!: DatasetOwnerProjectionHandler;
  const { port, exits } = await start(t, options => { projection = options.projection; return s.owner; }, { binary });
  await until(() => port.ready);
  const invalidProjection = () => projection('browseAlbumCandidates', { query: '', page: { offset: 0, limit: 0 } }, s.identity);
  await assert.rejects(invalidProjection(), error => error instanceof BridgeError && error.code === 'BAD_REQUEST');
  const response = await port.response(port.request('core.shutdown'));
  assert.deepEqual(response, { version: 1, id: response.id, ok: false, error: { code: 'INTERNAL_ERROR', message: 'Core request failed' } });
  assert.equal(exits.includes(0), false); assert.equal(s.counts.closes, 1); assert.equal(rust.live, 0);
  // 原包装 prepare 保留当前 owner 身份，close finally 即使失败也封闭投影网关。
  await assert.rejects(invalidProjection(), error => error instanceof BridgeError && error.code === 'ROON_LIBRARY_UNAVAILABLE');
});

test('早期 shutdown 清理失败仍作为启动失败退出，不冒称 stopped', async t => {
  const boot = deferred(), s = source({ boot: () => boot.promise, close: async () => { throw new RustSidecarError('PROCESS_EXIT'); } });
  const rust = fakeRust(t);
  const { port, exits } = await start(t, () => s.owner, { binary });
  await until(() => s.counts.boots === 1);
  const request = port.request('core.shutdown');
  await until(() => s.counts.closes === 1);
  boot.resolve();
  const response = await port.response(request);
  assert.deepEqual(response, { version: 1, id: response.id, ok: false, error: { code: 'INTERNAL_ERROR', message: 'Core request failed' } });
  await until(() => exits.includes(1));
  assert.deepEqual(exits, [1]);
  assert.equal(port.ready, false); assert.equal(s.counts.closes, 1); assert.equal(rust.spawn.mock.callCount(), 0);
});

test('Node 领域异常继续原安全 IPC 映射，不泄漏路径或 Rust pin', async t => {
  const s = source({ dispatch: async () => { throw new Error(`私有pin ${binary.sha256} /合成/秘密`); } });
  fakeRust(t);
  const { port, exits } = await start(t, () => s.owner, { binary });
  await until(() => port.ready);
  const response = await port.response(port.request('collection.detail', { id: randomUUID() }));
  assert.deepEqual(response, { version: 1, id: response.id, ok: false, error: { code: 'INTERNAL_ERROR', message: 'Core request failed' } });
  await shutdown(port, exits);
  assert.equal(JSON.stringify(port.messages).includes(binary.sha256), false);
});
