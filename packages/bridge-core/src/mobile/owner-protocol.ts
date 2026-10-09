import { isMobileId, isMobileAlbum, isMobileTrack, MOBILE_API_RESPONSE_MAX_BYTES } from '@music-bridge/contracts';
import {
  MOBILE_AUTH_SEALED_MAX_BYTES, type MobileOwnerCatalogRequest,
  type MobileOwnerPrivateRequest, type MobileOwnerPrivateResult,
} from './types.js';

const safeCodes = ['INVALID_REQUEST', 'UNAUTHORIZED', 'SOURCE_CHANGED', 'CURSOR_INVALID', 'REVISION_CONFLICT',
  'IDEMPOTENCY_CONFLICT', 'UNSUPPORTED_FORMAT', 'BUSY', 'CONTENT_LIMIT_EXCEEDED'];
const integer = (v: unknown, min: number, max = Number.MAX_SAFE_INTEGER): v is number => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max;
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(v);
function closed(value: unknown, names: readonly string[]): value is Record<string, unknown> {
  try {
    if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
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
function dense(value: unknown, maximum: number): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let i = 0; i < value.length; i++) { const d = Object.getOwnPropertyDescriptor(value, String(i)); if (!d?.enumerable || !Object.hasOwn(d, 'value')) return false; }
  return true;
}
export function isMobileOwnerCatalogRequest(v: unknown): v is MobileOwnerCatalogRequest {
  return closed(v, ['operation', 'serverId', 'offset', 'limit', 'q', 'albumId', 'itemId', 'expectedRevision'])
    && typeof v.operation === 'string' && ['listAlbums', 'getAlbum', 'listTracks', 'getTrack'].includes(v.operation) && isMobileId(v.serverId)
    && integer(v.offset, 0, 300000) && integer(v.limit, 1, 100) && typeof v.q === 'string' && [...v.q].length <= 200
    && (v.albumId === null || isMobileId(v.albumId)) && (v.itemId === null || isMobileId(v.itemId))
    && (v.expectedRevision === null || isMobileId(v.expectedRevision))
    && (v.operation.startsWith('get') ? v.itemId !== null && v.offset === 0 && v.limit === 1 : v.itemId === null);
}
export function isMobileOwnerPrivateRequest(v: unknown): v is MobileOwnerPrivateRequest {
  if (closed(v, ['kind', 'datasetId']) && v.kind === 'load') return isMobileId(v.datasetId);
  if (!closed(v, ['kind', 'datasetId', 'request']) || !isMobileId(v.datasetId)) return false;
  if (v.kind === 'catalog') return isMobileOwnerCatalogRequest(v.request);
  if (v.kind === 'artwork') return closed(v.request, ['serverId', 'artworkId']) && isMobileId(v.request.serverId) && isMobileId(v.request.artworkId);
  if (v.kind === 'save') return closed(v.request, ['datasetId', 'expectedRevision', 'commitId', 'sealed'])
    && v.request.datasetId === v.datasetId && integer(v.request.expectedRevision, 0, Number.MAX_SAFE_INTEGER - 1)
    && uuid(v.request.commitId) && bytes(v.request.sealed, MOBILE_AUTH_SEALED_MAX_BYTES);
  return false;
}
export function isMobileOwnerPrivateResult(v: unknown, request: MobileOwnerPrivateRequest): v is MobileOwnerPrivateResult {
  if (closed(v, ['kind', 'status', 'code', 'retryable', 'outcome']) && v.kind === 'mobile-error') {
    return typeof v.status === 'number' && [400, 401, 404, 409, 413, 429, 503].includes(v.status) && typeof v.code === 'string' && safeCodes.includes(v.code)
      && typeof v.retryable === 'boolean' && [null, 'not-sent', 'unknown'].includes(v.outcome as null | string);
  }
  if (request.kind === 'load') return closed(v, ['kind', 'datasetId', 'revision']) && v.kind === 'missing' && v.datasetId === request.datasetId && v.revision === 0
    || closed(v, ['kind', 'datasetId', 'revision', 'commitId', 'sealed']) && v.kind === 'sealed' && v.datasetId === request.datasetId
      && integer(v.revision, 1) && uuid(v.commitId) && bytes(v.sealed, MOBILE_AUTH_SEALED_MAX_BYTES);
  if (request.kind === 'save') return closed(v, ['kind', 'datasetId', 'revision', 'commitId']) && v.kind === 'saved'
      && v.datasetId === request.datasetId && v.revision === request.request.expectedRevision + 1 && v.commitId === request.request.commitId
    || closed(v, ['kind', 'datasetId', 'currentRevision']) && v.kind === 'conflict' && v.datasetId === request.datasetId && integer(v.currentRevision, 0);
  if (request.kind === 'artwork') return closed(v, ['datasetId', 'ownerEpoch', 'libraryRevision', 'artworkId', 'selectionRevision', 'contentType', 'bytes'])
    && v.datasetId === request.datasetId && uuid(v.ownerEpoch) && isMobileId(v.libraryRevision) && v.artworkId === request.request.artworkId
    && isMobileId(v.selectionRevision) && v.contentType === 'image/jpeg' && bytes(v.bytes, 1024 * 1024);
  if (!closed(v, ['datasetId', 'ownerEpoch', 'libraryRevision', 'operation', 'offset', 'limit', 'total', 'items'])
    || v.datasetId !== request.datasetId || !uuid(v.ownerEpoch) || !isMobileId(v.libraryRevision)
    || v.operation !== request.request.operation || v.offset !== request.request.offset || v.limit !== request.request.limit
    || !integer(v.total, 0, 300000) || !dense(v.items, request.request.limit)
    || v.items.length !== Math.max(0, Math.min(request.request.limit, v.total - request.request.offset))) return false;
  const album = request.request.operation === 'getAlbum' || request.request.operation === 'listAlbums';
  if (!v.items.every(album ? isMobileAlbum : isMobileTrack)) return false;
  try { return Buffer.byteLength(JSON.stringify(v)) <= MOBILE_API_RESPONSE_MAX_BYTES; } catch { return false; }
}

export interface MobileCorePrivateCall { type: 'mobile-main-request'; id: string; request: MobileOwnerPrivateRequest }
export type MobileCorePrivateReply = { type: 'mobile-main-response'; id: string; result: MobileOwnerPrivateResult };
export function isMobileCorePrivateCall(v: unknown): v is MobileCorePrivateCall {
  return closed(v, ['type', 'id', 'request']) && v.type === 'mobile-main-request' && uuid(v.id) && isMobileOwnerPrivateRequest(v.request);
}
export function isMobileCorePrivateReply(v: unknown, call: MobileCorePrivateCall): v is MobileCorePrivateReply {
  return closed(v, ['type', 'id', 'result']) && v.type === 'mobile-main-response' && v.id === call.id && isMobileOwnerPrivateResult(v.result, call.request);
}
