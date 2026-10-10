/** 实际完整资料包的离线 Electron 观察；仅接受外置隔离 profile。 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect } from '@playwright/test'
import { waitForMainWindow } from '../e2e/main-window.ts'
import { verifiedElectronExecution } from './electron-identity.mjs'
import { testElectronArguments } from './test-keychain.mjs'

const [profile, importEvidence, restoreEvidence, archivePath, evidence] = process.argv.slice(2)
if (!profile || !importEvidence || !restoreEvidence || !archivePath || !evidence
  || !profile.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-tape-r3-')
  || !/^musicbridge-ui-e2e-tape-r3[A-Za-z0-9._-]*$/u.test(path.basename(profile))
  || !evidence.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-tape-r3-')) throw new Error('应用观察只接受外置任务隔离目录。')
assert.equal(process.versions.node.split('.')[0], '22')
await mkdir(evidence, { recursive: true, mode: 0o700 })
const imported = JSON.parse(await readFile(importEvidence, 'utf8'))
const restored = JSON.parse(await readFile(restoreEvidence, 'utf8'))
const desktop = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const identity = verifiedElectronExecution()
const errors = [], closes = [], networks = [], screenshots = []
const freePort = async () => {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}
async function launch() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) => value !== undefined && !/^(MUSIC_BRIDGE_|NETEASE_|ROON_|BRIDGE_)/u.test(name)))
  Object.assign(env, { MUSIC_BRIDGE_UI_E2E: '1', MUSIC_BRIDGE_UI_E2E_OFFLINE: '1', MUSIC_BRIDGE_CORE_TEST_MODE: '1',
    MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR: profile, BRIDGE_CONTROL_HOST: '127.0.0.1', BRIDGE_CONTROL_PORT: String(await freePort()),
    BRIDGE_STREAM_HOST: '127.0.0.1', BRIDGE_STREAM_PORT: String(await freePort()) })
  const app = await electron.launch({ executablePath: path.join(identity.packageRoot, 'dist/Electron.app/Contents/MacOS/Electron'),
    args: testElectronArguments([path.join(desktop, 'dist/main/index.js')], 'mock'), cwd: desktop, env, timeout: 30_000 })
  app.on('window', page => page.on('pageerror', error => errors.push(error.message)))
  const page = await waitForMainWindow(app)
  page.on('pageerror', error => errors.push(error.message))
  await page.setViewportSize({ width: 1440, height: 1000 })
  assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), profile)
  await expect.poll(() => page.evaluate(async () => (await window.musicBridge.getCoreHealth()).runtime), { timeout: 30_000 }).toBe('ready')
  await expect.poll(() => page.evaluate(async () => (await window.musicBridge.getCommandOutbox()).datasetId)).toBe(restored.restoredDatasetId)
  return { app, page }
}
async function finish(app) {
  networks.push(await app.evaluate(() => globalThis.__musicBridgeUiE2eNetworkEvidence))
  assert.equal(networks.at(-1).installedBeforeWindow, true)
  assert.equal(networks.at(-1).blockedExternalAttempts, 0)
  const child = app.process()
  const exit = new Promise(resolve => child.once('close', (exitCode, signal) => resolve({ exitCode, signal })))
  await app.close(); closes.push(await exit)
  assert.deepEqual(closes.at(-1), { exitCode: 0, signal: null })
}
async function screenshot(page, name) {
  const file = path.join(evidence, name + '.png')
  await page.screenshot({ path: file, fullPage: false }); screenshots.push(file)
}
async function catalogue(page) {
  await page.locator('[data-sidebar-source="collection"]').click()
  await expect(page.getByRole('button', { name: '我的磁带', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: '全部磁带资料', exact: true }).click()
  await expect(page.locator('.catalog-summary')).toContainText('已发布 634 条磁带资料')
}
async function readState(page) {
  return page.evaluate(async input => {
    const revision = await window.musicBridge.getCatalogRevision({ id: input.revisionId })
    const inventory = await window.musicBridge.listCollection({ offset: 0, limit: 24 })
    return { revision, inventory }
  }, { revisionId: imported.revisionId })
}
let active
try {
  active = await launch()
  const { page, app } = active
  await catalogue(page)
  const before = await readState(page)
  assert.equal(before.revision.revision.items.length, 634)
  assert.equal(before.inventory.total, 1)
  assert.equal(before.revision.currentCounts.owned, 0)
  const oldPreview = JSON.parse(await readFile(path.join(path.dirname(restoreEvidence), 'original-default-preview.json'), 'utf8'))
  const rejection = await page.evaluate(async request => {
    try { await window.musicBridge.importCassetteArchive(request); return { rejected: false, message: '' } }
    catch (error) { return { rejected: true, message: error.message } }
  }, { ...oldPreview, commandId: randomUUID(), userConfirmed: true })
  assert.equal(rejection.rejected, true)
  assert.match(rejection.message, /SCOPE|CONFLICT|资料库|工作库/u)
  assert.deepEqual(await readState(page), before)
  const brands = new Set(before.revision.revision.items.map(item => item.brand))
  await expect(page.locator('.brand-grid .catalog-card')).toHaveCount(brands.size)
  await screenshot(page, '01-brands')
  const groups = new Map()
  for (const item of before.revision.revision.items) {
    const key = JSON.stringify([item.brand, item.model, item.series, item.iec])
    const group = groups.get(key) ?? []; group.push(item); groups.set(key, group)
  }
  const versions = [...groups.values()].find(group => group.length > 1 && group.some(item => item.archive?.primaryAssetId))
  assert.ok(versions)
  await page.locator('.brand-grid .catalog-card').filter({ hasText: versions[0].brand }).first().click()
  await expect(page.getByRole('heading', { name: versions[0].brand + ' 型号', exact: true })).toBeVisible()
  await screenshot(page, '02-models')
  const modelCard = page.locator('.catalog-grid .catalog-card').filter({ has: page.locator('strong', { hasText: versions[0].model }) }).filter({ hasText: `IEC ${versions[0].iec}` }).first()
  await modelCard.click()
  await expect(page.locator('[data-catalog-reference]')).toHaveCount(Math.min(48, versions.length))
  await screenshot(page, '03-years-editions')
  await page.locator('[data-catalog-reference]').first().click()
  await expect(page.locator('.cassette-detail')).toBeVisible()
  await expect(page.locator('.transcription')).not.toHaveCount(0)
  await page.getByRole('button', { name: '添加到我的收藏', exact: true }).click()
  const receive = page.getByRole('dialog', { name: '添加到我的收藏', exact: true })
  await expect(receive).toBeVisible()
  await expect(receive.getByLabel('版次 / 包装版本', { exact: true })).toHaveValue('')
  await expect(receive.getByLabel('年份', { exact: true })).toHaveValue('')
  await expect(receive.getByLabel('时长（分钟）', { exact: true })).toHaveValue('')
  await expect(receive.getByRole('combobox', { name: /^版次确认/u })).toHaveValue('unidentified')
  for (const name of ['未开封空白', '已拆空白', '旧录音待登记', '未分类']) await expect(receive.getByLabel(name, { exact: true })).toHaveValue('0')
  await screenshot(page, '04-add-to-my-collection')
  await receive.getByRole('button', { name: '关闭录入', exact: true }).click()
  await page.getByRole('button', { name: '关联已有库存', exact: true }).click()
  const association = page.getByRole('dialog', { name: '参考目录与版次', exact: true })
  await expect(association.getByRole('heading', { name: '3. 审核参考目录与库存的关联', exact: true })).toBeVisible()
  await association.getByRole('button', { name: '关闭', exact: true }).click()
  await association.getByRole('button', { name: '确认关闭', exact: true }).click()
  await expect(association).not.toBeVisible()
  assert.deepEqual(await readState(page), before)
  await page.getByRole('button', { name: '← 返回资料列表', exact: true }).click()
  const input = page.getByPlaceholder('品牌、型号、版次、原书说明…')
  await input.fill('mbref-fuji-range-6-d1450e0cf76a8da27c59150b')
  await expect(page.locator('[data-catalog-reference]')).toHaveCount(1)
  await page.locator('[data-catalog-reference]').click()
  await expect(page.getByRole('heading', { name: 'r3 资料纠正', exact: true })).toBeVisible()
  await screenshot(page, '05-detail')
  const primary = page.locator('.primary-image img')
  await expect.poll(() => primary.evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true)
  await page.getByRole('heading', { name: 'r3 资料纠正', exact: true }).scrollIntoViewIfNeeded()
  await expect(page.locator('.transcription')).not.toHaveCount(0)
  await screenshot(page, '05b-original-text-and-correction')
  await page.getByRole('button', { name: '← 返回资料列表', exact: true }).click()
  const missing = before.revision.revision.items.find(item => item.archive?.primaryAssetId === null)
  await input.fill(missing.referenceId)
  await page.locator('[data-catalog-reference]').click()
  await expect(page.locator('.primary-image figcaption')).not.toHaveText('主图尚缺 · 资料条目保留')
  await screenshot(page, '06-missing-image')
  await page.getByRole('button', { name: '← 返回资料列表', exact: true }).click()
  await page.getByRole('button', { name: '全部品牌', exact: true }).click()
  await app.evaluate(({ dialog }, archivePath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [archivePath] }) }, archivePath)
  await page.getByRole('button', { name: '导入完整资料 ZIP', exact: true }).click()
  const importer = page.getByRole('dialog', { name: '导入完整磁带资料 ZIP', exact: true })
  await importer.getByRole('button', { name: '选择完整 ZIP', exact: true }).click()
  await expect(importer.getByRole('region', { name: '完整资料包预览' })).toBeVisible({ timeout: 60_000 })
  await screenshot(page, '07-import-preview')
  await importer.getByRole('button', { name: '确认导入并发布资料', exact: true }).click()
  await expect(importer.getByRole('region', { name: '完整资料包导入结果' })).toBeVisible({ timeout: 30_000 })
  await importer.getByRole('button', { name: '查看全部磁带资料', exact: true }).click()
  assert.deepEqual(await readState(page), before)
  await screenshot(page, '08-after-repeat-import')
  await finish(app); active = undefined
  active = await launch()
  await catalogue(active.page)
  assert.deepEqual(await readState(active.page), before)
  await screenshot(active.page, '09-cold-restart')
  await finish(active.app); active = undefined
  assert.deepEqual(errors, [])
  const result = { taskId: 'TAPE-CATALOG-R3', node: process.versions.node, electron: identity.version,
    evidenceKind: '实际来源资料、离线隔离 Electron、mock钥匙串；不是真实账号、音频或Owner验收', profile,
    archiveSha256: imported.archive.sha256, referenceCount: 634, brandCount: brands.size,
    threeLevelNavigation: true, directSearch: true, fullTextAndCorrectionVisible: true, originalImageRendered: true,
    missingImageReasonVisible: true, addPrefillsOnlyKnownFieldsAndZeroQuantity: true, existingMatchEntryReachable: true,
    repeatedImportSameRevision: true, inventoryUnchanged: true, restartPersisted: true, oldDatasetPreviewRejectedByApp: rejection,
    closes, networks, pageErrors: errors, screenshots }
  await writeFile(path.join(evidence, 'electron-observation.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  await writeFile(path.join(evidence, 'failed-observation.json'), JSON.stringify({ message: error.message, stack: error.stack, pageErrors: errors, closes, networks, screenshots }, null, 2) + '\n')
  if (active) { await screenshot(active.page, 'failure').catch(() => undefined); await active.app.close().catch(() => undefined) }
  throw error
}
