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
  parsePlaylistDetailHeader,
  parsePlaylistTrackIds,
  parsePlaylistSummaries,
  parsePlaylistTrackPage,
  parseSearchPage,
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
  likelist?(params: Record<string, unknown>): ApiResponse;
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

  constructor(
    cookie: string | undefined,
    api?: NeteaseApiModule,
    prepareApiRuntime?: () => Promise<void>,
  ) {
    this.cookie = cookie?.trim() || undefined;
    this.api = api ?? loadApi();
    this.prepareApiRuntime =
      prepareApiRuntime ?? (api === undefined ? ensureNeteaseApiRuntime : async () => undefined);
  }

  get configured(): boolean {
    return this.cookie !== undefined;
  }

  setCredential(credential: string): void {
    this.cookie = credential.trim() || undefined;
  }

  clearCredential(): void {
    this.cookie = undefined;
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
    const cookie = this.requireCookie();
    const search = this.api.search;
    if (!search) throw this.libraryApiUnavailable();
    try {
      return parseSearchPage(
        await search({
          keywords: query,
          type: 1,
          offset: page.offset,
          limit: page.limit,
          cookie,
        }),
        page,
      );
    } catch (error) {
      throw this.libraryError(error, 'search');
    }
  }

  async getLikedTracks(pageInput: PageRequest): Promise<Page<TrackSummary>> {
    const page = normalizePageRequest(pageInput);
    const cookie = this.requireCookie();
    try {
      const accountId = await this.getAccountId(cookie);
      const userPlaylist = this.api.user_playlist;
      const playlistDetail = this.api.playlist_detail;
      const songDetail = this.api.song_detail;
      if (!userPlaylist || !playlistDetail || !songDetail) throw this.libraryApiUnavailable();
      const likedPlaylistId = parseLikedPlaylistId(await userPlaylist({
        uid: accountId,
        limit: MAX_LIBRARY_PAGE_LIMIT,
        offset: 0,
        cookie,
      }));
      const detail = await playlistDetail({ id: likedPlaylistId, cookie });
      const ids = parsePlaylistTrackIds(detail) ?? [];
      const selectedIds = ids.slice(page.offset, page.offset + page.limit);
      if (selectedIds.length === 0) return pageOf([], page, ids.length);
      const response = await songDetail({ ids: selectedIds.join(','), cookie });
      return pageOf(orderTrackSummariesByIds(parseTrackSummaries(response), selectedIds), page, ids.length);
    } catch (error) {
      throw this.libraryError(error, 'liked tracks');
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
      return parseDailyRecommendations(
        await recommendSongs({ cookie, afresh: false }),
        dayKey,
      );
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
      return { ...header, tracks };
    } catch (error) {
      throw this.libraryError(error, 'playlist detail');
    }
  }

  async getTrack(trackIdInput: string): Promise<TrackMetadata> {
    const trackId = normalizeTrackId(trackIdInput);
    const cookie = this.requireCookie();
    try {
      const response = await this.api.song_detail({
        ids: trackId,
        cookie,
      });
      return parseTrackMetadata(response, trackId);
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

  private async getAccountId(cookie: string): Promise<string> {
    const userAccount = this.api.user_account;
    if (!userAccount) throw this.libraryApiUnavailable();
    return parseAccountId(await userAccount({ cookie }));
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
