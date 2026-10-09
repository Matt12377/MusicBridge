import assert from 'node:assert/strict';
import test from 'node:test';
import { mapMobileFileAudioParameters, type FileAudioParameters } from '../src/index.js';

const parameters = (value: Partial<FileAudioParameters>): FileAudioParameters => ({
  container: 'WAVE', codec: 'PCM', lossless: true, sampleRateHz: 44100,
  channels: 2, bitsPerSample: 16, durationMs: 120000, evidence: 'bounded-parser-reported', ...value,
});

test('002曲库解析PCM规格与移动文件格式合同一致，全部原技术轴和源记录保留', () => {
  for (const [container, bits, expected] of [
    ['WAVE', 16, 'pcm_s16le'], ['WAVE', 24, 'pcm_s24le'], ['WAVE', 32, 'pcm_s32le'],
    ['WAVE', 8, 'pcm_u8'], ['AIFF', 16, 'pcm_s16be'], ['AIFF', 24, 'pcm_s24be'],
  ] as const) {
    const raw = parameters({ container, bitsPerSample: bits }), before = structuredClone(raw);
    const result = mapMobileFileAudioParameters(raw);
    assert.ok(result.ok);
    assert.deepEqual(result.value, Object.assign(Object.create(null), {
      codec: expected, container: container === 'WAVE' ? 'wav' : 'aiff',
      sampleRateHz: 44100, channels: 2, bitsPerSample: bits }));
    assert.deepEqual(raw, before);
  }
});

test('002真实Parser的MPEG Layer3和Apple Lossless词汇可成为SDK请求格式，保留独立容器', () => {
  for (const [container, codec, lossless, expected, wireContainer] of [
    ['MPEG', 'MPEG 1 Layer 3', false, 'mp3', 'mp3'],
    ['MPEG', 'MPEG 2.5 Layer III', false, 'mp3', 'mp3'],
    ['MP4', 'Apple Lossless', true, 'alac', 'm4a'],
    ['FLAC', 'FLAC', true, 'flac', 'flac'],
  ] as const) {
    const raw = parameters({ container, codec, lossless, bitsPerSample: container === 'MPEG' ? null : 24 });
    const result = mapMobileFileAudioParameters(raw); assert.ok(result.ok);
    assert.equal(result.value.codec, expected); assert.equal(result.value.container, wireContainer);
    assert.equal(result.value.sampleRateHz, raw.sampleRateHz); assert.equal(result.value.channels, raw.channels);
    assert.equal(result.value.bitsPerSample, raw.bitsPerSample ?? undefined);
  }
});

test('002未知PCM位深或编码资格不补成可播放格式，非法Parser词汇仍拒绝', () => {
  for (const raw of [parameters({ bitsPerSample: null }), parameters({ lossless: null }),
    parameters({ lossless: false })]) {
    const result = mapMobileFileAudioParameters(raw); assert.ok(result.ok);
    assert.equal(result.value.codec, 'pcm');
    assert.equal(result.value.bitsPerSample, raw.bitsPerSample ?? undefined);
  }
  const malformed = parameters({ codec: '未知 Parser 编码' });
  assert.equal(mapMobileFileAudioParameters(malformed).ok, false);
  const aac = mapMobileFileAudioParameters(parameters({ container: 'MP4', codec: 'AAC', lossless: false }));
  assert.ok(aac.ok); assert.equal(aac.value.codec, 'aac');
});
