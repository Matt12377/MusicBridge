import { testElectronArguments } from '../scripts/test-keychain.mjs'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, realpath, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import type { TestContext } from 'node:test'
import { recordingRecordFixture } from '../../../packages/bridge-core/test/helpers/recording-record-fixture.js'
import { createRecordingRecordCoordinator } from '../../../packages/bridge-core/src/recording/record-coordinator.js'
import { createRecordingReplicaInput } from '../../../packages/bridge-core/src/recording/replica-input.js'
import path from 'node:path'
import os from 'node:os'

const root = path.resolve(import.meta.dirname, '..')
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
  test.setTimeout(180_000); directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'musicbridge-ui-e2e-replica-')))
  await mkdir(test.info().outputDir, { recursive: true }); await writeFile(test.info().outputPath('synthetic-user-data-path.txt'), directory)
})
test.afterEach(close)

test('Replica实际六API无设备保持blocked，取消先到不伪启动，冷启不恢复会话或改档案', async () => {
  await launch()
  const before = await page.evaluate(async () => ({ records: await window.musicBridge.listRecordingRecords({ page: { offset: 0, limit: 25 } }), attempts: await window.musicBridge.listRecordingAttempts({ page: { offset: 0, limit: 25 } }), outbox: await window.musicBridge.getCommandOutbox() }))
  const expected = { playback: 'blocked', reason: 'BACKEND_UNAVAILABLE', deviceAccess: 'not-authorized', deviceOpened: false, formalReady: false, gateB: 'NOT_RUN' }
  expect(await page.evaluate(() => window.musicBridge.getRecordingReplicaStatus())).toEqual(expected)
  const recordingId = randomUUID(), readId = randomUUID(), runId = randomUUID()
  await expect(page.evaluate(request => window.musicBridge.inspectRecordingReplica(request), { readId, recordingId })).rejects.toThrow(/INVENTORY_UNAVAILABLE/u)
  const cancelledRead = randomUUID()
  expect(await page.evaluate(id => window.musicBridge.cancelRecordingReplicaRead(id), cancelledRead)).toEqual({ readId: cancelledRead, cancelRequested: true })
  await expect(page.evaluate(request => window.musicBridge.inspectRecordingReplica(request), { readId: cancelledRead, recordingId })).rejects.toThrow(/INVENTORY_UNAVAILABLE/u)
  const request = { runId, recordingId, target: 'actual-execution' as const, side: 'A' as const, expectedFingerprint: 'a'.repeat(64), userConfirmed: true as const }
  await expect(page.evaluate(request => window.musicBridge.startRecordingReplica(request), request)).rejects.toThrow(/NOT_READY/u)
  expect(await page.evaluate(id => window.musicBridge.getRecordingReplicaRun(id), runId)).toEqual({ run: null })
  const tombstone = await page.evaluate(id => window.musicBridge.stopRecordingReplica(id), runId)
  expect(tombstone).toEqual({ kind: 'cancelled-before-start', runId, state: 'cancelled', started: false, stopRequested: true, cleanupQuiescent: true, evidence: 'none', deviceOpened: false, formalReady: false, gateB: 'NOT_RUN' })
  expect(await page.evaluate(request => window.musicBridge.startRecordingReplica(request), request)).toEqual(tombstone)
  expect(await page.evaluate(id => window.musicBridge.getRecordingReplicaRun(id), runId)).toEqual({ run: tombstone })
  expect(await page.evaluate(async () => ({ records: await window.musicBridge.listRecordingRecords({ page: { offset: 0, limit: 25 } }), attempts: await window.musicBridge.listRecordingAttempts({ page: { offset: 0, limit: 25 } }), outbox: await window.musicBridge.getCommandOutbox() }))).toEqual(before)
  await close(); await launch()
  expect(await page.evaluate(() => window.musicBridge.getRecordingReplicaStatus())).toEqual(expected)
  expect(await page.evaluate(id => window.musicBridge.getRecordingReplicaRun(id), runId)).toEqual({ run: null })
  expect(await page.evaluate(async () => ({ records: await window.musicBridge.listRecordingRecords({ page: { offset: 0, limit: 25 } }), attempts: await window.musicBridge.listRecordingAttempts({ page: { offset: 0, limit: 25 } }), outbox: await window.musicBridge.getCommandOutbox() }))).toEqual(before)
})

test('Replica历史详情只读核验与明确选择，后端blocked、取消失败重试和迟到结果收口', async () => {
  await launch()
  const cleanups: Array<() => void | Promise<void>> = []
  const context = { after: (fn: () => void | Promise<void>) => { cleanups.push(fn) } } as unknown as TestContext
  try {
    // 独立临时库真实完成事务和归档字节；私有合成driver仅产档案，窗口使用只读DTO且从未接播放provider。
    const f = await recordingRecordFixture(context), pending = await f.readyForFinal()
    await f.attempts.confirm(pending.request)
    const records = createRecordingRecordCoordinator({ store: f.repository.recordingRecords, assertCurrent: () => {}, assertExecutionIdle: () => f.attempts.assertExecutionIdle() })
    cleanups.push(() => records.close())
    const list = records.list({ page: { offset: 0, limit: 25 } }), detail = records.get({ id: list.items[0]!.id }).record!
    const history = records.history({ physicalId: detail.record.completion.physicalId, page: { offset: 0, limit: 25 } })
    const input = createRecordingReplicaInput({ repository: f.repository })
    const inspection = await input.inspect({ readId: randomUUID(), recordingId: detail.record.id }, new AbortController().signal, () => {})
    expect(inspection.targets[0]!.state).toBe('verified')
    const before = f.repository.recordingRecords.read(db => ['recording_records', 'recording_record_current', 'recording_attempts', 'physical_copies'].map(table => db.prepare(`SELECT * FROM ${table}`).all()))
    await writeFile(test.info().outputPath('synthetic-replica-evidence.json'), JSON.stringify({ evidence: 'real-archive-bytes-private-synthetic-driver-and-main-readonly-ui-fixture-not-device-playback', detail, inspection }, null, 2))
    await app!.evaluate(({ ipcMain }, fixture) => {
      const host = globalThis as typeof globalThis & { task076Mode?: string; task076Reads?: number; task076CancelFails?: boolean; task076Release?: () => void }
      host.task076Mode = 'ready'; host.task076Reads = 0; host.task076CancelFails = false
      for (const method of ['list', 'get', 'history']) ipcMain.removeHandler(`recordingRecords:${method}`)
      ipcMain.handle('recordingRecords:list', () => fixture.list)
      ipcMain.handle('recordingRecords:get', (_event, envelope) => ({ record: envelope.payload.id === fixture.detail.record.id ? fixture.detail : null }))
      ipcMain.handle('recordingRecords:history', () => fixture.history)
      ipcMain.removeHandler('recordingReplica:inspect'); ipcMain.removeHandler('recordingReplica:cancelRead')
      ipcMain.handle('recordingReplica:inspect', async (_event, envelope) => {
        ++host.task076Reads!
        if (envelope.payload.recordingId !== fixture.detail.record.id) throw new Error('合成档案身份不匹配')
        if (host.task076Mode === 'fail') throw new Error('/private/synthetic-replica-failure')
        if (host.task076Mode === 'pending') await new Promise<void>(resolve => { host.task076Release = resolve })
        return { ...fixture.inspection, readId: envelope.payload.readId }
      })
      ipcMain.handle('recordingReplica:cancelRead', (_event, envelope) => {
        if (host.task076CancelFails) { host.task076CancelFails = false; throw new Error('/private/synthetic-cancel-failure') }
        return { readId: envelope.payload.readId, cancelRequested: true }
      })
    }, { list, detail, history, inspection })
    await page.locator('[data-sidebar-source="recording"]').click()
    await page.getByRole('button', { name: '录音档案', exact: true }).click()
    await page.getByRole('button', { name: `查看录音档案 ${detail.record.id}`, exact: true }).click()
    const trigger = page.getByRole('button', { name: 'Digital Replica', exact: true })
    await trigger.click()
    const panel = page.getByTestId('recording-replica-panel')
    await expect(panel).toBeVisible()
    await expect(panel).toContainText('播放后端不可用；不会播放音频，也不代表 Gate B 已认证')
    expect(await app!.evaluate(() => (globalThis as typeof globalThis & { task076Reads?: number }).task076Reads)).toBe(0)
    await panel.getByRole('button', { name: '核验历史音频', exact: true }).click()
    await expect(panel).toContainText('历史音频核验通过')
    await panel.getByRole('combobox', { name: '音频版本', exact: true }).selectOption('actual-execution')
    await panel.getByRole('combobox', { name: '播放面／节目', exact: true }).selectOption('A')
    await expect(panel.getByRole('button', { name: '播放所选历史音频', exact: true })).toBeDisabled()
    await expect(panel).toContainText(inspection.targets[0]!.state === 'verified' ? inspection.targets[0]!.audio.pcmSha256 : '')
    await page.setViewportSize({ width: 720, height: 480 }); await panel.scrollIntoViewIfNeeded()
    expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    await page.evaluate(source => window.eval(source), axe)
    const violations = await panel.evaluate(async el => (window as typeof window & { axe: { run(root: Element): Promise<{ violations: { impact: string | null }[] }> } }).axe.run(el))
    expect(violations.violations.filter(item => item.impact === 'serious' || item.impact === 'critical')).toEqual([])
    await page.screenshot({ path: test.info().outputPath('replica-verified-720.png') })
    await panel.getByRole('combobox', { name: '音频版本', exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: test.info().outputPath('replica-selection-720.png') })
    await page.setViewportSize({ width: 1440, height: 900 }); await panel.scrollIntoViewIfNeeded()
    await page.screenshot({ path: test.info().outputPath('replica-verified-1440.png') })
    await panel.getByRole('button', { name: '关闭 Digital Replica', exact: true }).click(); await expect(trigger).toBeFocused()
    await trigger.click()
    await app!.evaluate(() => { (globalThis as typeof globalThis & { task076Mode?: string }).task076Mode = 'fail' })
    await panel.getByRole('button', { name: '核验历史音频', exact: true }).click()
    await expect(panel).toContainText('历史音频核验失败')
    await expect(panel).not.toContainText('/private/'); await expect(panel).not.toContainText('历史音频核验通过')
    await app!.evaluate(() => { const host = globalThis as typeof globalThis & { task076Mode?: string; task076CancelFails?: boolean }; host.task076Mode = 'pending'; host.task076CancelFails = true })
    await panel.getByRole('button', { name: '核验历史音频', exact: true }).click()
    await expect.poll(async () => app!.evaluate(() => typeof (globalThis as typeof globalThis & { task076Release?: () => void }).task076Release)).toBe('function')
    await panel.getByRole('button', { name: '关闭 Digital Replica', exact: true }).click()
    await expect(panel.getByRole('button', { name: '重试取消核验', exact: true })).toBeVisible()
    await expect(panel).not.toContainText('/private/')
    await panel.getByRole('button', { name: '重试取消核验', exact: true }).click()
    await expect(panel).toContainText('已请求取消，正在等待本次核验收口')
    await expect(panel).toBeVisible()
    await app!.evaluate(() => { (globalThis as typeof globalThis & { task076Release?: () => void }).task076Release!() })
    await expect(panel).toHaveCount(0); await expect(trigger).toBeFocused()
    await trigger.click(); await expect(panel).not.toContainText('历史音频核验通过')
    expect(f.repository.recordingRecords.read(db => ['recording_records', 'recording_record_current', 'recording_attempts', 'physical_copies'].map(table => db.prepare(`SELECT * FROM ${table}`).all()))).toEqual(before)
    expect(await page.evaluate(() => window.musicBridge.getRecordingReplicaStatus())).toMatchObject({ playback: 'blocked', deviceOpened: false, formalReady: false, gateB: 'NOT_RUN' })
  } finally { for (const cleanup of cleanups) await cleanup() }
})
