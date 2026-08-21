import { BridgeError } from '../shared/errors.js';
import type { Logger } from '../shared/logger.js';
import type {
  RoonPlayRequest,
  RoonPort,
  RoonState,
  RoonTerminalReason,
} from './types.js';
import {
  createProductionRoonSdk,
  type RoonApiInstance,
  type RoonAudioInputService,
  type RoonAudioInputSession,
  type RoonCore,
  type RoonSdk,
  type RoonSettingsRequest,
  type RoonSettingsService,
  type RoonStatusService,
  type RoonZone,
  type RoonZoneChangeMessage,
} from './sdk.js';

interface SettingsState {
  output?: {
    output_id?: string;
    display_name?: string;
  };
}

type RoonPlaybackPhase = 'awaiting_session' | 'awaiting_playing';

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
}

const DEFAULT_SESSION_BEGIN_TIMEOUT_MS = 10_000;
const DEFAULT_PLAYING_TIMEOUT_MS = 30_000;

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

function isLocalPngIconUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      url.port === '38502' &&
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
  const output = (value as { output?: unknown }).output;
  if (!output || typeof output !== 'object') return {};

  const outputId = (output as { output_id?: unknown }).output_id;
  const displayName = (output as { display_name?: unknown }).display_name;
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

export class RoonAudioInputAdapter implements RoonPort {
  private roon: RoonApiInstance | undefined;
  private core: RoonCore | undefined;
  private statusService: RoonStatusService | undefined;
  private audioInput: RoonAudioInputService | undefined;
  private settings: SettingsState = {};
  private readonly zones = new Map<string, RoonZone>();
  private selectedZone: RoonZone | undefined;
  private session: RoonAudioInputSession | undefined;
  private state: RoonState = { status: 'discovering' };
  private terminalHandler: (reason: RoonTerminalReason) => void = () => undefined;
  private readonly sessionBeginTimeoutMs: number;
  private readonly playingTimeoutMs: number;

  constructor(
    private readonly logger: Logger,
    private readonly sdk: RoonSdk = createProductionRoonSdk(),
    options: RoonAudioInputAdapterOptions = {},
  ) {
    this.sessionBeginTimeoutMs = options.sessionBeginTimeoutMs ?? DEFAULT_SESSION_BEGIN_TIMEOUT_MS;
    this.playingTimeoutMs = options.playingTimeoutMs ?? DEFAULT_PLAYING_TIMEOUT_MS;
  }

  setTerminalHandler(handler: (reason: RoonTerminalReason) => void): void {
    this.terminalHandler = handler;
  }

  async start(): Promise<void> {
    if (this.roon) return;

    this.roon = this.sdk.createApi({
      extension_id: 'com.musicbridgeforroon.netease.poc',
      display_name: 'Music Bridge for Roon — NetEase POC',
      display_version: '0.1.0-poc.1',
      publisher: 'Music Bridge for Roon',
      email: 'local-only@example.invalid',
      website: 'https://github.com/RoonLabs/roon-connect-stream-example',
      log_level: 'none',
      force_server: true,
      core_paired: (core) => this.onCorePaired(core),
      core_unpaired: () => this.onCoreUnpaired(),
    });

    this.settings = readSettings(this.roon.load_config('settings'));

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
        this.roon?.save_config('settings', this.settings);
        this.updateSelectedZone();
      },
    });

    this.statusService = this.sdk.createStatus(this.roon);
    this.roon.init_services({
      provided_services: [settingsService, this.statusService],
      required_services: [this.sdk.audioInputService, this.sdk.transportService],
    });
    this.roon.start_discovery();
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
    if (!iconUrlPresent || !isLocalPngIconUrl(request.iconUrl)) {
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

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let phase: RoonPlaybackPhase = 'awaiting_session';
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const startedAt = Date.now();

      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };

      const armTimeout = (nextPhase: RoonPlaybackPhase, durationMs: number): void => {
        phase = nextPhase;
        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(() => {
          this.logger.warn('roon_session_timeout', {
            phase: nextPhase,
            elapsedMs: Date.now() - startedAt,
          });
          finish(timeoutError(nextPhase));
        }, durationMs);
      };

      const finishZoneLoss = (): void => {
        this.selectedZone = undefined;
        this.setStatus('paired', 'Please configure Zone', true);
        this.terminalHandler('zone_lost');
        finish(
          new BridgeError(
            'ROON_ZONE_NOT_SELECTED',
            'Selected Roon Zone was lost',
            { httpStatus: 409, details: { phase } },
          ),
        );
      };

      const handlePlayEvent = (playMessage: unknown): void => {
        const event = messageName(playMessage);
        this.logger.info('roon_play_event', {
          phase: 'awaiting_playing',
          eventName: event,
        });
        switch (event) {
          case 'Playing':
            this.setStatus('playing', 'Playing', false);
            finish();
            break;
          case 'Time':
            break;
          case 'EndedNaturally':
            this.setStatus('ready', 'Ready', false);
            this.terminalHandler('ended');
            if (!settled) finish(protocolError('awaiting_playing', 'ended_before_playing', event));
            break;
          case 'StoppedUser':
          case 'Paused':
            this.setStatus('ready', 'Ready', false);
            this.terminalHandler('stopped');
            if (!settled) finish(protocolError('awaiting_playing', 'stopped_before_playing', event));
            break;
          case 'MediaError':
            this.setStatus('error', 'Media error', true, 'Roon MediaError');
            this.terminalHandler('media_error');
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
        const sessionId = readSessionId(body);
        const responseSummary = summarizeRoonResponseBody(body);
        this.logger.info('roon_session_event', {
          phase,
          eventName: sessionEvent,
          hasSessionId: Boolean(sessionId),
          sanitizedErrorClass: responseSummary.sanitizedErrorClass,
        });

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
            audioInput.play(
              {
                session_id: sessionId,
                type: 'channel',
                slot: 'play',
                media_url: request.mediaUrl,
                info: {
                  is_seek_allowed: false,
                  is_pause_allowed: false,
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
              },
              handlePlayEvent,
            );
          } catch (error) {
            this.logger.warn('roon_connection_error', {
              phase: 'awaiting_playing',
              reason: 'play_request_failed',
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
          if (!settled) finish(protocolError(phase, 'session_ended', sessionEvent));
          return;
        }

        if (isConnectionErrorEvent(sessionEvent)) {
          this.logger.warn('roon_connection_error', {
            phase,
            eventName: sessionEvent,
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
            display_name: 'Music Bridge for Roon',
            icon_url: request.iconUrl,
          },
          handleSessionEvent,
        );
        this.session = session;
      } catch (error) {
        this.logger.warn('roon_connection_error', {
          phase: 'awaiting_session',
          reason: 'begin_session_failed',
        });
        finish(protocolError('awaiting_session', 'begin_session_failed'));
      }
    });
  }

  async stop(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    if (!session) return;

    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        resolve();
      };
      const timeout = setTimeout(finish, 2_000);
      session.end_session(() => {
        clearTimeout(timeout);
        finish();
      });
    });

    if (this.core && this.selectedZone) {
      this.setStatus('ready', 'Ready', false);
    }
  }

  async shutdown(): Promise<void> {
    await this.stop();
    try {
      this.roon?.stop_discovery?.();
      this.roon?.disconnect_all?.();
    } finally {
      this.roon = undefined;
      this.core = undefined;
      this.audioInput = undefined;
      this.zones.clear();
      this.selectedZone = undefined;
      this.state = { status: 'discovering' };
    }
  }

  getState(): RoonState {
    return { ...this.state };
  }

  private onCorePaired(core: RoonCore): void {
    this.core = core;
    this.audioInput = core.services.RoonApiAudioInput;
    this.state = {
      status: 'paired',
      ...(typeof core.display_name === 'string' ? { coreName: core.display_name } : {}),
    };
    this.setStatus('paired', 'Initializing…', false);

    core.services.RoonApiTransport.subscribe_zones(
      (response: string, message: RoonZoneChangeMessage) => {
        if (response === 'Subscribed') {
          this.zones.clear();
          for (const zone of message.zones ?? []) this.storeZone(zone);
        } else if (response === 'Changed') {
          for (const zone of message.zones_added ?? []) this.storeZone(zone);
          for (const zone of message.zones_changed ?? []) this.storeZone(zone);
          for (const zone of message.zones_removed ?? []) {
            const zoneId = readZoneId(zone);
            if (zoneId) this.zones.delete(zoneId);
          }
        }
        this.updateSelectedZone();
      },
    );

    this.logger.info('roon_core_paired');
  }

  private onCoreUnpaired(): void {
    this.core = undefined;
    this.audioInput = undefined;
    this.zones.clear();
    this.selectedZone = undefined;
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

    this.state = {
      status: 'ready',
      ...(coreName ? { coreName } : {}),
      selectedZoneId: this.selectedZone.zone_id,
      selectedZoneName: this.selectedZone.display_name ?? this.selectedZone.zone_id,
    };
    this.setStatus('ready', 'Ready', false);
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
  }

  private makeSettingsLayout(settings: SettingsState): Record<string, unknown> {
    return {
      values: settings,
      layout: [
        {
          type: 'zone',
          title: 'Roon Zone',
          setting: 'output',
        },
      ],
      has_error: false,
    };
  }
}
