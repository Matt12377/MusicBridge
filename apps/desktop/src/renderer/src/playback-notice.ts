import type { PlaybackSnapshot } from '@music-bridge/contracts'

/** 失败反馈不依赖 currentTrack；UNKNOWN 仅提示核对原请求，不鼓励重试或重放。 */
export function playbackFailureNotice(input: {
  ready: boolean
  diagnostics: boolean
  unconfirmed: boolean
  snapshot: (Pick<PlaybackSnapshot, 'state' | 'lastIssue'> & {
    local?: Pick<NonNullable<PlaybackSnapshot['local']>, 'phase' | 'ownership' | 'queue_owner'>
  }) | null | undefined
}): string | undefined {
  if (!input.ready || input.diagnostics || input.unconfirmed || input.snapshot?.state !== 'error') return undefined
  const local = input.snapshot.local
  if (local && (local.phase === 'SUBMISSION_UNKNOWN' || local.ownership === 'UNKNOWN' || local.queue_owner === 'UNKNOWN')) {
    return '播放请求结果尚未确认，请先核对原请求与 Roon 状态；不会重复提交。'
  }
  return input.snapshot.lastIssue?.message || '播放未成功，请查看诊断后重试。'
}
