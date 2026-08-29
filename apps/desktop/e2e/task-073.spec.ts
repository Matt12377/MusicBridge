import { testElectronArguments } from '../scripts/test-keychain.mjs'
import { _electron as electron, expect, test, type ElectronApplication, type Page, type Locator } from '@playwright/test'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { seedRecordingPlan } from './task-072-workflows.js'

const root = path.resolve(import.meta.dirname, '..')
const axe = await readFile(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8')
let app: ElectronApplication | undefined, page: Page, directory: string
async function launch(enabled: boolean) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !/^(MUSIC_BRIDGE_|NETEASE_|ROON_)/u.test(k))) as Record<string, string>
  app = await electron.launch({ args: testElectronArguments([path.join(root, 'dist/main/index.js')]), cwd: root, env: { ...env, MUSIC_BRIDGE_UI_E2E: '1', MUSIC_BRIDGE_CORE_TEST_MODE: '1', MUSIC_BRIDGE_SYNTHETIC_ROON_LIBRARY: '1', MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR: directory, ...(enabled ? { MUSIC_BRIDGE_BUNDLED_OUTPUT_GATE: '1' } : {}) } })
  page = await app.firstWindow(); await page.waitForLoadState('domcontentloaded'); await expect(page.locator('#home-heading')).toBeVisible()
  await expect.poll(async () => (await page.evaluate(() => window.musicBridge.getCoreHealth())).runtime).toBe('ready')
}
async function close() { const running = app; app = undefined; await running?.close() }
test.beforeEach(async () => { test.setTimeout(180000); directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'musicbridge-ui-e2e-output-'))); await mkdir(test.info().outputDir, { recursive: true }); await writeFile(test.info().outputPath('synthetic-user-data-path.txt'), directory) })
test.afterEach(close)

async function frozenFixture() {
  const f = await seedRecordingPlan(page, app!, directory)
  const proposal = await page.evaluate(selection => window.musicBridge.previewRecordingPlan({ readId: crypto.randomUUID(), selection }), f.selection)
  const plan = await page.evaluate(request => window.musicBridge.freezeRecordingPlan(request), { commandId: randomUUID(), selection: f.selection, proposalFingerprint: proposal.proposalFingerprint, userConfirmed: true as const })
  return { ...f, plan }
}
async function openOutput() {
  await page.locator('[data-sidebar-source="recording"]').click()
  await page.getByRole('button', { name: /^继续草稿 计划与预检合成草稿 /u }).click()
  const trigger = page.getByRole('button', { name: '计划与预检', exact: true }); await trigger.click()
  const parent = page.getByTestId('recording-plan-panel'), output = page.getByTestId('recording-output-panel')
  await expect(output).toContainText('请先明确查看或冻结一份计划；不会自动选择历史版本。')
  await expect(output.getByLabel('检查面／节目', { exact: true })).toBeDisabled()
  await expect(output.getByRole('button', { name: '无设备检查', exact: true })).toBeDisabled()
  await parent.getByRole('button', { name: '查看计划第 1 版', exact: true }).click()
  return { parent, output, trigger }
}
async function auditOutput(output: Locator, name: string) {
  await output.scrollIntoViewIfNeeded()
  expect(await output.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  await page.evaluate(source => window.eval(source), axe)
  const violations = await output.evaluate(async el => (window as typeof window & { axe: { run(root: Element): Promise<{ violations: { impact: string | null }[] }> } }).axe.run(el))
  expect(violations.violations.filter(v => v.impact === 'serious' || v.impact === 'critical')).toEqual([])
  await page.screenshot({ path: test.info().outputPath(name + '.png') })
}

test('V3输出检查：未启用固定包时明确禁用，无设备或普通outbox启动', async () => {
  await launch(false)
  const before = await page.evaluate(() => window.musicBridge.getCommandOutbox())
  const status = await page.evaluate(() => window.musicBridge.getRecordingOutputStatus())
  expect(status).toMatchObject({ syntheticCheck: { available: false, helperSha256: null }, backend: { halAdapterCompiled: false }, deviceAccess: 'not-authorized', gateB: 'NOT_RUN', formalReady: false })
  await expect(page.evaluate(request => window.musicBridge.checkRecordingOutput(request), { runId: randomUUID(), planVersionId: randomUUID(), side: 'A' as const })).rejects.toThrow(/INVENTORY_CONFLICT/u)
  expect(await page.evaluate(() => window.musicBridge.getCommandOutbox())).toEqual(before)
})

test('V3固定原生输出检查：真实Plan到只读FD与PCM守恒，取消先到、冷启和变更不产生认证', async () => {
  test.skip(process.env.MUSIC_BRIDGE_OUTPUT_NATIVE_GATE !== '1', '需要显式构建并核定的无设备原生候选')
  await launch(true)
  const status = await page.evaluate(() => window.musicBridge.getRecordingOutputStatus())
  expect(status.syntheticCheck.available).toBe(true); expect(status.syntheticCheck.helperSha256).toMatch(/^[a-f0-9]{64}$/u)
  expect(status).toMatchObject({ deviceAccess: 'not-authorized', gateB: 'NOT_RUN', formalReady: false })
  const f = await seedRecordingPlan(page, app!, directory)
  const proposal = await page.evaluate(selection => window.musicBridge.previewRecordingPlan({ readId: crypto.randomUUID(), selection }), f.selection)
  const plan = await page.evaluate(request => window.musicBridge.freezeRecordingPlan(request), { commandId: randomUUID(), selection: f.selection, proposalFingerprint: proposal.proposalFingerprint, userConfirmed: true as const })
  const inventory = await page.evaluate(id => window.musicBridge.getCollectionModel(id, { offset: 0, limit: 25 }), f.media.reservation!.modelId)
  const outbox = await page.evaluate(() => window.musicBridge.getCommandOutbox())
  const request = { runId: randomUUID(), planVersionId: plan.id, side: 'A' as const }
  const result = await page.evaluate(request => window.musicBridge.checkRecordingOutput(request), request)
  const expectedAudio = plan.execution.audio.find(a => a.recipe.side === 'A')!.audio
  expect(result).toEqual({ state: 'verified', ...request, planContentHash: plan.contentHash, frameCount: expectedAudio.frameCount, consumedFrames: expectedAudio.frameCount, pcmSha256: expectedAudio.pcmSha256, helperSha256: status.syntheticCheck.helperSha256, deviceOpened: false, formalReady: false, gateB: 'NOT_RUN', evidence: 'synthetic-only' })
  expect(await page.evaluate(request => window.musicBridge.checkRecordingOutput(request), request)).toEqual(result)
  const cancelledId = randomUUID(); await page.evaluate(id => window.musicBridge.cancelRecordingOutputCheck(id), cancelledId)
  await expect(page.evaluate(request => window.musicBridge.checkRecordingOutput(request), { ...request, runId: cancelledId })).rejects.toThrow(/INVENTORY_CONFLICT/u)
  await expect(page.evaluate(request => window.musicBridge.checkRecordingOutput(request), { ...request, runId: randomUUID(), side: 'B' as const })).rejects.toThrow(/INVENTORY_CONFLICT/u)
  expect(await page.evaluate(() => window.musicBridge.getCommandOutbox())).toEqual(outbox)
  expect(await page.evaluate(id => window.musicBridge.getCollectionModel(id, { offset: 0, limit: 25 }), f.media.reservation!.modelId)).toEqual(inventory)
  expect((await page.evaluate(id => window.musicBridge.getRecordingPlanVersion(id), plan.id)).plan).toEqual(plan)
  const preflight = await page.evaluate(planVersionId => window.musicBridge.preflightRecordingPlan({ readId: crypto.randomUUID(), planVersionId }), plan.id)
  expect(preflight.checks.find(c => c.category === 'backend')).toMatchObject({ state: 'not-run', code: 'BACKEND_NOT_CERTIFIED' }); expect(preflight.formalReady).toBe(false)
  await page.evaluate(request => window.musicBridge.releaseMediaPlan(request), { commandId: randomUUID(), planId: f.media.id, expectedRevision: f.media.revision, userConfirmed: true as const })
  await expect(page.evaluate(request => window.musicBridge.checkRecordingOutput(request), { ...request, runId: randomUUID() })).rejects.toThrow(/INVENTORY_CONFLICT/u)
  await close(); await launch(true)
  // 同run ID在新Runtime没有持久成功回执，当前预留失效仍须拒绝，不自动重播。
  await expect(page.evaluate(request => window.musicBridge.checkRecordingOutput(request), request)).rejects.toThrow(/INVENTORY_CONFLICT/u)
  expect((await page.evaluate(id => window.musicBridge.getRecordingPlanVersion(id), plan.id)).plan).toEqual(plan)
  expect(await readFile(f.sourceFile)).toEqual(f.bytes)
  expect(JSON.stringify(result)).not.toContain(directory)
  await writeFile(test.info().outputPath('synthetic-output-result.json'), JSON.stringify({ status, result, preflight }, null, 2))
})

test('V3无设备检查面板：未启用包时禁用，状态读取错误不泄漏内部路径', async () => {
  await launch(false); await frozenFixture()
  const { parent, output } = await openOutput()
  await expect(output).toContainText('不播放音频，不认证 Gate B。')
  await output.getByLabel('检查面／节目', { exact: true }).selectOption('A')
  await expect(output.getByRole('button', { name: '无设备检查', exact: true })).toBeDisabled()
  await page.setViewportSize({ width: 720, height: 480 }); await auditOutput(output, 'output-unavailable-720')
  await parent.getByRole('button', { name: '关闭计划与预检', exact: true }).click()
  await app!.evaluate(({ ipcMain }) => { ipcMain.removeHandler('recordingOutput:status'); ipcMain.handle('recordingOutput:status', () => { throw new Error('/private/synthetic-output-status-internal') }) })
  await page.getByRole('button', { name: '计划与预检', exact: true }).click()
  await expect(output.getByRole('alert')).toBeVisible()
  await expect(output).not.toContainText('synthetic-output-status-internal')
  await expect(output.getByRole('button', { name: '无设备检查', exact: true })).toBeDisabled()
  await auditOutput(output, 'output-status-error-720')
})

test('V3无设备检查面板：明确计划与侧面后真实helper通过，键盘与窄窗保留未认证边界', async () => {
  test.skip(process.env.MUSIC_BRIDGE_OUTPUT_NATIVE_GATE !== '1', '需要固定无设备原生候选')
  await launch(true); const f = await frozenFixture()
  await app!.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>> })._invokeHandlers
    const original = handlers.get('recordingOutput:check')!
    ;(globalThis as typeof globalThis & { outputUIChecks: number }).outputUIChecks = 0
    ipcMain.removeHandler('recordingOutput:check'); ipcMain.handle('recordingOutput:check', (...args) => { (globalThis as typeof globalThis & { outputUIChecks: number }).outputUIChecks++; return original(...args) })
  })
  const before = await page.evaluate(id => window.musicBridge.getCollectionModel(id, { offset: 0, limit: 25 }), f.media.reservation!.modelId)
  const outbox = await page.evaluate(() => window.musicBridge.getCommandOutbox())
  const { parent, output, trigger } = await openOutput()
  await expect(output).toContainText('本次尚未检查。')
  const side = output.getByLabel('检查面／节目', { exact: true })
  await expect(side).toHaveValue(''); await expect(side.locator('option[value="B"]')).toHaveCount(0)
  expect(await app!.evaluate(() => (globalThis as typeof globalThis & { outputUIChecks: number }).outputUIChecks)).toBe(0)
  await side.selectOption('A')
  const start = output.getByRole('button', { name: '无设备检查', exact: true })
  await expect(start).toBeEnabled(); await start.focus(); await page.keyboard.press('Enter')
  await expect(output).toContainText('无设备检查通过')
  await expect(start).toBeFocused()
  await expect(output).toContainText('不播放音频，不认证 Gate B。')
  const audio = f.plan.execution.audio.find(a => a.recipe.side === 'A')!.audio
  await expect(output).toContainText(String(audio.frameCount))
  expect(await app!.evaluate(() => (globalThis as typeof globalThis & { outputUIChecks: number }).outputUIChecks)).toBe(1)
  for (const size of [{ width: 720, height: 480 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(size); await auditOutput(output, `output-verified-${size.width}`)
  }
  expect(await page.evaluate(() => window.musicBridge.getCommandOutbox())).toEqual(outbox)
  expect(await page.evaluate(id => window.musicBridge.getCollectionModel(id, { offset: 0, limit: 25 }), f.media.reservation!.modelId)).toEqual(before)
  expect((await page.evaluate(id => window.musicBridge.getRecordingPlanVersion(id), f.plan.id)).plan).toEqual(f.plan)
  await parent.getByRole('button', { name: '关闭计划与预检', exact: true }).click(); await expect(trigger).toBeFocused()
  expect(await readFile(f.sourceFile)).toEqual(f.bytes)
})

test('V3无设备检查面板：取消失败可重试，迟到真实成功不能改为通过', async () => {
  test.skip(process.env.MUSIC_BRIDGE_OUTPUT_NATIVE_GATE !== '1', '需要固定无设备原生候选')
  await launch(true); await frozenFixture()
  await app!.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>> })._invokeHandlers
    const original = handlers.get('recordingOutput:check')!, cancel = handlers.get('recordingOutput:cancel')!
    let failed = false
    ipcMain.removeHandler('recordingOutput:check'); ipcMain.handle('recordingOutput:check', async (...args) => {
      const result = await original(...args)
      await new Promise<void>(resolve => { (globalThis as typeof globalThis & { releaseOutputUI?: () => void }).releaseOutputUI = resolve })
      return result
    })
    ipcMain.removeHandler('recordingOutput:cancel'); ipcMain.handle('recordingOutput:cancel', (...args) => { if (!failed) { failed = true; throw new Error('/private/synthetic-output-cancel-internal') } return cancel(...args) })
  })
  const { output } = await openOutput()
  await output.getByLabel('检查面／节目', { exact: true }).selectOption('A')
  await output.getByRole('button', { name: '无设备检查', exact: true }).click()
  await expect.poll(() => app!.evaluate(() => !!(globalThis as typeof globalThis & { releaseOutputUI?: () => void }).releaseOutputUI)).toBe(true)
  await output.getByRole('button', { name: '取消无设备检查', exact: true }).click()
  await expect(output.getByRole('button', { name: '重试取消', exact: true })).toBeVisible()
  await expect(output).not.toContainText('synthetic-output-cancel-internal')
  await output.getByRole('button', { name: '重试取消', exact: true }).click()
  await expect(output).toContainText('尚不能确认已停止')
  await expect(output).not.toContainText('无设备检查通过')
  await page.setViewportSize({ width: 720, height: 480 }); await auditOutput(output, 'output-cancelling-720')
  await app!.evaluate(() => (globalThis as typeof globalThis & { releaseOutputUI?: () => void }).releaseOutputUI?.())
  await expect(output.getByRole('button', { name: '无设备检查', exact: true })).toBeEnabled()
  await expect(output).not.toContainText('无设备检查通过')
})
