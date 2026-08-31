import { isCollectionId } from '@music-bridge/contracts';
import type { RecordingOutputRunner } from './output-input.js';
import { outputCheckFail } from './output-error.js';

type Input = Parameters<RecordingOutputRunner['run']>[0];
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const integer = (v: number, min: number, max: number) => Number.isSafeInteger(v) && v >= min && v <= max;
const uuid = (value: string) => { if (!isCollectionId(value)) return outputCheckFail('INVALID_REQUEST'); return Buffer.from(value.replaceAll('-', ''), 'hex'); };
const zeroHash = '0'.repeat(64);

/** v1只编码无设备检查，不存在设备ID、任意路径或backend开关。 */
export function encodeOutputHeader(input: Input, callbackFrames = 1024): Buffer {
  const { identity, audio, format } = input;
  const formats = { 'pcm-s16le': [1, 2], 'pcm-s24le': [2, 3], 'pcm-s32le': [3, 4], 'pcm-f32le': [4, 4] } as const;
  const spec = formats[format.outputSampleFormat];
  if (!spec || !integer(format.channelCount, 1, 2) || !integer(format.sampleRate, 8000, 384000) || !integer(callbackFrames, 1, 4096)
    || !integer(audio.size, 44, 0xffffffff + 8) || !integer(audio.dataOffset, 20, audio.size) || !integer(audio.frameCount, 1, Number.MAX_SAFE_INTEGER)
    || ![identity.planContentHash, identity.recipeHash, audio.sha256, audio.pcmSha256].every(hash)) return outputCheckFail('INVALID_REQUEST');
  const dataBytes = audio.frameCount * spec[1] * format.channelCount;
  if (!Number.isSafeInteger(dataBytes) || dataBytes > audio.size - audio.dataOffset) return outputCheckFail('INVALID_REQUEST');
  const b = Buffer.alloc(256); b.write('MBFP'); b.writeUInt16LE(1, 4); b.writeUInt16LE(256, 6);
  uuid(identity.runId).copy(b, 8); uuid(identity.planVersionId).copy(b, 24); uuid(identity.assetId).copy(b, 40);
  [identity.planContentHash, identity.recipeHash, audio.sha256, audio.pcmSha256].forEach((value, i) => Buffer.from(value, 'hex').copy(b, 56 + 32 * i));
  [audio.size, audio.dataOffset, dataBytes, audio.frameCount].forEach((value, i) => b.writeBigUInt64LE(BigInt(value), 184 + 8 * i));
  b.writeUInt32LE(format.sampleRate, 216); b.writeUInt16LE(format.channelCount, 220); b.writeUInt16LE(spec[0], 222); b.writeUInt32LE(callbackFrames, 224); return b;
}
export function encodeOutputControl(runId: string, operation: 'run' | 'stop', sequence: number): Buffer {
  if (!['run', 'stop'].includes(operation) || !integer(sequence, 1, 2)) return outputCheckFail('INVALID_REQUEST');
  const b = Buffer.alloc(32); b.write('MBFC'); b.writeUInt16LE(1, 4); b.writeUInt16LE(operation === 'run' ? 1 : 2, 6); uuid(runId).copy(b, 8); b.writeUInt32LE(sequence, 24); return b;
}
export interface OutputNativeEvent { kind: number; code: number; elapsedNs: bigint; consumedFrames: number; zeroFrames: number; callbacks: number; inputHash: string; consumedHash: string }
export function createOutputEventDecoder(expected: { runId: string; frameCount: number; pcmSha256: string }) {
  if (!integer(expected.frameCount, 1, Number.MAX_SAFE_INTEGER) || !hash(expected.pcmSha256)) return outputCheckFail('INVALID_REQUEST');
  const runBytes = uuid(expected.runId); let pending = Buffer.alloc(0), bytes = 0, sequence = 0, previous: OutputNativeEvent | undefined;
  const count = (b: Buffer, offset: number) => { const n = b.readBigUInt64LE(offset); if (n > BigInt(Number.MAX_SAFE_INTEGER)) return outputCheckFail('HELPER_PROTOCOL'); return Number(n); };
  const terminal = (event?: OutputNativeEvent) => !!event && event.kind >= 5;
  return {
    push(chunk: Buffer): OutputNativeEvent[] {
      bytes += chunk.length; if (bytes > 1024) return outputCheckFail('HELPER_PROTOCOL');
      pending = Buffer.concat([pending, chunk]); const events: OutputNativeEvent[] = [];
      while (pending.length >= 128) {
        const b = pending.subarray(0, 128); pending = pending.subarray(128);
        if (terminal(previous) || b.toString('ascii', 0, 4) !== 'MBFE' || b.readUInt16LE(4) !== 1 || b.readUInt32LE(8) !== sequence + 1 || !b.subarray(16, 32).equals(runBytes)) return outputCheckFail('HELPER_PROTOCOL');
        const e: OutputNativeEvent = { kind: b.readUInt16LE(6), code: b.readUInt32LE(12), elapsedNs: b.readBigUInt64LE(32), consumedFrames: count(b, 40), zeroFrames: count(b, 48), callbacks: count(b, 56), inputHash: b.subarray(64, 96).toString('hex'), consumedHash: b.subarray(96, 128).toString('hex') };
        const kind = previous?.kind ?? 0;
        if (!integer(e.kind, 1, 7) || !integer(e.code, 0, 13) || (e.kind <= 5 && e.code !== 0) || (e.kind === 6 && ![1, 2].includes(e.code)) || (e.kind === 7 && e.code < 2)
          || e.elapsedNs < (previous?.elapsedNs ?? 0n) || e.consumedFrames < (previous?.consumedFrames ?? 0) || e.consumedFrames > expected.frameCount
          || e.zeroFrames < (previous?.zeroFrames ?? 0) || e.callbacks < (previous?.callbacks ?? 0)) return outputCheckFail('HELPER_PROTOCOL');
        if (e.kind <= 5 && e.kind !== kind + 1) return outputCheckFail('HELPER_PROTOCOL');
        if (e.kind === 1 && (e.inputHash !== zeroHash || e.consumedFrames !== 0)) return outputCheckFail('HELPER_PROTOCOL');
        if (e.kind >= 2 && e.kind <= 5 && e.inputHash !== expected.pcmSha256) return outputCheckFail('INPUT_CHANGED');
        if (e.kind <= 3 && e.consumedFrames !== 0) return outputCheckFail('HELPER_PROTOCOL');
        // SOURCE_EOF发生在供帧结束，尾部可能仍在ring中；完整消费只在排空终态核对。
        if (e.kind === 5 && e.consumedFrames !== expected.frameCount) return outputCheckFail('FRAME_MISMATCH');
        if (e.kind === 5 && e.consumedHash !== expected.pcmSha256) return outputCheckFail('FRAME_MISMATCH');
        sequence++; previous = e; events.push(e);
      }
      return events;
    },
    finish(exitCode: number | null): { consumedFrames: number; pcmSha256: string } {
      if (pending.length || !terminal(previous)) return outputCheckFail('HELPER_PROTOCOL');
      if (previous!.kind === 6) return outputCheckFail('CANCELLED');
      if (previous!.kind === 7) return outputCheckFail([7, 8].includes(previous!.code) ? 'INPUT_CHANGED' : previous!.code === 9 ? 'INPUT_UNAVAILABLE' : 'HELPER_PROTOCOL');
      if (exitCode !== 0) return outputCheckFail('HELPER_PROTOCOL');
      return { consumedFrames: previous!.consumedFrames, pcmSha256: previous!.consumedHash };
    },
  };
}
