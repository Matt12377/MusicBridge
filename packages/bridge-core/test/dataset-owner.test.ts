import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { Worker } from 'node:worker_threads';
import test from 'node:test';
import { validateIpcRequest, type IpcRequest } from '@music-bridge/contracts';
import { createDatasetOwnerClient } from '../src/collection/dataset-owner-client.js';
import { DatasetOwnerDispatchError, DatasetOwnerTransportError, isDatasetOwnerRequest, type DatasetOwnerFatalReason, type DatasetOwnerProjectionHandler, type DatasetOwnerRequest } from '../src/collection/dataset-owner-protocol.js';

const begin = (): IpcRequest => ({ version: 1, id: randomUUID(), command: 'recordingAttempts.begin', payload: { commandId: randomUUID(), planVersionId: randomUUID(), planContentHash: 'a'.repeat(64), userConfirmed: true } });
function fixture(t: test.TestContext, mode: string, projection?: DatasetOwnerProjectionHandler) {
  const datasetId = randomUUID();
  const worker = new Worker(new URL('./helpers/dataset-owner-fixture.ts', import.meta.url), { workerData: { mode, datasetId }, execArgv: ['--import', 'tsx'] });
  const reasons: DatasetOwnerFatalReason[] = [];
  const endpoint = createDatasetOwnerClient({ worker, onFatal: reason => reasons.push(reason), ...(projection === undefined ? {} : { projection }) });
  t.after(async () => {
    if (worker.threadId === -1) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([endpoint.close().catch(() => undefined), new Promise<void>(resolve => { timer = setTimeout(resolve, 2000); })]);
    } finally {
      if (timer) clearTimeout(timer);
      // 仅失败清理终止测试自有线程；成功用例仍须独立断言原close和自然exit。
      if (worker.threadId !== -1) await worker.terminate();
    }
  });
  return { datasetId, worker, endpoint, reasons };
}

test('owner封入口并停止coordinator后等待在途写，close等待自然exit0', { timeout: 10_000 }, async t => {
  const { endpoint, worker, datasetId, reasons } = fixture(t, 'hold');
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

test('已发begin断链保留unknown及原身份，不伪称未受理或重放', { timeout: 10_000 }, async t => {
  const { endpoint, reasons, worker } = fixture(t, 'crash');
  await endpoint.prepare(); await endpoint.commitBoot();
  const request = begin();
  const exit = once(worker, 'exit');
  await assert.rejects(endpoint.dispatch(request), error => error instanceof DatasetOwnerTransportError && error.outcome === 'unknown' && error.requestId === request.id && error.command === request.command && !error.message.includes('ATTEMPT_NOT_ACCEPTED'));
  assert.deepEqual(await exit, [17]);
  await assert.rejects(endpoint.dispatch(request), error => error instanceof DatasetOwnerTransportError && error.outcome === 'not-sent');
  assert.deepEqual(reasons, ['worker-exit']);
});

test('双方丢弃旧epoch消息，当前实例的合法请求仍能完成', { timeout: 10_000 }, async t => {
  const { endpoint, worker, reasons } = fixture(t, 'stale');
  await endpoint.prepare(); await endpoint.commitBoot();
  worker.postMessage({ version: 1, type: 'request', epoch: randomUUID(), requestId: randomUUID(), sequence: 1, operation: 'prepare' });
  assert.deepEqual(await endpoint.dispatch({ version: 1, id: randomUUID(), command: 'recordingProfiles.list', payload: {} }), { stopped: false, commits: 1, command: 'recordingProfiles.list' });
  await endpoint.close();
  assert.deepEqual(reasons, []);
});

test('未知命令与坏payload拒绝后不触发任意方法，已证实的安全领域错误保留', { timeout: 10_000 }, async t => {
  const { endpoint, reasons } = fixture(t, 'safe-failure');
  await endpoint.prepare(); await endpoint.commitBoot();
  await assert.rejects(endpoint.dispatch({ version: 1, id: randomUUID(), command: 'collection.executeSql' as IpcRequest['command'], payload: {} }), error => error instanceof DatasetOwnerDispatchError && error.failure.error.code === 'INVALID_IPC_REQUEST');
  await assert.rejects(endpoint.dispatch({ ...begin(), payload: {} }), error => error instanceof DatasetOwnerDispatchError && error.failure.error.code === 'INVALID_IPC_REQUEST');
  await assert.rejects(endpoint.dispatch(begin()), error => error instanceof DatasetOwnerDispatchError && error.failure.error.code === 'ATTEMPT_NOT_ACCEPTED');
  await endpoint.close();
  assert.deepEqual(reasons, []);
});

test('元数据投影只经窄票据和permit，安全投影错误不附带内部异常', { timeout: 10_000 }, async t => {
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
  const successful = fixture(t, 'projection', handler);
  await successful.endpoint.prepare(); await successful.endpoint.commitBoot();
  assert.deepEqual(await successful.endpoint.dispatch(begin()), { title: '合成专辑' });
  await successful.endpoint.close();
  assert.deepEqual(calls, ['captureAlbumMetadata','acquirePermit','releasePermit']);
  const failed = fixture(t, 'projection', async () => { throw new Error('私密路径和内部堆栈'); });
  await failed.endpoint.prepare(); await failed.endpoint.commitBoot();
  await assert.rejects(failed.endpoint.dispatch(begin()), error => error instanceof DatasetOwnerDispatchError && error.failure.error.code === 'INTERNAL_ERROR' && !JSON.stringify(error.failure).includes('私密'));
  await failed.endpoint.close();
});

test('关闭失败不能ACK成功，生产client不强制终止worker', { timeout: 10_000 }, async t => {
  const { endpoint, worker, reasons } = fixture(t, 'close-failure');
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
  const committing = endpoint.commitBoot(), commit = worker.takeRequest();
  assert.equal(commit.operation, 'commitBoot');
  worker.emit('message', { version: 1, epoch: commit.epoch, type: 'response', requestId: commit.requestId,
    operation: 'commitBoot', ok: true, result: undefined });
  await committing;
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

test('原validator合法的含控制字符public id逐字转发，私有身份仍严格校验', { timeout: 10_000 }, async t => {
  const { endpoint, reasons } = fixture(t, 'public-id');
  const request: IpcRequest = { version: 1, id: '合法\u0000\t请求\n\u007f', command: 'recordingProfiles.list', payload: {} };
  assert.equal(validateIpcRequest(request).ok, true);
  await endpoint.prepare(); await endpoint.commitBoot();
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


// 以下只控制原消息交付次序，运行真实Client；不是实际Owner/Utility或物理FD闭口资格。
import { DatasetWorkbenchWireError, datasetWorkbenchFrames, datasetWorkbenchMeta, datasetWorkbenchControl, isDatasetWorkbenchFrame, type DatasetWorkbenchFrame, type DatasetWorkbenchMeta, type DatasetWorkbenchContext } from '../src/collection/dataset-owner-protocol.js';

class ContextSettledWorker773 extends EventEmitter {
  readonly ownerRequests: DatasetOwnerRequest[] = [];
  readonly frames: DatasetWorkbenchFrame[] = [];
  readonly begins: DatasetWorkbenchMeta[] = [];
  postMessage(message: unknown): void {
    if (isDatasetOwnerRequest(message)) { this.ownerRequests.push(message); return; }
    assert.ok(isDatasetWorkbenchFrame(message));
    this.frames.push(message);
    if (message.lane === 'request' && message.part === 'begin') this.begins.push(datasetWorkbenchMeta(message));
  }
  takeOwner(operation: DatasetOwnerRequest['operation']): DatasetOwnerRequest {
    const request = this.ownerRequests.shift();
    assert.ok(request); assert.equal(request.operation, operation); return request;
  }
  takeContext(): DatasetWorkbenchMeta {
    const meta = this.begins.shift(); assert.ok(meta); assert.equal(meta.kind, 'context'); return meta;
  }
  respond(request: DatasetOwnerRequest, result: unknown): void {
    this.emit('message', { version: 1, epoch: request.epoch, type: 'response', requestId: request.requestId, operation: request.operation, ok: true, result });
  }
}

async function contextSettledFixture773(t: test.TestContext) {
  const worker = new ContextSettledWorker773();
  const reasons: DatasetOwnerFatalReason[] = [];
  const endpoint = createDatasetOwnerClient({ worker: worker as unknown as Worker, onFatal: reason => reasons.push(reason) });
  let closed = false;
  t.after(() => {
    if (!closed) { worker.emit('error', new Error('仅受控组件的未完成消息收尾。')); worker.emit('exit', 17); }
  });
  const preparing = endpoint.prepare(), prepare = worker.takeOwner('prepare');
  const expected = { epoch: prepare.epoch, datasetId: randomUUID() };
  worker.respond(prepare, expected);
  const identity = await preparing;
  const committing = endpoint.commitBoot(), commit = worker.takeOwner('commitBoot');
  worker.respond(commit, undefined); await committing;
  const result: DatasetWorkbenchContext = { ...identity, ready: true };
  return {
    worker, endpoint, reasons, result,
    end(meta: DatasetWorkbenchMeta, value: DatasetWorkbenchContext = result) {
      const frames = datasetWorkbenchFrames(meta, 'response', value);
      for (const frame of frames) worker.emit('message', frame);
      return frames;
    },
    settle(meta: DatasetWorkbenchMeta) { worker.emit('message', datasetWorkbenchControl(meta, 'settled')); },
    async finish() {
      const closing = endpoint.close(), close = worker.takeOwner('close');
      worker.respond(close, undefined); worker.emit('exit', 0);
      await closing; closed = true; assert.deepEqual(reasons, []);
    },
  };
}

const contextCheckpoint773 = () => new Promise<void>(resolve => setImmediate(resolve));
const contextCode773 = (code: string) => (error: unknown) => error instanceof DatasetWorkbenchWireError && error.code === code;

test('context完整成功end仍保pending与join，只有同原settled先清自身再履行原DTO', async t => {
  const h = await contextSettledFixture773(t);
  let fulfilled = 0, quiet = false;
  const result = h.endpoint.workbenchContext!().then(value => { fulfilled++; return value; });
  const meta = h.worker.takeContext(); h.end(meta);
  const joining = h.endpoint.joinWorkbench!().then(() => { quiet = true; });
  await contextCheckpoint773();
  assert.equal(fulfilled, 0); assert.equal(quiet, false); assert.equal(h.worker.frames.filter(frame => frame.lane === 'request' && frame.part === 'begin').length, 1);
  h.settle(meta);
  assert.deepEqual(await result, h.result); await joining;
  assert.equal(fulfilled, 1); assert.equal(quiet, true); assert.deepEqual(h.reasons, []);
  await h.finish();
});

test('context原abort或failure后的合法late end不消账，原settled及取消retired重复ACK才幂等收尾', async t => {
  for (const mode of ['abort', 'failure'] as const) await t.test(mode, async st => {
    const h = await contextSettledFixture773(st), controller = new AbortController();
    const result = h.endpoint.workbenchContext!({ signal: controller.signal });
    const rejected = assert.rejects(result, contextCode773(mode === 'abort' ? 'TIMEOUT' : 'NOT_READY'));
    const meta = h.worker.takeContext();
    if (mode === 'abort') controller.abort();
    else h.worker.emit('message', datasetWorkbenchControl(meta, 'failure', 'NOT_READY'));
    await rejected;
    let quiet = false; const joining = h.endpoint.joinWorkbench!().then(() => { quiet = true; });
    h.end(meta); await contextCheckpoint773();
    assert.equal(quiet, false); assert.equal(h.worker.frames.filter(frame => frame.part === 'cancel').length, mode === 'abort' ? 1 : 0);
    h.settle(meta); await joining; assert.equal(quiet, true);
    h.settle(meta); await contextCheckpoint773(); assert.deepEqual(h.reasons, []);
    await h.finish();
  });
});

test('context缺settled仍沿原2秒timer拒绝，过期end不能替代实际settled解除join', { timeout: 10_000 }, async t => {
  for (const mode of ['valid-end-before-timeout', 'first-end-after-timeout'] as const) await t.test(mode, async st => {
    const h = await contextSettledFixture773(st);
    const result = h.endpoint.workbenchContext!();
    const rejected = assert.rejects(result, contextCode773('TIMEOUT'));
    const meta = h.worker.takeContext();
    if (mode === 'valid-end-before-timeout') h.end(meta);
    // 留待原timer真实触发，不加sleep、模拟ACK或延长期限。
    await rejected; assert.ok(Date.now() >= meta.expiresAtMs);
    let quiet = false; const joining = h.endpoint.joinWorkbench!().then(() => { quiet = true; });
    if (mode === 'first-end-after-timeout') h.end(meta);
    await contextCheckpoint773(); assert.equal(quiet, false);
    assert.equal(h.worker.frames.filter(frame => frame.part === 'cancel').length, 1);
    h.settle(meta); await joining; assert.equal(quiet, true); assert.deepEqual(h.reasons, []);
    await h.finish();
  });
});

test('context无成功end或错原meta的settled拒绝，成功end重复与错误DTO身份保原拒绝', async t => {
  for (const mode of ['no-end', 'wrong-meta', 'duplicate-end', 'wrong-dataset', 'wrong-epoch'] as const) await t.test(mode, async st => {
    const h = await contextSettledFixture773(st);
    const result = h.endpoint.workbenchContext!();
    const expectedCode = mode === 'wrong-meta' ? 'NOT_READY' : mode === 'wrong-dataset' || mode === 'wrong-epoch' ? 'OUTBOX_SCOPE_MISMATCH' : 'INVALID_IPC_RESPONSE';
    const rejected = assert.rejects(result, contextCode773(expectedCode));
    const meta = h.worker.takeContext();
    if (mode === 'no-end') h.settle(meta);
    else if (mode === 'wrong-meta') { h.end(meta); h.settle({ ...meta, requestSha256: 'f'.repeat(64) }); }
    else if (mode === 'duplicate-end') {
      const frames = h.end(meta), end = frames[frames.length - 1]; assert.ok(end); assert.equal(end.part, 'end'); h.worker.emit('message', end);
    } else h.end(meta, { ...h.result, ...(mode === 'wrong-dataset' ? { datasetId: randomUUID() } : { epoch: randomUUID() }) });
    await rejected; assert.deepEqual(h.reasons, ['protocol-failure']);
    const sent = h.worker.frames.length;
    await assert.rejects(h.endpoint.workbenchContext!(), contextCode773('NOT_READY'));
    assert.equal(h.worker.frames.length, sent);
  });
});

test('context成功retired的重复settled或end锁定原协议失败，不能第二次resolve或创造关闭资格', async t => {
  for (const mode of ['settled', 'end'] as const) await t.test(mode, async st => {
    const h = await contextSettledFixture773(st); let fulfilled = 0;
    const result = h.endpoint.workbenchContext!().then(value => { fulfilled++; return value; });
    const meta = h.worker.takeContext(), frames = h.end(meta);
    h.settle(meta); assert.deepEqual(await result, h.result);
    if (mode === 'settled') h.settle(meta);
    else { const end = frames[frames.length - 1]; assert.ok(end); h.worker.emit('message', end); }
    await contextCheckpoint773(); assert.equal(fulfilled, 1); assert.deepEqual(h.reasons, ['protocol-failure']);
    await assert.rejects(h.endpoint.close(), error => error instanceof DatasetOwnerTransportError && error.outcome === 'not-sent');
  });
});

test('首次合法context end后的closeWorkbench保原cancel及drain，两个原收口均完成才关闭', async t => {
  for (const order of ['context-first', 'drain-first'] as const) await t.test(order, async st => {
    const h = await contextSettledFixture773(st);
    const result = h.endpoint.workbenchContext!(), rejected = assert.rejects(result, contextCode773('NOT_READY'));
    const meta = h.worker.takeContext(); h.end(meta);
    let closed = false; const closing = h.endpoint.closeWorkbench!().then(() => { closed = true; });
    const drain = h.worker.begins.shift(); assert.ok(drain); assert.equal(drain.kind, 'drain');
    assert.equal(h.worker.frames.filter(frame => frame.part === 'cancel').length, 1);
    assert.equal(h.worker.frames.filter(frame => frame.lane === 'request' && frame.part === 'begin' && frame.kind === 'drain').length, 1);
    const finishDrain = () => { for (const frame of datasetWorkbenchFrames(drain, 'response', { closed: true })) h.worker.emit('message', frame); };
    await rejected; await contextCheckpoint773(); assert.equal(closed, false);
    if (order === 'context-first') h.settle(meta); else finishDrain();
    await contextCheckpoint773(); assert.equal(closed, false);
    if (order === 'context-first') finishDrain(); else h.settle(meta);
    await closing; assert.equal(closed, true); assert.deepEqual(h.reasons, []);
    await h.finish();
  });
});

test('context成功end未settled仍计原23在途上限，第24次零发送且每个原settled仅释放自身', async t => {
  const h = await contextSettledFixture773(t);
  const results = Array.from({ length: 23 }, () => h.endpoint.workbenchContext!());
  for (const result of results) void result.catch(() => {}); // 仅隔离测试失败后的清理拒绝，不改断言或结果。
  const metas = results.map(() => h.worker.takeContext());
  for (const meta of metas) h.end(meta);
  const before = h.worker.frames.length;
  await assert.rejects(h.endpoint.workbenchContext!(), error => error instanceof DatasetWorkbenchWireError && error.code === 'NOT_READY' && error.outcome === 'not-sent');
  assert.equal(h.worker.frames.length, before);
  let quiet = false; const joining = h.endpoint.joinWorkbench!().then(() => { quiet = true; });
  h.settle(metas[0]!); assert.deepEqual(await results[0], h.result);
  await contextCheckpoint773(); assert.equal(quiet, false);
  for (const meta of metas.slice(1)) h.settle(meta);
  assert.deepEqual(await Promise.all(results), Array.from({ length: 23 }, () => h.result));
  await joining; assert.equal(quiet, true); assert.deepEqual(h.reasons, []);
  await h.finish();
});

import { libraryRemovalClock as removalClockClient } from './helpers/library-removal-clock.js';

for(const command of ['library.remove','library.rename'] as const)test(`移除期限：实际Client仅remove延续原剩余期限，普通命令仍2秒（${command}）`,async t=>{
  const h=await contextSettledFixture773(t),clock=removalClockClient(t),controller=new AbortController(),commandId=randomUUID(),libraryId=randomUUID();
  const request:import('../src/collection/dataset-owner-protocol.js').DatasetWorkbenchRequest=command==='library.remove'
    ?{family:'management',command,payload:{commandId,libraryIds:[libraryId]}}:{family:'management',command,payload:{commandId,libraryId,name:'合成名称'}};
  const pending=h.endpoint.dispatchWorkbench!(request,{identity:{epoch:h.result.epoch,datasetId:h.result.datasetId},signal:controller.signal,deadlineAtMs:performance.now()+8000});
  const observed=pending.then(value=>({value}),error=>({error})),meta=h.worker.begins.shift();assert.ok(meta);assert.equal(meta.kind,'execute');
  try{
    const remaining=meta.expiresAtMs-Date.now();assert.ok(remaining<=8000);assert.ok(command==='library.remove'?remaining>7900:remaining<=2000);
    clock.advance(2100);await contextCheckpoint773();
    const receipt={commandId,kind:command,state:'succeeded',libraryIds:[libraryId],message:null};
    for(const frame of datasetWorkbenchFrames(meta,'response',receipt))h.worker.emit('message',frame);
    const result=await observed;
    if(command==='library.remove')assert.ok('value'in result);else assert.ok('error'in result&&contextCode773('TIMEOUT')(result.error));
    assert.equal(h.worker.begins.length,0);assert.deepEqual(h.reasons,[]);
  }finally{clock.reset();await h.finish();}
});

test('身份等待20秒：实际Client在2.5秒收到identity end仍等待原settled，join不能被较长预算替代', async t => {
  const h = await contextSettledFixture773(t), clock = removalClockClient(t)
  const pending = h.endpoint.workbenchReadIdentity!(); let completed = false, quiet = false, didSettle = false
  const result = pending.then(value => { completed = true; return value }), meta = h.worker.begins.shift()!
  void result.catch(() => {})
  assert.equal(meta.kind, 'context.identity'); assert.ok(meta.expiresAtMs - Date.now() > 19_900 && meta.expiresAtMs - Date.now() <= 20_000)
  try {
    clock.advance(2_500); await contextCheckpoint773(); h.end(meta)
    const joining = h.endpoint.joinWorkbench!().then(() => { quiet = true })
    await contextCheckpoint773(); assert.equal(completed, false); assert.equal(quiet, false)
    didSettle = true; h.settle(meta); assert.deepEqual(await result, h.result); await joining; assert.equal(quiet, true)
    assert.equal(h.worker.frames.filter(frame => frame.part === 'cancel').length, 0)
  } finally {
    if (!didSettle) { h.worker.emit('message', datasetWorkbenchControl(meta, 'failure', 'TIMEOUT')); h.settle(meta) }
    clock.reset(); await h.finish()
  }
})

for (const duration of [500, 20_000]) test(`身份等待20秒：Client较紧期限${duration}到期仍拒绝，late end不能清原pending/quiet`, async t => {
  const h = await contextSettledFixture773(t), clock = removalClockClient(t)
  const result = h.endpoint.workbenchReadIdentity!({ deadlineAtMs: performance.now() + duration }), rejected = assert.rejects(result, contextCode773('TIMEOUT'))
  const meta = h.worker.begins.shift()!; let didSettle = false; assert.equal(meta.kind, 'context.identity')
  assert.ok(meta.expiresAtMs - Date.now() <= duration)
  try {
    clock.advance(duration - 1); await contextCheckpoint773()
    clock.advance(1); await rejected
    let quiet = false; const joining = h.endpoint.joinWorkbench!().then(() => { quiet = true })
    h.end(meta); await contextCheckpoint773(); assert.equal(quiet, false)
    assert.equal(h.worker.frames.filter(frame => frame.part === 'cancel').length, 1)
    didSettle = true; h.settle(meta); await joining; assert.equal(quiet, true); assert.deepEqual(h.reasons, [])
  } finally {
    if (!didSettle) { h.worker.emit('message', datasetWorkbenchControl(meta, 'failure', 'TIMEOUT')); h.settle(meta) }
    clock.reset(); await h.finish()
  }
})
