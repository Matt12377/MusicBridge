import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { discoverAlbumDirectoryCandidates, type AlbumDirectoryInput, type AlbumDirectoryIssue } from '../../src/library/local-name-rules.js';
interface DirectoryCase { test: string; input: AlbumDirectoryInput; expected: {
  albumCount?: number; audioCount?: number; albumNames?: string[]; albumCounts?: number[]; looseAudioPaths?: string[];
  lastAlbumIssues?: AlbumDirectoryIssue[]; relativeAudioPaths?: string[]; relativeCuePaths?: string[]; issues?: AlbumDirectoryIssue[];
  artist?: string; artistNot?: string; album?: string; boundary?: string; noIssue?: string; hasIssue?: string;
  needsAttention?: boolean; allNeedAttention?: boolean; readErrors?: string[]; beforeAudioPaths?: string[]; afterAudioPaths?: string[]; error?: string;
} }
const corpus: { directoryFactCases: DirectoryCase[] } = JSON.parse(readFileSync(new URL('./golden-facts.json', import.meta.url), 'utf8'));
for (const [index, sample] of corpus.directoryFactCases.entries()) test(`上游目录 ${index + 1}：${sample.test}`, () => {
  const expected = sample.expected;
  // 上游Reader故障转换成已捕获的错误事实；这里不调用Reader或文件系统。
  const input = { ...sample.input, ...(expected.readErrors ? { readErrorPaths: expected.readErrors } : {}) };
  const result = discoverAlbumDirectoryCandidates(input), first = result.albums[0];
  if (expected.albumCount !== undefined) assert.equal(result.albums.length, expected.albumCount);
  if (expected.albumNames) assert.deepEqual(result.albums.map(album => album.albumName), expected.albumNames);
  if (expected.albumCounts) assert.deepEqual(result.albums.map(album => album.relativeAudioPaths.length), expected.albumCounts);
  if (expected.looseAudioPaths) assert.deepEqual(result.looseAudioPaths, expected.looseAudioPaths);
  if (expected.lastAlbumIssues) assert.deepEqual(result.albums.at(-1)?.issues, expected.lastAlbumIssues);
  if (expected.audioCount !== undefined) assert.equal(first?.relativeAudioPaths.length, expected.audioCount);
  if (expected.relativeAudioPaths) assert.deepEqual(first?.relativeAudioPaths, expected.relativeAudioPaths);
  if (expected.relativeCuePaths) assert.deepEqual(first?.relativeCuePaths, expected.relativeCuePaths);
  if (expected.artist) assert.equal(first?.artistName, expected.artist);
  if (expected.artistNot) assert.notEqual(first?.artistName, expected.artistNot);
  if (expected.album) assert.equal(first?.albumName, expected.album);
  if (expected.boundary) assert.equal(first?.boundaryPath, expected.boundary);
  if (expected.issues) assert.deepEqual(first?.issues, expected.issues);
  if (expected.noIssue) assert.ok(!first?.issues.some(issue => issue.type === expected.noIssue));
  if (expected.hasIssue) assert.ok(result.albums.every(album => album.issues.some(issue => issue.type === expected.hasIssue)));
  if (expected.needsAttention) assert.equal(first?.needsAttention, true);
  if (expected.allNeedAttention) assert.ok(result.albums.every(album => album.needsAttention));
  if (expected.error) assert.equal(result.error, expected.error);
  if (expected.beforeAudioPaths && expected.afterAudioPaths) {
    const before = discoverAlbumDirectoryCandidates({ ...input, audioPaths: expected.beforeAudioPaths });
    assert.deepEqual(before.albums[0]?.relativeAudioPaths, expected.beforeAudioPaths);
    assert.deepEqual(result.albums[0]?.relativeAudioPaths, expected.afterAudioPaths);
  }
});
