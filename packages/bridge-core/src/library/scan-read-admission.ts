import { randomUUID } from 'node:crypto';

/** 仅可信 Core/唯一 DatasetOwner 通道；不是 Roon 元数据许可或 SourceLock。 */
export interface ScanReadContext { epoch: string; datasetId: string }
export type ScanReadAcquireResult = { status: 'granted'; permitId: string } | { status: 'deferred' };
export type ScanReadRevocationReason = 'media-busy' | 'admission-closed' | 'permit-released' | 'renew';
export interface ScanReadWatchResult { reason: ScanReadRevocationReason }
export interface ScanReadAdmission {
  acquire(context: ScanReadContext): ScanReadAcquireResult;
  watchRevocation(context: ScanReadContext, permitId: string): Promise<ScanReadWatchResult>;
  /** 调用方必须先等实际 read 退出和 FD 关闭；LRF 不得伪造此确认。 */
  release(context: ScanReadContext, permitId: string): { released: true };
  observe(): void;
  close(): void;
  resourceCounts(): { permits: number; revoked: number; watches: number; timers: number; closed: boolean };
}
interface Watch { resolve(value: ScanReadWatchResult): void; timer: ReturnType<typeof setTimeout> }
interface Permit { context: ScanReadContext; revoked?: 'media-busy' | 'admission-closed'; watch?: Watch }
export class ScanReadAdmissionError extends Error {
  constructor() { super('扫描读取私有许可无效。'); }
}
const validId = (value: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
const sameContext = (a: ScanReadContext, b: ScanReadContext): boolean => a.epoch === b.epoch && a.datasetId === b.datasetId;
/** 繁忙从原 Controller/网关实时采样；通知只用于迅速撤销，不创造第二份播放真相。 */
export function createScanReadAdmission(options: { isBusy(): boolean; watchTimeoutMs?: number }): ScanReadAdmission {
  const watchTimeoutMs = options.watchTimeoutMs ?? 1000;
  if (!Number.isSafeInteger(watchTimeoutMs) || watchTimeoutMs < 1 || watchTimeoutMs > 1000) throw new ScanReadAdmissionError();
  const permits = new Map<string, Permit>();
  let closed = false;
  const current = (context: ScanReadContext): void => {
    if (!validId(context.epoch) || !validId(context.datasetId)) throw new ScanReadAdmissionError();
  };
  const busy = (): boolean => { try { return options.isBusy() !== false; } catch { return true; } };
  const finishWatch = (permit: Permit, reason: ScanReadRevocationReason): void => {
    const watch = permit.watch;
    if (!watch) return;
    delete permit.watch; clearTimeout(watch.timer); watch.resolve({ reason });
  };
  const observe = (): void => {
    if (!closed && !busy()) return;
    for (const permit of permits.values()) {
      permit.revoked ??= closed ? 'admission-closed' : 'media-busy';
      finishWatch(permit, permit.revoked);
    }
  };
  const lookup = (context: ScanReadContext, id: string): Permit => {
    current(context);
    const permit = permits.get(id);
    if (!validId(id) || !permit || !sameContext(permit.context, context)) throw new ScanReadAdmissionError();
    return permit;
  };
  return {
    acquire(context) {
      current(context); observe();
      // 撤销尚不等于资源释放；原票据仍占槽，最多两个 reader 可持有许可。
      if (closed || busy() || permits.size >= 2) return { status: 'deferred' };
      const permitId = randomUUID(); permits.set(permitId, { context: { ...context } });
      return { status: 'granted', permitId };
    },
    watchRevocation(context, permitId) {
      const permit = lookup(context, permitId); observe();
      if (permit.revoked) return Promise.resolve({ reason: permit.revoked });
      if (permit.watch) throw new ScanReadAdmissionError();
      return new Promise(resolve => {
        const timer = setTimeout(() => {
          observe();
          if (permit.watch) finishWatch(permit, 'renew');
        }, watchTimeoutMs);
        permit.watch = { resolve, timer };
      });
    },
    release(context, permitId) {
      current(context);
      if (!validId(permitId)) throw new ScanReadAdmissionError();
      const permit = permits.get(permitId);
      // 同一票据重复release不需要无限tombstone；未知票据不会释放任何其它资源。
      if (permit && !sameContext(permit.context, context)) throw new ScanReadAdmissionError();
      if (permit) { finishWatch(permit, 'permit-released'); permits.delete(permitId); }
      return { released: true };
    },
    observe,
    close() {
      closed = true; observe();
      // 保留未确认quiet的票据；close通知不冒充 worker/FD 已释放。
    },
    resourceCounts() {
      let revoked = 0, watches = 0;
      for (const permit of permits.values()) { if (permit.revoked) ++revoked; if (permit.watch) ++watches; }
      return { permits: permits.size, revoked, watches, timers: watches, closed };
    },
  };
}
