import assert from 'node:assert/strict'
import test from 'node:test'

import { confirmRoonTrackActionAfterExactMatchFailure } from '../src/roon/track-action-confirmation.js'
import { BridgeError } from '../src/shared/errors.js'

test('Roon action 已推进目标 Zone 到 playing 时，元数据精确匹配超时不误报播放失败', () => {
  const latest = {
    revision: 12,
    zoneId: 'zone-1',
    state: 'playing' as const,
    nowPlaying: { title: '1. Target' },
  }
  assert.equal(confirmRoonTrackActionAfterExactMatchFailure({
    zoneId: 'zone-1',
    afterRevision: 11,
    expectedTrack: { title: 'Target' },
    latest,
    actionOutcome: 'confirmation-required',
    exactMatchError: new BridgeError('ROON_TIMEOUT', 'metadata mismatch'),
  }), latest)
})

test('Roon action 没有新的 playing revision 时保留安全失败，不吞掉真正失败', () => {
  assert.throws(() => confirmRoonTrackActionAfterExactMatchFailure({
    zoneId: 'zone-1',
    afterRevision: 11,
    expectedTrack: { title: 'Target' },
    latest: { revision: 11, zoneId: 'zone-1', state: 'stopped' },
    actionOutcome: 'confirmation-required',
    exactMatchError: new BridgeError('ROON_TIMEOUT', 'no playback'),
  }), (error: unknown) => error instanceof BridgeError
    && error.code === 'ROON_TIMEOUT'
    && error.details?.stage === 'post-action-confirmation')
})

test('Roon action 不得把同 Zone 上无关曲目的 playing revision 当作目标曲目成功', () => {
  assert.throws(() => confirmRoonTrackActionAfterExactMatchFailure({
    zoneId: 'zone-1',
    afterRevision: 11,
    expectedTrack: { title: 'Target' },
    latest: {
      revision: 12,
      zoneId: 'zone-1',
      state: 'playing',
      nowPlaying: { title: 'Unrelated Track' },
    },
    actionOutcome: 'confirmation-required',
    exactMatchError: new BridgeError('ROON_TIMEOUT', 'metadata mismatch'),
  }), (error: unknown) => error instanceof BridgeError
    && error.code === 'ROON_TIMEOUT'
    && error.details?.stage === 'post-action-confirmation')
})
