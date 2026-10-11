import { createHash } from 'node:crypto';
import { mobileInteger } from '@music-bridge/contracts';
import type { MobileNeteaseObservedAudio } from './netease-source-types.js';
import { MobileServiceError } from './types.js';

const unsupported = (): never => { throw new MobileServiceError(409, 'UNSUPPORTED_FORMAT'); };
const changed = (): never => { throw new MobileServiceError(409, 'SOURCE_CHANGED'); };
/** 仅从真实有限头部读取参数。不是整曲 decode、全 hash 或听感证明。 */
export async function readMobileNeteaseAudioFacts(size: number,
  readAt: (position: number, length: number, signal: AbortSignal) => Promise<Uint8Array>, signal: AbortSignal,
): Promise<Readonly<MobileNeteaseObservedAudio>> {
  if (!mobileInteger(size, 4)) return unsupported();
  let calls = 0, bytes = 0;
  const headers: Buffer[] = [];
  async function read(start: number, length: number): Promise<Buffer> {
    signal.throwIfAborted();
    if (!mobileInteger(start) || !mobileInteger(length, 1, 65_536) || start + length > size
      || ++calls > 8 || (bytes += length) > 65_536) return unsupported();
    const raw = await readAt(start, length, signal); signal.throwIfAborted();
    if (!(raw instanceof Uint8Array) || ![Uint8Array.prototype, Buffer.prototype].includes(Object.getPrototypeOf(raw))
      || !(raw.buffer instanceof ArrayBuffer) || raw.byteLength !== length) return changed();
    const value = Buffer.from(raw); headers.push(value); return value;
  }
  const first = await read(0, Math.min(12, size));
  const finish = (value: Omit<MobileNeteaseObservedAudio, 'size' | 'headerSha256'>): Readonly<MobileNeteaseObservedAudio> =>
    Object.freeze({ ...value, audio: Object.freeze({ ...value.audio }), size,
      headerSha256: createHash('sha256').update(Buffer.concat(headers)).digest('hex') });
  if (first.subarray(0, 4).toString('ascii') === 'fLaC') {
    const head = await read(0, 42);
    if ((head[4]! & 0x7f) !== 0 || head.readUIntBE(5, 3) !== 34) return unsupported();
    const minBlock = head.readUInt16BE(8), maxBlock = head.readUInt16BE(10);
    if (minBlock < 16 || maxBlock < minBlock) return unsupported();
    const packed = head.readBigUInt64BE(18), sampleRateHz = Number(packed >> 44n);
    const channels = Number(packed >> 41n & 7n) + 1, bitsPerSample = Number(packed >> 36n & 31n) + 1;
    const samples = packed & ((1n << 36n) - 1n);
    if (!mobileInteger(sampleRateHz, 8_000, 768_000) || bitsPerSample < 4 || bitsPerSample > 32 || samples === 0n) return unsupported();
    const duration = (samples * 1_000n + BigInt(sampleRateHz) / 2n) / BigInt(sampleRateHz);
    if (duration > BigInt(Number.MAX_SAFE_INTEGER)) return unsupported();
    return finish({ audio: { codec: 'flac', container: 'flac', sampleRateHz, bitsPerSample, channels },
      durationMs: Number(duration), contentType: 'audio/flac' });
  }
  let offset = 0;
  if (first.subarray(0, 3).toString('ascii') === 'ID3') {
    if (first.length < 10 || ![2, 3, 4].includes(first[3]!) || first[4] === 0xff
      || first.subarray(6, 10).some(n => n > 0x7f)) return unsupported();
    const version = first[3]!, flags = first[5]!;
    if (flags & (version === 2 ? 0x3f : version === 3 ? 0x1f : 0x0f)) return unsupported();
    const tagSize = first[6]! * 2 ** 21 + first[7]! * 2 ** 14 + first[8]! * 2 ** 7 + first[9]!;
    offset = 10 + tagSize + (version === 4 && flags & 0x10 ? 10 : 0);
    // 随机跳过只读标签，不分配标签内容；上限仍独立拒绝不可信大前缀。
    if (offset > 1_048_576 || offset + 4 > size) return unsupported();
  }
  function mp3(head: Buffer) {
    const a = head[1]!, b = head[2]!, c = head[3]!;
    const version = a >> 3 & 3, layer = a >> 1 & 3, index = b >> 4, rateIndex = b >> 2 & 3;
    if (head[0] !== 0xff || (a & 0xe0) !== 0xe0 || version === 1 || layer !== 1
      || index === 0 || index === 15 || rateIndex === 3 || (c & 3) === 2) return unsupported();
    const bitrateKbps = (version === 3 ? [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320]
      : [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160])[index]!;
    const sampleRateHz = [44_100,48_000,32_000][rateIndex]! / (version === 3 ? 1 : version === 2 ? 2 : 4);
    const channels = c >> 6 === 3 ? 1 : 2;
    const frameBytes = Math.floor((version === 3 ? 144_000 : 72_000) * bitrateKbps / sampleRateHz) + (b >> 1 & 1);
    return { version, sampleRateHz, channels, bitrateKbps, frameBytes };
  }
  const frame = mp3(await read(offset, 4)), next = mp3(await read(offset + frame.frameBytes, 4));
  if (frame.version !== next.version || frame.sampleRateHz !== next.sampleRateHz || frame.channels !== next.channels
    || offset + frame.frameBytes + next.frameBytes > size) return unsupported();
  return finish({ audio: { codec: 'mp3', container: 'mp3', sampleRateHz: frame.sampleRateHz, channels: frame.channels,
    bitrateKbps: frame.bitrateKbps }, durationMs: null, contentType: 'audio/mpeg' });
}
