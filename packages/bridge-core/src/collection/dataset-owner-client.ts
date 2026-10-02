import { randomUUID } from 'node:crypto';
import type { Worker } from 'node:worker_threads';
import type { IpcCommand, IpcRequest } from '@music-bridge/contracts';
import { failureForError, responseFailure } from '../shared/ipc-failure.js';
import {
  DATASET_OWNER_PROTOCOL_VERSION, DatasetOwnerDispatchError, DatasetOwnerTransportError,
  isDatasetCollectionSnapshot, isDatasetCollectionSnapshotVersion, isDatasetVersionedCollectionSnapshot, isDatasetOwnerFailure, isDatasetOwnerIdentity, isDatasetOwnerProjectionRequest, isDatasetOwnerResponse,
  isDatasetProjectionResult, isDatasetRequestEnvelope, ownerRecord,
  type DatasetCollectionSnapshot, type DatasetCollectionSnapshotVersion, type DatasetVersionedCollectionSnapshot, type DatasetOwnerVersionedSnapshotEndpoint, type DatasetOwnerFatalReason, type DatasetOwnerIdentity,
  type DatasetOwnerOperation, type DatasetOwnerProjectionHandler,
  type DatasetOwnerProjectionRequest, type DatasetOwnerProjectionResponse, type DatasetOwnerRequest,
} from './dataset-owner-protocol.js';

interface PendingRequest {
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
export function createDatasetOwnerClient(options: DatasetOwnerClientOptions): DatasetOwnerVersionedSnapshotEndpoint {
  const { worker } = options;
  const epoch = randomUUID();
  const pending = new Map<string, PendingRequest>();
  let sequence = 0;
  let identity: DatasetOwnerIdentity | undefined;
  let preparation: Promise<DatasetOwnerIdentity> | undefined;
  let commitment: Promise<void> | undefined;
  let bootCommitted = false;
  let exporting = false;
  const snapshotIds = new Set<string>();
  let closure: Promise<void> | undefined;
  let closing = false;
  let closeAcknowledged = false;
  let exited = false;
  let failed = false;
  let exitResolve!: () => void;
  let exitReject!: (error: unknown) => void;
  const naturalExit = new Promise<void>((resolve, reject) => { exitResolve = resolve; exitReject = reject; });
  // 未进入close的故障也会拒绝退出等待；挂接处理避免无人等待时产生未处理拒绝。
  void naturalExit.catch(() => undefined);

  function fatal(reason: DatasetOwnerFatalReason): void {
    if (failed) return;
    failed = true;
    for (const item of pending.values()) item.reject(new DatasetOwnerTransportError(item.sent ? 'unknown' : 'not-sent', item.publicId, item.command));
    pending.clear();
    exitReject(new DatasetOwnerTransportError('unknown'));
    // 通知不能把底层异常、路径或线程数据带到公开错误中。
    try { options.onFatal?.(reason); } catch { /* 监督回调失败不能改写已发送操作的未知结果。 */ }
  }

  function rpc(operation: DatasetOwnerOperation, request?: IpcRequest, expectedDatasetId?: string): Promise<unknown> {
    if (failed || exited) return Promise.reject(new DatasetOwnerTransportError('not-sent', request?.id, request?.command));
    const requestId = randomUUID();
    const message: DatasetOwnerRequest = {
      version: DATASET_OWNER_PROTOCOL_VERSION, type: 'request', epoch, requestId,
      sequence: ++sequence, operation, ...(request === undefined ? {} : { request }),
      ...(expectedDatasetId === undefined ? {} : { expectedDatasetId }),
    };
    return new Promise((resolve, reject) => {
      const item: PendingRequest = { operation, sent: false, resolve, reject,
        ...(request === undefined ? {} : { publicId: request.id, command: request.command }) };
      pending.set(requestId, item);
      try { worker.postMessage(message); item.sent = true; }
      catch {
        pending.delete(requestId);
        reject(new DatasetOwnerTransportError('not-sent', request?.id, request?.command));
        fatal('post-failed');
      }
    });
  }

  async function project(message: DatasetOwnerProjectionRequest): Promise<void> {
    let response: DatasetOwnerProjectionResponse;
    try {
      if (options.projection === undefined) throw new DatasetOwnerDispatchError(responseFailure(message.projectionRequestId, 'NOT_READY', 'Roon 元数据投影尚未就绪。'));
      const result = await options.projection(message.command, message.payload, { epoch, ...(identity === undefined ? {} : { datasetId: identity.datasetId }) });
      if (!isDatasetProjectionResult(message.command, result)) throw new DatasetOwnerDispatchError(responseFailure(message.projectionRequestId, 'INVALID_IPC_RESPONSE', 'Roon 元数据投影返回无效。'));
      response = { version: DATASET_OWNER_PROTOCOL_VERSION, type: 'projection-response', epoch, projectionRequestId: message.projectionRequestId, ok: true, result };
    } catch (error) {
      const projectedFailure = error instanceof DatasetOwnerDispatchError
        ? { ...error.failure, id: message.projectionRequestId }
        : failureForError(message.projectionRequestId, error, 'physicalLinks.search');
      const failure = isDatasetOwnerFailure(projectedFailure) ? projectedFailure : responseFailure(message.projectionRequestId, 'INTERNAL_ERROR', '元数据投影失败。');
      response = { version: DATASET_OWNER_PROTOCOL_VERSION, type: 'projection-response', epoch, projectionRequestId: message.projectionRequestId, ok: false, failure };
    }
    if (failed || exited) return;
    try { worker.postMessage(response); } catch { fatal('post-failed'); }
  }

  function receive(message: unknown): void {
    if (failed || exited) return;
    // 上一实例的回复无权完成当前实例的promise，也不能使当前实例进入fatal。
    if (ownerRecord(message) && typeof message.epoch === 'string' && message.epoch !== epoch) return;
    if (isDatasetOwnerProjectionRequest(message)) { void project(message); return; }
    if (ownerRecord(message) && message.version === DATASET_OWNER_PROTOCOL_VERSION && message.epoch === epoch && message.type === 'fatal' && ['protocol-failure','close-failed'].includes(String(message.reason))) {
      fatal(message.reason as 'protocol-failure' | 'close-failed'); return;
    }
    if (!isDatasetOwnerResponse(message)) { fatal('protocol-failure'); return; }
    const item = pending.get(message.requestId);
    if (item === undefined || item.operation !== message.operation) { fatal('protocol-failure'); return; }
    const publicId = item.publicId ?? message.requestId;
    if (!message.ok && message.failure.id !== publicId) { fatal('protocol-failure'); return; }
    if (message.ok && message.operation === 'prepare' && (!isDatasetOwnerIdentity(message.result) || message.result.epoch !== epoch)) { fatal('protocol-failure'); return; }
    if (message.ok && message.operation === 'getCollectionSnapshotVersion') {
      if (!isDatasetCollectionSnapshotVersion(message.result) || message.result.epoch !== epoch || message.result.datasetId !== identity?.datasetId) { fatal('protocol-failure'); return; }
    }
    if (message.ok && (message.operation === 'exportCollectionSnapshot' || message.operation === 'exportVersionedCollectionSnapshot')) {
      let snapshot: DatasetCollectionSnapshot;
      if (message.operation === 'exportVersionedCollectionSnapshot') {
        if (!isDatasetVersionedCollectionSnapshot(message.result)) { fatal('protocol-failure'); return; }
        snapshot = message.result.snapshot;
      } else {
        if (!isDatasetCollectionSnapshot(message.result)) { fatal('protocol-failure'); return; }
        snapshot = message.result;
      }
      if (snapshot.epoch !== epoch || snapshot.datasetId !== identity?.datasetId || snapshotIds.has(snapshot.snapshotId)) { fatal('protocol-failure'); return; }
      snapshotIds.add(snapshot.snapshotId);
    }
    if (message.ok && (message.operation === 'close' || message.operation === 'commitBoot') && message.result !== undefined) { fatal('protocol-failure'); return; }
    pending.delete(message.requestId);
    if (!message.ok) {
      item.reject(new DatasetOwnerDispatchError(message.failure));
      // 合法关闭失败回复已证明owner未关闭；同步锁定原因，不依赖下一帧fatal到达。
      if (message.operation === 'close') fatal('close-failed');
      return;
    }
    if (message.operation === 'close') closeAcknowledged = true;
    item.resolve(message.result);
  }

  worker.on('message', receive);
  worker.on('error', () => fatal('worker-error'));
  worker.on('messageerror', () => fatal('protocol-failure'));
  worker.once('exit', code => {
    exited = true;
    worker.off('message', receive);
    if (code === 0 && closing && closeAcknowledged && !failed && pending.size === 0) exitResolve();
    else fatal('worker-exit');
  });

  return {
    prepare() {
      if (closing || failed || exited) return Promise.reject(new DatasetOwnerTransportError('not-sent'));
      preparation ??= rpc('prepare').then(value => {
        if (!isDatasetOwnerIdentity(value)) throw new DatasetOwnerTransportError('unknown');
        identity = value; return value;
      });
      return preparation;
    },
    dispatch(request) {
      const { id, command } = request;
      if (identity === undefined || closing || failed || exited) return Promise.reject(new DatasetOwnerTransportError('not-sent', id, command));
      if (!isDatasetRequestEnvelope(request)) return Promise.reject(new DatasetOwnerDispatchError(responseFailure(id, 'INVALID_IPC_REQUEST', '领域命令不在允许范围或信封无效。')));
      return rpc('dispatch', request);
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
    close() {
      if (closure !== undefined) return closure;
      closing = true;
      // 发close即封入口；owner先停止coordinator，再等待在途dispatch，然后关闭连接。
      closure = rpc('close').then(() => naturalExit);
      return closure;
    },
  };
}
