import type { RoonLibraryItem } from '@music-bridge/contracts'

export const MATCH_ALGORITHM_VERSION = 'v2-deterministic-2'

export interface LogicalRecording {
  neteaseTrackId: string
  title: string
  artists: readonly string[]
  album?: string
  durationMs?: number
  version?: string
}

export type MatchState = 'CONFIRMED' | 'POSSIBLE' | 'REJECTED' | 'NONE' | 'MANUAL'

export interface MatchCandidateScore {
  candidate: RoonLibraryItem
  score: number
  evidence: readonly string[]
}

export interface MatchResult {
  state: MatchState
  confidence: number
  evidence: readonly string[]
  candidates: readonly MatchCandidateScore[]
  candidate?: RoonLibraryItem
  algorithmVersion: typeof MATCH_ALGORITHM_VERSION
}
