import { createHash } from 'node:crypto';
import type { ReadonlyAudioReader } from './readonly-audio-consumer.js';

export type DevicePcmPumpFailure = 'INVALID_REQUEST' | 'CANCELLED' | 'SCOPE_CHANGED' | 'INPUT_CHANGED' | 'SINK_CLOSED';
export class DevicePcmPumpError extends Error {
  constructor(readonly code: DevicePcmPumpFailure) { super(`正式输出供帧未完成。 [${code}]`); }
}
const fail = (code: DevicePcmPumpFailure): never => { throw new DevicePcmPumpError(code); };

/**
 * Core私有的顺序PCM供帧边界。写端只收到受限块，不收到输入FD、release或revoke。
 * 完整PCM Hash是供帧事实；返回绝不表示HAL消费、软件排空或实体录音。
 */
export async function pumpOutputDevicePcm(input: {
  reader: ReadonlyAudioReader;
  expectedPcmSha256: string;
  signal: AbortSignal;
  checkOperation(): void;
  writeChunk(bytes: Buffer): Promise<void>;
  maxFramesPerRead?: number;
}): Promise<{ suppliedFrames: number; suppliedPcmSha256: string }> {
  const { reader, expectedPcmSha256, signal, checkOperation, writeChunk } = input;
  const { descriptor } = reader;
  const sampleBytes = descriptor.sampleFormat === 'pcm-s16le' ? 2 : descriptor.sampleFormat === 'pcm-s24le' ? 3 : 4;
  const frameBytes = descriptor.channelCount * sampleBytes, total = descriptor.frameCount;
  const chunkFrames = input.maxFramesPerRead ?? 4096;
  if (!/^[a-f0-9]{64}$/u.test(expectedPcmSha256) || !Number.isSafeInteger(total) || total < 1
    || ![1, 2].includes(descriptor.channelCount) || !['pcm-s16le', 'pcm-s24le', 'pcm-s32le', 'pcm-f32le'].includes(descriptor.sampleFormat)
    || !Number.isSafeInteger(chunkFrames) || chunkFrames < 1 || chunkFrames > 4096) return fail('INVALID_REQUEST');
  const check = () => {
    if (signal.aborted) return fail('CANCELLED');
    try { checkOperation(); } catch { return fail('SCOPE_CHANGED'); }
  };
  const digest = createHash('sha256');
  let suppliedFrames = 0;
  while (suppliedFrames < total) {
    check();
    const expectedFrames = Math.min(chunkFrames, total - suppliedFrames);
    let result: Awaited<ReturnType<ReadonlyAudioReader['readFrames']>>;
    try { result = await reader.readFrames(suppliedFrames, expectedFrames); }
    catch { if (signal.aborted) return fail('CANCELLED'); return fail('INPUT_CHANGED'); }
    check();
    if (!Buffer.isBuffer(result.bytes) || result.frames !== expectedFrames || result.bytes.length !== expectedFrames * frameBytes
      || result.sourceEof !== (suppliedFrames + expectedFrames === total)) return fail('INPUT_CHANGED');
    digest.update(result.bytes);
    try { await writeChunk(result.bytes); }
    catch { if (signal.aborted) return fail('CANCELLED'); return fail('SINK_CLOSED'); }
    check();
    suppliedFrames += expectedFrames;
  }
  const suppliedPcmSha256 = digest.digest('hex');
  if (suppliedPcmSha256 !== expectedPcmSha256) return fail('INPUT_CHANGED');
  return { suppliedFrames, suppliedPcmSha256 };
}
