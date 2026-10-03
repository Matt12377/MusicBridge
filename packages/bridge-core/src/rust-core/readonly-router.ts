import { isCollectionId, isCommandOutboxDatasetId, type IpcRequest } from '@music-bridge/contracts';
import { types } from 'node:util';
import type { DatasetCollectionSnapshotVersion, DatasetOwnerLargeSnapshotEndpoint, DatasetOwnerVersionedSnapshotEndpoint } from '../collection/dataset-owner-protocol.js';
import { createRustReadonlyDatasetEndpointFromOwner, RustSidecarError, validateRustSnapshotProfile,
  observeRustReadonlyCost, type RustReadonlyCostObservation, type RustReadonlyDatasetEndpoint, type RustReadonlyOwnerOptions, type RustSidecarErrorCode } from './readonly-sidecar.js';

export interface RustReadonlyCollectionRouterOptions extends Omit<RustReadonlyOwnerOptions, 'owner'> {
  owner: DatasetOwnerVersionedSnapshotEndpoint & Partial<Pick<DatasetOwnerLargeSnapshotEndpoint, 'exportLargeVersionedCollectionSnapshot'>>;
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
// 审定已 boot Owner 的领域实现与辅助函数；只保留这十六条精确纯读，不按前缀扩大。
const nodeReadonlyCommands = new Set<IpcRequest['command']>([
  'collection.detail', 'collection.copy', 'collection.photo',
  'referenceCatalog.sources', 'referenceCatalog.history', 'referenceCatalog.revision',
  'commandOutbox.context', 'collectionProgress.modelLengths',
  'collectionProgress.current', 'collectionProgress.wants', 'collectionProgress.wantHistory',
  'collectionProgress.snapshots', 'collectionProgress.snapshot',
  'referenceCatalog.snapshot', 'referenceCatalog.source', 'referenceCatalog.sourceZipReceipts',
]);
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
  const profile = validateRustSnapshotProfile(options.snapshotProfile);
  const costSink = options.onCostObservation;
  function measured<T>(stage: RustReadonlyCostObservation['stage'], operation: () => Promise<T>, fields: Partial<RustReadonlyCostObservation> = {}, completed?: (result: T) => Partial<RustReadonlyCostObservation>): Promise<T> {
    if (!costSink) return operation();
    const started = performance.now(), work = operation();
    const emit = (outcome: RustReadonlyCostObservation['outcome'], result?: T) => {
      const durationMs = performance.now() - started;
      let extra: Partial<RustReadonlyCostObservation> = {};
      // 摘要序列化是额外诊断开销，排除在该 RPC 包围值外；父子阶段不可直接求和。
      if (outcome === 'fulfilled' && completed) { try { extra = completed(result as T); } catch { /* 摘要失败不更改业务结果。 */ } }
      observeRustReadonlyCost(costSink, { ...fields, ...extra, stage, snapshotProfile: profile, durationMs, outcome });
    };
    void work.then(result => emit('fulfilled', result), () => emit('rejected'));
    return work;
  }
  if (profile === 'v3-5000' && typeof options.owner.exportLargeVersionedCollectionSnapshot !== 'function') throw new RustSidecarError('SNAPSHOT_UNAVAILABLE');
  const probeTimeout = budget(options.requestTimeoutMs, 5_000);
  const startupTimeout = budget(options.startupTimeoutMs, 5_000);
  budget(options.closeTimeoutMs, 5_000);
  let binding: DatasetCollectionSnapshotVersion;
  try { binding = await measured('versionProbe', async () => versionCopy(await bounded(() => options.owner.getCollectionSnapshotVersion(), performance.now() + probeTimeout)), { operation: 'bind' }, version => version); }
  catch (error) { throw safeError(error); }
  let generation = 0, phase: RustReadonlyCollectionRouterStatus['phase'] = 'node', closed = false, refreshAttempted = false;
  let errorCode: RustSidecarErrorCode | undefined, writes = 0;
  const claimWindows = new Map<number, number>();
  const pendingClaims = (ownGeneration: number) => (claimWindows.get(ownGeneration) ?? 0) > 0;
  let wakeReads!: () => void;
  let readWake = new Promise<void>(resolve => { wakeReads = resolve; });
  function notifyReads(): void {
    wakeReads();
    readWake = new Promise<void>(resolve => { wakeReads = resolve; });
  }
  let active: { endpoint: RustReadonlyDatasetEndpoint; version: DatasetCollectionSnapshotVersion } | undefined;
  let refreshing: Promise<void> | undefined, closing: Promise<void> | undefined;
  let refreshingCandidate: RustReadonlyDatasetEndpoint | undefined;
  // 每次刷新独有的证书；首个可信探测锁定版本，导出和领取不得更换它。
  let refreshCertificate: { generation: number; deadline: number; version?: DatasetCollectionSnapshotVersion } | undefined;
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
    // 撤销立即唤醒旧读，不让挂起的领取阻塞关闭／失效回执。
    notifyReads();
    phase = nextPhase;
    refreshCertificate = undefined;
    errorCode = undefined;
    const old = active;
    active = undefined;
    if (old) retire(old.endpoint);
    // 上传中的候选同样属于本路由；撤销时立即封闭它，不等整体期限耗尽。
    if (refreshingCandidate) retire(refreshingCandidate);
  }
  function fence(expectedGeneration: number): void {
    if (closed || generation !== expectedGeneration) throw new RustSidecarError('STALE_SNAPSHOT');
  }
  function scoped(version: DatasetCollectionSnapshotVersion): void {
    if (version.epoch !== binding.epoch || version.datasetId !== binding.datasetId) throw new RustSidecarError('SCOPE_MISMATCH');
  }
  async function probe(deadline = Infinity): Promise<DatasetCollectionSnapshotVersion> {
    return measured('versionProbe', async () => versionCopy(await bounded(() => options.owner.getCollectionSnapshotVersion(), Math.min(deadline, performance.now() + probeTimeout))), { generation, operation: 'probe' }, version => version);
  }
  function failCurrent(error: unknown, expectedGeneration: number): void {
    if (closed || generation !== expectedGeneration) return;
    const code = safeError(error).code;
    revoke('failed'); errorCode = code;
  }
  async function nodeRead(request: IpcRequest, expectedGeneration: number): Promise<unknown> {
    try {
      const result = await Promise.resolve().then(() => options.owner.dispatch(request));
      while (pendingClaims(expectedGeneration) && !closed && generation === expectedGeneration) await readWake;
      fence(expectedGeneration);
      return result;
    } catch (error) {
      while (pendingClaims(expectedGeneration) && !closed && generation === expectedGeneration) await readWake;
      fence(expectedGeneration); throw error;
    }
  }
  async function conditionalClaim(request: IpcRequest, current: typeof active, certificate: typeof refreshCertificate): Promise<unknown> {
    const ownGeneration = generation;
    // 首次 await 前登记完整窗口；领取不是纯读，仍由唯一 Node 作者执行。
    writes++; claimWindows.set(ownGeneration, (claimWindows.get(ownGeneration) ?? 0) + 1);
    const ownsCandidate = () => !closed && generation === ownGeneration
      && (current ? active === current : certificate ? refreshCertificate === certificate : !active && !refreshCertificate);
    const abandon = () => { if (ownsCandidate()) revoke('stale'); };
    const deadline = certificate?.deadline ?? Infinity;
    let expectedVersion = current?.version ?? certificate?.version;
    try {
      let unchanged = false;
      try {
        const before = await probe(deadline); scoped(before);
        if (ownsCandidate()) {
          if (!expectedVersion) {
            // 导出前或容量失败后的空领取都锁定完整版本，不能只看到 null。
            expectedVersion = before;
            if (certificate) certificate.version ??= before;
          }
          unchanged = sameVersion(before, expectedVersion)
            && (!certificate?.version || sameVersion(before, certificate.version));
        }
      } catch { /* 辅助故障只能放弃保留，不覆盖原 Node 回执。 */ }
      if (!unchanged) abandon();
      let result: unknown;
      try { result = await Promise.resolve().then(() => options.owner.dispatch(request)); }
      catch (error) { abandon(); throw error; }
      let empty = false;
      try {
        // Proxy 可伪造反射结果；先用内建检查拒绝，不能执行 trap 或 getter。
        empty = !types.isProxy(result) && plain(result, ['lease']) && Object.getOwnPropertyDescriptor(result, 'lease')?.value === null;
      } catch { /* 异常对象不满足精确 own-data 空回执。 */ }
      if (!unchanged || !empty || !ownsCandidate()) { abandon(); return result; }
      try {
        const after = await probe(deadline); scoped(after);
        if (!ownsCandidate() || !expectedVersion || !sameVersion(after, expectedVersion)
          || (certificate?.version && !sameVersion(after, certificate.version))) abandon();
      } catch { abandon(); }
      return result;
    } finally {
      writes--;
      const pending = (claimWindows.get(ownGeneration) ?? 1) - 1;
      if (pending) claimWindows.set(ownGeneration, pending); else claimWindows.delete(ownGeneration);
      // 旧代窗口也消费自己的收口；新代等待只检查自己的计数。
      notifyReads();
    }
  }
  const router: RustReadonlyCollectionRouter = {
    async dispatch(request) {
      if (closed) throw new RustSidecarError('CLOSING');
      if (request.expectedDatasetId !== undefined && request.expectedDatasetId !== binding.datasetId) throw new RustSidecarError('SCOPE_MISMATCH');
      // 省略 scope 仍可用，但固定路由不得跨库交付来源的新身份。
      if (request.expectedDatasetId === undefined) request = { ...request, expectedDatasetId: binding.datasetId };
      if (request.command !== 'collection.list') {
        // Node 纯读借用当前代际；并发写入、刷新、失效或关闭仍撤销它的迟到回执。
        if (nodeReadonlyCommands.has(request.command)) return nodeRead(request, generation);
        // 显式刷新后的Node回退也核空领取；未尝试Rust的原Node路径不增加探测。
        if (request.command === 'recordingPrintWorker.claim' && refreshAttempted) return conditionalClaim(request, active, refreshCertificate);
        revoke('stale');
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
      catch (error) {
        while (pendingClaims(ownGeneration) && !closed && generation === ownGeneration) await readWake;
        fence(ownGeneration); failCurrent(error, ownGeneration); throw safeError(error);
      }
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
        // 判定与放行在同一同步片段；唤醒后再检查窗口，不能越过新领取。
        while (pendingClaims(ownGeneration) && !closed && generation === ownGeneration) await readWake;
        fence(ownGeneration);
        return result;
      } catch (error) {
        while (pendingClaims(ownGeneration) && !closed && generation === ownGeneration) await readWake;
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
      refreshAttempted = true;
      revoke('refreshing');
      const ownGeneration = generation, deadline = performance.now() + startupTimeout;
      const certificate: NonNullable<typeof refreshCertificate> = { generation: ownGeneration, deadline };
      refreshCertificate = certificate;
      const fresh = () => { fence(ownGeneration); if (performance.now() >= deadline) throw new RustSidecarError('TIMEOUT'); };
      const work = (async () => {
        let candidate: RustReadonlyDatasetEndpoint | undefined, exportedVersion: DatasetCollectionSnapshotVersion | undefined;
        try {
          await bounded(() => retiring, deadline); fresh();
          if (retirementError) throw retirementError;
          const initialVersion = await probe(deadline); fresh(); scoped(initialVersion);
          if (certificate.version && !sameVersion(initialVersion, certificate.version)) throw new RustSidecarError('STALE_SNAPSHOT');
          certificate.version ??= initialVersion;
          // 复用既有 pin、帧校验和进程期限；proxy 不启动或关闭来源 Owner。
          candidate = await createRustReadonlyDatasetEndpointFromOwner({
            ...options,
            startupTimeoutMs: Math.max(1, Math.floor(deadline - performance.now())),
            owner: {
              prepare: async () => { fresh(); return { epoch: binding.epoch, datasetId: binding.datasetId }; },
              exportCollectionSnapshot: async () => {
                const exported = await measured('snapshotExport', () => bounded(() => options.owner.exportVersionedCollectionSnapshot(), deadline), { generation: ownGeneration, operation: 'exportVersionedCollectionSnapshot' }, value => ({
                  ...value.version, snapshotId: value.snapshot.snapshotId, modelCount: value.snapshot.models.length, encodedBytes: Buffer.byteLength(JSON.stringify(value.snapshot), 'utf8'),
                })); fresh();
                if (!plain(exported, ['snapshot', 'version'])) throw new RustSidecarError('SNAPSHOT_UNAVAILABLE');
                exportedVersion = versionCopy(exported.version); scoped(exportedVersion);
                if (!certificate.version || !sameVersion(exportedVersion, certificate.version)) throw new RustSidecarError('STALE_SNAPSHOT');
                return exported.snapshot;
              },
              ...(profile === 'v3-5000' ? { exportLargeVersionedCollectionSnapshot: async () => {
                const exported = await measured('snapshotExport', () => bounded(() => options.owner.exportLargeVersionedCollectionSnapshot!(), deadline), { generation: ownGeneration, operation: 'exportLargeVersionedCollectionSnapshot' }, value => ({
                  ...value.version, snapshotId: value.snapshot.snapshotId, modelCount: value.snapshot.models.length, encodedBytes: Buffer.byteLength(JSON.stringify(value.snapshot), 'utf8'),
                })); fresh();
                if (!plain(exported, ['snapshot', 'version'])) throw new RustSidecarError('SNAPSHOT_UNAVAILABLE');
                exportedVersion = versionCopy(exported.version); scoped(exportedVersion);
                if (!certificate.version || !sameVersion(exportedVersion, certificate.version)) throw new RustSidecarError('STALE_SNAPSHOT');
                return exported;
              } } : {}),
              dispatch: () => Promise.reject(new RustSidecarError('UNSUPPORTED_COMMAND')),
              commitBoot: () => Promise.reject(new RustSidecarError('UNSUPPORTED_OPERATION')),
              close: () => Promise.reject(new RustSidecarError('UNSUPPORTED_OPERATION')),
            },
            onFatal: code => {
              if (candidate && generation === ownGeneration && (active?.endpoint === candidate || refreshCertificate === certificate)) {
                const wasActive = active?.endpoint === candidate;
                failCurrent(new RustSidecarError(code), ownGeneration);
                if (wasActive) terminalFailureGeneration.set(candidate, generation);
              }
              observer(code);
            },
          }, endpoint => { candidate = endpoint; refreshingCandidate = endpoint; });
          fresh();
          const current = await probe(deadline); fresh(); scoped(current);
          if (!exportedVersion || !sameVersion(current, exportedVersion)) {
            revoke('stale');
            throw new RustSidecarError('STALE_SNAPSHOT');
          }
          // 发布与放行在同一同步片段；await 后复核窗口，不能越过刚打开的新 latch。
          while (pendingClaims(ownGeneration)) {
            // 同步捕获本次 latch；bounded 的微任务不能误借已经更换的新 latch。
            const wake = readWake;
            await bounded(() => wake, deadline); fresh();
          }
          fresh();
          if (refreshCertificate !== certificate) throw new RustSidecarError('STALE_SNAPSHOT');
          active = { endpoint: candidate, version: exportedVersion };
          refreshCertificate = undefined;
          refreshingCandidate = undefined;
          phase = 'rust'; errorCode = undefined;
        } catch (error) {
          if (candidate) retire(candidate);
          failCurrent(error, ownGeneration);
          throw safeError(error);
        } finally {
          if (refreshingCandidate === candidate) refreshingCandidate = undefined;
          if (refreshCertificate === certificate) refreshCertificate = undefined;
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
  if (costSink) {
    const dispatch = router.dispatch, refresh = router.refresh;
    router.dispatch = request => measured('routerDispatch', () => dispatch(request), { requestId: request.id, generation, datasetId: binding.datasetId, epoch: binding.epoch, operation: request.command,
      ...(active ? { snapshotId: active.endpoint.snapshotId, revision: active.version.revision } : {}) });
    // 附加观察，不替换单航班返回的 Promise 身份；同一次 flight 只登记一次。
    const observedFlights = new WeakSet<Promise<void>>();
    router.refresh = () => {
      const started = performance.now(), work = refresh(), ownGeneration = generation;
      if (!observedFlights.has(work)) {
        observedFlights.add(work);
        const emit = (outcome: RustReadonlyCostObservation['outcome']) => observeRustReadonlyCost(costSink, { stage: 'routerRefresh', durationMs: performance.now() - started,
          outcome, snapshotProfile: profile, generation: ownGeneration, datasetId: binding.datasetId, epoch: binding.epoch, ...(active ? { snapshotId: active.endpoint.snapshotId, revision: active.version.revision } : {}) });
        void work.then(() => emit('fulfilled'), () => emit('rejected'));
      }
      return work;
    };
  }
  return router;
}
