import { randomUUID } from 'node:crypto';
import * as dto from '@music-bridge/contracts';
import { DeviceOutputRunError, type DeviceOutputRunCallbacks } from './device-output-runner.js';
import type { ReplicaDeviceOutputProvider } from './replica-device-output-provider.js';
import type { ReplicaInput, ReplicaVerifiedInput } from './replica-input.js';
import { RecordingReplicaError, replicaFail } from './replica-error.js';

type Session = Extract<dto.RecordingReplicaRun, { kind: 'device-session' }>;
type Segment = Awaited<ReturnType<ReplicaDeviceOutputProvider['start']>>;
interface Command { fingerprint: string; result: Session }
interface Run {
  snapshot: Session; controller: AbortController; promise?: Promise<void>; segment?: Segment | undefined;
  desired?: 'pause' | 'stop' | undefined; wake?: (() => void) | undefined; commands: Map<string, Command>;
  nativeCompleted?: boolean; nativePending?: boolean;
}
type SegmentOutcome = { kind: 'paused'; cursorFrame: number } | { kind: 'completed'; segment: Segment;
  progress: dto.ReplicaProgress; segmentId: string; fromFrame: number; sourceFrameCount: number; archiveManifestHash: string };
interface Options {
  input: ReplicaInput; provider: ReplicaDeviceOutputProvider;
  currentSelection(): dto.RecordingOutputSelection | null;
  assertCurrent?: () => void; assertAttemptIdle?: () => void;
  outputRecoveryReady?: () => boolean;
  maxRunIds?: number; closeTimeoutMs?: number;
}
const now = (): string => new Date().toISOString();
const sameSelection = (a: dto.RecordingOutputSelection, b: dto.RecordingOutputSelection): boolean =>
  a.endpointId === b.endpointId && a.selectionGeneration === b.selectionGeneration;
const emptyProgress = (): dto.ReplicaProgress => ({ sourceFramesRead: 0, submittedFrames: 0, consumedFrames: 0,
  sourceEof: false, backendDrained: false });
const cancelledBeforeStart = (runId: string): Extract<dto.RecordingReplicaRun, { kind: 'cancelled-before-start' }> =>
  ({ kind: 'cancelled-before-start', runId, state: 'cancelled', started: false, stopRequested: true,
    cleanupQuiescent: true, evidence: 'none', deviceOpened: false, formalReady: false, gateB: 'NOT_RUN' });
const terminal = (state: Session['state']): boolean => state === 'finished' || state === 'cancelled' || state === 'failed';
function failure(error: unknown): dto.ReplicaRunReason {
  if (error instanceof RecordingReplicaError) {
    if (error.code === 'AUDIO_CHANGED' || error.code === 'ARCHIVE_CHANGED') return 'INPUT_CHANGED';
    if (error.code === 'ARCHIVE_UNAVAILABLE' || error.code === 'RESTORE_UNAVAILABLE'
      || error.code === 'AUDIO_UNAVAILABLE' || error.code === 'DEPENDENCY_UNAVAILABLE') return 'INPUT_UNAVAILABLE';
    if (error.code === 'CANCELLED' || error.code === 'CLOSED' || error.code === 'SCOPE_CHANGED'
      || error.code === 'INPUT_CHANGED' || error.code === 'AUTHORIZATION_REVOKED'
      || error.code === 'UNSUPPORTED_FORMAT' || error.code === 'BACKEND_UNAVAILABLE'
      || error.code === 'DEVICE_CHANGED' || error.code === 'HELPER_CHANGED' || error.code === 'TIMEOUT'
      || error.code === 'PROTOCOL_ERROR' || error.code === 'FRAME_MISMATCH'
      || error.code === 'IDENTITY_MISMATCH') return error.code;
  }
  if (error instanceof DeviceOutputRunError) {
    return error.code === 'CANCELLED' ? 'CANCELLED' : error.code === 'ROUTE_CHANGED' ? 'ROUTE_CHANGED'
      : error.code === 'INPUT_CHANGED' ? 'INPUT_CHANGED' : error.code === 'TIMEOUT' ? 'TIMEOUT'
        : error.code === 'PROTOCOL' ? 'PROTOCOL_ERROR' : 'BACKEND_UNAVAILABLE';
  }
  return 'PROVIDER_FAILED';
}

/** 普通历史试听的单逻辑run控制；每次resume/seek后创建全新native segment，绝不产生Formal Record。 */
export function createReplicaDeviceSessionCoordinator({ input, provider, currentSelection,
  assertCurrent = () => {}, assertAttemptIdle = () => {}, outputRecoveryReady = () => true,
  maxRunIds = 1000, closeTimeoutMs = 5_000 }: Options) {
  if (!Number.isSafeInteger(maxRunIds) || maxRunIds < 1 || maxRunIds > 1000
    || !Number.isSafeInteger(closeTimeoutMs) || closeTimeoutMs < 1 || closeTimeoutMs > 5_000) return replicaFail('INVALID_REQUEST');
  const runs = new Map<string, Run>();
  const tombstones = new Set<string>();
  let active: Run | undefined, closed = false;
  const open = () => { if (closed) return replicaFail('CLOSED'); try { assertCurrent(); } catch { return replicaFail('SCOPE_CHANGED'); } };
  const snapshot = (run: Run): Session => {
    if (!dto.isRecordingReplicaRun(run.snapshot)) return replicaFail('INPUT_INVALID');
    return structuredClone(run.snapshot);
  };
  const update = (run: Run, patch: Partial<Session>): void => {
    const old = run.snapshot;
    run.snapshot = { ...old, ...patch, revision: old.revision + 1, updatedAt: now() };
  };
  const stopNative = (run: Run): void => { void run.segment?.handle.stop().catch(() => undefined); };
  const end = (run: Run, error: unknown): void => {
    if (terminal(run.snapshot.state)) return;
    if (run.desired === 'stop' && run.snapshot.state === 'stopping') { stopNative(run); return; }
    const reason = run.snapshot.reason ?? failure(error);
    run.desired = 'stop';
    update(run, { state: 'stopping', stopRequested: true, reason });
    if (!run.controller.signal.aborted) run.controller.abort(new RecordingReplicaError(reason));
    stopNative(run); run.wake?.();
  };
  const checked = (run: Run): void => { run.controller.signal.throwIfAborted(); open(); if (!outputRecoveryReady()) return replicaFail('BACKEND_UNAVAILABLE'); };
  async function paused(run: Run): Promise<void> {
    if (run.snapshot.state !== 'paused') return;
    await new Promise<void>((resolve, reject) => {
      const abort = () => { run.controller.signal.removeEventListener('abort', abort); reject(run.controller.signal.reason); };
      run.wake = () => { run.controller.signal.removeEventListener('abort', abort); resolve(); };
      run.controller.signal.addEventListener('abort', abort, { once: true });
      if (run.controller.signal.aborted) abort();
    });
    run.wake = undefined;
  }
  async function playSegment(run: Run, value: ReplicaVerifiedInput): Promise<SegmentOutcome> {
    const fromFrame = run.snapshot.segmentFromFrame, segmentId = run.snapshot.segmentId;
    if (!segmentId) return replicaFail('INPUT_INVALID');
    const remaining = value.audio.frameCount - fromFrame;
    let progress = emptyProgress(), cleanup: Parameters<DeviceOutputRunCallbacks['onCleanup']>[0] | undefined;
    let drainObserved = false;
    let resolve!: () => void, reject!: (error: unknown) => void;
    const settled = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    void settled.catch(() => undefined); // provider可能在交还句柄前同步失败，拒绝仍由下方统一观察。
    run.nativeCompleted = false;
    const publish = (patch: Partial<dto.ReplicaProgress>): void => {
      progress = { ...progress, ...patch };
      if (run.snapshot.started && !terminal(run.snapshot.state)) update(run, {
        progress: { ...progress }, cursorFrame: fromFrame + progress.consumedFrames,
        ...(!run.desired && progress.sourceEof ? { state: 'draining' as const } : {}),
      });
    };
    const callbacks: DeviceOutputRunCallbacks = {
      onProgress(event) {
        if (run.desired) return;
        if (event.suppliedFrames < progress.sourceFramesRead || event.consumedFrames < progress.consumedFrames
          || event.consumedFrames > event.suppliedFrames || event.suppliedFrames > remaining) {
          reject(new RecordingReplicaError('PROTOCOL_ERROR')); return;
        }
        publish({ sourceFramesRead: event.suppliedFrames, submittedFrames: event.suppliedFrames,
          consumedFrames: event.consumedFrames });
      },
      onSourceEof() {
        if (run.desired) return;
        if (progress.sourceFramesRead !== remaining) { reject(new RecordingReplicaError('PROTOCOL_ERROR')); return; }
        publish({ sourceEof: true });
      },
      onDrainObserved() { drainObserved = true; /* HAL候选不是完成；等待child.close、pin及输入末验。 */ },
      onCleanup(facts) { cleanup = facts; run.nativePending = false; },
      onComplete() {
        run.nativeCompleted = true;
        if (run.desired) { reject(new RecordingReplicaError('PROTOCOL_ERROR')); return; }
        resolve();
      },
      onFailure(error: DeviceOutputRunError) { reject(error); },
    };
    try {
      checked(run);
      const segment = await provider.start({ logicalRunId: run.snapshot.runId, segmentId, fromFrame,
        selection: run.snapshot.request.outputSelection, input: value, signal: run.controller.signal,
        checkOperation: () => checked(run), callbacks, onNativeAttempt: () => { run.nativePending = true; } });
      run.segment = segment;
      update(run, { started: true, deviceOpened: true,
        ...(run.snapshot.startedAt ? {} : { startedAt: now() }),
        state: run.desired === 'stop' ? 'stopping' : run.desired === 'pause' ? 'pausing'
          : progress.sourceEof ? 'draining' : 'outputting',
        progress: { ...progress },
        cursorFrame: fromFrame + progress.consumedFrames });
      if (run.desired) stopNative(run);
      let outputError: unknown;
      try { await settled; } catch (error) { outputError = error; }
      try { await segment.handle.close(); }
      catch (error) {
        // close未证明child/供帧静止；故意不让withInput回调返回，保留输入FD与执行槽。
        end(run, error);
        await new Promise<never>(() => {});
      }
      if (!cleanup?.engineCutoff || !cleanup.cleanupQuiescent) return replicaFail('PROTOCOL_ERROR');
      if (run.desired === 'pause') {
        const final = cleanup.terminal;
        if (!(outputError instanceof DeviceOutputRunError) || outputError.code !== 'CANCELLED'
          || !cleanup.stopAcknowledged || final?.kind !== 'cancelled'
          || final.consumedFrames < progress.consumedFrames || final.consumedFrames > final.suppliedFrames
          || final.suppliedFrames < progress.sourceFramesRead || final.suppliedFrames > remaining) return replicaFail('PROTOCOL_ERROR');
        // 只接收decoder.finish验证的终态游标；周期进度可能漏掉Stop前的最后消费。
        publish({ sourceFramesRead: final.suppliedFrames, submittedFrames: final.suppliedFrames,
          consumedFrames: final.consumedFrames });
        return { kind: 'paused', cursorFrame: fromFrame + final.consumedFrames };
      }
      if (run.desired === 'stop') return replicaFail('CANCELLED');
      if (outputError) throw outputError;
      if (cleanup.terminal?.kind !== 'completed' || !cleanup.stopAcknowledged || !drainObserved
        || cleanup.terminal.suppliedFrames !== remaining || cleanup.terminal.consumedFrames !== remaining
        || !progress.sourceEof || progress.submittedFrames !== remaining || progress.consumedFrames !== remaining)
        return replicaFail('FRAME_MISMATCH');
      return { kind: 'completed', segment, progress: { ...progress }, segmentId, fromFrame,
        sourceFrameCount: value.audio.frameCount, archiveManifestHash: value.inspection.archiveManifestHash };
    } finally { run.segment = undefined; }
  }
  async function execute(run: Run): Promise<void> {
    try {
      checked(run);
      const request = run.snapshot.request;
      for (;;) {
        checked(run);
        if (run.snapshot.state === 'paused') { await paused(run); continue; }
        if (!run.snapshot.segmentId) update(run, { segmentId: randomUUID(), segmentIndex: run.snapshot.segmentIndex + 1,
          segmentFromFrame: run.snapshot.cursorFrame, segmentQuiescent: false, progress: emptyProgress(),
          state: run.snapshot.started ? 'resuming' : 'starting' });
        // 一个native segment独占一个输入租期。withInput返回之前必须完成原件末Hash、归档末验和FD关闭。
        const lease: { state: 'not-acquired' | 'held' | 'released' | 'release-unverified' } = { state: 'not-acquired' };
        let outcome: SegmentOutcome;
        try {
          outcome = await input.withInput({ recordingId: request.recordingId, target: request.target, side: request.side,
            expectedFingerprint: request.expectedFingerprint }, run.controller.signal, () => checked(run), async value => {
        const { recordingId, recordingContentHash, planVersionId, planContentHash, archiveOperationId, archiveManifestHash,
          fingerprint } = value.inspection;
        if (fingerprint !== request.expectedFingerprint || recordingId !== request.recordingId
          || value.audio.target !== request.target) return replicaFail('IDENTITY_MISMATCH');
        const identity = { recordingId, recordingContentHash, planVersionId, planContentHash,
          archiveOperationId, archiveManifestHash, fingerprint, target: request.target, side: request.side,
          audio: structuredClone(value.audio) };
        if (run.snapshot.identity && JSON.stringify(run.snapshot.identity) !== JSON.stringify(identity)) return replicaFail('IDENTITY_MISMATCH');
        if (!run.snapshot.identity) update(run, { identity, progress: emptyProgress() });
            return playSegment(run, value);
          }, event => { lease.state = event === 'acquired' ? 'held' : event; });
          if (lease.state !== 'released') { lease.state = 'release-unverified'; return replicaFail('PROTOCOL_ERROR'); }
        } catch (error) {
          // 拒绝本身不证明FD或native child已停；未知租期保留执行槽和最后可信run。
          if (lease.state === 'held' || lease.state === 'release-unverified' || run.nativePending) {
            end(run, error);
            await new Promise<never>(() => {});
          }
          throw error;
        }
        checked(run); // 包括输入末验；失败绝不发布静止pause或成功回执。
        if (outcome.kind === 'paused') {
          run.desired = undefined;
          update(run, { state: 'paused', segmentId: null, segmentQuiescent: true,
            cursorFrame: outcome.cursorFrame });
          continue;
        }
        const { segment, progress, segmentId, fromFrame, sourceFrameCount, archiveManifestHash } = outcome;
        const receipt: dto.ReplicaDeviceReceipt = { runId: run.snapshot.runId, segmentId,
          playbackIdentitySha256: segment.playbackIdentitySha256, manifestSha256: archiveManifestHash,
          helperSha256: segment.helperSha256, backendId: 'musicbridge-coreaudio-hal', backendVersion: '0.2.0',
          drainAlgorithmId: segment.drainAlgorithmId, endpointId: segment.observed.endpointId,
          deviceUid: segment.observed.uid, configurationFingerprintSha256: segment.observed.configurationFingerprintSha256,
          selectionGeneration: segment.observed.selectionGeneration, sourceFrameCount, fromFrame,
          frameCount: sourceFrameCount - fromFrame, suppliedFrames: progress.submittedFrames,
          consumedFrames: progress.consumedFrames, sourceEof: true, drainObserved: true, childClosed: true,
          inputFinalVerified: true, segmentPlaybackComplete: true, formalReady: false, gateB: 'NOT_RUN' };
        update(run, { state: 'finished', progress: { ...progress, backendDrained: true }, receipt,
          cursorFrame: sourceFrameCount, evidence: 'device-output', cleanupQuiescent: true,
          segmentQuiescent: true, endedAt: now() });
        return;
      }
    } catch (error) {
      const reason = run.snapshot.reason ?? failure(error);
      update(run, { state: reason === 'CANCELLED' ? 'cancelled' : 'failed', reason, stopRequested: true,
        receipt: null, evidence: 'none', segmentQuiescent: true, cleanupQuiescent: true, endedAt: now() });
    } finally { if (active === run) active = undefined; }
  }
  return {
    status(): dto.RecordingReplicaStatus {
      open();
      if (!outputRecoveryReady()) return { playback: 'blocked', reason: 'OUTPUT_RUN_UNVERIFIED', deviceAccess: 'not-authorized',
        deviceOpened: false, formalReady: false, gateB: 'NOT_RUN' };
      let current: dto.RecordingOutputSelection | null;
      try { current = currentSelection(); } catch { current = null; }
      return current && dto.isRecordingOutputSelection(current)
        ? { playback: 'ready', outputSelection: current, deviceAccess: 'authorized', deviceOpened: false,
          formalReady: false, gateB: 'NOT_RUN' }
        : { playback: 'blocked', reason: 'NO_DEVICE_SELECTION', deviceAccess: 'not-authorized',
          deviceOpened: false, formalReady: false, gateB: 'NOT_RUN' };
    },
    assertExecutionIdle(): void { open(); if (active) return replicaFail('RUN_CONFLICT'); },
    start(value: dto.ReplicaDeviceStartRequest): dto.RecordingReplicaRun {
      open(); if (!dto.isStartRecordingReplicaRequest(value) || value.mode !== 'device-output') return replicaFail('INVALID_REQUEST');
      if (tombstones.has(value.runId)) return cancelledBeforeStart(value.runId);
      if (!outputRecoveryReady()) return replicaFail('BACKEND_UNAVAILABLE');
      const prior = runs.get(value.runId);
      if (prior) return JSON.stringify(prior.snapshot.request) === JSON.stringify(value) ? snapshot(prior) : replicaFail('RUN_CONFLICT');
      if (runs.size + tombstones.size >= maxRunIds) return replicaFail('RUN_LIMIT');
      if (active) return replicaFail('RUN_CONFLICT');
      try { assertAttemptIdle(); } catch { return replicaFail('RUN_CONFLICT'); }
      const selected = currentSelection();
      if (!selected || !sameSelection(selected, value.outputSelection)) return replicaFail('DEVICE_CHANGED');
      const at = now(), run: Run = { controller: new AbortController(), commands: new Map(),
        snapshot: { kind: 'device-session', runId: value.runId, request: structuredClone(value), revision: 1,
          createdAt: at, updatedAt: at, state: 'starting', identity: null, progress: null, receipt: null,
          controlRevision: 0, cursorFrame: 0, segmentId: null, segmentIndex: 0, segmentFromFrame: 0,
          segmentQuiescent: true, started: false, stopRequested: false, cleanupQuiescent: false,
          evidence: 'none', deviceOpened: false, formalReady: false, gateB: 'NOT_RUN' } };
      runs.set(value.runId, run); active = run;
      run.promise = Promise.resolve().then(() => execute(run));
      return snapshot(run);
    },
    get(request: dto.RecordingReplicaRunIdRequest): { run: dto.RecordingReplicaRun | null } {
      open(); if (!dto.isRecordingReplicaRunIdRequest(request)) return replicaFail('INVALID_REQUEST');
      const run = runs.get(request.runId); return { run: run ? snapshot(run) : tombstones.has(request.runId) ? cancelledBeforeStart(request.runId) : null };
    },
    /** 优先安全Stop只按精确runId生效，不依赖控制修订或某个可能失回执的pause。 */
    stop(request: dto.RecordingReplicaRunIdRequest): dto.RecordingReplicaRun {
      open(); if (!dto.isRecordingReplicaRunIdRequest(request)) return replicaFail('INVALID_REQUEST');
      const run = runs.get(request.runId);
      if (run) { end(run, new RecordingReplicaError('CANCELLED')); return snapshot(run); }
      if (tombstones.has(request.runId)) return cancelledBeforeStart(request.runId);
      if (runs.size + tombstones.size >= maxRunIds) return replicaFail('RUN_LIMIT');
      tombstones.add(request.runId); return cancelledBeforeStart(request.runId);
    },
    control(request: dto.ReplicaDeviceControlRequest): Session {
      open(); if (!dto.isReplicaDeviceControlRequest(request)) return replicaFail('INVALID_REQUEST');
      const run = runs.get(request.runId);
      if (!run) return replicaFail('RUN_CONFLICT');
      const fingerprint = JSON.stringify(request), prior = run.commands.get(request.commandId);
      if (prior) return prior.fingerprint === fingerprint ? structuredClone(prior.result) : replicaFail('CONTROL_CONFLICT');
      if (request.expectedControlRevision !== run.snapshot.controlRevision || run.commands.size >= 1000)
        return replicaFail('CONTROL_CONFLICT');
      if (terminal(run.snapshot.state)) return replicaFail('CONTROL_CONFLICT');
      const current = run.snapshot;
      if (request.operation === 'pause') {
        if ((current.state !== 'outputting' && current.state !== 'draining') || !run.segment || run.nativeCompleted)
          return replicaFail('CONTROL_CONFLICT');
        update(run, { controlRevision: current.controlRevision + 1, state: 'pausing' });
        run.desired = 'pause'; stopNative(run);
      } else if (request.operation === 'seek') {
        if (current.state !== 'paused' || !current.identity || request.frame >= current.identity.audio.frameCount)
          return replicaFail('CONTROL_CONFLICT');
        update(run, { controlRevision: current.controlRevision + 1, cursorFrame: request.frame,
          segmentFromFrame: request.frame, progress: emptyProgress() });
      } else if (request.operation === 'resume') {
        if (current.state !== 'paused' || !current.identity || current.cursorFrame >= current.identity.audio.frameCount)
          return replicaFail('CONTROL_CONFLICT');
        update(run, { controlRevision: current.controlRevision + 1, segmentId: randomUUID(),
          segmentIndex: current.segmentIndex + 1, segmentFromFrame: current.cursorFrame,
          segmentQuiescent: false, progress: emptyProgress(), state: 'resuming' });
        run.wake?.();
      } else {
        update(run, { controlRevision: current.controlRevision + 1 });
        end(run, new RecordingReplicaError('CANCELLED'));
      }
      const result = snapshot(run);
      run.commands.set(request.commandId, { fingerprint, result });
      return result;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      if (active) end(active, new RecordingReplicaError('CLOSED'));
      const pending = active?.promise;
      if (!pending) return;
      let timer: ReturnType<typeof setTimeout>;
      await Promise.race([pending, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new RecordingReplicaError('TIMEOUT')), closeTimeoutMs);
      })]).finally(() => clearTimeout(timer));
    },
  };
}
export type ReplicaDeviceSessionCoordinator = ReturnType<typeof createReplicaDeviceSessionCoordinator>;
