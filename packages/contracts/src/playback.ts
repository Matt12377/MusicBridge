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

export const PLAYBACK_ISSUE_CODES = [
  'AUTH_REQUIRED',
  'AUTH_EXPIRED',
  'TRACK_UNAVAILABLE',
  'TRACK_PREVIEW_ONLY',
  'STREAM_URL_EXPIRED',
  'UPSTREAM_HTTP_ERROR',
  'ROON_NOT_PAIRED',
  'ROON_ZONE_NOT_SELECTED',
  'ROON_ZONE_LOST',
  'ROON_MEDIA_ERROR',
  'ROON_TIMEOUT',
  'GATEWAY_NOT_REACHABLE',
  'INTERNAL_ERROR',
  'QUALITY_DOWNGRADED',
] as const

export type PlaybackIssueCode = (typeof PLAYBACK_ISSUE_CODES)[number]

export type PlaybackRecoveryAction =
  | 'reauthenticate'
  | 'retry'
  | 'select_zone'
  | 'restart_core'
  | 'none'

export interface PlaybackIssue {
  code: PlaybackIssueCode
  message: string
  retryable: boolean
  diagnosticId: string
  action?: PlaybackRecoveryAction
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
  lastIssue?: PlaybackIssue
  qualityNotice?: PlaybackIssue
  canNext: boolean
  canPrevious: boolean
  canStop: boolean
}
