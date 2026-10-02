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

const claimCommand: Partial<IpcRequest> = { command: 'recordingPrintWorker.claim', payload: { workerId: randomUUID() } };
const writeCommand: Partial<IpcRequest> = { command: 'collection.setPolicy', payload: {} };
const newReads: Partial<IpcRequest>[] = [
  { command: 'commandOutbox.context', payload: {} },
  { command: 'collectionProgress.modelLengths', payload: { modelId: randomUUID() } },
];
const readModes = ['旧Node纯读', '新Node纯读', '带上下文列表', 'Rust列表'] as const;
type ReadMode = typeof readModes[number];
function readRequest(s: ReturnType<typeof source>, mode: ReadMode) {
  return s.request(mode === '旧Node纯读' ? { command: 'collection.photo', payload: { photoId: randomUUID() } }
    : mode === '新Node纯读' ? newReads[0]
    : mode === '带上下文列表' ? { readContext: { deadlineAtMs: Date.now() + 5_000 } } : {});
}
function watched(work: Promise<unknown>) {
  const state: { settled: boolean; value?: unknown; error?: unknown } = { settled: false };
  const done = work.then(value => { state.settled = true; state.value = value; }, error => { state.settled = true; state.error = error; });
  return { state, done };
}
async function tick() { await new Promise<void>(resolve => setImmediate(resolve)); }
async function ready(t: test.TestContext) {
  const s = source(), f = spawnFake(t), router = await createRustReadonlyCollectionRouter({ binary, owner: s.owner });
  t.after(() => router.close());
  await router.refresh();
  return { s, f, router };
}

for (const entry of newReads) {
  for (const fails of [false, true]) test(`${entry.command} 精确Node读取${fails ? '原错误' : '成功'}保留Rust，下一列表仍双探测`, async t => {
    const { s, f, router } = await ready(t), status = router.getStatus(), value = new Error('合成原Node对象');
    const before = s.counts;
    let calls = 0;
    s.owner.dispatch = async () => { calls++; if (fails) throw value; return value; };
    if (fails) await assert.rejects(router.dispatch(s.request(entry)), error => error === value);
    else assert.equal(await router.dispatch(s.request(entry)), value);
    assert.deepEqual(router.getStatus(), status); assert.equal(calls, 1); assert.equal(f.live, 1);
    assert.deepEqual(await router.dispatch(s.request()), page);
    assert.equal(s.counts.probes - before.probes, 2); assert.equal(f.spawn.mock.callCount(), 1);
  });
  test(`${entry.command} scope拒绝与补全仍生效`, async t => {
    const { s, router } = await ready(t), status = router.getStatus();
    await assert.rejects(router.dispatch(s.request({ ...entry, expectedDatasetId: randomUUID() })), code('SCOPE_MISMATCH'));
    assert.equal(s.requests.length, 0);
    const request = s.request(entry); delete request.expectedDatasetId;
    await router.dispatch(request);
    assert.equal(s.requests[0]!.expectedDatasetId, s.version.datasetId); assert.deepEqual(router.getStatus(), status);
  });
}

test('严格空领取保留同一Rust候选，刷新全窗口阻挡，后续列表仍双版本探测', async t => {
  const { s, f, router } = await ready(t), status = router.getStatus(), nullReceipt = { lease: null };
  const held = deferred<unknown>(); let calls = 0;
  s.owner.dispatch = async request => { calls++; assert.equal(request.command, claimCommand.command); return held.promise; };
  const claim = router.dispatch(s.request(claimCommand));
  await assert.rejects(router.refresh(), code('NOT_READY')); await until(() => calls === 1);
  assert.deepEqual(router.getStatus(), status); held.resolve(nullReceipt);
  assert.equal(await claim, nullReceipt); assert.deepEqual(router.getStatus(), status); assert.equal(f.live, 1);
  const probes = s.counts.probes; assert.deepEqual(await router.dispatch(s.request()), page);
  assert.equal(s.counts.probes - probes, 2); assert.equal(calls, 1); assert.equal(f.spawn.mock.callCount(), 1);
});

for (const mode of readModes) {
  for (const outcome of ['空', '租约', 'unknown', '后探测失败'] as const) {
    test(`${mode} 回执已完成仍等领取证据窗口，${outcome}先判定再交付`, async t => {
      const { s, router } = await ready(t), held = deferred<unknown>(), original = new Error('合成读取原对象');
      const unknown = Object.assign(new Error('领取结果未知'), { code: 'DATASET_WRITE_UNKNOWN' });
      let claimCalls = 0;
      s.owner.dispatch = request => request.command === claimCommand.command ? (claimCalls++, held.promise) : Promise.resolve(original);
      const claim = watched(router.dispatch(s.request(claimCommand))); await until(() => claimCalls === 1);
      const read = watched(router.dispatch(readRequest(s, mode))); await tick(); await tick();
      assert.equal(read.state.settled, false, '读取结果不得越过待决领取窗口。');
      if (outcome === '后探测失败') s.owner.getCollectionSnapshotVersion = async () => { throw new Error('辅助探测失败'); };
      const receipt = outcome === '租约' ? { lease: { 合成租约: true } } : { lease: null };
      if (outcome === 'unknown') held.reject(unknown); else held.resolve(receipt);
      await claim.done; await read.done;
      if (outcome === '空') {
        assert.equal(read.state.error, undefined); assert.deepEqual(read.state.value, mode === 'Rust列表' ? page : original);
        assert.equal(router.getStatus().phase, 'rust');
      } else { assert.ok(code('STALE_SNAPSHOT')(read.state.error)); assert.equal(router.getStatus().phase, 'stale'); }
      if (outcome === 'unknown') assert.equal(claim.state.error, unknown); else assert.equal(claim.state.value, receipt);
      assert.equal(claimCalls, 1);
    });
  }
}

for (const mode of ['旧Node纯读', '新Node纯读', '带上下文列表'] as const) {
  test(`${mode} 原错误在空窗口收口后仍保持对象身份`, async t => {
    const { s, router } = await ready(t), held = deferred<unknown>(), original = new Error('原Node读取错误'); let calls = 0;
    s.owner.dispatch = request => request.command === claimCommand.command ? (calls++, held.promise) : Promise.reject(original);
    const claim = router.dispatch(s.request(claimCommand)); await until(() => calls === 1);
    const read = watched(router.dispatch(readRequest(s, mode))); await tick(); assert.equal(read.state.settled, false);
    held.resolve({ lease: null }); await claim; await read.done;
    assert.equal(read.state.error, original); assert.equal(router.getStatus().phase, 'rust');
  });
}

for (const action of ['失效', '关闭', '其他写'] as const) {
  test(`${action}立即唤醒读取，不等待挂起claim，迟到原领取回执不复活`, async t => {
    const { s, router } = await ready(t), held = deferred<unknown>(); let claims = 0;
    s.owner.dispatch = request => request.command === claimCommand.command ? (claims++, held.promise) : Promise.resolve(page);
    const claim = router.dispatch(s.request(claimCommand)); await until(() => claims === 1);
    const read = watched(router.dispatch(readRequest(s, '旧Node纯读'))); await tick(); assert.equal(read.state.settled, false);
    if (action === '关闭') await router.close(); else if (action === '失效') router.invalidate(); else await router.dispatch(s.request(writeCommand));
    await until(() => read.state.settled); assert.ok(code('STALE_SNAPSHOT')(read.state.error));
    const status = router.getStatus(), receipt = { lease: null }; held.resolve(receipt);
    assert.equal(await claim, receipt); assert.deepEqual(router.getStatus(), status); assert.equal(claims, 1);
  });
}

for (const probeStage of ['前', '后'] as const) {
  for (const failure of ['抛错', '版本变化', '作用域变化', '坏版本'] as const) {
    test(`${probeStage}探测${failure}保守撤销且辅助错误不覆盖原Node空回执`, async t => {
      const { s, router } = await ready(t), receipt = { lease: null }; let probes = 0, calls = 0;
      s.owner.dispatch = async () => { calls++; return receipt; };
      s.owner.getCollectionSnapshotVersion = async () => {
        probes++;
        if (probes === (probeStage === '前' ? 1 : 2)) {
          if (failure === '抛错') throw new Error('原辅助故障');
          if (failure === '版本变化') return { ...s.version, revision: randomUUID() };
          if (failure === '作用域变化') return { ...s.version, datasetId: randomUUID() };
          return { ...s.version, revision: '坏版本' };
        }
        return { ...s.version };
      };
      assert.equal(await router.dispatch(s.request(claimCommand)), receipt); assert.equal(calls, 1);
      assert.equal(router.getStatus().phase, 'stale');
      assert.equal(probes, probeStage === '前' ? 1 : 2);
      s.owner.getCollectionSnapshotVersion = async () => ({ ...s.version });
      await router.refresh(); assert.equal(router.getStatus().phase, 'rust');
    });
  }
}

const malformedReceipts: [string, () => unknown][] = [
  ['缺字段', () => ({})], ['undefined', () => ({ lease: undefined })], ['多字段', () => ({ lease: null, extra: true })],
  ['数组', () => []], ['异常原型', () => Object.create({ lease: null })],
  ['symbol', () => ({ lease: null, [Symbol('额外字段')]: true })],
  ['accessor', () => Object.defineProperty({}, 'lease', { enumerable: true, get() { throw new Error('不得读取getter'); } })],
];
for (const [name, make] of malformedReceipts) test(`领取${name}不满足strict null，保持原回执且不读取getter`, async t => {
  const { s, router } = await ready(t), value = make(); let calls = 0;
  s.owner.dispatch = async () => { calls++; return value; };
  assert.equal(await router.dispatch(s.request(claimCommand)), value); assert.equal(calls, 1); assert.equal(router.getStatus().phase, 'stale');
});

test('没有活动Rust的claim沿用单次Node原错误，没有辅助版本探测', async t => {
  const s = source(), f = spawnFake(t), router = await createRustReadonlyCollectionRouter({ binary, owner: s.owner });
  t.after(() => router.close()); const probes = s.counts.probes, original = new Error('原Node失败'); let calls = 0;
  s.owner.dispatch = () => { calls++; throw original; };
  await assert.rejects(router.dispatch(s.request(claimCommand)), error => error === original);
  assert.equal(calls, 1); assert.equal(s.counts.probes, probes); assert.equal(f.spawn.mock.callCount(), 0);
});

test('重叠空窗口须全部归零才放行，随后新窗口不能越过旧latch', async t => {
  const { s, router } = await ready(t), first = deferred<unknown>(), second = deferred<unknown>(), third = deferred<unknown>(); let claims = 0;
  s.owner.dispatch = request => request.command === claimCommand.command ? [first, second, third][claims++]!.promise : Promise.resolve(page);
  const a = router.dispatch(s.request(claimCommand)), b = router.dispatch(s.request(claimCommand)); await until(() => claims === 2);
  const read = watched(router.dispatch(readRequest(s, '旧Node纯读'))); await tick(); assert.equal(read.state.settled, false);
  first.resolve({ lease: null }); await a; await tick(); assert.equal(read.state.settled, false);
  await assert.rejects(router.refresh(), code('NOT_READY'));
  second.resolve({ lease: null }); await b; await read.done; assert.equal(read.state.value, page);
  const c = router.dispatch(s.request(claimCommand)); await until(() => claims === 3);
  const late = watched(router.dispatch(readRequest(s, '旧Node纯读'))); await tick(); assert.equal(late.state.settled, false);
  third.resolve({ lease: null }); await c; await late.done; assert.equal(late.state.value, page);
  assert.equal(router.getStatus().phase, 'rust'); await router.refresh(); assert.equal(router.getStatus().phase, 'rust');
});

test('真写发生后probe尚未完成，先完成的旧Node读取仍不能提前交付', async t => {
  const { s, router } = await ready(t), originalRead = deferred<unknown>(), after = deferred<DatasetCollectionSnapshotVersion>();
  let readCalls = 0, probes = 0, claims = 0;
  s.owner.dispatch = request => {
    if (request.command !== claimCommand.command) { readCalls++; return originalRead.promise; }
    claims++; s.version = { ...s.version, revision: randomUUID() }; return Promise.resolve({ lease: null });
  };
  const read = watched(router.dispatch(readRequest(s, '旧Node纯读'))); await until(() => readCalls === 1);
  s.owner.getCollectionSnapshotVersion = () => ++probes === 1 ? Promise.resolve({ ...s.version }) : after.promise;
  const claim = router.dispatch(s.request(claimCommand)); await until(() => probes === 2 && claims === 1);
  originalRead.resolve(page); await tick(); assert.equal(read.state.settled, false);
  after.resolve({ ...s.version }); await claim; await read.done;
  assert.ok(code('STALE_SNAPSHOT')(read.state.error)); assert.equal(claims, 1); assert.equal(router.getStatus().phase, 'stale');
});

for (const stage of ['前探测', 'Node', '后探测'] as const) test(`${stage}迟到条件窗口不覆盖失效代次，收口后可建立新child`, async t => {
  const { s, f, router } = await ready(t), heldVersion = deferred<DatasetCollectionSnapshotVersion>(), heldNode = deferred<unknown>();
  let probes = 0, calls = 0;
  s.owner.getCollectionSnapshotVersion = () => { probes++; return probes === (stage === '前探测' ? 1 : 2) && stage !== 'Node' ? heldVersion.promise : Promise.resolve({ ...s.version }); };
  s.owner.dispatch = () => { calls++; return stage === 'Node' ? heldNode.promise : Promise.resolve({ lease: null }); };
  const claim = router.dispatch(s.request(claimCommand));
  await until(() => stage === '前探测' ? probes === 1 : stage === 'Node' ? calls === 1 : probes === 2);
  router.invalidate(); const status = router.getStatus(); await assert.rejects(router.refresh(), code('NOT_READY'));
  heldVersion.resolve({ ...s.version }); heldNode.resolve({ lease: null }); await claim;
  assert.deepEqual(router.getStatus(), status); assert.equal(calls, 1);
  await router.refresh(); assert.equal(router.getStatus().phase, 'rust'); assert.equal(f.spawn.mock.callCount(), 2);
});

for (const command of ['collectionProgress.current', 'collectionProgress.capture', 'recordingPrintWorker.complete', 'recordingPrintWorker.fail'] as const) {
  test(`${command}仍在闭集外保守撤销且原回执不重放`, async t => {
    const { s, router } = await ready(t), receipt = { 原领域回执: command }; let calls = 0;
    s.owner.dispatch = async () => { calls++; return receipt; };
    assert.equal(await router.dispatch(s.request({ command, payload: {} })), receipt);
    assert.equal(router.getStatus().phase, 'stale'); assert.equal(calls, 1);
  });
}

test('重叠窗口有一次真租约就先撤销唤醒，另一个空窗口挂起仍挡刷新', async t => {
  const { s, router } = await ready(t), a = deferred<unknown>(), b = deferred<unknown>(); let calls = 0;
  s.owner.dispatch = request => request.command === claimCommand.command ? [a, b][calls++]!.promise : Promise.resolve(page);
  const first = router.dispatch(s.request(claimCommand)), second = router.dispatch(s.request(claimCommand));
  await until(() => calls === 2);
  const read = watched(router.dispatch(readRequest(s, '旧Node纯读'))); await tick(); assert.equal(read.state.settled, false);
  const lease = { lease: { 合成真实写回执: true } }; a.resolve(lease); assert.equal(await first, lease);
  await until(() => read.state.settled); assert.ok(code('STALE_SNAPSHOT')(read.state.error));
  await assert.rejects(router.refresh(), code('NOT_READY'));
  const status = router.getStatus(), empty = { lease: null }; b.resolve(empty);
  assert.equal(await second, empty); assert.deepEqual(router.getStatus(), status);
  await router.refresh(); assert.equal(router.getStatus().phase, 'rust');
});

for (const stage of ['前', '后'] as const) test(`${stage}探测超时仍原样交付Node回执，迟到版本不能撤销刷新后的新child`, async t => {
  const s = source(), f = spawnFake(t), held = deferred<DatasetCollectionSnapshotVersion>();
  const router = await createRustReadonlyCollectionRouter({ binary, owner: s.owner, requestTimeoutMs: 1_000 });
  t.after(() => router.close()); await router.refresh();
  let probes = 0, calls = 0;
  s.owner.getCollectionSnapshotVersion = () => ++probes === (stage === '前' ? 1 : 2) ? held.promise : Promise.resolve({ ...s.version });
  const receipt = { lease: null }; s.owner.dispatch = async () => { calls++; return receipt; };
  assert.equal(await router.dispatch(s.request(claimCommand)), receipt); assert.equal(calls, 1);
  assert.equal(router.getStatus().phase, 'stale');
  s.owner.getCollectionSnapshotVersion = async () => ({ ...s.version });
  await router.refresh(); const status = router.getStatus(); held.resolve({ ...s.version, revision: randomUUID() });
  await tick(); assert.deepEqual(router.getStatus(), status); assert.equal(f.spawn.mock.callCount(), 2); assert.equal(f.live, 1);
});

for (const stage of ['前探测', '后探测'] as const) test(`${stage}挂起时关闭唤醒读取，原Node错误仍可迟到交付`, async t => {
  const { s, router } = await ready(t), version = deferred<DatasetCollectionSnapshotVersion>();
  const node = deferred<unknown>(), error = Object.assign(new Error('原领取unknown'), { code: 'DATASET_WRITE_UNKNOWN' });
  let probes = 0, calls = 0;
  s.owner.getCollectionSnapshotVersion = () => ++probes === (stage === '前探测' ? 1 : 2) ? version.promise : Promise.resolve({ ...s.version });
  s.owner.dispatch = request => request.command === claimCommand.command ? (calls++, stage === '前探测' ? node.promise : Promise.resolve({ lease: null })) : Promise.resolve(page);
  const claim = watched(router.dispatch(s.request(claimCommand)));
  await until(() => probes === (stage === '前探测' ? 1 : 2));
  const read = watched(router.dispatch(readRequest(s, '旧Node纯读'))); await tick(); assert.equal(read.state.settled, false);
  await router.close(); await until(() => read.state.settled); assert.ok(code('STALE_SNAPSHOT')(read.state.error));
  const status = router.getStatus(); version.reject(new Error('迟到辅助故障')); if (stage === '前探测') node.reject(error);
  await claim.done;
  if (stage === '前探测') assert.equal(claim.state.error, error); else assert.deepEqual(claim.state.value, { lease: null });
  assert.equal(calls, 1); assert.deepEqual(router.getStatus(), status);
});

test('读取原错误先完成而真租约仍待决，先撤销后拒绝旧错误且不覆盖领取原对象', async t => {
  const { s, router } = await ready(t), held = deferred<unknown>(), original = new Error('旧Node错误'); let calls = 0;
  s.owner.dispatch = request => request.command === claimCommand.command ? (calls++, held.promise) : Promise.reject(original);
  const claim = router.dispatch(s.request(claimCommand)); await until(() => calls === 1);
  const read = watched(router.dispatch(readRequest(s, '带上下文列表'))); await tick(); assert.equal(read.state.settled, false);
  const receipt = { lease: { 合成写入: true } }; held.resolve(receipt); assert.equal(await claim, receipt);
  await read.done; assert.ok(code('STALE_SNAPSHOT')(read.state.error)); assert.notEqual(read.state.error, original);
});

test('Rust完整DTO错误保持协议失败可见，窗口内fatal仍立即撤销而无Node重放', async t => {
  const s = source(), held = deferred<unknown>(); let claims = 0;
  const f = spawnFake(t, (frame, respond) => {
    if (frame.operation === 'dispatch') respond({ result: { ...page, total: 1 } }); else respond();
  });
  const router = await createRustReadonlyCollectionRouter({ binary, owner: s.owner });
  t.after(() => router.close().catch(() => {})); await router.refresh();
  s.owner.dispatch = request => { assert.equal(request.command, claimCommand.command); claims++; return held.promise; };
  const claim = router.dispatch(s.request(claimCommand)); await until(() => claims === 1);
  await assert.rejects(router.dispatch(s.request()), code('PROTOCOL_ERROR'));
  assert.equal(router.getStatus().phase, 'failed'); const status = router.getStatus();
  const receipt = { lease: null }; held.resolve(receipt); assert.equal(await claim, receipt);
  assert.deepEqual(router.getStatus(), status); assert.equal(claims, 1);
  assert.equal(f.frames.filter(frame => frame.operation === 'dispatch').length, 1);
  await assert.rejects(router.close(), code('PROTOCOL_ERROR'));
});

for (const fails of [false, true]) test(`同微任务空窗口已收口后新领取准入，读取${fails ? '错误' : '成功'}不能使用已resolved的旧latch`, async t => {
  const { s, router } = await ready(t), a = deferred<unknown>(), b = deferred<unknown>(), pendingRead = deferred<unknown>();
  const original = new Error('原读取对象'); let calls = 0;
  s.owner.dispatch = request => request.command === claimCommand.command ? [a, b][calls++]!.promise : pendingRead.promise;
  const first = router.dispatch(s.request(claimCommand)); await until(() => calls === 1);
  const read = watched(router.dispatch(readRequest(s, '旧Node纯读')));
  a.resolve({ lease: null }); await first;
  // 同一微任务内先使读取可完成再同步登记新窗口，读取 continuation 尚未执行。
  if (fails) pendingRead.reject(original); else pendingRead.resolve(original);
  const second = router.dispatch(s.request(claimCommand));
  await until(() => calls === 2); await tick(); assert.equal(read.state.settled, false);
  b.resolve({ lease: null }); await second; await read.done;
  if (fails) assert.equal(read.state.error, original); else assert.equal(read.state.value, original);
  assert.equal(router.getStatus().phase, 'rust'); assert.equal(calls, 2);
});

test('claim scope在所有窗口之前拒绝，省略scope补固定库且null原型空回执可保留', async t => {
  const { s, router } = await ready(t), status = router.getStatus(), probes = s.counts.probes;
  await assert.rejects(router.dispatch(s.request({ ...claimCommand, expectedDatasetId: randomUUID() })), code('SCOPE_MISMATCH'));
  assert.equal(s.requests.length, 0); assert.equal(s.counts.probes, probes); assert.deepEqual(router.getStatus(), status);
  const receipt = Object.assign(Object.create(null) as Record<string, unknown>, { lease: null });
  s.owner.dispatch = async request => { s.requests.push(request); return receipt; };
  const request = s.request(claimCommand); delete request.expectedDatasetId;
  assert.equal(await router.dispatch(request), receipt); assert.equal(s.requests[0]!.expectedDatasetId, s.version.datasetId);
  assert.equal(s.requests.length, 1); assert.deepEqual(router.getStatus(), status);
});

for (const empty of [false, true]) test(`Proxy${empty ? '空回执' : '非空租约'}均不能作为空证明，lease get trap不执行`, async t => {
  const { s, router } = await ready(t), status = router.getStatus(); let gets = 0, calls = 0;
  const result = new Proxy({ lease: empty ? null : { 合成租约: true } }, { get(target, key, receiver) { if (key === 'lease') { gets++; return null; } return Reflect.get(target, key, receiver); } });
  s.owner.dispatch = async () => { calls++; return result; };
  assert.equal(await router.dispatch(s.request(claimCommand)), result); assert.equal(gets, 0); assert.equal(calls, 1);
  assert.equal(router.getStatus().phase, 'stale'); assert.equal(router.getStatus().generation, status.generation + 1);
});

test('Proxy反射伪造null描述符仍保守撤销，所有lease与反射trap均不执行且原回执不重放', async t => {
  const { s, router } = await ready(t); let calls = 0, descriptors = 0, keys = 0, prototypes = 0, leaseGets = 0;
  const result = new Proxy({ lease: { 合成非空租约: true } }, {
    getOwnPropertyDescriptor(target, key) { descriptors++; const descriptor = Reflect.getOwnPropertyDescriptor(target, key); return key === 'lease' ? { ...descriptor!, value: null } : descriptor; },
    ownKeys(target) { keys++; return Reflect.ownKeys(target); },
    getPrototypeOf(target) { prototypes++; return Reflect.getPrototypeOf(target); },
    // Promise可合法查询then；这里专门记录禁止触发的lease取值。
    get(target, key, receiver) { if (key === 'lease') leaseGets++; return Reflect.get(target, key, receiver); },
  });
  s.owner.dispatch = async () => { calls++; return result; };
  assert.equal(await router.dispatch(s.request(claimCommand)), result); assert.equal(calls, 1);
  assert.equal(router.getStatus().phase, 'stale'); assert.deepEqual({ descriptors, keys, prototypes, leaseGets }, { descriptors: 0, keys: 0, prototypes: 0, leaseGets: 0 });
});
