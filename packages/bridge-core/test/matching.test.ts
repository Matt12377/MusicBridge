import assert from 'node:assert/strict';
import test from 'node:test';
import type { RoonLibraryItem } from '@music-bridge/contracts';
import {
  createMatchCache,
  isCacheableMatchResult,
  matchLogicalRecording,
  resolvePlaybackSource,
  type LogicalRecording,
} from '../src/matching/index.js';

const track: LogicalRecording = {
  neteaseTrackId: '101',
  title: '吻别',
  artists: ['张学友'],
  album: '吻别',
  durationMs: 271_000,
};

function candidate(overrides: Partial<RoonLibraryItem> = {}): RoonLibraryItem {
  return {
    reference: 'musicbridge-v2-entity-123e4567-e89b-12d3-a456-426614174000',
    kind: 'track',
    title: '吻别',
    artist: '张学友',
    album: '吻别',
    durationMs: 271_500,
    ...overrides,
  };
}

function withoutCandidateFields(
  value: RoonLibraryItem,
  ...keys: readonly (keyof RoonLibraryItem)[]
): RoonLibraryItem {
  const result = { ...value };
  for (const key of keys) delete result[key];
  return result;
}

test('MatchingEngine confirms a unique same-version Roon candidate', () => {
  const result = matchLogicalRecording(track, [candidate()]);
  assert.equal(result.state, 'CONFIRMED');
  assert.equal(result.candidate?.reference, candidate().reference);
  assert.ok(result.confidence >= 0.85);
  assert.ok(result.evidence.includes('title-exact'));
  assert.ok(result.evidence.includes('artist-exact'));
});

test('MatchingEngine protects studio/live and remix version boundaries', () => {
  const live = matchLogicalRecording(track, [candidate({ title: '吻别 (Live)', version: 'Live' })]);
  const remix = matchLogicalRecording(track, [candidate({ title: '吻别 (Remix)', version: 'Remix' })]);
  assert.equal(live.state, 'REJECTED');
  assert.equal(remix.state, 'REJECTED');
  assert.match(live.evidence.join(','), /version-reject/);
});

test('MatchingEngine keeps ambiguous compilations as possible, never auto-confirmed', () => {
  const candidates = [
    candidate({ reference: 'musicbridge-v2-entity-123e4567-e89b-12d3-a456-426614174001' }),
    candidate({
      reference: 'musicbridge-v2-entity-123e4567-e89b-12d3-a456-426614174002',
      album: '张学友精选',
      durationMs: 270_900,
    }),
  ];
  const result = matchLogicalRecording(track, candidates);
  assert.equal(result.state, 'POSSIBLE');
  assert.equal(result.candidate, undefined);
  assert.equal(result.candidates.length, 2);
});

test('MatchingEngine exposes multiple sparse exact-title versions as candidates without auto-confirming', () => {
  const recording: LogicalRecording = {
    neteaseTrackId: '401',
    title: '至少还有你',
    artists: ['林忆莲'],
    album: "林忆莲's",
  };
  const candidates = [
    withoutCandidateFields(candidate({
      reference: 'musicbridge-v2-entity-123e4567-e89b-12d3-a456-426614174041',
      title: '至少还有你',
      subtitle: 'Sandy Lam, Davy Chan, Lin Xi',
    }), 'artist', 'album', 'durationMs'),
    withoutCandidateFields(candidate({
      reference: 'musicbridge-v2-entity-123e4567-e89b-12d3-a456-426614174042',
      title: '至少还有你',
      subtitle: 'Sandy Lam, Davy Chan, Lin Xi, Anthony Lun',
    }), 'artist', 'album', 'durationMs'),
  ];

  const result = matchLogicalRecording(recording, candidates);
  assert.equal(result.state, 'POSSIBLE');
  assert.equal(result.candidate, undefined);
  assert.ok(result.evidence.includes('ambiguous-exact-title-candidates'));
});

test('MatchingEngine confirms one exact title plus exact album when Roon artist uses an alias', () => {
  const recording: LogicalRecording = {
    neteaseTrackId: '301',
    title: '归零',
    artists: ['林忆莲'],
    album: '0 (2024版)',
    durationMs: 271_000,
  };
  const result = matchLogicalRecording(recording, [withoutCandidateFields(candidate({
    title: '归零',
    subtitle: 'Sandy Lam, 常石磊',
    album: '0 (2024版)',
  }), 'artist', 'durationMs')]);

  assert.equal(result.state, 'CONFIRMED');
  assert.ok(result.evidence.includes('title-exact'));
  assert.ok(result.evidence.includes('album-exact'));
  assert.equal(result.evidence.includes('artist-exact'), false);
});

test('MatchingEngine does not treat neighboring tracks from the same album as title ambiguity', () => {
  const recording: LogicalRecording = {
    neteaseTrackId: '301',
    title: '归零',
    artists: ['林忆莲'],
    album: '0 (2024版)',
  };
  const result = matchLogicalRecording(recording, [
    withoutCandidateFields(candidate({
      reference: 'musicbridge-v2-entity-123e4567-e89b-12d3-a456-426614174031',
      title: '归零',
      subtitle: 'Sandy Lam, 常石磊',
      album: '0 (2024版)',
    }), 'artist', 'durationMs'),
    withoutCandidateFields(candidate({
      reference: 'musicbridge-v2-entity-123e4567-e89b-12d3-a456-426614174032',
      title: '太阳系',
      artist: '林忆莲',
      album: '0 (2024版)',
    }), 'durationMs'),
  ]);

  assert.equal(result.state, 'CONFIRMED');
  assert.ok(result.evidence.includes('title-album-unique'));
});

test('MatchingEngine keeps duplicate exact-title/exact-album candidates ambiguous', () => {
  const recording: LogicalRecording = {
    neteaseTrackId: '301',
    title: '归零',
    artists: ['林忆莲'],
    album: '0 (2024版)',
  };
  const candidates = [
    withoutCandidateFields(candidate({
      reference: 'musicbridge-v2-entity-123e4567-e89b-12d3-a456-426614174011',
      title: '归零',
      subtitle: 'Sandy Lam, 常石磊',
      album: '0 (2024版)',
    }), 'artist', 'durationMs'),
    withoutCandidateFields(candidate({
      reference: 'musicbridge-v2-entity-123e4567-e89b-12d3-a456-426614174012',
      title: '归零',
      subtitle: 'Sandy Lam, 常石磊',
      album: '0 (2024版)',
    }), 'artist', 'durationMs'),
  ];

  const result = matchLogicalRecording(recording, candidates);
  assert.equal(result.state, 'POSSIBLE');
  assert.equal(result.candidate, undefined);
  assert.ok(result.evidence.includes('ambiguous-top-candidates'));
});

test('MatchingEngine rejects a version marker carried by album metadata', () => {
  const result = matchLogicalRecording(track, [candidate({
    title: '吻别',
    album: '吻别 Live',
  })]);

  assert.equal(result.state, 'REJECTED');
  assert.ok(result.evidence.includes('version-reject'));
});

test('MatchingEngine treats one exact artist inside real Roon multi-credit subtitle as evidence', () => {
  const result = matchLogicalRecording(track, [withoutCandidateFields(candidate({
    subtitle: '张学友, 欧丁玉 & 林明阳',
  }), 'artist', 'album')]);

  assert.equal(result.state, 'CONFIRMED');
  assert.ok(result.evidence.includes('artist-exact'));
});

test('MatchingEngine hard-rejects Chinese instrumental wording against a vocal original', () => {
  const result = matchLogicalRecording(track, [candidate({
    title: '吻别 (纯音乐版)',
    artist: '张学友',
  })]);

  assert.equal(result.state, 'REJECTED');
  assert.ok(result.evidence.includes('version-reject'));
});

test('Match cache is bounded, keyed by NetEase id, and can invalidate runtime references', () => {
  const cache = createMatchCache(1);
  const first = matchLogicalRecording(track, [candidate()]);
  cache.set(track, first);
  assert.deepEqual(cache.get(track), first);
  const secondTrack = { ...track, neteaseTrackId: '102', title: '她来听我的演唱会' };
  cache.set(secondTrack, matchLogicalRecording(secondTrack, []));
  assert.equal(cache.get(track), undefined);
  cache.invalidate();
  assert.equal(cache.get(secondTrack), undefined);
});

test('Match cache expires runtime references and never stores transient Roon unavailability', () => {
  let now = 1_000;
  const cache = createMatchCache(2, () => now, 100);
  const confirmed = matchLogicalRecording(track, [candidate()]);
  cache.set(track, confirmed);
  assert.equal(cache.get(track)?.state, 'CONFIRMED');
  now += 101;
  assert.equal(cache.get(track), undefined);

  assert.equal(isCacheableMatchResult(confirmed), true);
  assert.equal(isCacheableMatchResult({
    evidence: ['roon-library-unavailable'],
  }), false);
});

test('PlaybackResolver is fail-closed for Smart and Roon-only policies', () => {
  const confirmed = matchLogicalRecording(track, [candidate()]);
  const possible = matchLogicalRecording(track, [candidate({ title: '吻别 (Live)', version: 'Live' })]);
  assert.equal(resolvePlaybackSource('smart', confirmed, true), 'roon');
  assert.equal(resolvePlaybackSource('smart', confirmed, false), 'netease');
  assert.equal(resolvePlaybackSource('smart', possible, true), 'netease');
  assert.equal(resolvePlaybackSource('roon-only', possible, true), 'unavailable');
  assert.equal(resolvePlaybackSource('netease-only', confirmed, true), 'netease');
});
