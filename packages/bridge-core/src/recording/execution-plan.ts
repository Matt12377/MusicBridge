import { isExecutionFormat, isExecutionPcmInput, isExecutionRecipe, isFrozenPrepared, isVersionHistory, type ExecutionFormat, type ExecutionRecipe, type ExecutionPcmInput, type ExecutionSegment, type MasterVersion, type LayoutVersion, type FrozenPrepared } from '@music-bridge/contracts';
import { mediaFingerprint } from './media-store.js';
import { assessRender } from './render-conformance.js';
import { isAudioConversionSource, isAudioConversionPlan, isConvertedExecutionRecipe, conversionFrameBounds, type AudioConversionPlan, type AudioConversionSource, type ConvertedExecutionRecipe, type ConvertedExecutionSegment } from '@music-bridge/contracts';

export type ExecutionFailure = 'INVALID_INPUT' | 'VERSION_MISMATCH' | 'CONVERSION_REQUIRED' | 'UNSUPPORTED_WAVE' | 'FRAME_MISMATCH' | 'HASH_MISMATCH' | 'INPUT_CHANGED' | 'SOURCE_UNAVAILABLE' | 'IO_ERROR' | 'DISK_FULL' | 'CANCELLED' | 'LIMIT_EXCEEDED';
export class ExecutionCompileError extends Error { constructor(readonly code: ExecutionFailure) { super(code); } }
export const executionFail = (code: ExecutionFailure): never => { throw new ExecutionCompileError(code); };
export function requireCopyFormat(format: ExecutionFormat): number {
  if (!isExecutionFormat(format)) return executionFail('INVALID_INPUT');
  if (format.internalProcessingPrecision !== 'integer-bit-copy' || format.outputSampleFormat === 'pcm-f32le' || format.resamplerImplementation !== 'none' || format.resamplerVersion !== 'not-applied' || format.ditherPolicy !== 'none' || format.channelMapping !== 'identity') return executionFail('CONVERSION_REQUIRED');
  return Number(format.outputSampleFormat.slice(5,7));
}
function scale(value: number, numerator: number, denominator: number): number {
  const n = BigInt(value) * BigInt(numerator), d = BigInt(denominator), result = Number((2n * n + d) / (2n * d));
  if (!Number.isSafeInteger(result)) return executionFail('LIMIT_EXCEEDED');
  return result;
}
function checkVersions(master: MasterVersion, layout: LayoutVersion): void {
  if (!isVersionHistory({ draftId: master.draftId, masters: [master], layouts: [layout], jobs: [] }) || mediaFingerprint(master.content) !== master.contentHash || mediaFingerprint(layout.timeline) !== layout.timelineHash) return executionFail('VERSION_MISMATCH');
  for (const side of layout.timeline.sides) {
    if (side.tracks.length && (side.leadInFrames !== scale(layout.spec.leadInMs, layout.timeline.sampleRate, 1000) || side.tailFrames !== scale(layout.spec.tailMs, layout.timeline.sampleRate, 1000))) return executionFail('VERSION_MISMATCH');
    for (const [i, t] of side.tracks.entries()) {
      const source = master.sourceEvidence.find(e => e.trackId === t.trackId), content = master.content.tracks.find(c => c.trackId === t.trackId)!;
      if (!source || source.binding.id !== t.sourceBindingId || source.binding.size !== content.source.size || mediaFingerprint(source.binding.technical) !== mediaFingerprint(content.source.technical) || t.gapAfterFrames !== (i === side.tracks.length - 1 ? 0 : scale(content.transitionAfterMs, layout.timeline.sampleRate, 1000))) return executionFail('VERSION_MISMATCH');
    }
  }
}
function base(master: MasterVersion, layout: LayoutVersion, format: ExecutionFormat, side: 'A' | 'B' | 'Program'): Omit<ExecutionRecipe, 'mode' | 'totalFrames' | 'segments'> {
  return { schemaVersion: 1, compiler: 'musicbridge-pcm-copy-v1', masterVersionId: master.id, layoutVersionId: layout.id, contentHash: master.contentHash, plannedTimelineHash: layout.timelineHash, format: structuredClone(format), side, capacityFrames: layout.lengthMinutes * 60 * format.sampleRate / (layout.spec.format === 'cassette' ? 2 : 1), formalReady: false };
}
/** 可换执行时基，但不把规划的有理数换算当作已实现 SRC；输入规格不同仍明确拒绝。 */
export function planDirectExecution(master: MasterVersion, layout: LayoutVersion, format: ExecutionFormat): readonly ExecutionRecipe[] {
  checkVersions(master, layout); const bits = requireCopyFormat(format);
  return layout.timeline.sides.map(side => {
    let cursor = 0; const segments: ExecutionSegment[] = [];
    const silence = (reason: 'lead-in' | 'gap' | 'tail', frames: number): void => { if (frames) { segments.push({ kind: 'silence', reason, startFrame: cursor, endFrame: cursor + frames }); cursor += frames; } };
    if (side.tracks.length) silence('lead-in', scale(layout.spec.leadInMs, format.sampleRate, 1000));
    for (const [i, t] of side.tracks.entries()) {
      const content = master.content.tracks.find(c => c.trackId === t.trackId)!, technical = content.source.technical;
      if (technical.container !== 'WAVE' || technical.codec !== 'PCM' || technical.sampleRate !== format.sampleRate || technical.channels !== format.channelCount || technical.bitsPerSample !== bits) return executionFail('CONVERSION_REQUIRED');
      const input: ExecutionPcmInput = { sha256: content.source.sha256, size: content.source.size, sampleRate: technical.sampleRate, channelCount: format.channelCount, bitsPerSample: bits as 16 | 24 | 32, totalFrames: technical.sampleFrames };
      if (!isExecutionPcmInput(input)) return executionFail('INVALID_INPUT');
      segments.push({ kind: 'source', trackId: t.trackId, input, startFrame: cursor, endFrame: cursor + input.totalFrames }); cursor += input.totalFrames;
      if (i < side.tracks.length - 1) silence('gap', scale(content.transitionAfterMs, format.sampleRate, 1000));
    }
    if (side.tracks.length) silence('tail', scale(layout.spec.tailMs, format.sampleRate, 1000));
    const recipe: ExecutionRecipe = { ...base(master, layout, format, side.name), mode: 'direct', totalFrames: cursor, segments };
    if (!isExecutionRecipe(recipe)) return executionFail('FRAME_MISMATCH');
    return recipe;
  });
}
export function planPreparedExecution(master: MasterVersion, layout: LayoutVersion, prep: FrozenPrepared, format: ExecutionFormat, inputs: readonly { assetId: string; input: ExecutionPcmInput }[]): readonly ExecutionRecipe[] {
  checkVersions(master, layout); requireCopyFormat(format);
  checkPreparedVersions(master, layout, prep);
  if (inputs.length !== prep.assets.length || new Set(inputs.map(i => i.assetId)).size !== inputs.length) return executionFail('VERSION_MISMATCH');
  return prep.renderTimeline.sides.map(side => {
    const segments: ExecutionSegment[] = [];
    if (side.totalFrames) {
      const asset = prep.assets.find(a => a.id === side.renderAssetId), supplied = inputs.find(i => i.assetId === side.renderAssetId);
      if (!asset || !supplied || !isExecutionPcmInput(supplied.input) || supplied.input.sha256 !== asset.sha256 || supplied.input.size !== asset.size || supplied.input.sampleRate !== side.sampleRate || supplied.input.channelCount !== (side.channelLayout === 'mono' ? 1 : 2) || supplied.input.totalFrames !== side.totalFrames) return executionFail('VERSION_MISMATCH');
      if (supplied.input.sampleRate !== format.sampleRate || supplied.input.channelCount !== format.channelCount || supplied.input.bitsPerSample !== requireCopyFormat(format)) return executionFail('CONVERSION_REQUIRED');
      segments.push({ kind: 'render', renderAssetId: asset.id, input: structuredClone(supplied.input), startFrame: 0, endFrame: side.totalFrames });
    }
    const recipe: ExecutionRecipe = { ...base(master, layout, format, side.name), mode: 'prepared-reference', prepared: { id: prep.id, renderTimelineHash: prep.renderTimelineHash }, totalFrames: side.totalFrames, segments };
    if (!isExecutionRecipe(recipe)) return executionFail('FRAME_MISMATCH');
    return recipe;
  });
}
function checkPreparedVersions(master: MasterVersion, layout: LayoutVersion, prep: FrozenPrepared): void {
  if (!isFrozenPrepared(prep) || prep.masterVersionId !== master.id || prep.layoutVersionId !== layout.id || prep.draftId !== master.draftId || prep.contentHash !== master.contentHash || prep.plannedTimelineHash !== layout.timelineHash || mediaFingerprint(prep.plannedTimeline) !== layout.timelineHash || mediaFingerprint(prep.renderTimeline) !== prep.renderTimelineHash) return executionFail('VERSION_MISMATCH');
  const conformance = assessRender(master, layout, prep.assets, { timeline: prep.renderTimeline, structureChanged: false, acceptVariance: prep.conformance.status === 'ACCEPTED_VARIANCE', varianceReason: prep.varianceReason });
  if (conformance.status !== prep.conformance.status || !['MATCHED','ACCEPTED_VARIANCE'].includes(conformance.status)) return executionFail('VERSION_MISMATCH');
}
type ConversionPlanner = (source: AudioConversionSource, format: ExecutionFormat) => AudioConversionPlan;
function conversionFor(source: AudioConversionSource, format: ExecutionFormat, makePlan: ConversionPlanner): AudioConversionPlan {
  if (!isAudioConversionSource(source) || !isExecutionFormat(format)) return executionFail('INVALID_INPUT');
  const mapped: ExecutionFormat = { ...structuredClone(format), channelMapping: source.technical.channels === format.channelCount ? 'identity' : source.technical.channels === 1 ? 'mono-to-stereo' : 'stereo-to-mono' };
  const result = makePlan(structuredClone(source), structuredClone(mapped));
  if (!isAudioConversionPlan(result) || mediaFingerprint(result.input) !== mediaFingerprint(source) || mediaFingerprint(result.format) !== mediaFingerprint(mapped)) return executionFail('INVALID_INPUT');
  return structuredClone(result);
}
function convertedRecipe(master: MasterVersion, layout: LayoutVersion, format: ExecutionFormat, side: ConvertedExecutionRecipe['side'], segments: readonly ConvertedExecutionSegment[], prepared?: ConvertedExecutionRecipe['prepared']): ConvertedExecutionRecipe {
  let minimumFrames = 0, maximumFrames = 0;
  for (const segment of segments) {
    const bounds = segment.kind === 'silence' ? { minimum: segment.frames, maximum: segment.frames } : conversionFrameBounds(segment.conversion);
    minimumFrames += bounds.minimum; maximumFrames += bounds.maximum;
  }
  const recipe: ConvertedExecutionRecipe = { ...base(master, layout, format, side), schemaVersion: 2, compiler: 'musicbridge-conversion-v2', mode: prepared ? 'prepared-derivative' : 'direct', ...(prepared ? { prepared } : {}), minimumFrames, maximumFrames, segments };
  if (!isConvertedExecutionRecipe(recipe)) return executionFail('FRAME_MISMATCH');
  return recipe;
}
/** 源计划保留原容器/Hash；只在每条转换计划上明确选择所需声道映射。 */
export function planConvertedDirectExecution(master: MasterVersion, layout: LayoutVersion, format: ExecutionFormat, makePlan: ConversionPlanner): readonly ConvertedExecutionRecipe[] {
  checkVersions(master, layout); if (!isExecutionFormat(format)) return executionFail('INVALID_INPUT');
  return layout.timeline.sides.map(side => {
    const segments: ConvertedExecutionSegment[] = [];
    const silence = (reason: 'lead-in' | 'gap' | 'tail', ms: number): void => { const frames = scale(ms, format.sampleRate, 1000); if (frames) segments.push({ kind: 'silence', reason, frames }); };
    if (side.tracks.length) silence('lead-in', layout.spec.leadInMs);
    for (const [i,track] of side.tracks.entries()) {
      const content = master.content.tracks.find(t => t.trackId === track.trackId)!;
      segments.push({ kind: 'source', trackId: track.trackId, conversion: conversionFor(content.source, format, makePlan) });
      if (i < side.tracks.length - 1) silence('gap', content.transitionAfterMs);
    }
    if (side.tracks.length) silence('tail', layout.spec.tailMs);
    return convertedRecipe(master, layout, format, side.name, segments);
  });
}
/** 原 Render 的技术证据必须来自文件核验；不借目标 Profile 的位深填充源证据。 */
export function planPreparedDerivative(master: MasterVersion, layout: LayoutVersion, prep: FrozenPrepared, format: ExecutionFormat, inputs: readonly { assetId: string; source: AudioConversionSource }[], makePlan: ConversionPlanner): readonly ConvertedExecutionRecipe[] {
  checkVersions(master, layout); checkPreparedVersions(master, layout, prep);
  if (!isExecutionFormat(format) || inputs.length !== prep.assets.length || new Set(inputs.map(i => i.assetId)).size !== inputs.length) return executionFail('VERSION_MISMATCH');
  return prep.renderTimeline.sides.map(side => {
    const segments: ConvertedExecutionSegment[] = [];
    if (side.totalFrames) {
      const asset = prep.assets.find(a => a.id === side.renderAssetId), supplied = inputs.find(i => i.assetId === side.renderAssetId);
      if (!asset || !supplied || !isAudioConversionSource(supplied.source) || supplied.source.sha256 !== asset.sha256 || supplied.source.size !== asset.size || supplied.source.technical.container !== 'WAVE' || supplied.source.technical.sampleRate !== side.sampleRate || supplied.source.technical.channels !== (side.channelLayout === 'mono' ? 1 : 2) || supplied.source.technical.sampleFrames !== side.totalFrames) return executionFail('VERSION_MISMATCH');
      segments.push({ kind: 'render', renderAssetId: asset.id, conversion: conversionFor(supplied.source, format, makePlan) });
    }
    return convertedRecipe(master, layout, format, side.name, segments, { id: prep.id, renderTimelineHash: prep.renderTimelineHash });
  });
}
