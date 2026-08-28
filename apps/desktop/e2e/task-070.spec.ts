import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CanonicalReference, CatalogMapping, CatalogMatch, SaveWantEntryRequest } from '@music-bridge/contracts'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const axe = await readFile(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8')
const bookId = 'synthetic-progress-book', paging = { offset: 0, limit: 25 }
let app: ElectronApplication | undefined, page: Page, directory: string

async function launch(): Promise<void> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !/^(MUSIC_BRIDGE_|NETEASE_|ROON_)/u.test(key))) as Record<string, string>
  app = await electron.launch({ args: [path.join(root, 'dist/main/index.js')], cwd: root, env: { ...env, MUSIC_BRIDGE_UI_E2E: '1', MUSIC_BRIDGE_CORE_TEST_MODE: '1', MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR: directory } })
  page = await app.firstWindow(); await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('#home-heading')).toBeVisible()
  await expect.poll(async () => (await page.evaluate(() => window.musicBridge.getCoreHealth())).runtime).toBe('ready')
}
async function close(): Promise<void> { const current = app; app = undefined; await current?.close().catch(() => undefined) }
test.beforeEach(async () => {
  test.setTimeout(120_000)
  directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-ui-e2e-progress-'))
  await mkdir(test.info().outputDir, { recursive: true }); await writeFile(test.info().outputPath('synthetic-user-data-path.txt'), directory)
  await launch()
})
test.afterEach(close)

function reference(referenceId = 'a', changes: Partial<CanonicalReference> = {}): CanonicalReference {
  return { referenceId, bookId, brand: '合成品牌', series: '合成系列', model: referenceId, edition: '1990', lengths: [46, 90, 120], iec: 'II', era: '1990', image: { kind: 'none' }, pages: ['1'], notes: '仅自动验证使用的合成目录', confidence: 'high', ...changes }
}
async function publish(items: CanonicalReference[] = [reference()], previous: string | null = null, mappings: CatalogMapping[] = []) {
  const rawPack = '\uFEFF' + JSON.stringify({ schemaVersion: 1, bookId, title: '合成完成度目录', sourceVersion: previous ? '修订资料' : '初始资料', items }) + '\r\n'
  const source = await page.evaluate(request => window.musicBridge.registerReferenceSource(request), { commandId: randomUUID(), rawPack, packHash: createHash('sha256').update(rawPack).digest('hex'), userConfirmed: true as const })
  const request = { sourceId: source.id, items, expectedCurrentRevisionId: previous, mappings }
  const preview = await page.evaluate(request => window.musicBridge.previewCatalogRevision(request), request)
  return page.evaluate(request => window.musicBridge.publishCatalogRevision(request), { ...request, commandId: randomUUID(), baselineFingerprint: preview.baselineFingerprint, userConfirmed: true as const })
}
async function match(revisionId: string, value: CatalogMatch) {
  const detail = await page.evaluate(id => window.musicBridge.getCatalogRevision({ id }), revisionId)
  return page.evaluate(request => window.musicBridge.setCatalogMatch(request), { commandId: randomUUID(), revisionId, expectedMatchVersion: detail.matchVersion, match: value, userConfirmed: true as const })
}
async function receive(lengthMinutes: number | null, quantity: number) {
  return page.evaluate(request => window.musicBridge.receiveCollectionStock(request), {
    commandId: randomUUID(), model: { brand: '合成库存品牌', name: '多长度测试型号', edition: '1990', year: 1990, format: 'cassette' as const, tapeType: 'II' as const, identification: 'verified' as const }, lengthMinutes,
    quantities: { openedBlank: lengthMinutes === null ? 0 : quantity, sealedBlank: 0, legacyUsed: 0, unclassified: lengthMinutes === null ? quantity : 0 }
  })
}
function want(revisionId: string, changes: Partial<SaveWantEntryRequest> = {}): SaveWantEntryRequest {
  return { commandId: randomUUID(), id: null, expectedVersion: 0, revisionId, referenceId: 'a', priority: 'high', preferredCondition: '未使用', notes: '保留拥有，另求一种长度\n合成目标', targetLengthMinutes: 120, packagingTarget: '带原盒', priceTarget: { currency: 'CNY', amount: '12.3400' }, userConfirmed: true, ...changes }
}
async function progress(revisionId: string) { return page.evaluate(request => window.musicBridge.getCollectionProgress(request), { revisionId, page: paging }) }
async function capture(revisionId: string) {
  const current = await progress(revisionId), request = { commandId: randomUUID(), revisionId, expectedFingerprint: current.fingerprint, userConfirmed: true as const }
  const summary = await page.evaluate(request => window.musicBridge.captureCollectionProgress(request), request)
  expect(await page.evaluate(request => window.musicBridge.captureCollectionProgress(request), request)).toEqual(summary)
  return page.evaluate(request => window.musicBridge.getCollectionProgressSnapshot(request), { id: summary.id, page: paging })
}
async function armReceiptFailure(): Promise<void> {
  await app!.evaluate(() => {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite'), prepare = DatabaseSync.prototype.prepare
    DatabaseSync.prototype.prepare = function (sql: string) {
      const statement = prepare.call(this, sql)
      if (sql.startsWith('UPDATE outbox_states SET result_json=')) {
        // 只中断真实 Core 提交之后的 Main 回执保存，不替代库存、求购或快照实现。
        DatabaseSync.prototype.prepare = prepare
        Object.defineProperty(statement, 'run', { value: () => { throw new Error('合成求购回执落盘失败') } })
      }
      return statement
    }
  })
}
async function prepareRestore(): Promise<string> {
  const backupPath = path.join(directory, '合成备份'), restorePath = path.join(directory, '合成恢复')
  await mkdir(backupPath); await mkdir(restorePath)
  // 原生选择器仅返回本测试临时目录；后续备份、校验、恢复和激活均执行生产链路。
  await app!.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }) }, backupPath)
  const destination = await page.evaluate(() => window.musicBridge.chooseBackupRoot({ commandId: crypto.randomUUID(), kind: 'backup-destination' }))
  expect(destination).not.toBeNull()
  const job = await page.evaluate(rootId => window.musicBridge.startBackupJob({ commandId: crypto.randomUUID(), rootId, kind: 'backup', mode: 'metadata', userConfirmed: true }), destination!.id)
  await expect.poll(async () => (await page.evaluate(() => window.musicBridge.getBackupOverview())).jobs.find(item => item.id === job.id)?.state, { timeout: 30_000 }).toBe('succeeded')
  const source = (await page.evaluate(() => window.musicBridge.getBackupOverview())).roots.find(item => item.kind === 'backup-source')!
  expect(source).toBeDefined()
  const verification = await page.evaluate(rootId => window.musicBridge.startBackupJob({ commandId: crypto.randomUUID(), rootId, kind: 'verify', userConfirmed: true }), source.id)
  await expect.poll(async () => (await page.evaluate(() => window.musicBridge.getBackupOverview())).jobs.find(item => item.id === verification.id)?.state, { timeout: 30_000 }).toBe('succeeded')
  await app!.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }) }, restorePath)
  const destinationRoot = await page.evaluate(() => window.musicBridge.chooseBackupRoot({ commandId: crypto.randomUUID(), kind: 'restore-destination' }))
  expect(destinationRoot).not.toBeNull()
  const restored = await page.evaluate(input => window.musicBridge.startBackupJob({ commandId: crypto.randomUUID(), kind: 'restore', ...input, userConfirmed: true }), { rootId: source.id, destinationId: destinationRoot!.id, verificationId: verification.id })
  await expect.poll(async () => (await page.evaluate(() => window.musicBridge.getBackupOverview())).jobs.find(item => item.id === restored.id)?.state, { timeout: 30_000 }).toBe('succeeded')
  return restored.id
}

test('V3完成度：真实九API，Owned与Wanted正交、长度守恒及取消后的不可变历史跨冷启', async () => {
  const firstLot = await receive(46, 2)
  for (const [length, quantity] of [[90, 3], [60, 1], [null, 2]] as const) expect((await receive(length, quantity)).modelId).toBe(firstLot.modelId)
  const copy = await page.evaluate(lotId => window.musicBridge.materializeCollectionCopy({ commandId: crypto.randomUUID(), lotId, bucket: 'openedBlank', action: 'identify' }), firstLot.lotId!)
  const initialCopy = (await page.evaluate(id => window.musicBridge.getCollectionModel(id, { offset: 0, limit: 25 }), firstLot.modelId)).copies.items.find(item => item.physicalId === copy.physicalId)!
  await page.evaluate(input => window.musicBridge.updateCollectionCopy({ commandId: crypto.randomUUID(), ...input, action: 'reserve' }), { physicalId: copy.physicalId!, expectedRevision: initialCopy.revision })
  await page.evaluate(input => window.musicBridge.updateCollectionCopy({ commandId: crypto.randomUUID(), ...input, action: 'mark-unavailable' }), { physicalId: copy.physicalId!, expectedRevision: initialCopy.revision + 1 })
  const inventory = await page.evaluate(id => window.musicBridge.getCollectionModel(id, { offset: 0, limit: 25 }), firstLot.modelId)
  const catalog = await publish([reference(), reference('missing', { brand: '第二品牌', series: '另一系列' }), reference('unknown', { lengths: [] })])
  await match(catalog.revision.id, { referenceId: 'a', modelId: firstLot.modelId, status: 'confirmed', availability: 'unknown' })
  const legacy = await match(catalog.revision.id, { referenceId: 'missing', modelId: null, status: 'unmatched', availability: 'missing' })
  const before = await progress(catalog.revision.id)
  expect((await page.evaluate(() => window.musicBridge.listCollectionProgressSnapshots({ page: { offset: 0, limit: 25 } }))).total).toBe(0)
  const request = want(catalog.revision.id), saved = await page.evaluate(request => window.musicBridge.saveWantEntry(request), request)
  expect(await page.evaluate(request => window.musicBridge.saveWantEntry(request), request)).toEqual(saved)
  expect(saved).toMatchObject({ brand: '合成品牌', model: 'a', version: 1, priceTarget: { currency: 'CNY', amount: '12.3400' } })
  expect((await page.evaluate(request => window.musicBridge.listWantEntries(request), { bookId, revisionId: catalog.revision.id, referenceId: 'a', active: true, page: paging })).items).toEqual([{ entry: saved, needsReview: false }])
  const current = await progress(catalog.revision.id)
  expect(current.overall).toEqual({ total: 3, owned: 1, missing: 1, unknown: 1, candidate: 0, needsReview: 0, wanted: 1, wantTargetCount: 1 })
  expect(current.brands.reduce((total, group) => total + group.counts.total, 0)).toBe(3)
  expect(current.series.reduce((total, group) => total + group.counts.owned, 0)).toBe(1)
  expect(current.entries.items.find(item => item.referenceId === 'a')).toMatchObject({ state: 'owned', stockCount: 8, ownedLengths: [{ lengthMinutes: 46, quantity: 2 }, { lengthMinutes: 90, quantity: 3 }], extraLengths: [{ lengthMinutes: 60, quantity: 1 }], unknownLengthQty: 2, allKnownLengthsOwned: false, wantedTargets: [{ id: saved.id, version: 1 }] })
  expect(current.entries.items.find(item => item.referenceId === 'unknown')?.allKnownLengthsOwned).toBe(false)
  const lengths = await page.evaluate(modelId => window.musicBridge.getCollectionModelLengths({ modelId }), firstLot.modelId)
  expect(lengths).toMatchObject({ total: 8, lengths: [{ lengthMinutes: 46, quantity: 2 }, { lengthMinutes: 60, quantity: 1 }, { lengthMinutes: 90, quantity: 3 }], unknownLengthQty: 2 })
  expect(lengths.lengths.reduce((total, item) => total + item.quantity, lengths.unknownLengthQty)).toBe(lengths.total)
  await expect(page.evaluate(request => window.musicBridge.captureCollectionProgress(request), { commandId: randomUUID(), revisionId: catalog.revision.id, expectedFingerprint: before.fingerprint, userConfirmed: true as const })).rejects.toThrow(/INVENTORY_CONFLICT/u)
  const snapshot = await capture(catalog.revision.id)
  expect((await page.evaluate(request => window.musicBridge.listCollectionProgressSnapshots(request), { bookId, revisionId: catalog.revision.id, page: paging })).items).toEqual([snapshot.snapshot])
  const cancellation = { commandId: randomUUID(), id: saved.id, expectedVersion: 1, userConfirmed: true as const }
  const cancelled = await page.evaluate(request => window.musicBridge.cancelWantEntry(request), cancellation)
  expect(await page.evaluate(request => window.musicBridge.cancelWantEntry(request), cancellation)).toEqual(cancelled)
  expect(cancelled).toMatchObject({ id: saved.id, active: false, version: 2 })
  expect((await page.evaluate(request => window.musicBridge.getWantEntryHistory(request), { id: saved.id, page: paging })).items).toEqual([saved, cancelled])
  await expect(page.evaluate(request => window.musicBridge.saveWantEntry(request), want(catalog.revision.id, { id: saved.id, expectedVersion: 2 }))).rejects.toThrow(/INVENTORY_CONFLICT/u)
  expect((await progress(catalog.revision.id)).overall).toEqual({ ...current.overall, wanted: 0, wantTargetCount: 0 })
  expect(await page.evaluate(request => window.musicBridge.getCollectionProgressSnapshot(request), { id: snapshot.snapshot.id, page: paging })).toEqual(snapshot)
  expect(await page.evaluate(id => window.musicBridge.getCatalogSnapshot({ id }), legacy.snapshot.id)).toEqual(legacy.snapshot)
  expect(await page.evaluate(id => window.musicBridge.getCollectionModel(id, { offset: 0, limit: 25 }), firstLot.modelId)).toEqual(inventory)
  const scope = (await page.evaluate(() => window.musicBridge.getCommandOutbox())).datasetId
  await close(); await launch()
  expect((await page.evaluate(() => window.musicBridge.getCommandOutbox())).datasetId).toBe(scope)
  expect(await page.evaluate(request => window.musicBridge.getCollectionProgressSnapshot(request), { id: snapshot.snapshot.id, page: paging })).toEqual(snapshot)
  expect((await progress(catalog.revision.id)).overall.wanted).toBe(0)
  expect(await page.evaluate(modelId => window.musicBridge.getCollectionModelLengths({ modelId }), firstLot.modelId)).toEqual(lengths)
  await close()
  const db = new DatabaseSync(path.join(directory, 'data', 'collection.v1.sqlite'), { readOnly: true })
  try {
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(17)
    expect(db.prepare('SELECT count(*) n FROM inventory_lots').get()?.n).toBe(4)
    expect(db.prepare('SELECT count(*) n FROM physical_copies').get()?.n).toBe(1)
    expect(db.prepare('SELECT count(*) n FROM inventory_ledger').get()?.n).toBe(7)
    expect(db.prepare('SELECT count(*) n FROM collection_progress_ledger WHERE command_id=?').get(request.commandId)?.n).toBe(1)
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  } finally { db.close() }
})

test('V3完成度：目录修订仅标记旧求购待复核，明确重绑保留版本，旧快照不回填新口径', async () => {
  const stock = await receive(90, 2), first = await publish()
  const legacy = await match(first.revision.id, { referenceId: 'a', modelId: stock.modelId, status: 'confirmed', availability: 'unknown' })
  const saved = await page.evaluate(request => window.musicBridge.saveWantEntry(request), want(first.revision.id))
  const snapshot = await capture(first.revision.id), inventory = await page.evaluate(() => window.musicBridge.listCollection({ offset: 0, limit: 25 }))
  const second = await publish([reference('left'), reference('right')], first.revision.id, [{ fromReferenceIds: ['a'], toReferenceIds: ['left', 'right'] }])
  expect((await page.evaluate(request => window.musicBridge.listWantEntries(request), { bookId, active: true, page: paging })).items).toEqual([{ entry: saved, needsReview: true }])
  const current = await progress(second.revision.id)
  expect(current).toMatchObject({ historicalWantedCount: 1, isCurrentRevision: true, facts: 'current', overall: { total: 2, owned: 0, unknown: 2, needsReview: 2, wanted: 0, wantTargetCount: 0 } })
  expect(current.entries.items.every(item => item.wantedTargets.length === 0)).toBe(true)
  const oldFacts = await progress(first.revision.id)
  expect(oldFacts).toMatchObject({ facts: 'current', isCurrentRevision: false })
  await expect(page.evaluate(request => window.musicBridge.captureCollectionProgress(request), { commandId: randomUUID(), revisionId: first.revision.id, expectedFingerprint: oldFacts.fingerprint, userConfirmed: true as const })).rejects.toThrow(/INVENTORY_CONFLICT/u)
  await expect(page.evaluate(request => window.musicBridge.saveWantEntry(request), want(first.revision.id))).rejects.toThrow(/INVENTORY_CONFLICT/u)
  const update = want(second.revision.id, { id: saved.id, expectedVersion: saved.version, referenceId: 'left', targetLengthMinutes: 46 })
  const rebound = await page.evaluate(request => window.musicBridge.saveWantEntry(request), update)
  expect(rebound).toMatchObject({ id: saved.id, version: 2, revisionId: second.revision.id, referenceId: 'left', model: 'left' })
  expect((await page.evaluate(request => window.musicBridge.listWantEntries(request), { bookId, page: paging })).items).toEqual([{ entry: rebound, needsReview: false }])
  expect((await page.evaluate(request => window.musicBridge.getWantEntryHistory(request), { id: saved.id, page: paging })).items).toEqual([saved, rebound])
  expect(await progress(second.revision.id)).toMatchObject({ historicalWantedCount: 0, overall: { owned: 0, wanted: 1, wantTargetCount: 1 } })
  expect(await page.evaluate(request => window.musicBridge.getCollectionProgressSnapshot(request), { id: snapshot.snapshot.id, page: paging })).toEqual(snapshot)
  const preserved = await page.evaluate(id => window.musicBridge.getCatalogSnapshot({ id }), legacy.snapshot.id)
  expect(preserved).toEqual(legacy.snapshot)
  expect(preserved.counts).not.toHaveProperty('wanted')
  for (const entry of preserved.entries) { expect(entry).not.toHaveProperty('wantedTargets'); expect(entry).not.toHaveProperty('ownedLengths') }
  expect(await page.evaluate(() => window.musicBridge.listCollection({ offset: 0, limit: 25 }))).toEqual(inventory)
})

test('V3完成度：真实回执丢失冷启不重放，人工恢复幂等，schema17恢复切库隔离旧求购命令', async () => {
  test.setTimeout(180_000)
  const catalog = await publish(), baseline = await page.evaluate(request => window.musicBridge.saveWantEntry(request), want(catalog.revision.id, { targetLengthMinutes: 46 }))
  const snapshot = await capture(catalog.revision.id), restoreJobId = await prepareRestore()
  const request = want(catalog.revision.id, { notes: '回执未知但业务已经提交的合成目标' })
  await armReceiptFailure()
  await expect(page.evaluate(request => window.musicBridge.saveWantEntry(request), request)).rejects.toThrow(/OUTBOX_RESULT_UNKNOWN/u)
  const pending = await page.evaluate(() => window.musicBridge.getCommandOutbox())
  expect(pending.entries).toHaveLength(1); expect(pending.entries[0]).toMatchObject({ commandId: request.commandId, command: 'collectionProgress.saveWant', state: 'uncertain', canRetry: true })
  expect(JSON.stringify(pending)).not.toContain('payload'); expect(JSON.stringify(pending)).not.toContain(directory)
  expect((await page.evaluate(request => window.musicBridge.listWantEntries(request), { page: paging })).total).toBe(2)
  await close(); await launch()
  expect(await page.evaluate(() => window.musicBridge.getCommandOutbox())).toEqual(pending)
  await page.reload(); await expect(page.locator('#home-heading')).toBeVisible()
  expect(await page.evaluate(() => window.musicBridge.getCommandOutbox())).toEqual(pending)
  expect((await page.evaluate(request => window.musicBridge.listWantEntries(request), { page: paging })).total).toBe(2)
  const recovered = await page.evaluate(id => window.musicBridge.retryCommandOutbox({ id, userConfirmed: true }), pending.entries[0]!.id)
  expect(recovered.state).toBe('succeeded')
  await page.evaluate(id => window.musicBridge.acknowledgeCommandOutbox({ id }), recovered.id)
  const same = await page.evaluate(request => window.musicBridge.saveWantEntry(request), request)
  expect((await page.evaluate(request => window.musicBridge.getWantEntryHistory(request), { id: same.id, page: paging })).items).toEqual([same])
  expect((await page.evaluate(request => window.musicBridge.listWantEntries(request), { page: paging })).total).toBe(2)

  const oldRequest = want(catalog.revision.id, { notes: '仅存在于旧库，不得写入恢复库' })
  await armReceiptFailure()
  await expect(page.evaluate(request => window.musicBridge.saveWantEntry(request), oldRequest)).rejects.toThrow(/OUTBOX_RESULT_UNKNOWN/u)
  const oldScope = await page.evaluate(() => window.musicBridge.getCommandOutbox()), oldEntry = oldScope.entries.find(entry => entry.commandId === oldRequest.commandId)!
  expect(oldEntry.state).toBe('uncertain')
  await page.evaluate(restoreJobId => window.musicBridge.activateRestoredDataset({ commandId: crypto.randomUUID(), restoreJobId, expectedActiveId: null, userConfirmed: true, stopPlaybackConfirmed: true }), restoreJobId)
  const switched = await page.evaluate(() => window.musicBridge.getCommandOutbox())
  expect(switched.datasetId).not.toBe(oldScope.datasetId)
  expect(switched.entries.find(entry => entry.id === oldEntry.id)).toMatchObject({ datasetId: oldScope.datasetId, state: 'uncertain', canRetry: false })
  await expect(page.evaluate(id => window.musicBridge.retryCommandOutbox({ id, userConfirmed: true }), oldEntry.id)).rejects.toThrow(/OUTBOX_SCOPE_MISMATCH/u)
  await expect(page.evaluate(request => window.musicBridge.cancelWantEntry(request), { commandId: randomUUID(), id: baseline.id, expectedVersion: 1, userConfirmed: true as const })).rejects.toThrow(/OUTBOX_SCOPE_MISMATCH/u)
  expect((await page.evaluate(request => window.musicBridge.listWantEntries(request), { page: paging })).items).toEqual([{ entry: baseline, needsReview: false }])
  expect(await page.evaluate(request => window.musicBridge.getCollectionProgressSnapshot(request), { id: snapshot.snapshot.id, page: paging })).toEqual(snapshot)
  await close(); await launch()
  expect((await page.evaluate(() => window.musicBridge.getCommandOutbox())).datasetId).toBe(switched.datasetId)
  expect((await page.evaluate(request => window.musicBridge.listWantEntries(request), { page: paging })).total).toBe(1)
  expect((await page.evaluate(() => window.musicBridge.getPlaybackState())).state).toBe('idle')
  expect((await page.evaluate(() => window.musicBridge.listCollection({ offset: 0, limit: 25 }))).total).toBe(0)
  await close()
  const oldDb = new DatabaseSync(path.join(directory, 'data', 'collection.v1.sqlite'), { readOnly: true })
  try {
    expect(oldDb.prepare('SELECT count(*) n FROM collection_progress_ledger WHERE command_id=?').get(request.commandId)?.n).toBe(1)
    expect(oldDb.prepare('SELECT count(*) n FROM collection_progress_ledger WHERE command_id=?').get(oldRequest.commandId)?.n).toBe(1)
  } finally { oldDb.close() }
})

test('V3完成度：720窄窗键盘、明确求购与快照确认、旧口径提示及axe截图', async () => {
  const stock = await receive(90, 2), catalog = await publish()
  await match(catalog.revision.id, { referenceId: 'a', modelId: stock.modelId, status: 'confirmed', availability: 'unknown' })
  const inventory = await page.evaluate(() => window.musicBridge.listCollection({ offset: 0, limit: 25 }))
  await page.setViewportSize({ width: 720, height: 800 })
  await page.locator('[data-sidebar-source="collection"]').click()
  const trigger = page.getByRole('button', { name: '完成度与求购', exact: true })
  await trigger.focus(); await trigger.press('Enter')
  const panel = page.getByTestId('collection-progress-panel')
  await expect(panel).toBeVisible(); await expect(panel.getByRole('heading', { name: '完成度与求购', exact: true })).toBeFocused()
  await page.keyboard.press('Tab'); await expect(panel.getByRole('button', { name: '关闭', exact: true })).toBeFocused()
  await panel.getByRole('combobox', { name: '参考书籍', exact: true }).selectOption(bookId)
  await panel.getByRole('combobox', { name: '目录修订', exact: true }).selectOption(catalog.revision.id)
  const entry = panel.locator('.references > li')
  await expect(entry).toHaveCount(1); await expect(entry.getByText(/Owned · 已拥有 · 持有 2 盘 · Wanted 0 目标/u)).toBeVisible()
  const screenshot = async (name: string, focus?: Locator) => {
    if (focus) await focus.scrollIntoViewIfNeeded()
    else await panel.evaluate(element => { element.scrollTop = 0 })
    await page.evaluate(axe)
    const result = await page.evaluate(async () => (window as typeof window & { axe: { run(root: Element): Promise<{ violations: Array<{ id: string; impact: string | null }> }> } }).axe.run(document.querySelector('[data-testid="collection-progress-panel"]')!))
    expect(result.violations.filter(issue => issue.impact === 'critical' || issue.impact === 'serious')).toEqual([])
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await page.screenshot({ path: test.info().outputPath(`progress-${name}-720.png`) })
  }
  await screenshot('current', entry)
  await entry.getByRole('button', { name: '为此参考项新增求购', exact: true }).click()
  await panel.getByRole('combobox', { name: '优先级', exact: true }).selectOption('high')
  await panel.getByLabel('目标长度（分钟，可留空）', { exact: true }).fill('46')
  await panel.getByLabel('偏好包装', { exact: true }).fill('原盒')
  await panel.getByLabel('偏好品相', { exact: true }).fill('未使用')
  await panel.getByLabel('价格币种（可选，三位大写）', { exact: true }).fill('CNY')
  await panel.getByLabel('精确价格金额（可选）', { exact: true }).fill('12.3400')
  await panel.getByLabel('求购备注', { exact: true }).fill('已拥有90分钟，仍明确求46分钟。')
  await expect(panel.getByRole('button', { name: '保存求购目标', exact: true })).toBeDisabled()
  const confirmation = panel.getByLabel('我已核对目标目录与参考项，确认仅保存求购，不更改库存', { exact: true })
  await screenshot('want-confirmation', confirmation)
  await confirmation.focus(); await confirmation.press('Space'); await expect(confirmation).toBeChecked()
  await panel.getByRole('button', { name: '保存求购目标', exact: true }).click()
  await expect(panel.getByText('求购目标已保存 · 版本 1', { exact: true })).toBeVisible()
  await panel.getByRole('button', { name: '刷新求购清单', exact: true }).click()
  await expect(panel.getByText('价格目标 CNY 12.3400', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.musicBridge.listCollection({ offset: 0, limit: 25 }))).toEqual(inventory)
  await panel.getByRole('navigation', { name: '完成度与求购内容' }).getByRole('button', { name: '完成度', exact: true }).click()
  await panel.getByRole('button', { name: '刷新当前完成度', exact: true }).click()
  await expect(entry.getByText(/Owned · 已拥有 · 持有 2 盘 · Wanted 1 目标/u)).toBeVisible()
  await expect(panel.getByRole('button', { name: '采集完成度快照', exact: true })).toBeDisabled()
  await panel.getByLabel('我已核对当前目录与整批事实，确认采集完成度快照', { exact: true }).check()
  await panel.getByRole('button', { name: '采集完成度快照', exact: true }).click()
  await panel.getByRole('button', { name: '查看本次快照', exact: true }).click()
  await expect(panel.getByRole('heading', { name: /^独立历史快照/u })).toBeVisible()
  await expect(entry.getByText(/Wanted 1 目标/u)).toBeVisible(); await screenshot('snapshot', entry)
  await panel.getByRole('button', { name: '读取完成度快照历史', exact: true }).click()
  await expect(panel.getByRole('button', { name: '读取此完成度快照', exact: true })).toHaveCount(1)
  await panel.locator('summary').filter({ hasText: '旧目录快照（旧口径）' }).click()
  await panel.getByRole('button', { name: '读取旧口径快照', exact: true }).first().click()
  await expect(panel.getByText('Wanted 与长度维度未采集。此处仅保留原统计。', { exact: true })).toBeVisible()
  await screenshot('legacy-history', panel.getByRole('heading', { name: /^旧口径历史快照/u }))
  await page.keyboard.press('Escape'); await expect(panel).not.toBeVisible(); await expect(trigger).toBeFocused()
  await page.locator('.inventory-card').filter({ hasText: '多长度测试型号' }).click()
  await expect(page.getByRole('heading', { name: '当前真实持有长度', exact: true })).toBeVisible()
  await expect(page.getByText('90 分钟 · 2 盘', { exact: true })).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('progress-model-lengths-720.png') })
})

test('V3完成度：来源与求购独立读取，单侧失败仍显示另一侧真实资料并可明确恢复', async () => {
  const catalog = await publish(), request = want(catalog.revision.id, { notes: '独立读取回归的既有求购，刷新不得丢失或重复' })
  const saved = await page.evaluate(request => window.musicBridge.saveWantEntry(request), request)
  await page.setViewportSize({ width: 720, height: 800 })
  await page.locator('[data-sidebar-source="collection"]').click()
  const trigger = page.getByRole('button', { name: '完成度与求购', exact: true })
  for (const resource of ['sources', 'wants'] as const) {
    const channel = resource === 'sources' ? 'referenceCatalog:sources' : 'collectionProgress:wants'
    await app!.evaluate(({ ipcMain }, channel) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers
      const original = handlers.get(channel)
      if (!original) throw new Error('合成故障注入必须找到真实读取入口')
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, () => {
        // 仅首次精确读取抛错；立即还原真实处理器，正常资料仍来自生产 Core。
        ipcMain.removeHandler(channel); ipcMain.handle(channel, original)
        throw new Error('[INVENTORY_UNAVAILABLE] 合成单侧列表读取失败')
      })
    }, channel)
    await trigger.click()
    const panel = page.getByTestId('collection-progress-panel')
    await expect(panel).toBeVisible()
    await panel.getByRole('navigation', { name: '完成度与求购内容' }).getByRole('button', { name: '求购清单', exact: true }).click()
    const books = panel.getByRole('combobox', { name: '参考书籍', exact: true })
    const bookOption = books.locator(`option[value="${bookId}"]`)
    const wants = panel.locator('section[aria-labelledby="want-list-title"]')
    const wantedRows = wants.locator('.records > li')
    const label = resource === 'sources' ? '参考来源' : '求购清单'
    const failure = panel.getByRole('alert').filter({ hasText: `${label}读取失败，请重试；已有资料不会被当作空列表。` })
    await expect(failure).toBeVisible()
    if (resource === 'sources') {
      await expect(wantedRows).toHaveCount(1)
      await expect(wantedRows.getByText(saved.notes, { exact: true })).toBeVisible()
      await expect(wantedRows.getByText('价格目标 CNY 12.3400', { exact: true })).toBeVisible()
      await expect(bookOption).toHaveCount(0)
      await expect(panel.getByText(/^尚无参考书籍。/u)).toHaveCount(0)
    } else {
      await expect(bookOption).toHaveCount(1)
      await expect(bookOption).toHaveText(`合成完成度目录 · ${bookId}`)
      await expect(wantedRows).toHaveCount(0)
      await expect(wants.getByText('还没有求购目标。', { exact: true })).toHaveCount(0)
      await expect(wants.getByText('求购清单尚未刷新，不能据此判断没有目标。', { exact: true })).toHaveCount(0)
    }
    await page.screenshot({ path: test.info().outputPath(`progress-partial-${resource}-720.png`) })
    await failure.getByRole('button', { name: `重试${label}`, exact: true }).click()
    await expect(failure).toHaveCount(0)
    await expect(bookOption).toHaveCount(1)
    await expect(wantedRows).toHaveCount(1)
    await expect(wantedRows.getByText(saved.notes, { exact: true })).toBeVisible()
    await expect(wantedRows.getByText('价格目标 CNY 12.3400', { exact: true })).toBeVisible()
    expect((await page.evaluate(request => window.musicBridge.listWantEntries(request), { bookId, page: paging })).items).toEqual([{ entry: saved, needsReview: false }])
    expect((await page.evaluate(request => window.musicBridge.getWantEntryHistory(request), { id: saved.id, page: paging })).items).toEqual([saved])
    expect((await page.evaluate(() => window.musicBridge.listCollectionProgressSnapshots({ page: { offset: 0, limit: 25 } }))).total).toBe(0)
    await page.keyboard.press('Escape'); await expect(panel).not.toBeVisible(); await expect(trigger).toBeFocused()
  }
  expect((await page.evaluate(() => window.musicBridge.listCollection({ offset: 0, limit: 25 }))).total).toBe(0)
})


test('V3完成度：合法大目录历史按响应字节预算分页，完整分组与全部快照均可到达', async () => {
  test.setTimeout(180_000)
  const items = Array.from({ length: 500 }, (_, index) => reference(`large-${index}`, { brand: '牌'.repeat(119) + String.fromCharCode(0x4e00 + index), series: '系'.repeat(120), model: `型号${index}`, edition: '', notes: '', lengths: [] }))
  const catalog = await publish(items), current = await progress(catalog.revision.id), captured: string[] = []
  for (let index = 0; index < 25; index++) {
    const snapshot = await page.evaluate(request => window.musicBridge.captureCollectionProgress(request), { commandId: randomUUID(), revisionId: catalog.revision.id, expectedFingerprint: current.fingerprint, userConfirmed: true as const })
    expect(snapshot.overall.total).toBe(500); captured.push(snapshot.id)
  }
  const seen: string[] = [], pageSizes: number[] = []
  let offset = 0, pages = 0
  while (offset < 25) {
    const result = await page.evaluate(request => window.musicBridge.listCollectionProgressSnapshots(request), { bookId, page: { offset, limit: 25 } })
    expect(result.total).toBe(25); expect(result.offset).toBe(offset)
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(8 * 1024 * 1024)
    expect(result.items.length).toBeGreaterThan(0)
    expect(result.items.length).toBe(Math.min(result.limit, 25 - offset))
    if (pages === 0) expect(result.limit).toBeLessThan(25)
    for (const snapshot of result.items) {
      expect(snapshot.overall.total).toBe(500); expect(snapshot.brands).toHaveLength(500); expect(snapshot.series).toHaveLength(500)
      expect(snapshot.brands.every(group => group.brand.length === 120)).toBe(true)
      expect(snapshot.series.every(group => group.series === '系'.repeat(120))).toBe(true)
      seen.push(snapshot.id)
    }
    pageSizes.push(result.items.length)
    offset += result.items.length; pages++
    expect(result.hasMore).toBe(offset < 25)
    expect(pages).toBeLessThanOrEqual(25)
  }
  expect(new Set(seen).size).toBe(25); expect(seen).toEqual(captured.reverse())
  const empty = await page.evaluate(request => window.musicBridge.listCollectionProgressSnapshots(request), { bookId, page: { offset: 25, limit: 25 } })
  expect(empty.items).toEqual([]); expect(empty.total).toBe(25); expect(empty.hasMore).toBe(false)
  expect((await page.evaluate(() => window.musicBridge.listCollection({ offset: 0, limit: 25 }))).total).toBe(0)
  await page.setViewportSize({ width: 720, height: 800 })
  await page.locator('[data-sidebar-source="collection"]').click()
  await page.getByRole('button', { name: '完成度与求购', exact: true }).click()
  const panel = page.getByTestId('collection-progress-panel')
  await panel.getByRole('combobox', { name: '参考书籍', exact: true }).selectOption(bookId)
  await panel.getByRole('navigation', { name: '完成度与求购内容' }).getByRole('button', { name: '历史', exact: true }).click()
  await panel.getByRole('button', { name: '读取完成度快照历史', exact: true }).click()
  const historyButtons = panel.getByRole('button', { name: '读取此完成度快照', exact: true })
  await expect(historyButtons).toHaveCount(pageSizes[0]!)
  for (let index = 1; index < pageSizes.length; index++) {
    await panel.getByRole('button', { name: '下一页快照', exact: true }).click()
    await expect(historyButtons).toHaveCount(pageSizes[index]!)
  }
  await expect(panel.getByRole('button', { name: '下一页快照', exact: true })).toBeDisabled()
  const previous = panel.getByRole('button', { name: '上一页快照', exact: true })
  await previous.scrollIntoViewIfNeeded(); await expect(previous).toBeEnabled()
  await page.screenshot({ path: test.info().outputPath('progress-history-budget-last-page-720.png') })
  for (let index = pageSizes.length - 2; index >= 0; index--) {
    await previous.click()
    // 相邻预算页可能同为12条；必须等读取结束，不能仅用条数判定已返回。
    await expect(panel.getByRole('button', { name: '关闭', exact: true })).toBeEnabled()
    await expect(historyButtons).toHaveCount(pageSizes[index]!)
  }
  await expect(previous).toBeDisabled()
  await page.keyboard.press('Escape'); await expect(panel).not.toBeVisible()
})
