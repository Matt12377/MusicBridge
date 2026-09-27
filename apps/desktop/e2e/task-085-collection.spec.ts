import { testElectronArguments } from '../scripts/test-keychain.mjs'
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CanonicalReference, SourcePack } from '@music-bridge/contracts'

const desktopRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const fromCore = createRequire(path.join(desktopRoot, '../../packages/bridge-core/package.json'))
const XLSX = fromCore('xlsx') as {
  utils: { book_new(): Record<string, unknown>; aoa_to_sheet(rows: Array<Array<string | number | null>>): Record<string, unknown>; book_append_sheet(book: Record<string, unknown>, sheet: Record<string, unknown>, name: string): void }
  write(book: Record<string, unknown>, options: Record<string, unknown>): Buffer
}
const yazl = fromCore('yazl') as {
  ZipFile: new () => { addBuffer(bytes: Buffer, name: string, options: { compress: boolean }): void; end(options: { comment: string }): void; outputStream: AsyncIterable<Buffer> }
}
const sheetName = '合成库存'
const bookId = 'task085-synthetic-book'
const sourceItems: CanonicalReference[] = ['a', 'b', 'c', 'd'].map((referenceId, index) => ({
  referenceId, bookId, brand: '合成牌', series: '合成系列', edition: '测试版', model: referenceId.toUpperCase(),
  lengths: index < 2 ? [60, 90] : [60], iec: 'II', era: '1990', image: { kind: 'none' },
  pages: [String(index + 1)], notes: '仅隔离合成回归使用', confidence: 'high',
}))
const sourcePack: SourcePack = { schemaVersion: 1, bookId, title: 'TASK-085 合成参考书', sourceVersion: '第一版', items: sourceItems }
const workbookHeaders = ['品牌', '型号', '版次候选', '时长', '数量', '已使用', '价格', '购入日期', '备注']
const originalRows: Array<Array<string | number | null>> = [
  ['', '', '待核候选', 90, 10, 3, '19.80', 45352, 'Unknown 原行'],
  ['合成牌', 'A', '测试版候选', 60, 2, null, 8, '2026-08-28', '型号 A 原行'],
  ['合成牌', 'B', '测试版候选', 90, 1, null, 9, '2026-08-28', '型号 B 原行'],
]
const columns = [['品牌', 1], ['型号', 2], ['版次候选', 3], ['时长（分钟）', 4], ['总数量', 5], ['Used 数量', 6], ['价格原值', 7], ['购买日期原值', 8], ['备注', 9]] as const
let app: ElectronApplication | undefined
let page: Page
let userDataDirectory: string

function externalTmp(): string {
  const value = process.env.TMPDIR ?? ''
  if (path.resolve(value) !== '/Volumes/LifeWeave/Developer/CommandLine/tmp') throw new Error('TASK-085 E2E 必须显式使用外置 LifeWeave TMPDIR')
  return value
}
async function launch(): Promise<void> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !/^(MUSIC_BRIDGE_|NETEASE_|ROON_)/u.test(key))) as Record<string, string>
  app = await electron.launch({ args: testElectronArguments([path.join(desktopRoot, 'dist/main/index.js')]), cwd: desktopRoot, timeout: 30_000,
    env: { ...env, MUSIC_BRIDGE_UI_E2E: '1', MUSIC_BRIDGE_UI_E2E_OFFLINE: '1', MUSIC_BRIDGE_CORE_TEST_MODE: '1', MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR: userDataDirectory } })
  const startupOutput: string[] = []
  for (const stream of [app.process().stdout, app.process().stderr]) stream?.on('data', chunk => startupOutput.push(String(chunk)))
  try { page = await app.firstWindow() }
  catch (error) { throw new Error(`Electron 窗口未打开：${String(error)}\n${startupOutput.join('').slice(-4000)}`) }
  page.setDefaultTimeout(15_000)
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('#home-heading')).toBeVisible()
  await expect.poll(async () => (await page.evaluate(() => window.musicBridge.getCoreHealth())).runtime).toBe('ready')
}
async function close(): Promise<void> { const current = app; app = undefined; await current?.close().catch(() => undefined) }
async function inventoryTotal(): Promise<number> {
  return (await page.evaluate(() => window.musicBridge.listCollection({ offset: 0, limit: 100 }))).items.reduce((sum, model) => sum + model.counts.total, 0)
}
async function physicalEvidence(physicalId: string) {
  const copy = await page.evaluate(id => window.musicBridge.getCollectionCopy(id), physicalId)
  const db = new DatabaseSync(path.join(userDataDirectory, 'data', 'collection.v1.sqlite'), { readOnly: true })
  try {
    const ledger = db.prepare("SELECT command_id,fingerprint,action,result,event_data,created_at FROM inventory_ledger WHERE json_extract(result,'$.physicalId')=? ORDER BY rowid").all(physicalId)
    return { copy, ledger }
  } finally { db.close() }
}
async function networkEvidence() {
  const evidence = await app!.evaluate(() => (globalThis as typeof globalThis & {
    __musicBridgeUiE2eNetworkEvidence?: { installedBeforeWindow: boolean; localCoverResponses: number; localAvatarResponses: number; blockedExternalAttempts: number; blockedHosts: string[] }
  }).__musicBridgeUiE2eNetworkEvidence)
  expect(evidence).toMatchObject({ installedBeforeWindow: true, blockedExternalAttempts: 0, blockedHosts: [] })
  return evidence!
}
async function buttonEvidence() {
  return page.evaluate(() => {
    const primary = document.querySelector<HTMLButtonElement>('.collection-add')!
    const secondary = document.querySelector<HTMLButtonElement>('.reference-entry')!
    const primaryStyle = getComputedStyle(primary), secondaryStyle = getComputedStyle(secondary)
    return { theme: document.documentElement.dataset.theme, primary: { background: primaryStyle.backgroundColor, color: primaryStyle.color, height: primary.getBoundingClientRect().height },
      secondary: { background: secondaryStyle.backgroundColor, color: secondaryStyle.color } }
  })
}
function contrast(foreground: string, background: string): number {
  const luminance = (color: string) => {
    const values = (color.match(/[\d.]+/gu) ?? []).slice(0, 3).map(Number)
    expect(values).toHaveLength(3)
    const channels = values.map(value => { const c = value / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4 })
    return channels[0]! * .2126 + channels[1]! * .7152 + channels[2]! * .0722
  }
  const a = luminance(foreground), b = luminance(background)
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
}
async function bundleIdentity() {
  const assets = await readdir(path.join(desktopRoot, 'dist/renderer/assets'))
  const renderer = assets.filter(name => /^index-.*\.js$/u.test(name))
  expect(renderer).toHaveLength(1)
  const files = { main: 'dist/main/index.js', core: 'dist/main/core.js', preload: 'dist/preload/index.cjs', renderer: `dist/renderer/assets/${renderer[0]}` }
  return Object.fromEntries(await Promise.all(Object.entries(files).map(async ([part, file]) =>
    [part, createHash('sha256').update(await readFile(path.join(desktopRoot, file))).digest('hex')])))
}
async function workbook(name: string, rows: Array<Array<string | number | null>>): Promise<string> {
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([workbookHeaders, ...rows]), sheetName)
  const target = path.join(userDataDirectory, `${name}.xlsx`)
  await writeFile(target, XLSX.write(book, { type: 'buffer', bookType: 'xlsx', compression: true }))
  return target
}
async function zipPack(): Promise<{ bytes: Buffer; sha256: string }> {
  const zip = new yazl.ZipFile()
  zip.addBuffer(Buffer.from(JSON.stringify(sourcePack), 'utf8'), 'catalog.json', { compress: false })
  zip.end({ comment: '' })
  const chunks: Buffer[] = []
  for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk))
  const bytes = Buffer.concat(chunks)
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
}
async function openCollection(): Promise<void> {
  await page.locator('[data-sidebar-source="collection"]').click()
  await expect(page.locator('.collection-view')).toBeVisible()
}
async function chooseWorkbook(panel: Locator, selected: string): Promise<void> {
  await app!.evaluate(({ dialog }, filePath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] }) }, selected)
  await panel.getByRole('navigation', { name: '库存表导入步骤' }).getByRole('button', { name: '选择来源' }).click()
  await panel.getByRole('button', { name: '选择库存表', exact: true }).click()
  await expect(panel.getByRole('heading', { name: '2. 选择 Sheet、介质与列映射' })).toBeVisible()
}
async function mapWorkbook(panel: Locator, relationship: 'independent' | 'revision', previousRevisionId?: string): Promise<void> {
  await panel.getByRole('combobox', { name: '工作表 Sheet' }).selectOption(sheetName)
  await panel.getByRole('combobox', { name: '介质类别（必须明确选择）' }).selectOption('cassette')
  await panel.getByLabel('表头行号（0 表示无表头）').fill('1')
  await panel.getByLabel('表头行号（0 表示无表头）').press('Tab')
  await panel.getByRole('combobox', { name: '来源关系（必须明确声明）' }).selectOption(relationship)
  if (relationship === 'revision') {
    await panel.getByRole('button', { name: '刷新可承接修订' }).click()
    await panel.getByRole('combobox', { name: '承接旧导入修订' }).selectOption(previousRevisionId!)
  }
  for (const [label, column] of columns) await panel.getByRole('combobox', { name: `${label}对应列` }).selectOption(String(column))
}
async function approveImport(panel: Locator, expectedNew: number): Promise<void> {
  await panel.getByRole('button', { name: '前往批准导入' }).click()
  await expect(panel.getByRole('heading', { name: '4. 独立批准本次导入' })).toBeVisible()
  await expect(panel.getByText(`明确新增数量 ${expectedNew}`, { exact: false })).toBeVisible()
  await panel.getByLabel('我已核对整批源行、Unknown 与对应关系，批准仅明确新增的有效行入库').check()
  await panel.getByRole('button', { name: '批准本次导入' }).click()
  await expect(panel.getByRole('heading', { name: '5. 只读历史与独立数量更正' })).toBeVisible()
}
async function closeDialog(panel: Locator): Promise<void> {
  await panel.getByRole('button', { name: '关闭', exact: true }).click()
  const confirm = panel.getByRole('button', { name: '确认关闭' })
  if (await confirm.isVisible()) await confirm.click()
  await expect(panel).not.toBeVisible()
}
async function selectReferenceSource(panel: Locator): Promise<void> {
  await panel.getByRole('navigation', { name: '参考目录步骤' }).getByRole('button', { name: '资料来源' }).click()
  await panel.getByRole('button', { name: '刷新来源' }).click()
  await panel.getByRole('button', { name: '整理此来源' }).first().click()
  await expect(panel.getByRole('heading', { name: '2. 整理并发布目录' })).toBeVisible()
}
async function publishDraft(panel: Locator, items: readonly CanonicalReference[], mappings: readonly { fromReferenceIds: string[]; toReferenceIds: string[] }[], expected: string): Promise<void> {
  await panel.getByRole('button', { name: '重新读取来源与当前基线' }).click()
  const advanced = panel.locator('details').filter({ has: page.locator('summary', { hasText: '高级修订草案 JSON' }) })
  if (await advanced.getAttribute('open') === null) await advanced.locator('summary').click()
  await panel.getByLabel('items 与 mappings').fill(JSON.stringify({ items, mappings }))
  await panel.getByRole('button', { name: '校验并应用到草案' }).click()
  await panel.getByRole('button', { name: '预览发布影响' }).click()
  await expect(panel.getByRole('heading', { name: '本次发布预览' })).toBeVisible()
  await expect(panel.getByText(expected, { exact: false })).toBeVisible()
  await panel.getByLabel('我已核对映射和影响，确认发布不可变目录修订；库存不增加').check()
  await panel.getByRole('button', { name: '确认发布目录' }).click()
  await expect(panel.getByRole('heading', { name: '3. 审核参考目录与库存的关联' })).toBeVisible()
}
async function reviewMatch(panel: Locator, referenceId: string, outcome: 'confirmed' | 'missing', model?: string): Promise<void> {
  const form = panel.locator('section[aria-labelledby="reference-review-title"] form')
  await form.getByRole('combobox', { name: '参考条目' }).selectOption(referenceId)
  await form.getByRole('combobox', { name: '审核结论' }).selectOption(outcome === 'confirmed' ? 'confirmed' : 'unmatched')
  if (outcome === 'confirmed') {
    await form.getByRole('textbox', { name: '查找已有收藏型号' }).fill(model!)
    await form.getByRole('button', { name: '搜索库存型号' }).click()
    const select = form.getByRole('combobox', { name: '已有收藏型号' })
    const option = select.locator('option').filter({ hasText: `合成牌 ${model}` }).first()
    await expect(option).toBeAttached()
    await select.selectOption(await option.getAttribute('value') ?? '')
  } else await form.getByRole('combobox', { name: '拥有事实' }).selectOption('missing')
  await form.getByLabel('我已核对条目与实际收藏，确认替换该条目的关联审核；不改变库存账本').check()
  await form.getByRole('button', { name: '保存关联审核' }).click()
  await expect(panel.getByText('关联审核已保存；库存账本未改变。')).toBeVisible()
}
async function selectProgressCatalog(panel: Locator, revisionIndex: number): Promise<void> {
  await panel.getByRole('combobox', { name: '参考书籍' }).selectOption(bookId)
  await panel.getByRole('combobox', { name: '目录修订' }).selectOption({ index: revisionIndex })
  await expect(panel.getByRole('heading', { name: '型号与版次完成度' })).toBeVisible()
}
async function expectOverall(panel: Locator, total: number, owned: number, missing: number, unknown: number, wanted: number): Promise<void> {
  const cells = panel.getByRole('table', { name: '当前事实统计' }).getByRole('row', { name: /整本目录/u }).getByRole('cell')
  await expect(cells.nth(0)).toHaveText(String(total))
  await expect(cells.nth(1)).toHaveText(String(owned))
  await expect(cells.nth(2)).toHaveText(String(missing))
  await expect(cells.nth(3)).toHaveText(String(unknown))
  await expect(cells.nth(4)).toContainText(`${wanted} 型号`)
}

test('TASK-085 J03/J04/C11：库存表原行到目录合并拆分、求购快照与同库冷启', async () => {
  test.setTimeout(360_000)
  userDataDirectory = await mkdtemp(path.join(externalTmp(), 'musicbridge-ui-e2e-collection-'))
  await mkdir(test.info().outputDir, { recursive: true })
  await writeFile(test.info().outputPath('synthetic-user-data-path.txt'), userDataDirectory)
  const bundle = await bundleIdentity()
  await writeFile(test.info().outputPath('bundle-identity.json'), `${JSON.stringify(bundle, null, 2)}\n`)
  const original = await workbook('第一版', originalRows)
  const originalBytes = await readFile(original)
  const revised = await workbook('重排修改版', [originalRows[1]!, [...originalRows[0]!.slice(0, 4), 12, ...originalRows[0]!.slice(5)], originalRows[2]!])
  const zip = await zipPack()
  await launch()
  try {
    await page.setViewportSize({ width: 1440, height: 900 })
    await openCollection()
    await expect(page.locator('.collection-add')).toBeEnabled()
    const lightButton = await buttonEvidence()
    expect(lightButton.theme).toBe('light')
    expect(lightButton.primary.background).not.toBe(lightButton.secondary.background)
    expect(lightButton.primary.height).toBeGreaterThanOrEqual(44)
    expect(contrast(lightButton.primary.color, lightButton.primary.background)).toBeGreaterThanOrEqual(4.5)
    await page.screenshot({ path: test.info().outputPath('collection-action-light-1440.png'), scale: 'css' })
    await page.getByRole('button', { name: '打开设置', exact: true }).click()
    await page.getByRole('tab', { name: '应用', exact: true }).click()
    await page.getByRole('radio', { name: /深色/u }).check()
    await openCollection()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('appearance-changing'))).toBe(false)
    const darkButton = await buttonEvidence()
    expect(darkButton.primary.background).not.toBe(darkButton.secondary.background)
    expect(darkButton.primary.height).toBeGreaterThanOrEqual(44)
    expect(contrast(darkButton.primary.color, darkButton.primary.background)).toBeGreaterThanOrEqual(4.5)
    await page.screenshot({ path: test.info().outputPath('collection-action-dark-1440.png'), scale: 'css' })
    await writeFile(test.info().outputPath('collection-theme-button-evidence.json'), `${JSON.stringify({ bundle, lightButton, darkButton,
      lightContrast: contrast(lightButton.primary.color, lightButton.primary.background), darkContrast: contrast(darkButton.primary.color, darkButton.primary.background) }, null, 2)}\n`)
    await page.getByRole('button', { name: '打开设置', exact: true }).click()
    await page.getByRole('tab', { name: '应用', exact: true }).click()
    await page.getByRole('radio', { name: /浅色/u }).check()
    await openCollection()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.getByRole('button', { name: '库存表导入', exact: true }).click()
    const excel = page.getByRole('dialog', { name: '库存表非破坏导入' })
    await chooseWorkbook(excel, original)
    await mapWorkbook(excel, 'independent')
    await excel.getByRole('button', { name: '读取原始行以核对列' }).click()
    await expect(excel.locator('.raw-data table')).toContainText('Unknown 原行')
    await excel.getByRole('button', { name: '预览源行与修订差异' }).click()
    await expect(excel.getByRole('heading', { name: '3. 核对原行与对应关系' })).toBeVisible()
    await expect(excel.getByText('资料缺失，保留待确认').first()).toBeVisible()
    await excel.getByRole('button', { name: '本页有效新行标为新增' }).click()
    await excel.getByRole('button', { name: '按当前决定重新预览' }).click()
    await approveImport(excel, 13)
    await expect.poll(inventoryTotal).toBe(13)
    await excel.getByRole('button', { name: '查看本次持久结果' }).click()
    await expect(excel.getByText('原 Quantity 10 · 原 Used 3')).toBeVisible()
    const firstRevisionId = (await page.evaluate(() => window.musicBridge.listSpreadsheetImportHistory({ offset: 0, limit: 25 }))).items[0]!.id

    // 从导入的 Used 池通过正式收藏页登记一盘，再冻结永久身份与库存流水读证据。
    await closeDialog(excel)
    const unknownCard = page.locator('.inventory-card').filter({ hasText: '品牌待确认 · 型号待确认' })
    await expect(unknownCard).toHaveCount(1)
    await unknownCard.click()
    const modelDetail = page.locator('.model-detail')
    await modelDetail.getByRole('button', { name: '登记旧录音' }).click()
    const physicalId = (await modelDetail.locator('article.copy strong').first().textContent())?.trim() ?? ''
    expect(physicalId).toMatch(/^MB-C-\d{5,9}$/u)
    const baselinePhysical = await physicalEvidence(physicalId)
    expect(baselinePhysical.copy.copy).toMatchObject({ physicalId, origin: 'legacy-registration', usage: 'recorded' })
    expect(baselinePhysical.ledger).toHaveLength(1)
    const physicalStages = [{ stage: '首次导入后经 UI 登记 Used 单盘', evidence: baselinePhysical }]
    await modelDetail.getByRole('button', { name: '← 返回收藏' }).click()
    await page.getByRole('button', { name: '库存表导入', exact: true }).click()

    // 同一原文件再次经正式页面确认，不允许因新命令增加库存。
    await chooseWorkbook(excel, original)
    await mapWorkbook(excel, 'independent')
    await excel.getByRole('button', { name: '预览源行与修订差异' }).click()
    await excel.getByRole('button', { name: '本页有效新行标为新增' }).click()
    await excel.getByRole('button', { name: '按当前决定重新预览' }).click()
    await approveImport(excel, 13)
    await expect(excel.getByText('原文件已导入，本次 0 增量')).toBeVisible()
    await expect.poll(inventoryTotal).toBe(13)

    // 修改版明确承接旧修订，变化行只保留建议；真正数量变动走独立更正。
    await chooseWorkbook(excel, revised)
    await mapWorkbook(excel, 'revision', firstRevisionId)
    await excel.getByRole('button', { name: '预览源行与修订差异' }).click()
    await excel.getByRole('button', { name: '读取旧行供人工对应' }).click()
    const changed = excel.locator('.review-rows > li').filter({ has: page.getByRole('heading', { name: /^原行 3/u }) })
    await expect(changed).toHaveCount(1)
    await changed.getByRole('combobox', { name: '原行 3 处理方式' }).selectOption('match')
    await changed.getByRole('combobox', { name: '原行 3 对应的旧源行' }).selectOption({ index: 1 })
    await changed.getByRole('button', { name: '保存本行决定' }).click()
    await excel.getByRole('button', { name: '按当前决定重新预览' }).click()
    await approveImport(excel, 0)
    await expect.poll(inventoryTotal).toBe(13)
    await excel.getByRole('button', { name: '刷新导入历史' }).click()
    const oldRevision = excel.locator('.records > li').filter({ hasText: '修订 1' }).first()
    await oldRevision.getByRole('button', { name: '查看修订与源行' }).click()
    const oldRow = excel.locator('section.summary .records > li').filter({ hasText: '原行 2' }).first()
    await oldRow.getByRole('button', { name: '核对本行批次余额' }).click()
    await excel.getByRole('spinbutton', { name: /^Unclassified 增减量/u }).fill('2')
    await excel.getByLabel('我已核对原行、实际批次与前后余额，确认只记录上述增减量，不重置原库存').check()
    await excel.getByRole('button', { name: '确认独立数量更正' }).click()
    await excel.getByRole('button', { name: '读取更正历史' }).click()
    await expect(excel.getByText('原始入库量 10 → 10（保持原始事实）')).toBeVisible()
    await expect.poll(inventoryTotal).toBe(15)
    const afterCorrection = await physicalEvidence(physicalId)
    expect(afterCorrection).toEqual(baselinePhysical)
    physicalStages.push({ stage: '独立数量更正后', evidence: afterCorrection })
    await closeDialog(excel)

    await page.getByRole('button', { name: '参考目录与版次', exact: true }).click()
    let reference = page.getByRole('dialog', { name: '参考目录与版次' })
    await reference.getByLabel('选择 ZIP 文件').setInputFiles({ name: 'task085-catalog.zip', mimeType: 'application/zip', buffer: zip.bytes })
    await reference.getByRole('button', { name: '严格预览 ZIP' }).click()
    await expect(reference.getByText(zip.sha256, { exact: true })).toBeVisible()
    await expect.poll(inventoryTotal).toBe(15)
    await reference.getByLabel('我已核对 ZIP 与原 JSON 身份，确认登记；不发布目录、不创建库存，原 ZIP 不长期归档').check()
    await reference.getByRole('button', { name: '登记 ZIP 资料版本' }).click()
    await expect(reference.getByText('原 ZIP 不长期归档。', { exact: false })).toBeVisible()
    await expect(reference.getByRole('heading', { name: '当前来源的 ZIP 容器回执' })).toBeVisible()
    await expect(reference.getByText(zip.sha256, { exact: true })).toBeVisible()
    await selectReferenceSource(reference)
    await publishDraft(reference, sourceItems, [], '合并 0 · 拆分 0')
    await reviewMatch(reference, 'a', 'confirmed', 'A')
    await reviewMatch(reference, 'b', 'confirmed', 'B')
    await reviewMatch(reference, 'c', 'missing')
    await expect(reference.locator('section[aria-labelledby="reference-review-title"] dl.counts')).toContainText('2')
    await closeDialog(reference)

    await page.getByRole('button', { name: '完成度与求购', exact: true }).click()
    let progress = page.getByRole('dialog', { name: '完成度与求购' })
    await selectProgressCatalog(progress, 1)
    await expectOverall(progress, 4, 2, 1, 1, 0)
    await progress.getByRole('button', { name: '新建求购目标' }).first().click()
    await progress.getByRole('combobox', { name: '目标参考项' }).selectOption('a')
    await progress.getByRole('combobox', { name: '优先级' }).selectOption('high')
    await progress.getByRole('textbox', { name: '目标长度（分钟，可留空）' }).fill('90')
    await progress.getByRole('textbox', { name: '偏好包装' }).fill('未拆封')
    await progress.getByRole('textbox', { name: '价格币种（可选，三位大写）' }).fill('CNY')
    await progress.getByRole('textbox', { name: '精确价格金额（可选）' }).fill('12.3400')
    await progress.getByLabel('我已核对目标目录与参考项，确认仅保存求购，不更改库存').check()
    await progress.getByRole('button', { name: '保存求购目标' }).click()
    await expect(progress.getByText('求购目标已保存，库存未改变。请刷新求购清单与当前完成度。')).toBeVisible()
    await progress.getByRole('navigation', { name: '完成度与求购内容' }).getByRole('button', { name: '完成度' }).click()
    await progress.getByRole('button', { name: '刷新当前完成度' }).click()
    await expectOverall(progress, 4, 2, 1, 1, 1)
    await progress.getByLabel('我已核对当前目录与整批事实，确认采集完成度快照').check()
    await progress.getByRole('button', { name: '采集完成度快照' }).click()
    await expect(progress.getByRole('heading', { name: '历史记录' })).toBeVisible()
    await closeDialog(progress)

    await page.getByRole('button', { name: '参考目录与版次', exact: true }).click()
    await selectReferenceSource(reference)
    const merged = { ...sourceItems[0]!, referenceId: 'merged', model: '合并型号' }
    const mergeItems = [merged, sourceItems[2]!, sourceItems[3]!]
    await publishDraft(reference, mergeItems, [
      { fromReferenceIds: ['a', 'b'], toReferenceIds: ['merged'] },
      { fromReferenceIds: ['c'], toReferenceIds: ['c'] },
      { fromReferenceIds: ['d'], toReferenceIds: ['d'] },
    ], '合并 1 · 拆分 0')
    await expect(reference.locator('section[aria-labelledby="reference-review-title"]')).toContainText('merged')
    await selectReferenceSource(reference)
    const splitItems = [
      { ...merged, referenceId: 'left', model: '拆分左' },
      { ...merged, referenceId: 'right', model: '拆分右' },
      sourceItems[2]!, sourceItems[3]!,
    ]
    await publishDraft(reference, splitItems, [
      { fromReferenceIds: ['merged'], toReferenceIds: ['left', 'right'] },
      { fromReferenceIds: ['c'], toReferenceIds: ['c'] },
      { fromReferenceIds: ['d'], toReferenceIds: ['d'] },
    ], '合并 0 · 拆分 1')
    await expect(reference.locator('section[aria-labelledby="reference-review-title"]')).toContainText('待复核')
    await closeDialog(reference)

    await page.getByRole('button', { name: '完成度与求购', exact: true }).click()
    await selectProgressCatalog(progress, 1)
    await expectOverall(progress, 4, 0, 1, 3, 0)
    await expect(progress.getByText('旧目录求购目标 1 条')).toBeVisible()
    await progress.getByRole('navigation', { name: '完成度与求购内容' }).getByRole('button', { name: '历史' }).click()
    await progress.getByRole('button', { name: '读取完成度快照历史' }).click()
    await expect(progress.getByRole('button', { name: '读取此完成度快照' })).toHaveCount(1)
    await progress.getByRole('button', { name: '读取此完成度快照' }).click()
    const historical = progress.getByRole('table', { name: '历史时点统计' }).getByRole('row', { name: /整本目录/u })
    await expect(historical).toContainText('2')
    await expect(historical).toContainText('1 型号 / 1 目标')
    await closeDialog(progress)

    const afterCatalog = await physicalEvidence(physicalId)
    expect(afterCatalog).toEqual(baselinePhysical)
    physicalStages.push({ stage: '目录合并拆分与快照后', evidence: afterCatalog })

    await page.setViewportSize({ width: 720, height: 800 })
    await page.screenshot({ path: test.info().outputPath('collection-before-cold-reopen-720.png'), scale: 'css' })
    const firstNetwork = await networkEvidence()
    await close()
    await launch()
    await page.setViewportSize({ width: 720, height: 800 })
    await openCollection()
    await expect.poll(inventoryTotal).toBe(15)
    await page.getByRole('button', { name: '完成度与求购', exact: true }).click()
    progress = page.getByRole('dialog', { name: '完成度与求购' })
    await selectProgressCatalog(progress, 1)
    await expectOverall(progress, 4, 0, 1, 3, 0)
    await progress.getByRole('navigation', { name: '完成度与求购内容' }).getByRole('button', { name: '历史' }).click()
    await progress.getByRole('button', { name: '读取完成度快照历史' }).click()
    await progress.getByRole('button', { name: '读取此完成度快照' }).click()
    const restoredHistorical = progress.getByRole('table', { name: '历史时点统计' }).getByRole('row', { name: /整本目录/u })
    await expect(restoredHistorical).toContainText('2')
    await expect(restoredHistorical).toContainText('1 型号 / 1 目标')
    await progress.getByRole('navigation', { name: '完成度与求购内容' }).getByRole('button', { name: '求购清单' }).click()
    await expect(progress.getByText('旧目录目标待复核：保留原目标与历史，不自动迁移、合并或拆分复制。')).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('collection-cold-reopen-720.png'), scale: 'css' })
    await closeDialog(progress)
    await page.getByRole('button', { name: '参考目录与版次', exact: true }).click()
    reference = page.getByRole('dialog', { name: '参考目录与版次' })
    await selectReferenceSource(reference)
    await reference.getByRole('navigation', { name: '参考目录步骤' }).getByRole('button', { name: '资料来源' }).click()
    await expect(reference.getByText(zip.sha256, { exact: true })).toBeVisible()
    await reference.getByRole('navigation', { name: '参考目录步骤' }).getByRole('button', { name: '历史快照' }).click()
    await reference.getByRole('button', { name: '读取历史' }).click()
    await expect(reference.getByRole('button', { name: '查看版次' })).toHaveCount(3)
    await closeDialog(reference)
    const afterReopen = await physicalEvidence(physicalId)
    expect(afterReopen).toEqual(baselinePhysical)
    physicalStages.push({ stage: '同库冷启后', evidence: afterReopen })
    await writeFile(test.info().outputPath('physical-id-history-evidence.json'), `${JSON.stringify({ physicalId, physicalStages }, null, 2)}\n`)
    const secondNetwork = await networkEvidence()
    await writeFile(test.info().outputPath('offline-network-evidence.json'), `${JSON.stringify({ scope: 'Electron defaultSession HTTP(S) 建窗前拦截；不推定 Core 或系统网络的全局零流量', firstNetwork, secondNetwork }, null, 2)}\n`)
    expect(await bundleIdentity()).toEqual(bundle)
    expect(await readFile(original)).toEqual(originalBytes)
  } finally { await close() }
})
