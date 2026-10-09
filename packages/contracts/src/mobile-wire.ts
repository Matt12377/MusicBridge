import { MOBILE_API_RESPONSE_MAX_BYTES, MOBILE_CODEC_LIMITS, MOBILE_COMMON_SCHEMAS, isMobileId, mobileCanonicalJson, mobileDataSnapshot, mobileFailure, mobileInteger, mobileOk, mobileProjectSchema, mobileRecord, mobileSchemaSnapshot, mobileUtf8Bytes, parseMobileJson } from './mobile-common.js';
import type { MobileCodecLimits, MobileDecodeResult, MobileErrorEnvelope, MobileJsonValue, MobileRecord, MobileSchema, MobileSchemaRegistry, MobileSessionScope } from './mobile-common.js';
import { MOBILE_CATALOG_SCHEMAS, validateMobileCatalogPage } from './mobile-catalog.js';
import type { MobileAlbum, MobileAlbumPage, MobileArtworkQuery, MobileCatalogReadContext, MobileSearchQuery, MobileTrack, MobileTrackPage } from './mobile-catalog.js';
import { MOBILE_RESOURCE_SCHEMAS, mobileResourceRequestSnapshot, validateMobileCreateResourceReply, validateMobileGetResourceReply } from './mobile-resource.js';
import type { MobileObservation, MobileObservationReceipt, MobileResource, MobileResourceRequest, MobileResourceSemanticContext, MobileSession, MobileSessionRequest } from './mobile-resource.js';
import { MOBILE_CONTENT_SCHEMAS, MOBILE_CONTENT_RESPONSE_NAMES, mobileContentResponseSnapshot, validateMobileContentIdentity, validateMobileContentCas } from './mobile-content.js';
import type * as Content from './mobile-content.js';
import type { MobileCapabilities, MobilePairingClaim, MobileRefreshRequest, MobileResourceCodecContext, MobileServerInfo, MobileTokenPair } from './mobile-common.js';

/** 原40个 HTTP 操作，唯一方法／路径／状态，不添加 UNKNOWN 查询接口。 */
export const MOBILE_OPERATION_TABLE = {
  getServer:{"method":"GET","path":"/mobile/v1/server","successStatuses":[200],"requestSchema":null,"responseSchema":"ServerInfo","idempotency":false,"querySchema":{"type":"object","properties":{},"required":[],"additionalProperties":false}},
  claimPairing:{"method":"POST","path":"/mobile/v1/pairings/claim","successStatuses":[201],"requestSchema":"PairingClaim","responseSchema":"TokenPair","idempotency":true,"querySchema":{"type":"object","properties":{},"required":[],"additionalProperties":false}},
  refreshToken:{"method":"POST","path":"/mobile/v1/auth/refresh","successStatuses":[200],"requestSchema":"RefreshRequest","responseSchema":"TokenPair","idempotency":true,"querySchema":{"type":"object","properties":{},"required":[],"additionalProperties":false}},
  logout:{"method":"POST","path":"/mobile/v1/auth/logout","successStatuses":[204],"requestSchema":"EmptyRequest","responseSchema":null,"idempotency":false,"querySchema":{"type":"object","properties":{},"required":[],"additionalProperties":false}},
  getCapabilities:{"method":"GET","path":"/mobile/v1/capabilities","successStatuses":[200],"requestSchema":null,"responseSchema":"Capabilities","idempotency":false,"querySchema":{"type":"object","properties":{},"required":[],"additionalProperties":false}},
  listAlbums:{"method":"GET","path":"/mobile/v1/albums","successStatuses":[200],"requestSchema":null,"responseSchema":"AlbumPage","idempotency":false,"querySchema":{"type":"object","properties":{"limit":{"type":"integer","minimum":1,"maximum":100},"cursor":{"type":"string"},"q":{"type":"string","maxLength":200},"source":{"type":"string","enum":["all","local","netease"]}},"required":[],"additionalProperties":false}},
  getAlbum:{"method":"GET","path":"/mobile/v1/albums/{albumId}","successStatuses":[200],"requestSchema":null,"responseSchema":"Album","idempotency":false,"querySchema":{"type":"object","properties":{},"required":[],"additionalProperties":false}},
  listTracks:{"method":"GET","path":"/mobile/v1/tracks","successStatuses":[200],"requestSchema":null,"responseSchema":"TrackPage","idempotency":false,"querySchema":{"type":"object","properties":{"limit":{"type":"integer","minimum":1,"maximum":100},"cursor":{"type":"string"},"q":{"type":"string","maxLength":200},"source":{"type":"string","enum":["all","local","netease"]},"albumId":{"type":"string","minLength":1,"maxLength":160,"pattern":"^[A-Za-z0-9_.:-]+(?![\\s\\S])"}},"required":[],"additionalProperties":false}},
  getTrack:{"method":"GET","path":"/mobile/v1/tracks/{trackId}","successStatuses":[200],"requestSchema":null,"responseSchema":"Track","idempotency":false,"querySchema":{"type":"object","properties":{},"required":[],"additionalProperties":false}},
  getArtwork:{"method":"GET","path":"/mobile/v1/artwork/{artworkId}","successStatuses":[200],"requestSchema":null,"responseSchema":null,"idempotency":false,"querySchema":{"type":"object","properties":{"size":{"type":"string","enum":["96","256","512"]}},"required":[],"additionalProperties":false}},
  createSession:{"method":"POST","path":"/mobile/v1/sessions","successStatuses":[201],"requestSchema":"SessionRequest","responseSchema":"Session","idempotency":true,"querySchema":{"type":"object","properties":{},"required":[],"additionalProperties":false}},
  getSession:{"method":"GET","path":"/mobile/v1/sessions/{sessionId}","successStatuses":[200],"requestSchema":null,"responseSchema":"Session","idempotency":false,"querySchema":{"type":"object","properties":{},"required":[],"additionalProperties":false}},
  closeSession:{"method":"DELETE","path":"/mobile/v1/sessions/{sessionId}","successStatuses":[204],"requestSchema":null,"responseSchema":null,"idempotency":false,"querySchema":{"type":"object","properties":{},"required":[],"additionalProperties":false}},
  reportObservation:{"method":"PUT","path":"/mobile/v1/sessions/{sessionId}/observation","successStatuses":[200],"requestSchema":"Observation","responseSchema":"ObservationReceipt","idempotency":false,"querySchema":{"type":"object","properties":{},"required":[],"additionalProperties":false}},
  createResource:{"method":"POST","path":"/mobile/v1/sessions/{sessionId}/resources","successStatuses":[201,202],"requestSchema":"NegotiatedResourceRequest","responseSchema":"Resource","idempotency":true,"querySchema":{"type":"object","properties":{},"required":[],"additionalProperties":false}},
  getResource:{"method":"GET","path":"/mobile/v1/sessions/{sessionId}/resources/{resourceId}","successStatuses":[200],"requestSchema":null,"responseSchema":"Resource","idempotency":false,"querySchema":{"type":"object","properties":{},"required":[],"additionalProperties":false}},
  releaseResource:{"method":"DELETE","path":"/mobile/v1/sessions/{sessionId}/resources/{resourceId}","successStatuses":[204],"requestSchema":null,"responseSchema":null,"idempotency":false,"querySchema":{"type":"object","properties":{},"required":[],"additionalProperties":false}},
  renewResource:{"method":"POST","path":"/mobile/v1/sessions/{sessionId}/resources/{resourceId}/renew","successStatuses":[200],"requestSchema":"EmptyRequest","responseSchema":"Resource","idempotency":true,"querySchema":{"type":"object","properties":{},"required":[],"additionalProperties":false}},
  getMediaAsset:{"method":"GET","path":"/mobile/v1/media/{resourceId}/{asset}","successStatuses":[200,206],"requestSchema":null,"responseSchema":null,"idempotency":false,"querySchema":{"type":"object","properties":{"ticket":{"type":"string","minLength":16}},"required":["ticket"],"additionalProperties":false}},
  headMediaAsset:{"method":"HEAD","path":"/mobile/v1/media/{resourceId}/{asset}","successStatuses":[200],"requestSchema":null,"responseSchema":null,"idempotency":false,"querySchema":{"type":"object","properties":{"ticket":{"type":"string","minLength":16}},"required":["ticket"],"additionalProperties":false}},
  getUIContentCapabilities:{"method":"GET","path":"/mobile/v1/ui/capabilities","successStatuses":[200],"requestSchema":null,"responseSchema":"UIContentCapabilities","idempotency":false,"querySchema":{"type":"object","properties":{},"required":[],"additionalProperties":false}},
  listRecentlyAddedAlbums:{"method":"GET","path":"/mobile/v1/ui/home/added-albums","successStatuses":[200],"requestSchema":null,"responseSchema":"AddedAlbumPage","idempotency":false,"querySchema":{"type":"object","properties":{"limit":{"type":"integer","minimum":1,"maximum":100},"cursor":{"type":"string","minLength":1,"maxLength":2048}},"required":[],"additionalProperties":false}},
  getNeteaseDailyRecommendations:{"method":"GET","path":"/mobile/v1/ui/netease/daily-recommendations","successStatuses":[200],"requestSchema":null,"responseSchema":"DailyRecommendationFeed","idempotency":false,"querySchema":{"type":"object","properties":{},"required":[],"additionalProperties":false}},
  getExactTrackLyrics:{"method":"GET","path":"/mobile/v1/ui/tracks/{trackId}/lyrics","successStatuses":[200],"requestSchema":null,"responseSchema":"LyricsContent","idempotency":false,"querySchema":{"type":"object","properties":{"source":{"type":"string","enum":["local","netease"]},"versionId":{"type":"string","minLength":1,"maxLength":160,"pattern":"^[A-Za-z0-9_.:-]+(?![\\s\\S])"},"contentRevision":{"type":"string","minLength":1,"maxLength":160,"pattern":"^[A-Za-z0-9_.:-]+(?![\\s\\S])"}},"required":["source","versionId","contentRevision"],"additionalProperties":false}},
  getNeteaseLikedPlaylist:{"method":"GET","path":"/mobile/v1/ui/netease/liked-playlist","successStatuses":[200],"requestSchema":null,"responseSchema":"NeteaseLikedPlaylist","idempotency":false,"querySchema":{"type":"object","properties":{},"required":[],"additionalProperties":false}},
  listNeteaseLikedPlaylistTracks:{"method":"GET","path":"/mobile/v1/ui/netease/liked-playlist/tracks","successStatuses":[200],"requestSchema":null,"responseSchema":"NeteaseLikedPlaylistTrackPage","idempotency":false,"querySchema":{"type":"object","properties":{"playlistId":{"type":"string","minLength":1,"maxLength":160,"pattern":"^[A-Za-z0-9_.:-]+(?![\\s\\S])"},"accountDomain":{"type":"string","minLength":1,"maxLength":160,"pattern":"^[A-Za-z0-9_.:-]+(?![\\s\\S])"},"playlistRevision":{"type":"string","minLength":1,"maxLength":160,"pattern":"^[A-Za-z0-9_.:-]+(?![\\s\\S])"},"limit":{"type":"integer","minimum":1,"maximum":100},"cursor":{"type":"string","minLength":1,"maxLength":2048}},"required":["playlistId","accountDomain","playlistRevision"],"additionalProperties":false}},
  listFavoriteAlbums:{"method":"GET","path":"/mobile/v1/ui/favorites/albums","successStatuses":[200],"requestSchema":null,"responseSchema":"FavoriteAlbumPage","idempotency":false,"querySchema":{"type":"object","properties":{"limit":{"type":"integer","minimum":1,"maximum":100},"cursor":{"type":"string","minLength":1,"maxLength":2048}},"required":[],"additionalProperties":false}},
  getFavoriteAlbumState:{"method":"GET","path":"/mobile/v1/ui/favorites/albums/{albumId}","successStatuses":[200],"requestSchema":null,"responseSchema":"FavoriteAlbumState","idempotency":false,"querySchema":{"type":"object","properties":{"source":{"type":"string","enum":["local","netease"]}},"required":["source"],"additionalProperties":false}},
  setAlbumFavorite:{"method":"PUT","path":"/mobile/v1/ui/favorites/albums/{albumId}","successStatuses":[200],"requestSchema":"SetAlbumFavoriteRequest","responseSchema":"FavoriteAlbumState","idempotency":true,"querySchema":{"type":"object","properties":{},"required":[],"additionalProperties":false}},
  listFavoriteAlbumTracks:{"method":"GET","path":"/mobile/v1/ui/favorites/albums/{albumId}/tracks","successStatuses":[200],"requestSchema":null,"responseSchema":"FavoriteAlbumTrackPage","idempotency":false,"querySchema":{"type":"object","properties":{"source":{"type":"string","enum":["local","netease"]},"accountDomain":{"type":"string","minLength":1,"maxLength":160,"pattern":"^[A-Za-z0-9_.:-]+(?![\\s\\S])"},"favoritesRevision":{"type":"string","minLength":1,"maxLength":160,"pattern":"^[A-Za-z0-9_.:-]+(?![\\s\\S])"},"limit":{"type":"integer","minimum":1,"maximum":100},"cursor":{"type":"string","minLength":1,"maxLength":2048}},"required":["source","accountDomain","favoritesRevision"],"additionalProperties":false}},
  setTrackFavorite:{"method":"PUT","path":"/mobile/v1/ui/favorites/tracks/{trackId}","successStatuses":[200],"requestSchema":"SetTrackFavoriteRequest","responseSchema":"FavoriteAlbumState","idempotency":true,"querySchema":{"type":"object","properties":{},"required":[],"additionalProperties":false}},
  listPersonalPlaylists:{"method":"GET","path":"/mobile/v1/ui/playlists","successStatuses":[200],"requestSchema":null,"responseSchema":"PersonalPlaylistPage","idempotency":false,"querySchema":{"type":"object","properties":{"limit":{"type":"integer","minimum":1,"maximum":100},"cursor":{"type":"string","minLength":1,"maxLength":2048}},"required":[],"additionalProperties":false}},
  createPersonalPlaylist:{"method":"POST","path":"/mobile/v1/ui/playlists","successStatuses":[201],"requestSchema":"CreatePersonalPlaylistRequest","responseSchema":"PersonalPlaylistReceipt","idempotency":true,"querySchema":{"type":"object","properties":{},"required":[],"additionalProperties":false}},
  listPersonalPlaylistTracks:{"method":"GET","path":"/mobile/v1/ui/playlists/{playlistId}/tracks","successStatuses":[200],"requestSchema":null,"responseSchema":"PersonalPlaylistTrackPage","idempotency":false,"querySchema":{"type":"object","properties":{"accountDomain":{"type":"string","minLength":1,"maxLength":160,"pattern":"^[A-Za-z0-9_.:-]+(?![\\s\\S])"},"playlistRevision":{"type":"string","minLength":1,"maxLength":160,"pattern":"^[A-Za-z0-9_.:-]+(?![\\s\\S])"},"limit":{"type":"integer","minimum":1,"maximum":100},"cursor":{"type":"string","minLength":1,"maxLength":2048}},"required":["accountDomain","playlistRevision"],"additionalProperties":false}},
  addPersonalPlaylistTrack:{"method":"PUT","path":"/mobile/v1/ui/playlists/{playlistId}/tracks","successStatuses":[200],"requestSchema":"AddPersonalPlaylistTrackRequest","responseSchema":"PersonalPlaylistReceipt","idempotency":true,"querySchema":{"type":"object","properties":{},"required":[],"additionalProperties":false}},
  listNeteaseRecommendedPlaylists:{"method":"GET","path":"/mobile/v1/ui/netease/recommended-playlists","successStatuses":[200],"requestSchema":null,"responseSchema":"DiscoveryCollectionPage","idempotency":false,"querySchema":{"type":"object","properties":{"limit":{"type":"integer","minimum":1,"maximum":100},"cursor":{"type":"string","minLength":1,"maxLength":2048}},"required":[],"additionalProperties":false}},
  listNeteaseNewAlbums:{"method":"GET","path":"/mobile/v1/ui/netease/new-albums","successStatuses":[200],"requestSchema":null,"responseSchema":"DiscoveryAlbumPage","idempotency":false,"querySchema":{"type":"object","properties":{"limit":{"type":"integer","minimum":1,"maximum":100},"cursor":{"type":"string","minLength":1,"maxLength":2048}},"required":[],"additionalProperties":false}},
  listNeteaseCharts:{"method":"GET","path":"/mobile/v1/ui/netease/charts","successStatuses":[200],"requestSchema":null,"responseSchema":"DiscoveryCollectionPage","idempotency":false,"querySchema":{"type":"object","properties":{"limit":{"type":"integer","minimum":1,"maximum":100},"cursor":{"type":"string","minLength":1,"maxLength":2048}},"required":[],"additionalProperties":false}},
  getNeteaseDiscoveryCollectionTracks:{"method":"GET","path":"/mobile/v1/ui/netease/discovery-collections/{collectionId}/tracks","successStatuses":[200],"requestSchema":null,"responseSchema":"DiscoveryCollectionTrackPage","idempotency":false,"querySchema":{"type":"object","properties":{"kind":{"type":"string","enum":["playlist","chart"]},"accountDomain":{"type":"string","minLength":1,"maxLength":160,"pattern":"^[A-Za-z0-9_.:-]+(?![\\s\\S])"},"collectionRevision":{"type":"string","minLength":1,"maxLength":160,"pattern":"^[A-Za-z0-9_.:-]+(?![\\s\\S])"},"limit":{"type":"integer","minimum":1,"maximum":100},"cursor":{"type":"string","minLength":1,"maxLength":2048}},"required":["kind","accountDomain","collectionRevision"],"additionalProperties":false}},
  getNeteasePersonalFM:{"method":"GET","path":"/mobile/v1/ui/netease/personal-fm","successStatuses":[200],"requestSchema":null,"responseSchema":"DiscoveryFMFeed","idempotency":false,"querySchema":{"type":"object","properties":{},"required":[],"additionalProperties":false}}
} as const;

export type MobileOperationId = keyof typeof MOBILE_OPERATION_TABLE;
export type MobileHeaderPairs = readonly (readonly [string,string])[];
export interface MobileHttpRequestInput { method:string; path:string; headers:MobileHeaderPairs; query:MobileHeaderPairs; body:Uint8Array }
export interface MobileHttpResponseInput { status:number; headers:MobileHeaderPairs; body:Uint8Array; finalUrl:string }
export interface MobileMediaHeadContext { totalBytes:number; resourceId:string; asset:string }
export interface MobileWireCodecContext {
  responseOrigin:string; requestPath:string; limits?:MobileCodecLimits;
  resourceCapabilities?:MobileResourceCodecContext; resource?:MobileResourceSemanticContext; session?:MobileSessionScope;
  catalog?:MobileCatalogReadContext; content?:Content.MobileContentReadContext; contentMutation?:Content.MobileContentMutationContext; media?:MobileMediaHeadContext;
}
export type MobileRequestBody<O extends MobileOperationId> = O extends 'claimPairing' ? MobilePairingClaim : O extends 'refreshToken' ? MobileRefreshRequest : O extends 'createSession' ? MobileSessionRequest : O extends 'reportObservation' ? MobileObservation : O extends 'createResource' ? MobileResourceRequest : O extends 'setAlbumFavorite' ? Content.MobileSetAlbumFavoriteRequest : O extends 'setTrackFavorite' ? Content.MobileSetTrackFavoriteRequest : O extends 'createPersonalPlaylist' ? Content.MobileCreatePersonalPlaylistRequest : O extends 'addPersonalPlaylistTrack' ? Content.MobileAddPersonalPlaylistTrackRequest : O extends 'logout' | 'renewResource' ? Record<string,never> : null;
export interface MobileDecodedRequest<B> { path:string; pathParameters:Record<string,string>; query:MobileRecord; body:B; idempotencyKey?:string }
export type MobileRequestMap = { [O in MobileOperationId]:MobileDecodedRequest<MobileRequestBody<O>> };
export interface MobileBinaryMetadata { contentLength:number; contentType:string | null; contentRange:string | null }
export type MobileResponseBody<O extends MobileOperationId> =
  O extends 'getServer' ? MobileServerInfo : O extends 'claimPairing' | 'refreshToken' ? MobileTokenPair : O extends 'getCapabilities' ? MobileCapabilities
  : O extends 'listAlbums' ? MobileAlbumPage : O extends 'getAlbum' ? MobileAlbum : O extends 'listTracks' ? MobileTrackPage : O extends 'getTrack' ? MobileTrack
  : O extends 'createSession' | 'getSession' ? MobileSession : O extends 'reportObservation' ? MobileObservationReceipt : O extends 'createResource' | 'getResource' | 'renewResource' ? MobileResource
  : O extends 'getUIContentCapabilities' ? Content.MobileUIContentCapabilities : O extends 'listRecentlyAddedAlbums' ? Content.MobileAddedAlbumPage : O extends 'getNeteaseDailyRecommendations' ? Content.MobileDailyRecommendationFeed
  : O extends 'getExactTrackLyrics' ? Content.MobileLyricsContent : O extends 'getNeteaseLikedPlaylist' ? Content.MobileNeteaseLikedPlaylist : O extends 'listNeteaseLikedPlaylistTracks' ? Content.MobileNeteaseLikedPlaylistTrackPage
  : O extends 'listFavoriteAlbums' ? Content.MobileFavoriteAlbumPage : O extends 'getFavoriteAlbumState' | 'setAlbumFavorite' | 'setTrackFavorite' ? Content.MobileFavoriteAlbumState : O extends 'listFavoriteAlbumTracks' ? Content.MobileFavoriteAlbumTrackPage
  : O extends 'listPersonalPlaylists' ? Content.MobilePersonalPlaylistPage : O extends 'createPersonalPlaylist' | 'addPersonalPlaylistTrack' ? Content.MobilePersonalPlaylistReceipt : O extends 'listPersonalPlaylistTracks' ? Content.MobilePersonalPlaylistTrackPage
  : O extends 'listNeteaseRecommendedPlaylists' | 'listNeteaseCharts' ? Content.MobileDiscoveryCollectionPage : O extends 'listNeteaseNewAlbums' ? Content.MobileDiscoveryAlbumPage : O extends 'getNeteaseDiscoveryCollectionTracks' ? Content.MobileDiscoveryCollectionTrackPage : O extends 'getNeteasePersonalFM' ? Content.MobileDiscoveryFMFeed
  : O extends 'getArtwork' | 'getMediaAsset' | 'headMediaAsset' ? MobileBinaryMetadata : null;
export type MobileReplyMap = { [O in MobileOperationId]:{ status:number; category:'success' | 'error' | 'binary' | 'empty'; body:MobileResponseBody<O> | MobileErrorEnvelope } };
export interface MobileEncodedJsonRequest { method:string; path:string; query:MobileHeaderPairs; headers:MobileHeaderPairs; body:Uint8Array }
export interface MobileEncodedJsonReply { status:number; headers:MobileHeaderPairs; body:Uint8Array }
const schemas:MobileSchemaRegistry = {...MOBILE_COMMON_SCHEMAS,...MOBILE_CATALOG_SCHEMAS,...MOBILE_RESOURCE_SCHEMAS,...MOBILE_CONTENT_SCHEMAS};
function envelope(raw:unknown,names:readonly string[]):boolean {
  try { if (!mobileRecord(raw) || ![Object.prototype,null].includes(Object.getPrototypeOf(raw))) return false; const keys = Reflect.ownKeys(raw); return keys.length === names.length && names.every(name => { const d = Object.getOwnPropertyDescriptor(raw,name); return d?.enumerable === true && Object.hasOwn(d,'value'); }); } catch { return false; }
}
function pairs(raw:unknown):MobileDecodeResult<[string,string][]> {
  const result = mobileDataSnapshot(raw, MOBILE_CODEC_LIMITS,'request'); if (!result.ok) return result;
  if (!Array.isArray(result.value) || result.value.some(row => !Array.isArray(row) || row.length !== 2 || row.some(value => typeof value !== 'string' || /[\u0000-\u001f\u007f]/u.test(value)))) return mobileFailure('INVALID_REQUEST','headers');
  return mobileOk(result.value as [string,string][]);
}
function headers(raw:unknown):MobileDecodeResult<Map<string,string>> {
  const result = pairs(raw); if (!result.ok) return result;
  const out = new Map<string,string>();
  for (const [name,value] of result.value) { if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) || out.has(name.toLowerCase())) return mobileFailure('INVALID_REQUEST','headers'); out.set(name.toLowerCase(),value); }
  return mobileOk(out);
}
function bodyBytes(raw:unknown):Uint8Array | null {
  try {
    if (!(raw instanceof Uint8Array) || Object.getPrototypeOf(raw) !== Uint8Array.prototype || Reflect.ownKeys(raw).some(key => typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(key)) || raw.buffer instanceof SharedArrayBuffer) return null;
    return new Uint8Array(raw);
  } catch { return null; }
}
function jsonContentType(value:string | undefined):boolean { return value !== undefined && /^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(value); }
function pathParts(path:string):string[] | null {
  if (!path.startsWith('/') || path.includes('?') || path.includes('#') || /[\u0000-\u0020\u007f\\]/u.test(path)) return null;
  try { const parts = path.slice(1).split('/').map(p => decodeURIComponent(p)); return parts.some(p => !p || p === '.' || p === '..' || p.includes('/')) ? null : parts; } catch { return null; }
}
function matchPath(operation:MobileOperationId,path:string):Record<string,string> | null {
  const actual = pathParts(path), expected = MOBILE_OPERATION_TABLE[operation].path.slice(1).split('/'); if (!actual || actual.length !== expected.length) return null;
  const values:Record<string,string> = Object.create(null) as Record<string,string>;
  for (let i = 0; i < expected.length; i++) { const part = expected[i]!; if (part.startsWith('{')) { if (!isMobileId(actual[i])) return null; values[part.slice(1,-1)] = actual[i]!; } else if (actual[i] !== part) return null; }
  return values;
}
export function resolveMobileOperation(method:string,components:readonly string[]):MobileDecodeResult<MobileOperationId> {
  const captured = mobileDataSnapshot(components, MOBILE_CODEC_LIMITS,'request'); if (!captured.ok || !Array.isArray(captured.value) || captured.value.some(p => typeof p !== 'string' || p.includes('/'))) return mobileFailure('INVALID_REQUEST','path');
  for (const operation of Object.keys(MOBILE_OPERATION_TABLE) as MobileOperationId[]) if (MOBILE_OPERATION_TABLE[operation].method === method && matchPath(operation,`/${(captured.value as string[]).join('/')}`)) return mobileOk(operation);
  return mobileFailure('INVALID_REQUEST','operation');
}
export function mobileExpectedResponseStatuses(operation:MobileOperationId):readonly number[] { return MOBILE_OPERATION_TABLE[operation].successStatuses; }
export function decodeMobileRequest<O extends MobileOperationId>(operation:O,input:MobileHttpRequestInput,context:MobileWireCodecContext):MobileDecodeResult<MobileRequestMap[O]> {
  if (!Object.hasOwn(MOBILE_OPERATION_TABLE,operation) || !envelope(input,['method','path','headers','query','body'])) return mobileFailure('INVALID_REQUEST','request');
  const entry = MOBILE_OPERATION_TABLE[operation], pathParameters = typeof input.path === 'string' ? matchPath(operation,input.path) : null, bytes = bodyBytes(input.body), h = headers(input.headers), q = pairs(input.query);
  if (input.method !== entry.method || !pathParameters || bytes === null || !h.ok || !q.ok || input.path !== context.requestPath) return mobileFailure('INVALID_REQUEST','request');
  const limits = context.limits ?? MOBILE_CODEC_LIMITS; if (bytes.byteLength > limits.requestBytes) return mobileFailure('LIMIT_EXCEEDED','body');
  const query:MobileRecord = Object.create(null) as MobileRecord;
  const querySchema = entry.querySchema as MobileSchema;
  for (const [name,raw] of q.value) { if (Object.hasOwn(query,name) || !Object.hasOwn(querySchema.properties!,name)) return mobileFailure('INVALID_REQUEST','query'); const schema = querySchema.properties![name]!; if (schema.type === 'integer') { if (!/^(0|[1-9]\d*)$/u.test(raw)) return mobileFailure('INVALID_REQUEST','query'); query[name] = Number(raw); } else query[name] = raw; }
  const queryResult = mobileSchemaSnapshot<MobileRecord>(querySchema,query,schemas,limits,'request'); if (!queryResult.ok) return queryResult;
  if (operation === 'headMediaAsset' || operation === 'getMediaAsset') {
    if (typeof query.ticket !== 'string' || !/^[\x21-\x7e]{16,512}$/u.test(query.ticket)) return mobileFailure('INVALID_REQUEST','ticket');
    if (context.media && (pathParameters.resourceId !== context.media.resourceId || pathParameters.asset !== context.media.asset || !mobileInteger(context.media.totalBytes))) return mobileFailure('CONTEXT_MISMATCH','media');
    const range = h.value.get('range');
    if (operation === 'getMediaAsset' && range !== undefined && !h.value.has('if-range')) {
      const match = /^bytes=(\d*)-(\d*)$/u.exec(range);
      if (range.length > 128 || !match || !match[1] && !match[2] || match[1] && !mobileInteger(Number(match[1])) || match[2] && !mobileInteger(Number(match[2])) || match[1] && match[2] && Number(match[2]) < Number(match[1])) return mobileFailure('INVALID_REQUEST','range');
    }
  }
  let body:unknown = null;
  if (entry.requestSchema !== null) {
    if (!jsonContentType(h.value.get('content-type'))) return mobileFailure('INVALID_REQUEST','content-type');
    const parsed = parseMobileJson(bytes,limits,'request'); if (!parsed.ok) return parsed;
    const request = operation === 'createResource' ? context.resourceCapabilities ?? context.resource ? mobileResourceRequestSnapshot(parsed.value,(context.resourceCapabilities ?? context.resource)!,limits) : mobileFailure('CONTEXT_MISMATCH','capabilities') : schemas[entry.requestSchema] ? mobileSchemaSnapshot(schemas[entry.requestSchema]!,parsed.value,schemas,limits,'request') : mobileFailure('INVALID_REQUEST','schema');
    if (!request.ok) return request; body = request.value;
    if (operation === 'createResource' && context.resource?.sourceAudio.codec === 'flac') { const value = body as MobileResourceRequest; if (value.quality.profile !== 'lossless' || value.quality.allowLossyFallback) return mobileFailure('INVALID_REQUEST','quality'); }
    if (context.contentMutation && ['setAlbumFavorite','setTrackFavorite','createPersonalPlaylist','addPersonalPlaylistTrack'].includes(operation)) {
      if (operation === 'setAlbumFavorite' && context.contentMutation.albumId !== undefined && pathParameters.albumId !== context.contentMutation.albumId || operation === 'setTrackFavorite' && context.contentMutation.selection !== undefined && pathParameters.trackId !== context.contentMutation.selection.trackId) return mobileFailure('SOURCE_CHANGED','path');
      const cas = validateMobileContentCas(body as Content.MobileContentMutation,context.contentMutation); if (!cas.ok) return cas; body = cas.value;
    }
  } else if (bytes.byteLength !== 0) return mobileFailure('INVALID_REQUEST','body');
  const key = h.value.get('idempotency-key'); if (entry.idempotency && (key === undefined || [...key].length < 1 || [...key].length > 128)) return mobileFailure('INVALID_REQUEST','idempotency-key');
  return mobileOk({path:input.path,pathParameters,query:queryResult.value,body,...(key === undefined ? {} : {idempotencyKey:key})} as MobileRequestMap[O]);
}
function mediaMetadata(operation:'getMediaAsset' | 'headMediaAsset',status:number,body:Uint8Array,h:Map<string,string>,context:MobileWireCodecContext):MobileDecodeResult<MobileBinaryMetadata> {
  const rawLength = h.get('content-length'); if (rawLength === undefined || !/^(0|[1-9]\d*)$/u.test(rawLength) || !mobileInteger(Number(rawLength))) return mobileFailure('INVALID_RESPONSE','content-length');
  const length = Number(rawLength), range = h.get('content-range') ?? null, type = h.get('content-type') ?? null;
  if (operation === 'headMediaAsset') {
    if (body.byteLength !== 0 || status === 206 || status === 416 || status === 200 && (range !== null || context.media !== undefined && length !== context.media.totalBytes)) return mobileFailure('INVALID_RESPONSE','head');
    return mobileOk({contentLength:length,contentType:type,contentRange:range});
  }
  if (status === 400) return body.byteLength === 0 && length === 0 && range === null ? mobileOk({contentLength:length,contentType:type,contentRange:range}) : mobileFailure('INVALID_RESPONSE','range');
  if (status === 416) { const match = /^bytes \*\/(0|[1-9]\d*)$/u.exec(range ?? ''); if (!match || !mobileInteger(Number(match[1])) || length !== 0 || body.byteLength !== 0 || context.media && Number(match[1]) !== context.media.totalBytes) return mobileFailure('INVALID_RESPONSE','range'); }
  else if (status === 206) { const match = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(range ?? ''); if (!match) return mobileFailure('INVALID_RESPONSE','range'); const [start,end,total] = match.slice(1).map(Number); if (![start,end,total].every(n => mobileInteger(n)) || start! > end! || end! >= total! || length !== end! - start! + 1 || context.media && total !== context.media.totalBytes || h.get('accept-ranges') !== 'bytes') return mobileFailure('INVALID_RESPONSE','range'); }
  else if (status === 200 && (range !== null || context.media && length !== context.media.totalBytes || h.get('accept-ranges') !== 'bytes')) return mobileFailure('INVALID_RESPONSE','range');
  if (status !== 416 && body.byteLength !== length) return mobileFailure('INVALID_RESPONSE','content-length');
  return mobileOk({contentLength:length,contentType:type,contentRange:range});
}
export function decodeMobileResponse<O extends MobileOperationId>(operation:O,input:MobileHttpResponseInput,context:MobileWireCodecContext):MobileDecodeResult<MobileReplyMap[O]> {
  if (!Object.hasOwn(MOBILE_OPERATION_TABLE,operation) || !envelope(input,['status','headers','body','finalUrl']) || !mobileInteger(input.status,100,599)) return mobileFailure('INVALID_RESPONSE','response');
  const entry = MOBILE_OPERATION_TABLE[operation], h = headers(input.headers), bytes = bodyBytes(input.body); if (!h.ok || bytes === null) return mobileFailure('INVALID_RESPONSE','response');
  try { const final = new URL(input.finalUrl); if (final.protocol !== 'https:' || final.origin !== context.responseOrigin || final.username || final.password || final.hash || final.pathname !== context.requestPath) return mobileFailure('CONTEXT_MISMATCH','origin'); } catch { return mobileFailure('INVALID_RESPONSE','origin'); }
  const success = (entry.successStatuses as readonly number[]).includes(input.status);
  if (operation === 'headMediaAsset') { if (!success && input.status < 400) return mobileFailure('INVALID_RESPONSE','status'); const metadata = mediaMetadata(operation,input.status,bytes,h.value,context); return metadata.ok ? mobileOk({status:input.status,category:'binary',body:metadata.value} as MobileReplyMap[O]) : metadata; }
  if (operation === 'getMediaAsset' && (success || [400,416].includes(input.status) && bytes.byteLength === 0)) { const metadata = mediaMetadata(operation,input.status,bytes,h.value,context); return metadata.ok ? mobileOk({status:input.status,category:'binary',body:metadata.value} as MobileReplyMap[O]) : metadata; }
  const limits = context.limits ?? MOBILE_CODEC_LIMITS; if (bytes.byteLength > limits.responseBytes) return mobileFailure('LIMIT_EXCEEDED','body');
  const length = h.value.get('content-length'); if (length !== undefined && (!/^(0|[1-9]\d*)$/u.test(length) || !mobileInteger(Number(length)) || Number(length) !== bytes.byteLength)) return mobileFailure('INVALID_RESPONSE','content-length');
  if (operation === 'getArtwork' && success) { if (!['image/png','image/jpeg'].includes(h.value.get('content-type') ?? '') || bytes.byteLength === 0 || h.value.get('content-length') !== undefined && Number(h.value.get('content-length')) !== bytes.byteLength) return mobileFailure('INVALID_RESPONSE','artwork'); return mobileOk({status:input.status,category:'binary',body:{contentLength:bytes.byteLength,contentType:h.value.get('content-type')!,contentRange:null}} as MobileReplyMap[O]); }
  if (input.status === 204) return success && bytes.byteLength === 0 ? mobileOk({status:204,category:'empty',body:null} as MobileReplyMap[O]) : mobileFailure('INVALID_RESPONSE','body');
  if (!success && input.status < 400) return mobileFailure('INVALID_RESPONSE','status');
  if (!jsonContentType(h.value.get('content-type'))) return mobileFailure('INVALID_RESPONSE','content-type');
  const parsed = parseMobileJson(bytes,limits); if (!parsed.ok) return parsed;
  if (!success) { const error = mobileSchemaSnapshot<MobileErrorEnvelope>(schemas.Error!,parsed.value,schemas,limits); return error.ok ? mobileOk({status:input.status,category:'error',body:error.value} as MobileReplyMap[O]) : error; }
  let body:unknown;
  if (operation === 'createResource' || operation === 'getResource' || operation === 'renewResource') { if (!context.resource) return mobileFailure('CONTEXT_MISMATCH','resource'); const result = operation === 'createResource' ? validateMobileCreateResourceReply(input.status,parsed.value,context.resource,limits) : validateMobileGetResourceReply(input.status,parsed.value,context.resource,limits); if (!result.ok) return result; body = result.value.body; }
  else {
    if (!entry.responseSchema || !schemas[entry.responseSchema]) return mobileFailure('INVALID_RESPONSE','schema');
    const contentKind = (Object.keys(MOBILE_CONTENT_RESPONSE_NAMES) as (keyof Content.MobileContentResponseMap)[]).find(key => MOBILE_CONTENT_RESPONSE_NAMES[key] === entry.responseSchema);
    const result = contentKind ? mobileContentResponseSnapshot(contentKind,parsed.value,limits) : mobileSchemaSnapshot(schemas[entry.responseSchema]!,parsed.value,schemas,limits); if (!result.ok) return result; body = result.value;
    if (contentKind && context.content) { const identity = validateMobileContentIdentity(contentKind,result.value as Content.MobileContentResponseMap[typeof contentKind],context.content); if (!identity.ok) return identity; body = identity.value; }
    if (entry.responseSchema === 'Session' && context.session) { const session = body as MobileSession; if (session.deviceId !== context.session.deviceId || operation === 'getSession' && session.id !== context.session.sessionId) return mobileFailure('CONTEXT_MISMATCH','session'); }
    if ((operation === 'listAlbums' || operation === 'listTracks') && context.catalog) { const page = validateMobileCatalogPage(body as MobileAlbumPage | MobileTrackPage,context.catalog); if (!page.ok) return page; body = page.value; }
  }
  return mobileOk({status:input.status,category:'success',body} as MobileReplyMap[O]);
}

export function encodeMobileRequest<O extends MobileOperationId>(operation:O,value:MobileRequestMap[O],context:MobileWireCodecContext):MobileDecodeResult<MobileEncodedJsonRequest> {
  if (!Object.hasOwn(MOBILE_OPERATION_TABLE,operation) || !mobileRecord(value) || !envelope(value,Object.hasOwn(value,'idempotencyKey') ? ['path','pathParameters','query','body','idempotencyKey'] : ['path','pathParameters','query','body'])) return mobileFailure('INVALID_REQUEST','request');
  const entry = MOBILE_OPERATION_TABLE[operation], limits = context.limits ?? MOBILE_CODEC_LIMITS;
  const captured = mobileDataSnapshot(value.body,limits,'request'), querySnapshot = mobileDataSnapshot(value.query,limits,'request'), pathSnapshot = mobileDataSnapshot(value.pathParameters,limits,'request');
  if (!captured.ok) return captured;
  if (!querySnapshot.ok || !mobileRecord(querySnapshot.value) || !pathSnapshot.ok || !mobileRecord(pathSnapshot.value) || typeof value.path !== 'string' || value.idempotencyKey !== undefined && typeof value.idempotencyKey !== 'string') return mobileFailure('INVALID_REQUEST','request');
  const raw = value, body = raw.body === null ? new Uint8Array() : new TextEncoder().encode(mobileCanonicalJson(captured.value));
  const h:[string,string][] = raw.body === null ? [] : [['Content-Type','application/json']]; if (raw.idempotencyKey !== undefined) h.push(['Idempotency-Key',raw.idempotencyKey]);
  const query = Object.entries(querySnapshot.value).map(([k,v]) => [k,String(v)] as [string,string]);
  const input:MobileHttpRequestInput = {method:entry.method,path:raw.path,headers:h,query,body}; const checked = decodeMobileRequest(operation,input,context);
  if (checked.ok && mobileCanonicalJson(checked.value.pathParameters) !== mobileCanonicalJson(pathSnapshot.value)) return mobileFailure('INVALID_REQUEST','pathParameters');
  return checked.ok ? mobileOk(input) : checked;
}
export function encodeMobileJsonReply<O extends MobileOperationId>(operation:O,reply:MobileReplyMap[O],context:MobileWireCodecContext):MobileDecodeResult<MobileEncodedJsonReply> {
  if (!Object.hasOwn(MOBILE_OPERATION_TABLE,operation) || !envelope(reply,['status','category','body'])) return mobileFailure('INVALID_RESPONSE','reply');
  const captured = mobileDataSnapshot(reply.body,context.limits ?? MOBILE_CODEC_LIMITS); if (!captured.ok) return captured;
  const value = {status:reply.status,category:reply.category,body:captured.value} as unknown as MobileReplyMap[O];
  if (value.category === 'binary') return mobileFailure('INVALID_RESPONSE','binary');
  if (value.status === 204) return value.category === 'empty' && value.body === null && (MOBILE_OPERATION_TABLE[operation].successStatuses as readonly number[]).includes(204) ? mobileOk({status:204,headers:[],body:new Uint8Array()}) : mobileFailure('INVALID_RESPONSE','body');
  const name = value.category === 'error' ? 'Error' : MOBILE_OPERATION_TABLE[operation].responseSchema;
  if (!name || !schemas[name]) return mobileFailure('INVALID_RESPONSE','schema');
  const validated = decodeMobileResponse(operation,{status:value.status,headers:[['Content-Type','application/json']],body:new TextEncoder().encode(mobileCanonicalJson(value.body as unknown as MobileJsonValue)),finalUrl:`${context.responseOrigin}${context.requestPath}`},context); if (!validated.ok) return validated;
  const projected = mobileProjectSchema(schemas[name]!,value.body as unknown as MobileJsonValue,schemas), body = new TextEncoder().encode(mobileCanonicalJson(projected));
  if (body.byteLength > (context.limits ?? MOBILE_CODEC_LIMITS).responseBytes) return mobileFailure('LIMIT_EXCEEDED','body');
  return mobileOk({status:value.status,headers:[['Content-Type','application/json'],['Content-Length',String(body.byteLength)]],body});
}

export interface MobileMutationScope { serverId:string; deviceId:string; accountDomain:string | null; sessionId:string | null; targetId:string | null; method:string; path:string }
export interface MobileMutationIdentity { operation:MobileOperationId; scope:MobileMutationScope; key:string; fingerprint:string }
export interface MobileMutationReceipt { status:number; body:MobileJsonValue }
export interface MobileMutationRecord { identity:MobileMutationIdentity; state:'UNKNOWN' | 'RECORDED'; originalReceipt:MobileMutationReceipt | null }
export type MobileMutationReplayDecision = {kind:'NEW'} | {kind:'CONFLICT'} | {kind:'ORIGINAL_RECORD_LOOKUP_ONLY'} | {kind:'RETURN_ORIGINAL_RECEIPT';receipt:MobileMutationReceipt};
function mutationScopeValid(operation:MobileOperationId,raw:unknown):raw is MobileMutationScope {
  if (!Object.hasOwn(MOBILE_OPERATION_TABLE,operation) || !envelope(raw,['serverId','deviceId','accountDomain','sessionId','targetId','method','path'])) return false;
  const scope = raw as MobileMutationScope;
  return typeof scope.path === 'string' && ['POST','PUT','DELETE'].includes(scope.method) && scope.method === MOBILE_OPERATION_TABLE[operation].method && matchPath(operation,scope.path) !== null && [scope.serverId,scope.deviceId].every(isMobileId) && [scope.accountDomain,scope.sessionId,scope.targetId].every(v => v === null || isMobileId(v));
}
export function mobileMutationFingerprintInput(operation:MobileOperationId,scope:MobileMutationScope,body:MobileJsonValue):string {
  const identity = mobileDataSnapshot(scope,MOBILE_CODEC_LIMITS,'request'), captured = mobileDataSnapshot(body,MOBILE_CODEC_LIMITS,'request');
  if (!identity.ok || !mutationScopeValid(operation,identity.value) || !captured.ok) throw new TypeError('移动操作身份无法识别。');
  return mobileCanonicalJson({domain:'MOBILE_MUTATION_V1',operation,scope:identity.value,body:captured.value});
}
export function classifyMobileMutationReplay(record:MobileMutationRecord | null,incoming:MobileMutationIdentity):MobileMutationReplayDecision {
  const next = mobileDataSnapshot(incoming,MOBILE_CODEC_LIMITS,'request'); if (!next.ok || !envelope(next.value,['operation','scope','key','fingerprint']) || !mobileRecord(next.value) || typeof next.value.operation !== 'string' || !mutationScopeValid(next.value.operation as MobileOperationId,next.value.scope) || typeof next.value.key !== 'string' || !next.value.key || [...next.value.key].length > 128 || typeof next.value.fingerprint !== 'string' || !next.value.fingerprint) return {kind:'CONFLICT'};
  if (record === null) return {kind:'NEW'};
  const current = mobileDataSnapshot(record); if (!current.ok || !envelope(current.value,['identity','state','originalReceipt']) || !mobileRecord(current.value) || !mobileRecord(current.value.identity) || mobileCanonicalJson(current.value.identity) !== mobileCanonicalJson(next.value)) return {kind:'CONFLICT'};
  if (current.value.state === 'UNKNOWN') return {kind:'ORIGINAL_RECORD_LOOKUP_ONLY'};
  if (current.value.state !== 'RECORDED' || !mobileRecord(current.value.originalReceipt) || !mobileInteger(current.value.originalReceipt.status,200,599) || !Object.hasOwn(current.value.originalReceipt,'body')) return {kind:'CONFLICT'};
  return {kind:'RETURN_ORIGINAL_RECEIPT',receipt:current.value.originalReceipt as unknown as MobileMutationReceipt};
}
