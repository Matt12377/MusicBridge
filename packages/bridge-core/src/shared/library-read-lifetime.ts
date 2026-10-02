import { AsyncLocalStorage } from 'node:async_hooks';
import { BridgeError } from './errors.js';
import { emitLibraryReadTrace, type LibraryReadTraceEvent, type LibraryReadTraceReason, type LibraryReadTraceSink } from './library-read-trace.js';

export interface LibraryReadLifetime {
  signal: AbortSignal;
  deadlineAtMs: number;
  cacheMode?: 'reload';
  now: () => number;
  isCurrent: () => boolean;
  trace?: { coreReadId: string; flightId: string; command: NonNullable<LibraryReadTraceEvent['command']>; emit: LibraryReadTraceSink };
}
const reads = new AsyncLocalStorage<LibraryReadLifetime>();
export const currentLibraryRead = (): LibraryReadLifetime | undefined => reads.getStore();
export function assertLibraryReadCurrent(): void {
  const read = reads.getStore();
  if (!read) return;
  if (read.signal.aborted) throw read.signal.reason instanceof BridgeError ? read.signal.reason : libraryReadCancelled();
  if (!read.isCurrent()) throw libraryReadCancelled('scope-changed');
  if (read.now() >= read.deadlineAtMs) throw libraryReadTimeout();
}
export const libraryReadCancelled = (source: LibraryReadTraceReason = 'unknown'): BridgeError => Object.assign(new BridgeError('READ_CANCELLED', '读取已取消'), { libraryReadSource: source });
export const libraryReadTimeout = (source: LibraryReadTraceReason = 'subscriber-deadline'): BridgeError => Object.assign(new BridgeError('READ_DEADLINE', '读取期限已到'), { libraryReadSource: source });
export function traceLibraryRead(event: LibraryReadTraceEvent): void {
  const trace = reads.getStore()?.trace;
  if (trace) emitLibraryReadTrace(trace.emit, { ...event, coreReadId: trace.coreReadId, flightId: trace.flightId, command: trace.command });
}
export function withLibraryRead<T>(read: LibraryReadLifetime, operation: () => T): T {
  return reads.run(read, () => { assertLibraryReadCurrent(); return operation(); });
}
export function remainingLibraryReadMs(maximum: number): number {
  assertLibraryReadCurrent();
  const read = reads.getStore();
  return read ? Math.max(1, Math.min(maximum, read.deadlineAtMs - read.now())) : maximum;
}
/** 仅结束本地等待，底层不可撤销调用仍须保留资源计数到实际返回。 */
export function waitLibraryRead<T>(work: Promise<T>, abandoned?: () => void): Promise<T> {
  const read = reads.getStore();
  if (!read) return work;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: unknown, value?: T): void => {
      if (settled) return;
      settled = true; clearTimeout(timer); read.signal.removeEventListener('abort', cancel);
      if (error) reject(error); else resolve(value as T);
    };
    const cancel = (): void => { abandoned?.(); finish(read.signal.reason instanceof BridgeError ? read.signal.reason : libraryReadCancelled()); };
    const timer = setTimeout(() => { abandoned?.(); finish(libraryReadTimeout()); }, Math.max(0, read.deadlineAtMs - read.now()));
    read.signal.addEventListener('abort', cancel, { once: true });
    work.then(value => { try { assertLibraryReadCurrent(); finish(undefined, value); } catch (error) { abandoned?.(); finish(error); } }, error => finish(error));
    if (read.signal.aborted) cancel();
  });
}
