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
