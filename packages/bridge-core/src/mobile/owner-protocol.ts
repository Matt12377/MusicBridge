import { isMobileId, isMobileAlbum, isMobileTrack, MOBILE_API_RESPONSE_MAX_BYTES, MOBILE_SAFE_ERROR_CODES } from '@music-bridge/contracts';
import { isMobileOwnerSourceRequest, isMobileOwnerSourceResult } from './source-protocol.js';
import { isMobileContentOwnerRequest, isMobileContentOwnerResult } from './owner-content-protocol.js';
import { types } from 'node:util';
import { ownedSealedByteLength } from './owned-sealed-bytes.js';
import { isPlaybackHistoryRequest, isPlaybackHistoryReply } from './playback-history-protocol.js';
import {
  MOBILE_AUTH_SEALED_MAX_BYTES, type MobileOwnerCatalogRequest,
  type MobileOwnerCatalogSelectedRequest,
  type MobileOwnerPrivateRequest, type MobileOwnerPrivateResult,
} from './types.js';

const safeCodes: readonly string[] = MOBILE_SAFE_ERROR_CODES;
const integer = (v: unknown, min: number, max = Number.MAX_SAFE_INTEGER): v is number => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max;
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(v);
function closed(value: unknown, names: readonly string[]): value is Record<string, unknown> {
  try {
    if (!value || typeof value !== 'object' || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
    return keys.length === names.length && names.every(name => {
      const d = descriptors[name]; return d?.enumerable === true && Object.hasOwn(d, 'value');
    });
  } catch { return false; }
}
const typedArray = Object.getPrototypeOf(Uint8Array.prototype) as object;
const byteLength = Object.getOwnPropertyDescriptor(typedArray, 'byteLength')!.get!;
const byteBuffer = Object.getOwnPropertyDescriptor(typedArray, 'buffer')!.get!;
function bytes(value: unknown, maximum: number): value is Uint8Array {
  try {
    if (!(value instanceof Uint8Array) || Object.getPrototypeOf(value) !== Uint8Array.prototype) return false;
    const length = byteLength.call(value) as number;
    return length > 0 && length <= maximum && !(byteBuffer.call(value) instanceof SharedArrayBuffer)
      && Reflect.ownKeys(value).every(key => typeof key === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(key) && Number(key) < length);
  } catch { return false; }
}
function sealedBytes(value: unknown): value is Uint8Array {
  if (types.isProxy(value)) return false;
  return ownedSealedByteLength(value, MOBILE_AUTH_SEALED_MAX_BYTES) !== null || bytes(value, MOBILE_AUTH_SEALED_MAX_BYTES);
}
function dense(value: unknown, maximum: number): value is unknown[] {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let i = 0; i < value.length; i++) { const d = Object.getOwnPropertyDescriptor(value, String(i)); if (!d?.enumerable || !Object.hasOwn(d, 'value')) return false; }
  return true;
}
export function isMobileOwnerCatalogRequest(v: unknown): v is MobileOwnerCatalogRequest {
  const keys = ['operation', 'serverId', 'offset', 'limit', 'q', 'albumId', 'itemId', 'expectedRevision'];
  return (closed(v, keys) || closed(v, [...keys, 'catalogPlaybackEnabled']) && typeof v.catalogPlaybackEnabled === 'boolean')
    && typeof v.operation === 'string' && ['listAlbums', 'getAlbum', 'listTracks', 'getTrack'].includes(v.operation) && isMobileId(v.serverId)
    && integer(v.offset, 0, 300000) && integer(v.limit, 1, 100) && typeof v.q === 'string' && [...v.q].length <= 200
    && (v.albumId === null || isMobileId(v.albumId)) && (v.itemId === null || isMobileId(v.itemId))
    && (v.expectedRevision === null || isMobileId(v.expectedRevision))
    && (v.operation.startsWith('get') ? v.itemId !== null && v.offset === 0 && v.limit === 1 : v.itemId === null);
}
export function isMobileOwnerCatalogSelectedRequest(v: unknown): v is MobileOwnerCatalogSelectedRequest {
  const keys = ['kind', 'ids', 'sourceRevision', 'serverId'];
  return (closed(v, keys) || closed(v, [...keys, 'catalogPlaybackEnabled']) && typeof v.catalogPlaybackEnabled === 'boolean')
    && (v.kind === 'albums' || v.kind === 'tracks') && isMobileId(v.serverId) && isMobileId(v.sourceRevision)
    && dense(v.ids, 100) && v.ids.every(isMobileId) && new Set(v.ids).size === v.ids.length;
}
export function isMobileOwnerPrivateRequest(v: unknown): v is MobileOwnerPrivateRequest {
  if (closed(v, ['kind', 'datasetId']) && (v.kind === 'load' || v.kind === 'playback-load')) return isMobileId(v.datasetId);
  if (!closed(v, ['kind', 'datasetId', 'request']) || !isMobileId(v.datasetId)) return false;
  if (v.kind === 'catalog') return isMobileOwnerCatalogRequest(v.request);
  if (v.kind === 'catalog-selected') return isMobileOwnerCatalogSelectedRequest(v.request);
  if (v.kind === 'media-source') return isMobileOwnerSourceRequest(v.request);
  if (v.kind === 'content') return isMobileContentOwnerRequest(v.request);
  if (v.kind === 'playback-history') return isPlaybackHistoryRequest(v.request) && v.request.datasetId === v.datasetId;
  if (v.kind === 'playback-activity') return closed(v.request, ['operation']) && v.request.operation === 'begin'
    || closed(v.request, ['operation', 'ownerEpoch', 'leaseId']) && v.request.operation === 'end'
      && uuid(v.request.ownerEpoch) && uuid(v.request.leaseId);
  if (v.kind === 'artwork') return closed(v.request, ['serverId', 'artworkId']) && isMobileId(v.request.serverId) && isMobileId(v.request.artworkId);
  if (v.kind === 'save' || v.kind === 'playback-save') return closed(v.request, ['datasetId', 'expectedRevision', 'commitId', 'sealed'])
    && v.request.datasetId === v.datasetId && integer(v.request.expectedRevision, 0, Number.MAX_SAFE_INTEGER - 1)
    && uuid(v.request.commitId) && sealedBytes(v.request.sealed);
  return false;
}
export function isMobileOwnerPrivateResult(v: unknown, request: MobileOwnerPrivateRequest): v is MobileOwnerPrivateResult {
  // 内容 UNKNOWN 必须携原 commit 身份，不能退化成缺失该身份的通用失败。
  if (request.kind === 'content') return isMobileContentOwnerResult(v, request.request);
  if (closed(v, ['kind', 'status', 'code', 'retryable', 'outcome']) && v.kind === 'mobile-error') {
    return typeof v.status === 'number' && [400, 401, 403, 404, 409, 410, 413, 429, 503].includes(v.status) && typeof v.code === 'string' && safeCodes.includes(v.code)
      && typeof v.retryable === 'boolean' && [null, 'not-sent', 'unknown'].includes(v.outcome as null | string);
  }
  if (request.kind === 'media-source') return isMobileOwnerSourceResult(v, request.request);
  if (request.kind === 'playback-history') return isPlaybackHistoryReply(v, request.request);
  if (request.kind === 'playback-activity') return closed(v, ['kind', 'datasetId', 'ownerEpoch', 'operation', 'leaseId'])
    && v.kind === 'playback-activity' && v.datasetId === request.datasetId && uuid(v.ownerEpoch) && v.operation === request.request.operation
    && (request.request.operation === 'begin' ? v.leaseId === null || uuid(v.leaseId)
      : v.ownerEpoch === request.request.ownerEpoch && v.leaseId === request.request.leaseId);
  if (request.kind === 'load' || request.kind === 'playback-load') return closed(v, ['kind', 'datasetId', 'revision']) && v.kind === 'missing' && v.datasetId === request.datasetId && v.revision === 0
    || closed(v, ['kind', 'datasetId', 'revision', 'commitId', 'sealed']) && v.kind === 'sealed' && v.datasetId === request.datasetId
      && integer(v.revision, 1) && uuid(v.commitId) && sealedBytes(v.sealed);
  if (request.kind === 'save' || request.kind === 'playback-save') return closed(v, ['kind', 'datasetId', 'revision', 'commitId']) && v.kind === 'saved'
      && v.datasetId === request.datasetId && v.revision === request.request.expectedRevision + 1 && v.commitId === request.request.commitId
    || closed(v, ['kind', 'datasetId', 'currentRevision']) && v.kind === 'conflict' && v.datasetId === request.datasetId && integer(v.currentRevision, 0);
  if (request.kind === 'artwork') return closed(v, ['datasetId', 'ownerEpoch', 'libraryRevision', 'artworkId', 'selectionRevision', 'contentType', 'bytes'])
    && v.datasetId === request.datasetId && uuid(v.ownerEpoch) && isMobileId(v.libraryRevision) && v.artworkId === request.request.artworkId
    && isMobileId(v.selectionRevision) && v.contentType === 'image/jpeg' && bytes(v.bytes, 1024 * 1024);
  if (request.kind === 'catalog-selected') {
    if (!closed(v, ['datasetId', 'ownerEpoch', 'sourceRevision', 'libraryRevision', 'kind', 'items'])
      || v.datasetId !== request.datasetId || !uuid(v.ownerEpoch) || !isMobileId(v.libraryRevision)
      || v.sourceRevision !== request.request.sourceRevision || v.kind !== request.request.kind
      || !dense(v.items, 100) || v.items.length !== request.request.ids.length) return false;
    const valid = v.kind === 'albums' ? isMobileAlbum : isMobileTrack;
    if (!v.items.every((item, index) => valid(item) && item.source === 'local' && item.id === request.request.ids[index])) return false;
    try { return Buffer.byteLength(JSON.stringify(v)) <= MOBILE_API_RESPONSE_MAX_BYTES; } catch { return false; }
  }
  if (request.kind !== 'catalog') return false;
  if (!closed(v, ['datasetId', 'ownerEpoch', 'libraryRevision', 'operation', 'offset', 'limit', 'total', 'items'])
    || v.datasetId !== request.datasetId || !uuid(v.ownerEpoch) || !isMobileId(v.libraryRevision)
    || v.operation !== request.request.operation || v.offset !== request.request.offset || v.limit !== request.request.limit
    || !integer(v.total, 0, 300000) || !dense(v.items, request.request.limit)
    || v.items.length !== Math.max(0, Math.min(request.request.limit, v.total - request.request.offset))) return false;
  const album = request.request.operation === 'getAlbum' || request.request.operation === 'listAlbums';
  if (!v.items.every(album ? isMobileAlbum : isMobileTrack)) return false;
  try { return Buffer.byteLength(JSON.stringify(v)) <= MOBILE_API_RESPONSE_MAX_BYTES; } catch { return false; }
}

export interface MobileCorePrivateCall { type: 'mobile-main-request'; id: string; request: MobileOwnerPrivateRequest; ownerLoadTrace?: number; catalogTrace?: unknown }
export type MobileCorePrivateReply = { type: 'mobile-main-response'; id: string; result: MobileOwnerPrivateResult };
export function isMobileCorePrivateCall(v: unknown): v is MobileCorePrivateCall {
  return (closed(v, ['type', 'id', 'request']) || closed(v, ['type', 'id', 'request', 'ownerLoadTrace']) || closed(v, ['type', 'id', 'request', 'catalogTrace']))
    && v.type === 'mobile-main-request' && uuid(v.id) && isMobileOwnerPrivateRequest(v.request)
    && (!Object.hasOwn(v, 'catalogTrace') || v.request.kind === 'catalog' && v.request.request.operation === 'listTracks')
    && (!Object.hasOwn(v, 'ownerLoadTrace') || v.request.kind === 'load' && integer(v.ownerLoadTrace, 1, 8));
}
export function isMobileCorePrivateReply(v: unknown, call: MobileCorePrivateCall): v is MobileCorePrivateReply {
  return closed(v, ['type', 'id', 'result']) && v.type === 'mobile-main-response' && v.id === call.id && isMobileOwnerPrivateResult(v.result, call.request);
}
