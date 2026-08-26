import {
  roonTrackIdFromReference,
  type PlaybackQualityPreference,
  type PlaybackSnapshot,
  type RoonLibraryItem,
  type TrackSummary,
} from '@music-bridge/contracts'

function trackSummary(item: RoonLibraryItem): TrackSummary {
  return {
    id: roonTrackIdFromReference(item.reference),
    title: item.title,
    artists: [item.artist ?? item.subtitle ?? 'Roon Library'],
    album: item.album ?? 'Roon Library',
    ...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {}),
    ...(item.bitrate !== undefined ? { bitrate: item.bitrate } : {}),
    ...(item.format !== undefined ? { format: item.format } : {}),
    ...(item.artworkReference !== undefined
      ? { artworkReference: item.artworkReference }
      : {}),
  }
}

export function createOptimisticRoonPlayback(
  item: RoonLibraryItem,
  zoneId: string,
  qualityPreference: PlaybackQualityPreference = 'auto',
): PlaybackSnapshot {
  const track = trackSummary(item)
  return {
    state: 'resolving',
    queue: {
      items: [{
        trackId: track.id,
        track,
        qualityPreference,
        preferredSource: 'roon',
        resolvedSource: 'roon',
        actualQuality: 'unknown',
      }],
      index: 0,
      hasNext: false,
      hasPrevious: false,
    },
    currentTrack: track,
    source: 'roon',
    qualityPreference,
    actualQuality: 'unknown',
    positionMs: 0,
    selectedZoneId: zoneId,
    canNext: false,
    canPrevious: false,
    canStop: false,
    canPause: false,
    canResume: false,
  }
}
