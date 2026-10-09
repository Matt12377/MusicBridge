import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess, { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough, Writable } from 'node:stream';
import type { IpcRequest } from '@music-bridge/contracts';
import type { DatasetCollectionSnapshotVersion, DatasetOwnerEndpoint, DatasetOwnerVersionedSnapshotEndpoint } from '../src/collection/dataset-owner-protocol.js';
import { createRustReadonlyCoreDatasetOwner } from '../src/rust-core/core-dataset-owner.js';
import { RustSidecarError } from '../src/rust-core/readonly-sidecar.js';

// 仅受控 child 与合成 owner；此文件不提供真实进程、账号或设备证据。
const binary = { path: process.execPath, sha256: createHash('sha256').update(readFileSync(process.execPath)).digest('hex') };
const code = (expected: string) => (error: unknown) => error instanceof RustSidecarError && error.code === expected;
const page = { items: [], total: 0, offset: 0, limit: 25, hasMore: false };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(check: () => boolean, now: () => number = () => performance.now()): Promise<void> {
  const deadline = now() + 2_000;
  while (!check()) { if (now() >= deadline) throw new Error('受控行为未及时到达。'); await tick(); }
}
function source() {
  const version: DatasetCollectionSnapshotVersion = { epoch: randomUUID(), datasetId: randomUUID(), revision: randomUUID() };
  const calls = { prepares: 0, boots: 0, closes: 0, probes: 0, exports: 0 };
  const requests: IpcRequest[] = [];
  const snapshot = () => ({ snapshot: { epoch: version.epoch, datasetId: version.datasetId, snapshotId: randomUUID(), models: [] }, version: { ...version } });
  const owner: DatasetOwnerVersionedSnapshotEndpoint = {
    async prepare() { calls.prepares++; return { epoch: version.epoch, datasetId: version.datasetId }; },
    async commitBoot() { calls.boots++; },
    async close() { calls.closes++; },
    async dispatch(request) { requests.push(request); return page; },
    async exportCollectionSnapshot() { throw new Error('不得调用非版本导出。'); },
    async getCollectionSnapshotVersion() { calls.probes++; return { ...version }; },
    async exportVersionedCollectionSnapshot() { calls.exports++; return snapshot(); },
  };
  return { owner, calls, version, requests, snapshot,
    request(overrides: Partial<IpcRequest> = {}): IpcRequest {
      return { version: 1, id: randomUUID(), command: 'collection.list', payload: { page: { offset: 0, limit: 25 } },
        expectedDatasetId: version.datasetId, ...overrides };
    },
  };
}
type Frame = Record<string, unknown>;
function spawnFake(t: test.TestContext, behavior: (frame: Frame, respond: (changes?: Frame) => void) => void = (_frame, respond) => respond()) {
  const frames: Frame[] = [];
  let live = 0, peak = 0;
  const spawn = t.mock.method(childProcess, 'spawn', () => {
    const child = new EventEmitter(); live++; peak = Math.max(live, peak);
    let exited = false;
    child.on('close', () => { if (!exited) { exited = true; live--; } });
    const stdout = new PassThrough(), stderr = new PassThrough();
    let buffered = '', modelCount = 0;
    const stdin = new Writable({ write(chunk: Buffer, _encoding, callback) {
      buffered += chunk.toString();
      while (buffered.includes('\n')) {
        const end = buffered.indexOf('\n'), frame = JSON.parse(buffered.slice(0, end)) as Frame;
        buffered = buffered.slice(end + 1); frames.push(frame);
        if (frame.operation === 'prepare') modelCount = (frame.payload as { models: unknown[] }).models.length;
        const respond = (changes: Frame = {}) => {
          const { payload: _payload, ...identity } = frame;
          const result = frame.operation === 'prepare' ? { epoch: frame.epoch, datasetId: frame.datasetId, snapshotId: frame.snapshotId,
            readOnly: true, capabilities: ['collection.list'], modelCount } : frame.operation === 'dispatch' ? page : null;
          stdout.write(JSON.stringify({ ...identity, ok: true, result, ...changes }) + '\n');
          if (frame.operation === 'close') setImmediate(() => child.emit('close', 0, null));
        };
        setImmediate(() => behavior(frame, respond));
      }
      callback();
    } });
    return Object.assign(child, { stdin, stdout, stderr, kill() { setImmediate(() => child.emit('close', null, 'SIGKILL')); return true; } }) as unknown as ChildProcessWithoutNullStreams;
  });
  return { spawn, frames, get live() { return live; }, get peak() { return peak; } };
}

test('同步factory零来源RPC/零child，并固定调用方options', async t => {
  const f = spawnFake(t), s = source(), options = { binary: { ...binary } };
  const core = createRustReadonlyCoreDatasetOwner(s.owner, options);
  assert.deepEqual(s.calls, { prepares: 0, boots: 0, closes: 0, probes: 0, exports: 0 });
  assert.equal(f.spawn.mock.callCount(), 0);
  assert.deepEqual(core.getStatus(), { phase: 'new' });
  assert.ok(Object.isFrozen(core.getStatus()));
  options.binary.sha256 = '0'.repeat(64); options.binary.path = '/不得启动';
  await core.prepare(); await core.commitBoot();
  assert.equal(core.getStatus().phase, 'ready');
  assert.equal(core.getStatus().router?.phase, 'rust');
  await core.close(); assert.equal(f.live, 0);
});

test('只有完整私有能力可显式准入；v3需大快照能力且factory不执行能力', () => {
  const s = source(), legacy: DatasetOwnerEndpoint = { prepare: s.owner.prepare, dispatch: s.owner.dispatch, commitBoot: s.owner.commitBoot, close: s.owner.close };
  assert.throws(() => createRustReadonlyCoreDatasetOwner(legacy, { binary }), code('SNAPSHOT_UNAVAILABLE'));
  for (const key of ['getCollectionSnapshotVersion', 'exportVersionedCollectionSnapshot', 'exportCollectionSnapshot'] as const) {
    const incomplete = { ...s.owner, [key]: undefined } as unknown as DatasetOwnerEndpoint;
    assert.throws(() => createRustReadonlyCoreDatasetOwner(incomplete, { binary }), code('SNAPSHOT_UNAVAILABLE'));
  }
  assert.throws(() => createRustReadonlyCoreDatasetOwner(s.owner, { binary, snapshotProfile: 'v3-5000' }), code('SNAPSHOT_UNAVAILABLE'));
  const largeOwner = { ...s.owner, exportLargeVersionedCollectionSnapshot: s.owner.exportVersionedCollectionSnapshot };
  assert.doesNotThrow(() => createRustReadonlyCoreDatasetOwner(largeOwner, { binary, snapshotProfile: 'v3-5000' }));
  assert.throws(() => createRustReadonlyCoreDatasetOwner(s.owner, { binary, startupTimeoutMs: 0 }), code('INVALID_REQUEST'));
  assert.equal(s.calls.prepares + s.calls.probes + s.calls.exports, 0);
});

test('prepare/boot合并并发，完整Rust ACK前领域请求与refresh均拒绝', async t => {
  const held: (() => void)[] = [], f = spawnFake(t, (frame, respond) => { if (frame.operation === 'commitBoot') held.push(respond); else respond(); });
  const s = source(), core = createRustReadonlyCoreDatasetOwner(s.owner, { binary });
  await assert.rejects(core.dispatch(s.request()), code('NOT_READY'));
  const prep = core.prepare(); assert.equal(prep, core.prepare()); await prep;
  assert.equal(core.getStatus().phase, 'prepared');
  const boot = core.commitBoot(); assert.equal(boot, core.commitBoot());
  await until(() => held.length === 1);
  await assert.rejects(core.dispatch(s.request()), code('NOT_READY'));
  await assert.rejects(core.refresh(), code('NOT_READY'));
  assert.equal(s.requests.length, 0); assert.equal(core.getStatus().phase, 'booting');
  held[0]!(); await boot;
  assert.equal(core.commitBoot(), boot); assert.equal(s.calls.boots, 1); assert.equal(s.calls.prepares, 1);
  assert.deepEqual(await core.dispatch(s.request()), page);
  assert.equal(s.requests.length, 0); assert.equal(f.spawn.mock.callCount(), 1);
  await core.close(); assert.equal(s.calls.closes, 1);
});

test('Node boot迟到超过整体期限只消费回执，不建立router或child', async t => {
  const f = spawnFake(t), s = source(), pending = deferred<void>();
  s.owner.commitBoot = () => { s.calls.boots++; return pending.promise; };
  const core = createRustReadonlyCoreDatasetOwner(s.owner, { binary, startupTimeoutMs: 40 });
  await assert.rejects(core.commitBoot(), code('TIMEOUT'));
  assert.equal(core.getStatus().phase, 'failed'); assert.equal(core.getStatus().errorCode, 'TIMEOUT');
  assert.equal(s.calls.closes, 1);
  pending.resolve(); await tick();
  assert.equal(s.calls.probes, 0); assert.equal(f.spawn.mock.callCount(), 0);
  await assert.rejects(core.commitBoot(), code('TIMEOUT'));
  await core.close(); assert.equal(s.calls.closes, 1);
});

test('单一单调期限包含Node boot、版本探测、导出与child boot，不能逐段重置', async t => {
  const s = source();
  s.owner.commitBoot = async () => { s.calls.boots++; await new Promise(resolve => setTimeout(resolve, 250)); };
  s.owner.exportVersionedCollectionSnapshot = async () => { s.calls.exports++; await new Promise(resolve => setTimeout(resolve, 250)); return s.snapshot(); };
  const f = spawnFake(t, (frame, respond) => { if (frame.operation === 'commitBoot') setTimeout(respond, 650); else respond(); });
  const core = createRustReadonlyCoreDatasetOwner(s.owner, { binary, startupTimeoutMs: 1_000, requestTimeoutMs: 2_000 });
  await assert.rejects(core.commitBoot(), code('TIMEOUT'));
  assert.equal(s.calls.boots, 1); assert.equal(s.calls.exports, 1); assert.equal(f.spawn.mock.callCount(), 1);
  assert.equal(core.getStatus().phase, 'failed');
  await assert.rejects(core.close(), code('TIMEOUT'));
  await until(() => f.live === 0); assert.equal(s.calls.closes, 1);
});

test('关闭即刻封闭、Node close立即登记一次，无需等在途Node boot结束', async t => {
  const s = source(), f = spawnFake(t), held = deferred<void>();
  s.owner.commitBoot = () => { s.calls.boots++; return held.promise; };
  const core = createRustReadonlyCoreDatasetOwner(s.owner, { binary });
  const boot = core.commitBoot(); await until(() => s.calls.boots === 1);
  const close = core.close(); assert.equal(close, core.close());
  assert.equal(s.calls.closes, 1); assert.equal(core.getStatus().phase, 'closing');
  await assert.rejects(core.dispatch(s.request()), code('CLOSING'));
  await assert.rejects(core.prepare(), code('CLOSING'));
  await assert.rejects(boot, code('CLOSING')); await close;
  held.reject(new Error('迟到Node boot失败')); await tick();
  assert.equal(core.getStatus().phase, 'closed'); assert.equal(f.spawn.mock.callCount(), 0);
});

test('router创建中的版本探测迟到不能启动child，关闭消费创建并清理Node', async t => {
  const s = source(), f = spawnFake(t), held = deferred<DatasetCollectionSnapshotVersion>();
  s.owner.getCollectionSnapshotVersion = () => { s.calls.probes++; return held.promise; };
  const core = createRustReadonlyCoreDatasetOwner(s.owner, { binary });
  const boot = core.commitBoot(); await until(() => s.calls.probes === 1);
  const close = core.close();
  await assert.rejects(boot, code('CLOSING')); await close;
  held.resolve(s.version); await tick();
  assert.equal(core.getStatus().phase, 'closed'); assert.equal(f.spawn.mock.callCount(), 0); assert.equal(s.calls.closes, 1);
});

test('末次版本探测迟到越过整体期限时清理已boot候选，不能发布ready', async t => {
  const realNow = performance.now.bind(performance);
  let now = realNow();
  // 二进制完整校验的机器耗时不决定受控探测阶段；期限仍固定500ms。
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = source(), f = spawnFake(t), held = deferred<DatasetCollectionSnapshotVersion>();
  // 刷新前锁定新增一次探测；按候选实际 boot 阶段挂起末次探测，避免借用调用序号。
  s.owner.getCollectionSnapshotVersion = () => {
    s.calls.probes++;
    return f.frames.some(frame => frame.operation === 'commitBoot') ? held.promise : Promise.resolve(s.version);
  };
  const core = createRustReadonlyCoreDatasetOwner(s.owner, { binary, startupTimeoutMs: 500 });
  t.after(() => { held.resolve(s.version); return core.close().catch(() => {}); });
  const boot = core.commitBoot(), expired = assert.rejects(boot, code('TIMEOUT'));
  await until(() => s.calls.probes === 3, realNow);
  assert.equal(s.calls.probes, 3); assert.equal(f.spawn.mock.callCount(), 1);
  assert.equal(f.frames.filter(frame => frame.operation === 'commitBoot').length, 1);
  assert.equal(core.getStatus().phase, 'booting');
  now += 500; t.mock.timers.tick(500);
  await expired;
  held.resolve(s.version); await tick();
  assert.equal(core.getStatus().phase, 'failed');
  await core.close(); assert.equal(f.live, 0); assert.equal(s.calls.closes, 1);
});

test('child启动ACK迟到遇到close只能清理候选，不重新发布ready', async t => {
  const s = source(), held: (() => void)[] = [], f = spawnFake(t, (frame, respond) => { if (frame.operation === 'commitBoot') held.push(respond); else respond(); });
  const core = createRustReadonlyCoreDatasetOwner(s.owner, { binary });
  const boot = core.commitBoot(); await until(() => held.length === 1);
  const close = core.close(); assert.equal(s.calls.closes, 1);
  held[0]!(); await assert.rejects(boot, code('CLOSING')); await close;
  assert.equal(core.getStatus().phase, 'closed'); assert.equal(f.live, 0);
  assert.equal(f.frames.filter(frame => frame.operation === 'close').length, 1);
});

test('pin失败清理Node，原失败码安全可见且不再次boot', async t => {
  const s = source(), f = spawnFake(t), core = createRustReadonlyCoreDatasetOwner(s.owner, { binary: { ...binary, sha256: '0'.repeat(64) } });
  await assert.rejects(core.commitBoot(), code('BINARY_PIN_MISMATCH'));
  assert.equal(core.getStatus().errorCode, 'BINARY_PIN_MISMATCH'); assert.equal(s.calls.closes, 1);
  await assert.rejects(core.commitBoot(), code('BINARY_PIN_MISMATCH'));
  assert.equal(s.calls.boots, 1); assert.equal(f.spawn.mock.callCount(), 0);
  await assert.rejects(core.close(), code('BINARY_PIN_MISMATCH')); assert.equal(s.calls.closes, 1);
});

test('坏child启动回执清理全部候选，关闭仍呈现非自然退出失败', async t => {
  const s = source(), f = spawnFake(t, (frame, respond) => respond(frame.operation === 'prepare' ? { result: '坏回执' } : {}));
  const core = createRustReadonlyCoreDatasetOwner(s.owner, { binary });
  await assert.rejects(core.commitBoot(), code('PROTOCOL_ERROR'));
  await assert.rejects(core.close(), code('PROTOCOL_ERROR'));
  assert.equal(core.getStatus().phase, 'failed'); assert.equal(core.getStatus().errorCode, 'PROTOCOL_ERROR');
  await until(() => f.live === 0); assert.equal(s.calls.closes, 1); assert.equal(f.peak, 1);
});

test('ready后collection.list走Rust，其余已有领域只到Node；非领域闭集不会泄漏', async t => {
  const s = source(), f = spawnFake(t), core = createRustReadonlyCoreDatasetOwner(s.owner, { binary });
  await core.commitBoot(); await core.dispatch(s.request());
  const detail = s.request({ command: 'collection.detail', payload: { modelId: randomUUID(), page: { offset: 0, limit: 25 } } });
  assert.equal(await core.dispatch(detail), page); assert.equal(s.requests[0], detail);
  const unsupported = { ...s.request(), command: 'auth.login', payload: { token: '合成保密值' } } as unknown as IpcRequest;
  await assert.rejects(core.dispatch(unsupported), code('UNSUPPORTED_COMMAND'));
  assert.equal(s.requests.length, 1);
  assert.equal(f.frames.filter(frame => frame.operation === 'dispatch').length, 1);
  assert.equal(JSON.stringify(f.frames).includes('合成保密值'), false);
  await core.close();
});

for (const outcome of ['success', 'failure', 'unknown'] as const) {
  test(`写入${outcome}回执在invalidate/close后保留对象与命令身份，不重放`, async t => {
    const s = source(), f = spawnFake(t), held = deferred<unknown>(), core = createRustReadonlyCoreDatasetOwner(s.owner, { binary });
    await core.commitBoot();
    const request = s.request({ command: 'collection.setPolicy', payload: { id: randomUUID(), collectorPolicy: 'normal' } });
    s.owner.dispatch = input => { s.requests.push(input); return held.promise; };
    const write = core.dispatch(request); await until(() => s.requests.length === 1);
    assert.equal(core.getStatus().router?.phase, 'stale'); await assert.rejects(core.refresh(), code('NOT_READY'));
    core.invalidate(); const close = core.close();
    const receipt = outcome === 'success' ? { commandId: request.id, outcome: 'committed' }
      : Object.assign(new Error('合成领域失败'), { code: outcome === 'unknown' ? 'DATASET_WRITE_UNKNOWN' : 'WRITE_FAILED', commandId: request.id });
    if (outcome === 'success') { held.resolve(receipt); assert.equal(await write, receipt); }
    else { held.reject(receipt); await assert.rejects(write, value => value === receipt); }
    await close;
    assert.equal(s.requests.length, 1); assert.equal(s.requests[0], request);
    assert.equal(f.frames.filter(frame => frame.operation === 'dispatch').length, 0); assert.equal(s.calls.closes, 1);
  });
}

test('并发refresh合并，旧child退出后才创建下一child，关闭Node仍只一次', async t => {
  const s = source(), f = spawnFake(t), core = createRustReadonlyCoreDatasetOwner(s.owner, { binary });
  await core.commitBoot();
  const refresh = core.refresh(); assert.equal(refresh, core.refresh()); await refresh;
  assert.equal(f.spawn.mock.callCount(), 2); assert.equal(f.peak, 1);
  const close = core.close(); assert.equal(close, core.close()); await close;
  assert.equal(f.live, 0); assert.equal(s.calls.closes, 1);
});

test('Node关闭失败不能伪称closed，关闭Promise/原异常只返回一次且status不泄漏', async t => {
  const s = source(), f = spawnFake(t), failure = new Error('私密数据库路径');
  s.owner.close = async () => { s.calls.closes++; throw failure; };
  const core = createRustReadonlyCoreDatasetOwner(s.owner, { binary }); await core.commitBoot();
  const close = core.close(); assert.equal(close, core.close());
  await assert.rejects(close, value => value === failure);
  assert.equal(core.getStatus().phase, 'failed'); assert.equal(core.getStatus().errorCode, 'PROCESS_EXIT');
  assert.equal(JSON.stringify(core.getStatus()).includes('私密'), false); assert.equal(s.calls.closes, 1); assert.equal(f.live, 0);
  await assert.rejects(core.dispatch(s.request()), code('CLOSING'));
});

test('Rust关闭坏回执不能伪称closed，Node仍收口一次', async t => {
  const s = source(), f = spawnFake(t, (frame, respond) => respond(frame.operation === 'close' ? { result: '坏关闭回执' } : {}));
  const core = createRustReadonlyCoreDatasetOwner(s.owner, { binary }); await core.commitBoot();
  await assert.rejects(core.close(), code('PROTOCOL_ERROR'));
  assert.equal(core.getStatus().phase, 'failed'); assert.equal(core.getStatus().errorCode, 'PROTOCOL_ERROR');
  assert.equal(s.calls.closes, 1); await until(() => f.live === 0);
});

test('prepare失败原调用保留异常，同时关闭Node一次且status仅安全错误码', async t => {
  const s = source(), f = spawnFake(t), failure = new Error('私密来源异常');
  s.owner.prepare = async () => { s.calls.prepares++; throw failure; };
  const core = createRustReadonlyCoreDatasetOwner(s.owner, { binary });
  await assert.rejects(core.prepare(), value => value === failure);
  assert.equal(core.getStatus().phase, 'failed'); assert.equal(core.getStatus().errorCode, 'SNAPSHOT_UNAVAILABLE');
  assert.equal(s.calls.closes, 1); assert.equal(f.spawn.mock.callCount(), 0);
  await core.close(); assert.equal(s.calls.closes, 1);
});

test('Node prepare与版本探测身份错配在导出/spawn前拒绝，不发布另一来源库', async t => {
  const s = source(), f = spawnFake(t);
  s.owner.prepare = async () => { s.calls.prepares++; return { epoch: s.version.epoch, datasetId: randomUUID() }; };
  const core = createRustReadonlyCoreDatasetOwner(s.owner, { binary });
  await assert.rejects(core.commitBoot(), code('SCOPE_MISMATCH'));
  assert.equal(s.calls.exports, 0); assert.equal(f.spawn.mock.callCount(), 0);
  assert.equal(core.getStatus().errorCode, 'SCOPE_MISMATCH');
  await core.close(); assert.equal(s.calls.closes, 1);
});

test('prepare返回身份冻结，调用者不能修改内部绑定或改变之后的router事实', async t => {
  const s = source(), f = spawnFake(t), core = createRustReadonlyCoreDatasetOwner(s.owner, { binary });
  t.after(() => core.close().catch(() => {}));
  const identity = await core.prepare();
  assert.ok(Object.isFrozen(identity));
  assert.throws(() => { identity.datasetId = randomUUID(); }, TypeError);
  assert.throws(() => { identity.epoch = randomUUID(); }, TypeError);
  await core.commitBoot();
  assert.equal(core.getStatus().router?.datasetId, s.version.datasetId);
  assert.equal(core.getStatus().router?.epoch, s.version.epoch);
  assert.equal(f.spawn.mock.callCount(), 1);
});

for (const lateOutcome of ['resolve', 'reject'] as const) {
  test(`Node close未确认必须在整体关闭期限失败，迟到${lateOutcome}不重开或冒称自然关闭`, async t => {
    const s = source(), f = spawnFake(t), held = deferred<void>();
    s.owner.close = () => { s.calls.closes++; return held.promise; };
    const core = createRustReadonlyCoreDatasetOwner(s.owner, { binary, closeTimeoutMs: 60 });
    await core.commitBoot();
    const startedAt = performance.now(), close = core.close();
    assert.equal(close, core.close()); assert.equal(s.calls.closes, 1);
    await assert.rejects(close, code('TIMEOUT'));
    assert.ok(performance.now() - startedAt < 1_000, '整体关闭不能无限等待来源ACK。');
    assert.equal(core.getStatus().phase, 'failed'); assert.equal(core.getStatus().errorCode, 'TIMEOUT');
    const status = core.getStatus();
    assert.equal(close, core.close()); await assert.rejects(core.close(), code('TIMEOUT'));
    if (lateOutcome === 'resolve') held.resolve(); else held.reject(new Error('迟到私密关闭异常'));
    await tick(); await tick();
    assert.deepEqual(core.getStatus(), status);
    await assert.rejects(core.dispatch(s.request()), code('CLOSING'));
    await assert.rejects(core.commitBoot(), code('CLOSING'));
    await assert.rejects(core.refresh(), code('CLOSING'));
    assert.equal(s.calls.closes, 1); assert.equal(f.spawn.mock.callCount(), 1);
    await until(() => f.live === 0);
  });
}
