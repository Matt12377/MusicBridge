import { testElectronArguments } from '../scripts/test-keychain.mjs'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, realpath, readFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import type { TestContext } from 'node:test'
import path from 'node:path'
import os from 'node:os'
import { recordingRecordFixture } from '../../../packages/bridge-core/test/helpers/recording-record-fixture.js'
import { createRecordingRecordCoordinator } from '../../../packages/bridge-core/src/recording/record-coordinator.js'

const root = path.resolve(import.meta.dirname, '..'), pageRequest = { offset: 0, limit: 25 }
const axe = await readFile(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8')
let app: ElectronApplication | undefined, page: Page, directory: string
async function launch(): Promise<void> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !/^(MUSIC_BRIDGE_|NETEASE_|ROON_)/u.test(key))) as Record<string, string>
  app = await electron.launch({ args: testElectronArguments([path.join(root, 'dist/main/index.js')]), cwd: root, env: { ...env, MUSIC_BRIDGE_UI_E2E: '1', MUSIC_BRIDGE_CORE_TEST_MODE: '1', MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR: directory } })
  page = await app.firstWindow(); await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('#home-heading')).toBeVisible()
  await expect.poll(async () => (await page.evaluate(() => window.musicBridge.getCoreHealth())).runtime).toBe('ready')
}
async function close(): Promise<void> { const running = app; app = undefined; await running?.close() }
test.beforeEach(async () => {
  test.setTimeout(180_000); directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'musicbridge-ui-e2e-prints-')))
  await mkdir(test.info().outputDir, { recursive: true }); await writeFile(test.info().outputPath('synthetic-user-data-path.txt'), directory)
})
test.afterEach(close)

test('Completed持久任务在真实App冷启自动生成PDF，公开八API保持历史字节、导出取消零写与改图不回填', async () => {
  const cleanups: Array<() => void | Promise<void>> = []
  const context = { after: (fn: () => void | Promise<void>) => { cleanups.push(fn) } } as unknown as TestContext
  try {
    // 私有合成driver只产生完成事件；SQLite/Plan/归档字节真实，App不安装设备provider或伪Print handler。
    const f = await recordingRecordFixture(context), pending = await f.readyForFinal()
    await f.attempts.confirm(pending.request)
    const records = createRecordingRecordCoordinator({ store: f.repository.recordingRecords, assertCurrent: () => {}, assertExecutionIdle: () => f.attempts.assertExecutionIdle() })
    cleanups.push(() => records.close())
    const record = records.get({ id: records.list({ page: pageRequest }).items[0]!.id }).record!
    expect(record.record.schemaVersion).toBe(2)
    await mkdir(path.join(directory, 'data'), { recursive: true })
    f.repository.recordingRecords.read(db => db.prepare('VACUUM INTO ?').run(path.join(directory, 'data', 'collection.v1.sqlite')))
    const recordingId = record.record.id, masterVersionId = record.plan.master.id
    await launch()
    const list = () => page.evaluate(request => window.musicBridge.listRecordingPrints(request), { recordingId, page: pageRequest })
    await expect.poll(async () => (await list()).items[0]?.state, { timeout: 65_000 }).toBe('ready')
    const first = await list(), job = first.items[0]!, artifactId = job.artifactId!
    expect(first.total).toBe(1); expect(job.request.origin).toBe('completion')
    const print = await page.evaluate(request => window.musicBridge.getRecordingPrint(request), { recordingId, artifactId })
    expect(print.facts.recordingContentHash).toBe(record.record.contentHash)
    expect(print.facts.artwork.state).toBe('not-captured')
    expect(print.artifact.geometry).toMatchObject({ widthMm: 103.1875, heightMm: 101.6, widthPt: 292.5, heightPt: 288 })
    const exportRequest = { recordingId, artifactId, expectedPdfSha256: print.artifact.pdfSha256 }
    const exports = path.join(directory, 'exported'); await mkdir(exports)
    await app!.evaluate(({ dialog }) => { dialog.showSaveDialog = (async () => ({ canceled: true, filePath: '' })) as typeof dialog.showSaveDialog })
    expect(await page.evaluate(request => window.musicBridge.exportRecordingPrint(request), exportRequest)).toEqual({ state: 'cancelled' })
    expect(await readdir(exports)).toEqual([])
    const target = path.join(exports, '历史录音.pdf')
    await app!.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as typeof dialog.showSaveDialog }, target)
    expect(await page.evaluate(request => window.musicBridge.exportRecordingPrint(request), exportRequest)).toEqual({ state: 'exported', artifactId, pdfSha256: print.artifact.pdfSha256, size: print.artifact.size })
    const original = await readFile(target)
    expect(createHash('sha256').update(original).digest('hex')).toBe(print.artifact.pdfSha256)
    await expect(page.evaluate(request => window.musicBridge.exportRecordingPrint(request), exportRequest)).rejects.toThrow(/PRINT_EXPORT_UNCONFIRMED/u)
    expect(await readFile(target)).toEqual(original)
    await writeFile(test.info().outputPath('actual-archived-j-card.pdf'), original)
    await writeFile(test.info().outputPath('actual-archived-j-card.json'), JSON.stringify({ job, print, evidence: 'real-app-pdf-and-sqlite-private-synthetic-attempt-not-device-or-paper-print' }, null, 2))

    const png = await app!.evaluate(({ nativeImage }) => nativeImage.createFromBitmap(Buffer.alloc(32 * 32 * 4, 180), { width: 32, height: 32 }).toPNG().toString('base64'))
    const imagePath = path.join(directory, '合成Artwork.png'); await writeFile(imagePath, Buffer.from(png, 'base64'))
    await app!.evaluate(({ dialog }) => { dialog.showOpenDialog = (async () => ({ canceled: true, filePaths: [] })) as typeof dialog.showOpenDialog })
    expect(await page.evaluate(request => window.musicBridge.pickMasterArtwork(request), { masterVersionId })).toEqual({ state: 'cancelled' })
    await app!.evaluate(({ dialog }, filePath) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [filePath] })) as typeof dialog.showOpenDialog }, imagePath)
    const chosen = await page.evaluate(request => window.musicBridge.pickMasterArtwork(request), { masterVersionId })
    expect(chosen.state).toBe('selected'); if (chosen.state !== 'selected') throw new Error('合成Artwork未选中')
    expect((await page.evaluate(request => window.musicBridge.getMasterArtwork(request), { masterVersionId })).currentVersion).toBeNull()
    const save = { commandId: randomUUID(), masterVersionId, expectedVersionId: null, image: chosen.image, userConfirmed: true as const }
    const artwork = await page.evaluate(request => window.musicBridge.saveMasterArtwork(request), save)
    expect(await page.evaluate(request => window.musicBridge.saveMasterArtwork(request), save)).toEqual(artwork)
    expect(await page.evaluate(request => window.musicBridge.getRecordingPrint(request), { recordingId, artifactId })).toEqual(print)
    expect((await page.evaluate(id => window.musicBridge.getRecordingRecord(id), recordingId)).record!.record).toEqual(record.record)
    expect(await page.evaluate(request => window.musicBridge.requestRecordingPrint(request), { commandId: randomUUID(), recordingId, expectedRecordHash: record.record.contentHash, templateId: 'jp0-basic-v1' as const, userConfirmed: true as const })).toEqual(job)
    expect((await list()).total).toBe(1)
    await expect(page.evaluate(request => window.musicBridge.retryRecordingPrint(request), { commandId: randomUUID(), jobId: job.id, expectedRevision: job.revision, userConfirmed: true as const })).rejects.toThrow(/INVENTORY_CONFLICT/u)
    await expect(page.evaluate(request => window.musicBridge.exportRecordingPrint(request), { ...exportRequest, expectedPdfSha256: 'b'.repeat(64) })).rejects.toThrow()

    await page.locator('[data-sidebar-source="recording"]').click()
    await page.getByRole('button', { name: '录音档案', exact: true }).click()
    await page.getByRole('button', { name: `查看录音档案 ${recordingId}`, exact: true }).click()
    await page.getByRole('button', { name: 'J-Card 与印刷文件', exact: true }).click()
    const panel = page.getByTestId('recording-print-panel')
    await expect(panel).toBeVisible()
    await panel.getByRole('button', { name: `查看印刷文件 ${artifactId}`, exact: true }).click()
    await expect(panel).toContainText('103.1875')
    await expect(panel).toContainText(recordingId)
    await page.setViewportSize({ width: 720, height: 480 }); await panel.scrollIntoViewIfNeeded()
    expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    const confirmation = panel.getByRole('checkbox')
    const checkboxGeometry = await confirmation.evaluate(el => {
      const box = el.getBoundingClientRect(), label = el.closest('label')!
      return { width: box.width, height: box.height, labelDisplay: getComputedStyle(label).display, labelDirection: getComputedStyle(label).flexDirection, labelHeight: label.getBoundingClientRect().height }
    })
    await writeFile(test.info().outputPath('confirmation-computed-style.json'), JSON.stringify(checkboxGeometry, null, 2))
    expect(checkboxGeometry.width).toBeLessThanOrEqual(24)
    expect(checkboxGeometry.height).toBeLessThanOrEqual(24)
    expect(checkboxGeometry.labelDisplay).toBe('flex')
    expect(checkboxGeometry.labelDirection).toBe('row')
    expect(checkboxGeometry.labelHeight).toBeGreaterThanOrEqual(44)
    await page.evaluate(source => window.eval(source), axe)
    const violations = await panel.evaluate(async el => (window as typeof window & { axe: { run(root: Element): Promise<{ violations: { impact: string | null }[] }> } }).axe.run(el))
    expect(violations.violations.filter(item => item.impact === 'serious' || item.impact === 'critical')).toEqual([])
    await panel.evaluate(el => { el.scrollTop = 0 })
    await page.screenshot({ path: test.info().outputPath('j-card-720.png') })
    await panel.getByTestId('recording-print-detail').evaluate(el => el.scrollIntoView({ block: 'start' }))
    await page.screenshot({ path: test.info().outputPath('j-card-detail-720.png') })
    await page.setViewportSize({ width: 1440, height: 900 }); await panel.evaluate(el => { el.scrollTop = 0 })
    await page.screenshot({ path: test.info().outputPath('j-card-1440.png') })
    await panel.getByTestId('recording-print-detail').evaluate(el => el.scrollIntoView({ block: 'start' }))
    expect(await panel.locator('img').evaluate(el => el.getBoundingClientRect().height)).toBeLessThanOrEqual(360)
    await page.screenshot({ path: test.info().outputPath('j-card-detail-1440.png') })
    await close(); await launch()
    expect(await list()).toEqual(first)
    expect(await page.evaluate(request => window.musicBridge.getRecordingPrint(request), { recordingId, artifactId })).toEqual(print)
    expect((await page.evaluate(request => window.musicBridge.getMasterArtwork(request), { masterVersionId })).currentVersion).toEqual(artwork)
    expect(await page.evaluate(() => window.musicBridge.getRecordingOutputStatus())).toMatchObject({ deviceAccess: 'not-authorized', gateB: 'NOT_RUN', formalReady: false })
  } finally { await close(); for (const cleanup of cleanups.reverse()) await cleanup() }
})

test('真实schema20旧档案启动不自动补建，用户明确后补由运行中worker生成且旧Record字节不改', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const data = path.join(directory, 'data'); await mkdir(data)
  const file = path.join(data, 'collection.v1.sqlite'), db = new DatabaseSync(file)
  let old: string
  try {
    db.exec(await readFile(new URL('../../../packages/bridge-core/test/fixtures/collection-schema20-cassette-completed.sql', import.meta.url), 'utf8'))
    old = String(db.prepare('SELECT data FROM recording_records').get()!.data)
  } finally { db.close() }
  const record = JSON.parse(old!), recordingId = record.id as string
  expect(record.schemaVersion).toBe(1)
  await launch()
  const list = () => page.evaluate(request => window.musicBridge.listRecordingPrints(request), { recordingId, page: pageRequest })
  expect((await list()).total).toBe(0)
  await page.locator('[data-sidebar-source="recording"]').click()
  await page.getByRole('button', { name: '录音档案', exact: true }).click()
  await page.getByRole('button', { name: `查看录音档案 ${recordingId}`, exact: true }).click()
  const trigger = page.getByRole('button', { name: 'J-Card 与印刷文件', exact: true }); await trigger.click()
  const panel = page.getByTestId('recording-print-panel')
  await expect(panel).toContainText('此旧档案没有完成时自动打印请求')
  const create = panel.getByRole('button', { name: '依据现有历史事实补建基础卡片', exact: true })
  await expect(create).toBeDisabled()
  await panel.getByRole('checkbox', { name: '我确认仅按本次历史事实补建或重试原打印请求，不改写录音档案', exact: true }).check()
  await create.click()
  await expect.poll(async () => (await list()).items[0]?.state, { timeout: 65_000 }).toBe('ready')
  const job = (await list()).items[0]!
  expect(job.request.origin).toBe('historical-backfill')
  const artifact = await page.evaluate(request => window.musicBridge.getRecordingPrint(request), { recordingId, artifactId: job.artifactId! })
  expect(artifact.facts.artwork).toEqual(record.visuals.artwork)
  expect((await page.evaluate(id => window.musicBridge.getRecordingRecord(id), recordingId)).record!.record).toEqual(record)
  await panel.getByRole('button', { name: '刷新印刷文件', exact: true }).click()
  await panel.getByRole('button', { name: `查看印刷文件 ${job.artifactId}`, exact: true }).click()
  await expect(panel).toContainText('所选历史印刷文件')
  await page.keyboard.press('Escape'); await expect(panel).toHaveCount(0); await expect(trigger).toBeFocused()
  await close()
  const verification = new DatabaseSync(file, { readOnly: true })
  try { expect(String(verification.prepare('SELECT data FROM recording_records WHERE id=?').get(recordingId)!.data)).toBe(old!) }
  finally { verification.close() }
})
