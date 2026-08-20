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
  return typeof sessionId === 'string' ? sessionId : undefined;
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

  constructor(
    private readonly logger: Logger,
    private readonly sdk: RoonSdk = createProductionRoonSdk(),
  ) {}

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
    this.setStatus('ready', 'Preparing stream…', false);
    const audioInput = this.audioInput;
    if (!audioInput) {
      throw new BridgeError('ROON_NOT_PAIRED', 'Roon is not paired with the extension', {
        httpStatus: 503,
      });
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        finish(
          new BridgeError('ROON_TIMEOUT', 'Roon did not start playback in time', {
            httpStatus: 504,
          }),
        );
      }, 30_000);

      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };

      const session = audioInput.begin_session(
        {
          zone_id: this.selectedZone?.zone_id,
          display_name: 'Music Bridge for Roon',
          icon_url: request.iconUrl,
        },
        (sessionMessage: unknown, body: unknown) => {
          const sessionEvent = messageName(sessionMessage);
          if (sessionEvent === 'SessionBegan') {
            const sessionId = readSessionId(body);
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
              (playMessage: unknown, playBody: unknown) => {
                const event = messageName(playMessage);
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
                    break;
                  case 'StoppedUser':
                  case 'Paused':
                    this.setStatus('ready', 'Ready', false);
                    this.terminalHandler('stopped');
                    break;
                  case 'MediaError':
                    this.setStatus('error', 'Media error', true, 'Roon MediaError');
                    this.terminalHandler('media_error');
                    finish(
                      new BridgeError('ROON_MEDIA_ERROR', 'Roon reported a media error', {
                        httpStatus: 502,
                        details: { event, bodyType: typeof playBody },
                      }),
                    );
                    break;
                  case 'ZoneNotFound':
                  case 'ZoneLost':
                    this.selectedZone = undefined;
                    this.setStatus('paired', 'Please configure Zone', true);
                    this.terminalHandler('zone_lost');
                    finish(
                      new BridgeError(
                        'ROON_ZONE_NOT_SELECTED',
                        'Selected Roon Zone was lost',
                        { httpStatus: 409 },
                      ),
                    );
                    break;
                  default:
                    this.logger.debug('roon_unhandled_play_event', { event });
                }
              },
            );
          } else if (sessionEvent === 'ZoneNotFound' || sessionEvent === 'ZoneLost') {
            finish(
              new BridgeError(
                'ROON_ZONE_NOT_SELECTED',
                'Roon could not find the selected Zone',
                { httpStatus: 409 },
              ),
            );
          } else if (sessionEvent === 'SessionEnded') {
            this.setStatus('ready', 'Ready', false);
          }
        },
      );
      this.session = session;
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

    this.logger.info('roon_core_paired', {
      coreName: typeof core.display_name === 'string' ? core.display_name : 'unknown',
    });
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
