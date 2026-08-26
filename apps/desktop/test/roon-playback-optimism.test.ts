import assert from 'node:assert/strict'
import test from 'node:test'
import type { RoonLibraryItem } from '@music-bridge/contracts'
import { createOptimisticRoonPlayback } from '../src/renderer/src/roon-playback-optimism.js'

test('本地 Roon 点播立即投影新曲目，同时不伪造真实码率', () => {
  const item: RoonLibraryItem = {
    reference: 'musicbridge-v2-entity-00000000-0000-0000-0000-000000000001',
    kind: 'track',
    title: 'Immediate Song',
    artist: 'Local Artist',
    album: 'Local Album',
    durationMs: 180_000,
  }

  const snapshot = createOptimisticRoonPlayback(item, 'zone-1')

  assert.equal(snapshot.state, 'resolving')
  assert.equal(snapshot.source, 'roon')
  assert.equal(snapshot.currentTrack?.title, 'Immediate Song')
  assert.deepEqual(snapshot.currentTrack?.artists, ['Local Artist'])
  assert.equal(snapshot.currentTrack?.album, 'Local Album')
  assert.equal(snapshot.selectedZoneId, 'zone-1')
  assert.equal(snapshot.bitrate, undefined)
  assert.equal(snapshot.format, undefined)
  assert.equal(snapshot.actualQuality, 'unknown')
})
