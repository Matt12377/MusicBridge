import { isRenderAssessment, isRawRenderAsset, type MasterVersion, type LayoutVersion, type RawRenderAsset, type RenderAssessment, type RenderConformance, type RenderConformanceStatus, type RenderConformanceReason, type FrozenPrepared } from '@music-bridge/contracts';

export function assessRender(master: MasterVersion, layout: LayoutVersion, assets: readonly RawRenderAsset[], assessment: RenderAssessment): RenderConformance {
  const result = (status: RenderConformanceStatus, ...reasons: RenderConformanceReason[]): RenderConformance => ({ status, policy: 'one-render-frame-v1', reasons });
  if (!isRenderAssessment(assessment)) return result('REJECTED', 'INVALID_TIMELINE');
  const sides = assessment.timeline.sides;
  if (sides.some(s => s.totalFrames === 0 && s.sampleRate !== layout.timeline.sampleRate)) return result('REJECTED', 'INVALID_TIMELINE');
  const rendered = sides.filter(s => s.totalFrames > 0);
  if (assets.length !== rendered.length || !assets.every(isRawRenderAsset) || new Set(assets.map(a => a.id)).size !== assets.length || new Set(assets.map(a => a.side)).size !== assets.length || rendered.some(s => !assets.some(a => a.id === s.renderAssetId && a.side === s.name && a.sha256 === s.renderFileHash && a.sampleRate === s.sampleRate && a.channelLayout === s.channelLayout && a.totalFrames === s.totalFrames))) return result('REJECTED', 'RENDER_IDENTITY_MISMATCH');
  const actual = sides.flatMap(s => s.markers), expected = master.content.tracks;
  if (actual.some(m => !m.userConfirmed || m.confirmationMethod !== 'manual')) return result('REJECTED', 'MARKERS_UNCONFIRMED');
  if (assessment.contentIdentityChanged || actual.length !== expected.length || actual.some((m, i) => m.trackId !== expected[i]!.trackId || m.exactSourceSha256 !== expected[i]!.source.sha256)) return result('REQUIRES_NEW_MASTER', 'CONTENT_OR_ORDER_CHANGED');
  if (assessment.structureChanged || sides.length !== layout.timeline.sides.length || sides.some((s, i) => s.name !== layout.timeline.sides[i]!.name || s.markers.length !== layout.timeline.sides[i]!.tracks.length || s.markers.some((m, j) => m.trackId !== layout.timeline.sides[i]!.tracks[j]!.trackId))) return result('REQUIRES_NEW_LAYOUT', 'SIDE_OR_STRUCTURE_CHANGED');
  const plannedRate = BigInt(layout.timeline.sampleRate);
  if (sides.some((s, i) => BigInt(s.totalFrames) * plannedRate > BigInt(layout.timeline.sides[i]!.capacityFrames) * BigInt(s.sampleRate))) return result('REQUIRES_NEW_LAYOUT', 'CAPACITY_EXCEEDED');
  const variance = sides.some((s, i) => {
    const planned = layout.timeline.sides[i]!, renderRate = BigInt(s.sampleRate);
    const differs = (a: number, p: number): boolean => { const difference = BigInt(a) * plannedRate - BigInt(p) * renderRate; return (difference < 0n ? -difference : difference) > plannedRate; };
    return differs(s.totalFrames, planned.totalFrames) || s.markers.some((m, j) => { const e = planned.tracks[j]!; return differs(m.actualStartFrame, e.startFrame) || differs(m.actualEndFrame, e.endFrame) || differs(m.actualGapToNextFrames, e.gapAfterFrames); });
  });
  if (!variance) return result('MATCHED');
  return assessment.acceptVariance && assessment.varianceReason.trim().length > 0 ? result('ACCEPTED_VARIANCE', 'TIMING_VARIANCE') : result('REJECTED', 'VARIANCE_NOT_ACCEPTED');
}

/** 兼容性是相对于某个版本的查询；不会反向改写旧 PREP 的有效性。 */
export function preparedCompatibility(prep: FrozenPrepared, current: { masterVersionId: string; layoutVersionId: string }): 'COMPATIBLE' | 'DIFFERENT_MASTER' | 'DIFFERENT_LAYOUT' {
  return prep.masterVersionId !== current.masterVersionId ? 'DIFFERENT_MASTER' : prep.layoutVersionId !== current.layoutVersionId ? 'DIFFERENT_LAYOUT' : 'COMPATIBLE';
}
