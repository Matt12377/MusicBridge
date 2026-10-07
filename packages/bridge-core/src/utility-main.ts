import { isLocalArtworkCommand, isLocalArtworkInternalCommand, isLocalRelocationCommand, isLocalRelocationInternalCommand } from '@music-bridge/contracts';
import { isLocalCatalogCommand, isLocalCatalogInternalCommand, isLocalScanCommand, isLocalScanInternalCommand, validateIpcInternalRequest } from '@music-bridge/contracts';
import { dispatchDatasetCommand, dispatchInternalDatasetCommand } from './collection/dataset-dispatch.js';
import { createDatasetRoonProjectionGateway } from './collection/dataset-roon-projection.js';
import { isDatasetProjectionPayload, type DatasetProjectionCommand, type DatasetProjectionCommandPayloads, isDatasetCommand, DatasetOwnerDispatchError, type DatasetOwnerEndpoint, type DatasetOwnerIdentity, type DatasetOwnerProjectionHandler } from './collection/dataset-owner-protocol.js';
import { failureForError, responseFailure } from './shared/ipc-failure.js';
import { LibraryReadRegistry } from './shared/library-read-registry.js';
import { createLibraryReadTraceWriter, emitLibraryReadTrace, isLibraryReadTraceEnabled, libraryReadTraceFailure, type LibraryReadTraceSink } from './shared/library-read-trace.js';
import { isLibraryReadCommand, isLibraryReadCancel } from '@music-bridge/contracts';
import { withPerformanceContext } from './diagnostics/performance-trace.js';
import type { VolumeRequest } from '@music-bridge/contracts';
import { RecordingPrintError } from './recording/print-integrity.js';
import { RecordingReplicaError } from './recording/replica-error.js';
import { AttemptError, AttemptNotAcceptedError } from './recording/attempt-integrity.js';
import { RecordingRecordError } from './recording/record-integrity.js';
import { OutputCheckError } from './recording/output-error.js';
import type { PinnedOutputHelper } from './recording/bundled-output-helper.js';
import type { PinnedDeviceOutputHelper } from './recording/bundled-device-output-helper.js';
import type { GateBCandidateIdentity } from './recording/gate-b-admission.js';
import { reconcileOutputRunRecovery, type OutputRunRecoveryState } from './recording/output-run-recovery.js';
import { DeviceSelectionError } from './recording/device-selection-broker.js';
import { RecordingPlanError } from './recording/plan-integrity.js';
import { BackupWorkflowError } from './recording/backup-workflow-store.js';
import { readSpreadsheetFile, SpreadsheetReadError } from './collection/spreadsheet-files.js';
import { parseSpreadsheetWorkbook, SpreadsheetParseError } from './collection/spreadsheet-parser.js';
import { DatasetScopeError } from './recording/dataset-identity.js';
import { createSyntheticRoonLibrary } from './roon/synthetic-library.js';
import { appendFileSync, chmodSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { types } from 'node:util';
import { CollectionError, type CollectionRepository } from './collection/repository.js';
import { openCollectionDataset } from './recording/restore-dataset-runtime.js';
import {
  IPC_VERSION,
  parseIpcRuntimeMessage,
  validateIpcRequest,
  validateIpcResponseForCommand,
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
import { createRustReadonlyCoreDatasetOwner, type RustReadonlyCoreOptions } from './rust-core/core-dataset-owner.js';
import { createRustReadonlyCoreController, type RustReadonlyCoreController } from './rust-core/host-controller.js';
import { validateRustSnapshotProfile } from './rust-core/readonly-sidecar.js';

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


function requestId(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.id !== 'string') return undefined;
  if (value.id.trim().length === 0 || value.id.length > 128) return undefined;
  return value.id;
}


function postReady(port: UtilityPort, runtime: CoreRuntime): void {
  const playbackEvents = runtime.getPlaybackEventProtocol?.();
  port.postMessage({
    version: IPC_VERSION,
    event: 'core.ready',
    payload: { state: runtime.getState(), ...(playbackEvents ? { playbackEvents } : {}) },
  } satisfies CoreRuntimeEvent);
}

async function dispatch(
  runtime: CoreRuntimeForIpc,
  request: IpcRequest,
): Promise<unknown> {
  if (isLocalArtworkInternalCommand(request.command) || isLocalCatalogInternalCommand(request.command) || isLocalScanInternalCommand(request.command) || isLocalRelocationInternalCommand(request.command)) {
    if (runtime.datasetOwnerEndpoint) {
      if (!runtime.datasetOwnerEndpoint.dispatchInternal) throw new DatasetOwnerDispatchError(responseFailure(request.id, 'NOT_READY', '可信观察入口未就绪。'));
      return runtime.datasetOwnerEndpoint.dispatchInternal(request);
    }
    return dispatchInternalDatasetCommand(runtime, request);
  }
  if(request.command==='localCatalog.prepare' && runtime.playbackPlayLocal){
    if(request.expectedDatasetId!==undefined){const identity=await runtime.datasetOwnerEndpoint?.prepare();if(!identity || identity.datasetId!==request.expectedDatasetId)throw new DatasetScopeError();}
    return runtime.playbackPlayLocal(request.payload as import('@music-bridge/contracts').LocalPlayRequest);
  }
  if (isDatasetCommand(request.command)) {
    return runtime.datasetOwnerEndpoint
      ? runtime.datasetOwnerEndpoint.dispatch(request)
      : dispatchDatasetCommand(runtime, request);
  }
  if (request.expectedDatasetId !== undefined) {
    if (runtime.datasetOwnerEndpoint) {
      // 一个Core代际只有一个dataset；已完成prepare的身份无需排在繁忙SQL之后读取。
      const identity = await runtime.datasetOwnerEndpoint.prepare();
      if (identity.datasetId !== request.expectedDatasetId) throw new DatasetScopeError();
    } else {
      if (!runtime.commandOutbox) throw new CollectionError('INVENTORY_UNAVAILABLE', '工作库身份尚未就绪。');
      runtime.commandOutbox.assertScope(request.expectedDatasetId);
    }
  }
  switch (request.command as IpcCommand) {
    case 'playback.localTarget':
      return runtime.getLocalLibraryPlaybackTarget?.() ?? null;
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
    case 'lyrics.display.update':
      return runtime.updateRoonDisplayLyrics(request.payload as IpcCommandPayloads['lyrics.display.update']);
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
        (request.payload as { kind?: 'track' | 'album' | 'artist' }).kind,
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
        (request.payload as { queueReferences?: readonly string[] }).queueReferences,
        (request.payload as { contextHandle?: string }).contextHandle,
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
    case 'playback.getStreamSnapshot':
      return runtime.getPlaybackStreamSnapshot?.() ?? null;
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
    case 'roon.volume.get': return runtime.getVolume();
    case 'roon.volume.set': return runtime.setVolume(request.payload as VolumeRequest);
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
    case 'playback.editQueue':
      if(!runtime.playbackEditLogicalQueue)throw new BridgeError('BAD_REQUEST','队列编辑尚未就绪',{httpStatus:409});return runtime.playbackEditLogicalQueue(request.payload as import('@music-bridge/contracts').MBQueueEditRequest);
    case 'playback.playQueueEntry':
      if(!runtime.playbackPlayQueueEntry)throw new BridgeError('BAD_REQUEST','队列入口尚未就绪',{httpStatus:409});return runtime.playbackPlayQueueEntry(request.payload as import('@music-bridge/contracts').MBQueuePlayEntryRequest);
    case 'playback.queueLocalEdition':
      if(!runtime.playbackQueueLocalEdition)throw new BridgeError('BAD_REQUEST','发行队列尚未就绪',{httpStatus:409});return runtime.playbackQueueLocalEdition(request.payload as import('@music-bridge/contracts').MBEditionQueueRequest);
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

function validateRoutedIpcRequest(runtime: CoreRuntimeForIpc, input: unknown) {
  if (isRecord(input) && (isLocalArtworkCommand(input.command) || isLocalCatalogCommand(input.command) || isLocalScanCommand(input.command) || isLocalRelocationCommand(input.command))) return isLocalArtworkInternalCommand(input.command) || isLocalCatalogInternalCommand(input.command) || isLocalScanInternalCommand(input.command) || isLocalRelocationInternalCommand(input.command) ? validateIpcInternalRequest(input) : validateIpcRequest(input);
  if (runtime.datasetOwnerEndpoint && isRecord(input) && isDatasetCommand(input.command) && isRecord(input.payload)) {
    // 仅用原core.ping合同核小信封；原领域命令和完整payload由owner再执行原完整validator。
    // 数据集命令不在library read白名单，readContext仍由原validator拒绝。
    const envelope = validateIpcRequest({ ...input, command: 'core.ping', payload: {} });
    return envelope.ok ? { ok: true as const, value: { ...envelope.value, command: input.command, payload: input.payload } } : envelope;
  }
  return validateIpcRequest(input);
}

export async function attachCoreRuntimePort(
  port: UtilityPort,
  runtime: CoreRuntimeForIpc,
  options: { exitAfterShutdown?: boolean; beforeReady?: () => void | Promise<void>; libraryReadTrace?: LibraryReadTraceSink } = {},
): Promise<void> {
  const reads = new LibraryReadRegistry(command => runtime.getLibraryReadScope?.(command) ?? 'runtime', Date.now, 64, 256, options.libraryReadTrace);
  port.on('message', (event) => {
    if (isLibraryReadCancel(event.data)) { reads.cancel(event.data.id); return; }
    void (async () => {
      const parsed = validateRoutedIpcRequest(runtime, event.data);
      const id = requestId(event.data);
      if (!parsed.ok) {
        if (id) port.postMessage(responseFailure(id, parsed.error.code, parsed.error.message));
        return;
      }
      try {
        const recorder = runtime.performance;
        const context = parsed.value.performanceTrace;
        const span = recorder?.start('ipc', context, {}, { command: parsed.value.command });
        recorder?.mark('ipc', 'core-received', span?.context, {}, { command: parsed.value.command });
        let result: unknown;
        try {
          const operation = () => recorder ? withPerformanceContext(recorder, span?.context, () => dispatch(runtime, parsed.value)) : dispatch(runtime, parsed.value);
          if (parsed.value.command === 'core.shutdown') reads.cancelAll('shutdown');
          if (['auth.setCredential', 'auth.clearCredential', 'auth.logout'].includes(parsed.value.command)) reads.cancelWhere(command => command.startsWith('library.'), 'credential-changed');
          if (parsed.value.command === 'roon.selectZone') reads.cancelWhere(command => !command.startsWith('library.') || command === 'library.match' || command === 'library.aggregateSearch', 'zone-changed');
          result = await (isLibraryReadCommand(parsed.value.command) ? reads.read(parsed.value, operation) : operation());
          span?.end('ok');
        } catch (error) { span?.end('error'); throw error; }
        // 最后同步采样覆盖dispatch的await窗口，此后直到postMessage不再让出执行权。
        if (parsed.value.command === 'playback.getStreamSnapshot') result = runtime.getPlaybackStreamSnapshot?.() ?? null;
        const response: IpcResponse = {
          version: IPC_VERSION,
          id: parsed.value.id,
          ok: true,
          result,
        };
        if (parsed.value.command === 'playback.getStreamSnapshot' && !validateIpcResponseForCommand(response, 'playback.getStreamSnapshot').ok) {
          throw new Error('Core播放流回执无效');
        }
        if (isLibraryReadCommand(parsed.value.command)) emitLibraryReadTrace(options.libraryReadTrace, { stage: 'core.return', coreReadId: parsed.value.id, command: parsed.value.command, outcome: 'ok' });
        port.postMessage(response);
        recorder?.mark('ipc', 'response-sent', span?.context, {}, { command: parsed.value.command });
        if (parsed.value.command === 'core.shutdown' && options.exitAfterShutdown) {
          setImmediate(() => process.exit(0));
        }
      } catch (error) {
        if (isLibraryReadCommand(parsed.value.command)) emitLibraryReadTrace(options.libraryReadTrace, { stage: 'core.return', coreReadId: parsed.value.id, command: parsed.value.command, ...libraryReadTraceFailure(error) });
        port.postMessage(error instanceof DatasetOwnerDispatchError
          ? { ...error.failure, id: parsed.value.id }
          : failureForError(parsed.value.id, error, parsed.value.command));
      }
    })();
  });
  port.start();
  await runtime.start();
  await options.beforeReady?.();
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

export type DatasetOwnerFactory = (options: {
  projection: DatasetOwnerProjectionHandler;
  onFatal: (error: unknown) => void;
}) => DatasetOwnerEndpoint;

/** 仅同进程可信源码提供；不能由环境或父端口选择。 */
export type RustReadonlyCoreFactory = () => Promise<RustReadonlyCoreOptions>;
const RUST_RESOURCE_ADMISSION_TIMEOUT_MS = 5_000;

function admittedRustFactoryOptions(value: unknown): RustReadonlyCoreOptions {
  const plain = (object: unknown): object is Record<string, unknown> => {
    if (object === null || typeof object !== 'object' || types.isProxy(object) || Array.isArray(object)) return false;
    const prototype = Object.getPrototypeOf(object);
    return prototype === Object.prototype || prototype === null;
  };
  if (!plain(value)) throw new Error('可信 Rust 资源配置无效。');
  const allowed = ['binary', 'snapshotProfile', 'requestTimeoutMs', 'closeTimeoutMs', 'startupTimeoutMs', 'onFatal', 'onObservation'];
  const keys = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value);
  if (!keys.includes('binary') || keys.some(key => typeof key !== 'string' || !allowed.includes(key))
    || Object.values(descriptors).some(field => !field.enumerable || !Object.hasOwn(field, 'value'))) {
    throw new Error('可信 Rust 资源配置无效。');
  }
  const binary = descriptors.binary!.value as unknown;
  if (!plain(binary)) throw new Error('可信 Rust 资源配置无效。');
  const binaryKeys = Reflect.ownKeys(binary), binaryFields = Object.getOwnPropertyDescriptors(binary);
  if (binaryKeys.length !== 2 || binaryKeys.some(key => key !== 'path' && key !== 'sha256')
    || Object.values(binaryFields).some(field => !field.enumerable || !Object.hasOwn(field, 'value'))
    || typeof binaryFields.path?.value !== 'string' || typeof binaryFields.sha256?.value !== 'string') {
    throw new Error('可信 Rust 资源配置无效。');
  }
  const binaryPath = binaryFields.path.value as string, binarySha = binaryFields.sha256.value as string;
  if (!path.isAbsolute(binaryPath) || binaryPath.length > 1024 || binaryPath.includes('\0') || !/^[a-f0-9]{64}$/.test(binarySha)) {
    throw new Error('可信 Rust 资源配置无效。');
  }
  validateRustSnapshotProfile(descriptors.snapshotProfile?.value);
  for (const key of ['startupTimeoutMs', 'requestTimeoutMs', 'closeTimeoutMs']) {
    const budget = descriptors[key]?.value;
    if (budget !== undefined && (!Number.isSafeInteger(budget) || budget < 1 || budget > 30_000)) {
      throw new Error('可信 Rust 资源配置无效。');
    }
  }
  for (const key of ['onFatal', 'onObservation']) {
    const callback = descriptors[key]?.value;
    if (callback !== undefined && (typeof callback !== 'function' || types.isProxy(callback))) {
      throw new Error('可信 Rust 资源配置无效。');
    }
  }
  // 首次交付前固定数据字段；后续修改工厂返回对象不能替换在途身份。
  return Object.freeze({ ...value, binary: Object.freeze({ path: binaryPath, sha256: binarySha }) }) as RustReadonlyCoreOptions;
}

async function admitRustReadonlyFactory(factory: RustReadonlyCoreFactory): Promise<RustReadonlyCoreOptions> {
  const deadline = performance.now() + RUST_RESOURCE_ADMISSION_TIMEOUT_MS;
  const work = Promise.resolve().then(factory);
  // 超时只终止准入；迟到拒绝仍被消费，迟到成功不能接着创建来源。
  void work.catch(() => {});
  let timer!: NodeJS.Timeout;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('可信 Rust 资源准入超时。')), RUST_RESOURCE_ADMISSION_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([work, timeout]);
    if (performance.now() >= deadline) throw new Error('可信 Rust 资源准入超时。');
    return admittedRustFactoryOptions(result);
  } finally { clearTimeout(timer); }
}

export async function runCoreUtilityProcess(
  env: NodeJS.ProcessEnv = process.env,
  createRecordingConverter?: () => Promise<FfmpegConverter | undefined>,
  createRecordingOutputHelper?: () => Promise<PinnedOutputHelper | undefined>,
  createRecordingDeviceOutputHelper?: () => Promise<PinnedDeviceOutputHelper | undefined>,
  recordingGateBCandidate?: GateBCandidateIdentity | null,
  createDatasetOwner?: DatasetOwnerFactory,
  rustReadonlyCollection?: RustReadonlyCoreOptions,
  onRustReadonlyCoreController?: (controller: RustReadonlyCoreController) => void,
  createRustReadonlyCollection?: RustReadonlyCoreFactory,
): Promise<void> {
  const traceEnabled = isLibraryReadTraceEnabled(env, env.NODE_ENV === 'development' && env.MUSIC_BRIDGE_CORE_TEST_MODE !== '1');
  const libraryReadTrace = traceEnabled ? createLibraryReadTraceWriter({ enabled: true, write: line => { process.stdout.write(line); } }) : undefined;
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
      let datasetOwnerEndpoint: DatasetOwnerEndpoint | undefined;
      let ownerIdentity: DatasetOwnerIdentity | undefined;
      let runtime: CoreRuntime | undefined;
      let runtimeShutdown: Promise<void> | undefined;
      let resolvedRustReadonlyCollection = rustReadonlyCollection;
      let projectionGateway: ReturnType<typeof createDatasetRoonProjectionGateway> | undefined;
      try {
        if (!isRecord(event.data) || event.data.type !== 'musicbridge.core.port' ||
          Object.keys(event.data).some(key => !['type', 'playbackEventProtocol'].includes(key)) ||
          (event.data.playbackEventProtocol !== undefined && event.data.playbackEventProtocol !== 'compact-v1')) {
          throw new Error('Core启动播放事件协议无效');
        }
        const playbackEventProtocol = event.data.playbackEventProtocol === 'compact-v1' ? 'compact-v1' as const : undefined;
        const playbackOptions = playbackEventProtocol ? { playbackEventProtocol } : {};
        const onEvent = (message: CoreRuntimeEvent) => { if (message.event !== 'core.ready') port.postMessage(message); };
        if (onRustReadonlyCoreController !== undefined
          && (typeof onRustReadonlyCoreController !== 'function' || rustReadonlyCollection === undefined && createRustReadonlyCollection === undefined)) {
          throw new Error('Rust 主机控制需要显式只读配置与同步回调。');
        }
        if (createRustReadonlyCollection !== undefined
          && (typeof createRustReadonlyCollection !== 'function' || types.isProxy(createRustReadonlyCollection) || rustReadonlyCollection !== undefined)) {
          throw new Error('可信 Rust 资源工厂无效或配置冲突。');
        }
        if ((rustReadonlyCollection !== undefined || createRustReadonlyCollection !== undefined) && !createDatasetOwner) {
          throw new Error('Rust 只读配置需要显式 Dataset Owner 工厂。');
        }
        if (createRustReadonlyCollection !== undefined) resolvedRustReadonlyCollection = await admitRustReadonlyFactory(createRustReadonlyCollection);
        if (createDatasetOwner) {
          const dataDirectory = env.MUSIC_BRIDGE_DATA_DIRECTORY;
          if (!dataDirectory || dataDirectory.length > 1024 || !path.isAbsolute(dataDirectory) || dataDirectory.includes('\0')) throw new Error('Core数据目录不可用。');
          projectionGateway = createDatasetRoonProjectionGateway(() => runtime?.getDatasetRoonLibrary?.(), {
            isCurrentOwner: epoch => ownerIdentity?.epoch === epoch,
          });
          const project = async (command: DatasetProjectionCommand, payload: DatasetProjectionCommandPayloads[DatasetProjectionCommand], context: { epoch: string; datasetId?: string }): Promise<unknown> => {
            if (command === 'scanReadAcquire' || command === 'scanReadWatchRevocation' || command === 'scanReadRelease') {
              if (!isDatasetProjectionPayload(command, payload) || !ownerIdentity || context.epoch !== ownerIdentity.epoch
                || context.datasetId !== ownerIdentity.datasetId) throw new DatasetOwnerDispatchError(responseFailure(context.epoch, 'NOT_READY', '扫描读取私有来源已失效。'));
              const admission = runtime?.getDatasetScanReadAdmission?.();
              if (!admission || context.datasetId === undefined) throw new DatasetOwnerDispatchError(responseFailure(context.epoch, 'NOT_READY', '扫描读取准入尚未就绪。'));
              const scope = { epoch: context.epoch, datasetId: context.datasetId };
              if (command === 'scanReadAcquire') return admission.acquire(scope);
              const permitId = (payload as { permitId: string }).permitId;
              return command === 'scanReadWatchRevocation' ? admission.watchRevocation(scope, permitId) : admission.release(scope, permitId);
            }
            return projectionGateway!.handler(command, payload as DatasetProjectionCommandPayloads[typeof command], context);
          };
          const source = createDatasetOwner({ projection: project as DatasetOwnerProjectionHandler, onFatal: () => {
            runtime?.getDatasetScanReadAdmission?.().close();
            projectionGateway?.close();
            datasetOwnerEndpoint?.sealLocalSources?.();
            // 先封派发，再join自有FD；退出不能抢在阻塞读取静止之前。
            if(runtime)void runtime.shutdown().then(()=>process.exit(72),()=>process.exit(72));else process.exit(72);
          } });
          // 在能力准入前登记来源；同步拒绝配置时也必须清理已创建的 Node Owner。
          datasetOwnerEndpoint = source;
          // 私有快照能力属于原始来源；不可先经既有 IPC 包装而丢失能力。
          const rustClient = resolvedRustReadonlyCollection === undefined ? undefined
            : createRustReadonlyCoreDatasetOwner(source, resolvedRustReadonlyCollection);
          const client = rustClient ?? source;
          datasetOwnerEndpoint = {
            prepare: async () => { ownerIdentity = await client.prepare(); return ownerIdentity; },
            dispatch: request => client.dispatch(request),
            ...(client.dispatchInternal === undefined ? {} : {
              dispatchInternal: (request: IpcRequest) => client.dispatchInternal!(request),
            }),
            ...(client.materializeMBEdition?{materializeMBEdition:(request:import('@music-bridge/contracts').MBEditionQueueRequest)=>client.materializeMBEdition!(request)}:{}),
            ...(client.loadMBQueue ? { loadMBQueue: () => client.loadMBQueue!() } : {}),
            ...(client.saveMBQueue ? { saveMBQueue: (request: import('@music-bridge/contracts').MBQueueSaveRequest) => client.saveMBQueue!(request) } : {}),
            ...(client.captureLocalSource?{captureLocalSource: (selection:import('@music-bridge/contracts').LocalPlayRequest)=>client.captureLocalSource!(selection)}:{}),
            ...(client.revalidateLocalSource?{revalidateLocalSource:(ticket:string)=>client.revalidateLocalSource!(ticket)}:{}),
            ...(client.releaseLocalSource?{releaseLocalSource:(ticket:string)=>client.releaseLocalSource!(ticket)}:{}),
            ...(client.sealLocalSources?{sealLocalSources:()=>client.sealLocalSources!()}:{}),
            ...(client.isLocalSourceCurrent?{isLocalSourceCurrent:()=>client.isLocalSourceCurrent!()}:{}),
            commitBoot: () => client.commitBoot(),
            close: async () => {
              runtime?.getDatasetScanReadAdmission?.().close();
              try { await client.close(); } finally { projectionGateway?.close(); }
            },
          };
          if (rustClient && onRustReadonlyCoreController) {
            // 先登记清理端点再同步交付能力；宿主不能借回调延长启动期限。
            const returned: unknown = onRustReadonlyCoreController(createRustReadonlyCoreController(rustClient));
            if (returned !== undefined) {
              // void 回调也可能意外返回 Promise；消费拒绝，但不等待或准入异步回调。
              void Promise.resolve(returned).catch(() => {});
              throw new Error('Rust 主机控制回调必须同步返回空值。');
            }
          }
          await datasetOwnerEndpoint.prepare();
          const onRoonTimeShape = createRoonTimeShapeRecorder(env);
          const onRoonBrowseShape = createRoonBrowseShapeRecorder(env);
          const onRoonImageShape = createRoonImageShapeRecorder(env);
          runtime = env.MUSIC_BRIDGE_CORE_TEST_MODE === '1'
            ? createTestBridgeRuntime({ ...playbackOptions, onEvent, datasetOwnerEndpoint,
                ...(env.MUSIC_BRIDGE_UI_E2E === '1' && env.MUSIC_BRIDGE_SYNTHETIC_ROON_LIBRARY === '1' ? { roonLibrary: createSyntheticRoonLibrary() } : {}),
                authorized: env.MUSIC_BRIDGE_UI_E2E === '1',
                ...(env.MUSIC_BRIDGE_SYNTHETIC_ACCOUNT_MODE === 'profile-unavailable' || env.MUSIC_BRIDGE_SYNTHETIC_ACCOUNT_MODE === 'expired' ? { accountMode: env.MUSIC_BRIDGE_SYNTHETIC_ACCOUNT_MODE } : {}) })
            : createBridgeRuntime({ ...playbackOptions, onEvent, datasetOwnerEndpoint,
                lyricsMatchRepository: createLyricsMatchRepository({ filePath: path.join(dataDirectory, 'lyrics-matches.v1.json') }),
                ...(onRoonTimeShape ? { onRoonTimeShape } : {}),
                ...(onRoonBrowseShape ? { onRoonBrowseShape } : {}),
                ...(onRoonImageShape ? { onRoonImageShape } : {}) });
        } else {
        const recordingConverter = await createRecordingConverter?.();
        const recordingOutputHelper = await createRecordingOutputHelper?.();
        const recordingDeviceOutputHelper = await createRecordingDeviceOutputHelper?.();
        const dataDirectory = env.MUSIC_BRIDGE_DATA_DIRECTORY;
        if (dataDirectory !== undefined && (!dataDirectory || dataDirectory.length > 1024 || !path.isAbsolute(dataDirectory) || dataDirectory.includes('\0'))) throw new Error('Core 数据目录不可用');
        if (dataDirectory) dataset = await openCollectionDataset(dataDirectory);
        let outputRunRecovery: OutputRunRecoveryState | undefined;
        if (dataset && env.MUSIC_BRIDGE_CORE_TEST_MODE !== '1') {
          try {
            outputRunRecovery = await reconcileOutputRunRecovery({ databaseFile: dataset.databaseFile,
              datasetId: dataset.datasetId, rows: dataset.repository.recordingAttempts.outputRunRecoveryRows(),
              ...(recordingDeviceOutputHelper ? { pin: recordingDeviceOutputHelper } : {}),
              assertCurrent: () => dataset!.assertIdentity(),
              persistQuiet: row => dataset!.repository.recordingAttempts.persistRevokedOutputRunQuiet(row) });
          } catch {
            // 冷启历史或SQLite读取不明时只封设备，不把V2和历史浏览一并关停。
            outputRunRecovery = { safe: false, pendingRuns: 0, reason: 'OUTPUT_RUN_UNVERIFIED' };
          }
        }
        const datasetOptions = dataset ? {
          collectionDatasetIdentity: { datasetId: dataset.datasetId, assertCurrent: () => dataset!.assertIdentity() },
          collectionRepository: dataset.repository,
          backupWorkflowStore: dataset.store,
          backupPrivateRoot: dataset.privateRoot,
          ...(dataset.contentBinding ? { backupContentBinding: dataset.contentBinding } : {}),
        } : {};
        runtime =
          env.MUSIC_BRIDGE_CORE_TEST_MODE === '1'
            ? createTestBridgeRuntime({
                ...playbackOptions,
                onEvent,
                ...(recordingConverter ? { recordingConverter } : {}),
                ...(recordingOutputHelper ? { recordingOutputHelper } : {}),
                ...(recordingDeviceOutputHelper ? { recordingDeviceOutputHelper } : {}),
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
                  ...playbackOptions,
                  ...(recordingConverter ? { recordingConverter } : {}),
                ...(recordingOutputHelper ? { recordingOutputHelper } : {}),
                ...(recordingDeviceOutputHelper ? { recordingDeviceOutputHelper } : {}),
                recordingGateBCandidate: recordingGateBCandidate ?? null,
                ...(dataset ? { recordingLeaseDatabaseFile: dataset.databaseFile } : {}),
                ...(outputRunRecovery ? { recordingOutputRunRecovery: outputRunRecovery } : {}),
                  ...datasetOptions,
                  lyricsMatchRepository: createLyricsMatchRepository({
                    filePath: path.join(dataDirectory, 'lyrics-matches.v1.json'),
                  }),
                  ...(onRoonTimeShape ? { onRoonTimeShape } : {}),
                  ...(onRoonBrowseShape ? { onRoonBrowseShape } : {}),
                  ...(onRoonImageShape ? { onRoonImageShape } : {}),
                  onEvent,
                });
              })();
        }
        if (resolvedRustReadonlyCollection !== undefined) {
          const shutdown = runtime.shutdown.bind(runtime);
          // 原 shutdown 的完成包含控制面清理和 stopped 状态；Owner close 完成不能代替它。
          runtime.shutdown = () => runtimeShutdown ??= shutdown();
        }
        await attachCoreRuntimePort(port, runtime, { exitAfterShutdown: true, beforeReady: async () => { if(datasetOwnerEndpoint)await datasetOwnerEndpoint.commitBoot();else await dataset?.commit();await runtime!.restoreLogicalQueue?.(); }, ...(libraryReadTrace ? { libraryReadTrace } : {}) });
        if (isCrashProbeEnabled(env)) {
          const configuredDelay = Number(env.MUSIC_BRIDGE_CORE_CRASH_DELAY_MS);
          const delayMs = Number.isSafeInteger(configuredDelay) && configuredDelay >= 25
            ? Math.min(configuredDelay, 5_000)
            : 25;
          setTimeout(() => process.exit(71), delayMs);
        }
      } catch {
        let cleanupSucceeded = false;
        try { await datasetOwnerEndpoint?.close(); cleanupSucceeded = true; } catch { /* 保留未确认关闭，不把启动失败冒充静止。 */ }
        projectionGateway?.close();
        dataset?.fail();
        dataset?.close();
        // 显式组合在正常 shutdown 时会封闭尚未完成的 boot；已确认 stopped 由原 attach 正常退出。
        let shutdownSucceeded = false;
        if (resolvedRustReadonlyCollection !== undefined && runtimeShutdown) {
          try { await runtimeShutdown; shutdownSucceeded = true; } catch { /* shutdown 失败仍按启动失败退出。 */ }
        }
        if (resolvedRustReadonlyCollection !== undefined && cleanupSucceeded && shutdownSucceeded && runtime?.getState().runtime === 'stopped') return;
        process.exitCode = 1;
        process.exit(1);
      }
    })();
  });
}

export { parseIpcRuntimeMessage };
