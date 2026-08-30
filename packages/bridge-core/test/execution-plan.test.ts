import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { isExecutionRecipe, isConvertedExecutionRecipe, isFrozenPrepared, type AudioConversionPlan, type AudioConversionSource, type ExecutionFormat, type FrozenPrepared, type RawRenderAsset, type RenderTimeline, type LayoutVersion, type MasterVersion } from '@music-bridge/contracts';
import { planDirectExecution, planPreparedExecution, planConvertedDirectExecution, planPreparedDerivative, ExecutionCompileError } from '../src/recording/execution-plan.js';
import { compileDirectPcm } from '../src/recording/execution-compiler.js';
import { mediaFingerprint } from '../src/recording/media-store.js';
import { preparationFixture } from './helpers/preparation-fixture.js';

const format = (sampleRate = 44100): ExecutionFormat => ({ sampleRate, channelCount: 2, channelLayout: 'stereo', internalProcessingPrecision: 'integer-bit-copy', outputSampleFormat: 'pcm-s16le', resamplerImplementation: 'none', resamplerVersion: 'not-applied', ditherPolicy: 'none', channelMapping: 'identity', outputBackend: { id: 'isolated-test-no-output', version: '1' }, outputProfileVersion: randomUUID() });
const rejects = (action: () => unknown, code: string): void => assert.throws(action, e => e instanceof ExecutionCompileError && e.code === code);
async function versions(t: test.TestContext, options: { format?: 'cassette' | 'dat'; emptyB?: boolean } = {}) {
  const f = await preparationFixture(t, options), job = await f.freeze(); await f.versions.idle();
  return { ...f, ...f.repository.preparations.frozen(f.versions.job(job.id).job!.layoutVersionId!) };
}
/** 本夹具只描述已确认版本；真实保留文件、授权和字节验证由编译内核测试单独覆盖。 */
function prepared(master: MasterVersion, layout: LayoutVersion) {
  const assets: RawRenderAsset[] = layout.timeline.sides.filter(s => s.totalFrames > 0).map(s => ({ id: randomUUID(), side: s.name, sha256: 'a'.repeat(64), size: 44 + s.totalFrames * 4, format: 'wav', sampleRate: layout.timeline.sampleRate, channelLayout: 'stereo', totalFrames: s.totalFrames, createdAt: new Date().toISOString(), creationTimeEvidence: 'first-observed' }));
  const timeline: RenderTimeline = { timebase: 'sample-frames', sides: layout.timeline.sides.map(s => {
    const asset = assets.find(a => a.side === s.name);
    return { name: s.name, renderAssetId: asset?.id ?? null, renderFileHash: asset?.sha256 ?? null, sampleRate: layout.timeline.sampleRate, channelLayout: asset ? 'stereo' : 'none', totalFrames: s.totalFrames, markers: s.tracks.map(track => ({ trackId: track.trackId, exactSourceSha256: master.content.tracks.find(m => m.trackId === track.trackId)!.source.sha256, actualStartFrame: track.startFrame, actualEndFrame: track.endFrame, actualGapToNextFrames: track.gapAfterFrames, confirmationMethod: 'manual', userConfirmed: true })) };
  }) };
  const prep: FrozenPrepared = { id: randomUUID(), draftId: master.draftId, sequence: 1, preparationId: randomUUID(), importJobId: randomUUID(), masterVersionId: master.id, layoutVersionId: layout.id, contentHash: master.contentHash, plannedTimelineHash: layout.timelineHash, plannedTimeline: layout.timeline, renderTimeline: timeline, renderTimelineHash: mediaFingerprint(timeline), assets, conformance: { status: 'MATCHED', policy: 'one-render-frame-v1', reasons: [] }, varianceReason: '', daw: '合成 DAW 版本', processingLineage: '人工确认，不重复插入 Gap', createdAt: new Date().toISOString(), transitionRenderingMode: 'Baked Into Render', status: 'frozen', executionReady: false };
  assert.equal(isFrozenPrepared(prep), true);
  const inputs = assets.map(a => ({ assetId: a.id, input: { sha256: a.sha256, size: a.size, sampleRate: a.sampleRate, channelCount: 2 as const, bitsPerSample: 16 as const, totalFrames: a.totalFrames } }));
  return { prep, inputs };
}

test('数据库 Frozen M/L 到 Direct 实际文件：保留各面源帧，使用执行时基重新算 Gap', async t => {
  const f = await versions(t), selectedFormat = format(), recipes = planDirectExecution(f.master, f.layout, selectedFormat);
  assert.deepEqual(recipes.map(r => r.side), ['A','B']); assert.equal(recipes.every(isExecutionRecipe), true);
  assert.deepEqual(recipes[0]!.segments.map(s => s.endFrame - s.startFrame), [44100,44101,220500,44101,44100]);
  assert.deepEqual(recipes[1]!.segments.map(s => s.endFrame - s.startFrame), [44100,44101,44100]);
  const prior = structuredClone({ master: f.master, layout: f.layout });
  for (const recipe of recipes) {
    const handle = await open(path.join(f.directory, `${recipe.side}.execution.wav`), constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
    try {
      const locations = recipe.segments.filter(s => s.kind === 'source').map(s => ({ trackId: s.trackId, root: f.repository.sources.root(f.root.id), relative: path.basename(f.file) }));
      const result = await compileDirectPcm(recipe, locations, handle, new AbortController().signal);
      assert.equal(result.audio.frameCount, recipe.totalFrames); assert.equal(result.recipe.masterVersionId, f.master.id); assert.equal(result.recipe.layoutVersionId, f.layout.id);
      const bytes = await readFile(path.join(f.directory, `${recipe.side}.execution.wav`)); assert.equal(bytes.length, 44 + recipe.totalFrames * 4);
    } finally { await handle.close(); }
  }
  assert.deepEqual({ master: f.master, layout: f.layout }, prior);
  selectedFormat.sampleRate = 48000; assert.equal(recipes[0]!.format.sampleRate, 44100);
});
test('DAT 是一个 Program；空 B 保留零帧配方而不生成文件输入', async t => {
  const dat = await versions(t, { format: 'dat' }), datRecipes = planDirectExecution(dat.master, dat.layout, format());
  assert.deepEqual(datRecipes.map(r => r.side), ['Program']); assert.equal(datRecipes[0]!.segments.filter(s => s.kind === 'silence' && s.reason === 'gap').length, 2);
  const empty = await versions(t, { emptyB: true }), recipes = planDirectExecution(empty.master, empty.layout, format());
  assert.equal(recipes[1]!.side, 'B'); assert.equal(recipes[1]!.totalFrames, 0); assert.deepEqual(recipes[1]!.segments, []);
});
test('错误 M/L/内容/时间线/绑定引用拒绝，不根据当前草稿替换冻结事实', async t => {
  const f = await versions(t);
  for (const patch of [{ masterVersionId: randomUUID() }, { timelineHash: 'f'.repeat(64) }, { draftId: randomUUID() }]) rejects(() => planDirectExecution(f.master, { ...f.layout, ...patch }, format()), 'VERSION_MISMATCH');
  rejects(() => planDirectExecution({ ...f.master, contentHash: 'f'.repeat(64) }, f.layout, format()), 'VERSION_MISMATCH');
  const layout = structuredClone(f.layout); layout.timeline.sides[0]!.tracks[0]!.sourceBindingId = randomUUID(); layout.timelineHash = mediaFingerprint(layout.timeline);
  rejects(() => planDirectExecution(f.master, layout, format()), 'VERSION_MISMATCH');
});
test('不同采样率/位深/声道、浮点、SRC 和 dither 不被悄悄当作字节保持', async t => {
  const f = await versions(t);
  for (const patch of [{ sampleRate: 96000 }, { channelCount: 1 as const, channelLayout: 'mono' as const }, { outputSampleFormat: 'pcm-s24le' as const }, { outputSampleFormat: 'pcm-f32le' as const }, { internalProcessingPrecision: 'float64' as const }, { ditherPolicy: 'tpdf' as const }, { resamplerImplementation: 'soxr', resamplerVersion: 'unselected' }, { channelMapping: 'mono-to-stereo' as const }]) rejects(() => planDirectExecution(f.master, f.layout, { ...format(), ...patch }), 'CONVERSION_REQUIRED');
});
test('Prepared 计划引用实际 Render 帧；不插入已有 Gap，旧版本身份保留', async t => {
  const f = await versions(t), { prep, inputs } = prepared(f.master, f.layout), old = structuredClone(prep), selectedFormat = format(96000);
  const recipes = planPreparedExecution(f.master, f.layout, prep, selectedFormat, inputs);
  assert.equal(recipes.every(isExecutionRecipe), true);
  for (const r of recipes) { assert.equal(r.segments.length, 1); assert.equal(r.segments[0]!.kind, 'render'); assert.equal(r.totalFrames, prep.renderTimeline.sides.find(s => s.name === r.side)!.totalFrames); assert.equal(r.prepared!.id, prep.id); }
  rejects(() => planPreparedExecution(f.master, { ...f.layout, id: randomUUID() }, prep, selectedFormat, inputs), 'VERSION_MISMATCH');
  rejects(() => planPreparedExecution(f.master, f.layout, prep, format(44100), inputs), 'CONVERSION_REQUIRED');
  assert.deepEqual(prep, old);
});
test('Prepared 的实际时间线、人工确认、原件 Hash 和输入谱系逐一核验', async t => {
  const f = await versions(t), { prep, inputs } = prepared(f.master, f.layout);
  for (const patch of [{ renderTimelineHash: 'b'.repeat(64) }, { plannedTimelineHash: 'c'.repeat(64) }, { masterVersionId: randomUUID() }, { contentHash: 'f'.repeat(64) }]) rejects(() => planPreparedExecution(f.master, f.layout, { ...prep, ...patch }, format(96000), inputs), 'VERSION_MISMATCH');
  const unconfirmed = structuredClone(prep); unconfirmed.renderTimeline.sides[0]!.markers[0]!.userConfirmed = false; unconfirmed.renderTimelineHash = mediaFingerprint(unconfirmed.renderTimeline);
  rejects(() => planPreparedExecution(f.master, f.layout, unconfirmed, format(96000), inputs), 'VERSION_MISMATCH');
  rejects(() => planPreparedExecution(f.master, f.layout, prep, format(96000), []), 'VERSION_MISMATCH');
  rejects(() => planPreparedExecution(f.master, f.layout, prep, format(96000), inputs.map(i => ({ ...i, input: { ...i.input, sha256: 'c'.repeat(64) } }))), 'VERSION_MISMATCH');
});
test('已接受的 Render 时序差异使用实际帧，不回退计划 Marker；DAT/空 B 同样成立', async t => {
  for (const options of [{ format: 'dat' as const }, { emptyB: true }]) {
    const f = await versions(t, options), { prep, inputs } = prepared(f.master, f.layout);
    const changed = structuredClone(prep); changed.renderTimeline.sides[0]!.markers[0]!.actualStartFrame += 2; changed.renderTimelineHash = mediaFingerprint(changed.renderTimeline); changed.conformance = { status: 'ACCEPTED_VARIANCE', policy: 'one-render-frame-v1', reasons: ['TIMING_VARIANCE'] }; changed.varianceReason = '人工确认实际起点差两帧';
    const recipes = planPreparedExecution(f.master, f.layout, changed, format(96000), inputs); assert.equal(recipes[0]!.prepared!.renderTimelineHash, changed.renderTimelineHash);
    if (options.emptyB) { assert.equal(recipes[1]!.totalFrames, 0); assert.deepEqual(recipes[1]!.segments, []); }
    else assert.equal(recipes[0]!.side, 'Program');
  }
});

const conversionPlan = (input: AudioConversionSource, output: ExecutionFormat): AudioConversionPlan => ({
  schemaVersion: 1, input: structuredClone(input), format: structuredClone(output),
  converter: { id: 'fixture-converter', version: '1', binarySha256: 'a'.repeat(64), buildSha256: 'b'.repeat(64), components: [{ name: 'fixture-src', version: '1' }] },
  processing: { sourceExtent: 'whole-input', inputStreamIndex: 0, gain: 'unchanged', timestampCompensation: 'disabled', parameters: [] }, formalReady: false,
});
const convertedFormat = (rate = 96000): ExecutionFormat => ({ ...format(rate), internalProcessingPrecision: 'float64', outputSampleFormat: 'pcm-s24le', resamplerImplementation: 'ffmpeg-swr', resamplerVersion: '6.3.102' });

test('V2 Direct 保留冻结源及 Master/Layout，按输出率精确计划静音并报告 SRC 范围', async t => {
  const f = await versions(t), before = structuredClone({ master: f.master, layout: f.layout });
  const recipes = planConvertedDirectExecution(f.master, f.layout, convertedFormat(), conversionPlan);
  assert.equal(recipes.every(isConvertedExecutionRecipe), true);
  assert.deepEqual(recipes[0]!.segments.filter(s => s.kind === 'silence').map(s => s.frames), [96000,480000,96000]);
  assert.equal(recipes[0]!.minimumFrames, 864004); assert.equal(recipes[0]!.maximumFrames, 864006);
  const source = recipes[0]!.segments.find(s => s.kind === 'source')!;
  assert.equal(source.conversion.input.sha256, f.master.content.tracks[0]!.source.sha256);
  assert.equal(source.conversion.input.technical.sampleRate, 44100);
  assert.deepEqual({ master: f.master, layout: f.layout }, before);
  const mono = planConvertedDirectExecution(f.master, f.layout, { ...convertedFormat(), channelCount: 1, channelLayout: 'mono' }, conversionPlan);
  assert.equal(mono[0]!.segments.find(s => s.kind === 'source')!.conversion.format.channelMapping, 'stereo-to-mono');
  rejects(() => planConvertedDirectExecution({ ...f.master, contentHash: 'f'.repeat(64) }, f.layout, convertedFormat(), conversionPlan), 'VERSION_MISMATCH');
});

test('V2 PREP Derivative 锁定原 Render 证据，只计划整文件转换且保留空 B', async t => {
  const f = await versions(t, { emptyB: true }), { prep, inputs } = prepared(f.master, f.layout), before = structuredClone(prep);
  const sources = inputs.map(i => ({ assetId: i.assetId, source: { sha256: i.input.sha256, size: i.input.size, technical: { container: 'WAVE', codec: 'PCM', sampleRate: i.input.sampleRate, channels: i.input.channelCount, bitsPerSample: i.input.bitsPerSample, sampleFrames: i.input.totalFrames, frameEvidence: 'container-declared' as const, lossless: true, durationMs: Math.round(i.input.totalFrames / i.input.sampleRate * 1000) } } }));
  const recipes = planPreparedDerivative(f.master, f.layout, prep, convertedFormat(48000), sources, conversionPlan);
  assert.equal(recipes.every(isConvertedExecutionRecipe), true);
  assert.equal(recipes[0]!.segments.length, 1); assert.equal(recipes[0]!.segments[0]!.kind, 'render');
  assert.equal(recipes[0]!.prepared!.renderTimelineHash, prep.renderTimelineHash);
  assert.equal(recipes[1]!.maximumFrames, 0); assert.equal(recipes[1]!.segments.length, 0);
  assert.deepEqual(prep, before);
  rejects(() => planPreparedDerivative(f.master, f.layout, prep, convertedFormat(48000), sources.map(s => ({ ...s, source: { ...s.source, sha256: 'c'.repeat(64) } })), conversionPlan), 'VERSION_MISMATCH');
});
