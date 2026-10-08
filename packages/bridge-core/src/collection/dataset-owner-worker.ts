import { MBQueueStoreError } from './mb-queue-store.js';
import {LocalSourcePreparationError} from '../application/local-source-resolver.js';
import { LocalFactsCommitFatal } from '../stream/local-source-fence.js';
import { LOCAL_RELOCATION_COMMANDS, isLocalArtworkInternalCommand, isLocalRelocationCommand, isLocalRelocationInternalCommand, isLocalRelocationCommandResult } from '@music-bridge/contracts';
import { randomUUID } from 'node:crypto';
import type { MessagePort } from 'node:worker_threads';
import { localSourceWritesMainRequestSnapshot, localSourceWritesMainResponseSnapshot, type SourceWritesMainRequest } from '@music-bridge/contracts';
import { createSourceWritesMainActor } from './source-writes-authority.js';
import { localRelocationMainRequestSnapshot, localRelocationMainResponseSnapshot, type LocalRelocationMainRequest } from '@music-bridge/contracts';
import { createRelocationMainActor } from './source-relocation-authority.js';
import { validateIpcRequest, validateIpcInternalRequest, isLocalCatalogInternalCommand, isLocalScanInternalCommand, type IpcCommand, type IpcFailure } from '@music-bridge/contracts';
import { failureForError, responseFailure } from '../shared/ipc-failure.js';
import {
  DATASET_OWNER_PROTOCOL_VERSION, DatasetOwnerDispatchError, DatasetOwnerTransportError,
  isDatasetCollectionSnapshot, isDatasetLargeCollectionSnapshot, isDatasetOwnerFailure, isDatasetOwnerIdentity, isDatasetOwnerProjectionResponse, isDatasetOwnerRequest,
  isDatasetProjectionPayload, isDatasetProjectionResult, ownerRecord,
  type DatasetOwnerProjectionRequest, type DatasetOwnerRequest, type DatasetOwnerResponse,
  type DatasetProjectionCommand, type DatasetProjectionCommandPayloads, type DatasetProjectionCommandResults,
  type DatasetProjectionPort, type OwnedDatasetDomain,
} from './dataset-owner-protocol.js';

export interface DatasetOwnerWorkerOptions {
  privateSourceWritesPort?:MessagePort;
  privateRelocationMainPort?: MessagePort;
  // factory、converter和helper只在worker本地创建，端口上不接受函数或任意方法名。
  prepare(epoch: string, projection: DatasetProjectionPort): Promise<OwnedDatasetDomain>;
}

interface PendingProjection {
  command: DatasetProjectionCommand;
  payload: DatasetProjectionCommandPayloads[DatasetProjectionCommand];
  resolve(result: unknown): void;
  reject(error: unknown): void;
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
  const sourcePort=options.privateSourceWritesPort,sourceActor=sourcePort?createSourceWritesMainActor(sourcePort):undefined;
  let sourceSequence=0,sourceRequests=0;
  async function receiveSource(raw:unknown):Promise<void>{
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
    if(error instanceof LocalFactsCommitFatal || error instanceof MBQueueStoreError && error.code === 'QUEUE_COMMIT_UNKNOWN'){domain?.sealLocalSources?.();protocolFailure();return;}
    const message: DatasetOwnerResponse = { version: DATASET_OWNER_PROTOCOL_VERSION, type: 'response', epoch: request.epoch, requestId: request.requestId, operation: request.operation, ok: false,
      failure: projectFailure(request.request?.id ?? request.requestId, error, request.request?.command) };
    post(message);
  }

  const projection: DatasetProjectionPort = {
    call<K extends DatasetProjectionCommand>(command: K, payload: DatasetProjectionCommandPayloads[K]): Promise<DatasetProjectionCommandResults[K]> {
      if (epoch === undefined || failed || disconnected || !isDatasetProjectionPayload(command, payload)) return Promise.reject(new DatasetOwnerTransportError('not-sent'));
      const projectionRequestId = randomUUID();
      return new Promise((resolve, reject) => {
        projections.set(projectionRequestId, { command, payload, resolve: result => resolve(result as DatasetProjectionCommandResults[K]), reject });
        const message: DatasetOwnerProjectionRequest = { version: DATASET_OWNER_PROTOCOL_VERSION, type: 'projection', epoch: epoch!, projectionRequestId, command, payload };
        if (!post(message)) {
          projections.delete(projectionRequestId);
          reject(new DatasetOwnerTransportError('unknown'));
        }
      });
    },
  };

  function rejectProjections(): void {
    for (const item of projections.values()) item.reject(new DatasetOwnerTransportError('unknown'));
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

  async function handle(request: DatasetOwnerRequest): Promise<void> {
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
        preparation ??= Promise.resolve().then(() => options.prepare(request.epoch, projection)).then(prepared => {
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

  function receive(message: unknown): void {
    if (epoch !== undefined && ownerRecord(message) && typeof message.epoch === 'string' && message.epoch !== epoch) return;
    if (isDatasetOwnerProjectionResponse(message)) {
      const item = projections.get(message.projectionRequestId);
      if (item === undefined) { protocolFailure(); return; }
      if (!message.ok && message.failure.id !== message.projectionRequestId) { protocolFailure(); return; }
      if (message.ok && (!isDatasetProjectionResult(item.command, message.result) || (item.command === 'captureTrackMetadataBatch' && ownerRecord(message.result) && Array.isArray(message.result.metadata) && 'references' in item.payload && message.result.metadata.length !== item.payload.references.length))) { protocolFailure(); return; }
      if (message.ok && (item.command === 'acquirePermit' || item.command === 'releasePermit') && ownerRecord(message.result) && item.command === 'acquirePermit' && 'scope' in item.payload && (message.result.scope !== item.payload.scope || message.result.projectionId !== item.payload.projectionId)) { protocolFailure(); return; }
      projections.delete(message.projectionRequestId);
      if (message.ok) item.resolve(message.result); else item.reject(new DatasetOwnerDispatchError(message.failure));
      return;
    }
    if (!isDatasetOwnerRequest(message)) { protocolFailure(); return; }
    if (epoch === undefined) {
      if (message.operation !== 'prepare' && message.operation !== 'close') { protocolFailure(); return; }
      epoch = message.epoch;
    }
    if (message.sequence !== lastSequence + 1) { protocolFailure(); return; }
    lastSequence = message.sequence;
    void handle(message).catch(() => protocolFailure());
  }
  port.on('message', receive);
  port.on('messageerror', protocolFailure);
  port.once('close', () => { if (!closing) { disconnected = true; abandon(); } });
}
