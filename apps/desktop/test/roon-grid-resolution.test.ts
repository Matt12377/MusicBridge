import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveFavorite } from '../src/renderer/src/composables/favoriteResolution.js'
const record = { favoriteId: 'fav', kind: 'album' as const, title: '目标专辑', createdAt: 1, updatedAt: 1 }
const epochA = '00000000-0000-4000-8000-000000000001', epochB = '00000000-0000-4000-8000-000000000002'
test('007 RED/GREEN 收藏实际nextOffset推进，不能以limit跳过候选', async () => {
  const offsets: number[] = []
  const result = await resolveFavorite(record, async (_q, page) => { offsets.push(page.offset); return { ...page, sourceEpoch: epochA, nextOffset: page.offset + 7, items: page.offset === 7 ? [{ reference: 'target', kind: 'album', title: record.title }] : [], hasMore: page.offset === 0 } })
  assert.deepEqual(offsets, [0, 7]); assert.equal(result.state, 'ready')
})
test('007 RED/GREEN 收藏同dataset换epoch不可将旧候选当唯一命中', async () => {
  const result = await resolveFavorite(record, async (_q, page) => ({ ...page, sourceEpoch: page.offset === 0 ? epochA : epochB, items: page.offset === 0 ? [{ reference: 'stale', kind: 'album', title: record.title }] : [], hasMore: page.offset === 0 }))
  assert.equal(result.state, 'error')
})
