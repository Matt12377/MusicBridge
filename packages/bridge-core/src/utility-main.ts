import { RecordingPrintError } from './recording/print-integrity.js';
import { RecordingReplicaError } from './recording/replica-error.js';
import { AttemptError } from './recording/attempt-integrity.js';
import { RecordingRecordError } from './recording/record-integrity.js';
import { OutputCheckError } from './recording/output-error.js';
import type { PinnedOutputHelper } from './recording/bundled-output-helper.js';
import { RecordingPlanError } from './recording/plan-integrity.js';
import { BackupWorkflowError } from './recording/backup-workflow-store.js';
import { readSpreadsheetFile, SpreadsheetReadError } from './collection/spreadsheet-files.js';
import { parseSpreadsheetWorkbook, SpreadsheetParseError } from './collection/spreadsheet-parser.js';
import { DatasetScopeError } from './recording/dataset-identity.js';
import { createSyntheticRoonLibrary } from './roon/synthetic-library.js';
import { appendFileSync, chmodSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CollectionError, type CollectionRepository } from './collection/repository.js';
import { openCollectionDataset } from './recording/restore-dataset-runtime.js';
import {
  IPC_VERSION,
  parseIpcRuntimeMessage,
  validateIpcRequest,
  isCommandOutboxExecute,
  type IpcCommand,
  type IpcCommandPayloads,
  type IpcFailure,
  type IpcRequest,
  type IpcResponse,
  type RoonImageShapeSummary,
} from '@music-bridge/contracts';
import { asBridgeError, BridgeError } from './shared/errors.js';
import {
  createBridgeRuntime,
  createTestBridgeRuntime,
  type CoreRuntime,
  type CoreRuntimeEvent,
} from './runtime.js';
import type { RoonTimeShapeSummary } from './roon/adapter.js';
import type { RoonBrowseShapeSummary } from './roon/library.js';
import { createLyricsMatchRepository } from './lyrics-matching/repository.js';
import type { FfmpegConverter } from './recording/audio-converter.js';

export interface UtilityPort {
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown;
  start(): void;
  postMessage(message: unknown): void;
}

export type CoreRuntimeForIpc = CoreRuntime;

interface MessageWithPorts {
  data: unknown;
  ports?: readonly UtilityPort[];
}

interface ParentPortLike {
  once(event: 'message', listener: (event: MessageWithPorts) => void): unknown;
}

interface ProcessWithParentPort {
  parentPort?: ParentPortLike | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function responseFailure(
  id: string,
  code: IpcFailure['error']['code'],
  message: string,
): IpcFailure {
  return {
    version: IPC_VERSION,
    id,
    ok: false,
    error: { code, message },
  };
}

function requestId(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.id !== 'string') return undefined;
  if (value.id.trim().length === 0 || value.id.length > 128) return undefined;
  return value.id;
}

function failureForError(id: string, error: unknown): IpcFailure {
  if (error instanceof RecordingPrintError) {
    const code = error.code === 'INVALID_REQUEST' ? 'INVALID_IPC_REQUEST' : error.code === 'CLOSED' ? 'NOT_READY'
      : error.code === 'CONFLICT' || error.code === 'COMMAND_CONFLICT' ? 'INVENTORY_CONFLICT' : 'INVENTORY_UNAVAILABLE';
    return responseFailure(id, code, '印刷资料操作未获确认，请核对档案、版本与生成状态；原录音与历史PDF不会改写。');
  }

  if (error instanceof RecordingReplicaError) {
    const code = error.code === 'INVALID_REQUEST' ? 'INVALID_IPC_REQUEST' : error.code === 'BACKEND_UNAVAILABLE' ? 'NOT_READY'
      : error.code === 'RUN_CONFLICT' || error.code === 'READ_CONFLICT' ? 'INVENTORY_CONFLICT' : error.code === 'TIMEOUT' ? 'TIMEOUT' : 'INVENTORY_UNAVAILABLE';
    return responseFailure(id, code, '历史音频操作未获确认，请核对原档案与会话；不会自动替换来源或重新播放。');
  }
  if (error instanceof RecordingRecordError) {
    const code = error.code === 'INVALID_REQUEST' ? 'INVALID_IPC_REQUEST' : error.code === 'NOT_READY' ? 'NOT_READY'
      : error.code === 'CONFLICT' || error.code === 'COMMAND_CONFLICT' ? 'INVENTORY_CONFLICT' : 'INVENTORY_UNAVAILABLE';
    return responseFailure(id, code, '档案操作未获确认，请刷新当前实体状态；历史档案不会因此改写。');
  }
  if (error instanceof AttemptError) {
    const code = error.code === 'BACKEND_NOT_CERTIFIED' ? 'NOT_READY' : error.code === 'INVALID_REQUEST' ? 'INVALID_IPC_REQUEST'
      : ['PLAN_CHANGED', 'COPY_UNAVAILABLE', 'ATTEMPT_CONFLICT', 'VERSION_MISMATCH', 'INVALID_TRANSITION', 'COMMAND_CONFLICT'].includes(error.code) ? 'INVENTORY_CONFLICT' : 'INVENTORY_UNAVAILABLE';
    return responseFailure(id, code, '录音操作未获确认，请刷新计划与录音状态；未认证后端不能开始正式录音。');
  }
  if (error instanceof OutputCheckError) return responseFailure(id, 'INVENTORY_CONFLICT', error.message);
  if (error instanceof RecordingPlanError) return responseFailure(id, 'INVENTORY_CONFLICT', error.message);
  if (error instanceof DatasetScopeError) return responseFailure(id, error.code, error.message);
  if (error instanceof BackupWorkflowError) return responseFailure(id, error.code === 'BACKUP_CONFLICT' ? 'INVENTORY_CONFLICT' : 'INVENTORY_UNAVAILABLE', error.message);
  if (error instanceof CollectionError) return responseFailure(id, error.code, error.message);
  if (error instanceof SpreadsheetReadError || error instanceof SpreadsheetParseError) return responseFailure(id, 'INVALID_IPC_REQUEST', error.message);
  const bridgeError = asBridgeError(error);
  if (bridgeError.code === 'NETEASE_NOT_CONFIGURED') {
    return responseFailure(id, 'AUTH_REQUIRED', 'Provider login required');
  }
  if (bridgeError.code === 'AUTH_EXPIRED') {
    return responseFailure(id, 'AUTH_EXPIRED', 'Provider session expired');
  }
  if (bridgeError.code === 'ACCOUNT_PROFILE_UNAVAILABLE') {
    return responseFailure(id, 'ACCOUNT_PROFILE_UNAVAILABLE', 'Account profile is temporarily unavailable');
  }
  if (bridgeError.code === 'DAILY_RECOMMENDATIONS_UNAVAILABLE') {
    return responseFailure(id, 'DAILY_RECOMMENDATIONS_UNAVAILABLE', 'Daily recommendations are temporarily unavailable');
  }
  if (bridgeError.code === 'ROON_NOT_PAIRED') {
    return responseFailure(id, 'ROON_CORE_NOT_CONNECTED', 'Roon Core is not connected');
  }
  if (bridgeError.code === 'ROON_ZONE_NOT_SELECTED') {
    return responseFailure(id, 'ROON_ZONE_NOT_SELECTED', 'Roon Zone is not selected');
  }
  if (bridgeError.code === 'ROON_TRANSPORT_UNAVAILABLE') {
    return responseFailure(id, 'NOT_READY', 'Roon Transport is not ready for this request');
  }
  if (bridgeError.code === 'ROON_LIBRARY_UNAVAILABLE') {
    return responseFailure(id, 'ROON_LIBRARY_UNAVAILABLE', 'Roon Library is not available');
  }
  if (bridgeError.code === 'ROON_LIBRARY_REQUEST_FAILED') {
    return responseFailure(id, 'ROON_LIBRARY_REQUEST_FAILED', 'Roon Library request failed');
  }
  if (bridgeError.code === 'ROON_IMAGE_UNAVAILABLE') {
    return responseFailure(id, 'ROON_IMAGE_UNAVAILABLE', 'Roon image is unavailable');
  }
  if (bridgeError.code === 'ROON_IMAGE_DECODE_FAILED') {
    return responseFailure(id, 'ROON_IMAGE_DECODE_FAILED', 'Roon image decode failed');
  }
  if (bridgeError.code === 'ROON_ALBUM_HIERARCHY_INVALID') {
    return responseFailure(id, 'ROON_ALBUM_HIERARCHY_INVALID', 'Roon album hierarchy is invalid');
  }
  if (bridgeError.code === 'ROON_TRACK_ACTION_UNAVAILABLE') {
    return responseFailure(id, 'ROON_TRACK_ACTION_UNAVAILABLE', 'Roon track action is unavailable');
  }
  if (
    bridgeError.code === 'ROON_LIBRARY_INVALID_REFERENCE' ||
    bridgeError.code === 'ROON_ACTION_BLOCKED' ||
    bridgeError.code === 'BAD_REQUEST'
  ) {
    return responseFailure(id, 'INVALID_IPC_REQUEST', 'Invalid Roon Library request');
  }
  return responseFailure(id, 'INTERNAL_ERROR', 'Core request failed');
}

function postReady(port: UtilityPort, runtime: CoreRuntime): void {
  port.postMessage({
    version: IPC_VERSION,
    event: 'core.ready',
    payload: { state: runtime.getState() },
  } satisfies CoreRuntimeEvent);
}

function backupsFor(runtime: CoreRuntimeForIpc) {
  if (!runtime.backups) throw new CollectionError('INVENTORY_UNAVAILABLE', '备份维护服务尚未就绪。');
  return runtime.backups;
}

function collectionFor(runtime: CoreRuntimeForIpc): CollectionRepository {
  if (!runtime.collection) throw new CollectionError('INVENTORY_UNAVAILABLE', '库存服务尚未就绪，请重试。');
  return runtime.collection;
}

function sourcesFor(runtime: CoreRuntimeForIpc) {
  if (!runtime.sources) throw new BridgeError('BAD_REQUEST', '源文件服务尚未就绪。', { httpStatus: 503 });
  return runtime.sources;
}

function masterVersionsFor(runtime: CoreRuntimeForIpc) {
  if (!runtime.masterVersions) throw new CollectionError('INVENTORY_UNAVAILABLE', '母版版本服务尚未就绪，请重试。');
  return runtime.masterVersions;
}
function executionFor(runtime: CoreRuntimeForIpc) {
  if (!runtime.execution) throw new CollectionError('INVENTORY_UNAVAILABLE', '执行资产服务尚未就绪，请重试。');
  return runtime.execution;
}
function recordingReplicaFor(runtime: CoreRuntimeForIpc) {
  if (!runtime.recordingReplica) throw new RecordingReplicaError('BACKEND_UNAVAILABLE');
  return runtime.recordingReplica;
}
function recordingPrintsFor(runtime: CoreRuntimeForIpc) {
  if (!runtime.recordingPrints) throw new CollectionError('INVENTORY_UNAVAILABLE', '印刷资料服务尚未就绪。');
  return runtime.recordingPrints;
}
function recordingRecordsFor(runtime: CoreRuntimeForIpc) {
  if (!runtime.recordingRecords) throw new CollectionError('INVENTORY_UNAVAILABLE', '录音档案服务尚未就绪。');
  return runtime.recordingRecords;
}
function recordingAttemptsFor(runtime: CoreRuntimeForIpc) {
  if (!runtime.recordingAttempts) throw new AttemptError('CLOSED');
  return runtime.recordingAttempts;
}
function recordingOutputFor(runtime: CoreRuntimeForIpc) {
  if (!runtime.recordingOutput) throw new OutputCheckError('HELPER_UNAVAILABLE');
  return runtime.recordingOutput;
}
function recordingPlansFor(runtime: CoreRuntimeForIpc) {
  if (!runtime.recordingPlans) throw new CollectionError('INVENTORY_UNAVAILABLE', '录音计划服务尚未就绪，请重试。');
  return runtime.recordingPlans;
}
function archiveFor(runtime: CoreRuntimeForIpc) {
  if (!runtime.archive) throw new CollectionError('INVENTORY_UNAVAILABLE', '归档服务尚未就绪，请重试。');
  return runtime.archive;
}
function preparedFor(runtime: CoreRuntimeForIpc) {
  if (!runtime.prepared) throw new CollectionError('INVENTORY_UNAVAILABLE', 'PREP 服务尚未就绪，请重试。');
  return runtime.prepared;
}
function preparationFor(runtime: CoreRuntimeForIpc) {
  if (!runtime.preparation) throw new CollectionError('INVENTORY_UNAVAILABLE', 'Logic 工作区服务尚未就绪，请重试。');
  return runtime.preparation;
}

function mediaPlanningFor(runtime: CoreRuntimeForIpc) {
  if (!runtime.mediaPlanning) throw new CollectionError('INVENTORY_UNAVAILABLE', '录音规划服务尚未就绪，请重试。');
  return runtime.mediaPlanning;
}

function masterDraftsFor(runtime: CoreRuntimeForIpc) {
  if (!runtime.masterDrafts) throw new BridgeError('ROON_LIBRARY_UNAVAILABLE', '录音草稿服务尚未就绪。', { httpStatus: 503 });
  return runtime.masterDrafts;
}

function physicalLinksFor(runtime: CoreRuntimeForIpc) {
  if (!runtime.physicalLinks) throw new BridgeError('ROON_LIBRARY_UNAVAILABLE', 'Roon 关联服务尚未就绪。', { httpStatus: 503 });
  return runtime.physicalLinks;
}

async function dispatch(
  runtime: CoreRuntimeForIpc,
  request: IpcRequest,
): Promise<unknown> {
  if ((request.command.startsWith('recordingAttempts.') || request.command.startsWith('recordingRecords.') || request.command.startsWith('recordingReplica.') || request.command.startsWith('masterArtwork.') || request.command.startsWith('recordingPrints.') || request.command.startsWith('recordingPrintWorker.')) && (!request.expectedDatasetId || !runtime.commandOutbox)) throw new DatasetScopeError();
  if (request.expectedDatasetId !== undefined) {
    if (!runtime.commandOutbox) throw new CollectionError('INVENTORY_UNAVAILABLE', '工作库身份尚未就绪。');
    runtime.commandOutbox.assertScope(request.expectedDatasetId);
  }
  switch (request.command as IpcCommand) {
    case 'recordingBackups.activationReceipt': return backupsFor(runtime).activationReceipt(request.payload as IpcCommandPayloads['recordingBackups.activationReceipt']);
    case 'commandOutbox.context': {
      if (!runtime.commandOutbox) throw new CollectionError('INVENTORY_UNAVAILABLE', '工作库身份尚未就绪。');
      return runtime.commandOutbox.context();
    }
    case 'commandOutbox.execute': {
      if (!isCommandOutboxExecute(request.payload)) throw new BridgeError('BAD_REQUEST', '持久命令请求无效。');
      if (!runtime.commandOutbox) throw new CollectionError('INVENTORY_UNAVAILABLE', '工作库身份尚未就绪。');
      const value = request.payload;
      runtime.commandOutbox.assertScope(value.datasetId);
      return { command: value.command, result: await dispatch(runtime, { version: IPC_VERSION, id: request.id, command: value.command, payload: value.payload }) };
    }
    case 'recordingSources.roots': return sourcesFor(runtime).roots();
    case 'recordingSources.rootReceipt': { const p = request.payload as IpcCommandPayloads['recordingSources.rootReceipt']; return sourcesFor(runtime).rootReceipt(p.commandId); }
    case 'recordingSources.authorize': { const p = request.payload as IpcCommandPayloads['recordingSources.authorize']; return sourcesFor(runtime).authorize(p.commandId, p.absolutePath); }
    case 'recordingSources.context': { const p = request.payload as IpcCommandPayloads['recordingSources.context']; return sourcesFor(runtime).context(p.id); }
    case 'recordingSources.start': { const p = request.payload as IpcCommandPayloads['recordingSources.start']; return sourcesFor(runtime).start(p.selection, p.absolutePath); }
    case 'recordingSources.revoke': { const p = request.payload as IpcCommandPayloads['recordingSources.revoke']; return sourcesFor(runtime).revoke(p); }
    case 'recordingSources.snapshot': { const p = request.payload as IpcCommandPayloads['recordingSources.snapshot']; return sourcesFor(runtime).snapshot(p.draftId); }
    case 'recordingSources.job': { const p = request.payload as IpcCommandPayloads['recordingSources.job']; return sourcesFor(runtime).job(p.id); }
    case 'recordingSources.cancel': { const p = request.payload as IpcCommandPayloads['recordingSources.cancel']; return sourcesFor(runtime).cancel(p); }
    case 'recordingSources.confirm': { const p = request.payload as IpcCommandPayloads['recordingSources.confirm']; return sourcesFor(runtime).confirm(p); }
    case 'recordingSources.recheck': { const p = request.payload as IpcCommandPayloads['recordingSources.recheck']; return sourcesFor(runtime).recheck(p); }
    case 'recordingVersions.list': return masterVersionsFor(runtime).list((request.payload as IpcCommandPayloads['recordingVersions.list']).draftId);
    case 'recordingProfiles.list': return collectionFor(runtime).recordingProfiles.list();
    case 'recordingProfiles.history': return collectionFor(runtime).recordingProfiles.history((request.payload as IpcCommandPayloads['recordingProfiles.history']).profileId);
    case 'recordingProfiles.version': return collectionFor(runtime).recordingProfiles.version((request.payload as IpcCommandPayloads['recordingProfiles.version']).versionId);
    case 'recordingProfiles.save': return collectionFor(runtime).recordingProfiles.save(request.payload as IpcCommandPayloads['recordingProfiles.save']);
    case 'recordingProfiles.session': return collectionFor(runtime).recordingProfiles.session((request.payload as IpcCommandPayloads['recordingProfiles.session']).draftId);
    case 'recordingProfiles.saveSession': return collectionFor(runtime).recordingProfiles.saveSession(request.payload as IpcCommandPayloads['recordingProfiles.saveSession']);
    case 'recordingBackups.overview': return backupsFor(runtime).overview();
    case 'recordingBackups.activate': return backupsFor(runtime).activate(request.payload as IpcCommandPayloads['recordingBackups.activate']);
    case 'recordingBackups.authorize': return backupsFor(runtime).authorize(request.payload as IpcCommandPayloads['recordingBackups.authorize']);
    case 'recordingBackups.authorizationReceipt': return backupsFor(runtime).authorizationReceipt(request.payload as IpcCommandPayloads['recordingBackups.authorizationReceipt']);
    case 'recordingBackups.start': return backupsFor(runtime).start(request.payload as IpcCommandPayloads['recordingBackups.start']);
    case 'recordingBackups.cancel': return backupsFor(runtime).cancel(request.payload as IpcCommandPayloads['recordingBackups.cancel']);
    case 'recordingBackups.revoke': return backupsFor(runtime).revoke(request.payload as IpcCommandPayloads['recordingBackups.revoke']);
    case 'masterArtwork.get': return recordingPrintsFor(runtime).artworkGet(request.payload as IpcCommandPayloads['masterArtwork.get']);
    case 'masterArtwork.save': return recordingPrintsFor(runtime).artworkSave(request.payload as IpcCommandPayloads['masterArtwork.save']);
    case 'recordingPrints.list': return recordingPrintsFor(runtime).list(request.payload as IpcCommandPayloads['recordingPrints.list']);
    case 'recordingPrints.request': return recordingPrintsFor(runtime).request(request.payload as IpcCommandPayloads['recordingPrints.request']);
    case 'recordingPrints.retry': return recordingPrintsFor(runtime).retry(request.payload as IpcCommandPayloads['recordingPrints.retry']);
    case 'recordingPrints.get': return recordingPrintsFor(runtime).get(request.payload as IpcCommandPayloads['recordingPrints.get']);
    case 'recordingPrintWorker.claim': return recordingPrintsFor(runtime).claim(request.payload as IpcCommandPayloads['recordingPrintWorker.claim']);
    case 'recordingPrintWorker.complete': return recordingPrintsFor(runtime).complete(request.payload as IpcCommandPayloads['recordingPrintWorker.complete']);
    case 'recordingPrintWorker.fail': return recordingPrintsFor(runtime).fail(request.payload as IpcCommandPayloads['recordingPrintWorker.fail']);
    case 'recordingPrintWorker.pdf': return recordingPrintsFor(runtime).pdf(request.payload as IpcCommandPayloads['recordingPrintWorker.pdf']);
    case 'recordingReplica.status': return recordingReplicaFor(runtime).status();
    case 'recordingReplica.inspect': return recordingReplicaFor(runtime).inspect(request.payload as IpcCommandPayloads['recordingReplica.inspect']);
    case 'recordingReplica.cancelRead': return recordingReplicaFor(runtime).cancelRead(request.payload as IpcCommandPayloads['recordingReplica.cancelRead']);
    case 'recordingReplica.start': return recordingReplicaFor(runtime).start(request.payload as IpcCommandPayloads['recordingReplica.start']);
    case 'recordingReplica.get': return recordingReplicaFor(runtime).get(request.payload as IpcCommandPayloads['recordingReplica.get']);
    case 'recordingReplica.stop': return recordingReplicaFor(runtime).stop(request.payload as IpcCommandPayloads['recordingReplica.stop']);
    case 'recordingRecords.list': return recordingRecordsFor(runtime).list(request.payload as IpcCommandPayloads['recordingRecords.list']);
    case 'recordingRecords.get': return recordingRecordsFor(runtime).get(request.payload as IpcCommandPayloads['recordingRecords.get']);
    case 'recordingRecords.visual': return recordingRecordsFor(runtime).visual(request.payload as IpcCommandPayloads['recordingRecords.visual']);
    case 'recordingRecords.history': return recordingRecordsFor(runtime).history(request.payload as IpcCommandPayloads['recordingRecords.history']);
    case 'recordingRecords.previewDisposition': return recordingRecordsFor(runtime).previewDisposition(request.payload as IpcCommandPayloads['recordingRecords.previewDisposition']);
    case 'recordingRecords.applyDisposition': return recordingRecordsFor(runtime).applyDisposition(request.payload as IpcCommandPayloads['recordingRecords.applyDisposition']);
    case 'recordingAttempts.list': return recordingAttemptsFor(runtime).list(request.payload as IpcCommandPayloads['recordingAttempts.list']);
    case 'recordingAttempts.get': return recordingAttemptsFor(runtime).get(request.payload as IpcCommandPayloads['recordingAttempts.get']);
    case 'recordingAttempts.begin': return recordingAttemptsFor(runtime).begin(request.payload as IpcCommandPayloads['recordingAttempts.begin']);
    case 'recordingAttempts.confirm': return recordingAttemptsFor(runtime).confirm(request.payload as IpcCommandPayloads['recordingAttempts.confirm']);
    case 'recordingAttempts.beginSide': return recordingAttemptsFor(runtime).beginSide(request.payload as IpcCommandPayloads['recordingAttempts.beginSide']);
    case 'recordingAttempts.stop': return recordingAttemptsFor(runtime).stop(request.payload as IpcCommandPayloads['recordingAttempts.stop']);
    case 'recordingOutput.status': return recordingOutputFor(runtime).status();
    case 'recordingOutput.check': return recordingOutputFor(runtime).check(request.payload as IpcCommandPayloads['recordingOutput.check']);
    case 'recordingOutput.cancel': return recordingOutputFor(runtime).cancel(request.payload as IpcCommandPayloads['recordingOutput.cancel']);
    case 'recordingPlans.list': return recordingPlansFor(runtime).list(request.payload as IpcCommandPayloads['recordingPlans.list']);
    case 'recordingPlans.version': return recordingPlansFor(runtime).version(request.payload as IpcCommandPayloads['recordingPlans.version']);
    case 'recordingPlans.preview': return recordingPlansFor(runtime).preview(request.payload as IpcCommandPayloads['recordingPlans.preview']);
    case 'recordingPlans.freeze': return recordingPlansFor(runtime).freeze(request.payload as IpcCommandPayloads['recordingPlans.freeze']);
    case 'recordingPlans.preflight': return recordingPlansFor(runtime).preflight(request.payload as IpcCommandPayloads['recordingPlans.preflight']);
    case 'recordingPlans.cancelRead': return recordingPlansFor(runtime).cancelRead(request.payload as IpcCommandPayloads['recordingPlans.cancelRead']);
    case 'recordingArchive.roots': return archiveFor(runtime).roots();
    case 'recordingArchive.authorize': { const p = request.payload as IpcCommandPayloads['recordingArchive.authorize']; return archiveFor(runtime).authorize(p.commandId, p.absolutePath); }
    case 'recordingArchive.authorizationReceipt': return archiveFor(runtime).authorizationReceipt((request.payload as IpcCommandPayloads['recordingArchive.authorizationReceipt']).commandId);
    case 'recordingArchive.initialize': return archiveFor(runtime).initialize(request.payload as IpcCommandPayloads['recordingArchive.initialize']);
    case 'recordingArchive.revokeRoot': return archiveFor(runtime).revoke(request.payload as IpcCommandPayloads['recordingArchive.revokeRoot']);
    case 'recordingArchive.preview': return archiveFor(runtime).preview(request.payload as IpcCommandPayloads['recordingArchive.preview']);
    case 'recordingArchive.start': return archiveFor(runtime).start(request.payload as IpcCommandPayloads['recordingArchive.start']);
    case 'recordingArchive.list': return archiveFor(runtime).list((request.payload as IpcCommandPayloads['recordingArchive.list']).draftId);
    case 'recordingArchive.operation': return archiveFor(runtime).operation((request.payload as IpcCommandPayloads['recordingArchive.operation']).id);
    case 'recordingArchive.cancel': return archiveFor(runtime).cancel(request.payload as IpcCommandPayloads['recordingArchive.cancel']);
    case 'recordingArchive.resume': return archiveFor(runtime).resume(request.payload as IpcCommandPayloads['recordingArchive.resume']);
    case 'recordingArchive.verify': return archiveFor(runtime).verify(request.payload as IpcCommandPayloads['recordingArchive.verify']);
    case 'recordingArchive.cancelRead': return archiveFor(runtime).cancelRead((request.payload as IpcCommandPayloads['recordingArchive.cancelRead']).id);
    case 'recordingExecution.list': return executionFor(runtime).list((request.payload as IpcCommandPayloads['recordingExecution.list']).draftId);
    case 'recordingExecution.preview': return executionFor(runtime).preview(request.payload as IpcCommandPayloads['recordingExecution.preview']);
    case 'recordingExecution.start': return executionFor(runtime).start(request.payload as IpcCommandPayloads['recordingExecution.start']);
    case 'recordingExecution.job': return executionFor(runtime).job((request.payload as IpcCommandPayloads['recordingExecution.job']).id);
    case 'recordingExecution.cancel': return executionFor(runtime).cancel(request.payload as IpcCommandPayloads['recordingExecution.cancel']);
    case 'recordingExecution.cancelRead': return executionFor(runtime).cancelRead((request.payload as IpcCommandPayloads['recordingExecution.cancelRead']).id);
    case 'recordingExecution.verify': return executionFor(runtime).verify(request.payload as IpcCommandPayloads['recordingExecution.verify']);
    case 'collectionProgress.wants': return collectionFor(runtime).collectionProgress.wants(request.payload as IpcCommandPayloads['collectionProgress.wants']);
    case 'collectionProgress.saveWant': return collectionFor(runtime).collectionProgress.saveWant(request.payload as IpcCommandPayloads['collectionProgress.saveWant']);
    case 'collectionProgress.cancelWant': return collectionFor(runtime).collectionProgress.cancelWant(request.payload as IpcCommandPayloads['collectionProgress.cancelWant']);
    case 'collectionProgress.wantHistory': return collectionFor(runtime).collectionProgress.wantHistory(request.payload as IpcCommandPayloads['collectionProgress.wantHistory']);
    case 'collectionProgress.current': return collectionFor(runtime).collectionProgress.current(request.payload as IpcCommandPayloads['collectionProgress.current']);
    case 'collectionProgress.capture': return collectionFor(runtime).collectionProgress.capture(request.payload as IpcCommandPayloads['collectionProgress.capture']);
    case 'collectionProgress.snapshots': return collectionFor(runtime).collectionProgress.snapshots(request.payload as IpcCommandPayloads['collectionProgress.snapshots']);
    case 'collectionProgress.snapshot': return collectionFor(runtime).collectionProgress.snapshot(request.payload as IpcCommandPayloads['collectionProgress.snapshot']);
    case 'collectionProgress.modelLengths': return collectionFor(runtime).collectionProgress.modelLengths(request.payload as IpcCommandPayloads['collectionProgress.modelLengths']);
    case 'spreadsheetImports.registerWorkbook': {
      const payload = request.payload as IpcCommandPayloads['spreadsheetImports.registerWorkbook'];
      const repository = collectionFor(runtime).spreadsheetImports, prior = repository.sourceReceipt({ commandId: payload.commandId });
      if (prior.source) return prior.source;
      const file = await readSpreadsheetFile(payload.absolutePath);
      const workbook = await parseSpreadsheetWorkbook(file.bytes, file.fileFormat);
      // 原生选择及解析均会跨异步边界，写入前必须再次核对原工作库。
      if (!runtime.commandOutbox || !request.expectedDatasetId) throw new DatasetScopeError();
      runtime.commandOutbox.assertScope(request.expectedDatasetId);
      return repository.registerSource({ commandId: payload.commandId, bytes: file.bytes, displayName: file.displayName, workbook });
    }
    case 'spreadsheetImports.workbookReceipt': return collectionFor(runtime).spreadsheetImports.sourceReceipt(request.payload as IpcCommandPayloads['spreadsheetImports.workbookReceipt']);
    case 'spreadsheetImports.sources': return collectionFor(runtime).spreadsheetImports.sources(request.payload as IpcCommandPayloads['spreadsheetImports.sources']);
    case 'spreadsheetImports.source': return collectionFor(runtime).spreadsheetImports.source(request.payload as IpcCommandPayloads['spreadsheetImports.source']);
    case 'spreadsheetImports.sourceRows': return collectionFor(runtime).spreadsheetImports.sourceRows(request.payload as IpcCommandPayloads['spreadsheetImports.sourceRows']);
    case 'spreadsheetImports.preview': return collectionFor(runtime).spreadsheetImports.preview(request.payload as IpcCommandPayloads['spreadsheetImports.preview']);
    case 'spreadsheetImports.apply': return collectionFor(runtime).spreadsheetImports.apply(request.payload as IpcCommandPayloads['spreadsheetImports.apply']);
    case 'spreadsheetImports.revision': return collectionFor(runtime).spreadsheetImports.revision(request.payload as IpcCommandPayloads['spreadsheetImports.revision']);
    case 'spreadsheetImports.history': return collectionFor(runtime).spreadsheetImports.history(request.payload as IpcCommandPayloads['spreadsheetImports.history']);
    case 'spreadsheetImports.adjustmentPreview': return collectionFor(runtime).spreadsheetImports.adjustmentPreview(request.payload as IpcCommandPayloads['spreadsheetImports.adjustmentPreview']);
    case 'spreadsheetImports.adjust': return collectionFor(runtime).spreadsheetImports.adjust(request.payload as IpcCommandPayloads['spreadsheetImports.adjust']);
    case 'spreadsheetImports.adjustments': return collectionFor(runtime).spreadsheetImports.adjustments(request.payload as IpcCommandPayloads['spreadsheetImports.adjustments']);
    case 'referenceCatalog.registerSource': return collectionFor(runtime).catalog.registerSource(request.payload as IpcCommandPayloads['referenceCatalog.registerSource']);
    case 'referenceCatalog.sources': return collectionFor(runtime).catalog.sources(request.payload as IpcCommandPayloads['referenceCatalog.sources']);
    case 'referenceCatalog.source': return collectionFor(runtime).catalog.source(request.payload as IpcCommandPayloads['referenceCatalog.source']);
    case 'referenceCatalog.previewRevision': return collectionFor(runtime).catalog.previewRevision(request.payload as IpcCommandPayloads['referenceCatalog.previewRevision']);
    case 'referenceCatalog.publishRevision': return collectionFor(runtime).catalog.publishRevision(request.payload as IpcCommandPayloads['referenceCatalog.publishRevision']);
    case 'referenceCatalog.revision': return collectionFor(runtime).catalog.revision(request.payload as IpcCommandPayloads['referenceCatalog.revision']);
    case 'referenceCatalog.setMatch': return collectionFor(runtime).catalog.setMatch(request.payload as IpcCommandPayloads['referenceCatalog.setMatch']);
    case 'referenceCatalog.snapshot': return collectionFor(runtime).catalog.snapshot(request.payload as IpcCommandPayloads['referenceCatalog.snapshot']);
    case 'referenceCatalog.history': return collectionFor(runtime).catalog.history(request.payload as IpcCommandPayloads['referenceCatalog.history']);
    case 'recordingPrepared.list': return preparedFor(runtime).list((request.payload as IpcCommandPayloads['recordingPrepared.list']).draftId);
    case 'recordingPrepared.selections': return preparedFor(runtime).selections((request.payload as IpcCommandPayloads['recordingPrepared.selections']).preparationId);
    case 'recordingPrepared.selectionReceipt': return { selection: preparedFor(runtime).selectionReceipt((request.payload as IpcCommandPayloads['recordingPrepared.selectionReceipt'])) };
    case 'recordingPrepared.revoke': return preparedFor(runtime).revoke((request.payload as IpcCommandPayloads['recordingPrepared.revoke']));
    case 'recordingPrepared.previewImport': return preparedFor(runtime).previewImport((request.payload as IpcCommandPayloads['recordingPrepared.previewImport']));
    case 'recordingPrepared.startImport': return preparedFor(runtime).startImport((request.payload as IpcCommandPayloads['recordingPrepared.startImport']));
    case 'recordingPrepared.job': return preparedFor(runtime).job((request.payload as IpcCommandPayloads['recordingPrepared.job']).id);
    case 'recordingPrepared.cancel': return preparedFor(runtime).cancel((request.payload as IpcCommandPayloads['recordingPrepared.cancel']));
    case 'recordingPrepared.review': return preparedFor(runtime).review((request.payload as IpcCommandPayloads['recordingPrepared.review']));
    case 'recordingPrepared.freeze': return preparedFor(runtime).freeze((request.payload as IpcCommandPayloads['recordingPrepared.freeze']));
    case 'recordingPrepared.select': { const { absolutePath, ...selection } = request.payload as IpcCommandPayloads['recordingPrepared.select']; return preparedFor(runtime).select(selection, absolutePath); }
    case 'recordingPreparation.destinations': return { destinations: preparationFor(runtime).destinations() };
    case 'recordingPreparation.authorizationReceipt': return { destination: preparationFor(runtime).authorizationReceipt((request.payload as IpcCommandPayloads['recordingPreparation.authorizationReceipt']).commandId) };
    case 'recordingPreparation.authorize': { const payload = request.payload as IpcCommandPayloads['recordingPreparation.authorize']; return preparationFor(runtime).authorize(payload.commandId, payload.absolutePath); }
    case 'recordingPreparation.revoke': return preparationFor(runtime).revoke(request.payload as IpcCommandPayloads['recordingPreparation.revoke']);
    case 'recordingPreparation.job': return preparationFor(runtime).job((request.payload as IpcCommandPayloads['recordingPreparation.job']).id);
    case 'recordingPreparation.cancel': return preparationFor(runtime).cancel(request.payload as IpcCommandPayloads['recordingPreparation.cancel']);
    case 'recordingPreparation.context': return preparationFor(runtime).context((request.payload as IpcCommandPayloads['recordingPreparation.context']).id);
    case 'recordingPreparation.list': return preparationFor(runtime).list((request.payload as IpcCommandPayloads['recordingPreparation.list']).draftId);
    case 'recordingPreparation.preview': return preparationFor(runtime).preview(request.payload as IpcCommandPayloads['recordingPreparation.preview']);
    case 'recordingPreparation.start': return preparationFor(runtime).start(request.payload as IpcCommandPayloads['recordingPreparation.start']);
    case 'recordingVersions.preview': return masterVersionsFor(runtime).preview(request.payload as IpcCommandPayloads['recordingVersions.preview']);
    case 'recordingVersions.freeze': return masterVersionsFor(runtime).freeze(request.payload as IpcCommandPayloads['recordingVersions.freeze']);
    case 'recordingVersions.job': return masterVersionsFor(runtime).job((request.payload as IpcCommandPayloads['recordingVersions.job']).id);
    case 'recordingVersions.cancel': return masterVersionsFor(runtime).cancel(request.payload as IpcCommandPayloads['recordingVersions.cancel']);
    case 'recordingMedia.plans': return mediaPlanningFor(runtime).list((request.payload as IpcCommandPayloads['recordingMedia.plans']).draftId);
    case 'recordingMedia.detail': return mediaPlanningFor(runtime).detail((request.payload as IpcCommandPayloads['recordingMedia.detail']).id);
    case 'recordingMedia.balance': { const p = request.payload as IpcCommandPayloads['recordingMedia.balance']; return mediaPlanningFor(runtime).balance(p.draftId, p.spec); }
    case 'recordingMedia.preview': return mediaPlanningFor(runtime).preview(request.payload as IpcCommandPayloads['recordingMedia.preview']);
    case 'recordingMedia.save': return mediaPlanningFor(runtime).save(request.payload as IpcCommandPayloads['recordingMedia.save']);
    case 'recordingMedia.reserve': return mediaPlanningFor(runtime).reserve(request.payload as IpcCommandPayloads['recordingMedia.reserve']);
    case 'recordingMedia.release': return mediaPlanningFor(runtime).release(request.payload as IpcCommandPayloads['recordingMedia.release']);
    case 'recordingDrafts.list': {
      const result = collectionFor(runtime).drafts.list((request.payload as IpcCommandPayloads['recordingDrafts.list']).page);
      const items = [];
      for (const item of result.items) { const evidence = runtime.sources ? await runtime.sources.snapshot(item.id) : undefined; const latest = collectionFor(runtime).drafts.detail(item.id); items.push({ ...item, sourceLockEligible: latest.revision === item.revision && evidence?.sourceLockEligible === true }); }
      return { ...result, items };
    }
    case 'recordingDrafts.detail': {
      const id = (request.payload as IpcCommandPayloads['recordingDrafts.detail']).id;
      const evidence = runtime.sources ? await runtime.sources.snapshot(id) : undefined;
      const draft = collectionFor(runtime).drafts.detail(id);
      return { ...draft, sourceLockEligible: evidence?.sourceLockEligible === true && JSON.stringify(evidence.tracks.map(t => t.trackId)) === JSON.stringify(draft.tracks.map(t => t.id)) };
    }
    case 'recordingDrafts.append': return masterDraftsFor(runtime).append(request.payload as IpcCommandPayloads['recordingDrafts.append']);
    case 'recordingDrafts.update': return masterDraftsFor(runtime).update(request.payload as IpcCommandPayloads['recordingDrafts.update']);
    case 'recordingDrafts.runtime': { const p = request.payload as IpcCommandPayloads['recordingDrafts.runtime']; return masterDraftsFor(runtime).runtime(p.draftId, p.trackId); }
    case 'physicalLinks.search': { const p = request.payload as IpcCommandPayloads['physicalLinks.search']; return physicalLinksFor(runtime).search(p.query, p.page); }
    case 'physicalLinks.digitalList': return collectionFor(runtime).links.digitalList((request.payload as IpcCommandPayloads['physicalLinks.digitalList']).page);
    case 'physicalLinks.digitalDetail': return collectionFor(runtime).links.digitalDetail((request.payload as IpcCommandPayloads['physicalLinks.digitalDetail']).id);
    case 'physicalLinks.physical': return collectionFor(runtime).links.physical((request.payload as IpcCommandPayloads['physicalLinks.physical']).releaseId);
    case 'physicalLinks.runtime': return physicalLinksFor(runtime).runtime((request.payload as IpcCommandPayloads['physicalLinks.runtime']).id);
    case 'physicalLinks.matrix': { const p = request.payload as IpcCommandPayloads['physicalLinks.matrix']; return collectionFor(runtime).links.matrix(p.page, p.query); }
    case 'physicalLinks.confirm': return physicalLinksFor(runtime).confirm(request.payload as IpcCommandPayloads['physicalLinks.confirm']);
    case 'physicalLinks.relocate': return physicalLinksFor(runtime).relocate(request.payload as IpcCommandPayloads['physicalLinks.relocate']);
    case 'physicalLinks.register': return physicalLinksFor(runtime).register(request.payload as IpcCommandPayloads['physicalLinks.register']);
    case 'physicalLinks.remove': return physicalLinksFor(runtime).remove(request.payload as IpcCommandPayloads['physicalLinks.remove']);
    case 'physicalLinks.absence': return physicalLinksFor(runtime).absence(request.payload as IpcCommandPayloads['physicalLinks.absence']);
    case 'physicalMusic.list': { const p = request.payload as IpcCommandPayloads['physicalMusic.list']; return collectionFor(runtime).music.list(p.page, p.filter); }
    case 'physicalMusic.detail': return collectionFor(runtime).music.detail((request.payload as IpcCommandPayloads['physicalMusic.detail']).id);
    case 'physicalMusic.photo': return collectionFor(runtime).music.photo((request.payload as IpcCommandPayloads['physicalMusic.photo']).photoId);
    case 'physicalMusic.saveRelease': return collectionFor(runtime).music.saveRelease(request.payload as IpcCommandPayloads['physicalMusic.saveRelease']);
    case 'physicalMusic.saveLegacy': return collectionFor(runtime).music.saveLegacy(request.payload as IpcCommandPayloads['physicalMusic.saveLegacy']);
    case 'physicalMusic.addPhoto': return collectionFor(runtime).music.addPhoto(request.payload as IpcCommandPayloads['physicalMusic.addPhoto']);
    case 'physicalMusic.removePhoto': return collectionFor(runtime).music.removePhoto(request.payload as IpcCommandPayloads['physicalMusic.removePhoto']);
    case 'collection.addPhoto':
      return collectionFor(runtime).addPhoto(request.payload as IpcCommandPayloads['collection.addPhoto']);
    case 'collection.photo':
      return collectionFor(runtime).photo((request.payload as IpcCommandPayloads['collection.photo']).photoId);
    case 'collection.changePhoto':
      return collectionFor(runtime).changePhoto(request.payload as IpcCommandPayloads['collection.changePhoto']);
    case 'collection.list': {
      const payload = request.payload as IpcCommandPayloads['collection.list'];
      return collectionFor(runtime).list(payload.page, payload.filter);
    }
    case 'collection.detail': {
      const payload = request.payload as IpcCommandPayloads['collection.detail'];
      return collectionFor(runtime).detail(payload.modelId, payload.page);
    }
    case 'collection.receive':
      return collectionFor(runtime).receive(request.payload as IpcCommandPayloads['collection.receive']);
    case 'collection.materialize':
      return collectionFor(runtime).materialize(request.payload as IpcCommandPayloads['collection.materialize']);
    case 'collection.updateCopy':
      return collectionFor(runtime).updateCopy(request.payload as IpcCommandPayloads['collection.updateCopy']);
    case 'collection.setPolicy':
      return collectionFor(runtime).setPolicy(request.payload as IpcCommandPayloads['collection.setPolicy']);
    case 'core.ping':
      return runtime.ping();
    case 'core.getHealth':
      return runtime.getHealth();
    case 'core.getState':
      return runtime.getState();
    case 'core.getDiagnostics':
      return runtime.getDiagnostics();
    case 'core.shutdown':
      await runtime.shutdown();
      return { stopped: true as const };
    case 'auth.setCredential':
      return runtime.setProviderCredential(
        (request.payload as { credential: string }).credential,
      );
    case 'auth.verifyCredential':
      return runtime.verifyProviderCredential(
        (request.payload as { credential: string }).credential,
      );
    case 'auth.clearCredential':
      return runtime.clearProviderCredential();
    case 'auth.beginQr':
      return runtime.beginQrLogin();
    case 'auth.pollQr':
      return runtime.pollQrLogin(
        (request.payload as { challengeId: string }).challengeId,
      );
    case 'auth.cancelQr':
      return runtime.cancelQrLogin(
        (request.payload as { challengeId: string }).challengeId,
      );
    case 'auth.getState':
      return runtime.getAuthState();
    case 'auth.logout':
      return runtime.logoutProvider();
    case 'account.getState':
      return runtime.getAccountState();
    case 'account.refresh':
      return runtime.refreshAccountProfile();
    case 'library.search':
      return runtime.searchTracks(
        (request.payload as { query: string }).query,
        (request.payload as { page: { offset: number; limit: number } }).page,
      );
    case 'library.searchArtists':
      return runtime.searchArtists(
        (request.payload as { query: string }).query,
        (request.payload as { page: { offset: number; limit: number } }).page,
      );
    case 'library.searchAlbums':
      return runtime.searchAlbums(
        (request.payload as { query: string }).query,
        (request.payload as { page: { offset: number; limit: number } }).page,
      );
    case 'library.artist':
      return runtime.getArtist(
        (request.payload as { artistId: string }).artistId,
        (request.payload as { page: { offset: number; limit: number } }).page,
      );
    case 'library.album':
      return runtime.getAlbum(
        (request.payload as { albumId: string }).albumId,
        (request.payload as { page: { offset: number; limit: number } }).page,
      );
    case 'library.aggregateSearch':
      return runtime.aggregateSearch(
        (request.payload as { query: string }).query,
        (request.payload as { page: { offset: number; limit: number } }).page,
      );
    case 'library.liked':
      return runtime.getLikedTracks(
        (request.payload as { page: { offset: number; limit: number } }).page,
      );
    case 'library.likeStatus':
      return runtime.getTrackLikeStatus(
        (request.payload as { trackId: string }).trackId,
      );
    case 'library.like':
      return runtime.likeTrack(
        (request.payload as { trackId: string }).trackId,
        (request.payload as { liked: boolean }).liked,
      );
    case 'library.match':
      return runtime.matchLibraryTrack(
        (request.payload as { track: Parameters<CoreRuntimeForIpc['matchLibraryTrack']>[0] }).track,
      );
    case 'library.playlists':
      return runtime.getUserPlaylists();
    case 'library.playlist':
      return runtime.getPlaylist(
        (request.payload as { playlistId: string }).playlistId,
        (request.payload as { page: { offset: number; limit: number } }).page,
      );
    case 'library.dailyRecommendations':
      return runtime.getDailyRecommendations();
    case 'favorites.list':
      return runtime.listFavorites(
        (request.payload as { kind?: Parameters<CoreRuntimeForIpc['listFavorites']>[0] }).kind,
        (request.payload as { page: Parameters<CoreRuntimeForIpc['listFavorites']>[1] }).page,
      );
    case 'favorites.check':
      return runtime.checkFavorite(
        (request.payload as { descriptor: Parameters<CoreRuntimeForIpc['checkFavorite']>[0] }).descriptor,
      );
    case 'favorites.set':
      return runtime.setFavorite(
        (request.payload as { descriptor: Parameters<CoreRuntimeForIpc['setFavorite']>[0] }).descriptor,
        (request.payload as { favorite: boolean }).favorite,
      );
    case 'lyrics.get':
      return runtime.getLyrics((request.payload as { trackId: string }).trackId);
    case 'lyrics.match.get':
      return runtime.getLocalLyricsMatch();
    case 'lyrics.match.select':
      return runtime.selectLocalLyricsMatch(
        (request.payload as { matchSessionId: string }).matchSessionId,
        (request.payload as { candidateId: string }).candidateId,
      );
    case 'lyrics.match.revoke':
      return runtime.revokeLocalLyricsMatch();
    case 'roon.listZones':
      return { zones: runtime.listZones() };
    case 'roon.selectZone':
      return runtime.selectZone((request.payload as { zoneId: string }).zoneId);
    case 'roon.library.albums':
      return runtime.browseRoonAlbums(
        (request.payload as { page: { offset: number; limit: number } }).page,
      );
    case 'roon.library.artists':
      return runtime.browseRoonArtists(
        (request.payload as { page: { offset: number; limit: number } }).page,
      );
    case 'roon.library.genres':
      return runtime.browseRoonGenres(
        (request.payload as { page: { offset: number; limit: number } }).page,
      );
    case 'roon.library.playlists':
      return runtime.browseRoonPlaylists(
        (request.payload as { page: { offset: number; limit: number } }).page,
      );
    case 'roon.library.album':
      return runtime.browseRoonAlbum(
        (request.payload as { reference: string }).reference,
        (request.payload as { page: { offset: number; limit: number } }).page,
      );
    case 'roon.library.artist':
      return runtime.browseRoonArtist(
        (request.payload as { reference: string }).reference,
        (request.payload as { page: { offset: number; limit: number } }).page,
      );
    case 'roon.library.genre':
      return runtime.browseRoonGenre(
        (request.payload as { reference: string }).reference,
        (request.payload as { page: { offset: number; limit: number } }).page,
      );
    case 'roon.library.playlist':
      return runtime.browseRoonPlaylist(
        (request.payload as { reference: string }).reference,
        (request.payload as { page: { offset: number; limit: number } }).page,
      );
    case 'roon.library.search':
      return runtime.searchRoonLibrary(
        (request.payload as { query: string }).query,
        (request.payload as { page: { offset: number; limit: number } }).page,
      );
    case 'roon.library.image':
      return runtime.getRoonImage(
        (request.payload as { reference: string }).reference,
        (request.payload as { options?: Parameters<CoreRuntimeForIpc['getRoonImage']>[1] }).options,
      );
    case 'roon.library.play':
      return runtime.playRoonTrack(
        (request.payload as { reference: string }).reference,
        (request.payload as { zoneId: string }).zoneId,
      );
    case 'roon.library.queue':
      return runtime.queueRoonTrack(
        (request.payload as { reference: string }).reference,
        (request.payload as { zoneId: string }).zoneId,
      );
    case 'roon.transport.stop':
      return runtime.stopRoonTransport();
    case 'playback.getState':
      return runtime.getPlaybackState();
    case 'playback.play':
      return runtime.playbackPlay(
        (request.payload as { trackId: string }).trackId,
        (request.payload as { qualityPreference: Parameters<CoreRuntimeForIpc['playbackPlay']>[1] }).qualityPreference,
        (request.payload as { rendererClickAtMs?: number }).rendererClickAtMs,
      );
    case 'playback.pause':
      return runtime.playbackPause();
    case 'playback.resume':
      return runtime.playbackResume();
    case 'playback.seek':
      return runtime.seekPlayback(
        (request.payload as { positionMs: number }).positionMs,
      );
    case 'playback.stop':
      return runtime.playbackStop();
    case 'playback.next':
      return runtime.playbackNext();
    case 'playback.previous':
      return runtime.playbackPrevious();
    case 'playback.playQueueIndex':
      return runtime.playbackPlayQueueIndex(
        (request.payload as { index: number }).index,
      );
    case 'playback.replaceQueue':
      return runtime.replacePlaybackQueue(
        (request.payload as { items: Parameters<CoreRuntimeForIpc['replacePlaybackQueue']>[0] }).items,
        (request.payload as { index: number }).index,
      );
    case 'playback.appendQueue':
      return runtime.appendPlaybackQueue(
        (request.payload as { items: Parameters<CoreRuntimeForIpc['appendPlaybackQueue']>[0] }).items,
      );
    case 'playback.insertNext':
      return runtime.insertNextPlayback(
        (request.payload as { items: Parameters<CoreRuntimeForIpc['insertNextPlayback']>[0] }).items,
      );
  }
}

export async function attachCoreRuntimePort(
  port: UtilityPort,
  runtime: CoreRuntimeForIpc,
  options: { exitAfterShutdown?: boolean; beforeReady?: () => void } = {},
): Promise<void> {
  port.on('message', (event) => {
    void (async () => {
      const parsed = validateIpcRequest(event.data);
      const id = requestId(event.data);
      if (!parsed.ok) {
        if (id) port.postMessage(responseFailure(id, parsed.error.code, parsed.error.message));
        return;
      }
      try {
        const result = await dispatch(runtime, parsed.value);
        const response: IpcResponse = {
          version: IPC_VERSION,
          id: parsed.value.id,
          ok: true,
          result,
        };
        port.postMessage(response);
        if (parsed.value.command === 'core.shutdown' && options.exitAfterShutdown) {
          setImmediate(() => process.exit(0));
        }
      } catch (error) {
        port.postMessage(failureForError(parsed.value.id, error));
      }
    })();
  });
  port.start();
  await runtime.start();
  options.beforeReady?.();
  postReady(port, runtime);
}

export function isCrashProbeEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === 'test' && env.MUSIC_BRIDGE_CORE_CRASH_PROBE === '1';
}

function createRoonTimeShapeRecorder(
  env: NodeJS.ProcessEnv,
): ((summary: RoonTimeShapeSummary) => void) | undefined {
  const outputPath = env.MUSIC_BRIDGE_ROON_TIME_GATE_PATH;
  if (env.MUSIC_BRIDGE_ROON_TIME_GATE !== '1' || outputPath === undefined) return undefined;
  return (summary) => {
    try {
      writeFileSync(outputPath, `${JSON.stringify(summary)}\n`, { encoding: 'utf8', mode: 0o600 });
      chmodSync(outputPath, 0o600);
    } catch {
      // A diagnostic sampler must never change playback behavior.
    }
  };
}

function createRoonBrowseShapeRecorder(
  env: NodeJS.ProcessEnv,
): ((summary: RoonBrowseShapeSummary) => void) | undefined {
  const outputPath = env.MUSIC_BRIDGE_ROON_BROWSE_GATE_PATH;
  if (env.MUSIC_BRIDGE_ROON_BROWSE_GATE !== '1' || outputPath === undefined) return undefined;
  return (summary) => {
    try {
      appendFileSync(outputPath, `${JSON.stringify(summary)}\n`, { encoding: 'utf8', mode: 0o600 });
      chmodSync(outputPath, 0o600);
    } catch {
      // 诊断采样不得改变 Browse 行为。
    }
  };
}

function createRoonImageShapeRecorder(
  env: NodeJS.ProcessEnv,
): ((summary: RoonImageShapeSummary) => void) | undefined {
  const outputPath = env.MUSIC_BRIDGE_ROON_IMAGE_GATE_PATH;
  if (env.MUSIC_BRIDGE_ROON_IMAGE_GATE !== '1' || outputPath === undefined) return undefined;
  return (summary) => {
    try {
      appendFileSync(outputPath, `${JSON.stringify(summary)}\n`, { encoding: 'utf8', mode: 0o600 });
      chmodSync(outputPath, 0o600);
    } catch {
      // 诊断采样不得改变图片行为。
    }
  };
}

export async function runCoreUtilityProcess(
  env: NodeJS.ProcessEnv = process.env,
  createRecordingConverter?: () => Promise<FfmpegConverter | undefined>,
  createRecordingOutputHelper?: () => Promise<PinnedOutputHelper | undefined>,
): Promise<void> {
  const parentPort = (process as unknown as ProcessWithParentPort).parentPort;
  if (!parentPort) {
    process.exitCode = 1;
    return;
  }

  parentPort.once('message', (event) => {
    void (async () => {
      const port = event.ports?.[0];
      if (!port) {
        process.exitCode = 1;
        return;
      }
      let dataset: Awaited<ReturnType<typeof openCollectionDataset>> | undefined;
      try {
        const recordingConverter = await createRecordingConverter?.();
        const recordingOutputHelper = await createRecordingOutputHelper?.();
        const dataDirectory = env.MUSIC_BRIDGE_DATA_DIRECTORY;
        if (dataDirectory !== undefined && (!dataDirectory || dataDirectory.length > 1024 || !path.isAbsolute(dataDirectory) || dataDirectory.includes('\0'))) throw new Error('Core 数据目录不可用');
        if (dataDirectory) dataset = await openCollectionDataset(dataDirectory);
        const datasetOptions = dataset ? {
          collectionDatasetIdentity: { datasetId: dataset.datasetId, assertCurrent: () => dataset!.assertIdentity() },
          collectionRepository: dataset.repository,
          backupWorkflowStore: dataset.store,
          backupPrivateRoot: dataset.privateRoot,
          ...(dataset.contentBinding ? { backupContentBinding: dataset.contentBinding } : {}),
        } : {};
        const runtime =
          env.MUSIC_BRIDGE_CORE_TEST_MODE === '1'
            ? createTestBridgeRuntime({
                ...(recordingConverter ? { recordingConverter } : {}),
                ...(recordingOutputHelper ? { recordingOutputHelper } : {}),
                ...(env.MUSIC_BRIDGE_UI_E2E === '1' && env.MUSIC_BRIDGE_SYNTHETIC_ROON_LIBRARY === '1' ? { roonLibrary: createSyntheticRoonLibrary() } : {}),
                ...datasetOptions,
                authorized: env.MUSIC_BRIDGE_UI_E2E === '1',
                ...(env.MUSIC_BRIDGE_SYNTHETIC_ACCOUNT_MODE === 'profile-unavailable' || env.MUSIC_BRIDGE_SYNTHETIC_ACCOUNT_MODE === 'expired'
                  ? { accountMode: env.MUSIC_BRIDGE_SYNTHETIC_ACCOUNT_MODE }
                  : {}),
              })
            : (() => {
                const dataDirectory = env.MUSIC_BRIDGE_DATA_DIRECTORY;
                if (
                  !dataDirectory
                  || dataDirectory.length > 1_024
                  || !path.isAbsolute(dataDirectory)
                  || dataDirectory.includes('\0')
                ) {
                  throw new Error('Core data directory is unavailable');
                }
                const onRoonTimeShape = createRoonTimeShapeRecorder(env);
                const onRoonBrowseShape = createRoonBrowseShapeRecorder(env);
                const onRoonImageShape = createRoonImageShapeRecorder(env);
                return createBridgeRuntime({
                  ...(recordingConverter ? { recordingConverter } : {}),
                ...(recordingOutputHelper ? { recordingOutputHelper } : {}),
                  ...datasetOptions,
                  lyricsMatchRepository: createLyricsMatchRepository({
                    filePath: path.join(dataDirectory, 'lyrics-matches.v1.json'),
                  }),
                  ...(onRoonTimeShape ? { onRoonTimeShape } : {}),
                  ...(onRoonBrowseShape ? { onRoonBrowseShape } : {}),
                  ...(onRoonImageShape ? { onRoonImageShape } : {}),
                  onEvent: (message) => {
                  if (message.event !== 'core.ready') {
                    port.postMessage(message)
                  }
                  },
                });
              })();
        await attachCoreRuntimePort(port, runtime, { exitAfterShutdown: true, beforeReady: () => dataset?.commit() });
        if (isCrashProbeEnabled(env)) {
          const configuredDelay = Number(env.MUSIC_BRIDGE_CORE_CRASH_DELAY_MS);
          const delayMs = Number.isSafeInteger(configuredDelay) && configuredDelay >= 25
            ? Math.min(configuredDelay, 5_000)
            : 25;
          setTimeout(() => process.exit(71), delayMs);
        }
      } catch {
        dataset?.fail();
        dataset?.close();
        process.exitCode = 1;
        process.exit(1);
      }
    })();
  });
}

export { parseIpcRuntimeMessage };
