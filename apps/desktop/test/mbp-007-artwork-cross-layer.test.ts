import assert from 'node:assert/strict'
import test from 'node:test'
import { createRoonLibraryService } from '../../../packages/bridge-core/src/roon/library.js'
import { createRoonPublicLibrary } from '../../../packages/bridge-core/src/roon/public-library.js'
import { createRoonArtworkCache } from '../src/renderer/src/roon-artwork-cache.js'
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
const request = (reference: string) => ({ reference, width: 256, height: 256, scale: 'fit' as const, format: 'image/jpeg' as const })
for (const layer of ['owner', 'sdk'] as const) test(`007 跨层：真实Core ${layer} held32临时失败可重试，不生成Renderer negative`, async () => {
  const callbacks: Array<(error: string | false, type?: string, body?: Buffer) => void> = []
  const service = createRoonLibraryService({ browse: { browse() {}, load() {} }, image: { get_image(_key, _options, callback) { callbacks.push(callback) } }, requestTimeoutMs: 1000 })
  const library = createRoonPublicLibrary(() => service)
  const initial = Array.from({ length: 32 }, (_, i) => layer === 'owner' ? library.getImage(library.registerNowPlayingArtwork(`合成-${i}`)) : service.getImage(`合成-${i}`))
  const completed = Promise.allSettled(initial); await turn(); assert.equal(callbacks.length, 32)
  const cache = createRoonArtworkCache({ getImage: (reference, options) => library.getImage(reference, options) })
  try {
    await assert.rejects(cache.acquire(request(library.registerNowPlayingArtwork('合成-新请求'))), { code: 'ARTWORK_BUSY' })
    assert.equal(cache.inspect().negativeEntries, 0); assert.equal(callbacks.length, 32)
  } finally {
    library.invalidateReferences(); callbacks.forEach(callback => callback('合成清理失败')); await completed; cache.clear()
  }
})
for (const serialized of [false, true]) test(`007 序列化：公开临时读取失败${serialized}保守可重试而非图片失败事实`, async () => {
  let calls = 0
  const cache = createRoonArtworkCache({ getImage: async () => { calls++; throw serialized ? Error('Error invoking remote method: [ROON_LIBRARY_REQUEST_FAILED] 合成失败') : Object.assign(Error('合成失败'), { code: 'ROON_LIBRARY_REQUEST_FAILED' }) } })
  for (let i = 0; i < 2; i++) await assert.rejects(cache.acquire(request('musicbridge-v2-image-123e4567-e89b-12d3-a456-426614174001')), { code: 'ARTWORK_BUSY' })
  assert.equal(calls, 2); assert.equal(cache.inspect().negativeEntries, 0)
})
for (const code of ['READ_CANCELLED', 'READ_DEADLINE', 'LIBRARY_READ_CANCELLED', 'LIBRARY_READ_TIMEOUT']) test(`007 控制终态：${code}不产生negative`, async () => {
  const cache = createRoonArtworkCache({ getImage: async () => { throw Error(`[${code}] 合成控制终态`) } })
  await assert.rejects(cache.acquire(request('musicbridge-v2-image-123e4567-e89b-12d3-a456-426614174001')))
  assert.equal(cache.inspect().negativeEntries, 0)
})
