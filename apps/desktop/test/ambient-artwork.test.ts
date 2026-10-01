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
  assert.deepEqual({ src: f.artwork.value.src, isCover: f.artwork.value.isCover }, { src: 'default.png', isCover: false })
  await f.select('blue.jpg')
  assert.equal(f.artwork.value.src, 'default.png')
  f.requests[0]!.resolve(); await f.flush()
  assert.deepEqual({ src: f.artwork.value.src, isCover: f.artwork.value.isCover }, { src: 'blue.jpg', isCover: true })
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
  assert.deepEqual({ src: f.artwork.value.src, isCover: f.artwork.value.isCover }, { src: 'default.png', isCover: false })
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
  assert.deepEqual({ src: f.artwork.value.src, isCover: f.artwork.value.isCover }, { src: 'default.png', isCover: false })
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

test('007：A→B→A同blob按frame token独立释放，900ms正常淡出不提前release', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
  const source = ref<string>(), released: string[] = [], scope = effectScope()
  let sequence = 0
  const artwork = scope.run(() => useAmbientArtwork(source, 'default.png', async src => {
    const lease = `${src}-${++sequence}`; return { src: `blob:${src}`, release: () => released.push(lease) }
  }))!
  const choose = async (src: string) => { source.value = src; await nextTick(); await Promise.resolve(); await nextTick() }
  try {
    await choose('A'); const first = artwork.value.frameToken
    await choose('B'); const second = artwork.value.frameToken
    await choose('A'); const current = artwork.value.frameToken; assert.notEqual(first, current)
    t.mock.timers.tick(899); assert.deepEqual(released, []); t.mock.timers.tick(1); assert.deepEqual(released, [])
    artwork.releaseFrame(first); assert.deepEqual(released, ['A-1']); assert.equal(artwork.value.src, 'blob:A')
    artwork.releaseFrame(current); assert.deepEqual(released, ['A-1'])
    artwork.releaseFrame(second); assert.deepEqual(released, ['A-1', 'B-2'])
  } finally { scope.stop() }
  assert.deepEqual(released, ['A-1', 'B-2', 'A-3'])
})

test('007：ambient每subscriber signal独立，换source/强clear/卸载废late资源且同props不重放', async () => {
  const source = ref<string>(), scope = effectScope(), signals: AbortSignal[] = [], released: string[] = []
  const pending: Array<(resource: { src: string; release(): void }) => void> = []
  const artwork = scope.run(() => useAmbientArtwork(source, 'default.png', (_src, options) => { signals.push(options.signal); return new Promise(resolve => pending.push(resolve)) }))!
  source.value = 'A'; await nextTick(); source.value = 'B'; await nextTick(); assert.equal(signals[0]!.aborted, true)
  pending[1]!({ src: 'blob:B', release: () => released.push('B') }); await Promise.resolve(); await nextTick()
  artwork.invalidate(); assert.equal(artwork.value.src, 'default.png'); assert.deepEqual(released, ['B']); assert.equal(signals.length, 2)
  pending[0]!({ src: 'blob:A', release: () => released.push('A') }); await Promise.resolve(); await nextTick(); assert.equal(artwork.value.src, 'default.png'); assert.deepEqual(released, ['B', 'A'])
  source.value = 'C'; await nextTick(); scope.stop(); assert.equal(signals[2]!.aborted, true)
  pending[2]!({ src: 'blob:C', release: () => released.push('C') }); await Promise.resolve(); assert.deepEqual(released, ['B', 'A', 'C'])
})

test('007：同URL快速帧也保守限128，超额lease释放且保留当前画面', async () => {
  const source = ref<string>(), scope = effectScope(); let releases = 0
  const artwork = scope.run(() => useAmbientArtwork(source, 'default.png', async () => ({ src: 'blob:shared', release: () => { releases++ } })))!
  for (let i = 0; i < 129; i++) { source.value = String(i); await nextTick(); await Promise.resolve(); await nextTick() }
  assert.equal(releases, 1); assert.equal(artwork.value.src, 'blob:shared'); scope.stop(); assert.equal(releases, 129)
})

test('007：当前目标自身10s超时回default，忽略signal的late成功仍零commit并release', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
  const source = ref<string>('A'), scope = effectScope(), released: string[] = []
  let late!: (resource: { src: string; release(): void }) => void
  const artwork = scope.run(() => useAmbientArtwork(source, 'default.png', src => src === 'A' ? Promise.resolve({ src: 'blob:A', release: () => released.push('A') }) : new Promise(resolve => { late = resolve })))!
  try {
    await Promise.resolve(); await nextTick(); assert.equal(artwork.value.src, 'blob:A')
    source.value = 'B'; await nextTick(); t.mock.timers.tick(10000); await Promise.resolve(); await nextTick()
    assert.equal(artwork.value.src, 'default.png'); assert.equal(artwork.value.isCover, false)
    late({ src: 'blob:B', release: () => released.push('B') }); await Promise.resolve(); await nextTick()
    assert.equal(artwork.value.src, 'default.png'); assert.deepEqual(released, ['B'])
  } finally { scope.stop() }
  assert.deepEqual(released, ['B', 'A'])
})
