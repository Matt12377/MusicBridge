import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdtemp, mkdir, open, readFile, realpath, rm, stat, symlink, link, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isExecutionAudioReceipt, isExecutionRecipe, isConvertedExecutionReceipt, type AudioConversionPlan, type AudioConversionReceipt, type ConvertedExecutionRecipe, type ExecutionFormat, type ExecutionRecipe, type ExecutionSegment } from '@music-bridge/contracts';
import { compileDirectPcm, verifyPreparedPcm } from '../src/recording/execution-compiler.js';
import { compileConvertedDirect, preparedDerivativeReceipt } from '../src/recording/converted-compiler.js';
import { mediaFingerprint } from '../src/recording/media-store.js';
import { authorizeSourceDirectory } from '../src/recording/source-files.js';
import { ExecutionCompileError } from '../src/recording/execution-plan.js';
import * as waveReader from '../src/recording/execution-wave.js';
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const signal = (): AbortSignal => new AbortController().signal;
function conversionWave(extensible: boolean, floating: boolean, channels: 1 | 2 = 2, frames = 7): { bytes: Buffer; pcm: Buffer; offset: number } {
  const bits = floating ? 32 : 24, pcm = Buffer.alloc(frames * channels * bits / 8);
  if (floating) for (let i = 0; i < frames * channels; i++) pcm.writeFloatLE((i - 4) / 2, i * 4);
  else for (let i = 0; i < pcm.length; i++) pcm[i] = (i * 7) % 256;
  const fmt = Buffer.alloc(extensible ? 48 : 26); fmt.write('fmt '); fmt.writeUInt32LE(fmt.length - 8, 4);
  fmt.writeUInt16LE(extensible ? 0xfffe : floating ? 3 : 1, 8); fmt.writeUInt16LE(channels, 10); fmt.writeUInt32LE(48000, 12);
  fmt.writeUInt32LE(48000 * channels * bits / 8, 16); fmt.writeUInt16LE(channels * bits / 8, 20); fmt.writeUInt16LE(bits, 22);
  if (extensible) {
    fmt.writeUInt16LE(22, 24); fmt.writeUInt16LE(bits, 26); fmt.writeUInt32LE(channels === 1 ? 4 : 3, 28);
    Buffer.from(floating ? '0300000000001000800000aa00389b71' : '0100000000001000800000aa00389b71', 'hex').copy(fmt, 32);
  }
  const fact = Buffer.alloc(12); fact.write('fact'); fact.writeUInt32LE(4, 4); fact.writeUInt32LE(frames, 8);
  const data = Buffer.alloc(8); data.write('data'); data.writeUInt32LE(pcm.length, 4);
  const body = Buffer.concat([fmt, fact, data, pcm, Buffer.alloc(pcm.length % 2)]), head = Buffer.alloc(12);
  head.write('RIFF'); head.writeUInt32LE(body.length + 4, 4); head.write('WAVE', 8);
  return { bytes: Buffer.concat([head, body]), pcm, offset: 12 + fmt.length + fact.length + data.length };
}
function conversionInspector(): (handle: FileHandle, format: ExecutionFormat, signal: AbortSignal) => Promise<{ sha256: string; pcmSha256: string; frameCount: number; size: number; dataOffset: number }> {
  const fn = (waveReader as unknown as Record<string, unknown>).inspectConversionOutput;
  assert.equal(typeof fn, 'function', '缺少输出回读接口；这是接线 RED，不能证明已实现转换');
  return fn as ReturnType<typeof conversionInspector>;
}
function wave(rate: number, channels: 1 | 2, bits: 16 | 24 | 32, frames: number, seed: number, metadata = false): { bytes: Buffer; pcm: Buffer; offset: number } {
  const pcm = Buffer.alloc(frames * channels * bits / 8);
  for (let i = channels * bits / 8; i < pcm.length - channels * bits / 8; i++) pcm[i] = (i + seed) % 256;
  const fmt = Buffer.alloc(24); fmt.write('fmt '); fmt.writeUInt32LE(16, 4); fmt.writeUInt16LE(1, 8); fmt.writeUInt16LE(channels, 10); fmt.writeUInt32LE(rate, 12); fmt.writeUInt32LE(rate * channels * bits / 8, 16); fmt.writeUInt16LE(channels * bits / 8, 20); fmt.writeUInt16LE(bits, 22);
  const data = Buffer.alloc(8); data.write('data'); data.writeUInt32LE(pcm.length, 4);
  const junk = Buffer.alloc(metadata ? 12 : 0); if (metadata) { junk.write('JUNK'); junk.writeUInt32LE(3, 4); junk.write('abc', 8); }
  const body = Buffer.concat([junk, fmt, data, pcm, Buffer.alloc(pcm.length % 2), junk]);
  const head = Buffer.alloc(12); head.write('RIFF'); head.writeUInt32LE(body.length + 4, 4); head.write('WAVE', 8);
  return { bytes: Buffer.concat([head, body]), pcm, offset: 44 + junk.length };
}
async function fixture(t: test.TestContext, options: { rate?: number; channels?: 1 | 2; bits?: 16 | 24 | 32; frames?: number; count?: number; gap?: number; metadata?: boolean } = {}) {
  const rate = options.rate ?? 96000, channels = options.channels ?? 2, bits = options.bits ?? 16, frames = options.frames ?? 97, count = options.count ?? 3;
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'musicbridge-pcm-'))), sourceDir = path.join(dir, 'sources'); await mkdir(sourceDir);
  const root = { ...await authorizeSourceDirectory(sourceDir), id: randomUUID() };
  const format: ExecutionFormat = { sampleRate: rate, channelCount: channels, channelLayout: channels === 1 ? 'mono' : 'stereo', internalProcessingPrecision: 'integer-bit-copy', outputSampleFormat: `pcm-s${bits}le`, resamplerImplementation: 'none', resamplerVersion: 'not-applied', ditherPolicy: 'none', channelMapping: 'identity', outputBackend: { id: 'isolated-test-no-output', version: '1' }, outputProfileVersion: randomUUID() };
  const waves = [], locations = [], segments: ExecutionSegment[] = []; let cursor = 0;
  for (let i = 0; i < count; i++) {
    const value = wave(rate, channels, bits, frames, i * 7, options.metadata), trackId = randomUUID(), relative = `${i}.wav`;
    waves.push(value); locations.push({ trackId, root, relative }); await writeFile(path.join(sourceDir, relative), value.bytes);
    segments.push({ kind: 'source', trackId, input: { sha256: digest(value.bytes), size: value.bytes.length, sampleRate: rate, channelCount: channels, bitsPerSample: bits, totalFrames: frames }, startFrame: cursor, endFrame: cursor + frames }); cursor += frames;
    const gap = options.gap ?? 5 * rate;
    if (i < count - 1 && gap) { segments.push({ kind: 'silence', reason: 'gap', startFrame: cursor, endFrame: cursor + gap }); cursor += gap; }
  }
  const recipe: ExecutionRecipe = { schemaVersion: 1, mode: 'direct', compiler: 'musicbridge-pcm-copy-v1', masterVersionId: randomUUID(), layoutVersionId: randomUUID(), contentHash: 'a'.repeat(64), plannedTimelineHash: 'b'.repeat(64), format, side: 'Program', capacityFrames: 60 * rate, totalFrames: cursor, segments, formalReady: false };
  assert.equal(isExecutionRecipe(recipe), true);
  const handles: FileHandle[] = [];
  const output = async () => { const file = path.join(dir, `${randomUUID()}.wav`), handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); handles.push(handle); return { file, handle }; };
  t.after(async () => { await Promise.all(handles.map(h => h.close())); await rm(dir, { recursive: true, force: true }); });
  return { dir, sourceDir, root, waves, locations, recipe, output, frames, rate, channels, bits };
}
const rejects = async (action: Promise<unknown>, code: string): Promise<void> => { await assert.rejects(action, e => e instanceof ExecutionCompileError && e.code === code && !e.message.includes('/')); };
function proxy(handle: FileHandle, overrides: Partial<FileHandle>): FileHandle { return new Proxy(handle, { get(target, key) { const v = key in overrides ? Reflect.get(overrides, key) : Reflect.get(target, key, target); return typeof v === 'function' ? v.bind(target) : v; } }); }

async function convertedFixture(t: test.TestContext, floating: boolean) {
  const f = await fixture(t, { count: 1, rate: 48000, frames: 48 }), value = conversionWave(true, floating, 2, 48);
  await writeFile(path.join(f.sourceDir, 'converted.wav'), value.bytes);
  const outputFormat: ExecutionFormat = { ...f.recipe.format, internalProcessingPrecision: 'float64', outputSampleFormat: floating ? 'pcm-f32le' : 'pcm-s24le' };
  const plan: AudioConversionPlan = { schemaVersion: 1, input: { sha256: digest(f.waves[0]!.bytes), size: f.waves[0]!.bytes.length, technical: { container: 'WAVE', codec: 'PCM', sampleRate: 48000, channels: 2, bitsPerSample: 16, sampleFrames: 48, frameEvidence: 'container-declared', durationMs: 1, lossless: true } }, format: outputFormat,
    converter: { id: 'fixture', version: '1', binarySha256: 'a'.repeat(64), buildSha256: 'b'.repeat(64), components: [{ name: 'fixture', version: '1' }] }, processing: { sourceExtent: 'whole-input', inputStreamIndex: 0, gain: 'unchanged', timestampCompensation: 'disabled', parameters: [] }, formalReady: false };
  const conversion: AudioConversionReceipt = { plan, planHash: mediaFingerprint(plan), decoded: { codec: 'pcm_s16le', sampleRate: 48000, channelCount: 2, sampleFormat: 's16', frameCount: 48, wholeInputConsumed: true }, audio: { sha256: digest(value.bytes), pcmSha256: digest(value.pcm), size: value.bytes.length, dataOffset: value.offset, frameCount: 48 }, formalReady: false };
  const ids = [randomUUID(),randomUUID()];
  const recipe: ConvertedExecutionRecipe = { schemaVersion: 2, compiler: 'musicbridge-conversion-v2', mode: 'direct', masterVersionId: f.recipe.masterVersionId, layoutVersionId: f.recipe.layoutVersionId, contentHash: f.recipe.contentHash, plannedTimelineHash: f.recipe.plannedTimelineHash, format: outputFormat, side: 'Program', capacityFrames: 48000, minimumFrames: 99, maximumFrames: 99,
    segments: [{ kind: 'source', trackId: ids[0]!, conversion: plan }, { kind: 'silence', reason: 'gap', frames: 3 }, { kind: 'source', trackId: ids[1]!, conversion: plan }], formalReady: false };
  return { ...f, value, conversion, recipe, converted: ids.map(trackId => ({ trackId, root: f.root, relative: 'converted.wav', receipt: conversion })) };
}

test('V2 编译逐字节保留整数/浮点转换结果，Gap 是精确数字零且回执按实际帧拼接', async t => {
  for (const floating of [false,true]) {
    const f = await convertedFixture(t, floating), output = await f.output();
    const result = await compileConvertedDirect(f.recipe, f.converted, output.handle, signal());
    assert.equal(isConvertedExecutionReceipt(result), true);
    const bytes = await readFile(output.file), pcm = Buffer.concat([f.value.pcm, Buffer.alloc(3 * 2 * (floating ? 4 : 3)), f.value.pcm]);
    assert.deepEqual(bytes.subarray(result.audio.dataOffset, result.audio.dataOffset + pcm.length), pcm);
    assert.equal(result.audio.pcmSha256, digest(pcm)); assert.equal(result.audio.sha256, digest(bytes));
    assert.deepEqual(result.segments.map(s => [s.startFrame,s.endFrame]), [[0,48],[48,51],[51,99]]);
    assert.deepEqual(await readFile(path.join(f.sourceDir, 'converted.wav')), f.value.bytes);
  }
});

test('V2 编译拒绝伪造转换计划 Hash、损坏转换文件与撤权；不覆盖已有输出', async t => {
  for (const fault of ['plan-hash','changed','revoked','occupied']) {
    const f = await convertedFixture(t, false), output = await f.output();
    if (fault === 'plan-hash') f.converted[0]!.receipt = { ...f.conversion, planHash: 'f'.repeat(64) };
    if (fault === 'changed') { const bytes = Buffer.from(f.value.bytes); bytes[f.value.offset] = bytes[f.value.offset]! ^ 1; await writeFile(path.join(f.sourceDir, 'converted.wav'), bytes); }
    if (fault === 'revoked') f.root.authorized = false;
    if (fault === 'occupied') await output.handle.writeFile('keep');
    await rejects(compileConvertedDirect(f.recipe, f.converted, output.handle, signal()), fault === 'changed' ? 'HASH_MISMATCH' : fault === 'revoked' ? 'SOURCE_UNAVAILABLE' : 'INVALID_INPUT');
    assert.equal((await output.handle.stat()).size, fault === 'occupied' ? 4 : 0);
  }
});

test('V2 PREP 回执直接绑定独立转换字节，不再次编译、插 Gap 或改原 Render 谱系', async t => {
  const f = await convertedFixture(t, true), renderAssetId = randomUUID();
  const recipe: ConvertedExecutionRecipe = { ...f.recipe, mode: 'prepared-derivative', prepared: { id: randomUUID(), renderTimelineHash: 'e'.repeat(64) }, minimumFrames: 48, maximumFrames: 48, segments: [{ kind: 'render', renderAssetId, conversion: f.conversion.plan }] };
  const result = preparedDerivativeReceipt(recipe, f.conversion);
  assert.equal(isConvertedExecutionReceipt(result), true); assert.deepEqual(result.audio, f.conversion.audio);
  assert.equal(result.origin, 'derived-render'); assert.equal(result.segments.length, 1);
  assert.throws(() => preparedDerivativeReceipt(recipe, { ...f.conversion, planHash: 'f'.repeat(64) }), (error: unknown) => error instanceof ExecutionCompileError && error.code === 'INVALID_INPUT');
});

test('最终 96k WAV 的两个 Gap 各 480000 帧，源首尾静音和全部 PCM 字节保留', async t => {
  const f = await fixture(t), output = await f.output(), before = await Promise.all(f.locations.map(l => stat(path.join(f.sourceDir, l.relative), { bigint: true })));
  const receipt = await compileDirectPcm(f.recipe, f.locations, output.handle, signal());
  const bytes = await readFile(output.file), expected = Buffer.concat([f.waves[0]!.pcm, Buffer.alloc(480000 * 4), f.waves[1]!.pcm, Buffer.alloc(480000 * 4), f.waves[2]!.pcm]);
  assert.deepEqual(bytes.subarray(44), expected); assert.equal(bytes.readUInt32LE(40), expected.length); assert.equal(bytes.readUInt32LE(4), bytes.length - 8);
  assert.equal(receipt.audio.frameCount, f.frames * 3 + 960000); assert.equal(receipt.audio.sha256, digest(bytes)); assert.equal(receipt.audio.pcmSha256, digest(expected)); assert.equal(isExecutionAudioReceipt(receipt), true); assert.equal(receipt.formalReady, false);
  for (const [i, l] of f.locations.entries()) { const after = await stat(path.join(f.sourceDir, l.relative), { bigint: true }); assert.equal(after.mtimeNs, before[i]!.mtimeNs); assert.equal(after.ctimeNs, before[i]!.ctimeNs); assert.deepEqual(await readFile(path.join(f.sourceDir, l.relative)), f.waves[i]!.bytes); }
  const second = await f.output(), repeated = await compileDirectPcm(f.recipe, f.locations, second.handle, signal()); assert.deepEqual(repeated, receipt); assert.deepEqual(await readFile(second.file), bytes);
  if (process.env.MUSIC_BRIDGE_PCM_TEST_EVIDENCE) {
    // 仅测试入口显式提供的全新目录；不存在时创建，禁止覆盖历史证据。
    const dir = process.env.MUSIC_BRIDGE_PCM_TEST_EVIDENCE; await mkdir(dir);
    await writeFile(path.join(dir, 'Program.execution.wav'), bytes, { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(dir, 'Receipt.json'), JSON.stringify(receipt, null, 2), { flag: 'wx', mode: 0o600 });
    for (const [i, w] of f.waves.entries()) await writeFile(path.join(dir, `source-${i + 1}.wav`), w.bytes, { flag: 'wx', mode: 0o600 });
  }
});
test('16/24/32 bit、mono/stereo、44.1/48k 与奇数数据块填充保持实际帧', async t => {
  for (const bits of [16,24,32] as const) for (const channels of [1,2] as const) {
    const f = await fixture(t, { bits, channels, rate: bits === 24 ? 44100 : 48000, frames: 3, count: 2, gap: 0, metadata: true }), output = await f.output();
    const receipt = await compileDirectPcm(f.recipe, f.locations, output.handle, signal()), bytes = await readFile(output.file), pcm = Buffer.concat(f.waves.map(w => w.pcm));
    assert.deepEqual(bytes.subarray(44, 44 + pcm.length), pcm); assert.equal(bytes.length, 44 + pcm.length + pcm.length % 2); assert.equal(receipt.audio.frameCount, 6);
  }
  const f = await fixture(t, { bits: 24, channels: 1, frames: 3, count: 1 }), output = await f.output();
  const receipt = await compileDirectPcm(f.recipe, f.locations, output.handle, signal()); assert.equal(receipt.audio.size, 54); assert.equal((await readFile(output.file))[53], 0);
});
test('Lead-in、Tail、零 Gap 和空 B 不会伪造尾部曲间间隔或空文件回执', async t => {
  const f = await fixture(t, { count: 1 }), output = await f.output(), s = f.recipe.segments[0]!;
  const recipe = { ...f.recipe, totalFrames: f.frames + 5, segments: [{ kind: 'silence' as const, reason: 'lead-in' as const, startFrame: 0, endFrame: 2 }, { ...s, startFrame: 2, endFrame: f.frames + 2 }, { kind: 'silence' as const, reason: 'tail' as const, startFrame: f.frames + 2, endFrame: f.frames + 5 }] };
  await compileDirectPcm(recipe, f.locations, output.handle, signal()); assert.deepEqual((await readFile(output.file)).subarray(44), Buffer.concat([Buffer.alloc(8), f.waves[0]!.pcm, Buffer.alloc(12)]));
  const empty = await f.output(); await rejects(compileDirectPcm({ ...f.recipe, side: 'B', totalFrames: 0, segments: [] }, [], empty.handle, signal()), 'INVALID_INPUT'); assert.equal((await empty.handle.stat()).size, 0);
});
test('Prepared 返回同一原始 Render Hash，不复制或再次加 Gap', async t => {
  const f = await fixture(t, { count: 1, metadata: true }), source = f.recipe.segments[0]!;
  assert.equal(source.kind, 'source'); if (source.kind !== 'source') return;
  const renderAssetId = randomUUID(), recipe: ExecutionRecipe = { ...f.recipe, mode: 'prepared-reference', prepared: { id: randomUUID(), renderTimelineHash: 'd'.repeat(64) }, segments: [{ kind: 'render', renderAssetId, input: source.input, startFrame: 0, endFrame: f.frames }] };
  const before = await stat(path.join(f.sourceDir, '0.wav'), { bigint: true });
  const receipt = await verifyPreparedPcm(recipe, { renderAssetId, root: f.root, relative: '0.wav' }, signal());
  assert.equal(receipt.audio.sha256, digest(f.waves[0]!.bytes)); assert.equal(receipt.audio.size, f.waves[0]!.bytes.length); assert.equal(receipt.audio.dataOffset, f.waves[0]!.offset); assert.equal(receipt.origin, 'retained-render'); assert.equal(isExecutionAudioReceipt(receipt), true);
  const after = await stat(path.join(f.sourceDir, '0.wav'), { bigint: true }); assert.equal(after.mtimeNs, before.mtimeNs); assert.equal(after.ctimeNs, before.ctimeNs);
});
test('输入完整 Hash 变化、撤权和链接越界均拒绝且不写目标', async t => {
  for (const fault of ['changed','revoked','link'] as const) {
    const f = await fixture(t, { count: 1 }), output = await f.output();
    if (fault === 'changed') { const bytes = Buffer.from(f.waves[0]!.bytes); bytes[44] = bytes[44]! ^ 1; await writeFile(path.join(f.sourceDir, '0.wav'), bytes); }
    if (fault === 'revoked') f.root.authorized = false;
    if (fault === 'link') { await symlink(path.join(f.sourceDir, '0.wav'), path.join(f.sourceDir, 'linked.wav')); f.locations[0]!.relative = 'linked.wav'; }
    await rejects(compileDirectPcm(f.recipe, f.locations, output.handle, signal()), fault === 'changed' ? 'HASH_MISMATCH' : 'SOURCE_UNAVAILABLE'); assert.equal((await output.handle.stat()).size, 0);
  }
});
test('非空目标、硬链接目标、缺少曲目定位和重复定位不能编译', async t => {
  const f = await fixture(t), output = await f.output();
  await output.handle.write(Buffer.from('keep')); await rejects(compileDirectPcm(f.recipe, f.locations, output.handle, signal()), 'INVALID_INPUT'); assert.equal((await readFile(output.file)).toString(), 'keep');
  const linked = await f.output(); await link(linked.file, path.join(f.dir, 'alias')); await rejects(compileDirectPcm(f.recipe, f.locations, linked.handle, signal()), 'INVALID_INPUT');
  const empty = await f.output(); await rejects(compileDirectPcm(f.recipe, [], empty.handle, signal()), 'INVALID_INPUT'); await rejects(compileDirectPcm(f.recipe, [f.locations[0]!, f.locations[0]!, f.locations[2]!], empty.handle, signal()), 'INVALID_INPUT');
});
test('复制期间源变化、取消、撤权不产生成功回执', async t => {
  for (const fault of ['change','cancel','revoke'] as const) {
    const f = await fixture(t, { count: 1 }), output = await f.output(), controller = new AbortController(); let fired = false;
    const wrapped = proxy(output.handle, { write: (async (b: Buffer, offset: number, length: number, position: number) => {
      const result = await output.handle.write(b, offset, length, position);
      if (!fired && position >= 44) { fired = true; if (fault === 'cancel') controller.abort(); else if (fault === 'revoke') f.root.authorized = false; else { const changed = Buffer.from(f.waves[0]!.bytes); changed[45] = changed[45]! ^ 1; await writeFile(path.join(f.sourceDir, '0.wav'), changed); } }
      return result;
    }) as unknown as FileHandle['write'] });
    await rejects(compileDirectPcm(f.recipe, f.locations, wrapped, controller.signal), fault === 'change' ? 'INPUT_CHANGED' : fault === 'cancel' ? 'CANCELLED' : 'SOURCE_UNAVAILABLE'); assert.equal(fired, true);
  }
});
test('短写正确循环，磁盘满/零写/回读篡改返回有界错误而非文件成功', async t => {
  const f = await fixture(t, { count: 1 }), short = await f.output();
  const wrapped = proxy(short.handle, { write: (async (b: Buffer, offset: number, length: number, position: number) => short.handle.write(b, offset, Math.min(7, length), position)) as FileHandle['write'] });
  const receipt = await compileDirectPcm(f.recipe, f.locations, wrapped, signal()); assert.equal(receipt.audio.sha256, digest(await readFile(short.file)));
  for (const fault of ['full','zero','tamper'] as const) {
    const output = await f.output();
    const bad = proxy(output.handle, fault === 'tamper' ? { sync: async () => { await output.handle.sync(); await output.handle.write(Buffer.from([127]), 0, 1, 44); } } : { write: (async () => { if (fault === 'full') throw Object.assign(new Error('/private/ENOSPC'), { code: 'ENOSPC' }); return { bytesWritten: 0, buffer: Buffer.alloc(0) }; }) as unknown as FileHandle['write'] });
    await rejects(compileDirectPcm(f.recipe, f.locations, bad, signal()), fault === 'tamper' ? 'HASH_MISMATCH' : fault === 'full' ? 'DISK_FULL' : 'IO_ERROR');
  }
});
test('明确不支持的格式、畸形 RIFF/重复数据/错误块对齐在写入前阻断', async t => {
  for (const fault of ['float','extensible','align','duplicate','trailing','frames','magic'] as const) {
    const f = await fixture(t, { count: 1 }), output = await f.output(); let bytes: Buffer = Buffer.from(f.waves[0]!.bytes);
    if (fault === 'magic') bytes[0] = bytes[0]! | 0x80;
    if (fault === 'float') bytes.writeUInt16LE(3, 20);
    if (fault === 'extensible') bytes.writeUInt16LE(0xfffe, 20);
    if (fault === 'align') bytes.writeUInt16LE(8, 32);
    if (fault === 'duplicate') { bytes = Buffer.concat([bytes, bytes.subarray(36)]); bytes.writeUInt32LE(bytes.length - 8, 4); }
    if (fault === 'trailing') bytes = Buffer.concat([bytes, Buffer.from([1])]);
    await writeFile(path.join(f.sourceDir, '0.wav'), bytes);
    const s = f.recipe.segments[0]!; if (s.kind !== 'source') throw new Error('合成曲目缺失');
    const frames = fault === 'frames' ? f.frames - 1 : f.frames;
    const recipe = { ...f.recipe, totalFrames: frames, segments: [{ ...s, endFrame: frames, input: { ...s.input, totalFrames: frames, sha256: digest(bytes), size: bytes.length } }] };
    await rejects(compileDirectPcm(recipe, f.locations, output.handle, signal()), fault === 'frames' ? 'FRAME_MISMATCH' : 'UNSUPPORTED_WAVE'); assert.equal((await output.handle.stat()).size, 0);
  }
});
test('预取消和超过 RIFF 上限的配方不写目标', async t => {
  const f = await fixture(t, { count: 1 }), output = await f.output(), controller = new AbortController(); controller.abort();
  await rejects(compileDirectPcm(f.recipe, f.locations, output.handle, controller.signal), 'CANCELLED');
  const frames = 0x40000000, s = f.recipe.segments[0]!;
  const recipe = { ...f.recipe, capacityFrames: frames, totalFrames: frames, segments: [s, { kind: 'silence' as const, reason: 'tail' as const, startFrame: f.frames, endFrame: frames }] };
  await rejects(compileDirectPcm(recipe, f.locations, output.handle, signal()), 'LIMIT_EXCEEDED'); assert.equal((await output.handle.stat()).size, 0);
});
test('最终回读期间撤销任一源 Root，不得返回编译成功', async t => {
  const f = await fixture(t, { count: 1 }), output = await f.output();
  const wrapped = proxy(output.handle, { sync: async () => { await output.handle.sync(); f.root.authorized = false; } });
  await rejects(compileDirectPcm(f.recipe, f.locations, wrapped, signal()), 'SOURCE_UNAVAILABLE');
});
test('Prepared 的合法 RIFF 子块顺序不改变字节身份或误报转换需求', async t => {
  const f = await fixture(t, { count: 1 }), original = f.waves[0]!.bytes;
  const reordered = Buffer.concat([original.subarray(0,12), original.subarray(36), original.subarray(12,36)]);
  await writeFile(path.join(f.sourceDir, '0.wav'), reordered);
  const s = f.recipe.segments[0]!; if (s.kind !== 'source') throw new Error('合成曲目缺失');
  const renderAssetId = randomUUID(), recipe: ExecutionRecipe = { ...f.recipe, mode: 'prepared-reference', prepared: { id: randomUUID(), renderTimelineHash: 'd'.repeat(64) }, segments: [{ kind: 'render', renderAssetId, input: { ...s.input, sha256: digest(reordered) }, startFrame: 0, endFrame: f.frames }] };
  const result = await verifyPreparedPcm(recipe, { renderAssetId, root: f.root, relative: '0.wav' }, signal());
  assert.equal(result.audio.dataOffset, 20); assert.equal(result.audio.sha256, digest(reordered));
});
test('整体编译有明确超时，不以卡住的读取来证明成功', async t => {
  const f = await fixture(t, { count: 1 }), output = await f.output(); let calls = 0;
  t.mock.method(Date, 'now', () => 1000000 + calls++ * 16 * 60_000);
  await rejects(compileDirectPcm(f.recipe, f.locations, output.handle, signal()), 'LIMIT_EXCEEDED'); assert.equal((await output.handle.stat()).size, 0);
});

test('转换输出回读实际整数/浮点及扩展 WAV，整文件和 PCM 分别 Hash；旧复制入口仍拒绝', async t => {
  const inspect = conversionInspector(), f = await fixture(t, { count: 1 });
  for (const extensible of [false, true]) for (const floating of [false, true]) for (const channels of [1, 2] as const) {
    const value = conversionWave(extensible, floating, channels), output = await f.output(); await output.handle.writeFile(value.bytes);
    const format: ExecutionFormat = { ...f.recipe.format, sampleRate: 48000, channelCount: channels, channelLayout: channels === 1 ? 'mono' : 'stereo', outputSampleFormat: floating ? 'pcm-f32le' : 'pcm-s24le', internalProcessingPrecision: 'float64' };
    const before = await output.handle.stat({ bigint: true }), evidence = await inspect(output.handle, format, signal());
    assert.deepEqual(evidence, { sha256: digest(value.bytes), pcmSha256: digest(value.pcm), frameCount: 7, size: value.bytes.length, dataOffset: value.offset });
    const after = await output.handle.stat({ bigint: true }); assert.equal(after.mtimeNs, before.mtimeNs); assert.equal(after.ctimeNs, before.ctimeNs);
    await rejects(waveReader.readPcmWave(output.handle, value.bytes.length, () => undefined), 'UNSUPPORTED_WAVE');
  }
});

test('转换输出拒绝错误 GUID、有效位宽、声道位置、fact 帧数、重复数据和非有限浮点', async t => {
  const inspect = conversionInspector(), f = await fixture(t, { count: 1 });
  for (const fault of ['guid','valid-bits','mask','fact','duplicate','nan','infinity','magic','trailing'] as const) {
    const value = conversionWave(true, true); let bytes: Buffer = Buffer.from(value.bytes);
    if (fault === 'guid') bytes[59] = bytes[59]! ^ 1;
    if (fault === 'valid-bits') bytes.writeUInt16LE(24, 38);
    if (fault === 'mask') bytes.writeUInt32LE(5, 40);
    if (fault === 'fact') bytes.writeUInt32LE(8, 68);
    if (fault === 'duplicate') { bytes = Buffer.concat([bytes, bytes.subarray(value.offset - 8)]); bytes.writeUInt32LE(bytes.length - 8, 4); }
    if (fault === 'nan' || fault === 'infinity') bytes.writeFloatLE(fault === 'nan' ? NaN : Infinity, value.offset + 4);
    if (fault === 'magic') bytes[0] = bytes[0]! | 0x80;
    if (fault === 'trailing') bytes = Buffer.concat([bytes, Buffer.alloc(1)]);
    const output = await f.output(); await output.handle.writeFile(bytes);
    await rejects(inspect(output.handle, { ...f.recipe.format, sampleRate: 48000, outputSampleFormat: 'pcm-f32le', internalProcessingPrecision: 'float64' }, signal()), 'UNSUPPORTED_WAVE');
  }
});

test('转换输出格式与预期不符、读取中变化、取消和私有 IO 异常不能生成文件证据', async t => {
  const inspect = conversionInspector(), f = await fixture(t, { count: 1 }), value = conversionWave(true, true);
  const output = await f.output(); await output.handle.writeFile(value.bytes);
  const format: ExecutionFormat = { ...f.recipe.format, sampleRate: 48000, outputSampleFormat: 'pcm-f32le', internalProcessingPrecision: 'float64' };
  await rejects(inspect(output.handle, { ...format, outputSampleFormat: 'pcm-s32le' }, signal()), 'CONVERSION_REQUIRED');
  const controller = new AbortController(); controller.abort(); await rejects(inspect(output.handle, format, controller.signal), 'CANCELLED');
  const bad = proxy(output.handle, { read: (async () => { throw new Error('/private/output-name.wav'); }) as unknown as FileHandle['read'] });
  await rejects(inspect(bad, format, signal()), 'IO_ERROR');
  let changed = false;
  const changing = proxy(output.handle, { read: (async (b: Buffer, offset: number, length: number, position: number) => {
    const result = await output.handle.read(b, offset, length, position);
    if (!changed && position === value.offset) { changed = true; await output.handle.truncate(value.bytes.length + 4); }
    return result;
  }) as FileHandle['read'] });
  await rejects(inspect(changing, format, signal()), 'INPUT_CHANGED'); assert.equal(changed, true);
});

test('转换回读短读补齐；超过首个缓冲区的 NaN 和中途取消仍被检测', async t => {
  const inspect = conversionInspector(), f = await fixture(t, { count: 1 }), output = await f.output(), small = conversionWave(true, true);
  const frames = 131080, pcm = Buffer.alloc(frames * 8), bytes = Buffer.concat([small.bytes.subarray(0, small.offset), pcm]);
  bytes.writeUInt32LE(bytes.length - 8, 4); bytes.writeUInt32LE(frames, 68); bytes.writeUInt32LE(pcm.length, small.offset - 4);
  await output.handle.writeFile(bytes);
  const format: ExecutionFormat = { ...f.recipe.format, sampleRate: 48000, outputSampleFormat: 'pcm-f32le', internalProcessingPrecision: 'float64' };
  const short = proxy(output.handle, { read: (async (b: Buffer, offset: number, length: number, position: number) => output.handle.read(b, offset, Math.min(4093, length), position)) as FileHandle['read'] });
  const evidence = await inspect(short, format, signal()); assert.equal(evidence.frameCount, frames); assert.equal(evidence.pcmSha256, digest(pcm));
  const nan = Buffer.alloc(4); nan.writeFloatLE(NaN); await output.handle.write(nan, 0, 4, small.offset + 1024 * 1024 + 4);
  await rejects(inspect(short, format, signal()), 'UNSUPPORTED_WAVE');
  await output.handle.write(Buffer.alloc(4), 0, 4, small.offset + 1024 * 1024 + 4);
  const controller = new AbortController();
  const cancel = proxy(output.handle, { read: (async (b: Buffer, offset: number, length: number, position: number) => {
    const result = await output.handle.read(b, offset, length, position); if (position >= small.offset) controller.abort(); return result;
  }) as FileHandle['read'] });
  await rejects(inspect(cancel, format, controller.signal), 'CANCELLED');
});

test('转换回读同时限制墙钟和单调时钟，拒绝硬链接输出', async t => {
  const inspect = conversionInspector(), f = await fixture(t, { count: 1 }), value = conversionWave(true, true), output = await f.output();
  await output.handle.writeFile(value.bytes);
  const format: ExecutionFormat = { ...f.recipe.format, sampleRate: 48000, outputSampleFormat: 'pcm-f32le', internalProcessingPrecision: 'float64' };
  for (const clock of [Date, performance]) {
    let calls = 0; const mock = t.mock.method(clock, 'now', () => 1000000 + calls++ * 16 * 60_000);
    await rejects(inspect(output.handle, format, signal()), 'LIMIT_EXCEEDED'); mock.mock.restore();
  }
  await link(output.file, path.join(f.dir, 'linked-output'));
  await rejects(inspect(output.handle, format, signal()), 'INVALID_INPUT');
});
