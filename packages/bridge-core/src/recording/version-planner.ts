import { isMasterDraft, isSourceBinding, type MasterDraft, type DraftSourceSnapshot, type MediaLayoutSpec } from '@music-bridge/contracts';
import type { MasterContent, VersionMaterial, VersionTimeline } from '@music-bridge/contracts';
import { BridgeError } from '../shared/errors.js';
import { resolveMediaLayout } from './media-planner.js';
import { mediaFingerprint } from './media-store.js';

const invalid = (message: string): never => { throw new BridgeError('BAD_REQUEST', message, { httpStatus: 400 }); };
/** 固定整数有理数换算，避免浮点累计漂移；实际编译必须验证输出帧数吻合此规划。 */
function frames(value: number, numerator: number, denominator: number): number {
  const scaled = BigInt(value) * BigInt(numerator), divisor = BigInt(denominator);
  const result = Number((scaled * 2n + divisor) / (divisor * 2n));
  if (!Number.isSafeInteger(result)) return invalid('时间线帧数超出支持范围。');
  return result;
}
export function planVersions(draft: MasterDraft, sources: DraftSourceSnapshot['tracks'], spec: MediaLayoutSpec, sampleRate: number, lengthMinutes: number): VersionMaterial {
  if (!isMasterDraft(draft) || !Number.isSafeInteger(sampleRate) || sampleRate < 8000 || sampleRate > 384000 || !Number.isSafeInteger(lengthMinutes) || lengthMinutes < 1 || lengthMinutes > 360) return invalid('母版时基、容量或草稿无效。');
  const rules = new Map(spec.rules.map(r => [r.trackId, r]));
  const content: MasterContent = { programType: draft.programType, tracks: draft.tracks.map(track => {
    const binding = sources.find(source => source.trackId === track.id)?.binding;
    if (!binding || !isSourceBinding(binding) || !binding.sourceLockEligible || !binding.technical.sampleFrames || binding.technical.frameEvidence !== 'container-declared') return invalid('每首曲目都需要可用、人工确认并带精确帧数的源证据，请重新校验。');
    const rule = rules.get(track.id);
    return { trackId: track.id, metadata: structuredClone(track.metadata), source: { sha256: binding.sha256, size: binding.size, technical: { ...binding.technical, sampleFrames: binding.technical.sampleFrames, frameEvidence: 'container-declared' as const } }, transitionAfterMs: rule?.gapAfterMs ?? spec.defaultGapMs, keepWithNext: rule?.keepWithNext ?? false };
  }) };
  const layout = resolveMediaLayout(content.tracks.map(t => ({ trackId: t.trackId, durationMs: t.source.technical.durationMs, basis: 'verified-sources' })), spec);
  if (layout.constraints.length) return invalid('分面约束尚未满足，不能冻结。');
  const capacityFrames = frames(lengthMinutes * 60, sampleRate, spec.format === 'cassette' ? 2 : 1);
  const timeline: VersionTimeline = { timebase: 'sample-frames', sampleRate, rounding: 'nearest-half-up-v1', sides: layout.sides.map(side => {
    const leadInFrames = frames(side.leadInMs, sampleRate, 1000), tailFrames = frames(side.tailMs, sampleRate, 1000);
    let cursor = leadInFrames;
    const tracks = side.tracks.map(t => {
      const source = content.tracks.find(c => c.trackId === t.trackId)!.source.technical;
      const startFrame = cursor, endFrame = cursor + frames(source.sampleFrames, sampleRate, source.sampleRate), gapAfterFrames = frames(t.gapAfterMs, sampleRate, 1000);
      cursor = endFrame + gapAfterFrames;
      return { trackId: t.trackId, sourceBindingId: sources.find(s => s.trackId === t.trackId)!.binding!.id, sourceSampleRate: source.sampleRate, sourceFrames: source.sampleFrames, startFrame, endFrame, gapAfterFrames };
    });
    const totalFrames = cursor + tailFrames;
    if (!Number.isSafeInteger(totalFrames) || totalFrames > capacityFrames) return invalid('精确帧数超过此面或连续段容量，请调整分面或选择其他介质。');
    return { name: side.name, capacityFrames, leadInFrames, tailFrames, totalFrames, tracks };
  }) };
  return { content, contentHash: mediaFingerprint(content), timeline, timelineHash: mediaFingerprint(timeline), executionReady: false };
}
