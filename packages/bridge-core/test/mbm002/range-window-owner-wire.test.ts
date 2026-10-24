import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { EventEmitter, once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, stat, rm, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { MessageChannel, Worker } from 'node:worker_threads';
import { createDatasetOwnerClient } from '../../src/collection/dataset-owner-client.js';
import { attachDatasetOwnerWorkerPort } from '../../src/collection/dataset-owner-worker.js';
import { responseFailure } from '../../src/shared/ipc-failure.js';
import type { OwnedDatasetDomain } from '../../src/collection/dataset-owner-protocol.js';
import { authorizeSourceDirectory } from '../../src/recording/source-files.js';
import { LocalFileSourcePool, type AssetLease, type ReadonlyLocalFileDescriptor } from '../../src/stream/local-file-source.js';
import type { MobileOwnerPrivateRequest, MobileOwnerPrivateResult } from '../../src/mobile/types.js';
import * as trace from '../../src/mobile/range-window-observer.js';

/** 原Client/Worker端函数＋真实MessageChannel/合成自有FD；不冒称数据库、独立Worker或手机实播。 */
async function fixture(t: TestContext) {
  const temporary = process.env.TMPDIR;
  assert.ok(typeof temporary === 'string' && temporary.startsWith('/Volumes/LifeWeave/'));
  const directory = await mkdtemp(path.join(temporary, 'owner-range-'));
  const filename = path.join(directory, 'synthetic.wav');
  const bytes = Buffer.from(Array.from({ length: 4 * 65536 }, (_, index) => index % 251));
  await writeFile(filename, bytes, { mode: 0o600 });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourceRoot = { id: randomUUID(), ...await authorizeSourceDirectory(directory) };
  const rootId = randomUUID(), assetId = randomUUID(), trackId = randomUUID();
  const info = await stat(filename, { bigint: true });
  const descriptor: ReadonlyLocalFileDescriptor = { source_kind: 'local_file', status: 'prepared_descriptor', facts: {
    sourceRoot, relative: path.basename(filename), root: { id: rootId, sourceRootId: sourceRoot.id, role: 'library', revision: '1' },
    asset: { id: assetId, libraryRootId: rootId, sourceRootId: sourceRoot.id, rootRevision: '1', fileRevision: '2', locationRevision: '3', sampleFrames: null, timebaseHz: null },
    track: { id: trackId, assetId, selectionRevision: '4', segment: null },
    observation: { signature: [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':'), assetId, trackId,
      libraryRootId: rootId, sourceRootId: sourceRoot.id, fileRevision: '2', rootRevision: '1', locationRevision: '3', selectionRevision: '4' },
  } };
  const calls: string[] = [], pool = new LocalFileSourcePool();
  let current = true;
  const lease = await pool.prepare(descriptor, { ownerId: 'synthetic-owner-range', attempt: 1,
    isCurrent() { calls.push('authority'); return current; } });
  const file = (lease as unknown as { file: { handle: FileHandle; verify(): Promise<void> } }).file;
  const verifyOriginal = file.verify.bind(file), readOriginal = file.handle.read.bind(file.handle);
  let onVerify: (() => void | Promise<void>) | undefined, onRead: (() => void | Promise<void>) | undefined;
  t.mock.method(file, 'verify', async () => { calls.push('named-fd'); await onVerify?.(); await verifyOriginal(); });
  t.mock.method(file.handle, 'read', (async (...args: Parameters<FileHandle['read']>) => {
    calls.push('fd-read'); await onRead?.(); return readOriginal(...args);
  }) as FileHandle['read']);
  const ports = new MessageChannel(), datasetId = randomUUID(), clientPackets: unknown[] = [], ownerPackets: unknown[] = [];
  let clientHook: ((raw: unknown) => 'drop' | void) | undefined, ownerHook: ((raw: unknown) => 'drop' | void) | undefined;
  const worker = new EventEmitter() as EventEmitter & { postMessage(raw: unknown): void };
  worker.postMessage = raw => { clientPackets.push(raw); if (clientHook?.(raw) !== 'drop') ports.port1.postMessage(raw); };
  ports.port1.on('message', raw => worker.emit('message', raw));
  ports.port1.once('close', () => worker.emit('exit', 0));
  const nativeOwnerPost = ports.port2.postMessage.bind(ports.port2);
  t.mock.method(ports.port2, 'postMessage', (raw: unknown) => { ownerPackets.push(raw); if (ownerHook?.(raw) !== 'drop') nativeOwnerPost(raw); });
  const fatal: string[] = [], endpoint = createDatasetOwnerClient({ worker: worker as unknown as Worker, onFatal: reason => fatal.push(reason) });
  const controller = new AbortController();
  const domain: OwnedDatasetDomain = { datasetId, async dispatch() { return undefined; }, commitBoot() {},
    async mobileMain(request: MobileOwnerPrivateRequest): Promise<MobileOwnerPrivateResult> {
      assert.equal(request.kind, 'media-source');
      if (request.kind !== 'media-source') throw new Error('合成夹具只允许Source。');
      const source = request.request;
      if (source.operation === 'verify') { await lease.verify(); return { kind: 'mobile-source-ack', operation: 'verify', handle: source.handle, readId: null, quiet: true }; }
      if (source.operation === 'close-read') return { kind: 'mobile-source-ack', operation: 'close-read', handle: source.handle, readId: source.readId, quiet: true };
      if (source.operation !== 'read') throw new Error('合成夹具只允许read/verify/close-read。');
      trace.mobileRangeWindowCoreFacts(() => { calls.push('ticket-facts'); });
      // 保留Source新块路径的原4轮verify、每轮前后authority与单次64KiB read。
      await lease.verify();
      const iterator = lease.readSlice(source.start, source.start + source.maxBytes - 1, controller.signal);
      let chunk: IteratorResult<Buffer>;
      try { chunk = await iterator.next(); } finally { await iterator.return(undefined); }
      assert.equal(chunk.done, false); await lease.verify();
      return { kind: 'mobile-source-read', handle: source.handle, readId: source.readId, start: source.start, bytes: new Uint8Array(chunk.value!) };
    },
    async close(before) { await before?.(); controller.abort(); await pool.close(); },
    failureForError(id) { return responseFailure(id, 'INTERNAL_ERROR', '合成Source受控失败'); },
  };
  attachDatasetOwnerWorkerPort(ports.port2, { async prepare() { return domain; } });
  const identity = await endpoint.prepare(); await endpoint.commitBoot();
  assert.equal(identity.datasetId, datasetId);
  t.after(async () => { current = true; await endpoint.close(); ports.port1.close(); ports.port2.close(); });
  const handle = randomUUID(), readId = randomUUID();
  calls.length = 0;
  return { endpoint, identity, lease, file, descriptor, directory, bytes, calls, clientPackets, ownerPackets, fatal,
    injectOwner(raw: unknown) { nativeOwnerPost(raw); },
    controller, setCurrent(value: boolean) { current = value; },
    onVerify(work?: () => void | Promise<void>) { onVerify = work; },
    onRead(work?: () => void | Promise<void>) { onRead = work; },
    clientHook(work?: typeof clientHook) { clientHook = work; }, ownerHook(work?: typeof ownerHook) { ownerHook = work; },
    request(start = 0): MobileOwnerPrivateRequest { return { kind: 'media-source', datasetId, request: { operation: 'read', handle, readId, start, maxBytes: 65536 } }; },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function observed(t: TestContext, enabled = true, configure?: (f: Fixture) => void,
  requestOf: (f: Fixture) => MobileOwnerPrivateRequest = f => f.request(), diagnosticClock?: () => number) {
  const f = await fixture(t), frames: unknown[] = [];
  configure?.(f);
  const probe = trace.createMobileRangeWindowProbe({ enabled, windowSink() {}, ...(diagnosticClock ? { now: diagnosticClock, epochNow: diagnosticClock } : {}) });
  const context = probe.claim({ requestId: randomUUID(), method: 'GET', operation: 'getMediaAsset', range: 'bytes=0-262143' });
  const callId = randomUUID();
  const request = requestOf(f); assert.equal(request.kind, 'media-source');
  const operation = request.kind === 'media-source' ? request.request.operation : 'read';
  const role = operation === 'close-read' ? 'cleanup' : 'business';
  const transport = trace.withMobileRangeWindowContext(context, () => trace.mobileRangeWindowRpc(callId, operation, role, 'content.rpc.retained'));
  const receiver = trace.createMobileRangeWindowCoreReceiver({ sink(frame) { frames.push(frame); transport?.coreFrame(frame); },
    ...(diagnosticClock ? { now: diagnosticClock, epochNow: diagnosticClock } : {}) });
  const seed = transport?.seed(); if (seed) receiver.acceptSeed(seed);
  let result: MobileOwnerPrivateResult | undefined, error: unknown;
  try { result = await receiver.run(callId, operation, () => trace.mobileRangeWindowCoreObserve('core.source.execute', () => f.endpoint.mobileMain!(request))); }
  catch (caught) { error = caught; }
  finally { transport?.settle(callId, error !== undefined, error); probe.finish(context, { status: error ? null : 206, finished: !error, failed: !!error, ...(error ? { error } : {}) }); }
  return { ...f, frames, probe, snapshot: probe.snapshot(), result, error };
}

test('M55 原Owner往返与真实合成FD均成功时，Range必须带独立dispatch/命名FD/read阶段', { timeout: 10_000 }, async t => {
  const f = await observed(t);
  assert.ok(f.result && 'kind' in f.result && f.result.kind === 'mobile-source-read');
  assert.deepEqual(Buffer.from(f.result.bytes), f.bytes.subarray(0, 65536));
  const records = f.snapshot.requests[0]!.records;
  for (const stage of ['core.owner-source.rpc', 'owner.source.dispatch', 'owner.source.named-fd.verify', 'owner.source.fd.read']) {
    assert.ok(records.some(row => row.stage === stage), `缺少跨Owner实际阶段：${stage}`);
  }
  assert.equal(records.find(row => String(row.stage) === 'owner.source.named-fd.verify')!.count, 4);
  assert.equal(records.find(row => String(row.stage) === 'owner.source.fd.read')!.count, 1);
  assert.equal(records.find(row => row.stage === 'core.source.ticket-facts.composite')!.count, 1);
  assert.deepEqual(f.calls, ['ticket-facts', 'authority', 'named-fd', 'authority', 'authority', 'named-fd', 'authority',
    'authority', 'fd-read', 'authority', 'named-fd', 'authority', 'authority', 'named-fd', 'authority']);
  assert.deepEqual(f.fatal, []); assert.equal(f.snapshot.requests[0]!.pendingSpans, 0);
});

test('M55 默认关闭时原Source及FD行为相同，不新建Owner旁注', { timeout: 10_000 }, async t => {
  const f = await observed(t, false);
  assert.ok(f.result && 'kind' in f.result && f.result.kind === 'mobile-source-read'); assert.equal(f.result.bytes.byteLength, 65536);
  assert.equal(f.snapshot.requests.length, 0); assert.equal(f.frames.length, 0);
  assert.equal(f.clientPackets.some(raw => (raw as { type?: string }).type === 'mobile-range-window-owner-seed'), false);
  assert.equal(f.ownerPackets.some(raw => (raw as { type?: string }).type === 'mobile-range-window-owner'), false);
  assert.deepEqual(f.fatal, []);
});

test('M55 verify与实际read独立归因，原顺序与计数保持且Master预算不扩', { timeout: 10_000 }, async t => {
  let clock = 1000;
  t.mock.method(performance, 'now', () => clock);
  const f = await observed(t, true, f => { f.onVerify(() => { clock += 31; }); f.onRead(() => { clock += 17; }); });
  assert.equal(f.error, undefined);
  const row = f.snapshot.requests[0]!, verify = row.records.find(v => v.stage === 'owner.source.named-fd.verify')!;
  const read = row.records.find(v => v.stage === 'owner.source.fd.read')!;
  assert.equal(verify.count, 4); assert.equal(verify.durationMs, 124); assert.equal(verify.maxDurationMs, 31);
  assert.equal(read.count, 1); assert.equal(read.durationMs, 17); assert.equal(read.maxDurationMs, 17);
  assert.equal(row.records.find(v => v.stage === 'owner.source.dispatch')!.durationMs, 141);
  assert.equal(row.records.find(v => v.stage === 'core.owner-source.rpc')!.durationMs, 141);
  assert.equal(f.snapshot.maxRequests, 8); assert.equal(f.snapshot.maxRecordsPerRequest, 64);
  assert.equal(f.snapshot.maxRecords, 512); assert.equal(f.snapshot.maxSerializedBytes, 262144);
  assert.ok(trace.copyMobileRangeWindowSnapshot(f.snapshot)); assert.equal(row.pendingSpans, 0);
  const encoded = JSON.stringify(f.ownerPackets.filter(v => trace.isMobileRangeWindowOwnerWire(v, 'mobile-range-window-owner')));
  assert.equal(encoded.includes(f.directory), false); assert.equal(encoded.includes(f.descriptor.facts.asset.id), false);
  assert.equal(encoded.includes('synthetic.wav'), false);
});

test('M55 默认关闭不读任何新增诊断时钟', { timeout: 10_000 }, async t => {
  let clocks = 0;
  const f = await observed(t, false, undefined, f => f.request(), () => { clocks++; throw new Error('关闭时不可读诊断时钟'); });
  assert.equal(f.error, undefined); assert.equal(clocks, 0); assert.equal(f.frames.length, 0);
});

test('M55 seed/Owner帧丢失或post抛错均不影响原bytes、guard或自然关闭', { timeout: 15_000 }, async t => {
  for (const side of ['seed-drop', 'seed-throw', 'owner-drop', 'owner-throw'] as const) await t.test(side, async child => {
    const f = await observed(child, true, f => {
      const hook = (raw: unknown) => {
        const marker = side.startsWith('seed') ? 'mobile-range-window-owner-seed' : 'mobile-range-window-owner';
        if (!trace.isMobileRangeWindowOwnerWire(raw, marker)) return;
        if (side.endsWith('throw')) throw new Error('合成旁注sink拒绝');
        return 'drop' as const;
      };
      if (side.startsWith('seed')) f.clientHook(hook); else f.ownerHook(hook);
    });
    assert.equal(f.error, undefined); assert.ok(f.result && 'kind' in f.result && f.result.kind === 'mobile-source-read');
    assert.deepEqual(Buffer.from(f.result.bytes), f.bytes.subarray(0, 65536));
    assert.deepEqual(f.fatal, []); assert.equal(f.lease.resourceSnapshot().activeIo, 0);
    const records = f.snapshot.requests[0]!.records;
    assert.equal(records.some(v => v.stage === 'owner.source.fd.read'), false, '缺少Owner明细必须缺省，不可补0ms');
    assert.equal(records.find(v => v.stage === 'core.owner-source.rpc')!.count, 1);
    assert.equal(f.snapshot.requests[0]!.pendingSpans, 0);
    await f.endpoint.close(); assert.equal(f.lease.state, 'CLOSED'); assert.equal(f.file.handle.fd, -1);
  });
});

test('M55 错epoch/parent/operation/id与重复Owner帧不串入现请求', { timeout: 15_000 }, async t => {
  for (const changed of ['epoch', 'parent', 'operation', 'id', 'duplicate'] as const) await t.test(changed, async child => {
    const f = await observed(child, true, f => f.ownerHook(raw => {
      const original = trace.copyMobileRangeWindowOwnerFrame(raw); if (!original) return;
      const value = structuredClone(original);
      if (changed === 'epoch') value.epoch = randomUUID();
      if (changed === 'parent') value.parentId = randomUUID();
      if (changed === 'operation') {
        value.frame.operation = 'verify';
        value.frame.records = value.frame.records.filter(v => v.stage !== 'owner.source.fd.read').map(v => ({ ...v, kind: 'verify' }));
      }
      if (changed === 'id') {
        value.frame.id = randomUUID();
        const nonce = createHash('sha256').update('MusicBridge:range-window:content:1\0' + value.frame.id).digest('hex');
        value.frame.records = value.frame.records.map(v => ({ ...v, nonceSha256: nonce }));
      }
      assert.ok(trace.copyMobileRangeWindowOwnerFrame(value), '错绑定帧本身仍满足完整闭集形状');
      f.injectOwner(value); if (changed === 'duplicate') f.injectOwner(value);
      return 'drop';
    }));
    assert.equal(f.error, undefined); assert.ok(f.result && 'kind' in f.result && f.result.kind === 'mobile-source-read'); assert.deepEqual(f.fatal, []);
    const reads = f.snapshot.requests[0]!.records.filter(v => v.stage === 'owner.source.fd.read');
    if (changed === 'duplicate') { assert.equal(reads.length, 1); assert.equal(reads[0]!.count, 1); }
    else assert.equal(reads.length, 0);
  });
});

test('M55 业务回复后的迟帧与观察关闭不重新发布旧窗口', { timeout: 10_000 }, async t => {
  let late: unknown;
  const f = await observed(t, true, f => f.ownerHook(raw => {
    if (trace.isMobileRangeWindowOwnerWire(raw, 'mobile-range-window-owner')) { late = raw; return 'drop'; }
  }));
  assert.ok(late); const before = JSON.stringify(f.probe.snapshot());
  f.injectOwner(late); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(JSON.stringify(f.probe.snapshot()), before);
  f.probe.close(); f.injectOwner(late); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.probe.snapshot().requests[0]!.records.some(v => v.stage === 'owner.source.fd.read'), false);
  assert.deepEqual(f.fatal, []);
});

test('M55 read中取消与权威撤销保持原失败，FD操作收口及关闭仍真实等待', { timeout: 15_000 }, async t => {
  for (const failure of ['abort', 'revoke', 'verify-error'] as const) await t.test(failure, async child => {
    const f = await observed(child, true, f => {
      if (failure === 'abort') f.onRead(() => { f.controller.abort(); });
      if (failure === 'revoke') f.onRead(() => { f.setCurrent(false); });
      if (failure === 'verify-error') f.onVerify(() => { throw Object.assign(new Error('合成身份复核错误'), { code: 'SOURCE_CHANGED' }); });
    });
    assert.ok(f.error); assert.equal(f.result, undefined); assert.deepEqual(f.fatal, []);
    assert.equal(f.lease.resourceSnapshot().activeIo, 0);
    assert.ok(f.snapshot.requests[0]!.firstBusinessFailure);
    assert.equal(f.snapshot.requests[0]!.firstCleanupFailure, null);
    await f.endpoint.close(); assert.equal(f.lease.state, 'CLOSED'); assert.equal(f.file.handle.fd, -1);
  });
});

test('M55 原FD read未结算时close继续等待，旁注不制造quiet或提前关闭', { timeout: 10_000 }, async t => {
  let entered!: () => void, release!: () => void, fixtureValue: Fixture | undefined;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reading = observed(t, true, f => { fixtureValue = f; f.onRead(async () => { entered(); await gate; }); });
  await started; const f = fixtureValue!; let closed = false;
  const closing = f.lease.close().then(() => { closed = true; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(closed, false); assert.ok(f.lease.resourceSnapshot().activeIo > 0); assert.ok(f.file.handle.fd >= 0);
  } finally { release(); }
  const result = await reading; await closing;
  assert.ok(result.error); assert.equal(f.lease.state, 'CLOSED'); assert.equal(f.file.handle.fd, -1);
  assert.deepEqual(f.lease.resourceSnapshot(), { activeRequests: 0, activeIo: 0, timer: 0 });
});

function ownerSeed(ordinal = 1, id: string = randomUUID(), epoch: string = randomUUID()): trace.MobileRangeWindowOwnerSeed {
  return { type: 'mobile-range-window-owner-seed', epoch, parentId: randomUUID(), seed: {
    type: 'mobile-range-window-seed', schema: 2, id, requestSha256: ordinal.toString(16).padStart(64, '0'), ordinal,
    operation: 'read', retainedOrdinals: Array.from({ length: Math.min(8, ordinal) }, (_, index) => Math.max(1, ordinal - 7) + index),
  } };
}

test('M55 Owner旁注严格guard拒绝访问器/Proxy/原型/额外字段及数量超界', async t => {
  const valid = ownerSeed(); assert.ok(trace.copyMobileRangeWindowOwnerSeed(valid));
  let getters = 0, traps = 0;
  const accessor = { ...valid }; Object.defineProperty(accessor, 'epoch', { enumerable: true, get() { getters++; return valid.epoch; } });
  const proxy = new Proxy(valid, { ownKeys() { traps++; return Reflect.ownKeys(valid); }, getOwnPropertyDescriptor() { traps++; throw new Error('不可窥看Proxy'); } });
  const bad: unknown[] = [accessor, proxy, { ...valid, extra: true }, { ...valid, [Symbol('extra')]: true },
    Object.assign(Object.create({ inherited: true }), valid), { ...valid, seed: { ...valid.seed, ordinal: 4097 } },
    { ...valid, seed: { ...valid.seed, retainedOrdinals: Array.from({ length: 9 }, (_, i) => i + 1) } }];
  for (const value of bad) assert.equal(trace.copyMobileRangeWindowOwnerSeed(value), null);
  assert.equal(trace.isMobileRangeWindowOwnerWire(proxy, 'mobile-range-window-owner-seed'), false);
  assert.equal(getters, 0); assert.equal(traps, 0);
  const frames: trace.MobileRangeWindowOwnerFrame[] = [];
  const receiver = trace.createMobileRangeWindowOwnerReceiver({ sink(frame) { frames.push(frame); } });
  receiver.acceptSeed(valid, valid.epoch);
  await receiver.run(valid.epoch, valid.seed.id, 'read', () => trace.mobileRangeWindowCoreObserve('owner.source.dispatch', async () => undefined));
  const frame = frames[0]!; assert.ok(trace.copyMobileRangeWindowOwnerFrame(frame));
  const withGetter = { ...frame }; Object.defineProperty(withGetter, 'frame', { enumerable: true, get() { getters++; return frame.frame; } });
  for (const value of [withGetter, { ...frame, extra: true }, { ...frame, frame: { ...frame.frame, records: Array(9).fill(frame.frame.records[0]) } }]) {
    assert.equal(trace.copyMobileRangeWindowOwnerFrame(value), null);
  }
  assert.equal(getters, 0); receiver.close();
});

test('M55 同代seed仅消费一次，错代/错operation/关闭均只丢旁注且原work执行一次', async () => {
  for (const mode of ['valid', 'epoch', 'operation', 'closed', 'sink-error'] as const) {
    let works = 0, clocks = 0; const frames: unknown[] = [], seed = ownerSeed();
    const receiver = trace.createMobileRangeWindowOwnerReceiver({ now() { clocks++; return clocks; }, epochNow: () => 1000,
      sink(frame) { if (mode === 'sink-error') throw new Error('合成sink拒绝'); frames.push(frame); } });
    receiver.acceptSeed(seed, mode === 'epoch' ? randomUUID() : seed.epoch);
    if (mode === 'closed') receiver.close();
    const operation = mode === 'operation' ? 'verify' : 'read';
    const result = await receiver.run(seed.epoch, seed.seed.id, operation,
      () => trace.mobileRangeWindowCoreObserve('owner.source.dispatch', async () => { works++; return 42; }));
    assert.equal(result, 42); assert.equal(works, 1);
    assert.equal(frames.length, mode === 'valid' ? 1 : 0);
    if (['epoch', 'operation', 'closed'].includes(mode)) assert.equal(clocks, 0);
    receiver.acceptSeed(seed, mode === 'epoch' ? randomUUID() : seed.epoch);
    await receiver.run(seed.epoch, seed.seed.id, operation, async () => { works++; });
    assert.equal(works, 2); assert.equal(frames.length, mode === 'valid' ? 1 : 0);
    receiver.close();
  }
});

test('M55 Owner并发seed16、同窗hop16及活窗8预算不因旁注扩大', async () => {
  const frames: trace.MobileRangeWindowOwnerFrame[] = [], seed = ownerSeed(), receiver = trace.createMobileRangeWindowOwnerReceiver({ sink(frame) { frames.push(frame); } });
  const seeds = Array.from({ length: 17 }, () => ({ ...seed, seed: { ...seed.seed, id: randomUUID() } }));
  for (const value of seeds) receiver.acceptSeed(value, seed.epoch);
  let work = 0;
  for (const value of seeds) await receiver.run(seed.epoch, value.seed.id, 'read', () => trace.mobileRangeWindowCoreObserve('owner.source.dispatch', async () => { work++; }));
  assert.equal(work, 17); assert.equal(frames.length, 16);
  const seventeenth = { ...seed, seed: { ...seed.seed, id: randomUUID() } };
  receiver.acceptSeed(seventeenth, seed.epoch);
  await receiver.run(seed.epoch, seventeenth.seed.id, 'read', async () => { work++; });
  assert.equal(work, 18); assert.equal(frames.length, 16); receiver.close();
  const windows: trace.MobileRangeWindowOwnerFrame[] = [], across = trace.createMobileRangeWindowOwnerReceiver({ sink(frame) { windows.push(frame); } });
  const requests = Array.from({ length: 9 }, (_, index) => ownerSeed(index + 1, randomUUID(), seed.epoch));
  for (const value of requests) across.acceptSeed(value, seed.epoch);
  for (const value of requests) await across.run(seed.epoch, value.seed.id, 'read', () => trace.mobileRangeWindowCoreObserve('owner.source.dispatch', async () => undefined));
  assert.equal(windows.length, 8); across.close();
});

test('M55 旁注时钟异常保留原值，缺失时间为null，close-read错误只属于cleanup', async () => {
  const frames: trace.MobileRangeWindowOwnerFrame[] = [], input = ownerSeed(); input.seed.operation = 'close-read';
  const receiver = trace.createMobileRangeWindowOwnerReceiver({ now() { throw new Error('合成时钟失效'); }, epochNow() { throw new Error('合成epoch失效'); }, sink(frame) { frames.push(frame); } });
  receiver.acceptSeed(input, input.epoch);
  const failure = Object.assign(new Error('合成原cleanup错误'), { code: 'RELEASE_FAILED' });
  await assert.rejects(receiver.run(input.epoch, input.seed.id, 'close-read', () => trace.mobileRangeWindowCoreObserve('owner.source.dispatch', () => Promise.reject(failure))), error => error === failure);
  assert.equal(frames.length, 1); assert.ok(trace.copyMobileRangeWindowOwnerFrame(frames[0]));
  assert.equal(frames[0]!.frame.clockFault, true); assert.equal(frames[0]!.frame.epochMs, null);
  const row = frames[0]!.frame.records[0]!;
  assert.equal(row.role, 'cleanup'); assert.equal(row.phase, 'reject'); assert.equal(row.code, 'RELEASE_FAILED');
  assert.equal(row.durationMs, null); assert.equal(row.maxDurationMs, null); receiver.close();
});

test('M55 默认512/64/4MiB真实Owner Worker：完整256K为4read/17身份复核，原ACK与FD自然关闭', { timeout: 15_000 }, async t => {
  const file = await fixture(t), worker = new Worker(new URL('./range-window-owner-worker.mjs', import.meta.url), {
    execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64, stackSizeMb: 4 },
    workerData: { descriptor: file.descriptor, datasetId: randomUUID() },
  });
  t.after(async () => { if (worker.threadId !== -1) await worker.terminate(); });
  const exited = once(worker, 'exit'), fatal: string[] = [], endpoint = createDatasetOwnerClient({ worker, onFatal: reason => fatal.push(reason) });
  const identity = await endpoint.prepare(); await endpoint.commitBoot();
  const probe = trace.createMobileRangeWindowProbe({ enabled: true, continuous: true, windowSink() {} });
  const context = probe.claim({ requestId: randomUUID(), method: 'GET', operation: 'getMediaAsset', range: 'bytes=0-262143' }); assert.ok(context);
  const transports = new Map<string, NonNullable<ReturnType<typeof trace.mobileRangeWindowRpc>>>();
  const receiver = trace.createMobileRangeWindowCoreReceiver({ sink(frame) {
    assert.ok(trace.copyMobileRangeWindowCoreFrame(frame)); transports.get(frame.id)!.coreFrame(frame);
  } });
  const base = file.request(); assert.ok(base.kind === 'media-source' && base.request.operation === 'read');
  const read = base.request;
  async function run(request: Extract<MobileOwnerPrivateRequest, { kind: 'media-source' }>['request']) {
    const id = randomUUID(), role = request.operation === 'close-read' ? 'cleanup' : 'business';
    const transport = trace.withMobileRangeWindowContext(context, () => trace.mobileRangeWindowRpc(id, request.operation, role, 'content.rpc.retained'))!;
    transports.set(id, transport); const seed = transport.seed(); assert.ok(seed); receiver.acceptSeed(seed);
    let result: MobileOwnerPrivateResult;
    try { result = await receiver.run(id, request.operation, () => trace.mobileRangeWindowCoreObserve('core.source.execute', () => endpoint.mobileMain!({ kind: 'media-source', datasetId: identity.datasetId, request }))); }
    catch (error) { transport.settle(id, true, error); throw error; }
    transport.settle(id); return result;
  }
  await run({ operation: 'verify', handle: read.handle });
  const chunks: Buffer[] = [];
  for (let index = 0; index < 4; index++) {
    const result = await run({ ...read, start: index * 65536 });
    assert.ok('kind' in result && result.kind === 'mobile-source-read'); chunks.push(Buffer.from(result.bytes));
  }
  await run({ operation: 'close-read', handle: read.handle, readId: read.readId });
  assert.deepEqual(Buffer.concat(chunks), file.bytes);
  probe.finish(context, { status: 206, finished: true, failed: false });
  const snapshot = probe.snapshot(); assert.ok(trace.copyMobileRangeContinuousSnapshot(snapshot));
  const records = snapshot.requests[0]!.records;
  assert.equal(records.filter(v => v.stage === 'owner.source.named-fd.verify').reduce((count, v) => count + v.count, 0), 17);
  assert.equal(records.find(v => v.stage === 'owner.source.fd.read')!.count, 4);
  assert.equal(records.filter(v => v.stage === 'owner.source.dispatch').reduce((count, v) => count + v.count, 0), 6);
  assert.equal(records.filter(v => v.stage === 'core.owner-source.rpc').reduce((count, v) => count + v.count, 0), 6);
  assert.equal(snapshot.requests[0]!.pendingSpans, 0); assert.equal(snapshot.malformedFrames, 0); assert.equal(snapshot.unmatchedFrames, 0);
  await endpoint.close(); assert.deepEqual(await exited, [0]); assert.equal(worker.threadId, -1); assert.deepEqual(fatal, []);
});
