import type { FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isExecutionFormat, type AudioConversionReceipt, type ExecutionFormat, type ExecutionPcmInput } from '@music-bridge/contracts';
import { ExecutionCompileError, executionFail } from './execution-plan.js';

export interface PcmWave { sampleRate: number; channelCount: 1 | 2; bitsPerSample: 16 | 24 | 32; totalFrames: number; dataOffset: number; dataSize: number; blockAlign: number }
interface ConversionWave extends PcmWave { sampleFormat: ExecutionFormat['outputSampleFormat'] }
export async function readExactly(handle: FileHandle, length: number, position: number, check: () => void): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(length); let offset = 0;
  while (offset < length) { check(); const { bytesRead } = await handle.read(bytes, offset, length - offset, position + offset); if (!bytesRead) return executionFail('INPUT_CHANGED'); offset += bytesRead; }
  return bytes;
}
/** 只解析整数 PCM 的 RIFF 子块；不读标签，不猜扩展格式，不将 WAV 扩展名当成编码证据。 */
export async function readPcmWave(handle: FileHandle, size: number, check: () => void): Promise<PcmWave> {
  const { sampleFormat: _, ...wave } = await readWave(handle, size, check, false);
  return wave;
}
async function readWave(handle: FileHandle, size: number, check: () => void, conversion: boolean): Promise<ConversionWave> {
  if (!Number.isSafeInteger(size) || size < 44 || size > 0xffffffff + 8) return executionFail('UNSUPPORTED_WAVE');
  const riff = await readExactly(handle, 12, 0, check);
  if (riff.toString('latin1', 0, 4) !== 'RIFF' || riff.toString('latin1', 8, 12) !== 'WAVE' || riff.readUInt32LE(4) + 8 !== size) return executionFail('UNSUPPORTED_WAVE');
  let format: Omit<ConversionWave, 'totalFrames' | 'dataOffset' | 'dataSize'> | undefined, data: { dataOffset: number; dataSize: number } | undefined, factFrames: number | undefined;
  let offset = 12, count = 0;
  while (offset < size) {
    check(); if (++count > 2048) return executionFail('LIMIT_EXCEEDED');
    if (offset + 8 > size) return executionFail('UNSUPPORTED_WAVE');
    const header = await readExactly(handle, 8, offset, check), id = header.toString('latin1', 0, 4), length = header.readUInt32LE(4), end = offset + 8 + length + length % 2;
    if (end > size) return executionFail('UNSUPPORTED_WAVE');
    if (id === 'fmt ') {
      if (format || !(conversion ? [16,18,40] : [16,18]).includes(length)) return executionFail('UNSUPPORTED_WAVE');
      const bytes = await readExactly(handle, length, offset + 8, check), tag = bytes.readUInt16LE(0), channels = bytes.readUInt16LE(2), sampleRate = bytes.readUInt32LE(4), byteRate = bytes.readUInt32LE(8), align = bytes.readUInt16LE(12), bits = bytes.readUInt16LE(14);
      if (![1,2].includes(channels) || ![16,24,32].includes(bits) || sampleRate < 8000 || sampleRate > 384000 || align !== channels * bits / 8 || byteRate !== sampleRate * align || length === 18 && bytes.readUInt16LE(16) !== 0) return executionFail('UNSUPPORTED_WAVE');
      let encoding = tag;
      if (length === 40) {
        // 执行输出只接收完整位宽和明确的 mono/stereo 位置；不猜测有效位或 DIRECTOUT 布局。
        if (tag !== 0xfffe || bytes.readUInt16LE(16) !== 22 || bytes.readUInt16LE(18) !== bits || bytes.readUInt32LE(20) !== (channels === 1 ? 4 : 3)) return executionFail('UNSUPPORTED_WAVE');
        const guid = bytes.subarray(24).toString('hex');
        encoding = guid === '0100000000001000800000aa00389b71' ? 1 : guid === '0300000000001000800000aa00389b71' ? 3 : 0;
      }
      if (encoding !== 1 && !(conversion && encoding === 3 && bits === 32)) return executionFail('UNSUPPORTED_WAVE');
      format = { sampleRate, channelCount: channels as 1 | 2, bitsPerSample: bits as 16 | 24 | 32, blockAlign: align, sampleFormat: encoding === 3 ? 'pcm-f32le' : `pcm-s${bits as 16 | 24 | 32}le` };
    } else if (id === 'data') {
      if (data || !length) return executionFail('UNSUPPORTED_WAVE');
      data = { dataOffset: offset + 8, dataSize: length };
    } else if (id === 'LIST') {
      if (length < 4) return executionFail('UNSUPPORTED_WAVE');
      const kind = await readExactly(handle, 4, offset + 8, check);
      if (kind.toString('latin1') === 'wavl') return executionFail('UNSUPPORTED_WAVE');
    } else if (id === 'fact') {
      if (!conversion || factFrames !== undefined || length !== 4) return executionFail('UNSUPPORTED_WAVE');
      factFrames = (await readExactly(handle, 4, offset + 8, check)).readUInt32LE(0);
    } else if (id === 'slnt') return executionFail('UNSUPPORTED_WAVE');
    offset = end;
  }
  if (!format || !data || data.dataSize % format.blockAlign !== 0) return executionFail('UNSUPPORTED_WAVE');
  if (factFrames !== undefined && factFrames !== data.dataSize / format.blockAlign || format.sampleFormat === 'pcm-f32le' && factFrames === undefined) return executionFail('UNSUPPORTED_WAVE');
  return { ...format, ...data, totalFrames: data.dataSize / format.blockAlign };
}

/** 只回读上层持有的输出句柄，不运行转换器，也不证明源已完整解码或已获输出设备认证。 */
export interface ReadonlyPcmFormat { sampleRate: number; channelCount: 1 | 2; sampleFormat: ExecutionFormat['outputSampleFormat'] }
/** 原件的中立解析，不构造设备Profile或执行转换谱系。 */
export async function inspectReadonlyPcmWave(handle: FileHandle, signal: AbortSignal, checkOperation: () => void = () => undefined): Promise<{ format: ReadonlyPcmFormat; audio: AudioConversionReceipt['audio'] }> {
  const wallDeadline = Date.now() + 15 * 60_000, monotonicDeadline = performance.now() + 15 * 60_000;
  const check = (): void => {
    if (signal.aborted) return executionFail('CANCELLED');
    if (Date.now() > wallDeadline || performance.now() > monotonicDeadline) return executionFail('LIMIT_EXCEEDED');
    checkOperation();
  };
  try {
    check(); const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n) return executionFail('INVALID_INPUT');
    const size = Number(before.size), wave = await readWave(handle, size, check, true);
    const wholeHash = createHash('sha256'), pcmHash = createHash('sha256');
    // 分块回读限制内存；浮点块始终按四字节对齐，短读由 readExactly 补齐。
    for (let offset = 0; offset < wave.dataSize;) {
      const bytes = await readExactly(handle, Math.min(1024 * 1024, wave.dataSize - offset), wave.dataOffset + offset, check);
      if (wave.sampleFormat === 'pcm-f32le') for (let i = 0; i < bytes.length; i += 4) {
        if (!Number.isFinite(bytes.readFloatLE(i))) return executionFail('UNSUPPORTED_WAVE');
      }
      pcmHash.update(bytes); offset += bytes.length;
    }
    for (let offset = 0; offset < size;) {
      const bytes = await readExactly(handle, Math.min(1024 * 1024, size - offset), offset, check);
      wholeHash.update(bytes); offset += bytes.length;
    }
    check(); const after = await handle.stat({ bigint: true }); check();
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || after.nlink !== 1n) return executionFail('INPUT_CHANGED');
    return { format: { sampleRate: wave.sampleRate, channelCount: wave.channelCount, sampleFormat: wave.sampleFormat }, audio: { sha256: wholeHash.digest('hex'), pcmSha256: pcmHash.digest('hex'), size, dataOffset: wave.dataOffset, frameCount: wave.totalFrames } };
  } catch (error) {
    if (error instanceof ExecutionCompileError) throw error;
    return executionFail('IO_ERROR');
  }
}
/** 执行资产保持原有完整ExecutionFormat校验；中立解析不放宽输出格式。 */
export async function inspectConversionOutput(handle: FileHandle, expected: ExecutionFormat, signal: AbortSignal, checkOperation: () => void = () => undefined): Promise<AudioConversionReceipt['audio']> {
  if (signal.aborted) return executionFail('CANCELLED');
  checkOperation(); if (!isExecutionFormat(expected)) return executionFail('INVALID_INPUT');
  const format = structuredClone(expected), result = await inspectReadonlyPcmWave(handle, signal, checkOperation);
  if (result.format.sampleRate !== format.sampleRate || result.format.channelCount !== format.channelCount || result.format.sampleFormat !== format.outputSampleFormat) return executionFail('CONVERSION_REQUIRED');
  return result.audio;
}
export function assertPcmInput(wave: PcmWave, input: ExecutionPcmInput): void {
  if (wave.totalFrames !== input.totalFrames) return executionFail('FRAME_MISMATCH');
  if (wave.sampleRate !== input.sampleRate || wave.channelCount !== input.channelCount || wave.bitsPerSample !== input.bitsPerSample) return executionFail('CONVERSION_REQUIRED');
}
export function pcmWaveHeader(sampleRate: number, channels: number, bits: number, frames: number): Buffer {
  const dataSize = BigInt(frames) * BigInt(channels) * BigInt(bits) / 8n;
  if (dataSize + 36n + dataSize % 2n > 0xffffffffn) return executionFail('LIMIT_EXCEEDED');
  const b = Buffer.alloc(44); b.write('RIFF'); b.writeUInt32LE(Number(36n + dataSize + dataSize % 2n), 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(channels, 22); b.writeUInt32LE(sampleRate, 24); b.writeUInt32LE(sampleRate * channels * bits / 8, 28); b.writeUInt16LE(channels * bits / 8, 32); b.writeUInt16LE(bits, 34); b.write('data', 36); b.writeUInt32LE(Number(dataSize), 40); return b;
}
