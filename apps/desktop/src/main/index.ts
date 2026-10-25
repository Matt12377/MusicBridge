import { MOBILE_RESOURCE_CAPACITY_FLAG } from '../../../../packages/bridge-core/src/mobile/resource-capacity-trace.js';
import { createMobileOwnerLoadTraceProbe } from '../../../../packages/bridge-core/src/mobile/owner-load-trace.js'
import { createMobileRangeWindowProbe, createMobileRangeWindowTraceWriter } from '../../../../packages/bridge-core/src/mobile/range-window-observer.js'
import { runLocalAlbumMainRead } from './local-library-workbench/album-ipc.js'
import { localAlbumPhase, localAlbumMatch, localAlbumRejectCode, localAlbumLink, collectLocalAlbumSafeTrace } from '../../../../packages/bridge-core/src/shared/local-album-read-trace-node.js'
import { collectDesktopArtwork, snapshotDesktopArtwork } from '../../../../packages/bridge-core/src/shared/desktop-artwork-trace-node.js'
import { readDesktopArtworkLine, desktopArtworkTraceEnabled } from '../../../../packages/bridge-core/src/shared/desktop-artwork-trace.js'
import { readLocalAlbumSafeTraceLine } from '../shared/library-read-trace.js'
import { readLibraryOperationLine, logLibraryOperation } from '../../../../packages/bridge-core/src/shared/library-operation-log.js'
import { closeRustMediaWorkerPool } from '../../../../packages/bridge-core/src/library/rust-media-worker.js'
import { resolveDesktopMediaWorker } from './media-worker-bootstrap.js'
import { createRemoteCoreModeController } from './remote-core-mode.js'
import { createRemoteCoreStartup, REMOTE_CORE_STARTUP_PREFERENCE, REMOTE_CORE_STARTUP_READY } from './remote-core-startup.js'
import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createMobilePreparationProbe, MOBILE_CAPABILITY_TRACE_PREFIX, type MobileCapabilityTraceRecord } from '../../../../packages/bridge-core/src/mobile/capability-trace.js'
import { createLocalNameSettings } from './local-library-workbench/name-settings.js'
import { createLocalWorkbenchNativeChooser, createLocalWorkbenchDirectoryMainBridge } from './local-library-workbench/native-chooser.js'
import { createLocalLyricsMainService, createLocalLyricsMainProviderBridge } from './local-library-workbench/lyrics-service.js'
import { DATASET_WORKBENCH_BOUNDS, type DatasetLyricsProviderStart } from '../../../../packages/bridge-core/src/collection/dataset-owner-protocol.js'
import { registerLocalWorkbenchIpc } from './local-library-workbench/workbench-ipc.js'
import { registerLocalAlbumIpc } from './local-library-workbench/album-ipc.js'
import { isLocalAlbumMainResponse } from '../../../../packages/bridge-core/src/collection/local-album-browser/main-protocol.js'
import { createLocalNameTransport, createLocalArtworkProviders, createLocalArtworkWebNavigation } from './local-library-workbench/providers/index.js'
import { registerLocalArtworkNavigationPhysical } from './local-library-workbench/providers/artwork-web-navigation.js'
import { normalizeLocalArtworkInWorker } from './local-artwork-image.js'
import { resizeMobileProviderArtwork } from './mobile-artwork-image.js'
import { createLocalAlbumArtworkNormalizer } from './local-library-workbench/album-artwork-normalizer.js'
import { createLocalArtworkImportNormalizer } from './local-library-workbench/artwork-import-normalizer.js'
import { createLocalWorkbenchQuitCoordinator } from './local-library-workbench/quit-coordinator.js'
import { createLocalWorkbenchMainRecovery, type LocalWorkbenchMainRecovery } from './local-workbench-main-recovery.js'
import { readDatasetWorkbenchNativeConfiguration } from './dataset-owner-bootstrap.js'
import { createLocalWorkbenchService, createLocalWorkbenchNameMainBridge, createLocalWorkbenchMainAssembly, createLocalWorkbenchManagementBoundary, createLocalWorkbenchTransportOwner, LocalWorkbenchMainBoundaryError, type LocalWorkbenchOwnerPorts, type LocalWorkbenchRootMainAuthor } from './local-library-workbench/service.js'
import { installLocalArtworkHandlers } from './local-artwork-ipc.js'
import { createMobileConnectionSettings, installMobileConnectionHandlers } from './mobile-settings.js'
import { createMobileBonjourPublisher } from './mobile-bonjour.js'
import { createMobilePairingPromptCoordinator } from './mobile-pairing-prompt.js'
import { createArtistCatalogService, type ArtistCatalogService } from './artist-catalog-service.js'
import { installArtistCatalogHandlers } from './artist-catalog-ipc.js'
import { createMobileRangeTimingProbe } from './mobile-range-timing.js'
import { installLocalSourceWritesHandlers } from './local-source-writes-ipc.js'
import { installLocalRelocationHandlers } from './local-relocation-ipc.js'
import { createCommonsArtworkProvider } from './commons-artwork-provider.js'
import { createMusicCoverArtProvider } from './music-cover-art-provider.js'
import {isMBQueueEditRequest,isMBQueuePlayEntryRequest,isMBEditionQueueRequest} from '@music-bridge/contracts'
import {installLocalLibraryHandlers} from './local-library-ipc.js'
import { installLocalOrganizerHandlers } from './local-organizer-ipc.js'
import { installLocalLegacyLinksHandlers } from './local-legacy-links-ipc.js'
import type {CommandOutboxPickOptions} from './command-outbox-executor.js'
import { createLibraryReadBroker } from './library-read-ipc.js'
import { createPerformanceIpcBridge } from "./performance-ipc.js"
import { createLibraryReadTraceWriter, isLibraryReadTraceEnabled } from '../shared/library-read-trace.js'
import { installDiagnosticStdioProtection, writeDiagnosticStdout, writeDiagnosticStderr } from './diagnostic-stdio.js'

import { createCollectionReadonlySettings, installCollectionReadonlyHandlers } from './collection-readonly-settings.js'
import { createCollectionReadonlyControlClient, type CollectionReadonlyControlChild, type CollectionReadonlyControlPort } from './collection-readonly-control-client.js'
import { createCollectionReadonlyMainProbe } from './collection-readonly-main-probe.js'
declare const __MUSIC_BRIDGE_COLLECTION_READONLY_DIAGNOSTICS__: boolean
declare const __MUSIC_BRIDGE_MEDIA_WORKER_SHA256__: string
declare const __MUSIC_BRIDGE_COLLECTION_SCALE_DIAGNOSTICS__: boolean
import { createCollectionScaleMainProbe } from './collection-scale-main-probe.js'

declare const __MUSIC_BRIDGE_DEVELOPMENT_BUILD__: boolean
declare const __MUSIC_BRIDGE_PACKAGED_ROUTE_DIAGNOSTICS__: boolean
declare const __MUSIC_BRIDGE_PACKAGED_RENDERER_DIAGNOSTICS__: boolean
declare const __MUSIC_BRIDGE_PRIVATE_MOBILE_RANGE_TIMING__: boolean
installDiagnosticStdioProtection()
const mobileRangeTimingProbe = typeof __MUSIC_BRIDGE_PRIVATE_MOBILE_RANGE_TIMING__ === 'boolean' && __MUSIC_BRIDGE_PRIVATE_MOBILE_RANGE_TIMING__
  ? createMobileRangeTimingProbe({ enabled: true }) : undefined
const mobileRangeWindowProbe = typeof __MUSIC_BRIDGE_PRIVATE_MOBILE_RANGE_TIMING__ === 'boolean' && __MUSIC_BRIDGE_PRIVATE_MOBILE_RANGE_TIMING__
  ? process.argv.includes('--mb-private-range-continuity') && process.argv.includes('--mb-private-content-trace')
    ? createMobileRangeWindowProbe({ enabled: true, continuous: true,
      windowSink: createMobileRangeWindowTraceWriter({ enabled: true, sink: writeDiagnosticStdout }) })
    : createMobileRangeWindowProbe({ enabled: true, ...(process.argv.includes('--mb-private-content-trace')
      ? { windowSink: createMobileRangeWindowTraceWriter({ enabled: true, sink: writeDiagnosticStdout }) } : {}) }) : undefined
// 仅显式本地启动参数启用；不读取环境、Renderer或配对内容。
const mobileOwnerLoadTraceProbe = process.argv.includes('--mb-private-owner-load-trace')
  ? createMobileOwnerLoadTraceProbe({ enabled: true, sink: writeDiagnosticStdout }) : undefined
// 内容诊断可在正式构建中显式启用；不连带打开媒体 Range 探针，也不改变正常启动。
const mobilePreparationProbe = (typeof __MUSIC_BRIDGE_PRIVATE_MOBILE_RANGE_TIMING__ === 'boolean' && __MUSIC_BRIDGE_PRIVATE_MOBILE_RANGE_TIMING__)
  || process.argv.includes('--mb-private-content-trace') || process.argv.includes(MOBILE_RESOURCE_CAPACITY_FLAG)
  ? createMobilePreparationProbe({ enabled: true, sink: record => {
      // 仅输出原闭集计时事件；探针自身限制会话/资源数，不包含曲目、凭据或错误正文。
      writeDiagnosticStdout(MOBILE_CAPABILITY_TRACE_PREFIX + JSON.stringify(record) + '\n')
    } }) : undefined
// 显式连接诊断从首次身份读取开始取证；沿用原八次/首败停止预算。
if (process.argv.includes('--mb-private-owner-load-trace')) mobilePreparationProbe?.arm()
import { assertPackagedRouteDiagnosticEnvironment, createPackagedRouteMainProbe } from './packaged-route-main-probe.js'
import { assertPackagedRendererDiagnosticEnvironment, createPackagedRendererMainProbe } from './packaged-renderer-main-probe.js'
import { observePackagedRendererIpc } from './packaged-renderer-ipc-observer.js'
import { isVolumeRequest } from '@music-bridge/contracts'
import { normalizeRoonDisplayUrl } from '@music-bridge/contracts'
import { RoonDisplayConnection } from './roon-display-connection.js'
import { installRecordingPrintHandlers } from './recording-print-ipc.js'
import { createRecordingPrintWorker } from './recording-print-worker.js'
import { createRecordingPrintRenderer } from './recording-print-renderer.js'
import { createLifecycleProbe } from './lifecycle-probe.js'
import { waitForCoreCrashFailure } from './core-crash-gate.js'
import { installUiE2eNetworkGuard, type UiE2eNetworkEvidence } from './ui-e2e-network-guard.js'
import { exportRecordingPrintPdf } from './recording-print-export.js'
import { installRecordingRecordHandlers } from './recording-record-ipc.js'
import { installRecordingReplicaHandlers } from './recording-replica-ipc.js'
import { installRecordingDeviceHandlers } from './recording-device-ipc.js'
import { installRecordingAttemptHandlers } from './recording-attempt-ipc.js'
import { installRecordingPlanReads } from './recording-plan-ipc.js'
import { installRecordingWorkspaceRead } from './recording-workspace-ipc.js'
import { installRecordingCandidateHandlers } from './recording-candidate-ipc.js'
import { installPreparationZipHandlers } from './recording-preparation-zip-ipc.js'
import { installRecordingOutputReads } from './recording-output-ipc.js'
import { installCollectionProgressReads } from './collection-progress-ipc.js'
import { installReferenceCatalogReads } from './reference-catalog-ipc.js'
import { createCassetteCatalogService, installCassetteCatalogHandlers } from './cassette-catalog-service.js'
import { installSpreadsheetImportReads } from './spreadsheet-import-ipc.js'
import { createCommandOutboxStore } from './command-outbox-store.js'
import { createCommandOutboxService, type CommandOutboxService } from './command-outbox-service.js'
import { createCommandOutboxExecutor } from './command-outbox-executor.js'
import { installCommandOutboxIpc } from './command-outbox-ipc.js'

import { isPreviewArchiveRequest, isVerifyArchiveRequest } from '@music-bridge/contracts'
import { isPreviewExecutionRequest, isVerifyExecutionRequest } from '@music-bridge/contracts'
import { isPreviewPreparedImportRequest, isReviewPreparedRequest } from '@music-bridge/contracts'
import { isPreviewPreparationRequest } from '@music-bridge/contracts'
import { isPreviewVersionsRequest } from '@music-bridge/contracts'
import { isMediaLayoutSpec, isPreviewMediaRequest } from '@music-bridge/contracts'


import { isAlbumQuery } from '@music-bridge/contracts'
import { isMusicId, isMusicFilter } from '@music-bridge/contracts'
import {
  app,
  BrowserWindow,
  WebContentsView,
  dialog,
  ipcMain,
  Menu,
  MessageChannelMain,
  nativeImage,
  nativeTheme,
  protocol,
  safeStorage,
  session,
  shell,
  Tray,
  utilityProcess,
} from 'electron'
import type {
  PageRequest,
  PlaybackQueueRequestItem,
  PlaybackQualityPreference,
  PlaybackSourcePreference,
  PlaybackSnapshot,
  PublicAuthState,
  PublicBridgeState,
  PublicErrorCode,
  RemoteCoreMode,
  RemoteCoreTunnelState,
  FavoriteEntityDescriptor,
  FavoriteKind,
  RoonImageOptions,
  RoonImageResult,
  RoonImageShapeSummary,
  TrackSummary,
  TypedIpcEvent,
} from '@music-bridge/contracts'
import {
  IPC_VERSION,
  MAX_PLAYBACK_QUEUE_ITEMS,
  summarizeRoonImageBinary,
  validateIpcEvent,
  isCollectionId,
  isCollectionReceiveRequest,
  isCollectionMaterializeRequest,
  isCollectionUpdateCopyRequest,
  isCollectionPolicyRequest,
  isCollectionFilter,
  isCollectionAddPhotoRequest,
  isCollectionChangePhotoRequest,
} from '@music-bridge/contracts'
import { pickCollectionPhoto, CollectionPhotoImportError } from './collection-photos'
import { appendFileSync, chmodSync } from 'node:fs'
import { mkdir, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 内部名称决定既有资料目录和保险库钥匙身份；展示更名不改变它。
const APPLICATION_NAME = 'Music Bridge for Roon'
const DISPLAY_NAME = 'Mousa'
app.setName(APPLICATION_NAME)

import { migrateRoonConfig } from './config-migration.js'
import {
  provisionProviderCredential,
  restoreProviderCredential,
} from './credential-provisioning.js'
import { CredentialVault } from './credential-vault.js'
import {
  MainDiagnosticRecorder,
  writeDiagnosticReport,
} from './diagnostics.js'
import {
  CoreIpcError,
  CoreSupervisor,
  shouldRefreshTrayForCoreEvent,
  type CoreSupervisorLifecycle,
  type CoreStartupClient,
  type CoreChildProcess,
  type CoreMessagePort,
  type CoreRelocationMessagePort,
} from './core-supervisor.js'
import {
  buildBrowserWindowWebPreferences,
  buildContentSecurityPolicy,
  getWindowOpenDecision,
  isNavigationAllowed,
  isTrustedRendererSender,
} from './security.js'
import {
  getRendererAssetPath,
  isAllowedRendererRequest,
  RENDERER_ENTRY_PATH,
  RENDERER_HOST,
  RENDERER_SCHEME,
  rendererContentType,
} from './renderer-protocol.js'
import {
  buildCoreEnvironment as buildAllowlistedCoreEnvironment,
  resolveRemoteCoreLocalPorts,
} from './core-environment.js'
import {
  DEFAULT_REMOTE_STREAM_PORT,
  isSafeSshTarget,
  RemoteCoreTunnelManager,
} from './remote-core-tunnel.js'
import {
  initializeStartupTestPaths,
  readStartupTestConfiguration,
  type ElectronColdStartStage,
} from './startup-test-config.js'
import { settleRoonImageIpc } from '../roon-image-ipc.js'
import trayTemplateSvg from './assets/musicbridge-tray-template.svg?raw'
import {
  buildTrayPresentation,
  shouldHideWindowOnClose,
  type TrayPresentation,
} from './tray.js'

protocol.registerSchemesAsPrivileged([
  {
    scheme: RENDERER_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
])

const currentFile = fileURLToPath(import.meta.url)
const currentDirectory = path.dirname(currentFile)
const startupTestConfiguration = readStartupTestConfiguration()
const isStartupTest = startupTestConfiguration.isStartupTest
const isUiE2e = process.env.MUSIC_BRIDGE_UI_E2E === '1'
const isOfflineUiE2e = isUiE2e && process.env.MUSIC_BRIDGE_UI_E2E_OFFLINE === '1'
if (__MUSIC_BRIDGE_PACKAGED_ROUTE_DIAGNOSTICS__) assertPackagedRouteDiagnosticEnvironment(process.env)
if (__MUSIC_BRIDGE_PACKAGED_RENDERER_DIAGNOSTICS__) {
  if (__MUSIC_BRIDGE_PACKAGED_ROUTE_DIAGNOSTICS__) throw new Error('候选诊断编译模式冲突。')
  assertPackagedRendererDiagnosticEnvironment(process.env)
}
const syntheticUserDataDirectory = initializeStartupTestPaths(startupTestConfiguration, isUiE2e, app)
const packagedRouteProbe = __MUSIC_BRIDGE_PACKAGED_ROUTE_DIAGNOSTICS__ ? createPackagedRouteMainProbe() : undefined
const packagedRendererProbe = __MUSIC_BRIDGE_PACKAGED_RENDERER_DIAGNOSTICS__ ? createPackagedRendererMainProbe() : undefined
const collectionReadonlyProbe = __MUSIC_BRIDGE_COLLECTION_READONLY_DIAGNOSTICS__ ? createCollectionReadonlyMainProbe() : undefined
const collectionScaleProbe = typeof __MUSIC_BRIDGE_COLLECTION_SCALE_DIAGNOSTICS__ === 'boolean' && __MUSIC_BRIDGE_COLLECTION_SCALE_DIAGNOSTICS__ ? createCollectionScaleMainProbe() : undefined
let collectionReadonlySettings: ReturnType<typeof createCollectionReadonlySettings> | undefined
const lifecycleProbe = createLifecycleProbe({ enabled: isUiE2e, sink: line => {
  writeDiagnosticStdout(line.trimEnd() + '\n')
  if (collectionScaleProbe) { try { const value = JSON.parse(line.slice('TASK078_LIFECYCLE '.length)); collectionScaleProbe.observeLifecycle(value.phase, value.exitCode) } catch { /* 被动观察不改变原生命周期。 */ } }
  if (collectionReadonlyProbe) { try { const value = JSON.parse(line.slice('TASK078_LIFECYCLE '.length)); collectionReadonlyProbe.observeLifecycle(value.phase, value.exitCode) } catch { /* 被动观察不改变原生命周期。 */ } }
  if (packagedRendererProbe) {
    try {
      const value = JSON.parse(line.slice('TASK078_LIFECYCLE '.length)) as { phase: string; exitCode?: number }
      packagedRendererProbe.observeMainEvent('main.lifecycle', { event: value.phase, ...(value.exitCode === undefined ? {} : { code: value.exitCode }) })
    } catch { /* 原合成生命周期日志保留，旁路失败不改变退出。 */ }
  }
} })
const isCoreCrashGate = startupTestConfiguration.coreCrashGate
const isCredentialVaultGate = startupTestConfiguration.credentialVaultGate
const isCoreRestartCredentialRecoveryGate =
  startupTestConfiguration.coreRestartCredentialRecoveryGate
const electronColdStartStage: ElectronColdStartStage | undefined =
  startupTestConfiguration.electronColdStartStage
const isElectronColdStartGate = electronColdStartStage !== undefined
const isRoonTimeGate = process.env.MUSIC_BRIDGE_ROON_TIME_GATE === '1'
const isRoonBrowseGate = process.env.MUSIC_BRIDGE_ROON_BROWSE_GATE === '1'
const isLibraryReadTrace = isLibraryReadTraceEnabled(process.env, __MUSIC_BRIDGE_DEVELOPMENT_BUILD__ && !app.isPackaged && process.env.NODE_ENV !== 'production' && !isStartupTest && !isUiE2e)
const libraryReadTrace = isLibraryReadTrace ? createLibraryReadTraceWriter({ enabled: true, write: writeDiagnosticStdout }) : undefined
const isRoonImageGate = process.env.MUSIC_BRIDGE_ROON_IMAGE_GATE === '1'
const roonImageGatePath = process.env.MUSIC_BRIDGE_ROON_IMAGE_GATE_PATH

let mainWindow: BrowserWindow | undefined
let coreSupervisor: CoreSupervisor | undefined
let mobileConnectionSettings: ReturnType<typeof createMobileConnectionSettings> | undefined
let mobilePairingPrompts: ReturnType<typeof createMobilePairingPromptCoordinator> | undefined
let artistCatalogService: ArtistCatalogService | undefined
let closeLocalArtwork: (()=>void) | undefined
let closeLocalSourceWrites: (() => void) | undefined
let closeLocalRelocation: (() => void) | undefined
let localWorkbenchRootMainAuthor: LocalWorkbenchRootMainAuthor | undefined
let localWorkbenchMainRecovery: LocalWorkbenchMainRecovery | undefined
let localWorkbenchMainRecoverySupervisor: CoreSupervisor | undefined
let localWorkbenchTransportOwner: LocalWorkbenchOwnerPorts | undefined
let localWorkbenchManagementBoundary: ReturnType<typeof createLocalWorkbenchManagementBoundary<Electron.IpcMainInvokeEvent>> | undefined
let localWorkbenchMainAssembly: ReturnType<typeof createLocalWorkbenchMainAssembly> | undefined
let localArtworkImportNormalizer: ReturnType<typeof createLocalArtworkImportNormalizer> | undefined
let localWorkbenchLegacyIpc: ReturnType<typeof registerLocalWorkbenchIpc> | undefined
let localLyricsMainService: ReturnType<typeof createLocalLyricsMainService> | undefined
let localLyricsProviderBridge: ReturnType<typeof createLocalLyricsMainProviderBridge> | undefined
let localNameMainBridge: ReturnType<typeof createLocalWorkbenchNameMainBridge> | undefined
let localWorkbenchNativeChooser: ReturnType<typeof createLocalWorkbenchNativeChooser> | undefined
let localWorkbenchDirectoryBridge:ReturnType<typeof createLocalWorkbenchDirectoryMainBridge>|undefined
/** Root仅在当前真实Owner prepare/commit后接此私有作者；不得用scope读数或UUID造binding。 */
function attachLocalWorkbenchRootMainAuthor(author: LocalWorkbenchRootMainAuthor, supervisor: CoreSupervisor): void {
  if (coreSupervisor !== supervisor || quitAfterCoreShutdown) throw new CoreIpcError('NOT_READY', '原整理Utility已撤销。')
  if (localWorkbenchRootMainAuthor && localWorkbenchRootMainAuthor !== author) localWorkbenchManagementBoundary?.revoke()
  const owner = createLocalWorkbenchTransportOwner(author)
  localWorkbenchRootMainAuthor = author
  localWorkbenchTransportOwner = owner
}
async function announceCurrentLocalWorkbenchReady(author: LocalWorkbenchRootMainAuthor, supervisor: CoreSupervisor, assertCurrent: () => void): Promise<void> {
  const assembly = localWorkbenchMainAssembly
  const check = () => {
    assertCurrent()
    if (!assembly || localWorkbenchMainAssembly !== assembly || coreSupervisor !== supervisor || supervisor.status !== 'ready' || localWorkbenchRootMainAuthor !== author || quitAfterCoreShutdown)
      throw new CoreIpcError('NOT_READY', '原 Main 整理作者或资源已经撤销。')
  }
  check()
  const state = await supervisor.request('core.getState', {})
  check()
  if (state.runtime !== 'ready') throw new CoreIpcError('NOT_READY', '原 Core 健康快照尚未就绪。')
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('core:event', { version: IPC_VERSION, event: 'core.health', payload: { state } })
  check()
  // 原恢复链已等待真实assembly.activate；健康核验后才允许Owner开启后台补齐。
  const deadlineAtMs = performance.now() + DATASET_WORKBENCH_BOUNDS.requestMs
  const accepted = await author.requestOwner('lifecycle.mainReady', {}, { binding: author.binding, signal: new AbortController().signal, deadlineAtMs })
  check()
  if (accepted !== true) throw new CoreIpcError('INVALID_IPC_RESPONSE', '原后台就绪确认未通过核验。')
}
async function bindCurrentLocalWorkbenchRootMainAuthor(supervisor: CoreSupervisor): Promise<void> {
  if (localWorkbenchMainRecoverySupervisor !== supervisor) {
    localWorkbenchMainRecovery?.close()
    localWorkbenchMainRecoverySupervisor = supervisor
    localWorkbenchMainRecovery = createLocalWorkbenchMainRecovery({
      isReady: () => coreSupervisor === supervisor && supervisor.status === 'ready' && !quitAfterCoreShutdown,
      create: () => supervisor.createWorkbenchRootMainAuthor(),
      attach: author => attachLocalWorkbenchRootMainAuthor(author, supervisor),
      activate: async author => {
        const assembly = localWorkbenchMainAssembly
        if (!assembly) throw new CoreIpcError('NOT_READY', 'Main 原整理资源尚未注册。')
        await assembly.activate(author)
        if (localWorkbenchMainAssembly !== assembly || localWorkbenchRootMainAuthor !== author)
          throw new CoreIpcError('NOT_READY', '原 Main 整理资源已经撤销。')
      },
      announce: (author, check) => announceCurrentLocalWorkbenchReady(author, supervisor, check),
      failureCode: error => error instanceof CoreIpcError || error instanceof LocalWorkbenchMainBoundaryError ? error.code : 'UNKNOWN',
      observe: event => {
        logLibraryOperation('library', `workbench.main-bind.${event.phase}`, event.state, { count: event.attempt, elapsedMs: event.elapsedMs, ...(event.code ? { code: event.code } : {}) })
        if (event.state !== 'error' || coreSupervisor !== supervisor) return
        if (event.phase === 'create' && !localWorkbenchRootMainAuthor) mainDiagnostics.recordLifecycle('local_workbench_owner_not_ready', 'warn')
        else mainDiagnostics.recordLifecycle('local_workbench_main_resources_not_ready', 'warn')
      },
    })
  }
  await localWorkbenchMainRecovery!.request()
}
function revokeLocalWorkbenchRootMainAuthor(): void {
  localWorkbenchMainRecovery?.revoke()
  const previous=localWorkbenchRootMainAuthor
  if(previous)void localNameMainBridge?.revokeOwner(previous.binding).catch(()=>mainDiagnostics.recordLifecycle('local_name_resources_not_closed','warn'))
  localWorkbenchRootMainAuthor = undefined
  localWorkbenchTransportOwner = undefined
  localWorkbenchManagementBoundary?.revoke()
  localWorkbenchMainAssembly?.revoke()
  localLyricsMainService?.revoke()
}
let roonDisplayConnection: RoonDisplayConnection | undefined
let recordingPrintWorker: ReturnType<typeof createRecordingPrintWorker> | undefined
let recordingPrintEpoch = 0
function stopRecordingPrintWorker(): void {
  recordingPrintEpoch++
  const previous = recordingPrintWorker
  recordingPrintWorker = undefined
  if (previous) lifecycleProbe.mark('print-stop-requested')
  const stopping = previous?.stop()
  if (stopping) lifecycleProbe.observe(stopping, 'print-stop-settled', 'print-stop-failed')
}
async function startRecordingPrintWorker(supervisor: CoreStartupClient): Promise<void> {
  stopRecordingPrintWorker()
  const epoch = recordingPrintEpoch
  try {
    const { datasetId } = await supervisor.request('commandOutbox.context', {})
    if (epoch !== recordingPrintEpoch || quitAfterCoreShutdown) return
    recordingPrintWorker = createRecordingPrintWorker({ datasetId, requestInternal: supervisor.requestInternal.bind(supervisor), renderer: createRecordingPrintRenderer() })
    recordingPrintWorker.start()
  } catch {
    mainDiagnostics.recordLifecycle('recording_print_worker_unavailable', 'warn')
  }
}

let commandOutbox: CommandOutboxService | undefined
let coreMode: RemoteCoreMode = 'local-core'
let coreDataDirectory: string | undefined
let cassetteCatalogService: ReturnType<typeof createCassetteCatalogService> | undefined
let remoteStreamPort: number | undefined
let tray: Tray | undefined
let trayRefreshPromise: Promise<void> | undefined
let trayRefreshQueued = false
let quitAfterCoreShutdown = false
let localWorkbenchShutdownConfirmed = false
let localWorkbenchQuitCoordinator: ReturnType<typeof createLocalWorkbenchQuitCoordinator> | undefined
const mainDiagnostics = new MainDiagnosticRecorder()
const performanceIpc = createPerformanceIpcBridge(mainDiagnostics.performance)
const registerPerformanceHandler: typeof ipcMain.handle = (channel, listener) => {
  const observed = packagedRendererProbe ? observePackagedRendererIpc({ channel, listener,
    trustedSender: event => {
      try {
        requireTrustedRenderer(event)
        return { webContentsId: event.sender.id, rendererPid: event.sender.getOSProcessId(), frameUrl: event.senderFrame?.url ?? '', trusted: true as const }
      } catch { return undefined }
    },
    observe: (event, data) => packagedRendererProbe.observeMainEvent(event, data),
  }) : listener
  const withCollectionObservation = collectionReadonlyProbe ? collectionReadonlyProbe.observeIpc({ channel, listener: observed, trustedSender: event => {
    try { requireTrustedRenderer(event); return { webContentsId: event.sender.id, rendererPid: event.sender.getOSProcessId(), frameUrl: event.senderFrame?.url ?? '', trusted: true as const } } catch { return undefined }
  } }) : observed
  const withScaleObservation = collectionScaleProbe ? collectionScaleProbe.observeIpc({ channel, listener: withCollectionObservation, trustedSender: event => {
    try { requireTrustedRenderer(event); return { webContentsId: event.sender.id, rendererPid: event.sender.getOSProcessId(), frameUrl: event.senderFrame?.url ?? '', trusted: true as const } } catch { return undefined }
  } }) : withCollectionObservation
  ipcMain.handle(channel, performanceIpc.wrap(withScaleObservation, event => {
    try { requireTrustedRenderer(event); return true } catch { return false }
  }))
}

function recordRoonImageShape(summary: RoonImageShapeSummary): void {
  if (
    !isRoonImageGate
    || !roonImageGatePath
    || !/^\/tmp\/musicbridge-roon-image-gate-[A-Za-z0-9._-]+\.jsonl$/.test(roonImageGatePath)
  ) {
    return
  }
  try {
    appendFileSync(roonImageGatePath, `${JSON.stringify(summary)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    chmodSync(roonImageGatePath, 0o600)
  } catch {
    // 诊断采样不得改变图片行为。
  }
}

function recordPreloadRoonImageShape(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const shape = value as Record<string, unknown>
  if (
    shape.layer !== 'preload'
    || (shape.contentType !== 'image/jpeg' && shape.contentType !== 'image/png')
    || !Number.isSafeInteger(shape.byteLength)
    || (shape.byteLength as number) < 0
    || (shape.byteLength as number) > 4 * 1024 * 1024
    || typeof shape.magic8 !== 'string'
    || !/^[0-9a-f]{0,16}$/u.test(shape.magic8)
    || typeof shape.bodyType !== 'string'
    || shape.bodyType.length > 64
    || typeof shape.isBuffer !== 'boolean'
    || typeof shape.isUint8Array !== 'boolean'
    || typeof shape.isArrayBuffer !== 'boolean'
    || typeof shape.valid !== 'boolean'
  ) {
    return
  }
  recordRoonImageShape({
    layer: 'preload',
    contentType: shape.contentType,
    byteLength: shape.byteLength as number,
    magic8: shape.magic8,
    bodyType: shape.bodyType,
    isBuffer: shape.isBuffer,
    isUint8Array: shape.isUint8Array,
    isArrayBuffer: shape.isArrayBuffer,
    valid: shape.valid,
  })
}

let remoteCoreStartup: ReturnType<typeof createRemoteCoreStartup> | undefined
let remoteCoreModeIntent = 0
const remoteCoreModeController = createRemoteCoreModeController({
  readMode: () => ({ mode: coreMode, remoteStreamPort }),
  setMode: (mode, port) => { coreMode = mode; remoteStreamPort = port },
  restart: async () => {
    if (!coreSupervisor) throw new CoreIpcError('NOT_READY', 'Core 尚未就绪，不能切换远程模式。')
    if (quitAfterCoreShutdown) throw new CoreIpcError('NOT_READY', '应用正在退出，不能启动Core。')
    remoteCoreStartup?.markCoreActivation()
    await coreSupervisor.restart(buildCoreEnvironment())
  },
})

async function restoreLocalCoreAfterTunnelFailure(state: RemoteCoreTunnelState): Promise<void> {
  if (quitAfterCoreShutdown) return
  try {
    await remoteCoreModeController.unavailable(state)
    mainDiagnostics.recordLifecycle('remote_core_fallback_checked', 'info', { state: coreMode })
    writeDiagnosticStdout(`[remote-core] fallback state=${coreMode}\n`)
  } catch (error) {
    mainDiagnostics.recordLifecycle('remote_core_fallback_failed', 'error', { code: 'CORE_RESTART_FAILED' })
    writeDiagnosticStderr('[remote-core] fallback failed code=CORE_RESTART_FAILED\n')
    throw error
  }
}

const remoteCoreTunnelManager = new RemoteCoreTunnelManager({
  onStateChanged: (state) => {
    if (state.status === 'failed' || state.status === 'disconnected') {
      const code = state.errorCode ?? 'UNKNOWN'
      mainDiagnostics.recordLifecycle(
        'remote_core_tunnel_failed',
        state.status === 'failed' ? 'error' : 'warn',
        { code, state: state.status },
      )
      writeDiagnosticStderr(
        `[remote-core] ${state.status} code=${code} port=${state.remoteStreamPort ?? '-'}\n`,
      )
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('remote-core:event', state)
    }
  },
  onTunnelBound: state => {
    if (quitAfterCoreShutdown) throw new CoreIpcError('NOT_READY', '应用正在退出，不能切换 Core。')
    return remoteCoreModeController.bound(state)
  },
  onTunnelUnavailable: state => restoreLocalCoreAfterTunnelFailure(state),
  onDisconnected: async state => {
    const stopped = coreSupervisor?.request('playback.stop', {}).catch(() => undefined)
    // 先捕获原绑定并启动回退；不能等停止播放后再用迟到状态撤销新绑定。
    await restoreLocalCoreAfterTunnelFailure(state)
    await stopped
  },
})

const EMPTY_PLAYBACK_SNAPSHOT: PlaybackSnapshot = {
  state: 'idle',
  queue: { items: [], index: -1, hasNext: false, hasPrevious: false },
  positionMs: 0,
  canNext: false,
  canPrevious: false,
  canStop: false,
  canPause: false,
  canResume: false,
}

const STARTING_BRIDGE_STATE: PublicBridgeState = {
  runtime: 'starting',
  roon: 'disconnected',
  provider: 'missing',
  activeStreamCount: 0,
  activePlaybackPresent: false,
}

function appInfo() {
  return {
    version: app.getVersion(),
    buildMode: app.isPackaged ? 'production' : 'development',
    platform: process.platform,
  } as const
}

function sendRendererCommand(command: 'show-queue'): void {
  const target = mainWindow
  if (!target || target.isDestroyed()) return
  const send = (): void => {
    if (!target.isDestroyed()) target.webContents.send('app:command', command)
  }
  if (target.webContents.isLoading()) target.webContents.once('did-finish-load', send)
  else send()
}

function showMainWindow(command?: 'show-queue'): void {
  const target = mainWindow
  if (!target || target.isDestroyed()) return
  if (target.isMinimized()) target.restore()
  if (isUiE2e) target.showInactive()
  else { target.show(); target.focus() }
  if (command) sendRendererCommand(command)
}

function createTrayIcon() {
  const icon = nativeImage.createFromDataURL(
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(trayTemplateSvg)}`,
  )
  if (process.platform === 'darwin') icon.setTemplateImage(true)
  return icon
}

function destroyTray(): void {
  trayRefreshQueued = false
  tray?.destroy()
  tray = undefined
}

function buildTrayMenu(
  supervisor: CoreSupervisor,
  snapshot: { bridge: PublicBridgeState; playback: PlaybackSnapshot },
  presentation: TrayPresentation,
): Electron.Menu {
  const runPlaybackCommand = (
    command: 'playback.previous' | 'playback.next' | 'playback.stop',
  ): void => {
    void supervisor
      .request(command, {})
      .catch(() => undefined)
      .finally(() => requestTrayRefresh(supervisor))
  }

  return Menu.buildFromTemplate([
    { label: presentation.statusLabel, enabled: false },
    { label: presentation.trackLabel, enabled: false },
    { type: 'separator' },
    { label: '打开 Mousa', click: () => showMainWindow() },
    {
      label: 'Previous',
      enabled: snapshot.playback.canPrevious,
      click: () => runPlaybackCommand('playback.previous'),
    },
    {
      label: 'Next',
      enabled: snapshot.playback.canNext,
      click: () => runPlaybackCommand('playback.next'),
    },
    {
      label: 'Stop',
      enabled: snapshot.playback.canStop,
      click: () => runPlaybackCommand('playback.stop'),
    },
    { label: 'Show Queue', click: () => showMainWindow('show-queue') },
    { label: 'Export Diagnostics', click: () => void exportDiagnosticsFromMain(supervisor) },
    { type: 'separator' },
    { label: '退出 Mousa', click: () => app.quit() },
  ])
}

function installApplicationMenu(): void {
  const editMenu: Electron.MenuItemConstructorOptions = {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
    ],
  }
  const windowMenu: Electron.MenuItemConstructorOptions = {
    label: 'Window',
    submenu: [
      { role: 'minimize' },
      { role: 'zoom' },
      { type: 'separator' },
      { role: 'front' },
    ],
  }
  const template: Electron.MenuItemConstructorOptions[] = process.platform === 'darwin'
    ? [
        {
          label: DISPLAY_NAME,
          submenu: [
            { role: 'about', label: `关于 ${DISPLAY_NAME}` },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide', label: `隐藏 ${DISPLAY_NAME}` },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit', label: `退出 ${DISPLAY_NAME}` },
          ],
        },
        editMenu,
        windowMenu,
      ]
    : [
        { label: 'File', submenu: [{ role: 'close' }, { role: 'quit' }] },
        editMenu,
        { role: 'viewMenu' },
        windowMenu,
      ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function requestTrayRefresh(supervisor: CoreSupervisor = coreSupervisor!): void {
  if (!tray || !supervisor) return
  trayRefreshQueued = true
  if (trayRefreshPromise) return

  trayRefreshPromise = (async () => {
    while (tray && trayRefreshQueued) {
      trayRefreshQueued = false
      try {
        const [bridge, playback] = await Promise.all([
          supervisor.request('core.getHealth', {}),
          supervisor.request('playback.getState', {}),
        ])
        if (!tray) return
        const snapshot = { bridge, playback }
        const presentation = buildTrayPresentation(snapshot)
        tray.setContextMenu(buildTrayMenu(supervisor, snapshot, presentation))
      } catch {
        if (!tray) return
        const snapshot = { bridge: STARTING_BRIDGE_STATE, playback: EMPTY_PLAYBACK_SNAPSHOT }
        const presentation = buildTrayPresentation(snapshot)
        tray.setContextMenu(buildTrayMenu(supervisor, snapshot, presentation))
      }
    }
  })().finally(() => {
    trayRefreshPromise = undefined
    if (trayRefreshQueued) requestTrayRefresh(supervisor)
  })
}

function createTray(supervisor: CoreSupervisor): void {
  if (process.platform !== 'darwin') return
  destroyTray()
  tray = new Tray(createTrayIcon())
  tray.setToolTip(DISPLAY_NAME)
  tray.on('click', () => showMainWindow())
  requestTrayRefresh(supervisor)
}

function installSessionSecurity(targetSession: Electron.Session): void {
  targetSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
  targetSession.setPermissionCheckHandler(() => false)
  targetSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          buildContentSecurityPolicy(app.isPackaged ? 'production' : 'development'),
        ],
      },
    })
  })
}

async function installRendererProtocol(): Promise<void> {
  const rendererRoot = await realpath(path.join(currentDirectory, '../renderer'))
  protocol.handle(RENDERER_SCHEME, async (request) => {
    if (!isAllowedRendererRequest(request.url, request.method)) {
      return new Response('Not Found', { status: 404 })
    }
    try {
      const url = new URL(request.url)
      if (url.hostname !== RENDERER_HOST) return new Response('Not Found', { status: 404 })
      if (url.pathname.startsWith('/reference-assets/')) {
        return cassetteCatalogService ? await cassetteCatalogService.image(request.url, request.method) : new Response(null, { status: 404 })
      }
      const assetPath = await getRendererAssetPath(rendererRoot, url.pathname)
      const body = request.method === 'HEAD' ? null : await readFile(assetPath)
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': rendererContentType(url.pathname),
          'Cache-Control': 'no-store',
        },
      })
    } catch {
      return new Response('Not Found', { status: 404 })
    }
  })
}

class PublicIpcError extends Error {
  readonly code: PublicErrorCode

  constructor(code: PublicErrorCode, message: string) {
    // Electron 通过 ipcRenderer.invoke() 传递异常时只保留 Error.message；
    // 将受控公开错误码写入消息，Renderer 才能安全恢复具体错误语义。
    super(`[${code}] ${message}`)
    this.name = 'PublicIpcError'
    this.code = code
  }
}

function publicIpcFailure(code: PublicErrorCode, message: string): never {
  throw new PublicIpcError(code, message)
}

function requireTrustedRenderer(event: Electron.IpcMainInvokeEvent): BrowserWindow {
  const target = mainWindow
  if (
    !target ||
    target.isDestroyed() ||
    event.sender !== target.webContents ||
    !isTrustedRendererSender({
      senderId: event.sender.id,
      windowId: target.webContents.id,
      frameUrl: event.senderFrame?.url ?? '',
    })
  ) {
    return publicIpcFailure('NOT_READY', 'Renderer sender rejected')
  }
  return target
}

async function invokeCore<T>(
  event: Electron.IpcMainInvokeEvent,
  operation: () => Promise<T>,
): Promise<T> {
  requireTrustedRenderer(event)
  try {
    return await operation()
  } catch (error) {
    if (error instanceof CoreIpcError) {
      return publicIpcFailure(error.code, error.message)
    }
    return publicIpcFailure('INTERNAL_ERROR', 'Core request failed')
  }
}

function requireChallengeId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 128) {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid QR challenge')
  }
  return value
}

function requireLibraryPage(value: unknown): PageRequest {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !['offset', 'limit'].includes(key))
  ) {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid library page')
  }
  const page = value as { offset?: unknown; limit?: unknown }
  if (
    typeof page.offset !== 'number' ||
    !Number.isSafeInteger(page.offset) ||
    page.offset < 0 ||
    page.offset > 1_000_000 ||
    typeof page.limit !== 'number' ||
    !Number.isSafeInteger(page.limit) ||
    page.limit < 1 ||
    page.limit > 100
  ) {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid library page')
  }
  return { offset: page.offset, limit: page.limit }
}

function requireFavoriteKind(value: unknown): FavoriteKind | undefined {
  if (value === undefined) return undefined
  if (value !== 'track' && value !== 'album' && value !== 'artist') {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid favorite kind')
  }
  return value
}

function requireFavoriteDescriptor(value: unknown): FavoriteEntityDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid favorite descriptor')
  }
  const descriptor = value as Record<string, unknown>
  const allowedKeys = new Set([
    'kind',
    'title',
    'subtitle',
    'artist',
    'album',
    'durationMs',
    'trackNumber',
    'discNumber',
    'year',
    'version',
  ])
  if (Object.keys(descriptor).some((key) => !allowedKeys.has(key))) {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid favorite descriptor')
  }
  const kind = requireFavoriteKind(descriptor.kind)
  const title = descriptor.title
  if (
    kind === undefined ||
    typeof title !== 'string' ||
    title.trim().length === 0 ||
    title.length > 512
  ) {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid favorite descriptor')
  }
  for (const key of ['subtitle', 'artist', 'album', 'version'] as const) {
    const field = descriptor[key]
    if (field !== undefined && (typeof field !== 'string' || field.length > 512)) {
      return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid favorite descriptor')
    }
  }
  for (const key of ['durationMs', 'trackNumber', 'discNumber', 'year'] as const) {
    const field = descriptor[key]
    if (
      field !== undefined &&
      (typeof field !== 'number' || !Number.isSafeInteger(field) || field < 0)
    ) {
      return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid favorite descriptor')
    }
  }
  const optionalText = (key: 'subtitle' | 'artist' | 'album' | 'version'): string | undefined =>
    typeof descriptor[key] === 'string' ? descriptor[key] as string : undefined
  const optionalNumber = (key: 'durationMs' | 'trackNumber' | 'discNumber' | 'year'): number | undefined =>
    typeof descriptor[key] === 'number' ? descriptor[key] as number : undefined
  const subtitle = optionalText('subtitle')
  const artist = optionalText('artist')
  const album = optionalText('album')
  const version = optionalText('version')
  const durationMs = optionalNumber('durationMs')
  const trackNumber = optionalNumber('trackNumber')
  const discNumber = optionalNumber('discNumber')
  const year = optionalNumber('year')
  return {
    kind,
    title,
    ...(subtitle !== undefined ? { subtitle } : {}),
    ...(artist !== undefined ? { artist } : {}),
    ...(album !== undefined ? { album } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(trackNumber !== undefined ? { trackNumber } : {}),
    ...(discNumber !== undefined ? { discNumber } : {}),
    ...(year !== undefined ? { year } : {}),
    ...(version !== undefined ? { version } : {}),
  }
}

function requireSearchQuery(value: unknown): string {
  if (typeof value !== 'string') {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid search query')
  }
  const query = value.trim()
  if (query.length === 0 || query.length > 100) {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid search query')
  }
  return query
}

function requirePlaylistId(value: unknown): string {
  if (typeof value !== 'string' || !/^\d+$/.test(value) || value === '0' || value.length > 128) {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid playlist')
  }
  return value
}

function requireZoneId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 128) {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid Roon zone')
  }
  return value
}

function requireRoonReference(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > 128 ||
    !/^musicbridge-v2-(?:entity|image)-[0-9a-f-]{36}$/u.test(value)
  ) {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid Roon Library reference')
  }
  return value
}

function requireRoonEntityReference(value: unknown): string {
  const reference = requireRoonReference(value)
  if (!reference.startsWith('musicbridge-v2-entity-')) {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid Roon entity reference')
  }
  return reference
}

function requireRoonQueueReferences(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PLAYBACK_QUEUE_ITEMS) {
    return publicIpcFailure('INVALID_IPC_REQUEST', '本地播放队列长度无效')
  }
  return value.map(requireRoonEntityReference)
}

function requireRoonPlaybackContextHandle(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)) {
    return publicIpcFailure('INVALID_IPC_REQUEST', '播放上下文句柄无效')
  }
  return value
}

function requireRoonImageOptions(value: unknown): RoonImageOptions | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid Roon image options')
  }
  const options = value as {
    scale?: unknown
    width?: unknown
    height?: unknown
    format?: unknown
  }
  if (
    Object.keys(options).some((key) => !['scale', 'width', 'height', 'format'].includes(key)) ||
    (options.scale !== undefined && !['fit', 'fill', 'stretch'].includes(String(options.scale))) ||
    (options.format !== undefined && !['image/jpeg', 'image/png'].includes(String(options.format))) ||
    (options.width !== undefined && (
      typeof options.width !== 'number' || !Number.isSafeInteger(options.width) || options.width < 1 || options.width > 2048
    )) ||
    (options.height !== undefined && (
      typeof options.height !== 'number' || !Number.isSafeInteger(options.height) || options.height < 1 || options.height > 2048
    ))
  ) {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid Roon image options')
  }
  return {
    ...(options.scale !== undefined ? { scale: options.scale as RoonImageOptions['scale'] } : {}),
    ...(options.width !== undefined ? { width: options.width } : {}),
    ...(options.height !== undefined ? { height: options.height } : {}),
    ...(options.format !== undefined ? { format: options.format as RoonImageOptions['format'] } : {}),
  }
}

function requirePlaybackTrackId(value: unknown): string {
  if (typeof value !== 'string' || !/^\d+$/.test(value) || value === '0' || value.length > 128) {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid playback track')
  }
  return value
}

/** 本地UUID仅选择Core当前播放歌词快照，不进入Provider播放/收藏等数字ID入口。 */
function requireLyricsTrackId(value: unknown): string {
  return isCollectionId(value) ? value : requirePlaybackTrackId(value)
}

function requireLyricsMatchId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/u.test(value)) {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid lyrics match session')
  }
  return value
}

function requireTrackSummary(value: unknown): TrackSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid match track')
  }
  const track = value as Record<string, unknown>
  const allowedKeys = new Set(['id', 'title', 'artists', 'album', 'durationMs', 'artworkUrl'])
  if (Object.keys(track).some((key) => !allowedKeys.has(key))) {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid match track')
  }
  const id = requirePlaybackTrackId(track.id)
  if (
    typeof track.title !== 'string' ||
    track.title.trim().length === 0 ||
    track.title.length > 512 ||
    typeof track.album !== 'string' ||
    track.album.trim().length === 0 ||
    track.album.length > 512 ||
    !Array.isArray(track.artists) ||
    track.artists.length > 64 ||
    track.artists.some((artist) => typeof artist !== 'string' || artist.trim().length === 0 || artist.length > 256)
  ) {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid match track')
  }
  if (
    track.durationMs !== undefined &&
    (typeof track.durationMs !== 'number' ||
      !Number.isSafeInteger(track.durationMs) ||
      track.durationMs < 0 ||
      track.durationMs > 24 * 60 * 60 * 1000)
  ) {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid match track')
  }
  if (track.artworkUrl !== undefined) {
    if (typeof track.artworkUrl !== 'string' || track.artworkUrl.length > 2_048) {
      return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid match track')
    }
    try {
      const url = new URL(track.artworkUrl)
      const hostname = url.hostname.toLowerCase()
      if (
        url.protocol !== 'https:' ||
        (hostname !== 'music.126.net' && !hostname.endsWith('.music.126.net')) ||
        url.username !== '' ||
        url.password !== '' ||
        url.hash !== ''
      ) {
        return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid match track')
      }
    } catch {
      return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid match track')
    }
  }
  return {
    id,
    title: track.title,
    artists: track.artists,
    album: track.album,
    ...(track.durationMs !== undefined ? { durationMs: track.durationMs } : {}),
    ...(track.artworkUrl !== undefined ? { artworkUrl: track.artworkUrl } : {}),
  }
}

function requirePlaybackQualityPreference(value: unknown): PlaybackQualityPreference {
  if (!['auto', 'standard', 'exhigh', 'lossless', 'hires'].includes(String(value))) {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid playback quality preference')
  }
  return value as PlaybackQualityPreference
}

function requireRendererClickAtMs(value: unknown, receivedAtMs: number): number {
  if (value === undefined) return receivedAtMs
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > receivedAtMs + 1_000 ||
    value < receivedAtMs - 60_000
  ) {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid playback startup timestamp')
  }
  return value
}

function requirePlaybackSourcePreference(value: unknown): PlaybackSourcePreference {
  if (!['smart', 'netease', 'roon'].includes(String(value))) {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid playback source preference')
  }
  return value as PlaybackSourcePreference
}

function requirePlaybackQueue(value: unknown): readonly PlaybackQueueRequestItem[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PLAYBACK_QUEUE_ITEMS) {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid playback queue')
  }
  return value.map((item) => {
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      Object.keys(item).some((key) => !['trackId', 'qualityPreference', 'preferredSource'].includes(key))
    ) {
      return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid playback queue')
    }
    const queueItem = item as { trackId?: unknown; qualityPreference?: unknown; preferredSource?: unknown }
    const preferredSource = queueItem.preferredSource === undefined
      ? {}
      : { preferredSource: requirePlaybackSourcePreference(queueItem.preferredSource) }
    return {
      trackId: requirePlaybackTrackId(queueItem.trackId),
      qualityPreference: requirePlaybackQualityPreference(queueItem.qualityPreference),
      ...preferredSource,
    }
  })
}

function requirePlaybackIndex(value: unknown, items: readonly PlaybackQueueRequestItem[]): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value >= items.length
  ) {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid playback queue index')
  }
  return value
}

function requireExistingPlaybackIndex(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value >= MAX_PLAYBACK_QUEUE_ITEMS
  ) {
    return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid playback queue index')
  }
  return value
}

async function saveQrCredential(
  supervisor: CoreSupervisor,
  credentialVault: CredentialVault,
  credential: string,
): Promise<void> {
  try {
    await credentialVault.save(credential)
    await supervisor.request('auth.setCredential', { credential })
  } catch (error) {
    // Keep an encrypted credential after a transient Core/IPC failure. The
    // next cold-start or Core restart will verify it through login_status.
    if (error instanceof CoreIpcError || error instanceof Error) {
      await supervisor.request('auth.clearCredential', {}).catch(() => undefined)
    }
    throw error
  }
}

async function exportDiagnosticsFromMain(
  supervisor: CoreSupervisor,
): Promise<{ exported: boolean }> {
  mainDiagnostics.recordLifecycle('diagnostics_export_requested')
  const core = await supervisor.request('core.getDiagnostics', {})
  const testOutputPath = isUiE2e ? process.env.MUSIC_BRIDGE_DIAGNOSTIC_EXPORT_PATH : undefined
  const selection = testOutputPath
    ? { canceled: false, filePath: testOutputPath }
    : mainWindow
      ? await dialog.showSaveDialog(mainWindow, {
          title: '导出 Mousa 诊断文件',
          defaultPath: 'MusicBridge-diagnostics.json',
          filters: [{ name: 'JSON', extensions: ['json'] }],
        })
      : await dialog.showSaveDialog({
          title: '导出 Mousa 诊断文件',
          defaultPath: 'MusicBridge-diagnostics.json',
          filters: [{ name: 'JSON', extensions: ['json'] }],
        })
  if (selection.canceled || !selection.filePath) return { exported: false }

  // 原手动诊断合同仍为v1；连续v2走显式stdout闭集及配套reader，不伪装成旧schema。
  const rangeWindow = mobileRangeWindowProbe?.snapshot()
  await writeDiagnosticReport(selection.filePath, {
    platform: {
      platform: process.platform,
      arch: process.arch,
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron ?? 'unknown',
      nodeVersion: process.versions.node,
    },
    ...(performanceIpc.rendererSnapshot() ? { rendererPerformance: performanceIpc.rendererSnapshot()! } : {}),
    main: mainDiagnostics.snapshot(core.health),
    privateEvidence: { version: 1, ...(desktopArtworkTraceEnabled ? { desktopArtwork: snapshotDesktopArtwork() } : {}), localAlbum: supervisor.getLocalAlbumReadTraceSnapshot(), localPlayback: supervisor.getLocalPlaybackEvidenceSnapshot(), mobileCapability: supervisor.getMobileCapabilityTraceSnapshot(),
      ...(mobileRangeTimingProbe ? { mobileRangeTiming: mobileRangeTimingProbe.snapshot() } : {}),
      ...(rangeWindow?.schema === 'mb.mobile-range-window.v1' ? { mobileRangeWindow: rangeWindow } : {}),
      ...(mobilePreparationProbe ? { mobilePreparation: mobilePreparationProbe.snapshot() } : {}) },
    core,
    gates: [
      ...mainDiagnostics.snapshot(core.health).gates,
      ...core.gates,
      { name: 'diagnostic-export', status: 'pass' },
    ],
  })
  mainDiagnostics.recordLifecycle('diagnostics_export_completed')
  return { exported: true }
}

/** 实际Main资源装配；Provider/Native对象不进入Renderer或Owner序列化合同。 */
function createCurrentLocalWorkbenchResources(author: LocalWorkbenchRootMainAuthor, physicalTestTransport?: Readonly<{
  nameFetch: typeof globalThis.fetch
  artworkTransport: import('./commons-artwork-provider.js').PinnedArtworkTransport
  readTransportAvailability?: (signal:AbortSignal)=>boolean|Promise<boolean>
  promptHost?: Parameters<typeof createLocalWorkbenchNativeChooser>[0]['promptHost']
  /** 工程夹具只能提供真实宿主窗口；正式使用原主窗口。 */
  panelHost?: BrowserWindow
}>) {
  if (!coreDataDirectory) throw new CoreIpcError('NOT_READY', '整理私有数据目录尚未就绪。')
  const binding = author.binding
  let resourcesCreated=false,resourcesClosing=false,resourcesClosed=false,artworkCreated=false,webCreated=false
  const originalShellOpen=shell.openExternal,originalViewConstructor=WebContentsView,originalSessionPort=session.fromPartition
  const originalTestPanelHost=physicalTestTransport?.panelHost
  const panelHost=originalTestPanelHost ?? mainWindow
  const panelContents=panelHost&&!panelHost.isDestroyed()?panelHost.webContents:undefined
  const trustedPanel=()=>!!panelHost&&!panelHost.isDestroyed()&&!panelHost.webContents.isDestroyed()
    &&physicalTestTransport?.panelHost===originalTestPanelHost
    &&(!!originalTestPanelHost||isTrustedRendererSender({senderId:panelHost.webContents.id,windowId:panelHost.webContents.id,frameUrl:panelHost.webContents.getURL()}))
  const assertCurrent = async () => {
    if (quitAfterCoreShutdown || localWorkbenchRootMainAuthor !== author || coreSupervisor?.status !== 'ready') throw new CoreIpcError('OUTBOX_SCOPE_MISMATCH', '原整理Main作者已经撤销。')
    await author.assertCurrent(binding)
    if (quitAfterCoreShutdown || localWorkbenchRootMainAuthor !== author || coreSupervisor?.status !== 'ready') throw new CoreIpcError('OUTBOX_SCOPE_MISMATCH', '原整理Main作者已经撤销。')
  }
  let directoryBridge:ReturnType<typeof createLocalWorkbenchDirectoryMainBridge>
  const nativeChooser = createLocalWorkbenchNativeChooser({ assertCurrent: async context => {
    if (context.datasetId !== binding.datasetId) throw new CoreIpcError('OUTBOX_SCOPE_MISMATCH', '原选择不属于该工作库。')
    await assertCurrent()
  },registerLibraryDirectory:(approved,context)=>directoryBridge.registerLibraryDirectory(approved,context),registerCueTarget:(approved,context)=>directoryBridge.registerCueTarget(approved,context),revokeDirectory:approved=>directoryBridge.revokeDirectory(approved), ...(physicalTestTransport?.promptHost ? { promptHost: physicalTestTransport.promptHost } : {}) })
  if(!coreSupervisor)throw new CoreIpcError('NOT_READY','目录原物理Supervisor未就绪。')
  const directorySupervisor=coreSupervisor
  directoryBridge=createLocalWorkbenchDirectoryMainBridge({currentAuthor:()=>localWorkbenchRootMainAuthor,chooser:nativeChooser,registration:(command,binding,actual,signal)=>directorySupervisor.requestWorkbenchDirectoryRegistration(command,binding,actual,signal),ownerClosed:actual=>directorySupervisor.waitWorkbenchDirectoryOwnerClosed(actual)})
  localWorkbenchDirectoryBridge=directoryBridge
  localWorkbenchNativeChooser = nativeChooser
  const settings = createLocalNameSettings({ file: path.join(coreDataDirectory, 'local-name-settings.json'),
    vault: new CredentialVault({ filePath: path.join(coreDataDirectory, 'local-name-cloud.credential'), storage: safeStorage }), securePrompt: nativeChooser.securePrompt })
  const names = createLocalNameTransport({ getConfiguration: backend => settings.getConfiguration(backend), resolveSecret: (backend, configuration, signal) => settings.resolveSecret(backend, configuration, signal), ...(physicalTestTransport ? { fetch: physicalTestTransport.nameFetch } : {}) })
  const originalTransportState=physicalTestTransport?.readTransportAvailability
  const artwork = createLocalArtworkProviders({ normalize: async (bytes, signal) => (await normalizeLocalArtworkInWorker(bytes, signal)).image,
    ...(physicalTestTransport ? { transport: physicalTestTransport.artworkTransport } : {}),
    async readTransportAvailability(signal){
      if(signal.aborted||!resourcesCreated||!artworkCreated||resourcesClosing||resourcesClosed)return false
      await assertCurrent()
      const ready=physicalTestTransport?typeof originalTransportState==='function'&&await originalTransportState(signal)===true:artworkCreated
      await assertCurrent()
      return ready&&!signal.aborted&&resourcesCreated&&artworkCreated&&!resourcesClosing&&!resourcesClosed
        &&(!physicalTestTransport||physicalTestTransport.readTransportAvailability===originalTransportState)
    } })
  artworkCreated=true
  const windows = new Map<WebContentsView, Promise<void>>()
  const viewIdentities=new Map<WebContentsView,string>()
  let viewportEpoch=0
  const hideWebViews=()=>{for(const view of windows.keys())if(!view.webContents.isDestroyed())view.setVisible(false)}
  const closeOwnedWebView=(view:WebContentsView)=>{if(!view.webContents.isDestroyed()){view.setVisible(false);if(panelHost&&!panelHost.isDestroyed())panelHost.contentView.removeChildView(view);view.webContents.close({waitForBeforeUnload:false})}}
  // 只从原应用页面读取实际宿主身份与布局；离开原捕获则实闭，临时遮挡只隐藏。
  async function syncWebViewport():Promise<void>{
    const epoch=++viewportEpoch
    await assertCurrent()
    if(!panelHost||!trustedPanel()){hideWebViews();return}
    const viewport:unknown=await panelHost.webContents.executeJavaScript(`(() => {
      const hosts=[...document.querySelectorAll('[data-musicbridge-artwork-web-host]')];if(hosts.length>24)return null;
      return hosts.map(host=>{
        const identity=host.getAttribute('data-musicbridge-artwork-web-identity')??'';
        const blocking=[...document.querySelectorAll('dialog[open],[aria-modal="true"]')].some(node=>node!==host&&!node.contains(host)&&node.getClientRects().length>0);
        if(document.visibilityState!=='visible'||blocking||host.closest('[hidden],[aria-hidden="true"]')||!host.getClientRects().length)return {identity,visible:false,bounds:null};
        let rect=host.getBoundingClientRect(),left=Math.max(0,rect.left),top=Math.max(0,rect.top),right=Math.min(innerWidth,rect.right),bottom=Math.min(innerHeight,rect.bottom);
        for(let parent=host.parentElement;parent;parent=parent.parentElement){const style=getComputedStyle(parent);if(/auto|scroll|hidden|clip/.test(style.overflow+style.overflowX+style.overflowY)){const box=parent.getBoundingClientRect();left=Math.max(left,box.left);top=Math.max(top,box.top);right=Math.min(right,box.right);bottom=Math.min(bottom,box.bottom)}}
        if(right-left<80||bottom-top<80)return {identity,visible:false,bounds:null};
        return {identity,visible:true,bounds:{x:Math.ceil(left),y:Math.ceil(top),width:Math.floor(right)-Math.ceil(left),height:Math.floor(bottom)-Math.ceil(top)}};
      });
    })()`)
    await assertCurrent()
    if(epoch!==viewportEpoch||resourcesClosing||resourcesClosed||panelHost.isDestroyed())return
    hideWebViews()
    if(!Array.isArray(viewport)||viewport.length>24||viewport.some(item=>!item||typeof item!=='object'||Object.keys(item).sort().join(',')!=='bounds,identity,visible'||typeof item.identity!=='string'||item.identity.length>4096||typeof item.visible!=='boolean'))return
    const content=panelHost.getContentBounds(),zoom=panelHost.webContents.getZoomFactor(),closures:Promise<void>[]=[]
    for(const [view,closed]of windows){
      const matches=viewport.filter(item=>item.identity===viewIdentities.get(view))
      if(matches.length!==1){closeOwnedWebView(view);closures.push(closed);continue}
      const item=matches[0];if(view.webContents.isDestroyed()||!item.visible||!item.bounds||typeof item.bounds!=='object'||Array.isArray(item.bounds)||!Number.isFinite(zoom)||zoom<=0)continue
      const rawBounds=item.bounds as Electron.Rectangle
      if(Object.keys(rawBounds).sort().join(',')!=='height,width,x,y'||![rawBounds.x,rawBounds.y,rawBounds.width,rawBounds.height].every(Number.isSafeInteger))continue
      const bounds={x:Math.ceil(rawBounds.x*zoom),y:Math.ceil(rawBounds.y*zoom),width:Math.floor((rawBounds.x+rawBounds.width)*zoom)-Math.ceil(rawBounds.x*zoom),height:Math.floor((rawBounds.y+rawBounds.height)*zoom)-Math.ceil(rawBounds.y*zoom)}
      if(bounds.x<0||bounds.y<0||bounds.width<80||bounds.height<80||bounds.x+bounds.width>content.width||bounds.y+bounds.height>content.height)continue
      view.setBounds(bounds);view.setVisible(true)
    }
    await Promise.all(closures)
  }
  let viewportWork:Promise<void>|undefined,viewportQueued=false
  const viewportChanged=()=>{
    viewportQueued=true
    if(!viewportWork){const work=(async()=>{while(viewportQueued&&!resourcesClosing&&!resourcesClosed){viewportQueued=false;await syncWebViewport()}})().catch(hideWebViews).finally(()=>{if(viewportWork===work)viewportWork=undefined});viewportWork=work}
  }
  const viewportNotification=(event:Electron.IpcMainEvent,channel:string)=>{if(channel==='localWorkbench:web-layout'&&panelHost&&!panelHost.isDestroyed()&&event.sender===panelHost.webContents&&event.senderFrame===panelHost.webContents.mainFrame&&trustedPanel())viewportChanged()}
  const closeWebViews=()=>{viewportEpoch++;for(const view of windows.keys())closeOwnedWebView(view)}
  panelContents?.on('ipc-message',viewportNotification);panelHost?.on('resize',viewportChanged);panelHost?.once('closed',closeWebViews)
  const webReloads=new Map<string,{signal:AbortSignal;url:string;reload(context:{signal:AbortSignal;originalSignal:AbortSignal;captureId:string}):Promise<void>}>()
  const checkedWeb = (value: URL) => value.protocol === 'https:' && !value.username && !value.password && !value.port && !value.hash
    && (value.hostname === 'search.douban.com' && value.pathname === '/music/subject_search'
      || value.hostname === 'www.bing.com' && value.pathname === '/images/search'
      || value.hostname === 'www.google.com' && value.pathname === '/search')
  const navigation = createLocalArtworkWebNavigation({
    async readPortAvailability(mode,signal){
      if(signal.aborted||!resourcesCreated||!webCreated||resourcesClosing||resourcesClosed||!app.isReady())return false
      await assertCurrent()
      const portCurrent=()=>mode!=='openExternal'?WebContentsView===originalViewConstructor&&session.fromPartition===originalSessionPort&&trustedPanel():shell.openExternal===originalShellOpen
      const ready=portCurrent()
      await assertCurrent()
      return ready&&portCurrent()&&!signal.aborted&&resourcesCreated&&webCreated&&!resourcesClosing&&!resourcesClosed&&app.isReady()
    },
    async navigate(url, context) {
      await assertCurrent(); if (!checkedWeb(url) || context.signal.aborted) throw new Error('整理网页来源或原请求无效。')
      if(typeof context.hostIdentity!=='string'||context.hostIdentity.length<1||context.hostIdentity.length>4096)throw new Error('原工作区网页宿主身份未绑定。')
      const isolated = session.fromPartition('local-workbench-web-' + randomUUID())
      isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
      if(!panelHost||panelHost.isDestroyed()||panelHost.webContents.isDestroyed())throw new Error('原工作区宿主窗口尚未就绪。')
      const window = new WebContentsView({ webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false } })
      window.setVisible(false);panelHost.contentView.addChildView(window)
      const closed = new Promise<void>(resolve => window.webContents.once('destroyed', () => { if(!panelHost.isDestroyed())panelHost.contentView.removeChildView(window);windows.delete(window);viewIdentities.delete(window);webReloads.delete(context.captureId);resolve() })); windows.set(window, closed);viewIdentities.set(window,context.hostIdentity)
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      window.webContents.on('will-navigate', (event, next) => { try { if (!checkedWeb(new URL(next))) event.preventDefault() } catch { event.preventDefault() } })
      window.webContents.on('will-redirect', (event, next) => { try { if (!checkedWeb(new URL(next))) event.preventDefault() } catch { event.preventDefault() } })
      const cancel = () => { closeOwnedWebView(window) }
      // 捕获只在此自有网页的隔离world内响应真实dragstart，不开放网页IPC或自动导入。
      // 每次拖图携带原导航UUID和有界序号；旧窗口/旧拖图不能借下一次缓存。
      const dragWorld = 1001, dragSlot = '__musicbridgeTakeArtworkDrag'
      let nextDocumentSequence = 1, dragDocumentGeneration = 0, dragDocumentReady = false
      const installDragCapture = () => {
        // 原Main窗口跨document分配不重叠序号段；网页刷新不能把旧'.1'复用给新图片。
        const firstSequence = nextDocumentSequence, lastSequence = Math.min(999999, firstSequence + 1023)
        nextDocumentSequence = lastSequence + 1
        return window.webContents.executeJavaScriptInIsolatedWorld(dragWorld, [{ code: `(() => {
        if (Object.hasOwn(globalThis, ${JSON.stringify(dragSlot)})) return;
        const originalId = ${JSON.stringify(context.captureId)};
        let sequence = ${firstSequence - 1}, captured = null;
        Object.defineProperty(globalThis, ${JSON.stringify(dragSlot)}, { value: expected => {
          if (!captured || captured.ref !== expected) return null;
          const original = captured; captured = null;
          const ageMs = performance.now() - original.at;
          return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= 30000 ? { url: original.url, ageMs } : null;
        }});
        document.addEventListener('dragstart', event => {
          if (!event.isTrusted || !event.dataTransfer || sequence >= ${lastSequence}) return;
          const image = event.composedPath().find(node => node instanceof HTMLImageElement);
          if (!image) return;
          const url = image.currentSrc || image.src;
          if (typeof url !== 'string' || !url.startsWith('https:') || url.length > 2048) return;
          const ref = originalId + '.' + (++sequence);
          try { event.dataTransfer.setData('application/x-musicbridge-artwork-drag', ref); }
          catch { return; }
          captured = { ref, url, at: performance.now() };
        }, true);
      })()` }])
      }
      let dragCaptureReady: Promise<unknown> = Promise.resolve()
      window.webContents.on('did-start-navigation', details => { if (details.isMainFrame && !details.isSameDocument) { dragDocumentGeneration++; dragDocumentReady = false } })
      window.webContents.on('dom-ready', () => {
        const generation = ++dragDocumentGeneration; dragDocumentReady = false
        dragCaptureReady = installDragCapture().then(() => { if (generation === dragDocumentGeneration) dragDocumentReady = true })
        void dragCaptureReady.catch(cancel)
      })
      context.signal.addEventListener('abort', cancel, { once: true })
      webReloads.set(context.captureId,{signal:context.signal,url:url.href,async reload(refreshContext){
        await assertCurrent()
        if(refreshContext.originalSignal!==context.signal||refreshContext.captureId!==context.captureId||refreshContext.signal.aborted||context.signal.aborted||window.webContents.isDestroyed())throw new Error('原整理网页已经撤销。')
        await syncWebViewport()
        // 在真正reload前封旧document；沿原UUID分配后续序号，绝不重置或重新navigate。
        dragDocumentGeneration++;dragDocumentReady=false
        await new Promise<void>((resolve,reject)=>{
          let settled=false
          const cleanup=()=>{window.webContents.removeListener('dom-ready',ready);window.webContents.removeListener('did-fail-load',failed);window.webContents.removeListener('destroyed',gone);refreshContext.signal.removeEventListener('abort',aborted)}
          const finish=(error?:Error)=>{if(settled)return;settled=true;cleanup();if(error)reject(error);else resolve()}
          const gone=()=>finish(new Error('原整理网页已关闭。'))
          const aborted=()=>{cancel();finish(new Error('原网页刷新已撤销。'))}
          const failed=(_event:unknown,_code:number,_description:string,_url:string,isMainFrame:boolean)=>{if(isMainFrame){cancel();finish(new Error('原网页刷新未完成。'))}}
          const ready=()=>{void(async()=>{await dragCaptureReady;await assertCurrent();if(refreshContext.signal.aborted||context.signal.aborted||window.webContents.isDestroyed()||!dragDocumentReady)throw new Error('原网页document尚未确认。')})().then(()=>finish(),()=>{cancel();finish(new Error('原网页刷新未获确认。'))})}
          window.webContents.once('dom-ready',ready);window.webContents.on('did-fail-load',failed);window.webContents.once('destroyed',gone);refreshContext.signal.addEventListener('abort',aborted,{once:true})
          if(refreshContext.signal.aborted||context.signal.aborted)aborted();else try{window.webContents.reload()}catch{cancel();finish(new Error('原网页刷新未开始。'))}
        })
      }})
      // 打开完成与自有窗口退出分别记账；原库撤销后仍须沿同signal等真正closed。
      void closed.then(() => { context.signal.removeEventListener('abort', cancel) })
      try {
        registerLocalArtworkNavigationPhysical(context.signal,{closed,abort:cancel,async readCapturedImage(dragRef: string) {
          await assertCurrent()
          if (context.signal.aborted || window.webContents.isDestroyed() || !dragDocumentReady) return null
          const documentGeneration = dragDocumentGeneration
          const captured = await window.webContents.executeJavaScriptInIsolatedWorld(dragWorld, [{ code: `globalThis[${JSON.stringify(dragSlot)}]?.(${JSON.stringify(dragRef)}) ?? null` }])
          await assertCurrent()
          if (context.signal.aborted || window.webContents.isDestroyed() || !dragDocumentReady || dragDocumentGeneration !== documentGeneration) return null
          return captured
        }})
        await window.webContents.loadURL(url.href); await dragCaptureReady; await assertCurrent()
        if(context.signal.aborted||window.webContents.isDestroyed())throw new Error('原整理网页已经撤销。')
        await syncWebViewport();if(context.signal.aborted||window.webContents.isDestroyed())throw new Error('原网页工作区已离开。')
      } catch(error){cancel();await closed;throw error}
    },
    async refresh(url,context){await assertCurrent();const original=webReloads.get(context.captureId);if(!checkedWeb(url)||!original||original.signal!==context.originalSignal||original.url!==url.href||context.signal.aborted)throw new Error('原网页刷新捕获无效。');await original.reload(context);await assertCurrent()},
    async openExternal(url, context) { await assertCurrent(); if (!checkedWeb(url) || context.signal.aborted) throw new Error('整理网页来源或原请求无效。'); await shell.openExternal(url.href); await assertCurrent(); if(context.signal.aborted)throw new Error('原外部打开结果已撤销。') },
  })
  webCreated=true
  const service = createLocalWorkbenchService({ directoryAuthorization:directoryBridge, owner: createLocalWorkbenchTransportOwner(author), names, artwork, navigation, nativeChooser,
    artworkSources: { aggregate: { kind: 'provider', source: 'douban-itunes' }, douban: { kind: 'provider', source: 'douban' }, itunes: { kind: 'provider', source: 'itunes' },
      'google-web': { kind: 'web', source: 'google-images' }, 'bing-web': { kind: 'web', source: 'bing-images' }, 'douban-web': { kind: 'web', source: 'douban-web' } }, decode: bytes => nativeImage.createFromBuffer(bytes) })
  resourcesCreated=true
  let closing: Promise<void> | undefined
  return { service, names: settings, nameTransport: names, close(): Promise<void> {
    if (!closing) closing = (async () => {
      resourcesClosing=true;artworkCreated=false;webCreated=false;viewportEpoch++
      panelContents?.removeListener('ipc-message',viewportNotification);panelHost?.removeListener('resize',viewportChanged);panelHost?.removeListener('closed',closeWebViews)
      if(viewportWork)await viewportWork
      const windowClosures = [...windows].map(([window, closed]) => { if (!window.webContents.isDestroyed()) window.webContents.close({waitForBeforeUnload:false}); return closed })
      await service.close()
      await directoryBridge.close()
      await nativeChooser.closeApprovedDirectories()
      const results = await Promise.allSettled([settings.close(), ...windowClosures])
      if (localWorkbenchNativeChooser === nativeChooser) localWorkbenchNativeChooser = undefined
      if(localWorkbenchDirectoryBridge===directoryBridge)localWorkbenchDirectoryBridge=undefined
      if (results.some(item => item.status === 'rejected')) throw new Error('原整理Main/Provider/Native资源关闭未确认。')
      resourcesClosed=true
    })()
    return closing
  } }
}

/** 三个只读专辑入口固定本次实际作者；同dataset新代也不能接收旧代迟到结果。 */
function registerCurrentLocalAlbumIpc(supervisor: CoreSupervisor, assembly: ReturnType<typeof createLocalWorkbenchMainAssembly>): void {
  type ReadScope = { author: LocalWorkbenchRootMainAuthor; pin: ReturnType<typeof assembly.captureLocalAlbumReadAuthor> }
  const reads = new AsyncLocalStorage<ReadScope>()
  const trusted = (event: Electron.IpcMainInvokeEvent) => {
    const target = requireTrustedRenderer(event)
    if (event.senderFrame !== target.webContents.mainFrame) publicIpcFailure('NOT_READY', '本地专辑只允许当前应用主页面。')
  }
  const checkLocal = (scope: ReadScope) => {
    if (quitAfterCoreShutdown || coreSupervisor !== supervisor || supervisor.status !== 'ready' || localWorkbenchRootMainAuthor !== scope.author)
      throw new CoreIpcError('OUTBOX_SCOPE_MISMATCH', '原本地专辑Owner或Utility已经改变。')
    scope.pin.assertCurrent()
  }
  const check = async (scope: ReadScope) => {
    const started = performance.now()
    let succeeded = false
    try {
      checkLocal(scope)
      // 每次独立IPC首末都实核Owner；中间复用本操作的Main引用栅栏，避免15次串行身份RPC。
      await scope.pin.verifyCurrent()
      checkLocal(scope)
      succeeded = true
    } finally {
      const elapsedMs = Math.max(0, performance.now() - started)
      if (elapsedMs >= 50) logLibraryOperation('library', 'albums.author-check', succeeded ? 'complete' : 'error', { elapsedMs, slowAfterMs: 50 })
    }
  }
  const capture = async (datasetId: string) => {
    const scope = reads.getStore()
    if (!scope) throw new CoreIpcError('NOT_READY', '本地专辑本次读取上下文尚未就绪。')
    checkLocal(scope)
    const datasetMatched = scope.pin.binding.datasetId === datasetId; localAlbumMatch('dataset', datasetMatched)
    if (!datasetMatched) throw new CoreIpcError('OUTBOX_SCOPE_MISMATCH', '原本地专辑工作库已经改变。')
    return scope
  }
  registerLocalAlbumIpc({
    ipcMain: { handle: (channel, handler) => registerPerformanceHandler(channel, (event, value) => runLocalAlbumMainRead(value, async () => {
      const started = performance.now()
      localAlbumPhase('main.trusted'); trusted(event); localAlbumMatch('trusted', true)
      localAlbumPhase('main.author'); const author = localWorkbenchRootMainAuthor
      if (!author) throw new CoreIpcError('NOT_READY', '本地专辑真实Owner尚未就绪。')
      const scope: ReadScope = { author, pin: assembly.captureLocalAlbumReadAuthor(author.binding.datasetId) }
      return reads.run(scope, async () => {
        await check(scope)
        const result = await handler(event, value)
        localAlbumPhase('main.trusted'); trusted(event); localAlbumMatch('trusted', true); localAlbumPhase('main.author'); await check(scope)
        localAlbumPhase('main.trusted'); trusted(event); localAlbumMatch('trusted', true)
        logLibraryOperation('library', 'albums.main-reply', 'complete', { elapsedMs: Math.max(0, performance.now() - started) })
        return result
      })
    })) },
    assertTrusted: event => trusted(event as Electron.IpcMainInvokeEvent),
    assertDataset: async datasetId => { await capture(datasetId) },
    read: async (request, datasetId) => {
      localAlbumPhase('main.dataset'); const scope = await capture(datasetId); localAlbumMatch('dataset', true)
      const call = { version: 1 as const, type: 'local-album-main-request' as const, id: randomUUID(), datasetId, request: structuredClone(request) }
      localAlbumLink(call.id, 'main.dispatch'); const reply = await supervisor.readLocalAlbum(call)
      localAlbumPhase('main.author'); checkLocal(scope)
      localAlbumPhase('main.dto'); const responseValid = isLocalAlbumMainResponse(reply, call); localAlbumMatch('dto', responseValid)
      if (!responseValid) throw new CoreIpcError('INVALID_IPC_RESPONSE', '原本地专辑结果身份无效。')
      if (!reply.ok) { localAlbumPhase('main.response'); localAlbumRejectCode(reply.error.code); throw new Error(reply.error.message) }
      return reply.result
    },
  })
}

function registerIpcHandlers(
  supervisor: CoreSupervisor,
  credentialVault: CredentialVault,
): void {
  if (!coreDataDirectory) throw new Error('命令outbox缺少私有数据目录')
  if (!mobileConnectionSettings) throw new Error('移动连接设置尚未初始化。')
  if (!artistCatalogService) throw new Error('艺术家目录尚未初始化。')
  installArtistCatalogHandlers<Electron.IpcMainInvokeEvent>({
    handle: (channel, handler) => registerPerformanceHandler(channel, handler),
    requireTrusted: event => {
      if (quitAfterCoreShutdown) throw new CoreIpcError('NOT_READY', '艺术家目录正在关闭。')
      const target = requireTrustedRenderer(event)
      if (event.senderFrame !== target.webContents.mainFrame) throw new CoreIpcError('NOT_READY', '艺术家查询只允许当前应用主页面。')
    },
    service: artistCatalogService,
  })
  installMobileConnectionHandlers<Electron.IpcMainInvokeEvent>({ handle: (channel, handler) => ipcMain.handle(channel, handler),
    requireTrusted: event => { requireTrustedRenderer(event); if (!mainWindow || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('移动连接只允许当前应用主页面。'); },
    settings: mobileConnectionSettings })
  const store = createCommandOutboxStore({ filePath: path.join(coreDataDirectory, 'command-outbox.v1.sqlite') })
  let sourcePickerBusy = false
  const pickLocalLibrary = async (options:CommandOutboxPickOptions) => {
    if (sourcePickerBusy || quitAfterCoreShutdown || !mainWindow || mainWindow.isDestroyed()) throw new CoreIpcError('NOT_READY', '目录或文件选择器暂不可用')
    sourcePickerBusy = true
    try { return await dialog.showOpenDialog(mainWindow, options) }
    finally { sourcePickerBusy = false }
  }
  const executor = createCommandOutboxExecutor({supervisor,pick:pickLocalLibrary})
  installLocalLibraryHandlers({handle:(channel,handler)=>registerPerformanceHandler(channel,handler),requireTrusted:requireTrustedRenderer,supervisor,pick:pickLocalLibrary})
  installLocalOrganizerHandlers({handle:(channel,handler)=>registerPerformanceHandler(channel,handler),requireTrusted:requireTrustedRenderer,supervisor})
  const assembly = createLocalWorkbenchMainAssembly({ currentAuthor: () => localWorkbenchRootMainAuthor, createResources: createCurrentLocalWorkbenchResources })
  localWorkbenchMainAssembly = assembly
  registerCurrentLocalAlbumIpc(supervisor, assembly)
  void bindCurrentLocalWorkbenchRootMainAuthor(supervisor)
  const trustedWorkbench = (event: Electron.IpcMainInvokeEvent) => { if(quitAfterCoreShutdown)publicIpcFailure('NOT_READY','整理正在退出，不再接受新请求。');const target=requireTrustedRenderer(event);if(event.senderFrame!==target.webContents.mainFrame)publicIpcFailure('NOT_READY','整理操作只允许当前应用主页面。') }
  localWorkbenchLegacyIpc = registerLocalWorkbenchIpc({ ipcMain: { handle: (channel,handler) => registerPerformanceHandler(channel,(event,value) => handler(event,value)), removeHandler: channel => ipcMain.removeHandler(channel) },
    assertTrusted: event => trustedWorkbench(event as Electron.IpcMainInvokeEvent),
    assertDataset: async datasetId => { await assembly.captureAuthor(datasetId) }, captureAuthor: datasetId => assembly.captureAuthor(datasetId),
    request: (request,context) => assembly.request(request,context), closeReadResources: () => assembly.closeReadResources() })
  const managementBoundary = createLocalWorkbenchManagementBoundary<Electron.IpcMainInvokeEvent>({
    assertTrusted: event => {
      const target = requireTrustedRenderer(event)
      if (event.senderFrame !== target.webContents.mainFrame) publicIpcFailure('NOT_READY', '整理操作只允许当前应用主页面。')
    },
    isAccepting: () => coreSupervisor === supervisor && supervisor.status === 'ready' && !quitAfterCoreShutdown,
    currentAuthor: () => localWorkbenchRootMainAuthor,
    nameSettings: assembly.nameSettings,
    prepareLibraryImport: async context => {
      await context.assertCurrent()
      if (!localWorkbenchNativeChooser) throw new CoreIpcError('NOT_READY','当前原生选择器尚未绑定。')
      const chooser=localWorkbenchNativeChooser,originalContext={ datasetId:context.binding.datasetId,signal:context.signal,assertCurrent:context.assertCurrent,...(context.directoryUiToken?{directoryUiToken:context.directoryUiToken}:{}) }
      const availability=await chooser.readAvailability('library',originalContext)
      await context.assertCurrent()
      if(localWorkbenchNativeChooser!==chooser||context.signal.aborted||!availability.available)throw new CoreIpcError('NOT_READY','当前原生目录选择host尚未确认可调用。')
      return chooser.chooseLibrary(originalContext)
    },
    cancelLibraryImport: async (request, context) => {
      await context.assertCurrent()
      const bridge = localWorkbenchDirectoryBridge
      if (!bridge) throw new CoreIpcError('NOT_READY', '原目录Main账本未就绪。')
      const result = await bridge.cancelLibraryChoice(request.choiceId, context)
      await context.assertCurrent()
      if (localWorkbenchDirectoryBridge !== bridge) throw new CoreIpcError('OUTBOX_SCOPE_MISMATCH', '原目录Main作者已换代。')
      return result
    },
    acceptDirectoryRequest:async(request,context)=>{if(request.family!=='management'||!['library.import.prepare','library.import.confirm','library.cue.start'].includes(request.command))return;if(!localWorkbenchDirectoryBridge)throw new CoreIpcError('NOT_READY','原目录Main账本未就绪。');return localWorkbenchDirectoryBridge.enter(request,context)},
    acceptLyricsRequest: async (request,context) => { if (!localLyricsMainService) throw new CoreIpcError('NOT_READY','歌词Main原请求账本尚未装配。');await localLyricsMainService.accept(request,context) },
    observeLyricsResult: async (request,result,context) => { if(!localLyricsMainService)throw new CoreIpcError('NOT_READY','歌词Main原请求账本尚未装配。');await localLyricsMainService.observe(request,result,context) },
    acceptNameRequest:async(request,context)=>{
      if(request.family==='management'&&request.command==='library.remove')await assembly.registerLibraryRemovalIntent(request,context)
      if(!localNameMainBridge&&request.family==='management'&&request.command==='library.ai.start')throw new CoreIpcError('NOT_READY','真实Main名称后端尚未装配。')
      return localNameMainBridge?.accept(request,context)??Promise.resolve(undefined)
    },
    observeNameResult:(request,result,context)=>localNameMainBridge?.observe(request,result,context)??Promise.resolve(),
    closeMainResources: () => assembly.close(),
  })
  // 三个具名渠道只传dataset/command/payload，不接通用前缀或Renderer私有路径。
  localWorkbenchManagementBoundary = managementBoundary
  // 唯一私有drop渠道由isolated preload读取实际Native File，不开放Renderer路径调用口。
  registerPerformanceHandler('localWorkbench:directoryDrop',async(event,value:unknown)=>{
    trustedWorkbench(event)
    if(!value||typeof value!=='object'||Array.isArray(value)||Reflect.ownKeys(value).length!==2
      ||!['datasetId','path'].every(key=>{const descriptor=Object.getOwnPropertyDescriptor(value,key);return !!descriptor&&descriptor.enumerable&&Object.hasOwn(descriptor,'value')}))publicIpcFailure('INVALID_IPC_REQUEST','请拖入一个实际本地目录。')
    const body=value as {datasetId:unknown;path:unknown}
    if(typeof body.datasetId!=='string'||typeof body.path!=='string'||!path.isAbsolute(body.path)||body.path.length>65536||body.path.includes('\0'))publicIpcFailure('INVALID_IPC_REQUEST','拖入目录的原生身份无效。')
    const datasetId=body.datasetId as string,absolute=body.path as string
    try{return await managementBoundary.prepareDroppedLibrary(event,datasetId,async prepared=>{
      await prepared.assertCurrent()
      const chooser=localWorkbenchNativeChooser
      if(!chooser)throw new CoreIpcError('NOT_READY','原目录选择器尚未绑定。')
      const choice=await chooser.chooseDroppedLibrary(absolute,{datasetId:prepared.binding.datasetId,signal:prepared.signal,assertCurrent:prepared.assertCurrent,...(prepared.directoryUiToken?{directoryUiToken:prepared.directoryUiToken}:{})})
      await prepared.assertCurrent();trustedWorkbench(event)
      if(localWorkbenchNativeChooser!==chooser)throw new CoreIpcError('OUTBOX_SCOPE_MISMATCH','原目录选择器已换代。')
      return choice
    })}catch(error){
      const code=error&&typeof error==='object'&&'code'in error?error.code:undefined
      publicIpcFailure(code==='TIMEOUT'||code==='OUTBOX_SCOPE_MISMATCH'||code==='INVALID_IPC_REQUEST'?code:'NOT_READY','拖入目录尚未确认，请核对当前工作库。')
    }
  })
  registerPerformanceHandler('localWorkbench:management', (event, value: unknown) => managementBoundary.management(event, value))
  registerPerformanceHandler('localWorkbench:nameSettings', (event, value: unknown) => managementBoundary.nameSettings(event, value))
  registerPerformanceHandler('localWorkbench:lyrics', (event, value: unknown) => managementBoundary.lyrics(event, value))
  installLocalLegacyLinksHandlers({handle:(channel,handler)=>registerPerformanceHandler(channel,handler),requireTrusted:requireTrustedRenderer,supervisor})
  closeLocalArtwork=installLocalArtworkHandlers<Electron.IpcMainInvokeEvent>({ handle:(channel,handler)=>registerPerformanceHandler(channel,handler), requireTrusted:requireTrustedRenderer, eventKey:event=>String(event.sender.id), supervisor, attachOriginal: request => supervisor.requestSourceWrites('localSourceWrites.attachOriginal', request), ...(!isStartupTest&&!isUiE2e?{providers:{'cover-art-archive-v1':createMusicCoverArtProvider(),'commons-cc0-v1':createCommonsArtworkProvider()}}:{}), decode:bytes=>nativeImage.createFromBuffer(bytes), pick:()=>pickLocalLibrary({title:'选择封面图片',message:'只保存到 Mousa；不会修改原图、cover.jpg 或音乐标签。',properties:['openFile'],filters:[{name:'PNG / JPEG',extensions:['png','jpg','jpeg']}]}) }).close
  commandOutbox = createCommandOutboxService({ store, currentDataset: async () => (await supervisor.request('commandOutbox.context', {})).datasetId, ...executor })
  closeLocalSourceWrites = installLocalSourceWritesHandlers<Electron.IpcMainInvokeEvent>({
    handle: (channel, handler) => registerPerformanceHandler(channel, handler), supervisor, outbox: commandOutbox,
    requireTrusted: event => {
      requireTrustedRenderer(event)
      if (!mainWindow || event.senderFrame !== mainWindow.webContents.mainFrame) throw new CoreIpcError('INVALID_IPC_REQUEST', '源写确认必须来自当前应用主页面。')
    },
  }).close
  closeLocalRelocation = installLocalRelocationHandlers<Electron.IpcMainInvokeEvent>({
    handle: (channel, handler) => registerPerformanceHandler(channel, handler),
    requireTrusted: event => {
      requireTrustedRenderer(event)
      if (!mainWindow || event.senderFrame !== mainWindow.webContents.mainFrame) throw new CoreIpcError('INVALID_IPC_REQUEST', '搬迁操作必须来自当前应用主页面。')
    },
    requestPublic: (command, payload, datasetId) => supervisor.request(command,
      payload as import('@music-bridge/contracts').IpcCommandPayloads[typeof command], datasetId),
    requestMain: (command, payload) => supervisor.requestRelocationMain(command, payload),
    pickTarget: kind => pickLocalLibrary({ title: kind === 'directory' ? '选择搬迁目标目录' : '选择已移动的音乐文件',
      message: '先生成完整位置计划；不会覆盖已有文件。', properties: kind === 'directory' ? ['openDirectory'] : ['openFile'] }),
  }).close
  installCommandOutboxIpc<Electron.IpcMainInvokeEvent>({
    handle: (channel, handler) => registerPerformanceHandler(channel, handler), requireTrusted: requireTrustedRenderer,
    context: () => supervisor.request('commandOutbox.context', {}), service: commandOutbox, store,
  })
  if (isRoonImageGate) {
    registerPerformanceHandler('roon:image:diagnostic', (event, shape: unknown) => {
      requireTrustedRenderer(event)
      recordPreloadRoonImageShape(shape)
      return { recorded: true }
    })
  }
  const libraryReads = createLibraryReadBroker(supervisor, { ...(libraryReadTrace ? { trace: libraryReadTrace } : {}) })
  const readOwners = new Set<number>()
  registerPerformanceHandler('library:read', (event, value: unknown, metadata?: unknown) => invokeCore(event, async () => {
    if (event.senderFrame !== event.sender.mainFrame) return publicIpcFailure('NOT_READY', '读取仅允许可信主页面')
    const owner = event.sender.id
    if (!readOwners.has(owner)) {
      readOwners.add(owner)
      event.sender.once('destroyed', () => { libraryReads.cancelOwner(owner, 'owner-destroyed'); readOwners.delete(owner) })
      event.sender.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace) libraryReads.cancelOwner(owner, 'owner-navigation')
      })
    }
    return libraryReads.read(owner, value, metadata)
  }))
  registerPerformanceHandler('library:cancel-read', (event, id: unknown, metadata?: unknown) => invokeCore(event, async () => {
    if (event.senderFrame !== event.sender.mainFrame) return publicIpcFailure('NOT_READY', '读取取消仅允许可信主页面')
    libraryReads.cancel(event.sender.id, id, metadata)
  }))
  installCollectionReadonlyHandlers<Electron.IpcMainInvokeEvent>({
    handle: (channel, listener) => registerPerformanceHandler(channel, listener),
    requireTrusted: event => { requireTrustedRenderer(event); if (event.senderFrame !== event.sender.mainFrame) publicIpcFailure('NOT_READY', '收藏查询拒绝非主框架。') },
    reject: () => publicIpcFailure('INVALID_IPC_REQUEST', '收藏查询参数无效。'),
    settings: {
      get: () => { if (!collectionReadonlySettings) return publicIpcFailure('NOT_READY', '收藏查询尚未就绪。'); return collectionReadonlySettings.get() },
      set: async enabled => { if (!collectionReadonlySettings) return publicIpcFailure('NOT_READY', '收藏查询尚未就绪。'); try { return await collectionReadonlySettings.set(enabled) } catch { return publicIpcFailure('INTERNAL_ERROR', '收藏查询偏好未保存。') } },
      refresh: () => { if (!collectionReadonlySettings) return publicIpcFailure('NOT_READY', '收藏查询尚未就绪。'); return collectionReadonlySettings.refresh() },
    },
  })
  registerPerformanceHandler('app:set-appearance-theme', (event, theme: unknown) => {
    const target = requireTrustedRenderer(event)
    if (theme !== 'light' && theme !== 'dark') return publicIpcFailure('INVALID_IPC_REQUEST', '主题必须为浅色或深色')
    nativeTheme.themeSource = theme
    target.setBackgroundColor(theme === 'dark' ? '#3c4253' : '#f2edf1')
  })
  registerPerformanceHandler('app:get-info', (event) => {
    requireTrustedRenderer(event)
    return appInfo()
  })
  registerPerformanceHandler('core:get-health', (event) =>
    invokeCore(event, () => supervisor.request('core.getHealth', {})),
  )
  registerPerformanceHandler('core:get-state', (event) =>
    invokeCore(event, () => supervisor.request('core.getState', {})),
  )
  registerPerformanceHandler('core:ping', (event) =>
    invokeCore(event, () => supervisor.request('core.ping', {})),
  )
  registerPerformanceHandler('diagnostics:export', (event) =>
    invokeCore(event, () => exportDiagnosticsFromMain(supervisor)),
  )
  registerPerformanceHandler('auth:get-state', (event) =>
    invokeCore(event, () => supervisor.request('auth.getState', {})),
  )
  registerPerformanceHandler('auth:begin-qr', (event) =>
    invokeCore(event, () => supervisor.request('auth.beginQr', {})),
  )
  registerPerformanceHandler('auth:poll-qr', (event, challengeId: unknown) =>
    invokeCore(event, async (): Promise<PublicAuthState> => {
      const result = await supervisor.requestInternal('auth.pollQr', {
        challengeId: requireChallengeId(challengeId),
      })
      if (result.credential !== undefined) {
        await saveQrCredential(supervisor, credentialVault, result.credential)
      }
      return result.state
    }),
  )
  registerPerformanceHandler('auth:cancel-qr', (event, challengeId: unknown) =>
    invokeCore(event, () =>
      supervisor.request('auth.cancelQr', {
        challengeId: requireChallengeId(challengeId),
      }),
    ),
  )
  registerPerformanceHandler('auth:logout', (event) =>
    invokeCore(event, async (): Promise<PublicAuthState> => {
      let state: PublicAuthState | undefined
      let failure: unknown
      try {
        state = await supervisor.request('auth.logout', {})
      } catch (error) {
        failure = error
      }
      try {
        await credentialVault.delete()
      } catch (error) {
        failure ??= error
      }
      if (failure) throw failure
      if (!state) throw new Error('Auth logout returned no state')
      return state
    }),
  )
  registerPerformanceHandler('account:get-state', (event) =>
    invokeCore(event, () => supervisor.request('account.getState', {})),
  )
  registerPerformanceHandler('account:refresh', (event) =>
    invokeCore(event, () => supervisor.request('account.refresh', {})),
  )
  registerPerformanceHandler('library:search', (event, query: unknown, page: unknown) =>
    invokeCore(event, () =>
      supervisor.request('library.search', {
        query: requireSearchQuery(query),
        page: requireLibraryPage(page),
      }),
    ),
  )
  registerPerformanceHandler('library:search-artists', (event, query: unknown, page: unknown) =>
    invokeCore(event, () =>
      supervisor.request('library.searchArtists', {
        query: requireSearchQuery(query),
        page: requireLibraryPage(page),
      }),
    ),
  )
  registerPerformanceHandler('library:search-albums', (event, query: unknown, page: unknown) =>
    invokeCore(event, () =>
      supervisor.request('library.searchAlbums', {
        query: requireSearchQuery(query),
        page: requireLibraryPage(page),
      }),
    ),
  )
  registerPerformanceHandler('library:artist', (event, artistId: unknown, page: unknown) =>
    invokeCore(event, () =>
      supervisor.request('library.artist', {
        artistId: requirePlaybackTrackId(artistId),
        page: requireLibraryPage(page),
      }),
    ),
  )
  registerPerformanceHandler('library:album', (event, albumId: unknown, page: unknown) =>
    invokeCore(event, () =>
      supervisor.request('library.album', {
        albumId: requirePlaybackTrackId(albumId),
        page: requireLibraryPage(page),
      }),
    ),
  )
  registerPerformanceHandler('library:liked', (event, page: unknown) =>
    invokeCore(event, () =>
      supervisor.request('library.liked', { page: requireLibraryPage(page) }),
    ),
  )
  registerPerformanceHandler('library:like-status', (event, trackId: unknown) =>
    invokeCore(event, () => supervisor.request('library.likeStatus', {
      trackId: requirePlaybackTrackId(trackId),
    })),
  )
  registerPerformanceHandler('library:like', (event, trackId: unknown, liked: unknown) =>
    invokeCore(event, () => {
      if (typeof liked !== 'boolean') {
        return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid like state')
      }
      return supervisor.request('library.like', {
        trackId: requirePlaybackTrackId(trackId),
        liked,
      })
    }),
  )
  registerPerformanceHandler('library:match', (event, track: unknown) =>
    invokeCore(event, () => supervisor.request('library.match', {
      track: requireTrackSummary(track),
    })),
  )
  registerPerformanceHandler('library:aggregate-search', (event, query: unknown, page: unknown) =>
    invokeCore(event, () => supervisor.request('library.aggregateSearch', {
      query: requireSearchQuery(query),
      page: requireLibraryPage(page),
    })),
  )
  registerPerformanceHandler('library:playlists', (event) =>
    invokeCore(event, () => supervisor.request('library.playlists', {})),
  )
  registerPerformanceHandler('library:playlist', (event, playlistId: unknown, page: unknown) =>
    invokeCore(event, () =>
      supervisor.request('library.playlist', {
        playlistId: requirePlaylistId(playlistId),
        page: requireLibraryPage(page),
      }),
    ),
  )
  registerPerformanceHandler('library:daily-recommendations', (event) =>
    invokeCore(event, () => supervisor.request('library.dailyRecommendations', {})),
  )
  registerPerformanceHandler('recordingVersions:list', (event, draftId: unknown) => invokeCore(event, () => {
    if (!isCollectionId(draftId)) throw new Error('录音草稿编号无效。')
    return supervisor.request('recordingVersions.list', { draftId })
  }))
  registerPerformanceHandler('recordingVersions:preview', (event, request: unknown) => invokeCore(event, () => {
    if (!isPreviewVersionsRequest(request)) throw new Error('版本预览请求无效。')
    return supervisor.request('recordingVersions.preview', request)
  }))
  registerPerformanceHandler('recordingVersions:job', (event, id: unknown) => invokeCore(event, () => {
    if (!isCollectionId(id)) throw new Error('版本任务编号无效。')
    return supervisor.request('recordingVersions.job', { id })
  }))
  registerPerformanceHandler('recordingMedia:plans', (event, draftId: unknown) => invokeCore(event, () => {
    if (!isCollectionId(draftId)) throw new Error('录音草稿编号无效。')
    return supervisor.request('recordingMedia.plans', { draftId })
  }))
  registerPerformanceHandler('recordingMedia:detail', (event, id: unknown) => invokeCore(event, () => {
    if (!isCollectionId(id)) throw new Error('录音规划编号无效。')
    return supervisor.request('recordingMedia.detail', { id })
  }))
  registerPerformanceHandler('recordingMedia:balance', (event, draftId: unknown, spec: unknown) => invokeCore(event, () => {
    if (!isCollectionId(draftId) || !isMediaLayoutSpec(spec)) throw new Error('分面输入无效。')
    return supervisor.request('recordingMedia.balance', { draftId, spec })
  }))
  registerPerformanceHandler('recordingMedia:preview', (event, request: unknown) => invokeCore(event, () => {
    if (!isPreviewMediaRequest(request)) throw new Error('分面预览请求无效。')
    return supervisor.request('recordingMedia.preview', request)
  }))
  registerPerformanceHandler('recordingBackups:overview', event => invokeCore(event, () => supervisor.request('recordingBackups.overview', {})))
  registerPerformanceHandler('recordingArchive:roots', event => invokeCore(event, () => supervisor.request('recordingArchive.roots', {})))
  registerPerformanceHandler('recordingArchive:preview', (event, request: unknown) => invokeCore(event, () => {
    if (!isPreviewArchiveRequest(request)) return publicIpcFailure('INVALID_IPC_REQUEST', '归档请求无效或尚未明确确认')
    return supervisor.request('recordingArchive.preview', request)
  }))
  registerPerformanceHandler('recordingArchive:verify', (event, request: unknown) => invokeCore(event, () => {
    if (!isVerifyArchiveRequest(request)) return publicIpcFailure('INVALID_IPC_REQUEST', '归档请求无效或尚未明确确认')
    return supervisor.request('recordingArchive.verify', request)
  }))
  registerPerformanceHandler('recordingArchive:list', (event, draftId: unknown) => invokeCore(event, () => {
    if (!isCollectionId(draftId)) return publicIpcFailure('INVALID_IPC_REQUEST', '归档编号无效')
    return supervisor.request('recordingArchive.list', { draftId })
  }))
  registerPerformanceHandler('recordingArchive:operation', (event, id: unknown) => invokeCore(event, () => {
    if (!isCollectionId(id)) return publicIpcFailure('INVALID_IPC_REQUEST', '归档编号无效')
    return supervisor.request('recordingArchive.operation', { id })
  }))
  registerPerformanceHandler('recordingArchive:cancelRead', (event, id: unknown) => invokeCore(event, () => {
    if (!isCollectionId(id)) return publicIpcFailure('INVALID_IPC_REQUEST', '归档编号无效')
    return supervisor.request('recordingArchive.cancelRead', { id })
  }))
  registerPerformanceHandler('recordingProfiles:list', event => invokeCore(event, () => supervisor.request('recordingProfiles.list', {})))
  registerPerformanceHandler('recordingProfiles:history', (event, profileId: unknown) => invokeCore(event, () => {
    if (!isCollectionId(profileId)) return publicIpcFailure('INVALID_IPC_REQUEST', '录音参数或执行资产请求无效或未确认')
    return supervisor.request('recordingProfiles.history', { profileId })
  }))
  registerPerformanceHandler('recordingProfiles:version', (event, versionId: unknown) => invokeCore(event, () => {
    if (!isCollectionId(versionId)) return publicIpcFailure('INVALID_IPC_REQUEST', '录音参数或执行资产请求无效或未确认')
    return supervisor.request('recordingProfiles.version', { versionId })
  }))
  registerPerformanceHandler('recordingProfiles:session', (event, draftId: unknown) => invokeCore(event, () => {
    if (!isCollectionId(draftId)) return publicIpcFailure('INVALID_IPC_REQUEST', '录音参数或执行资产请求无效或未确认')
    return supervisor.request('recordingProfiles.session', { draftId })
  }))
  registerPerformanceHandler('recordingExecution:list', (event, draftId: unknown) => invokeCore(event, () => {
    if (!isCollectionId(draftId)) return publicIpcFailure('INVALID_IPC_REQUEST', '录音参数或执行资产请求无效或未确认')
    return supervisor.request('recordingExecution.list', { draftId })
  }))
  registerPerformanceHandler('recordingExecution:preview', (event, request: unknown) => invokeCore(event, () => {
    if (!isPreviewExecutionRequest(request)) return publicIpcFailure('INVALID_IPC_REQUEST', '录音参数或执行资产请求无效或未确认')
    return supervisor.request('recordingExecution.preview', request)
  }))
  registerPerformanceHandler('recordingExecution:job', (event, id: unknown) => invokeCore(event, () => {
    if (!isCollectionId(id)) return publicIpcFailure('INVALID_IPC_REQUEST', '录音参数或执行资产请求无效或未确认')
    return supervisor.request('recordingExecution.job', { id })
  }))
  registerPerformanceHandler('recordingExecution:cancelRead', (event, id: unknown) => invokeCore(event, () => {
    if (!isCollectionId(id)) return publicIpcFailure('INVALID_IPC_REQUEST', '录音参数或执行资产请求无效或未确认')
    return supervisor.request('recordingExecution.cancelRead', { id })
  }))
  registerPerformanceHandler('recordingExecution:verify', (event, request: unknown) => invokeCore(event, () => {
    if (!isVerifyExecutionRequest(request)) return publicIpcFailure('INVALID_IPC_REQUEST', '录音参数或执行资产请求无效或未确认')
    return supervisor.request('recordingExecution.verify', request)
  }))
  registerPerformanceHandler('recordingPrepared:list', (event, draftId: unknown) => invokeCore(event, () => {
    if (!isCollectionId(draftId)) return publicIpcFailure('INVALID_IPC_REQUEST', 'PREP 请求无效或未确认')
    return supervisor.request('recordingPrepared.list', { draftId })
  }))
  installReferenceCatalogReads({ handle: (channel, handler) => registerPerformanceHandler(channel, handler), requireTrusted: requireTrustedRenderer, supervisor })
  cassetteCatalogService = createCassetteCatalogService({
    dataDirectory: () => coreDataDirectory,
    request: supervisor.request.bind(supervisor),
    chooseArchive: async () => {
      if (!mainWindow || mainWindow.isDestroyed()) return null
      const selected = await dialog.showOpenDialog(mainWindow, {
        title: '选择完整磁带资料档案', properties: ['openFile'], filters: [{ name: '磁带资料档案', extensions: ['zip'] }],
      })
      return selected.canceled ? null : selected.filePaths[0] ?? null
    },
  })
  installCassetteCatalogHandlers({ handle: (channel, handler) => registerPerformanceHandler(channel, handler), requireTrusted: requireTrustedRenderer, service: cassetteCatalogService })
  installSpreadsheetImportReads({ handle: (channel, handler) => registerPerformanceHandler(channel, handler), requireTrusted: requireTrustedRenderer, supervisor })
  installRecordingPlanReads({ handle: (channel, handler) => registerPerformanceHandler(channel, handler), requireTrusted: requireTrustedRenderer, supervisor })
  installRecordingWorkspaceRead({ handle: (channel, handler) => registerPerformanceHandler(channel, handler), requireTrusted: requireTrustedRenderer, supervisor })
  installRecordingCandidateHandlers({ handle: (channel, handler) => registerPerformanceHandler(channel, handler), requireTrusted: requireTrustedRenderer, supervisor })
  installPreparationZipHandlers<Electron.IpcMainInvokeEvent>({
    handle: (channel, handler) => registerPerformanceHandler(channel, handler), supervisor,
    windowFor: event => {
      const window = requireTrustedRenderer(event)
      const contents = window.webContents
      return {
        id: window.id,
        onInvalidated: listener => {
          contents.on('did-start-navigation', listener)
          window.on('closed', listener)
          // closed 时原生窗口已销毁；解除监听使用登记时的对象，不再读取窗口 getter。
          return () => { contents.removeListener('did-start-navigation', listener); window.removeListener('closed', listener) }
        },
      }
    },
    choose: async (event, suggestedName) => {
      const selected = await dialog.showSaveDialog(requireTrustedRenderer(event), {
        title: '将 Logic 工作区另存为 ZIP（不覆盖已有文件）', defaultPath: suggestedName,
        filters: [{ name: 'ZIP 文件', extensions: ['zip'] }],
      })
      return selected.canceled ? null : selected.filePath ?? null
    },
  })
  installRecordingOutputReads({ handle: (channel, handler) => registerPerformanceHandler(channel, handler), requireTrusted: requireTrustedRenderer, supervisor })
  installRecordingRecordHandlers({ handle: (channel, handler) => registerPerformanceHandler(channel, handler), requireTrusted: requireTrustedRenderer, supervisor })
  installRecordingPrintHandlers({
    handle: (channel, handler) => registerPerformanceHandler(channel, handler), requireTrusted: requireTrustedRenderer, supervisor,
    getEpoch: () => recordingPrintEpoch,
    pickArtwork: event => pickCollectionPhoto(
      () => dialog.showOpenDialog(requireTrustedRenderer(event), { title: '选择母版 Artwork（选择后需保存）', properties: ['openFile'], filters: [{ name: 'Artwork 图片', extensions: ['png', 'jpg', 'jpeg'] }] }),
      bytes => nativeImage.createFromBuffer(bytes),
    ),
    pickPrintImage: event => pickCollectionPhoto(
      () => dialog.showOpenDialog(requireTrustedRenderer(event), { title: '选择 J-Card 设计图片（仅用于新印刷版本）', properties: ['openFile'], filters: [{ name: 'J-Card 图片', extensions: ['png', 'jpg', 'jpeg'] }] }),
      bytes => nativeImage.createFromBuffer(bytes),
    ),
    exportPdf: (options, event) => exportRecordingPrintPdf({ ...options, select: () => dialog.showSaveDialog(requireTrustedRenderer(event), {
      title: '导出历史 J-Card PDF（不覆盖已有文件）', defaultPath: `MusicBridge-${options.request.artifactId}.pdf`, filters: [{ name: 'PDF 文档', extensions: ['pdf'] }],
    }) }),
  })
  installRecordingReplicaHandlers({ handle: (channel, handler) => registerPerformanceHandler(channel, handler), requireTrusted: requireTrustedRenderer, supervisor })
  installRecordingDeviceHandlers({ handle: (channel, handler) => registerPerformanceHandler(channel, handler), requireTrusted: requireTrustedRenderer, supervisor })
  installRecordingAttemptHandlers({ handle: (channel, handler) => registerPerformanceHandler(channel, handler), requireTrusted: requireTrustedRenderer, supervisor })
  installCollectionProgressReads({ handle: (channel, handler) => registerPerformanceHandler(channel, handler), requireTrusted: requireTrustedRenderer, supervisor })
  registerPerformanceHandler('recordingPrepared:selections', (event, preparationId: unknown) => invokeCore(event, () => {
    if (!isCollectionId(preparationId)) return publicIpcFailure('INVALID_IPC_REQUEST', 'PREP 请求无效或未确认')
    return supervisor.request('recordingPrepared.selections', { preparationId })
  }))
  registerPerformanceHandler('recordingPrepared:job', (event, id: unknown) => invokeCore(event, () => {
    if (!isCollectionId(id)) return publicIpcFailure('INVALID_IPC_REQUEST', 'PREP 请求无效或未确认')
    return supervisor.request('recordingPrepared.job', { id })
  }))
  registerPerformanceHandler('recordingPrepared:previewImport', (event, request: unknown) => invokeCore(event, () => {
    if (!isPreviewPreparedImportRequest(request)) return publicIpcFailure('INVALID_IPC_REQUEST', 'PREP 请求无效或未确认')
    return supervisor.request('recordingPrepared.previewImport', request)
  }))
  registerPerformanceHandler('recordingPrepared:review', (event, request: unknown) => invokeCore(event, () => {
    if (!isReviewPreparedRequest(request)) return publicIpcFailure('INVALID_IPC_REQUEST', 'PREP 请求无效或未确认')
    return supervisor.request('recordingPrepared.review', request)
  }))
  registerPerformanceHandler('recordingPreparation:destinations', event => invokeCore(event, () => supervisor.request('recordingPreparation.destinations', {})))
  registerPerformanceHandler('recordingPreparation:list', (event, draftId: unknown) => invokeCore(event, () => {
    if (!isCollectionId(draftId)) return publicIpcFailure('INVALID_IPC_REQUEST', '草稿编号无效')
    return supervisor.request('recordingPreparation.list', { draftId })
  }))
  registerPerformanceHandler('recordingPreparation:preview', (event, request: unknown) => invokeCore(event, () => {
    if (!isPreviewPreparationRequest(request)) return publicIpcFailure('INVALID_IPC_REQUEST', '工作区预览请求无效')
    return supervisor.request('recordingPreparation.preview', request)
  }))
  registerPerformanceHandler('recordingPreparation:job', (event, id: unknown) => invokeCore(event, () => {
    if (!isCollectionId(id)) return publicIpcFailure('INVALID_IPC_REQUEST', '工作区任务编号无效')
    return supervisor.request('recordingPreparation.job', { id })
  }))
  registerPerformanceHandler('recordingPreparation:open', (event, id: unknown) => invokeCore(event, async () => {
    if (!isCollectionId(id)) return publicIpcFailure('INVALID_IPC_REQUEST', '工作区编号无效')
    const context = await supervisor.requestInternal('recordingPreparation.context', { id })
    const error = await shell.openPath(context.absolutePath)
    if (error) return publicIpcFailure('NOT_READY', '无法打开工作区，请检查目标目录是否仍可用')
    return { opened: true as const }
  }))
  registerPerformanceHandler('recordingSources:roots', event => invokeCore(event, () => supervisor.request('recordingSources.roots', {})))
  registerPerformanceHandler('recordingSources:snapshot', (event, draftId: unknown) => invokeCore(event, () => {
    if (!isCollectionId(draftId)) return publicIpcFailure('INVALID_IPC_REQUEST', '草稿编号无效')
    return supervisor.request('recordingSources.snapshot', { draftId })
  }))
  registerPerformanceHandler('recordingSources:job', (event, id: unknown) => invokeCore(event, () => {
    if (!isCollectionId(id)) return publicIpcFailure('INVALID_IPC_REQUEST', '校验任务编号无效')
    return supervisor.request('recordingSources.job', { id })
  }))
  registerPerformanceHandler('recordingDrafts:list', (event, page: unknown) => invokeCore(event, () => supervisor.request('recordingDrafts.list', { page: requireLibraryPage(page) })))
  registerPerformanceHandler('recordingDrafts:detail', (event, id: unknown) => invokeCore(event, () => {
    if (!isCollectionId(id)) return publicIpcFailure('INVALID_IPC_REQUEST', '草稿编号无效')
    return supervisor.request('recordingDrafts.detail', { id })
  }))
  registerPerformanceHandler('recordingDrafts:runtime', (event, draftId: unknown, trackId: unknown) => invokeCore(event, () => {
    if (!isCollectionId(draftId) || !isCollectionId(trackId)) return publicIpcFailure('INVALID_IPC_REQUEST', '草稿曲目编号无效')
    return supervisor.request('recordingDrafts.runtime', { draftId, trackId })
  }))
  registerPerformanceHandler('physicalLinks:digitalDetail', (event, id: unknown) => invokeCore(event, () => {
    if (!isCollectionId(id)) return publicIpcFailure('INVALID_IPC_REQUEST', '关联对象编号无效')
    return supervisor.request('physicalLinks.digitalDetail', { id })
  }))
  registerPerformanceHandler('physicalLinks:physical', (event, releaseId: unknown) => invokeCore(event, () => {
    if (!isCollectionId(releaseId)) return publicIpcFailure('INVALID_IPC_REQUEST', '关联对象编号无效')
    return supervisor.request('physicalLinks.physical', { releaseId })
  }))
  registerPerformanceHandler('physicalLinks:history', (event, releaseId: unknown, page: unknown) => invokeCore(event, () => {
    if (!isCollectionId(releaseId)) return publicIpcFailure('INVALID_IPC_REQUEST', '发行版编号无效')
    return supervisor.request('physicalLinks.history', { releaseId, page: requireLibraryPage(page) })
  }))
  registerPerformanceHandler('physicalLinks:runtime', (event, id: unknown) => invokeCore(event, () => {
    if (!isCollectionId(id)) return publicIpcFailure('INVALID_IPC_REQUEST', '关联对象编号无效')
    return supervisor.request('physicalLinks.runtime', { id })
  }))
  registerPerformanceHandler('physicalLinks:digitalList', (event, page: unknown) => invokeCore(event, () => supervisor.request('physicalLinks.digitalList', { page: requireLibraryPage(page) })))
  registerPerformanceHandler('physicalLinks:search', (event, query: unknown, page: unknown) => invokeCore(event, () => {
    if (!isAlbumQuery(query)) return publicIpcFailure('INVALID_IPC_REQUEST', '专辑查询无效')
    return supervisor.request('physicalLinks.search', { query, page: requireLibraryPage(page) })
  }))
  registerPerformanceHandler('physicalLinks:matrix', (event, page: unknown, query: unknown) => invokeCore(event, () => {
    if (query !== undefined && !isAlbumQuery(query)) return publicIpcFailure('INVALID_IPC_REQUEST', '矩阵查询无效')
    return supervisor.request('physicalLinks.matrix', { page: requireLibraryPage(page), ...(query !== undefined ? { query } : {}) })
  }))
  registerPerformanceHandler('physicalMusic:list', (event, page: unknown, filter: unknown) => invokeCore(event, () => {
    if (filter !== undefined && !isMusicFilter(filter)) return publicIpcFailure('INVALID_IPC_REQUEST', '音乐筛选无效')
    return supervisor.request('physicalMusic.list', { page: requireLibraryPage(page), ...(filter ? { filter } : {}) })
  }))
  registerPerformanceHandler('physicalMusic:detail', (event, id: unknown) => invokeCore(event, () => {
    if (!isMusicId(id)) return publicIpcFailure('INVALID_IPC_REQUEST', '音乐编号无效')
    return supervisor.request('physicalMusic.detail', { id })
  }))
  registerPerformanceHandler('physicalMusic:copies', (event, releaseId: unknown, page: unknown) => invokeCore(event, () => {
    if (!isCollectionId(releaseId)) return publicIpcFailure('INVALID_IPC_REQUEST', '商业发行编号无效')
    return supervisor.request('physicalMusic.copies', { releaseId, page: requireLibraryPage(page) })
  }))
  registerPerformanceHandler('physicalMusic:photo', (event, photoId: unknown) => invokeCore(event, () => {
    if (!isCollectionId(photoId)) return publicIpcFailure('INVALID_IPC_REQUEST', '照片编号无效')
    return supervisor.request('physicalMusic.photo', { photoId })
  }))
  let photoPickerBusy = false
  registerPerformanceHandler('collection:pick-photo', async (event) => {
    const window = requireTrustedRenderer(event)
    if (photoPickerBusy) return publicIpcFailure('NOT_READY', '照片选择器已打开')
    photoPickerBusy = true
    try {
      return await pickCollectionPhoto(
        () => dialog.showOpenDialog(window, { title: '选择照片', properties: ['openFile'], filters: [{ name: '图片文件', extensions: ['png', 'jpg', 'jpeg'] }] }),
        bytes => nativeImage.createFromBuffer(bytes),
      )
    } catch (error) {
      return publicIpcFailure('INVALID_IPC_REQUEST', error instanceof CollectionPhotoImportError ? error.message : '照片导入失败')
    } finally { photoPickerBusy = false }
  })
  registerPerformanceHandler('collection:photo', (event, photoId: unknown) => invokeCore(event, () => {
    if (!isCollectionId(photoId)) return publicIpcFailure('INVALID_IPC_REQUEST', '照片编号无效')
    return supervisor.request('collection.photo', { photoId })
  }))
  registerPerformanceHandler('collection:list', (event, page: unknown, filter: unknown) => invokeCore(event, () => {
    if (filter !== undefined && !isCollectionFilter(filter)) return publicIpcFailure('INVALID_IPC_REQUEST', '库存筛选无效')
    return supervisor.request('collection.list', { page: requireLibraryPage(page), ...(filter ? { filter } : {}) })
  }))
  registerPerformanceHandler('collection:detail', (event, modelId: unknown, page: unknown) => invokeCore(event, () => {
    if (!isCollectionId(modelId)) return publicIpcFailure('INVALID_IPC_REQUEST', '库存型号无效')
    return supervisor.request('collection.detail', { modelId, page: requireLibraryPage(page) })
  }))
  registerPerformanceHandler('favorites:list', (event, kind: unknown, page: unknown) =>
    invokeCore(event, () => {
      const favoriteKind = requireFavoriteKind(kind)
      return supervisor.request('favorites.list', {
        ...(favoriteKind !== undefined ? { kind: favoriteKind } : {}),
        page: requireLibraryPage(page),
      })
    }),
  )
  registerPerformanceHandler('favorites:check', (event, descriptor: unknown) =>
    invokeCore(event, () => supervisor.request('favorites.check', {
      descriptor: requireFavoriteDescriptor(descriptor),
    })),
  )
  registerPerformanceHandler('favorites:set', (event, descriptor: unknown, favorite: unknown) =>
    invokeCore(event, () => {
      if (typeof favorite !== 'boolean') {
        return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid favorite state')
      }
      return supervisor.request('favorites.set', {
        descriptor: requireFavoriteDescriptor(descriptor),
        favorite,
      })
    }),
  )
  registerPerformanceHandler('roon:list-zones', (event) =>
    invokeCore(event, () => supervisor.request('roon.listZones', {})),
  )
  registerPerformanceHandler('lyrics:display:get', event => invokeCore(event, async () => roonDisplayConnection?.getSettings() ?? { url: '', status: 'disabled' }))
  registerPerformanceHandler('lyrics:display:configure', (event, url: unknown) => invokeCore(event, async () => {
    let normalized: string
    try { normalized = normalizeRoonDisplayUrl(url) } catch { return publicIpcFailure('INVALID_IPC_REQUEST', '请输入不含凭据的局域网 Roon /display/ 地址。') }
    if (!roonDisplayConnection) return publicIpcFailure('NOT_READY', '歌词连接尚未就绪。')
    return roonDisplayConnection.configure(normalized)
  }))
  registerPerformanceHandler('roon:select-zone', (event, zoneId: unknown) =>
    invokeCore(event, () =>
      supervisor.request('roon.selectZone', { zoneId: requireZoneId(zoneId) }),
    ),
  )
  registerPerformanceHandler('roon:library:albums', (event, page: unknown) =>
    invokeCore(event, () =>
      supervisor.request('roon.library.albums', { page: requireLibraryPage(page) }),
    ),
  )
  registerPerformanceHandler('roon:library:artists', (event, page: unknown) =>
    invokeCore(event, () =>
      supervisor.request('roon.library.artists', { page: requireLibraryPage(page) }),
    ),
  )
  registerPerformanceHandler('roon:library:genres', (event, page: unknown) =>
    invokeCore(event, () =>
      supervisor.request('roon.library.genres', { page: requireLibraryPage(page) }),
    ),
  )
  registerPerformanceHandler('roon:library:playlists', (event, page: unknown) =>
    invokeCore(event, () =>
      supervisor.request('roon.library.playlists', { page: requireLibraryPage(page) }),
    ),
  )
  registerPerformanceHandler('roon:library:album', (event, reference: unknown, page: unknown) =>
    invokeCore(event, () =>
      supervisor.request('roon.library.album', {
        reference: requireRoonReference(reference),
        page: requireLibraryPage(page),
      }),
    ),
  )
  registerPerformanceHandler('roon:library:artist', (event, reference: unknown, page: unknown) =>
    invokeCore(event, () =>
      supervisor.request('roon.library.artist', {
        reference: requireRoonReference(reference),
        page: requireLibraryPage(page),
      }),
    ),
  )
  registerPerformanceHandler('roon:library:genre', (event, reference: unknown, page: unknown) =>
    invokeCore(event, () =>
      supervisor.request('roon.library.genre', {
        reference: requireRoonReference(reference),
        page: requireLibraryPage(page),
      }),
    ),
  )
  registerPerformanceHandler('roon:library:playlist', (event, reference: unknown, page: unknown) =>
    invokeCore(event, () =>
      supervisor.request('roon.library.playlist', {
        reference: requireRoonReference(reference),
        page: requireLibraryPage(page),
      }),
    ),
  )
  registerPerformanceHandler('roon:library:search', (event, query: unknown, page: unknown, kind: unknown) =>
    invokeCore(event, () =>
      supervisor.request('roon.library.search', {
        query: requireSearchQuery(query),
        page: requireLibraryPage(page),
        ...(kind === undefined ? {} : { kind: requireRoonSearchKind(kind) }),
      }),
    ),
  )
  registerPerformanceHandler('roon:library:image', async (event, reference: unknown, options: unknown) => {
    requireTrustedRenderer(event)
    const imageOptions = requireRoonImageOptions(options)
    const imageReference = requireRoonReference(reference)
    return settleRoonImageIpc(async () => {
      const result = await supervisor.request('roon.library.image', {
        reference: imageReference,
        ...(imageOptions !== undefined ? { options: imageOptions } : {}),
      }) as RoonImageResult
      recordRoonImageShape(summarizeRoonImageBinary(
        'main-ipc',
        result.contentType,
        result.body,
      ))
      return result
    }, (error) => error instanceof CoreIpcError
      ? { code: error.code, message: error.message }
      : { code: 'INTERNAL_ERROR', message: 'Roon image request failed' })
  })
  registerPerformanceHandler('roon:library:play', (event, reference: unknown, zoneId: unknown, queueReferences: unknown, contextHandle: unknown) =>
    invokeCore(event, () => {
      if (queueReferences !== undefined && contextHandle !== undefined) {
        return publicIpcFailure('INVALID_IPC_REQUEST', '上下文句柄与完整队列不能同时使用')
      }
      return supervisor.request('roon.library.play', {
        reference: requireRoonEntityReference(reference),
        zoneId: requireZoneId(zoneId),
        ...(queueReferences !== undefined ? { queueReferences: requireRoonQueueReferences(queueReferences) } : {}),
        ...(contextHandle !== undefined ? { contextHandle: requireRoonPlaybackContextHandle(contextHandle) } : {}),
      })
    }),
  )
  registerPerformanceHandler('roon:library:queue', (event, reference: unknown, zoneId: unknown) =>
    invokeCore(event, () =>
      supervisor.request('roon.library.queue', {
        reference: requireRoonEntityReference(reference),
        zoneId: requireZoneId(zoneId),
      }),
    ),
  )
  registerPerformanceHandler('roon:transport:stop', (event) =>
    invokeCore(event, () => supervisor.request('roon.transport.stop', {})),
  )
  registerPerformanceHandler('lyrics:get', (event, trackId: unknown) =>
    invokeCore(event, () =>
      supervisor.request('lyrics.get', {
        trackId: requireLyricsTrackId(trackId),
      }),
    ),
  )
  registerPerformanceHandler('lyrics:match:get', (event) =>
    invokeCore(event, () => supervisor.request('lyrics.match.get', {})),
  )
  registerPerformanceHandler('lyrics:match:select', (event, matchSessionId: unknown, candidateId: unknown) =>
    invokeCore(event, () => supervisor.request('lyrics.match.select', {
      matchSessionId: requireLyricsMatchId(matchSessionId),
      candidateId: requireLyricsMatchId(candidateId),
    })),
  )
  registerPerformanceHandler('lyrics:match:revoke', (event) =>
    invokeCore(event, () => supervisor.request('lyrics.match.revoke', {})),
  )
  registerPerformanceHandler('playback:get-state', (event) =>
    invokeCore(event, () => supervisor.request('playback.getState', {})),
  )
  registerPerformanceHandler('playback:get-stream-snapshot', (event) =>
    invokeCore(event, () => supervisor.getPlaybackStreamSnapshot()),
  )
  registerPerformanceHandler('playback:play', (event, trackId: unknown, qualityPreference: unknown, rendererClickAt: unknown) => {
    const mainReceivedAtMs = Date.now()
    return invokeCore(event, () => {
      const rendererClickAtMs = requireRendererClickAtMs(rendererClickAt, mainReceivedAtMs)
      mainDiagnostics.recordPlaybackStartup(rendererClickAtMs, mainReceivedAtMs)
      return supervisor.request('playback.play', {
        trackId: requirePlaybackTrackId(trackId),
        qualityPreference: requirePlaybackQualityPreference(qualityPreference),
        rendererClickAtMs,
      })
    })
  })
  registerPerformanceHandler('playback:pause', (event) =>
    invokeCore(event, () => supervisor.request('playback.pause', {})),
  )
  registerPerformanceHandler('playback:resume', (event) =>
    invokeCore(event, () => supervisor.request('playback.resume', {})),
  )
  registerPerformanceHandler('playback:stop', (event) =>
    invokeCore(event, () => supervisor.request('playback.stop', {})),
  )
  registerPerformanceHandler('playback:next', (event) =>
    invokeCore(event, () => supervisor.request('playback.next', {})),
  )
  registerPerformanceHandler('playback:previous', (event) =>
    invokeCore(event, () => supervisor.request('playback.previous', {})),
  )
  registerPerformanceHandler('playback:edit-queue',(event,request:unknown)=>invokeCore(event,()=>{if(!isMBQueueEditRequest(request))throw new Error('队列编辑请求无效');return supervisor.request('playback.editQueue',request)}))
  registerPerformanceHandler('playback:play-queue-entry',(event,request:unknown)=>invokeCore(event,()=>{if(!isMBQueuePlayEntryRequest(request))throw new Error('队列条目请求无效');return supervisor.request('playback.playQueueEntry',request)}))
  registerPerformanceHandler('playback:queue-local-edition',(event,request:unknown)=>invokeCore(event,()=>{if(!isMBEditionQueueRequest(request))throw new Error('发行版队列请求无效');return supervisor.request('playback.queueLocalEdition',request)}))
  registerPerformanceHandler('playback:play-queue-index', (event, index: unknown) =>
    invokeCore(event, () =>
      supervisor.request('playback.playQueueIndex', {
        index: requireExistingPlaybackIndex(index),
      }),
    ),
  )
  registerPerformanceHandler('playback:replace-queue', (event, items: unknown, index: unknown) =>
    invokeCore(event, () => {
      const queue = requirePlaybackQueue(items)
      return supervisor.request('playback.replaceQueue', {
        items: queue,
        index: requirePlaybackIndex(index, queue),
      })
    }),
  )
  registerPerformanceHandler('roon:volume:get', event => invokeCore(event, () => supervisor.request('roon.volume.get', {})))
  registerPerformanceHandler('roon:volume:set', (event, request: unknown) => invokeCore(event, () => {
    if (!isVolumeRequest(request)) return publicIpcFailure('INVALID_IPC_REQUEST', '无效的音量请求')
    return supervisor.request('roon.volume.set', request)
  }))
  registerPerformanceHandler('playback:seek', (event, positionMs: unknown) =>
    invokeCore(event, () => {
      if (
        typeof positionMs !== 'number' ||
        !Number.isSafeInteger(positionMs) ||
        positionMs < 0 ||
        positionMs > 24 * 60 * 60 * 1_000
      ) {
        return publicIpcFailure('INVALID_IPC_REQUEST', 'Invalid playback position')
      }
      return supervisor.request('playback.seek', { positionMs })
    }),
  )
  registerPerformanceHandler('playback:append-queue', (event, items: unknown) =>
    invokeCore(event, () =>
      supervisor.request('playback.appendQueue', {
        items: requirePlaybackQueue(items),
      }),
    ),
  )
  registerPerformanceHandler('playback:insert-next', (event, items: unknown) =>
    invokeCore(event, () =>
      supervisor.request('playback.insertNext', {
        items: requirePlaybackQueue(items),
      }),
    ),
  )
  registerPerformanceHandler('remote-core:get-state', (event) => {
    return invokeRemoteCore(event, getRemoteCoreState)
  })
  registerPerformanceHandler('remote-core:start', (event, sshTarget: unknown) => invokeRemoteCore(event, () => startRemoteCoreDevelopment(sshTarget)))
  registerPerformanceHandler('remote-core:stop', (event) => invokeRemoteCore(event, stopRemoteCoreDevelopment))
  registerPerformanceHandler('remote-core:reconnect', (event) => invokeRemoteCore(event, reconnectRemoteCoreDevelopment))
}

function createWindow(supervisor: CoreSupervisor, startup?: ReturnType<typeof createRemoteCoreStartup>): BrowserWindow {
  nativeTheme.themeSource = 'light'
  const window = new BrowserWindow({
    title: DISPLAY_NAME,
    width: 960,
    height: 640,
    minWidth: 720,
    minHeight: 480,
    // E2E 默认不弹出原生窗口；后台仍渲染，保留截图和 DOM 键盘测试。
    show: !!collectionScaleProbe || !!collectionReadonlyProbe || !!packagedRendererProbe || !isStartupTest && !isUiE2e,
    backgroundColor: '#f2edf1',
    webPreferences: {
      ...buildBrowserWindowWebPreferences(),
      ...(isUiE2e ? { backgroundThrottling: false } : {}),
      preload: path.join(currentDirectory, '../preload/index.cjs'),
      additionalArguments: ['--music-bridge-mobile-settings=v1', ...(startup ? ['--music-bridge-startup-nonce=' + startup.nonce] : []), ...(process.env.MUSIC_BRIDGE_PERFORMANCE_TRACE === '1' ? ['--music-bridge-performance-trace=1'] : []), ...(isLibraryReadTrace ? ['--music-bridge-library-read-trace=1'] : [])],
    },
  })
  mainWindow = window
  startup?.bindWindow(window)

  // 仅此真实主window的可信主frame；网页子view和任意console文本不进入证据环。
  window.webContents.on('console-message', details => {
    try {
      const frame = details.frame, mainFrame = window.webContents.mainFrame
      if (!frame || frame.processId !== mainFrame.processId || frame.routingId !== mainFrame.routingId
        || !isTrustedRendererSender({ senderId: window.webContents.id, windowId: window.webContents.id, frameUrl: frame.url })) return
      const operation = readLibraryOperationLine(details.message)
      if (operation?.part === 'ui') console.info(details.message)
      const artwork = desktopArtworkTraceEnabled ? readDesktopArtworkLine(details.message) : null
      if (artwork?.origin === 'renderer') collectDesktopArtwork(artwork)
      const safe = readLocalAlbumSafeTraceLine(details.message)
      if (safe && (safe.stage.startsWith('preload.') || safe.stage === 'renderer.reject')) collectLocalAlbumSafeTrace(safe)
    } catch { /* 旁注自己的异常不影响window/原读取。 */ }
  })

  window.webContents.on('will-navigate', (event, url) => {
    if (!isNavigationAllowed(url)) {
      event.preventDefault()
    }
  })
  window.webContents.setWindowOpenHandler(() => getWindowOpenDecision())
  window.on('close', (event) => {
    if (!shouldHideWindowOnClose(localWorkbenchShutdownConfirmed)) {
      return
    }
    event.preventDefault()
    window.hide()
  })
  window.on('closed', () => {
    if (mainWindow === window) {
      startup?.cancel()
      mainWindow = undefined
    }
  })
  collectionScaleProbe?.observeRenderer(window)
  void window.loadURL(`${RENDERER_SCHEME}://${RENDERER_HOST}${RENDERER_ENTRY_PATH}`)

  window.webContents.once('did-finish-load', () => {
    lifecycleProbe.mark('ui-loaded')
    const checkStartup = () => {
      collectionReadonlyProbe?.observeWindow(window)
      collectionScaleProbe?.observeWindow(window)
      if (isStartupTest && !isCoreCrashGate && !quitAfterCoreShutdown && !window.isDestroyed() && supervisor.status === 'ready') {
        void window.webContents
          .executeJavaScript(
            'Promise.all([window.musicBridge.pingCore(), window.musicBridge.getCoreHealth(), window.musicBridge.getCoreState()])',
          )
          .then((result: unknown) => {
            const [ping, health, state] = Array.isArray(result) ? result : []
            const healthValid = validateIpcEvent({
              version: IPC_VERSION,
              event: 'core.health',
              payload: { state: health },
            }).ok
            const stateValid = validateIpcEvent({
              version: IPC_VERSION,
              event: 'core.health',
              payload: { state },
            }).ok
            const passed =
              ping &&
              typeof ping === 'object' &&
              'pong' in ping &&
              ping.pong === true &&
              healthValid &&
              stateValid
            writeDiagnosticStdout(`${passed ? 'DESKTOP_STARTUP_READY' : 'DESKTOP_STARTUP_FAIL'}\n`)
            if (passed) {
              setTimeout(() => app.quit(), 25)
            } else {
              app.exit(1)
            }
          })
          .catch(() => {
            writeDiagnosticStdout('DESKTOP_STARTUP_FAIL\n')
            app.exit(1)
          })
      }
    }
    // 提前加载窗口时，原启动Gate仍须等同一bootstrap真正结算。
    if (startup) {
      void startup.waitUntilReady({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, { version: 1, nonce: startup.nonce }).then(checkStartup, () => undefined)
    } else checkStartup()
  })

  return window
}

function buildCoreEnvironment(): NodeJS.ProcessEnv {
  const environment = buildAllowlistedCoreEnvironment(process.env, {
    startupTest: isStartupTest,
    uiE2e: isUiE2e,
    coreCrashGate: isCoreCrashGate || isCoreRestartCredentialRecoveryGate,
    roonTimeGate: isRoonTimeGate,
    roonBrowseGate: isRoonBrowseGate,
    roonImageGate: isRoonImageGate,
    libraryReadTrace: isLibraryReadTrace,
    remoteCoreMode: coreMode,
    ...(coreDataDirectory !== undefined ? { dataDirectory: coreDataDirectory } : {}),
    ...(remoteStreamPort !== undefined ? { remoteStreamPort } : {}),
  })
  // arm 只由 Main 的真实双崩溃分支派生，原 Core allowlist 不继承父环境标志。
  if (
    isCoreCrashGate
    && environment.NODE_ENV === 'test'
    && environment.MUSIC_BRIDGE_CORE_TEST_MODE === '1'
    && environment.MUSIC_BRIDGE_CORE_CRASH_PROBE === '1'
  ) environment.MUSIC_BRIDGE_CORE_CRASH_PROBE_ARM_REQUIRED = '1'
  if (process.env.MB_MEDIA_WORKER_BINARY && process.env.MB_MEDIA_WORKER_BINARY_SHA256) {
    environment.MB_MEDIA_WORKER_BINARY = process.env.MB_MEDIA_WORKER_BINARY
    environment.MB_MEDIA_WORKER_BINARY_SHA256 = process.env.MB_MEDIA_WORKER_BINARY_SHA256
  }
  return environment
}

function getRemoteCoreState(): RemoteCoreTunnelState {
  const state = remoteCoreTunnelManager.getState()
  const configuredTarget = process.env.CORE_SSH_TARGET
  return !state.sshTarget && isSafeSshTarget(configuredTarget)
    ? { ...state, sshTarget: configuredTarget }
    : state
}

async function invokeRemoteCore<T>(
  event: Electron.IpcMainInvokeEvent,
  operation: () => Promise<T> | T,
): Promise<T> {
  requireTrustedRenderer(event)
  try {
    return await operation()
  } catch (error) {
    if (error instanceof CoreIpcError) {
      return publicIpcFailure(error.code, error.message)
    }
    return publicIpcFailure('INTERNAL_ERROR', 'Remote Core request failed')
  }
}

async function startRemoteCoreDevelopment(requestedTarget: unknown): Promise<RemoteCoreTunnelState> {
  const intent = ++remoteCoreModeIntent
  const environmentTarget = process.env.CORE_SSH_TARGET
  const sshTarget = typeof requestedTarget === 'string' && requestedTarget.length > 0
    ? requestedTarget
    : isSafeSshTarget(environmentTarget) ? environmentTarget : ''
  const localPorts = resolveRemoteCoreLocalPorts(process.env)
  if (coreMode === 'remote-core-development') await restoreLocalCoreAfterTunnelFailure(remoteCoreTunnelManager.getState())
  if (intent !== remoteCoreModeIntent || quitAfterCoreShutdown) return remoteCoreTunnelManager.getState()
  remoteCoreModeController.reset()
  return remoteCoreTunnelManager.start({
    sshTarget,
    remoteStreamPort: DEFAULT_REMOTE_STREAM_PORT,
    localStreamPort: localPorts.streamPort,
    autoReconnect: true,
  })
}

async function stopRemoteCoreDevelopment(): Promise<RemoteCoreTunnelState> {
  const intent = ++remoteCoreModeIntent
  remoteCoreModeController.reset()
  await coreSupervisor?.request('playback.stop', {}).catch(() => undefined)
  if (intent !== remoteCoreModeIntent) return remoteCoreTunnelManager.getState()
  const state = await remoteCoreTunnelManager.stop()
  if (intent === remoteCoreModeIntent && coreMode === 'remote-core-development') {
    coreMode = 'local-core'
    remoteStreamPort = undefined
    await coreSupervisor?.restart(buildCoreEnvironment())
  }
  return state
}

async function reconnectRemoteCoreDevelopment(): Promise<RemoteCoreTunnelState> {
  const intent = ++remoteCoreModeIntent
  if (coreMode === 'remote-core-development') await restoreLocalCoreAfterTunnelFailure(remoteCoreTunnelManager.getState())
  if (intent !== remoteCoreModeIntent || quitAfterCoreShutdown) return remoteCoreTunnelManager.getState()
  remoteCoreModeController.reset()
  return remoteCoreTunnelManager.reconnect()
}

function createCoreSupervisor(
  dataDirectory: string,
  options: {
    onReady?: (client: CoreStartupClient) => Promise<void> | void
    onEvent?: (event: TypedIpcEvent) => void
    onLifecycle?: (event: CoreSupervisorLifecycle) => void
    onCrashGateArm?: (arm: () => boolean) => void
  } = {},
): CoreSupervisor {
  coreDataDirectory = dataDirectory
  // callback仅由Main实际crash分支提供；普通factory不依赖新增外部标志。
  const crashGateEnabled = typeof options.onCrashGateArm === 'function'
  let currentCollectionChild: CoreChildProcess | undefined, boundCollectionChild: CoreChildProcess | undefined
  let readyCrashChild: CoreChildProcess | undefined, crashGateEntered = false
  const armedCrashChildren = new WeakSet<CoreChildProcess>()
  const armCurrentCrashChild = (): boolean => {
    const child = currentCollectionChild
    if (!crashGateEnabled || !child || readyCrashChild !== child || armedCrashChildren.has(child)) return false
    try {
      // 只走本次真实 Utility 的私有父连接；不增加 Renderer 或公共 Core 方法。
      child.postMessage({ type: 'musicbridge.core.crash-probe-arm', version: 1 }, [])
      armedCrashChildren.add(child)
      return true
    } catch { return false }
  }
  if (crashGateEnabled) options.onCrashGateArm?.(() => {
    const armed = armCurrentCrashChild()
    if (armed) crashGateEntered = true
    return armed
  })
  const supervisor = new CoreSupervisor({
    entryPath: path.join(currentDirectory, 'core.js'),
    cwd: dataDirectory,
    env: buildCoreEnvironment(),
    ...(mobilePreparationProbe ? { onMobileCapabilityTrace: (record: MobileCapabilityTraceRecord) => mobilePreparationProbe.acceptCoreTrace(record) } : {}),
    playbackEventProtocol: process.env.MUSIC_BRIDGE_COMPACT_PLAYBACK_EVENTS === '0' ? null : 'compact-v1',
    sourceWritesPort: true,
    relocationMainPort: true,
    dependencies: {
      createRelocationChannel: () => {
        const channel = new MessageChannelMain()
        return { port1: channel.port1 as unknown as CoreRelocationMessagePort, port2: channel.port2 as unknown as CoreRelocationMessagePort }
      },
      createSourceWritesChannel: () => {
        const channel = new MessageChannelMain()
        return { port1: channel.port1 as unknown as CoreMessagePort, port2: channel.port2 as unknown as CoreMessagePort }
      },
      createChannel: () => {
        const channel = new MessageChannelMain()
        collectionReadonlyProbe?.observePublicPort(channel.port2 as unknown as CoreMessagePort)
        collectionScaleProbe?.observePublicPort(channel.port2 as unknown as CoreMessagePort)
        packagedRouteProbe?.observePublicPort(channel.port2 as unknown as CoreMessagePort)
        packagedRendererProbe?.observePublicPort(channel.port2 as unknown as CoreMessagePort)
        return {
          port1: channel.port1 as unknown as CoreMessagePort,
          port2: channel.port2 as unknown as CoreMessagePort,
        }
      },
      fork: (entryPath, args, options) => {
        const child = utilityProcess.fork(entryPath, args, {
          cwd: options.cwd,
          env: (packagedRouteProbe || packagedRendererProbe || collectionReadonlyProbe || collectionScaleProbe ? { ...options.env,
            TMPDIR: process.env.TMPDIR, DEV_BUILD_ROOT: process.env.DEV_BUILD_ROOT, DEV_CACHE_ROOT: process.env.DEV_CACHE_ROOT,
          } : options.env) as Record<string, string>,
          stdio: packagedRouteProbe || packagedRendererProbe || collectionReadonlyProbe || collectionScaleProbe ? 'pipe' : options.stdio,
          serviceName: options.serviceName,
        }) as unknown as CoreChildProcess
        currentCollectionChild = child
        collectionReadonlyProbe?.observeChild(child, entryPath, args)
        collectionScaleProbe?.observeChild(child, entryPath, args)
        const diagnosticProbe = packagedRouteProbe ?? packagedRendererProbe
        if (diagnosticProbe) {
          const diagnostic = new MessageChannelMain()
          diagnosticProbe.observeChild(child, entryPath, args, diagnostic as unknown as { port1: CoreMessagePort; port2: CoreMessagePort })
        }
        return child
      },
    },
    performance: mainDiagnostics.performance,
    performanceContext: () => performanceIpc.context(),
    ...(libraryReadTrace ? { libraryReadTrace } : {}),
    onReady: async client => {
      if (collectionReadonlySettings && currentCollectionChild && boundCollectionChild !== currentCollectionChild) {
        boundCollectionChild = currentCollectionChild
        try {
          const channel = new MessageChannelMain() as unknown as { port1: CollectionReadonlyControlPort; port2: CollectionReadonlyControlPort }
          collectionScaleProbe?.observeControlPort(channel.port2)
          collectionReadonlySettings.attach(createCollectionReadonlyControlClient({ child: currentCollectionChild as unknown as CollectionReadonlyControlChild, channel }))
        } catch { collectionReadonlySettings.detach() /* 可选控制绑定失败不改变原Node ready与恢复。 */ }
      }
      await options.onReady?.(client)
    },
    onLifecycle: event => {
      // 该 ready 已经过 Main onReady 和 compact seed；初轮等真正进入 Gate 才 arm。
      if (event.event === 'ready') {
        readyCrashChild = currentCollectionChild
        if (crashGateEntered) armCurrentCrashChild()
      } else if (event.event === 'exit' || event.event === 'failed' || event.event === 'stopped') {
        readyCrashChild = undefined
        currentCollectionChild = undefined
      }
      collectionReadonlyProbe?.observeLifecycle(event)
      collectionScaleProbe?.observeLifecycle(event)
      if (event.event === 'exit' || event.event === 'failed' || event.event === 'stopped') collectionReadonlySettings?.detach()
      options.onLifecycle?.(event)
    },
    onEvent: (event: TypedIpcEvent) => {
      mainDiagnostics.recordCoreEvent(event)
      options.onEvent?.(event)
      if (shouldRefreshTrayForCoreEvent(event)) requestTrayRefresh()
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('core:event', event)
      }
    },
  })
  supervisor.configurePrivatePersistentOwnerStartup()
  return supervisor
}

async function prepareCoreDataDirectory(): Promise<{
  dataDirectory: string
  credentialVault: CredentialVault
}> {
  const dataDirectory = path.join(syntheticUserDataDirectory ?? app.getPath('userData'), 'data')
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 })
  const result = await migrateRoonConfig(isStartupTest || isUiE2e ? { mode: 'synthetic-test' } : {
    legacyPath: path.join(
      app.getPath('home'),
      'Library',
      'Application Support',
      'MusicBridgeAgent',
      'data',
      'config.json',
    ),
    targetPath: path.join(dataDirectory, 'config.json'),
  })
  if (result.status === 'invalid') {
    throw new Error('Roon configuration migration failed')
  }
  return {
    dataDirectory,
    credentialVault: new CredentialVault({
      filePath: path.join(dataDirectory, 'netease.credential'),
      storage: safeStorage,
    }),
  }
}

async function runCredentialVaultGate(credentialVault: CredentialVault): Promise<boolean> {
  const testCredential = 'v'.repeat(32)
  await credentialVault.save(testCredential)
  const stored = await credentialVault.read()
  await credentialVault.delete()
  const deleted = (await credentialVault.read()).status === 'missing'
  return stored.status === 'configured' && stored.credential === testCredential && deleted
}

async function waitForProviderConfigured(
  supervisor: CoreSupervisor,
  credentialVault: CredentialVault,
): Promise<boolean> {
  try {
    const health = await supervisor.request('core.getHealth', {})
    const stored = await credentialVault.read()
    return health.provider === 'configured' && stored.status === 'configured'
  } catch {
    return false
  }
}

async function waitForCoreRestartCredentialRecovery(
  supervisor: CoreSupervisor,
  credentialVault: CredentialVault,
): Promise<boolean> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (supervisor.restarts === 1 && supervisor.status === 'ready') {
      try {
        if (await waitForProviderConfigured(supervisor, credentialVault)) return true
      } catch {
        // The restart boundary is allowed to race one health request.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return false
}

async function bootstrap(): Promise<void> {
  const bootstrapStarted = performance.now()
  if (packagedRouteProbe && !app.isPackaged) throw new Error('固定路由诊断必须运行实际候选应用包。')
  if (packagedRendererProbe && !app.isPackaged) throw new Error('原控件诊断必须运行实际候选应用包。')
  lifecycleProbe.mark('bootstrap-start')
  await app.whenReady()
  // 二进制位置与SHA仅来自Main编译身份；Renderer、目录文件名和Provider均不能替换。
  if (typeof __MUSIC_BRIDGE_MEDIA_WORKER_SHA256__ === 'string') {
    const started = performance.now()
    logLibraryOperation('worker', 'media.bootstrap', 'start', {})
    try {
      const media = await resolveDesktopMediaWorker({ entryDirectory: currentDirectory, resourcesDirectory: process.resourcesPath,
        packaged: app.isPackaged, binarySha256: __MUSIC_BRIDGE_MEDIA_WORKER_SHA256__ })
      process.env.MB_MEDIA_WORKER_BINARY = media.binaryPath
      process.env.MB_MEDIA_WORKER_BINARY_SHA256 = media.binarySha256
      logLibraryOperation('worker', 'media.bootstrap', 'complete', { elapsedMs: performance.now() - started })
    } catch (error) {
      logLibraryOperation('worker', 'media.bootstrap', 'error', { elapsedMs: performance.now() - started, code: 'WORKER_FAILED' })
      throw error
    }
  }
  if (isUiE2e && process.platform === 'darwin') app.setActivationPolicy(packagedRendererProbe || collectionReadonlyProbe || collectionScaleProbe ? 'regular' : 'accessory')
  app.setAboutPanelOptions({ applicationName: DISPLAY_NAME })
  installApplicationMenu()
  await installRendererProtocol()
  installSessionSecurity(session.defaultSession)
  if (isOfflineUiE2e) {
    const evidence = installUiE2eNetworkGuard(session.defaultSession)
    ;(globalThis as typeof globalThis & { __musicBridgeUiE2eNetworkEvidence?: UiE2eNetworkEvidence }).__musicBridgeUiE2eNetworkEvidence = evidence
  }

  const prepared = await prepareCoreDataDirectory()
  lifecycleProbe.mark('data-prepared')
  if (isCredentialVaultGate && !isCoreRestartCredentialRecoveryGate && !isElectronColdStartGate) {
    try {
      const passed = await runCredentialVaultGate(prepared.credentialVault)
      writeDiagnosticStdout(`${passed ? 'CREDENTIAL_VAULT_GATE_PASS' : 'CREDENTIAL_VAULT_GATE_FAIL'}\n`)
      if (passed) app.quit()
      else app.exit(1)
    } catch {
      writeDiagnosticStdout('CREDENTIAL_VAULT_GATE_FAIL\n')
      app.exit(1)
    }
    return
  }

  collectionReadonlySettings = createCollectionReadonlySettings({ file: path.join(syntheticUserDataDirectory ?? app.getPath('userData'), 'collection-readonly.json'), ...(collectionScaleProbe ? { write: collectionScaleProbe.writePreference } : {}) })
  await collectionReadonlySettings.restore()
  let initialProvisioningComplete = false
  let supervisor: CoreSupervisor
  let armInitialCrashGate: (() => boolean) | undefined
  const crashGateLifecycle: Array<{ event: 'spawn' | 'ready' | 'exit'; code?: number }> = []
  supervisor = createCoreSupervisor(prepared.dataDirectory, {
    ...(isCoreCrashGate ? { onCrashGateArm: (arm: () => boolean) => { armInitialCrashGate = arm } } : {}),
    onReady: async client => {
      lifecycleProbe.mark('core-ready-received')
      await startRecordingPrintWorker(client)
      if (!initialProvisioningComplete || packagedRendererProbe) { lifecycleProbe.mark('onready-complete'); return }
      await restoreProviderCredential({
        vault: prepared.credentialVault,
        core: {
          verifyCredential: async (credential) =>
            (await client.requestInternal('auth.verifyCredential', { credential })).status,
          setCredential: (credential) =>
            client.request('auth.setCredential', { credential }),
          clearCredential: () => client.request('auth.clearCredential', {}),
        },
      })
      lifecycleProbe.mark('onready-complete')
    },
    onEvent: (event) => {
      if (event.event === 'auth.changed' && event.payload.state.status === 'expired') {
        void prepared.credentialVault.delete().catch(() => undefined)
      }
    },
    onLifecycle: (event) => {
      if (event.event === 'spawn') lifecycleProbe.mark('core-spawn')
      else if (event.event === 'ready') lifecycleProbe.mark('supervisor-ready')
      else if (event.event === 'exit') lifecycleProbe.mark('core-exit', event.code)
      if (isCoreCrashGate && (event.event === 'spawn' || event.event === 'ready' || event.event === 'exit') && crashGateLifecycle.length < 7) {
        crashGateLifecycle.push({ event: event.event, ...(event.event === 'exit' ? { code: event.code } : {}) })
      }
      if (event.event === 'ready') void bindCurrentLocalWorkbenchRootMainAuthor(supervisor)
      if (event.event !== 'ready' && !quitAfterCoreShutdown) revokeLocalWorkbenchRootMainAuthor()
      if (event.event !== 'ready') stopRecordingPrintWorker()
      if (event.event === 'ready') mobileConnectionSettings?.resume()
      else mobileConnectionSettings?.suspend()
      if (event.event === 'ready') roonDisplayConnection?.restart()
      else if (event.event === 'exit' || event.event === 'failed') roonDisplayConnection?.stop()
      const level = event.event === 'exit' || event.event === 'failed' ? 'warn' : 'info'
      mainDiagnostics.recordLifecycle(`core_${event.event}`, level)
    },
  })
  const albumArtworkDataDirectory=coreDataDirectory
  if(!albumArtworkDataDirectory)throw new CoreIpcError('NOT_READY','专辑封面转换的数据目录尚未就绪。')
  localArtworkImportNormalizer??=createLocalArtworkImportNormalizer({privateRoot:path.join(albumArtworkDataDirectory,'artwork-normalization'),decode:bytes=>nativeImage.createFromBuffer(bytes)})
  supervisor.configurePrivateLocalAlbumArtworkNormalizer(createLocalAlbumArtworkNormalizer(bytes=>nativeImage.createFromBuffer(Buffer.from(bytes)),localArtworkImportNormalizer))
  // 编译metadata的expectedManifest只在Main读取；相邻manifest与父环境不能自授权。
  supervisor.configurePrivateWorkbenchNative(await readDatasetWorkbenchNativeConfiguration({
    entryDirectory: currentDirectory,
    appDirectory: path.resolve(currentDirectory, '../..'),
    resourcesDirectory: process.resourcesPath,
    packaged: app.isPackaged,
  }))
  localLyricsMainService = createLocalLyricsMainService({ currentAuthor: () => localWorkbenchRootMainAuthor,
    verifyOriginal: (request,binding,context) => supervisor.verifyLyricsGrantOriginal(request,binding,context.signal,context.deadlineAtMs) })
  supervisor.configurePrivateLyricsGrantProducer((request,context) => localLyricsMainService!.produce(request,context))
  localLyricsProviderBridge = createLocalLyricsMainProviderBridge({ currentAuthor: () => localWorkbenchRootMainAuthor })
  supervisor.configurePrivateLyricsProviderBridge({
    execute: (request,context) => {
      if (!localLyricsProviderBridge) throw new CoreIpcError('NOT_READY','歌词来源Main桥尚未装配。')
      switch (request.command) {
        case 'lyricsProviderStart': return localLyricsProviderBridge.execute({ command: 'lyricsProviderStart', payload: request.payload as DatasetLyricsProviderStart },context)
        case 'lyricsProviderRead': return localLyricsProviderBridge.execute({ command: 'lyricsProviderRead', payload: request.payload as {operationId:string;offset:number} },context)
        case 'lyricsProviderCancel': return localLyricsProviderBridge.execute({ command: 'lyricsProviderCancel', payload: request.payload as {operationId:string} },context)
        case 'lyricsProviderJoin': return localLyricsProviderBridge.execute({ command: 'lyricsProviderJoin', payload: request.payload as {operationId:string} },context)
      }
    },
    revokeOwner: binding => localLyricsProviderBridge!.revokeOwner(binding),
  })

  localNameMainBridge=createLocalWorkbenchNameMainBridge({currentAuthor:()=>localWorkbenchRootMainAuthor,getTransport:binding=>{
    if(!localWorkbenchMainAssembly)throw new CoreIpcError('NOT_READY','原Main名称资源尚未装配。')
    return localWorkbenchMainAssembly.nameTransport(binding)
  }})
  supervisor.configurePrivateNameProviderBridge({execute:(request,context)=>{
    if(!localNameMainBridge)throw new CoreIpcError('NOT_READY','原NAME Main桥尚未装配。')
    return localNameMainBridge.execute(request,context)
  },revokeOwner:binding=>quitAfterCoreShutdown?localNameMainBridge!.sealOwner(binding):localNameMainBridge!.revokeOwner(binding)})

  supervisor.configurePrivateWorkbenchReadersProducer(async(request,context)=>{
    if(!localWorkbenchMainAssembly)throw new CoreIpcError('NOT_READY','原本库读取资源作者尚未装配。')
    await localWorkbenchMainAssembly.stopLibraryReaders(request.binding,context.binding)
  })
  supervisor.configurePrivateWorkbenchDirectoryProducer((request,context)=>{if(!localWorkbenchDirectoryBridge)throw new CoreIpcError('NOT_READY','原目录Main许可尚未装配。');return localWorkbenchDirectoryBridge.produce(request,context)})
  coreSupervisor = supervisor
  if (isCoreRestartCredentialRecoveryGate || electronColdStartStage === 'seed') {
    await prepared.credentialVault.save('v'.repeat(32))
  }
  // 专用无窗口Gate保持原入口；普通应用先读取同源偏好，再激活唯一首代Core。
  let earlyWindow: BrowserWindow | undefined
  if (!packagedRouteProbe && !isCoreRestartCredentialRecoveryGate && !isElectronColdStartGate) {
    const startup = createRemoteCoreStartup({ nonce: randomUUID(),
      suggestedTarget: process.env.CORE_SSH_TARGET, currentWindow: () => mainWindow,
      isClosing: () => quitAfterCoreShutdown })
    remoteCoreStartup = startup
    ipcMain.handle(REMOTE_CORE_STARTUP_PREFERENCE, (event, value: unknown) => startup.acceptPreference(event, value))
    ipcMain.handle(REMOTE_CORE_STARTUP_READY, (event, value: unknown) => startup.waitUntilReady(event, value))
    earlyWindow = createWindow(supervisor, startup)
    await startup.activate({ startLocal: () => supervisor.start(),
      startRemote: target => startRemoteCoreDevelopment(target), isCoreReady: () => supervisor.status === 'ready' })
    startup.assertCurrent()
  } else await supervisor.start()
  remoteCoreStartup?.assertCurrent()
  await bindCurrentLocalWorkbenchRootMainAuthor(supervisor)
  remoteCoreStartup?.assertCurrent()
  if (packagedRouteProbe) {
    await packagedRouteProbe.run(supervisor)
    app.quit()
    return
  }
  roonDisplayConnection = new RoonDisplayConnection({
    settingsPath: path.join(syntheticUserDataDirectory ?? app.getPath('userData'), 'roon-display.json'),
    forward: event => supervisor.requestInternal('lyrics.display.update', event),
  })
  // 隔离测试绝不自动读取本机的真实服务地址。
  if (!isStartupTest && !isUiE2e) await roonDisplayConnection.restore()
  remoteCoreStartup?.assertCurrent()
  const credentialCore = {
    verifyCredential: async (credential: string) =>
      (await supervisor.requestInternal('auth.verifyCredential', { credential })).status,
    setCredential: (credential: string) =>
      supervisor.request('auth.setCredential', { credential }),
    clearCredential: () => supervisor.request('auth.clearCredential', {}),
  }
  if (electronColdStartStage === 'restore') {
    await restoreProviderCredential({ vault: prepared.credentialVault, core: credentialCore })
  } else if (!packagedRendererProbe) {
    const provisioningStatus = await provisionProviderCredential({
      vault: prepared.credentialVault,
      environment: process.env,
      core: credentialCore,
    })
    // 只记录闭集恢复结果，便于区分未登录与凭据读取/验证未完成；不记录凭据或异常正文。
    logLibraryOperation('library', 'startup.provider-auth', provisioningStatus === 'configured' ? 'complete' : 'skipped',
      { code: provisioningStatus.toUpperCase() })
  }
  remoteCoreStartup?.assertCurrent()
  initialProvisioningComplete = true
  if (isCoreRestartCredentialRecoveryGate) {
    const passed = await waitForCoreRestartCredentialRecovery(
      supervisor,
      prepared.credentialVault,
    )
    await prepared.credentialVault.delete().catch(() => undefined)
    await supervisor.shutdown()
    writeDiagnosticStdout(
      `${passed ? 'CORE_RESTART_CREDENTIAL_RECOVERY_GATE_PASS' : 'CORE_RESTART_CREDENTIAL_RECOVERY_GATE_FAIL'}\n`,
    )
    if (passed) app.quit()
    else app.exit(1)
    return
  }
  if (isElectronColdStartGate) {
    const passed = await waitForProviderConfigured(supervisor, prepared.credentialVault)
    if (electronColdStartStage === 'restore') {
      await prepared.credentialVault.delete().catch(() => undefined)
    }
    await supervisor.shutdown()
    const marker =
      electronColdStartStage === 'seed'
        ? 'ELECTRON_COLD_START_SEED'
        : 'ELECTRON_COLD_START_RESTORE'
    writeDiagnosticStdout(`${passed ? `${marker}_PASS` : `${marker}_FAIL`}\n`)
    if (passed) app.quit()
    else app.exit(1)
    return
  }
  artistCatalogService = createArtistCatalogService({ supervisor,
    directory: path.join(syntheticUserDataDirectory ?? app.getPath('userData'), 'artist-catalog') })
  const pairingPrompts = !isStartupTest && !isUiE2e
    ? createMobilePairingPromptCoordinator({ getWindow: () => mainWindow }) : undefined
  mobilePairingPrompts = pairingPrompts
  mobileConnectionSettings = createMobileConnectionSettings({ directory: path.join(syntheticUserDataDirectory ?? app.getPath('userData'), 'mobile-connection'),
    artistCatalog: artistCatalogService,
    ...(pairingPrompts ? { nearbyPairing: {
      publisher: createMobileBonjourPublisher(),
      show: input => pairingPrompts.show(input),
      dismiss: requestId => pairingPrompts.dismiss(requestId),
    } } : {}),
    ...(mobileRangeTimingProbe ? { rangeTimingProbe: mobileRangeTimingProbe } : {}),
    ...(mobileRangeWindowProbe ? { rangeWindowProbe: mobileRangeWindowProbe } : {}),
    ...(mobilePreparationProbe ? { preparationProbe: mobilePreparationProbe } : {}),
    ...(mobileOwnerLoadTraceProbe ? { ownerLoadTraceProbe: mobileOwnerLoadTraceProbe } : {}),
    protector: { encryptString: value => { if (!safeStorage.isEncryptionAvailable()) throw new Error('移动连接安全存储不可用。'); return safeStorage.encryptString(value) },
      decryptString: value => { if (!safeStorage.isEncryptionAvailable()) throw new Error('移动连接安全存储不可用。'); return safeStorage.decryptString(value) } },
    currentDataset: async () => (await supervisor.request('commandOutbox.context', {})).datasetId,
    requestOwner: request => supervisor.requestMobileMain(request), isCoreReady: () => supervisor.status === 'ready' && !quitAfterCoreShutdown,
    requestContentRpc: (request, signal, recheck) => supervisor.requestMobileContentMain(request, signal, recheck),
    environment: __MUSIC_BRIDGE_DEVELOPMENT_BUILD__ ? 'development' : 'production',
    resizeArtwork: (bytes, size, providerInput) => {
      if (providerInput) {
        // 仅新增Provider图片先过原结构/像素/解码预算；本地Owner路径保持原读取与缩图。
        return resizeMobileProviderArtwork(bytes, size, raw => nativeImage.createFromBuffer(raw));
      }
      const image = nativeImage.createFromBuffer(Buffer.from(bytes)); if (image.isEmpty()) throw new Error('当前封面无法解码。');
      const original = image.getSize(); if (original.width < 1 || original.height < 1 || original.width > 1200 || original.height > 1200) throw new Error('当前封面尺寸无效。');
      const scale = size / Math.max(original.width, original.height), resized = image.resize({ width: Math.max(1, Math.round(original.width * scale)), height: Math.max(1, Math.round(original.height * scale)), quality: 'best' });
      return new Uint8Array(resized.toJPEG(90));
    } })
  if (!isStartupTest && !isUiE2e) await mobileConnectionSettings.restore()
  remoteCoreStartup?.assertCurrent()
  registerIpcHandlers(supervisor, prepared.credentialVault)
  const window = earlyWindow ?? createWindow(supervisor)
  createTray(supervisor)
  if (remoteCoreStartup) {
    if (supervisor.status !== 'ready' || ['checking', 'starting', 'reconnecting', 'stopping'].includes(remoteCoreTunnelManager.getState().status)) {
      throw new CoreIpcError('NOT_READY', '最终Core模式尚未完成启动。')
    }
    remoteCoreStartup.complete()
    logLibraryOperation('library', 'startup.bootstrap', 'complete', { code: 'FINAL_READY', elapsedMs: performance.now() - bootstrapStarted })
  }
  if (collectionScaleProbe) {
    try { await collectionScaleProbe.runWindowProbe(window) } catch { collectionScaleProbe.emit('main.probeFailed', { code: 'PROBE_FAILED' }) }
    app.quit(); return
  }
  if (collectionReadonlyProbe) {
    try { await collectionReadonlyProbe.runWindowProbe(window) } catch { collectionReadonlyProbe.emit('main.probeFailed', { code: 'PROBE_FAILED' }) }
    app.quit(); return
  }
  if (packagedRendererProbe) {
    try { await packagedRendererProbe.run(window) }
    catch { packagedRendererProbe.emit('main.probeFailed', { code: 'PROBE_FAILED' }) }
    app.quit()
    return
  }
  if (isCoreCrashGate) {
    const armed = armInitialCrashGate?.() === true
    const passed = armed && await waitForCoreCrashFailure(() => ({ status: supervisor.status, restarts: supervisor.restarts, lifecycle: crashGateLifecycle }))
    writeDiagnosticStdout(`${passed ? 'CORE_CRASH_GATE_PASS' : 'CORE_CRASH_GATE_FAIL'}\n`)
    if (passed) app.quit()
    else app.exit(1)
    return
  }

  app.on('activate', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      showMainWindow()
    } else {
      createWindow(supervisor)
      createTray(supervisor)
    }
  })
}

void bootstrap().catch(error => {
  const cancelled = remoteCoreStartup?.cancelled
  remoteCoreStartup?.fail(error)
  if (quitAfterCoreShutdown) return
  if (cancelled) { app.quit(); return }
  writeDiagnosticStderr('DESKTOP_STARTUP_FAIL\n')
  app.exit(1)
})

app.on('before-quit', (event) => {
  remoteCoreStartup?.cancel()
  packagedRouteProbe?.emit('main.beforeQuit')
  packagedRendererProbe?.emit('main.beforeQuit')
  collectionReadonlyProbe?.emit('main.beforeQuit')
  collectionScaleProbe?.emit('main.beforeQuit')
  lifecycleProbe.mark('before-quit')
  if (localWorkbenchShutdownConfirmed) {
    destroyTray()
    return
  }
  if (!coreSupervisor && !localWorkbenchQuitCoordinator) {
    destroyTray()
    return
  }
  event.preventDefault()
  const shutdownCode = (reason: unknown): string => {
    try {
      const descriptor = reason !== null && typeof reason === 'object' ? Object.getOwnPropertyDescriptor(reason, 'code') : undefined
      if (descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string'
        && ['NOT_READY', 'OUTBOX_SCOPE_MISMATCH', 'TIMEOUT', 'INVALID_IPC_RESPONSE', 'INTERNAL_ERROR', 'CHANGED', 'CLOSED', 'UNKNOWN'].includes(descriptor.value)) return descriptor.value
    } catch { /* 错误对象不能妨碍原资源收尾，也不执行code getter。 */ }
    return 'INTERNAL_ERROR'
  }
  if (!localWorkbenchQuitCoordinator) {
    // 首次Quit固定全部原关闭者；作者撤销后重试也不能从当前global换取新对象。
    const original = {
      supervisor: coreSupervisor!, author: localWorkbenchRootMainAuthor,
      management: localWorkbenchManagementBoundary, legacy: localWorkbenchLegacyIpc,
      normalizer: localArtworkImportNormalizer, assembly: localWorkbenchMainAssembly,
      lyricsMain: localLyricsMainService, lyricsProvider: localLyricsProviderBridge, name: localNameMainBridge,
      remote: remoteCoreTunnelManager, mobile: mobileConnectionSettings, pairingPrompts: mobilePairingPrompts,
      outbox: commandOutbox, artistCatalog: artistCatalogService,
      display: roonDisplayConnection, closeArtwork: closeLocalArtwork,
      closeSourceWrites: closeLocalSourceWrites, closeRelocation: closeLocalRelocation, probe: collectionScaleProbe,
    }
    quitAfterCoreShutdown = true
    localWorkbenchMainRecovery?.close()
    remoteCoreModeIntent++
    remoteCoreModeController.reset()
    // 首代尚未发布作者时，SSH绑定回调可能正等待Core.start；先启动同原关闭，
    // 解除remote_stop→绑定→冷启动的等待环。原owner_shutdown仍须等它的真实结果。
    const initialCoreShutdown = remoteCoreStartup?.remoteActivationPending && !original.author
      && original.supervisor.status === 'starting' ? original.supervisor.shutdown() : undefined
    void initialCoreShutdown?.catch(() => undefined)
    original.management?.seal()
    stopRecordingPrintWorker()
    let outboxClosing: Promise<void> | undefined
    localWorkbenchQuitCoordinator = createLocalWorkbenchQuitCoordinator({
      onPhaseStart: phase => mainDiagnostics.recordLifecycle('local_workbench_shutdown_phase_start', 'info', { state: phase }),
      onPhaseSettled: phase => mainDiagnostics.recordLifecycle('local_workbench_shutdown_phase_settled', 'info', { state: phase }),
      onFailure: (failure, first) => mainDiagnostics.recordLifecycle(first ? 'local_workbench_shutdown_failure' : 'local_workbench_shutdown_cleanup_failure', 'error', {
        state: failure.phase, code: shutdownCode(failure.reason),
      }),
      groups: [
        { steps: [
          ['stop_display', () => original.display?.stop()],
          ['seal_artwork_ipc', () => original.closeArtwork?.()],
          ['seal_source_writes_ipc', () => original.closeSourceWrites?.()],
          ['seal_relocation_ipc', () => original.closeRelocation?.()],
          ['close_artist_catalog', () => original.artistCatalog?.close()],
        ] },
        { onStart: () => lifecycleProbe.mark('remote-stop-start'), onSettled: () => lifecycleProbe.mark('remote-stop-end'), steps: [
          ['remote_stop', async () => {
            const state = await original.remote.stop()
            if (state.status !== 'idle' || state.mode !== 'local-core') throw new CoreIpcError('NOT_READY', '原远程隧道关闭尚未确认。')
          }],
          ['mobile_close', async () => {
            // 仍等待首次退出固定的服务；即使其关闭失败也收起本轮原生验证码窗口。
            try { await original.mobile?.close() }
            finally { await original.pairingPrompts?.stop() }
          }],
        ] },
        { onStart: () => lifecycleProbe.mark('core-shutdown-start'), steps: [
          ['prepare_name', () => original.author ? original.name?.sealOwner(original.author.binding) : undefined],
          ['prepare_lyrics', () => original.author ? original.lyricsProvider?.revokeOwner(original.author.binding) : undefined],
          ['prepare_reads', () => original.legacy?.sealReads()],
          ['prepare_normalizer', () => original.normalizer?.close()],
          ['prepare_media_worker', () => closeRustMediaWorkerPool()],
        ] },
        // 某一准备/Owner关闭失败，仍等待同原其余关闭与join；未确认时保留作者和批准FD。
        { steps: [['owner_shutdown', () => initialCoreShutdown ?? original.supervisor.shutdown()]] },
        { steps: [
          ['join_name', () => original.supervisor.joinPrivateNameProviderBridge()],
          ['join_lyrics_grant', () => original.supervisor.joinPrivateLyricsGrantProducer()],
          ['join_lyrics_provider', () => original.supervisor.joinPrivateLyricsProviderBridge()],
          ['join_directory', () => original.supervisor.joinPrivateWorkbenchDirectoryProducer()],
          ['join_readers', () => original.supervisor.joinPrivateWorkbenchReadersProducer()],
        ] },
        { requiresPreviousSuccess: true, steps: [['revoke_author', () => {
          if (localWorkbenchRootMainAuthor !== original.author) throw new CoreIpcError('OUTBOX_SCOPE_MISMATCH', '原退出作者已经改变，不能撤销其他作者。')
          revokeLocalWorkbenchRootMainAuthor()
        }]] },
        { requiresPreviousSuccess: true, steps: [
          ['close_management', () => original.management?.close()],
          ['close_legacy', () => original.legacy?.close()],
          ['close_assembly', () => original.assembly?.close()],
          ['close_lyrics_main', () => original.lyricsMain?.close()],
          ['close_lyrics_provider', () => original.lyricsProvider?.close()],
          ['close_name', () => original.name?.close()],
        ] },
        { requiresPreviousSuccess: true, steps: [['core_shutdown_complete', () => lifecycleProbe.mark('core-shutdown-end')]] },
        { requiresPreviousSuccess: true, steps: [['close_outbox', async () => {
          if (!original.outbox) return
          if (!outboxClosing) {
            lifecycleProbe.mark('outbox-close-start')
            outboxClosing = Promise.resolve().then(() => original.outbox!.close())
            void outboxClosing.then(() => lifecycleProbe.mark('outbox-close-end'), () => undefined)
          }
          // 一秒只界定本次等待；原close仍保留，超时不能授quiet或另发store.close。
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            await Promise.race([outboxClosing, new Promise<void>((_resolve, reject) => {
              timer = setTimeout(() => { lifecycleProbe.mark('outbox-close-timeout'); reject(new CoreIpcError('TIMEOUT', '原未确认操作资源仍在关闭。')) }, 1000)
            })])
          } finally { if (timer) clearTimeout(timer) }
        }]] },
        { requiresPreviousSuccess: true, steps: [['flush_core_evidence', async () => {
          if (original.probe) { try { await original.probe.flushCoreEvidence() } catch { /* 保留诊断失败，不改变已完成的业务关闭。 */ } }
        }]] },
      ],
    })
  }
  const coordinator = localWorkbenchQuitCoordinator
  const attempt = coordinator.request()
  if (!attempt) return
  void attempt.then(() => {
    localWorkbenchShutdownConfirmed = true
    destroyTray(); lifecycleProbe.mark('app-quit-reissued'); app.quit()
  }).catch(reason => {
    const first = coordinator.firstFailure
    if (first) mainDiagnostics.recordLifecycle('local_workbench_shutdown_failure', 'error', { state: first.phase, code: shutdownCode(first.reason) })
    mainDiagnostics.recordLifecycle('local_workbench_shutdown_not_verified', 'error', { code: shutdownCode(reason) })
  })
})

app.on('will-quit', () => { lifecycleProbe.mark('will-quit'); packagedRouteProbe?.emit('main.willQuit'); packagedRendererProbe?.emit('main.willQuit'); collectionReadonlyProbe?.emit('main.willQuit'); collectionScaleProbe?.emit('main.willQuit') })

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !quitAfterCoreShutdown) {
    app.quit()
  }
})

function requireRoonSearchKind(value: unknown): 'track' | 'album' | 'artist' {
  if (value === 'track' || value === 'album' || value === 'artist') return value
  throw new Error('搜索类型无效')
}
