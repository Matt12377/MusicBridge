import assert from 'node:assert/strict'
import test from 'node:test'

import type { RoonLibraryPage } from '@music-bridge/contracts'
import { useRoonCollection } from '../src/renderer/src/composables/useRoonCollection.js'

function page(reference: string, offset: number, hasMore: boolean): RoonLibraryPage {
  return {
    items: [{ reference, kind: 'album', title: reference }],
    offset,
    limit: 1,
    total: 2,
    hasMore,
  }
}

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
