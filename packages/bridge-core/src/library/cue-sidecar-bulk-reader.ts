import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { withCheckedReadonlyMetadataSource, MetadataLeaseReleaseError, SourceFileError } from '../recording/source-files.js';
import type { CueSidecarReaderInput, CueSidecarReadResult } from './cue-sidecar-reader.js';

export type CueSidecarBulkLifecycle = { type: 'lease-acquired' | 'lease-released'; fd: number }
  | { type: 'worker-start' | 'worker-exit'; fd: number; threadId: number }
  | { type: 'read-start' | 'read-settled'; fd: number; threadId: number; requestId: string };
const failure = (code: string): CueSidecarReadResult => ({ status: 'failure', code });
const closedFrame = (value: unknown, names: readonly string[]): value is Record<string, unknown> => value !== null
  && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === names.length
  && names.every(name => Object.hasOwn(value, name));

/** 仅冻结八槽作业使用；每个Worker每次只借一个FD，正常settled后可复用，未settled取消必须等真实exit。 */
export function createCueSidecarBulkReader(options: { onLifecycle?: (event: CueSidecarBulkLifecycle) => void } = {}) {
  let closed = false, fatal = false, closePromise: Promise<void> | undefined;
  const active = new Map<AbortController, Promise<CueSidecarReadResult>>();
  const emit = (event: CueSidecarBulkLifecycle): void => { try { options.onLifecycle?.(event); } catch { /* 观察者不影响资源收口。 */ } };

  function resident() {
    const actual = new Worker(new URL('./cue-sidecar-bulk-worker.js', import.meta.url), {
      execArgv: [], env: {}, resourceLimits: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 },
    });
    const threadId = actual.threadId;
    let ready = false, started = false, ended = false, stopping = false;
    let exited!: () => void;
    const exit = new Promise<void>(resolve => { exited = resolve; });
    interface Pending {
      fd: number; size: number; requestId: string; signal: AbortSignal; forced?: string;
      resolve(value: CueSidecarReadResult): void; abort(): void;
      startTimer?: ReturnType<typeof setTimeout>; readTimer?: ReturnType<typeof setTimeout>;
    }
    let pending: Pending | undefined;
    function finish(call: Pending, value: CueSidecarReadResult): void {
      if (pending !== call) return;
      clearTimeout(call.startTimer); clearTimeout(call.readTimer);
      call.signal.removeEventListener('abort', call.abort); pending = undefined;
      call.resolve(value);
    }
    function stop(code: string): void {
      if (pending) pending.forced ??= code;
      if (stopping || ended) return;
      stopping = true;
      // terminate的返回或失败不能替代真实exit；Source消费只会在exit回调后结束。
      void actual.terminate().catch(() => { if (pending) pending.forced = 'WORKER_FAILED'; });
    }
    function send(call: Pending): void {
      if (pending !== call || call.forced || stopping || ended) return;
      clearTimeout(call.startTimer);
      call.readTimer = setTimeout(() => stop('TIMEOUT'), 5000);
      try { actual.postMessage({ kind: 'read', protocol: 1, requestId: call.requestId, fd: call.fd, size: call.size }); }
      catch { stop('WORKER_FAILED'); return; }
      emit({ type: 'read-start', fd: call.fd, threadId, requestId: call.requestId });
    }
    actual.on('message', (value: unknown) => {
      if (closedFrame(value, ['kind','protocol']) && value.kind === 'ready' && value.protocol === 1 && !ready) {
        ready = true; if (pending) send(pending); return;
      }
      const call = pending;
      if (!call || !ready) { stop('WORKER_FAILED'); return; }
      if (call.forced || stopping) return;
      const names = value !== null && typeof value === 'object' && (value as Record<string, unknown>).status === 'ok'
        ? ['kind','protocol','requestId','borrowedFdReleased','status','bytes','readCalls']
        : ['kind','protocol','requestId','borrowedFdReleased','status','code'];
      if (!closedFrame(value, names) || value.kind !== 'settled' || value.protocol !== 1
        || value.requestId !== call.requestId || value.borrowedFdReleased !== true) { stop('WORKER_FAILED'); return; }
      let result: CueSidecarReadResult;
      if (value.status === 'ok' && value.bytes instanceof Uint8Array && value.bytes.length === call.size
        && value.bytes.buffer instanceof ArrayBuffer && value.bytes.byteOffset === 0 && value.bytes.buffer.byteLength === call.size
        && Number.isSafeInteger(value.readCalls) && Number(value.readCalls) >= 1 && Number(value.readCalls) <= 64)
        result = { status: 'ok', bytes: value.bytes, readCalls: Number(value.readCalls) };
      else if (value.status === 'failure' && typeof value.code === 'string' && ['BUDGET_EXCEEDED','IO_ERROR'].includes(value.code)) result = failure(value.code);
      else { stop('WORKER_FAILED'); return; }
      clearTimeout(call.startTimer); clearTimeout(call.readTimer);
      call.signal.removeEventListener('abort', call.abort); pending = undefined;
      emit({ type: 'read-settled', fd: call.fd, threadId, requestId: call.requestId });
      call.resolve(result);
    });
    actual.once('error', () => stop('WORKER_FAILED'));
    actual.once('exit', () => {
      ended = true;
      const call = pending;
      emit({ type: 'worker-exit', fd: call?.fd ?? -1, threadId });
      exited();
      if (call) finish(call, failure(call.forced ?? 'WORKER_FAILED'));
    });
    return {
      get ended() { return ended; },
      read(fd: number, size: number, signal: AbortSignal): Promise<CueSidecarReadResult> {
        if (pending || stopping || ended) return Promise.resolve(failure('WORKER_FAILED'));
        return new Promise(resolve => {
          const call: Pending = { fd, size, signal, requestId: randomUUID(), resolve, abort: () => stop('CANCELLED') };
          pending = call; signal.addEventListener('abort', call.abort, { once: true });
          if (!started) { started = true; emit({ type: 'worker-start', fd, threadId }); }
          if (signal.aborted) { stop('CANCELLED'); return; }
          if (ready) send(call); else call.startTimer = setTimeout(() => stop('WORKER_START_TIMEOUT'), 3000);
        });
      },
      close(): Promise<void> { if (!ended) stop('CANCELLED'); return exit; },
    };
  }
  type Resident = ReturnType<typeof resident>;
  const slots: { busy: boolean; worker?: Resident }[] = Array.from({ length: 8 }, () => ({ busy: false }));
  return {
    read(input: CueSidecarReaderInput, signal?: AbortSignal): Promise<CueSidecarReadResult> {
      if (fatal) return Promise.resolve(failure('LEASE_RELEASE_FAILED'));
      if (closed) return Promise.resolve(failure('CLOSED'));
      if (signal?.aborted) return Promise.resolve(failure('CANCELLED'));
      const slot = slots.find(value => !value.busy);
      if (!slot) return Promise.resolve(failure('QUEUE_FULL'));
      slot.busy = true;
      const controller = new AbortController(), forward = (): void => controller.abort(signal?.reason);
      signal?.addEventListener('abort', forward, { once: true });
      const promise = (async (): Promise<CueSidecarReadResult> => {
        try {
          return await withCheckedReadonlyMetadataSource(input.root, input.relative, input.expectedSignature, controller.signal,
            (handle, size) => {
              if (size < 1 || size > 65_536) return Promise.resolve(failure('BUDGET_EXCEEDED'));
              if (!slot.worker || slot.worker.ended) {
                try { slot.worker = resident(); } catch { return Promise.resolve(failure('WORKER_FAILED')); }
              }
              return slot.worker.read(handle.fd, size, controller.signal);
            }, input.assertCurrent, emit);
        } catch (error) {
          if (error instanceof MetadataLeaseReleaseError) {
            fatal = true; for (const other of active.keys()) if (other !== controller) other.abort();
            return failure('LEASE_RELEASE_FAILED');
          }
          return failure(error instanceof SourceFileError ? error.code : controller.signal.aborted ? 'CANCELLED' : 'IO_ERROR');
        } finally {
          // 已settled后才到来的取消也在返回Core quiet前回收该Worker；旧FD已不在Worker中。
          if (controller.signal.aborted && slot.worker) await slot.worker.close();
          signal?.removeEventListener('abort', forward); active.delete(controller); slot.busy = false;
        }
      })();
      active.set(controller, promise); return promise;
    },
    close(): Promise<void> {
      if (!closePromise) {
        closed = true;
        const pending = [...active.entries()]; for (const [controller] of pending) controller.abort();
        closePromise = (async () => {
          await Promise.allSettled(pending.map(([, promise]) => promise));
          await Promise.all(slots.map(slot => slot.worker?.close()));
          if (fatal) throw new MetadataLeaseReleaseError();
        })();
      }
      return closePromise;
    },
  };
}
