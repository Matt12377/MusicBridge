import { testElectronArguments } from '../scripts/test-keychain.mjs'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { waitForMainWindow } from './main-window.js'
import { openCollectionView, selectModelPage } from './collection-navigation.js'
import { e2eTemporaryRoot } from './temporary-root.js'

const desktopRoot = path.resolve(import.meta.dirname, '..')
const temporaryRoot = e2eTemporaryRoot()
let app: ElectronApplication | undefined
let page: Page
let userData: string
let tracingStarted = false

async function captureGeometry(name: string): Promise<void> {
  const native = await app!.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().startsWith('musicbridge://app/'))
    if (!window) throw new Error('正式主窗口未找到')
    return { bounds: window.getBounds(), contentBounds: window.getContentBounds(), zoomFactor: window.webContents.getZoomFactor() }
  })
  const renderer = await page.evaluate(() => ({ innerWidth, innerHeight, devicePixelRatio, visualViewport: window.visualViewport
    ? { width: window.visualViewport.width, height: window.visualViewport.height, scale: window.visualViewport.scale } : null }))
  await writeFile(test.info().outputPath(`${name}-geometry.json`), JSON.stringify({ native, renderer }, null, 2))
}

async function setNativeContentSize(width: number, height: number, requireExact = true): Promise<void> {
  const actual = await app!.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().startsWith('musicbridge://app/'))
    if (!window) throw new Error('正式主窗口未找到')
    window.setContentSize(size.width, size.height)
    return window.getContentBounds()
  }, { width, height })
  await expect.poll(async () => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width: actual.width, height: actual.height })
  if (requireExact) expect({ width: actual.width, height: actual.height }).toEqual({ width, height })
  process.stdout.write(`TASK085_WINDOW_REQUESTED=${width}x${height} ACTUAL_CONTENT=${actual.width}x${actual.height}\n`)
}

async function launch(): Promise<void> {
  const preloadBundle = await readFile(path.join(desktopRoot, 'dist/preload/index.cjs'), 'utf8')
  const preloadRequires = [...preloadBundle.matchAll(/\brequire\(["']([^"']+)["']\)/gu)].map(match => match[1]!)
  expect([...new Set(preloadRequires)], 'sandbox Preload 产物只允许此启动路径实际支持的 electron 外部模块').toEqual(['electron'])
  process.stdout.write('TASK085_STAGE=electron-launch\n')
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !/^(MUSIC_BRIDGE_|NETEASE_|ROON_)/u.test(key))) as Record<string, string>
  app = await electron.launch({
    timeout: 45_000, args: testElectronArguments([path.join(desktopRoot, 'dist/main/index.js')], 'mock'), cwd: desktopRoot,
    env: { ...inherited, MUSIC_BRIDGE_UI_E2E: '1', MUSIC_BRIDGE_UI_E2E_OFFLINE: '1', MUSIC_BRIDGE_CORE_TEST_MODE: '1', MUSIC_BRIDGE_SYNTHETIC_ROON_LIBRARY: '1', MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR: userData },
  })
  await app.context().tracing.start({ screenshots: true, snapshots: true, sources: true })
  tracingStarted = true
  process.stdout.write('TASK085_STAGE=main-window\n')
  page = await waitForMainWindow(app)
  page.on('pageerror', error => process.stdout.write(`TASK085_PAGE_ERROR=${error.message}\n`))
  page.on('console', message => { if (message.type() === 'error') process.stdout.write(`TASK085_CONSOLE_ERROR=${message.text()}\n`) })
  page.on('requestfailed', request => process.stdout.write(`TASK085_REQUEST_FAILED=${request.url()} ${request.failure()?.errorText}\n`))
  page.on('response', response => { if (response.status() >= 400) process.stdout.write(`TASK085_RESPONSE=${response.status()} ${response.url()}\n`) })
  process.stdout.write('TASK085_STAGE=dom-ready\n')
  await page.waitForLoadState('domcontentloaded')
  process.stdout.write(`TASK085_URL=${page.url()} TITLE=${await page.title()} API=${await page.evaluate(() => typeof window.musicBridge)}\n`)
  await expect(page.locator('#home-heading')).toBeVisible()
  await captureGeometry('00-startup-home')
  await page.screenshot({ path: test.info().outputPath('00-startup-home.png') })
  process.stdout.write('TASK085_STAGE=core-ready\n')
  await expect.poll(async () => (await page.evaluate(() => window.musicBridge.getCoreHealth())).runtime).toBe('ready')
}

test.beforeEach(async () => {
  test.setTimeout(120_000)
  userData = await realpath(await mkdtemp(path.join(temporaryRoot, 'musicbridge-ui-e2e-task085-')))
  await mkdir(test.info().outputDir, { recursive: true })
  await writeFile(test.info().outputPath('synthetic-user-data-path.txt'), userData)
  await launch()
})
test.afterEach(async () => {
  const running = app; app = undefined
  try {
    if (running && tracingStarted) await running.context().tracing.stop({ path: test.info().outputPath('task085-trace.zip') })
  } finally { tracingStarted = false; await running?.close() }
})

test('正式 App：指定单盘进入确切制作、明确预留与释放后回到原盘', async () => {
  await setNativeContentSize(1440, 900)
  await captureGeometry('01-wide-light')
  const fixture = await page.evaluate(async () => {
    const api = window.musicBridge
    const albums = await api.searchPhysicalRoonAlbums('', { offset: 0, limit: 20 })
    const tracks = await api.getRoonAlbumTracks(albums.items[0]!.reference, { offset: 0, limit: 20 })
    const references = [tracks.items[0]!.reference]
    const target = await api.appendMasterDraft({ commandId: crypto.randomUUID(), title: '085 指定单盘制作', programType: 'compilation', references, userConfirmed: true })
    const other = await api.appendMasterDraft({ commandId: crypto.randomUUID(), title: '085 其他制作', programType: 'compilation', references, userConfirmed: true })
    const stock = await api.receiveCollectionStock({ commandId: crypto.randomUUID(), model: {
      brand: '085 合成', name: '指定单盘', edition: '仅用于隔离 E2E', year: 1990, format: 'cassette', tapeType: 'II', identification: 'verified',
    }, lengthMinutes: 90, quantities: { sealedBlank: 0, openedBlank: 1, legacyUsed: 0, unclassified: 0 } })
    const materialized = await api.materializeCollectionCopy({ commandId: crypto.randomUUID(), lotId: stock.lotId!, bucket: 'openedBlank', action: 'identify' })
    return { draftId: target.draftId, otherDraftId: other.draftId, modelId: stock.modelId, physicalId: materialized.physicalId! }
  })
  const copy = () => page.evaluate(id => window.musicBridge.getCollectionCopy(id), fixture.physicalId)
  expect((await copy()).copy).toMatchObject({ physicalId: fixture.physicalId, usage: 'blank', available: true })

  await openCollectionView(page, 'tapes')
  await page.locator('.inventory-card').filter({ hasText: '指定单盘' }).click()
  const copyRow = page.locator('.model-detail .copy').filter({ hasText: fixture.physicalId })
  await selectModelPage(page, '概览')
  await page.locator('.content-scroll').evaluate(element => { element.scrollTop = 0 })
  await page.screenshot({ path: test.info().outputPath('01a-collection-overview-light-1440.png'), scale: 'css' })
  await selectModelPage(page, '实体磁带')
  await expect(copyRow).toBeVisible()
  await copyRow.scrollIntoViewIfNeeded()
  await page.screenshot({ path: test.info().outputPath('01b-collection-copy-light-1440.png'), scale: 'css' })
  await copyRow.getByRole('button', { name: '用于本次录音', exact: true }).click()
  await expect(page.locator('.recording-view .physical-intent')).toContainText(fixture.physicalId)
  expect((await copy()).copy.usage).toBe('blank')
  await page.locator('.draft-card').filter({ hasText: '085 指定单盘制作' }).click()
  await expect(page.getByRole('heading', { name: '085 指定单盘制作', exact: true })).toBeVisible()
  await expect(page.locator('.context-card').filter({ hasText: '这盘实物' })).toContainText(fixture.physicalId)

  await page.locator('.workbench-main').getByRole('button', { name: '估算分面与选带', exact: true }).click()
  const media = page.locator('.media-panel')
  await expect(media).toContainText(fixture.physicalId)
  await media.getByLabel('确认所选设备支持这些介质').check()
  await media.getByLabel('Type II', { exact: true }).check()
  await media.getByRole('button', { name: '重新计算', exact: true }).click()
  await expect(media.getByRole('button', { name: '保存分面规划', exact: true })).toBeEnabled()
  await media.getByRole('button', { name: '保存分面规划', exact: true }).click()
  await expect.poll(async () => (await page.evaluate(id => window.musicBridge.listMediaPlans(id), fixture.draftId)).plans.length).toBe(1)
  await media.getByRole('button', { name: '重新核对这盘', exact: true }).click()
  await expect(media.locator('.selected-copy')).toContainText(fixture.physicalId)
  await media.getByRole('checkbox', { name: `我确认预留指定的 ${fixture.physicalId}，暂不开始录音` }).check()
  await media.getByRole('button', { name: '确认预留这盘', exact: true }).click()
  await expect.poll(async () => (await copy()).copy.reservationOwner?.kind).toBe('recording-plan')
  const reserved = await copy()
  expect(reserved.copy.reservationOwner).toMatchObject({ kind: 'recording-plan', draftId: fixture.draftId })
  const planId = reserved.copy.reservationOwner?.kind === 'recording-plan' ? reserved.copy.reservationOwner.planId : ''
  expect(planId).toBeTruthy()
  expect((await page.evaluate(id => window.musicBridge.listMediaPlans(id), fixture.otherDraftId)).plans).toEqual([])
  await media.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.getByRole('heading', { name: '085 指定单盘制作', exact: true })).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('02-recording-reserved-light-1440.png'), scale: 'css' })
  await page.locator('.context-card').filter({ hasText: '这盘实物' }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: test.info().outputPath('02b-recording-reservation-context-light-1440.png'), scale: 'css' })

  await page.getByRole('button', { name: '查看实物收藏 →', exact: true }).click()
  await expect(copyRow).toBeVisible()
  await expect(copyRow).toHaveAttribute('data-returned-copy', 'true')
  await expect(copyRow.getByRole('button', { name: '这盘的制作', exact: true })).toBeVisible()
  await expect(copyRow.getByRole('button', { name: '取消库存预留', exact: true })).toHaveCount(0)
  await copyRow.getByRole('button', { name: '这盘的制作', exact: true }).click()
  await expect(page.getByRole('heading', { name: '085 指定单盘制作', exact: true })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: '对应的确切制作规划' })).toBeVisible()
  await expect.poll(async () => (await page.evaluate(id => window.musicBridge.getRecordingWorkspaceContext(id), fixture.draftId))?.selection.planId).toBe(planId)
  expect((await page.evaluate(id => window.musicBridge.getRecordingWorkspaceContext(id), fixture.draftId))?.selection.selectedPhysicalId).toBe(fixture.physicalId)
  await page.screenshot({ path: test.info().outputPath('03-exact-production-light-1440.png'), scale: 'css' })

  await page.getByRole('button', { name: '更换或预留', exact: true }).click()
  await expect(media.getByRole('heading', { name: '这份规划的预留', exact: true })).toBeVisible()
  await media.getByRole('button', { name: '取消这盘预留', exact: true }).click()
  await media.getByRole('button', { name: '确认取消预留', exact: true }).click()
  await expect.poll(async () => (await copy()).copy.usage).toBe('blank')
  expect((await copy()).copy.reservationOwner).toBeUndefined()
  await media.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: '查看实物收藏 →', exact: true }).click()
  await expect(copyRow).toHaveAttribute('data-returned-copy', 'true')
  await expect(copyRow.getByRole('button', { name: '用于本次录音', exact: true })).toBeVisible()
  const detail = await page.evaluate(id => window.musicBridge.getCollectionModel(id, { offset: 0, limit: 20 }), fixture.modelId)
  expect(detail.model.counts).toMatchObject({ total: 1, openedBlank: 1, reserved: 0 })
  expect(detail.copies.total).toBe(1)
  expect((await page.evaluate(() => window.musicBridge.getRecordingOutputStatus()))).toMatchObject({ deviceAccess: 'not-authorized', gateB: 'NOT_RUN', formalReady: false })
  await page.getByRole('button', { name: '打开设置', exact: true }).click()
  await page.getByRole('tab', { name: '应用', exact: true }).click()
  await page.getByRole('radio', { name: /深色/u }).check()
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')
  await page.locator('[data-sidebar-source="collection"]').click()
  await expect(page.getByRole('region', { name: '磁带型号详情', exact: true })).toBeVisible()
  await selectModelPage(page, '实体磁带')
  await expect(copyRow).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('04-collection-dark-1440.png'), scale: 'css' })
  await setNativeContentSize(720, 480, false)
  await captureGeometry('05-narrow-dark')
  await copyRow.scrollIntoViewIfNeeded()
  await page.screenshot({ path: test.info().outputPath('05-collection-dark-720.png'), scale: 'css' })
  expect(await page.locator('.collection-view').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  await copyRow.getByRole('button', { name: '用于本次录音', exact: true }).click()
  await page.locator('.draft-card').filter({ hasText: '085 指定单盘制作' }).click()
  await expect(page.getByRole('heading', { name: '085 指定单盘制作', exact: true })).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('06-recording-dark-720.png'), scale: 'css' })
  await page.locator('.context-card').filter({ hasText: '这盘实物' }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: test.info().outputPath('06b-recording-context-dark-720.png'), scale: 'css' })
  expect(await page.locator('.recording-view').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  await page.locator('.content-scroll').evaluate(element => { element.scrollTop = element.scrollHeight })
  const returnToCollection = page.getByRole('button', { name: '查看实物收藏 →', exact: true })
  await returnToCollection.scrollIntoViewIfNeeded()
  const returnBounds = await returnToCollection.boundingBox(), playerBounds = await page.locator('.global-player').boundingBox()
  expect(returnBounds).not.toBeNull(); expect(playerBounds).not.toBeNull()
  expect(returnBounds!.y + returnBounds!.height).toBeLessThanOrEqual(playerBounds!.y - 4)
  await returnToCollection.click()
  await expect(copyRow).toBeVisible()
  await expect(copyRow).toHaveAttribute('data-returned-copy', 'true')
  await page.screenshot({ path: test.info().outputPath('06c-return-to-collection-dark-720.png'), scale: 'css' })
  await writeFile(test.info().outputPath('fixture-identities.json'), JSON.stringify({ ...fixture, planId, evidence: 'isolated synthetic Roon and inventory through real Preload/Main/Core; no real account, device or Owner acceptance' }, null, 2))
  const networkEvidence = await app!.evaluate(() => (globalThis as typeof globalThis & {
    __musicBridgeUiE2eNetworkEvidence?: { installedBeforeWindow: boolean; localCoverResponses: number; localAvatarResponses: number; blockedExternalAttempts: number; blockedHosts: string[] }
  }).__musicBridgeUiE2eNetworkEvidence)
  expect(networkEvidence).toMatchObject({ installedBeforeWindow: true, blockedExternalAttempts: 0, blockedHosts: [] })
  expect(networkEvidence!.localCoverResponses).toBeGreaterThan(0)
  await writeFile(test.info().outputPath('network-evidence.json'), JSON.stringify({ ...networkEvidence,
    policy: 'Electron defaultSession rejects all HTTP(S) before first window; exact synthetic cover/avatar URL requests are redirected to embedded local SVG bytes, so no external socket is required.',
  }, null, 2))
})
