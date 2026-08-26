import assert from 'node:assert/strict'
import test from 'node:test'
import type { PlaybackSnapshot } from '@music-bridge/contracts'
import { playbackStateLabel } from '../src/renderer/src/composables/playbackStatus.js'

test('播放状态共享文案覆盖全部公开状态与真实确认过渡态', () => {
  assert.deepEqual(
    [
      playbackStateLabel('idle'),
      playbackStateLabel('resolving'),
      playbackStateLabel('preparing'),
      playbackStateLabel('playing'),
      playbackStateLabel('pausing' as PlaybackSnapshot['state']),
      playbackStateLabel('paused'),
      playbackStateLabel('resuming' as PlaybackSnapshot['state']),
      playbackStateLabel('stopping'),
      playbackStateLabel('error'),
    ],
    ['待机', '正在获取音频', '正在连接 Roon', '正在播放', '正在暂停', '已暂停', '正在恢复', '正在停止', '播放失败'],
  )
  assert.equal(playbackStateLabel(undefined), '待机')
})
