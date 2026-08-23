import assert from 'node:assert/strict'
import test from 'node:test'

import type { PlaybackSnapshot, PublicBridgeState } from '@music-bridge/contracts'

import {
  buildTrayPresentation,
  shouldHideWindowOnClose,
  TRAY_ACTION_LABELS,
} from '../src/main/tray.js'

const bridge: PublicBridgeState = {
  runtime: 'ready',
  roon: 'ready',
  provider: 'configured',
  activeStreamCount: 1,
  activePlaybackPresent: true,
}

const playback: PlaybackSnapshot = {
  state: 'playing',
  queue: {
    items: [{ trackId: 'internal-track-id', qualityPreference: 'lossless' }],
    index: 0,
    hasNext: false,
    hasPrevious: false,
  },
  currentTrack: {
    id: 'internal-track-id',
    title: 'Synthetic title',
    artists: ['Synthetic artist'],
    album: 'Synthetic album',
    artworkUrl: 'https://provider.invalid/artwork.jpg?token=secret',
  },
  positionMs: 0,
  canNext: false,
  canPrevious: false,
  canStop: true,
}

test('托盘展示只包含允许的公共摘要和状态', () => {
  const presentation = buildTrayPresentation({ bridge, playback })

  assert.deepEqual(presentation.actionLabels, TRAY_ACTION_LABELS)
  assert.match(presentation.trackLabel, /Synthetic title/)
  assert.match(presentation.trackLabel, /Synthetic artist/)
  assert.match(presentation.statusLabel, /Bridge: ready/)
  assert.match(presentation.statusLabel, /Roon: ready/)
  assert.match(presentation.statusLabel, /Provider: configured/)

  const serialized = JSON.stringify(presentation)
  assert.doesNotMatch(serialized, /internal-track-id/)
  assert.doesNotMatch(serialized, /https?:\/\//i)
  assert.doesNotMatch(serialized, /token|cookie|authorization|bearer/i)
  assert.doesNotMatch(serialized, /Pause|Seek/)
})

test('没有当前播放时托盘保持可用的空状态摘要', () => {
  const presentation = buildTrayPresentation({
    bridge: { ...bridge, activeStreamCount: 0, activePlaybackPresent: false },
    playback: { ...playback, state: 'idle', currentTrack: undefined, canStop: false },
  })

  assert.equal(presentation.trackLabel, 'Now Playing: idle')
})

test('关闭窗口默认隐藏，真正退出时才允许关闭', () => {
  assert.equal(shouldHideWindowOnClose(false), true)
  assert.equal(shouldHideWindowOnClose(true), false)
})
