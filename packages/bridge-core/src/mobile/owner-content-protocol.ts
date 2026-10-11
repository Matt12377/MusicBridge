import { createHash } from 'node:crypto';
import {
  MOBILE_CODEC_LIMITS, isMobileId, mobileCanonicalJson, mobileCatalogResponseSnapshot,
  mobileContentRequestSnapshot, mobileContentResponseSnapshot, mobileDataSnapshot, mobileRecord,
  mobileTrackSelectionEquals, mobileInteger, MOBILE_SAFE_ERROR_CODES, isLocalLibraryTrackDetail,
} from '@music-bridge/contracts';
import type {
  MobileContentReadContext, MobileJsonValue, MobileLyricsContent, MobileRequestMap,
  MobileTrack, MobileTrackSelection, MobileUIAlbumRecord, LocalLibraryTrackDetail,
} from '@music-bridge/contracts';
import { captureMobileContentRequest, captureMobileContentReply } from './content-protocol.js';
import {
  captureMobileContentScope, isMobileContentMutation, type MobileContentMutationFacts,
  type MobileContentMutationOperation, type MobileContentScope, type MobileContentSuccessReply,
} from './content-types.js';
import { MobileServiceError } from './content-errors.js';

/** 只经过原 Main→Core→唯一 Owner 私有通道；不是公开 HTTP 或 Renderer 命令。 */
export const MOBILE_CONTENT_OWNER_OPERATIONS = [
  'listRecentlyAddedAlbums', 'listFavoriteAlbums', 'getFavoriteAlbumState', 'setAlbumFavorite',
  'listFavoriteAlbumTracks', 'setTrackFavorite', 'listPersonalPlaylists', 'createPersonalPlaylist',
  'listPersonalPlaylistTracks', 'addPersonalPlaylistTrack',
] as const;
export type MobileContentOwnerOperation = typeof MOBILE_CONTENT_OWNER_OPERATIONS[number];
export interface MobileContentProviderPage {
  planId: string; scope: Readonly<MobileContentScope>; album: MobileUIAlbumRecord;
  items: MobileTrack[]; offset: number; limit: number; total: number; sourceRevision: string;
}
export interface MobileContentOwnerDispatch {
  action: 'dispatch'; operation: MobileContentOwnerOperation; scope: Readonly<MobileContentScope>;
  request: MobileRequestMap[MobileContentOwnerOperation];
  /** 仅可信 Core 原 Provider 精确 resolver 的事实；local 事实仍由 Owner 自己读取。 */
  providerFacts?: MobileContentMutationFacts;
  providerPage?: MobileContentProviderPage;
}
export type MobileContentOwnerRequest =
  | { action: 'initialize'; serverId: string; datasetId: string; key: Uint8Array }
  | { action: 'context'; serverId: string }
  | { action: 'updateScope'; scope: Readonly<MobileContentScope> }
  | { action: 'invalidateScope'; kind: 'device'; deviceId: string }
  | { action: 'invalidateScope'; kind: 'provider'; providerEpoch: string }
  | MobileContentOwnerDispatch
  | { action: 'lookup-receipt'; scope: Readonly<MobileContentScope>; operation: MobileContentMutationOperation;
      request: MobileRequestMap[MobileContentMutationOperation] }
  | { action: 'plan-read'; scope: Readonly<MobileContentScope>; operation: 'listFavoriteAlbumTracks';
      request: MobileRequestMap['listFavoriteAlbumTracks'] }
  | { action: 'revalidate'; scope: Readonly<MobileContentScope>; snapshotId: string }
  | { action: 'revalidate'; scope: Readonly<MobileContentScope>; commitId: string;
      operation: MobileContentMutationOperation; request: MobileRequestMap[MobileContentMutationOperation] }
  | { action: 'local-track'; scope: Readonly<MobileContentScope>; selection: MobileTrackSelection }
  | { action: 'local-album'; scope: Readonly<MobileContentScope>; albumId: string }
  | { action: 'local-lyrics'; scope: Readonly<MobileContentScope>; selection: MobileTrackSelection };
export interface MobileContentOwnerSnapshot {
  kind: 'content-snapshot'; datasetId: string; ownerEpoch: string; snapshotId: string;
  operation: MobileContentOwnerOperation; scope: Readonly<MobileContentScope>;
  reply: MobileContentSuccessReply<MobileContentOwnerOperation>; context: MobileContentReadContext;
}
/** 此计划只授权一次有限 Provider 读取，不签发媒体或公开客户端能力。 */
export interface MobileContentOwnerReadPlan {
  kind: 'content-read-plan'; datasetId: string; ownerEpoch: string; planId: string;
  scope: Readonly<MobileContentScope>; operation: 'listFavoriteAlbumTracks'; requestHash: string;
  albumId: string; offset: number; limit: number; revision: string; expectedRevision: string | null;
  selections: MobileTrackSelection[] | null; total: number | null;
}
export interface MobileContentOwnerFailure {
  kind: 'content-error'; status: MobileServiceError['status']; code: MobileServiceError['code'];
  retryable: false; outcome: 'not-sent' | 'unknown' | null; commitId: string | null;
}
export type MobileContentOwnerResult =
  | { kind: 'content-initialized'; serverId: string; datasetId: string; ownerEpoch: string }
  | { kind: 'content-context'; serverId: string; datasetId: string; ownerEpoch: string; libraryRevision: string }
  | { kind: 'content-scope-updated'; datasetId: string; ownerEpoch: string; scope: Readonly<MobileContentScope> }
  | { kind: 'content-scope-invalidated'; datasetId: string; ownerEpoch: string; scopeKind: 'device' | 'provider' }
  | MobileContentOwnerSnapshot
  | { kind: 'content-receipt-not-found'; datasetId: string; ownerEpoch: string }
  | MobileContentOwnerReadPlan
  | { kind: 'content-revalidated'; datasetId: string; ownerEpoch: string; snapshotId: string }
  | { kind: 'content-track'; datasetId: string; ownerEpoch: string; libraryRevision: string; track: MobileTrack; detail: LocalLibraryTrackDetail }
  | { kind: 'content-album'; datasetId: string; ownerEpoch: string; libraryRevision: string; album: MobileUIAlbumRecord }
  | { kind: 'content-lyrics'; datasetId: string; ownerEpoch: string; libraryRevision: string; lyrics: MobileLyricsContent; snapshotId: string }
  | MobileContentOwnerFailure;

const uuid = (v: unknown): v is string => typeof v === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(v);
const invalid = (): never => { throw new MobileServiceError(400, 'INVALID_REQUEST'); };
function closed(raw: unknown, keys: readonly string[]): raw is Record<string, unknown> {
  try {
    if (!raw || typeof raw !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return false;
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    return Reflect.ownKeys(descriptors).length === keys.length && keys.every(key => {
      const d = descriptors[key]; return d?.enumerable === true && Object.hasOwn(d, 'value');
    });
  } catch { return false; }
}
function immutable<T>(v: T): T {
  if (v && typeof v === 'object' && !(v instanceof Uint8Array)) {
    for (const child of Object.values(v)) immutable(child); Object.freeze(v);
  }
  return v;
}
export function isMobileContentOwnerOperation(raw: unknown): raw is MobileContentOwnerOperation {
  return typeof raw === 'string' && (MOBILE_CONTENT_OWNER_OPERATIONS as readonly string[]).includes(raw);
}
const same = (a: unknown, b: unknown): boolean =>
  mobileCanonicalJson(a as MobileJsonValue) === mobileCanonicalJson(b as MobileJsonValue);
function selection(raw: unknown, source: 'local' | 'netease' = 'local'): MobileTrackSelection {
  const result = mobileContentRequestSnapshot('favoriteTrackSelection', raw);
  if (!result.ok || result.value.source !== source) return invalid(); return result.value;
}
function providerPage(raw: unknown, scope: Readonly<MobileContentScope>, albumId: string): MobileContentProviderPage {
  if (!closed(raw, ['planId', 'scope', 'album', 'items', 'offset', 'limit', 'total', 'sourceRevision'])
    || !uuid(raw.planId) || !same(raw.scope, scope) || !mobileInteger(raw.offset, 0)
    || !mobileInteger(raw.limit, 1, 100) || !mobileInteger(raw.total, 0, 300000)
    || !isMobileId(raw.sourceRevision) || !Array.isArray(raw.items)) return invalid();
  const album = mobileContentResponseSnapshot('uiAlbum', raw.album);
  if (!album.ok || album.value.source !== 'netease' || album.value.id !== albumId
    || raw.items.length !== Math.max(0, Math.min(raw.limit, raw.total - raw.offset))) return invalid();
  const items = raw.items.map(item => {
    const track = mobileCatalogResponseSnapshot('track', item);
    if (!track.ok || track.value.source !== 'netease' || track.value.albumId !== albumId) return invalid(); return track.value;
  });
  if (new Set(items.map(t => sameTrackKey(t))).size !== items.length) return invalid();
  return { planId: raw.planId, scope, album: album.value, items, offset: raw.offset, limit: raw.limit,
    total: raw.total, sourceRevision: raw.sourceRevision };
}
const sameTrackKey = (t: MobileTrack): string => mobileCanonicalJson([t.source, t.id, t.versionId, t.contentRevision]);
function keySnapshot(value: unknown): Uint8Array {
  try {
    if (!(value instanceof Uint8Array) || ![Uint8Array.prototype, Buffer.prototype].includes(Object.getPrototypeOf(value))) return invalid();
    const base = Object.getPrototypeOf(Uint8Array.prototype) as object;
    const length = Object.getOwnPropertyDescriptor(base, 'byteLength')!.get!.call(value) as number;
    const buffer = Object.getOwnPropertyDescriptor(base, 'buffer')!.get!.call(value) as ArrayBuffer;
    if (length !== 32 || buffer instanceof SharedArrayBuffer || Reflect.ownKeys(value).length !== 32
      || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= 32)) return invalid();
    const copy = new Uint8Array(32); Uint8Array.prototype.set.call(copy, value); return copy;
  } catch { return invalid(); }
}

export function captureMobileContentOwnerRequest(raw: unknown): MobileContentOwnerRequest {
  if (closed(raw, ['action', 'serverId', 'datasetId', 'key']) && raw.action === 'initialize') {
    if (!isMobileId(raw.serverId) || !isMobileId(raw.datasetId)) return invalid();
    return Object.freeze({ action: 'initialize', serverId: raw.serverId, datasetId: raw.datasetId, key: keySnapshot(raw.key) });
  }
  const data = mobileDataSnapshot(raw, MOBILE_CODEC_LIMITS);
  if (!data.ok || !mobileRecord(data.value)) return invalid();
  const v = data.value;
  if (v.action === 'context' && closed(v, ['action', 'serverId']) && isMobileId(v.serverId)) return immutable(v as unknown as MobileContentOwnerRequest);
  if (v.action === 'updateScope' && closed(v, ['action', 'scope'])) return immutable({ action: 'updateScope', scope: captureMobileContentScope(v.scope) });
  if (v.action === 'invalidateScope' && v.kind === 'device' && closed(v, ['action', 'kind', 'deviceId']) && isMobileId(v.deviceId)) return immutable(v as unknown as MobileContentOwnerRequest);
  if (v.action === 'invalidateScope' && v.kind === 'provider' && closed(v, ['action', 'kind', 'providerEpoch']) && isMobileId(v.providerEpoch)) return immutable(v as unknown as MobileContentOwnerRequest);
  if (v.action === 'dispatch' && (closed(v, ['action', 'operation', 'scope', 'request'])
    || closed(v, ['action', 'operation', 'scope', 'request', 'providerFacts'])
    || closed(v, ['action', 'operation', 'scope', 'request', 'providerPage'])) && isMobileContentOwnerOperation(v.operation)) {
    const scope = captureMobileContentScope(v.scope), request = captureMobileContentRequest(v.operation, v.request);
    let providerFacts: MobileContentMutationFacts | undefined;
    if (Object.hasOwn(v, 'providerFacts')) {
      const f = v.providerFacts;
      if (!mobileRecord(f) || Reflect.ownKeys(f).length === 0 || Reflect.ownKeys(f).some(k => k !== 'album' && k !== 'track')) return invalid();
      providerFacts = {};
      if (Object.hasOwn(f, 'album')) { const result = mobileContentResponseSnapshot('uiAlbum', f.album); if (!result.ok || result.value.source !== 'netease') return invalid(); providerFacts.album = result.value; }
      if (Object.hasOwn(f, 'track')) { const result = mobileCatalogResponseSnapshot('track', f.track); if (!result.ok || result.value.source !== 'netease') return invalid(); providerFacts.track = result.value; }
    }
    let page: MobileContentProviderPage | undefined;
    if (Object.hasOwn(v, 'providerPage')) {
      if (v.operation !== 'listFavoriteAlbumTracks' || request.query.source !== 'netease') return invalid();
      page = providerPage(v.providerPage, scope, request.pathParameters.albumId!);
    }
    return immutable({ action: 'dispatch', operation: v.operation, scope, request,
      ...(providerFacts ? { providerFacts } : {}), ...(page ? { providerPage: page } : {}) });
  }
  if (v.action === 'plan-read' && closed(v, ['action', 'scope', 'operation', 'request']) && v.operation === 'listFavoriteAlbumTracks') {
    const scope = captureMobileContentScope(v.scope), request = captureMobileContentRequest(v.operation, v.request);
    if (request.query.source !== 'netease') return invalid();
    return immutable({ action: 'plan-read', scope, operation: v.operation, request });
  }
  if (v.action === 'lookup-receipt' && closed(v, ['action', 'scope', 'operation', 'request']) && isMobileContentMutation(v.operation)) {
    return immutable({ action: 'lookup-receipt', scope: captureMobileContentScope(v.scope), operation: v.operation,
      request: captureMobileContentRequest(v.operation, v.request) });
  }
  if (v.action === 'revalidate' && closed(v, ['action', 'scope', 'snapshotId']) && uuid(v.snapshotId)) {
    return immutable({ action: 'revalidate', scope: captureMobileContentScope(v.scope), snapshotId: v.snapshotId });
  }
  if (v.action === 'revalidate' && closed(v, ['action', 'scope', 'commitId', 'operation', 'request']) && uuid(v.commitId) && isMobileContentMutation(v.operation)) {
    return immutable({ action: 'revalidate', scope: captureMobileContentScope(v.scope), commitId: v.commitId,
      operation: v.operation, request: captureMobileContentRequest(v.operation, v.request) });
  }
  if ((v.action === 'local-track' || v.action === 'local-lyrics') && closed(v, ['action', 'scope', 'selection'])) {
    return immutable({ action: v.action, scope: captureMobileContentScope(v.scope), selection: selection(v.selection) });
  }
  if (v.action === 'local-album' && closed(v, ['action', 'scope', 'albumId']) && isMobileId(v.albumId)) {
    return immutable({ action: 'local-album', scope: captureMobileContentScope(v.scope), albumId: v.albumId });
  }
  return invalid();
}
export function isMobileContentOwnerRequest(raw: unknown): raw is MobileContentOwnerRequest {
  try { captureMobileContentOwnerRequest(raw); return true; } catch { return false; }
}

/** 接收端核原请求与整件 DTO；物理端口的父子/boot/epoch 认证仍由原 Owner transport 完成。 */
export function isMobileContentOwnerResult(raw: unknown, request: MobileContentOwnerRequest): raw is MobileContentOwnerResult {
  try {
    const req = captureMobileContentOwnerRequest(request), result = mobileDataSnapshot(raw);
    if (!result.ok || !mobileRecord(result.value)) return false;
    const v = result.value;
    if (v.kind === 'content-error') return closed(v, ['kind', 'status', 'code', 'retryable', 'outcome', 'commitId'])
      && [400, 401, 403, 404, 409, 410, 413, 429, 503].includes(v.status as number)
      && (MOBILE_SAFE_ERROR_CODES as readonly unknown[]).includes(v.code) && v.retryable === false
      && [null, 'not-sent', 'unknown'].includes(v.outcome as null | string) && (v.commitId === null || uuid(v.commitId))
      && (v.outcome !== null || v.commitId === null);
    if (!isMobileId(v.datasetId) || !isMobileId(v.ownerEpoch)) return false;
    const expectedDataset = 'scope' in req ? req.scope.datasetId : req.action === 'initialize' ? req.datasetId : undefined;
    if (expectedDataset !== undefined && v.datasetId !== expectedDataset || 'scope' in req && v.ownerEpoch !== req.scope.ownerEpoch) return false;
    if (req.action === 'initialize') return closed(v, ['kind', 'serverId', 'datasetId', 'ownerEpoch'])
      && v.kind === 'content-initialized' && v.serverId === req.serverId;
    if (req.action === 'context') return closed(v, ['kind', 'serverId', 'datasetId', 'ownerEpoch', 'libraryRevision'])
      && v.kind === 'content-context' && v.serverId === req.serverId && isMobileId(v.libraryRevision);
    if (req.action === 'updateScope') return closed(v, ['kind', 'datasetId', 'ownerEpoch', 'scope'])
      && v.kind === 'content-scope-updated' && same(v.scope, req.scope);
    if (req.action === 'invalidateScope') return closed(v, ['kind', 'datasetId', 'ownerEpoch', 'scopeKind'])
      && v.kind === 'content-scope-invalidated' && v.scopeKind === req.kind;
    if (req.action === 'plan-read') {
      if (!closed(v, ['kind', 'datasetId', 'ownerEpoch', 'planId', 'scope', 'operation', 'requestHash',
        'albumId', 'offset', 'limit', 'revision', 'expectedRevision', 'selections', 'total'])
        || v.kind !== 'content-read-plan' || !uuid(v.planId) || !same(v.scope, req.scope)
        || v.operation !== req.operation || typeof v.requestHash !== 'string' || !/^[a-f0-9]{64}$/u.test(v.requestHash)
        || v.requestHash !== createHash('sha256').update(mobileCanonicalJson([req.scope, req.operation, req.request] as unknown as MobileJsonValue)).digest('hex')
        || v.albumId !== req.request.pathParameters.albumId || !mobileInteger(v.offset, 0)
        || !mobileInteger(v.limit, 1, 100) || v.limit !== (req.request.query.limit ?? 50)
        || !isMobileId(v.revision) || v.revision !== req.request.query.favoritesRevision
        || v.expectedRevision !== null && !isMobileId(v.expectedRevision)) return false;
      if (v.selections === null) return v.total === null;
      return mobileInteger(v.total, 0, 300000) && Array.isArray(v.selections)
        && v.selections.length === Math.max(0, Math.min(v.limit, v.total - v.offset))
        && v.selections.every(item => selection(item, 'netease'))
        && new Set(v.selections.map(item => mobileCanonicalJson(item))).size === v.selections.length;
    }
    if (req.action === 'revalidate' && 'snapshotId' in req) return closed(v, ['kind', 'datasetId', 'ownerEpoch', 'snapshotId'])
      && v.kind === 'content-revalidated' && v.snapshotId === req.snapshotId;
    if (req.action === 'lookup-receipt' && v.kind === 'content-receipt-not-found') {
      return closed(v, ['kind', 'datasetId', 'ownerEpoch']);
    }
    if (req.action === 'dispatch' || req.action === 'revalidate' || req.action === 'lookup-receipt') {
      if (!closed(v, ['kind', 'datasetId', 'ownerEpoch', 'snapshotId', 'operation', 'scope', 'reply', 'context'])
        || v.kind !== 'content-snapshot' || !uuid(v.snapshotId) || v.operation !== req.operation
        || !same(v.scope, req.scope)) return false;
      captureMobileContentReply(req.operation, req.request, req.scope, v.reply, v.context as unknown as MobileContentReadContext); return true;
    }
    if (!isMobileId(v.libraryRevision)) return false;
    if (req.action === 'local-track') {
      const track = mobileCatalogResponseSnapshot('track', v.track);
      return closed(v, ['kind', 'datasetId', 'ownerEpoch', 'libraryRevision', 'track', 'detail']) && v.kind === 'content-track'
        && isLocalLibraryTrackDetail(v.detail)
        && track.ok && mobileTrackSelectionEquals(req.selection, { trackId: track.value.id, source: track.value.source, versionId: track.value.versionId, contentRevision: track.value.contentRevision });
    }
    if (req.action === 'local-album') {
      const album = mobileContentResponseSnapshot('uiAlbum', v.album);
      return closed(v, ['kind', 'datasetId', 'ownerEpoch', 'libraryRevision', 'album']) && v.kind === 'content-album'
        && album.ok && album.value.id === req.albumId && album.value.source === 'local';
    }
    const lyrics = mobileContentResponseSnapshot('lyrics', v.lyrics);
    return closed(v, ['kind', 'datasetId', 'ownerEpoch', 'libraryRevision', 'lyrics', 'snapshotId']) && v.kind === 'content-lyrics'
      && uuid(v.snapshotId) && lyrics.ok && mobileTrackSelectionEquals(req.selection, { trackId: lyrics.value.trackId,
        source: lyrics.value.source, versionId: lyrics.value.versionId, contentRevision: lyrics.value.contentRevision });
  } catch { return false; }
}
