import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { MessageChannel } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { encodeMobileSealedCoreRequest, encodeMobileSealedOwnerRequest,
  attachMobileSealedCoreReceiver, attachMobileSealedOwnerReceiver, captureMobileSealedRequestFromPort } from '../../src/mobile/sealed-request-transport.js';
import { captureMobileCorePrivateCall, readMobileCorePrivateCallForCapture, captureDatasetOwnerRequest } from '../../src/mobile/owner-boundary-capture.js';
import { isMobileCorePrivateCall, isMobileOwnerPrivateRequest } from '../../src/mobile/owner-protocol.js';
import { isDatasetOwnerRequest } from '../../src/collection/dataset-owner-protocol.js';
import { allocateOwnedSealedBytes, ownedSealedByteLength } from '../../src/mobile/owned-sealed-bytes.js';
import { MOBILE_AUTH_SEALED_MAX_BYTES } from '../../src/mobile/types.js';

const DATASET = '50000000-0000-4000-8000-000000000038';
const call = (sealed: unknown) => ({ type: 'mobile-main-request', id: randomUUID(), request: { kind: 'playback-save', datasetId: DATASET,
  request: { datasetId: DATASET, expectedRevision: 0, commitId: randomUUID(), sealed } } });
const owner = (sealed: unknown) => ({ version: 1, type: 'request', epoch: randomUUID(), requestId: randomUUID(), sequence: 1,
  operation: 'mobileMain', expectedDatasetId: DATASET, mobile: call(sealed).request });
type Wire = { request: { request: { sealed: { schema: string; buffer: ArrayBuffer; byteOffset: number; byteLength: number } } } };
const wire = () => encodeMobileSealedCoreRequest(call(allocateOwnedSealedBytes(8))) as Wire;
function emitCore(value: unknown, listener: (value: unknown) => void) {
  const events = new EventEmitter(); attachMobileSealedCoreReceiver({ on(_event, callback) { events.on('message', callback); } }, event => listener(event.data));
  events.emit('message', { data: value });
}

test('M38发送端仍完整拒绝未知raw bytes、额外字段/getter/Proxy/SAB，原guard没有接纳新wire', () => {
  let getters = 0, traps = 0;
  const hidden = Object.defineProperty(new Uint8Array(8), 'extra', { get() { getters++; return 1; } });
  const symbol = Object.defineProperty(new Uint8Array(8), Symbol('额外'), { value: 1 });
  const proxy = new Proxy(new Uint8Array(8), { getPrototypeOf() { traps++; throw Error('不应执行'); } });
  const detached = new Uint8Array(8); structuredClone(detached, { transfer: [detached.buffer] });
  for (const bytes of [hidden, symbol, proxy, detached, Object.assign(new Uint8Array(8), { extra: 1 }),
    new Uint8Array(new SharedArrayBuffer(8)), Buffer.alloc(8), new (class extends Uint8Array {})(8), new Uint8Array(0), new Uint8Array(MOBILE_AUTH_SEALED_MAX_BYTES + 1)]) {
    assert.equal(isMobileOwnerPrivateRequest(call(bytes).request), false);
    assert.throws(() => encodeMobileSealedCoreRequest(call(bytes))); assert.throws(() => encodeMobileSealedOwnerRequest(owner(bytes)));
  }
  const valid = wire(); assert.equal(isMobileCorePrivateCall(valid), false); assert.equal(captureMobileCorePrivateCall(valid), null);
  assert.equal(captureMobileSealedRequestFromPort(valid), null, '未经过实际listener登记不能恢复资格。');
  for (const encode of [encodeMobileSealedCoreRequest, encodeMobileSealedOwnerRequest]) {
    const envelope = new Proxy({}, { getPrototypeOf() { traps++; throw Error('不应执行'); }, getOwnPropertyDescriptor() { traps++; throw Error('不应执行'); } });
    assert.throws(() => encode(envelope));
  }
  assert.equal(getters, 0); assert.equal(traps, 0);
});

test('M38传输buffer严拒forged/detached/resizable/Shared/Proxy/额外字段与错误offset/length，不执行getter', () => {
  let getters = 0, traps = 0;
  const detached = new ArrayBuffer(8); structuredClone(detached, { transfer: [detached] });
  const getter = Object.defineProperty(new ArrayBuffer(8), 'byteLength', { get() { getters++; return 8; } });
  const proxy = new Proxy(new ArrayBuffer(8), { ownKeys() { traps++; return []; } });
  const resizable = Reflect.construct(ArrayBuffer, [8, { maxByteLength: 16 }]) as ArrayBuffer;
  const bad = [Object.create(ArrayBuffer.prototype), detached, getter, proxy, resizable,
    new SharedArrayBuffer(8), Object.assign(new ArrayBuffer(8), { extra: true }), Object.defineProperty(new ArrayBuffer(8), Symbol('额外'), { value: 1 }),
    new Uint8Array(8), new ArrayBuffer(0), new ArrayBuffer(MOBILE_AUTH_SEALED_MAX_BYTES + 1)];
  for (const buffer of bad) {
    const value = wire(); Object.defineProperty(value.request.request.sealed, 'buffer', { value: buffer, enumerable: true });
    emitCore(value, decoded => { assert.equal(decoded, value); assert.equal(captureMobileCorePrivateCall(decoded), null); });
  }
  for (const [key, value] of [['byteOffset', 1], ['byteOffset', -1], ['byteLength', 7], ['byteLength', 9], ['byteLength', NaN], ['schema', '自报可信']] as const) {
    const packet = wire(); Object.defineProperty(packet.request.request.sealed, key, { value, enumerable: true });
    emitCore(packet, decoded => assert.equal(captureMobileCorePrivateCall(decoded), null));
  }
  for (const key of ['buffer', 'schema', 'byteOffset', 'byteLength']) {
    const packet = wire(); Object.defineProperty(packet.request.request.sealed, key, { get() { getters++; return 8; }, enumerable: true });
    emitCore(packet, decoded => assert.equal(captureMobileCorePrivateCall(decoded), null));
  }
  const extra = wire(); Object.defineProperty(extra.request.request.sealed, 'extra', { value: true });
  emitCore(extra, decoded => assert.equal(captureMobileCorePrivateCall(decoded), null));
  const metadataGetter = wire(); Object.defineProperty(metadataGetter.request.request, 'commitId', { get() { getters++; return randomUUID(); }, enumerable: true });
  emitCore(metadataGetter, decoded => assert.equal(captureMobileCorePrivateCall(decoded), null));
  assert.equal(getters, 0); assert.equal(traps, 0);
});

test('M38metadata只替sealed：原型/描述符/额外字段、dataset/revision/commit/envelope继续原guard拒绝', () => {
  const invalid = [
    (p: object) => Object.defineProperty(p, 'extra', { value: true }),
    (p: object) => Object.setPrototypeOf(p, { extra: true }),
    (p: object) => Object.defineProperty(p, 'id', { enumerable: false }),
    (p: object) => Object.defineProperty(p, 'id', { value: '不是原UUID' }),
    (p: object) => Object.defineProperty((p as Wire).request.request, 'expectedRevision', { value: -1 }),
    (p: object) => Object.defineProperty((p as Wire).request.request, 'datasetId', { value: 'different.dataset' }),
    (p: object) => Object.defineProperty((p as Wire).request.request, 'commitId', { value: '不是原UUID' }),
    (p: object) => Object.defineProperty((p as Wire).request.request, 'extra', { value: true }),
  ];
  for (const mutate of invalid) { const packet = wire(); mutate(packet); emitCore(packet, decoded => {
    assert.equal(decoded, packet); assert.equal(captureMobileCorePrivateCall(decoded), null);
  }); }
});

test('M38端口同步capture隔离新owned；重复/异步迟到/排队capture绝不能保存1字节占位', async () => {
  const packet = wire(), buffer = packet.request.request.sealed.buffer; new Uint8Array(buffer).fill(81);
  let bytes: Uint8Array | undefined;
  emitCore(packet, decoded => {
    const b = readMobileCorePrivateCallForCapture(decoded); assert.ok(b);
    const captured = b.capture(); assert.ok(captured.request.kind === 'playback-save'); bytes = captured.request.request.sealed;
    assert.equal(ownedSealedByteLength(bytes, MOBILE_AUTH_SEALED_MAX_BYTES), 8); assert.throws(() => b.capture());
    new Uint8Array(buffer).fill(0); assert.ok(bytes.every(n => n === 81));
  });
  let late: ReturnType<typeof readMobileCorePrivateCallForCapture>;
  emitCore(wire(), decoded => { late = readMobileCorePrivateCallForCapture(decoded); assert.ok(late); });
  await new Promise<void>(done => setImmediate(done)); assert.throws(() => late?.capture());
  let queued: Promise<void> | undefined;
  emitCore(wire(), decoded => { const b = readMobileCorePrivateCallForCapture(decoded); assert.ok(b);
    queued = Promise.resolve().then(() => { assert.throws(() => b.capture()); }); });
  await queued; assert.ok(bytes?.every(n => n === 81));
  const detached = wire(); emitCore(detached, decoded => {
    const b = readMobileCorePrivateCallForCapture(decoded); assert.ok(b);
    structuredClone(detached.request.request.sealed.buffer, { transfer: [detached.request.request.sealed.buffer] });
    assert.throws(() => b.capture()); assert.throws(() => b.capture());
  });
});

test('M38实际Owner MessageChannel同步消费；detach/close后不再登记，出站view不泄漏外侧字节或借用', async () => {
  const channel = new MessageChannel(), outer = new Uint8Array(24).fill(9), view = outer.subarray(7, 15); view.fill(63);
  const outgoing = encodeMobileSealedOwnerRequest(owner(view)); outer.fill(0);
  let resolve!: () => void; const done = new Promise<void>(yes => { resolve = yes; }); let received = 0;
  const detach = attachMobileSealedOwnerReceiver(channel.port2, value => {
    received++; const captured = captureDatasetOwnerRequest(value); assert.ok(captured && isDatasetOwnerRequest(captured));
    assert.ok(captured.mobile?.kind === 'playback-save'); const bytes = captured.mobile.request.sealed;
    assert.equal(bytes.byteLength, 8); assert.equal(bytes.byteOffset, 0); assert.equal(bytes.buffer.byteLength, 8); assert.ok(bytes.every(n => n === 63)); resolve();
  });
  try { channel.port1.postMessage(outgoing); await done; detach(); channel.port1.postMessage(outgoing);
    await new Promise<void>(yes => setImmediate(yes)); assert.equal(received, 1); }
  finally { channel.port1.close(); channel.port2.close(); }
});
