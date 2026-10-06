import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { MessageChannel, Worker } from 'node:worker_threads';
import { validateIpcRequest, validateIpcInternalRequest, type IpcCommand, type IpcRequest, type IpcResponse } from '@music-bridge/contracts';
import { buildStoragePolicy } from '../../../../apps/desktop/scripts/build-storage-root.mjs';
import { loadFreshMetadataReader } from '../helpers/mbrs003-audio-fixtures.js';
import { attachCoreRuntimePort, type UtilityPort, type CoreRuntimeForIpc } from '../../src/utility-main.js';
import { createDatasetOwnerClient } from '../../src/collection/dataset-owner-client.js';
import { ownerRecord } from '../../src/collection/dataset-owner-protocol.js';

test('MBRS003 utility：真实Owner client/Worker内部批路由，普通完整校验和坏payload零转发', { timeout: 60_000 }, async t => {
  // 明确消费主控新编译Reader，不自行构建或用旧dist作为本轮源证据。
  await loadFreshMetadataReader();
  const temporary = process.env.TMPDIR;
  assert.ok(temporary && path.isAbsolute(temporary));
  const policy = buildStoragePolicy();
  policy.check(temporary, { mustExist: true });
  const directory = await mkdtemp(path.join(temporary, 'musicbridge-mbrs003-routing-'));
  await chmod(directory, 0o700);
  policy.check(directory, { mustExist: true });
  const worker = new Worker(new URL('../helpers/dataset-owner-fixture.ts', import.meta.url), {
    execArgv: ['--import', 'tsx'], workerData: { mode: 'scan-real', dataDirectory: directory },
  });
  const endpoint = createDatasetOwnerClient({ worker, onFatal: () => {}, async projection() {
    throw new Error('本测试不创建扫描任务或读取媒体，不应请求媒体准入。');
  } });
  const channel = new MessageChannel();
  t.after(async () => {
    try {
      if (worker.threadId !== -1) await endpoint.close();
      assert.equal(worker.threadId, -1, '实际Owner Worker必须退出，不能把close请求当join');
    } finally {
      channel.port1.close(); channel.port2.close();
      if (worker.threadId !== -1) await worker.terminate();
    }
  });
  const identity = await endpoint.prepare();
  await endpoint.commitBoot();

  // spy委托原client方法及真实Worker发送，不替换Owner/领域/Repository行为。
  const calls: Array<{ operation: 'dispatch' | 'dispatchInternal'; command: string }> = [];
  const posted: Array<{ operation: unknown; command: unknown }> = [];
  const ordinary = endpoint.dispatch.bind(endpoint), internal = endpoint.dispatchInternal!.bind(endpoint);
  endpoint.dispatch = request => { calls.push({ operation: 'dispatch', command: request.command }); return ordinary(request); };
  endpoint.dispatchInternal = request => { calls.push({ operation: 'dispatchInternal', command: request.command }); return internal(request); };
  const realPost = worker.postMessage.bind(worker);
  worker.postMessage = message => {
    if (ownerRecord(message) && message.type === 'request' && ownerRecord(message.request)) {
      posted.push({ operation: message.operation, command: message.request.command });
    }
    realPost(message);
  };
  let inbound: ((event: { data: unknown }) => void) | undefined;
  const port: UtilityPort = {
    on(event, listener) { assert.equal(event, 'message'); inbound = listener; channel.port1.on('message', data => listener({ data })); },
    start() { channel.port1.start(); },
    postMessage(message) { channel.port1.postMessage(message); },
  };
  // 这里只替代Core生命周期壳；数据路径仍为实际utility→client→Worker→领域。
  const runtime = {
    datasetOwnerEndpoint: endpoint,
    async start() {},
    getState() { return { runtime: 'ready', roon: 'disconnected', provider: 'missing', activeStreamCount: 0, activePlaybackPresent: false }; },
  } as unknown as CoreRuntimeForIpc;
  const waiting = new Map<string, (response: IpcResponse) => void>();
  channel.port2.on('message', message => {
    if (ownerRecord(message) && typeof message.id === 'string' && typeof message.ok === 'boolean') waiting.get(message.id)?.(message as unknown as IpcResponse);
  });
  channel.port2.start();
  await attachCoreRuntimePort(port, runtime);
  const body = (command: IpcCommand, payload: unknown, scope: string | undefined = identity.datasetId): IpcRequest => ({
    version: 1, id: randomUUID(), command, payload, ...(scope ? { expectedDatasetId: scope } : {}),
  });
  function rpc(request: IpcRequest, retainRawHiddenKeys = false): Promise<IpcResponse> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(request.id); reject(new Error('真实utility/Owner响应诊断期限5秒')); }, 5000);
      waiting.set(request.id, response => { clearTimeout(timer); waiting.delete(request.id); resolve(response); });
      if (retainRawHiddenKeys) {
        // structured clone会丢弃非枚举字段；此项直接调用已注册的实际listener，专核原始validator边界。
        assert.ok(inbound); inbound({ data: request });
      } else channel.port2.postMessage(request);
    });
  }
  const page = await rpc(body('localScan.page', { offset: 0, limit: 200 }));
  assert.equal(page.ok, true);
  if (page.ok) assert.deepEqual(page.result, { offset: 0, limit: 200, total: 0, hasMore: false, items: [] });
  assert.deepEqual(calls, [{ operation: 'dispatch', command: 'localScan.page' }]);
  assert.deepEqual(posted, [{ operation: 'dispatch', command: 'localScan.page' }]);

  // 合法批但job不存在：真实领域拒绝是正控制，不虚造扫描状态/成功提交。
  // 路由断言要求到达真正dispatchInternal和Worker envelope，当前遗漏分支会有效失败。
  const jobId = randomUUID(), batchId = randomUUID();
  const requests = [
    body('localScan.prepareBatch', { commandId: randomUUID(), jobId, batch: {
      batchId, jobId, expectedJobRevision: '1', checkpointBefore: null, items: [], frontier: [], completed: true,
    } }),
    body('localScan.commitBatch', { commandId: randomUUID(), jobId, batchId, expectedRevision: '1' }),
  ];
  for (const request of requests) {
    assert.equal(validateIpcInternalRequest(request).ok, true, '请求必须真实通过完整internal合同');
    assert.equal(validateIpcRequest(request).ok, false, '普通validator继续拒绝可信批');
    await assert.rejects(ordinary(request), '原Owner client普通入口也必须拒绝可信批');
    const before: number = posted.length, beforeCalls: number = calls.length;
    const response = await rpc(request);
    assert.equal(response.ok, false, '不存在任务的真实领域不会提交');
    if (!response.ok) assert.notEqual(response.error.code, 'INVALID_IPC_REQUEST', '完整合同通过后才允许到领域冲突');
    assert.deepEqual(calls.slice(beforeCalls), [{ operation: 'dispatchInternal', command: request.command }]);
    assert.deepEqual(posted.slice(before), [{ operation: 'dispatchInternal', command: request.command }]);
  }
  const hiddenPage = { offset: 0, limit: 200 };
  Object.defineProperty(hiddenPage, 'internalPath', { value: '禁止隐藏字段', enumerable: false });
  const missingScope = body('localScan.page', { offset: 0, limit: 1 });
  delete missingScope.expectedDatasetId;
  const rejected = [
    { request: body('localScan.page', { offset: 0, limit: 201 }), raw: false },
    { request: body('localScan.start', { commandId: randomUUID(), libraryRootId: randomUUID(), expectedRootRevision: '1', path: '禁止额外字段' }), raw: false },
    { request: missingScope, raw: false },
    { request: body('localScan.page', hiddenPage), raw: true },
    { request: body('localScan.prepareBatch', { commandId: randomUUID(), jobId, batch: { ...((requests[0]!.payload as { batch: object }).batch), path: '禁止额外字段' } }), raw: false },
    { request: body('localScan.commitBatch', { commandId: randomUUID(), jobId, batchId, expectedRevision: '1', epoch: randomUUID() }), raw: false },
  ];
  for (const item of rejected) {
    const before: number = calls.length, beforePosted: number = posted.length;
    const response = await rpc(item.request, item.raw);
    assert.equal(response.ok, false);
    if (!response.ok) assert.equal(response.error.code, 'INVALID_IPC_REQUEST');
    assert.equal(calls.length, before, '完整utility validator先拒绝，不能依赖Owner补拒绝');
    assert.equal(posted.length, beforePosted, '坏payload零真实Worker转发');
  }
  const crossScope = await rpc(body('localScan.page', { offset: 0, limit: 1 }, randomUUID()));
  assert.equal(crossScope.ok, false, '合法但跨dataset仍必须由真实Owner拒绝');
  await endpoint.close();
  assert.equal(worker.threadId, -1);
});
