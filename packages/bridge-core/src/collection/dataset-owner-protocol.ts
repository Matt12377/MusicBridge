import { LOCAL_ARTWORK_COMMANDS, isLocalArtworkInternalCommand } from '@music-bridge/contracts';
import { LOCAL_ORGANIZER_COMMANDS } from '@music-bridge/contracts';
import { LOCAL_LEGACY_LINKS_COMMANDS } from '@music-bridge/contracts';
import type {MBQueueLoadResult} from './mb-queue-owner-types.js';
import { isMBEditionQueueRequest, type MBEditionQueueRequest, type MBEditionQueueSnapshot, isMBQueueSaveRequest, type MBQueueRecord, type MBQueueSaveRequest } from '@music-bridge/contracts';
import { isLocalSourcePrivatePayload, type LocalSourcePrivatePayload, type LocalSourceCaptureResult } from './local-source-ticket-types.js';
import type { LocalPlayRequest } from '@music-bridge/contracts';
import {LOCAL_RELOCATION_COMMANDS,isLocalRelocationCommand,isLocalRelocationInternalCommand,isLocalRelocationCommandResult} from '@music-bridge/contracts';
import { LOCAL_CATALOG_COMMANDS, LOCAL_LIBRARY_READ_COMMANDS, LOCAL_SCAN_COMMANDS, isLocalScanInternalCommand, isLocalCatalogInternalCommand } from '@music-bridge/contracts';
import { IPC_VERSION, isCollectionId, isCollectionModel, isCommandOutboxDatasetId, isRoonAlbumReference, isDigitalAlbumMetadata, isDraftTrackMetadata, validateIpcRequest, validateIpcResponse, validateIpcResponseForCommand,
  type CollectionModel, type IpcCommand, type IpcFailure, type IpcRequest, type PageRequest, type RoonLibraryPage, type DigitalAlbumMetadata, type DraftTrackMetadata } from '@music-bridge/contracts';

export const DATASET_OWNER_PROTOCOL_VERSION = 1 as const;
// 原领域作者命令及本地库只读入口组成固定闭集；新命令必须显式加入，不能按前缀自动授权。
export const DATASET_COMMANDS = [
  ...LOCAL_LEGACY_LINKS_COMMANDS,
  ...LOCAL_ARTWORK_COMMANDS,
  ...LOCAL_ORGANIZER_COMMANDS,
  ...LOCAL_CATALOG_COMMANDS,
  ...LOCAL_LIBRARY_READ_COMMANDS,
  ...LOCAL_SCAN_COMMANDS, ...LOCAL_RELOCATION_COMMANDS,
  'localCatalog.prepare',
  'recordingBackups.activationReceipt',
  'commandOutbox.context',
  'commandOutbox.execute',
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
  'recordingCandidates.start',
  'recordingCandidates.get',
  'recordingCandidates.cancel',
  'recordingCandidates.select',
  'recordingVersions.list',
  'recordingProfiles.list',
  'recordingProfiles.history',
  'recordingProfiles.version',
  'recordingProfiles.save',
  'recordingProfiles.session',
  'recordingProfiles.saveSession',
  'recordingBackups.overview',
  'recordingBackups.activate',
  'recordingBackups.authorize',
  'recordingBackups.authorizationReceipt',
  'recordingBackups.start',
  'recordingBackups.cancel',
  'recordingBackups.revoke',
  'masterArtwork.get',
  'masterArtwork.save',
  'recordingPrints.list',
  'recordingPrints.request',
  'recordingPrints.retry',
  'recordingPrints.get',
  'recordingPrintWorker.claim',
  'recordingPrintWorker.complete',
  'recordingPrintWorker.fail',
  'recordingPrintWorker.pdf',
  'recordingReplica.status',
  'recordingReplica.inspect',
  'recordingReplica.cancelRead',
  'recordingReplica.start',
  'recordingReplica.get',
  'recordingReplica.stop',
  'recordingReplica.control',
  'recordingDevice.candidates',
  'recordingDevice.select',
  'recordingRecords.list',
  'recordingRecords.get',
  'recordingRecords.visual',
  'recordingRecords.history',
  'recordingRecords.previewDisposition',
  'recordingRecords.applyDisposition',
  'recordingAttempts.list',
  'recordingAttempts.get',
  'recordingAttempts.begin',
  'recordingAttempts.receipt',
  'recordingAttempts.confirm',
  'recordingAttempts.beginSide',
  'recordingAttempts.stop',
  'recordingOutput.status',
  'recordingOutput.check',
  'recordingOutput.cancel',
  'recordingPlans.list',
  'recordingPlans.version',
  'recordingPlans.preview',
  'recordingPlans.freeze',
  'recordingPlans.preflight',
  'recordingPlans.cancelRead',
  'recordingWorkspace.get',
  'recordingWorkspace.put',
  'recordingArchive.roots',
  'recordingArchive.authorize',
  'recordingArchive.authorizationReceipt',
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
  'recordingExecution.list',
  'recordingExecution.preview',
  'recordingExecution.start',
  'recordingExecution.job',
  'recordingExecution.cancel',
  'recordingExecution.cancelRead',
  'recordingExecution.verify',
  'collectionProgress.wants',
  'collectionProgress.saveWant',
  'collectionProgress.cancelWant',
  'collectionProgress.wantHistory',
  'collectionProgress.current',
  'collectionProgress.capture',
  'collectionProgress.snapshots',
  'collectionProgress.snapshot',
  'collectionProgress.modelLengths',
  'spreadsheetImports.registerWorkbook',
  'spreadsheetImports.workbookReceipt',
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
  'referenceCatalog.registerSource',
  'referenceCatalog.previewSourceZip',
  'referenceCatalog.registerSourceZip',
  'referenceCatalog.sourceZipReceipts',
  'referenceCatalog.sources',
  'referenceCatalog.source',
  'referenceCatalog.previewRevision',
  'referenceCatalog.publishRevision',
  'referenceCatalog.revision',
  'referenceCatalog.setMatch',
  'referenceCatalog.snapshot',
  'referenceCatalog.history',
  'recordingPrepared.list',
  'recordingPrepared.selections',
  'recordingPrepared.selectionReceipt',
  'recordingPrepared.revoke',
  'recordingPrepared.previewImport',
  'recordingPrepared.startImport',
  'recordingPrepared.job',
  'recordingPrepared.cancel',
  'recordingPrepared.review',
  'recordingPrepared.freeze',
  'recordingPrepared.select',
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
  'recordingPreparationZip.authorizeTarget',
  'recordingPreparationZip.invalidateScope',
  'recordingPreparationZip.preview',
  'recordingPreparationZip.start',
  'recordingPreparationZip.list',
  'recordingPreparationZip.job',
  'recordingPreparationZip.receipt',
  'recordingPreparationZip.cancel',
  'recordingVersions.preview',
  'recordingVersions.freeze',
  'recordingVersions.job',
  'recordingVersions.cancel',
  'recordingMedia.plans',
  'recordingMedia.detail',
  'recordingMedia.balance',
  'recordingMedia.preview',
  'recordingMedia.save',
  'recordingMedia.reserve',
  'recordingMedia.release',
  'recordingDrafts.list',
  'recordingDrafts.detail',
  'recordingDrafts.append',
  'recordingDrafts.update',
  'recordingDrafts.runtime',
  'physicalLinks.search',
  'physicalLinks.digitalList',
  'physicalLinks.digitalDetail',
  'physicalLinks.physical',
  'physicalLinks.history',
  'physicalLinks.runtime',
  'physicalLinks.matrix',
  'physicalLinks.confirm',
  'physicalLinks.confirmWithEvidence',
  'physicalLinks.relocate',
  'physicalLinks.register',
  'physicalLinks.remove',
  'physicalLinks.removeWithEvidence',
  'physicalLinks.absence',
  'physicalMusic.list',
  'physicalMusic.detail',
  'physicalMusic.copies',
  'physicalMusic.photo',
  'physicalMusic.saveRelease',
  'physicalMusic.materializeCopy',
  'physicalMusic.saveCopyDetails',
  'physicalMusic.assignCopyPhoto',
  'physicalMusic.saveLegacy',
  'physicalMusic.addPhoto',
  'physicalMusic.removePhoto',
  'collection.addPhoto',
  'collection.photo',
  'collection.changePhoto',
  'collection.list',
  'collection.detail',
  'collection.copy',
  'collection.receive',
  'collection.materialize',
  'collection.updateCopy',
  'collection.setPolicy',
  'localSourceWrites.preview','localSourceWrites.get','localSourceWrites.history','localSourceWrites.confirm','localSourceWrites.undo','localSourceWrites.cancel','localSourceWrites.setPolicy',
 ] as const satisfies readonly IpcCommand[];
export type DatasetCommand = typeof DATASET_COMMANDS[number];
const commands = new Set<string>(DATASET_COMMANDS);
export const isDatasetCommand = (value: unknown): value is DatasetCommand => typeof value === 'string' && commands.has(value);

export interface DatasetOwnerIdentity { epoch: string; datasetId: string }
export interface DatasetOwnerEndpoint {
  materializeMBEdition?(request:MBEditionQueueRequest):Promise<MBEditionQueueSnapshot>;
  loadMBQueue?(): Promise<MBQueueLoadResult>;
  saveMBQueue?(request: MBQueueSaveRequest): Promise<MBQueueRecord>;
  captureLocalSource?(selection: LocalPlayRequest): Promise<LocalSourceCaptureResult>;
  revalidateLocalSource?(ticketId: string): Promise<boolean>;
  releaseLocalSource?(ticketId: string): Promise<void>;
  isLocalSourceCurrent?(): boolean;
  sealLocalSources?(): void;
  prepare(): Promise<DatasetOwnerIdentity>;
  dispatch(request: IpcRequest): Promise<unknown>;
  dispatchInternal?(request: IpcRequest): Promise<unknown>;
  commitBoot(): Promise<void>;
  close(): Promise<void>;
}
export const MAX_DATASET_COLLECTION_MODELS = 2_000;
export const MAX_DATASET_COLLECTION_SNAPSHOT_BYTES = 4 * 1024 * 1024;
export const MAX_DATASET_LARGE_COLLECTION_MODELS = 5_000;
export const MAX_DATASET_LARGE_COLLECTION_SNAPSHOT_BYTES = 8 * 1024 * 1024;
export interface DatasetCollectionSnapshot extends DatasetOwnerIdentity { snapshotId: string; models: readonly CollectionModel[] }
export interface DatasetOwnerSnapshotEndpoint extends DatasetOwnerEndpoint {
  exportCollectionSnapshot(): Promise<DatasetCollectionSnapshot>;
}
export interface DatasetCollectionSnapshotVersion extends DatasetOwnerIdentity { revision: string }
export interface DatasetVersionedCollectionSnapshot { snapshot: DatasetCollectionSnapshot; version: DatasetCollectionSnapshotVersion }
export interface DatasetOwnerVersionedSnapshotEndpoint extends DatasetOwnerSnapshotEndpoint {
  getCollectionSnapshotVersion(): Promise<DatasetCollectionSnapshotVersion>;
  exportVersionedCollectionSnapshot(): Promise<DatasetVersionedCollectionSnapshot>;
}
export interface DatasetOwnerLargeSnapshotEndpoint extends DatasetOwnerVersionedSnapshotEndpoint {
  exportLargeVersionedCollectionSnapshot(): Promise<DatasetVersionedCollectionSnapshot>;
}
export interface DatasetProjectionCommandPayloads {
  scanReadAcquire: Record<string, never>;
  scanReadWatchRevocation: {permitId:string};
  scanReadRelease: {permitId:string};
  browseAlbumCandidates: { query: string; page: PageRequest };
  captureAlbumMetadata: { reference: string };
  captureTrackMetadataBatch: { references: readonly string[] };
  acquirePermit: { scope: string; projectionId: string };
  releasePermit: { scope: string; projectionId: string; permitId: string };
}
export interface DatasetProjectionTicket<T> { scope: string; projectionId: string; metadata: T }
export interface DatasetProjectionPermit { scope: string; projectionId: string; permitId: string }
export interface DatasetProjectionCommandResults {
  scanReadAcquire: {status:'granted';permitId:string}|{status:'deferred'};
  scanReadWatchRevocation: {reason:'media-busy'|'admission-closed'|'permit-released'|'renew'};
  scanReadRelease: {released:true};
  browseAlbumCandidates: RoonLibraryPage;
  captureAlbumMetadata: DatasetProjectionTicket<DigitalAlbumMetadata>;
  captureTrackMetadataBatch: DatasetProjectionTicket<readonly DraftTrackMetadata[]>;
  acquirePermit: DatasetProjectionPermit;
  releasePermit: { released: true };
}
export type DatasetProjectionCommand = keyof DatasetProjectionCommandPayloads;
export interface DatasetProjectionPort {
  call<K extends DatasetProjectionCommand>(command: K, payload: DatasetProjectionCommandPayloads[K]): Promise<DatasetProjectionCommandResults[K]>;
}
export type DatasetOwnerProjectionHandler = <K extends DatasetProjectionCommand>(command: K, payload: DatasetProjectionCommandPayloads[K], context: { epoch: string; datasetId?: string }) => Promise<DatasetProjectionCommandResults[K]>;
export interface OwnedDatasetDomain {
  dispatchSourceWritesMain?(request:SourceWritesMainRequest,actor:SourceWritesMainActor):Promise<unknown>;
  materializeMBEdition?(request:MBEditionQueueRequest):MBEditionQueueSnapshot;
  loadMBQueue?(): MBQueueLoadResult;
  saveMBQueue?(request: MBQueueSaveRequest): MBQueueRecord;
  captureLocalSource?(selection: LocalPlayRequest): LocalSourceCaptureResult;
  revalidateLocalSource?(ticketId: string): boolean;
  releaseLocalSource?(ticketId: string): void;
  sealLocalSources?(): void;
  readonly datasetId: string;
  dispatch(request: IpcRequest): Promise<unknown>;
  dispatchInternal?(request: IpcRequest): Promise<unknown>;
  commitBoot(): Promise<void> | void;
  exportCollectionModels?(): readonly CollectionModel[];
  exportLargeCollectionModels?(): readonly CollectionModel[];
  readonlySnapshotStamp?(): { dataVersion: number; totalChanges: number };
  // 回调只在owner本地调用：coordinator静止后等请求收口，再关闭两库，不能跨port传递。
  close(beforeConnectionClose?: () => Promise<void>): Promise<void>;
  failureForError(id: string, error: unknown, command?: IpcCommand): IpcFailure;
}

export type DatasetOwnerOperation = 'materializeMBEdition' | 'loadMBQueue' | 'saveMBQueue' | 'captureLocalSource' | 'revalidateLocalSource' | 'releaseLocalSource' | 'prepare' | 'dispatch' | 'dispatchInternal' | 'commitBoot' | 'exportCollectionSnapshot' | 'getCollectionSnapshotVersion' | 'exportVersionedCollectionSnapshot' | 'exportLargeVersionedCollectionSnapshot' | 'close';
export type DatasetOwnerFatalReason = 'worker-error' | 'worker-exit' | 'protocol-failure' | 'close-failed' | 'post-failed';
interface OwnerEnvelope { version: typeof DATASET_OWNER_PROTOCOL_VERSION; epoch: string }
export interface DatasetOwnerRequest extends OwnerEnvelope { type: 'request'; requestId: string; sequence: number; operation: DatasetOwnerOperation; request?: IpcRequest; queue?: MBQueueSaveRequest; edition?: MBEditionQueueRequest; local?: LocalSourcePrivatePayload; expectedDatasetId?: string }
export type DatasetOwnerResponse = OwnerEnvelope & { type: 'response'; requestId: string; operation: DatasetOwnerOperation } & ({ ok: true; result: unknown } | { ok: false; failure: IpcFailure });
export type DatasetOwnerProjectionRequest = OwnerEnvelope & { type: 'projection'; projectionRequestId: string; command: DatasetProjectionCommand; payload: DatasetProjectionCommandPayloads[DatasetProjectionCommand] };
export type DatasetOwnerProjectionResponse = OwnerEnvelope & { type: 'projection-response'; projectionRequestId: string } & ({ ok: true; result: unknown } | { ok: false; failure: IpcFailure });
export type DatasetOwnerFatal = OwnerEnvelope & { type: 'fatal'; reason: 'protocol-failure' | 'close-failed' };

export const ownerRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key));
const safeString = (value: unknown, max = 512): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
export function isDatasetOwnerIdentity(value: unknown): value is DatasetOwnerIdentity { return ownerRecord(value) && keys(value, ['epoch', 'datasetId']) && isCollectionId(value.epoch) && isCommandOutboxDatasetId(value.datasetId); }
export function isDatasetCollectionModels(value: unknown): value is readonly CollectionModel[] {
  return collectionModelsWithinBudget(value, MAX_DATASET_COLLECTION_MODELS, MAX_DATASET_COLLECTION_SNAPSHOT_BYTES);
}
export function isDatasetLargeCollectionModels(value: unknown): value is readonly CollectionModel[] {
  return collectionModelsWithinBudget(value, MAX_DATASET_LARGE_COLLECTION_MODELS, MAX_DATASET_LARGE_COLLECTION_SNAPSHOT_BYTES);
}
function collectionModelsWithinBudget(value: unknown, maxModels: number, maxBytes: number): value is readonly CollectionModel[] {
  if (!Array.isArray(value) || value.length > maxModels) return false;
  const ids = new Set<string>();
  for (const model of value) {
    if (!isCollectionModel(model) || ids.has(model.id)) return false;
    ids.add(model.id);
  }
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8') <= maxBytes; } catch { return false; }
}
export function isDatasetCollectionSnapshot(value: unknown): value is DatasetCollectionSnapshot {
  return collectionSnapshotWithinBudget(value, isDatasetCollectionModels, MAX_DATASET_COLLECTION_SNAPSHOT_BYTES);
}
export function isDatasetLargeCollectionSnapshot(value: unknown): value is DatasetCollectionSnapshot {
  return collectionSnapshotWithinBudget(value, isDatasetLargeCollectionModels, MAX_DATASET_LARGE_COLLECTION_SNAPSHOT_BYTES);
}
function collectionSnapshotWithinBudget(value: unknown, modelsGuard: typeof isDatasetCollectionModels, maxBytes: number): value is DatasetCollectionSnapshot {
  if (!ownerRecord(value) || !keys(value, ['epoch', 'datasetId', 'snapshotId', 'models']) || !isCollectionId(value.epoch) || !isCommandOutboxDatasetId(value.datasetId) || !isCollectionId(value.snapshotId) || !modelsGuard(value.models)) return false;
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8') <= maxBytes; } catch { return false; }
}
export function isDatasetCollectionSnapshotVersion(value: unknown): value is DatasetCollectionSnapshotVersion {
  return ownerRecord(value) && keys(value, ['epoch', 'datasetId', 'revision']) && isCollectionId(value.epoch) && isCommandOutboxDatasetId(value.datasetId)
    && typeof value.revision === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.revision);
}
export function isDatasetVersionedCollectionSnapshot(value: unknown): value is DatasetVersionedCollectionSnapshot {
  return ownerRecord(value) && keys(value, ['snapshot', 'version']) && isDatasetCollectionSnapshot(value.snapshot) && isDatasetCollectionSnapshotVersion(value.version)
    && value.snapshot.epoch === value.version.epoch && value.snapshot.datasetId === value.version.datasetId;
}
export function isDatasetLargeVersionedCollectionSnapshot(value: unknown): value is DatasetVersionedCollectionSnapshot {
  return ownerRecord(value) && keys(value, ['snapshot', 'version']) && isDatasetLargeCollectionSnapshot(value.snapshot) && isDatasetCollectionSnapshotVersion(value.version)
    && value.snapshot.epoch === value.version.epoch && value.snapshot.datasetId === value.version.datasetId;
}
export function isDatasetRequestEnvelope(value: unknown, internal = false): value is IpcRequest {
  // 公开id与原validateIpcRequest保持一致；私有epoch/requestId继续使用UUID校验。
  return ownerRecord(value) && keys(value, ['version','id','command','payload','readContext','performanceTrace','expectedDatasetId']) && value.version === IPC_VERSION && typeof value.id === 'string' && value.id.trim().length > 0 && value.id.length <= 128
    && isDatasetCommand(value.command) && (internal || !(isLocalArtworkInternalCommand(value.command) || isLocalCatalogInternalCommand(value.command) || isLocalScanInternalCommand(value.command) || isLocalRelocationInternalCommand(value.command))) && ownerRecord(value.payload) && (value.expectedDatasetId === undefined || isCommandOutboxDatasetId(value.expectedDatasetId));
}
export function isDatasetOwnerRequest(value: unknown): value is DatasetOwnerRequest {
  if (!ownerRecord(value) || !keys(value, ['version','epoch','type','requestId','sequence','operation','request','queue','edition','local','expectedDatasetId']) || value.version !== DATASET_OWNER_PROTOCOL_VERSION || value.type !== 'request' || !isCollectionId(value.epoch) || !isCollectionId(value.requestId)
    || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1 || !['materializeMBEdition','loadMBQueue','saveMBQueue','captureLocalSource','revalidateLocalSource','releaseLocalSource','prepare','dispatch','dispatchInternal','commitBoot','exportCollectionSnapshot','getCollectionSnapshotVersion','exportVersionedCollectionSnapshot','exportLargeVersionedCollectionSnapshot','close'].includes(String(value.operation))) return false;
  if(value.operation==='materializeMBEdition')return value.request===undefined&&value.local===undefined&&value.queue===undefined&&isCommandOutboxDatasetId(value.expectedDatasetId)&&isMBEditionQueueRequest(value.edition);
  if(Object.hasOwn(value,'edition'))return false;
  if (value.operation === 'loadMBQueue' || value.operation === 'saveMBQueue') return value.request === undefined && value.local === undefined && isCommandOutboxDatasetId(value.expectedDatasetId)
    && (value.operation === 'loadMBQueue' ? value.queue === undefined : isMBQueueSaveRequest(value.queue) && value.queue.queue.datasetId === value.expectedDatasetId);
  if (Object.hasOwn(value,'queue')) return false;
  if (['captureLocalSource','revalidateLocalSource','releaseLocalSource'].includes(String(value.operation))) return value.request === undefined && isCommandOutboxDatasetId(value.expectedDatasetId) && isLocalSourcePrivatePayload(String(value.operation),value.local);
  if (Object.hasOwn(value,'local')) return false;
  if (['exportCollectionSnapshot','getCollectionSnapshotVersion','exportVersionedCollectionSnapshot','exportLargeVersionedCollectionSnapshot'].includes(String(value.operation))) return value.request === undefined && isCommandOutboxDatasetId(value.expectedDatasetId);
  if (Object.hasOwn(value, 'expectedDatasetId')) return false;
  return value.operation === 'dispatch' || value.operation === 'dispatchInternal' ? isDatasetRequestEnvelope(value.request, true)
    && (value.operation !== 'dispatchInternal' || ownerRecord(value.request) && (isLocalArtworkInternalCommand(value.request.command) || isLocalCatalogInternalCommand(value.request.command) || isLocalScanInternalCommand(value.request.command) || isLocalRelocationInternalCommand(value.request.command))) : value.request === undefined;
}
export function isDatasetOwnerFailure(value: unknown): value is IpcFailure {
  if (!ownerRecord(value) || !keys(value, ['version','id','ok','error'])) return false;
  const checked = validateIpcResponse(value); return checked.ok && checked.value.ok === false;
}
export function isDatasetOwnerResponse(value: unknown): value is DatasetOwnerResponse {
  if (!ownerRecord(value) || !keys(value,['version','epoch','type','requestId','operation','ok','result','failure']) || value.version !== DATASET_OWNER_PROTOCOL_VERSION || value.type !== 'response' || !isCollectionId(value.epoch) || !isCollectionId(value.requestId)
    || !['materializeMBEdition','loadMBQueue','saveMBQueue','captureLocalSource','revalidateLocalSource','releaseLocalSource','prepare','dispatch','dispatchInternal','commitBoot','exportCollectionSnapshot','getCollectionSnapshotVersion','exportVersionedCollectionSnapshot','exportLargeVersionedCollectionSnapshot','close'].includes(String(value.operation))) return false;
  return value.ok === true ? value.failure === undefined && Object.hasOwn(value,'result') : value.ok === false && value.result === undefined && isDatasetOwnerFailure(value.failure);
}
export const DATASET_PROJECTION_COMMANDS = ['browseAlbumCandidates','captureAlbumMetadata','captureTrackMetadataBatch','acquirePermit','releasePermit','scanReadAcquire','scanReadWatchRevocation','scanReadRelease'] as const;
export function isDatasetProjectionPayload(command: unknown, payload: unknown): payload is DatasetProjectionCommandPayloads[DatasetProjectionCommand] {
  if (!ownerRecord(payload)) return false;
  if (command === 'scanReadAcquire') return Reflect.ownKeys(payload).length === 0 && [Object.prototype,null].includes(Object.getPrototypeOf(payload));
  if (command === 'scanReadWatchRevocation' || command === 'scanReadRelease') return Reflect.ownKeys(payload).length === 1
    && Object.prototype.propertyIsEnumerable.call(payload,'permitId') && isCollectionId(payload.permitId) && [Object.prototype,null].includes(Object.getPrototypeOf(payload));
  if (command === 'browseAlbumCandidates') return validateIpcRequest({version:IPC_VERSION,id:'projection',command:'physicalLinks.search',payload}).ok;
  if (command === 'captureAlbumMetadata') return keys(payload,['reference']) && isRoonAlbumReference(payload.reference);
  if (command === 'captureTrackMetadataBatch') return keys(payload,['references']) && Array.isArray(payload.references) && payload.references.length > 0 && payload.references.length <= 100 && payload.references.every(isRoonAlbumReference);
  if (command === 'acquirePermit') return keys(payload,['scope','projectionId']) && safeString(payload.scope) && isCollectionId(payload.projectionId);
  if (command === 'releasePermit') return keys(payload,['scope','projectionId','permitId']) && safeString(payload.scope) && isCollectionId(payload.projectionId) && isCollectionId(payload.permitId);
  return false;
}
export function isDatasetProjectionResult(command: DatasetProjectionCommand, value: unknown): boolean {
  if (command === 'scanReadAcquire' || command === 'scanReadWatchRevocation' || command === 'scanReadRelease') {
    if (!ownerRecord(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) return false;
    const closedScan=(names:readonly string[])=>Reflect.ownKeys(value).length === names.length && names.every(k=>Object.prototype.propertyIsEnumerable.call(value,k));
    if(command === 'scanReadAcquire') return value.status === 'deferred' ? closedScan(['status']) : value.status === 'granted' && closedScan(['status','permitId']) && isCollectionId(value.permitId);
    return command === 'scanReadRelease' ? closedScan(['released']) && value.released === true : closedScan(['reason']) && ['media-busy','admission-closed','permit-released','renew'].includes(String(value.reason));
  }
  if (command === 'browseAlbumCandidates') return validateIpcResponseForCommand({version:IPC_VERSION,id:'projection',ok:true,result:value},'physicalLinks.search').ok;
  if (!ownerRecord(value)) return false;
  if (command === 'releasePermit') return keys(value,['released']) && value.released === true;
  if (command === 'acquirePermit') return keys(value,['scope','projectionId','permitId']) && safeString(value.scope) && isCollectionId(value.projectionId) && isCollectionId(value.permitId);
  if (!keys(value,['scope','projectionId','metadata']) || !safeString(value.scope) || !isCollectionId(value.projectionId)) return false;
  return command === 'captureAlbumMetadata' ? isDigitalAlbumMetadata(value.metadata) : Array.isArray(value.metadata) && value.metadata.length > 0 && value.metadata.length <= 100 && value.metadata.every(isDraftTrackMetadata);
}
export function isDatasetOwnerProjectionRequest(value: unknown): value is DatasetOwnerProjectionRequest {
  return ownerRecord(value) && keys(value,['version','epoch','type','projectionRequestId','command','payload']) && value.version === DATASET_OWNER_PROTOCOL_VERSION && value.type === 'projection' && isCollectionId(value.epoch) && isCollectionId(value.projectionRequestId) && isDatasetProjectionPayload(value.command,value.payload);
}
export function isDatasetOwnerProjectionResponse(value: unknown): value is DatasetOwnerProjectionResponse {
  if (!ownerRecord(value) || !keys(value,['version','epoch','type','projectionRequestId','ok','result','failure']) || value.version !== DATASET_OWNER_PROTOCOL_VERSION || value.type !== 'projection-response' || !isCollectionId(value.epoch) || !isCollectionId(value.projectionRequestId)) return false;
  return value.ok === true ? value.failure === undefined && Object.hasOwn(value,'result') : value.ok === false && value.result === undefined && isDatasetOwnerFailure(value.failure);
}
export class DatasetOwnerDispatchError extends Error {
  constructor(readonly failure: IpcFailure) { super(failure.error.message); this.name = 'DatasetOwnerDispatchError'; }
}
export class DatasetOwnerTransportError extends Error {
  readonly code = 'INVENTORY_UNAVAILABLE';
  constructor(readonly outcome: 'not-sent' | 'unknown', readonly requestId?: string, readonly command?: IpcCommand) {
    super(outcome === 'unknown' ? '领域所有者连接中断，已发送操作的结果不明；请查询原命令记录，操作不会自动重放。' : '领域所有者尚未就绪，本次操作未发送。'); this.name = 'DatasetOwnerTransportError';
  }
}
import type { SourceWritesMainRequest } from '@music-bridge/contracts';
import type { SourceWritesMainActor } from './source-writes-authority.js';
