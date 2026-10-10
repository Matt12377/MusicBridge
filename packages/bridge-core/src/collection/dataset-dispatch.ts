import { isLocalArtworkCommand, isLocalArtworkInternalCommand } from '@music-bridge/contracts';
import { isLocalOrganizerCommand } from '@music-bridge/contracts';
import { isLocalLegacyLinksCommand } from '@music-bridge/contracts';
import { isLocalSourceWritesCommand } from '@music-bridge/contracts';
import { isLocalRelocationPlanCommand } from '@music-bridge/contracts';
import { withLocalFactsMutation } from '../stream/local-source-fence.js';
import {isLocalRelocationCommand,isLocalRelocationInternalCommand} from '@music-bridge/contracts';
import { isScanPreparedBatch } from './local-scan-store.js';
import { loadCassetteArchive } from './cassette-archive.js';
import { isLocalScanCommand, isLocalScanInternalCommand, isLocalCatalogCommand, isLocalCatalogInternalCommand, validateIpcRequest, validateIpcInternalRequest } from '@music-bridge/contracts';
import { IPC_VERSION, isCommandOutboxExecute, type IpcCommand, type IpcCommandPayloads, type IpcRequest } from '@music-bridge/contracts';
import { CollectionError, type CollectionRepository } from './repository.js';
import { BridgeError } from '../shared/errors.js';
import { RecordingReplicaError } from '../recording/replica-error.js';
import { DeviceSelectionError } from '../recording/device-selection-broker.js';
import { AttemptError } from '../recording/attempt-integrity.js';
import { OutputCheckError } from '../recording/output-error.js';
import { DatasetScopeError } from '../recording/dataset-identity.js';
import { readSpreadsheetFile } from './spreadsheet-files.js';
import { parseSpreadsheetWorkbook } from './spreadsheet-parser.js';
import { isDatasetCommand } from './dataset-owner-protocol.js';
import type { DatasetServices } from './dataset-services.js';

export type DatasetDispatchTarget = Partial<DatasetServices>;

function backupsFor(runtime: DatasetDispatchTarget) {
  if (!runtime.backups) throw new CollectionError('INVENTORY_UNAVAILABLE', '备份维护服务尚未就绪。');
  return runtime.backups;
}

function collectionFor(runtime: DatasetDispatchTarget): CollectionRepository {
  if (!runtime.collection) throw new CollectionError('INVENTORY_UNAVAILABLE', '库存服务尚未就绪，请重试。');
  return runtime.collection;
}

function scanFor(runtime:DatasetDispatchTarget) {
  if(!runtime.localScan) throw new CollectionError('INVENTORY_UNAVAILABLE','扫描owner尚未就绪。');return runtime.localScan;
}
function artworkFor(runtime: DatasetDispatchTarget) {
  if (!runtime.localArtwork) throw new CollectionError('INVENTORY_UNAVAILABLE', '封面服务尚未就绪。');
  return runtime.localArtwork;
}
function sourcesFor(runtime: DatasetDispatchTarget) {
  if (!runtime.sources) throw new BridgeError('BAD_REQUEST', '源文件服务尚未就绪。', { httpStatus: 503 });
  return runtime.sources;
}

function candidatesFor(runtime: DatasetDispatchTarget) {
  if (!runtime.sourceCandidates) throw new BridgeError('BAD_REQUEST', '候选扫描服务尚未就绪。', { httpStatus: 503 });
  return runtime.sourceCandidates;
}

function masterVersionsFor(runtime: DatasetDispatchTarget) {
  if (!runtime.masterVersions) throw new CollectionError('INVENTORY_UNAVAILABLE', '母版版本服务尚未就绪，请重试。');
  return runtime.masterVersions;
}
function executionFor(runtime: DatasetDispatchTarget) {
  if (!runtime.execution) throw new CollectionError('INVENTORY_UNAVAILABLE', '执行资产服务尚未就绪，请重试。');
  return runtime.execution;
}
function recordingReplicaFor(runtime: DatasetDispatchTarget) {
  if (!runtime.recordingReplica) throw new RecordingReplicaError('BACKEND_UNAVAILABLE');
  return runtime.recordingReplica;
}
function recordingDeviceFor(runtime: DatasetDispatchTarget) {
  if (!runtime.recordingDeviceSelection) throw new DeviceSelectionError('NO_DEVICE_CATALOG');
  return runtime.recordingDeviceSelection;
}
function recordingPrintsFor(runtime: DatasetDispatchTarget) {
  if (!runtime.recordingPrints) throw new CollectionError('INVENTORY_UNAVAILABLE', '印刷资料服务尚未就绪。');
  return runtime.recordingPrints;
}
function recordingRecordsFor(runtime: DatasetDispatchTarget) {
  if (!runtime.recordingRecords) throw new CollectionError('INVENTORY_UNAVAILABLE', '录音档案服务尚未就绪。');
  return runtime.recordingRecords;
}
function recordingAttemptsFor(runtime: DatasetDispatchTarget) {
  if (!runtime.recordingAttempts) throw new AttemptError('CLOSED');
  return runtime.recordingAttempts;
}
function recordingOutputFor(runtime: DatasetDispatchTarget) {
  if (!runtime.recordingOutput) throw new OutputCheckError('HELPER_UNAVAILABLE');
  return runtime.recordingOutput;
}
function recordingPlansFor(runtime: DatasetDispatchTarget) {
  if (!runtime.recordingPlans) throw new CollectionError('INVENTORY_UNAVAILABLE', '录音计划服务尚未就绪，请重试。');
  return runtime.recordingPlans;
}
function archiveFor(runtime: DatasetDispatchTarget) {
  if (!runtime.archive) throw new CollectionError('INVENTORY_UNAVAILABLE', '归档服务尚未就绪，请重试。');
  return runtime.archive;
}
function preparedFor(runtime: DatasetDispatchTarget) {
  if (!runtime.prepared) throw new CollectionError('INVENTORY_UNAVAILABLE', 'PREP 服务尚未就绪，请重试。');
  return runtime.prepared;
}
function preparationFor(runtime: DatasetDispatchTarget) {
  if (!runtime.preparation) throw new CollectionError('INVENTORY_UNAVAILABLE', 'Logic 工作区服务尚未就绪，请重试。');
  return runtime.preparation;
}
function preparationZipFor(runtime: DatasetDispatchTarget) {
  if (!runtime.preparationZips) throw new CollectionError('INVENTORY_UNAVAILABLE', 'Logic ZIP 导出服务尚未就绪，请重试。');
  return runtime.preparationZips;
}

function mediaPlanningFor(runtime: DatasetDispatchTarget) {
  if (!runtime.mediaPlanning) throw new CollectionError('INVENTORY_UNAVAILABLE', '录音规划服务尚未就绪，请重试。');
  return runtime.mediaPlanning;
}

function masterDraftsFor(runtime: DatasetDispatchTarget) {
  if (!runtime.masterDrafts) throw new BridgeError('ROON_LIBRARY_UNAVAILABLE', '录音草稿服务尚未就绪。', { httpStatus: 503 });
  return runtime.masterDrafts;
}

function physicalLinksFor(runtime: DatasetDispatchTarget) {
  if (!runtime.physicalLinks) throw new BridgeError('ROON_LIBRARY_UNAVAILABLE', 'Roon 关联服务尚未就绪。', { httpStatus: 503 });
  return runtime.physicalLinks;
}

export async function dispatchDatasetCommand(
  runtime: DatasetDispatchTarget,
  request: IpcRequest,
): Promise<unknown> {
  return dispatchDataset(runtime, request, false);
}

/** 仅既有owner私有通路；内部许可不由请求payload中的标志授予。 */
export async function dispatchInternalDatasetCommand(runtime: DatasetDispatchTarget, request: IpcRequest): Promise<unknown> {
  if (!(isLocalArtworkInternalCommand(request.command) || isLocalCatalogInternalCommand(request.command) || isLocalScanInternalCommand(request.command) || isLocalRelocationInternalCommand(request.command))) throw new BridgeError('BAD_REQUEST', '内部本地观察命令无效。');
  return dispatchDataset(runtime, request, true);
}

async function dispatchDataset(runtime: DatasetDispatchTarget, request: IpcRequest, internal: boolean): Promise<unknown> {
  if (!isDatasetCommand(request.command)) throw new BridgeError('BAD_REQUEST', '工作库命令无效。');
  runtime.assertOpen?.();
  if (isLocalRelocationPlanCommand(request.command) || isLocalSourceWritesCommand(request.command) || isLocalLegacyLinksCommand(request.command) || isLocalOrganizerCommand(request.command) || isLocalArtworkCommand(request.command) || isLocalCatalogCommand(request.command) || isLocalScanCommand(request.command) || isLocalRelocationCommand(request.command) || request.command === 'localCatalog.prepare') {
    const checked = internal ? validateIpcInternalRequest(request) : validateIpcRequest(request);
    if (!checked.ok) throw new BridgeError('BAD_REQUEST', '本地目录请求无效。');
    if (isLocalRelocationPlanCommand(request.command) || isLocalSourceWritesCommand(request.command) || isLocalLegacyLinksCommand(request.command)) request = checked.value as IpcRequest;
    if (!runtime.commandOutbox) throw new DatasetScopeError();
  }
  if ((request.command.startsWith('recordingAttempts.') || request.command.startsWith('recordingRecords.') || request.command.startsWith('recordingReplica.') || request.command.startsWith('recordingDevice.') || request.command.startsWith('recordingWorkspace.') || request.command.startsWith('recordingCandidates.') || request.command.startsWith('recordingPreparationZip.') || request.command === 'collection.copy' || request.command.startsWith('masterArtwork.') || request.command.startsWith('recordingPrints.') || request.command.startsWith('recordingPrintWorker.')) && (!request.expectedDatasetId || !runtime.commandOutbox)) throw new DatasetScopeError();
  if (request.expectedDatasetId !== undefined) {
    if (!runtime.commandOutbox) throw new CollectionError('INVENTORY_UNAVAILABLE', '工作库身份尚未就绪。');
    runtime.commandOutbox.assertScope(request.expectedDatasetId);
  }
  // 原录音SourceLock/严格证据不变；读文件/正式输出入口先等待scan实际quiet，再进入原业务门禁。
  if (runtime.localScan && ['recordingSources.start','recordingAttempts.confirm','recordingAttempts.beginSide','recordingReplica.start','recordingExecution.start'].includes(request.command)) await runtime.localScan.yieldForMedia();
  switch (request.command as IpcCommand) {
    case 'localRelocationPlan.chooseTarget': case 'localRelocationPlan.confirm': case 'localRelocationPlan.cleanup': throw new BridgeError('BAD_REQUEST', '搬迁具体能力仅由当前真实Main专用通道受理。');
    case 'localRelocationPlan.preview': if (!runtime.localRelocationPlans) throw new CollectionError('INVENTORY_UNAVAILABLE', '搬迁Owner尚未就绪。'); return runtime.localRelocationPlans.preview(request.payload as IpcCommandPayloads['localRelocationPlan.preview']);
    case 'localRelocationPlan.get': if (!runtime.localRelocationPlans) throw new CollectionError('INVENTORY_UNAVAILABLE', '搬迁Owner尚未就绪。'); return runtime.localRelocationPlans.get(request.payload as IpcCommandPayloads['localRelocationPlan.get']);
    case 'localRelocationPlan.history': if (!runtime.localRelocationPlans) throw new CollectionError('INVENTORY_UNAVAILABLE', '搬迁Owner尚未就绪。'); return runtime.localRelocationPlans.history(request.payload as IpcCommandPayloads['localRelocationPlan.history']);
    case 'localRelocationPlan.cancel': if (!runtime.localRelocationPlans) throw new CollectionError('INVENTORY_UNAVAILABLE', '搬迁Owner尚未就绪。'); return runtime.localRelocationPlans.cancel(request.payload as IpcCommandPayloads['localRelocationPlan.cancel']);
    case 'localRelocationPlan.setPolicy': if (!runtime.localRelocationPlans) throw new CollectionError('INVENTORY_UNAVAILABLE', '搬迁Owner尚未就绪。'); return runtime.localRelocationPlans.setPolicy(request.payload as IpcCommandPayloads['localRelocationPlan.setPolicy']);
    case 'localSourceWrites.preview':if(!runtime.localSourceWrites)throw new CollectionError('INVENTORY_UNAVAILABLE','源写 Owner 尚未就绪。');return runtime.localSourceWrites.preview(request.payload as IpcCommandPayloads['localSourceWrites.preview']);
    case 'localSourceWrites.get':if(!runtime.localSourceWrites)throw new CollectionError('INVENTORY_UNAVAILABLE','源写 Owner 尚未就绪。');return runtime.localSourceWrites.get(request.payload as IpcCommandPayloads['localSourceWrites.get']);
    case 'localSourceWrites.history':if(!runtime.localSourceWrites)throw new CollectionError('INVENTORY_UNAVAILABLE','源写 Owner 尚未就绪。');return runtime.localSourceWrites.history(request.payload as IpcCommandPayloads['localSourceWrites.history']);
    case 'localSourceWrites.confirm':if(!runtime.localSourceWrites)throw new CollectionError('INVENTORY_UNAVAILABLE','源写 Owner 尚未就绪。');return runtime.localSourceWrites.confirm(request.payload as IpcCommandPayloads['localSourceWrites.confirm']);
    case 'localSourceWrites.undo':if(!runtime.localSourceWrites)throw new CollectionError('INVENTORY_UNAVAILABLE','源写 Owner 尚未就绪。');return runtime.localSourceWrites.undo(request.payload as IpcCommandPayloads['localSourceWrites.undo']);
    case 'localSourceWrites.cancel':if(!runtime.localSourceWrites)throw new CollectionError('INVENTORY_UNAVAILABLE','源写 Owner 尚未就绪。');return runtime.localSourceWrites.cancel(request.payload as IpcCommandPayloads['localSourceWrites.cancel']);
    case 'localSourceWrites.setPolicy':if(!runtime.localSourceWrites)throw new CollectionError('INVENTORY_UNAVAILABLE','源写 Owner 尚未就绪。');return runtime.localSourceWrites.setPolicy(request.payload as IpcCommandPayloads['localSourceWrites.setPolicy']);
    case 'localLegacyLinks.read': if(!runtime.localLegacyLinks)throw new CollectionError('INVENTORY_UNAVAILABLE','旧库关联 owner 尚未就绪。');return runtime.localLegacyLinks.read(request.payload as IpcCommandPayloads['localLegacyLinks.read']);
    case 'localLegacyLinks.history': if(!runtime.localLegacyLinks)throw new CollectionError('INVENTORY_UNAVAILABLE','旧库关联 owner 尚未就绪。');return runtime.localLegacyLinks.history(request.payload as IpcCommandPayloads['localLegacyLinks.history']);
    case 'localLegacyLinks.preview': if(!runtime.localLegacyLinks)throw new CollectionError('INVENTORY_UNAVAILABLE','旧库关联 owner 尚未就绪。');return runtime.localLegacyLinks.preview(request.payload as IpcCommandPayloads['localLegacyLinks.preview']);
    case 'localLegacyLinks.confirm': if(!runtime.localLegacyLinks)throw new CollectionError('INVENTORY_UNAVAILABLE','旧库关联 owner 尚未就绪。');return runtime.localLegacyLinks.confirm(request.payload as IpcCommandPayloads['localLegacyLinks.confirm']);
    case 'localLegacyLinks.revoke': if(!runtime.localLegacyLinks)throw new CollectionError('INVENTORY_UNAVAILABLE','旧库关联 owner 尚未就绪。');return runtime.localLegacyLinks.revoke(request.payload as IpcCommandPayloads['localLegacyLinks.revoke']);
    case 'localLegacyLinks.undo': if(!runtime.localLegacyLinks)throw new CollectionError('INVENTORY_UNAVAILABLE','旧库关联 owner 尚未就绪。');return runtime.localLegacyLinks.undo(request.payload as IpcCommandPayloads['localLegacyLinks.undo']);
    case 'localOrganizer.preview': if (!runtime.localOrganizer) throw new CollectionError('INVENTORY_UNAVAILABLE', '整理owner尚未就绪。'); return runtime.localOrganizer.preview(request.payload as IpcCommandPayloads['localOrganizer.preview']);
    case 'localOrganizer.get': if (!runtime.localOrganizer) throw new CollectionError('INVENTORY_UNAVAILABLE', '整理owner尚未就绪。'); return runtime.localOrganizer.get(request.payload as IpcCommandPayloads['localOrganizer.get']);
    case 'localOrganizer.history': if (!runtime.localOrganizer) throw new CollectionError('INVENTORY_UNAVAILABLE', '整理owner尚未就绪。'); return runtime.localOrganizer.history(request.payload as IpcCommandPayloads['localOrganizer.history']);
    case 'localOrganizer.confirm': if (!runtime.localOrganizer) throw new CollectionError('INVENTORY_UNAVAILABLE', '整理owner尚未就绪。'); return runtime.localOrganizer.confirm(request.payload as IpcCommandPayloads['localOrganizer.confirm']);
    case 'localOrganizer.undo': if (!runtime.localOrganizer) throw new CollectionError('INVENTORY_UNAVAILABLE', '整理owner尚未就绪。'); return runtime.localOrganizer.undo(request.payload as IpcCommandPayloads['localOrganizer.undo']);
    case 'localOrganizer.cancel': if (!runtime.localOrganizer) throw new CollectionError('INVENTORY_UNAVAILABLE', '整理owner尚未就绪。'); return runtime.localOrganizer.cancel(request.payload as IpcCommandPayloads['localOrganizer.cancel']);
    case 'localArtwork.context': return artworkFor(runtime).context(request.payload as IpcCommandPayloads['localArtwork.context']);
    case 'localArtwork.apply': return artworkFor(runtime).apply(request.payload as IpcCommandPayloads['localArtwork.apply']);
    case 'localArtwork.createEdition': return artworkFor(runtime).createEdition(request.payload as IpcCommandPayloads['localArtwork.createEdition']);
    case 'localArtwork.stage': return artworkFor(runtime).stage(request.payload as IpcCommandPayloads['localArtwork.stage']);
    case 'localArtwork.readCandidates': return artworkFor(runtime).readCandidates(request.payload as IpcCommandPayloads['localArtwork.readCandidates']);
    case 'localArtwork.cancelLookup': return artworkFor(runtime).cancelLookup((request.payload as IpcCommandPayloads['localArtwork.cancelLookup']).lookupId);
    case 'localRelocation.roots': if(!runtime.localRelocation)throw new CollectionError('INVENTORY_UNAVAILABLE','重定位owner未就绪。');return runtime.localRelocation.roots();
    case 'localRelocation.registerRoot': if(!runtime.localRelocation)throw new CollectionError('INVENTORY_UNAVAILABLE','重定位owner未就绪。');return runtime.localRelocation.registerRoot(request.payload as IpcCommandPayloads['localRelocation.registerRoot']);
    case 'localRelocation.capture': if(!runtime.localRelocation)throw new CollectionError('INVENTORY_UNAVAILABLE','重定位owner未就绪。');return runtime.localRelocation.capture(request.payload as IpcCommandPayloads['localRelocation.capture']);
    case 'localRelocation.confirm': if(!runtime.localRelocation)throw new CollectionError('INVENTORY_UNAVAILABLE','重定位owner未就绪。');return runtime.localRelocation.confirm(request.payload as IpcCommandPayloads['localRelocation.confirm']);
    case 'localRelocation.relinkRoot': if(!runtime.localRelocation)throw new CollectionError('INVENTORY_UNAVAILABLE','重定位owner未就绪。');return runtime.localRelocation.relinkRoot(request.payload as IpcCommandPayloads['localRelocation.relinkRoot']);
    case 'localScan.start': return scanFor(runtime).start(request.payload as IpcCommandPayloads['localScan.start']);
    case 'localScan.pause': return scanFor(runtime).pause(request.payload as IpcCommandPayloads['localScan.pause']);
    case 'localScan.resume': return scanFor(runtime).resume(request.payload as IpcCommandPayloads['localScan.resume']);
    case 'localScan.cancel': return scanFor(runtime).cancel(request.payload as IpcCommandPayloads['localScan.cancel']);
    case 'localScan.get': return scanFor(runtime).get((request.payload as IpcCommandPayloads['localScan.get']).jobId);
    case 'localScan.page': return scanFor(runtime).page(request.payload as IpcCommandPayloads['localScan.page']);
    case 'localScan.receipt': return scanFor(runtime).receipt((request.payload as IpcCommandPayloads['localScan.receipt']).commandId);
    case 'localScan.prepareBatch': {
      const value=request.payload as IpcCommandPayloads['localScan.prepareBatch'];
      if(!isScanPreparedBatch(value.batch)) throw new BridgeError('BAD_REQUEST','可信扫描批结构无效。');
      return scanFor(runtime).prepareBatch({...value,batch:value.batch});
    }
    case 'localScan.commitBatch': return scanFor(runtime).commitBatch(request.payload as IpcCommandPayloads['localScan.commitBatch']);
    // 当前owner没有稳定Core/Zone权威；禁止用公开target自证准备或执行播放动作。
    case 'localCatalog.prepare': return { status: 'unsupported', reason: 'TARGET_AUTHORITY_UNAVAILABLE' } satisfies import('@music-bridge/contracts').LocalSourceUnsupported;
    case 'localCatalog.registerRoot': return collectionFor(runtime).localCatalog.registerRoot(request.payload as IpcCommandPayloads['localCatalog.registerRoot']);
    case 'localCatalog.relinkRoot': return withLocalFactsMutation(() => collectionFor(runtime).localCatalog.relinkRoot(request.payload as IpcCommandPayloads['localCatalog.relinkRoot']));
    case 'localCatalog.registerAsset': return collectionFor(runtime).localCatalog.registerAsset(request.payload as IpcCommandPayloads['localCatalog.registerAsset']);
    case 'localCatalog.moveAsset': return withLocalFactsMutation(() => collectionFor(runtime).localCatalog.moveAsset(request.payload as IpcCommandPayloads['localCatalog.moveAsset']));
    case 'localCatalog.replaceAsset': return withLocalFactsMutation(() => collectionFor(runtime).localCatalog.replaceAsset(request.payload as IpcCommandPayloads['localCatalog.replaceAsset']));
    case 'localCatalog.createTrack': return collectionFor(runtime).localCatalog.createTrack(request.payload as IpcCommandPayloads['localCatalog.createTrack']);
    case 'localCatalog.selectAsset': return withLocalFactsMutation(() => collectionFor(runtime).localCatalog.selectAsset(request.payload as IpcCommandPayloads['localCatalog.selectAsset']));
    case 'localCatalog.createEdition': return collectionFor(runtime).localCatalog.createEdition(request.payload as IpcCommandPayloads['localCatalog.createEdition']);
    case 'localCatalog.linkEditionTrack': return collectionFor(runtime).localCatalog.linkEditionTrack(request.payload as IpcCommandPayloads['localCatalog.linkEditionTrack']);
    case 'localCatalog.removeEditionTrack': return collectionFor(runtime).localCatalog.removeEditionTrack(request.payload as IpcCommandPayloads['localCatalog.removeEditionTrack']);
    case 'localCatalog.observeMetadata': return collectionFor(runtime).localCatalog.observeMetadata(request.payload as IpcCommandPayloads['localCatalog.observeMetadata']);
    case 'localCatalog.overrideMetadata': return collectionFor(runtime).localCatalog.overrideMetadata(request.payload as IpcCommandPayloads['localCatalog.overrideMetadata']);
    case 'localCatalog.pageTracks': return collectionFor(runtime).localCatalog.pageTracks(request.payload as IpcCommandPayloads['localCatalog.pageTracks']);
    case 'localCatalog.queryTracks': return collectionFor(runtime).localCatalog.queryTracks(request.payload as IpcCommandPayloads['localCatalog.queryTracks']);
    case 'localCatalog.trackDetail': {
      const repository = collectionFor(runtime), detail = repository.localCatalog.trackDetail((request.payload as IpcCommandPayloads['localCatalog.trackDetail']).trackId);
      return { ...detail, fileParameters: repository.localScan.privateDisplayFileParameters(detail.track.id, detail.asset) };
    }
    case 'localCatalog.root': return collectionFor(runtime).localCatalog.root((request.payload as IpcCommandPayloads['localCatalog.root']).rootId);
    case 'localCatalog.asset': return collectionFor(runtime).localCatalog.asset((request.payload as IpcCommandPayloads['localCatalog.asset']).assetId);
    case 'localCatalog.track': return collectionFor(runtime).localCatalog.track((request.payload as IpcCommandPayloads['localCatalog.track']).trackId);
    case 'localCatalog.edition': return collectionFor(runtime).localCatalog.edition((request.payload as IpcCommandPayloads['localCatalog.edition']).editionId);
    case 'localCatalog.editionTracks': return collectionFor(runtime).localCatalog.editionTracks((request.payload as IpcCommandPayloads['localCatalog.editionTracks']).editionId);
    case 'localCatalog.observations': return collectionFor(runtime).localCatalog.observations((request.payload as IpcCommandPayloads['localCatalog.observations']).trackId);
    case 'localCatalog.metadata': return collectionFor(runtime).localCatalog.metadata((request.payload as IpcCommandPayloads['localCatalog.metadata']).trackId);
    case 'localCatalog.roots': return collectionFor(runtime).localCatalog.roots();
    case 'localCatalog.receipt': {
      const value = request.payload as IpcCommandPayloads['localCatalog.receipt'];
      const receipt = collectionFor(runtime).localCatalog.receipt(value.commandId);
      if (receipt && (receipt.operation !== value.operation || receipt.fingerprint !== value.fingerprint)) throw new CollectionError('INVENTORY_CONFLICT', '回执与原完整请求不一致。');
      return receipt;
    }
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
      return { command: value.command, result: await dispatchDatasetCommand(runtime, { version: IPC_VERSION, id: request.id, command: value.command, payload: value.payload, expectedDatasetId: value.datasetId }) };
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
    case 'recordingCandidates.start': return candidatesFor(runtime).start(request.payload as IpcCommandPayloads['recordingCandidates.start']);
    case 'recordingCandidates.get': return candidatesFor(runtime).get((request.payload as IpcCommandPayloads['recordingCandidates.get']).id);
    case 'recordingCandidates.cancel': return candidatesFor(runtime).cancel(request.payload as IpcCommandPayloads['recordingCandidates.cancel']);
    case 'recordingCandidates.select': return candidatesFor(runtime).select(request.payload as IpcCommandPayloads['recordingCandidates.select']);
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
    case 'recordingReplica.control': return recordingReplicaFor(runtime).control(request.payload as IpcCommandPayloads['recordingReplica.control']);
    case 'recordingDevice.candidates': return recordingDeviceFor(runtime).list();
    case 'recordingDevice.select': return recordingDeviceFor(runtime).select(request.payload as IpcCommandPayloads['recordingDevice.select']);
    case 'recordingRecords.list': return recordingRecordsFor(runtime).list(request.payload as IpcCommandPayloads['recordingRecords.list']);
    case 'recordingRecords.get': return recordingRecordsFor(runtime).get(request.payload as IpcCommandPayloads['recordingRecords.get']);
    case 'recordingRecords.visual': return recordingRecordsFor(runtime).visual(request.payload as IpcCommandPayloads['recordingRecords.visual']);
    case 'recordingRecords.history': return recordingRecordsFor(runtime).history(request.payload as IpcCommandPayloads['recordingRecords.history']);
    case 'recordingRecords.previewDisposition': return recordingRecordsFor(runtime).previewDisposition(request.payload as IpcCommandPayloads['recordingRecords.previewDisposition']);
    case 'recordingRecords.applyDisposition': return recordingRecordsFor(runtime).applyDisposition(request.payload as IpcCommandPayloads['recordingRecords.applyDisposition']);
    case 'recordingAttempts.list': return recordingAttemptsFor(runtime).list(request.payload as IpcCommandPayloads['recordingAttempts.list']);
    case 'recordingAttempts.get': return recordingAttemptsFor(runtime).get(request.payload as IpcCommandPayloads['recordingAttempts.get']);
    case 'recordingAttempts.begin': return recordingAttemptsFor(runtime).begin(request.payload as IpcCommandPayloads['recordingAttempts.begin']);
    case 'recordingAttempts.receipt': return recordingAttemptsFor(runtime).receipt(request.payload as IpcCommandPayloads['recordingAttempts.receipt']);
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
    case 'recordingWorkspace.get': return { context: collectionFor(runtime).workspace.get((request.payload as IpcCommandPayloads['recordingWorkspace.get']).draftId) };
    case 'recordingWorkspace.put': return collectionFor(runtime).workspace.put(request.payload as IpcCommandPayloads['recordingWorkspace.put']);
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
      runtime.assertOpen?.();
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
    case 'referenceCatalog.previewArchive':
    case 'referenceCatalog.importArchive': {
      const repository = collectionFor(runtime), root = repository.privateReferenceArchiveDirectory?.();
      if (!root) throw new CollectionError('INVENTORY_UNAVAILABLE', '磁带资料档案目录尚未就绪。');
      const payload = request.payload as IpcCommandPayloads['referenceCatalog.importArchive'];
      if (!runtime.commandOutbox || runtime.commandOutbox.context().datasetId !== payload.expectedDatasetId)
        throw new CollectionError('INVENTORY_CONFLICT', '资料库已切换，原档案预览不能写入当前资料库。');
      const archive = await loadCassetteArchive(root, payload.archiveSha256);
      if (runtime.commandOutbox.context().datasetId !== payload.expectedDatasetId || collectionFor(runtime) !== repository)
        throw new CollectionError('INVENTORY_CONFLICT', '档案校验期间资料库已切换，请重新预览。');
      return request.command === 'referenceCatalog.previewArchive'
        ? repository.catalog.previewArchiveCatalog(payload, archive.rawPack)
        : repository.catalog.importArchiveCatalog(payload, archive.rawPack);
    }
    case 'referenceCatalog.previewSourceZip': return collectionFor(runtime).catalog.previewSourceZip(request.payload as IpcCommandPayloads['referenceCatalog.previewSourceZip']);
    case 'referenceCatalog.registerSourceZip': return collectionFor(runtime).catalog.registerSourceZip(request.payload as IpcCommandPayloads['referenceCatalog.registerSourceZip']);
    case 'referenceCatalog.sourceZipReceipts': return collectionFor(runtime).catalog.sourceZipReceipts(request.payload as IpcCommandPayloads['referenceCatalog.sourceZipReceipts']);
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
    case 'recordingPreparationZip.authorizeTarget': return preparationZipFor(runtime).authorizeTarget(request.payload as IpcCommandPayloads['recordingPreparationZip.authorizeTarget']);
    case 'recordingPreparationZip.invalidateScope': preparationZipFor(runtime).invalidateScope((request.payload as IpcCommandPayloads['recordingPreparationZip.invalidateScope']).scopeId); return { invalidated: true as const };
    case 'recordingPreparationZip.preview': return preparationZipFor(runtime).preview(request.payload as IpcCommandPayloads['recordingPreparationZip.preview']);
    case 'recordingPreparationZip.start': return preparationZipFor(runtime).start(request.payload as IpcCommandPayloads['recordingPreparationZip.start']);
    case 'recordingPreparationZip.list': return preparationZipFor(runtime).list((request.payload as IpcCommandPayloads['recordingPreparationZip.list']).draftId);
    case 'recordingPreparationZip.job': return preparationZipFor(runtime).job((request.payload as IpcCommandPayloads['recordingPreparationZip.job']).id);
    case 'recordingPreparationZip.receipt': return preparationZipFor(runtime).receipt(request.payload as IpcCommandPayloads['recordingPreparationZip.receipt']);
    case 'recordingPreparationZip.cancel': return preparationZipFor(runtime).cancel(request.payload as IpcCommandPayloads['recordingPreparationZip.cancel']);
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
      for (const item of result.items) { const evidence = runtime.sources ? await runtime.sources.snapshot(item.id) : undefined; runtime.assertOpen?.(); const latest = collectionFor(runtime).drafts.detail(item.id); items.push({ ...item, sourceLockEligible: latest.revision === item.revision && evidence?.sourceLockEligible === true }); }
      return { ...result, items };
    }
    case 'recordingDrafts.detail': {
      const id = (request.payload as IpcCommandPayloads['recordingDrafts.detail']).id;
      const evidence = runtime.sources ? await runtime.sources.snapshot(id) : undefined;
      runtime.assertOpen?.();
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
    case 'physicalLinks.history': { const p = request.payload as IpcCommandPayloads['physicalLinks.history']; return collectionFor(runtime).links.history(p.releaseId, p.page); }
    case 'physicalLinks.runtime': return physicalLinksFor(runtime).runtime((request.payload as IpcCommandPayloads['physicalLinks.runtime']).id);
    case 'physicalLinks.matrix': { const p = request.payload as IpcCommandPayloads['physicalLinks.matrix']; return collectionFor(runtime).links.matrix(p.page, p.query); }
    case 'physicalLinks.confirm': return physicalLinksFor(runtime).confirm(request.payload as IpcCommandPayloads['physicalLinks.confirm']);
    case 'physicalLinks.confirmWithEvidence': return physicalLinksFor(runtime).confirm(request.payload as IpcCommandPayloads['physicalLinks.confirmWithEvidence']);
    case 'physicalLinks.relocate': return physicalLinksFor(runtime).relocate(request.payload as IpcCommandPayloads['physicalLinks.relocate']);
    case 'physicalLinks.register': return physicalLinksFor(runtime).register(request.payload as IpcCommandPayloads['physicalLinks.register']);
    case 'physicalLinks.remove': return physicalLinksFor(runtime).remove(request.payload as IpcCommandPayloads['physicalLinks.remove']);
    case 'physicalLinks.removeWithEvidence': return physicalLinksFor(runtime).remove(request.payload as IpcCommandPayloads['physicalLinks.removeWithEvidence']);
    case 'physicalLinks.absence': return physicalLinksFor(runtime).absence(request.payload as IpcCommandPayloads['physicalLinks.absence']);
    case 'physicalMusic.list': { const p = request.payload as IpcCommandPayloads['physicalMusic.list']; return collectionFor(runtime).music.list(p.page, p.filter); }
    case 'physicalMusic.detail': return collectionFor(runtime).music.detail((request.payload as IpcCommandPayloads['physicalMusic.detail']).id);
    case 'physicalMusic.copies': { const p = request.payload as IpcCommandPayloads['physicalMusic.copies']; return collectionFor(runtime).music.copies(p.releaseId, p.page); }
    case 'physicalMusic.photo': return collectionFor(runtime).music.photo((request.payload as IpcCommandPayloads['physicalMusic.photo']).photoId);
    case 'physicalMusic.saveRelease': return collectionFor(runtime).music.saveRelease(request.payload as IpcCommandPayloads['physicalMusic.saveRelease']);
    case 'physicalMusic.materializeCopy': return collectionFor(runtime).music.materializeCopy(request.payload as IpcCommandPayloads['physicalMusic.materializeCopy']);
    case 'physicalMusic.saveCopyDetails': return collectionFor(runtime).music.saveCopyDetails(request.payload as IpcCommandPayloads['physicalMusic.saveCopyDetails']);
    case 'physicalMusic.assignCopyPhoto': return collectionFor(runtime).music.assignCopyPhoto(request.payload as IpcCommandPayloads['physicalMusic.assignCopyPhoto']);
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
    case 'collection.copy': return collectionFor(runtime).copy((request.payload as IpcCommandPayloads['collection.copy']).physicalId);
    case 'collection.receive':
      return collectionFor(runtime).receive(request.payload as IpcCommandPayloads['collection.receive']);
    case 'collection.materialize':
      return collectionFor(runtime).materialize(request.payload as IpcCommandPayloads['collection.materialize']);
    case 'collection.updateCopy':
      return collectionFor(runtime).updateCopy(request.payload as IpcCommandPayloads['collection.updateCopy']);
    case 'collection.setPolicy':
      return collectionFor(runtime).setPolicy(request.payload as IpcCommandPayloads['collection.setPolicy']);
    default: throw new BridgeError('BAD_REQUEST', '工作库命令无效。');
  }
}
