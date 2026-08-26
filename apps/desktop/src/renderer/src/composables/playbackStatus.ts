import type { PlaybackSnapshot } from '@music-bridge/contracts'

const PLAYBACK_STATE_LABELS: Record<PlaybackSnapshot['state'], string> = {
  idle: '待机',
  resolving: '正在获取音频',
  preparing: '正在连接 Roon',
  playing: '正在播放',
  pausing: '正在暂停',
  paused: '已暂停',
  resuming: '正在恢复',
  stopping: '正在停止',
  error: '播放失败',
}

export function playbackStateLabel(state: PlaybackSnapshot['state'] | undefined): string {
  return PLAYBACK_STATE_LABELS[state ?? 'idle']
}
