import { captureLocalAlbumContext, withLocalAlbumContext, runLocalAlbumContext, localAlbumPhase, localAlbumMatch, localAlbumReject, localAlbumRejectCode, emitLocalAlbumNodeTrace, localAlbumLink, type LocalAlbumNodeContext } from '../shared/local-album-read-trace-node.js';
import { createMobileCapabilityContext, withMobileCapabilityContext, mobileCapabilityAsync, mobileCapabilityReject, closeMobileCapabilityContext } from '../mobile/capability-trace.js';
import { consumeSourceWorkbenchDirectoryReply, isSourceWorkbenchDirectoryWire, captureSourceWorkbenchDirectoryRegistrationRequest, captureSourceWorkbenchDirectoryRegistrationReply, captureSourceWorkbenchDirectoryRegistration, invalidateSourceWorkbenchDirectory, type SourceWorkbenchDirectoryOwnerDomain } from './source-writes-authority.js';
import { lyricsPhysicalDigest as directoryDigest } from '../library/lyrics-source-format.js';
import { isDatasetWorkbenchOwnerRequest, isDatasetWorkbenchOwnerResult, isDatasetWorkbenchOwnerScope, type DatasetWorkbenchOwnerRequest, type DatasetWorkbenchOwnerResult, type DatasetWorkbenchOwnerCommand, type DatasetWorkbenchOwnerPayloads, type DatasetWorkbenchOwnerResults, DATASET_WORKBENCH_BOUNDS, isDatasetWorkbenchContext, isDatasetWorkbenchRequest, isDatasetWorkbenchResult, isDatasetWorkbenchFrame, datasetWorkbenchMeta, sameDatasetWorkbenchMeta, datasetWorkbenchJson, datasetWorkbenchSha, datasetWorkbenchFrames, datasetWorkbenchControl, createDatasetWorkbenchAssembler, DatasetWorkbenchWireError, type DatasetWorkbenchMeta, type DatasetWorkbenchRequest, type DatasetWorkbenchResult, type DatasetWorkbenchContext } from './dataset-owner-protocol.js';
import { MBQueueStoreError } from './mb-queue-store.js';
import {LocalSourcePreparationError} from '../application/local-source-resolver.js';
import { LocalFactsCommitFatal } from '../stream/local-source-fence.js';
import { LOCAL_RELOCATION_COMMANDS, isLocalArtworkInternalCommand, isLocalRelocationCommand, isLocalRelocationInternalCommand, isLocalRelocationCommandResult } from '@music-bridge/contracts';
import { randomUUID } from 'node:crypto';
import type { MessagePort } from 'node:worker_threads';
import { localSourceWritesMainRequestSnapshot, localSourceWritesMainResponseSnapshot, type SourceWritesMainRequest } from '@music-bridge/contracts';
import { createSourceWritesMainActor, consumeSourceWorkbenchReadersReply, consumeSourceWritesLyricsGrantReply, isSourceWritesLyricsVerifyWire,captureSourceWritesLyricsVerifyRequest,
  captureSourceWritesLyricsOriginalEvidence,captureSourceWritesLyricsVerifyReply,assertSourceWritesLyricsVerifyForPending,
  type SourceWritesMainActor,type SourceWritesLyricsOriginalEvidence } from './source-writes-authority.js';
import type { LocalLyricsPhysicalBinding } from '../library/lyrics-source-format.js';
import { localRelocationMainRequestSnapshot, localRelocationMainResponseSnapshot, type LocalRelocationMainRequest } from '@music-bridge/contracts';
import { createRelocationMainActor } from './source-relocation-authority.js';
import { validateIpcRequest, validateIpcInternalRequest, isLocalCatalogInternalCommand, isLocalScanInternalCommand, type IpcCommand, type IpcFailure } from '@music-bridge/contracts';
import { failureForError, responseFailure } from '../shared/ipc-failure.js';
import { readDatasetOwnerRequestForCapture } from '../mobile/owner-boundary-capture.js';
import {
  DATASET_OWNER_PROTOCOL_VERSION, DatasetOwnerDispatchError, DatasetOwnerTransportError,
  isDatasetCollectionSnapshot, isDatasetLargeCollectionSnapshot, isDatasetOwnerFailure, isDatasetOwnerIdentity, isDatasetOwnerProjectionResponse,
  isDatasetProjectionPayload, isDatasetProjectionResult, ownerRecord,
  type DatasetOwnerProjectionRequest, type DatasetOwnerRequest, type DatasetOwnerResponse,
  type DatasetProjectionCommand, type DatasetProjectionCommandPayloads, type DatasetProjectionCommandResults,
  type DatasetProjectionPort, type OwnedDatasetDomain,
} from './dataset-owner-protocol.js';

export interface DatasetOwnerWorkerOptions {
  privateSourceWritesPort?:MessagePort;
  privateRelocationMainPort?: MessagePort;
  // factory、converter和helper只在worker本地创建，端口上不接受函数或任意方法名。
  prepare(epoch: string, projection: DatasetProjectionPort, sourceWritesMainActor?: SourceWritesMainActor): Promise<OwnedDatasetDomain>;
}

interface PendingProjection {
  command: DatasetProjectionCommand;
  payload: DatasetProjectionCommandPayloads[DatasetProjectionCommand];
  resolve(result: unknown): void;
  reject(error: unknown): void;
  detach():void;
}

export function attachDatasetOwnerWorkerPort(port: MessagePort, options: DatasetOwnerWorkerOptions): void {
  let epoch: string | undefined;
  let lastSequence = 0;
  let domain: OwnedDatasetDomain | undefined;
  let preparation: Promise<OwnedDatasetDomain> | undefined;
  let commitment: Promise<void> | undefined;
  let bootCommitted = false;
  let boundDatasetId: string | undefined;
  let snapshotStamp: { dataVersion: number; totalChanges: number } | undefined;
  let snapshotRevision: string | undefined;
  let closure: Promise<void> | undefined;
  let closing = false;
  let failed = false;
  let disconnected = false;
  const dispatches = new Set<Promise<unknown>>();
  const projections = new Map<string, PendingProjection>();
  type WorkbenchFlight={meta:DatasetWorkbenchMeta;assembly:ReturnType<typeof createDatasetWorkbenchAssembler>;controller:AbortController;timer:NodeJS.Timeout;running:boolean;expired:boolean;task?:Promise<void>;trace?:LocalAlbumNodeContext|undefined}
  const workbenchFlights=new Map<string,WorkbenchFlight>(),workbenchRetired=new Map<string,DatasetWorkbenchMeta>()
  let workbenchClosing=false,workbenchClosure:Promise<void>|undefined
  function wbPost(frame:unknown):void{post(frame)}
  function wbFailure(item:WorkbenchFlight,code:'INVALID_IPC_REQUEST'|'INVALID_IPC_RESPONSE'|'OUTBOX_SCOPE_MISMATCH'|'NOT_READY'|'TIMEOUT',cause?:{error:unknown}):void{
    if(!item.expired){
      if(item.meta.kind==='context')try{
        const record=()=>{if(cause)localAlbumReject(cause.error,code);else localAlbumRejectCode(code,code)};
        if(item.trace)withLocalAlbumContext(item.trace,record);
        else runLocalAlbumContext(item.meta.id,null,'context.worker.receive',record,false,false);
      }catch{ /* 观测故障不改变原失败帧。 */ }
      item.expired=true;wbPost(datasetWorkbenchControl(item.meta,'failure',code))
    }
  }
  function wbSettle(item:WorkbenchFlight):void{
    clearTimeout(item.timer);workbenchFlights.delete(item.meta.id);workbenchRetired.set(item.meta.id,item.meta)
    if(workbenchRetired.size>1024)workbenchRetired.delete(workbenchRetired.keys().next().value!)
    if(item.expired||item.meta.kind==='context')wbPost(datasetWorkbenchControl(item.meta,'settled'))
  }
  function wbCloseDomain():Promise<void>{
    if(!workbenchClosure){workbenchClosing=true;for(const item of workbenchFlights.values())if(item.meta.kind!=='drain'){item.controller.abort();if(!item.running){wbFailure(item,'NOT_READY');wbSettle(item)}}
      workbenchClosure=Promise.resolve().then(()=>domain?.closeWorkbench?.()).then(async()=>{await Promise.allSettled([...workbenchFlights.values()].filter(item=>item.meta.kind!=='drain').flatMap(item=>item.task?[item.task]:[]))})}
    return workbenchClosure
  }
  async function wbContext(meta:DatasetWorkbenchMeta):Promise<DatasetWorkbenchContext>{
    if(meta.kind==='context')try{localAlbumPhase('context.worker.ready')}catch{}
    if(closing||failed||workbenchClosing||!bootCommitted||!domain?.workbenchContext||!domain.dispatchWorkbench||!domain.dispatchWorkbenchOwner||!domain.closeWorkbench||domain.datasetId!==boundDatasetId||meta.epoch!==epoch||meta.datasetId!==boundDatasetId)throw new DatasetWorkbenchWireError('NOT_READY','not-sent')
    if(meta.kind==='context')try{localAlbumPhase('context.worker.owner')}catch{}
    const value=await domain.workbenchContext()
    if(meta.kind==='context')try{localAlbumPhase('context.worker.dto')}catch{}
    if(!isDatasetWorkbenchContext(value)||value.epoch!==epoch||value.datasetId!==boundDatasetId||closing||failed||workbenchClosing||domain.datasetId!==boundDatasetId)throw new DatasetWorkbenchWireError('OUTBOX_SCOPE_MISMATCH')
    return value
  }
  function wbReceive(raw:unknown):void{
    if(!isDatasetWorkbenchFrame(raw)||raw.epoch!==epoch||raw.lane==='response'){protocolFailure();return}
    const receive=()=>{
    let item=workbenchFlights.get(raw.id)
    if(raw.lane==='control'){
      if(!item){const retired=workbenchRetired.get(raw.id);if(retired&&sameDatasetWorkbenchMeta(raw,retired)){wbPost(datasetWorkbenchControl(retired,'settled'));return}protocolFailure();return}
      if(!sameDatasetWorkbenchMeta(raw,item.meta)){protocolFailure();return}
      item.controller.abort();wbFailure(item,'TIMEOUT');if(!item.running)wbSettle(item);return
    }
    if(raw.part==='begin'){
      if(item||workbenchRetired.has(raw.id)||raw.sequence!==lastSequence+1){protocolFailure();return}
      lastSequence=raw.sequence
      const meta=datasetWorkbenchMeta(raw),controller=new AbortController(),remaining=Math.min(2000,meta.expiresAtMs-Date.now())
      const flight:WorkbenchFlight={meta,assembly:createDatasetWorkbenchAssembler(meta,'request'),controller,timer:undefined as unknown as NodeJS.Timeout,running:false,expired:false}
      if(meta.kind==='context')try{flight.trace=captureLocalAlbumContext()}catch{ /* 仅旁注。 */ }
      item=flight;workbenchFlights.set(raw.id,flight)
      flight.timer=setTimeout(()=>{controller.abort();wbFailure(flight,'TIMEOUT');if(!flight.running)wbSettle(flight)},Math.max(1,remaining))
      if(remaining<=0||workbenchFlights.size>24){if(meta.kind==='context')try{localAlbumPhase('context.worker.ready')}catch{}wbFailure(flight,remaining<=0?'TIMEOUT':'NOT_READY');wbSettle(flight);return}
    }
    if(!item){if(workbenchRetired.has(raw.id))return;protocolFailure();return}
    if(item.running||!sameDatasetWorkbenchMeta(raw,item.meta)){protocolFailure();return}
    if(item.meta.kind==='context')try{item.trace=captureLocalAlbumContext()}catch{ /* 仅旁注。 */ }
    try{
      const body=item.assembly.accept(raw);if(body===undefined)return
      if(datasetWorkbenchSha(datasetWorkbenchJson(body))!==item.meta.requestSha256)throw new DatasetWorkbenchWireError('INVALID_IPC_REQUEST')
      if(item.meta.kind==='execute'&&!isDatasetWorkbenchRequest(body)||item.meta.kind==='owner'&&!isDatasetWorkbenchOwnerRequest(body)||!['execute','owner'].includes(item.meta.kind)&&(!ownerRecord(body)||Reflect.ownKeys(body).length!==0))throw new DatasetWorkbenchWireError('INVALID_IPC_REQUEST')
      const flight=item;flight.running=true
      const task=Promise.resolve().then(async()=>{
        let result:unknown
        if(flight.meta.kind==='drain'){
          if(!bootCommitted||flight.meta.epoch!==epoch||flight.meta.datasetId!==boundDatasetId||!domain?.closeWorkbench)throw new DatasetWorkbenchWireError('NOT_READY')
          await wbCloseDomain();result={closed:true}
        }else{
          const identity=await wbContext(flight.meta)
          if(flight.controller.signal.aborted||Date.now()>=flight.meta.expiresAtMs)throw new DatasetWorkbenchWireError('TIMEOUT')
          if(flight.meta.kind==='context')result=identity
          else if(flight.meta.kind==='owner'){
            if(!isDatasetWorkbenchOwnerRequest(body)||!isDatasetWorkbenchOwnerScope(body,identity.datasetId))throw new DatasetWorkbenchWireError('OUTBOX_SCOPE_MISMATCH')
            result=await domain!.dispatchWorkbenchOwner!(structuredClone(body),{identity:Object.freeze({epoch:identity.epoch,datasetId:identity.datasetId}),signal:flight.controller.signal,deadlineAtMs:performance.now()+Math.max(0,flight.meta.expiresAtMs-Date.now())})
            await wbContext(flight.meta)
            if(!isDatasetWorkbenchOwnerResult(body.command,result,body.payload,identity.datasetId))throw new DatasetWorkbenchWireError('INVALID_IPC_RESPONSE')
          }else{
            const request=body as DatasetWorkbenchRequest
            if(request.family==='lyrics'&&('scope'in request.payload&&request.payload.scope.datasetId!==identity.datasetId||'library'in request.payload&&request.payload.library.datasetId!==identity.datasetId))throw new DatasetWorkbenchWireError('OUTBOX_SCOPE_MISMATCH')
            result=await domain!.dispatchWorkbench!(structuredClone(request),{identity:Object.freeze({epoch:identity.epoch,datasetId:identity.datasetId}),signal:flight.controller.signal,deadlineAtMs:performance.now()+Math.max(0,flight.meta.expiresAtMs-Date.now())})
            await wbContext(flight.meta)
            if(!isDatasetWorkbenchResult(request,result,identity.datasetId))throw new DatasetWorkbenchWireError('INVALID_IPC_RESPONSE')
          }
        }
        if(flight.expired||flight.controller.signal.aborted||Date.now()>=flight.meta.expiresAtMs)throw new DatasetWorkbenchWireError('TIMEOUT')
        if(flight.meta.kind==='context')try{localAlbumPhase('context.worker.reply')}catch{}
        for(const frame of datasetWorkbenchFrames(flight.meta,'response',result))wbPost(frame)
      }).catch(error=>{wbFailure(flight,error instanceof DatasetWorkbenchWireError?error.code:'NOT_READY',{error})}).finally(()=>{dispatches.delete(task);wbSettle(flight)})
      flight.task=task;dispatches.add(task)
    }catch(error){wbFailure(item,error instanceof DatasetWorkbenchWireError?error.code:'INVALID_IPC_REQUEST',{error});wbSettle(item)}
    };
    if(raw.kind==='context')runLocalAlbumContext(raw.id,null,'context.worker.receive',receive,false,false);else receive();
  }
  const sourcePort=options.privateSourceWritesPort,sourceActor=sourcePort?createSourceWritesMainActor(sourcePort):undefined;
  let sourceSequence=0,sourceRequests=0;
  let directoryRegistrationSequence=0;
  let lyricsVerifySequence=0;
  async function receiveSource(raw:unknown):Promise<void>{
    try{if(sourceActor&&consumeSourceWorkbenchReadersReply(sourceActor,raw))return;}catch{sourcePort?.close();return;}
    // 同一专用MessagePort的实际回包先由actor私有监听消费并留品牌；普通dispatch不接触歌词grant。
    try{if(sourceActor&&consumeSourceWorkbenchDirectoryReply(sourceActor,raw))return;}catch{sourcePort?.close();return;}
    try{if(sourceActor&&consumeSourceWritesLyricsGrantReply(sourceActor,raw))return;}catch{sourcePort?.close();return;}
    if(isSourceWorkbenchDirectoryWire(raw,'registration-request')){
      let q:import('./source-writes-authority.js').SourceWorkbenchDirectoryRegistrationRequest;try{q=captureSourceWorkbenchDirectoryRegistrationRequest(raw)}catch{sourcePort?.close();return;}
      const controller=new AbortController(),deadlineAtMs=performance.now()+Math.min(2000,q.expiresAtMs-Date.now());
      if(q.sequence!==directoryRegistrationSequence+1||q.expiresAtMs<=Date.now()||q.expiresAtMs>Date.now()+2000){sourcePort?.close();return;}directoryRegistrationSequence=q.sequence;
      const abort=()=>controller.abort();sourcePort?.once('close',abort);const timer=setTimeout(abort,Math.max(1,deadlineAtMs-performance.now()));let response:unknown;
      try{
        const actual=domain as (OwnedDatasetDomain&Partial<SourceWorkbenchDirectoryOwnerDomain>)|undefined;
        if(closing||failed||!bootCommitted||!sourceActor||!epoch||!boundDatasetId||actual?.datasetId!==boundDatasetId||q.binding.datasetId!==boundDatasetId||q.binding.ownerEpoch!==epoch||sourceRequests>=4||!actual.registerWorkbenchDirectory||!actual.revokeWorkbenchDirectory)throw Error('目录Owner尚未就绪。');
        const context={identity:Object.freeze({epoch,datasetId:boundDatasetId}),mainActor:sourceActor,signal:controller.signal,deadlineAtMs};sourceRequests++;
        const work=Promise.resolve().then<unknown>(()=>q.command==='register'?actual.registerWorkbenchDirectory!(q.binding,context):actual.revokeWorkbenchDirectory!(q.binding,context));dispatches.add(work);
        let result:unknown;try{result=await work;}finally{dispatches.delete(work);sourceRequests--;}
        if(controller.signal.aborted||closing||failed||Date.now()>=q.expiresAtMs)throw Error('目录原回复已迟到。');
        if(q.command==='register')captureSourceWorkbenchDirectoryRegistration(result,q.binding);else invalidateSourceWorkbenchDirectory(sourceActor,q.binding);
        response=captureSourceWorkbenchDirectoryRegistrationReply({version:1,type:'workbench-directory-registration-reply',purpose:'WORKBENCH_DIRECTORY',requestId:q.requestId,sequence:q.sequence,command:q.command,binding:q.binding,requestSha256:directoryDigest(q),ok:true,result});
      }catch{
        response=captureSourceWorkbenchDirectoryRegistrationReply({version:1,type:'workbench-directory-registration-reply',purpose:'WORKBENCH_DIRECTORY',requestId:q.requestId,sequence:q.sequence,command:q.command,binding:q.binding,requestSha256:directoryDigest(q),ok:false,failure:'NOT_READY'});
      }finally{clearTimeout(timer);sourcePort?.off('close',abort)}
      if(!controller.signal.aborted&&Date.now()<q.expiresAtMs)sourcePort?.postMessage(response);return;
    }
    if(isSourceWritesLyricsVerifyWire(raw,'request')){
      try{
        const request=captureSourceWritesLyricsVerifyRequest(raw);
        const author=domain as (OwnedDatasetDomain&{readLyricsGrantOriginal?:(binding:LocalLyricsPhysicalBinding,revision:number,context:{identity:Readonly<{epoch:string;datasetId:string}>;mainActor:SourceWritesMainActor})=>SourceWritesLyricsOriginalEvidence|Promise<SourceWritesLyricsOriginalEvidence>})|undefined;
        if(closing||failed||!bootCommitted||!sourceActor||!epoch||!boundDatasetId||author?.datasetId!==boundDatasetId||!author.readLyricsGrantOriginal
          ||sourceRequests>=4||request.epoch!==epoch||request.datasetId!==boundDatasetId||request.sequence!==lyricsVerifySequence+1)throw new Error('歌词原账本验证入口无效。');
        assertSourceWritesLyricsVerifyForPending(sourceActor,request);lyricsVerifySequence=request.sequence;sourceRequests++;
        const actualIdentity=Object.freeze({epoch,datasetId:boundDatasetId}),actor=sourceActor;
        const dispatch=Promise.resolve().then(()=>author.readLyricsGrantOriginal!(request.grantRequest.binding,request.grantRequest.revision,{identity:actualIdentity,mainActor:actor}));dispatches.add(dispatch);
        let result:SourceWritesLyricsOriginalEvidence;try{result=captureSourceWritesLyricsOriginalEvidence(await dispatch);}finally{dispatches.delete(dispatch);sourceRequests--;}
        if(closing||failed||Date.now()>=request.grantRequest.expiresAtMs||result.currentOwnerEpoch!==epoch||result.jobOrigin&&!['queued','running'].includes(result.jobOrigin.phase))throw new Error('歌词原只读验证已过期或批次停止。');
        const response=captureSourceWritesLyricsVerifyReply({version:1,type:'lyrics-source-verify-reply',purpose:'LYRICS',requestId:request.requestId,sequence:request.sequence,epoch,datasetId:boundDatasetId,
          grantRequestId:request.grantRequest.requestId,authorityId:sourceActor.authorityId,binding:request.grantRequest.binding,bindingSha256:request.grantRequest.bindingSha256,revision:request.grantRequest.revision,result});
        sourcePort?.postMessage(response);
      }catch{sourcePort?.close();}return;
    }
    let request:SourceWritesMainRequest;try{request=localSourceWritesMainRequestSnapshot(raw);}catch{sourcePort?.close();return;}
    if(request.sequence!==sourceSequence+1){sourcePort?.close();return;}sourceSequence=request.sequence;
    let result:unknown;let failure:IpcFailure|undefined;
    try{if(closing||failed||!bootCommitted||!domain?.dispatchSourceWritesMain||request.payload.datasetId!==boundDatasetId||!sourceActor||sourceRequests>=4)throw new DatasetOwnerDispatchError(responseFailure(request.requestId,'NOT_READY','源写专用 Owner 入口尚未就绪。'));sourceRequests++;
      const dispatch=domain.dispatchSourceWritesMain(request,sourceActor);dispatches.add(dispatch);try{result=await dispatch;}finally{dispatches.delete(dispatch);sourceRequests--;}
    }catch(error){if(error instanceof LocalFactsCommitFatal){domain?.sealLocalSources?.();protocolFailure();return;}failure=projectFailure(request.requestId,error,'localSourceWrites.confirm');}
    const response={version:1 as const,type:'source-writes-response' as const,requestId:request.requestId,sequence:request.sequence,...(failure?{ok:false as const,failure}:{ok:true as const,result})};
    try{sourcePort?.postMessage(localSourceWritesMainResponseSnapshot(response,request.command));}catch{sourcePort?.close();}
  }
  if(sourcePort){sourcePort.on('message',raw=>{void receiveSource(raw).catch(()=>sourcePort.close());});sourcePort.on('messageerror',()=>sourcePort.close());sourcePort.start();}
  const relocationPort = options.privateRelocationMainPort, relocationActor = relocationPort ? createRelocationMainActor(relocationPort) : undefined;
  let relocationSequence = 0, relocationRequests = 0;
  async function receiveRelocation(raw: unknown): Promise<void> {
    let request: LocalRelocationMainRequest;
    try { request = localRelocationMainRequestSnapshot(raw); } catch { relocationPort?.close(); return; }
    if (request.sequence !== relocationSequence + 1) { relocationPort?.close(); return; }
    relocationSequence = request.sequence;
    let result: unknown, failure: IpcFailure | undefined;
    try {
      if (closing || failed || !bootCommitted || !domain?.dispatchRelocationMain || request.payload.datasetId !== boundDatasetId || !relocationActor || relocationRequests >= 4)
        throw new DatasetOwnerDispatchError(responseFailure(request.requestId, 'NOT_READY', '搬迁专用Owner入口尚未就绪。'));
      relocationRequests++;
      const dispatch = domain.dispatchRelocationMain(request, relocationActor); dispatches.add(dispatch);
      try { result = await dispatch; } finally { dispatches.delete(dispatch); relocationRequests--; }
    } catch (error) {
      if (error instanceof LocalFactsCommitFatal) { domain?.sealLocalSources?.(); protocolFailure(); return; }
      failure = projectFailure(request.requestId, error, 'localRelocationPlan.confirm');
    }
    const response = { version: 1 as const, type: 'relocation-main-response' as const, requestId: request.requestId, sequence: request.sequence,
      ...(failure ? { ok: false as const, failure } : { ok: true as const, result }) };
    try { relocationPort?.postMessage(localRelocationMainResponseSnapshot(response, request.command)); } catch { relocationPort?.close(); }
  }
  if (relocationPort) {
    relocationPort.on('message', raw => { void receiveRelocation(raw).catch(() => relocationPort.close()); });
    relocationPort.on('messageerror', () => relocationPort.close()); relocationPort.start();
  }

  function readSnapshotStamp(): { dataVersion: number; totalChanges: number } {
    if (domain?.readonlySnapshotStamp === undefined) throw new DatasetOwnerDispatchError(responseFailure('snapshot-version', 'NOT_READY', '收藏快照版本尚未就绪。'));
    if (domain.datasetId !== boundDatasetId) throw new DatasetOwnerDispatchError(responseFailure('snapshot-version', 'OUTBOX_SCOPE_MISMATCH', '收藏快照不属于当前工作库。'));
    const stamp = domain.readonlySnapshotStamp();
    if (domain.datasetId !== boundDatasetId || !ownerRecord(stamp) || Object.keys(stamp).some(key => !['dataVersion', 'totalChanges'].includes(key))
      || !Number.isSafeInteger(stamp.dataVersion) || stamp.dataVersion < 0 || !Number.isSafeInteger(stamp.totalChanges) || stamp.totalChanges < 0) {
      throw new DatasetOwnerDispatchError(responseFailure('snapshot-version', 'INVENTORY_UNAVAILABLE', '收藏快照版本无效。'));
    }
    // 固定本次观测值，不能让领域返回的可变对象改写导出前的戳。
    return { dataVersion: stamp.dataVersion, totalChanges: stamp.totalChanges };
  }
  function sameStamp(left: { dataVersion: number; totalChanges: number }, right: { dataVersion: number; totalChanges: number }): boolean {
    return left.dataVersion === right.dataVersion && left.totalChanges === right.totalChanges;
  }
  function observeSnapshotStamp(stamp: { dataVersion: number; totalChanges: number }): void {
    if (snapshotStamp === undefined || !sameStamp(snapshotStamp, stamp)) {
      snapshotStamp = { ...stamp };
      snapshotRevision = randomUUID();
    }
  }

  function projectFailure(id: string, error: unknown, command?: IpcCommand): IpcFailure {
    if(error instanceof LocalSourcePreparationError && error.code==='SEGMENT_UNSUPPORTED')return responseFailure(id,'INVALID_IPC_REQUEST','[LOCAL_SEGMENT_UNSUPPORTED] 本地点播当前仅支持整文件，CUE/segment尚未支持。');
    const failure = error instanceof DatasetOwnerDispatchError ? { ...error.failure, id }
      : domain === undefined ? failureForError(id, error, command ?? 'physicalLinks.search') : domain.failureForError(id, error, command);
    return isDatasetOwnerFailure(failure) ? failure : responseFailure(id, 'INTERNAL_ERROR', '领域操作失败。');
  }

  function post(message: unknown): boolean {
    if (disconnected) return false;
    try { port.postMessage(message); return true; }
    catch { disconnected = true; abandon(); return false; }
  }

  function reply(request: DatasetOwnerRequest, result: unknown): void {
    const message: DatasetOwnerResponse = { version: DATASET_OWNER_PROTOCOL_VERSION, type: 'response', epoch: request.epoch, requestId: request.requestId, operation: request.operation, ok: true, result };
    post(message);
  }
  function reject(request: DatasetOwnerRequest, error: unknown): void {
    if (request.operation === 'localAlbumRead') localAlbumReject(error);
    mobileCapabilityReject('owner.rpc.failure', error);
    if(error instanceof LocalFactsCommitFatal || error instanceof MBQueueStoreError && error.code === 'QUEUE_COMMIT_UNKNOWN'){domain?.sealLocalSources?.();protocolFailure();return;}
    const message: DatasetOwnerResponse = { version: DATASET_OWNER_PROTOCOL_VERSION, type: 'response', epoch: request.epoch, requestId: request.requestId, operation: request.operation, ok: false,
      failure: projectFailure(request.request?.id ?? request.requestId, error, request.request?.command) };
    post(message);
  }

  const projection: DatasetProjectionPort = {
    call<K extends DatasetProjectionCommand>(command: K, payload: DatasetProjectionCommandPayloads[K], read?:{signal?:AbortSignal;deadlineAtMs?:number}): Promise<DatasetProjectionCommandResults[K]> {
      if (epoch === undefined || failed || disconnected || !isDatasetProjectionPayload(command, payload)) return Promise.reject(new DatasetOwnerTransportError('not-sent'));
      const projectionRequestId = randomUUID();
      const remaining=command==='normalizeLocalAlbumArtwork'&&read?Math.min(2000,Math.floor((read.deadlineAtMs??performance.now()+2000)-performance.now())):undefined;
      if(read?.signal?.aborted||remaining!==undefined&&remaining<=0)return Promise.reject(new DatasetWorkbenchWireError('TIMEOUT'));
      const expiresAtMs=remaining===undefined?undefined:Date.now()+remaining;
      return new Promise((resolve, reject) => {
        let timer:ReturnType<typeof setTimeout>|undefined,cancelled=false;
        const detach=()=>{if(timer)clearTimeout(timer);read?.signal?.removeEventListener('abort',abort)};
        const abort=()=>{if(cancelled)return;cancelled=true;reject(new DatasetWorkbenchWireError('TIMEOUT'));
          // 已派发投影仍保原槽位至真实响应；取消不能使迟到结果完成旧 read。
          if(expiresAtMs!==undefined)post({version:DATASET_OWNER_PROTOCOL_VERSION,type:'projection-cancel',epoch,projectionRequestId,command:'normalizeLocalAlbumArtwork',expiresAtMs});};
        projections.set(projectionRequestId, { command, payload, resolve: result => resolve(result as DatasetProjectionCommandResults[K]), reject,detach });
        const message: DatasetOwnerProjectionRequest = { version: DATASET_OWNER_PROTOCOL_VERSION, type: 'projection', epoch: epoch!, projectionRequestId, command, payload,...(expiresAtMs===undefined?{}:{read:{expiresAtMs}}) };
        if (!post(message)) {
          projections.delete(projectionRequestId);detach();
          reject(new DatasetOwnerTransportError('unknown'));return;
        }
        if(expiresAtMs!==undefined){read?.signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(abort,Math.max(1,expiresAtMs-Date.now()));if(read?.signal?.aborted)abort();}
      });
    },
  };

  function rejectProjections(): void {
    for (const item of projections.values()) {item.detach();item.reject(new DatasetOwnerTransportError('unknown'));}
    projections.clear();
  }
  async function beforeConnectionClose(): Promise<void> {
    // 封入口后不会增加dispatch；commit也可能持有事务，因此一并等它收口。
    await Promise.allSettled([...dispatches, ...(commitment === undefined ? [] : [commitment])]);
  }
  function closeDomain(): Promise<void> {
    closing = true; domain?.sealLocalSources?.();
    closure ??= (async () => {
      if (preparation !== undefined) {
        try { await preparation; } catch { /* 准备失败的factory负责回滚和释放自身资源。 */ }
      }
      await wbCloseDomain();
      if (domain !== undefined) await domain.close(beforeConnectionClose);
      else await beforeConnectionClose();
      if (projections.size !== 0) throw new Error('领域关闭时仍有元数据投影未收口。');
    })();
    return closure;
  }
  function abandon(): void {
    failed = true;
    rejectProjections();
    // 父端断链仍先停止coordinator并等待已发请求，禁止中断数据库事务。
    void closeDomain().then(() => { port.off('message', receive); sourcePort?.close(); relocationPort?.close(); port.close(); }, () => undefined);
  }
  function protocolFailure(): void {
    if (failed) return;
    if (epoch !== undefined) post({ version: DATASET_OWNER_PROTOCOL_VERSION, type: 'fatal', epoch, reason: 'protocol-failure' });
    abandon();
  }

  async function handleOriginal(request: DatasetOwnerRequest, capture: () => DatasetOwnerRequest): Promise<void> {
    if (request.operation === 'close') {
      try {
        await closeDomain();
        reply(request, undefined);
        port.off('message', receive);
        sourcePort?.close(); relocationPort?.close(); port.close(); // closed确认后让worker自然退出；不调用process.exit/terminate。
      } catch (error) {
        reject(request, error);
        post({ version: DATASET_OWNER_PROTOCOL_VERSION, type: 'fatal', epoch, reason: 'close-failed' });
        failed = true;
      }
      return;
    }
    if (closing || failed) { reject(request, new DatasetOwnerDispatchError(responseFailure(request.request?.id ?? request.requestId, 'NOT_READY', '领域所有者正在关闭。'))); return; }
    if (request.operation === 'prepare') {
      try {
        preparation ??= Promise.resolve().then(() => options.prepare(request.epoch, projection, sourceActor)).then(prepared => {
          if (!isDatasetOwnerIdentity({ epoch: request.epoch, datasetId: prepared.datasetId })) throw new Error('领域身份无效。');
          domain = prepared; boundDatasetId = prepared.datasetId; return prepared;
        });
        const prepared = await preparation;
        reply(request, { epoch: request.epoch, datasetId: prepared.datasetId });
      } catch (error) { reject(request, error); }
      return;
    }
    if (domain === undefined) { reject(request, new DatasetOwnerDispatchError(responseFailure(request.request?.id ?? request.requestId, 'NOT_READY', '领域所有者尚未准备完成。'))); return; }
    if (request.operation === 'commitBoot') {
      try {
        commitment ??= Promise.resolve().then(async () => {
          await domain!.commitBoot();
          // 旧领域mock仍可boot；版本操作只在成功boot且具备同连接戳时开放。
          if (domain!.readonlySnapshotStamp !== undefined) observeSnapshotStamp(readSnapshotStamp());
        });
        await commitment; bootCommitted = true; reply(request, undefined);
      }
      catch (error) { reject(request, error); }
      return;
    }
    if (request.operation === 'localAlbumRead') {
      try {
        localAlbumPhase('worker.guard');
        if (!bootCommitted || request.expectedDatasetId !== boundDatasetId || domain.datasetId !== boundDatasetId || !domain.readLocalAlbum || !request.album) throw new DatasetOwnerTransportError('not-sent');
        localAlbumMatch('dataset', true);
        localAlbumPhase('worker.read'); const operation = domain.readLocalAlbum(request.album); dispatches.add(operation);
        try {
          const result = await operation;
          try { localAlbumPhase('worker.await'); emitLocalAlbumNodeTrace('ok'); }
          catch { /* 私有计时失败不替换原领域结果。 */ }
          finally { try { localAlbumPhase('worker.read'); } catch { /* 只恢复原阶段，不制造业务错误。 */ } }
          localAlbumPhase('worker.reply');
          try { localAlbumPhase('worker.post'); emitLocalAlbumNodeTrace('begin'); }
          catch { /* 私有计时失败不阻止原reply。 */ }
          finally { try { localAlbumPhase('worker.reply'); } catch { /* 原post异常仍归原回复阶段。 */ } }
          reply(request, result); emitLocalAlbumNodeTrace('ok');
        } finally { dispatches.delete(operation); }
      } catch (error) { reject(request, error); }
      return;
    }
    if (request.operation === 'mobileMain') {
      try {
        if (!bootCommitted || request.expectedDatasetId !== boundDatasetId || domain.datasetId !== boundDatasetId || !domain.mobileMain || !request.mobile) throw new DatasetOwnerTransportError('not-sent');
        let captured: DatasetOwnerRequest;
        try { captured = capture(); }
        catch { throw new DatasetOwnerTransportError('not-sent'); }
        const operation = domain.mobileMain(captured.mobile!); dispatches.add(operation);
        try { reply(request, await operation); } finally { dispatches.delete(operation); }
      } catch (error) { reject(request, error); }
      return;
    }
    if(request.operation==='materializeMBEdition'){
      try{if(!bootCommitted||request.expectedDatasetId!==boundDatasetId||domain.datasetId!==boundDatasetId||!domain.materializeMBEdition||!request.edition)throw new DatasetOwnerTransportError('not-sent');reply(request,domain.materializeMBEdition(request.edition));}catch(error){reject(request,error);}return;
    }
    if (request.operation === 'loadMBQueue' || request.operation === 'saveMBQueue') {
      try {
        if (!bootCommitted || request.expectedDatasetId !== boundDatasetId || domain.datasetId !== boundDatasetId) throw new DatasetOwnerTransportError('not-sent');
        if (request.operation === 'loadMBQueue' && domain.loadMBQueue) reply(request, domain.loadMBQueue());
        else if (request.operation === 'saveMBQueue' && domain.saveMBQueue && request.queue) reply(request, domain.saveMBQueue(request.queue));
        else throw new DatasetOwnerTransportError('not-sent');
      } catch (error) { reject(request, error); }
      return;
    }
    if (request.operation === 'getCollectionSnapshotVersion'  || request.operation === 'exportVersionedCollectionSnapshot' || request.operation === 'exportLargeVersionedCollectionSnapshot') {
      try {
        const exportModels = request.operation === 'exportLargeVersionedCollectionSnapshot' ? domain.exportLargeCollectionModels : domain.exportCollectionModels;
        if (!bootCommitted || snapshotRevision === undefined || domain.readonlySnapshotStamp === undefined
          || (request.operation !== 'getCollectionSnapshotVersion' && exportModels === undefined)) {
          throw new DatasetOwnerDispatchError(responseFailure(request.requestId, 'NOT_READY', '收藏快照版本尚未就绪。'));
        }
        if (request.expectedDatasetId !== boundDatasetId || domain.datasetId !== boundDatasetId) throw new DatasetOwnerDispatchError(responseFailure(request.requestId, 'OUTBOX_SCOPE_MISMATCH', '收藏快照不属于当前工作库。'));
        const before = readSnapshotStamp();
        observeSnapshotStamp(before);
        const version = { epoch: request.epoch, datasetId: boundDatasetId!, revision: snapshotRevision! };
        if (request.operation === 'getCollectionSnapshotVersion') { reply(request, version); return; }
        const models = exportModels!.call(domain);
        const snapshot = { epoch: request.epoch, datasetId: boundDatasetId!, snapshotId: randomUUID(), models };
        const after = readSnapshotStamp();
        observeSnapshotStamp(after);
        const validSnapshot = request.operation === 'exportLargeVersionedCollectionSnapshot' ? isDatasetLargeCollectionSnapshot : isDatasetCollectionSnapshot;
        if (!sameStamp(before, after) || !validSnapshot(snapshot)) throw new DatasetOwnerDispatchError(responseFailure(request.requestId, 'INVENTORY_UNAVAILABLE', '收藏快照导出期间已经改变或超过当前预算。'));
        reply(request, { snapshot, version });
      } catch (error) { reject(request, error); }
      return;
    }
    if (request.operation === 'exportCollectionSnapshot') {
      try {
        if (!bootCommitted || domain.exportCollectionModels === undefined) throw new DatasetOwnerDispatchError(responseFailure(request.requestId, 'NOT_READY', '收藏快照导出尚未就绪。'));
        if (request.expectedDatasetId !== domain.datasetId) throw new DatasetOwnerDispatchError(responseFailure(request.requestId, 'OUTBOX_SCOPE_MISMATCH', '收藏快照不属于当前工作库。'));
        const datasetId = domain.datasetId;
        const models = domain.exportCollectionModels();
        const snapshot = { epoch: request.epoch, datasetId, snapshotId: randomUUID(), models };
        if (domain.datasetId !== datasetId || !isDatasetCollectionSnapshot(snapshot)) throw new DatasetOwnerDispatchError(responseFailure(request.requestId, 'INVENTORY_UNAVAILABLE', '收藏快照无效或超过当前预算。'));
        reply(request, snapshot);
      } catch (error) { reject(request, error); }
      return;
    }
    if (['captureLocalSource','revalidateLocalSource','releaseLocalSource'].includes(request.operation)) {
      try {
        if (!bootCommitted || request.expectedDatasetId !== boundDatasetId || domain.datasetId !== boundDatasetId) throw new Error('本地私有来源未就绪或epoch不符。');
        const payload = request.local!;
        if (request.operation === 'captureLocalSource' && 'selection' in payload && domain.captureLocalSource) reply(request,domain.captureLocalSource(payload.selection));
        else if (request.operation === 'revalidateLocalSource' && 'ticketId' in payload && domain.revalidateLocalSource) reply(request,domain.revalidateLocalSource(payload.ticketId));
        else if (request.operation === 'releaseLocalSource' && 'ticketId' in payload && domain.releaseLocalSource) {domain.releaseLocalSource(payload.ticketId);reply(request,undefined);}
        else throw new Error('本地私有来源能力缺失。');
      } catch (error) { reject(request,error); }
      return;
    }
    const internal = request.operation === 'dispatchInternal';
    const checked = internal ? validateIpcInternalRequest(request.request) : validateIpcRequest(request.request);
    if (!checked.ok) { reject(request, new DatasetOwnerDispatchError({ version: 1, id: request.request!.id, ok: false, error: checked.error })); return; }
    // 不等待整个异步命令才接收下一条；同步SQL仍完整地在同一个owner线程执行。
    let dispatch: Promise<unknown>;
    try {
      if (internal && (!(isLocalArtworkInternalCommand(checked.value.command) || isLocalCatalogInternalCommand(checked.value.command) || isLocalScanInternalCommand(checked.value.command) || isLocalRelocationInternalCommand(checked.value.command)) || !domain.dispatchInternal)) throw new DatasetOwnerDispatchError(responseFailure(checked.value.id, 'INVALID_IPC_REQUEST', '可信观察入口未就绪。'));
      dispatch = Promise.resolve(internal ? domain.dispatchInternal!(checked.value) : domain.dispatch(checked.value));
    }
    catch (error) { reject(request, error); return; }
    dispatches.add(dispatch);
    try { reply(request, await dispatch); } catch (error) { reject(request, error); }
    finally { dispatches.delete(dispatch); }
  }

  function handle(request: DatasetOwnerRequest, capture: () => DatasetOwnerRequest): Promise<void> {
    if (request.operation === 'mobileMain' && request.mobile?.kind === 'content'
      && (request.mobile.request.action === 'initialize' || request.mobile.request.action === 'updateScope')) {
      const context = createMobileCapabilityContext(request.requestId, 'owner', 'owner');
      if (!context) return handleOriginal(request, capture);
      return withMobileCapabilityContext(context, async () => {
        try { await mobileCapabilityAsync('owner.rpc.receive', () => handleOriginal(request, capture)); }
        finally { closeMobileCapabilityContext(context); }
      });
    }
    return request.operation === 'localAlbumRead'
      ? runLocalAlbumContext(request.requestId, null, 'worker.receive', () => handleOriginal(request, capture)) : handleOriginal(request, capture);
  }

  function receive(message: unknown): void {
    if (epoch !== undefined && ownerRecord(message) && typeof message.epoch === 'string' && message.epoch !== epoch) return;
    if(ownerRecord(message)&&Object.getOwnPropertyDescriptor(message,'type')?.value==='musicbridge.workbench.frame'){wbReceive(message);return;}
    if (isDatasetOwnerProjectionResponse(message)) {
      const item = projections.get(message.projectionRequestId);
      if (item === undefined) { protocolFailure(); return; }
      if (!message.ok && message.failure.id !== message.projectionRequestId) { protocolFailure(); return; }
      if (message.ok && (!isDatasetProjectionResult(item.command, message.result) || (item.command === 'captureTrackMetadataBatch' && ownerRecord(message.result) && Array.isArray(message.result.metadata) && 'references' in item.payload && message.result.metadata.length !== item.payload.references.length))) { protocolFailure(); return; }
      if (message.ok && (item.command === 'acquirePermit' || item.command === 'releasePermit') && ownerRecord(message.result) && item.command === 'acquirePermit' && 'scope' in item.payload && (message.result.scope !== item.payload.scope || message.result.projectionId !== item.payload.projectionId)) { protocolFailure(); return; }
      item.detach();projections.delete(message.projectionRequestId);
      if (message.ok) item.resolve(message.result); else item.reject(new DatasetOwnerDispatchError(message.failure));
      return;
    }
    const boundary = readDatasetOwnerRequestForCapture(message);
    if (!boundary) { protocolFailure(); return; }
    const request = boundary.value;
    if (epoch === undefined) {
      if (request.operation !== 'prepare' && request.operation !== 'close') { protocolFailure(); return; }
      epoch = request.epoch;
    }
    if (request.sequence !== lastSequence + 1) { protocolFailure(); return; }
    lastSequence = request.sequence;
    void handle(request, boundary.capture).catch(() => protocolFailure());
  }
  port.on('message', receive);
  port.on('messageerror', protocolFailure);
  port.once('close', () => { if (!closing) { disconnected = true; abandon(); } });
  // 本代真实目录登记后的专用port断链，必须沿原Owner关闭等dispatch/FD静止；旧无目录模式不改。
  sourcePort?.once('close',()=>{if(directoryRegistrationSequence>0&&!closing){disconnected=true;abandon();}});
}
