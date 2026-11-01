import { createRequire } from 'node:module';
import { isIP } from 'node:net';
import type { RoonBrowseApi, RoonImageApi } from './library.js';

export interface RoonZoneOutput {
  volume?: { type?: string; min?: number; max?: number; value?: number; step?: number; is_muted?: boolean; limits?: {min?: number; max?: number} };
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
    image_key?: string;
    seek_position?: number;
    length?: number;
    one_line?: { line1?: string };
    two_line?: { line1?: string; line2?: string };
    three_line?: { line1?: string; line2?: string; line3?: string };
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
  change_volume?(outputId: string, how: 'absolute' | 'relative', value: number, callback: (error: string | false) => void): void;
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
  core_id?: string;
  display_name?: string;
  services: {
    RoonApiAudioInput: RoonAudioInputService;
    RoonApiTransport: RoonTransportService;
    RoonApiBrowse?: RoonBrowseApi;
    RoonApiImage?: RoonImageApi;
  };
}

/** 仅在Core进程内使用的真实控制连接地址，不进入公开快照。 */
export interface RoonCoreNetworkConnection {
  localAddress: string;
  remoteAddress: string;
}

export function readRoonCoreNetworkConnection(core: RoonCore): RoonCoreNetworkConnection | undefined {
  try {
    // 固定SDK的Core保留moo，Node ws在open之前设置_socket；host只是拨号目标，不能代替实际peer。
    const socket = (core as RoonCore & {
      moo?: { transport?: { ws?: { _socket?: { localAddress?: unknown; remoteAddress?: unknown; destroyed?: boolean } } } };
    }).moo?.transport?.ws?._socket;
    const normalize = (value: unknown): string | undefined => {
      if (typeof value !== 'string') return undefined;
      const normalized = value.startsWith('::ffff:') && isIP(value.slice(7)) === 4 ? value.slice(7) : value;
      return isIP(normalized) ? normalized : undefined;
    };
    const localAddress = normalize(socket?.localAddress);
    const remoteAddress = normalize(socket?.remoteAddress);
    return socket && !socket.destroyed && localAddress && remoteAddress ? { localAddress, remoteAddress } : undefined;
  } catch { return undefined; }
}

/** ws_connect返回私有Moo对象，仅允许在原SDK边界关闭它持有的连接。 */
export function closeRoonConnection(connection: unknown): void {
  try {
    const transport = (connection as { transport?: { close?: () => void } } | undefined)?.transport;
    transport?.close?.();
  } catch { /* 关闭失败不能让退出路径遗留重拨定时器。 */ }
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

interface RoonPairingCompatibilityApi extends RoonApiInstance {
  paired_core_id?: string;
  paired_core?: Pick<RoonCore, 'core_id'>;
  is_paired?: boolean;
}

/**
 * 固定SDK写入paired_core_id却不在冷启动恢复，且重连时不刷新paired_core/is_paired。
 * 只补齐这三个私有配对字段；tokens仍由官方SDK原样加载、使用及持久化。
 */
export function createRoonApiWithPairingCompatibility(
  options: RoonApiOptions,
  createApi: (options: RoonApiOptions) => RoonApiInstance,
): RoonApiInstance {
  let api: RoonPairingCompatibilityApi;
  let currentCore: RoonCore | undefined;
  api = createApi({
    ...options,
    core_paired: core => {
      // 官方Pair调用仍可更换目标；此处不另选Core，也不重写授权状态。
      api.paired_core = core;
      api.is_paired = true;
      currentCore = core;
      options.core_paired(core);
    },
    core_unpaired: core => {
      // 固定SDK的lost_core回调对非配对Core也可能触发，旧socket不能撤销新连接。
      if (!core || core !== currentCore) {
        // 同id的旧socket已先把SDK的is_paired置false，仍活动的新Core需要保留该位。
        if (currentCore) api.is_paired = true;
        return;
      }
      currentCore = undefined;
      api.is_paired = false;
      options.core_unpaired(core);
    },
  });
  const state = api.load_config('roonstate');
  const selectedId = state && typeof state === 'object' && !Array.isArray(state)
    ? (state as { paired_core_id?: unknown }).paired_core_id : undefined;
  if (typeof selectedId === 'string' && selectedId.length > 0) {
    api.paired_core_id = selectedId;
    // 离线身份锚点只供官方Pair handler删除旧目标；绝不当作可播放Core交给适配器。
    api.paired_core = { core_id: selectedId };
    api.is_paired = false;
  }
  return api;
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
    createApi: (options) => createRoonApiWithPairingCompatibility(options, wrapped => new RoonApi(wrapped)),
    createSettings: (roon, options) => new RoonApiSettings(roon, options),
    createStatus: (roon) => new RoonApiStatus(roon),
  };
}
