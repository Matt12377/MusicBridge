import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, readFile, rm, mkdir, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// 本模块由 tsconfig.e2e.json 独立检查；历史 v1 用例尚未纳入此类型 Gate。
export interface Task066E2eSession {
  electronApp: ElectronApplication
  page: Page
}

interface BackupWorkflowContext {
  session: Task066E2eSession
  electronEntry: string
  desktopRoot: string
  diagnosticDirectory: string
  axeSource: string
}

export async function verifyInactiveWindowRestore(session: Task066E2eSession): Promise<void> {
  const { electronApp, page } = session
  const search = page.getByRole('searchbox', { name: '搜索歌曲或歌手' })
  await search.fill('synthetic')
  await expect(page.getByText('Synthetic Track 1', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '播放 Synthetic Track 1', exact: true }).click()
  await expect(page.locator('.now-playing-fullscreen')).toBeVisible()
  await expect.poll(async () => (await page.evaluate(() => window.musicBridge.getPlaybackState())).state).toBe('playing')

  const originalWindowId = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.id)
  const hidden = await electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    if (!window) return false
    window.close()
    return !window.isVisible()
  })
  expect(hidden).toBe(true)
  expect((await page.evaluate(() => window.musicBridge.getPlaybackState())).state).toBe('playing')

  const restored = await electronApp.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]!
    const observation = globalThis as typeof globalThis & { task066FocusEvents?: number }
    observation.task066FocusEvents = 0
    window.on('focus', () => { observation.task066FocusEvents = (observation.task066FocusEvents ?? 0) + 1 })
    app.emit('activate')
    return { id: window.id, visible: window.isVisible(), focused: window.isFocused() }
  })
  expect(restored).toEqual({ id: originalWindowId, visible: true, focused: false })
  await expect(page.locator('.now-playing-fullscreen')).toBeVisible()

  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('app:command', 'show-queue')
  })
  await expect(page.locator('.playback-inspector').getByRole('heading', { name: '播放队列', exact: true }).first()).toBeVisible()
  expect((await page.evaluate(() => window.musicBridge.getPlaybackState())).state).toBe('playing')
  // 同时检查原生焦点与恢复期间的 focus 事件，避免短暂抢焦点后又失焦被漏掉。
  expect(await electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]!
    const observation = globalThis as typeof globalThis & { task066FocusEvents?: number }
    return { id: window.id, focused: window.isFocused(), focusEvents: observation.task066FocusEvents }
  })).toEqual({ id: originalWindowId, focused: false, focusEvents: 0 })
}

export async function verifyBackupRestoreWorkflow({ session, electronEntry, desktopRoot, diagnosticDirectory, axeSource }: BackupWorkflowContext): Promise<void> {
  let { electronApp, page } = session
  test.setTimeout(120_000)
  const work = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-backup-ui-'))
  try {
    const backup = path.join(work, '备份'), restore = path.join(work, '恢复'); await mkdir(backup); await mkdir(restore)
    expect(await electronApp.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]!; return { visible: window.isVisible(), focused: window.isFocused() } })).toEqual({ visible: false, focused: false })
    await page.locator('[data-sidebar-source="recording"]').click()
    const trigger = page.getByRole('button', { name: '备份与恢复', exact: true }); await trigger.click()
    const panel = page.getByRole('dialog', { name: '备份与恢复', exact: true })
    await expect(panel).toBeVisible()
    await electronApp.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }) }, backup)
    const retainedStock = await page.evaluate(() => window.musicBridge.receiveCollectionStock({ commandId: crypto.randomUUID(), model: { brand: '合成', name: '备份内库存', edition: '激活验证', year: 1990, format: 'cassette', tapeType: 'II', identification: 'verified' }, lengthMinutes: 60, quantities: { sealedBlank: 1, openedBlank: 0, legacyUsed: 0, unclassified: 0 } }))
    await panel.getByRole('button', { name: '选择备份目标目录', exact: true }).click()
    expect(await readdir(backup)).toEqual([])
    await panel.getByRole('combobox', { name: '备份范围', exact: true }).selectOption('metadata')
    await expect(panel.getByRole('button', { name: '确认并开始备份', exact: true })).toBeDisabled()
    await panel.getByLabel('我确认备份所选范围到新建子目录，不覆盖已有文件', { exact: true }).check()
    await electronApp.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>> })._invokeHandlers
      const original = handlers.get('recordingBackups:start')!; let lost = false
      ipcMain.removeHandler('recordingBackups:start'); ipcMain.handle('recordingBackups:start', async (...args) => { const result = await original(...args); if (!lost) { lost = true; throw new Error('合成备份回执丢失') }; return result })
    })
    await panel.getByRole('button', { name: '确认并开始备份', exact: true }).click()
    await panel.getByRole('button', { name: '重试备份恢复原操作', exact: true }).click()
    await expect.poll(async () => (await page.evaluate(() => window.musicBridge.getBackupOverview())).jobs.filter(j => j.kind === 'backup' && j.state === 'succeeded').length).toBe(1)
    expect(await readdir(backup)).toHaveLength(1)
    const laterStock = await page.evaluate(() => window.musicBridge.receiveCollectionStock({ commandId: crypto.randomUUID(), model: { brand: '合成', name: '备份后库存', edition: '旧库保留验证', year: 1990, format: 'cassette', tapeType: 'II', identification: 'verified' }, lengthMinutes: 60, quantities: { sealedBlank: 1, openedBlank: 0, legacyUsed: 0, unclassified: 0 } }))
    expect((await page.evaluate(() => window.musicBridge.listCollection({ offset: 0, limit: 100 }))).total).toBe(2)
    await panel.getByRole('button', { name: '刷新备份恢复状态', exact: true }).click()
    await panel.getByRole('button', { name: '校验所选备份', exact: true }).click()
    await expect(panel.getByText('备份完整性核验通过', { exact: true })).toBeVisible()
    await panel.getByRole('button', { name: '检查基本索引', exact: true }).click()
    await expect(panel.getByText('基本索引已读取；历史事实仍需审核', { exact: true })).toBeVisible()
    await panel.getByText('查看索引问题与未知事实', { exact: true }).click()
    await expect(panel.getByText('未发现清单或对象内容问题；以下历史事实仍然未知。', { exact: true })).toBeVisible()
    await expect(panel.getByRole('list', { name: '基本索引无法重建的事实' }).getByRole('listitem')).toHaveCount(5)
    await electronApp.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }) }, restore)
    await panel.getByRole('button', { name: '选择隔离恢复目标目录', exact: true }).click()
    expect(await readdir(restore)).toEqual([])
    await expect(panel.getByRole('button', { name: '确认并隔离恢复', exact: true })).toBeDisabled()
    await panel.getByLabel('我确认创建隔离恢复副本，当前工作库保持不变', { exact: true }).check()
    await panel.getByRole('button', { name: '确认并隔离恢复', exact: true }).click()
    await expect(panel.getByText('隔离恢复已完成；当前工作库未切换。', { exact: true })).toBeVisible()
    const history = await page.evaluate(() => window.musicBridge.getBackupOverview())
    expect(JSON.stringify(history)).not.toContain(work)
    const restored = history.jobs.find(j => j.kind === 'restore')!
    expect(JSON.parse(await readFile(path.join(restore, restored.id, 'Restore.json'), 'utf8')).state).toBe('isolated-pending-activation')
    await page.setViewportSize({ width: 720, height: 800 })
    await page.evaluate(axeSource)
    const a11y = await page.evaluate(async () => (window as typeof window & { axe: { run(root: Element): Promise<{ violations: { impact: string | null }[] }> } }).axe.run(document.querySelector('dialog[open]')!))
    expect(a11y.violations.filter(v => v.impact === 'critical' || v.impact === 'serious')).toEqual([])
    expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    await page.screenshot({ path: test.info().outputPath('backup-restore-720.png') })
    await panel.getByRole('button', { name: '返回录音', exact: true }).click(); await expect(trigger).toBeFocused()
    const environment: Record<string, string> = {
      ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      MUSIC_BRIDGE_UI_E2E: '1',
      MUSIC_BRIDGE_CORE_TEST_MODE: '1',
      MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR: diagnosticDirectory,
    }
    delete environment.NETEASE_COOKIE; delete environment.MUSIC_BRIDGE_SYNTHETIC_ROON_LIBRARY
    await electronApp.close()
    const oldDatabasePath = path.join(diagnosticDirectory, 'data', 'collection.v1.sqlite')
    const oldDatabaseBytes = await readFile(oldDatabasePath)
    session.electronApp = electronApp = await electron.launch({ args: [electronEntry], cwd: desktopRoot, env: environment }); session.page = page = await electronApp.firstWindow()
    await page.setViewportSize({ width: 720, height: 800 })
    await expect.poll(async () => (await page.evaluate(() => window.musicBridge.getCoreHealth())).runtime).toBe('ready')
    expect(await page.evaluate(() => window.musicBridge.getBackupOverview())).toEqual(history)
    await page.locator('[data-sidebar-source="recording"]').click(); await page.getByRole('button', { name: '备份与恢复', exact: true }).click()
    await expect(page.getByText('隔离恢复已完成；当前工作库未切换。', { exact: true })).toBeVisible()
    const activationPanel = page.getByRole('dialog', { name: '备份与恢复', exact: true })
    const activationButton = activationPanel.getByRole('button', { name: '确认停止播放并切换工作库', exact: true })
    await expect(activationButton).toBeDisabled()
    expect((await page.evaluate(() => window.musicBridge.listCollection({ offset: 0, limit: 100 }))).total).toBe(2)
    await activationPanel.getByLabel('我确认停止播放、重启 Core 并复制为新工作库；保留旧库，丢弃未保存的录音编辑', { exact: true }).check()
    await expect(activationButton).toBeEnabled()
    await page.evaluate(async () => {
      const tracks = await window.musicBridge.searchTracks('synthetic', { offset: 0, limit: 20 })
      await window.musicBridge.play(tracks.items[0]!.id, 'auto')
    })
    await expect.poll(async () => (await page.evaluate(() => window.musicBridge.getPlaybackState())).state).toBe('playing')
    const beforeCore = await electronApp.evaluate(({ app }) => app.getAppMetrics().filter(p => p.name === 'Music Bridge Core' || p.serviceName === 'Music Bridge Core').map(p => ({ pid: p.pid, created: p.creationTime })))
    expect(beforeCore).toHaveLength(1)
    await electronApp.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>> })._invokeHandlers
      const original = handlers.get('recordingBackups:activate')!; let lost = false
      ipcMain.removeHandler('recordingBackups:activate')
      ipcMain.handle('recordingBackups:activate', async (...args) => {
        const result = await original(...args)
        if (!lost) { lost = true; throw new Error('合成激活回执丢失') }
        return result
      })
    })
    await activationButton.click()
    const retryActivation = activationPanel.getByRole('button', { name: '重试备份恢复原操作', exact: true })
    await expect(retryActivation).toBeVisible({ timeout: 30_000 })
    const activatedCore = await electronApp.evaluate(({ app }) => app.getAppMetrics().filter(p => p.name === 'Music Bridge Core' || p.serviceName === 'Music Bridge Core').map(p => ({ pid: p.pid, created: p.creationTime })))
    expect(activatedCore).toHaveLength(1); expect(activatedCore).not.toEqual(beforeCore)
    await retryActivation.click()
    await expect(activationPanel.getByText('已切换到恢复工作库；旧库保留，播放不会自动恢复。', { exact: true })).toBeVisible()
    expect(await electronApp.evaluate(({ app }) => app.getAppMetrics().filter(p => p.name === 'Music Bridge Core' || p.serviceName === 'Music Bridge Core').map(p => ({ pid: p.pid, created: p.creationTime })))).toEqual(activatedCore)
    const activated = (await page.evaluate(() => window.musicBridge.getBackupOverview())).activations
    expect(activated).toHaveLength(1); expect(activated[0]).toMatchObject({ restoreJobId: restored.id, state: 'active', contentIncluded: false })
    const currentCollection = await page.evaluate(() => window.musicBridge.listCollection({ offset: 0, limit: 100 }))
    expect(currentCollection.items.map(item => item.id)).toEqual([retainedStock.modelId])
    expect((await page.evaluate(() => window.musicBridge.getPlaybackState())).state).toBe('idle')
    expect(await readFile(oldDatabasePath)).toEqual(oldDatabaseBytes)
    const oldDatabase = new DatabaseSync(oldDatabasePath, { readOnly: true })
    try { expect(oldDatabase.prepare('SELECT id FROM collection_models ORDER BY id').all().map(row => row.id)).toEqual([retainedStock.modelId, laterStock.modelId].sort()) }
    finally { oldDatabase.close() }
    await page.evaluate(axeSource)
    const activeA11y = await page.evaluate(async () => (window as typeof window & { axe: { run(root: Element): Promise<{ violations: { impact: string | null }[] }> } }).axe.run(document.querySelector('dialog[open]')!))
    expect(activeA11y.violations.filter(v => v.impact === 'critical' || v.impact === 'serious')).toEqual([])
    expect(await activationPanel.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    await activationPanel.getByText('已切换到恢复工作库；旧库保留，播放不会自动恢复。', { exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: test.info().outputPath('restored-dataset-active-720.png') })
    await electronApp.close()
    session.electronApp = electronApp = await electron.launch({ args: [electronEntry], cwd: desktopRoot, env: environment }); session.page = page = await electronApp.firstWindow()
    await expect.poll(async () => (await page.evaluate(() => window.musicBridge.getCoreHealth())).runtime).toBe('ready')
    expect((await page.evaluate(() => window.musicBridge.getBackupOverview())).activations).toEqual(activated)
    expect((await page.evaluate(() => window.musicBridge.listCollection({ offset: 0, limit: 100 }))).items.map(item => item.id)).toEqual([retainedStock.modelId])
    expect((await page.evaluate(() => window.musicBridge.getPlaybackState())).state).toBe('idle')
    expect(await readFile(oldDatabasePath)).toEqual(oldDatabaseBytes)
  } finally { await rm(work, { recursive: true, force: true }) }
}
