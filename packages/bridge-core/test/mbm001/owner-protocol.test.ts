import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { isMobileCorePrivateCall, isMobileOwnerPrivateRequest, isMobileOwnerPrivateResult } from '../../src/mobile/owner-protocol.js';

test('闭集私有信封拒绝可克隆强制转换对象及字符串状态，不调用getter', () => {
  const datasetId = randomUUID(), request = { kind: 'catalog', datasetId, request: { operation: { toString: 'x' }, serverId: randomUUID(), offset: 0, limit: 1, q: '', albumId: null, itemId: null, expectedRevision: null } };
  assert.doesNotThrow(() => assert.equal(isMobileCorePrivateCall({ type: 'mobile-main-request', id: randomUUID(), request: structuredClone(request) }), false));
  const load = { kind: 'load' as const, datasetId };
  assert.equal(isMobileOwnerPrivateResult({ kind: 'mobile-error', status: '503', code: 'BUSY', retryable: false, outcome: null }, load), false);
  assert.equal(isMobileOwnerPrivateResult({ kind: 'mobile-error', status: 503, code: { toString: 'x' }, retryable: false, outcome: null }, load), false);
  let reads = 0; const getter = { kind: 'load', get datasetId() { reads++; return datasetId; } };
  assert.equal(isMobileOwnerPrivateRequest(getter), false); assert.equal(reads, 0);
  // 002开启值只属于可信私有请求；缺省仍兼容001，任何自报强制转换或新增可用性字段都拒绝。
  const catalog = { operation: 'listTracks', serverId: randomUUID(), offset: 0, limit: 1, q: '', albumId: null, itemId: null, expectedRevision: null };
  const catalogRequest = (value: object) => ({ kind: 'catalog', datasetId, request: value });
  assert.equal(isMobileOwnerPrivateRequest(catalogRequest(catalog)), true);
  for (const enabled of [false, true]) assert.equal(isMobileOwnerPrivateRequest(catalogRequest({ ...catalog, catalogPlaybackEnabled: enabled })), true);
  for (const forged of [undefined, null, 0, 1, 'true', { valueOf: true }]) {
    assert.equal(isMobileOwnerPrivateRequest(catalogRequest({ ...catalog, catalogPlaybackEnabled: forged })), false);
  }
  const flagGetter = { ...catalog, get catalogPlaybackEnabled() { reads++; return true; } };
  assert.equal(isMobileOwnerPrivateRequest(catalogRequest(flagGetter)), false); assert.equal(reads, 0);
  const hiddenFlag = Object.defineProperty({ ...catalog }, 'catalogPlaybackEnabled', { value: true, enumerable: false });
  assert.equal(isMobileOwnerPrivateRequest(catalogRequest(hiddenFlag)), false);
  assert.equal(isMobileOwnerPrivateRequest(catalogRequest({ ...catalog, catalogPlaybackEnabled: true, availability: 'available' })), false);
});
test('私有密文二进制拒绝Shared、子类及隐藏getter，不伪称完整原字节', () => {
  const datasetId = randomUUID();
  const request = (sealed: unknown) => ({ kind: 'save', datasetId, request: { datasetId, expectedRevision: 0, commitId: randomUUID(), sealed } });
  assert.equal(isMobileOwnerPrivateRequest(request(new Uint8Array([1, 2, 3]))), true);
  assert.equal(isMobileOwnerPrivateRequest(request(new Uint8Array(new SharedArrayBuffer(3)))), false);
  assert.equal(isMobileOwnerPrivateRequest(request(Buffer.from([1, 2, 3]))), false);
  let reads = 0; const hidden = new Uint8Array([1, 2, 3]); Object.defineProperty(hidden, 'length', { get() { reads++; return 3; } });
  assert.equal(isMobileOwnerPrivateRequest(request(hidden)), false); assert.equal(reads, 0);
  assert.equal(isMobileOwnerPrivateRequest({ ...request(new Uint8Array([1])), request: { datasetId: randomUUID(), expectedRevision: 0, commitId: randomUUID(), sealed: new Uint8Array([1]) } }), false);
});
