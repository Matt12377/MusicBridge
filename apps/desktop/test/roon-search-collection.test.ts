import assert from 'node:assert/strict'
import test from 'node:test'
import type { PageRequest, RoonLibraryPage } from '@music-bridge/contracts'
import { useRoonSearchCollection } from '../src/renderer/src/composables/useRoonSearchCollection.js'

const turn = () => new Promise(resolve => setTimeout(resolve, 10))
const result = (name: string, request: PageRequest, hasMore = false): RoonLibraryPage => ({
  ...request, hasMore, items: [{ reference: name, kind: 'album', title: name }],
})

for (const kind of ['album', 'artist'] as const) {
  test(`${kind} 页面只查询指定 Roon 类型，翻页沿用关键词，清除后恢复完整列表`, async () => {
    const calls: unknown[] = []
    const state = useRoonSearchCollection(kind,
      async page => { calls.push(['list', page.offset]); return result('全部', page) },
      async (query, page, type) => { calls.push([query, type, page.offset]); return result(query + page.offset, page, page.offset === 0) },
      () => '读取失败', 0)
    state.setQuery('  逆光  ')
    await turn()
    await state.loadMore()
    assert.deepEqual(calls, [['逆光', kind, 0], ['逆光', kind, 24]])
    assert.equal(state.page.value.items.length, 2)
    state.setQuery('')
    await turn()
    assert.deepEqual(calls.at(-1), ['list', 0])
    assert.equal(state.page.value.items[0]?.title, '全部')
    state.reset()
  })
}

test('输入新词时立即隔离旧请求，分页失败可重试且不丢现有结果', async () => {
  let completeOld!: (value: RoonLibraryPage) => void
  let failPage = true
  const state = useRoonSearchCollection('album', async page => result('全部', page), async (query, page) => {
    if (query === '旧词') return new Promise(resolve => { completeOld = resolve })
    if (page.offset > 0 && failPage) { failPage = false; throw Error('合成分页错误') }
    return result(query + page.offset, page, page.offset === 0)
  }, () => '读取失败', 0)
  state.setQuery('旧词'); await turn()
  state.setQuery('新词')
  completeOld(result('不能写回的旧结果', { offset: 0, limit: 24 }))
  await turn()
  assert.equal(state.page.value.items[0]?.title, '新词0')
  await state.loadMore()
  assert.ok(state.loadMoreError.value)
  assert.equal(state.page.value.items[0]?.title, '新词0')
  await state.loadMore()
  assert.equal(state.loadMoreError.value, null)
  assert.deepEqual(state.page.value.items.map(x => x.title), ['新词0', '新词24'])
  state.reset()
})
