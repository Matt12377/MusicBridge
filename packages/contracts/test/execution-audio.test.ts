import assert from 'node:assert/strict';
import test from 'node:test';
import * as contracts from '../src/index.js';
import { randomUUID } from 'node:crypto';
import type { ExecutionFormat, ExecutionRecipe } from '../src/index.js';

test('执行格式有独立公开合同，不从普通播放状态隐式推导', () => {
  assert.equal(typeof (contracts as Record<string, unknown>).isExecutionFormat, 'function');
});

const format: ExecutionFormat = { sampleRate: 96000, channelCount: 2, channelLayout: 'stereo', internalProcessingPrecision: 'integer-bit-copy', outputSampleFormat: 'pcm-s16le', resamplerImplementation: 'none', resamplerVersion: 'not-applied', ditherPolicy: 'none', channelMapping: 'identity', outputBackend: { id: 'fixture', version: '1' }, outputProfileVersion: randomUUID() };
const recipe: ExecutionRecipe = { schemaVersion: 1, mode: 'direct', compiler: 'musicbridge-pcm-copy-v1', masterVersionId: randomUUID(), layoutVersionId: randomUUID(), contentHash: 'a'.repeat(64), plannedTimelineHash: 'b'.repeat(64), format, side: 'A', capacityFrames: 1000000, totalFrames: 1, segments: [{ kind: 'source', trackId: randomUUID(), input: { sha256: 'c'.repeat(64), size: 48, sampleRate: 96000, channelCount: 2, bitsPerSample: 16, totalFrames: 1 }, startFrame: 0, endFrame: 1 }], formalReady: false };
test('执行格式拒绝省略版本、矛盾声道、私有路径和额外控制字段', () => {
  assert.equal(contracts.isExecutionFormat(format), true);
  for (const field of Object.keys(format)) { const value = { ...format } as Record<string, unknown>; delete value[field]; assert.equal(contracts.isExecutionFormat(value), false, field); }
  for (const patch of [{ sampleRate: NaN }, { channelLayout: 'mono' }, { outputProfileVersion: 'latest' }, { resamplerVersion: 'auto' }, { resamplerImplementation: '/private/converter' }, { outputBackend: { ...format.outputBackend, endpoint: 'http://secret' } }, { fallback: true }]) assert.equal(contracts.isExecutionFormat({ ...format, ...patch }), false);
});
test('配方拒绝假正式状态、空 A、重叠、帧不符和隐式转换', () => {
  assert.equal(contracts.isExecutionRecipe(recipe), true);
  for (const patch of [{ formalReady: true }, { totalFrames: 0, segments: [] }, { format: { ...format, ditherPolicy: 'tpdf' } }, { segments: [{ ...recipe.segments[0], endFrame: 2 }] }, { segments: [{ ...recipe.segments[0], startFrame: 1 }] }, { sourcePath: '/private/music' }]) assert.equal(contracts.isExecutionRecipe({ ...recipe, ...patch }), false);
  assert.equal(contracts.isExecutionRecipe({ ...recipe, side: 'B', totalFrames: 0, segments: [] }), true);
});
test('音频回执必须有非空实际文件，且不能把原件身份写成另一个 Hash', () => {
  const value = { recipe, recipeHash: 'd'.repeat(64), origin: 'compiled', audio: { sha256: 'e'.repeat(64), size: 48, pcmSha256: 'f'.repeat(64), dataOffset: 44, frameCount: 1 }, formalReady: false };
  assert.equal(contracts.isExecutionAudioReceipt(value), true);
  for (const patch of [{ origin: 'retained-render' }, { formalReady: true }, { audio: { ...value.audio, size: 47 } }, { audio: { ...value.audio, frameCount: 2 } }, { recipe: { ...recipe, side: 'B', totalFrames: 0, segments: [] } }]) assert.equal(contracts.isExecutionAudioReceipt({ ...value, ...patch }), false);
  const render = { ...recipe, mode: 'prepared-reference', prepared: { id: randomUUID(), renderTimelineHash: 'a'.repeat(64) }, segments: [{ kind: 'render', renderAssetId: randomUUID(), input: (recipe.segments[0] as Extract<contracts.ExecutionSegment, {kind: 'source'}>).input, startFrame: 0, endFrame: 1 }] };
  assert.equal(contracts.isExecutionRecipe(render), true);
  assert.equal(contracts.isExecutionRecipe({ ...render, segments: [...render.segments, { kind: 'silence', reason: 'gap', startFrame: 1, endFrame: 2 }], totalFrames: 2 }), false);
  assert.equal(contracts.isExecutionAudioReceipt({ ...value, recipe: render, origin: 'retained-render' }), false);
  assert.equal(contracts.isExecutionAudioReceipt({ ...value, recipe: render, origin: 'retained-render', audio: { ...value.audio, sha256: 'c'.repeat(64) } }), true);
});
