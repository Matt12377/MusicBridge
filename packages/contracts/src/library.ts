export interface PageRequest {
  offset: number
  limit: number
}

export interface Page<T> {
  items: readonly T[]
  offset: number
  limit: number
  total: number
  hasMore: boolean
}

export interface TrackSummary {
  id: string
  title: string
  artists: readonly string[]
  album: string
  durationMs?: number
  artworkUrl?: string
}

export interface ArtistSummary {
  id: string
  name: string
  artworkUrl?: string
  albumCount?: number
  trackCount?: number
}

export interface AlbumSummary {
  id: string
  name: string
  artistId?: string
  artistName: string
  artworkUrl?: string
  trackCount?: number
}

export interface ArtistDetail extends ArtistSummary {
  tracks: Page<TrackSummary>
}

export interface AlbumDetail extends AlbumSummary {
  tracks: Page<TrackSummary>
}

export interface SearchSnapshot {
  query: string
  artists: Page<ArtistSummary>
  tracks: Page<TrackSummary>
  albums: Page<AlbumSummary>
}

export interface DailyRecommendationTrack extends TrackSummary {
  recommendationReason?: string
}

export interface DailyRecommendationsSnapshot {
  dayKey: string
  tracks: readonly DailyRecommendationTrack[]
}

export interface PlaylistSummary {
  id: string
  name: string
  trackCount: number
  artworkUrl?: string
}

export interface PlaylistDetail extends PlaylistSummary {
  description?: string
  tracks: Page<TrackSummary>
}
