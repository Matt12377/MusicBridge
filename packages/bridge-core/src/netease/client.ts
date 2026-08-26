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
    ...(track.artworkUrl !== undefined ? { artworkUrl: track.artworkUrl } : {}),
  };
}

function localDayKey(now = Date.now()): string {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

interface NeteaseApiModule {
  song_detail(params: Record<string, unknown>): ApiResponse;
  song_url_v1(params: Record<string, unknown>): ApiResponse;
  login_qr_key(params: Record<string, unknown>): ApiResponse;
  login_qr_create(params: Record<string, unknown>): ApiResponse;
  login_qr_check(params: Record<string, unknown>): ApiResponse;
  login_status(params: Record<string, unknown>): ApiResponse;
  logout(params: Record<string, unknown>): ApiResponse;
  search?(params: Record<string, unknown>): ApiResponse;
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
  lyric_new?(params: Record<string, unknown>): ApiResponse;
}

function loadApi(): NeteaseApiModule {
  enforceNeteaseSafetyEnvironment(process.env);
  const require = createRequire(import.meta.url);
  return require('@neteasecloudmusicapienhanced/api') as NeteaseApiModule;
}

export class NeteaseClient implements NeteasePort, QrLoginProvider {
  private cookie: string | undefined;
  private readonly api: NeteaseApiModule;
  private readonly prepareApiRuntime: () => Promise<void>;
  private readonly metadataCache = new Map<string, CachedTrackMetadata>();
  private readonly metadataCacheMaxEntries: number;
  private readonly metadataCacheTtlMs: number;
  private readonly now: () => number;
  private likedTrackIdsCache: CachedLikedTrackIds | undefined;

  constructor(
    cookie: string | undefined,
    api?: NeteaseApiModule,
    prepareApiRuntime?: () => Promise<void>,
    options: NeteaseClientOptions = {},
  ) {
    this.cookie = cookie?.trim() || undefined;
    this.api = api ?? loadApi();
    this.prepareApiRuntime =
      prepareApiRuntime ?? (api === undefined ? ensureNeteaseApiRuntime : async () => undefined);
    this.metadataCacheMaxEntries = boundedMetadataCacheEntries(options.metadataCacheMaxEntries);
    this.metadataCacheTtlMs = boundedMetadataCacheTtlMs(options.metadataCacheTtlMs);
    this.now = options.now ?? Date.now;
  }

  get configured(): boolean {
    return this.cookie !== undefined;
  }

  setCredential(credential: string): void {
    const nextCredential = credential.trim() || undefined;
    if (nextCredential !== this.cookie) {
      this.metadataCache.clear();
      this.likedTrackIdsCache = undefined;
    }
    this.cookie = nextCredential;
  }

  clearCredential(): void {
    this.cookie = undefined;
    this.metadataCache.clear();
    this.likedTrackIdsCache = undefined;
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
    if (!this.api.artist_detail) throw new BridgeError('NETEASE_REQUEST_FAILED', 'Artist detail is unavailable', { httpStatus: 501 })
    try {
      const result = parseArtistDetail(await this.api.artist_detail({ id: artistId, cookie: this.cookie }), page)
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
    const page = normalizePageRequest(pageInput);
    const cookie = this.requireCookie();
    try {
      const playlistDetail = this.api.playlist_detail;
      if (!playlistDetail) throw this.libraryApiUnavailable();
      const playlistDetailResponse = await playlistDetail({ id: playlistId, cookie });
      const header = parsePlaylistDetailHeader(
        playlistDetailResponse,
        playlistId,
      );
      const trackIds = parsePlaylistTrackIds(playlistDetailResponse);
      let trackResponse: unknown;
      if (trackIds !== undefined) {
        const selectedIds = trackIds.slice(page.offset, page.offset + page.limit);
        trackResponse = selectedIds.length === 0
          ? { body: { code: 200, songs: [] } }
          : await this.api.song_detail({ ids: selectedIds.join(','), cookie });
      } else {
        const playlistTrackAll = this.api.playlist_track_all;
        if (!playlistTrackAll) throw this.libraryApiUnavailable();
        trackResponse = await playlistTrackAll({
          id: playlistId,
          limit: page.limit,
          offset: page.offset,
          cookie,
        });
      }
      const tracks = parsePlaylistTrackPage(trackResponse, page, header.trackCount);
      this.rememberTracks(tracks.items);
      return { ...header, tracks };
    } catch (error) {
      throw this.libraryError(error, 'playlist detail');
    }
  }

  async getTrack(trackIdInput: string): Promise<TrackMetadata> {
    const trackId = normalizeTrackId(trackIdInput);
    const cookie = this.requireCookie();
    const cached = this.cachedTrack(trackId);
    if (cached) return cached;
    try {
      const response = await this.api.song_detail({
        ids: trackId,
        cookie,
      });
      const metadata = parseTrackMetadata(response, trackId);
      this.rememberTrack(metadata);
      return cloneTrackMetadata(metadata);
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError(
        'NETEASE_REQUEST_FAILED',
        'NetEase song metadata request failed',
        { cause: error, httpStatus: 502, details: { trackId } },
      );
    }
  }

  async getLyrics(trackIdInput: string) {
    const trackId = normalizeTrackId(trackIdInput);
    const cookie = this.requireCookie();
    const lyricNew = this.api.lyric_new;
    if (!lyricNew) throw this.libraryApiUnavailable();
    try {
      return parseLyricsResponse(await lyricNew({ id: trackId, cookie }));
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError(
        'NETEASE_REQUEST_FAILED',
        'NetEase lyrics request failed',
        { cause: error, httpStatus: 502 },
      );
    }
  }

  async resolveStream(
    trackIdInput: string,
    quality: QualityLevel,
  ): Promise<ResolvedAudioStream> {
    const trackId = normalizeTrackId(trackIdInput);
    const cookie = this.requireCookie();
    try {
      await this.prepareApiRuntime();
      // Intentionally no `unblock`, `source`, proxy, randomIP or match parameter.
      const response = await this.api.song_url_v1({
        id: trackId,
        level: quality,
        cookie,
      });
      return parseResolvedAudioStream(response, trackId, quality);
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError(
        'NETEASE_REQUEST_FAILED',
        'NetEase audio URL request failed',
        { cause: error, httpStatus: 502, details: { trackId, quality } },
      );
    }
  }

  private requireCookie(): string {
    if (!this.cookie) {
      throw new BridgeError(
        'NETEASE_NOT_CONFIGURED',
        'NETEASE_COOKIE is not configured',
        { httpStatus: 503 },
      );
    }
    return this.cookie;
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
    const userAccount = this.api.user_account;
    if (!userAccount) throw this.libraryApiUnavailable();
    return parseAccountId(await userAccount({ cookie }));
  }

  private async getLikedTrackIds(cookie: string): Promise<readonly string[]> {
    const cached = this.likedTrackIdsCache;
    if (cached && cached.expiresAt > this.now()) return cached.ids;
    this.likedTrackIdsCache = undefined;
    const accountId = await this.getAccountId(cookie);
    const ids = this.api.likelist
      ? parseLikedTrackIds(await this.api.likelist({ uid: accountId, cookie }))
      : await this.getLikedPlaylistTrackIds(accountId, cookie);
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
