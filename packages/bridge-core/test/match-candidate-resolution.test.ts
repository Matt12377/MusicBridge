import assert from 'node:assert/strict';
import test from 'node:test';
import type { RoonLibraryItem, RoonLibraryPage } from '@music-bridge/contracts';
import { resolveRoonMatch } from '../src/matching/candidate-resolution.js';
import type { LogicalRecording } from '../src/matching/index.js';

const recording: LogicalRecording = {
  neteaseTrackId: '301',
  title: '归零',
  artists: ['林忆莲'],
  album: '0 (2024版)',
  durationMs: 271_000,
};

function page(items: readonly RoonLibraryItem[]): RoonLibraryPage {
  return { items, offset: 0, limit: 20, total: items.length, hasMore: false };
}

test('candidate resolution falls back from Track Search to Album → Tracks with album provenance', async () => {
  const calls: string[] = [];
  const directTrack: RoonLibraryItem = {
    reference: 'musicbridge-v2-entity-123e4567-e89b-12d3-a456-426614174021',
    kind: 'track',
    title: '归零',
    subtitle: 'Sandy Lam, 常石磊',
  };
  const album: RoonLibraryItem = {
    reference: 'musicbridge-v2-entity-123e4567-e89b-12d3-a456-426614174022',
    kind: 'album',
    title: '0 (2024版)',
    subtitle: 'Sandy Lam',
  };
  const result = await resolveRoonMatch(recording, {
    async searchLibrary(query, _request, kind = 'track') {
      calls.push(`${kind}:${query}`);
      return kind === 'album' ? page([album]) : page([directTrack]);
    },
    async browseAlbum(reference) {
      calls.push(`album-tracks:${reference}`);
      return page([directTrack]);
    },
  });

  assert.equal(result.state, 'CONFIRMED');
  assert.equal(result.candidate?.album, '0 (2024版)');
  assert.ok(result.evidence.includes('title-album-unique'));
  assert.deepEqual(calls, [
    'track:林忆莲 归零',
    'album:林忆莲 0 (2024版)',
    `album-tracks:${album.reference}`,
  ]);
});

test('candidate resolution does not open albums after strong Track Search evidence', async () => {
  const calls: string[] = [];
  const directTrack: RoonLibraryItem = {
    reference: 'musicbridge-v2-entity-123e4567-e89b-12d3-a456-426614174023',
    kind: 'track',
    title: '归零',
    artist: '林忆莲',
    durationMs: 271_000,
  };
  const result = await resolveRoonMatch(recording, {
    async searchLibrary(query, _request, kind = 'track') {
      calls.push(`${kind}:${query}`);
      return page([directTrack]);
    },
    async browseAlbum() {
      calls.push('unexpected-album-drill-down');
      return page([]);
    },
  });

  assert.equal(result.state, 'CONFIRMED');
  assert.deepEqual(calls, ['track:林忆莲 归零']);
});

test('candidate resolution never treats the Provider Unknown Album placeholder as evidence', async () => {
  const calls: string[] = [];
  const result = await resolveRoonMatch({
    ...recording,
    album: 'Unknown Album',
  }, {
    async searchLibrary(query, _request, kind = 'track') {
      calls.push(`${kind}:${query}`);
      return page([]);
    },
    async browseAlbum() {
      calls.push('unexpected-album-drill-down');
      return page([]);
    },
  });

  assert.equal(result.state, 'NONE');
  assert.deepEqual(calls, ['track:林忆莲 归零']);
});
