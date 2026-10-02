import { randomUUID } from 'node:crypto';
import type { MessagePort } from 'node:worker_threads';
import { validateIpcRequest, type IpcCommand, type IpcFailure } from '@music-bridge/contracts';
import { failureForError, responseFailure } from '../shared/ipc-failure.js';
import {
  DATASET_OWNER_PROTOCOL_VERSION, DatasetOwnerDispatchError, DatasetOwnerTransportError,
  isDatasetCollectionSnapshot, isDatasetOwnerFailure, isDatasetOwnerIdentity, isDatasetOwnerProjectionResponse, isDatasetOwnerRequest,
  isDatasetProjectionPayload, isDatasetProjectionResult, ownerRecord,
  type DatasetOwnerProjectionRequest, type DatasetOwnerRequest, type DatasetOwnerResponse,
  type DatasetProjectionCommand, type DatasetProjectionCommandPayloads, type DatasetProjectionCommandResults,
  type DatasetProjectionPort, type OwnedDatasetDomain,
} from './dataset-owner-protocol.js';

export interface DatasetOwnerWorkerOptions {
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
  let closure: Promise<void> | undefined;
  let closing = false;
  let failed = false;
  let disconnected = false;
  const dispatches = new Set<Promise<unknown>>();
  const projections = new Map<string, PendingProjection>();

  function projectFailure(id: string, error: unknown, command?: IpcCommand): IpcFailure {
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
    closing = true;
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
    void closeDomain().then(() => { port.off('message', receive); port.close(); }, () => undefined);
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
        port.close(); // closed确认后让worker自然退出；不调用process.exit/terminate。
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
          domain = prepared; return prepared;
        });
        const prepared = await preparation;
        reply(request, { epoch: request.epoch, datasetId: prepared.datasetId });
      } catch (error) { reject(request, error); }
      return;
    }
    if (domain === undefined) { reject(request, new DatasetOwnerDispatchError(responseFailure(request.request?.id ?? request.requestId, 'NOT_READY', '领域所有者尚未准备完成。'))); return; }
    if (request.operation === 'commitBoot') {
      try { commitment ??= Promise.resolve().then(() => domain!.commitBoot()); await commitment; bootCommitted = true; reply(request, undefined); }
      catch (error) { reject(request, error); }
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
    const checked = validateIpcRequest(request.request);
    if (!checked.ok) { reject(request, new DatasetOwnerDispatchError({ version: 1, id: request.request!.id, ok: false, error: checked.error })); return; }
    // 不等待整个异步命令才接收下一条；同步SQL仍完整地在同一个owner线程执行。
    let dispatch: Promise<unknown>;
    try { dispatch = Promise.resolve(domain.dispatch(checked.value)); }
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
