import { testElectronArguments } from '../scripts/test-keychain.mjs'
import { _electron as electron, expect, test, type ElectronApplication, type Page, type Locator } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loseNextOutboxReceipt } from './task-066-workflows.js'
import { verifyTask071Photos } from './task-071-photo-workflow.js'

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
  test.setTimeout(90_000)
  directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'musicbridge-ui-e2e-workflow-')))
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
  await page.locator('.draft-card').filter({ hasText: title }).click()
}
async function audit(target: Locator, name: string, screenshotTarget?: Locator) {
  expect(await target.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  await page.evaluate(source => window.eval(source), axe)
  const violations = await target.evaluate(async el => (window as typeof window & { axe: { run(root: Element): Promise<{ violations: { impact: string | null }[] }> } }).axe.run(el))
  expect(violations.violations.filter(v => v.impact === 'serious' || v.impact === 'critical')).toEqual([])
  await screenshotTarget?.scrollIntoViewIfNeeded()
  await page.screenshot({ path: test.info().outputPath(name + '.png') })
}

async function expandRecordingDetails(): Promise<void> {
  const details = page.locator('.extra-steps')
  if (!await details.evaluate(element => (element as HTMLDetailsElement).open)) await details.locator(':scope > summary').click()
}

test('V3交互：240字符草稿长名在窄窗与宽窗均可读，不撑出主内容', async () => {
  const title = 'W'.repeat(240); await draft(title); await openDraft(title)
  for (const size of [{ width: 720, height: 480 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(size)
    await audit(page.locator('.recording-view'), `recording-long-title-${size.width}`, page.getByRole('heading', { name: title, exact: true }))
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
  }
})

test('V3交互：唯一下一步跟随草稿修改、源面板关闭与读取失败，不伪装正式预检', async () => {
  const saved = await draft(); await openDraft('下一步合成草稿')
  const next = page.getByTestId('recording-next-step'), action = page.getByTestId('recording-next-action')
  await expect(next).toBeVisible(); await expect(action).toBeEnabled()
  // 可以先做元数据估算；它不能取代真实源验证或创建可输出的冻结版本。
  await expect(action).toHaveAttribute('data-action', 'media')
  await action.click()
  const media = page.locator('section.media-panel.is-inline')
  await expect(media.getByText('Roon 估算', { exact: true })).toBeVisible()
  expect((await page.evaluate(id => window.musicBridge.listMasterVersions(id), saved.draftId)).masters).toHaveLength(0)
  await media.getByRole('button', { name: '保存分面规划', exact: true }).click()
  await expect(media.getByRole('status').filter({ hasText: '规划已保存' })).toBeVisible()
  await media.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(action).toHaveAttribute('data-action', 'source')
  await expect(next).toContainText('源')
  await action.click(); const source = page.locator('section.source-panel.is-inline')
  await expect(source).toBeVisible(); await source.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(action).toBeEnabled()
  await page.getByLabel('制作标题', { exact: true }).fill('修改后合成草稿')
  await expect(action).toHaveText('保存当前草稿')
  await action.click()
  await expect.poll(async () => (await page.evaluate(id => window.musicBridge.getMasterDraft(id), saved.draftId)).title).toBe('修改后合成草稿')
  await expect(action).toBeEnabled(); await expect(next).toContainText('源')
  await action.click(); await expect(source).toBeVisible()
  await app!.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers
    const handler = handlers.get('recordingSources:snapshot')!
    ipcMain.removeHandler('recordingSources:snapshot')
    ipcMain.handle('recordingSources:snapshot', (...args) => {
      ipcMain.removeHandler('recordingSources:snapshot'); ipcMain.handle('recordingSources:snapshot', handler)
      throw new Error('[CORE_UNAVAILABLE] 合成单次源状态读取失败')
    })
  })
  await source.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(action).toHaveAttribute('data-action', 'refresh')
  await expect(next.getByRole('alert')).toContainText('读取失败')
  await action.click(); await expect(action).toHaveAttribute('data-action', 'source')
  await expect(page.getByRole('button', { name: /开始正式录音|Start Recording/u })).toHaveCount(0)
  expect((await page.evaluate(() => window.musicBridge.listCollection({ offset: 0, limit: 25 }))).total).toBe(0)
})

test('V3交互：已登记关系选曲保留Exact与Probable区别，浏览不写入，跨来源明确追加', async () => {
  const fixture = await page.evaluate(async () => {
    const albums = await window.musicBridge.searchPhysicalRoonAlbums('', { offset: 0, limit: 20 })
    const first = albums.items.find(item => item.title === '关联验收专辑')!
    const cd = await window.musicBridge.savePhysicalRelease({ commandId: crypto.randomUUID(), release: { format: 'cd', title: '合成已确认CD', artist: '合成艺术家', quantity: 2, completeness: 'basic', tracks: [] } })
    const related = await window.musicBridge.savePhysicalRelease({ commandId: crypto.randomUUID(), release: { format: 'cassette', title: '合成待核实磁带', artist: '合成艺术家', quantity: 1, completeness: 'basic', tracks: [] } })
    const exact = await window.musicBridge.confirmPhysicalLink({ commandId: crypto.randomUUID(), releaseId: cd.id, expectedRevision: 1, reference: first.reference, relation: 'exact', ripFromCdConfirmed: true, reason: '合成验收：已核对 CD 为原版来源', userConfirmed: true })
    await window.musicBridge.confirmPhysicalLink({ commandId: crypto.randomUUID(), releaseId: related.id, expectedRevision: 1, digitalId: exact.digitalId!, relation: 'probable', ripFromCdConfirmed: false, reason: '合成验收：仅保留待核实关联', userConfirmed: true })
    return { digitalId: exact.digitalId!, before: await window.musicBridge.getCollectionMatrix({ offset: 0, limit: 25 }) }
  })
  await page.locator('[data-sidebar-source="recording"]').click()
  await page.getByRole('button', { name: '新建制作', exact: true }).click()
  const picker = page.locator('section.source-picker.is-inline')
  await picker.getByRole('tab', { name: '已登记收藏关系', exact: true }).click()
  await picker.getByRole('button', { name: '查看已登记专辑 关联验收专辑', exact: true }).click()
  const detail = picker.getByTestId('source-picker-relation-detail')
  await expect(detail).toContainText('Exact'); await expect(detail).toContainText('Probable')
  await expect(detail).toContainText('合成已确认CD'); await expect(detail).toContainText('合成待核实磁带')
  await picker.getByRole('button', { name: '从此数字关联选择曲目', exact: true }).click()
  await picker.getByLabel('选择 合成关联曲目', { exact: true }).check()
  await picker.getByRole('tab', { name: 'Roon 浏览', exact: true }).click()
  await picker.getByRole('button', { name: '查看曲目 另一张合成专辑', exact: true }).click()
  await picker.getByLabel('选择 另一首合成曲目', { exact: true }).check()
  expect((await page.evaluate(() => window.musicBridge.listMasterDrafts({ offset: 0, limit: 25 }))).total).toBe(0)
  expect(await page.evaluate(() => window.musicBridge.getCollectionMatrix({ offset: 0, limit: 25 }))).toEqual(fixture.before)
  await picker.getByLabel('我确认将所选曲目按选择顺序加入草稿', { exact: true }).check()
  await loseNextOutboxReceipt(app!, 'recordingDrafts.append', '合成关系选曲回执失败')
  await picker.getByRole('button', { name: '加入录音草稿', exact: true }).click()
  await expect(picker.getByRole('button', { name: '重试原操作', exact: true })).toBeVisible()
  await picker.getByRole('button', { name: '重试原操作', exact: true }).click(); await expect(picker).toHaveCount(0)
  const list = await page.evaluate(() => window.musicBridge.listMasterDrafts({ offset: 0, limit: 25 }))
  expect(list.total).toBe(1)
  const result = await page.evaluate(id => window.musicBridge.getMasterDraft(id), list.items[0]!.id)
  expect(result.tracks.map(track => track.metadata.title)).toEqual(['合成关联曲目', '另一首合成曲目'])
  expect(result.sourceLockEligible).toBe(false)
  expect(await page.evaluate(() => window.musicBridge.getCollectionMatrix({ offset: 0, limit: 25 }))).toEqual(fixture.before)
})

test('V3交互：240字符曲目在Picker跨专辑已选区保持可读和键盘返回', async () => {
  const title = 'W'.repeat(240)
  // 只变形正式只读结果中的合成长标题，用于布局；不追加或声称这是Core持久元数据。
  await app!.evaluate(({ ipcMain }, title) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => Promise<{ items: object[] }>> })._invokeHandlers
    const original = handlers.get('roon:library:album')!
    ipcMain.removeHandler('roon:library:album'); ipcMain.handle('roon:library:album', async (...args) => {
      const result = await original(...args); return { ...result, items: result.items.map(item => ({ ...item, title })) }
    })
  }, title)
  await page.locator('[data-sidebar-source="recording"]').click()
  const trigger = page.getByRole('button', { name: '新建制作', exact: true }); await trigger.click()
  const picker = page.locator('section.source-picker.is-inline')
  await picker.getByRole('button', { name: '查看曲目 关联验收专辑', exact: true }).click()
  await picker.getByRole('checkbox', { name: `选择 ${title}`, exact: true }).check()
  for (const size of [{ width: 720, height: 480 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(size); await picker.getByRole('region', { name: '本次已选曲目', exact: true }).scrollIntoViewIfNeeded()
    await audit(picker, `picker-long-selection-${size.width}`)
  }
  await page.keyboard.press('Escape'); await expect(picker).toHaveCount(0); await expect(trigger).toBeFocused()
  expect((await page.evaluate(() => window.musicBridge.listMasterDrafts({ offset: 0, limit: 25 }))).total).toBe(0)
})

test('V3交互：两库照片按需读取、失败单图重试、长名与横竖图保持原始资料', async () => {
  test.setTimeout(180_000)
  await verifyTask071Photos({ app: app!, page, directory, outputPath: name => test.info().outputPath(name) })
})

test('V3交互：关系离线与冷启不丢本地资料，不自动重定位或恢复旧选择', async () => {
  const fixture = await page.evaluate(async () => {
    const api = window.musicBridge, albums = await api.searchPhysicalRoonAlbums('', { offset: 0, limit: 20 })
    const digital = await api.registerDigitalAlbum({ commandId: crypto.randomUUID(), reference: albums.items[0]!.reference, physicalAbsenceConfirmed: true, userConfirmed: true })
    const release = await api.savePhysicalRelease({ commandId: crypto.randomUUID(), release: { format: 'cd', title: '合成只有实物', artist: '合成艺术家', quantity: 1, completeness: 'basic', tracks: [] } })
    await api.confirmPhysicalAbsence({ commandId: crypto.randomUUID(), id: release.id, target: 'digital', expectedRevision: 1, confirmedAbsent: true, userConfirmed: true })
    return { digitalId: digital.digitalId!, title: albums.items[0]!.title, matrix: await api.getCollectionMatrix({ offset: 0, limit: 25 }) }
  })
  async function enter() {
    await page.locator('[data-sidebar-source="recording"]').click()
    await page.getByRole('button', { name: '新建制作', exact: true }).click()
    const picker = page.locator('section.source-picker.is-inline')
    const roon = picker.getByRole('tab', { name: 'Roon 浏览', exact: true }); await roon.focus(); await page.keyboard.press('End')
    await expect(picker.getByRole('tab', { name: '已登记收藏关系', exact: true })).toBeFocused()
    await expect(picker.getByTestId('source-picker-relations')).toContainText('Physical Only')
    await expect(picker.getByTestId('source-picker-relations')).toContainText('Digital Only')
    await picker.getByRole('button', { name: `查看已登记专辑 ${fixture.title}`, exact: true }).click()
    return picker
  }
  let picker = await enter()
  await picker.getByRole('button', { name: '从此数字关联选择曲目', exact: true }).click()
  await picker.getByRole('checkbox', { name: '选择 合成关联曲目', exact: true }).check()
  // 受控连接事件；真实本地关系/选择器状态仍由生产路径处理。
  await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('core:event', { version: 1, event: 'roon.changed', payload: { state: { runtime: 'ready', roon: 'disconnected', provider: 'configured', activeStreamCount: 0, activePlaybackPresent: false } } }))
  await expect(picker.getByRole('button', { name: '加入录音草稿', exact: true })).toBeDisabled()
  await picker.getByRole('button', { name: '返回数字关联详情', exact: true }).click()
  await expect(picker.getByTestId('source-picker-relation-detail')).toContainText(fixture.title)
  await expect(picker.getByRole('button', { name: '从此数字关联选择曲目', exact: true })).toBeDisabled()
  await page.keyboard.press('Escape'); await expect(picker).toHaveCount(0)
  expect(await page.evaluate(() => window.musicBridge.getCollectionMatrix({ offset: 0, limit: 25 }))).toEqual(fixture.matrix)
  await close(); await launch()
  expect((await page.evaluate(id => window.musicBridge.getDigitalRuntime(id), fixture.digitalId)).status).toBe('needs-resolution')
  picker = await enter()
  await expect(picker.getByTestId('source-picker-relation-detail')).toContainText('链接待重新定位')
  await expect(picker.getByRole('button', { name: '从此数字关联选择曲目', exact: true })).toBeDisabled()
  for (const size of [{ width: 720, height: 480 }, { width: 1440, height: 900 }]) { await page.setViewportSize(size); await audit(picker, `picker-local-history-${size.width}`) }
  expect((await page.evaluate(() => window.musicBridge.listMasterDrafts({ offset: 0, limit: 25 }))).total).toBe(0)
  expect(await page.evaluate(() => window.musicBridge.getCollectionMatrix({ offset: 0, limit: 25 }))).toEqual(fixture.matrix)
})

test('V3交互：真实多规划历史需明确选择，同谱系Direct路径与预留变化不会串线', async () => {
  const saved = await draft('多历史上下文'), sourceFile = path.join(directory, 'synthetic-workflow.wav')
  const bytes = Buffer.alloc(44 + 44100 * 4)
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22); bytes.writeUInt32LE(44100, 24); bytes.writeUInt32LE(176400, 28); bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40)
  await writeFile(sourceFile, bytes)
  await app!.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }) }, directory)
  const sourceRoot = await page.evaluate(() => window.musicBridge.chooseRecordingSourceRoot(crypto.randomUUID()))
  await app!.evaluate(({ dialog }, sourceFile) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [sourceFile] }) }, sourceFile)
  const job = await page.evaluate(request => window.musicBridge.chooseRecordingSource(request), { commandId: randomUUID(), draftId: saved.draftId, trackId: saved.trackIds[0]!, rootId: sourceRoot!.id, acquisition: 'userFileBind' as const })
  await expect.poll(async () => (await page.evaluate(id => window.musicBridge.getRecordingSourceJob(id), job!.id)).job?.state).toBe('completed')
  const snapshot = await page.evaluate(id => window.musicBridge.getDraftSources(id), saved.draftId)
  await page.evaluate(request => window.musicBridge.confirmRecordingSource(request), { commandId: randomUUID(), id: snapshot.tracks[0]!.binding!.id, draftId: saved.draftId, trackId: saved.trackIds[0]!, userConfirmed: true as const })
  const plans = await page.evaluate(async draftId => {
    const api = window.musicBridge
    await api.receiveCollectionStock({ commandId: crypto.randomUUID(), model: { brand: '合成071', name: '上下文库存', edition: '1990', year: 1990, format: 'cassette', tapeType: 'II', identification: 'verified' }, lengthMinutes: 60, quantities: { openedBlank: 3, sealedBlank: 0, legacyUsed: 0, unclassified: 0 } })
    const plans = []
    for (const leadInMs of [1000, 2000]) {
      const spec = { format: 'cassette' as const, splitAfter: 1, leadInMs, tailMs: 1000, defaultGapMs: 5000, rules: [], compatibility: { confirmed: true, cassetteTypes: ['II' as const], dat: true } }
      const preview = await api.previewMediaPlan({ draftId, spec, page: { offset: 0, limit: 25 } })
      const plan = await api.saveMediaPlan({ commandId: crypto.randomUUID(), draftId, expectedDraftRevision: preview.draftRevision, inputFingerprint: preview.inputFingerprint, spec })
      plans.push(await api.reserveMediaPlan({ commandId: crypto.randomUUID(), planId: plan.id, expectedRevision: plan.revision, skuId: preview.candidates.items[0]!.skuId, packaging: 'opened', userConfirmed: true }))
    }
    return plans
  }, saved.draftId)
  const proposal = await page.evaluate(planId => window.musicBridge.previewMasterVersions({ planId, sampleRate: 44100 }), plans[0]!.id)
  const freeze = await page.evaluate(request => window.musicBridge.freezeMasterVersions(request), { commandId: randomUUID(), planId: plans[0]!.id, sampleRate: 44100, proposalFingerprint: proposal.proposalFingerprint, userConfirmed: true as const })
  await expect.poll(async () => (await page.evaluate(id => window.musicBridge.getMasterVersionJob(id), freeze.id)).job?.state).toBe('completed')
  const firstHistory = await page.evaluate(id => window.musicBridge.listMasterVersions(id), saved.draftId), layout = firstHistory.layouts[0]!
  const newerProposal = await page.evaluate(planId => window.musicBridge.previewMasterVersions({ planId, sampleRate: 48000 }), plans[0]!.id)
  const newerFreeze = await page.evaluate(request => window.musicBridge.freezeMasterVersions(request), { commandId: randomUUID(), planId: plans[0]!.id, sampleRate: 48000, proposalFingerprint: newerProposal.proposalFingerprint, userConfirmed: true as const })
  await expect.poll(async () => (await page.evaluate(id => window.musicBridge.getMasterVersionJob(id), newerFreeze.id)).job?.state).toBe('completed')
  const history = await page.evaluate(id => window.musicBridge.listMasterVersions(id), saved.draftId)
  expect(history.layouts[0]!.id).not.toBe(layout.id)
  await openDraft('多历史上下文')
  const next = page.getByTestId('recording-next-step'), action = page.getByTestId('recording-next-action')
  await next.locator('.next-details > summary').click()
  const planSelect = next.getByRole('combobox', { name: '本次媒体规划', exact: true }), layoutSelect = next.getByRole('combobox', { name: '本次冻结布局', exact: true }), pathSelect = next.getByRole('combobox', { name: '本次处理路径', exact: true })
  await expect(action).toHaveAttribute('data-action', 'choose-context'); await expect(planSelect).toHaveValue('')
  await action.click(); await expect(planSelect).toBeFocused()
  await app!.evaluate(({ ipcMain }, input) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>> })._invokeHandlers
    const original = handlers.get('commandOutbox:submit')
    if (!original) throw new Error('缺少正式工作上下文命令 handler')
    const state = { held: false, release: undefined as (() => void) | undefined, restore: () => { ipcMain.removeHandler('commandOutbox:submit'); ipcMain.handle('commandOutbox:submit', original) } }
    ;(globalThis as unknown as { task085WorkspaceHold: typeof state }).task085WorkspaceHold = state
    ipcMain.removeHandler('commandOutbox:submit')
    ipcMain.handle('commandOutbox:submit', async (...args) => {
      const result = await original(...args)
      const submitted = args[1] as { request?: { command?: string; payload?: { draftId?: string; selection?: { planId?: string } } } } | undefined
      if (!state.held && submitted?.request?.command === 'recordingWorkspace.put' && submitted.request.payload?.draftId === input.draftId
        && submitted.request.payload.selection?.planId === input.planId && typeof result === 'object' && result !== null && 'ok' in result && result.ok === true) {
        state.held = true
        await new Promise<void>(resolve => { state.release = resolve })
      }
      return result
    })
  }, { draftId: saved.draftId, planId: plans[0]!.id })
  try {
    await planSelect.selectOption(plans[0]!.id)
    await expect.poll(() => app!.evaluate(() => (globalThis as unknown as { task085WorkspaceHold: { held: boolean } }).task085WorkspaceHold.held)).toBe(true)
    await planSelect.selectOption(plans[1]!.id)
    await expect(planSelect).toHaveValue(plans[1]!.id)
    await app!.evaluate(() => (globalThis as unknown as { task085WorkspaceHold: { release?: () => void } }).task085WorkspaceHold.release?.())
    await expect.poll(async () => (await page.evaluate(id => window.musicBridge.getRecordingWorkspaceContext(id), saved.draftId))?.selection.planId).toBe(plans[1]!.id)
    const expectedDurations = plans[1]!.layout.sides.map(side => `${Math.floor(side.durationMs! / 60_000)}:${String(Math.floor(side.durationMs! / 1000) % 60).padStart(2, '0')}`)
    await expect.poll(() => page.locator('.side-card header > span').allTextContents()).toEqual(expectedDurations)
    await expect(planSelect).toHaveValue(plans[1]!.id)
  } finally {
    await app!.evaluate(() => {
      const state = (globalThis as unknown as { task085WorkspaceHold: { release?: () => void; restore: () => void } }).task085WorkspaceHold
      state.release?.(); state.restore()
    })
  }
  await planSelect.selectOption(plans[0]!.id); await expect(layoutSelect).toHaveValue('')
  await action.click(); await expect(layoutSelect).toBeFocused()
  await layoutSelect.selectOption(layout.id); await expect(pathSelect).toHaveValue('')
  await action.click(); await expect(pathSelect).toBeFocused()
  await pathSelect.selectOption('direct'); await expect(action).toHaveAttribute('data-action', 'execution')
  await expect(next).toContainText('F-01')
  await action.click()
  const executionPanel = page.locator('section.execution-panel.is-inline')
  await expect(executionPanel.getByRole('combobox', { name: '冻结布局', exact: true })).toHaveValue(layout.id)
  await expect(executionPanel.getByRole('combobox', { name: '执行来源', exact: true })).toHaveValue('direct')
  await executionPanel.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(action).toBeEnabled(); await expect(action).toBeFocused()
  for (const size of [{ width: 720, height: 480 }, { width: 1440, height: 900 }]) { await page.setViewportSize(size); await next.scrollIntoViewIfNeeded(); await audit(page.locator('.recording-view'), `recording-context-${size.width}`) }
  await planSelect.selectOption(plans[1]!.id); await expect(layoutSelect).toHaveValue(''); await expect(action).toHaveAttribute('data-action', 'versions')
  await action.click()
  const versionPanel = page.locator('section.versions-panel.is-inline')
  await expect(versionPanel.getByRole('combobox', { name: '已保存的规划', exact: true })).toHaveValue(plans[1]!.id)
  await versionPanel.getByRole('button', { name: '关闭', exact: true }).click(); await expect(action).toBeEnabled(); await expect(action).toBeFocused()
  await planSelect.selectOption(plans[0]!.id); await layoutSelect.selectOption(layout.id)
  await page.evaluate(request => window.musicBridge.releaseMediaPlan(request), { commandId: randomUUID(), planId: plans[0]!.id, expectedRevision: plans[0]!.revision, userConfirmed: true as const })
  await expandRecordingDetails()
  await page.locator('.extra-steps').getByRole('button', { name: '母版与版本', exact: true }).click()
  await page.locator('section.versions-panel.is-inline').getByRole('button', { name: '关闭', exact: true }).click()
  await expect(planSelect).toHaveValue(''); await expect(layoutSelect).toHaveValue('')
  await planSelect.selectOption(plans[0]!.id); await expect(action).toHaveAttribute('data-action', 'media')
  await action.click()
  const mediaPanel = page.locator('section.media-panel.is-inline')
  await expect(mediaPanel.getByRole('combobox', { name: '已存规划', exact: true })).toHaveValue(plans[0]!.id)
  await mediaPanel.getByRole('button', { name: '关闭', exact: true }).click(); await expect(action).toBeFocused()
  expect(await page.evaluate(id => window.musicBridge.listMasterVersions(id), saved.draftId)).toEqual(history)
  expect(await readFile(sourceFile)).toEqual(bytes)
  await expect.poll(async () => { const stored = await page.evaluate(id => window.musicBridge.getRecordingWorkspaceContext(id), saved.draftId); return { planId: stored?.selection.planId, page: stored?.pagePosition } }).toEqual({ planId: plans[0]!.id, page: 'workbench' })
  const storedContext = await page.evaluate(id => window.musicBridge.getRecordingWorkspaceContext(id), saved.draftId)
  await close(); await launch(); await openDraft('多历史上下文')
  await page.getByTestId('recording-next-step').locator('.next-details > summary').click()
  await expect(page.getByTestId('recording-next-step').getByRole('combobox', { name: '本次媒体规划', exact: true })).toHaveValue(plans[0]!.id)
  expect((await page.evaluate(id => window.musicBridge.getRecordingWorkspaceContext(id), saved.draftId))?.selection).toEqual(storedContext?.selection)
  await expect(page.getByTestId('recording-next-action')).toHaveAttribute('data-action', 'media')
})

test('TASK-085 J05：正式 UI 登记发行与逐件、归属照片、关联更正撤销并冷启保留', async () => {
  test.setTimeout(120_000)
  const blocked: string[] = []
  const pageErrors: string[] = [], consoleErrors: string[] = []
  const requestFailures: Array<{ url: string; error: string | null }> = []
  const observePage = () => {
    page.on('pageerror', error => pageErrors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
    page.on('requestfailed', request => requestFailures.push({ url: request.url(), error: request.failure()?.errorText ?? null }))
  }
  const blockExternal = async () => page.route(/^https?:\/\//u, route => {
    blocked.push(route.request().url())
    return route.abort('blockedbyclient')
  })
  observePage()
  await blockExternal()
  await page.locator('[data-sidebar-source="collection"]').click()
  await page.getByRole('tab', { name: '实体音乐库', exact: true }).click()
  await page.getByRole('button', { name: '添加实体音乐', exact: true }).click()
  const editor = page.getByRole('dialog', { name: '添加实体音乐', exact: true })
  await editor.getByLabel('艺术家', { exact: true }).fill('合成艺术家')
  await editor.getByLabel('专辑 / 录音标题', { exact: true }).fill('关联验收专辑')
  await editor.getByLabel('版次', { exact: true }).fill('合成首版')
  await editor.getByLabel('实物数量', { exact: true }).fill('2')
  await editor.getByRole('button', { name: '保存音乐资料', exact: true }).click()
  await expect(page.getByRole('heading', { name: '关联验收专辑', exact: true })).toBeVisible()
  const releaseId = await page.evaluate(async () => {
    const list = await window.musicBridge.listPhysicalMusic({ offset: 0, limit: 20 })
    return list.items.find(item => item.title === '关联验收专辑')!.id
  })
  const copies = page.getByRole('region', { name: '商业发行逐件身份', exact: true })
  await expect(copies).toContainText('发行数量 2 · 已有逐件编号 0 · 未逐件识别 Pool 2')
  for (const assigned of [1, 2]) {
    await copies.getByLabel('我正在核对手上的一件实物，为它分配永久编号；不会增加发行总数', { exact: true }).check()
    await copies.getByRole('button', { name: '给这一件分配永久编号', exact: true }).click()
    await expect(copies).toContainText('已有逐件编号 ' + assigned + ' · 未逐件识别 Pool ' + (2 - assigned))
  }
  const identified = await page.evaluate(id => window.musicBridge.getCommercialCopies(id, { offset: 0, limit: 20 }), releaseId)
  expect(identified.quantity).toBe(2)
  expect(identified.copies.items).toHaveLength(2)
  const [firstId, secondId] = identified.copies.items.map(copy => copy.id)
  const first = copies.locator('.copy-card').filter({ hasText: firstId })
  await first.getByRole('button', { name: '编辑这一件', exact: true }).click()
  await first.getByLabel('这件的存放位置', { exact: true }).fill('书柜 A1')
  await first.getByLabel('这件的品相', { exact: true }).fill('封套完整')
  await first.getByLabel('这件的购买信息', { exact: true }).fill('合成验收购入')
  await first.getByRole('button', { name: '保存这件资料', exact: true }).click()
  await expect(first).toContainText('书柜 A1')
  const afterDetails = await page.evaluate(id => window.musicBridge.getCommercialCopies(id, { offset: 0, limit: 20 }), releaseId)
  expect(afterDetails.copies.items.find(copy => copy.id === firstId)?.details.location).toBe('书柜 A1')
  expect(afterDetails.copies.items.find(copy => copy.id === secondId)?.details.location).toBeUndefined()

  const image = await app!.evaluate(({ nativeImage }) => Array.from(nativeImage.createFromBitmap(Buffer.from([80, 100, 120, 255]), { width: 1, height: 1 }).toPNG()))
  const filePath = test.info().outputPath('j05-synthetic-release-photo.png')
  await writeFile(filePath, Buffer.from(image))
  await app!.evaluate(({ dialog }, target) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] }) }, filePath)
  await page.getByRole('button', { name: '添加发行版照片', exact: true }).click()
  await expect.poll(async () => (await page.evaluate(id => window.musicBridge.getPhysicalMusic(id), releaseId)).photos.length).toBe(1)
  const photoId = (await page.evaluate(id => window.musicBridge.getPhysicalMusic(id), releaseId)).photos[0]!.id
  const beforeAssignment = await page.evaluate(id => window.musicBridge.getCommercialCopies(id, { offset: 0, limit: 20 }), releaseId)
  expect(beforeAssignment.photoAssignments).toHaveLength(0)
  await first.getByRole('combobox', { name: '选择发行版照片', exact: true }).selectOption(photoId)
  await first.getByRole('button', { name: '确认归属这件', exact: true }).click()
  await expect(first).toContainText('明确归属这件的照片')
  const assigned = await page.evaluate(id => window.musicBridge.getCommercialCopies(id, { offset: 0, limit: 20 }), releaseId)
  expect(assigned.copies.items.find(copy => copy.id === firstId)?.photoIds).toEqual([photoId])
  expect(assigned.copies.items.find(copy => copy.id === secondId)?.photoIds).toEqual([])
  expect(assigned.quantity).toBe(2)
  expect((await page.evaluate(() => window.musicBridge.listCollection({ offset: 0, limit: 20 }))).total).toBe(0)

  const relations = page.getByRole('region', { name: 'Roon 数字关联', exact: true })
  async function chooseRelation(relation: 'exact' | 'probable', reason: string) {
    await relations.getByRole('button', { name: '关联 Roon 专辑', exact: true }).click()
    const picker = page.getByRole('dialog', { name: '选择 Roon 专辑', exact: true })
    await picker.getByRole('radio', { name: /关联验收专辑/u }).check()
    await picker.getByRole('combobox', { name: '关系类型', exact: true }).selectOption(relation)
    await picker.getByLabel('确认或更正理由', { exact: true }).fill(reason)
    await picker.getByLabel('我已核对候选信息并确认本次选择', { exact: true }).check()
    await picker.getByRole('button', { name: '确认关联', exact: true }).click()
    await expect(picker).toHaveCount(0)
  }
  await chooseRelation('exact', '合成验收：核对同版')
  await expect(relations).toContainText('Exact · 用户确认同版')
  await chooseRelation('probable', '合成验收：版次尚未确认，降为可能同版')
  await expect(relations).toContainText('Probable · 可能同版')
  const history = relations.getByRole('region', { name: '数字关系历史', exact: true })
  await expect(history).toContainText('确认关联')
  await expect(history).toContainText('更正关联')
  await relations.getByRole('button', { name: '解除关联', exact: true }).click()
  const removal = page.getByRole('group', { name: '确认解除关联', exact: true })
  await removal.getByLabel('解除理由', { exact: true }).fill('合成验收：撤销已核对关系')
  const native = await app!.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().startsWith('musicbridge://app/'))
    if (!window) throw new Error('正式主窗口未找到')
    window.setContentSize(720, 480)
    return { bounds: window.getBounds(), contentBounds: window.getContentBounds(), zoomFactor: window.webContents.getZoomFactor() }
  })
  await expect.poll(async () => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width: native.contentBounds.width, height: native.contentBounds.height })
  const renderer = await page.evaluate(() => ({ innerWidth, innerHeight, devicePixelRatio, visualViewport: window.visualViewport
    ? { width: window.visualViewport.width, height: window.visualViewport.height, scale: window.visualViewport.scale } : null }))
  await writeFile(test.info().outputPath('j05-native-720-geometry.json'), JSON.stringify({ requestedContent: { width: 720, height: 480 }, native, renderer }, null, 2))
  await page.locator('.content-scroll').evaluate(element => { element.scrollTop = element.scrollHeight })
  const revoke = removal.getByRole('button', { name: '确认解除关联', exact: true })
  const actionBounds = await revoke.boundingBox(), playerBounds = await page.locator('.global-player').boundingBox()
  expect(actionBounds).not.toBeNull()
  expect(playerBounds).not.toBeNull()
  expect(actionBounds!.y + actionBounds!.height).toBeLessThanOrEqual(playerBounds!.y - 4)
  await revoke.click()
  await expect(history).toContainText('撤销关联')
  await expect(relations.getByText('尚未关联，数字版本是否存在仍待核实', { exact: true })).toBeVisible()
  expect((await page.evaluate(id => window.musicBridge.getPhysicalLinks(id), releaseId)).links).toHaveLength(0)
  await page.screenshot({ path: test.info().outputPath('j05-revoked-720.png'), scale: 'css' })

  await page.getByRole('button', { name: '← 返回音乐库', exact: true }).click()
  await expect(page.locator('.music-card').filter({ hasText: '关联验收专辑' })).toBeVisible()
  await close()
  await launch()
  observePage()
  await blockExternal()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.locator('[data-sidebar-source="collection"]').click()
  await page.getByRole('tab', { name: '实体音乐库', exact: true }).click()
  await page.locator('.music-card').filter({ hasText: '关联验收专辑' }).click()
  const restored = await page.evaluate(async id => ({
    detail: await window.musicBridge.getPhysicalMusic(id),
    copies: await window.musicBridge.getCommercialCopies(id, { offset: 0, limit: 20 }),
    links: await window.musicBridge.getPhysicalLinks(id),
  }), releaseId)
  expect(restored.detail.release?.quantity).toBe(2)
  expect(restored.detail.photos.map(photo => photo.id)).toEqual([photoId])
  expect(restored.copies.copies.items.find(copy => copy.id === firstId)?.photoIds).toEqual([photoId])
  expect(restored.copies.copies.items.find(copy => copy.id === firstId)?.details.location).toBe('书柜 A1')
  expect(restored.copies.copies.items.find(copy => copy.id === secondId)?.photoIds).toEqual([])
  expect(restored.links.links).toHaveLength(0)
  await expect(page.getByRole('region', { name: '数字关系历史', exact: true })).toContainText('撤销关联')
  await page.screenshot({ path: test.info().outputPath('j05-cold-reopen-1440.png'), scale: 'css' })
  await writeFile(test.info().outputPath('j05-network-and-errors.json'), JSON.stringify({
    blocked, requestFailures, pageErrors, consoleErrors,
    knownSyntheticCoverBlocked: blocked.filter(url => url === 'https://p1.music.126.net/synthetic-cover.jpg').length,
    boundary: '拦截器在每次 launch 后安装；启动阶段请求不在拦截断言范围内。',
  }, null, 2))
})
