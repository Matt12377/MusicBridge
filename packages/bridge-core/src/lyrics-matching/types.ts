export const LYRICS_MATCH_ALGORITHM_VERSION = 'lyrics-match-v1'

export const lyricsMatchResultBrand: unique symbol = Symbol('LyricsMatchResult')

export type LyricsMatchState =
  | 'CONFIRMED'
  | 'MANUAL'
  | 'POSSIBLE'
  | 'AMBIGUOUS'
  | 'REJECTED'
  | 'NONE'

export interface LyricsRecordingIdentity {
  title: string
  artists: readonly string[]
  album?: string
  durationMs?: number
  version?: string
}

export interface LyricsCandidate extends LyricsRecordingIdentity {
  trackId: string
}

export interface LyricsCandidateScore {
  candidate: LyricsCandidate
  score: number
  evidence: readonly string[]
}

export interface LyricsRecordingCluster {
  key: string
  score: number
  evidence: readonly string[]
  candidates: readonly LyricsCandidateScore[]
}

export interface LyricsMatchResult {
  readonly [lyricsMatchResultBrand]: true
  state: LyricsMatchState
  algorithmVersion: typeof LYRICS_MATCH_ALGORITHM_VERSION
  evidence: readonly string[]
  candidates: readonly LyricsCandidateScore[]
  clusters: readonly LyricsRecordingCluster[]
  candidate?: LyricsCandidate
}
