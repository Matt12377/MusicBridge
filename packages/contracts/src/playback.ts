import type { TrackSummary } from './library.js'

export const PLAYBACK_QUALITY_LEVELS = [
  'standard',
  'exhigh',
  'lossless',
  'hires',
] as const

export type PlaybackQuality = (typeof PLAYBACK_QUALITY_LEVELS)[number]

export type PlaybackState =
  | 'idle'
  | 'resolving'
  | 'preparing'
  | 'playing'
  | 'stopping'
  | 'error'

export interface PlaybackQueueItem {
  trackId: string
  quality: PlaybackQuality
}

export interface PlaybackQueueSnapshot {
  items: readonly PlaybackQueueItem[]
  index: number
  hasNext: boolean
  hasPrevious: boolean
}

export interface PlaybackSnapshot {
  state: PlaybackState
  queue: PlaybackQueueSnapshot
  currentTrack?: TrackSummary
  requestedQuality?: PlaybackQuality
  actualQuality?: string
  format?: string
  bitrate?: number
  selectedZoneId?: string
  lastError?: string
  canNext: boolean
  canPrevious: boolean
  canStop: boolean
}
