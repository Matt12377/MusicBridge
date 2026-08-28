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
  app = await electron.launch({ args: [path.join(root, 'dist/main/index.js')], cwd: root, env: { ...env, MUSIC_BRIDGE_UI_E2E: '1', MUSIC_BRIDGE_CORE_TEST_MODE: '1', MUSIC_BRIDGE_SYNTHETIC_ROON_LIBRARY: '1', MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR: directory } })
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
  await expect(next).toContainText('源')
  await action.click(); const source = page.getByRole('dialog', { name: '实际源文件', exact: true })
  await expect(source).toBeVisible(); await source.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(action).toBeEnabled()
  await page.getByLabel('草稿标题', { exact: true }).fill('修改后合成草稿')
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
    const exact = await window.musicBridge.confirmPhysicalLink({ commandId: crypto.randomUUID(), releaseId: cd.id, expectedRevision: 1, reference: first.reference, relation: 'exact', ripFromCdConfirmed: true, userConfirmed: true })
    await window.musicBridge.confirmPhysicalLink({ commandId: crypto.randomUUID(), releaseId: related.id, expectedRevision: 1, digitalId: exact.digitalId!, relation: 'probable', ripFromCdConfirmed: false, userConfirmed: true })
    return { digitalId: exact.digitalId!, before: await window.musicBridge.getCollectionMatrix({ offset: 0, limit: 25 }) }
  })
  await page.locator('[data-sidebar-source="recording"]').click()
  await page.getByRole('button', { name: '从 Roon 选择音乐', exact: true }).click()
  const picker = page.getByRole('dialog', { name: '从 Roon 选择曲目', exact: true })
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
  const trigger = page.getByRole('button', { name: '从 Roon 选择音乐', exact: true }); await trigger.click()
  const picker = page.getByRole('dialog', { name: '从 Roon 选择曲目', exact: true })
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
    await page.getByRole('button', { name: '从 Roon 选择音乐', exact: true }).click()
    const picker = page.getByRole('dialog', { name: '从 Roon 选择曲目', exact: true })
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
  const planSelect = next.getByRole('combobox', { name: '本次媒体规划', exact: true }), layoutSelect = next.getByRole('combobox', { name: '本次冻结布局', exact: true }), pathSelect = next.getByRole('combobox', { name: '本次处理路径', exact: true })
  await expect(action).toHaveAttribute('data-action', 'choose-context'); await expect(planSelect).toHaveValue('')
  await action.click(); await expect(planSelect).toBeFocused()
  await planSelect.selectOption(plans[0]!.id); await expect(layoutSelect).toHaveValue('')
  await action.click(); await expect(layoutSelect).toBeFocused()
  await layoutSelect.selectOption(layout.id); await expect(pathSelect).toHaveValue('')
  await action.click(); await expect(pathSelect).toBeFocused()
  await pathSelect.selectOption('direct'); await expect(action).toHaveAttribute('data-action', 'execution')
  await expect(next).toContainText('F-01')
  await action.click()
  const executionPanel = page.getByRole('dialog', { name: '录音参数与执行资产', exact: true })
  await expect(executionPanel.getByRole('combobox', { name: '冻结布局', exact: true })).toHaveValue(layout.id)
  await expect(executionPanel.getByRole('combobox', { name: '执行来源', exact: true })).toHaveValue('direct')
  await executionPanel.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(action).toBeEnabled(); await expect(action).toBeFocused()
  for (const size of [{ width: 720, height: 480 }, { width: 1440, height: 900 }]) { await page.setViewportSize(size); await next.scrollIntoViewIfNeeded(); await audit(page.locator('.recording-view'), `recording-context-${size.width}`) }
  await planSelect.selectOption(plans[1]!.id); await expect(layoutSelect).toHaveValue(''); await expect(action).toHaveAttribute('data-action', 'versions')
  await action.click()
  const versionPanel = page.getByRole('dialog', { name: '母版与布局版本', exact: true })
  await expect(versionPanel.getByRole('combobox', { name: '已保存的规划', exact: true })).toHaveValue(plans[1]!.id)
  await versionPanel.getByRole('button', { name: '关闭', exact: true }).click(); await expect(action).toBeEnabled(); await expect(action).toBeFocused()
  await planSelect.selectOption(plans[0]!.id); await layoutSelect.selectOption(layout.id)
  await page.evaluate(request => window.musicBridge.releaseMediaPlan(request), { commandId: randomUUID(), planId: plans[0]!.id, expectedRevision: plans[0]!.revision, userConfirmed: true as const })
  await page.getByRole('button', { name: '母版与布局版本', exact: true }).click()
  await page.getByRole('dialog', { name: '母版与布局版本', exact: true }).getByRole('button', { name: '关闭', exact: true }).click()
  await expect(planSelect).toHaveValue(''); await expect(layoutSelect).toHaveValue('')
  await planSelect.selectOption(plans[0]!.id); await expect(action).toHaveAttribute('data-action', 'media')
  await action.click()
  const mediaPanel = page.getByRole('dialog', { name: '分面与选择磁带', exact: true })
  await expect(mediaPanel.getByRole('combobox', { name: '已存规划', exact: true })).toHaveValue(plans[0]!.id)
  await mediaPanel.getByRole('button', { name: '关闭', exact: true }).click(); await expect(action).toBeFocused()
  expect(await page.evaluate(id => window.musicBridge.listMasterVersions(id), saved.draftId)).toEqual(history)
  expect(await readFile(sourceFile)).toEqual(bytes)
  await close(); await launch(); await openDraft('多历史上下文')
  await expect(page.getByTestId('recording-next-step').getByRole('combobox', { name: '本次媒体规划', exact: true })).toHaveValue('')
})
