export type FavoriteKind = 'track' | 'album' | 'artist'

export interface FavoriteEntityDescriptor {
  kind: FavoriteKind
  title: string
  subtitle?: string
  artist?: string
  album?: string
  durationMs?: number
  trackNumber?: number
  discNumber?: number
  year?: number
  version?: string
}

export interface FavoriteRecord extends FavoriteEntityDescriptor {
  favoriteId: string
  createdAt: number
  updatedAt: number
}

export interface FavoritePage {
  items: readonly FavoriteRecord[]
  offset: number
  limit: number
  total: number
  hasMore: boolean
}
