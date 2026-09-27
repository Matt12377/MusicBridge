import { testElectronArguments } from '../scripts/test-keychain.mjs'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { TestContext } from 'node:test'
import { recordingRecordFixture } from '../../../packages/bridge-core/test/helpers/recording-record-fixture.js'
import { createRecordingRecordCoordinator } from '../../../packages/bridge-core/src/recording/record-coordinator.js'
import { waitForMainWindow } from './main-window.js'

const desktopRoot = path.resolve(import.meta.dirname, '..')
const temporaryRoot = '/Volumes/LifeWeave/Developer/CommandLine/tmp'
const fixedDatabase = process.env.MUSIC_BRIDGE_TASK085_PRINT_FIXED_DB
const fixedDatabaseSha256 = '33027eaaa76fe2889d5995b31cf3254f05d092227b7f71058a1910c39485709f'
const fixedRecordingId = '02b1ac35-f048-461a-825b-8df30e4dc90d'
const fixedOriginalJobId = '48cb6982-8708-492f-a138-b987e1bd987b'
const pageRequest = { offset: 0, limit: 25 }
async function sha256IfPresent(filename: string): Promise<string | null> {
  try { return createHash('sha256').update(await readFile(filename)).digest('hex') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}
let app: ElectronApplication | undefined
let page: Page
let userData: string
let tracingStarted = false
let mainDiagnostics: string[] = []
let networkEvidence: { blocked: Array<{ host: string; resourceType: string }>; failed: Array<{ host: string; resourceType: string }>; consoleErrors: number; pageErrors: number }
const hostOf = (url: string) => { try { return new URL(url).hostname } catch { return 'invalid-url' } }

async function launch(): Promise<void> {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !/^(MUSIC_BRIDGE_|NETEASE_|ROON_)/u.test(key))) as Record<string, string>
  app = await electron.launch({ timeout: 45_000, args: testElectronArguments([path.join(desktopRoot, 'dist/main/index.js')], 'mock'), cwd: desktopRoot,
    env: { ...inherited, MUSIC_BRIDGE_UI_E2E: '1', MUSIC_BRIDGE_CORE_TEST_MODE: '1', MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR: userData } })
  for (const stream of [app.process().stdout, app.process().stderr]) {
    stream?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/u)) if (line.includes('印刷渲染诊断') || line.includes('印刷任务诊断') || line.includes('印刷截图诊断')) mainDiagnostics.push(line)
    })
  }
  await app.context().tracing.start({ screenshots: true, snapshots: true, sources: true })
  tracingStarted = true
  await app.context().route(/^https?:\/\//u, async route => {
    networkEvidence.blocked.push({ host: hostOf(route.request().url()), resourceType: route.request().resourceType() })
    await route.abort('blockedbyclient')
  })
  page = await waitForMainWindow(app)
  page.on('requestfailed', request => networkEvidence.failed.push({ host: hostOf(request.url()), resourceType: request.resourceType() }))
  page.on('console', message => { if (message.type() === 'error') networkEvidence.consoleErrors++ })
  page.on('pageerror', () => networkEvidence.pageErrors++)
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('#home-heading')).toBeVisible()
  await expect.poll(async () => (await page.evaluate(() => window.musicBridge.getCoreHealth())).runtime).toBe('ready')
}

test.beforeEach(async () => {
  test.setTimeout(180_000)
  mainDiagnostics = []
  networkEvidence = { blocked: [], failed: [], consoleErrors: 0, pageErrors: 0 }
  userData = await realpath(await mkdtemp(path.join(temporaryRoot, 'musicbridge-ui-e2e-task085-print-')))
  await mkdir(test.info().outputDir, { recursive: true })
  await writeFile(test.info().outputPath('synthetic-user-data-path.txt'), userData)
})
test.afterEach(async () => {
  const running = app; app = undefined
  try { if (running && tracingStarted) await running.context().tracing.stop({ path: test.info().outputPath('task085-print-trace.zip') }) }
  finally {
    tracingStarted = false
    await running?.close()
    await writeFile(test.info().outputPath('main-print-diagnostics.txt'), `${mainDiagnostics.join('\n')}\n`)
    await writeFile(test.info().outputPath('network-and-console.json'), `${JSON.stringify(networkEvidence, null, 2)}\n`)
  }
})

test('J13 正式 App 按合成历史档案生成选图、自定义尺寸和逐页预览的独立 PDF', async () => {
  const cleanups: Array<() => void | Promise<void>> = []
  try {
    let recordingId: string
    await mkdir(path.join(userData, 'data'), { recursive: true })
    if (fixedDatabase) {
      expect(createHash('sha256').update(await readFile(fixedDatabase)).digest('hex')).toBe(fixedDatabaseSha256)
      await copyFile(fixedDatabase, path.join(userData, 'data', 'collection.v1.sqlite'))
      recordingId = fixedRecordingId
    } else {
      const context = { after: (fn: () => void | Promise<void>) => { cleanups.push(fn) } } as unknown as TestContext
      const fixture = await recordingRecordFixture(context)
      const pending = await fixture.readyForFinal()
      await fixture.attempts.confirm(pending.request)
      const records = createRecordingRecordCoordinator({ store: fixture.repository.recordingRecords,
        assertCurrent: () => {}, assertExecutionIdle: () => fixture.attempts.assertExecutionIdle() })
      cleanups.push(() => records.close())
      recordingId = records.list({ page: pageRequest }).items[0]!.id
      fixture.repository.recordingRecords.read(db => db.prepare('VACUUM INTO ?').run(path.join(userData, 'data', 'collection.v1.sqlite')))
    }
    await launch()
    const frozen = await page.evaluate(id => window.musicBridge.getRecordingRecord(id), recordingId)
    expect(frozen.record?.record).toMatchObject({ schemaVersion: 2, id: recordingId })
    if (fixedDatabase) expect(frozen.record?.record).toMatchObject({
      contentHash: '31a5ec54b172d4213d0c8069a4c5450f17f79b3715f9d51cf797d150320e9447',
      completion: { planContentHash: '3eae985292b7b66ebfbfab83f70ba12bff483e1a70d366a5ee8b39b27f3b0ab8' } })
    const list = () => page.evaluate(request => window.musicBridge.listRecordingPrints(request), { recordingId, page: pageRequest })
    if (fixedDatabase) {
      const prior = (await list()).items[0]!
      expect(prior).toMatchObject({ id: fixedOriginalJobId, state: 'failed', revision: 3, errorCode: 'RENDER_FAILED',
        request: { inputHash: 'cdb93ad7d96ca7a3ebfcac8d8d9958dae10bf0076bfd0ea6589d213344dd4d9a' } })
      await page.evaluate(request => window.musicBridge.retryRecordingPrint(request), { commandId: randomUUID(), jobId: prior.id, expectedRevision: prior.revision, userConfirmed: true as const })
    }
    await expect.poll(async () => (await list()).items[0]?.state, { timeout: 65_000 }).toMatch(/^(ready|failed)$/u)
    const originalJob = (await list()).items[0]!
    expect(originalJob.state, `基础印刷任务失败：${originalJob.errorCode ?? '无错误码'}`).toBe('ready')
    const original = await page.evaluate(request => window.musicBridge.getRecordingPrint(request), { recordingId, artifactId: originalJob.artifactId! })
    expect(original.artifact.templateId).toBe('jp0-basic-v1')

    await page.locator('[data-sidebar-source="recording"]').click()
    await page.getByRole('button', { name: '录音档案', exact: true }).click()
    await page.getByRole('button', { name: `查看录音档案 ${recordingId}`, exact: true }).click()
    await page.getByRole('button', { name: 'J-Card 与印刷文件', exact: true }).click()
    const panel = page.getByTestId('recording-print-panel')
    await expect(panel).toBeVisible()
    await panel.getByRole('checkbox', { name: /我确认仅按本次历史事实生成或重试打印请求/u }).check()
    await panel.getByLabel('封面标题').fill('085 合成设计封面')
    await panel.getByLabel('脊文字').fill('085 合成脊文字')
    await panel.getByLabel(/高度（90–150 mm）/u).fill('110')
    await panel.getByLabel(/折页宽（18–55 mm）/u).fill('28')
    await panel.getByLabel(/脊宽（8–25 mm）/u).fill('14')
    await panel.getByLabel(/封面宽（55–160 mm）/u).fill('68')
    await expect(panel).toContainText('PDF 总宽：110 mm')
    const pngBase64 = await app!.evaluate(({ nativeImage }) => nativeImage.createFromBitmap(Buffer.alloc(64 * 64 * 4, 180), { width: 64, height: 64 }).toPNG().toString('base64'))
    const imagePath = path.join(userData, 'synthetic-print-image.png')
    await writeFile(imagePath, Buffer.from(pngBase64, 'base64'))
    await app!.evaluate(({ dialog }, filePath) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [filePath] })) as typeof dialog.showOpenDialog }, imagePath)
    await panel.getByRole('button', { name: '选择本次设计图片', exact: true }).click()
    await expect(panel.getByAltText('尚未保存的本次 J-Card 设计图片')).toBeVisible()
    await panel.getByRole('checkbox', { name: /加入冻结录音短身份/u }).check()
    await page.screenshot({ path: test.info().outputPath('j13-design-form-wide.png'), scale: 'css' })
    await panel.getByRole('button', { name: '生成新印刷版本', exact: true }).click()
    await expect.poll(async () => (await list()).items.find(item => item.request.origin === 'manual-version')?.state, { timeout: 65_000 }).toMatch(/^(ready|failed)$/u)
    const jobs = await list(), customJob = jobs.items.find(item => item.request.origin === 'manual-version')!
    expect(customJob.state, `自定义印刷任务失败：${customJob.errorCode ?? '无错误码'}`).toBe('ready')
    expect(jobs.total).toBe(2)
    expect(customJob.request.design).toMatchObject({ schemaVersion: 2, coverTitle: '085 合成设计封面', spineText: '085 合成脊文字',
      geometry: { widthMm: 110, heightMm: 110, flapMm: 28, spineMm: 14, coverMm: 68 }, image: { source: 'selected-image' }, qr: 'recording-summary' })
    const result = await page.evaluate(request => window.musicBridge.getRecordingPrint(request), { recordingId, artifactId: customJob.artifactId! })
    expect(result.artifact.templateId).toBe('jc-design-v1')
    expect(result.artifact.pageCount).toBeGreaterThanOrEqual(3)
    expect(result.previewPages).toHaveLength(result.artifact.pageCount)
    expect(result.artifact.pdfSha256).not.toBe(original.artifact.pdfSha256)
    expect((await page.evaluate(id => window.musicBridge.getRecordingRecord(id), recordingId)).record!.record).toEqual(frozen.record!.record)
    expect(await page.evaluate(request => window.musicBridge.getRecordingPrint(request), { recordingId, artifactId: originalJob.artifactId! })).toEqual(original)

    await panel.getByRole('button', { name: '刷新印刷文件', exact: true }).click()
    await panel.getByRole('button', { name: `查看印刷文件 ${customJob.artifactId}`, exact: true }).click()
    const detail = panel.getByTestId('recording-print-detail')
    await expect(detail).toContainText('110 × 110 mm')
    await expect(detail.locator('.preview-grid figure')).toHaveCount(result.artifact.pageCount)
    await detail.scrollIntoViewIfNeeded()
    await page.screenshot({ path: test.info().outputPath('j13-custom-preview-wide.png'), scale: 'css' })
    const target = test.info().outputPath('j13-custom-actual.pdf')
    await app!.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as typeof dialog.showSaveDialog }, target)
    await detail.getByRole('button', { name: '导出 PDF', exact: true }).click()
    await expect.poll(() => sha256IfPresent(target)).toBe(result.artifact.pdfSha256)
    await writeFile(test.info().outputPath('j13-custom-actual.json'), JSON.stringify({ recordingId, originalJobId: originalJob.id,
      customJobId: customJob.id, artifact: result.artifact, design: result.design, facts: result.facts,
      evidence: fixedDatabase ? 'SHA-pinned fixed synthetic immutable record and plan from preserved failed run; real App retry, print worker and PDF renderer; no real recording or paper print' : 'isolated synthetic private driver seeded actual immutable record; real App print worker and PDF renderer; no real recording or paper print' }, null, 2))

    const maximumTitle = '最大合法纸面与长标题核对'.repeat(8)
    await panel.getByLabel('封面标题').fill(maximumTitle)
    await panel.getByLabel('脊文字').fill('085 最大纸面与曲目续页核对')
    await panel.getByLabel(/高度（90–150 mm）/u).fill('150')
    await panel.getByLabel(/折页宽（18–55 mm）/u).fill('55')
    await panel.getByLabel(/脊宽（8–25 mm）/u).fill('25')
    await panel.getByLabel(/封面宽（55–160 mm）/u).fill('160')
    await expect(panel).toContainText('PDF 总宽：240 mm')
    await page.screenshot({ path: test.info().outputPath('j13-maximum-form-wide.png'), scale: 'css' })
    await panel.getByRole('checkbox', { name: /我确认仅按本次历史事实生成或重试打印请求/u }).check()
    await panel.getByRole('button', { name: '生成新印刷版本', exact: true }).click()
    const maximumJob = async () => (await list()).items.find(item => item.request.origin === 'manual-version' && item.request.design?.geometry.widthMm === 240)
    await expect.poll(async () => (await maximumJob())?.state, { timeout: 65_000 }).toMatch(/^(ready|failed)$/u)
    const maximum = (await maximumJob())!
    expect(maximum.state, `最大合法纸面任务失败：${maximum.errorCode ?? '无错误码'}`).toBe('ready')
    expect((await list()).total).toBe(3)
    expect(maximum.request.design).toMatchObject({ schemaVersion: 2, coverTitle: maximumTitle,
      geometry: { widthMm: 240, heightMm: 150, flapMm: 55, spineMm: 25, coverMm: 160 } })
    const maximumResult = await page.evaluate(request => window.musicBridge.getRecordingPrint(request), { recordingId, artifactId: maximum.artifactId! })
    expect(maximumResult.artifact.geometry).toMatchObject({ widthMm: 240, heightMm: 150 })
    expect(maximumResult.artifact.pageCount).toBeGreaterThanOrEqual(3)
    expect(maximumResult.previewPages).toHaveLength(maximumResult.artifact.pageCount)
    expect(maximumResult.previewPages?.every(image => Math.max(image.width, image.height) <= 1200)).toBe(true)
    expect(maximumResult.artifact.pdfSha256).not.toBe(result.artifact.pdfSha256)
    expect((await page.evaluate(id => window.musicBridge.getRecordingRecord(id), recordingId)).record!.record).toEqual(frozen.record!.record)
    await panel.getByRole('button', { name: '刷新印刷文件', exact: true }).click()
    await panel.getByRole('button', { name: `查看印刷文件 ${maximum.artifactId}`, exact: true }).click()
    const maximumDetail = panel.getByTestId('recording-print-detail')
    await expect(maximumDetail).toContainText('240 × 150 mm')
    await expect(maximumDetail.locator('.preview-grid figure')).toHaveCount(maximumResult.artifact.pageCount)
    await maximumDetail.scrollIntoViewIfNeeded()
    await page.screenshot({ path: test.info().outputPath('j13-maximum-preview-wide.png'), scale: 'css' })
    const maximumTarget = test.info().outputPath('j13-maximum-actual.pdf')
    await app!.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as typeof dialog.showSaveDialog }, maximumTarget)
    await maximumDetail.getByRole('button', { name: '导出 PDF', exact: true }).click()
    await expect.poll(() => sha256IfPresent(maximumTarget)).toBe(maximumResult.artifact.pdfSha256)
    await writeFile(test.info().outputPath('j13-maximum-actual.json'), JSON.stringify({ recordingId, maximumJobId: maximum.id,
      artifact: maximumResult.artifact, design: maximumResult.design, facts: maximumResult.facts,
      evidence: 'maximum permitted 240 x 150 mm synthetic J-Card in actual Electron print worker; preview image bounded to 1200 px; no physical paper print' }, null, 2))
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup()
  }
})
