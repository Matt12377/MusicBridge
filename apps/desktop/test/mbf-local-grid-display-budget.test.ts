import test from 'node:test'
import assert from 'node:assert/strict'
import { canDisplayPersistentGridArtwork } from '../src/renderer/src/composables/application/local-library-browser/grid-display-budget.js'
import type { LocalAlbumArtworkState } from '../src/renderer/src/composables/application/local-library-browser/types.js'

function artwork(width = 512, height = 512): LocalAlbumArtworkState {
  return { status: 'ready', dataUrl: 'data:image/jpeg;base64,/9j/', error: '', canRetry: false,
    display: { sha256: 'a'.repeat(64), bytes: 3, width: 1200, height: 1200 },
    grid: { mime: 'image/jpeg', sha256: 'b'.repeat(64), bytes: 3, width, height, dataUrl: 'data:image/jpeg;base64,/9j/' } }
}

test('持久网格图整个窗口累计最多24MiB解码引用，恰好预算可直用而超出回原有界缓存', () => {
  assert.equal(canDisplayPersistentGridArtwork(Array.from({ length: 24 }, () => artwork())), true)
  assert.equal(canDisplayPersistentGridArtwork(Array.from({ length: 25 }, () => artwork())), false)
  assert.equal(canDisplayPersistentGridArtwork(Array.from({ length: 128 }, () => artwork(128, 128))), true)
})

test('解码预算采用真实宽高，visible与nearby同窗累计而不只计算已可见图片', () => {
  const visible = Array.from({ length: 20 }, () => artwork()), nearby = Array.from({ length: 5 }, () => artwork())
  assert.equal(canDisplayPersistentGridArtwork(visible), true)
  assert.equal(canDisplayPersistentGridArtwork([...visible, ...nearby]), false)
  assert.equal(canDisplayPersistentGridArtwork(Array.from({ length: 48 }, () => artwork(512, 256))), true)
})

test('混有旧display的窗口整体使用原缓存，不能让两条展示路径分别取得完整预算', () => {
  const legacy = artwork(); delete legacy.grid
  assert.equal(canDisplayPersistentGridArtwork([artwork(), legacy]), false)
  assert.equal(canDisplayPersistentGridArtwork([artwork(), { status: 'missing', dataUrl: null, error: '', canRetry: false }]), true)
  assert.equal(canDisplayPersistentGridArtwork([]), false)
})

test('非法持久网格几何不能绕过解码预算', () => {
  for (const [width, height] of [[0, 512], [513, 512], [512, Number.NaN], [1.5, 128]]) {
    assert.equal(canDisplayPersistentGridArtwork([artwork(width, height)]), false)
  }
})
