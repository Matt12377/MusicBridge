import { captureLocalAlbumContext, withLocalAlbumContext, runLocalAlbumContext, localAlbumPhase, localAlbumMatch, localAlbumReject, localAlbumRejectCode, emitLocalAlbumNodeTrace, localAlbumLink, localAlbumTraceSha, type LocalAlbumNodeContext } from '../shared/local-album-read-trace-node.js';
import { isDatasetWorkbenchOwnerRequest, isDatasetWorkbenchOwnerResult, isDatasetWorkbenchOwnerScope, type DatasetWorkbenchOwnerRequest, type DatasetWorkbenchOwnerResult, type DatasetWorkbenchOwnerCommand, type DatasetWorkbenchOwnerPayloads, type DatasetWorkbenchOwnerResults, DATASET_WORKBENCH_BOUNDS, isDatasetWorkbenchContext, isDatasetWorkbenchRequest, isDatasetWorkbenchResult, isDatasetWorkbenchFrame, datasetWorkbenchMeta, sameDatasetWorkbenchMeta, datasetWorkbenchJson, datasetWorkbenchSha, datasetWorkbenchFrames, datasetWorkbenchControl, createDatasetWorkbenchAssembler, DatasetWorkbenchWireError, type DatasetWorkbenchMeta, type DatasetWorkbenchRequest, type DatasetWorkbenchResult, type DatasetWorkbenchContext } from './dataset-owner-protocol.js';
import {isMBQueueLoadResult,isMBQueueNeedsReview,isMBQueueUnavailable,type MBQueueLoadResult} from './mb-queue-owner-types.js';
import { isLocalAlbumOwnerReadRequest, isLocalAlbumOwnerReadResult, type LocalAlbumOwnerReadRequest, type LocalAlbumOwnerReadResult } from './local-album-browser/owner-protocol.js';
import { isMBEditionQueueRequest, isMBEditionQueueSnapshot, type MBEditionQueueRequest, type MBEditionQueueSnapshot, isMBQueueRecord, isMBQueueSaveRequest, type MBQueueRecord, type MBQueueSaveRequest } from '@music-bridge/contracts';
import { LocalSourceFence } from '../stream/local-source-fence.js';
import { isLocalSourceCaptureResult, type LocalSourceCaptureResult, type LocalSourcePrivatePayload } from './local-source-ticket-types.js';
import { isMobileOwnerPrivateRequest } from '../mobile/owner-protocol.js';
import { captureMobileOwnerPrivateResult } from '../mobile/owner-boundary-capture.js';
import type { MobileOwnerPrivateRequest, MobileOwnerPrivateResult } from '../mobile/types.js';
import { mobileCapabilityLink } from '../mobile/capability-trace.js';
import { LOCAL_RELOCATION_COMMANDS, isLocalArtworkCommand, isLocalArtworkInternalCommand, isLocalRelocationCommand, isLocalRelocationInternalCommand, isLocalRelocationCommandResult } from '@music-bridge/contracts';
import { isLocalScanCommand, isLocalScanInternalCommand, isLocalScanCommandResult, isLocalCatalogCommand, isLocalCatalogInternalCommand, validateIpcRequest, validateIpcInternalRequest, isLocalCatalogCommandResult } from '@music-bridge/contracts';
import { randomUUID } from 'node:crypto';
import { isLocalLegacyLinksCommand } from '@music-bridge/contracts';
import { isLocalSourceWritesCommand, isLocalSourceWritesCommandResult } from '@music-bridge/contracts';
import { isLocalRelocationPlanCommand, isLocalRelocationPlanCommandResult } from '@music-bridge/contracts';
import type { Worker } from 'node:worker_threads';
import type { IpcCommand, IpcRequest } from '@music-bridge/contracts';
import { failureForError, responseFailure } from '../shared/ipc-failure.js';
import {
  DATASET_OWNER_PROTOCOL_VERSION, DatasetOwnerDispatchError, DatasetOwnerTransportError,
  isDatasetCollectionSnapshot, isDatasetCollectionSnapshotVersion, isDatasetVersionedCollectionSnapshot, isDatasetLargeVersionedCollectionSnapshot, isDatasetOwnerFailure, isDatasetOwnerIdentity, isDatasetOwnerProjectionRequest, isDatasetOwnerProjectionCancel, isDatasetOwnerResponse,
  isDatasetProjectionResult, isDatasetRequestEnvelope, ownerRecord,
  type DatasetCollectionSnapshot, type DatasetCollectionSnapshotVersion, type DatasetVersionedCollectionSnapshot, type DatasetOwnerLargeSnapshotEndpoint, type DatasetOwnerFatalReason, type DatasetOwnerIdentity,
  type DatasetOwnerOperation, type DatasetOwnerProjectionHandler,
  type DatasetOwnerProjectionRequest, type DatasetOwnerProjectionResponse, type DatasetOwnerRequest,
} from './dataset-owner-protocol.js';

interface PendingRequest {
  trace?: LocalAlbumNodeContext;
  album?: LocalAlbumOwnerReadRequest;
  mobile?: MobileOwnerPrivateRequest;
  operation: DatasetOwnerOperation;
  publicId?: string;
  command?: IpcCommand;
  sent: boolean;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

export interface DatasetOwnerClientOptions {
  worker: Worker;
  projection?: DatasetOwnerProjectionHandler;
  onFatal?: (reason: DatasetOwnerFatalReason) => void;
}

// 只持有线程端口与窄投影；连接失败后保留原命令身份，不创建数据库或自动重放。
export function createDatasetOwnerClient(options: DatasetOwnerClientOptions): DatasetOwnerLargeSnapshotEndpoint & { fatalDrain(): Promise<void> } {
  const { worker } = options;
  const epoch = randomUUID();
  let localAlive = true;
  const localFences = new Map<string,LocalSourceFence>();
  const sealLocalSources = () => { localAlive = false; for (const fence of localFences.values()) fence.revoke(); };
  const pending = new Map<string, PendingRequest>();
  const projectionFlights=new Map<string,{request:DatasetOwnerProjectionRequest;controller:AbortController}>();
  const projectionRetired=new Map<string,{epoch:string;expiresAtMs:number}>();
  let sequence = 0;
  type WorkbenchPending = {meta:DatasetWorkbenchMeta;request:DatasetWorkbenchRequest|DatasetWorkbenchOwnerRequest|null;assembly:ReturnType<typeof createDatasetWorkbenchAssembler>;timer:NodeJS.Timeout;expired:boolean;detach():void;resolve(value:unknown):void;reject(error:unknown):void;settle():void;quiet:Promise<void>;contextStage?:Parameters<typeof localAlbumPhase>[0];contextTrace?:LocalAlbumNodeContext;contextResult?:DatasetWorkbenchContext|undefined;contextSignal?:AbortSignal|undefined}
  let workbenchEverReady=false
  const workbenchPending=new Map<string,WorkbenchPending>()
  const workbenchRetired=new Set<string>()
  // 只记原成功context的收口meta；同原1024项淘汰，不保存DTO或授予后续权限。
  const workbenchSettledContexts=new Map<string,DatasetWorkbenchMeta>()
  const wbRetire=(id:string)=>{workbenchRetired.add(id);if(workbenchRetired.size>1024){const retired=workbenchRetired.values().next().value!;workbenchRetired.delete(retired);workbenchSettledContexts.delete(retired)}}
  function wbCancel(item:WorkbenchPending):void{try{worker.postMessage(datasetWorkbenchControl(item.meta,'cancel'))}catch{fatal('post-failed')}}
  function wbQuiet(id:string,item:WorkbenchPending):void{clearTimeout(item.timer);item.detach();workbenchPending.delete(id);wbRetire(id);item.settle()}
  function wbReceive(message:unknown):void{
    if(!isDatasetWorkbenchFrame(message)||message.lane!=='response'){fatal('protocol-failure');return}
    const item=workbenchPending.get(message.id)
    if(!item){if(workbenchRetired.has(message.id)){if(workbenchSettledContexts.has(message.id)&&(message.part==='settled'||message.part==='end'))fatal('protocol-failure');return}fatal('protocol-failure');return}
    if(!sameDatasetWorkbenchMeta(message,item.meta)){fatal('protocol-failure');return}
    if(item.meta.kind==='context')item.contextStage='context.client.response'
    if(message.part==='failure'){item.expired=true;item.reject(new DatasetWorkbenchWireError(message.code));return}
    if(message.part==='settled'){
      if(item.meta.kind==='context'){
        // failure/取消仅在原真实settled后清账；重复的已取消ACK仍按原retired规则幂等。
        if(item.expired){wbQuiet(message.id,item);return}
        const value=item.contextResult
        if(value===undefined){item.expired=true;item.reject(new DatasetWorkbenchWireError('INVALID_IPC_RESPONSE'));fatal('protocol-failure');return}
        if(Date.now()>=item.meta.expiresAtMs||item.contextSignal?.aborted){item.expired=true;item.reject(new DatasetWorkbenchWireError('TIMEOUT'));wbQuiet(message.id,item);return}
        if(value.epoch!==epoch||value.datasetId!==identity?.datasetId){item.expired=true;item.reject(new DatasetWorkbenchWireError('OUTBOX_SCOPE_MISMATCH'));fatal('protocol-failure');return}
        workbenchSettledContexts.set(message.id,item.meta)
        // 先清本flight的timer/listener/pending，再履行原context Promise；不等待无关Owner工作。
        wbQuiet(message.id,item);item.contextResult=undefined;item.resolve(value);return
      }
      if(!item.expired){item.reject(new DatasetWorkbenchWireError('INVALID_IPC_RESPONSE'));}wbQuiet(message.id,item);return
    }
    try{
      const value=item.assembly.accept(message)
      if(value===undefined)return
      if(message.part!=='end')throw new DatasetWorkbenchWireError('INVALID_IPC_RESPONSE')
      if(Date.now()>=item.meta.expiresAtMs)throw new DatasetWorkbenchWireError('TIMEOUT')
      if(item.meta.kind==='context'){
        item.contextStage='context.client.dto'
        if(!isDatasetWorkbenchContext(value)||value.epoch!==epoch||value.datasetId!==identity?.datasetId)throw new DatasetWorkbenchWireError('OUTBOX_SCOPE_MISMATCH')
        workbenchEverReady=true
      }else if(item.meta.kind==='drain'){
        if(!ownerRecord(value)||Reflect.ownKeys(value).length!==1||value.closed!==true)throw new DatasetWorkbenchWireError('INVALID_IPC_RESPONSE')
      }else if(item.meta.kind==='owner'){
        if(!item.request||!isDatasetWorkbenchOwnerRequest(item.request)||!isDatasetWorkbenchOwnerResult(item.request.command,value,item.request.payload,item.meta.datasetId))throw new DatasetWorkbenchWireError('INVALID_IPC_RESPONSE')
      }else if(!item.request||!isDatasetWorkbenchRequest(item.request)||!isDatasetWorkbenchResult(item.request,value,item.meta.datasetId))throw new DatasetWorkbenchWireError('INVALID_IPC_RESPONSE')
      if(item.expired){if(item.meta.kind!=='context')wbQuiet(message.id,item);return}
      if(Date.now()>=item.meta.expiresAtMs)throw new DatasetWorkbenchWireError('TIMEOUT')
      if(item.meta.kind==='context'){item.contextResult=value as DatasetWorkbenchContext;return}
      item.resolve(value);wbQuiet(message.id,item)
    }catch(error){item.expired=true;item.reject(error);if(error instanceof DatasetWorkbenchWireError&&error.code==='TIMEOUT'&&message.part==='end'){if(item.meta.kind!=='context')wbQuiet(message.id,item)}else fatal('protocol-failure')}
  }
  function workbenchRpc(kind:DatasetWorkbenchMeta['kind'],request:DatasetWorkbenchRequest|DatasetWorkbenchOwnerRequest|null,read?:{signal?:AbortSignal;deadlineAtMs?:number}):Promise<unknown>{
    if(!identity||!bootCommitted||closing||failed||exited||workbenchPending.size>=(kind==='drain'?24:23)||read?.signal?.aborted){
      const error=new DatasetWorkbenchWireError('NOT_READY','not-sent');
      if(kind==='context')try{
        localAlbumPhase(!identity||!bootCommitted?'context.client.ready':closing||failed||exited?'context.client.route':workbenchPending.size>=23?'context.client.budget':'context.client.cancel');
        localAlbumReject(error,'NOT_READY');
      }catch{ /* 原未发送回执保持。 */ }
      return Promise.reject(error);
    }
    const remaining=Math.min(2000,Math.floor((read?.deadlineAtMs??performance.now()+2000)-performance.now()))
    if(remaining<=0){const error=new DatasetWorkbenchWireError('TIMEOUT','not-sent');if(kind==='context')try{localAlbumPhase('context.client.budget');localAlbumReject(error,'TIMEOUT')}catch{}return Promise.reject(error)}
    const body=request??{},raw=datasetWorkbenchJson(body),meta:DatasetWorkbenchMeta={id:randomUUID(),epoch,datasetId:identity.datasetId,sequence:++sequence,kind,requestSha256:datasetWorkbenchSha(raw),expiresAtMs:Date.now()+remaining}
    let parentSha256:string|null=null;if(kind==='context')try{parentSha256=captureLocalAlbumContext()?.traceSha256??null}catch{}
    let contextTrace:LocalAlbumNodeContext|undefined;
    if(kind==='context')try{
      const expectedTraceSha=localAlbumTraceSha(meta.id);
      runLocalAlbumContext(meta.id,parentSha256,'context.client.send',()=>{
        const captured=captureLocalAlbumContext();if(captured?.traceSha256===expectedTraceSha)contextTrace=captured;
      },false,false);
    }catch{ /* 诊断setup失效仅关闭本次观测，原RPC不变。 */ }
    let settled!:()=>void;const quiet=new Promise<void>(resolve=>{settled=resolve})
    return new Promise((resolve,reject)=>{
      let contextRejected=false;
      const rejectOriginal=(error:unknown)=>{
        if(kind==='context'&&!contextRejected){contextRejected=true;try{
          if(item.contextTrace)withLocalAlbumContext(item.contextTrace,()=>{localAlbumPhase(item.contextStage??'context.client.send');localAlbumReject(error)});
        }catch{ /* 失败关联不改变原reject。 */ }}
        reject(error);
      };
      const onAbort=()=>{const item=workbenchPending.get(meta.id);if(item&&!item.expired){if(kind==='context')item.contextStage='context.client.cancel';item.expired=true;item.reject(new DatasetWorkbenchWireError('TIMEOUT'));wbCancel(item)}}
      const timer=setTimeout(onAbort,remaining),item:WorkbenchPending={meta,request:request?structuredClone(request):null,assembly:createDatasetWorkbenchAssembler(meta,'response'),timer,expired:false,detach(){read?.signal?.removeEventListener('abort',onAbort)},resolve,reject:rejectOriginal,settle:settled,quiet,...(kind==='context'?{contextStage:'context.client.send' as const,contextSignal:read?.signal,...(contextTrace===undefined?{}:{contextTrace})}:{})}
      workbenchPending.set(meta.id,item);read?.signal?.addEventListener('abort',onAbort,{once:true})
      try{for(const frame of datasetWorkbenchFrames(meta,'request',body))worker.postMessage(frame)}catch{item.expired=true;item.reject(new DatasetWorkbenchWireError('NOT_READY','not-sent'));wbQuiet(meta.id,item);fatal('post-failed')}
    })
  }
  let identity: DatasetOwnerIdentity | undefined;
  let preparation: Promise<DatasetOwnerIdentity> | undefined;
  let commitment: Promise<void> | undefined;
  let bootCommitted = false;
  let exporting = false;
  const snapshotIds = new Set<string>();
  let closure: Promise<void> | undefined;
  let closing = false;
  let closeAcknowledged = false;
  let closePostAttempted = false;
  let exited = false;
  let failed = false;
  let fatalDrainFlight: Promise<void> | undefined;
  let physicalExitResolve!: (code: number) => void;
  // 只由真实 exit 事件结算；正常关闭资格仍由原 ACK、pending 与 naturalExit 单独判断。
  const physicalExit = new Promise<number>(resolve => { physicalExitResolve = resolve; });
  let exitResolve!: () => void;
  let exitReject!: (error: unknown) => void;
  const naturalExit = new Promise<void>((resolve, reject) => { exitResolve = resolve; exitReject = reject; });
  // 未进入close的故障也会拒绝退出等待；挂接处理避免无人等待时产生未处理拒绝。
  void naturalExit.catch(() => undefined);

  function fatal(reason: DatasetOwnerFatalReason): void {
    if (failed) return;
    failed = true; sealLocalSources();
    for(const flight of projectionFlights.values())flight.controller.abort();
    for (const item of pending.values()) item.reject(new DatasetOwnerTransportError(item.sent ? 'unknown' : 'not-sent', item.publicId, item.command));
    pending.clear();
    for(const [id,item] of workbenchPending){item.reject(new DatasetWorkbenchWireError('NOT_READY'));wbQuiet(id,item)}
    exitReject(new DatasetOwnerTransportError('unknown'));
    // 通知不能把底层异常、路径或线程数据带到公开错误中。
    try { options.onFatal?.(reason); } catch { /* 监督回调失败不能改写已发送操作的未知结果。 */ }
  }

  let queueLoading = false, queueSaving = false;
  function rpc(operation: DatasetOwnerOperation, request?: IpcRequest, expectedDatasetId?: string, local?: LocalSourcePrivatePayload, queue?: MBQueueSaveRequest, edition?:MBEditionQueueRequest, mobile?: MobileOwnerPrivateRequest, album?: LocalAlbumOwnerReadRequest): Promise<unknown> {
    if (failed || exited) return Promise.reject(new DatasetOwnerTransportError('not-sent', request?.id, request?.command));
    const requestId = randomUUID();
    if (operation === 'mobileMain' && mobile?.kind === 'content'
      && (mobile.request.action === 'initialize' || mobile.request.action === 'updateScope')) mobileCapabilityLink('owner', requestId, 'owner.rpc.link');
    const trace = operation === 'localAlbumRead' ? captureLocalAlbumContext() : undefined;
    if (trace) { localAlbumPhase('client.send'); localAlbumLink(requestId, 'client.send'); }
    const message: DatasetOwnerRequest = {
      version: DATASET_OWNER_PROTOCOL_VERSION, type: 'request', epoch, requestId,
      sequence: ++sequence, operation, ...(album === undefined ? {} : { album }), ...(mobile === undefined ? {} : { mobile }), ...(local === undefined ? {} : { local }), ...(queue === undefined ? {} : { queue }), ...(edition === undefined ? {} : { edition }), ...(request === undefined ? {} : { request }),
      ...(expectedDatasetId === undefined ? {} : { expectedDatasetId }),
    };
    return new Promise((resolve, reject) => {
      const item: PendingRequest = { operation, sent: false, ...(trace ? { trace } : {}),
        resolve: value => withLocalAlbumContext(trace, () => { emitLocalAlbumNodeTrace('ok'); resolve(value); }),
        reject: error => withLocalAlbumContext(trace, () => { localAlbumReject(error); reject(error); }), ...(album === undefined ? {} : { album }), ...(mobile === undefined ? {} : { mobile }),
        ...(request === undefined ? {} : { publicId: request.id, command: request.command }) };
      pending.set(requestId, item);
      try {
        if (operation === 'close') closePostAttempted = true;
        worker.postMessage(message); item.sent = true;
      }
      catch {
        pending.delete(requestId);
        reject(new DatasetOwnerTransportError('not-sent', request?.id, request?.command));
        fatal('post-failed');
      }
    });
  }

  async function project(message: DatasetOwnerProjectionRequest): Promise<void> {
    const controller=new AbortController();projectionFlights.set(message.projectionRequestId,{request:message,controller});
    const expiresAtMs=message.read?.expiresAtMs;const timer=expiresAtMs===undefined?undefined:setTimeout(()=>controller.abort(),Math.max(1,expiresAtMs-Date.now()));
    let response: DatasetOwnerProjectionResponse;
    try {
      if (options.projection === undefined) throw new DatasetOwnerDispatchError(responseFailure(message.projectionRequestId, 'NOT_READY', 'Roon 元数据投影尚未就绪。'));
      if(controller.signal.aborted||expiresAtMs!==undefined&&Date.now()>=expiresAtMs)throw new DatasetOwnerDispatchError(responseFailure(message.projectionRequestId,'TIMEOUT','原封面读取已取消或到期。'));
      const result = await options.projection(message.command, message.payload, { epoch, ...(identity === undefined ? {} : { datasetId: identity.datasetId }),...(expiresAtMs===undefined?{}:{signal:controller.signal,expiresAtMs,deadlineAtMs:performance.now()+Math.max(0,expiresAtMs-Date.now())}) });
      if(controller.signal.aborted||expiresAtMs!==undefined&&Date.now()>=expiresAtMs)throw new DatasetOwnerDispatchError(responseFailure(message.projectionRequestId,'TIMEOUT','原封面读取已取消或到期。'));
      if (!isDatasetProjectionResult(message.command, result)) throw new DatasetOwnerDispatchError(responseFailure(message.projectionRequestId, 'INVALID_IPC_RESPONSE', 'Roon 元数据投影返回无效。'));
      response = { version: DATASET_OWNER_PROTOCOL_VERSION, type: 'projection-response', epoch, projectionRequestId: message.projectionRequestId, ok: true, result };
    } catch (error) {
      const projectedFailure = error instanceof DatasetOwnerDispatchError
        ? { ...error.failure, id: message.projectionRequestId }
        : failureForError(message.projectionRequestId, error, 'physicalLinks.search');
      const failure = isDatasetOwnerFailure(projectedFailure) ? projectedFailure : responseFailure(message.projectionRequestId, 'INTERNAL_ERROR', '元数据投影失败。');
      response = { version: DATASET_OWNER_PROTOCOL_VERSION, type: 'projection-response', epoch, projectionRequestId: message.projectionRequestId, ok: false, failure };
    }
    if(timer)clearTimeout(timer);projectionFlights.delete(message.projectionRequestId);
    if(expiresAtMs!==undefined){projectionRetired.set(message.projectionRequestId,{epoch:message.epoch,expiresAtMs});if(projectionRetired.size>32)projectionRetired.delete(projectionRetired.keys().next().value!);}
    if (failed || exited) return;
    try { worker.postMessage(response); } catch { fatal('post-failed'); }
  }

  function receive(message: unknown): void {
    if (failed || exited) return;
    // 上一实例的回复无权完成当前实例的promise，也不能使当前实例进入fatal。
    if (ownerRecord(message) && typeof message.epoch === 'string' && message.epoch !== epoch) return;
    if(ownerRecord(message)&&Object.getOwnPropertyDescriptor(message,'type')?.value==='musicbridge.workbench.frame'){wbReceive(message);return;}
    if(isDatasetOwnerProjectionCancel(message)){
      const flight=projectionFlights.get(message.projectionRequestId);
      if(!flight){const retired=projectionRetired.get(message.projectionRequestId);if(retired?.epoch===message.epoch&&retired.expiresAtMs===message.expiresAtMs){projectionRetired.delete(message.projectionRequestId);return;}fatal('protocol-failure');return;}
      if(flight.request.command!=='normalizeLocalAlbumArtwork'||flight.request.read?.expiresAtMs!==message.expiresAtMs){fatal('protocol-failure');return;}
      flight.controller.abort();return;
    }
    if (isDatasetOwnerProjectionRequest(message)) { if(projectionFlights.has(message.projectionRequestId)||projectionRetired.has(message.projectionRequestId)){fatal('protocol-failure');return;}void project(message); return; }
    if (ownerRecord(message) && message.version === DATASET_OWNER_PROTOCOL_VERSION && message.epoch === epoch && message.type === 'fatal' && ['protocol-failure','close-failed'].includes(String(message.reason))) {
      fatal(message.reason as 'protocol-failure' | 'close-failed'); return;
    }
    const responseValid = isDatasetOwnerResponse(message);
    if (!responseValid) {
      for (const item of pending.values()) if (item.trace) withLocalAlbumContext(item.trace, () => { localAlbumPhase('client.envelope'); localAlbumMatch('dto', false); });
      fatal('protocol-failure'); return;
    }
    const item = pending.get(message.requestId);
    if (item === undefined || item.operation !== message.operation) { fatal('protocol-failure'); return; }
    const publicId = item.publicId ?? message.requestId;
    if (!message.ok && message.failure.id !== publicId) { fatal('protocol-failure'); return; }
    if (message.ok && message.operation === 'prepare' && (!isDatasetOwnerIdentity(message.result) || message.result.epoch !== epoch)) { fatal('protocol-failure'); return; }
    if (message.operation === 'localAlbumRead') {
      withLocalAlbumContext(item.trace, () => { localAlbumPhase('client.identity'); localAlbumMatch('epoch', message.epoch === epoch); });
      if (message.ok) {
        const albumValid = !!item.album && isLocalAlbumOwnerReadResult(message.result, item.album);
        withLocalAlbumContext(item.trace, () => { localAlbumPhase('client.dto'); localAlbumMatch('dto', albumValid); });
        if (!albumValid) { fatal('protocol-failure'); return; }
      } else withLocalAlbumContext(item.trace, () => { localAlbumPhase('client.reject'); localAlbumRejectCode(message.failure.error.code); });
    }
    let capturedMobile: MobileOwnerPrivateResult | undefined;
    if (message.ok && message.operation === 'mobileMain') {
      const captured = item.mobile ? captureMobileOwnerPrivateResult(message.result, item.mobile) : null;
      if (!captured) { fatal('protocol-failure'); return; }
      capturedMobile = captured;
    }
    if(message.ok&&message.operation==='materializeMBEdition'&&!isMBEditionQueueSnapshot(message.result)){fatal('protocol-failure');return;}
    if(message.ok&&message.operation==='loadMBQueue'){
      if(!isMBQueueLoadResult(message.result)||message.result!==null&&!isMBQueueNeedsReview(message.result)&&!isMBQueueUnavailable(message.result)&&message.result.datasetId!==identity?.datasetId){fatal('protocol-failure');return;}
    }
    if(message.ok&&message.operation==='saveMBQueue'&&(!isMBQueueRecord(message.result)||message.result.datasetId!==identity?.datasetId)){fatal('protocol-failure');return;}
    if (message.ok && message.operation === 'captureLocalSource') {
      if (!isLocalSourceCaptureResult(message.result) || message.result.epoch !== epoch || message.result.datasetId !== identity?.datasetId || localFences.has(message.result.ticketId) || localFences.size >= 16) { fatal('protocol-failure'); return; }
      const fence = new LocalSourceFence(message.result.buffer); if (!localAlive) fence.revoke(); localFences.set(message.result.ticketId,fence);
    }
    if (message.ok && message.operation === 'revalidateLocalSource' && typeof message.result !== 'boolean') { fatal('protocol-failure'); return; }
    if (message.ok && message.operation === 'releaseLocalSource' && message.result !== undefined) { fatal('protocol-failure'); return; }
    if (message.ok && message.operation === 'getCollectionSnapshotVersion') {
      if (!isDatasetCollectionSnapshotVersion(message.result) || message.result.epoch !== epoch || message.result.datasetId !== identity?.datasetId) { fatal('protocol-failure'); return; }
    }
    if (message.ok && (message.operation === 'exportCollectionSnapshot' || message.operation === 'exportVersionedCollectionSnapshot' || message.operation === 'exportLargeVersionedCollectionSnapshot')) {
      let snapshot: DatasetCollectionSnapshot;
      if (message.operation === 'exportVersionedCollectionSnapshot' || message.operation === 'exportLargeVersionedCollectionSnapshot') {
        const valid = message.operation === 'exportLargeVersionedCollectionSnapshot' ? isDatasetLargeVersionedCollectionSnapshot : isDatasetVersionedCollectionSnapshot;
        if (!valid(message.result)) { fatal('protocol-failure'); return; }
        snapshot = message.result.snapshot;
      } else {
        if (!isDatasetCollectionSnapshot(message.result)) { fatal('protocol-failure'); return; }
        snapshot = message.result;
      }
      if (snapshot.epoch !== epoch || snapshot.datasetId !== identity?.datasetId || snapshotIds.has(snapshot.snapshotId)) { fatal('protocol-failure'); return; }
      snapshotIds.add(snapshot.snapshotId);
    }
    if (message.ok && (message.operation === 'close' || message.operation === 'commitBoot') && message.result !== undefined) { fatal('protocol-failure'); return; }
    if (message.ok && isLocalSourceWritesCommand(item.command) && !isLocalSourceWritesCommandResult(item.command,message.result)) { fatal('protocol-failure');return; }
    if (message.ok && isLocalRelocationPlanCommand(item.command) && !isLocalRelocationPlanCommandResult(item.command, message.result)) { fatal('protocol-failure'); return; }
    if (message.ok && isLocalRelocationCommand(item.command) && !isLocalRelocationCommandResult(item.command,message.result)) { fatal('protocol-failure');return; }
    if (message.ok && isLocalScanCommand(item.command) && !isLocalScanCommandResult(item.command,message.result)) { fatal('protocol-failure'); return; }
    if (message.ok && isLocalCatalogCommand(item.command) && !isLocalCatalogCommandResult(item.command, message.result)) { fatal('protocol-failure'); return; }
    pending.delete(message.requestId);
    if (!message.ok) {
      item.reject(new DatasetOwnerDispatchError(message.failure));
      // 合法关闭失败回复已证明owner未关闭；同步锁定原因，不依赖下一帧fatal到达。
      if (message.operation === 'close') fatal('close-failed');
      return;
    }
    if (message.operation === 'close') closeAcknowledged = true;
    item.resolve(capturedMobile ?? message.result);
  }

  worker.on('message', receive);
  worker.on('error', () => fatal('worker-error'));
  worker.on('messageerror', () => fatal('protocol-failure'));
  worker.once('exit', code => {
    exited = true;
    physicalExitResolve(code);
    worker.off('message', receive);
    if (code === 0 && closing && closeAcknowledged && !failed && pending.size === 0 && workbenchPending.size === 0 && projectionFlights.size === 0) exitResolve();
    else fatal('worker-exit');
  });

  return {
    async workbenchContext(read){return await workbenchRpc('context',null,read) as DatasetWorkbenchContext},
    async joinWorkbench(){await Promise.all([...workbenchPending.values()].map(item=>item.quiet))},
    async dispatchWorkbench(request,context){
      if(!identity||context.identity.epoch!==epoch||context.identity.datasetId!==identity.datasetId||!isDatasetWorkbenchRequest(request))throw new DatasetWorkbenchWireError('OUTBOX_SCOPE_MISMATCH','not-sent')
      if(request.family==='lyrics'&&('scope'in request.payload&&request.payload.scope.datasetId!==identity.datasetId||'library'in request.payload&&request.payload.library.datasetId!==identity.datasetId))throw new DatasetWorkbenchWireError('OUTBOX_SCOPE_MISMATCH','not-sent')
      return await workbenchRpc('execute',structuredClone(request),context) as DatasetWorkbenchResult
    },
    async dispatchWorkbenchOwner(request,context){
      if(!identity||context.identity.epoch!==epoch||context.identity.datasetId!==identity.datasetId||!isDatasetWorkbenchOwnerRequest(request)||!isDatasetWorkbenchOwnerScope(request,identity.datasetId))throw new DatasetWorkbenchWireError('OUTBOX_SCOPE_MISMATCH','not-sent')
      return await workbenchRpc('owner',structuredClone(request),context) as DatasetWorkbenchOwnerResult
    },
    async closeWorkbench(){
      if(!workbenchEverReady){for(const item of workbenchPending.values())if(!item.expired){item.expired=true;item.reject(new DatasetWorkbenchWireError('NOT_READY'));wbCancel(item)}await Promise.all([...workbenchPending.values()].map(item=>item.quiet));return}
      for(const item of workbenchPending.values())if(!item.expired){item.expired=true;item.reject(new DatasetWorkbenchWireError('NOT_READY'));wbCancel(item)}
      const draining=workbenchRpc('drain',null),quiet=Promise.all([...workbenchPending.values()].map(item=>item.quiet))
      try{await draining}finally{await quiet}
    },
    fatalDrain() {
      if (!failed) return Promise.reject(new DatasetOwnerTransportError('not-sent'));
      if (fatalDrainFlight !== undefined) return fatalDrainFlight;
      closing = true; sealLocalSources();
      fatalDrainFlight = physicalExit.then(code => {
        if (code !== 0) throw new DatasetOwnerTransportError('unknown');
      });
      void fatalDrainFlight.catch(() => undefined);
      // failed 后的旧 close 可能立即 not-sent；只有实际 post 过的关闭请求才禁止本次关闭派发。
      // 不重新发送领域命令、不信任故障通道 ACK，也不从线程结束推导原操作成功。
      if (!exited && !closePostAttempted) {
        closePostAttempted = true;
        const message: DatasetOwnerRequest = {
          version: DATASET_OWNER_PROTOCOL_VERSION, type: 'request', epoch, requestId: randomUUID(),
          sequence: ++sequence, operation: 'close',
        };
        try { worker.postMessage(message); }
        catch { /* 关闭发送仍未知；继续等待真实退出，不二发、不 terminate。 */ }
      }
      return fatalDrainFlight;
    },
    prepare() {
      if (closing || failed || exited) return Promise.reject(new DatasetOwnerTransportError('not-sent'));
      preparation ??= rpc('prepare').then(value => {
        if (!isDatasetOwnerIdentity(value)) throw new DatasetOwnerTransportError('unknown');
        identity = value; return value;
      });
      return preparation;
    },
    materializeMBEdition(request) {
      if(!identity||!bootCommitted||queueLoading||closing||failed||exited||!isMBEditionQueueRequest(request))return Promise.reject(new DatasetOwnerTransportError('not-sent'));
      queueLoading=true;return rpc('materializeMBEdition',undefined,identity.datasetId,undefined,undefined,request).then(value=>value as MBEditionQueueSnapshot).finally(()=>{queueLoading=false;});
    },
    loadMBQueue() {
      if (!identity || !bootCommitted || queueLoading || closing || failed || exited) return Promise.reject(new DatasetOwnerTransportError('not-sent'));
      queueLoading = true;
      return rpc('loadMBQueue', undefined, identity.datasetId).then(value => value as MBQueueLoadResult).finally(() => { queueLoading = false; });
    },
    saveMBQueue(request) {
      if (!identity || !bootCommitted || queueSaving || closing || failed || exited || !isMBQueueSaveRequest(request) || request.queue.datasetId !== identity.datasetId) return Promise.reject(new DatasetOwnerTransportError('not-sent'));
      queueSaving = true;
      return rpc('saveMBQueue', undefined, identity.datasetId, undefined, structuredClone(request)).then(value => value as MBQueueRecord).finally(() => { queueSaving = false; });
    },
    mobileMain(request) {
      if (!identity || !bootCommitted || closing || failed || exited || !isMobileOwnerPrivateRequest(request) || request.datasetId !== identity.datasetId) return Promise.reject(new DatasetOwnerTransportError('not-sent'));
      return rpc('mobileMain', undefined, identity.datasetId, undefined, undefined, undefined, request).then(value => value as MobileOwnerPrivateResult);
    },
    readLocalAlbum(request) {
      localAlbumPhase('client.guard');
      if (!identity || !bootCommitted || closing || failed || exited || !isLocalAlbumOwnerReadRequest(request)) { const error = new DatasetOwnerTransportError('not-sent'); localAlbumReject(error); return Promise.reject(error); }
      return rpc('localAlbumRead', undefined, identity.datasetId, undefined, undefined, undefined, undefined, structuredClone(request)).then(value => value as LocalAlbumOwnerReadResult);
    },
    sealLocalSources,
    isLocalSourceCurrent: () => localAlive && !closing && !failed && !exited && identity !== undefined && bootCommitted,
    captureLocalSource(selection) {
      if (!localAlive || !identity || !bootCommitted || closing || failed || exited) return Promise.reject(new DatasetOwnerTransportError('not-sent'));
      return rpc('captureLocalSource',undefined,identity.datasetId,{selection}).then(value => value as LocalSourceCaptureResult);
    },
    revalidateLocalSource(ticketId) {
      if (!localAlive || !identity || !localFences.has(ticketId)) return Promise.resolve(false);
      return rpc('revalidateLocalSource',undefined,identity.datasetId,{ticketId}).then(value => value as boolean);
    },
    async releaseLocalSource(ticketId) {
      const fence=localFences.get(ticketId); if (!fence) return; fence.revoke(); fence.assertQuiet();
      if (!identity || failed || exited) { localFences.delete(ticketId); return; }
      await rpc('releaseLocalSource',undefined,identity.datasetId,{ticketId}); localFences.delete(ticketId);
    },
    dispatch(request) {
      try {
        if (isLocalRelocationPlanCommand(Object.getOwnPropertyDescriptor(request,'command')?.value) || isLocalSourceWritesCommand(Object.getOwnPropertyDescriptor(request,'command')?.value) || isLocalLegacyLinksCommand(Object.getOwnPropertyDescriptor(request,'command')?.value)) {
          const validated=validateIpcRequest(request);
          if(!validated.ok)return Promise.reject(new DatasetOwnerDispatchError(responseFailure('local-legacy-links','INVALID_IPC_REQUEST','本地旧库关联请求无效。')));
          request=validated.value as IpcRequest;
        }
      } catch { return Promise.reject(new DatasetOwnerDispatchError(responseFailure('local-legacy-links','INVALID_IPC_REQUEST','本地旧库关联请求无效。'))); }
      const { id, command } = request;
      if (identity === undefined || closing || failed || exited) return Promise.reject(new DatasetOwnerTransportError('not-sent', id, command));
      if (!isDatasetRequestEnvelope(request)) return Promise.reject(new DatasetOwnerDispatchError(responseFailure(id, 'INVALID_IPC_REQUEST', '领域命令不在允许范围或信封无效。')));
      if ((isLocalRelocationPlanCommand(command) || isLocalLegacyLinksCommand(command) || isLocalArtworkCommand(command) || isLocalCatalogCommand(command) || isLocalScanCommand(command) || isLocalRelocationCommand(command)) && !validateIpcRequest(request).ok) return Promise.reject(new DatasetOwnerDispatchError(responseFailure(id, 'INVALID_IPC_REQUEST', '本地目录请求无效。')));
      return rpc('dispatch', request);
    },
    dispatchInternal(request) {
      const { id, command } = request;
      if (identity === undefined || closing || failed || exited) return Promise.reject(new DatasetOwnerTransportError('not-sent', id, command));
      if (!(isLocalArtworkInternalCommand(command) || isLocalCatalogInternalCommand(command) || isLocalScanInternalCommand(command) || isLocalRelocationInternalCommand(command)) || !isDatasetRequestEnvelope(request, true) || !validateIpcInternalRequest(request).ok) return Promise.reject(new DatasetOwnerDispatchError(responseFailure(id, 'INVALID_IPC_REQUEST', '可信本地观察请求无效。')));
      return rpc('dispatchInternal', request);
    },
    commitBoot() {
      if (identity === undefined || closing || failed || exited) return Promise.reject(new DatasetOwnerTransportError('not-sent'));
      commitment ??= rpc('commitBoot').then(() => { bootCommitted = true; });
      return commitment;
    },
    exportCollectionSnapshot() {
      if (identity === undefined || !bootCommitted || exporting || closing || failed || exited) return Promise.reject(new DatasetOwnerTransportError('not-sent'));
      exporting = true;
      return rpc('exportCollectionSnapshot', undefined, identity.datasetId).then(value => value as DatasetCollectionSnapshot).finally(() => { exporting = false; });
    },
    getCollectionSnapshotVersion() {
      if (identity === undefined || !bootCommitted || closing || failed || exited) return Promise.reject(new DatasetOwnerTransportError('not-sent'));
      return rpc('getCollectionSnapshotVersion', undefined, identity.datasetId).then(value => value as DatasetCollectionSnapshotVersion);
    },
    exportVersionedCollectionSnapshot() {
      if (identity === undefined || !bootCommitted || exporting || closing || failed || exited) return Promise.reject(new DatasetOwnerTransportError('not-sent'));
      exporting = true;
      return rpc('exportVersionedCollectionSnapshot', undefined, identity.datasetId).then(value => value as DatasetVersionedCollectionSnapshot).finally(() => { exporting = false; });
    },
    exportLargeVersionedCollectionSnapshot() {
      if (identity === undefined || !bootCommitted || exporting || closing || failed || exited) return Promise.reject(new DatasetOwnerTransportError('not-sent'));
      exporting = true;
      return rpc('exportLargeVersionedCollectionSnapshot', undefined, identity.datasetId).then(value => value as DatasetVersionedCollectionSnapshot).finally(() => { exporting = false; });
    },
    close() {
      if (closure !== undefined) return closure;
      closing = true; sealLocalSources();
      // 发close即封入口；owner先停止coordinator，再等待在途dispatch，然后关闭连接。
      closure = rpc('close').then(() => naturalExit);
      return closure;
    },
  };
}
