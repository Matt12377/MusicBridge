export {
  LYRICS_MATCH_ALGORITHM_VERSION,
  lyricsMatchResultBrand,
  type LyricsCandidate,
  type LyricsCandidateScore,
  type LyricsMatchResult,
  type LyricsMatchState,
  type LyricsRecordingCluster,
  type LyricsRecordingIdentity,
} from './types.js'
export { matchLyricsRecording } from './scorer.js'
export {
  lyricsArtistsIntersect,
  normalizeLyricsArtists,
  normalizeLyricsText,
} from './normalize.js'
export {
  buildLyricsVersionProfile,
  findLyricsVersionConflicts,
  lyricsVersionProfileKey,
  normalizeLyricsBaseTitle,
  type LyricsVersionAxis,
  type LyricsVersionConflict,
  type LyricsVersionProfile,
} from './version-profile.js'
