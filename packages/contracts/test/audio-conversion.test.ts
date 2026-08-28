import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import * as contracts from '../src/index.js';

const format = {
  sampleRate: 96000, channelCount: 2, channelLayout: 'stereo', internalProcessingPrecision: 'float64',
  outputSampleFormat: 'pcm-s24le', resamplerImplementation: 'fixture-src', resamplerVersion: '1',
  ditherPolicy: 'none', channelMapping: 'identity', outputBackend: { id: 'no-output', version: '1' }, outputProfileVersion: randomUUID(),
};
const converter = {
  id: 'fixture-converter', version: '1', binarySha256: 'a'.repeat(64), buildSha256: 'b'.repeat(64),
  components: [{ name: 'decoder', version: '1' }, { name: 'fixture-src', version: '1' }],
};
const plan = {
  schemaVersion: 1, input: { sha256: 'c'.repeat(64), size: 1024,
    technical: { container: 'FLAC', codec: 'FLAC', sampleRate: 44100, channels: 2, bitsPerSample: 16, sampleFrames: 44100, frameEvidence: 'container-declared', durationMs: 1000, lossless: true } },
  format, converter, processing: { sourceExtent: 'whole-input', inputStreamIndex: 0, gain: 'unchanged', timestampCompensation: 'disabled', parameters: [{ name: 'filter-size', value: 32 }] },
  formalReady: false,
};
function validate(name: string, value: unknown): boolean {
  const fn = (contracts as unknown as Record<string, unknown>)[name];
  assert.equal(typeof fn, 'function', `缺少转换合同 ${name}；这是合同接线 RED`);
  return (fn as (value: unknown) => boolean)(value);
}
const receipt = {
  plan, planHash: 'd'.repeat(64),
  decoded: { codec: 'flac', sampleRate: 44100, channelCount: 2, sampleFormat: 's16', frameCount: 44100, wholeInputConsumed: true },
  audio: { sha256: 'e'.repeat(64), pcmSha256: 'f'.repeat(64), size: 576044, dataOffset: 44, frameCount: 96000 },
  formalReady: false,
};

test('执行格式的枚举必须是字符串，不接受可强制转字符串的数组', () => {
  assert.equal(contracts.isExecutionFormat(format), true);
  for (const key of ['internalProcessingPrecision','outputSampleFormat','ditherPolicy','channelMapping'] as const) {
    assert.equal(contracts.isExecutionFormat({ ...format, [key]: [format[key]] }), false, key);
  }
});

test('转换器身份固定二进制、构建和组件版本，不包含路径或认证声明', () => {
  assert.equal(validate('isAudioConverterIdentity', converter), true);
  for (const patch of [{ executablePath: '/private/converter' }, { certified: true }, { binarySha256: '' }, { components: [...converter.components, converter.components[0]] }]) {
    assert.equal(validate('isAudioConverterIdentity', { ...converter, ...patch }), false);
  }
});

test('转换计划保留原文件证据和明确处理参数，拒绝隐式声音处理或重复参数', () => {
  assert.equal(validate('isAudioConversionPlan', plan), true);
  for (const patch of [{ formalReady: true }, { outputPath: '/private/output.wav' }, { input: { ...plan.input, sourcePath: '/private/source.flac' } },
    { processing: { ...plan.processing, gain: 2 } }, { processing: { ...plan.processing, sourceExtent: 'trim-silence' } },
    { processing: { ...plan.processing, extraArguments: ['-af','loudnorm'] } },
    { processing: { ...plan.processing, parameters: [plan.processing.parameters[0], plan.processing.parameters[0]] } },
    { format: { ...format, channelMapping: 'mono-to-stereo' } },
    { format: { ...format, resamplerImplementation: 'none', resamplerVersion: 'not-applied' } },
  ]) assert.equal(validate('isAudioConversionPlan', { ...plan, ...patch }), false);
});

test('转换回执使用实际解码与输出帧数，不能用进程成功或预计时长代替音频', () => {
  assert.equal(validate('isAudioConversionReceipt', receipt), true);
  for (const patch of [{ formalReady: true }, { exitCode: 0 }, { audio: undefined }, { decoded: { ...receipt.decoded, wholeInputConsumed: false } },
    { decoded: { ...receipt.decoded, channelCount: 1 } }, { audio: { ...receipt.audio, frameCount: 96001 } },
    { audio: { ...receipt.audio, dataOffset: receipt.audio.size } },
  ]) assert.equal(validate('isAudioConversionReceipt', { ...receipt, ...patch }), false);
});

test('转换回执不把容器体积当作 PCM 大小，实际零帧或未冻结源帧拒绝', () => {
  assert.equal(validate('isAudioConversionPlan', { ...plan, input: { ...plan.input, technical: { ...plan.input.technical, sampleFrames: undefined, frameEvidence: undefined } } }), false);
  assert.equal(validate('isAudioConversionReceipt', { ...receipt, audio: { ...receipt.audio, frameCount: 0 } }), false);
  assert.equal(validate('isAudioConversionPlan', { ...plan, processing: { ...plan.processing, parameters: [{ name: 'quality', value: Infinity }] } }), false);
});

test('转换源必须无损；浮点和未知编码不能声明整数位复制', () => {
  assert.equal(validate('isAudioConversionPlan', { ...plan, input: { ...plan.input, technical: { ...plan.input.technical, lossless: false } } }), false);
  const copyFormat = { ...format, sampleRate: 44100, outputSampleFormat: 'pcm-s32le', internalProcessingPrecision: 'integer-bit-copy', resamplerImplementation: 'none', resamplerVersion: 'not-applied' };
  for (const codec of ['IEEE_FLOAT', 'unrecognized-codec']) {
    assert.equal(validate('isAudioConversionPlan', { ...plan, format: copyFormat, input: { ...plan.input, technical: { ...plan.input.technical, codec, bitsPerSample: 32 } } }), false);
  }
});

test('转换帧数只允许异率的一帧边界差，同率解码一帧也不能丢', () => {
  assert.equal(validate('isAudioConversionReceipt', { ...receipt, decoded: { ...receipt.decoded, frameCount: 44099 } }), false);
  for (const delta of [-2, -1, 0, 1, 2]) {
    assert.equal(validate('isAudioConversionReceipt', { ...receipt, audio: { ...receipt.audio, frameCount: 96000 + delta, size: 44 + (96000 + delta) * 6 } }), Math.abs(delta) <= 1);
  }
});

test('解码证据必须是源采样率和源帧数，不能把转换后时基当作解码事实', () => {
  assert.equal(validate('isAudioConversionReceipt', { ...receipt, decoded: { ...receipt.decoded, sampleRate: 96000, frameCount: 96000 } }), false);
});

function executionFixture() {
  const recipe = {
    schemaVersion: 2, compiler: 'musicbridge-conversion-v2', mode: 'direct',
    masterVersionId: randomUUID(), layoutVersionId: randomUUID(), contentHash: '1'.repeat(64), plannedTimelineHash: '2'.repeat(64),
    format, side: 'Program', capacityFrames: 1000000, minimumFrames: 672998, maximumFrames: 673002,
    segments: [{ kind: 'source', trackId: randomUUID(), conversion: plan }, { kind: 'silence', reason: 'gap', frames: 481000 }, { kind: 'source', trackId: randomUUID(), conversion: plan }], formalReady: false,
  };
  const result = { recipe, recipeHash: '3'.repeat(64), origin: 'compiled',
    segments: [{ startFrame: 0, endFrame: 96000, conversion: receipt }, { startFrame: 96000, endFrame: 577000 }, { startFrame: 577000, endFrame: 673000, conversion: receipt }],
    audio: { sha256: '4'.repeat(64), pcmSha256: '5'.repeat(64), size: 44 + 673000 * 6, dataOffset: 44, frameCount: 673000 }, formalReady: false,
  };
  return { recipe, result };
}

test('V2 转换配方保留源计划，预览只声明帧数范围；实际回执才确定时间线', () => {
  const { recipe, result } = executionFixture();
  assert.equal(validate('isConvertedExecutionRecipe', recipe), true);
  assert.equal(validate('isConvertedExecutionReceipt', result), true);
  for (const patch of [{ minimumFrames: 673000 }, { maximumFrames: 673000 }, { capacityFrames: 673001 }, { totalFrames: 673000 }, { schemaVersion: 1 }, { formalReady: true }]) {
    assert.equal(validate('isConvertedExecutionRecipe', { ...recipe, ...patch }), false);
  }
  for (const patch of [{ segments: result.segments.slice(0,2) }, { audio: { ...result.audio, frameCount: 673001 } }, { segments: result.segments.map((s,i) => i === 1 ? { ...s, endFrame: s.endFrame + 1 } : s) }, { origin: 'retained-render' }]) {
    assert.equal(validate('isConvertedExecutionReceipt', { ...result, ...patch }), false);
  }
});

test('V2 Prepared Derivative 只转换整个原 Render，禁止再加 Gap 或伪造原件身份', () => {
  const { recipe } = executionFixture();
  const prepared = { ...recipe, mode: 'prepared-derivative', prepared: { id: randomUUID(), renderTimelineHash: '6'.repeat(64) }, minimumFrames: 95999, maximumFrames: 96001,
    segments: [{ kind: 'render', renderAssetId: randomUUID(), conversion: plan }] };
  const result = { recipe: prepared, recipeHash: '3'.repeat(64), origin: 'derived-render', segments: [{ startFrame: 0, endFrame: 96000, conversion: receipt }], audio: receipt.audio, formalReady: false };
  assert.equal(validate('isConvertedExecutionRecipe', prepared), true);
  assert.equal(validate('isConvertedExecutionReceipt', result), true);
  assert.equal(validate('isConvertedExecutionRecipe', { ...prepared, segments: [...prepared.segments, { kind: 'silence', reason: 'tail', frames: 1 }] }), false);
  assert.equal(validate('isConvertedExecutionReceipt', { ...result, audio: { ...receipt.audio, sha256: '7'.repeat(64) } }), false);
  assert.equal(validate('isConvertedExecutionRecipe', { ...prepared, prepared: undefined }), false);
});

test('V2 不接受跨格式回执、重复曲目、私有路径和空 A；空 B 不伪造音频', () => {
  const { recipe, result } = executionFixture();
  assert.equal(validate('isConvertedExecutionRecipe', { ...recipe, segments: [recipe.segments[0], recipe.segments[0]], minimumFrames: 191998, maximumFrames: 192002 }), false);
  assert.equal(validate('isConvertedExecutionReceipt', { ...result, segments: result.segments.map((s,i) => i === 0 ? { ...s, conversion: { ...receipt, plan: { ...plan, converter: { ...converter, version: '2' } } } } : s) }), false);
  const empty = { ...recipe, side: 'B', minimumFrames: 0, maximumFrames: 0, segments: [] };
  assert.equal(validate('isConvertedExecutionRecipe', empty), true);
  assert.equal(validate('isConvertedExecutionRecipe', { ...empty, side: 'A' }), false);
  assert.equal(validate('isConvertedExecutionRecipe', { ...recipe, outputPath: '/private/output.wav' }), false);
});
