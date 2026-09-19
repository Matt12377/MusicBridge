import { app, ipcMain, net } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'

// 仅验证渲染、导航与分页；合成数据不代表真实 Roon 或音频验收。
if (process.env.MUSIC_BRIDGE_UI_E2E !== '1' || process.env.MUSIC_BRIDGE_CORE_TEST_MODE !== '1' || !process.env.MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR) throw Error('仅允许隔离合成验证')
const directory = process.env.MUSIC_BRIDGE_SEARCH_QA_DIR
if (!directory?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/')) throw Error('验证产物必须位于外置临时根')
await mkdir(directory, { recursive: true })
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const reference = suffix => `musicbridge-v2-entity-11111111-1111-4111-8111-${suffix.padStart(12, '0')}`
const album = { reference: reference('1'), kind: 'album', title: '合成 Roon 专辑', artist: '合成艺人' }
const artist = { reference: reference('2'), kind: 'artist', title: '合成艺人' }
const track = { reference: reference('3'), kind: 'track', title: '合成本地歌曲', artist: '合成艺人', album: album.title, durationMs: 180000 }
const pageOf = (items, page) => ({ items: items.slice(page.offset, page.offset + page.limit), ...page, total: items.length, hasMore: page.offset + page.limit < items.length })
let started = false
app.on('browser-window-created', (_event, window) => {
  if (started) return
  started = true
  window.webContents.session.protocol.handle('https', request => {
    const url = new URL(request.url)
    if (url.hostname === 'p1.music.126.net') return net.fetch(new URL('../../../prototypes/sakura-glass/assets/cover-1.jpg', import.meta.url).href)
    return new Response('', { status: 404 })
  })
  window.webContents.once('did-finish-load', async () => {
    const evaluate = code => window.webContents.executeJavaScript(code)
    const waitFor = async code => {
      for (let i = 0; i < 80; i++) {
        if (await evaluate(code)) return
        await pause(100)
      }
      throw Error(`界面条件未满足：${code}`)
    }
    const capture = async name => {
      await pause(500)
      await writeFile(`${directory}/${name}.png`, (await window.webContents.capturePage()).toPNG())
    }
    try {
      window.setTitle('Music Bridge · 搜索基础验证（合成数据）')
      window.show()
      window.setContentSize(1440, 1000)
      await waitFor(`!!document.querySelector('[role="searchbox"], input[type="search"]')`)
      for (const channel of ['roon:library:search', 'roon:library:album', 'roon:library:artist', 'library:search-albums', 'library:search-artists']) ipcMain.removeHandler(channel)
      const requests = []
      let failNeteasePage = true
      ipcMain.handle('roon:library:search', async (_event, query, page, kind) => {
        requests.push({ source: 'roon', kind, offset: page.offset })
        await pause(60)
        return pageOf(kind === 'album' ? Array.from({ length: 18 }, (_, i) => ({ ...album, reference: reference(String(i + 10)), title: i === 0 ? album.title : `合成专辑 ${i + 1}` })) : kind === 'artist' ? Array.from({ length: 12 }, (_, i) => ({ ...artist, reference: reference(String(i + 30)), title: i === 0 ? artist.title : `合成艺人 ${i + 1}` })) : [track], page)
      })
      ipcMain.handle('library:search-albums', async (_event, query, page) => {
        requests.push({ source: 'netease', kind: 'album', offset: page.offset })
        await pause(90)
        if (page.offset === 8 && failNeteasePage) { failNeteasePage = false; throw Error('合成分页故障') }
        return pageOf(Array.from({ length: 18 }, (_, i) => ({ id: String(i + 100), name: `网易云专辑 ${i + 1}`, artistName: '合成艺人', artworkUrl: 'https://p1.music.126.net/cover.jpg' })), page)
      })
      ipcMain.handle('library:search-artists', async (_event, query, page) => {
        requests.push({ source: 'netease', kind: 'artist', offset: page.offset })
        await pause(90)
        return pageOf(Array.from({ length: 12 }, (_, i) => ({ id: String(i + 200), name: i === 0 ? '合成艺人' : `网易云艺人 ${i + 1}`, artworkUrl: 'https://p1.music.126.net/cover.jpg' })), page)
      })
      const scrollToEnd = () => evaluate(`document.querySelector('.search-entity-sentinel')?.scrollIntoView({ block: 'end' })`)
      ipcMain.handle('roon:library:album', (_event, _reference, page) => pageOf([track], page))
      ipcMain.handle('roon:library:artist', (_event, _reference, page) => pageOf([album], page))
      await evaluate(`{ const input = document.querySelector('[role="searchbox"], input[type="search"]'); input.value = 'synthetic'; input.dispatchEvent(new Event('input', { bubbles: true })); }`)
      await waitFor(`document.querySelectorAll('.search-song').length === 6 && document.querySelector('.search-album-card')?.textContent.includes('合成 Roon 专辑')`)
      await capture('search-overview')
      await evaluate(`[...document.querySelectorAll('.search-category-tabs button')].find(e => e.textContent === '专辑').click()`)
      await waitFor(`document.querySelectorAll('.search-album-card').length > 6 && !document.querySelector('#search-artists-heading')`)
      await scrollToEnd()
      await waitFor(`document.body.textContent.includes('重试网易云专辑')`)
      for (let i = 0; i < 4; i++) { await scrollToEnd(); await pause(180) }
      if (requests.filter(r => r.source === 'netease' && r.kind === 'album' && r.offset === 8).length !== 1) throw Error('失败来源出现自动重试循环')
      if (!requests.some(r => r.source === 'roon' && r.kind === 'album' && r.offset === 16)) throw Error('一个来源失败不应阻塞另一来源')
      await evaluate(`[...document.querySelectorAll('button')].find(e => e.textContent === '重试网易云专辑').click()`)
      for (let i = 0; i < 4; i++) { await scrollToEnd(); await pause(180) }
      await waitFor(`document.querySelectorAll('.search-album-card').length === 36`)
      const countAtEnd = requests.length
      await scrollToEnd(); await pause(300)
      if (requests.length !== countAtEnd) throw Error('到末页后仍然发请求')
      await evaluate(`document.querySelector('.content-scroll').scrollTop = 0`)
      await capture('albums-category')
      await evaluate(`[...document.querySelectorAll('.search-category-tabs button')].find(e => e.textContent === '艺人').click()`)
      await waitFor(`document.querySelectorAll('.artist-primary').length > 2 && !document.querySelector('#search-albums-heading')`)
      for (let i = 0; i < 4; i++) { await scrollToEnd(); await pause(180) }
      await waitFor(`document.querySelectorAll('.artist-primary').length === 23`)
      await evaluate(`document.querySelector('.content-scroll').scrollTop = 0`)
      const artistLayout = await evaluate(`({ columns: getComputedStyle(document.querySelector('.search-card-grid-artists')).gridTemplateColumns.split(' ').length, avatar: document.querySelector('.search-artist-art').getBoundingClientRect().width })`)
      if (artistLayout.columns !== 6 || artistLayout.avatar < 120) throw Error('艺人未呈现六列大头像')
      await capture('artists-category')
      await evaluate(`[...document.querySelectorAll('.search-category-tabs button')].find(e => e.textContent === '综合').click()`)
      await waitFor(`document.querySelectorAll('.search-song').length === 6 && document.querySelectorAll('.search-album-card').length === 6`)

      await evaluate(`document.querySelector('#search-tracks-heading').scrollIntoView({ block: 'start' })`)
      await capture('six-songs')
      await evaluate(`document.querySelector('.content-scroll').scrollTop = 0`)
      const layout = await evaluate(`({ headings: [...document.querySelectorAll('.search-result-section h3')].map(e => e.textContent), songs: document.querySelectorAll('.search-song').length, columns: getComputedStyle(document.querySelector('.search-song-preview')).gridTemplateColumns.split(' ').length })`)
      if (JSON.stringify(layout.headings) !== JSON.stringify(['艺人', '专辑', '单曲']) || layout.columns !== 2) throw Error('搜索布局不符合六首双列布局')
      await evaluate(`document.querySelector('.search-album-card').click()`)
      await waitFor(`document.querySelector('#roon-album-heading')?.textContent === '合成 Roon 专辑' && document.body.textContent.includes('合成本地歌曲')`)
      await capture('roon-album-detail')
      await evaluate(`document.querySelector('.roon-album-detail-view .back-link').click()`)
      await waitFor(`document.querySelectorAll('.search-song').length === 6`)
      await evaluate(`document.querySelector('.artist-primary').click()`)
      await waitFor(`document.querySelector('#roon-artist-heading')?.textContent === '合成艺人'`)
      await evaluate(`document.querySelector('[aria-labelledby="roon-artist-heading"] .back-link').click()`)
      await waitFor(`!!document.querySelector('#search-tracks-heading')`)
      await evaluate(`[...document.querySelectorAll('.artist-sources button')].find(e => e.textContent === '网易云').click()`)
      await waitFor(`!!document.querySelector('.search-detail-hero') && !!document.querySelector('.view-search [role="table"]')`)
      await evaluate(`document.querySelector('.view-search .back-link').click()`)
      await waitFor(`document.querySelectorAll('.search-song').length === 6`)
      await evaluate(`document.querySelector('#search-tracks-heading').parentElement.querySelector('button').click()`)
      await waitFor(`!!document.querySelector('.search-track-results [role="table"]') && !document.querySelector('#search-albums-heading')`)
      if (await evaluate(`!!document.querySelector('#roon-search-heading')`)) throw Error('单曲分类仍显示底部 Roon 分区')
      if (requests.some(r => r.kind === 'track')) throw Error('单曲分类不应额外查询 Roon 单曲块')
      await capture('all-songs')
      await evaluate(`document.querySelector('.view-search .back-link').click()`)
      await waitFor(`document.querySelectorAll('.search-song').length === 6`)
      window.setContentSize(720, 800)
      await capture('search-narrow')
      const clearance = await evaluate(`parseFloat(getComputedStyle(document.querySelector('.view-search')).paddingBottom)` )
      if (clearance > 32) throw Error('搜索重复叠加底部避让')
      const overflow = await evaluate(`document.documentElement.scrollWidth > innerWidth`)
      if (overflow) throw Error('窄窗口存在水平溢出')
      await writeFile(`${directory}/result.json`, JSON.stringify({ passed: true, layout, artistLayout, requests, overflow, evidence: '隔离合成数据，未验证真实播放' }, null, 2))
      console.log('SEARCH_UI_PASS')
    } catch (error) {
      console.error(error)
      process.exitCode = 1
    } finally { app.quit() }
  })
})
try {
  await import('../dist/main/index.js')
} catch (error) {
  console.error(error)
  app.exit(1)
}
