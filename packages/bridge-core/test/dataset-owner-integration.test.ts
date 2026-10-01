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
