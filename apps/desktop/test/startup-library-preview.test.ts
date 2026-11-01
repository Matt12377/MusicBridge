import assert from 'node:assert/strict'
import test from 'node:test'
import { effectScope, nextTick, ref, shallowRef } from 'vue'
import { createLocalAlbumBrowserModel } from '../src/renderer/src/composables/application/local-library-browser/model.js'
import { readStartupLibraryPreview, saveStartupLibraryPreview, STARTUP_LIBRARY_PREVIEW_KEY, useStartupLibraryPreview } from '../src/renderer/src/composables/application/startup-library-preview.js'
import type { LocalAlbumSummary } from '@music-bridge/contracts'

const album: LocalAlbumSummary = { id: 'edition-1', kind: 'edition', rootId: '11111111-1111-4111-8111-111111111111', editionId: null,
  title: '合成预览', artists: ['合成艺人'], versionLabel: null, year: null, trackCount: 1, representativeTrackId: null, revision: '1', artworkAvailable: false, statuses: [] }
function fixtures() {
  const data = new Map<string, string>()
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) }, removeItem: (key: string) => { data.delete(key) } }
  const model = createLocalAlbumBrowserModel({ api: { queryAlbums: async () => { throw new Error('预览不能读取业务') }, queryAlbumTracks: async () => { throw new Error('预览不能读歌曲') }, getArtwork: async () => { throw new Error('预览不能读来源') } } })
  return { data, storage, snapshot: { ...model.getSnapshot(), active: true, loaded: true, items: [album] } }
}

test('预览只保存上次成功页面的显示信息，不保留可执行专辑和来源身份', () => {
  const { storage, data, snapshot } = fixtures()
  assert.equal(saveStartupLibraryPreview(storage, 'dataset-1', snapshot, 1000), true)
  assert.deepEqual(readStartupLibraryPreview(storage, 1001)?.albums, [{ title: album.title, artists: '合成艺人', edition: '', image: null }])
  const saved = data.get(STARTUP_LIBRARY_PREVIEW_KEY)!
  assert.equal(saved.includes(album.rootId), false)
  assert.equal(saved.includes(album.id), false)
  for (const patch of [{ stale: true }, { loaded: false }, { error: '读取失败' }, { query: '搜索' }, { rootId: album.rootId }]) {
    assert.equal(saveStartupLibraryPreview(storage, 'dataset-1', { ...snapshot, ...patch }, 2000), false)
    assert.equal(data.get(STARTUP_LIBRARY_PREVIEW_KEY), saved)
  }
  assert.equal(readStartupLibraryPreview(storage, 8 * 24 * 60 * 60 * 1000), null)
})

test('损坏、过大或外部图片地址不进入启动预览，存储失败不阻断页面', () => {
  const { storage, data, snapshot } = fixtures()
  for (const raw of ['{', 'x'.repeat(800 * 1024), JSON.stringify({ version: 1, datasetId: 'd', savedAt: 1, albums: [{ title: 'a', artists: '', edition: '', image: 'https://example.com/cover.jpg' }] })]) {
    data.set(STARTUP_LIBRARY_PREVIEW_KEY, raw)
    assert.equal(readStartupLibraryPreview(storage, 2), null)
  }
  assert.equal(saveStartupLibraryPreview({ ...storage, setItem: () => { throw new Error('存储已满') } }, 'dataset-1', snapshot), false)
})

test('准备阶段显示历史内容，就绪后移除；切换Dataset时不保存旧页面', async () => {
  const { storage, snapshot } = fixtures()
  saveStartupLibraryPreview(storage, 'old', snapshot)
  const ready = ref(false), datasetId = ref('old'), current = shallowRef(snapshot), scope = effectScope()
  const preview = scope.run(() => useStartupLibraryPreview({ storage, ready, datasetId: () => datasetId.value, snapshot: () => current.value }))!
  assert.equal(preview.value?.datasetId, 'old')
  ready.value = true; await nextTick()
  assert.equal(preview.value, null)
  datasetId.value = 'new'; current.value = { ...snapshot, loaded: false }; await nextTick()
  await new Promise(resolve => setTimeout(resolve, 650))
  assert.equal(readStartupLibraryPreview(storage)?.datasetId, 'old')
  scope.stop()
})
