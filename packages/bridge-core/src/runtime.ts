import path from 'node:path';
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
  FavoriteEntityDescriptor,
  FavoriteKind,
  FavoritePage,
  FavoriteRecord,
  PlaybackQueueItem,
  PlaybackQueueRequestItem,
  PlaybackQuality,
  PlaybackQualityPreference,
  PlaybackSnapshot,
  PublicAuthState,
  PublicAggregatedSearchResult,
  PublicAccountState,
  PublicBridgeState,
  PublicRoonZone,
  RoonImageOptions,
  RoonImageResult,
  RoonLibraryPage,
  TrackSummary,
  PublicTrackMatchResult,
  TypedIpcEvent,
} from '@music-bridge/contracts';
import {
  BridgeController,
  type BridgeState,
  type SmartRoonResolution,
} from './application/bridge-controller.js';
import { loadConfig } from './config/config.js';
import { ControlServer } from './control/server.js';
import { NeteaseClient } from './netease/client.js';
import type { CredentialVerificationStatus } from './netease/types.js';
import { emptyLyricsSnapshot } from './netease/lyrics.js';
import { QrLoginStateMachine } from './netease/qr-login.js';
import { RoonAudioInputAdapter, type RoonTimeShapeSummary } from './roon/adapter.js';
import { createRoonPublicLibrary } from './roon/public-library.js';
import type { RoonSdk } from './roon/sdk.js';
import { asBridgeError, BridgeError } from './shared/errors.js';
import { createLogger, type Logger } from './shared/logger.js';
import { StreamGateway } from './stream/gateway.js';
import { StreamRegistry } from './stream/registry.js';
import { LyricsCoordinator } from './lyrics/coordinator.js';
import {
  createLocalFavoriteRepository,
  type LocalFavoriteRepository,
} from './favorites/repository.js';
import {
  createMatchCache,
  matchLogicalRecording,
  MATCH_ALGORITHM_VERSION,
  type LogicalRecording,
  type MatchResult,
} from './matching/index.js';

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
  aggregateSearch(query: string, page: PageRequest): Promise<PublicAggregatedSearchResult>;
  getLikedTracks(page: PageRequest): Promise<Page<TrackSummary>>;
  getTrackLikeStatus(trackId: string): Promise<{ liked: boolean }>;
  likeTrack(trackId: string, liked: boolean): Promise<{ liked: boolean }>;
  matchLibraryTrack(track: TrackSummary): Promise<PublicTrackMatchResult>;
  getUserPlaylists(): Promise<readonly PlaylistSummary[]>;
  getPlaylist(playlistId: string, page: PageRequest): Promise<PlaylistDetail>;
  listFavorites(kind: FavoriteKind | undefined, page: PageRequest): Promise<FavoritePage>;
  checkFavorite(descriptor: FavoriteEntityDescriptor): Promise<{ favorite: boolean }>;
  setFavorite(descriptor: FavoriteEntityDescriptor, favorite: boolean): Promise<{ favorite: boolean; item?: FavoriteRecord }>;
  getLyrics(trackId: string): Promise<LyricsSnapshot>;
  getPlaybackState(): PlaybackSnapshot;
  playbackPlay(trackId: string, quality: PlaybackQualityPreference): Promise<PlaybackSnapshot>;
  seekPlayback(positionMs: number): Promise<{ positionMs: number }>;
  playbackStop(): Promise<PlaybackSnapshot>;
  playbackNext(): Promise<PlaybackSnapshot>;
  playbackPrevious(): Promise<PlaybackSnapshot>;
  replacePlaybackQueue(
    items: readonly PlaybackQueueRequestItem[],
    index: number,
  ): Promise<PlaybackSnapshot>;
  appendPlaybackQueue(items: readonly PlaybackQueueRequestItem[]): Promise<PlaybackSnapshot>;
  insertNextPlayback(items: readonly PlaybackQueueRequestItem[]): Promise<PlaybackSnapshot>;
  browseRoonAlbums(page: PageRequest): Promise<RoonLibraryPage>;
  browseRoonArtists(page: PageRequest): Promise<RoonLibraryPage>;
  browseRoonGenres(page: PageRequest): Promise<RoonLibraryPage>;
  browseRoonPlaylists(page: PageRequest): Promise<RoonLibraryPage>;
  browseRoonAlbum(reference: string, page: PageRequest): Promise<RoonLibraryPage>;
  browseRoonArtist(reference: string, page: PageRequest): Promise<RoonLibraryPage>;
  searchRoonLibrary(query: string, page: PageRequest): Promise<RoonLibraryPage>;
  getRoonImage(reference: string, options?: RoonImageOptions): Promise<RoonImageResult>;
  playRoonTrack(reference: string, zoneId: string): Promise<{ started: true }>;
  queueRoonTrack(reference: string, zoneId: string): Promise<{ queued: true }>;
  stopRoonTransport(): Promise<{ stopped: true }>;
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
  favoriteRepository?: LocalFavoriteRepository;
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
    activePlaybackPresent:
      state.activePlayback !== undefined || state.activeRoonPlayback !== undefined,
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
    ...(config.roonCoreHost ? { coreHost: config.roonCoreHost } : {}),
    ...(config.roonCorePort ? { corePort: config.roonCorePort } : {}),
    ...(options.onRoonTimeShape ? { onTimeShape: options.onRoonTimeShape } : {}),
  });
  const roonLibrary = createRoonPublicLibrary(() => roon.getLibraryService());
  const favoriteRepository = options.favoriteRepository ?? createLocalFavoriteRepository(
    path.join(process.cwd(), '.musicbridge-favorites.json'),
  );
  const matchCache = createMatchCache();
  const gateway = new StreamGateway({
    host: config.streamHost,
    port: config.streamPort,
    publicBaseUrl: config.publicStreamBaseUrl,
    registry,
    logger,
    remoteDevelopmentMode: config.mode === 'remote-core-development',
  });
  let notifyProviderExpired: () => void = () => undefined;
  let resolveSmartSource: (track: TrackSummary) => Promise<SmartRoonResolution | undefined> = async () => undefined;
  const controller = new BridgeController({
    netease,
    roon,
    registry,
    gateway,
    logger,
    roonLibrary: {
      play: (reference, zoneId) => roonLibrary.playTrack(reference, zoneId),
      stop: async () => {
        if (!roon.control) {
          throw new BridgeError('ROON_TRANSPORT_UNAVAILABLE', 'Roon transport control is not available', {
            httpStatus: 409,
          });
        }
        await roon.control('stop');
      },
    },
    resolveSmartSource: (track) => resolveSmartSource(track),
    ...(options.now ? { now: options.now } : {}),
    onProviderAuthExpired: () => {
      netease.clearCredential();
      notifyProviderExpired();
    },
  });
  let runtime: PublicBridgeState['runtime'] = 'starting';
  const control = new ControlServer({
    host: config.controlHost,
    port: config.controlPort,
    defaultQuality: config.defaultQuality,
    controller,
    roon: {
      listZones: () => roon.listZones().map((zone) => ({
        zoneId: zone.zone_id,
        displayName: zone.display_name ?? zone.zone_id,
        selected: zone.zone_id === controller.getState().roon.selectedZoneId,
      })),
      selectZone: (zoneId) => {
        roon.selectZone(zoneId);
        return toPublicBridgeState(controller.getState(), runtime);
      },
      browseRoonAlbums: (page) => roonLibrary.browseAlbums(page),
      browseRoonAlbum: (reference, page) => roonLibrary.browseAlbum(reference, page),
      getRoonImage: (reference, options) => roonLibrary.getImage(reference, options),
      async playRoonTrack(reference, zoneId) {
        await controller.playRoon({ reference, zoneId, track: roonLibrary.getTrackSummary(reference) });
        return { started: true as const };
      },
      async queueRoonTrack(reference, zoneId) {
        await controller.appendRoon({ reference, zoneId, track: roonLibrary.getTrackSummary(reference) });
        return { queued: true as const };
      },
      async seekRoonTransport(positionMs) {
        if (!roon.seek) {
          throw new BridgeError('ROON_TRANSPORT_UNAVAILABLE', 'Roon seek is not available', {
            httpStatus: 409,
          });
        }
        await roon.seek(positionMs);
        lyrics.updateRoonTime(positionMs);
        return { positionMs };
      },
      async stopRoonTransport() {
        await controller.stopRoonTransport();
        return { stopped: true as const };
      },
    },
    logger,
  });

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

  const matchLibraryTrack = async (track: TrackSummary): Promise<PublicTrackMatchResult> => {
    const recording: LogicalRecording = {
      neteaseTrackId: track.id,
      title: track.title,
      artists: track.artists,
      album: track.album,
      ...(track.durationMs !== undefined ? { durationMs: track.durationMs } : {}),
    };
    const cached = matchCache.get(recording);
    if (cached) return { trackId: track.id, ...cached };

    try {
      const query = `${track.artists[0] ?? ''} ${track.title}`.trim();
      const page = await roonLibrary.searchLibrary(query, { offset: 0, limit: 20 });
      const result = matchLogicalRecording(recording, page.items);
      matchCache.set(recording, result);
      return { trackId: track.id, ...result };
    } catch (error) {
      const code = asBridgeError(error).code;
      if (code !== 'ROON_LIBRARY_UNAVAILABLE' && code !== 'ROON_LIBRARY_REQUEST_FAILED') {
        throw error;
      }
      const result: MatchResult = {
        state: 'NONE' as const,
        confidence: 0,
        evidence: ['roon-library-unavailable'],
        candidates: [],
        algorithmVersion: MATCH_ALGORITHM_VERSION,
      };
      matchCache.set(recording, result);
      return { trackId: track.id, ...result };
    }
  };

  resolveSmartSource = async (track: TrackSummary): Promise<SmartRoonResolution | undefined> => {
    const zoneId = roon.getState().selectedZoneId;
    if (!zoneId) return undefined;
    const match = await matchLibraryTrack(track);
    if (match.state !== 'CONFIRMED' || match.candidate?.kind !== 'track') return undefined;
    return { reference: match.candidate.reference, zoneId };
  };

  const aggregateSearch = async (
    query: string,
    page: PageRequest,
  ): Promise<PublicAggregatedSearchResult> => {
    const [neteaseResult, roonResult] = await Promise.all([
      withProviderRecovery(() => netease.searchTracks(query, page)),
      roonLibrary.searchLibrary(query, page)
        .then((roon) => ({ roon, roonAvailable: true as const }))
        .catch((error: unknown) => {
          const code = asBridgeError(error).code;
          if (code !== 'ROON_LIBRARY_UNAVAILABLE' && code !== 'ROON_LIBRARY_REQUEST_FAILED') {
            throw error;
          }
          return {
            roon: { items: [], offset: page.offset, limit: page.limit, hasMore: false },
            roonAvailable: false as const,
          };
        }),
    ]);
    return {
      query,
      netease: neteaseResult,
      roon: roonResult.roon,
      roonAvailable: roonResult.roonAvailable,
    };
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
    controller.handleRoonPlaybackState(roon.getSelectedZonePlaybackState());
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
    aggregateSearch,
    getLikedTracks: (page) => withProviderRecovery(() => netease.getLikedTracks(page)),
    getTrackLikeStatus: (trackId) => withProviderRecovery(() => netease.isTrackLiked(trackId)),
    likeTrack: (trackId, liked) => withProviderRecovery(() => netease.likeTrack(trackId, liked)),
    matchLibraryTrack,
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
    async seekPlayback(positionMs: number): Promise<{ positionMs: number }> {
      if (!roon.seek) {
        throw new BridgeError('ROON_TRANSPORT_UNAVAILABLE', 'Roon seek is not available', {
          httpStatus: 409,
        });
      }
      await roon.seek(positionMs);
      lyrics.updateRoonTime(positionMs);
      return { positionMs };
    },
    async playbackStop() {
      await controller.stop();
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

    browseRoonAlbums: (page) => roonLibrary.browseAlbums(page),
    browseRoonArtists: (page) => roonLibrary.browseArtists(page),
    browseRoonGenres: (page) => roonLibrary.browseGenres(page),
    browseRoonPlaylists: (page) => roonLibrary.browsePlaylists(page),
    browseRoonAlbum: (reference, page) => roonLibrary.browseAlbum(reference, page),
    browseRoonArtist: (reference, page) => roonLibrary.browseArtist(reference, page),
    searchRoonLibrary: (query, page) => roonLibrary.searchLibrary(query, page),
    getRoonImage: (reference, options) => roonLibrary.getImage(reference, options),
    async playRoonTrack(reference, zoneId) {
      await controller.playRoon({
        reference,
        zoneId,
        track: roonLibrary.getTrackSummary(reference),
      });
      return { started: true as const };
    },
    async queueRoonTrack(reference, zoneId) {
      await controller.appendRoon({
        reference,
        zoneId,
        track: roonLibrary.getTrackSummary(reference),
      });
      return { queued: true as const };
    },
    async stopRoonTransport() {
      await controller.stopRoonTransport();
      return { stopped: true as const };
    },

    listFavorites: (kind, page) => favoriteRepository.listFavorites(kind, page),
    async checkFavorite(descriptor) {
      return { favorite: await favoriteRepository.isFavorite(descriptor) };
    },
    async setFavorite(descriptor, favorite) {
      const item = await favoriteRepository.setFavorite(descriptor, favorite);
      return { favorite, ...(item !== undefined ? { item } : {}) };
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
  const favoriteRepository = createLocalFavoriteRepository()
  const fixtureTracks: readonly TrackSummary[] = Array.from({ length: 120 }, (_, index) => ({
    id: String(1000 + index),
    title: `Synthetic Track ${index + 1}`,
    artists: ['Synthetic Artist'],
    album: 'Synthetic Album',
    durationMs: 180_000 + index * 1_000,
    artworkUrl: 'https://p1.music.126.net/synthetic-cover.jpg',
  }));
  const fixturePlaylistId = '301';
  const fixtureZoneId = 'synthetic-zone';
  const pageOf = (items: readonly TrackSummary[], page: PageRequest): Page<TrackSummary> => {
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
    async searchTracks(_query, page) {
      return pageOf(fixtureTracks, page);
    },
    async aggregateSearch(query, page) {
      return {
        query,
        netease: pageOf(fixtureTracks, page),
        roon: { items: [], offset: page.offset, limit: page.limit, hasMore: false },
        roonAvailable: false,
      };
    },
    async getLikedTracks(page) {
      return pageOf(fixtureTracks, page);
    },
    async getTrackLikeStatus() {
      return { liked: false };
    },
    async likeTrack(_trackId, liked) {
      return { liked };
    },
    async matchLibraryTrack(track) {
      return {
        trackId: track.id,
        state: 'NONE' as const,
        confidence: 0,
        evidence: ['roon-library-unavailable'],
        candidates: [],
        algorithmVersion: MATCH_ALGORITHM_VERSION,
      };
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
    async seekPlayback(positionMs) {
      playbackState = { ...playbackState, positionMs };
      return { positionMs };
    },
    async playbackPlay(trackId, qualityPreference) {
      playbackState = {
        ...playbackState,
        positionMs: 0,
        queue: { items: [verifiedQueueItem({ trackId, qualityPreference })], index: 0, hasNext: false, hasPrevious: false },
      };
      setPlayingTrack(trackId, qualityPreference);
      return playbackState;
    },
    async playbackStop() {
      playbackState = { ...playbackState, state: 'idle', positionMs: 0, canStop: false };
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
    async browseRoonAlbums(page) {
      return { items: [], offset: page.offset, limit: page.limit };
    },
    async browseRoonArtists(page) {
      return { items: [], offset: page.offset, limit: page.limit };
    },
    async browseRoonGenres(page) {
      return { items: [], offset: page.offset, limit: page.limit };
    },
    async browseRoonPlaylists(page) {
      return { items: [], offset: page.offset, limit: page.limit };
    },
    async browseRoonAlbum() {
      throw new BridgeError('ROON_LIBRARY_UNAVAILABLE', 'Synthetic runtime has no Roon Library', {
        httpStatus: 503,
      });
    },
    async browseRoonArtist() {
      throw new BridgeError('ROON_LIBRARY_UNAVAILABLE', 'Synthetic runtime has no Roon Library', {
        httpStatus: 503,
      });
    },
    async searchRoonLibrary() {
      throw new BridgeError('ROON_LIBRARY_UNAVAILABLE', 'Synthetic runtime has no Roon Library', {
        httpStatus: 503,
      });
    },
    async getRoonImage() {
      throw new BridgeError('ROON_LIBRARY_UNAVAILABLE', 'Synthetic runtime has no Roon Library', {
        httpStatus: 503,
      });
    },
    async playRoonTrack() {
      throw new BridgeError('ROON_LIBRARY_UNAVAILABLE', 'Synthetic runtime has no Roon Library', {
        httpStatus: 503,
      });
    },
    async queueRoonTrack() {
      throw new BridgeError('ROON_LIBRARY_UNAVAILABLE', 'Synthetic runtime has no Roon Library', {
        httpStatus: 503,
      });
    },
    async stopRoonTransport() {
      return { stopped: true as const };
    },
    listFavorites: (kind, page) => favoriteRepository.listFavorites(kind, page),
    async checkFavorite(descriptor) {
      return { favorite: await favoriteRepository.isFavorite(descriptor) };
    },
    async setFavorite(descriptor, favorite) {
      const item = await favoriteRepository.setFavorite(descriptor, favorite);
      return { favorite, ...(item !== undefined ? { item } : {}) };
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
