import type { FileHandle } from 'node:fs/promises';
import type { ExecutionAssetAudio, ExecutionFormat, RecordingOutputCheckRequest, RecordingPlanVersion } from '@music-bridge/contracts';
import { RecordingPlanError, planSame, recordingPlanContent, type RecordingPlanInput } from './plan-integrity.js';
import type { RecordingPlanStore } from './plan-store.js';
import { withVerifiedReadonlySource, withVerifiedReadonlyReplicaSource, SourceFileError } from './source-files.js';
import { checkPreparationOwnership, verifyPublishedPreparation, type OwnedPreparation } from './preparation-files.js';
import { verifyArchiveObjects } from './archive-files.js';
import { inspectConversionOutput } from './execution-wave.js';
import { ExecutionCompileError } from './execution-plan.js';
import { OutputCheckError, outputCheckFail } from './output-error.js';
import { createReadonlyAudioConsumer, readonlyAudioReader, type ReadonlyAudioConsumer, type ReadonlyAudioReader } from './readonly-audio-consumer.js';

export interface RecordingOutputRunner {
  /** 成功、取消或失败均必须等子进程close之后settle；句柄租期由调用方管理。 */
  run(request: {
    handle: FileHandle; format: ExecutionFormat; audio: ExecutionAssetAudio['audio']; signal: AbortSignal; checkOperation: () => void;
    identity: { runId: string; planVersionId: string; assetId: string; planContentHash: string; recipeHash: string };
  }): Promise<{ consumedFrames: number; pcmSha256: string; helperSha256: string }>;
}
export interface RecordingOutputInput {
  plan: RecordingPlanVersion; facts: RecordingPlanInput; receipt: ExecutionAssetAudio; owned: OwnedPreparation; relative: string;
}

/** 受控provider只见不可写的独立视图，不持有FD，也不能提前释放租期。 */
export interface RecordingOutputProviderInput {
  /** 包含输入身份/授权漂移、有限租期超时及调用方取消。 */
  readonly signal: AbortSignal;
  readonly audio: Readonly<ExecutionAssetAudio['audio']>;
  readonly format: Readonly<ExecutionFormat>;
  readonly consumer: ReadonlyAudioReader;
  checkOperation(): void;
}

/** FD只存在于闭包中；Core在软件静止后负责末核验和关闭。 */
export interface RecordingOutputInputLease {
  readonly signal: AbortSignal;
  readonly provider: RecordingOutputProviderInput;
  /** 必须在driver.close证明软件静止（或start拒绝已自行收口）后调用。 */
  release(): Promise<'verified' | 'cancelled'>;
}

/** 只读取已冻结计划及其私有谱系；不取最新资产、不迁移或恢复任务。 */
export function captureRecordingOutput(store: RecordingPlanStore, request: RecordingOutputCheckRequest): RecordingOutputInput {
  let plan: RecordingPlanVersion | null;
  try { plan = store.version({ id: request.planVersionId }).plan; }
  catch { return outputCheckFail('PLAN_UNAVAILABLE'); }
  if (!plan) return outputCheckFail('PLAN_UNAVAILABLE');
  let facts: RecordingPlanInput;
  try {
    facts = store.capture({ assetId: plan.execution.assetId, archiveOperationId: plan.archive.operationId }, plan.profileSnapshot);
    // 当前设备绝不反填旧计划；新计划仅把自身已冻结的输出绑定用于历史材料比对。
    if (!planSame({ ...facts.material, ...(plan.outputBinding ? { outputBinding: plan.outputBinding } : {}) }, recordingPlanContent(plan))) return outputCheckFail('PLAN_CHANGED');
  } catch (error) {
    if (error instanceof OutputCheckError) throw error;
    return outputCheckFail(error instanceof RecordingPlanError ? 'PLAN_CHANGED' : 'PLAN_UNAVAILABLE');
  }
  const matches = plan.execution.audio.filter(receipt => receipt.recipe.side === request.side);
  if (matches.length !== 1) return outputCheckFail('EMPTY_SIDE');
  const receipt = matches[0]!, retained = receipt.origin === 'retained-render';
  const owned = retained ? facts.job.input.retained?.owned : facts.job.owned;
  const files = retained ? facts.job.input.retained?.files : facts.job.files;
  const relative = retained ? `Originals/${request.side}.wav` : `Audio/${request.side}.${receipt.origin === 'derived-render' ? 'derivative' : 'execution'}.wav`;
  if (!owned || !files || files.filter(file => file.relative === relative && file.sha256 === receipt.audio.sha256 && file.size === receipt.audio.size).length !== 1) return outputCheckFail('INPUT_UNAVAILABLE');
  return { plan, facts, receipt, owned, relative };
}

/** 发布/归档证明需重新读文件；boolean核验不作为输出句柄租期。 */
export async function verifyRecordingOutputDependencies(input: RecordingOutputInput, signal: AbortSignal, check: () => void): Promise<void> {
  try {
    check();
    for (const { root, binding } of input.facts.sources) await withVerifiedReadonlySource(root, binding.relative, binding.evidence, signal, async () => undefined, check);
    const job = input.facts.job;
    if (!await verifyPublishedPreparation(job.owned!, job.files, job.manifestHash!, signal)) { check(); return outputCheckFail('INPUT_UNAVAILABLE'); }
    if (job.input.retained && !await verifyPublishedPreparation(job.input.retained.owned, job.input.retained.files, job.input.retained.manifestHash, signal)) { check(); return outputCheckFail('INPUT_UNAVAILABLE'); }
    await verifyArchiveObjects(input.facts.archive, signal); check();
  } catch (error) {
    check(); if (error instanceof OutputCheckError) throw error;
    return outputCheckFail(error instanceof SourceFileError && ['CONTENT_CHANGED', 'HASH_MISMATCH'].includes(error.code) ? 'INPUT_CHANGED' : 'INPUT_UNAVAILABLE');
  }
}

/** callback返回后仍需完成源句柄的末核验；不能在callback里发布成功回执。 */
export async function withRecordingOutputInput<T>(input: RecordingOutputInput, signal: AbortSignal, check: () => void, consume: (handle: FileHandle, check: () => void) => Promise<T>): Promise<T> {
  try {
    check(); await checkPreparationOwnership(input.owned);
    const result = await withVerifiedReadonlySource(input.owned.root, input.relative, input.receipt.audio, signal, async (handle, sourceCheck) => {
      const checked = () => { check(); sourceCheck(); };
      const actual = await inspectConversionOutput(handle, input.plan.profileSnapshot.settings.format, signal, checked);
      if (!planSame(actual, input.receipt.audio)) return outputCheckFail('INPUT_CHANGED');
      checked(); return consume(handle, checked);
    }, check);
    await checkPreparationOwnership(input.owned); check(); return result;
  } catch (error) {
    check(); if (error instanceof OutputCheckError) throw error;
    if (error instanceof SourceFileError && ['CONTENT_CHANGED', 'HASH_MISMATCH'].includes(error.code)) return outputCheckFail('INPUT_CHANGED');
    return outputCheckFail(error instanceof ExecutionCompileError ? 'FORMAT_MISMATCH' : 'INPUT_UNAVAILABLE');
  }
}

/** 把原有完整校验与末核验转为长寿命私有租期；release之前FD始终归Core持有。 */
export async function acquireRecordingOutputInputLease(input: RecordingOutputInput, signal: AbortSignal, check: () => void): Promise<RecordingOutputInputLease> {
  let announced = false;
  let announce!: (value: { signal: AbortSignal; checkOperation: () => void; consumer: ReadonlyAudioConsumer }) => void;
  let rejectAnnounce!: (error: unknown) => void;
  const ready = new Promise<{ signal: AbortSignal; checkOperation: () => void; consumer: ReadonlyAudioConsumer }>((resolve, reject) => { announce = resolve; rejectAnnounce = reject; });
  let resume!: () => void;
  const held = new Promise<void>(resolve => { resume = resolve; });
  const { frameCount } = input.receipt.audio, { sampleRate, channelCount, outputSampleFormat } = input.plan.profileSnapshot.settings.format;
  const durationMs = Number((BigInt(frameCount) * 1000n + BigInt(sampleRate) - 1n) / BigInt(sampleRate));
  if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 6 * 60 * 60_000) return outputCheckFail('FORMAT_MISMATCH');
  const task = (async (): Promise<'verified' | 'cancelled'> => {
    try {
      check(); await checkPreparationOwnership(input.owned);
      await withVerifiedReadonlyReplicaSource(input.owned.root, input.relative, input.receipt.audio, signal,
        async (handle, checked, leaseSignal) => {
          const consumer = createReadonlyAudioConsumer(handle, { dataOffset: input.receipt.audio.dataOffset, frameCount, channelCount, sampleFormat: outputSampleFormat }, leaseSignal, checked);
          announced = true;
          announce({ signal: leaseSignal, checkOperation: checked, consumer });
          await held;
        }, check, {
          durationMs,
          verify: async (handle, checked, leaseSignal) => {
            const actual = await inspectConversionOutput(handle, input.plan.profileSnapshot.settings.format, leaseSignal, checked);
            if (!planSame(actual, input.receipt.audio)) return outputCheckFail('INPUT_CHANGED');
            await checkPreparationOwnership(input.owned); checked();
          },
          finalize: async (_handle, checked) => { await checkPreparationOwnership(input.owned); checked(); },
        });
      return 'verified';
    } catch (error) {
      if (error instanceof SourceFileError && ['CONTENT_CHANGED', 'HASH_MISMATCH'].includes(error.code)) return outputCheckFail('INPUT_CHANGED');
      if (error instanceof OutputCheckError && error.code === 'INPUT_CHANGED') throw error;
      if (signal.aborted) return 'cancelled';
      if (error instanceof OutputCheckError) throw error;
      return outputCheckFail(error instanceof ExecutionCompileError ? 'FORMAT_MISMATCH' : 'INPUT_UNAVAILABLE');
    }
  })();
  // 预检失败或取消可能发生在announce之前；两种结果都不能让ready悬空。
  void task.then(() => { if (!announced) rejectAnnounce(new OutputCheckError('CANCELLED')); }, rejectAnnounce);
  const value = await ready;
  let released: Promise<'verified' | 'cancelled'> | undefined;
  const provider = Object.freeze({
    signal: value.signal,
    audio: Object.freeze(structuredClone(input.receipt.audio)),
    format: Object.freeze(structuredClone(input.plan.profileSnapshot.settings.format)),
    consumer: readonlyAudioReader(value.consumer),
    checkOperation: value.checkOperation,
  } satisfies RecordingOutputProviderInput);
  return {
    signal: value.signal,
    provider,
    release() {
      if (!released) {
        value.consumer.revoke();
        resume();
        released = task;
      }
      return released;
    },
  };
}
