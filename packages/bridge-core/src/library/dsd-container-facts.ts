/** DSF/DSDIFF 的有界只读容器准入；只捕获头与边界，不读整曲音频或接管 FD。 */
export interface DsdContainerFacts {
  container: 'DSF' | 'DFF'; codec: 'DSD'; sampleRateHz: number; bitsPerSample: 1;
  channels: number; durationSeconds: number; oneBitSamples: number; dataOffset: number; dataBytes: number;
  bitOrder: 'lsbf-planar' | 'msbf-planar' | 'msbf-interleaved';
  /** 仅元数据token适配使用，原头与pad已实际验界；不改变源长度或音频样本数。 */
  paddedChunkHeaders?: readonly { at: number; payloadBytes: number }[];
}
export class DsdContainerError extends Error {
  constructor(readonly code: 'UNSUPPORTED' | 'PARSE_FAILED' | 'BUDGET_EXCEEDED') { super('DSD 容器当前无法准入。'); }
}
const clocks = new Set([2_822_400,3_072_000,5_644_800,6_144_000,11_289_600,12_288_000,22_579_200,24_576_000]);
function fail(code: DsdContainerError['code'] = 'PARSE_FAILED'): never { throw new DsdContainerError(code); }
const text = (b: Uint8Array, at: number, n: number): string => String.fromCharCode(...b.subarray(at,at+n));
const view = (b: Uint8Array): DataView => new DataView(b.buffer,b.byteOffset,b.byteLength);
const safe = (n: bigint): number => n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : fail();
const qualify = (rate: number, channels: number): void => {
  if (!clocks.has(rate) || !Number.isSafeInteger(channels) || channels < 1 || channels > 6) fail('UNSUPPORTED');
};

/** readAt 必须保留来源 current/readonly claim 及调用方的时间、I/O、分配预算。 */
export async function readDsdContainerFacts(size: number,
  readAt: (position: number, length: number) => Promise<Uint8Array>): Promise<DsdContainerFacts> {
  if (!Number.isSafeInteger(size) || size < 16) fail();
  let calls = 0;
  const read = async (at: number, n: number): Promise<Uint8Array> => {
    if (++calls > 4_096) fail('BUDGET_EXCEEDED');
    if (!Number.isSafeInteger(at) || !Number.isSafeInteger(n) || at < 0 || n < 1 || n > 1_024 || at > size - n) fail();
    const b = await readAt(at,n);
    if (b.length !== n) fail();
    return b;
  };
  const first = await read(0,16);
  if (text(first,0,4) === 'DSD ') {
    if (size < 92) fail();
    const h = await read(0,92), v = view(h);
    if (v.getBigUint64(4,true) !== 28n || safe(v.getBigUint64(12,true)) !== size
      || text(h,28,4) !== 'fmt ' || v.getBigUint64(32,true) !== 52n) fail();
    if (v.getUint32(40,true) !== 1 || v.getUint32(44,true) !== 0) fail('UNSUPPORTED');
    const type = v.getUint32(48,true), channels = v.getUint32(52,true), rate = v.getUint32(56,true);
    qualify(rate,channels);
    const layoutChannels = [0,1,2,3,4,4,5,6][type];
    if (layoutChannels === undefined || layoutChannels === 0) fail('UNSUPPORTED');
    if (layoutChannels !== channels) fail();
    const packing = v.getUint32(60,true), samples = safe(v.getBigUint64(64,true));
    if (packing !== 1 && packing !== 8) fail('UNSUPPORTED');
    if (samples < 8 || samples % 8 !== 0) fail('UNSUPPORTED');
    const block = v.getUint32(72,true);
    if (block !== 4_096 || v.getUint32(76,true) !== 0 || text(h,80,4) !== 'data') fail();
    const dataBytes = safe(v.getBigUint64(84,true)) - 12;
    const expectedBytes = Math.ceil(samples / 8 / block) * block * channels;
    if (!Number.isSafeInteger(expectedBytes) || dataBytes !== expectedBytes || dataBytes > size - 92) fail();
    const dataEnd = 92 + dataBytes, metadata = safe(v.getBigUint64(20,true));
    if (metadata === 0) { if (dataEnd !== size) fail(); }
    else {
      if (metadata !== dataEnd || size - metadata < 10) fail();
      const id3 = await read(metadata,10);
      if (text(id3,0,3) !== 'ID3' || ![2,3,4].includes(id3[3]!) || id3[4] === 255
        || [id3[6],id3[7],id3[8],id3[9]].some(n => n === undefined || n > 127)) fail();
      const tagBytes = id3[6]! * 2_097_152 + id3[7]! * 16_384 + id3[8]! * 128 + id3[9]!;
      const footer = id3[3] === 4 && (id3[5]! & 0x10) !== 0 ? 10 : 0;
      if (metadata + 10 + tagBytes + footer !== size) fail();
    }
    return {container:'DSF',codec:'DSD',sampleRateHz:rate,bitsPerSample:1,channels,
      durationSeconds:samples/rate,oneBitSamples:samples,dataOffset:92,dataBytes,
      bitOrder:packing === 1 ? 'lsbf-planar':'msbf-planar'};
  }
  if (text(first,0,4) !== 'FRM8' || text(first,12,4) !== 'DSD ') fail('UNSUPPORTED');
  if (safe(view(first).getBigUint64(4)) !== size - 12) fail();
  let chunks = 0, version = false, properties = false, rate: number | undefined, channels: number | undefined;
  let compression = false, dataOffset: number | undefined, dataBytes: number | undefined;
  const paddedChunkHeaders: {at:number;payloadBytes:number}[] = [];
  const chunk = async (at: number, end: number) => {
    if (++chunks > 2_048) fail('BUDGET_EXCEEDED');
    if (end - at < 12) fail();
    const h = await read(at,12), n = safe(view(h).getBigUint64(4));
    if (n > end - at - 12 || n % 2 > end - at - 12 - n) fail();
    if (n % 2) paddedChunkHeaders.push({at,payloadBytes:n});
    return {id:text(h,0,4),n,payload:at+12,next:at+12+n+n%2};
  };
  let at = 16;
  while (at < size) {
    const c = await chunk(at,size);
    if (!version && (at !== 16 || c.id !== 'FVER')) fail();
    if (c.id === 'FVER') {
      if (version || c.n !== 4) fail();
      const v = await read(c.payload,4);
      if (v[0] !== 1 || v[2] !== 0 || v[3] !== 0) fail('UNSUPPORTED');
      version = true;
    } else if (c.id === 'PROP') {
      if (properties || dataOffset !== undefined || c.n < 4 || text(await read(c.payload,4),0,4) !== 'SND ') fail();
      properties = true;
      let p = c.payload + 4;
      while (p < c.payload + c.n) {
        const s = await chunk(p,c.payload+c.n);
        if (s.id === 'FS  ') {
          if (rate !== undefined || s.n !== 4) fail();
          rate = view(await read(s.payload,4)).getUint32(0);
        } else if (s.id === 'CHNL') {
          if (channels !== undefined || s.n < 2) fail();
          channels = view(await read(s.payload,2)).getUint16(0);
          if (channels < 1 || channels > 6) fail('UNSUPPORTED');
          if (s.n !== 2 + channels * 4) fail();
          const ids = await read(s.payload+2,channels*4), seen = new Set<string>();
          for (let i = 0; i < channels; ++i) {
            const id = text(ids,i*4,4);
            if (!/^[\x20-\x7e]{4}$/u.test(id) || seen.has(id)) fail();
            seen.add(id);
          }
        } else if (s.id === 'CMPR') {
          if (compression || s.n < 5 || s.n > 260) fail();
          const v = await read(s.payload,s.n);
          if (text(v,0,4) !== 'DSD ') fail('UNSUPPORTED');
          if (s.n !== 5 + v[4]!) fail();
          compression = true;
        }
        p = s.next;
      }
      if (p !== c.payload+c.n || rate === undefined || channels === undefined || !compression) fail();
      qualify(rate,channels);
    } else if (c.id === 'DSD ') {
      if (!properties || dataOffset !== undefined || c.n < 1) fail();
      dataOffset = c.payload; dataBytes = c.n;
    } else if (c.id === 'DST ' || c.id === 'DSTI') fail('UNSUPPORTED');
    at = c.next;
  }
  if (at !== size || !version || !properties || rate === undefined || channels === undefined
    || dataOffset === undefined || dataBytes === undefined || dataBytes % channels !== 0) fail();
  const samples = dataBytes * 8 / channels;
  if (!Number.isSafeInteger(samples) || samples < 8) fail();
  return {container:'DFF',codec:'DSD',sampleRateHz:rate,bitsPerSample:1,channels,
    durationSeconds:samples/rate,oneBitSamples:samples,dataOffset,dataBytes,bitOrder:'msbf-interleaved',paddedChunkHeaders};
}
