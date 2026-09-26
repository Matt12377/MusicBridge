import type {
  PlaybackIssue,
  PlaybackQueueItem,
  PlaybackQueueSnapshot,
  PlaybackSnapshot,
  TrackSummary,
} from '@music-bridge/contracts'

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left === right || (left.length === right.length && left.every((value, index) => value === right[index]))
}

function sameTrack(left: TrackSummary | undefined, right: TrackSummary | undefined): boolean {
  if (left === right) return true
  if (!left || !right) return false
  return left.id === right.id
    && left.title === right.title
    && sameStrings(left.artists, right.artists)
    && left.album === right.album
    && left.durationMs === right.durationMs
    && left.version === right.version
    && left.bitrate === right.bitrate
    && left.format === right.format
    && left.artworkUrl === right.artworkUrl
    && left.artworkReference === right.artworkReference
}

function sameQueueItem(left: PlaybackQueueItem, right: PlaybackQueueItem): boolean {
  return left === right || (left.trackId === right.trackId
    && left.qualityPreference === right.qualityPreference
    && sameTrack(left.track, right.track)
    && left.preferredSource === right.preferredSource
    && left.resolvedSource === right.resolvedSource
    && left.requestedQuality === right.requestedQuality
    && left.actualQuality === right.actualQuality)
}

function sameQueue(left: PlaybackQueueSnapshot, right: PlaybackQueueSnapshot): boolean {
  if (left === right) return true
  if (left.index !== right.index || left.hasNext !== right.hasNext
    || left.hasPrevious !== right.hasPrevious || left.items.length !== right.items.length) return false
  // IPC 会重新序列化队列；逐项比较合同字段，避免每个进度 tick 都生成大 JSON 字符串。
  for (let index = 0; index < left.items.length; index += 1) {
    if (!sameQueueItem(left.items[index]!, right.items[index]!)) return false
  }
  return true
}

function sameIssue(left: PlaybackIssue | undefined, right: PlaybackIssue | undefined): boolean {
  if (left === right) return true
  if (!left || !right) return false
  return left.code === right.code && left.message === right.message
    && left.retryable === right.retryable && left.diagnosticId === right.diagnosticId
    && left.action === right.action
}

/** 保留未变化的低频对象引用，同时让同 ID 的元数据和能力变化正常透出。 */
export function projectPlaybackSnapshot(previous: PlaybackSnapshot | null, incoming: PlaybackSnapshot): PlaybackSnapshot {
  if (!previous) return incoming
  const currentTrack = sameTrack(previous.currentTrack, incoming.currentTrack)
    ? previous.currentTrack : incoming.currentTrack
  const queue = sameQueue(previous.queue, incoming.queue) ? previous.queue : incoming.queue
  const lastIssue = sameIssue(previous.lastIssue, incoming.lastIssue) ? previous.lastIssue : incoming.lastIssue
  const qualityNotice = sameIssue(previous.qualityNotice, incoming.qualityNotice)
    ? previous.qualityNotice : incoming.qualityNotice
  if (previous.state === incoming.state && previous.positionMs === incoming.positionMs
    && previous.source === incoming.source && previous.qualityPreference === incoming.qualityPreference
    && previous.requestedQuality === incoming.requestedQuality && previous.actualQuality === incoming.actualQuality
    && previous.format === incoming.format && previous.bitrate === incoming.bitrate
    && previous.selectedZoneId === incoming.selectedZoneId && previous.lastError === incoming.lastError
    && previous.canNext === incoming.canNext && previous.canPrevious === incoming.canPrevious
    && previous.canStop === incoming.canStop && previous.canPause === incoming.canPause
    && previous.canResume === incoming.canResume && previous.currentTrack === currentTrack
    && previous.queue === queue && previous.lastIssue === lastIssue
    && previous.qualityNotice === qualityNotice) return previous
  return {
    ...incoming,
    ...(currentTrack === undefined ? {} : { currentTrack }),
    queue,
    ...(lastIssue === undefined ? {} : { lastIssue }),
    ...(qualityNotice === undefined ? {} : { qualityNotice }),
  }
}
