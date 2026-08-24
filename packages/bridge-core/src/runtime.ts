import {
  DiagnosticRingBuffer,
  type DiagnosticComponentSnapshot,
  type DiagnosticGateResult,
  type DiagnosticResourceCounters,
} from '@music-bridge/contracts';
import type {
  Page,
  PageRequest,
  PlaylistDetail,
  PlaylistSummary,
  LyricsSnapshot,
  DailyRecommendationsSnapshot,
  ArtistDetail,
  PlaybackQueueItem,
  PlaybackQueueRequestItem,
  PlaybackQuality,
  PlaybackQualityPreference,
  PlaybackSnapshot,
  PublicAuthState,
  PublicAccountState,
  PublicBridgeState,
  PublicRoonZone,
  TrackSummary,
  ArtistSummary,
  AlbumDetail,
  AlbumSummary,
  TypedIpcEvent,
} from '@music-bridge/contracts';
import { BridgeController, type BridgeState } from './application/bridge-controller.js';
import { loadConfig } from './config/config.js';
import { ControlServer } from './control/server.js';
import { NeteaseClient } from './netease/client.js';
import type { CredentialVerificationStatus } from './netease/types.js';
import { emptyLyricsSnapshot } from './netease/lyrics.js';
import { QrLoginStateMachine } from './netease/qr-login.js';
import { RoonAudioInputAdapter, type RoonTimeShapeSummary } from './roon/adapter.js';
import type { RoonSdk } from './roon/sdk.js';
import { asBridgeError, BridgeError } from './shared/errors.js';
import { createLogger, type Logger } from './shared/logger.js';
import { StreamGateway } from './stream/gateway.js';
import { StreamRegistry } from './stream/registry.js';
import { LyricsCoordinator } from './lyrics/coordinator.js';

export type CoreRuntimeEvent = TypedIpcEvent;

export interface CoreRuntime {
  start(): Promise<void>;
  shutdown(): Promise<void>;
  ping(): { pong: true };
  getHealth(): PublicBridgeState;
  getState(): PublicBridgeState;
  getDiagnostics(): DiagnosticComponentSnapshot;
  verifyProviderCredential(credential: string): Promise<{ status: CredentialVerificationStatus }>;
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
  getAccountState(): PublicAccountState;
  refreshAccountProfile(): Promise<PublicAccountState>;
  getDailyRecommendations(): Promise<DailyRecommendationsSnapshot>;
  searchTracks(query: string, page: PageRequest): Promise<Page<TrackSummary>>;
  searchArtists(query: string, page: PageRequest): Promise<Page<ArtistSummary>>;
  searchAlbums(query: string, page: PageRequest): Promise<Page<AlbumSummary>>;
  getArtist(artistId: string, page: PageRequest): Promise<ArtistDetail>;
  getAlbum(albumId: string, page: PageRequest): Promise<AlbumDetail>;
  getLikedTracks(page: PageRequest): Promise<Page<TrackSummary>>;
  getUserPlaylists(): Promise<readonly PlaylistSummary[]>;
  getPlaylist(playlistId: string, page: PageRequest): Promise<PlaylistDetail>;
  getLyrics(trackId: string): Promise<LyricsSnapshot>;
  getPlaybackState(): PlaybackSnapshot;
  playbackPlay(trackId: string, quality: PlaybackQualityPreference): Promise<PlaybackSnapshot>;
  playbackPause(): Promise<PlaybackSnapshot>;
  playbackResume(): Promise<PlaybackSnapshot>;
  playbackStop(): Promise<PlaybackSnapshot>;
  playbackNext(): Promise<PlaybackSnapshot>;
  playbackPrevious(): Promise<PlaybackSnapshot>;
  replacePlaybackQueue(
    items: readonly PlaybackQueueRequestItem[],
    index: number,
  ): Promise<PlaybackSnapshot>;
  appendPlaybackQueue(items: readonly PlaybackQueueRequestItem[]): Promise<PlaybackSnapshot>;
  insertNextPlayback(items: readonly PlaybackQueueRequestItem[]): Promise<PlaybackSnapshot>;
  listZones(): readonly PublicRoonZone[];
  selectZone(zoneId: string): Promise<PublicBridgeState>;
}

export interface BridgeRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  roonSdk?: RoonSdk;
  now?: () => number;
  onEvent?: (event: CoreRuntimeEvent) => void;
  onRoonTimeShape?: (summary: RoonTimeShapeSummary) => void;
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
    case 'paused':
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

function emptyPlaybackState(): PlaybackSnapshot {
  return {
    state: 'idle',
    queue: {
      items: [],
      index: -1,
      hasNext: false,
      hasPrevious: false,
    },
    positionMs: 0,
    canNext: false,
    canPrevious: false,
    canStop: false,
    canPause: false,
    canResume: false,
  };
}

function localDayKey(now = Date.now()): string {
  const date = new Date(now);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function createBridgeRuntime(options: BridgeRuntimeOptions = {}): CoreRuntime {
  const config = loadConfig(options.env);
  const logger = options.logger ?? createLogger(config.logLevel);
  const registry = new StreamRegistry();
  const netease = new NeteaseClient(config.neteaseCookie);
  const qrLogin = new QrLoginStateMachine(netease);
  if (netease.configured) qrLogin.markAuthorized();
  const roon = new RoonAudioInputAdapter(logger, options.roonSdk, {
    mode: config.mode,
    iconPort: config.remoteStreamPort ?? config.streamPort,
    ...(options.onRoonTimeShape ? { onTimeShape: options.onRoonTimeShape } : {}),
  });
  const gateway = new StreamGateway({
    host: config.streamHost,
    port: config.streamPort,
    publicBaseUrl: config.publicStreamBaseUrl,
    registry,
    logger,
    remoteDevelopmentMode: config.mode === 'remote-core-development',
  });
  let notifyProviderExpired: () => void = () => undefined;
  const controller = new BridgeController({
    netease,
    roon,
    registry,
    gateway,
    logger,
    ...(options.now ? { now: options.now } : {}),
    onProviderAuthExpired: () => {
      netease.clearCredential();
      notifyProviderExpired();
    },
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
  const diagnostics = new DiagnosticRingBuffer();
  const runtimeStartedAt = Date.now();
  let startupLatencyMs: number | undefined;
  let lastPlayLatencyMs: number | undefined;
  let credentialGeneration = netease.configured ? 1 : 0;
  let accountState: PublicAccountState = {
    status: netease.configured ? 'loading' : 'missing',
  };
  let accountRequest: Promise<PublicAccountState> | undefined;
  let accountRequestGeneration = -1;
  let dailyCache:
    | { generation: number; dayKey: string; snapshot: DailyRecommendationsSnapshot }
    | undefined;
  let dailyRequest: Promise<DailyRecommendationsSnapshot> | undefined;
  let dailyRequestGeneration = -1;
  let dailyRequestDayKey = '';
  let dailyFailureUntil = 0;
  const gateResults: DiagnosticGateResult[] = [
    { name: 'startup', status: 'not-run' },
    { name: 'queue-state-machine', status: 'not-run' },
    { name: 'crash-recovery', status: 'not-run' },
    { name: 'resource-cleanup', status: 'not-run' },
    { name: 'secret-scan', status: 'not-run' },
  ];
  const recordDiagnostic = (
    level: 'info' | 'warn' | 'error',
    event: string,
    fields: { code?: string; diagnosticId?: string; state?: string; durationMs?: number } = {},
  ): void => {
    diagnostics.record({ component: 'core', level, event, ...fields });
  };
  const emit = (event: CoreRuntimeEvent): void => options.onEvent?.(event);
  const publicState = (): PublicBridgeState =>
    toPublicBridgeState(controller.getState(), runtime);
  const emitHealth = (): void => emit(eventWithState('core.health', publicState()));
  const emitAccount = (): void => {
    emit({
      version: 1,
      event: 'account.changed',
      payload: { state: accountState },
    });
  };
  const clearAccount = (status: PublicAccountState['status']): void => {
    credentialGeneration += 1;
    accountRequest = undefined;
    accountRequestGeneration = -1;
    dailyCache = undefined;
    dailyRequest = undefined;
    dailyRequestGeneration = -1;
    dailyRequestDayKey = '';
    dailyFailureUntil = 0;
    accountState = { status };
    emitAccount();
  };
  const startAccountLoading = (): number => {
    const generation = credentialGeneration;
    accountState = { status: 'loading' };
    emitAccount();
    return generation;
  };

  const withProviderRecovery = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (asBridgeError(error).code === 'AUTH_EXPIRED') {
        netease.clearCredential();
        notifyProviderExpired();
      }
      throw error;
    }
  };

  const refreshAccountProfileState = async (): Promise<PublicAccountState> => {
    if (!netease.configured) {
      if (accountState.status !== 'missing') clearAccount('missing');
      return accountState;
    }
    dailyFailureUntil = 0;
    if (accountRequest && accountRequestGeneration === credentialGeneration) {
      return accountRequest;
    }
    const generation = startAccountLoading();
    const request = (async (): Promise<PublicAccountState> => {
      try {
        const profile = await withProviderRecovery(() => netease.getPublicAccountProfile());
        if (generation !== credentialGeneration || !netease.configured) return accountState;
        accountState = { status: 'ready', profile };
        emitAccount();
        return accountState;
      } catch (error) {
        if (generation !== credentialGeneration || !netease.configured) return accountState;
        const bridgeError = asBridgeError(error);
        if (bridgeError.code === 'AUTH_EXPIRED') throw error;
        accountState = { status: 'unavailable' };
        emitAccount();
        return accountState;
      }
    })();
    accountRequest = request;
    accountRequestGeneration = generation;
    try {
      return await request;
    } finally {
      if (accountRequest === request) {
        accountRequest = undefined;
        accountRequestGeneration = -1;
      }
    }
  };

  const getDailyRecommendationSnapshot = async (): Promise<DailyRecommendationsSnapshot> => {
    if (!netease.configured) {
      throw new BridgeError('NETEASE_NOT_CONFIGURED', 'NetEase account is not configured', {
        httpStatus: 503,
      });
    }
    const now = options.now?.() ?? Date.now();
    const dayKey = localDayKey(now);
    if (dailyCache?.generation === credentialGeneration && dailyCache.dayKey === dayKey) {
      return dailyCache.snapshot;
    }
    if (
      dailyRequest &&
      dailyRequestGeneration === credentialGeneration &&
      dailyRequestDayKey === dayKey
    ) {
      return dailyRequest;
    }
    if (dailyFailureUntil > now) {
      throw new BridgeError(
        'DAILY_RECOMMENDATIONS_UNAVAILABLE',
        'Daily recommendations are temporarily unavailable',
        { httpStatus: 503 },
      );
    }
    const generation = credentialGeneration;
    const request = (async (): Promise<DailyRecommendationsSnapshot> => {
      try {
        const snapshot = await withProviderRecovery(() => netease.getDailyRecommendations());
        if (generation !== credentialGeneration || !netease.configured) {
          return { dayKey, tracks: [] };
        }
        const normalized = { ...snapshot, dayKey };
        dailyCache = { generation, dayKey, snapshot: normalized };
        return normalized;
      } catch (error) {
        const bridgeError = asBridgeError(error);
        if (bridgeError.code === 'AUTH_EXPIRED') throw error;
        dailyFailureUntil = (options.now?.() ?? Date.now()) + 30_000;
        if (bridgeError.code === 'DAILY_RECOMMENDATIONS_UNAVAILABLE') throw error;
        throw new BridgeError(
          'DAILY_RECOMMENDATIONS_UNAVAILABLE',
          'Daily recommendations are temporarily unavailable',
          { httpStatus: 503, cause: error },
        );
      }
    })();
    dailyRequest = request;
    dailyRequestGeneration = generation;
    dailyRequestDayKey = dayKey;
    try {
      return await request;
    } finally {
      if (dailyRequest === request) {
        dailyRequest = undefined;
        dailyRequestGeneration = -1;
        dailyRequestDayKey = '';
      }
    }
  };

  notifyProviderExpired = (): void => {
    netease.clearCredential();
    clearAccount('missing');
    emit(eventWithAuthState(qrLogin.markExpired()));
    emitHealth();
  };

  const lyrics = new LyricsCoordinator({
    load: (trackId) => withProviderRecovery(() => netease.getLyrics(trackId)),
    scheduleEstimatedUpdates: (callback) => {
      const timer = setInterval(callback, 100);
      return () => clearInterval(timer);
    },
    onChange: (snapshot) => {
      emit({
        version: 1,
        event: 'lyrics.changed',
        payload: { state: snapshot },
      });
    },
  });

  const removeControllerListener = controller.subscribe((snapshot) => {
    lyrics.onPlaybackChanged(snapshot);
    emit({
      version: 1,
      event: 'playback.changed',
      payload: { state: snapshot },
    });
    emit({
      version: 1,
      event: 'queue.changed',
      payload: { queue: snapshot.queue },
    });
  });

  roon.setStateHandler(() => {
    controller.syncRoonTransportState();
    const state = publicState();
    emit(eventWithState('roon.changed', state));
    emit(eventWithState('core.health', state));
  });
  roon.setTimeHandler?.((positionMs) => {
    controller.updateRoonTime(positionMs);
    lyrics.updateRoonTime(positionMs);
  });

  const cleanup = async (): Promise<void> => {
    await control.stop();
    await controller.shutdown();
    removeControllerListener();
    await roon.shutdown();
    lyrics.shutdown();
    registry.revokeAll();
    await gateway.stop();
  };

  const diagnosticCounters = (): DiagnosticResourceCounters => {
    const controllerCounters = controller.getDiagnosticResourceCounters();
    const roonCounters = roon.getDiagnosticResourceCounters?.() ?? {
      activeSessionCount: controllerCounters.activeSessionCount,
      listenerCount: 0,
      timerCount: 0,
    };
    const gatewayCounters = gateway.getDiagnosticResourceCounters();
    return {
      ...controllerCounters,
      activeSessionCount: Math.max(
        controllerCounters.activeSessionCount,
        roonCounters.activeSessionCount,
      ),
      listenerCount:
        controllerCounters.listenerCount + roonCounters.listenerCount + gatewayCounters.listenerCount,
      timerCount: controllerCounters.timerCount + roonCounters.timerCount + gatewayCounters.timerCount,
    };
  };

  const getDiagnostics = (): DiagnosticComponentSnapshot => {
    const counters = diagnosticCounters();
    const resourceClean =
      counters.activeStreamCount === 0 &&
      counters.activePlaybackCount === 0 &&
      counters.activeSessionCount === 0 &&
      counters.activeTokenCount === 0 &&
      counters.timerCount === 0;
    const gates = gateResults.map((gate) =>
      gate.name === 'startup' && runtime === 'ready'
        ? { ...gate, status: 'pass' as const }
        : gate.name === 'resource-cleanup' && resourceClean
          ? { ...gate, status: 'pass' as const }
          : { ...gate },
    );
    return {
      component: 'core',
      health: publicState(),
      timeline: diagnostics.snapshot(),
      memory: {
        rssBytes: process.memoryUsage().rss,
        heapUsedBytes: process.memoryUsage().heapUsed,
        heapTotalBytes: process.memoryUsage().heapTotal,
        externalBytes: process.memoryUsage().external,
      },
      counters,
      latency: {
        ...(startupLatencyMs !== undefined ? { startupMs: startupLatencyMs } : {}),
        ...(lastPlayLatencyMs !== undefined ? { lastPlayMs: lastPlayLatencyMs } : {}),
      },
      gates,
    };
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
        startupLatencyMs = Date.now() - runtimeStartedAt;
        recordDiagnostic('info', 'core_ready', { state: runtime, durationMs: startupLatencyMs });
        emit(eventWithState('core.ready', publicState()));
        emitHealth();
        if (netease.configured) void refreshAccountProfileState().catch(() => undefined);
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
        recordDiagnostic('info', 'core_shutdown', { state: runtime });
        emitHealth();
      }
    },

    ping: () => ({ pong: true as const }),
    getHealth: publicState,
    getState: publicState,
    getDiagnostics,

    async verifyProviderCredential(credential: string) {
      const status = await netease.verifyCredentialStatus(credential);
      if (status === 'expired') {
        netease.clearCredential();
        notifyProviderExpired();
      }
      return { status };
    },

    async setProviderCredential(credential: string): Promise<PublicBridgeState> {
      netease.setCredential(credential);
      credentialGeneration += 1;
      accountRequest = undefined;
      accountRequestGeneration = -1;
      dailyCache = undefined;
      dailyRequest = undefined;
      dailyRequestGeneration = -1;
      dailyRequestDayKey = '';
      dailyFailureUntil = 0;
      emit(eventWithAuthState(qrLogin.markAuthorized()));
      accountState = { status: 'loading' };
      emitAccount();
      const state = publicState();
      emitHealth();
      await refreshAccountProfileState().catch((error) => {
        if (asBridgeError(error).code === 'AUTH_EXPIRED') throw error;
      });
      return state;
    },

    async clearProviderCredential(): Promise<PublicBridgeState> {
      netease.clearCredential();
      clearAccount('missing');
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
      try {
        await controller.clearQueue();
      } finally {
        clearAccount('missing');
      }
      emit(eventWithAuthState(state));
      emitHealth();
      return state;
    },

    searchTracks: (query, page) => withProviderRecovery(() => netease.searchTracks(query, page)),
    searchArtists: (query, page) => withProviderRecovery(() => netease.searchArtists(query, page)),
    searchAlbums: (query, page) => withProviderRecovery(() => netease.searchAlbums(query, page)),
    getArtist: (artistId, page) => withProviderRecovery(() => netease.getArtist(artistId, page)),
    getAlbum: (albumId, page) => withProviderRecovery(() => netease.getAlbum(albumId, page)),
    getLikedTracks: (page) => withProviderRecovery(() => netease.getLikedTracks(page)),
    getUserPlaylists: () => withProviderRecovery(() => netease.getUserPlaylists()),
    getPlaylist: (playlistId, page) =>
      withProviderRecovery(() => netease.getPlaylist(playlistId, page)),
    getAccountState: () => ({
      ...accountState,
      ...(accountState.profile ? { profile: { ...accountState.profile } } : {}),
    }),
    refreshAccountProfile: refreshAccountProfileState,
    getDailyRecommendations: getDailyRecommendationSnapshot,
    getLyrics: (trackId) => lyrics.getLyrics(trackId),
    getPlaybackState: () => controller.getPlaybackState(),
    async playbackPlay(trackId, qualityPreference) {
      const startedAt = Date.now();
      try {
        await controller.play({ trackId, qualityPreference });
        lastPlayLatencyMs = Date.now() - startedAt;
        recordDiagnostic('info', 'play_completed', {
          state: 'playing',
          durationMs: lastPlayLatencyMs,
        });
        return controller.getPlaybackState();
      } catch (error) {
        lastPlayLatencyMs = Date.now() - startedAt;
        recordDiagnostic('warn', 'play_failed', {
          code: asBridgeError(error).code,
          state: 'error',
          durationMs: lastPlayLatencyMs,
        });
        throw error;
      }
    },
    async playbackStop() {
      await controller.stop();
      return controller.getPlaybackState();
    },
    async playbackPause() {
      await controller.pause();
      return controller.getPlaybackState();
    },
    async playbackResume() {
      await controller.resume();
      return controller.getPlaybackState();
    },
    async playbackNext() {
      await controller.next();
      return controller.getPlaybackState();
    },
    async playbackPrevious() {
      await controller.previous();
      return controller.getPlaybackState();
    },
    async replacePlaybackQueue(items, index) {
      await controller.replaceQueue(items, index);
      return controller.getPlaybackState();
    },
    async appendPlaybackQueue(items) {
      await controller.appendQueue(items);
      return controller.getPlaybackState();
    },
    async insertNextPlayback(items) {
      await controller.insertNext(items);
      return controller.getPlaybackState();
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

const SYNTHETIC_QR_IMAGE = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNTYiIGhlaWdodD0iMjU2IiB2aWV3Qm94PSIwIDAgMzMgMzMiIHNoYXBlLXJlbmRlcmluZz0iY3Jpc3BFZGdlcyI+PHBhdGggZmlsbD0iI2ZmZmZmZiIgZD0iTTAgMGgzM3YzM0gweiIvPjxwYXRoIHN0cm9rZT0iIzAwMDAwMCIgZD0iTTIgMi41aDdtMSAwaDFtMSAwaDJtNCAwaDFtMSAwaDNtMSAwaDdNMiAzLjVoMW01IDBoMW0xIDBoMW0xIDBoMW0xIDBoMm04IDBoMW01IDBoMU0yIDQuNWgxbTEgMGgzbTEgMGgxbTMgMGgybTEgMGgzbTIgMGgybTIgMGgxbTEgMGgzbTEgMGgxTTIgNS41aDFtMSAwaDNtMSAwaDFtMSAwaDFtNCAwaDJtMiAwaDNtMiAwaDFtMSAwaDNtMSAwaDFNMiA2LjVoMW0xIDBoM20xIDBoMW0zIDBoMW0zIDBoM20yIDBoMW0yIDBoMW0xIDBoM20xIDBoMU0yIDcuNWgxbTUgMGgxbTIgMGgybTIgMGgybTIgMGgzbTIgMGgxbTUgMGgxTTIgOC41aDdtMSAwaDFtMSAwaDFtMSAwaDFtMSAwaDFtMSAwaDFtMSAwaDFtMSAwaDFtMSAwaDdNMTAgOS41aDFtMiAwaDJtMyAwaDNNMiAxMC41aDFtMSAwaDJtMSAwaDNtMSAwaDJtMiAwaDFtMiAwaDVtMSAwaDFtMiAwaDFtMSAwaDJNNCAxMS41aDFtMiAwaDFtMiAwaDNtMSAwaDJtMiAwaDFtMiAwaDRtMSAwaDFtMSAwaDNNMiAxMi41aDFtMiAwaDJtMSAwaDFtNSAwaDJtMyAwaDJtMiAwaDdNMiAxMy41aDFtMSAwaDFtMSAwaDFtMiAwaDFtMSAwaDNtNyAwaDNtMiAwaDFtMiAwaDFNMiAxNC41aDNtMiAwaDJtMiAwaDJtMSAwaDFtMSAwaDFtMiAwaDFtMyAwaDFtMSAwaDFtMiAwaDJNMiAxNS41aDFtMSAwaDFtMSAwaDJtMiAwaDVtMSAwaDRtMSAwaDFtMiAwaDJtMiAwaDNNNSAxNi41aDFtMiAwaDFtMSAwaDFtMiAwaDFtMSAwaDFtMiAwaDFtMSAwaDJtMSAwaDFtMSAwaDFtMiAwaDNNNCAxNy41aDRtMSAwaDJtNSAwaDNtNSAwaDRNNCAxOC41aDFtMSAwaDFtMSAwaDFtMSAwaDFtMSAwaDJtMiAwaDJtMiAwaDRtMSAwaDJtMiAwaDFNMyAxOS41aDNtNCAwaDRtMiAwaDJtMiAwaDFtMSAwaDJtMSAwaDFtMSAwaDFtMSAwaDFNMiAyMC41aDFtMiAwaDFtMiAwaDFtMSAwaDNtMiAwaDZtMiAwaDFtMSAwaDFtMiAwaDFNMTEgMjEuNWgxbTMgMGgybTIgMGgybTIgMGgybTIgMGgzTTMgMjIuNWg2bTMgMGg1bTEgMGg5bTEgMGgyTTEwIDIzLjVoMW0xIDBoMW0xIDBoMW0zIDBoMW0yIDBoMm0zIDBoMW0yIDBoMk0yIDI0LjVoN20xIDBoMW0xIDBoMm0yIDBoMW0yIDBoNG0xIDBoMW0xIDBoMW0yIDBoMU0yIDI1LjVoMW01IDBoMW0xIDBoMW0yIDBoNG0xIDBoMW0zIDBoMW0zIDBoMU0yIDI2LjVoMW0xIDBoM20xIDBoMW0zIDBoMW02IDBoMm0xIDBoNW0xIDBoMU0yIDI3LjVoMW0xIDBoM20xIDBoMW0xIDBoMW0yIDBoMW0zIDBoMm00IDBoMW0xIDBoMm0zIDBoMU0yIDI4LjVoMW0xIDBoM20xIDBoMW0xIDBoMW0yIDBoMW0xIDBoMW00IDBoMW0xIDBoMm0xIDBoMW00IDBoMU0yIDI5LjVoMW01IDBoMW0yIDBoMW0xIDBoMm03IDBoM20xIDBoMm0xIDBoMU0yIDMwLjVoN20xIDBoMW0yIDBoMW0xIDBoMm0zIDBoNG01IDBoMSIvPjwvc3ZnPgo='

export interface TestBridgeRuntimeOptions {
  authorized?: boolean
  accountMode?: 'ready' | 'profile-unavailable' | 'expired'
}

export function createTestBridgeRuntime(options: TestBridgeRuntimeOptions = {}): CoreRuntime {
  const accountMode = options.accountMode ?? 'ready'
  const syntheticAuthorized = options.authorized === true && accountMode !== 'expired'
  const fixtureTracks: readonly TrackSummary[] = Array.from({ length: 120 }, (_, index) => ({
    id: String(1000 + index),
    title: `Synthetic Track ${index + 1}`,
    artists: ['Synthetic Artist'],
    album: 'Synthetic Album',
    durationMs: 180_000 + index * 1_000,
    artworkUrl: 'https://p1.music.126.net/synthetic-cover.jpg',
  }));
  const fixtureArtists: readonly ArtistSummary[] = [
    { id: '2000', name: 'Synthetic Artist', artworkUrl: 'https://p1.music.126.net/synthetic-cover.jpg', albumCount: 3, trackCount: fixtureTracks.length },
    { id: '2001', name: 'Synthetic Guest', albumCount: 1, trackCount: 4 },
  ];
  const fixtureAlbums: readonly AlbumSummary[] = [
    { id: '3000', name: 'Synthetic Album', artistId: '2000', artistName: 'Synthetic Artist', artworkUrl: 'https://p1.music.126.net/synthetic-cover.jpg', trackCount: fixtureTracks.length },
    { id: '3001', name: 'Synthetic Sessions', artistId: '2001', artistName: 'Synthetic Guest', trackCount: 4 },
  ];
  const fixturePlaylistId = '301';
  const fixtureZoneId = 'synthetic-zone';
  const pageOf = <T>(items: readonly T[], page: PageRequest): Page<T> => {
    const start = Math.min(page.offset, items.length);
    const end = Math.min(start + page.limit, items.length);
    return {
      items: items.slice(start, end),
      offset: start,
      limit: page.limit,
      total: items.length,
      hasMore: end < items.length,
    };
  };
  const syntheticSearchPage = <T>(items: readonly T[], query: string, page: PageRequest): Page<T> =>
    query.trim() === '无结果字符串' ? pageOf([], page) : pageOf(items, page);
  let state: PublicBridgeState = {
    runtime: 'starting',
    roon: 'disconnected',
    provider: syntheticAuthorized ? 'configured' : 'missing',
    activeStreamCount: 0,
    activePlaybackPresent: false,
  };
  let authState: PublicAuthState = {
    status: syntheticAuthorized ? 'authorized' : accountMode === 'expired' ? 'expired' : 'idle',
  };
  const dailyDayKey = localDayKey();
  const dailyRecommendations: DailyRecommendationsSnapshot = {
    dayKey: dailyDayKey,
    tracks: fixtureTracks.slice(0, 12).map((track, index) => ({
      ...track,
      recommendationReason: index === 0 ? 'Synthetic taste match' : 'Synthetic daily pick',
    })),
  };
  let accountState: PublicAccountState = syntheticAuthorized
    ? accountMode === 'profile-unavailable'
      ? { status: 'unavailable' }
      : {
          status: 'ready',
          profile: {
            displayName: 'Synthetic Listener',
            avatarUrl: 'https://p1.music.126.net/synthetic-avatar.jpg',
          },
        }
    : { status: 'missing' };
  let playbackState = emptyPlaybackState();
  let selectedZoneId: string | undefined;
  const diagnostics = new DiagnosticRingBuffer();
  const trackFor = (trackId: string): TrackSummary | undefined =>
    fixtureTracks.find((track) => track.id === trackId);
  const verifiedQueueItem = (item: PlaybackQueueRequestItem): PlaybackQueueItem => {
    const track = trackFor(item.trackId);
    return track ? { ...item, track } : { ...item };
  };
  const setPlayingTrack = (trackId: string, qualityPreference: PlaybackQualityPreference): void => {
    const requestedQuality: PlaybackQuality = qualityPreference === 'auto' ? 'hires' : qualityPreference;
    const actualQuality: PlaybackQuality = requestedQuality === 'hires' ? 'lossless' : requestedQuality;
    const currentTrack = trackFor(trackId);
    const {
      currentTrack: _previousTrack,
      selectedZoneId: _previousZone,
      qualityNotice: _previousQualityNotice,
      ...basePlaybackState
    } = playbackState;
    const nextState: PlaybackSnapshot = {
      ...basePlaybackState,
      state: 'playing',
      ...(currentTrack ? { currentTrack } : {}),
      qualityPreference,
      requestedQuality,
      actualQuality,
      positionMs: 0,
      format: 'flac',
      bitrate: 1_411_200,
      ...(selectedZoneId ? { selectedZoneId } : {}),
      ...(qualityPreference !== 'auto' && actualQuality !== requestedQuality
        ? {
            qualityNotice: {
              code: 'QUALITY_DOWNGRADED' as const,
              message: 'Requested quality was downgraded for this synthetic flow',
              retryable: false,
              diagnosticId: 'diag-synthetic-quality',
              action: 'none' as const,
            },
          }
        : {}),
      canNext: playbackState.queue.index < playbackState.queue.items.length - 1,
      canPrevious: playbackState.queue.index > 0,
      canStop: true,
      canPause: true,
      canResume: false,
    };
    playbackState = nextState;
  };
  const getDiagnostics = (): DiagnosticComponentSnapshot => {
    const queueStateMachinePassed = playbackState.queue.items.length >= 100;
    const resourcesClean =
      playbackState.queue.items.length === 0 &&
      !playbackState.canStop &&
      state.activeStreamCount === 0 &&
      !state.activePlaybackPresent;
    return {
      component: 'core',
      health: state,
      timeline: diagnostics.snapshot(),
      memory: {
        rssBytes: process.memoryUsage().rss,
        heapUsedBytes: process.memoryUsage().heapUsed,
        heapTotalBytes: process.memoryUsage().heapTotal,
        externalBytes: process.memoryUsage().external,
      },
      counters: {
        queueItemCount: playbackState.queue.items.length,
        activeStreamCount: 0,
        activePlaybackCount: playbackState.canStop ? 1 : 0,
        activeSessionCount: 0,
        activeTokenCount: 0,
        listenerCount: 0,
        timerCount: 0,
      },
      latency: {},
      gates: [
        { name: 'startup', status: state.runtime === 'ready' ? 'pass' : 'not-run' },
        { name: 'queue-state-machine', status: queueStateMachinePassed ? 'pass' : 'not-run' },
        { name: 'crash-recovery', status: 'not-run' },
        { name: 'resource-cleanup', status: resourcesClean ? 'pass' : 'not-run' },
        { name: 'secret-scan', status: 'not-run' },
      ],
    };
  };
  return {
    async start() {
      state = { ...state, runtime: 'ready', roon: 'ready' };
      diagnostics.record({ component: 'core', level: 'info', event: 'core_ready', state: 'ready' });
    },
    async shutdown() {
      playbackState = emptyPlaybackState();
      state = {
        ...state,
        runtime: 'stopped',
        roon: 'disconnected',
        activeStreamCount: 0,
        activePlaybackPresent: false,
      };
      diagnostics.record({ component: 'core', level: 'info', event: 'core_shutdown', state: 'stopped' });
    },
    ping: () => ({ pong: true as const }),
    getHealth: () => state,
    getState: () => state,
    getDiagnostics,
    async verifyProviderCredential() {
      return { status: 'authorized' as const };
    },
    async setProviderCredential() {
      state = { ...state, provider: 'configured' };
      authState = { status: 'authorized' };
      accountState = {
        status: 'ready',
        profile: {
          displayName: 'Synthetic Listener',
          avatarUrl: 'https://p1.music.126.net/synthetic-avatar.jpg',
        },
      };
      return state;
    },
    async clearProviderCredential() {
      state = { ...state, provider: 'missing' };
      authState = { status: 'idle' };
      accountState = { status: 'missing' };
      playbackState = emptyPlaybackState();
      return state;
    },
    getAccountState: () => ({
      ...accountState,
      ...(accountState.profile ? { profile: { ...accountState.profile } } : {}),
    }),
    async refreshAccountProfile() {
      return {
        ...accountState,
        ...(accountState.profile ? { profile: { ...accountState.profile } } : {}),
      };
    },
    async getDailyRecommendations() {
      return authState.status === 'authorized'
        ? dailyRecommendations
        : { dayKey: dailyDayKey, tracks: [] };
    },
    getAuthState: () => ({ ...authState }),
    async beginQrLogin() {
      authState = {
        status: 'waiting',
        challengeId: 'test-challenge',
        qrImage: SYNTHETIC_QR_IMAGE,
        expiresAt: Date.now() + 180_000,
      };
      return { ...authState };
    },
    async pollQrLogin() {
      authState = {
        status: 'waiting',
        challengeId: 'test-challenge',
        qrImage: SYNTHETIC_QR_IMAGE,
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
      accountState = { status: 'missing' };
      playbackState = emptyPlaybackState();
      return { ...authState };
    },
    async searchTracks(query, page) {
      return syntheticSearchPage(fixtureTracks, query, page);
    },
    async searchArtists(query, page) {
      return syntheticSearchPage(fixtureArtists, query, page);
    },
    async searchAlbums(query, page) {
      return syntheticSearchPage(fixtureAlbums, query, page);
    },
    async getArtist(artistId, page) {
      const artist = fixtureArtists.find((item) => item.id === artistId) ?? fixtureArtists[0];
      if (!artist) throw new BridgeError('NETEASE_REQUEST_FAILED', 'Synthetic artist detail unavailable', { httpStatus: 404 });
      return { ...artist, tracks: pageOf(fixtureTracks, page) };
    },
    async getAlbum(albumId, page) {
      const album = fixtureAlbums.find((item) => item.id === albumId) ?? fixtureAlbums[0];
      if (!album) throw new BridgeError('NETEASE_REQUEST_FAILED', 'Synthetic album detail unavailable', { httpStatus: 404 });
      return { ...album, tracks: pageOf(fixtureTracks, page) };
    },
    async getLikedTracks(page) {
      return pageOf(fixtureTracks, page);
    },
    async getUserPlaylists() {
      return [{ id: fixturePlaylistId, name: 'Synthetic Playlist', trackCount: fixtureTracks.length }];
    },
    async getPlaylist(playlistId, page) {
      return {
        id: playlistId,
        name: 'Synthetic Playlist',
        trackCount: fixtureTracks.length,
        tracks: pageOf(fixtureTracks, page),
      };
    },
    async getLyrics(trackId) {
      if (Number(trackId) % 2 === 0) return emptyLyricsSnapshot('unavailable');
      return {
        status: 'ready',
        lines: [
          { startMs: 0, text: 'Midnight finds us wide awake', translation: '午夜让我们保持清醒' },
          { startMs: 4_500, text: 'A quiet light across the room', translation: '一束安静的光穿过房间' },
          { startMs: 9_000, text: 'We leave the windows open', translation: '我们把窗户留在夜风里' },
          { startMs: 13_500, text: 'And let the city bloom', translation: '让城市在眼前慢慢盛开' },
          { startMs: 18_000, text: 'Every small sound pulls us closer', translation: '每一个细小声音都让我们靠近' },
          { startMs: 22_500, text: 'Every shadow turns to gold', translation: '每一道影子都变成金色' },
          { startMs: 27_000, text: 'Stay a little longer', translation: '再多停留一会儿' },
          { startMs: 31_500, text: 'Before the morning takes us home', translation: '在清晨带我们回家之前' },
        ],
        activeLineIndex: 0,
        timingSource: 'static',
      };
    },
    getPlaybackState: () => playbackState,
    async playbackPlay(trackId, qualityPreference) {
      playbackState = {
        ...playbackState,
        positionMs: 0,
        queue: { items: [verifiedQueueItem({ trackId, qualityPreference })], index: 0, hasNext: false, hasPrevious: false },
      };
      setPlayingTrack(trackId, qualityPreference);
      return playbackState;
    },
    async playbackPause() {
      if (playbackState.canPause) {
        playbackState = { ...playbackState, state: 'paused', canPause: false, canResume: true };
      }
      return playbackState;
    },
    async playbackResume() {
      if (playbackState.canResume) {
        playbackState = { ...playbackState, state: 'playing', canPause: true, canResume: false };
      }
      return playbackState;
    },
    async playbackStop() {
      playbackState = {
        ...playbackState,
        state: 'idle',
        positionMs: 0,
        canStop: false,
        canPause: false,
        canResume: false,
      };
      return playbackState;
    },
    async playbackNext() {
      if (playbackState.queue.hasNext) {
        const index = playbackState.queue.index + 1;
        const item = playbackState.queue.items[index];
        playbackState = {
          ...playbackState,
          queue: {
            ...playbackState.queue,
            index,
            hasNext: index < playbackState.queue.items.length - 1,
            hasPrevious: index > 0,
          },
        };
        if (item) setPlayingTrack(item.trackId, item.qualityPreference);
      }
      return playbackState;
    },
    async playbackPrevious() {
      if (playbackState.queue.hasPrevious) {
        const index = playbackState.queue.index - 1;
        const item = playbackState.queue.items[index];
        playbackState = {
          ...playbackState,
          queue: {
            ...playbackState.queue,
            index,
            hasNext: index < playbackState.queue.items.length - 1,
            hasPrevious: index > 0,
          },
        };
        if (item) setPlayingTrack(item.trackId, item.qualityPreference);
      }
      return playbackState;
    },
    async replacePlaybackQueue(items, index) {
      const verifiedItems = items.map(verifiedQueueItem);
      playbackState = {
        ...playbackState,
        state: 'playing',
        queue: {
          items: verifiedItems,
          index,
          hasNext: index < verifiedItems.length - 1,
          hasPrevious: index > 0,
        },
      };
      const item = verifiedItems[index];
      if (item) setPlayingTrack(item.trackId, item.qualityPreference);
      return playbackState;
    },
    async appendPlaybackQueue(items) {
      const verifiedItems = items.map(verifiedQueueItem);
      const nextItems = [...playbackState.queue.items, ...verifiedItems];
      const hasNext = playbackState.queue.index >= 0
        ? playbackState.queue.index < nextItems.length - 1
        : false;
      playbackState = {
        ...playbackState,
        queue: {
          ...playbackState.queue,
          items: nextItems,
          hasNext,
        },
        canNext: hasNext,
        canPrevious: playbackState.queue.index > 0,
      };
      return playbackState;
    },
    async insertNextPlayback(items) {
      const verifiedItems = items.map(verifiedQueueItem);
      const insertionIndex = playbackState.queue.index >= 0
        ? playbackState.queue.index + 1
        : 0;
      const nextItems = [...playbackState.queue.items];
      nextItems.splice(insertionIndex, 0, ...verifiedItems);
      const hasNext = playbackState.queue.index >= 0
        ? playbackState.queue.index < nextItems.length - 1
        : false;
      playbackState = {
        ...playbackState,
        queue: {
          ...playbackState.queue,
          items: nextItems,
          hasNext,
        },
        canNext: hasNext,
        canPrevious: playbackState.queue.index > 0,
      };
      return playbackState;
    },
    listZones: () => ({
      zones: [{ zoneId: fixtureZoneId, displayName: 'Synthetic Zone', selected: selectedZoneId === fixtureZoneId }],
    }).zones,
    async selectZone(zoneId) {
      selectedZoneId = zoneId;
      state = { ...state, roon: 'ready' };
      playbackState = { ...playbackState, selectedZoneId };
      return state;
    },
  };
}
