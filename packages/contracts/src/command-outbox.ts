import { isApplyLocalArtworkSelection, isLocalArtworkSelection, isCreateLocalArtworkEdition } from './local-artwork.js';
import { isLocalSourceWritesHash, isLocalSourceWritesOutboxCommand, isLocalSourceWritesCommandPayload, isLocalSourceWritesCommandResult, type LocalSourceWritesCommandPayloads, type LocalSourceWritesReceipt } from './local-source-writes.js';
import { localSourceWritesDataSnapshot, localSourceWritesRecord } from './local-source-writes-data.js';
import { isAlbumEdition } from './local-catalog.js';
import { isLocalLegacyLinksCommandPayload, isLocalLegacyLinksCommandResult, localLegacyLinksDataSnapshot, localLegacyRecord, type ExecuteLocalLegacyLink, type LocalLegacyLinkReceipt } from './local-legacy-links.js';
import {isLocalRelocationConfirm,isLocalRootRelink,isLocalRelocationCommandResult} from './local-relocation.js';
import type {LibraryRoot} from './local-catalog.js';
import { LOCAL_CATALOG_OUTBOX_COMMANDS, isLocalCatalogCommandPayload, isLocalCatalogCommandResult, type LocalCatalogCommandPayloads, type LocalCatalogCommandResults } from './local-catalog.js';
import { isFreezeRecordingPlanRequest, isRecordingPlanVersion } from './recording-plans.js';
import { isChooseSpreadsheetWorkbookRequest, isSpreadsheetWorkbookSource, isApplySpreadsheetImportRequest, isSpreadsheetImportResult, isAdjustSpreadsheetInventoryRequest, isSpreadsheetInventoryAdjustment, type ChooseSpreadsheetWorkbookRequest, type SpreadsheetWorkbookSource } from './spreadsheet-import.js';
import { isSaveWantEntryRequest, isCancelWantEntryRequest, isCaptureCollectionProgressRequest, isWantEntry, isCollectionProgressSnapshotSummary } from './collection-progress.js';
import { isCollectionId, isCollectionReceiveRequest, isCollectionMaterializeRequest, isCollectionUpdateCopyRequest, isCollectionPolicyRequest, isCollectionAddPhotoRequest, isCollectionChangePhotoRequest, isCollectionMutationResult } from './collection.js';
import { isRegisterReferenceSourceRequest, isRegisterReferenceSourceZipRequest, isRegisterReferenceSourceZipResult, isPublishCatalogRevisionRequest, isSetCatalogMatchRequest, isReferenceSourceVersion, isCatalogRevisionDetail, MAX_REFERENCE_SOURCE_ZIP_BASE64_CHARS } from './reference-catalog.js';
import { isSaveReleaseRequest, isMaterializeCommercialCopyRequest, isSaveCommercialCopyDetailsRequest, isAssignCommercialCopyPhotoRequest, isSaveLegacyRequest, isAddMusicPhotoRequest, isRemoveMusicPhotoRequest, isMusicMutationResult } from './physical-music.js';
import { isConfirmPhysicalLinkRequest, isLegacyConfirmPhysicalLinkRequest, isRelocateDigitalRequest, isRegisterDigitalRequest, isRemovePhysicalLinkRequest, isLegacyRemovePhysicalLinkRequest, isConfirmAbsenceRequest, isPhysicalLinkResult } from './physical-links.js';
import { isAppendMasterDraftRequest, isUpdateMasterDraftRequest, isMasterDraftResult } from './master-drafts.js';
import { isSaveMediaPlanRequest, isReserveMediaRequest, isReleaseMediaRequest, isMediaPlan } from './media-planning.js';
import { isPutRecordingWorkspaceContextRequest, isRecordingWorkspaceContext } from './recording-workspace.js';
import { isFreezeVersionsRequest, isVersionJob } from './master-versions.js';
import { isStartPreparationRequest, isPreparationJob } from './preparation.js';
import { isStartPreparedImportRequest, isFreezePreparedRequest, isPreparedImportJob, isFrozenPrepared } from './prepared-render.js';
import { isSaveRecordingProfileRequest, isSaveRecordingSessionRequest, isRecordingProfileVersion, isRecordingSessionSettings } from './recording-profile.js';
import { isStartExecutionRequest, isExecutionJob } from './execution-assets.js';
import { isInitializeArchiveRequest, isStartArchiveRequest, isArchiveOperationView } from './recording-archive.js';
import { isStartBackupJob, isBackupJobView } from './recording-backups.js';
import { isSourceAction, isSourceConfirmation, isSourceBinding, isSourceRoot, isSourceJob, isSourceSelection, type SourceSelection, type SourceRoot, type SourceJob } from './source-evidence.js';
import { isSelectSourceCandidate } from './source-candidates.js';
import { isPreparedSelection, isSelectPreparedRequest, type SelectPreparedRequest, type PreparedSelection } from './prepared-render.js';
import { isPreparationDestination, type PreparationDestination } from './preparation.js';
import { isArchiveRootView, type ArchiveRootView } from './recording-archive.js';
import { isAuthorizeBackupRoot, isBackupRootView, type AuthorizeBackupRoot, type BackupRootView } from './recording-backups.js';
import { isActivateRestoredDataset, isRestoreActivationView, type ActivateRestoredDataset, type RestoreActivationView } from './recording-activation.js';

/** 只允许原有公开领域写命令，不能从任意 IPC 名称推导重放权限。 */
export const COMMAND_OUTBOX_COMMANDS = [
  'localSourceWrites.setPolicy', 'localSourceWrites.confirm', 'localSourceWrites.undo',
  'localLegacyLinks.confirm', 'localLegacyLinks.revoke', 'localLegacyLinks.undo',
  'localOrganizer.confirm', 'localOrganizer.undo',
  ...LOCAL_CATALOG_OUTBOX_COMMANDS,
  'localArtwork.apply', 'localArtwork.createEdition',
  'localRelocation.confirm','localRelocation.relinkRoot',
  'collectionProgress.saveWant', 'collectionProgress.cancelWant', 'collectionProgress.capture',
  'spreadsheetImports.apply', 'spreadsheetImports.adjust',
  'referenceCatalog.registerSource', 'referenceCatalog.registerSourceZip', 'referenceCatalog.publishRevision', 'referenceCatalog.setMatch',
  'collection.receive', 'collection.materialize', 'collection.updateCopy', 'collection.setPolicy', 'collection.addPhoto', 'collection.changePhoto',
  'physicalMusic.saveRelease', 'physicalMusic.materializeCopy', 'physicalMusic.saveCopyDetails', 'physicalMusic.assignCopyPhoto', 'physicalMusic.saveLegacy', 'physicalMusic.addPhoto', 'physicalMusic.removePhoto',
  'physicalLinks.confirm', 'physicalLinks.confirmWithEvidence', 'physicalLinks.relocate', 'physicalLinks.register', 'physicalLinks.remove', 'physicalLinks.removeWithEvidence', 'physicalLinks.absence',
  'recordingDrafts.append', 'recordingDrafts.update',
  'recordingSources.revoke', 'recordingSources.cancel', 'recordingSources.confirm', 'recordingSources.recheck',
  'recordingCandidates.select',
  'recordingMedia.save', 'recordingMedia.reserve', 'recordingMedia.release',
  'recordingWorkspace.put',
  'recordingVersions.freeze', 'recordingVersions.cancel',
  'recordingPreparation.revoke', 'recordingPreparation.start', 'recordingPreparation.cancel',
  'recordingPrepared.revoke', 'recordingPrepared.startImport', 'recordingPrepared.cancel', 'recordingPrepared.freeze',
  'recordingPlans.freeze',
  'recordingProfiles.save', 'recordingProfiles.saveSession', 'recordingExecution.start', 'recordingExecution.cancel',
  'recordingArchive.initialize', 'recordingArchive.revokeRoot', 'recordingArchive.start', 'recordingArchive.cancel', 'recordingArchive.resume',
  'recordingBackups.start', 'recordingBackups.cancel', 'recordingBackups.revoke',
] as const;
export const COMMAND_OUTBOX_SPECIAL_COMMANDS = [
  'localLibrary.chooseRoot',
  'spreadsheetImports.chooseWorkbook',
  'recordingSources.chooseRoot', 'recordingSources.choose', 'recordingPreparation.chooseDestination',
  'recordingPrepared.choose', 'recordingArchive.choose', 'recordingBackups.choose', 'recordingBackups.activate',
] as const;
export type CommandOutboxCommand = typeof COMMAND_OUTBOX_COMMANDS[number];
export type CommandOutboxSpecialCommand = typeof COMMAND_OUTBOX_SPECIAL_COMMANDS[number];
export type CommandOutboxTrackedCommand = CommandOutboxCommand | CommandOutboxSpecialCommand;
/** 复用叶级领域验证器；不反向导入总 IPC validator，避免运行时模块循环。 */
const ordinaryValidators = {
  'localSourceWrites.setPolicy': [(v: unknown): v is LocalSourceWritesCommandPayloads['localSourceWrites.setPolicy'] => isLocalSourceWritesCommandPayload('localSourceWrites.setPolicy', v), (v: unknown): v is LocalSourceWritesReceipt => isLocalSourceWritesCommandResult('localSourceWrites.setPolicy', v)],
  'localSourceWrites.confirm': [(v: unknown): v is LocalSourceWritesCommandPayloads['localSourceWrites.confirm'] => isLocalSourceWritesCommandPayload('localSourceWrites.confirm', v), (v: unknown): v is LocalSourceWritesReceipt => isLocalSourceWritesCommandResult('localSourceWrites.confirm', v)],
  'localSourceWrites.undo': [(v: unknown): v is LocalSourceWritesCommandPayloads['localSourceWrites.undo'] => isLocalSourceWritesCommandPayload('localSourceWrites.undo', v), (v: unknown): v is LocalSourceWritesReceipt => isLocalSourceWritesCommandResult('localSourceWrites.undo', v)],
  'localLegacyLinks.confirm': [(v: unknown): v is ExecuteLocalLegacyLink => isLocalLegacyLinksCommandPayload('localLegacyLinks.confirm',v), (v: unknown): v is LocalLegacyLinkReceipt => isLocalLegacyLinksCommandResult('localLegacyLinks.confirm',v)],
  'localLegacyLinks.revoke': [(v: unknown): v is ExecuteLocalLegacyLink => isLocalLegacyLinksCommandPayload('localLegacyLinks.revoke',v), (v: unknown): v is LocalLegacyLinkReceipt => isLocalLegacyLinksCommandResult('localLegacyLinks.revoke',v)],
  'localLegacyLinks.undo': [(v: unknown): v is ExecuteLocalLegacyLink => isLocalLegacyLinksCommandPayload('localLegacyLinks.undo',v), (v: unknown): v is LocalLegacyLinkReceipt => isLocalLegacyLinksCommandResult('localLegacyLinks.undo',v)],
  'localArtwork.apply': [isApplyLocalArtworkSelection,isLocalArtworkSelection],
  'localArtwork.createEdition': [isCreateLocalArtworkEdition,isAlbumEdition],
  'localRelocation.confirm':[isLocalRelocationConfirm,(v:unknown):v is import('./local-catalog.js').AudioAsset=>isLocalRelocationCommandResult('localRelocation.confirm',v)],
  'localRelocation.relinkRoot':[isLocalRootRelink,(v:unknown):v is LibraryRoot=>isLocalRelocationCommandResult('localRelocation.relinkRoot',v)],
  'localCatalog.createTrack': [(v: unknown): v is LocalCatalogCommandPayloads['localCatalog.createTrack'] => isLocalCatalogCommandPayload('localCatalog.createTrack', v), (v: unknown): v is LocalCatalogCommandResults['localCatalog.createTrack'] => isLocalCatalogCommandResult('localCatalog.createTrack', v)],
  'localCatalog.selectAsset': [(v: unknown): v is LocalCatalogCommandPayloads['localCatalog.selectAsset'] => isLocalCatalogCommandPayload('localCatalog.selectAsset', v), (v: unknown): v is LocalCatalogCommandResults['localCatalog.selectAsset'] => isLocalCatalogCommandResult('localCatalog.selectAsset', v)],
  'localCatalog.createEdition': [(v: unknown): v is LocalCatalogCommandPayloads['localCatalog.createEdition'] => isLocalCatalogCommandPayload('localCatalog.createEdition', v), (v: unknown): v is LocalCatalogCommandResults['localCatalog.createEdition'] => isLocalCatalogCommandResult('localCatalog.createEdition', v)],
  'localCatalog.linkEditionTrack': [(v: unknown): v is LocalCatalogCommandPayloads['localCatalog.linkEditionTrack'] => isLocalCatalogCommandPayload('localCatalog.linkEditionTrack', v), (v: unknown): v is LocalCatalogCommandResults['localCatalog.linkEditionTrack'] => isLocalCatalogCommandResult('localCatalog.linkEditionTrack', v)],
  'localCatalog.removeEditionTrack': [(v: unknown): v is LocalCatalogCommandPayloads['localCatalog.removeEditionTrack'] => isLocalCatalogCommandPayload('localCatalog.removeEditionTrack', v), (v: unknown): v is LocalCatalogCommandResults['localCatalog.removeEditionTrack'] => isLocalCatalogCommandResult('localCatalog.removeEditionTrack', v)],
  'localCatalog.overrideMetadata': [(v: unknown): v is LocalCatalogCommandPayloads['localCatalog.overrideMetadata'] => isLocalCatalogCommandPayload('localCatalog.overrideMetadata', v), (v: unknown): v is LocalCatalogCommandResults['localCatalog.overrideMetadata'] => isLocalCatalogCommandResult('localCatalog.overrideMetadata', v)],
  'localOrganizer.confirm': [(v: unknown): v is ConfirmLocalOrganizer => isLocalOrganizerCommandPayload('localOrganizer.confirm', v), (v: unknown): v is LocalOrganizerPlan => isLocalOrganizerCommandResult('localOrganizer.confirm', v)],
  'localOrganizer.undo': [(v: unknown): v is ChangeLocalOrganizer => isLocalOrganizerCommandPayload('localOrganizer.undo', v), (v: unknown): v is LocalOrganizerPlan => isLocalOrganizerCommandResult('localOrganizer.undo', v)],

  'collectionProgress.saveWant': [isSaveWantEntryRequest, isWantEntry],
  'collectionProgress.cancelWant': [isCancelWantEntryRequest, isWantEntry],
  'collectionProgress.capture': [isCaptureCollectionProgressRequest, isCollectionProgressSnapshotSummary],
  'spreadsheetImports.apply': [isApplySpreadsheetImportRequest, isSpreadsheetImportResult],
  'spreadsheetImports.adjust': [isAdjustSpreadsheetInventoryRequest, isSpreadsheetInventoryAdjustment],
  'referenceCatalog.registerSource': [isRegisterReferenceSourceRequest, isReferenceSourceVersion],
  'referenceCatalog.registerSourceZip': [isRegisterReferenceSourceZipRequest, isRegisterReferenceSourceZipResult],
  'referenceCatalog.publishRevision': [isPublishCatalogRevisionRequest, isCatalogRevisionDetail],
  'referenceCatalog.setMatch': [isSetCatalogMatchRequest, isCatalogRevisionDetail],
  'collection.receive': [isCollectionReceiveRequest, isCollectionMutationResult],
  'collection.materialize': [isCollectionMaterializeRequest, isCollectionMutationResult],
  'collection.updateCopy': [isCollectionUpdateCopyRequest, isCollectionMutationResult],
  'collection.setPolicy': [isCollectionPolicyRequest, isCollectionMutationResult],
  'collection.addPhoto': [isCollectionAddPhotoRequest, isCollectionMutationResult],
  'collection.changePhoto': [isCollectionChangePhotoRequest, isCollectionMutationResult],
  'physicalMusic.saveRelease': [isSaveReleaseRequest, isMusicMutationResult],
  'physicalMusic.materializeCopy': [isMaterializeCommercialCopyRequest, isMusicMutationResult],
  'physicalMusic.saveCopyDetails': [isSaveCommercialCopyDetailsRequest, isMusicMutationResult],
  'physicalMusic.assignCopyPhoto': [isAssignCommercialCopyPhotoRequest, isMusicMutationResult],
  'physicalMusic.saveLegacy': [isSaveLegacyRequest, isMusicMutationResult],
  'physicalMusic.addPhoto': [isAddMusicPhotoRequest, isMusicMutationResult],
  'physicalMusic.removePhoto': [isRemoveMusicPhotoRequest, isMusicMutationResult],
  'physicalLinks.confirm': [isLegacyConfirmPhysicalLinkRequest, isPhysicalLinkResult],
  'physicalLinks.confirmWithEvidence': [isConfirmPhysicalLinkRequest, isPhysicalLinkResult],
  'physicalLinks.relocate': [isRelocateDigitalRequest, isPhysicalLinkResult],
  'physicalLinks.register': [isRegisterDigitalRequest, isPhysicalLinkResult],
  'physicalLinks.remove': [isLegacyRemovePhysicalLinkRequest, isPhysicalLinkResult],
  'physicalLinks.removeWithEvidence': [isRemovePhysicalLinkRequest, isPhysicalLinkResult],
  'physicalLinks.absence': [isConfirmAbsenceRequest, isPhysicalLinkResult],
  'recordingDrafts.append': [isAppendMasterDraftRequest, isMasterDraftResult],
  'recordingDrafts.update': [isUpdateMasterDraftRequest, isMasterDraftResult],
  'recordingSources.revoke': [isSourceAction, isSourceRoot],
  'recordingSources.cancel': [isSourceAction, isSourceJob],
  'recordingSources.confirm': [isSourceConfirmation, isSourceBinding],
  'recordingSources.recheck': [isSourceConfirmation, isSourceJob],
  'recordingCandidates.select': [isSelectSourceCandidate, isSourceJob],
  'recordingMedia.save': [isSaveMediaPlanRequest, isMediaPlan],
  'recordingMedia.reserve': [isReserveMediaRequest, isMediaPlan],
  'recordingMedia.release': [isReleaseMediaRequest, isMediaPlan],
  'recordingWorkspace.put': [isPutRecordingWorkspaceContextRequest, isRecordingWorkspaceContext],
  'recordingVersions.freeze': [isFreezeVersionsRequest, isVersionJob],
  'recordingVersions.cancel': [isSourceAction, isVersionJob],
  'recordingPreparation.revoke': [isSourceAction, isPreparationDestination],
  'recordingPreparation.start': [isStartPreparationRequest, isPreparationJob],
  'recordingPreparation.cancel': [isSourceAction, isPreparationJob],
  'recordingPrepared.revoke': [isSourceAction, isPreparedSelection],
  'recordingPrepared.startImport': [isStartPreparedImportRequest, isPreparedImportJob],
  'recordingPrepared.cancel': [isSourceAction, isPreparedImportJob],
  'recordingPrepared.freeze': [isFreezePreparedRequest, isFrozenPrepared],
  'recordingPlans.freeze': [isFreezeRecordingPlanRequest, isRecordingPlanVersion],
  'recordingProfiles.save': [isSaveRecordingProfileRequest, isRecordingProfileVersion],
  'recordingProfiles.saveSession': [isSaveRecordingSessionRequest, isRecordingSessionSettings],
  'recordingExecution.start': [isStartExecutionRequest, isExecutionJob],
  'recordingExecution.cancel': [isSourceAction, isExecutionJob],
  'recordingArchive.initialize': [isInitializeArchiveRequest, isArchiveRootView],
  'recordingArchive.revokeRoot': [isSourceAction, isArchiveRootView],
  'recordingArchive.start': [isStartArchiveRequest, isArchiveOperationView],
  'recordingArchive.cancel': [isSourceAction, isArchiveOperationView],
  'recordingArchive.resume': [isSourceAction, isArchiveOperationView],
  'recordingBackups.start': [isStartBackupJob, isBackupJobView],
  'recordingBackups.cancel': [isSourceAction, isBackupJobView],
  'recordingBackups.revoke': [isSourceAction, isBackupRootView],
} as const satisfies Record<CommandOutboxCommand, readonly [(value: unknown) => boolean, (value: unknown) => boolean]>;
type Guarded<F> = F extends (value: unknown) => value is infer V ? V : never;
export type CommandOutboxExecute = { [C in CommandOutboxCommand]: { datasetId: string; command: C; payload: Guarded<typeof ordinaryValidators[C][0]> } }[CommandOutboxCommand];
export type CommandOutboxResult = { [C in CommandOutboxCommand]: { command: C; result: Guarded<typeof ordinaryValidators[C][1]> } }[CommandOutboxCommand];
export interface CommandOutboxSpecialPayloads {
  'localLibrary.chooseRoot':{commandId:string};
  'spreadsheetImports.chooseWorkbook': ChooseSpreadsheetWorkbookRequest;
  'recordingSources.chooseRoot': { commandId: string };
  'recordingSources.choose': SourceSelection;
  'recordingPreparation.chooseDestination': { commandId: string };
  'recordingPrepared.choose': SelectPreparedRequest;
  'recordingArchive.choose': { commandId: string };
  'recordingBackups.choose': AuthorizeBackupRoot;
  'recordingBackups.activate': ActivateRestoredDataset;
}
export interface CommandOutboxSpecialResults {
  'localLibrary.chooseRoot':LibraryRoot|null;
  'spreadsheetImports.chooseWorkbook': SpreadsheetWorkbookSource | null;
  'recordingSources.chooseRoot': SourceRoot | null;
  'recordingSources.choose': SourceJob | null;
  'recordingPreparation.chooseDestination': PreparationDestination | null;
  'recordingPrepared.choose': PreparedSelection | null;
  'recordingArchive.choose': ArchiveRootView | null;
  'recordingBackups.choose': BackupRootView | null;
  'recordingBackups.activate': RestoreActivationView;
}
export type CommandOutboxRequest = CommandOutboxExecute | { [C in CommandOutboxSpecialCommand]: { datasetId: string; command: C; payload: CommandOutboxSpecialPayloads[C] } }[CommandOutboxSpecialCommand];
export type CommandOutboxDispatchResult = CommandOutboxResult | { [C in CommandOutboxSpecialCommand]: { command: C; result: CommandOutboxSpecialResults[C] } }[CommandOutboxSpecialCommand];
export interface CommandOutboxContext { datasetId: string }
export const MAX_COMMAND_OUTBOX_PAYLOAD_BYTES = 2 * 1024 * 1024;
/** 两万行人工对应及公式确认只携带定位信息，不包含工作簿或原始单元格。 */
export const MAX_COMMAND_OUTBOX_SPREADSHEET_APPLY_BYTES = 3 * 1024 * 1024;
/** 仅带图参考目录可使用较大信封；留出命令、基线及工作库字段开销。 */
export const MAX_COMMAND_OUTBOX_REFERENCE_REVISION_BYTES = 4 * 1024 * 1024 + 4096;
/** 单份有界 ZIP 的 base64 信封；成功回执只存摘要，不在目录库归档原容器。 */
export const MAX_COMMAND_OUTBOX_REFERENCE_ZIP_BYTES = MAX_REFERENCE_SOURCE_ZIP_BASE64_CHARS + 4096;
export const MAX_COMMAND_OUTBOX_TOTAL_BYTES = 64 * 1024 * 1024;
export const MAX_COMMAND_OUTBOX_ENTRIES = 1000;
export const COMMAND_OUTBOX_STATES = ['pending', 'sending', 'uncertain', 'succeeded', 'rejected', 'dismissed'] as const;
export const COMMAND_OUTBOX_ERROR_CODES = [
  'OUTBOX_UNAVAILABLE', 'OUTBOX_CONFLICT', 'OUTBOX_SCOPE_MISMATCH', 'OUTBOX_LIMIT_EXCEEDED', 'OUTBOX_RESULT_UNKNOWN',
  'INVALID_IPC_REQUEST', 'INVALID_IPC_RESPONSE', 'INVENTORY_CONFLICT', 'INVENTORY_UNAVAILABLE', 'BACKUP_CONFLICT',
  'NOT_READY', 'TIMEOUT', 'INTERNAL_ERROR', 'ROON_LIBRARY_UNAVAILABLE', 'ROON_CORE_NOT_CONNECTED',
] as const;
export type CommandOutboxState = typeof COMMAND_OUTBOX_STATES[number];
export type CommandOutboxErrorCode = typeof COMMAND_OUTBOX_ERROR_CODES[number];
export interface CommandOutboxView {
  id: string; commandId: string; command: CommandOutboxTrackedCommand; datasetId: string; state: CommandOutboxState;
  createdAt: string; updatedAt: string; errorCode?: CommandOutboxErrorCode; acknowledged: boolean; canRetry: boolean;
  /** 仅三 Source 动作的原 public 请求指纹；旧域没有此键，不能用它再次授权。 */
  sourceRequestFingerprint?: string;
}
export interface CommandOutboxOverview { datasetId: string; entries: readonly CommandOutboxView[] }
export interface CommandOutboxAction { id: string; userConfirmed: true }
export interface CommandOutboxAcknowledge { id: string }
export interface CommandOutboxPublicApi {
  getCommandOutbox(): Promise<CommandOutboxOverview>;
  retryCommandOutbox(request: CommandOutboxAction): Promise<CommandOutboxView>;
  dismissCommandOutbox(request: CommandOutboxAction): Promise<CommandOutboxView>;
  acknowledgeCommandOutbox(request: CommandOutboxAcknowledge): Promise<CommandOutboxView>;
}
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(v).every(k => allowed.includes(k));
export const isCommandOutboxDatasetId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(v);
export const isCommandOutboxCommand = (v: unknown): v is CommandOutboxCommand => typeof v === 'string' && (COMMAND_OUTBOX_COMMANDS as readonly string[]).includes(v);
export const isCommandOutboxTrackedCommand = (v: unknown): v is CommandOutboxTrackedCommand => isCommandOutboxCommand(v) || typeof v === 'string' && (COMMAND_OUTBOX_SPECIAL_COMMANDS as readonly string[]).includes(v);
export function isCommandOutboxContext(v: unknown): v is CommandOutboxContext { return record(v) && keys(v, ['datasetId']) && isCommandOutboxDatasetId(v.datasetId); }
function envelope(v: unknown): v is Record<string, unknown> {
  if (!record(v) || !keys(v, ['datasetId', 'command', 'payload']) || !isCommandOutboxDatasetId(v.datasetId) || !record(v.payload) || !isCollectionId(v.payload.commandId)) return false;
  const limit = v.command === 'spreadsheetImports.apply' ? MAX_COMMAND_OUTBOX_SPREADSHEET_APPLY_BYTES
    : v.command === 'referenceCatalog.publishRevision' ? MAX_COMMAND_OUTBOX_REFERENCE_REVISION_BYTES
    : v.command === 'referenceCatalog.registerSourceZip' ? MAX_COMMAND_OUTBOX_REFERENCE_ZIP_BYTES : MAX_COMMAND_OUTBOX_PAYLOAD_BYTES;
  try { return new TextEncoder().encode(JSON.stringify(v)).byteLength <= limit; } catch { return false; }
}
/** 信封先捕获 own data 字段；旧 payload 保留既有 validator/canonical 语义。 */
function observedOutboxEnvelope(v: unknown): Record<string, unknown> | null {
  try {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
    const names = Reflect.ownKeys(v), copy: Record<string, unknown> = {};
    if (names.length !== 3 || !['datasetId','command','payload'].every(k => names.includes(k))) return null;
    for (const key of names) {
      if (typeof key !== 'string' || !['datasetId','command','payload'].includes(key)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(v,key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor,'value')) return null;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch { return null; }
}
export function isCommandOutboxExecute(v: unknown): v is CommandOutboxExecute {
  const observed = observedOutboxEnvelope(v); if (!observed) return false;
  try {
    const command = observed.command;
    if (typeof command === 'string' && command.startsWith('localSourceWrites.')) {
      const copy = localSourceWritesDataSnapshot(v, MAX_COMMAND_OUTBOX_PAYLOAD_BYTES, 8192, 100);
      return localSourceWritesRecord(copy, ['datasetId', 'command', 'payload']) && copy.command === command && isLocalSourceWritesOutboxCommand(command)
        && isCommandOutboxDatasetId(copy.datasetId) && isLocalSourceWritesCommandPayload(command, copy.payload) && copy.payload.datasetId === copy.datasetId;
    }
    if (command === 'localLegacyLinks.confirm' || command === 'localLegacyLinks.revoke' || command === 'localLegacyLinks.undo') {
      const copy = localLegacyLinksDataSnapshot(v, MAX_COMMAND_OUTBOX_PAYLOAD_BYTES, 2048, 100);
      return localLegacyRecord(copy, ['datasetId','command','payload']) && copy.command === command && isCommandOutboxDatasetId(copy.datasetId) && isLocalLegacyLinksCommandPayload(command, copy.payload);
    }
  } catch { return false; }
  return envelope(observed) && isCommandOutboxCommand(observed.command) && ordinaryValidators[observed.command][0](observed.payload);
}
export function isCommandOutboxRequest(v: unknown): v is CommandOutboxRequest {
  const observed = observedOutboxEnvelope(v); if (!observed) return false;
  try {
    const command = observed.command;
    if (typeof command === 'string' && command.startsWith('localSourceWrites.')) {
      const copy = localSourceWritesDataSnapshot(v, MAX_COMMAND_OUTBOX_PAYLOAD_BYTES, 8192, 100);
      return localSourceWritesRecord(copy, ['datasetId', 'command', 'payload']) && copy.command === command && isLocalSourceWritesOutboxCommand(command)
        && isCommandOutboxDatasetId(copy.datasetId) && isLocalSourceWritesCommandPayload(command, copy.payload) && copy.payload.datasetId === copy.datasetId;
    }
    if (command === 'localLegacyLinks.confirm' || command === 'localLegacyLinks.revoke' || command === 'localLegacyLinks.undo') {
      const copy = localLegacyLinksDataSnapshot(v, MAX_COMMAND_OUTBOX_PAYLOAD_BYTES, 2048, 100);
      return localLegacyRecord(copy, ['datasetId','command','payload']) && copy.command === command && isCommandOutboxDatasetId(copy.datasetId) && isLocalLegacyLinksCommandPayload(command, copy.payload);
    }
  } catch { return false; }
  v = observed;
  if (!envelope(v)) return false;
  if (isCommandOutboxCommand(v.command)) return isCommandOutboxExecute(v);
  switch (v.command) {
    case 'localLibrary.chooseRoot': return record(v.payload) && Reflect.ownKeys(v.payload).length===1 && Object.prototype.propertyIsEnumerable.call(v.payload,'commandId') && isCollectionId(v.payload.commandId);
    case 'recordingSources.chooseRoot': case 'recordingPreparation.chooseDestination': case 'recordingArchive.choose': return record(v.payload) && keys(v.payload, ['commandId']);
    case 'recordingSources.choose': return isSourceSelection(v.payload);
    case 'recordingPrepared.choose': return isSelectPreparedRequest(v.payload);
    case 'recordingBackups.choose': return isAuthorizeBackupRoot(v.payload);
    case 'spreadsheetImports.chooseWorkbook': return isChooseSpreadsheetWorkbookRequest(v.payload);
    case 'recordingBackups.activate': return isActivateRestoredDataset(v.payload);
    default: return false;
  }
}
export function isCommandOutboxResult(v: unknown): v is CommandOutboxResult {
  try {
    const descriptor = v !== null && typeof v === 'object' ? Object.getOwnPropertyDescriptor(v, 'command') : undefined;
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return false;
    const command: unknown = descriptor.value;
    if (typeof command === 'string' && command.startsWith('localSourceWrites.')) {
      const copy = localSourceWritesDataSnapshot(v, 16384, 2048, 100);
      return localSourceWritesRecord(copy, ['command', 'result']) && copy.command === command && isLocalSourceWritesOutboxCommand(command) && isLocalSourceWritesCommandResult(command, copy.result);
    }
  } catch { return false; }
  return record(v) && keys(v, ['command', 'result']) && isCommandOutboxCommand(v.command)
    && ordinaryValidators[v.command][1](v.result);
}
export function isCommandOutboxDispatchResult(v: unknown): v is CommandOutboxDispatchResult {
  try {
    const descriptor = v !== null && typeof v === 'object' ? Object.getOwnPropertyDescriptor(v, 'command') : undefined;
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return false;
    const command: unknown = descriptor.value;
    if (typeof command === 'string' && command.startsWith('localSourceWrites.')) {
      const copy = localSourceWritesDataSnapshot(v, 16384, 2048, 100);
      return localSourceWritesRecord(copy, ['command', 'result']) && copy.command === command && isLocalSourceWritesOutboxCommand(command) && isLocalSourceWritesCommandResult(command, copy.result);
    }
  } catch { return false; }
  if (!record(v) || !keys(v, ['command', 'result'])) return false;
  if (isCommandOutboxCommand(v.command)) return isCommandOutboxResult(v);
  switch (v.command) {
    case 'localLibrary.chooseRoot': return v.result===null || isLocalRelocationCommandResult('localRelocation.registerRoot',v.result);
    case 'recordingSources.chooseRoot': return v.result === null || isSourceRoot(v.result);
    case 'recordingSources.choose': return v.result === null || isSourceJob(v.result);
    case 'recordingPreparation.chooseDestination': return v.result === null || isPreparationDestination(v.result);
    case 'recordingPrepared.choose': return v.result === null || isPreparedSelection(v.result);
    case 'recordingArchive.choose': return v.result === null || isArchiveRootView(v.result);
    case 'recordingBackups.choose': return v.result === null || isBackupRootView(v.result);
    case 'spreadsheetImports.chooseWorkbook': return v.result === null || isSpreadsheetWorkbookSource(v.result);
    case 'recordingBackups.activate': return isRestoreActivationView(v.result);
    default: return false;
  }
}
const timestamp = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(v) && Number.isFinite(Date.parse(v));
export function isCommandOutboxView(v: unknown): v is CommandOutboxView {
  try {
    const descriptor = v !== null && typeof v === 'object' ? Object.getOwnPropertyDescriptor(v, 'command') : undefined;
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return false;
    const command: unknown = descriptor.value;
    if (typeof command === 'string' && command.startsWith('localSourceWrites.')) {
      const value = localSourceWritesDataSnapshot(v, 16384, 2048, 100);
      return localSourceWritesRecord(value, ['id', 'commandId', 'command', 'datasetId', 'state', 'createdAt', 'updatedAt', 'acknowledged', 'canRetry'], ['errorCode', 'sourceRequestFingerprint'])
        && value.command === command && isLocalSourceWritesOutboxCommand(command) && isCollectionId(value.id) && isCollectionId(value.commandId) && isCommandOutboxDatasetId(value.datasetId)
        && (COMMAND_OUTBOX_STATES as readonly unknown[]).includes(value.state) && timestamp(value.createdAt) && timestamp(value.updatedAt)
        && (!Object.hasOwn(value, 'errorCode') || (COMMAND_OUTBOX_ERROR_CODES as readonly unknown[]).includes(value.errorCode))
        && (!Object.hasOwn(value, 'sourceRequestFingerprint') || isLocalSourceWritesHash(value.sourceRequestFingerprint))
        && typeof value.acknowledged === 'boolean' && value.canRetry === false;
    }
  } catch { return false; }
  return record(v) && keys(v, ['id', 'commandId', 'command', 'datasetId', 'state', 'createdAt', 'updatedAt', 'errorCode', 'acknowledged', 'canRetry'])
    && isCollectionId(v.id) && isCollectionId(v.commandId) && isCommandOutboxTrackedCommand(v.command) && isCommandOutboxDatasetId(v.datasetId)
    && (COMMAND_OUTBOX_STATES as readonly unknown[]).includes(v.state) && timestamp(v.createdAt) && timestamp(v.updatedAt)
    && (v.errorCode === undefined || (COMMAND_OUTBOX_ERROR_CODES as readonly unknown[]).includes(v.errorCode))
    && typeof v.acknowledged === 'boolean' && typeof v.canRetry === 'boolean';
}
export function isCommandOutboxOverview(v: unknown): v is CommandOutboxOverview {
  return record(v) && keys(v, ['datasetId', 'entries']) && isCommandOutboxDatasetId(v.datasetId) && Array.isArray(v.entries)
    && v.entries.length <= MAX_COMMAND_OUTBOX_ENTRIES && v.entries.every(isCommandOutboxView) && new Set(v.entries.map(e => e.id)).size === v.entries.length;
}
export function isCommandOutboxAction(v: unknown): v is CommandOutboxAction { return record(v) && keys(v, ['id', 'userConfirmed']) && isCollectionId(v.id) && v.userConfirmed === true; }
export function isCommandOutboxAcknowledge(v: unknown): v is CommandOutboxAcknowledge { return record(v) && keys(v, ['id']) && isCollectionId(v.id); }
import { isLocalOrganizerCommandPayload, isLocalOrganizerCommandResult, type ConfirmLocalOrganizer, type ChangeLocalOrganizer, type LocalOrganizerPlan } from './local-organizer.js';
