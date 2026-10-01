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

const mbp004EpochA = '00000000-0000-4000-8000-000000000001'
const mbp004EpochB = '00000000-0000-4000-8000-000000000002'
test('MBP004：append保留dataset epoch/EOF/原始下一游标，不以去重长度推进', () => {
  const first = { items: [{ reference: 'a', kind: 'album' as const, title: 'A' }], offset: 0, limit: 24, sourceEpoch: mbp004EpochA, complete: false, nextOffset: 7, hasMore: true }
  const second = { items: [{ reference: 'a', kind: 'album' as const, title: '重复A' }, { reference: 'b', kind: 'album' as const, title: 'B' }], offset: 7, limit: 24, sourceEpoch: mbp004EpochA, complete: true, nextOffset: 13, total: 2, hasMore: false }
  assert.deepEqual(appendRoonPage(first, second), { ...second, items: [first.items[0], second.items[1]] })
})
for (const sourceEpoch of [mbp004EpochB, undefined]) {
  test(`MBP004：append在不同或缺失epoch时先拒绝混页（${sourceEpoch ?? '旧协议'}）`, () => {
    const first = { items: [], offset: 0, limit: 24, sourceEpoch: mbp004EpochA, hasMore: true }
    const second = { items: [], offset: 24, limit: 24, ...(sourceEpoch ? { sourceEpoch } : {}), hasMore: false }
    assert.throws(() => appendRoonPage(first, second), /已变化/u)
  })
}

test('MBP003B：分页累积保留同代稳定句柄与前页曲目', () => {
  const handle = '00000000-0000-4000-8000-000000000011'
  const first = { items: [{ reference: 'first', kind: 'track' as const, title: '前页曲目' }], offset: 0, limit: 24, sourceEpoch: mbp004EpochA, playbackContextHandle: handle, hasMore: true }
  const second = { items: [{ reference: 'second', kind: 'track' as const, title: '后页曲目' }], offset: 24, limit: 24, sourceEpoch: mbp004EpochA, playbackContextHandle: handle, hasMore: false }
  assert.deepEqual(appendRoonPage(first, second), { ...second, items: [...first.items, ...second.items] })
})

test('MBP003B：同epoch下冲突句柄拒绝混页，原页不变', () => {
  const first = { items: [{ reference: 'first', kind: 'track' as const, title: '前页曲目' }], offset: 0, limit: 24, sourceEpoch: mbp004EpochA, playbackContextHandle: mbp004EpochA, hasMore: true }
  const original = structuredClone(first)
  const second = { items: [{ reference: 'second', kind: 'track' as const, title: '后页曲目' }], offset: 24, limit: 24, sourceEpoch: mbp004EpochA, playbackContextHandle: mbp004EpochB, hasMore: false }
  assert.throws(() => appendRoonPage(first, second), /上下文已变化/u)
  assert.deepEqual(first, original)
})
