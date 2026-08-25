import type { RoonImageResult, RoonImageShapeSummary } from '@music-bridge/contracts'

export function summarizePreloadRoonImage(
  result: RoonImageResult,
): RoonImageShapeSummary {
  const body = result.body
  const bodyType = body?.constructor?.name ?? typeof body
  const magic8 = Array.from(
    body.subarray(0, 8),
    (value) => value.toString(16).padStart(2, '0'),
  ).join('')
  const jpeg = body.byteLength >= 3
    && body[0] === 0xff
    && body[1] === 0xd8
    && body[2] === 0xff
  const png = body.byteLength >= 8
    && body[0] === 0x89
    && body[1] === 0x50
    && body[2] === 0x4e
    && body[3] === 0x47
    && body[4] === 0x0d
    && body[5] === 0x0a
    && body[6] === 0x1a
    && body[7] === 0x0a
  return {
    layer: 'preload',
    contentType: result.contentType,
    byteLength: body.byteLength,
    magic8,
    bodyType,
    isBuffer: bodyType === 'Buffer',
    isUint8Array: body instanceof Uint8Array,
    isArrayBuffer: body instanceof ArrayBuffer,
    valid: body.byteLength > 0
      && body.byteLength <= 4 * 1024 * 1024
      && ((result.contentType === 'image/jpeg' && jpeg)
        || (result.contentType === 'image/png' && png)),
  }
}
