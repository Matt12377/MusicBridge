import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { IpcRequest } from '@music-bridge/contracts';
import type { DatasetCollectionSnapshotVersion, DatasetOwnerVersionedSnapshotEndpoint } from '../../src/collection/dataset-owner-protocol.js';
import { createOptionalRustReadonlyManager } from '../../src/rust-core/optional-readonly-manager.js';
import { createRustReadonlyCollectionRouter, type RustReadonlyCollectionRouter } from '../../src/rust-core/readonly-router.js';
import { RustSidecarError } from '../../src/rust-core/readonly-sidecar.js';

const binary = { path: process.execPath, sha256: createHash('sha256').update(readFileSync(process.execPath)).digest('hex') };
const stale = (error: unknown) => error instanceof RustSidecarError && error.code === 'STALE_SNAPSHOT';
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error('受控并发窗口未到达。');
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}
async function fixture(t: test.TestContext) {
  let version: DatasetCollectionSnapshotVersion = { epoch: randomUUID(), datasetId: randomUUID(), revision: randomUUID() };
  const originalPage = { items: [], offset: 0, limit: 1, total: 0, hasMore: false };
  const pendingRead = deferred<unknown>(), pendingClaims: ReturnType<typeof deferred<unknown>>[] = [];
  const calls = { read: 0, claim: 0, probe: 0, ownerClose: 0, write: 0 };
  let probeError: Error | undefined;
  const spawn = t.mock.method(childProcess, 'spawn', () => { throw new Error('容量拒绝不得建立 native。'); });
  const owner: DatasetOwnerVersionedSnapshotEndpoint = {
    async prepare() { return { epoch: version.epoch, datasetId: version.datasetId }; },
    async commitBoot() {}, async close() { calls.ownerClose++; },
    async getCollectionSnapshotVersion() { calls.probe++; if (probeError) throw probeError; return { ...version }; },
    async exportCollectionSnapshot() { throw new Error('不得使用无版本快照。'); },
    async exportVersionedCollectionSnapshot() { throw new RustSidecarError('CAPACITY_EXCEEDED'); },
    async dispatch(request) {
      if (request.command === 'collection.list') { calls.read++; return pendingRead.promise; }
      if (request.command === 'recordingPrintWorker.claim') {
        calls.claim++; const pending = deferred<unknown>(); pendingClaims.push(pending); return pending.promise;
      }
      calls.write++; return { 原Node写回执: true };
    },
  };
  let router!: RustReadonlyCollectionRouter;
  const manager = createOptionalRustReadonlyManager({
    createOptions: async () => ({ binary, snapshotProfile: 'v2-2000' }),
    createRouter: async options => { router = await createRustReadonlyCollectionRouter(options); return router; },
  });
  const endpoint = manager.decorate(owner);
  await endpoint.prepare(); await endpoint.commitBoot();
  assert.deepEqual(await manager.setEnabled(true), { schemaVersion: 1, enabled: true, mode: 'node', state: 'failed', errorCode: 'RUST_UNAVAILABLE' });
  t.after(() => endpoint.close());
  const initial = router.getStatus();
  const request = (command: IpcRequest['command'], payload: unknown): IpcRequest =>
    ({ version: 1, id: randomUUID(), command, payload, expectedDatasetId: version.datasetId });
  return { endpoint, manager, router, initial, calls, spawn, originalPage, pendingRead, pendingClaims,
    get version() { return version; }, set version(next) { version = next; },
    set probeError(next: Error | undefined) { probeError = next; },
    list: () => endpoint.dispatch(request('collection.list', { page: { offset: 0, limit: 1 }, filter: { stockState: 'needs-review' } })),
    claim: () => endpoint.dispatch(request('recordingPrintWorker.claim', { workerId: randomUUID() })),
    write: () => endpoint.dispatch(request('collection.setPolicy', { commandId: randomUUID(), modelId: randomUUID(), expectedRevision: 1, collectorPolicy: 'collector', minimumSealedReserve: 2 })),
  };
}

test('容量失败的普通ON保留原Node查询：空领取窗口完整版本未变，不能误拒绝并发needs-review', async t => {
  const f = await fixture(t), beforeProbes = f.calls.probe;
  let readSettled = false;
  const read = f.list(); void read.then(() => { readSettled = true; }, () => { readSettled = true; });
  await until(() => f.calls.read === 1);
  const claim = f.claim(); await until(() => f.calls.claim === 1);
  f.pendingRead.resolve(f.originalPage); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(readSettled, false, '原Node回执必须等完整领取窗口，不能提前放行。');
  const empty = { lease: null }; f.pendingClaims[0]!.resolve(empty);
  assert.equal(await claim, empty); assert.equal(await read, f.originalPage);
  assert.deepEqual(f.router.getStatus(), f.initial);
  assert.equal(f.manager.getStatus().state, 'failed'); assert.equal(f.manager.getStatus().mode, 'node');
  assert.equal(f.calls.probe - beforeProbes, 2); assert.equal(f.calls.claim, 1); assert.equal(f.calls.read, 1);
  assert.equal(f.spawn.mock.callCount(), 0);
});

for (const scenario of ['非空', 'getter', 'Proxy', '领取异常', '前探测异常', '后探测异常', 'revision改变', 'epoch改变', 'dataset改变'] as const) {
  test(`容量失败的原Node领取${scenario}仍撤销迟到查询，保留原领取回执`, async t => {
    const f = await fixture(t), read = f.list(), rejectedRead = assert.rejects(read, stale);
    await until(() => f.calls.read === 1);
    const originalError = new Error('受控原Node领取异常');
    if (scenario === '前探测异常') f.probeError = new Error('受控前探测异常');
    const claim = f.claim(), originalRejectedClaim = scenario === '领取异常' ? assert.rejects(claim, error => error === originalError) : undefined;
    await until(() => f.calls.claim === 1);
    let traps = 0;
    const value = scenario === '非空' ? { lease: { 原Node非空领取: true } }
      : scenario === 'getter' ? Object.defineProperty({}, 'lease', { enumerable: true, get() { traps++; return null; } })
      : scenario === 'Proxy' ? new Proxy({ lease: null }, { getOwnPropertyDescriptor(target, key) { traps++; return Reflect.getOwnPropertyDescriptor(target, key); } })
      : { lease: null };
    if (scenario === '后探测异常') f.probeError = new Error('受控后探测异常');
    if (scenario === 'revision改变') f.version = { ...f.version, revision: randomUUID() };
    if (scenario === 'epoch改变') f.version = { ...f.version, epoch: randomUUID() };
    if (scenario === 'dataset改变') f.version = { ...f.version, datasetId: randomUUID() };
    f.pendingRead.resolve(f.originalPage);
    if (originalRejectedClaim) { f.pendingClaims[0]!.reject(originalError); await originalRejectedClaim; }
    else { f.pendingClaims[0]!.resolve(value); assert.equal(await claim, value); }
    await rejectedRead;
    assert.equal(f.router.getStatus().phase, 'stale'); assert.ok(f.router.getStatus().generation > f.initial.generation);
    assert.equal(traps, 0, '领取保留判定不能调用getter或Proxy trap。');
    assert.equal(f.calls.claim, 1); assert.equal(f.calls.read, 1); assert.equal(f.spawn.mock.callCount(), 0);
  });
}

for (const action of ['失效', 'OFF', '关闭'] as const) {
  test(`容量失败空领取尚未完成时${action}立即撤权，晚到空领取不能恢复旧代`, async t => {
    const f = await fixture(t), read = f.list(), rejectedRead = assert.rejects(read, stale);
    await until(() => f.calls.read === 1);
    const claim = f.claim(); await until(() => f.calls.claim === 1);
    f.pendingRead.resolve(f.originalPage);
    if (action === '失效') f.router.invalidate();
    else if (action === 'OFF') await f.manager.setEnabled(false);
    else await f.endpoint.close();
    await rejectedRead; const after = f.router.getStatus();
    const empty = { lease: null }; f.pendingClaims[0]!.resolve(empty); assert.equal(await claim, empty);
    assert.deepEqual(f.router.getStatus(), after); assert.equal(f.spawn.mock.callCount(), 0);
    assert.equal(f.calls.ownerClose, action === '关闭' ? 1 : 0);
  });
}

test('容量失败双空领取都收口后才放行原Node查询，窗口不能互相代替', async t => {
  const f = await fixture(t), beforeProbes = f.calls.probe; let readSettled = false;
  const read = f.list(); void read.then(() => { readSettled = true; }, () => { readSettled = true; });
  await until(() => f.calls.read === 1);
  const first = f.claim(); await until(() => f.calls.claim === 1);
  const second = f.claim(); await until(() => f.calls.claim === 2);
  f.pendingRead.resolve(f.originalPage); f.pendingClaims[0]!.resolve({ lease: null }); await first;
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(readSettled, false);
  f.pendingClaims[1]!.resolve({ lease: null }); await second; assert.equal(await read, f.originalPage);
  assert.deepEqual(f.router.getStatus(), f.initial); assert.equal(f.calls.probe - beforeProbes, 4);
  assert.equal(f.calls.claim, 2); assert.equal(f.calls.read, 1); assert.equal(f.spawn.mock.callCount(), 0);
});

test('容量失败空领取完整证明后原Node查询错误保持对象身份，不吞原错误', async t => {
  const f = await fixture(t), originalError = new Error('受控原Node查询失败');
  const read = f.list(), rejectedRead = assert.rejects(read, error => error === originalError);
  await until(() => f.calls.read === 1); const claim = f.claim(); await until(() => f.calls.claim === 1);
  f.pendingRead.reject(originalError); f.pendingClaims[0]!.resolve({ lease: null }); await claim; await rejectedRead;
  assert.deepEqual(f.router.getStatus(), f.initial); assert.equal(f.calls.read, 1); assert.equal(f.calls.claim, 1);
  assert.equal(f.spawn.mock.callCount(), 0);
});

test('容量失败普通业务写入仍同步撤权，不能借空领取优化放行旧查询', async t => {
  const f = await fixture(t), read = f.list(), rejectedRead = assert.rejects(read, stale);
  await until(() => f.calls.read === 1);
  assert.deepEqual(await f.write(), { 原Node写回执: true }); f.pendingRead.resolve(f.originalPage); await rejectedRead;
  assert.equal(f.router.getStatus().phase, 'stale'); assert.equal(f.calls.write, 1); assert.equal(f.calls.claim, 0);
  assert.equal(f.spawn.mock.callCount(), 0);
});
