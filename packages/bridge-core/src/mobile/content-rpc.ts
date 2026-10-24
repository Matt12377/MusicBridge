import { captureMobileDirectoryQuery, captureMobileDirectoryPage, type MobileDirectoryQuery, type MobileDirectoryPage } from './directory-rpc.js';
import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { MOBILE_SAFE_ERROR_CODES, isMobileId, mobileInteger, mobileCatalogRequestSnapshot, mobileCatalogResponseSnapshot, mobileCanonicalJson, mobileUtf8Bytes } from '@music-bridge/contracts';
import type { MobileAlbum, MobileContentReadContext, MobileSearchQuery, MobileTrack, MobileTrackPage, MobileTrackSelection, MobileJsonValue } from '@music-bridge/contracts';
import { captureMobileNeteaseSelection } from './netease-catalog-service.js';
import {
  captureMobileContentPrivateRequest, captureMobileContentReply,
} from './content-protocol.js';
import { captureMobileContentScope, type MobileContentOperation, type MobileContentScope,
  type MobileContentSuccessReply } from './content-types.js';
import { sameMobileContentScope } from './content-service.js';
import { isMobileOwnerSourceRequest, isMobileOwnerSourceResult,
  type MobileOwnerSourceRequest, type MobileOwnerSourceResult } from './source-protocol.js';
import { MobileAuthPersistenceError, MobileServiceError, type MobilePrincipal } from './types.js';
import { MobilePlaybackError } from './playback-types.js';
import { captureMobileArtworkBytes } from './artwork-bytes.js';
import { allocateOwnedSourceBytes } from './owned-source-bytes.js';

const typedArray = Object.getPrototypeOf(Uint8Array.prototype) as object;
const sourceByteLength = Object.getOwnPropertyDescriptor(typedArray, 'byteLength')!.get!;
const setSourceBytes = Uint8Array.prototype.set;

/** 只来自 Main 已认证的原 principal；没有 token、账号显示名或 Provider 凭据。 */
export type MobileContentMainPrincipal = Pick<MobileContentScope,
  'serverId' | 'datasetId' | 'deviceId' | 'deviceEpoch' | 'accessGeneration'>;
interface RequestBase { type: 'mobile-content-core-request'; id: string }
export type MobileContentAlbumOperation = 'getAlbum' | 'listTracks';
export type MobileContentCoreRequest =
  | (RequestBase & { action: 'initialize'; serverId: string; datasetId: string; key: Uint8Array; privateProviderDiagnostics?: true })
  | (RequestBase & { action: 'invalidate-device'; serverId: string; datasetId: string; deviceId: string; deviceEpoch: number })
  | (RequestBase & { action: 'scope'; principal: Readonly<MobileContentMainPrincipal> })
  | (RequestBase & { action: 'dispatch'; operation: MobileContentOperation;
    scope: Readonly<MobileContentScope>; request: import('@music-bridge/contracts').MobileRequestMap[MobileContentOperation] })
  | (RequestBase & { action: 'revalidate'; snapshotId: string; scope: Readonly<MobileContentScope> })
  | (RequestBase & { action: 'source'; scope: Readonly<MobileContentScope>; request: MobileOwnerSourceRequest })
  | (RequestBase & { action: 'track'; operation: 'read' | 'revalidate'; scope: Readonly<MobileContentScope>; trackId: string;
    expectedSelection: Readonly<MobileTrackSelection> | null; expectedFingerprint: string | null })
  | (RequestBase & { action: 'directory'; scope: Readonly<MobileContentScope>; query: MobileDirectoryQuery })
  | (RequestBase & { action: 'album-catalog'; operation: MobileContentAlbumOperation; mode: 'read' | 'revalidate';
    scope: Readonly<MobileContentScope>; albumId: string; query: Readonly<MobileSearchQuery> | null;
    expectedFingerprint: string | null; expectedRevision: string | null })
  | (RequestBase & { action: 'artwork'; operation: 'read' | 'revalidate'; scope: Readonly<MobileContentScope>;
    artworkId: string; expectedRevision: string | null })
  | (RequestBase & { action: 'cancel'; requestId: string; snapshotId: string | null; scope: Readonly<MobileContentScope> | null });
interface ResponseBase { type: 'mobile-content-core-response'; id: string; action: MobileContentCoreRequest['action'] }
export interface MobileContentCoreFailure extends ResponseBase {
  kind: 'error'; status: MobileServiceError['status']; code: MobileServiceError['code'];
  retryable: false; outcome: 'not-sent' | 'unknown' | null;
}
export type MobileContentCoreResponse = MobileContentCoreFailure
  | (ResponseBase & { action: 'initialize'; ok: true })
  | (ResponseBase & { action: 'invalidate-device'; ok: true })
  | (ResponseBase & { action: 'scope'; kind: 'scope'; scope: Readonly<MobileContentScope>; neteasePlayback: boolean })
  | (ResponseBase & { action: 'dispatch'; kind: 'snapshot'; snapshotId: string; operation: MobileContentOperation;
    scope: Readonly<MobileContentScope>; reply: MobileContentSuccessReply<MobileContentOperation>; context: MobileContentReadContext })
  | (ResponseBase & { action: 'revalidate'; kind: 'validated'; snapshotId: string; scope: Readonly<MobileContentScope> })
  | (ResponseBase & { action: 'source'; kind: 'source'; scope: Readonly<MobileContentScope>; source: 'local' | 'netease'; result: MobileOwnerSourceResult })
  | (ResponseBase & { action: 'track'; kind: 'track'; scope: Readonly<MobileContentScope>; trackId: string; track: MobileTrack; fingerprint: string })
  | (ResponseBase & { action: 'track'; kind: 'track-validated'; scope: Readonly<MobileContentScope>; trackId: string; fingerprint: string })
  | (ResponseBase & { action: 'directory'; kind: 'directory'; scope: Readonly<MobileContentScope>; page: MobileDirectoryPage })
  | (ResponseBase & { action: 'album-catalog'; kind: 'album-catalog'; operation: 'getAlbum'; scope: Readonly<MobileContentScope>; albumId: string; body: MobileAlbum; fingerprint: string })
  | (ResponseBase & { action: 'album-catalog'; kind: 'album-catalog'; operation: 'listTracks'; scope: Readonly<MobileContentScope>; albumId: string; body: MobileTrackPage; fingerprint: string })
  | (ResponseBase & { action: 'album-catalog'; kind: 'album-catalog-validated'; operation: MobileContentAlbumOperation; scope: Readonly<MobileContentScope>; albumId: string; fingerprint: string })
  | (ResponseBase & { action: 'artwork'; kind: 'artwork'; scope: Readonly<MobileContentScope>;
    artworkId: string; revision: string; contentType: 'image/png' | 'image/jpeg'; bytes: Uint8Array })
  | (ResponseBase & { action: 'artwork'; kind: 'artwork-validated'; scope: Readonly<MobileContentScope>; artworkId: string; revision: string })
  | (ResponseBase & { action: 'cancel'; kind: 'cancelled'; requestId: string; snapshotId: string | null; quiet: true });

/** 仅同一可信私有调用链的结算旁注；不增加wire字段，也不代表FD或未知写入已quiet。 */
export type MobileContentCoreSettlementObserver = (response: MobileContentCoreResponse) => void;
export function mobileContentLateSourceRequest(request: MobileContentCoreRequest | undefined): request is Extract<MobileContentCoreRequest, { action: 'source' }> {
  return request?.action === 'source' && ['read', 'close-read', 'release'].includes(request.request.operation);
}
export function mobileContentLateResponseAllowed(request: MobileContentCoreRequest, response: MobileContentCoreResponse): boolean {
  if (request.action !== 'cancel' && !mobileContentLateSourceRequest(request)) return false;
  // 原cancel的晚失败不能抹掉关闭复核所需的关联；只认其真实quiet ACK。
  if (request.action === 'cancel') return response.action === 'cancel' && 'kind' in response && response.kind === 'cancelled' && response.quiet;
  if ('kind' in response && response.kind === 'error') return response.outcome !== 'unknown';
  // 晚音频字节绝不重新发布；清理成功必须携原close-read/release的真实quiet ACK。
  return response.action === 'source' && 'kind' in response && response.kind === 'source'
    && response.result.kind === 'mobile-source-ack' && response.result.quiet === true;
}

const principalKeys = ['serverId', 'datasetId', 'deviceId', 'deviceEpoch', 'accessGeneration'] as const;
const statusCodes: readonly number[] = [400, 401, 403, 404, 409, 410, 413, 429, 503];
const safeCodes: readonly string[] = MOBILE_SAFE_ERROR_CODES;
export const MOBILE_CONTENT_RPC_BOUNDS = Object.freeze({ inflight: 16, snapshots: 16, requestMs: 10_000, closeMs: 10_000 });
export const mobileContentRpcUuid = (value: unknown): value is string => typeof value === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value);
export function mobileContentRpcClosed(raw: unknown, keys: readonly string[]): raw is Record<string, unknown> {
  try {
    if (!raw || typeof raw !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return false;
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    return Reflect.ownKeys(descriptors).length === keys.length && keys.every(key =>
      descriptors[key]?.enumerable === true && Object.hasOwn(descriptors[key]!, 'value'));
  } catch { return false; }
}
function invalid(): never { throw new MobileServiceError(400, 'INVALID_REQUEST'); }
function unavailable(): never { throw new MobileAuthPersistenceError('unknown'); }
const trackFingerprint = /^[a-f0-9]{64}(?![\s\S])/u;
export function mobileContentTrackFingerprint(track: MobileTrack): string {
  return createHash('sha256').update(mobileCanonicalJson(track as unknown as MobileJsonValue)).digest('hex');
}
/** 专辑目录只投既有公开字段；unknown音频仍是目录事实，不能升级为已探测音频。 */
export function captureMobileContentAlbumBody(operation: MobileContentAlbumOperation, albumId: string, raw: unknown): MobileAlbum | MobileTrackPage {
  const label = (v: string, empty = false) => (empty || v.trim().length > 0) && mobileUtf8Bytes(v) <= 1024
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(v);
  const metadata = (v: MobileAlbum | MobileTrack) => label(v.title) && label(v.editionLabel, true)
    && v.artists.length > 0 && v.artists.length <= 32 && v.artists.every(name => label(name));
  const known = (v: object, names: readonly string[]) => Object.keys(v).every(key => names.includes(key));
  if (operation === 'getAlbum') {
    const captured = mobileCatalogResponseSnapshot('album', raw); if (!captured.ok) return unavailable(); const album = captured.value;
    if (!known(album, ['id','title','artists','source','editionLabel','trackCount','artworkId'])
      || album.source !== 'netease' || album.id !== albumId || !metadata(album)) return unavailable();
    return album;
  }
  const captured = mobileCatalogResponseSnapshot('trackPage', raw); if (!captured.ok) return unavailable(); const page = captured.value;
  if (!mobileContentRpcClosed(page, ['items','nextCursor','libraryRevision']) || !isMobileId(page.libraryRevision) || page.items.length > 100
    || page.nextCursor !== null && (mobileUtf8Bytes(page.nextCursor) > 2048 || !/^mc2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(page.nextCursor))) return unavailable();
  for (const track of page.items) {
    if (!known(track, ['id','title','artists','albumId','source','sourceItemId','versionId','contentRevision','editionLabel','durationMs','audio','availability','artworkId'])
      || track.source !== 'netease' || track.albumId !== albumId || !track.id.startsWith('nt:') || !metadata(track)
      || !known(track.audio, ['codec','container','sampleRateHz','bitsPerSample','channels','bitrateKbps'])
      || !['unknown','flac','mp3'].includes(track.audio.codec) || track.audio.codec !== track.audio.container) return unavailable();
  }
  if (new Set(page.items.map(track => track.id)).size !== page.items.length || page.nextCursor !== null && page.items.length === 0) return unavailable();
  return page;
}
export function mobileContentAlbumFingerprint(operation: MobileContentAlbumOperation, body: MobileAlbum | MobileTrackPage): string {
  // 新签游标的时钟不属于页内容；原查询和全部权限事实仍由签名游标与scope逐项绑定。
  const page = body as MobileTrackPage;
  return createHash('sha256').update(mobileCanonicalJson((operation === 'getAlbum' ? body
    : { items: page.items, libraryRevision: page.libraryRevision, hasNext: page.nextCursor !== null }) as unknown as MobileJsonValue)).digest('hex');
}
/** 私有详情只承认已经真实探测的既有Track；不接受目录unknown或上游扩展。 */
export function captureMobileContentObservedTrack(raw: unknown, trackId: string): MobileTrack {
  const captured = mobileCatalogResponseSnapshot('track', raw); if (!captured.ok) return unavailable(); const track = captured.value;
  const keys = ['id','title','artists','albumId','source','sourceItemId','versionId','contentRevision','editionLabel','durationMs','audio','availability','artworkId'];
  const label = (v: unknown, empty = false) => typeof v === 'string' && (empty || v.trim().length > 0)
    && mobileUtf8Bytes(v) <= 1024 && !/[\u0000-\u001f\u007f-\u009f]/u.test(v);
  if (Object.keys(track).some(key => !keys.includes(key)) || track.source !== 'netease' || track.id !== trackId || !trackId.startsWith('nt:')
    || !label(track.title) || !label(track.editionLabel,true) || track.artists.length < 1 || track.artists.length > 32 || !track.artists.every(name => label(name))
    || !mobileInteger(track.durationMs,1) || track.audio.codec === 'unknown' || track.audio.container === 'unknown'
    || Object.keys(track.audio).some(key => !['codec','container','sampleRateHz','bitsPerSample','channels','bitrateKbps'].includes(key))
    || !['flac','mp3'].includes(track.audio.codec) || track.audio.container !== track.audio.codec
    || (track.audio.codec === 'flac' ? !mobileInteger(track.audio.bitsPerSample,4,32) : track.audio.bitsPerSample !== undefined)
    || !mobileInteger(track.audio.sampleRateHz,8000,768000) || !mobileInteger(track.audio.channels,1,32)) return unavailable();
  return track;
}
export function captureMobileContentMainPrincipal(raw: unknown): Readonly<MobileContentMainPrincipal> {
  if (!mobileContentRpcClosed(raw, principalKeys)
    || !['serverId', 'datasetId', 'deviceId'].every(key => isMobileId(raw[key]))
    || !mobileInteger(raw.deviceEpoch, 1) || !mobileInteger(raw.accessGeneration, 1)) return invalid();
  return Object.freeze({ serverId: String(raw.serverId), datasetId: String(raw.datasetId), deviceId: String(raw.deviceId),
    deviceEpoch: Number(raw.deviceEpoch), accessGeneration: Number(raw.accessGeneration) });
}
/** 认证真实性由原 auth 核；此函数只剥离不能跨线程的 brand 与秘密字段。 */
export function mobileContentPrincipalFields(principal: MobilePrincipal): Readonly<MobileContentMainPrincipal> {
  return captureMobileContentMainPrincipal({ serverId: principal.serverId, datasetId: principal.datasetId,
    deviceId: principal.deviceId, deviceEpoch: principal.deviceEpoch, accessGeneration: principal.generation });
}
export function mobileContentPrincipalMatches(principal: Readonly<MobileContentMainPrincipal>, scope: Readonly<MobileContentScope>): boolean {
  return principalKeys.every(key => principal[key] === scope[key]);
}
function secretKey(raw: unknown): Uint8Array {
  try {
    if (!(raw instanceof Uint8Array) || Object.getPrototypeOf(raw) !== Uint8Array.prototype
      || !(raw.buffer instanceof ArrayBuffer) || raw.byteLength !== 32
      || Reflect.ownKeys(raw).length !== 32) return invalid();
    return new Uint8Array(raw);
  } catch { return invalid(); }
}

/** 同一个闭集信封可以 clone；原 Source guard 与块上限没有变更。 */
export function captureMobileContentCoreRequest(raw: unknown): MobileContentCoreRequest {
  if (!raw || typeof raw !== 'object') return invalid();
  let action: unknown, privateDiagnostics = false;
  try {
    action = Object.getOwnPropertyDescriptor(raw, 'action')?.value;
    privateDiagnostics = Object.getOwnPropertyDescriptor(raw, 'privateProviderDiagnostics')?.value === true;
  } catch { return invalid(); }
  const keys = action === 'initialize' ? ['type', 'id', 'action', 'serverId', 'datasetId', 'key', ...(privateDiagnostics ? ['privateProviderDiagnostics'] : [])]
    : action === 'invalidate-device' ? ['type', 'id', 'action', 'serverId', 'datasetId', 'deviceId', 'deviceEpoch']
    : action === 'scope' ? ['type', 'id', 'action', 'principal']
      : action === 'dispatch' ? ['type', 'id', 'action', 'operation', 'scope', 'request']
        : action === 'revalidate' ? ['type', 'id', 'action', 'snapshotId', 'scope']
          : action === 'source' ? ['type', 'id', 'action', 'scope', 'request']
            : action === 'directory' ? ['type','id','action','scope','query']
            : action === 'album-catalog' ? ['type','id','action','operation','mode','scope','albumId','query','expectedFingerprint','expectedRevision']
            : action === 'track' ? ['type', 'id', 'action', 'operation', 'scope', 'trackId', 'expectedSelection', 'expectedFingerprint']
            : action === 'artwork' ? ['type', 'id', 'action', 'operation', 'scope', 'artworkId', 'expectedRevision']
            : action === 'cancel' ? ['type', 'id', 'action', 'requestId', 'snapshotId', 'scope'] : null;
  if (!keys || !mobileContentRpcClosed(raw, keys) || raw.type !== 'mobile-content-core-request' || !mobileContentRpcUuid(raw.id)) return invalid();
  const base = { type: 'mobile-content-core-request' as const, id: raw.id };
  if (action === 'initialize') {
    if (!isMobileId(raw.serverId) || !isMobileId(raw.datasetId)) return invalid();
    return { ...base, action, serverId: raw.serverId, datasetId: raw.datasetId, key: secretKey(raw.key),
      ...(privateDiagnostics ? { privateProviderDiagnostics: true as const } : {}) };
  }
  if (action === 'invalidate-device') {
    if (!isMobileId(raw.serverId) || !isMobileId(raw.datasetId) || !isMobileId(raw.deviceId) || !mobileInteger(raw.deviceEpoch, 1)) return invalid();
    return { ...base, action, serverId: raw.serverId, datasetId: raw.datasetId, deviceId: raw.deviceId, deviceEpoch: raw.deviceEpoch };
  }
  if (action === 'scope') return { ...base, action, principal: captureMobileContentMainPrincipal(raw.principal) };
  if (action === 'directory') {
    const scope = captureMobileContentScope(raw.scope); if (scope.providerEpoch === null) return invalid();
    return { ...base, action, scope, query: captureMobileDirectoryQuery(raw.query) };
  }
  if (action === 'album-catalog') {
    if (raw.operation !== 'getAlbum' && raw.operation !== 'listTracks' || raw.mode !== 'read' && raw.mode !== 'revalidate'
      || !isMobileId(raw.albumId) || !raw.albumId.startsWith('na:')) return invalid();
    const scope = captureMobileContentScope(raw.scope); if (scope.providerEpoch === null) return invalid();
    let query: Readonly<MobileSearchQuery> | null = null;
    if (raw.operation === 'getAlbum') { if (raw.query !== null || raw.expectedRevision !== null) return invalid(); }
    else {
      const captured = mobileCatalogRequestSnapshot('search', raw.query);
      if (!captured.ok || captured.value.source !== 'netease' || captured.value.albumId !== raw.albumId) return invalid();
      query = captured.value;
    }
    if (raw.mode === 'read' ? raw.expectedFingerprint !== null || raw.expectedRevision !== null
      : typeof raw.expectedFingerprint !== 'string' || !trackFingerprint.test(raw.expectedFingerprint)
        || raw.operation === 'listTracks' && !isMobileId(raw.expectedRevision)) return invalid();
    return { ...base, action, operation: raw.operation, mode: raw.mode, scope, albumId: raw.albumId, query,
      expectedFingerprint: raw.expectedFingerprint as string | null, expectedRevision: raw.expectedRevision as string | null };
  }
  if (action === 'track') {
    if (!isMobileId(raw.trackId) || !raw.trackId.startsWith('nt:') || raw.operation !== 'read' && raw.operation !== 'revalidate') return invalid();
    const scope = captureMobileContentScope(raw.scope); if (scope.providerEpoch === null) return invalid();
    if (raw.operation === 'read') {
      if (raw.expectedSelection !== null || raw.expectedFingerprint !== null) return invalid();
      return { ...base, action, operation: 'read', scope, trackId: raw.trackId, expectedSelection: null, expectedFingerprint: null };
    }
    const selected = captureMobileNeteaseSelection(raw.expectedSelection);
    if (selected.trackId !== raw.trackId || typeof raw.expectedFingerprint !== 'string' || !trackFingerprint.test(raw.expectedFingerprint)) return invalid();
    return { ...base, action, operation: 'revalidate', scope, trackId: raw.trackId, expectedSelection: selected, expectedFingerprint: raw.expectedFingerprint };
  }
  if (action === 'artwork') {
    if (raw.operation !== 'read' && raw.operation !== 'revalidate' || !isMobileId(raw.artworkId)
      || !raw.artworkId.startsWith('naw:') || (raw.operation === 'read' ? raw.expectedRevision !== null : !isMobileId(raw.expectedRevision))) return invalid();
    const scope = captureMobileContentScope(raw.scope);
    if (scope.providerEpoch === null) return invalid();
    return { ...base, action, operation: raw.operation as 'read' | 'revalidate', scope,
      artworkId: raw.artworkId, expectedRevision: raw.expectedRevision as string | null };
  }
  if (action === 'dispatch') {
    const input = captureMobileContentPrivateRequest({ type: 'mobile-content-main-request', id: raw.id,
      operation: raw.operation, scope: raw.scope, request: raw.request });
    return { ...base, action, operation: input.operation, scope: input.scope, request: input.request };
  }
  if (action === 'revalidate') {
    if (!mobileContentRpcUuid(raw.snapshotId)) return invalid();
    return { ...base, action, snapshotId: raw.snapshotId, scope: captureMobileContentScope(raw.scope) };
  }
  if (action === 'source') {
    if (!isMobileOwnerSourceRequest(raw.request)) return invalid();
    const request: unknown = structuredClone(raw.request);
    if (!isMobileOwnerSourceRequest(request)) return invalid();
    return { ...base, action, scope: captureMobileContentScope(raw.scope), request };
  }
  if (action === 'cancel' && mobileContentRpcUuid(raw.requestId)
    && (raw.snapshotId === null || mobileContentRpcUuid(raw.snapshotId))) {
    return { ...base, action, requestId: raw.requestId, snapshotId: raw.snapshotId,
      scope: raw.scope === null ? null : captureMobileContentScope(raw.scope) };
  }
  return invalid();
}

/** 接收端重核原 request/id/action；不接受额外栈、路径或错误详情。 */
function captureResponse(raw: unknown, expected: MobileContentCoreRequest): MobileContentCoreResponse {
  if (!raw || typeof raw !== 'object') return unavailable();
  let kind: unknown;
  try { kind = Object.getOwnPropertyDescriptor(raw, 'kind')?.value; } catch { return unavailable(); }
  if (kind === 'error') {
    if (!mobileContentRpcClosed(raw, ['type', 'id', 'action', 'kind', 'status', 'code', 'retryable', 'outcome'])
      || typeof raw.status !== 'number' || !statusCodes.includes(raw.status)
      || typeof raw.code !== 'string' || !safeCodes.includes(raw.code) || raw.retryable !== false
      || ![null, 'not-sent', 'unknown'].includes(raw.outcome as null | string)) return unavailable();
  } else {
    const keys = expected.action === 'initialize' || expected.action === 'invalidate-device' ? ['type', 'id', 'action', 'ok']
      : expected.action === 'scope' ? ['type', 'id', 'action', 'kind', 'scope', 'neteasePlayback']
        : expected.action === 'dispatch' ? ['type', 'id', 'action', 'kind', 'snapshotId', 'operation', 'scope', 'reply', 'context']
          : expected.action === 'revalidate' ? ['type', 'id', 'action', 'kind', 'snapshotId', 'scope']
            : expected.action === 'source' ? ['type', 'id', 'action', 'kind', 'scope', 'source', 'result']
              : expected.action === 'track' ? expected.operation === 'read'
                ? ['type', 'id', 'action', 'kind', 'scope', 'trackId', 'track', 'fingerprint']
                : ['type', 'id', 'action', 'kind', 'scope', 'trackId', 'fingerprint']
              : expected.action === 'directory' ? ['type','id','action','kind','scope','page']
              : expected.action === 'album-catalog' ? ['type','id','action','kind','operation','scope','albumId','fingerprint', ...(expected.mode === 'read' ? ['body'] : [])]
              : expected.action === 'artwork' ? expected.operation === 'read'
                ? ['type', 'id', 'action', 'kind', 'scope', 'artworkId', 'revision', 'contentType', 'bytes']
                : ['type', 'id', 'action', 'kind', 'scope', 'artworkId', 'revision']
              : ['type', 'id', 'action', 'kind', 'requestId', 'snapshotId', 'quiet'];
    if (!mobileContentRpcClosed(raw, keys)) return unavailable();
  }
  if (!mobileContentRpcClosed(raw, Reflect.ownKeys(raw).filter((key): key is string => typeof key === 'string'))
    || raw.type !== 'mobile-content-core-response' || raw.id !== expected.id || raw.action !== expected.action) return unavailable();
  const base = { type: 'mobile-content-core-response' as const, id: expected.id, action: expected.action };
  if (kind === 'error') return { ...base, kind, status: raw.status as MobileServiceError['status'],
    code: raw.code as MobileServiceError['code'], retryable: false, outcome: raw.outcome as MobileContentCoreFailure['outcome'] };
  switch (expected.action) {
    case 'directory': {
      const scope = captureMobileContentScope(raw.scope);
      if (kind !== 'directory' || !sameMobileContentScope(scope, expected.scope)) return unavailable();
      return { ...base, action: 'directory', kind, scope, page: captureMobileDirectoryPage(raw.page, expected.query) };
    }
    case 'album-catalog': {
      const scope = captureMobileContentScope(raw.scope);
      if (!sameMobileContentScope(scope, expected.scope) || raw.operation !== expected.operation || raw.albumId !== expected.albumId
        || typeof raw.fingerprint !== 'string' || !trackFingerprint.test(raw.fingerprint)) return unavailable();
      if (expected.mode === 'revalidate') {
        if (kind !== 'album-catalog-validated' || raw.fingerprint !== expected.expectedFingerprint) return unavailable();
        return { ...base, action: 'album-catalog', kind, operation: expected.operation, scope, albumId: expected.albumId, fingerprint: raw.fingerprint };
      }
      const body = captureMobileContentAlbumBody(expected.operation, expected.albumId, raw.body);
      if (kind !== 'album-catalog' || mobileContentAlbumFingerprint(expected.operation, body) !== raw.fingerprint) return unavailable();
      if (expected.operation === 'getAlbum') return { ...base, action: 'album-catalog', kind, operation: 'getAlbum', scope, albumId: expected.albumId, body: body as MobileAlbum, fingerprint: raw.fingerprint };
      if ((body as MobileTrackPage).items.length > (expected.query?.limit ?? 50)) return unavailable();
      return { ...base, action: 'album-catalog', kind, operation: 'listTracks', scope, albumId: expected.albumId, body: body as MobileTrackPage, fingerprint: raw.fingerprint };
    }
    case 'track': {
      const scope = captureMobileContentScope(raw.scope);
      if (!sameMobileContentScope(scope, expected.scope) || raw.trackId !== expected.trackId || typeof raw.fingerprint !== 'string' || !trackFingerprint.test(raw.fingerprint)) return unavailable();
      if (expected.operation === 'revalidate') {
        if (kind !== 'track-validated' || raw.fingerprint !== expected.expectedFingerprint) return unavailable();
        return { ...base, action: 'track', kind, scope, trackId: expected.trackId, fingerprint: raw.fingerprint };
      }
      const track = captureMobileContentObservedTrack(raw.track, expected.trackId);
      if (kind !== 'track' || mobileContentTrackFingerprint(track) !== raw.fingerprint) return unavailable();
      return { ...base, action: 'track', kind, scope, trackId: expected.trackId, track, fingerprint: raw.fingerprint };
    }
    case 'artwork': {
      const scope = captureMobileContentScope(raw.scope);
      if (!sameMobileContentScope(scope, expected.scope) || raw.artworkId !== expected.artworkId || !isMobileId(raw.revision)) return unavailable();
      if (expected.operation === 'revalidate') {
        if (kind !== 'artwork-validated' || raw.revision !== expected.expectedRevision) return unavailable();
        return { ...base, action: 'artwork', kind, scope, artworkId: expected.artworkId, revision: raw.revision };
      }
      if (kind !== 'artwork' || raw.contentType !== 'image/png' && raw.contentType !== 'image/jpeg') return unavailable();
      return { ...base, action: 'artwork', kind, scope, artworkId: expected.artworkId, revision: raw.revision,
        contentType: raw.contentType as 'image/png' | 'image/jpeg', bytes: captureMobileArtworkBytes(raw.bytes) };
    }
    case 'initialize':
    case 'invalidate-device':
      if (raw.ok !== true) return unavailable();
      return expected.action === 'initialize'
        ? { ...base, action: 'initialize', ok: true }
        : { ...base, action: 'invalidate-device', ok: true };
    case 'scope': {
      const scope = captureMobileContentScope(raw.scope);
      if (kind !== 'scope' || typeof raw.neteasePlayback !== 'boolean' || !mobileContentPrincipalMatches(expected.principal, scope)) return unavailable();
      return { ...base, action: expected.action, kind, scope, neteasePlayback: raw.neteasePlayback };
    }
    case 'dispatch': {
      const scope = captureMobileContentScope(raw.scope);
      if (kind !== 'snapshot' || !mobileContentRpcUuid(raw.snapshotId) || raw.operation !== expected.operation
        || !sameMobileContentScope(scope, expected.scope)) return unavailable();
      const captured = captureMobileContentReply(expected.operation, expected.request, scope, raw.reply, raw.context as MobileContentReadContext);
      return { ...base, action: expected.action, kind, snapshotId: raw.snapshotId, operation: expected.operation, scope, ...captured };
    }
    case 'revalidate': {
      const scope = captureMobileContentScope(raw.scope);
      if (kind !== 'validated' || raw.snapshotId !== expected.snapshotId || !sameMobileContentScope(scope, expected.scope)) return unavailable();
      return { ...base, action: expected.action, kind, snapshotId: expected.snapshotId, scope };
    }
    case 'source': {
      const scope = captureMobileContentScope(raw.scope);
      if (kind !== 'source' || !sameMobileContentScope(scope, expected.scope) || raw.source !== 'local' && raw.source !== 'netease'
        || types.isProxy(raw.result) || !isMobileOwnerSourceResult(raw.result, expected.request)) return unavailable();
      if (raw.source === 'netease' && scope.providerEpoch === null) return unavailable();
      let result: unknown;
      if (raw.result.kind === 'mobile-source-read') {
        // 原完整guard先拒绝额外字段；同步捕获只给新存储资格，不登记外来数组。
        // 固定小信封仍在下方重核；真实IPC丢失资格后必须重新走完整原始guard。
        const bytes = allocateOwnedSourceBytes(Reflect.apply(sourceByteLength, raw.result.bytes, []) as number);
        Reflect.apply(setSourceBytes, bytes, [raw.result.bytes]);
        result = { kind: raw.result.kind, handle: raw.result.handle, readId: raw.result.readId, start: raw.result.start, bytes };
      } else result = structuredClone(raw.result);
      if (!isMobileOwnerSourceResult(result, expected.request)) return unavailable();
      return { ...base, action: expected.action, kind, scope, source: raw.source, result };
    }
    case 'cancel':
      if (kind !== 'cancelled' || raw.requestId !== expected.requestId || raw.snapshotId !== expected.snapshotId || raw.quiet !== true) return unavailable();
      return { ...base, action: expected.action, kind, requestId: expected.requestId, snapshotId: expected.snapshotId, quiet: true };
  }
}

export function captureMobileContentCoreResponse(raw: unknown, expected: MobileContentCoreRequest): MobileContentCoreResponse {
  try { return captureResponse(raw, expected); } catch { return unavailable(); }
}

export function mobileContentRpcFailure(expected: Pick<MobileContentCoreRequest, 'id' | 'action'>, error: unknown): MobileContentCoreFailure {
  const outcome = error instanceof MobileAuthPersistenceError ? error.outcome
    : error instanceof MobileServiceError && ['not-sent', 'unknown'].includes(String(Object.getOwnPropertyDescriptor(error, 'outcome')?.value))
      ? Object.getOwnPropertyDescriptor(error, 'outcome')!.value as 'not-sent' | 'unknown' : null;
  const safeError = error instanceof MobileServiceError || error instanceof MobilePlaybackError;
  const status = safeError && statusCodes.includes(error.status) ? error.status : 503;
  const code = safeError && safeCodes.includes(error.code) ? error.code : 'BUSY';
  return { type: 'mobile-content-core-response', id: expected.id, action: expected.action,
    kind: 'error', status, code, retryable: false, outcome };
}
export function throwMobileContentRpcFailure(response: MobileContentCoreFailure): never {
  const error = new MobileServiceError(response.status, response.code, false);
  if (response.outcome !== null) Object.defineProperty(error, 'outcome', { value: response.outcome, enumerable: true });
  throw error;
}
