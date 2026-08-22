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
