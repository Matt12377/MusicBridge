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
      window.setTitle('Music Bridge · 背景迁移验证（合成数据）')
      await waitFor(`!!document.querySelector('.global-player')`)
      await waitFor(`!!document.querySelector('.daily-recommendation-tile')`)
      await evaluate(`document.fonts.ready.then(() => { if(!document.fonts.check('16px bootstrap-icons')) throw Error('图标字体未加载') })`)
      if (process.env.MUSIC_BRIDGE_APPEARANCE_RESTORE === '1') {
        await delay(150)
        if(await evaluate(`document.documentElement.dataset.theme`)!=='dark' || nativeTheme.themeSource !== 'dark') throw Error('独立进程启动未恢复深色主题')
        console.log('APPEARANCE_COLD_RESTART_PASS')
        return
      }
      if (process.env.MUSIC_BRIDGE_APPEARANCE_GATE === '1') {
        window.setContentSize(1440,819)
        await evaluate(`document.querySelector('.sidebar-settings-button').click()`)
        await waitFor(`!!document.querySelector('#settings-tab-application')`)
        await evaluate(`document.querySelector('#settings-tab-application').click()`)
        await waitFor(`!!document.querySelector('input[name="appearance-theme"][value="dark"]')`)
        await evaluate(`document.querySelector('input[name="appearance-theme"][value="dark"]').click()`)
        await evaluate(`document.querySelector('[data-sidebar-source="home"]').click()`)
        await delay(250)
        await writeFile(outputPath('home-dark-idle.png'),(await window.webContents.capturePage()).toPNG())
        await evaluate(`document.querySelector('.sidebar-settings-button').click()`)
        await waitFor(`!!document.querySelector('#settings-tab-application')`)
        await evaluate(`document.querySelector('#settings-tab-application').click()`)
        await waitFor(`!!document.querySelector('input[name="appearance-theme"][value="light"]')`)
        await evaluate(`document.querySelector('input[name="appearance-theme"][value="light"]').click()`)
        await evaluate(`document.querySelector('[data-sidebar-source="home"]').click()`)
        await waitFor(`!!document.querySelector('.daily-recommendation-tile')`)
      }
      for (const [width, height] of [[1980,1080], [1440,819], [720,480]]) {
        window.setContentSize(width,height); window.show(); await delay(300)
        const homeLayout = await evaluate(`(() => {
          const grids = [...document.querySelectorAll('.home-cover-wall, .daily-recommendation-grid')];
          const sections = [...document.querySelectorAll('.home-media-section, .home-recent-section')];
          return {columns:grids.map(grid=>getComputedStyle(grid).gridTemplateColumns.split(' ').length),daily:document.querySelectorAll('.daily-recommendation-tile').length,continuePresent:!!document.querySelector('.home-continue-hero'),bare:sections.every(s=>{const c=getComputedStyle(s);return c.backgroundColor==='rgba(0, 0, 0, 0)'&&c.boxShadow==='none'&&c.borderTopWidth==='0px'}),artWidth:document.querySelector('.daily-recommendation-art').getBoundingClientRect().width};
        })()`)
        if (homeLayout.columns.some(count=>count!==(width>900?5:3)) || homeLayout.daily!==5 || homeLayout.continuePresent || !homeLayout.bare) throw new Error('主页布局不符合要求：'+JSON.stringify(homeLayout))
        console.log('主页检查通过',width,JSON.stringify(homeLayout))
        const result = await evaluate(`(() => {
          const p = document.querySelector('.global-player'), r = p.getBoundingClientRect();
          const controls = [...p.querySelectorAll('button')];
          const rects = controls.map(b => b.getBoundingClientRect());
          const fits = rects.every(b => b.width > 0 && b.left >= r.left && b.right <= r.right + 1 && b.top >= r.top && b.bottom <= r.bottom + 1);
          const overlap = rects.some((a,i) => rects.some((b,j) => j > i && Math.min(a.right,b.right)-Math.max(a.left,b.left)>1 && Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1));
          const settings = document.querySelector('.sidebar-settings-button'), s = settings.getBoundingClientRect();
          return { centered: Math.abs(r.left + r.width/2 - innerWidth/2)<1, fits, overlap, buttons:controls.length, topbar:!!document.querySelector('.topbar'), status:!!document.querySelector('.toolbar-status-button'), width:r.width, bodyBottom:document.querySelector('.app-main').getBoundingClientRect().bottom, sidebarBottom:document.querySelector('.music-sidebar').getBoundingClientRect().bottom, contentBottom:document.querySelector('.content-scroll').getBoundingClientRect().bottom, windowHeight:innerHeight, settingsReachable:settings.contains(document.elementFromPoint(s.left+s.width/2,s.top+s.height/2)) };
        })()`)
        if (!result.centered || !result.fits || result.overlap || result.buttons !== 7 || result.topbar || result.status || result.bodyBottom !== height || result.sidebarBottom !== height || result.contentBottom !== height || !result.settingsReachable) throw new Error(JSON.stringify({width,...result}))
        await writeFile(outputPath(`home-open-${width}.png`), (await window.webContents.capturePage()).toPNG())
        await evaluate(`document.querySelector('.content-scroll').scrollTop = 100000`)
        await delay(100)
        const lastVisible = await evaluate(`document.querySelector('.content-scroll').lastElementChild.getBoundingClientRect().bottom <= document.querySelector('.global-player').getBoundingClientRect().top`)
        if (!lastVisible) throw new Error('内容末尾被播放栏遮挡：'+width)
        await evaluate(`document.querySelector('.content-scroll').scrollTop = 0`)
        console.log('布局通过',width,JSON.stringify(result))
      }
      window.setContentSize(1440,819)
      const reference = new BrowserWindow({width:1440,height:819,useContentSize:true,show:false,webPreferences:{sandbox:true,contextIsolation:true,partition:'ambient-reference'}})
      await reference.loadURL('http://127.0.0.1:4186/ambient-study/')
      await reference.webContents.insertCSS('.study-bar{display:none!important}.app{height:100vh!important;min-height:0!important}')
      await reference.webContents.executeJavaScript('document.fonts.ready.then(()=>Promise.all([...document.images].map(img=>img.decode().catch(()=>{}))))')
      await delay(300)
      await writeFile(outputPath('reference-1440.png'),(await reference.webContents.capturePage()).toPNG())
      const measure = selectors => `(${(selectors => Object.fromEntries(Object.entries(selectors).map(([key,selector])=>{
        const e=document.querySelector(selector),c=getComputedStyle(e),r=e.getBoundingClientRect();return [key,{x:r.x,y:r.y,width:r.width,height:r.height,background:c.backgroundColor,filter:c.filter,blur:c.backdropFilter,radius:c.borderRadius,font:c.fontFamily,fontSize:c.fontSize,fontWeight:c.fontWeight,letterSpacing:c.letterSpacing}]
      }))).toString()})(${JSON.stringify(selectors)})`
      const referenceValues=await reference.webContents.executeJavaScript(measure({side:'.sidebar',player:'.player',art:'.cover-wrap',heading:'.welcome h1',section:'.section-head',wash:'.wash',scene:'.wallpaper img.visible'}))
      const actualValues=await evaluate(measure({side:'.music-sidebar',player:'.global-player',art:'.daily-recommendation-art',heading:'.home-browse-header h2',section:'.home-section-heading',wash:'.album-ambient-wash',scene:'.ambient-image-frame img'}))
      await writeFile(outputPath('comparison.json'),JSON.stringify({reference:referenceValues,actual:actualValues},null,2))
      for (const key of ['side','player','heading','section','wash','scene']) {
        for (const property of ['x','y','width','height','background','filter','blur','radius','font','fontSize','fontWeight','letterSpacing']) {
          if (!(key === 'heading' && property === 'width') && referenceValues[key][property] !== actualValues[key][property]) throw Error(`预览不一致：${key}.${property}`)
        }
      }
      console.log('AMBIENT_REFERENCE_PARITY_PASS')
      reference.destroy()
      await evaluate(`document.querySelector('[aria-labelledby="liked-home-heading"] .text-button').click()`)
      await waitFor(`!!document.querySelector('.liked-hero')`)
      await delay(250)
      await writeFile(outputPath('list-idle.png'),(await window.webContents.capturePage()).toPNG())
      console.log('SELECT_RESULT',await evaluate(`window.musicBridge.selectZone('synthetic-zone')`))
      await evaluate(`document.querySelector('.liked-hero .primary-button').click()`)
      await waitFor(`!!document.querySelector('.now-playing-back')`)
      await evaluate(`document.querySelector('.now-playing-back').click()`)
      await delay(600)
      console.log('PLAY_STATE',await evaluate(`JSON.stringify({label:document.querySelector('.player-play-button').getAttribute('aria-label'),cover:!!document.querySelector('.album-ambient-cover img')?.naturalWidth})`))
      await waitFor(`!!document.querySelector('.album-ambient-cover img')?.naturalWidth`)
      await delay(1100)
      await writeFile(outputPath('list-playing.png'),(await window.webContents.capturePage()).toPNG())
      const playingSource = await evaluate(`document.querySelector('.album-ambient-cover img').src`)
      await evaluate(`document.querySelector('.player-play-button').click()`)
      await delay(300)
      await waitFor(`document.querySelector('.player-play-button')?.getAttribute('aria-label') === '恢复播放'`)
      if(await evaluate(`document.querySelector('.album-ambient-cover img')?.src`)!==playingSource) throw Error('暂停后背景未保持')
      await writeFile(outputPath('list-paused.png'),(await window.webContents.capturePage()).toPNG())
      console.log('AMBIENT_PLAY_PAUSE_PASS')
      await evaluate(`document.querySelector('.sidebar-settings-button').click()`)
      await waitFor(`!!document.querySelector('#settings-tab-application')`)
      await evaluate(`document.querySelector('#settings-tab-application').click()`)
      if (process.env.MUSIC_BRIDGE_APPEARANCE_GATE === '1') {
        const chooseTheme = async theme => {
          await waitFor(`!!document.querySelector('input[name="appearance-theme"][value="${theme}"]')`)
          await evaluate(`document.querySelector('input[name="appearance-theme"][value="${theme}"]').click()`)
          await waitFor(`document.documentElement.dataset.theme === '${theme}'`)
          await delay(120)
          if(nativeTheme.themeSource !== theme) throw Error('原生主题不同步')
        }
        const beforePlayback = await evaluate(`window.musicBridge.getPlaybackState().then(s=>({state:s.state,id:s.currentTrack?.id,queue:s.queue,positionMs:s.positionMs}))`)
        await chooseTheme('dark')
        await writeFile(outputPath('settings-dark.png'),(await window.webContents.capturePage()).toPNG())
        const afterPlayback = await evaluate(`window.musicBridge.getPlaybackState().then(s=>({state:s.state,id:s.currentTrack?.id,queue:s.queue,positionMs:s.positionMs}))`)
        if(JSON.stringify(beforePlayback)!==JSON.stringify(afterPlayback)) throw Error('主题切换改变了播放状态')
        const invalidRejected = await evaluate(`window.musicBridge.setAppearanceTheme('system').then(()=>false,()=>true)`)
        if(!invalidRejected || nativeTheme.themeSource !== 'dark') throw Error('非法主题没有被拒绝')
        await evaluate(`document.querySelector('[data-sidebar-source="home"]').click()`)
        await delay(250)
        await writeFile(outputPath('home-dark-cover.png'),(await window.webContents.capturePage()).toPNG())
        const preservedCover = await evaluate(`document.querySelector('.album-ambient-cover img').src`)
        const darkMaterial = await evaluate(`({side:getComputedStyle(document.querySelector('.music-sidebar')).backgroundColor,player:getComputedStyle(document.querySelector('.global-player')).backgroundColor,wash:getComputedStyle(document.querySelector('.album-ambient-wash')).backgroundColor})`)
        const referenceDark = new BrowserWindow({width:1440,height:819,useContentSize:true,show:false,webPreferences:{sandbox:true,contextIsolation:true,partition:'ambient-dark-reference'}})
        await referenceDark.loadURL('http://127.0.0.1:4186/ambient-study/?theme=dark&state=playing')
        await referenceDark.webContents.insertCSS('.study-bar{display:none!important}.app{height:100vh!important;min-height:0!important}')
        await delay(1400)
        await writeFile(outputPath('reference-dark.png'),(await referenceDark.webContents.capturePage()).toPNG())
        const referenceMaterial = await referenceDark.webContents.executeJavaScript(`({side:getComputedStyle(document.querySelector('.sidebar')).backgroundColor,player:getComputedStyle(document.querySelector('.player')).backgroundColor,wash:getComputedStyle(document.querySelector('.wash')).backgroundColor})`)
        if(JSON.stringify(darkMaterial)!==JSON.stringify(referenceMaterial)) throw Error('深色预览材质不匹配')
        referenceDark.destroy()
        const reloaded = new Promise(resolve=>window.webContents.once('did-finish-load',resolve))
        window.webContents.reload(); await reloaded
        await waitFor(`!!document.querySelector('.sidebar-settings-button')`)
        if(await evaluate(`document.documentElement.dataset.theme`)!=='dark') throw Error('重新加载未恢复主题')
        await waitFor(`!!document.querySelector('.album-ambient-cover img')?.naturalWidth`)
        if(await evaluate(`document.querySelector('.album-ambient-cover img').src`)!==preservedCover) throw Error('重新加载丢失当前封面')
        await evaluate(`document.querySelector('.sidebar-settings-button').click()`)
        await waitFor(`!!document.querySelector('#settings-tab-application')`)
        await evaluate(`document.querySelector('#settings-tab-application').click()`)
        window.setContentSize(720,640)
        await delay(150)
        await writeFile(outputPath('settings-dark-narrow.png'),(await window.webContents.capturePage()).toPNG())
        await evaluate(`document.querySelector('input[name="appearance-theme"][value="dark"]').focus()`)
        window.webContents.sendInputEvent({type:'keyDown',keyCode:'Left'})
        window.webContents.sendInputEvent({type:'keyUp',keyCode:'Left'})
        await waitFor(`document.documentElement.dataset.theme === 'light'`)
        window.setContentSize(1440,819)
        await chooseTheme('light')
        await writeFile(outputPath('settings-light.png'),(await window.webContents.capturePage()).toPNG())
        if(await evaluate(`getComputedStyle(document.querySelector('.music-sidebar')).backgroundColor`)!==actualValues.side.background) throw Error('浅色材质未恢复')
        await chooseTheme('dark')
        window.webContents.session.flushStorageData()
        console.log('APPEARANCE_NATIVE_PASS 双向切换、保存恢复、原生主题、播放保持、非法参数拒绝和深色预览对照')
      }
      await waitFor(`!!document.querySelector('.command-outbox-entry')`)
      await evaluate(`document.querySelector('.command-outbox-entry').click()`)
      await waitFor(`!!document.querySelector('dialog.outbox-panel[open]')`)
      console.log('AMBIENT_NATIVE_PASS 布局与设置内未确认操作入口')
    } catch (error) { console.error('AMBIENT_NATIVE_FAIL',error.message); process.exitCode=1 }
    finally { app.quit() }
  })
})
await import('../dist/main/index.js')
