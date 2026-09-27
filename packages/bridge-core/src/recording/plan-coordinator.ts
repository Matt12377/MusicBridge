import * as dto from '@music-bridge/contracts';
import { verifyPublishedPreparation } from './preparation-files.js';
import { verifyArchiveObjects } from './archive-files.js';
import { withVerifiedReadonlySource } from './source-files.js';
import { mediaFingerprint } from './media-store.js';
import { RecordingPlanError, planFail, planSame, recordingPlanContent, type RecordingPlanInput } from './plan-integrity.js';
import type { RecordingPlanStore } from './plan-store.js';
import type { RecordingDeviceSelectionBroker } from './device-selection-broker.js';
import type { GateBAdmission, GateBAdmissionSource } from './gate-b-admission.js';

interface Dependencies {
  store: RecordingPlanStore;
  deviceSelection?: Pick<RecordingDeviceSelectionBroker, 'current' | 'binding'>;
  gateB?: GateBAdmissionSource;
  now?: () => number;
  operationTimeoutMs?: number;
  /** 合成故障注入点；正式实例使用真实只读文件核验。 */
  afterVerification?: () => Promise<void>;
}
export function createRecordingPlanCoordinator({ store, deviceSelection, gateB, now = Date.now,
  operationTimeoutMs = 30 * 60_000, afterVerification }: Dependencies) {
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
  const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) && !/^0{64}$/u.test(value);
  function admissionMatches(plan: dto.RecordingPlanVersion, selection: dto.RecordingOutputSelection,
    admission: GateBAdmission): boolean {
    const binding = plan.outputBinding, format = plan.profileSnapshot.settings.format, route = admission.route, drain = admission.drain;
    return !!binding && hash(admission.recordSha256) && hash(admission.helperSha256)
      && admission.endpointId === binding.endpointId && admission.uid === binding.deviceUid
      && admission.selectionGeneration === selection.selectionGeneration
      && admission.configurationFingerprintSha256 === binding.configurationFingerprintSha256
      && admission.drainAlgorithmId === binding.drainAlgorithmId
      && Number.isFinite(Date.parse(admission.validUntil)) && now() < Date.parse(admission.validUntil)
      && route.endpointId === binding.endpointId && route.uid === binding.deviceUid
      && route.sampleRate === format.sampleRate && route.channelCount === format.channelCount
      && route.format === format.outputSampleFormat && route.physicalFormat === route.format
      && route.bufferFrames === binding.bufferFrames
      && Number.isSafeInteger(drain.capacityFrames) && drain.capacityFrames >= binding.bufferFrames && drain.capacityFrames <= 16384
      && Number.isSafeInteger(drain.tailFrames) && drain.tailFrames >= binding.bufferFrames && drain.tailFrames <= 3840000
      && Number.isSafeInteger(drain.minimumZeroCallbacks) && drain.minimumZeroCallbacks >= 1 && drain.minimumZeroCallbacks <= 128;
  }
  async function checkBackend(plan: dto.RecordingPlanVersion, signal: AbortSignal): Promise<dto.RecordingPreflightCheck> {
    const blocked = (code: dto.RecordingPreflightIssue): dto.RecordingPreflightCheck => ({ category: 'backend', state: 'blocked', code });
    if (!plan.outputBinding) return blocked('OUTPUT_BINDING_MISSING');
    const selection = deviceSelection?.current();
    if (!selection || selection.endpointId !== plan.outputBinding.endpointId) return blocked('OUTPUT_SELECTION_CHANGED');
    let binding: dto.RecordingPlanOutputBinding;
    try { binding = await deviceSelection!.binding(selection, signal); }
    catch { signal.throwIfAborted(); return blocked('OUTPUT_DEVICE_UNAVAILABLE'); }
    if (!planSame(binding, plan.outputBinding)) return blocked('OUTPUT_IDENTITY_CHANGED');
    // 冻结身份不是执行许可；仅本次完整受信Gate B核验可产生瞬时通过，生产空白名单仍阻断。
    if (!gateB) return blocked('BACKEND_NOT_CERTIFIED');
    let admission: GateBAdmission | null;
    try { admission = await gateB.verify(plan, signal); }
    catch { signal.throwIfAborted(); return blocked('BACKEND_NOT_CERTIFIED'); }
    signal.throwIfAborted();
    if (!admission || !admissionMatches(plan, selection, admission)) return blocked('BACKEND_NOT_CERTIFIED');
    const latest = deviceSelection?.current();
    if (!latest || latest.endpointId !== selection.endpointId || latest.selectionGeneration !== selection.selectionGeneration)
      return blocked('OUTPUT_SELECTION_CHANGED');
    try { binding = await deviceSelection!.binding(selection, signal); }
    catch { signal.throwIfAborted(); return blocked('OUTPUT_DEVICE_UNAVAILABLE'); }
    signal.throwIfAborted();
    if (!planSame(binding, plan.outputBinding)) return blocked('OUTPUT_IDENTITY_CHANGED');
    if (now() >= Date.parse(admission.validUntil)) return blocked('BACKEND_NOT_CERTIFIED');
    return { category: 'backend', state: 'passed' };
  }
  return {
    list(request: dto.RecordingPlanHistoryRequest) { open(); return store.list(request); },
    version(request: dto.RecordingPlanIdRequest) { open(); return store.version(request); },
    async preview(request: dto.PreviewRecordingPlanRequest): Promise<dto.RecordingPlanProposal> {
      if (!dto.isPreviewRecordingPlanRequest(request)) return planFail(); const selected = structuredClone(request.selection);
      return run(request.readId, async signal => {
        if (!deviceSelection) return planFail('backend', 'OUTPUT_DEVICE_UNAVAILABLE');
        const binding = await deviceSelection.binding(selected.outputSelection, signal);
        const input = store.capture(selected), fingerprint = store.fingerprint(input, binding); await checkFiles(input, signal);
        const current = store.capture(selected), latest = await deviceSelection.binding(selected.outputSelection, signal);
        if (current.identity !== input.identity || !planSame(latest, binding) || store.fingerprint(current, latest) !== fingerprint) return planFail();
        const proposal = { ...input.material, outputBinding: binding, draftId: input.draftId, selection: selected, checkedAt: new Date().toISOString(), proposalFingerprint: fingerprint };
        if (!dto.isRecordingPlanProposal(proposal)) return planFail(); return proposal;
      });
    },
    async freeze(value: dto.FreezeRecordingPlanRequest): Promise<dto.RecordingPlanVersion> {
      open(); if (!dto.isFreezeRecordingPlanRequest(value)) return planFail(); const request = structuredClone(value), fingerprint = mediaFingerprint(request);
      const prior = store.cached(request); if (prior) return prior;
      if (!dto.isCurrentFreezeRecordingPlanRequest(request)) return planFail('backend', 'OUTPUT_BINDING_MISSING');
      const running = writes.get(request.commandId); if (running) { if (running.fingerprint !== fingerprint) return planFail(); return running.promise; }
      const promise = run(request.commandId, async signal => {
        if (!deviceSelection) return planFail('backend', 'OUTPUT_DEVICE_UNAVAILABLE');
        const binding = await deviceSelection.binding(request.selection.outputSelection, signal);
        const input = store.capture(request.selection); if (store.fingerprint(input, binding) !== request.proposalFingerprint) return planFail();
        await checkFiles(input, signal);
        const latest = await deviceSelection.binding(request.selection.outputSelection, signal);
        if (!planSame(latest, binding)) return planFail('backend', 'OUTPUT_IDENTITY_CHANGED');
        signal.throwIfAborted(); open(); return store.freeze(request, input, latest);
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
          if (input.material.mediaPlanRevision !== plan.mediaPlanRevision) return planFail('versions', 'VERSION_MISMATCH');
          if (!planSame({ ...input.material, ...(plan.outputBinding ? { outputBinding: plan.outputBinding } : {}) }, recordingPlanContent(plan))) return planFail('physical-copy', 'COPY_UNAVAILABLE');
          for (const category of ['versions','physical-copy','capacity','profile'] as const) checked.set(category, { category, state: 'passed' });
          await checkFiles(input, signal, checked);
          if (store.capture(selection, plan.profileSnapshot).identity !== input.identity) return planFail();
          checked.set('backend', await checkBackend(plan, signal));
          if (store.capture(selection, plan.profileSnapshot).identity !== input.identity) return planFail();
        } catch (error) {
          signal.throwIfAborted(); const category = error instanceof RecordingPlanError ? error.category : 'versions';
          checked.set(category, { category, state: 'blocked', code: error instanceof RecordingPlanError ? error.issue : 'READ_FAILED' });
        }
        signal.throwIfAborted();
        const checks = dto.RECORDING_PREFLIGHT_CATEGORIES.map(category => checked.get(category)!);
        const gateVerified = checked.get('backend')?.state === 'passed';
        const ready = gateVerified && checks.every(check => check.state === 'passed');
        const result: dto.RecordingPreflightResult = ready
          ? { planVersionId: plan.id, checkedAt: new Date().toISOString(), state: 'ready', gateB: 'VERIFIED', checks, formalReady: true }
          : { planVersionId: plan.id, checkedAt: new Date().toISOString(), state: 'blocked',
            gateB: gateVerified ? 'VERIFIED' : 'NOT_RUN', checks, formalReady: false };
        if (!dto.isRecordingPreflightResult(result)) return planFail('backend', 'BACKEND_NOT_CERTIFIED');
        return result;
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
