import type { RoonLibraryItem } from './roon.js';

export const MATCH_STATES = ['CONFIRMED', 'POSSIBLE', 'REJECTED', 'NONE', 'MANUAL'] as const;
export type MatchState = (typeof MATCH_STATES)[number];

export interface PublicMatchCandidate {
  candidate: RoonLibraryItem;
  score: number;
  evidence: readonly string[];
}

export interface PublicTrackMatchResult {
  trackId: string;
  state: MatchState;
  confidence: number;
  evidence: readonly string[];
  candidates: readonly PublicMatchCandidate[];
  candidate?: RoonLibraryItem;
  algorithmVersion: string;
}
