import { LocalArtworkImageError } from './artwork-image-error.js'

const MAX_DIMENSION = 4096
const MAX_PIXELS = 16 * 1024 * 1024
const MAX_DECODED_BYTES = 64 * 1024 * 1024
const MAX_METADATA_BYTES = 256 * 1024
const MAX_PARTS = 4096
const MAX_IFD_FIELDS = 512

interface Geometry { width: number; height: number }
interface TiffGeometry extends Geometry { orientation: number }
const fail = (message: string): never => { throw new LocalArtworkImageError(message) }
const invalid = (format: string): never => fail(`${format} 封面结构不完整或不受支持，请选择完整的单帧图片。`)
const singleFrame = (format: string): never => fail(`${format} 封面含多帧或额外图像目录，请先导出单帧副本。`)
const metadataLimit = (): never => fail('封面图片的元数据超过安全预算，请先导出不含多余元数据的副本。')

export function geometry(size: Geometry): void {
  if (!Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height) || size.width < 1 || size.height < 1
    || size.width > MAX_DIMENSION || size.height > MAX_DIMENSION || size.width * size.height > MAX_PIXELS) {
    fail('封面像素过大或尺寸无效，宽高不得超过 4096，像素不得超过 16 Mi。')
  }
  if (size.width * size.height * 4 > MAX_DECODED_BYTES) fail('封面的解码像素内存超过安全预算。')
}
const uint24 = (bytes: Buffer, offset: number): number => bytes[offset]! | bytes[offset + 1]! << 8 | bytes[offset + 2]! << 16

/** WebP 容器与帧头预算；压缩像素的实际可解码性仍由注入的 native 适配器确认。 */
export function webpGeometry(bytes: Buffer): Geometry {
  // 结构依据：https://developers.google.com/speed/webp/docs/riff_container
  if (bytes.length < 20 || bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WEBP'
    || bytes.readUInt32LE(4) !== bytes.length - 8) return invalid('WebP')
  let offset = 12, parts = 0, metadataBytes = 0, extended = false, flags = 0
  let canvas: Geometry | undefined, frame: Geometry | undefined, imageType = '', alpha: Buffer | undefined
  const seen = new Set<string>()
  while (offset < bytes.length) {
    if (++parts > MAX_PARTS || offset + 8 > bytes.length) return invalid('WebP')
    const type = bytes.toString('latin1', offset, offset + 4), length = bytes.readUInt32LE(offset + 4)
    const end = offset + 8 + length, padded = end + (length & 1)
    if (!/^[\x20-\x7e]{4}$/u.test(type) || padded > bytes.length || ((length & 1) && bytes[end] !== 0)) return invalid('WebP')
    const body = bytes.subarray(offset + 8, end)
    if (type === 'ANIM' || type === 'ANMF') return singleFrame('WebP')
    if (['VP8X', 'VP8 ', 'VP8L', 'ALPH', 'ICCP', 'EXIF', 'XMP '].includes(type)) {
      if (seen.has(type)) return invalid('WebP')
      seen.add(type)
    }
    if (type === 'VP8X') {
      if (parts !== 1 || length !== 10 || (body[0]! & 0xc1) !== 0 || body[1] !== 0 || body[2] !== 0 || body[3] !== 0) return invalid('WebP')
      flags = body[0]!; if (flags & 2) return singleFrame('WebP')
      extended = true; canvas = { width: uint24(body, 4) + 1, height: uint24(body, 7) + 1 }; geometry(canvas)
    } else if (type === 'VP8 ' || type === 'VP8L') {
      if (frame) return singleFrame('WebP')
      imageType = type
      if (type === 'VP8 ') {
        // RFC 6386 帧头：首分区大小不含 10 字节的未压缩关键帧头。
        if (length < 11) return invalid('WebP')
        const tag = uint24(body, 0), partition = tag >>> 5
        if ((tag & 1) !== 0 || ((tag >>> 1) & 7) > 3 || (tag & 16) === 0 || partition < 1 || partition > length - 10
          || !body.subarray(3, 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))) return invalid('WebP')
        frame = { width: body.readUInt16LE(6) & 0x3fff, height: body.readUInt16LE(8) & 0x3fff }
      } else {
        if (length < 6 || body[0] !== 0x2f) return invalid('WebP')
        const bits = body.readUInt32LE(1)
        if ((bits >>> 29) !== 0 || alpha) return invalid('WebP')
        frame = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
      }
      geometry(frame)
    } else if (type === 'ALPH') {
      if (!extended || frame || length < 2 || (body[0]! & 0xc0) !== 0 || ((body[0]! >>> 4) & 3) > 1 || (body[0]! & 3) > 1) return invalid('WebP')
      alpha = body
    } else {
      if (type === 'ICCP' && (!extended || frame || alpha || !length)) return invalid('WebP')
      if ((type === 'EXIF' || type === 'XMP ') && (!extended || !frame || !length)) return invalid('WebP')
      metadataBytes += length
      if (metadataBytes > MAX_METADATA_BYTES) return metadataLimit()
    }
    offset = padded
  }
  if (!frame || offset !== bytes.length) return invalid('WebP')
  if (!extended && (parts !== 1 || alpha)) return invalid('WebP')
  if (canvas && (canvas.width !== frame.width || canvas.height !== frame.height)) return invalid('WebP')
  if (extended && (Boolean(flags & 0x20) !== seen.has('ICCP') || Boolean(flags & 0x08) !== seen.has('EXIF')
    || Boolean(flags & 0x04) !== seen.has('XMP ') || (imageType === 'VP8 ' && Boolean(flags & 0x10) !== Boolean(alpha)))) return invalid('WebP')
  if (alpha && (imageType !== 'VP8 ' || ((alpha[0]! & 3) === 0 && alpha.length !== 1 + frame.width * frame.height))) return invalid('WebP')
  return frame
}

interface TiffField { type: number; count: number; bytes: Buffer }
interface ByteRange { start: number; end: number }
const TYPE_BYTES: Readonly<Record<number, number>> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4, 16: 8, 17: 8, 18: 8 }
const IMAGE_DIRECTORY_TAGS = new Set([254, 255, 256, 257, 258, 259, 262, 273, 277, 278, 279, 284, 297, 322, 323, 324, 325, 330, 513, 514, 32997, 32998])
const overlap = (a: ByteRange, b: ByteRange): boolean => a.start < b.end && b.start < a.end

/** TIFF 中的 JPEG 帧头也要先校核，不能让小 TIFF 尺寸掩盖巨大压缩子图。 */
function embeddedJpegGeometry(bytes: Buffer, tablesOnly = false): Geometry | null {
  if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216) return invalid('TIFF JPEG')
  let offset = 2, parts = 0, scans = 0, metadataBytes = 0, frame: Geometry | null = null
  while (offset < bytes.length) {
    if (++parts > MAX_PARTS || bytes[offset++] !== 255) return invalid('TIFF JPEG')
    while (bytes[offset] === 255) offset++
    const marker = bytes[offset++]
    if (marker === undefined || marker === 0 || marker === 216 || (marker >= 208 && marker <= 215)) return invalid('TIFF JPEG')
    if (marker === 217) {
      if (offset !== bytes.length || (tablesOnly ? Boolean(frame || scans) : !frame || !scans)) return invalid('TIFF JPEG')
      return frame
    }
    if (offset + 2 > bytes.length) return invalid('TIFF JPEG')
    const length = bytes.readUInt16BE(offset), end = offset + length
    if (length < 2 || end > bytes.length) return invalid('TIFF JPEG')
    const body = bytes.subarray(offset + 2, end)
    if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker)) {
      if (tablesOnly || frame || body.length < 9 || body[5]! < 1 || body[5]! > 4 || body.length !== 6 + body[5]! * 3) return invalid('TIFF JPEG')
      frame = { width: body.readUInt16BE(3), height: body.readUInt16BE(1) }; geometry(frame)
    } else if (marker === 218) {
      if (tablesOnly || !frame || ++scans > 128 || body.length < 6 || body[0]! < 1 || body[0]! > 4 || body.length !== 1 + body[0]! * 2 + 3) return invalid('TIFF JPEG')
      offset = end; let entropyBytes = 0
      while (offset < bytes.length) {
        if (bytes[offset] !== 255) { offset++; entropyBytes++; continue }
        const start = offset; while (bytes[offset] === 255) offset++
        const next = bytes[offset]
        if (next === undefined) return invalid('TIFF JPEG')
        if (next === 0 || (next >= 208 && next <= 215)) { offset++; entropyBytes++; continue }
        offset = start; break
      }
      if (!entropyBytes) return invalid('TIFF JPEG')
      continue
    } else if ((marker >= 224 && marker <= 239) || marker === 254) {
      if (marker === 226 && body.subarray(0, 4).equals(Buffer.from('MPF\0', 'ascii'))) return singleFrame('TIFF JPEG')
      metadataBytes += body.length; if (metadataBytes > MAX_METADATA_BYTES) return metadataLimit()
    } else if (![196, 204, 219, 221].includes(marker)) return invalid('TIFF JPEG')
    offset = end
  }
  return invalid('TIFF JPEG')
}

/** Classic TIFF 与 BigTIFF 的 IFD/条带/瓦片均有界；不使用 native 解码探测单帧或尺寸。 */
export function tiffGeometry(bytes: Buffer): TiffGeometry {
  // TIFF 6.0 与 BigTIFF 的结构规则；64 位 offset 在读取前仍受当前输入长度约束。
  const endian = bytes.toString('latin1', 0, 2), little = endian === 'II'
  if ((endian !== 'II' && endian !== 'MM') || bytes.length < 8) return invalid('TIFF')
  const u16 = (at: number): number => little ? bytes.readUInt16LE(at) : bytes.readUInt16BE(at)
  const u32 = (at: number): number => little ? bytes.readUInt32LE(at) : bytes.readUInt32BE(at)
  const u64 = (at: number): number => {
    const value = little ? bytes.readBigUInt64LE(at) : bytes.readBigUInt64BE(at)
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) return invalid('TIFF')
    return Number(value)
  }
  const magic = u16(2), big = magic === 43
  if (magic !== 42 && !big) return invalid('TIFF')
  const header = big ? 16 : 8, countSize = big ? 8 : 2, entrySize = big ? 20 : 12, inlineSize = big ? 8 : 4
  if (bytes.length < header || (big && (u16(4) !== 8 || u16(6) !== 0))) return invalid('TIFF')
  const offsetValue = big ? u64 : u32, countValue = big ? u64 : u16
  const ranges: ByteRange[] = [{ start: 0, end: header }], visited = new Set<number>()
  let metadataBytes = 0, ifds = 0, totalFields = 0
  const range = (start: number, length: number): ByteRange => {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 1 || start > bytes.length - length) return invalid('TIFF')
    return { start, end: start + length }
  }
  const addStructure = (item: ByteRange): void => {
    if (ranges.some(other => overlap(item, other) && (item.start !== other.start || item.end !== other.end))) return invalid('TIFF')
    if (!ranges.some(other => item.start === other.start && item.end === other.end)) ranges.push(item)
  }
  const values = (field: TiffField | undefined): number[] => {
    if (!field || ![1, 3, 4, 13, ...(big ? [16, 18] : [])].includes(field.type) || field.count > MAX_PARTS) return invalid('TIFF')
    const width = TYPE_BYTES[field.type]!
    return Array.from({ length: field.count }, (_, index) => {
      const at = index * width
      if (width === 1) return field.bytes[at]!
      if (width === 2) return little ? field.bytes.readUInt16LE(at) : field.bytes.readUInt16BE(at)
      if (width === 4) return little ? field.bytes.readUInt32LE(at) : field.bytes.readUInt32BE(at)
      const value = little ? field.bytes.readBigUInt64LE(at) : field.bytes.readBigUInt64BE(at)
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) return invalid('TIFF')
      return Number(value)
    })
  }
  const scalar = (fields: Map<number, TiffField>, tag: number, fallback?: number): number => {
    const field = fields.get(tag)
    if (!field && fallback !== undefined) return fallback
    const all = values(field); if (all.length !== 1) return invalid('TIFF')
    return all[0]!
  }
  const parseIfd = (start: number, metadata: boolean, depth: number): Map<number, TiffField> => {
    if (++ifds > 8 || depth > 4 || start < header || start % (big ? 8 : 2) !== 0 || visited.has(start)) return invalid('TIFF')
    visited.add(start); range(start, countSize)
    const count = countValue(start)
    if (count < 1 || count > MAX_IFD_FIELDS || (totalFields += count) > MAX_PARTS) return invalid('TIFF')
    const size = countSize + count * entrySize + inlineSize, table = range(start, size)
    if (ranges.some(other => overlap(table, other))) return invalid('TIFF')
    addStructure(table); metadataBytes += size
    if (metadataBytes > MAX_METADATA_BYTES) return metadataLimit()
    const fields = new Map<number, TiffField>(); let previous = -1
    for (let index = 0; index < count; index++) {
      const at = start + countSize + index * entrySize, tag = u16(at), type = u16(at + 2)
      const width = TYPE_BYTES[type], length = big ? u64(at + 4) : u32(at + 4)
      if (tag <= previous || !width || (!big && type >= 16) || length < 1 || !Number.isSafeInteger(length * width)) return invalid('TIFF')
      if (metadata && IMAGE_DIRECTORY_TAGS.has(tag)) return singleFrame('TIFF')
      if (tag === 330 || tag === 400) return singleFrame('TIFF')
      previous = tag
      const byteCount = length * width, valueAt = at + (big ? 12 : 8)
      metadataBytes += byteCount; if (metadataBytes > MAX_METADATA_BYTES) return metadataLimit()
      const payloadAt = byteCount <= inlineSize ? valueAt : offsetValue(valueAt), payload = range(payloadAt, byteCount)
      if (byteCount > inlineSize) {
        if (payloadAt < header || payloadAt % (big ? 8 : 2) !== 0) return invalid('TIFF')
        addStructure(payload)
      }
      if ((type === 13 || type === 18) && ![34665, 34853, 40965].includes(tag)) return singleFrame('TIFF')
      fields.set(tag, { type, count: length, bytes: bytes.subarray(payload.start, payload.end) })
    }
    if (offsetValue(start + countSize + count * entrySize) !== 0) return singleFrame('TIFF')
    for (const tag of [34665, 34853, 40965]) {
      if (fields.has(tag)) {
        const next = scalar(fields, tag)
        if (next !== 0) parseIfd(next, true, depth + 1)
      }
    }
    return fields
  }
  const fields = parseIfd(offsetValue(big ? 8 : 4), false, 0)
  const size = { width: scalar(fields, 256), height: scalar(fields, 257) }; geometry(size)
  const samples = scalar(fields, 277, 1), orientation = scalar(fields, 274, 1), planar = scalar(fields, 284, 1), compression = scalar(fields, 259, 1)
  if (samples < 1 || samples > 4 || orientation < 1 || orientation > 8 || ![1, 2].includes(planar)
    || ![1, 2, 3, 4, 5, 6, 7, 8, 32946, 32773].includes(compression)) return invalid('TIFF')
  const photo = scalar(fields, 262)
  if (![0, 1, 2, 3, 4, 5, 6, 8, 9, 10].includes(photo) || ([2, 6, 8, 9, 10].includes(photo) && samples < 3) || (photo === 5 && samples !== 4)) return invalid('TIFF')
  const bits = fields.has(258) ? values(fields.get(258)) : Array.from({ length: samples }, () => 1)
  if (bits.length !== samples || bits.some(value => ![1, 2, 4, 8, 16, 32, 64].includes(value))) return invalid('TIFF')
  const bitSum = bits.reduce((sum, value) => sum + value, 0)
  // 同时约束编码展开与 RGBA 尺寸；这不是对 native 进程完整 RSS 的保证。
  if (Math.ceil(size.width * bitSum / 8) * size.height > MAX_DECODED_BYTES) fail('TIFF 封面的样本展开超过安全预算。')
  if (fields.has(339)) {
    const formats = values(fields.get(339)); if (formats.length !== samples || formats.some(value => ![1, 2, 3, 4].includes(value))) return invalid('TIFF')
  }
  if (fields.has(338)) { const extra = values(fields.get(338)); if (extra.length > samples || extra.some(value => value > 2)) return invalid('TIFF') }
  if (fields.has(297)) { const page = values(fields.get(297)); if (page.length !== 2 || page[0] !== 0 || page[1] !== 1) return singleFrame('TIFF') }
  if ((scalar(fields, 254, 0) & 2) !== 0 || (fields.has(255) && scalar(fields, 255) === 3)) return singleFrame('TIFF')
  if (scalar(fields, 32997, 1) !== 1 || scalar(fields, 32998, 1) !== 1) return singleFrame('TIFF')
  const subsampling = photo === 6 ? fields.has(530) ? values(fields.get(530)) : [2, 2] : [1, 1]
  if (photo === 6 && (samples !== 3 || planar !== 1 || bits.some(value => value !== 8) || subsampling.length !== 2
    || subsampling.some(value => ![1, 2, 4].includes(value)) || subsampling[1]! > subsampling[0]!)) return invalid('TIFF')
  if (photo === 3) {
    const palette = fields.get(320)
    if (samples !== 1 || !palette || palette.type !== 3 || palette.count !== 3 * 2 ** bits[0]!) return invalid('TIFF')
  }
  const tiled = [322, 323, 324, 325].some(tag => fields.has(tag)), planes = planar === 2 ? samples : 1
  if (tiled && [273, 278, 279].some(tag => fields.has(tag))) return invalid('TIFF')
  let offsets: number[], counts: number[], blockWidth: number, blockHeight: number, perPlane: number
  if (tiled) {
    blockWidth = scalar(fields, 322); blockHeight = scalar(fields, 323); geometry({ width: blockWidth, height: blockHeight })
    perPlane = Math.ceil(size.width / blockWidth) * Math.ceil(size.height / blockHeight)
    offsets = values(fields.get(324)); counts = values(fields.get(325))
    if (Math.ceil(blockWidth * bitSum / 8) * blockHeight * perPlane > MAX_DECODED_BYTES
      || blockWidth * blockHeight * perPlane * 4 > MAX_DECODED_BYTES) fail('TIFF 封面的瓦片展开超过安全预算。')
  } else {
    const rows = scalar(fields, 278, 0xffffffff); if (rows < 1) return invalid('TIFF')
    blockWidth = size.width; blockHeight = Math.min(rows, size.height); perPlane = Math.ceil(size.height / blockHeight)
    offsets = values(fields.get(273)); counts = values(fields.get(279))
  }
  if (offsets.length !== perPlane * planes || counts.length !== offsets.length || offsets.length > MAX_PARTS) return invalid('TIFF')
  const imageRanges: ByteRange[] = []
  const validatePixelRange = (item: ByteRange): void => {
    if (ranges.some(other => overlap(item, other)) || imageRanges.some(other => overlap(item, other))) return invalid('TIFF')
    imageRanges.push(item)
  }
  const oldJpegOffset = fields.has(513), oldJpegLength = fields.has(514)
  if (oldJpegOffset !== oldJpegLength || ((oldJpegOffset || oldJpegLength) && compression !== 6)) return invalid('TIFF')
  let oldJpeg: ByteRange | null = null
  if (compression === 6) {
    if (!oldJpegOffset || planar !== 1) return invalid('TIFF')
    oldJpeg = range(scalar(fields, 513), scalar(fields, 514))
    if (ranges.some(other => overlap(oldJpeg!, other))) return invalid('TIFF')
    const nested = embeddedJpegGeometry(bytes.subarray(oldJpeg.start, oldJpeg.end))!
    if (nested.width !== size.width || nested.height !== size.height) return invalid('TIFF JPEG')
  }
  if (fields.has(347)) embeddedJpegGeometry(fields.get(347)!.bytes, true)
  for (let index = 0; index < offsets.length; index++) {
    const item = range(offsets[index]!, counts[index]!); validatePixelRange(item)
    const rowCount = tiled ? blockHeight : Math.min(blockHeight, size.height - (index % perPlane) * blockHeight)
    const sampleBits = planar === 2 ? bits[Math.floor(index / perPlane)]! : bitSum
    const unpackedBytes = photo === 6
      ? Math.ceil(blockWidth / subsampling[0]!) * Math.ceil(rowCount / subsampling[1]!) * (subsampling[0]! * subsampling[1]! + 2)
      : Math.ceil(blockWidth * sampleBits / 8) * rowCount
    if (compression === 1 && counts[index] !== unpackedBytes) return invalid('TIFF')
    if (oldJpeg && (item.start < oldJpeg.start || item.end > oldJpeg.end)) return invalid('TIFF JPEG')
    if (compression === 7) {
      const nested = embeddedJpegGeometry(bytes.subarray(item.start, item.end))!
      if (nested.width > blockWidth || nested.height > rowCount) return invalid('TIFF JPEG')
    }
  }
  return { ...size, orientation }
}
