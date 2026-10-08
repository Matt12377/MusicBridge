import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess, { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough, Writable } from 'node:stream';
import type { CollectionModel, IpcRequest } from '@music-bridge/contracts';
import type { DatasetOwnerLargeSnapshotEndpoint } from '../src/collection/dataset-owner-protocol.js';
import { createRustReadonlyDatasetEndpoint, createRustReadonlyDatasetEndpointFromOwner, RUST_LARGE_SNAPSHOT_LIMITS,
  RUST_SIDECAR_LIMITS, RustSidecarError, type RustReadonlySnapshot, type RustSnapshotProfile } from '../src/rust-core/readonly-sidecar.js';
import { createRustReadonlyCollectionRouter } from '../src/rust-core/readonly-router.js';
import { filterCollectionSnapshot } from '../src/rust-core/collection-query.js';

const binary = { path: process.execPath, sha256: createHash('sha256').update(readFileSync(process.execPath)).digest('hex') };
const code = (expected: string) => (error: unknown) => error instanceof RustSidecarError && error.code === expected;
function model(): CollectionModel {
  return { id: randomUUID(), brand: '合成牌', name: '只读型号', edition: '初版', year: 1990, format: 'cassette',
    tapeType: 'II', identification: 'verified', collectorPolicy: 'normal', minimumSealedReserve: 0, revision: 1,
    lengths: [60, null], counts: { total: 1, sealedBlank: 1, openedBlank: 0, legacyUsed: 0, recorded: 0,
      reserved: 0, unavailable: 0, unknown: 0 } };
}
function snapshot(count = 1): RustReadonlySnapshot {
  return { epoch: randomUUID(), datasetId: randomUUID(), snapshotId: randomUUID(), models: Array.from({ length: count }, model) };
}
function request(s: RustReadonlySnapshot, offset = 0, filter?: { query: string }): IpcRequest {
  return { version: 1, id: randomUUID(), command: 'collection.list', expectedDatasetId: s.datasetId,
    payload: { page: { offset, limit: 100 }, ...(filter ? { filter } : {}) } };
}
async function until(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (!check()) {
    if (performance.now() >= deadline) throw new Error('受控状态未及时到达。');
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}
type Frame = Record<string, unknown> & { payload: Record<string, unknown> };
function fake(t: test.TestContext, behavior: (frame: Frame, respond: (changes?: Record<string, unknown>) => void) => void = (_f, respond) => respond(), holdExit = false) {
  const frames: Frame[] = [], bytes: number[] = [], children: EventEmitter[] = [], stdout: PassThrough[] = [];
  let live = 0, peak = 0, kills = 0;
  const killExits: (() => void)[] = [];
  const spawn = t.mock.method(childProcess, 'spawn', () => {
    const child = new EventEmitter(), out = new PassThrough(), stderr = new PassThrough();
    children.push(child); stdout.push(out); live++; peak = Math.max(peak, live);
    let models: CollectionModel[] = [], expected = 0, exited = false;
    child.on('close', () => { if (!exited) { exited = true; live--; } });
    const stdin = new Writable({ write(chunk: Buffer, _encoding, callback) {
      const frame = JSON.parse(chunk.toString()) as Frame;
      frames.push(frame); bytes.push(chunk.length);
      if (frame.operation === 'prepare') {
        if (frame.protocolVersion === 3) expected = frame.payload.modelCount as number;
        else models = frame.payload.models as CollectionModel[];
      }
      if (frame.operation === 'appendSnapshot') models.push(...frame.payload.models as CollectionModel[]);
      const respond = (changes: Record<string, unknown> = {}) => {
        const { payload: _payload, ...identity } = frame;
        let result: unknown = null;
        if (frame.operation === 'prepare') result = { epoch: frame.epoch, datasetId: frame.datasetId, snapshotId: frame.snapshotId,
          readOnly: true, capabilities: ['collection.list'], modelCount: frame.protocolVersion === 3 ? 0 : models.length,
          ...(frame.protocolVersion === 3 ? { expectedModelCount: expected } : {}) };
        if (frame.operation === 'appendSnapshot') result = { chunkIndex: frame.payload.chunkIndex, receivedModelCount: models.length };
        if (frame.operation === 'dispatch') {
          const r = frame.payload.request as IpcRequest, payload = r.payload as { page: { offset: number; limit: number }; filter?: { query: string } };
          const filtered = filterCollectionSnapshot(models, payload.filter), items = filtered.slice(payload.page.offset, payload.page.offset + payload.page.limit);
          result = { ...payload.page, items, total: filtered.length, hasMore: payload.page.offset + items.length < filtered.length };
        }
        out.write(JSON.stringify({ ...identity, ok: true, result, ...changes }) + '\n');
        if (frame.operation === 'close') setImmediate(() => child.emit('close', 0, null));
      };
      setImmediate(() => behavior(frame, respond)); callback();
    } });
    return Object.assign(child, { stdin, stdout: out, stderr, kill() {
      kills++; const finish = () => child.emit('close', null, 'SIGKILL');
      if (holdExit) killExits.push(finish); else setImmediate(finish);
      return true;
    } }) as unknown as ChildProcessWithoutNullStreams;
  });
  return { frames, bytes, stdout, children, spawn, releaseKills() { killExits.splice(0).forEach(finish => finish()); },
    get live() { return live; }, get peak() { return peak; }, get kills() { return kills; } };
}
function source(s = snapshot()) {
  let revision: string = randomUUID(), exports = 0, oldExports = 0, prepares = 0, closes = 0, boots = 0, probes = 0;
  const owner: DatasetOwnerLargeSnapshotEndpoint = {
    async prepare() { prepares++; return { epoch: s.epoch, datasetId: s.datasetId }; },
    async close() { closes++; }, async commitBoot() { boots++; },
    async dispatch() { throw new Error('不应回退公开读取。'); },
    async exportCollectionSnapshot() { oldExports++; return s; },
    async exportVersionedCollectionSnapshot() { oldExports++; throw new Error('不应降级小版本导出。'); },
    async getCollectionSnapshotVersion() { probes++; return { epoch: s.epoch, datasetId: s.datasetId, revision }; },
    async exportLargeVersionedCollectionSnapshot() {
      exports++; return { snapshot: s, version: { epoch: s.epoch, datasetId: s.datasetId, revision } };
    },
  };
  return { owner, s, set revision(v: string) { revision = v; }, get counts() { return { exports, oldExports, prepares, closes, boots, probes }; } };
}

test('v3纯数组5000型号复制冻结后40块顺序上传，完整查询逐页核验', async t => {
  const f = fake(t), s = snapshot(5_000), expected = structuredClone(s.models);
  const endpoint = createRustReadonlyDatasetEndpoint({ binary, snapshot: s, snapshotProfile: 'v3-5000' });
  s.models[0]!.name = '调用者后来改了';
  await endpoint.prepare(); await endpoint.commitBoot();
  const received: CollectionModel[] = [];
  for (let offset = 0; offset < 5_000; offset += 100) received.push(...(await endpoint.dispatch(request(s, offset)) as { items: CollectionModel[] }).items);
  assert.deepEqual(received, expected);
  await endpoint.close();
  const chunks = f.frames.filter(frame => frame.operation === 'appendSnapshot');
  assert.equal(chunks.length, 40);
  chunks.forEach((frame, i) => {
    assert.equal(frame.payload.chunkIndex, i);
    assert.equal((frame.payload.models as CollectionModel[]).length, i === 39 ? 8 : 128);
    assert.equal(frame.protocolVersion, 3);
  });
  assert.deepEqual(f.frames[0]!.payload, { modelCount: 5_000 });
  assert.equal(f.bytes.filter((_bytes, i) => f.frames[i]!.operation === 'appendSnapshot').every(bytes => bytes - 1 <= RUST_LARGE_SNAPSHOT_LIMITS.chunkFrameBytes), true);
  assert.ok(f.bytes.reduce((sum, bytes, i) => sum + (f.frames[i]!.operation === 'appendSnapshot' ? bytes : 0), 0) <= RUST_LARGE_SNAPSHOT_LIMITS.uploadBytes);
  assert.equal(f.kills, 0);
});

test('默认及显式v2保持旧2000预算和不发送append，空v3不发送块', async t => {
  const f = fake(t);
  for (const profile of [undefined, 'v2-2000', 'v3-5000'] as const) {
    const s = snapshot(0), endpoint = createRustReadonlyDatasetEndpoint({ binary, snapshot: s, ...(profile ? { snapshotProfile: profile } : {}) });
    await endpoint.prepare(); await endpoint.commitBoot(); await endpoint.close();
  }
  assert.equal(f.frames.some(frame => frame.operation === 'appendSnapshot'), false);
  assert.deepEqual(f.frames.filter(frame => frame.operation === 'prepare').map(frame => frame.protocolVersion), [2, 2, 3]);
  assert.equal(RUST_SIDECAR_LIMITS.models, 2_000); assert.equal(RUST_SIDECAR_LIMITS.frameBytes, 4_194_304);
  assert.throws(() => createRustReadonlyDatasetEndpoint({ binary, snapshot: snapshot(2_001) }), code('CAPACITY_EXCEEDED'));
});

test('v3拒绝5001、完整8MiB超预算、重复ID和非JSON对象，未知profile不启动', t => {
  const f = fake(t);
  assert.throws(() => createRustReadonlyDatasetEndpoint({ binary, snapshot: snapshot(5_001), snapshotProfile: 'v3-5000' }), code('CAPACITY_EXCEEDED'));
  const s = snapshot(5_000);
  for (const m of s.models) { m.brand = '汉'.repeat(120); m.name = '汉'.repeat(120); m.edition = '汉'.repeat(120); m.lengths = Array(100).fill(360); }
  assert.ok(Buffer.byteLength(JSON.stringify(s)) > RUST_LARGE_SNAPSHOT_LIMITS.snapshotBytes);
  assert.throws(() => createRustReadonlyDatasetEndpoint({ binary, snapshot: s, snapshotProfile: 'v3-5000' }), code('CAPACITY_EXCEEDED'));
  const bad = snapshot(2); bad.models[1]!.id = bad.models[0]!.id;
  assert.throws(() => createRustReadonlyDatasetEndpoint({ binary, snapshot: bad, snapshotProfile: 'v3-5000' }), code('INVALID_REQUEST'));
  const getter = snapshot(); Object.defineProperty(getter.models[0], 'name', { enumerable: true, get: () => '访问器' });
  assert.throws(() => createRustReadonlyDatasetEndpoint({ binary, snapshot: getter, snapshotProfile: 'v3-5000' }), code('INVALID_REQUEST'));
  assert.throws(() => createRustReadonlyDatasetEndpoint({ binary, snapshot: snapshot(), snapshotProfile: 'v4' as RustSnapshotProfile }), code('INVALID_REQUEST'));
  assert.equal(f.spawn.mock.callCount(), 0);
});

test('v3完整快照恰8MiB可上传，增加一字节在启动前拒绝', async t => {
  const f = fake(t), s = snapshot(5_000);
  for (const m of s.models) { m.brand = '汉'.repeat(120); m.name = '汉'.repeat(120); m.edition = '汉'.repeat(120); m.lengths = Array(100).fill(360); }
  let excess = Buffer.byteLength(JSON.stringify(s)) - RUST_LARGE_SNAPSHOT_LIMITS.snapshotBytes;
  assert.ok(excess > 0);
  for (const m of s.models) {
    for (const field of ['brand', 'name', 'edition'] as const) {
      const removed = Math.min(m[field].length - 1, Math.floor(excess / 3));
      m[field] = m[field].slice(removed); excess -= removed * 3;
      if (excess === 1 || excess === 2) { m[field] = (excess === 1 ? 'é' : 'x') + m[field].slice(1); excess = 0; }
    }
    if (!excess) break;
  }
  assert.equal(excess, 0); assert.equal(Buffer.byteLength(JSON.stringify(s)), RUST_LARGE_SNAPSHOT_LIMITS.snapshotBytes);
  const endpoint = createRustReadonlyDatasetEndpoint({ binary, snapshot: s, snapshotProfile: 'v3-5000' });
  await endpoint.prepare(); await endpoint.commitBoot(); await endpoint.close();
  const upload = f.bytes.reduce((sum, bytes, i) => sum + (f.frames[i]!.operation === 'appendSnapshot' ? bytes : 0), 0);
  assert.ok(upload > RUST_LARGE_SNAPSHOT_LIMITS.snapshotBytes);
  assert.ok(upload <= RUST_LARGE_SNAPSHOT_LIMITS.uploadBytes);
  // 第一字段已因削减预算留出长度空间；一个ASCII字符只增加一字节。
  assert.ok(s.models[0]!.brand.length < 120); s.models[0]!.brand += 'x';
  assert.equal(Buffer.byteLength(JSON.stringify(s)), RUST_LARGE_SNAPSHOT_LIMITS.snapshotBytes + 1);
  assert.throws(() => createRustReadonlyDatasetEndpoint({ binary, snapshot: s, snapshotProfile: 'v3-5000' }), code('CAPACITY_EXCEEDED'));
  assert.equal(f.spawn.mock.callCount(), 1);
});

for (const issue of ['wrong-index', 'wrong-count', 'old-count', 'extra', 'old-envelope'] as const) {
  test(`v3 ${issue} append回执整体失败且不能commit或重发`, async t => {
    let old: Frame | undefined;
    const f = fake(t, (frame, respond) => {
      if (frame.operation !== 'appendSnapshot') { respond(); return; }
      if (issue === 'old-envelope') {
        if (!old) { old = frame; respond(); return; }
        const { payload: _payload, ...identity } = old;
        f.stdout[0]!.write(JSON.stringify({ ...identity, ok: true, result: { chunkIndex: 0, receivedModelCount: 128 } }) + '\n');
        return;
      }
      const index = frame.payload.chunkIndex as number;
      const result = { chunkIndex: issue === 'wrong-index' ? index + 1 : index,
        receivedModelCount: issue === 'wrong-count' ? 129 : issue === 'old-count' ? 0 : 128,
        ...(issue === 'extra' ? { extra: true } : {}) };
      respond({ result });
    });
    const endpoint = createRustReadonlyDatasetEndpoint({ binary, snapshot: snapshot(257), snapshotProfile: 'v3-5000' });
    await assert.rejects(endpoint.prepare(), code('PROTOCOL_ERROR'));
    await assert.rejects(endpoint.commitBoot(), code('PROTOCOL_ERROR'));
    await assert.rejects(endpoint.close(), code('PROTOCOL_ERROR'));
    assert.equal(f.frames.some(frame => frame.operation === 'commitBoot'), false);
    assert.equal(f.frames.filter(frame => frame.operation === 'appendSnapshot').length, issue === 'old-envelope' ? 2 : 1);
    await until(() => f.live === 0);
  });
}

for (const issue of ['model-count', 'expected-count', 'extra'] as const) {
  test(`v3 prepare ${issue} manifest回执拒绝`, async t => {
    const s = snapshot(1), f = fake(t, (frame, respond) => {
      if (frame.operation !== 'prepare') { respond(); return; }
      respond({ result: { epoch: frame.epoch, datasetId: frame.datasetId, snapshotId: frame.snapshotId,
        readOnly: true, capabilities: ['collection.list'], modelCount: issue === 'model-count' ? 1 : 0,
        expectedModelCount: issue === 'expected-count' ? 2 : 1, ...(issue === 'extra' ? { extra: true } : {}) } });
    });
    const endpoint = createRustReadonlyDatasetEndpoint({ binary, snapshot: s, snapshotProfile: 'v3-5000' });
    await assert.rejects(endpoint.prepare(), code('PROTOCOL_ERROR')); await assert.rejects(endpoint.close(), code('PROTOCOL_ERROR'));
    assert.equal(f.frames.length, 1); await until(() => f.live === 0);
  });
}

test('v3 FromOwner只调用大版本导出，缺少大API不降级，坏版本配对不启动', async t => {
  const f = fake(t), s = source();
  const endpoint = await createRustReadonlyDatasetEndpointFromOwner({ binary, owner: s.owner, snapshotProfile: 'v3-5000' });
  await endpoint.close(); assert.deepEqual(s.counts, { exports: 1, oldExports: 0, prepares: 1, closes: 0, boots: 0, probes: 0 });
  const { exportLargeVersionedCollectionSnapshot: _large, ...legacy } = s.owner;
  await assert.rejects(createRustReadonlyDatasetEndpointFromOwner({ binary, owner: legacy, snapshotProfile: 'v3-5000' }), code('SNAPSHOT_UNAVAILABLE'));
  await assert.rejects(createRustReadonlyCollectionRouter({ binary, owner: legacy, snapshotProfile: 'v3-5000' }), code('SNAPSHOT_UNAVAILABLE'));
  s.owner.exportLargeVersionedCollectionSnapshot = async () => ({ snapshot: s.s, version: { epoch: randomUUID(), datasetId: s.s.datasetId, revision: randomUUID() } });
  await assert.rejects(createRustReadonlyDatasetEndpointFromOwner({ binary, owner: s.owner, snapshotProfile: 'v3-5000' }), code('SCOPE_MISMATCH'));
  assert.equal(f.spawn.mock.callCount(), 1);
});

test('v3全部块共用启动期限，迟到ACK不能恢复发布或触发重发', async t => {
  let now = 0;
  const clock = t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const delayed: (() => void)[] = [], f = fake(t, (frame, respond) => {
    if (frame.operation !== 'appendSnapshot') { respond(); return; }
    delayed.push(respond);
    // 只推进受控单调时钟和定时器：前三块在240/480/720ms回执，第四块越过整体800ms期限。
    now += 240; t.mock.timers.tick(240); respond();
  });
  const s = source(snapshot(513));
  let count = 0;
  try {
    await assert.rejects(createRustReadonlyDatasetEndpointFromOwner({ binary, owner: s.owner, snapshotProfile: 'v3-5000',
      requestTimeoutMs: 2_000, startupTimeoutMs: 800 }), code('TIMEOUT'));
    assert.ok(delayed.length >= 2, '至少两块分别成功或在途，才能证明整体期限而非单块超时。');
    assert.equal(now, 960);
    assert.deepEqual(f.frames.filter(frame => frame.operation === 'appendSnapshot').map(frame => frame.payload.chunkIndex), [0, 1, 2, 3]);
    count = f.frames.length;
    delayed.forEach(respond => respond());
  } finally {
    // 子进程实际事件循环退出仍由原来的两秒until边界检查，先恢复真实时钟和定时器。
    t.mock.timers.reset(); clock.mock.restore();
  }
  await until(() => f.live === 0);
  assert.equal(f.frames.length, count); assert.equal(f.frames.some(frame => frame.operation === 'commitBoot'), false);
  assert.equal(s.counts.exports, 1); assert.equal(s.counts.closes, 0);
});

test('部分上传close只排空当前块，停止后续块并取得close ACK与自然退出', async t => {
  let release!: () => void;
  const f = fake(t, (frame, respond) => { if (frame.operation === 'appendSnapshot') release = respond; else respond(); });
  const s = snapshot(257), endpoint = createRustReadonlyDatasetEndpoint({ binary, snapshot: s, snapshotProfile: 'v3-5000' });
  const preparing = endpoint.prepare(); void preparing.catch(() => {});
  await until(() => !!release);
  await assert.rejects(endpoint.commitBoot(), code('NOT_READY'));
  await assert.rejects(endpoint.dispatch(request(s)), code('NOT_READY'));
  const closing = endpoint.close();
  assert.equal(f.frames.some(frame => frame.operation === 'close'), false);
  release(); await assert.rejects(preparing, code('CLOSING')); await closing;
  assert.deepEqual(f.frames.map(frame => frame.operation), ['prepare', 'appendSnapshot', 'close']);
  assert.equal(f.live, 0); assert.equal(f.kills, 0);
});

test('Router v3版本探测/筛选与失效沿用原合同，借用source不boot/close', async t => {
  const f = fake(t), s = source(snapshot(257)); s.s.models[5]!.name = '精选型号';
  const router = await createRustReadonlyCollectionRouter({ binary, owner: s.owner, snapshotProfile: 'v3-5000' });
  await router.refresh(); assert.equal(router.getStatus().phase, 'rust');
  const before = s.counts.probes;
  const result = await router.dispatch(request(s.s, 0, { query: '精选' })) as { items: CollectionModel[] };
  assert.equal(result.items.length, 1); assert.equal(result.items[0]!.id, s.s.models[5]!.id);
  assert.equal(s.counts.probes - before, 2);
  assert.equal(s.counts.exports, 1); assert.equal(s.counts.oldExports, 0);
  router.invalidate(); await router.close();
  assert.equal(s.counts.prepares, 0); assert.equal(s.counts.closes, 0); assert.equal(s.counts.boots, 0);
  assert.equal(f.peak, 1); assert.equal(f.live, 0);
});

test('Router v3 close撤销晚到大导出的候选，源合法RPC自然结算且不重放', async t => {
  const f = fake(t), s = source();
  let finish!: (value: Awaited<ReturnType<DatasetOwnerLargeSnapshotEndpoint['exportLargeVersionedCollectionSnapshot']>>) => void, exports = 0;
  s.owner.exportLargeVersionedCollectionSnapshot = () => { exports++; return new Promise(resolve => { finish = resolve; }); };
  const router = await createRustReadonlyCollectionRouter({ binary, owner: s.owner, snapshotProfile: 'v3-5000' });
  const refreshing = router.refresh(); void refreshing.catch(() => {});
  await until(() => exports === 1); const closing = router.close();
  finish({ snapshot: s.s, version: await s.owner.getCollectionSnapshotVersion() });
  await assert.rejects(refreshing, code('STALE_SNAPSHOT')); await closing;
  assert.equal(f.spawn.mock.callCount(), 0); assert.equal(exports, 1); assert.equal(s.counts.closes, 0);
});

test('Router v3启动候选坏ACK且强杀未退出时登记退役，不能再spawn或伪称close成功', async t => {
  const f = fake(t, (frame, respond) => {
    if (frame.operation === 'appendSnapshot') respond({ result: { chunkIndex: 0, receivedModelCount: 0 } }); else respond();
  }, true), s = source();
  const router = await createRustReadonlyCollectionRouter({ binary, owner: s.owner, snapshotProfile: 'v3-5000' });
  await assert.rejects(router.refresh(), code('PROTOCOL_ERROR'));
  assert.equal(f.live, 1); await assert.rejects(router.refresh(), code('PROTOCOL_ERROR'));
  await assert.rejects(router.close(), code('PROTOCOL_ERROR'));
  assert.equal(f.spawn.mock.callCount(), 1); assert.equal(f.peak, 1); assert.equal(s.counts.closes, 0);
  f.releaseKills(); await until(() => f.live === 0);
});


for (const action of ['close', 'invalidate'] as const) {
  test(`Router v3 ${action}立即封闭上传候选，当前ACK迟到后不继续上传或boot`, async t => {
  let release!: () => void;
  const f = fake(t, (frame, respond) => { if (frame.operation === 'appendSnapshot') release = respond; else respond(); });
  const s = source(snapshot(257)), router = await createRustReadonlyCollectionRouter({ binary, owner: s.owner, snapshotProfile: 'v3-5000' });
  const refreshing = router.refresh(); void refreshing.catch(() => {});
  await until(() => !!release);
  const closing = action === 'close' ? router.close() : (router.invalidate(), Promise.resolve());
  release(); await assert.rejects(refreshing, code('CLOSING')); await closing;
  assert.equal(router.getStatus().phase, action === 'close' ? 'closed' : 'stale');
  await router.close();
  assert.deepEqual(f.frames.map(frame => frame.operation), ['prepare', 'appendSnapshot', 'close']);
  assert.equal(router.getStatus().phase, 'closed'); assert.equal(f.live, 0); assert.equal(f.kills, 0); assert.equal(s.counts.closes, 0);
  });
}

test('Router v3大导出版本在上传期间变化，最终探测撤销候选且不发布', async t => {
  const s = source(snapshot(257)), f = fake(t, (frame, respond) => {
    if (frame.operation === 'commitBoot') s.revision = randomUUID();
    respond();
  });
  const router = await createRustReadonlyCollectionRouter({ binary, owner: s.owner, snapshotProfile: 'v3-5000' });
  await assert.rejects(router.refresh(), code('STALE_SNAPSHOT')); await router.close();
  assert.equal(f.live, 0); assert.equal(s.counts.exports, 1); assert.equal(s.counts.oldExports, 0); assert.equal(s.counts.closes, 0);
});
