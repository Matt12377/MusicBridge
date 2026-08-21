import type {
  Page,
  PageRequest,
  PlaylistDetail,
  PlaylistSummary,
  LyricsSnapshot,
  PlaybackQueueItem,
  PlaybackQuality,
  PlaybackSnapshot,
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
import { emptyLyricsSnapshot } from './netease/lyrics.js';
import { QrLoginStateMachine } from './netease/qr-login.js';
import { RoonAudioInputAdapter } from './roon/adapter.js';
import type { RoonSdk } from './roon/sdk.js';
import { asBridgeError } from './shared/errors.js';
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
  getLyrics(trackId: string): Promise<LyricsSnapshot>;
  getPlaybackState(): PlaybackSnapshot;
  playbackPlay(trackId: string, quality: PlaybackQuality): Promise<PlaybackSnapshot>;
  playbackStop(): Promise<PlaybackSnapshot>;
  playbackNext(): Promise<PlaybackSnapshot>;
  playbackPrevious(): Promise<PlaybackSnapshot>;
  replacePlaybackQueue(
    items: readonly PlaybackQueueItem[],
    index: number,
  ): Promise<PlaybackSnapshot>;
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

function emptyPlaybackState(): PlaybackSnapshot {
  return {
    state: 'idle',
    queue: {
      items: [],
      index: -1,
      hasNext: false,
      hasPrevious: false,
    },
    canNext: false,
    canPrevious: false,
    canStop: false,
  };
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
  const emit = (event: CoreRuntimeEvent): void => options.onEvent?.(event);
  const publicState = (): PublicBridgeState =>
    toPublicBridgeState(controller.getState(), runtime);
  const emitHealth = (): void => emit(eventWithState('core.health', publicState()));
  notifyProviderExpired = (): void => {
    emit(eventWithAuthState(qrLogin.markExpired()));
    emitHealth();
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

  const lyrics = new LyricsCoordinator({
    load: (trackId) => withProviderRecovery(() => netease.getLyrics(trackId)),
    onChange: (snapshot) => {
      emit({
        version: 1,
        event: 'lyrics.changed',
        payload: { state: snapshot },
      });
    },
  });

  controller.subscribe((snapshot) => {
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
    const state = publicState();
    emit(eventWithState('roon.changed', state));
    emit(eventWithState('core.health', state));
  });
  roon.setTimeHandler?.((positionMs) => lyrics.updateRoonTime(positionMs));

  const cleanup = async (): Promise<void> => {
    await control.stop();
    await controller.shutdown();
    await roon.shutdown();
    lyrics.shutdown();
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

    searchTracks: (query, page) => withProviderRecovery(() => netease.searchTracks(query, page)),
    getLikedTracks: (page) => withProviderRecovery(() => netease.getLikedTracks(page)),
    getUserPlaylists: () => withProviderRecovery(() => netease.getUserPlaylists()),
    getPlaylist: (playlistId, page) =>
      withProviderRecovery(() => netease.getPlaylist(playlistId, page)),
    getLyrics: (trackId) => lyrics.getLyrics(trackId),
    getPlaybackState: () => controller.getPlaybackState(),
    async playbackPlay(trackId, quality) {
      await controller.play({ trackId, quality });
      return controller.getPlaybackState();
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
  const fixtureTracks: readonly TrackSummary[] = Array.from({ length: 25 }, (_, index) => ({
    id: String(1000 + index),
    title: `Synthetic Track ${index + 1}`,
    artists: ['Synthetic Artist'],
    album: 'Synthetic Album',
    durationMs: 180_000 + index * 1_000,
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
    provider: 'missing',
    activeStreamCount: 0,
    activePlaybackPresent: false,
  };
  let authState: PublicAuthState = { status: 'idle' };
  let playbackState = emptyPlaybackState();
  let selectedZoneId: string | undefined;
  const trackFor = (trackId: string): TrackSummary | undefined =>
    fixtureTracks.find((track) => track.id === trackId);
  const setPlayingTrack = (trackId: string, quality: PlaybackQuality): void => {
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
      requestedQuality: quality,
      actualQuality: quality === 'hires' ? 'lossless' : quality,
      format: quality === 'hires' ? 'flac' : 'flac',
      bitrate: 1_411_200,
      ...(selectedZoneId ? { selectedZoneId } : {}),
      ...(quality === 'hires'
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
  return {
    async start() {
      state = { ...state, runtime: 'ready', roon: 'ready' };
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
      return pageOf(fixtureTracks, page);
    },
    async getLikedTracks(page) {
      return pageOf(fixtureTracks.slice(0, 12), page);
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
        lines: [{ startMs: 0, text: 'Synthetic lyric line' }],
        activeLineIndex: 0,
        timingSource: 'static',
      };
    },
    getPlaybackState: () => playbackState,
    async playbackPlay(trackId, quality) {
      playbackState = {
        ...playbackState,
        queue: { items: [{ trackId, quality }], index: 0, hasNext: false, hasPrevious: false },
      };
      setPlayingTrack(trackId, quality);
      return playbackState;
    },
    async playbackStop() {
      playbackState = { ...playbackState, state: 'idle', canStop: false };
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
        if (item) setPlayingTrack(item.trackId, item.quality);
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
        if (item) setPlayingTrack(item.trackId, item.quality);
      }
      return playbackState;
    },
    async replacePlaybackQueue(items, index) {
      playbackState = {
        ...playbackState,
        state: 'playing',
        queue: {
          items,
          index,
          hasNext: index < items.length - 1,
          hasPrevious: index > 0,
        },
      };
      const item = items[index];
      if (item) setPlayingTrack(item.trackId, item.quality);
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
