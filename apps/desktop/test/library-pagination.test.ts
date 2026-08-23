import assert from 'node:assert/strict'
import test from 'node:test'

import type { Page, TrackSummary } from '@music-bridge/contracts'
import { appendPage } from '../src/renderer/src/composables/libraryPagination.js'

function page(items: string[], offset: number, hasMore: boolean): Page<string> {
  return { items, offset, limit: 2, total: 5, hasMore }
}

test('long library views append the next page instead of replacing visible tracks', () => {
  const result = appendPage(page(['一', '二'], 0, true), page(['三', '四'], 2, true))

  assert.deepEqual(result.items, ['一', '二', '三', '四'])
  assert.equal(result.offset, 2)
  assert.equal(result.hasMore, true)
})

test('a fresh page resets stale tracks', () => {
  const result = appendPage(page(['旧内容'], 2, true), page(['新内容'], 0, false))

  assert.deepEqual(result.items, ['新内容'])
  assert.equal(result.offset, 0)
  assert.equal(result.hasMore, false)
})

test('track pages de-duplicate by id while preserving provider order', () => {
  const track = (id: string): TrackSummary => ({ id, title: id, artists: ['Artist'], album: 'Album' })
  const result = appendPage(
    { items: [track('1'), track('2')], offset: 0, limit: 2, total: 4, hasMore: true },
    { items: [track('2'), track('3')], offset: 2, limit: 2, total: 4, hasMore: false },
  )

  assert.deepEqual(result.items.map((item) => item.id), ['1', '2', '3'])
})
