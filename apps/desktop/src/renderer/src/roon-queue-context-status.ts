import type { PlaybackQueueSnapshot } from '@music-bridge/contracts'

/** 后台读取状态不改变当前曲目的播放状态或控制能力。 */
export function roonQueueContextStatus(context: PlaybackQueueSnapshot['context']): string | undefined {
  if (!context) return undefined
  if (context.loading) return '正在读取邻近曲目…'
  if (context.error === 'retryable') return '邻近曲目读取失败，可在切歌时重试。'
  if (context.error === 'expired') return '队列上下文已过期，请返回列表重新选择。'
  if (context.error === 'capacity') return '队列达到容量限制，请选择较小的歌单。'
  if (!context.afterComplete) return '后续曲目尚未读取，切歌时继续加载。'
  if (!context.beforeComplete) return '前面的曲目尚未读取，上一首时继续加载。'
  return undefined
}
