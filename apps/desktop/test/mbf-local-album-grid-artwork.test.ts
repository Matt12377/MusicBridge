import test from 'node:test'
import assert from 'node:assert/strict'
import { createGridArtworkCache, type GridArtworkSource } from '../src/renderer/src/composables/application/local-library-browser/grid-artwork-cache.js'

const source = (id: string, digest = id.padEnd(64, 'a').slice(0, 64)): GridArtworkSource => ({ identity: id,
  dataUrl: 'data:image/jpeg;base64,/9j/', display: { sha256: digest, width: 1200, height: 1200, bytes: 3 }, visible: true })
const settle = async () => { for (let index = 0; index < 16; index++) await Promise.resolve() }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept }); return { promise, resolve } }
const thumbnail = (size: number, bytes = 12) => ({ blob: new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }), width: size, height: size })

test('网格小图：同display与尺寸只创建一次，离窗撤URL，压缩缓存回窗复用且其他图完成不重复解码', async t => {
  let creates = 0, urlSequence = 0
  const revoked: string[] = [], cache = createGridArtworkCache({ make: async (_source, size) => { creates++; return thumbnail(size) },
    createUrl: () => `blob:synthetic-${++urlSequence}`, revokeUrl: url => { revoked.push(url) } })
  t.after(cache.dispose)
  const a = source('a'), b = source('b', a.display.sha256)
  cache.setWindow([a, b]); await settle()
  assert.equal(creates, 1); assert.equal(cache.get('a').status, 'ready'); assert.equal(cache.get('b').status, 'ready')
  const aUrl = cache.get('a').dataUrl
  cache.setWindow([a, b, source('c')]); await settle()
  assert.equal(cache.get('a').dataUrl, aUrl, '新增另一张图不能撤销有效可见图的URL')
  cache.setWindow([]); assert.equal(cache.usage().decodedReferenceBytes, 0); assert.ok(revoked.includes(aUrl!))
  const before = creates; cache.setWindow([a]); await settle()
  assert.equal(creates, before); assert.equal(cache.get('a').status, 'ready'); assert.notEqual(cache.get('a').dataUrl, aUrl)
})

test('网格小图：离窗取消和回窗迟到隔离，真实创建settle前不释放唯一并发槽', async t => {
  const jobs: { id: string; size: number; signal: AbortSignal; gate: ReturnType<typeof deferred<ReturnType<typeof thumbnail>>> }[] = []
  const urls: string[] = [], cache = createGridArtworkCache({ make: (value, size, signal) => {
    const gate = deferred<ReturnType<typeof thumbnail>>(); jobs.push({ id: value.identity, size, signal, gate }); return gate.promise
  }, createUrl: () => { const url = `blob:synthetic-${urls.length}`; urls.push(url); return url }, revokeUrl: () => {} })
  t.after(() => { cache.dispose(); for (const job of jobs) job.gate.resolve(thumbnail(job.size)) })
  cache.setWindow([source('a'), source('b')]); assert.equal(jobs.length, 1); assert.equal(cache.usage().queued, 1)
  cache.setWindow([source('c')]); assert.equal(jobs[0]!.signal.aborted, true)
  assert.equal(jobs.length, 1); assert.equal(cache.usage().running, 1); assert.equal(cache.usage().queued, 1)
  jobs[0]!.gate.resolve(thumbnail(jobs[0]!.size)); await settle()
  assert.deepEqual(jobs.map(job => job.id), ['a', 'c']); assert.equal(urls.length, 0, '旧图迟到不能保存或绑定URL')
  jobs[1]!.gate.resolve(thumbnail(jobs[1]!.size)); await settle()
  assert.equal(cache.get('c').status, 'ready'); assert.equal(cache.get('a').status, 'loading'); assert.equal(cache.usage().running, 0)
})

test('网格小图：压缩与解码引用各自限额，淘汰有据且dispose关闭全部URL', async () => {
  let sequence = 0
  const live = new Set<string>(), cache = createGridArtworkCache({ compressedBytes: 32, decodedBytes: 256 * 256 * 4,
    make: async (_source, size) => thumbnail(size), createUrl: () => { const url = `blob:synthetic-${++sequence}`; live.add(url); return url }, revokeUrl: url => { live.delete(url) } })
  cache.setWindow([source('a')]); await settle(); assert.equal(cache.get('a').status, 'ready')
  cache.setWindow([source('b'), source('c'), source('d')]); await settle()
  assert.ok(cache.usage().compressedBytes <= 32); assert.ok(cache.usage().decodedReferenceBytes <= 256 * 256 * 4)
  assert.ok(cache.usage().entries <= 2); assert.ok(cache.usage().running <= 1)
  cache.dispose(); assert.equal(live.size, 0); assert.equal(cache.usage().compressedBytes, 0); assert.equal(cache.usage().decodedReferenceBytes, 0)
})

test('网格小图：失败同窗不循环重试，显式重试只重建小图', async t => {
  let attempts = 0
  const cache = createGridArtworkCache({ make: async (_source, size) => { if (++attempts === 1) throw new Error('合成缩略图失败'); return thumbnail(size) }, createUrl: () => 'blob:synthetic', revokeUrl: () => {} })
  t.after(cache.dispose)
  const a = source('a'); cache.setWindow([a]); await settle(); assert.equal(cache.get('a').status, 'error')
  cache.setWindow([a]); await settle(); assert.equal(attempts, 1)
  cache.retry('a'); cache.setWindow([a]); await settle(); assert.equal(attempts, 2); assert.equal(cache.get('a').status, 'ready')
})
