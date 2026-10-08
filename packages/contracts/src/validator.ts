import { isLocalArtworkCommand, isLocalArtworkInternalCommand, isLocalArtworkCommandPayload, isLocalArtworkCommandResult } from './local-artwork.js';
import { isLocalLegacyLinksCommand, isLocalLegacyLinksCommandPayload, isLocalLegacyLinksCommandResult, localLegacyRecord, localLegacyLinksDataSnapshot } from './local-legacy-links.js';
import { LOCAL_SOURCE_WRITES_BUDGET, isLocalSourceWritesCommand, isLocalSourceWritesCommandPayload, isLocalSourceWritesCommandResult } from './local-source-writes.js';
import { localSourceWritesDataSnapshot, localSourceWritesRecord } from './local-source-writes-data.js';
import { isLocalRelocationPlanCommand, isLocalRelocationPlanCommandPayload, isLocalRelocationPlanCommandResult, localRelocationDataSnapshot, localRelocationRecord } from './local-relocation-plan.js';
import {isMBQueueEditRequest,isMBQueuePlayEntryRequest,isMBEditionQueueRequest} from './mb-queue.js';
import {isAlbumEdition,isLocalExactInteger} from './local-catalog.js';
import { isLocalPlayAccepted, isLocalQueueIdentity } from './local-play-request.js';
import { isLocalPlaybackObservationLeaf } from './local-playback-compat.js';
import {isLocalRelocationCommand,isLocalRelocationInternalCommand,isLocalRelocationCommandPayload,isLocalRelocationCommandResult} from './local-relocation.js';
import { isLocalScanCommand, isLocalScanInternalCommand, isLocalScanCommandPayload, isLocalScanCommandResult } from './local-scan.js';
import { isLocalPlayRequest, isLocalPlayTarget, isLocalSourceUnsupported } from './local-play-request.js';
import { isLocalCatalogCommand, isLocalCatalogInternalCommand, isLocalCatalogCommandPayload, isLocalCatalogCommandResult } from './local-catalog.js';
import { copyPerformanceTraceContext, isPerformanceTraceSnapshot } from './performance.js';
import { isLibraryReadCommand, isLibraryReadContext } from './library-read.js';
import { isVolumeRequest, isVolumeSnapshot } from './volume.js';
import { isRoonDisplayLyricsEvent } from './roon-display-lyrics.js';
import { isGetMasterArtworkRequest, isSaveMasterArtworkRequest, isMasterArtworkResult, isMasterArtworkVersion } from './recording-artwork.js';
import { isListRecordingPrintsRequest, isRequestRecordingPrintRequest, isRetryRecordingPrintRequest, isGetRecordingPrintRequest, isExportRecordingPrintRequest, isRecordingPrintsPage, isRecordingPrintJob, isRecordingPrintResult, isClaimRecordingPrintRequest, isCompleteRecordingPrintRequest, isFailRecordingPrintRequest, isRecordingPrintLease, isRecordingPrintPdfResult } from './recording-prints.js';
import { isRecordingReplicaStatus, isInspectRecordingReplicaRequest, isRecordingReplicaReadIdRequest, isStartRecordingReplicaRequest, isRecordingReplicaRunIdRequest, isReplicaDeviceControlRequest, isRecordingReplicaInspection, isRecordingReplicaReadCancellation, isRecordingReplicaRun } from './recording-replica.js';
import { isListRecordingRecordsRequest, isRecordingRecordIdRequest, isRecordingVisualRequest, isPhysicalRecordingHistoryRequest, isPreviewPhysicalRecordingDispositionRequest, isApplyPhysicalRecordingDispositionRequest, isRecordingRecordsPage, isRecordingRecordDetail, isRecordingVisualResult, isPhysicalRecordingHistory, isPhysicalRecordingDispositionProposal, isApplyPhysicalRecordingDispositionResult } from './recording-records.js';
import { isRecordingOutputStatus, isRecordingOutputCheckRequest, isRecordingOutputCancelRequest, isRecordingOutputCheckResult } from './recording-output.js';
import { isRecordingDeviceCandidates, isRecordingOutputSelection, isSelectRecordingDeviceRequest } from './recording-device-selection.js';
import { isListRecordingAttemptsRequest, isRecordingAttemptIdRequest, isBeginRecordingAttemptRequest, isConfirmRecordingAttemptRequest, isBeginRecordingAttemptSideRequest, isStopRecordingAttemptRequest, isRecordingAttemptsPage, isRecordingAttempt, isRecordingAttemptReceiptRequest, isRecordingAttemptReceipt } from './recording-attempts.js';
import { isRecordingPlanHistoryRequest, isRecordingPlanIdRequest, isPreviewRecordingPlanRequest, isFreezeRecordingPlanRequest, isRecordingPreflightRequest, isRecordingPlanHistory, isRecordingPlanVersion, isRecordingPlanProposal, isRecordingPreflightResult } from './recording-plans.js';
import { isSpreadsheetPageRequest, isSpreadsheetSourcePage, isSpreadsheetIdRequest, isSpreadsheetWorkbookSource, isSpreadsheetSourceRowsRequest, isSpreadsheetSourceRowsPage, isPreviewSpreadsheetImportRequest, isSpreadsheetImportPreview, isApplySpreadsheetImportRequest, isSpreadsheetImportResult, isSpreadsheetImportRevisionRequest, isSpreadsheetImportRevisionDetail, isSpreadsheetImportHistory, isSpreadsheetAdjustmentPreviewRequest, isSpreadsheetAdjustmentBalance, isAdjustSpreadsheetInventoryRequest, isSpreadsheetInventoryAdjustment, isSpreadsheetAdjustmentsRequest, isSpreadsheetAdjustmentsPage, isRegisterSpreadsheetWorkbookRequest, isChooseSpreadsheetWorkbookRequest, isSpreadsheetWorkbookReceipt } from './spreadsheet-import.js';
import { isListWantEntriesRequest, isWantEntriesPage, isSaveWantEntryRequest, isWantEntry, isCancelWantEntryRequest, isGetWantEntryHistoryRequest, isWantEntryHistory, isGetCollectionProgressRequest, isCollectionProgress, isCaptureCollectionProgressRequest, isCollectionProgressSnapshotSummary, isListCollectionProgressSnapshotsRequest, isCollectionProgressSnapshotsPage, isGetCollectionProgressSnapshotRequest, isCollectionProgressSnapshotDetail, isGetCollectionModelLengthsRequest, isCollectionModelLengths } from './collection-progress.js';
import { isCommandOutboxDatasetId, isCommandOutboxContext, isCommandOutboxExecute, isCommandOutboxResult } from './command-outbox.js';
import { isRegisterReferenceSourceRequest, isReferenceSourceVersion, isReferenceSourceListRequest, isReferenceSourcePage, isCatalogIdRequest, isReferenceSourceDetail, isPreviewReferenceSourceZipRequest, isReferenceSourceZipPreview, isRegisterReferenceSourceZipRequest, isRegisterReferenceSourceZipResult, isReferenceSourceZipReceiptListRequest, isReferenceSourceZipReceiptPage, isPreviewCatalogRevisionRequest, isCatalogRevisionPreview, isPublishCatalogRevisionRequest, isCatalogRevisionDetail, isSetCatalogMatchRequest, isCatalogSnapshot, isCatalogHistoryRequest, isCatalogHistory } from './reference-catalog.js';
import { isActivateRestoredDataset, isRestoreActivationView } from './recording-activation.js';
import { isBackupOverview, isBackupRootView, isAuthorizeBackupRoot, isStartBackupJob, isBackupJobView } from './recording-backups.js';
import { isArchiveRootView, isInitializeArchiveRequest, isArchiveProposal, isStartArchiveRequest, isPreviewArchiveRequest, isArchiveOperationView, isArchiveHistory, isArchiveCheck, isVerifyArchiveRequest } from './recording-archive.js';
import { isRecordingProfileVersion, isRecordingProfileHistory, isRecordingSessionSettings, isSaveRecordingProfileRequest, isSaveRecordingSessionRequest } from './recording-profile.js';
import { isExecutionHistory, isExecutionProposal, isExecutionJob, isExecutionAssetCheck, isPreviewExecutionRequest, isStartExecutionRequest, isVerifyExecutionRequest } from './execution-assets.js';
import { isPreparedHistory, isPreparedSelection, isSelectPreparedRequest, isPreviewPreparedImportRequest, isStartPreparedImportRequest, isPreparedImportProposal, isPreparedImportJob, isReviewPreparedRequest, isFreezePreparedRequest, isPreparedReview, isFrozenPrepared } from './prepared-render.js';
import { isPreviewVersionsRequest, isFreezeVersionsRequest, isVersionProposal, isVersionHistory, isVersionJob } from './master-versions.js';
import { isPreviewPreparationRequest, isStartPreparationRequest, isPreparationHistory, isPreparationProposal, isPreparationJob, isPreparationDestination } from './preparation.js';
import { isPreparationZipTarget, isPreviewPreparationZipRequest, isStartPreparationZipRequest, isPreparationZipReceiptRequest, isPreparationZipReceipt, isPreparationZipProposal, isPreparationZipJob, isPreparationZipHistory } from './preparation-export.js';
import { isMediaLayoutSpec, isPreviewMediaRequest, isSaveMediaPlanRequest, isReserveMediaRequest, isReleaseMediaRequest, isMediaPlan, isMediaCandidate, isMediaPreview } from './media-planning.js';
import { isPutRecordingWorkspaceContextRequest, isRecordingWorkspaceContext } from './recording-workspace.js';
import { isSourceRoot, isSourceJob, isSourceBinding, isSourceSelection, isSourceAction, isSourceConfirmation, isDraftSourceSnapshot } from './source-evidence.js';
import { isStartSourceCandidateScan, isSelectSourceCandidate, isSourceCandidateScan } from './source-candidates.js';
import { isMasterDraft, isMasterDraftSummary, isMasterDraftResult, isAppendMasterDraftRequest, isUpdateMasterDraftRequest } from './master-drafts.js';
import { isAlbumQuery, isDigitalAlbum, isDigitalAlbumDetail, isPhysicalLinksSnapshot, isPhysicalLinkHistoryEvent, isDigitalRuntime, isPhysicalLinkResult, isCollectionMatrixRow, isConfirmPhysicalLinkRequest, isLegacyConfirmPhysicalLinkRequest, isRelocateDigitalRequest, isRegisterDigitalRequest, isRemovePhysicalLinkRequest, isLegacyRemovePhysicalLinkRequest, isConfirmAbsenceRequest } from './physical-links.js';
import { isMusicId, isMusicFilter, isMusicEntry, isMusicDetail, isCommercialCopiesSnapshot, isMusicMutationResult, isSaveReleaseRequest, isMaterializeCommercialCopyRequest, isSaveCommercialCopyDetailsRequest, isAssignCommercialCopyPhotoRequest, isSaveLegacyRequest, isAddMusicPhotoRequest, isRemoveMusicPhotoRequest } from './physical-music.js';
import type { PublicError } from './errors.js';
import { isCollectionFilter, isCollectionPhotoImage, isCollectionAddPhotoRequest, isCollectionChangePhotoRequest, isCollectionId, isPhysicalId, isCollectionReceiveRequest, isCollectionMaterializeRequest, isCollectionUpdateCopyRequest, isCollectionPolicyRequest, isCollectionMutationResult, isCollectionModel, isCollectionPage, isCollectionDetail, isCollectionCopyDetail } from './collection.js';
import type {
  DailyRecommendationTrack,
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
import {
  LYRICS_STATUSES,
  LYRICS_TIMING_SOURCES,
  type LyricLine,
  type LyricWord,
  type LyricsSnapshot,
  type LocalLyricsMatchSnapshot,
  LOCAL_LYRICS_MATCH_STATUSES,
} from './lyrics.js';
import {
  PLAYBACK_ISSUE_CODES,
  MAX_PLAYBACK_QUEUE_ITEMS,
  PLAYBACK_QUALITY_LEVELS,
  PLAYBACK_QUALITY_PREFERENCES,
  PLAYBACK_SOURCE_PREFERENCES,
  type PlaybackQueueEntry,
  type PlaybackQueueRequestItem,
  type PlaybackQueueItem,
  type PlaybackQueueSnapshot,
  type PlaybackIssue,
  type PlaybackQuality,
  type PlaybackQualityPreference,
  type PlaybackResolvedSource,
  type PlaybackSourcePreference,
  type PlaybackSnapshot,
  type PlaybackStreamStamp,
  type PlaybackStreamSnapshot,
  type PlaybackEventProtocolAck,
} from './playback.js';
import {
  IPC_COMMANDS,
  IPC_EVENTS,
  IPC_VERSION,
  type IpcCommand,
  type IpcCommandResults,
  type IpcInternalCommand,
  type IpcInternalCommandResults,
  type IpcEventName,
  type IpcRuntimeMessage,
  type IpcResponse,
  type IpcRequest,
} from './ipc.js';
import type {
  PublicAccountProfile,
  PublicAccountState,
  PublicAuthState,
  PublicBridgeState,
  PublicRoonZone,
} from './state.js';
import type {
  DiagnosticComponentSnapshot,
  DiagnosticGateResult,
  DiagnosticTimelineEvent,
} from './diagnostics.js';
import type { FavoriteEntityDescriptor, FavoriteKind, FavoriteRecord } from './favorites.js';
import { MATCH_STATES, type PublicTrackMatchResult } from './matching.js';
import type { PublicAggregatedSearchResult } from './aggregated-search.js';
import { isValidRoonImageBinary, roonTrackIdFromReference } from './roon.js';

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: PublicError };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidRequest(): ValidationResult<never> {
  return {
    ok: false,
    error: {
      code: 'INVALID_IPC_REQUEST',
      message: 'Invalid IPC request',
    },
  };
}

function invalidResponse(): ValidationResult<never> {
  return {
    ok: false,
    error: {
      code: 'INVALID_IPC_RESPONSE',
      message: 'Invalid IPC response',
    },
  };
}

function safeString(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximumLength;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isEmptyPayload(value: unknown): value is Record<string, never> {
  return isRecord(value) && Object.keys(value).length === 0;
}

const MAX_PAGE_OFFSET = 1_000_000;
const MAX_PAGE_LIMIT = 100;
const MAX_SEARCH_QUERY_LENGTH = 100;
const MAX_LYRICS_LINES = 500;
const MAX_LYRICS_WORDS = 200;
const MAX_LYRICS_TEXT_LENGTH = 2_048;
const MAX_LYRICS_TOTAL_TEXT_LENGTH = 256 * 1024;
const MAX_ACCOUNT_DISPLAY_NAME_LENGTH = 80;
const MAX_RECOMMENDATION_TRACKS = 50;
const MAX_RECOMMENDATION_REASON_LENGTH = 120;
const FAVORITE_KINDS: readonly FavoriteKind[] = ['track', 'album', 'artist'];
const MAX_FAVORITE_TEXT_LENGTH = 512;

function isPageRequest(value: unknown): value is PageRequest {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['offset', 'limit']) &&
    typeof value.offset === 'number' &&
    Number.isSafeInteger(value.offset) &&
    value.offset >= 0 &&
    value.offset <= MAX_PAGE_OFFSET &&
    typeof value.limit === 'number' &&
    Number.isSafeInteger(value.limit) &&
    value.limit >= 1 &&
    value.limit <= MAX_PAGE_LIMIT
  );
}

function isLibrarySearchPayload(value: unknown): value is { query: string; page: PageRequest } {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['query', 'page']) &&
    safeString(value.query, MAX_SEARCH_QUERY_LENGTH) &&
    value.query.trim().length > 0 &&
    isPageRequest(value.page)
  );
}

function isTrackLikeStatusPayload(value: unknown): value is { trackId: string } {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['trackId']) &&
    safeString(value.trackId, 128) &&
    /^\d+$/.test(value.trackId) &&
    value.trackId !== '0'
  );
}

function isTrackLikePayload(value: unknown): value is { trackId: string; liked: boolean } {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['trackId', 'liked']) &&
    safeString(value.trackId, 128) &&
    /^\d+$/.test(value.trackId) &&
    value.trackId !== '0' &&
    typeof value.liked === 'boolean'
  );
}

function isTrackMatchPayload(value: unknown): value is { track: TrackSummary } {
  return isRecord(value) && hasOnlyKeys(value, ['track']) && isTrackSummary(value.track);
}

function isFavoriteDescriptor(value: unknown): value is FavoriteEntityDescriptor {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['kind', 'title', 'subtitle', 'artist', 'album', 'durationMs', 'trackNumber', 'discNumber', 'year', 'version']) ||
    !FAVORITE_KINDS.includes(value.kind as FavoriteKind) ||
    !safeString(value.title, MAX_FAVORITE_TEXT_LENGTH)
  ) return false;
  for (const key of ['subtitle', 'artist', 'album', 'version'] as const) {
    if (value[key] !== undefined && !safeString(value[key], MAX_FAVORITE_TEXT_LENGTH)) return false;
  }
  if (
    value.durationMs !== undefined &&
    (typeof value.durationMs !== 'number' || !Number.isSafeInteger(value.durationMs) || value.durationMs < 0 || value.durationMs > 24 * 60 * 60 * 1000)
  ) return false;
  for (const key of ['trackNumber', 'discNumber', 'year'] as const) {
    if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 9999)) return false;
  }
  return true;
}

function isFavoriteListPayload(value: unknown): value is { kind?: FavoriteKind; page: PageRequest } {
  return isRecord(value) && hasOnlyKeys(value, ['kind', 'page']) &&
    (value.kind === undefined || FAVORITE_KINDS.includes(value.kind as FavoriteKind)) &&
    isPageRequest(value.page);
}

function isFavoriteCheckPayload(value: unknown): value is { descriptor: FavoriteEntityDescriptor } {
  return isRecord(value) && hasOnlyKeys(value, ['descriptor']) && isFavoriteDescriptor(value.descriptor);
}

function isFavoriteSetPayload(value: unknown): value is { descriptor: FavoriteEntityDescriptor; favorite: boolean } {
  return isRecord(value) && hasOnlyKeys(value, ['descriptor', 'favorite']) &&
    isFavoriteDescriptor(value.descriptor) && typeof value.favorite === 'boolean';
}

function isLibraryPagePayload(value: unknown): value is { page: PageRequest } {
  return isRecord(value) && hasOnlyKeys(value, ['page']) && isPageRequest(value.page);
}

function isRoonLibraryReference(value: unknown): value is string {
  return safeString(value, 128) && /^musicbridge-v2-(?:entity|image)-[0-9a-f-]{36}$/u.test(value);
}

function isRoonAlbumPayload(value: unknown): value is { reference: string; page: PageRequest } {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['reference', 'page']) &&
    isRoonLibraryReference(value.reference) &&
    isPageRequest(value.page)
  );
}

function isRoonImageOptions(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value) || !hasOnlyKeys(value, ['scale', 'width', 'height', 'format'])) return false;
  return (
    (value.scale === undefined || ['fit', 'fill', 'stretch'].includes(String(value.scale))) &&
    (value.format === undefined || ['image/jpeg', 'image/png'].includes(String(value.format))) &&
    (value.width === undefined || (
      typeof value.width === 'number' && Number.isSafeInteger(value.width) && value.width >= 1 && value.width <= 2048
    )) &&
    (value.height === undefined || (
      typeof value.height === 'number' && Number.isSafeInteger(value.height) && value.height >= 1 && value.height <= 2048
    ))
  );
}

function isRoonImagePayload(value: unknown): value is { reference: string; options?: Record<string, unknown> } {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['reference', 'options']) &&
    isRoonLibraryReference(value.reference) &&
    isRoonImageOptions(value.options)
  );
}

function isRoonTrackActionPayload(value: unknown, allowQueue = false): value is { reference: string; zoneId: string } {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, allowQueue ? ['reference', 'zoneId', 'queueReferences', 'contextHandle'] : ['reference', 'zoneId']) &&
    safeString(value.reference, 128) &&
    /^musicbridge-v2-entity-[0-9a-f-]{36}$/u.test(value.reference) &&
    safeString(value.zoneId, 128) &&
    (value.contextHandle === undefined || (typeof value.contextHandle === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value.contextHandle) && value.queueReferences === undefined)) &&
    (value.queueReferences === undefined || (
      Array.isArray(value.queueReferences) && value.queueReferences.length > 0 &&
      value.queueReferences.length <= MAX_PLAYBACK_QUEUE_ITEMS &&
      new Set(value.queueReferences).size === value.queueReferences.length &&
      value.queueReferences.includes(value.reference) &&
      value.queueReferences.every((reference) => typeof reference === 'string' &&
        /^musicbridge-v2-entity-[0-9a-f-]{36}$/u.test(reference))
    ))
  );
}

function isLibraryPlaylistPayload(
  value: unknown,
): value is { playlistId: string; page: PageRequest } {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['playlistId', 'page']) &&
    safeString(value.playlistId, 128) &&
    /^\d+$/.test(value.playlistId) &&
    value.playlistId !== '0' &&
    isPageRequest(value.page)
  );
}

function isLibraryArtistPayload(value: unknown): value is { artistId: string; page: PageRequest } {
  return isRecord(value) && hasOnlyKeys(value, ['artistId', 'page']) && safeString(value.artistId, 128) && /^\d+$/.test(value.artistId) && value.artistId !== '0' && isPageRequest(value.page);
}

function isLibraryAlbumPayload(value: unknown): value is { albumId: string; page: PageRequest } {
  return isRecord(value) && hasOnlyKeys(value, ['albumId', 'page']) && safeString(value.albumId, 128) && /^\d+$/.test(value.albumId) && value.albumId !== '0' && isPageRequest(value.page);
}

function isSelectZonePayload(value: unknown): value is { zoneId: string } {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['zoneId']) &&
    safeString(value.zoneId, 128)
  );
}

const MAX_QUEUE_ITEMS = MAX_PLAYBACK_QUEUE_ITEMS;

function isPlaybackQuality(value: unknown): value is PlaybackQuality {
  return PLAYBACK_QUALITY_LEVELS.includes(value as PlaybackQuality);
}

function isPlaybackQualityPreference(value: unknown): value is PlaybackQualityPreference {
  return PLAYBACK_QUALITY_PREFERENCES.includes(value as PlaybackQualityPreference);
}

function isPlaybackSourcePreference(value: unknown): value is PlaybackSourcePreference {
  return PLAYBACK_SOURCE_PREFERENCES.includes(value as PlaybackSourcePreference);
}

function isPlaybackResolvedSource(value: unknown): value is PlaybackResolvedSource {
  return value === 'roon' || value === 'netease' || value === 'local_file';
}

function isPlaybackSeekPayload(value: unknown): value is { positionMs: number } {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['positionMs']) &&
    typeof value.positionMs === 'number' &&
    Number.isSafeInteger(value.positionMs) &&
    value.positionMs >= 0 &&
    value.positionMs <= 24 * 60 * 60 * 1_000
  );
}

function isPlaybackQueueIndexPayload(value: unknown): value is { index: number } {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['index']) &&
    typeof value.index === 'number' &&
    Number.isSafeInteger(value.index) &&
    value.index >= 0 &&
    value.index < MAX_QUEUE_ITEMS
  );
}

function isPlaybackQueueRequestItem(value: unknown): value is PlaybackQueueRequestItem {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['trackId', 'qualityPreference', 'preferredSource']) &&
    safeString(value.trackId, 128) &&
    /^\d+$/.test(value.trackId) &&
    value.trackId !== '0' &&
    isPlaybackQualityPreference(value.qualityPreference) &&
    (value.preferredSource === undefined || isPlaybackSourcePreference(value.preferredSource))
  );
}

function isPlaybackQueueEntry(value: unknown): value is PlaybackQueueEntry {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'trackId',
      'entryId',
      'edition',
      'preflight',
      'local',
      'qualityPreference',
      'track',
      'preferredSource',
      'resolvedSource',
      'requestedQuality',
      'actualQuality',
      'roonItem',
    ]) &&
    (value.entryId === undefined || isCollectionId(value.entryId)) &&
    (value.edition === undefined || isAlbumEdition(value.edition)) &&
    (value.preflight === undefined || isRecord(value.preflight) && hasOnlyKeys(value.preflight,['state','reason']) && ['NEEDS_REVALIDATION','PREPARED','FAILED'].includes(String(value.preflight.state)) && (value.preflight.reason===null || ['SOURCE_UNAVAILABLE','SEGMENT_UNSUPPORTED','UNSUPPORTED_NATIVE_RESTORE'].includes(String(value.preflight.reason)))) &&
    safeString(value.trackId, 128) &&
    (value.resolvedSource === 'local_file' ? isLocalQueueIdentity(value.local) && value.local.local_track_id === value.trackId : (value.trackId==='0' && value.preferredSource==='roon' && isRecord(value.preflight) && value.preflight.reason==='UNSUPPORTED_NATIVE_RESTORE' || /^\d+$/.test(value.trackId) && value.trackId !== '0') && value.local === undefined) &&
    isPlaybackQualityPreference(value.qualityPreference) &&
    (value.track === undefined || isTrackSummary(value.track, value.resolvedSource === 'local_file' && isLocalQueueIdentity(value.local) ? value.local.local_track_id : undefined)) &&
    (value.preferredSource === undefined || isPlaybackSourcePreference(value.preferredSource)) &&
    (value.resolvedSource === undefined || isPlaybackResolvedSource(value.resolvedSource)) &&
    (value.requestedQuality === undefined || isPlaybackQuality(value.requestedQuality)) &&
    (value.actualQuality === undefined || isPlaybackQuality(value.actualQuality) || value.actualQuality === 'unknown') &&
    (value.roonItem === undefined || isQueueRoonItem(value.roonItem, value.trackId, value.preferredSource))
  );
}

function isQueueRoonItem(item: unknown, trackId: unknown, preferredSource: unknown): boolean {
  if (!isRecord(item) || !isRoonLibraryItem(item) || item.kind !== 'track' || preferredSource !== 'roon') return false;
  try { return roonTrackIdFromReference(String(item.reference)) === trackId; } catch { return false; }
}

function isQueueContext(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, ['beforeComplete', 'afterComplete', 'loading', 'error']) &&
    typeof value.beforeComplete === 'boolean' && typeof value.afterComplete === 'boolean' &&
    typeof value.loading === 'boolean' && (value.error === undefined || typeof value.error === 'string' && ['retryable', 'expired', 'capacity'].includes(value.error));
}

function isPlaybackQueueSnapshot(value: unknown): value is PlaybackQueueSnapshot {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['queueId','revision','persistence','items', 'index', 'hasNext', 'hasPrevious', 'context']) ||
    (value.queueId !== undefined && !isCollectionId(value.queueId)) ||
    (value.revision !== undefined && !isLocalExactInteger(value.revision)) ||
    (value.persistence !== undefined && !['SAVED','UNAVAILABLE','NEEDS_REVALIDATION'].includes(String(value.persistence))) ||
    !Array.isArray(value.items) ||
    value.items.length > MAX_QUEUE_ITEMS ||
    !value.items.every((item) => isPlaybackQueueEntry(item)) ||
    typeof value.index !== 'number' ||
    !Number.isSafeInteger(value.index) ||
    value.index < -1 ||
    (value.items.length === 0 ? value.index !== -1 : value.index >= value.items.length) ||
    typeof value.hasNext !== 'boolean' ||
    typeof value.hasPrevious !== 'boolean' ||
    (value.context !== undefined && !isQueueContext(value.context))
  ) {
    return false;
  }
  return true;
}

function isPlaybackState(value: unknown): value is PlaybackSnapshot['state'] {
  return typeof value === 'string' && ['idle', 'resolving', 'preparing', 'playing', 'pausing', 'paused', 'resuming', 'stopping', 'error'].includes(value);
}

const PLAYBACK_RECOVERY_ACTIONS = new Set([
  'reauthenticate',
  'retry',
  'select_zone',
  'restart_core',
  'none',
]);

function isPlaybackIssue(value: unknown): value is PlaybackIssue {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['code', 'message', 'retryable', 'diagnosticId', 'action']) &&
    PLAYBACK_ISSUE_CODES.includes(value.code as PlaybackIssue['code']) &&
    safeString(value.message, 512) &&
    typeof value.retryable === 'boolean' &&
    safeString(value.diagnosticId, 128) &&
    (value.action === undefined || typeof value.action === 'string' && PLAYBACK_RECOVERY_ACTIONS.has(value.action))
  );
}

function isPlaybackSnapshot(value: unknown): value is PlaybackSnapshot {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'state',
      'local',
      'queue',
      'currentTrack',
      'source',
      'qualityPreference',
      'requestedQuality',
      'actualQuality',
      'positionMs',
      'format',
      'bitrate',
      'selectedZoneId',
      'lastError',
      'lastIssue',
      'qualityNotice',
      'canNext',
      'canPrevious',
      'canStop',
      'canPause',
      'canResume',
      'stream',
    ]) ||
    !isPlaybackState(value.state) ||
    (value.local !== undefined && !isLocalPlaybackObservationLeaf(value.local)) ||
    (value.source === 'local_file' && (!isLocalPlaybackObservationLeaf(value.local) || !isTrackSummary(value.currentTrack,value.local.local_track_id) || value.currentTrack.id !== value.local.local_track_id)) ||
    !isPlaybackQueueSnapshot(value.queue) ||
    (value.currentTrack !== undefined && !isTrackSummary(value.currentTrack,value.source === 'local_file' && isLocalPlaybackObservationLeaf(value.local) ? value.local.local_track_id : undefined)) ||
    (value.source !== undefined && !isPlaybackResolvedSource(value.source)) ||
    (value.qualityPreference !== undefined && !isPlaybackQualityPreference(value.qualityPreference)) ||
    (value.requestedQuality !== undefined && !isPlaybackQuality(value.requestedQuality)) ||
    (value.actualQuality !== undefined && !isPlaybackQuality(value.actualQuality) && value.actualQuality !== 'unknown') ||
    (typeof value.positionMs !== 'number' ||
      !Number.isSafeInteger(value.positionMs) ||
      value.positionMs < 0 ||
      value.positionMs > 24 * 60 * 60 * 1000) ||
    (value.format !== undefined && !safeString(value.format, 32)) ||
    (value.bitrate !== undefined &&
      (typeof value.bitrate !== 'number' ||
        !Number.isSafeInteger(value.bitrate) ||
        value.bitrate < 0 ||
        value.bitrate > 10_000_000)) ||
    (value.selectedZoneId !== undefined && !safeString(value.selectedZoneId, 128)) ||
    (value.lastError !== undefined && !safeString(value.lastError, 128)) ||
    (value.lastIssue !== undefined && !isPlaybackIssue(value.lastIssue)) ||
    (value.qualityNotice !== undefined && !isPlaybackIssue(value.qualityNotice)) ||
    typeof value.canNext !== 'boolean' ||
    typeof value.canPrevious !== 'boolean' ||
    typeof value.canStop !== 'boolean' ||
    typeof value.canPause !== 'boolean' ||
    typeof value.canResume !== 'boolean'
  ) {
    return false;
  }
  return value.stream === undefined || isPlaybackStreamStamp(value.stream) && matchesPlaybackStamp(value.stream, value);
}

function isStreamInteger(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

export function isPlaybackEventProtocolAck(value: unknown): value is PlaybackEventProtocolAck {
  return isRecord(value) && hasOnlyKeys(value, ['protocol', 'coreInstanceId']) &&
    value.protocol === 'compact-v1' && typeof value.coreInstanceId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value.coreInstanceId);
}

export function isPlaybackStreamStamp(value: unknown): value is PlaybackStreamStamp {
  return isRecord(value) && hasOnlyKeys(value, ['coreInstanceId', 'generation', 'sequence', 'queueRevision', 'selectedZoneId', 'trackId', 'source']) &&
    typeof value.coreInstanceId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value.coreInstanceId) &&
    isStreamInteger(value.generation, 0) && isStreamInteger(value.sequence, 1) && isStreamInteger(value.queueRevision, 1) &&
    (value.selectedZoneId === null || safeString(value.selectedZoneId, 128)) &&
    (value.trackId === null || safeString(value.trackId, 128)) &&
    (value.source === null || typeof value.source === 'string' && isPlaybackResolvedSource(value.source));
}

function matchesPlaybackStamp(stamp: PlaybackStreamStamp, snapshot: Record<string, unknown>): boolean {
  const track = snapshot.currentTrack;
  return stamp.selectedZoneId === (snapshot.selectedZoneId ?? null) &&
    stamp.trackId === (isRecord(track) ? track.id : null) && stamp.source === (snapshot.source ?? null);
}

export function isPlaybackStreamSnapshot(value: unknown): value is PlaybackStreamSnapshot {
  return isRecord(value) && hasOnlyKeys(value, ['stamp', 'snapshot']) &&
    isPlaybackStreamStamp(value.stamp) && isRecord(value.snapshot) && !Object.hasOwn(value.snapshot, 'stream') &&
    isPlaybackSnapshot(value.snapshot) && matchesPlaybackStamp(value.stamp, value.snapshot);
}

function isPlaybackStreamState(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ['stamp', 'state', 'queue']) ||
    !isPlaybackStreamStamp(value.stamp) || !isRecord(value.state) || Object.hasOwn(value.state, 'queue') || Object.hasOwn(value.state, 'stream')) return false;
  // 复用完整状态保护；只添加固定空队列，不遍历事件之外的任何队列。
  return isPlaybackSnapshot({ ...value.state, queue: { items: [], index: -1, hasNext: false, hasPrevious: false } }) &&
    matchesPlaybackStamp(value.stamp, value.state) &&
    (value.queue === undefined || isPlaybackQueueSnapshot(value.queue));
}

function isPlaybackStreamProgress(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, ['stamp', 'positionMs']) && isPlaybackStreamStamp(value.stamp) &&
    isStreamInteger(value.positionMs, 0) && value.positionMs <= 86_400_000;
}

function isPlaybackPlayPayload(
  value: unknown,
): value is {
  trackId: string;
  qualityPreference: PlaybackQualityPreference;
  rendererClickAtMs?: number;
} {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['trackId', 'qualityPreference', 'rendererClickAtMs']) &&
    safeString(value.trackId, 128) &&
    /^\d+$/.test(value.trackId) &&
    value.trackId !== '0' &&
    isPlaybackQualityPreference(value.qualityPreference) &&
    (
      value.rendererClickAtMs === undefined ||
      (
        typeof value.rendererClickAtMs === 'number' &&
        Number.isSafeInteger(value.rendererClickAtMs) &&
        value.rendererClickAtMs > 0
      )
    )
  );
}

function isPlaybackReplaceQueuePayload(
  value: unknown,
): value is { items: readonly PlaybackQueueRequestItem[]; index: number } {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['items', 'index']) &&
    Array.isArray(value.items) &&
    value.items.length > 0 &&
    value.items.length <= MAX_QUEUE_ITEMS &&
    value.items.every((item) => isPlaybackQueueRequestItem(item)) &&
    typeof value.index === 'number' &&
    Number.isSafeInteger(value.index) &&
    value.index >= 0 &&
    value.index < value.items.length
  );
}

function isPlaybackQueueMutationPayload(
  value: unknown,
): value is { items: readonly PlaybackQueueRequestItem[] } {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['items']) &&
    Array.isArray(value.items) &&
    value.items.length > 0 &&
    value.items.length <= MAX_QUEUE_ITEMS &&
    value.items.every((item) => isPlaybackQueueRequestItem(item))
  );
}

function isLyricWord(value: unknown): value is LyricWord {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['startMs', 'endMs', 'text']) &&
    typeof value.startMs === 'number' &&
    Number.isSafeInteger(value.startMs) &&
    value.startMs >= 0 &&
    value.startMs <= 24 * 60 * 60 * 1000 &&
    typeof value.endMs === 'number' &&
    Number.isSafeInteger(value.endMs) &&
    value.endMs > value.startMs &&
    value.endMs <= 24 * 60 * 60 * 1000 &&
    safeString(value.text, MAX_LYRICS_TEXT_LENGTH)
  );
}

function isLyricLine(value: unknown): value is LyricLine {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'startMs',
      'endMs',
      'text',
      'translation',
      'romanization',
      'words',
    ]) &&
    typeof value.startMs === 'number' &&
    Number.isSafeInteger(value.startMs) &&
    value.startMs >= 0 &&
    value.startMs <= 24 * 60 * 60 * 1000 &&
    (value.endMs === undefined ||
      (typeof value.endMs === 'number' &&
        Number.isSafeInteger(value.endMs) &&
        value.endMs > value.startMs &&
        value.endMs <= 24 * 60 * 60 * 1000)) &&
    safeString(value.text, MAX_LYRICS_TEXT_LENGTH) &&
    (value.translation === undefined || safeString(value.translation, MAX_LYRICS_TEXT_LENGTH)) &&
    (value.romanization === undefined || safeString(value.romanization, MAX_LYRICS_TEXT_LENGTH)) &&
    (value.words === undefined ||
      (Array.isArray(value.words) &&
        value.words.length > 0 &&
        value.words.length <= MAX_LYRICS_WORDS &&
        value.words.every((word) => isLyricWord(word))))
  );
}

function isLyricsSnapshot(value: unknown): value is LyricsSnapshot {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'status',
      'lines',
      'activeLineIndex',
      'activeWordIndex',
      'timingSource',
      'source',
    ]) ||
    !LYRICS_STATUSES.includes(value.status as (typeof LYRICS_STATUSES)[number]) ||
    !Array.isArray(value.lines) ||
    value.lines.length > MAX_LYRICS_LINES ||
    !value.lines.every((line) => isLyricLine(line)) ||
    typeof value.activeLineIndex !== 'number' ||
    !Number.isSafeInteger(value.activeLineIndex) ||
    value.activeLineIndex < -1 ||
    value.activeLineIndex >= value.lines.length ||
    !LYRICS_TIMING_SOURCES.includes(
      value.timingSource as (typeof LYRICS_TIMING_SOURCES)[number],
    ) ||
    (value.source !== undefined && value.source !== 'roon-display' && (
      value.source !== 'netease'
      || (value.status !== 'ready' && value.status !== 'instrumental')
    ))
  ) {
    return false;
  }

  const totalTextLength = value.lines.reduce((total, line) => {
    const words = Array.isArray(line.words)
      ? line.words.reduce((wordTotal, word) => wordTotal + word.text.length, 0)
      : 0;
    return total + line.text.length + (line.translation?.length ?? 0) +
      (line.romanization?.length ?? 0) + words;
  }, 0);
  if (totalTextLength > MAX_LYRICS_TOTAL_TEXT_LENGTH) return false;

  if (
    value.activeWordIndex !== undefined &&
    (typeof value.activeWordIndex !== 'number' ||
      !Number.isSafeInteger(value.activeWordIndex) ||
      value.activeWordIndex < -1)
  ) {
    return false;
  }
  if (value.activeWordIndex !== undefined && value.activeWordIndex >= 0) {
    const activeLine = value.lines[value.activeLineIndex];
    if (!activeLine?.words || value.activeWordIndex >= activeLine.words.length) return false;
  }
  return true;
}

const OPAQUE_LYRICS_MATCH_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/u;

function isLocalLyricsMatchCandidate(value: unknown): boolean {
  return isRecord(value)
    && hasOnlyKeys(value, ['candidateId', 'title', 'artists', 'album', 'durationMs'])
    && typeof value.candidateId === 'string'
    && OPAQUE_LYRICS_MATCH_ID.test(value.candidateId)
    && safeString(value.title, 512)
    && value.title.trim().length > 0
    && Array.isArray(value.artists)
    && value.artists.length > 0
    && value.artists.length <= 64
    && value.artists.every((artist) => safeString(artist, 512) && artist.trim().length > 0)
    && (value.album === undefined || safeString(value.album, 512))
    && (value.durationMs === undefined || (
      Number.isSafeInteger(value.durationMs)
      && Number(value.durationMs) >= 0
      && Number(value.durationMs) <= 24 * 60 * 60 * 1_000
    ));
}

function isLocalLyricsMatchSnapshot(value: unknown): value is LocalLyricsMatchSnapshot {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['status', 'candidates', 'canRevoke', 'matchSessionId'])
    || !LOCAL_LYRICS_MATCH_STATUSES.includes(value.status as (typeof LOCAL_LYRICS_MATCH_STATUSES)[number])
    || !Array.isArray(value.candidates)
    || value.candidates.length > 20
    || !value.candidates.every(isLocalLyricsMatchCandidate)
    || typeof value.canRevoke !== 'boolean'
    || (value.matchSessionId !== undefined && (
      typeof value.matchSessionId !== 'string' || !OPAQUE_LYRICS_MATCH_ID.test(value.matchSessionId)
    ))) return false;
  if (value.status === 'needs-choice') {
    return value.candidates.length > 0 && value.matchSessionId !== undefined && value.canRevoke === false;
  }
  return value.candidates.length === 0 && value.matchSessionId === undefined;
}

function isLyricsPayload(value: unknown): value is { trackId: string } {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['trackId']) &&
    safeString(value.trackId, 128) &&
    /^\d+$/.test(value.trackId) &&
    value.trackId !== '0'
  );
}

function isLyricsMatchSelectionPayload(value: unknown): boolean {
  return isRecord(value)
    && hasOnlyKeys(value, ['matchSessionId', 'candidateId'])
    && typeof value.matchSessionId === 'string'
    && OPAQUE_LYRICS_MATCH_ID.test(value.matchSessionId)
    && typeof value.candidateId === 'string'
    && OPAQUE_LYRICS_MATCH_ID.test(value.candidateId);
}

function isSetCredentialPayload(value: unknown): value is { credential: string } {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['credential']) &&
    safeString(value.credential, 64 * 1024)
  );
}

function isChallengePayload(value: unknown): value is { challengeId: string } {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['challengeId']) &&
    safeString(value.challengeId, 128)
  );
}

function isArtworkUrl(value: unknown): value is string {
  if (!safeString(value, 2_048)) return false;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return (
      url.protocol === 'https:' &&
      (hostname === 'music.126.net' || hostname.endsWith('.music.126.net')) &&
      url.username === '' &&
      url.password === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

function isTrackSummary(value: unknown, localId?: string): value is TrackSummary {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'id',
    'title',
    'artists',
    'album',
    'durationMs',
    'version',
    'bitrate',
    'format',
    'artworkUrl',
    'artworkReference',
  ])) {
    return false;
  }
  return (
    safeString(value.id, 128) &&
    (localId !== undefined ? value.id === localId : /^\d+$/.test(value.id) && value.id !== '0') &&
    safeString(value.title, 512) &&
    Array.isArray(value.artists) &&
    value.artists.length <= 64 &&
    value.artists.every((artist) => safeString(artist, 256)) &&
    (safeString(value.album, 512) || localId !== undefined && value.album === '') &&
    (value.durationMs === undefined ||
      (typeof value.durationMs === 'number' &&
        Number.isSafeInteger(value.durationMs) &&
        value.durationMs >= 0 &&
        value.durationMs <= 24 * 60 * 60 * 1000)) &&
    (value.version === undefined || safeString(value.version, 256)) &&
    (value.bitrate === undefined || (typeof value.bitrate === 'number' && Number.isSafeInteger(value.bitrate) && value.bitrate > 0 && value.bitrate <= 10_000_000)) &&
    (value.format === undefined || safeString(value.format, 64)) &&
    (value.artworkUrl === undefined || isArtworkUrl(value.artworkUrl)) &&
    (value.artworkReference === undefined ||
      /^musicbridge-v2-image-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(String(value.artworkReference)))
  );
}

function isArtistSummary(value: unknown): value is ArtistSummary {
  if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'name', 'artworkUrl', 'albumCount', 'trackCount'])) return false
  return (
    safeString(value.id, 128) &&
    /^\d+$/.test(value.id) &&
    value.id !== '0' &&
    safeString(value.name, 512) &&
    (value.artworkUrl === undefined || isArtworkUrl(value.artworkUrl)) &&
    (value.albumCount === undefined || (typeof value.albumCount === 'number' && Number.isSafeInteger(value.albumCount) && value.albumCount >= 0 && value.albumCount <= MAX_PAGE_OFFSET)) &&
    (value.trackCount === undefined || (typeof value.trackCount === 'number' && Number.isSafeInteger(value.trackCount) && value.trackCount >= 0 && value.trackCount <= MAX_PAGE_OFFSET))
  )
}

function isAlbumSummary(value: unknown): value is AlbumSummary {
  if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'name', 'artistId', 'artistName', 'artworkUrl', 'trackCount'])) return false
  return (
    safeString(value.id, 128) &&
    /^\d+$/.test(value.id) &&
    value.id !== '0' &&
    safeString(value.name, 512) &&
    (value.artistId === undefined || (safeString(value.artistId, 128) && /^\d+$/.test(value.artistId) && value.artistId !== '0')) &&
    safeString(value.artistName, 512) &&
    (value.artworkUrl === undefined || isArtworkUrl(value.artworkUrl)) &&
    (value.trackCount === undefined || (typeof value.trackCount === 'number' && Number.isSafeInteger(value.trackCount) && value.trackCount >= 0 && value.trackCount <= MAX_PAGE_OFFSET))
  )
}

function isDailyRecommendationTrack(value: unknown): value is DailyRecommendationTrack {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'id',
    'title',
    'artists',
    'album',
    'durationMs',
    'artworkUrl',
    'recommendationReason',
  ])) {
    return false;
  }
  const { recommendationReason, ...summary } = value;
  return (
    isTrackSummary(summary) &&
    (recommendationReason === undefined || safeString(recommendationReason, MAX_RECOMMENDATION_REASON_LENGTH))
  );
}

function isDailyRecommendationsSnapshot(value: unknown): value is DailyRecommendationsSnapshot {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['dayKey', 'tracks']) &&
    typeof value.dayKey === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value.dayKey) &&
    Array.isArray(value.tracks) &&
    value.tracks.length <= MAX_RECOMMENDATION_TRACKS &&
    value.tracks.every((track) => isDailyRecommendationTrack(track))
  );
}

function isPageOfTracks(value: unknown): value is Page<TrackSummary> {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['items', 'offset', 'limit', 'total', 'hasMore']) &&
    isPageRequest({ offset: value.offset, limit: value.limit }) &&
    Array.isArray(value.items) &&
    value.items.length <= MAX_PAGE_LIMIT &&
    value.items.every((item) => isTrackSummary(item)) &&
    typeof value.total === 'number' &&
    Number.isSafeInteger(value.total) &&
    value.total >= 0 &&
    value.total <= MAX_PAGE_OFFSET &&
    typeof value.hasMore === 'boolean'
  );
}

function isPageOfArtists(value: unknown): value is Page<ArtistSummary> {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['items', 'offset', 'limit', 'total', 'hasMore']) &&
    isPageRequest({ offset: value.offset, limit: value.limit }) &&
    Array.isArray(value.items) &&
    value.items.length <= MAX_PAGE_LIMIT &&
    value.items.every((item) => isArtistSummary(item)) &&
    typeof value.total === 'number' &&
    Number.isSafeInteger(value.total) &&
    value.total >= 0 &&
    value.total <= MAX_PAGE_OFFSET &&
    typeof value.hasMore === 'boolean'
  )
}

function isPageOfAlbums(value: unknown): value is Page<AlbumSummary> {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['items', 'offset', 'limit', 'total', 'hasMore']) &&
    isPageRequest({ offset: value.offset, limit: value.limit }) &&
    Array.isArray(value.items) &&
    value.items.length <= MAX_PAGE_LIMIT &&
    value.items.every((item) => isAlbumSummary(item)) &&
    typeof value.total === 'number' &&
    Number.isSafeInteger(value.total) &&
    value.total >= 0 &&
    value.total <= MAX_PAGE_OFFSET &&
    typeof value.hasMore === 'boolean'
  )
}

function isArtistDetail(value: unknown): value is ArtistDetail {
  if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'name', 'artworkUrl', 'albumCount', 'trackCount', 'tracks'])) return false;
  return isArtistSummary({
    id: value.id,
    name: value.name,
    ...(value.artworkUrl !== undefined ? { artworkUrl: value.artworkUrl } : {}),
    ...(value.albumCount !== undefined ? { albumCount: value.albumCount } : {}),
    ...(value.trackCount !== undefined ? { trackCount: value.trackCount } : {}),
  }) && isPageOfTracks(value.tracks);
}

function isAlbumDetail(value: unknown): value is AlbumDetail {
  if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'name', 'artistId', 'artistName', 'artworkUrl', 'trackCount', 'tracks'])) return false;
  return isAlbumSummary({
    id: value.id,
    name: value.name,
    ...(value.artistId !== undefined ? { artistId: value.artistId } : {}),
    artistName: value.artistName,
    ...(value.artworkUrl !== undefined ? { artworkUrl: value.artworkUrl } : {}),
    ...(value.trackCount !== undefined ? { trackCount: value.trackCount } : {}),
  }) && isPageOfTracks(value.tracks);
}

function isPlaylistSummary(value: unknown): value is PlaylistSummary {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['id', 'name', 'trackCount', 'artworkUrl']) &&
    safeString(value.id, 128) &&
    /^\d+$/.test(value.id) &&
    value.id !== '0' &&
    safeString(value.name, 512) &&
    typeof value.trackCount === 'number' &&
    Number.isSafeInteger(value.trackCount) &&
    value.trackCount >= 0 &&
    value.trackCount <= MAX_PAGE_OFFSET &&
    (value.artworkUrl === undefined || isArtworkUrl(value.artworkUrl))
  );
}

function isPlaylistDetail(value: unknown): value is PlaylistDetail {
  const summary = isRecord(value)
    ? {
        id: value.id,
        name: value.name,
        trackCount: value.trackCount,
        ...(value.artworkUrl !== undefined ? { artworkUrl: value.artworkUrl } : {}),
      }
    : undefined;
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['id', 'name', 'trackCount', 'artworkUrl', 'description', 'tracks', 'snapshotVersion']) &&
    summary !== undefined &&
    isPlaylistSummary(summary) &&
    (value.description === undefined || safeString(value.description, 4_096)) &&
    (value.snapshotVersion === undefined || typeof value.snapshotVersion === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.snapshotVersion)) &&
    isPageOfTracks(value.tracks)
  );
}

function isValidCommandPayload(command: IpcCommand, payload: unknown): boolean {
  if (isLocalSourceWritesCommand(command)) return isLocalSourceWritesCommandPayload(command, payload);
  if (isLocalRelocationPlanCommand(command)) return isLocalRelocationPlanCommandPayload(command, payload);
  if (isLocalArtworkCommand(command)) return isLocalArtworkCommandPayload(command,payload);
  if (isLocalRelocationCommand(command)) return isLocalRelocationCommandPayload(command,payload);
  if (isLocalScanCommand(command)) return isLocalScanCommandPayload(command, payload);
  if (command === 'localCatalog.prepare') return isLocalPlayRequest(payload);
  if (command === 'playback.localTarget') return isRecord(payload) && Reflect.ownKeys(payload).length === 0;
  if (isLocalLegacyLinksCommand(command)) return isLocalLegacyLinksCommandPayload(command, payload);
  if (isLocalOrganizerCommand(command)) return isLocalOrganizerCommandPayload(command, payload);
  if (isLocalCatalogCommand(command)) return isLocalCatalogCommandPayload(command, payload);
  if (command === 'collectionProgress.wants') return isListWantEntriesRequest(payload);
  if (command === 'collectionProgress.saveWant') return isSaveWantEntryRequest(payload);
  if (command === 'collectionProgress.cancelWant') return isCancelWantEntryRequest(payload);
  if (command === 'collectionProgress.wantHistory') return isGetWantEntryHistoryRequest(payload);
  if (command === 'collectionProgress.current') return isGetCollectionProgressRequest(payload);
  if (command === 'collectionProgress.capture') return isCaptureCollectionProgressRequest(payload);
  if (command === 'collectionProgress.snapshots') return isListCollectionProgressSnapshotsRequest(payload);
  if (command === 'collectionProgress.snapshot') return isGetCollectionProgressSnapshotRequest(payload);
  if (command === 'collectionProgress.modelLengths') return isGetCollectionModelLengthsRequest(payload);
  if (command === 'spreadsheetImports.sources') return isSpreadsheetPageRequest(payload);
  if (command === 'spreadsheetImports.source') return isSpreadsheetIdRequest(payload);
  if (command === 'spreadsheetImports.sourceRows') return isSpreadsheetSourceRowsRequest(payload);
  if (command === 'spreadsheetImports.preview') return isPreviewSpreadsheetImportRequest(payload);
  if (command === 'spreadsheetImports.apply') return isApplySpreadsheetImportRequest(payload);
  if (command === 'spreadsheetImports.revision') return isSpreadsheetImportRevisionRequest(payload);
  if (command === 'spreadsheetImports.history') return isSpreadsheetPageRequest(payload);
  if (command === 'spreadsheetImports.adjustmentPreview') return isSpreadsheetAdjustmentPreviewRequest(payload);
  if (command === 'spreadsheetImports.adjust') return isAdjustSpreadsheetInventoryRequest(payload);
  if (command === 'spreadsheetImports.adjustments') return isSpreadsheetAdjustmentsRequest(payload);
  if (command === 'spreadsheetImports.registerWorkbook') return isRegisterSpreadsheetWorkbookRequest(payload);
  if (command === 'spreadsheetImports.workbookReceipt') return isChooseSpreadsheetWorkbookRequest(payload);
  if (command === 'recordingBackups.activationReceipt') return isActivateRestoredDataset(payload);
  if (command === 'commandOutbox.context') return isEmptyPayload(payload);
  if (command === 'commandOutbox.execute') return isCommandOutboxExecute(payload);
  if (command === 'referenceCatalog.registerSource') return isRegisterReferenceSourceRequest(payload);
  if (command === 'referenceCatalog.previewSourceZip') return isPreviewReferenceSourceZipRequest(payload);
  if (command === 'referenceCatalog.registerSourceZip') return isRegisterReferenceSourceZipRequest(payload);
  if (command === 'referenceCatalog.sourceZipReceipts') return isReferenceSourceZipReceiptListRequest(payload);
  if (command === 'referenceCatalog.sources') return isReferenceSourceListRequest(payload);
  if (command === 'referenceCatalog.source' || command === 'referenceCatalog.revision' || command === 'referenceCatalog.snapshot') return isCatalogIdRequest(payload);
  if (command === 'referenceCatalog.previewRevision') return isPreviewCatalogRevisionRequest(payload);
  if (command === 'referenceCatalog.publishRevision') return isPublishCatalogRevisionRequest(payload);
  if (command === 'referenceCatalog.setMatch') return isSetCatalogMatchRequest(payload);
  if (command === 'referenceCatalog.history') return isCatalogHistoryRequest(payload);
  if (command === 'recordingSources.roots') return isRecord(payload) && hasOnlyKeys(payload, []);
  if (command === 'recordingSources.rootReceipt') return isRecord(payload) && hasOnlyKeys(payload, ['commandId']) && isCollectionId(payload.commandId);
  if (command === 'recordingSources.authorize') return isRecord(payload) && hasOnlyKeys(payload, ['commandId', 'absolutePath']) && isCollectionId(payload.commandId) && isSourcePrivatePath(payload.absolutePath);
  if (command === 'recordingSources.start') return isRecord(payload) && hasOnlyKeys(payload, ['selection', 'absolutePath']) && isSourceSelection(payload.selection) && isSourcePrivatePath(payload.absolutePath);
  if (command === 'recordingSources.context' || command === 'recordingSources.job') return isRecord(payload) && hasOnlyKeys(payload, ['id']) && isCollectionId(payload.id);
  if (command === 'recordingSources.snapshot') return isRecord(payload) && hasOnlyKeys(payload, ['draftId']) && isCollectionId(payload.draftId);
  if (command === 'recordingSources.revoke' || command === 'recordingSources.cancel') return isSourceAction(payload);
  if (command === 'recordingSources.confirm' || command === 'recordingSources.recheck') return isSourceConfirmation(payload);
  if (command === 'recordingCandidates.start') return isStartSourceCandidateScan(payload);
  if (command === 'recordingCandidates.get') return isRecord(payload) && hasOnlyKeys(payload, ['id']) && isCollectionId(payload.id);
  if (command === 'recordingCandidates.cancel') return isSourceAction(payload);
  if (command === 'recordingCandidates.select') return isSelectSourceCandidate(payload);
  if (command === 'recordingVersions.list') return isRecord(payload) && hasOnlyKeys(payload, ['draftId']) && isCollectionId(payload.draftId);
  if (command === 'recordingPlans.list') return isRecordingPlanHistoryRequest(payload);
  if (command === 'recordingPlans.version' || command === 'recordingPlans.cancelRead') return isRecordingPlanIdRequest(payload);
  if (command === 'recordingPlans.preview') return isPreviewRecordingPlanRequest(payload);
  if (command === 'recordingPlans.freeze') return isFreezeRecordingPlanRequest(payload);
  if (command === 'recordingPlans.preflight') return isRecordingPreflightRequest(payload);
  if (command === 'recordingDevice.candidates') return isEmptyPayload(payload);
  if (command === 'recordingDevice.select') return isSelectRecordingDeviceRequest(payload);
  if (command === 'recordingWorkspace.get') return isRecord(payload) && hasOnlyKeys(payload, ['draftId']) && isCollectionId(payload.draftId);
  if (command === 'recordingWorkspace.put') return isPutRecordingWorkspaceContextRequest(payload);
  if (command === 'masterArtwork.get') return isGetMasterArtworkRequest(payload);
  if (command === 'masterArtwork.save') return isSaveMasterArtworkRequest(payload);
  if (command === 'recordingPrints.list') return isListRecordingPrintsRequest(payload);
  if (command === 'recordingPrints.request') return isRequestRecordingPrintRequest(payload);
  if (command === 'recordingPrints.retry') return isRetryRecordingPrintRequest(payload);
  if (command === 'recordingPrints.get') return isGetRecordingPrintRequest(payload);
  if (command === 'recordingPrintWorker.claim') return isClaimRecordingPrintRequest(payload);
  if (command === 'recordingPrintWorker.complete') return isCompleteRecordingPrintRequest(payload);
  if (command === 'recordingPrintWorker.fail') return isFailRecordingPrintRequest(payload);
  if (command === 'recordingPrintWorker.pdf') return isExportRecordingPrintRequest(payload);
  if (command === 'recordingReplica.status') return isEmptyPayload(payload);
  if (command === 'recordingReplica.inspect') return isInspectRecordingReplicaRequest(payload);
  if (command === 'recordingReplica.cancelRead') return isRecordingReplicaReadIdRequest(payload);
  if (command === 'recordingReplica.start') return isStartRecordingReplicaRequest(payload);
  if (command === 'recordingReplica.get' || command === 'recordingReplica.stop') return isRecordingReplicaRunIdRequest(payload);
  if (command === 'recordingReplica.control') return isReplicaDeviceControlRequest(payload);
  if (command === 'recordingOutput.status') return isEmptyPayload(payload);
  if (command === 'recordingOutput.check') return isRecordingOutputCheckRequest(payload);
  if (command === 'recordingOutput.cancel') return isRecordingOutputCancelRequest(payload);
  if (command === 'recordingRecords.list') return isListRecordingRecordsRequest(payload);
  if (command === 'recordingRecords.get') return isRecordingRecordIdRequest(payload);
  if (command === 'recordingRecords.visual') return isRecordingVisualRequest(payload);
  if (command === 'recordingRecords.history') return isPhysicalRecordingHistoryRequest(payload);
  if (command === 'recordingRecords.previewDisposition') return isPreviewPhysicalRecordingDispositionRequest(payload);
  if (command === 'recordingRecords.applyDisposition') return isApplyPhysicalRecordingDispositionRequest(payload);
  if (command === 'recordingAttempts.list') return isListRecordingAttemptsRequest(payload);
  if (command === 'recordingAttempts.get') return isRecordingAttemptIdRequest(payload);
  if (command === 'recordingAttempts.receipt') return isRecordingAttemptReceiptRequest(payload);
  if (command === 'recordingAttempts.begin') return isBeginRecordingAttemptRequest(payload);
  if (command === 'recordingAttempts.confirm') return isConfirmRecordingAttemptRequest(payload);
  if (command === 'recordingAttempts.beginSide') return isBeginRecordingAttemptSideRequest(payload);
  if (command === 'recordingAttempts.stop') return isStopRecordingAttemptRequest(payload);
  if (command === 'recordingProfiles.list') return isRecord(payload) && hasOnlyKeys(payload, []);
  if (command === 'recordingProfiles.history') return isRecord(payload) && hasOnlyKeys(payload, ['profileId']) && isCollectionId(payload.profileId);
  if (command === 'recordingProfiles.version') return isRecord(payload) && hasOnlyKeys(payload, ['versionId']) && isCollectionId(payload.versionId);
  if (command === 'recordingProfiles.save') return isSaveRecordingProfileRequest(payload);
  if (command === 'recordingProfiles.session') return isRecord(payload) && hasOnlyKeys(payload, ['draftId']) && isCollectionId(payload.draftId);
  if (command === 'recordingProfiles.saveSession') return isSaveRecordingSessionRequest(payload);
  if (command === 'recordingBackups.authorize') return isRecord(payload) && hasOnlyKeys(payload, ['commandId','kind','format','absolutePath']) && isAuthorizeBackupRoot({ commandId: payload.commandId, kind: payload.kind, ...(payload.format !== undefined ? { format: payload.format } : {}) }) && isSourcePrivatePath(payload.absolutePath);
  if (command === 'recordingBackups.authorizationReceipt') return isAuthorizeBackupRoot(payload);
  if (command === 'recordingBackups.start') return isStartBackupJob(payload);
  if (command === 'recordingBackups.activate') return isActivateRestoredDataset(payload);
  if (command === 'recordingBackups.cancel' || command === 'recordingBackups.revoke') return isSourceAction(payload);
  if (command === 'recordingBackups.overview') return isRecord(payload) && hasOnlyKeys(payload, []);
  if (command === 'recordingArchive.roots') return isRecord(payload) && hasOnlyKeys(payload, []);
  if (command === 'recordingArchive.initialize') return isInitializeArchiveRequest(payload);
  if (command === 'recordingArchive.revokeRoot' || command === 'recordingArchive.cancel' || command === 'recordingArchive.resume') return isSourceAction(payload);
  if (command === 'recordingArchive.preview') return isPreviewArchiveRequest(payload);
  if (command === 'recordingArchive.start') return isStartArchiveRequest(payload);
  if (command === 'recordingArchive.list') return isRecord(payload) && hasOnlyKeys(payload, ['draftId']) && isCollectionId(payload.draftId);
  if (command === 'recordingArchive.operation' || command === 'recordingArchive.cancelRead') return isRecord(payload) && hasOnlyKeys(payload, ['id']) && isCollectionId(payload.id);
  if (command === 'recordingArchive.verify') return isVerifyArchiveRequest(payload);
  if (command === 'recordingArchive.authorize') return isRecord(payload) && hasOnlyKeys(payload, ['commandId','absolutePath']) && isCollectionId(payload.commandId) && isSourcePrivatePath(payload.absolutePath);
  if (command === 'recordingArchive.authorizationReceipt') return isRecord(payload) && hasOnlyKeys(payload, ['commandId']) && isCollectionId(payload.commandId);
  if (command === 'recordingExecution.list') return isRecord(payload) && hasOnlyKeys(payload, ['draftId']) && isCollectionId(payload.draftId);
  if (command === 'recordingExecution.preview') return isPreviewExecutionRequest(payload);
  if (command === 'recordingExecution.start') return isStartExecutionRequest(payload);
  if (command === 'recordingExecution.job') return isRecord(payload) && hasOnlyKeys(payload, ['id']) && isCollectionId(payload.id);
  if (command === 'recordingExecution.cancel') return isSourceAction(payload);
  if (command === 'recordingExecution.cancelRead') return isRecord(payload) && hasOnlyKeys(payload, ['id']) && isCollectionId(payload.id);
  if (command === 'recordingExecution.verify') return isVerifyExecutionRequest(payload);
  if (command === 'recordingPrepared.selections') return isRecord(payload) && hasOnlyKeys(payload, ['preparationId']) && isCollectionId(payload.preparationId);
  if (command === 'recordingPrepared.selectionReceipt') return isSelectPreparedRequest(payload);
  if (command === 'recordingPrepared.select') return isRecord(payload) && hasOnlyKeys(payload, ['commandId','preparationId','side','absolutePath']) && isSelectPreparedRequest({ commandId: payload.commandId, preparationId: payload.preparationId, side: payload.side }) && isSourcePrivatePath(payload.absolutePath);
  if (command === 'recordingPrepared.revoke' || command === 'recordingPrepared.cancel') return isSourceAction(payload);
  if (command === 'recordingPrepared.job') return isRecord(payload) && hasOnlyKeys(payload, ['id']) && isCollectionId(payload.id);
  if (command === 'recordingPrepared.previewImport') return isPreviewPreparedImportRequest(payload);
  if (command === 'recordingPrepared.startImport') return isStartPreparedImportRequest(payload);
  if (command === 'recordingPrepared.review') return isReviewPreparedRequest(payload);
  if (command === 'recordingPrepared.freeze') return isFreezePreparedRequest(payload);
  if (command === 'recordingPreparation.destinations') return isRecord(payload) && hasOnlyKeys(payload, []);
  if (command === 'recordingPreparation.authorizationReceipt') return isRecord(payload) && hasOnlyKeys(payload, ['commandId']) && isCollectionId(payload.commandId);
  if (command === 'recordingPreparation.authorize') return isRecord(payload) && hasOnlyKeys(payload, ['commandId','absolutePath']) && isCollectionId(payload.commandId) && isSourcePrivatePath(payload.absolutePath);
  if (command === 'recordingPreparation.revoke' || command === 'recordingPreparation.cancel') return isSourceAction(payload);
  if (command === 'recordingPreparation.job' || command === 'recordingPreparation.context') return isRecord(payload) && hasOnlyKeys(payload, ['id']) && isCollectionId(payload.id);
  if (command === 'recordingPreparation.list' || command === 'recordingPrepared.list') return isRecord(payload) && hasOnlyKeys(payload, ['draftId']) && isCollectionId(payload.draftId);
  if (command === 'recordingPreparation.preview') return isPreviewPreparationRequest(payload);
  if (command === 'recordingPreparation.start') return isStartPreparationRequest(payload);
  if (command === 'recordingPreparationZip.authorizeTarget') return isRecord(payload) && hasOnlyKeys(payload, ['targetId','absolute','parentPath','parentDev','parentIno','datasetId','scopeId','generation','expiresAt'])
    && [payload.targetId,payload.datasetId,payload.scopeId].every(isCollectionId) && isSourcePrivatePath(payload.absolute) && isSourcePrivatePath(payload.parentPath)
    && typeof payload.parentDev === 'string' && /^\d+$/u.test(payload.parentDev) && typeof payload.parentIno === 'string' && /^\d+$/u.test(payload.parentIno)
    && Number.isSafeInteger(payload.generation) && Number(payload.generation) >= 0 && Number(payload.generation) <= 1_000_000
    && typeof payload.expiresAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(payload.expiresAt) && Number.isFinite(Date.parse(payload.expiresAt));
  if (command === 'recordingPreparationZip.invalidateScope') return isRecord(payload) && hasOnlyKeys(payload, ['scopeId']) && isCollectionId(payload.scopeId);
  if (command === 'recordingPreparationZip.preview') return isPreviewPreparationZipRequest(payload);
  if (command === 'recordingPreparationZip.start') return isStartPreparationZipRequest(payload);
  if (command === 'recordingPreparationZip.list') return isRecord(payload) && hasOnlyKeys(payload, ['draftId']) && isCollectionId(payload.draftId);
  if (command === 'recordingPreparationZip.job') return isRecord(payload) && hasOnlyKeys(payload, ['id']) && isCollectionId(payload.id);
  if (command === 'recordingPreparationZip.receipt') return isPreparationZipReceiptRequest(payload);
  if (command === 'recordingPreparationZip.cancel') return isSourceAction(payload);
  if (command === 'recordingVersions.preview') return isPreviewVersionsRequest(payload);
  if (command === 'recordingVersions.freeze') return isFreezeVersionsRequest(payload);
  if (command === 'recordingVersions.job') return isRecord(payload) && hasOnlyKeys(payload, ['id']) && isCollectionId(payload.id);
  if (command === 'recordingVersions.cancel') return isSourceAction(payload);
  if (command === 'recordingMedia.plans') return isRecord(payload) && hasOnlyKeys(payload, ['draftId']) && isCollectionId(payload.draftId);
  if (command === 'recordingMedia.detail') return isRecord(payload) && hasOnlyKeys(payload, ['id']) && isCollectionId(payload.id);
  if (command === 'recordingMedia.preview') return isPreviewMediaRequest(payload);
  if (command === 'recordingMedia.balance') return isRecord(payload) && hasOnlyKeys(payload, ['draftId', 'spec']) && isCollectionId(payload.draftId) && isMediaLayoutSpec(payload.spec);
  if (command === 'recordingMedia.save') return isSaveMediaPlanRequest(payload);
  if (command === 'recordingMedia.reserve') return isReserveMediaRequest(payload);
  if (command === 'recordingMedia.release') return isReleaseMediaRequest(payload);
  if (command === 'recordingDrafts.list') return isRecord(payload) && hasOnlyKeys(payload, ['page']) && isPageRequest(payload.page);
  if (command === 'recordingDrafts.detail') return isRecord(payload) && hasOnlyKeys(payload, ['id']) && isCollectionId(payload.id);
  if (command === 'recordingDrafts.runtime') return isRecord(payload) && hasOnlyKeys(payload, ['draftId', 'trackId']) && isCollectionId(payload.draftId) && isCollectionId(payload.trackId);
  if (command === 'recordingDrafts.append') return isAppendMasterDraftRequest(payload);
  if (command === 'recordingDrafts.update') return isUpdateMasterDraftRequest(payload);
  if (command === 'physicalLinks.digitalList') return isRecord(payload) && hasOnlyKeys(payload, ['page']) && isPageRequest(payload.page);
  if (command === 'physicalLinks.search') return isRecord(payload) && hasOnlyKeys(payload, ['page', 'query']) && isPageRequest(payload.page) && isAlbumQuery(payload.query);
  if (command === 'physicalLinks.matrix') return isRecord(payload) && hasOnlyKeys(payload, ['page', 'query']) && isPageRequest(payload.page) && (payload.query === undefined || isAlbumQuery(payload.query));
  if (command === 'physicalLinks.digitalDetail' || command === 'physicalLinks.runtime') return isRecord(payload) && hasOnlyKeys(payload, ['id']) && isCollectionId(payload.id);
  if (command === 'physicalLinks.physical') return isRecord(payload) && hasOnlyKeys(payload, ['releaseId']) && isCollectionId(payload.releaseId);
  if (command === 'physicalLinks.history') return isRecord(payload) && hasOnlyKeys(payload, ['releaseId', 'page']) && isCollectionId(payload.releaseId) && isPageRequest(payload.page);
  if (command === 'physicalLinks.confirm') return isLegacyConfirmPhysicalLinkRequest(payload);
  if (command === 'physicalLinks.confirmWithEvidence') return isConfirmPhysicalLinkRequest(payload);
  if (command === 'physicalLinks.relocate') return isRelocateDigitalRequest(payload);
  if (command === 'physicalLinks.register') return isRegisterDigitalRequest(payload);
  if (command === 'physicalLinks.remove') return isLegacyRemovePhysicalLinkRequest(payload);
  if (command === 'physicalLinks.removeWithEvidence') return isRemovePhysicalLinkRequest(payload);
  if (command === 'physicalLinks.absence') return isConfirmAbsenceRequest(payload);
  if (command === 'physicalMusic.list') return isRecord(payload) && hasOnlyKeys(payload, ['page', 'filter']) && isPageRequest(payload.page) && (payload.filter === undefined || isMusicFilter(payload.filter));
  if (command === 'physicalMusic.detail') return isRecord(payload) && hasOnlyKeys(payload, ['id']) && isMusicId(payload.id);
  if (command === 'physicalMusic.copies') return isRecord(payload) && hasOnlyKeys(payload, ['releaseId', 'page']) && isCollectionId(payload.releaseId) && isPageRequest(payload.page);
  if (command === 'physicalMusic.photo') return isRecord(payload) && hasOnlyKeys(payload, ['photoId']) && isCollectionId(payload.photoId);
  if (command === 'physicalMusic.saveRelease') return isSaveReleaseRequest(payload);
  if (command === 'physicalMusic.materializeCopy') return isMaterializeCommercialCopyRequest(payload);
  if (command === 'physicalMusic.saveCopyDetails') return isSaveCommercialCopyDetailsRequest(payload);
  if (command === 'physicalMusic.assignCopyPhoto') return isAssignCommercialCopyPhotoRequest(payload);
  if (command === 'physicalMusic.saveLegacy') return isSaveLegacyRequest(payload);
  if (command === 'physicalMusic.addPhoto') return isAddMusicPhotoRequest(payload);
  if (command === 'physicalMusic.removePhoto') return isRemoveMusicPhotoRequest(payload);
  if (command === 'collection.list') return isRecord(payload) && hasOnlyKeys(payload, ['page', 'filter']) && isPageRequest(payload.page) && (payload.filter === undefined || isCollectionFilter(payload.filter));
  if (command === 'collection.addPhoto') return isCollectionAddPhotoRequest(payload);
  if (command === 'collection.changePhoto') return isCollectionChangePhotoRequest(payload);
  if (command === 'collection.photo') return isRecord(payload) && hasOnlyKeys(payload, ['photoId']) && isCollectionId(payload.photoId);
  if (command === 'collection.detail') return isRecord(payload) && hasOnlyKeys(payload, ['modelId', 'page']) && isCollectionId(payload.modelId) && isPageRequest(payload.page);
  if (command === 'collection.copy') return isRecord(payload) && hasOnlyKeys(payload, ['physicalId']) && isPhysicalId(payload.physicalId);
  if (command === 'collection.receive') return isCollectionReceiveRequest(payload);
  if (command === 'collection.materialize') return isCollectionMaterializeRequest(payload);
  if (command === 'collection.updateCopy') return isCollectionUpdateCopyRequest(payload);
  if (command === 'collection.setPolicy') return isCollectionPolicyRequest(payload);
  if (command === 'roon.selectZone') return isSelectZonePayload(payload);
  if (command === 'auth.setCredential') return isSetCredentialPayload(payload);
  if (command === 'auth.verifyCredential') return isSetCredentialPayload(payload);
  if (command === 'auth.pollQr' || command === 'auth.cancelQr') {
    return isChallengePayload(payload);
  }
  if (command === 'library.search' || command === 'library.searchArtists' || command === 'library.searchAlbums') return isLibrarySearchPayload(payload);
  if (command === 'library.artist') return isLibraryArtistPayload(payload);
  if (command === 'library.album') return isLibraryAlbumPayload(payload);
  if (command === 'library.liked') return isLibraryPagePayload(payload);
  if (command === 'library.likeStatus') return isTrackLikeStatusPayload(payload);
  if (command === 'library.like') return isTrackLikePayload(payload);
  if (command === 'library.match') return isTrackMatchPayload(payload);
  if (command === 'library.aggregateSearch') return isLibrarySearchPayload(payload);
  if (command === 'library.playlist') return isLibraryPlaylistPayload(payload);
  if (command === 'favorites.list') return isFavoriteListPayload(payload);
  if (command === 'favorites.check') return isFavoriteCheckPayload(payload);
  if (command === 'favorites.set') return isFavoriteSetPayload(payload);
  if (command === 'roon.library.albums') return isLibraryPagePayload(payload);
  if (
    command === 'roon.library.artists' ||
    command === 'roon.library.genres' ||
    command === 'roon.library.playlists'
  ) return isLibraryPagePayload(payload);
  if (command === 'roon.library.album') return isRoonAlbumPayload(payload);
  if (command === 'roon.library.artist') return isRoonAlbumPayload(payload);
  if (command === 'roon.library.genre') return isRoonAlbumPayload(payload);
  if (command === 'roon.library.playlist') return isRoonAlbumPayload(payload);
  if (command === 'roon.library.search') return isRecord(payload)
    && hasOnlyKeys(payload, ['query', 'page', 'kind'])
    && isLibrarySearchPayload({ query: payload.query, page: payload.page })
    && (payload.kind === undefined || payload.kind === 'track' || payload.kind === 'album' || payload.kind === 'artist');
  if (command === 'roon.volume.get') return isRecord(payload) && Object.keys(payload).length === 0;
  if (command === 'roon.volume.set') return isVolumeRequest(payload);
  if (command === 'playback.seek') return isPlaybackSeekPayload(payload);
  if(command === 'playback.editQueue')return isMBQueueEditRequest(payload);
  if(command === 'playback.playQueueEntry')return isMBQueuePlayEntryRequest(payload);
  if(command === 'playback.queueLocalEdition')return isMBEditionQueueRequest(payload);
  if (command === 'playback.playQueueIndex') return isPlaybackQueueIndexPayload(payload);
  if (command === 'roon.library.image') return isRoonImagePayload(payload);
  if (command === 'roon.library.play' || command === 'roon.library.queue') {
    return isRoonTrackActionPayload(payload, command === 'roon.library.play');
  }
  if (command === 'lyrics.get') return isLyricsPayload(payload);
  if (command === 'lyrics.display.update') return isRoonDisplayLyricsEvent(payload);
  if (command === 'lyrics.match.select') return isLyricsMatchSelectionPayload(payload);
  if (command === 'playback.play') return isPlaybackPlayPayload(payload);
  if (command === 'playback.replaceQueue') return isPlaybackReplaceQueuePayload(payload);
  if (command === 'playback.appendQueue' || command === 'playback.insertNext') {
    return isPlaybackQueueMutationPayload(payload);
  }
  return isEmptyPayload(payload);
}

const PUBLIC_ERROR_CODES = new Set([
  'OUTBOX_SCOPE_MISMATCH',
  'INVENTORY_CONFLICT',
  'INVENTORY_UNAVAILABLE',
  'INVALID_IPC_REQUEST',
  'UNSUPPORTED_IPC_VERSION',
  'UNKNOWN_IPC_COMMAND',
  'INVALID_IPC_RESPONSE',
  'TIMEOUT',
  'CANCELLED',
  'NOT_READY',
  'ATTEMPT_NOT_ACCEPTED',
  'AUTH_REQUIRED',
  'AUTH_EXPIRED',
  'ACCOUNT_PROFILE_UNAVAILABLE',
  'DAILY_RECOMMENDATIONS_UNAVAILABLE',
  'ROON_CORE_NOT_CONNECTED',
  'ROON_TIMEOUT',
  'ROON_LIBRARY_UNAVAILABLE',
  'ROON_LIBRARY_REQUEST_FAILED',
  'ROON_ZONE_NOT_SELECTED',
  'ROON_IMAGE_UNAVAILABLE',
  'ROON_IMAGE_DECODE_FAILED',
  'ROON_ALBUM_HIERARCHY_INVALID',
  'ROON_TRACK_ACTION_UNAVAILABLE',
  'INTERNAL_ERROR',
]);

function isPublicError(value: unknown): value is PublicError {
  if (!isRecord(value) || !PUBLIC_ERROR_CODES.has(String(value.code))) return false;
  if (!safeString(value.message, 256)) return false;
  if (
    Object.keys(value).some((key) => !['code', 'message', 'diagnosticId'].includes(key))
  ) {
    return false;
  }
  return value.diagnosticId === undefined || safeString(value.diagnosticId, 128);
}

function isRuntimeStatus(value: unknown): value is PublicBridgeState['runtime'] {
  return ['starting', 'ready', 'degraded', 'failed', 'stopped'].includes(String(value));
}

function isRoonStatus(value: unknown): value is PublicBridgeState['roon'] {
  return ['disconnected', 'discovering', 'paired', 'ready'].includes(String(value));
}

function isProviderStatus(value: unknown): value is PublicBridgeState['provider'] {
  return ['configured', 'missing', 'invalid'].includes(String(value));
}

function isPublicBridgeState(value: unknown): value is PublicBridgeState {
  if (!isRecord(value)) return false;
  if (
    !hasOnlyKeys(value, [
      'runtime',
      'roon',
      'provider',
      'activeStreamCount',
      'activePlaybackPresent',
    ])
  ) {
    return false;
  }
  return (
    isRuntimeStatus(value.runtime) &&
    isRoonStatus(value.roon) &&
    isProviderStatus(value.provider) &&
    typeof value.activeStreamCount === 'number' &&
    Number.isSafeInteger(value.activeStreamCount) &&
    value.activeStreamCount >= 0 &&
    value.activeStreamCount <= 100_000 &&
    typeof value.activePlaybackPresent === 'boolean'
  );
}

function isDiagnosticTimelineEvent(value: unknown): value is DiagnosticTimelineEvent {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, ['at', 'component', 'level', 'event', 'code', 'diagnosticId', 'state', 'durationMs'])) {
    return false;
  }
  return (
    safeString(value.at, 64) &&
    (value.component === 'main' || value.component === 'core') &&
    (value.level === 'info' || value.level === 'warn' || value.level === 'error') &&
    safeString(value.event, 128) &&
    (value.code === undefined || safeString(value.code, 128)) &&
    (value.diagnosticId === undefined || safeString(value.diagnosticId, 128)) &&
    (value.state === undefined || safeString(value.state, 64)) &&
    (value.durationMs === undefined ||
      (typeof value.durationMs === 'number' &&
        Number.isSafeInteger(value.durationMs) &&
        value.durationMs >= 0 &&
        value.durationMs <= 24 * 60 * 60 * 1000))
  );
}

function isDiagnosticGate(value: unknown): value is DiagnosticGateResult {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['name', 'status']) &&
    safeString(value.name, 128) &&
    ['pass', 'fail', 'not-run'].includes(String(value.status))
  );
}

function isDiagnosticComponentSnapshot(value: unknown): value is DiagnosticComponentSnapshot {
  if (!isRecord(value)) return false;
  if (
    !hasOnlyKeys(value, ['component', 'health', 'timeline', 'memory', 'counters', 'latency', 'gates', 'performance']) ||
    (value.performance !== undefined && (!isPerformanceTraceSnapshot(value.performance) || value.performance.component !== value.component)) ||
    !['main', 'core'].includes(String(value.component)) ||
    !isPublicBridgeState(value.health) ||
    !Array.isArray(value.timeline) ||
    value.timeline.length > 200 ||
    !value.timeline.every((event) => isDiagnosticTimelineEvent(event)) ||
    !isRecord(value.memory) ||
    !hasOnlyKeys(value.memory, ['rssBytes', 'heapUsedBytes', 'heapTotalBytes', 'externalBytes']) ||
    !isRecord(value.counters) ||
    !hasOnlyKeys(value.counters, [
      'queueItemCount',
      'activeStreamCount',
      'activePlaybackCount',
      'activeSessionCount',
      'activeTokenCount',
      'listenerCount',
      'timerCount',
    ]) ||
    !isRecord(value.latency) ||
    !hasOnlyKeys(value.latency, ['startupMs', 'lastPlayMs']) ||
    !Array.isArray(value.gates) ||
    value.gates.length > 64 ||
    !value.gates.every((gate) => isDiagnosticGate(gate))
  ) {
    return false;
  }

  const memory = value.memory;
  const counters = value.counters;
  const latency = value.latency;
  const boundedNumber = (candidate: unknown, maximum = Number.MAX_SAFE_INTEGER): boolean =>
    typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0 && candidate <= maximum;
  return (
    boundedNumber(memory.rssBytes) &&
    boundedNumber(memory.heapUsedBytes) &&
    boundedNumber(memory.heapTotalBytes) &&
    boundedNumber(memory.externalBytes) &&
    boundedNumber(counters.queueItemCount, MAX_QUEUE_ITEMS) &&
    boundedNumber(counters.activeStreamCount, 100_000) &&
    boundedNumber(counters.activePlaybackCount, 1) &&
    boundedNumber(counters.activeSessionCount, 1) &&
    boundedNumber(counters.activeTokenCount, 100_000) &&
    boundedNumber(counters.listenerCount, 100_000) &&
    boundedNumber(counters.timerCount, 100_000) &&
    (latency.startupMs === undefined || boundedNumber(latency.startupMs, 24 * 60 * 60 * 1000)) &&
    (latency.lastPlayMs === undefined || boundedNumber(latency.lastPlayMs, 24 * 60 * 60 * 1000))
  );
}

function isAuthStatus(value: unknown): value is PublicAuthState['status'] {
  return [
    'idle',
    'creating',
    'waiting',
    'scanned',
    'authorized',
    'expired',
    'cancelled',
    'error',
  ].includes(String(value));
}

function isPublicAuthState(value: unknown): value is PublicAuthState {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, ['status', 'challengeId', 'qrImage', 'expiresAt'])) {
    return false;
  }
  if (!isAuthStatus(value.status)) return false;
  if (value.challengeId !== undefined && !safeString(value.challengeId, 128)) {
    return false;
  }
  if (
    value.qrImage !== undefined &&
    (!safeString(value.qrImage, 2 * 1024 * 1024) ||
      !value.qrImage.startsWith('data:image/'))
  ) {
    return false;
  }
  return (
    value.expiresAt === undefined ||
    (typeof value.expiresAt === 'number' &&
      Number.isSafeInteger(value.expiresAt) &&
      value.expiresAt >= 0)
  );
}

function isPublicAccountState(value: unknown): value is PublicAccountState {
  if (!isRecord(value) || !hasOnlyKeys(value, ['status', 'profile'])) return false;
  if (!['missing', 'loading', 'ready', 'unavailable'].includes(String(value.status))) return false;
  if (value.profile === undefined) return value.status !== 'ready';
  if (!isRecord(value.profile) || !hasOnlyKeys(value.profile, ['displayName', 'avatarUrl'])) return false;
  const profile = value.profile as unknown as PublicAccountProfile;
  return (
    safeString(profile.displayName, MAX_ACCOUNT_DISPLAY_NAME_LENGTH) &&
    (profile.avatarUrl === undefined || isArtworkUrl(profile.avatarUrl)) &&
    value.status === 'ready'
  );
}

function isInternalQrPollResult(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ['state', 'credential'])) return false;
  return (
    isPublicAuthState(value.state) &&
    (value.credential === undefined || safeString(value.credential, 64 * 1024))
  );
}

function isPublicRoonZone(value: unknown): value is PublicRoonZone {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['zoneId', 'displayName', 'selected', 'seekAllowed']) &&
    safeString(value.zoneId, 128) &&
    safeString(value.displayName, 256) &&
    typeof value.selected === 'boolean' &&
    (value.seekAllowed === undefined || typeof value.seekAllowed === 'boolean')
  );
}

function isRoonLibraryItem(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'reference',
      'kind',
      'title',
      'subtitle',
      'artist',
      'album',
      'durationMs',
      'bitrate',
      'format',
      'trackNumber',
      'discNumber',
      'year',
      'version',
      'artworkReference',
      'albumCount',
    ])
  ) return false;
  return (
    isRoonLibraryReference(value.reference) &&
    (value.albumCount === undefined || (typeof value.albumCount === 'number' && Number.isSafeInteger(value.albumCount) && value.albumCount >= 0 && value.albumCount <= MAX_PAGE_OFFSET)) &&
    ['album', 'artist', 'genre', 'playlist', 'composer', 'track'].includes(String(value.kind)) &&
    safeString(value.title, 512) &&
    (value.subtitle === undefined || safeString(value.subtitle, 512)) &&
    (value.artist === undefined || safeString(value.artist, 512)) &&
    (value.album === undefined || safeString(value.album, 512)) &&
    (value.durationMs === undefined || (
      typeof value.durationMs === 'number' && Number.isSafeInteger(value.durationMs) && value.durationMs >= 0 && value.durationMs <= 24 * 60 * 60 * 1000
    )) &&
    (value.bitrate === undefined || (typeof value.bitrate === 'number' && Number.isSafeInteger(value.bitrate) && value.bitrate > 0 && value.bitrate <= 10_000_000)) &&
    (value.format === undefined || safeString(value.format, 64)) &&
    (value.trackNumber === undefined || (typeof value.trackNumber === 'number' && Number.isSafeInteger(value.trackNumber) && value.trackNumber >= 0)) &&
    (value.discNumber === undefined || (typeof value.discNumber === 'number' && Number.isSafeInteger(value.discNumber) && value.discNumber >= 0)) &&
    (value.year === undefined || (typeof value.year === 'number' && Number.isSafeInteger(value.year) && value.year >= 0 && value.year <= 9999)) &&
    (value.version === undefined || safeString(value.version, 256)) &&
    (value.artworkReference === undefined || /^musicbridge-v2-image-[0-9a-f-]{36}$/u.test(String(value.artworkReference)))
  );
}

function isRoonLibraryPage(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['items', 'offset', 'limit', 'total', 'hasMore', 'sourceEpoch', 'complete', 'nextOffset', 'playbackContextHandle']) &&
    isPageRequest({ offset: value.offset, limit: value.limit }) &&
    Array.isArray(value.items) &&
    value.items.length <= MAX_PAGE_LIMIT &&
    value.items.every((item) => isRoonLibraryItem(item)) &&
    (value.total === undefined || (typeof value.total === 'number' && Number.isSafeInteger(value.total) && value.total >= 0 && value.total <= MAX_PAGE_OFFSET)) &&
    (value.hasMore === undefined || typeof value.hasMore === 'boolean') &&
    (value.sourceEpoch === undefined || (typeof value.sourceEpoch === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value.sourceEpoch))) &&
    (value.complete === undefined || typeof value.complete === 'boolean') &&
    (value.playbackContextHandle === undefined || (typeof value.playbackContextHandle === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value.playbackContextHandle))) &&
    (value.nextOffset === undefined || (
      typeof value.nextOffset === 'number' && Number.isSafeInteger(value.nextOffset) &&
      typeof value.offset === 'number' && value.nextOffset >= value.offset && value.nextOffset <= MAX_PAGE_OFFSET &&
      (value.hasMore !== true || value.nextOffset > value.offset)
    ))
  );
}

function isPublicTrackMatchResult(value: unknown): value is PublicTrackMatchResult {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['trackId', 'state', 'confidence', 'evidence', 'candidates', 'candidate', 'algorithmVersion']) ||
    !safeString(value.trackId, 128) ||
    !/^\d+$/.test(value.trackId) ||
    value.trackId === '0' ||
    !MATCH_STATES.includes(value.state as (typeof MATCH_STATES)[number]) ||
    typeof value.confidence !== 'number' ||
    !Number.isFinite(value.confidence) ||
    value.confidence < 0 ||
    value.confidence > 1 ||
    !Array.isArray(value.evidence) ||
    value.evidence.length > 32 ||
    !value.evidence.every((entry) => safeString(entry, 128)) ||
    !safeString(value.algorithmVersion, 64) ||
    !Array.isArray(value.candidates) ||
    value.candidates.length > MAX_PAGE_LIMIT
  ) return false;
  const isCandidate = (entry: unknown): boolean => (
    isRecord(entry) &&
    hasOnlyKeys(entry, ['candidate', 'score', 'evidence']) &&
    isRoonLibraryItem(entry.candidate) &&
    typeof entry.score === 'number' &&
    Number.isFinite(entry.score) &&
    entry.score >= 0 &&
    entry.score <= 1 &&
    Array.isArray(entry.evidence) &&
    entry.evidence.length <= 32 &&
    entry.evidence.every((item) => safeString(item, 128))
  );
  return value.candidates.every(isCandidate) &&
    (value.candidate === undefined || isRoonLibraryItem(value.candidate));
}

function isPublicAggregatedSearchResult(value: unknown): value is PublicAggregatedSearchResult {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['query', 'netease', 'roon', 'roonAvailable']) &&
    safeString(value.query, MAX_SEARCH_QUERY_LENGTH) &&
    isPageOfTracks(value.netease) &&
    isRoonLibraryPage(value.roon) &&
    typeof value.roonAvailable === 'boolean'
  );
}

function isRoonImageResult(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['contentType', 'body']) &&
    isValidRoonImageBinary(value.contentType, value.body)
  );
}

function isFavoriteRecord(value: unknown): value is FavoriteRecord {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'favoriteId', 'kind', 'title', 'subtitle', 'artist', 'album',
    'durationMs', 'trackNumber', 'discNumber', 'year', 'version', 'createdAt', 'updatedAt',
  ])) return false;
  const { favoriteId, createdAt, updatedAt, ...descriptor } = value;
  return safeString(favoriteId, 128) &&
    /^[0-9a-f-]{36}$/u.test(favoriteId) &&
    typeof createdAt === 'number' && Number.isSafeInteger(createdAt) && createdAt >= 0 &&
    typeof updatedAt === 'number' && Number.isSafeInteger(updatedAt) && updatedAt >= createdAt &&
    isFavoriteDescriptor(descriptor);
}

function isFavoritePage(value: unknown): boolean {
  return isRecord(value) &&
    hasOnlyKeys(value, ['items', 'offset', 'limit', 'total', 'hasMore']) &&
    isPageRequest({ offset: value.offset, limit: value.limit }) &&
    Array.isArray(value.items) && value.items.length <= MAX_PAGE_LIMIT &&
    value.items.every((item) => isFavoriteRecord(item)) &&
    typeof value.total === 'number' && Number.isSafeInteger(value.total) && value.total >= 0 && value.total <= MAX_PAGE_OFFSET &&
    typeof value.hasMore === 'boolean';
}

function isZoneListResult(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['zones']) &&
    Array.isArray(value.zones) &&
    value.zones.length <= 256 &&
    value.zones.every((zone) => isPublicRoonZone(zone))
  );
}

function isCommandResult(
  command: IpcCommand,
  value: unknown,
  allowInternalResult = false,
): boolean {
  if (isLocalSourceWritesCommand(command)) return isLocalSourceWritesCommandResult(command, value);
  if (isLocalRelocationPlanCommand(command)) return isLocalRelocationPlanCommandResult(command, value);
  if (isLocalArtworkCommand(command)) return (allowInternalResult || !isLocalArtworkInternalCommand(command)) && isLocalArtworkCommandResult(command,value);
  if (isLocalRelocationCommand(command)) return (allowInternalResult || !isLocalRelocationInternalCommand(command)) && isLocalRelocationCommandResult(command,value);
  if (isLocalScanCommand(command)) return (allowInternalResult || !isLocalScanInternalCommand(command)) && isLocalScanCommandResult(command,value);
  if (command === 'localCatalog.prepare') return isLocalSourceUnsupported(value) || isLocalPlayAccepted(value);
  if (command === 'playback.localTarget') return value === null || isLocalPlayTarget(value);
  if (isLocalLegacyLinksCommand(command)) return isLocalLegacyLinksCommandResult(command, value);
  if (isLocalOrganizerCommand(command)) return isLocalOrganizerCommandResult(command, value);
  if (isLocalCatalogCommand(command)) return (allowInternalResult || !isLocalCatalogInternalCommand(command)) && isLocalCatalogCommandResult(command, value);
  if (command === 'lyrics.display.update') return allowInternalResult && isRecord(value) && hasOnlyKeys(value, ['applied']) && typeof value.applied === 'boolean';
  switch (command) {
    case 'collectionProgress.wants': return isWantEntriesPage(value);
    case 'collectionProgress.saveWant': return isWantEntry(value);
    case 'collectionProgress.cancelWant': return isWantEntry(value);
    case 'collectionProgress.wantHistory': return isWantEntryHistory(value);
    case 'collectionProgress.current': return isCollectionProgress(value);
    case 'collectionProgress.capture': return isCollectionProgressSnapshotSummary(value);
    case 'collectionProgress.snapshots': return isCollectionProgressSnapshotsPage(value);
    case 'collectionProgress.snapshot': return isCollectionProgressSnapshotDetail(value);
    case 'collectionProgress.modelLengths': return isCollectionModelLengths(value);
    case 'spreadsheetImports.sources': return isSpreadsheetSourcePage(value);
    case 'spreadsheetImports.source': return isSpreadsheetWorkbookSource(value);
    case 'spreadsheetImports.sourceRows': return isSpreadsheetSourceRowsPage(value);
    case 'spreadsheetImports.preview': return isSpreadsheetImportPreview(value);
    case 'spreadsheetImports.apply': return isSpreadsheetImportResult(value);
    case 'spreadsheetImports.revision': return isSpreadsheetImportRevisionDetail(value);
    case 'spreadsheetImports.history': return isSpreadsheetImportHistory(value);
    case 'spreadsheetImports.adjustmentPreview': return isSpreadsheetAdjustmentBalance(value);
    case 'spreadsheetImports.adjust': return isSpreadsheetInventoryAdjustment(value);
    case 'spreadsheetImports.adjustments': return isSpreadsheetAdjustmentsPage(value);
    case 'spreadsheetImports.registerWorkbook': return allowInternalResult && isSpreadsheetWorkbookSource(value);
    case 'spreadsheetImports.workbookReceipt': return allowInternalResult && isSpreadsheetWorkbookReceipt(value);
    case 'recordingBackups.activationReceipt': return allowInternalResult && isRecord(value) && hasOnlyKeys(value, ['activation']) && (value.activation === null || isRestoreActivationView(value.activation));
    case 'commandOutbox.context': return isCommandOutboxContext(value);
    case 'commandOutbox.execute': return isCommandOutboxResult(value);
    case 'referenceCatalog.registerSource': return isReferenceSourceVersion(value);
    case 'referenceCatalog.previewSourceZip': return isReferenceSourceZipPreview(value);
    case 'referenceCatalog.registerSourceZip': return isRegisterReferenceSourceZipResult(value);
    case 'referenceCatalog.sourceZipReceipts': return isReferenceSourceZipReceiptPage(value);
    case 'referenceCatalog.sources': return isReferenceSourcePage(value);
    case 'referenceCatalog.source': return isReferenceSourceDetail(value);
    case 'referenceCatalog.previewRevision': return isCatalogRevisionPreview(value);
    case 'referenceCatalog.publishRevision':
    case 'referenceCatalog.setMatch':
    case 'referenceCatalog.revision': return isCatalogRevisionDetail(value);
    case 'referenceCatalog.snapshot': return isCatalogSnapshot(value);
    case 'referenceCatalog.history': return isCatalogHistory(value);
    case 'recordingSources.roots': return isRecord(value) && hasOnlyKeys(value, ['roots']) && Array.isArray(value.roots) && value.roots.length <= 100 && value.roots.every(isSourceRoot);
    case 'recordingSources.rootReceipt': return allowInternalResult && isRecord(value) && hasOnlyKeys(value, ['root']) && (value.root === null || isSourceRoot(value.root));
    case 'recordingSources.authorize': return allowInternalResult && isSourceRoot(value);
    case 'recordingSources.context': return allowInternalResult && isRecord(value) && hasOnlyKeys(value, ['absolutePath']) && isSourcePrivatePath(value.absolutePath);
    case 'recordingSources.start': return allowInternalResult && isSourceJob(value);
    case 'recordingSources.revoke': return isSourceRoot(value);
    case 'recordingSources.snapshot': return isDraftSourceSnapshot(value);
    case 'recordingSources.job': return isRecord(value) && hasOnlyKeys(value, ['job']) && (value.job === null || isSourceJob(value.job));
    case 'recordingSources.cancel':
    case 'recordingSources.recheck': return isSourceJob(value);
    case 'recordingSources.confirm': return isSourceBinding(value);
    case 'recordingCandidates.start': case 'recordingCandidates.cancel': return isSourceCandidateScan(value);
    case 'recordingCandidates.get': return isRecord(value) && hasOnlyKeys(value, ['scan']) && (value.scan === null || isSourceCandidateScan(value.scan));
    case 'recordingCandidates.select': return isSourceJob(value);
    case 'recordingVersions.list': return isVersionHistory(value);
    case 'recordingPlans.list': return isRecordingPlanHistory(value);
    case 'recordingPlans.version': return isRecord(value) && hasOnlyKeys(value, ['plan']) && (value.plan === null || isRecordingPlanVersion(value.plan));
    case 'recordingPlans.preview': return isRecordingPlanProposal(value);
    case 'recordingPlans.freeze': return isRecordingPlanVersion(value);
    case 'recordingPlans.preflight': return isRecordingPreflightResult(value);
    case 'recordingPlans.cancelRead': return isRecord(value) && hasOnlyKeys(value, ['cancelled']) && value.cancelled === true;
    case 'recordingDevice.candidates': return isRecordingDeviceCandidates(value);
    case 'recordingDevice.select': return isRecordingOutputSelection(value);
    case 'recordingWorkspace.get': return isRecord(value) && hasOnlyKeys(value, ['context']) && (value.context === null || isRecordingWorkspaceContext(value.context));
    case 'recordingWorkspace.put': return isRecordingWorkspaceContext(value);
    case 'masterArtwork.get': return isMasterArtworkResult(value);
    case 'masterArtwork.save': return isMasterArtworkVersion(value);
    case 'recordingPrints.list': return isRecordingPrintsPage(value);
    case 'recordingPrints.request': return isRecordingPrintJob(value);
    case 'recordingPrints.retry': return isRecordingPrintJob(value);
    case 'recordingPrints.get': return isRecordingPrintResult(value);
    case 'recordingPrintWorker.claim': return allowInternalResult && isRecord(value) && hasOnlyKeys(value, ['lease']) && (value.lease === null || isRecordingPrintLease(value.lease));
    case 'recordingPrintWorker.complete': case 'recordingPrintWorker.fail': return allowInternalResult && isRecordingPrintJob(value);
    case 'recordingPrintWorker.pdf': return allowInternalResult && isRecordingPrintPdfResult(value);
    case 'recordingReplica.status': return isRecordingReplicaStatus(value);
    case 'recordingReplica.inspect': return isRecordingReplicaInspection(value);
    case 'recordingReplica.cancelRead': return isRecordingReplicaReadCancellation(value);
    case 'recordingReplica.start': case 'recordingReplica.stop': case 'recordingReplica.control': return isRecordingReplicaRun(value);
    case 'recordingReplica.get': return isRecord(value) && hasOnlyKeys(value, ['run']) && (value.run === null || isRecordingReplicaRun(value.run));
    case 'recordingOutput.status': return isRecordingOutputStatus(value);
    case 'recordingOutput.check': return isRecordingOutputCheckResult(value);
    case 'recordingOutput.cancel': return isRecord(value) && hasOnlyKeys(value, ['cancelled']) && value.cancelled === true;
    case 'recordingRecords.list': return isRecordingRecordsPage(value);
    case 'recordingRecords.get': return isRecord(value) && hasOnlyKeys(value, ['record']) && (value.record === null || isRecordingRecordDetail(value.record));
    case 'recordingRecords.visual': return isRecordingVisualResult(value);
    case 'recordingRecords.history': return isPhysicalRecordingHistory(value);
    case 'recordingRecords.previewDisposition': return isPhysicalRecordingDispositionProposal(value);
    case 'recordingRecords.applyDisposition': return isApplyPhysicalRecordingDispositionResult(value);
    case 'recordingAttempts.list': return isRecordingAttemptsPage(value);
    case 'recordingAttempts.get': return isRecord(value) && hasOnlyKeys(value, ['attempt']) && (value.attempt === null || isRecordingAttempt(value.attempt));
    case 'recordingAttempts.receipt': return isRecordingAttemptReceipt(value);
    case 'recordingAttempts.begin':
    case 'recordingAttempts.confirm':
    case 'recordingAttempts.beginSide':
    case 'recordingAttempts.stop': return isRecordingAttempt(value);
    case 'recordingProfiles.list': return isRecord(value) && hasOnlyKeys(value, ['profiles']) && Array.isArray(value.profiles) && value.profiles.length <= 100 && value.profiles.every(isRecordingProfileVersion);
    case 'recordingProfiles.history': return isRecordingProfileHistory(value);
    case 'recordingProfiles.version': return isRecordingProfileVersion(value);
    case 'recordingProfiles.save': return isRecordingProfileVersion(value);
    case 'recordingProfiles.session': return isRecord(value) && hasOnlyKeys(value, ['session']) && (value.session === null || isRecordingSessionSettings(value.session));
    case 'recordingProfiles.saveSession': return isRecordingSessionSettings(value);
    case 'recordingBackups.authorize': return allowInternalResult && isBackupRootView(value);
    case 'recordingBackups.authorizationReceipt': return allowInternalResult && isRecord(value) && hasOnlyKeys(value, ['root']) && (value.root === null || isBackupRootView(value.root));
    case 'recordingBackups.start':
    case 'recordingBackups.cancel': return isBackupJobView(value);
    case 'recordingBackups.revoke': return isBackupRootView(value);
    case 'recordingBackups.overview': return isBackupOverview(value);
    case 'recordingBackups.activate': return isRestoreActivationView(value);
    case 'recordingArchive.roots': return isRecord(value) && hasOnlyKeys(value, ['roots']) && Array.isArray(value.roots) && value.roots.length <= 100 && value.roots.every(isArchiveRootView) && new Set(value.roots.map(root => root.id)).size === value.roots.length;
    case 'recordingArchive.initialize':
    case 'recordingArchive.revokeRoot': return isArchiveRootView(value);
    case 'recordingArchive.preview': return isArchiveProposal(value);
    case 'recordingArchive.start':
    case 'recordingArchive.cancel':
    case 'recordingArchive.resume': return isArchiveOperationView(value);
    case 'recordingArchive.list': return isArchiveHistory(value);
    case 'recordingArchive.operation': return isRecord(value) && hasOnlyKeys(value, ['operation']) && (value.operation === null || isArchiveOperationView(value.operation));
    case 'recordingArchive.verify': return isArchiveCheck(value);
    case 'recordingArchive.cancelRead': return isRecord(value) && hasOnlyKeys(value, ['cancelled']) && value.cancelled === true;
    case 'recordingArchive.authorize': return allowInternalResult && isArchiveRootView(value);
    case 'recordingArchive.authorizationReceipt': return allowInternalResult && isRecord(value) && hasOnlyKeys(value, ['root']) && (value.root === null || isArchiveRootView(value.root));
    case 'recordingExecution.list': return isExecutionHistory(value);
    case 'recordingExecution.preview': return isExecutionProposal(value);
    case 'recordingExecution.start': return isExecutionJob(value);
    case 'recordingExecution.job': return isRecord(value) && hasOnlyKeys(value, ['job']) && (value.job === null || isExecutionJob(value.job));
    case 'recordingExecution.cancel': return isExecutionJob(value);
    case 'recordingExecution.cancelRead': return isRecord(value) && hasOnlyKeys(value, ['cancelled']) && value.cancelled === true;
    case 'recordingExecution.verify': return isExecutionAssetCheck(value);
    case 'recordingPreparation.destinations': return isRecord(value) && hasOnlyKeys(value, ['destinations']) && Array.isArray(value.destinations) && value.destinations.length <= 100 && value.destinations.every(isPreparationDestination);
    case 'recordingPreparation.authorizationReceipt': return allowInternalResult && isRecord(value) && hasOnlyKeys(value, ['destination']) && (value.destination === null || isPreparationDestination(value.destination));
    case 'recordingPreparation.authorize': return allowInternalResult && isPreparationDestination(value);
    case 'recordingPreparation.revoke': return isPreparationDestination(value);
    case 'recordingPreparation.job': return isRecord(value) && hasOnlyKeys(value, ['job']) && (value.job === null || isPreparationJob(value.job));
    case 'recordingPreparation.cancel': return isPreparationJob(value);
    case 'recordingPreparation.context': return allowInternalResult && isRecord(value) && hasOnlyKeys(value, ['absolutePath']) && isSourcePrivatePath(value.absolutePath);
    case 'recordingPrepared.selections': return isRecord(value) && hasOnlyKeys(value, ['selections']) && Array.isArray(value.selections) && value.selections.length <= 100 && value.selections.every(isPreparedSelection);
    case 'recordingPrepared.selectionReceipt': return allowInternalResult && isRecord(value) && hasOnlyKeys(value, ['selection']) && (value.selection === null || isPreparedSelection(value.selection));
    case 'recordingPrepared.select': return allowInternalResult && isPreparedSelection(value);
    case 'recordingPrepared.revoke': return isPreparedSelection(value);
    case 'recordingPrepared.previewImport': return isPreparedImportProposal(value);
    case 'recordingPrepared.startImport': case 'recordingPrepared.cancel': return isPreparedImportJob(value);
    case 'recordingPrepared.job': return isRecord(value) && hasOnlyKeys(value, ['job']) && (value.job === null || isPreparedImportJob(value.job));
    case 'recordingPrepared.review': return isPreparedReview(value);
    case 'recordingPrepared.freeze': return isFrozenPrepared(value);
    case 'recordingPrepared.list': return isPreparedHistory(value);
    case 'recordingPreparation.list': return isPreparationHistory(value);
    case 'recordingPreparation.preview': return isPreparationProposal(value);
    case 'recordingPreparation.start': return isPreparationJob(value);
    case 'recordingPreparationZip.authorizeTarget': return allowInternalResult && isPreparationZipTarget(value);
    case 'recordingPreparationZip.invalidateScope': return allowInternalResult && isRecord(value) && hasOnlyKeys(value, ['invalidated']) && value.invalidated === true;
    case 'recordingPreparationZip.preview': return isPreparationZipProposal(value);
    case 'recordingPreparationZip.start': case 'recordingPreparationZip.cancel': return isPreparationZipJob(value);
    case 'recordingPreparationZip.list': return isPreparationZipHistory(value);
    case 'recordingPreparationZip.job': return isRecord(value) && hasOnlyKeys(value, ['job']) && (value.job === null || isPreparationZipJob(value.job));
    case 'recordingPreparationZip.receipt': return isPreparationZipReceipt(value);
    case 'recordingVersions.preview': return isVersionProposal(value);
    case 'recordingVersions.freeze':
    case 'recordingVersions.cancel': return isVersionJob(value);
    case 'recordingVersions.job': return isRecord(value) && hasOnlyKeys(value, ['job']) && (value.job === null || isVersionJob(value.job));
    case 'recordingMedia.plans': return isRecord(value) && hasOnlyKeys(value, ['draftId', 'plans']) && isCollectionId(value.draftId) && Array.isArray(value.plans) && value.plans.length <= 100 && value.plans.every(isMediaPlan);
    case 'recordingMedia.preview': return isMediaPreview(value, page => isCollectionPage(page, isMediaCandidate));
    case 'recordingMedia.balance': return isRecord(value) && hasOnlyKeys(value, ['splitAfter']) && Number.isInteger(value.splitAfter) && Number(value.splitAfter) >= 1 && Number(value.splitAfter) <= 200;
    case 'recordingMedia.detail':
    case 'recordingMedia.save':
    case 'recordingMedia.reserve':
    case 'recordingMedia.release': return isMediaPlan(value);
    case 'recordingDrafts.list': return isCollectionPage(value, isMasterDraftSummary);
    case 'recordingDrafts.detail': return isMasterDraft(value);
    case 'recordingDrafts.append':
    case 'recordingDrafts.update': return isMasterDraftResult(value);
    case 'recordingDrafts.runtime': return isDigitalRuntime(value);
    case 'physicalLinks.search': return isRoonLibraryPage(value);
    case 'physicalLinks.digitalList': return isCollectionPage(value, isDigitalAlbum);
    case 'physicalLinks.digitalDetail': return isDigitalAlbumDetail(value, isMusicEntry);
    case 'physicalLinks.physical': return isPhysicalLinksSnapshot(value);
    case 'physicalLinks.history': return isCollectionPage(value, isPhysicalLinkHistoryEvent);
    case 'physicalLinks.runtime': return isDigitalRuntime(value);
    case 'physicalLinks.matrix': return isCollectionPage(value, isCollectionMatrixRow);
    case 'physicalLinks.confirm':
    case 'physicalLinks.confirmWithEvidence':
    case 'physicalLinks.relocate':
    case 'physicalLinks.register':
    case 'physicalLinks.remove':
    case 'physicalLinks.removeWithEvidence':
    case 'physicalLinks.absence':
      return isPhysicalLinkResult(value);
    case 'physicalMusic.list': return isCollectionPage(value, isMusicEntry);
    case 'physicalMusic.detail': return isMusicDetail(value);
    case 'physicalMusic.copies': return isCommercialCopiesSnapshot(value);
    case 'physicalMusic.photo': return isCollectionPhotoImage(value);
    case 'physicalMusic.saveRelease':
    case 'physicalMusic.materializeCopy':
    case 'physicalMusic.saveCopyDetails':
    case 'physicalMusic.assignCopyPhoto':
    case 'physicalMusic.saveLegacy':
    case 'physicalMusic.addPhoto':
    case 'physicalMusic.removePhoto':
      return isMusicMutationResult(value);
    case 'collection.addPhoto':
    case 'collection.changePhoto':
      return isCollectionMutationResult(value);
    case 'collection.photo':
      return isCollectionPhotoImage(value);
    case 'collection.list':
      return isCollectionPage(value, isCollectionModel);
    case 'collection.detail':
      return isCollectionDetail(value);
    case 'collection.copy':
      return isCollectionCopyDetail(value);
    case 'collection.receive':
    case 'collection.materialize':
    case 'collection.updateCopy':
    case 'collection.setPolicy':
      return isCollectionMutationResult(value);
    case 'core.ping':
      return isRecord(value) && hasOnlyKeys(value, ['pong']) && value.pong === true;
    case 'core.getHealth':
    case 'core.getState':
    case 'auth.setCredential':
    case 'auth.clearCredential':
    case 'roon.selectZone':
      return isPublicBridgeState(value);
    case 'auth.verifyCredential':
      return allowInternalResult && isRecord(value) &&
        hasOnlyKeys(value, ['status']) &&
        ['authorized', 'expired', 'unavailable'].includes(String(value.status));
    case 'core.getDiagnostics':
      return isDiagnosticComponentSnapshot(value);
    case 'auth.beginQr':
    case 'auth.cancelQr':
    case 'auth.getState':
    case 'auth.logout':
      return isPublicAuthState(value);
    case 'auth.pollQr':
      return isPublicAuthState(value) ||
        (allowInternalResult && isInternalQrPollResult(value));
    case 'library.search':
    case 'library.liked':
      return isPageOfTracks(value);
    case 'library.searchArtists':
      return isPageOfArtists(value);
    case 'library.searchAlbums':
      return isPageOfAlbums(value);
    case 'library.artist':
      return isArtistDetail(value);
    case 'library.album':
      return isAlbumDetail(value);
    case 'library.likeStatus':
    case 'library.like':
      return isRecord(value) && hasOnlyKeys(value, ['liked']) && typeof value.liked === 'boolean';
    case 'library.match':
      return isPublicTrackMatchResult(value);
    case 'library.aggregateSearch':
      return isPublicAggregatedSearchResult(value);
    case 'library.playlists':
      return Array.isArray(value) && value.length <= MAX_PAGE_OFFSET && value.every((item) => isPlaylistSummary(item));
    case 'library.playlist':
      return isPlaylistDetail(value);
    case 'account.getState':
    case 'account.refresh':
      return isPublicAccountState(value);
    case 'library.dailyRecommendations':
      return isDailyRecommendationsSnapshot(value);
    case 'favorites.list':
      return isFavoritePage(value);
    case 'favorites.check':
      return isRecord(value) && hasOnlyKeys(value, ['favorite']) && typeof value.favorite === 'boolean';
    case 'favorites.set':
      return isRecord(value) && hasOnlyKeys(value, ['favorite', 'item']) &&
        typeof value.favorite === 'boolean' &&
        (value.item === undefined || isFavoriteRecord(value.item));
    case 'lyrics.get':
      return isLyricsSnapshot(value);
    case 'lyrics.match.get':
    case 'lyrics.match.select':
    case 'lyrics.match.revoke':
      return isLocalLyricsMatchSnapshot(value);
    case 'core.shutdown':
      return isRecord(value) && hasOnlyKeys(value, ['stopped']) && value.stopped === true;
    case 'roon.listZones':
      return isZoneListResult(value);
    case 'roon.library.albums':
    case 'roon.library.artists':
    case 'roon.library.genres':
    case 'roon.library.playlists':
    case 'roon.library.album':
    case 'roon.library.artist':
    case 'roon.library.genre':
    case 'roon.library.playlist':
    case 'roon.library.search':
      return isRoonLibraryPage(value);
    case 'roon.library.image':
      return isRoonImageResult(value);
    case 'roon.library.play':
      return isRecord(value) && hasOnlyKeys(value, ['started']) && value.started === true;
    case 'roon.library.queue':
      return isRecord(value) && hasOnlyKeys(value, ['queued']) && value.queued === true;
    case 'roon.transport.stop':
      return isRecord(value) && hasOnlyKeys(value, ['stopped']) && value.stopped === true;
    case 'playback.getState':
    case 'playback.play':
    case 'playback.pause':
    case 'playback.resume':
    case 'playback.stop':
    case 'playback.next':
    case 'playback.previous':
    case 'playback.editQueue':
    case 'playback.playQueueEntry':
    case 'playback.queueLocalEdition':
    case 'playback.playQueueIndex':
    case 'playback.replaceQueue':
    case 'playback.appendQueue':
    case 'playback.insertNext':
      return isPlaybackSnapshot(value);
    case 'playback.getStreamSnapshot':
      return value === null || isPlaybackStreamSnapshot(value);
    case 'roon.volume.get':
    case 'roon.volume.set':
      return isVolumeSnapshot(value);
    case 'playback.seek':
      return isRecord(value) &&
        hasOnlyKeys(value, ['positionMs']) &&
        typeof value.positionMs === 'number' &&
        Number.isSafeInteger(value.positionMs) &&
        value.positionMs >= 0 &&
        value.positionMs <= 24 * 60 * 60 * 1_000;
  }
}

function isDiagnosticPayload(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ['code', 'message'])) return false;
  return safeString(value.code, 128) &&
    (value.message === undefined || safeString(value.message, 256));
}

function isEventPayload(event: IpcEventName, payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  switch (event) {
    case 'core.ready':
      return hasOnlyKeys(payload, ['state', 'playbackEvents']) && isPublicBridgeState(payload.state) &&
        (payload.playbackEvents === undefined || isPlaybackEventProtocolAck(payload.playbackEvents));
    case 'core.health':
    case 'roon.changed':
      return hasOnlyKeys(payload, ['state']) && isPublicBridgeState(payload.state);
    case 'auth.changed':
      return hasOnlyKeys(payload, ['state']) && isPublicAuthState(payload.state);
    case 'account.changed':
      return hasOnlyKeys(payload, ['state']) && isPublicAccountState(payload.state);
    case 'diagnostic.notice':
      return isDiagnosticPayload(payload);
    case 'playback.changed':
      return hasOnlyKeys(payload, ['state']) && isPlaybackSnapshot(payload.state);
    case 'playback.snapshot':
      return isPlaybackStreamSnapshot(payload);
    case 'playback.state':
      return isPlaybackStreamState(payload);
    case 'playback.progress':
      return isPlaybackStreamProgress(payload);
    case 'queue.changed':
      return hasOnlyKeys(payload, ['queue']) && isPlaybackQueueSnapshot(payload.queue);
    case 'lyrics.changed':
      return hasOnlyKeys(payload, ['state']) && isLyricsSnapshot(payload.state);
    case 'lyrics.match.changed':
      return hasOnlyKeys(payload, ['state']) && isLocalLyricsMatchSnapshot(payload.state);
  }
}

export function validateIpcRequest(input: unknown): ValidationResult<IpcRequest<unknown>> {
  return validateRequest(input, false);
}

/** 仅既有Main/Core私有端口的内部调用方使用；普通入口不可传可信观察。 */
export function validateIpcInternalRequest(input: unknown): ValidationResult<IpcRequest<unknown>> {
  return validateRequest(input, true);
}

function validateRequest(input: unknown, internal: boolean): ValidationResult<IpcRequest<unknown>> {
  let observedCommand: unknown;
  let sourceOutboxCommand: unknown;
  try {
    if (input === null || typeof input !== 'object') return invalidRequest();
    const descriptor = Object.getOwnPropertyDescriptor(input, 'command');
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return invalidRequest();
    observedCommand = descriptor.value;
    if (typeof observedCommand === 'string' && observedCommand.startsWith('localRelocationPlan.')) {
      input = localRelocationDataSnapshot(input);
      if (!localRelocationRecord(input, ['version', 'id', 'command', 'payload', 'expectedDatasetId'], ['performanceTrace']) || input.command !== observedCommand
        || !isRecord(input.payload) || input.payload.datasetId !== input.expectedDatasetId) return invalidRequest();
    } else if (typeof observedCommand === 'string' && observedCommand.startsWith('localSourceWrites.')) {
      input = localSourceWritesDataSnapshot(input, LOCAL_SOURCE_WRITES_BUDGET.requestBytes, LOCAL_SOURCE_WRITES_BUDGET.requestNodes);
      if (!localSourceWritesRecord(input, ['version', 'id', 'command', 'payload', 'expectedDatasetId'], ['performanceTrace']) || input.command !== observedCommand
        || !isRecord(input.payload) || input.payload.datasetId !== input.expectedDatasetId) return invalidRequest();
    } else if (observedCommand === 'commandOutbox.execute') {
      const payloadDescriptor = Object.getOwnPropertyDescriptor(input, 'payload');
      if (!payloadDescriptor?.enumerable || !Object.hasOwn(payloadDescriptor, 'value')) return invalidRequest();
      if (payloadDescriptor.value && typeof payloadDescriptor.value === 'object') sourceOutboxCommand = Object.getOwnPropertyDescriptor(payloadDescriptor.value, 'command')?.value;
      if (typeof sourceOutboxCommand === 'string' && sourceOutboxCommand.startsWith('localSourceWrites.')) {
        input = localSourceWritesDataSnapshot(input, LOCAL_SOURCE_WRITES_BUDGET.requestBytes, LOCAL_SOURCE_WRITES_BUDGET.requestNodes);
        if (!localSourceWritesRecord(input, ['version', 'id', 'command', 'payload'], ['expectedDatasetId', 'performanceTrace']) || input.command !== observedCommand
          || !localSourceWritesRecord(input.payload, ['datasetId', 'command', 'payload']) || input.payload.command !== sourceOutboxCommand
          || !isRecord(input.payload.payload) || input.payload.datasetId !== input.payload.payload.datasetId
          || input.expectedDatasetId !== undefined && input.expectedDatasetId !== input.payload.datasetId) return invalidRequest();
      }
    }
    if (isLocalLegacyLinksCommand(observedCommand)) {
      input = localLegacyLinksDataSnapshot(input, 16384, 2048, 100);
      if (!isRecord(input) || input.command !== observedCommand) return invalidRequest();
    }
  } catch { return invalidRequest(); }
  if (!isRecord(input)) return invalidRequest();
  if (isLocalLegacyLinksCommand(observedCommand) && (!localLegacyRecord(input, ['version','id','command','payload','expectedDatasetId'], ['performanceTrace']) || !isCommandOutboxDatasetId(input.expectedDatasetId))) return invalidRequest();
  if ((isLocalArtworkCommand(observedCommand) || isLocalScanCommand(observedCommand) || isLocalRelocationCommand(observedCommand)) && (![Object.prototype,null].includes(Object.getPrototypeOf(input))
    || Reflect.ownKeys(input).some(k=>typeof k !== 'string' || !['version','id','command','payload','expectedDatasetId','performanceTrace'].includes(k)
      || !Object.prototype.propertyIsEnumerable.call(input,k)))) return invalidRequest();
  if ((isLocalOrganizerCommand(observedCommand) || isLocalArtworkCommand(observedCommand) || isLocalCatalogCommand(observedCommand) || isLocalScanCommand(observedCommand) || isLocalRelocationCommand(observedCommand) || observedCommand === 'localCatalog.prepare') && ((!internal && (isLocalArtworkInternalCommand(observedCommand) || isLocalCatalogInternalCommand(observedCommand) || isLocalScanInternalCommand(observedCommand) || isLocalRelocationInternalCommand(observedCommand)))
    || !isCommandOutboxDatasetId(input.expectedDatasetId)
    || !hasOnlyKeys(input, ['version','id','command','payload','expectedDatasetId','performanceTrace']))) return invalidRequest();

  if (input.version !== IPC_VERSION) {
    return {
      ok: false,
      error: {
        code: 'UNSUPPORTED_IPC_VERSION',
        message: 'Unsupported IPC version',
      },
    };
  }

  if (
    (input.readContext !== undefined && (!isLibraryReadCommand(observedCommand) || !isLibraryReadContext(input.readContext))) ||
    (input.expectedDatasetId !== undefined && !isCommandOutboxDatasetId(input.expectedDatasetId)) ||
    typeof input.id !== 'string' ||
    input.id.trim().length === 0 ||
    input.id.length > 128 ||
    typeof observedCommand !== 'string' ||
    !IPC_COMMANDS.includes(observedCommand as (typeof IPC_COMMANDS)[number]) ||
    !isRecord(input.payload) ||
    !isValidCommandPayload(observedCommand as IpcCommand, input.payload)
  ) {
    if (
      typeof observedCommand === 'string' &&
      observedCommand.length > 0 &&
      !IPC_COMMANDS.includes(observedCommand as (typeof IPC_COMMANDS)[number])
    ) {
      return {
        ok: false,
        error: {
          code: 'UNKNOWN_IPC_COMMAND',
          message: 'Unknown IPC command',
        },
      };
    }
    return invalidRequest();
  }

  return {
    ok: true,
    value: {
      version: IPC_VERSION,
      id: input.id,
      command: observedCommand as (typeof IPC_COMMANDS)[number],
      payload: input.payload,
      ...(input.readContext !== undefined ? { readContext: input.readContext as import('./library-read.js').LibraryReadContext } : {}),
      ...(input.expectedDatasetId !== undefined ? { expectedDatasetId: input.expectedDatasetId as string } : {}),
      ...(copyPerformanceTraceContext(input.performanceTrace) ? { performanceTrace: copyPerformanceTraceContext(input.performanceTrace)! } : {}),
    },
  };
}

export function validateIpcResponse(
  input: unknown,
): ValidationResult<IpcResponse<unknown>> {
  if (!isRecord(input)) return invalidResponse();
  if (input.version !== IPC_VERSION) {
    return {
      ok: false,
      error: {
        code: 'UNSUPPORTED_IPC_VERSION',
        message: 'Unsupported IPC version',
      },
    };
  }
  if (!safeString(input.id, 128) || typeof input.ok !== 'boolean') {
    return invalidResponse();
  }
  if (input.ok) {
    if (!Object.prototype.hasOwnProperty.call(input, 'result')) return invalidResponse();
    return {
      ok: true,
      value: {
        version: IPC_VERSION,
        id: input.id,
        ok: true,
        result: input.result,
      },
    };
  }
  if (!isPublicError(input.error)) return invalidResponse();
  return {
    ok: true,
    value: {
      version: IPC_VERSION,
      id: input.id,
      ok: false,
      error: input.error,
    },
  };
}

export function validateIpcResponseForCommand<TCommand extends IpcCommand>(
  input: unknown,
  command: TCommand,
): ValidationResult<IpcResponse<IpcCommandResults[TCommand]>> {
  if (isLocalRelocationPlanCommand(command)) {
    try {
      input = localRelocationDataSnapshot(input);
      if (!localRelocationRecord(input, ['version', 'id', 'ok'], ['result', 'error'])
        || input.ok === true && !localRelocationRecord(input, ['version', 'id', 'ok', 'result'])
        || input.ok === false && !localRelocationRecord(input, ['version', 'id', 'ok', 'error'])) return invalidResponse();
    } catch { return invalidResponse(); }
  }
  if (isLocalSourceWritesCommand(command)) {
    try {
      input = localSourceWritesDataSnapshot(input, LOCAL_SOURCE_WRITES_BUDGET.planBytes, LOCAL_SOURCE_WRITES_BUDGET.publicNodes);
      if (!localSourceWritesRecord(input, ['version', 'id', 'ok'], ['result', 'error'])) return invalidResponse();
    } catch { return invalidResponse(); }
  }
  if (isLocalLegacyLinksCommand(command)) {
    try { input = localLegacyLinksDataSnapshot(input, 2097152, 32768, 100); } catch { return invalidResponse(); }
  }
  const response = validateIpcResponse(input);
  if (!response.ok) return response;
  if (!response.value.ok || isCommandResult(command, response.value.result)) {
    return {
      ok: true,
      value: response.value as IpcResponse<IpcCommandResults[TCommand]>,
    };
  }
  return invalidResponse();
}

export function validateIpcInternalResponseForCommand<
  TCommand extends IpcInternalCommand,
>(
  input: unknown,
  command: TCommand,
): ValidationResult<IpcResponse<IpcInternalCommandResults[TCommand]>> {
  const response = validateIpcResponse(input);
  if (!response.ok) return response;
  if (!response.value.ok || isCommandResult(command, response.value.result, true)) {
    return {
      ok: true,
      value: response.value as IpcResponse<IpcInternalCommandResults[TCommand]>,
    };
  }
  return invalidResponse();
}

export function validateIpcEvent(input: unknown): ValidationResult<IpcRuntimeMessage> {
  if (!isRecord(input)) return invalidResponse();
  if (input.version !== IPC_VERSION) {
    return {
      ok: false,
      error: {
        code: 'UNSUPPORTED_IPC_VERSION',
        message: 'Unsupported IPC version',
      },
    };
  }
  if (
    typeof input.event !== 'string' ||
    !IPC_EVENTS.includes(input.event as IpcEventName) ||
    !isEventPayload(input.event as IpcEventName, input.payload)
  ) {
    return invalidResponse();
  }
  return {
    ok: true,
    value: {
      version: IPC_VERSION,
      event: input.event as IpcEventName,
      payload: input.payload,
    } as IpcRuntimeMessage,
  };
}

export function parseIpcRuntimeMessage(
  input: unknown,
): ValidationResult<IpcRuntimeMessage> {
  if (isRecord(input) && Object.prototype.hasOwnProperty.call(input, 'ok')) {
    return validateIpcResponse(input);
  }
  if (isRecord(input) && Object.prototype.hasOwnProperty.call(input, 'event')) {
    return validateIpcEvent(input);
  }
  return invalidResponse();
}

function isSourcePrivatePath(value: unknown): value is string { return typeof value === 'string' && value.startsWith('/') && value.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value); }
import { isLocalOrganizerCommand, isLocalOrganizerCommandPayload, isLocalOrganizerCommandResult } from './local-organizer.js';
