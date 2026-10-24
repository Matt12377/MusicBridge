import { LOCAL_ARTIST_COMMANDS } from '@music-bridge/contracts';
import path from 'node:path';
import { LIBRARY_REMOVAL_REQUEST_MS } from '../shared/library-removal-budget.js';
import type { LocalWorkbenchReadService, LocalWorkbenchResolvedReadCapture, LocalWorkbenchNamePreparation } from './local-library-workbench/read-service.js';
import type { LocalWorkbenchPlanDraft, LocalWorkbenchPlanCapture, LocalWorkbenchArtworkCapture, LocalNameProposalResult, LocalWorkbenchFrozenArtwork } from './local-library-workbench/types.js';
import { isLocalWorkbenchAlbumCapture } from './local-library-workbench/name-proposal.js';
import { isLocalWorkbenchPlanCapture, isLocalWorkbenchArtworkCapture, assertLocalWorkbenchCapturedPlan } from './local-library-workbench/plan-registry.js';
import { isLocalAlbumPrivateRelative } from './local-album-browser/grouping.js';
import { isScanFileState } from './local-scan-store.js';
import * as dto from '@music-bridge/contracts';
import { createHash as wbHash } from 'node:crypto';
import { types as wbNodeTypes } from 'node:util';
import { isMobileOwnerPrivateRequest } from '../mobile/owner-protocol.js';
import { isLocalAlbumOwnerReadRequest, type LocalAlbumOwnerReadRequest, type LocalAlbumOwnerReadResult } from './local-album-browser/owner-protocol.js';
import { isLocalArtworkImage, isLocalArtworkCommandResult, type LocalArtworkImage, type LocalArtworkSourceCopies } from '@music-bridge/contracts';
import type { MobileOwnerPrivateRequest, MobileOwnerPrivateResult } from '../mobile/types.js';
import { LOCAL_ARTWORK_COMMANDS, isLocalArtworkInternalCommand } from '@music-bridge/contracts';
import { LOCAL_ORGANIZER_COMMANDS } from '@music-bridge/contracts';
import { LOCAL_LEGACY_LINKS_COMMANDS } from '@music-bridge/contracts';
import { LOCAL_RELOCATION_PLAN_COMMANDS } from '@music-bridge/contracts';
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
  ...LOCAL_ARTIST_COMMANDS,
  ...LOCAL_LEGACY_LINKS_COMMANDS,
  ...LOCAL_RELOCATION_PLAN_COMMANDS,
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
  'referenceCatalog.previewArchive',
  'referenceCatalog.importArchive',
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
  workbenchContext?(read?:{signal?:AbortSignal;deadlineAtMs?:number}):Promise<DatasetWorkbenchContext>;
  /** 可信Main只核当前Owner身份；不读取目录可用性或扩充公开命令。 */
  workbenchReadIdentity?(read?:{signal?:AbortSignal;deadlineAtMs?:number}):Promise<DatasetWorkbenchContext>;
  joinWorkbench?():Promise<void>;
  dispatchWorkbench?(request:DatasetWorkbenchRequest, context:{identity:DatasetOwnerIdentity;signal?:AbortSignal;deadlineAtMs?:number}):Promise<DatasetWorkbenchResult>;
  dispatchWorkbenchOwner?(request:DatasetWorkbenchOwnerRequest, context:{identity:DatasetOwnerIdentity;signal?:AbortSignal;deadlineAtMs?:number}):Promise<DatasetWorkbenchOwnerResult>;
  closeWorkbench?():Promise<void>;
  readLocalAlbum?(request: LocalAlbumOwnerReadRequest): Promise<LocalAlbumOwnerReadResult>;
  /** 可信 Main 设备域闭集，不进入普通公开 IPC。 */
  mobileMain?(request: MobileOwnerPrivateRequest): Promise<MobileOwnerPrivateResult>;
  materializeMBEdition?(request:MBEditionQueueRequest):Promise<MBEditionQueueSnapshot>;
  loadMBQueue?(): Promise<MBQueueLoadResult>;
  saveMBQueue?(request: MBQueueSaveRequest): Promise<MBQueueRecord>;
  captureLocalSource?(selection: LocalPlayRequest): Promise<LocalSourceCaptureResult>;
  /** 只读取原播放ticket的精确旁置歌词；无路径、Provider ID或新授权输入。 */
  readLocalSourceLyrics?(ticketId: string): Promise<import('@music-bridge/contracts').LyricsSnapshot>;
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
  nameProviderStart:DatasetNameProviderStart;
  nameProviderRead:{operationId:string;offset:number};
  nameProviderCancel:{operationId:string};
  nameProviderJoin:{operationId:string};
  lyricsProviderStart:DatasetLyricsProviderStart;
  lyricsProviderRead:{operationId:string;offset:number};
  lyricsProviderCancel:{operationId:string};
  lyricsProviderJoin:{operationId:string};
  normalizeLocalAlbumArtwork: { copies: LocalArtworkSourceCopies };
  scanReadStatus: Record<string, never>;
  scanReadAcquire: Record<string, never> | { purpose: 'local-album-display' };
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
  nameProviderStart:{operationId:string;state:DatasetNameProviderState};
  nameProviderRead:DatasetNameProviderRead;
  nameProviderCancel:{operationId:string;cancelRequested:true};
  nameProviderJoin:{operationId:string;physicalClosed:true};
  lyricsProviderStart:{operationId:string;state:DatasetLyricsProviderState};
  lyricsProviderRead:DatasetLyricsProviderRead;
  lyricsProviderCancel:{operationId:string;cancelRequested:true};
  lyricsProviderJoin:{operationId:string;physicalClosed:true};
  normalizeLocalAlbumArtwork: { image: LocalArtworkImage | null; status: 'ready' | 'source-unavailable'; grid?: dto.LocalAlbumArtworkGrid };
  scanReadStatus: {status:'ready'|'deferred'};
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
/** 固定五源反向传输与原Roon投影分开；不携带URL、header或访问凭据。 */
export const DATASET_LYRICS_PROVIDER_COMMANDS=['lyricsProviderStart','lyricsProviderRead','lyricsProviderCancel','lyricsProviderJoin'] as const;
export type DatasetLyricsProviderCommand=typeof DATASET_LYRICS_PROVIDER_COMMANDS[number];
export type DatasetLyricsProviderState='queued'|'running'|'complete'|'failed'|'cancelled';
export const DATASET_LYRICS_PROVIDER_FAILURES=['INVALID_INPUT','NOT_READY','TIMEOUT','NETWORK','HTTP_STATUS','INVALID_RESPONSE','BUDGET','CANCELLED'] as const;
export type DatasetLyricsProviderFailure=typeof DATASET_LYRICS_PROVIDER_FAILURES[number];
export class DatasetLyricsProviderBridgeError extends Error{constructor(readonly code:DatasetLyricsProviderFailure){super('固定歌词来源请求未确认，保留原操作身份。');this.name='DatasetLyricsProviderBridgeError';}}
export interface DatasetLyricsProviderStart {operationId:string;source:dto.LocalLyricsSource;operation:'search'|'body';input:import('./local-library-lyrics/types.js').LocalLyricsProviderQuery|{id:string};expiresAtMs:number}
export interface DatasetLyricsProviderRead {operationId:string;state:DatasetLyricsProviderState;totalBytes:number|null;sha256:string|null;offset:number;bytes:Uint8Array;eof:boolean;failure:DatasetLyricsProviderFailure|null}
export type DatasetLyricsProviderRequest = {version:1;type:'musicbridge.lyrics.provider-request';requestId:string;sequence:number;epoch:string;datasetId:string;expiresAtMs:number}&{[K in DatasetLyricsProviderCommand]:{command:K;payload:DatasetProjectionCommandPayloads[K]}}[DatasetLyricsProviderCommand]
export type DatasetLyricsProviderReply={version:1;type:'musicbridge.lyrics.provider-reply';requestId:string;sequence:number;epoch:string;datasetId:string;command:DatasetLyricsProviderCommand;requestSha256:string}&({ok:true;result:DatasetProjectionCommandResults[DatasetLyricsProviderCommand]}|{ok:false;failure:DatasetLyricsProviderFailure});
export function isDatasetLyricsProviderCommand(v:unknown):v is DatasetLyricsProviderCommand{return typeof v==='string'&&(DATASET_LYRICS_PROVIDER_COMMANDS as readonly string[]).includes(v);}
function lyricsProviderText(v:unknown,max=2048):v is string{return typeof v==='string'&&Buffer.byteLength(v)<=max&&!/[\x00-\x1f\x7f]/u.test(v)&&Buffer.from(v).toString('utf8')===v;}
function isDatasetLyricsProviderPayload(command:DatasetLyricsProviderCommand,input:unknown):boolean{
  if(!ownResult(input,command==='lyricsProviderStart'?['operationId','source','operation','input','expiresAtMs']:command==='lyricsProviderRead'?['operationId','offset']:['operationId'])||!dto.isCollectionId(input.operationId))return false;
  if(command==='lyricsProviderRead')return Number.isSafeInteger(input.offset)&&Number(input.offset)>=0&&Number(input.offset)<=dto.LOCAL_LYRICS_LIMITS.sourceRawBytes;
  if(command!=='lyricsProviderStart')return true;
  if(!(dto.LOCAL_LYRICS_SOURCES as readonly unknown[]).includes(input.source)||!['search','body'].includes(String(input.operation))||!Number.isSafeInteger(input.expiresAtMs)||Number(input.expiresAtMs)<1)return false;
  const value=input.input;if(input.operation==='body')return ownResult(value,['id'])&&lyricsProviderText(value.id)&&value.id.length>0;
  return ownResult(value,['title','artist','album','language','version','durationMs'])&&['title','artist','album','language'].every(k=>lyricsProviderText(value[k]))
    &&['original','live','remix','instrumental','unknown'].includes(String(value.version))&&(value.durationMs===null||Number.isSafeInteger(value.durationMs)&&Number(value.durationMs)>=0);
}
function isDatasetLyricsProviderResult(command:DatasetLyricsProviderCommand,value:unknown):boolean{
  const fields=command==='lyricsProviderStart'?['operationId','state']:command==='lyricsProviderCancel'?['operationId','cancelRequested']:command==='lyricsProviderJoin'?['operationId','physicalClosed']:['operationId','state','totalBytes','sha256','offset','bytes','eof','failure'];
  if(!ownResult(value,fields)||!dto.isCollectionId(value.operationId))return false;
  if(command==='lyricsProviderCancel')return value.cancelRequested===true;if(command==='lyricsProviderJoin')return value.physicalClosed===true;
  if(!['queued','running','complete','failed','cancelled'].includes(String(value.state)))return false;if(command==='lyricsProviderStart')return true;
  const bytes=value.bytes;if(wbNodeTypes.isProxy(bytes)||!wbNodeTypes.isUint8Array(bytes)||![Uint8Array.prototype,Buffer.prototype].includes(Object.getPrototypeOf(bytes))
    ||wbNodeTypes.isSharedArrayBuffer(bytes.buffer)||bytes.byteLength>60*1024||Reflect.ownKeys(bytes).length!==bytes.byteLength||!Number.isSafeInteger(value.offset)||Number(value.offset)<0||Number(value.offset)>dto.LOCAL_LYRICS_LIMITS.sourceRawBytes||typeof value.eof!=='boolean'
    ||value.failure!==null&&!(DATASET_LYRICS_PROVIDER_FAILURES as readonly unknown[]).includes(value.failure))return false;
  if(value.state==='complete')return Number.isSafeInteger(value.totalBytes)&&Number(value.totalBytes)>=1&&Number(value.totalBytes)<=dto.LOCAL_LYRICS_LIMITS.sourceRawBytes&&wbSha(value.sha256)
    &&value.failure===null&&Number(value.offset)+bytes.byteLength<=Number(value.totalBytes)&&value.eof===(Number(value.offset)+bytes.byteLength===Number(value.totalBytes))&&(value.eof||bytes.byteLength>0);
  return value.totalBytes===null&&value.sha256===null&&bytes.byteLength===0&&value.eof===false&&(value.state==='queued'||value.state==='running'?value.failure===null:value.failure!==null);
}
export function captureDatasetLyricsProviderRequest(value:unknown):DatasetLyricsProviderRequest{
  if(!ownResult(value,['version','type','requestId','sequence','epoch','datasetId','command','payload','expiresAtMs'])||value.version!==1||value.type!=='musicbridge.lyrics.provider-request'
    ||!['requestId','epoch','datasetId'].every(k=>dto.isCollectionId(value[k]))||!Number.isSafeInteger(value.sequence)||Number(value.sequence)<1||!Number.isSafeInteger(value.expiresAtMs)||Number(value.expiresAtMs)<1
    ||!isDatasetLyricsProviderCommand(value.command)||!isDatasetLyricsProviderPayload(value.command,value.payload)||datasetWorkbenchJson(value).byteLength>4096)throw new DatasetWorkbenchWireError('INVALID_IPC_REQUEST');
  return JSON.parse(Buffer.from(datasetWorkbenchJson(value)).toString('utf8')) as DatasetLyricsProviderRequest;
}
export function captureDatasetLyricsProviderReply(value:unknown):DatasetLyricsProviderReply{
  if(!ownResult(value,['version','type','requestId','sequence','epoch','datasetId','command','requestSha256','ok'],['result','failure'])||value.version!==1||value.type!=='musicbridge.lyrics.provider-reply'
    ||!['requestId','epoch','datasetId'].every(k=>dto.isCollectionId(value[k]))||!Number.isSafeInteger(value.sequence)||Number(value.sequence)<1||!wbSha(value.requestSha256)||!isDatasetLyricsProviderCommand(value.command)
    ||(value.ok===true?Object.hasOwn(value,'failure')||!isDatasetLyricsProviderResult(value.command,value.result):value.ok===false?Object.hasOwn(value,'result')||!(DATASET_LYRICS_PROVIDER_FAILURES as readonly unknown[]).includes(value.failure):true))throw new DatasetWorkbenchWireError('INVALID_IPC_RESPONSE');
  const result=value.result as DatasetLyricsProviderRead|undefined,metadata=result&&Object.hasOwn(result,'bytes')?{...value,result:{...result,bytes:[]}}:value;
  if(datasetWorkbenchJson(metadata).byteLength>4096)throw new DatasetWorkbenchWireError('INVALID_IPC_RESPONSE');
  return structuredClone(value) as unknown as DatasetLyricsProviderReply;
}
export function assertDatasetLyricsProviderReplyForRequest(reply:DatasetLyricsProviderReply,request:DatasetLyricsProviderRequest):void{
  const r=captureDatasetLyricsProviderReply(reply),q=captureDatasetLyricsProviderRequest(request);
  if(['requestId','sequence','epoch','datasetId','command'].some(k=>r[k as keyof typeof r]!==q[k as keyof typeof q])||r.requestSha256!==datasetWorkbenchSha(datasetWorkbenchJson(q))
    ||r.ok&&(r.result.operationId!==q.payload.operationId||q.command==='lyricsProviderRead'&&(r.result as DatasetLyricsProviderRead).offset!==(q.payload as {offset:number}).offset))throw new DatasetWorkbenchWireError('INVALID_IPC_RESPONSE');
}
/** 整库名称只通过原Main物理port的四个有限反向命令；不携带服务配置或凭据。 */
export const DATASET_NAME_PROVIDER_COMMANDS=['nameProviderStart','nameProviderRead','nameProviderCancel','nameProviderJoin'] as const;
export type DatasetNameProviderCommand=typeof DATASET_NAME_PROVIDER_COMMANDS[number];
export type DatasetNameProviderState='queued'|'running'|'complete'|'failed'|'cancelled';
export const DATASET_NAME_PROVIDER_FAILURES=['INVALID_INPUT','NOT_READY','TIMEOUT','NETWORK','HTTP_STATUS','INVALID_RESPONSE','BUDGET','CANCELLED'] as const;
export type DatasetNameProviderFailure=typeof DATASET_NAME_PROVIDER_FAILURES[number];
export const DATASET_NAME_PROVIDER_CONTENT_BYTES=256*1024+1024;
export class DatasetNameProviderBridgeError extends Error{constructor(readonly code:DatasetNameProviderFailure){super('原名称请求未确认，保留原job/command/body身份。');this.name='DatasetNameProviderBridgeError';}}
export interface DatasetNameProviderStart {operationId:string;jobId:string;captureId:string;albumId:string;preparationId:string;backend:dto.LocalAiBackend;systemPrompt:string;userPrompt:string;originalStartSha256:string;expiresAtMs:number}
export interface DatasetNameProviderRead {operationId:string;state:DatasetNameProviderState;totalBytes:number|null;sha256:string|null;offset:number;bytes:Uint8Array;eof:boolean;failure:DatasetNameProviderFailure|null}
export type DatasetNameProviderRequest={version:1;type:'musicbridge.name.provider-request';requestId:string;sequence:number;epoch:string;datasetId:string;authorityId:string|null;childGeneration:number|null;expiresAtMs:number}&{[K in DatasetNameProviderCommand]:{command:K;payload:DatasetProjectionCommandPayloads[K]}}[DatasetNameProviderCommand]
export type DatasetNameProviderReply={version:1;type:'musicbridge.name.provider-reply';requestId:string;sequence:number;epoch:string;datasetId:string;authorityId:string|null;childGeneration:number|null;command:DatasetNameProviderCommand;requestSha256:string}&({ok:true;result:DatasetProjectionCommandResults[DatasetNameProviderCommand]}|{ok:false;failure:DatasetNameProviderFailure});
export function isDatasetNameProviderCommand(v:unknown):v is DatasetNameProviderCommand{return typeof v==='string'&&(DATASET_NAME_PROVIDER_COMMANDS as readonly string[]).includes(v);}
/** SHA只绑定原持久start正文，不随单专辑提示、准备身份或剩余期限改变。 */
export function datasetNameOriginalStartSha256(request:dto.LocalLibraryManagementPayloads['library.ai.start']):string{
  if(!dto.isLocalLibraryManagementPayload('library.ai.start',request))throw new DatasetWorkbenchWireError('INVALID_IPC_REQUEST');
  return datasetWorkbenchSha(datasetWorkbenchJson({command:'library.ai.start',request}));
}
function isDatasetNameProviderPayload(command:DatasetNameProviderCommand,input:unknown):boolean{
  if(!ownResult(input,command==='nameProviderStart'?['operationId','jobId','captureId','albumId','preparationId','backend','systemPrompt','userPrompt','originalStartSha256','expiresAtMs']:command==='nameProviderRead'?['operationId','offset']:['operationId'])||!dto.isLocalWorkbenchIdentity(input.operationId))return false;
  if(command==='nameProviderRead')return Number.isSafeInteger(input.offset)&&Number(input.offset)>=0&&Number(input.offset)<=DATASET_NAME_PROVIDER_CONTENT_BYTES;
  if(command!=='nameProviderStart')return true;
  return ['jobId','captureId','albumId','preparationId'].every(k=>dto.isLocalWorkbenchIdentity(input[k]))&&['ollama','vllm','cloud'].includes(String(input.backend))&&wbSha(input.originalStartSha256)
    &&Number.isSafeInteger(input.expiresAtMs)&&Number(input.expiresAtMs)>0&&['systemPrompt','userPrompt'].every(k=>typeof input[k]==='string'&&String(input[k]).trim().length>0&&Buffer.byteLength(String(input[k]),'utf8')<=64*1024&&!String(input[k]).includes('\u0000')&&Buffer.from(String(input[k]),'utf8').toString('utf8')===input[k]);
}
function nameAuthority(value:Record<string,unknown>):boolean{return value.authorityId===null&&value.childGeneration===null||dto.isCollectionId(value.authorityId)&&Number.isSafeInteger(value.childGeneration)&&Number(value.childGeneration)>0;}
function isDatasetNameProviderResult(command:DatasetNameProviderCommand,value:unknown):boolean{
  const fields=command==='nameProviderStart'?['operationId','state']:command==='nameProviderCancel'?['operationId','cancelRequested']:command==='nameProviderJoin'?['operationId','physicalClosed']:['operationId','state','totalBytes','sha256','offset','bytes','eof','failure'];
  if(!ownResult(value,fields)||!dto.isLocalWorkbenchIdentity(value.operationId))return false;
  if(command==='nameProviderCancel')return value.cancelRequested===true;if(command==='nameProviderJoin')return value.physicalClosed===true;
  if(!['queued','running','complete','failed','cancelled'].includes(String(value.state)))return false;if(command==='nameProviderStart')return true;
  const bytes=value.bytes;if(wbNodeTypes.isProxy(bytes)||!wbNodeTypes.isUint8Array(bytes)||![Uint8Array.prototype,Buffer.prototype].includes(Object.getPrototypeOf(bytes))||wbNodeTypes.isSharedArrayBuffer(bytes.buffer)
    ||bytes.byteLength>60*1024||Reflect.ownKeys(bytes).length!==bytes.byteLength||!Number.isSafeInteger(value.offset)||Number(value.offset)<0||Number(value.offset)>DATASET_NAME_PROVIDER_CONTENT_BYTES||typeof value.eof!=='boolean'
    ||value.failure!==null&&!(DATASET_NAME_PROVIDER_FAILURES as readonly unknown[]).includes(value.failure))return false;
  if(value.state==='complete')return Number.isSafeInteger(value.totalBytes)&&Number(value.totalBytes)>0&&Number(value.totalBytes)<=DATASET_NAME_PROVIDER_CONTENT_BYTES&&wbSha(value.sha256)&&value.failure===null
    &&Number(value.offset)+bytes.byteLength<=Number(value.totalBytes)&&value.eof===(Number(value.offset)+bytes.byteLength===Number(value.totalBytes))&&(value.eof||bytes.byteLength>0);
  return value.totalBytes===null&&value.sha256===null&&bytes.byteLength===0&&value.eof===false&&(value.state==='queued'||value.state==='running'?value.failure===null:value.failure!==null);
}
export function captureDatasetNameProviderRequest(value:unknown):DatasetNameProviderRequest{
  if(!ownResult(value,['version','type','requestId','sequence','epoch','datasetId','authorityId','childGeneration','command','payload','expiresAtMs'])||value.version!==1||value.type!=='musicbridge.name.provider-request'
    ||!['requestId','epoch','datasetId'].every(k=>dto.isCollectionId(value[k]))||!Number.isSafeInteger(value.sequence)||Number(value.sequence)<1||!Number.isSafeInteger(value.expiresAtMs)||Number(value.expiresAtMs)<1
    ||!nameAuthority(value)||!isDatasetNameProviderCommand(value.command)||!isDatasetNameProviderPayload(value.command,value.payload)||datasetWorkbenchJson(value).byteLength>DATASET_WORKBENCH_BOUNDS.requestBytes)throw new DatasetWorkbenchWireError('INVALID_IPC_REQUEST');
  return JSON.parse(Buffer.from(datasetWorkbenchJson(value)).toString('utf8')) as DatasetNameProviderRequest;
}
export function captureDatasetNameProviderReply(value:unknown):DatasetNameProviderReply{
  if(!ownResult(value,['version','type','requestId','sequence','epoch','datasetId','authorityId','childGeneration','command','requestSha256','ok'],['result','failure'])||value.version!==1||value.type!=='musicbridge.name.provider-reply'
    ||!['requestId','epoch','datasetId'].every(k=>dto.isCollectionId(value[k]))||!Number.isSafeInteger(value.sequence)||Number(value.sequence)<1||!nameAuthority(value)||!wbSha(value.requestSha256)||!isDatasetNameProviderCommand(value.command)
    ||(value.ok===true?value.authorityId===null||Object.hasOwn(value,'failure')||!isDatasetNameProviderResult(value.command,value.result):value.ok===false?Object.hasOwn(value,'result')||!(DATASET_NAME_PROVIDER_FAILURES as readonly unknown[]).includes(value.failure):true))throw new DatasetWorkbenchWireError('INVALID_IPC_RESPONSE');
  const result=value.result as DatasetNameProviderRead|undefined,metadata=result&&Object.hasOwn(result,'bytes')?{...value,result:{...result,bytes:[]}}:value;
  if(datasetWorkbenchJson(metadata).byteLength>4096)throw new DatasetWorkbenchWireError('INVALID_IPC_RESPONSE');
  return structuredClone(value) as unknown as DatasetNameProviderReply;
}
export function assertDatasetNameProviderReplyForRequest(reply:DatasetNameProviderReply,request:DatasetNameProviderRequest):void{
  const r=captureDatasetNameProviderReply(reply),q=captureDatasetNameProviderRequest(request);
  if(['requestId','sequence','epoch','datasetId','command'].some(k=>r[k as keyof typeof r]!==q[k as keyof typeof q])||r.requestSha256!==datasetWorkbenchSha(datasetWorkbenchJson(q))
    ||q.authorityId!==null&&(r.authorityId!==q.authorityId||r.childGeneration!==q.childGeneration)
    ||r.ok&&(r.result.operationId!==q.payload.operationId||q.command==='nameProviderRead'&&(r.result as DatasetNameProviderRead).offset!==(q.payload as {offset:number}).offset))throw new DatasetWorkbenchWireError('INVALID_IPC_RESPONSE');
}
export interface DatasetProjectionPort {
  call<K extends DatasetProjectionCommand>(command: K, payload: DatasetProjectionCommandPayloads[K], read?: {signal?:AbortSignal;deadlineAtMs?:number}): Promise<DatasetProjectionCommandResults[K]>;
}
export type DatasetOwnerProjectionHandler = <K extends DatasetProjectionCommand>(command: K, payload: DatasetProjectionCommandPayloads[K], context: { epoch: string; datasetId?: string; signal?:AbortSignal;deadlineAtMs?:number;expiresAtMs?:number }) => Promise<DatasetProjectionCommandResults[K]>;
export interface OwnedDatasetDomain {
  workbenchContext?():Promise<DatasetWorkbenchContext>;
  workbenchReadIdentity?():Promise<DatasetWorkbenchContext>;
  dispatchWorkbench?(request:DatasetWorkbenchRequest, context:DatasetWorkbenchExecutionContext):Promise<DatasetWorkbenchResult>;
  /** 私有Owner闭集；实现须回核原作者捕获/实际target许可，Main就绪确认不授予源写权限。 */
  dispatchWorkbenchOwner?(request:DatasetWorkbenchOwnerRequest, context:DatasetWorkbenchExecutionContext):Promise<DatasetWorkbenchOwnerResult>;
  closeWorkbench?():Promise<void>;
  readLocalAlbum?(request: LocalAlbumOwnerReadRequest): Promise<LocalAlbumOwnerReadResult>;
  mobileMain?(request: MobileOwnerPrivateRequest): Promise<MobileOwnerPrivateResult>;
  dispatchSourceWritesMain?(request:SourceWritesMainRequest,actor:SourceWritesMainActor):Promise<unknown>;
  /** LYRICS独立只读原件核验；不会增加通用Owner18或公开39命令。 */
  readLyricsGrantOriginal?(binding:import('../library/lyrics-source-format.js').LocalLyricsPhysicalBinding,revision:number,context:{identity:{epoch:string;datasetId:string};mainActor:SourceWritesMainActor}):import('./source-writes-authority.js').SourceWritesLyricsOriginalEvidence|Promise<import('./source-writes-authority.js').SourceWritesLyricsOriginalEvidence>;
  dispatchRelocationMain?(request: import('@music-bridge/contracts').LocalRelocationMainRequest, actor: import('./source-relocation-authority.js').RelocationMainActor): Promise<unknown>;
  materializeMBEdition?(request:MBEditionQueueRequest):MBEditionQueueSnapshot;
  loadMBQueue?(): MBQueueLoadResult;
  saveMBQueue?(request: MBQueueSaveRequest): MBQueueRecord;
  captureLocalSource?(selection: LocalPlayRequest): LocalSourceCaptureResult;
  readLocalSourceLyrics?(ticketId: string): Promise<import('@music-bridge/contracts').LyricsSnapshot>;
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

export type DatasetOwnerOperation = 'localAlbumRead' | 'mobileMain' | 'materializeMBEdition' | 'loadMBQueue' | 'saveMBQueue' | 'captureLocalSource' | 'readLocalSourceLyrics' | 'revalidateLocalSource' | 'releaseLocalSource' | 'prepare' | 'dispatch' | 'dispatchInternal' | 'commitBoot' | 'exportCollectionSnapshot' | 'getCollectionSnapshotVersion' | 'exportVersionedCollectionSnapshot' | 'exportLargeVersionedCollectionSnapshot' | 'close';
export type DatasetOwnerFatalReason = 'worker-error' | 'worker-exit' | 'protocol-failure' | 'close-failed' | 'post-failed';
interface OwnerEnvelope { version: typeof DATASET_OWNER_PROTOCOL_VERSION; epoch: string }
export interface DatasetOwnerRequest extends OwnerEnvelope { type: 'request'; requestId: string; sequence: number; operation: DatasetOwnerOperation; album?: LocalAlbumOwnerReadRequest; mobile?: MobileOwnerPrivateRequest; ownerLoadTrace?: number; catalogTrace?: unknown; request?: IpcRequest; queue?: MBQueueSaveRequest; edition?: MBEditionQueueRequest; local?: LocalSourcePrivatePayload; expectedDatasetId?: string }
export type DatasetOwnerResponse = OwnerEnvelope & { type: 'response'; requestId: string; operation: DatasetOwnerOperation } & ({ ok: true; result: unknown } | { ok: false; failure: IpcFailure });
export type DatasetOwnerProjectionRequest = OwnerEnvelope & { type: 'projection'; projectionRequestId: string; command: DatasetProjectionCommand; payload: DatasetProjectionCommandPayloads[DatasetProjectionCommand]; read?: {expiresAtMs:number} };
export type DatasetOwnerProjectionCancel = OwnerEnvelope & {type:'projection-cancel';projectionRequestId:string;command:'normalizeLocalAlbumArtwork';expiresAtMs:number};
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
  if (!ownerRecord(value) || !keys(value, ['version','epoch','type','requestId','sequence','operation','album','mobile','ownerLoadTrace','catalogTrace','request','queue','edition','local','expectedDatasetId']) || value.version !== DATASET_OWNER_PROTOCOL_VERSION || value.type !== 'request' || !isCollectionId(value.epoch) || !isCollectionId(value.requestId)
    || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1 || !['localAlbumRead','mobileMain','materializeMBEdition','loadMBQueue','saveMBQueue','captureLocalSource','readLocalSourceLyrics','revalidateLocalSource','releaseLocalSource','prepare','dispatch','dispatchInternal','commitBoot','exportCollectionSnapshot','getCollectionSnapshotVersion','exportVersionedCollectionSnapshot','exportLargeVersionedCollectionSnapshot','close'].includes(String(value.operation))) return false;
  if (Object.hasOwn(value, 'catalogTrace') && (value.operation !== 'mobileMain' || !ownerRecord(value.mobile)
    || value.mobile.kind !== 'catalog' || !ownerRecord(value.mobile.request) || value.mobile.request.operation !== 'listTracks')) return false;
  // 临时诊断序号只沿既有认证load，不授予任何业务资格。
  if (Object.hasOwn(value, 'ownerLoadTrace') && (value.operation !== 'mobileMain' || !ownerRecord(value.mobile)
    || value.mobile.kind !== 'load' || !Number.isSafeInteger(value.ownerLoadTrace) || Number(value.ownerLoadTrace) < 1 || Number(value.ownerLoadTrace) > 8)) return false;
  if (value.operation === 'localAlbumRead') return value.request === undefined && value.mobile === undefined && value.local === undefined
    && value.queue === undefined && value.edition === undefined && isCommandOutboxDatasetId(value.expectedDatasetId) && isLocalAlbumOwnerReadRequest(value.album);
  if (Object.hasOwn(value, 'album')) return false;
  if (value.operation === 'mobileMain') return value.request === undefined && value.local === undefined && value.queue === undefined && value.edition === undefined
    && isCommandOutboxDatasetId(value.expectedDatasetId) && isMobileOwnerPrivateRequest(value.mobile) && value.mobile.datasetId === value.expectedDatasetId;
  if (Object.hasOwn(value, 'mobile')) return false;
  if(value.operation==='materializeMBEdition')return value.request===undefined&&value.local===undefined&&value.queue===undefined&&isCommandOutboxDatasetId(value.expectedDatasetId)&&isMBEditionQueueRequest(value.edition);
  if(Object.hasOwn(value,'edition'))return false;
  if (value.operation === 'loadMBQueue' || value.operation === 'saveMBQueue') return value.request === undefined && value.local === undefined && isCommandOutboxDatasetId(value.expectedDatasetId)
    && (value.operation === 'loadMBQueue' ? value.queue === undefined : isMBQueueSaveRequest(value.queue) && value.queue.queue.datasetId === value.expectedDatasetId);
  if (Object.hasOwn(value,'queue')) return false;
  if (['captureLocalSource','readLocalSourceLyrics','revalidateLocalSource','releaseLocalSource'].includes(String(value.operation))) return value.request === undefined && isCommandOutboxDatasetId(value.expectedDatasetId) && isLocalSourcePrivatePayload(String(value.operation),value.local);
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
    || !['localAlbumRead','mobileMain','materializeMBEdition','loadMBQueue','saveMBQueue','captureLocalSource','readLocalSourceLyrics','revalidateLocalSource','releaseLocalSource','prepare','dispatch','dispatchInternal','commitBoot','exportCollectionSnapshot','getCollectionSnapshotVersion','exportVersionedCollectionSnapshot','exportLargeVersionedCollectionSnapshot','close'].includes(String(value.operation))) return false;
  return value.ok === true ? value.failure === undefined && Object.hasOwn(value,'result') : value.ok === false && value.result === undefined && isDatasetOwnerFailure(value.failure);
}
export const DATASET_PROJECTION_COMMANDS = ['normalizeLocalAlbumArtwork','browseAlbumCandidates','captureAlbumMetadata','captureTrackMetadataBatch','acquirePermit','releasePermit','scanReadStatus','scanReadAcquire','scanReadWatchRevocation','scanReadRelease','lyricsProviderStart','lyricsProviderRead','lyricsProviderCancel','lyricsProviderJoin','nameProviderStart','nameProviderRead','nameProviderCancel','nameProviderJoin'] as const;
export function isDatasetProjectionPayload(command: unknown, payload: unknown): payload is DatasetProjectionCommandPayloads[DatasetProjectionCommand] {
  if(isDatasetNameProviderCommand(command))return isDatasetNameProviderPayload(command,payload);
  if(isDatasetLyricsProviderCommand(command))return isDatasetLyricsProviderPayload(command,payload);
  if (command === 'scanReadStatus' || command === 'scanReadAcquire' || command === 'scanReadWatchRevocation' || command === 'scanReadRelease') {
    if (wbNodeTypes.isProxy(payload) || !ownerRecord(payload) || ![Object.prototype,null].includes(Object.getPrototypeOf(payload))) return false;
    const fields = Reflect.ownKeys(payload);
    if (command === 'scanReadStatus') return fields.length === 0;
    if (command === 'scanReadAcquire' && fields.length === 0) return true;
    const key = command === 'scanReadAcquire' ? 'purpose' : 'permitId', descriptor = Object.getOwnPropertyDescriptor(payload, key);
    return fields.length === 1 && fields[0] === key && descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value')
      && (command === 'scanReadAcquire' ? descriptor.value === 'local-album-display' : isCollectionId(descriptor.value));
  }
  if (!ownerRecord(payload)) return false;
  if (command === 'normalizeLocalAlbumArtwork') return Reflect.ownKeys(payload).length === 1 && Object.hasOwn(payload, 'copies')
    && Object.getOwnPropertyDescriptor(payload, 'copies')?.enumerable === true && Object.hasOwn(Object.getOwnPropertyDescriptor(payload, 'copies')!, 'value')
    && [Object.prototype, null].includes(Object.getPrototypeOf(payload)) && isLocalArtworkCommandResult('localArtwork.readCandidates', payload.copies);
  if (command === 'browseAlbumCandidates') return validateIpcRequest({version:IPC_VERSION,id:'projection',command:'physicalLinks.search',payload}).ok;
  if (command === 'captureAlbumMetadata') return keys(payload,['reference']) && isRoonAlbumReference(payload.reference);
  if (command === 'captureTrackMetadataBatch') return keys(payload,['references']) && Array.isArray(payload.references) && payload.references.length > 0 && payload.references.length <= 100 && payload.references.every(isRoonAlbumReference);
  if (command === 'acquirePermit') return keys(payload,['scope','projectionId']) && safeString(payload.scope) && isCollectionId(payload.projectionId);
  if (command === 'releasePermit') return keys(payload,['scope','projectionId','permitId']) && safeString(payload.scope) && isCollectionId(payload.projectionId) && isCollectionId(payload.permitId);
  return false;
}
export function isDatasetProjectionResult(command: DatasetProjectionCommand, value: unknown): boolean {
  if(isDatasetNameProviderCommand(command))return isDatasetNameProviderResult(command,value);
  if(isDatasetLyricsProviderCommand(command))return isDatasetLyricsProviderResult(command,value);
  if (command === 'normalizeLocalAlbumArtwork') return ownerRecord(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Reflect.ownKeys(value).length === (Object.hasOwn(value, 'grid') ? 3 : 2) && ['image', 'status', ...(Object.hasOwn(value, 'grid') ? ['grid'] : [])].every(key => Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
      && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))
    && (value.status === 'ready' || value.status === 'source-unavailable') && (value.image === null || isLocalArtworkImage(value.image))
    && (!Object.hasOwn(value, 'grid') || value.image !== null && dto.isLocalAlbumArtworkGrid(value.grid))
    && (value.status !== 'source-unavailable' || value.image === null);
  if (command === 'scanReadStatus' || command === 'scanReadAcquire' || command === 'scanReadWatchRevocation' || command === 'scanReadRelease') {
    if (!ownerRecord(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) return false;
    const closedScan=(names:readonly string[])=>Reflect.ownKeys(value).length === names.length && names.every(k=>Object.prototype.propertyIsEnumerable.call(value,k));
    if(command === 'scanReadStatus') { const status=Object.getOwnPropertyDescriptor(value,'status');return closedScan(['status'])&&status!==undefined&&Object.hasOwn(status,'value')&&(status.value==='ready'||status.value==='deferred'); }
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
  return ownerRecord(value) && keys(value,['version','epoch','type','projectionRequestId','command','payload','read']) && value.version === DATASET_OWNER_PROTOCOL_VERSION && value.type === 'projection' && isCollectionId(value.epoch) && isCollectionId(value.projectionRequestId) && isDatasetProjectionPayload(value.command,value.payload)
    && (!Object.hasOwn(value,'read') || value.command==='normalizeLocalAlbumArtwork' && ownerRecord(value.read) && [Object.prototype,null].includes(Object.getPrototypeOf(value.read))
      && Reflect.ownKeys(value.read).length===1 && Object.getOwnPropertyDescriptor(value.read,'expiresAtMs')?.enumerable===true && Object.hasOwn(Object.getOwnPropertyDescriptor(value.read,'expiresAtMs')!,'value')
      && Number.isSafeInteger(value.read.expiresAtMs) && (value.read.expiresAtMs as number)>0);

}
export function isDatasetOwnerProjectionCancel(value:unknown):value is DatasetOwnerProjectionCancel {
  return ownerRecord(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&Reflect.ownKeys(value).length===6
    &&['version','epoch','type','projectionRequestId','command','expiresAtMs'].every(k=>Object.getOwnPropertyDescriptor(value,k)?.enumerable===true&&Object.hasOwn(Object.getOwnPropertyDescriptor(value,k)!,'value'))
    &&value.version===DATASET_OWNER_PROTOCOL_VERSION&&value.type==='projection-cancel'&&isCollectionId(value.epoch)&&isCollectionId(value.projectionRequestId)
    &&value.command==='normalizeLocalAlbumArtwork'&&Number.isSafeInteger(value.expiresAtMs)&&(value.expiresAtMs as number)>0;
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

const ownResult = (value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || wbNodeTypes.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value)
  return required.every(key => descriptors[key] !== undefined) && keys.every(key => typeof key === 'string' && [...required, ...optional].includes(key) && descriptors[key]?.enumerable === true && 'value' in descriptors[key]!)
}
const arrayResult = (value: unknown, max: number): value is unknown[] => !wbNodeTypes.isProxy(value) && Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype
  && value.length <= max && Reflect.ownKeys(value).length === value.length + 1
  && Array.from({ length: value.length }, (_, i) => Object.getOwnPropertyDescriptor(value, String(i))).every(d => d?.enumerable === true && 'value' in d)
const idsResult = (value: unknown): value is string[] => arrayResult(value, 10000) && value.every(dto.isLocalLyricsId) && new Set(value).size === value.length
const naturalResult = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
const stateResult = (value: unknown, allowed: readonly string[]): boolean => typeof value === 'string' && allowed.includes(value)
function publicDataResult(value: unknown, ancestors = new Set<object>(), depth = 0): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || wbNodeTypes.isProxy(value) || depth > 16 || ancestors.has(value)) return false
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value)
  if (prototype !== (array ? Array.prototype : Object.prototype) && (array || prototype !== null)) return false
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value)
  if (keys.some(key => typeof key !== 'string' || !('value' in descriptors[key]!) || key !== 'length' && descriptors[key]?.enumerable !== true)) return false
  ancestors.add(value)
  try { return keys.every(key => array && key === 'length' || publicDataResult(descriptors[key as string]!.value, ancestors, depth + 1)) }
  finally { ancestors.delete(value) }
}
const equalScope = (a: dto.LocalLyricsScope, b: dto.LocalLyricsScope) => a.datasetId === b.datasetId && a.libraryId === b.libraryId && a.albumId === b.albumId && a.captureId === b.captureId
const equalLibrary = (a: dto.LocalLyricsLibraryRequest, b: dto.LocalLyricsLibraryRequest) => a.datasetId === b.datasetId && a.libraryId === b.libraryId && a.captureId === b.captureId
function lyricsReceiptResult(value: unknown): value is dto.LocalLyricsSaveReceipt {
  if (!ownResult(value, ['commandId', 'sessionId', 'state', 'cover', 'tracks', 'snapshot']) || !dto.isLocalLyricsId(value.commandId) || !dto.isLocalLyricsId(value.sessionId)
    || !stateResult(value.state, ['running','complete','partial','unknown','cancelled','failed']) || !stateResult(value.snapshot, ['not-requested','pending','saved','failed']) || !arrayResult(value.tracks,10000)) return false
  const states = ['not-requested','pending','saved','existing','failed','unknown','cancelled']
  return stateResult(value.cover, states) && value.tracks.every(row => ownResult(row,['trackId','lrc','embed']) && dto.isLocalLyricsId(row.trackId) && stateResult(row.lrc,states) && stateResult(row.embed,states))
    && new Set(value.tracks.map(row => (row as dto.LocalLyricsTrackReceipt).trackId)).size === value.tracks.length
}
function lyricsSessionResult(value: unknown): value is dto.LocalLyricsSession {
  if (!ownResult(value,['sessionId','scope','state','tracks','candidates'],['pendingOperations']) || !dto.isLocalLyricsId(value.sessionId) || !dto.isLocalLyricsScope(value.scope)
    || !stateResult(value.state,['querying','ready','cancelled','stale']) || !arrayResult(value.tracks,10000) || !arrayResult(value.candidates,dto.LOCAL_LYRICS_LIMITS.sessionBodyBytes)) return false
  if (!value.candidates.every(candidate => dto.isLocalLyricsCandidateDetail({candidate,body:'核验候选'}))) return false
  const candidates = value.candidates as unknown as dto.LocalLyricsCandidate[]
  if (new Set(candidates.map(row => row.candidateId)).size !== candidates.length || !value.tracks.every(track => {
    if (!ownResult(track,['trackId','title','presence','match','candidateIds','selectedCandidateId','sources']) || !dto.isLocalLyricsId(track.trackId) || !dto.isLocalLyricsSafeText(track.title,2048)
      || !stateResult(track.presence,['unknown','false','true']) || !stateResult(track.match,['existing','whole-track','recommended','review','not-found','failed','unknown']) || !idsResult(track.candidateIds)
      || track.selectedCandidateId !== null && (!dto.isLocalLyricsId(track.selectedCandidateId) || !track.candidateIds.includes(track.selectedCandidateId)) || !arrayResult(track.sources,5)) return false
    return track.candidateIds.every(id => candidates.some(row => row.candidateId === id && row.trackId === track.trackId))
      && track.sources.every(source => ownResult(source,['source','state']) && dto.LOCAL_LYRICS_SOURCES.includes(source.source as dto.LocalLyricsSource) && stateResult(source.state,['ok','failed','unavailable','budget','cancelled']))
      && new Set(track.sources.map(source => (source as dto.LocalLyricsSourceResult).source)).size === track.sources.length
  })) return false
  const tracks = value.tracks as unknown as dto.LocalLyricsTrackView[]
  if (new Set(tracks.map(row => row.trackId)).size !== tracks.length || candidates.some(row => !tracks.some(track => track.trackId === row.trackId))) return false
  if (Object.hasOwn(value,'pendingOperations') && (!arrayResult(value.pendingOperations,10000) || !value.pendingOperations.every(row => ownResult(row,['request','receipt'])
    && dto.isLocalLyricsCommandPayload('localLyrics.save',row.request) && lyricsReceiptResult(row.receipt)
    && row.receipt.commandId === (row.request as dto.LocalLyricsSaveRequest).commandId && row.receipt.sessionId === (row.request as dto.LocalLyricsSaveRequest).sessionId)
    || new Set((value.pendingOperations as { request: dto.LocalLyricsSaveRequest }[]).map(row=>row.request.commandId)).size !== (value.pendingOperations as unknown[]).length)) return false
  return true
}
function lyricsJobResult(value: unknown, datasetId: string): value is dto.LocalLyricsJobSnapshot {
  if (!ownResult(value,['jobId','library','state','totalAlbums','processedAlbums','savedAlbums','reviewAlbumIds','failedAlbumIds','unknownAlbumIds','sidecars','embedded','inspectionFailures','revision'],['originalEntry'])
    || !dto.isLocalLyricsId(value.jobId) || !dto.isLocalLyricsLibraryRequest(value.library) || value.library.datasetId !== datasetId
    || !stateResult(value.state,['queued','running','stopped','complete','partial','unknown','failed'])
    || !['totalAlbums','processedAlbums','savedAlbums','sidecars','embedded','inspectionFailures','revision'].every(key=>naturalResult(value[key]))
    || Number(value.processedAlbums)>Number(value.totalAlbums) || Number(value.savedAlbums)>Number(value.processedAlbums)
    || !idsResult(value.reviewAlbumIds) || !idsResult(value.failedAlbumIds) || !idsResult(value.unknownAlbumIds)) return false
  const ids = [...value.reviewAlbumIds,...value.failedAlbumIds,...value.unknownAlbumIds]
  return new Set(ids).size === ids.length && ids.length <= Number(value.totalAlbums)
    && (!Object.hasOwn(value,'originalEntry') || value.originalEntry === null
      || dto.isLocalLyricsJobOriginalEntry(value.originalEntry) && value.originalEntry.scope.datasetId === datasetId && value.originalEntry.scope.libraryId === value.library.libraryId)
}
/** public只消费闭集结果；不从候选正文或源URL构造路径/许可。 */
export function isDatasetWorkbenchLyricsResult<C extends dto.LocalLyricsCommand>(command: C, value: unknown, payload: dto.LocalLyricsCommandPayloads[C], datasetId: string): value is dto.LocalLyricsCommandResults[C] {
  try {
    if (!dto.isLocalLyricsCommandPayload(command,payload) || !publicDataResult(value) || new TextEncoder().encode(JSON.stringify(value)).byteLength > dto.LOCAL_LYRICS_LIMITS.sessionBodyBytes) return false
    if (command === 'localLyrics.detail') return dto.isLocalLyricsCandidateDetail(value) && value.candidate.candidateId === (payload as dto.LocalLyricsDetailRequest).candidateId
    if (command === 'localLyrics.query') return lyricsSessionResult(value) && equalScope(value.scope,(payload as dto.LocalLyricsQueryRequest).scope) && value.scope.datasetId === datasetId
    if (['localLyrics.session.read','localLyrics.select','localLyrics.cancel'].includes(command) || command === 'localLyrics.discard' && !('commandId' in payload)) {
      if (!lyricsSessionResult(value) || value.scope.datasetId !== datasetId || value.sessionId !== (payload as dto.LocalLyricsSessionRequest).sessionId) return false
      if (command === 'localLyrics.select') { const p=payload as dto.LocalLyricsSelectionRequest; return value.tracks.some(row=>row.trackId===p.trackId && row.selectedCandidateId===p.candidateId) }
      return true
    }
    if (['localLyrics.save','localLyrics.receipt','localLyrics.save.retry','localLyrics.snapshot.retry','localLyrics.discard'].includes(command)) {
      if (value === null) return command === 'localLyrics.receipt'
      const p=payload as dto.LocalLyricsReceiptRequest
      return lyricsReceiptResult(value) && value.sessionId===p.sessionId && value.commandId===p.commandId
    }
    if (command === 'localLyrics.inventory') {
      const p=payload as dto.LocalLyricsInventoryRequest
      return ownResult(value,['total','offset','rows','watermark']) && naturalResult(value.total) && value.offset===p.offset && dto.isLocalLyricsSafeText(value.watermark,2048) && (value.watermark as string).length>0
        && arrayResult(value.rows,p.limit) && value.rows.every(row=>ownResult(row,['albumId','presence']) && dto.isLocalLyricsId(row.albumId) && stateResult(row.presence,['unknown','false','true']))
        && new Set(value.rows.map(row=>(row as dto.LocalLyricsInventoryRow).albumId)).size===value.rows.length && value.rows.length===Math.min(p.limit,Math.max(0,Number(value.total)-p.offset)) && (p.filter!=='missingLyrics' || value.rows.every(row=>(row as dto.LocalLyricsInventoryRow).presence==='false'))
    }
    if (value === null) return command === 'localLyrics.job.read'
    if (!lyricsJobResult(value,datasetId)) return false
    if (command === 'localLyrics.job.read') {
      const p = payload as dto.LocalLyricsJobReadRequest
      return value.jobId === p.jobId && (Object.hasOwn(p,'albumId')
        ? Object.hasOwn(value,'originalEntry') && (value.originalEntry === null || value.originalEntry !== undefined && value.originalEntry.scope.albumId === p.albumId)
        : !Object.hasOwn(value,'originalEntry'))
    }
    if (Object.hasOwn(value,'originalEntry')) return false
    if (command === 'localLyrics.job.start') { const p=payload as dto.LocalLyricsJobStartRequest;return value.jobId===p.commandId && equalLibrary(value.library,p.library) }
    return value.jobId === (payload as dto.LocalLyricsJobRequest).jobId
  } catch { return false }
}





/** 只在原Owner线程/原Utility端口上的39命令，不进入general IpcCommand。 */
export const DATASET_WORKBENCH_COMMANDS = {
  management: ['library.read','library.import.prepare','library.import.confirm','library.capture','library.album.capture','library.albums.capture','library.rename','library.remove','library.snapshot.load','library.snapshot.retry','library.operation.read','library.settings.read','library.settings.save','library.watch.set','library.ai.start','library.cue.start','library.job.read','library.job.stop','library.job.resume','library.job.retry'],
  nameSettings: ['name.settings.read','name.settings.save','name.settings.securityPrompt'],
  lyrics: ['localLyrics.query','localLyrics.session.read','localLyrics.detail','localLyrics.select','localLyrics.cancel','localLyrics.discard','localLyrics.save','localLyrics.receipt','localLyrics.save.retry','localLyrics.snapshot.retry','localLyrics.job.start','localLyrics.job.read','localLyrics.job.stop','localLyrics.job.resume','localLyrics.job.retry','localLyrics.inventory'],
} as const
export type DatasetWorkbenchRequest =
  | { [C in dto.LocalLibraryManagementCommand]: {family:'management';command:C;payload:dto.LocalLibraryManagementPayloads[C]} }[dto.LocalLibraryManagementCommand]
  | { [C in dto.LocalNameSettingsCommand]: {family:'nameSettings';command:C;payload:dto.LocalNameSettingsPayloads[C]} }[dto.LocalNameSettingsCommand]
  | { [C in dto.LocalLyricsCommand]: {family:'lyrics';command:C;payload:dto.LocalLyricsCommandPayloads[C]} }[dto.LocalLyricsCommand]
export type DatasetWorkbenchResult = dto.LocalLibraryManagementResults[dto.LocalLibraryManagementCommand] | dto.LocalNameSettingsResults[dto.LocalNameSettingsCommand] | dto.LocalLyricsCommandResults[dto.LocalLyricsCommand]
export interface DatasetWorkbenchContext extends DatasetOwnerIdentity {ready:true}
export interface DatasetWorkbenchExecutionContext {identity:Readonly<DatasetOwnerIdentity>;signal:AbortSignal;deadlineAtMs:number}
export const DATASET_WORKBENCH_BOUNDS = Object.freeze({requestMs:2000,drainMs:10000,libraryRemoveMs:LIBRARY_REMOVAL_REQUEST_MS,chunkBytes:64*1024,requestBytes:128*1024,resultBytes:8*1024*1024,pending:24})
export function isDatasetWorkbenchContext(value:unknown):value is DatasetWorkbenchContext {
  return ownResult(value,['epoch','datasetId','ready']) && dto.isCollectionId(value.epoch) && dto.isCommandOutboxDatasetId(value.datasetId) && value.ready===true
}
export function datasetWorkbenchJson(value:unknown):Uint8Array {
  if(!publicDataResult(value))throw new DatasetWorkbenchWireError('INVALID_IPC_REQUEST')
  const sorted=(v:unknown):unknown=>Array.isArray(v)?v.map(sorted):v!==null&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sorted((v as Record<string,unknown>)[k])])):v
  return Buffer.from(JSON.stringify(sorted(value)),'utf8')
}
export const datasetWorkbenchSha=(raw:Uint8Array):string=>wbHash('sha256').update(raw).digest('hex')
export function isDatasetWorkbenchRequest(value:unknown):value is DatasetWorkbenchRequest {
  try {
    if(!ownResult(value,['family','command','payload'])||!publicDataResult(value.payload))return false
    const family=value.family,command=value.command
    if(family==='management')return (DATASET_WORKBENCH_COMMANDS.management as readonly unknown[]).includes(command)&&dto.isLocalLibraryManagementCommand(command)&&dto.isLocalLibraryManagementPayload(command,value.payload)&&datasetWorkbenchJson(value).byteLength<=DATASET_WORKBENCH_BOUNDS.requestBytes
    if(family==='nameSettings')return (DATASET_WORKBENCH_COMMANDS.nameSettings as readonly unknown[]).includes(command)&&dto.isLocalNameSettingsCommand(command)&&dto.isLocalNameSettingsPayload(command,value.payload)&&datasetWorkbenchJson(value).byteLength<=DATASET_WORKBENCH_BOUNDS.requestBytes
    return family==='lyrics'&&(DATASET_WORKBENCH_COMMANDS.lyrics as readonly unknown[]).includes(command)&&dto.isLocalLyricsCommandPayload(command as dto.LocalLyricsCommand,value.payload)&&datasetWorkbenchJson(value).byteLength<=DATASET_WORKBENCH_BOUNDS.requestBytes
  }catch{return false}
}
/** 只有完整闭集remove正文取得关闭链预算；普通命令、context与未组装帧仍是原2秒。 */
export function datasetWorkbenchRequestMs(request:unknown):number {
  return isDatasetWorkbenchRequest(request)&&request.family==='management'&&request.command==='library.remove'
    ?DATASET_WORKBENCH_BOUNDS.libraryRemoveMs:DATASET_WORKBENCH_BOUNDS.requestMs
}
/** 私有身份读取与drain只在合法空正文取得各自有界预算；普通命令仍沿原期限。 */
export function datasetWorkbenchOperationMs(kind:DatasetWorkbenchMeta['kind'],body:unknown):number {
  if(kind==='context.identity'){
    if(!ownResult(body,[]))throw new DatasetWorkbenchWireError('INVALID_IPC_REQUEST')
    return 20_000
  }
  if(kind==='drain'){
    if(!ownResult(body,[]))throw new DatasetWorkbenchWireError('INVALID_IPC_REQUEST')
    return DATASET_WORKBENCH_BOUNDS.drainMs
  }
  return kind==='execute'?datasetWorkbenchRequestMs(body):DATASET_WORKBENCH_BOUNDS.requestMs
}
/** 收完正文后仍使用原expiry与首次接收时钟；不从组装完成时另给一轮期限。 */
export function datasetWorkbenchExecutionDeadline(meta:DatasetWorkbenchMeta,body:unknown,receivedAtMs:number,startedAtMs:number):number {
  const monotonic=performance.now(),wall=Date.now()
  if(wall-receivedAtMs>=DATASET_WORKBENCH_BOUNDS.requestMs||monotonic-startedAtMs>=DATASET_WORKBENCH_BOUNDS.requestMs)throw new DatasetWorkbenchWireError('TIMEOUT')
  const budget=datasetWorkbenchOperationMs(meta.kind,body)
  if(meta.expiresAtMs>receivedAtMs+budget)throw new DatasetWorkbenchWireError('INVALID_IPC_REQUEST')
  const originalRemaining=Math.min(budget,meta.expiresAtMs-receivedAtMs)
  const deadline=Math.min(monotonic+meta.expiresAtMs-wall,startedAtMs+originalRemaining)
  if(deadline<=monotonic)throw new DatasetWorkbenchWireError('TIMEOUT')
  return deadline
}
export function isDatasetWorkbenchResult(request:DatasetWorkbenchRequest,value:unknown,datasetId:string):value is DatasetWorkbenchResult {
  if(!isDatasetWorkbenchRequest(request)||!publicDataResult(value))return false
  if(request.family==='management')return dto.isLocalLibraryManagementResult(request.command,value,request.payload)&&(value===null||typeof value!=='object'||!('datasetId'in value)||value.datasetId===datasetId)
    && (value===null||typeof value!=='object'||!('originalEntry'in value)||value.originalEntry===null||dto.isLocalLibraryJobOriginalEntry(value.originalEntry)&&value.originalEntry.datasetId===datasetId)
  if(request.family==='nameSettings')return dto.isLocalNameSettingsResult(request.command,value,request.payload)
  return isDatasetWorkbenchLyricsResult(request.command,value,request.payload,datasetId)
}
export type DatasetWorkbenchWireCode='INVALID_IPC_REQUEST'|'INVALID_IPC_RESPONSE'|'OUTBOX_SCOPE_MISMATCH'|'NOT_READY'|'TIMEOUT'
export class DatasetWorkbenchWireError extends Error {
  readonly outcome:'not-sent'|'unknown'
  constructor(readonly code:DatasetWorkbenchWireCode,outcome:'not-sent'|'unknown'='unknown'){super('原整理请求未确认，请核对原command/body回执。');this.name='DatasetWorkbenchWireError';this.outcome=outcome}
}
export interface DatasetWorkbenchMeta {
  id:string;epoch:string|null;datasetId:string;sequence:number;kind:'context'|'context.identity'|'execute'|'owner'|'drain';requestSha256:string;expiresAtMs:number
}
export const isDatasetWorkbenchContextKind = (value: unknown): value is 'context' | 'context.identity' => value === 'context' || value === 'context.identity'
interface WorkbenchFrameBase extends DatasetWorkbenchMeta {version:1;type:'musicbridge.workbench.frame';lane:'request'|'response'|'control'}
export type DatasetWorkbenchFrame = WorkbenchFrameBase & (
  | {part:'begin';totalBytes:number;sha256:string;chunks:number}
  | {part:'data';index:number;data:Uint8Array}
  | {part:'end';totalBytes:number;sha256:string;chunks:number}
  | {part:'failure';code:DatasetWorkbenchWireCode}
  | {part:'settled'} | {part:'cancel'}
)
const wbMetaKeys=['id','epoch','datasetId','sequence','kind','requestSha256','expiresAtMs'] as const
const wbSha=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{64}$/u.test(v)
export function isDatasetWorkbenchMeta(value:unknown):value is DatasetWorkbenchMeta {
  return ownResult(value,wbMetaKeys)&&dto.isCollectionId(value.id)&&(value.epoch===null||dto.isCollectionId(value.epoch))&&dto.isCommandOutboxDatasetId(value.datasetId)
    &&Number.isSafeInteger(value.sequence)&&Number(value.sequence)>0&&['context','context.identity','execute','owner','drain'].includes(String(value.kind))&&wbSha(value.requestSha256)&&Number.isSafeInteger(value.expiresAtMs)&&Number(value.expiresAtMs)>0
}
export function datasetWorkbenchMeta(frame:DatasetWorkbenchFrame):DatasetWorkbenchMeta {
  return {id:frame.id,epoch:frame.epoch,datasetId:frame.datasetId,sequence:frame.sequence,kind:frame.kind,requestSha256:frame.requestSha256,expiresAtMs:frame.expiresAtMs}
}
export function sameDatasetWorkbenchMeta(a:DatasetWorkbenchMeta,b:DatasetWorkbenchMeta):boolean{return wbMetaKeys.every(k=>a[k]===b[k])}
export function isDatasetWorkbenchFrame(value:unknown):value is DatasetWorkbenchFrame {
  if(!value||typeof value!=='object'||wbNodeTypes.isProxy(value))return false
  const v=value as Record<string,unknown>,part=Object.getOwnPropertyDescriptor(v,'part')?.value
  const fields=part==='begin'||part==='end'?['totalBytes','sha256','chunks']:part==='data'?['index','data']:part==='failure'?['code']:part==='settled'||part==='cancel'?[]:null
  if(!fields||!ownResult(v,['version','type','lane','part',...wbMetaKeys,...fields])||v.version!==1||v.type!=='musicbridge.workbench.frame'||!['request','response','control'].includes(String(v.lane)))return false
  const meta=Object.fromEntries(wbMetaKeys.map(k=>[k,v[k]]))
  if(!isDatasetWorkbenchMeta(meta)||v.epoch===null&&v.kind!=='context')return false
  if(part==='cancel')return v.lane==='control'
  if(v.lane==='control')return false
  if(part==='failure')return v.lane==='response'&&['INVALID_IPC_REQUEST','INVALID_IPC_RESPONSE','OUTBOX_SCOPE_MISMATCH','NOT_READY','TIMEOUT'].includes(String(v.code))
  if(part==='settled')return v.lane==='response'
  if(part==='data')return Number.isSafeInteger(v.index)&&Number(v.index)>=0&&!wbNodeTypes.isProxy(v.data)&&v.data instanceof Uint8Array&&v.data.byteLength>0&&v.data.byteLength<=DATASET_WORKBENCH_BOUNDS.chunkBytes
  return Number.isSafeInteger(v.totalBytes)&&Number(v.totalBytes)>0&&Number(v.totalBytes)<=datasetWorkbenchMaximum(meta,v.lane as 'request'|'response')&&wbSha(v.sha256)
    &&Number.isSafeInteger(v.chunks)&&v.chunks===Math.ceil(Number(v.totalBytes)/DATASET_WORKBENCH_BOUNDS.chunkBytes)
}
export function datasetWorkbenchControl(meta:DatasetWorkbenchMeta,part:'cancel'|'settled'|'failure',code?:DatasetWorkbenchWireCode):DatasetWorkbenchFrame {
  const frame={...meta,version:1 as const,type:'musicbridge.workbench.frame' as const,lane:part==='cancel'?'control' as const:'response' as const,part,...(part==='failure'?{code:code??'NOT_READY'}:{})} as DatasetWorkbenchFrame
  if(!isDatasetWorkbenchFrame(frame))throw new DatasetWorkbenchWireError('INVALID_IPC_REQUEST');return frame
}
export function datasetWorkbenchFrames(meta:DatasetWorkbenchMeta,lane:'request'|'response',value:unknown):DatasetWorkbenchFrame[] {
  if(!isDatasetWorkbenchMeta(meta))throw new DatasetWorkbenchWireError('INVALID_IPC_REQUEST')
  const raw=datasetWorkbenchJson(value),maximum=datasetWorkbenchMaximum(meta,lane)
  if(raw.byteLength>maximum)throw new DatasetWorkbenchWireError('INVALID_IPC_RESPONSE')
  const sha256=datasetWorkbenchSha(raw),chunks=Math.ceil(raw.byteLength/DATASET_WORKBENCH_BOUNDS.chunkBytes),base={...meta,version:1 as const,type:'musicbridge.workbench.frame' as const,lane}
  const frames:DatasetWorkbenchFrame[]=[{...base,part:'begin',totalBytes:raw.byteLength,sha256,chunks}]
  for(let index=0;index<chunks;index++)frames.push({...base,part:'data',index,data:new Uint8Array(raw.slice(index*DATASET_WORKBENCH_BOUNDS.chunkBytes,(index+1)*DATASET_WORKBENCH_BOUNDS.chunkBytes))})
  frames.push({...base,part:'end',totalBytes:raw.byteLength,sha256,chunks});return frames
}
/** 每原请求独立重组，严格顺序/EOF/bytes/SHA；不让断流或重复chunk形成部分成功。 */
export function createDatasetWorkbenchAssembler(meta:DatasetWorkbenchMeta,lane:'request'|'response') {
  let started=false,ended=false,total=0,sha='',chunks=0,index=0,bytes=0
  const parts:Uint8Array[]=[]
  return {accept(frame:unknown):unknown|undefined{
    if(!isDatasetWorkbenchFrame(frame)||frame.lane!==lane||!sameDatasetWorkbenchMeta(frame,meta)||ended)throw new DatasetWorkbenchWireError('INVALID_IPC_RESPONSE')
    if(frame.part==='begin'){
      if(started)throw new DatasetWorkbenchWireError('INVALID_IPC_RESPONSE')
      started=true;total=frame.totalBytes;sha=frame.sha256;chunks=frame.chunks;return undefined
    }
    if(!started)throw new DatasetWorkbenchWireError('INVALID_IPC_RESPONSE')
    if(frame.part==='data'){
      if(frame.index!==index||index>=chunks||frame.data.byteLength!==Math.min(DATASET_WORKBENCH_BOUNDS.chunkBytes,total-bytes))throw new DatasetWorkbenchWireError('INVALID_IPC_RESPONSE')
      parts.push(new Uint8Array(frame.data));bytes+=frame.data.byteLength;index++;return undefined
    }
    if(frame.part!=='end'||frame.chunks!==chunks||frame.totalBytes!==total||frame.sha256!==sha||index!==chunks||bytes!==total)throw new DatasetWorkbenchWireError('INVALID_IPC_RESPONSE')
    ended=true;const raw=Buffer.concat(parts,total)
    if(datasetWorkbenchSha(raw)!==sha)throw new DatasetWorkbenchWireError('INVALID_IPC_RESPONSE')
    const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw))
    if(Buffer.compare(Buffer.from(datasetWorkbenchJson(value)),raw)!==0)throw new DatasetWorkbenchWireError('INVALID_IPC_RESPONSE')
    parts.length=0;return value
  }}
}


/** 原工作台私有端点与Main就绪确认，不加入IpcCommand或公开39命令。 */
export const DATASET_WORKBENCH_OWNER_COMMANDS = [
  'read.albums','read.resolveCapture','read.prepareNameSuggestion','read.completeNameSuggestion',
  'read.prepareNamePreview','read.prepareArtworkPreview','read.cancelNamePreparation',
  'registry.issuePlan','registry.apply','registry.readOriginalReceipt','registry.cancel',
  'registry.getPlan','registry.readArtworkCapture','registry.operations',
  'capabilities.read','artwork.readLocal','cue.preparePreview','existing.open','lifecycle.mainReady',
] as const
export type DatasetWorkbenchOwnerCommand = typeof DATASET_WORKBENCH_OWNER_COMMANDS[number]
export interface DatasetWorkbenchOwnerPayloads {
  /** 仅真实Main装配完成后确认；Owner只开启原后台调度，不取得Source许可。 */
  'lifecycle.mainReady': Record<string,never>
  'read.albums': dto.LocalWorkbenchReadRequest
  'read.resolveCapture': dto.LocalWorkbenchArtworkRequest
  'read.prepareNameSuggestion': dto.LocalWorkbenchAiRequest
  'read.completeNameSuggestion': {preparationId:string;response:{backend:dto.LocalAiBackend;content:string}}
  'read.prepareNamePreview': dto.LocalWorkbenchAiPreviewRequest
  // 只送原引用；Owner重新resolve，Main的完整DTO不是新的SourceFiles许可。
  'read.prepareArtworkPreview': {reference:dto.LocalWorkbenchArtworkRequest;artwork:Readonly<LocalWorkbenchArtworkCapture>}
  'read.cancelNamePreparation': {preparationId:string}
  'registry.issuePlan': {draft:LocalWorkbenchPlanDraft;capture:LocalWorkbenchPlanCapture}
  'registry.apply': dto.LocalWorkbenchApplyRequest
  'registry.readOriginalReceipt': dto.LocalWorkbenchApplyRequest
  'registry.cancel': dto.LocalWorkbenchCancelRequest
  'registry.getPlan': {planId:string}
  'registry.readArtworkCapture': {datasetId:string;planId:string;candidateId:string}
  'registry.operations': Record<string,never>
  'capabilities.read': Record<string,never>
  'artwork.readLocal': dto.LocalWorkbenchArtworkRequest
  /** target仅原Main许可的公开描述/修订，Domain仍须持有实际Native作者回调。 */
  'cue.preparePreview': {request:dto.LocalCueSplitInput;target:{target:dto.LocalCueOutputTarget;revision:string}}
  'existing.open': dto.LocalWorkbenchExistingRequest
}
export interface DatasetWorkbenchOwnerResults {
  'lifecycle.mainReady': true
  'read.albums': dto.LocalWorkbenchReadback
  'read.resolveCapture': Readonly<LocalWorkbenchResolvedReadCapture>
  'read.prepareNameSuggestion': Readonly<LocalWorkbenchNamePreparation>
  'read.completeNameSuggestion': LocalNameProposalResult
  'read.prepareNamePreview': Awaited<ReturnType<LocalWorkbenchReadService['prepareNamePreview']>>
  'read.prepareArtworkPreview': Awaited<ReturnType<LocalWorkbenchReadService['prepareArtworkPreview']>>
  'read.cancelNamePreparation': boolean
  'registry.issuePlan': dto.LocalWorkbenchPlan
  'registry.apply': dto.LocalWorkbenchReceipt
  'registry.readOriginalReceipt': dto.LocalWorkbenchReceipt|null
  'registry.cancel': dto.LocalWorkbenchReceipt
  'registry.getPlan': dto.LocalWorkbenchPlan|null
  'registry.readArtworkCapture': Readonly<LocalWorkbenchFrozenArtwork>|null
  'registry.operations': readonly dto.LocalWorkbenchOperation[]
  'capabilities.read': dto.LocalWorkbenchCapabilitiesReply
  'artwork.readLocal': dto.LocalArtworkSourceCopies
  'cue.preparePreview': {draft:Extract<LocalWorkbenchPlanDraft,{kind:'cue'}>;capture:LocalWorkbenchPlanCapture}
  'existing.open': dto.LocalWorkbenchExistingReply
}
export type DatasetWorkbenchOwnerRequest = {[C in DatasetWorkbenchOwnerCommand]:{command:C;payload:DatasetWorkbenchOwnerPayloads[C]}}[DatasetWorkbenchOwnerCommand]
export type DatasetWorkbenchOwnerResult = DatasetWorkbenchOwnerResults[DatasetWorkbenchOwnerCommand]
export const DATASET_WORKBENCH_OWNER_BOUNDS=Object.freeze({maxMembers:10000,requestBytes:32*1024*1024,resultBytes:32*1024*1024})
function datasetWorkbenchMaximum(meta:DatasetWorkbenchMeta,lane:'request'|'response'):number {
  // 只有显式owner kind使用完整捕获上限；public39/context/drain原预算保持。
  return meta.kind==='owner' ? (lane==='request'?DATASET_WORKBENCH_OWNER_BOUNDS.requestBytes:DATASET_WORKBENCH_OWNER_BOUNDS.resultBytes)
    : lane==='request'?DATASET_WORKBENCH_BOUNDS.requestBytes:DATASET_WORKBENCH_BOUNDS.resultBytes
}
function wbPrepared(value:unknown,kind?:'artwork'|'ai'|'cue'):value is {draft:LocalWorkbenchPlanDraft;capture:LocalWorkbenchPlanCapture} {
  if(!ownResult(value,['draft','capture'])||!isLocalWorkbenchPlanCapture(value.capture)||!publicDataResult(value.draft)
    ||!ownResult(value.draft,['kind','scope','albumIds','state','blockers','items'],['relationship','candidateIds','sourceDisposition','target','tracks'])
    ||kind!==undefined&&value.draft.kind!==kind)return false
  // 纯shape校验只补固定非执行字段；此值从不保存、签发或充当author grant。
  const plan={...value.draft,datasetId:value.capture.datasetId,planId:'private-shape-check',revision:'1',contextFingerprint:'0'.repeat(64),planHash:'0'.repeat(64),expiresAt:'2000-01-01T00:00:00.000Z'}
  if(!dto.isLocalWorkbenchPlan(plan))return false
  try{assertLocalWorkbenchCapturedPlan(plan,value.capture);return true}catch{return false}
}
function wbResolved(value:unknown,reference:dto.LocalWorkbenchArtworkRequest,datasetId:string):value is LocalWorkbenchResolvedReadCapture {
  if(!ownResult(value,['datasetId','datasetRevision','capture','group','directoryFacts','provenance','availability'])
    ||value.datasetId!==datasetId||reference.datasetId!==datasetId||!dto.isLocalWorkbenchIdentity(value.datasetRevision)
    ||!isLocalWorkbenchAlbumCapture(value.capture)||value.capture.albumId!==reference.capture.albumId||value.capture.readToken!==reference.capture.readToken
    ||!['online','offline','unavailable'].includes(String(value.availability)))return false
  const group=value.group,facts=value.directoryFacts,provenance=value.provenance
  if(!ownResult(group,['summary','members','directory','issues'],['rejectedFiles'])||!dto.isLocalAlbumSummary(group.summary)
    ||group.summary.id!==value.capture.albumId||group.summary.rootId!==value.capture.rootId
    ||group.directory!==null&&!isLocalAlbumPrivateRelative(group.directory,true)
    ||!arrayResult(group.members,10000)||!arrayResult(group.issues,10000)
    ||Object.hasOwn(group,'rejectedFiles')&&!arrayResult(group.rejectedFiles,10000)
    ||!ownResult(facts,['revision','files','cues'])||!dto.isLocalWorkbenchIdentity(facts.revision)
    ||!arrayResult(facts.files,10000)||!arrayResult(facts.cues,10000)||facts.files.length+facts.cues.length>10000
    ||!arrayResult(provenance,10000))return false
  if(!group.members.every(member=>ownResult(member,['fact','disc','trackNumber','sequence','editionLink','statuses'])
    &&ownResult(member.fact,['relative','summary','rawMetadata','hasArtwork','artworkRevision'],['artworkState'])
    &&isLocalAlbumPrivateRelative(member.fact.relative)&&dto.isLocalLibraryTrackSummary(member.fact.summary)
    &&dto.isLocalMetadata(member.fact.rawMetadata)&&typeof member.fact.hasArtwork==='boolean'
    &&(member.fact.artworkRevision===null||dto.isLocalWorkbenchIdentity(member.fact.artworkRevision))
    &&(member.disc===null||naturalResult(member.disc))&&(member.trackNumber===null||naturalResult(member.trackNumber))
    &&naturalResult(member.sequence)&&(member.editionLink===null||dto.isAlbumEditionTrack(member.editionLink))
    &&arrayResult(member.statuses,8)&&member.statuses.every(status=>(dto.LOCAL_ALBUM_STATUSES as readonly unknown[]).includes(status))))return false
  if(!facts.files.every(file=>ownResult(file,['jobId','rootRevision','sourceRootId','currentRelative','value'])
    &&[file.jobId,file.rootRevision,file.sourceRootId].every(dto.isLocalWorkbenchIdentity)
    &&isLocalAlbumPrivateRelative(file.currentRelative)&&ownResult(file.value,['libraryRootId','relative','signature','parserVersion','outcome','assetId','trackId','failureCode','readFacts'])&&isScanFileState(file.value))
    ||!facts.cues.every(cue=>ownResult(cue,['id','sidecarId','libraryRootId','sourceRootId','rootRevision','item'])
      &&[cue.id,cue.sidecarId,cue.libraryRootId,cue.sourceRootId,cue.rootRevision].every(dto.isLocalWorkbenchIdentity)&&dto.isLocalCuePreparedItem(cue.item))
    ||!provenance.every(fact=>ownResult(fact,['trackId','override'])&&dto.isLocalWorkbenchIdentity(fact.trackId)
      &&(fact.override===null||ownResult(fact.override,['commandId','revision','fields'])
        &&dto.isLocalWorkbenchIdentity(fact.override.commandId)&&dto.isLocalWorkbenchIdentity(fact.override.revision)&&dto.isLocalMetadata(fact.override.fields))))return false
  const capture=value.capture,tracks=new Set(capture.members.flatMap(member=>member.trackId===null?[]:[member.trackId])),groupIds:string[]=[]
  for(const member of group.members){if(!ownResult(member,['fact','disc','trackNumber','sequence','editionLink','statuses'])||!ownResult(member.fact,['relative','summary','rawMetadata','hasArtwork','artworkRevision'],['artworkState'])||!dto.isLocalLibraryTrackSummary(member.fact.summary))return false;groupIds.push(member.fact.summary.track.id)}
  if(!group.issues.every(issue=>ownResult(issue,['kind','trackId','fields'])&&issue.kind==='missing-metadata'&&dto.isLocalWorkbenchIdentity(issue.trackId)&&arrayResult(issue.fields,3)&&issue.fields.every(field=>['title','artist','album'].includes(String(field)))
    ||ownResult(issue,['kind','relative'])&&issue.kind==='metadata-read-failed'&&isLocalAlbumPrivateRelative(issue.relative)
    ||ownResult(issue,['kind','relative','status'])&&issue.kind==='cue'&&isLocalAlbumPrivateRelative(issue.relative)&&['ready','failed','unresolved'].includes(String(issue.status))
    ||ownResult(issue,['kind','revision'])&&issue.kind==='name-enhancement-failed'&&dto.isLocalWorkbenchIdentity(issue.revision))
    ||Object.hasOwn(group,'rejectedFiles')&&(!arrayResult(group.rejectedFiles,10000)||!group.rejectedFiles.every(file=>ownResult(file,['relative','revision'])&&isLocalAlbumPrivateRelative(file.relative)&&dto.isLocalWorkbenchIdentity(file.revision))))return false
  return new Set(groupIds).size===groupIds.length&&tracks.size===groupIds.length&&groupIds.every(id=>tracks.has(id))
}
export function isDatasetWorkbenchOwnerRequest(value:unknown):value is DatasetWorkbenchOwnerRequest {
  if(!ownResult(value,['command','payload'])||!DATASET_WORKBENCH_OWNER_COMMANDS.includes(value.command as DatasetWorkbenchOwnerCommand)||!publicDataResult(value))return false
  try{if(datasetWorkbenchJson(value).byteLength>DATASET_WORKBENCH_OWNER_BOUNDS.requestBytes)return false}catch{return false}
  const p=value.payload
  switch(value.command){
    case 'read.albums':return dto.isLocalWorkbenchReadRequest(p)
    case 'read.resolveCapture':case 'artwork.readLocal':return dto.isLocalWorkbenchCommandPayload('localWorkbench.artwork.local',p)
    case 'read.prepareNameSuggestion':return dto.isLocalWorkbenchCommandPayload('localWorkbench.ai.suggest',p)
    case 'read.completeNameSuggestion':return ownResult(p,['preparationId','response'])&&dto.isLocalWorkbenchIdentity(p.preparationId)
      &&ownResult(p.response,['backend','content'])&&['ollama','vllm','cloud'].includes(String(p.response.backend))
      &&typeof p.response.content==='string'&&Buffer.byteLength(p.response.content,'utf8')<=128*1024
    case 'read.prepareNamePreview':return dto.isLocalWorkbenchAiPreviewRequest(p)
    case 'read.prepareArtworkPreview':return ownResult(p,['reference','artwork'])&&dto.isLocalWorkbenchCommandPayload('localWorkbench.artwork.local',p.reference)
      &&isLocalWorkbenchArtworkCapture(p.artwork)&&p.artwork.albumId===p.reference.capture.albumId
    case 'read.cancelNamePreparation':return ownResult(p,['preparationId'])&&dto.isLocalWorkbenchIdentity(p.preparationId)
    case 'registry.issuePlan':return wbPrepared(p)
    case 'registry.apply':case 'registry.readOriginalReceipt':return dto.isLocalWorkbenchApplyRequest(p)
    case 'registry.cancel':return dto.isLocalWorkbenchCommandPayload('localWorkbench.plan.cancel',p)
    case 'registry.getPlan':return ownResult(p,['planId'])&&dto.isLocalWorkbenchIdentity(p.planId)
    case 'registry.readArtworkCapture':return ownResult(p,['datasetId','planId','candidateId'])&&[p.datasetId,p.planId,p.candidateId].every(dto.isLocalWorkbenchIdentity)
    case 'registry.operations':case 'capabilities.read':case 'lifecycle.mainReady':return ownResult(p,[])
    case 'cue.preparePreview':return ownResult(p,['request','target'])&&dto.isLocalCueSplitInput(p.request)&&ownResult(p.target,['target','revision'])
      &&dto.isLocalCueOutputTarget(p.target.target)&&dto.isLocalWorkbenchIdentity(p.target.revision)
      &&p.request.target.choiceId===p.target.target.choiceId&&p.request.target.label===p.target.target.label
    case 'existing.open':return dto.isLocalWorkbenchCommandPayload('localWorkbench.existing.open',p)
  }
  return false
}
export function isDatasetWorkbenchOwnerResult<C extends DatasetWorkbenchOwnerCommand>(command:C,value:unknown,payload:DatasetWorkbenchOwnerPayloads[C],datasetId:string):value is DatasetWorkbenchOwnerResults[C] {
  if(!isDatasetWorkbenchOwnerRequest({command,payload})||!publicDataResult(value))return false
  try{if(datasetWorkbenchJson(value).byteLength>DATASET_WORKBENCH_OWNER_BOUNDS.resultBytes)return false}catch{return false}
  const p:unknown=payload
  switch(command){
    case 'read.albums':return dto.isLocalWorkbenchReadback(value,payload as dto.LocalWorkbenchReadRequest)&&value.datasetId===datasetId
    case 'read.resolveCapture':return wbResolved(value,payload as dto.LocalWorkbenchArtworkRequest,datasetId)
    case 'read.prepareNameSuggestion':return ownResult(value,['preparationId','backend','systemPrompt','userPrompt'])&&dto.isLocalWorkbenchIdentity(value.preparationId)
      &&ownResult(p,['datasetId','capture','backend'])&&value.backend===p.backend&&typeof value.systemPrompt==='string'&&typeof value.userPrompt==='string'
      &&Buffer.byteLength(value.systemPrompt+value.userPrompt,'utf8')<=128*1024
    case 'read.completeNameSuggestion':return ownResult(value,['status','proposal','candidate'])&&value.status==='ready'
      &&ownResult(value.proposal,['candidateId','albumId','captureRevision','readToken','artistName','albumName','reason'])
      &&[value.proposal.candidateId,value.proposal.albumId,value.proposal.captureRevision,value.proposal.readToken].every(dto.isLocalWorkbenchIdentity)
      &&[value.proposal.artistName,value.proposal.albumName,value.proposal.reason].every(v=>dto.isLocalWorkbenchText(v,true))
      &&dto.isLocalAiNameCandidate(value.candidate,value.proposal.albumId as string)&&value.candidate.candidateId===value.proposal.candidateId
      ||ownResult(value,['status','code','publicMessage'])&&(value.status==='unavailable'&&value.code==='INVALID_CAPTURE'||value.status==='failed'&&['MODEL_BUDGET','MODEL_JSON','MODEL_FIELDS','MODEL_INSTRUCTIONS'].includes(String(value.code)))&&dto.isLocalWorkbenchText(value.publicMessage)
    case 'read.prepareNamePreview':return wbPrepared(value,'ai')&&value.capture.datasetId===datasetId
    case 'read.prepareArtworkPreview':return wbPrepared(value,'artwork')&&value.capture.datasetId===datasetId
    case 'cue.preparePreview':return wbPrepared(value,'cue')&&value.capture.datasetId===datasetId
    case 'read.cancelNamePreparation':return typeof value==='boolean'
    case 'registry.issuePlan':return dto.isLocalWorkbenchPlan(value)&&value.datasetId===datasetId&&ownResult(p,['draft','capture'])
      &&isLocalWorkbenchPlanCapture(p.capture)&&value.contextFingerprint===datasetWorkbenchSha(datasetWorkbenchJson(p.capture))
      &&value.kind===(p.draft as LocalWorkbenchPlanDraft).kind
    case 'registry.apply':case 'registry.readOriginalReceipt':return command==='registry.readOriginalReceipt'&&value===null
      ||dto.isLocalWorkbenchReceipt(value,payload as dto.LocalWorkbenchApplyRequest)&&value.datasetId===datasetId
    case 'registry.cancel':return ownResult(p,['original','cancelCommandId'])&&dto.isLocalWorkbenchApplyRequest(p.original)
      &&dto.isLocalWorkbenchReceipt(value,p.original)&&value.datasetId===datasetId
    case 'registry.getPlan':return value===null||dto.isLocalWorkbenchPlan(value)&&value.datasetId===datasetId&&ownResult(p,['planId'])&&value.planId===p.planId
    case 'registry.readArtworkCapture':return value===null||ownResult(value,['datasetId','datasetRevision','planId','planHash','contextFingerprint','capture','artwork'])
      &&value.datasetId===datasetId&&ownResult(p,['datasetId','planId','candidateId'])&&p.datasetId===datasetId&&value.planId===p.planId
      &&dto.isLocalWorkbenchIdentity(value.datasetRevision)&&wbSha(value.planHash)&&wbSha(value.contextFingerprint)&&isLocalWorkbenchAlbumCapture(value.capture)
      &&isLocalWorkbenchArtworkCapture(value.artwork)&&value.artwork.candidateId===p.candidateId&&value.artwork.albumId===value.capture.albumId
    case 'lifecycle.mainReady':return value===true
    case 'registry.operations':return arrayResult(value,512)&&value.every(operation=>dto.isLocalWorkbenchOperation(operation,datasetId))
    case 'capabilities.read':return dto.isLocalWorkbenchCapabilitiesReply(value)
    case 'artwork.readLocal':return dto.isLocalArtworkCommandResult('localArtwork.readCandidates',value)
    case 'existing.open':return dto.isLocalWorkbenchCommandResult('localWorkbench.existing.open',value,payload as dto.LocalWorkbenchExistingRequest)
  }
  return false
}
/** 再核body里的真实dataset；不从capture或target构造grant。 */
export function isDatasetWorkbenchOwnerScope(request:DatasetWorkbenchOwnerRequest,datasetId:string):boolean {
  const p=request.payload
  if('datasetId'in p&&p.datasetId!==datasetId)return false
  if('reference'in p&&p.reference.datasetId!==datasetId)return false
  if('capture'in p&&'datasetId'in p.capture&&p.capture.datasetId!==datasetId)return false
  if('request'in p&&p.request.datasetId!==datasetId)return false
  if('original'in p&&p.original.datasetId!==datasetId)return false
  return true
}


/** 只来自Main已编译metadata；不构成Native资格或SourceFiles授权。 */
export interface DatasetWorkbenchNativeResource {readonly root:string;readonly manifestSha256:string}
export interface DatasetWorkbenchNativeConfiguration {
  readonly cue:Readonly<DatasetWorkbenchNativeResource>|null
  readonly tags:Readonly<DatasetWorkbenchNativeResource>|null
  /** 旧两字段输入只能表示监听未就绪；capture后明确固定null或独立包身份。 */
  readonly watch?:Readonly<DatasetWorkbenchNativeResource>|null
}
function workbenchNativeResource(value:unknown,suffix:string):value is DatasetWorkbenchNativeResource {
  return ownResult(value,['root','manifestSha256'])&&typeof value.root==='string'&&value.root.length>0&&value.root.length<=1024
    &&path.isAbsolute(value.root)&&path.normalize(value.root)===value.root&&!/[\u0000-\u001f\u007f]/u.test(value.root)
    &&value.root.endsWith(suffix)&&wbSha(value.manifestSha256)
}
export function isDatasetWorkbenchNativeConfiguration(value:unknown):value is DatasetWorkbenchNativeConfiguration {
  if(!ownResult(value,['cue','tags'])&&!ownResult(value,['cue','tags','watch']))return false
  if((value.cue!==null&&!workbenchNativeResource(value.cue,'/cue-ffmpeg/darwin-arm64'))
    ||(value.tags!==null&&!workbenchNativeResource(value.tags,'/local-audio-tags/darwin-arm64'))
    ||(Object.hasOwn(value,'watch')&&value.watch!==null&&!workbenchNativeResource(value.watch,'/library-watch/darwin-arm64')))return false
  const resources=[value.cue,value.tags,value.watch??null].filter((item):item is DatasetWorkbenchNativeResource=>item!==null)
  return resources.every(item=>path.dirname(path.dirname(item.root))===path.dirname(path.dirname(resources[0]!.root)))
}
/** 调用前拒未知/隐藏字段，复制后固定，后续caller修改不能替换在途expectedManifest。 */
export function captureDatasetWorkbenchNativeConfiguration(value:unknown):Readonly<DatasetWorkbenchNativeConfiguration> {
  if(!isDatasetWorkbenchNativeConfiguration(value))throw new DatasetWorkbenchWireError('INVALID_IPC_REQUEST','not-sent')
  return Object.freeze({cue:value.cue===null?null:Object.freeze({root:value.cue.root,manifestSha256:value.cue.manifestSha256}),
    tags:value.tags===null?null:Object.freeze({root:value.tags.root,manifestSha256:value.tags.manifestSha256}),
    watch:value.watch==null?null:Object.freeze({root:value.watch.root,manifestSha256:value.watch.manifestSha256})})
}
