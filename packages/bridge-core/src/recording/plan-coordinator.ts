import * as dto from '@music-bridge/contracts';
import { verifyPublishedPreparation } from './preparation-files.js';
import { verifyArchiveObjects } from './archive-files.js';
import { withVerifiedReadonlySource } from './source-files.js';
import { mediaFingerprint } from './media-store.js';
import { RecordingPlanError, planFail, planSame, recordingPlanContent, type RecordingPlanInput } from './plan-integrity.js';
import type { RecordingPlanStore } from './plan-store.js';

interface Dependencies {
  store: RecordingPlanStore;
  operationTimeoutMs?: number;
  /** 合成故障注入点；正式实例使用真实只读文件核验。 */
  afterVerification?: () => Promise<void>;
}
export function createRecordingPlanCoordinator({ store, operationTimeoutMs = 30 * 60_000, afterVerification }: Dependencies) {
  if (!Number.isSafeInteger(operationTimeoutMs) || operationTimeoutMs < 1 || operationTimeoutMs > 30 * 60_000) return planFail();
  let closed = false;
  const reads = new Map<string, { controller: AbortController; promise: Promise<unknown> }>(), cancelled = new Set<string>();
  const writes = new Map<string, { fingerprint: string; promise: Promise<dto.RecordingPlanVersion> }>();
  function open(): void { if (closed) return planFail(); }
  async function run<T>(id: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    open(); if (!dto.isCollectionId(id) || reads.has(id) || reads.size >= 2 || cancelled.delete(id)) return planFail();
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), operationTimeoutMs);
    const promise = Promise.resolve().then(() => fn(controller.signal)); reads.set(id, { controller, promise });
    try { return await promise; } finally { clearTimeout(timer); reads.delete(id); }
  }
  async function checkFiles(input: RecordingPlanInput, signal: AbortSignal, checked?: Map<dto.RecordingPreflightCheck['category'], dto.RecordingPreflightCheck>): Promise<void> {
    const check = async (category: dto.RecordingPreflightCheck['category'], issue: dto.RecordingPreflightIssue, fn: () => Promise<void>) => {
      signal.throwIfAborted();
      try { await fn(); signal.throwIfAborted(); checked?.set(category, { category, state: 'passed' }); }
      catch (error) { signal.throwIfAborted(); if (!checked) return planFail(category, issue); checked.set(category, { category, state: 'blocked', code: error instanceof RecordingPlanError ? error.issue : issue }); }
    };
    await check('sources', 'SOURCE_INVALID', async () => {
      for (const { root, binding } of input.sources) await withVerifiedReadonlySource(root, binding.relative, binding.evidence, signal, async () => undefined);
    });
    await check('execution', 'EXECUTION_INVALID', async () => {
      const job = input.job;
      if (!await verifyPublishedPreparation(job.owned!, job.files, job.manifestHash!, signal)) return planFail('execution', 'EXECUTION_INVALID');
      const retained = job.input.retained;
      if (retained && !await verifyPublishedPreparation(retained.owned, retained.files, retained.manifestHash, signal)) return planFail('execution', 'EXECUTION_INVALID');
    });
    await check('archive', 'ARCHIVE_INVALID', async () => { await verifyArchiveObjects(input.archive, signal); });
    await afterVerification?.(); signal.throwIfAborted();
  }
  const selectionFor = (plan: dto.RecordingPlanVersion): dto.RecordingPlanSelection => ({ assetId: plan.execution.assetId, archiveOperationId: plan.archive.operationId });
  return {
    list(request: dto.RecordingPlanHistoryRequest) { open(); return store.list(request); },
    version(request: dto.RecordingPlanIdRequest) { open(); return store.version(request); },
    async preview(request: dto.PreviewRecordingPlanRequest): Promise<dto.RecordingPlanProposal> {
      if (!dto.isPreviewRecordingPlanRequest(request)) return planFail(); const selected = structuredClone(request.selection);
      return run(request.readId, async signal => {
        const input = store.capture(selected), fingerprint = store.fingerprint(input); await checkFiles(input, signal);
        const current = store.capture(selected); if (current.identity !== input.identity || store.fingerprint(current) !== fingerprint) return planFail();
        const proposal = { ...input.material, draftId: input.draftId, selection: selected, checkedAt: new Date().toISOString(), proposalFingerprint: fingerprint };
        if (!dto.isRecordingPlanProposal(proposal)) return planFail(); return proposal;
      });
    },
    async freeze(value: dto.FreezeRecordingPlanRequest): Promise<dto.RecordingPlanVersion> {
      open(); if (!dto.isFreezeRecordingPlanRequest(value)) return planFail(); const request = structuredClone(value), fingerprint = mediaFingerprint(request);
      const prior = store.cached(request); if (prior) return prior;
      const running = writes.get(request.commandId); if (running) { if (running.fingerprint !== fingerprint) return planFail(); return running.promise; }
      const promise = run(request.commandId, async signal => {
        const input = store.capture(request.selection); if (store.fingerprint(input) !== request.proposalFingerprint) return planFail();
        await checkFiles(input, signal); signal.throwIfAborted(); open(); return store.freeze(request, input);
      });
      writes.set(request.commandId, { fingerprint, promise });
      try { return await promise; } finally { writes.delete(request.commandId); }
    },
    async preflight(request: dto.RecordingPreflightRequest): Promise<dto.RecordingPreflightResult> {
      if (!dto.isRecordingPreflightRequest(request)) return planFail();
      return run(request.readId, async signal => {
        const plan = store.version({ id: request.planVersionId }).plan; if (!plan) return planFail();
        const checked = new Map<dto.RecordingPreflightCheck['category'], dto.RecordingPreflightCheck>(dto.RECORDING_PREFLIGHT_CATEGORIES.map(category => [category, { category, state: 'not-run', code: 'NOT_CHECKED' }]));
        checked.set('backend', { category: 'backend', state: 'not-run', code: 'BACKEND_NOT_CERTIFIED' });
        try {
          const selection = selectionFor(plan), input = store.capture(selection, plan.profileSnapshot);
          if (!planSame(input.material, recordingPlanContent(plan))) return planFail('physical-copy', 'COPY_UNAVAILABLE');
          for (const category of ['versions','physical-copy','capacity','profile'] as const) checked.set(category, { category, state: 'passed' });
          await checkFiles(input, signal, checked);
          if (store.capture(selection, plan.profileSnapshot).identity !== input.identity) return planFail();
        } catch (error) {
          signal.throwIfAborted(); const category = error instanceof RecordingPlanError ? error.category : 'versions';
          checked.set(category, { category, state: 'blocked', code: error instanceof RecordingPlanError ? error.issue : 'READ_FAILED' });
        }
        signal.throwIfAborted(); return { planVersionId: plan.id, checkedAt: new Date().toISOString(), state: 'blocked', gateB: 'NOT_RUN', checks: dto.RECORDING_PREFLIGHT_CATEGORIES.map(category => checked.get(category)!), formalReady: false };
      });
    },
    cancelRead(request: dto.RecordingPlanIdRequest): { cancelled: true } {
      open(); if (!dto.isRecordingPlanIdRequest(request)) return planFail();
      // freeze 是已明确确认的 outbox 写，不允许用只读取消接口撤销它。
      if (writes.has(request.id)) return planFail();
      const active = reads.get(request.id); if (active) active.controller.abort();
      else { if (cancelled.size >= 1000) cancelled.delete(cancelled.values().next().value!); cancelled.add(request.id); }
      return { cancelled: true };
    },
    async idle() { await Promise.allSettled([...reads.values()].map(read => read.promise)); },
    async close() { closed = true; cancelled.clear(); for (const read of reads.values()) read.controller.abort(); await Promise.allSettled([...reads.values()].map(read => read.promise)); },
  };
}
export type RecordingPlanCoordinator = ReturnType<typeof createRecordingPlanCoordinator>;
