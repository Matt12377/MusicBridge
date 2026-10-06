import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { cleanAlbumName, cleanArtistName, coverSearchKeyword, resolveAlbumNameCandidates } from '../../src/library/local-name-rules.js';
interface NameCase { id?: string; input: string; artist?: string | null; expected: string; kind?: string; idempotent?: boolean }
interface DisplayCase { id: string; input: { artist: string; album: string; tracks: { album?: string; artist?: string; albumArtist?: string; repeatCount?: number }[]; override?: { artist: string; album: string } }; expected: { artist?: string; album?: string; keyword?: string; withoutOverrideAlbum?: string; withOverrideArtist?: string; withOverrideAlbum?: string; elapsedLessThanSeconds?: number } }
interface Corpus { selectedCommit: string; counts: Record<string, number>; albumAndArtistNameCases: NameCase[]; displayCases: DisplayCase[]; sharedEnhancementCases: { test: string; cases: NameCase[] }[]; keywordCases: { test: string; input: { artist: string; album: string }; expected: string }[] }
const corpus: Corpus = JSON.parse(readFileSync(new URL('./golden-facts.json', import.meta.url), 'utf8'));
for (const sample of corpus.albumAndArtistNameCases) test(`上游 ${sample.id}：名称及幂等`, () => {
  const clean = (value: string): string => sample.kind === 'artist' ? cleanArtistName(value) : cleanAlbumName(value, sample.artist ?? undefined);
  assert.equal(clean(sample.input), sample.expected);
  assert.equal(clean(clean(sample.input)), sample.expected);
});
for (const group of corpus.sharedEnhancementCases) test(`上游增强共享规则：${group.test}`, () => {
  for (const sample of group.cases) { const clean = sample.kind === 'artist' ? cleanArtistName : (value: string) => cleanAlbumName(value, sample.artist ?? undefined); assert.equal(clean(sample.input), sample.expected); assert.equal(clean(clean(sample.input)), sample.expected); }
});
for (const sample of corpus.displayCases) test(`上游 ${sample.id}：展示与候选`, () => {
  const members = sample.input.tracks.flatMap((track, index) => Array.from({ length: track.repeatCount ?? 1 }, (_, n) => ({ trackId: `${index}-${n}`, ...track })));
  const input = { artistName: sample.input.artist, albumName: sample.input.album, members, aiMode: 'off' as const };
  const started = performance.now(), result = resolveAlbumNameCandidates(input), elapsed = (performance.now() - started) / 1000;
  if (sample.expected.artist) assert.equal(result.artist.display, sample.expected.artist);
  if (sample.expected.album) assert.equal(result.album.display, sample.expected.album);
  if (sample.expected.keyword) assert.equal(coverSearchKeyword(result.artist.display, result.album.display), sample.expected.keyword);
  if (sample.expected.withoutOverrideAlbum) assert.equal(result.album.display, sample.expected.withoutOverrideAlbum);
  if (sample.input.override) {
    const manual = resolveAlbumNameCandidates({ ...input, manual: { artistName: sample.input.override.artist, albumName: sample.input.override.album } });
    assert.equal(manual.artist.display, sample.expected.withOverrideArtist); assert.equal(manual.album.display, sample.expected.withOverrideAlbum);
  }
  if (sample.expected.elapsedLessThanSeconds) assert.ok(elapsed < sample.expected.elapsedLessThanSeconds, `5000个重复值耗时 ${elapsed}s`);
});
for (const sample of corpus.keywordCases) test(`上游搜索词：${sample.test}`, () => assert.equal(coverSearchKeyword(sample.input.artist, sample.input.album), sample.expected));
