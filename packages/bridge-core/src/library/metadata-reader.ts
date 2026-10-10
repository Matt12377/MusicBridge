import { Worker } from 'node:worker_threads';
import { SourceFileError, MetadataLeaseReleaseError, withCheckedReadonlyMetadataSource } from '../recording/source-files.js';
import { withRelocationMetadataRead, type RelocationReadAccess } from '../collection/source-relocation-verify.js';
import { DEFAULT_METADATA_READ_BUDGET, type MetadataReaderPort, type MetadataReaderOptions, type MetadataReaderLifecycle,
  type MetadataReadInput, type MetadataReadResult, type MetadataReadFailure, type MetadataReadBudget, type MetadataWorkerInput,
  type MetadataWorkerResultMessage, type MetadataWorkerPhase, type MetadataReaderTimeoutLifecycle } from './metadata-reader-types.js';

const failure = (code: MetadataReadFailure): MetadataReadResult => ({ status: 'failure', code, readEvidence: null });
type RelocationReader = (input: MetadataReadInput, access: RelocationReadAccess, signal?: AbortSignal) => Promise<MetadataReadResult>;
interface RelocationRead { access: RelocationReadAccess }
const relocationReaders = new WeakMap<MetadataReaderPort, RelocationReader>();
/** 本域可信读取只进入真实原Reader；公开read/close与input不增加绕过字段。 */
export function readRelocationMetadata(reader: MetadataReaderPort, input: MetadataReadInput, access: RelocationReadAccess,
  signal?: AbortSignal): Promise<MetadataReadResult> {
  const read = relocationReaders.get(reader);
  return read ? read(input, access, signal) : Promise.resolve(failure('ADMISSION_FAILED'));
}
const sourceCodes = new Set(['REVOKED','SOURCE_ROOT_OFFLINE','OUTSIDE_ROOT','MISSING','CONTENT_CHANGED','IO_ERROR']);
function classify(error: unknown): MetadataReadFailure {
  if (error instanceof MetadataLeaseReleaseError) return 'LEASE_RELEASE_FAILED';
  if (error instanceof SourceFileError) {
    if (sourceCodes.has(error.code)) return error.code as MetadataReadFailure;
    if (error.code === 'CANCELLED') return 'CANCELLED';
    if (error.code === 'LIMIT_EXCEEDED') return 'BUDGET_EXCEEDED';
  }
  return 'IO_ERROR';
}
interface PendingRead { controller: AbortController; started: boolean; run(): Promise<void>; cancelQueued(): void; promise: Promise<MetadataReadResult> }
const workerPhases = new Set(['dependency-load', 'container-check', 'parser-load', 'parse', 'output-check', 'complete']);
const workerFailureCodes = new Set<MetadataReadFailure>(['REVOKED','SOURCE_ROOT_OFFLINE','OUTSIDE_ROOT','MISSING','CONTENT_CHANGED','IO_ERROR',
  'BUDGET_EXCEEDED','PARSE_FAILED','UNSUPPORTED','TIMEOUT','WORKER_START_TIMEOUT','CANCELLED','CLOSED','QUEUE_FULL','WORKER_FAILED','LEASE_RELEASE_FAILED','ADMISSION_FAILED']);
function isWorkerMessage(value: unknown): value is MetadataWorkerResultMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  if (Object.keys(message).length !== 3 || message.kind !== 'metadata-result' || typeof message.phase !== 'string' || !workerPhases.has(message.phase)) return false;
  if (typeof message.result !== 'object' || message.result === null || Array.isArray(message.result)) return false;
  const result = message.result as Record<string, unknown>;
  if (result.status === 'failure') return typeof result.code === 'string' && workerFailureCodes.has(result.code as MetadataReadFailure)
    && (result.readEvidence === null || typeof result.readEvidence === 'object' && !Array.isArray(result.readEvidence));
  return result.status === 'ok' && message.phase === 'complete' && result.parserVersion === 'music-metadata-11.15.0/mbrs003-v3'
    && typeof result.fields === 'object' && result.fields !== null && typeof result.technical === 'object' && result.technical !== null
    && Array.isArray(result.coverEvidence) && typeof result.readEvidence === 'object' && result.readEvidence !== null;
}
/** 只支持当前Node编译产物URL；测试也通过真实编译worker，不接受用户worker入口。 */
export function createMetadataReader(options: MetadataReaderOptions = {}): MetadataReaderPort {
  const concurrency = options.concurrency ?? 1, maxPending = options.maxPending ?? 16;
  if (![1,2].includes(concurrency) || !Number.isSafeInteger(maxPending) || maxPending < 0 || maxPending > 64) throw new Error('元数据reader池预算无效。');
  const budget: MetadataReadBudget = { ...DEFAULT_METADATA_READ_BUDGET, ...options.trustedBudget };
  for (const key of Object.keys(DEFAULT_METADATA_READ_BUDGET) as (keyof MetadataReadBudget)[]) {
    if (!Number.isSafeInteger(budget[key]) || budget[key] < 1 || budget[key] > DEFAULT_METADATA_READ_BUDGET[key]) throw new Error('元数据reader仅允许可信低预算。');
  }
  if (options.trustedBudget && Object.keys(options.trustedBudget).some(k => !Object.hasOwn(DEFAULT_METADATA_READ_BUDGET,k))) throw new Error('元数据reader预算包含未知字段。');
  const emit = (event: MetadataReaderLifecycle): void => { try { options.onLifecycle?.(event); } catch { /* 诊断观察者不能阻止真实关闭。 */ } };
  const queue: PendingRead[] = [], jobs = new Set<PendingRead>(); let active = 0, closed = false, closePromise: Promise<void> | undefined;
  let fatalLeaseFailure = false;
  const pump = (): void => {
    if (fatalLeaseFailure) {
      for (const job of [...queue]) { job.controller.abort(); job.cancelQueued(); }
      return;
    }
    while (active < concurrency && queue.length) {
      const job = queue.shift()!; if (!jobs.has(job)) continue;
      job.started = true; ++active;
      void job.run().finally(() => { --active; pump(); });
    }
  };
  const runWorker = (input: MetadataWorkerInput, signal: AbortSignal): Promise<MetadataReadResult> => new Promise(resolve => {
    const startupStarted = performance.now(), startupDeadline = startupStarted + 3000;
    let worker: Worker;
    try { worker = new Worker(new URL('./metadata-reader-worker.bundle.mjs', import.meta.url), { workerData: input, execArgv: [], env: {}, resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } }); }
    catch { resolve(failure('WORKER_FAILED')); return; }
    const threadId = worker.threadId, fd = input.fd; let result: MetadataReadResult | undefined, forced: MetadataReadFailure | undefined;
    let startTimer: ReturnType<typeof setTimeout> | undefined, readTimer: ReturnType<typeof setTimeout> | undefined;
    let readStarted: number | undefined, readDeadline: number | undefined;
    let onlineObserved = false, resultMessageObserved = false, workerReportedTimeout = false, exited = false;
    let resultPhase: MetadataWorkerPhase | undefined;
    let timeoutInfo: Pick<MetadataReaderTimeoutLifecycle, 'origin' | 'phase' | 'elapsedMs' | 'lateByMs'> | undefined;
    const stop = (code: MetadataReadFailure, now = performance.now()): void => {
      if (forced !== undefined) return;
      forced = code;
      if (code === 'WORKER_START_TIMEOUT' || code === 'TIMEOUT') {
        const startup = code === 'WORKER_START_TIMEOUT', started = startup ? startupStarted : readStarted!, deadline = startup ? startupDeadline : readDeadline!;
        timeoutInfo = { origin: startup ? 'parent-start' : 'parent-read', phase: startup ? 'startup' : result ? 'exit-wait' : 'awaiting-result',
          elapsedMs: Math.max(0, now - started), lateByMs: Math.max(0, now - deadline) };
      }
      // terminate的请求本身不是关闭；只有下面exit事件可完成这次读取。
      if (!exited) void worker.terminate().catch(() => { forced ??= 'WORKER_FAILED'; });
    };
    const enforceStartupDeadline = (now = performance.now()): void => { if (now >= startupDeadline) stop('WORKER_START_TIMEOUT', now); };
    const enforceReadDeadline = (now = performance.now()): void => { if (readDeadline !== undefined && now >= readDeadline) stop('TIMEOUT', now); };
    const startupTimer = (): void => {
      if (forced !== undefined || exited || onlineObserved) return;
      enforceStartupDeadline();
      if (forced === undefined) startTimer = setTimeout(startupTimer, Math.max(1, Math.ceil(startupDeadline - performance.now())));
    };
    const readingTimer = (): void => {
      if (forced !== undefined || exited || readDeadline === undefined) return;
      enforceReadDeadline();
      if (forced === undefined) readTimer = setTimeout(readingTimer, Math.max(1, Math.ceil(readDeadline - performance.now())));
    };
    const abort = (): void => stop('CANCELLED'); signal.addEventListener('abort',abort,{ once: true });
    worker.once('online', () => {
      const now = performance.now(); onlineObserved = true; clearTimeout(startTimer); enforceStartupDeadline(now);
      if (forced === undefined) { readStarted = now; readDeadline = now + budget.timeoutMs; readingTimer(); }
      emit({ type: 'worker-online', fd, threadId });
      if (signal.aborted) abort();
      // 同步观察者无法被timer抢占；返回后仍核同一个期限，不重新起预算。
      enforceReadDeadline();
    });
    worker.on('message', (value: unknown) => {
      resultMessageObserved = true;
      if (result !== undefined || !isWorkerMessage(value)) { stop('WORKER_FAILED'); return; }
      enforceReadDeadline();
      result = value.result; resultPhase = value.phase;
      workerReportedTimeout = result.status === 'failure' && result.code === 'TIMEOUT';
    });
    worker.once('error', () => { forced ??= 'WORKER_FAILED'; });
    worker.once('exit', exitCode => {
      const now = performance.now(); exited = true;
      clearTimeout(startTimer); clearTimeout(readTimer); signal.removeEventListener('abort',abort);
      if (onlineObserved) enforceReadDeadline(now); else enforceStartupDeadline(now);
      if (forced === undefined && workerReportedTimeout) {
        const elapsed = result?.readEvidence?.elapsedMs;
        const elapsedMs = typeof elapsed === 'number' && Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
        timeoutInfo = { origin: 'worker-check', phase: resultPhase!, elapsedMs, lateByMs: elapsedMs === null ? null : Math.max(0, elapsedMs - budget.timeoutMs) };
      }
      // 只在真实exit时发布一次有限诊断；没有结果时不猜Worker内部阶段。
      if (timeoutInfo) emit({ type: 'worker-timeout', fd, threadId, ...timeoutInfo, onlineObserved, resultMessageObserved, workerReportedTimeout });
      emit({ type: 'worker-exit', fd, threadId, exitCode });
      resolve(forced ? failure(forced) : exitCode === 0 && result ? result : failure('WORKER_FAILED'));
    });
    startupTimer();
    emit({ type: 'worker-start', fd, threadId }); if (signal.aborted) abort(); enforceStartupDeadline();
  });
  const execute = async (input: MetadataReadInput, signal: AbortSignal, relocation?: RelocationRead): Promise<MetadataReadResult> => {
    let release: (() => void | Promise<void>) | undefined;
    try {
      if (signal.aborted) return failure('CANCELLED');
      if (options.readAdmission) {
        try { release = await options.readAdmission.acquire(signal); }
        catch { return failure(signal.aborted ? 'CANCELLED' : 'ADMISSION_FAILED'); }
      }
      if (signal.aborted) return failure('CANCELLED');
      if (relocation) return await withRelocationMetadataRead(relocation.access, input, signal,
        (handle, size) => runWorker({ fd: handle.fd, size, budget, dsdMetadataEnabled: options.dsdMetadataEnabled === true }, signal), event => emit(event));
      return await withCheckedReadonlyMetadataSource(input.root, input.relative, input.expectedSignature, signal,
        (handle, size) => runWorker({ fd: handle.fd, size, budget, dsdMetadataEnabled: options.dsdMetadataEnabled === true },signal), input.assertCurrent,
        event => emit(event));
    } catch (error) {
      if (error instanceof MetadataLeaseReleaseError) { fatalLeaseFailure = true; return failure('LEASE_RELEASE_FAILED'); }
      return failure(signal.aborted ? 'CANCELLED' : classify(error));
    }
    finally { if (release) await release(); }
  };
  const enqueue = (input: MetadataReadInput, signal?: AbortSignal, relocation?: RelocationRead): Promise<MetadataReadResult> => {
      if (fatalLeaseFailure) return Promise.resolve(failure('LEASE_RELEASE_FAILED'));
      if (closed) return Promise.resolve(failure('CLOSED'));
      if (signal?.aborted) return Promise.resolve(failure('CANCELLED'));
      if (active >= concurrency && queue.length >= maxPending) return Promise.resolve(failure('QUEUE_FULL'));
      const controller = new AbortController(); let settle!: (value: MetadataReadResult) => void;
      const promise = new Promise<MetadataReadResult>(resolve => { settle = resolve; });
      const complete = (value: MetadataReadResult): void => { signal?.removeEventListener('abort', forward); jobs.delete(job); emit({ type: 'read-complete', status: value.status }); settle(value); };
      const forward = (): void => { controller.abort(); if (!job.started) job.cancelQueued(); };
      const job: PendingRead = { controller, started: false, promise,
        async run() { let value: MetadataReadResult; try { value = await execute(input,controller.signal,relocation); } catch { value = failure(fatalLeaseFailure ? 'LEASE_RELEASE_FAILED' : 'IO_ERROR'); } complete(value); },
        cancelQueued() { const index = queue.indexOf(job); if (index >= 0) queue.splice(index,1); if (jobs.has(job)) complete(failure(fatalLeaseFailure ? 'LEASE_RELEASE_FAILED' : 'CANCELLED')); },
      };
      signal?.addEventListener('abort',forward,{ once: true }); jobs.add(job); queue.push(job); pump(); return promise;
  };
  const port: MetadataReaderPort = {
    read(input, signal) { return enqueue(input, signal); },
    close() {
      if (!closePromise) {
        closed = true; const pending = [...jobs];
        for (const job of pending) { job.controller.abort(); if (!job.started) job.cancelQueued(); }
        closePromise = Promise.all(pending.map(job => job.promise)).then(() => {
          if (fatalLeaseFailure) throw new MetadataLeaseReleaseError();
        });
      }
      return closePromise;
    },
  };
  relocationReaders.set(port, (input, access, signal) => enqueue(input, signal, { access }));
  return port;
}
