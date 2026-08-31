import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import path from 'node:path'
import { isCollectionPhotoImage, MAX_COLLECTION_PHOTO_BYTES, type CollectionPhotoImage } from '@music-bridge/contracts'

export interface PhotoDecoderImage {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  resize(size: { width: number; height: number; quality: 'best' }): PhotoDecoderImage
  toJPEG(quality: number): Buffer
}
export class CollectionPhotoImportError extends Error {}
const fail = (message: string): never => { throw new CollectionPhotoImportError(message) }
const maxInputBytes = 25 * 1024 * 1024

function dimensions(bytes: Buffer, extension: string): { width: number; height: number } {
  if (extension === '.png' && bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR') {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  }
  if (['.jpg', '.jpeg'].includes(extension) && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) break
      while (bytes[offset] === 0xff) offset++
      const marker = bytes[offset++]!
      if (marker === 0xda || marker === 0xd9) break
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
      if (offset + 2 > bytes.length) break
      const size = bytes.readUInt16BE(offset)
      if (size < 2 || offset + size > bytes.length) break
      if ([0xc0, 0xc1, 0xc2].includes(marker) && size >= 8) return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) }
      offset += size
    }
  }
  return fail('请选择有效的 PNG 或 JPEG 照片。')
}
function validSize(size: { width: number; height: number }): boolean {
  return Number.isSafeInteger(size.width) && Number.isSafeInteger(size.height) && size.width > 0 && size.height > 0
    && size.width <= 16000 && size.height <= 16000 && size.width * size.height <= 40_000_000
}

export async function pickCollectionPhoto(
  select: () => Promise<{ canceled: boolean; filePaths: string[] }>,
  decode: (buffer: Buffer) => PhotoDecoderImage,
): Promise<CollectionPhotoImage | null> {
  try {
    const selected = await select()
    if (selected.canceled) return null
    if (selected.filePaths.length !== 1) return fail('请每次选择一张实物照片。')
    const filePath = selected.filePaths[0]!
    const original = await lstat(filePath)
    if (!original.isFile() || original.isSymbolicLink() || original.size < 4 || original.size > maxInputBytes) return fail('照片必须是普通文件，大小不超过 25 MB。')
    const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    let bytes: Buffer
    try {
      const before = await handle.stat()
      if (!before.isFile() || before.ino !== original.ino || before.dev !== original.dev || before.size !== original.size) return fail('照片在读取前发生变化，请重新选择。')
      const buffer = Buffer.alloc(before.size + 1)
      let total = 0
      while (total < buffer.length) {
        const read = await handle.read(buffer, total, buffer.length - total, total)
        if (!read.bytesRead) break
        total += read.bytesRead
      }
      const after = await handle.stat()
      if (total !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) return fail('照片在读取时发生变化，请重新选择。')
      bytes = buffer.subarray(0, total)
    } finally { await handle.close() }
    const declared = dimensions(bytes, path.extname(filePath).toLowerCase())
    if (!validSize(declared)) return fail('照片像素过大，请选择不超过 4000 万像素的图片。')
    const originalImage = decode(bytes)
    if (originalImage.isEmpty()) return fail('无法解码所选照片，请换一张图片。')
    const decoded = originalImage.getSize()
    if (!validSize(decoded)) return fail('照片像素过大。')
    // 等比例重编码应用副本，不裁剪、不修改来源文件，也不保留来源 EXIF。
    const scale = Math.min(1, 1200 / Math.max(decoded.width, decoded.height))
    const size = { width: Math.max(1, Math.round(decoded.width * scale)), height: Math.max(1, Math.round(decoded.height * scale)) }
    const image = scale < 1 ? originalImage.resize({ ...size, quality: 'best' }) : originalImage
    const output = image.toJPEG(85)
    if (output.length > MAX_COLLECTION_PHOTO_BYTES) return fail('展示副本仍然过大，请先缩小照片再导入。')
    const result = { ...size, dataUrl: `data:image/jpeg;base64,${output.toString('base64')}` }
    if (!isCollectionPhotoImage(result)) return fail('照片转换失败，请换一张图片。')
    return result
  } catch (error) {
    if (error instanceof CollectionPhotoImportError) throw error
    return fail('无法读取所选照片，请重新选择；原文件未被修改。')
  }
}
