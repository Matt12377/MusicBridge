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

async function readId3(reader: BoundedReader, magic: Buffer, pictures: Pictures): Promise<void> {
  // 其他 ID3 主版本属于未支持格式，不尝试借用 v2.3/v2.4 的 frame 布局。
  if (magic.length === 4 && magic[3] !== 3 && magic[3] !== 4) return;
  const tail = await reader.read(4, 6), header = Buffer.concat([magic, tail]);
  const version = header[3]!;
  if ((version !== 3 && version !== 4) || header[4] !== 0 || header[5] !== 0) {
    fail('UNSUPPORTED', 'ID3 修订、扩展头、非同步或其他标签标记暂不支持');
  }
  const end = reader.end(10, synchsafe(header, 6));
  let position = 10;
  for (let count = 0; position < end; count++) {
    if (count >= HEADER_COUNT) fail('LIMIT', 'ID3 frame 数量超过预算');
    const header = await reader.read(position, Math.min(10, end - position), end);
    if (header.every(byte => byte === 0)) return; // padding 起点，不延伸到标签后的音频。
    if (header.length !== 10 || !/^[A-Z0-9]{4}$/u.test(header.toString('latin1', 0, 4))) fail('INVALID', 'ID3 frame 头无效或截断');
    if (header[8] !== 0 || header[9] !== 0) fail('UNSUPPORTED', 'ID3 frame 压缩、加密、非同步或其他标记暂不支持');
    const length = version === 4 ? synchsafe(header, 4) : header.readUInt32BE(4);
    if (length === 0) fail('INVALID', 'ID3 frame 内容为空');
    position += 10;
    const frameEnd = reader.end(position, length, end);
    if (header.toString('latin1', 0, 4) === 'APIC') await apic(reader, position, frameEnd, version, pictures);
    position = frameEnd;
  }
}

/** 只提取已许可只读 FD 的原图片字节；不解码图片，不验证 SourceRoot，也不持有音频排他锁。 */
export async function readLocalEmbeddedArtwork(handle: FileHandle, size: number, signal: AbortSignal): Promise<ReadonlyArray<EmbeddedArtwork>> {
  const reader = new BoundedReader(handle, size, signal), pictures = new Pictures();
  reader.check();
  if (!Number.isSafeInteger(size) || size < 0) fail('INVALID', '内嵌封面源文件大小无效');
  const magic = await reader.read(0, Math.min(4, size));
  if (magic.toString('latin1') === 'fLaC') await readFlac(reader, pictures);
  else if (magic.length >= 3 && magic.toString('latin1', 0, 3) === 'ID3') await readId3(reader, magic, pictures);
  reader.check();
  // pictureIndex 仅定位这次读取的图片顺序，不是跨重扫的稳定身份。
  return Object.freeze(pictures.items);
}
