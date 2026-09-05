import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import test from 'node:test'

const root = path.resolve('src/renderer/src')
test('正式默认背景必须与 Owner 认可的 HTML 素材逐字节一致', async () => {
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
  assert.equal(sha(await readFile(path.join(root, 'assets/ambient-default-scene.png'))), sha(await readFile('../../prototypes/ambient-study/assets/default-scene.png')))
})

test('正式背景保留默认与封面双状态，预加载完成后同时淡入淡出', async () => {
  const source = await readFile(path.join(root, 'components/AlbumAmbientBackground.vue'), 'utf8')
  assert.match(source, /useAmbientArtwork/)
  assert.match(source, /ambient-default-scene\.png/)
  assert.doesNotMatch(source, /mode="out-in"/)
  assert.match(source, /:key="artwork.src"/)
  const css = await readFile(path.join(root, 'sakura-theme.css'), 'utf8')
  assert.match(css, /blur\(3px\) saturate\(\.84\)/)
  assert.match(css, /blur\(24px\) saturate\(\.8\)/)
  assert.match(css, /rgba\(246, 241, 245, \.30\)/)
  assert.match(css, /rgba\(246, 241, 245, \.60\)/)
  assert.match(css, /opacity 900ms ease/)
})

test('迁移使用已认可的材质和比例，不叠加旧颗粒与强高光', async () => {
  const css = await readFile(path.join(root, 'sakura-theme.css'), 'utf8')
  assert.match(css, /rgba\(248, 245, 249, \.30\)/)
  assert.match(css, /rgba\(247, 242, 247, \.70\)/)
  assert.match(css, /blur\(32px\) saturate\(\.90\)/)
  assert.match(css, /width:\s*min\(1060px, calc\(100% - 64px\)\)/)
  assert.match(css, /max-width:\s*1380px/)
  assert.match(css, /flex:\s*0 0 224px/)
  assert.doesNotMatch(css, /frosted-grain\.svg|saturate\(1\.4\)/)
  const app = await readFile(path.join(root, 'App.vue'), 'utf8')
  assert.match(app, /<AlbumAmbientBackground :current-track="currentTrack"/)
  assert.doesNotMatch(app, /背景研究|模拟播放|study-bar/)
})


test('图标字体使用无查询参数的本地路径，兼容正式 Renderer 协议', async () => {
  const css = await readFile(path.resolve('src/renderer/src/assets/bootstrap-icons/icons.css'), 'utf8')
  assert.match(css, /url\("fonts\/bootstrap-icons\.woff2"\)/)
  assert.doesNotMatch(css, /url\([^)]*\?/)
})
