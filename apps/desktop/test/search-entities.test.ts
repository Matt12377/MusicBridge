import assert from 'node:assert/strict'
import test from 'node:test'
import { groupSearchArtists, mixSearchAlbums } from '../src/renderer/src/composables/search-entities.js'

test('同名艺人聚合展示但保留两个来源的独立入口', () => {
  const result = groupSearchArtists([{ id: '1', name: ' Artist ' }], [{ reference: 'r1', kind: 'artist', title: 'artist' }])
  assert.equal(result.length, 1)
  assert.equal(result[0]?.netease?.id, '1')
  assert.equal(result[0]?.roon?.reference, 'r1')
})

test('重名和未确认的中英文别名不误合并', () => {
  assert.equal(groupSearchArtists([{ id: '1', name: '同名' }, { id: '2', name: '同名' }], [{ reference: 'r1', kind: 'artist', title: '同名' }]).length, 3)
  assert.equal(groupSearchArtists([{ id: '1', name: '草蜢' }], [{ reference: 'r1', kind: 'artist', title: 'Grasshopper' }]).length, 2)
})

test('专辑跨来源交错展示，保留同名版本并排除单曲', () => {
  const result = mixSearchAlbums([{ id: '1', name: '专辑', artistName: '艺人' }], [
    { reference: 'r1', kind: 'album', title: '专辑' },
    { reference: 'r2', kind: 'album', title: '专辑', year: 2024 },
    { reference: 'r3', kind: 'track', title: '歌曲' },
  ])
  assert.deepEqual(result.map((item) => item.key), ['roon:r1', 'netease:1', 'roon:r2'])
})
