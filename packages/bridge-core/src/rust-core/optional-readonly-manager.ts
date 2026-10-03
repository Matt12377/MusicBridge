import type { DatasetOwnerEndpoint, DatasetOwnerVersionedSnapshotEndpoint } from '../collection/dataset-owner-protocol.js';
import { createRustReadonlyCollectionRouter, type RustReadonlyCollectionRouter, type RustReadonlyCollectionRouterOptions } from './readonly-router.js';
import { RustSidecarError } from './readonly-sidecar.js';

export interface OptionalReadonlyStatus {
  schemaVersion: 1;
  enabled: boolean;
  mode: 'node' | 'rust';
  state: 'off' | 'enabling' | 'ready' | 'stale' | 'refreshing' | 'failed' | 'blocked' | 'closing';
  errorCode?: 'RUST_UNAVAILABLE' | 'RUST_STALE' | 'RUST_BLOCKED';
}
export interface OptionalReadonlyRefreshResult { refreshed: boolean; status: OptionalReadonlyStatus }
export interface OptionalRustReadonlyManagerOptions {
  createOptions: () => Promise<Omit<RustReadonlyCollectionRouterOptions, 'owner'>>;
  // 测试和同进程可信宿主接口；不能由父消息或 Renderer 选择。
  createRouter?: typeof createRustReadonlyCollectionRouter;
  operationTimeoutMs?: number;
}
export interface OptionalRustReadonlyManager {
  decorate<T extends DatasetOwnerEndpoint>(owner: T): T;
  setEnabled(enabled: boolean): Promise<OptionalReadonlyStatus>;
  refresh(): Promise<OptionalReadonlyRefreshResult>;
  getStatus(): OptionalReadonlyStatus;
}

/** 只附加已 boot 的唯一 Node 作者。失败的 native 收口留在本代，不能靠再次 ON 洗掉。 */
export function createOptionalRustReadonlyManager(options: OptionalRustReadonlyManagerOptions): OptionalRustReadonlyManager {
  const timeout = options.operationTimeoutMs ?? 5_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 5_000) throw new RustSidecarError('INVALID_REQUEST');
  let owner: DatasetOwnerEndpoint | undefined, booted = false, enabled = false, generation = 0, closed = false;
  let state: OptionalReadonlyStatus['state'] = 'off', blocked = false;
  let active: RustReadonlyCollectionRouter | undefined, enableFlight: Promise<OptionalReadonlyStatus> | undefined;
  let refreshFlight: { generation: number; promise: Promise<OptionalReadonlyRefreshResult> } | undefined, closing: Promise<void> | undefined;
  // 原始建立任务、晚到 router 和失败引用都登记；不把 Promise.race 当取消。
  const establishing = new Set<Promise<unknown>>(), routers = new Set<RustReadonlyCollectionRouter>();
  const retired = new Map<RustReadonlyCollectionRouter, Promise<void>>();
  let retirementError: unknown;
  const current = (token: number) => !closed && enabled && generation === token && !blocked;
  function block(error: unknown): void { retirementError ??= error; blocked = true; state = 'blocked'; }
  async function bounded<T>(work: Promise<T>): Promise<T> {
    let timer!: NodeJS.Timeout;
    try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new RustSidecarError('TIMEOUT')), timeout); })]); }
    finally { clearTimeout(timer); }
  }
  function track<T>(work: Promise<T>): Promise<T> {
    establishing.add(work);
    void work.then(() => establishing.delete(work), () => establishing.delete(work));
    return work;
  }
  function retire(router: RustReadonlyCollectionRouter): Promise<void> {
    const previous = retired.get(router); if (previous) return previous;
    router.invalidate();
    let work: Promise<void>;
    try { work = Promise.resolve(router.close()); } catch (error) { work = Promise.reject(error); }
    const settled = work.catch(error => { block(error); throw error; });
    retired.set(router, settled); void settled.catch(() => {});
    return settled;
  }
  // 撤权发生在任何 await 前。close 负责真实 ACK/pending0/自然退出；这里只等待其证明。
  function revoke(): void {
    generation++; active = undefined;
    for (const router of routers) void retire(router).catch(() => {});
  }
  async function drain(): Promise<void> {
    try {
      // 建立任务可能在 OFF 后才交付 router；任务内部先登记并 retire，随后循环收口。
      while (establishing.size) await bounded(Promise.allSettled([...establishing]));
      const results = await bounded(Promise.allSettled([...retired.values()]));
      for (const result of results) if (result.status === 'rejected') throw result.reason;
      if (retirementError) throw retirementError;
    } catch (error) { block(error); throw error; }
  }
  function getStatus(): OptionalReadonlyStatus {
    let actualState = closed ? 'closing' as const : blocked ? 'blocked' as const : state;
    const route = active?.getStatus();
    if (enabled && !blocked && state !== 'enabling' && state !== 'refreshing' && route) {
      actualState = route.phase === 'rust' ? 'ready' : route.phase === 'stale' ? 'stale' : route.phase === 'failed' ? 'failed' : actualState;
    }
    const mode = enabled && !closed && !blocked && route?.phase === 'rust' ? 'rust' as const : 'node' as const;
    return Object.freeze({ schemaVersion: 1, enabled, mode, state: actualState,
      ...(actualState === 'blocked' ? { errorCode: 'RUST_BLOCKED' as const } : actualState === 'failed' ? { errorCode: 'RUST_UNAVAILABLE' as const } : actualState === 'stale' ? { errorCode: 'RUST_STALE' as const } : {}) });
  }
  function refresh(): Promise<OptionalReadonlyRefreshResult> {
    if (!enabled || !active || closed || blocked) return Promise.resolve({ refreshed: false, status: getStatus() });
    if (refreshFlight?.generation === generation) return refreshFlight.promise;
    const token = generation, router = active; state = 'refreshing';
    const work = (async () => {
      try { await bounded(router.refresh()); if (current(token) && active === router) state = 'ready'; }
      catch (error) {
        if (current(token)) {
          if (error instanceof RustSidecarError && error.code === 'TIMEOUT') { block(error); revoke(); }
          else state = 'failed';
        }
      }
      const status = getStatus();
      return { refreshed: current(token) && active === router && status.mode === 'rust' && status.state === 'ready', status };
    })();
    const flight = { generation: token, promise: work.finally(() => { if (refreshFlight === flight) refreshFlight = undefined; }) };
    refreshFlight = flight; return flight.promise;
  }
  function setEnabled(next: boolean): Promise<OptionalReadonlyStatus> {
    if (typeof next !== 'boolean') return Promise.reject(new RustSidecarError('INVALID_REQUEST'));
    if (closed) return Promise.resolve(getStatus());
    if (!next) {
      enabled = false; state = 'closing'; revoke();
      return drain().then(() => { if (!enabled && !closed && !blocked) state = 'off'; return getStatus(); }, () => getStatus());
    }
    if (enabled && enableFlight) return enableFlight;
    enabled = true;
    if (blocked || !booted) { if (!blocked) state = 'failed'; return Promise.resolve(getStatus()); }
    if (active) return Promise.resolve(getStatus());
    const token = ++generation; state = 'enabling';
    const work = (async () => {
      try {
        await drain(); if (!current(token)) return getStatus();
        const configuration = await bounded(track(Promise.resolve().then(options.createOptions)));
        if (!current(token)) return getStatus();
        const creation = track(Promise.resolve().then(() => (options.createRouter ?? createRustReadonlyCollectionRouter)({
          ...configuration, owner: owner as DatasetOwnerVersionedSnapshotEndpoint,
          onFatal: code => {
            try { configuration.onFatal?.(code); }
            finally {
              block(new RustSidecarError(code)); generation++; active = undefined;
              // 原 router 已同步撤权并登记 native 退休；不要再次 invalidate/close 改写
              // 已发送读取的原失败。保留 router 引用，OFF/整Core关闭再收取关闭证明。
            }
          },
        })).then(router => {
          routers.add(router);
          if (!current(token)) { void retire(router).catch(() => {}); return router; }
          active = router; return router;
        }));
        const router = await bounded(creation);
        if (!current(token) || active !== router) return getStatus();
        const result = await refresh();
        return result.status;
      } catch (error) {
        if (current(token)) {
          // 超时意味着存在未确认资源，保持本 Core 封禁；准入拒绝尚未创建 native 则可稍后重试。
          if (error instanceof RustSidecarError && error.code === 'TIMEOUT') { block(error); revoke(); }
          else state = 'failed';
        }
        return getStatus();
      }
    })();
    enableFlight = work.finally(() => { if (enableFlight === joined) enableFlight = undefined; });
    const joined = enableFlight; return joined;
  }
  return {
    getStatus, setEnabled, refresh,
    decorate<T extends DatasetOwnerEndpoint>(source: T): T {
      if (owner) throw new RustSidecarError('INVALID_REQUEST'); owner = source;
      const bound = new Map<PropertyKey, unknown>();
      const overrides: DatasetOwnerEndpoint = {
        prepare: () => source.prepare(),
        commitBoot: async () => { await source.commitBoot(); booted = true; },
        dispatch: request => active && enabled && !closed && !blocked ? active.dispatch(request) : source.dispatch(request),
        close() {
          if (closing) return closing;
          closed = true; enabled = false; state = 'closing'; revoke();
          closing = (async () => {
            const results = await Promise.allSettled([drain(), Promise.resolve().then(() => source.close())]);
            for (const result of results) if (result.status === 'rejected') throw result.reason;
          })();
          void closing.catch(() => {}); return closing;
        },
      };
      return new Proxy(source, { get(target, key) {
        if (Object.hasOwn(overrides, key)) return overrides[key as keyof DatasetOwnerEndpoint];
        if (!bound.has(key)) { const value: unknown = Reflect.get(target, key, target); bound.set(key, typeof value === 'function' ? value.bind(target) : value); }
        return bound.get(key);
      } });
    },
  };
}
