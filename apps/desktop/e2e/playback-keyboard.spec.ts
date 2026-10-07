import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'
import { e2eTemporaryRoot } from './temporary-root.js'

const require = createRequire(import.meta.url)
const desktopRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

test('MBR-001 实际键盘：行 Enter 播放，子按钮 Enter/空格只执行自身操作', async () => {
  test.setTimeout(60_000)
  const directory = await mkdtemp(path.join(e2eTemporaryRoot(), 'musicbridge-keyboard-'))
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined
  try {
    const componentRoot = path.join(desktopRoot, 'src/renderer/src/components')
    const entry = path.join(directory, 'fixture.ts')
    await writeFile(entry, `
      import { createApp, h, reactive } from 'vue'
      import TrackTable from ${JSON.stringify(path.join(componentRoot, 'media/TrackTable.vue'))}
      import RoonBrowseDetail from ${JSON.stringify(path.join(componentRoot, 'RoonBrowseDetail.vue'))}
      const counts = reactive({ netPlay: 0, netQueue: 0, roonPlay: 0, roonQueue: 0 })
      const track = { id: 'synthetic', title: '合成歌曲', artists: ['合成艺人'], album: '合成专辑' }
      const item = { reference: 'synthetic-reference', kind: 'track', title: '合成 Roon 曲目', artist: '合成艺人' }
      createApp({ render: () => h('main', [
        h('output', { id: 'counts' }, JSON.stringify(counts)),
        h(TrackTable, { tracks: [track], showArtwork: false,
          onPlay: () => counts.netPlay++, onQueue: () => counts.netQueue++ }),
        h(RoonBrowseDetail, { entity: { ...item, kind: 'playlist', title: '合成歌单' }, mode: 'playlist',
          page: { items: [item], offset: 0, limit: 24, total: 1, hasMore: false },
          onPlay: () => counts.roonPlay++, onQueue: () => counts.roonQueue++ }),
      ]) }).mount('#app')
    `)
    // 只替换封面/专辑墙，避免夹具访问媒体或 API；被测行和按钮使用正式组件。
    const output = await build({
      configFile: false, root: directory, logLevel: 'silent',
      define: { 'process.env.NODE_ENV': '"production"' },
      resolve: { alias: { vue: require.resolve('vue/dist/vue.esm-bundler.js') } },
      plugins: [{ name: 'keyboard-artwork-stubs', enforce: 'pre', load(id) {
        if (['TrackArtwork.vue', 'RoonArtwork.vue', 'RoonAlbumGrid.vue'].some(name => id.endsWith('/' + name))) {
          return '<template><span aria-hidden="true"></span></template>'
        }
      } }, vue()],
      build: { write: false, minify: false, lib: { entry, formats: ['iife'], name: 'KeyboardFixture', cssFileName: 'keyboard-fixture' } },
    })
    const bundles = Array.isArray(output) ? output : [output]
    const assets = bundles.flatMap(bundle => 'output' in bundle ? bundle.output : [])
    const chunk = assets.find(item => item.type === 'chunk')
    if (!chunk || chunk.type !== 'chunk') throw new Error('键盘夹具未生成')
    const css = assets.find(item => item.type === 'asset' && item.fileName === 'keyboard-fixture.css')
    if (!css || css.type !== 'asset') throw new Error('键盘夹具未生成正式组件样式')
    await writeFile(path.join(directory, 'fixture.js'), chunk.code)
    await writeFile(path.join(directory, 'keyboard-fixture.css'), css.source)
    await writeFile(path.join(directory, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="keyboard-fixture.css"><div id="app"></div><script src="fixture.js"></script>')
    const main = path.join(directory, 'main.cjs')
    await writeFile(main, `const { app, BrowserWindow } = require('electron');
      app.setPath('userData', ${JSON.stringify(path.join(directory, 'user-data'))});
      app.whenReady().then(() => { const window = new BrowserWindow({ width: 1000, height: 700 });
        window.loadFile(${JSON.stringify(path.join(directory, 'index.html'))}); });`)
    application = await electron.launch({ args: [main] })
    const page = await application.firstWindow()
    const counts = () => page.locator('#counts').evaluate(element => JSON.parse(element.textContent!))
    await expect(page.locator('.track-row')).toBeVisible()
    await page.locator('.track-row').press('Enter')
    expect(await counts()).toEqual({ netPlay: 1, netQueue: 0, roonPlay: 0, roonQueue: 0 })
    for (const key of ['Enter', 'Space']) {
      await page.getByRole('button', { name: '打开 合成歌曲 的更多操作', exact: true }).press(key)
      await expect(page.getByRole('menu')).toBeVisible()
      await page.getByRole('menuitem', { name: '加入队列', exact: true }).press(key)
    }
    expect(await counts()).toEqual({ netPlay: 1, netQueue: 2, roonPlay: 0, roonQueue: 0 })
    await page.locator('.roon-track-row').press('Enter')
    for (const key of ['Enter', 'Space']) {
      await page.getByRole('button', { name: '将 合成 Roon 曲目 加入队列', exact: true }).press(key)
    }
    expect(await counts()).toEqual({ netPlay: 1, netQueue: 2, roonPlay: 1, roonQueue: 2 })
    for (const key of ['Enter', 'Space']) {
      await page.getByRole('button', { name: '播放 合成歌曲', exact: true }).press(key)
      await page.getByRole('button', { name: '播放 合成 Roon 曲目', exact: true }).press(key)
    }
    expect(await counts()).toEqual({ netPlay: 3, netQueue: 2, roonPlay: 3, roonQueue: 2 })
  } finally {
    await application?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
