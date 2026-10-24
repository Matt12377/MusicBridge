import { AsyncLocalStorage } from 'node:async_hooks';
import { MobileServiceError } from './types.js';

/** 只属于同一个Main HTTP请求；不经IPC/Renderer，也不保存任何授权结论。 */
export interface MobileMediaReadBudget {
  readonly deadlineAtMs: number;
  readonly signal: AbortSignal;
  assertCurrent(): void;
  remainingMs(): number;
}
export const MOBILE_MEDIA_READ_TOTAL_MS = 30_000;
export const MOBILE_MEDIA_READ_MAX_BYTES = 256 * 1024;
const storage = new AsyncLocalStorage<Readonly<MobileMediaReadBudget>>();

/** 只有原合同的显式单闭合小Range采用本预算；If-Range/整流/HEAD不扩大等待策略。 */
export function boundedMobileMediaReadRange(range: string): boolean {
  if (range.length > 128) return false;
  const match = /^bytes=(\d+)-(\d+)(?![\s\S])/u.exec(range);
  if (!match) return false;
  const start = Number(match[1]), end = Number(match[2]);
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= start
    && end - start < MOBILE_MEDIA_READ_MAX_BYTES;
}

export function withMobileMediaReadBudget<T>(deadlineAtMs: number, signal: AbortSignal, work: () => T): T {
  const currentAtMs = performance.now();
  if (!Number.isFinite(deadlineAtMs) || deadlineAtMs <= currentAtMs || deadlineAtMs > currentAtMs + MOBILE_MEDIA_READ_TOTAL_MS)
    throw new MobileServiceError(503, 'BUSY');
  const current = () => {
    signal.throwIfAborted();
    // 同步复核也涵盖事件循环阻塞后先执行的Promise，不能只依赖timer及时触发。
    if (performance.now() >= deadlineAtMs) throw new MobileServiceError(503, 'BUSY');
  };
  return storage.run(Object.freeze({ deadlineAtMs, signal, assertCurrent: current,
    remainingMs() { current(); return Math.min(MOBILE_MEDIA_READ_TOTAL_MS, deadlineAtMs - performance.now()); } }), work);
}

export function captureMobileMediaReadBudget(): Readonly<MobileMediaReadBudget> | undefined { return storage.getStore(); }
