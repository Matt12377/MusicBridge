import { testElectronArguments } from '../scripts/test-keychain.mjs'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CanonicalReference, CatalogMapping, CatalogRevisionDetail } from '@music-bridge/contracts'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const axe = await readFile(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8')
let app: ElectronApplication | undefined, page: Page, directory: string
async function launch() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !/^(MUSIC_BRIDGE_|NETEASE_|ROON_)/u.test(key))) as Record<string, string>
  app = await electron.launch({ args: testElectronArguments([path.join(root, 'dist/main/index.js')]), cwd: root, env: { ...env, MUSIC_BRIDGE_UI_E2E: '1', MUSIC_BRIDGE_CORE_TEST_MODE: '1', MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR: directory } })
  page = await app.firstWindow(); await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('#home-heading')).toBeVisible()
  await expect.poll(async () => (await page.evaluate(() => window.musicBridge.getCoreHealth())).runtime).toBe('ready')
}
async function close() { const current = app; app = undefined; await current?.close().catch(() => undefined) }
test.beforeEach(async () => { test.setTimeout(120_000); directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-ui-e2e-catalog-')); await mkdir(test.info().outputDir, { recursive: true }); await writeFile(test.info().outputPath('synthetic-user-data-path.txt'), directory); await launch() })
test.afterEach(close)
const item = (referenceId: string): CanonicalReference => ({ referenceId, bookId: 'synthetic-book', brand: '合成品牌', series: '测试系列', edition: '1990', model: referenceId, lengths: [60, 90], iec: 'II', era: '1990', image: { kind: 'none' }, pages: ['1'], notes: '仅用于自动验证', confidence: 'high' })
const sourceText = (items: CanonicalReference[]) => '\uFEFF' + JSON.stringify({ schemaVersion: 1, bookId: 'synthetic-book', title: '合成参考目录', sourceVersion: '第一版', items }) + '\r\n'
async function register(items: CanonicalReference[]) {
  const rawPack = sourceText(items), request = { commandId: randomUUID(), rawPack, packHash: createHash('sha256').update(rawPack).digest('hex'), userConfirmed: true as const }
  const source = await page.evaluate(request => window.musicBridge.registerReferenceSource(request), request)
  expect(await page.evaluate(request => window.musicBridge.registerReferenceSource(request), request)).toEqual(source)
  expect(await page.evaluate(id => window.musicBridge.getReferenceSource({ id }), source.id)).toEqual({ source, rawPack })
  return source
}
async function publish(sourceId: string, items: CanonicalReference[], previous: string | null, mappings: CatalogMapping[] = []): Promise<CatalogRevisionDetail> {
  const request = { sourceId, items, expectedCurrentRevisionId: previous, mappings }
  const preview = await page.evaluate(request => window.musicBridge.previewCatalogRevision(request), request)
  const command = { ...request, commandId: randomUUID(), baselineFingerprint: preview.baselineFingerprint, userConfirmed: true as const }
  const result = await page.evaluate(request => window.musicBridge.publishCatalogRevision(request), command)
  expect(await page.evaluate(request => window.musicBridge.publishCatalogRevision(request), command)).toEqual(result)
  return result
}

test('V3参考目录：实际九API的合并/拆分与历史快照跨冷启动保留，浏览和发布不增库存', async () => {
  expect((await page.evaluate(() => window.musicBridge.listReferenceSources({ offset: 0, limit: 25 }))).total).toBe(0)
  const received = await page.evaluate(() => window.musicBridge.receiveCollectionStock({ commandId: crypto.randomUUID(), model: { brand: '合成', name: '既有型号', edition: '测试', year: 1990, format: 'cassette', tapeType: 'II', identification: 'verified' }, lengthMinutes: 60, quantities: { openedBlank: 2, sealedBlank: 0, legacyUsed: 0, unclassified: 0 } }))
  const inventory = await page.evaluate(() => window.musicBridge.listCollection({ offset: 0, limit: 20 }))
  const source = await register([item('a'), { ...item('a'), pages: ['2'], lengths: [90, 120] }, item('b')])
  expect(source.itemCount).toBe(2)
  const first = await publish(source.id, [{ ...item('a'), pages: ['1', '2'], lengths: [60, 90, 120] }, item('b')], null)
  expect(first.currentCounts).toMatchObject({ total: 2, owned: 0, missing: 0, unknown: 2 })
  const matched = await page.evaluate(input => window.musicBridge.setCatalogMatch({ commandId: crypto.randomUUID(), revisionId: input.revisionId, expectedMatchVersion: 0, match: { referenceId: 'a', modelId: input.modelId, status: 'confirmed', availability: 'unknown' }, userConfirmed: true }), { revisionId: first.revision.id, modelId: received.modelId })
  expect(matched.currentCounts.owned).toBe(1)
  const mergedSource = await register([item('merged')])
  const merged = await publish(mergedSource.id, [item('merged')], first.revision.id, [{ fromReferenceIds: ['a', 'b'], toReferenceIds: ['merged'] }])
  expect(merged.currentCounts).toMatchObject({ total: 1, owned: 1 })
  const splitItems = [item('left'), item('right'), item('added')], splitSource = await register(splitItems)
  const split = await publish(splitSource.id, splitItems, merged.revision.id, [{ fromReferenceIds: ['merged'], toReferenceIds: ['left', 'right'] }])
  expect(split.currentCounts).toEqual({ total: 3, owned: 0, missing: 0, unknown: 3, candidate: 0, needsReview: 2 })
  expect(await page.evaluate(id => window.musicBridge.getCatalogSnapshot({ id }), matched.snapshot.id)).toEqual(matched.snapshot)
  expect((await page.evaluate(() => window.musicBridge.getCatalogHistory({ bookId: 'synthetic-book', offset: 0, limit: 25 }))).total).toBe(3)
  expect(await page.evaluate(() => window.musicBridge.listCollection({ offset: 0, limit: 20 }))).toEqual(inventory)
  const scope = (await page.evaluate(() => window.musicBridge.getCommandOutbox())).datasetId
  await close(); await launch()
  expect((await page.evaluate(() => window.musicBridge.getCommandOutbox())).datasetId).toBe(scope)
  expect((await page.evaluate(() => window.musicBridge.getCommandOutbox())).entries).toEqual([])
  expect(await page.evaluate(id => window.musicBridge.getCatalogRevision({ id }), split.revision.id)).toEqual(split)
  expect(await page.evaluate(id => window.musicBridge.getCatalogSnapshot({ id }), matched.snapshot.id)).toEqual(matched.snapshot)
  expect(await page.evaluate(() => window.musicBridge.listCollection({ offset: 0, limit: 20 }))).toEqual(inventory)
  await close()
  const db = new DatabaseSync(path.join(directory, 'data', 'collection.v1.sqlite'), { readOnly: true })
  try { expect(db.prepare('SELECT count(*) n FROM inventory_ledger').get()?.n).toBe(1); expect(db.prepare('SELECT count(*) n FROM reference_catalog_revisions').get()?.n).toBe(3) } finally { db.close() }
})

test('V3参考目录：页面四步明确确认、原JSON文件预览和历史比较，窄窗无障碍可用', async () => {
  const rawPack = sourceText([item('a'), item('b')]), packHash = createHash('sha256').update(rawPack).digest('hex')
  await page.locator('[data-sidebar-source="collection"]').click()
  await page.getByRole('button', { name: '参考目录与版次', exact: true }).click()
  const panel = page.getByRole('dialog', { name: '参考目录与版次', exact: true })
  await expect(panel).toBeVisible()
  await panel.getByLabel('选择 JSON 文件', { exact: true }).setInputFiles({ name: '合成目录.json', mimeType: 'application/json', buffer: Buffer.from(rawPack) })
  await panel.getByRole('button', { name: '严格预览原资料', exact: true }).click()
  await expect(panel.getByText(packHash, { exact: true })).toBeVisible()
  expect((await page.evaluate(() => window.musicBridge.listReferenceSources({ offset: 0, limit: 25 }))).total).toBe(0)
  await expect(panel.getByRole('button', { name: '登记资料版本', exact: true })).toBeDisabled()
  await panel.getByLabel('我确认登记此原资料与 Hash；这不会发布目录或创建库存', { exact: true }).check()
  await panel.getByRole('button', { name: '登记资料版本', exact: true }).click()
  await expect(panel.getByRole('heading', { name: '2. 整理并发布目录', exact: true })).toBeVisible()
  await panel.getByRole('button', { name: '重新读取来源与当前基线', exact: true }).click()
  await panel.getByRole('button', { name: '预览发布影响', exact: true }).click()
  await expect(panel.getByText('本次发布预览', { exact: true })).toBeVisible()
  expect((await page.evaluate(() => window.musicBridge.getCatalogHistory({ bookId: 'synthetic-book', offset: 0, limit: 25 }))).total).toBe(0)
  await expect(panel.getByRole('button', { name: '确认发布目录', exact: true })).toBeDisabled()
  await panel.getByLabel('我已核对映射和影响，确认发布不可变目录修订；库存不增加', { exact: true }).check()
  await panel.getByRole('button', { name: '确认发布目录', exact: true }).click()
  await expect(panel.getByRole('heading', { name: '3. 审核参考目录与库存的关联', exact: true })).toBeVisible()
  const initialHistory = await page.evaluate(() => window.musicBridge.getCatalogHistory({ bookId: 'synthetic-book', offset: 0, limit: 25 }))
  const initial = await page.evaluate(id => window.musicBridge.getCatalogRevision({ id }), initialHistory.currentRevisionId!)
  await writeFile(test.info().outputPath('catalog-dom-diagnostic.json'), JSON.stringify(await page.evaluate(() => ({ dialogs: [...document.querySelectorAll('dialog')].map(d => ({ open: d.open, attributes: [...d.attributes].map(a => [a.name, a.value]), title: d.querySelector('h2')?.outerHTML, labels: [...d.querySelectorAll('select')].map(e => ({ html: e.outerHTML, label: e.labels?.[0]?.textContent })) })), title: document.getElementById('reference-title')?.outerHTML })), null, 2))
  await panel.getByRole('combobox', { name: '参考条目', exact: true }).selectOption('b')
  await panel.getByRole('combobox', { name: '拥有事实', exact: true }).selectOption('missing')
  await panel.getByLabel('我已核对条目与实际收藏，确认替换该条目的关联审核；不改变库存账本', { exact: true }).check()
  await panel.getByRole('button', { name: '保存关联审核', exact: true }).click()
  await expect(panel.getByText('关联审核已保存；库存账本未改变。', { exact: true })).toBeVisible()
  const matched = await page.evaluate(id => window.musicBridge.getCatalogRevision({ id }), initial.revision.id)
  expect(matched.currentCounts).toMatchObject({ total: 2, owned: 0, missing: 1, unknown: 1 })
  expect((await page.evaluate(() => window.musicBridge.listCollection({ offset: 0, limit: 20 }))).total).toBe(0)
  await page.setViewportSize({ width: 720, height: 800 })
  await page.evaluate(axe)
  const issues = await page.evaluate(async () => (window as typeof window & { axe: { run(root: Element): Promise<{ violations: { id: string; impact: string | null }[] }> } }).axe.run(document.querySelector('dialog[open]')!))
  expect(issues.violations.filter(issue => issue.impact === 'critical' || issue.impact === 'serious')).toEqual([])
  expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  await page.screenshot({ path: test.info().outputPath('catalog-review-720.png') })
  await panel.getByRole('button', { name: /^4\s*历史快照$/u }).click()
  await panel.getByRole('button', { name: '读取历史', exact: true }).click()
  await panel.getByRole('combobox', { name: '前一快照', exact: true }).selectOption(initial.snapshot.id)
  await panel.getByRole('combobox', { name: '后一快照', exact: true }).selectOption(matched.snapshot.id)
  await panel.getByRole('button', { name: '只读比较快照', exact: true }).click()
  await expect(panel.getByRole('columnheader', { name: '事实', exact: true })).toBeVisible()
  await expect(panel.getByText('新增参考：无', { exact: true })).toBeVisible()
  expect(await page.evaluate(id => window.musicBridge.getCatalogSnapshot({ id }), initial.snapshot.id)).toEqual(initial.snapshot)
  await page.screenshot({ path: test.info().outputPath('catalog-history-720.png') })
})

test('V3参考目录：原资料登记回执落盘失败后冷启不重发，人工恢复同命令只保留一份来源', async () => {
  const rawPack = sourceText([item('a')]), request = { commandId: randomUUID(), rawPack, packHash: createHash('sha256').update(rawPack).digest('hex'), userConfirmed: true as const }
  await app!.evaluate(() => {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite')
    const prepare = DatabaseSync.prototype.prepare
    DatabaseSync.prototype.prepare = function (sql: string) {
      const statement = prepare.call(this, sql)
      if (sql.startsWith('UPDATE outbox_states SET result_json=')) {
        DatabaseSync.prototype.prepare = prepare
        Object.defineProperty(statement, 'run', { value: () => { throw new Error('合成目录回执落盘失败') } })
      }
      return statement
    }
  })
  await page.evaluate(request => window.musicBridge.registerReferenceSource(request), request).then(() => { throw new Error('必须观察到回执未确认') }, () => undefined)
  const before = await page.evaluate(() => window.musicBridge.getCommandOutbox())
  expect(before.entries).toHaveLength(1); expect(before.entries[0]?.state).toBe('uncertain')
  await close(); await launch()
  expect(await page.evaluate(() => window.musicBridge.getCommandOutbox())).toEqual(before)
  expect((await page.evaluate(() => window.musicBridge.listReferenceSources({ offset: 0, limit: 25 }))).total).toBe(1)
  await page.getByRole('button', { name: '未确认操作', exact: true }).click()
  const panel = page.getByRole('dialog', { name: '未确认操作', exact: true }), row = panel.locator(`[data-outbox-id="${before.entries[0]!.id}"]`)
  await expect(row.getByText('登记参考资料版本', { exact: true })).toBeVisible()
  await row.getByLabel('我已核对该操作及上述影响，确认恢复原操作', { exact: true }).check()
  await row.getByRole('button', { name: '按原命令重试', exact: true }).click()
  await expect(row.getByText('已成功，待确认', { exact: true })).toBeVisible()
  await row.getByRole('button', { name: '成功结果已确认', exact: true }).click()
  const sources = await page.evaluate(() => window.musicBridge.listReferenceSources({ offset: 0, limit: 25 }))
  expect(sources.total).toBe(1)
  expect((await page.evaluate(id => window.musicBridge.getReferenceSource({ id }), sources.items[0]!.id)).rawPack).toBe(rawPack)
  await close()
  const db = new DatabaseSync(path.join(directory, 'data', 'collection.v1.sqlite'), { readOnly: true })
  try { expect(db.prepare('SELECT count(*) n FROM reference_catalog_ledger WHERE command_id=?').get(request.commandId)?.n).toBe(1); expect(db.prepare('SELECT count(*) n FROM inventory_ledger').get()?.n).toBe(0) } finally { db.close() }
})
