import type { IpcRequest } from '@music-bridge/contracts';
import { isDatasetOwnerIdentity, isDatasetRequestEnvelope, type DatasetOwnerEndpoint, type DatasetOwnerIdentity } from '../collection/dataset-owner-protocol.js';
import { createRustReadonlyCollectionRouter, type RustReadonlyCollectionRouter,
  type RustReadonlyCollectionRouterOptions, type RustReadonlyCollectionRouterStatus } from './readonly-router.js';
import { RustSidecarError, validateRustSnapshotProfile, type RustSidecarErrorCode } from './readonly-sidecar.js';

export type RustReadonlyCoreOptions = Omit<RustReadonlyCollectionRouterOptions, 'owner'>;
export interface RustReadonlyCoreDatasetOwnerStatus {
  readonly phase: 'new' | 'prepared' | 'booting' | 'ready' | 'failed' | 'closing' | 'closed';
  readonly router?: RustReadonlyCollectionRouterStatus;
  readonly errorCode?: RustSidecarErrorCode;
}
export interface RustReadonlyCoreDatasetOwner extends DatasetOwnerEndpoint {
  refresh(): Promise<void>;
  invalidate(): void;
  getStatus(): RustReadonlyCoreDatasetOwnerStatus;
}
function budget(value: number | undefined): number {
  const result = value ?? 5_000;
  if (!Number.isSafeInteger(result) || result < 1 || result > 30_000) throw new RustSidecarError('INVALID_REQUEST');
  return result;
}
const errorCodes = new Set<RustSidecarErrorCode>(['INVALID_REQUEST', 'UNSUPPORTED_OPERATION', 'UNSUPPORTED_COMMAND', 'UNSUPPORTED_FILTER',
  'SCOPE_MISMATCH', 'CAPACITY_EXCEEDED', 'NOT_READY', 'CLOSING', 'PROTOCOL_ERROR', 'BINARY_PIN_MISMATCH',
  'TIMEOUT', 'PROCESS_EXIT', 'SNAPSHOT_UNAVAILABLE', 'STALE_SNAPSHOT']);
const safeCode = (error: unknown, fallback: RustSidecarErrorCode): RustSidecarErrorCode =>
  error instanceof RustSidecarError && errorCodes.has(error.code) ? error.code : fallback;

/** 可信主机显式准入；同步创建只绑定能力，不调用来源或启动进程。 */
export function createRustReadonlyCoreDatasetOwner(owner: DatasetOwnerEndpoint, supplied: RustReadonlyCoreOptions): RustReadonlyCoreDatasetOwner {
  const options = { ...supplied, binary: { ...supplied.binary } };
  const startupTimeout = budget(options.startupTimeoutMs);
  const closeTimeout = budget(options.closeTimeoutMs);
  budget(options.requestTimeoutMs);
  const profile = validateRustSnapshotProfile(options.snapshotProfile);
  const source = owner as RustReadonlyCollectionRouterOptions['owner'];
  if (typeof source.getCollectionSnapshotVersion !== 'function'
    || typeof source.exportVersionedCollectionSnapshot !== 'function'
    || typeof source.exportCollectionSnapshot !== 'function'
    || profile === 'v3-5000' && typeof source.exportLargeVersionedCollectionSnapshot !== 'function') {
    throw new RustSidecarError('SNAPSHOT_UNAVAILABLE');
  }
  let phase: RustReadonlyCoreDatasetOwnerStatus['phase'] = 'new';
  let errorCode: RustSidecarErrorCode | undefined;
  let preparation: Promise<DatasetOwnerIdentity> | undefined, boot: Promise<void> | undefined, closing: Promise<void> | undefined;
  let preparedIdentity: DatasetOwnerIdentity | undefined;
  let router: RustReadonlyCollectionRouter | undefined, creation: Promise<RustReadonlyCollectionRouter> | undefined;
  let initialDeadline: number | undefined;
  let sealed = false;
  const retirements = new Map<RustReadonlyCollectionRouter, Promise<void>>();
  let nodeClosure: Promise<void> | undefined;
  let sealResolve!: () => void;
  const seal = new Promise<void>(resolve => { sealResolve = resolve; });
  const usable = () => {
    if (sealed) throw new RustSidecarError('CLOSING');
    if (phase === 'failed') throw new RustSidecarError(errorCode ?? 'NOT_READY');
  };
  const fresh = (deadline: number) => { usable(); if (performance.now() >= deadline) throw new RustSidecarError('TIMEOUT'); };
  // 截断等待但消费迟到回执；不取消、更改或重放 Node 已发 RPC。
  async function bounded<T>(operation: () => T | Promise<T>, deadline: number): Promise<T> {
    fresh(deadline);
    const work = Promise.resolve().then(() => { fresh(deadline); return operation(); });
    let timer!: NodeJS.Timeout;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new RustSidecarError('TIMEOUT')), Math.max(1, deadline - performance.now()));
    });
    try {
      const result = await Promise.race([work, timeout, seal.then(() => { throw new RustSidecarError('CLOSING'); })]);
      fresh(deadline); return result;
    } finally { clearTimeout(timer); }
  }
  function retire(candidate: RustReadonlyCollectionRouter): Promise<void> {
    const existing = retirements.get(candidate);
    if (existing) return existing;
    let cleanup: Promise<void>;
    try { cleanup = Promise.resolve(candidate.close()); } catch (error) { cleanup = Promise.reject(error); }
    retirements.set(candidate, cleanup);
    void cleanup.catch(() => {});
    return cleanup;
  }
  function closeNode(): Promise<void> {
    if (nodeClosure) return nodeClosure;
    try { nodeClosure = Promise.resolve(owner.close()); } catch (error) { nodeClosure = Promise.reject(error); }
    void nodeClosure.catch(() => {});
    return nodeClosure;
  }
  function fail(error: unknown): void {
    if (!sealed) { phase = 'failed'; errorCode = safeCode(error, 'SNAPSHOT_UNAVAILABLE'); }
    if (router) void retire(router).catch(() => {});
    void closeNode().catch(() => {});
  }
  function privateCall<T>(operation: () => Promise<T>): Promise<T> {
    try {
      usable();
      return initialDeadline === undefined ? Promise.resolve().then(() => { usable(); return operation(); }) : bounded(operation, initialDeadline);
    } catch (error) { return Promise.reject(error); }
  }
  const borrowed: RustReadonlyCollectionRouterOptions['owner'] = {
    prepare: () => Promise.reject(new RustSidecarError('UNSUPPORTED_OPERATION')),
    commitBoot: () => Promise.reject(new RustSidecarError('UNSUPPORTED_OPERATION')),
    close: () => Promise.reject(new RustSidecarError('UNSUPPORTED_OPERATION')),
    dispatch: request => owner.dispatch(request),
    exportCollectionSnapshot: () => privateCall(() => source.exportCollectionSnapshot()),
    getCollectionSnapshotVersion: () => privateCall(() => source.getCollectionSnapshotVersion()),
    exportVersionedCollectionSnapshot: () => privateCall(() => source.exportVersionedCollectionSnapshot()),
    ...(profile === 'v3-5000' ? {
      exportLargeVersionedCollectionSnapshot: () => privateCall(() => source.exportLargeVersionedCollectionSnapshot!()),
    } : {}),
  };
  const endpoint: RustReadonlyCoreDatasetOwner = {
    ...(owner.captureLocalSource ? {captureLocalSource: (selection: import('@music-bridge/contracts').LocalPlayRequest) => {usable();if(phase!=='ready')return Promise.reject(new RustSidecarError('NOT_READY'));return owner.captureLocalSource!(selection);}} : {}),
    ...(owner.revalidateLocalSource ? {revalidateLocalSource: (ticketId:string) => {usable();return owner.revalidateLocalSource!(ticketId);}} : {}),
    ...(owner.releaseLocalSource ? {releaseLocalSource: (ticketId:string) => owner.releaseLocalSource!(ticketId)} : {}),
    ...(owner.sealLocalSources ? {sealLocalSources: () => owner.sealLocalSources!()} : {}),
    ...(owner.isLocalSourceCurrent ? {isLocalSourceCurrent: () => !sealed && phase==='ready' && owner.isLocalSourceCurrent!()} : {}),
    ...(owner.dispatchInternal ? {dispatchInternal: (request:IpcRequest) => {usable();return owner.dispatchInternal!(request);}} : {}),

    prepare() {
      try { usable(); } catch (error) { return Promise.reject(error); }
      if (preparation) return preparation;
      preparation = bounded(() => owner.prepare(), performance.now() + startupTimeout).then(identity => {
        if (!isDatasetOwnerIdentity(identity)) throw new RustSidecarError('SNAPSHOT_UNAVAILABLE');
        preparedIdentity = Object.freeze({ epoch: identity.epoch, datasetId: identity.datasetId });
        if (phase === 'new') phase = 'prepared';
        return preparedIdentity;
      }).catch(error => { fail(error); throw error; });
      void preparation.catch(() => {});
      return preparation;
    },
    commitBoot() {
      try { usable(); } catch (error) { return Promise.reject(error); }
      if (boot) return boot;
      initialDeadline = performance.now() + startupTimeout;
      const deadline = initialDeadline;
      phase = 'booting';
      boot = (async () => {
        try {
          await bounded(() => endpoint.prepare(), deadline);
          await bounded(() => owner.commitBoot(), deadline);
          fresh(deadline);
          creation = createRustReadonlyCollectionRouter({ ...options, owner: borrowed,
            startupTimeoutMs: Math.max(1, Math.floor(deadline - performance.now())),
          }).then(candidate => {
            router = candidate;
            // router 创建可以晚于外层期限；登记之后只能清理，不能刷新或发布。
            if (sealed || phase !== 'booting' || performance.now() >= deadline) void retire(candidate).catch(() => {});
            return candidate;
          });
          const candidate = await bounded(() => creation!, deadline);
          const binding = candidate.getStatus();
          if (binding.epoch !== preparedIdentity!.epoch || binding.datasetId !== preparedIdentity!.datasetId) {
            throw new RustSidecarError('SCOPE_MISMATCH');
          }
          await bounded(() => candidate.refresh(), deadline);
          fresh(deadline);
          phase = 'ready'; initialDeadline = undefined;
        } catch (error) { fail(error); throw error; }
      })();
      void boot.catch(() => {});
      return boot;
    },
    dispatch(request: IpcRequest) {
      try {
        usable();
        if (phase !== 'ready' || !router) throw new RustSidecarError('NOT_READY');
        // 领域闭集先挡在组合边界，Provider/auth/playback 不能触达 source 或 Rust。
        if (!isDatasetRequestEnvelope(request)) throw new RustSidecarError('UNSUPPORTED_COMMAND');
        return router.dispatch(request);
      } catch (error) { return Promise.reject(error); }
    },
    refresh() {
      try {
        usable();
        if (phase !== 'ready' || !router) throw new RustSidecarError('NOT_READY');
        return router.refresh();
      } catch (error) { return Promise.reject(error); }
    },
    invalidate() { if (!sealed) router?.invalidate(); },
    getStatus() {
      return Object.freeze({ phase, ...(router ? { router: router.getStatus() } : {}), ...(errorCode ? { errorCode } : {}) });
    },
    close() {
      if (closing) return closing;
      const deadline = performance.now() + closeTimeout;
      sealed = true; phase = 'closing'; sealResolve();
      if (router) void retire(router).catch(() => {});
      const node = closeNode();
      const cleanup = (async () => {
        // 创建/boot 的失败已在原调用交付；关闭只认资源收口的结果。
        await Promise.allSettled([preparation, boot, creation]);
        const results = await Promise.allSettled([node, ...retirements.values()]);
        const failure = results.find(result => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
      })();
      let timer!: NodeJS.Timeout;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new RustSidecarError('TIMEOUT')), Math.max(1, deadline - performance.now()));
      });
      // 超时只结束等待。后台资源回执继续消费，晚到成功无权改写 failed 为 closed。
      closing = Promise.race([cleanup, timeout]).then(() => {
        if (performance.now() >= deadline) throw new RustSidecarError('TIMEOUT');
        phase = 'closed';
      }).catch(error => {
        phase = 'failed'; errorCode = safeCode(error, 'PROCESS_EXIT');
        throw error;
      }).finally(() => { clearTimeout(timer); });
      void closing.catch(() => {});
      return closing;
    },
  };
  return endpoint;
}
