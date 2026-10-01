import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { Worker } from 'node:worker_threads';
import test from 'node:test';
import { validateIpcRequest, type IpcRequest } from '@music-bridge/contracts';
import { createDatasetOwnerClient } from '../src/collection/dataset-owner-client.js';
import { DatasetOwnerDispatchError, DatasetOwnerTransportError, isDatasetOwnerRequest, type DatasetOwnerFatalReason, type DatasetOwnerProjectionHandler, type DatasetOwnerRequest } from '../src/collection/dataset-owner-protocol.js';

const begin = (): IpcRequest => ({ version: 1, id: randomUUID(), command: 'recordingAttempts.begin', payload: { commandId: randomUUID(), planVersionId: randomUUID(), planContentHash: 'a'.repeat(64), userConfirmed: true } });
function fixture(mode: string, projection?: DatasetOwnerProjectionHandler) {
  const datasetId = randomUUID();
  const worker = new Worker(new URL('./helpers/dataset-owner-fixture.ts', import.meta.url), { workerData: { mode, datasetId }, execArgv: ['--import', 'tsx'] });
  const reasons: DatasetOwnerFatalReason[] = [];
  const endpoint = createDatasetOwnerClient({ worker, onFatal: reason => reasons.push(reason), ...(projection === undefined ? {} : { projection }) });
  return { datasetId, worker, endpoint, reasons };
}

test('owner封入口并停止coordinator后等待在途写，close等待自然exit0', { timeout: 10_000 }, async () => {
  const { endpoint, worker, datasetId, reasons } = fixture('hold');
  const before = begin();
  await assert.rejects(endpoint.dispatch(before), error => error instanceof DatasetOwnerTransportError && error.outcome === 'not-sent');
  const identity = await endpoint.prepare();
  assert.equal(identity.datasetId, datasetId);
  await Promise.all([endpoint.commitBoot(), endpoint.commitBoot()]);
  const write = endpoint.dispatch(begin());
  const exit = once(worker, 'exit');
  const close = endpoint.close();
  await assert.rejects(endpoint.dispatch(begin()), error => error instanceof DatasetOwnerTransportError && error.outcome === 'not-sent');
  assert.deepEqual(await write, { stopped: true, commits: 1, command: 'recordingAttempts.begin' });
  await close;
  assert.deepEqual(await exit, [0]);
  assert.deepEqual(reasons, []);
  assert.equal(endpoint.close(), close);
});

test('已发begin断链保留unknown及原身份，不伪称未受理或重放', { timeout: 10_000 }, async () => {
  const { endpoint, reasons, worker } = fixture('crash');
  await endpoint.prepare();
  const request = begin();
  const exit = once(worker, 'exit');
  await assert.rejects(endpoint.dispatch(request), error => error instanceof DatasetOwnerTransportError && error.outcome === 'unknown' && error.requestId === request.id && error.command === request.command && !error.message.includes('ATTEMPT_NOT_ACCEPTED'));
  assert.deepEqual(await exit, [17]);
  await assert.rejects(endpoint.dispatch(request), error => error instanceof DatasetOwnerTransportError && error.outcome === 'not-sent');
  assert.deepEqual(reasons, ['worker-exit']);
});

test('双方丢弃旧epoch消息，当前实例的合法请求仍能完成', { timeout: 10_000 }, async () => {
  const { endpoint, worker, reasons } = fixture('stale');
  await endpoint.prepare();
  worker.postMessage({ version: 1, type: 'request', epoch: randomUUID(), requestId: randomUUID(), sequence: 1, operation: 'prepare' });
  assert.deepEqual(await endpoint.dispatch({ version: 1, id: randomUUID(), command: 'recordingProfiles.list', payload: {} }), { stopped: false, commits: 0, command: 'recordingProfiles.list' });
  await endpoint.close();
  assert.deepEqual(reasons, []);
});

test('未知命令与坏payload拒绝后不触发任意方法，已证实的安全领域错误保留', { timeout: 10_000 }, async () => {
  const { endpoint, reasons } = fixture('safe-failure');
  await endpoint.prepare();
  await assert.rejects(endpoint.dispatch({ version: 1, id: randomUUID(), command: 'collection.executeSql' as IpcRequest['command'], payload: {} }), error => error instanceof DatasetOwnerDispatchError && error.failure.error.code === 'INVALID_IPC_REQUEST');
  await assert.rejects(endpoint.dispatch({ ...begin(), payload: {} }), error => error instanceof DatasetOwnerDispatchError && error.failure.error.code === 'INVALID_IPC_REQUEST');
  await assert.rejects(endpoint.dispatch(begin()), error => error instanceof DatasetOwnerDispatchError && error.failure.error.code === 'ATTEMPT_NOT_ACCEPTED');
  await endpoint.close();
  assert.deepEqual(reasons, []);
});

test('元数据投影只经窄票据和permit，安全投影错误不附带内部异常', { timeout: 10_000 }, async () => {
  const calls: string[] = [];
  const scope = '合成库代际';
  const projectionId = randomUUID(), permitId = randomUUID();
  const handler: DatasetOwnerProjectionHandler = async (command, payload, context) => {
    assert.match(context.epoch, /^[0-9a-f-]{36}$/);
    calls.push(command);
    if (command === 'captureAlbumMetadata') return { scope, projectionId, metadata: { title: '合成专辑' } } as never;
    if (command === 'acquirePermit') {
      assert.equal('scope' in payload && payload.scope, scope);
      return { scope, projectionId, permitId } as never;
    }
    if (command === 'releasePermit') return { released: true } as never;
    throw new Error('不应访问其他投影。');
  };
  const successful = fixture('projection', handler);
  await successful.endpoint.prepare();
  assert.deepEqual(await successful.endpoint.dispatch(begin()), { title: '合成专辑' });
  await successful.endpoint.close();
  assert.deepEqual(calls, ['captureAlbumMetadata','acquirePermit','releasePermit']);
  const failed = fixture('projection', async () => { throw new Error('私密路径和内部堆栈'); });
  await failed.endpoint.prepare();
  await assert.rejects(failed.endpoint.dispatch(begin()), error => error instanceof DatasetOwnerDispatchError && error.failure.error.code === 'INTERNAL_ERROR' && !JSON.stringify(error.failure).includes('私密'));
  await failed.endpoint.close();
});

test('关闭失败不能ACK成功，生产client不强制终止worker', { timeout: 10_000 }, async () => {
  const { endpoint, worker, reasons } = fixture('close-failure');
  await endpoint.prepare();
  await assert.rejects(endpoint.close(), error => error instanceof DatasetOwnerDispatchError && error.failure.error.code === 'INTERNAL_ERROR');
  // 故障fixture刻意保留端口，测试自身负责终止；生产close没有terminate/restart路径。
  await worker.terminate();
  assert.deepEqual(reasons, ['close-failed']);
});

test('关闭失败回复同步锁定close-failed，后续exit与fatal不覆盖安全错误或在途unknown', async () => {
  // 只控制消息交付次序，运行实际client；没有线程调度、sleep或宽松原因断言。
  class ControlledOwnerWorker extends EventEmitter {
    readonly requests: DatasetOwnerRequest[] = [];
    postMessage(message: unknown): void {
      assert.ok(isDatasetOwnerRequest(message));
      this.requests.push(message);
    }
    takeRequest(): DatasetOwnerRequest {
      const request = this.requests.shift();
      assert.ok(request);
      return request;
    }
  }
  const worker = new ControlledOwnerWorker();
  const reasons: DatasetOwnerFatalReason[] = [];
  const endpoint = createDatasetOwnerClient({ worker: worker as unknown as Worker, onFatal: reason => reasons.push(reason) });
  const prepare = endpoint.prepare();
  const preparation = worker.takeRequest();
  worker.emit('message', { version: 1, epoch: preparation.epoch, type: 'response', requestId: preparation.requestId,
    operation: 'prepare', ok: true, result: { epoch: preparation.epoch, datasetId: randomUUID() } });
  await prepare;
  const publicWrite = begin();
  const writeOutcome = endpoint.dispatch(publicWrite).catch((error: unknown) => error);
  const write = worker.takeRequest();
  assert.equal(write.operation, 'dispatch');
  const closeOutcome = endpoint.close().catch((error: unknown) => error);
  const close = worker.takeRequest();
  const failure = { version: 1 as const, id: close.requestId, ok: false as const, error: { code: 'INVENTORY_UNAVAILABLE' as const, message: '合成关闭未完成。' } };
  worker.emit('message', { version: 1, epoch: close.epoch, type: 'response', requestId: close.requestId, operation: 'close', ok: false, failure });
  assert.deepEqual(reasons, ['close-failed']); // 失败帧返回时即锁定，不等待下一帧或microtask。
  worker.emit('exit', 17);
  worker.emit('message', { version: 1, epoch: close.epoch, type: 'fatal', reason: 'close-failed' });
  const closeError: unknown = await closeOutcome;
  assert.ok(closeError instanceof DatasetOwnerDispatchError);
  assert.deepEqual(closeError.failure, failure);
  const writeError: unknown = await writeOutcome;
  assert.ok(writeError instanceof DatasetOwnerTransportError);
  assert.equal(writeError.outcome, 'unknown');
  assert.equal(writeError.requestId, publicWrite.id);
  assert.equal(writeError.command, publicWrite.command);
  assert.deepEqual(reasons, ['close-failed']);
  await assert.rejects(endpoint.dispatch(publicWrite), error => error instanceof DatasetOwnerTransportError && error.outcome === 'not-sent');
  assert.deepEqual(worker.requests, []); // 后续请求不发送，也不会重放在途写。
});

test('原validator合法的含控制字符public id逐字转发，私有身份仍严格校验', { timeout: 10_000 }, async () => {
  const { endpoint, reasons } = fixture('public-id');
  const request: IpcRequest = { version: 1, id: '合法\u0000\t请求\n\u007f', command: 'recordingProfiles.list', payload: {} };
  assert.equal(validateIpcRequest(request).ok, true);
  await endpoint.prepare();
  try {
    // client只验证回复信封，领域结果保持unknown，由现有公开IPC层执行原DTOguard。
    assert.deepEqual(await endpoint.dispatch(request), { publicId: request.id });
    const privateRequest = { version: 1, type: 'request', epoch: randomUUID(), requestId: randomUUID(), sequence: 1, operation: 'dispatch', request };
    assert.equal(isDatasetOwnerRequest(privateRequest), true);
    assert.equal(isDatasetOwnerRequest({ ...privateRequest, epoch: request.id }), false);
    assert.equal(isDatasetOwnerRequest({ ...privateRequest, requestId: request.id }), false);
  } finally { await endpoint.close(); }
  assert.deepEqual(reasons, []);
});
