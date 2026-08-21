import type {
  PublicBridgeState,
  PublicRoonZone,
  TypedIpcEvent,
} from '@music-bridge/contracts';
import { BridgeController, type BridgeState } from './application/bridge-controller.js';
import { loadConfig } from './config/config.js';
import { ControlServer } from './control/server.js';
import { NeteaseClient } from './netease/client.js';
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

export function createBridgeRuntime(options: BridgeRuntimeOptions = {}): CoreRuntime {
  const config = loadConfig(options.env);
  const logger = options.logger ?? createLogger(config.logLevel);
  const registry = new StreamRegistry();
  const netease = new NeteaseClient(config.neteaseCookie);
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
      const state = publicState();
      emitHealth();
      return state;
    },

    async clearProviderCredential(): Promise<PublicBridgeState> {
      netease.clearCredential();
      const state = publicState();
      emitHealth();
      return state;
    },

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
      return state;
    },
    async clearProviderCredential() {
      state = { ...state, provider: 'missing' };
      return state;
    },
    listZones: () => [],
    async selectZone() {
      return state;
    },
  };
}
