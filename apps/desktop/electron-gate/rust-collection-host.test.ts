import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { _electron as electron, type ElectronApplication, type Page, type Locator } from '@playwright/test'
import { testElectronArguments } from '../scripts/test-keychain.mjs'
import { waitForMainWindow } from '../e2e/main-window.js'
import { seedCollectionHost } from '../test/helpers/rust-collection-host-seed.js'
import { buildRoot, manifest, manifestPath, manifestSha256, sha256, count, naturalResources, scrubbedEnvironment, until, type HostSnapshot, type HostObservation } from '../test/helpers/rust-collection-host-evidence.js'

const reports: Record<string, unknown>[] = []
const require = createRequire(import.meta.url), electronPackage = path.dirname(require.resolve('electron/package.json'))
const electronPathFile = path.join(electronPackage, 'path.txt')
assert.ok(existsSync(electronPathFile), '缺少既有Electron；禁止隐式安装。')
const executablePath = path.join(electronPackage, 'dist', readFileSync(electronPathFile, 'utf8').trim())
assert.ok(existsSync(executablePath), '缺少真实Electron可执行文件。')
assert.equal(sha256(executablePath), '1af684f056a8eb13e49fbd677072e437316086b076e3b9b92de3ddb343edc5b1')
async function control(application: ElectronApplication, operation: string, parameters: Record<string, unknown> = {}) {
  return application.evaluate(async (_electron, input) => {
    const host = (globalThis as typeof globalThis & { __rust009Host: { control(operation: string, parameters?: unknown): Promise<unknown> } }).__rust009Host
    return host.control(input.operation, input.parameters)
  }, { operation, parameters })
}
interface UiRequest { requestId: string; command: string; actionId: string; request: any; reply: any; oracle: any; route: string; ownerSequence?: number; rustAckSequence?: number; pid?: number; generation?: number; scope?: unknown }
interface Action { id: string; role: string; method: string; locator: string; startedMs: number; completedMs: number; dom: unknown; screenshot: {path: string; sha256: string}; requestIds: string[] }

for (const [rust, models] of [[false,100],[true,100],[true,2000],[true,5000]] as const) {
  test(`真实收藏Vue页面 ${rust ? 'Rust' : '默认Node'} ${models}：浏览与辅助链、原表单单写与可信刷新`, {timeout:240_000}, async t => {
    const directory = await mkdtemp(path.join(buildRoot, 'musicbridge-ui-e2e-rust009-'))
    const seed = await seedCollectionHost(directory, models), tick = performance.now()
    const application = await electron.launch({ executablePath, args:testElectronArguments([path.join(buildRoot,'main',rust ? `private-rust-collection-main-${models}-wrapper.mjs` : 'private-rust-collection-node-main-wrapper.mjs')],'mock'), cwd:path.resolve('.'), timeout:60_000,
      env:Object.fromEntries(Object.entries(scrubbedEnvironment({TMPDIR:buildRoot,MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR:directory,MUSIC_BRIDGE_UI_E2E_LIFECYCLE_TRACE:'1'})).filter((entry): entry is [string,string] => typeof entry[1] === 'string')) })
    const owned = application.process()
    let closed = false, output = ''
    owned.stderr?.on('data', chunk => { output += String(chunk) })
    owned.stdout?.on('data', chunk => { output += String(chunk) })
    const status = async () => await control(application,'status') as HostSnapshot
    const seen = new Set<string>(), actions: Action[] = [], requests: UiRequest[] = []
    t.after(async () => { await writeFile(path.join(directory,'scene-attempt.json'),JSON.stringify({schemaVersion:1,task:'RUST-009',purpose:'保留本次尝试与失败诊断，不替代最终验收报告',models,rust,seed,actions,requests},null,2)+'\n') })
    async function close() {
      closed = true
      await application.evaluate(({app}) => { app.quit() }).catch(() => undefined)
      await until(() => owned.exitCode !== null || owned.signalCode !== null,'Electron自然退出')
      assert.equal(owned.exitCode,0); assert.equal(owned.signalCode,null)
      return JSON.parse(await readFile(path.join(directory,'rust009-main-evidence.json'),'utf8')) as { final: HostSnapshot; main: any[]; coreExit: number }
    }
    t.after(async () => { if (!closed) { t.diagnostic(output); await close() } })
    const page = await waitForMainWindow(application)
    await page.locator('[data-sidebar-source="collection"]').waitFor()
    await until(async () => count(await status(),'node.claimComplete') >= 2,'真实1500ms worker初始两次空领取')
    const initial = await status()
    if (rust) assert.equal(initial.controller?.router?.phase,'rust')
    else { assert.equal(count(initial,'rust.spawn'),0); assert.equal(count(initial,'node.export')+count(initial,'node.exportLarge'),0) }
    const initialStatus = initial.controller
    async function collect(actionId: string, start: number): Promise<string[]> {
      const snapshot = await status(), ids: string[] = []
      for (const observed of snapshot.observations.filter(item => item.event === 'core.publicRequest' && item.sequence > start && item.request && !seen.has(String(item.requestId)))) {
        const reply = snapshot.observations.find(item => item.event === 'core.publicReply' && item.requestId === observed.requestId)
        assert.ok(reply?.reply,'完整公开回执必须闭合后再记录动作。')
        const request = observed.request as any, envelope = reply.reply as any
        const node = snapshot.observations.find(item => item.event === 'node.dispatch' && item.requestId === request.id)
        const ack = snapshot.observations.find(item => item.event === 'rust.frame' && item.requestId === request.id && item.operation === 'dispatch' && item.ok)
        const ownerStatus = (observed.status as any)?.router
        const entry: UiRequest = {requestId:request.id,command:request.command,actionId,request,reply:envelope,oracle:undefined,route:ack ? 'rust':'node',
          ...(node ? {ownerSequence:node.sequence}:{}), ...(ack ? {rustAckSequence:ack.sequence,pid:Number(ack.pid),generation:ownerStatus.generation,scope:ownerStatus}:{}),
        }
        if (request.command !== 'commandOutbox.execute') {
          const oracle = await control(application,'oracle',{request})
          assert.deepEqual(envelope,oracle,`SQLite完整DTO差分：${request.command}`)
          entry.oracle = {kind:'independent-Node-SQLite',request,reply:oracle}
        }
        seen.add(request.id); ids.push(request.id); requests.push(entry)
      }
      return ids
    }
    async function act(role: string, method: 'click'|'fill'|'selectOption', locator: Locator, value?: string, ready?: () => Promise<void>) {
      const id = `action-${actions.length+1}`, before = await status(), startedMs = performance.now()-tick
      if (method === 'click') await locator.click()
      else if (method === 'fill') await locator.fill(value!)
      else await locator.selectOption(value!)
      if (ready) await ready()
      // UI渲染与图片解码要有机会完成；该等待从不作为Core精确性能。
      await page.waitForTimeout(120)
      await until(async () => { const state = await status(); return state.observations.filter(item => item.sequence > before.observations.length && item.event === 'core.publicRequest' && item.request).every(item => state.observations.some(reply => reply.event === 'core.publicReply' && reply.requestId === item.requestId)) },'公开动作读取完成')
      const requestIds = await collect(id,before.observations.length)
      const dom = await page.evaluate(() => ({cards:Array.from(document.querySelectorAll('.inventory-card-title')).map(node => node.textContent!.trim()),tableRows:Array.from(document.querySelectorAll('.inventory-table tbody tr th button')).map(node => node.textContent!.trim()),pagination:document.querySelector('.inventory-pagination span')?.textContent?.trim(),url:location.href,heading:Array.from(document.querySelectorAll('h1,h2,h3')).filter(node => (node as HTMLElement).offsetParent !== null).map(node => node.textContent).join(' / '),text:document.body.innerText,mounted:!!document.querySelector('[data-component="CollectionView"]')}))
      const listRequest = [...requests].reverse().find(item => item.command === 'collection.list' && item.request.payload.page.limit === 24 && item.actionId === id)
      if (listRequest && (dom.cards.length || dom.tableRows.length)) {
        const labels = listRequest.reply.result.items.map((model: {brand:string;name:string}) => `${model.brand} ${model.name}`)
        assert.deepEqual(dom.cards.length ? dom.cards : dom.tableRows,labels,'真实页面型号顺序必须与完整DTO/SQLite一致')
      }
      const screenshotPath = path.join(directory,`${id}-${role}.png`)
      await page.screenshot({path:screenshotPath})
      actions.push({id,role,method,locator:locator.toString(),startedMs,completedMs:performance.now()-tick,dom,screenshot:{path:path.relative(buildRoot,screenshotPath),sha256:sha256(screenshotPath)},requestIds})
      const state = await status()
      if (rust && !['write','fallback','refreshed-list'].includes(role)) assert.equal(state.controller?.router?.phase,'rust',`纯读动作不能撤销Rust：${role}`)
      return id
    }
    const button = (name: string) => page.getByRole('button',{name,exact:true})
    const collection = page.locator('[data-component="CollectionView"]')
    await act('navigate','click',page.locator('[data-sidebar-source="collection"]'),undefined,async () => { await collection.locator('.inventory-card').first().waitFor() })
    await act('navigate','click',page.locator('[data-collection-view="tapes"]'))
    assert.match(await collection.innerText(),new RegExp(`${models} 个型号`))
    await act('page','click',page.getByRole('navigation',{name:'收藏分页'}).getByRole('button',{name:'下一页',exact:true}))
    await act('page','click',page.getByRole('navigation',{name:'收藏分页'}).getByRole('button',{name:'上一页',exact:true}))
    await act('filter','fill',page.getByPlaceholder('搜索品牌、型号、版次…'),'SA 90%')
    await act('filter','click',button('筛选'))
    await act('filter','click',button('清除'))
    await act('filter','selectOption',collection.locator('.state-filter select'),'needs-review')
    await act('filter','click',button('清除'))
    await act('filter','selectOption',collection.locator('#collection-filters select').first(),'1990')
    await act('filter','click',button('清除'))
    await act('page','click',button('我的库存'))
    await act('page','click',button('磁带墙'))
    await act('detail','click',collection.locator('.inventory-card').first(),undefined,async () => { await page.locator('.model-detail').waitFor() })
    const detail = page.locator('.model-detail')
    assert.match(await detail.innerText(),new RegExp(seed.modelId))
    await act('detail','click',detail.getByRole('tab',{name:'我的库存',exact:true}))
    await act('page','click',page.getByRole('navigation',{name:'库存详情分页'}).getByRole('button',{name:'下一页',exact:true}))
    await act('detail','click',detail.getByRole('tab',{name:'资料照片',exact:true}))
    await page.locator('[data-photo-state="ready"] img').first().waitFor()
    assert.ok(await page.locator('[data-photo-state="ready"] img').first().evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0),'有效合成照片必须真实解码')
    await act('detail','click',button('← 返回收藏'))
    await act('progress','click',page.getByRole('button',{name:'完成度与求购',exact:true}))
    const progress = page.getByTestId('collection-progress-panel')
    await act('progress','selectOption',progress.getByLabel('参考书籍'),seed.bookId)
    await act('progress','selectOption',progress.getByLabel('目录修订'),seed.previousCatalogRevision)
    await act('progress','selectOption',progress.getByLabel('目录修订'),seed.currentCatalogRevision)
    await act('wants','click',progress.getByRole('button',{name:'求购清单',exact:true}))
    await act('history','click',progress.getByRole('button',{name:'查看求购历史',exact:true}).first())
    assert.match(await progress.innerText(),/合成求购第二版/)
    await act('history','click',progress.getByRole('button',{name:'读取完成度快照历史',exact:true}))
    await act('history','click',progress.getByRole('button',{name:'读取此完成度快照',exact:true}).first())
    await act('history','click',progress.getByText('旧目录快照（旧口径）',{exact:true}))
    await act('history','click',progress.getByRole('button',{name:'读取旧口径快照',exact:true}).first())
    await act('history','click',progress.getByRole('button',{name:'关闭',exact:true}))
    await act('reference','click',button('参考目录与版次'))
    const reference = page.getByRole('dialog',{name:'参考目录与版次'})
    await act('reference','click',reference.getByRole('button',{name:'整理此来源',exact:true}).first())
    await act('reference','click',reference.getByRole('button',{name:/资料来源/}))
    assert.match(await reference.innerText(),/当前来源的 ZIP 容器回执/)
    await act('reference','click',reference.getByRole('button',{name:/历史快照/}))
    await act('reference','click',reference.getByRole('button',{name:'查看版次',exact:true}).last())
    // 两份已存在快照通过原select与比较控件读取，不生成新资料。
    const beforeOptions = await reference.getByLabel('前一快照').locator('option').evaluateAll(nodes => nodes.map(node => (node as HTMLOptionElement).value).filter(Boolean))
    await act('reference','selectOption',reference.getByLabel('前一快照'),beforeOptions.at(-1)!)
    await act('reference','selectOption',reference.getByLabel('后一快照'),beforeOptions[0]!)
    await act('reference','click',reference.getByRole('button',{name:'只读比较快照',exact:true}))
    await act('reference','click',reference.getByRole('button',{name:'关闭',exact:true}))
    await act('reference','click',reference.getByRole('button',{name:'确认关闭',exact:true}))
    const preWrite = await status()
    if (rust) { assert.deepEqual(preWrite.controller,initialStatus); assert.equal(count(preWrite,'rust.spawn'),1) }
    let outbox: Record<string,unknown> | undefined, refreshWindow: Record<string,unknown> | undefined, afterWriteStatus: unknown, refreshedStatus: unknown, postRefreshNullClaimCount = 0
    if (rust) {
      await act('detail','click',collection.locator('.inventory-card').first())
      await act('write','click',detail.getByText('收藏保护设置',{exact:true}))
      await act('write','selectOption',detail.getByLabel('收藏策略'),'collector')
      await act('write','fill',detail.getByLabel('最低未开封保留数量'),'1')
      const writeAction = await act('write','click',button('保存保护设置'))
      const written = await status(); afterWriteStatus = written.controller
      assert.equal(written.controller?.router?.phase,'stale'); assert.equal(count(written,'rust.spawn'),1)
      const write = requests.find(item => item.actionId === writeAction && item.command === 'commandOutbox.execute')!
      assert.ok(write)
      outbox = {actionId:writeAction,commandId:write.request.payload.payload.commandId,executeRequestId:write.requestId,refreshCalls:1,succeededRows:1,acknowledgedRows:1}
      await act('write','click',button('← 返回收藏'))
      await act('fallback','click',page.getByRole('navigation',{name:'收藏分页'}).getByRole('button',{name:'下一页',exact:true}))
      await act('fallback','click',page.getByRole('navigation',{name:'收藏分页'}).getByRole('button',{name:'上一页',exact:true}))
      await control(application,'armExport')
      const refreshing = control(application,'refresh')
      await until(async () => (await status()).observations.some(item => item.event === 'host.exportHeld'),'真实导出返回进入受控等待')
      const held = (await status()).observations.find(item => item.event === 'host.exportHeld')!
      await until(async () => (await status()).observations.filter(item => item.event === 'core.publicReply' && item.command === 'recordingPrintWorker.claim' && item.leaseNull && item.sequence > held.sequence).length >= 2,'刷新导出窗口跨两次真实1500ms空claim')
      await control(application,'releaseExport')
      const refreshed = await refreshing as HostSnapshot; refreshedStatus = refreshed.controller
      assert.equal(refreshed.controller?.router?.phase,'rust'); assert.equal(count(refreshed,'rust.spawn'),2)
      const release = refreshed.observations.find(item => item.event === 'host.exportReleased')!
      refreshWindow = {startedMs:held.elapsedMs,completedMs:release.elapsedMs,phase:'export',claimSequences:refreshed.observations.filter(item => item.event === 'node.claimComplete' && item.sequence > held.sequence && item.sequence < release.sequence).map(item => item.sequence)}
      const claims = count(refreshed,'node.claimComplete')
      await until(async () => count(await status(),'node.claimComplete') >= claims+2,'刷新后真实worker两次空claim')
      const retained = await status(); assert.deepEqual(retained.controller,refreshed.controller)
      postRefreshNullClaimCount = count(retained,'node.claimComplete')-claims
      await act('refreshed-list','click',page.getByRole('navigation',{name:'收藏分页'}).getByRole('button',{name:'下一页',exact:true}))
      await act('refreshed-list','click',page.getByRole('navigation',{name:'收藏分页'}).getByRole('button',{name:'上一页',exact:true}))
      await act('refreshed-list','click',collection.locator('.inventory-card').first())
      assert.equal(await detail.getByLabel('收藏策略').inputValue(),'collector')
    }
    const versions = await application.evaluate(() => ({node:process.versions.node,electron:process.versions.electron,chrome:process.versions.chrome}))
    const electronPid = owned.pid, evidence = await close()
    assert.equal(evidence.coreExit,0)
    if (outbox) {
      const db = new DatabaseSync(path.join(directory,'data','command-outbox.v1.sqlite'),{readOnly:true})
      const rows = db.prepare('SELECT e.command_id,s.state,s.acknowledged,s.result_json FROM outbox_entries e JOIN outbox_states s ON s.id=e.id WHERE e.command_id=?').all(String(outbox.commandId)); db.close()
      assert.equal(rows.length,1); assert.equal(rows[0]!.state,'succeeded'); assert.equal(rows[0]!.acknowledged,1)
      const write = requests.find(item => item.requestId === outbox!.executeRequestId)!
      const durableReply = {...write.reply,result:{command:write.request.payload.command,result:JSON.parse(String(rows[0]!.result_json))}}
      assert.deepEqual(write.reply,durableReply)
      write.oracle = {kind:'independent-Node-SQLite-durable-outbox',request:write.request,reply:durableReply}
    }
    reports.push({scenario:rust ? 'explicit-rust-collection-UI-outbox-refresh':'default-node-collection-UI',models,directory,electronPid,runtimeVersions:versions,electronExit:{code:0,signal:null},
      staticProfile:{profile:models===5000?'v3-5000':'default',maxModels:models===5000?5000:2000,maxJsonBytes:models===5000?8388608:4194304,binarySha256:manifest.binarySha256},
      initialStatus,afterWriteStatus,refreshedStatus,initialNullClaimCount:count(initial,'node.claimComplete'),postRefreshNullClaimCount,exportCount:count(evidence.final,'node.export')+count(evidence.final,'node.exportLarge'),
      ui:{entry:'production-Vue-collection',apiOnly:false,actions,requests,oracleSummary:seed,pageCoverage:'实际未筛选第1/2页与筛选首屏；详情第1/2页。未宣称遍历所有UI页。'},oracleSummary:seed,
      refreshWindow,outbox,resources:naturalResources(evidence.final,rust?2:0,models===5000?models:undefined),main:evidence.main,observations:evidence.final.observations,mockKeychain:true,
      actualLayers:['Electron','Main-index','CoreSupervisor','utilityProcess','sharedDesktopCoreHost','production-DatasetOwner-entry','original-preload-outbox','Main-durable-outbox-service-executor','actual-recordingPrintWorker','production-Vue-collection'],completeSceneElapsedMs:performance.now()-tick})
  })
}
test('保存真实收藏页面冻结报告',async () => {
  assert.equal(reports.length,4)
  const output = process.env.MUSIC_BRIDGE_RUST_COLLECTION_ELECTRON_REPORT
  assert.ok(output && path.isAbsolute(output))
  await writeFile(output,JSON.stringify({schemaVersion:1,task:'RUST-009',evidenceLayer:'real-Electron-production-Main-collection-UI',sourceSha:manifest.sourceSha,sourceAggregateSha256:manifest.sourceAggregateSha256,
    artifactManifestPath:manifestPath,artifactManifestSha256:manifestSha256,artifacts:manifest.artifacts,sources:manifest.sources,binaryPath:manifest.binaryPath,binarySha256:manifest.binarySha256,nodeVersion:process.version,scenarios:reports,productionDefault:'Node',
    electronExecutablePath:executablePath,electronExecutableSha256:sha256(executablePath),costs:'观测等待不作精确Core性能；UI仅覆盖所列实际页。',realProvider:'NOT_RUN',realRoon:'NOT_RUN',realAccount:'NOT_RUN',realAudioRecording:'NOT_RUN',pdfDevice:'NOT_RUN',systemKeychain:'NOT_RUN',installedApplication:'NOT_CHANGED',ownerAcceptance:'NOT_RUN'},null,2)+'\n')
})
