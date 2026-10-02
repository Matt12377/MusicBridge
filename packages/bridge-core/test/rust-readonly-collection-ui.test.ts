import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess, { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough, Writable } from 'node:stream';
import type { IpcRequest, CollectionModel } from '@music-bridge/contracts';
import type { DatasetCollectionSnapshotVersion, DatasetOwnerLargeSnapshotEndpoint } from '../src/collection/dataset-owner-protocol.js';
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
  const owner: DatasetOwnerLargeSnapshotEndpoint = {
    async exportLargeVersionedCollectionSnapshot() { return owner.exportVersionedCollectionSnapshot(); },
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
        if (frame.operation === 'prepare') modelCount = frame.protocolVersion === 3 ? Number((frame.payload as Frame).modelCount) : (frame.payload as { models: unknown[] }).models.length;
        const respond = (changes: Frame = {}) => {
          const { payload: _payload, ...identity } = frame;
          const result = frame.operation === 'prepare' ? { epoch: frame.epoch, datasetId: frame.datasetId, snapshotId: frame.snapshotId,
            readOnly: true, capabilities: ['collection.list'], modelCount: frame.protocolVersion === 3 ? 0 : modelCount, ...(frame.protocolVersion === 3 ? { expectedModelCount: modelCount } : {}) } : frame.operation === 'appendSnapshot' ? { chunkIndex: (frame.payload as Frame).chunkIndex, receivedModelCount: modelCount } : frame.operation === 'dispatch' ? page : null;
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


const reads: IpcRequest['command'][] = ['collectionProgress.current', 'collectionProgress.wants', 'collectionProgress.wantHistory', 'collectionProgress.snapshots', 'collectionProgress.snapshot', 'referenceCatalog.snapshot', 'referenceCatalog.source', 'referenceCatalog.sourceZipReceipts'];
const claim = { command: 'recordingPrintWorker.claim' as const, payload: { workerId: randomUUID() } };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function watch(work: Promise<unknown>) {
  const state: { settled: boolean; value?: unknown; error?: unknown } = { settled: false };
  const done = work.then(value => { state.settled = true; state.value = value; }, error => { state.settled = true; state.error = error; });
  return { state, done };
}
async function ready(t: test.TestContext) {
  const s = source(), f = spawnFake(t), router = await createRustReadonlyCollectionRouter({ binary, owner: s.owner });
  t.after(() => router.close()); await router.refresh(); return { s, f, router };
}
for (const command of reads) {
  for (const fails of [false, true]) test(`${command}热Node${fails ? '原错误' : '原成功'}保留候选且下一Rust列表仍双探测`, async t => {
    const { s, f, router } = await ready(t), status = router.getStatus(), original = new Error('原Node领域对象');
    let calls = 0; s.owner.dispatch = async () => { calls++; if (fails) throw original; return original; };
    if (fails) await assert.rejects(router.dispatch(s.request({ command, payload: {} })), error => error === original);
    else assert.equal(await router.dispatch(s.request({ command, payload: {} })), original);
    assert.equal(calls, 1); assert.deepEqual(router.getStatus(), status); assert.equal(f.live, 1);
    const probes = s.counts.probes; assert.deepEqual(await router.dispatch(s.request()), page);
    assert.equal(s.counts.probes - probes, 2); assert.equal(f.spawn.mock.callCount(), 1);
  });
  test(`${command}错误scope先拒绝且省略scope按固定Owner补全`, async t => {
    const { s, router } = await ready(t); let calls = 0;
    s.owner.dispatch = async request => { calls++; assert.equal(request.expectedDatasetId, s.version.datasetId); return page; };
    await assert.rejects(router.dispatch(s.request({ command, expectedDatasetId: randomUUID() })), code('SCOPE_MISMATCH')); assert.equal(calls, 0);
    const request = s.request({ command }); delete request.expectedDatasetId;
    await router.dispatch(request); assert.equal(calls, 1); assert.equal(router.getStatus().phase, 'rust');
  });
}
for (const action of ['写', 'refresh', 'invalidate', 'close'] as const) for (const fails of [false, true]) test(`新增并发Node读${fails ? '错误' : '成功'}迟到遇${action}仍有围栏`, async t => {
  const { s, router } = await ready(t), pending = deferred<unknown>(), original = new Error('迟到原错');
  s.owner.dispatch = async request => request.command === 'collectionProgress.current' ? pending.promise : { 写: true };
  const read = watch(router.dispatch(s.request({ command: 'collectionProgress.current' })));
  await tick();
  if (action === '写') await router.dispatch(s.request({ command: 'collection.setPolicy' }));
  else if (action === 'refresh') await router.refresh(); else if (action === 'invalidate') router.invalidate(); else await router.close();
  if (fails) pending.reject(original); else pending.resolve(page);
  await read.done; assert.ok(code('STALE_SNAPSHOT')(read.state.error));
});

type Stage = '导出前' | '导出后' | '上传中' | 'boot后发布前';
async function refreshing(t: test.TestContext, stage: Stage, startupTimeoutMs = 2000) {
  const s = source(), reached = deferred<void>(), release = deferred<void>();
  const originalExport = s.owner.exportVersionedCollectionSnapshot;
  s.owner.exportVersionedCollectionSnapshot = async () => {
    const exported = await originalExport();
    if (stage === '上传中') return { ...exported, snapshot: { ...exported.snapshot, models: [{ id: randomUUID(), brand: '合成牌', name: '上传型号', edition: '初版', year: 1990, format: 'cassette', tapeType: 'II', identification: 'verified', collectorPolicy: 'normal', minimumSealedReserve: 0, revision: 1, lengths: [60], counts: { total: 1, sealedBlank: 1, openedBlank: 0, legacyUsed: 0, recorded: 0, reserved: 0, unavailable: 0, unknown: 0 } } as CollectionModel] } };
    return exported;
  };
  s.owner.exportLargeVersionedCollectionSnapshot = s.owner.exportVersionedCollectionSnapshot;
  const heldOperation = stage === '上传中' ? 'appendSnapshot' : stage === 'boot后发布前' ? 'commitBoot' : 'prepare';
  const f = spawnFake(t, (frame, respond) => {
    if (stage !== '导出前' && frame.operation === heldOperation) {
      reached.resolve(); void release.promise.then(() => respond());
    } else respond();
  });
  const router = await createRustReadonlyCollectionRouter({ binary, owner: s.owner, startupTimeoutMs, ...(stage === '上传中' ? { snapshotProfile: 'v3-5000' as const } : {}) });
  if (stage === '导出前') {
    const probe = s.owner.getCollectionSnapshotVersion; let calls = 0;
    s.owner.getCollectionSnapshotVersion = async () => { if (++calls === 1) { reached.resolve(); await release.promise; } return probe(); };
  }
  let expectedCleanupFailure = false;
  t.after(async () => { if (expectedCleanupFailure) await assert.rejects(router.close(), code('PROCESS_EXIT')); else await router.close(); });
  const refresh = watch(router.refresh()); await reached.promise;
  return { s, f, router, release, refresh, expectFatalCleanup() { expectedCleanupFailure = true; } };
}
for (const stage of ['导出前', '导出后', '上传中', 'boot后发布前'] as const) test(`${stage}空claim双版本收口前不得发布或交付Node读`, async t => {
  const { s, f, router, release, refresh } = await refreshing(t, stage), original = { lease: null }, pending = deferred<unknown>();
  const generation = router.getStatus().generation; let calls = 0;
  s.owner.dispatch = async request => { if (request.command === claim.command) { calls++; return pending.promise; } return page; };
  const poll = watch(router.dispatch(s.request(claim))); await until(() => calls === 1);
  const read = watch(router.dispatch(s.request({ command: 'collectionProgress.current' })));
  release.resolve(); await tick(); await tick(); assert.equal(refresh.state.settled, false); assert.equal(read.state.settled, false);
  pending.resolve(original); await poll.done; assert.equal(poll.state.value, original); await refresh.done; await read.done;
  assert.equal(refresh.state.error, undefined); assert.equal(read.state.error, undefined); assert.equal(router.getStatus().phase, 'rust'); assert.equal(router.getStatus().generation, generation);
  assert.equal(calls, 1); assert.equal(f.peak, 1);
  if (stage === '上传中') assert.ok(f.frames.some(frame => frame.operation === 'appendSnapshot'));
  else assert.deepEqual(await router.dispatch(s.request()), page);
});
for (const outcome of ['真lease', '原错误', 'unknown', '版本变化', 'scope变化', '前probe失败', '后probe失败', 'Proxy', 'getter'] as const) test(`刷新窗口${outcome}保守撤销且Node一次原回执`, async t => {
  const { s, router, release, refresh } = await refreshing(t, '导出后'); const pending = deferred<unknown>();
  const originalError = Object.assign(new Error('原claim异常'), { code: outcome === 'unknown' ? 'DATASET_WRITE_UNKNOWN' : '领域异常' });
  let calls = 0, gets = 0; const original = outcome === '真lease' ? { lease: { id: randomUUID() } } : outcome === 'Proxy' ? new Proxy({ lease: null }, { get(target, key) { if (key === 'lease') gets++; return Reflect.get(target, key); } }) : outcome === 'getter' ? Object.defineProperty({}, 'lease', { enumerable: true, get() { gets++; return null; } }) : { lease: null };
  const probe = s.owner.getCollectionSnapshotVersion; let probes = 0;
  s.owner.getCollectionSnapshotVersion = async () => { probes++; if ((outcome === '前probe失败' && probes === 1) || (outcome === '后probe失败' && probes === 2)) throw new Error('辅助探测失败'); return probe(); };
  s.owner.dispatch = async () => { calls++; return pending.promise; };
  const poll = watch(router.dispatch(s.request(claim))); await until(() => calls === 1);
  if (outcome === '版本变化') s.version = { ...s.version, revision: randomUUID() }; if (outcome === 'scope变化') s.version = { ...s.version, epoch: randomUUID() };
  if (outcome === '原错误' || outcome === 'unknown') pending.reject(originalError); else pending.resolve(original);
  await poll.done; release.resolve(); await refresh.done;
  assert.equal(calls, 1); assert.equal(gets, 0); if (outcome === '原错误' || outcome === 'unknown') assert.equal(poll.state.error, originalError); else assert.equal(poll.state.value, original);
  assert.ok(refresh.state.error instanceof RustSidecarError); assert.notEqual(router.getStatus().phase, 'rust');
});
for (const action of ['close', 'invalidate', '写'] as const) test(`刷新挂起claim遇${action}即时唤醒等待读且迟到不复活`, async t => {
  const { s, router, release, refresh } = await refreshing(t, '导出后'), pending = deferred<unknown>(); let calls = 0;
  s.owner.dispatch = async request => request.command === claim.command ? (calls++, pending.promise) : page;
  const poll = watch(router.dispatch(s.request(claim))); await until(() => calls === 1);
  const read = watch(router.dispatch(s.request({ command: 'collectionProgress.wants' }))); await tick(); assert.equal(read.state.settled, false);
  const close = action === 'close' ? watch(router.close()) : undefined;
  if (action === 'invalidate') router.invalidate(); if (action === '写') await router.dispatch(s.request({ command: 'collection.setPolicy' }));
  await until(() => read.state.settled); assert.ok(code('STALE_SNAPSHOT')(read.state.error)); const generation = router.getStatus().generation;
  release.resolve(); await refresh.done; pending.resolve({ lease: null }); await poll.done; await close?.done;
  assert.equal(router.getStatus().generation, generation); assert.notEqual(router.getStatus().phase, 'rust');
});
test('刷新多claim窗口须全部关闭，旧latch唤醒不能越新窗口', async t => {
  const { s, router, release, refresh } = await refreshing(t, '导出后'), one = deferred<unknown>(), two = deferred<unknown>(); let calls = 0;
  s.owner.dispatch = async request => request.command === claim.command ? (++calls === 1 ? one.promise : two.promise) : page;
  const first = watch(router.dispatch(s.request(claim))); await until(() => calls === 1);
  release.resolve(); await tick(); one.resolve({ lease: null });
  const second = watch(router.dispatch(s.request(claim))); await until(() => calls === 2);
  await first.done; await tick(); assert.equal(refresh.state.settled, false);
  two.resolve({ lease: null }); await second.done; await refresh.done; assert.equal(refresh.state.error, undefined); assert.equal(router.getStatus().phase, 'rust');
});
test('刷新窗口等待沿原整体期限超时，晚claim不重置或发布旧代', async t => {
  const { s, router, release, refresh } = await refreshing(t, '导出后', 500), pending = deferred<unknown>(); let calls = 0;
  s.owner.dispatch = async () => { calls++; return pending.promise; };
  const poll = watch(router.dispatch(s.request(claim))); await until(() => calls === 1); release.resolve();
  await refresh.done; assert.ok(code('TIMEOUT')(refresh.state.error)); const generation = router.getStatus().generation;
  pending.resolve({ lease: null }); await poll.done; assert.equal(router.getStatus().generation, generation); assert.equal(router.getStatus().phase, 'failed');
});

for (const fails of [false, true]) test(`刷新空claim阻止Node${fails ? '原错误' : '成功'}提前交付，收口后身份不变`, async t => {
  const { s, router, release, refresh } = await refreshing(t, '导出后'), pending = deferred<unknown>(), original = new Error('纯读原对象'); let calls = 0;
  s.owner.dispatch = async request => { if (request.command === claim.command) { calls++; return pending.promise; } if (fails) throw original; return original; };
  const poll = watch(router.dispatch(s.request(claim))); await until(() => calls === 1);
  const read = watch(router.dispatch(s.request({ command: 'collectionProgress.current' })));
  release.resolve(); await tick(); assert.equal(read.state.settled, false); assert.equal(refresh.state.settled, false);
  pending.resolve({ lease: null }); await poll.done; await read.done; await refresh.done;
  if (fails) assert.equal(read.state.error, original); else assert.equal(read.state.value, original);
  assert.equal(refresh.state.error, undefined);
});
test('最终probe已返回时同微任务新claim仍阻止refresh同步发布', async t => {
  const { s, router, release, refresh } = await refreshing(t, 'boot后发布前'), pending = deferred<unknown>(); let calls = 0, started = false;
  s.owner.dispatch = async request => { if (request.command === claim.command) { calls++; return pending.promise; } return page; };
  const probe = s.owner.getCollectionSnapshotVersion; let poll: ReturnType<typeof watch> | undefined;
  s.owner.getCollectionSnapshotVersion = async () => {
    const version = await probe();
    if (!started) { started = true; queueMicrotask(() => { poll = watch(router.dispatch(s.request(claim))); }); }
    return version;
  };
  release.resolve(); await until(() => calls === 1); await tick(); assert.equal(refresh.state.settled, false);
  pending.resolve({ lease: null }); await until(() => !!poll); await poll!.done; await refresh.done;
  assert.equal(refresh.state.error, undefined); assert.equal(router.getStatus().phase, 'rust');
});
test('刷新child fatal立即唤醒领取窗内纯读，晚claim不遮蔽原回执', async t => {
  const { s, f, router, release, refresh, expectFatalCleanup } = await refreshing(t, 'boot后发布前'), pending = deferred<unknown>(); let calls = 0;
  s.owner.dispatch = async request => request.command === claim.command ? (calls++, pending.promise) : page;
  const poll = watch(router.dispatch(s.request(claim))); await until(() => calls === 1);
  const read = watch(router.dispatch(s.request({ command: 'referenceCatalog.source' }))); await tick(); assert.equal(read.state.settled, false);
  expectFatalCleanup(); f.children[0]!.emit('close', 19, null); await until(() => read.state.settled);
  assert.ok(code('STALE_SNAPSHOT')(read.state.error)); release.resolve(); await refresh.done;
  assert.ok(code('PROCESS_EXIT')(refresh.state.error)); const generation = router.getStatus().generation;
  const receipt = { lease: null }; pending.resolve(receipt); await poll.done;
  assert.equal(poll.state.value, receipt); assert.equal(router.getStatus().generation, generation); assert.equal(router.getStatus().phase, 'failed');
});
test('旧窗口invalidate后迟到不能拖住新代Node读或改变新代状态', async t => {
  const { s, router, release, refresh } = await refreshing(t, '导出后'), pending = deferred<unknown>(); let calls = 0;
  s.owner.dispatch = async request => request.command === claim.command ? (calls++, pending.promise) : page;
  const poll = watch(router.dispatch(s.request(claim))); await until(() => calls === 1); router.invalidate(); release.resolve(); await refresh.done;
  const generation = router.getStatus().generation;
  const read = watch(router.dispatch(s.request({ command: 'collectionProgress.snapshot' })));
  await until(() => read.state.settled); assert.equal(read.state.error, undefined);
  pending.resolve({ lease: null }); await poll.done; assert.equal(router.getStatus().generation, generation);
});
