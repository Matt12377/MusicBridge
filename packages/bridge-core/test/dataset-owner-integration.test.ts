import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Worker, MessageChannel, type MessagePort } from 'node:worker_threads';
import { validateIpcResponseForCommand, type IpcRequest, type IpcResponse } from '@music-bridge/contracts';
import { createDatasetOwnerClient } from '../src/collection/dataset-owner-client.js';
import { DatasetOwnerTransportError } from '../src/collection/dataset-owner-protocol.js';
import { createDatasetRoonProjectionGateway } from '../src/collection/dataset-roon-projection.js';
import { createSyntheticRoonLibrary } from '../src/roon/synthetic-library.js';
import { createTestBridgeRuntime } from '../src/runtime.js';
import { attachCoreRuntimePort } from '../src/utility-main.js';

const page = { offset: 0, limit: 25 };
function owner(dataDirectory: string, options: { syntheticBusyMs?: number; crashAfterReceive?: boolean; projection?: ReturnType<typeof createDatasetRoonProjectionGateway>['handler'] } = {}) {
  const signals = new Int32Array(new SharedArrayBuffer(12));
  const reasons: string[] = [];
  const worker = new Worker(new URL('./helpers/dataset-owner-domain-fixture.ts', import.meta.url), {
    execArgv: ['--import', 'tsx'], workerData: { dataDirectory, signals: signals.buffer,
      ...(options.syntheticBusyMs ? { syntheticBusyMs: options.syntheticBusyMs } : {}),
      ...(options.crashAfterReceive ? { crashAfterReceive: true } : {}) },
  });
  return { signals, worker, reasons, endpoint: createDatasetOwnerClient({ worker, onFatal: reason => reasons.push(reason),
    ...(options.projection ? { projection: options.projection } : {}) }) };
}
async function directory(t: test.TestContext) {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'mbp-008-integration-test-'));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  return dataDirectory;
}
function request(command: IpcRequest['command'], payload: unknown, datasetId: string): IpcRequest {
  return { version: 1, id: randomUUID(), command, payload, expectedDatasetId: datasetId } as IpcRequest;
}
function rpc(port: MessagePort, message: IpcRequest): Promise<IpcResponse> {
  return new Promise(resolve => {
    const listener = (value: IpcResponse) => { if (value.id !== message.id) return; port.off('message', listener); resolve(value); };
    port.on('message', listener); port.postMessage(message);
  });
}

test('实际两库owner承载SQL时父Utility播放控制不等领域队列，关闭等待自然退出', { timeout: 20_000 }, async t => {
  const f = owner(await directory(t), { syntheticBusyMs: 120 });
  const identity = await f.endpoint.prepare();
  const runtime = createTestBridgeRuntime({ datasetOwnerEndpoint: f.endpoint });
  assert.equal(runtime.collection, undefined);
  assert.equal(runtime.commandOutbox, undefined);
  const ports = new MessageChannel();
  t.after(() => { ports.port1.close(); ports.port2.close(); });
  t.after(() => runtime.shutdown());
  await attachCoreRuntimePort({ on: (_event, listener) => ports.port1.on('message', data => listener({ data })), start() { ports.port1.start(); }, postMessage: value => ports.port1.postMessage(value) }, runtime, { beforeReady: () => f.endpoint.commitBoot() });
  const reading = rpc(ports.port2, request('collection.list', { page }, identity.datasetId));
  while (Atomics.load(f.signals, 0) === 0) await new Promise(resolve => setImmediate(resolve));
  const pausing = await rpc(ports.port2, request('playback.pause', {}, identity.datasetId));
  assert.equal(pausing.ok, true);
  assert.equal(validateIpcResponseForCommand(pausing, 'playback.pause').ok, true);
  assert.equal(Atomics.load(f.signals, 1), 0, '暂停回执必须早于合成繁忙领域读取结束');
  const result = await reading;
  assert.equal(validateIpcResponseForCommand(result, 'collection.list').ok, true);
  const badScope = await rpc(ports.port2, request('playback.pause', {}, randomUUID()));
  assert.equal(badScope.ok, false);
  if (!badScope.ok) assert.equal(badScope.error.code, 'OUTBOX_SCOPE_MISMATCH');
  const exit = once(f.worker, 'exit');
  await runtime.shutdown();
  assert.deepEqual(await exit, [0]);
  assert.equal(Atomics.load(f.signals, 2), 2);
  assert.deepEqual(f.reasons, []);
});

test('owner真实写已落库而回执断链时保留unknown，冷启原commandId查询不会重复入库', { timeout: 20_000 }, async t => {
  const dataDirectory = await directory(t);
  const first = owner(dataDirectory, { crashAfterReceive: true });
  const identity = await first.endpoint.prepare(); await first.endpoint.commitBoot();
  const receive = request('collection.receive', { commandId: randomUUID(), model: { brand: '合成', name: '断链收据', edition: '测试', year: 1990, format: 'cassette', tapeType: 'II', identification: 'verified' }, lengthMinutes: 60, quantities: { openedBlank: 1, sealedBlank: 0, legacyUsed: 0, unclassified: 0 } }, identity.datasetId);
  const exit = once(first.worker, 'exit');
  await assert.rejects(first.endpoint.dispatch(receive), error => error instanceof DatasetOwnerTransportError && error.outcome === 'unknown' && error.requestId === receive.id);
  assert.deepEqual(await exit, [19]);
  assert.deepEqual(first.reasons, ['worker-exit']);
  const second = owner(dataDirectory); t.after(() => second.endpoint.close());
  assert.equal((await second.endpoint.prepare()).datasetId, identity.datasetId);
  await second.endpoint.commitBoot();
  const listBefore = await second.endpoint.dispatch(request('collection.list', { page }, identity.datasetId));
  const receipt = await second.endpoint.dispatch(receive);
  assert.equal(validateIpcResponseForCommand({ version: 1, id: receive.id, ok: true, result: receipt }, 'collection.receive').ok, true);
  const listAfter = await second.endpoint.dispatch(request('collection.list', { page }, identity.datasetId));
  assert.deepEqual(listBefore, listAfter);
  assert.equal((listAfter as { total: number }).total, 1);
  await second.endpoint.close();
  assert.equal(Atomics.load(second.signals, 2), 2);
});

test('父Roon元数据经实际线程注册关联，公开DTO与原持久关联合同相同', { timeout: 20_000 }, async t => {
  const library = createSyntheticRoonLibrary();
  const gateway = createDatasetRoonProjectionGateway(() => library);
  t.after(() => gateway.close());
  const f = owner(await directory(t), { projection: gateway.handler }); t.after(() => f.endpoint.close());
  const identity = await f.endpoint.prepare(); await f.endpoint.commitBoot();
  const reference = (await library.browseAlbums(page)).items[0]!.reference;
  const registration = request('physicalLinks.register', { commandId: randomUUID(), reference, physicalAbsenceConfirmed: true, userConfirmed: true }, identity.datasetId);
  const result = await f.endpoint.dispatch(registration);
  assert.equal(validateIpcResponseForCommand({ version: 1, id: registration.id, ok: true, result }, registration.command).ok, true);
  assert.deepEqual(await f.endpoint.dispatch(registration), result);
  assert.doesNotMatch(JSON.stringify(result), /itemKey|sessionId|musicbridge-v2/u);
  await f.endpoint.close();
});

import { attachDatasetOwnerWorkerPort as attachContext772Worker } from '../src/collection/dataset-owner-worker.js';
import { createDatasetWorkbenchAssembler as assembleContext772, datasetWorkbenchControl as controlContext772,
  datasetWorkbenchFrames as framesContext772, datasetWorkbenchJson as jsonContext772, datasetWorkbenchSha as shaContext772,
  isDatasetOwnerIdentity as identityContext772, isDatasetOwnerResponse as responseContext772,
  isDatasetWorkbenchFrame as frameContext772, sameDatasetWorkbenchMeta as sameContext772,
  type DatasetOwnerRequest as RequestContext772, type DatasetOwnerResponse as ResponseContext772,
  type DatasetWorkbenchContext as Context772, type DatasetWorkbenchFrame as FrameContext772,
  type DatasetWorkbenchMeta as MetaContext772, type OwnedDatasetDomain as DomainContext772 } from '../src/collection/dataset-owner-protocol.js';
import { responseFailure as failureContext772 } from '../src/shared/ipc-failure.js';

function deferredContext772() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

/** 生产Worker端函数＋真实MessageChannel；领域工作受控，不冒实际Worker进程/数据库/Main现场证据。 */
async function fixtureContext772(t: test.TestContext, observe?: (value: unknown) => void) {
  const ports = new MessageChannel(), epoch = randomUUID(), datasetId = randomUUID(), packets: unknown[] = [];
  const listeners = new Set<() => void>(), releases = new Set<() => void>(), portClosed = deferredContext772(), workbenchClosing = deferredContext772();
  const state = { contextCompleted: 0, closeWorkbench: 0, closeEntered: 0, closed: 0 };
  let sequence = 0, disconnected = false, closure: Promise<ResponseContext772> | undefined;
  let readContext: () => Promise<Context772> = async () => ({ epoch, datasetId, ready: true });
  const nativePost = ports.port2.postMessage.bind(ports.port2);
  t.mock.method(ports.port2, 'postMessage', (value: unknown) => { observe?.(value); return nativePost(value); });
  ports.port1.on('message', (value: unknown) => { packets.push(value); for (const notify of [...listeners]) notify(); });
  ports.port1.once('close', () => { disconnected = true; portClosed.resolve(); });
  function take<T>(predicate: (value: unknown) => value is T): Promise<T> {
    const prior = packets.find(predicate);
    if (prior !== undefined) return Promise.resolve(prior);
    return new Promise<T>(resolve => {
      const notify = () => { const found = packets.find(predicate); if (found !== undefined) { listeners.delete(notify); resolve(found); } };
      listeners.add(notify); notify();
    });
  }
  const domain: DomainContext772 = {
    datasetId, async dispatch() { return undefined; }, commitBoot() {},
    async workbenchContext() { try { return await readContext(); } finally { state.contextCompleted++; } },
    async dispatchWorkbench() { throw new Error('context772夹具未授权execute'); },
    async dispatchWorkbenchOwner() { throw new Error('context772夹具未授权owner'); },
    async closeWorkbench() { state.closeWorkbench++; workbenchClosing.resolve(); },
    async close(before) { state.closeEntered++; await before?.(); state.closed++; },
    failureForError: id => failureContext772(id, 'INTERNAL_ERROR', '受控Worker组件失败'),
  };
  attachContext772Worker(ports.port2, { async prepare(actualEpoch) { assert.equal(actualEpoch, epoch); return domain; } });
  function command(operation: 'prepare' | 'commitBoot' | 'close'): Promise<ResponseContext772> {
    const request: RequestContext772 = { version: 1, type: 'request', epoch, requestId: randomUUID(), sequence: ++sequence, operation };
    const response = take((value): value is ResponseContext772 => responseContext772(value)
      && value.epoch === epoch && value.requestId === request.requestId && value.operation === operation);
    ports.port1.postMessage(request); return response;
  }
  const close = () => { closure ??= command('close'); return closure; };
  t.after(async () => {
    for (const release of releases) release();
    try { if (!disconnected) { const response = await close(); assert.equal(response.ok, true); await portClosed.promise; } }
    finally { ports.port1.close(); ports.port2.close(); }
  });
  const prepared = await command('prepare');
  assert.ok(prepared.ok); assert.ok(identityContext772(prepared.result)); assert.deepEqual(prepared.result, { epoch, datasetId });
  assert.equal((await command('commitBoot')).ok, true);
  function send(kind: MetaContext772['kind'], duration = 2000): MetaContext772 {
    const body = {}, meta: MetaContext772 = { id: randomUUID(), epoch, datasetId, sequence: ++sequence, kind,
      requestSha256: shaContext772(jsonContext772(body)), expiresAtMs: Date.now() + duration };
    for (const frame of framesContext772(meta, 'request', body)) ports.port1.postMessage(frame);
    return meta;
  }
  return { state, epoch, datasetId, close, portClosed: portClosed.promise, workbenchClosing: workbenchClosing.promise,
    barrier() { return command('commitBoot'); },
    setContext(work: () => Promise<Context772>) { readContext = work; }, releaseOnCleanup(release: () => void) { releases.add(release); },
    send, cancel(meta: MetaContext772) { ports.port1.postMessage(controlContext772(meta, 'cancel')); },
    frames(meta: MetaContext772): FrameContext772[] { return packets.filter((value): value is FrameContext772 => frameContext772(value) && sameContext772(value, meta)); },
    frame(meta: MetaContext772, part: FrameContext772['part']) { return take((value): value is FrameContext772 => frameContext772(value) && sameContext772(value, meta) && value.part === part); },
    hasCloseResponse() { return packets.some(value => responseContext772(value) && value.operation === 'close'); },
  };
}

test('辅助context772：完整end后清原timer再settled，32次成功不积留flight且非context无新增ACK', { timeout: 10_000 }, async t => {
  const timeline: { id: string | null; event: string }[] = [], cleared: Parameters<typeof clearTimeout>[0][] = [];
  const nativeClear = globalThis.clearTimeout;
  const clearObserver = t.mock.method(globalThis, 'clearTimeout', (...args: Parameters<typeof clearTimeout>) => {
    cleared.push(args[0]); timeline.push({ id: null, event: 'clearTimeout' }); return nativeClear(...args);
  });
  t.after(() => clearObserver.mock.restore());
  const f = await fixtureContext772(t, value => { if (frameContext772(value)) timeline.push({ id: value.id, event: value.part }); });
  for (let index = 0; index < 32; index++) {
    const meta = f.send('context');
    await f.frame(meta, 'end'); assert.equal((await f.barrier()).ok, true);
    const actual = f.frames(meta);
    assert.deepEqual(actual.map(frame => frame.part), ['begin', 'data', 'end', 'settled']);
    assert.ok(actual.every(frame => sameContext772(frame, meta)));
    const assembler = assembleContext772(meta, 'response'); let result: unknown;
    for (const frame of actual) if (frame.part !== 'settled') result = assembler.accept(frame);
    assert.deepEqual(result, { epoch: f.epoch, datasetId: f.datasetId, ready: true });
    const end = timeline.findIndex(row => row.id === meta.id && row.event === 'end');
    const settled = timeline.findIndex(row => row.id === meta.id && row.event === 'settled');
    assert.ok(end >= 0 && settled > end);
    assert.ok(timeline.slice(end + 1, settled).some(row => row.event === 'clearTimeout'), '原实际timer须在end之后、settled之前清理');
  }
  assert.equal(f.state.contextCompleted, 32);
  assert.equal(cleared.length, 32);
  const drain = f.send('drain'); await f.frame(drain, 'end');
  const closed = await f.close(); assert.equal(closed.ok, true); await f.portClosed;
  assert.deepEqual(f.frames(drain).map(frame => frame.part), ['begin', 'data', 'end']);
  assert.equal(f.state.closeWorkbench, 1); assert.equal(f.state.closed, 1);
});

test('辅助context772：取消与原期限先失败而不提前settled，领域失败仍待本task结束后原ACK', { timeout: 10_000 }, async t => {
  for (const mode of ['cancel', 'timeout', 'failure'] as const) {
    const entered = deferredContext772(), held = deferredContext772();
    const f = await fixtureContext772(t); f.releaseOnCleanup(held.resolve);
    f.setContext(async () => { entered.resolve(); await held.promise;
      if (mode === 'failure') throw new Error('受控context领域原失败');
      return { epoch: f.epoch, datasetId: f.datasetId, ready: true };
    });
    const meta = f.send('context', mode === 'timeout' ? 120 : 2000); await entered.promise;
    if (mode === 'cancel') f.cancel(meta);
    if (mode === 'failure') held.resolve();
    const failure = await f.frame(meta, 'failure'); assert.ok(failure.part === 'failure');
    assert.equal(failure.code, mode === 'failure' ? 'NOT_READY' : 'TIMEOUT');
    if (mode !== 'failure') {
      assert.equal(f.state.contextCompleted, 0);
      assert.equal(f.frames(meta).some(frame => frame.part === 'settled'), false, '取消/超时不能用caller拒绝冒实际task收口');
      held.resolve();
    }
    await f.frame(meta, 'settled');
    assert.equal(f.state.contextCompleted, 1);
    assert.deepEqual(f.frames(meta).map(frame => frame.part), ['failure', 'settled']);
    assert.equal((await f.close()).ok, true); await f.portClosed; assert.equal(f.state.closed, 1);
  }
});

test('辅助context772：close等已取消但仍owned的context真实完成，原settled先于closed与port关闭', { timeout: 10_000 }, async t => {
  const entered = deferredContext772(), held = deferredContext772(), publication: string[] = [];
  const f = await fixtureContext772(t, value => {
    if (frameContext772(value) && value.part === 'settled') publication.push('settled');
    if (responseContext772(value) && value.operation === 'close') publication.push('closed');
  });
  f.releaseOnCleanup(held.resolve);
  f.setContext(async () => { entered.resolve(); await held.promise; return { epoch: f.epoch, datasetId: f.datasetId, ready: true }; });
  const meta = f.send('context'); await entered.promise; f.cancel(meta); await f.frame(meta, 'failure');
  const closing = f.close(); await f.workbenchClosing;
  assert.equal(f.state.contextCompleted, 0); assert.equal(f.state.closed, 0); assert.equal(f.hasCloseResponse(), false);
  assert.equal(f.frames(meta).some(frame => frame.part === 'settled'), false);
  held.resolve(); await f.frame(meta, 'settled'); const closed = await closing;
  assert.equal(closed.ok, true); await f.portClosed;
  assert.deepEqual(publication, ['settled', 'closed']);
  assert.equal(f.state.contextCompleted, 1); assert.equal(f.state.closeEntered, 1); assert.equal(f.state.closed, 1);
});

test('辅助context772：成功end之后settled发布断链沿原abandon闭口，不把post失败当已收到quiet', { timeout: 10_000 }, async t => {
  let postFailures = 0;
  const f = await fixtureContext772(t, value => {
    if (frameContext772(value) && value.kind === 'context' && value.part === 'settled') {
      postFailures++; throw new Error('受控实际MessagePort.postMessage失败');
    }
  });
  const meta = f.send('context'); await f.frame(meta, 'end');
  assert.equal(postFailures, 1);
  await f.portClosed;
  assert.deepEqual(f.frames(meta).map(frame => frame.part), ['begin', 'data', 'end']);
  assert.equal(f.frames(meta).some(frame => frame.part === 'settled'), false);
  assert.equal(f.state.contextCompleted, 1); assert.equal(f.state.closeWorkbench, 1);
  assert.equal(f.state.closeEntered, 1); assert.equal(f.state.closed, 1);
});
