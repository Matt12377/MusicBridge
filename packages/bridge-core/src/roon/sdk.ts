import { createRequire } from 'node:module';
import type { RoonBrowseApi, RoonImageApi } from './library.js';

export interface RoonZoneOutput {
  output_id?: string;
  display_name?: string;
}

export interface RoonZone {
  zone_id: string;
  display_name?: string;
  outputs?: readonly RoonZoneOutput[];
  state?: 'playing' | 'paused' | 'loading' | 'stopped';
  seek_position?: number;
  is_pause_allowed?: boolean;
  is_play_allowed?: boolean;
  is_previous_allowed?: boolean;
  is_next_allowed?: boolean;
  is_seek_allowed?: boolean;
  now_playing?: {
    seek_position?: number;
    length?: number;
  };
}

export interface RoonZoneChangeMessage {
  zones?: readonly unknown[];
  zones_added?: readonly unknown[];
  zones_changed?: readonly unknown[];
  zones_removed?: readonly (string | { zone_id?: unknown })[];
  zones_seek_changed?: readonly unknown[];
}

export type RoonZoneChangeCallback = (
  response: string,
  message: RoonZoneChangeMessage,
) => void;

export type RoonTransportControl = 'play' | 'pause' | 'playpause' | 'stop' | 'previous' | 'next';
export type RoonTransportTarget = string | RoonZone | RoonZoneOutput | { zone_id: string };

export interface RoonTransportService {
  subscribe_zones(callback: RoonZoneChangeCallback): void;
  seek(
    zoneOrOutputId: string,
    how: 'absolute' | 'relative',
    seconds: number,
    callback: (error: string | false) => void,
  ): void;
  control(
    zoneOrOutputId: RoonTransportTarget,
    control: RoonTransportControl,
    callback: (error: string | false) => void,
  ): void;
}

export interface RoonAudioInputSession {
  end_session(callback: (message: unknown, body: unknown) => void): void;
}

export interface RoonAudioInputPlayInfo {
  is_seek_allowed: boolean;
  is_pause_allowed: boolean;
  length?: number;
  one_line: { line1: string };
  two_line: { line1: string; line2?: string };
  three_line: { line1: string; line2?: string; line3?: string };
}

export interface RoonAudioInputPlayOptions {
  session_id: string;
  track_id: string;
  type: 'channel' | 'track';
  slot: 'play';
  media_url: string;
  seek_position_ms?: number;
  info: RoonAudioInputPlayInfo;
}

export interface RoonAudioInputService {
  begin_session(
    options: unknown,
    callback: (message: unknown, body: unknown) => void,
  ): RoonAudioInputSession;
  update_transport_controls(
    options: unknown,
    callback: (message: unknown, body: unknown) => void,
  ): void;
  play(
    options: RoonAudioInputPlayOptions,
    callback: (message: unknown, body: unknown) => void,
  ): void;
}

export interface RoonCore {
  display_name?: string;
  services: {
    RoonApiAudioInput: RoonAudioInputService;
    RoonApiTransport: RoonTransportService;
    RoonApiBrowse?: RoonBrowseApi;
    RoonApiImage?: RoonImageApi;
  };
}

export interface RoonSettingsRequest {
  send_complete(status: string, body: unknown): void;
}

export interface RoonSettingsOptions {
  get_settings(callback: (layout: unknown) => void): void;
  save_settings(
    request: RoonSettingsRequest,
    isDryRun: boolean,
    settings: unknown,
  ): void;
}

export interface RoonSettingsService {}

export interface RoonStatusService {
  set_status(message: string, isError: boolean): void;
}

export type RoonRequiredServiceConstructor = new (
  core: RoonCore,
) => unknown;

export interface RoonApiOptions {
  extension_id: string;
  display_name: string;
  display_version: string;
  publisher: string;
  email: string;
  website: string;
  log_level: string;
  force_server: boolean;
  core_paired(core: RoonCore): void;
  core_unpaired(core?: RoonCore): void;
}

export interface RoonApiInstance {
  load_config(key: string): unknown;
  save_config(key: string, value: unknown): void;
  init_services(options: {
    provided_services?: readonly unknown[];
    required_services?: readonly RoonRequiredServiceConstructor[];
    optional_services?: readonly RoonRequiredServiceConstructor[];
  }): void;
  start_discovery(): void;
  ws_connect?(options: RoonWsConnectOptions): unknown;
  stop_discovery?(): void;
  disconnect_all?(): void;
}

export interface RoonWsConnectOptions {
  host: string;
  port: number;
  onclose?: () => void;
  onerror?: (connection: unknown) => void;
}

export interface RoonSdk {
  readonly audioInputService: RoonRequiredServiceConstructor;
  readonly transportService: RoonRequiredServiceConstructor;
  readonly browseService?: RoonRequiredServiceConstructor;
  readonly imageService?: RoonRequiredServiceConstructor;
  createApi(options: RoonApiOptions): RoonApiInstance;
  createSettings(
    roon: RoonApiInstance,
    options: RoonSettingsOptions,
  ): RoonSettingsService;
  createStatus(roon: RoonApiInstance): RoonStatusService;
}

interface RoonApiConstructor {
  new (options: RoonApiOptions): RoonApiInstance;
}

interface RoonSettingsConstructor {
  new (
    roon: RoonApiInstance,
    options: RoonSettingsOptions,
  ): RoonSettingsService;
}

interface RoonStatusConstructor {
  new (roon: RoonApiInstance): RoonStatusService;
}

const require = createRequire(import.meta.url);

const RoonApi = require('node-roon-api') as RoonApiConstructor;
const RoonApiAudioInput = require(
  'node-roon-api-audioinput',
) as RoonRequiredServiceConstructor;
const RoonApiBrowse = require(
  'node-roon-api-browse',
) as RoonRequiredServiceConstructor;
const RoonApiImage = require(
  'node-roon-api-image',
) as RoonRequiredServiceConstructor;
const RoonApiSettings = require(
  'node-roon-api-settings',
) as RoonSettingsConstructor;
const RoonApiStatus = require(
  'node-roon-api-status',
) as RoonStatusConstructor;
const RoonApiTransport = require(
  'node-roon-api-transport',
) as RoonRequiredServiceConstructor;

export function createProductionRoonSdk(): RoonSdk {
  return {
    audioInputService: RoonApiAudioInput,
    transportService: RoonApiTransport,
    browseService: RoonApiBrowse,
    imageService: RoonApiImage,
    createApi: (options) => new RoonApi(options),
    createSettings: (roon, options) => new RoonApiSettings(roon, options),
    createStatus: (roon) => new RoonApiStatus(roon),
  };
}
