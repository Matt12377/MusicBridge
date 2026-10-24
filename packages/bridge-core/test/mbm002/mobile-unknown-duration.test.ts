import assert from 'node:assert/strict';
import test from 'node:test';
import { mobileCatalogResponseSnapshot, type MobileTrack } from '@music-bridge/contracts';
import { unknownDurationFixture } from '../helpers/mobile-unknown-duration-fixture.js';
import { MobileServiceError } from '../../src/mobile/types.js';

test('M35未知时长：offset300第90项无精确时长仍完整返回100项，保持null且不可播放', () => {
  const f = unknownDurationFixture(); f.setDuration(389, null); f.setPlaybackAvailable(true);
  const page = f.page({ offset: 300, catalogPlaybackEnabled: true });
  assert.equal(page.items.length, 100); assert.equal(page.total, 401); assert.equal(page.offset, 300);
  assert.deepEqual(page.items.map(item => item.id), Array.from({ length: 100 }, (_, i) => f.id(300 + i)));
  const track = mobileCatalogResponseSnapshot('track', page.items[89]); assert.ok(track.ok);
  assert.equal(track.value.durationMs, null); assert.equal(track.value.availability, 'unavailable');
  assert.equal(f.counts().playbackChecks, 99);
});

test('M35未知时长：五页全量不跳行、不补零，详情和专辑成员保持同一内容身份', () => {
  const f = unknownDurationFixture(); for (const i of [5, 193, 389]) f.setDuration(i, null);
  const tracks: MobileTrack[] = []; let revision: string | null = null;
  for (let offset = 0; offset < 401; offset += 100) {
    const page = f.page({ offset, expectedRevision: revision }); revision ??= page.libraryRevision;
    assert.equal(page.libraryRevision, revision); assert.equal(page.total, 401);
    for (const item of page.items) { const parsed = mobileCatalogResponseSnapshot('track', item); assert.ok(parsed.ok); tracks.push(parsed.value); }
  }
  assert.equal(tracks.length, 401); assert.equal(new Set(tracks.map(t => t.id)).size, 401);
  assert.equal(tracks.filter(t => t.durationMs === null && t.availability === 'unavailable').length, 3);
  assert.equal(tracks.filter(t => t.durationMs === 0).length, 0);
  const affected = tracks[389]!;
  assert.deepEqual(f.page({ operation: 'getTrack', itemId: affected.id, limit: 1 }).items[0], affected);
  assert.deepEqual(f.page({ albumId: affected.albumId, offset: 300 }).items[89], affected);
});

test('M35未知时长：准确CUE帧数仍计算真时长，坏帧边界与其他音频事实不降级', () => {
  const f = unknownDurationFixture(1); f.setDuration(0, null);
  const original = f.details[0]!;
  f.details[0] = { ...original, asset: { ...original.asset, sampleFrames: '88200', timebaseHz: 44100 },
    track: { ...original.track, segment: { id: '83000000-0000-4000-8000-000000000001', startFrame: '0', endFrameExclusive: '44100', timebaseHz: 44100 } } };
  const cue = mobileCatalogResponseSnapshot('track', f.page().items[0]); assert.ok(cue.ok);
  assert.equal(cue.value.durationMs, 1000);
  f.details[0] = { ...f.details[0]!, asset: { ...original.asset, sampleFrames: null, timebaseHz: null } };
  assert.throws(() => f.page(), e => e instanceof MobileServiceError && e.code === 'BUSY');
  f.details[0] = { ...original, fileParameters: null };
  assert.throws(() => f.page(), e => e instanceof MobileServiceError && e.code === 'BUSY');
  assert.ok(original.fileParameters);
  f.details[0] = { ...original, fileParameters: { ...original.fileParameters, codec: '非法 空格' } };
  assert.throws(() => f.page(), e => e instanceof MobileServiceError && e.code === 'SOURCE_CHANGED');
});

test('M35未知时长：目录换代、授权撤销和资产绑定异常仍拒绝整页', () => {
  const f = unknownDurationFixture(1); f.setDuration(0, null); const revision = f.page().libraryRevision;
  f.setRevision('scope:2');
  assert.throws(() => f.page({ expectedRevision: revision }), e => e instanceof MobileServiceError && e.code === 'SOURCE_CHANGED');
  f.setAuthorized(false); assert.throws(() => f.page(), MobileServiceError);
  f.setAuthorized(true); const d = f.details[0]!;
  f.details[0] = { ...d, asset: { ...d.asset, rootRevision: 'different' } };
  assert.throws(() => f.page(), MobileServiceError);
});
