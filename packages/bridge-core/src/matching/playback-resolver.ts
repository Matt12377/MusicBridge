import type { MatchResult } from './index.js';

export type PlaybackSourcePolicy = 'smart' | 'netease-only' | 'roon-only';
export type ResolvedPlaybackSource = 'roon' | 'netease' | 'unavailable';

export function resolvePlaybackSource(
  policy: PlaybackSourcePolicy,
  match: MatchResult | undefined,
  roonAvailable: boolean,
): ResolvedPlaybackSource {
  if (policy === 'netease-only') return 'netease';
  const confirmedRoon = roonAvailable && match?.state === 'CONFIRMED' && match.candidate !== undefined;
  if (confirmedRoon) return 'roon';
  if (policy === 'roon-only') return 'unavailable';
  return 'netease';
}
