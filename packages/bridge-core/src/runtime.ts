import { createRecordingPrintCoordinator, type RecordingPrintCoordinator } from './recording/print-coordinator.js';
import { createRecordingReplicaInput } from './recording/replica-input.js';
import { createRecordingReplicaCoordinator, type RecordingReplicaCoordinator } from './recording/replica-coordinator.js';
import { createRecordingRecordCoordinator, type RecordingRecordCoordinator } from './recording/record-coordinator.js';
import { createRecordingAttemptCoordinator, type RecordingAttemptCoordinator } from './recording/attempt-coordinator.js';
import { createRecordingOutputService, type RecordingOutputService } from './recording/output-service.js';
import type { PinnedOutputHelper } from './recording/bundled-output-helper.js';
import { createRecordingPlanCoordinator, type RecordingPlanCoordinator } from './recording/plan-coordinator.js';
import { randomUUID } from 'node:crypto';
import { createDatasetCommandBoundary, type DatasetIdentity } from './recording/dataset-identity.js';
import type { ArchiveContentBinding } from './recording/backup-package.js';
import type { RootCapability } from './recording/source-files.js';
import { createBackupCoordinator, type BackupCoordinator } from './recording/backup-coordinator.js';
import { createBackupWorkflowStore, type BackupWorkflowStore } from './recording/backup-workflow-store.js';
import { createExecutionCoordinator, type ExecutionCoordinator } from './recording/execution-coordinator.js';
import { createArchiveCoordinator, type ArchiveCoordinator } from './recording/archive-coordinator.js';
import { assertSourceOutsideArchives } from './recording/archive-input.js';
import type { FfmpegConverter } from './recording/audio-converter.js';
import { createPreparedCoordinator, type PreparedCoordinator } from './recording/prepared-coordinator.js';
import { createMasterVersionsCoordinator, type MasterVersionsCoordinator } from './recording/versions-coordinator.js';
import { createPreparationCoordinator, type PreparationCoordinator } from './recording/preparation-coordinator.js';
import { createMediaPlanningCoordinator, type MediaPlanningCoordinator } from './recording/media-coordinator.js';
import { createSourceEvidenceService, type SourceEvidenceService } from './recording/source-evidence.js';
import { createMasterDraftsCoordinator, type MasterDraftsCoordinator } from './recording/drafts-coordinator.js';
import { createPhysicalLinksCoordinator, type PhysicalLinksCoordinator } from './collection/physical-links-coordinator.js';
import type { RoonPublicLibrary } from './roon/public-library.js';
import path from 'node:path';
import { createCollectionRepository, type CollectionRepository } from './collection/repository.js';
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
  LocalLyricsMatchSnapshot,
  DailyRecommendationsSnapshot,
  ArtistDetail,
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
  RoonImageShapeSummary,
  RoonLibraryPage,
  TrackSummary,
  ArtistSummary,
  AlbumDetail,
  AlbumSummary,
  PublicTrackMatchResult,
  TypedIpcEvent,
} from '@music-bridge/contracts';
import {
  BridgeController,
  type BridgeState,
  type PlaybackStartupStage,
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
import type { RoonBrowseShapeSummary } from './roon/library.js';
import { switchRoonZoneAfterStop } from './roon/zone-switch.js';
import { confirmRoonTrackActionAfterExactMatchFailure } from './roon/track-action-confirmation.js';
import type { RoonSdk } from './roon/sdk.js';
import { asBridgeError, BridgeError } from './shared/errors.js';
import { createLogger, type Logger } from './shared/logger.js';
import { StreamGateway } from './stream/gateway.js';
import { StreamRegistry } from './stream/registry.js';
import {
  LyricsCoordinator,
  createLyricsRequestContext,
} from './lyrics/coordinator.js';
import { LyricsMatchResolver } from './lyrics-matching/resolver.js';
import { LocalLyricsManualMatchController } from './lyrics-matching/manual-controller.js';
import {
  createLyricsMatchRepository,
  type LyricsMatchRepository,
} from './lyrics-matching/repository.js';
import {
  createLocalFavoriteRepository,
  type LocalFavoriteRepository,
} from './favorites/repository.js';
import {
  createMatchCache,
  isCacheableMatchResult,
  MATCH_ALGORITHM_VERSION,
  type LogicalRecording,
  type MatchResult,
} from './matching/index.js';
import { resolveRoonMatch } from './matching/candidate-resolution.js';

export type CoreRuntimeEvent = TypedIpcEvent;

export interface CoreRuntime {
  readonly commandOutbox?: ReturnType<typeof createDatasetCommandBoundary>;
  physicalLinks?: PhysicalLinksCoordinator;
  masterDrafts?: MasterDraftsCoordinator;
  sources?: SourceEvidenceService;
  mediaPlanning?: MediaPlanningCoordinator;
  masterVersions?: MasterVersionsCoordinator;
  preparation?: PreparationCoordinator;
  prepared?: PreparedCoordinator;
  execution?: ExecutionCoordinator;
  archive?: ArchiveCoordinator;
  recordingPlans?: RecordingPlanCoordinator;
  recordingOutput?: RecordingOutputService;
  recordingAttempts?: RecordingAttemptCoordinator;
  recordingRecords?: RecordingRecordCoordinator;
  recordingPrints?: RecordingPrintCoordinator;
  recordingReplica?: RecordingReplicaCoordinator;
  backups?: BackupCoordinator;
  readonly collection?: CollectionRepository;
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
  getLocalLyricsMatch(): LocalLyricsMatchSnapshot;
  selectLocalLyricsMatch(matchSessionId: string, candidateId: string): Promise<LocalLyricsMatchSnapshot>;
  revokeLocalLyricsMatch(): Promise<LocalLyricsMatchSnapshot>;
  getPlaybackState(): PlaybackSnapshot;
  playbackPlay(
    trackId: string,
    quality: PlaybackQualityPreference,
    rendererClickAtMs?: number,
  ): Promise<PlaybackSnapshot>;
  playbackPause(): Promise<PlaybackSnapshot>;
  playbackResume(): Promise<PlaybackSnapshot>;
  seekPlayback(positionMs: number): Promise<{ positionMs: number }>;
  playbackStop(): Promise<PlaybackSnapshot>;
  playbackNext(): Promise<PlaybackSnapshot>;
  playbackPrevious(): Promise<PlaybackSnapshot>;
  playbackPlayQueueIndex(index: number): Promise<PlaybackSnapshot>;
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
  browseRoonGenre(reference: string, page: PageRequest): Promise<RoonLibraryPage>;
  browseRoonPlaylist(reference: string, page: PageRequest): Promise<RoonLibraryPage>;
  searchRoonLibrary(query: string, page: PageRequest): Promise<RoonLibraryPage>;
  getRoonImage(reference: string, options?: RoonImageOptions): Promise<RoonImageResult>;
  playRoonTrack(reference: string, zoneId: string, queueReferences?: readonly string[]): Promise<{ started: true }>;
  queueRoonTrack(reference: string, zoneId: string): Promise<{ queued: true }>;
  stopRoonTransport(): Promise<{ stopped: true }>;
  listZones(): readonly PublicRoonZone[];
  selectZone(zoneId: string): Promise<PublicBridgeState>;
}

export interface BridgeRuntimeOptions {
  collectionDatasetIdentity?: DatasetIdentity;
  /** 仅由受信任的 Core 组合层注入；不从 Renderer 或系统 PATH 自动配置。 */
  recordingConverter?: FfmpegConverter;
  recordingOutputHelper?: PinnedOutputHelper;
  collectionRepository?: CollectionRepository;
  backupWorkflowStore?: BackupWorkflowStore;
  backupPrivateRoot?: RootCapability;
  backupContentBinding?: ArchiveContentBinding;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  roonSdk?: RoonSdk;
  now?: () => number;
  onEvent?: (event: CoreRuntimeEvent) => void;
  onRoonTimeShape?: (summary: RoonTimeShapeSummary) => void;
  onRoonBrowseShape?: (summary: RoonBrowseShapeSummary) => void;
  onRoonImageShape?: (summary: RoonImageShapeSummary) => void;
  favoriteRepository?: LocalFavoriteRepository;
  lyricsMatchRepository?: LyricsMatchRepository;
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

const PLAYBACK_STARTUP_DIAGNOSTIC_EVENTS: Record<PlaybackStartupStage, string> = {
  'metadata-ready': 'playback_metadata_ready',
  'stream-url-ready': 'playback_stream_url_ready',
  'gateway-preflight-ready': 'playback_gateway_preflight_ready',
  'roon-session-began': 'playback_roon_session_began',
  'roon-playing': 'playback_roon_playing',
};

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
    ...(options.onRoonBrowseShape ? { onBrowseShape: options.onRoonBrowseShape } : {}),
    ...(options.onRoonImageShape ? { onImageShape: options.onRoonImageShape } : {}),
  });
  const roonLibrary = createRoonPublicLibrary(
    () => roon.getLibraryService(),
    options.onRoonImageShape ? { onImageShape: options.onRoonImageShape } : {},
  );
  const favoriteRepository = options.favoriteRepository ?? createLocalFavoriteRepository(
    path.join(process.cwd(), '.musicbridge-favorites.json'),
  );
  const lyricsMatchRepository = options.lyricsMatchRepository ?? createLyricsMatchRepository();
  const matchCache = createMatchCache();
  let matchLibraryAvailable = roon.getLibraryService() !== undefined;
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
      play: async (reference, zoneId, track) => {
        const before = roon.getSelectedZonePlaybackObservation();
        if (!before || before.zoneId !== zoneId) {
          throw new BridgeError(
            'ROON_ZONE_NOT_SELECTED',
            'The requested Roon Zone is not the selected playback Zone',
            { httpStatus: 409 },
          );
        }
        const actionOutcome = await roonLibrary.playTrack(reference, zoneId);
        try {
          return await roon.waitForSelectedZonePlayback({
            zoneId,
            state: 'playing',
            afterRevision: before.revision,
            track,
          });
        } catch (error) {
          const latest = roon.getSelectedZonePlaybackObservation();
          return confirmRoonTrackActionAfterExactMatchFailure({
            zoneId,
            afterRevision: before.revision,
            expectedTrack: track,
            ...(latest !== undefined ? { latest } : {}),
            actionOutcome,
            exactMatchError: error,
          });
        }
      },
      pause: async () => {
        const before = roon.getSelectedZonePlaybackObservation();
        if (!before) {
          throw new BridgeError('ROON_ZONE_NOT_SELECTED', 'Roon Zone is not selected', {
            httpStatus: 409,
          });
        }
        await roon.control('pause');
        await roon.waitForSelectedZonePlayback({
          zoneId: before.zoneId,
          state: 'paused',
          afterRevision: before.revision,
        });
      },
      resume: async () => {
        const before = roon.getSelectedZonePlaybackObservation();
        if (!before) {
          throw new BridgeError('ROON_ZONE_NOT_SELECTED', 'Roon Zone is not selected', {
            httpStatus: 409,
          });
        }
        await roon.control('play');
        await roon.waitForSelectedZonePlayback({
          zoneId: before.zoneId,
          state: 'playing',
          afterRevision: before.revision,
          requirePosition: true,
        });
      },
      seek: async (positionMs) => {
        if (!roon.seek) {
          throw new BridgeError('ROON_TRANSPORT_UNAVAILABLE', 'Roon seek is not available', {
            httpStatus: 409,
          });
        }
        await roon.seek(positionMs);
      },
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
        ...(zone.is_seek_allowed !== undefined ? { seekAllowed: zone.is_seek_allowed === true } : {}),
      })),
      selectZone: async (zoneId) => {
        const stateBeforeSwitch = controller.getState();
        await switchRoonZoneAfterStop({
          hasActivePlayback: stateBeforeSwitch.activePlayback !== undefined
            || stateBeforeSwitch.activeRoonPlayback !== undefined,
          stop: () => controller.stop(),
          select: () => roon.selectZone(zoneId),
        });
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
        return {
          positionMs:
            roon.getSelectedZonePlaybackObservation()?.positionMs ?? positionMs,
        };
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
      const result = await resolveRoonMatch(recording, roonLibrary);
      if (isCacheableMatchResult(result)) matchCache.set(recording, result);
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
      if (isCacheableMatchResult(result)) matchCache.set(recording, result);
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

  const lyricsResolver = new LyricsMatchResolver({
    provider: {
      get configured() {
        return netease.configured;
      },
      searchTracks: (query, page) => withProviderRecovery(() => netease.searchTracks(query, page)),
      getLyrics: (trackId) => withProviderRecovery(() => netease.getLyrics(trackId)),
    },
    repository: lyricsMatchRepository,
  });
  let lyrics!: LyricsCoordinator;
  const manualLyrics = new LocalLyricsManualMatchController({
    repository: lyricsMatchRepository,
    reload: async (context) => {
      lyricsResolver.invalidate(context.signature.key);
      await lyrics.reloadActiveLocalLyrics(context);
    },
    onChange: (snapshot) => {
      emit({
        version: 1,
        event: 'lyrics.match.changed',
        payload: { state: snapshot },
      });
    },
  });
  lyrics = new LyricsCoordinator({
    load: (trackId) => withProviderRecovery(() => netease.getLyrics(trackId)),
    localResolver: lyricsResolver,
    onLocalResolution: (context, resolution) => {
      manualLyrics.observeResolution(context, resolution);
    },
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
    const lyricsContext = createLyricsRequestContext(snapshot, controller.getPlaybackGeneration());
    manualLyrics.observeContext(lyricsContext?.kind === 'local' ? lyricsContext : undefined);
    lyrics.onPlaybackChanged(snapshot, lyricsContext);
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
    const libraryAvailable = roon.getLibraryService() !== undefined;
    if (!libraryAvailable) roonLibrary.invalidateReferences();
    if (libraryAvailable !== matchLibraryAvailable) {
      matchLibraryAvailable = libraryAvailable;
      matchCache.invalidate();
    }
    controller.syncRoonTransportState();
    controller.handleRoonPlaybackState(roon.getSelectedZonePlaybackState());
    const state = publicState();
    emit(eventWithState('roon.changed', state));
    emit(eventWithState('core.health', state));
  });
  roon.setTimeHandler?.((event) => {
    if (controller.updateRoonTime(event)) lyrics.updateRoonTime(event.positionMs);
  });

  const sources = options.collectionRepository ? createSourceEvidenceService({ store: options.collectionRepository.sources, drafts: options.collectionRepository.drafts, validateAuthorization: root => assertSourceOutsideArchives(root.path, options.collectionRepository!.archive) }) : undefined;
  const mediaPlanning = options.collectionRepository ? createMediaPlanningCoordinator({ store: options.collectionRepository.media, drafts: options.collectionRepository.drafts, ...(sources ? { sources } : {}) }) : undefined;
  const masterVersions = options.collectionRepository && sources && mediaPlanning ? createMasterVersionsCoordinator({ store: options.collectionRepository.versions, mediaStore: options.collectionRepository.media, media: mediaPlanning, drafts: options.collectionRepository.drafts, sourceStore: options.collectionRepository.sources, sources }) : undefined;
  const preparation = options.collectionRepository && sources ? createPreparationCoordinator({ store: options.collectionRepository.preparations, sourceStore: options.collectionRepository.sources, sources }) : undefined;
  const prepared = options.collectionRepository && preparation ? createPreparedCoordinator({ store: options.collectionRepository.prepared, preparationStore: options.collectionRepository.preparations, preparation, sourceStore: options.collectionRepository.sources }) : undefined;
  const execution = options.collectionRepository && sources && preparation ? createExecutionCoordinator({ store: options.collectionRepository.execution, profiles: options.collectionRepository.recordingProfiles, preparationStore: options.collectionRepository.preparations, preparedStore: options.collectionRepository.prepared, mediaStore: options.collectionRepository.media, sourceStore: options.collectionRepository.sources, sources, preparation, ...(options.recordingConverter ? { converter: options.recordingConverter } : {}) }) : undefined;
  const backups = options.backupWorkflowStore && options.collectionRepository ? createBackupCoordinator({ store: options.backupWorkflowStore, repository: options.collectionRepository, ...(options.backupPrivateRoot ? { privateRoot: options.backupPrivateRoot } : {}), ...(options.backupContentBinding ? { contentBinding: options.backupContentBinding } : {}) }) : undefined;
  const archive = options.collectionRepository && sources && preparation ? createArchiveCoordinator({ store: options.collectionRepository.archive, executionStore: options.collectionRepository.execution, preparationStore: options.collectionRepository.preparations, sourceStore: options.collectionRepository.sources, sources, preparation }) : undefined;
  const recordingPlans = options.collectionRepository ? createRecordingPlanCoordinator({ store: options.collectionRepository.recordingPlans }) : undefined;
  const recordingOutput = createRecordingOutputService({ ...(options.collectionRepository ? { store: options.collectionRepository.recordingPlans } : {}), ...(options.recordingOutputHelper ? { helper: options.recordingOutputHelper } : {}) });
  let recordingReplica: RecordingReplicaCoordinator | undefined;
  const assertReplicaCurrent = () => {
    if (options.collectionDatasetIdentity) options.collectionDatasetIdentity.assertCurrent();
    else options.collectionRepository!.list({ offset: 0, limit: 1 });
  };
  const recordingAttempts = options.collectionRepository ? createRecordingAttemptCoordinator({ store: options.collectionRepository.recordingAttempts, assertReplicaIdle: () => recordingReplica?.assertExecutionIdle(), assertCurrent: () => {
    if (options.collectionDatasetIdentity) options.collectionDatasetIdentity.assertCurrent();
    else options.collectionRepository!.list({ offset: 0, limit: 1 });
  } }) : undefined;
  const recordingRecords = options.collectionRepository && recordingAttempts ? createRecordingRecordCoordinator({
    store: options.collectionRepository.recordingRecords,
    assertCurrent: () => {
      if (options.collectionDatasetIdentity) options.collectionDatasetIdentity.assertCurrent();
      else options.collectionRepository!.list({ offset: 0, limit: 1 });
    },
    assertExecutionIdle: () => recordingAttempts.assertExecutionIdle(),
  }) : undefined;
  const recordingPrints = options.collectionRepository ? createRecordingPrintCoordinator({ store: options.collectionRepository.recordingPrints, assertCurrent: assertReplicaCurrent }) : undefined;
  recordingReplica = options.collectionRepository && recordingAttempts ? createRecordingReplicaCoordinator({
    input: createRecordingReplicaInput({ repository: options.collectionRepository, assertCurrent: assertReplicaCurrent, ...(options.backupContentBinding ? { contentBinding: options.backupContentBinding } : {}) }),
    assertCurrent: assertReplicaCurrent, assertAttemptIdle: () => recordingAttempts.assertExecutionIdle(),
  }) : undefined;
  const cleanup = async (): Promise<void> => {
    await recordingReplica?.close();
    await recordingPrints?.close();
    await recordingRecords?.close();
    await recordingAttempts?.close();
    await recordingOutput.close();
    await recordingPlans?.close();
    await backups?.close();
    await archive?.close();
    await execution?.close();
    await prepared?.close();
    await preparation?.close();
    await masterVersions?.close();
    await sources?.close();
    options.collectionRepository?.close();
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
    getLocalLyricsMatch: () => manualLyrics.getSnapshot(),
    selectLocalLyricsMatch: (matchSessionId, candidateId) =>
      manualLyrics.select(matchSessionId, candidateId),
    revokeLocalLyricsMatch: () => manualLyrics.revoke(),
    getPlaybackState: () => controller.getPlaybackState(),
    async playbackPlay(trackId, qualityPreference, rendererClickAtMs) {
      const coreReceivedAtMs = options.now?.() ?? Date.now();
      const startedAt = Math.min(rendererClickAtMs ?? coreReceivedAtMs, coreReceivedAtMs);
      recordDiagnostic('info', 'playback_core_request_received', {
        durationMs: coreReceivedAtMs - startedAt,
      });
      try {
        await controller.play({
          trackId,
          qualityPreference,
          startupTrace: {
            startedAtMs: startedAt,
            onStage: (stage, elapsedMs) => {
              recordDiagnostic('info', PLAYBACK_STARTUP_DIAGNOSTIC_EVENTS[stage], {
                durationMs: elapsedMs,
              });
            },
          },
        });
        lastPlayLatencyMs = Math.max(0, (options.now?.() ?? Date.now()) - startedAt);
        recordDiagnostic('info', 'play_completed', {
          state: 'playing',
          durationMs: lastPlayLatencyMs,
        });
        return controller.getPlaybackState();
      } catch (error) {
        lastPlayLatencyMs = Math.max(0, (options.now?.() ?? Date.now()) - startedAt);
        recordDiagnostic('warn', 'play_failed', {
          code: asBridgeError(error).code,
          state: 'error',
          durationMs: lastPlayLatencyMs,
        });
        throw error;
      }
    },
    async seekPlayback(positionMs: number): Promise<{ positionMs: number }> {
      await controller.seek(positionMs);
      return { positionMs: controller.getPlaybackState().positionMs };
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
    async playbackPlayQueueIndex(index) {
      await controller.playQueueIndex(index);
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
    browseRoonGenre: (reference, page) => roonLibrary.browseGenre(reference, page),
    browseRoonPlaylist: (reference, page) => roonLibrary.browsePlaylist(reference, page),
    searchRoonLibrary: (query, page) => roonLibrary.searchLibrary(query, page),
    getRoonImage: (reference, options) => roonLibrary.getImage(reference, options),
    async playRoonTrack(reference, zoneId, queueReferences) {
      const references = queueReferences ?? [reference];
      await controller.replaceRoonQueue(references.map((entry) => ({
        reference: entry, zoneId, track: roonLibrary.getTrackSummary(entry),
      })), references.indexOf(reference));
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

    ...(sources ? { sources } : {}),
    ...(mediaPlanning ? { mediaPlanning } : {}),
    ...(masterVersions ? { masterVersions } : {}),
    ...(preparation ? { preparation } : {}),
    ...(prepared ? { prepared } : {}),
    ...(execution ? { execution } : {}),
    ...(archive ? { archive } : {}),
    ...(recordingPlans ? { recordingPlans } : {}),
    ...(recordingAttempts ? { recordingAttempts } : {}),
    ...(recordingRecords ? { recordingRecords } : {}),
    ...(recordingPrints ? { recordingPrints } : {}),
    ...(recordingReplica ? { recordingReplica } : {}),
    recordingOutput,
    ...(backups ? { backups } : {}),
    ...(options.collectionRepository ? { collection: options.collectionRepository, physicalLinks: createPhysicalLinksCoordinator({ repository: options.collectionRepository.links, library: roonLibrary }), masterDrafts: createMasterDraftsCoordinator({ repository: options.collectionRepository.drafts, library: roonLibrary }) } : {}),
    ...(options.collectionDatasetIdentity ? { commandOutbox: createDatasetCommandBoundary(options.collectionDatasetIdentity) } : {}),
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
      ...(zone.is_seek_allowed !== undefined ? { seekAllowed: zone.is_seek_allowed === true } : {}),
    })),

    async selectZone(zoneId: string): Promise<PublicBridgeState> {
      const stateBeforeSwitch = controller.getState();
      await switchRoonZoneAfterStop({
        hasActivePlayback: stateBeforeSwitch.activePlayback !== undefined
          || stateBeforeSwitch.activeRoonPlayback !== undefined,
        stop: () => controller.stop(),
        select: () => roon.selectZone(zoneId),
      });
      const state = publicState();
      emit(eventWithState('roon.changed', state));
      emitHealth();
      return state;
    },
  };
}

const SYNTHETIC_QR_IMAGE = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNTYiIGhlaWdodD0iMjU2IiB2aWV3Qm94PSIwIDAgMzMgMzMiIHNoYXBlLXJlbmRlcmluZz0iY3Jpc3BFZGdlcyI+PHBhdGggZmlsbD0iI2ZmZmZmZiIgZD0iTTAgMGgzM3YzM0gweiIvPjxwYXRoIHN0cm9rZT0iIzAwMDAwMCIgZD0iTTIgMi41aDdtMSAwaDFtMSAwaDJtNCAwaDFtMSAwaDNtMSAwaDdNMiAzLjVoMW01IDBoMW0xIDBoMW0xIDBoMW0xIDBoMm04IDBoMW01IDBoMU0yIDQuNWgxbTEgMGgzbTEgMGgxbTMgMGgybTEgMGgzbTIgMGgybTIgMGgxbTEgMGgzbTEgMGgxTTIgNS41aDFtMSAwaDNtMSAwaDFtMSAwaDFtNCAwaDJtMiAwaDNtMiAwaDFtMSAwaDNtMSAwaDFNMiA2LjVoMW0xIDBoM20xIDBoMW0zIDBoMW0zIDBoM20yIDBoMW0yIDBoMW0xIDBoM20xIDBoMU0yIDcuNWgxbTUgMGgxbTIgMGgybTIgMGgybTIgMGgzbTIgMGgxbTUgMGgxTTIgOC41aDdtMSAwaDFtMSAwaDFtMSAwaDFtMSAwaDFtMSAwaDFtMSAwaDFtMSAwaDFtMSAwaDdNMTAgOS41aDFtMiAwaDJtMyAwaDNNMiAxMC41aDFtMSAwaDJtMSAwaDNtMSAwaDJtMiAwaDFtMiAwaDVtMSAwaDFtMiAwaDFtMSAwaDJNNCAxMS41aDFtMiAwaDFtMiAwaDNtMSAwaDJtMiAwaDFtMiAwaDRtMSAwaDFtMSAwaDNNMiAxMi41aDFtMiAwaDJtMSAwaDFtNSAwaDJtMyAwaDJtMiAwaDdNMiAxMy41aDFtMSAwaDFtMSAwaDFtMiAwaDFtMSAwaDNtNyAwaDNtMiAwaDFtMiAwaDFNMiAxNC41aDNtMiAwaDJtMiAwaDJtMSAwaDFtMSAwaDFtMiAwaDFtMyAwaDFtMSAwaDFtMiAwaDJNMiAxNS41aDFtMSAwaDFtMSAwaDJtMiAwaDVtMSAwaDRtMSAwaDFtMiAwaDJtMiAwaDNNNSAxNi41aDFtMiAwaDFtMSAwaDFtMiAwaDFtMSAwaDFtMiAwaDFtMSAwaDJtMSAwaDFtMSAwaDFtMiAwaDNNNCAxNy41aDRtMSAwaDJtNSAwaDNtNSAwaDRNNCAxOC41aDFtMSAwaDFtMSAwaDFtMSAwaDFtMSAwaDJtMiAwaDJtMiAwaDRtMSAwaDJtMiAwaDFNMyAxOS41aDNtNCAwaDRtMiAwaDJtMiAwaDFtMSAwaDJtMSAwaDFtMSAwaDFtMSAwaDFNMiAyMC41aDFtMiAwaDFtMiAwaDFtMSAwaDNtMiAwaDZtMiAwaDFtMSAwaDFtMiAwaDFNMTEgMjEuNWgxbTMgMGgybTIgMGgybTIgMGgybTIgMGgzTTMgMjIuNWg2bTMgMGg1bTEgMGg5bTEgMGgyTTEwIDIzLjVoMW0xIDBoMW0xIDBoMW0zIDBoMW0yIDBoMm0zIDBoMW0yIDBoMk0yIDI0LjVoN20xIDBoMW0xIDBoMm0yIDBoMW0yIDBoNG0xIDBoMW0xIDBoMW0yIDBoMU0yIDI1LjVoMW01IDBoMW0xIDBoMW0yIDBoNG0xIDBoMW0zIDBoMW0zIDBoMU0yIDI2LjVoMW0xIDBoM20xIDBoMW0zIDBoMW02IDBoMm0xIDBoNW0xIDBoMU0yIDI3LjVoMW0xIDBoM20xIDBoMW0xIDBoMW0yIDBoMW0zIDBoMm00IDBoMW0xIDBoMm0zIDBoMU0yIDI4LjVoMW0xIDBoM20xIDBoMW0xIDBoMW0yIDBoMW0xIDBoMW00IDBoMW0xIDBoMm0xIDBoMW00IDBoMU0yIDI5LjVoMW01IDBoMW0yIDBoMW0xIDBoMm03IDBoM20xIDBoMm0xIDBoMU0yIDMwLjVoN20xIDBoMW0yIDBoMW0xIDBoMm0zIDBoNG01IDBoMSIvPjwvc3ZnPgo='

export interface TestBridgeRuntimeOptions {
  collectionDatasetIdentity?: DatasetIdentity;
  recordingConverter?: FfmpegConverter;
  recordingOutputHelper?: PinnedOutputHelper;
  roonLibrary?: RoonPublicLibrary;
  collectionRepository?: CollectionRepository;
  backupWorkflowStore?: BackupWorkflowStore;
  backupPrivateRoot?: RootCapability;
  backupContentBinding?: ArchiveContentBinding;
  authorized?: boolean
  accountMode?: 'ready' | 'profile-unavailable' | 'expired'
}

export function createTestBridgeRuntime(options: TestBridgeRuntimeOptions = {}): CoreRuntime {
  const collection = options.collectionRepository ?? createCollectionRepository({ filePath: ':memory:' });
  const commandOutbox = createDatasetCommandBoundary(options.collectionDatasetIdentity ?? { datasetId: randomUUID(), assertCurrent: () => { collection.list({ offset: 0, limit: 1 }); } });
  const backups = createBackupCoordinator({ store: options.backupWorkflowStore ?? createBackupWorkflowStore({ filePath: ':memory:' }), repository: collection, ...(options.backupPrivateRoot ? { privateRoot: options.backupPrivateRoot } : {}), ...(options.backupContentBinding ? { contentBinding: options.backupContentBinding } : {}) });
  const sources = createSourceEvidenceService({ store: collection.sources, drafts: collection.drafts, validateAuthorization: root => assertSourceOutsideArchives(root.path, collection.archive) });
  const mediaPlanning = createMediaPlanningCoordinator({ store: collection.media, drafts: collection.drafts, sources });
  const masterVersions = createMasterVersionsCoordinator({ store: collection.versions, mediaStore: collection.media, media: mediaPlanning, drafts: collection.drafts, sourceStore: collection.sources, sources });
  const preparation = createPreparationCoordinator({ store: collection.preparations, sourceStore: collection.sources, sources });
  const prepared = createPreparedCoordinator({ store: collection.prepared, preparationStore: collection.preparations, preparation, sourceStore: collection.sources });
  const execution = createExecutionCoordinator({ store: collection.execution, profiles: collection.recordingProfiles, preparationStore: collection.preparations, preparedStore: collection.prepared, mediaStore: collection.media, sourceStore: collection.sources, sources, preparation, ...(options.recordingConverter ? { converter: options.recordingConverter } : {}) });
  const recordingPlans = createRecordingPlanCoordinator({ store: collection.recordingPlans });
  let assertReplicaIdle = () => {};
  const recordingAttempts = createRecordingAttemptCoordinator({ store: collection.recordingAttempts, assertReplicaIdle: () => assertReplicaIdle(), assertCurrent: () => { commandOutbox.context(); } });
  const recordingReplica = createRecordingReplicaCoordinator({
    input: createRecordingReplicaInput({ repository: collection, assertCurrent: () => { commandOutbox.context(); }, ...(options.backupContentBinding ? { contentBinding: options.backupContentBinding } : {}) }),
    assertCurrent: () => { commandOutbox.context(); }, assertAttemptIdle: () => recordingAttempts.assertExecutionIdle(),
  });
  assertReplicaIdle = () => recordingReplica.assertExecutionIdle();
  const recordingRecords = createRecordingRecordCoordinator({ store: collection.recordingRecords, assertCurrent: () => { commandOutbox.context(); }, assertExecutionIdle: () => recordingAttempts.assertExecutionIdle() });
  const recordingPrints = createRecordingPrintCoordinator({ store: collection.recordingPrints, assertCurrent: () => { commandOutbox.context(); } });
  const recordingOutput = createRecordingOutputService({ store: collection.recordingPlans, ...(options.recordingOutputHelper ? { helper: options.recordingOutputHelper } : {}) });
  const archive = createArchiveCoordinator({ store: collection.archive, executionStore: collection.execution, preparationStore: collection.preparations, sourceStore: collection.sources, sources, preparation });
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
      commandOutbox.context();
      state = { ...state, runtime: 'ready', roon: 'ready' };
      diagnostics.record({ component: 'core', level: 'info', event: 'core_ready', state: 'ready' });
    },
    async shutdown() {
      await recordingReplica.close();
      await recordingPrints.close();
      await recordingRecords.close();
      await recordingAttempts.close();
      await recordingOutput.close();
      await recordingPlans.close();
      await backups.close();
      await archive.close();
      await execution.close();
      await prepared.close();
      await preparation.close();
      await masterVersions.close();
      await sources.close();
      collection.close();
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
        source: 'netease',
      };
    },
    getLocalLyricsMatch: () => ({ status: 'hidden', candidates: [], canRevoke: false }),
    async selectLocalLyricsMatch() {
      throw new BridgeError('BAD_REQUEST', 'Synthetic local lyrics matching is unavailable', { httpStatus: 409 });
    },
    async revokeLocalLyricsMatch() {
      throw new BridgeError('BAD_REQUEST', 'Synthetic local lyrics matching is unavailable', { httpStatus: 409 });
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
    async playbackPlayQueueIndex(index) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= playbackState.queue.items.length) {
        throw new BridgeError('BAD_REQUEST', 'Playback queue index is invalid', { httpStatus: 400 });
      }
      const item = playbackState.queue.items[index];
      playbackState = {
        ...playbackState,
        state: 'playing',
        queue: {
          ...playbackState.queue,
          index,
          hasNext: index < playbackState.queue.items.length - 1,
          hasPrevious: index > 0,
        },
      };
      if (item) setPlayingTrack(item.trackId, item.qualityPreference);
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
      if (options.roonLibrary) return options.roonLibrary.browseAlbums(page);
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
    async browseRoonAlbum(reference, page) {
      if (options.roonLibrary) return options.roonLibrary.browseAlbum(reference, page);
      throw new BridgeError('ROON_LIBRARY_UNAVAILABLE', 'Synthetic runtime has no Roon Library', {
        httpStatus: 503,
      });
    },
    async browseRoonArtist() {
      throw new BridgeError('ROON_LIBRARY_UNAVAILABLE', 'Synthetic runtime has no Roon Library', {
        httpStatus: 503,
      });
    },
    async browseRoonGenre() {
      throw new BridgeError('ROON_LIBRARY_UNAVAILABLE', 'Synthetic runtime has no Roon Library', {
        httpStatus: 503,
      });
    },
    async browseRoonPlaylist() {
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
    collection,
    commandOutbox,
    sources,
    mediaPlanning, masterVersions, preparation, prepared, execution, archive, backups, recordingPlans, recordingOutput, recordingAttempts, recordingRecords, recordingPrints, recordingReplica,
    physicalLinks: createPhysicalLinksCoordinator({ repository: collection.links, library: options.roonLibrary ?? createRoonPublicLibrary(() => undefined) }),
    masterDrafts: createMasterDraftsCoordinator({ repository: collection.drafts, library: options.roonLibrary ?? createRoonPublicLibrary(() => undefined) }),
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
      if (playbackState.state !== 'idle') {
        const {
          currentTrack: _currentTrack,
          source: _source,
          qualityPreference: _qualityPreference,
          requestedQuality: _requestedQuality,
          actualQuality: _actualQuality,
          format: _format,
          bitrate: _bitrate,
          lastError: _lastError,
          lastIssue: _lastIssue,
          qualityNotice: _qualityNotice,
          ...stoppedPlayback
        } = playbackState;
        playbackState = {
          ...stoppedPlayback,
          state: 'idle',
          positionMs: 0,
          canNext: false,
          canPrevious: false,
          canStop: false,
          canPause: false,
          canResume: false,
        };
      }
      selectedZoneId = zoneId;
      state = { ...state, roon: 'ready' };
      playbackState = { ...playbackState, selectedZoneId };
      return state;
    },
  };
}
