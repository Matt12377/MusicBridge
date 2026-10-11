import {
  MOBILE_CODEC_LIMITS, MOBILE_OPERATION_TABLE, decodeMobileRequest, decodeMobileResponse,
  encodeMobileJsonReply, encodeMobileRequest, isMobileId, mobileCanonicalJson,
  mobileCatalogResponseSnapshot, mobileContentRequestSnapshot, mobileContentResponseSnapshot,
  mobileDataSnapshot, mobileInteger, mobileRecord, mobileTrackSelectionEquals, mobileUtf8Bytes,
} from '@music-bridge/contracts';
import type {
  MobileContentReadContext, MobileJsonValue, MobileReplyMap, MobileRequestMap, MobileTrackSelection,
} from '@music-bridge/contracts';
import {
  captureMobileContentScope, isMobileContentOperation,
} from './content-types.js';
import type {
  MobileContentCodecOptions, MobileContentOperation, MobileContentScope, MobileContentSuccessReply,
} from './content-types.js';
import { MobileServiceError } from './content-errors.js';

const origin = 'https://mobile-content.invalid';
const contextKeys = ['serverId', 'deviceId', 'accountDomain', 'source', 'selection', 'albumId',
  'playlistId', 'collectionId', 'kind', 'revision', 'limit', 'pageOffset', 'previousIdentities',
  'previousCursors', 'cursorFacts', 'sort', 'playlistFirstTracks', 'collection', 'trackAlbums'] as const;
const pages = new Set<MobileContentOperation>(['listRecentlyAddedAlbums', 'listNeteaseLikedPlaylistTracks',
  'listFavoriteAlbums', 'listFavoriteAlbumTracks', 'listPersonalPlaylists', 'listPersonalPlaylistTracks',
  'listNeteaseRecommendedPlaylists', 'listNeteaseNewAlbums', 'listNeteaseCharts', 'getNeteaseDiscoveryCollectionTracks']);
const closed = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const invalid = (): never => { throw new MobileServiceError(400, 'INVALID_REQUEST'); };
const unavailable = (): never => { throw new MobileServiceError(503, 'BUSY'); };
const changed = (): never => { throw new MobileServiceError(409, 'SOURCE_CHANGED'); };
const canonical = (value: unknown): string => mobileCanonicalJson(value as MobileJsonValue);
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** 请求仍使用原 HTTP codec；此捕获不签发或替代认证 principal。 */
export function captureMobileContentRequest<O extends MobileContentOperation>(
  operation: O, raw: unknown, options: MobileContentCodecOptions = {},
): MobileRequestMap[O] {
  if (!isMobileContentOperation(operation)) return invalid();
  const captured = mobileDataSnapshot(raw, options.limits ?? MOBILE_CODEC_LIMITS, 'request');
  if (!captured.ok || !mobileRecord(captured.value) || typeof captured.value.path !== 'string') return invalid();
  const context = { responseOrigin: origin, requestPath: captured.value.path, ...options };
  const encoded = encodeMobileRequest(operation, captured.value as unknown as MobileRequestMap[O], context);
  if (!encoded.ok) return invalid();
  const decoded = decodeMobileRequest(operation, encoded.value, context);
  if (!decoded.ok) return invalid();
  return freeze(decoded.value);
}

function captureContext(raw: unknown, scope: Readonly<MobileContentScope>, options: MobileContentCodecOptions): MobileContentReadContext {
  const captured = mobileDataSnapshot(raw, options.limits ?? MOBILE_CODEC_LIMITS);
  if (!captured.ok || !mobileRecord(captured.value)) return unavailable();
  const value = captured.value;
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !(contextKeys as readonly string[]).includes(key))
    || value.serverId !== scope.serverId || value.deviceId !== scope.deviceId || value.accountDomain !== scope.accountDomain
    || !['serverId', 'deviceId', 'accountDomain'].every(key => isMobileId(value[key]))
    || ['albumId', 'playlistId', 'collectionId', 'revision', 'sort'].some(key => Object.hasOwn(value, key) && !isMobileId(value[key]))
    || Object.hasOwn(value, 'source') && value.source !== 'local' && value.source !== 'netease'
    || Object.hasOwn(value, 'kind') && value.kind !== 'playlist' && value.kind !== 'chart'
    || Object.hasOwn(value, 'limit') && !mobileInteger(value.limit, 1, 100)
    || Object.hasOwn(value, 'pageOffset') && !mobileInteger(value.pageOffset)) return unavailable();
  if (Object.hasOwn(value, 'selection') && !mobileContentRequestSnapshot('favoriteTrackSelection', value.selection, options.limits).ok) return unavailable();
  for (const name of ['previousIdentities', 'previousCursors'] as const) {
    if (!Object.hasOwn(value, name)) continue;
    const entries = value[name];
    if (!Array.isArray(entries) || entries.some(entry => typeof entry !== 'string'
      || mobileUtf8Bytes(entry) > 2048 || /[\u0000-\u001f\u007f]/u.test(entry))
      || new Set(entries).size !== entries.length) return unavailable();
  }
  if (Object.hasOwn(value, 'trackAlbums') && (!mobileRecord(value.trackAlbums)
    || Object.values(value.trackAlbums).some(albumId => !isMobileId(albumId)))) return unavailable();
  if (Object.hasOwn(value, 'playlistFirstTracks')) {
    if (!mobileRecord(value.playlistFirstTracks) || Object.entries(value.playlistFirstTracks).some(([id, track]) =>
      !isMobileId(id) || track !== null && !mobileCatalogResponseSnapshot('track', track, options.limits).ok)) return unavailable();
  }
  if (Object.hasOwn(value, 'collection') && !mobileContentResponseSnapshot('discoveryCollection', value.collection, options.limits).ok) return unavailable();
  if (Object.hasOwn(value, 'cursorFacts')) {
    const facts = value.cursorFacts;
    if (!mobileRecord(facts) || !closed(facts, ['serverId', 'deviceId', 'accountDomain', 'revision', 'sort', 'parentId', 'source'])
      || !['serverId', 'deviceId', 'accountDomain', 'revision', 'sort'].every(key => isMobileId(facts[key]))
      || facts.parentId !== null && !isMobileId(facts.parentId)
      || facts.source !== 'all' && facts.source !== 'local' && facts.source !== 'netease') return unavailable();
  }
  return freeze(value as unknown as MobileContentReadContext);
}

function bindContext<O extends MobileContentOperation>(operation: O, request: MobileRequestMap[O], context: MobileContentReadContext): void {
  const query = request.query, path = request.pathParameters;
  const body = request.body as unknown as Record<string, unknown> | null;
  if (operation !== 'getExactTrackLyrics' && context.revision === undefined) return unavailable();
  if (pages.has(operation) && (context.limit === undefined || context.pageOffset === undefined
    || query.limit !== undefined && context.limit !== query.limit)) return unavailable();
  const source = operation === 'listRecentlyAddedAlbums' ? 'local' : operation.includes('Netease') ? 'netease'
    : query.source ?? body?.source;
  if (source !== undefined && context.source !== source) return changed();
  if (query.accountDomain !== undefined && context.accountDomain !== query.accountDomain
    || body?.accountDomain !== undefined && context.accountDomain !== body.accountDomain) return changed();
  const revision = query.playlistRevision ?? query.collectionRevision ?? query.favoritesRevision;
  if (revision !== undefined && context.revision !== revision) return changed();
  const albumId = path.albumId ?? body?.albumId;
  if (albumId !== undefined && context.albumId !== albumId) return changed();
  const playlistId = path.playlistId ?? query.playlistId;
  if (playlistId !== undefined && context.playlistId !== playlistId) return changed();
  if (path.collectionId !== undefined && (context.collectionId !== path.collectionId || context.kind !== query.kind)) return changed();
  if (operation === 'getNeteaseLikedPlaylist' && context.playlistId === undefined) return unavailable();
  let selection: MobileTrackSelection | undefined;
  if (operation === 'getExactTrackLyrics') selection = { trackId: path.trackId!, source: query.source as 'local' | 'netease',
    versionId: query.versionId as string, contentRevision: query.contentRevision as string };
  if (operation === 'setTrackFavorite') selection = { trackId: path.trackId!, source: body!.source as 'local' | 'netease',
    versionId: body!.versionId as string, contentRevision: body!.contentRevision as string };
  if (operation === 'addPersonalPlaylistTrack') selection = body!.selection as unknown as MobileTrackSelection;
  if (selection && (!context.selection || !mobileTrackSelectionEquals(selection, context.selection))) return changed();
}

/** context 必须由可信端口独立传入；不从返回正文复制账号、修订或选曲。 */
export function captureMobileContentReply<O extends MobileContentOperation>(
  operation: O, requestRaw: MobileRequestMap[O], scopeRaw: Readonly<MobileContentScope>, rawReply: unknown,
  trustedContext: MobileContentReadContext, options: MobileContentCodecOptions = {},
): { reply: MobileContentSuccessReply<O>; context: MobileContentReadContext } {
  const request = captureMobileContentRequest(operation, requestRaw, options), scope = captureMobileContentScope(scopeRaw);
  const context = captureContext(trustedContext, scope, options);
  bindContext(operation, request, context);
  const captured = mobileDataSnapshot(rawReply, options.limits ?? MOBILE_CODEC_LIMITS);
  if (!captured.ok || !mobileRecord(captured.value) || !closed(captured.value, ['status', 'category', 'body'])
    || captured.value.category !== 'success'
    || !(MOBILE_OPERATION_TABLE[operation].successStatuses as readonly number[]).includes(captured.value.status as number)) return unavailable();
  const raw = captured.value as unknown as MobileReplyMap[O];
  const wire = { responseOrigin: origin, requestPath: request.path, content: context, ...options };
  const encoded = encodeMobileJsonReply(operation, raw, wire);
  if (!encoded.ok) return encoded.issue.code === 'SOURCE_CHANGED' ? changed() : unavailable();
  const decoded = decodeMobileResponse(operation, { ...encoded.value, finalUrl: `${origin}${request.path}` }, wire);
  if (!decoded.ok || decoded.value.category !== 'success') return unavailable();
  // 既有公共 codec 的两路列表共用 enum；私有业务层补上 canonical 的逐操作 kind。
  if (operation === 'listNeteaseRecommendedPlaylists' || operation === 'listNeteaseCharts') {
    const items = (decoded.value.body as { items: { kind: string }[] }).items;
    if (items.some(item => item.kind !== (operation === 'listNeteaseCharts' ? 'chart' : 'playlist'))) return unavailable();
  }
  return { reply: freeze(decoded.value as unknown as MobileContentSuccessReply<O>), context };
}

export interface MobileContentPrivateRequest<O extends MobileContentOperation = MobileContentOperation> {
  type: 'mobile-content-main-request'; id: string; operation: O;
  scope: Readonly<MobileContentScope>; request: MobileRequestMap[O];
}
export interface MobileContentPrivateResponse<O extends MobileContentOperation = MobileContentOperation> {
  type: 'mobile-content-main-response'; id: string; operation: O;
  scope: Readonly<MobileContentScope>; reply: MobileContentSuccessReply<O>; context: MobileContentReadContext;
}
const uuid = (value: unknown): value is string => typeof value === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value);

/** 只定义新逻辑消息形状；此模块没有增加物理端口或装载主路由。 */
export function captureMobileContentPrivateRequest(raw: unknown, options: MobileContentCodecOptions = {}): MobileContentPrivateRequest {
  const captured = mobileDataSnapshot(raw, options.limits ?? MOBILE_CODEC_LIMITS, 'request');
  if (!captured.ok || !mobileRecord(captured.value) || !closed(captured.value, ['type', 'id', 'operation', 'scope', 'request'])
    || captured.value.type !== 'mobile-content-main-request' || !uuid(captured.value.id)
    || !isMobileContentOperation(captured.value.operation)) return invalid();
  const value = captured.value;
  return freeze({ type: 'mobile-content-main-request', id: value.id as string, operation: value.operation as MobileContentOperation,
    scope: captureMobileContentScope(value.scope), request: captureMobileContentRequest(value.operation as MobileContentOperation, value.request, options) });
}

export function captureMobileContentPrivateResponse<O extends MobileContentOperation>(raw: unknown,
  expected: MobileContentPrivateRequest<O>, trustedContext: MobileContentReadContext,
  options: MobileContentCodecOptions = {}): MobileContentPrivateResponse<O> {
  const request = captureMobileContentPrivateRequest(expected, options), captured = mobileDataSnapshot(raw, options.limits ?? MOBILE_CODEC_LIMITS);
  if (!captured.ok || !mobileRecord(captured.value) || !closed(captured.value, ['type', 'id', 'operation', 'scope', 'reply', 'context'])
    || captured.value.type !== 'mobile-content-main-response' || captured.value.id !== request.id
    || captured.value.operation !== request.operation) return unavailable();
  const scope = captureMobileContentScope(captured.value.scope), context = captureContext(trustedContext, scope, options);
  if (canonical(scope) !== canonical(request.scope) || canonical(captured.value.context) !== canonical(context)) return unavailable();
  const result = captureMobileContentReply(expected.operation, request.request as MobileRequestMap[O], scope, captured.value.reply, context, options);
  return freeze({ type: 'mobile-content-main-response', id: request.id, operation: expected.operation, scope, ...result });
}
