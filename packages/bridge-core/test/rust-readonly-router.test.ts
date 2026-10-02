import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess, { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough, Writable } from 'node:stream';
import type { IpcRequest } from '@music-bridge/contracts';
import type { DatasetCollectionSnapshotVersion, DatasetOwnerVersionedSnapshotEndpoint } from '../src/collection/dataset-owner-protocol.js';
import { createRustReadonlyCollectionRouter } from '../src/rust-core/readonly-router.js';
import { RustSidecarError } from '../src/rust-core/readonly-sidecar.js';

const binary = { path: process.execPath, sha256: createHash('sha256').update(readFileSync(process.execPath)).digest('hex') };
const code = (expected: string) => (error: unknown) => error instanceof RustSidecarError && error.code === expected;
const page = { items: [], total: 0, offset: 0, limit: 25, hasMore: false };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error('受控行为未及时到达。');
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}
function source() {
  let version: DatasetCollectionSnapshotVersion = { epoch: randomUUID(), datasetId: randomUUID(), revision: randomUUID() };
  const requests: IpcRequest[] = [];
  let probes = 0, exports = 0, prepares = 0, boots = 0, closes = 0;
  const owner: DatasetOwnerVersionedSnapshotEndpoint = {
    async prepare() { prepares++; return { epoch: version.epoch, datasetId: version.datasetId }; },
    async commitBoot() { boots++; }, async close() { closes++; },
    async dispatch(request) { requests.push(request); return page; },
    async exportCollectionSnapshot() { throw new Error('不可调用非版本导出。'); },
    async getCollectionSnapshotVersion() { probes++; return { ...version }; },
    async exportVersionedCollectionSnapshot() {
      exports++;
      return { snapshot: { epoch: version.epoch, datasetId: version.datasetId, snapshotId: randomUUID(), models: [] }, version: { ...version } };
    },
  };
  return { owner, requests, get version() { return version; }, set version(next) { version = next; },
    get counts() { return { probes, exports, prepares, boots, closes }; },
    request(overrides: Partial<IpcRequest> = {}): IpcRequest {
      return { version: 1, id: randomUUID(), command: 'collection.list', payload: { page: { offset: 0, limit: 25 } },
        expectedDatasetId: version.datasetId, ...overrides };
    },
  };
}
type Frame = Record<string, unknown>;
function spawnFake(t: test.TestContext, behavior: (frame: Frame, respond: (changes?: Frame) => void, child: EventEmitter, index: number) => void = (_frame, respond) => respond(), holdKillExit = false) {
  const frames: Frame[] = [], children: EventEmitter[] = [];
  const pendingKills: (() => void)[] = [];
  let live = 0, peak = 0;
  const spawn = t.mock.method(childProcess, 'spawn', () => {
    const child = new EventEmitter(), index = children.length;
    children.push(child); live++; peak = Math.max(peak, live);
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
        setImmediate(() => behavior(frame, respond, child, index));
      }
      callback();
    } });
    return Object.assign(child, { stdin, stdout, stderr,
      kill() {
        const exit = () => child.emit('close', null, 'SIGKILL');
        if (holdKillExit) pendingKills.push(exit); else setImmediate(exit);
        return true;
      },
    }) as unknown as ChildProcessWithoutNullStreams;
  });
  return { frames, children, spawn, releaseKills() { pendingKills.splice(0).forEach(exit => exit()); }, get live() { return live; }, get peak() { return peak; } };
}

for (const stage of ['prepare', 'commitBoot', 'timeout'] as const) {
  test(`工厂尚未返回时${stage}失败也登记候选，延迟强杀退出不能再启动或伪称关闭`, async t => {
    const s = source();
    const f = spawnFake(t, (frame, respond, _child, index) => {
      if (index === 0 && frame.operation === (stage === 'timeout' ? 'prepare' : stage)) {
        if (stage !== 'timeout') respond({ result: '坏启动回执' });
      } else respond();
    }, true);
    // 坏回执使用正常 RPC 预算，避免并行负载先触发计时器；刻意无回执仍验证 25ms 超时。
    const router = await createRustReadonlyCollectionRouter({ binary, owner: s.owner,
      ...(stage === 'timeout' ? { requestTimeoutMs: 25 } : {}) });
    t.after(async () => { await router.close().catch(() => {}); f.releaseKills(); });
    const expected = stage === 'timeout' ? 'TIMEOUT' : 'PROTOCOL_ERROR';
    await assert.rejects(router.refresh(), code(expected));
    assert.equal(f.live, 1, 'SIGKILL 调用尚不构成退出证明。');
    await assert.rejects(router.refresh(), code(expected));
    assert.equal(f.spawn.mock.callCount(), 1);
    assert.equal(f.peak, 1);
    await assert.rejects(router.close(), code(expected));
    assert.equal(s.counts.closes, 0);
    f.releaseKills();
    await until(() => f.live === 0);
  });
}

test('默认只读Node，显式刷新才启动；前后版本探测与Node合同保留', async t => {
  const f = spawnFake(t), s = source(), router = await createRustReadonlyCollectionRouter({ binary, owner: s.owner });
  assert.equal(router.getStatus().phase, 'node');
  assert.equal(await router.dispatch(s.request()), page);
  assert.equal(f.spawn.mock.callCount(), 0);
  assert.equal(s.counts.exports, 0);
  await router.refresh();
  assert.equal(router.getStatus().phase, 'rust');
  const before = s.counts.probes;
  assert.deepEqual(await router.dispatch(s.request()), page);
  assert.equal(s.counts.probes - before, 2);
  const contextual = s.request({ readContext: { deadlineAtMs: Date.now() + 5_000 } });
  assert.equal(await router.dispatch(contextual), page);
  assert.equal(s.requests.at(-1), contextual);
  const wrongScope = s.request({ expectedDatasetId: randomUUID() });
  await assert.rejects(router.dispatch(wrongScope), code('SCOPE_MISMATCH'));
  assert.notEqual(s.requests.at(-1), wrongScope);
  assert.equal(f.frames.filter(frame => frame.operation === 'dispatch').length, 1);
  await router.close();
  assert.deepEqual({ prepares: s.counts.prepares, boots: s.counts.boots, closes: s.counts.closes }, { prepares: 0, boots: 0, closes: 0 });
});

test('就绪child失效立即撤销发布，观察者异常不能影响收口', async t => {
  const f = spawnFake(t), s = source(), observed: string[] = [];
  const router = await createRustReadonlyCollectionRouter({ binary, owner: s.owner, onFatal(code) { observed.push(code); throw new Error('私密异常'); } });
  await router.refresh();
  f.children[0]!.emit('error', new Error('私密进程异常'));
  assert.equal(router.getStatus().phase, 'failed');
  assert.equal(router.getStatus().errorCode, 'PROCESS_EXIT');
  assert.deepEqual(observed, ['PROCESS_EXIT']);
  assert.equal(JSON.stringify(router.getStatus()).includes('私密'), false);
  await assert.rejects(router.close(), code('PROCESS_EXIT'));
  await until(() => f.live === 0);
});

test('刷新合并同一Promise，失效后迟到导出不启动child或覆盖新状态', async t => {
  const f = spawnFake(t), s = source(), pending = deferred<Awaited<ReturnType<typeof s.owner.exportVersionedCollectionSnapshot>>>();
  let exports = 0;
  s.owner.exportVersionedCollectionSnapshot = () => { exports++; return pending.promise; };
  const router = await createRustReadonlyCollectionRouter({ binary, owner: s.owner });
  const first = router.refresh(), second = router.refresh();
  assert.equal(first, second);
  await until(() => exports === 1);
  router.invalidate();
  const status = router.getStatus();
  pending.resolve({ snapshot: { ...s.version, snapshotId: randomUUID(), models: [] }, version: s.version });
  await assert.rejects(first, code('STALE_SNAPSHOT'));
  assert.deepEqual(router.getStatus(), status);
  assert.equal(f.spawn.mock.callCount(), 0);
  await router.close();
});

test('旧child自然退出之前不建立新candidate，同时最多一个child', async t => {
  const s = source(), closing = deferred<void>();
  let oldClose = false;
  const f = spawnFake(t, (frame, respond, _child, index) => {
    if (index === 0 && frame.operation === 'close') { oldClose = true; void closing.promise.then(() => respond()); }
    else respond();
  });
  const router = await createRustReadonlyCollectionRouter({ binary, owner: s.owner });
  await router.refresh();
  const refresh = router.refresh();
  await until(() => oldClose);
  assert.equal(f.spawn.mock.callCount(), 1);
  assert.equal(router.getStatus().phase, 'refreshing');
  closing.resolve(); await refresh;
  assert.equal(f.spawn.mock.callCount(), 2);
  assert.equal(f.peak, 1);
  await router.close();
});

test('调用前版本变化退役旧child，本次Node仅执行一次', async t => {
  const f = spawnFake(t), s = source(), router = await createRustReadonlyCollectionRouter({ binary, owner: s.owner });
  await router.refresh();
  s.version = { ...s.version, revision: randomUUID() };
  const request = s.request();
  assert.equal(await router.dispatch(request), page);
  assert.deepEqual(s.requests, [request]);
  assert.equal(router.getStatus().phase, 'stale');
  assert.equal(f.frames.filter(frame => frame.operation === 'dispatch').length, 0);
  await router.close();
});

test('Rust请求发送后版本改变拒绝旧结果，不静默再次Node读取', async t => {
  const s = source();
  const f = spawnFake(t, (frame, respond) => {
    if (frame.operation === 'dispatch') s.version = { ...s.version, revision: randomUUID() };
    respond();
  });
  const router = await createRustReadonlyCollectionRouter({ binary, owner: s.owner });
  await router.refresh();
  await assert.rejects(router.dispatch(s.request()), code('STALE_SNAPSHOT'));
  assert.equal(s.requests.length, 0);
  assert.equal(f.frames.filter(frame => frame.operation === 'dispatch').length, 1);
  assert.equal(router.getStatus().phase, 'stale');
  await router.close();
});

test('关闭与invalidate阻止迟到Rust读取交付，close等child收口', async t => {
  const s = source(), held: (() => void)[] = [];
  const f = spawnFake(t, (frame, respond) => { if (frame.operation === 'dispatch') held.push(respond); else respond(); });
  const router = await createRustReadonlyCollectionRouter({ binary, owner: s.owner });
  await router.refresh();
  const read = router.dispatch(s.request());
  await until(() => held.length === 1);
  const close = router.close();
  assert.equal(close, router.close());
  assert.equal(router.getStatus().phase, 'closed');
  held[0]!();
  await assert.rejects(read, code('STALE_SNAPSHOT'));
  await close;
  assert.equal(f.live, 0);
  await assert.rejects(router.refresh(), code('CLOSING'));
  await assert.rejects(router.dispatch(s.request()), code('CLOSING'));
});

test('关闭等迟到candidate收口，候选完成后不能重新发布', async t => {
  const s = source(), held: (() => void)[] = [];
  const f = spawnFake(t, (frame, respond) => { if (frame.operation === 'commitBoot') held.push(respond); else respond(); });
  const router = await createRustReadonlyCollectionRouter({ binary, owner: s.owner });
  const refresh = router.refresh();
  await until(() => held.length === 1);
  let closed = false;
  const close = router.close().then(() => { closed = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(closed, false);
  held[0]!();
  await assert.rejects(refresh, code('STALE_SNAPSHOT'));
  await close;
  assert.equal(router.getStatus().phase, 'closed');
  assert.equal(f.live, 0);
  assert.deepEqual(f.frames.map(frame => frame.operation), ['prepare', 'commitBoot', 'close']);
});

test('candidate末次探测版本错配会清理，不交付导出时的旧revision', async t => {
  const s = source(), f = spawnFake(t, (frame, respond) => {
    if (frame.operation === 'commitBoot') s.version = { ...s.version, revision: randomUUID() };
    respond();
  });
  const router = await createRustReadonlyCollectionRouter({ binary, owner: s.owner });
  await assert.rejects(router.refresh(), code('STALE_SNAPSHOT'));
  assert.notEqual(router.getStatus().phase, 'rust');
  await router.close();
  assert.equal(f.live, 0);
});

test('末次探测迟到不能越过整体期限，来源在途RPC保持合法', async t => {
  const f = spawnFake(t), s = source(), held = deferred<DatasetCollectionSnapshotVersion>();
  let probes = 0;
  s.owner.getCollectionSnapshotVersion = () => {
    probes++;
    return f.frames.some(frame => frame.operation === 'commitBoot') ? held.promise : Promise.resolve({ ...s.version });
  };
  const router = await createRustReadonlyCollectionRouter({ binary, owner: s.owner, startupTimeoutMs: 1_000, requestTimeoutMs: 5_000 });
  await assert.rejects(router.refresh(), code('TIMEOUT'));
  assert.equal(probes, 3);
  assert.equal(f.spawn.mock.callCount(), 1);
  assert.equal(f.frames.filter(frame => frame.operation === 'commitBoot').length, 1);
  const status = router.getStatus();
  held.resolve({ ...s.version });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(router.getStatus(), status);
  await router.close();
  assert.equal(f.live, 0);
});

test('整体刷新期限包含旧child退役，超时后不启动第二child', async t => {
  const s = source(), held: (() => void)[] = [];
  const f = spawnFake(t, (frame, respond) => { if (frame.operation === 'close') held.push(respond); else respond(); });
  const router = await createRustReadonlyCollectionRouter({ binary, owner: s.owner, startupTimeoutMs: 1_000, closeTimeoutMs: 5_000 });
  await router.refresh();
  await assert.rejects(router.refresh(), code('TIMEOUT'));
  assert.equal(f.spawn.mock.callCount(), 1);
  await until(() => held.length === 1);
  held[0]!();
  await router.close();
  assert.equal(f.live, 0);
});

test('探测超时拒绝并撤销Rust，不清Node在途探测、不自动重读', async t => {
  const f = spawnFake(t), s = source();
  const router = await createRustReadonlyCollectionRouter({ binary, owner: s.owner, requestTimeoutMs: 100 });
  await router.refresh();
  const held = deferred<DatasetCollectionSnapshotVersion>();
  s.owner.getCollectionSnapshotVersion = () => held.promise;
  await assert.rejects(router.dispatch(s.request()), code('TIMEOUT'));
  assert.equal(s.requests.length, 0);
  assert.equal(f.frames.filter(frame => frame.operation === 'dispatch').length, 0);
  assert.equal(router.getStatus().errorCode, 'TIMEOUT');
  held.resolve(s.version);
  await router.close();
});

test('潜在写入前保守失效，写入在途不可刷新；unknown原error与commandId保留', async t => {
  const f = spawnFake(t), s = source(), pending = deferred<unknown>();
  const router = await createRustReadonlyCollectionRouter({ binary, owner: s.owner });
  await router.refresh();
  const request = s.request({ command: 'collection.setPolicy', payload: { id: randomUUID(), collectorPolicy: 'normal' } });
  let calls = 0;
  s.owner.dispatch = input => { calls++; assert.equal(input, request); return pending.promise; };
  const write = router.dispatch(request);
  assert.equal(router.getStatus().phase, 'stale');
  await assert.rejects(router.refresh(), code('NOT_READY'));
  const error = Object.assign(new Error('未知写入回执'), { code: 'DATASET_WRITE_UNKNOWN', commandId: request.id });
  router.invalidate(); pending.reject(error);
  await assert.rejects(write, result => result === error && (result as typeof error).commandId === request.id);
  assert.equal(calls, 1);
  assert.equal(f.frames.filter(frame => frame.operation === 'dispatch').length, 0);
  await router.close();
});

test('Node同步throw保持原error，迟到Node读取受invalidate和close generation约束', async () => {
  const s = source(), router = await createRustReadonlyCollectionRouter({ binary, owner: s.owner });
  const error = new Error('原Node错误');
  s.owner.dispatch = () => { throw error; };
  await assert.rejects(router.dispatch(s.request()), value => value === error);
  const first = deferred<unknown>();
  s.owner.dispatch = () => first.promise;
  const read = router.dispatch(s.request());
  router.invalidate(); first.resolve(page);
  await assert.rejects(read, code('STALE_SNAPSHOT'));
  const second = deferred<unknown>();
  s.owner.dispatch = () => second.promise;
  const late = router.dispatch(s.request());
  await router.close(); second.resolve(page);
  await assert.rejects(late, code('STALE_SNAPSHOT'));
  assert.equal(s.counts.closes, 0);
});

test('导出身份错配与坏版本在启动前拒绝，绑定来源未就绪时不boot它', async t => {
  const f = spawnFake(t), s = source();
  const get = s.owner.getCollectionSnapshotVersion;
  s.owner.getCollectionSnapshotVersion = () => { throw new Error('来源尚未boot'); };
  await assert.rejects(createRustReadonlyCollectionRouter({ binary, owner: s.owner }));
  s.owner.getCollectionSnapshotVersion = get;
  const router = await createRustReadonlyCollectionRouter({ binary, owner: s.owner });
  s.owner.exportVersionedCollectionSnapshot = async () => ({
    snapshot: { epoch: s.version.epoch, datasetId: randomUUID(), snapshotId: randomUUID(), models: [] }, version: s.version,
  });
  await assert.rejects(router.refresh(), code('SCOPE_MISMATCH'));
  assert.equal(f.spawn.mock.callCount(), 0);
  assert.equal(router.getStatus().errorCode, 'SCOPE_MISMATCH');
  await router.close();
  assert.equal(s.counts.boots, 0);
});

test('旧child关闭失败可观察且阻止候选spawn，close也保留失败', async t => {
  const s = source(), f = spawnFake(t, (frame, respond) => {
    if (frame.operation === 'close') respond({ result: '坏关闭回执' }); else respond();
  });
  const router = await createRustReadonlyCollectionRouter({ binary, owner: s.owner });
  await router.refresh();
  await assert.rejects(router.refresh(), code('PROTOCOL_ERROR'));
  assert.equal(f.spawn.mock.callCount(), 1);
  assert.equal(router.getStatus().errorCode, 'PROTOCOL_ERROR');
  await assert.rejects(router.refresh(), code('PROTOCOL_ERROR'));
  assert.equal(f.spawn.mock.callCount(), 1);
  await assert.rejects(router.close(), code('PROTOCOL_ERROR'));
  await until(() => f.live === 0);
});

test('已发Rust错误不以成功Node fallback掩盖', async t => {
  const s = source(), f = spawnFake(t, (frame, respond) => {
    if (frame.operation === 'dispatch') respond({ result: { ...page, total: 1 } }); else respond();
  });
  const router = await createRustReadonlyCollectionRouter({ binary, owner: s.owner });
  await router.refresh();
  await assert.rejects(router.dispatch(s.request()), code('PROTOCOL_ERROR'));
  assert.equal(s.requests.length, 0);
  assert.equal(f.frames.filter(frame => frame.operation === 'dispatch').length, 1);
  await assert.rejects(router.close(), code('PROTOCOL_ERROR'));
});

test('省略expectedDatasetId时Node与Rust仍可用，内部始终绑定初始库', async t => {
  const s = source(), f = spawnFake(t), router = await createRustReadonlyCollectionRouter({ binary, owner: s.owner });
  const request = s.request(); delete request.expectedDatasetId;
  assert.equal(await router.dispatch(request), page);
  assert.equal(s.requests[0]!.expectedDatasetId, s.version.datasetId);
  assert.equal(request.expectedDatasetId, undefined);
  await router.refresh();
  assert.deepEqual(await router.dispatch(request), page);
  const dispatched = f.frames.find(frame => frame.operation === 'dispatch')!;
  assert.equal((dispatched.payload as { request: IpcRequest }).request.expectedDatasetId, s.version.datasetId);
  await router.close();
});

test('调用前source epoch或datasetId变化拒绝固定库路由，不Node fallback', async t => {
  for (const field of ['epoch', 'datasetId'] as const) {
    await t.test(field, async context => {
      const s = source(), f = spawnFake(context), router = await createRustReadonlyCollectionRouter({ binary, owner: s.owner });
      await router.refresh();
      const request = s.request();
      s.version = { ...s.version, [field]: randomUUID() };
      await assert.rejects(router.dispatch(request), code('SCOPE_MISMATCH'));
      assert.equal(s.requests.length, 0);
      assert.equal(f.frames.filter(frame => frame.operation === 'dispatch').length, 0);
      assert.equal(router.getStatus().errorCode, 'SCOPE_MISMATCH');
      await router.close();
    });
  }
});

test('调用后source身份变化拒绝Rust结果，保留SCOPE_MISMATCH而不重放', async t => {
  const s = source(), f = spawnFake(t, (frame, respond) => {
    if (frame.operation === 'dispatch') s.version = { ...s.version, epoch: randomUUID() };
    respond();
  });
  const router = await createRustReadonlyCollectionRouter({ binary, owner: s.owner });
  await router.refresh();
  await assert.rejects(router.dispatch(s.request()), code('SCOPE_MISMATCH'));
  assert.equal(s.requests.length, 0);
  assert.equal(f.frames.filter(frame => frame.operation === 'dispatch').length, 1);
  await router.close();
});

test('已确认写入回执经过invalidate和close仍原样返回，不伪称读取失效', async () => {
  const s = source(), router = await createRustReadonlyCollectionRouter({ binary, owner: s.owner });
  const pending = deferred<unknown>(), receipt = { commandId: randomUUID(), outcome: 'committed' };
  s.owner.dispatch = () => pending.promise;
  const request = s.request({ command: 'collection.setPolicy', payload: { id: randomUUID(), collectorPolicy: 'normal' } });
  const write = router.dispatch(request);
  router.invalidate(); await router.close();
  pending.resolve(receipt);
  assert.equal(await write, receipt);
  assert.equal(s.counts.closes, 0);
});

test('固定options来源及binary pin拷贝，不受调用方绑定后替换影响', async t => {
  const s = source(), alternate = source(), f = spawnFake(t);
  const options = { binary: { ...binary }, owner: s.owner };
  const router = await createRustReadonlyCollectionRouter(options);
  options.owner = alternate.owner;
  options.binary.sha256 = '0'.repeat(64);
  options.binary.path = '/不应启动的程序';
  await router.refresh();
  assert.equal(router.getStatus().datasetId, s.version.datasetId);
  assert.deepEqual(await router.dispatch(s.request()), page);
  assert.equal(alternate.counts.exports, 0);
  assert.equal(alternate.requests.length, 0);
  assert.equal(f.spawn.mock.callCount(), 1);
  await router.close();
});

test('finalprobe在invalidate后迟到不能覆盖新generation，child只清理', async t => {
  const s = source(), f = spawnFake(t), held = deferred<DatasetCollectionSnapshotVersion>();
  let probes = 0;
  s.owner.getCollectionSnapshotVersion = () => {
    probes++;
    return f.frames.some(frame => frame.operation === 'commitBoot') ? held.promise : Promise.resolve(s.version);
  };
  const router = await createRustReadonlyCollectionRouter({ binary, owner: s.owner });
  const refresh = router.refresh();
  await until(() => probes === 3);
  assert.equal(f.spawn.mock.callCount(), 1);
  assert.equal(f.frames.filter(frame => frame.operation === 'commitBoot').length, 1);
  router.invalidate();
  const status = router.getStatus();
  held.resolve(s.version);
  await assert.rejects(refresh, code('STALE_SNAPSHOT'));
  assert.deepEqual(router.getStatus(), status);
  await router.close();
  assert.equal(f.live, 0);
});

test('版本探测只接受封闭UUID版本，坏回执和私密异常不进入status', async t => {
  const s = source(), f = spawnFake(t), router = await createRustReadonlyCollectionRouter({ binary, owner: s.owner });
  await router.refresh();
  let getterCalled = false;
  const malformed = { epoch: s.version.epoch, datasetId: s.version.datasetId,
    get revision() { getterCalled = true; return '私密路径'; } };
  s.owner.getCollectionSnapshotVersion = async () => malformed;
  await assert.rejects(router.dispatch(s.request()), code('SNAPSHOT_UNAVAILABLE'));
  assert.equal(getterCalled, false);
  assert.equal(router.getStatus().errorCode, 'SNAPSHOT_UNAVAILABLE');
  assert.equal(JSON.stringify(router.getStatus()).includes('私密'), false);
  assert.equal(f.frames.filter(frame => frame.operation === 'dispatch').length, 0);
  await router.close();
});

test('已审定纯收藏读取detail/copy/photo只发Node，invalidate与close拒绝迟到结果', async t => {
  const commands: Partial<IpcRequest>[] = [
    { command: 'collection.detail', payload: { modelId: randomUUID(), page: { offset: 0, limit: 25 } } },
    { command: 'collection.copy', payload: { physicalId: randomUUID() } },
    { command: 'collection.photo', payload: { photoId: randomUUID() } },
  ];
  for (const entry of commands) {
    for (const action of ['invalidate', 'close'] as const) {
      await t.test(`${entry.command} / ${action}`, async context => {
        const s = source(), pending = deferred<unknown>(), f = spawnFake(context);
        const router = await createRustReadonlyCollectionRouter({ binary, owner: s.owner });
        const request = s.request(entry);
        let calls = 0;
        s.owner.dispatch = input => { calls++; assert.equal(input, request); return pending.promise; };
        const read = router.dispatch(request);
        await until(() => calls === 1);
        if (action === 'close') await router.close(); else router.invalidate();
        pending.resolve({ 合成读取: true });
        await assert.rejects(read, code('STALE_SNAPSHOT'));
        assert.equal(calls, 1);
        assert.equal(f.spawn.mock.callCount(), 0);
        await router.close();
      });
    }
  }
});
