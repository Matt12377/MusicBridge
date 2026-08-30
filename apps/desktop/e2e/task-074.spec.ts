import { testElectronArguments } from '../scripts/test-keychain.mjs'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { seedRecordingPlan } from './task-072-workflows.js'

const root = path.resolve(import.meta.dirname, '..')
const axe = await readFile(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8')
let app: ElectronApplication | undefined, page: Page, directory: string
async function launch() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !/^(MUSIC_BRIDGE_|NETEASE_|ROON_)/u.test(key))) as Record<string, string>
  app = await electron.launch({ args: testElectronArguments([path.join(root, 'dist/main/index.js')]), cwd: root, env: { ...env, MUSIC_BRIDGE_UI_E2E: '1', MUSIC_BRIDGE_CORE_TEST_MODE: '1', MUSIC_BRIDGE_SYNTHETIC_ROON_LIBRARY: '1', MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR: directory } })
  page = await app.firstWindow(); await page.waitForLoadState('domcontentloaded'); await expect(page.locator('#home-heading')).toBeVisible()
  await expect.poll(async () => (await page.evaluate(() => window.musicBridge.getCoreHealth())).runtime).toBe('ready')
}
async function close() { const running = app; app = undefined; await running?.close() }
test.beforeEach(async () => { test.setTimeout(180000); directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'musicbridge-ui-e2e-attempt-'))); await mkdir(test.info().outputDir, { recursive: true }); await writeFile(test.info().outputPath('synthetic-user-data-path.txt'), directory) })
test.afterEach(close)
async function fixture() {
  const seeded = await seedRecordingPlan(page, app!, directory)
  const proposal = await page.evaluate(selection => window.musicBridge.previewRecordingPlan({ readId: crypto.randomUUID(), selection }), seeded.selection)
  const plan = await page.evaluate(request => window.musicBridge.freezeRecordingPlan(request), { commandId: randomUUID(), selection: seeded.selection, proposalFingerprint: proposal.proposalFingerprint, userConfirmed: true as const })
  return { ...seeded, plan }
}

test('V3正式Attempt实际全链路默认拒绝，零新增、outbox不变且冷启不续播', async () => {
  await launch(); const f = await fixture()
  const request = { commandId: randomUUID(), planVersionId: f.plan.id, planContentHash: f.plan.contentHash, userConfirmed: true as const }
  const before = await page.evaluate(() => window.musicBridge.getCommandOutbox())
  const inventory = await page.evaluate(id => window.musicBridge.getCollectionModel(id, { offset: 0, limit: 25 }), f.media.reservation!.modelId)
  await expect(page.evaluate(request => window.musicBridge.beginRecordingAttempt(request), request)).rejects.toThrow(/NOT_READY/u)
  expect(await page.evaluate(planVersionId => window.musicBridge.listRecordingAttempts({ planVersionId, page: { offset: 0, limit: 25 } }), f.plan.id)).toEqual({ items: [], offset: 0, limit: 25, total: 0, hasMore: false })
  expect(await page.evaluate(() => window.musicBridge.getCommandOutbox())).toEqual(before)
  expect(await page.evaluate(id => window.musicBridge.getCollectionModel(id, { offset: 0, limit: 25 }), f.media.reservation!.modelId)).toEqual(inventory)
  expect(await page.evaluate(id => window.musicBridge.getRecordingAttempt(id), randomUUID())).toEqual({ attempt: null })
  await close(); await launch()
  expect((await page.evaluate(() => window.musicBridge.listRecordingAttempts({ page: { offset: 0, limit: 25 } }))).total).toBe(0)
  await expect(page.evaluate(request => window.musicBridge.beginRecordingAttempt(request), request)).rejects.toThrow(/NOT_READY/u)
  expect(await page.evaluate(() => window.musicBridge.getRecordingOutputStatus())).toMatchObject({ deviceAccess: 'not-authorized', gateB: 'NOT_RUN', formalReady: false })
  expect(await readFile(f.sourceFile)).toEqual(f.bytes)
})

test('V3正式Attempt面板明确Plan后才读历史，窄窗与错误不伪造空历史或正式准入', async () => {
  await launch(); await fixture()
  await page.locator('[data-sidebar-source="recording"]').click()
  await page.getByRole('button', { name: /^继续草稿 计划与预检合成草稿 /u }).click()
  const trigger = page.getByRole('button', { name: '计划与预检', exact: true }); await trigger.click()
  const parent = page.getByTestId('recording-plan-panel'), panel = page.getByTestId('recording-attempt-panel')
  await expect(panel).toContainText('请先明确查看一份已冻结计划；不会自动选择历史或开始录音。')
  await expect(panel.getByRole('button', { name: '开始正式录音', exact: true })).toBeDisabled()
  await parent.getByRole('button', { name: '查看计划第 1 版', exact: true }).click()
  await expect(panel).toContainText('这份计划尚无正式录音尝试；未生成演示记录。')
  await page.setViewportSize({ width: 720, height: 480 }); await panel.scrollIntoViewIfNeeded()
  expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  await page.evaluate(source => window.eval(source), axe)
  const violations = await panel.evaluate(async el => (window as typeof window & { axe: { run(root: Element): Promise<{ violations: { impact: string | null }[] }> } }).axe.run(el))
  expect(violations.violations.filter(item => item.impact === 'serious' || item.impact === 'critical')).toEqual([])
  await page.screenshot({ path: test.info().outputPath('attempt-empty-720.png') })
  await app!.evaluate(({ ipcMain }) => { ipcMain.removeHandler('recordingAttempts:list'); ipcMain.handle('recordingAttempts:list', () => { throw new Error('/private/synthetic-attempt-read-failure') }) })
  await panel.getByRole('button', { name: '刷新录音尝试', exact: true }).click()
  await expect(panel.getByRole('alert')).toContainText('录音尝试读取失败')
  await expect(panel).not.toContainText('这份计划尚无正式录音尝试')
  await expect(panel).not.toContainText('/private/')
  await expect(panel.getByRole('button', { name: '开始正式录音', exact: true })).toBeDisabled()
  await page.screenshot({ path: test.info().outputPath('attempt-error-720.png') })
  await parent.getByRole('button', { name: '关闭计划与预检', exact: true }).click(); await expect(trigger).toBeFocused()
})

test('V3受控历史显示保留中断与三层事实，人工实体停止不伪造软件成功', async () => {
  await launch(); const f = await fixture(), id = randomUUID(), startedAt = '2026-08-29T10:00:00.000Z', endedAt = '2026-08-29T10:00:01.000Z'
  // 仅当前测试Main的有限读取fixture；不向Core或真实数据库写入正式演示历史。
  const history = { kind: 'formal' as const, id, draftId: f.plan.draftId, planVersionId: f.plan.id, planContentHash: f.plan.contentHash, executionAssetId: f.plan.execution.assetId, physicalId: f.plan.physicalCopy.physicalId,
    revision: 4, createdAt: startedAt, updatedAt: endedAt, endedAt, status: 'interrupted' as const, phase: 'finished' as const, reason: 'app-restarted' as const, softwarePlaybackComplete: false,
    sides: f.plan.execution.audio.map((receipt, index) => ({ side: receipt.recipe.side, frameCount: receipt.audio.frameCount, recipeHash: receipt.recipeHash, audioSha256: receipt.audio.sha256, pcmSha256: receipt.audio.pcmSha256,
      phase: index === 0 ? 'interrupted' as const : 'pending' as const, ...(index === 0 ? { runId: randomUUID(), startedAt, endedAt, reason: 'app-restarted' as const } : {}),
      sourceFramesRead: index === 0 ? 1 : 0, submittedFrames: index === 0 ? 1 : 0, consumedFrames: 0, sourceEof: false, backendDrained: false, engineStoppedSubmitting: index === 0, stopAcknowledged: index === 0, cleanupQuiescent: false })) }
  await app!.evaluate(({ ipcMain }, history) => {
    let value = history
    ipcMain.removeHandler('recordingAttempts:list'); ipcMain.handle('recordingAttempts:list', () => ({ items: [value], offset: 0, limit: 25, total: 1, hasMore: false }))
    ipcMain.removeHandler('recordingAttempts:get'); ipcMain.handle('recordingAttempts:get', () => ({ attempt: value }))
    ipcMain.removeHandler('recordingAttempts:confirm'); ipcMain.handle('recordingAttempts:confirm', (_event, envelope) => {
      const request = envelope.payload
      if (request.attemptId !== value.id || request.expectedRevision !== value.revision || request.kind !== 'physical-stop' || request.userConfirmed !== true
        || request.side !== value.sides.find(side => side.runId)?.side) throw new Error('合成确认不匹配')
      const at = '2026-08-29T10:00:02.000Z'
      value = { ...value, revision: value.revision + 1, updatedAt: at, sides: value.sides.map(side => side.side === request.side ? { ...side, physicalStopConfirmedAt: at } : side) }
      return value
    })
  }, history)
  await page.locator('[data-sidebar-source="recording"]').click()
  await page.getByRole('button', { name: /^继续草稿 计划与预检合成草稿 /u }).click()
  await page.getByRole('button', { name: '计划与预检', exact: true }).click()
  const parent = page.getByTestId('recording-plan-panel'), panel = page.getByTestId('recording-attempt-panel')
  await parent.getByRole('button', { name: '查看计划第 1 版', exact: true }).click()
  await expect(panel.getByRole('button', { name: `查看录音尝试 ${id}`, exact: true })).toBeVisible()
  await expect(panel.getByTestId('recording-attempt-detail')).toHaveCount(0)
  await panel.getByRole('button', { name: `查看录音尝试 ${id}`, exact: true }).click()
  await expect(panel).toContainText('已中断')
  await expect(panel).toContainText('软件播放完成：未完成')
  await expect(panel).toContainText('实体录制确认：未确认')
  await expect(panel).toContainText('最终核验完成：未确认')
  await expect(panel).toContainText('停止请求应答：已确认')
  await expect(panel).toContainText('资源静止：未确认')
  const confirm = panel.getByRole('button', { name: '确认 A 面实体已停止', exact: true })
  await expect(confirm).toBeDisabled()
  await panel.getByRole('checkbox').check(); await confirm.focus(); await page.keyboard.press('Enter')
  await expect(panel).toContainText('修订 5')
  await expect(panel.locator('section.side').first().locator('dt').filter({ hasText: /^实体已停止$/u }).locator('+ dd')).toHaveText('已确认')
  await expect(confirm).toHaveCount(0)
  await expect(panel).toContainText('软件播放完成：未完成')
  await expect(panel).toContainText('已中断')
  await expect(panel.getByRole('heading', { name: '本次录音事实', exact: true })).toBeFocused()
  await page.setViewportSize({ width: 720, height: 480 }); await panel.scrollIntoViewIfNeeded()
  expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  await page.evaluate(source => window.eval(source), axe)
  const violations = await panel.evaluate(async el => (window as typeof window & { axe: { run(root: Element): Promise<{ violations: { impact: string | null }[] }> } }).axe.run(el))
  expect(violations.violations.filter(item => item.impact === 'serious' || item.impact === 'critical')).toEqual([])
  await page.screenshot({ path: test.info().outputPath('attempt-interrupted-720.png') })
  await panel.locator('.facts').scrollIntoViewIfNeeded(); await page.screenshot({ path: test.info().outputPath('attempt-facts-720.png') })
  await panel.locator('section.side').first().scrollIntoViewIfNeeded(); await page.screenshot({ path: test.info().outputPath('attempt-side-720.png') })
  await page.setViewportSize({ width: 1440, height: 900 }); await panel.locator('.facts').scrollIntoViewIfNeeded(); await page.screenshot({ path: test.info().outputPath('attempt-facts-1440.png') })
  await writeFile(test.info().outputPath('synthetic-history-evidence.json'), JSON.stringify({ evidence: 'test-main-fixture-only-not-core-execution', history }, null, 2))
})
