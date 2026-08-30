import { testElectronArguments } from '../scripts/test-keychain.mjs'
import { _electron as electron, expect, test, type ElectronApplication, type Page, type Locator } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loseNextOutboxReceipt } from './task-066-workflows.js'
import { seedRecordingPlan } from './task-072-workflows.js'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const axe = await readFile(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8')
let app: ElectronApplication | undefined, page: Page, directory: string
async function launch(): Promise<void> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !/^(MUSIC_BRIDGE_|NETEASE_|ROON_)/u.test(key))) as Record<string, string>
  app = await electron.launch({ args: testElectronArguments([path.join(root, 'dist/main/index.js')]), cwd: root, env: { ...env, MUSIC_BRIDGE_UI_E2E: '1', MUSIC_BRIDGE_CORE_TEST_MODE: '1', MUSIC_BRIDGE_SYNTHETIC_ROON_LIBRARY: '1', MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR: directory } })
  page = await app.firstWindow(); await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('#home-heading')).toBeVisible()
  await expect.poll(async () => (await page.evaluate(() => window.musicBridge.getCoreHealth())).runtime).toBe('ready')
}
async function close(): Promise<void> { const running = app; app = undefined; await running?.close() }
test.beforeEach(async () => {
  test.setTimeout(180_000)
  directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'musicbridge-ui-e2e-plan-')))
  await mkdir(test.info().outputDir, { recursive: true }); await writeFile(test.info().outputPath('synthetic-user-data-path.txt'), directory)
  await launch()
})
test.afterEach(close)
async function draft(title = '下一步合成草稿') {
  return page.evaluate(async title => {
    const albums = await window.musicBridge.searchPhysicalRoonAlbums('', { offset: 0, limit: 20 })
    const tracks = await window.musicBridge.getRoonAlbumTracks(albums.items[0]!.reference, { offset: 0, limit: 20 })
    return window.musicBridge.appendMasterDraft({ commandId: crypto.randomUUID(), title, programType: 'compilation', references: [tracks.items[0]!.reference], userConfirmed: true })
  }, title)
}
async function openDraft(title: string) {
  await page.locator('[data-sidebar-source="recording"]').click()
  await page.getByRole('button', { name: `继续草稿 ${title}` }).click()
}
async function audit(target: Locator, name: string, screenshotTarget?: Locator) {
  expect(await target.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  await page.evaluate(source => window.eval(source), axe)
  const violations = await target.evaluate(async el => (window as typeof window & { axe: { run(root: Element): Promise<{ violations: { impact: string | null }[] }> } }).axe.run(el))
  expect(violations.violations.filter(v => v.impact === 'serious' || v.impact === 'critical')).toEqual([])
  await screenshotTarget?.scrollIntoViewIfNeeded()
  await page.screenshot({ path: test.info().outputPath(name + '.png') })
}

test('V3正式计划：实际链路冻结当前参数、原命令重试、冷启历史和GateB阻断', async () => {
  const f = await seedRecordingPlan(page, app!, directory)
  const inventory = await page.evaluate(id => window.musicBridge.getCollectionModel(id, { offset: 0, limit: 25 }), f.media.reservation!.modelId)
  await page.evaluate(request => window.musicBridge.saveRecordingSession(request), { commandId: randomUUID(), draftId: f.draft.draftId, expectedRevision: f.session.revision, profileVersionId: f.profile.id, overrides: { noiseReduction: null, recordLevel: '冻结前本次新电平', calibration: '本次人工校准' }, userConfirmed: true as const })
  await openDraft('计划与预检合成草稿')
  const trigger = page.getByRole('button', { name: '计划与预检', exact: true }); await trigger.click()
  let panel = page.getByTestId('recording-plan-panel')
  await expect(panel.getByLabel('本次执行资产', { exact: true })).toHaveValue('')
  await expect(panel.getByLabel('本次 FINALIZED 归档', { exact: true })).toHaveValue('')
  await expect(panel.getByRole('button', { name: '核对所选资产与归档', exact: true })).toBeDisabled()
  await panel.getByLabel('本次执行资产', { exact: true }).selectOption(f.asset.id)
  await panel.getByLabel('本次 FINALIZED 归档', { exact: true }).selectOption(f.archive.id)
  await panel.getByRole('button', { name: '核对所选资产与归档', exact: true }).click()
  await expect(panel).toContainText('冻结前本次新电平')
  await expect(panel.getByRole('button', { name: '确认并冻结计划', exact: true })).toBeDisabled()
  await panel.locator('.snapshot').evaluate(el => el.scrollIntoView({ block: 'start' }))
  await audit(panel, 'plan-proposal-wide')
  await loseNextOutboxReceipt(app!, 'recordingPlans.freeze', '合成冻结回执丢失')
  await panel.getByLabel('我已核对资产、归档、实体副本与完整参数；确认冻结此计划，不开始录音', { exact: true }).check()
  await panel.getByRole('button', { name: '确认并冻结计划', exact: true }).click()
  await expect(panel.getByRole('button', { name: '重试原冻结操作', exact: true })).toBeVisible()
  await expect(panel.getByRole('button', { name: '关闭计划与预检', exact: true })).toBeDisabled()
  await panel.getByRole('button', { name: '重试原冻结操作', exact: true }).click()
  await expect(panel.getByRole('button', { name: '重新执行只读预检', exact: true })).toBeVisible()
  const history = await page.evaluate(id => window.musicBridge.listRecordingPlans(id), f.draft.draftId)
  expect(history.versions).toHaveLength(1)
  const frozen = history.versions[0]!
  expect(frozen.profileSnapshot.settings.effective.recordLevel).toBe('冻结前本次新电平')
  expect(frozen.execution.compiledSettings.effective.recordLevel).toBe('合成初始电平')
  expect(frozen.retentionPolicy).toBe('f01-permanent-execution-v1'); expect(frozen.formalReady).toBe(false)
  await panel.getByRole('button', { name: '重新执行只读预检', exact: true }).click()
  await expect(panel).toContainText('BACKEND_NOT_CERTIFIED')
  const check = await page.evaluate(request => window.musicBridge.preflightRecordingPlan(request), { readId: randomUUID(), planVersionId: frozen.id })
  expect(check.checks.filter(c => c.category !== 'backend').every(c => c.state === 'passed')).toBe(true)
  expect(check.state).toBe('blocked'); expect(check.formalReady).toBe(false)
  expect(await page.evaluate(id => window.musicBridge.getCollectionModel(id, { offset: 0, limit: 25 }), f.media.reservation!.modelId)).toEqual(inventory)
  for (const size of [{ width: 720, height: 480 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(size)
    await panel.locator('.preflight').evaluate(el => el.scrollIntoView({ block: 'start' }))
    await audit(panel, `plan-preflight-${size.width}`)
    await panel.locator('.checks li').last().evaluate(el => el.scrollIntoView({ block: 'end' }))
    await audit(panel, `plan-backend-blocked-${size.width}`)
  }
  await panel.getByRole('button', { name: '关闭计划与预检', exact: true }).click(); await expect(trigger).toBeFocused()
  await page.evaluate(request => window.musicBridge.saveRecordingSession(request), { commandId: randomUUID(), draftId: f.draft.draftId, expectedRevision: 2, profileVersionId: f.profile.id, overrides: { recordLevel: '冻结后的新会话' }, userConfirmed: true as const })
  expect((await page.evaluate(id => window.musicBridge.getRecordingPlanVersion(id), frozen.id)).plan).toEqual(frozen)
  await close(); await launch(); await openDraft('计划与预检合成草稿'); await page.getByRole('button', { name: '计划与预检', exact: true }).click()
  panel = page.getByTestId('recording-plan-panel')
  await expect(panel.getByLabel('本次执行资产', { exact: true })).toHaveValue('')
  await expect(panel.getByRole('button', { name: '重新执行只读预检', exact: true })).toHaveCount(0)
  await panel.getByRole('button', { name: '查看计划第 1 版', exact: true }).click()
  await expect(panel).toContainText('冻结前本次新电平'); await expect(panel).not.toContainText('冻结后的新会话')
  await page.evaluate(request => window.musicBridge.releaseMediaPlan(request), { commandId: randomUUID(), planId: f.media.id, expectedRevision: f.media.revision, userConfirmed: true as const })
  await panel.getByRole('button', { name: '重新执行只读预检', exact: true }).click()
  await expect(panel).toContainText('COPY_UNAVAILABLE'); await expect(panel).toContainText('BACKEND_NOT_CERTIFIED')
  expect((await page.evaluate(id => window.musicBridge.getRecordingPlanVersion(id), frozen.id)).plan).toEqual(frozen)
  expect(await readFile(f.sourceFile)).toEqual(f.bytes)
  await writeFile(test.info().outputPath('recording-plan.json'), JSON.stringify(frozen, null, 2))
  await writeFile(test.info().outputPath('preflight.json'), JSON.stringify(check, null, 2))
  expect(JSON.stringify(frozen)).not.toContain(directory)
})

test('V3计划读取：取消核验丢弃迟到结果，读取失败不装空历史或泄漏内部路径', async () => {
  const f = await seedRecordingPlan(page, app!, directory)
  await openDraft('计划与预检合成草稿'); await page.getByRole('button', { name: '计划与预检', exact: true }).click()
  const panel = page.getByTestId('recording-plan-panel')
  await panel.getByLabel('本次执行资产', { exact: true }).selectOption(f.asset.id)
  await panel.getByLabel('本次 FINALIZED 归档', { exact: true }).selectOption(f.archive.id)
  await app!.evaluate(({ ipcMain }) => {
    const original = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>> })._invokeHandlers.get('recordingPlans:preview')!
    let paused = false
    ipcMain.removeHandler('recordingPlans:preview'); ipcMain.handle('recordingPlans:preview', async (...args) => {
      if (!paused) { paused = true; await new Promise<void>(resolve => { (globalThis as typeof globalThis & { releasePlanRead?: () => void }).releasePlanRead = resolve }) }
      return original(...args)
    })
  })
  await panel.getByRole('button', { name: '核对所选资产与归档', exact: true }).click()
  await panel.getByRole('button', { name: '取消本次只读核验', exact: true }).click()
  await app!.evaluate(() => { (globalThis as typeof globalThis & { releasePlanRead?: () => void }).releasePlanRead?.() })
  await expect(panel.getByRole('button', { name: '核对所选资产与归档', exact: true })).toBeEnabled()
  await expect(panel.getByRole('button', { name: '确认并冻结计划', exact: true })).toHaveCount(0)
  expect((await page.evaluate(id => window.musicBridge.listRecordingPlans(id), f.draft.draftId)).versions).toHaveLength(0)
  await panel.getByRole('button', { name: '核对所选资产与归档', exact: true }).click()
  await expect(panel.getByRole('button', { name: '确认并冻结计划', exact: true })).toBeVisible()
  await panel.getByRole('button', { name: '关闭计划与预检', exact: true }).click()
  await app!.evaluate(({ ipcMain }) => { ipcMain.removeHandler('recordingPlans:list'); ipcMain.handle('recordingPlans:list', () => { throw new Error('/private/synthetic-plan-internal') }) })
  await page.getByRole('button', { name: '计划与预检', exact: true }).click()
  await expect(panel.getByRole('alert')).toBeVisible(); await expect(panel).not.toContainText('synthetic-plan-internal')
  await expect(panel).not.toContainText('尚无已冻结计划。')
  await panel.getByRole('alert').evaluate(el => el.scrollIntoView({ block: 'center' }))
  await audit(panel, 'plan-read-error')
  expect(await readFile(f.sourceFile)).toEqual(f.bytes)
})
