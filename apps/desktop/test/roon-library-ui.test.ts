import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

import {
  appendRoonPage,
  emptyRoonPage,
  shouldAutoLoadRoonPage,
} from '../src/renderer/src/composables/roonLibraryPagination.js'

test('Roon library pagination starts empty and preserves the requested page size', () => {
  assert.deepEqual(emptyRoonPage(18), {
    items: [],
    offset: 0,
    limit: 18,
    total: 0,
    hasMore: false,
  })
})

test('Roon library pagination de-duplicates runtime references without reordering', () => {
  const first = {
    items: [
      { reference: 'musicbridge-v2-entity-a', kind: 'album' as const, title: 'A' },
      { reference: 'musicbridge-v2-entity-b', kind: 'album' as const, title: 'B' },
    ],
    offset: 0,
    limit: 2,
    total: 3,
    hasMore: true,
  }
  const second = {
    items: [
      { reference: 'musicbridge-v2-entity-b', kind: 'album' as const, title: 'B (repeat)' },
      { reference: 'musicbridge-v2-entity-c', kind: 'album' as const, title: 'C' },
    ],
    offset: 2,
    limit: 2,
    total: 3,
    hasMore: false,
  }

  assert.deepEqual(appendRoonPage(first, second), {
    items: [first.items[0], first.items[1], second.items[1]],
    offset: 2,
    limit: 2,
    total: 3,
    hasMore: false,
  })
})

test('empty Roon views report the Core library result instead of claiming pairing is missing', async () => {
  const albumGrid = await readFile(
    new URL('../src/renderer/src/components/RoonAlbumGrid.vue', import.meta.url),
    'utf8',
  )
  const app = await readFile(new URL('../src/renderer/src/App.vue', import.meta.url), 'utf8')

  assert.match(albumGrid, /Roon Core 当前返回 0 张专辑/)
  assert.doesNotMatch(albumGrid, /请确认 Roon Core 已配对/)
  assert.match(app, /Roon Core 当前返回 0 位艺术家/)
  assert.match(app, /Roon Core 当前返回 0 个流派/)
  assert.match(app, /Roon Core 当前返回 0 个歌单/)
})

test('Roon album pagination auto-loads only at an idle intersecting sentinel', () => {
  const idle = {
    isIntersecting: true,
    hasMore: true,
    initialLoading: false,
    loadingMore: false,
    loadMoreError: null,
  }

  assert.equal(shouldAutoLoadRoonPage(idle), true)
  assert.equal(shouldAutoLoadRoonPage({ ...idle, isIntersecting: false }), false)
  assert.equal(shouldAutoLoadRoonPage({ ...idle, loadingMore: true }), false)
  assert.equal(shouldAutoLoadRoonPage({ ...idle, loadMoreError: '读取失败' }), false)
  assert.equal(shouldAutoLoadRoonPage({ ...idle, hasMore: false }), false)
})
