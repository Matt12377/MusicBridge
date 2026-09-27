import type { FileHandle } from 'node:fs/promises';
import type { ExecutionFormat } from '@music-bridge/contracts';

export interface ReadonlyAudioDescriptor {
  dataOffset: number;
  frameCount: number;
  channelCount: 1 | 2;
  sampleFormat: ExecutionFormat['outputSampleFormat'];
}

export class ReadonlyAudioReadError extends Error {
  constructor(readonly code: 'INVALID_RANGE' | 'INPUT_CHANGED' | 'CANCELLED' | 'LEASE_CLOSED') { super(code); }
}

export interface ReadonlyAudioReader {
  readonly descriptor: Readonly<ReadonlyAudioDescriptor>;
  /** 只读、按绝对帧定位；EOF仅为输入事实，不能推出后端排空或实体完成。 */
  readFrames(startFrame: number, frames: number): Promise<{ bytes: Buffer; frames: number; sourceEof: boolean }>;
}

export interface ReadonlyAudioConsumer extends ReadonlyAudioReader {
  /** 结束租期时先封闭新读取；不关闭由外层租期持有的FD。 */
  revoke(): void;
}

/** 真正独立的provider视图：运行时不携带句柄，也不暴露撤销租期的方法。 */
export function readonlyAudioReader(consumer: ReadonlyAudioConsumer): ReadonlyAudioReader {
  return Object.freeze({
    descriptor: consumer.descriptor,
    readFrames: (startFrame: number, frames: number) => consumer.readFrames(startFrame, frames),
  });
}

/** 正式Attempt与历史Replica共用的FD读取边界；调用方必须持有并最终核验只读租期。 */
export function createReadonlyAudioConsumer(
  handle: FileHandle,
  descriptor: ReadonlyAudioDescriptor,
  signal: AbortSignal,
  checkOperation: () => void,
): ReadonlyAudioConsumer {
  const sampleBytes = descriptor.sampleFormat === 'pcm-s16le' ? 2 : descriptor.sampleFormat === 'pcm-s24le' ? 3 : 4;
  const frameBytes = descriptor.channelCount * sampleBytes;
  const end = BigInt(descriptor.dataOffset) + BigInt(descriptor.frameCount) * BigInt(frameBytes);
  if (!Number.isSafeInteger(descriptor.dataOffset) || descriptor.dataOffset < 20
    || !Number.isSafeInteger(descriptor.frameCount) || descriptor.frameCount < 1
    || ![1, 2].includes(descriptor.channelCount) || !['pcm-s16le', 'pcm-s24le', 'pcm-s32le', 'pcm-f32le'].includes(descriptor.sampleFormat)
    || end > BigInt(Number.MAX_SAFE_INTEGER)) throw new ReadonlyAudioReadError('INVALID_RANGE');
  const frozen = Object.freeze({ ...descriptor });
  let revoked = false, busy = false;
  const check = () => {
    if (revoked) throw new ReadonlyAudioReadError('LEASE_CLOSED');
    if (signal.aborted) throw new ReadonlyAudioReadError('CANCELLED');
    checkOperation();
  };
  return {
    descriptor: frozen,
    async readFrames(startFrame, frames) {
      check();
      if (busy || !Number.isSafeInteger(startFrame) || startFrame < 0 || startFrame >= frozen.frameCount
        || !Number.isSafeInteger(frames) || frames < 1 || frames > 4096) throw new ReadonlyAudioReadError('INVALID_RANGE');
      busy = true;
      try {
        const count = Math.min(frames, frozen.frameCount - startFrame), length = count * frameBytes;
        const position = frozen.dataOffset + startFrame * frameBytes;
        const bytes = Buffer.allocUnsafe(length);
        for (let offset = 0; offset < length;) {
          check();
          let bytesRead: number;
          try { ({ bytesRead } = await handle.read(bytes, offset, length - offset, position + offset)); }
          catch { throw new ReadonlyAudioReadError('INPUT_CHANGED'); }
          if (!bytesRead) throw new ReadonlyAudioReadError('INPUT_CHANGED');
          offset += bytesRead;
        }
        check();
        return { bytes, frames: count, sourceEof: startFrame + count === frozen.frameCount };
      } finally { busy = false; }
    },
    revoke() { revoked = true; },
  };
}
