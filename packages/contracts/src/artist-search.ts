import { isCollectionId } from './collection.js';
import { isLocalAlbumSummary, type LocalAlbumSummary } from './local-album-library.js';
import { isLocalCatalogText, isLocalLibraryTrackSummary, type LocalLibraryTrackSummary } from './local-catalog.js';

/** 本地身份来自规范名称；外部人物关联只补充资料，不合并或改写本地曲库。 */
export interface LocalArtistSummary {
  id: string;
  name: string;
  source: 'local' | 'netease';
  /** 专辑艺人归属数量；参与合辑的曲目不增加此计数。 */
  albumCount: number;
  /** 作为歌曲艺人参与的去重曲目数量。 */
  trackCount: number;
  artworkId?: string;
  linkedNeteaseId?: string;
}
export interface ArtistQuery { query: string; offset: number; limit: number }
export interface ArtistPageBase<T> { offset: number; limit: number; total: number; hasMore: boolean; revision: string; items: readonly T[] }
export interface LocalArtistPage extends ArtistQuery, ArtistPageBase<LocalArtistSummary> {}
export interface LocalArtistAlbumsQuery { artistId: string; relation: 'albums' | 'appearsOn'; offset: number; limit: number }
export interface LocalArtistAlbumsPage extends LocalArtistAlbumsQuery, ArtistPageBase<LocalAlbumSummary> {}
export interface LocalArtistTracksQuery { artistId: string; offset: number; limit: number }
/** 保留旧曲目事实与原专辑身份；播放和手机映射继续使用原曲目/专辑链。 */
export interface LocalArtistTrackItem extends LocalLibraryTrackSummary { rootId: string; albumKey: string }
export interface LocalArtistTracksPage extends LocalArtistTracksQuery, ArtistPageBase<LocalArtistTrackItem> {}
export interface LocalArtistTrackMembership { rootId: string; albumKey: string }
export interface LocalSearchAlbumsPage extends ArtistQuery, ArtistPageBase<LocalAlbumSummary> {}
export interface LocalSearchTracksPage extends ArtistQuery, ArtistPageBase<LocalArtistTrackItem> {}
export interface LocalArtistSearchResult {
  query: string;
  revision: string;
  artists: LocalArtistPage;
  albums: LocalSearchAlbumsPage;
  tracks: LocalSearchTracksPage;
}
export interface LocalArtistSearchPort {
  queryArtists(request: ArtistQuery): Promise<LocalArtistPage>;
  artist(artistId: string): Promise<LocalArtistSummary>;
  queryArtistAlbums(request: LocalArtistAlbumsQuery): Promise<LocalArtistAlbumsPage>;
  queryArtistTracks(request: LocalArtistTracksQuery): Promise<LocalArtistTracksPage>;
  search(request: ArtistQuery): Promise<LocalArtistSearchResult>;
  trackMemberships(trackId: string): Promise<readonly LocalArtistTrackMembership[]>;
}

function closed(v: unknown, required: readonly string[], optional: readonly string[] = []): v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return false;
  return required.every(key => Object.hasOwn(v, key)) && Reflect.ownKeys(v).every(key => typeof key === 'string'
    && [...required, ...optional].includes(key) && Object.getOwnPropertyDescriptor(v, key)?.enumerable === true
    && Object.hasOwn(Object.getOwnPropertyDescriptor(v, key)!, 'value'));
}
const natural = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const opaque = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,255}$/u.test(v);
const window = (v: Record<string, unknown>) => natural(v.offset) && natural(v.limit) && v.limit >= 1 && v.limit <= 200;
export function isLocalArtistId(v: unknown): v is string { return typeof v === 'string' && /^local-artist:[a-f0-9]{64}$/u.test(v); }
export function isLocalArtistSummary(v: unknown): v is LocalArtistSummary {
  return closed(v, ['id', 'name', 'source', 'albumCount', 'trackCount'], ['artworkId', 'linkedNeteaseId'])
    && opaque(v.id) && (v.source === 'local' ? isLocalArtistId(v.id) : v.source === 'netease')
    && isLocalCatalogText(v.name) && natural(v.albumCount) && natural(v.trackCount)
    && (!Object.hasOwn(v, 'artworkId') || opaque(v.artworkId))
    && (!Object.hasOwn(v, 'linkedNeteaseId') || typeof v.linkedNeteaseId === 'string' && /^[1-9][0-9]{0,19}$/u.test(v.linkedNeteaseId));
}
export function isArtistQuery(v: unknown): v is ArtistQuery {
  return closed(v, ['query', 'offset', 'limit']) && isLocalCatalogText(v.query, true) && [...v.query].length <= 256 && window(v);
}
export function isLocalArtistAlbumsQuery(v: unknown): v is LocalArtistAlbumsQuery {
  return closed(v, ['artistId', 'relation', 'offset', 'limit']) && isLocalArtistId(v.artistId)
    && (v.relation === 'albums' || v.relation === 'appearsOn') && window(v);
}
export function isLocalArtistTracksQuery(v: unknown): v is LocalArtistTracksQuery {
  return closed(v, ['artistId', 'offset', 'limit']) && isLocalArtistId(v.artistId) && window(v);
}
export function isLocalArtistTrackItem(v: unknown): v is LocalArtistTrackItem {
  return closed(v, ['track', 'asset', 'metadata', 'versionTokens', 'rootId', 'albumKey']) && isCollectionId(v.rootId) && opaque(v.albumKey)
    && isLocalLibraryTrackSummary({ track: v.track, asset: v.asset, metadata: v.metadata, versionTokens: v.versionTokens })
    && (v.asset as LocalArtistTrackItem['asset']).libraryRootId === v.rootId;
}
function page(v: Record<string, unknown>, guard: (item: unknown) => boolean): boolean {
  return window(v) && natural(v.total) && opaque(v.revision) && Array.isArray(v.items)
    && Object.getPrototypeOf(v.items) === Array.prototype && Reflect.ownKeys(v.items).length === v.items.length + 1
    && v.items.length === Math.min(Number(v.limit), Math.max(0, v.total - Number(v.offset)))
    && v.items.every(guard) && v.hasMore === (Number(v.offset) + v.items.length < v.total)
    && new TextEncoder().encode(JSON.stringify(v)).byteLength <= 2 * 1024 * 1024;
}
export function isLocalArtistPage(v: unknown): v is LocalArtistPage {
  return closed(v, ['query', 'offset', 'limit', 'total', 'hasMore', 'revision', 'items'])
    && isArtistQuery({ query: v.query, offset: v.offset, limit: v.limit }) && page(v, isLocalArtistSummary);
}
export function isLocalArtistAlbumsPage(v: unknown): v is LocalArtistAlbumsPage {
  return closed(v, ['artistId', 'relation', 'offset', 'limit', 'total', 'hasMore', 'revision', 'items'])
    && isLocalArtistAlbumsQuery({ artistId: v.artistId, relation: v.relation, offset: v.offset, limit: v.limit }) && page(v, isLocalAlbumSummary);
}
export function isLocalArtistTracksPage(v: unknown): v is LocalArtistTracksPage {
  return closed(v, ['artistId', 'offset', 'limit', 'total', 'hasMore', 'revision', 'items'])
    && isLocalArtistTracksQuery({ artistId: v.artistId, offset: v.offset, limit: v.limit }) && page(v, isLocalArtistTrackItem);
}
export function isLocalArtistSearchResult(v: unknown): v is LocalArtistSearchResult {
  return closed(v, ['query', 'revision', 'artists', 'albums', 'tracks']) && isLocalCatalogText(v.query, true) && opaque(v.revision)
    && isLocalArtistPage(v.artists)
    && closed(v.albums, ['query', 'offset', 'limit', 'total', 'hasMore', 'revision', 'items']) && page(v.albums, isLocalAlbumSummary)
    && closed(v.tracks, ['query', 'offset', 'limit', 'total', 'hasMore', 'revision', 'items']) && page(v.tracks, isLocalArtistTrackItem)
    && [v.artists, v.albums, v.tracks].every(p => p.query === v.query && p.revision === v.revision);
}
