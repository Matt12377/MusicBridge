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
const page = { items: [], total: 0, offset: 0, limit: 25, hasMore: false };
const code = (expected: string) => (error: unknown) => error instanceof RustSidecarError && error.code === expected;
const nodeReads: Partial<IpcRequest>[] = [
  { command: 'collection.detail', payload: { modelId: randomUUID(), page: { offset: 0, limit: 25 } } },
  { command: 'collection.copy', payload: { physicalId: 'MB-C-00001' } },
  { command: 'collection.photo', payload: { photoId: randomUUID() } },
  { command: 'referenceCatalog.sources', payload: { offset: 0, limit: 25 } },
  { command: 'referenceCatalog.history', payload: { bookId: randomUUID(), offset: 0, limit: 25 } },
  { command: 'referenceCatalog.revision', payload: { id: randomUUID() } },
];
const potentialWrite: Partial<IpcRequest> = { command: 'collection.setPolicy', payload: {
  commandId: randomUUID(), modelId: randomUUID(), expectedRevision: 1, collectorPolicy: 'normal', minimumSealedReserve: 0,
} };
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
  let probes = 0, exports = 0;
  const owner: DatasetOwnerVersionedSnapshotEndpoint = {
    async prepare() { throw new Error('借用已启动 Owner，不得再次 prepare。'); },
    async commitBoot() { throw new Error('借用已启动 Owner，不得再次 boot。'); },
    async close() { throw new Error('路由不得关闭来源 Owner。'); },
    async dispatch(request) { requests.push(request); return page; },
    async exportCollectionSnapshot() { throw new Error('不得调用非版本导出。'); },
    async getCollectionSnapshotVersion() { probes++; return { ...version }; },
    async exportVersionedCollectionSnapshot() {
      exports++;
      return { snapshot: { epoch: version.epoch, datasetId: version.datasetId, snapshotId: randomUUID(), models: [] }, version: { ...version } };
    },
  };
  return { owner, requests, get version() { return version; }, set version(next) { version = next; },
    get counts() { return { probes, exports }; },
    request(overrides: Partial<IpcRequest> = {}): IpcRequest {
      return { version: 1, id: randomUUID(), command: 'collection.list', payload: { page: { offset: 0, limit: 25 } },
        expectedDatasetId: version.datasetId, ...overrides };
    },
  };
}
type Frame = Record<string, unknown>;
// 复用既有路由测试的受控帧/child方式；不启动真实 Rust、账号或媒体操作。
function spawnFake(t: test.TestContext) {
  const frames: Frame[] = [], children: EventEmitter[] = [];
  let live = 0;
  const spawn = t.mock.method(childProcess, 'spawn', () => {
    const child = new EventEmitter(); children.push(child); live++;
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
        setImmediate(() => {
          const { payload: _payload, ...identity } = frame;
          const result = frame.operation === 'prepare' ? { epoch: frame.epoch, datasetId: frame.datasetId,
            snapshotId: frame.snapshotId, readOnly: true, capabilities: ['collection.list'], modelCount }
            : frame.operation === 'dispatch' ? page : null;
          stdout.write(JSON.stringify({ ...identity, ok: true, result }) + '\n');
          if (frame.operation === 'close') setImmediate(() => child.emit('close', 0, null));
        });
      }
      callback();
    } });
    return Object.assign(child, { stdin, stdout, stderr,
      kill() { setImmediate(() => child.emit('close', null, 'SIGKILL')); return true; },
    }) as unknown as ChildProcessWithoutNullStreams;
  });
  return { frames, children, spawn, get live() { return live; } };
}

for (const entry of nodeReads) {
  test(`${entry.command} 由Node读且保留就绪Rust、代际和child，后续列表仍有前后版本探测`, async t => {
    const s = source(), f = spawnFake(t), router = await createRustReadonlyCollectionRouter({ binary, owner: s.owner });
    t.after(() => router.close());
    await router.refresh();
    const status = router.getStatus(), child = f.children[0], counts = s.counts;
    const request = s.request(entry), value = { 合成读取: entry.command };
    let calls = 0;
    s.owner.dispatch = input => { calls++; assert.equal(input, request); return Promise.resolve(value); };
    assert.equal(await router.dispatch(request), value);
    assert.deepEqual(router.getStatus(), status);
    assert.deepEqual(s.counts, counts);
    assert.equal(calls, 1);
    assert.equal(f.children[0], child);
    assert.equal(f.live, 1);
    assert.equal(f.frames.filter(frame => frame.operation === 'close' || frame.operation === 'dispatch').length, 0);
    assert.deepEqual(await router.dispatch(s.request()), page);
    assert.equal(s.counts.probes - counts.probes, 2);
    assert.equal(calls, 1);
    assert.equal(f.spawn.mock.callCount(), 1);
    assert.equal(f.frames.filter(frame => frame.operation === 'dispatch').length, 1);
    await router.close();
    assert.equal(f.live, 0);
  });

  for (const failure of ['同步', '异步'] as const) {
    test(`${entry.command} ${failure}原Node错误保持对象身份且不撤销Rust`, async t => {
      const s = source(), f = spawnFake(t), router = await createRustReadonlyCollectionRouter({ binary, owner: s.owner });
      t.after(() => router.close());
      await router.refresh();
      const status = router.getStatus(), error = Object.assign(new Error('合成原始读取错误'), { code: 'DOMAIN_READ_FAILURE' });
      let calls = 0;
      s.owner.dispatch = () => { calls++; if (failure === '同步') throw error; return Promise.reject(error); };
      await assert.rejects(router.dispatch(s.request(entry)), value => value === error);
      assert.deepEqual(router.getStatus(), status);
      assert.equal(calls, 1);
      assert.equal(f.live, 1);
      assert.equal(f.frames.filter(frame => frame.operation === 'close' || frame.operation === 'dispatch').length, 0);
    });
  }

  test(`${entry.command} 作用域不符在Node之前拒绝，省略作用域仍绑定当前库`, async t => {
    const s = source(), f = spawnFake(t), router = await createRustReadonlyCollectionRouter({ binary, owner: s.owner });
    t.after(() => router.close());
    await router.refresh();
    const status = router.getStatus();
    await assert.rejects(router.dispatch(s.request({ ...entry, expectedDatasetId: randomUUID() })), code('SCOPE_MISMATCH'));
    assert.equal(s.requests.length, 0);
    const { expectedDatasetId: _scope, ...request } = s.request(entry);
    assert.equal(await router.dispatch(request), page);
    assert.deepEqual(s.requests, [{ ...request, expectedDatasetId: s.version.datasetId }]);
    assert.deepEqual(router.getStatus(), status);
    assert.equal(f.live, 1);
  });

  for (const action of ['写入', '刷新', '失效', '关闭'] as const) {
    for (const outcome of ['成功', '错误'] as const) {
      test(`${entry.command} 在${action}后迟到${outcome}受代际围栏保护`, async t => {
        const s = source(), f = spawnFake(t), pending = deferred<unknown>();
        const router = await createRustReadonlyCollectionRouter({ binary, owner: s.owner });
        t.after(() => router.close());
        await router.refresh();
        let calls = 0;
        s.owner.dispatch = () => { calls++; return pending.promise; };
        const read = router.dispatch(s.request(entry));
        const rejected = assert.rejects(read, code('STALE_SNAPSHOT'));
        await until(() => calls === 1);
        if (action === '写入') {
          const receipt = { commandId: randomUUID(), outcome: 'committed' };
          s.owner.dispatch = async () => { calls++; return receipt; };
          assert.equal(await router.dispatch(s.request(potentialWrite)), receipt);
        } else if (action === '刷新') await router.refresh();
        else if (action === '失效') router.invalidate();
        else await router.close();
        const status = router.getStatus();
        if (outcome === '成功') pending.resolve({ 合成读取: true });
        else pending.reject(new Error('旧代际原读取错误'));
        await rejected;
        assert.deepEqual(router.getStatus(), status);
        assert.equal(calls, action === '写入' ? 2 : 1);
        assert.equal(f.frames.filter(frame => frame.operation === 'dispatch').length, 0);
        assert.equal(f.spawn.mock.callCount(), action === '刷新' ? 2 : 1);
      });
    }
  }
}

test('六条Node纯读并发及乱序回执互不撤销，始终保留同一Rust快照', async t => {
  const s = source(), f = spawnFake(t), router = await createRustReadonlyCollectionRouter({ binary, owner: s.owner });
  t.after(() => router.close());
  await router.refresh();
  const status = router.getStatus(), waiting = nodeReads.map(() => deferred<unknown>());
  let calls = 0;
  s.owner.dispatch = () => waiting[calls++]!.promise;
  const reads = nodeReads.map(entry => router.dispatch(s.request(entry)));
  await until(() => calls === nodeReads.length);
  assert.deepEqual(router.getStatus(), status);
  for (let index = waiting.length - 1; index >= 0; index--) {
    const value = { 合成读取序号: index };
    waiting[index]!.resolve(value);
    assert.equal(await reads[index], value);
    assert.deepEqual(router.getStatus(), status);
  }
  assert.equal(f.live, 1);
  assert.equal(f.spawn.mock.callCount(), 1);
  assert.equal(f.frames.filter(frame => frame.operation === 'close' || frame.operation === 'dispatch').length, 0);
});

for (const stage of ['调用前', '交付前'] as const) {
  test(`混合Node纯读后列表${stage}版本变化仍撤销旧Rust，不绕过版本探测`, async t => {
    const s = source(), f = spawnFake(t), router = await createRustReadonlyCollectionRouter({ binary, owner: s.owner });
    t.after(() => router.close());
    await router.refresh();
    for (const entry of nodeReads) assert.equal(await router.dispatch(s.request(entry)), page);
    const probes = s.counts.probes;
    if (stage === '调用前') s.version = { ...s.version, revision: randomUUID() };
    else {
      const original = s.owner.getCollectionSnapshotVersion;
      s.owner.getCollectionSnapshotVersion = async () => {
        if (s.counts.probes === probes + 1) s.version = { ...s.version, revision: randomUUID() };
        return original();
      };
    }
    const list = router.dispatch(s.request());
    if (stage === '调用前') assert.equal(await list, page);
    else await assert.rejects(list, code('STALE_SNAPSHOT'));
    assert.equal(router.getStatus().phase, 'stale');
    assert.equal(s.counts.probes - probes, stage === '调用前' ? 1 : 2);
    assert.equal(s.requests.filter(request => request.command === 'collection.list').length, stage === '调用前' ? 1 : 0);
    assert.equal(f.frames.filter(frame => frame.operation === 'dispatch').length, stage === '调用前' ? 0 : 1);
  });
}

for (const entry of [
  potentialWrite,
  { command: 'referenceCatalog.source', payload: { id: randomUUID() } },
  { command: 'referenceCatalog.previewRevision', payload: { sourceId: randomUUID(), expectedCurrentRevisionId: null, items: [], mappings: [] } },
  { command: 'collectionProgress.current', payload: {} },
] as Partial<IpcRequest>[]) {
  for (const outcome of ['成功', '未知'] as const) {
    test(`闭集外${entry.command}仍保守撤销，${outcome}原回执在关闭后保留且不重放`, async t => {
      const s = source(), f = spawnFake(t), pending = deferred<unknown>();
      const router = await createRustReadonlyCollectionRouter({ binary, owner: s.owner });
      t.after(() => router.close());
      await router.refresh();
      const before = router.getStatus(), request = s.request(entry);
      const receipt = { commandId: request.id, outcome: 'committed' };
      const error = Object.assign(new Error('合成未知写入结果'), { code: 'DATASET_WRITE_UNKNOWN', commandId: request.id });
      let calls = 0;
      s.owner.dispatch = input => { calls++; assert.equal(input, request); return pending.promise; };
      const work = router.dispatch(request);
      const result = outcome === '未知' ? assert.rejects(work, value => value === error) : work;
      assert.equal(router.getStatus().phase, 'stale');
      assert.equal(router.getStatus().generation, before.generation + 1);
      assert.equal(router.getStatus().snapshotId, undefined);
      await until(() => calls === 1);
      await assert.rejects(router.refresh(), code('NOT_READY'));
      router.invalidate(); await router.close();
      if (outcome === '未知') pending.reject(error); else pending.resolve(receipt);
      if (outcome === '成功') assert.equal(await result, receipt); else await result;
      assert.equal(calls, 1);
      assert.equal(f.live, 0);
      assert.equal(f.spawn.mock.callCount(), 1);
      assert.equal(f.frames.filter(frame => frame.operation === 'dispatch').length, 0);
    });
  }
}
