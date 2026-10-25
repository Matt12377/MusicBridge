import type { MobileSqlWorkerOptions } from './local-album-browser/mobile-sql-worker.js';
import type { Worker, WorkerOptions } from 'node:worker_threads';
import { createLocalArtworkService } from './local-artwork-service.js';
import { logLibraryOperation, traceLibraryImport, traceLibraryRemoval } from '../shared/library-operation-log.js';
import { createLocalAlbumOwnerRuntime } from './local-album-browser/owner-runtime.js';
import { LocalAlbumReadError } from './local-album-browser/grouping.js';
import type { LocalAlbumLibraryOrganization } from './local-album-browser/sql-types.js';
import { classifyDirectoryName } from '../library/local-name-rules.js';
import { createMobileOwnerService } from '../mobile/owner-service.js';
import { createMobileContentOwnerService } from '../mobile/content-owner-service.js';
import { createMobileOwnerSourceService } from '../mobile/source-service.js';
import { loadMobileDsdConverter } from '../mobile/dsd-converter.js';
import { createMobilePreparedCache } from '../mobile/prepared-cache.js';
import type { MobileDsdDomainOptions, MobilePreparedCache } from '../mobile/prepared-cache-types.js';
import { isMobileOwnerPrivateRequest } from '../mobile/owner-protocol.js';
import {materializeMBEdition,materializeLocalAlbumQueue,materializeLocalSearchQueue} from './mb-queue-materializer.js';
import { createLocalArtistSearchService } from './local-artist-search.js';
import { createArtistMetadataBackfillCoordinator, type ArtistMetadataBackfillCoordinator } from './local-artist-metadata-backfill.js';
import { createLocalSourceTickets } from './local-source-tickets.js';
import {createLocalRelocationCoordinator} from './local-relocation-coordinator.js';
import { createLocalScanCoordinator } from './local-scan-coordinator.js';
import { createLocalSourceReadProjection } from './local-source-read-projection.js';
import { createCompletedScanSnapshotView } from './local-scan-snapshot-view.js';
import { createLocalWorkbenchReadService, createLocalLibraryManagementRuntime, type LocalLibraryManagementRuntime, type LocalLibraryManagementJobPort, type LocalWorkbenchReadContext, type LocalLibraryManagementJobInput } from './local-library-workbench/read-service.js';
import { createLocalWorkbenchMBOnlyWriter, type LocalWorkbenchMBOnlyWriter } from './local-library-workbench/owner-writer.js';
import { createLocalWorkbenchPlanRegistry } from './local-library-workbench/plan-registry.js';
import { createLocalWorkbenchOwnerPersistence } from './local-library-workbench/owner-journal.js';
import { LocalWorkbenchPlanError } from './local-library-workbench/types.js';
import { buildLocalCuePlan, selectLocalCueSourceOutputFormat, isLocalCueSourceOutputPrecisionQualified, type LocalCueSourceEncoding } from './local-library-workbench/cue-plan.js';
import { createLocalCueOutputActor, type LocalCueAuthorizedSource } from './local-cue-output-actor.js';
import { createCueNativeActor, loadBundledCueConverter, type CueInputDemuxer } from '../library/bundled-cue-converter.js';
import { createLocalAudioTagsActor, loadLocalAudioTagsBundle } from '../library/local-audio-tags-actor.js';
import { qualifyCueEightFormats, readCueQualifiedFormats } from '../library/local-cue-format-qualification.js';
import { loadLibraryWatchBundle, createLibraryWatchRegistry, probeLibraryDirectoryStructure, LibraryDirectoryProbeError, type LibraryWatchBundle } from '../library/fsevents-library-monitor.js';
import { createLocalWorkbenchRootLyricsRuntime, type LocalWorkbenchLyricsService } from './local-library-workbench/lyrics-service.js';
import { requestSourceWorkbenchReadersStop } from './source-writes-authority.js';
import type { LocalWorkbenchPlanCapture, LocalWorkbenchProtectedWriter, LocalCueAudioProbe } from './local-library-workbench/types.js';
import type { LocalWorkbenchResolvedReadCapture } from './local-library-workbench/read-service.js';
import type { MetadataReaderPort } from '../library/metadata-reader-types.js';
import { closeRustMediaWorkerPool } from '../library/rust-media-worker.js';
import { runLibraryShutdownStep, type LibraryShutdownStage } from '../shared/library-shutdown-log.js';
import { createRecordingPrintCoordinator } from '../recording/print-coordinator.js';
import { createRecordingReplicaInput } from '../recording/replica-input.js';
import { createReplicaDeviceSessionCoordinator } from '../recording/replica-device-session.js';
import { createReplicaDeviceOutputProvider } from '../recording/replica-device-output-provider.js';
import { createRecordingDeviceSelectionBroker, type RecordingDeviceSelectionBroker } from '../recording/device-selection-broker.js';
import { createNativeReadonlyDeviceCatalog } from '../recording/native-device-catalog.js';
import { createProductionGateBAdmission, type GateBCandidateIdentity, type GateBAdmissionSource } from '../recording/gate-b-admission.js';
import { createFormalDeviceAttemptProvider } from '../recording/formal-device-attempt-provider.js';
import type { PinnedDeviceOutputHelper } from '../recording/bundled-device-output-helper.js';
import type { OutputRunRecoveryState } from '../recording/output-run-recovery.js';
import { createRecordingReplicaCoordinator, type RecordingReplicaCoordinator } from '../recording/replica-coordinator.js';
import { createRecordingRecordCoordinator } from '../recording/record-coordinator.js';
import { createRecordingAttemptCoordinator, type RecordingAttemptCoordinator, type RecordingAttemptAdmissionProvider } from '../recording/attempt-coordinator.js';
import { createRecordingOutputService } from '../recording/output-service.js';
import type { PinnedOutputHelper } from '../recording/bundled-output-helper.js';
import { createRecordingPlanCoordinator } from '../recording/plan-coordinator.js';
import { randomUUID, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, lstat, realpath, mkdir, readdir, opendir, type FileHandle } from 'node:fs/promises';
import { createDatasetCommandBoundary, type DatasetIdentity } from '../recording/dataset-identity.js';
import type { ArchiveContentBinding } from '../recording/backup-package.js';
import { authorizeSourceDirectory, sourceRootAvailability, readonlySourceCandidateMetadata, withReadonlySourcePublicationClaims, createLyricsSourceFilesAuthor, type RootCapability } from '../recording/source-files.js';
import { createBackupCoordinator } from '../recording/backup-coordinator.js';
import { createBackupWorkflowStore, type BackupWorkflowStore } from '../recording/backup-workflow-store.js';
import { createExecutionCoordinator } from '../recording/execution-coordinator.js';
import { createArchiveCoordinator } from '../recording/archive-coordinator.js';
import { assertSourceOutsideArchives } from '../recording/archive-input.js';
import type { FfmpegConverter } from '../recording/audio-converter.js';
import { createPreparedCoordinator } from '../recording/prepared-coordinator.js';
import { createMasterVersionsCoordinator } from '../recording/versions-coordinator.js';
import { createPreparationCoordinator } from '../recording/preparation-coordinator.js';
import { createPreparationZipCoordinator } from '../recording/preparation-export-coordinator.js';
import { createMediaPlanningCoordinator } from '../recording/media-coordinator.js';
import { createSourceEvidenceService } from '../recording/source-evidence.js';
import { createSourceCandidateService } from '../recording/source-candidates.js';
import { createMasterDraftsCoordinator, createProjectedMasterDraftsCoordinator, type MasterDraftsCoordinator } from '../recording/drafts-coordinator.js';
import { createPhysicalLinksCoordinator, createProjectedPhysicalLinksCoordinator, type PhysicalLinksCoordinator, type CollectionRoonProjectionPort } from './physical-links-coordinator.js';

import path from 'node:path';
import { createLocalOrganizerService } from './local-organizer-service.js';
import { createLocalLegacyLinksService } from './local-legacy-links-service.js';
import { createLocalSourceWritesService } from './local-source-writes-service.js';
import { assertSourceWritesMainActor, captureSourceWritesLyricsOriginalEvidence, requestWorkbenchDirectoryApproval, assertSourceWorkbenchDirectoryApproval, invalidateSourceWorkbenchDirectory,
  type SourceWorkbenchDirectoryBinding, type SourceWorkbenchDirectoryUi, type SourceWorkbenchDirectoryOwnerDomain, type SourceWritesMainActor, type SourceWritesLyricsOriginalEvidence } from './source-writes-authority.js';
import { captureLocalLyricsPhysicalBinding, localLyricsPhysicalOperationId, lyricsPhysicalDigest, createLyricsNativeFidelityPort, type LyricsNativeFidelityPort, type LocalLyricsPhysicalBinding } from '../library/lyrics-source-format.js';
import { LocalLyricsError, type LocalLyricsSaveRecord } from './local-library-lyrics/types.js';
import { assertLocalLyricsSaveRecord } from './local-library-lyrics/save-coordinator.js';
import { sourceWritesPolicy } from './local-source-writes-journal.js';
import { createLocalRelocationService } from './local-relocation-service.js';
import type { IpcRequest } from '@music-bridge/contracts';
import * as workbenchDto from '@music-bridge/contracts';
import { createCollectionRepository, type CollectionRepository, CollectionError } from './repository.js';
import { createRoonPublicLibrary, type RoonPublicLibrary } from '../roon/public-library.js';
import { openCollectionDataset } from '../recording/restore-dataset-runtime.js';
import { reconcileOutputRunRecovery } from '../recording/output-run-recovery.js';
import { failureForError } from '../shared/ipc-failure.js';
import { dispatchDatasetCommand, dispatchInternalDatasetCommand, dispatchLocalAlbumRead } from './dataset-dispatch.js';
import type { DatasetServices } from './dataset-services.js';
import { DatasetWorkbenchWireError, isDatasetWorkbenchOwnerRequest, isDatasetWorkbenchOwnerResult, isDatasetWorkbenchRequest, isDatasetWorkbenchResult, datasetWorkbenchJson, datasetWorkbenchSha,
    datasetNameOriginalStartSha256, DATASET_NAME_PROVIDER_CONTENT_BYTES, DatasetNameProviderBridgeError, type DatasetWorkbenchRequest, type DatasetWorkbenchResult, type DatasetWorkbenchExecutionContext, type DatasetWorkbenchOwnerRequest, type DatasetWorkbenchOwnerResult, type DatasetProjectionPort, type DatasetProjectionTicket, type OwnedDatasetDomain, type DatasetWorkbenchNativeConfiguration } from './dataset-owner-protocol.js';

const ARTIST_INTERACTION_QUIET_MS = 5000;
const artistInteractiveCommands = new Set<IpcRequest['command']>([
  'localArtist.list', 'localArtist.get', 'localArtist.albums', 'localArtist.tracks', 'localArtist.search',
]);

export interface DatasetDomainOptions {
  mobileSqlWorker?: MobileSqlWorkerOptions;
  /** 可信Owner的单向只读撤销；不参与Source许可或写事务核验。 */
  assertAlbumReadActive?(): void;
  /** 仅可信桌面 Owner 组合开启；通用领域工厂继续使用旧两槽。 */
  localScanReadProfile?: 'bulk-v2';
  sourceWritesMainActor?: SourceWritesMainActor;
  mobileDsd?: MobileDsdDomainOptions;
  localWorkbenchNative?: DatasetWorkbenchNativeConfiguration;
  localSourceEpoch?: string;
  /** 仅本机可重建派生索引；生产工厂按实际DatasetIdentity隔离。 */
  artistSearchDirectory?: string | null;
  collectionRepository: CollectionRepository;
  backupWorkflowStore: BackupWorkflowStore;
  collectionDatasetIdentity?: DatasetIdentity;
  backupPrivateRoot?: RootCapability;
  backupContentBinding?: ArchiveContentBinding;
  recordingConverter?: FfmpegConverter;
  recordingOutputHelper?: PinnedOutputHelper;
  recordingDeviceOutputHelper?: PinnedDeviceOutputHelper;
  recordingGateBCandidate?: GateBCandidateIdentity | null;
  recordingLeaseDatabaseFile?: string;
  recordingOutputRunRecovery?: OutputRunRecoveryState;
  roonLibrary?: RoonPublicLibrary;
  projection?: DatasetProjectionPort;
  commitBoot?: () => void | Promise<void>;
  /** 仅同线程 Owner 工厂提供；后台准备失败沿原 fatal 通道封入口并收束，不进入公开协议。 */
  onBackgroundFatal?: () => void;
  closeConnections?: () => void;
  failureForError?: typeof failureForError;
}
export interface TestDatasetDomainOptions extends Partial<Omit<DatasetDomainOptions, 'projection'>> {
  scanMetadataReader?: MetadataReaderPort;
  /** 合成注入仅供明确测试工厂；生产工厂没有这些字段。 */
  recordingAttemptAdmissionProvider?: RecordingAttemptAdmissionProvider;
  recordingPlanDeviceSelection?: RecordingDeviceSelectionBroker;
  recordingPlanGateB?: GateBAdmissionSource;
}
export interface DatasetDomain extends OwnedDatasetDomain, DatasetServices, SourceWorkbenchDirectoryOwnerDomain {
  /** 原prepare/ACK前的有限工作台恢复与Native工厂，不是公共命令。 */
  prepareWorkbench():Promise<void>;
}
export type TestDatasetDomain = Omit<DatasetDomain, 'physicalLinks' | 'masterDrafts'> & {
  physicalLinks: PhysicalLinksCoordinator; masterDrafts: MasterDraftsCoordinator;
};

/** 票据跨线程，事务回调留在owner；许可期间没有异步数据库事务或第二读取连接。 */
export function createCollectionRoonProjectionPort(port: DatasetProjectionPort, assertCurrent: () => void): CollectionRoonProjectionPort {
  async function consume<T, U>(ticket: DatasetProjectionTicket<T>, operation: (metadata: T) => U): Promise<U> {
    assertCurrent();
    const permit = await port.call('acquirePermit', { scope: ticket.scope, projectionId: ticket.projectionId });
    try {
      assertCurrent();
      if (permit.scope !== ticket.scope || permit.projectionId !== ticket.projectionId) throw new CollectionError('INVENTORY_UNAVAILABLE', '媒体库许可身份不一致。');
      // 协调器只传同步本地消费；这里不得把Promise带入SQLite事务。
      return operation(ticket.metadata);
    } finally {
      await port.call('releasePermit', permit);
    }
  }
  return {
    async projectAlbum(reference, operation) { assertCurrent(); return consume(await port.call('captureAlbumMetadata', { reference }), operation); },
    async projectTracks(references, operation) { assertCurrent(); return consume(await port.call('captureTrackMetadataBatch', { references }), operation); },
    async browseAlbumCandidates(query, page) { assertCurrent(); const result = await port.call('browseAlbumCandidates', { query, page }); assertCurrent(); return result; },
  };
}

function composeDatasetDomain(options: DatasetDomainOptions, test?: TestDatasetDomainOptions, mobilePreparedCache?: MobilePreparedCache): DatasetDomain {
  if (options.mobileDsd && !mobilePreparedCache) throw new Error('DSD 后端必须经唯一 Owner 异步准备工厂取得真实资格。');
  const collection = options.collectionRepository, maintenance = options.backupWorkflowStore;
  const identity = options.collectionDatasetIdentity ?? { datasetId: randomUUID(), assertCurrent: () => { collection.list({ offset: 0, limit: 1 }); } };
  const commandOutbox = createDatasetCommandBoundary(identity);
  let closing = false, closed: Promise<void> | undefined;
  const assertDataset = () => identity.assertCurrent();
  const assertOpen = () => { if (closing) throw new CollectionError('INVENTORY_UNAVAILABLE', '工作库正在关闭，请重新读取当前状态。'); assertDataset(); };
  const sourceReads = options.projection ? createLocalSourceReadProjection({ projection: options.projection, assertCurrent: assertDataset,
    concurrency: options.localScanReadProfile === 'bulk-v2' ? 8 : 2 }) : undefined;
  const sourceProjection = sourceReads?.port;
  const pendingDispatches = new Set<Promise<unknown>>();
  let artistInteractionQuietUntil = 0;
  // 仅实际持久DatasetIdentity安装设置作者；测试旧工厂的临时UUID不能取得新账本许可。
  if(options.collectionDatasetIdentity) collection.localCatalog.privateBindWorkbenchDataset(options.collectionDatasetIdentity);
  const scanSettings=options.collectionDatasetIdentity?collection.localCatalog.privateScanSettingsStore(options.collectionDatasetIdentity):undefined;
  const completedScanSnapshots=options.collectionDatasetIdentity?createCompletedScanSnapshotView({repository:collection,identity:options.collectionDatasetIdentity}):undefined;
  let scanBootReady=!options.commitBoot;
  let mobileWarmPending = false, mobileWarmFailed = false;
  let mobileWarmFlight: Promise<void> | undefined;
  let notifyArtworkBatch: (rootId: string, sourceRevision: string) => void = () => {};
  let artistBackfill: ArtistMetadataBackfillCoordinator | undefined;
  let artistMainReady = false;
  const mobileOwnerEpoch = options.localSourceEpoch ?? randomUUID();
  const localTickets = createLocalSourceTickets(collection, options.localSourceEpoch ?? randomUUID(), identity.datasetId, () => { assertOpen(); if (!scanBootReady) throw new Error('本地事实Owner尚未boot。'); });
  const localScan=createLocalScanCoordinator({repository:collection,datasetId:identity.datasetId,assertCurrent:assertDataset,dsdMetadataEnabled:mobilePreparedCache?.qualified === true,cueInputMetadataEnabled:options.localWorkbenchNative?.cue !== null && options.localWorkbenchNative?.cue !== undefined,assertReady:()=>{if(!scanBootReady) throw new CollectionError('INVENTORY_UNAVAILABLE','扫描owner尚未commitBoot。');},
    ...(options.localScanReadProfile ? {localScanReadProfile:options.localScanReadProfile}:{}),
    onCommitted:job=>{if(!closing)notifyArtworkBatch(job.libraryRootId,`${job.jobId}:${job.phase==='completed'?'completed':'scanning'}`);},
    ...(scanSettings?{identity:options.collectionDatasetIdentity!,settings:scanSettings}:{}),
    ...(completedScanSnapshots?{onCompleted:async(job,context)=>{
      if(context?.retry){completedScanSnapshots.retry(job.jobId);return;}
      completedScanSnapshots.captureCompleted(job.jobId);
      await recoverArtistMetadataAfterScan(job);
    }}:{}),
    ...(sourceProjection ? {projection:sourceProjection}:{}),...(test?.scanMetadataReader ? {reader:test.scanMetadataReader}:{})});
  /** 原目录操作command关联一次扫描；旧回执只查询当前job，不重放parser或恢复旧运行。 */
  async function startInitialLibraryScan(commandId:string,root:Readonly<workbenchDto.LibraryRoot>):Promise<void>{
    assertOpen();if(!workbenchDto.isCollectionId(commandId)||!workbenchDto.isLibraryRoot(root)||root.role!=='library')throw new LocalWorkbenchPlanError('CHANGED','目录扫描的原操作或Root身份无效。');
    root=Object.freeze({...root});
    let receipt=localScan.receipt(commandId);
    if(!receipt){
      const source=collection.sources.root(root.sourceRootId);
      const checkNew=()=>{
        assertOpen();const current=collection.localCatalog.root(root.id),actual=collection.sources.root(root.sourceRootId);
        if(!scanBootReady||current.role!=='library'||current.sourceRootId!==root.sourceRootId||current.revision!==root.revision
          ||!collection.localCatalog.privateLibraryManagementRootAvailable(root.id)||!source.authorized||!actual.authorized
          ||actual.id!==source.id||actual.path!==source.path||actual.dev!==source.dev||actual.ino!==source.ino)
          throw new LocalWorkbenchPlanError('CHANGED','目录扫描的原库修订、来源许可或撤库状态已改变。');
      };
      checkNew();if(await sourceRootAvailability(source)!=='ONLINE')throw new LocalWorkbenchPlanError('CHANGED','目录扫描的原来源尚未在线，原Root与命令保留。');checkNew();
      receipt=localScan.receipt(commandId);
      if(!receipt){localScan.start({commandId,libraryRootId:root.id,expectedRootRevision:root.revision});receipt=localScan.receipt(commandId);}
    }
    if(!receipt||receipt.operation!=='start'||receipt.commandId!==commandId||receipt.result.datasetId!==identity.datasetId
      ||receipt.result.libraryRootId!==root.id||receipt.result.sourceRootId!==root.sourceRootId||receipt.result.rootRevision!==root.revision)
      throw new LocalWorkbenchPlanError('CHANGED','原目录扫描回执不属于同一操作与Root。');
    const current=localScan.get(receipt.jobId);
    if(current.jobId!==receipt.jobId||current.datasetId!==identity.datasetId||current.libraryRootId!==root.id
      ||current.sourceRootId!==root.sourceRootId||current.rootRevision!==root.revision)
      throw new LocalWorkbenchPlanError('CHANGED','原目录扫描任务身份已改变，不能创建替代任务。');
  }
  // BackupCoordinator仍使用唯一原store的方法与事务；其close只提出关闭请求。
  // domain必须等录音清理、激活/文件回调及在途dispatch收口后，才真正关闭维护库连接。
  const maintenanceForCoordinator: BackupWorkflowStore = { ...maintenance, close() {} };
  const localRelocation=createLocalRelocationCoordinator({repository:collection,assertCurrent:assertDataset,assertReady:()=>{if(!scanBootReady)throw new CollectionError('INVENTORY_UNAVAILABLE','owner尚未commitBoot。');},beforeMutation:()=>localScan.yieldForMedia(),onRegistered:(request,root)=>startInitialLibraryScan(request.commandId,root),onRelinked:async(request,root)=>{if(root.role==='library')await startInitialLibraryScan(request.commandId,root);}});
  const localArtwork = createLocalArtworkService({ repository: collection, assertCurrent: assertOpen, ...(sourceProjection ? { projection: sourceProjection } : {}) });
  const albumReadActive = options.assertAlbumReadActive
  const albumRuntime = createLocalAlbumOwnerRuntime({ repository: collection,
    ...(options.mobileSqlWorker ? { mobileSqlWorker: options.mobileSqlWorker } : {}), ...(options.collectionDatasetIdentity ? { datasetId: identity.datasetId } : {}), ...(sourceProjection ? { projection: sourceProjection } : {}),
    ...(options.assertAlbumReadActive ? { assertReadActive: options.assertAlbumReadActive } : {}),
    lyricsInventory:{revision:()=>collection.localCatalog.privateLyricsInventoryRevision(identity.datasetId),
      read:(trackId,rootId,fileRevision)=>collection.localCatalog.privateLyricsInventoryRead(identity.datasetId,trackId,rootId,fileRevision),
      ...(options.collectionDatasetIdentity && albumReadActive ? { withRead: <T>(read: () => T): T => collection.localCatalog.privateWithLyricsInventoryRead(identity.datasetId, read, () => {
        if (closing || !scanBootReady || options.assertAlbumReadActive !== albumReadActive) throw new CollectionError('INVENTORY_UNAVAILABLE', '歌词库存原Owner已停止或读取作者已变化。')
        albumReadActive()
      }) } : {})},
    assertCurrent: () => { assertOpen(); if (!scanBootReady) throw new CollectionError('INVENTORY_UNAVAILABLE', '本地专辑 Owner 尚未 commitBoot。'); },
    readRootViews: () => localRelocation.roots(),
    ...(options.collectionDatasetIdentity ? { readLibraryOrganizations } : {}) });
  notifyArtworkBatch = (rootId, sourceRevision) => albumRuntime.background?.notifyChanged(rootId, sourceRevision);
  const artistCurrent = () => { assertDataset(); if (!scanBootReady) throw new CollectionError('INVENTORY_UNAVAILABLE', '本地艺人 Owner 尚未 commitBoot。'); };
  const localArtists = createLocalArtistSearchService({ collection, localAlbums: albumRuntime.localAlbums,
    directory: options.artistSearchDirectory ?? null, assertCurrent: artistCurrent,
    // 交互查询先等待当前补读FD安全退出，避免自己追加的观察打断原分页快照。
    beforeRefresh: async () => { await artistBackfill?.suspend(); },
    // resume只归还临时借用；自动启动仍只由本代Main-ready设置，人工暂停保持。
    afterRefresh: () => { if(!closing && !workbenchLife.signal.aborted)artistBackfill?.resume(); } });
  artistBackfill = options.collectionDatasetIdentity && options.projection && !test ? createArtistMetadataBackfillCoordinator({
    collection, directory: options.artistSearchDirectory ?? null, assertCurrent: artistCurrent,
    // PREPARING 已结束本次 dispatch，客户端仍会重试；保留这段间隔，避免索引刚完成就被补读再次推进水位。
    isBusy: () => mobileWarmPending || pendingDispatches.size > 0 || localArtists.preparing || performance.now() < artistInteractionQuietUntil || albumRuntime.isPlaybackBusy(),
    read: (candidate, signal) => localScan.privateReadArtistMetadata(candidate, signal),
    onState: state => logLibraryOperation('library', 'artists.metadata-backfill', state.phase === 'needs-attention' ? 'error' : 'complete',
      { code: state.phase.toUpperCase().replaceAll('-', '_'), count: state.succeeded, total: state.succeeded + state.failed + state.pending }),
  }) : undefined;
  function startMobilePreparation(): void {
    if (mobileWarmFlight) return;
    mobileWarmPending = true;
    const started = performance.now();
    logLibraryOperation('library', 'startup.mobile-prepare', 'start');
    mobileWarmFlight = Promise.resolve().then(async () => {
      await albumRuntime.localAlbums.privateMobile.prepare!();
      assertOpen();
      // 自动恢复仍在独立准备完成后启动，避免本代启动自己推进准备快照。
      if (options.collectionDatasetIdentity && options.projection) localScan.privateStartRecovery();
      logLibraryOperation('library', 'startup.mobile-prepare', 'complete', { elapsedMs: performance.now() - started });
    }).catch(error => {
      mobileWarmFailed = true;
      logLibraryOperation('library', 'startup.mobile-prepare', closing ? 'cancelled' : 'error',
        { code: error instanceof LocalAlbumReadError ? error.code : 'UNAVAILABLE', elapsedMs: performance.now() - started });
      if (!closing) options.onBackgroundFatal!();
    }).finally(() => { mobileWarmPending = false; });
    // close 先经 owner.albums 取消并等待实际 Actor，再经 owner.dispatches 收齐本任务。
    pendingDispatches.add(mobileWarmFlight);
    void mobileWarmFlight.then(() => pendingDispatches.delete(mobileWarmFlight!), () => pendingDispatches.delete(mobileWarmFlight!));
  }
  async function recoverArtistMetadataAfterScan(job: Readonly<workbenchDto.ScanJobRecord>): Promise<void> {
    if (!artistBackfill || closing || workbenchLife.signal.aborted) return;
    assertOpen();
    const recovered = structuredClone(job), root = collection.localCatalog.root(job.libraryRootId);
    const source = collection.sources.root(job.sourceRootId);
    const checkRecovered = () => {
      assertOpen();
      const current = localScan.get(recovered.jobId), actual = collection.localCatalog.root(recovered.libraryRootId);
      const currentSource = collection.sources.root(recovered.sourceRootId);
      if (!scanBootReady || workbenchLife.signal.aborted || recovered.phase !== 'completed'
        || recovered.datasetId !== identity.datasetId || current.phase !== 'completed' || current.jobRevision !== recovered.jobRevision
        || current.datasetId !== recovered.datasetId || current.libraryRootId !== recovered.libraryRootId
        || current.sourceRootId !== recovered.sourceRootId || current.rootRevision !== recovered.rootRevision
        || actual.role !== 'library' || actual.id !== root.id || actual.revision !== recovered.rootRevision
        || actual.sourceRootId !== recovered.sourceRootId || !collection.localCatalog.privateLibraryManagementRootAvailable(actual.id)
        || !source.authorized || !currentSource.authorized || currentSource.id !== source.id
        || currentSource.path !== source.path || currentSource.dev !== source.dev || currentSource.ino !== source.ino)
        throw new LocalWorkbenchPlanError('CHANGED','完成扫描的原Owner、有效库或来源身份已改变，补读不自动恢复。');
    };
    checkRecovered();
    if (await sourceRootAvailability(source) !== 'ONLINE') return;
    checkRecovered();
    await artistBackfill.recoverAfterScan(recovered, checkRecovered);
  }
  const mobileOwner = createMobileOwnerService({ collection, datasetId: identity.datasetId, ownerEpoch: mobileOwnerEpoch,
    localAlbums: albumRuntime.localAlbums, isPlaybackBusy: albumRuntime.isPlaybackBusy, dsdToPcmAvailable:()=>mobilePreparedCache?.qualified === true,
    assertCurrent: () => { assertOpen(); if (!scanBootReady) throw new CollectionError('INVENTORY_UNAVAILABLE', '移动 Owner 尚未 commitBoot。'); } });
  const dispatchMobileOwner: typeof mobileOwner.dispatch = async request => {
    if ((mobileWarmPending || mobileWarmFailed) && (request.kind === 'catalog' || request.kind === 'catalog-selected')
      && isMobileOwnerPrivateRequest(request) && request.datasetId === identity.datasetId) {
      assertOpen();
      // 顶层与内容服务嵌套目录共用准备状态；致命失败仍交原 BUSY/fatal 路径处理。
      return { kind: 'mobile-error', status: 503,
        code: mobileWarmPending ? 'ARTIST_INDEX_PREPARING' : 'BUSY', retryable: false, outcome: null };
    }
    return mobileOwner.dispatch(request);
  };
  // 内容复用同一 Owner 的隔离目录读取；同步提交围栏只取原投影修订，不重查目录页。
  const mobileContent = createMobileContentOwnerService({ collection, datasetId: identity.datasetId, ownerEpoch: mobileOwnerEpoch,
    catalog: { dispatch: dispatchMobileOwner, catalogRevision: mobileOwner.catalogRevision, refresh: mobileOwner.refreshCatalog }, limits: { stateBytes: 16 * 1024 * 1024, receipts: 1024, albums: 10000,
      favoriteTracks: 100000, playlists: 10000, playlistTracks: 100000 },
    assertCurrent: () => { assertOpen(); if (!scanBootReady) throw new CollectionError('INVENTORY_UNAVAILABLE', '内容 Owner 尚未 commitBoot。'); } });
  const mobileSources = createMobileOwnerSourceService({ collection, tickets: localTickets, datasetId: identity.datasetId,
    localAlbums: albumRuntime.localAlbums, beginActivity: albumRuntime.beginMobilePlaybackActivity, ...(mobilePreparedCache ? { preparedCache: mobilePreparedCache } : {}),
    ownerEpoch: options.localSourceEpoch ?? randomUUID(), assertCurrent: () => {
      assertOpen(); if (!scanBootReady) throw new CollectionError('INVENTORY_UNAVAILABLE', '移动源 Owner 尚未 commitBoot。');
    } });
  function readLibraryOrganizations(): readonly LocalAlbumLibraryOrganization[] {
    assertOpen(); const result = collection.localCatalog.privateLibraryManagementOrganizations(identity);
    assertOpen(); return result;
  }
  // 工作台复用本次真正的Owner、catalog、扫描与专辑作者，不从UUID或公开DTO补造身份。
  let workbenchWriter: LocalWorkbenchMBOnlyWriter | undefined;
  let cueNative:ReturnType<typeof createCueNativeActor>|undefined,cueTags:ReturnType<typeof createLocalAudioTagsActor>|undefined;
  let cueQualification:Awaited<ReturnType<typeof qualifyCueEightFormats>>|undefined,cueActor:ReturnType<typeof createLocalCueOutputActor>|undefined;
  let lyricsNative:LyricsNativeFidelityPort|undefined,lyricsTags:ReturnType<typeof createLocalAudioTagsActor>|undefined;
  let lyricsRuntime:ReturnType<typeof createLocalWorkbenchRootLyricsRuntime>|undefined;
  let libraryManagement:LocalLibraryManagementRuntime|undefined;
  let libraryWatch:ReturnType<typeof createLibraryWatchRegistry>|undefined;
  let directoryStructureBundle:LibraryWatchBundle|undefined;
  // 仅真实Owner派发对象持有期限；公开正文或普通ReadContext不能创建目录批准上下文。
  const managementContexts=new WeakMap<LocalWorkbenchReadContext,DatasetWorkbenchExecutionContext>();
  const directoryClosures=new Map<string,Promise<void>>();
  const nameOperations=new Map<string,{jobId:string;albumId:string;operationId:string;preparationId:string;joined:boolean;done:Promise<{backend:workbenchDto.LocalAiBackend;content:string}>}>();
  const jobAttempts=new Map<string,{jobId:string;albumId:string;request:workbenchDto.LocalWorkbenchApplyRequest}>();

  let workbenchPreparation:Promise<void>|undefined,workbenchRecoveryFailure:unknown=null;
  const approvedDirectories=new Map<string,{binding:SourceWorkbenchDirectoryBinding;root:RootCapability;fd:FileHandle;approval:Awaited<ReturnType<typeof requestWorkbenchDirectoryApproval>>;ui:SourceWorkbenchDirectoryUi;active:boolean;ownerClosed:boolean;suggestion?:workbenchDto.LocalLibraryImportChoice}>();
  const roleProbeFds=new Set<FileHandle>(),roleProbeFlights=new Set<Promise<workbenchDto.LocalLibraryImportChoice>>();
  const roleProbeTasks=new Map<string,{controller:AbortController;work:Promise<workbenchDto.LocalLibraryImportChoice>}>(),roleProbeUnknown=new Map<string,LibraryDirectoryProbeError>();
  const cueSources=new Map<string,{source:LocalCueAuthorizedSource;probe:LocalCueAudioProbe;rootId:string}>();
  const cuePreparationLives=new Map<string,{roots:readonly string[];controller:AbortController;done:Promise<unknown>}>();
  const cuePreparations=new Map<string,Promise<{draft:Extract<import('./local-library-workbench/types.js').LocalWorkbenchPlanDraft,{kind:'cue'}>;capture:LocalWorkbenchPlanCapture}>>();
  const workbenchLife=new AbortController();
  const workbenchRead = options.collectionDatasetIdentity ? createLocalWorkbenchReadService({
    datasetId: identity.datasetId, repository: collection, localAlbums: albumRuntime.localAlbums,
    assertCurrent: () => { assertOpen(); if (!scanBootReady) throw new CollectionError('INVENTORY_UNAVAILABLE', '工作台 Owner 尚未 commitBoot。'); },
    readRootViews: () => localRelocation.roots(),
    readNameSources: fact => { if (!workbenchWriter) throw new LocalWorkbenchPlanError('CHANGED', '原字段作者尚未就绪。'); return workbenchWriter.readNameSources(fact); },
    readAuthorRevision: () => { if (!workbenchWriter) throw new LocalWorkbenchPlanError('CHANGED', '原字段作者尚未就绪。');
      return workbenchWriter.readAuthorRevision(); },
    readLibraryOrganizations,
    async readCurrentArtwork(group, context) {
      const request: workbenchDto.LocalAlbumArtworkRequest = { albumKey: group.summary.id, rootId: group.summary.rootId,
        editionId: group.summary.editionId, representativeTrackId: group.summary.representativeTrackId, revision: group.summary.revision };
      const source = await albumRuntime.artwork.readSources({ request, context: { album: group.summary, directory: group.directory, representative: group.members.find(member => member.fact.hasArtwork)?.fact ?? group.members.find(member => member.fact.summary.track.id === group.summary.representativeTrackId)?.fact ?? null } }, randomUUID(), context.signal, (context as LocalWorkbenchReadContext & { deadlineAtMs?: number }).deadlineAtMs, 'display');
      if (source.image) return source.image;
      if (source.copies.status !== 'ready' || !source.copies.items.length || !options.projection) return null;
      const originalRead=context as LocalWorkbenchReadContext&{deadlineAtMs?:number};
      const normalized = await options.projection.call('normalizeLocalAlbumArtwork', { copies: source.copies }, {
        ...(originalRead.signal === undefined ? {} : {signal:originalRead.signal}),
        ...(originalRead.deadlineAtMs === undefined ? {} : {deadlineAtMs:originalRead.deadlineAtMs}),
      });
      assertOpen(); return normalized.image;
    },
  }) : undefined;
  if (workbenchRead) workbenchWriter = createLocalWorkbenchMBOnlyWriter({ identity: options.collectionDatasetIdentity!, catalog: collection.localCatalog, read: workbenchRead, assertAccepting: assertOpen });
  const workbenchProtectedWriter:LocalWorkbenchProtectedWriter={
    async revalidate(capture,plan){
      if(plan.kind!=='cue')return workbenchWriter!.writer.revalidate(capture,plan);
      if(!cueActor)return {valid:false,reason:'CUE尚未取得当前真实Native和原独立目录许可。'};
      try{await revalidateCueCapture(capture);return {valid:true};}catch{return {valid:false,reason:'原CUE完整捕获或独立目录许可已变化。'};}
    },
    async apply(request,plan,capture){
      if(plan.kind!=='cue')return workbenchWriter!.writer.apply(request,plan,capture);
      if(!cueActor)throw new LocalWorkbenchPlanError('UNQUALIFIED_FORMAT','CUE尚未取得当前真实Native作者。');
      return cueActor.apply(request,plan,structuredClone(capture));
    },
    async readOriginalReceipt(request){
      const stored=collection.localCatalog.privateWorkbenchSnapshot(identity.datasetId),plan=stored?.entries.find(value=>value.plan.planId===request.planId)?.plan;
      if(plan?.kind==='cue'){
        const receipt=cueActor?await cueActor.readOriginal(request):collection.localCatalog.privateCueOutputRead(identity,request.commandId)?.record.receipt??null;
        if(receipt!==null&&!workbenchDto.isLocalWorkbenchReceipt(receipt))throw new LocalWorkbenchPlanError('CHANGED','原CUE回执不符合实际合同。');
        return receipt;
      }
      return workbenchWriter!.writer.readOriginalReceipt(request);
    },
    async cancel(request){
      const entry=collection.localCatalog.privateWorkbenchSnapshot(identity.datasetId)?.entries.find(value=>value.plan.planId===request.original.planId);
      if(entry?.plan.kind!=='cue'||!cueActor)throw new LocalWorkbenchPlanError('CANCEL_UNAVAILABLE','该原操作没有可取消的实际Native任务。');
      return cueActor.cancel(structuredClone(request));
    },
  };
  const workbenchRegistry = workbenchWriter ? createLocalWorkbenchPlanRegistry({ datasetId: identity.datasetId,
    persistence: createLocalWorkbenchOwnerPersistence(identity.datasetId, collection.localCatalog), writer: workbenchProtectedWriter }) : undefined;
  // 冷账本读取立即登记拒绝处理；稍后的实际请求仍会回取原失败，不吞掉或替换坏库。
  void workbenchRegistry?.catch(() => {});
  let workbenchClose: Promise<void> | undefined;
  function assertWorkbench(context?: DatasetWorkbenchExecutionContext): void {
    assertOpen();
    if (!options.collectionDatasetIdentity || !workbenchRead || !workbenchRegistry || !scanBootReady || !workbenchDto.isCollectionId(options.localSourceEpoch))
      throw new CollectionError('INVENTORY_UNAVAILABLE', '当前真实工作台 Owner 尚未就绪。');
    if (context && (context.identity.datasetId !== identity.datasetId || context.identity.epoch !== options.localSourceEpoch
      || context.signal.aborted || performance.now() >= context.deadlineAtMs))
      throw new CollectionError('INVENTORY_UNAVAILABLE', '工作台原作者身份或本次期限已失效。');
  }
  function trackWorkbench<T>(context: DatasetWorkbenchExecutionContext, run: () => Promise<T>): Promise<T> {
    assertWorkbench(context); const pending = Promise.resolve().then(run).then(result => { assertWorkbench(context); return result; });
    pendingDispatches.add(pending); return pending.finally(() => pendingDispatches.delete(pending));
  }
  function directoryContext(context:{identity:{epoch:string;datasetId:string};mainActor:SourceWritesMainActor;signal:AbortSignal;deadlineAtMs:number},cleanup=false):void {
    assertDataset();if(!cleanup)assertWorkbench();
    if(context.mainActor!==options.sourceWritesMainActor||context.identity.datasetId!==identity.datasetId||context.identity.epoch!==options.localSourceEpoch
      ||context.signal.aborted||performance.now()>=context.deadlineAtMs)throw new LocalWorkbenchPlanError('CHANGED','原目录作者或期限已失效。');
    assertSourceWritesMainActor(context.mainActor);
  }
  function independentCueRoot(root:RootCapability):void {
    for(const source of collection.sources.roots().filter(value=>value.authorized)){
      const a=path.relative(source.path,root.path),b=path.relative(root.path,source.path);
      if(root.dev===source.dev&&root.ino===source.ino||a===''||b===''||!a.startsWith('..'+path.sep)&&a!=='..'&&!path.isAbsolute(a)
        ||!b.startsWith('..'+path.sep)&&b!=='..'&&!path.isAbsolute(b))throw new LocalWorkbenchPlanError('CHANGED','CUE目标必须独立于全部原音乐目录。');
    }
  }
  async function assertDirectory(entry:typeof approvedDirectories extends Map<string,infer V>?V:never,physical:import('./source-writes-authority.js').SourceWorkbenchDirectoryPhysical):Promise<void>{
    const fd=await entry.fd.stat({bigint:true}),named=await lstat(entry.root.path,{bigint:true});
    if(!fd.isDirectory()||named.isSymbolicLink()||!named.isDirectory()||await realpath(entry.root.path)!==entry.root.path
      ||(['dev','ino','birthtimeNs','mode','uid','gid'] as const).some(key=>String(fd[key])!==physical[key==='birthtimeNs'?'birthtimeNs':key]||fd[key]!==named[key]))
      throw new LocalWorkbenchPlanError('CHANGED','原目录FD或物理身份已变化。');
    if(entry.root.dev!==String(fd.dev)||entry.root.ino!==String(fd.ino))throw new LocalWorkbenchPlanError('CHANGED','原目录绑定已变化。');
    if(entry.binding.kind==='cue')independentCueRoot(entry.root);
  }
  // 只探测同一原目录FD的两层直接结构；有限建议不是扫描、登记或Source许可。
  async function suggestLibraryDirectory(entry:typeof approvedDirectories extends Map<string,infer V>?V:never,
    context:{signal:AbortSignal;deadlineAtMs:number}):Promise<workbenchDto.LocalLibraryImportChoice> {
    const current = () => { assertWorkbench(); if (!entry.active || entry.ownerClosed || context.signal.aborted
      || performance.now() >= context.deadlineAtMs) throw new LocalWorkbenchPlanError('CHANGED','原目录角色探测已取消或过期。'); };
    const step=async<T>(run:()=>Promise<T>):Promise<T>=>{current();const value=await run();current();return value;};
    const physical = assertSourceWorkbenchDirectoryApproval(entry.approval, options.sourceWritesMainActor!, entry.binding, entry.ui);
    const unchanged=(before:import('node:fs').BigIntStats,after:import('node:fs').BigIntStats):boolean=>
      after.isDirectory()&&!after.isSymbolicLink()&&(['dev','ino','birthtimeNs','mode','uid','gid'] as const).every(key=>before[key]===after[key]);
    async function rootCurrent():Promise<void>{
      const fd=await step(()=>entry.fd.stat({bigint:true})),named=await step(()=>lstat(entry.root.path,{bigint:true})),canonical=await step(()=>realpath(entry.root.path));
      if(!fd.isDirectory()||!unchanged(fd,named)||canonical!==entry.root.path
        ||(['dev','ino','birthtimeNs','mode','uid','gid'] as const).some(key=>String(fd[key])!==physical[key])
        ||entry.root.dev!==String(fd.dev)||entry.root.ino!==String(fd.ino))
        throw new LocalWorkbenchPlanError('CHANGED','原角色探测目录FD或物理身份已变化。');
    }
    await rootCurrent();current();
    const accepts = (name:string) => /\.(flac|mp3|m4a|mp4|aac|wav|wave|aif|aiff)$/iu.test(name)
      || mobilePreparedCache?.qualified === true && /\.(dsf|dff)$/iu.test(name)
      || options.localWorkbenchNative?.cue != null && /\.(ogg|oga|opus|wv|ape|tta|mpc|mpp|mp\+|tak)$/iu.test(name);
    if(process.platform==='darwin'){
      if(!directoryStructureBundle)return {choiceId:entry.binding.choiceId,label:entry.root.label,suggestedRole:'catalog',
        evidence:['已核验原Main选择对象及实际Owner目录FD。','当前未安装同代FD结构后端；请手动确认四种目录角色，本次未作结构推断。']};
      try{
        const probe=await probeLibraryDirectoryStructure(directoryStructureBundle,{root:entry.fd,signal:context.signal,
          deadlineAtMs:context.deadlineAtMs,assertCurrent:rootCurrent});
        current();await rootCurrent();current();
        const root=probe.facts.directories[0]!,children=probe.facts.directories.filter(row=>row.relative!==''&&!row.relative.includes('/')&&!row.relative.startsWith('.'));
        const audio=(row:typeof root)=>row.entries.some(item=>!item.name.startsWith('.')&&item.kind==='file'&&accepts(item.name));
        let role:workbenchDto.LocalLibraryRole='catalog';
        if(audio(root))role='album';
        else if(children.some(audio))role=children.length>0&&children.every(child=>classifyDirectoryName(child.relative)==='disc')?'album':'artist';
        else if(probe.facts.directories.some(row=>row.relative.includes('/')&&row.relative.split('/').every(part=>!part.startsWith('.'))&&audio(row)))role='catalog';
        if(probe.facts.bounded)role='catalog';
        current();await rootCurrent();current();
        return {choiceId:entry.binding.choiceId,label:entry.root.label,suggestedRole:role,
          evidence:['已核验原Main选择对象及实际Owner目录FD。',probe.facts.bounded?
            'FD锚两层结构探测达到256条目或12子目录上限；请明确确认角色。':
            '仅按原FD锚两层直接音频结构建议角色；请确认音乐库、歌手目录、单张专辑或多库容器。']};
      }catch(error){
        if(error instanceof LibraryDirectoryProbeError){
          if(!error.physicalClosed)roleProbeUnknown.set(entry.binding.choiceId,error);
          const raw=error.raw;
          if(error.physicalClosed&&raw&&raw.exitCode===2&&raw.signal===null&&raw.pidClosed&&raw.overflow===null&&raw.stdout.length===0
            &&(raw.stderr.equals(Buffer.from('STRUCTURE_PROBE_ENTRY_BUDGET\n'))||raw.stderr.equals(Buffer.from('STRUCTURE_PROBE_CHILD_FD_BUDGET\n')))){
            logLibraryOperation('library','import.owner.role-budget','hit',{id:entry.binding.choiceId,code:raw.stderr.equals(Buffer.from('STRUCTURE_PROBE_ENTRY_BUDGET\n'))?'PROBE_ENTRY_BUDGET_CLOSED':'PROBE_CHILD_FD_BUDGET_CLOSED'});
            await traceLibraryImport('owner.role-budget-check',entry.binding.choiceId,async()=>{current();await rootCurrent();current();});
            return {choiceId:entry.binding.choiceId,label:entry.root.label,suggestedRole:'catalog',
              evidence:['已核验原Main选择对象及实际Owner目录FD。','达到有限条目/子目录预算，未形成结构建议，请手动确认角色。']};
          }
        }
        throw error;
      }
    }
    const anchor=(fd:FileHandle):string=>{if(fd.fd<0||process.platform!=='linux')throw new LocalWorkbenchPlanError('CHANGED','当前系统没有原目录FD结构读取锚。');
      return '/proc/self/fd/'+fd.fd;};
    if(process.platform!=='linux')return {choiceId:entry.binding.choiceId,label:entry.root.label,suggestedRole:'catalog',
      evidence:['已核验原Main选择对象及实际Owner目录FD。','当前系统没有FD锚结构读取；请手动确认四种目录角色，本次未作结构推断。']};
    type Child={fd:FileHandle;relative:string;parent:FileHandle;name:string;info:import('node:fs').BigIntStats};
    const handles=new Set<FileHandle>();let remaining=256,directories=0,bounded=false;
    async function childCurrent(child:Child):Promise<void>{
      const held=await step(()=>child.fd.stat({bigint:true})),named=await step(()=>lstat(path.join(anchor(child.parent),child.name),{bigint:true}));
      if(!unchanged(child.info,held)||!unchanged(held,named))throw new LocalWorkbenchPlanError('CHANGED','结构探测的原子目录FD身份已变化。');
    }
    async function direct(fd:FileHandle,relative:string,child:Child|null,descend:boolean):Promise<{audio:boolean;children:Child[]}> {
      await rootCurrent();if(child)await childCurrent(child);current();
      // opendir通过内核FD命名空间打开原对象，不能按可替换的命名路径读完再贴原inode标签。
      current();const stream=await opendir(anchor(fd)),children:Child[]=[];
      let audio=false;try { current();while(remaining>0){await rootCurrent();if(child)await childCurrent(child);
        const item=await step(()=>stream.read());await rootCurrent();if(child)await childCurrent(child);if(!item)break;remaining--;
        if(item.name.startsWith('.')||item.isSymbolicLink())continue;
        if(item.isFile()&&accepts(item.name))audio=true;
        else if(descend&&item.isDirectory()){
          if(directories>=12){bounded=true;continue;}directories++;
          const named=await step(()=>lstat(path.join(anchor(fd),item.name),{bigint:true}));
          if(named.isSymbolicLink()||!named.isDirectory())throw new LocalWorkbenchPlanError('CHANGED','结构子目录已改变。');
          current();const opened=await open(path.join(anchor(fd),item.name),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_DIRECTORY);
          handles.add(opened);roleProbeFds.add(opened);current();
          const info=await step(()=>opened.stat({bigint:true}));
          if(!unchanged(named,info))throw new LocalWorkbenchPlanError('CHANGED','结构子目录打开时原inode已改变。');
          const next={fd:opened,relative:path.join(relative,item.name),parent:fd,name:item.name,info};await childCurrent(next);children.push(next);
        }
      }if(remaining===0)bounded=true; }
      // cleanup即使原signal已取消也必须真实关闭；不得以过期阻断close或借cleanup续期。
      finally{await stream.close();try{await stream.read();throw new Error('原角色探测目录流关闭未核实。');}
        catch(error){if((error as NodeJS.ErrnoException).code!=='ERR_DIR_CLOSED')throw error;}}
      await rootCurrent();if(child)await childCurrent(child);current();return {audio,children};
    }
    let role:workbenchDto.LocalLibraryRole='catalog';
    try {
      const root=await direct(entry.fd,'',null,true);
      if(root.audio)role='album';
      else {
        let childAudio=false,grandchildAudio=false;const children:{name:string;audio:boolean}[]=[];
        for(const child of root.children){const read=await direct(child.fd,child.relative,child,true);children.push({name:child.name,audio:read.audio});childAudio ||= read.audio;
          if(!read.audio)for(const grandchild of read.children){const facts=await direct(grandchild.fd,grandchild.relative,grandchild,false);grandchildAudio ||= facts.audio;}}
        if(childAudio)role=children.length>0&&children.every(child=>classifyDirectoryName(child.name)==='disc')?'album':'artist';
        else if(grandchildAudio)role='catalog';
      }
      await rootCurrent();current();
    } finally {
      const failures:unknown[]=[];
      for(const fd of [...handles].reverse()){
        try{await fd.close();try{await fd.stat();throw new Error('原角色探测子目录FD关闭未核实。');}
          catch(error){if((error as NodeJS.ErrnoException).code!=='EBADF')throw error;}roleProbeFds.delete(fd);}
        catch(error){failures.push(error);}
      }
      if(failures.length)throw new AggregateError(failures,'角色探测的实际子目录FD未全部关闭。');
    }
    current();await rootCurrent();current();if(bounded)role='catalog';
    return {choiceId:entry.binding.choiceId,label:entry.root.label,suggestedRole:role,
      evidence:['已核验原Main选择对象及实际Owner目录FD。',bounded?'FD锚两层结构探测达到256条目或12子目录上限；请明确确认角色。':
        '仅按原FD锚两层直接音频结构建议角色；请确认音乐库、歌手目录、单张专辑或多库容器。']};
  }
  async function readLibrarySuggestion(entry:typeof approvedDirectories extends Map<string,infer V>?V:never,context:{signal:AbortSignal;deadlineAtMs:number}){
    if(roleProbeTasks.has(entry.binding.choiceId))throw new LocalWorkbenchPlanError('CHANGED','同一原目录结构探测仍在途。');
    const controller=new AbortController(),signal=AbortSignal.any([context.signal,workbenchLife.signal,controller.signal]);
    const work=suggestLibraryDirectory(entry,{...context,signal}),task={controller,work};roleProbeTasks.set(entry.binding.choiceId,task);roleProbeFlights.add(work);
    try{return await work;}finally{roleProbeFlights.delete(work);if(roleProbeTasks.get(entry.binding.choiceId)===task)roleProbeTasks.delete(entry.binding.choiceId);}
  }
  async function stopRoleProbe(choiceId:string):Promise<void>{
    const task=roleProbeTasks.get(choiceId);task?.controller.abort();if(task)await task.work.catch(()=>undefined);
    const unknown=roleProbeUnknown.get(choiceId);if(unknown)throw unknown;
  }
  async function registerWorkbenchDirectory(binding:SourceWorkbenchDirectoryBinding,context:Parameters<SourceWorkbenchDirectoryOwnerDomain['registerWorkbenchDirectory']>[1]){
    directoryContext(context);if(binding.datasetId!==identity.datasetId||binding.ownerEpoch!==options.localSourceEpoch)throw new LocalWorkbenchPlanError('CHANGED','原目录不属于当前Owner。');
    const existing=approvedDirectories.get(binding.choiceId);
    if(existing&&lyricsPhysicalDigest(existing.binding)!==lyricsPhysicalDigest(binding))throw new LocalWorkbenchPlanError('CHANGED','目录choice不能换原批准。');
    const proof=await traceLibraryImport('owner.proof',binding.choiceId,()=>requestWorkbenchDirectoryApproval(context.mainActor,existing?'revalidate':'approve',binding,binding.originalUi,context.signal,context.deadlineAtMs));
    const physical=await traceLibraryImport('owner.proof-check',binding.choiceId,()=>{directoryContext(context);return assertSourceWorkbenchDirectoryApproval(proof,context.mainActor,binding,binding.originalUi);});
    if(!existing){
      if([...approvedDirectories.values()].filter(value=>!value.ownerClosed).length>=100||approvedDirectories.size>=10000)throw new LocalWorkbenchPlanError('CHANGED','原目录许可已达到当前上限。');
      const certified=await traceLibraryImport('owner.authorize',binding.choiceId,()=>authorizeSourceDirectory(physical.path)),fd=await traceLibraryImport('owner.fd',binding.choiceId,()=>open(physical.path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_DIRECTORY));
      const entry={binding:structuredClone(binding),root:{...certified,id:binding.choiceId},fd,approval:proof,ui:structuredClone(binding.originalUi),active:true,ownerClosed:false};
      try{await traceLibraryImport('owner.fd-check',binding.choiceId,async()=>{await assertDirectory(entry,physical);directoryContext(context);approvedDirectories.set(binding.choiceId,entry);});}catch(error){await fd.close();throw error;}
    }else{if(existing.ownerClosed||!existing.active)throw new LocalWorkbenchPlanError('CHANGED','原目录批准已消费或撤销。');await assertDirectory(existing,physical);existing.approval=proof;existing.ui=structuredClone(binding.originalUi);}
    const entry=approvedDirectories.get(binding.choiceId)!;
    if(binding.kind==='library')try{entry.suggestion=await traceLibraryImport('owner.role',binding.choiceId,()=>readLibrarySuggestion(entry,context));}
    catch(error){entry.active=false;if(roleProbeUnknown.has(binding.choiceId)){invalidateSourceWorkbenchDirectory(context.mainActor,binding);throw error;}
      await entry.fd.close();try{await entry.fd.stat();throw new Error('原角色探测FD关闭未核实。');}
      catch(closedError){if((closedError as NodeJS.ErrnoException).code!=='EBADF')throw closedError;}entry.ownerClosed=true;
      approvedDirectories.delete(binding.choiceId);invalidateSourceWorkbenchDirectory(context.mainActor,binding);throw error;}
    return binding.kind==='library'?{kind:'library' as const,choice:entry.suggestion!}
      :{kind:'cue' as const,choiceId:binding.choiceId,revision:binding.revision};
  }
  async function revokeWorkbenchDirectory(binding:SourceWorkbenchDirectoryBinding,context:Parameters<SourceWorkbenchDirectoryOwnerDomain['revokeWorkbenchDirectory']>[1]){
    directoryContext(context,true);const entry=approvedDirectories.get(binding.choiceId);
    if(!entry||lyricsPhysicalDigest(entry.binding)!==lyricsPhysicalDigest(binding))throw new LocalWorkbenchPlanError('CHANGED','原目录撤销对象不匹配。');
    entry.active=false;await stopRoleProbe(binding.choiceId);if(binding.kind==='cue')await cueActor?.abortTarget(binding.choiceId);
    if(!entry.ownerClosed)await entry.fd.close();try{await entry.fd.stat();throw new Error('原目录FD关闭未核实。');}catch(error){if((error as NodeJS.ErrnoException).code!=='EBADF')throw error;}
    entry.ownerClosed=true;
    approvedDirectories.delete(binding.choiceId);invalidateSourceWorkbenchDirectory(context.mainActor,binding);
    return {choiceId:binding.choiceId,revision:binding.revision,revoked:true as const,physicalClosed:true as const};
  }
  async function revalidateDirectory(choiceId:string,revision:string,ui:SourceWorkbenchDirectoryUi,signal:AbortSignal,deadlineAtMs:number):Promise<RootCapability>{
    assertWorkbench();const entry=approvedDirectories.get(choiceId),actor=options.sourceWritesMainActor;
    if(!entry||!entry.active||!actor||entry.binding.revision!==revision)throw new LocalWorkbenchPlanError('CHANGED','原Main目录批准不可由公开choice恢复。');
    const proof=await requestWorkbenchDirectoryApproval(actor,'revalidate',entry.binding,ui,signal,deadlineAtMs),physical=assertSourceWorkbenchDirectoryApproval(proof,actor,entry.binding,ui);
    await assertDirectory(entry,physical);assertWorkbench();entry.approval=proof;entry.ui=structuredClone(ui);return entry.root;
  }
  function cueDemuxer(relative:string):CueInputDemuxer {
    const extension=path.extname(relative).toLowerCase(),value:Record<string,CueInputDemuxer>={'.wav':'wav','.wave':'wav','.aif':'aiff','.aiff':'aiff','.flac':'flac','.mp3':'mp3','.ogg':'ogg','.oga':'ogg','.opus':'ogg','.wv':'wv','.m4a':'mov','.mp4':'mov','.ape':'ape','.tta':'tta','.mpc':'mpc','.mpp':'mpc','.mp+':'mpc','.tak':'tak'};
    const demuxer=value[extension];if(!demuxer)throw new LocalWorkbenchPlanError('UNQUALIFIED_FORMAT','该CUE源未取得实际解码格式资格。');return demuxer;
  }
  async function sourceSha(fd:FileHandle,signal:AbortSignal):Promise<string>{
    const before=await fd.stat({bigint:true});if(!before.isFile()||before.size<1n||before.size>256n*1024n*1024n)throw new LocalWorkbenchPlanError('CHANGED','原音频超出本次物理预算。');
    const hash=createHash('sha256'),bytes=Buffer.allocUnsafe(1024*1024);let at=0;
    while(at<Number(before.size)){if(signal.aborted)throw new LocalWorkbenchPlanError('CHANGED','原音频读取已撤销。');const read=await fd.read(bytes,0,Math.min(bytes.length,Number(before.size)-at),at);if(!read.bytesRead)throw new LocalWorkbenchPlanError('CHANGED','原音频未读至EOF。');hash.update(bytes.subarray(0,read.bytesRead));at+=read.bytesRead;}
    const after=await fd.stat({bigint:true});if((['dev','ino','birthtimeNs','size','mtimeNs','ctimeNs'] as const).some(key=>before[key]!==after[key]))throw new LocalWorkbenchPlanError('CHANGED','原音频读取期间改变。');return hash.digest('hex');
  }
  async function revalidateCueCapture(capture:Readonly<LocalWorkbenchPlanCapture>):Promise<void>{
    assertWorkbench();if(!cueNative||!cueQualification||!capture.target||!capture.format)throw new LocalWorkbenchPlanError('UNQUALIFIED_FORMAT','CUE原Native或目录作者尚未就绪。');
    const format=readCueQualifiedFormats(cueQualification).find(value=>value.formatId===capture.format!.formatId);
    if(!format||lyricsPhysicalDigest(format)!==lyricsPhysicalDigest(capture.format))throw new LocalWorkbenchPlanError('UNQUALIFIED_FORMAT','CUE编码资格不是当前原实例。');
    for(const album of capture.albums){const resolved=await workbenchRead!.resolveCapture({datasetId:identity.datasetId,capture:{albumId:album.albumId,readToken:album.readToken}},{signal:workbenchLife.signal});
      if(resolved.datasetRevision!==capture.datasetRevision||lyricsPhysicalDigest(resolved.capture)!==lyricsPhysicalDigest(album)||resolved.availability!=='online')throw new LocalWorkbenchPlanError('CHANGED','原CUE完整专辑已变化。');}
    const entry=approvedDirectories.get(capture.target.choiceId);if(!entry?.active||entry.binding.kind!=='cue'||entry.binding.revision!==capture.target.revision)throw new LocalWorkbenchPlanError('CHANGED','原独立输出许可已撤销。');
    const physical=assertSourceWorkbenchDirectoryApproval(entry.approval,options.sourceWritesMainActor!,entry.binding,entry.ui);await assertDirectory(entry,physical);assertWorkbench();
  }
  async function cuePreview(payload:Extract<DatasetWorkbenchOwnerRequest,{command:'cue.preparePreview'}>['payload'],context:DatasetWorkbenchExecutionContext,
    originalUi?:SourceWorkbenchDirectoryUi,signal:AbortSignal=workbenchLife.signal){
    assertWorkbench(context);if(!cueQualification||!cueNative||!cueActor)throw new LocalWorkbenchPlanError('UNQUALIFIED_FORMAT','当前Owner尚未完成真实CUE编码与EOF核验。');
    const ui:SourceWorkbenchDirectoryUi=originalUi??{family:'workbench',command:'localWorkbench.cue.preview',commandId:null,
      requestSha256:datasetWorkbenchSha(datasetWorkbenchJson({command:'localWorkbench.cue.preview',payload:payload.request}))};
    if(lyricsPhysicalDigest(payload.target.target)!==lyricsPhysicalDigest(payload.request.target))throw new LocalWorkbenchPlanError('CHANGED','CUE原目录描述不一致。');
    await revalidateDirectory(payload.target.target.choiceId,payload.target.revision,ui,context.signal,context.deadlineAtMs);
    const key=lyricsPhysicalDigest([ui,payload]),existing=cuePreparations.get(key);if(existing)return existing;
    if(cuePreparations.size>=512)throw new LocalWorkbenchPlanError('CHANGED','原CUE捕获已达到当前预算。');
    const controller=new AbortController(),parentSignal=signal,abort=()=>controller.abort();parentSignal.addEventListener('abort',abort,{once:true});if(parentSignal.aborted)abort();signal=controller.signal;
    const roots=payload.request.cueSelections.map(selection=>workbenchRead!.inspectRoot(payload.request.captures.find(capture=>capture.albumId===selection.albumId)!));
    const preparation=(async()=>{
      const selections:import('./local-library-workbench/types.js').LocalCueSheetCapture[]=[],albums:LocalWorkbenchPlanCapture['albums'][number][]= [];
      const sheets:NonNullable<LocalWorkbenchPlanCapture['cueSheets']>[number][]=[],allAudio:LocalCueAudioProbe[]=[],encodings:LocalCueSourceEncoding[]=[];
      let datasetRevision:string|undefined,sourceBytes=0n;
      for(const selected of payload.request.cueSelections){
        if(signal.aborted)throw new LocalWorkbenchPlanError('CHANGED','原CUE准备已撤销。');
        const capture=payload.request.captures.find(value=>value.albumId===selected.albumId);
        if(!capture)throw new LocalWorkbenchPlanError('CHANGED','所选CUE缺少原完整专辑读取。');
        const reference={datasetId:identity.datasetId,capture};
        const facts=await workbenchRead!.resolveCueFacts({...reference,cueId:selected.cueId},{signal});
        const resolved=await workbenchRead!.resolveCapture(reference,{signal});
        if(facts.parsed.status!=='ok'||resolved.availability!=='online'||datasetRevision!==undefined&&resolved.datasetRevision!==datasetRevision)
          throw new LocalWorkbenchPlanError('CHANGED','原CUE解析或完整数据修订改变。');
        datasetRevision=resolved.datasetRevision;
        const references=[...new Map(facts.parsed.tracks.map(track=>[track.assetReference.assetId,track.assetReference])).values()];
        if(references.length>32)throw new LocalWorkbenchPlanError('CHANGED','CUE源数量超过原全组预算。');
        const locations=references.map(sourceReference=>{
          const located=collection.localCatalog.privateAssetLocator(sourceReference.assetId),root=collection.localCatalog.root(sourceReference.libraryRootId),source=collection.sources.root(sourceReference.sourceRootId);
          const scan=resolved.directoryFacts.files.find(file=>file.currentRelative===located.relative);
          if(!source.authorized||root.sourceRootId!==sourceReference.sourceRootId||root.revision!==sourceReference.rootRevision||located.asset.fileRevision!==sourceReference.fileRevision
            ||located.asset.locationRevision!==sourceReference.locationRevision||!scan||scan.value.outcome!=='accepted')throw new LocalWorkbenchPlanError('CHANGED','原CUE源定位或修订改变。');
          return {reference:sourceReference,root:source,relative:located.relative,signature:scan.value.signature,demuxer:cueDemuxer(located.relative)};
        });
        const commandId=randomUUID(),audio:LocalCueAudioProbe[]=[];
        await withReadonlySourcePublicationClaims(locations.map(location=>({root:location.root,relative:location.relative,expectedSignature:location.signature})),signal,async(verify,files)=>{
          for(let index=0;index<locations.length;index++){
            const location=locations[index]!,file=files[index]!,stat=await file.handle.stat({bigint:true});sourceBytes+=stat.size;
            if(stat.size>256n*1024n*1024n||sourceBytes>2n*1024n*1024n*1024n)throw new LocalWorkbenchPlanError('CHANGED','原CUE完整源超过固定物理预算。');
            const claim={commandId,claimId:lyricsPhysicalDigest([key,location.reference]),async assertCurrent(){assertWorkbench();await verify();
              const current=await workbenchRead!.resolveCapture(reference,{signal});if(lyricsPhysicalDigest(current.capture)!==lyricsPhysicalDigest(resolved.capture))throw new LocalWorkbenchPlanError('CHANGED','原CUE捕获变化。');}};
            let demuxer=location.demuxer;
            if(demuxer==='mpc'){
              await claim.assertCurrent();const header=Buffer.alloc(4),read=await file.handle.read(header,0,4,0);await claim.assertCurrent();
              if(read.bytesRead!==4)throw new LocalWorkbenchPlanError('CUE_INVALID','MPC原源头不完整。');
              if(header.toString('ascii')==='MPCK')demuxer='mpc8';
              else if(header.toString('ascii',0,3)!=='MP+'||(header[3]!&15)!==7)throw new LocalWorkbenchPlanError('CUE_INVALID','MPC原源不是已支持的7/8版本。');
            }
            const native=await cueNative!.probe(file.handle,demuxer,claim,signal),sha256=await sourceSha(file.handle,signal);await claim.assertCurrent();
            if(!native.eof||!native.pidClosed||![1,2].includes(native.channels))throw new LocalWorkbenchPlanError('CHANGED','原CUE源未取得完整实际帧读取。');
            const encoding:LocalCueSourceEncoding={codec:native.codec,demuxer,sampleFormat:native.sampleFormat,bitsPerSample:native.bitsPerSample};encodings.push(encoding);
            const explicitFormat=readCueQualifiedFormats(cueQualification!).find(format=>format.formatId===payload.request.outputFormat);
            if(explicitFormat&&!isLocalCueSourceOutputPrecisionQualified(encoding,explicitFormat.codec))
              throw new LocalWorkbenchPlanError('UNQUALIFIED_FORMAT','本源精度不在所选输出的实际资格内。');
            const readRevision=lyricsPhysicalDigest([location.reference,location.signature,sha256,demuxer,native.frames,native.sampleRate,native.channels,native.sampleFormat,native.bitsPerSample]);
            const probe:LocalCueAudioProbe={assetReference:{assetId:location.reference.assetId,libraryRootId:location.reference.libraryRootId,sourceRootId:location.reference.sourceRootId,
              rootRevision:location.reference.rootRevision,fileRevision:location.reference.fileRevision,locationRevision:location.reference.locationRevision},sourceLabel:path.basename(location.relative),evidence:'audio-pcm-read',readRevision,sampleRate:native.sampleRate,totalPcmFrames:native.frames};
            audio.push(probe);cueSources.set(readRevision,{rootId:location.reference.libraryRootId,source:{root:location.root,relative:location.relative,signature:location.signature,sha256,channels:native.channels as 1|2,demuxer},probe});
          }
        },()=>cueNative!.join(commandId));
        selections.push({album:facts.capture,cueId:facts.cueId,cueRevision:facts.cueRevision,parsed:facts.parsed,audio});albums.push(facts.capture);
        sheets.push({cueId:facts.cueId,revision:facts.cueRevision,albumId:facts.capture.albumId});allAudio.push(...audio);
      }
      if(!datasetRevision)throw new LocalWorkbenchPlanError('CUE_INVALID','原CUE完整选择为空。');
      const qualified=readCueQualifiedFormats(cueQualification!);
      const format=payload.request.outputFormat==='auto'?selectLocalCueSourceOutputFormat(encodings,qualified):qualified.find(value=>value.formatId===payload.request.outputFormat);
      if(!format)throw new LocalWorkbenchPlanError('UNQUALIFIED_FORMAT','原输出格式未取得当前品牌资格。');
      // 完整观察同一个批准目录及其持有FD；观察期间改名/新增不能被当作空目录。
      const targetRoot=await revalidateDirectory(payload.target.target.choiceId,payload.target.revision,ui,signal,context.deadlineAtMs);
      const approved=approvedDirectories.get(payload.target.target.choiceId);
      if(!approved?.active||approved.root!==targetRoot||approved.ownerClosed)throw new LocalWorkbenchPlanError('CHANGED','原独立目标作者已经变化。');
      const before=await approved.fd.stat({bigint:true}),named=await lstat(targetRoot.path,{bigint:true});
      const matches=(a:typeof before,b:typeof before)=>['dev','ino','birthtimeNs','mode','uid','gid','mtimeNs','ctimeNs'].every(key=>a[key as keyof typeof a]===b[key as keyof typeof b]);
      if(!before.isDirectory()||named.isSymbolicLink()||!matches(before,named))throw new LocalWorkbenchPlanError('CHANGED','原目标命名位与持有FD不一致。');
      const occupied=await readdir(targetRoot.path),after=await approved.fd.stat({bigint:true}),afterNamed=await lstat(targetRoot.path,{bigint:true});
      if(signal.aborted||!matches(before,after)||!matches(after,afterNamed)||afterNamed.isSymbolicLink())throw new LocalWorkbenchPlanError('CHANGED','完整目标名称观察期间发生变化，未生成输出计划。');
      await revalidateDirectory(payload.target.target.choiceId,payload.target.revision,ui,signal,context.deadlineAtMs);
      const plan=buildLocalCuePlan({selections,target:payload.target.target,format,pregapPolicy:'append-to-previous'},occupied);
      const capture:LocalWorkbenchPlanCapture={datasetId:identity.datasetId,datasetRevision,albums,cueSheets:sheets,cueOutputs:plan.outputs,audio:allAudio,target:{...payload.target.target,revision:payload.target.revision},format};
      await revalidateCueCapture(capture);return {draft:plan.draft,capture};
    })();cuePreparationLives.set(key,{roots,controller,done:preparation});
    void preparation.finally(()=>{cuePreparationLives.delete(key);parentSignal.removeEventListener('abort',abort);}).catch(()=>{});
    cuePreparations.set(key,preparation);void preparation.catch(()=>{cuePreparations.delete(key);});return preparation;
  }
  async function privateWorkbenchDirectory(directory:string):Promise<void>{
    const missing:string[]=[];let cursor=directory;
    for(;;){try{const stat=await lstat(cursor);if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(cursor)!==cursor)throw new Error('工作台私有目录不是原普通目录。');break;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;missing.push(cursor);const parent=path.dirname(cursor);if(parent===cursor)throw error;cursor=parent;}}
    for(const name of missing.reverse()){await mkdir(name,{mode:0o700});if(await realpath(name)!==name)throw new Error('工作台私有目录路径改变。');}
    const final=await lstat(directory,{bigint:true});if(!final.isDirectory()||final.isSymbolicLink()||(final.mode&0o077n)!==0n)throw new Error('工作台私有目录权限不符合原安全材料边界。');
  }
  function consumeLibraryDirectory(choiceId:string):Promise<void>{
    const prior=directoryClosures.get(choiceId);if(prior)return prior;
    const entry=approvedDirectories.get(choiceId),actor=options.sourceWritesMainActor;
    if(!entry||entry.binding.kind!=='library'||!actor)return Promise.reject(new DatasetWorkbenchWireError('NOT_READY'));
    const done=(async()=>{
      // 已确认的SourceRoot另由同SQL原作者保存；这里收口本次选择的两个真实目录FD。
      entry.active=false;await stopRoleProbe(choiceId);
      await requestWorkbenchDirectoryApproval(actor,'revoke',entry.binding,entry.ui,new AbortController().signal,performance.now()+2000);
      if(!entry.ownerClosed)await entry.fd.close();
      try{await entry.fd.stat();throw new Error('导入选择的Owner目录FD仍开启。');}catch(error){if((error as NodeJS.ErrnoException).code!=='EBADF')throw error;}
      entry.ownerClosed=true;invalidateSourceWorkbenchDirectory(actor,entry.binding);
    })();directoryClosures.set(choiceId,done);void done.catch(()=>{});return done;
  }
  function assertLibraryJobOriginal(input:LocalLibraryManagementJobInput):void{
    assertDataset();const job=collection.localCatalog.privateLibraryManagementRead(identity,'job',input.job.key)?.record;
    const capture=collection.localCatalog.privateLibraryManagementRead(identity,'capture',input.capture.key)?.record;
    if(!job||!capture||job.originalSha256!==input.job.originalSha256||capture.originalSha256!==job.original.captureSha256
      ||lyricsPhysicalDigest(job.original)!==lyricsPhysicalDigest(input.job.original)||lyricsPhysicalDigest(capture.original)!==lyricsPhysicalDigest(input.capture.original)
      ||!job.original.expandedSelection.some(value=>lyricsPhysicalDigest(value)===lyricsPhysicalDigest(input.selection))
      ||!capture.original.albums.some(value=>lyricsPhysicalDigest(value)===lyricsPhysicalDigest(input.album)))
      throw new LocalWorkbenchPlanError('CHANGED','原整组任务、完整捕获或实际选择已变化。');
  }
  async function waitNamePoll(signal:AbortSignal):Promise<void>{
    if(signal.aborted)throw new LocalWorkbenchPlanError('CHANGED','原名称请求已停止。');
    await new Promise<void>((resolve,reject)=>{
      const finish=()=>{clearTimeout(timer);signal.removeEventListener('abort',stop);resolve();};
      const stop=()=>{clearTimeout(timer);signal.removeEventListener('abort',stop);reject(new LocalWorkbenchPlanError('CHANGED','原名称请求已停止。'));};
      const timer=setTimeout(finish,100);signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();
    });
  }
  async function closeNameOperation(operationId:string):Promise<void>{
    if(!options.projection)throw new DatasetWorkbenchWireError('NOT_READY');
    await options.projection.call('nameProviderCancel',{operationId});
    const deadline=performance.now()+30000;
    for(;;){
      try{const joined=await options.projection.call('nameProviderJoin',{operationId});if(joined.operationId!==operationId||joined.physicalClosed!==true)throw new DatasetWorkbenchWireError('INVALID_IPC_RESPONSE');return;}
      catch(error){if(!(error instanceof DatasetNameProviderBridgeError)||error.code!=='TIMEOUT'||performance.now()>=deadline)throw error;}
    }
  }
  async function prepareLibraryName(input:LocalLibraryManagementJobInput,signal:AbortSignal){
    if(input.job.original.start.command!=='library.ai.start'||!options.projection)throw new DatasetWorkbenchWireError('NOT_READY');
    assertLibraryJobOriginal(input);
    const scope={datasetId:identity.datasetId,libraryId:input.album.libraryId,albumId:input.selection.albumId,captureId:input.capture.key};
    const readToken=await libraryManagement!.lyricsLibraryAuthor.resolveAlbumReadToken(scope);
    const preparation=await workbenchRead!.prepareNameSuggestion({datasetId:identity.datasetId,capture:{albumId:scope.albumId,readToken},backend:input.job.original.start.request.backend},{signal});
    // 一个真实已受理attempt只有一个Provider identity；未知attempt不能进入新的prepare。
    const operationId=randomUUID(),key=input.job.key+':'+scope.albumId;
    const prior=nameOperations.get(key);
    if(prior&&!prior.joined){workbenchRead!.cancelNamePreparation(preparation.preparationId);throw new DatasetWorkbenchWireError('NOT_READY');}
    const start={operationId,jobId:input.job.key,captureId:input.capture.key,albumId:scope.albumId,...preparation,
      originalStartSha256:datasetNameOriginalStartSha256(input.job.original.start.request),expiresAtMs:Date.now()+300000};
    const row={jobId:input.job.key,albumId:scope.albumId,operationId,preparationId:preparation.preparationId,joined:false,done:undefined as unknown as Promise<{backend:workbenchDto.LocalAiBackend;content:string}>};
    row.done=(async()=>{
      let response:{backend:workbenchDto.LocalAiBackend;content:string}|undefined,failure:unknown;
      try{
        await options.projection!.call('nameProviderStart',start);
        const chunks:Buffer[]=[];let offset=0,total:number|null=null,wholeSha:string|null=null;
        for(;;){
          if(signal.aborted||Date.now()>=start.expiresAtMs)throw new LocalWorkbenchPlanError('CHANGED','原名称请求已停止或达到固定期限。');
          assertLibraryJobOriginal(input);const part=await options.projection!.call('nameProviderRead',{operationId,offset});
          if(part.operationId!==operationId||part.offset!==offset)throw new DatasetWorkbenchWireError('INVALID_IPC_RESPONSE');
          if(part.state==='failed'||part.state==='cancelled')throw new LocalWorkbenchPlanError('CHANGED','名称模型明确失败，保留原名称。');
          if(part.state!=='complete'){await waitNamePoll(signal);continue;}
          if(part.totalBytes===null||part.sha256===null||part.totalBytes>DATASET_NAME_PROVIDER_CONTENT_BYTES||total!==null&&total!==part.totalBytes||wholeSha!==null&&wholeSha!==part.sha256)
            throw new DatasetWorkbenchWireError('INVALID_IPC_RESPONSE');
          total=part.totalBytes;wholeSha=part.sha256;
          const bytes=Buffer.from(part.bytes);if(bytes.length>64*1024||offset+bytes.length>total||!bytes.length&&!part.eof)throw new DatasetWorkbenchWireError('INVALID_IPC_RESPONSE');
          chunks.push(bytes);offset+=bytes.length;
          if(!part.eof)continue;
          const raw=Buffer.concat(chunks);if(offset!==total||datasetWorkbenchSha(raw)!==wholeSha)throw new DatasetWorkbenchWireError('INVALID_IPC_RESPONSE');
          const decoded:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
          if(!decoded||typeof decoded!=='object'||Array.isArray(decoded)||Reflect.ownKeys(decoded).length!==2||!Object.hasOwn(decoded,'backend')||!Object.hasOwn(decoded,'content'))
            throw new DatasetWorkbenchWireError('INVALID_IPC_RESPONSE');
          const value=decoded as {backend:unknown;content:unknown};
          if(value.backend!==preparation.backend||typeof value.content!=='string'||Buffer.byteLength(value.content,'utf8')>64*1024||Buffer.from(value.content,'utf8').toString('utf8')!==value.content)
            throw new DatasetWorkbenchWireError('INVALID_IPC_RESPONSE');
          response={backend:preparation.backend,content:value.content};break;
        }
      }catch(error){failure=error;}
      try{await closeNameOperation(operationId);row.joined=true;}
      catch(error){throw new AggregateError([...(failure?[failure]:[]),error],'原名称Provider/reader未核实关闭，保留UNKNOWN。');}
      if(failure)throw failure;if(!response)throw new DatasetWorkbenchWireError('INVALID_IPC_RESPONSE');return response;
    })();nameOperations.set(key,row);void row.done.catch(()=>{});
    try{
      const response=await row.done;assertLibraryJobOriginal(input);
      const result=await workbenchRead!.completeNameSuggestion(preparation.preparationId,response,{signal});
      if(result.status!=='ready')throw new LocalWorkbenchPlanError('CHANGED',result.publicMessage);
      return workbenchRead!.prepareNamePreview({datasetId:identity.datasetId,captures:[{albumId:scope.albumId,readToken}],selections:[{albumId:scope.albumId,candidateId:result.proposal.candidateId}]},{signal});
    }finally{workbenchRead!.cancelNamePreparation(preparation.preparationId);}
  }
  function createLibraryJobPort():LocalLibraryManagementJobPort{
    return {
      async prepare(input,context){
        assertWorkbench();assertLibraryJobOriginal(input);
        const actual=collection.localCatalog.privateLibraryManagementRead(identity,'job',input.job.key)!.record;
        const item=actual.checkpoint.items.find(value=>value.albumId===input.selection.albumId);
        if(!item||item.state!=='queued'||item.planId!==null||item.commandId!==null||actual.checkpoint.state!=='running'||actual.checkpoint.items.some(value=>value.state==='unknown'))
          throw new LocalWorkbenchPlanError('CHANGED','只准备原任务中明确未受理的成员。');
        const signal=context.signal??workbenchLife.signal;
        let prepared:{draft:import('./local-library-workbench/types.js').LocalWorkbenchPlanDraft;capture:LocalWorkbenchPlanCapture};
        if(input.job.original.start.command==='library.ai.start')prepared=await prepareLibraryName(input,signal);
        else{
          if(!input.selection.cueId)return null;
          const start=input.job.original.start.request,entry=approvedDirectories.get(start.target.choiceId);
          if(!entry?.active||entry.binding.kind!=='cue')throw new LocalWorkbenchPlanError('CHANGED','原CUE任务缺少当前真实Main批准。');
          const readToken=await libraryManagement!.lyricsLibraryAuthor.resolveAlbumReadToken({datasetId:identity.datasetId,libraryId:input.album.libraryId,albumId:input.selection.albumId,captureId:input.capture.key});
          const request:workbenchDto.LocalCueSplitInput={datasetId:identity.datasetId,captures:[{albumId:input.selection.albumId,readToken}],
            cueSelections:[{albumId:input.selection.albumId,cueId:input.selection.cueId}],outputFormat:start.outputFormat,target:start.target,sourceDisposition:'retain'};
          const ui:SourceWorkbenchDirectoryUi={family:'management',command:'library.cue.start',commandId:input.job.key,requestSha256:datasetWorkbenchSha(datasetWorkbenchJson({command:'library.cue.start',payload:start}))};
          const ownerContext:DatasetWorkbenchExecutionContext={identity:{epoch:options.localSourceEpoch!,datasetId:identity.datasetId},signal,deadlineAtMs:performance.now()+2000};
          prepared=await cuePreview({request,target:{target:start.target,revision:entry.binding.revision}},ownerContext,ui,signal);
        }
        assertLibraryJobOriginal(input);if(signal.aborted)throw new LocalWorkbenchPlanError('CHANGED','原任务已停止，未签发写入。');
        if(prepared.draft.state!=='ready')return null;
        const registry=await workbenchRegistry!,plan=await registry.issuePlan(prepared.draft,prepared.capture);
        if(plan.kind==='ai')workbenchWriter!.originRoutes.registerAiPreviewPlan(plan.planId);
        const request:workbenchDto.LocalWorkbenchApplyRequest={commandId:randomUUID(),datasetId:identity.datasetId,planId:plan.planId,
          expectedRevision:plan.revision,planHash:plan.planHash,contextFingerprint:plan.contextFingerprint,kind:plan.kind};
        jobAttempts.set(request.commandId,{jobId:input.job.key,albumId:input.selection.albumId,request});
        return {planId:plan.planId,commandId:request.commandId};
      },
      async run(input,attempt,context){
        assertLibraryJobOriginal(input);const author=jobAttempts.get(attempt.commandId),job=collection.localCatalog.privateLibraryManagementRead(identity,'job',input.job.key)!.record;
        const item=job.checkpoint.items.find(value=>value.albumId===input.selection.albumId);
        if(!author||author.jobId!==input.job.key||author.albumId!==input.selection.albumId||author.request.planId!==attempt.planId||item?.commandId!==attempt.commandId||item.planId!==attempt.planId)
          throw new LocalWorkbenchPlanError('CHANGED','实际原计划未由同job持久受理。');
        const registry=await workbenchRegistry!;
        if(context.signal?.aborted)throw new LocalWorkbenchPlanError('CHANGED','原任务在写入受理前已停止。');
        let cancellation:Promise<unknown>|undefined;
        const stop=()=>{if(author.request.kind==='cue')cancellation??=registry.cancel({cancelCommandId:randomUUID(),original:author.request});void cancellation?.catch(()=>{});};
        context.signal?.addEventListener('abort',stop,{once:true});
        try{
          const initial=await registry.apply(author.request);
          if(author.request.kind!=='cue')return initial;
          if(context.signal?.aborted)stop();await cueActor!.join(attempt.commandId);await cancellation;
          const physical=collection.localCatalog.privateCueOutputRead(identity,attempt.commandId);
          if(!physical?.record.physicalClosed)throw new DatasetWorkbenchWireError('NOT_READY');
          return registry.readOriginalReceipt(author.request);
        }finally{context.signal?.removeEventListener('abort',stop);}
      },
      async readOriginal(input,attempt){
        assertLibraryJobOriginal(input);const snapshot=collection.localCatalog.privateWorkbenchSnapshot(identity.datasetId),entry=snapshot?.entries.find(value=>value.plan.planId===attempt.planId&&value.original?.commandId===attempt.commandId);
        if(!entry?.original||entry.capture.albums.every(value=>value.albumId!==input.selection.albumId))return null;
        return (await workbenchRegistry!).readOriginalReceipt(entry.original);
      },
      async join(job){
        assertDataset();const names=[...nameOperations.values()].filter(value=>value.jobId===job.key);
        for(const value of names){try{await value.done;}catch{if(!value.joined)throw new DatasetWorkbenchWireError('NOT_READY');}if(!value.joined)throw new DatasetWorkbenchWireError('NOT_READY');}
        for(const item of job.checkpoint.items){
          if(!item.commandId||!item.planId)continue;
          const snapshot=collection.localCatalog.privateWorkbenchSnapshot(identity.datasetId),entry=snapshot?.entries.find(value=>value.plan.planId===item.planId&&value.original?.commandId===item.commandId);
          if(!entry?.original)throw new DatasetWorkbenchWireError('NOT_READY');
          if(entry.plan.kind==='cue'){
            await cueActor?.join(item.commandId);
            if(!collection.localCatalog.privateCueOutputRead(identity,item.commandId)?.record.physicalClosed)throw new DatasetWorkbenchWireError('NOT_READY');
          }
          const receipt=await (await workbenchRegistry!).readOriginalReceipt(entry.original);
          if(!receipt||['unknown','running'].includes(receipt.state)||receipt.items.some(value=>value.state==='unknown'))throw new DatasetWorkbenchWireError('NOT_READY');
        }
      },
    };
  }
  function createManagementRuntime():LocalLibraryManagementRuntime{
    if(!workbenchRead||!completedScanSnapshots)throw new DatasetWorkbenchWireError('NOT_READY');
    return createLocalLibraryManagementRuntime({
      identity,catalog:collection.localCatalog,localScan:collection.localScan,workbench:workbenchRead,
      localAlbums:albumRuntime.localAlbums,readRootViews:()=>localRelocation.roots(),assertAccepting:assertDataset,
      completedSnapshots:completedScanSnapshots,jobs:createLibraryJobPort(),
      async startInitialScan(commandId,root,context){
        const ownerContext=managementContexts.get(context);if(!ownerContext)throw new DatasetWorkbenchWireError('NOT_READY');
        assertWorkbench(ownerContext);await startInitialLibraryScan(commandId,root);assertWorkbench(ownerContext);
      },
      assertRemoveCurrent(context){const ownerContext=managementContexts.get(context);if(!ownerContext)throw new DatasetWorkbenchWireError('NOT_READY');assertWorkbench(ownerContext);},
      async removeResources(libraryId,context,removingLibraries,original,pin){
        const ownerContext=managementContexts.get(context);if(!ownerContext)throw new DatasetWorkbenchWireError('NOT_READY');
        const accepting=()=>assertWorkbench(ownerContext);accepting();
        const root=collection.localCatalog.root(libraryId),binding=collection.localCatalog.privateLibraryManagementRead(identity,'binding',libraryId);
        if(pin.libraryId!==libraryId||root.role!=='library'||root.sourceRootId!==pin.sourceRootId||root.revision!==pin.rootRevision
          ||(pin.bindingSha256===null?binding!==null:!binding||binding.recordSha256!==pin.bindingSha256))throw new DatasetWorkbenchWireError('NOT_READY');
        const removal=collection.localCatalog.privateLibraryManagementRead(identity,'operation',original.commandId);
        if(!removal||removal.record.revision!==1||removal.record.receipt.state!=='running'||removal.record.original.command!=='library.remove'
          ||removal.record.originalSha256!==original.originalSha256||!removal.record.receipt.libraryIds.includes(libraryId))throw new DatasetWorkbenchWireError('NOT_READY');
        await albumRuntime.background?.removeRoot(libraryId);accepting();
        if(libraryWatch){await libraryWatch.remove(libraryId);const watched=libraryWatch.inspect(libraryId);
          if(watched.watching||watched.leaseRetained||watched.failed||watched.status!=='disabled')throw new DatasetWorkbenchWireError('NOT_READY');}
        else if(binding?.record.watchEnabled)throw new DatasetWorkbenchWireError('NOT_READY');
        await localScan.privateQuiesceLibrary(libraryId,ownerContext);
        const preparations=[...cuePreparationLives.values()].filter(value=>value.roots.includes(libraryId));for(const value of preparations)value.controller.abort();
        const preparationResults=await Promise.allSettled(preparations.map(value=>value.done));
        for(const result of preparationResults)if(result.status==='rejected'&&!(result.reason instanceof LocalWorkbenchPlanError&&result.reason.code==='CHANGED'))throw result.reason;
        await workbenchWriter!.removeLibrary(libraryId);
        const registry=await workbenchRegistry!,snapshot=collection.localCatalog.privateWorkbenchSnapshot(identity.datasetId);
        for(const entry of snapshot?.entries??[])if(entry.capture.albums.some(album=>album.rootId===libraryId)&&entry.original){
          if(entry.capture.albums.some(album=>!removingLibraries.includes(album.rootId))&&(!entry.receipt||['unknown','running'].includes(entry.receipt.state)))throw new DatasetWorkbenchWireError('NOT_READY');
          if(entry.plan.kind==='cue'){
            if(!cueActor)throw new DatasetWorkbenchWireError('NOT_READY');
            await cueActor.cancel({cancelCommandId:randomUUID(),original:entry.original});await cueActor.join(entry.original.commandId);
            const physical=collection.localCatalog.privateCueOutputRead(identity,entry.original.commandId);
            if(!physical?.record.physicalClosed||!['succeeded','failed','cancelled'].includes(physical.record.phase))throw new DatasetWorkbenchWireError('NOT_READY');
          }
          const receipt=await registry.readOriginalReceipt(entry.original);
          if(!receipt||['unknown','running'].includes(receipt.state)||receipt.items.some(item=>item.state==='unknown'))throw new DatasetWorkbenchWireError('NOT_READY');
        }
        const lyrics=collection.localCatalog.privateLyricsLibraryRecords(identity,libraryId);
        if(lyricsRuntime)await lyricsRuntime.removeLibrary(libraryId);
        else if(lyrics.jobs.some(job=>['queued','running','unknown'].includes(job.snapshot.state))||lyrics.saves.some(save=>!save.physicalClosed||['unknown','running'].includes(save.receipt.state))
          ||collection.localCatalog.privateLyricsPhysicalPending(identity).some(value=>value.record.binding.libraryId===libraryId))throw new DatasetWorkbenchWireError('NOT_READY');
        await localSourceWrites.privateStopLibrary(libraryId,{identity,commandId:original.commandId,originalSha256:original.originalSha256});
        // 原已受理Core writer仍可能消费Main私有图/目录；先cancel/join原writer，再封Main原库读取。
        if(options.sourceWritesMainActor){
          await traceLibraryRemoval('owner.fence',original.commandId,()=>requestSourceWorkbenchReadersStop(options.sourceWritesMainActor!,{...original,libraryId,datasetId:identity.datasetId,ownerEpoch:ownerContext.identity.epoch},ownerContext));accepting();
        }else if(!test)throw new DatasetWorkbenchWireError('NOT_READY');
        await Promise.all([localArtwork.removeLibrary(libraryId),albumRuntime.artwork.removeLibrary(libraryId)]);
        workbenchRead!.invalidateRoot(libraryId);albumRuntime.localAlbums.invalidateRoot(libraryId);
        for(const [key,value]of cueSources)if(value.rootId===libraryId)cueSources.delete(key);
        accepting();
      },
      async beforeSnapshotRetry(libraryId,jobId,context){
        const ownerContext=managementContexts.get(context);if(!ownerContext)throw new DatasetWorkbenchWireError('NOT_READY');
        const accepting=()=>assertWorkbench(ownerContext);accepting();const job=collection.localScan.get(jobId),root=collection.localCatalog.root(libraryId),source=collection.sources.root(root.sourceRootId);
        if(!collection.localCatalog.privateLibraryManagementRootAvailable(libraryId)||job.datasetId!==identity.datasetId||job.libraryRootId!==libraryId||job.phase!=='completed'
          ||job.rootRevision!==root.revision||job.sourceRootId!==source.id||!source.authorized||await sourceRootAvailability(source)!=='ONLINE')throw new DatasetWorkbenchWireError('NOT_READY');
        const rows=collection.localCatalog.privateRead(db=>db.prepare("SELECT request FROM local_scan_batches WHERE job_id=? AND phase='committed' ORDER BY rowid").all(jobId));
        let count=0,bytes=0;for(const row of rows){if(typeof row.request!=='string'||(bytes+=Buffer.byteLength(row.request))>32*1024*1024)throw new DatasetWorkbenchWireError('NOT_READY');
          const batch=JSON.parse(row.request) as import('./local-scan-store.js').ScanPreparedBatch;
          for(const item of batch.items){accepting();if(++count>10000||context.signal?.aborted)throw new DatasetWorkbenchWireError('NOT_READY');
            const current=collection.localScan.privateSourceWriteFileState(libraryId,item.relative),physical=await readonlySourceCandidateMetadata(source,item.relative);
            if(!current||current.jobId!==jobId||current.value.signature!==item.signature||physical.signature!==item.signature)throw new DatasetWorkbenchWireError('NOT_READY');}}
        if(!rows.length||collection.localCatalog.root(libraryId).revision!==root.revision||!collection.localCatalog.privateLibraryManagementRootAvailable(libraryId))throw new DatasetWorkbenchWireError('NOT_READY');
        accepting();
      },
      async activateSnapshot(libraryId,snapshot){
        assertWorkbench();const actual=completedScanSnapshots.load(libraryId).lastSuccess;
        if(!actual||lyricsPhysicalDigest(actual)!==lyricsPhysicalDigest(snapshot))throw new LocalWorkbenchPlanError('CHANGED','原完成快照已改变。');
        albumRuntime.localAlbums.invalidate();workbenchRead!.invalidateRoot(libraryId);
      },
      imports:{
        async prepare(context){
          assertWorkbench();const entry=[...approvedDirectories.values()].filter(value=>value.active&&!value.ownerClosed&&value.binding.kind==='library')
            .sort((a,b)=>b.binding.issuedAtMs-a.binding.issuedAtMs)[0];
          if(!entry)return null;
          const ownerContext=managementContexts.get(context);if(!ownerContext)throw new DatasetWorkbenchWireError('NOT_READY');
          assertWorkbench(ownerContext);entry.suggestion=await readLibrarySuggestion(entry,ownerContext);assertWorkbench(ownerContext);
          return entry.suggestion;
        },
        async confirm(request,context){
          assertWorkbench();const operation=collection.localCatalog.privateLibraryManagementRead(identity,'operation',request.commandId);
          if(!operation||operation.record.original.command!=='library.import.confirm'
            ||lyricsPhysicalDigest(operation.record.original.request)!==lyricsPhysicalDigest(request))throw new LocalWorkbenchPlanError('CHANGED','导入必须先持久受理同一原命令。');
          const entry=approvedDirectories.get(request.choiceId);
          if(!entry?.active||entry.ownerClosed||entry.binding.kind!=='library')throw new LocalWorkbenchPlanError('CHANGED','原目录选择已消费或撤销。');
          const ui:SourceWorkbenchDirectoryUi={family:'management',command:'library.import.confirm',commandId:request.commandId,
            requestSha256:datasetWorkbenchSha(datasetWorkbenchJson({command:'library.import.confirm',payload:request}))};
          const ownerContext=managementContexts.get(context);
          if(!ownerContext)throw new DatasetWorkbenchWireError('NOT_READY');
          assertWorkbench(ownerContext);
          const approved=await revalidateDirectory(request.choiceId,entry.binding.revision,ui,ownerContext.signal,ownerContext.deadlineAtMs);
          assertWorkbench();const {id:_choiceId,...capability}=approved,source=collection.sources.authorize(request.commandId,capability);
          const registered=collection.localCatalog.registerRoot({commandId:request.commandId,sourceRootId:source.id,role:'library'});
          await consumeLibraryDirectory(request.choiceId);return registered;
        },
        async readOriginal(commandId){
          assertWorkbench();const operation=collection.localCatalog.privateLibraryManagementRead(identity,'operation',commandId);
          if(!operation||operation.record.original.command!=='library.import.confirm')return null;
          const source=collection.sources.rootReceipt(commandId),registered=collection.localCatalog.receipt(commandId);
          if(!source||!registered||registered.operation!=='register-root'||!workbenchDto.isLibraryRoot(registered.result))return null;
          const choiceId=operation.record.original.request.choiceId;
          if(approvedDirectories.has(choiceId)||directoryClosures.has(choiceId))await consumeLibraryDirectory(choiceId);
          assertWorkbench();
          const root=collection.localCatalog.root(registered.result.id);
          if(root.sourceRootId!==source.id||root.revision!==registered.result.revision||root.role!=='library')throw new LocalWorkbenchPlanError('CHANGED','原Source与LibraryRoot回执不一致。');
          return {original:operation.record.original,root,state:'succeeded'};
        },
      },
      watch:{
        async enable(rootId){if(!libraryWatch)throw new DatasetWorkbenchWireError('NOT_READY');await libraryWatch.enable(rootId);},
        async disable(rootId){return libraryWatch?libraryWatch.disable(rootId):null;},
        async remove(rootId){return libraryWatch?libraryWatch.remove(rootId):null;},
        watching:rootId=>libraryWatch?.watching(rootId)??false,
        async close(){await libraryWatch?.close();},
      },
    });
  }
  async function prepareLibraryWatch():Promise<void>{
    const resource=options.localWorkbenchNative?.watch;if(!resource)return;
    const bundle=await loadLibraryWatchBundle(resource.root,resource.manifestSha256);
    directoryStructureBundle=bundle;
    libraryWatch=createLibraryWatchRegistry({bundle,
      async acquireRoot(rootId){
        assertWorkbench();const original=collection.localCatalog.root(rootId),source=collection.sources.root(original.sourceRootId);
        if(original.role!=='library'||!source.authorized||await sourceRootAvailability(source)!=='ONLINE')throw new DatasetWorkbenchWireError('NOT_READY');
        const fd=await open(source.path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
        const first=await fd.stat({bigint:true}),generation=lyricsPhysicalDigest([identity.datasetId,options.localSourceEpoch,original,source]);
        let released=false;
        const assertCurrent=async():Promise<void>=>{
          assertDataset();if(released||!scanBootReady||lyricsPhysicalDigest(collection.localCatalog.root(rootId))!==lyricsPhysicalDigest(original)
            ||lyricsPhysicalDigest(collection.sources.root(source.id))!==lyricsPhysicalDigest(source))throw new DatasetWorkbenchWireError('NOT_READY');
          const actual=await fd.stat({bigint:true}),named=await lstat(source.path,{bigint:true});
          if(!actual.isDirectory()||named.isSymbolicLink()||!named.isDirectory()||await realpath(source.path)!==source.path
            ||String(actual.dev)!==source.dev||String(actual.ino)!==source.ino
            ||(['dev','ino','birthtimeNs','mode','uid','gid'] as const).some(field=>actual[field]!==first[field]||actual[field]!==named[field]))
            throw new DatasetWorkbenchWireError('NOT_READY');
        };
        try{await assertCurrent();}catch(error){await fd.close();throw error;}
        return {root:fd,generation,assertCurrent,async release(){
          if(!released)await fd.close();
          try{await fd.stat();throw new Error('监听目录FD关闭未核实。');}catch(error){if((error as NodeJS.ErrnoException).code!=='EBADF')throw error;}
          released=true;
        }};
      },
      async invalidate(rootId){
        assertWorkbench();albumRuntime.localAlbums.invalidate();workbenchRead!.invalidateRoot(rootId);
        for(const [key,value] of cueSources)if(value.rootId===rootId)cueSources.delete(key);
        const pending=collection.localCatalog.privateLyricsPhysicalPending(identity).filter(value=>value.record.binding.libraryId===rootId);
        for(const commandId of new Set(pending.map(value=>value.record.binding.commandId))){
          if(!lyricsRuntime)throw new DatasetWorkbenchWireError('NOT_READY');
          await lyricsRuntime.joinOriginalWrite(commandId);
        }
        assertWorkbench();const root=collection.localCatalog.root(rootId);
        localScan.start({commandId:randomUUID(),libraryRootId:root.id,expectedRootRevision:root.revision});
      },
    });
  }
  function prepareWorkbench():Promise<void>{
    if(workbenchPreparation)return workbenchPreparation;
    workbenchPreparation=(async()=>{
      if(!options.collectionDatasetIdentity||!workbenchRead||!workbenchRegistry)return;
      await workbenchRegistry;
      libraryManagement=createManagementRuntime();
      await prepareLibraryWatch();
      const pendingLyrics=collection.localCatalog.privateLyricsPhysicalPending(identity),pendingCue=collection.localCatalog.privateCueOutputPending(identity);
      if(pendingLyrics.length||pendingCue.length){workbenchRecoveryFailure=new Error('原CUE或歌词物理保护尚未完整恢复，prepare不发送ACK。');throw workbenchRecoveryFailure;}
      const native=options.localWorkbenchNative;if(!native?.cue||!native.tags||!options.sourceWritesMainActor||!options.projection)return;
      assertSourceWritesMainActor(options.sourceWritesMainActor);const safety=localSourceWrites.privateLyricsSafety();await privateWorkbenchDirectory(safety.temporaryRoot);
      const evidenceRoot=path.join(safety.temporaryRoot,'cue-qualification-'+options.localSourceEpoch);await privateWorkbenchDirectory(evidenceRoot);
      cueQualification=await qualifyCueEightFormats({cueRoot:native.cue.root,cueManifestSha256:native.cue.manifestSha256,tagsRoot:native.tags.root,tagsManifestSha256:native.tags.manifestSha256,evidenceRoot});
      cueNative=createCueNativeActor(await loadBundledCueConverter(native.cue.root,native.cue.manifestSha256));cueTags=createLocalAudioTagsActor(await loadLocalAudioTagsBundle(native.tags.root,native.tags.manifestSha256));
      cueActor=createLocalCueOutputActor({identity,store:{read:collection.localCatalog.privateCueOutputRead,compareAndSwap:collection.localCatalog.privateCueOutputCompareAndSwap},native:cueNative,tags:cueTags,qualification:cueQualification,
        assertAccepting:()=>{assertWorkbench();assertSourceWritesMainActor(options.sourceWritesMainActor!);},
        assertOriginal(request,plan,capture){assertDataset();const entry=collection.localCatalog.privateWorkbenchSnapshot(identity.datasetId)?.entries.find(value=>value.plan.planId===plan.planId);
          if(!entry?.original||lyricsPhysicalDigest(entry.original)!==lyricsPhysicalDigest(request)||lyricsPhysicalDigest(entry.plan)!==lyricsPhysicalDigest(plan)||lyricsPhysicalDigest(entry.capture)!==lyricsPhysicalDigest(capture))throw new LocalWorkbenchPlanError('CHANGED','CUE不是原同SQL已持久受理的命令。');},
        revalidate:revalidateCueCapture,
        async assertTargetCurrent(capture,outputRoot){
          const entry=capture.target?approvedDirectories.get(capture.target.choiceId):undefined;
          if(!entry?.active||entry.binding.kind!=='cue'||entry.root.id!==outputRoot.id||entry.root.path!==outputRoot.path||entry.root.dev!==outputRoot.dev||entry.root.ino!==outputRoot.ino)
            throw new LocalWorkbenchPlanError('CHANGED','原实际Main输出批准已撤销。');
          const physical=assertSourceWorkbenchDirectoryApproval(entry.approval,options.sourceWritesMainActor!,entry.binding,entry.ui);await assertDirectory(entry,physical);
        },
        source(capture,binding){const source=cueSources.get(binding.sourceReadRevision),probe=capture.audio?.find(value=>value.readRevision===binding.sourceReadRevision);
          if(!source||!probe||lyricsPhysicalDigest(source.probe)!==lyricsPhysicalDigest(probe)||probe.assetReference.assetId!==binding.sourceAssetId||source.rootId!==binding.libraryRootId||source.source.root.id!==binding.sourceRootId)throw new LocalWorkbenchPlanError('CHANGED','原CUE实际源读取身份改变。');return source.source;},
        async target(capture){await revalidateCueCapture(capture);return approvedDirectories.get(capture.target!.choiceId)!.root;},
      });
      lyricsNative=await createLyricsNativeFidelityPort({cueRoot:native.cue.root,cueManifestSha256:native.cue.manifestSha256,tagsRoot:native.tags.root,tagsManifestSha256:native.tags.manifestSha256,temporaryRoot:safety.temporaryRoot});
      lyricsTags=createLocalAudioTagsActor(await loadLocalAudioTagsBundle(native.tags.root,native.tags.manifestSha256));
      lyricsRuntime=createLocalWorkbenchRootLyricsRuntime({identity,ownerEpoch:options.localSourceEpoch!,repository:collection,catalog:collection.localCatalog,
        workbench:workbenchRead,library:libraryManagement.lyricsLibraryAuthor,readFrozenAlbum:scope=>libraryManagement!.readFrozenAlbum(scope),
        mainActor:options.sourceWritesMainActor,native:lyricsNative,tags:lyricsTags,sourceSafety:safety.sourceSafety,
        projection:options.projection,plans:()=>workbenchRegistry!,coverWriter:workbenchWriter!,assertAccepting:assertDataset});
    })();void workbenchPreparation.catch(()=>{});return workbenchPreparation;
  }
  async function dispatchWorkbenchOwner(request: DatasetWorkbenchOwnerRequest, context: DatasetWorkbenchExecutionContext): Promise<DatasetWorkbenchOwnerResult> {
    assertWorkbench(context); if (!isDatasetWorkbenchOwnerRequest(request)) throw new LocalWorkbenchPlanError('INVALID_REQUEST', '工作台私有请求不符合原闭集。');
    const registry = await workbenchRegistry!; assertWorkbench(context);
    let value: DatasetWorkbenchOwnerResult;
    switch (request.command) {
      case 'lifecycle.mainReady':
        if (workbenchClose || workbenchLife.signal.aborted) throw new DatasetWorkbenchWireError('NOT_READY');
        // Main确认只开启原调度；start保留持久暂停/取消，不能替换为resume。
        if (options.collectionDatasetIdentity && options.projection) albumRuntime.background?.start();
        // commitBoot仍在Main资源恢复之前；艺人补读只能在本代Main实际就绪后启动。
        if (!artistMainReady) { artistMainReady = true; artistBackfill?.start(); }
        value = true; break;
      case 'read.albums':
        value = await workbenchRead!.readAlbums(request.payload, context);
        if(!libraryManagement)throw new DatasetWorkbenchWireError('NOT_READY');
        await libraryManagement.rememberAlbumReadback(value,context);break;
      case 'read.resolveCapture': value = await workbenchRead!.resolveCapture(request.payload, context); break;
      case 'read.prepareNameSuggestion': value = await workbenchRead!.prepareNameSuggestion(request.payload, context); break;
      case 'read.completeNameSuggestion': value = await workbenchRead!.completeNameSuggestion(request.payload.preparationId, request.payload.response, context); break;
      case 'read.prepareNamePreview': value = await workbenchRead!.prepareNamePreview(request.payload, context); break;
      case 'read.prepareArtworkPreview': {
        const resolved = await workbenchRead!.resolveCapture(request.payload.reference, context);
        value = await workbenchRead!.prepareArtworkPreview({ resolved, artwork: request.payload.artwork }, context); break;
      }
      case 'read.cancelNamePreparation': value = workbenchRead!.cancelNamePreparation(request.payload.preparationId); break;
      case 'registry.issuePlan': {
        value = await registry.issuePlan(request.payload.draft, request.payload.capture);
        if (value.kind === 'ai') workbenchWriter!.originRoutes.registerAiPreviewPlan(value.planId);
        break;
      }
      case 'registry.apply': {
        const entry=registry.inspect().entries.find(item=>item.plan.planId===request.payload.planId);
        if(entry?.plan.kind==='cue'&&entry.capture.target){
          const ui:SourceWorkbenchDirectoryUi={family:'workbench',command:'localWorkbench.plan.apply',commandId:request.payload.commandId,
            requestSha256:datasetWorkbenchSha(datasetWorkbenchJson({command:'localWorkbench.plan.apply',payload:request.payload}))};
          await revalidateDirectory(entry.capture.target.choiceId,entry.capture.target.revision,ui,context.signal,context.deadlineAtMs);
        }
        value = await registry.apply(request.payload); break;
      }
      case 'registry.readOriginalReceipt': value = await registry.readOriginalReceipt(request.payload); break;
      case 'registry.cancel': value = await registry.cancel(request.payload); break;
      case 'registry.getPlan': value = registry.getPlan(request.payload.planId); break;
      case 'registry.readArtworkCapture': value = registry.readArtworkCapture(request.payload); break;
      case 'registry.operations': value = registry.operations(); break;
      case 'artwork.readLocal': {
        const resolved = await workbenchRead!.resolveCapture(request.payload, context), group = resolved.group;
        const source = await albumRuntime.artwork.readSources({ request: { albumKey: group.summary.id, rootId: group.summary.rootId, editionId: group.summary.editionId,
          representativeTrackId: group.summary.representativeTrackId, revision: group.summary.revision }, context: { album: group.summary, directory: group.directory,
          representative: group.members.find(member => member.fact.hasArtwork)?.fact ?? group.members.find(member => member.fact.summary.track.id === group.summary.representativeTrackId)?.fact ?? null } }, randomUUID(), context.signal, context.deadlineAtMs);
        await workbenchRead!.resolveCapture(request.payload, context); value = source.copies; break;
      }
      case 'capabilities.read': {
        const capabilities: workbenchDto.LocalWorkbenchCapabilitiesReply = { capabilities: {}, artworkSources: [], artworkImportFormats: [], aiBackends: [], cueFormats: [], existingActions: {} };
        for (const key of workbenchDto.LOCAL_WORKBENCH_CAPABILITIES) capabilities.capabilities[key] = { available: false, reason: '此能力尚待实际 Main 或 Native 作者接线与核验。' };
        for (const key of ['read', 'artwork-local', 'artwork-preview', 'ai-preview', 'apply', 'receipt'] as const) capabilities.capabilities[key] = { available: true };
        if(cueActor&&cueNative&&cueTags&&cueQualification){
          capabilities.capabilities['cue-preview']={available:true};capabilities.capabilities['cancel-application']={available:true};
          capabilities.cueFormats=[{id:'auto',label:'保持原格式（无法保持时 FLAC）',availability:{available:true as const}},...readCueQualifiedFormats(cueQualification).map(value=>({id:value.formatId,label:value.formatId.toUpperCase(),availability:{available:true as const}}))];
        }
        value = capabilities; break;
      }
      case 'cue.preparePreview': value=await cuePreview(request.payload,context);break;
      case 'existing.open': value = { opened: false, reason: '实际 Main 页面或 Finder 路由尚未接入。' }; break;
    }
    assertWorkbench(context); if (!isDatasetWorkbenchOwnerResult(request.command, value, request.payload, identity.datasetId)) throw new LocalWorkbenchPlanError('INVALID_REQUEST', '工作台私有结果与原请求不匹配。');
    return value;
  }
  async function dispatchWorkbench(request:DatasetWorkbenchRequest,context:DatasetWorkbenchExecutionContext):Promise<DatasetWorkbenchResult>{
    assertWorkbench(context);if(!isDatasetWorkbenchRequest(request))throw new DatasetWorkbenchWireError('INVALID_IPC_REQUEST');
    let value:DatasetWorkbenchResult;
    if(request.family==='management'){
      if(!libraryManagement)throw new DatasetWorkbenchWireError('NOT_READY');
      managementContexts.set(context,context);
      try{value=await libraryManagement.execute(request.command,request.payload,context);}finally{managementContexts.delete(context);}
    }else if(request.family==='lyrics'){
      if(!lyricsRuntime)throw new DatasetWorkbenchWireError('NOT_READY');
      value=await lyricsRuntime.execute(request.command,request.payload);
    }else{
      // 独立保险库和配置由实际Main边界处理；Root不持有凭据或伪造Main结果。
      throw new DatasetWorkbenchWireError('NOT_READY');
    }
    assertWorkbench(context);if(!isDatasetWorkbenchResult(request,value,identity.datasetId))throw new DatasetWorkbenchWireError('INVALID_IPC_RESPONSE');
    return value;
  }
  function closeWorkbench(): Promise<void> {
    if (workbenchClose) return workbenchClose;
    workbenchClose = (async () => {
      workbenchLife.abort();
      const failures: unknown[] = [];
      // 新输入先封；实际job/provider/写作者、Native和原目录FD静止以后才交还SQL。
      for (const close of [() => albumRuntime.background?.close(), () => workbenchPreparation, () => libraryManagement?.close(), () => libraryWatch?.close(), () => lyricsRuntime?.close(),
        () => lyricsNative?.close(), () => lyricsTags?.close(), () => cueActor?.close(), () => cueNative?.close(), () => cueTags?.close(),
        () => Promise.allSettled([...cuePreparations.values()]), () => Promise.all([...directoryClosures.values()]),
        () => Promise.allSettled([...roleProbeFlights]),
        () => workbenchRegistry, () => workbenchWriter?.close(), () => workbenchRead?.close()]) {
        try { await close(); } catch (error) { failures.push(error); }
      }
      failures.push(...roleProbeUnknown.values());
      // 探测取消不等于子FD闭口；实际close/EBADF全部成立才从私有保留集合移除。
      for(const fd of [...roleProbeFds])try{await fd.close();try{await fd.stat();throw new Error('原角色探测子FD仍开启。');}
        catch(error){if((error as NodeJS.ErrnoException).code!=='EBADF')throw error;}roleProbeFds.delete(fd);}catch(error){failures.push(error);}
      // 上层物理收口有失败时，目录与SQL仍须保留，不能把port.close当FD静止。
      if(!failures.length)for(const entry of approvedDirectories.values()){
        try{entry.active=false;if(!entry.ownerClosed)await entry.fd.close();try{await entry.fd.stat();throw new Error('原目录FD仍开启。');}catch(error){if((error as NodeJS.ErrnoException).code!=='EBADF')throw error;}
          entry.ownerClosed=true;
          if(options.sourceWritesMainActor?.active)invalidateSourceWorkbenchDirectory(options.sourceWritesMainActor,entry.binding);
        }catch(error){failures.push(error);}
      }
      if(!failures.length)approvedDirectories.clear();
      if(workbenchRecoveryFailure)failures.push(workbenchRecoveryFailure);
      if (failures.length) throw new AggregateError(failures, '工作台收尾未核实，保留原账本连接。');
    })();
    return workbenchClose;
  }
  function readLyricsGrantOriginal(input:LocalLyricsPhysicalBinding,revision:number,context:{identity:{epoch:string;datasetId:string};mainActor:SourceWritesMainActor}):SourceWritesLyricsOriginalEvidence{
    assertWorkbench();const binding=captureLocalLyricsPhysicalBinding(input);
    if(context.mainActor!==options.sourceWritesMainActor||context.identity.epoch!==options.localSourceEpoch||context.identity.datasetId!==identity.datasetId
      ||binding.ownerEpoch!==context.identity.epoch||binding.datasetId!==identity.datasetId||!Number.isSafeInteger(revision)||revision<1)throw new LocalLyricsError('STALE');
    assertSourceWritesMainActor(context.mainActor);
    const policy=collection.localCatalog.privateSourceWritesRead(view=>sourceWritesPolicy(view.projection,identity.datasetId));if(!policy.enabled||policy.draining)throw new LocalLyricsError('CLOSED');
    const physical=collection.localCatalog.privateLyricsPhysicalRead(identity,localLyricsPhysicalOperationId(binding)),saved=collection.localCatalog.privateLyricsRecord(identity.datasetId,'save',binding.commandId) as LocalLyricsSaveRecord|null;
    if(!physical||!saved)throw new LocalLyricsError('NOT_FOUND');assertLocalLyricsSaveRecord(saved);const record=physical.record;
    const {ownerEpoch:_old,...original}=record.binding,{ownerEpoch:_new,...current}=binding;
    if(lyricsPhysicalDigest(original)!==lyricsPhysicalDigest(current)||record.revision!==revision||!['PREPARED','FAILED'].includes(record.phase)||record.unresolved||saved.discarded
      ||record.phase==='PREPARED'&&(record.physicalClosed||record.protectionReleased)||record.phase==='FAILED'&&(!record.physicalClosed||!record.protectionReleased)
      ||lyricsPhysicalDigest(saved.intent)!==binding.originalIntentSha256||lyricsPhysicalDigest(saved.intent.request)!==binding.originalRequestSha256
      ||saved.intent.captureFingerprint!==binding.groupCaptureSha256||saved.intent.fingerprint!==binding.intentFingerprint||lyricsPhysicalDigest(record.original)!==binding.protectionSha256)throw new LocalLyricsError('STALE');
    const selected=saved.intent.selected.find(s=>s.track.trackId===binding.trackId);if(!selected||selected.candidateId!==binding.candidateId||selected.sha256!==binding.bodySha256
      ||saved.intent.scope.datasetId!==binding.datasetId||saved.intent.scope.libraryId!==binding.libraryId||saved.intent.scope.albumId!==binding.albumId||saved.intent.scope.captureId!==binding.captureId
      ||saved.intent.request.commandId!==binding.commandId||saved.intent.request.sessionId!==binding.sessionId||binding.kind==='embed'&&!saved.intent.request.embed)throw new LocalLyricsError('STALE');
    const jobOrigin=collection.localCatalog.privateLyricsJobOrigin(identity,saved.intent.request,saved.intent.scope);
    collection.localCatalog.privateLyricsPhysicalAssertOriginal(identity,record.operationId,revision);
    const result=captureSourceWritesLyricsOriginalEvidence({originalBinding:record.binding,request:saved.intent.request,phase:record.phase,revision:record.revision,recordOwnerEpoch:record.currentOwnerEpoch,currentOwnerEpoch:context.identity.epoch,
      physicalClosed:record.physicalClosed,protectionReleased:record.protectionReleased,unresolved:false,ledgerSequence:physical.ledgerSequence,
      originalIntentSha256:binding.originalIntentSha256,originalRequestSha256:binding.originalRequestSha256,groupCaptureSha256:binding.groupCaptureSha256,protectionSha256:binding.protectionSha256,jobOrigin});
    assertWorkbench();return result;
  }
  const localOrganizer = createLocalOrganizerService({ repository: collection, datasetId: identity.datasetId, assertCurrent: () => { assertOpen(); if (!scanBootReady) throw new CollectionError('INVENTORY_UNAVAILABLE', '整理owner尚未commitBoot。'); } });
  const localLegacyLinks = createLocalLegacyLinksService({repository:collection,datasetId:identity.datasetId,assertCurrent:()=>{assertOpen();if(!scanBootReady)throw new CollectionError('INVENTORY_UNAVAILABLE','旧库关联 owner 尚未 commitBoot。');}});
  const localSourceWrites=createLocalSourceWritesService({repository:collection,datasetId:identity.datasetId,...(options.localSourceEpoch?{ownerEpoch:options.localSourceEpoch}:{}),
    ...(options.collectionDatasetIdentity?{readClosingSourceRecovery:(judge:(projection:import('./local-source-writes-journal.js').SourceWritesProjection)=>boolean)=>collection.localCatalog.privateSourceWritesClosingRead(identity,judge)}:{}),
    assertCurrent:()=>{assertDataset();if(!scanBootReady)throw new CollectionError('INVENTORY_UNAVAILABLE','源写 Owner 尚未 commitBoot。');},assertRecoveryCurrent:assertDataset,beforeMedia:()=>localScan.yieldForMedia()});
  const localRelocationPlans = createLocalRelocationService({ repository: collection, datasetId: identity.datasetId, ...(options.localSourceEpoch ? { ownerEpoch: options.localSourceEpoch } : {}),
    assertCurrent: () => { assertDataset(); if (!scanBootReady) throw new CollectionError('INVENTORY_UNAVAILABLE', '搬迁Owner尚未commitBoot。'); }, assertRecoveryCurrent: assertDataset, beforeMedia: () => localScan.yieldForMedia() });
  const backups = createBackupCoordinator({ store: maintenanceForCoordinator, repository: collection, ...(options.backupPrivateRoot ? { privateRoot: options.backupPrivateRoot } : {}), ...(options.backupContentBinding ? { contentBinding: options.backupContentBinding } : {}) });
  const sources = createSourceEvidenceService({ store: collection.sources, drafts: collection.drafts, validateAuthorization: root => assertSourceOutsideArchives(root.path, collection.archive) });
  const sourceCandidates = createSourceCandidateService({ store: collection.sources, drafts: collection.drafts, sources });
  const mediaPlanning = createMediaPlanningCoordinator({ store: collection.media, drafts: collection.drafts, sources });
  const masterVersions = createMasterVersionsCoordinator({ store: collection.versions, mediaStore: collection.media, media: mediaPlanning, drafts: collection.drafts, sourceStore: collection.sources, sources });
  const preparation = createPreparationCoordinator({ store: collection.preparations, sourceStore: collection.sources, sources });
  const preparationZips = createPreparationZipCoordinator({
    store: collection.preparationZips, preparations: collection.preparations, datasetId: identity.datasetId, assertDataset,
    protectedRoots: () => [...collection.sources.roots(), ...collection.preparations.destinations(), ...collection.archive.candidates().map(candidate => candidate.parent), ...collection.archive.operations().flatMap(operation => operation.owned ? [operation.owned.archive.root] : []), ...(options.backupContentBinding?.protectedRoots ?? []), ...(options.backupPrivateRoot ? [options.backupPrivateRoot] : [])],
  });
  const prepared = createPreparedCoordinator({ store: collection.prepared, preparationStore: collection.preparations, preparation, sourceStore: collection.sources });
  const execution = createExecutionCoordinator({ store: collection.execution, profiles: collection.recordingProfiles, preparationStore: collection.preparations, preparedStore: collection.prepared, mediaStore: collection.media, sourceStore: collection.sources, sources, preparation, ...(options.recordingConverter ? { converter: options.recordingConverter } : {}) });
  const archive = createArchiveCoordinator({ store: collection.archive, executionStore: collection.execution, preparationStore: collection.preparations, sourceStore: collection.sources, sources, preparation });
  let recordingAttempts: RecordingAttemptCoordinator;
  let recordingReplica: RecordingReplicaCoordinator;
  const devicePin = test ? undefined : options.recordingDeviceOutputHelper;
  const outputRecoveryReady = () => !options.collectionDatasetIdentity || options.recordingOutputRunRecovery?.safe === true;
  const recordingDeviceSelection = test ? test.recordingPlanDeviceSelection : createRecordingDeviceSelectionBroker({
    ...(devicePin ? { catalog: createNativeReadonlyDeviceCatalog(devicePin), pin: devicePin } : {}),
    assertCurrent: assertDataset, assertIdle: () => { recordingAttempts?.assertExecutionIdle(); recordingReplica?.assertExecutionIdle(); }, outputRecoveryReady,
  });
  const gateB = test ? test.recordingPlanGateB : devicePin && recordingDeviceSelection ? createProductionGateBAdmission({ recordPath: path.join(path.dirname(path.dirname(devicePin.path)), 'GateBComplete.json'), candidate: options.recordingGateBCandidate ?? null, observeExact: recordingDeviceSelection.observeExactForAdmission }) : undefined;
  const recordingPlans = createRecordingPlanCoordinator({ store: collection.recordingPlans, ...(recordingDeviceSelection ? { deviceSelection: recordingDeviceSelection } : {}), ...(gateB ? { gateB } : {}) });
  const recordingOutput = createRecordingOutputService({ store: collection.recordingPlans, ...(options.recordingOutputHelper ? { helper: options.recordingOutputHelper } : {}) });
  const admissionProvider = test ? test.recordingAttemptAdmissionProvider : devicePin && recordingDeviceSelection && gateB ? createFormalDeviceAttemptProvider({ pin: devicePin, deviceSelection: recordingDeviceSelection, gateB, outputRecoveryReady, ...(options.collectionDatasetIdentity && options.recordingLeaseDatabaseFile ? { leaseScope: { databaseFile: options.recordingLeaseDatabaseFile, datasetId: identity.datasetId } } : {}) }) : undefined;
  // 身份断言在shutdown期间仍允许真实quiet/barrier持久化；新入口另由assertOpen封锁。
  recordingAttempts = createRecordingAttemptCoordinator({ store: collection.recordingAttempts, ...(admissionProvider ? { admissionProvider } : {}), assertReplicaIdle: () => recordingReplica?.assertExecutionIdle(), assertCurrent: assertDataset });
  const recordingRecords = createRecordingRecordCoordinator({ store: collection.recordingRecords, assertCurrent: assertDataset, assertExecutionIdle: () => recordingAttempts.assertExecutionIdle() });
  const recordingPrints = createRecordingPrintCoordinator({ store: collection.recordingPrints, assertCurrent: assertDataset });
  const replicaInput = createRecordingReplicaInput({ repository: collection, assertCurrent: assertDataset, ...(options.backupContentBinding ? { contentBinding: options.backupContentBinding } : {}) });
  const replicaDeviceSession = !test && devicePin && recordingDeviceSelection ? createReplicaDeviceSessionCoordinator({ input: replicaInput, provider: createReplicaDeviceOutputProvider({ pin: devicePin, deviceSelection: recordingDeviceSelection }), currentSelection: recordingDeviceSelection.current, assertCurrent: assertDataset, assertAttemptIdle: () => recordingAttempts.assertExecutionIdle(), outputRecoveryReady }) : undefined;
  recordingReplica = createRecordingReplicaCoordinator({ input: replicaInput, ...(replicaDeviceSession ? { deviceSession: replicaDeviceSession } : {}), assertCurrent: assertDataset, assertAttemptIdle: () => recordingAttempts.assertExecutionIdle() });
  const library = options.projection ? undefined : options.roonLibrary ?? createRoonPublicLibrary(() => undefined);
  const projection = options.projection ? createCollectionRoonProjectionPort(options.projection, assertOpen) : undefined;
  const physicalLinks = projection ? createProjectedPhysicalLinksCoordinator({ repository: collection.links, projection, assertCurrent: assertOpen }) : createPhysicalLinksCoordinator({ repository: collection.links, library: library! });
  const masterDrafts = projection ? createProjectedMasterDraftsCoordinator({ repository: collection.drafts, projection, assertCurrent: assertOpen }) : createMasterDraftsCoordinator({ repository: collection.drafts, library: library! });
  const domain: DatasetDomain = {
    prepareWorkbench,registerWorkbenchDirectory,revokeWorkbenchDirectory,
    async workbenchContext() { assertWorkbench(); await workbenchRegistry; assertWorkbench(); return { epoch: options.localSourceEpoch!, datasetId: identity.datasetId, ready: true }; },
    async workbenchReadIdentity() { assertWorkbench(); return { epoch: options.localSourceEpoch!, datasetId: identity.datasetId, ready: true }; },
    dispatchWorkbench: (request,context)=>trackWorkbench(context,()=>dispatchWorkbench(request,context)),
    dispatchWorkbenchOwner: (request, context) => trackWorkbench(context, () => dispatchWorkbenchOwner(request, context)),
    readLyricsGrantOriginal,
    closeWorkbench,
    datasetId: identity.datasetId, collection, localScan, localRelocation, localRelocationPlans, localArtwork, localAlbums: albumRuntime.localAlbums, localArtists, localOrganizer, localLegacyLinks, localSourceWrites, commandOutbox, sources, sourceCandidates, mediaPlanning, masterVersions, preparation, preparationZips, prepared, execution, backups, archive,
    ...(recordingDeviceSelection ? { recordingDeviceSelection } : {}), recordingPlans, recordingOutput, recordingAttempts, recordingRecords, recordingPrints, recordingReplica, physicalLinks, masterDrafts, assertOpen,
    dispatch(request) {
      const artistInteraction = artistInteractiveCommands.has(request.command);
      if (artistInteraction) artistInteractionQuietUntil = performance.now() + ARTIST_INTERACTION_QUIET_MS;
      const pending = dispatchDatasetCommand(domain, request);
      pendingDispatches.add(pending);
      return pending.finally(() => {
        // 从回包时重新计时，包含准备中与失败；慢请求不能耗尽留给下一次交互的窗口。
        if (artistInteraction) artistInteractionQuietUntil = performance.now() + ARTIST_INTERACTION_QUIET_MS;
        pendingDispatches.delete(pending);
      });
    },
    dispatchInternal(request) {
      const pending = dispatchInternalDatasetCommand(domain, request);
      pendingDispatches.add(pending);
      return pending.finally(() => pendingDispatches.delete(pending));
    },
    readLocalAlbum(request) {
      assertOpen();
      const current=()=>{assertOpen();if(!scanBootReady)throw new CollectionError('INVENTORY_UNAVAILABLE','队列Owner尚未就绪。');};
      const pending = request.command==='localAlbum.materializeQueue'
        ? request.payload.selection.context
          ? materializeLocalSearchQueue(collection,localArtists,request.payload.selection,request.payload.expiresAtMs,current)
          : materializeLocalAlbumQueue(collection,albumRuntime.localAlbums,request.payload.selection,identity.datasetId,request.payload.expiresAtMs,current)
        : dispatchLocalAlbumRead(domain, request);
      pendingDispatches.add(pending); return pending.finally(() => pendingDispatches.delete(pending));
    },
    mobileMain(request) {
      const pending = Promise.resolve().then(() => {
        if (request.kind === 'playback-activity') {
          if (!isMobileOwnerPrivateRequest(request) || request.datasetId !== identity.datasetId) return {
            kind: 'mobile-error' as const, status: 400 as const, code: 'INVALID_REQUEST' as const, retryable: false, outcome: null,
          };
          assertOpen(); if (!scanBootReady) throw new CollectionError('INVENTORY_UNAVAILABLE', '移动 Owner 尚未 commitBoot。');
          if (request.request.operation === 'end' && request.request.ownerEpoch !== mobileOwnerEpoch) return {
            kind: 'mobile-error' as const, status: 409 as const, code: 'SOURCE_CHANGED' as const, retryable: false, outcome: null,
          };
          const leaseId = request.request.operation === 'begin' ? albumRuntime.beginMobileControlActivity()
            : (albumRuntime.endMobileControlActivity(request.request.leaseId), request.request.leaseId);
          return { kind: 'playback-activity' as const, datasetId: identity.datasetId, ownerEpoch: mobileOwnerEpoch,
            operation: request.request.operation, leaseId };
        }
        if (request.kind === 'content') {
          if (!isMobileOwnerPrivateRequest(request) || request.datasetId !== identity.datasetId) return {
            kind: 'content-error' as const, status: 400 as const, code: 'INVALID_REQUEST' as const,
            retryable: false as const, outcome: null, commitId: null,
          };
          return mobileContent.dispatch(request.request);
        }
        if (request.kind !== 'media-source') return dispatchMobileOwner(request);
        if (!isMobileOwnerPrivateRequest(request) || request.datasetId !== identity.datasetId) return {
          kind: 'mobile-error' as const, status: 400 as const, code: 'INVALID_REQUEST' as const, retryable: false, outcome: null,
        };
        return mobileSources.dispatch(request.request);
      });
      pendingDispatches.add(pending); return pending.finally(() => pendingDispatches.delete(pending));
    },
    dispatchSourceWritesMain(request,actor) {
      assertOpen();const pending=Promise.resolve().then<unknown>(()=>{switch(request.command){case 'localSourceWrites.attachOriginal':return localSourceWrites.attachOriginal(request.payload,actor);case 'localSourceWrites.challenge':return localSourceWrites.challenge(request.payload,actor);case 'localSourceWrites.executeGranted':return localSourceWrites.executeGranted(request.payload,actor);}});pendingDispatches.add(pending);return pending.finally(()=>pendingDispatches.delete(pending));
    },
    dispatchRelocationMain(request, actor) {
      assertOpen(); const pending = Promise.resolve().then(() => localRelocationPlans.dispatchMain(request, actor));
      pendingDispatches.add(pending); return pending.finally(() => pendingDispatches.delete(pending));
    },
    materializeMBEdition: request => {assertOpen();if(!scanBootReady)throw new CollectionError('INVENTORY_UNAVAILABLE','队列Owner尚未就绪。');return materializeMBEdition(collection,request);},
    loadMBQueue: () => { assertOpen(); if (!scanBootReady) throw new CollectionError('INVENTORY_UNAVAILABLE','队列Owner尚未就绪。'); return collection.mbQueue.load(identity.datasetId); },
    saveMBQueue: request => { assertOpen(); if (!scanBootReady || request.queue.datasetId !== identity.datasetId) throw new CollectionError('INVENTORY_UNAVAILABLE','队列工作库不匹配。'); return collection.mbQueue.save(request); },
    captureLocalSource: selection => localTickets.capture(selection),
    readLocalSourceLyrics(ticketId) {
      assertOpen(); const pending = localTickets.readLyrics(ticketId);
      pendingDispatches.add(pending); return pending.finally(() => pendingDispatches.delete(pending));
    },
    revalidateLocalSource: ticketId => localTickets.revalidate(ticketId),
    releaseLocalSource: ticketId => localTickets.release(ticketId),
    sealLocalSources: () => localTickets.seal(),
    async commitBoot() { assertOpen();await options.commitBoot?.();assertOpen();
      // 仅沿完整核验过的原成功Root回执补齐绑定；开放本地scope前完成，不重放重关联或扫描。
      if(options.collectionDatasetIdentity)collection.localCatalog.privateRecoverLibraryRootRelinkBindings(options.collectionDatasetIdentity);
      assertOpen();scanBootReady=true;
      // 只有接上原 fatal 通道的 Owner 可以后台准备；已核验的普通读取先开放，目录立即告知准备状态。
      const backgroundWarm = options.onBackgroundFatal && albumRuntime.localAlbums.privateMobile.prepare;
      if (backgroundWarm) startMobilePreparation();
      else { await albumRuntime.localAlbums.privateMobile.prepare?.(); assertOpen(); }
      void collection.localScan.privateWarmDisplayFileParameters();
      // 原持久目录事实已可查询；后台仅续跑有系统中断证据且当前ONLINE的任务。
      if(!backgroundWarm && options.collectionDatasetIdentity && options.projection)localScan.privateStartRecovery();
    },
    readonlySnapshotStamp() {
      assertOpen();
      const stamp = collection.readonlySnapshotStamp();
      assertOpen();
      return stamp;
    },
    exportCollectionModels() {
      assertOpen();
      const models = collection.exportReadonlyModels();
      assertOpen();
      return models;
    },
    exportLargeCollectionModels() {
      assertOpen();
      const models = collection.exportLargeReadonlyModels();
      assertOpen();
      return models;
    },
    failureForError(id, error, command) { return (options.failureForError ?? failureForError)(id, error, command ?? 'commandOutbox.context'); },
    close(beforeConnectionClose) {
      if (closed) return closed;
      closing = true; localTickets.seal(); sourceReads?.seal();
      closed = (async () => {
        const failures: unknown[] = [];
        const stop = async (stage: LibraryShutdownStage, operation: () => unknown) => { try { await runLibraryShutdownStep(stage, operation); } catch (error) { failures.push(error); } };
        await stop('owner.background', async () => {
          const stopped = await Promise.allSettled([artistBackfill?.close(),localArtists.close(),albumRuntime.background?.close()]);
          const failures = stopped.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
          if(failures.length)throw new AggregateError(failures,'后台艺人、补读与封面任务尚未全部静止。');
        });
        await stop('owner.mobile', () => mobileContent.close());
        await stop('owner.mobile-sources', async () => {
          const results = await Promise.allSettled([Promise.resolve().then(() => mobileSources.close()), localTickets.joinLyrics()]);
          const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map(r => r.reason);
          if (failures.length) throw new AggregateError(failures, '移动与本地歌词来源尚未全部静止。');
        });
        // 前序失败仍尽力停止后续原资源；任何收尾失败都保留两库，不发送静止成功回执，也不自动重试。
        await stop('owner.replica', () => recordingReplica.close()); await stop('owner.prints', () => recordingPrints.close()); await stop('owner.records', () => recordingRecords.close()); await stop('owner.attempts', () => recordingAttempts.close());
        await stop('owner.devices', () => recordingDeviceSelection?.close()); await stop('owner.output', () => recordingOutput.close()); await stop('owner.plans', () => recordingPlans.close());
        await stop('owner.backups', () => backups.close()); await stop('owner.archive', () => archive.close()); await stop('owner.execution', () => execution.close()); await stop('owner.prepared', () => prepared.close()); await stop('owner.zip', () => preparationZips.close()); await stop('owner.preparation', () => preparation.close()); await stop('owner.versions', () => masterVersions.close());
        await stop('owner.workbench', () => closeWorkbench());
        await stop('owner.source-writes', () => localSourceWrites.close());
        await stop('owner.relocation-plans', () => localRelocationPlans.close());
        await stop('owner.artwork', () => localArtwork.close());
        await stop('owner.albums', () => albumRuntime.close());
        await stop('owner.organizer', () => localOrganizer.close());
        await stop('owner.legacy', () => localLegacyLinks.close());
        await stop('owner.scan', async () => {
          const errors: unknown[] = [];
          try { await localScan.close(); } catch (error) { errors.push(error); }
          // 所有实际读者已请求停止后，再核共享队列与迟到票据；前序失败仍要执行此收口。
          try { await sourceReads?.close(); } catch (error) { errors.push(error); }
          if (errors.length) throw new AggregateError(errors, '扫描与来源读取调度未全部静止。');
        });
        await stop('owner.media-worker', () => closeRustMediaWorkerPool());
        await stop('owner.snapshots', () => completedScanSnapshots?.close());
        await stop('owner.relocation', () => localRelocation.close());
        await stop('owner.candidates', () => sourceCandidates.close()); await stop('owner.sources', () => sources.close());
        await runLibraryShutdownStep('owner.dispatches', () => Promise.allSettled([...pendingDispatches]));
        await stop('owner.mobile', () => mobileOwner.close());
        await stop('owner.barrier', () => beforeConnectionClose?.());
        // 其余原资源没有静止证明时保留唯一SourceSafety，不能先清预留再声称Owner关闭。
        if(failures.length===0)await stop('owner.source-safety', ()=>localSourceWrites.closeSourceSafety());
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, '工作库收尾失败；已尽力停止全部资源，保留连接供故障处理。');
        await runLibraryShutdownStep('owner.connections', () => {
          if (options.closeConnections) options.closeConnections();
          else { try { collection.close(); } finally { maintenance.close(); } }
        });
      })();
      return closed;
    },
  };
  if(scanBootReady && options.collectionDatasetIdentity && options.projection)localScan.privateStartRecovery();
  return domain;
}

export function createDatasetDomain(options: DatasetDomainOptions): DatasetDomain { return composeDatasetDomain(options); }
export function createTestDatasetDomain(options: TestDatasetDomainOptions = {}): TestDatasetDomain {
  return composeDatasetDomain({ ...options, collectionRepository: options.collectionRepository ?? createCollectionRepository({ filePath: ':memory:' }), backupWorkflowStore: options.backupWorkflowStore ?? createBackupWorkflowStore({ filePath: ':memory:' }) }, options) as TestDatasetDomain;
}

export interface OwnedDatasetDomainOptions {
  /** 仅 Worker 组合层注入，复用现有 Owner fatal/close 路径。 */
  onBackgroundFatal?: () => void;
  mobileSqlWorkerEntry?: URL;
  /** 私有测试工厂；生产缺省使用打包后的专用只读Worker。 */
  mobileSqlWorkerFactory?: (options: WorkerOptions) => Worker;
  assertAlbumReadActive?(): void;
  localScanReadProfile?: 'bulk-v2';
  sourceWritesMainActor?: SourceWritesMainActor;
  mobileDsd?: MobileDsdDomainOptions;
  localWorkbenchNative?: DatasetWorkbenchNativeConfiguration;
  dataDirectory: string;
  epoch: string;
  testMode?: boolean;
  /** 仅真实worker测试传入有lifecycle观测的真实Reader，不来自公开IPC。 */
  scanMetadataReader?: MetadataReaderPort;
  projection: DatasetProjectionPort;
  recordingDependencies?: {
    recordingConverter?: FfmpegConverter;
    recordingOutputHelper?: PinnedOutputHelper;
    recordingDeviceOutputHelper?: PinnedDeviceOutputHelper;
    recordingGateBCandidate?: GateBCandidateIdentity | null;
  };
  failureForError?: typeof failureForError;
}
/** 两个实际数据库、迁移/恢复和全部资源只在调用本工厂的owner线程打开。 */
export async function prepareOwnedDatasetDomain(options: OwnedDatasetDomainOptions): Promise<DatasetDomain> {
  const dataset = await openCollectionDataset(options.dataDirectory);
  let domain:DatasetDomain|undefined, mobilePreparedCache:MobilePreparedCache|undefined;
  try {
    if (options.mobileDsd) {
      const converter = await loadMobileDsdConverter({directory:options.mobileDsd.converterDirectory,manifestSha256:options.mobileDsd.converterManifestSha256});
      mobilePreparedCache = await createMobilePreparedCache({directory:options.mobileDsd.cacheDirectory,datasetId:dataset.datasetId,
        ownerEpoch:options.epoch,converter,assertCurrent:dataset.assertIdentity});
    }
    const dependencies = options.recordingDependencies ?? {};
    let outputRunRecovery: OutputRunRecoveryState | undefined;
    if (!options.testMode) {
      try {
        outputRunRecovery = await reconcileOutputRunRecovery({ databaseFile: dataset.databaseFile, datasetId: dataset.datasetId, rows: dataset.repository.recordingAttempts.outputRunRecoveryRows(), ...(dependencies.recordingDeviceOutputHelper ? { pin: dependencies.recordingDeviceOutputHelper } : {}), assertCurrent: dataset.assertIdentity, persistQuiet: row => dataset.repository.recordingAttempts.persistRevokedOutputRunQuiet(row) });
      } catch { outputRunRecovery = { safe: false, pendingRuns: 0, reason: 'OUTPUT_RUN_UNVERIFIED' }; }
    }
    const common: DatasetDomainOptions = {
      mobileSqlWorker: { databaseFile: dataset.databaseFile, ...(options.mobileSqlWorkerEntry ? { entry: options.mobileSqlWorkerEntry } : {}), ...(options.mobileSqlWorkerFactory ? { workerFactory: options.mobileSqlWorkerFactory } : {}) },
      ...(options.assertAlbumReadActive ? { assertAlbumReadActive: options.assertAlbumReadActive } : {}),
      ...(options.onBackgroundFatal ? { onBackgroundFatal: options.onBackgroundFatal } : {}),
      ...(options.localScanReadProfile ? { localScanReadProfile: options.localScanReadProfile } : {}),
      ...(options.mobileDsd ? { mobileDsd: options.mobileDsd } : {}),
      ...(options.localWorkbenchNative ? { localWorkbenchNative: options.localWorkbenchNative } : {}),
      localSourceEpoch: options.epoch, collectionRepository: dataset.repository, backupWorkflowStore: dataset.store,
      artistSearchDirectory: path.join(options.dataDirectory,'artist-search',dataset.datasetId),
      ...(options.sourceWritesMainActor ? { sourceWritesMainActor: options.sourceWritesMainActor } : {}),
      collectionDatasetIdentity: { datasetId: dataset.datasetId, assertCurrent: dataset.assertIdentity },
      backupPrivateRoot: dataset.privateRoot, ...(dataset.contentBinding ? { backupContentBinding: dataset.contentBinding } : {}),
      ...dependencies, ...(outputRunRecovery ? { recordingOutputRunRecovery: outputRunRecovery } : {}), recordingLeaseDatabaseFile: dataset.databaseFile,
      projection: options.projection, commitBoot: dataset.commit, closeConnections: () => { dataset.fail(); dataset.close(); }, ...(options.failureForError ? { failureForError: options.failureForError } : {}),
    };
    // 测试模式仅禁用设备准入，不从环境或IPC取得合成provider资格。
    domain=composeDatasetDomain(common,options.testMode ? { ...(options.scanMetadataReader ? {scanMetadataReader:options.scanMetadataReader}:{}) } : undefined,mobilePreparedCache);
    // 认证冷投影后、prepare/ACK之前安装真正命名位和FD保护，不让首个新Reader穿过未解目标。
    await domain.localSourceWrites.prepareRecoveryProtection(); await domain.localRelocationPlans.prepareRecoveryProtection();await domain.prepareWorkbench();return domain;
  } catch (error) {
    if(domain){try{await domain.close();}catch(closeError){throw new AggregateError([error,closeError],'冷保护准入/收尾未核实；保留工作库连接及真实保护。');}}
    else{
      if(mobilePreparedCache)try{await mobilePreparedCache.close();}catch(closeError){throw new AggregateError([error,closeError],'DSD 后端静止未核实；保留 Owner 连接及保护。');}
      dataset.fail();dataset.close();
    }throw error;
  }
}
