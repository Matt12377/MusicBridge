import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { captureMobileContentCoreResponse } from '../../src/mobile/content-rpc.js';
import { allocateOwnedSourceBytes, ownedSourceByteLength } from '../../src/mobile/owned-source-bytes.js';
import { mediaRequest, privatePathFixture } from './playback-private-path-fixture.js';
import { SOURCE_API, SOURCE_CALL, SOURCE_REQUEST, SOURCE_SIZE, byteScans, sourceBytes,
  sourcePipeline, sourceResponse } from './source-byte-pipeline-fixture.js';

test('媒体字节资格：未品牌原件的local捕获链保留13次guard，仅需3轮原始64KiB索引枚举', () => {
  const original = sourceBytes(), captured = byteScans(() => sourcePipeline(SOURCE_API, original));
  assert.deepEqual(captured.value, original);
  assert.notEqual(captured.value.buffer, original.buffer);
  assert.equal(captured.scans, 3);
});

test('媒体字节资格：捕获副本固定原生索引形状，外来合法原件不取得资格或别名', () => {
  const original = sourceBytes(), captured = captureMobileContentCoreResponse(sourceResponse(original), SOURCE_CALL);
  assert.ok(captured.action === 'source' && captured.kind === 'source' && captured.result.kind === 'mobile-source-read');
  assert.equal(Object.isExtensible(original), true);
  assert.equal(Object.isExtensible(captured.result.bytes), false);
  assert.equal(captured.result.bytes.byteOffset, 0);
  assert.equal(captured.result.bytes.buffer.byteLength, SOURCE_SIZE);
  original.fill(0); assert.equal(captured.result.bytes[1], 1);
  captured.result.bytes[2] = 73; assert.equal(original[2], 0);
  const again = byteScans(() => captureMobileContentCoreResponse(captured, SOURCE_CALL));
  assert.equal(again.scans, 0);
  assert.ok(again.value.action === 'source' && again.value.kind === 'source' && again.value.result.kind === 'mobile-source-read');
  assert.notEqual(again.value.result.bytes.buffer, captured.result.bytes.buffer);
});

test('媒体原始边界：错误身份、extra、Symbol、getter、Proxy、Buffer、SAB及超额不能被复制清洗', () => {
  let getters = 0;
  const extra = sourceBytes(); Object.defineProperty(extra, 'extra', { value: 1 });
  const symbol = sourceBytes(); Object.defineProperty(symbol, Symbol('extra'), { value: 1 });
  const getter = sourceBytes(); Object.defineProperty(getter, 'extra', { get() { getters++; return 1; } });
  class Subclass extends Uint8Array {}
  const prototype = sourceBytes(); Object.setPrototypeOf(prototype, {});
  for (const bytes of [extra, symbol, getter, new Proxy(sourceBytes(), {}), Buffer.alloc(SOURCE_SIZE),
    new Subclass(SOURCE_SIZE), new Uint8Array(new SharedArrayBuffer(SOURCE_SIZE)), prototype, new Uint8Array(SOURCE_SIZE + 1)]) {
    assert.throws(() => captureMobileContentCoreResponse(sourceResponse(bytes), SOURCE_CALL));
  }
  const valid = sourceResponse(sourceBytes());
  const resultGetter = { ...valid.result }; Object.defineProperty(resultGetter, 'bytes', { enumerable: true, get() { getters++; return sourceBytes(); } });
  for (const raw of [{ ...valid, extra: true }, { ...valid, result: { ...valid.result, extra: true } },
    { ...valid, result: resultGetter }, { ...valid, result: new Proxy(valid.result, {}) },
    { ...valid, scope: { ...valid.scope, deviceEpoch: 2 } },
    { ...valid, result: { ...valid.result, handle: SOURCE_REQUEST.readId } },
    { ...valid, result: { ...valid.result, readId: SOURCE_REQUEST.handle } },
    { ...valid, result: { ...valid.result, start: SOURCE_REQUEST.start + 1 } }]) {
    assert.throws(() => captureMobileContentCoreResponse(raw, SOURCE_CALL));
  }
  assert.equal(getters, 0);
});

test('媒体原始边界：真空EOF可捕获，detached不得借零长度成为EOF', () => {
  const empty = captureMobileContentCoreResponse(sourceResponse(new Uint8Array()), SOURCE_CALL);
  assert.ok(empty.action === 'source' && empty.kind === 'source' && empty.result.kind === 'mobile-source-read');
  assert.equal(empty.result.bytes.byteLength, 0);
  const detached = sourceBytes(); structuredClone(detached, { transfer: [detached.buffer] });
  assert.equal(detached.byteLength, 0);
  assert.throws(() => captureMobileContentCoreResponse(sourceResponse(detached), SOURCE_CALL));
});

test('媒体字节资格：仅自分配fixed存储有形状证明，外来非扩展对象不能伪造或跨detach复用', () => {
  for (const length of [-1, SOURCE_SIZE + 1, 0.5, NaN, Infinity]) assert.throws(() => allocateOwnedSourceBytes(length));
  const raw = sourceBytes(); Object.preventExtensions(raw);
  assert.equal(ownedSourceByteLength(raw, SOURCE_SIZE), null);
  const own = allocateOwnedSourceBytes(SOURCE_SIZE); own.set(raw);
  assert.equal(ownedSourceByteLength(own, SOURCE_SIZE), SOURCE_SIZE);
  assert.equal(ownedSourceByteLength(own, SOURCE_SIZE - 1), null);
  assert.equal(Reflect.defineProperty(own, 'extra', { value: 1 }), false);
  assert.equal(Reflect.setPrototypeOf(own, {}), false);
  let traps = 0;
  assert.equal(ownedSourceByteLength(new Proxy(own, { getPrototypeOf() { traps++; return Uint8Array.prototype; } }), SOURCE_SIZE), null);
  assert.equal(traps, 0);
  own[1] = 73; assert.equal(ownedSourceByteLength(own, SOURCE_SIZE), SOURCE_SIZE);
  structuredClone(own, { transfer: [own.buffer] });
  assert.equal(ownedSourceByteLength(own, SOURCE_SIZE), null);
  assert.throws(() => captureMobileContentCoreResponse(sourceResponse(own), SOURCE_CALL));
  const empty = allocateOwnedSourceBytes(0);
  assert.equal(ownedSourceByteLength(empty, SOURCE_SIZE), 0);
  assert.equal(ownedSourceByteLength(structuredClone(empty), SOURCE_SIZE), null);
  structuredClone(empty, { transfer: [empty.buffer] });
  assert.equal(ownedSourceByteLength(empty, SOURCE_SIZE), null);
});

test('媒体原始边界：RAB及切片保持原准入，捕获只持fixed副本且不随原件resize或transfer变化', () => {
  type ResizableBuffer = ArrayBuffer & { resizable: boolean; resize(length: number): void };
  const ResizableArrayBuffer = ArrayBuffer as unknown as new (length: number, options: { maxByteLength: number }) => ResizableBuffer;
  const buffer = new ResizableArrayBuffer(SOURCE_SIZE + 8, { maxByteLength: SOURCE_SIZE * 2 });
  const view = new Uint8Array(buffer, 8, SOURCE_SIZE); view.set(sourceBytes());
  const captured = byteScans(() => captureMobileContentCoreResponse(sourceResponse(view), SOURCE_CALL));
  assert.equal(captured.scans, 1);
  assert.ok(captured.value.action === 'source' && captured.value.kind === 'source' && captured.value.result.kind === 'mobile-source-read');
  const bytes = captured.value.result.bytes;
  assert.equal((bytes.buffer as ResizableBuffer).resizable, false);
  assert.equal(bytes.byteOffset, 0); assert.equal(bytes.buffer.byteLength, SOURCE_SIZE);
  assert.equal(ownedSourceByteLength(bytes, SOURCE_SIZE), SOURCE_SIZE);
  buffer.resize(0); assert.equal(view.byteLength, 0); assert.deepEqual(bytes, sourceBytes());
  structuredClone(buffer, { transfer: [buffer] }); assert.deepEqual(bytes, sourceBytes());
  const empty = new Uint8Array(new ResizableArrayBuffer(0, { maxByteLength: SOURCE_SIZE }));
  assert.doesNotThrow(() => captureMobileContentCoreResponse(sourceResponse(empty), SOURCE_CALL));
});

test('媒体真实线程边界：品牌不跨IPC，Worker与Main各完整核原件一次后才拥有本地副本', { timeout: 15_000 }, async t => {
  const worker = new Worker(new URL('./owned-source-bytes-worker.mjs', import.meta.url), {
    execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64, stackSizeMb: 4 },
  });
  t.after(() => worker.terminate());
  const exit = once(worker, 'exit');
  const ready = once(worker, 'message'); assert.deepEqual((await ready)[0], { kind: 'ready' });
  const captured = captureMobileContentCoreResponse(sourceResponse(sourceBytes()), SOURCE_CALL);
  assert.ok(captured.action === 'source' && captured.kind === 'source' && captured.result.kind === 'mobile-source-read');
  assert.equal(ownedSourceByteLength(captured.result.bytes, SOURCE_SIZE), SOURCE_SIZE);
  const returning = once(worker, 'message'); worker.postMessage({ call: SOURCE_CALL, response: captured });
  const [reply] = await returning as [{ kind: string; ownedBefore: number | null; ownedAfter: number | null;
    scans: number; response: unknown }];
  assert.equal(reply.kind, 'returned'); assert.equal(reply.ownedBefore, null); assert.equal(reply.ownedAfter, SOURCE_SIZE);
  assert.equal(reply.scans, 1);
  const received = byteScans(() => captureMobileContentCoreResponse(reply.response, SOURCE_CALL));
  assert.equal(received.scans, 1);
  assert.ok(received.value.action === 'source' && received.value.kind === 'source' && received.value.result.kind === 'mobile-source-read');
  assert.deepEqual(received.value.result.bytes, sourceBytes());
  worker.postMessage({ kind: 'close' }); assert.deepEqual(await exit, [0]);
  assert.equal(worker.threadId, -1);
});

test('媒体完整捕获链接入原可信读：256KiB四片与17次fresh授权、双源水位次数保持', async t => {
  const f = privatePathFixture(t), { resource } = await f.ready();
  const slice = f.data.slice.bind(f.data); let pipelines = 0, scans = 0;
  // 只替换本用例的合成字节生产器；服务、组合、beforeSend及授权均使用原生产实现。
  Object.defineProperty(f.data, 'slice', { value(start: number, end: number) {
    const captured = byteScans(() => sourcePipeline(SOURCE_API, slice(start, end)));
    pipelines++; scans += captured.scans; return captured.value;
  } });
  f.reset();
  const media = await f.service.openMedia('getMediaAsset', mediaRequest(resource), new AbortController().signal, { range: 'bytes=0-262143' });
  await media.beforeSend(); const chunks: Uint8Array[] = [];
  for (let index = 0; index < 4; index++) { chunks.push(await media.reader!.read(SOURCE_SIZE)); await media.beforeSend(); }
  assert.deepEqual(Buffer.concat(chunks), Buffer.from(f.data));
  assert.equal(f.auth(), 17); assert.deepEqual(f.watermarks(), [4, 4]); assert.equal(f.reads.length, 4);
  assert.equal(pipelines, 4); assert.equal(scans, 12); await media.close();
});
