import type { PublicError } from './errors.js';
import type {
  Page,
  PageRequest,
  PlaylistDetail,
  PlaylistSummary,
  TrackSummary,
} from './library.js';
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
  PublicAuthState,
  PublicBridgeState,
  PublicRoonZone,
} from './state.js';

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
  if (command === 'auth.pollQr' || command === 'auth.cancelQr') {
    return isChallengePayload(payload);
  }
  if (command === 'library.search') return isLibrarySearchPayload(payload);
  if (command === 'library.liked') return isLibraryPagePayload(payload);
  if (command === 'library.playlist') return isLibraryPlaylistPayload(payload);
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
    case 'core.shutdown':
      return isRecord(value) && hasOnlyKeys(value, ['stopped']) && value.stopped === true;
    case 'roon.listZones':
      return isZoneListResult(value);
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
    case 'diagnostic.notice':
      return isDiagnosticPayload(payload);
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
