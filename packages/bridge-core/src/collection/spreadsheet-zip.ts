import { crc32, inflateRawSync } from 'node:zlib';

const fail = (): never => { throw new Error('工作簿压缩结构无效或超过安全预算。'); };
const ENTRY_LIMIT = 2048, ENTRY_BYTES = 16 * 1024 * 1024, TOTAL_BYTES = 64 * 1024 * 1024;

/** 在可终止 Worker 内调用。实际解压限额、CRC及本地/中央目录一致性必须同时通过。 */
export function validateSpreadsheetZip(bytes: Buffer): { entryCount: number; expandedBytes: number } {
  if (bytes.length < 22 || bytes.length > 8 * 1024 * 1024) return fail();
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0 || bytes.readUInt32LE(end) !== 0x06054b50 || end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length) return fail();
  const count = bytes.readUInt16LE(end + 10), start = bytes.readUInt32LE(end + 16), size = bytes.readUInt32LE(end + 12);
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== count
    || count < 1 || count > ENTRY_LIMIT || start + size !== end) return fail();
  const names = new Set<string>(), ranges: Array<[number, number]> = []; let offset = start, total = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) return fail();
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10), checksum = bytes.readUInt32LE(offset + 16);
    const compressed = bytes.readUInt32LE(offset + 20), expanded = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28), extraLength = bytes.readUInt16LE(offset + 30), commentLength = bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42), next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > end || flags & ~0x080e || flags & 1 || ![0, 8].includes(method) || bytes.readUInt16LE(offset + 34)
      || expanded > ENTRY_BYTES || compressed === 0xffffffff || local === 0xffffffff || total + expanded > TOTAL_BYTES) return fail();
    const rawName = bytes.subarray(offset + 46, offset + 46 + nameLength), name = rawName.toString('utf8');
    if (!name || !Buffer.from(name).equals(rawName) || name.length > 512 || /[\\\x00-\x1f\x7f:]/u.test(name) || name.startsWith('/')
      || name.split('/').some((part, index, all) => part === '.' || part === '..' || (!part && index !== all.length - 1)) || names.has(name)) return fail();
    names.add(name);
    // ZIP64及路径重定义扩展不在本任务支持范围；忽略时间戳类普通扩展。
    for (let e = offset + 46 + nameLength; e < offset + 46 + nameLength + extraLength;) {
      if (e + 4 > offset + 46 + nameLength + extraLength) return fail();
      const tag = bytes.readUInt16LE(e), length = bytes.readUInt16LE(e + 2); e += 4 + length;
      if ([1, 0x7075].includes(tag) || e > offset + 46 + nameLength + extraLength) return fail();
    }
    if (local + 30 > start || bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method) return fail();
    const localNameLength = bytes.readUInt16LE(local + 26), localExtraLength = bytes.readUInt16LE(local + 28);
    const dataStart = local + 30 + localNameLength + localExtraLength, dataEnd = dataStart + compressed;
    if (dataStart > start || dataEnd > start || !rawName.equals(bytes.subarray(local + 30, local + 30 + localNameLength))) return fail();
    if (!(flags & 8) && (bytes.readUInt32LE(local + 14) !== checksum || bytes.readUInt32LE(local + 18) !== compressed || bytes.readUInt32LE(local + 22) !== expanded)) return fail();
    let rangeEnd = dataEnd;
    if (flags & 8) {
      const descriptor = dataEnd + (dataEnd + 4 <= start && bytes.readUInt32LE(dataEnd) === 0x08074b50 ? 4 : 0);
      if (descriptor + 12 > start || bytes.readUInt32LE(descriptor) !== checksum || bytes.readUInt32LE(descriptor + 4) !== compressed || bytes.readUInt32LE(descriptor + 8) !== expanded) return fail();
      rangeEnd = descriptor + 12;
    }
    const packed = bytes.subarray(dataStart, dataEnd);
    const output = method === 0 ? packed : inflateRawSync(packed, { maxOutputLength: Math.min(ENTRY_BYTES, TOTAL_BYTES - total) });
    if (output.length !== expanded || output.length > ENTRY_BYTES || crc32(output) !== checksum) return fail();
    total += output.length; if (total > TOTAL_BYTES) return fail();
    ranges.push([local, rangeEnd]); offset = next;
  }
  if (offset !== end) return fail();
  ranges.sort((a, b) => a[0] - b[0]); let expected = 0;
  for (const [begin, finish] of ranges) { if (begin !== expected) return fail(); expected = finish; }
  if (expected !== start) return fail();
  return { entryCount: count, expandedBytes: total };
}
