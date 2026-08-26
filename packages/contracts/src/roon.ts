export type RoonLibraryKind =
  | 'album'
  | 'artist'
  | 'genre'
  | 'playlist'
  | 'composer'
  | 'track'

/**
 * 运行期作用域引用；它不是 Roon 的 item_key，禁止持久化为实体永久 ID。
 */
export interface RoonLibraryItem {
  reference: string
  kind: RoonLibraryKind
  title: string
  subtitle?: string
  artist?: string
  album?: string
  durationMs?: number
  trackNumber?: number
  discNumber?: number
  year?: number
  version?: string
  artworkReference?: string
}

const ROON_ENTITY_REFERENCE_PATTERN =
  /^musicbridge-v2-entity-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u

/**
 * 将运行期实体 UUID 投影成 V1 合同要求的纯数字 Track ID。
 * 保留完整 128 位空间，避免旧 32 位哈希在大型曲库中碰撞。
 */
export function roonTrackIdFromReference(reference: string): string {
  const match = ROON_ENTITY_REFERENCE_PATTERN.exec(reference)
  if (!match?.[1]) throw new TypeError('Roon entity reference is invalid')
  const value = BigInt(`0x${match[1].replaceAll('-', '')}`)
  return value === 0n ? '1' : value.toString(10)
}

export interface RoonLibraryPage {
  items: readonly RoonLibraryItem[]
  offset: number
  limit: number
  total?: number
  hasMore?: boolean
}

export type RoonImageScale = 'fit' | 'fill' | 'stretch'
export type RoonImageFormat = 'image/jpeg' | 'image/png'

export const MAX_ROON_IMAGE_BYTES = 4 * 1024 * 1024

export type RoonImageShapeLayer =
  | 'roon-callback'
  | 'bridge-core-output'
  | 'main-ipc'
  | 'preload'
  | 'renderer-blob'

export interface RoonImageShapeSummary {
  layer: RoonImageShapeLayer
  contentType?: string
  byteLength: number
  magic8: string
  bodyType: string
  isBuffer: boolean
  isUint8Array: boolean
  isArrayBuffer: boolean
  valid: boolean
}

export interface RoonImageOptions {
  scale?: RoonImageScale
  width?: number
  height?: number
  format?: RoonImageFormat
}

export interface RoonImageResult {
  contentType: string
  body: Uint8Array
}

function bytesForShape(body: unknown): Uint8Array | undefined {
  if (body instanceof Uint8Array) return body
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  return undefined
}

export function roonImageMagic8(body: Uint8Array): string {
  return Array.from(body.subarray(0, 8), (value) => value.toString(16).padStart(2, '0')).join('')
}

export function roonImageContentTypeFromMagic(body: Uint8Array): RoonImageFormat | undefined {
  if (body.byteLength >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    body.byteLength >= 8
    && body[0] === 0x89
    && body[1] === 0x50
    && body[2] === 0x4e
    && body[3] === 0x47
    && body[4] === 0x0d
    && body[5] === 0x0a
    && body[6] === 0x1a
    && body[7] === 0x0a
  ) {
    return 'image/png'
  }
  return undefined
}

export function isValidRoonImageBinary(
  contentType: unknown,
  body: unknown,
): body is Uint8Array {
  return (
    (contentType === 'image/jpeg' || contentType === 'image/png')
    && body instanceof Uint8Array
    && body.byteLength > 0
    && body.byteLength <= MAX_ROON_IMAGE_BYTES
    && roonImageContentTypeFromMagic(body) === contentType
  )
}

export function summarizeRoonImageBinary(
  layer: RoonImageShapeLayer,
  contentType: unknown,
  body: unknown,
): RoonImageShapeSummary {
  const bytes = bytesForShape(body)
  const bodyType = body && typeof body === 'object'
    ? (body as { constructor?: { name?: unknown } }).constructor?.name
    : undefined
  const normalizedBodyType = typeof bodyType === 'string' && bodyType.length <= 64
    ? bodyType
    : typeof body
  return {
    layer,
    ...(typeof contentType === 'string' && contentType.length <= 128 ? { contentType } : {}),
    byteLength: bytes?.byteLength ?? 0,
    magic8: bytes ? roonImageMagic8(bytes) : '',
    bodyType: normalizedBodyType,
    isBuffer: normalizedBodyType === 'Buffer' && body instanceof Uint8Array,
    isUint8Array: body instanceof Uint8Array,
    isArrayBuffer: body instanceof ArrayBuffer,
    valid: bytes !== undefined
      && bytes.byteLength > 0
      && bytes.byteLength <= MAX_ROON_IMAGE_BYTES
      && roonImageContentTypeFromMagic(bytes) === contentType,
  }
}
