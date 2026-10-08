import assert from 'node:assert/strict';
import test from 'node:test';
import * as c from '../../src/index.js';
import { confirm, hash, id, original as originalFixture, originalPacket, other, receipt } from './fixtures.js';

/** 先证明材料基准有效，再改变待测边界，防止负例在无关 metadata 阶段假绿。 */
function original(): c.AttachLocalSourceWritesOriginal {
  const value = originalFixture();
  assert.equal(c.isLocalArtworkTarget(value.target), true, '原图夹具必须符合冻结 Artwork target 合同。');
  assert.doesNotThrow(() => c.localSourceWritesOriginalSnapshot(value), '原图夹具必须先通过有效材料捕获。');
  return value;
}

test('012 原图 transport 捕获自有连续字节，修改原 backing 不改变独立材料', () => {
  const input = original(), captured = c.localSourceWritesOriginalSnapshot(input);
  assert.deepEqual(Array.from(captured.bytes), [1, 2, 3, 4]);
  assert.notEqual(captured.bytes.buffer, input.bytes.buffer);
  input.bytes[0] = 255; assert.equal(captured.bytes[0], 1);
  assert.ok(Object.isFrozen(captured)); assert.ok(Object.isFrozen(captured.target));
  assert.equal(c.isSourceWritesMainRequest(originalPacket()), true);
});

test('012 原图原生 brand 检查拒共享/可调整/巨大 backing view/JSON/base64/伪 typed array', () => {
  const ResizableArrayBuffer = ArrayBuffer as unknown as new (length: number, options: { maxByteLength: number }) => ArrayBuffer;
  const values: unknown[] = [new Uint8Array(new SharedArrayBuffer(4)), new Uint8Array(new ResizableArrayBuffer(4, { maxByteLength: 8 })), new Uint8Array(new ArrayBuffer(65536), 0, 4), new Uint8Array(new ArrayBuffer(8), 4, 4), [1, 2, 3, 4], 'AQIDBA==', { buffer: new ArrayBuffer(4), byteLength: 4, byteOffset: 0 }, Object.create(Uint8Array.prototype), Buffer.from([1, 2, 3, 4])];
  for (const bytes of values) assert.throws(() => c.localSourceWritesOriginalSnapshot({ ...original(), bytes }));
  assert.throws(() => c.localSourceWritesOriginalSnapshot({ ...original(), bytes: new Uint8Array(0) }));
  const revoked = Proxy.revocable(new Uint8Array(4), {}); revoked.revoke();
  assert.throws(() => c.localSourceWritesOriginalSnapshot({ ...original(), bytes: revoked.proxy }));
});

test('012 二进制准确 4MiB 上限，材料长度与原声明必须相同', () => {
  const bytes = new Uint8Array(4194304), input = { ...original(), original: { ...original().original, bytes: bytes.byteLength }, bytes };
  assert.equal(c.localSourceWritesOriginalSnapshot(input).bytes.byteLength, 4194304);
  assert.throws(() => c.localSourceWritesOriginalSnapshot({ ...input, bytes: new Uint8Array(4194305), original: { ...input.original, bytes: 4194305 } }));
  assert.throws(() => c.localSourceWritesOriginalSnapshot({ ...input, original: { ...input.original, bytes: 4 } }));
});

test('012 材料捕获不使用 iterator/影子 buffer getter，也不枚举字节描述符', () => {
  const bytes = new Uint8Array([1, 2, 3, 4]); let reads = 0;
  Object.defineProperty(bytes, 'buffer', { get: () => { reads++; throw new Error('影子 backing'); } });
  Object.defineProperty(bytes, Symbol.iterator, { get: () => { reads++; throw new Error('不能迭代原始输入'); } });
  assert.deepEqual(Array.from(c.localSourceWritesOriginalSnapshot({ ...original(), bytes }).bytes), [1, 2, 3, 4]); assert.equal(reads, 0);
});

test('012 私有 metadata 在 byte 捕获前拒 getter/符号/超限，整个封套≤16KiB', () => {
  let reads = 0; const input = original(); Object.defineProperty(input, 'bytes', { enumerable: true, get: () => { reads++; return original().bytes; } });
  assert.throws(() => c.localSourceWritesOriginalSnapshot(input)); assert.equal(reads, 0);
  assert.throws(() => c.localSourceWritesOriginalSnapshot({ ...original(), [Symbol('额外授权')]: true }));
  assert.throws(() => c.localSourceWritesOriginalSnapshot({ ...original(), target: { ...original().target, expectedTrackRevision: '1'.repeat(16384) } }));
  assert.equal(c.isSourceWritesMainRequest(originalPacket()), true, '私有 packet 的基准必须有效。');
  assert.equal(c.isSourceWritesMainRequest({ ...originalPacket(), sequence: 0 }), false);
  assert.equal(c.isSourceWritesMainRequest({ ...originalPacket(), sequence: Number.MAX_SAFE_INTEGER + 1 }), false);
  assert.equal(c.isSourceWritesMainRequest({ ...originalPacket(), extra: '私有路径' }), false);
});

test('012 private challenge/grant 仅是端口 DTO，不接受 public approval/路径或跨dataset', () => {
  const grant = { challengeId: id, ownerEpoch: other, nonce: hash, authorityId: id, signature: hash };
  const request: c.SourceWritesMainRequest = { version: 1, type: 'source-writes-request', requestId: id, sequence: 1, command: 'localSourceWrites.executeGranted', payload: { datasetId: id, confirm: confirm(), grant } };
  assert.equal(c.isSourceWritesMainRequest(request), true);
  for (const change of [{ grant: { ...grant, ownerEpoch: '1' } }, { grant: { ...grant, nonce: id } }, { grant: { ...grant, signature: hash.toUpperCase() } }, { datasetId: other }, { userConfirmed: true }, { fd: 4 }, { path: '原件' }]) assert.equal(c.isSourceWritesMainRequest({ ...request, payload: { ...request.payload, ...change } }), false);
  assert.equal(c.validateIpcRequest({ version: c.IPC_VERSION, id, command: request.command, payload: request.payload, expectedDatasetId: id }).ok, false);
  assert.equal(c.validateIpcInternalRequest({ version: c.IPC_VERSION, id, command: request.command, payload: request.payload, expectedDatasetId: id }).ok, false);
});

test('012 private response 按原命令及序列回执闭合，拒额外能力与伪失败', () => {
  const attached = { version: 1, type: 'source-writes-response', requestId: id, sequence: 1, ok: true, result: { contentRef: id, sha256: hash, bytes: 4 } };
  assert.equal(c.isSourceWritesMainResponse(attached, 'localSourceWrites.attachOriginal'), true);
  assert.equal(c.isSourceWritesMainResponse(attached, 'localSourceWrites.executeGranted'), false);
  assert.equal(c.isSourceWritesMainResponse({ ...attached, result: { ...attached.result, path: '秘密原图' } }, 'localSourceWrites.attachOriginal'), false);
  const executed = { ...attached, result: receipt() };
  assert.equal(c.isSourceWritesMainResponse(executed, 'localSourceWrites.executeGranted'), true);
  const failed = { version: 1, type: 'source-writes-response', requestId: id, sequence: 1, ok: false, failure: { version: c.IPC_VERSION, id, ok: false, error: { code: 'INVENTORY_UNAVAILABLE', message: '源写结果待核对。' } } };
  assert.equal(c.isSourceWritesMainResponse(failed, 'localSourceWrites.executeGranted'), true);
  assert.equal(c.isSourceWritesMainResponse({ ...failed, result: receipt() }, 'localSourceWrites.executeGranted'), false);
  assert.equal(c.isSourceWritesMainResponse({ ...failed, failure: { ...failed.failure, id: other } }, 'localSourceWrites.executeGranted'), false);
  assert.equal(c.isSourceWritesMainResponse({ ...failed, failure: { ...failed.failure, error: { ...failed.failure.error, stack: '秘密失败' } } }, 'localSourceWrites.executeGranted'), false);
});

test('012 challenge 完整绑定与私有 UUID，字段缺失不能伪装为授权回执', () => {
  const challenge: c.LocalSourceWritesChallenge = { datasetId: id, commandId: other, planId: id, expectedViewRevision: '1', range: 'TAGS', planHash: hash, contextFingerprint: hash, policyRevision: '1', requestFingerprint: hash, expiresAt: '2026-10-08T00:10:00.000Z', grant: { challengeId: id, ownerEpoch: other, nonce: hash, authorityId: id, signature: hash } };
  assert.equal(c.isLocalSourceWritesPrivateCommandResult('localSourceWrites.challenge', challenge), true);
  for (const change of [{ policyRevision: '0' }, { range: 'MB_ONLY' }, { expiresAt: '2026-02-31T00:00:00.000Z' }, { grant: { ...challenge.grant, ownerEpoch: '1' } }, { permission: true }]) assert.equal(c.isLocalSourceWritesPrivateCommandResult('localSourceWrites.challenge', { ...challenge, ...change }), false);
});
