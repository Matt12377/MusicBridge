import type { PageRequest, PlaylistSummary, TrackSummary } from '@music-bridge/contracts'

export const HOME_RECOMMENDATION_PAGE_SIZE = 12
export const HOME_RECOMMENDATION_PLAYLIST_SAMPLE_SIZE = 4
export const HOME_RECOMMENDATION_TRACK_LIMIT = 24

export type HomeRecommendationState = 'loading' | 'ready' | 'error'

export interface HomePlaylistPageSelection {
  playlistId: string
  page: PageRequest
}

function randomIndex(length: number, random: () => number): number {
  if (length <= 1) return 0
  return Math.min(length - 1, Math.max(0, Math.floor(random() * length)))
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const result = [...items]
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = randomIndex(index + 1, random)
    const current = result[index]
    result[index] = result[swapIndex] as T
    result[swapIndex] = current as T
  }
  return result
}

export function selectRandomPlaylistPages(
  playlists: readonly PlaylistSummary[],
  sampleSize = HOME_RECOMMENDATION_PLAYLIST_SAMPLE_SIZE,
  pageSize = HOME_RECOMMENDATION_PAGE_SIZE,
  random: () => number = Math.random,
): HomePlaylistPageSelection[] {
  return shuffled(
    playlists.filter((playlist) => playlist.trackCount > 0),
    random,
  )
    .slice(0, Math.max(0, sampleSize))
    .map((playlist) => {
      const maxOffset = Math.max(0, playlist.trackCount - pageSize)
      return {
        playlistId: playlist.id,
        page: {
          offset: randomIndex(maxOffset + 1, random),
          limit: pageSize,
        },
      }
    })
}

export function shuffleTracks(
  tracks: readonly TrackSummary[],
  limit = HOME_RECOMMENDATION_TRACK_LIMIT,
  random: () => number = Math.random,
): TrackSummary[] {
  const uniqueTracks = [...new Map(tracks.map((track) => [track.id, track])).values()]
  return shuffled(uniqueTracks, random).slice(0, Math.max(0, limit))
}
