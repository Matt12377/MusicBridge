import type { SpreadsheetPageRequest, SpreadsheetSourcePage, SpreadsheetIdRequest, SpreadsheetWorkbookSource, SpreadsheetSourceRowsRequest, SpreadsheetSourceRowsPage, PreviewSpreadsheetImportRequest, SpreadsheetImportPreview, ApplySpreadsheetImportRequest, SpreadsheetImportResult, SpreadsheetImportRevisionRequest, SpreadsheetImportRevisionDetail, SpreadsheetImportHistory, SpreadsheetAdjustmentPreviewRequest, SpreadsheetAdjustmentBalance, AdjustSpreadsheetInventoryRequest, SpreadsheetInventoryAdjustment, SpreadsheetAdjustmentsRequest, SpreadsheetAdjustmentsPage, RegisterSpreadsheetWorkbookRequest, ChooseSpreadsheetWorkbookRequest, SpreadsheetWorkbookReceipt } from './spreadsheet-import.js';
import type { ListWantEntriesRequest, WantEntriesPage, SaveWantEntryRequest, WantEntry, CancelWantEntryRequest, GetWantEntryHistoryRequest, WantEntryHistory, GetCollectionProgressRequest, CollectionProgress, CaptureCollectionProgressRequest, CollectionProgressSnapshotSummary, ListCollectionProgressSnapshotsRequest, CollectionProgressSnapshotsPage, GetCollectionProgressSnapshotRequest, CollectionProgressSnapshotDetail, GetCollectionModelLengthsRequest, CollectionModelLengths } from './collection-progress.js';
import type { CommandOutboxContext, CommandOutboxExecute, CommandOutboxResult } from './command-outbox.js';
import type { RegisterReferenceSourceRequest, ReferenceSourceVersion, ReferenceSourceListRequest, ReferenceSourcePage, CatalogIdRequest, ReferenceSourceDetail, PreviewCatalogRevisionRequest, CatalogRevisionPreview, PublishCatalogRevisionRequest, CatalogRevisionDetail, SetCatalogMatchRequest, CatalogSnapshot, CatalogHistoryRequest, CatalogHistory } from './reference-catalog.js';
import type { ActivateRestoredDataset, RestoreActivationView } from './recording-activation.js';
import type { BackupOverview, BackupRootView, AuthorizeBackupRoot, StartBackupJob, BackupJobView } from './recording-backups.js';
import type { ArchiveRootView, InitializeArchiveRequest, ArchiveProposal, StartArchiveRequest, PreviewArchiveRequest, ArchiveOperationView, ArchiveHistory, ArchiveCheck, VerifyArchiveRequest } from './recording-archive.js';
import type { RecordingProfileVersion, RecordingProfileHistory, RecordingSessionSettings, SaveRecordingProfileRequest, SaveRecordingSessionRequest } from './recording-profile.js';
import type { ExecutionHistory, ExecutionProposal, ExecutionJob, ExecutionAssetCheck, PreviewExecutionRequest, StartExecutionRequest, VerifyExecutionRequest } from './execution-assets.js';
import type { PreparedHistory, PreparedSelection, SelectPreparedRequest, PreviewPreparedImportRequest, StartPreparedImportRequest, PreparedImportJob, PreparedImportProposal, ReviewPreparedRequest, FreezePreparedRequest, PreparedReview, FrozenPrepared } from './prepared-render.js';
import type { PreviewVersionsRequest, FreezeVersionsRequest, VersionProposal, VersionHistory, VersionJob } from './master-versions.js';
import type { PreviewPreparationRequest, StartPreparationRequest, PreparationHistory, PreparationProposal, PreparationJob, PreparationDestination } from './preparation.js';
import type { MediaPlan, MediaPreview, MediaLayoutSpec, PreviewMediaRequest, SaveMediaPlanRequest, ReserveMediaRequest, ReleaseMediaRequest } from './media-planning.js';
import type { SourceRoot, SourceJob, SourceBinding, SourceSelection, SourceAction, SourceConfirmation, DraftSourceSnapshot } from './source-evidence.js';
import type { MasterDraft, MasterDraftSummary, AppendMasterDraftRequest, UpdateMasterDraftRequest, MasterDraftResult } from './master-drafts.js';
import type { DigitalAlbum, DigitalAlbumDetail, PhysicalLinksSnapshot, DigitalRuntime, ConfirmPhysicalLinkRequest, RelocateDigitalRequest, RegisterDigitalRequest, RemovePhysicalLinkRequest, ConfirmAbsenceRequest, PhysicalLinkResult, CollectionMatrixRow } from './physical-links.js';
import type { MusicFilter, MusicEntry, MusicDetail, SaveReleaseRequest, SaveLegacyRequest, MusicMutationResult, AddMusicPhotoRequest, RemoveMusicPhotoRequest } from './physical-music.js';
import type { PublicError } from './errors.js';
import type { CollectionFilter, CollectionPhotoImage, CollectionAddPhotoRequest, CollectionChangePhotoRequest, CollectionModel, CollectionDetail, CollectionReceiveRequest, CollectionMaterializeRequest, CollectionUpdateCopyRequest, CollectionPolicyRequest, CollectionMutationResult } from './collection.js';
import type {
  DailyRecommendationsSnapshot,
  ArtistDetail,
  ArtistSummary,
  AlbumDetail,
  AlbumSummary,
  Page,
  PageRequest,
  PlaylistDetail,
  PlaylistSummary,
  TrackSummary,
} from './library.js';
import type {
  RoonImageOptions,
  RoonImageResult,
  RoonLibraryPage,
} from './roon.js';
import type { LocalLyricsMatchSnapshot, LyricsSnapshot } from './lyrics.js';
import type {
  PlaybackQueueRequestItem,
  PlaybackQueueSnapshot,
  PlaybackQualityPreference,
  PlaybackSnapshot,
} from './playback.js';
import type {
  PublicAccountState,
  PublicAuthState,
  PublicBridgeState,
  PublicRoonZone,
} from './state.js';
import type { DiagnosticComponentSnapshot } from './diagnostics.js';
import type {
  FavoriteEntityDescriptor,
  FavoriteKind,
  FavoritePage,
  FavoriteRecord,
} from './favorites.js';
import type { PublicTrackMatchResult } from './matching.js';
import type { PublicAggregatedSearchResult } from './aggregated-search.js';

export const IPC_VERSION = 1 as const;

export const IPC_COMMANDS = [
  'spreadsheetImports.sources',
  'spreadsheetImports.source',
  'spreadsheetImports.sourceRows',
  'spreadsheetImports.preview',
  'spreadsheetImports.apply',
  'spreadsheetImports.revision',
  'spreadsheetImports.history',
  'spreadsheetImports.adjustmentPreview',
  'spreadsheetImports.adjust',
  'spreadsheetImports.adjustments',
  'spreadsheetImports.registerWorkbook',
  'spreadsheetImports.workbookReceipt',
  'collectionProgress.wants',
  'collectionProgress.saveWant',
  'collectionProgress.cancelWant',
  'collectionProgress.wantHistory',
  'collectionProgress.current',
  'collectionProgress.capture',
  'collectionProgress.snapshots',
  'collectionProgress.snapshot',
  'collectionProgress.modelLengths',
  'referenceCatalog.registerSource',
  'referenceCatalog.sources',
  'referenceCatalog.source',
  'referenceCatalog.previewRevision',
  'referenceCatalog.publishRevision',
  'referenceCatalog.revision',
  'referenceCatalog.setMatch',
  'referenceCatalog.snapshot',
  'referenceCatalog.history',
  'commandOutbox.context',
  'commandOutbox.execute',
  'core.ping',
  'core.getHealth',
  'core.getState',
  'core.getDiagnostics',
  'core.shutdown',
  'auth.setCredential',
  'auth.verifyCredential',
  'auth.clearCredential',
  'auth.beginQr',
  'auth.pollQr',
  'auth.cancelQr',
  'auth.getState',
  'auth.logout',
  'account.getState',
  'account.refresh',
  'library.search',
  'library.searchArtists',
  'library.searchAlbums',
  'library.artist',
  'library.album',
  'library.liked',
  'library.likeStatus',
  'library.like',
  'library.match',
  'library.aggregateSearch',
  'library.playlists',
  'library.playlist',
  'library.dailyRecommendations',
  'favorites.list',
  'recordingBackups.overview',
  'recordingBackups.activate',
  'recordingBackups.activationReceipt',
  'recordingBackups.authorize',
  'recordingBackups.authorizationReceipt',
  'recordingBackups.start',
  'recordingBackups.cancel',
  'recordingBackups.revoke',
  'recordingArchive.roots',
  'recordingArchive.initialize',
  'recordingArchive.revokeRoot',
  'recordingArchive.preview',
  'recordingArchive.start',
  'recordingArchive.list',
  'recordingArchive.operation',
  'recordingArchive.cancel',
  'recordingArchive.resume',
  'recordingArchive.verify',
  'recordingArchive.cancelRead',
  'recordingArchive.authorize',
  'recordingArchive.authorizationReceipt',
  'recordingProfiles.list',
  'recordingProfiles.history',
  'recordingProfiles.version',
  'recordingProfiles.save',
  'recordingProfiles.session',
  'recordingProfiles.saveSession',
  'recordingExecution.list',
  'recordingExecution.preview',
  'recordingExecution.start',
  'recordingExecution.job',
  'recordingExecution.cancel',
  'recordingExecution.cancelRead',
  'recordingExecution.verify',
  'recordingVersions.list',
  'recordingPrepared.list',
  'recordingPrepared.selections',
  'recordingPrepared.selectionReceipt',
  'recordingPrepared.select',
  'recordingPrepared.revoke',
  'recordingPrepared.previewImport',
  'recordingPrepared.startImport',
  'recordingPrepared.job',
  'recordingPrepared.cancel',
  'recordingPrepared.review',
  'recordingPrepared.freeze',
  'recordingPreparation.destinations',
  'recordingPreparation.authorizationReceipt',
  'recordingPreparation.authorize',
  'recordingPreparation.revoke',
  'recordingPreparation.job',
  'recordingPreparation.cancel',
  'recordingPreparation.context',
  'recordingPreparation.list',
  'recordingPreparation.preview',
  'recordingPreparation.start',
  'recordingVersions.preview',
  'recordingVersions.freeze',
  'recordingVersions.job',
  'recordingVersions.cancel',
  'recordingMedia.plans',
  'recordingMedia.detail',
  'recordingMedia.preview',
  'recordingMedia.balance',
  'recordingMedia.save',
  'recordingMedia.reserve',
  'recordingMedia.release',
  'recordingSources.roots',
  'recordingSources.rootReceipt',
  'recordingSources.authorize',
  'recordingSources.context',
  'recordingSources.start',
  'recordingSources.revoke',
  'recordingSources.snapshot',
  'recordingSources.job',
  'recordingSources.cancel',
  'recordingSources.confirm',
  'recordingSources.recheck',
  'recordingDrafts.list',
  'recordingDrafts.detail',
  'recordingDrafts.append',
  'recordingDrafts.update',
  'recordingDrafts.runtime',
  'physicalLinks.search',
  'physicalLinks.digitalList',
  'physicalLinks.digitalDetail',
  'physicalLinks.physical',
  'physicalLinks.runtime',
  'physicalLinks.confirm',
  'physicalLinks.relocate',
  'physicalLinks.register',
  'physicalLinks.remove',
  'physicalLinks.absence',
  'physicalLinks.matrix',
  'physicalMusic.list',
  'physicalMusic.detail',
  'physicalMusic.saveRelease',
  'physicalMusic.saveLegacy',
  'physicalMusic.addPhoto',
  'physicalMusic.photo',
  'physicalMusic.removePhoto',
  'collection.addPhoto',
  'collection.photo',
  'collection.changePhoto',
  'collection.list',
  'collection.detail',
  'collection.receive',
  'collection.materialize',
  'collection.updateCopy',
  'collection.setPolicy',
  'favorites.check',
  'favorites.set',
  'lyrics.get',
  'lyrics.match.get',
  'lyrics.match.select',
  'lyrics.match.revoke',
  'roon.listZones',
  'roon.selectZone',
  'roon.library.albums',
  'roon.library.artists',
  'roon.library.genres',
  'roon.library.playlists',
  'roon.library.album',
  'roon.library.artist',
  'roon.library.genre',
  'roon.library.playlist',
  'roon.library.search',
  'roon.library.image',
  'roon.library.play',
  'roon.library.queue',
  'roon.transport.stop',
  'playback.getState',
  'playback.play',
  'playback.pause',
  'playback.resume',
  'playback.seek',
  'playback.stop',
  'playback.next',
  'playback.previous',
  'playback.playQueueIndex',
  'playback.replaceQueue',
  'playback.appendQueue',
  'playback.insertNext',
] as const;

export type IpcCommand = (typeof IPC_COMMANDS)[number];

export const IPC_EVENTS = [
  'core.ready',
  'core.health',
  'auth.changed',
  'account.changed',
  'roon.changed',
  'diagnostic.notice',
  'playback.changed',
  'queue.changed',
  'lyrics.changed',
  'lyrics.match.changed',
] as const;

export type IpcEvent = (typeof IPC_EVENTS)[number];

export interface IpcRequest<TPayload = unknown> {
  expectedDatasetId?: string;
  version: typeof IPC_VERSION;
  id: string;
  command: IpcCommand;
  payload: TPayload;
}

export interface IpcSuccess<TResult = unknown> {
  version: typeof IPC_VERSION;
  id: string;
  ok: true;
  result: TResult;
}

export interface IpcFailure {
  version: typeof IPC_VERSION;
  id: string;
  ok: false;
  error: PublicError;
}

export type IpcResponse<TResult = unknown> =
  | IpcSuccess<TResult>
  | IpcFailure;

export type IpcEnvelope<T = unknown> = IpcRequest<T> | IpcResponse<T>;

export interface IpcCommandPayloads {
  'commandOutbox.context': Record<string, never>;
  'commandOutbox.execute': CommandOutboxExecute;
  'spreadsheetImports.sources': SpreadsheetPageRequest;
  'spreadsheetImports.source': SpreadsheetIdRequest;
  'spreadsheetImports.sourceRows': SpreadsheetSourceRowsRequest;
  'spreadsheetImports.preview': PreviewSpreadsheetImportRequest;
  'spreadsheetImports.apply': ApplySpreadsheetImportRequest;
  'spreadsheetImports.revision': SpreadsheetImportRevisionRequest;
  'spreadsheetImports.history': SpreadsheetPageRequest;
  'spreadsheetImports.adjustmentPreview': SpreadsheetAdjustmentPreviewRequest;
  'spreadsheetImports.adjust': AdjustSpreadsheetInventoryRequest;
  'spreadsheetImports.adjustments': SpreadsheetAdjustmentsRequest;
  'spreadsheetImports.registerWorkbook': RegisterSpreadsheetWorkbookRequest;
  'spreadsheetImports.workbookReceipt': ChooseSpreadsheetWorkbookRequest;
  'collectionProgress.wants': ListWantEntriesRequest;
  'collectionProgress.saveWant': SaveWantEntryRequest;
  'collectionProgress.cancelWant': CancelWantEntryRequest;
  'collectionProgress.wantHistory': GetWantEntryHistoryRequest;
  'collectionProgress.current': GetCollectionProgressRequest;
  'collectionProgress.capture': CaptureCollectionProgressRequest;
  'collectionProgress.snapshots': ListCollectionProgressSnapshotsRequest;
  'collectionProgress.snapshot': GetCollectionProgressSnapshotRequest;
  'collectionProgress.modelLengths': GetCollectionModelLengthsRequest;
  'referenceCatalog.registerSource': RegisterReferenceSourceRequest;
  'referenceCatalog.sources': ReferenceSourceListRequest;
  'referenceCatalog.source': CatalogIdRequest;
  'referenceCatalog.previewRevision': PreviewCatalogRevisionRequest;
  'referenceCatalog.publishRevision': PublishCatalogRevisionRequest;
  'referenceCatalog.revision': CatalogIdRequest;
  'referenceCatalog.setMatch': SetCatalogMatchRequest;
  'referenceCatalog.snapshot': CatalogIdRequest;
  'referenceCatalog.history': CatalogHistoryRequest;
  'recordingBackups.overview': Record<string, never>;
  'recordingBackups.activate': ActivateRestoredDataset;
  'recordingBackups.activationReceipt': ActivateRestoredDataset;
  'recordingBackups.authorize': AuthorizeBackupRoot & { absolutePath: string };
  'recordingBackups.authorizationReceipt': AuthorizeBackupRoot;
  'recordingBackups.start': StartBackupJob;
  'recordingBackups.cancel': { commandId: string; id: string };
  'recordingBackups.revoke': { commandId: string; id: string };
  'recordingArchive.roots': Record<string, never>;
  'recordingArchive.initialize': InitializeArchiveRequest;
  'recordingArchive.revokeRoot': { commandId: string; id: string };
  'recordingArchive.preview': PreviewArchiveRequest;
  'recordingArchive.start': StartArchiveRequest;
  'recordingArchive.list': { draftId: string };
  'recordingArchive.operation': { id: string };
  'recordingArchive.cancel': { commandId: string; id: string };
  'recordingArchive.resume': { commandId: string; id: string };
  'recordingArchive.verify': VerifyArchiveRequest;
  'recordingArchive.cancelRead': { id: string };
  'recordingArchive.authorize': { commandId: string; absolutePath: string };
  'recordingArchive.authorizationReceipt': { commandId: string };

  'recordingProfiles.list': {};
  'recordingProfiles.history': { profileId: string };
  'recordingProfiles.version': { versionId: string };
  'recordingProfiles.save': SaveRecordingProfileRequest;
  'recordingProfiles.session': { draftId: string };
  'recordingProfiles.saveSession': SaveRecordingSessionRequest;
  'recordingExecution.list': { draftId: string };
  'recordingExecution.preview': PreviewExecutionRequest;
  'recordingExecution.start': StartExecutionRequest;
  'recordingExecution.job': { id: string };
  'recordingExecution.cancel': { commandId: string; id: string };
  'recordingExecution.cancelRead': { id: string };
  'recordingExecution.verify': VerifyExecutionRequest;

  'recordingPreparation.destinations': {};
  'recordingPreparation.authorizationReceipt': { commandId: string };
  'recordingPreparation.authorize': { commandId: string; absolutePath: string };
  'recordingPreparation.revoke': { commandId: string; id: string };
  'recordingPreparation.job': { id: string };
  'recordingPreparation.cancel': { commandId: string; id: string };
  'recordingPreparation.context': { id: string };

  'recordingVersions.list': { draftId: string };
  'recordingPrepared.list': { draftId: string };
  'recordingPrepared.selections': { preparationId: string };
  'recordingPrepared.selectionReceipt': SelectPreparedRequest;
  'recordingPrepared.select': SelectPreparedRequest & { absolutePath: string };
  'recordingPrepared.revoke': { commandId: string; id: string };
  'recordingPrepared.previewImport': PreviewPreparedImportRequest;
  'recordingPrepared.startImport': StartPreparedImportRequest;
  'recordingPrepared.job': { id: string };
  'recordingPrepared.cancel': { commandId: string; id: string };
  'recordingPrepared.review': ReviewPreparedRequest;
  'recordingPrepared.freeze': FreezePreparedRequest;
  'recordingPreparation.list': { draftId: string };
  'recordingPreparation.preview': PreviewPreparationRequest;
  'recordingPreparation.start': StartPreparationRequest;
  'recordingVersions.preview': PreviewVersionsRequest;
  'recordingVersions.freeze': FreezeVersionsRequest;
  'recordingVersions.job': { id: string };
  'recordingVersions.cancel': { commandId: string; id: string };
  'recordingMedia.plans': { draftId: string };
  'recordingMedia.detail': { id: string };
  'recordingMedia.preview': PreviewMediaRequest;
  'recordingMedia.balance': { draftId: string; spec: MediaLayoutSpec };
  'recordingMedia.save': SaveMediaPlanRequest;
  'recordingMedia.reserve': ReserveMediaRequest;
  'recordingMedia.release': ReleaseMediaRequest;
  'recordingSources.roots': Record<string, never>;
  'recordingSources.rootReceipt': { commandId: string };
  'recordingSources.authorize': { commandId: string; absolutePath: string };
  'recordingSources.context': { id: string };
  'recordingSources.start': { selection: SourceSelection; absolutePath: string };
  'recordingSources.revoke': SourceAction;
  'recordingSources.snapshot': { draftId: string };
  'recordingSources.job': { id: string };
  'recordingSources.cancel': SourceAction;
  'recordingSources.confirm': SourceConfirmation;
  'recordingSources.recheck': SourceConfirmation;
  'recordingDrafts.list': { page: PageRequest };
  'recordingDrafts.detail': { id: string };
  'recordingDrafts.append': AppendMasterDraftRequest;
  'recordingDrafts.update': UpdateMasterDraftRequest;
  'recordingDrafts.runtime': { draftId: string; trackId: string };
  'core.ping': Record<string, never>;
  'core.getHealth': Record<string, never>;
  'core.getState': Record<string, never>;
  'core.getDiagnostics': Record<string, never>;
  'core.shutdown': Record<string, never>;
  'auth.setCredential': { credential: string };
  'auth.verifyCredential': { credential: string };
  'auth.clearCredential': Record<string, never>;
  'auth.beginQr': Record<string, never>;
  'auth.pollQr': { challengeId: string };
  'auth.cancelQr': { challengeId: string };
  'auth.getState': Record<string, never>;
  'auth.logout': Record<string, never>;
  'account.getState': Record<string, never>;
  'account.refresh': Record<string, never>;
  'library.search': { query: string; page: PageRequest };
  'library.searchArtists': { query: string; page: PageRequest };
  'library.searchAlbums': { query: string; page: PageRequest };
  'library.artist': { artistId: string; page: PageRequest };
  'library.album': { albumId: string; page: PageRequest };
  'library.liked': { page: PageRequest };
  'library.likeStatus': { trackId: string };
  'library.like': { trackId: string; liked: boolean };
  'library.match': { track: TrackSummary };
  'library.aggregateSearch': { query: string; page: PageRequest };
  'library.playlists': Record<string, never>;
  'library.playlist': { playlistId: string; page: PageRequest };
  'library.dailyRecommendations': Record<string, never>;
  'favorites.list': { kind?: FavoriteKind; page: PageRequest };
  'physicalLinks.search': { query: string; page: PageRequest };
  'physicalLinks.digitalList': { page: PageRequest };
  'physicalLinks.digitalDetail': { id: string };
  'physicalLinks.physical': { releaseId: string };
  'physicalLinks.runtime': { id: string };
  'physicalLinks.confirm': ConfirmPhysicalLinkRequest;
  'physicalLinks.relocate': RelocateDigitalRequest;
  'physicalLinks.register': RegisterDigitalRequest;
  'physicalLinks.remove': RemovePhysicalLinkRequest;
  'physicalLinks.absence': ConfirmAbsenceRequest;
  'physicalLinks.matrix': { page: PageRequest; query?: string };
  'physicalMusic.list': { page: PageRequest; filter?: MusicFilter };
  'physicalMusic.detail': { id: string };
  'physicalMusic.saveRelease': SaveReleaseRequest;
  'physicalMusic.saveLegacy': SaveLegacyRequest;
  'physicalMusic.addPhoto': AddMusicPhotoRequest;
  'physicalMusic.photo': { photoId: string };
  'physicalMusic.removePhoto': RemoveMusicPhotoRequest;
  'collection.list': { page: PageRequest; filter?: CollectionFilter };
  'collection.addPhoto': CollectionAddPhotoRequest;
  'collection.photo': { photoId: string };
  'collection.changePhoto': CollectionChangePhotoRequest;
  'collection.detail': { modelId: string; page: PageRequest };
  'collection.receive': CollectionReceiveRequest;
  'collection.materialize': CollectionMaterializeRequest;
  'collection.updateCopy': CollectionUpdateCopyRequest;
  'collection.setPolicy': CollectionPolicyRequest;
  'favorites.check': { descriptor: FavoriteEntityDescriptor };
  'favorites.set': { descriptor: FavoriteEntityDescriptor; favorite: boolean };
  'lyrics.get': { trackId: string };
  'lyrics.match.get': Record<string, never>;
  'lyrics.match.select': { matchSessionId: string; candidateId: string };
  'lyrics.match.revoke': Record<string, never>;
  'roon.listZones': Record<string, never>;
  'roon.selectZone': { zoneId: string };
  'roon.library.albums': { page: PageRequest };
  'roon.library.artists': { page: PageRequest };
  'roon.library.genres': { page: PageRequest };
  'roon.library.playlists': { page: PageRequest };
  'roon.library.album': { reference: string; page: PageRequest };
  'roon.library.artist': { reference: string; page: PageRequest };
  'roon.library.genre': { reference: string; page: PageRequest };
  'roon.library.playlist': { reference: string; page: PageRequest };
  'roon.library.search': { query: string; page: PageRequest };
  'roon.library.image': { reference: string; options?: RoonImageOptions };
  'roon.library.play': { reference: string; zoneId: string };
  'roon.library.queue': { reference: string; zoneId: string };
  'roon.transport.stop': Record<string, never>;
  'playback.getState': Record<string, never>;
  'playback.play': {
    trackId: string;
    qualityPreference: PlaybackQualityPreference;
    rendererClickAtMs?: number;
  };
  'playback.pause': Record<string, never>;
  'playback.resume': Record<string, never>;
  'playback.seek': { positionMs: number };
  'playback.stop': Record<string, never>;
  'playback.next': Record<string, never>;
  'playback.previous': Record<string, never>;
  'playback.playQueueIndex': { index: number };
  'playback.replaceQueue': { items: readonly PlaybackQueueRequestItem[]; index: number };
  'playback.appendQueue': { items: readonly PlaybackQueueRequestItem[] };
  'playback.insertNext': { items: readonly PlaybackQueueRequestItem[] };
}

export interface IpcCommandResults {
  'commandOutbox.context': CommandOutboxContext;
  'commandOutbox.execute': CommandOutboxResult;
  'spreadsheetImports.sources': SpreadsheetSourcePage;
  'spreadsheetImports.source': SpreadsheetWorkbookSource;
  'spreadsheetImports.sourceRows': SpreadsheetSourceRowsPage;
  'spreadsheetImports.preview': SpreadsheetImportPreview;
  'spreadsheetImports.apply': SpreadsheetImportResult;
  'spreadsheetImports.revision': SpreadsheetImportRevisionDetail;
  'spreadsheetImports.history': SpreadsheetImportHistory;
  'spreadsheetImports.adjustmentPreview': SpreadsheetAdjustmentBalance;
  'spreadsheetImports.adjust': SpreadsheetInventoryAdjustment;
  'spreadsheetImports.adjustments': SpreadsheetAdjustmentsPage;
  'spreadsheetImports.registerWorkbook': never;
  'spreadsheetImports.workbookReceipt': never;
  'collectionProgress.wants': WantEntriesPage;
  'collectionProgress.saveWant': WantEntry;
  'collectionProgress.cancelWant': WantEntry;
  'collectionProgress.wantHistory': WantEntryHistory;
  'collectionProgress.current': CollectionProgress;
  'collectionProgress.capture': CollectionProgressSnapshotSummary;
  'collectionProgress.snapshots': CollectionProgressSnapshotsPage;
  'collectionProgress.snapshot': CollectionProgressSnapshotDetail;
  'collectionProgress.modelLengths': CollectionModelLengths;
  'referenceCatalog.registerSource': ReferenceSourceVersion;
  'referenceCatalog.sources': ReferenceSourcePage;
  'referenceCatalog.source': ReferenceSourceDetail;
  'referenceCatalog.previewRevision': CatalogRevisionPreview;
  'referenceCatalog.publishRevision': CatalogRevisionDetail;
  'referenceCatalog.revision': CatalogRevisionDetail;
  'referenceCatalog.setMatch': CatalogRevisionDetail;
  'referenceCatalog.snapshot': CatalogSnapshot;
  'referenceCatalog.history': CatalogHistory;
  'recordingBackups.overview': BackupOverview;
  'recordingBackups.activate': RestoreActivationView;
  'recordingBackups.activationReceipt': { activation: RestoreActivationView | null };
  'recordingBackups.authorize': BackupRootView;
  'recordingBackups.authorizationReceipt': { root: BackupRootView | null };
  'recordingBackups.start': BackupJobView;
  'recordingBackups.cancel': BackupJobView;
  'recordingBackups.revoke': BackupRootView;
  'recordingArchive.roots': { roots: readonly ArchiveRootView[] };
  'recordingArchive.initialize': ArchiveRootView;
  'recordingArchive.revokeRoot': ArchiveRootView;
  'recordingArchive.preview': ArchiveProposal;
  'recordingArchive.start': ArchiveOperationView;
  'recordingArchive.list': ArchiveHistory;
  'recordingArchive.operation': { operation: ArchiveOperationView | null };
  'recordingArchive.cancel': ArchiveOperationView;
  'recordingArchive.resume': ArchiveOperationView;
  'recordingArchive.verify': ArchiveCheck;
  'recordingArchive.cancelRead': { cancelled: true };
  'recordingArchive.authorize': ArchiveRootView;
  'recordingArchive.authorizationReceipt': { root: ArchiveRootView | null };

  'recordingProfiles.list': { profiles: readonly RecordingProfileVersion[] };
  'recordingProfiles.history': RecordingProfileHistory;
  'recordingProfiles.version': RecordingProfileVersion;
  'recordingProfiles.save': RecordingProfileVersion;
  'recordingProfiles.session': { session: RecordingSessionSettings | null };
  'recordingProfiles.saveSession': RecordingSessionSettings;
  'recordingExecution.list': ExecutionHistory;
  'recordingExecution.preview': ExecutionProposal;
  'recordingExecution.start': ExecutionJob;
  'recordingExecution.job': { job: ExecutionJob | null };
  'recordingExecution.cancel': ExecutionJob;
  'recordingExecution.cancelRead': { cancelled: true };
  'recordingExecution.verify': ExecutionAssetCheck;

  'recordingPreparation.destinations': { destinations: readonly PreparationDestination[] };
  'recordingPreparation.authorizationReceipt': { destination: PreparationDestination | null };
  'recordingPreparation.authorize': PreparationDestination;
  'recordingPreparation.revoke': PreparationDestination;
  'recordingPreparation.job': { job: PreparationJob | null };
  'recordingPreparation.cancel': PreparationJob;
  'recordingPreparation.context': { absolutePath: string };

  'recordingPrepared.list': PreparedHistory;
  'recordingPrepared.selections': { selections: readonly PreparedSelection[] };
  'recordingPrepared.selectionReceipt': { selection: PreparedSelection | null };
  'recordingPrepared.select': PreparedSelection;
  'recordingPrepared.revoke': PreparedSelection;
  'recordingPrepared.previewImport': PreparedImportProposal;
  'recordingPrepared.startImport': PreparedImportJob;
  'recordingPrepared.job': { job: PreparedImportJob | null };
  'recordingPrepared.cancel': PreparedImportJob;
  'recordingPrepared.review': PreparedReview;
  'recordingPrepared.freeze': FrozenPrepared;
  'recordingPreparation.list': PreparationHistory;
  'recordingPreparation.preview': PreparationProposal;
  'recordingPreparation.start': PreparationJob;
  'recordingVersions.list': VersionHistory;
  'recordingVersions.preview': VersionProposal;
  'recordingVersions.freeze': VersionJob;
  'recordingVersions.job': { job: VersionJob | null };
  'recordingVersions.cancel': VersionJob;
  'recordingMedia.plans': { draftId: string; plans: readonly MediaPlan[] };
  'recordingMedia.detail': MediaPlan;
  'recordingMedia.preview': MediaPreview;
  'recordingMedia.balance': { splitAfter: number };
  'recordingMedia.save': MediaPlan;
  'recordingMedia.reserve': MediaPlan;
  'recordingMedia.release': MediaPlan;
  'recordingSources.roots': { roots: readonly SourceRoot[] };
  'recordingSources.rootReceipt': { root: SourceRoot | null };
  'recordingSources.authorize': SourceRoot;
  'recordingSources.context': { absolutePath: string };
  'recordingSources.start': SourceJob;
  'recordingSources.revoke': SourceRoot;
  'recordingSources.snapshot': DraftSourceSnapshot;
  'recordingSources.job': { job: SourceJob | null };
  'recordingSources.cancel': SourceJob;
  'recordingSources.confirm': SourceBinding;
  'recordingSources.recheck': SourceJob;
  'recordingDrafts.list': Page<MasterDraftSummary>;
  'recordingDrafts.detail': MasterDraft;
  'recordingDrafts.append': MasterDraftResult;
  'recordingDrafts.update': MasterDraftResult;
  'recordingDrafts.runtime': DigitalRuntime;
  'core.ping': { pong: true };
  'core.getHealth': PublicBridgeState;
  'core.getState': PublicBridgeState;
  'core.getDiagnostics': DiagnosticComponentSnapshot;
  'core.shutdown': { stopped: true };
  'auth.setCredential': PublicBridgeState;
  'auth.verifyCredential': { status: 'authorized' | 'expired' | 'unavailable' };
  'auth.clearCredential': PublicBridgeState;
  'auth.beginQr': PublicAuthState;
  'auth.pollQr': PublicAuthState;
  'auth.cancelQr': PublicAuthState;
  'auth.getState': PublicAuthState;
  'auth.logout': PublicAuthState;
  'account.getState': PublicAccountState;
  'account.refresh': PublicAccountState;
  'library.search': Page<TrackSummary>;
  'library.searchArtists': Page<ArtistSummary>;
  'library.searchAlbums': Page<AlbumSummary>;
  'library.artist': ArtistDetail;
  'library.album': AlbumDetail;
  'library.liked': Page<TrackSummary>;
  'library.likeStatus': { liked: boolean };
  'library.like': { liked: boolean };
  'library.match': PublicTrackMatchResult;
  'library.aggregateSearch': PublicAggregatedSearchResult;
  'library.playlists': readonly PlaylistSummary[];
  'library.playlist': PlaylistDetail;
  'library.dailyRecommendations': DailyRecommendationsSnapshot;
  'favorites.list': FavoritePage;
  'physicalLinks.search': RoonLibraryPage;
  'physicalLinks.digitalList': Page<DigitalAlbum>;
  'physicalLinks.digitalDetail': DigitalAlbumDetail;
  'physicalLinks.physical': PhysicalLinksSnapshot;
  'physicalLinks.runtime': DigitalRuntime;
  'physicalLinks.confirm': PhysicalLinkResult;
  'physicalLinks.relocate': PhysicalLinkResult;
  'physicalLinks.register': PhysicalLinkResult;
  'physicalLinks.remove': PhysicalLinkResult;
  'physicalLinks.absence': PhysicalLinkResult;
  'physicalLinks.matrix': Page<CollectionMatrixRow>;
  'physicalMusic.list': Page<MusicEntry>;
  'physicalMusic.detail': MusicDetail;
  'physicalMusic.saveRelease': MusicMutationResult;
  'physicalMusic.saveLegacy': MusicMutationResult;
  'physicalMusic.addPhoto': MusicMutationResult;
  'physicalMusic.photo': CollectionPhotoImage;
  'physicalMusic.removePhoto': MusicMutationResult;
  'collection.list': Page<CollectionModel>;
  'collection.addPhoto': CollectionMutationResult;
  'collection.photo': CollectionPhotoImage;
  'collection.changePhoto': CollectionMutationResult;
  'collection.detail': CollectionDetail;
  'collection.receive': CollectionMutationResult;
  'collection.materialize': CollectionMutationResult;
  'collection.updateCopy': CollectionMutationResult;
  'collection.setPolicy': CollectionMutationResult;
  'favorites.check': { favorite: boolean };
  'favorites.set': { favorite: boolean; item?: FavoriteRecord };
  'lyrics.get': LyricsSnapshot;
  'lyrics.match.get': LocalLyricsMatchSnapshot;
  'lyrics.match.select': LocalLyricsMatchSnapshot;
  'lyrics.match.revoke': LocalLyricsMatchSnapshot;
  'roon.listZones': { zones: readonly PublicRoonZone[] };
  'roon.selectZone': PublicBridgeState;
  'roon.library.albums': RoonLibraryPage;
  'roon.library.artists': RoonLibraryPage;
  'roon.library.genres': RoonLibraryPage;
  'roon.library.playlists': RoonLibraryPage;
  'roon.library.album': RoonLibraryPage;
  'roon.library.artist': RoonLibraryPage;
  'roon.library.genre': RoonLibraryPage;
  'roon.library.playlist': RoonLibraryPage;
  'roon.library.search': RoonLibraryPage;
  'roon.library.image': RoonImageResult;
  'roon.library.play': { started: true };
  'roon.library.queue': { queued: true };
  'roon.transport.stop': { stopped: true };
  'playback.getState': PlaybackSnapshot;
  'playback.play': PlaybackSnapshot;
  'playback.pause': PlaybackSnapshot;
  'playback.resume': PlaybackSnapshot;
  'playback.seek': { positionMs: number };
  'playback.stop': PlaybackSnapshot;
  'playback.next': PlaybackSnapshot;
  'playback.previous': PlaybackSnapshot;
  'playback.playQueueIndex': PlaybackSnapshot;
  'playback.replaceQueue': PlaybackSnapshot;
  'playback.appendQueue': PlaybackSnapshot;
  'playback.insertNext': PlaybackSnapshot;
}

export interface IpcEventPayloads {
  'core.ready': { state: PublicBridgeState };
  'core.health': { state: PublicBridgeState };
  'roon.changed': { state: PublicBridgeState };
  'auth.changed': { state: PublicAuthState };
  'account.changed': { state: PublicAccountState };
  'diagnostic.notice': { code: string; message?: string };
  'playback.changed': { state: PlaybackSnapshot };
  'queue.changed': { queue: PlaybackQueueSnapshot };
  'lyrics.changed': { state: LyricsSnapshot };
  'lyrics.match.changed': { state: LocalLyricsMatchSnapshot };
}

export type IpcInternalCommand = 'spreadsheetImports.registerWorkbook' | 'spreadsheetImports.workbookReceipt' | 'recordingBackups.activationReceipt' | 'recordingBackups.authorize' | 'recordingBackups.authorizationReceipt' | 'recordingArchive.authorize' | 'recordingArchive.authorizationReceipt' | 'recordingPrepared.select' | 'recordingPrepared.selectionReceipt' | 'recordingPreparation.authorizationReceipt' | 'recordingPreparation.authorize' | 'recordingPreparation.context' | 'auth.pollQr' | 'auth.verifyCredential' | 'recordingSources.rootReceipt' | 'recordingSources.authorize' | 'recordingSources.context' | 'recordingSources.start';

export interface IpcInternalCommandResults {
  'spreadsheetImports.registerWorkbook': SpreadsheetWorkbookSource;
  'spreadsheetImports.workbookReceipt': SpreadsheetWorkbookReceipt;
  'recordingBackups.activationReceipt': { activation: RestoreActivationView | null };
  'recordingBackups.authorize': BackupRootView;
  'recordingBackups.authorizationReceipt': { root: BackupRootView | null };
  'recordingArchive.authorize': ArchiveRootView;
  'recordingArchive.authorizationReceipt': { root: ArchiveRootView | null };
  'recordingPrepared.select': PreparedSelection;
  'recordingPrepared.selectionReceipt': { selection: PreparedSelection | null };
  'recordingPreparation.authorizationReceipt': { destination: PreparationDestination | null };
  'recordingPreparation.authorize': PreparationDestination;
  'recordingPreparation.context': { absolutePath: string };

  'recordingSources.rootReceipt': { root: SourceRoot | null };
  'recordingSources.authorize': SourceRoot;
  'recordingSources.context': { absolutePath: string };
  'recordingSources.start': SourceJob;

  'auth.pollQr': { state: PublicAuthState; credential?: string };
  'auth.verifyCredential': { status: 'authorized' | 'expired' | 'unavailable' };
}

export interface IpcEventMessage {
  version: typeof IPC_VERSION;
  event: IpcEventName;
  payload: unknown;
}

export type IpcEventName = (typeof IPC_EVENTS)[number];

export type TypedIpcRequest<TCommand extends IpcCommand = IpcCommand> =
  TCommand extends IpcCommand
    ? IpcRequest<IpcCommandPayloads[TCommand]> & { command: TCommand }
    : never;

export type TypedIpcResponse<TCommand extends IpcCommand = IpcCommand> =
  TCommand extends IpcCommand
    ? IpcResponse<IpcCommandResults[TCommand]>
    : never;

export type TypedIpcEvent<TEvent extends IpcEventName = IpcEventName> =
  TEvent extends IpcEventName
    ? { version: typeof IPC_VERSION; event: TEvent; payload: IpcEventPayloads[TEvent] }
    : never;

export type IpcRuntimeMessage = IpcResponse<unknown> | TypedIpcEvent;
