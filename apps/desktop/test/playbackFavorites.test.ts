import assert from 'node:assert/strict'
import test from 'node:test'
import {
  favoriteDescriptorForRoonItem,
  favoriteDescriptorForTrack,
  resolveFavoriteToggle,
} from '../src/renderer/src/composables/playbackFavorites.js'

test('本地收藏描述符只保存稳定的公开元数据，不携带 Roon runtime reference', () => {
  const descriptor = favoriteDescriptorForRoonItem({
    reference: 'runtime:track:42',
    kind: 'track',
    title: '吻别',
    subtitle: 'Track 1',
    artist: '张学友',
    album: '真爱',
    durationMs: 271_000,
    trackNumber: 1,
  })

  assert.deepEqual(descriptor, {
    kind: 'track',
    title: '吻别',
    subtitle: 'Track 1',
    artist: '张学友',
    album: '真爱',
    durationMs: 271_000,
    trackNumber: 1,
  })
  assert.equal('reference' in descriptor, false)
})

test('网易云 Track 可以映射为本地 Track 收藏描述符', () => {
  assert.deepEqual(
    favoriteDescriptorForTrack({
      id: 'netease-1',
      title: '吻别',
      artists: ['张学友'],
      album: '真爱',
      durationMs: 271_000,
    }),
    {
      kind: 'track',
      title: '吻别',
      artist: '张学友',
      album: '真爱',
      durationMs: 271_000,
    },
  )
})

test('双身份 Heart 明确操作时保持两边一致：任一边未收藏就补齐，两边都收藏才取消', () => {
  assert.equal(resolveFavoriteToggle({ netease: false, local: false }), true)
  assert.equal(resolveFavoriteToggle({ netease: true, local: false }), true)
  assert.equal(resolveFavoriteToggle({ netease: false, local: true }), true)
  assert.equal(resolveFavoriteToggle({ netease: true, local: true }), false)
})
