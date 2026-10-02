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
import { randomUUID } from 'node:crypto';
import { createDatasetCommandBoundary, type DatasetIdentity } from '../recording/dataset-identity.js';
import type { ArchiveContentBinding } from '../recording/backup-package.js';
import type { RootCapability } from '../recording/source-files.js';
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
import type { IpcRequest } from '@music-bridge/contracts';
import { createCollectionRepository, type CollectionRepository, CollectionError } from './repository.js';
import { createRoonPublicLibrary, type RoonPublicLibrary } from '../roon/public-library.js';
import { openCollectionDataset } from '../recording/restore-dataset-runtime.js';
import { reconcileOutputRunRecovery } from '../recording/output-run-recovery.js';
import { failureForError } from '../shared/ipc-failure.js';
import { dispatchDatasetCommand } from './dataset-dispatch.js';
import type { DatasetServices } from './dataset-services.js';
import type { DatasetProjectionPort, DatasetProjectionTicket, OwnedDatasetDomain } from './dataset-owner-protocol.js';

export interface DatasetDomainOptions {
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
  closeConnections?: () => void;
  failureForError?: typeof failureForError;
}
export interface TestDatasetDomainOptions extends Partial<Omit<DatasetDomainOptions, 'projection'>> {
  /** 合成注入仅供明确测试工厂；生产工厂没有这些字段。 */
  recordingAttemptAdmissionProvider?: RecordingAttemptAdmissionProvider;
  recordingPlanDeviceSelection?: RecordingDeviceSelectionBroker;
  recordingPlanGateB?: GateBAdmissionSource;
}
export interface DatasetDomain extends OwnedDatasetDomain, DatasetServices {}
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

function composeDatasetDomain(options: DatasetDomainOptions, test?: TestDatasetDomainOptions): DatasetDomain {
  const collection = options.collectionRepository, maintenance = options.backupWorkflowStore;
  const identity = options.collectionDatasetIdentity ?? { datasetId: randomUUID(), assertCurrent: () => { collection.list({ offset: 0, limit: 1 }); } };
  const commandOutbox = createDatasetCommandBoundary(identity);
  let closing = false, closed: Promise<void> | undefined;
  const assertDataset = () => identity.assertCurrent();
  const assertOpen = () => { if (closing) throw new CollectionError('INVENTORY_UNAVAILABLE', '工作库正在关闭，请重新读取当前状态。'); assertDataset(); };
  const pendingDispatches = new Set<Promise<unknown>>();
  // BackupCoordinator仍使用唯一原store的方法与事务；其close只提出关闭请求。
  // domain必须等录音清理、激活/文件回调及在途dispatch收口后，才真正关闭维护库连接。
  const maintenanceForCoordinator: BackupWorkflowStore = { ...maintenance, close() {} };
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
    datasetId: identity.datasetId, collection, commandOutbox, sources, sourceCandidates, mediaPlanning, masterVersions, preparation, preparationZips, prepared, execution, backups, archive,
    ...(recordingDeviceSelection ? { recordingDeviceSelection } : {}), recordingPlans, recordingOutput, recordingAttempts, recordingRecords, recordingPrints, recordingReplica, physicalLinks, masterDrafts, assertOpen,
    dispatch(request) {
      const pending = dispatchDatasetCommand(domain, request);
      pendingDispatches.add(pending);
      return pending.finally(() => pendingDispatches.delete(pending));
    },
    commitBoot() { assertOpen(); return options.commitBoot?.(); },
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
      closing = true;
      closed = (async () => {
        const failures: unknown[] = [];
        const stop = async (operation: () => unknown) => { try { await operation(); } catch (error) { failures.push(error); } };
        // 前序失败仍尽力停止后续原资源；任何收尾失败都保留两库，不发送静止成功回执，也不自动重试。
        await stop(() => recordingReplica.close()); await stop(() => recordingPrints.close()); await stop(() => recordingRecords.close()); await stop(() => recordingAttempts.close());
        await stop(() => recordingDeviceSelection?.close()); await stop(() => recordingOutput.close()); await stop(() => recordingPlans.close());
        await stop(() => backups.close()); await stop(() => archive.close()); await stop(() => execution.close()); await stop(() => prepared.close()); await stop(() => preparationZips.close()); await stop(() => preparation.close()); await stop(() => masterVersions.close());
        await stop(() => sourceCandidates.close()); await stop(() => sources.close());
        await Promise.allSettled([...pendingDispatches]);
        await stop(() => beforeConnectionClose?.());
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, '工作库收尾失败；已尽力停止全部资源，保留连接供故障处理。');
        if (options.closeConnections) options.closeConnections();
        else { try { collection.close(); } finally { maintenance.close(); } }
      })();
      return closed;
    },
  };
  return domain;
}

export function createDatasetDomain(options: DatasetDomainOptions): DatasetDomain { return composeDatasetDomain(options); }
export function createTestDatasetDomain(options: TestDatasetDomainOptions = {}): TestDatasetDomain {
  return composeDatasetDomain({ ...options, collectionRepository: options.collectionRepository ?? createCollectionRepository({ filePath: ':memory:' }), backupWorkflowStore: options.backupWorkflowStore ?? createBackupWorkflowStore({ filePath: ':memory:' }) }, options) as TestDatasetDomain;
}

export interface OwnedDatasetDomainOptions {
  dataDirectory: string;
  epoch: string;
  testMode?: boolean;
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
  try {
    const dependencies = options.recordingDependencies ?? {};
    let outputRunRecovery: OutputRunRecoveryState | undefined;
    if (!options.testMode) {
      try {
        outputRunRecovery = await reconcileOutputRunRecovery({ databaseFile: dataset.databaseFile, datasetId: dataset.datasetId, rows: dataset.repository.recordingAttempts.outputRunRecoveryRows(), ...(dependencies.recordingDeviceOutputHelper ? { pin: dependencies.recordingDeviceOutputHelper } : {}), assertCurrent: dataset.assertIdentity, persistQuiet: row => dataset.repository.recordingAttempts.persistRevokedOutputRunQuiet(row) });
      } catch { outputRunRecovery = { safe: false, pendingRuns: 0, reason: 'OUTPUT_RUN_UNVERIFIED' }; }
    }
    const common: DatasetDomainOptions = {
      collectionRepository: dataset.repository, backupWorkflowStore: dataset.store,
      collectionDatasetIdentity: { datasetId: dataset.datasetId, assertCurrent: dataset.assertIdentity },
      backupPrivateRoot: dataset.privateRoot, ...(dataset.contentBinding ? { backupContentBinding: dataset.contentBinding } : {}),
      ...dependencies, ...(outputRunRecovery ? { recordingOutputRunRecovery: outputRunRecovery } : {}), recordingLeaseDatabaseFile: dataset.databaseFile,
      projection: options.projection, commitBoot: dataset.commit, closeConnections: () => { dataset.fail(); dataset.close(); }, ...(options.failureForError ? { failureForError: options.failureForError } : {}),
    };
    // 测试模式仅禁用设备准入，不从环境或IPC取得合成provider资格。
    return options.testMode ? composeDatasetDomain(common, {}) : createDatasetDomain(common);
  } catch (error) { dataset.fail(); dataset.close(); throw error; }
}
