import type { RecordingRecordsPublicApi } from '@music-bridge/contracts'
import type { RecordingAttemptsPublicApi } from '@music-bridge/contracts'
import type { RecordingPlansPublicApi } from '@music-bridge/contracts'
import type { RecordingOutputPublicApi } from '@music-bridge/contracts'
import type { CollectionProgressPublicApi } from '@music-bridge/contracts'
import type { SpreadsheetImportPublicApi } from '@music-bridge/contracts'
import type { ReferenceCatalogPublicApi } from '@music-bridge/contracts'
import type { CommandOutboxPublicApi } from '@music-bridge/contracts'
import type { RecordingProfilesPublicApi, RecordingExecutionPublicApi, RecordingArchivePublicApi, RecordingBackupsPublicApi } from '@music-bridge/contracts'
import type { PreparedPublicApi } from '@music-bridge/contracts'
import type { PreparationPublicApi } from '@music-bridge/contracts'
import type { MasterVersionsPublicApi } from '@music-bridge/contracts'
import type { MediaPlanningPublicApi } from '@music-bridge/contracts'
import type { RecordingSourcesPublicApi } from '@music-bridge/contracts'
import type { MasterDraftsPublicApi } from '@music-bridge/contracts'
import type { PhysicalLinksPublicApi } from '@music-bridge/contracts'
import type { PhysicalMusicPublicApi } from '@music-bridge/contracts'
import type {
  AlbumDetail,
  CollectionPublicApi,
  AlbumSummary,
  ArtistDetail,
  ArtistSummary,
  Page,
  PageRequest,
  PlaylistDetail,
  PlaylistSummary,
  LyricsSnapshot,
  LocalLyricsMatchSnapshot,
  PlaybackQueueRequestItem,
  PlaybackQualityPreference,
  PlaybackSnapshot,
  PublicAuthState,
  PublicAccountState,
  PublicBridgeState,
  PublicRoonZone,
  RoonImageOptions,
  RoonImageResult,
  RoonLibraryPage,
  RemoteCoreTunnelState,
  DailyRecommendationsSnapshot,
  FavoriteEntityDescriptor,
  FavoriteKind,
  FavoritePage,
  FavoriteRecord,
  TrackSummary,
  PublicTrackMatchResult,
  PublicAggregatedSearchResult,
  TypedIpcEvent,
} from '@music-bridge/contracts'

export type AppCommand = 'show-queue'

export interface AppInfo {
  version: string
  buildMode: 'development' | 'production'
  platform: string
}

export const DEFAULT_REMOTE_CORE_STATE: RemoteCoreTunnelState = {
  mode: 'local-core',
  status: 'idle',
  localStreamPort: 38502,
  remoteHealth: 'unavailable',
  autoReconnect: false,
}

export interface MusicBridgePublicApi extends RecordingRecordsPublicApi, RecordingAttemptsPublicApi, RecordingOutputPublicApi, RecordingPlansPublicApi, CollectionProgressPublicApi, SpreadsheetImportPublicApi, ReferenceCatalogPublicApi, CommandOutboxPublicApi, RecordingBackupsPublicApi, RecordingArchivePublicApi, RecordingProfilesPublicApi, RecordingExecutionPublicApi, PreparedPublicApi, PreparationPublicApi, MasterVersionsPublicApi, MediaPlanningPublicApi, RecordingSourcesPublicApi, CollectionPublicApi, PhysicalMusicPublicApi, PhysicalLinksPublicApi, MasterDraftsPublicApi {
  getAppInfo: () => Promise<AppInfo>
  getCoreHealth: () => Promise<PublicBridgeState>
  getCoreState: () => Promise<PublicBridgeState>
  pingCore: () => Promise<{ pong: true }>
  exportDiagnostics: () => Promise<{ exported: boolean }>
  getAuthState: () => Promise<PublicAuthState>
  beginQrLogin: () => Promise<PublicAuthState>
  pollQrLogin: (challengeId: string) => Promise<PublicAuthState>
  cancelQrLogin: (challengeId: string) => Promise<PublicAuthState>
  logout: () => Promise<PublicAuthState>
  getAccountState: () => Promise<PublicAccountState>
  refreshAccountProfile: () => Promise<PublicAccountState>
  searchTracks: (query: string, page: PageRequest) => Promise<Page<TrackSummary>>
  searchArtists: (query: string, page: PageRequest) => Promise<Page<ArtistSummary>>
  searchAlbums: (query: string, page: PageRequest) => Promise<Page<AlbumSummary>>
  getArtist: (artistId: string, page: PageRequest) => Promise<ArtistDetail>
  getAlbum: (albumId: string, page: PageRequest) => Promise<AlbumDetail>
  getLikedTracks: (page: PageRequest) => Promise<Page<TrackSummary>>
  getTrackLikeStatus: (trackId: string) => Promise<{ liked: boolean }>
  setTrackLiked: (trackId: string, liked: boolean) => Promise<{ liked: boolean }>
  matchLibraryTrack: (track: TrackSummary) => Promise<PublicTrackMatchResult>
  aggregateSearch: (query: string, page: PageRequest) => Promise<PublicAggregatedSearchResult>
  seek: (positionMs: number) => Promise<{ positionMs: number }>
  getUserPlaylists: () => Promise<readonly PlaylistSummary[]>
  getPlaylist: (playlistId: string, page: PageRequest) => Promise<PlaylistDetail>
  getDailyRecommendations: () => Promise<DailyRecommendationsSnapshot>
  listFavorites: (kind: FavoriteKind | undefined, page: PageRequest) => Promise<FavoritePage>
  checkFavorite: (descriptor: FavoriteEntityDescriptor) => Promise<{ favorite: boolean }>
  setFavorite: (descriptor: FavoriteEntityDescriptor, favorite: boolean) => Promise<{ favorite: boolean; item?: FavoriteRecord }>
  listZones: () => Promise<{ zones: readonly PublicRoonZone[] }>
  selectZone: (zoneId: string) => Promise<PublicBridgeState>
  listRoonAlbums: (page: PageRequest) => Promise<RoonLibraryPage>
  listRoonArtists: (page: PageRequest) => Promise<RoonLibraryPage>
  listRoonGenres: (page: PageRequest) => Promise<RoonLibraryPage>
  listRoonPlaylists: (page: PageRequest) => Promise<RoonLibraryPage>
  getRoonAlbumTracks: (reference: string, page: PageRequest) => Promise<RoonLibraryPage>
  getRoonArtistAlbums: (reference: string, page: PageRequest) => Promise<RoonLibraryPage>
  getRoonGenreItems: (reference: string, page: PageRequest) => Promise<RoonLibraryPage>
  getRoonPlaylistTracks: (reference: string, page: PageRequest) => Promise<RoonLibraryPage>
  searchRoonLibrary: (query: string, page: PageRequest) => Promise<RoonLibraryPage>
  getRoonImage: (reference: string, options?: RoonImageOptions) => Promise<RoonImageResult>
  playRoonTrack: (reference: string, zoneId: string) => Promise<{ started: true }>
  queueRoonTrack: (reference: string, zoneId: string) => Promise<{ queued: true }>
  stopRoonTransport: () => Promise<{ stopped: true }>
  getLyrics: (trackId: string) => Promise<LyricsSnapshot>
  getLocalLyricsMatch: () => Promise<LocalLyricsMatchSnapshot>
  selectLocalLyricsMatch: (matchSessionId: string, candidateId: string) => Promise<LocalLyricsMatchSnapshot>
  revokeLocalLyricsMatch: () => Promise<LocalLyricsMatchSnapshot>
  getPlaybackState: () => Promise<PlaybackSnapshot>
  play: (
    trackId: string,
    quality: PlaybackQualityPreference,
    rendererClickAtMs?: number,
  ) => Promise<PlaybackSnapshot>
  pause: () => Promise<PlaybackSnapshot>
  resume: () => Promise<PlaybackSnapshot>
  stop: () => Promise<PlaybackSnapshot>
  next: () => Promise<PlaybackSnapshot>
  previous: () => Promise<PlaybackSnapshot>
  playQueueIndex: (index: number) => Promise<PlaybackSnapshot>
  replaceQueue: (items: readonly PlaybackQueueRequestItem[], index: number) => Promise<PlaybackSnapshot>
  appendQueue: (items: readonly PlaybackQueueRequestItem[]) => Promise<PlaybackSnapshot>
  insertNext: (items: readonly PlaybackQueueRequestItem[]) => Promise<PlaybackSnapshot>
  onCoreEvent: (listener: (event: TypedIpcEvent) => void) => () => void
  onAppCommand: (listener: (command: AppCommand) => void) => () => void
  getRemoteCoreState: () => Promise<RemoteCoreTunnelState>
  startRemoteCore: () => Promise<RemoteCoreTunnelState>
  stopRemoteCore: () => Promise<RemoteCoreTunnelState>
  reconnectRemoteCore: () => Promise<RemoteCoreTunnelState>
  onRemoteCoreEvent: (listener: (state: RemoteCoreTunnelState) => void) => () => void
}

export const PUBLIC_API_KEYS = [
  'listRecordingRecords',
  'getRecordingRecord',
  'getRecordingRecordVisual',
  'getPhysicalRecordingHistory',
  'previewPhysicalRecordingDisposition',
  'applyPhysicalRecordingDisposition',
  'listRecordingAttempts',
  'getRecordingAttempt',
  'beginRecordingAttempt',
  'confirmRecordingAttempt',
  'beginRecordingAttemptSide',
  'stopRecordingAttempt',
  'getRecordingOutputStatus',
  'checkRecordingOutput',
  'cancelRecordingOutputCheck',
  'listRecordingPlans',
  'getRecordingPlanVersion',
  'previewRecordingPlan',
  'freezeRecordingPlan',
  'preflightRecordingPlan',
  'cancelRecordingPlanRead',
  'getCommandOutbox',
  'retryCommandOutbox',
  'dismissCommandOutbox',
  'acknowledgeCommandOutbox',
  'activateRestoredDataset',
  'getBackupOverview',
  'chooseBackupRoot',
  'startBackupJob',
  'cancelBackupJob',
  'revokeBackupRoot',
  'listArchiveRoots',
  'chooseArchiveRoot',
  'initializeArchiveRoot',
  'revokeArchiveRoot',
  'previewArchive',
  'startArchive',
  'listArchives',
  'getArchiveOperation',
  'cancelArchive',
  'resumeArchive',
  'verifyArchive',
  'cancelArchiveRead',
  'listRecordingProfiles',
  'getRecordingProfileHistory',
  'getRecordingProfileVersion',
  'saveRecordingProfile',
  'getRecordingSession',
  'saveRecordingSession',
  'listExecutionAssets',
  'previewExecutionAsset',
  'startExecutionAsset',
  'getExecutionJob',
  'cancelExecutionJob',
  'cancelExecutionRead',
  'verifyExecutionAsset',
  'chooseSpreadsheetWorkbook',
  'listSpreadsheetSources',
  'getSpreadsheetSource',
  'getSpreadsheetSourceRows',
  'previewSpreadsheetImport',
  'applySpreadsheetImport',
  'getSpreadsheetImportRevision',
  'listSpreadsheetImportHistory',
  'previewSpreadsheetAdjustment',
  'adjustSpreadsheetInventory',
  'listSpreadsheetAdjustments',
  'registerReferenceSource',
  'listReferenceSources',
  'getReferenceSource',
  'previewCatalogRevision',
  'publishCatalogRevision',
  'getCatalogRevision',
  'setCatalogMatch',
  'getCatalogSnapshot',
  'getCatalogHistory',
  'listWantEntries',
  'saveWantEntry',
  'cancelWantEntry',
  'getWantEntryHistory',
  'getCollectionProgress',
  'captureCollectionProgress',
  'listCollectionProgressSnapshots',
  'getCollectionProgressSnapshot',
  'getCollectionModelLengths',
  'listPrepared',
  'listPreparedSelections',
  'choosePreparedRender',
  'revokePreparedSelection',
    'revokePreparedSelections',
  'previewPreparedImport',
  'startPreparedImport',
  'getPreparedImportJob',
  'cancelPreparedImport',
  'reviewPrepared',
  'freezePrepared',
  'listPreparationDestinations',
  'choosePreparationDestination',
  'revokePreparationDestination',
  'listPreparations',
  'previewPreparation',
  'startPreparation',
  'getPreparationJob',
  'cancelPreparationJob',
  'openPreparationWorkspace',

  'listMasterVersions',
  'previewMasterVersions',
  'freezeMasterVersions',
  'getMasterVersionJob',
  'cancelMasterVersionJob',
  'listMediaPlans',
  'getMediaPlan',
  'previewMediaPlan',
  'balanceMediaPlan',
  'saveMediaPlan',
  'reserveMediaPlan',
  'releaseMediaPlan',
  'listRecordingSourceRoots',
  'chooseRecordingSourceRoot',
  'revokeRecordingSourceRoot',
  'chooseRecordingSource',
  'getDraftSources',
  'getRecordingSourceJob',
  'cancelRecordingSourceJob',
  'recheckRecordingSource',
  'confirmRecordingSource',
  'listMasterDrafts',
  'getMasterDraft',
  'appendMasterDraft',
  'updateMasterDraft',
  'getMasterDraftTrackRuntime',

  'searchPhysicalRoonAlbums',
  'listDigitalAlbums',
  'getDigitalAlbum',
  'getPhysicalLinks',
  'getDigitalRuntime',
  'confirmPhysicalLink',
  'relocateDigitalAlbum',
  'registerDigitalAlbum',
  'removePhysicalLink',
  'confirmPhysicalAbsence',
  'getCollectionMatrix',
  'listPhysicalMusic',
  'getPhysicalMusic',
  'savePhysicalRelease',
  'saveLegacyRecording',
  'addPhysicalMusicPhoto',
  'getPhysicalMusicPhoto',
  'removePhysicalMusicPhoto',
  'pickCollectionPhoto',
  'addCollectionPhoto',
  'getCollectionPhoto',
  'changeCollectionPhoto',
  'listCollection',
  'getCollectionModel',
  'receiveCollectionStock',
  'materializeCollectionCopy',
  'updateCollectionCopy',
  'setCollectionPolicy',
  'getAppInfo',
  'getCoreHealth',
  'getCoreState',
  'pingCore',
  'exportDiagnostics',
  'getAuthState',
  'beginQrLogin',
  'pollQrLogin',
  'cancelQrLogin',
  'logout',
  'getAccountState',
  'refreshAccountProfile',
  'searchTracks',
  'searchArtists',
  'searchAlbums',
  'getArtist',
  'getAlbum',
  'getLikedTracks',
  'getTrackLikeStatus',
  'setTrackLiked',
  'matchLibraryTrack',
  'aggregateSearch',
  'seek',
  'getUserPlaylists',
  'getPlaylist',
  'getDailyRecommendations',
  'listFavorites',
  'checkFavorite',
  'setFavorite',
  'listZones',
  'selectZone',
  'listRoonAlbums',
  'listRoonArtists',
  'listRoonGenres',
  'listRoonPlaylists',
  'getRoonAlbumTracks',
  'getRoonArtistAlbums',
  'getRoonGenreItems',
  'getRoonPlaylistTracks',
  'searchRoonLibrary',
  'getRoonImage',
  'playRoonTrack',
  'queueRoonTrack',
  'stopRoonTransport',
  'getLyrics',
  'getLocalLyricsMatch',
  'selectLocalLyricsMatch',
  'revokeLocalLyricsMatch',
  'getPlaybackState',
  'play',
  'pause',
  'resume',
  'stop',
  'next',
  'previous',
  'playQueueIndex',
  'replaceQueue',
  'appendQueue',
  'insertNext',
  'onCoreEvent',
  'onAppCommand',
  'getRemoteCoreState',
  'startRemoteCore',
  'stopRemoteCore',
  'reconnectRemoteCore',
  'onRemoteCoreEvent',
] as const

export function createPreloadApi(
  getAppInfo: () => Promise<AppInfo>,
  getCoreHealth: () => Promise<PublicBridgeState>,
  getCoreState: () => Promise<PublicBridgeState>,
  pingCore: () => Promise<{ pong: true }>,
  exportDiagnostics: () => Promise<{ exported: boolean }>,
  getAuthState: () => Promise<PublicAuthState>,
  beginQrLogin: () => Promise<PublicAuthState>,
  pollQrLogin: (challengeId: string) => Promise<PublicAuthState>,
  cancelQrLogin: (challengeId: string) => Promise<PublicAuthState>,
  logout: () => Promise<PublicAuthState>,
  getAccountState: () => Promise<PublicAccountState>,
  refreshAccountProfile: () => Promise<PublicAccountState>,
  searchTracks: (query: string, page: PageRequest) => Promise<Page<TrackSummary>>,
  getLikedTracks: (page: PageRequest) => Promise<Page<TrackSummary>>,
  getUserPlaylists: () => Promise<readonly PlaylistSummary[]>,
  getPlaylist: (playlistId: string, page: PageRequest) => Promise<PlaylistDetail>,
  getDailyRecommendations: () => Promise<DailyRecommendationsSnapshot>,
  listZones: () => Promise<{ zones: readonly PublicRoonZone[] }>,
  selectZone: (zoneId: string) => Promise<PublicBridgeState>,
  getLyrics: (trackId: string) => Promise<LyricsSnapshot>,
  getPlaybackState: () => Promise<PlaybackSnapshot>,
  play: (
    trackId: string,
    quality: PlaybackQualityPreference,
    rendererClickAtMs?: number,
  ) => Promise<PlaybackSnapshot>,
  pause: () => Promise<PlaybackSnapshot>,
  resume: () => Promise<PlaybackSnapshot>,
  stop: () => Promise<PlaybackSnapshot>,
  next: () => Promise<PlaybackSnapshot>,
  previous: () => Promise<PlaybackSnapshot>,
  replaceQueue: (items: readonly PlaybackQueueRequestItem[], index: number) => Promise<PlaybackSnapshot>,
  appendQueue: (items: readonly PlaybackQueueRequestItem[]) => Promise<PlaybackSnapshot>,
  insertNext: (items: readonly PlaybackQueueRequestItem[]) => Promise<PlaybackSnapshot>,
  onCoreEvent: (listener: (event: TypedIpcEvent) => void) => () => void,
  onAppCommand: (listener: (command: AppCommand) => void) => () => void,
  getRemoteCoreState: () => Promise<RemoteCoreTunnelState> = async () => DEFAULT_REMOTE_CORE_STATE,
  startRemoteCore: () => Promise<RemoteCoreTunnelState> = async () => DEFAULT_REMOTE_CORE_STATE,
  stopRemoteCore: () => Promise<RemoteCoreTunnelState> = async () => DEFAULT_REMOTE_CORE_STATE,
  reconnectRemoteCore: () => Promise<RemoteCoreTunnelState> = async () => DEFAULT_REMOTE_CORE_STATE,
  onRemoteCoreEvent: (
    _listener: (state: RemoteCoreTunnelState) => void,
  ) => (() => void) = () => () => undefined,
  searchArtists: (_query: string, page: PageRequest) => Promise<Page<ArtistSummary>> = async (_query, page) => ({
    items: [],
    offset: page.offset,
    limit: page.limit,
    total: 0,
    hasMore: false,
  } satisfies Page<ArtistSummary>),
  searchAlbums: (_query: string, page: PageRequest) => Promise<Page<AlbumSummary>> = async (_query, page) => ({
    items: [],
    offset: page.offset,
    limit: page.limit,
    total: 0,
    hasMore: false,
  } satisfies Page<AlbumSummary>),
  getArtist: (_artistId: string, page: PageRequest) => Promise<ArtistDetail> = async (_artistId, page) => ({
    id: '1',
    name: '未知艺人',
    tracks: { items: [], offset: page.offset, limit: page.limit, total: 0, hasMore: false },
  }),
  getAlbum: (_albumId: string, page: PageRequest) => Promise<AlbumDetail> = async (_albumId, page) => ({
    id: '1',
    name: '未知专辑',
    artistName: '未知艺人',
    tracks: { items: [], offset: page.offset, limit: page.limit, total: 0, hasMore: false },
  }),
  listRoonAlbums: (_page: PageRequest) => Promise<RoonLibraryPage> = async () => {
    throw new Error('Roon Library API is unavailable')
  },
  listRoonArtists: (_page: PageRequest) => Promise<RoonLibraryPage> = async () => {
    throw new Error('Roon Library API is unavailable')
  },
  listRoonGenres: (_page: PageRequest) => Promise<RoonLibraryPage> = async () => {
    throw new Error('Roon Library API is unavailable')
  },
  listRoonPlaylists: (_page: PageRequest) => Promise<RoonLibraryPage> = async () => {
    throw new Error('Roon Library API is unavailable')
  },
  getRoonAlbumTracks: (_reference: string, _page: PageRequest) => Promise<RoonLibraryPage> = async () => {
    throw new Error('Roon Library API is unavailable')
  },
  getRoonArtistAlbums: (_reference: string, _page: PageRequest) => Promise<RoonLibraryPage> = async () => {
    throw new Error('Roon Library API is unavailable')
  },
  getRoonGenreItems: (_reference: string, _page: PageRequest) => Promise<RoonLibraryPage> = async () => {
    throw new Error('Roon Library API is unavailable')
  },
  getRoonPlaylistTracks: (_reference: string, _page: PageRequest) => Promise<RoonLibraryPage> = async () => {
    throw new Error('Roon Library API is unavailable')
  },
  searchRoonLibrary: (_query: string, _page: PageRequest) => Promise<RoonLibraryPage> = async () => {
    throw new Error('Roon Library API is unavailable')
  },
  getRoonImage: (_reference: string, _options?: RoonImageOptions) => Promise<RoonImageResult> = async () => {
    throw new Error('Roon Library API is unavailable')
  },
  playRoonTrack: (_reference: string, _zoneId: string) => Promise<{ started: true }> = async () => {
    throw new Error('Roon Library API is unavailable')
  },
  queueRoonTrack: (_reference: string, _zoneId: string) => Promise<{ queued: true }> = async () => {
    throw new Error('Roon Library API is unavailable')
  },
  listFavorites: (_kind: FavoriteKind | undefined, _page: PageRequest) => Promise<FavoritePage> = async () => {
    throw new Error('Local favorites API is unavailable')
  },
  checkFavorite: (_descriptor: FavoriteEntityDescriptor) => Promise<{ favorite: boolean }> = async () => {
    throw new Error('Local favorites API is unavailable')
  },
  setFavorite: (_descriptor: FavoriteEntityDescriptor, _favorite: boolean) => Promise<{ favorite: boolean; item?: FavoriteRecord }> = async () => {
    throw new Error('Local favorites API is unavailable')
  },
  getTrackLikeStatus: (_trackId: string) => Promise<{ liked: boolean }> = async () => {
    throw new Error('NetEase like API is unavailable')
  },
  setTrackLiked: (_trackId: string, _liked: boolean) => Promise<{ liked: boolean }> = async () => {
    throw new Error('NetEase like API is unavailable')
  },
  matchLibraryTrack: (_track: TrackSummary) => Promise<PublicTrackMatchResult> = async () => {
    throw new Error('Roon matching API is unavailable')
  },
  aggregateSearch: (_query: string, _page: PageRequest) => Promise<PublicAggregatedSearchResult> = async () => {
    throw new Error('Aggregated search API is unavailable')
  },
  seek: (_positionMs: number) => Promise<{ positionMs: number }> = async () => {
    throw new Error('Roon Transport seek API is unavailable')
  },
  stopRoonTransport: () => Promise<{ stopped: true }> = async () => {
    throw new Error('Roon Transport stop API is unavailable')
  },
  playQueueIndex: (_index: number) => Promise<PlaybackSnapshot> = async () => {
    throw new Error('Queue index API is unavailable')
  },
  getLocalLyricsMatch: () => Promise<LocalLyricsMatchSnapshot> = async () => ({
    status: 'hidden', candidates: [], canRevoke: false,
  }),
  selectLocalLyricsMatch: (_matchSessionId: string, _candidateId: string) => Promise<LocalLyricsMatchSnapshot> = async () => {
    throw new Error('Local lyrics matching API is unavailable')
  },
  revokeLocalLyricsMatch: () => Promise<LocalLyricsMatchSnapshot> = async () => {
    throw new Error('Local lyrics matching API is unavailable')
  },
  collectionApi?: CollectionPublicApi,
  physicalMusicApi?: PhysicalMusicPublicApi,
  physicalLinksApi?: PhysicalLinksPublicApi,
  masterDraftsApi?: MasterDraftsPublicApi,
  recordingSourcesApi?: RecordingSourcesPublicApi,
  mediaPlanningApi?: MediaPlanningPublicApi,
  masterVersionsApi?: MasterVersionsPublicApi,
  preparationApi?: PreparationPublicApi,
  preparedApi?: PreparedPublicApi,
  recordingProfilesApi?: RecordingProfilesPublicApi,
  recordingExecutionApi?: RecordingExecutionPublicApi,
  recordingArchiveApi?: RecordingArchivePublicApi,
  recordingBackupsApi?: RecordingBackupsPublicApi,
  commandOutboxApi?: CommandOutboxPublicApi,
  referenceCatalogApi?: ReferenceCatalogPublicApi,
  spreadsheetImportApi?: SpreadsheetImportPublicApi,
  collectionProgressApi?: CollectionProgressPublicApi,
  recordingPlansApi?: RecordingPlansPublicApi,
  recordingOutputApi?: RecordingOutputPublicApi,
  recordingAttemptsApi?: RecordingAttemptsPublicApi,
  recordingRecordsApi?: RecordingRecordsPublicApi,
): MusicBridgePublicApi {
  const collectionUnavailable = async (): Promise<never> => { throw new Error('库存服务暂时不可用') }
  const outputUnavailable = async (): Promise<never> => { throw new Error('输出核验服务暂时不可用；未访问设备。') }
  return Object.freeze({
    ...(recordingRecordsApi ?? { listRecordingRecords: collectionUnavailable, getRecordingRecord: collectionUnavailable, getRecordingRecordVisual: collectionUnavailable, getPhysicalRecordingHistory: collectionUnavailable, previewPhysicalRecordingDisposition: collectionUnavailable, applyPhysicalRecordingDisposition: collectionUnavailable }),
    ...(recordingAttemptsApi ?? { listRecordingAttempts: collectionUnavailable, getRecordingAttempt: collectionUnavailable, beginRecordingAttempt: collectionUnavailable, confirmRecordingAttempt: collectionUnavailable, beginRecordingAttemptSide: collectionUnavailable, stopRecordingAttempt: collectionUnavailable }),
    ...(recordingOutputApi ?? { getRecordingOutputStatus: outputUnavailable, checkRecordingOutput: outputUnavailable, cancelRecordingOutputCheck: outputUnavailable }),
    ...(recordingPlansApi ?? { listRecordingPlans: collectionUnavailable, getRecordingPlanVersion: collectionUnavailable, previewRecordingPlan: collectionUnavailable, freezeRecordingPlan: collectionUnavailable, preflightRecordingPlan: collectionUnavailable, cancelRecordingPlanRead: collectionUnavailable }),
    ...(commandOutboxApi ?? { getCommandOutbox: collectionUnavailable, retryCommandOutbox: collectionUnavailable, dismissCommandOutbox: collectionUnavailable, acknowledgeCommandOutbox: collectionUnavailable }),
    ...(recordingBackupsApi ?? { activateRestoredDataset: collectionUnavailable, getBackupOverview: collectionUnavailable, chooseBackupRoot: collectionUnavailable, startBackupJob: collectionUnavailable, cancelBackupJob: collectionUnavailable, revokeBackupRoot: collectionUnavailable }),
    ...(recordingArchiveApi ?? { listArchiveRoots: collectionUnavailable, chooseArchiveRoot: collectionUnavailable, initializeArchiveRoot: collectionUnavailable, revokeArchiveRoot: collectionUnavailable, previewArchive: collectionUnavailable, startArchive: collectionUnavailable, listArchives: collectionUnavailable, getArchiveOperation: collectionUnavailable, cancelArchive: collectionUnavailable, resumeArchive: collectionUnavailable, verifyArchive: collectionUnavailable, cancelArchiveRead: collectionUnavailable }),
    ...(recordingProfilesApi ?? { listRecordingProfiles: collectionUnavailable, getRecordingProfileHistory: collectionUnavailable, getRecordingProfileVersion: collectionUnavailable, saveRecordingProfile: collectionUnavailable, getRecordingSession: collectionUnavailable, saveRecordingSession: collectionUnavailable }),
    ...(recordingExecutionApi ?? { listExecutionAssets: collectionUnavailable, previewExecutionAsset: collectionUnavailable, startExecutionAsset: collectionUnavailable, getExecutionJob: collectionUnavailable, cancelExecutionJob: collectionUnavailable, cancelExecutionRead: collectionUnavailable, verifyExecutionAsset: collectionUnavailable }),
    ...(spreadsheetImportApi ?? { chooseSpreadsheetWorkbook: collectionUnavailable, listSpreadsheetSources: collectionUnavailable, getSpreadsheetSource: collectionUnavailable, getSpreadsheetSourceRows: collectionUnavailable, previewSpreadsheetImport: collectionUnavailable, applySpreadsheetImport: collectionUnavailable, getSpreadsheetImportRevision: collectionUnavailable, listSpreadsheetImportHistory: collectionUnavailable, previewSpreadsheetAdjustment: collectionUnavailable, adjustSpreadsheetInventory: collectionUnavailable, listSpreadsheetAdjustments: collectionUnavailable }),
    ...(referenceCatalogApi ?? { registerReferenceSource: collectionUnavailable, listReferenceSources: collectionUnavailable, getReferenceSource: collectionUnavailable, previewCatalogRevision: collectionUnavailable, publishCatalogRevision: collectionUnavailable, getCatalogRevision: collectionUnavailable, setCatalogMatch: collectionUnavailable, getCatalogSnapshot: collectionUnavailable, getCatalogHistory: collectionUnavailable }),
    ...(collectionProgressApi ?? { listWantEntries: collectionUnavailable, saveWantEntry: collectionUnavailable, cancelWantEntry: collectionUnavailable, getWantEntryHistory: collectionUnavailable, getCollectionProgress: collectionUnavailable, captureCollectionProgress: collectionUnavailable, listCollectionProgressSnapshots: collectionUnavailable, getCollectionProgressSnapshot: collectionUnavailable, getCollectionModelLengths: collectionUnavailable }),
    ...(preparedApi ?? { listPrepared: collectionUnavailable, listPreparedSelections: collectionUnavailable, choosePreparedRender: collectionUnavailable, revokePreparedSelection: collectionUnavailable, revokePreparedSelections: collectionUnavailable, previewPreparedImport: collectionUnavailable, startPreparedImport: collectionUnavailable, getPreparedImportJob: collectionUnavailable, cancelPreparedImport: collectionUnavailable, reviewPrepared: collectionUnavailable, freezePrepared: collectionUnavailable }),
    ...(preparationApi ?? { listPreparationDestinations: collectionUnavailable, choosePreparationDestination: collectionUnavailable, revokePreparationDestination: collectionUnavailable, listPreparations: collectionUnavailable, previewPreparation: collectionUnavailable, startPreparation: collectionUnavailable, getPreparationJob: collectionUnavailable, cancelPreparationJob: collectionUnavailable, openPreparationWorkspace: collectionUnavailable }),
    ...(masterVersionsApi ?? { listMasterVersions: collectionUnavailable, previewMasterVersions: collectionUnavailable, freezeMasterVersions: collectionUnavailable, getMasterVersionJob: collectionUnavailable, cancelMasterVersionJob: collectionUnavailable }),
    ...(mediaPlanningApi ?? { listMediaPlans: collectionUnavailable, getMediaPlan: collectionUnavailable, previewMediaPlan: collectionUnavailable, balanceMediaPlan: collectionUnavailable, saveMediaPlan: collectionUnavailable, reserveMediaPlan: collectionUnavailable, releaseMediaPlan: collectionUnavailable }),
    ...(recordingSourcesApi ?? {
      listRecordingSourceRoots: collectionUnavailable,
      chooseRecordingSourceRoot: collectionUnavailable,
      revokeRecordingSourceRoot: collectionUnavailable,
      chooseRecordingSource: collectionUnavailable,
      getDraftSources: collectionUnavailable,
      getRecordingSourceJob: collectionUnavailable,
      cancelRecordingSourceJob: collectionUnavailable,
      recheckRecordingSource: collectionUnavailable,
      confirmRecordingSource: collectionUnavailable,
    }),
    ...(masterDraftsApi ?? {
      listMasterDrafts: collectionUnavailable,
      getMasterDraft: collectionUnavailable,
      appendMasterDraft: collectionUnavailable,
      updateMasterDraft: collectionUnavailable,
      getMasterDraftTrackRuntime: collectionUnavailable,
    }),
    ...(physicalLinksApi ?? {
      searchPhysicalRoonAlbums: collectionUnavailable,
      listDigitalAlbums: collectionUnavailable,
      getDigitalAlbum: collectionUnavailable,
      getPhysicalLinks: collectionUnavailable,
      getDigitalRuntime: collectionUnavailable,
      confirmPhysicalLink: collectionUnavailable,
      relocateDigitalAlbum: collectionUnavailable,
      registerDigitalAlbum: collectionUnavailable,
      removePhysicalLink: collectionUnavailable,
      confirmPhysicalAbsence: collectionUnavailable,
      getCollectionMatrix: collectionUnavailable,
    }),
    ...(physicalMusicApi ?? {
      listPhysicalMusic: collectionUnavailable,
      getPhysicalMusic: collectionUnavailable,
      savePhysicalRelease: collectionUnavailable,
      saveLegacyRecording: collectionUnavailable,
      addPhysicalMusicPhoto: collectionUnavailable,
      getPhysicalMusicPhoto: collectionUnavailable,
      removePhysicalMusicPhoto: collectionUnavailable,
    }),
    ...(collectionApi ?? {
      pickCollectionPhoto: collectionUnavailable, addCollectionPhoto: collectionUnavailable,
      getCollectionPhoto: collectionUnavailable, changeCollectionPhoto: collectionUnavailable,
      listCollection: collectionUnavailable, getCollectionModel: collectionUnavailable,
      receiveCollectionStock: collectionUnavailable, materializeCollectionCopy: collectionUnavailable,
      updateCollectionCopy: collectionUnavailable, setCollectionPolicy: collectionUnavailable,
    }),
    getAppInfo,
    getCoreHealth,
    getCoreState,
    pingCore,
    exportDiagnostics,
    getAuthState,
    beginQrLogin,
    pollQrLogin,
    cancelQrLogin,
    logout,
    getAccountState,
    refreshAccountProfile,
    searchTracks,
    searchArtists,
    searchAlbums,
    getArtist,
    getAlbum,
    getLikedTracks,
    getTrackLikeStatus,
    setTrackLiked,
    matchLibraryTrack,
    aggregateSearch,
    seek,
    getUserPlaylists,
    getPlaylist,
    getDailyRecommendations,
    listFavorites,
    checkFavorite,
    setFavorite,
    listZones,
    selectZone,
    listRoonAlbums,
    listRoonArtists,
    listRoonGenres,
    listRoonPlaylists,
    getRoonAlbumTracks,
    getRoonArtistAlbums,
    getRoonGenreItems,
    getRoonPlaylistTracks,
    searchRoonLibrary,
    getRoonImage,
    playRoonTrack,
    queueRoonTrack,
    stopRoonTransport,
    getLyrics,
    getLocalLyricsMatch,
    selectLocalLyricsMatch,
    revokeLocalLyricsMatch,
    getPlaybackState,
    play,
    pause,
    resume,
    stop,
    next,
    previous,
    playQueueIndex,
    replaceQueue,
    appendQueue,
    insertNext,
    onCoreEvent,
    onAppCommand,
    getRemoteCoreState,
    startRemoteCore,
    stopRemoteCore,
    reconnectRemoteCore,
    onRemoteCoreEvent,
  })
}
