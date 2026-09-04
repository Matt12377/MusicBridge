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
