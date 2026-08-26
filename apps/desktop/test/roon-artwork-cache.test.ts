import assert from 'node:assert/strict'
import test from 'node:test'

import { createRoonArtworkCache } from '../src/renderer/src/roon-artwork-cache.js'

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])

test('Renderer artwork cache 去重同图同尺寸请求并复用已解码 URL', async () => {
  let fetchCalls = 0
  let createCalls = 0
  const revoked: string[] = []
  const cache = createRoonArtworkCache({
    getImage: async () => {
      fetchCalls += 1
      await new Promise((resolve) => setImmediate(resolve))
      return { contentType: 'image/jpeg', body: JPEG_BYTES }
    },
    createObjectUrl: () => `blob:art-${++createCalls}`,
    revokeObjectUrl: (url) => revoked.push(url),
    decodeObjectUrl: async () => undefined,
    maxEntries: 4,
  })
  const request = {
    reference: 'musicbridge-v2-image-123e4567-e89b-12d3-a456-426614174001',
    width: 256,
    height: 256,
    scale: 'fit' as const,
    format: 'image/jpeg' as const,
  }

  const [first, second] = await Promise.all([cache.acquire(request), cache.acquire(request)])
  assert.equal(fetchCalls, 1)
  assert.equal(createCalls, 1)
  assert.equal(first.url, second.url)
  first.release()
  second.release()

  const third = await cache.acquire(request)
  assert.equal(fetchCalls, 1)
  assert.equal(third.url, first.url)
  third.release()
  assert.deepEqual(revoked, [])
})

test('Renderer artwork cache 使用有界 LRU，clear 时撤销缓存 URL', async () => {
  let urlSequence = 0
  const revoked: string[] = []
  const cache = createRoonArtworkCache({
    getImage: async () => ({ contentType: 'image/jpeg', body: JPEG_BYTES }),
    createObjectUrl: () => `blob:lru-${++urlSequence}`,
    revokeObjectUrl: (url) => revoked.push(url),
    decodeObjectUrl: async () => undefined,
    maxEntries: 2,
  })
  const request = (suffix: string) => ({
    reference: `musicbridge-v2-image-123e4567-e89b-12d3-a456-4266141740${suffix}`,
    width: 256,
    height: 256,
    scale: 'fit' as const,
    format: 'image/jpeg' as const,
  })

  const first = await cache.acquire(request('01'))
  first.release()
  const second = await cache.acquire(request('02'))
  second.release()
  const firstAgain = await cache.acquire(request('01'))
  firstAgain.release()
  const third = await cache.acquire(request('03'))
  third.release()

  assert.deepEqual(revoked, ['blob:lru-2'])
  cache.clear()
  assert.deepEqual(new Set(revoked), new Set(['blob:lru-1', 'blob:lru-2', 'blob:lru-3']))
})

test('Renderer artwork cache 对无效二进制和解码失败执行短时 negative cache', async () => {
  let now = 10_000
  let fetchCalls = 0
  let decodeCalls = 0
  const revoked: string[] = []
  const cache = createRoonArtworkCache({
    getImage: async () => {
      fetchCalls += 1
      return { contentType: 'image/jpeg', body: JPEG_BYTES }
    },
    createObjectUrl: () => `blob:broken-${fetchCalls}`,
    revokeObjectUrl: (url) => revoked.push(url),
    decodeObjectUrl: async () => {
      decodeCalls += 1
      throw new Error('synthetic decode failure')
    },
    now: () => now,
    negativeTtlMs: 100,
  })
  const request = {
    reference: 'musicbridge-v2-image-123e4567-e89b-12d3-a456-426614174099',
    width: 256,
    height: 256,
    scale: 'fit' as const,
    format: 'image/jpeg' as const,
  }

  await assert.rejects(cache.acquire(request), (error: unknown) => (
    error instanceof Error
    && 'code' in error
    && error.code === 'ROON_IMAGE_DECODE_FAILED'
  ))
  await assert.rejects(cache.acquire(request))
  assert.equal(fetchCalls, 1)
  assert.equal(decodeCalls, 1)
  assert.deepEqual(revoked, ['blob:broken-1'])

  now += 101
  await assert.rejects(cache.acquire(request))
  assert.equal(fetchCalls, 2)
  assert.equal(decodeCalls, 2)

  const invalidCache = createRoonArtworkCache({
    getImage: async () => ({ contentType: 'image/png', body: JPEG_BYTES }),
    createObjectUrl: () => {
      throw new Error('invalid bytes must not reach Blob construction')
    },
    decodeObjectUrl: async () => undefined,
  })
  await assert.rejects(invalidCache.acquire(request), (error: unknown) => (
    error instanceof Error
    && 'code' in error
    && error.code === 'ROON_IMAGE_DECODE_FAILED'
  ))

  const entityLease = await createRoonArtworkCache({
    getImage: async () => ({ contentType: 'image/jpeg', body: JPEG_BYTES }),
    createObjectUrl: () => 'blob:artist-fallback',
    decodeObjectUrl: async () => undefined,
  }).acquire({ ...request, reference: 'musicbridge-v2-entity-123e4567-e89b-12d3-a456-426614174099' })
  assert.equal(entityLease.url, 'blob:artist-fallback')
  entityLease.release()
})
