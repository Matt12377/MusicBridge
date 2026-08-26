import assert from 'node:assert/strict'
import test from 'node:test'
import type { MatchResult as PlaybackMatchResult } from '../src/matching/index.js'
import {
  LYRICS_MATCH_ALGORITHM_VERSION,
  matchLyricsRecording,
  type LyricsCandidate,
  type LyricsMatchResult,
  type LyricsMatchState,
  type LyricsRecordingIdentity,
} from '../src/lyrics-matching/index.js'

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false
type Assert<Value extends true> = Value
type ExpectedLyricsMatchState = 'CONFIRMED' | 'MANUAL' | 'POSSIBLE' | 'AMBIGUOUS' | 'REJECTED' | 'NONE'
const lyricsMatchStatesAreFrozen: Assert<Equal<LyricsMatchState, ExpectedLyricsMatchState>> = true

const recording: LyricsRecordingIdentity = {
  title: '归零',
  artists: ['林忆莲'],
  album: '0 (2024版)',
  durationMs: 271_000,
}

function candidate(overrides: Partial<LyricsCandidate> = {}): LyricsCandidate {
  return {
    trackId: '101',
    title: '归零',
    artists: ['林忆莲'],
    album: '0 (2024版)',
    durationMs: 271_400,
    ...overrides,
  }
}

test('LyricsMatch confirms one same-title, same-artist, same-duration recording', () => {
  const result = matchLyricsRecording(recording, [candidate()])

  assert.equal(result.state, 'CONFIRMED')
  assert.equal(result.candidate?.trackId, '101')
  assert.equal(result.algorithmVersion, 'lyrics-match-v1')
  assert.equal(LYRICS_MATCH_ALGORITHM_VERSION, 'lyrics-match-v1')
  assert.equal(result.clusters.length, 1)
})

for (const conflict of [
  { axis: 'performance', recordingVersion: 'Studio', candidateVersion: 'Live' },
  { axis: 'mix', recordingVersion: 'Original Mix', candidateVersion: 'Remix' },
  { axis: 'vocal', recordingVersion: 'Vocal', candidateVersion: 'Instrumental' },
  { axis: 'authorship', recordingVersion: 'Original', candidateVersion: 'Cover' },
  { axis: 'release', recordingVersion: 'Final', candidateVersion: 'Demo' },
] as const) {
  test(`LyricsMatch hard-rejects ${conflict.axis} conflicts before scoring`, () => {
    const result = matchLyricsRecording(
      { ...recording, version: conflict.recordingVersion },
      [candidate({ version: conflict.candidateVersion })],
    )

    assert.equal(result.state, 'REJECTED')
    assert.match(result.evidence.join(','), new RegExp(`version-conflict:${conflict.axis}`))
  })
}

for (const field of ['title', 'album', 'version'] as const) {
  test(`LyricsMatch detects a version marker in candidate ${field}`, () => {
    const result = matchLyricsRecording(recording, [candidate({
      [field]: `${candidate()[field] ?? ''} Live`,
    })])

    assert.equal(result.state, 'REJECTED')
    assert.match(result.evidence.join(','), /version-conflict:performance/)
  })
}

for (const field of ['title', 'album', 'version'] as const) {
  test(`LyricsMatch detects a version marker in local recording ${field}`, () => {
    const result = matchLyricsRecording(
      { ...recording, [field]: `${recording[field] ?? ''} Live` },
      [candidate()],
    )

    assert.equal(result.state, 'REJECTED')
    assert.match(result.evidence.join(','), /version-conflict:performance/)
  })
}

for (const version of ['现场', '混音', '纯音乐', '翻唱', '演示'] as const) {
  test(`LyricsMatch hard-rejects the Chinese version marker ${version}`, () => {
    const result = matchLyricsRecording(recording, [candidate({ version })])

    assert.equal(result.state, 'REJECTED')
  })
}

test('LyricsMatch clusters the same recording across original and compilation albums', () => {
  const result = matchLyricsRecording(recording, [
    candidate({ trackId: '101', album: '0 (2024版)', durationMs: 271_100 }),
    candidate({ trackId: '102', album: '林忆莲精选', durationMs: 271_700 }),
  ])

  assert.equal(result.state, 'CONFIRMED')
  assert.equal(result.clusters.length, 1)
  assert.deepEqual(result.clusters[0]?.candidates.map((entry) => entry.candidate.trackId), ['101', '102'])
})

test('LyricsMatch leaves two qualifying but distinct duration clusters ambiguous', () => {
  const target = { ...recording, durationMs: 240_000 }
  const result = matchLyricsRecording(target, [
    candidate({ trackId: '201', durationMs: 237_000, album: '原始专辑' }),
    candidate({ trackId: '202', durationMs: 243_000, album: '精选集' }),
  ])

  assert.equal(result.state, 'AMBIGUOUS')
  assert.equal(result.candidate, undefined)
  assert.equal(result.clusters.length, 2)
})

test('LyricsMatch keeps one exact-title candidate possible when artist and duration evidence are missing', () => {
  const sparse = candidate({ artists: [] })
  delete sparse.album
  delete sparse.durationMs

  const result = matchLyricsRecording(recording, [sparse])

  assert.equal(result.state, 'POSSIBLE')
  assert.equal(result.candidate, undefined)
})

test('LyricsMatch confirms at the inclusive three-second duration boundary', () => {
  const result = matchLyricsRecording(recording, [candidate({ durationMs: 274_000, album: '精选集' })])

  assert.equal(result.state, 'CONFIRMED')
})

test('LyricsMatch does not confirm beyond the three-second duration boundary', () => {
  const result = matchLyricsRecording(recording, [candidate({ durationMs: 274_001, album: '精选集' })])

  assert.equal(result.state, 'POSSIBLE')
  assert.equal(result.candidate, undefined)
})

test('LyricsMatch confirms one exact-album cluster when duration is unavailable', () => {
  const noDuration = candidate()
  delete noDuration.durationMs

  const result = matchLyricsRecording(recording, [noDuration])

  assert.equal(result.state, 'CONFIRMED')
  assert.equal(result.candidate?.trackId, '101')
})

test('LyricsMatch returns NONE when search has no candidates', () => {
  const result = matchLyricsRecording(recording, [])

  assert.equal(result.state, 'NONE')
  assert.deepEqual(result.candidates, [])
  assert.deepEqual(result.clusters, [])
})

test('LyricsMatch treats an album mismatch as a penalty rather than rejection', () => {
  const result = matchLyricsRecording(recording, [candidate({ album: '跨世纪精选' })])

  assert.equal(result.state, 'CONFIRMED')
  assert.doesNotMatch(result.evidence.join(','), /reject/)
})

test('LyricsMatch tie ordering is stable and independent of candidate input order', () => {
  const left = candidate({ trackId: '302', durationMs: 268_000, album: '乙' })
  const right = candidate({ trackId: '301', durationMs: 274_000, album: '甲' })

  const forward = matchLyricsRecording(recording, [left, right])
  const reverse = matchLyricsRecording(recording, [right, left])
  const ids = (result: LyricsMatchResult) => result.clusters.map((cluster) => cluster.candidates[0]?.candidate.trackId)

  assert.deepEqual(ids(forward), ['301', '302'])
  assert.deepEqual(ids(reverse), ids(forward))
})

test('LyricsMatch bounds candidates, clusters, cluster members, and evidence', () => {
  const candidates = Array.from({ length: 45 }, (_, index) => candidate({
    trackId: String(1_000 + index),
    durationMs: 271_000 + index * 10_000,
  }))

  const result = matchLyricsRecording(recording, candidates)

  assert.equal(result.candidates.length, 40)
  assert.ok(result.clusters.length <= 40)
  assert.ok(result.clusters.every((cluster) => cluster.candidates.length <= 20))
  assert.ok(result.evidence.length <= 16)
  assert.ok(result.clusters.every((cluster) => cluster.evidence.length <= 16))
})

test('LyricsMatchResult remains a distinct domain type from Playback MatchResult', () => {
  if (false) {
    const playbackResult = {} as PlaybackMatchResult
    const lyricsResult = {} as LyricsMatchResult
    // @ts-expect-error Playback MatchResult 不具备 LyricsMatchResult 的领域品牌与结构。
    const invalidLyrics: LyricsMatchResult = playbackResult
    // @ts-expect-error LyricsMatchResult 不能传给播放来源匹配链路。
    const invalidPlayback: PlaybackMatchResult = lyricsResult
    void invalidLyrics
    void invalidPlayback
  }

  assert.ok(true)
})

void lyricsMatchStatesAreFrozen
