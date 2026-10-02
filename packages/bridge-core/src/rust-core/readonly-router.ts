import { isCollectionId, isCommandOutboxDatasetId, type IpcRequest } from '@music-bridge/contracts';
import type { DatasetCollectionSnapshotVersion, DatasetOwnerVersionedSnapshotEndpoint } from '../collection/dataset-owner-protocol.js';
import { createRustReadonlyDatasetEndpointFromOwner, RustSidecarError,
  type RustReadonlyDatasetEndpoint, type RustReadonlyOwnerOptions, type RustSidecarErrorCode } from './readonly-sidecar.js';

export interface RustReadonlyCollectionRouterOptions extends Omit<RustReadonlyOwnerOptions, 'owner'> {
  owner: DatasetOwnerVersionedSnapshotEndpoint;
}
export interface RustReadonlyCollectionRouterStatus {
  readonly phase: 'node' | 'refreshing' | 'rust' | 'stale' | 'failed' | 'closed';
  readonly generation: number;
  readonly epoch: string;
  readonly datasetId: string;
  readonly snapshotId?: string;
  readonly revision?: string;
  readonly errorCode?: RustSidecarErrorCode;
}
export interface RustReadonlyCollectionRouter {
  dispatch(request: IpcRequest): Promise<unknown>;
  refresh(): Promise<void>;
  invalidate(): void;
  getStatus(): RustReadonlyCollectionRouterStatus;
  close(): Promise<void>;
}
function budget(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > 30_000) throw new RustSidecarError('INVALID_REQUEST');
  return result;
}
function plain(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value), descriptors = Object.getOwnPropertyDescriptors(value);
  return (prototype === Object.prototype || prototype === null) && !Object.getOwnPropertySymbols(value).length
    && Object.keys(descriptors).length === keys.length && keys.every(key => {
      const descriptor = descriptors[key];
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value');
    });
}
function versionCopy(value: unknown): DatasetCollectionSnapshotVersion {
  if (!plain(value, ['epoch', 'datasetId', 'revision']) || !isCollectionId(value.epoch)
    || !isCommandOutboxDatasetId(value.datasetId) || typeof value.revision !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.revision)) {
    throw new RustSidecarError('SNAPSHOT_UNAVAILABLE');
  }
  return { epoch: value.epoch, datasetId: value.datasetId, revision: value.revision };
}
const sameVersion = (a: DatasetCollectionSnapshotVersion, b: DatasetCollectionSnapshotVersion) =>
  a.epoch === b.epoch && a.datasetId === b.datasetId && a.revision === b.revision;
// 按领域实现审定的纯收藏读取闭集；不按命令名猜测其余命令是否写入。
const nodeReadonlyCommands = new Set<IpcRequest['command']>(['collection.detail', 'collection.copy', 'collection.photo']);
const errorCodes = new Set<RustSidecarErrorCode>(['INVALID_REQUEST', 'UNSUPPORTED_OPERATION', 'UNSUPPORTED_COMMAND', 'UNSUPPORTED_FILTER',
  'SCOPE_MISMATCH', 'CAPACITY_EXCEEDED', 'NOT_READY', 'CLOSING', 'PROTOCOL_ERROR', 'BINARY_PIN_MISMATCH',
  'TIMEOUT', 'PROCESS_EXIT', 'SNAPSHOT_UNAVAILABLE', 'STALE_SNAPSHOT']);
const safeError = (error: unknown): RustSidecarError => error instanceof RustSidecarError && errorCodes.has(error.code)
  ? error : new RustSidecarError('SNAPSHOT_UNAVAILABLE');

/** 限制等待，不取消借用 Owner 的合法 RPC；晚到结果始终被消费。 */
async function bounded<T>(operation: () => T | Promise<T>, deadline: number): Promise<T> {
  if (performance.now() >= deadline) throw new RustSidecarError('TIMEOUT');
  const work = Promise.resolve().then(operation);
  let timer!: NodeJS.Timeout;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new RustSidecarError('TIMEOUT')), Math.max(1, deadline - performance.now()));
  });
  try {
    const result = await Promise.race([work, timeout]);
    if (performance.now() >= deadline) throw new RustSidecarError('TIMEOUT');
    return result;
  } finally { clearTimeout(timer); }
}

/** 仅绑定已 boot 的来源。默认仍由 Node 读取，显式刷新才建立只读 child。 */
export async function createRustReadonlyCollectionRouter(options: RustReadonlyCollectionRouterOptions): Promise<RustReadonlyCollectionRouter> {
  options = { ...options, binary: { ...options.binary } };
  const probeTimeout = budget(options.requestTimeoutMs, 5_000);
  const startupTimeout = budget(options.startupTimeoutMs, 5_000);
  budget(options.closeTimeoutMs, 5_000);
  let binding: DatasetCollectionSnapshotVersion;
  try { binding = versionCopy(await bounded(() => options.owner.getCollectionSnapshotVersion(), performance.now() + probeTimeout)); }
  catch (error) { throw safeError(error); }
  let generation = 0, phase: RustReadonlyCollectionRouterStatus['phase'] = 'node', closed = false;
  let errorCode: RustSidecarErrorCode | undefined, writes = 0;
  let active: { endpoint: RustReadonlyDatasetEndpoint; version: DatasetCollectionSnapshotVersion } | undefined;
  let refreshing: Promise<void> | undefined, closing: Promise<void> | undefined;
  let retiring = Promise.resolve(), retirementError: RustSidecarError | undefined;
  const retired = new WeakSet<RustReadonlyDatasetEndpoint>();
  const terminalFailureGeneration = new WeakMap<RustReadonlyDatasetEndpoint, number>();
  const observer = (code: RustSidecarErrorCode) => { try { options.onFatal?.(code); } catch { /* 观察者不能影响资源收口。 */ } };
  function retire(endpoint: RustReadonlyDatasetEndpoint): void {
    if (retired.has(endpoint)) return;
    retired.add(endpoint);
    // close 即刻封闭读取，排空结束前不会建立下一 child。
    let cleanup: Promise<void>;
    try { cleanup = Promise.resolve(endpoint.close()); } catch (error) { cleanup = Promise.reject(error); }
    const ownGeneration = generation;
    retiring = Promise.allSettled([retiring, cleanup]).then(results => {
      for (const result of results) if (result.status === 'rejected') {
        retirementError ??= safeError(result.reason);
      }
      if (retirementError) {
        if (!closed && generation === ownGeneration) { phase = 'failed'; errorCode = retirementError.code; }
        throw retirementError;
      }
    });
    void retiring.catch(() => {});
  }
  function revoke(nextPhase: RustReadonlyCollectionRouterStatus['phase']): void {
    generation++;
    phase = nextPhase;
    errorCode = undefined;
    const old = active;
    active = undefined;
    if (old) retire(old.endpoint);
  }
  function fence(expectedGeneration: number): void {
    if (closed || generation !== expectedGeneration) throw new RustSidecarError('STALE_SNAPSHOT');
  }
  function scoped(version: DatasetCollectionSnapshotVersion): void {
    if (version.epoch !== binding.epoch || version.datasetId !== binding.datasetId) throw new RustSidecarError('SCOPE_MISMATCH');
  }
  async function probe(deadline = Infinity): Promise<DatasetCollectionSnapshotVersion> {
    return versionCopy(await bounded(() => options.owner.getCollectionSnapshotVersion(), Math.min(deadline, performance.now() + probeTimeout)));
  }
  function failCurrent(error: unknown, expectedGeneration: number): void {
    if (closed || generation !== expectedGeneration) return;
    const code = safeError(error).code;
    revoke('failed'); errorCode = code;
  }
  async function nodeRead(request: IpcRequest, expectedGeneration: number): Promise<unknown> {
    try {
      const result = await Promise.resolve().then(() => options.owner.dispatch(request));
      fence(expectedGeneration);
      return result;
    } catch (error) { fence(expectedGeneration); throw error; }
  }
  const router: RustReadonlyCollectionRouter = {
    async dispatch(request) {
      if (closed) throw new RustSidecarError('CLOSING');
      if (request.expectedDatasetId !== undefined && request.expectedDatasetId !== binding.datasetId) throw new RustSidecarError('SCOPE_MISMATCH');
      // 省略 scope 仍可用，但固定路由不得跨库交付来源的新身份。
      if (request.expectedDatasetId === undefined) request = { ...request, expectedDatasetId: binding.datasetId };
      if (request.command !== 'collection.list') {
        revoke('stale');
        if (nodeReadonlyCommands.has(request.command)) return nodeRead(request, generation);
        writes++;
        try {
          return await Promise.resolve().then(() => options.owner.dispatch(request));
        } finally { writes--; }
      }
      const ownGeneration = generation, current = active;
      if (!current || request.readContext !== undefined) {
        return nodeRead(request, ownGeneration);
      }
      let before: DatasetCollectionSnapshotVersion;
      try { before = await probe(); fence(ownGeneration); scoped(before); }
      catch (error) { fence(ownGeneration); failCurrent(error, ownGeneration); throw safeError(error); }
      if (!sameVersion(before, current.version)) {
        revoke('stale');
        return nodeRead(request, generation);
      }
      try {
        const result = await current.endpoint.dispatch(request);
        fence(ownGeneration);
        const after = await probe(); fence(ownGeneration); scoped(after);
        if (!sameVersion(after, current.version)) {
          revoke('stale');
          throw new RustSidecarError('STALE_SNAPSHOT');
        }
        return result;
      } catch (error) {
        // child 自身的协议/进程错误要保持可观察；外部失效后的迟到结果仍受 fence 约束。
        if (!closed && terminalFailureGeneration.get(current.endpoint) === generation && generation === ownGeneration + 1) throw safeError(error);
        fence(ownGeneration);
        failCurrent(error, ownGeneration);
        throw safeError(error);
      }
    },
    refresh() {
      if (closed) return Promise.reject(new RustSidecarError('CLOSING'));
      if (refreshing) return refreshing;
      if (writes) return Promise.reject(new RustSidecarError('NOT_READY'));
      revoke('refreshing');
      const ownGeneration = generation, deadline = performance.now() + startupTimeout;
      const fresh = () => { fence(ownGeneration); if (performance.now() >= deadline) throw new RustSidecarError('TIMEOUT'); };
      const work = (async () => {
        let candidate: RustReadonlyDatasetEndpoint | undefined, exportedVersion: DatasetCollectionSnapshotVersion | undefined;
        try {
          await bounded(() => retiring, deadline); fresh();
          if (retirementError) throw retirementError;
          // 复用既有 pin、帧校验和进程期限；proxy 不启动或关闭来源 Owner。
          candidate = await createRustReadonlyDatasetEndpointFromOwner({
            ...options,
            startupTimeoutMs: Math.max(1, Math.floor(deadline - performance.now())),
            owner: {
              prepare: async () => { fresh(); return { epoch: binding.epoch, datasetId: binding.datasetId }; },
              exportCollectionSnapshot: async () => {
                const exported = await bounded(() => options.owner.exportVersionedCollectionSnapshot(), deadline); fresh();
                if (!plain(exported, ['snapshot', 'version'])) throw new RustSidecarError('SNAPSHOT_UNAVAILABLE');
                exportedVersion = versionCopy(exported.version); scoped(exportedVersion);
                return exported.snapshot;
              },
              dispatch: () => Promise.reject(new RustSidecarError('UNSUPPORTED_COMMAND')),
              commitBoot: () => Promise.reject(new RustSidecarError('UNSUPPORTED_OPERATION')),
              close: () => Promise.reject(new RustSidecarError('UNSUPPORTED_OPERATION')),
            },
            onFatal: code => {
              if (candidate && active?.endpoint === candidate && generation === ownGeneration) {
                failCurrent(new RustSidecarError(code), ownGeneration);
                terminalFailureGeneration.set(candidate, generation);
              }
              observer(code);
            },
          }, endpoint => { candidate = endpoint; });
          fresh();
          const current = await probe(deadline); fresh(); scoped(current);
          if (!exportedVersion || !sameVersion(current, exportedVersion)) {
            revoke('stale');
            throw new RustSidecarError('STALE_SNAPSHOT');
          }
          active = { endpoint: candidate, version: exportedVersion };
          phase = 'rust'; errorCode = undefined;
        } catch (error) {
          if (candidate) retire(candidate);
          failCurrent(error, ownGeneration);
          throw safeError(error);
        }
      })();
      refreshing = work.finally(() => { if (refreshing === joined) refreshing = undefined; });
      const joined = refreshing;
      void joined.catch(() => {});
      return joined;
    },
    invalidate() { if (!closed) revoke('stale'); },
    getStatus() {
      return Object.freeze({ phase, generation, epoch: binding.epoch, datasetId: binding.datasetId,
        ...(active ? { snapshotId: active.endpoint.snapshotId, revision: active.version.revision } : {}),
        ...(errorCode ? { errorCode } : {}) });
    },
    close() {
      if (closing) return closing;
      closed = true; revoke('closed');
      closing = (async () => {
        if (refreshing) await refreshing.catch(() => {});
        await retiring;
      })();
      void closing.catch(() => {});
      return closing;
    },
  };
  return router;
}
