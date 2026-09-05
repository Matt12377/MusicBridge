import assert from 'node:assert/strict'
import test from 'node:test'
import { qualityDetails, playbackPosition, formatPlaybackTime } from '../src/renderer/src/components/player/details.js'
test('真实音质仅来自实际返回值，不从偏好或码率猜采样率', () => {
 assert.equal(qualityDetails({ actualQuality: 'lossless', format: 'flac', bitrate: 1411200 }), '无损 · FLAC · 1,411 kbps')
 assert.equal(qualityDetails({ actualQuality: 'unknown' }), '音质未知')
 assert.equal(qualityDetails({ format: 'mp3' }), 'MP3')
})
test('进度插值在暂停时固定，播放到总时长后停止增长', () => {
 assert.equal(playbackPosition(2000, 3000, 4000, true), 4000)
 assert.equal(playbackPosition(2000, 3000, 4000, false), 2000)
 assert.equal(playbackPosition(-10, 20, 0, true), 0)
 assert.equal(formatPlaybackTime(65000), '1:05')
})
