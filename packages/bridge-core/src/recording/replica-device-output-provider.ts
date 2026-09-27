import { createHash } from 'node:crypto';
import * as dto from '@music-bridge/contracts';
import { verifyPinnedDeviceOutputHelper, type PinnedDeviceOutputHelper } from './bundled-device-output-helper.js';
import type { RecordingDeviceSelectionBroker } from './device-selection-broker.js';
import { startDeviceOutputRun, type DeviceOutputRunCallbacks, type DeviceOutputRunnerOptions } from './device-output-runner.js';
import type { ReplicaVerifiedInput } from './replica-input.js';
import { RecordingReplicaError, replicaFail } from './replica-error.js';
import type { ReadonlyAudioReader } from './readonly-audio-consumer.js';

interface Options {
  pin: PinnedDeviceOutputHelper;
  deviceSelection: Pick<RecordingDeviceSelectionBroker, 'current' | 'verify'>;
  /** 仅受控Fake测试可注入；生产省略。 */
  run?: typeof startDeviceOutputRun;
  runnerOptions?: DeviceOutputRunnerOptions;
}
export interface ReplicaDeviceSegmentRequest {
  logicalRunId: string; segmentId: string; fromFrame: number;
  selection: dto.RecordingOutputSelection; input: ReplicaVerifiedInput;
  signal: AbortSignal; checkOperation(): void; callbacks: DeviceOutputRunCallbacks;
  /** 即将进入Runner；之后必须见到其cleanup事实才能释放逻辑执行槽。 */
  onNativeAttempt(): void;
}
const sameSelection = (left: dto.RecordingOutputSelection, right: dto.RecordingOutputSelection): boolean =>
  left.endpointId === right.endpointId && left.selectionGeneration === right.selectionGeneration;

/** 每次 seek 后先计算剩余段的真实 PCM Hash；原件完整段沿用输入边界已验证的 Hash。 */
async function segmentReader(input: ReplicaVerifiedInput, fromFrame: number, signal: AbortSignal,
  checkOperation: () => void): Promise<{ reader: ReadonlyAudioReader; pcmSha256: string }> {
  const source = input.consumer, total = source.descriptor.frameCount;
  if (!Number.isSafeInteger(fromFrame) || fromFrame < 0 || fromFrame >= total) return replicaFail('INPUT_INVALID');
  const remaining = total - fromFrame;
  const check = () => { if (signal.aborted) return replicaFail('CANCELLED'); checkOperation(); input.checkOperation(); };
  let pcmSha256 = input.audio.pcmSha256;
  if (fromFrame !== 0) {
    const digest = createHash('sha256');
    for (let read = 0; read < remaining;) {
      check(); const expected = Math.min(4096, remaining - read);
      let result: Awaited<ReturnType<ReadonlyAudioReader['readFrames']>>;
      try { result = await source.readFrames(fromFrame + read, expected); }
      catch { return replicaFail('INPUT_CHANGED'); }
      check();
      if (result.frames !== expected || !Buffer.isBuffer(result.bytes)) return replicaFail('INPUT_CHANGED');
      digest.update(result.bytes); read += result.frames;
    }
    pcmSha256 = digest.digest('hex');
  }
  const reader: ReadonlyAudioReader = Object.freeze({
    descriptor: Object.freeze({ ...source.descriptor, frameCount: remaining }),
    async readFrames(start: number, frames: number) {
      check();
      if (!Number.isSafeInteger(start) || start < 0 || start >= remaining) return replicaFail('INPUT_INVALID');
      const result = await source.readFrames(fromFrame + start, frames);
      check();
      return { ...result, sourceEof: start + result.frames === remaining };
    },
  });
  return { reader, pcmSha256 };
}

/** 普通历史试听只使用当前本机设备选择和精确音频，不读取也不签发 Formal Gate B。 */
export function createReplicaDeviceOutputProvider({ pin, deviceSelection, run = startDeviceOutputRun, runnerOptions }: Options) {
  async function selection(value: dto.RecordingOutputSelection, signal: AbortSignal) {
    signal.throwIfAborted();
    const current = deviceSelection.current();
    if (!current || !sameSelection(current, value)) return replicaFail('DEVICE_CHANGED');
    try { await verifyPinnedDeviceOutputHelper(pin); } catch { return replicaFail('HELPER_CHANGED'); }
    let observed: Awaited<ReturnType<typeof deviceSelection.verify>>;
    try { observed = await deviceSelection.verify(value, signal); }
    catch { return replicaFail('DEVICE_CHANGED'); }
    signal.throwIfAborted();
    if (observed.endpointId !== value.endpointId || observed.selectionGeneration !== value.selectionGeneration
      || !observed.alive || !observed.hasOutput) return replicaFail('DEVICE_CHANGED');
    try { await verifyPinnedDeviceOutputHelper(pin); } catch { return replicaFail('HELPER_CHANGED'); }
    return observed;
  }
  return {
    async verify(value: dto.RecordingOutputSelection, signal: AbortSignal) { return selection(value, signal); },
    async start(request: ReplicaDeviceSegmentRequest) {
      const { logicalRunId, segmentId, fromFrame, input, signal, checkOperation, callbacks } = request;
      if (!dto.isCollectionId(logicalRunId) || !dto.isCollectionId(segmentId)
        || !dto.isRecordingOutputSelection(request.selection) || !dto.isReplicaAudioIdentity(input.audio)) return replicaFail('INPUT_INVALID');
      const observed = await selection(request.selection, signal);
      if (input.audio.format.sampleRate !== observed.sampleRate || input.audio.format.channelCount !== observed.channelCount
        || input.audio.format.sampleFormat !== observed.format || observed.physicalFormat !== observed.format)
        return replicaFail('UNSUPPORTED_FORMAT');
      const check = () => {
        checkOperation(); input.checkOperation();
        const current = deviceSelection.current();
        if (!current || !sameSelection(current, request.selection)) return replicaFail('DEVICE_CHANGED');
      };
      const { reader, pcmSha256 } = await segmentReader(input, fromFrame, signal, check);
      check();
      const playbackIdentitySha256 = createHash('sha256').update(JSON.stringify({
        scope: 'replica-playback', logicalRunId, segmentId, fromFrame, selection: request.selection,
        audio: input.audio, observed, helperSha256: pin.sha256,
      })).digest('hex');
      const header = { scope: 'replica-playback' as const, runId: segmentId, playbackIdentitySha256, pcmSha256,
        uid: observed.uid, sampleRate: observed.sampleRate, channelCount: observed.channelCount,
        format: observed.format, bufferFrames: observed.bufferFrames, capacityFrames: observed.bufferFrames * 2,
        tailFrames: observed.bufferFrames, minimumZeroCallbacks: 2, frameCount: reader.descriptor.frameCount };
      try {
        request.onNativeAttempt();
        const handle = await run(pin, { header, reader, signal, checkOperation: check, callbacks }, runnerOptions);
        return { handle, playbackIdentitySha256, header, observed, segmentId, fromFrame,
          helperSha256: pin.sha256, drainAlgorithmId: pin.drainAlgorithmId };
      } catch (error) {
        if (error instanceof RecordingReplicaError) throw error;
        return replicaFail('BACKEND_UNAVAILABLE');
      }
    },
  };
}
export type ReplicaDeviceOutputProvider = ReturnType<typeof createReplicaDeviceOutputProvider>;
