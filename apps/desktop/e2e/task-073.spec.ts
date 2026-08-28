import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { seedRecordingPlan } from './task-072-workflows.js'

const root = path.resolve(import.meta.dirname, '..')
let app: ElectronApplication | undefined, page: Page, directory: string
async function launch(enabled: boolean) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !/^(MUSIC_BRIDGE_|NETEASE_|ROON_)/u.test(k))) as Record<string, string>
  app = await electron.launch({ args: [path.join(root, 'dist/main/index.js')], cwd: root, env: { ...env, MUSIC_BRIDGE_UI_E2E: '1', MUSIC_BRIDGE_CORE_TEST_MODE: '1', MUSIC_BRIDGE_SYNTHETIC_ROON_LIBRARY: '1', MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR: directory, ...(enabled ? { MUSIC_BRIDGE_BUNDLED_OUTPUT_GATE: '1' } : {}) } })
  page = await app.firstWindow(); await page.waitForLoadState('domcontentloaded'); await expect(page.locator('#home-heading')).toBeVisible()
  await expect.poll(async () => (await page.evaluate(() => window.musicBridge.getCoreHealth())).runtime).toBe('ready')
}
async function close() { const running = app; app = undefined; await running?.close() }
test.beforeEach(async () => { test.setTimeout(180000); directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'musicbridge-ui-e2e-output-'))); await mkdir(test.info().outputDir, { recursive: true }); await writeFile(test.info().outputPath('synthetic-user-data-path.txt'), directory) })
test.afterEach(close)

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
