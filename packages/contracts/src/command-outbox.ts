import { isCollectionId, isCollectionReceiveRequest, isCollectionMaterializeRequest, isCollectionUpdateCopyRequest, isCollectionPolicyRequest, isCollectionAddPhotoRequest, isCollectionChangePhotoRequest, isCollectionMutationResult } from './collection.js';
import { isSaveReleaseRequest, isSaveLegacyRequest, isAddMusicPhotoRequest, isRemoveMusicPhotoRequest, isMusicMutationResult } from './physical-music.js';
import { isConfirmPhysicalLinkRequest, isRelocateDigitalRequest, isRegisterDigitalRequest, isRemovePhysicalLinkRequest, isConfirmAbsenceRequest, isPhysicalLinkResult } from './physical-links.js';
import { isAppendMasterDraftRequest, isUpdateMasterDraftRequest, isMasterDraftResult } from './master-drafts.js';
import { isSaveMediaPlanRequest, isReserveMediaRequest, isReleaseMediaRequest, isMediaPlan } from './media-planning.js';
import { isFreezeVersionsRequest, isVersionJob } from './master-versions.js';
import { isStartPreparationRequest, isPreparationJob } from './preparation.js';
import { isStartPreparedImportRequest, isFreezePreparedRequest, isPreparedImportJob, isFrozenPrepared } from './prepared-render.js';
import { isSaveRecordingProfileRequest, isSaveRecordingSessionRequest, isRecordingProfileVersion, isRecordingSessionSettings } from './recording-profile.js';
import { isStartExecutionRequest, isExecutionJob } from './execution-assets.js';
import { isInitializeArchiveRequest, isStartArchiveRequest, isArchiveOperationView } from './recording-archive.js';
import { isStartBackupJob, isBackupJobView } from './recording-backups.js';
import { isSourceAction, isSourceConfirmation, isSourceBinding, isSourceRoot, isSourceJob, isSourceSelection, type SourceSelection, type SourceRoot, type SourceJob } from './source-evidence.js';
import { isPreparedSelection, isSelectPreparedRequest, type SelectPreparedRequest, type PreparedSelection } from './prepared-render.js';
import { isPreparationDestination, type PreparationDestination } from './preparation.js';
import { isArchiveRootView, type ArchiveRootView } from './recording-archive.js';
import { isAuthorizeBackupRoot, isBackupRootView, type AuthorizeBackupRoot, type BackupRootView } from './recording-backups.js';
import { isActivateRestoredDataset, isRestoreActivationView, type ActivateRestoredDataset, type RestoreActivationView } from './recording-activation.js';

/** 只允许原有公开领域写命令，不能从任意 IPC 名称推导重放权限。 */
export const COMMAND_OUTBOX_COMMANDS = [
  'collection.receive', 'collection.materialize', 'collection.updateCopy', 'collection.setPolicy', 'collection.addPhoto', 'collection.changePhoto',
  'physicalMusic.saveRelease', 'physicalMusic.saveLegacy', 'physicalMusic.addPhoto', 'physicalMusic.removePhoto',
  'physicalLinks.confirm', 'physicalLinks.relocate', 'physicalLinks.register', 'physicalLinks.remove', 'physicalLinks.absence',
  'recordingDrafts.append', 'recordingDrafts.update',
  'recordingSources.revoke', 'recordingSources.cancel', 'recordingSources.confirm', 'recordingSources.recheck',
  'recordingMedia.save', 'recordingMedia.reserve', 'recordingMedia.release',
  'recordingVersions.freeze', 'recordingVersions.cancel',
  'recordingPreparation.revoke', 'recordingPreparation.start', 'recordingPreparation.cancel',
  'recordingPrepared.revoke', 'recordingPrepared.startImport', 'recordingPrepared.cancel', 'recordingPrepared.freeze',
  'recordingProfiles.save', 'recordingProfiles.saveSession', 'recordingExecution.start', 'recordingExecution.cancel',
  'recordingArchive.initialize', 'recordingArchive.revokeRoot', 'recordingArchive.start', 'recordingArchive.cancel', 'recordingArchive.resume',
  'recordingBackups.start', 'recordingBackups.cancel', 'recordingBackups.revoke',
] as const;
export const COMMAND_OUTBOX_SPECIAL_COMMANDS = [
  'recordingSources.chooseRoot', 'recordingSources.choose', 'recordingPreparation.chooseDestination',
  'recordingPrepared.choose', 'recordingArchive.choose', 'recordingBackups.choose', 'recordingBackups.activate',
] as const;
export type CommandOutboxCommand = typeof COMMAND_OUTBOX_COMMANDS[number];
export type CommandOutboxSpecialCommand = typeof COMMAND_OUTBOX_SPECIAL_COMMANDS[number];
export type CommandOutboxTrackedCommand = CommandOutboxCommand | CommandOutboxSpecialCommand;
/** 复用叶级领域验证器；不反向导入总 IPC validator，避免运行时模块循环。 */
const ordinaryValidators = {
  'collection.receive': [isCollectionReceiveRequest, isCollectionMutationResult],
  'collection.materialize': [isCollectionMaterializeRequest, isCollectionMutationResult],
  'collection.updateCopy': [isCollectionUpdateCopyRequest, isCollectionMutationResult],
  'collection.setPolicy': [isCollectionPolicyRequest, isCollectionMutationResult],
  'collection.addPhoto': [isCollectionAddPhotoRequest, isCollectionMutationResult],
  'collection.changePhoto': [isCollectionChangePhotoRequest, isCollectionMutationResult],
  'physicalMusic.saveRelease': [isSaveReleaseRequest, isMusicMutationResult],
  'physicalMusic.saveLegacy': [isSaveLegacyRequest, isMusicMutationResult],
  'physicalMusic.addPhoto': [isAddMusicPhotoRequest, isMusicMutationResult],
  'physicalMusic.removePhoto': [isRemoveMusicPhotoRequest, isMusicMutationResult],
  'physicalLinks.confirm': [isConfirmPhysicalLinkRequest, isPhysicalLinkResult],
  'physicalLinks.relocate': [isRelocateDigitalRequest, isPhysicalLinkResult],
  'physicalLinks.register': [isRegisterDigitalRequest, isPhysicalLinkResult],
  'physicalLinks.remove': [isRemovePhysicalLinkRequest, isPhysicalLinkResult],
  'physicalLinks.absence': [isConfirmAbsenceRequest, isPhysicalLinkResult],
  'recordingDrafts.append': [isAppendMasterDraftRequest, isMasterDraftResult],
  'recordingDrafts.update': [isUpdateMasterDraftRequest, isMasterDraftResult],
  'recordingSources.revoke': [isSourceAction, isSourceRoot],
  'recordingSources.cancel': [isSourceAction, isSourceJob],
  'recordingSources.confirm': [isSourceConfirmation, isSourceBinding],
  'recordingSources.recheck': [isSourceConfirmation, isSourceJob],
  'recordingMedia.save': [isSaveMediaPlanRequest, isMediaPlan],
  'recordingMedia.reserve': [isReserveMediaRequest, isMediaPlan],
  'recordingMedia.release': [isReleaseMediaRequest, isMediaPlan],
  'recordingVersions.freeze': [isFreezeVersionsRequest, isVersionJob],
  'recordingVersions.cancel': [isSourceAction, isVersionJob],
  'recordingPreparation.revoke': [isSourceAction, isPreparationDestination],
  'recordingPreparation.start': [isStartPreparationRequest, isPreparationJob],
  'recordingPreparation.cancel': [isSourceAction, isPreparationJob],
  'recordingPrepared.revoke': [isSourceAction, isPreparedSelection],
  'recordingPrepared.startImport': [isStartPreparedImportRequest, isPreparedImportJob],
  'recordingPrepared.cancel': [isSourceAction, isPreparedImportJob],
  'recordingPrepared.freeze': [isFreezePreparedRequest, isFrozenPrepared],
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
  'recordingSources.chooseRoot': { commandId: string };
  'recordingSources.choose': SourceSelection;
  'recordingPreparation.chooseDestination': { commandId: string };
  'recordingPrepared.choose': SelectPreparedRequest;
  'recordingArchive.choose': { commandId: string };
  'recordingBackups.choose': AuthorizeBackupRoot;
  'recordingBackups.activate': ActivateRestoredDataset;
}
export interface CommandOutboxSpecialResults {
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
  try { return new TextEncoder().encode(JSON.stringify(v)).byteLength <= MAX_COMMAND_OUTBOX_PAYLOAD_BYTES; } catch { return false; }
}
export function isCommandOutboxExecute(v: unknown): v is CommandOutboxExecute {
  return envelope(v) && isCommandOutboxCommand(v.command) && ordinaryValidators[v.command][0](v.payload);
}
export function isCommandOutboxRequest(v: unknown): v is CommandOutboxRequest {
  if (!envelope(v)) return false;
  if (isCommandOutboxCommand(v.command)) return isCommandOutboxExecute(v);
  switch (v.command) {
    case 'recordingSources.chooseRoot': case 'recordingPreparation.chooseDestination': case 'recordingArchive.choose': return record(v.payload) && keys(v.payload, ['commandId']);
    case 'recordingSources.choose': return isSourceSelection(v.payload);
    case 'recordingPrepared.choose': return isSelectPreparedRequest(v.payload);
    case 'recordingBackups.choose': return isAuthorizeBackupRoot(v.payload);
    case 'recordingBackups.activate': return isActivateRestoredDataset(v.payload);
    default: return false;
  }
}
export function isCommandOutboxResult(v: unknown): v is CommandOutboxResult {
  return record(v) && keys(v, ['command', 'result']) && isCommandOutboxCommand(v.command)
    && ordinaryValidators[v.command][1](v.result);
}
export function isCommandOutboxDispatchResult(v: unknown): v is CommandOutboxDispatchResult {
  if (!record(v) || !keys(v, ['command', 'result'])) return false;
  if (isCommandOutboxCommand(v.command)) return isCommandOutboxResult(v);
  switch (v.command) {
    case 'recordingSources.chooseRoot': return v.result === null || isSourceRoot(v.result);
    case 'recordingSources.choose': return v.result === null || isSourceJob(v.result);
    case 'recordingPreparation.chooseDestination': return v.result === null || isPreparationDestination(v.result);
    case 'recordingPrepared.choose': return v.result === null || isPreparedSelection(v.result);
    case 'recordingArchive.choose': return v.result === null || isArchiveRootView(v.result);
    case 'recordingBackups.choose': return v.result === null || isBackupRootView(v.result);
    case 'recordingBackups.activate': return isRestoreActivationView(v.result);
    default: return false;
  }
}
const timestamp = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(v) && Number.isFinite(Date.parse(v));
export function isCommandOutboxView(v: unknown): v is CommandOutboxView {
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
