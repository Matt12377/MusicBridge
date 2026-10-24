import assert from 'node:assert/strict';
import test from 'node:test';
import { isFileAudioParameters, type FileAudioParameters } from '../src/audio-quality.js';
import { mapMobileFileAudioParameters } from '../src/mobile-common.js';
import { mapLocalDetailToMobileTrack, mobileCatalogResponseSnapshot, type MobileCatalogIdentityBinding } from '../src/mobile-catalog.js';
import type { LocalLibraryTrackDetail } from '../src/local-catalog.js';

const parameters = (bits = 16): FileAudioParameters => ({ container: 'APE', codec: 'APE', lossless: true,
  sampleRateHz: 44100, channels: 2, bitsPerSample: bits, durationMs: 120000, evidence: 'bounded-parser-reported' } as unknown as FileAudioParameters);
function fixture(index = 0, bits = 16) {
  const detail: LocalLibraryTrackDetail = { track: { id: `track.${index}`, assetId: `asset.${index}`, selectionRevision: '1', segment: null },
    asset: { id: `asset.${index}`, libraryRootId: 'root.1', sourceRootId: 'source.1', rootRevision: '1', fileRevision: '1', locationRevision: '1', sampleFrames: null, timebaseHz: null },
    metadata: { raw: { title: '合成APE曲目' }, override: null, effective: { title: '合成APE曲目' } }, versionTokens: [],
    editions: [{ id: 'edition.1', title: '合成专辑', edition: '原版', revision: '1' }], fileParameters: parameters(bits) };
  const binding: MobileCatalogIdentityBinding = { localTrackId: detail.track.id, assetId: detail.asset.id, fileRevision: '1', selectionRevision: '1', segmentId: null,
    editionId: 'edition.1', editionRevision: '1', trackId: `local:track.${index}`, sourceItemId: `local:item.${index}`, albumId: 'local:album.1', versionId: `version.${index}`, contentRevision: `revision.${index}` };
  const projection = { title: '合成APE曲目', artists: [], editionLabel: '原版', availability: 'unavailable' as const };
  return { detail, binding, projection };
}

test('APE 16/24bit真实文件参数合法且原规格映射ape/ape，不能伪装FLAC或授予播放', () => {
  for (const bits of [16, 24]) {
    const raw = parameters(bits), original = structuredClone(raw); assert.equal(isFileAudioParameters(raw), true);
    const audio = mapMobileFileAudioParameters(raw); assert.ok(audio.ok);
    assert.deepEqual({ ...audio.value }, { codec: 'ape', container: 'ape', sampleRateHz: 44100, channels: 2, bitsPerSample: bits });
    assert.deepEqual(raw, original);
    const f = fixture(0, bits), mapped = mapLocalDetailToMobileTrack(f.detail, f.binding, f.projection); assert.ok(mapped.ok);
    assert.equal(mapped.value.availability, 'unavailable'); assert.equal(mapped.value.audio.codec, 'ape');
    assert.equal(mapped.value.audio.container, 'ape'); assert.equal(mapped.value.source, 'local');
  }
});

test('APE位于非首批row80仍保100条整页与所有身份，后页继续不跳行', () => {
  const rows = Array.from({ length: 201 }, (_, index) => {
    const f = fixture(index, index % 2 ? 24 : 16);
    if (index !== 179 && index !== 180) f.detail.fileParameters = { ...parameters(), container: 'FLAC', codec: 'FLAC' };
    const result = mapLocalDetailToMobileTrack(f.detail, f.binding, f.projection); assert.ok(result.ok); return result.value;
  });
  const page = mobileCatalogResponseSnapshot('trackPage', { items: rows.slice(100, 200), nextCursor: 'cursor.synthetic', libraryRevision: 'scope.synthetic' });
  assert.ok(page.ok); assert.equal(page.value.items.length, 100);
  assert.equal(page.value.items[79]!.audio.codec, 'ape'); assert.equal(page.value.items[80]!.audio.bitsPerSample, 16);
  assert.deepEqual(page.value.items.map(row => row.id), Array.from({ length: 100 }, (_, i) => `local:track.${100 + i}`));
  assert.equal(new Set(rows.map(row => row.id)).size, 201); assert.equal(rows.slice(200).length, 1);
});

test('APE仅信息容器扩展，缺失/坏参数、未知容器及私有字段仍被原FileAudioParameters闭集拒绝', () => {
  const base = parameters();
  for (const patch of [{ container: 'UNKNOWN' }, { container: 'ape' }, { codec: '/private/source.ape' }, { codec: 'APE\n' },
    { sampleRateHz: 0 }, { sampleRateHz: NaN }, { channels: 65 }, { bitsPerSample: 0 }, { durationMs: -1 },
    { evidence: 'verified-output' }, { token: 'synthetic-only' }]) assert.equal(isFileAudioParameters({ ...base, ...patch }), false);
  for (const key of Object.keys(base)) { const missing = { ...base } as Record<string, unknown>; delete missing[key]; assert.equal(isFileAudioParameters(missing), false); }
  for (const patch of [{ codec: '/private/source.ape' }, { codec: 'APE\n' }, { sampleRateHz: 0 }, { channels: 0 }, { bitsPerSample: 0 }]) {
    assert.equal(mapMobileFileAudioParameters({ ...base, ...patch }).ok, false);
  }
});

test('APE详情缺少文件参数/原身份不符仍拒绝，不以空音频补造合法曲目', () => {
  const f = fixture(); f.detail.fileParameters = null;
  assert.equal(mapLocalDetailToMobileTrack(f.detail, f.binding, f.projection).ok, false);
  f.detail.fileParameters = parameters(); f.detail.asset.fileRevision = '2';
  assert.equal(mapLocalDetailToMobileTrack(f.detail, f.binding, f.projection).ok, false);
});

test('原七种信息容器映射及DSD严格组合保持', () => {
  for (const [container, codec, expected, wireContainer] of [
    ['FLAC', 'FLAC', 'flac', 'flac'], ['MPEG', 'MP3', 'mp3', 'mp3'], ['MP4', 'Apple Lossless', 'alac', 'm4a'],
    ['WAVE', 'PCM', 'pcm_s16le', 'wav'], ['AIFF', 'PCM', 'pcm_s16be', 'aiff'], ['DSF', 'DSD', 'dsd', 'dsf'], ['DFF', 'DSD', 'dsd', 'dff'],
  ] as const) {
    const dsd = container === 'DSF' || container === 'DFF';
    const raw = { ...parameters(), container, codec, lossless: container === 'MPEG' ? false : true, bitsPerSample: dsd ? 1 : 16, sampleRateHz: dsd ? 2822400 : 44100 };
    assert.equal(isFileAudioParameters(raw), true); const mapped = mapMobileFileAudioParameters(raw); assert.ok(mapped.ok);
    assert.equal(mapped.value.codec, expected); assert.equal(mapped.value.container, wireContainer);
  }
  assert.equal(isFileAudioParameters({ ...parameters(), container: 'DSF' }), false);
});
