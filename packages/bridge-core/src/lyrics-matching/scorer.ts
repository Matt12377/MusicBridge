import {
  lyricsArtistsIntersect,
  normalizeLyricsArtists,
  normalizeLyricsText,
} from './normalize.js'
import {
  buildLyricsVersionProfile,
  findLyricsVersionConflicts,
  lyricsVersionProfileKey,
  normalizeLyricsBaseTitle,
} from './version-profile.js'
import {
  LYRICS_MATCH_ALGORITHM_VERSION,
  lyricsMatchResultBrand,
  type LyricsCandidate,
  type LyricsCandidateScore,
  type LyricsMatchResult,
  type LyricsRecordingCluster,
  type LyricsRecordingIdentity,
} from './types.js'

const MAX_INPUT_CANDIDATES = 40
const MAX_CLUSTER_CANDIDATES = 20
const MAX_EVIDENCE = 16
const RECORDING_DURATION_TOLERANCE_MS = 3_000
const CONFIRM_SCORE = 0.85
const POSSIBLE_SCORE = 0.5
const SAFE_MARGIN = 0.08

interface InternalCandidateScore {
  publicScore: LyricsCandidateScore
  relevant: boolean
  rejected: boolean
  confirmable: boolean
  titleKey: string
  artistKey: string
  versionKey: string
  durationMs?: number
}

interface InternalCluster {
  publicCluster: LyricsRecordingCluster
  members: readonly InternalCandidateScore[]
  confirmable: boolean
}

function boundedEvidence(values: readonly string[]): readonly string[] {
  return [...new Set(values)].slice(0, MAX_EVIDENCE)
}

function stableCandidateKey(candidate: LyricsCandidate): string {
  return [
    candidate.trackId,
    normalizeLyricsText(candidate.title),
    normalizeLyricsArtists(candidate.artists).join('|'),
    normalizeLyricsText(candidate.album),
    candidate.durationMs ?? '',
    normalizeLyricsText(candidate.version),
  ].join('::')
}

function boundedUniqueCandidates(candidates: readonly LyricsCandidate[]): readonly LyricsCandidate[] {
  const ordered = [...candidates].sort((left, right) =>
    stableCandidateKey(left).localeCompare(stableCandidateKey(right), 'en'))
  const unique = new Map<string, LyricsCandidate>()
  for (const candidate of ordered) {
    if (!unique.has(candidate.trackId)) unique.set(candidate.trackId, candidate)
    if (unique.size >= MAX_INPUT_CANDIDATES) break
  }
  return [...unique.values()]
}

function scoreCandidate(
  recording: LyricsRecordingIdentity,
  candidate: LyricsCandidate,
): InternalCandidateScore {
  const recordingProfile = buildLyricsVersionProfile(recording)
  const candidateProfile = buildLyricsVersionProfile(candidate)
  const conflicts = findLyricsVersionConflicts(recordingProfile, candidateProfile)
  const titleKey = normalizeLyricsBaseTitle(candidate.title)
  const titleExact = normalizeLyricsBaseTitle(recording.title) === titleKey && titleKey.length > 0
  const artistExact = lyricsArtistsIntersect(recording.artists, candidate.artists)
  const albumExact = Boolean(
    recording.album
      && candidate.album
      && normalizeLyricsText(recording.album) === normalizeLyricsText(candidate.album),
  )
  const durationKnown = recording.durationMs !== undefined && candidate.durationMs !== undefined
  const durationDifference = durationKnown
    ? Math.abs(recording.durationMs! - candidate.durationMs!)
    : undefined
  const durationWithinOneSecond = durationDifference !== undefined && durationDifference <= 1_000
  const durationWithinTolerance = durationDifference !== undefined
    && durationDifference <= RECORDING_DURATION_TOLERANCE_MS
  const evidence = [
    ...(titleExact ? ['title-exact'] : ['title-mismatch']),
    ...(artistExact ? ['artist-intersection'] : ['artist-missing']),
    ...(albumExact ? ['album-exact'] : recording.album && candidate.album ? ['album-mismatch'] : ['album-unavailable']),
    ...(durationWithinOneSecond
      ? ['duration-within-1s']
      : durationWithinTolerance
        ? ['duration-within-3s']
        : durationKnown
          ? ['duration-outside-3s']
          : ['duration-unavailable']),
    ...conflicts.map((conflict) =>
      `version-conflict:${conflict.axis}:${conflict.recordingValue}/${conflict.candidateValue}`),
  ]
  const rejected = titleExact && conflicts.length > 0
  const score = rejected
    ? 0
    : (titleExact ? 0.55 : 0)
      + (artistExact ? 0.25 : 0)
      + (durationWithinOneSecond ? 0.15 : durationWithinTolerance ? 0.12 : 0)
      + (albumExact ? 0.05 : 0)
  const confirmableDuration = durationWithinTolerance || (!durationKnown && albumExact)

  return {
    publicScore: {
      candidate,
      score: Number(score.toFixed(3)),
      evidence: boundedEvidence(evidence),
    },
    relevant: titleExact,
    rejected,
    confirmable: titleExact && artistExact && confirmableDuration && score >= CONFIRM_SCORE,
    titleKey,
    artistKey: normalizeLyricsArtists(candidate.artists).join('|'),
    versionKey: lyricsVersionProfileKey(candidateProfile),
    ...(candidate.durationMs === undefined ? {} : { durationMs: candidate.durationMs }),
  }
}

function sameRecordingCluster(left: InternalCandidateScore, right: InternalCandidateScore): boolean {
  if (left.titleKey !== right.titleKey) return false
  if (left.artistKey !== right.artistKey) return false
  if (left.versionKey !== right.versionKey) return false
  if (left.durationMs === undefined || right.durationMs === undefined) return true
  return Math.abs(left.durationMs - right.durationMs) <= RECORDING_DURATION_TOLERANCE_MS
}

function clusterCandidates(candidates: readonly InternalCandidateScore[]): readonly InternalCluster[] {
  const groups: InternalCandidateScore[][] = []
  for (const candidate of candidates) {
    const group = groups.find((entries) => entries.every((entry) => sameRecordingCluster(entry, candidate)))
    if (group) group.push(candidate)
    else groups.push([candidate])
  }

  return groups
    .map((members): InternalCluster => {
      const orderedMembers = [...members].sort((left, right) =>
        right.publicScore.score - left.publicScore.score
          || left.publicScore.candidate.trackId.localeCompare(right.publicScore.candidate.trackId, 'en'))
      const representative = orderedMembers[0]!
      const publicMembers = orderedMembers
        .slice(0, MAX_CLUSTER_CANDIDATES)
        .map((member) => member.publicScore)
      const key = [
        representative.titleKey,
        representative.artistKey,
        representative.versionKey,
        representative.durationMs ?? 'unknown',
        representative.publicScore.candidate.trackId,
      ].join('::')
      return {
        members: orderedMembers,
        confirmable: orderedMembers.some((member) => member.confirmable),
        publicCluster: {
          key,
          score: representative.publicScore.score,
          evidence: boundedEvidence(orderedMembers.flatMap((member) => member.publicScore.evidence)),
          candidates: publicMembers,
        },
      }
    })
    .sort((left, right) =>
      right.publicCluster.score - left.publicCluster.score
        || left.publicCluster.candidates[0]!.candidate.trackId.localeCompare(
          right.publicCluster.candidates[0]!.candidate.trackId,
          'en',
        )
        || left.publicCluster.key.localeCompare(right.publicCluster.key, 'en'))
}

function result(
  state: LyricsMatchResult['state'],
  candidates: readonly InternalCandidateScore[],
  clusters: readonly InternalCluster[],
  evidence: readonly string[],
  candidate?: LyricsCandidate,
): LyricsMatchResult {
  return {
    [lyricsMatchResultBrand]: true,
    state,
    algorithmVersion: LYRICS_MATCH_ALGORITHM_VERSION,
    evidence: boundedEvidence(evidence),
    candidates: candidates.map((entry) => entry.publicScore),
    clusters: clusters.map((entry) => entry.publicCluster),
    ...(candidate === undefined ? {} : { candidate }),
  }
}

export function matchLyricsRecording(
  recording: LyricsRecordingIdentity,
  candidates: readonly LyricsCandidate[],
): LyricsMatchResult {
  if (candidates.length === 0) return result('NONE', [], [], ['no-candidate'])

  const scored = boundedUniqueCandidates(candidates)
    .map((candidate) => scoreCandidate(recording, candidate))
    .sort((left, right) =>
      right.publicScore.score - left.publicScore.score
        || left.publicScore.candidate.trackId.localeCompare(right.publicScore.candidate.trackId, 'en'))
  const relevant = scored.filter((entry) => entry.relevant)
  const usable = relevant.filter((entry) => !entry.rejected)
  const rejected = relevant.filter((entry) => entry.rejected)

  if (usable.length === 0) {
    if (rejected.length > 0) {
      return result(
        'REJECTED',
        scored,
        [],
        ['all-relevant-candidates-version-rejected', ...rejected.flatMap((entry) => entry.publicScore.evidence)],
      )
    }
    return result('NONE', scored, [], ['no-relevant-candidate'])
  }

  const clusters = clusterCandidates(usable)
  const confirmable = clusters.filter((cluster) => cluster.confirmable)
  const top = clusters[0]!
  const second = clusters[1]
  const margin = second === undefined ? top.publicCluster.score : top.publicCluster.score - second.publicCluster.score

  if (confirmable.length > 1 || (clusters.length > 1 && margin < SAFE_MARGIN)) {
    return result(
      'AMBIGUOUS',
      scored,
      clusters,
      ['multiple-recording-clusters', ...(confirmable.length > 1 ? ['multiple-qualifying-clusters'] : ['unsafe-score-margin'])],
    )
  }

  if (confirmable.length === 1 && confirmable[0] === top && margin >= SAFE_MARGIN) {
    const selected = top.publicCluster.candidates[0]!.candidate
    return result(
      'CONFIRMED',
      scored,
      clusters,
      ['unique-recording-cluster', ...top.publicCluster.evidence],
      selected,
    )
  }

  if (top.publicCluster.score >= POSSIBLE_SCORE) {
    return result('POSSIBLE', scored, clusters, ['insufficient-confirmation-evidence', ...top.publicCluster.evidence])
  }

  return result('NONE', scored, clusters, ['no-candidate-above-possible-threshold'])
}
