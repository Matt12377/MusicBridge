import assert from 'node:assert/strict'
import test from 'node:test'
import { playbackStateLabel } from '../src/renderer/src/composables/playbackStatus.js'

test('播放状态共享文案覆盖六种公开状态', () => {
  assert.deepEqual(
    [
      playbackStateLabel('idle'),
      playbackStateLabel('resolving'),
      playbackStateLabel('preparing'),
      playbackStateLabel('playing'),
      playbackStateLabel('stopping'),
      playbackStateLabel('error'),
    ],
    ['待机', '正在获取音频', '正在连接 Roon', '正在播放', '正在停止', '播放失败'],
  )
  assert.equal(playbackStateLabel(undefined), '待机')
})
