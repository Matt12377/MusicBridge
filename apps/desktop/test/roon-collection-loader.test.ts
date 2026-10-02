import assert from 'node:assert/strict'
import test from 'node:test'

import type { RoonLibraryPage } from '@music-bridge/contracts'
import { useRoonCollection } from '../src/renderer/src/composables/useRoonCollection.js'
import { roonLibraryMessage } from '../src/renderer/src/roonLibraryMessages.js'

function page(reference: string, offset: number, hasMore: boolean): RoonLibraryPage {
  return {
    items: [{ reference, kind: 'album', title: reference }],
    offset,
    limit: 1,
    total: 2,
    hasMore,
  }
}

test('当前 Roon 首屏取消必须显示可重试状态，不能冒充 Core 返回空库', async () => {
  let cancelled = true
  const collection = useRoonCollection(async () => {
    if (cancelled) throw Object.assign(new Error('合成上下文撤销'), { code: 'CANCELLED' })
    return page('album:recovered', 0, false)
  }, roonLibraryMessage, 1)
  await collection.load()
  assert.match(collection.error.value ?? '', /取消.*重新读取/u)
  assert.equal(collection.initialLoading.value, false)
  cancelled = false
  await collection.retry()
  assert.equal(collection.error.value, null)
  assert.equal(collection.page.value.items[0]?.reference, 'album:recovered')
})

test('当前 Roon 刷新取消保留已有内容，同时提示刷新未完成', async () => {
  let reads = 0
  const collection = useRoonCollection(async () => {
    if (++reads > 1) throw Object.assign(new Error('合成上下文撤销'), { code: 'CANCELLED' })
    return page('album:kept', 0, false)
  }, roonLibraryMessage, 1)
  await collection.load()
  await collection.retry()
  assert.equal(collection.page.value.items[0]?.reference, 'album:kept')
  assert.match(collection.refreshError.value ?? '', /取消.*重新读取/u)
})

test('离页取消的旧 Roon 请求仍保持静默，不污染新请求', async () => {
  let rejectOld!: (error: Error) => void
  let reads = 0
  const collection = useRoonCollection(() => ++reads === 1
    ? new Promise<RoonLibraryPage>((_, reject) => { rejectOld = reject })
    : Promise.resolve(page('album:new', 0, false)), roonLibraryMessage, 1)
  const old = collection.load()
  collection.suspend()
  await collection.load()
  rejectOld(Object.assign(new Error('合成旧请求取消'), { code: 'CANCELLED' }))
  await old
  assert.equal(collection.error.value, null)
  assert.equal(collection.refreshError.value, null)
  assert.equal(collection.page.value.items[0]?.reference, 'album:new')
})

test('Roon collection loader shares initial, append and retry state without reordering', async () => {
  const calls: number[] = []
  const collection = useRoonCollection(async (request) => {
    calls.push(request.offset)
    return request.offset === 0 ? page('album:1', 0, true) : page('album:2', 1, false)
  }, () => '本地库失败', 1)

  await collection.load()
  assert.deepEqual(collection.page.value.items.map((item) => item.reference), ['album:1'])
  assert.equal(collection.initialLoading.value, false)

  await collection.loadMore()
  assert.deepEqual(collection.page.value.items.map((item) => item.reference), ['album:1', 'album:2'])
  assert.equal(collection.loadingMore.value, false)
  assert.deepEqual(calls, [0, 1])
})

test('Roon collection loader ignores an older initial response and keeps bounded public errors', async () => {
  const resolvers: Array<(value: RoonLibraryPage) => void> = []
  const collection = useRoonCollection(
    () => new Promise<RoonLibraryPage>((resolve) => resolvers.push(resolve)),
    () => '本地库失败',
    1,
  )

  const older = collection.load()
  const newer = collection.load()
  resolvers[1]?.(page('album:new', 0, false))
  await newer
  resolvers[0]?.(page('album:old', 0, false))
  await older
  assert.equal(collection.page.value.items[0]?.reference, 'album:new')

  const failing = useRoonCollection(
    async () => { throw new Error('private upstream details') },
    () => '本地库失败',
    1,
  )
  await failing.load()
  assert.equal(failing.error.value, '本地库失败')
  assert.equal(failing.initialLoading.value, false)
})

test('Roon collection loader blocks load-more while an initial retry is pending', async () => {
  let resolveRetry: ((value: RoonLibraryPage) => void) | undefined
  const calls: number[] = []
  const collection = useRoonCollection(async (request) => {
    calls.push(request.offset)
    if (calls.length === 1) return page('album:old', 0, true)
    return new Promise<RoonLibraryPage>((resolve) => {
      resolveRetry = resolve
    })
  }, () => '本地库失败', 1)

  await collection.load()
  const retry = collection.retry()
  assert.equal(collection.initialLoading.value, true)

  await collection.loadMore()
  assert.deepEqual(calls, [0, 0])

  resolveRetry?.(page('album:new', 0, false))
  await retry
  assert.equal(collection.page.value.items[0]?.reference, 'album:new')
})

test('Roon collection loader reset drops stale runtime references and invalidates pending responses', async () => {
  let resolvePending: ((value: RoonLibraryPage) => void) | undefined
  const collection = useRoonCollection(async () => new Promise<RoonLibraryPage>((resolve) => {
    resolvePending = resolve
  }), () => '本地库失败', 1)

  const pending = collection.load()
  collection.reset()

  assert.deepEqual(collection.page.value.items, [])
  assert.equal(collection.initialLoading.value, false)
  assert.equal(collection.loadingMore.value, false)
  assert.equal(collection.error.value, null)

  resolvePending?.(page('album:stale-session', 0, false))
  await pending
  assert.deepEqual(collection.page.value.items, [])
})

test('Roon collection loader rejects a mismatched response offset and retries the same continuous page', async () => {
  const calls: number[] = []
  let mismatch = true
  const collection = useRoonCollection(async (request) => {
    calls.push(request.offset)
    if (request.offset === 0) return page('album:1', 0, true)
    if (mismatch) return page('album:wrong-offset', 0, true)
    return page('album:2', 1, false)
  }, () => '本地库失败', 1)

  await collection.load()
  await collection.loadMore()
  assert.deepEqual(collection.page.value.items.map((item) => item.reference), ['album:1'])
  assert.equal(collection.loadMoreError.value, '分页响应异常，点击重试')

  mismatch = false
  await collection.loadMore()
  assert.deepEqual(calls, [0, 1, 1])
  assert.deepEqual(collection.page.value.items.map((item) => item.reference), ['album:1', 'album:2'])
})

const epochA = '00000000-0000-4000-8000-000000000001', epochB = '00000000-0000-4000-8000-000000000002'
test('MBP004：根列表用raw nextOffset而非limit或有效显示长度', async () => {
  const calls: number[] = []
  const collection = useRoonCollection(async request => {
    calls.push(request.offset)
    return { ...page(`album:${request.offset}`, request.offset, request.offset === 0), sourceEpoch: epochA, complete: request.offset !== 0, nextOffset: request.offset === 0 ? 7 : 13 }
  }, () => '读取失败', 24)
  await collection.load(); await collection.loadMore()
  assert.deepEqual(calls, [0, 7])
})
test('MBP004：混epoch拒绝第N页，最多重读0一次，持续换代显式报错', async () => {
  const calls: number[] = []
  let generation = 0
  const collection = useRoonCollection(async request => {
    calls.push(request.offset)
    if (request.offset === 0) generation++
    const sourceEpoch = request.offset === 0 ? (generation === 1 ? epochA : epochB) : (generation === 1 ? epochB : epochA)
    return { ...page(`album:${generation}:${request.offset}`, request.offset, true), sourceEpoch, complete: false, nextOffset: request.offset + 7 }
  }, () => '读取失败', 24)
  await collection.load(); await collection.loadMore(); await collection.loadMore()
  assert.deepEqual(calls, [0, 7, 0, 7])
  assert.deepEqual(collection.page.value.items.map(item => item.reference), ['album:2:0'])
  assert.match(collection.loadMoreError.value ?? '', /重新读取/u)
})
test('MBP004：hasMore但游标不前进不继续派发', async () => {
  const calls: number[] = []
  const collection = useRoonCollection(async request => { calls.push(request.offset); return { ...page('album:1', 0, true), nextOffset: 0 } }, () => '游标异常')
  await collection.load(); await collection.loadMore()
  assert.deepEqual(calls, [0])
  assert.ok(collection.error.value || collection.loadMoreError.value)
})
