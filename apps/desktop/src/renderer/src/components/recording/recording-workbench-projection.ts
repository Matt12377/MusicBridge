import type { MediaLayoutSpec } from '@music-bridge/contracts'

/** 当前盘只投影自己的曲目；分盘谱系不再吻合完整母版时退回全量视图并标记失效。 */
export function projectWorkbenchSegment(spec: MediaLayoutSpec, allTrackIds: readonly string[]): {
  trackIds: readonly string[]; segmentIndex?: number; segmentCount?: number; invalid: boolean
} {
  const distribution = spec.distribution
  if (!distribution) return { trackIds: allTrackIds, invalid: false }
  const flattened = distribution.segmentSpecs.flatMap(segment => segment.trackIds)
  const segment = distribution.segmentSpecs[distribution.segmentIndex]
  if (!segment || flattened.length !== allTrackIds.length || flattened.some((id, index) => id !== allTrackIds[index])) {
    return { trackIds: allTrackIds, invalid: true }
  }
  return { trackIds: segment.trackIds, segmentIndex: distribution.segmentIndex, segmentCount: distribution.segmentSpecs.length, invalid: false }
}

/** 只修改当前未保存编辑稿；已存规划、预留与冻结历史完全不动。 */
export function releaseWorkbenchDistribution(spec: MediaLayoutSpec, trackCount: number): MediaLayoutSpec {
  const next = structuredClone(spec)
  delete next.distribution
  next.rules = []
  next.splitAfter = next.format === 'dat' ? 0 : Math.max(1, Math.ceil(trackCount / 2))
  return next
}
