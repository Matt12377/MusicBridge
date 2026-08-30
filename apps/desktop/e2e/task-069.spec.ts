import { testElectronArguments } from '../scripts/test-keychain.mjs'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SpreadsheetColumnMapping, SpreadsheetImportPlan, SpreadsheetWorkbookSource } from '@music-bridge/contracts'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const axe = await readFile(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8')
// 仅生成临时合成文件；使用 Core 锁定的官方解析器依赖，不读取用户工作簿。
const XLSX = createRequire(path.join(root, '../../packages/bridge-core/package.json'))('xlsx') as {
  utils: { book_new(): Record<string, unknown>; aoa_to_sheet(rows: Array<Array<string | number | null>>): Record<string, unknown>; book_append_sheet(book: Record<string, unknown>, sheet: Record<string, unknown>, name: string): void }
  write(book: Record<string, unknown>, options: Record<string, unknown>): Buffer
}
const sheetName = '合成库存', paging = { offset: 0, limit: 25 }
const columns: SpreadsheetColumnMapping = { brand: 1, model: 2, edition: 3, year: null, iec: null, length: 4, quantity: 5, used: 6, price: 7, purchaseDate: 8, notes: 9 }
const headers = ['品牌', '型号', '版次候选', '时长', '数量', '已使用', '价格', '购入日期', '备注']
const unknownRow = (quantity = 10): Array<string | number | null> => ['', '', '1990候选', 90, quantity, 3, '19.80', 45352, '来源行A']
const knownRow = (name = 'B', quantity = 2): Array<string | number | null> => ['合成牌', name, '1991候选', 60, quantity, null, 8, '2026-08-28', `来源行${name}`]
let app: ElectronApplication | undefined, page: Page, directory: string

async function launch(): Promise<void> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !/^(MUSIC_BRIDGE_|NETEASE_|ROON_)/u.test(key))) as Record<string, string>
  app = await electron.launch({ args: testElectronArguments([path.join(root, 'dist/main/index.js')]), cwd: root, env: { ...env, MUSIC_BRIDGE_UI_E2E: '1', MUSIC_BRIDGE_CORE_TEST_MODE: '1', MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR: directory } })
  page = await app.firstWindow(); await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('#home-heading')).toBeVisible()
  await expect.poll(async () => (await page.evaluate(() => window.musicBridge.getCoreHealth())).runtime).toBe('ready')
}
async function close(): Promise<void> { const current = app; app = undefined; await current?.close().catch(() => undefined) }
test.beforeEach(async () => { test.setTimeout(120_000); directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-ui-e2e-excel-')); await mkdir(test.info().outputDir, { recursive: true }); await writeFile(test.info().outputPath('synthetic-user-data-path.txt'), directory); await launch() })
test.afterEach(close)

async function workbook(name: string, rows: Array<Array<string | number | null>>, format: 'xlsx' | 'xls' = 'xlsx', date1904 = false) {
  const book = XLSX.utils.book_new(), sheet = XLSX.utils.aoa_to_sheet([headers, ...rows])
  if (typeof rows[0]?.[7] === 'number') sheet.H2 = { t: 'n', v: rows[0][7], z: 'yyyy-mm-dd' }
  XLSX.utils.book_append_sheet(book, sheet, sheetName); book.Workbook = { WBProps: { date1904 } }
  const bytes = XLSX.write(book, { type: 'buffer', bookType: format === 'xlsx' ? 'xlsx' : 'biff8', compression: true })
  const absolutePath = path.join(directory, `${name}.${format}`); await writeFile(absolutePath, bytes)
  return { absolutePath, bytes, hash: createHash('sha256').update(bytes).digest('hex') }
}
async function choose(absolutePath: string): Promise<SpreadsheetWorkbookSource> {
  await app!.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }) }, absolutePath)
  const source = await page.evaluate(() => window.musicBridge.chooseSpreadsheetWorkbook({ commandId: crypto.randomUUID() }))
  expect(source).not.toBeNull(); return source!
}
function plan(sourceId: string, overrides: Partial<SpreadsheetImportPlan> = {}): SpreadsheetImportPlan { return { sourceId, sheetName, format: 'cassette', sourceRelationship: 'independent', headerRow: 1, columns, previousRevisionId: null, decisions: [], ...overrides } }
async function apply(input: SpreadsheetImportPlan) {
  const preview = await page.evaluate(input => window.musicBridge.previewSpreadsheetImport(input), { ...input, page: paging })
  const request = { ...input, commandId: randomUUID(), baselineFingerprint: preview.baselineFingerprint, userConfirmed: true as const }
  const result = await page.evaluate(request => window.musicBridge.applySpreadsheetImport(request), request)
  expect(await page.evaluate(request => window.musicBridge.applySpreadsheetImport(request), request)).toEqual(result)
  return { preview, request, result }
}
async function inventoryTotal(): Promise<number> { return (await page.evaluate(() => window.musicBridge.listCollection({ offset: 0, limit: 100 }))).items.reduce((sum, model) => sum + model.counts.total, 0) }

test('V3 Excel：真实XLSX/XLS与11API，重导不增量、修订保留旧Lot且独立更正跨冷启动', async () => {
  const originalFile = await workbook('第一版', [unknownRow(), knownRow()]), original = await choose(originalFile.absolutePath)
  expect(original.workbookHash).toBe(originalFile.hash); expect(original.fileFormat).toBe('xlsx'); expect(original.dateSystem).toBe('1900')
  expect(await page.evaluate(id => window.musicBridge.getSpreadsheetSource({ id }), original.id)).toEqual(original)
  const raw = await page.evaluate(input => window.musicBridge.getSpreadsheetSourceRows(input), { sourceId: original.id, sheetName, page: paging })
  const originalRaw = raw.items.find(row => row.rowIndex === 2)!
  expect(originalRaw.cells.find(cell => cell.columnIndex === 7)).toMatchObject({ type: 'string', value: '19.80' })
  expect(originalRaw.cells.find(cell => cell.columnIndex === 8)).toMatchObject({ type: 'number', value: 45352, numberFormat: 'yyyy-mm-dd' })
  const draft = plan(original.id, { decisions: [{ rowIndex: 2, action: 'new' }, { rowIndex: 3, action: 'new' }] })
  const before = await page.evaluate(input => window.musicBridge.previewSpreadsheetImport(input), { ...draft, page: paging })
  expect(before.summary).toMatchObject({ newQuantity: 12, legacyUsed: 3, unclassified: 9 }); expect(await inventoryTotal()).toBe(0)
  const first = await apply(draft)
  const detail = await page.evaluate(input => window.musicBridge.getSpreadsheetImportRevision(input), { revisionId: first.result.revision.id, page: paging })
  const oldUnknown = detail.rows.items.find(row => row.rowIndex === 2)!
  const model = await page.evaluate(id => window.musicBridge.getCollectionModel(id, { offset: 0, limit: 25 }), oldUnknown.modelId!)
  expect(model.model).toMatchObject({ brand: '', name: '', edition: '', identification: 'unidentified', counts: { total: 10, legacyUsed: 3, unknown: 7, sealedBlank: 0, openedBlank: 0 } }); expect(model.copies.total).toBe(0)
  expect(await choose(originalFile.absolutePath)).toEqual(original)
  const duplicate = await page.evaluate(request => window.musicBridge.applySpreadsheetImport(request), { ...first.request, commandId: randomUUID() })
  expect(duplicate).toMatchObject({ duplicate: true, revision: { id: first.result.revision.id } }); expect(await inventoryTotal()).toBe(12)

  const legacyFile = await workbook('旧格式', [['合成DAT', 'D', '候选', 60, 4, 1, 30, 1, 'BIFF8原行']], 'xls', true), legacy = await choose(legacyFile.absolutePath)
  expect(legacy).toMatchObject({ fileFormat: 'xls', workbookHash: legacyFile.hash, dateSystem: '1904' })
  await apply(plan(legacy.id, { format: 'dat', decisions: [{ rowIndex: 2, action: 'new' }] })); expect(await inventoryTotal()).toBe(16)

  const revisedFile = await workbook('重排修改版', [knownRow(), unknownRow(12), knownRow('C', 1)]), revised = await choose(revisedFile.absolutePath)
  const revision = await apply(plan(revised.id, { sourceRelationship: 'revision', previousRevisionId: first.result.revision.id, decisions: [{ rowIndex: 3, action: 'match', previousRowId: oldUnknown.id }, { rowIndex: 4, action: 'new' }] }))
  expect(revision.preview.summary).toMatchObject({ matchedRows: 1, changedRows: 1, newQuantity: 1 }); expect(await inventoryTotal()).toBe(17)
  const revisedDetail = await page.evaluate(input => window.musicBridge.getSpreadsheetImportRevision(input), { revisionId: revision.result.revision.id, page: paging })
  const changed = revisedDetail.rows.items.find(row => row.rowIndex === 3)!
  expect(changed.lotId).toBe(oldUnknown.lotId); expect(changed.normalized.quantity).toBe(12)
  expect((await page.evaluate(id => window.musicBridge.getCollectionModel(id, { offset: 0, limit: 25 }), oldUnknown.modelId!)).model.counts.total).toBe(10)
  const location = { revisionId: revision.result.revision.id, rowId: changed.id }
  const balance = await page.evaluate(input => window.musicBridge.previewSpreadsheetAdjustment(input), location)
  const adjust = { ...location, commandId: randomUUID(), lotId: changed.lotId!, expectedBalanceFingerprint: balance.balanceFingerprint, legacyUsedDelta: 0, unclassifiedDelta: 2, userConfirmed: true as const }
  const corrected = await page.evaluate(input => window.musicBridge.adjustSpreadsheetInventory(input), adjust)
  expect(corrected.after).toMatchObject({ quantityAcquired: 10, quantityAdjustment: 2, legacyUsed: 3, unclassified: 9, materializedCount: 0 })
  expect(await page.evaluate(input => window.musicBridge.adjustSpreadsheetInventory(input), adjust)).toEqual(corrected)
  expect((await page.evaluate(input => window.musicBridge.listSpreadsheetAdjustments(input), { ...location, page: paging })).items).toEqual([corrected])
  expect((await page.evaluate(() => window.musicBridge.listSpreadsheetSources({ offset: 0, limit: 25 }))).total).toBe(3)
  expect((await page.evaluate(() => window.musicBridge.listSpreadsheetImportHistory({ offset: 0, limit: 25 }))).total).toBe(3)
  expect(await inventoryTotal()).toBe(19)
  const scope = (await page.evaluate(() => window.musicBridge.getCommandOutbox())).datasetId
  await close(); await launch()
  expect((await page.evaluate(() => window.musicBridge.getCommandOutbox())).datasetId).toBe(scope)
  expect(await inventoryTotal()).toBe(19)
  expect(await page.evaluate(input => window.musicBridge.getSpreadsheetImportRevision(input), { revisionId: first.result.revision.id, page: paging })).toEqual(detail)
  expect(await page.evaluate(input => window.musicBridge.previewSpreadsheetAdjustment(input), location)).toEqual(corrected.after)
  expect(await readFile(originalFile.absolutePath)).toEqual(originalFile.bytes)
  await close()
  const db = new DatabaseSync(path.join(directory, 'data', 'collection.v1.sqlite'), { readOnly: true })
  try {
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(21)
    expect(db.prepare('SELECT count(*) n FROM inventory_lots').get()?.n).toBe(4)
    expect(db.prepare('SELECT acquired,quantity_adjustment FROM inventory_lots WHERE id=?').get(changed.lotId!)).toMatchObject({ acquired: 10, quantity_adjustment: 2 })
    expect(db.prepare('SELECT count(*) n FROM physical_copies').get()?.n).toBe(0)
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  } finally { db.close() }
})

test('V3 Excel：原生选择登记回执未知后冷启不重选，原文件离线仍可人工恢复原回执', async () => {
  const selected = await workbook('回执合成来源', [unknownRow()]), commandId = randomUUID()
  await app!.evaluate(({ dialog }, absolutePath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [absolutePath] }) }, selected.absolutePath)
  await app!.evaluate(() => {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite'), prepare = DatabaseSync.prototype.prepare
    DatabaseSync.prototype.prepare = function (sql: string) {
      const statement = prepare.call(this, sql)
      if (sql.startsWith('UPDATE outbox_states SET result_json=')) {
        DatabaseSync.prototype.prepare = prepare
        Object.defineProperty(statement, 'run', { value: () => { throw new Error('合成工作簿登记回执落盘失败') } })
      }
      return statement
    }
  })
  await page.evaluate(commandId => window.musicBridge.chooseSpreadsheetWorkbook({ commandId }), commandId).then(() => { throw new Error('必须观察到选择回执未确认') }, () => undefined)
  const pending = await page.evaluate(() => window.musicBridge.getCommandOutbox())
  expect(pending.entries).toHaveLength(1); expect(pending.entries[0]).toMatchObject({ commandId, command: 'spreadsheetImports.chooseWorkbook', state: 'uncertain' })
  expect(JSON.stringify(pending)).not.toContain(directory); expect(JSON.stringify(pending)).not.toContain('payload')
  expect((await page.evaluate(() => window.musicBridge.listSpreadsheetSources({ offset: 0, limit: 25 }))).total).toBe(1)
  await close(); await rename(selected.absolutePath, selected.absolutePath + '.offline'); await launch()
  await app!.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => { throw new Error('恢复既有回执不得再次打开文件选择器') } })
  expect(await page.evaluate(() => window.musicBridge.getCommandOutbox())).toEqual(pending)
  await page.reload(); await expect(page.locator('#home-heading')).toBeVisible()
  expect(await page.evaluate(() => window.musicBridge.getCommandOutbox())).toEqual(pending)
  const restored = await page.evaluate(id => window.musicBridge.retryCommandOutbox({ id, userConfirmed: true }), pending.entries[0]!.id)
  expect(restored.state).toBe('succeeded')
  const sources = await page.evaluate(() => window.musicBridge.listSpreadsheetSources({ offset: 0, limit: 25 }))
  expect(sources.total).toBe(1); expect(sources.items[0]?.workbookHash).toBe(selected.hash)
  const rows = await page.evaluate(input => window.musicBridge.getSpreadsheetSourceRows(input), { sourceId: sources.items[0]!.id, sheetName, page: paging })
  expect(rows.items.find(row => row.rowIndex === 2)?.cells.find(cell => cell.columnIndex === 5)?.value).toBe(10)
  await page.evaluate(id => window.musicBridge.acknowledgeCommandOutbox({ id }), restored.id)
  expect((await page.evaluate(() => window.musicBridge.getCommandOutbox())).entries).toEqual([])
  expect(await inventoryTotal()).toBe(0)
  expect((await page.evaluate(() => window.musicBridge.getPlaybackState())).state).toBe('idle')
  expect(await readFile(selected.absolutePath + '.offline')).toEqual(selected.bytes)
})

test('V3 Excel：五步界面明确批准，720窄窗原行与独立更正截图及axe', async () => {
  const selected = await workbook('界面合成来源', [unknownRow()])
  await app!.evaluate(({ dialog }, absolutePath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [absolutePath] }) }, selected.absolutePath)
  await page.setViewportSize({ width: 720, height: 800 })
  await page.locator('[data-sidebar-source="collection"]').click()
  await page.getByRole('button', { name: 'Excel 导入', exact: true }).click()
  const panel = page.getByRole('dialog', { name: 'Excel 非破坏导入', exact: true })
  await expect(panel).toBeVisible()
  const capture = async (step: string) => {
    await panel.evaluate(element => { element.scrollTop = 0 })
    await page.evaluate(axe)
    const result = await page.evaluate(async () => (window as typeof window & { axe: { run(root: Element): Promise<{ violations: Array<{ id: string; impact: string | null }> }> } }).axe.run(document.querySelector('dialog[open]')!))
    expect(result.violations.filter(issue => issue.impact === 'critical' || issue.impact === 'serious')).toEqual([])
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await page.screenshot({ path: test.info().outputPath(`excel-${step}-720.png`) })
  }
  await expect(panel.getByRole('heading', { name: '1. 显式选择工作簿', exact: true })).toBeVisible()
  expect(await inventoryTotal()).toBe(0); await capture('1-source')
  await panel.getByRole('button', { name: '选择 Excel 工作簿', exact: true }).click()
  await expect(panel.getByRole('heading', { name: '2. 选择 Sheet、介质与列映射', exact: true })).toBeVisible()
  await expect(panel.getByText(selected.hash, { exact: true })).toBeVisible()
  await expect(panel.getByRole('button', { name: '预览源行与修订差异', exact: true })).toBeDisabled()
  await panel.getByRole('combobox', { name: '工作表 Sheet', exact: true }).selectOption(sheetName)
  await panel.getByRole('combobox', { name: '介质类别（必须明确选择）', exact: true }).selectOption('cassette')
  await panel.getByLabel('表头行号（0 表示无表头）', { exact: true }).fill('1')
  await panel.getByLabel('表头行号（0 表示无表头）', { exact: true }).press('Tab')
  for (const [label, column] of [['品牌', 1], ['型号', 2], ['版次候选', 3], ['时长（分钟）', 4], ['总数量', 5], ['Used 数量', 6], ['价格原值', 7], ['购买日期原值', 8], ['备注', 9]] as const) {
    await panel.getByRole('combobox', { name: `${label}对应列`, exact: true }).selectOption(String(column))
  }
  await expect(panel.getByRole('button', { name: '预览源行与修订差异', exact: true })).toBeDisabled()
  await expect(panel.getByRole('combobox', { name: '来源关系（必须明确声明）', exact: true })).toHaveValue('')
  await panel.getByRole('combobox', { name: '来源关系（必须明确声明）', exact: true }).selectOption('revision')
  await expect(panel.getByRole('button', { name: '预览源行与修订差异', exact: true })).toBeDisabled()
  await panel.getByRole('combobox', { name: '来源关系（必须明确声明）', exact: true }).selectOption('independent')
  await panel.getByRole('button', { name: '读取原始行以核对列', exact: true }).click()
  await expect(panel.getByRole('table')).toBeVisible()
  expect(await inventoryTotal()).toBe(0); await capture('2-mapping')
  await panel.getByRole('table').scrollIntoViewIfNeeded()
  await page.screenshot({ path: test.info().outputPath('excel-2-raw-rows-720.png') })
  await panel.getByRole('button', { name: '预览源行与修订差异', exact: true }).click()
  await expect(panel.getByRole('heading', { name: '3. 核对原行与对应关系', exact: true })).toBeVisible()
  await expect(panel.locator('.review-rows > li')).toHaveCount(1)
  const row = panel.locator('.review-rows > li').filter({ has: page.getByRole('heading', { name: /^原行 2/u }) })
  await expect(row).toHaveCount(1)
  await row.getByRole('combobox', { name: '原行 2 处理方式', exact: true }).selectOption('new')
  await row.getByRole('button', { name: '保存本行决定', exact: true }).click()
  await expect(panel.getByRole('button', { name: '前往批准导入', exact: true })).toBeDisabled()
  await panel.getByRole('button', { name: '按当前决定重新预览', exact: true }).click()
  await expect(panel.getByRole('button', { name: '前往批准导入', exact: true })).toBeEnabled()
  expect(await inventoryTotal()).toBe(0); await capture('3-review')
  await row.scrollIntoViewIfNeeded()
  await page.screenshot({ path: test.info().outputPath('excel-3-row-decision-720.png') })
  await panel.getByRole('button', { name: '前往批准导入', exact: true }).click()
  await expect(panel.getByRole('heading', { name: '4. 独立批准本次导入', exact: true })).toBeVisible()
  await expect(panel.getByRole('button', { name: '批准本次导入', exact: true })).toBeDisabled()
  expect(await inventoryTotal()).toBe(0); await capture('4-approval')
  await panel.getByLabel('我已核对整批源行、Unknown 与对应关系，批准仅明确新增的有效行入库', { exact: true }).check()
  await panel.getByRole('button', { name: '批准本次导入', exact: true }).click()
  await expect(panel.getByRole('heading', { name: '5. 只读历史与独立数量更正', exact: true })).toBeVisible()
  await expect.poll(inventoryTotal).toBe(10)
  await panel.getByRole('button', { name: '查看本次持久结果', exact: true }).click()
  await panel.getByRole('button', { name: '核对本行批次余额', exact: true }).click()
  await expect(panel.getByRole('button', { name: '确认独立数量更正', exact: true })).toBeDisabled()
  await panel.getByRole('spinbutton', { name: /^Unclassified 增减量/u }).fill('2')
  await capture('5-history-adjustment')
  await panel.getByLabel('我已核对原行、实际批次与前后余额，确认只记录上述增减量，不重置原库存', { exact: true }).check()
  await panel.getByRole('button', { name: '确认独立数量更正', exact: true }).click()
  await expect(panel.getByText('数量更正已保存为独立账本记录。原始入库量与历史保持不变；再次更正前须重新读取余额。', { exact: true })).toBeVisible()
  await expect.poll(inventoryTotal).toBe(12)
  await panel.getByRole('button', { name: '读取更正历史', exact: true }).click()
  await expect(panel.getByText('原始入库量 10 → 10（保持原始事实）', { exact: true })).toBeVisible()
  await capture('5-history-result')
  await panel.getByText('原始入库量 10 → 10（保持原始事实）', { exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: test.info().outputPath('excel-5-adjustment-ledger-720.png') })
  expect(await readFile(selected.absolutePath)).toEqual(selected.bytes)
})
