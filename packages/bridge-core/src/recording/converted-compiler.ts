import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { isAudioConversionReceipt, isConvertedExecutionRecipe, isConvertedExecutionReceipt, type AudioConversionReceipt, type ConvertedExecutionRecipe, type ConvertedExecutionReceipt, type ExecutionFormat } from '@music-bridge/contracts';
import { mediaFingerprint } from './media-store.js';
import { ExecutionCompileError, executionFail } from './execution-plan.js';
import { inspectConversionOutput, pcmWaveHeader, readExactly } from './execution-wave.js';
import { SourceFileError, withVerifiedReadonlySource, type RootCapability } from './source-files.js';

export interface ConvertedSourceLocation { trackId: string; root: RootCapability; relative: string; receipt: AudioConversionReceipt }
function matches(receipt: AudioConversionReceipt, plan: AudioConversionReceipt['plan']): boolean {
  return isAudioConversionReceipt(receipt) && receipt.planHash === mediaFingerprint(receipt.plan) && mediaFingerprint(receipt.plan) === mediaFingerprint(plan);
}
function header(format: ExecutionFormat, frames: number): Buffer {
  const bits = Number(format.outputSampleFormat.slice(5,7)), pcm = pcmWaveHeader(format.sampleRate, format.channelCount, bits, frames);
  if (format.outputSampleFormat !== 'pcm-f32le') return pcm;
  const size = frames * format.channelCount * 4;
  if (size + 48 > 0xffffffff) return executionFail('LIMIT_EXCEEDED');
  const bytes = Buffer.alloc(56); pcm.subarray(0,36).copy(bytes);
  bytes.writeUInt32LE(size + 48, 4); bytes.writeUInt16LE(3, 20);
  bytes.write('fact', 36); bytes.writeUInt32LE(4, 40); bytes.writeUInt32LE(frames, 44);
  bytes.write('data', 48); bytes.writeUInt32LE(size, 52); return bytes;
}
/** 绑定已经独立生成的 Derivative；本函数不声称文件当前仍在线，也不发布资产。 */
export function preparedDerivativeReceipt(input: ConvertedExecutionRecipe, conversion: AudioConversionReceipt): ConvertedExecutionReceipt {
  if (!isConvertedExecutionRecipe(input) || input.mode !== 'prepared-derivative') return executionFail('INVALID_INPUT');
  const segment = input.segments[0];
  if (segment?.kind !== 'render' || !matches(conversion, segment.conversion)) return executionFail('INVALID_INPUT');
  const recipe = structuredClone(input), receipt: ConvertedExecutionReceipt = { recipe, recipeHash: mediaFingerprint(recipe), origin: 'derived-render', segments: [{ startFrame: 0, endFrame: conversion.audio.frameCount, conversion: structuredClone(conversion) }], audio: structuredClone(conversion.audio), formalReady: false };
  if (!isConvertedExecutionReceipt(receipt)) return executionFail('INVALID_INPUT');
  return receipt;
}
/** 转换文件必须先完整核验；只复制 PCM 字节并插入数字零，不再运行 SRC 或 dither。 */
export async function compileConvertedDirect(input: ConvertedExecutionRecipe, locations: readonly ConvertedSourceLocation[], destination: FileHandle, signal: AbortSignal, checkOperation: () => void = () => undefined): Promise<ConvertedExecutionReceipt> {
  const wall = Date.now() + 15 * 60_000, monotonic = performance.now() + 15 * 60_000;
  const check = (): void => {
    checkOperation();
    if (signal.aborted) return executionFail('CANCELLED');
    if (Date.now() > wall || performance.now() > monotonic) return executionFail('LIMIT_EXCEEDED');
    if (locations.some(l => !l.root.authorized)) return executionFail('SOURCE_UNAVAILABLE');
  };
  try {
    check();
    if (!isConvertedExecutionRecipe(input) || input.mode !== 'direct' || !input.segments.length) return executionFail('INVALID_INPUT');
    const recipe = structuredClone(input), expected = recipe.segments.filter(s => s.kind === 'source');
    if (locations.length !== expected.length || new Set(locations.map(l => l.trackId)).size !== locations.length) return executionFail('INVALID_INPUT');
    const sources = expected.map(s => {
      const location = locations.find(l => l.trackId === s.trackId);
      if (!location || !matches(location.receipt, s.conversion)) return executionFail('INVALID_INPUT');
      return { ...location, receipt: structuredClone(location.receipt) };
    });
    const segments: ConvertedExecutionReceipt['segments'][number][] = []; let cursor = 0;
    for (const segment of recipe.segments) {
      const conversion = segment.kind === 'source' ? sources.find(l => l.trackId === segment.trackId)!.receipt : undefined;
      const count = segment.kind === 'silence' ? segment.frames : conversion!.audio.frameCount;
      segments.push({ startFrame: cursor, endFrame: cursor + count, ...(conversion ? { conversion } : {}) }); cursor += count;
    }
    const target = await destination.stat({ bigint: true }), bytesHeader = header(recipe.format, cursor);
    if (!target.isFile() || target.nlink !== 1n || target.size !== 0n) return executionFail('INVALID_INPUT');
    async function verified<T>(location: ConvertedSourceLocation, consume: (handle: FileHandle, check: () => void) => Promise<T>): Promise<T> {
      return withVerifiedReadonlySource(location.root, location.relative, location.receipt.audio, signal, async (handle, sourceCheck) => {
        const checked = (): void => { check(); sourceCheck(); };
        const info = await handle.stat({ bigint: true });
        if (info.dev === target.dev && info.ino === target.ino) return executionFail('INVALID_INPUT');
        const actual = await inspectConversionOutput(handle, recipe.format, signal, checked);
        if (mediaFingerprint(actual) !== mediaFingerprint(location.receipt.audio)) return executionFail('HASH_MISMATCH');
        return consume(handle, checked);
      }, check);
    }
    for (const source of sources) await verified(source, async () => undefined);
    const wholeHash = createHash('sha256'), pcmHash = createHash('sha256'); let position = 0;
    async function write(bytes: Buffer, audio: boolean): Promise<void> {
      let offset = 0;
      while (offset < bytes.length) { check(); const { bytesWritten } = await destination.write(bytes, offset, bytes.length - offset, position + offset); if (!bytesWritten) return executionFail('IO_ERROR'); offset += bytesWritten; }
      wholeHash.update(bytes); if (audio) pcmHash.update(bytes); position += bytes.length;
    }
    await write(bytesHeader, false);
    const blockAlign = recipe.format.channelCount * Number(recipe.format.outputSampleFormat.slice(5,7)) / 8, zeros = Buffer.alloc(1024 * 1024);
    for (const [i,segment] of recipe.segments.entries()) {
      const actual = segments[i]!;
      if (segment.kind === 'silence') {
        let remaining = segment.frames * blockAlign;
        while (remaining) { const count = Math.min(remaining, zeros.length); await write(zeros.subarray(0,count), true); remaining -= count; }
      } else if (segment.kind === 'source') {
        const location = sources.find(l => l.trackId === segment.trackId)!;
        await verified(location, async (handle, checked) => {
          const count = (actual.endFrame - actual.startFrame) * blockAlign;
          for (let offset = 0; offset < count;) {
            const bytes = await readExactly(handle, Math.min(1024 * 1024, count - offset), location.receipt.audio.dataOffset + offset, checked);
            await write(bytes, true); offset += bytes.length;
          }
        });
      }
    }
    if (cursor * blockAlign % 2) await write(Buffer.alloc(1), false);
    check(); await destination.sync();
    const beforeReadback = await destination.stat({ bigint: true });
    const audio = await inspectConversionOutput(destination, recipe.format, signal, check);
    if (audio.sha256 !== wholeHash.digest('hex') || audio.pcmSha256 !== pcmHash.digest('hex') || audio.frameCount !== cursor) return executionFail('HASH_MISMATCH');
    for (const source of sources) await verified(source, async () => undefined);
    const after = await destination.stat({ bigint: true }); check();
    if (after.dev !== target.dev || after.ino !== target.ino || after.size !== BigInt(audio.size) || after.nlink !== 1n || after.mtimeNs !== beforeReadback.mtimeNs || after.ctimeNs !== beforeReadback.ctimeNs) return executionFail('INPUT_CHANGED');
    const receipt: ConvertedExecutionReceipt = { recipe, recipeHash: mediaFingerprint(recipe), origin: 'compiled', segments, audio, formalReady: false };
    if (!isConvertedExecutionReceipt(receipt)) return executionFail('INVALID_INPUT');
    return receipt;
  } catch (error) {
    if (error instanceof ExecutionCompileError) throw error;
    if (error instanceof SourceFileError) {
      if (error.code === 'CANCELLED' || error.code === 'LIMIT_EXCEEDED' || error.code === 'HASH_MISMATCH') return executionFail(error.code);
      return executionFail(error.code === 'CONTENT_CHANGED' ? 'INPUT_CHANGED' : 'SOURCE_UNAVAILABLE');
    }
    if (error instanceof Error && 'code' in error && error.code === 'ENOSPC') return executionFail('DISK_FULL');
    return executionFail('IO_ERROR');
  }
}
