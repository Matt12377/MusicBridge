import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { MessageChannel, MessagePort, Worker } from 'node:worker_threads';
import test from 'node:test';
import * as dto from '@music-bridge/contracts';
import type { DatasetOwnerEndpoint } from '../../src/collection/dataset-owner-protocol.js';
import { runCoreUtilityProcess, type UtilityPort } from '../../src/utility-main.js';
import { createUtilitySourceWritesBridge } from '../../src/shared/source-writes-utility-port.js';

/** 模拟 Electron 父端口的事件封套；对象本身确实不是 Node MessagePort。 */
class ElectronStylePort extends EventEmitter implements UtilityPort {
  readonly sent: unknown[] = [];
  closed = false;
  started = false;
  start(): void { this.started = true; }
  postMessage(message: unknown): void {
    if (this.closed) throw new Error('自有 Electron 样式端口已关闭。');
    this.sent.push(structuredClone(message));
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
  deliver(data: unknown): void { this.emit('message', { data }); }
  get ready(): boolean { return this.sent.some(value => typeof value === 'object' && value !== null && Object.getOwnPropertyDescriptor(value, 'event')?.value === 'core.ready'); }
}

async function until(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (!check()) {
    assert.ok(performance.now() < deadline, '端口行为未在受控时限内完成。');
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

test('012 Utility 回归：Electron 样式物理父端交付真实 Node 端给 Owner，原 Node brand 不拒绝启动', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'parentPort'), previousExitCode = process.exitCode;
  const publicPort = new ElectronStylePort(), sourcePort = new ElectronStylePort(), exits: (number | string | null | undefined)[] = [];
  let receive!: (event: { data: unknown; ports: UtilityPort[] }) => void;
  let factoryCalls = 0, ownerPort: MessagePort | undefined, ownerCloses = 0;
  const identity = { epoch: randomUUID(), datasetId: randomUUID() };
  const owner: DatasetOwnerEndpoint = {
    async prepare() { return identity; },
    async commitBoot() {},
    async dispatch() { throw new Error('本回归不派发领域命令。'); },
    async close() { ownerCloses++; ownerPort?.close(); },
  };
  t.mock.method(process, 'exit', ((code?: number | string | null) => { exits.push(code); }) as typeof process.exit);
  t.after(() => {
    if (descriptor) Object.defineProperty(process, 'parentPort', descriptor); else Reflect.deleteProperty(process, 'parentPort');
    process.exitCode = previousExitCode;
    ownerPort?.close(); sourcePort.close(); publicPort.close();
  });
  Object.defineProperty(process, 'parentPort', { configurable: true, value: { once(_event: 'message', listener: typeof receive) { receive = listener; } } });
  try {
    assert.equal(sourcePort instanceof MessagePort, false, '回归输入必须是非 Node 物理父端。');
    await runCoreUtilityProcess({ NODE_ENV: 'test', MUSIC_BRIDGE_CORE_TEST_MODE: '1', MUSIC_BRIDGE_DATA_DIRECTORY: '/合成/012端口回归' }, undefined, undefined, undefined, undefined, options => {
      factoryCalls++;
      ownerPort = options.privateSourceWritesPort;
      assert.ok(ownerPort instanceof MessagePort, 'Owner 仍只接收真正的 Node MessagePort。');
      return owner;
    });
    receive({ data: { type: 'musicbridge.core.port' }, ports: [publicPort, sourcePort] });
    await until(() => factoryCalls !== 0 || exits.length !== 0);
    assert.equal(factoryCalls, 1, '合法 Electron 父端不得在调用 Owner factory 前被 Node instanceof 拒绝。');
    await until(() => publicPort.ready || exits.length !== 0);
    assert.equal(publicPort.ready, true, '原 Utility 启动链必须到达 READY。');
    assert.deepEqual(exits, []);
  } finally {
    if (publicPort.ready && exits.length === 0) {
      publicPort.deliver({ version: 1, id: randomUUID(), command: 'core.shutdown', payload: {} });
      await until(() => exits.length !== 0);
      assert.deepEqual(exits, [0]);
      assert.equal(ownerCloses, 1);
    }
    ownerPort?.close();
    sourcePort.close(); publicPort.close();
    if (descriptor) Object.defineProperty(process, 'parentPort', descriptor); else Reflect.deleteProperty(process, 'parentPort');
    process.exitCode = previousExitCode;
  }
});

const datasetId = randomUUID(), hash = '1'.repeat(64);
function confirm(): dto.ConfirmLocalSourceWrites {
  return { datasetId, commandId: randomUUID(), planId: randomUUID(), expectedViewRevision: '1', scope: 'SOURCE_FILES', range: 'TAGS', planHash: hash, contextFingerprint: hash };
}
function challenge(sequence: number, requestId: string = randomUUID()): dto.SourceWritesMainRequest {
  return dto.localSourceWritesMainRequestSnapshot({ version: 1, type: 'source-writes-request', requestId, sequence, command: 'localSourceWrites.challenge', payload: { datasetId, confirm: confirm() } });
}
function original(sequence = 1, size = 1): dto.SourceWritesMainRequest {
  const bytes = new Uint8Array(size).fill(37);
  return dto.localSourceWritesMainRequestSnapshot({ version: 1, type: 'source-writes-request', requestId: randomUUID(), sequence, command: 'localSourceWrites.attachOriginal', payload: {
    datasetId, commandId: randomUUID(), target: { trackId: randomUUID(), editionId: randomUUID(), expectedEditionRevision: '1', expectedTrackRevision: '1', expectedSourceRevision: hash }, candidateId: randomUUID(),
    original: { mime: 'image/png', bytes: size, sha256: createHash('sha256').update(bytes).digest('hex'), width: 16, height: 16 }, bytes,
  } });
}
function result(request: dto.SourceWritesMainRequest): dto.LocalSourceWritesPrivateCommandResults[dto.LocalSourceWritesPrivateCommand] {
  if (request.command === 'localSourceWrites.attachOriginal') return { contentRef: randomUUID(), sha256: request.payload.original.sha256, bytes: request.payload.original.bytes };
  if (request.command === 'localSourceWrites.executeGranted') return { datasetId, commandId: request.payload.confirm.commandId, command: 'localSourceWrites.confirm', requestFingerprint: hash, planId: request.payload.confirm.planId, jobId: randomUUID(), outcome: 'accepted', policy: null, issue: null };
  const { datasetId: requestDatasetId, commandId, planId, expectedViewRevision, range, planHash, contextFingerprint } = request.payload.confirm;
  return { datasetId: requestDatasetId, commandId, planId, expectedViewRevision, range, planHash, contextFingerprint, expiresAt: new Date(Date.now() + 60_000).toISOString(), policyRevision: '1', requestFingerprint: hash, grant: { challengeId: randomUUID(), ownerEpoch: randomUUID(), nonce: hash, authorityId: randomUUID(), signature: hash } };
}
function response(request: dto.SourceWritesMainRequest, value: unknown = result(request)): dto.SourceWritesMainResponse {
  return dto.localSourceWritesMainResponseSnapshot({ version: 1, type: 'source-writes-response', requestId: request.requestId, sequence: request.sequence, ok: true, result: value }, request.command);
}
function harness(t: test.TestContext) {
  const source = new ElectronStylePort(), bridge = createUtilitySourceWritesBridge(source), received: dto.SourceWritesMainRequest[] = [];
  bridge.port.on('message', (value: unknown) => { received.push(dto.localSourceWritesMainRequestSnapshot(value)); });
  bridge.port.start();
  t.after(() => { bridge.close(); bridge.port.removeAllListeners(); bridge.port.close(); });
  return { source, bridge, received };
}
async function turns(): Promise<void> { for (let index = 0; index < 3; index++) await new Promise<void>(resolve => setImmediate(resolve)); }
function assertReleased(source: ElectronStylePort): void {
  assert.equal(source.closed, true);
  for (const event of ['message', 'close', 'messageerror']) assert.equal(source.listenerCount(event), 0, `关闭后不得保留 ${event} 监听。`);
}

test('012 私有桥：非 Node 父端的新 Node 端可真正转移进 Worker，三命令不借通用端口', async t => {
  const source = new ElectronStylePort(), bridge = createUtilitySourceWritesBridge(source), request = original(), expectedResult = result(request);
  assert.equal(source instanceof MessagePort, false); assert.ok(bridge.port instanceof MessagePort);
  const worker = new Worker(`
    const { parentPort, workerData, MessagePort } = require('node:worker_threads');
    const port = workerData.port;
    parentPort.postMessage({ nodePort: port instanceof MessagePort });
    port.once('message', request => {
      port.postMessage({ version: 1, type: 'source-writes-response', requestId: request.requestId, sequence: request.sequence, ok: true, result: workerData.result });
      port.close(); parentPort.close();
    });
    port.start();
  `, { eval: true, workerData: { port: bridge.port, result: expectedResult }, transferList: [bridge.port] });
  const exit = new Promise<number>((resolve, reject) => { worker.once('exit', resolve); worker.once('error', reject); });
  void exit.catch(() => undefined);
  t.after(async () => { bridge.close(); if (worker.threadId !== -1) await worker.terminate(); });
  const observed = await new Promise<unknown>((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
  assert.deepEqual(observed, { nodePort: true });
  source.deliver(request);
  await until(() => source.sent.length === 1 || source.closed);
  assert.equal(source.sent.length, 1); assert.deepEqual(dto.localSourceWritesMainResponseSnapshot(source.sent[0], request.command), response(request, expectedResult));
  assert.equal(await exit, 0);

  const direct = harness(t), commands: dto.SourceWritesMainRequest[] = [original(1), challenge(2)];
  const expected = confirm(), grant = { challengeId: randomUUID(), ownerEpoch: randomUUID(), nonce: hash, authorityId: randomUUID(), signature: hash };
  commands.push(dto.localSourceWritesMainRequestSnapshot({ version: 1, type: 'source-writes-request', requestId: randomUUID(), sequence: 3, command: 'localSourceWrites.executeGranted', payload: { datasetId, confirm: expected, grant } }));
  for (const command of commands) { direct.source.deliver(command); await until(() => direct.received.length === command.sequence); direct.bridge.port.postMessage(response(command)); await until(() => direct.source.sent.length === command.sequence); }
  assert.deepEqual(direct.received.map(value => value.command), dto.LOCAL_SOURCE_WRITES_PRIVATE_COMMANDS);
});

test('012 私有桥：4MiB原图整块独立复制，子视图/共享/可变backing/超限及非白名单均封闭', async t => {
  const valid = harness(t), request = original(1, dto.LOCAL_SOURCE_WRITES_BUDGET.originalBytes);
  assert.equal(request.command, 'localSourceWrites.attachOriginal'); assert.ok(request.command === 'localSourceWrites.attachOriginal');
  valid.source.deliver(request); request.payload.bytes.fill(9);
  await until(() => valid.received.length === 1);
  const received = valid.received[0]!; assert.ok(received.command === 'localSourceWrites.attachOriginal');
  assert.equal(received.payload.bytes.byteLength, 4 * 1024 * 1024); assert.equal(received.payload.bytes.byteOffset, 0); assert.equal(received.payload.bytes.buffer.byteLength, received.payload.bytes.byteLength);
  assert.ok(received.payload.bytes.every(value => value === 37)); assert.notEqual(received.payload.bytes.buffer, request.payload.bytes.buffer);
  valid.bridge.port.postMessage(response(received)); await until(() => valid.source.sent.length === 1);
  const small = original(); assert.ok(small.command === 'localSourceWrites.attachOriginal');
  const material = (bytes: Uint8Array) => ({ ...small, payload: { ...small.payload, bytes, original: { ...small.payload.original, bytes: bytes.byteLength } } });
  const invalid: unknown[] = [
    material(new Uint8Array(new ArrayBuffer(2), 1, 1)),
    material(new Uint8Array(new SharedArrayBuffer(1))),
    material(new Uint8Array(Reflect.construct(ArrayBuffer, [1, { maxByteLength: 2 }]) as ArrayBuffer)),
    material(new Uint8Array(dto.LOCAL_SOURCE_WRITES_BUDGET.originalBytes + 1)),
    { ...small, command: 'localSourceWrites.preview' },
    { ...small, payload: { ...small.payload, fd: 7 } },
    { ...small, metadata: '字'.repeat(dto.LOCAL_SOURCE_WRITES_BUDGET.originalMetadataEnvelopeBytes) },
  ];
  for (const raw of invalid) { const current = harness(t); current.source.deliver(raw); assertReleased(current.source); await turns(); assert.equal(current.received.length, 0); }
});

test('012 私有桥：序号跳跃/在途重复id/完成后原封套重放拒绝，更高序号不设终身ID上限', async t => {
  const jumped = harness(t); jumped.source.deliver(challenge(2)); assertReleased(jumped.source);
  const duplicate = harness(t), first = challenge(1); duplicate.source.deliver(first); await until(() => duplicate.received.length === 1);
  duplicate.source.deliver(challenge(2, first.requestId)); assertReleased(duplicate.source); await turns(); assert.equal(duplicate.received.length, 1);
  const replay = harness(t), done = challenge(1); replay.source.deliver(done); await until(() => replay.received.length === 1); replay.bridge.port.postMessage(response(done)); await until(() => replay.source.sent.length === 1);
  replay.source.deliver(done); assertReleased(replay.source); await turns(); assert.equal(replay.received.length, 1);
  const reusable = harness(t), start = challenge(1); reusable.source.deliver(start); await until(() => reusable.received.length === 1); reusable.bridge.port.postMessage(response(start)); await until(() => reusable.source.sent.length === 1);
  const next = challenge(2, start.requestId); reusable.source.deliver(next); await until(() => reusable.received.length === 2); reusable.bridge.port.postMessage(response(next)); await until(() => reusable.source.sent.length === 2); assert.equal(reusable.source.closed, false);
});

test('012 私有桥：按原命令捕获回执，错命令结果/序号/未知id/额外FD及受限预算均不得转发', async t => {
  const request = challenge(1), good = response(request), attachment = original();
  const invalid: unknown[] = [
    { ...good, result: result(attachment) },
    { ...good, sequence: 2 },
    { ...good, requestId: randomUUID() },
    { ...good, fd: 7 },
    { ...good, extra: '字'.repeat(dto.LOCAL_SOURCE_WRITES_BUDGET.originalMetadataEnvelopeBytes) },
  ];
  for (const raw of invalid) { const current = harness(t); current.source.deliver(request); await until(() => current.received.length === 1); current.bridge.port.postMessage(raw); await until(() => current.source.closed); assertReleased(current.source); assert.equal(current.source.sent.length, 0); }
  // 只在新测试注入接收回调，证明查 id 前的捕获不执行 getter；生产仍使用真实 Node 事件。
  const originalOn = MessagePort.prototype.on;
  let receive: ((value: unknown) => void) | undefined;
  const hook = t.mock.method(MessagePort.prototype, 'on', function (this: MessagePort, event: string, listener: (...args: unknown[]) => void) {
    if (event === 'message' && receive === undefined) receive = listener;
    return originalOn.call(this, event, listener);
  });
  const source = new ElectronStylePort(), bridge = createUtilitySourceWritesBridge(source); hook.mock.restore(); t.after(() => bridge.close());
  source.deliver(request);
  let getters = 0; const poisoned = { ...good }; Object.defineProperty(poisoned, 'requestId', { enumerable: true, get() { getters++; return request.requestId; } });
  assert.ok(receive); receive(poisoned); assert.equal(getters, 0); assertReleased(source); assert.equal(source.sent.length, 0);
});

test('012 私有桥：断连或显式close撤销对端、清监听，迟到请求与回执不再发送', async t => {
  for (const event of ['close', 'messageerror', 'explicit'] as const) {
    const current = harness(t), request = challenge(1); let ownerClosed = false; current.bridge.port.once('close', () => { ownerClosed = true; });
    current.source.deliver(request); await until(() => current.received.length === 1);
    if (event === 'explicit') current.bridge.close(); else current.source.emit(event);
    current.bridge.close(); current.bridge.close(); assertReleased(current.source); await until(() => ownerClosed);
    current.source.deliver(challenge(2)); current.bridge.port.postMessage(response(request)); await turns(); assert.equal(current.received.length, 1); assert.equal(current.source.sent.length, 0);
  }
});

test('012 私有桥：四请求并发可乱序回执，各回执仍绑定原command和sequence', async t => {
  const current = harness(t), requests = [challenge(1), original(2), challenge(3), original(4)];
  for (const request of requests) current.source.deliver(request);
  await until(() => current.received.length === 4);
  for (const request of [...requests].reverse()) current.bridge.port.postMessage(response(request));
  await until(() => current.source.sent.length === 4);
  assert.equal(current.source.closed, false);
  for (let index = 0; index < 4; index++) { const original = requests[3 - index]!, reply = dto.localSourceWritesMainResponseSnapshot(current.source.sent[index], original.command); assert.equal(reply.requestId, original.requestId); assert.equal(reply.sequence, original.sequence); }
  const fifth = challenge(5); current.source.deliver(fifth); await until(() => current.received.length === 5); current.bridge.port.postMessage(response(fifth)); await until(() => current.source.sent.length === 5); assert.equal(current.source.closed, false);
});

test('012 私有桥：第五在途请求封通道，附带额外物理port或启动失败均释放双方', async t => {
  const full = harness(t); for (let sequence = 1; sequence <= 4; sequence++) full.source.deliver(challenge(sequence)); await until(() => full.received.length === 4);
  full.source.deliver(challenge(5)); assertReleased(full.source); await turns(); assert.equal(full.received.length, 4); assert.equal(full.source.sent.length, 0);
  const extra = harness(t), foreign = new MessageChannel(); t.after(() => { foreign.port1.close(); foreign.port2.close(); });
  extra.source.emit('message', { data: challenge(1), ports: [foreign.port1] }); assertReleased(extra.source); await turns(); assert.equal(extra.received.length, 0);
  const broken = new ElectronStylePort(); broken.start = () => { throw new Error('自有端口启动故障'); }; assert.throws(() => createUtilitySourceWritesBridge(broken), /适配失败/u); assertReleased(broken);
});
