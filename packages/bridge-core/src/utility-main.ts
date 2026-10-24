import { createMobileOwnerLoadTraceContext, withMobileOwnerLoadTrace, markMobileOwnerLoadTrace, observeMobileOwnerLoadTrace } from './mobile/owner-load-trace.js';
import { createMobileRangeWindowCoreReceiver } from './mobile/range-window-observer.js';
import { captureLocalAlbumContext, withLocalAlbumContext, runLocalAlbumContext, localAlbumPhase, localAlbumMatch, localAlbumReject, localAlbumRejectCode, emitLocalAlbumNodeTrace, type LocalAlbumNodeContext } from './shared/local-album-read-trace-node.js';
import { isDatasetNameProviderCommand, captureDatasetNameProviderRequest, captureDatasetNameProviderReply, assertDatasetNameProviderReplyForRequest, DatasetNameProviderBridgeError, type DatasetNameProviderCommand, type DatasetNameProviderRequest } from './collection/dataset-owner-protocol.js';
import { isDatasetWorkbenchNativeConfiguration, captureDatasetWorkbenchNativeConfiguration, type DatasetWorkbenchNativeConfiguration, isDatasetWorkbenchOwnerRequest, isDatasetWorkbenchOwnerResult, isDatasetWorkbenchOwnerScope, type DatasetWorkbenchOwnerRequest, type DatasetWorkbenchOwnerResult, type DatasetWorkbenchOwnerCommand, type DatasetWorkbenchOwnerPayloads, type DatasetWorkbenchOwnerResults, DATASET_WORKBENCH_BOUNDS, datasetWorkbenchRequestMs, datasetWorkbenchExecutionDeadline, isDatasetWorkbenchContextKind, isDatasetWorkbenchContext, isDatasetWorkbenchRequest, isDatasetWorkbenchResult, isDatasetWorkbenchFrame, datasetWorkbenchMeta, sameDatasetWorkbenchMeta, datasetWorkbenchJson, datasetWorkbenchSha, datasetWorkbenchFrames, datasetWorkbenchControl, createDatasetWorkbenchAssembler, DatasetWorkbenchWireError, type DatasetWorkbenchMeta, type DatasetWorkbenchRequest } from './collection/dataset-owner-protocol.js';
import { isLocalArtworkCommand, isLocalArtworkInternalCommand, isLocalRelocationCommand, isLocalRelocationInternalCommand } from '@music-bridge/contracts';
import { isLocalCatalogCommand, isLocalCatalogInternalCommand, isLocalScanCommand, isLocalScanInternalCommand, validateIpcInternalRequest } from '@music-bridge/contracts';
import { dispatchDatasetCommand, dispatchInternalDatasetCommand } from './collection/dataset-dispatch.js';
import { createDatasetRoonProjectionGateway } from './collection/dataset-roon-projection.js';
import { isDatasetProjectionPayload, type DatasetProjectionCommand, type DatasetProjectionCommandPayloads, isDatasetCommand, DatasetOwnerDispatchError, DatasetOwnerTransportError, type DatasetOwnerEndpoint, type DatasetOwnerIdentity, type DatasetOwnerProjectionHandler } from './collection/dataset-owner-protocol.js';
import { isDatasetLyricsProviderCommand, captureDatasetLyricsProviderRequest, captureDatasetLyricsProviderReply, assertDatasetLyricsProviderReplyForRequest, DatasetLyricsProviderBridgeError,
  type DatasetLyricsProviderCommand, type DatasetLyricsProviderRequest, type DatasetProjectionCommandResults } from './collection/dataset-owner-protocol.js';
import { randomUUID } from 'node:crypto';
import { failureForError, responseFailure } from './shared/ipc-failure.js';
import { isMobileOwnerPrivateResult } from './mobile/owner-protocol.js';
import { copyCatalogTraceSeed, catalogTraceNonce, withCatalogTrace, withCatalogTraceScope, catalogTraceAsync, catalogTraceEvent } from './mobile/catalog-private-trace.js';
import { readMobileCorePrivateCallForCapture } from './mobile/owner-boundary-capture.js';
import { attachMobileSealedCoreReceiver, encodeMobileSealedCoreReply } from './mobile/sealed-request-transport.js';
import { MobileAuthPersistenceError, MobileServiceError, type MobileOwnerPrivateFailure, type MobileOwnerPrivateResult } from './mobile/types.js';
import { captureMobileContentCoreRequest, captureMobileContentCoreResponse, mobileContentRpcFailure, MOBILE_CONTENT_RPC_BOUNDS,
  mobileContentLateResponseAllowed, type MobileContentCoreRequest, type MobileContentCoreResponse, type MobileContentCoreSettlementObserver } from './mobile/content-rpc.js';
import { LibraryReadRegistry } from './shared/library-read-registry.js';
import { runLibraryShutdownStep } from './shared/library-shutdown-log.js';
import { createCoreShutdownReceipt } from './shared/core-shutdown-receipt.js';
import { logLibraryOperation } from './shared/library-operation-log.js';
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
import type { MessagePort } from 'node:worker_threads';
import { createUtilitySourceWritesBridge, type SourceWritesUtilityPort } from './shared/source-writes-utility-port.js';
import { createUtilityRelocationBridge, LOCAL_RELOCATION_MAIN_PORT_BOOTSTRAP, type RelocationUtilityPort } from './shared/source-relocation-utility-port.js';
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
import { isLocalAlbumArtworkMainRequest, isLocalAlbumArtworkMainReply, localAlbumArtworkMainCancel, localAlbumArtworkMainReference, type LocalAlbumArtworkMainReference, type LocalAlbumArtworkMainRequest, isLocalAlbumMainRequest, isLocalAlbumMainResponse, localAlbumMainFailure, type LocalAlbumMainResponse } from './collection/local-album-browser/main-protocol.js';
import { createRustReadonlyCoreDatasetOwner, type RustReadonlyCoreOptions } from './rust-core/core-dataset-owner.js';
import { createRustReadonlyCoreController, type RustReadonlyCoreController } from './rust-core/host-controller.js';
import { validateRustSnapshotProfile } from './rust-core/readonly-sidecar.js';

export interface UtilityPort {
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown;
  start(): void;
  postMessage(message: unknown): void;
}

/** 私有五源反向RPC只经原Main物理port；不是任意HTTP或新的general工厂。 */
export function createUtilityLyricsProviderBridge(port:UtilityPort,current:()=>DatasetOwnerIdentity|undefined,onFatal:()=>void,sharedPending:()=>number=()=>0){
  let sequence=0,closed=false;
  const pending=new Map<string,{request:DatasetLyricsProviderRequest;timer:ReturnType<typeof setTimeout>;resolve:(value:unknown)=>void;reject:(error:unknown)=>void}>(),expired=new Set<string>();
  const fail=(error:unknown)=>{closed=true;for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(error);}pending.clear();};
  port.on('message',event=>{
    if(!isRecord(event.data)||Object.getOwnPropertyDescriptor(event.data,'type')?.value!=='musicbridge.lyrics.provider-reply'||closed)return;
    try{const reply=captureDatasetLyricsProviderReply(event.data),entry=pending.get(reply.requestId);
      if(!entry){if(expired.has(reply.requestId)){expired.delete(reply.requestId);return;}throw new DatasetLyricsProviderBridgeError('INVALID_RESPONSE');}
      assertDatasetLyricsProviderReplyForRequest(reply,entry.request);const identity=current();if(identity?.epoch!==entry.request.epoch||identity.datasetId!==entry.request.datasetId)throw new DatasetLyricsProviderBridgeError('NOT_READY');
      clearTimeout(entry.timer);pending.delete(reply.requestId);if(reply.ok)entry.resolve(reply.result);else entry.reject(new DatasetLyricsProviderBridgeError(reply.failure));
    }catch(error){fail(error);onFatal();}
  });
  return {
    call<K extends DatasetLyricsProviderCommand>(command:K,payload:DatasetProjectionCommandPayloads[DatasetLyricsProviderCommand],scope:{epoch:string;datasetId?:string}):Promise<DatasetProjectionCommandResults[K]>{
      const identity=current();if(closed||!identity||identity.epoch!==scope.epoch||identity.datasetId!==scope.datasetId)return Promise.reject(new DatasetLyricsProviderBridgeError('NOT_READY'));
      if(pending.size+sharedPending()>=DATASET_WORKBENCH_BOUNDS.pending)return Promise.reject(new DatasetLyricsProviderBridgeError('BUDGET'));
      const request=captureDatasetLyricsProviderRequest({version:1,type:'musicbridge.lyrics.provider-request',requestId:randomUUID(),sequence:++sequence,epoch:identity.epoch,datasetId:identity.datasetId,command,payload,expiresAtMs:Date.now()+2000});
      return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(request.requestId);if(expired.size>=32){fail(new DatasetLyricsProviderBridgeError('TIMEOUT'));onFatal();return;}expired.add(request.requestId);reject(new DatasetLyricsProviderBridgeError('TIMEOUT'));},2000);
        pending.set(request.requestId,{request,timer,resolve:value=>resolve(value as DatasetProjectionCommandResults[K]),reject});
        try{port.postMessage(request);}catch(error){clearTimeout(timer);pending.delete(request.requestId);reject(error);fail(error);onFatal();}
      });
    },
    pending(){return pending.size},
    close(){fail(new DatasetLyricsProviderBridgeError('NOT_READY'));expired.clear();},
  };
}

/** 原 Owner 只读图片副本经 Main 实际解码；timeout/close 只取消本次有限请求。 */
export function createUtilityLocalAlbumArtworkBridge(port:UtilityPort,current:()=>DatasetOwnerIdentity|undefined,onFatal:()=>void) {
  let sequence=0,closed=false;
  const pending=new Map<string,{request:LocalAlbumArtworkMainRequest;timer:ReturnType<typeof setTimeout>;resolve:(value:DatasetProjectionCommandResults['normalizeLocalAlbumArtwork'])=>void;reject:(error:unknown)=>void;detach():void}>();
  const expired=new Map<string,LocalAlbumArtworkMainReference>();
  const error=(id:string,code:'NOT_READY'|'TIMEOUT'|'CANCELLED'|'INVALID_IPC_REQUEST'|'INVALID_IPC_RESPONSE')=>new DatasetOwnerDispatchError(responseFailure(id,code,'原专辑封面规范化未确认。'));
  const cancel=(request:LocalAlbumArtworkMainRequest)=>{try{port.postMessage(localAlbumArtworkMainCancel(request));}catch{onFatal();}};
  const fail=(reason:unknown)=>{closed=true;for(const entry of pending.values()){clearTimeout(entry.timer);entry.detach();cancel(entry.request);entry.reject(reason);}pending.clear();};
  port.on('message',event=>{
    if(!isRecord(event.data)||Object.getOwnPropertyDescriptor(event.data,'type')?.value!=='local-album-artwork-main-response'||closed)return;
    try {
      const id=Object.getOwnPropertyDescriptor(event.data,'id')?.value,entry=typeof id==='string'?pending.get(id):undefined;
      const request=entry?.request??(typeof id==='string'?expired.get(id):undefined);
      if(!request||!isLocalAlbumArtworkMainReply(event.data,request))throw error(typeof id==='string'?id:randomUUID(),'INVALID_IPC_RESPONSE');
      if(!entry){expired.delete(request.id);return;}
      const active=entry.request,identity=current();clearTimeout(entry.timer);entry.detach();pending.delete(active.id);
      if(identity?.epoch!==active.projection.epoch||identity.datasetId!==active.datasetId){entry.reject(error(active.id,'NOT_READY'));return;}
      if(Date.now()>=active.expiresAtMs){cancel(active);entry.reject(error(active.id,'TIMEOUT'));return;}
      if(event.data.projection.ok)entry.resolve(event.data.projection.result as DatasetProjectionCommandResults['normalizeLocalAlbumArtwork']);
      else entry.reject(new DatasetOwnerDispatchError(event.data.projection.failure));
    } catch(reason){fail(reason);onFatal();}
  });
  return {
    call(payload:DatasetProjectionCommandPayloads['normalizeLocalAlbumArtwork'],scope:{epoch:string;datasetId?:string;signal?:AbortSignal;deadlineAtMs?:number;expiresAtMs?:number}):Promise<DatasetProjectionCommandResults['normalizeLocalAlbumArtwork']> {
      const identity=current(),id=randomUUID();
      if(closed||!identity||identity.epoch!==scope.epoch||identity.datasetId!==scope.datasetId)return Promise.reject(error(id,'NOT_READY'));
      if(pending.size>=4||sequence>=Number.MAX_SAFE_INTEGER)return Promise.reject(error(id,'NOT_READY'));
      const remaining=Math.min(2000,Math.floor((scope.deadlineAtMs??performance.now()+2000)-performance.now()));
      if(scope.signal?.aborted||remaining<=0)return Promise.reject(error(id,'TIMEOUT'));
      const expiresAtMs=Math.min(Date.now()+remaining,scope.expiresAtMs??Number.MAX_SAFE_INTEGER);
      const raw={version:1,type:'local-album-artwork-main-request',id,sequence:++sequence,datasetId:identity.datasetId,expiresAtMs,
        projection:{version:1,type:'projection',epoch:identity.epoch,projectionRequestId:id,command:'normalizeLocalAlbumArtwork',payload}};
      if(!isLocalAlbumArtworkMainRequest(raw))return Promise.reject(error(id,'INVALID_IPC_REQUEST'));
      const request=structuredClone(raw);
      return new Promise((resolve,reject)=>{
        const expire=(code:'TIMEOUT'|'CANCELLED')=>{const entry=pending.get(id);if(!entry)return;clearTimeout(entry.timer);entry.detach();pending.delete(id);cancel(request);if(expired.size>=32){fail(error(id,'TIMEOUT'));onFatal();}else expired.set(id,localAlbumArtworkMainReference(request));reject(error(id,code));};
        const abort=()=>expire('CANCELLED'),detach=()=>scope.signal?.removeEventListener('abort',abort),timer=setTimeout(()=>expire('TIMEOUT'),Math.max(1,request.expiresAtMs-Date.now()));
        pending.set(id,{request,timer,resolve,reject,detach});scope.signal?.addEventListener('abort',abort,{once:true});
        try{port.postMessage(request);if(scope.signal?.aborted)abort();}catch(reason){clearTimeout(timer);detach();pending.delete(id);reject(reason);fail(reason);onFatal();}
      });
    },
    close(){fail(error(randomUUID(),'NOT_READY'));expired.clear();},
    pending(){return pending.size},
  };
}

/** NAME独立有限RPC保持原Owner接收2s；模型运行期限由原Start另行冻结。 */
export function createUtilityNameProviderBridge(port:UtilityPort,current:()=>DatasetOwnerIdentity|undefined,onFatal:()=>void,sharedPending:()=>number=()=>0){
  let sequence=0,closed=false,authority:{id:string;generation:number}|undefined;
  const pending=new Map<string,{request:DatasetNameProviderRequest;timer:ReturnType<typeof setTimeout>;resolve:(value:unknown)=>void;reject:(error:unknown)=>void}>(),expired=new Set<string>(),started=new Set<string>();
  const fail=(error:unknown)=>{closed=true;for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(error);}pending.clear();};
  port.on('message',event=>{
    if(!isRecord(event.data)||Object.getOwnPropertyDescriptor(event.data,'type')?.value!=='musicbridge.name.provider-reply'||closed)return;
    try{const reply=captureDatasetNameProviderReply(event.data),entry=pending.get(reply.requestId);
      if(!entry){if(expired.has(reply.requestId)){expired.delete(reply.requestId);return;}throw new DatasetNameProviderBridgeError('INVALID_RESPONSE');}
      assertDatasetNameProviderReplyForRequest(reply,entry.request);const identity=current();if(identity?.epoch!==entry.request.epoch||identity.datasetId!==entry.request.datasetId)throw new DatasetNameProviderBridgeError('NOT_READY');
      if(authority&&(reply.authorityId!==authority.id||reply.childGeneration!==authority.generation))throw new DatasetNameProviderBridgeError('NOT_READY');
      if(reply.ok){if(!authority){if(reply.authorityId===null||reply.childGeneration===null)throw new DatasetNameProviderBridgeError('INVALID_RESPONSE');authority={id:reply.authorityId,generation:reply.childGeneration};}
        if(entry.request.command==='nameProviderStart')started.add(entry.request.payload.operationId);
        if(entry.request.command==='nameProviderJoin')started.delete(entry.request.payload.operationId);
      }
      clearTimeout(entry.timer);pending.delete(reply.requestId);if(reply.ok)entry.resolve(reply.result);else entry.reject(new DatasetNameProviderBridgeError(reply.failure));
    }catch(error){fail(error);onFatal();}
  });
  return {
    call<K extends DatasetNameProviderCommand>(command:K,payload:DatasetProjectionCommandPayloads[K],scope:{epoch:string;datasetId?:string}):Promise<DatasetProjectionCommandResults[K]>{
      const identity=current();if(closed||!identity||identity.epoch!==scope.epoch||identity.datasetId!==scope.datasetId||command==='nameProviderRead'&&!started.has(payload.operationId))return Promise.reject(new DatasetNameProviderBridgeError('NOT_READY'));
      if(pending.size+sharedPending()>=DATASET_WORKBENCH_BOUNDS.pending)return Promise.reject(new DatasetNameProviderBridgeError('BUDGET'));
      const request=captureDatasetNameProviderRequest({version:1,type:'musicbridge.name.provider-request',requestId:randomUUID(),sequence:++sequence,epoch:identity.epoch,datasetId:identity.datasetId,authorityId:authority?.id??null,childGeneration:authority?.generation??null,command,payload,expiresAtMs:Date.now()+DATASET_WORKBENCH_BOUNDS.requestMs});
      return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(request.requestId);if(expired.size>=32){fail(new DatasetNameProviderBridgeError('TIMEOUT'));onFatal();return;}expired.add(request.requestId);reject(new DatasetNameProviderBridgeError('TIMEOUT'));},DATASET_WORKBENCH_BOUNDS.requestMs);
        pending.set(request.requestId,{request,timer,resolve:value=>resolve(value as DatasetProjectionCommandResults[K]),reject});
        try{port.postMessage(request);}catch(error){clearTimeout(timer);pending.delete(request.requestId);reject(error);fail(error);onFatal();}
      });
    },
    pending(){return pending.size},
    close(){fail(new DatasetNameProviderBridgeError('NOT_READY'));expired.clear();started.clear();},
  };
}

export type CoreRuntimeForIpc = CoreRuntime & {
  /** 只由可信Main独立信封调用；不扩大通用IPC或旧Control API。 */
  mobileContentRpc?(request: MobileContentCoreRequest, signal: AbortSignal, onSettled?: MobileContentCoreSettlementObserver): Promise<MobileContentCoreResponse>;
};

interface MessageWithPorts {
  data: unknown;
  ports?: readonly UtilityPort[];
}

interface ParentPortLike {
  once(event: 'message', listener: (event: MessageWithPorts) => void): unknown;
  on?(event: 'message', listener: (event: MessageWithPorts) => void): unknown;
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
    case 'localCatalog.playReceipt':
      if(!runtime.getLocalPlayReceipt)throw new BridgeError('BAD_REQUEST','原点播回执读取尚未就绪。',{httpStatus:409});
      return runtime.getLocalPlayReceipt(request.payload as import('@music-bridge/contracts').LocalPlayRequest);
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
    case 'library.searchSuggestions': return runtime.searchSuggestions((request.payload as { query: string }).query);
    case 'library.artistProfile': return runtime.getArtistProfile((request.payload as { artistId: string }).artistId);
    case 'library.artistAlbums': return runtime.getArtistAlbums((request.payload as { artistId: string }).artistId, (request.payload as { page: { offset: number; limit: number } }).page);
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
  const rangeWindow = createMobileRangeWindowCoreReceiver({ sink: frame => { port.postMessage(frame); } });
  const shutdownReceipt = createCoreShutdownReceipt(port, () => {
    if (!options.exitAfterShutdown) return;
    setImmediate(() => {
      if (!shutdownReceipt.isConfirmed()) return;
      logLibraryOperation('library', 'shutdown.utility-exit', 'progress', { code: 'EXIT_ZERO' });
      process.exit(0);
    });
  });
  let mobileReady = false, mobileClosing = false;
  const mobileFlights = new Set<Promise<void>>();
  const contentFlights = new Map<string, { controller: AbortController; flight: Promise<void> }>();
  type WorkbenchFlight={meta:DatasetWorkbenchMeta;receivedAtMs:number;startedAtMs:number;deadlineAtMs:number;assembly:ReturnType<typeof createDatasetWorkbenchAssembler>;controller:AbortController;timer:NodeJS.Timeout;running:boolean;expired:boolean;task?:Promise<void>;trace?:LocalAlbumNodeContext|undefined;settledContextEndpoint:DatasetOwnerEndpoint|undefined}
  const workbenchFlights=new Map<string,WorkbenchFlight>(),workbenchRetired=new Map<string,DatasetWorkbenchMeta>()
  let workbenchSequence=0
  function wbFailure(item:WorkbenchFlight,code:'INVALID_IPC_REQUEST'|'INVALID_IPC_RESPONSE'|'OUTBOX_SCOPE_MISMATCH'|'NOT_READY'|'TIMEOUT',cause?:{error:unknown}):void{
    if(!item.expired){
      if(isDatasetWorkbenchContextKind(item.meta.kind))try{
        const record=()=>{if(cause)localAlbumReject(cause.error,code);else localAlbumRejectCode(code,code)};
        if(item.trace)withLocalAlbumContext(item.trace,record);
        else runLocalAlbumContext(item.meta.id,null,'context.utility.receive',record,false,false);
      }catch{ /* 观测故障不改变原失败帧。 */ }
      item.expired=true;port.postMessage(datasetWorkbenchControl(item.meta,'failure',code))
    }
  }
  function wbSettle(item:WorkbenchFlight):void{
    clearTimeout(item.timer);workbenchFlights.delete(item.meta.id);workbenchRetired.set(item.meta.id,item.meta)
    if(workbenchRetired.size>1024)workbenchRetired.delete(workbenchRetired.keys().next().value!)
    if(item.expired)port.postMessage(datasetWorkbenchControl(item.meta,'settled'))
  }
  async function wbOriginalContext(meta:DatasetWorkbenchMeta,signal:AbortSignal,deadlineAtMs:number){
    const endpoint=runtime.datasetOwnerEndpoint
    if(isDatasetWorkbenchContextKind(meta.kind))try{localAlbumPhase(!mobileReady||mobileClosing?'context.utility.ready':'context.utility.endpoint')}catch{}
    if(!mobileReady||mobileClosing||!endpoint?.workbenchContext||!endpoint.dispatchWorkbench||!endpoint.dispatchWorkbenchOwner||!endpoint.closeWorkbench||!endpoint.joinWorkbench)throw new DatasetWorkbenchWireError('NOT_READY')
    if(isDatasetWorkbenchContextKind(meta.kind))try{localAlbumPhase('context.utility.prepare')}catch{}
    const prepared=await endpoint.prepare()
    if(runtime.datasetOwnerEndpoint!==endpoint||prepared.datasetId!==meta.datasetId||meta.epoch!==null&&meta.epoch!==prepared.epoch)throw new DatasetWorkbenchWireError('OUTBOX_SCOPE_MISMATCH')
    if(isDatasetWorkbenchContextKind(meta.kind))try{localAlbumPhase('context.utility.owner')}catch{}
    if(meta.kind==='context.identity'&&!endpoint.workbenchReadIdentity)throw new DatasetWorkbenchWireError('NOT_READY')
    const read={signal,deadlineAtMs}
    const identity=await (meta.kind==='context.identity'?endpoint.workbenchReadIdentity!(read):endpoint.workbenchContext(read))
    if(isDatasetWorkbenchContextKind(meta.kind))try{localAlbumPhase('context.utility.endpoint')}catch{}
    if(!isDatasetWorkbenchContext(identity)||identity.datasetId!==prepared.datasetId||identity.epoch!==prepared.epoch||runtime.datasetOwnerEndpoint!==endpoint||mobileClosing||signal.aborted)throw new DatasetWorkbenchWireError('OUTBOX_SCOPE_MISMATCH')
    return {endpoint,identity}
  }
  function wbReceive(raw:unknown):void{
    if(!isDatasetWorkbenchFrame(raw)||raw.lane==='response'||raw.kind==='drain')return
    const receive=()=>{
    let item=workbenchFlights.get(raw.id)
    if(raw.lane==='control'){
      if(item&&sameDatasetWorkbenchMeta(raw,item.meta)){item.controller.abort();wbFailure(item,'TIMEOUT');if(!item.running)wbSettle(item)}
      else {const retired=workbenchRetired.get(raw.id);if(retired&&sameDatasetWorkbenchMeta(raw,retired))port.postMessage(datasetWorkbenchControl(retired,'settled'))}
      return
    }
    if(raw.part==='begin'){
      if(item||workbenchRetired.has(raw.id)||raw.sequence!==workbenchSequence+1)return
      workbenchSequence=raw.sequence
      const meta=datasetWorkbenchMeta(raw),controller=new AbortController(),receivedAtMs=Date.now(),startedAtMs=performance.now(),remaining=Math.min(DATASET_WORKBENCH_BOUNDS.requestMs,meta.expiresAtMs-receivedAtMs)
      const flight:WorkbenchFlight={meta,receivedAtMs,startedAtMs,deadlineAtMs:startedAtMs+remaining,assembly:createDatasetWorkbenchAssembler(meta,'request'),controller,timer:undefined as unknown as NodeJS.Timeout,running:false,expired:false,settledContextEndpoint:undefined}
      if(isDatasetWorkbenchContextKind(meta.kind))try{flight.trace=captureLocalAlbumContext()}catch{ /* 仅旁注。 */ }
      item=flight;workbenchFlights.set(raw.id,flight)
      flight.timer=setTimeout(()=>{controller.abort();wbFailure(flight,'TIMEOUT');if(!flight.running)wbSettle(flight)},Math.max(1,remaining))
      if(remaining<=0||workbenchFlights.size>24){if(isDatasetWorkbenchContextKind(meta.kind))try{localAlbumPhase('context.utility.budget')}catch{}wbFailure(flight,remaining<=0?'TIMEOUT':'NOT_READY');wbSettle(flight);return}
    }
    if(!item||item.running||!sameDatasetWorkbenchMeta(raw,item.meta))return
    if(isDatasetWorkbenchContextKind(item.meta.kind))try{item.trace=captureLocalAlbumContext()}catch{ /* 仅旁注。 */ }
    try{
      const body=item.assembly.accept(raw);if(body===undefined)return
      if(datasetWorkbenchSha(datasetWorkbenchJson(body))!==item.meta.requestSha256||item.meta.kind==='execute'&&!isDatasetWorkbenchRequest(body)||item.meta.kind==='owner'&&!isDatasetWorkbenchOwnerRequest(body)||isDatasetWorkbenchContextKind(item.meta.kind)&&(!isRecord(body)||Reflect.ownKeys(body).length!==0))throw new DatasetWorkbenchWireError('INVALID_IPC_REQUEST')
      const flight=item;flight.deadlineAtMs=datasetWorkbenchExecutionDeadline(item.meta,body,item.receivedAtMs,item.startedAtMs);flight.running=true
      // 空正文身份读通过原闭集和首次时钟核验后，只切换到原expiry的剩余时间；未组装帧仍限2秒。
      if(flight.meta.kind==='context.identity'||flight.meta.kind==='execute'&&datasetWorkbenchRequestMs(body)===DATASET_WORKBENCH_BOUNDS.libraryRemoveMs){
        clearTimeout(flight.timer)
        flight.timer=setTimeout(()=>{flight.controller.abort();wbFailure(flight,'TIMEOUT')},Math.max(1,flight.deadlineAtMs-performance.now()))
      }
      const task:Promise<void>=Promise.resolve().then(async()=>{
        const bound=await wbOriginalContext(flight.meta,flight.controller.signal,flight.deadlineAtMs)
        let result:unknown=bound.identity
        if(flight.meta.kind==='owner'){
          if(!isDatasetWorkbenchOwnerRequest(body)||!isDatasetWorkbenchOwnerScope(body,bound.identity.datasetId))throw new DatasetWorkbenchWireError('OUTBOX_SCOPE_MISMATCH')
          result=await bound.endpoint.dispatchWorkbenchOwner!(structuredClone(body),{identity:{epoch:bound.identity.epoch,datasetId:bound.identity.datasetId},signal:flight.controller.signal,deadlineAtMs:flight.deadlineAtMs})
          const fresh=await wbOriginalContext(flight.meta,flight.controller.signal,flight.deadlineAtMs)
          if(fresh.endpoint!==bound.endpoint||fresh.identity.epoch!==bound.identity.epoch||!isDatasetWorkbenchOwnerResult(body.command,result,body.payload,bound.identity.datasetId))throw new DatasetWorkbenchWireError('INVALID_IPC_RESPONSE')
        }else if(flight.meta.kind==='execute'){
          const request=body as DatasetWorkbenchRequest
          result=await bound.endpoint.dispatchWorkbench!(structuredClone(request),{identity:{epoch:bound.identity.epoch,datasetId:bound.identity.datasetId},signal:flight.controller.signal,deadlineAtMs:flight.deadlineAtMs})
          const fresh=await wbOriginalContext(flight.meta,flight.controller.signal,flight.deadlineAtMs)
          if(fresh.endpoint!==bound.endpoint||fresh.identity.epoch!==bound.identity.epoch||!isDatasetWorkbenchResult(request,result,bound.identity.datasetId))throw new DatasetWorkbenchWireError('INVALID_IPC_RESPONSE')
        }
        if(flight.expired||flight.controller.signal.aborted||mobileClosing||Date.now()>=flight.meta.expiresAtMs||performance.now()>=flight.deadlineAtMs)throw new DatasetWorkbenchWireError('TIMEOUT')
        for(const frame of datasetWorkbenchFrames(flight.meta,'response',result))port.postMessage(frame)
        // context生产Promise已等待本次settled及Client cleanup；全部成功响应帧发完才保存端点。
        if(isDatasetWorkbenchContextKind(flight.meta.kind))flight.settledContextEndpoint=bound.endpoint
      }).catch(error=>{wbFailure(flight,error instanceof DatasetWorkbenchWireError?error.code:'NOT_READY',{error})}).finally(async()=>{
        // 原Owner RPC超时只撤回响应；仍等其真实settled帧，不能提前声称底层已join。
        try{
          const contextSucceeded=isDatasetWorkbenchContextKind(flight.meta.kind)&&flight.settledContextEndpoint!==undefined
            &&runtime.datasetOwnerEndpoint===flight.settledContextEndpoint&&mobileReady&&!mobileClosing
            &&!flight.expired&&!flight.controller.signal.aborted&&Date.now()<flight.meta.expiresAtMs;
          if(!contextSucceeded)await runtime.datasetOwnerEndpoint?.joinWorkbench?.();
        }finally{wbSettle(flight)}
      })
      flight.task=task;void task.catch(()=>{})
    }catch(error){wbFailure(item,error instanceof DatasetWorkbenchWireError?error.code:'INVALID_IPC_REQUEST',{error});wbSettle(item)}
    };
    if(isDatasetWorkbenchContextKind(raw.kind))runLocalAlbumContext(raw.id,null,'context.utility.receive',receive,false,false);else receive();
  }
  async function closeWorkbenchFlights():Promise<void>{
    for(const item of workbenchFlights.values()){item.controller.abort();wbFailure(item,'NOT_READY');if(!item.running)wbSettle(item)}
    await runtime.datasetOwnerEndpoint?.closeWorkbench?.()
    await Promise.allSettled([...workbenchFlights.values()].flatMap(item=>item.task?[item.task]:[]))
  }
  const closeContentFlights = async () => {
    for (const entry of contentFlights.values()) entry.controller.abort(new MobileAuthPersistenceError('unknown'));
    const quiet = Promise.allSettled([...contentFlights.values()].map(entry => entry.flight));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new MobileAuthPersistenceError('unknown')), MOBILE_CONTENT_RPC_BOUNDS.closeMs);
      void quiet.then(() => { clearTimeout(timer); resolve(); }, () => { clearTimeout(timer); reject(new MobileAuthPersistenceError('unknown')); });
    });
  };
  attachMobileSealedCoreReceiver(port, (event) => {
    if (shutdownReceipt.receive(port, event.data)) return;
    if(isRecord(event.data)&&(Object.getOwnPropertyDescriptor(event.data,'type')?.value==='musicbridge.lyrics.provider-reply'||Object.getOwnPropertyDescriptor(event.data,'type')?.value==='musicbridge.name.provider-reply'))return;
    if(isRecord(event.data)&&Object.getOwnPropertyDescriptor(event.data,'type')?.value==='musicbridge.workbench.frame'){wbReceive(event.data);return;}
    if (isRecord(event.data) && Object.getOwnPropertyDescriptor(event.data, 'type')?.value === 'local-album-main-request') {
      if (!isLocalAlbumMainRequest(event.data)) return;
      const call = structuredClone(event.data);
      const operation = async () => {
        let response: LocalAlbumMainResponse;
        try {
          const endpoint = runtime.datasetOwnerEndpoint;
          localAlbumPhase('utility.ready');
          if (!mobileReady || mobileClosing || mobileFlights.size >= 32 || !endpoint?.readLocalAlbum) throw new Error('本地专辑作者未就绪。');
          localAlbumPhase('utility.prepare'); const identity = await endpoint.prepare();
          localAlbumPhase('utility.dataset'); const datasetMatched = identity.datasetId === call.datasetId; localAlbumMatch('dataset', datasetMatched);
          if (!datasetMatched) throw new Error('原工作库身份已改变。');
          localAlbumPhase('utility.read'); const result = await endpoint.readLocalAlbum(call.request);
          const candidate = { version: 1, type: 'local-album-main-response', id: call.id, datasetId: call.datasetId, command: call.request.command, ok: true, result };
          localAlbumPhase('utility.dto');
          if (mobileClosing) throw new Error('原本地专辑结果未通过校验。');
          const responseValid = isLocalAlbumMainResponse(candidate, call); localAlbumMatch('dto', responseValid);
          if (!responseValid) throw new Error('原本地专辑结果未通过校验。');
          response = candidate;
        } catch (error) { const mappedCode = mobileClosing || !mobileReady ? 'NOT_READY' : 'UNAVAILABLE'; localAlbumReject(error, mappedCode); response = localAlbumMainFailure(call, mappedCode); }
        port.postMessage(response);
      };
      const pending = runLocalAlbumContext(call.id, null, 'utility.receive', operation); mobileFlights.add(pending);
      void pending.finally(() => mobileFlights.delete(pending)).catch(() => {}); return;
    }
    if (isRecord(event.data) && Object.getOwnPropertyDescriptor(event.data, 'type')?.value === 'mobile-range-window-seed') {
      rangeWindow.acceptSeed(event.data); return;
    }
    if (isRecord(event.data) && Object.getOwnPropertyDescriptor(event.data, 'type')?.value === 'mobile-content-core-request') {
      let call: MobileContentCoreRequest;
      try { call = captureMobileContentCoreRequest(event.data); } catch { return; }
      const cleanup = call.action === 'source' && (call.request.operation === 'release' || call.request.operation === 'close-read');
      const control = cleanup || call.action === 'cancel' || call.action === 'invalidate-device' || call.action === 'revalidate';
      if (!mobileReady || mobileClosing || !runtime.mobileContentRpc || contentFlights.size >= (control ? 16 : 15) || contentFlights.has(call.id)) {
        port.postMessage(mobileContentRpcFailure(call, new MobileAuthPersistenceError(contentFlights.has(call.id) ? 'unknown' : 'not-sent')));
        if (call.action === 'initialize') call.key.fill(0); return;
      }
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(new MobileAuthPersistenceError('unknown')), MOBILE_CONTENT_RPC_BOUNDS.requestMs);
      let firstPostAttempted = false, firstUnknown = false, observedSettlement = false, latePostAttempted = false;
      let settledResponse: MobileContentCoreResponse | undefined;
      const flushSettlement = () => {
        if (!firstPostAttempted || !firstUnknown || latePostAttempted || settledResponse === undefined) return;
        const response = settledResponse; settledResponse = undefined; latePostAttempted = true;
        if (!mobileReady || mobileClosing) return;
        try { port.postMessage(response); } catch { /* 晚结算旁注失败不重放业务或冒充quiet。 */ }
      };
      const onSettled: MobileContentCoreSettlementObserver = raw => {
        if (observedSettlement) return; observedSettlement = true;
        try {
          if (firstPostAttempted && !firstUnknown) return;
          const response = captureMobileContentCoreResponse(raw, call);
          if (!mobileContentLateResponseAllowed(call, response)) return;
          settledResponse = response; flushSettlement();
        } catch { /* 原nonce/闭集不匹配不能成为Main的收槽证明。 */ }
      };
      const pending = Promise.resolve().then(async () => {
        let response: MobileContentCoreResponse;
        try {
          response = captureMobileContentCoreResponse(await rangeWindow.run(call.id, call.action === 'source' ? call.request.operation : undefined,
            () => runtime.mobileContentRpc!(call, controller.signal, onSettled)), call);
          if (mobileClosing || controller.signal.aborted) throw new MobileAuthPersistenceError('unknown');
        } catch (error) { response = mobileContentRpcFailure(call, error); }
        firstUnknown = 'kind' in response && response.kind === 'error' && response.outcome === 'unknown';
        // first必须先实际尝试发送；一个原调用至多补送一次已校验晚确定终态，不新增wire或时钟。
        try { port.postMessage(response); }
        finally {
          firstPostAttempted = true;
          if (!firstUnknown) settledResponse = undefined;
          else flushSettlement();
        }
      });
      contentFlights.set(call.id, { controller, flight: pending });
      const quiet = () => { clearTimeout(timer); contentFlights.delete(call.id); if (call.action === 'initialize') call.key.fill(0); };
      void pending.then(quiet, quiet); return;
    }
    if (isRecord(event.data) && Object.getOwnPropertyDescriptor(event.data, 'type')?.value === 'mobile-main-request') {
      const boundary = readMobileCorePrivateCallForCapture(event.data);
      if (!boundary) return;
      const call = boundary.value;
      const trace = call.ownerLoadTrace === undefined ? undefined : createMobileOwnerLoadTraceContext(call.ownerLoadTrace, event => {
        try { port.postMessage({ type: 'mobile-owner-load-trace', event }); } catch { /* 旁注失败不替换原业务。 */ }
      });
      const operation = async () => {
        markMobileOwnerLoadTrace('core', 'core.receive', 'ok');
        let result: MobileOwnerPrivateResult;
        try {
          const endpoint = runtime.datasetOwnerEndpoint;
          if (!mobileReady || mobileClosing || mobileFlights.size >= 32 || !endpoint?.mobileMain) throw new MobileAuthPersistenceError('not-sent');
          let captured: typeof call;
          try { captured = observeMobileOwnerLoadTrace('core', 'core.capture', () => boundary.capture()); }
          catch { throw new MobileAuthPersistenceError('not-sent'); }
          result = await catalogTraceAsync('core.owner-await', () => observeMobileOwnerLoadTrace('core', 'core.owner', () => endpoint.mobileMain!(captured.request)));
          const valid = observeMobileOwnerLoadTrace('core', 'core.result', () => !mobileClosing && isMobileOwnerPrivateResult(result, call.request));
          if (!valid) { markMobileOwnerLoadTrace('core', 'core.result', 'invalid'); throw new MobileAuthPersistenceError('unknown'); }
          if ('kind' in result && result.kind === 'mobile-error') catalogTraceEvent('core.result','reject',{error:{code:result.code},matched:false});
          else catalogTraceEvent('core.result','ok',{matched:true});
        } catch (error) {
          result = { kind: 'mobile-error', status: error instanceof MobileServiceError ? error.status : 503,
            code: error instanceof MobileServiceError ? error.code : 'BUSY', retryable: false,
            outcome: error instanceof MobileAuthPersistenceError || error instanceof DatasetOwnerTransportError ? error.outcome : null } satisfies MobileOwnerPrivateFailure;
        }
        try { observeMobileOwnerLoadTrace('core', 'core.post', () => port.postMessage(encodeMobileSealedCoreReply({ type: 'mobile-main-response', id: call.id, result }, call))); }
        catch (error) { markMobileOwnerLoadTrace('core', 'core.post', 'post-failed'); throw error; }
      };
      const seed = copyCatalogTraceSeed(call.catalogTrace);
      const validSeed = seed && seed.nonceSha256 === catalogTraceNonce(call.id) && call.request.kind === 'catalog' && call.request.request.operation === 'listTracks'
        && seed.offset === call.request.request.offset && seed.limit === call.request.request.limit ? seed : undefined;
      const pending = withCatalogTraceScope(validSeed, 'core', () => catalogTraceAsync('core.receive', () => withMobileOwnerLoadTrace(trace, operation))); mobileFlights.add(pending);
      void pending.finally(() => mobileFlights.delete(pending)).catch(() => {}); return;
    }
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
        let result: unknown, workbenchCloseFailure: unknown;
        try {
          const operation = () => recorder ? withPerformanceContext(recorder, span?.context, () => dispatch(runtime, parsed.value)) : dispatch(runtime, parsed.value);
          if (parsed.value.command === 'core.shutdown') {
            mobileClosing = true; reads.cancelAll('shutdown');
            await runLibraryShutdownStep('utility.content', () => closeContentFlights());
            try { await runLibraryShutdownStep('utility.workbench', () => closeWorkbenchFlights()); } catch (error) { workbenchCloseFailure = error; }
            await runLibraryShutdownStep('utility.mobile', () => Promise.allSettled([...mobileFlights]));
          }
          if (['auth.setCredential', 'auth.clearCredential', 'auth.logout'].includes(parsed.value.command)) reads.cancelWhere(command => command.startsWith('library.'), 'credential-changed');
          if (parsed.value.command === 'roon.selectZone') reads.cancelWhere(command => !command.startsWith('library.') || command === 'library.match' || command === 'library.aggregateSearch', 'zone-changed');
          result = await (parsed.value.command === 'core.shutdown' ? runLibraryShutdownStep('utility.dispatch', operation)
            : isLibraryReadCommand(parsed.value.command) ? reads.read(parsed.value, operation) : operation());
          if (workbenchCloseFailure !== undefined) throw workbenchCloseFailure;
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
        if (parsed.value.command === 'core.shutdown') shutdownReceipt.postSuccess(parsed.value.id, response);
        else port.postMessage(response);
        if (parsed.value.command === 'core.shutdown') logLibraryOperation('library', 'shutdown.utility-response', 'complete', { code: 'RESPONSE_POSTED' });
        recorder?.mark('ipc', 'response-sent', span?.context, {}, { command: parsed.value.command });
      } catch (error) {
        if (parsed.value.command === 'core.shutdown') {
          shutdownReceipt.cancel(parsed.value.id);
          logLibraryOperation('library', 'shutdown.utility-response', 'error', { code: 'SHUTDOWN_REPLY_FAILED' });
        }
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
  mobileReady = true;
  postReady(port, runtime);
}

export function isCrashProbeEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === 'test' && env.MUSIC_BRIDGE_CORE_CRASH_PROBE === '1';
}


/** 仅 Utility 的私有父连接可 arm；测试回调不进入任何 IPC 合同。 */
export function createCoreCrashProbeController(
  env: NodeJS.ProcessEnv,
  terminate: (code: number) => void = code => process.exit(code),
): { readonly armedMode: boolean; ready(): void; receive(event: MessageWithPorts): void; close(): void } {
  const armRequested = env.MUSIC_BRIDGE_CORE_CRASH_PROBE_ARM_REQUIRED !== undefined;
  const armedMode = isCrashProbeEnabled(env) && armRequested
    && env.MUSIC_BRIDGE_CORE_CRASH_PROBE_ARM_REQUIRED === '1' && env.MUSIC_BRIDGE_CORE_TEST_MODE === '1';
  const automaticMode = isCrashProbeEnabled(env) && !armRequested;
  let ready = false, started = false, closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const configuredDelay = Number(env.MUSIC_BRIDGE_CORE_CRASH_DELAY_MS);
  const automaticDelay = Number.isSafeInteger(configuredDelay) && configuredDelay >= 25 ? Math.min(configuredDelay, 5_000) : 25;
  const start = (delayMs: number): void => {
    if (closed || started) return;
    started = true;
    timer = setTimeout(() => { timer = undefined; closed = true; terminate(71); }, delayMs);
  };
  return {
    armedMode,
    ready() {
      if (closed || ready) return;
      ready = true;
      // credentialRecovery 保留原自动故障和原有 250ms 等有限配置。
      if (automaticMode) start(automaticDelay);
    },
    receive(event) {
      if (!armedMode || !ready || closed || started) return;
      try {
        if (event.ports !== undefined && (!Array.isArray(event.ports) || event.ports.length !== 0)) return;
        const data = event.data;
        if (!isRecord(data) || ![Object.prototype, null].includes(Object.getPrototypeOf(data))) return;
        const keys = Reflect.ownKeys(data), fields = Object.getOwnPropertyDescriptors(data);
        if (keys.length !== 2 || !keys.includes('type') || !keys.includes('version')
          || !Object.hasOwn(fields.type ?? {}, 'value') || !Object.hasOwn(fields.version ?? {}, 'value')
          || fields.type!.value !== 'musicbridge.core.crash-probe-arm' || fields.version!.value !== 1) return;
        start(25);
      } catch { /* 私有未知消息与访问器不能触发故障。 */ }
    },
    close() { closed = true; if (timer !== undefined) clearTimeout(timer); timer = undefined; },
  };
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
  localWorkbenchNative?: Readonly<DatasetWorkbenchNativeConfiguration>;
  privateSourceWritesPort?:MessagePort;
  privateRelocationMainPort?: MessagePort;
  projection: DatasetOwnerProjectionHandler;
  onFatal: (error: unknown, drainOwner?: () => Promise<void>) => void;
}) => DatasetOwnerEndpoint;

/** 真实私有启动信封；新配置不能从env、公开IPC或访问器取得。 */
export function captureCoreWorkbenchNativeBootstrap(message: unknown): Readonly<DatasetWorkbenchNativeConfiguration> | undefined {
  if(!isRecord(message)||types.isProxy(message)||![Object.prototype,null].includes(Object.getPrototypeOf(message)))throw new Error('Core私有启动身份无效。');
  const fields=Object.getOwnPropertyDescriptors(message),allowed=['type','playbackEventProtocol','relocationMainPort','localWorkbenchNative'];
  if(!Object.hasOwn(fields,'type')||Reflect.ownKeys(message).some(key=>typeof key!=='string'||!allowed.includes(key)||fields[key]?.enumerable!==true||!Object.hasOwn(fields[key]!, 'value'))
    ||message.type!=='musicbridge.core.port'||message.playbackEventProtocol!==undefined&&message.playbackEventProtocol!=='compact-v1'
    ||message.relocationMainPort!==undefined&&message.relocationMainPort!==LOCAL_RELOCATION_MAIN_PORT_BOOTSTRAP)throw new Error('Core私有启动协议无效。');
  return Object.hasOwn(message,'localWorkbenchNative')?captureDatasetWorkbenchNativeConfiguration(message.localWorkbenchNative):undefined;
}

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
      const closeTransferredPorts = (): void => {
        // 启动准入失败也关闭尚未建立bridge的真实父端；旧UtilityPort接口不增加能力。
        for (const transferred of new Set(event.ports ?? [])) {
          try { (transferred as UtilityPort & { close?: () => void }).close?.(); }
          catch { /* 继续清理其它父端，启动失败仍保留。 */ }
        }
      };
      const port = event.ports?.[0];
      if (!port) {
        closeTransferredPorts();
        process.exitCode = 1;
        return;
      }
      let dataset: Awaited<ReturnType<typeof openCollectionDataset>> | undefined;
      let datasetOwnerEndpoint: DatasetOwnerEndpoint | undefined;
      let ownerIdentity: DatasetOwnerIdentity | undefined;
      let runtime: CoreRuntime | undefined;
      let runtimeShutdown: Promise<void> | undefined;
      let sourceWritesBridge: ReturnType<typeof createUtilitySourceWritesBridge> | undefined;
      let relocationBridge: ReturnType<typeof createUtilityRelocationBridge> | undefined;
      let fatalOwnerDrain: Promise<void> | undefined;
      let resolvedRustReadonlyCollection = rustReadonlyCollection;
      let projectionGateway: ReturnType<typeof createDatasetRoonProjectionGateway> | undefined;
      let lyricsProviderBridge:ReturnType<typeof createUtilityLyricsProviderBridge>|undefined;
      let nameProviderBridge:ReturnType<typeof createUtilityNameProviderBridge>|undefined;
      let albumArtworkBridge:ReturnType<typeof createUtilityLocalAlbumArtworkBridge>|undefined;
      let crashProbe: ReturnType<typeof createCoreCrashProbeController> | undefined;
      try {
        const localWorkbenchNative = captureCoreWorkbenchNativeBootstrap(event.data);
        if(localWorkbenchNative!==undefined&&!createDatasetOwner)throw new Error('原生配置需要真实Dataset Owner工厂。');
        const bootstrap = event.data as Record<string, unknown>;
        const playbackEventProtocol = bootstrap.playbackEventProtocol === 'compact-v1' ? 'compact-v1' as const : undefined;
        const hasRelocationPort = bootstrap.relocationMainPort === LOCAL_RELOCATION_MAIN_PORT_BOOTSTRAP;
        if (hasRelocationPort && (!createDatasetOwner || ![2, 3].includes(event.ports?.length ?? 0)
          || new Set(event.ports).size !== event.ports!.length)) throw new Error('搬迁专用实际物理端口或Owner工厂无效。');
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
          lyricsProviderBridge=createUtilityLyricsProviderBridge(port,()=>ownerIdentity,()=>{
            datasetOwnerEndpoint?.sealLocalSources?.();runtime?.getDatasetScanReadAdmission?.().close();
            void Promise.resolve().then(()=>runtime?runtime.shutdown():datasetOwnerEndpoint?.close()).then(()=>process.exit(72),()=>process.exit(72));
          },()=>nameProviderBridge?.pending()??0);
          nameProviderBridge=createUtilityNameProviderBridge(port,()=>ownerIdentity,()=>{
            datasetOwnerEndpoint?.sealLocalSources?.();runtime?.getDatasetScanReadAdmission?.().close();
            void Promise.resolve().then(()=>runtime?runtime.shutdown():datasetOwnerEndpoint?.close()).then(()=>process.exit(72),()=>process.exit(72));
          },()=>lyricsProviderBridge?.pending()??0);
          albumArtworkBridge=createUtilityLocalAlbumArtworkBridge(port,()=>ownerIdentity,()=>{
            datasetOwnerEndpoint?.sealLocalSources?.();runtime?.getDatasetScanReadAdmission?.().close();
            void Promise.resolve().then(()=>runtime?runtime.shutdown():datasetOwnerEndpoint?.close()).then(()=>process.exit(72),()=>process.exit(72));
          });
          const project = async (command: DatasetProjectionCommand, payload: DatasetProjectionCommandPayloads[DatasetProjectionCommand], context: { epoch: string; datasetId?: string;signal?:AbortSignal;deadlineAtMs?:number;expiresAtMs?:number }): Promise<unknown> => {
            if(command==='normalizeLocalAlbumArtwork')return albumArtworkBridge!.call(payload as DatasetProjectionCommandPayloads['normalizeLocalAlbumArtwork'],context);
            if(isDatasetNameProviderCommand(command))return nameProviderBridge!.call(command,payload as DatasetProjectionCommandPayloads[typeof command],context);
            if(isDatasetLyricsProviderCommand(command))return lyricsProviderBridge!.call(command,payload as DatasetProjectionCommandPayloads[typeof command],context);
            if (command === 'scanReadStatus' || command === 'scanReadAcquire' || command === 'scanReadWatchRevocation' || command === 'scanReadRelease') {
              if (!isDatasetProjectionPayload(command, payload) || !ownerIdentity || context.epoch !== ownerIdentity.epoch
                || context.datasetId !== ownerIdentity.datasetId) throw new DatasetOwnerDispatchError(responseFailure(context.epoch, 'NOT_READY', '扫描读取私有来源已失效。'));
              const admission = runtime?.getDatasetScanReadAdmission?.();
              if (!admission || context.datasetId === undefined) throw new DatasetOwnerDispatchError(responseFailure(context.epoch, 'NOT_READY', '扫描读取准入尚未就绪。'));
              const scope = { epoch: context.epoch, datasetId: context.datasetId };
              if (command === 'scanReadStatus') return admission.status(scope);
              if (command === 'scanReadAcquire') return admission.acquire(scope, Object.getOwnPropertyDescriptor(payload, 'purpose')?.value as 'local-album-display' | undefined);
              const permitId = (payload as { permitId: string }).permitId;
              return command === 'scanReadWatchRevocation' ? admission.watchRevocation(scope, permitId) : admission.release(scope, permitId);
            }
            return projectionGateway!.handler(command, payload as DatasetProjectionCommandPayloads[typeof command], context);
          };
          const privatePort = hasRelocationPort && event.ports?.length === 2 ? undefined : event.ports?.[1];
          if (privatePort !== undefined) {
            if (event.ports?.length !== (hasRelocationPort ? 3 : 2)) throw new Error('源写专用物理端口数量无效。');
            // Electron 父端保留在 Utility；只有新建的真实 Node 端口转移给 Owner。
            sourceWritesBridge = createUtilitySourceWritesBridge(privatePort as SourceWritesUtilityPort);
          }
          if (hasRelocationPort) {
            const relocationPort = event.ports![event.ports!.length - 1]!;
            if (relocationPort === port || relocationPort === privatePort) throw new Error('搬迁物理端口不能复用其它域。');
            relocationBridge = createUtilityRelocationBridge(relocationPort as RelocationUtilityPort);
          }
          const source = createDatasetOwner({ projection: project as DatasetOwnerProjectionHandler,...(localWorkbenchNative ? { localWorkbenchNative } : {}),...(sourceWritesBridge ? { privateSourceWritesPort: sourceWritesBridge.port } : {}), ...(relocationBridge ? { privateRelocationMainPort: relocationBridge.port } : {}), onFatal: (_error, drainOwner) => {
            sourceWritesBridge?.close();
            relocationBridge?.close();
            if (drainOwner && !fatalOwnerDrain) {
              fatalOwnerDrain = Promise.resolve().then(drainOwner);
              void fatalOwnerDrain.catch(() => undefined);
            }
            runtime?.getDatasetScanReadAdmission?.().close();
            projectionGateway?.close();
            lyricsProviderBridge?.close(); nameProviderBridge?.close(); albumArtworkBridge?.close();
            datasetOwnerEndpoint?.sealLocalSources?.();
            // 先封派发，再join自有FD；退出不能抢在阻塞读取静止之前。
            void Promise.resolve().then(async () => {
              try { if (runtime) await runtime.shutdown(); else await datasetOwnerEndpoint?.close(); }
              catch { /* 原失败回执仍是失败；它不能替代实际线程退出。 */ }
              if (fatalOwnerDrain) await fatalOwnerDrain;
            }).then(() => process.exit(72), () => process.exit(72));
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
            ...(source.mobileMain ? { mobileMain: (request: import('./mobile/types.js').MobileOwnerPrivateRequest) => source.mobileMain!(request) } : {}),
            ...(source.workbenchReadIdentity ? { workbenchReadIdentity: (read?:{signal?:AbortSignal;deadlineAtMs?:number})=>source.workbenchReadIdentity!(read) } : {}),
            ...(source.workbenchContext && source.dispatchWorkbench && source.dispatchWorkbenchOwner && source.closeWorkbench && source.joinWorkbench ? {workbenchContext: (read?:{signal?:AbortSignal;deadlineAtMs?:number})=>source.workbenchContext!(read),dispatchWorkbench: (request:import('./collection/dataset-owner-protocol.js').DatasetWorkbenchRequest,context:{identity:DatasetOwnerIdentity;signal?:AbortSignal;deadlineAtMs?:number})=>source.dispatchWorkbench!(request,context),dispatchWorkbenchOwner:(request:DatasetWorkbenchOwnerRequest,context:{identity:DatasetOwnerIdentity;signal?:AbortSignal;deadlineAtMs?:number})=>source.dispatchWorkbenchOwner!(request,context),closeWorkbench:()=>source.closeWorkbench!(),joinWorkbench:()=>source.joinWorkbench!()} : {}),
            ...(source.readLocalAlbum ? { readLocalAlbum: (request: import('./collection/local-album-browser/owner-protocol.js').LocalAlbumOwnerReadRequest) => source.readLocalAlbum!(request) } : {}),
            ...(client.materializeMBEdition?{materializeMBEdition:(request:import('@music-bridge/contracts').MBEditionQueueRequest)=>client.materializeMBEdition!(request)}:{}),
            ...(client.loadMBQueue ? { loadMBQueue: () => client.loadMBQueue!() } : {}),
            ...(client.saveMBQueue ? { saveMBQueue: (request: import('@music-bridge/contracts').MBQueueSaveRequest) => client.saveMBQueue!(request) } : {}),
            ...(client.captureLocalSource?{captureLocalSource: (selection:import('@music-bridge/contracts').LocalPlayRequest)=>client.captureLocalSource!(selection)}:{}),
            ...(client.readLocalSourceLyrics?{readLocalSourceLyrics:(ticket:string)=>client.readLocalSourceLyrics!(ticket)}:{}),
            ...(client.revalidateLocalSource?{revalidateLocalSource:(ticket:string)=>client.revalidateLocalSource!(ticket)}:{}),
            ...(client.releaseLocalSource?{releaseLocalSource:(ticket:string)=>client.releaseLocalSource!(ticket)}:{}),
            ...(client.sealLocalSources?{sealLocalSources:()=>client.sealLocalSources!()}:{}),
            ...(client.isLocalSourceCurrent?{isLocalSourceCurrent:()=>client.isLocalSourceCurrent!()}:{}),
            commitBoot: () => client.commitBoot(),
            close: async () => {
              runtime?.getDatasetScanReadAdmission?.().close();
              // 原Owner收尾仍需实际批准、取消和join端口；先等物理静止再撤销端口。
              try { await client.close(); } finally { sourceWritesBridge?.close(); relocationBridge?.close(); projectionGateway?.close(); lyricsProviderBridge?.close(); nameProviderBridge?.close(); albumArtworkBridge?.close(); }
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
            ? createTestBridgeRuntime({ ...playbackOptions, onEvent, datasetOwnerEndpoint, localScanReadProfile: 'bulk-v2',
                ...(env.MUSIC_BRIDGE_UI_E2E === '1' && env.MUSIC_BRIDGE_SYNTHETIC_ROON_LIBRARY === '1' ? { roonLibrary: createSyntheticRoonLibrary() } : {}),
                authorized: env.MUSIC_BRIDGE_UI_E2E === '1',
                ...(env.MUSIC_BRIDGE_SYNTHETIC_ACCOUNT_MODE === 'profile-unavailable' || env.MUSIC_BRIDGE_SYNTHETIC_ACCOUNT_MODE === 'expired' ? { accountMode: env.MUSIC_BRIDGE_SYNTHETIC_ACCOUNT_MODE } : {}) })
            : createBridgeRuntime({ ...playbackOptions, onEvent, datasetOwnerEndpoint, localScanReadProfile: 'bulk-v2',
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
        crashProbe = createCoreCrashProbeController(env);
        if (crashProbe.armedMode) {
          if (typeof parentPort.on !== 'function') throw new Error('缺少可信 Utility 父连接。');
          // 不监听公共 Runtime 端口；监听器绑定本次实际 parentPort/Utility。
          parentPort.on('message', message => { crashProbe!.receive(message); });
        }
        if (isCrashProbeEnabled(env)) {
          const shutdown = runtime.shutdown.bind(runtime);
          runtime.shutdown = () => { crashProbe!.close(); return shutdown(); };
        }
        await attachCoreRuntimePort(port, runtime, { exitAfterShutdown: true, beforeReady: async () => { if(datasetOwnerEndpoint)await datasetOwnerEndpoint.commitBoot();else await dataset?.commit();await runtime!.restoreLogicalQueue?.(); }, ...(libraryReadTrace ? { libraryReadTrace } : {}) });
        crashProbe.ready();
      } catch {
        crashProbe?.close();
        sourceWritesBridge?.close();
        relocationBridge?.close();
        closeTransferredPorts();
        let cleanupSucceeded = false;
        try { await datasetOwnerEndpoint?.close(); cleanupSucceeded = true; } catch { /* 保留未确认关闭，不把启动失败冒充静止。 */ }
        if (fatalOwnerDrain) {
          try { await fatalOwnerDrain; } catch { /* 保留 fatal 结论，不提升为正常关闭。 */ }
        }
        projectionGateway?.close();
        lyricsProviderBridge?.close(); nameProviderBridge?.close(); albumArtworkBridge?.close();
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
