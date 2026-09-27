import {
  isLayoutVersion, isMasterVersion, isMediaDistributionSpec,
  isVersionHistory, type FrozenDistribution, type LayoutVersion, type MasterVersion, type MediaDistributionSpec, type VersionHistory,
} from '@music-bridge/contracts';
import { mediaFingerprint } from './media-store.js';

export type VerifiedVersionDistribution =
  | { kind: 'legacy'; trackIds: readonly string[] }
  | { kind: 'segmented'; trackIds: readonly string[]; distributionHash: string; segmentIndex: number };

const sameIds = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index]);
const sameSegments = (left: MediaDistributionSpec['segmentSpecs'], right: MediaDistributionSpec['segmentSpecs']): boolean =>
  left.length === right.length && left.every((segment, index) => sameIds(segment.trackIds, right[index]!.trackIds));

/** 摘要绑定完整 Master 与全组分段，不含任何 Layout ID 或本盘 index。 */
export function frozenDistributionHash(value: Pick<FrozenDistribution, 'schemaVersion' | 'groupId' | 'masterVersionId' | 'contentHash' | 'segmentSpecs'>): string {
  return mediaFingerprint({ schemaVersion: value.schemaVersion, groupId: value.groupId, masterVersionId: value.masterVersionId,
    contentHash: value.contentHash, segmentSpecs: value.segmentSpecs });
}

export function freezeMediaDistribution(master: MasterVersion, plan: MediaDistributionSpec): FrozenDistribution | null {
  if (!isMasterVersion(master) || mediaFingerprint(master.content) !== master.contentHash || !isMediaDistributionSpec(plan)) return null;
  const ordered = plan.segmentSpecs.flatMap(segment => segment.trackIds), content = master.content.tracks;
  if (!sameIds(ordered, content.map(track => track.trackId))) return null;
  let boundary = 0;
  for (const segment of plan.segmentSpecs.slice(0, -1)) {
    boundary += segment.trackIds.length;
    if (content[boundary - 1]?.keepWithNext) return null;
  }
  const value = { schemaVersion: 1 as const, groupId: plan.groupId, segmentIndex: plan.segmentIndex,
    segmentSpecs: structuredClone(plan.segmentSpecs), masterVersionId: master.id, contentHash: master.contentHash };
  return { ...value, distributionHash: frozenDistributionHash(value) };
}

/** 每一盘单独验完整分布，不依赖另一盘 Layout 是否已冻结。 */
export function verifyFrozenDistribution(master: MasterVersion, layout: LayoutVersion): VerifiedVersionDistribution | null {
  if (!isMasterVersion(master) || !isLayoutVersion(layout) || master.id !== layout.masterVersionId || master.draftId !== layout.draftId
    || mediaFingerprint(master.content) !== master.contentHash || mediaFingerprint(layout.timeline) !== layout.timelineHash) return null;
  const actual = layout.timeline.sides.flatMap(side => side.tracks), content = master.content.tracks;
  if (!layout.distribution) {
    if (layout.spec.distribution || !sameIds(actual.map(track => track.trackId), content.map(track => track.trackId))) return null;
    if (actual.some((track, index) => track.sourceFrames !== content[index]?.source.technical.sampleFrames
      || track.sourceSampleRate !== content[index]?.source.technical.sampleRate)) return null;
    return { kind: 'legacy', trackIds: content.map(track => track.trackId) };
  }
  const frozen = freezeMediaDistribution(master, layout.spec.distribution!);
  const stored = layout.distribution;
  if (!frozen || stored.masterVersionId !== frozen.masterVersionId || stored.contentHash !== frozen.contentHash
    || stored.distributionHash !== frozen.distributionHash || stored.groupId !== frozen.groupId
    || stored.segmentIndex !== frozen.segmentIndex || !sameSegments(stored.segmentSpecs, frozen.segmentSpecs)) return null;
  const assigned = stored.segmentSpecs[stored.segmentIndex]!.trackIds;
  if (!sameIds(actual.map(track => track.trackId), assigned) || actual.some(track => {
    const source = content.find(item => item.trackId === track.trackId)?.source.technical;
    return !source || track.sourceFrames !== source.sampleFrames || track.sourceSampleRate !== source.sampleRate;
  })) return null;
  return { kind: 'segmented', trackIds: assigned, distributionHash: stored.distributionHash, segmentIndex: stored.segmentIndex };
}

/** 读取不可变历史时复算每盘摘要，并核对同组跨盘的完整 Master 与分段边界。 */
export function verifyVersionHistoryDistribution(history: VersionHistory): boolean {
  if (!isVersionHistory(history)) return false;
  const masters = new Map(history.masters.map(master => [master.id, master]));
  const groups = new Map<string, string>();
  for (const layout of history.layouts) {
    const master = masters.get(layout.masterVersionId);
    if (!master) return false;
    const verified = verifyFrozenDistribution(master, layout);
    if (!verified) return false;
    if (verified.kind === 'segmented') {
      const groupId = layout.distribution!.groupId, prior = groups.get(groupId);
      if (prior && prior !== verified.distributionHash) return false;
      groups.set(groupId, verified.distributionHash);
    }
  }
  return true;
}

/** 复用旧组必须复用同一完整 Master 与完整分段快照；本盘 index 不参与组摘要。 */
export function frozenGroupMatchesHistory(history: VersionHistory, plan: MediaDistributionSpec, contentHash: string): boolean {
  const peers = history.layouts.filter(layout => layout.distribution?.groupId === plan.groupId);
  if (!peers.length) return true;
  const master = history.masters.find(item => item.contentHash === contentHash);
  const proposed = master ? freezeMediaDistribution(master, plan) : null;
  return !!proposed && peers.every(layout => layout.distribution?.distributionHash === proposed.distributionHash);
}
