import { BridgeError } from '../shared/errors.js';
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
  const code = numeric(body.code);
  if (code !== 200) return false;
  const data = isRecord(body.data) ? body.data : undefined;
  return Boolean(
    (data && (isRecord(data.profile) || isRecord(data.account))) ||
      isRecord(body.profile) ||
      isRecord(body.account),
  );
}

export function parseTrackMetadata(
  response: unknown,
  requestedTrackId: string,
): TrackMetadata {
  const body = bodyOf(response);
  const code = numeric(body.code);
  if (code !== undefined && code !== 200) {
    throw new BridgeError(
      'NETEASE_REQUEST_FAILED',
      `NetEase song_detail failed with code ${code}`,
      { httpStatus: 502, details: { code } },
    );
  }

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
    ? stringValue(albumRecord.picUrl ?? albumRecord.blurPicUrl)
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
  const bodyCode = numeric(body.code);
  if (bodyCode !== undefined && bodyCode !== 200) {
    throw new BridgeError(
      'NETEASE_REQUEST_FAILED',
      `NetEase song_url_v1 failed with code ${bodyCode}`,
      { httpStatus: 502, details: { code: bodyCode } },
    );
  }

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
