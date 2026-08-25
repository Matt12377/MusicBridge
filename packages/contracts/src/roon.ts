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
