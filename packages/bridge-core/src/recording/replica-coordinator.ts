import * as dto from '@music-bridge/contracts';
import { mediaFingerprint } from './media-store.js';
import { RecordingReplicaError, replicaFail } from './replica-error.js';
import type { ReplicaInput, ReplicaVerifiedInput } from './replica-input.js';

export interface RecordingReplicaDriver {
  completion: Promise<dto.ReplicaProgress & { pcmSha256: string }>;
  stop(): Promise<void>;
  /** resolve须证明所有使用输入FD的工作已静止；拒绝不视为静止。 */
  close(): Promise<void>;
}
export interface RecordingReplicaDriverRequest {
  runId: string; input: ReplicaVerifiedInput;
  onProgress(event: { runId: string; target: dto.ReplicaTarget; side: dto.RenderSide; progress: dto.ReplicaProgress }): void;
}
/** 仅私有测试构造器可注入；start拒绝前必须自行收口未交出的资源。 */
export interface RecordingReplicaProvider {
  evidence: 'synthetic-only';
  start(request: RecordingReplicaDriverRequest): Promise<RecordingReplicaDriver>;
}
interface Options {
  input: ReplicaInput; provider?: RecordingReplicaProvider;
  assertCurrent?: () => void; assertAttemptIdle?: () => void;
  maxRunIds?: number; maxReadIds?: number; operationTimeoutMs?: number; closeTimeoutMs?: number;
}
type Session = Extract<dto.RecordingReplicaRun, { kind: 'session' }>;
interface Run {
  snapshot: dto.RecordingReplicaRun; fingerprint?: string; controller: AbortController; promise?: Promise<void>;
  handle?: RecordingReplicaDriver; stopping?: boolean; closing?: boolean; quiescent: Promise<void>; release(): void;
}
interface Read { fingerprint?: string; controller: AbortController; promise?: Promise<dto.RecordingReplicaInspection>; settled?: boolean }
const safety = { deviceOpened: false, formalReady: false, gateB: 'NOT_RUN' } as const;
const emptyProgress = (): dto.ReplicaProgress => ({ sourceFramesRead: 0, submittedFrames: 0, consumedFrames: 0, sourceEof: false, backendDrained: false });
const terminal = (value: dto.RecordingReplicaRun) => value.kind === 'cancelled-before-start' || ['finished', 'cancelled', 'failed'].includes(value.state);
function progressValid(value: dto.ReplicaProgress, total: number, previous: dto.ReplicaProgress): boolean {
  if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'backendDrained,consumedFrames,sourceEof,sourceFramesRead,submittedFrames') return false;
  const numbers = [value.sourceFramesRead, value.submittedFrames, value.consumedFrames];
  return numbers.every(n => Number.isSafeInteger(n) && n >= 0 && n <= total)
    && value.consumedFrames <= value.submittedFrames && value.submittedFrames <= value.sourceFramesRead
    && typeof value.sourceEof === 'boolean' && typeof value.backendDrained === 'boolean'
    && (!value.sourceEof || value.sourceFramesRead === total)
    && (!value.backendDrained || value.sourceEof && value.submittedFrames === total && value.consumedFrames === total)
    && value.sourceFramesRead >= previous.sourceFramesRead && value.submittedFrames >= previous.submittedFrames && value.consumedFrames >= previous.consumedFrames
    && (!previous.sourceEof || value.sourceEof) && (!previous.backendDrained || value.backendDrained);
}
function reason(error: unknown): dto.ReplicaRunReason {
  const code = error instanceof RecordingReplicaError ? error.code : 'PROVIDER_FAILED';
  if (code === 'AUDIO_CHANGED' || code === 'ARCHIVE_CHANGED') return 'INPUT_CHANGED';
  if (['ARCHIVE_UNAVAILABLE', 'RESTORE_UNAVAILABLE', 'AUDIO_UNAVAILABLE', 'DEPENDENCY_UNAVAILABLE', 'NOT_FOUND'].includes(code)) return 'INPUT_UNAVAILABLE';
  if (['INVALID_REQUEST', 'RUN_CONFLICT', 'RUN_LIMIT', 'READ_CONFLICT', 'READ_LIMIT'].includes(code)) return 'INPUT_INVALID';
  return code as dto.ReplicaRunReason;
}
function limit(value: number, maximum: number): boolean { return Number.isSafeInteger(value) && value >= 1 && value <= maximum; }

export function createRecordingReplicaCoordinator({ input, provider, assertCurrent = () => {}, assertAttemptIdle = () => {}, maxRunIds = 1000, maxReadIds = 1000, operationTimeoutMs = 15 * 60_000, closeTimeoutMs = 5_000 }: Options) {
  if (!limit(maxRunIds, 1000) || !limit(maxReadIds, 1000) || !limit(operationTimeoutMs, 15 * 60_000) || !limit(closeTimeoutMs, 5_000) || provider && provider.evidence !== 'synthetic-only') return replicaFail('INVALID_REQUEST');
  let closed = false, active: Run | undefined, closing: Promise<void> | undefined;
  const runs = new Map<string, Run>(), reads = new Map<string, Read>();
  function open(): void { if (closed) return replicaFail('CLOSED'); try { assertCurrent(); } catch { return replicaFail('SCOPE_CHANGED'); } }
  function snapshot(run: Run): dto.RecordingReplicaRun { if (!dto.isRecordingReplicaRun(run.snapshot)) return replicaFail('INPUT_INVALID'); return structuredClone(run.snapshot); }
  function update(run: Run, patch: Partial<Session>): void {
    const old = run.snapshot; if (old.kind !== 'session') return;
    run.snapshot = { ...old, ...patch, revision: old.revision + 1, updatedAt: new Date().toISOString() };
  }
  function checked(run: Run): void { run.controller.signal.throwIfAborted(); open(); }
  function latch(run: Run, error: unknown): void {
    if (terminal(run.snapshot)) return;
    const current = run.snapshot as Session, first = current.reason ?? reason(error);
    if (!current.reason) update(run, { state: 'stopping', stopRequested: true, reason: first });
    if (!run.controller.signal.aborted) run.controller.abort(new RecordingReplicaError(first));
  }
  function bounded<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new RecordingReplicaError('TIMEOUT')), closeTimeoutMs); })]).finally(() => clearTimeout(timer));
  }
  function cleanup(run: Run, stop: boolean): void {
    if (!run.handle || run.closing) return;
    run.closing = true;
    const timer = setTimeout(() => latch(run, new RecordingReplicaError('TIMEOUT')), closeTimeoutMs);
    void (async () => {
      if (stop && !run.stopping) {
        run.stopping = true;
        try { await bounded(Promise.resolve().then(() => run.handle!.stop())); } catch { /* 停止应答失败仍须执行真正关闭屏障。 */ }
      }
      try { await run.handle!.close(); run.release(); }
      catch (error) { run.closing = false; latch(run, error); /* 未证明静止，保留FD；显式stop可再次请求关闭。 */ }
      finally { clearTimeout(timer); }
    })();
  }
  async function consume(run: Run, value: ReplicaVerifiedInput): Promise<void> {
    const request = (run.snapshot as Session).request;
    const { recordingId, recordingContentHash, planVersionId, planContentHash, archiveOperationId, archiveManifestHash, fingerprint } = value.inspection;
    const identity: dto.ReplicaRunIdentity = { recordingId, recordingContentHash, planVersionId, planContentHash, archiveOperationId, archiveManifestHash, fingerprint, target: request.target, side: request.side, audio: structuredClone(value.audio) };
    if (recordingId !== request.recordingId || fingerprint !== request.expectedFingerprint || value.audio.target !== request.target) return replicaFail('IDENTITY_MISMATCH');
    update(run, { identity, progress: emptyProgress() });
    const abort = () => { latch(run, value.signal.reason ?? new RecordingReplicaError('CANCELLED')); cleanup(run, true); };
    value.signal.addEventListener('abort', abort, { once: true });
    const deadline = performance.now() + operationTimeoutMs;
    const check = () => { value.checkOperation(); checked(run); if (performance.now() > deadline) return replicaFail('TIMEOUT'); };
    const timer = setTimeout(() => { latch(run, new RecordingReplicaError('TIMEOUT')); cleanup(run, true); }, operationTimeoutMs);
    let abortListener: (() => void) | undefined;
    let pendingProgress: dto.ReplicaProgress | undefined;
    try {
      check();
      run.handle = await provider!.start({ runId: request.runId, input: value, onProgress(event) {
        if (active !== run || terminal(run.snapshot) || (run.snapshot as Session).reason || event?.runId !== request.runId) return;
        const previous = pendingProgress ?? (run.snapshot as Session).progress ?? emptyProgress();
        if (event.target !== request.target || event.side !== request.side || !progressValid(event.progress, value.audio.frameCount, previous)) { latch(run, new RecordingReplicaError('FRAME_MISMATCH')); cleanup(run, true); return; }
        if (!run.handle) pendingProgress = structuredClone(event.progress);
        else update(run, { progress: structuredClone(event.progress) });
      } });
      // 取消可能先于句柄交还；即便不再等待消费成功，也必须观察迟到拒绝。
      void run.handle.completion.catch(() => undefined);
      // 句柄可能在取消/close之后才交还；仍记录实际启动事实并等待它静止。
      update(run, { started: true, startedAt: new Date().toISOString(), evidence: 'synthetic-only', ...(pendingProgress ? { progress: pendingProgress } : {}), ...((run.snapshot as Session).reason ? {} : { state: 'consuming' as const }) });
      pendingProgress = undefined;
      if (value.signal.aborted || run.controller.signal.aborted) { abort(); throw run.controller.signal.reason; }
      const aborted = new Promise<never>((_, reject) => {
        abortListener = () => reject(value.signal.reason ?? run.controller.signal.reason ?? new RecordingReplicaError('CANCELLED'));
        value.signal.addEventListener('abort', abortListener, { once: true });
      });
      const result = await Promise.race([run.handle.completion, aborted]); check();
      const { pcmSha256, ...progress } = result;
      if (pcmSha256 !== value.audio.pcmSha256 || !progressValid(progress, value.audio.frameCount, (run.snapshot as Session).progress!) || !progress.backendDrained) return replicaFail('FRAME_MISMATCH');
      update(run, { state: 'draining', progress });
    } catch (error) { latch(run, error); }
    finally {
      clearTimeout(timer); if (abortListener) value.signal.removeEventListener('abort', abortListener);
      if (run.handle) { cleanup(run, !!(run.snapshot as Session).reason); await run.quiescent; }
      value.signal.removeEventListener('abort', abort);
    }
    checked(run);
  }
  async function execute(run: Run): Promise<void> {
    try {
      checked(run); const { recordingId, target, side, expectedFingerprint } = (run.snapshot as Session).request;
      await input.withInput({ recordingId, target, side, expectedFingerprint }, run.controller.signal, () => checked(run), value => consume(run, value));
      checked(run); update(run, { state: 'finished', cleanupQuiescent: true, endedAt: new Date().toISOString() });
    } catch (error) {
      latch(run, error); const current = run.snapshot as Session;
      update(run, { state: current.reason === 'CANCELLED' ? 'cancelled' : 'failed', cleanupQuiescent: true, endedAt: new Date().toISOString() });
    } finally { if (active === run) active = undefined; }
  }
  return {
    status(): dto.RecordingReplicaStatus { open(); return { playback: 'blocked', reason: 'BACKEND_UNAVAILABLE', deviceAccess: 'not-authorized', ...safety }; },
    assertExecutionIdle(): void { open(); if (active) return replicaFail('RUN_CONFLICT'); },
    inspect(value: dto.InspectRecordingReplicaRequest): Promise<dto.RecordingReplicaInspection> {
      try { open(); if (!dto.isInspectRecordingReplicaRequest(value)) return Promise.reject(new RecordingReplicaError('INVALID_REQUEST')); }
      catch (error) { return Promise.reject(error); }
      const request = structuredClone(value), fingerprint = mediaFingerprint(request), prior = reads.get(request.readId);
      if (prior) return !prior.fingerprint ? Promise.reject(new RecordingReplicaError('CANCELLED')) : prior.fingerprint !== fingerprint ? Promise.reject(new RecordingReplicaError('READ_CONFLICT')) : prior.promise!.then(result => structuredClone(result));
      if (reads.size >= maxReadIds) return Promise.reject(new RecordingReplicaError('READ_LIMIT'));
      if ([...reads.values()].filter(read => read.promise && !read.settled).length >= 2) return Promise.reject(new RecordingReplicaError('READ_CONFLICT'));
      const read: Read = { fingerprint, controller: new AbortController() }; reads.set(request.readId, read);
      const deadline = performance.now() + 15 * 60_000;
      const check = () => { read.controller.signal.throwIfAborted(); open(); if (performance.now() > deadline) return replicaFail('TIMEOUT'); };
      const timer = setTimeout(() => read.controller.abort(new RecordingReplicaError('TIMEOUT')), 15 * 60_000);
      read.promise = Promise.resolve().then(async () => {
        check(); const result = await input.inspect(request, read.controller.signal, check); check();
        if (!dto.isRecordingReplicaInspection(result) || result.readId !== request.readId || result.recordingId !== request.recordingId) return replicaFail('INPUT_INVALID');
        return structuredClone(result);
      }).catch(error => { if (error instanceof RecordingReplicaError) throw error; return replicaFail('INPUT_UNAVAILABLE'); }).finally(() => { clearTimeout(timer); read.settled = true; });
      return read.promise.then(result => structuredClone(result));
    },
    cancelRead(request: dto.RecordingReplicaReadIdRequest): dto.RecordingReplicaReadCancellation {
      open(); if (!dto.isRecordingReplicaReadIdRequest(request)) return replicaFail('INVALID_REQUEST');
      let read = reads.get(request.readId);
      if (!read) { if (reads.size >= maxReadIds) return replicaFail('READ_LIMIT'); read = { controller: new AbortController() }; reads.set(request.readId, read); }
      if (!read.controller.signal.aborted) read.controller.abort(new RecordingReplicaError('CANCELLED'));
      return { readId: request.readId, cancelRequested: true };
    },
    start(value: dto.StartRecordingReplicaRequest): dto.RecordingReplicaRun {
      open(); if (!dto.isStartRecordingReplicaRequest(value)) return replicaFail('INVALID_REQUEST');
      const request = structuredClone(value), fingerprint = mediaFingerprint(request), prior = runs.get(request.runId);
      if (prior) { if (prior.fingerprint && prior.fingerprint !== fingerprint) return replicaFail('RUN_CONFLICT'); return snapshot(prior); }
      if (!provider) return replicaFail('BACKEND_UNAVAILABLE');
      if (runs.size >= maxRunIds) return replicaFail('RUN_LIMIT');
      if (active) return replicaFail('RUN_CONFLICT');
      try { assertAttemptIdle(); } catch { return replicaFail('RUN_CONFLICT'); }
      const at = new Date().toISOString(); let release!: () => void;
      const run: Run = { fingerprint, controller: new AbortController(), quiescent: new Promise<void>(resolve => { release = resolve; }), release: () => release(), snapshot: { kind: 'session', runId: request.runId, request, revision: 1, createdAt: at, updatedAt: at, state: 'starting', identity: null, progress: null, started: false, stopRequested: false, cleanupQuiescent: false, evidence: 'none', ...safety } };
      runs.set(request.runId, run); active = run; run.promise = Promise.resolve().then(() => execute(run));
      return snapshot(run);
    },
    get(request: dto.RecordingReplicaRunIdRequest): { run: dto.RecordingReplicaRun | null } {
      open(); if (!dto.isRecordingReplicaRunIdRequest(request)) return replicaFail('INVALID_REQUEST'); const run = runs.get(request.runId); return { run: run ? snapshot(run) : null };
    },
    stop(request: dto.RecordingReplicaRunIdRequest): dto.RecordingReplicaRun {
      open(); if (!dto.isRecordingReplicaRunIdRequest(request)) return replicaFail('INVALID_REQUEST'); let run = runs.get(request.runId);
      if (!run) {
        if (runs.size >= maxRunIds) return replicaFail('RUN_LIMIT');
        run = { controller: new AbortController(), quiescent: Promise.resolve(), release() {}, snapshot: { kind: 'cancelled-before-start', runId: request.runId, state: 'cancelled', started: false, stopRequested: true, cleanupQuiescent: true, evidence: 'none', ...safety } }; runs.set(request.runId, run);
      } else { latch(run, new RecordingReplicaError('CANCELLED')); if (!terminal(run.snapshot)) cleanup(run, true); }
      return snapshot(run);
    },
    close(): Promise<void> {
      if (closing) return closing; closed = true;
      for (const read of reads.values()) if (!read.controller.signal.aborted) read.controller.abort(new RecordingReplicaError('CLOSED'));
      if (active) { latch(active, new RecordingReplicaError('CLOSED')); cleanup(active, true); }
      closing = bounded(Promise.allSettled([...reads.values()].flatMap(read => read.promise ? [read.promise] : []),).then(async () => { await active?.promise; }));
      return closing;
    },
  };
}
export type RecordingReplicaCoordinator = ReturnType<typeof createRecordingReplicaCoordinator>;
