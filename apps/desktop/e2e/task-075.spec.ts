import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, realpath, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import type { TestContext } from 'node:test'
import path from 'node:path'
import os from 'node:os'
import type { PhysicalRecordingState, PreviewPhysicalRecordingDispositionRequest } from '@music-bridge/contracts'
import { recordingRecordFixture } from '../../../packages/bridge-core/test/helpers/recording-record-fixture.js'
import { createRecordingRecordCoordinator } from '../../../packages/bridge-core/src/recording/record-coordinator.js'

const root = path.resolve(import.meta.dirname, '..'), pageRequest = { offset: 0, limit: 25 }
const axe = await readFile(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8')
let app: ElectronApplication | undefined, page: Page, directory: string
async function launch(): Promise<void> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !/^(MUSIC_BRIDGE_|NETEASE_|ROON_)/u.test(key))) as Record<string, string>
  app = await electron.launch({ args: [path.join(root, 'dist/main/index.js')], cwd: root, env: { ...env, MUSIC_BRIDGE_UI_E2E: '1', MUSIC_BRIDGE_CORE_TEST_MODE: '1', MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR: directory } })
  page = await app.firstWindow(); await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('#home-heading')).toBeVisible()
  await expect.poll(async () => (await page.evaluate(() => window.musicBridge.getCoreHealth())).runtime).toBe('ready')
}
async function close(): Promise<void> { const running = app; app = undefined; await running?.close() }
test.beforeEach(async () => {
  test.setTimeout(180_000); directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'musicbridge-ui-e2e-records-')))
  await mkdir(test.info().outputDir, { recursive: true }); await writeFile(test.info().outputPath('synthetic-user-data-path.txt'), directory)
})
test.afterEach(close)
function disposition(state: PhysicalRecordingState, intent: PreviewPhysicalRecordingDispositionRequest['intent']): PreviewPhysicalRecordingDispositionRequest {
  return { physicalId: state.physicalId, expectedPhysicalRevision: state.physicalRevision, expectedContentRevision: state.revision,
    expectedAttempt: state.latestAttempt ? { id: state.latestAttempt.id, revision: state.latestAttempt.revision } : null, intent }
}

test('V3档案实际六API：人工处置幂等且不造Completed，库存守恒、冷启保留历史和未认证状态', async () => {
  await launch()
  // 全部数据通过实际Preload/Main/Core创建；没有注入Completed、设备provider或认证。
  const received = await page.evaluate(() => window.musicBridge.receiveCollectionStock({ commandId: crypto.randomUUID(),
    model: { brand: '合成075', name: '处置库存', edition: '合成版', year: null, format: 'cassette', tapeType: 'II', identification: 'verified' },
    lengthMinutes: 60, quantities: { openedBlank: 0, sealedBlank: 0, legacyUsed: 1, unclassified: 0 } }))
  const copy = await page.evaluate(lotId => window.musicBridge.materializeCollectionCopy({ commandId: crypto.randomUUID(), lotId, bucket: 'legacyUsed', action: 'register-legacy' }), received.lotId!)
  const physicalId = copy.physicalId!
  const history = () => page.evaluate(request => window.musicBridge.getPhysicalRecordingHistory(request), { physicalId, page: pageRequest })
  const inventory = () => page.evaluate(id => window.musicBridge.getCollectionModel(id, { offset: 0, limit: 25 }), received.modelId)
  const originalInventory = await inventory(), outbox = await page.evaluate(() => window.musicBridge.getCommandOutbox())
  const initial = await history()
  expect(initial.state).toMatchObject({ physicalId, revision: 0, knowledge: { state: 'unknown', reason: 'unverified' }, latestAttempt: null })
  expect(initial.entries.total).toBe(0)
  expect((await page.evaluate(request => window.musicBridge.listRecordingRecords(request), { page: pageRequest, filter: { query: physicalId } })).total).toBe(0)
  expect(await page.evaluate(id => window.musicBridge.getRecordingRecord(id), randomUUID())).toEqual({ record: null })
  await expect(page.evaluate(request => window.musicBridge.getRecordingRecordVisual(request), { recordingId: randomUUID(), attachmentId: randomUUID() })).rejects.toThrow(/INVENTORY_UNAVAILABLE/u)
  const request = disposition(initial.state, { action: 'mark-content-unknown' })
  const proposal = await page.evaluate(request => window.musicBridge.previewPhysicalRecordingDisposition(request), request)
  expect(proposal).toMatchObject({ request, outputWillStart: false, effect: 'content-unknown' })
  expect(await history()).toEqual(initial)
  const apply = { ...request, commandId: randomUUID(), proposalFingerprint: proposal.proposalFingerprint, userConfirmed: true as const }
  const result = await page.evaluate(request => window.musicBridge.applyPhysicalRecordingDisposition(request), apply)
  expect(result.state.knowledge).toMatchObject({ state: 'unknown', reason: 'manual-unknown' })
  expect(await page.evaluate(request => window.musicBridge.applyPhysicalRecordingDisposition(request), apply)).toEqual(result)
  await expect(page.evaluate(request => window.musicBridge.applyPhysicalRecordingDisposition(request), { ...apply, commandId: randomUUID() })).rejects.toThrow(/INVENTORY_CONFLICT/u)
  const eraseRequest = disposition(result.state, { action: 'confirm-erased' })
  const eraseProposal = await page.evaluate(request => window.musicBridge.previewPhysicalRecordingDisposition(request), eraseRequest)
  const erased = await page.evaluate(request => window.musicBridge.applyPhysicalRecordingDisposition(request), { ...eraseRequest, commandId: randomUUID(), proposalFingerprint: eraseProposal.proposalFingerprint, userConfirmed: true as const })
  expect(erased.state.knowledge.state).toBe('erased')
  const finalHistory = await history(), finalInventory = await inventory()
  expect(finalHistory.entries.total).toBe(2)
  expect(finalHistory.entries.items.every(item => item.kind === 'disposition')).toBe(true)
  expect(finalInventory.model.counts.total).toBe(originalInventory.model.counts.total)
  expect(finalInventory.copies.total).toBe(1)
  expect(finalInventory.copies.items[0]).toMatchObject({ physicalId, usage: 'erased', origin: originalInventory.copies.items[0]!.origin, recordingState: { state: 'erased' } })
  expect(await page.evaluate(() => window.musicBridge.getCommandOutbox())).toEqual(outbox)
  // 有内容处置历史的盘只能经明确重录许可；旧通用预留不能破坏当前头与冷启完整性。
  await expect(page.evaluate(request => window.musicBridge.updateCollectionCopy(request), { commandId: randomUUID(), physicalId, expectedRevision: erased.state.physicalRevision, action: 'reserve' as const })).rejects.toThrow()
  expect(await inventory()).toEqual(finalInventory)
  expect((await page.evaluate(request => window.musicBridge.listRecordingRecords(request), { page: pageRequest })).total).toBe(0)
  await close(); await launch()
  expect(await history()).toEqual(finalHistory); expect(await inventory()).toEqual(finalInventory)
  expect((await page.evaluate(request => window.musicBridge.listRecordingRecords(request), { page: pageRequest })).total).toBe(0)
  expect(await page.evaluate(() => window.musicBridge.getRecordingOutputStatus())).toMatchObject({ deviceAccess: 'not-authorized', gateB: 'NOT_RUN', formalReady: false })
})

test('V3档案界面明确选择实体和处置，空态与读取故障分开、键盘确认不自动写入', async () => {
  await launch()
  const received = await page.evaluate(() => window.musicBridge.receiveCollectionStock({ commandId: crypto.randomUUID(),
    model: { brand: '合成075', name: '界面旧录音', edition: '合成版', year: null, format: 'cassette', tapeType: 'II', identification: 'verified' },
    lengthMinutes: 60, quantities: { openedBlank: 0, sealedBlank: 0, legacyUsed: 1, unclassified: 0 } }))
  const copy = await page.evaluate(lotId => window.musicBridge.materializeCollectionCopy({ commandId: crypto.randomUUID(), lotId, bucket: 'legacyUsed', action: 'register-legacy' }), received.lotId!)
  await page.locator('[data-sidebar-source="recording"]').click()
  const trigger = page.getByRole('button', { name: '录音档案', exact: true }); await trigger.click()
  const panel = page.getByTestId('recording-records-panel')
  await expect(panel).toContainText('暂无符合条件的录音档案；这不表示实体不存在。')
  await expect(page.getByTestId('recording-record-detail')).toHaveCount(0)
  await panel.getByLabel('实体编号', { exact: true }).fill(copy.physicalId!)
  await panel.getByRole('button', { name: '查看实体历史', exact: true }).click()
  const history = page.getByTestId('recording-record-history'), dispositionPanel = page.getByTestId('recording-record-disposition')
  await expect(history).toContainText(copy.physicalId!)
  await dispositionPanel.getByRole('combobox', { name: '处置方式', exact: true }).selectOption('mark-content-unknown')
  await dispositionPanel.getByRole('button', { name: '预览处置', exact: true }).click()
  const confirm = dispositionPanel.getByRole('button', { name: '确认应用处置', exact: true })
  await expect(confirm).toBeDisabled()
  expect((await page.evaluate(request => window.musicBridge.getPhysicalRecordingHistory(request), { physicalId: copy.physicalId!, page: pageRequest })).entries.total).toBe(0)
  await dispositionPanel.getByRole('checkbox', { name: '我已核实此实体与处置后果，确认按预览应用', exact: true }).check()
  await confirm.focus(); await page.keyboard.press('Enter')
  await expect.poll(async () => (await page.evaluate(request => window.musicBridge.getPhysicalRecordingHistory(request), { physicalId: copy.physicalId!, page: pageRequest })).entries.total).toBe(1)
  await expect(history).toContainText('内容未知')
  await page.setViewportSize({ width: 720, height: 480 }); await history.scrollIntoViewIfNeeded()
  expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  await page.evaluate(source => window.eval(source), axe)
  const violations = await panel.evaluate(async el => (window as typeof window & { axe: { run(root: Element): Promise<{ violations: { impact: string | null }[] }> } }).axe.run(el))
  expect(violations.violations.filter(item => item.impact === 'serious' || item.impact === 'critical')).toEqual([])
  await page.screenshot({ path: test.info().outputPath('records-history-720.png') })
  await app!.evaluate(({ ipcMain }) => { ipcMain.removeHandler('recordingRecords:list'); ipcMain.handle('recordingRecords:list', () => { throw new Error('/private/synthetic-record-list-error') }) })
  await panel.getByRole('button', { name: '搜索录音档案', exact: true }).click()
  await expect(panel.getByRole('alert').first()).toBeVisible()
  await expect(panel).not.toContainText('暂无符合条件的录音档案；这不表示实体不存在。')
  await expect(panel).not.toContainText('/private/')
  await panel.getByRole('button', { name: '关闭录音档案', exact: true }).click(); await expect(trigger).toBeFocused()
  // 双库必须导航至同一实体；读取故障不影响明确的历史入口，也不复制库存。
  await page.locator('[data-sidebar-source="collection"]').click()
  await page.locator('.inventory-card').filter({ hasText: '界面旧录音' }).click()
  const inventoryEntry = page.getByRole('button', { name: '档案与当前内容', exact: true })
  await inventoryEntry.click()
  await expect(page.getByTestId('recording-record-history')).toContainText(copy.physicalId!)
  await expect(panel).toContainText('内容修订 1')
  await panel.getByRole('button', { name: '关闭录音档案', exact: true }).click(); await expect(inventoryEntry).toBeFocused()
  await page.getByRole('tab', { name: '实体音乐库', exact: true }).click()
  const musicCard = page.locator('.music-card').filter({ hasText: copy.physicalId! })
  await expect(musicCard).toHaveCount(1); await musicCard.click()
  await expect(page.getByRole('button', { name: '补录录音内容', exact: true })).toHaveCount(0)
  const musicEntry = page.getByRole('button', { name: '档案与当前内容', exact: true })
  await musicEntry.click()
  await expect(page.getByTestId('recording-record-history')).toContainText(copy.physicalId!)
  await expect(panel).toContainText('内容修订 1')
  await panel.getByRole('button', { name: '关闭录音档案', exact: true }).click(); await expect(musicEntry).toBeFocused()
  const inventory = await page.evaluate(id => window.musicBridge.getCollectionModel(id, { offset: 0, limit: 25 }), received.modelId)
  expect(inventory.model.counts.total).toBe(1); expect(inventory.copies.total).toBe(1)
})

test('V3受控完成档案展示冻结事实，照片按需读取与单图重试不启动录音', async () => {
  await launch()
  const cleanups: Array<() => void | Promise<void>> = []
  const context = { after: (fn: () => void | Promise<void>) => { cleanups.push(fn) } } as unknown as TestContext
  try {
    // 独立临时Core夹具：真实冻结Plan/事务，但仅私有合成driver；本窗口只读展示此DTO。
    const f = await recordingRecordFixture(context)
    const photo = await app!.evaluate(({ nativeImage }) => ({ width: 32, height: 16,
      dataUrl: 'data:image/jpeg;base64,' + nativeImage.createFromBitmap(Buffer.alloc(32 * 16 * 4, 160), { width: 32, height: 16 }).toJPEG(80).toString('base64') }))
    f.repository.addPhoto({ commandId: randomUUID(), modelId: f.frozenPlan.layout.reservation.modelId, physicalId: f.frozenPlan.physicalCopy.physicalId, image: photo })
    const pending = await f.readyForFinal(); await f.attempts.confirm(pending.request)
    const records = createRecordingRecordCoordinator({ store: f.repository.recordingRecords, assertCurrent: () => {}, assertExecutionIdle: () => f.attempts.assertExecutionIdle() })
    cleanups.push(() => records.close())
    const list = records.list({ page: pageRequest }), detail = records.get({ id: list.items[0]!.id }).record!
    const history = records.history({ physicalId: detail.record.completion.physicalId, page: pageRequest })
    if (detail.record.visuals.photos.state !== 'captured') throw new Error('合成照片必须实际归档')
    const visual = records.visual({ recordingId: detail.record.id, attachmentId: detail.record.visuals.photos.attachments[0]!.id })
    await writeFile(test.info().outputPath('synthetic-record-evidence.json'), JSON.stringify({ evidence: 'private-synthetic-driver-and-test-main-readonly-fixture-not-real-device', detail, history }, null, 2))
    await app!.evaluate(({ ipcMain }, fixture) => {
      const host = globalThis as typeof globalThis & { task075VisualReads?: number }; host.task075VisualReads = 0
      for (const method of ['list', 'get', 'history', 'visual']) ipcMain.removeHandler(`recordingRecords:${method}`)
      ipcMain.handle('recordingRecords:list', () => fixture.list)
      ipcMain.handle('recordingRecords:get', (_event, envelope) => ({ record: envelope.payload.id === fixture.detail.record.id ? fixture.detail : null }))
      ipcMain.handle('recordingRecords:history', () => fixture.history)
      ipcMain.handle('recordingRecords:visual', (_event, envelope) => {
        if (envelope.payload.recordingId !== fixture.visual.recordingId || envelope.payload.attachmentId !== fixture.visual.attachmentId) throw new Error('合成照片身份不匹配')
        if (++host.task075VisualReads! === 1) throw new Error('/private/synthetic-single-visual-failure')
        return fixture.visual
      })
    }, { list, detail, history, visual })
    await page.locator('[data-sidebar-source="recording"]').click()
    await page.getByRole('button', { name: '录音档案', exact: true }).click()
    const panel = page.getByTestId('recording-records-panel'), selected = page.getByTestId('recording-record-detail')
    await expect(selected).toHaveCount(0)
    await panel.getByRole('button', { name: `查看录音档案 ${detail.record.id}`, exact: true }).click()
    await expect(selected).toContainText(detail.plan.master.title)
    await expect(selected).toContainText(detail.record.completion.physicalId)
    await expect(selected).toContainText(detail.record.completion.planContentHash)
    expect(await app!.evaluate(() => (globalThis as typeof globalThis & { task075VisualReads?: number }).task075VisualReads)).toBe(0)
    await selected.getByRole('button', { name: '加载照片 1', exact: true }).click()
    await expect(selected.getByRole('button', { name: '重试照片 1', exact: true })).toBeVisible()
    await expect(selected).not.toContainText('/private/')
    await selected.getByRole('button', { name: '重试照片 1', exact: true }).click()
    await expect(selected.locator('img')).toHaveCount(1)
    await expect.poll(async () => selected.locator('img').evaluate(img => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth === 32)).toBe(true)
    expect(await app!.evaluate(() => (globalThis as typeof globalThis & { task075VisualReads?: number }).task075VisualReads)).toBe(2)
    await page.setViewportSize({ width: 720, height: 480 }); await selected.scrollIntoViewIfNeeded()
    expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    await page.evaluate(source => window.eval(source), axe)
    const violations = await panel.evaluate(async el => (window as typeof window & { axe: { run(root: Element): Promise<{ violations: { impact: string | null }[] }> } }).axe.run(el))
    expect(violations.violations.filter(item => item.impact === 'serious' || item.impact === 'critical')).toEqual([])
    await page.screenshot({ path: test.info().outputPath('record-detail-720.png') })
    await page.setViewportSize({ width: 1440, height: 900 }); await selected.scrollIntoViewIfNeeded()
    await page.screenshot({ path: test.info().outputPath('record-detail-1440.png') })
    expect(await page.evaluate(() => window.musicBridge.getRecordingOutputStatus())).toMatchObject({ deviceAccess: 'not-authorized', gateB: 'NOT_RUN', formalReady: false })
  } finally { for (const cleanup of cleanups) await cleanup() }
})
