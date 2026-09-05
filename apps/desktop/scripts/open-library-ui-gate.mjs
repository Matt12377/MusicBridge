import { app, net, BrowserWindow, nativeTheme } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
if (process.env.MUSIC_BRIDGE_UI_E2E !== '1' || process.env.MUSIC_BRIDGE_CORE_TEST_MODE !== '1' || !process.env.MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR) throw new Error('仅允许隔离合成验证')
const outputDirectory = process.env.MUSIC_BRIDGE_AMBIENT_QA_DIR
if (!outputDirectory?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/')) throw new Error('视觉证据目录必须位于外置临时根')
await mkdir(outputDirectory, { recursive: true })
const outputPath = name => `${outputDirectory}/${name}`
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
let captured = false
app.on('browser-window-created', (_event, window) => {
  if (captured) return
  captured = true
  window.webContents.on('console-message', details => { if(details.level === 'error') console.log('RENDERER_ERROR', details.message) })
  window.webContents.session.protocol.handle('https', request => {
    const url = new URL(request.url)
    if (url.hostname === 'p1.music.126.net' && /synthetic-(cover|avatar)\.jpg/.test(url.pathname)) return net.fetch(new URL(`../../../prototypes/sakura-glass/assets/cover-${process.env.MUSIC_BRIDGE_APPEARANCE_GATE === '1' ? 2 : 1}.jpg`, import.meta.url).href)
    return new Response('', { status: 404 })
  })
  window.webContents.once('did-finish-load', async () => {
    const evaluate = code => window.webContents.executeJavaScript(code)
    const waitFor = async code => {
      for (let attempt = 0; attempt < 60; attempt++) { if (await evaluate(code)) return; await delay(100) }
      throw new Error(`界面条件未满足：${code}`)
    }
    try {
      window.setTitle('Music Bridge · 开放布局验证（合成数据）'); window.show()
      await waitFor(`!!document.querySelector('.global-player')`)
      const capture = async name => { await delay(250); await writeFile(outputPath(name+'.png'),(await window.webContents.capturePage()).toPNG()) }
      const theme = async value => {
        await evaluate(`document.querySelector('.sidebar-settings-button').click()`)
        await waitFor(`!!document.querySelector('#settings-tab-application')`)
        await evaluate(`document.querySelector('#settings-tab-application').click()`)
        await waitFor(`!!document.querySelector('input[name="appearance-theme"][value="${value}"]')`)
        await evaluate(`document.querySelector('input[name="appearance-theme"][value="${value}"]').click()`)
        await evaluate(`document.querySelector('[data-sidebar-source="home"]').click()`)
      }
      const sidebarOrder=await evaluate(`[...document.querySelectorAll('.sidebar-primary-navigation .sidebar-nav-row')].map(e=>e.textContent.trim())`)
      if(JSON.stringify(sidebarOrder)!==JSON.stringify(['主页','专辑','艺术家','流派','收藏','实物收藏','录音'])) throw Error('侧栏顺序不符：'+JSON.stringify(sidebarOrder))
      await evaluate(`document.querySelector('.sidebar-playlist-toggle').click()`)
      if(await evaluate(`!!document.querySelector('[data-sidebar-source="roon-playlists"]')`)) throw Error('收起后仍显示歌单来源')
      window.setContentSize(1440,819)
      await capture('sidebar-folded')
      await evaluate(`document.querySelector('.sidebar-playlist-toggle').click()`)
      await waitFor(`!!document.querySelector('[data-sidebar-source="roon-playlists"]')`)
      await evaluate(`document.querySelector('[data-sidebar-source="roon-playlists"]').click()`)
      await waitFor(`!!document.querySelector('#roon-playlists-heading')`)
      await capture('sidebar-roon-playlists')
      console.log('SIDEBAR_NAV_PASS',JSON.stringify(sidebarOrder))
      for (const value of ['light','dark']) {
        await theme(value)
        for (const [width,height] of [[1980,1080],[1440,819],[720,640]]) {
          window.setContentSize(width,height); await delay(200)
          const layout = await evaluate(`(() => {
            const player = document.querySelector('.global-player'), r = player.getBoundingClientRect();
            const settings=document.querySelector('.sidebar-settings-button'), sr=settings.getBoundingClientRect();
            const controls = [...player.querySelectorAll('button,input')].map(e=>e.getBoundingClientRect());
            return {width:${width},playerWidth:r.width,playerCentered:Math.abs(r.left+r.width/2-innerWidth/2)<1, settingsReachable:settings.contains(document.elementFromPoint(sr.left+sr.width/2,sr.top+sr.height/2)), fits:controls.every(b=>b.left >= r.left && b.right <= r.right+1 && b.top>=r.top && b.bottom<=r.bottom+1), overlaps: controls.some((a,i)=>controls.some((b,j)=>j>i&&Math.min(a.right,b.right)-Math.max(a.left,b.left)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1)), timelineWidth:document.querySelector('.player-timeline').offsetWidth,timelineCentered:Math.abs(document.querySelector('.player-timeline').getBoundingClientRect().left+document.querySelector('.player-timeline').offsetWidth/2-innerWidth/2)<1,qualityHeight:document.querySelector('.player-quality-button').offsetHeight,zoneHeight:document.querySelector('.player-zone-button').offsetHeight};
          })()`)
          if (layout.playerWidth>1120 || !layout.playerCentered || layout.timelineWidth>360 || !layout.timelineCentered || !layout.settingsReachable || !layout.fits || layout.overlaps || layout.qualityHeight !== layout.zoneHeight) throw Error(JSON.stringify(layout))
          console.log('OPEN_LAYOUT_PASS',value,JSON.stringify(layout)); await capture('home-'+value+'-'+width)
        }
      }
      window.setContentSize(1980,1080)
      await evaluate(`document.querySelector('[data-sidebar-source="playlists"]').click()`)
      await waitFor(`!!document.querySelector('.playlist-card')`)
      const card=await evaluate(`(() => {const c=document.querySelector('.playlist-card'), s=getComputedStyle(c), a=c.querySelector('.playlist-art');return {width:a.offsetWidth,padding:s.padding,border:s.borderTopWidth,background:s.backgroundColor};})()`)
      if(card.width<210 || card.padding!=='0px' || card.border!=='0px' || card.background!=='rgba(0, 0, 0, 0)') throw Error(JSON.stringify(card))
      await capture('playlists-dark')
      console.log('OPEN_COVER_PASS',JSON.stringify(card))
      window.setContentSize(1440,819)
      await evaluate(`document.querySelector('[data-sidebar-source="home"]').click()` )
      await waitFor(`!!document.querySelector('[aria-labelledby="liked-home-heading"] .text-button')`)
      await evaluate(`document.querySelector('[aria-labelledby="liked-home-heading"] .text-button').click()`)

      await waitFor(`!!document.querySelector('.track-row')`)
      const list = await evaluate(`(() => { const row=document.querySelector('.track-row'), art=row.querySelector('.track-art'); return {row:row.offsetHeight,art:art.offsetWidth,background:getComputedStyle(document.querySelector('.track-table-wrap')).backgroundColor,meta:!!row.querySelector('.track-quality-details')}; })()`)
      if(list.row!==84 || list.art!==64 || list.background!=='rgba(0, 0, 0, 0)' || list.meta) throw Error(JSON.stringify(list))
      await capture('list-dark')
      // 合成库有 120 首；等待每次触底的分页结束，最后再定位到真正末尾。
      for (let page=0;page<8;page++) {
        await evaluate(`document.querySelector('.content-scroll').scrollTo({top:100000,behavior:'instant'})`)
        await delay(300)
        if(await evaluate(`document.querySelectorAll('.track-row').length===120`)) break
      }
      await waitFor(`document.querySelectorAll('.track-row').length===120`)
      await evaluate(`document.querySelector('.content-scroll').scrollTo({top:100000,behavior:'instant'})`)
      await delay(100)
      const lastClear=await evaluate(`document.querySelector('.track-row:last-child').getBoundingClientRect().bottom <= document.querySelector('.global-player').getBoundingClientRect().top`)
      if(!lastClear) throw Error('列表末尾被播放栏遮挡：'+await evaluate(`JSON.stringify({last:document.querySelector('.track-row:last-child').getBoundingClientRect().bottom,player:document.querySelector('.global-player').getBoundingClientRect().top,scroll:document.querySelector('.content-scroll').scrollTop,height:document.querySelector('.content-scroll').scrollHeight})`))
      await evaluate(`document.querySelector('.content-scroll').scrollTop=0`)

      await evaluate(`window.musicBridge.selectZone('synthetic-zone')`)
      await evaluate(`document.querySelector('.liked-hero .primary-button').click()`)
      await waitFor(`!!document.querySelector('.now-playing-back')`)
      await evaluate(`document.querySelector('.now-playing-back').click()`)
      await waitFor(`!document.querySelector('.player-volume button').disabled`)
      const motion=await evaluate(`new Promise(resolve=>{const values=[];const started=performance.now();function tick(){values.push(Number(document.querySelector('.player-timeline input').value));if(performance.now()-started<1800)requestAnimationFrame(tick);else resolve({count:values.length,backwards:values.some((v,i)=>i>0&&v<values[i-1]),advance:values.at(-1)-values[0]})}tick()})`)
      if(motion.backwards || motion.advance<1500)throw Error('进度不连续：'+JSON.stringify(motion))
      console.log('PLAYER_MOTION_PASS',JSON.stringify(motion))
      await evaluate(`document.querySelector('.player-play-button').click()`)

      await waitFor(`document.querySelector('.player-play-button').getAttribute('aria-label')==='恢复播放'`)
      await waitFor(`!document.querySelector('.player-timeline input').disabled`)
      await evaluate(`(() => { const e=document.querySelector('.player-timeline input');e.value=65000;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true})); })()`)
      await waitFor(`document.querySelector('.player-timeline time').textContent==='1:05'`)
      const position = await evaluate(`window.musicBridge.getPlaybackState().then(s=>s.positionMs)`)
      if(position!==65000) throw Error('进度没有写入播放接口')
      await evaluate(`document.querySelector('.player-volume button').click()`)
      await waitFor(`!!document.querySelector('.volume-output input')`)
      await evaluate(`(() => {const e=document.querySelector('.volume-output input');e.value=39;e.dispatchEvent(new Event('input',{bubbles:true}));})()`)
      await waitFor(`window.musicBridge.getVolume().then(s=>s.outputs[0]?.value===39)`)
      if(await evaluate(`document.querySelector('.volume-output input').disabled`))throw Error('拖动时音量滑块被禁用')
      await evaluate(`document.querySelector('.volume-output input').dispatchEvent(new Event('change',{bubbles:true}))`)
      await waitFor(`document.querySelector('.volume-output small').textContent==='39'`)
      await delay(650)
      if(await evaluate(`document.querySelector('.volume-output input').value`)!=='39')throw Error('松手后音量回闪')

      const volume=await evaluate(`window.musicBridge.getVolume()`)
      if(volume.outputs[0]?.value!==39) throw Error('音量没有写入设备接口')
      await capture('player-volume-dark')
      await evaluate(`document.querySelector('.player-volume-panel .text-button').click()`)
      const quality = await evaluate(`document.querySelector('.player-quality-detail').textContent`)
      if(!quality.includes('FLAC') || !quality.includes('1,411')) throw Error('实际音质缺失：'+quality)
      await capture('player-details-dark')
      await theme('light')
      await evaluate(`document.querySelector('[data-sidebar-source="home"]').click()` )
      await waitFor(`!!document.querySelector('[aria-labelledby="liked-home-heading"] .text-button')`)
      await evaluate(`document.querySelector('[aria-labelledby="liked-home-heading"] .text-button').click()`)
      await capture('list-light')
      console.log('OPEN_LIBRARY_NATIVE_PASS',JSON.stringify({list,position,volume,quality}))
    } catch (error) { console.error(error); process.exitCode=1 }
    finally { app.quit() }
  })
})
await import('../dist/main/index.js')
