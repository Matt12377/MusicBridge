import { randomUUID } from 'node:crypto';
import type { RemoteCoreMode, RoonImageShapeSummary } from '@music-bridge/contracts';
import { BridgeError } from '../shared/errors.js';
import type { Logger } from '../shared/logger.js';
import type {
  RoonPlayRequest,
  RoonGatewayStage,
  RoonPort,
  RoonState,
  RoonNativePlaybackState,
  RoonPlaybackConfirmationRequest,
  RoonPlaybackObservation,
  RoonTransportState,
  RoonTerminalReason,
  RoonTimeEvent,
} from './types.js';
import {
  createProductionRoonSdk,
  type RoonApiInstance,
  type RoonAudioInputService,
  type RoonAudioInputPlayOptions,
  type RoonAudioInputSession,
  type RoonCore,
  type RoonRequiredServiceConstructor,
  type RoonSdk,
  type RoonSettingsRequest,
  type RoonSettingsService,
  type RoonStatusService,
  type RoonTransportControl,
  type RoonZone,
  type RoonZoneChangeMessage,
} from './sdk.js';
import {
  createRoonLibraryService,
  type RoonBrowseShapeSummary,
  type RoonLibraryService,
} from './library.js';

interface SettingsState {
  output?: {
    output_id?: string;
    display_name?: string;
  };
}

type RoonPlaybackPhase = 'awaiting_session' | 'awaiting_playing';

interface ActiveRoonPlaybackContext {
  generation: number;
  trackId: string;
  session?: RoonAudioInputSession;
  cancel?: () => void;
}

interface PlaybackConfirmationWaiter {
  request: RoonPlaybackConfirmationRequest;
  resolve: (observation: RoonPlaybackObservation) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export type SanitizedRoonErrorClass =
  | 'missing_required_field'
  | 'invalid_zone'
  | 'invalid_icon'
  | 'unknown_service'
  | 'unsupported'
  | 'other'
  | 'none';

export interface RoonResponseBodySummary {
  bodyPresent: boolean;
  bodyType: string;
  bodyKeys: string[];
  errorMessagePresent: boolean;
  sanitizedErrorClass: SanitizedRoonErrorClass;
  sanitizedErrorText?: string;
}

export interface RoonAudioInputAdapterOptions {
  sessionBeginTimeoutMs?: number;
  playingTimeoutMs?: number;
  transportTimeoutMs?: number;
  trackIdFactory?: () => string;
  playbackMode?: 'channel' | 'track';
  mode?: RemoteCoreMode;
  iconPort?: number;
  coreHost?: string;
  corePort?: number;
  onTimeShape?: (summary: RoonTimeShapeSummary) => void;
  onBrowseShape?: (summary: RoonBrowseShapeSummary) => void;
  onImageShape?: (summary: RoonImageShapeSummary) => void;
}

const DEFAULT_SESSION_BEGIN_TIMEOUT_MS = 10_000;
const DEFAULT_PLAYING_TIMEOUT_MS = 30_000;
const DEFAULT_TRANSPORT_TIMEOUT_MS = 10_000;
const MAX_ROON_TIME_SHAPE_KEYS = 16;
const MAX_ROON_TIME_MS = 24 * 60 * 60 * 1_000;

export interface RoonTimeCandidateSummary {
  path: string;
  type: string;
  finite?: boolean;
  safeInteger?: boolean;
  nonNegative?: boolean;
  durationBounded?: boolean;
}

export interface RoonTimeShapeSummary {
  bodyPresent: boolean;
  bodyType: string;
  topLevelKeys: string[];
  nestedKeys: string[];
  candidates: RoonTimeCandidateSummary[];
}

function messageName(message: unknown): string {
  if (typeof message === 'string') return message;
  if (message && typeof message === 'object' && 'name' in message) {
    const name = (message as { name?: unknown }).name;
    return typeof name === 'string' ? name : 'Unknown';
  }
  return 'Unknown';
}

function readSessionId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || !('session_id' in value)) {
    return undefined;
  }
  const sessionId = (value as { session_id?: unknown }).session_id;
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined;
}

function valueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function isSafeKey(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(value);
}

function safeKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value)
    .filter(isSafeKey)
    .sort()
    .slice(0, MAX_ROON_TIME_SHAPE_KEYS);
}

function summarizeCandidate(path: string, value: unknown): RoonTimeCandidateSummary {
  const type = valueType(value);
  if (type !== 'number') return { path, type };
  const numericValue = value as number;
  return {
    path,
    type,
    finite: Number.isFinite(numericValue),
    safeInteger: Number.isSafeInteger(numericValue),
    nonNegative: numericValue >= 0,
    durationBounded: Number.isFinite(numericValue) && numericValue >= 0 && numericValue <= MAX_ROON_TIME_MS,
  };
}

export function summarizeRoonTimePayload(value: unknown): RoonTimeShapeSummary {
  const bodyPresent = value !== undefined && value !== null;
  const bodyType = valueType(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { bodyPresent, bodyType, topLevelKeys: [], nestedKeys: [], candidates: [] };
  }

  const body = value as Record<string, unknown>;
  const topLevelKeys = safeKeys(body);
  const nestedKeys: string[] = [];
  const candidates: RoonTimeCandidateSummary[] = [];
  for (const key of topLevelKeys) {
    const candidate = body[key];
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      const nested = candidate as Record<string, unknown>;
      for (const nestedKey of safeKeys(nested)) {
        const path = `${key}.${nestedKey}`;
        nestedKeys.push(path);
        candidates.push(summarizeCandidate(path, nested[nestedKey]));
      }
      continue;
    }
    candidates.push(summarizeCandidate(key, candidate));
  }

  return { bodyPresent, bodyType, topLevelKeys, nestedKeys, candidates };
}

function readRoonTimeMs(
  value: unknown,
  onTimeShape?: (summary: RoonTimeShapeSummary) => void,
): number | undefined {
  try {
    onTimeShape?.(summarizeRoonTimePayload(value));
  } catch {
    // Sampling must never change playback behavior.
  }

  // A redacted real-Core capture verified that Time uses a non-negative,
  // safe-integer millisecond field named seek_position_ms. Keep all other
  // shapes fail-closed so an upstream protocol change cannot skew lyrics.
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const positionMs = (value as { seek_position_ms?: unknown }).seek_position_ms;
  if (
    typeof positionMs !== 'number' ||
    !Number.isSafeInteger(positionMs) ||
    positionMs < 0 ||
    positionMs > MAX_ROON_TIME_MS
  ) {
    return undefined;
  }
  return positionMs;
}

function readErrorMessage(body: unknown): string | undefined {
  if (typeof body === 'string') return body;
  if (!body || typeof body !== 'object') return undefined;

  for (const key of ['error_message', 'errorMessage', 'message', 'error']) {
    const value = (body as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
    if (value && typeof value === 'object') {
      const nestedMessage = (value as Record<string, unknown>).message;
      if (typeof nestedMessage === 'string' && nestedMessage.trim().length > 0) {
        return nestedMessage;
      }
    }
  }
  return undefined;
}

function classifyRoonError(message: string | undefined): SanitizedRoonErrorClass {
  if (!message) return 'none';
  const normalized = message.toLowerCase();
  if (/(?:missing|required|must\s+provide|mandatory)/.test(normalized)) {
    return 'missing_required_field';
  }
  if (/(?:zone|output)/.test(normalized)) return 'invalid_zone';
  if (/(?:icon|png|image)/.test(normalized)) return 'invalid_icon';
  if (/(?:service|method|endpoint)/.test(normalized)) return 'unknown_service';
  if (/(?:unsupported|not\s+supported)/.test(normalized)) return 'unsupported';
  return 'other';
}

function safeErrorText(errorClass: SanitizedRoonErrorClass): string | undefined {
  switch (errorClass) {
    case 'missing_required_field':
      return 'missing required field';
    case 'invalid_zone':
      return 'invalid zone';
    case 'invalid_icon':
      return 'invalid icon';
    case 'unknown_service':
      return 'unknown service';
    case 'unsupported':
      return 'unsupported';
    case 'other':
      return 'roon request error';
    case 'none':
      return undefined;
  }
}

export const FORMAL_ROON_EXTENSION_ID = 'com.musicbridgeforroon.netease.poc';
export const DEVELOPMENT_ROON_EXTENSION_ID = 'com.musicbridgeforroon.netease.dev';
export const FORMAL_ROON_DISPLAY_NAME = 'Music Bridge for Roon';
export const DEVELOPMENT_ROON_DISPLAY_NAME = 'Music Bridge for Roon — Dev Mac';
export const DEVELOPMENT_ROON_SETTINGS_KEY = 'settings.remote-core-development';

function isLocalPngIconUrl(value: string, expectedPort: number): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      url.port === String(expectedPort) &&
      url.pathname === '/assets/icon.png' &&
      url.search === '' &&
      url.hash === '' &&
      url.username === '' &&
      url.password === ''
    );
  } catch {
    return false;
  }
}

function readGatewayStage(value: unknown): RoonGatewayStage {
  switch (value) {
    case 'headers':
    case 'streaming':
    case 'completed':
    case 'aborted':
    case 'error':
      return value;
    default:
      return 'none';
  }
}

export function summarizeRoonResponseBody(body: unknown): RoonResponseBodySummary {
  const bodyPresent = body !== undefined && body !== null;
  const bodyType = body === null ? 'null' : typeof body;
  const bodyKeys =
    body && typeof body === 'object' ? Object.keys(body).slice(0, 16) : [];
  const errorMessage = readErrorMessage(body);
  const sanitizedErrorClass = classifyRoonError(errorMessage);
  const sanitizedErrorText = safeErrorText(sanitizedErrorClass);

  return {
    bodyPresent,
    bodyType,
    bodyKeys,
    errorMessagePresent: Boolean(errorMessage),
    sanitizedErrorClass,
    ...(sanitizedErrorText ? { sanitizedErrorText } : {}),
  };
}

function isConnectionErrorEvent(event: string): boolean {
  return /^(?:MooError|ConnectionError|ConnectionClosed|ConnectionLost|Disconnected|NetworkError)$/i.test(
    event,
  );
}

function timeoutError(phase: RoonPlaybackPhase): BridgeError {
  const timeoutCode =
    phase === 'awaiting_session'
      ? 'ROON_SESSION_BEGIN_TIMEOUT'
      : 'ROON_PLAYING_TIMEOUT';
  return new BridgeError('ROON_TIMEOUT', timeoutCode, {
    httpStatus: 504,
    details: { phase, timeoutCode },
  });
}

function protocolError(
  phase: RoonPlaybackPhase,
  reason: string,
  event?: string,
): BridgeError {
  return new BridgeError('ROON_MEDIA_ERROR', 'Roon Audio Input session protocol error', {
    httpStatus: 502,
    details: {
      phase,
      reason,
      ...(event ? { event } : {}),
    },
  });
}

function readSettings(value: unknown): SettingsState {
  if (!value || typeof value !== 'object') return {};
  const settings = value as { output?: unknown; zone?: unknown };
  const output = settings.output ?? settings.zone;
  if (!output || typeof output !== 'object') return {};

  const outputId = (output as { output_id?: unknown }).output_id;
  const displayName = (output as { display_name?: unknown; name?: unknown }).display_name
    ?? (output as { name?: unknown }).name;
  return {
    output: {
      ...(typeof outputId === 'string' ? { output_id: outputId } : {}),
      ...(typeof displayName === 'string' ? { display_name: displayName } : {}),
    },
  };
}

function readSettingsInput(value: unknown): SettingsState {
  if (!value || typeof value !== 'object') return {};
  return readSettings((value as { values?: unknown }).values);
}

function readZoneId(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || !('zone_id' in value)) {
    return undefined;
  }
  const zoneId = (value as { zone_id?: unknown }).zone_id;
  return typeof zoneId === 'string' ? zoneId : undefined;
}

function isRoonZone(value: unknown): value is RoonZone {
  if (!value || typeof value !== 'object' || !('zone_id' in value)) {
    return false;
  }
  return typeof (value as { zone_id?: unknown }).zone_id === 'string';
}

function readZonePositionMs(zone: RoonZone | undefined): number | undefined {
  const seconds = zone?.now_playing?.seek_position ?? zone?.seek_position;
  if (
    typeof seconds !== 'number' ||
    !Number.isFinite(seconds) ||
    seconds < 0 ||
    seconds > MAX_ROON_TIME_MS / 1_000
  ) return undefined;
  const milliseconds = Math.round(seconds * 1_000);
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

function readDisplayLine(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().replace(/\s+/gu, ' ');
  return normalized.length > 0 && normalized.length <= 512 ? normalized : undefined;
}

function readZoneNowPlaying(zone: RoonZone | undefined): RoonPlaybackObservation['nowPlaying'] {
  const nowPlaying = zone?.now_playing;
  if (!nowPlaying) return undefined;
  const title = readDisplayLine(
    nowPlaying.three_line?.line1
      ?? nowPlaying.two_line?.line1
      ?? nowPlaying.one_line?.line1,
  );
  const artist = readDisplayLine(
    nowPlaying.three_line?.line2
      ?? nowPlaying.two_line?.line2,
  );
  const album = readDisplayLine(nowPlaying.three_line?.line3);
  const durationMs = typeof nowPlaying.length === 'number'
    && Number.isFinite(nowPlaying.length)
    && nowPlaying.length >= 0
    && nowPlaying.length <= MAX_ROON_TIME_MS / 1_000
    ? Math.round(nowPlaying.length * 1_000)
    : undefined;
  if (!title && !artist && !album && durationMs === undefined) return undefined;
  return {
    ...(title ? { title } : {}),
    ...(artist ? { artist } : {}),
    ...(album ? { album } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

function normalizedIdentity(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
}

function normalizedTrackIdentity(value: string): string {
  return normalizedIdentity(value).replace(
    /^\d{1,3}\s*(?:[.．、:：)]|[-–—])\s+/u,
    '',
  );
}

function relatedIdentity(left: string, right: string): boolean {
  const normalizedLeft = normalizedIdentity(left);
  const normalizedRight = normalizedIdentity(right);
  return normalizedLeft === normalizedRight
    || normalizedLeft.includes(normalizedRight)
    || normalizedRight.includes(normalizedLeft);
}

function observationMatchesTrack(
  observation: RoonPlaybackObservation,
  track: NonNullable<RoonPlaybackConfirmationRequest['track']>,
): boolean {
  const nowPlaying = observation.nowPlaying;
  if (
    !nowPlaying?.title
    || normalizedTrackIdentity(nowPlaying.title) !== normalizedTrackIdentity(track.title)
  ) {
    return false;
  }
  const corroborations: boolean[] = [];
  if (nowPlaying.artist) {
    corroborations.push(track.artists.some((artist) => relatedIdentity(nowPlaying.artist!, artist)));
  }
  if (nowPlaying.album) corroborations.push(relatedIdentity(nowPlaying.album, track.album));
  if (nowPlaying.durationMs !== undefined && track.durationMs !== undefined) {
    corroborations.push(Math.abs(nowPlaying.durationMs - track.durationMs) <= 2_000);
  }
  return corroborations.length === 0 || corroborations.some(Boolean);
}

function observationMatchesRequest(
  observation: RoonPlaybackObservation | undefined,
  request: RoonPlaybackConfirmationRequest,
): observation is RoonPlaybackObservation {
  const stateMatches = request.state === 'inactive'
    ? observation?.state === 'paused' || observation?.state === 'stopped'
    : observation?.state === request.state;
  return Boolean(
    observation
    && observation.revision > request.afterRevision
    && observation.zoneId === request.zoneId
    && stateMatches
    && (!request.requirePosition || observation.positionMs !== undefined)
    && (request.positionMs === undefined
      || (observation.positionMs !== undefined
        && Math.abs(observation.positionMs - request.positionMs) <= 1_500))
    && (!request.track || observationMatchesTrack(observation, request.track)),
  );
}

export class RoonAudioInputAdapter implements RoonPort {
  private roon: RoonApiInstance | undefined;
  private core: RoonCore | undefined;
  private statusService: RoonStatusService | undefined;
  private audioInput: RoonAudioInputService | undefined;
  private libraryService: RoonLibraryService | undefined;
  private settings: SettingsState = {};
  private readonly zones = new Map<string, RoonZone>();
  private selectedZone: RoonZone | undefined;
  private zoneRevision = 0;
  private playbackGeneration = 0;
  private activePlaybackContext: ActiveRoonPlaybackContext | undefined;
  private state: RoonState = { status: 'discovering' };
  private terminalHandler: (reason: RoonTerminalReason) => void = () => undefined;
  private readonly sessionBeginTimeoutMs: number;
  private readonly playingTimeoutMs: number;
  private readonly transportTimeoutMs: number;
  private readonly trackIdFactory: () => string;
  private readonly playbackMode: 'channel' | 'track';
  private readonly mode: RemoteCoreMode;
  private readonly iconPort: number;
  private readonly coreHost: string | undefined;
  private readonly corePort: number | undefined;
  private readonly settingsKey: string;
  private readonly extensionId: string;
  private readonly displayName: string;
  private readonly onTimeShape: ((summary: RoonTimeShapeSummary) => void) | undefined;
  private readonly onBrowseShape: ((summary: RoonBrowseShapeSummary) => void) | undefined;
  private readonly onImageShape: ((summary: RoonImageShapeSummary) => void) | undefined;
  private activeTimerCount = 0;
  private stateHandler: () => void = () => undefined;
  private timeHandler: (event: RoonTimeEvent) => void = () => undefined;
  private readonly playbackConfirmationWaiters = new Set<PlaybackConfirmationWaiter>();

  constructor(
    private readonly logger: Logger,
    private readonly sdk: RoonSdk = createProductionRoonSdk(),
    options: RoonAudioInputAdapterOptions = {},
  ) {
    this.sessionBeginTimeoutMs = options.sessionBeginTimeoutMs ?? DEFAULT_SESSION_BEGIN_TIMEOUT_MS;
    this.playingTimeoutMs = options.playingTimeoutMs ?? DEFAULT_PLAYING_TIMEOUT_MS;
    this.transportTimeoutMs = options.transportTimeoutMs ?? DEFAULT_TRANSPORT_TIMEOUT_MS;
    this.trackIdFactory = options.trackIdFactory ?? (() => `musicbridge-${randomUUID()}`);
    this.playbackMode = options.playbackMode ?? 'track';
    this.mode = options.mode ?? 'local-core';
    this.iconPort = options.iconPort ?? 38502;
    this.coreHost = options.coreHost;
    this.corePort = options.corePort;
    this.settingsKey =
      this.mode === 'remote-core-development' ? DEVELOPMENT_ROON_SETTINGS_KEY : 'settings';
    this.extensionId =
      this.mode === 'remote-core-development'
        ? DEVELOPMENT_ROON_EXTENSION_ID
        : FORMAL_ROON_EXTENSION_ID;
    this.displayName =
      this.mode === 'remote-core-development'
        ? DEVELOPMENT_ROON_DISPLAY_NAME
        : FORMAL_ROON_DISPLAY_NAME;
    this.onTimeShape = options.onTimeShape;
    this.onBrowseShape = options.onBrowseShape;
    this.onImageShape = options.onImageShape;
  }

  setTerminalHandler(handler: (reason: RoonTerminalReason) => void): void {
    this.terminalHandler = handler;
  }

  setStateHandler(handler: () => void): void {
    this.stateHandler = handler;
  }

  setTimeHandler(handler: (event: RoonTimeEvent) => void): void {
    this.timeHandler = handler;
  }

  listZones(): readonly RoonZone[] {
    return [...this.zones.values()].map((zone) => ({
      ...zone,
      ...(zone.outputs ? { outputs: zone.outputs.map((output) => ({ ...output })) } : {}),
    }));
  }

  getLibraryService(): RoonLibraryService | undefined {
    return this.libraryService;
  }

  selectZone(zoneId: string): void {
    const zone = this.zones.get(zoneId);
    if (!zone) {
      throw new BridgeError('ROON_ZONE_NOT_SELECTED', 'Requested Roon Zone is unavailable', {
        httpStatus: 409,
      });
    }
    const output = zone.outputs?.find(
      (candidate) => typeof candidate.output_id === 'string' && candidate.output_id.length > 0,
    );
    if (!output?.output_id) {
      throw new BridgeError('ROON_ZONE_NOT_SELECTED', 'Requested Roon Zone has no output', {
        httpStatus: 409,
      });
    }
    this.settings = {
      output: {
        output_id: output.output_id,
        ...(output.display_name ? { display_name: output.display_name } : {}),
      },
    };
    this.roon?.save_config(this.settingsKey, this.settings);
    this.updateSelectedZone();
  }

  async start(): Promise<void> {
    if (this.roon) return;

    this.roon = this.sdk.createApi({
      extension_id: this.extensionId,
      display_name: this.displayName,
      display_version: '0.1.0-beta.2',
      publisher: this.displayName,
      email: 'local-only@example.invalid',
      website: 'https://github.com/RoonLabs/roon-connect-stream-example',
      log_level: 'none',
      force_server: true,
      core_paired: (core) => this.onCorePaired(core),
      core_unpaired: () => this.onCoreUnpaired(),
    });

    this.settings = readSettings(this.roon.load_config(this.settingsKey));

    const settingsService: RoonSettingsService = this.sdk.createSettings(this.roon, {
      get_settings: (callback: (layout: unknown) => void) => {
        callback(this.makeSettingsLayout(this.settings));
      },
      save_settings: (
        request: RoonSettingsRequest,
        _isDryRun: boolean,
        incoming: unknown,
      ) => {
        const next = readSettingsInput(incoming);
        const layout = this.makeSettingsLayout(next);
        request.send_complete('Success', { settings: layout });
        this.settings = next;
        this.roon?.save_config(this.settingsKey, this.settings);
        this.updateSelectedZone();
      },
    });

    this.statusService = this.sdk.createStatus(this.roon);
    const requiredServices: RoonRequiredServiceConstructor[] = [
      this.sdk.audioInputService,
      this.sdk.transportService,
    ];
    // Browse/Image are capability additions. They must not prevent the
    // transport extension from pairing when a Core does not authorize them.
    const optionalServices = [this.sdk.browseService, this.sdk.imageService]
      .filter((service): service is RoonRequiredServiceConstructor => service !== undefined);
    this.roon.init_services({
      provided_services: [settingsService, this.statusService],
      required_services: requiredServices,
      optional_services: optionalServices,
    });
    if (this.coreHost && this.corePort && this.roon.ws_connect) {
      this.roon.ws_connect({
        host: this.coreHost,
        port: this.corePort,
        onerror: () => {
          this.logger.warn('roon_connection_error', { phase: 'direct_connect' });
        },
      });
    } else {
      this.roon.start_discovery();
    }
    this.setStatus('discovering', 'Ready to pair', true);
  }

  async play(request: RoonPlayRequest): Promise<void> {
    if (!this.core || !this.audioInput) {
      throw new BridgeError('ROON_NOT_PAIRED', 'Roon is not paired with the extension', {
        httpStatus: 503,
      });
    }
    if (!this.selectedZone) {
      throw new BridgeError(
        'ROON_ZONE_NOT_SELECTED',
        'Select a Roon Zone in Settings → Extensions → Music Bridge',
        { httpStatus: 409 },
      );
    }

    await this.stop();
    const selectedZone = this.selectedZone;
    if (
      !selectedZone ||
      typeof selectedZone.zone_id !== 'string' ||
      selectedZone.zone_id.length === 0
    ) {
      this.setStatus('paired', 'Please configure Zone', true);
      throw new BridgeError(
        'ROON_ZONE_NOT_SELECTED',
        'Selected Roon Zone is no longer available',
        { httpStatus: 409 },
      );
    }
    const selectedZoneSnapshot = Object.freeze({ zone_id: selectedZone.zone_id });
    const iconUrlPresent =
      typeof request.iconUrl === 'string' && request.iconUrl.length > 0;
    if (!iconUrlPresent || !isLocalPngIconUrl(request.iconUrl, this.iconPort)) {
      throw new BridgeError(
        'ROON_MEDIA_ERROR',
        'Roon Audio Input requires a local PNG icon URL',
        { httpStatus: 502, details: { reason: 'invalid_icon_url' } },
      );
    }
    this.setStatus('ready', 'Preparing stream…', false);
    const audioInput = this.audioInput;
    if (!audioInput) {
      throw new BridgeError('ROON_NOT_PAIRED', 'Roon is not paired with the extension', {
        httpStatus: 503,
      });
    }

    const trackId = this.trackIdFactory();
    if (typeof trackId !== 'string' || trackId.length === 0) {
      throw new BridgeError('ROON_MEDIA_ERROR', 'Roon track identity could not be generated', {
        httpStatus: 502,
        details: { reason: 'invalid_track_identity' },
      });
    }
    const generation = ++this.playbackGeneration;
    const playbackContext: ActiveRoonPlaybackContext = { generation, trackId };
    this.activePlaybackContext = playbackContext;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let phase: RoonPlaybackPhase = 'awaiting_session';
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const startedAt = Date.now();

      const releaseTimeout = (): void => {
        if (!timeout) return;
        clearTimeout(timeout);
        timeout = undefined;
        this.activeTimerCount = Math.max(0, this.activeTimerCount - 1);
      };

      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        releaseTimeout();
        if (error) this.clearPlaybackContext(generation);
        if (error) reject(error);
        else resolve();
      };

      playbackContext.cancel = () => {
        finish(protocolError(phase, 'stopped_by_new_playback'));
      };

      const armTimeout = (nextPhase: RoonPlaybackPhase, durationMs: number): void => {
        phase = nextPhase;
        releaseTimeout();
        this.activeTimerCount += 1;
        timeout = setTimeout(() => {
          timeout = undefined;
          this.activeTimerCount = Math.max(0, this.activeTimerCount - 1);
          const generationCurrent = this.isCurrentPlaybackGeneration(generation);
          this.logger.warn('roon_session_timeout', {
            phase: nextPhase,
            elapsedMs: Date.now() - startedAt,
            generationCurrent,
            staleCallback: !generationCurrent,
          });
          if (!generationCurrent) return;
          finish(timeoutError(nextPhase));
        }, durationMs);
      };

      const finishZoneLoss = (): void => {
        this.selectedZone = undefined;
        this.setStatus('paired', 'Please configure Zone', true);
        this.clearPlaybackContext(generation);
        this.terminalHandler('zone_lost');
        finish(
          new BridgeError(
            'ROON_ZONE_NOT_SELECTED',
            'Selected Roon Zone was lost',
            { httpStatus: 409, details: { phase } },
          ),
        );
      };

      const handlePlayEvent = (playMessage: unknown, playBody: unknown): void => {
        const event = messageName(playMessage);
        const generationCurrent = this.isCurrentPlaybackGeneration(generation);
        const staleCallback = !generationCurrent;
        const responseSummary = summarizeRoonResponseBody(playBody);
        const trackIdPresent =
          generationCurrent && this.activePlaybackContext?.trackId === trackId;
        let gatewayStage: RoonGatewayStage = 'none';
        try {
          gatewayStage = readGatewayStage(request.gatewayStage?.());
        } catch {
          gatewayStage = 'none';
        }
        this.logger.info('roon_play_event', {
          phase: 'awaiting_playing',
          eventName: event,
          elapsedMs: Date.now() - startedAt,
          bodyPresent: responseSummary.bodyPresent,
          bodyKeys: responseSummary.bodyKeys,
          sanitizedErrorClass: responseSummary.sanitizedErrorClass,
          generationCurrent,
          staleCallback,
          trackIdPresent,
          gatewayStage,
        });
        if (staleCallback) return;
        switch (event) {
          case 'Playing':
            this.setStatus('playing', 'Playing', false);
            this.setTransportState('playing');
            finish();
            break;
          case 'Time':
            {
              const positionMs = readRoonTimeMs(playBody, this.onTimeShape);
              const observation = this.getSelectedZonePlaybackObservation();
              if (positionMs !== undefined && observation) {
                this.timeHandler({
                  positionMs,
                  source: 'audio-input',
                  zoneId: observation.zoneId,
                  revision: observation.revision,
                  playbackEpoch: generation,
                  ...(observation.nowPlaying ? { nowPlaying: observation.nowPlaying } : {}),
                });
              }
            }
            break;
          case 'EndedNaturally':
            this.setStatus('ready', 'Ready', false);
            this.setTransportState('stopped');
            this.terminalHandler('ended');
            this.clearPlaybackContext(generation);
            if (!settled) finish(protocolError('awaiting_playing', 'ended_before_playing', event));
            break;
          case 'StoppedUser':
            this.setStatus('ready', 'Ready', false);
            this.setTransportState('stopped');
            this.terminalHandler('stopped');
            this.clearPlaybackContext(generation);
            if (!settled) finish(protocolError('awaiting_playing', 'stopped_before_playing', event));
            break;
          case 'Paused':
            // Audio Input reports an external Roon pause through this callback.
            // It is a live session state, not a terminal stop.
            this.setStatus('paused', 'Paused', false);
            this.setTransportState('paused');
            if (!settled) finish();
            break;
          case 'MediaError':
            this.setStatus('error', 'Media error', true, 'Roon MediaError');
            this.terminalHandler('media_error');
            this.clearPlaybackContext(generation);
            finish(
              new BridgeError('ROON_MEDIA_ERROR', 'Roon reported a media error', {
                httpStatus: 502,
                details: { phase: 'awaiting_playing', event },
              }),
            );
            break;
          case 'ZoneNotFound':
          case 'ZoneLost':
            finishZoneLoss();
            break;
          default:
            if (!settled) finish(protocolError('awaiting_playing', 'unexpected_play_event', event));
            break;
        }
      };

      const handleSessionEvent = (sessionMessage: unknown, body: unknown): void => {
        const sessionEvent = messageName(sessionMessage);
        const generationCurrent = this.isCurrentPlaybackGeneration(generation);
        const staleCallback = !generationCurrent;
        const sessionId = readSessionId(body);
        const responseSummary = summarizeRoonResponseBody(body);
        this.logger.info('roon_session_event', {
          phase,
          eventName: sessionEvent,
          generationCurrent,
          staleCallback,
          trackIdPresent: generationCurrent && this.activePlaybackContext?.trackId === trackId,
          hasSessionId: Boolean(sessionId),
          sanitizedErrorClass: responseSummary.sanitizedErrorClass,
        });
        if (staleCallback) return;

        if (sessionEvent === 'SessionBegan') {
          if (settled) return;
          if (!sessionId) {
            this.logger.warn('roon_session_began', {
              phase,
              hasSessionId: false,
            });
            finish(protocolError(phase, 'missing_session_id', sessionEvent));
            return;
          }

          armTimeout('awaiting_playing', this.playingTimeoutMs);
          this.logger.info('roon_session_began', {
            phase: 'awaiting_playing',
            hasSessionId: true,
          });

          try {
            audioInput.update_transport_controls(
              {
                session_id: sessionId,
                controls: {
                  is_previous_allowed: false,
                  is_next_allowed: false,
                },
              },
              () => undefined,
            );
            this.logger.info('roon_play_requested', { phase: 'awaiting_playing' });
            const playOptions: RoonAudioInputPlayOptions = {
              session_id: sessionId,
              track_id: trackId,
              type: this.playbackMode,
              slot: 'play',
              media_url: request.mediaUrl,
              ...(this.playbackMode === 'track' ? { seek_position_ms: 0 } : {}),
              info: {
                // V1 Provider Audio Input remains read-only. V2 native Roon
                // playback uses the Zone transport path for seek instead.
                is_seek_allowed: false,
                is_pause_allowed: true,
                ...(this.playbackMode === 'track' && request.metadata.durationMs !== undefined
                  ? { length: request.metadata.durationMs / 1000 }
                  : {}),
                one_line: { line1: request.metadata.title },
                two_line: {
                  line1: request.metadata.title,
                  line2: request.metadata.artists.join(' / '),
                },
                three_line: {
                  line1: request.metadata.title,
                  line2: request.metadata.artists.join(' / '),
                  line3: request.metadata.album,
                },
              },
            };
            audioInput.play(playOptions, handlePlayEvent);
          } catch (error) {
            this.logger.warn('roon_connection_error', {
              phase: 'awaiting_playing',
              reason: 'play_request_failed',
              generationCurrent: true,
              staleCallback: false,
              trackIdPresent: true,
            });
            finish(protocolError('awaiting_playing', 'play_request_failed'));
          }
          return;
        }

        if (sessionEvent === 'ZoneNotFound' || sessionEvent === 'ZoneLost') {
          finishZoneLoss();
          return;
        }

        if (sessionEvent === 'InvalidRequest') {
          if (!settled) finish(protocolError(phase, 'invalid_request', sessionEvent));
          return;
        }

        if (sessionEvent === 'SessionEnded') {
          this.setStatus('ready', 'Ready', false);
          this.clearPlaybackContext(generation);
          if (!settled) finish(protocolError(phase, 'session_ended', sessionEvent));
          return;
        }

        if (isConnectionErrorEvent(sessionEvent)) {
          this.logger.warn('roon_connection_error', {
            phase,
            eventName: sessionEvent,
            generationCurrent,
            staleCallback,
            trackIdPresent: generationCurrent && this.activePlaybackContext?.trackId === trackId,
          });
          if (!settled) finish(protocolError(phase, 'connection_error', sessionEvent));
          return;
        }

        if (!settled) {
          finish(protocolError(phase, 'unexpected_session_event', sessionEvent));
        }
      };

      armTimeout('awaiting_session', this.sessionBeginTimeoutMs);
      this.logger.info('roon_begin_session_requested', {
        phase: 'awaiting_session',
        zoneIdPresent: true,
        iconUrlPresent: true,
        iconKind: 'local-png',
      });

      try {
        const session = audioInput.begin_session(
          {
            zone_id: selectedZoneSnapshot.zone_id,
            display_name: this.displayName,
            icon_url: request.iconUrl,
          },
          handleSessionEvent,
        );
        if (this.isCurrentPlaybackGeneration(generation)) {
          playbackContext.session = session;
        } else {
          session.end_session(() => undefined);
        }
      } catch (error) {
        this.logger.warn('roon_connection_error', {
          phase: 'awaiting_session',
          reason: 'begin_session_failed',
          generationCurrent: this.isCurrentPlaybackGeneration(generation),
          staleCallback: false,
          trackIdPresent: this.isCurrentPlaybackGeneration(generation),
        });
        finish(protocolError('awaiting_session', 'begin_session_failed'));
      }
    });
  }

  async seek(positionMs: number): Promise<void> {
    if (
      !Number.isSafeInteger(positionMs) ||
      positionMs < 0 ||
      positionMs > MAX_ROON_TIME_MS
    ) {
      throw new BridgeError('BAD_REQUEST', 'Roon seek position is invalid', { httpStatus: 400 });
    }
    const zone = this.selectedZone;
    const transport = this.core?.services.RoonApiTransport;
    if (!zone || !transport) {
      throw new BridgeError('ROON_ZONE_NOT_SELECTED', 'Roon Zone is not selected', { httpStatus: 409 });
    }
    if (zone.is_seek_allowed !== true) {
      throw new BridgeError('ROON_TRANSPORT_UNAVAILABLE', 'Roon seek is not available for this Zone', {
        httpStatus: 409,
      });
    }
    const observation = this.getSelectedZonePlaybackObservation();
    if (!observation) {
      throw new BridgeError('ROON_ZONE_NOT_SELECTED', 'Roon Zone is not selected', {
        httpStatus: 409,
      });
    }
    await this.runTransportRequest(
      'seek',
      (callback) => transport.seek(zone.zone_id, 'absolute', positionMs / 1_000, callback),
      () => new BridgeError('ROON_TIMEOUT', 'Roon seek request failed', { httpStatus: 502 }),
    );
    await this.waitForSelectedZonePlayback({
      zoneId: observation.zoneId,
      state: observation.state === 'paused' ? 'paused' : 'playing',
      afterRevision: observation.revision,
      requirePosition: true,
      positionMs,
    });
  }

  async control(
    control: 'play' | 'pause' | 'playpause' | 'stop' | 'previous' | 'next',
  ): Promise<void> {
    const zone = this.selectedZone;
    const transport = this.core?.services.RoonApiTransport;
    if (!zone || !transport) {
      throw new BridgeError('ROON_ZONE_NOT_SELECTED', 'Roon Zone is not selected', { httpStatus: 409 });
    }
    const allowed = control === 'pause'
      ? zone.is_pause_allowed
      : control === 'play'
        ? zone.is_play_allowed
        : control === 'previous'
          ? zone.is_previous_allowed
          : control === 'next'
            ? zone.is_next_allowed
            : true;
    if (allowed !== true) {
      throw new BridgeError('ROON_TRANSPORT_UNAVAILABLE', 'Roon transport control is not available', {
        httpStatus: 409,
      });
    }
    const beforeStop = control === 'stop'
      ? this.getSelectedZonePlaybackObservation()
      : undefined;
    await this.runTransportRequest(
      control,
      (callback) => transport.control(zone.zone_id, control, callback),
      () => new BridgeError('ROON_TIMEOUT', 'Roon transport request failed', { httpStatus: 502 }),
    );
    if (beforeStop) {
      await this.waitForSelectedZonePlayback({
        zoneId: beforeStop.zoneId,
        state: 'inactive',
        afterRevision: beforeStop.revision,
      });
    }
  }

  async stop(): Promise<void> {
    const playbackContext = this.activePlaybackContext;
    this.activePlaybackContext = undefined;
    this.playbackGeneration += 1;
    playbackContext?.cancel?.();
    const session = playbackContext?.session;
    if (playbackContext) delete playbackContext.session;
    if (!session) return;

    await new Promise<void>((resolve) => {
      let done = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const releaseTimeout = (): void => {
        if (!timeout) return;
        clearTimeout(timeout);
        timeout = undefined;
        this.activeTimerCount = Math.max(0, this.activeTimerCount - 1);
      };
      const finish = (): void => {
        if (done) return;
        done = true;
        releaseTimeout();
        resolve();
      };
      this.activeTimerCount += 1;
      timeout = setTimeout(finish, 2_000);
      session.end_session(() => {
        finish();
      });
    });

    if (this.core && this.selectedZone) {
      this.setStatus('ready', 'Ready', false);
      this.setTransportState('stopped');
    }
  }

  async pause(): Promise<void> {
    const observation = this.getSelectedZonePlaybackObservation();
    if (!observation) {
      throw new BridgeError('ROON_ZONE_NOT_SELECTED', 'Roon Zone is not selected', {
        httpStatus: 409,
      });
    }
    await this.controlTransport('pause', 'is_pause_allowed');
    await this.waitForSelectedZonePlayback({
      zoneId: observation.zoneId,
      state: 'paused',
      afterRevision: observation.revision,
    });
  }

  async resume(): Promise<void> {
    const observation = this.getSelectedZonePlaybackObservation();
    if (!observation) {
      throw new BridgeError('ROON_ZONE_NOT_SELECTED', 'Roon Zone is not selected', {
        httpStatus: 409,
      });
    }
    await this.controlTransport('play', 'is_play_allowed');
    await this.waitForSelectedZonePlayback({
      zoneId: observation.zoneId,
      state: 'playing',
      afterRevision: observation.revision,
      requirePosition: true,
    });
  }

  async shutdown(): Promise<void> {
    await this.stop();
    this.rejectPlaybackConfirmations(new BridgeError(
      'ROON_ZONE_NOT_SELECTED',
      'Roon adapter stopped before playback confirmation',
      { httpStatus: 409 },
    ));
    try {
      this.roon?.stop_discovery?.();
      this.roon?.disconnect_all?.();
    } finally {
      this.roon = undefined;
      this.core = undefined;
      this.audioInput = undefined;
      this.libraryService = undefined;
      this.terminalHandler = () => undefined;
      this.stateHandler = () => undefined;
      this.timeHandler = () => undefined;
      this.activeTimerCount = 0;
      this.zones.clear();
      this.selectedZone = undefined;
      this.zoneRevision += 1;
      this.state = { status: 'discovering' };
    }
  }

  getState(): RoonState {
    return { ...this.state };
  }

  getSelectedZonePlaybackState(): RoonNativePlaybackState | undefined {
    return this.selectedZone?.state;
  }

  getSelectedZonePlaybackObservation(): RoonPlaybackObservation | undefined {
    const zone = this.selectedZone;
    if (!zone) return undefined;
    const positionMs = readZonePositionMs(zone);
    const nowPlaying = readZoneNowPlaying(zone);
    return {
      revision: this.zoneRevision,
      zoneId: zone.zone_id,
      ...(zone.state ? { state: zone.state } : {}),
      ...(positionMs !== undefined ? { positionMs } : {}),
      ...(nowPlaying ? { nowPlaying } : {}),
    };
  }

  waitForSelectedZonePlayback(
    request: RoonPlaybackConfirmationRequest,
  ): Promise<RoonPlaybackObservation> {
    if (
      request.zoneId.trim().length === 0
      || request.zoneId.length > 128
      || !Number.isSafeInteger(request.afterRevision)
      || request.afterRevision < 0
      || (request.positionMs !== undefined
        && (!Number.isSafeInteger(request.positionMs)
          || request.positionMs < 0
          || request.positionMs > MAX_ROON_TIME_MS))
    ) {
      return Promise.reject(new BridgeError(
        'BAD_REQUEST',
        'Roon playback confirmation request is invalid',
        { httpStatus: 400 },
      ));
    }
    const current = this.getSelectedZonePlaybackObservation();
    if (observationMatchesRequest(current, request)) return Promise.resolve(current);
    return new Promise<RoonPlaybackObservation>((resolve, reject) => {
      const finish = (
        waiter: PlaybackConfirmationWaiter,
        observation?: RoonPlaybackObservation,
        error?: Error,
      ): void => {
        if (!this.playbackConfirmationWaiters.delete(waiter)) return;
        clearTimeout(waiter.timeout);
        this.activeTimerCount = Math.max(0, this.activeTimerCount - 1);
        if (error) reject(error);
        else if (observation) resolve(observation);
      };
      const waiter = {} as PlaybackConfirmationWaiter;
      this.activeTimerCount += 1;
      waiter.request = request;
      waiter.resolve = (observation) => finish(waiter, observation);
      waiter.reject = (error) => finish(waiter, undefined, error);
      waiter.timeout = setTimeout(() => {
        waiter.reject(new BridgeError(
          'ROON_TIMEOUT',
          `Roon did not confirm transport state ${request.state}`,
          {
            httpStatus: 504,
            details: {
              operation: request.state === 'paused'
                ? 'pause'
                : request.state === 'stopped' || request.state === 'inactive'
                  ? 'stop'
                  : 'play',
            },
          },
        ));
      }, this.transportTimeoutMs);
      this.playbackConfirmationWaiters.add(waiter);
      this.flushPlaybackConfirmations();
    });
  }

  getActivePlaybackEpoch(): number | undefined {
    return this.activePlaybackContext?.generation;
  }

  getDiagnosticResourceCounters(): {
    activeSessionCount: number;
    listenerCount: number;
    timerCount: number;
  } {
    return {
      activeSessionCount: this.activePlaybackContext ? 1 : 0,
      listenerCount: this.roon ? 1 : 0,
      timerCount: this.activeTimerCount,
    };
  }

  private flushPlaybackConfirmations(): void {
    const observation = this.getSelectedZonePlaybackObservation();
    if (!observation) return;
    for (const waiter of [...this.playbackConfirmationWaiters]) {
      if (observationMatchesRequest(observation, waiter.request)) waiter.resolve(observation);
    }
  }

  private rejectPlaybackConfirmations(error: Error): void {
    for (const waiter of [...this.playbackConfirmationWaiters]) waiter.reject(error);
  }

  private isCurrentPlaybackGeneration(generation: number): boolean {
    return this.activePlaybackContext?.generation === generation;
  }

  private clearPlaybackContext(generation: number): void {
    if (!this.isCurrentPlaybackGeneration(generation)) return;
    this.activePlaybackContext = undefined;
  }

  private onCorePaired(core: RoonCore): void {
    this.core = core;
    this.audioInput = core.services.RoonApiAudioInput;
    this.libraryService =
      core.services.RoonApiBrowse && core.services.RoonApiImage
        ? createRoonLibraryService({
            browse: core.services.RoonApiBrowse,
            image: core.services.RoonApiImage,
            ...(this.onBrowseShape ? { onBrowseShape: this.onBrowseShape } : {}),
            ...(this.onImageShape ? { onImageShape: this.onImageShape } : {}),
            zoneOrOutputId: () => this.selectedZone?.zone_id,
          })
        : undefined;
    this.state = {
      status: 'paired',
      ...(typeof core.display_name === 'string' ? { coreName: core.display_name } : {}),
    };
    this.setStatus('paired', 'Initializing…', false);

    core.services.RoonApiTransport.subscribe_zones(
      (response: string, message: RoonZoneChangeMessage) => {
        if (response === 'Subscribed') {
          this.zoneRevision += 1;
          this.zones.clear();
          for (const zone of message.zones ?? []) this.storeZone(zone);
        } else if (response === 'Changed') {
          this.zoneRevision += 1;
          for (const zone of message.zones_added ?? []) this.storeZone(zone);
          for (const zone of message.zones_changed ?? []) this.storeZone(zone);
          for (const zone of message.zones_removed ?? []) {
            const zoneId = readZoneId(zone);
            if (zoneId) this.zones.delete(zoneId);
          }
        }
        this.updateSelectedZone();
        this.flushPlaybackConfirmations();
        const positionMs = readZonePositionMs(this.selectedZone);
        const observation = this.getSelectedZonePlaybackObservation();
        if (positionMs !== undefined && observation) {
          this.timeHandler({
            positionMs,
            source: 'zone',
            zoneId: observation.zoneId,
            revision: observation.revision,
            ...(this.activePlaybackContext
              ? { playbackEpoch: this.activePlaybackContext.generation }
              : {}),
            ...(observation.nowPlaying ? { nowPlaying: observation.nowPlaying } : {}),
          });
        }
      },
    );

    this.logger.info('roon_core_paired');
  }

  private onCoreUnpaired(): void {
    this.rejectPlaybackConfirmations(new BridgeError(
      'ROON_ZONE_NOT_SELECTED',
      'Roon Core disconnected before playback confirmation',
      { httpStatus: 409 },
    ));
    this.core = undefined;
    this.audioInput = undefined;
    this.libraryService = undefined;
    this.zones.clear();
    this.selectedZone = undefined;
    this.zoneRevision += 1;
    this.state = { status: 'discovering' };
    this.setStatus('discovering', 'Ready to pair', true);
    this.logger.warn('roon_core_unpaired');
  }

  private storeZone(value: unknown): void {
    if (isRoonZone(value)) this.zones.set(value.zone_id, value);
  }

  private updateSelectedZone(): void {
    const outputId = this.settings.output?.output_id;
    this.selectedZone = undefined;

    if (outputId) {
      for (const zone of this.zones.values()) {
        if (zone.outputs?.some((output) => output.output_id === outputId)) {
          this.selectedZone = zone;
          break;
        }
      }
    }

    if (!this.core) {
      this.state = { status: 'discovering' };
      this.setStatus('discovering', 'Ready to pair', true);
      return;
    }

    const coreName =
      typeof this.core.display_name === 'string' ? this.core.display_name : undefined;
    if (!this.selectedZone) {
      this.state = {
        status: 'paired',
        ...(coreName ? { coreName } : {}),
      };
      this.setStatus('paired', 'Please configure Zone', true);
      return;
    }

    const transportState = this.selectedZone.state ?? this.state.transportState;
    const status: RoonState['status'] =
      transportState === 'paused'
        ? 'paused'
        : transportState === 'playing' || transportState === 'loading'
          ? 'playing'
          : this.state.status === 'playing' || this.state.status === 'paused'
            ? this.state.status
            : 'ready';
    this.state = {
      status,
      ...(coreName ? { coreName } : {}),
      selectedZoneId: this.selectedZone.zone_id,
      selectedZoneName: this.selectedZone.display_name ?? this.selectedZone.zone_id,
      ...(transportState ? { transportState } : {}),
      ...(typeof this.selectedZone.is_pause_allowed === 'boolean'
        ? { canPause: this.selectedZone.is_pause_allowed }
        : this.state.canPause !== undefined
          ? { canPause: this.state.canPause }
          : {}),
      ...(typeof this.selectedZone.is_play_allowed === 'boolean'
        ? { canResume: this.selectedZone.is_play_allowed }
        : this.state.canResume !== undefined
          ? { canResume: this.state.canResume }
          : {}),
    };
    this.statusService?.set_status(
      status === 'paused' ? 'Paused' : status === 'playing' ? 'Playing' : 'Ready',
      false,
    );
    this.stateHandler();
  }

  private setTransportState(transportState: RoonTransportState): void {
    const status: RoonState['status'] =
      transportState === 'paused'
        ? 'paused'
        : transportState === 'playing' || transportState === 'loading'
          ? 'playing'
          : this.core && this.selectedZone
            ? 'ready'
            : this.state.status;
    this.state = {
      ...this.state,
      status,
      transportState,
      ...(transportState === 'paused' && this.state.canPause !== undefined
        ? { canPause: false, canResume: this.selectedZone?.is_play_allowed === true }
        : transportState === 'playing' && this.state.canResume !== undefined
          ? { canPause: this.selectedZone?.is_pause_allowed === true, canResume: false }
          : {}),
    };
    this.stateHandler();
  }

  private async controlTransport(
    control: RoonTransportControl,
    capability: 'is_pause_allowed' | 'is_play_allowed',
  ): Promise<void> {
    if (!this.core || !this.selectedZone || !this.activePlaybackContext) {
      throw new BridgeError('BAD_REQUEST', `Roon transport ${control} is unavailable`, {
        httpStatus: 409,
        details: { reason: 'pause_unsupported', ownerDecision: 'OWNER_DECISION_REQUIRED' },
      });
    }
    if (this.selectedZone[capability] !== true) {
      throw new BridgeError('BAD_REQUEST', `Roon transport ${control} is unavailable`, {
        httpStatus: 409,
        details: { reason: 'pause_unsupported', ownerDecision: 'OWNER_DECISION_REQUIRED' },
      });
    }
    const zone = Object.freeze({ zone_id: this.selectedZone.zone_id });
    await this.runTransportRequest(
      control,
      (callback) => this.core?.services.RoonApiTransport.control(zone, control, callback),
      (cause) => new BridgeError('ROON_MEDIA_ERROR', `Roon transport ${control} failed`, {
        httpStatus: 502,
        ...(cause !== undefined ? { cause } : {}),
        details: { control, reason: 'transport_control_failed' },
      }),
    );
  }

  private runTransportRequest(
    operation: RoonTransportControl | 'seek',
    request: (callback: (error: string | false) => void) => void,
    requestError: (cause?: unknown) => BridgeError,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.activeTimerCount = Math.max(0, this.activeTimerCount - 1);
        if (error) reject(error);
        else resolve();
      };
      this.activeTimerCount += 1;
      const timeout = setTimeout(() => {
        finish(new BridgeError('ROON_TIMEOUT', `Roon transport ${operation} timed out`, {
          httpStatus: 504,
          details: { operation },
        }));
      }, this.transportTimeoutMs);
      try {
        request((error) => {
          if (error === false) finish();
          else finish(requestError());
        });
      } catch (error) {
        finish(requestError(error));
      }
    });
  }

  private setStatus(
    status: RoonState['status'],
    display: string,
    isError: boolean,
    lastError?: string,
  ): void {
    this.state = {
      ...this.state,
      status,
      ...(lastError ? { lastError } : {}),
    };
    this.statusService?.set_status(display, isError);
    this.stateHandler();
  }

  private makeSettingsLayout(settings: SettingsState): Record<string, unknown> {
    const zone = settings.output?.output_id
      ? {
          output_id: settings.output.output_id,
          ...(settings.output.display_name ? { name: settings.output.display_name } : {}),
        }
      : undefined;
    return {
      values: zone ? { zone } : {},
      layout: [
        {
          type: 'zone',
          title: 'Roon Zone',
          setting: 'zone',
        },
      ],
      has_error: false,
    };
  }
}
