import { assertLibraryReadCurrent, currentLibraryRead, libraryReadCancelled, remainingLibraryReadMs, waitLibraryRead } from '../shared/library-read-lifetime.js';
import { randomUUID } from 'node:crypto';
import { SnapshotReadFlights } from './read-snapshot-cache.js';
import { assertNeteaseRequestCurrent, MAX_NETEASE_REQUEST_TIMEOUT_MS, NeteaseRequestScheduler, waitNeteaseRequest } from './request-scheduler.js';
import { traceProviderApi } from '../diagnostics/performance-instrumentation.js';
import { createRequire } from 'node:module';
import { BridgeError } from '../shared/errors.js';
import {
  enforceNeteaseSafetyEnvironment,
  normalizePageRequest,
  normalizeSearchQuery,
  normalizeTrackId,
  MAX_LIBRARY_PAGE_LIMIT,
} from './policy.js';
import {
  parseAccountId,
  parseDailyRecommendations,
  parseLikedPlaylistId,
  parseLikedTrackIds,
  assertTrackLikeMutationSucceeded,
  parsePlaylistDetailHeader,
  parsePlaylistTrackIds,
  parsePlaylistSummaries,
  parsePlaylistTrackPage,
  parseSearchPage,
  parseArtistSearchPage,
  parseAlbumSearchPage,
  parseArtistDetail,
  parseAlbumDetail,
  parseResolvedAudioStream,
  parseTrackMetadata,
  parseTrackSummaries,
  orderTrackSummariesByIds,
  parsePublicAccountProfile,
} from './parse.js';
import type {
  Page,
  PageRequest,
  DailyRecommendationsSnapshot,
  PlaylistDetail,
  PlaylistSummary,
  NeteasePort,
  QualityLevel,
  ResolvedAudioStream,
  TrackSummary,
  ArtistSummary,
  AlbumSummary,
  TrackMetadata,
  PublicAccountProfile,
  CredentialVerificationStatus,
  NeteaseRequestOptions,
} from './types.js';
import {
  parseLoginStatusResponse,
  parseQrCheckResponse,
  parseQrImageResponse,
  parseQrKeyResponse,
} from './parse.js';
import { parseLyricsResponse } from './lyrics.js';
import type { QrLoginCheckResult, QrLoginProvider } from './qr-login.js';
import { ensureNeteaseApiRuntime } from './api-runtime.js';

type ApiResponse = Promise<unknown>;

const DEFAULT_METADATA_CACHE_MAX_ENTRIES = 256;
const MAX_METADATA_CACHE_MAX_ENTRIES = 512;
const DEFAULT_METADATA_CACHE_TTL_MS = 5 * 60 * 1_000;
const LIKED_TRACK_IDS_CACHE_TTL_MS = 30 * 1_000;
const PLAYLIST_CACHE_MAX_ENTRIES = 32;
const PLAYLIST_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const PLAYLIST_CACHE_MAX_ENTRY_BYTES = 4 * 1024 * 1024;
const SNAPSHOT_CACHE_TTL_MS = 30_000;

type PlaylistHeader = Omit<PlaylistDetail, 'tracks' | 'snapshotVersion'>;
interface PlaylistBase {
  header: PlaylistHeader;
  trackIds?: readonly string[];
  snapshotVersion?: string;
  pageScope: string;
  bornAt: number;
  expiresAt: number;
  bytes: number;
}

interface PlaylistReadGroup {
  count: number;
  acceptedPageScope: string | undefined;
}

interface CachedTrackMetadata {
  metadata: TrackMetadata;
  expiresAt: number;
}

interface CachedLikedTrackIds {
  ids: readonly string[];
  idSet: ReadonlySet<string>;
  expiresAt: number;
}

interface NeteaseClientOptions {
  metadataCacheMaxEntries?: number;
  metadataCacheTtlMs?: number;
  now?: () => number;
  playlistCacheMaxEntries?: number;
  playlistCacheMaxBytes?: number;
  playlistCacheMaxEntryBytes?: number;
  snapshotCacheTtlMs?: number;
  snapshotReadMaximumFlights?: number;
  snapshotReadMaximumSubscribers?: number;
  snapshotReadTimeoutMs?: number;
  requestMaximumQueued?: number;
  requestTimeoutMs?: number;
}

function boundedCacheOption(value: number | undefined, maximum: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : maximum;
}

function samePlaylistBase(a: PlaylistBase, header: PlaylistHeader, ids: readonly string[]): boolean {
  return a.trackIds !== undefined && a.header.id === header.id && a.header.name === header.name &&
    a.header.trackCount === header.trackCount && a.header.description === header.description && a.header.artworkUrl === header.artworkUrl &&
    a.trackIds.length === ids.length && ids.every((id, index) => a.trackIds![index] === id);
}

function boundedMetadataCacheEntries(value: number | undefined): number {
  return Number.isSafeInteger(value) && value !== undefined && value > 0
    ? Math.min(value, MAX_METADATA_CACHE_MAX_ENTRIES)
    : DEFAULT_METADATA_CACHE_MAX_ENTRIES;
}

function boundedMetadataCacheTtlMs(value: number | undefined): number {
  return Number.isSafeInteger(value) && value !== undefined && value > 0
    ? Math.min(value, DEFAULT_METADATA_CACHE_TTL_MS)
    : DEFAULT_METADATA_CACHE_TTL_MS;
}

function cloneTrackMetadata(track: TrackSummary | TrackMetadata): TrackMetadata {
  return {
    id: track.id,
    title: track.title,
    artists: [...track.artists],
    album: track.album,
    ...(track.durationMs !== undefined ? { durationMs: track.durationMs } : {}),
    ...(track.version !== undefined ? { version: track.version } : {}),
    ...(track.artworkUrl !== undefined ? { artworkUrl: track.artworkUrl } : {}),
  };
}

function localDayKey(now = Date.now()): string {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

interface NeteaseApiModule {
  song_detail(params: Record<string, unknown>, options?: NeteaseRequestOptions): ApiResponse;
  song_url_v1(params: Record<string, unknown>, options?: NeteaseRequestOptions): ApiResponse;
  login_qr_key(params: Record<string, unknown>): ApiResponse;
  login_qr_create(params: Record<string, unknown>): ApiResponse;
  login_qr_check(params: Record<string, unknown>): ApiResponse;
  login_status(params: Record<string, unknown>): ApiResponse;
  logout(params: Record<string, unknown>): ApiResponse;
  search?(params: Record<string, unknown>): ApiResponse;
  artists?(params: Record<string, unknown>): ApiResponse;
  artist_detail?(params: Record<string, unknown>): ApiResponse;
  album?(params: Record<string, unknown>): ApiResponse;
  likelist?(params: Record<string, unknown>): ApiResponse;
  song_like?(params: Record<string, unknown>): ApiResponse;
  song_like_check?(params: Record<string, unknown>): ApiResponse;
  user_account?(params: Record<string, unknown>): ApiResponse;
  recommend_songs?(params: Record<string, unknown>): ApiResponse;
  user_playlist?(params: Record<string, unknown>): ApiResponse;
  playlist_detail?(params: Record<string, unknown>): ApiResponse;
  playlist_track_all?(params: Record<string, unknown>): ApiResponse;
  lyric_new?(params: Record<string, unknown>, options?: NeteaseRequestOptions): ApiResponse;
}

function loadApi(): NeteaseApiModule {
  enforceNeteaseSafetyEnvironment(process.env);
  const require = createRequire(import.meta.url);
  const provider = require('@neteasecloudmusicapienhanced/api') as NeteaseApiModule;
  const wrapped = new Map<PropertyKey, unknown>();
  // 固定SDK仅支持query.timeout；无signal透传入口，不能把本地取消冒充物理abort。
  return new Proxy(provider, { get(target, property, receiver) {
    const original = Reflect.get(target, property, receiver) as unknown;
    if (typeof original !== 'function') return original;
    if (!wrapped.has(property)) wrapped.set(property, (params: Record<string, unknown>) => original.call(target, { timeout: MAX_NETEASE_REQUEST_TIMEOUT_MS, ...params }));
    return wrapped.get(property);
  } });
}

export class NeteaseClient implements NeteasePort, QrLoginProvider {
  private cookie: string | undefined;
  private accountGeneration = 0;
  private outstandingReads = 0;
  private readonly requestScheduler: NeteaseRequestScheduler;
  private readonly api: NeteaseApiModule;
  private readonly prepareApiRuntime: () => Promise<void>;
  private readonly metadataCache = new Map<string, CachedTrackMetadata>();
  private readonly metadataCacheMaxEntries: number;
  private readonly metadataCacheTtlMs: number;
  private readonly now: () => number;
  private likedTrackIdsCache: CachedLikedTrackIds | undefined;
  private readonly playlistBases = new Map<string, PlaylistBase>();
  private playlistCacheBytes = 0;
  private readonly latestBaseLoads = new Map<string, object>();
  // 仅保留在途调用的最新受理事实；LRU淘汰不能让旧页重新有效。
  private readonly playlistReadGroups = new Map<string, PlaylistReadGroup>();
  private playlistReadCount = 0;
  private readonly maximumPlaylistReadSubscribers: number;
  private readonly snapshotReads: SnapshotReadFlights;
  private readonly playlistCacheMaxEntries: number;
  private readonly playlistCacheMaxBytes: number;
  private readonly playlistCacheMaxEntryBytes: number;
  private readonly snapshotCacheTtlMs: number;
  private accountCache: { id: string; bornAt: number; expiresAt: number } | undefined;
  private latestAccountLoad: object | undefined;

  constructor(
    cookie: string | undefined,
    api?: NeteaseApiModule,
    prepareApiRuntime?: () => Promise<void>,
    options: NeteaseClientOptions = {},
  ) {
    this.cookie = cookie?.trim() || undefined;
    this.requestScheduler = new NeteaseRequestScheduler({
      ...(options.requestMaximumQueued === undefined ? {} : { maximumQueued: options.requestMaximumQueued }),
      ...(options.requestTimeoutMs === undefined ? {} : { timeoutMs: options.requestTimeoutMs }),
    });
    const providerApi = api ?? loadApi();
    const traced = process.env.MUSIC_BRIDGE_PERFORMANCE_TRACE === '1' ? traceProviderApi(providerApi) : providerApi;
    const readMethods = new Set(['search', 'artists', 'artist_detail', 'album', 'likelist', 'song_like_check', 'user_account', 'recommend_songs', 'user_playlist', 'playlist_detail', 'playlist_track_all', 'song_detail', 'lyric_new', 'song_url_v1']);
    const playbackMethods = new Set(['song_detail', 'lyric_new', 'song_url_v1']);
    const wrapped = new Map<PropertyKey, unknown>();
    this.api = new Proxy(traced, { get: (target, property, receiver) => {
      const original = Reflect.get(target, property, receiver) as unknown;
      if (typeof original !== 'function' || !readMethods.has(String(property))) return original;
      if (wrapped.has(property)) return wrapped.get(property);
      const invoke = (params: Record<string, unknown>, requestOptions?: NeteaseRequestOptions) => {
        assertLibraryReadCurrent();
        if (typeof params.cookie === 'string' && params.cookie !== this.cookie) throw libraryReadCancelled();
        const read = currentLibraryRead();
        const generation = this.accountGeneration;
        if (!read) return this.requestScheduler.run(timeout => {
          assertLibraryReadCurrent();
          if (generation !== this.accountGeneration) throw libraryReadCancelled();
          return original.call(target, playbackMethods.has(String(property)) || requestOptions !== undefined ? { ...params, timeout } : params);
        }, requestOptions ?? { priority: property === 'song_url_v1' ? 'playback' : 'background' }, () => generation === this.accountGeneration && (typeof params.cookie !== 'string' || params.cookie === this.cookie));
        // 媒体库读取不能耗尽播放元数据与账户恢复所需的预留调用预算。
        if (this.outstandingReads >= 32) throw new BridgeError('NETEASE_REQUEST_FAILED', '未返回读取预算已满', { details: { reason: 'request-budget' } });
        this.outstandingReads++;
        const work = Promise.resolve().then(() => {
          assertLibraryReadCurrent();
          if (generation !== this.accountGeneration) throw libraryReadCancelled();
          return original.call(target, read ? { ...params, timeout: remainingLibraryReadMs(10_000) } : params);
        }).then(result => {
          assertLibraryReadCurrent();
          if (generation !== this.accountGeneration) throw libraryReadCancelled();
          return result;
        }).finally(() => { this.outstandingReads--; });
        return waitLibraryRead(work);
      };
      wrapped.set(property, invoke); return invoke;
    } });
    this.prepareApiRuntime =
      prepareApiRuntime ?? (api === undefined ? ensureNeteaseApiRuntime : async () => undefined);
    this.metadataCacheMaxEntries = boundedMetadataCacheEntries(options.metadataCacheMaxEntries);
    this.metadataCacheTtlMs = boundedMetadataCacheTtlMs(options.metadataCacheTtlMs);
    this.now = options.now ?? Date.now;
    this.playlistCacheMaxEntries = boundedCacheOption(options.playlistCacheMaxEntries, PLAYLIST_CACHE_MAX_ENTRIES);
    this.playlistCacheMaxBytes = boundedCacheOption(options.playlistCacheMaxBytes, PLAYLIST_CACHE_MAX_BYTES);
    this.playlistCacheMaxEntryBytes = boundedCacheOption(options.playlistCacheMaxEntryBytes, PLAYLIST_CACHE_MAX_ENTRY_BYTES);
    this.snapshotCacheTtlMs = boundedCacheOption(options.snapshotCacheTtlMs, SNAPSHOT_CACHE_TTL_MS);
    this.maximumPlaylistReadSubscribers = boundedCacheOption(options.snapshotReadMaximumSubscribers, 256);
    this.snapshotReads = new SnapshotReadFlights(boundedCacheOption(options.snapshotReadMaximumFlights, 32), boundedCacheOption(options.snapshotReadMaximumSubscribers, 256), boundedCacheOption(options.snapshotReadTimeoutMs, 10_000));
  }

  get configured(): boolean {
    return this.cookie !== undefined;
  }

  setCredential(credential: string): void {
    const nextCredential = credential.trim() || undefined;
    if (nextCredential !== this.cookie) {
      this.accountGeneration++;
      this.requestScheduler.cancelAll();
      this.metadataCache.clear();
      this.likedTrackIdsCache = undefined;
      this.clearSnapshotCaches();
    }
    this.cookie = nextCredential;
  }

  clearCredential(): void {
    this.accountGeneration++;
    this.requestScheduler.cancelAll();
    this.cookie = undefined;
    this.metadataCache.clear();
    this.likedTrackIdsCache = undefined;
    this.clearSnapshotCaches();
  }

  async createQr(): Promise<{ key: string; qrImage: string }> {
    const keyResponse = await this.api.login_qr_key({})
    const key = parseQrKeyResponse(keyResponse)
    const imageResponse = await this.api.login_qr_create({ key, qrimg: true })
    return { key, qrImage: parseQrImageResponse(imageResponse) }
  }

  async checkQr(key: string): Promise<QrLoginCheckResult> {
    return parseQrCheckResponse(await this.api.login_qr_check({ key }))
  }

  async verifyCredential(credential: string): Promise<boolean> {
    return (await this.verifyCredentialStatus(credential)) === 'authorized'
  }

  async verifyCredentialStatus(credential: string): Promise<CredentialVerificationStatus> {
    try {
      return parseLoginStatusResponse(
        await this.api.login_status({ cookie: credential }),
      ) ? 'authorized' : 'expired'
    } catch {
      return 'unavailable'
    }
  }

  async logout(): Promise<void> {
    const cookie = this.cookie
    try {
      if (cookie) {
        await this.api.logout({ cookie })
      }
    } finally {
      this.clearCredential()
    }
  }

  async searchTracks(queryInput: string, pageInput: PageRequest): Promise<Page<TrackSummary>> {
    const query = normalizeSearchQuery(queryInput);
    const page = normalizePageRequest(pageInput);
    this.requireCookie();
    const search = this.api.search;
    if (!search) throw this.libraryApiUnavailable();
    try {
      const result = parseSearchPage(
        await search({
          keywords: query,
          type: 1,
          offset: page.offset,
          limit: page.limit,
        }),
        page,
      );
      // 搜索接口经常省略封面，只为当前页缺图歌曲批量补齐元数据。
      const missing = result.items.filter((track) => !track.artworkUrl);
      if (missing.length > 0) {
        try {
          const details = parseTrackSummaries(await this.api.song_detail({ ids: missing.map((track) => track.id).join(',') }));
          const artwork = new Map(details.map((track) => [track.id, track.artworkUrl]));
          result.items = result.items.map((track) => {
            const artworkUrl = track.artworkUrl ?? artwork.get(track.id);
            return artworkUrl ? { ...track, artworkUrl } : track;
          });
        } catch {
          // 封面补齐失败仍保留可用搜索结果。
        }
      }
      this.rememberTracks(result.items);
      return result;
    } catch (error) {
      throw this.libraryError(error, 'search');
    }
  }

  async searchArtists(queryInput: string, pageInput: PageRequest): Promise<Page<ArtistSummary>> {
    const query = normalizeSearchQuery(queryInput)
    const page = normalizePageRequest(pageInput)
    this.requireCookie()
    const search = this.api.search
    if (!search) throw this.libraryApiUnavailable()
    try {
      return parseArtistSearchPage(
        await search({ keywords: query, type: 100, offset: page.offset, limit: page.limit }),
        page,
      )
    } catch (error) {
      throw this.libraryError(error, 'artist search')
    }
  }

  async searchAlbums(queryInput: string, pageInput: PageRequest): Promise<Page<AlbumSummary>> {
    const query = normalizeSearchQuery(queryInput)
    const page = normalizePageRequest(pageInput)
    this.requireCookie()
    const search = this.api.search
    if (!search) throw this.libraryApiUnavailable()
    try {
      return parseAlbumSearchPage(
        await search({ keywords: query, type: 10, offset: page.offset, limit: page.limit }),
        page,
      )
    } catch (error) {
      throw this.libraryError(error, 'album search')
    }
  }

  async getArtist(artistIdInput: string, pageInput: PageRequest) {
    const artistId = normalizeTrackId(artistIdInput)
    const page = normalizePageRequest(pageInput)
    if (!this.api.artists) throw new BridgeError('NETEASE_REQUEST_FAILED', 'Artist detail is unavailable', { httpStatus: 501 })
    try {
      const result = parseArtistDetail(await this.api.artists({ id: artistId, cookie: this.cookie }), page)
      this.rememberTracks(result.tracks.items)
      return result
    } catch (error) {
      throw this.libraryError(error, 'artist detail')
    }
  }

  async getAlbum(albumIdInput: string, pageInput: PageRequest) {
    const albumId = normalizeTrackId(albumIdInput)
    const page = normalizePageRequest(pageInput)
    if (!this.api.album) throw new BridgeError('NETEASE_REQUEST_FAILED', 'Album detail is unavailable', { httpStatus: 501 })
    try {
      const result = parseAlbumDetail(await this.api.album({ id: albumId, cookie: this.cookie }), page)
      this.rememberTracks(result.tracks.items)
      return result
    } catch (error) {
      throw this.libraryError(error, 'album detail')
    }
  }

  async getLikedTracks(pageInput: PageRequest): Promise<Page<TrackSummary>> {
    const page = normalizePageRequest(pageInput);
    const cookie = this.requireCookie();
    try {
      const songDetail = this.api.song_detail;
      if (!songDetail) throw this.libraryApiUnavailable();
      const ids = await this.getLikedTrackIds(cookie);
      const selectedIds = ids.slice(page.offset, page.offset + page.limit);
      if (selectedIds.length === 0) return pageOf([], page, ids.length);
      const response = await songDetail({ ids: selectedIds.join(','), cookie });
      const result = pageOf(orderTrackSummariesByIds(parseTrackSummaries(response), selectedIds), page, ids.length);
      this.rememberTracks(result.items);
      return result;
    } catch (error) {
      throw this.libraryError(error, 'liked tracks');
    }
  }

  private async getLikedPlaylistTrackIds(accountId: string, cookie: string): Promise<string[]> {
    const userPlaylist = this.api.user_playlist;
    const playlistDetail = this.api.playlist_detail;
    if (!userPlaylist || !playlistDetail) throw this.libraryApiUnavailable();
    const likedPlaylistId = parseLikedPlaylistId(await userPlaylist({
      uid: accountId,
      limit: MAX_LIBRARY_PAGE_LIMIT,
      offset: 0,
      cookie,
    }));
    const detail = await playlistDetail({ id: likedPlaylistId, cookie });
    return parsePlaylistTrackIds(detail) ?? [];
  }

  async isTrackLiked(trackIdInput: string): Promise<{ liked: boolean }> {
    const trackId = normalizeTrackId(trackIdInput);
    const cookie = this.requireCookie();
    try {
      const ids = await this.getLikedTrackIds(cookie);
      return { liked: ids.includes(trackId) };
    } catch (error) {
      throw this.libraryError(error, 'track like status');
    }
  }

  async likeTrack(trackIdInput: string, liked: boolean): Promise<{ liked: boolean }> {
    const trackId = normalizeTrackId(trackIdInput);
    const cookie = this.requireCookie();
    const songLike = this.api.song_like;
    if (!songLike) throw this.libraryApiUnavailable();
    try {
      const response = await songLike({ id: trackId, like: liked, cookie });
      assertTrackLikeMutationSucceeded(response);
      this.updateLikedTrackIdsCache(trackId, liked);
      return { liked };
    } catch (error) {
      throw this.libraryError(error, 'track like');
    }
  }

  async getUserPlaylists(): Promise<readonly PlaylistSummary[]> {
    const cookie = this.requireCookie();
    try {
      const accountId = await this.getAccountId(cookie);
      const userPlaylist = this.api.user_playlist;
      if (!userPlaylist) throw this.libraryApiUnavailable();
      return parsePlaylistSummaries(
        await userPlaylist({
          uid: accountId,
          limit: MAX_LIBRARY_PAGE_LIMIT,
          offset: 0,
          cookie,
        }),
      );
    } catch (error) {
      throw this.libraryError(error, 'user playlists');
    }
  }

  async getPublicAccountProfile(): Promise<PublicAccountProfile> {
    const cookie = this.requireCookie();
    const userAccount = this.api.user_account;
    if (!userAccount) throw this.libraryApiUnavailable();
    try {
      return parsePublicAccountProfile(await userAccount({ cookie }));
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError(
        'ACCOUNT_PROFILE_UNAVAILABLE',
        'NetEase account profile request failed',
        { cause: error, httpStatus: 503 },
      );
    }
  }

  async getDailyRecommendations(): Promise<DailyRecommendationsSnapshot> {
    const cookie = this.requireCookie();
    const recommendSongs = this.api.recommend_songs;
    if (!recommendSongs) throw this.libraryApiUnavailable();
    const dayKey = localDayKey();
    try {
      const result = parseDailyRecommendations(
        await recommendSongs({ cookie, afresh: false }),
        dayKey,
      );
      this.rememberTracks(result.tracks);
      return result;
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError(
        'DAILY_RECOMMENDATIONS_UNAVAILABLE',
        'NetEase daily recommendations request failed',
        { cause: error, httpStatus: 503 },
      );
    }
  }

  async getPlaylist(
    playlistIdInput: string,
    pageInput: PageRequest,
  ): Promise<PlaylistDetail> {
    const playlistId = normalizeTrackId(playlistIdInput);
    if (playlistId.length > 128) throw new BridgeError('BAD_REQUEST', '歌单ID无效');
    const page = normalizePageRequest(pageInput);
    const cookie = this.requireCookie();
    const generation = this.accountGeneration;
    const groupKey = `${generation}:${playlistId}`;
    if (this.playlistReadCount >= this.maximumPlaylistReadSubscribers) throw new BridgeError('NETEASE_REQUEST_FAILED', '读取订阅预算已满');
    let group = this.playlistReadGroups.get(groupKey);
    if (!group) {
      group = { count: 0, acceptedPageScope: this.playlistBases.get(playlistId)?.pageScope };
      this.playlistReadGroups.set(groupKey, group);
    }
    group.count++; this.playlistReadCount++;
    try {
      const base = await this.readPlaylistBase(playlistId, cookie, generation);
      assertLibraryReadCurrent();
      if (generation !== this.accountGeneration || group.acceptedPageScope !== base.pageScope) throw libraryReadCancelled();
      const reload = currentLibraryRead()?.cacheMode === 'reload';
      const tracks = await this.snapshotReads.read(`page:${generation}:${playlistId}:${base.pageScope}:${page.offset}:${page.limit}:${reload}`, () => generation === this.accountGeneration, async () => {
        let response: unknown;
        if (base.trackIds !== undefined) {
          const selectedIds = base.trackIds.slice(page.offset, page.offset + page.limit);
          response = selectedIds.length ? await this.api.song_detail({ ids: selectedIds.join(','), cookie }) : { body: { code: 200, songs: [] } };
          assertLibraryReadCurrent();
          const items = orderTrackSummariesByIds(parseTrackSummaries(response), selectedIds);
          return { items, offset: page.offset, limit: page.limit, total: base.trackIds.length, hasMore: page.offset + page.limit < base.trackIds.length };
        }
        const playlistTrackAll = this.api.playlist_track_all;
        if (!playlistTrackAll) throw this.libraryApiUnavailable();
        response = await playlistTrackAll({ id: playlistId, limit: page.limit, offset: page.offset, cookie });
        assertLibraryReadCurrent();
        return parsePlaylistTrackPage(response, page, base.header.trackCount);
      });
      assertLibraryReadCurrent();
      if (generation !== this.accountGeneration) throw libraryReadCancelled();
      // 不撤其他订阅者的等待；实际返回后拒绝给已接受的新base写旧页元数据。
      if (group.acceptedPageScope !== base.pageScope) throw libraryReadCancelled();
      this.rememberTracks(tracks.items);
      return { ...base.header, ...(base.snapshotVersion ? { snapshotVersion: base.snapshotVersion } : {}), tracks: { ...tracks, items: tracks.items.map(cloneTrackMetadata) } };
    } catch (error) {
      throw this.libraryError(error, 'playlist detail');
    } finally {
      group.count--; this.playlistReadCount--;
      if (!group.count && this.playlistReadGroups.get(groupKey) === group) this.playlistReadGroups.delete(groupKey);
    }
  }

  async getTrack(trackIdInput: string, options: NeteaseRequestOptions = {}): Promise<TrackMetadata> {
    const trackId = normalizeTrackId(trackIdInput);
    const cookie = this.requireCookie();
    const generation = this.accountGeneration;
    const requestOptions: NeteaseRequestOptions = { ...options, priority: options.priority ?? 'playback' };
    const isCurrent = () => generation === this.accountGeneration;
    assertNeteaseRequestCurrent(requestOptions, isCurrent);
    const cached = this.cachedTrack(trackId);
    if (cached) return cached;
    try {
      const response = await this.api.song_detail({
        ids: trackId,
        cookie,
      }, requestOptions);
      assertNeteaseRequestCurrent(requestOptions, isCurrent);
      const metadata = parseTrackMetadata(response, trackId);
      this.rememberTrack(metadata);
      return cloneTrackMetadata(metadata);
    } catch (error) {
      throw this.playbackError(error, '网易云歌曲元数据请求失败', { trackId });
    }
  }

  async getLyrics(trackIdInput: string, options: NeteaseRequestOptions = {}) {
    const trackId = normalizeTrackId(trackIdInput);
    const cookie = this.requireCookie();
    const generation = this.accountGeneration;
    const isCurrent = () => generation === this.accountGeneration;
    assertNeteaseRequestCurrent(options, isCurrent);
    const lyricNew = this.api.lyric_new;
    if (!lyricNew) throw this.libraryApiUnavailable();
    try {
      const response = await lyricNew({ id: trackId, cookie }, { ...options, priority: options.priority ?? 'background' });
      assertNeteaseRequestCurrent(options, isCurrent);
      return parseLyricsResponse(response);
    } catch (error) {
      throw this.playbackError(error, '网易云歌词请求失败');
    }
  }

  async resolveStream(
    trackIdInput: string,
    quality: QualityLevel,
    options: NeteaseRequestOptions = {},
  ): Promise<ResolvedAudioStream> {
    const trackId = normalizeTrackId(trackIdInput);
    const cookie = this.requireCookie();
    const generation = this.accountGeneration;
    const requestOptions: NeteaseRequestOptions = { ...options, priority: options.priority ?? 'playback' };
    const isCurrent = () => generation === this.accountGeneration;
    assertNeteaseRequestCurrent(requestOptions, isCurrent);
    try {
      try {
        await waitNeteaseRequest(this.prepareApiRuntime(), requestOptions, isCurrent, this.requestScheduler.timeoutMs);
      } catch (error) {
        if (error instanceof BridgeError && (error.code !== 'NETEASE_REQUEST_FAILED' || error.details?.reason === 'request-timeout')) throw error;
        throw new BridgeError('NETEASE_REQUEST_FAILED', '网易云音频服务准备失败', { cause: error, httpStatus: 502, details: { reason: 'runtime-prepare' } });
      }
      assertNeteaseRequestCurrent(requestOptions, isCurrent);
      // 不传unblock、source、代理、随机IP或替代来源参数。
      const response = await this.api.song_url_v1({
        id: trackId,
        level: quality,
        cookie,
      }, requestOptions);
      assertNeteaseRequestCurrent(requestOptions, isCurrent);
      return parseResolvedAudioStream(response, trackId, quality);
    } catch (error) {
      throw this.playbackError(error, '网易云音频URL请求失败', { trackId, quality });
    }
  }

  private requireCookie(): string {
    assertLibraryReadCurrent();
    if (!this.cookie) {
      throw new BridgeError(
        'NETEASE_NOT_CONFIGURED',
        'NETEASE_COOKIE is not configured',
        { httpStatus: 503 },
      );
    }
    return this.cookie;
  }

  private playbackError(error: unknown, message: string, details: Record<string, unknown> = {}): BridgeError {
    if (error instanceof BridgeError && (error.code !== 'NETEASE_REQUEST_FAILED' || error.details?.reason !== undefined)) return error;
    return new BridgeError('NETEASE_REQUEST_FAILED', message, { cause: error, httpStatus: error instanceof BridgeError ? error.httpStatus : 502, details: { ...details, reason: 'upstream-response' } });
  }

  private cachedTrack(trackId: string): TrackMetadata | undefined {
    const cached = this.metadataCache.get(trackId);
    if (!cached) return undefined;
    if (cached.expiresAt <= this.now()) {
      this.metadataCache.delete(trackId);
      return undefined;
    }
    this.metadataCache.delete(trackId);
    this.metadataCache.set(trackId, cached);
    return cloneTrackMetadata(cached.metadata);
  }

  private rememberTracks(tracks: readonly TrackSummary[]): void {
    for (const track of tracks) this.rememberTrack(track);
  }

  private rememberTrack(track: TrackSummary | TrackMetadata): void {
    assertLibraryReadCurrent();
    const metadata = cloneTrackMetadata(track);
    this.metadataCache.delete(metadata.id);
    this.metadataCache.set(metadata.id, {
      metadata,
      expiresAt: this.now() + this.metadataCacheTtlMs,
    });
    while (this.metadataCache.size > this.metadataCacheMaxEntries) {
      const oldest = this.metadataCache.keys().next().value;
      if (oldest === undefined) break;
      this.metadataCache.delete(oldest);
    }
  }

  private async getAccountId(cookie: string): Promise<string> {
    assertLibraryReadCurrent();
    const generation = this.accountGeneration;
    if (cookie !== this.cookie) throw libraryReadCancelled();
    const reload = currentLibraryRead()?.cacheMode === 'reload';
    const now = this.now();
    if (!reload && this.accountCache && this.accountCache.bornAt <= now && now < this.accountCache.expiresAt) return this.accountCache.id;
    return this.snapshotReads.read(`account:${generation}:${reload}`, () => generation === this.accountGeneration, async () => {
      const ticket = {}; this.latestAccountLoad = ticket;
      try {
        const userAccount = this.api.user_account;
        if (!userAccount) throw this.libraryApiUnavailable();
        const id = parseAccountId(await userAccount({ cookie }));
        assertLibraryReadCurrent();
        if (this.latestAccountLoad !== ticket) throw libraryReadCancelled();
        if (id.length > 128) throw new BridgeError('NETEASE_REQUEST_FAILED', '账户ID无效');
        const bornAt = this.now();
        this.accountCache = { id, bornAt, expiresAt: bornAt + this.snapshotCacheTtlMs };
        return id;
      } finally { if (this.latestAccountLoad === ticket) this.latestAccountLoad = undefined; }
    });
  }

  private clearSnapshotCaches(): void {
    this.snapshotReads.clear(); this.playlistBases.clear(); this.latestBaseLoads.clear(); this.playlistCacheBytes = 0; this.accountCache = undefined; this.latestAccountLoad = undefined;
  }

  private async readPlaylistBase(playlistId: string, cookie: string, generation: number): Promise<PlaylistBase> {
    assertLibraryReadCurrent();
    const reload = currentLibraryRead()?.cacheMode === 'reload';
    const cached = this.playlistBases.get(playlistId);
    const now = this.now();
    if (!reload && cached && cached.bornAt <= now && now < cached.expiresAt) {
      this.playlistBases.delete(playlistId); this.playlistBases.set(playlistId, cached); return cached;
    }
    return this.snapshotReads.read(`base:${generation}:${playlistId}:${reload}`, () => generation === this.accountGeneration, async () => {
      const ticket = {};
      this.latestBaseLoads.set(playlistId, ticket);
      try {
        const playlistDetail = this.api.playlist_detail;
        if (!playlistDetail) throw this.libraryApiUnavailable();
        const response = await playlistDetail({ id: playlistId, cookie });
        assertLibraryReadCurrent();
        if (this.latestBaseLoads.get(playlistId) !== ticket) throw libraryReadCancelled();
        const header = parsePlaylistDetailHeader(response, playlistId);
        if (header.id !== playlistId || header.id.length > 128 || header.name.length > 512 || (header.description?.length ?? 0) > 4096 || !Number.isSafeInteger(header.trackCount) || header.trackCount < 0 || header.trackCount > 1_000_000) throw new BridgeError('NETEASE_REQUEST_FAILED', '歌单快照header无效');
        const headerBytes = 256 + 2 * (playlistId.length + header.id.length + header.name.length + (header.description?.length ?? 0) + (header.artworkUrl?.length ?? 0));
        const limit = Math.min(this.playlistCacheMaxEntryBytes, this.playlistCacheMaxBytes);
        if (headerBytes + 32 > limit) throw new BridgeError('NETEASE_REQUEST_FAILED', '歌单快照字节预算已满');
        const ids = parsePlaylistTrackIds(response, limit - headerBytes);
        if (ids !== undefined && ids.length !== header.trackCount) throw new BridgeError('NETEASE_REQUEST_FAILED', '歌单完整曲目ID与总数不一致');
        const previous = this.playlistBases.get(playlistId);
        const snapshotVersion = ids === undefined ? undefined : previous && samePlaylistBase(previous, header, ids) && previous.snapshotVersion ? previous.snapshotVersion : randomUUID();
        const bytes = headerBytes + 32 + (ids?.reduce((sum, id) => sum + 32 + id.length * 2, 0) ?? 0) + 128;
        if (bytes > limit) throw new BridgeError('NETEASE_REQUEST_FAILED', '歌单快照字节预算已满');
        const bornAt = this.now();
        const base: PlaylistBase = Object.freeze({ header: Object.freeze(header), ...(ids === undefined ? {} : { trackIds: Object.freeze(ids) }), ...(snapshotVersion ? { snapshotVersion } : {}), pageScope: snapshotVersion ?? randomUUID(), bornAt, expiresAt: bornAt + this.snapshotCacheTtlMs, bytes });
        assertLibraryReadCurrent();
        if (this.latestBaseLoads.get(playlistId) !== ticket || generation !== this.accountGeneration) throw libraryReadCancelled();
        if (previous) { this.playlistBases.delete(playlistId); this.playlistCacheBytes -= previous.bytes; }
        while (this.playlistBases.size >= this.playlistCacheMaxEntries || this.playlistCacheBytes + bytes > this.playlistCacheMaxBytes) {
          const oldest = this.playlistBases.keys().next().value;
          if (oldest === undefined) break;
          this.playlistCacheBytes -= this.playlistBases.get(oldest)!.bytes; this.playlistBases.delete(oldest);
        }
        this.playlistBases.set(playlistId, base); this.playlistCacheBytes += bytes;
        const group = this.playlistReadGroups.get(`${generation}:${playlistId}`);
        if (group) group.acceptedPageScope = base.pageScope;
        return base;
      } finally { if (this.latestBaseLoads.get(playlistId) === ticket) this.latestBaseLoads.delete(playlistId); }
    });
  }

  private async getLikedTrackIds(cookie: string): Promise<readonly string[]> {
    const cached = this.likedTrackIdsCache;
    if (cached && cached.expiresAt > this.now()) return cached.ids;
    this.likedTrackIdsCache = undefined;
    const accountId = await this.getAccountId(cookie);
    const ids = this.api.likelist
      ? parseLikedTrackIds(await this.api.likelist({ uid: accountId, cookie }))
      : await this.getLikedPlaylistTrackIds(accountId, cookie);
    assertLibraryReadCurrent();
    this.likedTrackIdsCache = {
      ids: [...ids],
      idSet: new Set(ids),
      expiresAt: this.now() + LIKED_TRACK_IDS_CACHE_TTL_MS,
    };
    return this.likedTrackIdsCache.ids;
  }

  private updateLikedTrackIdsCache(trackId: string, liked: boolean): void {
    const cached = this.likedTrackIdsCache;
    if (!cached || cached.expiresAt <= this.now()) {
      this.likedTrackIdsCache = undefined;
      return;
    }
    const idSet = new Set(cached.idSet);
    if (liked) idSet.add(trackId);
    else idSet.delete(trackId);
    const ids = liked
      ? [trackId, ...cached.ids.filter((id) => id !== trackId)]
      : cached.ids.filter((id) => id !== trackId);
    this.likedTrackIdsCache = { ids, idSet, expiresAt: cached.expiresAt };
  }

  private libraryApiUnavailable(): BridgeError {
    return new BridgeError(
      'NETEASE_REQUEST_FAILED',
      'NetEase library operation is unavailable',
      { httpStatus: 502 },
    );
  }

  private libraryError(error: unknown, operation: string): BridgeError {
    if (error instanceof BridgeError) return error;
    return new BridgeError(
      'NETEASE_REQUEST_FAILED',
      `NetEase ${operation} request failed`,
      { cause: error, httpStatus: 502 },
    );
  }
}

function pageOf<T>(items: readonly T[], page: PageRequest, total: number): Page<T> {
  const boundedTotal = Math.max(total, page.offset + items.length);
  return {
    items,
    offset: page.offset,
    limit: page.limit,
    total: boundedTotal,
    hasMore: page.offset + items.length < boundedTotal,
  };
}
