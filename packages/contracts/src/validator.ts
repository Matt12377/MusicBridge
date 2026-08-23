import type { PublicError } from './errors.js';
import type {
  DailyRecommendationTrack,
  DailyRecommendationsSnapshot,
  Page,
  PageRequest,
  PlaylistDetail,
  PlaylistSummary,
  TrackSummary,
} from './library.js';
import {
  LYRICS_STATUSES,
  LYRICS_TIMING_SOURCES,
  type LyricLine,
  type LyricWord,
  type LyricsSnapshot,
} from './lyrics.js';
import {
  PLAYBACK_ISSUE_CODES,
  PLAYBACK_QUALITY_LEVELS,
  type PlaybackQueueItem,
  type PlaybackQueueSnapshot,
  type PlaybackIssue,
  type PlaybackQuality,
  type PlaybackSnapshot,
} from './playback.js';
import {
  IPC_COMMANDS,
  IPC_EVENTS,
  IPC_VERSION,
  type IpcCommand,
  type IpcCommandResults,
  type IpcInternalCommand,
  type IpcInternalCommandResults,
  type IpcEventName,
  type IpcRuntimeMessage,
  type IpcResponse,
  type IpcRequest,
} from './ipc.js';
import type {
  PublicAccountProfile,
  PublicAccountState,
  PublicAuthState,
  PublicBridgeState,
  PublicRoonZone,
} from './state.js';
import type {
  DiagnosticComponentSnapshot,
  DiagnosticGateResult,
  DiagnosticTimelineEvent,
} from './diagnostics.js';

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: PublicError };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidRequest(): ValidationResult<never> {
  return {
    ok: false,
    error: {
      code: 'INVALID_IPC_REQUEST',
      message: 'Invalid IPC request',
    },
  };
}

function invalidResponse(): ValidationResult<never> {
  return {
    ok: false,
    error: {
      code: 'INVALID_IPC_RESPONSE',
      message: 'Invalid IPC response',
    },
  };
}

function safeString(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximumLength;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isEmptyPayload(value: unknown): value is Record<string, never> {
  return isRecord(value) && Object.keys(value).length === 0;
}

const MAX_PAGE_OFFSET = 1_000_000;
const MAX_PAGE_LIMIT = 100;
const MAX_SEARCH_QUERY_LENGTH = 100;
const MAX_LYRICS_LINES = 500;
const MAX_LYRICS_WORDS = 200;
const MAX_LYRICS_TEXT_LENGTH = 2_048;
const MAX_LYRICS_TOTAL_TEXT_LENGTH = 256 * 1024;
const MAX_ACCOUNT_DISPLAY_NAME_LENGTH = 80;
const MAX_RECOMMENDATION_TRACKS = 50;
const MAX_RECOMMENDATION_REASON_LENGTH = 120;

function isPageRequest(value: unknown): value is PageRequest {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['offset', 'limit']) &&
    typeof value.offset === 'number' &&
    Number.isSafeInteger(value.offset) &&
    value.offset >= 0 &&
    value.offset <= MAX_PAGE_OFFSET &&
    typeof value.limit === 'number' &&
    Number.isSafeInteger(value.limit) &&
    value.limit >= 1 &&
    value.limit <= MAX_PAGE_LIMIT
  );
}

function isLibrarySearchPayload(value: unknown): value is { query: string; page: PageRequest } {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['query', 'page']) &&
    safeString(value.query, MAX_SEARCH_QUERY_LENGTH) &&
    value.query.trim().length > 0 &&
    isPageRequest(value.page)
  );
}

function isLibraryPagePayload(value: unknown): value is { page: PageRequest } {
  return isRecord(value) && hasOnlyKeys(value, ['page']) && isPageRequest(value.page);
}

function isLibraryPlaylistPayload(
  value: unknown,
): value is { playlistId: string; page: PageRequest } {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['playlistId', 'page']) &&
    safeString(value.playlistId, 128) &&
    /^\d+$/.test(value.playlistId) &&
    value.playlistId !== '0' &&
    isPageRequest(value.page)
  );
}

function isSelectZonePayload(value: unknown): value is { zoneId: string } {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['zoneId']) &&
    safeString(value.zoneId, 128)
  );
}

const MAX_QUEUE_ITEMS = 100;

function isPlaybackQuality(value: unknown): value is PlaybackQuality {
  return PLAYBACK_QUALITY_LEVELS.includes(value as PlaybackQuality);
}

function isPlaybackQueueItem(value: unknown): value is PlaybackQueueItem {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['trackId', 'quality']) &&
    safeString(value.trackId, 128) &&
    /^\d+$/.test(value.trackId) &&
    value.trackId !== '0' &&
    isPlaybackQuality(value.quality)
  );
}

function isPlaybackQueueSnapshot(value: unknown): value is PlaybackQueueSnapshot {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['items', 'index', 'hasNext', 'hasPrevious']) ||
    !Array.isArray(value.items) ||
    value.items.length > MAX_QUEUE_ITEMS ||
    !value.items.every((item) => isPlaybackQueueItem(item)) ||
    typeof value.index !== 'number' ||
    !Number.isSafeInteger(value.index) ||
    value.index < -1 ||
    (value.items.length === 0 ? value.index !== -1 : value.index >= value.items.length) ||
    typeof value.hasNext !== 'boolean' ||
    typeof value.hasPrevious !== 'boolean'
  ) {
    return false;
  }
  return true;
}

function isPlaybackState(value: unknown): value is PlaybackSnapshot['state'] {
  return ['idle', 'resolving', 'preparing', 'playing', 'stopping', 'error'].includes(
    String(value),
  );
}

const PLAYBACK_RECOVERY_ACTIONS = new Set([
  'reauthenticate',
  'retry',
  'select_zone',
  'restart_core',
  'none',
]);

function isPlaybackIssue(value: unknown): value is PlaybackIssue {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['code', 'message', 'retryable', 'diagnosticId', 'action']) &&
    PLAYBACK_ISSUE_CODES.includes(value.code as PlaybackIssue['code']) &&
    safeString(value.message, 512) &&
    typeof value.retryable === 'boolean' &&
    safeString(value.diagnosticId, 128) &&
    (value.action === undefined || PLAYBACK_RECOVERY_ACTIONS.has(String(value.action)))
  );
}

function isPlaybackSnapshot(value: unknown): value is PlaybackSnapshot {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'state',
      'queue',
      'currentTrack',
      'requestedQuality',
      'actualQuality',
      'format',
      'bitrate',
      'selectedZoneId',
      'lastError',
      'lastIssue',
      'qualityNotice',
      'canNext',
      'canPrevious',
      'canStop',
    ]) ||
    !isPlaybackState(value.state) ||
    !isPlaybackQueueSnapshot(value.queue) ||
    (value.currentTrack !== undefined && !isTrackSummary(value.currentTrack)) ||
    (value.requestedQuality !== undefined && !isPlaybackQuality(value.requestedQuality)) ||
    (value.actualQuality !== undefined && !safeString(value.actualQuality, 64)) ||
    (value.format !== undefined && !safeString(value.format, 32)) ||
    (value.bitrate !== undefined &&
      (typeof value.bitrate !== 'number' ||
        !Number.isSafeInteger(value.bitrate) ||
        value.bitrate < 0 ||
        value.bitrate > 10_000_000)) ||
    (value.selectedZoneId !== undefined && !safeString(value.selectedZoneId, 128)) ||
    (value.lastError !== undefined && !safeString(value.lastError, 128)) ||
    (value.lastIssue !== undefined && !isPlaybackIssue(value.lastIssue)) ||
    (value.qualityNotice !== undefined && !isPlaybackIssue(value.qualityNotice)) ||
    typeof value.canNext !== 'boolean' ||
    typeof value.canPrevious !== 'boolean' ||
    typeof value.canStop !== 'boolean'
  ) {
    return false;
  }
  return true;
}

function isPlaybackPlayPayload(
  value: unknown,
): value is { trackId: string; quality: PlaybackQuality } {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['trackId', 'quality']) &&
    safeString(value.trackId, 128) &&
    /^\d+$/.test(value.trackId) &&
    value.trackId !== '0' &&
    isPlaybackQuality(value.quality)
  );
}

function isPlaybackReplaceQueuePayload(
  value: unknown,
): value is { items: readonly PlaybackQueueItem[]; index: number } {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['items', 'index']) &&
    Array.isArray(value.items) &&
    value.items.length > 0 &&
    value.items.length <= MAX_QUEUE_ITEMS &&
    value.items.every((item) => isPlaybackQueueItem(item)) &&
    typeof value.index === 'number' &&
    Number.isSafeInteger(value.index) &&
    value.index >= 0 &&
    value.index < value.items.length
  );
}

function isLyricWord(value: unknown): value is LyricWord {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['startMs', 'endMs', 'text']) &&
    typeof value.startMs === 'number' &&
    Number.isSafeInteger(value.startMs) &&
    value.startMs >= 0 &&
    value.startMs <= 24 * 60 * 60 * 1000 &&
    typeof value.endMs === 'number' &&
    Number.isSafeInteger(value.endMs) &&
    value.endMs > value.startMs &&
    value.endMs <= 24 * 60 * 60 * 1000 &&
    safeString(value.text, MAX_LYRICS_TEXT_LENGTH)
  );
}

function isLyricLine(value: unknown): value is LyricLine {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'startMs',
      'endMs',
      'text',
      'translation',
      'romanization',
      'words',
    ]) &&
    typeof value.startMs === 'number' &&
    Number.isSafeInteger(value.startMs) &&
    value.startMs >= 0 &&
    value.startMs <= 24 * 60 * 60 * 1000 &&
    (value.endMs === undefined ||
      (typeof value.endMs === 'number' &&
        Number.isSafeInteger(value.endMs) &&
        value.endMs > value.startMs &&
        value.endMs <= 24 * 60 * 60 * 1000)) &&
    safeString(value.text, MAX_LYRICS_TEXT_LENGTH) &&
    (value.translation === undefined || safeString(value.translation, MAX_LYRICS_TEXT_LENGTH)) &&
    (value.romanization === undefined || safeString(value.romanization, MAX_LYRICS_TEXT_LENGTH)) &&
    (value.words === undefined ||
      (Array.isArray(value.words) &&
        value.words.length > 0 &&
        value.words.length <= MAX_LYRICS_WORDS &&
        value.words.every((word) => isLyricWord(word))))
  );
}

function isLyricsSnapshot(value: unknown): value is LyricsSnapshot {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'status',
      'lines',
      'activeLineIndex',
      'activeWordIndex',
      'timingSource',
    ]) ||
    !LYRICS_STATUSES.includes(value.status as (typeof LYRICS_STATUSES)[number]) ||
    !Array.isArray(value.lines) ||
    value.lines.length > MAX_LYRICS_LINES ||
    !value.lines.every((line) => isLyricLine(line)) ||
    typeof value.activeLineIndex !== 'number' ||
    !Number.isSafeInteger(value.activeLineIndex) ||
    value.activeLineIndex < -1 ||
    value.activeLineIndex >= value.lines.length ||
    !LYRICS_TIMING_SOURCES.includes(
      value.timingSource as (typeof LYRICS_TIMING_SOURCES)[number],
    )
  ) {
    return false;
  }

  const totalTextLength = value.lines.reduce((total, line) => {
    const words = Array.isArray(line.words)
      ? line.words.reduce((wordTotal, word) => wordTotal + word.text.length, 0)
      : 0;
    return total + line.text.length + (line.translation?.length ?? 0) +
      (line.romanization?.length ?? 0) + words;
  }, 0);
  if (totalTextLength > MAX_LYRICS_TOTAL_TEXT_LENGTH) return false;

  if (
    value.activeWordIndex !== undefined &&
    (typeof value.activeWordIndex !== 'number' ||
      !Number.isSafeInteger(value.activeWordIndex) ||
      value.activeWordIndex < -1)
  ) {
    return false;
  }
  if (value.activeWordIndex !== undefined && value.activeWordIndex >= 0) {
    const activeLine = value.lines[value.activeLineIndex];
    if (!activeLine?.words || value.activeWordIndex >= activeLine.words.length) return false;
  }
  return true;
}

function isLyricsPayload(value: unknown): value is { trackId: string } {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['trackId']) &&
    safeString(value.trackId, 128) &&
    /^\d+$/.test(value.trackId) &&
    value.trackId !== '0'
  );
}

function isSetCredentialPayload(value: unknown): value is { credential: string } {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['credential']) &&
    safeString(value.credential, 64 * 1024)
  );
}

function isChallengePayload(value: unknown): value is { challengeId: string } {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['challengeId']) &&
    safeString(value.challengeId, 128)
  );
}

function isArtworkUrl(value: unknown): value is string {
  if (!safeString(value, 2_048)) return false;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return (
      url.protocol === 'https:' &&
      (hostname === 'music.126.net' || hostname.endsWith('.music.126.net')) &&
      url.username === '' &&
      url.password === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

function isTrackSummary(value: unknown): value is TrackSummary {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'id',
    'title',
    'artists',
    'album',
    'durationMs',
    'artworkUrl',
  ])) {
    return false;
  }
  return (
    safeString(value.id, 128) &&
    /^\d+$/.test(value.id) &&
    value.id !== '0' &&
    safeString(value.title, 512) &&
    Array.isArray(value.artists) &&
    value.artists.length <= 64 &&
    value.artists.every((artist) => safeString(artist, 256)) &&
    safeString(value.album, 512) &&
    (value.durationMs === undefined ||
      (typeof value.durationMs === 'number' &&
        Number.isSafeInteger(value.durationMs) &&
        value.durationMs >= 0 &&
        value.durationMs <= 24 * 60 * 60 * 1000)) &&
    (value.artworkUrl === undefined || isArtworkUrl(value.artworkUrl))
  );
}

function isDailyRecommendationTrack(value: unknown): value is DailyRecommendationTrack {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'id',
    'title',
    'artists',
    'album',
    'durationMs',
    'artworkUrl',
    'recommendationReason',
  ])) {
    return false;
  }
  const { recommendationReason, ...summary } = value;
  return (
    isTrackSummary(summary) &&
    (recommendationReason === undefined || safeString(recommendationReason, MAX_RECOMMENDATION_REASON_LENGTH))
  );
}

function isDailyRecommendationsSnapshot(value: unknown): value is DailyRecommendationsSnapshot {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['dayKey', 'tracks']) &&
    typeof value.dayKey === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value.dayKey) &&
    Array.isArray(value.tracks) &&
    value.tracks.length <= MAX_RECOMMENDATION_TRACKS &&
    value.tracks.every((track) => isDailyRecommendationTrack(track))
  );
}

function isPageOfTracks(value: unknown): value is Page<TrackSummary> {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['items', 'offset', 'limit', 'total', 'hasMore']) &&
    isPageRequest({ offset: value.offset, limit: value.limit }) &&
    Array.isArray(value.items) &&
    value.items.length <= MAX_PAGE_LIMIT &&
    value.items.every((item) => isTrackSummary(item)) &&
    typeof value.total === 'number' &&
    Number.isSafeInteger(value.total) &&
    value.total >= 0 &&
    value.total <= MAX_PAGE_OFFSET &&
    typeof value.hasMore === 'boolean'
  );
}

function isPlaylistSummary(value: unknown): value is PlaylistSummary {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['id', 'name', 'trackCount', 'artworkUrl']) &&
    safeString(value.id, 128) &&
    /^\d+$/.test(value.id) &&
    value.id !== '0' &&
    safeString(value.name, 512) &&
    typeof value.trackCount === 'number' &&
    Number.isSafeInteger(value.trackCount) &&
    value.trackCount >= 0 &&
    value.trackCount <= MAX_PAGE_OFFSET &&
    (value.artworkUrl === undefined || isArtworkUrl(value.artworkUrl))
  );
}

function isPlaylistDetail(value: unknown): value is PlaylistDetail {
  const summary = isRecord(value)
    ? {
        id: value.id,
        name: value.name,
        trackCount: value.trackCount,
        ...(value.artworkUrl !== undefined ? { artworkUrl: value.artworkUrl } : {}),
      }
    : undefined;
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['id', 'name', 'trackCount', 'artworkUrl', 'description', 'tracks']) &&
    summary !== undefined &&
    isPlaylistSummary(summary) &&
    (value.description === undefined || safeString(value.description, 4_096)) &&
    isPageOfTracks(value.tracks)
  );
}

function isValidCommandPayload(command: IpcCommand, payload: unknown): boolean {
  if (command === 'roon.selectZone') return isSelectZonePayload(payload);
  if (command === 'auth.setCredential') return isSetCredentialPayload(payload);
  if (command === 'auth.verifyCredential') return isSetCredentialPayload(payload);
  if (command === 'auth.pollQr' || command === 'auth.cancelQr') {
    return isChallengePayload(payload);
  }
  if (command === 'library.search') return isLibrarySearchPayload(payload);
  if (command === 'library.liked') return isLibraryPagePayload(payload);
  if (command === 'library.playlist') return isLibraryPlaylistPayload(payload);
  if (command === 'lyrics.get') return isLyricsPayload(payload);
  if (command === 'playback.play') return isPlaybackPlayPayload(payload);
  if (command === 'playback.replaceQueue') return isPlaybackReplaceQueuePayload(payload);
  return isEmptyPayload(payload);
}

const PUBLIC_ERROR_CODES = new Set([
  'INVALID_IPC_REQUEST',
  'UNSUPPORTED_IPC_VERSION',
  'UNKNOWN_IPC_COMMAND',
  'INVALID_IPC_RESPONSE',
  'TIMEOUT',
  'NOT_READY',
  'AUTH_EXPIRED',
  'ACCOUNT_PROFILE_UNAVAILABLE',
  'DAILY_RECOMMENDATIONS_UNAVAILABLE',
  'INTERNAL_ERROR',
]);

function isPublicError(value: unknown): value is PublicError {
  if (!isRecord(value) || !PUBLIC_ERROR_CODES.has(String(value.code))) return false;
  if (!safeString(value.message, 256)) return false;
  if (
    Object.keys(value).some((key) => !['code', 'message', 'diagnosticId'].includes(key))
  ) {
    return false;
  }
  return value.diagnosticId === undefined || safeString(value.diagnosticId, 128);
}

function isRuntimeStatus(value: unknown): value is PublicBridgeState['runtime'] {
  return ['starting', 'ready', 'degraded', 'failed', 'stopped'].includes(String(value));
}

function isRoonStatus(value: unknown): value is PublicBridgeState['roon'] {
  return ['disconnected', 'discovering', 'paired', 'ready'].includes(String(value));
}

function isProviderStatus(value: unknown): value is PublicBridgeState['provider'] {
  return ['configured', 'missing', 'invalid'].includes(String(value));
}

function isPublicBridgeState(value: unknown): value is PublicBridgeState {
  if (!isRecord(value)) return false;
  if (
    !hasOnlyKeys(value, [
      'runtime',
      'roon',
      'provider',
      'activeStreamCount',
      'activePlaybackPresent',
    ])
  ) {
    return false;
  }
  return (
    isRuntimeStatus(value.runtime) &&
    isRoonStatus(value.roon) &&
    isProviderStatus(value.provider) &&
    typeof value.activeStreamCount === 'number' &&
    Number.isSafeInteger(value.activeStreamCount) &&
    value.activeStreamCount >= 0 &&
    value.activeStreamCount <= 100_000 &&
    typeof value.activePlaybackPresent === 'boolean'
  );
}

function isDiagnosticTimelineEvent(value: unknown): value is DiagnosticTimelineEvent {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, ['at', 'component', 'level', 'event', 'code', 'diagnosticId', 'state', 'durationMs'])) {
    return false;
  }
  return (
    safeString(value.at, 64) &&
    (value.component === 'main' || value.component === 'core') &&
    (value.level === 'info' || value.level === 'warn' || value.level === 'error') &&
    safeString(value.event, 128) &&
    (value.code === undefined || safeString(value.code, 128)) &&
    (value.diagnosticId === undefined || safeString(value.diagnosticId, 128)) &&
    (value.state === undefined || safeString(value.state, 64)) &&
    (value.durationMs === undefined ||
      (typeof value.durationMs === 'number' &&
        Number.isSafeInteger(value.durationMs) &&
        value.durationMs >= 0 &&
        value.durationMs <= 24 * 60 * 60 * 1000))
  );
}

function isDiagnosticGate(value: unknown): value is DiagnosticGateResult {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['name', 'status']) &&
    safeString(value.name, 128) &&
    ['pass', 'fail', 'not-run'].includes(String(value.status))
  );
}

function isDiagnosticComponentSnapshot(value: unknown): value is DiagnosticComponentSnapshot {
  if (!isRecord(value)) return false;
  if (
    !hasOnlyKeys(value, ['component', 'health', 'timeline', 'memory', 'counters', 'latency', 'gates']) ||
    !['main', 'core'].includes(String(value.component)) ||
    !isPublicBridgeState(value.health) ||
    !Array.isArray(value.timeline) ||
    value.timeline.length > 200 ||
    !value.timeline.every((event) => isDiagnosticTimelineEvent(event)) ||
    !isRecord(value.memory) ||
    !hasOnlyKeys(value.memory, ['rssBytes', 'heapUsedBytes', 'heapTotalBytes', 'externalBytes']) ||
    !isRecord(value.counters) ||
    !hasOnlyKeys(value.counters, [
      'queueItemCount',
      'activeStreamCount',
      'activePlaybackCount',
      'activeSessionCount',
      'activeTokenCount',
      'listenerCount',
      'timerCount',
    ]) ||
    !isRecord(value.latency) ||
    !hasOnlyKeys(value.latency, ['startupMs', 'lastPlayMs']) ||
    !Array.isArray(value.gates) ||
    value.gates.length > 64 ||
    !value.gates.every((gate) => isDiagnosticGate(gate))
  ) {
    return false;
  }

  const memory = value.memory;
  const counters = value.counters;
  const latency = value.latency;
  const boundedNumber = (candidate: unknown, maximum = Number.MAX_SAFE_INTEGER): boolean =>
    typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0 && candidate <= maximum;
  return (
    boundedNumber(memory.rssBytes) &&
    boundedNumber(memory.heapUsedBytes) &&
    boundedNumber(memory.heapTotalBytes) &&
    boundedNumber(memory.externalBytes) &&
    boundedNumber(counters.queueItemCount, 100) &&
    boundedNumber(counters.activeStreamCount, 100_000) &&
    boundedNumber(counters.activePlaybackCount, 1) &&
    boundedNumber(counters.activeSessionCount, 1) &&
    boundedNumber(counters.activeTokenCount, 100_000) &&
    boundedNumber(counters.listenerCount, 100_000) &&
    boundedNumber(counters.timerCount, 100_000) &&
    (latency.startupMs === undefined || boundedNumber(latency.startupMs, 24 * 60 * 60 * 1000)) &&
    (latency.lastPlayMs === undefined || boundedNumber(latency.lastPlayMs, 24 * 60 * 60 * 1000))
  );
}

function isAuthStatus(value: unknown): value is PublicAuthState['status'] {
  return [
    'idle',
    'creating',
    'waiting',
    'scanned',
    'authorized',
    'expired',
    'cancelled',
    'error',
  ].includes(String(value));
}

function isPublicAuthState(value: unknown): value is PublicAuthState {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, ['status', 'challengeId', 'qrImage', 'expiresAt'])) {
    return false;
  }
  if (!isAuthStatus(value.status)) return false;
  if (value.challengeId !== undefined && !safeString(value.challengeId, 128)) {
    return false;
  }
  if (
    value.qrImage !== undefined &&
    (!safeString(value.qrImage, 2 * 1024 * 1024) ||
      !value.qrImage.startsWith('data:image/'))
  ) {
    return false;
  }
  return (
    value.expiresAt === undefined ||
    (typeof value.expiresAt === 'number' &&
      Number.isSafeInteger(value.expiresAt) &&
      value.expiresAt >= 0)
  );
}

function isPublicAccountState(value: unknown): value is PublicAccountState {
  if (!isRecord(value) || !hasOnlyKeys(value, ['status', 'profile'])) return false;
  if (!['missing', 'loading', 'ready', 'unavailable'].includes(String(value.status))) return false;
  if (value.profile === undefined) return value.status !== 'ready';
  if (!isRecord(value.profile) || !hasOnlyKeys(value.profile, ['displayName', 'avatarUrl'])) return false;
  const profile = value.profile as unknown as PublicAccountProfile;
  return (
    safeString(profile.displayName, MAX_ACCOUNT_DISPLAY_NAME_LENGTH) &&
    (profile.avatarUrl === undefined || isArtworkUrl(profile.avatarUrl)) &&
    value.status === 'ready'
  );
}

function isInternalQrPollResult(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ['state', 'credential'])) return false;
  return (
    isPublicAuthState(value.state) &&
    (value.credential === undefined || safeString(value.credential, 64 * 1024))
  );
}

function isPublicRoonZone(value: unknown): value is PublicRoonZone {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['zoneId', 'displayName', 'selected']) &&
    safeString(value.zoneId, 128) &&
    safeString(value.displayName, 256) &&
    typeof value.selected === 'boolean'
  );
}

function isZoneListResult(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['zones']) &&
    Array.isArray(value.zones) &&
    value.zones.length <= 256 &&
    value.zones.every((zone) => isPublicRoonZone(zone))
  );
}

function isCommandResult(
  command: IpcCommand,
  value: unknown,
  allowInternalResult = false,
): boolean {
  switch (command) {
    case 'core.ping':
      return isRecord(value) && hasOnlyKeys(value, ['pong']) && value.pong === true;
    case 'core.getHealth':
    case 'core.getState':
    case 'auth.setCredential':
    case 'auth.clearCredential':
    case 'roon.selectZone':
      return isPublicBridgeState(value);
    case 'auth.verifyCredential':
      return allowInternalResult && isRecord(value) &&
        hasOnlyKeys(value, ['status']) &&
        ['authorized', 'expired', 'unavailable'].includes(String(value.status));
    case 'core.getDiagnostics':
      return isDiagnosticComponentSnapshot(value);
    case 'auth.beginQr':
    case 'auth.cancelQr':
    case 'auth.getState':
    case 'auth.logout':
      return isPublicAuthState(value);
    case 'auth.pollQr':
      return isPublicAuthState(value) ||
        (allowInternalResult && isInternalQrPollResult(value));
    case 'library.search':
    case 'library.liked':
      return isPageOfTracks(value);
    case 'library.playlists':
      return Array.isArray(value) && value.length <= MAX_PAGE_OFFSET && value.every((item) => isPlaylistSummary(item));
    case 'library.playlist':
      return isPlaylistDetail(value);
    case 'account.getState':
    case 'account.refresh':
      return isPublicAccountState(value);
    case 'library.dailyRecommendations':
      return isDailyRecommendationsSnapshot(value);
    case 'lyrics.get':
      return isLyricsSnapshot(value);
    case 'core.shutdown':
      return isRecord(value) && hasOnlyKeys(value, ['stopped']) && value.stopped === true;
    case 'roon.listZones':
      return isZoneListResult(value);
    case 'playback.getState':
    case 'playback.play':
    case 'playback.stop':
    case 'playback.next':
    case 'playback.previous':
    case 'playback.replaceQueue':
      return isPlaybackSnapshot(value);
  }
}

function isDiagnosticPayload(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ['code', 'message'])) return false;
  return safeString(value.code, 128) &&
    (value.message === undefined || safeString(value.message, 256));
}

function isEventPayload(event: IpcEventName, payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  switch (event) {
    case 'core.ready':
    case 'core.health':
    case 'roon.changed':
      return hasOnlyKeys(payload, ['state']) && isPublicBridgeState(payload.state);
    case 'auth.changed':
      return hasOnlyKeys(payload, ['state']) && isPublicAuthState(payload.state);
    case 'account.changed':
      return hasOnlyKeys(payload, ['state']) && isPublicAccountState(payload.state);
    case 'diagnostic.notice':
      return isDiagnosticPayload(payload);
    case 'playback.changed':
      return hasOnlyKeys(payload, ['state']) && isPlaybackSnapshot(payload.state);
    case 'queue.changed':
      return hasOnlyKeys(payload, ['queue']) && isPlaybackQueueSnapshot(payload.queue);
    case 'lyrics.changed':
      return hasOnlyKeys(payload, ['state']) && isLyricsSnapshot(payload.state);
  }
}

export function validateIpcRequest(
  input: unknown,
): ValidationResult<IpcRequest<unknown>> {
  if (!isRecord(input)) return invalidRequest();

  if (input.version !== IPC_VERSION) {
    return {
      ok: false,
      error: {
        code: 'UNSUPPORTED_IPC_VERSION',
        message: 'Unsupported IPC version',
      },
    };
  }

  if (
    typeof input.id !== 'string' ||
    input.id.trim().length === 0 ||
    input.id.length > 128 ||
    typeof input.command !== 'string' ||
    !IPC_COMMANDS.includes(input.command as (typeof IPC_COMMANDS)[number]) ||
    !isRecord(input.payload) ||
    !isValidCommandPayload(input.command as IpcCommand, input.payload)
  ) {
    if (
      typeof input.command === 'string' &&
      input.command.length > 0 &&
      !IPC_COMMANDS.includes(input.command as (typeof IPC_COMMANDS)[number])
    ) {
      return {
        ok: false,
        error: {
          code: 'UNKNOWN_IPC_COMMAND',
          message: 'Unknown IPC command',
        },
      };
    }
    return invalidRequest();
  }

  return {
    ok: true,
    value: {
      version: IPC_VERSION,
      id: input.id,
      command: input.command as (typeof IPC_COMMANDS)[number],
      payload: input.payload,
    },
  };
}

export function validateIpcResponse(
  input: unknown,
): ValidationResult<IpcResponse<unknown>> {
  if (!isRecord(input)) return invalidResponse();
  if (input.version !== IPC_VERSION) {
    return {
      ok: false,
      error: {
        code: 'UNSUPPORTED_IPC_VERSION',
        message: 'Unsupported IPC version',
      },
    };
  }
  if (!safeString(input.id, 128) || typeof input.ok !== 'boolean') {
    return invalidResponse();
  }
  if (input.ok) {
    if (!Object.prototype.hasOwnProperty.call(input, 'result')) return invalidResponse();
    return {
      ok: true,
      value: {
        version: IPC_VERSION,
        id: input.id,
        ok: true,
        result: input.result,
      },
    };
  }
  if (!isPublicError(input.error)) return invalidResponse();
  return {
    ok: true,
    value: {
      version: IPC_VERSION,
      id: input.id,
      ok: false,
      error: input.error,
    },
  };
}

export function validateIpcResponseForCommand<TCommand extends IpcCommand>(
  input: unknown,
  command: TCommand,
): ValidationResult<IpcResponse<IpcCommandResults[TCommand]>> {
  const response = validateIpcResponse(input);
  if (!response.ok) return response;
  if (!response.value.ok || isCommandResult(command, response.value.result)) {
    return {
      ok: true,
      value: response.value as IpcResponse<IpcCommandResults[TCommand]>,
    };
  }
  return invalidResponse();
}

export function validateIpcInternalResponseForCommand<
  TCommand extends IpcInternalCommand,
>(
  input: unknown,
  command: TCommand,
): ValidationResult<IpcResponse<IpcInternalCommandResults[TCommand]>> {
  const response = validateIpcResponse(input);
  if (!response.ok) return response;
  if (!response.value.ok || isCommandResult(command, response.value.result, true)) {
    return {
      ok: true,
      value: response.value as IpcResponse<IpcInternalCommandResults[TCommand]>,
    };
  }
  return invalidResponse();
}

export function validateIpcEvent(input: unknown): ValidationResult<IpcRuntimeMessage> {
  if (!isRecord(input)) return invalidResponse();
  if (input.version !== IPC_VERSION) {
    return {
      ok: false,
      error: {
        code: 'UNSUPPORTED_IPC_VERSION',
        message: 'Unsupported IPC version',
      },
    };
  }
  if (
    typeof input.event !== 'string' ||
    !IPC_EVENTS.includes(input.event as IpcEventName) ||
    !isEventPayload(input.event as IpcEventName, input.payload)
  ) {
    return invalidResponse();
  }
  return {
    ok: true,
    value: {
      version: IPC_VERSION,
      event: input.event as IpcEventName,
      payload: input.payload,
    } as IpcRuntimeMessage,
  };
}

export function parseIpcRuntimeMessage(
  input: unknown,
): ValidationResult<IpcRuntimeMessage> {
  if (isRecord(input) && Object.prototype.hasOwnProperty.call(input, 'ok')) {
    return validateIpcResponse(input);
  }
  if (isRecord(input) && Object.prototype.hasOwnProperty.call(input, 'event')) {
    return validateIpcEvent(input);
  }
  return invalidResponse();
}
