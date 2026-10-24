import { randomUUID } from 'node:crypto';
import { isDatasetProjectionPayload, isDatasetProjectionResult, type DatasetProjectionPort, type DatasetProjectionCommand,
  type DatasetProjectionCommandPayloads, type DatasetProjectionCommandResults } from './dataset-owner-protocol.js';
import { logLibraryOperation } from '../shared/library-operation-log.js';

type Acquire = DatasetProjectionCommandResults['scanReadAcquire'];
type Released = DatasetProjectionCommandResults['scanReadRelease'];
type Read = { signal?: AbortSignal; deadlineAtMs?: number };
type Failure = 'SOURCE_READ_CANCELLED'|'SOURCE_READ_DEADLINE'|'SOURCE_READ_CLOSED'|'SOURCE_READ_STALE'
  |'SOURCE_READ_QUEUE_FULL'|'SOURCE_READ_INVALID'|'SOURCE_READ_ACQUIRE_FAILED'|'SOURCE_READ_RELEASE_FAILED'|'SOURCE_READ_NOT_QUIET';
export class LocalSourceReadError extends Error {
  constructor(readonly code: Failure) { super('本地来源读取调度未完成。'); }
}
interface Waiter {
  id: string; payload: DatasetProjectionCommandPayloads['scanReadAcquire']; read: Read | undefined; queuedAt: number;
  running: boolean; settled: boolean; cancelled?: LocalSourceReadError;
  detach(): void; resolve(value: Acquire): void; reject(error: unknown): void;
}
interface Slot { waiter: Waiter; permitId?: string; grantedAt?: number; release?: Promise<Released> }

/** 仅调度同一 Owner 的原读取；Core 仍独占实际许可、用途与播放准入，不在排队时取得票据或 FD。 */
export function createLocalSourceReadProjection(options: { projection: DatasetProjectionPort; assertCurrent(): void; concurrency?: 1 | 2 | 8 }) {
  const concurrency = options.concurrency ?? 2;
  if (![1, 2, 8].includes(concurrency)) throw new LocalSourceReadError('SOURCE_READ_INVALID');
  const pending: Waiter[] = [], active = new Set<Slot>(), permits = new Map<string, Slot>(), flights = new Set<Promise<unknown>>();
  let closed = false, fatal: LocalSourceReadError | undefined;
  function track<T>(task: Promise<T>): Promise<T> {
    flights.add(task); void task.then(() => flights.delete(task), () => flights.delete(task)); return task;
  }
  function reject(waiter: Waiter, error: LocalSourceReadError): void {
    if (waiter.settled) return;
    waiter.settled = true; waiter.detach(); waiter.reject(error);
    logLibraryOperation('scan', 'source.read-queue', 'cancelled', { id: waiter.id, code: error.code,
      queueWaitMs: performance.now() - waiter.queuedAt, active: active.size, pending: pending.length });
  }
  function seal(error = new LocalSourceReadError('SOURCE_READ_CLOSED')): void {
    closed = true; for (const waiter of pending.splice(0)) reject(waiter, error);
  }
  function currentFailure(): LocalSourceReadError | undefined {
    try { options.assertCurrent(); return undefined; }
    catch { const error = new LocalSourceReadError('SOURCE_READ_STALE'); seal(error); return error; }
  }
  function stopped(waiter: Waiter): LocalSourceReadError | undefined {
    return fatal ?? waiter.cancelled ?? currentFailure() ?? (closed ? new LocalSourceReadError('SOURCE_READ_CLOSED')
      : waiter.read?.signal?.aborted ? new LocalSourceReadError('SOURCE_READ_CANCELLED')
      : waiter.read?.deadlineAtMs !== undefined && performance.now() >= waiter.read.deadlineAtMs ? new LocalSourceReadError('SOURCE_READ_DEADLINE') : undefined);
  }
  function release(slot: Slot): Promise<Released> {
    if (slot.release) return slot.release;
    const began = performance.now();
    logLibraryOperation('scan', 'source.read-source', 'complete', { id: slot.waiter.id,
      readMs: Math.max(0, began - (slot.grantedAt ?? began)), active: active.size, pending: pending.length });
    slot.release = track((async () => {
      try {
        const result = await options.projection.call('scanReadRelease', { permitId: slot.permitId! });
        if (!isDatasetProjectionResult('scanReadRelease', result)) throw new Error('来源许可释放回执无效。');
        permits.delete(slot.permitId!); active.delete(slot);
        logLibraryOperation('scan', 'source.read-quiet', 'complete', { id: slot.waiter.id, elapsedMs: performance.now() - began,
          active: active.size, pending: pending.length, count: permits.size });
        pump(); return result;
      } catch {
        fatal ??= new LocalSourceReadError('SOURCE_READ_RELEASE_FAILED'); seal(fatal);
        // 未确认的票据与本地槽继续保留；不能靠取消、重试或关闭伪造 quiet。
        logLibraryOperation('scan', 'source.read-quiet', 'error', { id: slot.waiter.id, code: fatal.code,
          elapsedMs: performance.now() - began, active: active.size, pending: pending.length });
        throw fatal;
      }
    })()); return slot.release;
  }
  async function grant(slot: Slot): Promise<void> {
    const waiter = slot.waiter;
    try {
      // 不把本地取消传给已派发 Acquire；必须接到真实回执后收回迟到票据，不能丢弃授予。
      const result = await options.projection.call('scanReadAcquire', waiter.payload);
      if (!isDatasetProjectionResult('scanReadAcquire', result)) throw new Error('来源许可授予回执无效。');
      if (result.status === 'granted') {
        slot.permitId = result.permitId; slot.grantedAt = performance.now(); permits.set(result.permitId, slot);
        const error = stopped(waiter);
        if (error) { await release(slot); reject(waiter, error); return; }
      } else {
        active.delete(slot);
        const error = stopped(waiter); if (error) { reject(waiter, error); pump(); return; }
      }
      waiter.settled = true; waiter.detach(); waiter.resolve(result);
      logLibraryOperation('scan', 'source.read-queue', result.status === 'granted' ? 'complete' : 'skipped', {
        id: waiter.id, ...(result.status === 'deferred' ? { code: 'CORE_READ_DEFERRED' } : {}),
        queueWaitMs: performance.now() - waiter.queuedAt, active: active.size, pending: pending.length, count: permits.size });
      pump();
    } catch {
      fatal ??= new LocalSourceReadError('SOURCE_READ_ACQUIRE_FAILED'); seal(fatal); reject(waiter, fatal);
      // 反向通道结果不明时保留本地占槽；唯有真实 release 成功才可恢复该槽。
    }
  }
  function pump(): void {
    while (!closed && !fatal && active.size < concurrency && pending.length) {
      const waiter = pending.shift()!, error = stopped(waiter);
      if (error) { reject(waiter, error); continue; }
      waiter.running = true; const slot: Slot = { waiter }; active.add(slot); void track(grant(slot));
    }
  }
  function acquire(payload: DatasetProjectionCommandPayloads['scanReadAcquire'], read?: Read): Promise<Acquire> {
    if (!isDatasetProjectionPayload('scanReadAcquire', payload) || read?.deadlineAtMs !== undefined && !Number.isFinite(read.deadlineAtMs))
      return Promise.reject(new LocalSourceReadError('SOURCE_READ_INVALID'));
    const error = fatal ?? currentFailure() ?? (closed ? new LocalSourceReadError('SOURCE_READ_CLOSED') : undefined);
    if (error) return Promise.reject(error);
    if (pending.length >= 32) return Promise.reject(new LocalSourceReadError('SOURCE_READ_QUEUE_FULL'));
    return new Promise((resolve, fail) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cancel = (code: 'SOURCE_READ_CANCELLED'|'SOURCE_READ_DEADLINE'): void => {
        if (waiter.settled) return; waiter.cancelled ??= new LocalSourceReadError(code); waiter.detach();
        if (waiter.running) return;
        const at = pending.indexOf(waiter); if (at >= 0) pending.splice(at, 1); reject(waiter, waiter.cancelled); pump();
      };
      const abort = (): void => cancel('SOURCE_READ_CANCELLED');
      const waiter: Waiter = { id: randomUUID(), payload: structuredClone(payload), read, queuedAt: performance.now(), running: false, settled: false,
        resolve, reject: fail, detach() { if (timer) clearTimeout(timer); read?.signal?.removeEventListener('abort', abort); } };
      pending.push(waiter); read?.signal?.addEventListener('abort', abort, { once: true });
      if (read?.deadlineAtMs !== undefined) timer = setTimeout(() => cancel('SOURCE_READ_DEADLINE'), Math.max(1, read.deadlineAtMs - performance.now()));
      if (read?.signal?.aborted) abort(); else if (read?.deadlineAtMs !== undefined && performance.now() >= read.deadlineAtMs) cancel('SOURCE_READ_DEADLINE');
      logLibraryOperation('scan', 'source.read-queue', 'start', { id: waiter.id, active: active.size, pending: pending.length }); pump();
    });
  }
  const port: DatasetProjectionPort = {
    async call<K extends DatasetProjectionCommand>(command: K, payload: DatasetProjectionCommandPayloads[K], read?: Read): Promise<DatasetProjectionCommandResults[K]> {
      if (command === 'scanReadAcquire') return await acquire(payload as DatasetProjectionCommandPayloads['scanReadAcquire'], read) as DatasetProjectionCommandResults[K];
      if (command === 'scanReadRelease' && isDatasetProjectionPayload(command, payload)) {
        const slot = permits.get((payload as DatasetProjectionCommandPayloads['scanReadRelease']).permitId);
        if (slot) return await release(slot) as DatasetProjectionCommandResults[K];
      }
      return options.projection.call(command, payload, read);
    },
  };
  return { port, seal,
    async close(): Promise<void> {
      seal(); await Promise.allSettled([...flights]);
      if (fatal) throw fatal; if (active.size || permits.size) throw new LocalSourceReadError('SOURCE_READ_NOT_QUIET');
    },
    inspect: () => ({ active: active.size, pending: pending.length, closed, fatal: fatal !== undefined }),
  };
}
