import type { TrackSummary } from './library.js'
import type { RoonLibraryItem } from './roon.js'

export const PLAYBACK_QUALITY_LEVELS = [
  'standard',
  'exhigh',
  'lossless',
  'hires',
] as const

export type PlaybackQuality = (typeof PLAYBACK_QUALITY_LEVELS)[number]

export const PLAYBACK_QUALITY_PREFERENCES = [
  'auto',
  ...PLAYBACK_QUALITY_LEVELS,
] as const

export type PlaybackQualityPreference = (typeof PLAYBACK_QUALITY_PREFERENCES)[number]
export type PlaybackActualQuality = PlaybackQuality | 'unknown'

/** Queue is filled in bounded pages; this is a safety ceiling, not a collection-page cap. */
export const MAX_PLAYBACK_QUEUE_ITEMS = 5_000

export const PLAYBACK_SOURCE_PREFERENCES = ['smart', 'netease', 'roon'] as const
export type PlaybackSourcePreference = (typeof PLAYBACK_SOURCE_PREFERENCES)[number]
export type PlaybackResolvedSource = Exclude<PlaybackSourcePreference, 'smart'>

export type PlaybackState =
  | 'idle'
  | 'resolving'
  | 'preparing'
  | 'playing'
  | 'pausing'
  | 'paused'
  | 'resuming'
  | 'stopping'
  | 'error'

export interface PlaybackQueueRequestItem {
  trackId: string
  qualityPreference: PlaybackQualityPreference
  /** 入队时的来源偏好；省略时保持现有网易云队列语义。 */
  preferredSource?: PlaybackSourcePreference
}

export interface PlaybackQueueEntry {
  trackId: string
  qualityPreference: PlaybackQualityPreference
  track?: TrackSummary
  preferredSource?: PlaybackSourcePreference
  /** 曲目真正开始后锁定的来源；后台匹配不能改变当前项。 */
  resolvedSource?: PlaybackResolvedSource
  requestedQuality?: PlaybackQuality
  actualQuality?: PlaybackActualQuality
  /** 仅响应的可信Roon曲目，供后台补页后的收藏与重播使用。 */
  roonItem?: RoonLibraryItem
}

/** @deprecated 新代码使用 PlaybackQueueEntry；此别名只保留公开快照命名兼容。 */
export type PlaybackQueueItem = PlaybackQueueEntry

export interface PlaybackQueueSnapshot {
  items: readonly PlaybackQueueItem[]
  index: number
  hasNext: boolean
  hasPrevious: boolean
  context?: {
    beforeComplete: boolean
    afterComplete: boolean
    loading: boolean
    error?: 'retryable' | 'expired' | 'capacity'
  }
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
  /** 仅紧凑事件模式响应；请求不能注入。 */
  stream?: PlaybackStreamStamp
  state: PlaybackState
  queue: PlaybackQueueSnapshot
  currentTrack?: TrackSummary
  source?: PlaybackResolvedSource
  qualityPreference?: PlaybackQualityPreference
  requestedQuality?: PlaybackQuality
  actualQuality?: PlaybackActualQuality
  positionMs: number
  format?: string
  bitrate?: number
  selectedZoneId?: string
  lastError?: string
  lastIssue?: PlaybackIssue
  qualityNotice?: PlaybackIssue
  canNext: boolean
  canPrevious: boolean
  canStop: boolean
  canPause: boolean
  canResume: boolean
}

export type PlaybackEventProtocol = 'compact-v1'

export interface PlaybackEventProtocolAck {
  protocol: PlaybackEventProtocol
  coreInstanceId: string
}

/** 同一Core实例的出版序号跨播放所有者单调递增。 */
export interface PlaybackStreamStamp {
  coreInstanceId: string
  generation: number
  sequence: number
  queueRevision: number
  selectedZoneId: string | null
  trackId: string | null
  source: PlaybackResolvedSource | null
}

export interface PlaybackStreamSnapshot {
  stamp: PlaybackStreamStamp
  snapshot: Omit<PlaybackSnapshot, 'stream'>
}

export type PlaybackStateProjection = Omit<PlaybackSnapshot, 'queue' | 'stream'>

export interface PlaybackStreamState {
  stamp: PlaybackStreamStamp
  state: PlaybackStateProjection
  queue?: PlaybackQueueSnapshot
}

export interface PlaybackStreamProgress {
  stamp: PlaybackStreamStamp
  positionMs: number
}
