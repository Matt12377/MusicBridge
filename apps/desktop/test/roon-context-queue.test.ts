import assert from 'node:assert/strict'
import test from 'node:test'
import type { RoonLibraryItem } from '@music-bridge/contracts'
import { collectRoonPlaybackContext } from '../src/renderer/src/roon-context-queue.js'

const tracks: RoonLibraryItem[] = [1, 2, 3].map((n) => ({
  reference: `musicbridge-v2-entity-00000000-0000-0000-0000-${String(n).padStart(12, '0')}`,
  kind: 'track', title: `歌曲 ${n}`,
}))

test('本地上下文加载未显示的分页，保留顺序和点击位置', async () => {
  const requests: number[] = []
  const result = await collectRoonPlaybackContext(tracks[1]!, {
    items: tracks.slice(0, 2), offset: 0, limit: 2, hasMore: true,
  }, async (page) => {
    requests.push(page.offset)
    return { items: [tracks[2]!], offset: 2, limit: 2, hasMore: false }
  })
  assert.deepEqual(requests, [2])
  assert.deepEqual(result, tracks)
})

test('不把不相关的页面或专辑条目拼入单曲队列', async () => {
  assert.deepEqual(await collectRoonPlaybackContext(tracks[2]!, {
    items: tracks.slice(0, 2), offset: 0, limit: 2, hasMore: false,
  }), [tracks[2]])
  assert.deepEqual(await collectRoonPlaybackContext(tracks[0]!, {
    items: [tracks[0]!, { reference: 'album', kind: 'album', title: '专辑' }], offset: 0, limit: 2,
  }), [tracks[0]])
})

test('分页读取失败不把不完整队列伪装成完整专辑', async () => {
  await assert.rejects(collectRoonPlaybackContext(tracks[0]!, {
    items: [tracks[0]!], offset: 0, limit: 1, hasMore: true,
  }, async () => { throw new Error('读取失败') }), /读取失败/)
})

test('取消旧的本地播放请求后停止继续翻页', async () => {
  let current = true
  let calls = 0
  await assert.rejects(collectRoonPlaybackContext(tracks[0]!, {
    items: [tracks[0]!], offset: 0, limit: 1, hasMore: true,
  }, async (page) => {
    calls += 1
    current = false
    return { items: [tracks[1]!], ...page, hasMore: true }
  }, () => current), /已取消/)
  assert.equal(calls, 1)
})

const mbpEpoch = '00000000-0000-4000-8000-000000000001'
test('MBP004：完整队列用effective nextOffset，完整缓存首页complete不终止翻页', async () => {
  const calls: number[] = []
  const initial = { items: [tracks[0]!], offset: 0, limit: 24, nextOffset: 1, complete: true, sourceEpoch: mbpEpoch, hasMore: true }
  const result = await collectRoonPlaybackContext(tracks[0]!, initial, async page => { calls.push(page.offset); return { ...page, items: [tracks[1]!], sourceEpoch: mbpEpoch, nextOffset: 2, complete: true, hasMore: false } })
  assert.deepEqual(calls, [1]); assert.deepEqual(result, tracks.slice(0, 2))
})
test('MBP004：完整队列EOF未知不能伪装成完成', async () => {
  const initial = { items: [tracks[0]!], offset: 0, limit: 24, complete: false, sourceEpoch: mbpEpoch }
  await assert.rejects(collectRoonPlaybackContext(tracks[0]!, initial), /完整/u)
})

test('MBP004：完整队列换代后有界重读，清掉旧条目并保留点击位置', async () => {
  const epochB = '00000000-0000-4000-8000-000000000002', calls: number[] = []
  const initial = { items: [tracks[0]!, tracks[1]!], offset: 0, limit: 24, sourceEpoch: mbpEpoch, nextOffset: 2, complete: false, hasMore: true }
  const result = await collectRoonPlaybackContext(tracks[1]!, initial, async request => {
    calls.push(request.offset)
    return request.offset === 0
      ? { ...request, items: [tracks[1]!], sourceEpoch: epochB, nextOffset: 1, complete: false, hasMore: true }
      : { ...request, items: [tracks[2]!], sourceEpoch: epochB, nextOffset: request.offset + 1, complete: true, hasMore: false }
  })
  assert.deepEqual(calls, [2, 0, 1]); assert.deepEqual(result, tracks.slice(1))
})
test('MBP004：完整队列重读期间再换代立即拒绝，不循环或返回部分集合', async () => {
  const calls: number[] = [], epochB = '00000000-0000-4000-8000-000000000002'
  const initial = { items: [tracks[0]!], offset: 0, limit: 24, sourceEpoch: mbpEpoch, nextOffset: 1, complete: false, hasMore: true }
  await assert.rejects(collectRoonPlaybackContext(tracks[0]!, initial, async request => {
    calls.push(request.offset)
    return { ...request, items: [tracks[0]!], sourceEpoch: request.offset === 0 ? mbpEpoch : epochB, nextOffset: request.offset + 1, hasMore: true, complete: false }
  }), /已变化/u)
  assert.deepEqual(calls, [1, 0])
})
test('MBP004：完整队列保留5000容量边界，5001首拒绝', async () => {
  const large = Array.from({ length: 5001 }, (_, index) => ({ reference: `track:${index}`, kind: 'track' as const, title: '合成曲目' }))
  const initial = { items: large.slice(0, 5000), offset: 4980, limit: 20, nextOffset: 5000, complete: true, hasMore: false, sourceEpoch: mbpEpoch }
  assert.equal((await collectRoonPlaybackContext(large[0]!, initial)).length, 5000)
  await assert.rejects(collectRoonPlaybackContext(large[0]!, { ...initial, items: large }), /容量/u)
})
