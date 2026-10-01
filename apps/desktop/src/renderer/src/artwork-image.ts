/** 私有图片几何与实际浏览器解码预算；导入时不访问window/Image。 */
export interface ArtworkGeometry { width: number; height: number; rgbaBytes: number }
export type ArtworkPriority = 'visible' | 'playing'
export function artworkError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}
function geometry(width: number, height: number): ArtworkGeometry {
  const rgbaBytes = width * height * 4
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || !Number.isSafeInteger(rgbaBytes)) {
    throw artworkError('ROON_IMAGE_DECODE_FAILED', '封面编码尺寸无效')
  }
  return { width, height, rgbaBytes }
}
export function readArtworkGeometry(body: Uint8Array, contentType: string): ArtworkGeometry {
  const invalid = () => artworkError('ROON_IMAGE_DECODE_FAILED', '封面未提供合法编码尺寸')
  if (contentType === 'image/png') {
    if (body.length < 33 || body[0] !== 137 || body[1] !== 80 || body[2] !== 78 || body[3] !== 71 || body[4] !== 13 || body[5] !== 10 || body[6] !== 26 || body[7] !== 10) throw invalid()
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
    if (view.getUint32(8) !== 13 || body[12] !== 73 || body[13] !== 72 || body[14] !== 68 || body[15] !== 82) throw invalid()
    return geometry(view.getUint32(16), view.getUint32(20))
  }
  if (contentType !== 'image/jpeg' || body[0] !== 255 || body[1] !== 216) throw invalid()
  let offset = 2
  while (offset < body.length) {
    if (body[offset++] !== 255) throw invalid()
    while (body[offset] === 255) offset++
    const marker = body[offset++]
    if (marker === undefined || marker === 0 || marker === 217 || marker === 218) throw invalid()
    if (marker === 216 || marker === 1 || (marker >= 208 && marker <= 215)) continue
    if (offset + 2 > body.length) throw invalid()
    const length = body[offset]! * 256 + body[offset + 1]!
    if (length < 2 || offset + length > body.length) throw invalid()
    if ([192, 193, 194].includes(marker)) {
      if (length < 8 || body[offset + 2] !== 8) throw invalid()
      const components = body[offset + 7]!
      if (components < 1 || components > 4 || length !== 8 + components * 3) throw invalid()
      return geometry(body[offset + 5]! * 256 + body[offset + 6]!, body[offset + 3]! * 256 + body[offset + 4]!)
    }
    offset += length
  }
  throw invalid()
}

let actualDecode = 0, actualVisibleDecode = 0
export function inspectActualArtworkDecode(): number { return actualDecode }
/** 返回真实decode Promise；调用者的本地取消/timeout不能提前归还此槽。 */
export async function decodeArtworkUrl(url: string, priority: ArtworkPriority = 'visible'): Promise<ArtworkGeometry> {
  if (actualDecode >= 32 || (priority === 'visible' && actualVisibleDecode >= 30)) throw artworkError('ARTWORK_BUSY', '封面解码繁忙，请重试')
  actualDecode++; if (priority === 'visible') actualVisibleDecode++
  try {
    const image = new Image()
    image.decoding = 'async'
    image.src = url
    await image.decode()
    return geometry(image.naturalWidth, image.naturalHeight)
  } finally {
    actualDecode--; if (priority === 'visible') actualVisibleDecode--
  }
}
