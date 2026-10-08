import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { lstat, mkdtemp, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { isMainThread, MessageChannel, MessagePort, parentPort, Worker, workerData } from 'node:worker_threads';
import test, { type TestContext } from 'node:test';
import type { IpcRequest } from '@music-bridge/contracts';
import { buildStoragePolicy } from '../../../../apps/desktop/scripts/build-storage-root.mjs';
import { createDatasetOwnerClient } from '../../src/collection/dataset-owner-client.js';
import { attachDatasetOwnerWorkerPort } from '../../src/collection/dataset-owner-worker.js';
import {
  DatasetOwnerDispatchError, DatasetOwnerTransportError, isDatasetOwnerRequest,
  type DatasetOwnerFatalReason, type DatasetOwnerRequest, type OwnedDatasetDomain,
} from '../../src/collection/dataset-owner-protocol.js';

// 真实线程运行原 Owner dispatcher；控制端口只释放自有测试门，不承载领域命令或关闭 ACK。
function startDrainWorker(): void {
  assert.ok(parentPort);
  const input: unknown = workerData;
  assert.ok(input !== null && typeof input === 'object' && 'control' in input && 'mode' in input && 'datasetId' in input && 'file' in input);
  assert.ok(input.control instanceof MessagePort);
  assert.ok(input.mode === 'prepare' || input.mode === 'dispatch' || input.mode === 'nonzero' || input.mode === 'close-failure');
  assert.equal(typeof input.datasetId, 'string'); assert.equal(typeof input.file, 'string');
  if (typeof input.datasetId !== 'string' || typeof input.file !== 'string') throw new Error('自有 Worker 夹具身份无效。');
  const control = input.control, mode = input.mode, datasetId = input.datasetId, file = input.file;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  control.on('message', (message: unknown) => {
    if (message === 'release') release();
    if (message === 'exit-failed-close') process.exit(29);
  });
  control.once('close', () => release());
  const signal = (name: string): void => { control.postMessage(name); };
  attachDatasetOwnerWorkerPort(parentPort, {
    async prepare() {
      const handle = await open(file, 'wx', 0o600);
      signal('prepare-entered');
      if (mode === 'prepare') await gate;
      const domain: OwnedDatasetDomain = {
        datasetId,
        commitBoot() {},
        async dispatch(request) {
          signal('dispatch-entered');
          await gate;
          await handle.writeFile('真实在途写入已完成');
          await handle.sync();
          signal('write-completed');
          return { command: request.command };
        },
        async close(beforeConnectionClose) {
          signal('close-entered');
          await beforeConnectionClose?.();
          await handle.close();
          signal('fd-quiet');
          if (mode === 'close-failure') {
            signal('close-failed');
            throw new Error('自有关闭故障，端口继续保留。');
          }
          control.close();
          if (mode === 'nonzero') process.exit(23);
        },
        failureForError(id) {
          return { version: 1, id, ok: false, error: { code: 'INTERNAL_ERROR', message: '自有测试领域操作失败。' } };
        },
      };
      return domain;
    },
  });
}

const writeRequest = (): IpcRequest => ({
  version: 1, id: randomUUID(), command: 'recordingAttempts.begin',
  payload: { commandId: randomUUID(), planVersionId: randomUUID(), planContentHash: 'a'.repeat(64), userConfirmed: true },
});
const unknown = (error: unknown): boolean => error instanceof DatasetOwnerTransportError && error.outcome === 'unknown';

function drainCapability(endpoint: ReturnType<typeof createDatasetOwnerClient>): () => Promise<void> {
  const method: unknown = Object.getOwnPropertyDescriptor(endpoint, 'fatalDrain')?.value;
  assert.equal(typeof method, 'function', '真实 client 必须提供私有 fatalDrain，不能用原 close 的立即拒绝代替线程 join。');
  if (typeof method !== 'function') throw new Error('缺少私有 fatalDrain。');
  return () => {
    const result: unknown = Reflect.apply(method, endpoint, []);
    assert.ok(result instanceof Promise);
    return result;
  };
}

async function fixture(t: TestContext, mode: 'prepare' | 'dispatch' | 'nonzero' | 'close-failure') {
  const storage = buildStoragePolicy();
  const temporary = storage.check(process.env.TMPDIR!, { mustExist: true });
  const directory = await mkdtemp(path.join(temporary, 'mbrs012-fatal-drain-'));
  storage.check(directory, { mustExist: true });
  const info = await lstat(directory);
  assert.ok(info.isDirectory() && !info.isSymbolicLink());
  assert.equal(info.mode & 0o777, 0o700);
  const file = path.join(directory, 'owned-write.txt'), datasetId = randomUUID();
  const { port1, port2 } = new MessageChannel();
  const signals = new Set<string>(), waiting = new Map<string, Array<() => void>>();
  port2.on('message', (value: unknown) => {
    assert.equal(typeof value, 'string');
    if (typeof value !== 'string') return;
    signals.add(value);
    for (const resolve of waiting.get(value) ?? []) resolve();
    waiting.delete(value);
  });
  const wait = (name: string): Promise<void> => signals.has(name) ? Promise.resolve() : new Promise(resolve => {
    waiting.set(name, [...(waiting.get(name) ?? []), resolve]);
  });
  const worker = new Worker(new URL(import.meta.url), {
    execArgv: ['--import', 'tsx'],
    workerData: { mode, datasetId, file, control: port1 },
    transferList: [port1],
  });
  const sent: DatasetOwnerRequest[] = [], post = worker.postMessage.bind(worker);
  worker.postMessage = (...args: Parameters<Worker['postMessage']>) => {
    if (isDatasetOwnerRequest(args[0])) sent.push(structuredClone(args[0]));
    post(...args);
  };
  const reasons: DatasetOwnerFatalReason[] = [];
  let resolveFatal!: () => void;
  const fatal = new Promise<void>(resolve => { resolveFatal = resolve; });
  const endpoint = createDatasetOwnerClient({ worker, onFatal(reason) { reasons.push(reason); resolveFatal(); } });
  let exitCode: number | undefined;
  worker.once('exit', code => { exitCode = code; });
  const actualExit = once(worker, 'exit');
  // RED 或断言失败只由测试自身收尾；生产 client 不调用 terminate，不伪造 quiet。
  t.after(async () => {
    port2.postMessage('release');
    port2.close();
    if (worker.threadId !== -1) {
      try { await endpoint.close(); } catch { /* 保留被测关闭失败，测试随后显式终止自有故障线程。 */ }
      if (worker.threadId !== -1) await worker.terminate();
    }
  });
  return {
    endpoint, worker, reasons, fatal, sent, file, wait, actualExit,
    get exitCode() { return exitCode; },
    release: () => port2.postMessage('release'),
    exitFailedClose: () => port2.postMessage('exit-failed-close'),
    triggerFatal: () => worker.postMessage({ version: 1, type: 'invalid-protocol-frame' }),
  };
}

if (!isMainThread) startDrainWorker();
else {
test('012 fatal prepare 在真实输入门未收口时不伪 join，私有 drain 只发一次 close 并等自然退出', { timeout: 20_000 }, async t => {
  const f = await fixture(t, 'prepare'), drain = drainCapability(f.endpoint);
  await assert.rejects(drain(), error => error instanceof DatasetOwnerTransportError && error.outcome === 'not-sent');
  const preparation = f.endpoint.prepare().catch((error: unknown) => error);
  await f.wait('prepare-entered');
  f.triggerFatal(); await f.fatal;
  assert.ok(unknown(await preparation));
  const closing = drain(), again = drain();
  assert.equal(closing, again);
  let settled = false; void closing.then(() => { settled = true; }, () => { settled = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(settled, false); assert.equal(f.exitCode, undefined);
  assert.equal(f.sent.filter(request => request.operation === 'close').length, 1);
  assert.deepEqual(f.sent.map(request => request.operation), ['prepare', 'close']);
  f.release(); await closing; await f.wait('fd-quiet');
  assert.deepEqual(await f.actualExit, [0]);
  assert.deepEqual(f.reasons, ['protocol-failure']);
  await assert.rejects(f.endpoint.close(), error => error instanceof DatasetOwnerTransportError && error.outcome === 'not-sent');
});

test('012 fatal pending 写入保持原 unknown 和命令身份，真实 FD 写完关闭前 drain 不完成或重放', { timeout: 20_000 }, async t => {
  const f = await fixture(t, 'dispatch'), drain = drainCapability(f.endpoint);
  await f.endpoint.prepare(); await f.endpoint.commitBoot();
  const request = writeRequest(), write = f.endpoint.dispatch(request).catch((error: unknown) => error);
  await f.wait('dispatch-entered'); f.triggerFatal(); await f.fatal;
  const error = await write;
  assert.ok(error instanceof DatasetOwnerTransportError);
  assert.equal(error.outcome, 'unknown'); assert.equal(error.requestId, request.id); assert.equal(error.command, request.command);
  const closing = drain();
  await f.wait('close-entered');
  let settled = false; void closing.then(() => { settled = true; }, () => { settled = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(settled, false); assert.equal(f.exitCode, undefined);
  assert.equal((await readFile(f.file)).length, 0);
  assert.equal(f.sent.filter(value => value.operation === 'dispatch').length, 1);
  assert.equal(f.sent.filter(value => value.operation === 'close').length, 1);
  f.release(); await closing;
  assert.deepEqual(await f.actualExit, [0]); await f.wait('write-completed'); await f.wait('fd-quiet');
  assert.equal(await readFile(f.file, 'utf8'), '真实在途写入已完成');
  await assert.rejects(f.endpoint.dispatch(request), value => value instanceof DatasetOwnerTransportError && value.outcome === 'not-sent');
  assert.equal(f.sent.filter(value => value.operation === 'dispatch').length, 1);
});

test('012 fatal drain 遇真实非零退出仍拒绝 unknown，不能升级成正常 close 成功', { timeout: 20_000 }, async t => {
  const f = await fixture(t, 'nonzero'), drain = drainCapability(f.endpoint);
  await f.endpoint.prepare(); await f.endpoint.commitBoot();
  const write = f.endpoint.dispatch(writeRequest()).catch((error: unknown) => error);
  await f.wait('dispatch-entered'); f.triggerFatal(); await f.fatal; assert.ok(unknown(await write));
  const closing = drain();
  const rejected = assert.rejects(closing, unknown);
  await f.wait('close-entered'); assert.equal(f.exitCode, undefined);
  f.release(); await rejected;
  assert.deepEqual(await f.actualExit, [23]);
  await assert.rejects(f.endpoint.close(), value => value instanceof DatasetOwnerTransportError && value.outcome === 'not-sent');
  assert.equal(drain(), closing); assert.equal(f.sent.filter(value => value.operation === 'close').length, 1);
});

test('012 已发送 close 的确定失败保持原错误立即拒绝，fatal drain 等真实退出且不追加第二次 close', { timeout: 20_000 }, async t => {
  const f = await fixture(t, 'close-failure'), drain = drainCapability(f.endpoint);
  await f.endpoint.prepare();
  const original = f.endpoint.close();
  await assert.rejects(original, error => error instanceof DatasetOwnerDispatchError && error.failure.error.code === 'INTERNAL_ERROR');
  await f.fatal; await f.wait('close-failed');
  assert.equal(f.exitCode, undefined); assert.equal(f.endpoint.close(), original);
  const closing = drain();
  let settled = false; void closing.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(closing, unknown);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(settled, false); assert.equal(f.sent.filter(value => value.operation === 'close').length, 1);
  f.exitFailedClose(); await rejected;
  assert.deepEqual(await f.actualExit, [29]); assert.deepEqual(f.reasons, ['close-failed']);
  assert.equal(f.sent.filter(value => value.operation === 'close').length, 1);
});
}
