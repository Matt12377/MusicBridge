import { noteDesktopArtwork, desktopArtworkStarted, desktopArtworkElapsed } from '../shared/desktop-artwork-trace-node.js'
import { createHash } from 'node:crypto'
import { constants, promises as fs, type BigIntStats } from 'node:fs'
import path from 'node:path'
import { inflateSync } from 'node:zlib'
interface PhotoDecoderImage {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  resize(size: { width: number; height: number; quality: 'best' }): PhotoDecoderImage
  toJPEG(quality: number): Buffer
}
import { getRustMediaWorkerPool, RustMediaWorkerError } from './rust-media-worker.js'
import { logLibraryOperation } from '../shared/library-operation-log.js'
import type { LocalAlbumArtworkGrid } from '@music-bridge/contracts'
import { tiffGeometry, webpGeometry } from './artwork-import-validation.js'
import { LocalArtworkImageError } from './artwork-image-error.js'
export { LocalArtworkImageError } from './artwork-image-error.js'

const MAX_INPUT_BYTES = 4 * 1024 * 1024
const MAX_DIMENSION = 4096
const MAX_PIXELS = 16 * 1024 * 1024
const MAX_DECODED_RGBA_BYTES = 64 * 1024 * 1024
const MAX_METADATA_BYTES = 256 * 1024
const MAX_STRUCTURAL_PARTS = 4096
const MAX_JPEG_SCANS = 128
const MAX_DISPLAY_BYTES = 1024 * 1024
const MAX_DISPLAY_DIMENSION = 1200
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

interface Geometry { width: number; height: number }
interface ImageIdentity extends Geometry { mime: 'image/png' | 'image/jpeg'; bytes: number; sha256: string }
export interface NormalizedLocalArtwork {
  original: ImageIdentity
  display: ImageIdentity & { mime: 'image/jpeg'; dataUrl: string }
}
const fail = (message: string): never => { throw new LocalArtworkImageError(message) }
const invalid = (): never => fail('封面图片结构不完整或格式不受支持，请选择单帧 PNG 或 JPEG。')
const metadataLimit = (): never => fail('封面图片的元数据超过安全预算，请先导出不含多余元数据的副本。')
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** 完整结构预算保留在边界；像素解码、缩放及两种JPEG副本交给常驻Rust进程。 */
export async function normalizeLocalArtworkInWorker(bytes: Uint8Array, signal?: AbortSignal): Promise<{ image: NormalizedLocalArtwork; grid: LocalAlbumArtworkGrid; compatibleOriginalBytes: Uint8Array }> {
  const started = performance.now()
  logLibraryOperation('artwork', 'normalize', 'start', { bytes: bytes.byteLength })
  try {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 4 || bytes.byteLength > MAX_INPUT_BYTES) fail('封面图片必须非空，压缩大小不得超过4 MiB。')
    const input = Buffer.from(bytes)
    const mime = input.subarray(0, 8).equals(PNG_SIGNATURE) ? 'image/png' : input[0] === 255 && input[1] === 216 ? 'image/jpeg'
      : input.toString('latin1', 0, 2) === 'II' || input.toString('latin1', 0, 2) === 'MM' ? 'image/tiff'
        : input.toString('latin1', 0, 4) === 'RIFF' ? 'image/webp' : invalid()
    const declared = mime === 'image/png' ? pngGeometry(input) : mime === 'image/jpeg' ? jpegGeometry(input)
      : mime === 'image/tiff' ? tiffGeometry(input) : webpGeometry(input)
    const result = await getRustMediaWorkerPool().processImage({ bytes: input, maxEdge: MAX_DISPLAY_DIMENSION, maxOutputBytes: 768 * 1024, gridSize: 512 }, signal)
    if (signal?.aborted) throw new RustMediaWorkerError('CANCELLED')
    if (result.original.width !== declared.width || result.original.height !== declared.height || result.original.mime !== mime || !result.grid) fail('封面的实际解码尺寸或格式与来源不一致。')
    const variant = (value: typeof result, edge: number, maximum: number): LocalAlbumArtworkGrid => {
      const encoded = Buffer.from(value.bytes), geometry = jpegGeometry(encoded)
      if (encoded.length > maximum || geometry.width !== value.width || geometry.height !== value.height || Math.max(value.width, value.height) > edge) fail('封面展示副本超过预算或尺寸不一致。')
      return { mime: 'image/jpeg', bytes: encoded.length, sha256: sha256(encoded), ...geometry, dataUrl: `data:image/jpeg;base64,${encoded.toString('base64')}` }
    }
    const display = variant(result, MAX_DISPLAY_DIMENSION, 768 * 1024)
    const grid = variant({ ...result, ...result.grid }, 512, 256 * 1024)
    const converted = mime === 'image/tiff' || mime === 'image/webp'
    const compatible = converted ? result.compatible ? Buffer.from(result.compatible.bytes) : fail('封面缺少已转换的JPEG兼容副本。') : input
    const originalGeometry = converted ? jpegGeometry(compatible) : declared
    const rotated = mime === 'image/tiff' && 'orientation' in declared && Number(declared.orientation) >= 5 && Number(declared.orientation) <= 8
    if (compatible.length > MAX_INPUT_BYTES || converted && (originalGeometry.width !== (rotated ? declared.height : declared.width)
      || originalGeometry.height !== (rotated ? declared.width : declared.height))) fail('封面兼容副本的尺寸或字节预算不一致。')
    logLibraryOperation('artwork', 'normalize', 'complete', { elapsedMs: performance.now() - started, bytes: display.bytes + grid.bytes, width: declared.width, height: declared.height, parseMs: result.performance.parseMs, queueWaitMs: result.performance.queueWaitMs, slowAfterMs: 100 })
    return { image: { original: { mime: converted ? 'image/jpeg' : mime as 'image/png' | 'image/jpeg', bytes: compatible.length, sha256: sha256(compatible), width: originalGeometry.width, height: originalGeometry.height }, display }, grid, compatibleOriginalBytes: compatible }
  } catch (error) {
    logLibraryOperation('artwork', 'normalize', signal?.aborted ? 'cancelled' : 'error', { elapsedMs: performance.now() - started, code: error instanceof RustMediaWorkerError ? error.code : 'INVALID_IMAGE', slowAfterMs: 100 })
    if (error instanceof RustMediaWorkerError && ['PARSE_FAILED', 'BUDGET_EXCEEDED', 'UNSUPPORTED'].includes(error.code)) fail('封面无法完整解码或超过安全预算，请选择另一张本地图片。')
    throw error
  }
}

function checkGeometry(value: Geometry): void {
  const { width, height } = value
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) {
    fail('封面像素过大或尺寸无效，宽高不得超过 4096，像素不得超过 16 Mi。')
  }
  // 解码内存单列预算，不能用压缩字节预算代替；这里不声称限制整个进程的 RSS。
  const rgbaBytes = width * height * 4
  if (!Number.isSafeInteger(rgbaBytes) || rgbaBytes > MAX_DECODED_RGBA_BYTES) fail('封面的解码像素内存超过安全预算。')
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})
function crc32(bytes: Buffer, start: number, end: number): number {
  let value = 0xffffffff
  for (let offset = start; offset < end; offset++) value = crcTable[(value ^ bytes[offset]!) & 255]! ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

/** 元数据解压也受总预算约束，避免小 iCCP/zTXt/iTXt 触发无界展开。 */
function expandedPngMetadata(type: string, body: Buffer, remaining: number): number {
  if (!['iCCP', 'zTXt', 'iTXt'].includes(type)) return 0
  const keywordEnd = body.indexOf(0)
  if (keywordEnd < 1 || keywordEnd > 79 || keywordEnd + 2 >= body.length) return invalid()
  let compressed: Buffer
  if (type === 'iTXt') {
    const flag = body[keywordEnd + 1], method = body[keywordEnd + 2]
    if ((flag !== 0 && flag !== 1) || method !== 0) return invalid()
    const languageEnd = body.indexOf(0, keywordEnd + 3)
    const translatedEnd = languageEnd < 0 ? -1 : body.indexOf(0, languageEnd + 1)
    if (translatedEnd < 0) return invalid()
    if (flag === 0) return 0
    compressed = body.subarray(translatedEnd + 1)
  } else {
    if (body[keywordEnd + 1] !== 0) return invalid()
    compressed = body.subarray(keywordEnd + 2)
  }
  if (!compressed.length) return invalid()
  if (remaining < 1) return metadataLimit()
  try { return inflateSync(compressed, { maxOutputLength: remaining }).length }
  catch { return fail('封面的压缩元数据无效或展开后超过安全预算。') }
}

function pngGeometry(bytes: Buffer): Geometry {
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return invalid()
  let offset = 8, parts = 0, metadataBytes = 0, colorType = -1, bitDepth = 0
  let size: Geometry | undefined, paletteEntries = 0, sawPalette = false, sawTransparency = false
  let sawData = false, dataEnded = false, dataBytes = 0
  while (offset < bytes.length) {
    if (++parts > MAX_STRUCTURAL_PARTS || offset + 12 > bytes.length) return invalid()
    const length = bytes.readUInt32BE(offset), end = offset + 12 + length
    if (end > bytes.length) return invalid()
    const type = bytes.toString('latin1', offset + 4, offset + 8)
    if (!/^[A-Za-z]{4}$/u.test(type) || !/[A-Z]/u.test(type[2]!)) return invalid()
    if (crc32(bytes, offset + 4, end - 4) !== bytes.readUInt32BE(end - 4)) return invalid()
    const body = bytes.subarray(offset + 8, end - 4)
    if (['acTL', 'fcTL', 'fdAT'].includes(type)) fail('封面不支持 APNG 或多帧图片，请选择单帧副本。')
    if (!size && type !== 'IHDR') return invalid()
    if (type === 'IHDR') {
      if (size || parts !== 1 || length !== 13) return invalid()
      size = { width: body.readUInt32BE(0), height: body.readUInt32BE(4) }; checkGeometry(size)
      bitDepth = body[8]!; colorType = body[9]!
      const depths: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }
      if (!depths[colorType]?.includes(bitDepth) || body[10] !== 0 || body[11] !== 0 || ![0, 1].includes(body[12]!)) return invalid()
    } else if (type === 'IDAT') {
      if (dataEnded || (colorType === 3 && !sawPalette)) return invalid()
      sawData = true; dataBytes += length
    } else if (type === 'IEND') {
      if (length !== 0 || !sawData || !dataBytes || end !== bytes.length) return invalid()
      return size!
    } else {
      if (sawData) dataEnded = true
      if (type === 'PLTE') {
        if (sawPalette || sawData || sawTransparency || colorType === 0 || colorType === 4
          || length < 3 || length > 768 || length % 3 !== 0) return invalid()
        paletteEntries = length / 3
        if (colorType === 3 && paletteEntries > 2 ** bitDepth) return invalid()
        sawPalette = true
      } else if (type === 'tRNS') {
        if (sawTransparency || sawData || (colorType === 0 ? length !== 2 : colorType === 2 ? length !== 6
          : colorType === 3 ? !sawPalette || length < 1 || length > paletteEntries : true)) return invalid()
        sawTransparency = true
      } else if (type[0] === type[0]!.toUpperCase()) return invalid()
      metadataBytes += length
      if (metadataBytes > MAX_METADATA_BYTES) return metadataLimit()
      metadataBytes += expandedPngMetadata(type, body, MAX_METADATA_BYTES - metadataBytes)
      if (metadataBytes > MAX_METADATA_BYTES) return metadataLimit()
    }
    offset = end
  }
  return invalid()
}

function jpegGeometry(bytes: Buffer): Geometry {
  if (bytes[0] !== 255 || bytes[1] !== 216) return invalid()
  let offset = 2, parts = 0, scans = 0, metadataBytes = 0, restartInterval = 0
  let size: Geometry | undefined, progressive = false
  const components = new Set<number>(), quantizerReferences = new Set<number>()
  const quantizers = new Set<number>(), huffmanTables = new Set<number>()
  while (offset < bytes.length) {
    if (++parts > MAX_STRUCTURAL_PARTS || bytes[offset++] !== 255) return invalid()
    while (bytes[offset] === 255) offset++
    const marker = bytes[offset++]
    if (marker === undefined || marker === 0 || marker === 216 || (marker >= 208 && marker <= 215)) return invalid()
    if (marker === 217) {
      if (!size || !scans || offset !== bytes.length) return invalid()
      return size
    }
    if (offset + 2 > bytes.length) return invalid()
    const length = bytes.readUInt16BE(offset), end = offset + length
    if (length < 2 || end > bytes.length) return invalid()
    const body = bytes.subarray(offset + 2, end)
    if ([192, 193, 194].includes(marker)) {
      if (size || body.length < 9 || body[0] !== 8 || body[5]! < 1 || body[5]! > 4 || body.length !== 6 + body[5]! * 3) return invalid()
      size = { width: body.readUInt16BE(3), height: body.readUInt16BE(1) }; checkGeometry(size)
      progressive = marker === 194
      for (let at = 6; at < body.length; at += 3) {
        const id = body[at]!, horizontal = body[at + 1]! >>> 4, vertical = body[at + 1]! & 15, quantizer = body[at + 2]!
        if (components.has(id) || horizontal < 1 || horizontal > 4 || vertical < 1 || vertical > 4 || quantizer > 3) return invalid()
        components.add(id); quantizerReferences.add(quantizer)
      }
    } else if (marker === 219) {
      if (!body.length) return invalid()
      for (let at = 0; at < body.length;) {
        const info = body[at++]!, precision = info >>> 4, id = info & 15
        if (precision > 1 || id > 3) return invalid()
        at += precision === 0 ? 64 : 128
        if (at > body.length) return invalid()
        quantizers.add(id)
      }
    } else if (marker === 196) {
      if (!body.length) return invalid()
      for (let at = 0; at < body.length;) {
        const info = body[at++]!
        if ((info >>> 4) > 1 || (info & 15) > 3 || at + 16 > body.length) return invalid()
        let symbols = 0
        for (let index = 0; index < 16; index++) symbols += body[at + index]!
        at += 16
        if (symbols < 1 || symbols > 256 || at + symbols > body.length) return invalid()
        at += symbols; huffmanTables.add(info)
      }
    } else if (marker === 221) {
      if (body.length !== 2) return invalid()
      restartInterval = body.readUInt16BE(0)
    } else if (marker === 218) {
      if (!size || ++scans > MAX_JPEG_SCANS || body.length < 6 || body[0]! < 1
        || body[0]! > components.size || body.length !== 1 + 2 * body[0]! + 3
        || [...quantizerReferences].some(id => !quantizers.has(id))) return invalid()
      const spectralStart = body[body.length - 3]!, spectralEnd = body[body.length - 2]!, approximation = body[body.length - 1]!
      const high = approximation >>> 4, low = approximation & 15
      if (spectralStart > spectralEnd || spectralEnd > 63 || high > 13 || low > 13
        || (!progressive && (spectralStart !== 0 || spectralEnd !== 63 || approximation !== 0))
        || (progressive && ((spectralStart === 0 && spectralEnd !== 0) || (spectralStart > 0 && body[0] !== 1) || (high !== 0 && high !== low + 1)))) return invalid()
      const scanComponents = new Set<number>()
      for (let at = 1; at < body.length - 3; at += 2) {
        const id = body[at]!, dc = body[at + 1]! >>> 4, ac = body[at + 1]! & 15
        if (!components.has(id) || scanComponents.has(id) || dc > 3 || ac > 3
          || (spectralStart === 0 && high === 0 && !huffmanTables.has(dc))
          || ((!progressive || spectralStart > 0) && !huffmanTables.has(16 | ac))) return invalid()
        scanComponents.add(id)
      }
      offset = end
      let entropyBytes = 0, expectedRestart = 0
      while (offset < bytes.length) {
        if (bytes[offset] !== 255) { offset++; entropyBytes++; continue }
        const markerStart = offset
        while (bytes[offset] === 255) offset++
        const next = bytes[offset]
        if (next === undefined) return invalid()
        if (next === 0) {
          if (offset !== markerStart + 1) return invalid()
          offset++; entropyBytes++; continue
        }
        if (next >= 208 && next <= 215) {
          if (!restartInterval || !entropyBytes || next !== 208 + expectedRestart) return invalid()
          expectedRestart = (expectedRestart + 1) % 8; offset++; continue
        }
        offset = markerStart; break
      }
      if (!entropyBytes || offset >= bytes.length) return invalid()
      continue
    } else if ((marker >= 224 && marker <= 239) || marker === 254) {
      if (marker === 226 && body.subarray(0, 4).equals(Buffer.from('MPF\0', 'ascii'))) fail('封面不支持 MPO 多图文件，请选择单张 JPEG。')
      metadataBytes += body.length
      if (metadataBytes > MAX_METADATA_BYTES) return metadataLimit()
    } else return invalid()
    offset = end
  }
  return invalid()
}

/** 可信 Main 的 nativeImage 适配器入口；结构校验和注入 fake 不等于真实 native 解码证据。 */
export function normalizeLocalArtwork(bytes: Uint8Array, decode: (bytes: Buffer) => PhotoDecoderImage): NormalizedLocalArtwork {
  const started = desktopArtworkStarted(); noteDesktopArtwork('normalize', null, {}, 'main')
  try {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 4 || bytes.byteLength > MAX_INPUT_BYTES) fail('封面图片必须非空，压缩大小不得超过 4 MiB。')
    const input = Buffer.from(bytes)
    const mime = input.subarray(0, 8).equals(PNG_SIGNATURE) ? 'image/png' : input[0] === 255 && input[1] === 216 ? 'image/jpeg' : invalid()
    const declared = mime === 'image/png' ? pngGeometry(input) : jpegGeometry(input)
    const original: ImageIdentity = { mime, bytes: input.length, sha256: sha256(input), ...declared }
    const decodeStarted = desktopArtworkStarted()
    noteDesktopArtwork('native-decode', original.sha256, {}, 'main')
    const image = decode(input)
    noteDesktopArtwork('native-decode', original.sha256, { count: 0, elapsedMs: desktopArtworkElapsed(decodeStarted) }, 'main')
    if (image.isEmpty()) fail('无法完整解码封面图片，请换一张图片。')
    const decoded = image.getSize(); checkGeometry(decoded)
    if (decoded.width !== declared.width || decoded.height !== declared.height) fail('封面的实际解码尺寸与文件声明不一致。')
    const scale = Math.min(1, MAX_DISPLAY_DIMENSION / Math.max(decoded.width, decoded.height))
    const size = { width: Math.max(1, Math.round(decoded.width * scale)), height: Math.max(1, Math.round(decoded.height * scale)) }
    const displayImage = scale < 1 ? image.resize({ ...size, quality: 'best' }) : image
    if (displayImage.isEmpty()) fail('封面展示副本缩放失败。')
    const displayed = displayImage.getSize()
    if (displayed.width !== size.width || displayed.height !== size.height) fail('封面展示副本的尺寸不一致。')
    const encoded = displayImage.toJPEG(85)
    if (!Buffer.isBuffer(encoded) || encoded.length < 4 || encoded.length > MAX_DISPLAY_BYTES) fail('封面展示副本无效或超过 1 MiB。')
    const displayGeometry = jpegGeometry(encoded)
    if (displayGeometry.width !== size.width || displayGeometry.height !== size.height) fail('封面展示副本的编码尺寸不一致。')
    noteDesktopArtwork('normalize', original.sha256, { count: 0, elapsedMs: desktopArtworkElapsed(started), bytes: encoded.length, decodedBytes: decoded.width * decoded.height * 4 }, 'main')
    return { original, display: { mime: 'image/jpeg', bytes: encoded.length, sha256: sha256(encoded), ...size, dataUrl: `data:image/jpeg;base64,${encoded.toString('base64')}` } }
  } catch (error) {
    noteDesktopArtwork('normalize', null, { count: 0, elapsedMs: desktopArtworkElapsed(started), reason: 'error' }, 'main')
    if (error instanceof LocalArtworkImageError) throw error
    return fail('封面解码或生成展示副本失败，请换一张 PNG 或 JPEG 图片。')
  }
}

function sameFile(before: BigIntStats, after: BigIntStats): boolean {
  return after.isFile() && !after.isSymbolicLink() && before.dev === after.dev && before.ino === after.ino
    && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs
}

/** 仅用于可信原生 picker 或已限定的 Owner 发现；不得直接接收 Renderer 任意路径。 */
export async function readLocalArtworkFile(absolutePath: string): Promise<Uint8Array> {
  const started = performance.now()
  logLibraryOperation('artwork', 'manual.read', 'start')
  try {
    if (typeof absolutePath !== 'string' || !path.isAbsolute(absolutePath) || absolutePath.includes('\0')) fail('请选择有效的本地封面文件。')
    const selected = await fs.lstat(absolutePath, { bigint: true })
    if (!selected.isFile() || selected.isSymbolicLink() || selected.size < 4n || selected.size > BigInt(MAX_INPUT_BYTES)) fail('封面必须是普通文件，大小不超过 4 MiB。')
    const handle = await fs.open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const before = await handle.stat({ bigint: true })
      if (!sameFile(selected, before)) fail('封面在读取前发生变化，请重新选择。')
      const expected = Number(before.size), buffer = Buffer.alloc(expected + 1)
      let total = 0
      while (total < buffer.length) {
        const result = await handle.read(buffer, total, buffer.length - total, total)
        if (!result.bytesRead) break
        total += result.bytesRead
      }
      const after = await handle.stat({ bigint: true })
      if (total !== expected || !sameFile(before, after)) fail('封面在读取时发生变化，请重新选择。')
      const current = await fs.lstat(absolutePath, { bigint: true })
      if (!sameFile(before, current)) fail('封面的位置或内容已变化，请重新选择。')
      logLibraryOperation('artwork', 'manual.read', 'complete', { bytes: total, elapsedMs: performance.now() - started, slowAfterMs: 100 })
      return buffer.subarray(0, total)
    } finally { await handle.close() }
  } catch (error) {
    logLibraryOperation('artwork', 'manual.read', 'error', { elapsedMs: performance.now() - started, code: 'SOURCE_READ_FAILED', slowAfterMs: 100 })
    if (error instanceof LocalArtworkImageError) throw error
    return fail('无法安全读取封面文件，请重新选择；原文件未被修改。')
  }
}
