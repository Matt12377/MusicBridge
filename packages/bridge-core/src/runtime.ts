import type {
  Page,
  PageRequest,
  PlaylistDetail,
  PlaylistSummary,
  PublicAuthState,
  PublicBridgeState,
  PublicRoonZone,
  TrackSummary,
  TypedIpcEvent,
} from '@music-bridge/contracts';
import { BridgeController, type BridgeState } from './application/bridge-controller.js';
import { loadConfig } from './config/config.js';
import { ControlServer } from './control/server.js';
import { NeteaseClient } from './netease/client.js';
import { QrLoginStateMachine } from './netease/qr-login.js';
import { RoonAudioInputAdapter } from './roon/adapter.js';
import type { RoonSdk } from './roon/sdk.js';
import { asBridgeError } from './shared/errors.js';
import { createLogger, type Logger } from './shared/logger.js';
import { StreamGateway } from './stream/gateway.js';
import { StreamRegistry } from './stream/registry.js';

export type CoreRuntimeEvent = TypedIpcEvent;

export interface CoreRuntime {
  start(): Promise<void>;
  shutdown(): Promise<void>;
  ping(): { pong: true };
  getHealth(): PublicBridgeState;
  getState(): PublicBridgeState;
  setProviderCredential(credential: string): Promise<PublicBridgeState>;
  clearProviderCredential(): Promise<PublicBridgeState>;
  getAuthState(): PublicAuthState;
  beginQrLogin(): Promise<PublicAuthState>;
  pollQrLogin(challengeId: string): Promise<{
    state: PublicAuthState;
    credential?: string;
  }>;
  cancelQrLogin(challengeId: string): PublicAuthState;
  logoutProvider(): Promise<PublicAuthState>;
  searchTracks(query: string, page: PageRequest): Promise<Page<TrackSummary>>;
  getLikedTracks(page: PageRequest): Promise<Page<TrackSummary>>;
  getUserPlaylists(): Promise<readonly PlaylistSummary[]>;
  getPlaylist(playlistId: string, page: PageRequest): Promise<PlaylistDetail>;
  listZones(): readonly PublicRoonZone[];
  selectZone(zoneId: string): Promise<PublicBridgeState>;
}

export interface BridgeRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  roonSdk?: RoonSdk;
  now?: () => number;
  onEvent?: (event: CoreRuntimeEvent) => void;
}

function publicRoonStatus(
  status: BridgeState['roon']['status'],
): PublicBridgeState['roon'] {
  switch (status) {
    case 'discovering':
      return 'discovering';
    case 'paired':
      return 'paired';
    case 'ready':
    case 'playing':
      return 'ready';
    case 'error':
      return 'disconnected';
  }
}

export function toPublicBridgeState(
  state: BridgeState,
  runtime: PublicBridgeState['runtime'],
): PublicBridgeState {
  return {
    runtime,
    roon: publicRoonStatus(state.roon.status),
    provider: state.neteaseConfigured ? 'configured' : 'missing',
    activeStreamCount: state.activeStreamCount,
    activePlaybackPresent: state.activePlayback !== undefined,
  };
}

function eventWithState(
  event: 'core.ready' | 'core.health' | 'roon.changed',
  state: PublicBridgeState,
): CoreRuntimeEvent {
  return {
    version: 1,
    event,
    payload: { state },
  } as TypedIpcEvent;
}

function eventWithAuthState(state: PublicAuthState): CoreRuntimeEvent {
  return {
    version: 1,
    event: 'auth.changed',
    payload: { state },
  } as TypedIpcEvent;
}

export function createBridgeRuntime(options: BridgeRuntimeOptions = {}): CoreRuntime {
  const config = loadConfig(options.env);
  const logger = options.logger ?? createLogger(config.logLevel);
  const registry = new StreamRegistry();
  const netease = new NeteaseClient(config.neteaseCookie);
  const qrLogin = new QrLoginStateMachine(netease);
  if (netease.configured) qrLogin.markAuthorized();
  const roon = new RoonAudioInputAdapter(logger, options.roonSdk);
  const gateway = new StreamGateway({
    host: config.streamHost,
    port: config.streamPort,
    publicBaseUrl: config.publicStreamBaseUrl,
    registry,
    logger,
  });
  const controller = new BridgeController({
    netease,
    roon,
    registry,
    gateway,
    logger,
    ...(options.now ? { now: options.now } : {}),
  });
  const control = new ControlServer({
    host: config.controlHost,
    port: config.controlPort,
    defaultQuality: config.defaultQuality,
    controller,
    logger,
  });

  let runtime: PublicBridgeState['runtime'] = 'starting';
  let shutdownStarted = false;
  const emit = (event: CoreRuntimeEvent): void => options.onEvent?.(event);
  const publicState = (): PublicBridgeState =>
    toPublicBridgeState(controller.getState(), runtime);
  const emitHealth = (): void => emit(eventWithState('core.health', publicState()));

  roon.setStateHandler(() => {
    const state = publicState();
    emit(eventWithState('roon.changed', state));
    emit(eventWithState('core.health', state));
  });

  const cleanup = async (): Promise<void> => {
    await control.stop();
    await controller.shutdown();
    await roon.shutdown();
    registry.revokeAll();
    await gateway.stop();
  };

  return {
    async start(): Promise<void> {
      if (runtime === 'ready') return;
      if (shutdownStarted) {
        throw new Error('Bridge runtime has already shut down');
      }
      runtime = 'starting';
      try {
        await gateway.start();
        await roon.start();
        await control.start();
        runtime = 'ready';
        emit(eventWithState('core.ready', publicState()));
        emitHealth();
        logger.info('bridge_started', {
          controlAddress: `${config.controlHost}:${config.controlPort}`,
          streamAddress: `${config.streamHost}:${config.streamPort}`,
          neteaseConfigured: netease.configured,
          defaultQuality: config.defaultQuality,
        });
      } catch (error) {
        runtime = 'failed';
        try {
          await cleanup();
        } catch (cleanupError) {
          logger.warn('bridge_start_cleanup_failed', {
            code: asBridgeError(cleanupError).code,
          });
        }
        throw error;
      }
    },

    async shutdown(): Promise<void> {
      if (shutdownStarted) return;
      shutdownStarted = true;
      try {
        await cleanup();
      } finally {
        runtime = 'stopped';
        emitHealth();
      }
    },

    ping: () => ({ pong: true as const }),
    getHealth: publicState,
    getState: publicState,

    async setProviderCredential(credential: string): Promise<PublicBridgeState> {
      netease.setCredential(credential);
      emit(eventWithAuthState(qrLogin.markAuthorized()));
      const state = publicState();
      emitHealth();
      return state;
    },

    async clearProviderCredential(): Promise<PublicBridgeState> {
      netease.clearCredential();
      emit(eventWithAuthState(qrLogin.markMissing()));
      const state = publicState();
      emitHealth();
      return state;
    },

    getAuthState: () => qrLogin.getState(),

    async beginQrLogin(): Promise<PublicAuthState> {
      const state = await qrLogin.begin();
      emit(eventWithAuthState(state));
      return state;
    },

    async pollQrLogin(challengeId: string) {
      const result = await qrLogin.poll(challengeId);
      emit(eventWithAuthState(result.state));
      return result;
    },

    cancelQrLogin(challengeId: string): PublicAuthState {
      const state = qrLogin.cancel(challengeId);
      emit(eventWithAuthState(state));
      return state;
    },

    async logoutProvider(): Promise<PublicAuthState> {
      const state = await qrLogin.logout();
      netease.clearCredential();
      emit(eventWithAuthState(state));
      emitHealth();
      return state;
    },

    searchTracks: (query, page) => netease.searchTracks(query, page),
    getLikedTracks: (page) => netease.getLikedTracks(page),
    getUserPlaylists: () => netease.getUserPlaylists(),
    getPlaylist: (playlistId, page) => netease.getPlaylist(playlistId, page),

    listZones: () => roon.listZones().map((zone) => ({
      zoneId: zone.zone_id,
      displayName: zone.display_name ?? zone.zone_id,
      selected: zone.zone_id === controller.getState().roon.selectedZoneId,
    })),

    async selectZone(zoneId: string): Promise<PublicBridgeState> {
      roon.selectZone(zoneId);
      const state = publicState();
      emit(eventWithState('roon.changed', state));
      emitHealth();
      return state;
    },
  };
}

export function createTestBridgeRuntime(): CoreRuntime {
  let state: PublicBridgeState = {
    runtime: 'starting',
    roon: 'disconnected',
    provider: 'missing',
    activeStreamCount: 0,
    activePlaybackPresent: false,
  };
  let authState: PublicAuthState = { status: 'idle' };
  return {
    async start() {
      state = { ...state, runtime: 'ready' };
    },
    async shutdown() {
      state = { ...state, runtime: 'stopped' };
    },
    ping: () => ({ pong: true as const }),
    getHealth: () => state,
    getState: () => state,
    async setProviderCredential() {
      state = { ...state, provider: 'configured' };
      authState = { status: 'authorized' };
      return state;
    },
    async clearProviderCredential() {
      state = { ...state, provider: 'missing' };
      authState = { status: 'idle' };
      return state;
    },
    getAuthState: () => ({ ...authState }),
    async beginQrLogin() {
      authState = {
        status: 'waiting',
        challengeId: 'test-challenge',
        qrImage: 'data:image/png;base64,synthetic-qr',
        expiresAt: Date.now() + 180_000,
      };
      return { ...authState };
    },
    async pollQrLogin() {
      authState = {
        status: 'waiting',
        challengeId: 'test-challenge',
        qrImage: 'data:image/png;base64,synthetic-qr',
        expiresAt: Date.now() + 180_000,
      };
      return { state: { ...authState } };
    },
    cancelQrLogin() {
      authState = { status: 'cancelled' };
      return { ...authState };
    },
    async logoutProvider() {
      state = { ...state, provider: 'missing' };
      authState = { status: 'idle' };
      return { ...authState };
    },
    async searchTracks(_query, page) {
      return { items: [], offset: page.offset, limit: page.limit, total: 0, hasMore: false };
    },
    async getLikedTracks(page) {
      return { items: [], offset: page.offset, limit: page.limit, total: 0, hasMore: false };
    },
    async getUserPlaylists() {
      return [];
    },
    async getPlaylist(playlistId, page) {
      return {
        id: playlistId,
        name: 'Synthetic Playlist',
        trackCount: 0,
        tracks: { items: [], offset: page.offset, limit: page.limit, total: 0, hasMore: false },
      };
    },
    listZones: () => [],
    async selectZone() {
      return state;
    },
  };
}
