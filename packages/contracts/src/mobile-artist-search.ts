import { MOBILE_CATALOG_SCHEMAS } from './mobile-catalog.js';
import type { MobileAlbumPage, MobileTrackPage } from './mobile-catalog.js';
import { MOBILE_CODEC_LIMITS, MOBILE_ID_SCHEMA, isMobileId, mobileDataSnapshot, mobileFailure,
  mobileOk, mobileRecord, mobileSchemaSnapshot } from './mobile-common.js';
import type { MobileDecodeResult, MobileSchemaRegistry, MobileSource } from './mobile-common.js';
import { isLocalArtistId } from './artist-search.js';

/** 4.1 独立扩展，不改写冻结基础移动合同或任何现存音乐身份。 */
export interface MobileArtist {
  id: string; name: string; source: MobileSource; albumCount: number; trackCount: number;
  artworkId?: string; linkedNeteaseId?: string; biography?: string; credit?: string;
  linkState?: 'automatic' | 'manual' | 'unlinked';
}
export interface MobileArtistPage { items: MobileArtist[]; nextCursor: string | null; libraryRevision: string }
export type MobileArtistSearchKind = 'tracks' | 'albums' | 'artists';
export type MobileArtistSearchOperation = 'searchTracks' | 'searchAlbums' | 'searchArtists' | 'listLibraryArtists'
  | 'getLibraryArtist' | 'listLibraryArtistAlbums' | 'listLibraryArtistTracks' | 'listLibraryArtistMatches' | 'setLibraryArtistLink';
export interface MobileArtistSearchRoute {
  operation: MobileArtistSearchOperation; kind: MobileArtistSearchKind;
  source: MobileSource; query: string; limit: number; cursor: string | null;
  artistId: string | null; relation: 'albums' | 'appearsOn'; neteaseArtistId: string | null;
}
export type MobileArtistSearchReply = MobileArtist | MobileArtistPage | MobileAlbumPage | MobileTrackPage;
export class MobileArtistSearchContractError extends Error {
  constructor() { super('艺术家或搜索请求不符合合同。'); this.name = 'MobileArtistSearchContractError'; }
}
const invalid = (): never => { throw new MobileArtistSearchContractError(); };
const numericId = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,31}$/u.test(value);
const text = (value: string, empty: boolean) => (empty || value.trim().length > 0) && [...value].length <= 200
  && !/[\u0000-\u001f\u007f]/u.test(value);

export function isMobileArtistSearchPath(path: string): boolean {
  return /^\/mobile\/v1\/(?:search\/(?:tracks|albums|artists)|library\/artists(?:\/[^/]+(?:\/(?:albums|tracks|matches|link))?)?)$/u.test(path);
}

/** 调用方先解析 origin-form URL；这里拒绝重复键、未知键、混合来源和查询中的裸offset。 */
export function parseMobileArtistSearchRoute(input: {
  method: string; path: string; query: readonly (readonly [string, string])[]; body: unknown;
}): MobileArtistSearchRoute {
  if (!isMobileArtistSearchPath(input.path)) return invalid();
  const pairs = mobileDataSnapshot(input.query, MOBILE_CODEC_LIMITS, 'request');
  if (!pairs.ok || !Array.isArray(pairs.value) || pairs.value.length > 8) return invalid();
  const values = new Map<string, string>();
  for (const pair of pairs.value) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string'
      || values.has(pair[0])) return invalid();
    values.set(pair[0], pair[1]);
  }
  const search = /^\/mobile\/v1\/search\/(tracks|albums|artists)$/u.exec(input.path);
  const artist = /^\/mobile\/v1\/library\/artists(?:\/([^/]+)(?:\/(albums|tracks|matches|link))?)?$/u.exec(input.path);
  let artistId: string | null = null;
  if (artist?.[1]) {
    try { artistId = decodeURIComponent(artist[1]); } catch { return invalid(); }
    if (!isMobileId(artistId)) return invalid();
  }
  const tail = artist?.[2] ?? null;
  const isDetail = !!artistId && tail === null;
  const isLink = tail === 'link';
  const isMatches = tail === 'matches';
  const allowed = isLink ? [] : isDetail ? ['source'] : isMatches ? ['q', 'limit', 'cursor']
    : tail === 'albums' ? ['q', 'source', 'limit', 'cursor', 'relation'] : ['q', 'source', 'limit', 'cursor'];
  if ([...values.keys()].some(key => !allowed.includes(key)) || input.method !== (isLink ? 'PUT' : 'GET')) return invalid();
  const source = values.get('source') ?? (search ? null : 'local');
  if (source !== 'local' && source !== 'netease' || !search && !artistId && source !== 'local'
    || (isMatches || isLink) && source !== 'local') return invalid();
  if (artistId !== null && (source === 'local' ? !isLocalArtistId(artistId) : !numericId(artistId))) return invalid();
  const query = values.get('q') ?? '';
  if (!text(query, !search)) return invalid();
  const limitValue = values.get('limit') ?? (isDetail || isLink ? '1' : '50');
  if (!/^[1-9][0-9]{0,2}$/u.test(limitValue)) return invalid();
  const limit = Number(limitValue);
  if (limit > 100) return invalid();
  const cursor = values.get('cursor') ?? null;
  if (cursor !== null && (cursor.length === 0 || new TextEncoder().encode(cursor).length > 2048
    || /[\u0000-\u0020\u007f]/u.test(cursor))) return invalid();
  const relation = values.get('relation') ?? 'albums';
  if (relation !== 'albums' && relation !== 'appearsOn'
    || source === 'netease' && relation === 'appearsOn') return invalid();
  let neteaseArtistId: string | null = null;
  if (isLink) {
    const body = mobileDataSnapshot(input.body, { ...MOBILE_CODEC_LIMITS, requestBytes: 4096 }, 'request');
    if (!body.ok || !mobileRecord(body.value) || Object.keys(body.value).length !== 1
      || !Object.hasOwn(body.value, 'neteaseArtistId')
      || body.value.neteaseArtistId !== null && !numericId(body.value.neteaseArtistId)) return invalid();
    neteaseArtistId = body.value.neteaseArtistId;
  } else if (input.body !== null) return invalid();
  const kind = (search?.[1] ?? (tail === 'tracks' ? 'tracks' : tail === 'albums' ? 'albums' : 'artists')) as MobileArtistSearchKind;
  const operation: MobileArtistSearchOperation = search ? kind === 'tracks' ? 'searchTracks' : kind === 'albums' ? 'searchAlbums' : 'searchArtists'
    : !artistId ? 'listLibraryArtists' : isLink ? 'setLibraryArtistLink' : isMatches ? 'listLibraryArtistMatches'
    : tail === 'albums' ? 'listLibraryArtistAlbums' : tail === 'tracks' ? 'listLibraryArtistTracks' : 'getLibraryArtist';
  return { operation, kind, source, query, limit, cursor, artistId, relation, neteaseArtistId };
}

export const MOBILE_ARTIST_SEARCH_SCHEMAS: MobileSchemaRegistry = {
  ...MOBILE_CATALOG_SCHEMAS,
  Artist: {
    type: 'object', additionalProperties: false, required: ['id', 'name', 'source', 'albumCount', 'trackCount'],
    properties: {
      id: MOBILE_ID_SCHEMA, name: { type: 'string', minLength: 1, maxLength: 1024 }, source: { enum: ['local', 'netease'] },
      albumCount: { type: 'integer', minimum: 0 }, trackCount: { type: 'integer', minimum: 0 },
      artworkId: MOBILE_ID_SCHEMA, linkedNeteaseId: MOBILE_ID_SCHEMA,
      biography: { type: 'string', maxLength: 20000 }, credit: { type: 'string', maxLength: 2000 },
      linkState: { enum: ['automatic', 'manual', 'unlinked'] },
    },
  },
  ArtistPage: {
    type: 'object', additionalProperties: false, required: ['items', 'nextCursor', 'libraryRevision'],
    properties: { items: { type: 'array', maxItems: 100, items: { $ref: '#/components/schemas/Artist' } },
      nextCursor: { type: ['string', 'null'], maxLength: 2048 }, libraryRevision: MOBILE_ID_SCHEMA },
  },
};

export function captureMobileArtist(raw: unknown): MobileDecodeResult<MobileArtist> {
  const result = mobileSchemaSnapshot<MobileArtist>(MOBILE_ARTIST_SEARCH_SCHEMAS.Artist!, raw, MOBILE_ARTIST_SEARCH_SCHEMAS);
  if (!result.ok) return result;
  const value = result.value;
  if (!value.name.trim() || value.source === 'local' && !isLocalArtistId(value.id)
    || value.source === 'netease' && !numericId(value.id)
    || value.linkedNeteaseId !== undefined && (!numericId(value.linkedNeteaseId) || value.source !== 'local')
    || value.linkState === 'unlinked' && value.linkedNeteaseId !== undefined) return mobileFailure('INVALID_RESPONSE', 'artist');
  return mobileOk(value);
}

export function captureMobileArtistPage(raw: unknown, source: MobileSource): MobileDecodeResult<MobileArtistPage> {
  const result = mobileSchemaSnapshot<MobileArtistPage>(MOBILE_ARTIST_SEARCH_SCHEMAS.ArtistPage!, raw, MOBILE_ARTIST_SEARCH_SCHEMAS);
  if (!result.ok) return result;
  const value = result.value;
  if (new Set(value.items.map(item => item.id)).size !== value.items.length
    || value.items.some(item => item.source !== source || !captureMobileArtist(item).ok)
    || value.nextCursor !== null && (!value.nextCursor || value.items.length === 0)) return mobileFailure('INVALID_RESPONSE', 'artistPage');
  return mobileOk(value);
}
