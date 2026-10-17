import { readSync } from 'node:fs';
import { readDsdContainerFacts, DsdContainerError, type DsdContainerFacts } from './dsd-container-facts.js';
import { createHash } from 'node:crypto';
import { loadMetadataEndOfStreamError, loadMetadataParser } from './metadata-reader-runtime.js';
import { parentPort, workerData } from 'node:worker_threads';
import type { parseFromTokenizer } from 'music-metadata';
import { METADATA_PARSER_VERSION, CUE_HEADER_METADATA_PARSER_VERSION } from './metadata-reader-types.js';
import type { MetadataReadEvidence, MetadataReadResult, MetadataReadFailure, MetadataWorkerInput, MetadataTechnical, MetadataRawFields, MetadataCoverEvidence, MetadataWorkerPhase, MetadataWorkerResultMessage } from './metadata-reader-types.js';

type Tokenizer = Parameters<typeof parseFromTokenizer>[0];
type Token<T> = { len: number; get(array: Uint8Array, offset: number): T };
type ReadOptions = Parameters<Tokenizer['readBuffer']>[1];
const input = workerData as MetadataWorkerInput;
const budget = input.budget, started = performance.now();
let bytesRead = 0, readCalls = 0, maxReadBytes = 0, allocationBytes = 0;
let phase: MetadataWorkerPhase = 'dependency-load';
class ReaderFailure extends Error { constructor(readonly code: MetadataReadFailure) { super(code); } }
const fail = (code: MetadataReadFailure): never => { throw new ReaderFailure(code); };
const integer = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;
const checkTime = (): void => { if (performance.now() - started > budget.timeoutMs) fail('TIMEOUT'); };
const reserve = (n: number): void => {
  checkTime();
  if (!integer(n) || n > budget.singleAllocationBytes || allocationBytes + n > budget.totalAllocationBytes) fail('BUDGET_EXCEEDED');
  allocationBytes += n;
};
interface WaveFormatFacts {
  codec: 'PCM' | 'IEEE_FLOAT' | 'WAVE_EXTENSIBLE_UNKNOWN' | null;
  lossless: boolean | null; sampleRateHz: number; channels: number; bitsPerSample: number; blockAlign: number;
}
/** 同一有界 FD 读到的完整 fmt 结构；fact 的存在不决定编码是否有损。 */
function waveFormatFacts(bytes: Uint8Array, chunkBytes: number): WaveFormatFacts {
  checkTime();
  if (chunkBytes < 16 || bytes.length < 16) fail('PARSE_FAILED');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = v.getUint16(0, true), channels = v.getUint16(2, true), sampleRateHz = v.getUint32(4, true);
  const byteRate = v.getUint32(8, true), blockAlign = v.getUint16(12, true), bitsPerSample = v.getUint16(14, true);
  if (channels < 1 || channels > 64 || sampleRateHz < 1 || sampleRateHz > 1_000_000_000) fail('PARSE_FAILED');
  let cbSize = 0;
  if (chunkBytes !== 16) {
    if (chunkBytes < 18 || bytes.length < 18) fail('PARSE_FAILED');
    cbSize = v.getUint16(16, true);
    if (18 + cbSize > chunkBytes) fail('PARSE_FAILED');
  }
  let codec: WaveFormatFacts['codec'] = tag === 1 ? 'PCM' : tag === 3 ? 'IEEE_FLOAT' : null;
  let validBits = bitsPerSample, channelMask = 0;
  if (tag === 0xfffe) {
    if (chunkBytes < 40 || bytes.length < 40 || cbSize < 22) fail('PARSE_FAILED');
    validBits = v.getUint16(18, true); channelMask = v.getUint32(20, true);
    // 完整比较 GUID；不能凭 Data1 的低字或容器位宽给未知子格式 PCM 资格。
    const guid = Buffer.from(bytes.subarray(24, 40)).toString('hex');
    codec = guid === '0100000000001000800000aa00389b71' ? 'PCM'
      : guid === '0300000000001000800000aa00389b71' ? 'IEEE_FLOAT' : 'WAVE_EXTENSIBLE_UNKNOWN';
  }
  let lossless: boolean | null = null;
  if (codec === 'PCM' || codec === 'IEEE_FLOAT') {
    if (bitsPerSample < 8 || bitsPerSample > 64 || bitsPerSample % 8 !== 0
      || validBits < 1 || validBits > bitsPerSample || blockAlign !== channels * bitsPerSample / 8
      || byteRate !== sampleRateHz * blockAlign
      || codec === 'IEEE_FLOAT' && (![32, 64].includes(bitsPerSample) || validBits !== bitsPerSample)) fail('PARSE_FAILED');
    let maskChannels = 0;
    for (let bit = 0; bit < 32; ++bit) maskChannels += channelMask >>> bit & 1;
    if (channelMask !== 0 && maskChannels !== channels) fail('PARSE_FAILED');
    lossless = true;
  } else if (tag !== 0xfffe && [0x0002, 0x0006, 0x0007, 0x0011, 0x0031, 0x0050, 0x0055, 0x00ff, 0x1600, 0x1602].includes(tag)) {
    lossless = false; // 已知有损编码；其它编码保持未知，不能从 data/fact 推断。
  }
  // 这里的位宽是容器位宽；validBits=24 的 32-bit 容器仍按 32-bit 传输。
  return { codec, lossless, sampleRateHz, channels, bitsPerSample, blockAlign };
}
type BoundedReadAt = (at: number, length: number) => Promise<Uint8Array>;
interface CueHeaderFacts {
  codec: string; lossless: boolean; sampleRateHz: number; channels: number;
  bitsPerSample: number | null; durationSeconds: number | null;
}
const byteView = (bytes: Uint8Array): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const byteText = (bytes: Uint8Array, at: number, length: number): string => String.fromCharCode(...bytes.subarray(at, at + length));
const boundedEnd = (at: number, bytes: number, limit = input.size): number => {
  const end = at + bytes;
  if (!integer(at) || !integer(bytes) || !integer(end) || end > limit) fail('PARSE_FAILED');
  return end;
};
/** 仅用于头、seek 表和有限首段的完整性；不读取整件音频，也不签 Native 解码。 */
function headerCRC32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; ++index) {
    if ((index & 4095) === 0) checkTime();
    crc ^= bytes[index]!;
    for (let bit = 0; bit < 8; ++bit) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function oggPageCRC(bytes: Uint8Array): number {
  let crc = 0;
  for (let index = 0; index < bytes.length; ++index) {
    if ((index & 4095) === 0) checkTime();
    crc ^= (index >= 22 && index < 26 ? 0 : bytes[index]!) << 24;
    for (let bit = 0; bit < 8; ++bit) crc = (crc << 1 ^ (crc & 0x80000000 ? 0x04c11db7 : 0)) >>> 0;
  }
  return crc >>> 0;
}
let takCRCTable: Uint32Array | undefined;
function takHeaderCRC24(bytes: Uint8Array): number {
  if (!takCRCTable) {
    takCRCTable = new Uint32Array(256);
    for (let index = 0; index < 256; ++index) {
      let c = index << 24 >>> 0;
      for (let bit = 0; bit < 8; ++bit) c = (c << 1 ^ (c & 0x80000000 ? 0x864cfb00 : 0)) >>> 0;
      takCRCTable[index] = ((c >>> 24) | (c >>> 8 & 0xff00) | (c << 8 & 0xff0000) | (c << 24)) >>> 0;
    }
  }
  let crc = 0xce04b7;
  for (let index = 0; index < bytes.length; ++index) {
    if ((index & 4095) === 0) checkTime();
    crc = (takCRCTable[(crc & 255) ^ bytes[index]!]! ^ crc >>> 8) >>> 0;
  }
  return crc & 0xffffff;
}
const be24 = (bytes: Uint8Array, at: number): number => bytes[at]! * 65536 + bytes[at + 1]! * 256 + bytes[at + 2]!;
class HeaderLittleBits {
  position = 0;
  constructor(readonly bytes: Uint8Array) {}
  get(width: number): number {
    checkTime();
    if (!integer(width) || width > 40 || this.position + width > this.bytes.length * 8) fail('PARSE_FAILED');
    let value = 0;
    for (let bit = 0; bit < width; ++bit, ++this.position) value += (this.bytes[this.position >>> 3]! >>> (this.position & 7) & 1) * 2 ** bit;
    return value;
  }
  align(): void { this.position = Math.ceil(this.position / 8) * 8; }
}
interface TakHeaderInfo extends CueHeaderFacts { codecId: number; profile: number; samples: number; frameSamples: number }
function takStreamInfo(bits: HeaderLittleBits): TakHeaderInfo {
  const codecId = bits.get(6), profile = bits.get(4), frameType = bits.get(4), samples = bits.get(35);
  const dataType = bits.get(3), sampleRateHz = bits.get(18) + 6000, bitsPerSample = bits.get(5) + 8, channels = bits.get(4) + 1;
  if (bits.get(1)) { bits.get(5); if (bits.get(1)) for (let channel = 0; channel < channels; ++channel) bits.get(6); }
  const quants = [3, 4, 6, 8, 4096, 8192, 16384, 512, 1024, 2048];
  if (frameType >= quants.length || samples < 1) fail('PARSE_FAILED');
  const frameSamples = frameType <= 3 ? Math.floor(sampleRateHz * quants[frameType]! / 32) : quants[frameType]!;
  if (frameSamples < 1 || frameSamples > (frameType <= 3 ? 16384 : Math.floor(sampleRateHz * 8 / 32))) fail('PARSE_FAILED');
  if (![2, 4].includes(codecId) || dataType !== 0 || ![8, 16, 24].includes(bitsPerSample)
    || channels > 6 || codecId === 2 && channels > 2) fail('UNSUPPORTED');
  return { codec: 'TAK', lossless: true, sampleRateHz, channels, bitsPerSample, durationSeconds: samples / sampleRateHz,
    codecId, profile, samples, frameSamples };
}
function sameTakInfo(first: TakHeaderInfo, second: TakHeaderInfo): boolean {
  return (['codecId', 'profile', 'samples', 'frameSamples', 'sampleRateHz', 'channels', 'bitsPerSample'] as const).every(key => first[key] === second[key]);
}
async function readTakHeaderFacts(readAt: BoundedReadAt): Promise<CueHeaderFacts> {
  let at = 4, info: TakHeaderInfo | undefined, last: { offset: number; bytes: number } | undefined, audioAt: number | undefined;
  for (let blocks = 0; blocks < 4096; ++blocks) {
    const header = await readAt(at, 4), type = header[0]! & 0x7f, size = header[1]! + header[2]! * 256 + header[3]! * 65536;
    const next = boundedEnd(at + 4, size);
    if (type > 7) fail('UNSUPPORTED');
    if (size > budget.singleAllocationBytes) fail('BUDGET_EXCEEDED');
    if (type === 0) { if (size !== 0) fail('PARSE_FAILED'); audioAt = next; break; }
    if ([1, 4, 6, 7].includes(type)) {
      if (size <= 3 || type === 6 && size !== 19 || type === 7 && size !== 11) fail('PARSE_FAILED');
      const data = await readAt(at + 4, size), body = data.subarray(0, size - 3);
      if (takHeaderCRC24(body) !== be24(data, size - 3)) fail('PARSE_FAILED');
      if (type === 1) {
        if (info || body.length < 10 || body.length > 23) fail('PARSE_FAILED');
        const bits = new HeaderLittleBits(body); info = takStreamInfo(bits);
        if (Math.ceil(bits.position / 8) !== body.length) fail('PARSE_FAILED');
      } else if (type === 7) {
        if (last) fail('PARSE_FAILED');
        const bits = new HeaderLittleBits(body); last = { offset: bits.get(40), bytes: bits.get(24) };
        if (last.bytes < 12) fail('PARSE_FAILED');
      }
    }
    at = next;
  }
  if (audioAt === undefined || !info) return fail('PARSE_FAILED');
  const stream = info, start = audioAt;
  const frame = async (position: number, end: number, expectedNumber: number, expectLast: boolean): Promise<void> => {
    if (end - position < 12) fail('PARSE_FAILED');
    const data = await readAt(position, Math.min(40, end - position)), bits = new HeaderLittleBits(data);
    if (bits.get(16) !== 0xa0ff) fail('PARSE_FAILED');
    const flags = bits.get(3), number = bits.get(21);
    if (flags & 4 || number !== expectedNumber || Boolean(flags & 1) !== expectLast) fail('PARSE_FAILED');
    const count = flags & 1 ? bits.get(14) + 1 : stream.frameSamples;
    if (flags & 1) bits.get(2);
    if (flags & 2) {
      if (!sameTakInfo(stream, takStreamInfo(bits))) fail('PARSE_FAILED');
      if (bits.get(6)) bits.get(25);
      bits.align();
    } else if (expectedNumber === 0) fail('PARSE_FAILED');
    const headerBytes = bits.position / 8;
    if (!integer(headerBytes) || headerBytes + 7 > end - position || headerBytes + 3 > data.length
      || takHeaderCRC24(data.subarray(0, headerBytes)) !== be24(data, headerBytes)) fail('PARSE_FAILED');
    const expectedSamples = expectLast ? stream.samples - expectedNumber * stream.frameSamples : stream.frameSamples;
    if (count !== expectedSamples || count < 1 || count > stream.frameSamples) fail('PARSE_FAILED');
    await readAt(position + headerBytes + 3, 1); // 真实音频载荷存在；不检查整帧残差或 body CRC。
  };
  const frameCount = Math.ceil(stream.samples / stream.frameSamples);
  if (!integer(frameCount) || frameCount < 1 || frameCount > 2 ** 21) fail('PARSE_FAILED');
  const audioEnd = last ? boundedEnd(start, last.offset + last.bytes) : input.size;
  await frame(start, audioEnd, 0, frameCount === 1);
  if (last) {
    const lastAt = boundedEnd(start, last.offset, audioEnd);
    if (frameCount === 1 && last.offset !== 0 || frameCount > 1 && last.offset === 0) fail('PARSE_FAILED');
    await frame(lastAt, audioEnd, frameCount - 1, true);
  }
  return stream;
}
async function readTtaHeaderFacts(readAt: BoundedReadAt): Promise<CueHeaderFacts> {
  const header = await readAt(0, 22), h = byteView(header), format = h.getUint16(4, true);
  const channels = h.getUint16(6, true), bitsPerSample = h.getUint16(8, true), sampleRateHz = h.getUint32(10, true), samples = h.getUint32(14, true);
  if (headerCRC32(header.subarray(0, 18)) !== h.getUint32(18, true) || channels < 1 || channels > 16
    || sampleRateHz < 1 || sampleRateHz > 1_000_000 || samples < 1) fail('PARSE_FAILED');
  if (format !== 1 || ![8, 16, 24].includes(bitsPerSample)) fail('UNSUPPORTED');
  const frameSamples = Math.floor(sampleRateHz * 256 / 245), frameCount = Math.ceil(samples / frameSamples), seekBytes = frameCount * 4;
  if (!integer(frameCount) || frameSamples < 1 || frameCount < 1 || !integer(seekBytes)) fail('PARSE_FAILED');
  if (seekBytes + 4 > budget.singleAllocationBytes || seekBytes + 4 > budget.singleReadBytes) fail('BUDGET_EXCEEDED');
  const seek = await readAt(22, seekBytes + 4), v = byteView(seek);
  if (headerCRC32(seek.subarray(0, seekBytes)) !== v.getUint32(seekBytes, true)) fail('PARSE_FAILED');
  const audioAt = boundedEnd(22, seekBytes + 4); let end = audioAt, lastAt = audioAt;
  for (let index = 0; index < frameCount; ++index) {
    checkTime(); const size = v.getUint32(index * 4, true);
    if (size < 5) fail('PARSE_FAILED'); lastAt = end; end = boundedEnd(end, size);
  }
  await readAt(audioAt, 1); if (lastAt !== audioAt) await readAt(lastAt, 1); await readAt(end - 4, 4);
  return { codec: 'TTA', lossless: true, sampleRateHz, channels, bitsPerSample, durationSeconds: samples / sampleRateHz };
}
async function readApeHeaderFacts(readAt: BoundedReadAt): Promise<CueHeaderFacts> {
  const descriptor = byteView(await readAt(0, 52)), version = descriptor.getUint16(4, true);
  const descriptorBytes = descriptor.getUint32(8, true), headerBytes = descriptor.getUint32(12, true), seekBytes = descriptor.getUint32(16, true);
  const waveBytes = descriptor.getUint32(20, true), frameBytes = descriptor.getUint32(24, true), frameHigh = descriptor.getUint32(28, true), tailBytes = descriptor.getUint32(32, true);
  if (version < 3980 || version > 3990 || headerBytes !== 24 || frameHigh !== 0) fail('UNSUPPORTED');
  if (descriptor.getUint16(6, true) !== 0 || descriptorBytes < 52 || seekBytes < 4 || seekBytes % 4 !== 0 || frameBytes < 8) fail('PARSE_FAILED');
  if (descriptorBytes > budget.singleAllocationBytes || seekBytes > budget.singleAllocationBytes || waveBytes > budget.singleAllocationBytes) fail('BUDGET_EXCEEDED');
  const header = byteView(await readAt(descriptorBytes, 24)), compression = header.getUint16(0, true), blocks = header.getUint32(4, true);
  const finalBlocks = header.getUint32(8, true), frames = header.getUint32(12, true), bitsPerSample = header.getUint16(16, true), channels = header.getUint16(18, true), sampleRateHz = header.getUint32(20, true);
  const samples = (frames - 1) * blocks + finalBlocks;
  if (compression < 1000 || compression > 5000 || compression % 1000 !== 0 || blocks < 1 || frames < 1
    || finalBlocks < 1 || finalBlocks > blocks || frames > seekBytes / 4 || !integer(samples) || samples < 1
    || ![8, 16, 24, 32].includes(bitsPerSample) || channels < 1 || channels > 2 || sampleRateHz < 1 || sampleRateHz > 1_000_000_000) fail('PARSE_FAILED');
  const seekAt = boundedEnd(descriptorBytes, headerBytes), audioAt = boundedEnd(boundedEnd(seekAt, seekBytes), waveBytes);
  const audioEnd = boundedEnd(audioAt, frameBytes); boundedEnd(audioEnd, tailBytes);
  const seek = byteView(await readAt(seekAt, seekBytes)); let previous = audioAt - 1;
  for (let index = 0; index < frames; ++index) {
    checkTime(); const position = seek.getUint32(index * 4, true);
    if (position < audioAt || position >= audioEnd || position <= previous || index === 0 && position !== audioAt) fail('PARSE_FAILED'); previous = position;
  }
  await readAt(audioAt, 8); await readAt(audioEnd - 1, 1);
  return { codec: 'APE', lossless: true, sampleRateHz, channels, bitsPerSample, durationSeconds: samples / sampleRateHz };
}
async function readMusepackHeaderFacts(readAt: BoundedReadAt): Promise<CueHeaderFacts> {
  const magic = byteText(await readAt(0, 4), 0, 4), rates = [44100, 48000, 37800, 32000];
  if (magic.slice(0, 3) === 'MP+') {
    const header = await readAt(0, 28), frames = byteView(header).getUint32(4, true), sampleRateHz = rates[header[10]! & 3]!;
    if (![7, 0x17].includes(header[3]!) || frames < 1 || frames * 21 + 8 > (input.size - 24) * 8) fail('PARSE_FAILED');
    const frameBits = byteView(header).getUint32(24, true) >>> 4 & 0xfffff;
    if (frameBits < 1 || Math.ceil((frameBits + 28) / 32) * 4 > input.size - 24) fail('PARSE_FAILED');
    // 固定 demux 的声明是 stereo、fcount*1152；MM 的 IS/MSS 和 gapless 派生不是解码 PCM 事实。
    return { codec: 'musepack7', lossless: false, sampleRateHz, channels: 2, bitsPerSample: 16, durationSeconds: frames * 1152 / sampleRateHz };
  }
  let at = 4, info: CueHeaderFacts | undefined, audio = false, ended = false;
  const variable = (bytes: Uint8Array, start: number): { value: number; next: number } => {
    let value = 0;
    for (let count = 0, cursor = start; count < 8 && cursor < bytes.length; ++count, ++cursor) {
      const byte = bytes[cursor]!; value = value * 128 + (byte & 127);
      if (!integer(value)) fail('PARSE_FAILED');
      if (!(byte & 128)) return { value, next: cursor + 1 };
    }
    return fail('PARSE_FAILED');
  };
  for (let chunks = 0; chunks < 16_384; ++chunks) {
    if (input.size - at < 3) fail('PARSE_FAILED');
    const header = await readAt(at, Math.min(10, input.size - at)), tag = byteText(header, 0, 2), size = variable(header, 2);
    if (!/^[A-Z]{2}$/u.test(tag) || size.value < size.next) fail('PARSE_FAILED');
    const next = boundedEnd(at, size.value), payloadAt = at + size.next, payloadBytes = size.value - size.next;
    if (tag === 'SH') {
      if (info || payloadBytes < 9 || payloadBytes > 26) fail('PARSE_FAILED');
      const body = await readAt(payloadAt, payloadBytes);
      if (byteView(body).getUint32(0) === 0 || body[4] !== 8) fail('PARSE_FAILED');
      const count = variable(body, 5), silence = variable(body, count.next);
      if (silence.next + 2 !== body.length || count.value < 1 || silence.value > count.value) fail('PARSE_FAILED');
      const sampleRateHz = rates[body[silence.next]! >>> 5], channels = (body[silence.next + 1]! >>> 4) + 1;
      if (!sampleRateHz || channels > 2) return fail('UNSUPPORTED');
      // SH 的 CRC 字段只验证非零与完整边界；固定 demux 未检查它，不冒称已验 CRC。
      info = { codec: 'musepack8', lossless: false, sampleRateHz, channels, bitsPerSample: 16, durationSeconds: count.value / sampleRateHz };
    } else if (tag === 'AP') {
      if (!info || payloadBytes < 1) fail('PARSE_FAILED'); await readAt(payloadAt, 1); audio = true;
    } else if (tag === 'SE') {
      if (payloadBytes !== 0 || !audio || !info) fail('PARSE_FAILED'); ended = true; break;
    }
    at = next;
  }
  if (!ended || !info) return fail('PARSE_FAILED'); return info;
}
async function checkWavpackHeader(readAt: BoundedReadAt): Promise<void> {
  const header = byteView(await readAt(0, 32)), end = boundedEnd(0, header.getUint32(4, true) + 8), version = header.getUint16(8, true), flags = header.getUint32(24, true);
  if (version < 0x402 || version > 0x410 || end <= 34 || header.getUint32(16, true) !== 0 || header.getUint32(20, true) < 1) fail('PARSE_FAILED');
  if (flags & 0x80000000) fail('UNSUPPORTED'); // WavPack DSD 不借 CUE 开关绕过独立 DSD/48k 策略。
  let at = 32, audio = false;
  for (let blocks = 0; at < end; ++blocks) {
    if (blocks >= 4096 || end - at < 2) fail('PARSE_FAILED');
    const first = await readAt(at, 2), large = Boolean(first[0]! & 0x80), odd = first[0]! >>> 6 & 1;
    const length = large ? await readAt(at + 1, 3) : first.subarray(1, 2), words = length[0]! + (large ? length[1]! * 256 + length[2]! * 65536 : 0);
    const bytes = words * 2 - odd, payloadAt = at + (large ? 4 : 2), next = boundedEnd(payloadAt, words * 2, end);
    if (bytes < 0) fail('PARSE_FAILED');
    if ((first[0]! & 0x3f) === 10) { if (bytes < 1) fail('PARSE_FAILED'); await readAt(payloadAt, 1); audio = true; }
    at = next;
  }
  if (at !== end || !audio) fail('PARSE_FAILED');
}
async function readOggHeaderFacts(readAt: BoundedReadAt): Promise<CueHeaderFacts> {
  let at = 0, serial: number | undefined, sequence = 0, packetBytes = 0, packetNumber = 0;
  let parts: Uint8Array[] = [], info: CueHeaderFacts | undefined;
  for (let pages = 0; pages < 4096; ++pages) {
    const header = await readAt(at, 27), h = byteView(header), flags = header[5]!;
    if (byteText(header, 0, 4) !== 'OggS' || header[4] !== 0 || flags > 7 || pages === 0 && (flags & 3) !== 2
      || pages !== 0 && (Boolean(flags & 1) !== (packetBytes > 0) || flags & 2)) fail('PARSE_FAILED');
    const currentSerial = h.getUint32(14, true), currentSequence = h.getUint32(18, true);
    if (serial !== undefined && currentSerial !== serial) fail('UNSUPPORTED');
    if (currentSequence !== sequence) fail('PARSE_FAILED'); serial = currentSerial; ++sequence;
    const lacing = await readAt(at + 27, header[26]!), payloadBytes = lacing.reduce((sum, n) => sum + n, 0), pageBytes = 27 + lacing.length + payloadBytes;
    const end = boundedEnd(at, pageBytes), page = await readAt(at, pageBytes);
    if (oggPageCRC(page) !== h.getUint32(22, true)) fail('PARSE_FAILED');
    let cursor = 27 + lacing.length;
    for (const size of lacing) {
      packetBytes += size; if (packetBytes > budget.singleAllocationBytes) fail('BUDGET_EXCEEDED');
      parts.push(page.subarray(cursor, cursor + size)); cursor += size;
      if (size === 255) continue;
      const packet = Buffer.concat(parts, packetBytes); parts = []; packetBytes = 0;
      if (packetNumber === 0) {
        if (byteText(packet, 0, 8) === 'OpusHead') {
          if (packet.length < 19 || packet[8]! > 15 || packet[9]! < 1 || packet[9]! > 64) fail('PARSE_FAILED');
          const channels = packet[9]!, family = packet[18]!;
          if (family === 0) { if (channels > 2 || packet.length !== 19) fail('PARSE_FAILED'); }
          else {
            if (packet.length !== 21 + channels || packet[19]! < 1 || packet[20]! > packet[19]! || packet[19]! + packet[20]! > 255) fail('PARSE_FAILED');
            for (let channel = 0; channel < channels; ++channel) if (packet[21 + channel] !== 255 && packet[21 + channel]! >= packet[19]! + packet[20]!) fail('PARSE_FAILED');
          }
          // OpusHead inputSampleRate 是编码前提示；规范时钟 48000 仍只是头事实，不能冒称已解码。
          info = { codec: 'Opus', lossless: false, sampleRateHz: 48000, channels, bitsPerSample: null, durationSeconds: null };
        } else if (packet[0] === 1 && byteText(packet, 1, 6) === 'vorbis') {
          if (packet.length !== 30) fail('PARSE_FAILED'); const v = byteView(packet), channels = packet[11]!, sampleRateHz = v.getUint32(12, true);
          const lowBlock = packet[28]! & 15, highBlock = packet[28]! >>> 4;
          if (v.getUint32(7, true) !== 0 || channels < 1 || channels > 64 || sampleRateHz < 1 || sampleRateHz > 1_000_000_000
            || lowBlock < 6 || highBlock > 13 || lowBlock > highBlock || !(packet[29]! & 1)) fail('PARSE_FAILED');
          info = { codec: 'Vorbis', lossless: false, sampleRateHz, channels, bitsPerSample: null, durationSeconds: null };
        } else fail('UNSUPPORTED'); // 固定 Factory 的 Speex/Theora/OggFLAC 不随本开关准入。
      } else if (!info) fail('PARSE_FAILED');
      else if (info.codec === 'Opus') {
        if (packetNumber === 1) { if (packet.length < 8 || byteText(packet, 0, 8) !== 'OpusTags') fail('PARSE_FAILED'); }
        else { if (packet.length < 1) fail('PARSE_FAILED'); return info; }
      } else if (packetNumber < 3) {
        if (packet.length < 7 || packet[0] !== (packetNumber === 1 ? 3 : 5) || byteText(packet, 1, 6) !== 'vorbis') fail('PARSE_FAILED');
      } else { if (packet.length < 1 || packet[0]! & 1) fail('PARSE_FAILED'); return info; }
      ++packetNumber;
    }
    if (flags & 4) fail('PARSE_FAILED'); at = end;
  }
  return fail('BUDGET_EXCEEDED');
}

/** 在第三方模块加载之前，限制这个独占worker里的字节分配；主线程原生对象不变。 */
function guardAllocations(): void {
  const originalByteLength = Buffer.byteLength;
  const sizeOf = (arg: unknown): number => {
    if (typeof arg === 'number') return arg;
    if (typeof arg === 'string') return originalByteLength(arg, 'utf8');
    if (ArrayBuffer.isView(arg)) return arg.byteLength;
    if (arg instanceof ArrayBuffer) return arg.byteLength;
    if (Array.isArray(arg)) return arg.length;
    return fail('BUDGET_EXCEEDED');
  };
  for (const name of ['alloc', 'allocUnsafe', 'allocUnsafeSlow'] as const) {
    if (!Reflect.set(Buffer,name,new Proxy(Buffer[name], { apply(target, receiver, args) { reserve(sizeOf(args[0])); return Reflect.apply(target, receiver, args); } }))) fail('WORKER_FAILED');
  }
  Buffer.from = new Proxy(Buffer.from, { apply(target, receiver, args) {
    reserve(typeof args[0] === 'string' ? originalByteLength(args[0], args[1] ?? 'utf8') : sizeOf(args[0])); return Reflect.apply(target, receiver, args);
  } });
  Buffer.concat = new Proxy(Buffer.concat, { apply(target, receiver, args) {
    const arrays = args[0] as Uint8Array[];
    if (!Array.isArray(arrays) || arrays.length > 4096) fail('BUDGET_EXCEEDED');
    reserve(args[1] ?? arrays.reduce((sum, array) => sum + array.byteLength, 0)); return Reflect.apply(target, receiver, args);
  } });
  // 同时拦住其他TypedArray直接构造，防止它们绕过全局ArrayBuffer入口。
  for (const name of ['Int8Array','Uint8Array','Uint8ClampedArray','Int16Array','Uint16Array','Int32Array','Uint32Array','Float32Array','Float64Array','BigInt64Array','BigUint64Array']) {
    const original = Reflect.get(globalThis,name) as typeof Uint8Array;
    const wrapped = new Proxy(original, { construct(target,args,newTarget) {
      const arg: unknown = args[0];
      let size: number;
      if (args.length === 0) size = 0;
      else if (typeof arg === 'number') size = arg * original.BYTES_PER_ELEMENT;
      else if (arg instanceof ArrayBuffer) size = args[2] === undefined ? arg.byteLength - (args[1] ?? 0) : args[2] * original.BYTES_PER_ELEMENT;
      else if (Array.isArray(arg)) size = arg.length * original.BYTES_PER_ELEMENT;
      else if (ArrayBuffer.isView(arg) && 'length' in arg) size = (arg as Uint8Array).length * original.BYTES_PER_ELEMENT;
      else return fail('BUDGET_EXCEEDED');
      reserve(size); return Reflect.construct(target,args,newTarget);
    } });
    if (!Reflect.set(globalThis,name,wrapped)) fail('WORKER_FAILED');
  }
  globalThis.ArrayBuffer = new Proxy(ArrayBuffer, { construct(target, args, newTarget) { reserve(sizeOf(args[0])); return Reflect.construct(target, args, newTarget); } });
}
const evidence = (): MetadataReadEvidence => ({ bytesRead, readCalls, maxReadBytes, allocationBytes, elapsedMs: Math.max(0, performance.now() - started), wholeAudioHash: false, wholeAudioDecode: false });

async function run(): Promise<MetadataReadResult> {
  guardAllocations();
  // 构建器强制直接strtok3与music-metadata依赖指向同一canonical EOF入口。
  const EndOfStreamError = await loadMetadataEndOfStreamError();
  checkTime();
  const dffPaddedHeaders = new Map<number,number>();
  const waveEmptyListHeaders = new Set<number>();
  class BoundedFdTokenizer implements Tokenizer {
    position = 0;
    readonly fileInfo: Tokenizer['fileInfo'] = { size: input.size }; // 不提供路径；格式仅由真实字节准入后选择。
    supportsRandomAccess(): boolean { return true; }
    setPosition(n: number): void { checkTime(); if (!integer(n) || n > input.size) fail('PARSE_FAILED'); this.position = n; }
    async peekBuffer(buffer: Uint8Array, options?: ReadOptions): Promise<number> {
      checkTime(); const at = options?.position ?? this.position, requested = options?.length ?? buffer.byteLength;
      if (!integer(at) || !integer(requested) || requested > buffer.byteLength || at > input.size) fail('PARSE_FAILED');
      if (requested > budget.singleReadBytes || bytesRead + requested > budget.totalReadBytes) fail('BUDGET_EXCEEDED');
      const count = Math.min(requested, input.size - at);
      if (!options?.mayBeLess && count < requested) throw new EndOfStreamError();
      let offset = 0;
      while (offset < count) {
        checkTime(); const got = readSync(input.fd, buffer, offset, count - offset, at + offset);
        ++readCalls; bytesRead += got; maxReadBytes = Math.max(maxReadBytes, count - offset);
        if (got === 0) break; offset += got;
      }
      checkTime(); if (!options?.mayBeLess && offset < requested) throw new EndOfStreamError(); return offset;
    }
    async readBuffer(buffer: Uint8Array, options?: ReadOptions): Promise<number> {
      const at = options?.position ?? this.position, got = await this.peekBuffer(buffer, options); this.position = at + got; return got;
    }
    async peekToken<T>(token: Token<T>, at?: number | null, mayBeLess?: boolean): Promise<T> {
      const buffer = new Uint8Array(token.len); // 私有Uint8Array门禁在分配前检查token.len。
      const got = await this.peekBuffer(buffer, { position: at ?? this.position, mayBeLess: mayBeLess ?? false });
      // 11.15 DSDIFF Parser 未计pad；只适配已实际验界的12字节头token，原FD与来源事实不变。
      const originalPayload = token.len === 12 ? dffPaddedHeaders.get(at ?? this.position) : undefined;
      if (originalPayload !== undefined && got === 12) new DataView(buffer.buffer,buffer.byteOffset,buffer.byteLength).setBigUint64(4,BigInt(originalPayload+1));
      // 空 LIST 缺少类型字段；只在解析视图中把已验界的原 8 字节头视作 JUNK，原 FD 字节不变。
      if (phase === 'parse' && token.len === 8 && waveEmptyListHeaders.has(at ?? this.position)) {
        if (got !== 8 || buffer[0] !== 0x4c || buffer[1] !== 0x49 || buffer[2] !== 0x53 || buffer[3] !== 0x54
          || new DataView(buffer.buffer,buffer.byteOffset,buffer.byteLength).getUint32(4,true) !== 0) fail('PARSE_FAILED');
        buffer[0] = 0x4a; buffer[1] = 0x55; buffer[2] = 0x4e; buffer[3] = 0x4b;
      }
      if (got < token.len) throw new EndOfStreamError(); return token.get(buffer, 0);
    }
    async readToken<T>(token: Token<T>, at?: number): Promise<T> { const position = at ?? this.position; const v = await this.peekToken(token, position); this.position = position + token.len; return v; }
    async peekNumber(token: Token<number>): Promise<number> { return this.peekToken(token); }
    async readNumber(token: Token<number>): Promise<number> { return this.readToken(token); }
    async ignore(n: number): Promise<number> { checkTime(); if (!integer(n)) fail('PARSE_FAILED'); const count = Math.min(n, input.size - this.position); this.position += count; return count; }
    async close(): Promise<void> { /* FD所有权留在父线程；这里只结束tokenizer租用。 */ }
    async abort(): Promise<void> { /* 父线程用Worker.terminate终止并等待真实exit。 */ }
  }
  phase = 'container-check';
  const tokenizer = new BoundedFdTokenizer(), head = new Uint8Array(Math.min(64, input.size));
  await tokenizer.peekBuffer(head, { mayBeLess: true });
  const ascii = (at: number, length: number): string => String.fromCharCode(...head.subarray(at, at + length));
  let container: MetadataTechnical['container'];
  if (ascii(0,4) === 'fLaC') container = 'FLAC';
  else if (ascii(0,4) === 'RIFF' && ascii(8,4) === 'WAVE') container = 'WAVE';
  else if (ascii(0,4) === 'FORM' && ['AIFF','AIFC'].includes(ascii(8,4))) container = 'AIFF';
  else if (ascii(4,4) === 'ftyp') container = 'MP4';
  else if (input.dsdMetadataEnabled === true && ascii(0,4) === 'DSD ') container = 'DSF';
  else if (input.dsdMetadataEnabled === true && ascii(0,4) === 'FRM8' && ascii(12,4) === 'DSD ') container = 'DFF';
  else if (input.cueInputMetadataEnabled === true && ascii(0,4) === 'OggS') container = 'OGG';
  else if (input.cueInputMetadataEnabled === true && ascii(0,4) === 'wvpk') container = 'WAVPACK';
  else if (input.cueInputMetadataEnabled === true && ascii(0,4) === 'MAC ') container = 'APE';
  else if (input.cueInputMetadataEnabled === true && ascii(0,4) === 'TTA1') container = 'TTA';
  else if (input.cueInputMetadataEnabled === true && (ascii(0,4) === 'MPCK' || ascii(0,3) === 'MP+' && [7,0x17].includes(head[3]!))) container = 'MPC';
  else if (input.cueInputMetadataEnabled === true && ascii(0,4) === 'tBaK') container = 'TAK';
  else if (ascii(0,3) === 'ID3' || head[0] === 0xff && (head[1]! & 0xe0) === 0xe0) container = 'MPEG';
  else return fail('UNSUPPORTED');
  const readAt = async (at: number, length: number): Promise<Uint8Array> => {
    const buffer = new Uint8Array(length); await tokenizer.peekBuffer(buffer,{position:at}); return buffer;
  };
  const textAt = (b: Uint8Array,at: number,length: number): string => String.fromCharCode(...b.subarray(at,at+length));
  const view = (b: Uint8Array): DataView => new DataView(b.buffer,b.byteOffset,b.byteLength);
  // 先检查容器边界与存在的音频载荷，再进入Parser；magic/扩展名本身不能构成成功。
  let dsd: DsdContainerFacts | undefined, wave: WaveFormatFacts | undefined, cue: CueHeaderFacts | undefined;
  if (container === 'DSF' || container === 'DFF') {
    try { dsd = await readDsdContainerFacts(input.size,readAt); }
    catch (error) { if (error instanceof DsdContainerError) fail(error.code); throw error; }
    for (const h of dsd.paddedChunkHeaders ?? []) dffPaddedHeaders.set(h.at,h.payloadBytes);
    // 已完整核验的容器事实选择固定 Parser，避免 4100 字节嗅探音频与 DFF 被 audio/dsf 误选。
    tokenizer.fileInfo.mimeType = dsd.container === 'DSF' ? 'audio/dsf' : 'audio/dsd';
  } else if (container === 'FLAC') {
    let at = 4, blocks = 0, last = false;
    while (!last) {
      if (++blocks > 2048) fail('BUDGET_EXCEEDED');
      const h = await readAt(at,4), kind = h[0]! & 0x7f, size = h[1]! * 65536 + h[2]! * 256 + h[3]!;
      if (blocks === 1 && (kind !== 0 || size !== 34) || kind > 6 || at + 4 + size >= input.size) fail('PARSE_FAILED');
      if (size > budget.singleAllocationBytes) fail('BUDGET_EXCEEDED');
      last = (h[0]! & 0x80) !== 0; at += 4 + size;
    }
    // 最多32字节首frame结构；只核header CRC8与最小载荷，绝不全decode/hash。
    const remaining = input.size - at;
    if (remaining < 6) fail('PARSE_FAILED');
    const frame = await readAt(at,Math.min(32,remaining));
    if (frame[0] !== 0xff || (frame[1]! & 0xfe) !== 0xf8 || (frame[3]! & 1) !== 0) fail('PARSE_FAILED');
    const blockCode = frame[2]! >> 4, rateCode = frame[2]! & 15;
    const channelCode = frame[3]! >> 4, bitsCode = frame[3]! >> 1 & 7;
    if (blockCode === 0 || rateCode === 15 || channelCode > 10 || bitsCode === 3) fail('PARSE_FAILED');
    let cursor = 4;
    const leading = frame[cursor++]!;
    let number = 0n;
    if (leading < 128) number = BigInt(leading);
    else {
      let width = 0; for (let mask = 128; leading & mask; mask >>= 1) ++width;
      if (width < 2 || width > 7 || cursor + width - 1 >= frame.length) fail('PARSE_FAILED');
      number = BigInt(leading & ((1 << (7 - width)) - 1));
      for (let index = 1; index < width; ++index) {
        const continuation = frame[cursor++]!;
        if ((continuation & 192) !== 128) fail('PARSE_FAILED');
        number = number * 64n + BigInt(continuation & 63);
      }
      const minimum = [0n,0n,128n,2048n,65536n,2097152n,67108864n,2147483648n][width]!;
      if (number < minimum) fail('PARSE_FAILED');
    }
    // 从完整文件起点读到的首frame必须是frame/sample编号0，不接受中段冒首帧。
    if (number !== 0n) fail('PARSE_FAILED');
    const extra = (bytes: 1 | 2): number => {
      if (cursor + bytes >= frame.length) fail('PARSE_FAILED');
      const n = bytes === 1 ? frame[cursor]! : frame[cursor]! * 256 + frame[cursor+1]!;
      cursor += bytes; return n;
    };
    const blockSamples = blockCode === 1 ? 192 : blockCode <= 5 ? 576 * 2 ** (blockCode - 2)
      : blockCode === 6 ? extra(1) + 1 : blockCode === 7 ? extra(2) + 1 : 256 * 2 ** (blockCode - 8);
    const packed = view(head).getBigUint64(18), infoRate = Number(packed >> 44n), infoChannels = Number(packed >> 41n & 7n) + 1, infoBits = Number(packed >> 36n & 31n) + 1;
    const fixedRates = [0,88200,176400,192000,8000,16000,22050,24000,32000,44100,48000,96000];
    const rate = rateCode === 0 ? infoRate : rateCode < 12 ? fixedRates[rateCode]!
      : rateCode === 12 ? extra(1) * 1000 : rateCode === 13 ? extra(2) : extra(2) * 10;
    const channels = channelCode < 8 ? channelCode + 1 : 2;
    const bits = bitsCode === 0 ? infoBits : [0,8,12,0,16,20,24,32][bitsCode]!;
    const maxBlock = view(head).getUint16(10), minFrameSize = head[12]! * 65536 + head[13]! * 256 + head[14]!;
    if (rate < 1 || rate !== infoRate || channels !== infoChannels || bits !== infoBits || blockSamples < 1 || maxBlock < 1 || blockSamples > maxBlock) fail('PARSE_FAILED');
    if (cursor >= frame.length) fail('PARSE_FAILED');
    let crc8 = 0;
    for (let index = 0; index < cursor; ++index) {
      crc8 ^= frame[index]!;
      for (let bit = 0; bit < 8; ++bit) crc8 = (crc8 & 128 ? crc8 << 1 ^ 7 : crc8 << 1) & 255;
    }
    if (crc8 !== frame[cursor]) fail('PARSE_FAILED');
    const headerBytes = cursor + 1;
    if (remaining < Math.max(minFrameSize,headerBytes + channels * 2 + 2)) fail('PARSE_FAILED');
  } else if (container === 'WAVE' || container === 'AIFF') {
    const little = container === 'WAVE', end = view(head).getUint32(4,little) + 8;
    if (end > input.size || end < 20) fail('PARSE_FAILED');
    let at = 12, chunks = 0, formatSeen = false, audioSeen = false;
    const waveDataSizes: number[] = [];
    while (at + 8 <= end) {
      if (++chunks > 4096) fail('BUDGET_EXCEEDED');
      const h = await readAt(at,8), id = textAt(h,0,4), size = view(h).getUint32(4,little);
      if (at + 8 + size > end) fail('PARSE_FAILED');
      if (little && id === 'fmt ') {
        if (wave) fail('PARSE_FAILED');
        wave = waveFormatFacts(await readAt(at + 8, Math.min(size, 40)), size); formatSeen = true;
      } else if (!little && id === 'COMM') formatSeen = size >= 18;
      if (id === (little ? 'data' : 'SSND')) audioSeen = size > (little ? 0 : 8);
      else if (size > budget.singleAllocationBytes) fail('BUDGET_EXCEEDED');
      if (little && id === 'data') waveDataSizes.push(size);
      if (little && id === 'LIST' && size === 0) waveEmptyListHeaders.add(at);
      at += 8 + size + size % 2;
    }
    if (!formatSeen || !audioSeen || at > end + 1) fail('PARSE_FAILED');
    if (wave && (wave.codec === 'PCM' || wave.codec === 'IEEE_FLOAT')) {
      const blockAlign = wave.blockAlign;
      if (waveDataSizes.some(size => size % blockAlign !== 0)) fail('PARSE_FAILED');
    }
  } else if (container === 'MP4') {
    let at = 0, atoms = 0, moov = false, media = false;
    while (at < input.size) {
      if (++atoms > 4096 || input.size - at < 8) fail('PARSE_FAILED');
      const h = await readAt(at,8), id = textAt(h,4,4); let size = view(h).getUint32(0), header = 8;
      if (size === 1) { const extended = view(await readAt(at + 8,8)).getBigUint64(0); if (extended > BigInt(Number.MAX_SAFE_INTEGER)) fail('PARSE_FAILED'); size = Number(extended); header = 16; }
      else if (size === 0) size = input.size - at;
      if (size < header || at + size > input.size) fail('PARSE_FAILED');
      if (id === 'moov') moov = true;
      if (id === 'mdat' && size > header) media = true;
      // mdat/free可随机跳过；尾部moov仍真实读取。嵌套atom分配继续受worker门禁。
      at += size;
    }
    if (!moov || !media) fail('PARSE_FAILED');
  } else if (container === 'OGG' || container === 'WAVPACK' || container === 'APE' || container === 'TTA' || container === 'MPC' || container === 'TAK') {
    if (container === 'OGG') { cue = await readOggHeaderFacts(readAt); tokenizer.fileInfo.mimeType = 'audio/ogg'; }
    else if (container === 'WAVPACK') { await checkWavpackHeader(readAt); tokenizer.fileInfo.mimeType = 'audio/wavpack'; }
    else if (container === 'APE') { cue = await readApeHeaderFacts(readAt); tokenizer.fileInfo.mimeType = 'audio/ape'; }
    else if (container === 'MPC') { cue = await readMusepackHeaderFacts(readAt); tokenizer.fileInfo.mimeType = 'audio/musepack'; }
    else {
      cue = container === 'TTA' ? await readTtaHeaderFacts(readAt) : await readTakHeaderFacts(readAt);
      // 固定 MM 没有这两个 Parser；只发布已核头声明，标签与封面保持未知。
      const technical: MetadataTechnical = { container, codec: cue.codec, lossless: cue.lossless, sampleRateHz: cue.sampleRateHz,
        channels: cue.channels, bitsPerSample: cue.bitsPerSample, durationSeconds: cue.durationSeconds, evidence: 'bounded-parser-reported' };
      checkTime(); phase = 'complete';
      return { status: 'ok', parserVersion: CUE_HEADER_METADATA_PARSER_VERSION, fields: {}, technical, coverEvidence: [], readEvidence: evidence() };
    }
  } else {
    let at = 0;
    if (ascii(0,3) === 'ID3') {
      if (head.length < 10 || [head[6],head[7],head[8],head[9]].some(n => n === undefined || n > 127)) fail('PARSE_FAILED');
      const size = head[6]! * 2097152 + head[7]! * 16384 + head[8]! * 128 + head[9]!;
      if (size > budget.singleAllocationBytes) fail('BUDGET_EXCEEDED');
      at = 10 + size + (head[3] === 4 && (head[5]! & 0x10) !== 0 ? 10 : 0);
    }
    const frame = await readAt(at,4), version = frame[1]! >> 3 & 3, layer = frame[1]! >> 1 & 3;
    const rateIndex = frame[2]! >> 2 & 3, bitIndex = frame[2]! >> 4;
    if (frame[0] !== 0xff || (frame[1]! & 0xe0) !== 0xe0 || version === 1 || layer !== 1 || rateIndex === 3 || bitIndex === 0 || bitIndex === 15) fail('PARSE_FAILED');
    const rates = [44100,48000,32000], high = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320];
    const low = [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160];
    const rate = rates[rateIndex]! / (version === 3 ? 1 : version === 2 ? 2 : 4), bitrate = (version === 3 ? high : low)[bitIndex]!;
    const size = Math.floor((version === 3 ? 144 : 72) * bitrate * 1000 / rate) + (frame[2]! >> 1 & 1);
    if (at + size > input.size) fail('PARSE_FAILED');
  }
  phase = 'parser-load'; checkTime();
  const parse = await loadMetadataParser();
  checkTime(); phase = 'parse';
  const metadata = await parse(tokenizer, { duration: false, skipCovers: false, includeChapters: false });
  checkTime();
  phase = 'output-check';
  // 整体原始文本与条目数也有限；输出只取六字段，不把未请求标签克隆给owner。
  let totalText = 0, entries = 0, coverTotal = 0;
  const inspect = (v: unknown, depth = 0): void => {
    checkTime(); if (++entries > 16_384 || depth > 16) fail('BUDGET_EXCEEDED');
    if (typeof v === 'string') { const size = Buffer.byteLength(v, 'utf8'); if (size > budget.textFieldBytes || totalText + size > budget.totalTextBytes) fail('BUDGET_EXCEEDED'); totalText += size; }
    else if (ArrayBuffer.isView(v)) { if (v.byteLength > budget.coverBytes) fail('BUDGET_EXCEEDED'); }
    else if (Array.isArray(v)) { for (const item of v) inspect(item, depth + 1); }
    else if (typeof v === 'object' && v !== null) { for (const item of Object.values(v)) inspect(item, depth + 1); }
  };
  inspect(metadata.native); inspect(metadata.common);
  const common = metadata.common, fields: MetadataRawFields = {};
  for (const key of ['title','artist','album'] as const) if (common[key] !== undefined) fields[key] = common[key];
  if (common.year !== undefined) fields.year = String(common.year);
  if (common.disk.no !== null) fields.disc = String(common.disk.no);
  if (common.track.no !== null) fields.track = String(common.track.no);
  for (const value of Object.values(fields)) if (Buffer.byteLength(value, 'utf8') > budget.textFieldBytes) fail('BUDGET_EXCEEDED');
  const format = metadata.format, codec = dsd ? dsd.codec : wave?.codec ?? cue?.codec
    ?? (container === 'WAVPACK' && (head[24]! & 0x80) ? 'IEEE_FLOAT' : format.codec);
  const sampleRateHz = cue?.sampleRateHz ?? format.sampleRate, channels = cue?.channels ?? format.numberOfChannels;
  if (cue && container !== 'MPC' && (format.numberOfChannels !== cue.channels
    || cue.codec !== 'Opus' && format.sampleRate !== cue.sampleRateHz)) fail('PARSE_FAILED');
  if (container === 'OGG' && format.codec !== (cue?.codec === 'Vorbis' ? 'Vorbis I' : cue?.codec)) fail('UNSUPPORTED');
  if (container === 'WAVPACK' && (format.codec !== 'PCM' || format.lossless !== ((head[24]! & 8) === 0))) fail('PARSE_FAILED');
  if (dsd && (format.sampleRate !== dsd.sampleRateHz || format.numberOfChannels !== dsd.channels)) fail('PARSE_FAILED');
  if (wave && (format.sampleRate !== wave.sampleRateHz || format.numberOfChannels !== wave.channels
    || format.bitsPerSample !== wave.bitsPerSample)) fail('PARSE_FAILED');
  if (!Number.isSafeInteger(sampleRateHz) || sampleRateHz! < 1 || sampleRateHz! > 1_000_000_000
    || !Number.isSafeInteger(channels) || channels! < 1 || channels! > 64
    || typeof codec !== 'string' || codec.length === 0 || Buffer.byteLength(codec,'utf8') > 256 || format.hasAudio === false) throw new ReaderFailure('PARSE_FAILED');
  if (container === 'MP4' && !/ALAC|AAC/iu.test(codec)) fail('UNSUPPORTED');
  const finite = (n: number | undefined): number | null => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER ? n : null;
  const technical: MetadataTechnical = { container, codec, sampleRateHz: sampleRateHz!, channels: channels!,
    lossless: dsd ? true : wave ? wave.lossless : cue ? cue.lossless : typeof format.lossless === 'boolean' ? format.lossless : null,
    bitsPerSample: dsd ? 1 : cue ? cue.bitsPerSample : finite(format.bitsPerSample),
    durationSeconds: dsd ? dsd.durationSeconds : cue?.durationSeconds ?? finite(format.duration), evidence: 'bounded-parser-reported' };
  const covers = common.picture ?? []; if (covers.length > 8) fail('BUDGET_EXCEEDED');
  const coverEvidence: MetadataCoverEvidence[] = [];
  for (const picture of covers) {
    checkTime(); const data = picture.data; coverTotal += data.byteLength;
    if (data.byteLength > budget.coverBytes || coverTotal > budget.coverBytes) fail('BUDGET_EXCEEDED');
    const png = data.length >= 8 && [137,80,78,71,13,10,26,10].every((n,i) => data[i] === n);
    const jpeg = data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    if (!png && !jpeg) continue;
    coverEvidence.push({ mime: png ? 'image/png' : 'image/jpeg', bytes: data.byteLength, sha256: createHash('sha256').update(data).digest('hex'), evidence: 'encoded-bytes-magic-and-digest' });
  }
  checkTime(); phase = 'complete'; return { status: 'ok', parserVersion: METADATA_PARSER_VERSION, fields, technical, coverEvidence, readEvidence: evidence() };
}
const publish = (result: MetadataReadResult): void => { parentPort!.postMessage({ kind: 'metadata-result', result, phase } satisfies MetadataWorkerResultMessage); };
try { publish(await run()); }
catch (error) { publish({ status: 'failure', code: error instanceof ReaderFailure ? error.code : 'PARSE_FAILED', readEvidence: evidence() }); }
finally { parentPort!.close(); }
