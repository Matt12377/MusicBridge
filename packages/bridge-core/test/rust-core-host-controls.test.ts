import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess, { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough, Writable } from 'node:stream';
import type { IpcRequest, IpcResponse } from '@music-bridge/contracts';
import type { DatasetOwnerVersionedSnapshotEndpoint } from '../src/collection/dataset-owner-protocol.js';
import { runCoreUtilityProcess, type DatasetOwnerFactory, type UtilityPort } from '../src/utility-main.js';
import type { RustReadonlyCoreController } from '../src/rust-core/host-controller.js';
import type { RustReadonlyCoreOptions } from '../src/rust-core/core-dataset-owner.js';
import { RustSidecarError } from '../src/rust-core/readonly-sidecar.js';

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
async function start(t: test.TestContext, factory?: DatasetOwnerFactory, options?: RustReadonlyCoreOptions, overrides: NodeJS.ProcessEnv = {}, message: unknown = { type: 'musicbridge.core.port' }, control?: (controller: RustReadonlyCoreController) => void) {
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
  await runCoreUtilityProcess({ ...env, ...overrides }, undefined, undefined, undefined, undefined, factory, options, control);
  const port = new Port();
  listener({ data: message, ports: [port] });
  return { port, exits };
}
async function shutdown(port: Port, exits: unknown[]) {
  const response = await port.response(port.request('core.shutdown'));
  assert.equal(response.ok, true);
  await until(() => exits.includes(0));
}

test('旧六参数保留原启动、Node控制面与零Rust资源语义', async t => {
  const s = source(), rust = fakeRust(t);
  const { port, exits } = await start(t, () => s.owner);
  await until(() => port.ready);
  assert.equal((await port.response(port.request('collection.list', { page: { offset: 0, limit: 25 } }))).ok, true);
  await shutdown(port, exits);
  assert.deepEqual(s.counts, { prepares: 1, boots: 1, closes: 1, probes: 0, exports: 0 });
  assert.equal(rust.spawn.mock.callCount(), 0);
});

test('仅第七参数保留既有boot与导出，控制面无需主机回调', async t => {
  const s = source(), rust = fakeRust(t);
  const { port, exits } = await start(t, () => s.owner, { binary });
  await until(() => port.ready);
  assert.equal(s.counts.prepares, 1); assert.equal(s.counts.boots, 1); assert.equal(s.counts.exports, 1);
  assert.equal((await port.response(port.request('core.ping'))).ok, true);
  await shutdown(port, exits);
  assert.equal(s.counts.closes, 1); assert.equal(rust.live, 0);
});

test('可信回调在prepare前恰好交付一次冻结窄能力，ready后显式控制可恢复Rust', async t => {
  const s = source(), rust = fakeRust(t);
  let control!: RustReadonlyCoreController, calls = 0;
  let earlyRefresh!: Promise<void>;
  const { port, exits } = await start(t, () => s.owner, { binary }, {}, undefined, value => {
    control = value; calls++;
    assert.equal(s.counts.prepares, 0);
    assert.deepEqual(control.getStatus(), { phase: 'new' });
    earlyRefresh = assert.rejects(control.refresh(), error => error instanceof RustSidecarError && error.code === 'NOT_READY');
    assert.equal(Object.isFrozen(control), true);
    assert.deepEqual(Object.keys(control).sort(), ['getStatus', 'invalidate', 'refresh']);
    assert.equal(Reflect.set(control, 'close', () => {}), false);
    assert.equal(Reflect.set(control, 'refresh', () => Promise.resolve()), false);
  });
  await earlyRefresh;
  await until(() => port.ready);
  assert.equal(calls, 1);
  assert.equal(control.getStatus().router?.phase, 'rust');
  const ready = port.messages.find(message => (message as { event?: string }).event === 'core.ready') as { payload: Record<string, unknown> };
  assert.deepEqual(Object.keys(ready.payload), ['state']);
  for (const command of ['core.ping', 'core.getHealth', 'core.getDiagnostics'] as const) {
    const response = await port.response(port.request(command));
    assert.equal(response.ok, true);
    assert.equal(JSON.stringify(response).includes('router'), false);
    assert.equal(JSON.stringify(response).includes(binary.sha256), false);
  }
  control.invalidate();
  assert.equal(control.getStatus().router?.phase, 'stale');
  const exportCount = s.counts.exports;
  assert.equal((await port.response(port.request('collection.list', { page: { offset: 0, limit: 25 } }))).ok, true);
  assert.equal(s.requests.length, 1);
  assert.equal(s.counts.exports, exportCount, '失效后的读取不得自动刷新。');
  await control.refresh();
  assert.equal(control.getStatus().router?.phase, 'rust');
  assert.equal(s.counts.exports, exportCount + 1);
  assert.equal((await port.response(port.request('collection.list', { page: { offset: 0, limit: 25 } }))).ok, true);
  assert.equal(s.requests.length, 1);
  await shutdown(port, exits);
  const final = control.getStatus();
  assert.equal(final.phase, 'closed');
  assert.equal(final.router?.phase, 'closed');
  assert.equal(Object.isFrozen(final), true);
  assert.equal(Object.isFrozen(final.router), true);
  const children = rust.spawn.mock.callCount(), probes = s.counts.probes;
  await assert.rejects(control.refresh(), error => error instanceof RustSidecarError && error.code === 'CLOSING');
  control.invalidate();
  assert.deepEqual(control.getStatus(), final);
  assert.equal(rust.spawn.mock.callCount(), children); assert.equal(s.counts.probes, probes);
  assert.equal(s.counts.closes, 1); assert.equal(rust.live, 0);
});

test('写请求保留Node唯一writer，失效后只有显式刷新建立新child', async t => {
  const s = source(), rust = fakeRust(t);
  let control!: RustReadonlyCoreController;
  const { port, exits } = await start(t, () => s.owner, { binary }, {}, undefined, value => { control = value; });
  await until(() => port.ready);
  const created = rust.spawn.mock.callCount(), exported = s.counts.exports;
  assert.equal((await port.response(port.request('collection.setPolicy', {
    commandId: randomUUID(), modelId: randomUUID(), expectedRevision: 1, collectorPolicy: 'normal', minimumSealedReserve: 0,
  }))).ok, true);
  assert.equal(s.requests.length, 1);
  assert.equal(control.getStatus().router?.phase, 'stale');
  assert.equal(rust.spawn.mock.callCount(), created); assert.equal(s.counts.exports, exported);
  await control.refresh();
  assert.equal(control.getStatus().router?.phase, 'rust');
  assert.equal(rust.spawn.mock.callCount(), created + 1);
  await shutdown(port, exits);
});

test('第八参数没有第七配置时拒绝，既不创建Owner也不打开legacy库', async t => {
  const rust = fakeRust(t);
  let factories = 0, controls = 0;
  const { port, exits } = await start(t, () => { factories++; return source().owner; }, undefined, {}, undefined, () => { controls++; });
  await until(() => exits.includes(1));
  assert.equal(factories, 0); assert.equal(controls, 0); assert.equal(port.ready, false); assert.equal(rust.spawn.mock.callCount(), 0);
});

test('无Factory或坏类型主机控制参数均在资源准入前失败', async t => {
  const rust = fakeRust(t);
  let controls = 0;
  const { port, exits } = await start(t, undefined, { binary }, {}, undefined, () => { controls++; });
  await until(() => exits.includes(1));
  assert.equal(controls, 0); assert.equal(port.ready, false); assert.equal(rust.spawn.mock.callCount(), 0);
});

test('缺少第七配置和Factory时不调用legacy资源创建入口', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'parentPort'), previousExitCode = process.exitCode;
  let listener!: (event: { data: unknown; ports: UtilityPort[] }) => void;
  const exits: unknown[] = [];
  t.mock.method(process, 'exit', ((code?: number | string | null) => { exits.push(code); }) as typeof process.exit);
  Object.defineProperty(process, 'parentPort', { configurable: true, value: { once(_event: string, callback: typeof listener) { listener = callback; } } });
  t.after(() => {
    if (descriptor) Object.defineProperty(process, 'parentPort', descriptor);
    else Reflect.deleteProperty(process, 'parentPort');
    process.exitCode = previousExitCode;
  });
  let legacy = 0, controls = 0;
  await runCoreUtilityProcess(env, async () => { legacy++; return undefined; }, undefined, undefined, undefined,
    undefined, undefined, () => { controls++; });
  const port = new Port(); listener({ data: { type: 'musicbridge.core.port' }, ports: [port] });
  await until(() => exits.includes(1));
  assert.equal(legacy, 0); assert.equal(controls, 0); assert.equal(port.ready, false);
});

for (const bad of [null, {}, true, 'refresh']) {
  test(`坏类型主机回调 ${String(bad)} 不创建Owner`, async t => {
    const rust = fakeRust(t);
    let factories = 0;
    const { port, exits } = await start(t, () => { factories++; return source().owner; }, { binary }, {}, undefined,
      bad as unknown as (controller: RustReadonlyCoreController) => void);
    await until(() => exits.includes(1));
    assert.equal(factories, 0); assert.equal(port.ready, false); assert.equal(rust.spawn.mock.callCount(), 0);
  });
}

test('同步回调抛错清理已登记组合和Node一次，私有错误不进入公开消息或日志', async t => {
  const s = source(), rust = fakeRust(t);
  let control!: RustReadonlyCoreController;
  const logs: string[] = [];
  const stdoutWrite = process.stdout.write, stderrWrite = process.stderr.write;
  // 保留测试框架本身的输出与回执，同时记录应用日志。
  t.mock.method(process.stdout, 'write', ((chunk: unknown, ...args: unknown[]) => {
    logs.push(String(chunk)); return Reflect.apply(stdoutWrite, process.stdout, [chunk, ...args]);
  }) as typeof process.stdout.write);
  t.mock.method(process.stderr, 'write', ((chunk: unknown, ...args: unknown[]) => {
    logs.push(String(chunk)); return Reflect.apply(stderrWrite, process.stderr, [chunk, ...args]);
  }) as typeof process.stderr.write);
  const { port, exits } = await start(t, () => s.owner, { binary }, {}, undefined, value => {
    control = value;
    throw new Error('主机私密 /合成/秘密');
  });
  await until(() => exits.includes(1));
  assert.equal(s.counts.closes, 1); assert.equal(s.counts.prepares, 0); assert.equal(s.counts.boots, 0);
  assert.equal(s.counts.exports, 0); assert.equal(rust.spawn.mock.callCount(), 0); assert.equal(port.ready, false);
  await assert.rejects(control.refresh(), error => error instanceof RustSidecarError && error.code === 'CLOSING');
  assert.equal(control.getStatus().phase, 'closed');
  assert.equal(JSON.stringify([...port.messages, ...logs]).includes('/合成/秘密'), false);
});

for (const result of ['挂起Promise', '拒绝Promise', '非空普通值'] as const) {
  test(`主机回调返回${result}立即拒绝并收口，不等待异步回调`, async t => {
    const s = source(), rust = fakeRust(t);
    let control!: RustReadonlyCoreController;
    const { port, exits } = await start(t, () => s.owner, { binary, startupTimeoutMs: 30_000 }, {}, undefined,
      ((value: RustReadonlyCoreController) => {
        control = value;
        if (result === '挂起Promise') return new Promise<void>(() => {});
        if (result === '拒绝Promise') return Promise.reject(new Error('异步私密 /合成/秘密'));
        return true;
      }) as unknown as (controller: RustReadonlyCoreController) => void);
    await until(() => exits.includes(1));
    assert.equal(port.ready, false); assert.equal(s.counts.prepares, 0); assert.equal(s.counts.boots, 0);
    assert.equal(s.counts.closes, 1); assert.equal(rust.spawn.mock.callCount(), 0);
    assert.equal(control.getStatus().phase, 'closed');
    await assert.rejects(control.refresh(), error => error instanceof RustSidecarError && error.code === 'CLOSING');
    assert.equal(JSON.stringify(port.messages).includes('/合成/秘密'), false);
  });
}

test('captured控制器随提前并发shutdown封闭，原stopped回执和once清理保持', async t => {
  const boot = deferred(), close = deferred(), s = source({ boot: () => boot.promise, close: () => close.promise }), rust = fakeRust(t);
  let control!: RustReadonlyCoreController;
  const { port, exits } = await start(t, () => s.owner, { binary }, {}, undefined, value => { control = value; });
  await until(() => s.counts.boots === 1);
  const first = port.request('core.shutdown'), second = port.request('core.shutdown');
  await until(() => s.counts.closes === 1);
  assert.equal(control.getStatus().phase, 'closing');
  await assert.rejects(control.refresh(), error => error instanceof RustSidecarError && error.code === 'CLOSING');
  control.invalidate(); boot.resolve(); close.resolve();
  assert.equal((await port.response(first)).ok, true); assert.equal((await port.response(second)).ok, true);
  await until(() => exits.includes(0));
  assert.equal(exits.includes(1), false); assert.equal(port.ready, false);
  assert.equal(s.counts.closes, 1); assert.equal(rust.spawn.mock.callCount(), 0); assert.equal(control.getStatus().phase, 'closed');
});

test('并发shutdown失败保留安全失败回执，控制器不能复活failed资源', async t => {
  const s = source({ close: async () => { throw new RustSidecarError('PROCESS_EXIT'); } }), rust = fakeRust(t);
  let control!: RustReadonlyCoreController;
  const { port, exits } = await start(t, () => s.owner, { binary }, {}, undefined, value => { control = value; });
  await until(() => port.ready);
  const first = port.request('core.shutdown'), second = port.request('core.shutdown');
  for (const id of [first, second]) {
    assert.deepEqual(await port.response(id), { version: 1, id, ok: false, error: { code: 'INTERNAL_ERROR', message: 'Core request failed' } });
  }
  assert.equal(exits.includes(0), false); assert.equal(s.counts.closes, 1); assert.equal(rust.live, 0);
  assert.equal(control.getStatus().phase, 'failed');
  await assert.rejects(control.refresh(), error => error instanceof RustSidecarError && error.code === 'CLOSING');
});

test('启动来源失败后captured控制器保持安全关闭，不泄漏异常或重放Node', async t => {
  const s = source({ prepare: async () => { throw new Error('来源私密 /合成/秘密'); } }), rust = fakeRust(t);
  let control!: RustReadonlyCoreController;
  const { port, exits } = await start(t, () => s.owner, { binary }, {}, undefined, value => { control = value; });
  await until(() => exits.includes(1));
  assert.equal(s.counts.closes, 1); assert.equal(port.ready, false); assert.equal(rust.spawn.mock.callCount(), 0);
  assert.equal(control.getStatus().phase, 'closed');
  assert.equal(JSON.stringify(control.getStatus()).includes('/合成/秘密'), false);
  assert.equal(JSON.stringify(port.messages).includes('/合成/秘密'), false);
  await assert.rejects(control.refresh(), error => error instanceof RustSidecarError && error.code === 'CLOSING');
  assert.equal(s.counts.prepares, 1);
});

test('环境、父端口和Renderer载荷无法取得或启用主机控制能力', async t => {
  const s = source(), rust = fakeRust(t);
  const { port, exits } = await start(t, () => s.owner, undefined,
    { MUSIC_BRIDGE_RUST_READONLY: '1', MUSIC_BRIDGE_RUST_CONTROLLER: 'refresh', MUSIC_BRIDGE_RUST_BINARY: binary.path });
  await until(() => port.ready);
  const response = await port.response(port.request('core.ping', { onRustReadonlyCoreController: true }));
  assert.equal(response.ok, false);
  await shutdown(port, exits);
  assert.equal(s.counts.exports, 0); assert.equal(rust.spawn.mock.callCount(), 0);
});

test('父端口主机控制字段拒绝，不创建Owner或公开ready', async t => {
  let factories = 0;
  const rust = fakeRust(t);
  const { port, exits } = await start(t, () => { factories++; return source().owner; }, undefined, {},
    { type: 'musicbridge.core.port', onRustReadonlyCoreController: true });
  await until(() => exits.includes(1));
  assert.equal(factories, 0); assert.equal(port.ready, false); assert.equal(rust.spawn.mock.callCount(), 0);
});
