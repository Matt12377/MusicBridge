import { readSync } from 'node:fs';
import { readDsdContainerFacts, DsdContainerError, type DsdContainerFacts } from './dsd-container-facts.js';
import { createHash } from 'node:crypto';
import { loadMetadataEndOfStreamError, loadMetadataParser } from './metadata-reader-runtime.js';
import { parentPort, workerData } from 'node:worker_threads';
import type { parseFromTokenizer } from 'music-metadata';
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
  else if (ascii(0,3) === 'ID3' || head[0] === 0xff && (head[1]! & 0xe0) === 0xe0) container = 'MPEG';
  else return fail('UNSUPPORTED');
  const readAt = async (at: number, length: number): Promise<Uint8Array> => {
    const buffer = new Uint8Array(length); await tokenizer.peekBuffer(buffer,{position:at}); return buffer;
  };
  const textAt = (b: Uint8Array,at: number,length: number): string => String.fromCharCode(...b.subarray(at,at+length));
  const view = (b: Uint8Array): DataView => new DataView(b.buffer,b.byteOffset,b.byteLength);
  // 先检查容器边界与存在的音频载荷，再进入Parser；magic/扩展名本身不能构成成功。
  let dsd: DsdContainerFacts | undefined;
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
    while (at + 8 <= end) {
      if (++chunks > 4096) fail('BUDGET_EXCEEDED');
      const h = await readAt(at,8), id = textAt(h,0,4), size = view(h).getUint32(4,little);
      if (at + 8 + size > end) fail('PARSE_FAILED');
      if (id === (little ? 'fmt ' : 'COMM')) formatSeen = size >= (little ? 16 : 18);
      if (id === (little ? 'data' : 'SSND')) audioSeen = size > (little ? 0 : 8);
      else if (size > budget.singleAllocationBytes) fail('BUDGET_EXCEEDED');
      if (little && id === 'LIST' && size === 0) waveEmptyListHeaders.add(at);
      at += 8 + size + size % 2;
    }
    if (!formatSeen || !audioSeen || at > end + 1) fail('PARSE_FAILED');
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
  const format = metadata.format, codec = dsd ? dsd.codec : format.codec;
  if (dsd && (format.sampleRate !== dsd.sampleRateHz || format.numberOfChannels !== dsd.channels)) fail('PARSE_FAILED');
  if (!Number.isSafeInteger(format.sampleRate) || format.sampleRate! < 1 || format.sampleRate! > 1_000_000_000
    || !Number.isSafeInteger(format.numberOfChannels) || format.numberOfChannels! < 1 || format.numberOfChannels! > 64
    || typeof codec !== 'string' || codec.length === 0 || Buffer.byteLength(codec,'utf8') > 256 || format.hasAudio === false) throw new ReaderFailure('PARSE_FAILED');
  if (container === 'MP4' && !/ALAC|AAC/iu.test(codec)) fail('UNSUPPORTED');
  const finite = (n: number | undefined): number | null => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER ? n : null;
  const technical: MetadataTechnical = { container, codec, sampleRateHz: format.sampleRate!, channels: format.numberOfChannels!,
    lossless: dsd ? true : typeof format.lossless === 'boolean' ? format.lossless : null,
    bitsPerSample: dsd ? 1 : finite(format.bitsPerSample), durationSeconds: dsd ? dsd.durationSeconds : finite(format.duration), evidence: 'bounded-parser-reported' };
  const covers = common.picture ?? []; if (covers.length > 8) fail('BUDGET_EXCEEDED');
  const coverEvidence: MetadataCoverEvidence[] = [];
  for (const picture of covers) {
    checkTime(); const data = picture.data; coverTotal += data.byteLength;
    if (data.byteLength > budget.coverBytes || coverTotal > budget.coverBytes) fail('BUDGET_EXCEEDED');
    const png = data.length >= 8 && [137,80,78,71,13,10,26,10].every((n,i) => data[i] === n);
    const jpeg = data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    if (!png && !jpeg) fail('UNSUPPORTED');
    coverEvidence.push({ mime: png ? 'image/png' : 'image/jpeg', bytes: data.byteLength, sha256: createHash('sha256').update(data).digest('hex'), evidence: 'encoded-bytes-magic-and-digest' });
  }
  checkTime(); phase = 'complete'; return { status: 'ok', parserVersion: 'music-metadata-11.15.0/mbrs003-v2', fields, technical, coverEvidence, readEvidence: evidence() };
}
const publish = (result: MetadataReadResult): void => { parentPort!.postMessage({ kind: 'metadata-result', result, phase } satisfies MetadataWorkerResultMessage); };
try { publish(await run()); }
catch (error) { publish({ status: 'failure', code: error instanceof ReaderFailure ? error.code : 'PARSE_FAILED', readEvidence: evidence() }); }
finally { parentPort!.close(); }
