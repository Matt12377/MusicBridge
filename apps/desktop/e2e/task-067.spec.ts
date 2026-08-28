import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CollectionReceiveRequest } from '@music-bridge/contracts'
import type { StoredPreparedSelection } from '../../../packages/bridge-core/src/recording/prepared-store.js'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const axe = await readFile(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8')
let app: ElectronApplication | undefined, page: Page, directory: string
async function launch(): Promise<void> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !/^(MUSIC_BRIDGE_|NETEASE_|ROON_)/u.test(key))) as Record<string, string>
  app = await electron.launch({ args: [path.join(root, 'dist/main/index.js')], cwd: root, env: { ...env, MUSIC_BRIDGE_UI_E2E: '1', MUSIC_BRIDGE_CORE_TEST_MODE: '1', MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR: directory } })
  page = await app.firstWindow(); await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('#home-heading')).toBeVisible()
  await expect.poll(async () => (await page.evaluate(() => window.musicBridge.getCoreHealth())).runtime).toBe('ready')
}
async function close(): Promise<void> { const current = app; app = undefined; await current?.close().catch(() => undefined) }
test.beforeEach(async () => { test.setTimeout(120_000); directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-ui-e2e-outbox-')); await mkdir(test.info().outputDir, { recursive: true }); await writeFile(test.info().outputPath('synthetic-user-data-path.txt'), directory); await launch() })
test.afterEach(close)
function stock(name: string): CollectionReceiveRequest { return { commandId: crypto.randomUUID(), model: { brand: '合成', name, edition: 'outbox验证', year: 1990, format: 'cassette', tapeType: 'II', identification: 'verified' }, lengthMinutes: 60, quantities: { openedBlank: 1, sealedBlank: 0, legacyUsed: 0, unclassified: 0 } } }
async function armReceiptFailure(mode: 'throw' | 'kill'): Promise<void> {
  await app!.evaluate(async (_electron, mode) => {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite')
    const prepare = DatabaseSync.prototype.prepare
    DatabaseSync.prototype.prepare = function (sql: string) {
      const statement = prepare.call(this, sql)
      if (sql.startsWith('UPDATE outbox_states SET result_json=')) {
        // Core已完成业务，Main尚未保存回执；只在本合成进程注入这一窄窗口。
        DatabaseSync.prototype.prepare = prepare
        Object.defineProperty(statement, 'run', { value: () => { if (mode === 'kill') process.kill(process.pid, 'SIGKILL'); throw new Error('合成回执落盘中断') } })
      }
      return statement
    }
  }, mode)
}
async function openOutbox() { await page.getByRole('button', { name: '未确认操作', exact: true }).click(); const panel = page.getByRole('dialog', { name: '未确认操作', exact: true }); await expect(panel).toBeVisible(); return panel }

for (const mode of ['throw', 'kill'] as const) {
  test(`V3 outbox：${mode === 'kill' ? '真实Main SIGKILL' : '回执落盘失败与Renderer刷新'}后无自动投递，人工原命令恢复不重复库存`, async () => {
    const request = stock('跨重启原命令'), oldScope = (await page.evaluate(() => window.musicBridge.getCommandOutbox())).datasetId
    const child = app!.process(); const stopped = mode === 'kill' ? new Promise<void>(resolve => child.once('exit', () => resolve())) : undefined
    await armReceiptFailure(mode)
    await page.evaluate(request => window.musicBridge.receiveCollectionStock(request), request).then(() => { throw new Error('故障注入必须使回执未知') }, () => undefined)
    if (stopped) { await stopped; app = undefined }
    else {
      expect((await page.evaluate(() => window.musicBridge.listCollection({ offset: 0, limit: 10 }))).total).toBe(1)
      const before = await page.evaluate(() => window.musicBridge.getCommandOutbox()); expect(before.entries).toHaveLength(1); expect(before.entries[0]?.state).toBe('uncertain')
      await page.reload(); await expect(page.locator('#home-heading')).toBeVisible()
      expect(await page.evaluate(() => window.musicBridge.getCommandOutbox())).toEqual(before)
      await close()
    }
    await launch()
    const overview = await page.evaluate(() => window.musicBridge.getCommandOutbox())
    expect(overview.datasetId).toBe(oldScope); expect(overview.entries).toHaveLength(1); expect(overview.entries[0]?.state).toBe('uncertain')
    expect((await page.evaluate(() => window.musicBridge.listCollection({ offset: 0, limit: 10 }))).total).toBe(1)
    expect(JSON.stringify(overview)).not.toContain('payload'); expect(JSON.stringify(overview)).not.toContain(directory)
    await page.setViewportSize({ width: 720, height: 800 })
    const panel = await openOutbox(), row = panel.locator(`[data-outbox-id="${overview.entries[0]!.id}"]`)
    await expect(row.getByRole('button', { name: '按原命令重试', exact: true })).toBeDisabled()
    await page.evaluate(axe)
    const issues = await page.evaluate(async () => (window as typeof window & { axe: { run(root: Element): Promise<{ violations: { impact: string | null }[] }> } }).axe.run(document.querySelector('dialog[open]')!))
    expect(issues.violations.filter(issue => issue.impact === 'critical' || issue.impact === 'serious')).toEqual([])
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await page.screenshot({ path: test.info().outputPath('outbox-pending-720.png') })
    await row.getByLabel('我已核对该操作及上述影响，确认恢复原操作', { exact: true }).check()
    await row.getByRole('button', { name: '按原命令重试', exact: true }).click()
    await expect(row.getByText('已成功，待确认', { exact: true })).toBeVisible()
    expect((await page.evaluate(() => window.musicBridge.listCollection({ offset: 0, limit: 10 }))).total).toBe(1)
    await row.getByRole('button', { name: '成功结果已确认', exact: true }).click()
    await expect(panel.getByText('没有待确认操作。', { exact: true })).toBeVisible()
    await close()
    const db = new DatabaseSync(path.join(directory, 'data', 'collection.v1.sqlite'), { readOnly: true })
    try { expect(db.prepare('SELECT count(*) n FROM inventory_ledger WHERE command_id=?').get(request.commandId)?.n).toBe(1) } finally { db.close() }
    const outbox = new DatabaseSync(path.join(directory, 'data', 'command-outbox.v1.sqlite'), { readOnly: true })
    try { expect(outbox.prepare('SELECT state,acknowledged FROM outbox_states').get()).toMatchObject({ state: 'succeeded', acknowledged: 1 }) } finally { outbox.close() }
  })
}

test('V3 outbox：切库旧命令隔离，激活未知回执只读恢复不再次重启', async () => {
  const backupPath = path.join(directory, '备份'), restorePath = path.join(directory, '恢复'); await mkdir(backupPath); await mkdir(restorePath)
  await page.evaluate(request => window.musicBridge.receiveCollectionStock(request), stock('备份内库存'))
  await app!.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }) }, backupPath)
  const destination = await page.evaluate(() => window.musicBridge.chooseBackupRoot({ commandId: crypto.randomUUID(), kind: 'backup-destination' }))
  const job = await page.evaluate(rootId => window.musicBridge.startBackupJob({ commandId: crypto.randomUUID(), rootId, kind: 'backup', mode: 'metadata', userConfirmed: true }), destination!.id)
  await expect.poll(async () => (await page.evaluate(() => window.musicBridge.getBackupOverview())).jobs.find(item => item.id === job.id)?.state).toBe('succeeded')
  const backup = (await page.evaluate(() => window.musicBridge.getBackupOverview())).roots.find(item => item.kind === 'backup-source')!
  const verification = await page.evaluate(rootId => window.musicBridge.startBackupJob({ commandId: crypto.randomUUID(), rootId, kind: 'verify', userConfirmed: true }), backup.id)
  await expect.poll(async () => (await page.evaluate(() => window.musicBridge.getBackupOverview())).jobs.find(item => item.id === verification.id)?.state).toBe('succeeded')
  await app!.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }) }, restorePath)
  const restoreRoot = await page.evaluate(() => window.musicBridge.chooseBackupRoot({ commandId: crypto.randomUUID(), kind: 'restore-destination' }))
  const restored = await page.evaluate(input => window.musicBridge.startBackupJob({ commandId: crypto.randomUUID(), kind: 'restore', ...input, userConfirmed: true }), { rootId: backup.id, destinationId: restoreRoot!.id, verificationId: verification.id })
  await expect.poll(async () => (await page.evaluate(() => window.musicBridge.getBackupOverview())).jobs.find(item => item.id === restored.id)?.state).toBe('succeeded')
  await armReceiptFailure('throw'); const oldRequest = stock('仅旧库未知库存')
  await page.evaluate(request => window.musicBridge.receiveCollectionStock(request), oldRequest).then(() => { throw new Error('应丢失库存回执') }, () => undefined)
  const oldOverview = await page.evaluate(() => window.musicBridge.getCommandOutbox()), oldEntry = oldOverview.entries[0]!
  const activation = { commandId: crypto.randomUUID(), restoreJobId: restored.id, expectedActiveId: null, userConfirmed: true as const, stopPlaybackConfirmed: true as const }
  await armReceiptFailure('throw')
  await page.evaluate(request => window.musicBridge.activateRestoredDataset(request), activation).then(() => { throw new Error('应丢失激活回执') }, () => undefined)
  const switched = await page.evaluate(() => window.musicBridge.getCommandOutbox())
  expect(switched.datasetId).not.toBe(oldOverview.datasetId)
  expect(switched.entries.find(item => item.id === oldEntry.id)?.canRetry).toBe(false)
  const activateEntry = switched.entries.find(item => item.commandId === activation.commandId)!
  expect(activateEntry.state).toBe('uncertain'); expect(activateEntry.canRetry).toBe(true)
  const processes = () => app!.evaluate(({ app }) => app.getAppMetrics().filter(item => item.name === 'Music Bridge Core' || item.serviceName === 'Music Bridge Core').map(item => item.pid))
  const before = await processes(); expect(before).toHaveLength(1)
  await page.evaluate(id => window.musicBridge.retryCommandOutbox({ id, userConfirmed: true }), oldEntry.id).then(() => { throw new Error('不能重放旧库存') }, () => undefined)
  expect((await page.evaluate(() => window.musicBridge.listCollection({ offset: 0, limit: 10 }))).total).toBe(1)
  const stale = stock('旧编辑上下文不能新写')
  await page.evaluate(request => window.musicBridge.receiveCollectionStock(request), stale).then(() => { throw new Error('旧Renderer scope必须阻挡') }, () => undefined)
  expect((await page.evaluate(() => window.musicBridge.listCollection({ offset: 0, limit: 10 }))).total).toBe(1)
  await page.setViewportSize({ width: 720, height: 800 }); const panel = await openOutbox(), row = panel.locator(`[data-outbox-id="${activateEntry.id}"]`)
  await row.getByLabel('我确认仅恢复原切换回执，不重新执行切换', { exact: true }).check()
  await row.getByRole('button', { name: '恢复切换回执', exact: true }).click()
  await expect(row.getByText('已成功，待确认', { exact: true })).toBeVisible()
  expect(await processes()).toEqual(before)
  await page.screenshot({ path: test.info().outputPath('outbox-dataset-isolation-720.png') })
  await page.reload(); await expect(page.locator('#home-heading')).toBeVisible()
  await page.evaluate(request => window.musicBridge.receiveCollectionStock(request), stock('新上下文独立库存'))
  expect((await page.evaluate(() => window.musicBridge.listCollection({ offset: 0, limit: 10 }))).total).toBe(2)
  expect((await page.evaluate(() => window.musicBridge.getPlaybackState())).state).toBe('idle')
})

test('V3 outbox：复合撤权首项发送前Main被SIGKILL，整批仍可人工恢复且不删文件', async () => {
  await close()
  const preparationId = crypto.randomUUID(), sourcePath = path.join(directory, '合成PREP源'); await mkdir(sourcePath)
  const identity = await stat(sourcePath, { bigint: true }), requests = ['A', 'B'].map(() => ({ commandId: crypto.randomUUID(), id: crypto.randomUUID() }))
  // 本用例只验证跨进程撤权恢复：预置合成授权记录，真实选择与PREP导入由既有E2E覆盖。
  const seed = new DatabaseSync(path.join(directory, 'data', 'collection.v1.sqlite'))
  try {
    for (let index = 0; index < requests.length; index++) {
      const request = requests[index]!, fileName = `合成-${index}.wav`; await writeFile(path.join(sourcePath, fileName), '合成保留字节')
      const value: StoredPreparedSelection = { public: { id: request.id, preparationId, side: index === 0 ? 'A' : 'B', label: fileName, authorized: true }, root: { id: crypto.randomUUID(), path: sourcePath, dev: String(identity.dev), ino: String(identity.ino), authorized: true, label: '合成PREP源' }, relative: fileName, signature: '合成撤权测试不读取音频', createdAt: new Date().toISOString(), creationTimeEvidence: 'first-observed' }
      seed.prepare('INSERT INTO prepared_selections(id,data) VALUES (?,?)').run(request.id, JSON.stringify(value))
    }
  } finally { seed.close() }
  const authorizations = (): boolean[] => {
    const inspection = new DatabaseSync(path.join(directory, 'data', 'collection.v1.sqlite'), { readOnly: true })
    try {
      return requests.map(request => {
        const row = inspection.prepare('SELECT data FROM prepared_selections WHERE id=?').get(request.id)
        expect(row).toBeDefined()
        const value = JSON.parse(String(row!.data)) as StoredPreparedSelection
        expect(value.public.id).toBe(request.id); expect(value.root.authorized).toBe(value.public.authorized)
        return value.public.authorized
      })
    } finally { inspection.close() }
  }
  await launch()
  expect(authorizations()).toEqual([true, true])
  await app!.evaluate(() => {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite'), prepare = DatabaseSync.prototype.prepare
    DatabaseSync.prototype.prepare = function (sql: string) {
      const statement = prepare.call(this, sql)
      if (sql.startsWith('UPDATE outbox_states SET state=?')) {
        DatabaseSync.prototype.prepare = prepare
        Object.defineProperty(statement, 'run', { value: () => { process.kill(process.pid, 'SIGKILL'); throw new Error('合成首发前进程终止') } })
      }
      return statement
    }
  })
  const stopped = new Promise<void>(resolve => app!.process().once('exit', () => resolve()))
  await page.evaluate(requests => window.musicBridge.revokePreparedSelections(requests), requests).then(() => { throw new Error('故障必须中断回执') }, () => undefined)
  await stopped; app = undefined; await launch()
  const overview = await page.evaluate(() => window.musicBridge.getCommandOutbox())
  expect(overview.entries).toHaveLength(2)
  expect(overview.entries.map(item => item.commandId).sort()).toEqual(requests.map(item => item.commandId).sort())
  expect(overview.entries.every(item => item.state === 'pending' && item.canRetry)).toBe(true)
  expect(authorizations()).toEqual([true, true])
  await page.reload(); await expect(page.locator('#home-heading')).toBeVisible()
  expect(authorizations()).toEqual([true, true])
  for (const entry of overview.entries) await page.evaluate(id => window.musicBridge.retryCommandOutbox({ id, userConfirmed: true }), entry.id)
  expect(authorizations()).toEqual([false, false])
  for (const entry of overview.entries) await page.evaluate(id => window.musicBridge.retryCommandOutbox({ id, userConfirmed: true }), entry.id)
  await close()
  const verified = new DatabaseSync(path.join(directory, 'data', 'collection.v1.sqlite'), { readOnly: true })
  try { for (const request of requests) expect(verified.prepare('SELECT count(*) n FROM prepared_ledger WHERE command_id=?').get(request.commandId)?.n).toBe(1) } finally { verified.close() }
  for (let index = 0; index < requests.length; index++) expect(await readFile(path.join(sourcePath, `合成-${index}.wav`), 'utf8')).toBe('合成保留字节')
})
