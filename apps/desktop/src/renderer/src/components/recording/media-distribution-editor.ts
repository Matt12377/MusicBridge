import type { MediaDistributionSpec, MediaLayoutSpec } from '@music-bridge/contracts'

/** 分盘边界以完整草稿的曲序计数；不会重排、漏掉或重复任何曲目。 */
export function distributionBoundaries(distribution: MediaDistributionSpec): number[] {
  let total = 0
  return distribution.segmentSpecs.slice(0, -1).map(segment => (total += segment.trackIds.length))
}

export function makeDistribution(trackIds: readonly string[], boundaries: readonly number[], groupId: string, segmentIndex = 0): MediaDistributionSpec | null {
  if (trackIds.length < 2 || trackIds.length > 200 || new Set(trackIds).size !== trackIds.length || boundaries.length < 1 || boundaries.length > 19
    || boundaries.some((value, index) => !Number.isSafeInteger(value) || value < 1 || value >= trackIds.length || index > 0 && value <= boundaries[index - 1]!)) return null
  const points = [0, ...boundaries, trackIds.length]
  const segmentSpecs = points.slice(1).map((end, index) => ({ trackIds: trackIds.slice(points[index]!, end) }))
  if (segmentIndex < 0 || segmentIndex >= segmentSpecs.length) return null
  return { schemaVersion: 1, groupId, segmentIndex, segmentSpecs }
}

export function assignedTrackIds(spec: MediaLayoutSpec, allTrackIds: readonly string[]): readonly string[] {
  return spec.distribution?.segmentSpecs[spec.distribution.segmentIndex]?.trackIds ?? allTrackIds
}
