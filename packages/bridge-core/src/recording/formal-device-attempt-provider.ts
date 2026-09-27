import * as dto from '@music-bridge/contracts';
import { attemptFail } from './attempt-integrity.js';
import type { RecordingAttemptAdmissionProvider, RecordingAttemptDriver, RecordingAttemptDriverRequest } from './attempt-coordinator.js';
import type { RecordingDeviceSelectionBroker } from './device-selection-broker.js';
import { verifyPinnedDeviceOutputHelper, type PinnedDeviceOutputHelper } from './bundled-device-output-helper.js';
import { startDeviceOutputRun, type DeviceOutputRunnerOptions, type DeviceOutputRunError } from './device-output-runner.js';
import type { GateBAdmission, GateBAdmissionSource, GateBLiveObservation } from './gate-b-admission.js';
import { DEVICE_OUTPUT_BACKEND_ID, DEVICE_OUTPUT_BACKEND_VERSION } from './device-output-protocol.js';
import { createOutputRunLease } from './output-run-lease.js';

interface Authorized {
  plan: dto.RecordingPlanVersion; side: dto.RenderSide; selection: dto.RecordingOutputSelection;
  admission: GateBAdmission;
}
interface Options {
  pin: PinnedDeviceOutputHelper;
  /** 生产内存中已绑定的精确工作库；缺失时真实helper不得获得正式run租约。 */
  leaseScope?: { databaseFile: string; datasetId: string };
  deviceSelection: Pick<RecordingDeviceSelectionBroker, 'current' | 'verify'>;
  gateB: GateBAdmissionSource;
  /** 冷启旧run静止未证实则拒绝任何新的正式输出，且不得进入HAL。 */
  outputRecoveryReady?: () => boolean;
  /** 仅私有受控测试可注入launch；正式Runtime省略。 */
  runnerOptions?: DeviceOutputRunnerOptions;
  /** 只供隔离单元测试核对准入与事件映射；正式Runtime使用固定Runner。 */
  run?: typeof startDeviceOutputRun;
  now?: () => number;
  /** 进度合并使用单调时钟，与Gate B绝对期限时钟分开。 */
  progressNow?: () => number;
}
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) && !/^0{64}$/u.test(value);
const sameSelection = (left: dto.RecordingOutputSelection, right: dto.RecordingOutputSelection): boolean =>
  left.endpointId === right.endpointId && left.selectionGeneration === right.selectionGeneration;
const sameAdmission = (left: GateBAdmission, right: GateBAdmission): boolean =>
  left.recordSha256 === right.recordSha256 && left.configurationFingerprintSha256 === right.configurationFingerprintSha256
  && left.endpointId === right.endpointId && left.uid === right.uid && left.selectionGeneration === right.selectionGeneration
  && left.validUntil === right.validUntil && left.helperSha256 === right.helperSha256
  && JSON.stringify(left.route) === JSON.stringify(right.route) && left.drainAlgorithmId === right.drainAlgorithmId
  && JSON.stringify(left.drain) === JSON.stringify(right.drain);
function matches(plan: dto.RecordingPlanVersion, selected: dto.RecordingOutputSelection,
  observed: GateBLiveObservation, admission: GateBAdmission, pin: PinnedDeviceOutputHelper, now: number): boolean {
  const binding = plan.outputBinding, expected = plan.profileSnapshot.settings.format;
  return !!binding && dto.isRecordingPlanOutputBinding(binding) && hash(admission.recordSha256)
    && admission.helperSha256 === pin.sha256 && admission.drainAlgorithmId === pin.drainAlgorithmId
    && Number.isFinite(now) && Number.isFinite(Date.parse(admission.validUntil)) && now < Date.parse(admission.validUntil)
    && admission.selectionGeneration === selected.selectionGeneration && admission.endpointId === selected.endpointId
    && observed.selectionGeneration === selected.selectionGeneration && observed.endpointId === selected.endpointId
    && admission.uid === binding.deviceUid && observed.uid === binding.deviceUid
    && admission.configurationFingerprintSha256 === binding.configurationFingerprintSha256
    && observed.configurationFingerprintSha256 === binding.configurationFingerprintSha256
    && admission.route.endpointId === binding.endpointId && admission.route.uid === binding.deviceUid
    && admission.route.sampleRate === observed.sampleRate && admission.route.channelCount === observed.channelCount
    && admission.route.format === observed.format && admission.route.physicalFormat === observed.physicalFormat
    && admission.route.bufferFrames === binding.bufferFrames && observed.bufferFrames === binding.bufferFrames
    && expected.sampleRate === admission.route.sampleRate && expected.channelCount === admission.route.channelCount
    && expected.outputSampleFormat === admission.route.format
    && expected.outputBackend.id === DEVICE_OUTPUT_BACKEND_ID && expected.outputBackend.version === DEVICE_OUTPUT_BACKEND_VERSION;
}
function failureReason(error: DeviceOutputRunError): 'backend-failure' | 'backend-timeout' | 'route-changed' | 'source-read-failed' | 'protocol-error' {
  return error.code === 'TIMEOUT' ? 'backend-timeout' : error.code === 'ROUTE_CHANGED' ? 'route-changed'
    : error.code === 'INPUT_CHANGED' ? 'source-read-failed' : error.code === 'PROTOCOL' ? 'protocol-error' : 'backend-failure';
}

/** 只供正式Attempt：每Side启动前及helper关闭后复核完整受信Gate B；生产空白名单始终拒绝。 */
export function createFormalDeviceAttemptProvider({ pin, leaseScope, deviceSelection, gateB, outputRecoveryReady = () => true, runnerOptions, run = startDeviceOutputRun,
  now = Date.now, progressNow = () => performance.now() }: Options): RecordingAttemptAdmissionProvider {
  let sequence = 0, authorized: Authorized | undefined;
  const verify = async (plan: dto.RecordingPlanVersion, selection: dto.RecordingOutputSelection,
    signal: AbortSignal): Promise<GateBAdmission> => {
    signal.throwIfAborted();
    let observed: GateBLiveObservation;
    try { await verifyPinnedDeviceOutputHelper(pin); observed = await deviceSelection.verify(selection, signal); }
    catch { return attemptFail('BACKEND_NOT_CERTIFIED'); }
    const admission = await gateB.verify(plan, signal);
    signal.throwIfAborted();
    if (!admission || !matches(plan, selection, observed, admission, pin, now())) return attemptFail('BACKEND_NOT_CERTIFIED');
    try { await verifyPinnedDeviceOutputHelper(pin); }
    catch { return attemptFail('BACKEND_NOT_CERTIFIED'); }
    if (!deviceSelection.current() || !sameSelection(deviceSelection.current()!, selection)) return attemptFail('BACKEND_NOT_CERTIFIED');
    return admission;
  };
  return {
    async authorize({ plan, side, signal }) {
      authorized = undefined; const ticket = ++sequence;
      if (!outputRecoveryReady()) return attemptFail('BACKEND_NOT_CERTIFIED');
      if (!dto.isRecordingPlanVersion(plan) || !plan.outputBinding
        || !plan.execution.audio.some(item => item.recipe.side === side)) return attemptFail('BACKEND_NOT_CERTIFIED');
      const selection = deviceSelection.current();
      if (!selection || selection.endpointId !== plan.outputBinding.endpointId) return attemptFail('BACKEND_NOT_CERTIFIED');
      const admission = await verify(plan, selection, signal);
      if (sequence !== ticket || signal.aborted) return attemptFail('BACKEND_NOT_CERTIFIED');
      authorized = { plan: structuredClone(plan), side, selection: { ...selection }, admission };
    },
    async start(request: RecordingAttemptDriverRequest): Promise<RecordingAttemptDriver> {
      const saved = authorized; authorized = undefined; ++sequence;
      // 没有未消费的授权时无法证明这是本次持久run；旧request重放不补造任何事实。
      if (!saved) return attemptFail('BACKEND_NOT_CERTIFIED');
      const identity = { side: request.side, runId: request.runId };
      const emit = (type: 'source-eof' | 'backend-drained' | 'engine-cutoff' | 'stop-ack' | 'cleanup-quiescent') =>
        request.onEvent({ ...identity, type, at: new Date().toISOString() });
      let lease: Awaited<ReturnType<typeof createOutputRunLease>> | undefined;
      // start首次消费授权后、委托Runner前均属软件pre-spawn。失败时绝无HAL调用，
      // 因此只可证明cutoff/quiescent；不能冒充原生Stop ACK、EOF或drain。
      const { receipt, admission } = await (async () => {
        if (request.side !== saved.side || request.attempt.planVersionId !== saved.plan.id
          || request.attempt.planContentHash !== saved.plan.contentHash) return attemptFail('BACKEND_NOT_CERTIFIED');
        const receipt = saved.plan.execution.audio.find(item => item.recipe.side === request.side);
        if (!receipt || receipt.audio.frameCount !== request.input.audio.frameCount
          || receipt.audio.pcmSha256 !== request.input.audio.pcmSha256
          || JSON.stringify(request.input.format) !== JSON.stringify(saved.plan.profileSnapshot.settings.format)) return attemptFail('PLAN_CHANGED');
        const current = deviceSelection.current();
        if (!current || !sameSelection(current, saved.selection)) return attemptFail('BACKEND_NOT_CERTIFIED');
        const admission = await verify(saved.plan, saved.selection, request.signal);
        if (!sameAdmission(admission, saved.admission)) return attemptFail('BACKEND_NOT_CERTIFIED');
        try {
          if (!outputRecoveryReady()) return attemptFail('BACKEND_NOT_CERTIFIED');
          if (leaseScope) lease = await createOutputRunLease({ ...leaseScope, attemptId: request.attempt.id,
            side: request.side, runId: request.runId, planContentSha256: saved.plan.contentHash,
            audioSha256: receipt.audio.sha256, pcmSha256: receipt.audio.pcmSha256,
            gateRecordSha256: admission.recordSha256, pin });
          request.signal.throwIfAborted(); request.input.checkOperation();
          const selected = deviceSelection.current();
          if (!selected || !sameSelection(selected, saved.selection) || now() >= Date.parse(admission.validUntil)) return attemptFail('BACKEND_NOT_CERTIFIED');
        } catch { return attemptFail('BACKEND_NOT_CERTIFIED'); }
        return { receipt, admission };
      })().catch(async error => {
        try { await lease?.close(); } catch { /* 未委托Runner，仍保留原拒绝。 */ }
        emit('engine-cutoff'); emit('cleanup-quiescent');
        throw error;
      });
      const checkOperation = () => {
        request.input.checkOperation();
        if (!outputRecoveryReady()) return attemptFail('BACKEND_NOT_CERTIFIED');
        const selected = deviceSelection.current();
        if (!selected || !sameSelection(selected, saved.selection) || now() >= Date.parse(admission.validUntil)) return attemptFail('BACKEND_NOT_CERTIFIED');
      };
      let cleanupDelivered = false, nativeStopAcknowledged = false;
      let latest: { suppliedFrames: number; consumedFrames: number } | undefined;
      let published: typeof latest;
      let lastPublishedAt = Number.NEGATIVE_INFINITY, protocolFailed = false;
      const interrupt = (reason: 'protocol-error' | ReturnType<typeof failureReason>) => {
        if (request.signal.aborted) return;
        request.onEvent({ ...identity, type: 'interrupt', at: new Date().toISOString(), reason });
      };
      const flushProgress = (force = false) => {
        if (!latest || protocolFailed || latest.suppliedFrames === published?.suppliedFrames
          && latest.consumedFrames === published.consumedFrames) return;
        const at = progressNow();
        if (!force && (!Number.isFinite(at) || at - lastPublishedAt < 1000)) return;
        request.onEvent({ ...identity, type: 'progress', at: new Date().toISOString(),
          sourceFramesRead: latest.suppliedFrames, submittedFrames: latest.suppliedFrames, consumedFrames: latest.consumedFrames });
        published = latest; lastPublishedAt = at;
      };
      const handle = await run(pin, {
        header: { scope: 'formal-recording', runId: request.runId, recordSha256: admission.recordSha256,
          pcmSha256: receipt.audio.pcmSha256, uid: admission.uid, frameCount: receipt.audio.frameCount,
          sampleRate: admission.route.sampleRate, channelCount: admission.route.channelCount,
          format: admission.route.format, bufferFrames: admission.route.bufferFrames,
          capacityFrames: admission.drain.capacityFrames, tailFrames: admission.drain.tailFrames,
          minimumZeroCallbacks: admission.drain.minimumZeroCallbacks },
        reader: request.input.consumer, signal: AbortSignal.any([request.signal, request.input.signal]), checkOperation,
        callbacks: {
          onProgress(value) {
            if (protocolFailed) return;
            if (!Number.isSafeInteger(value.suppliedFrames) || !Number.isSafeInteger(value.consumedFrames)
              || value.suppliedFrames < (latest?.suppliedFrames ?? 0) || value.consumedFrames < (latest?.consumedFrames ?? 0)
              || value.suppliedFrames > receipt.audio.frameCount || value.consumedFrames > value.suppliedFrames) {
              protocolFailed = true; interrupt('protocol-error'); return;
            }
            latest = { suppliedFrames: value.suppliedFrames, consumedFrames: value.consumedFrames };
            flushProgress();
          },
          onSourceEof() { flushProgress(true); if (!protocolFailed) emit('source-eof'); },
          onDrainObserved() { flushProgress(true); /* HAL候选不是完成；等待完整终态、child.close及复核。 */ },
          onCleanup(facts) {
            if (cleanupDelivered) return;
            cleanupDelivered = true;
            nativeStopAcknowledged = facts.stopAcknowledged;
            if (facts.engineCutoff) emit('engine-cutoff');
            if (facts.stopAcknowledged) emit('stop-ack');
            if (facts.cleanupQuiescent) emit('cleanup-quiescent');
          },
          onComplete() {
            flushProgress(true);
            if (protocolFailed || request.signal.aborted) return;
            if (!cleanupDelivered || !nativeStopAcknowledged) { interrupt('protocol-error'); return; }
            // Runner已等child.close并复核pin；这里再次读取受信完整记录与当前精确观测。
            void verify(saved.plan, saved.selection, request.signal).then(final => {
              if (request.signal.aborted || !sameAdmission(final, admission)) return interrupt('route-changed');
              flushProgress(true); emit('backend-drained');
            }).catch(() => interrupt('backend-failure'));
          },
          onFailure(error) { flushProgress(true); interrupt(failureReason(error)); },
        },
      }, { ...runnerOptions, ...(lease ? { lease } : {}) });
      // 用户停止沿用Attempt既有的先abort/派发stop边界；未冲刷的进度只作观测下限。
      return { stop: () => handle.stop(), close: () => handle.close() };
    },
  };
}
