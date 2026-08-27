import type { FileHandle } from 'node:fs/promises';
import type { ExecutionPcmInput } from '@music-bridge/contracts';
import { executionFail } from './execution-plan.js';

export interface PcmWave { sampleRate: number; channelCount: 1 | 2; bitsPerSample: 16 | 24 | 32; totalFrames: number; dataOffset: number; dataSize: number; blockAlign: number }
export async function readExactly(handle: FileHandle, length: number, position: number, check: () => void): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(length); let offset = 0;
  while (offset < length) { check(); const { bytesRead } = await handle.read(bytes, offset, length - offset, position + offset); if (!bytesRead) return executionFail('INPUT_CHANGED'); offset += bytesRead; }
  return bytes;
}
/** 只解析整数 PCM 的 RIFF 子块；不读标签，不猜扩展格式，不将 WAV 扩展名当成编码证据。 */
export async function readPcmWave(handle: FileHandle, size: number, check: () => void): Promise<PcmWave> {
  if (!Number.isSafeInteger(size) || size < 44 || size > 0xffffffff + 8) return executionFail('UNSUPPORTED_WAVE');
  const riff = await readExactly(handle, 12, 0, check);
  if (riff.toString('latin1', 0, 4) !== 'RIFF' || riff.toString('latin1', 8, 12) !== 'WAVE' || riff.readUInt32LE(4) + 8 !== size) return executionFail('UNSUPPORTED_WAVE');
  let format: Omit<PcmWave, 'totalFrames' | 'dataOffset' | 'dataSize'> | undefined, data: { dataOffset: number; dataSize: number } | undefined;
  let offset = 12, count = 0;
  while (offset < size) {
    check(); if (++count > 2048) return executionFail('LIMIT_EXCEEDED');
    if (offset + 8 > size) return executionFail('UNSUPPORTED_WAVE');
    const header = await readExactly(handle, 8, offset, check), id = header.toString('latin1', 0, 4), length = header.readUInt32LE(4), end = offset + 8 + length + length % 2;
    if (end > size) return executionFail('UNSUPPORTED_WAVE');
    if (id === 'fmt ') {
      if (format || ![16,18].includes(length)) return executionFail('UNSUPPORTED_WAVE');
      const bytes = await readExactly(handle, length, offset + 8, check), tag = bytes.readUInt16LE(0), channels = bytes.readUInt16LE(2), sampleRate = bytes.readUInt32LE(4), byteRate = bytes.readUInt32LE(8), align = bytes.readUInt16LE(12), bits = bytes.readUInt16LE(14);
      if (tag !== 1 || ![1,2].includes(channels) || ![16,24,32].includes(bits) || sampleRate < 8000 || sampleRate > 384000 || align !== channels * bits / 8 || byteRate !== sampleRate * align || length === 18 && bytes.readUInt16LE(16) !== 0) return executionFail('UNSUPPORTED_WAVE');
      format = { sampleRate, channelCount: channels as 1 | 2, bitsPerSample: bits as 16 | 24 | 32, blockAlign: align };
    } else if (id === 'data') {
      if (data || !length) return executionFail('UNSUPPORTED_WAVE');
      data = { dataOffset: offset + 8, dataSize: length };
    } else if (id === 'LIST') {
      if (length < 4) return executionFail('UNSUPPORTED_WAVE');
      const kind = await readExactly(handle, 4, offset + 8, check);
      if (kind.toString('latin1') === 'wavl') return executionFail('UNSUPPORTED_WAVE');
    } else if (['slnt','fact'].includes(id)) return executionFail('UNSUPPORTED_WAVE');
    offset = end;
  }
  if (!format || !data || data.dataSize % format.blockAlign !== 0) return executionFail('UNSUPPORTED_WAVE');
  return { ...format, ...data, totalFrames: data.dataSize / format.blockAlign };
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
