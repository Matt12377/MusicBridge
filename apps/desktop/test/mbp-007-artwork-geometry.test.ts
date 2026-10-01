import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeArtworkUrl, inspectActualArtworkDecode, readArtworkGeometry } from '../src/renderer/src/artwork-image.js'
import { decodeAmbientImage } from '../src/renderer/src/composables/ambientArtwork.js'
function png(width: number, height: number) {
  const body = new Uint8Array(33); body.set([137, 80, 78, 71, 13, 10, 26, 10]); const view = new DataView(body.buffer)
  view.setUint32(8, 13); body.set([73, 72, 68, 82], 12); view.setUint32(16, width); view.setUint32(20, height); return body
}
test('007 geometry：PNG自然尺寸估计，坏IHDR/零尺寸/不支持格式明确拒绝', () => {
  assert.deepEqual(readArtworkGeometry(png(768, 512), 'image/png'), { width: 768, height: 512, rgbaBytes: 768 * 512 * 4 })
  assert.throws(() => readArtworkGeometry(png(0, 1), 'image/png'))
  const broken = png(256, 256); broken[12] = 0; assert.throws(() => readArtworkGeometry(broken, 'image/png'))
  assert.throws(() => readArtworkGeometry(new Uint8Array(8), 'image/jpeg'))
  assert.throws(() => readArtworkGeometry(png(256, 256), 'image/webp'))
})
test('007 geometry：JPEG baseline/progressive有界SOF，不猜缺失/截断尺寸', () => {
  const body = new Uint8Array([255, 216, 255, 194, 0, 17, 8, 3, 0, 1, 128, 3, 1, 17, 0, 2, 17, 0, 3, 17, 0])
  assert.deepEqual(readArtworkGeometry(body, 'image/jpeg'), { width: 384, height: 768, rgbaBytes: 384 * 768 * 4 })
  assert.throws(() => readArtworkGeometry(body.slice(0, 12), 'image/jpeg'))
  body[7] = 0; body[8] = 0; assert.throws(() => readArtworkGeometry(body, 'image/jpeg'))
})

test('007 生产decoder：ambient取消/timeout不会提前归还共享actual槽，真实settle才归还', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
  const previous = globalThis.Image, releases: Array<() => void> = []
  class ImageFake { decoding = ''; src = ''; naturalWidth = 768; naturalHeight = 768; decode() { return new Promise<void>(resolve => { releases.push(resolve) }) } }
  globalThis.Image = ImageFake as unknown as typeof Image; t.after(() => { globalThis.Image = previous })
  const controller = new AbortController(), a = decodeAmbientImage('synthetic://ambient', { signal: controller.signal }); const cancelled = assert.rejects(a, { code: 'ARTWORK_CANCELLED' })
  controller.abort(); await cancelled; assert.equal(inspectActualArtworkDecode(), 1)
  const b = decodeAmbientImage('synthetic://timeout'); const timedOut = assert.rejects(b, { code: 'ARTWORK_TIMEOUT' }); t.mock.timers.tick(10001); await timedOut
  assert.equal(inspectActualArtworkDecode(), 2); releases.forEach(release => release()); await Promise.resolve(); await Promise.resolve(); assert.equal(inspectActualArtworkDecode(), 0)
  const work = decodeArtworkUrl('synthetic://ready', 'playing'); releases.at(-1)!(); assert.deepEqual(await work, { width: 768, height: 768, rgbaBytes: 768 * 768 * 4 })
})

test('007 生产decoder：实际30 visible及2 playing共享上限，真实Promise结算后清零', async t => {
  const previous = globalThis.Image, releases: Array<() => void> = []
  class ImageFake { decoding = ''; src = ''; naturalWidth = 256; naturalHeight = 256; decode() { return new Promise<void>(resolve => { releases.push(resolve) }) } }
  globalThis.Image = ImageFake as unknown as typeof Image; t.after(() => { globalThis.Image = previous })
  const ordinary = Array.from({ length: 30 }, () => decodeArtworkUrl('synthetic://visible'))
  await assert.rejects(decodeArtworkUrl('synthetic://busy'), { code: 'ARTWORK_BUSY' })
  const players = [decodeArtworkUrl('synthetic://player', 'playing'), decodeArtworkUrl('synthetic://ambient', 'playing')]
  assert.equal(inspectActualArtworkDecode(), 32); await assert.rejects(decodeArtworkUrl('synthetic://full', 'playing'), { code: 'ARTWORK_BUSY' })
  releases.forEach(release => release()); await Promise.all([...ordinary, ...players]); assert.equal(inspectActualArtworkDecode(), 0)
})
