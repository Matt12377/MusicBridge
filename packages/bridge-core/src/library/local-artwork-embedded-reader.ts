import type { FileHandle } from 'node:fs/promises';

const CHUNK_BYTES = 64 * 1024;
const TOTAL_READ_BYTES = 12 * 1024 * 1024;
const IMAGE_BYTES = 4 * 1024 * 1024;
const TOTAL_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_COUNT = 3;
const HEADER_COUNT = 4096;
const MIME_BYTES = 255;
const DESCRIPTION_BYTES = 4096;
const DEADLINE_MS = 3000;
type EmbeddedArtwork = { bytes: Uint8Array; pictureIndex: number };
type Failure = 'INVALID' | 'LIMIT' | 'UNSUPPORTED' | 'CANCELLED' | 'TIMEOUT';

function fail(code: Failure, message: string): never {
  throw Object.assign(new Error(message), { code: `ARTWORK_EMBEDDED_${code}` });
}

/** FD 的许可、身份和生命周期由调用者持有；这里仅限制位置、字节量和解析期限。 */
class BoundedReader {
  private readonly deadline = performance.now() + DEADLINE_MS;
  private totalRead = 0;
  constructor(private readonly handle: FileHandle, readonly size: number, private readonly signal: AbortSignal) {}
  check(): void {
    if (this.signal.aborted) fail('CANCELLED', '内嵌封面读取已取消');
    if (performance.now() >= this.deadline) fail('TIMEOUT', '内嵌封面读取超过期限');
  }
  end(position: number, length: number, containerEnd = this.size): number {
    this.check();
    if (!Number.isSafeInteger(position) || !Number.isSafeInteger(length) || position < 0 || length < 0
      || containerEnd > this.size || position > containerEnd || length > containerEnd - position) {
      fail('INVALID', '内嵌封面声明范围超出文件或元数据边界');
    }
    return position + length;
  }
  async read(position: number, length: number, containerEnd = this.size): Promise<Buffer> {
    this.end(position, length, containerEnd);
    if (length > IMAGE_BYTES) fail('LIMIT', '内嵌封面单次分配超过预算');
    const bytes = Buffer.allocUnsafe(length);
    for (let offset = 0; offset < length;) {
      this.check();
      const count = Math.min(CHUNK_BYTES, length - offset);
      if (this.totalRead + count > TOTAL_READ_BYTES) fail('LIMIT', '内嵌封面累计读取超过预算');
      let bytesRead: number;
      try { ({ bytesRead } = await this.handle.read(bytes, offset, count, position + offset)); }
      finally { this.check(); }
      if (!Number.isInteger(bytesRead!) || bytesRead! <= 0 || bytesRead! > count) fail('INVALID', '内嵌封面读取遇到截断或无效字节数');
      this.totalRead += bytesRead!;
      offset += bytesRead!;
    }
    return bytes;
  }
}

function mimeType(bytes: Buffer): void {
  if (bytes.length === 0 || bytes.some(byte => byte < 0x20 || byte > 0x7e)) fail('INVALID', '内嵌封面 MIME 字段无效');
  const mime = bytes.toString('ascii').toLowerCase();
  // 不跟随 URL 型图片；这里只认图片声明，实际格式与完整解码仍由 Main 核实。
  if (mime !== 'image/png' && mime !== 'image/jpeg') fail('UNSUPPORTED', '内嵌封面 MIME 或外部链接类型暂不支持');
}

class Pictures {
  readonly items: EmbeddedArtwork[] = [];
  private totalBytes = 0;
  reserve(length: number): void {
    if (length <= 0) fail('INVALID', '内嵌封面图片内容为空');
    if (this.items.length >= IMAGE_COUNT || length > IMAGE_BYTES || this.totalBytes + length > TOTAL_IMAGE_BYTES) {
      fail('LIMIT', '内嵌封面数量或图片字节量超过预算');
    }
    this.totalBytes += length;
  }
  add(bytes: Uint8Array): void { this.items.push(Object.freeze({ bytes, pictureIndex: this.items.length })); }
}

async function flacPicture(reader: BoundedReader, start: number, end: number, pictures: Pictures): Promise<void> {
  const prefix = await reader.read(start, 8, end);
  if (prefix.readUInt32BE(0) > 20) fail('INVALID', 'FLAC 图片用途字段无效');
  const mimeLength = prefix.readUInt32BE(4);
  if (mimeLength > MIME_BYTES) fail('LIMIT', 'FLAC 图片 MIME 字段超过预算');
  let position = start + 8;
  mimeType(await reader.read(position, mimeLength, end));
  position += mimeLength;
  const descriptionLength = (await reader.read(position, 4, end)).readUInt32BE(0);
  if (descriptionLength > DESCRIPTION_BYTES) fail('LIMIT', 'FLAC 图片说明字段超过预算');
  position = reader.end(position + 4, descriptionLength, end);
  // 宽高、位深和调色板数仅按结构跳过，不作为真实图像或音质证据。
  const fields = await reader.read(position, 20, end);
  const length = fields.readUInt32BE(16);
  position += 20;
  if (reader.end(position, length, end) !== end) fail('INVALID', 'FLAC 图片长度与块边界不一致');
  pictures.reserve(length);
  pictures.add(await reader.read(position, length, end));
}

async function readFlac(reader: BoundedReader, pictures: Pictures): Promise<void> {
  let position = 4;
  for (let count = 0; ; count++) {
    if (count >= HEADER_COUNT) fail('LIMIT', 'FLAC 元数据块数量超过预算');
    const header = await reader.read(position, 4);
    const type = header[0]! & 0x7f, last = (header[0]! & 0x80) !== 0;
    const length = header.readUIntBE(1, 3);
    position += 4;
    const end = reader.end(position, length);
    if (type === 127 || count === 0 && (type !== 0 || length !== 34) || count > 0 && type === 0) {
      fail('INVALID', 'FLAC 元数据块顺序或类型无效');
    }
    if (type === 6) await flacPicture(reader, position, end, pictures);
    // 非图片块只跳过声明范围；最后一个元数据块之后不读取音频帧。
    position = end;
    if (last) return;
  }
}

function synchsafe(bytes: Buffer, start: number): number {
  const values = [bytes[start]!, bytes[start + 1]!, bytes[start + 2]!, bytes[start + 3]!];
  if (values.some(byte => (byte & 0x80) !== 0)) fail('INVALID', 'ID3 同步安全长度字段无效');
  return values.reduce((value, byte) => value * 128 + byte, 0);
}

async function apic(reader: BoundedReader, start: number, end: number, version: number, pictures: Pictures): Promise<void> {
  // 只分配有界字段前缀，避免按 frame 的恶意长度一次分配。
  const prefix = await reader.read(start, Math.min(end - start, 1 + MIME_BYTES + 1 + 1 + DESCRIPTION_BYTES + 2), end);
  const encoding = prefix[0];
  if (encoding === undefined || encoding > (version === 3 ? 1 : 3)) fail('UNSUPPORTED', 'APIC 文字编码暂不支持');
  const mimeEnd = prefix.indexOf(0, 1);
  if (mimeEnd < 0 || mimeEnd - 1 > MIME_BYTES) fail('LIMIT', 'APIC 图片 MIME 缺少有界终止符');
  mimeType(prefix.subarray(1, mimeEnd));
  if (mimeEnd + 1 >= prefix.length || prefix[mimeEnd + 1]! > 20) fail('INVALID', 'APIC 图片用途字段无效');
  const descriptionStart = mimeEnd + 2, unit = encoding === 1 || encoding === 2 ? 2 : 1;
  let position = descriptionStart, terminator = -1;
  if (encoding === 1) {
    if (position + 2 > prefix.length) fail('INVALID', 'APIC UTF-16 说明字段截断');
    const first = prefix.readUInt16BE(position);
    if (first !== 0 && first !== 0xfeff && first !== 0xfffe) fail('INVALID', 'APIC UTF-16 说明缺少字节序标记');
  }
  for (; position - descriptionStart <= DESCRIPTION_BYTES && position + unit <= prefix.length; position += unit) {
    if (prefix[position] === 0 && (unit === 1 || prefix[position + 1] === 0)) { terminator = position; break; }
  }
  if (terminator < 0) fail('LIMIT', 'APIC 图片说明缺少有界终止符');
  const imageStart = start + terminator + unit, length = end - imageStart;
  pictures.reserve(length);
  pictures.add(await reader.read(imageStart, length, end));
}

async function readId3(reader: BoundedReader, magic: Buffer, pictures: Pictures, start = 0, containerEnd = reader.size): Promise<number> {
  // 其他 ID3 主版本属于未支持格式，不尝试借用 v2.3/v2.4 的 frame 布局。
  if (magic.length === 4 && magic[3] !== 3 && magic[3] !== 4) fail('UNSUPPORTED', 'ID3 主版本暂不支持');
  const tail = await reader.read(start + 4, 6, containerEnd), header = Buffer.concat([magic, tail]);
  const version = header[3]!;
  if ((version !== 3 && version !== 4) || header[4] !== 0 || header[5] !== 0) {
    fail('UNSUPPORTED', 'ID3 修订、扩展头、非同步或其他标签标记暂不支持');
  }
  const end = reader.end(start + 10, synchsafe(header, 6), containerEnd);
  let position = start + 10;
  for (let count = 0; position < end; count++) {
    if (count >= HEADER_COUNT) fail('LIMIT', 'ID3 frame 数量超过预算');
    const header = await reader.read(position, Math.min(10, end - position), end);
    if (header.every(byte => byte === 0)) return end; // padding 起点，不延伸到标签后的音频。
    if (header.length !== 10 || !/^[A-Z0-9]{4}$/u.test(header.toString('latin1', 0, 4))) fail('INVALID', 'ID3 frame 头无效或截断');
    if (header[8] !== 0 || header[9] !== 0) fail('UNSUPPORTED', 'ID3 frame 压缩、加密、非同步或其他标记暂不支持');
    const length = version === 4 ? synchsafe(header, 4) : header.readUInt32BE(4);
    if (length === 0) fail('INVALID', 'ID3 frame 内容为空');
    position += 10;
    const frameEnd = reader.end(position, length, end);
    if (header.toString('latin1', 0, 4) === 'APIC') await apic(reader, position, frameEnd, version, pictures);
    position = frameEnd;
  }
  return end;
}

async function readWave(reader: BoundedReader, pictures: Pictures): Promise<void> {
  const header = await reader.read(0, 12);
  if (header.toString('latin1', 8, 12) !== 'WAVE') fail('UNSUPPORTED', 'RIFF 类型暂不支持内嵌封面读取');
  const end = reader.end(8, header.readUInt32LE(4));
  if (end !== reader.size || end < 12) fail('INVALID', 'RIFF 声明长度与文件边界不一致');
  let position = 12, format = false, data = false;
  for (let count = 0; position < end; count++) {
    if (count >= HEADER_COUNT) fail('LIMIT', 'WAVE 元数据 chunk 数量超过预算');
    const chunk = await reader.read(position, 8, end), type = chunk.toString('latin1', 0, 4), length = chunk.readUInt32LE(4);
    const start = position + 8, chunkEnd = reader.end(start, length, end);
    position = reader.end(chunkEnd, length & 1, end);
    if (type === 'fmt ') {
      if (format) fail('INVALID', 'WAVE 格式 chunk 重复');
      const fields = await reader.read(start, 16, chunkEnd);
      if (!fields.readUInt16LE(0) || !fields.readUInt16LE(2) || !fields.readUInt32LE(4)
        || !fields.readUInt32LE(8) || !fields.readUInt16LE(12)) fail('INVALID', 'WAVE 基本格式字段无效');
      if (length !== 16) {
        const extra = (await reader.read(start + 16, 2, chunkEnd)).readUInt16LE();
        if (reader.end(start + 18, extra, chunkEnd) !== chunkEnd) fail('INVALID', 'WAVE 扩展格式长度无效');
      }
      format = true;
    } else if (type === 'data') data = true; // 只跨过已验证的范围，不读取音频。
    else if (type.toLowerCase() === 'id3 ') {
      const magic = await reader.read(start, Math.min(4, length), chunkEnd);
      if (magic.toString('latin1', 0, 3) !== 'ID3') fail('INVALID', 'WAVE 内嵌 ID3 头无效');
      if (await readId3(reader, magic, pictures, start, chunkEnd) !== chunkEnd) fail('INVALID', 'WAVE 内嵌 ID3 长度与 chunk 不一致');
    } else if (type === 'DISP') fail('UNSUPPORTED', 'WAVE 显示图片 chunk 暂不支持');
  }
  if (!format || !data) fail('INVALID', 'WAVE 缺少完整格式或数据 chunk');
}

type Mp4Atom = { type: string; start: number; end: number };
async function readMp4(reader: BoundedReader, pictures: Pictures): Promise<void> {
  let count = 0, movie = false;
  async function atom(position: number, end: number): Promise<Mp4Atom> {
    if (++count > HEADER_COUNT) fail('LIMIT', 'MP4 元数据 atom 数量超过预算');
    const header = await reader.read(position, 8, end);
    let length = header.readUInt32BE(0), start = position + 8;
    if (length === 1) {
      const extended = (await reader.read(start, 8, end)).readBigUInt64BE();
      if (extended > BigInt(Number.MAX_SAFE_INTEGER)) fail('INVALID', 'MP4 atom 长度超出安全范围');
      length = Number(extended); start += 8;
    } else if (length === 0) length = end - position;
    if (length < start - position) fail('INVALID', 'MP4 atom 长度小于其头部');
    return { type: header.toString('latin1', 4, 8), start, end: reader.end(position, length, end) };
  }
  // 仅沿标准图片元数据路径下行；mdat、采样表和未知载荷都不读取。
  async function walk(start: number, end: number, parent: string): Promise<void> {
    for (let position = start; position < end;) {
      const box = await atom(position, end);
      if (parent === 'file' && box.type === 'ftyp') {
        if (position !== 0 || box.end - box.start < 8 || (box.end - box.start) % 4 !== 0) fail('INVALID', 'MP4 文件类型 atom 无效');
      } else if (parent === 'file' && box.type === 'moov') {
        if (movie) fail('UNSUPPORTED', '多个 MP4 movie 元数据暂不支持');
        movie = true; await walk(box.start, box.end, 'moov');
      } else if (parent === 'moov' && box.type === 'trak'
        || (parent === 'moov' || parent === 'trak') && box.type === 'udta') {
        await walk(box.start, box.end, box.type);
      } else if ((parent === 'moov' || parent === 'trak' || parent === 'udta') && box.type === 'meta') {
        if ((await reader.read(box.start, 4, box.end)).readUInt32BE() !== 0) fail('UNSUPPORTED', 'MP4 meta 版本或标记暂不支持');
        await walk(box.start + 4, box.end, 'meta');
      } else if (parent === 'meta' && box.type === 'hdlr') {
        const handler = await reader.read(box.start, 12, box.end);
        if (handler.readUInt32BE() !== 0 || handler.toString('latin1', 8, 12) !== 'mdir') fail('UNSUPPORTED', 'MP4 元数据处理器暂不支持');
      } else if (parent === 'meta' && box.type === 'keys') {
        fail('UNSUPPORTED', 'MP4 索引元数据暂不支持');
      } else if (parent === 'meta' && box.type === 'ilst' || parent === 'ilst' && box.type === 'covr') {
        if (box.type === 'covr' && box.start === box.end) fail('INVALID', 'MP4 图片 atom 内容为空');
        await walk(box.start, box.end, box.type);
      } else if (parent === 'covr') {
        if (box.type !== 'data') fail('UNSUPPORTED', 'MP4 图片子 atom 暂不支持');
        const fields = await reader.read(box.start, 8, box.end), type = fields.readUInt32BE(0);
        if (type !== 13 && type !== 14) fail('UNSUPPORTED', 'MP4 图片编码暂不支持');
        const length = box.end - box.start - 8; pictures.reserve(length);
        pictures.add(await reader.read(box.start + 8, length, box.end));
      } else if (box.type === 'meta' || box.type === 'ilst' || box.type === 'covr') {
        fail('UNSUPPORTED', 'MP4 图片元数据层级暂不支持');
      }
      position = box.end;
    }
  }
  await walk(0, reader.size, 'file');
  if (!movie) fail('INVALID', 'MP4 缺少完整 movie 元数据');
}

type OggSpan = { position: number; offset: number; length: number };
/** packet 仅保存每页的文件范围；不合并整包，也不把后续音频读进内存。 */
class OggPacket {
  constructor(private readonly reader: BoundedReader, private readonly spans: OggSpan[], readonly size: number) {}
  end(position: number, length: number): number { return this.reader.end(position, length, this.size); }
  async read(position: number, length: number): Promise<Buffer> {
    this.end(position, length);
    if (length > IMAGE_BYTES) fail('LIMIT', 'Ogg 元数据单次分配超过预算');
    const result = Buffer.allocUnsafe(length);
    let written = 0;
    for (const span of this.spans) {
      this.reader.check();
      if (position >= span.offset + span.length) continue;
      const relative = position - span.offset, count = Math.min(length - written, span.length - relative);
      const bytes = await this.reader.read(span.position + relative, count);
      bytes.copy(result, written); position += count; written += count;
      if (written === length) return result;
    }
    if (written !== length) fail('INVALID', 'Ogg packet 文件范围不完整');
    return result;
  }
}

class OggPackets {
  private position = 0;
  private body = 0;
  private laces: Buffer = Buffer.alloc(0);
  private index = 0;
  private pages = 0;
  private serial: number | undefined;
  private sequence = 0;
  private last = false;
  constructor(private readonly reader: BoundedReader) {}
  private async page(continued: boolean): Promise<void> {
    if (this.last) fail('INVALID', 'Ogg 在元数据完成前已结束');
    if (++this.pages > HEADER_COUNT) fail('LIMIT', 'Ogg 元数据页数超过预算');
    const header = await this.reader.read(this.position, 27), flags = header[5]!;
    if (header.toString('latin1', 0, 4) !== 'OggS' || header[4] !== 0 || (flags & ~7) !== 0
      || Boolean(flags & 1) !== continued || Boolean(flags & 2) !== (this.pages === 1)) fail('INVALID', 'Ogg 页头或 continuation 无效');
    const serial = header.readUInt32LE(14), sequence = header.readUInt32LE(18);
    if (this.serial !== undefined && serial !== this.serial || sequence !== this.sequence) fail('INVALID', 'Ogg 元数据流身份或页序号改变');
    this.serial = serial; this.sequence = (sequence + 1) >>> 0; this.last = Boolean(flags & 4);
    this.laces = await this.reader.read(this.position + 27, header[26]!);
    this.body = this.position + 27 + this.laces.length;
    this.position = this.reader.end(this.body, this.laces.reduce((total, length) => total + length, 0));
    this.index = 0;
  }
  async packet(limit: number): Promise<OggPacket> {
    const spans: OggSpan[] = []; let length = 0;
    for (;;) {
      if (this.index === this.laces.length) { await this.page(length > 0); if (!this.laces.length) continue; }
      const start = this.body, offset = length;
      let complete = false;
      while (this.index < this.laces.length) {
        const next = this.laces[this.index++]!; this.body += next; length += next;
        if (length > limit) fail('LIMIT', 'Ogg 元数据 packet 超过预算');
        if (next < 255) { complete = true; break; }
      }
      if (length > offset) spans.push({ position: start, offset, length: length - offset });
      if (complete) return new OggPacket(this.reader, spans, length);
    }
  }
  async finishSingleStream(): Promise<void> {
    // 注释之后仅核页头和分段表；音频载荷按已验证范围跳过，不能漏掉后置多流。
    let continued = this.laces.length > 0 && this.laces[this.laces.length - 1] === 255;
    while (this.position < this.reader.size) {
      if (this.last) fail('UNSUPPORTED', 'Ogg 链式逻辑流暂不支持内嵌封面读取');
      await this.page(continued);
      if (this.laces.length) continued = this.laces[this.laces.length - 1] === 255;
    }
    if (continued) fail('INVALID', 'Ogg 尾部 packet 未完整结束');
  }
}

/** 每次只解码有界 base64 片段，图片长度声明在读取整图前检查。 */
class OggPictureBytes {
  private offset = 0;
  private pending: Buffer = Buffer.alloc(0);
  constructor(private readonly packet: OggPacket, private readonly start: number, private readonly length: number) {
    if (!length || length % 4 !== 0) fail('INVALID', 'Ogg 图片 base64 长度无效');
    if (length > Math.ceil((IMAGE_BYTES + 32 + MIME_BYTES + DESCRIPTION_BYTES) / 3) * 4) fail('LIMIT', 'Ogg 图片编码长度超过预算');
  }
  async read(length: number): Promise<Buffer> {
    if (length > IMAGE_BYTES) fail('LIMIT', 'Ogg 图片分配超过预算');
    const result = Buffer.allocUnsafe(length);
    for (let written = 0; written < length;) {
      if (!this.pending.length) {
        const count = Math.min(CHUNK_BYTES, Math.ceil((length - written) / 3) * 4, this.length - this.offset);
        if (!count) fail('INVALID', 'Ogg 图片数据被截断');
        const text = (await this.packet.read(this.start + this.offset, count)).toString('latin1');
        this.pending = Buffer.from(text, 'base64'); this.offset += count;
        if (this.pending.toString('base64') !== text || this.offset < this.length && text.includes('=')) fail('INVALID', 'Ogg 图片 base64 编码无效');
      }
      const count = Math.min(this.pending.length, length - written);
      this.pending.copy(result, written, 0, count); this.pending = this.pending.subarray(count); written += count;
    }
    return result;
  }
  finish(): void {
    if (this.offset !== this.length || this.pending.length) fail('INVALID', 'Ogg 图片长度与注释边界不一致');
  }
}

async function oggPicture(packet: OggPacket, start: number, length: number, pictures: Pictures): Promise<void> {
  const bytes = new OggPictureBytes(packet, start, length), prefix = await bytes.read(8);
  if (prefix.readUInt32BE(0) > 20) fail('INVALID', 'Ogg 图片用途字段无效');
  const mimeLength = prefix.readUInt32BE(4);
  if (mimeLength > MIME_BYTES) fail('LIMIT', 'Ogg 图片 MIME 字段超过预算');
  mimeType(await bytes.read(mimeLength));
  const descriptionLength = (await bytes.read(4)).readUInt32BE();
  if (descriptionLength > DESCRIPTION_BYTES) fail('LIMIT', 'Ogg 图片说明字段超过预算');
  await bytes.read(descriptionLength);
  const fields = await bytes.read(20), imageLength = fields.readUInt32BE(16);
  pictures.reserve(imageLength);
  const image = await bytes.read(imageLength); bytes.finish(); pictures.add(image);
}

async function readOgg(reader: BoundedReader, pictures: Pictures): Promise<void> {
  const packets = new OggPackets(reader), identification = await packets.packet(512);
  const first = await identification.read(0, identification.size);
  const vorbis = first.length >= 7 && first[0] === 1 && first.toString('latin1', 1, 7) === 'vorbis';
  const opus = first.length >= 8 && first.toString('latin1', 0, 8) === 'OpusHead';
  if (vorbis) {
    if (first.length !== 30 || first.readUInt32LE(7) !== 0 || !first[11] || !first.readUInt32LE(12)
      || first[29] !== 1 || (first[28]! & 15) < 6 || (first[28]! >> 4) > 13 || (first[28]! & 15) > (first[28]! >> 4)) fail('INVALID', 'Vorbis 标识头无效');
  } else if (opus) {
    if (first.length < 19 || first[8]! > 15) fail('UNSUPPORTED', 'Opus 标识版本暂不支持');
    if (!first[9] || (first[18] === 0 ? first.length !== 19 || first[9]! > 2 : first.length < 21 + first[9]!)) fail('INVALID', 'Opus 声道标识头无效');
  } else fail('UNSUPPORTED', 'Ogg 音频编码暂不支持内嵌封面读取');
  const packet = await packets.packet(TOTAL_READ_BYTES), prefixLength = vorbis ? 7 : 8;
  if (!(await packet.read(0, prefixLength)).equals(Buffer.from(vorbis ? '\x03vorbis' : 'OpusTags'))) fail('INVALID', 'Ogg 缺少对应注释头');
  let position = prefixLength;
  const integer = async (): Promise<number> => { const value = (await packet.read(position, 4)).readUInt32LE(); position += 4; return value; };
  const vendorLength = await integer(); position = packet.end(position, vendorLength);
  const count = await integer();
  if (count > HEADER_COUNT) fail('LIMIT', 'Ogg 注释数量超过预算');
  for (let index = 0; index < count; index++) {
    const length = await integer(), end = packet.end(position, length);
    const prefix = await packet.read(position, Math.min(length, MIME_BYTES + 1)), separator = prefix.indexOf(0x3d);
    if (separator < 1) fail('INVALID', 'Ogg 注释缺少有界字段名');
    const key = prefix.subarray(0, separator);
    if (key.some(byte => byte < 0x20 || byte > 0x7d)) fail('INVALID', 'Ogg 注释字段名无效');
    const name = key.toString('ascii').toUpperCase();
    if (name === 'METADATA_BLOCK_PICTURE') await oggPicture(packet, position + separator + 1, length - separator - 1, pictures);
    else if (name === 'COVERART' || name === 'COVERARTMIME') fail('UNSUPPORTED', 'Ogg 旧式封面注释暂不支持');
    position = end;
  }
  if (vorbis && (position + 1 !== packet.size || (await packet.read(position, 1))[0] !== 1)) fail('INVALID', 'Vorbis 注释 framing 无效');
  // OpusTags 允许注释列表后的填充；尾部只核单流页边界，不读取 setup 或音频载荷。
  await packets.finishSingleStream();
}

/** 只提取已许可只读 FD 的原图片字节；不解码图片，不验证 SourceRoot，也不持有音频排他锁。 */
export async function readLocalEmbeddedArtwork(handle: FileHandle, size: number, signal: AbortSignal): Promise<ReadonlyArray<EmbeddedArtwork>> {
  const reader = new BoundedReader(handle, size, signal), pictures = new Pictures();
  reader.check();
  if (!Number.isSafeInteger(size) || size < 0) fail('INVALID', '内嵌封面源文件大小无效');
  const magic = await reader.read(0, Math.min(4, size));
  if (magic.toString('latin1') === 'fLaC') await readFlac(reader, pictures);
  else if (magic.length >= 3 && magic.toString('latin1', 0, 3) === 'ID3') await readId3(reader, magic, pictures);
  else if (magic.toString('latin1') === 'RIFF') await readWave(reader, pictures);
  else if (magic.toString('latin1') === 'OggS') await readOgg(reader, pictures);
  else if (size >= 8 && (await reader.read(4, 4)).toString('latin1') === 'ftyp') await readMp4(reader, pictures);
  else fail('UNSUPPORTED', '音频容器暂不支持内嵌封面读取');
  reader.check();
  // pictureIndex 仅定位这次读取的图片顺序，不是跨重扫的稳定身份。
  return Object.freeze(pictures.items);
}
