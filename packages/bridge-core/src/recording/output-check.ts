import * as dto from '@music-bridge/contracts';
import { mediaFingerprint } from './media-store.js';
import type { RecordingPlanStore } from './plan-store.js';
import { captureRecordingOutput, verifyRecordingOutputDependencies, withRecordingOutputInput, type RecordingOutputRunner } from './output-input.js';
import { OutputCheckError, outputCheckFail } from './output-error.js';

interface Dependencies {
  store: RecordingPlanStore; runner: RecordingOutputRunner;
  /** 仅可收紧生产预算；不延长文件租期，不向Renderer暴露。 */
  operationTimeoutMs?: number; maxRunIds?: number;
  afterVerification?: () => Promise<void>;
}
interface Run { fingerprint?: string; controller: AbortController; promise?: Promise<dto.RecordingOutputCheckResult> }

export function createRecordingOutputCoordinator({ store, runner, operationTimeoutMs = 15 * 60_000, maxRunIds = 1000, afterVerification }: Dependencies) {
  if (!Number.isSafeInteger(operationTimeoutMs) || operationTimeoutMs < 1 || operationTimeoutMs > 15 * 60_000 || !Number.isSafeInteger(maxRunIds) || maxRunIds < 1 || maxRunIds > 1000) return outputCheckFail('INVALID_REQUEST');
  let closed = false, active: Run | undefined, closing: Promise<void> | undefined;
  const runs = new Map<string, Run>();
  const open = () => { if (closed) return outputCheckFail('CLOSED'); };
  function remember(id: string, run: Run): void { if (runs.size >= maxRunIds) return outputCheckFail('RUN_LIMIT'); runs.set(id, run); }
  return {
    async check(value: dto.RecordingOutputCheckRequest): Promise<dto.RecordingOutputCheckResult> {
      open(); if (!dto.isRecordingOutputCheckRequest(value)) return outputCheckFail('INVALID_REQUEST');
      const request = structuredClone(value), fingerprint = mediaFingerprint(request), prior = runs.get(request.runId);
      if (prior) {
        if (!prior.fingerprint) return outputCheckFail('CANCELLED');
        if (prior.fingerprint !== fingerprint) return outputCheckFail('RUN_CONFLICT');
        return structuredClone(await prior.promise!);
      }
      if (active) return outputCheckFail('RUN_CONFLICT');
      const run: Run = { fingerprint, controller: new AbortController() }; remember(request.runId, run); active = run;
      const deadline = performance.now() + operationTimeoutMs;
      const check = () => {
        if (run.controller.signal.aborted) throw run.controller.signal.reason;
        open(); if (performance.now() > deadline) return outputCheckFail('TIMEOUT');
      };
      const timer = setTimeout(() => run.controller.abort(new OutputCheckError('TIMEOUT')), operationTimeoutMs);
      run.promise = Promise.resolve().then(async () => {
        check(); const input = captureRecordingOutput(store, request);
        let lastChecked = -Infinity;
        const checkCurrent = (force = false) => {
          check(); const now = performance.now(); if (!force && now - lastChecked < 100) return;
          const current = captureRecordingOutput(store, request);
          if (current.facts.identity !== input.facts.identity) return outputCheckFail('PLAN_CHANGED'); lastChecked = now;
        };
        await verifyRecordingOutputDependencies(input, run.controller.signal, () => checkCurrent());
        await afterVerification?.(); checkCurrent(true);
        const receipt = await withRecordingOutputInput(input, run.controller.signal, () => checkCurrent(), async (handle, checked) => {
          checkCurrent(true); checked();
          try {
            return await runner.run({ handle, format: structuredClone(input.plan.profileSnapshot.settings.format), audio: structuredClone(input.receipt.audio), signal: run.controller.signal, checkOperation: checked,
              identity: { runId: request.runId, planVersionId: input.plan.id, assetId: input.plan.execution.assetId, planContentHash: input.plan.contentHash, recipeHash: input.receipt.recipeHash } });
          } catch (error) { check(); if (error instanceof OutputCheckError) throw error; return outputCheckFail('HELPER_UNAVAILABLE'); }
        });
        checkCurrent(true);
        if (!receipt || receipt.consumedFrames !== input.receipt.audio.frameCount || receipt.pcmSha256 !== input.receipt.audio.pcmSha256) return outputCheckFail('FRAME_MISMATCH');
        if (typeof receipt.helperSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(receipt.helperSha256)) return outputCheckFail('HELPER_PROTOCOL');
        // 源/归档等依赖可能在helper运行时改变；完整复核后才发布合成成功。
        await verifyRecordingOutputDependencies(input, run.controller.signal, () => checkCurrent()); checkCurrent(true);
        const result: dto.RecordingOutputCheckResult = { state: 'verified', ...request, planContentHash: input.plan.contentHash, frameCount: input.receipt.audio.frameCount, consumedFrames: receipt.consumedFrames, pcmSha256: receipt.pcmSha256, helperSha256: receipt.helperSha256, deviceOpened: false, formalReady: false, gateB: 'NOT_RUN', evidence: 'synthetic-only' };
        if (!dto.isRecordingOutputCheckResult(result)) return outputCheckFail('HELPER_PROTOCOL'); return result;
      }).catch(error => { if (error instanceof OutputCheckError) throw error; return outputCheckFail('INPUT_UNAVAILABLE'); }).finally(() => { clearTimeout(timer); if (active === run) active = undefined; });
      return structuredClone(await run.promise);
    },
    cancel(request: dto.RecordingOutputCancelRequest): { cancelled: true } {
      open(); if (!dto.isRecordingOutputCancelRequest(request)) return outputCheckFail('INVALID_REQUEST');
      let run = runs.get(request.runId);
      if (!run) { run = { controller: new AbortController() }; remember(request.runId, run); }
      if (!run.controller.signal.aborted) run.controller.abort(new OutputCheckError('CANCELLED'));
      return { cancelled: true };
    },
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      if (active && !active.controller.signal.aborted) active.controller.abort(new OutputCheckError('CLOSED'));
      closing = Promise.allSettled(active?.promise ? [active.promise] : []).then(() => { runs.clear(); }); return closing;
    },
  };
}
export type RecordingOutputCoordinator = ReturnType<typeof createRecordingOutputCoordinator>;
