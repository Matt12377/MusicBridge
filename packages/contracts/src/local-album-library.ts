import type { LocalArtworkImage } from './local-artwork.js';
import type { LocalLibraryTrackDetail } from './local-catalog.js';

/** 沿用 CoverDrop 分类身份；parse-failed 专指 AI 名称增强失败，取消或未运行不计入。 */
export const LOCAL_ALBUM_STATUSES = ['missing-artwork', 'has-artwork', 'cue-unsplit', 'metadata-issue', 'parse-failed', 'loose-audio', 'track-named-audio', 'missing-lyrics'] as const
export type LocalAlbumStatus = typeof LOCAL_ALBUM_STATUSES[number]
export type LocalAlbumFilter = 'all' | LocalAlbumStatus
export type LocalAlbumFilterCounts = Readonly<Record<LocalAlbumFilter, number>>

/** id 就是后端 albumKey；发行身份或根内不透明目录身份不由标题、艺人推断。 */
export interface LocalAlbumSummary {
  id: string
  kind: 'edition' | 'source-directory'
  rootId: string
  editionId: string | null
  title: string
  artists: readonly string[]
  year: string | null
  versionLabel: string | null
  sourceLabel?: string
  trackCount: number
  representativeTrackId: string | null
  revision: string
  artworkAvailable: boolean
  /** 本地展示资源已可靠提交；仅用于显示调度，不授予音乐源读取权限。 */
  artworkPrepared?: boolean
  /** 尚未实读与确认为缺图分开；省略时沿用旧布尔语义。 */
  artworkState?: 'available' | 'missing' | 'unknown' | 'source-unavailable'
  /** 全组全部有词才true；未观察/离线/修订过期为unknown，不能按搜索候选判定。 */
  lyricsPresence?: 'unknown' | 'false' | 'true'
  statuses: readonly LocalAlbumStatus[]
}

export interface LocalAlbumQuery {
  query: string
  rootId: string | null
  filter: LocalAlbumFilter
  offset: number
  limit: number
}
export interface LocalAlbumPage extends LocalAlbumQuery {
  total: number
  hasMore: boolean
  /** counts 的范围是当前 query/rootId 下、应用 filter 前的专辑集合。 */
  counts: LocalAlbumFilterCounts
  items: readonly LocalAlbumSummary[]
}

/** 保留原轨道、资产、元数据及版本事实，界面只向旧入口发出 facts.track.id。 */
export interface LocalAlbumTrackItem {
  facts: LocalLibraryTrackDetail
  disc: number | null
  trackNumber: number | null
  sequence: number
  statuses: readonly LocalAlbumStatus[]
}
export interface LocalAlbumTrackQuery {
  albumKey: string
  rootId: string
  offset: number
  limit: number
}
export interface LocalAlbumTrackPage extends LocalAlbumTrackQuery {
  album: LocalAlbumSummary
  total: number
  hasMore: boolean
  items: readonly LocalAlbumTrackItem[]
}

export interface LocalAlbumArtworkRequest {
  /** 仅选择传输尺寸；不改变来源身份、授权或持久封面。 */
  variant?: 'grid'
  /** 仅明确刷新/重试携带；重探读取观测，不放宽来源身份或许可。 */
  refresh?: true
  albumKey: string
  rootId: string
  editionId: string | null
  representativeTrackId: string | null
  revision: string
}
export interface LocalAlbumArtworkReply extends Omit<LocalAlbumArtworkRequest, 'refresh'> {
  image: LocalArtworkImage | null
  status?: 'ready' | 'source-unavailable'
  /** 与展示图同源生成的持久网格副本；旧缓存没有此字段仍可读取。 */
  grid?: LocalAlbumArtworkGrid
}
export type LocalAlbumArtworkGrid = LocalArtworkImage['display']
export function isLocalAlbumArtworkGrid(value: unknown): value is LocalAlbumArtworkGrid {
  if (!closed(value, ['mime', 'bytes', 'sha256', 'width', 'height', 'dataUrl'])) return false
  const grid = value as unknown as LocalAlbumArtworkGrid
  return isLocalArtworkImage({ original: { mime: grid.mime, bytes: grid.bytes, sha256: grid.sha256, width: grid.width, height: grid.height }, display: grid })
    && grid.width <= 512 && grid.height <= 512 && grid.bytes <= 256 * 1024
}

/** 端口只读；选图、整理、CUE、写回和播放继续走现有工作台。 */
export interface LocalAlbumReadPort {
  queryAlbums(request: LocalAlbumQuery): Promise<LocalAlbumPage>
  queryAlbumTracks(request: LocalAlbumTrackQuery): Promise<LocalAlbumTrackPage>
  getArtwork(request: LocalAlbumArtworkRequest): Promise<LocalAlbumArtworkReply>
}


import { isCollectionId } from './collection.js';
import { isLocalCatalogText, isLocalLibraryTrackDetail } from './local-catalog.js';
import { isLocalArtworkImage } from './local-artwork.js';

const filters = ['all', ...LOCAL_ALBUM_STATUSES] as const
const natural = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max
const opaqueIdentity = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,255}$/u.test(value)
const revision = opaqueIdentity
const nullableText = (value: unknown): value is string | null => value === null || isLocalCatalogText(value, true)
const isFilter = (value: unknown): value is LocalAlbumFilter => (filters as readonly unknown[]).includes(value)

/** 不执行 getter，也不在读取后抹掉隐藏键或未知字段。 */
function closed(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false
  const keys = Reflect.ownKeys(value)
  return required.every(key => Object.hasOwn(value, key)) && keys.every(key => typeof key === 'string' && [...required, ...optional].includes(key)
    && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))
}
function dense(value: unknown, max: number): value is unknown[] {
  return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length <= max
    && Reflect.ownKeys(value).length === value.length + 1 && Reflect.ownKeys(value).every(key => key === 'length' || typeof key === 'string'
      && /^(0|[1-9][0-9]*)$/u.test(key) && Number(key) < value.length && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
      && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))
}
function statuses(value: unknown): boolean {
  return dense(value, LOCAL_ALBUM_STATUSES.length) && value.every(status => (LOCAL_ALBUM_STATUSES as readonly unknown[]).includes(status)) && new Set(value).size === value.length
}
export function isLocalAlbumSummary(value: unknown): value is LocalAlbumSummary {
  if (!closed(value, ['id', 'kind', 'rootId', 'editionId', 'title', 'artists', 'year', 'versionLabel', 'trackCount', 'representativeTrackId', 'revision', 'artworkAvailable', 'statuses'], ['sourceLabel', 'artworkState', 'lyricsPresence', 'artworkPrepared'])) return false
  return opaqueIdentity(value.id) && isCollectionId(value.rootId) && natural(value.trackCount)
    && (value.trackCount === 0 ? value.representativeTrackId === null : isCollectionId(value.representativeTrackId))
    && (value.kind === 'edition' ? isCollectionId(value.editionId) : value.kind === 'source-directory' && value.editionId === null)
    && isLocalCatalogText(value.title) && dense(value.artists, 32) && value.artists.every(artist => isLocalCatalogText(artist))
    && nullableText(value.year) && nullableText(value.versionLabel) && revision(value.revision)
    && (!Object.hasOwn(value, 'sourceLabel') || isLocalCatalogText(value.sourceLabel) && !/^(?:\/|[a-z]:[\\/])/iu.test(value.sourceLabel))
    && typeof value.artworkAvailable === 'boolean' && statuses(value.statuses)
    && (!Object.hasOwn(value, 'artworkPrepared') || typeof value.artworkPrepared === 'boolean')
    && (!Object.hasOwn(value, 'artworkState') || ['available','missing','unknown','source-unavailable'].includes(String(value.artworkState)))
    && (!Object.hasOwn(value, 'lyricsPresence') || ['unknown', 'false', 'true'].includes(String(value.lyricsPresence)))
    && (value.lyricsPresence === undefined || (value.statuses as unknown[]).includes('missing-lyrics') === (value.lyricsPresence === 'false'))
    && (value.artworkState === 'unknown' || value.artworkState === 'source-unavailable'
      ? value.artworkAvailable === false && !(value.statuses as unknown[]).includes('has-artwork') && !(value.statuses as unknown[]).includes('missing-artwork')
      : (value.artworkState === undefined || value.artworkState === (value.artworkAvailable ? 'available' : 'missing'))
        && (value.statuses as unknown[]).includes(value.artworkAvailable ? 'has-artwork' : 'missing-artwork')
        && !(value.statuses as unknown[]).includes(value.artworkAvailable ? 'missing-artwork' : 'has-artwork'))
}
function validCounts(value: unknown): value is LocalAlbumFilterCounts {
  return closed(value, filters) && filters.every(filter => natural(value[filter])) && LOCAL_ALBUM_STATUSES.every(status => Number(value[status]) <= Number(value.all))
}
function payloadBound(value: unknown): boolean { try { return new TextEncoder().encode(JSON.stringify(value)).byteLength <= 2 * 1024 * 1024 } catch { return false } }
export function isLocalAlbumPage(value: unknown, request: LocalAlbumQuery): value is LocalAlbumPage {
  if (!closed(value, ['query', 'rootId', 'filter', 'offset', 'limit', 'total', 'hasMore', 'counts', 'items'])) return false
  return value.query === request.query && value.rootId === request.rootId && value.filter === request.filter && value.offset === request.offset && value.limit === request.limit
    && natural(value.total) && validCounts(value.counts) && value.counts[request.filter] === value.total && dense(value.items, request.limit)
    && value.items.every(item => isLocalAlbumSummary(item) && (request.rootId === null || item.rootId === request.rootId) && (request.filter === 'all' || item.statuses.includes(request.filter)))
    && value.items.length === Math.min(request.limit, Math.max(0, value.total - request.offset))
    && value.hasMore === (request.offset + value.items.length < value.total) && new Set(value.items.map(item => (item as LocalAlbumSummary).id)).size === value.items.length
    && payloadBound(value)
}
export function isLocalAlbumTrackItem(value: unknown): value is LocalAlbumTrackItem {
  return closed(value, ['facts', 'disc', 'trackNumber', 'sequence', 'statuses']) && isLocalLibraryTrackDetail(value.facts)
    && (value.disc === null || natural(value.disc, 1_000_000) && value.disc > 0)
    && (value.trackNumber === null || natural(value.trackNumber, 1_000_000) && value.trackNumber > 0)
    && natural(value.sequence) && statuses(value.statuses)
}
export function isLocalAlbumTrackPage(value: unknown, request: LocalAlbumTrackQuery, expectedAlbum: LocalAlbumSummary): value is LocalAlbumTrackPage {
  if (!closed(value, ['albumKey', 'rootId', 'offset', 'limit', 'album', 'total', 'hasMore', 'items'])) return false
  if (!isLocalAlbumSummary(value.album)) return false
  const album = value.album
  return value.albumKey === request.albumKey && value.rootId === request.rootId && value.offset === request.offset && value.limit === request.limit
    && album.id === request.albumKey && album.rootId === request.rootId
    && album.kind === expectedAlbum.kind && album.editionId === expectedAlbum.editionId
    && natural(value.total) && value.total === album.trackCount && dense(value.items, request.limit)
    && value.items.every(item => isLocalAlbumTrackItem(item) && item.facts.asset.libraryRootId === request.rootId
      && (album.kind !== 'edition' || item.facts.editions.some(edition => edition.id === album.editionId)))
    && value.items.length === Math.min(request.limit, Math.max(0, value.total - request.offset)) && value.hasMore === (request.offset + value.items.length < value.total)
    && new Set(value.items.map(item => (item as LocalAlbumTrackItem).facts.track.id)).size === value.items.length
    && value.items.every((item, index, items) => index === 0 || (item as LocalAlbumTrackItem).sequence > (items[index - 1] as LocalAlbumTrackItem).sequence)
    && payloadBound(value)
}
const artworkRequest = (album: LocalAlbumSummary): LocalAlbumArtworkRequest => ({ albumKey: album.id, rootId: album.rootId, editionId: album.editionId, representativeTrackId: album.representativeTrackId, revision: album.revision })
const sameArtworkRequest = (left: LocalAlbumArtworkRequest, right: LocalAlbumArtworkRequest): boolean => left.albumKey === right.albumKey && left.rootId === right.rootId
  && left.editionId === right.editionId && left.representativeTrackId === right.representativeTrackId && left.revision === right.revision
export function isLocalAlbumArtworkReply(value: unknown, request: LocalAlbumArtworkRequest): value is LocalAlbumArtworkReply {
  return closed(value, ['albumKey', 'rootId', 'editionId', 'representativeTrackId', 'revision', 'image'], ['status', 'grid', 'variant'])
    && (!Object.hasOwn(value, 'variant') || value.variant === 'grid') && value.variant === request.variant
    && sameArtworkRequest(value as unknown as LocalAlbumArtworkRequest, request) && (value.image === null || isLocalArtworkImage(value.image))
    && (!Object.hasOwn(value, 'grid') || value.image !== null && isLocalAlbumArtworkGrid(value.grid))
    && (!Object.hasOwn(value, 'status') || value.status === 'ready' || value.status === 'source-unavailable' && value.image === null)
}

export const LOCAL_ALBUM_COMMANDS = ['localAlbum.query', 'localAlbum.tracks', 'localAlbum.artwork'] as const;
export type LocalAlbumCommand = typeof LOCAL_ALBUM_COMMANDS[number];
export interface LocalAlbumCommandPayloads {
  'localAlbum.query': LocalAlbumQuery;
  'localAlbum.tracks': LocalAlbumTrackQuery;
  'localAlbum.artwork': LocalAlbumArtworkRequest;
}
export interface LocalAlbumCommandResults {
  'localAlbum.query': LocalAlbumPage;
  'localAlbum.tracks': LocalAlbumTrackPage;
  'localAlbum.artwork': LocalAlbumArtworkReply;
}
export interface LocalAlbumLibraryPublicApi {
  queryLocalAlbums(request: LocalAlbumQuery): Promise<LocalAlbumPage>;
  getLocalAlbumTracks(request: LocalAlbumTrackQuery): Promise<LocalAlbumTrackPage>;
  getLocalAlbumArtwork(request: LocalAlbumArtworkRequest): Promise<LocalAlbumArtworkReply>;
}
export function isLocalAlbumCommand(value: unknown): value is LocalAlbumCommand { return (LOCAL_ALBUM_COMMANDS as readonly unknown[]).includes(value); }
export function isLocalAlbumQuery(value: unknown): value is LocalAlbumQuery {
  return closed(value, ['query','rootId','filter','offset','limit']) && isLocalCatalogText(value.query, true) && Array.from(value.query as string).length <= 256
    && (value.rootId === null || isCollectionId(value.rootId)) && isFilter(value.filter) && natural(value.offset) && natural(value.limit, 200) && value.limit > 0;
}
export function isLocalAlbumTrackQuery(value: unknown): value is LocalAlbumTrackQuery {
  return closed(value, ['albumKey','rootId','offset','limit']) && opaqueIdentity(value.albumKey) && isCollectionId(value.rootId) && natural(value.offset) && natural(value.limit, 200) && value.limit > 0;
}
export function isLocalAlbumArtworkRequest(value: unknown): value is LocalAlbumArtworkRequest {
  return closed(value, ['albumKey','rootId','editionId','representativeTrackId','revision'], ['refresh','variant'])
    && (!Object.hasOwn(value, 'variant') || value.variant === 'grid')
    && (!Object.hasOwn(value, 'refresh') || value.refresh === true) && opaqueIdentity(value.albumKey) && isCollectionId(value.rootId)
    && (value.editionId === null || isCollectionId(value.editionId)) && (value.representativeTrackId === null || isCollectionId(value.representativeTrackId)) && revision(value.revision);
}
export function isLocalAlbumCommandPayload<C extends LocalAlbumCommand>(command: C, value: unknown): value is LocalAlbumCommandPayloads[C] {
  switch (command) { case 'localAlbum.query': return isLocalAlbumQuery(value); case 'localAlbum.tracks': return isLocalAlbumTrackQuery(value); case 'localAlbum.artwork': return isLocalAlbumArtworkRequest(value); }
  return false;
}
/** 响应闭集之外，客户端还须以原请求再次验证身份。 */
export function isLocalAlbumCommandResult<C extends LocalAlbumCommand>(command: C, value: unknown): value is LocalAlbumCommandResults[C] {
  if (typeof value !== 'object' || value === null || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some(key => typeof key !== 'string' || Object.getOwnPropertyDescriptor(value, key)?.enumerable !== true
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))) return false;
  const row = value as Record<string, unknown>;
  switch (command) {
    case 'localAlbum.query': {
      const request = { query: row.query, rootId: row.rootId, filter: row.filter, offset: row.offset, limit: row.limit };
      return isLocalAlbumQuery(request) && isLocalAlbumPage(value, request);
    }
    case 'localAlbum.tracks': {
      const request = { albumKey: row.albumKey, rootId: row.rootId, offset: row.offset, limit: row.limit };
      return isLocalAlbumTrackQuery(request) && isLocalAlbumSummary(row.album) && isLocalAlbumTrackPage(value, request, row.album);
    }
    case 'localAlbum.artwork': {
      const request = { albumKey: row.albumKey, rootId: row.rootId, editionId: row.editionId, representativeTrackId: row.representativeTrackId, revision: row.revision, ...(Object.hasOwn(row, 'variant') ? { variant: row.variant } : {}) };
      return isLocalAlbumArtworkRequest(request) && isLocalAlbumArtworkReply(value, request);
    }
  }
  return false;
}
