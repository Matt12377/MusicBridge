import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { isExecutionAudioReceipt, isExecutionRecipe, type ExecutionRecipe, type ExecutionAudioReceipt, type ExecutionPcmInput } from '@music-bridge/contracts';
import { SourceFileError, sourceRootAvailability, withVerifiedReadonlySource, type RootCapability } from './source-files.js';
import { mediaFingerprint } from './media-store.js';
import { ExecutionCompileError, executionFail, requireCopyFormat } from './execution-plan.js';
import { readPcmWave, assertPcmInput, pcmWaveHeader } from './execution-wave.js';

export interface ExecutionSourceLocation { trackId: string; root: RootCapability; relative: string }
export interface ExecutionRenderLocation { renderAssetId: string; root: RootCapability; relative: string }
function guard(signal: AbortSignal): () => void {
  const deadline = Date.now() + 15 * 60_000;
  return () => { if (signal.aborted) executionFail('CANCELLED'); if (Date.now() > deadline) executionFail('LIMIT_EXCEEDED'); };
}
async function bounded<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); } catch (error) {
    if (error instanceof ExecutionCompileError) throw error;
    if (error instanceof SourceFileError) {
      if (error.code === 'CANCELLED' || error.code === 'LIMIT_EXCEEDED' || error.code === 'HASH_MISMATCH') return executionFail(error.code);
      if (error.code === 'CONTENT_CHANGED') return executionFail('INPUT_CHANGED');
      if (['REVOKED','SOURCE_ROOT_OFFLINE','MISSING','OUTSIDE_ROOT'].includes(error.code)) return executionFail('SOURCE_UNAVAILABLE');
    }
    return executionFail('IO_ERROR');
  }
}
function recipeSnapshot(input: ExecutionRecipe, mode: ExecutionRecipe['mode']): ExecutionRecipe {
  if (!isExecutionRecipe(input) || input.mode !== mode || input.totalFrames === 0) return executionFail('INVALID_INPUT');
  return structuredClone(input);
}
async function pcmHash(handle: FileHandle, offset: number, size: number, check: () => void): Promise<string> {
  const hash = createHash('sha256'), chunk = Buffer.allocUnsafe(1024 * 1024); let read = 0;
  while (read < size) { check(); const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, size - read), offset + read); if (!bytesRead) return executionFail('INPUT_CHANGED'); hash.update(chunk.subarray(0, bytesRead)); read += bytesRead; }
  return hash.digest('hex');
}
/** 仅写入上层排他创建的空普通文件句柄；失败不返回资产，也不删任何文件。 */
export async function compileDirectPcm(input: ExecutionRecipe, locations: readonly ExecutionSourceLocation[], destination: FileHandle, signal: AbortSignal): Promise<ExecutionAudioReceipt> {
  return bounded(async () => {
    const recipe = recipeSnapshot(input, 'direct'), check = guard(signal), bits = requireCopyFormat(recipe.format);
    check(); const target = await destination.stat({ bigint: true });
    if (!target.isFile() || target.size !== 0n || target.nlink !== 1n) return executionFail('INVALID_INPUT');
    const sources = recipe.segments.filter(s => s.kind === 'source');
    if (locations.length !== sources.length || new Set(locations.map(l => l.trackId)).size !== locations.length || sources.some(s => !locations.some(l => l.trackId === s.trackId))) return executionFail('INVALID_INPUT');
    const header = pcmWaveHeader(recipe.format.sampleRate, recipe.format.channelCount, bits, recipe.totalFrames), blockAlign = recipe.format.channelCount * bits / 8;
    async function readSource<T>(trackId: string, expected: ExecutionPcmInput, action: (handle: FileHandle, dataOffset: number, dataSize: number, checked: () => void) => Promise<T>): Promise<T> {
      check(); const location = locations.find(l => l.trackId === trackId)!;
      return withVerifiedReadonlySource(location.root, location.relative, expected, signal, async (handle, sourceCheck) => {
        const checked = (): void => { check(); sourceCheck(); }; checked();
        const info = await handle.stat({ bigint: true });
        if (info.dev === target.dev && info.ino === target.ino) return executionFail('INVALID_INPUT');
        const wave = await readPcmWave(handle, expected.size, checked); assertPcmInput(wave, expected);
        return action(handle, wave.dataOffset, wave.dataSize, checked);
      }, check);
    }
    // 全部规格先核对；任何转换需求不产生半个可误用的输出文件。
    for (const source of sources) await readSource(source.trackId, source.input, async () => undefined);
    let position = 0; const expectedHash = createHash('sha256'), expectedPcmHash = createHash('sha256');
    async function write(bytes: Buffer, audio: boolean): Promise<void> {
      let offset = 0;
      while (offset < bytes.length) { check(); const { bytesWritten } = await destination.write(bytes, offset, bytes.length - offset, position + offset); if (!bytesWritten) return executionFail('IO_ERROR'); offset += bytesWritten; }
      expectedHash.update(bytes); if (audio) expectedPcmHash.update(bytes); position += bytes.length;
    }
    await write(header, false);
    const silence = Buffer.alloc(1024 * 1024);
    for (const segment of recipe.segments) {
      if (segment.kind === 'silence') {
        let remaining = (segment.endFrame - segment.startFrame) * blockAlign;
        while (remaining) { const length = Math.min(remaining, silence.length); await write(silence.subarray(0, length), true); remaining -= length; }
      } else if (segment.kind === 'source') {
        await readSource(segment.trackId, segment.input, async (handle, dataOffset, dataSize, checked) => {
          const bytes = Buffer.allocUnsafe(1024 * 1024); let offset = 0;
          while (offset < dataSize) { checked(); const { bytesRead } = await handle.read(bytes, 0, Math.min(bytes.length, dataSize - offset), dataOffset + offset); if (!bytesRead) return executionFail('INPUT_CHANGED'); await write(bytes.subarray(0, bytesRead), true); offset += bytesRead; }
        });
      }
    }
    const audioSize = recipe.totalFrames * blockAlign;
    if (audioSize % 2) await write(Buffer.alloc(1), false);
    check(); await destination.sync(); check();
    const before = await destination.stat({ bigint: true });
    if (before.dev !== target.dev || before.ino !== target.ino || before.size !== BigInt(position) || before.nlink !== 1n) return executionFail('IO_ERROR');
    const wave = await readPcmWave(destination, position, check);
    if (wave.totalFrames !== recipe.totalFrames || wave.dataOffset !== 44 || wave.sampleRate !== recipe.format.sampleRate || wave.channelCount !== recipe.format.channelCount || wave.bitsPerSample !== bits) return executionFail('FRAME_MISMATCH');
    const sha256 = await pcmHash(destination, 0, position, check), pcmSha256 = await pcmHash(destination, wave.dataOffset, wave.dataSize, check);
    if (sha256 !== expectedHash.digest('hex') || pcmSha256 !== expectedPcmHash.digest('hex')) return executionFail('HASH_MISMATCH');
    const after = await destination.stat({ bigint: true }); check();
    if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || after.nlink !== 1n) return executionFail('INPUT_CHANGED');
    for (const location of locations) if (await sourceRootAvailability(location.root) !== 'ONLINE') return executionFail('SOURCE_UNAVAILABLE');
    check(); if (locations.some(location => !location.root.authorized)) return executionFail('SOURCE_UNAVAILABLE');
    const receipt: ExecutionAudioReceipt = { recipe, recipeHash: mediaFingerprint(recipe), origin: 'compiled', audio: { sha256, size: position, pcmSha256, dataOffset: wave.dataOffset, frameCount: wave.totalFrames }, formalReady: false };
    if (!isExecutionAudioReceipt(receipt)) return executionFail('INVALID_INPUT');
    return receipt;
  });
}
/** 格式符合的 PREP 只读验证原始保留文件，既不复制也不插入任何静音。 */
export async function verifyPreparedPcm(input: ExecutionRecipe, location: ExecutionRenderLocation, signal: AbortSignal): Promise<ExecutionAudioReceipt> {
  return bounded(async () => {
    const recipe = recipeSnapshot(input, 'prepared-reference'), check = guard(signal); check();
    const segment = recipe.segments[0];
    if (segment?.kind !== 'render' || segment.renderAssetId !== location.renderAssetId) return executionFail('INVALID_INPUT');
    return withVerifiedReadonlySource(location.root, location.relative, segment.input, signal, async (handle, sourceCheck) => {
      const checked = (): void => { check(); sourceCheck(); };
      const wave = await readPcmWave(handle, segment.input.size, checked); assertPcmInput(wave, segment.input);
      const pcmSha256 = await pcmHash(handle, wave.dataOffset, wave.dataSize, checked);
      const receipt: ExecutionAudioReceipt = { recipe, recipeHash: mediaFingerprint(recipe), origin: 'retained-render', audio: { sha256: segment.input.sha256, size: segment.input.size, pcmSha256, dataOffset: wave.dataOffset, frameCount: wave.totalFrames }, formalReady: false };
      if (!isExecutionAudioReceipt(receipt)) return executionFail('INVALID_INPUT');
      return receipt;
    }, check);
  });
}
