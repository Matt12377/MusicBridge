import type { TrackSummary } from '@music-bridge/contracts'
import type { LyricsCandidate } from './types.js'

export function toUniqueLyricsCandidates(tracks: readonly TrackSummary[]): readonly LyricsCandidate[] {
  const byId = new Map<string, TrackSummary>()
  for (const track of [...tracks].sort((a, b) => a.id.localeCompare(b.id, 'en'))) {
    if (!byId.has(track.id)) byId.set(track.id, track)
  }
  return [...byId.values()].map((track) => ({
    trackId: track.id,
    title: track.title,
    artists: [...track.artists],
    album: track.album,
    ...(track.durationMs === undefined ? {} : { durationMs: track.durationMs }),
  }))
}
