import assert from 'node:assert/strict'
import test from 'node:test'
import { effectScope, nextTick, ref } from 'vue'
import { useAmbientArtwork } from '../src/renderer/src/composables/ambientArtwork.js'

function fixture(t: test.TestContext) {
  const requests: { src: string; resolve: () => void; reject: () => void }[] = []
  const source = ref<string>()
  const scope = effectScope()
  const artwork = scope.run(() => useAmbientArtwork(source, 'default.png', src => new Promise<void>((resolve, reject) => {
    requests.push({ src, resolve, reject: () => reject(new Error('合成加载失败')) })
  })))!
  t.after(() => scope.stop())
  const flush = async () => { await Promise.resolve(); await nextTick() }
  const select = async (src?: string) => { source.value = src; await nextTick() }
  return { source, scope, artwork, requests, flush, select }
}

test('首次显示默认画面，新封面解码完成前保留原画面', async t => {
  const f = fixture(t)
  assert.deepEqual(f.artwork.value, { src: 'default.png', isCover: false })
  await f.select('blue.jpg')
  assert.equal(f.artwork.value.src, 'default.png')
  f.requests[0]!.resolve(); await f.flush()
  assert.deepEqual(f.artwork.value, { src: 'blue.jpg', isCover: true })
  await f.select('green.jpg')
  assert.equal(f.artwork.value.src, 'blue.jpg')
  f.requests[1]!.resolve(); await f.flush()
  assert.equal(f.artwork.value.src, 'green.jpg')
})

test('暂停或相同封面更新不重载，清空当前曲目恢复默认画面', async t => {
  const f = fixture(t)
  await f.select('blue.jpg'); f.requests[0]!.resolve(); await f.flush()
  const frame = f.artwork.value
  await f.select('blue.jpg')
  assert.equal(f.artwork.value, frame)
  assert.equal(f.requests.length, 1)
  await f.select(undefined)
  assert.deepEqual(f.artwork.value, { src: 'default.png', isCover: false })
})

test('快速切歌时迟到的成功和失败均不能覆盖最新封面', async t => {
  const f = fixture(t)
  await f.select('old.jpg'); await f.select('new.jpg')
  f.requests[1]!.resolve(); await f.flush()
  f.requests[0]!.resolve(); await f.flush()
  assert.equal(f.artwork.value.src, 'new.jpg')
  await f.select('old-error.jpg'); await f.select('latest.jpg')
  f.requests[3]!.resolve(); await f.flush()
  f.requests[2]!.reject(); await f.flush()
  assert.equal(f.artwork.value.src, 'latest.jpg')
})

test('当前封面失败回退默认，清空和卸载使在途请求失效', async t => {
  const f = fixture(t)
  await f.select('bad.jpg'); f.requests[0]!.reject(); await f.flush()
  assert.deepEqual(f.artwork.value, { src: 'default.png', isCover: false })
  await f.select('pending.jpg'); await f.select(undefined)
  f.requests[1]!.resolve(); await f.flush()
  assert.equal(f.artwork.value.src, 'default.png')
  await f.select('unmount.jpg'); f.scope.stop()
  f.requests[2]!.resolve(); await f.flush()
  assert.equal(f.artwork.value.src, 'default.png')
})


test('Roon 封面租约等淡出结束才释放，迟到资源及卸载资源均会回收', async () => {
  const source = ref<string>()
  const released: string[] = []
  const requests: { src: string; resolve: (value: { src: string; release: () => void }) => void }[] = []
  const scope = effectScope()
  const artwork = scope.run(() => useAmbientArtwork(source, 'default.png', src => new Promise(resolve => requests.push({ src, resolve }))))!
  const choose = async (src: string) => { source.value = src; await nextTick() }
  const ready = async (index: number) => {
    const name = requests[index]!.src
    requests[index]!.resolve({ src: `blob:${name}`, release: () => released.push(name) })
    await Promise.resolve(); await nextTick()
  }
  try {
    await choose('first'); await ready(0)
    await choose('second'); await ready(1)
    assert.deepEqual(released, [])
    artwork.releaseFrame('blob:second')
    assert.deepEqual(released, [])
    artwork.releaseFrame('blob:first')
    assert.deepEqual(released, ['first'])
    await choose('late'); await choose('latest'); await ready(3); await ready(2)
    assert.deepEqual(released, ['first', 'late'])
    assert.equal(artwork.value.src, 'blob:latest')
  } finally { scope.stop() }
  assert.deepEqual(released, ['first', 'late', 'second', 'latest'])
})
