import { BridgeError } from '../shared/errors.js';
import type {
  DailyRecommendationTrack,
  DailyRecommendationsSnapshot,
  ArtistDetail,
  ArtistSummary,
  AlbumDetail,
  AlbumSummary,
  Page,
  PageRequest,
  PlaylistDetail,
  PlaylistSummary,
  PublicAccountProfile,
  TrackSummary,
} from '@music-bridge/contracts';
import { resolveNeteaseAudioUrl } from './policy.js';
import type {
  QualityLevel,
  ResolvedAudioStream,
  TrackMetadata,
} from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function bodyOf(response: unknown): Record<string, unknown> {
  if (!isRecord(response)) {
    throw new BridgeError('NETEASE_REQUEST_FAILED', 'Invalid NetEase response', {
      httpStatus: 502,
    });
  }
  const body = response.body;
  return isRecord(body) ? body : response;
}

function numeric(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function boundedPublicText(value: unknown, maximumLength: number): string | undefined {
  const text = stringValue(value)?.trim();
  if (!text || [...text].length > maximumLength) return undefined;
  return text;
}

function safeArtworkUrl(value: unknown): string | undefined {
  const raw = stringValue(value);
  if (!raw || raw.length > 2_048) return undefined;
  try {
    const url = new URL(raw);
    const hostname = url.hostname.toLowerCase();
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      (hostname !== 'music.126.net' && !hostname.endsWith('.music.126.net')) ||
      url.username !== '' ||
      url.password !== '' ||
      url.hash !== ''
    ) {
      return undefined;
    }
    // 网易云部分 Provider 接口仍返回 http 图片地址；只对已白名单的
    // NetEase 图片域名升级为 HTTPS，避免放宽到任意上游 URL。
    url.protocol = 'https:';
    return url.toString();
  } catch {
    return undefined;
  }
}

function safeId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value) && value !== '0') {
    return value;
  }
  return undefined;
}

function trackSummaryFromRecord(value: unknown): TrackSummary | undefined {
  if (!isRecord(value)) return undefined;
  const id = safeId(value.id);
  if (!id) return undefined;
  const title = stringValue(value.name) ?? `NetEase Track ${id}`;
  const artistRows = Array.isArray(value.ar)
    ? value.ar
    : Array.isArray(value.artists)
      ? value.artists
      : [];
  const artists = artistRows
    .map((artist) => (isRecord(artist) ? stringValue(artist.name) : undefined))
    .filter((artist): artist is string => artist !== undefined);
  const albumRecord = isRecord(value.al)
    ? value.al
    : isRecord(value.album)
      ? value.album
      : undefined;
  const album = albumRecord ? stringValue(albumRecord.name) : undefined;
  const durationMs = numeric(value.dt ?? value.duration);
  const artworkUrl = albumRecord
    ? safeArtworkUrl(albumRecord.picUrl ?? albumRecord.blurPicUrl ?? albumRecord.coverImgUrl)
    : safeArtworkUrl(value.artworkUrl);

  return {
    id,
    title,
    artists: artists.length > 0 ? artists : ['Unknown Artist'],
    album: album ?? 'Unknown Album',
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(artworkUrl !== undefined ? { artworkUrl } : {}),
  };
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

function responseBodyCode(body: Record<string, unknown>, operation: string): void {
  const data = isRecord(body.data) ? body.data : undefined;
  const result = isRecord(body.result) ? body.result : undefined;
  const code = numeric(body.code) ?? numeric(data?.code) ?? numeric(result?.code);
  if (code === 301 || code === 302) {
    throw new BridgeError('AUTH_EXPIRED', 'Provider session expired', {
      httpStatus: 401,
    });
  }
  if (code !== undefined && code !== 200) {
    throw new BridgeError(
      'NETEASE_REQUEST_FAILED',
      `NetEase ${operation} failed with code ${code}`,
      { httpStatus: 502, details: { code } },
    );
  }
}

export function parseTrackSummaries(response: unknown): TrackSummary[] {
  const body = bodyOf(response);
  responseBodyCode(body, 'library request');
  const result = isRecord(body.result) ? body.result : undefined;
  const rows = Array.isArray(body.songs)
    ? body.songs
    : result && Array.isArray(result.songs)
      ? result.songs
      : [];
  return rows
    .map(trackSummaryFromRecord)
    .filter((item): item is TrackSummary => item !== undefined);
}

export function parseDailyRecommendations(
  response: unknown,
  dayKey: string,
): DailyRecommendationsSnapshot {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) {
    throw new BridgeError('DAILY_RECOMMENDATIONS_UNAVAILABLE', 'Invalid recommendation day', {
      httpStatus: 502,
    });
  }
  const body = bodyOf(response);
  responseBodyCode(body, 'daily recommendations');
  const data = isRecord(body.data) ? body.data : body;
  const rows = Array.isArray(data.dailySongs)
    ? data.dailySongs
    : Array.isArray(body.dailySongs)
      ? body.dailySongs
      : [];
  const reasonRows = Array.isArray(data.recommendReasons)
    ? data.recommendReasons
    : Array.isArray(body.recommendReasons)
      ? body.recommendReasons
      : [];
  const reasons = new Map<string, string>();
  for (const row of reasonRows) {
    if (!isRecord(row)) continue;
    const id = safeId(row.songId ?? row.id);
    const reason = boundedPublicText(row.reason, 120);
    if (id && reason && !reasons.has(id)) reasons.set(id, reason);
  }

  const tracks: DailyRecommendationTrack[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const track = trackSummaryFromRecord(row);
    if (!track || seen.has(track.id)) continue;
    seen.add(track.id);
    const reason = reasons.get(track.id);
    tracks.push({ ...track, ...(reason !== undefined ? { recommendationReason: reason } : {}) });
    if (tracks.length === 50) break;
  }
  return { dayKey, tracks };
}

export function parseSearchPage(
  response: unknown,
  page: PageRequest,
): Page<TrackSummary> {
  const body = bodyOf(response);
  responseBodyCode(body, 'search');
  const result = isRecord(body.result) ? body.result : body;
  const items = parseTrackSummaries(response);
  const total = numeric(result.songCount ?? result.total) ?? page.offset + items.length;
  return pageOf(items, page, total);
}

function artistSummaryFromRecord(value: unknown): ArtistSummary | undefined {
  if (!isRecord(value)) return undefined
  const id = safeId(value.id)
  const name = stringValue(value.name)
  if (!id || !name) return undefined
  const artworkUrl = safeArtworkUrl(value.picUrl ?? value.avatarUrl)
  const albumCount = numeric(value.albumSize ?? value.albumCount)
  const trackCount = numeric(value.musicSize ?? value.trackCount)
  return {
    id,
    name,
    ...(artworkUrl !== undefined ? { artworkUrl } : {}),
    ...(albumCount !== undefined ? { albumCount } : {}),
    ...(trackCount !== undefined ? { trackCount } : {}),
  }
}

function albumSummaryFromRecord(value: unknown): AlbumSummary | undefined {
  if (!isRecord(value)) return undefined
  const id = safeId(value.id)
  const name = stringValue(value.name)
  const artist = isRecord(value.artist) ? value.artist : undefined
  const artistId = safeId(artist?.id ?? value.artistId)
  const artistName = stringValue(artist?.name ?? value.artistName) ?? '未知艺人'
  if (!id || !name) return undefined
  const artworkUrl = safeArtworkUrl(value.picUrl ?? value.blurPicUrl ?? value.coverImgUrl)
  const trackCount = numeric(value.size ?? value.trackCount)
  return {
    id,
    name,
    ...(artistId !== undefined ? { artistId } : {}),
    artistName,
    ...(artworkUrl !== undefined ? { artworkUrl } : {}),
    ...(trackCount !== undefined ? { trackCount } : {}),
  }
}

export function parseArtistSearchPage(
  response: unknown,
  page: PageRequest,
): Page<ArtistSummary> {
  const body = bodyOf(response)
  responseBodyCode(body, 'artist search')
  const result = isRecord(body.result) ? body.result : body
  const rows = Array.isArray(result.artists) ? result.artists : []
  const items = rows.map(artistSummaryFromRecord).filter((item): item is ArtistSummary => item !== undefined)
  const total = numeric(result.artistCount ?? result.total) ?? page.offset + items.length
  return pageOf(items, page, total)
}

export function parseAlbumSearchPage(
  response: unknown,
  page: PageRequest,
): Page<AlbumSummary> {
  const body = bodyOf(response)
  responseBodyCode(body, 'album search')
  const result = isRecord(body.result) ? body.result : body
  const rows = Array.isArray(result.albums) ? result.albums : []
  const items = rows.map(albumSummaryFromRecord).filter((item): item is AlbumSummary => item !== undefined)
  const total = numeric(result.albumCount ?? result.total) ?? page.offset + items.length
  return pageOf(items, page, total)
}

function pageTracksFromRows(rows: readonly unknown[], page: PageRequest): Page<TrackSummary> {
  const tracks = rows.map(trackSummaryFromRecord).filter((item): item is TrackSummary => item !== undefined)
  const items = tracks.slice(page.offset, page.offset + page.limit)
  return pageOf(items, page, tracks.length)
}

export function parseArtistDetail(response: unknown, page: PageRequest): ArtistDetail {
  const body = bodyOf(response)
  responseBodyCode(body, 'artist detail')
  const data = isRecord(body.data) ? body.data : body
  const artist = artistSummaryFromRecord(data.artist ?? body.artist)
  if (!artist) throw new BridgeError('NETEASE_REQUEST_FAILED', 'Artist detail was not returned', { httpStatus: 502 })
  const rows = Array.isArray(data.hotSongs) ? data.hotSongs : Array.isArray(data.songs) ? data.songs : []
  const tracks = pageTracksFromRows(rows, page)
  return { ...artist, ...(artist.trackCount === undefined ? { trackCount: tracks.total } : {}), tracks }
}

export function parseAlbumDetail(response: unknown, page: PageRequest): AlbumDetail {
  const body = bodyOf(response)
  responseBodyCode(body, 'album detail')
  const albumRecord = isRecord(body.album) ? body.album : isRecord(body.data) && isRecord(body.data.album) ? body.data.album : undefined
  const album = albumSummaryFromRecord(albumRecord)
  if (!album) throw new BridgeError('NETEASE_REQUEST_FAILED', 'Album detail was not returned', { httpStatus: 502 })
  const rows = Array.isArray(body.songs) ? body.songs : isRecord(body.data) && Array.isArray(body.data.songs) ? body.data.songs : []
  const tracks = pageTracksFromRows(rows, page)
  return { ...album, ...(album.trackCount === undefined ? { trackCount: tracks.total } : {}), tracks }
}

export function parseLikedTrackIds(response: unknown): string[] {
  const body = bodyOf(response);
  responseBodyCode(body, 'liked tracks');
  const ids = Array.isArray(body.ids) ? body.ids : [];
  return ids
    .map((item) => (isRecord(item) ? item.id : item))
    .map(safeId)
    .filter((id): id is string => id !== undefined);
}

export function parseLikedPlaylistId(response: unknown): string {
  const body = bodyOf(response);
  responseBodyCode(body, 'user playlists');
  const rows = Array.isArray(body.playlist)
    ? body.playlist
    : Array.isArray(body.playlists)
      ? body.playlists
      : [];
  const likedPlaylist = rows.find((value) => (
    isRecord(value) && numeric(value.specialType) === 10
  ));
  const id = likedPlaylist && isRecord(likedPlaylist) ? safeId(likedPlaylist.id) : undefined;
  if (!id) {
    throw new BridgeError('NETEASE_REQUEST_FAILED', 'NetEase native liked playlist was not returned', {
      httpStatus: 502,
    });
  }
  return id;
}

export function orderTrackSummariesByIds(
  tracks: readonly TrackSummary[],
  orderedIds: readonly string[],
): TrackSummary[] {
  const byId = new Map(tracks.map((track) => [track.id, track]));
  return orderedIds
    .map((id) => byId.get(id))
    .filter((track): track is TrackSummary => track !== undefined);
}

export function parseTrackLikeState(response: unknown): { liked: boolean } {
  const body = bodyOf(response);
  responseBodyCode(body, 'track like status');
  const candidates = [body.liked, body.like, body.checkPoint, body.data, body.result];
  for (const value of candidates) {
    if (typeof value === 'boolean') return { liked: value };
    if (isRecord(value)) {
      for (const key of ['liked', 'like', 'checkPoint', 'isLiked']) {
        if (typeof value[key] === 'boolean') return { liked: value[key] };
      }
    }
  }
  throw new BridgeError(
    'NETEASE_REQUEST_FAILED',
    'NetEase track like status response is missing state',
    { httpStatus: 502 },
  );
}

export function assertTrackLikeMutationSucceeded(response: unknown): void {
  const body = bodyOf(response);
  const data = isRecord(body.data) ? body.data : undefined;
  const result = isRecord(body.result) ? body.result : undefined;
  const code = numeric(body.code) ?? numeric(data?.code) ?? numeric(result?.code);
  responseBodyCode(body, 'track like');
  if (code !== 200) {
    throw new BridgeError(
      'NETEASE_REQUEST_FAILED',
      'NetEase track like response is missing success status',
      { httpStatus: 502 },
    );
  }
}

function playlistSummaryFromRecord(value: unknown): PlaylistSummary | undefined {
  if (!isRecord(value)) return undefined;
  const id = safeId(value.id);
  if (!id) return undefined;
  const trackCount = numeric(value.trackCount) ?? 0;
  const artworkUrl = safeArtworkUrl(value.coverImgUrl ?? value.coverUrl ?? value.picUrl);
  return {
    id,
    name: stringValue(value.name) ?? `Playlist ${id}`,
    trackCount: Math.max(0, Math.floor(trackCount)),
    ...(artworkUrl !== undefined ? { artworkUrl } : {}),
  };
}

export function parsePlaylistSummaries(response: unknown): PlaylistSummary[] {
  const body = bodyOf(response);
  responseBodyCode(body, 'user playlists');
  const rows = Array.isArray(body.playlist)
    ? body.playlist
    : Array.isArray(body.playlists)
      ? body.playlists
      : [];
  return rows
    .map(playlistSummaryFromRecord)
    .filter((item): item is PlaylistSummary => item !== undefined);
}

export function parseAccountId(response: unknown): string {
  const body = bodyOf(response);
  responseBodyCode(body, 'user account');
  const data = isRecord(body.data) ? body.data : undefined;
  const account = isRecord(body.account)
    ? body.account
    : data && isRecord(data.account)
      ? data.account
      : undefined;
  const profile = isRecord(body.profile)
    ? body.profile
    : data && isRecord(data.profile)
      ? data.profile
      : undefined;
  const id = safeId(account?.id ?? account?.userId ?? profile?.userId ?? profile?.id);
  if (!id) {
    throw new BridgeError('NETEASE_REQUEST_FAILED', 'NetEase account id was not returned', {
      httpStatus: 502,
    });
  }
  return id;
}

export function parsePublicAccountProfile(response: unknown): PublicAccountProfile {
  const body = bodyOf(response);
  responseBodyCode(body, 'user account');
  const data = isRecord(body.data) ? body.data : undefined;
  const profile = isRecord(body.profile)
    ? body.profile
    : data && isRecord(data.profile)
      ? data.profile
      : undefined;
  const displayName = boundedPublicText(profile?.nickname, 80);
  if (!profile || !displayName) {
    throw new BridgeError('ACCOUNT_PROFILE_UNAVAILABLE', 'NetEase account profile unavailable', {
      httpStatus: 503,
    });
  }
  const avatarUrl = safeArtworkUrl(profile.avatarUrl);
  return {
    displayName,
    ...(avatarUrl !== undefined ? { avatarUrl } : {}),
  };
}

export function parsePlaylistDetailHeader(
  response: unknown,
  requestedPlaylistId: string,
): Omit<PlaylistDetail, 'tracks'> {
  const body = bodyOf(response);
  responseBodyCode(body, 'playlist detail');
  const playlist = isRecord(body.playlist) ? body.playlist : undefined;
  const summary = playlistSummaryFromRecord({
    ...(playlist ?? {}),
    id: playlist?.id ?? requestedPlaylistId,
  });
  if (!summary) {
    throw new BridgeError('NETEASE_REQUEST_FAILED', 'NetEase playlist detail was not returned', {
      httpStatus: 502,
    });
  }
  const description = playlist ? stringValue(playlist.description ?? playlist.desc) : undefined;
  return {
    ...summary,
    ...(description !== undefined ? { description } : {}),
  };
}

export function parsePlaylistTrackIds(response: unknown): string[] | undefined {
  const body = bodyOf(response);
  responseBodyCode(body, 'playlist detail');
  const playlist = isRecord(body.playlist) ? body.playlist : undefined;
  if (!playlist || !Object.prototype.hasOwnProperty.call(playlist, 'trackIds')) return undefined;
  if (!Array.isArray(playlist.trackIds)) return [];
  return playlist.trackIds
    .map((item) => (isRecord(item) ? item.id : item))
    .map(safeId)
    .filter((id): id is string => id !== undefined);
}

export function parsePlaylistTrackPage(
  response: unknown,
  page: PageRequest,
  total: number,
): Page<TrackSummary> {
  return pageOf(parseTrackSummaries(response), page, total);
}

function responseCode(body: Record<string, unknown>, operation: string): number {
  const code = numeric(body.code);
  if (code === undefined) {
    throw new BridgeError('NETEASE_REQUEST_FAILED', `Invalid ${operation} response`, {
      httpStatus: 502,
    });
  }
  if (code !== 200 && operation !== 'login_qr_check') {
    throw new BridgeError(
      'NETEASE_REQUEST_FAILED',
      `NetEase ${operation} failed with code ${code}`,
      { httpStatus: 502, details: { code } },
    );
  }
  return code;
}

export function parseQrKeyResponse(response: unknown): string {
  const body = bodyOf(response);
  responseCode(body, 'login_qr_key');
  const data = isRecord(body.data) ? body.data : undefined;
  const key = data ? stringValue(data.unikey ?? data.key) : undefined;
  if (!key) {
    throw new BridgeError('NETEASE_REQUEST_FAILED', 'NetEase QR key was not returned', {
      httpStatus: 502,
    });
  }
  return key;
}

export function parseQrImageResponse(response: unknown): string {
  const body = bodyOf(response);
  responseCode(body, 'login_qr_create');
  const data = isRecord(body.data) ? body.data : undefined;
  const image = data ? stringValue(data.qrimg) : undefined;
  if (!image || !image.startsWith('data:image/')) {
    throw new BridgeError('NETEASE_REQUEST_FAILED', 'NetEase QR image was not returned', {
      httpStatus: 502,
    });
  }
  return image;
}

export function parseQrCheckResponse(response: unknown): {
  code: number;
  credential?: string;
} {
  const body = bodyOf(response);
  const code = responseCode(body, 'login_qr_check');
  const topLevel = isRecord(response) ? response.cookie : undefined;
  const cookie =
    stringValue(body.cookie) ??
    (Array.isArray(topLevel)
      ? topLevel.filter((item): item is string => typeof item === 'string').join(';')
      : stringValue(topLevel));
  return {
    code,
    ...(cookie !== undefined ? { credential: cookie } : {}),
  };
}

export function parseLoginStatusResponse(response: unknown): boolean {
  const body = bodyOf(response);
  const data = isRecord(body.data) ? body.data : undefined;
  const hasLoginStatusField =
    data !== undefined &&
    (Object.prototype.hasOwnProperty.call(data, 'code') ||
      Object.prototype.hasOwnProperty.call(data, 'profile') ||
      Object.prototype.hasOwnProperty.call(data, 'account'));
  const statusPayload = hasLoginStatusField ? data : body;
  const code = numeric(statusPayload?.code) ?? numeric(body.code);
  if (code !== 200) return false;
  return Boolean(
    isRecord(statusPayload?.profile) || isRecord(statusPayload?.account),
  );
}

export function parseTrackMetadata(
  response: unknown,
  requestedTrackId: string,
): TrackMetadata {
  const body = bodyOf(response);
  responseBodyCode(body, 'song_detail');

  const songs = Array.isArray(body.songs) ? body.songs : [];
  const song = songs.find((item) => {
    if (!isRecord(item)) return false;
    return String(item.id ?? '') === requestedTrackId;
  });

  if (!isRecord(song)) {
    throw new BridgeError('TRACK_UNAVAILABLE', 'Track metadata was not returned', {
      httpStatus: 404,
      details: { trackId: requestedTrackId },
    });
  }

  const title = stringValue(song.name) ?? `NetEase Track ${requestedTrackId}`;
  const artistRows = Array.isArray(song.ar)
    ? song.ar
    : Array.isArray(song.artists)
      ? song.artists
      : [];
  const artists = artistRows
    .map((artist) => (isRecord(artist) ? stringValue(artist.name) : undefined))
    .filter((artist): artist is string => artist !== undefined);

  const albumRecord = isRecord(song.al)
    ? song.al
    : isRecord(song.album)
      ? song.album
      : undefined;
  const album = albumRecord ? stringValue(albumRecord.name) : undefined;
  const artworkUrl = albumRecord
    ? safeArtworkUrl(albumRecord.picUrl ?? albumRecord.blurPicUrl)
    : undefined;
  const durationMs = numeric(song.dt ?? song.duration);

  return {
    id: requestedTrackId,
    title,
    artists: artists.length > 0 ? artists : ['Unknown Artist'],
    album: album ?? 'Unknown Album',
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(artworkUrl !== undefined ? { artworkUrl } : {}),
  };
}

export function parseResolvedAudioStream(
  response: unknown,
  trackId: string,
  requestedQuality: QualityLevel,
): ResolvedAudioStream {
  const body = bodyOf(response);
  responseBodyCode(body, 'song_url_v1');

  const rows = Array.isArray(body.data) ? body.data : [];
  const row = rows.find((item) => {
    if (!isRecord(item)) return false;
    return String(item.id ?? '') === trackId;
  });

  if (!isRecord(row)) {
    throw new BridgeError('TRACK_UNAVAILABLE', 'No stream row returned for track', {
      httpStatus: 409,
      details: { trackId },
    });
  }

  const itemCode = numeric(row.code);
  if (itemCode !== undefined && itemCode !== 200) {
    throw new BridgeError(
      'TRACK_UNAVAILABLE',
      `Track is not playable for this account (code ${itemCode})`,
      { httpStatus: 409, details: { trackId, code: itemCode } },
    );
  }

  if (row.freeTrialInfo !== null && row.freeTrialInfo !== undefined) {
    throw new BridgeError(
      'TRACK_PREVIEW_ONLY',
      'NetEase returned a preview/trial stream, not a full authorized track',
      { httpStatus: 409, details: { trackId } },
    );
  }

  const resolvedUrl = resolveNeteaseAudioUrl(row.url);
  const actualQuality = stringValue(row.level) ?? 'unknown';
  const format = stringValue(row.type ?? row.encodeType);
  const bitrate = numeric(row.br);
  const sizeBytes = numeric(row.size);
  const expiresInSeconds = numeric(row.expi);

  return {
    trackId,
    upstreamUrl: resolvedUrl.upstreamUrl,
    requestedQuality,
    transportSecurity: resolvedUrl.transportSecurity,
    actualQuality,
    ...(format !== undefined ? { format } : {}),
    ...(bitrate !== undefined ? { bitrate } : {}),
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    ...(expiresInSeconds !== undefined ? { expiresInSeconds } : {}),
    requestHeaders: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 MusicBridgeForRoon/0.1',
      Referer: 'https://music.163.com/',
      'Accept-Encoding': 'identity',
    },
  };
}
