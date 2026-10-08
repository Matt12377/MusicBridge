import type { LocalArtworkCommandPayloads, LocalArtworkCommandResults, LocalArtworkInternalCommand } from './local-artwork.js';
import type { LocalSourceWritesCommandPayloads, LocalSourceWritesCommandResults } from './local-source-writes.js';
import type { LocalRelocationPlanCommandPayloads, LocalRelocationPlanCommandResults } from './local-relocation-plan.js';
import type { LocalLegacyLinksCommandPayloads, LocalLegacyLinksCommandResults } from './local-legacy-links.js';
import type { LocalPlayAccepted } from './local-play-request.js';
import type {LocalRelocationCommandPayloads,LocalRelocationCommandResults,LocalRelocationInternalCommand} from './local-relocation.js';
import type { LocalScanCommandPayloads, LocalScanCommandResults, LocalScanInternalCommand } from './local-scan.js';
import type { LocalPlayRequest, LocalSourceUnsupported } from './local-play-request.js';
import type { LocalCatalogCommandPayloads, LocalCatalogCommandResults, LocalLibraryReadCommandPayloads, LocalLibraryReadCommandResults, LocalCatalogInternalCommand } from './local-catalog.js';
import type { VolumeRequest, VolumeSnapshot } from './volume.js';
import type { RoonDisplayLyricsEvent } from './roon-display-lyrics.js';
import type { GetMasterArtworkRequest, SaveMasterArtworkRequest, MasterArtworkResult, MasterArtworkVersion } from './recording-artwork.js';
import type { ListRecordingPrintsRequest, RequestRecordingPrintRequest, RetryRecordingPrintRequest, GetRecordingPrintRequest, ExportRecordingPrintRequest, RecordingPrintsPage, RecordingPrintJob, RecordingPrintResult, ClaimRecordingPrintRequest, CompleteRecordingPrintRequest, FailRecordingPrintRequest, RecordingPrintLease, RecordingPrintPdfResult } from './recording-prints.js';
import type { RecordingReplicaStatus, InspectRecordingReplicaRequest, RecordingReplicaReadIdRequest, StartRecordingReplicaRequest, RecordingReplicaRunIdRequest, ReplicaDeviceControlRequest, RecordingReplicaInspection, RecordingReplicaReadCancellation, RecordingReplicaRun } from './recording-replica.js';
import type { ListRecordingRecordsRequest, RecordingRecordIdRequest, RecordingVisualRequest, PhysicalRecordingHistoryRequest, PreviewPhysicalRecordingDispositionRequest, ApplyPhysicalRecordingDispositionRequest, RecordingRecordsPage, RecordingRecordDetail, RecordingVisualResult, PhysicalRecordingHistory, PhysicalRecordingDispositionProposal, ApplyPhysicalRecordingDispositionResult } from './recording-records.js';
import type { RecordingOutputStatus, RecordingOutputCheckRequest, RecordingOutputCancelRequest, RecordingOutputCheckResult } from './recording-output.js';
import type { RecordingDeviceCandidates, RecordingOutputSelection, SelectRecordingDeviceRequest } from './recording-device-selection.js';
import type { ListRecordingAttemptsRequest, RecordingAttemptIdRequest, BeginRecordingAttemptRequest, ConfirmRecordingAttemptRequest, BeginRecordingAttemptSideRequest, StopRecordingAttemptRequest, RecordingAttemptsPage, RecordingAttempt, RecordingAttemptReceiptRequest, RecordingAttemptReceipt } from './recording-attempts.js';
import type { RecordingPlanHistoryRequest, RecordingPlanIdRequest, PreviewRecordingPlanRequest, FreezeRecordingPlanRequest, RecordingPreflightRequest, RecordingPlanHistory, RecordingPlanVersion, RecordingPlanProposal, RecordingPreflightResult } from './recording-plans.js';
import type { SpreadsheetPageRequest, SpreadsheetSourcePage, SpreadsheetIdRequest, SpreadsheetWorkbookSource, SpreadsheetSourceRowsRequest, SpreadsheetSourceRowsPage, PreviewSpreadsheetImportRequest, SpreadsheetImportPreview, ApplySpreadsheetImportRequest, SpreadsheetImportResult, SpreadsheetImportRevisionRequest, SpreadsheetImportRevisionDetail, SpreadsheetImportHistory, SpreadsheetAdjustmentPreviewRequest, SpreadsheetAdjustmentBalance, AdjustSpreadsheetInventoryRequest, SpreadsheetInventoryAdjustment, SpreadsheetAdjustmentsRequest, SpreadsheetAdjustmentsPage, RegisterSpreadsheetWorkbookRequest, ChooseSpreadsheetWorkbookRequest, SpreadsheetWorkbookReceipt } from './spreadsheet-import.js';
import type { ListWantEntriesRequest, WantEntriesPage, SaveWantEntryRequest, WantEntry, CancelWantEntryRequest, GetWantEntryHistoryRequest, WantEntryHistory, GetCollectionProgressRequest, CollectionProgress, CaptureCollectionProgressRequest, CollectionProgressSnapshotSummary, ListCollectionProgressSnapshotsRequest, CollectionProgressSnapshotsPage, GetCollectionProgressSnapshotRequest, CollectionProgressSnapshotDetail, GetCollectionModelLengthsRequest, CollectionModelLengths } from './collection-progress.js';
import type { CommandOutboxContext, CommandOutboxExecute, CommandOutboxResult } from './command-outbox.js';
import type { RegisterReferenceSourceRequest, ReferenceSourceVersion, ReferenceSourceListRequest, ReferenceSourcePage, CatalogIdRequest, ReferenceSourceDetail, PreviewReferenceSourceZipRequest, ReferenceSourceZipPreview, RegisterReferenceSourceZipRequest, RegisterReferenceSourceZipResult, ReferenceSourceZipReceiptListRequest, ReferenceSourceZipReceiptPage, PreviewCatalogRevisionRequest, CatalogRevisionPreview, PublishCatalogRevisionRequest, CatalogRevisionDetail, SetCatalogMatchRequest, CatalogSnapshot, CatalogHistoryRequest, CatalogHistory } from './reference-catalog.js';
import type { ActivateRestoredDataset, RestoreActivationView } from './recording-activation.js';
import type { BackupOverview, BackupRootView, AuthorizeBackupRoot, StartBackupJob, BackupJobView } from './recording-backups.js';
import type { ArchiveRootView, InitializeArchiveRequest, ArchiveProposal, StartArchiveRequest, PreviewArchiveRequest, ArchiveOperationView, ArchiveHistory, ArchiveCheck, VerifyArchiveRequest } from './recording-archive.js';
import type { RecordingProfileVersion, RecordingProfileHistory, RecordingSessionSettings, SaveRecordingProfileRequest, SaveRecordingSessionRequest } from './recording-profile.js';
import type { ExecutionHistory, ExecutionProposal, ExecutionJob, ExecutionAssetCheck, PreviewExecutionRequest, StartExecutionRequest, VerifyExecutionRequest } from './execution-assets.js';
import type { PreparedHistory, PreparedSelection, SelectPreparedRequest, PreviewPreparedImportRequest, StartPreparedImportRequest, PreparedImportJob, PreparedImportProposal, ReviewPreparedRequest, FreezePreparedRequest, PreparedReview, FrozenPrepared } from './prepared-render.js';
import type { PreviewVersionsRequest, FreezeVersionsRequest, VersionProposal, VersionHistory, VersionJob } from './master-versions.js';
import type { PreviewPreparationRequest, StartPreparationRequest, PreparationHistory, PreparationProposal, PreparationJob, PreparationDestination } from './preparation.js';
import type { PreviewPreparationZipRequest, StartPreparationZipRequest, PreparationZipReceiptRequest, PreparationZipReceipt, PreparationZipTarget, PreparationZipProposal, PreparationZipJob, PreparationZipHistory } from './preparation-export.js';
import type { MediaPlan, MediaPreview, MediaLayoutSpec, PreviewMediaRequest, SaveMediaPlanRequest, ReserveMediaRequest, ReleaseMediaRequest } from './media-planning.js';
import type { RecordingWorkspaceContext, PutRecordingWorkspaceContextRequest } from './recording-workspace.js';
import type { SourceRoot, SourceJob, SourceBinding, SourceSelection, SourceAction, SourceConfirmation, DraftSourceSnapshot } from './source-evidence.js';
import type { SourceCandidateScan, StartSourceCandidateScan, SelectSourceCandidate } from './source-candidates.js';
import type { MasterDraft, MasterDraftSummary, AppendMasterDraftRequest, UpdateMasterDraftRequest, MasterDraftResult } from './master-drafts.js';
import type { DigitalAlbum, DigitalAlbumDetail, PhysicalLinksSnapshot, PhysicalLinkHistoryEvent, DigitalRuntime, ConfirmPhysicalLinkRequest, LegacyConfirmPhysicalLinkRequest, RelocateDigitalRequest, RegisterDigitalRequest, RemovePhysicalLinkRequest, LegacyRemovePhysicalLinkRequest, ConfirmAbsenceRequest, PhysicalLinkResult, CollectionMatrixRow } from './physical-links.js';
import type { MusicFilter, MusicEntry, MusicDetail, CommercialCopiesSnapshot, SaveReleaseRequest, MaterializeCommercialCopyRequest, SaveCommercialCopyDetailsRequest, AssignCommercialCopyPhotoRequest, SaveLegacyRequest, MusicMutationResult, AddMusicPhotoRequest, RemoveMusicPhotoRequest } from './physical-music.js';
import type { PublicError } from './errors.js';
import type { CollectionFilter, CollectionPhotoImage, CollectionAddPhotoRequest, CollectionChangePhotoRequest, CollectionModel, CollectionDetail, CollectionCopyDetail, CollectionReceiveRequest, CollectionMaterializeRequest, CollectionUpdateCopyRequest, CollectionPolicyRequest, CollectionMutationResult } from './collection.js';
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
  PlaybackEventProtocolAck,
  PlaybackStreamSnapshot,
  PlaybackStreamState,
  PlaybackStreamProgress,
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

import { IPC_COMMANDS, IPC_EVENTS, type IpcCommand, type IpcEvent } from './ipc-names.js';
export { IPC_COMMANDS, IPC_EVENTS, type IpcCommand, type IpcEvent } from './ipc-names.js';

export interface LibraryReadContext { deadlineAtMs: number; cacheMode?: 'reload' }

export interface IpcRequest<TPayload = unknown> {
  readContext?: LibraryReadContext;
  performanceTrace?: import('./performance.js').PerformanceTraceContext;
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

export interface IpcCommandPayloads extends LocalRelocationPlanCommandPayloads, LocalSourceWritesCommandPayloads, LocalLegacyLinksCommandPayloads, LocalOrganizerCommandPayloads, LocalArtworkCommandPayloads, LocalCatalogCommandPayloads, LocalLibraryReadCommandPayloads, LocalScanCommandPayloads, LocalRelocationCommandPayloads {
  'localCatalog.prepare': LocalPlayRequest;
  'playback.localTarget': Record<string, never>;
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
  'referenceCatalog.previewSourceZip': PreviewReferenceSourceZipRequest;
  'referenceCatalog.registerSourceZip': RegisterReferenceSourceZipRequest;
  'referenceCatalog.sourceZipReceipts': ReferenceSourceZipReceiptListRequest;
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

  'recordingPlans.list': RecordingPlanHistoryRequest;
  'recordingPlans.version': RecordingPlanIdRequest;
  'recordingPlans.preview': PreviewRecordingPlanRequest;
  'recordingPlans.freeze': FreezeRecordingPlanRequest;
  'recordingPlans.preflight': RecordingPreflightRequest;
  'recordingPlans.cancelRead': RecordingPlanIdRequest;
  'recordingDevice.candidates': Record<string, never>;
  'recordingDevice.select': SelectRecordingDeviceRequest;
  'recordingWorkspace.get': { draftId: string };
  'recordingWorkspace.put': PutRecordingWorkspaceContextRequest;
  'masterArtwork.get': GetMasterArtworkRequest;
  'masterArtwork.save': SaveMasterArtworkRequest;
  'recordingPrints.list': ListRecordingPrintsRequest;
  'recordingPrints.request': RequestRecordingPrintRequest;
  'recordingPrints.retry': RetryRecordingPrintRequest;
  'recordingPrints.get': GetRecordingPrintRequest;
  'recordingPrintWorker.claim': ClaimRecordingPrintRequest;
  'recordingPrintWorker.complete': CompleteRecordingPrintRequest;
  'recordingPrintWorker.fail': FailRecordingPrintRequest;
  'recordingPrintWorker.pdf': ExportRecordingPrintRequest;
  'recordingReplica.status': Record<string, never>;
  'recordingReplica.inspect': InspectRecordingReplicaRequest;
  'recordingReplica.cancelRead': RecordingReplicaReadIdRequest;
  'recordingReplica.start': StartRecordingReplicaRequest;
  'recordingReplica.get': RecordingReplicaRunIdRequest;
  'recordingReplica.stop': RecordingReplicaRunIdRequest;
  'recordingReplica.control': ReplicaDeviceControlRequest;
  'recordingOutput.status': Record<string, never>;
  'recordingOutput.check': RecordingOutputCheckRequest;
  'recordingOutput.cancel': RecordingOutputCancelRequest;
  'recordingRecords.list': ListRecordingRecordsRequest;
  'recordingRecords.get': RecordingRecordIdRequest;
  'recordingRecords.visual': RecordingVisualRequest;
  'recordingRecords.history': PhysicalRecordingHistoryRequest;
  'recordingRecords.previewDisposition': PreviewPhysicalRecordingDispositionRequest;
  'recordingRecords.applyDisposition': ApplyPhysicalRecordingDispositionRequest;
  'recordingAttempts.list': ListRecordingAttemptsRequest;
  'recordingAttempts.get': RecordingAttemptIdRequest;
  'recordingAttempts.receipt': RecordingAttemptReceiptRequest;
  'recordingAttempts.begin': BeginRecordingAttemptRequest;
  'recordingAttempts.confirm': ConfirmRecordingAttemptRequest;
  'recordingAttempts.beginSide': BeginRecordingAttemptSideRequest;
  'recordingAttempts.stop': StopRecordingAttemptRequest;
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
  'recordingPreparationZip.authorizeTarget': {
    targetId: string; absolute: string; parentPath: string; parentDev: string; parentIno: string;
    datasetId: string; scopeId: string; generation: number; expiresAt: string;
  };
  'recordingPreparationZip.invalidateScope': { scopeId: string };
  'recordingPreparationZip.preview': PreviewPreparationZipRequest;
  'recordingPreparationZip.start': StartPreparationZipRequest;
  'recordingPreparationZip.list': { draftId: string };
  'recordingPreparationZip.job': { id: string };
  'recordingPreparationZip.receipt': PreparationZipReceiptRequest;
  'recordingPreparationZip.cancel': { commandId: string; id: string };
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
  'recordingCandidates.start': StartSourceCandidateScan;
  'recordingCandidates.get': { id: string };
  'recordingCandidates.cancel': SourceAction;
  'recordingCandidates.select': SelectSourceCandidate;
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
  'physicalLinks.history': { releaseId: string; page: PageRequest };
  'physicalLinks.runtime': { id: string };
  'physicalLinks.confirm': LegacyConfirmPhysicalLinkRequest;
  'physicalLinks.confirmWithEvidence': ConfirmPhysicalLinkRequest;
  'physicalLinks.relocate': RelocateDigitalRequest;
  'physicalLinks.register': RegisterDigitalRequest;
  'physicalLinks.remove': LegacyRemovePhysicalLinkRequest;
  'physicalLinks.removeWithEvidence': RemovePhysicalLinkRequest;
  'physicalLinks.absence': ConfirmAbsenceRequest;
  'physicalLinks.matrix': { page: PageRequest; query?: string };
  'physicalMusic.list': { page: PageRequest; filter?: MusicFilter };
  'physicalMusic.detail': { id: string };
  'physicalMusic.copies': { releaseId: string; page: PageRequest };
  'physicalMusic.saveRelease': SaveReleaseRequest;
  'physicalMusic.materializeCopy': MaterializeCommercialCopyRequest;
  'physicalMusic.saveCopyDetails': SaveCommercialCopyDetailsRequest;
  'physicalMusic.assignCopyPhoto': AssignCommercialCopyPhotoRequest;
  'physicalMusic.saveLegacy': SaveLegacyRequest;
  'physicalMusic.addPhoto': AddMusicPhotoRequest;
  'physicalMusic.photo': { photoId: string };
  'physicalMusic.removePhoto': RemoveMusicPhotoRequest;
  'collection.list': { page: PageRequest; filter?: CollectionFilter };
  'collection.addPhoto': CollectionAddPhotoRequest;
  'collection.photo': { photoId: string };
  'collection.changePhoto': CollectionChangePhotoRequest;
  'collection.detail': { modelId: string; page: PageRequest };
  'collection.copy': { physicalId: string };
  'collection.receive': CollectionReceiveRequest;
  'collection.materialize': CollectionMaterializeRequest;
  'collection.updateCopy': CollectionUpdateCopyRequest;
  'collection.setPolicy': CollectionPolicyRequest;
  'favorites.check': { descriptor: FavoriteEntityDescriptor };
  'favorites.set': { descriptor: FavoriteEntityDescriptor; favorite: boolean };
  'lyrics.get': { trackId: string };
  'lyrics.display.update': RoonDisplayLyricsEvent;
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
  'roon.library.search': { query: string; page: PageRequest; kind?: 'track' | 'album' | 'artist' };
  'roon.library.image': { reference: string; options?: RoonImageOptions };
  'roon.library.play': { reference: string; zoneId: string; queueReferences?: readonly string[]; contextHandle?: string };
  'roon.library.queue': { reference: string; zoneId: string };
  'roon.transport.stop': Record<string, never>;
  'playback.getState': Record<string, never>;
  'playback.getStreamSnapshot': Record<string, never>;
  'playback.play': {
    trackId: string;
    qualityPreference: PlaybackQualityPreference;
    rendererClickAtMs?: number;
  };
  'playback.pause': Record<string, never>;
  'playback.resume': Record<string, never>;
  'playback.seek': { positionMs: number };
  'roon.volume.get': Record<string, never>;
  'roon.volume.set': VolumeRequest;
  'playback.stop': Record<string, never>;
  'playback.next': Record<string, never>;
  'playback.previous': Record<string, never>;
  'playback.editQueue': import('./mb-queue.js').MBQueueEditRequest;
  'playback.playQueueEntry': import('./mb-queue.js').MBQueuePlayEntryRequest;
  'playback.queueLocalEdition': import('./mb-queue.js').MBEditionQueueRequest;
  'playback.playQueueIndex': { index: number };
  'playback.replaceQueue': { items: readonly PlaybackQueueRequestItem[]; index: number };
  'playback.appendQueue': { items: readonly PlaybackQueueRequestItem[] };
  'playback.insertNext': { items: readonly PlaybackQueueRequestItem[] };
}

export interface IpcCommandResults extends LocalRelocationPlanCommandResults, LocalSourceWritesCommandResults, LocalLegacyLinksCommandResults, LocalOrganizerCommandResults, LocalArtworkCommandResults, LocalCatalogCommandResults, LocalLibraryReadCommandResults, LocalScanCommandResults, LocalRelocationCommandResults {
  'localCatalog.prepare': LocalSourceUnsupported | LocalPlayAccepted;
  'playback.localTarget': import('./local-play-request.js').LocalPlayTarget | null;
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
  'referenceCatalog.previewSourceZip': ReferenceSourceZipPreview;
  'referenceCatalog.registerSourceZip': RegisterReferenceSourceZipResult;
  'referenceCatalog.sourceZipReceipts': ReferenceSourceZipReceiptPage;
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

  'recordingPlans.list': RecordingPlanHistory;
  'recordingPlans.version': { plan: RecordingPlanVersion | null };
  'recordingPlans.preview': RecordingPlanProposal;
  'recordingPlans.freeze': RecordingPlanVersion;
  'recordingPlans.preflight': RecordingPreflightResult;
  'recordingPlans.cancelRead': { cancelled: true };
  'recordingDevice.candidates': RecordingDeviceCandidates;
  'recordingDevice.select': RecordingOutputSelection;
  'recordingWorkspace.get': { context: RecordingWorkspaceContext | null };
  'recordingWorkspace.put': RecordingWorkspaceContext;
  'masterArtwork.get': MasterArtworkResult;
  'masterArtwork.save': MasterArtworkVersion;
  'recordingPrints.list': RecordingPrintsPage;
  'recordingPrints.request': RecordingPrintJob;
  'recordingPrints.retry': RecordingPrintJob;
  'recordingPrints.get': RecordingPrintResult;
  'recordingPrintWorker.claim': { lease: RecordingPrintLease | null };
  'recordingPrintWorker.complete': RecordingPrintJob;
  'recordingPrintWorker.fail': RecordingPrintJob;
  'recordingPrintWorker.pdf': RecordingPrintPdfResult;
  'recordingReplica.status': RecordingReplicaStatus;
  'recordingReplica.inspect': RecordingReplicaInspection;
  'recordingReplica.cancelRead': RecordingReplicaReadCancellation;
  'recordingReplica.start': RecordingReplicaRun;
  'recordingReplica.get': { run: RecordingReplicaRun | null };
  'recordingReplica.stop': RecordingReplicaRun;
  'recordingReplica.control': RecordingReplicaRun;
  'recordingOutput.status': RecordingOutputStatus;
  'recordingOutput.check': RecordingOutputCheckResult;
  'recordingOutput.cancel': { cancelled: true };
  'recordingRecords.list': RecordingRecordsPage;
  'recordingRecords.get': { record: RecordingRecordDetail | null };
  'recordingRecords.visual': RecordingVisualResult;
  'recordingRecords.history': PhysicalRecordingHistory;
  'recordingRecords.previewDisposition': PhysicalRecordingDispositionProposal;
  'recordingRecords.applyDisposition': ApplyPhysicalRecordingDispositionResult;
  'recordingAttempts.list': RecordingAttemptsPage;
  'recordingAttempts.get': { attempt: RecordingAttempt | null };
  'recordingAttempts.receipt': RecordingAttemptReceipt;
  'recordingAttempts.begin': RecordingAttempt;
  'recordingAttempts.confirm': RecordingAttempt;
  'recordingAttempts.beginSide': RecordingAttempt;
  'recordingAttempts.stop': RecordingAttempt;
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
  'recordingPreparationZip.authorizeTarget': PreparationZipTarget;
  'recordingPreparationZip.invalidateScope': { invalidated: true };
  'recordingPreparationZip.preview': PreparationZipProposal;
  'recordingPreparationZip.start': PreparationZipJob;
  'recordingPreparationZip.list': PreparationZipHistory;
  'recordingPreparationZip.job': { job: PreparationZipJob | null };
  'recordingPreparationZip.receipt': PreparationZipReceipt;
  'recordingPreparationZip.cancel': PreparationZipJob;
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
  'recordingCandidates.start': SourceCandidateScan;
  'recordingCandidates.get': { scan: SourceCandidateScan | null };
  'recordingCandidates.cancel': SourceCandidateScan;
  'recordingCandidates.select': SourceJob;
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
  'physicalLinks.history': Page<PhysicalLinkHistoryEvent>;
  'physicalLinks.runtime': DigitalRuntime;
  'physicalLinks.confirm': PhysicalLinkResult;
  'physicalLinks.confirmWithEvidence': PhysicalLinkResult;
  'physicalLinks.relocate': PhysicalLinkResult;
  'physicalLinks.register': PhysicalLinkResult;
  'physicalLinks.remove': PhysicalLinkResult;
  'physicalLinks.removeWithEvidence': PhysicalLinkResult;
  'physicalLinks.absence': PhysicalLinkResult;
  'physicalLinks.matrix': Page<CollectionMatrixRow>;
  'physicalMusic.list': Page<MusicEntry>;
  'physicalMusic.detail': MusicDetail;
  'physicalMusic.copies': CommercialCopiesSnapshot;
  'physicalMusic.saveRelease': MusicMutationResult;
  'physicalMusic.materializeCopy': MusicMutationResult;
  'physicalMusic.saveCopyDetails': MusicMutationResult;
  'physicalMusic.assignCopyPhoto': MusicMutationResult;
  'physicalMusic.saveLegacy': MusicMutationResult;
  'physicalMusic.addPhoto': MusicMutationResult;
  'physicalMusic.photo': CollectionPhotoImage;
  'physicalMusic.removePhoto': MusicMutationResult;
  'collection.list': Page<CollectionModel>;
  'collection.addPhoto': CollectionMutationResult;
  'collection.photo': CollectionPhotoImage;
  'collection.changePhoto': CollectionMutationResult;
  'collection.detail': CollectionDetail;
  'collection.copy': CollectionCopyDetail;
  'collection.receive': CollectionMutationResult;
  'collection.materialize': CollectionMutationResult;
  'collection.updateCopy': CollectionMutationResult;
  'collection.setPolicy': CollectionMutationResult;
  'favorites.check': { favorite: boolean };
  'favorites.set': { favorite: boolean; item?: FavoriteRecord };
  'lyrics.get': LyricsSnapshot;
  'lyrics.display.update': { applied: boolean };
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
  'playback.getStreamSnapshot': PlaybackStreamSnapshot | null;
  'playback.play': PlaybackSnapshot;
  'playback.pause': PlaybackSnapshot;
  'playback.resume': PlaybackSnapshot;
  'playback.seek': { positionMs: number };
  'roon.volume.get': VolumeSnapshot;
  'roon.volume.set': VolumeSnapshot;
  'playback.stop': PlaybackSnapshot;
  'playback.next': PlaybackSnapshot;
  'playback.previous': PlaybackSnapshot;
  'playback.editQueue': PlaybackSnapshot;
  'playback.playQueueEntry': PlaybackSnapshot;
  'playback.queueLocalEdition': PlaybackSnapshot;
  'playback.playQueueIndex': PlaybackSnapshot;
  'playback.replaceQueue': PlaybackSnapshot;
  'playback.appendQueue': PlaybackSnapshot;
  'playback.insertNext': PlaybackSnapshot;
}

export interface IpcEventPayloads {
  'core.ready': { state: PublicBridgeState; playbackEvents?: PlaybackEventProtocolAck };
  'core.health': { state: PublicBridgeState };
  'roon.changed': { state: PublicBridgeState };
  'auth.changed': { state: PublicAuthState };
  'account.changed': { state: PublicAccountState };
  'diagnostic.notice': { code: string; message?: string };
  'playback.changed': { state: PlaybackSnapshot };
  'playback.snapshot': PlaybackStreamSnapshot;
  'playback.state': PlaybackStreamState;
  'playback.progress': PlaybackStreamProgress;
  'queue.changed': { queue: PlaybackQueueSnapshot };
  'lyrics.changed': { state: LyricsSnapshot };
  'lyrics.match.changed': { state: LocalLyricsMatchSnapshot };
}

export type IpcInternalCommand = LocalArtworkInternalCommand | LocalCatalogInternalCommand | LocalScanInternalCommand | LocalRelocationInternalCommand | 'lyrics.display.update' | 'recordingPrintWorker.claim' | 'recordingPrintWorker.complete' | 'recordingPrintWorker.fail' | 'recordingPrintWorker.pdf' | 'spreadsheetImports.registerWorkbook' | 'spreadsheetImports.workbookReceipt' | 'recordingBackups.activationReceipt' | 'recordingBackups.authorize' | 'recordingBackups.authorizationReceipt' | 'recordingArchive.authorize' | 'recordingArchive.authorizationReceipt' | 'recordingPrepared.select' | 'recordingPrepared.selectionReceipt' | 'recordingPreparation.authorizationReceipt' | 'recordingPreparation.authorize' | 'recordingPreparation.context' | 'recordingPreparationZip.authorizeTarget' | 'recordingPreparationZip.invalidateScope' | 'auth.pollQr' | 'auth.verifyCredential' | 'recordingSources.rootReceipt' | 'recordingSources.authorize' | 'recordingSources.context' | 'recordingSources.start';

export interface IpcInternalCommandResults extends Pick<LocalArtworkCommandResults, LocalArtworkInternalCommand>, Pick<LocalCatalogCommandResults, LocalCatalogInternalCommand>, Pick<LocalScanCommandResults, LocalScanInternalCommand>, Pick<LocalRelocationCommandResults,LocalRelocationInternalCommand> {
  'lyrics.display.update': { applied: boolean };
  'recordingPrintWorker.claim': { lease: RecordingPrintLease | null };
  'recordingPrintWorker.complete': RecordingPrintJob;
  'recordingPrintWorker.fail': RecordingPrintJob;
  'recordingPrintWorker.pdf': RecordingPrintPdfResult;

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
  'recordingPreparationZip.authorizeTarget': PreparationZipTarget;
  'recordingPreparationZip.invalidateScope': { invalidated: true };

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
import type { LocalOrganizerCommandPayloads, LocalOrganizerCommandResults } from './local-organizer.js';
