import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess, { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough, Writable } from 'node:stream';
import { type CollectionFilter, type CollectionModel, type IpcRequest } from '@music-bridge/contracts';
import { createRustReadonlyDatasetEndpoint, createRustReadonlyDatasetEndpointFromOwner, freezeCollectionSnapshot, RUST_SIDECAR_LIMITS, RustSidecarError,
  type RustReadonlySnapshot, type RustReadonlySidecarOptions } from '../src/rust-core/readonly-sidecar.js';
import { filterCollectionSnapshot } from '../src/rust-core/collection-query.js';
import type { DatasetOwnerSnapshotEndpoint } from '../src/collection/dataset-owner-protocol.js';

const binary = { path: process.execPath, sha256: createHash('sha256').update(readFileSync(process.execPath)).digest('hex') };
function model(): CollectionModel {
  return { id: randomUUID(), brand: '合成牌', name: '只读型号', edition: '初版', year: 1990, format: 'cassette',
    tapeType: 'II', identification: 'verified', collectorPolicy: 'normal', minimumSealedReserve: 0, revision: 1,
    lengths: [60, null], counts: { total: 1, sealedBlank: 1, openedBlank: 0, legacyUsed: 0, recorded: 0,
      reserved: 0, unavailable: 0, unknown: 0 } };
}
function snapshot(): RustReadonlySnapshot { return { epoch: randomUUID(), datasetId: randomUUID(), snapshotId: randomUUID(), models: [model()] }; }
function request(s: RustReadonlySnapshot, overrides: Partial<IpcRequest> = {}): IpcRequest {
  return { version: 1, id: randomUUID(), command: 'collection.list', payload: { page: { offset: 0, limit: 25 } }, expectedDatasetId: s.datasetId, ...overrides };
}
type Frame = Record<string, unknown>;
function fake(t: test.TestContext, behavior: (frame: Frame, respond: (changes?: Frame) => void, child: EventEmitter) => void = (_frame, respond) => respond(), delayWrite = 0) {
  const child = new EventEmitter();
  const frames: Frame[] = [];
  const stdout = new PassThrough(), stderr = new PassThrough();
  let models: unknown[] = [], buffered = '', killed = false;
  const stdin = new Writable({ highWaterMark: 1, write(chunk: Buffer, _encoding, callback) {
    buffered += chunk.toString();
    while (buffered.includes('\n')) {
      const index = buffered.indexOf('\n'), frame = JSON.parse(buffered.slice(0, index)) as Frame;
      buffered = buffered.slice(index + 1); frames.push(frame);
      if (frame.operation === 'prepare') models = (frame.payload as { models: unknown[] }).models;
      const respond = (changes: Frame = {}) => {
        const { payload: _payload, ...identity } = frame;
        let result: unknown = null;
        if (frame.operation === 'prepare') result = { epoch: frame.epoch, datasetId: frame.datasetId, snapshotId: frame.snapshotId,
          readOnly: true, capabilities: ['collection.list'], modelCount: models.length };
        if (frame.operation === 'dispatch') {
          const { page, filter } = (frame.payload as { request: { payload: { page: { offset: number; limit: number }; filter?: CollectionFilter } } }).request.payload;
          const filtered = filterCollectionSnapshot(models as CollectionModel[], filter);
          const items = filtered.slice(page.offset, page.offset + page.limit);
          result = { ...page, total: filtered.length, items, hasMore: page.offset + items.length < filtered.length };
        }
        stdout.write(JSON.stringify({ ...identity, ok: true, result, ...changes }) + '\n');
        if (frame.operation === 'close') setImmediate(() => child.emit('close', 0, null));
      };
      setImmediate(() => behavior(frame, respond, child));
    }
    if (delayWrite) setTimeout(callback, delayWrite); else callback();
  } });
  const runtime = Object.assign(child, { stdin, stdout, stderr, kill() { killed = true; setImmediate(() => child.emit('close', null, 'SIGKILL')); return true; } });
  const spawnMock = t.mock.method(childProcess, 'spawn', () => runtime as unknown as ChildProcessWithoutNullStreams);
  return { frames, stdout, stderr, child, spawnMock, get killed() { return killed; } };
}
const code = (expected: string) => (error: unknown) => error instanceof RustSidecarError && error.code === expected;
async function ready(options: RustReadonlySidecarOptions) {
  const endpoint = createRustReadonlyDatasetEndpoint(options);
  await endpoint.prepare(); await endpoint.commitBoot();
  return endpoint;
}

test('私有null回执恢复void，冻结快照不受调用方修改，分页不改变顺序', async t => {
  const f = fake(t), s = snapshot(), expected = structuredClone(s.models);
  const endpoint = createRustReadonlyDatasetEndpoint({ binary, snapshot: s });
  s.models[0]!.name = '之后修改';
  assert.deepEqual(await endpoint.prepare(), { epoch: s.epoch, datasetId: s.datasetId });
  assert.equal(await endpoint.commitBoot(), undefined);
  const result = await endpoint.dispatch(request(s)) as { items: unknown[] };
  assert.deepEqual(result.items, expected);
  assert.equal(await endpoint.close(), undefined);
  assert.equal(await endpoint.close(), undefined);
  assert.deepEqual(f.frames.map(v => v.operation), ['prepare', 'commitBoot', 'dispatch', 'close']);
  assert.deepEqual(f.frames.map(v => v.sequence), [1, 2, 3, 4]);
  assert.equal(f.killed, false);
  const opts = f.spawnMock.mock.calls[0]!.arguments[2]!;
  assert.equal(opts.shell, false);
  assert.deepEqual(opts.env, { LANG: 'C.UTF-8' });
});
test('未就绪读取和未启动关闭不启动原生程序', async t => {
  const f = fake(t), s = snapshot(), endpoint = createRustReadonlyDatasetEndpoint({ binary, snapshot: s });
  await assert.rejects(endpoint.dispatch(request(s)), code('NOT_READY'));
  await endpoint.close(); await assert.rejects(endpoint.prepare(), code('CLOSING'));
  assert.equal(f.frames.length, 0);
});
test('完整页导出要求一次结果完整且不重复型号', () => {
  const s = snapshot(), page = { items: s.models, total: 1, offset: 0, limit: 25, hasMore: false };
  assert.equal(freezeCollectionSnapshot(s, page).models.length, 1);
  assert.throws(() => freezeCollectionSnapshot(s, { ...page, total: 2, hasMore: true }), code('INVALID_REQUEST'));
  assert.throws(() => createRustReadonlyDatasetEndpoint({ binary, snapshot: { ...s, models: [s.models[0]!, s.models[0]!] } }), code('INVALID_REQUEST'));
});
test('拒绝坏模型、非JSON可选值及超过快照型号预算', () => {
  const s = snapshot();
  assert.throws(() => createRustReadonlyDatasetEndpoint({ binary, snapshot: { ...s, models: [{ ...model(), counts: { ...model().counts, total: 2 } }] } }), code('INVALID_REQUEST'));
  assert.throws(() => createRustReadonlyDatasetEndpoint({ binary, snapshot: { ...s, models: [{ ...model(), featuredPhoto: undefined } as unknown as CollectionModel] } }), code('INVALID_REQUEST'));
  assert.throws(() => createRustReadonlyDatasetEndpoint({ binary, snapshot: { ...s, models: Array.from({ length: 2001 }, model) } }), code('CAPACITY_EXCEEDED'));
});
test('负零按JSON数值归一化，库存快照及分页往返不误判', async t => {
  fake(t);
  const s = snapshot();
  s.models[0]!.minimumSealedReserve = -0;
  s.models[0]!.counts.openedBlank = -0;
  const endpoint = await ready({ binary, snapshot: s });
  const result = await endpoint.dispatch(request(s, { payload: { page: { offset: -0, limit: 25 } } })) as {
    items: CollectionModel[]; offset: number;
  };
  assert.equal(Object.is(result.items[0]!.minimumSealedReserve, 0), true);
  assert.equal(Object.is(result.items[0]!.counts.openedBlank, 0), true);
  assert.equal(Object.is(result.offset, 0), true);
  await endpoint.close();
});
test('策略只接受字符串，孤立UTF16代理项在启动前拒绝', t => {
  const f = fake(t), s = snapshot();
  const malformed = { ...s.models[0]!, collectorPolicy: ['normal'] } as unknown as CollectionModel;
  assert.throws(() => createRustReadonlyDatasetEndpoint({ binary, snapshot: { ...s, models: [malformed] } }), code('INVALID_REQUEST'));
  assert.throws(() => createRustReadonlyDatasetEndpoint({ binary, snapshot: { ...s, models: [{ ...s.models[0]!, name: '\uD800' }] } }), code('INVALID_REQUEST'));
  assert.equal(f.frames.length, 0);
  assert.equal(f.spawnMock.mock.callCount(), 0);
});
test('二进制摘要、绝对路径与有界期限在启动前验证', async t => {
  const f = fake(t), s = snapshot();
  await assert.rejects(createRustReadonlyDatasetEndpoint({ binary: { ...binary, sha256: '0'.repeat(64) }, snapshot: s }).prepare(), code('BINARY_PIN_MISMATCH'));
  await assert.rejects(createRustReadonlyDatasetEndpoint({ binary: { path: 'node', sha256: binary.sha256 }, snapshot: s }).prepare(), code('BINARY_PIN_MISMATCH'));
  assert.throws(() => createRustReadonlyDatasetEndpoint({ binary, snapshot: s, requestTimeoutMs: 30_001 }), code('INVALID_REQUEST'));
  assert.equal(f.frames.length, 0);
});
test('只允许collection.list，写命令/换库/坏筛选/readContext不发到stdin', async t => {
  const f = fake(t), s = snapshot(), endpoint = await ready({ binary, snapshot: s });
  await assert.rejects(endpoint.dispatch(request(s, { command: 'playback.pause', payload: {} })), code('UNSUPPORTED_COMMAND'));
  await assert.rejects(endpoint.dispatch(request(s, { expectedDatasetId: randomUUID() })), code('SCOPE_MISMATCH'));
  await assert.rejects(endpoint.dispatch(request(s, { payload: { page: { offset: 0, limit: 25 }, filter: { decade: 1991 } } })), code('INVALID_REQUEST'));
  await assert.rejects(endpoint.dispatch(request(s, { readContext: { deadlineAtMs: Date.now() + 1000 } })), code('INVALID_REQUEST'));
  assert.equal(f.frames.length, 2);
  await endpoint.close();
});
test('序列化写入处理背压，16个在途以外立即拒绝且不增加wire请求', async t => {
  const held: (() => void)[] = [], f = fake(t, (frame, respond) => {
    if (frame.operation === 'dispatch') held.push(respond); else respond();
  }, 1);
  const s = snapshot(), endpoint = await ready({ binary, snapshot: s });
  const reads = Array.from({ length: 16 }, () => endpoint.dispatch(request(s)));
  await assert.rejects(endpoint.dispatch(request(s)), code('CAPACITY_EXCEEDED'));
  while (held.length < 16) await new Promise(resolve => setTimeout(resolve, 2));
  held.forEach(respond => respond());
  await Promise.all(reads); await endpoint.close();
  assert.equal(f.frames.filter(v => v.operation === 'dispatch').length, 16);
});
test('close先封入口，等已接受读取结束再发送关闭帧', async t => {
  let release!: () => void;
  const f = fake(t, (frame, respond) => { if (frame.operation === 'dispatch') release = respond; else respond(); });
  const s = snapshot(), endpoint = await ready({ binary, snapshot: s });
  const reading = endpoint.dispatch(request(s));
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const closing = endpoint.close();
  await assert.rejects(endpoint.dispatch(request(s)), code('CLOSING'));
  assert.equal(f.frames.some(v => v.operation === 'close'), false);
  release(); await reading; await closing;
});
test('有close ACK但不自然退出时关闭失败，强杀不伪称成功', async t => {
  const f = fake(t, (frame, respond) => {
    if (frame.operation === 'close') {
      const { payload: _payload, ...identity } = frame;
      f.stdout.write(JSON.stringify({ ...identity, ok: true, result: null }) + '\n');
    } else respond();
  });
  const endpoint = await ready({ binary, snapshot: snapshot(), closeTimeoutMs: 20 });
  await assert.rejects(endpoint.close(), code('TIMEOUT')); assert.equal(f.killed, true);
});
test('无close ACK的提前退出不能完成读取，原生stderr不进入错误文本', async t => {
  const f = fake(t, (frame, respond, child) => {
    if (frame.operation === 'dispatch') { f.stderr.write('合成私密路径和上游内容'); child.emit('close', 7, null); } else respond();
  });
  const s = snapshot(), endpoint = await ready({ binary, snapshot: s });
  await assert.rejects(endpoint.dispatch(request(s)), error => code('PROCESS_EXIT')(error) && !(error as Error).message.includes('私密'));
  await assert.rejects(endpoint.close(), code('PROCESS_EXIT'));
});
test('错epoch触发fatal，不再发布结果', async t => {
  const f = fake(t, (frame, respond) => { if (frame.operation === 'dispatch') respond({ epoch: randomUUID() }); else respond(); });
  const reasons: string[] = [], s = snapshot(), endpoint = await ready({ binary, snapshot: s, onFatal: reason => reasons.push(reason) });
  await assert.rejects(endpoint.dispatch(request(s)), code('PROTOCOL_ERROR'));
  assert.deepEqual(reasons, ['PROTOCOL_ERROR']); assert.equal(f.killed, true);
  await assert.rejects(endpoint.close(), code('PROTOCOL_ERROR'));
});
for (const mismatch of ['requestId', 'result', 'unit', 'duplicate'] as const) {
  test('拒绝损坏回执：' + mismatch, async t => {
    const f = fake(t, (frame, respond) => {
      if (frame.operation === 'commitBoot' && mismatch === 'unit') respond({ result: {} });
      else if (frame.operation === 'dispatch' && mismatch === 'requestId') respond({ requestId: randomUUID() });
      else if (frame.operation === 'dispatch' && mismatch === 'result') respond({ result: { items: [], total: 1, offset: 0, limit: 25, hasMore: true } });
      else if (frame.operation === 'dispatch' && mismatch === 'duplicate') { respond(); respond(); }
      else respond();
    });
    const s = snapshot(), endpoint = createRustReadonlyDatasetEndpoint({ binary, snapshot: s });
    await endpoint.prepare();
    if (mismatch === 'unit') await assert.rejects(endpoint.commitBoot(), code('PROTOCOL_ERROR'));
    else {
      await endpoint.commitBoot();
      await assert.rejects(endpoint.dispatch(request(s)), code('PROTOCOL_ERROR'));
    }
    assert.equal(f.killed, true); await assert.rejects(endpoint.close(), code('PROTOCOL_ERROR'));
  });
}
test('损坏UTF8有界失败', async t => {
  const f = fake(t, (frame, respond) => { if (frame.operation === 'dispatch') f.stdout.write(Buffer.from([0xff, 10])); else respond(); });
  const s = snapshot(), endpoint = await ready({ binary, snapshot: s });
  await assert.rejects(endpoint.dispatch(request(s)), code('PROTOCOL_ERROR')); await assert.rejects(endpoint.close(), code('PROTOCOL_ERROR'));
});
test('toJSON、自定义prototype及访问器不能悄悄重写导出事实', () => {
  const s = snapshot(), counts = s.models[0]!.counts;
  Object.setPrototypeOf(counts, { toJSON: () => ({ ...counts, total: 0, sealedBlank: 0 }) });
  assert.throws(() => createRustReadonlyDatasetEndpoint({ binary, snapshot: s }), code('INVALID_REQUEST'));
  const next = snapshot(); let getterCalled = false;
  Object.defineProperty(next.models[0]!, 'brand', { enumerable: true, get() { getterCalled = true; return '访问器'; } });
  assert.throws(() => createRustReadonlyDatasetEndpoint({ binary, snapshot: next }), code('INVALID_REQUEST'));
  assert.equal(getterCalled, false);
});
test('事件循环阻塞后过期读取不写入stdin，不依赖timer抢先运行', async t => {
  const f = fake(t), s = snapshot(), endpoint = await ready({ binary, snapshot: s, requestTimeoutMs: 20 });
  const reading = endpoint.dispatch(request(s));
  const until = performance.now() + 40; while (performance.now() < until) { /* 合成同步阻塞。 */ }
  await assert.rejects(reading, code('TIMEOUT'));
  assert.equal(f.frames.filter(v => v.operation === 'dispatch').length, 0);
  await assert.rejects(endpoint.close(), code('TIMEOUT'));
});
test('回执即使在timer之前运行，也不能发布已过期数据', async t => {
  const f = fake(t, (frame, respond) => {
    if (frame.operation === 'dispatch') { const until = performance.now() + 40; while (performance.now() < until) {} }
    respond();
  });
  const s = snapshot(), endpoint = await ready({ binary, snapshot: s, requestTimeoutMs: 20 });
  await assert.rejects(endpoint.dispatch(request(s)), code('TIMEOUT'));
  assert.equal(f.frames.filter(v => v.operation === 'dispatch').length, 1);
  await assert.rejects(endpoint.close(), code('TIMEOUT'));
});
for (const nested of [false, true]) {
  test('私有JSON覆盖式重复键必须拒绝，嵌套=' + nested, async t => {
    const f = fake(t, (frame, respond) => {
      if (frame.operation !== 'dispatch') { respond(); return; }
      const { payload: _payload, ...identity } = frame;
      const page = { offset: 0, limit: 25, total: 1, hasMore: false, items: s.models };
      const value = JSON.stringify({ ...identity, ok: true, result: page });
      const corrupt = nested ? value.replace('"total":1', '"total":0,"total":1')
        : value.replace('"epoch":', '"epoch":"wrong","epoch":');
      f.stdout.write(corrupt + '\n');
    });
    const s = snapshot(), endpoint = await ready({ binary, snapshot: s });
    await assert.rejects(endpoint.dispatch(request(s)), code('PROTOCOL_ERROR'));
    await assert.rejects(endpoint.close(), code('PROTOCOL_ERROR'));
  });
}
test('超限帧不等换行即可失败', async t => {
  const f = fake(t, (frame, respond) => { if (frame.operation === 'dispatch') f.stdout.write(Buffer.alloc(RUST_SIDECAR_LIMITS.frameBytes + 1, 32)); else respond(); });
  const s = snapshot(), endpoint = await ready({ binary, snapshot: s });
  await assert.rejects(endpoint.dispatch(request(s)), code('CAPACITY_EXCEEDED')); await assert.rejects(endpoint.close(), code('CAPACITY_EXCEEDED'));
});
test('读取期限失败后，迟到数据不能恢复端点或自动重放', async t => {
  let late!: () => void;
  const f = fake(t, (frame, respond) => { if (frame.operation === 'dispatch') late = respond; else respond(); });
  // 同一 RPC 预算也覆盖 prepare/boot；留足正常启动时间，只有挂起读取制造期限失败。
  const s = snapshot(), endpoint = await ready({ binary, snapshot: s, requestTimeoutMs: 1_000 });
  assert.deepEqual(f.frames.map(frame => frame.operation), ['prepare', 'commitBoot']);
  await assert.rejects(endpoint.dispatch(request(s)), code('TIMEOUT'));
  assert.equal(typeof late, 'function', '读取请求确实发送后才进入超时断言。');
  late();
  await assert.rejects(endpoint.dispatch(request(s)), code('TIMEOUT'));
  await assert.rejects(endpoint.close(), code('TIMEOUT'));
  assert.equal(f.frames.filter(v => v.operation === 'dispatch').length, 1);
  assert.deepEqual(f.frames.map(frame => frame.operation), ['prepare', 'commitBoot', 'dispatch']);
  assert.equal(f.spawnMock.mock.callCount(), 1);
  assert.equal(f.killed, true);
});

test('v2投影保留Node Unicode归一化，筛选在分页前且不重排', async t => {
  const f = fake(t), s = snapshot();
  const a = { ...model(), brand: 'TDK', name: 'SA 90%', edition: 'A_B' };
  const b = { ...model(), brand: 'TDK', name: 'SA 90%', edition: 'A_B', year: 1999 };
  const c = { ...model(), brand: 'É', name: '不同', edition: 'C', year: null };
  const endpoint = await ready({ binary, snapshot: { ...s, models: [a, c, b] } });
  const filter = { query: '　ＳＡ　９０％　Ａ＿Ｂ　', brand: '　ＴＤＫ　', decade: 1990, stockState: 'blank' } as const;
  const page = await endpoint.dispatch(request(s, { payload: { page: { offset: 1, limit: 1 }, filter } })) as { items: CollectionModel[]; total: number; hasMore: boolean };
  assert.deepEqual(page.items, [b]); assert.equal(page.total, 2); assert.equal(page.hasMore, false);
  assert.deepEqual((f.frames.find(frame => frame.operation === 'dispatch')!.payload as Frame).filterProjection,
    { query: 'sa 90% a_b', brand: 'tdk' });
  const accented = await endpoint.dispatch(request(s, { payload: { page: { offset: 0, limit: 25 }, filter: { brand: 'É' } } })) as { total: number };
  assert.equal(accented.total, 0);
  const empty = await endpoint.dispatch(request(s, { payload: { page: { offset: 0, limit: 25 }, filter: { query: '　', brand: ' ' } } })) as { total: number };
  assert.equal(empty.total, 3);
  assert.ok(f.frames.every(frame => frame.protocolVersion === 2));
  await endpoint.close();
});

test('合法但不符合已申请筛选的DTO也要拒绝', async t => {
  const s = snapshot();
  const f = fake(t, (frame, respond) => frame.operation === 'dispatch'
    ? respond({ result: { items: s.models, total: 1, offset: 0, limit: 25, hasMore: false } }) : respond());
  const endpoint = await ready({ binary, snapshot: s });
  await assert.rejects(endpoint.dispatch(request(s, { payload: { page: { offset: 0, limit: 25 }, filter: { query: '不存在' } } })), code('PROTOCOL_ERROR'));
  assert.equal(f.killed, true); await assert.rejects(endpoint.close(), code('PROTOCOL_ERROR'));
});

function sourceOwner(s: RustReadonlySnapshot, exportSnapshot: () => Promise<RustReadonlySnapshot> = async () => s) {
  const calls = { prepare: 0, export: 0, boot: 0, close: 0 };
  const owner: DatasetOwnerSnapshotEndpoint = {
    async prepare() { calls.prepare++; return { epoch: s.epoch, datasetId: s.datasetId }; },
    async exportCollectionSnapshot() { calls.export++; return exportSnapshot(); },
    async commitBoot() { calls.boot++; }, async close() { calls.close++; },
    async dispatch() { return '原Node仍可读取'; },
  };
  return { owner, calls };
}

test('Owner工厂只显式导出一次，返回就绪Rust端点并保留Node所有权', async t => {
  const f = fake(t), s = snapshot(), source = sourceOwner(s);
  const endpoint = await createRustReadonlyDatasetEndpointFromOwner({ binary, owner: source.owner });
  const result = await endpoint.dispatch(request(s)) as { total: number };
  assert.equal(result.total, 1); assert.equal(endpoint.snapshotId, s.snapshotId);
  await endpoint.close();
  assert.deepEqual(source.calls, { prepare: 1, export: 1, boot: 0, close: 0 });
  assert.equal(await source.owner.dispatch(request(s)), '原Node仍可读取');
  assert.equal(f.killed, false);
});

test('源Owner失败与身份变化不启动原生程序，也不关闭源Owner', async t => {
  const f = fake(t), s = snapshot();
  const broken = sourceOwner(s, async () => { throw new Error('合成私密路径'); });
  await assert.rejects(createRustReadonlyDatasetEndpointFromOwner({ binary, owner: broken.owner }), error =>
    code('SNAPSHOT_UNAVAILABLE')(error) && !(error as Error).message.includes('私密'));
  for (const field of ['epoch', 'datasetId'] as const) {
    const shifted = sourceOwner(s, async () => ({ ...s, [field]: randomUUID() }));
    await assert.rejects(createRustReadonlyDatasetEndpointFromOwner({ binary, owner: shifted.owner }), code('SCOPE_MISMATCH'));
    assert.equal(shifted.calls.close, 0);
  }
  assert.equal(broken.calls.close, 0); assert.equal(f.spawnMock.mock.callCount(), 0);
});

test('整体期限耗尽后迟到导出不能启动或发布端点，不重放源RPC', async t => {
  const f = fake(t), s = snapshot(); let release!: (value: RustReadonlySnapshot) => void;
  const source = sourceOwner(s, () => new Promise(resolve => { release = resolve; }));
  await assert.rejects(createRustReadonlyDatasetEndpointFromOwner({ binary, owner: source.owner, startupTimeoutMs: 20 }), code('TIMEOUT'));
  release(s); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.spawnMock.mock.callCount(), 0);
  assert.deepEqual(source.calls, { prepare: 1, export: 1, boot: 0, close: 0 });
  assert.equal(await source.owner.dispatch(request(s)), '原Node仍可读取');
});

test('整体期限按单调时钟检查同步阻塞，过期后不继续导出', async t => {
  const f = fake(t), s = snapshot(), source = sourceOwner(s);
  source.owner.prepare = async () => {
    const until = performance.now() + 40; while (performance.now() < until) { /* 合成同步阻塞。 */ }
    return { epoch: s.epoch, datasetId: s.datasetId };
  };
  await assert.rejects(createRustReadonlyDatasetEndpointFromOwner({ binary, owner: source.owner, startupTimeoutMs: 20 }), code('TIMEOUT'));
  assert.equal(source.calls.export, 0); assert.equal(source.calls.close, 0); assert.equal(f.spawnMock.mock.callCount(), 0);
});

test('启动阶段整体期限失败清理自己的进程，迟到boot回执不发布成功', async t => {
  let release!: () => void;
  const f = fake(t, (frame, respond) => { if (frame.operation === 'commitBoot') release = respond; else respond(); });
  const s = snapshot(), source = sourceOwner(s);
  await assert.rejects(createRustReadonlyDatasetEndpointFromOwner({ binary, owner: source.owner, startupTimeoutMs: 200 }), code('TIMEOUT'));
  assert.equal(typeof release, 'function'); release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.killed, true); assert.equal(source.calls.close, 0);
  assert.equal(f.frames.filter(frame => frame.operation === 'prepare').length, 1);
});

test('工厂的二进制准入失败保留源Owner，不改写或重试导出', async t => {
  const f = fake(t), source = sourceOwner(snapshot());
  await assert.rejects(createRustReadonlyDatasetEndpointFromOwner({ binary: { ...binary, sha256: '0'.repeat(64) }, owner: source.owner }), code('BINARY_PIN_MISMATCH'));
  assert.equal(f.spawnMock.mock.callCount(), 0);
  assert.deepEqual(source.calls, { prepare: 1, export: 1, boot: 0, close: 0 });
});

test('v2客户端拒绝原生响应降级为v1', async t => {
  const f = fake(t, (_frame, respond) => respond({ protocolVersion: 1 }));
  const endpoint = createRustReadonlyDatasetEndpoint({ binary, snapshot: snapshot() });
  await assert.rejects(endpoint.prepare(), code('PROTOCOL_ERROR'));
  assert.equal(f.killed, true); await assert.rejects(endpoint.close(), code('PROTOCOL_ERROR'));
});

test('v2工厂保留Node既有合法v7工作库身份，不改写datasetId', async t => {
  fake(t);
  const s = { ...snapshot(), datasetId: '22222222-2222-7222-8222-222222222222' }, source = sourceOwner(s);
  const endpoint = await createRustReadonlyDatasetEndpointFromOwner({ binary, owner: source.owner });
  assert.deepEqual(await endpoint.prepare(), { epoch: s.epoch, datasetId: s.datasetId });
  assert.equal((await endpoint.dispatch(request(s)) as { total: number }).total, 1);
  await endpoint.close();
  assert.deepEqual(source.calls, { prepare: 1, export: 1, boot: 0, close: 0 });
});
