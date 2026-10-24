import assert from 'node:assert/strict';
import * as protocol from '../../src/mobile/source-protocol.js';
import * as boundary from '../../src/mobile/owner-boundary-capture.js';
import * as rpc from '../../src/mobile/content-rpc.js';
import type { MobileContentScope } from '../../src/mobile/content-types.js';

export const SOURCE_SIZE = 64 * 1024;
export const SOURCE_SCOPE: Readonly<MobileContentScope> = Object.freeze({
  serverId: 'server.source-byte-fixture', datasetId: 'dataset.source-byte-fixture',
  deviceId: 'device.source-byte-fixture', deviceEpoch: 1, accessGeneration: 1,
  ownerEpoch: 'owner.source-byte-fixture', accountDomain: 'local:dataset.source-byte-fixture', providerEpoch: null,
});
export const SOURCE_REQUEST = Object.freeze({ operation: 'read' as const,
  handle: '20000000-0000-4000-8000-000000000001', readId: '20000000-0000-4000-8000-000000000002',
  start: 65536, maxBytes: SOURCE_SIZE });
export const SOURCE_CALL: Extract<rpc.MobileContentCoreRequest, { action: 'source' }> = {
  type: 'mobile-content-core-request', id: '20000000-0000-4000-8000-000000000003',
  action: 'source', scope: SOURCE_SCOPE, request: SOURCE_REQUEST,
};
export const SOURCE_API = { protocol, boundary, rpc };
export type SourcePipelineApi = typeof SOURCE_API;
export const sourceBytes = () => Uint8Array.from({ length: SOURCE_SIZE }, (_, index) => index % 251);
export const sourceResult = (bytes: Uint8Array) => ({ kind: 'mobile-source-read' as const,
  handle: SOURCE_REQUEST.handle, readId: SOURCE_REQUEST.readId, start: SOURCE_REQUEST.start, bytes });
export const sourceResponse = (bytes: Uint8Array) => ({ type: 'mobile-content-core-response' as const,
  id: SOURCE_CALL.id, action: 'source' as const, kind: 'source' as const,
  scope: SOURCE_SCOPE, source: 'local' as const, result: sourceResult(bytes) });

export function byteScans<T>(work: () => T): { value: T; scans: number } {
  const ownKeys = Reflect.ownKeys; let scans = 0;
  Reflect.ownKeys = value => { if (value instanceof Uint8Array) scans++; return ownKeys(value); };
  try { return { value: work(), scans }; } finally { Reflect.ownKeys = ownKeys; }
}

/** 对应原生产 local 路径的三次源 guard、五次 capture 和一次 Core→Main clone。 */
export function sourcePipeline(api: SourcePipelineApi, bytes: Uint8Array): Uint8Array {
  const original = sourceResult(bytes);
  assert.equal(api.protocol.isMobileOwnerSourceResult(original, SOURCE_REQUEST), true);
  const received = api.boundary.captureMobileOwnerPrivateResult(original,
    { kind: 'media-source', datasetId: SOURCE_SCOPE.datasetId, request: SOURCE_REQUEST });
  assert.ok(received && 'kind' in received && received.kind === 'mobile-source-read');
  assert.equal(api.protocol.isMobileOwnerSourceResult(received, SOURCE_REQUEST), true);
  let response = { ...sourceResponse(bytes), result: received } as rpc.MobileContentCoreResponse;
  for (let index = 0; index < 3; index++) response = api.rpc.captureMobileContentCoreResponse(response, SOURCE_CALL);
  // 真实进程边界由独立 Worker 用例补证；这里固定原序列化位置，品牌不得跨过它。
  response = structuredClone(response);
  for (let index = 0; index < 2; index++) response = api.rpc.captureMobileContentCoreResponse(response, SOURCE_CALL);
  assert.ok(response.action === 'source' && response.kind === 'source' && response.result.kind === 'mobile-source-read');
  return response.result.bytes;
}
