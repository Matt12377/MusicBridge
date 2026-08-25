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
