import assert from 'node:assert/strict'
import test from 'node:test'

import { IPC_VERSION, roonTrackIdFromReference, validateIpcRequest } from '../src/index.js'

test('contracts accepts a bounded Roon library albums request', () => {
  const result = validateIpcRequest({
    version: IPC_VERSION,
    id: 'roon-library-albums',
    command: 'roon.library.albums',
    payload: { page: { offset: 0, limit: 20 } },
  })

  assert.equal(result.ok, true)
})

test('Roon runtime entity references map to collision-resistant numeric V1 track ids', () => {
  assert.equal(
    roonTrackIdFromReference('musicbridge-v2-entity-00000000-0000-0000-0000-000000000001'),
    '1',
  )
  assert.equal(
    roonTrackIdFromReference('musicbridge-v2-entity-ffffffff-ffff-ffff-ffff-ffffffffffff'),
    '340282366920938463463374607431768211455',
  )
  assert.throws(
    () => roonTrackIdFromReference('musicbridge-v2-image-00000000-0000-0000-0000-000000000001'),
    /invalid/u,
  )
})

test('contracts accept only a bounded existing-queue index', () => {
  const accepted = validateIpcRequest({
    version: IPC_VERSION,
    id: 'play-queue-index',
    command: 'playback.playQueueIndex',
    payload: { index: 1 },
  })
  const rejected = validateIpcRequest({
    version: IPC_VERSION,
    id: 'play-queue-index-negative',
    command: 'playback.playQueueIndex',
    payload: { index: -1 },
  })

  assert.equal(accepted.ok, true)
  assert.equal(rejected.ok, false)
})
