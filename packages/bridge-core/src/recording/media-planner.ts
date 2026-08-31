import { isCollectionId, isMediaLayoutSpec, type MediaLayoutSpec, type MediaLayout, type MediaTimingTrack, type MediaPlannedTrack, type MediaSide, type MediaCandidate, type MediaCandidateReason, type MediaSourceBasis } from '@music-bridge/contracts';
import { BridgeError } from '../shared/errors.js';

const invalid = (message: string): never => { throw new BridgeError('BAD_REQUEST', message, { httpStatus: 400 }); };
function validate(tracks: readonly MediaTimingTrack[], spec: MediaLayoutSpec): void {
  if (!isMediaLayoutSpec(spec) || !Array.isArray(tracks) || tracks.length < 1 || tracks.length > 200 || tracks.some(t => !isCollectionId(t.trackId) || t.durationMs !== undefined && (!Number.isSafeInteger(t.durationMs) || t.durationMs < 1 || t.durationMs > 86_400_000)) || new Set(tracks.map(t => t.trackId)).size !== tracks.length) return invalid('分面输入无效或草稿尚无曲目。');
  if (spec.format === 'cassette' && spec.splitAfter > tracks.length) return invalid('分界超出当前草稿曲目范围。');
  if (spec.rules.some(rule => !tracks.some(track => track.trackId === rule.trackId))) return invalid('分面约束包含已不在草稿中的曲目，请重新确认。');
}

/** 仅做带明确毫秒时基的规划，不生成冻结版本或正式执行帧。 */
export function resolveMediaLayout(tracks: readonly MediaTimingTrack[], spec: MediaLayoutSpec): MediaLayout {
  validate(tracks, spec);
  const rules = new Map(spec.rules.map(rule => [rule.trackId, rule])), constraints: string[] = [];
  const parts = spec.format === 'dat' ? [{ name: 'Program' as const, tracks }] : [{ name: 'A' as const, tracks: tracks.slice(0, spec.splitAfter) }, { name: 'B' as const, tracks: tracks.slice(spec.splitAfter) }];
  const sides: MediaSide[] = parts.map(part => {
    if (!part.tracks.length) return { name: part.name, tracks: [], musicMs: 0, gapMs: 0, leadInMs: 0, tailMs: 0, durationMs: 0 };
    let cursor: number | undefined = spec.leadInMs, musicMs: number | undefined = 0, gapMs = 0;
    const positions: MediaPlannedTrack[] = part.tracks.map((track, index) => {
      const rule = rules.get(track.trackId), last = index === part.tracks.length - 1;
      if (rule?.forceSide && rule.forceSide !== part.name) constraints.push(`曲目 ${tracks.indexOf(track) + 1} 的指定面不满足。`);
      if (rule?.sideOpener && index !== 0) constraints.push(`曲目 ${tracks.indexOf(track) + 1} 必须作为本面/段首曲。`);
      if (rule?.sideCloser && !last) constraints.push(`曲目 ${tracks.indexOf(track) + 1} 必须作为本面/段末曲。`);
      if (rule?.keepWithNext && last && tracks.indexOf(track) < tracks.length - 1) constraints.push(`曲目 ${tracks.indexOf(track) + 1} 与下一首不能分开。`);
      const gapAfterMs = last ? 0 : rule?.gapAfterMs ?? spec.defaultGapMs;
      const startMs = cursor;
      const endMs: number | undefined = cursor === undefined || track.durationMs === undefined ? undefined : cursor + track.durationMs;
      musicMs = musicMs === undefined || track.durationMs === undefined ? undefined : musicMs + track.durationMs;
      cursor = endMs === undefined ? undefined : endMs + gapAfterMs; gapMs += gapAfterMs;
      return { trackId: track.trackId, ...(startMs !== undefined ? { startMs } : {}), ...(endMs !== undefined ? { endMs } : {}), gapAfterMs };
    });
    return { name: part.name, tracks: positions, ...(musicMs !== undefined ? { musicMs } : {}), gapMs, leadInMs: spec.leadInMs, tailMs: spec.tailMs, ...(cursor !== undefined ? { durationMs: cursor + spec.tailMs } : {}) };
  });
  return { timebase: 'milliseconds', executionReady: false, sides, constraints };
}

export function balancedSplit(tracks: readonly MediaTimingTrack[], spec: MediaLayoutSpec): number {
  validate(tracks, spec);
  if (spec.format !== 'cassette') return invalid('DAT 使用连续节目，不需要 A/B 平衡。');
  if (tracks.some(t => t.durationMs === undefined)) return invalid('有曲目时长未知，无法自动提出可靠分界。');
  let best: { index: number; distance: number } | undefined;
  for (let index = 1; index <= tracks.length; index++) {
    const result = resolveMediaLayout(tracks, { ...spec, splitAfter: index });
    if (result.constraints.length) continue;
    const distance = Math.abs(result.sides[0]!.durationMs! - result.sides[1]!.durationMs!);
    if (!best || distance < best.distance) best = { index, distance };
  }
  return best?.index ?? invalid('没有同时满足当前曲序和分面约束的分界，请调整约束。');
}

export type MediaStockCandidate = Pick<MediaCandidate, 'skuId' | 'model' | 'lengthMinutes' | 'packaging' | 'availableCount'>;
export function assessMediaCandidate(stock: MediaStockCandidate, layout: MediaLayout, spec: MediaLayoutSpec, sourceBasis: MediaSourceBasis): MediaCandidate {
  const reasons: MediaCandidateReason[] = [];
  const add = (reason: MediaCandidateReason): void => { if (!reasons.includes(reason)) reasons.push(reason); };
  let remaining = stock.availableCount;
  if (stock.model.collectorPolicy === 'collector') { add('collector-protected'); remaining = 0; }
  if (stock.packaging === 'sealed') {
    if (stock.model.collectorPolicy === 'preserve-sealed') { add('sealed-protected'); remaining = 0; }
    remaining = Math.min(remaining, Math.max(0, stock.model.counts.sealedBlank - stock.model.minimumSealedReserve));
    if (remaining === 0 && stock.model.minimumSealedReserve > 0) add('minimum-reserve');
  }
  const capacity = stock.lengthMinutes === null ? undefined : stock.lengthMinutes * 60_000 / (spec.format === 'cassette' ? 2 : 1);
  let fit: MediaCandidate['fit'] = 'fits';
  if (capacity === undefined) { fit = 'unknown'; add('capacity-unknown'); }
  if (layout.sides.some(side => side.durationMs === undefined)) { fit = 'unknown'; add('duration-unknown'); }
  if (capacity !== undefined && layout.sides.some(side => side.durationMs !== undefined && side.durationMs > capacity)) { fit = 'too-short'; add('too-short'); }
  const expectedType = stock.model.tapeType;
  let compatibility: MediaCandidate['compatibility'];
  if (stock.model.format !== spec.format) compatibility = 'incompatible';
  else if (!spec.compatibility.confirmed || expectedType === 'unknown') compatibility = 'unknown';
  else if (spec.format === 'dat') compatibility = spec.compatibility.dat && expectedType === 'dat' ? 'confirmed' : 'incompatible';
  else compatibility = expectedType !== 'dat' && spec.compatibility.cassetteTypes.includes(expectedType) ? 'confirmed' : 'incompatible';
  if (compatibility === 'unknown') add('compatibility-unknown');
  if (compatibility === 'incompatible') add('incompatible');
  if (sourceBasis === 'unavailable') add('source-unavailable');
  if (layout.constraints.length) add('layout-conflict');
  const excluded = reasons.some(reason => !['capacity-unknown', 'duration-unknown', 'compatibility-unknown'].includes(reason));
  const status = excluded ? 'excluded' : reasons.length ? 'pending' : 'recommended';
  return { ...stock, reservableCount: status === 'recommended' ? remaining : 0, fit, compatibility, reasons, status };
}
