import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { spawn, type ChildProcess } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, unlink, rmdir, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import type { LocalArtworkImportFormat } from '@music-bridge/contracts'
import type { PhotoDecoderImage } from '../collection-photos.js'
import { LocalArtworkImageError, normalizeLocalArtwork, type NormalizedLocalArtwork } from '../local-artwork-image.js'

const MAX_INPUT_BYTES = 4 * 1024 * 1024
const MAX_DIMENSION = 4096
const MAX_PIXELS = 16 * 1024 * 1024
const MAX_DECODED_BYTES = 64 * 1024 * 1024
const MAX_METADATA_BYTES = 256 * 1024
const MAX_PARTS = 4096
const MAX_IFD_FIELDS = 512
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

export type ImportedLocalArtworkMime = 'image/png' | 'image/jpeg' | 'image/tiff' | 'image/webp'
/** 仅供 Main 捕获；原输入身份不能当成旧公开 original 的身份。 */
export interface ImportedLocalArtworkInput {
  mime: ImportedLocalArtworkMime
  bytes: number
  sha256: string
  converted: boolean
}
export interface NormalizedImportedLocalArtwork {
  image: NormalizedLocalArtwork
  /** TIFF/WebP 时为转换后的 JPEG copy；与 image.original 的字节身份一致。 */
  compatibleOriginalBytes: Uint8Array
  input: ImportedLocalArtworkInput
  conversionLabel: string | null
}
interface Geometry { width: number; height: number }
interface TiffGeometry extends Geometry { orientation: number }
const fail = (message: string): never => { throw new LocalArtworkImageError(message) }
const invalid = (format: string): never => fail(`${format} 封面结构不完整或不受支持，请选择完整的单帧图片。`)
const singleFrame = (format: string): never => fail(`${format} 封面含多帧或额外图像目录，请先导出单帧副本。`)
const metadataLimit = (): never => fail('封面图片的元数据超过安全预算，请先导出不含多余元数据的副本。')
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

function geometry(size: Geometry): void {
  if (!Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height) || size.width < 1 || size.height < 1
    || size.width > MAX_DIMENSION || size.height > MAX_DIMENSION || size.width * size.height > MAX_PIXELS) {
    fail('封面像素过大或尺寸无效，宽高不得超过 4096，像素不得超过 16 Mi。')
  }
  if (size.width * size.height * 4 > MAX_DECODED_BYTES) fail('封面的解码像素内存超过安全预算。')
}
const uint24 = (bytes: Buffer, offset: number): number => bytes[offset]! | bytes[offset + 1]! << 8 | bytes[offset + 2]! << 16

/** WebP 容器与帧头预算；压缩像素的实际可解码性仍由注入的 native 适配器确认。 */
function webpGeometry(bytes: Buffer): Geometry {
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
function tiffGeometry(bytes: Buffer): TiffGeometry {
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

/**
 * Main 导入入口。PNG/JPEG 使用已有严格归一化；TIFF/WebP 先有界检查，再转换成兼容 JPEG。
 * 合成 decoder 只证明调用边界；实际 TIFF/WebP native 能力须由 Electron Gate 单独确认。
 */
export function normalizeImportedLocalArtwork(bytes: Uint8Array, decode: (bytes: Buffer) => PhotoDecoderImage): NormalizedImportedLocalArtwork {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 4 || bytes.byteLength > MAX_INPUT_BYTES) fail('封面图片必须非空，压缩大小不得超过 4 MiB。')
  const captured = Buffer.from(bytes)
  const prefix = captured.toString('latin1', 0, 2)
  const mime: ImportedLocalArtworkMime = captured.subarray(0, 8).equals(PNG_SIGNATURE) ? 'image/png'
    : captured[0] === 255 && captured[1] === 216 ? 'image/jpeg'
      : prefix === 'II' || prefix === 'MM' ? 'image/tiff'
        : captured.toString('latin1', 0, 4) === 'RIFF' ? 'image/webp'
          : fail('封面格式不受支持，请选择单帧 TIFF、WebP、JPEG 或 PNG。')
  const converted = mime === 'image/tiff' || mime === 'image/webp'
  const input: ImportedLocalArtworkInput = { mime, bytes: captured.length, sha256: hash(captured), converted }
  if (!converted) return { image: normalizeLocalArtwork(captured, decode), compatibleOriginalBytes: new Uint8Array(captured), input, conversionLabel: null }
  const declared = mime === 'image/tiff' ? tiffGeometry(captured) : { ...webpGeometry(captured), orientation: 1 }
  const format = mime === 'image/tiff' ? 'TIFF' : 'WebP'
  let image: PhotoDecoderImage
  try {
    image = decode(Buffer.from(captured))
    if (image.isEmpty()) fail(`当前图片解码器无法读取这张 ${format} 封面，请提供完整单帧副本或使用支持该格式的解码器。`)
  } catch (error) {
    if (error instanceof LocalArtworkImageError) throw error
    return fail(`当前图片解码器无法读取这张 ${format} 封面，请提供完整单帧副本或使用支持该格式的解码器。`)
  }
  try {
    const actual = image.getSize(); geometry(actual)
    const swapped = declared.orientation >= 5 && declared.orientation <= 8
      && actual.width === declared.height && actual.height === declared.width
    if (!swapped && (actual.width !== declared.width || actual.height !== declared.height)) fail('封面的实际解码尺寸与文件声明不一致。')
    const compatible = image.toJPEG(85)
    if (!Buffer.isBuffer(compatible) || compatible.length < 4 || compatible.length > MAX_INPUT_BYTES) fail('封面的 JPEG 兼容副本无效或超过 4 MiB。')
    const copied = Buffer.from(compatible), normalized = normalizeLocalArtwork(copied, decode)
    if (normalized.original.width !== actual.width || normalized.original.height !== actual.height) fail('封面的 JPEG 兼容副本尺寸与转换前不一致。')
    return { image: normalized, compatibleOriginalBytes: new Uint8Array(copied), input, conversionLabel: `${format} 输入已转换为 JPEG 兼容副本；原输入身份仅保存在 Main 捕获记录。` }
  } catch (error) {
    if (error instanceof LocalArtworkImageError) throw error
    return fail(`${format} 封面转换为 JPEG 兼容副本失败，请换一张完整的单帧图片。`)
  }
}


/** 本代 Main 的一像素有界探针；通过原完整规范化及展示 JPEG 实际回读才报告可调用。 */
export function probeLocalArtworkImportFormats(decode:(bytes:Buffer)=>PhotoDecoderImage):readonly LocalArtworkImportFormat[] {
  const chunk=(type:string,body:Buffer=Buffer.alloc(0))=>{
    const bytes=Buffer.alloc(body.length+12);bytes.writeUInt32BE(body.length,0);bytes.write(type,4,'ascii');body.copy(bytes,8)
    let crc=0xffffffff
    for(const value of bytes.subarray(4,bytes.length-4)){crc^=value;for(let bit=0;bit<8;bit++)crc=crc&1?0xedb88320^(crc>>>1):crc>>>1}
    bytes.writeUInt32BE((crc^0xffffffff)>>>0,bytes.length-4);return bytes
  }
  const header=Buffer.alloc(13);header.writeUInt32BE(1,0);header.writeUInt32BE(1,4);header[8]=8;header[9]=2
  const png=Buffer.concat([PNG_SIGNATURE,chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([0,37,73,109]))),chunk('IEND')])
  // 一像素、单strip、未压缩Classic TIFF；无外部来源、账户、路径或应用对话框。
  const fields=[[256,4,1,1],[257,4,1,1],[258,3,3,146],[259,3,1,1],[262,3,1,2],[273,4,1,152],[274,3,1,1],[277,3,1,3],[278,4,1,1],[279,4,1,3],[284,3,1,1]] as const
  const tiff=Buffer.alloc(155);tiff.write('II',0,'ascii');tiff.writeUInt16LE(42,2);tiff.writeUInt32LE(8,4);tiff.writeUInt16LE(fields.length,8)
  fields.forEach(([tag,type,count,value],index)=>{const at=10+index*12;tiff.writeUInt16LE(tag,at);tiff.writeUInt16LE(type,at+2);tiff.writeUInt32LE(count,at+4);tiff.writeUInt32LE(value,at+8)})
  for(let index=0;index<3;index++)tiff.writeUInt16LE(8,146+index*2);tiff.set([37,73,109],152)
  // 单帧 VP8 的完整小副本；不能用帧头通过代替真实 native 解码成功。
  const webp=Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA','base64')
  let compatibleJpeg:Buffer|undefined
  const probe=(mime:ImportedLocalArtworkMime,bytes:Buffer|undefined):LocalArtworkImportFormat=>{
    let verified=false
    if(bytes){try{
      const result=normalizeImportedLocalArtwork(bytes,decode),display=result.image.display
      const encoded=Buffer.from(display.dataUrl.slice('data:image/jpeg;base64,'.length),'base64'),read=decode(Buffer.from(encoded)),size=read.getSize()
      verified=result.input.mime===mime&&result.input.sha256===hash(bytes)&&result.image.original.width===1&&result.image.original.height===1
        &&display.width===1&&display.height===1&&encoded.length===display.bytes&&hash(encoded)===display.sha256&&!read.isEmpty()&&size.width===1&&size.height===1
      if(mime==='image/png'&&verified)compatibleJpeg=Buffer.from(encoded)
    }catch{/* 未通过当前 Main 真实规范化/回读时保不可用，不推断其他格式或授权。 */}}
    return {mime,label:mime.slice('image/'.length).toUpperCase(),availability:verified?{available:true}:{available:false,reason:'此格式未通过当前 Main 的有界解码和兼容副本回读。'}}
  }
  const pngResult=probe('image/png',png),jpegResult=probe('image/jpeg',compatibleJpeg)
  return [jpegResult,pngResult,probe('image/tiff',tiff),probe('image/webp',webp)]
}

export interface LocalArtworkNormalizationContext {
  signal: AbortSignal
  /** 仅本Main进程performance.now域；调用者在原flight入场固定，不能逐图续期。 */
  deadlineAtMs: number
  assertCurrent?(): void | Promise<void>
}
export class LocalArtworkNormalizationPhysicalError extends Error {
  constructor(readonly failure: unknown) { super('封面转换的实际资源关闭未确认，原读取未发布。'); this.name = 'LocalArtworkNormalizationPhysicalError' }
}
export interface LocalArtworkImportNormalizerOptions {
  privateRoot: string
  decode(bytes: Buffer): PhotoDecoderImage
  /** 仅受控组件夹具替换进程配方；生产Main不传，不构成系统/Native资格。 */
  spawnProcess?(input: string, output: string, directory: string): ChildProcess
}
interface ConversionFlight {
  controller: AbortController
  work: Promise<NormalizedImportedLocalArtwork>
  physicalFailure: boolean
}
const normalizationExpired = (): Error => { const error = new Error('封面读取的原响应期限已到。'); error.name = 'AbortError'; return error }
const samePrivateDirectory = (a: import('node:fs').BigIntStats, b: import('node:fs').BigIntStats): boolean =>
  a.isDirectory() && b.isDirectory() && !a.isSymbolicLink() && !b.isSymbolicLink()
  && a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid
const samePrivateFile = (a: import('node:fs').BigIntStats, b: import('node:fs').BigIntStats): boolean =>
  a.isFile() && b.isFile() && !a.isSymbolicLink() && !b.isSymbolicLink()
  && ['dev', 'ino', 'birthtimeNs', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'gid', 'nlink'].every(key =>
    a[key as keyof typeof a] === b[key as keyof typeof b])

/** Main自有字节副本的OS适配；不接受用户源路径，不授Source写权或Native包资格。 */
export function createLocalArtworkImportNormalizer(options: LocalArtworkImportNormalizerOptions) {
  if (!path.isAbsolute(options.privateRoot) || path.resolve(options.privateRoot) !== options.privateRoot
    || options.privateRoot === path.parse(options.privateRoot).root || typeof options.decode !== 'function') throw new Error('封面转换需要Main自有的规范私有目录。')
  const active = new Set<ConversionFlight>(), retained = new Set<ConversionFlight>()
  let closing = false, closure: Promise<void> | undefined
  async function current(context: LocalArtworkNormalizationContext, signal = context.signal): Promise<void> {
    if (closing || signal.aborted || context.signal.aborted || !Number.isFinite(context.deadlineAtMs) || performance.now() >= context.deadlineAtMs) throw normalizationExpired()
    await context.assertCurrent?.()
    if (closing || signal.aborted || context.signal.aborted || !Number.isFinite(context.deadlineAtMs) || performance.now() >= context.deadlineAtMs) throw normalizationExpired()
  }
  async function convert(captured: Buffer, context: LocalArtworkNormalizationContext, flight: ConversionFlight): Promise<NormalizedImportedLocalArtwork> {
    const declared = webpGeometry(captured), input: ImportedLocalArtworkInput = { mime: 'image/webp', bytes: captured.length, sha256: hash(captured), converted: true }
    const deadline = context.deadlineAtMs, parentSignal = context.signal, originalAssert = context.assertCurrent
    const guard = async () => {
      if (context.deadlineAtMs !== deadline || context.signal !== parentSignal || context.assertCurrent !== originalAssert) throw normalizationExpired()
      await current(context, flight.controller.signal)
    }
    const checked = async <T>(operation: () => Promise<T>): Promise<T> => { await guard(); const value = await operation(); await guard(); return value }
    let directory: string | undefined, directoryStat: import('node:fs').BigIntStats | undefined
    const handles = new Map<FileHandle, number>(), closeRecords = new WeakMap<FileHandle, { work?: Promise<void>; threw: boolean; failure?: unknown }>(), files: string[] = [], cleanupFailures: unknown[] = []
    let originalFailure: unknown, result: NormalizedImportedLocalArtwork | undefined
    const remember = (handle: FileHandle): FileHandle => { handles.set(handle, handle.fd); return handle }
    const openOwned = async (file: string, flags: number, mode?: number, created = false): Promise<FileHandle> => {
      await guard(); const handle = remember(await open(file, flags, mode)); if (created) files.push(file)
      await guard(); return handle
    }
    const closeHandle = async (handle: FileHandle): Promise<void> => {
      if (!handles.has(handle)) return
      let record = closeRecords.get(handle)
      if (!record) {
        record = { threw: false }; closeRecords.set(handle, record)
        try { record.work = handle.close() } catch (error) { record.threw = true; record.failure = error }
      }
      if (record.threw) throw record.failure
      if (!record.work) throw new Error('原封面副本close没有返回实际工作。')
      await record.work
      // 原close真正fulfilled后只核同FileHandle；旧整数可能已由另一flight复用。
      if (handle.fd !== -1) throw new Error('原封面副本FileHandle关闭尚未确认。')
      handles.delete(handle)
    }
    const assertDirectory = async () => {
      if (!directory || !directoryStat || !samePrivateDirectory(directoryStat, await lstat(directory, { bigint: true }))) throw new Error('Main私有封面目录身份已变化。')
    }
    const readExact = async (handle: FileHandle, size: number): Promise<Buffer> => {
      const bytes = Buffer.alloc(size + 1); let offset = 0
      while (offset < bytes.length) {
        const { bytesRead } = await checked(() => handle.read(bytes, offset, bytes.length - offset, offset))
        if (!bytesRead) break
        offset += bytesRead
      }
      if (offset !== size) throw new Error('Main私有封面副本长度已变化。')
      return bytes.subarray(0, size)
    }
    try {
      await checked(() => mkdir(options.privateRoot, { recursive: true, mode: 0o700 }))
      const root = await checked(() => lstat(options.privateRoot, { bigint: true }))
      if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o777n) !== 0o700n) throw new Error('Main封面转换目录没有私有权限。')
      const rootHandle = await openOwned(options.privateRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      if (!samePrivateDirectory(root, await checked(() => rootHandle.stat({ bigint: true })))) throw new Error('Main封面转换根目录身份已变化。')
      await checked(async () => { directory = await mkdtemp(path.join(options.privateRoot, 'captured-')); directoryStat = await lstat(directory, { bigint: true }); return directory })
      if(!directoryStat)throw new Error('Main封面副本目录缺少原物理身份。')
      if ((directoryStat.mode & 0o777n) !== 0o700n || !samePrivateDirectory(root, await checked(() => lstat(options.privateRoot, { bigint: true })))) throw new Error('Main封面副本目录身份或权限无效。')
      const directoryHandle = await openOwned(directory!, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      if (!samePrivateDirectory(directoryStat, await checked(() => directoryHandle.stat({ bigint: true })))) throw new Error('Main封面副本目录FD身份无效。')
      const inputFile = path.join(directory!, 'input.webp'), outputFile = path.join(directory!, 'output.jpg')
      const inputHandle = await openOwned(inputFile, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600, true)
      await checked(() => inputHandle.writeFile(captured)); await checked(() => inputHandle.sync())
      const inputStat = await checked(() => inputHandle.stat({ bigint: true }))
      if ((inputStat.mode & 0o777n) !== 0o600n || inputStat.nlink !== 1n || inputStat.size !== BigInt(captured.length)
        || !samePrivateFile(inputStat, await checked(() => lstat(inputFile, { bigint: true }))) || hash(await readExact(inputHandle, captured.length)) !== input.sha256) throw new Error('WebP捕获副本与原输入身份不一致。')
      const emptyOutput = await openOwned(outputFile, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600, true)
      await closeHandle(emptyOutput); await guard(); await assertDirectory(); await guard()
      await runSips(inputFile, outputFile, directory!, context, flight)
      await guard(); await assertDirectory(); await guard()
      if (!samePrivateFile(inputStat, await checked(() => inputHandle.stat({ bigint: true })))
        || !samePrivateFile(inputStat, await checked(() => lstat(inputFile, { bigint: true }))) || hash(await readExact(inputHandle, captured.length)) !== input.sha256) throw new Error('系统转换期间原WebP捕获副本已变化。')
      const outputNamed = await checked(() => lstat(outputFile, { bigint: true }))
      if (!outputNamed.isFile() || outputNamed.isSymbolicLink() || outputNamed.nlink !== 1n || outputNamed.size < 4n || outputNamed.size > BigInt(MAX_INPUT_BYTES)) fail('WebP转换后的JPEG副本无效或超过4 MiB。')
      const outputHandle = await openOwned(outputFile, constants.O_RDONLY | constants.O_NOFOLLOW)
      if(!samePrivateFile(outputNamed,await checked(()=>outputHandle.stat({bigint:true}))))throw new Error('系统JPEG与原完成输出的FD身份不一致。')
      await checked(() => outputHandle.chmod(0o600))
      const outputStat = await checked(() => outputHandle.stat({ bigint: true }))
      if ((outputStat.mode & 0o777n) !== 0o600n || !samePrivateFile(outputStat, await checked(() => lstat(outputFile, { bigint: true }))) || outputStat.size !== outputNamed.size) throw new Error('系统JPEG副本的FD或字节身份已变化。')
      const compatible = await readExact(outputHandle, Number(outputStat.size))
      if (!samePrivateFile(outputStat, await checked(() => outputHandle.stat({ bigint: true }))) || !samePrivateFile(outputStat, await checked(() => lstat(outputFile, { bigint: true })))) throw new Error('读取系统JPEG期间原FD身份已变化。')
      const normalized = normalizeLocalArtwork(compatible, options.decode), display = normalized.display
      if (normalized.original.width !== declared.width || normalized.original.height !== declared.height || normalized.original.sha256 !== hash(compatible)) fail('WebP转换后的真实JPEG尺寸或身份与原声明不一致。')
      const displayBytes = Buffer.from(display.dataUrl.slice('data:image/jpeg;base64,'.length), 'base64'), decoded = options.decode(Buffer.from(displayBytes)), displaySize = decoded.getSize()
      if (decoded.isEmpty() || displaySize.width !== display.width || displaySize.height !== display.height || displayBytes.length !== display.bytes || hash(displayBytes) !== display.sha256) fail('WebP展示JPEG副本未通过实际解码回读。')
      await guard()
      result = { image: normalized, compatibleOriginalBytes: new Uint8Array(compatible), input, conversionLabel: 'WebP输入已转换为JPEG兼容副本；原WebP身份与来源签名单独保留，原输入未修改。' }
    } catch (error) { originalFailure = error }
    finally {
      for (const handle of [...handles.keys()].reverse()) try { await closeHandle(handle) } catch (error) { cleanupFailures.push(error) }
      if (directory && !flight.physicalFailure && !cleanupFailures.length && !handles.size) {
        try { await assertDirectory(); for (const file of files) await unlink(file); await rmdir(directory) } catch (error) { cleanupFailures.push(error) }
      }
      if (cleanupFailures.length || handles.size) { flight.physicalFailure = true; retained.add(flight) }
    }
    if (flight.physicalFailure) throw new LocalArtworkNormalizationPhysicalError(new AggregateError([...(originalFailure === undefined ? [] : [originalFailure]), ...cleanupFailures], '原封面转换或物理收尾未确认。'))
    if (originalFailure !== undefined) throw originalFailure
    await guard()
    if (!result) throw new Error('系统封面转换未产生完整结果。')
    return result
  }
  async function runSips(input: string, output: string, directory: string, context: LocalArtworkNormalizationContext, flight: ConversionFlight): Promise<void> {
    await current(context, flight.controller.signal)
    const child = options.spawnProcess?.(input, output, directory) ?? spawn('/usr/bin/sips', ['-s', 'format', 'jpeg', input, '--out', output], {
      cwd: directory, detached: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { LANG: 'C', LC_ALL: 'C', TMPDIR: directory },
    })
    let processFailure: unknown, closed = false, stdoutClosed = false, stderrClosed = false, outputBytes = 0, stopSent = false
    const signalGroup = (signal: NodeJS.Signals) => { if (!child.pid) return; try { process.kill(-child.pid, signal) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') processFailure ??= error } }
    const stop = () => { if (stopSent) return; stopSent = true; signalGroup('SIGTERM'); signalGroup('SIGKILL') }
    const streamClosed = (stream: typeof child.stdout, set: () => void) => new Promise<void>(resolve => {
      if (!stream) { set(); resolve(); return }
      stream.once('close', () => { set(); resolve() }); stream.on('error', error => { processFailure ??= error; stop() })
      stream.on('data', (chunk: Buffer) => { outputBytes += chunk.length; if (outputBytes > 64 * 1024) { processFailure ??= new Error('系统转换输出超过原日志预算。'); stop() } })
    })
    const stdout = streamClosed(child.stdout, () => { stdoutClosed = true }), stderr = streamClosed(child.stderr, () => { stderrClosed = true })
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child.once('error', error => { processFailure ??= error }); child.once('close', (code, signal) => { closed = true; resolve({ code, signal }) })
    })
    const timer = setTimeout(stop, Math.max(1, context.deadlineAtMs - performance.now())), abort = () => stop()
    flight.controller.signal.addEventListener('abort', abort, { once: true }); if (flight.controller.signal.aborted) stop()
    let exit: { code: number | null; signal: NodeJS.Signals | null }
    try { [exit] = await Promise.all([exited, stdout, stderr]) }
    finally { clearTimeout(timer); flight.controller.signal.removeEventListener('abort', abort) }
    let groupGone = !child.pid
    if (child.pid) try { process.kill(-child.pid, 0) } catch (error) { groupGone = (error as NodeJS.ErrnoException).code === 'ESRCH' }
    if (!closed || !stdoutClosed || !stderrClosed || !groupGone) { stop(); flight.physicalFailure = true; retained.add(flight); throw new LocalArtworkNormalizationPhysicalError(processFailure) }
    await current(context, flight.controller.signal)
    if (processFailure !== undefined) throw processFailure
    if (exit.code !== 0 || exit.signal !== null || stopSent) fail('系统未完成此WebP的JPEG兼容副本转换。')
  }
  function normalize(bytes: Uint8Array, context: LocalArtworkNormalizationContext): Promise<NormalizedImportedLocalArtwork> {
    if (closing || context.signal.aborted || !Number.isFinite(context.deadlineAtMs) || performance.now() >= context.deadlineAtMs) return Promise.reject(normalizationExpired())
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 4 || bytes.byteLength > MAX_INPUT_BYTES) return Promise.reject(new LocalArtworkImageError('封面图片必须非空，压缩大小不得超过4 MiB。'))
    const captured = Buffer.from(bytes), webp = captured.toString('latin1', 0, 4) === 'RIFF'
    if (retained.size) return Promise.reject(new Error('封面转换原资源尚未收口，请重新读取。'))
    if (!webp || process.platform !== 'darwin') return Promise.resolve().then(async () => { await current(context); const result = normalizeImportedLocalArtwork(captured, options.decode); await current(context); return result })
    try { webpGeometry(captured) } catch (error) { return Promise.reject(error) }
    if (active.size >= 2) return Promise.reject(new Error('封面转换原资源尚未收口，请重新读取。'))
    const controller = new AbortController(), forward = () => controller.abort(); context.signal.addEventListener('abort', forward, { once: true }); if (context.signal.aborted) forward()
    let work!: Promise<NormalizedImportedLocalArtwork>
    const flight: ConversionFlight = { controller, get work() { return work }, physicalFailure: false }
    work = (async () => { try { return await convert(captured, context, flight) } finally { active.delete(flight); context.signal.removeEventListener('abort', forward) } })()
    active.add(flight); void work.catch(() => {}); return work
  }
  return {
    normalize,
    close(): Promise<void> { if (!closure) { closing = true; for (const flight of active) flight.controller.abort(); closure = Promise.allSettled([...active].map(flight => flight.work)).then(() => { if (retained.size) throw new LocalArtworkNormalizationPhysicalError(new Error('原封面转换资源仍未确认闭口。')) }) } return closure },
    inspect: () => ({ active: active.size, retained: retained.size, closing }),
  }
}
export type LocalArtworkImportNormalizer = ReturnType<typeof createLocalArtworkImportNormalizer>
