import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { LocalLegacyKey, LocalLegacyLinksReadPage, LocalLegacyLinkTransition, MasterDraft, MusicDetail, RecordingWorkspaceContext } from '@music-bridge/contracts'
import { verifiedElectronExecution } from '../scripts/electron-identity.mjs'
import { testElectronArguments } from '../scripts/test-keychain.mjs'
import { e2eTemporaryRoot } from './temporary-root.js'
import { waitForMainWindow } from './main-window.js'

const desktop = path.resolve(import.meta.dirname, '..'), hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const quote = (value: string) => '"' + value.replace(/"/gu, '""') + '"'
const json = async <T>(file: string): Promise<T> => JSON.parse(await readFile(file, 'utf8')) as T
/** 非零自制PCM；A不使用旧库。B只使用封存011/schema34自建库，不称真实用户迁移。 */
function wave(): Buffer {
  const pcm = Buffer.alloc(44101 * 4)
  for (let frame = 0; frame < 44101; frame++) { pcm.writeInt16LE((frame % 31) * 107 + 1, frame * 4); pcm.writeInt16LE(-((frame % 19) * 113 + 1), frame * 4 + 2) }
  const fmt = Buffer.alloc(24); fmt.write('fmt '); fmt.writeUInt32LE(16, 4); fmt.writeUInt16LE(1, 8); fmt.writeUInt16LE(2, 10); fmt.writeUInt32LE(44100, 12); fmt.writeUInt32LE(176400, 16); fmt.writeUInt16LE(4, 20); fmt.writeUInt16LE(16, 22)
  const info = Object.entries({ INAM: '014 自制本地曲目', IART: '014 自制作者', IPRD: '014 自制本地专辑' }).flatMap(([key, value]) => { const bytes = Buffer.from(value + '\0'), chunk = Buffer.alloc(8); chunk.write(key); chunk.writeUInt32LE(bytes.length, 4); return [chunk, bytes, Buffer.alloc(bytes.length % 2)] })
  const list = Buffer.concat([Buffer.from('INFO'), ...info]), lh = Buffer.alloc(8), dh = Buffer.alloc(8); lh.write('LIST'); lh.writeUInt32LE(list.length, 4); dh.write('data'); dh.writeUInt32LE(pcm.length, 4)
  const body = Buffer.concat([Buffer.from('WAVE'), fmt, dh, pcm, lh, list]), riff = Buffer.alloc(8); riff.write('RIFF'); riff.writeUInt32LE(body.length, 4); return Buffer.concat([riff, body])
}
async function launch(profile: string): Promise<ElectronApplication> {
  const identity = verifiedElectronExecution(), env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !/^(MUSIC_BRIDGE_|NETEASE_|ROON_)/u.test(key))) as Record<string, string>
  Object.assign(env, { MUSIC_BRIDGE_UI_E2E: '1', MUSIC_BRIDGE_UI_E2E_OFFLINE: '1', MUSIC_BRIDGE_CORE_TEST_MODE: '1', MUSIC_BRIDGE_TEST_KEYCHAIN_MODE: 'mock', MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR: profile })
  return electron.launch({ executablePath: path.join(identity.packageRoot, 'dist/Electron.app/Contents/MacOS/Electron'), args: testElectronArguments([path.join(desktop, 'dist/main/index.js')], 'mock'), cwd: desktop, env })
}
async function network(app: ElectronApplication) {
  const value = await app.evaluate(() => (globalThis as typeof globalThis & { __musicBridgeUiE2eNetworkEvidence?: { installedBeforeWindow: boolean; blockedExternalAttempts: number; blockedHosts: string[] } }).__musicBridgeUiE2eNetworkEvidence)
  expect(value?.installedBeforeWindow).toBe(true); expect(value?.blockedExternalAttempts).toBe(0); expect(value?.blockedHosts).toEqual([]); return value
}
async function closeNormally(app: ElectronApplication) {
  const child = app.process(), finished = child.exitCode === null ? new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('close', (exitCode, signal) => resolve({ exitCode, signal }))) : Promise.resolve({ exitCode: child.exitCode, signal: child.signalCode })
  await app.close(); const value = await finished; expect(value.exitCode).toBe(0); expect(value.signal).toBe(null); return value
}
async function physicalPage(page: Page): Promise<void> {
  const child = page.locator('[data-collection-view="music"]'); if (!await child.isVisible()) await page.locator('[data-sidebar-source="collection"]').click(); await child.click()
}
async function openRelease(page: Page, title: string): Promise<Locator> { await physicalPage(page); await page.getByRole('button', { name: `查看藏品详情：${title}`, exact: true }).click(); return page.getByRole('region', { name: '本地发行关联', exact: true }) }
async function library(page: Page): Promise<Locator> { await page.locator('[data-sidebar-source="local-library"]').click(); const view = page.getByTestId('local-library-view'); await expect(view).toBeVisible(); return view }
async function scan(page: Page): Promise<string> {
  const view = await library(page), summary = view.locator('.local-library-management > summary'); if (!await view.getByRole('button', { name: '增量扫描', exact: true }).isVisible()) await summary.click()
  await view.getByRole('button', { name: '增量扫描', exact: true }).click(); await expect(view.getByRole('list', { name: '扫描任务' })).toContainText('已完成', { timeout: 45_000 }); await expect(view.locator('.local-results-summary')).toContainText('1 首', { timeout: 10_000 })
  const result = await page.evaluate(() => window.musicBridge.queryLocalLibraryTracks({ query: '', rootId: null, offset: 0, limit: 20 })); expect(result.items).toHaveLength(1); return result.items[0]!.track.id
}
async function createEdition(page: Page, trackId: string, title: string): Promise<string> {
  const view = await library(page); await view.locator(`[data-local-detail-track="${trackId}"]`).click(); await view.locator('.local-track-detail').getByRole('button', { name: '选择封面', exact: true }).click()
  const dialog = page.locator('dialog.local-artwork-dialog'); if (await dialog.getByRole('button', { name: '建立另一独立发行', exact: true }).count()) await dialog.getByRole('button', { name: '建立另一独立发行', exact: true }).click()
  await dialog.getByLabel('独立发行名称', { exact: true }).fill(title); await dialog.getByRole('button', { name: '建立独立发行用于选图', exact: true }).click(); await expect(dialog).toContainText('独立发行已建立'); await dialog.getByRole('button', { name: '关闭封面选图', exact: true }).click()
  const detail = await page.evaluate(id => window.musicBridge.getLocalLibraryTrackDetail(id), trackId), newest = detail.editions.find(edition => edition.title === title); expect(newest).toBeDefined(); return newest!.id
}
async function relationPage(page: Page, key: LocalLegacyKey): Promise<LocalLegacyLinksReadPage> { return page.evaluate(async key => { const { datasetId } = await window.musicBridge.getCommandOutbox(); return window.musicBridge.readLocalLegacyLinks({ datasetId, selector: { by: 'legacy', key }, state: 'all', cursor: null, limit: 100 }) }, key) }
async function relationHistory(page: Page, linkId: string): Promise<LocalLegacyLinkTransition[]> { return page.evaluate(async linkId => { const { datasetId } = await window.musicBridge.getCommandOutbox(); return (await window.musicBridge.historyLocalLegacyLinks({ datasetId, linkId, cursor: null, limit: 100 })).items }, linkId) }
async function chooseAndConfirm(panel: Locator, trackId: string, editionId: string | null, source = false, screenshot = source ? '014-source-preview.png' : '014-edition-preview.png'): Promise<void> {
  await panel.getByRole('button', { name: source ? '关联当前源到本地曲目' : '关联本地发行', exact: true }).click(); await panel.getByRole('button', { name: `查看本地候选 ${trackId}`, exact: true }).click()
  if (editionId) await panel.getByRole('combobox', { name: '具体本地发行', exact: true }).selectOption(editionId)
  await panel.getByLabel('关联理由', { exact: true }).fill('自有夹具中逐项核对明确身份和真实文件证据'); await panel.getByRole('button', { name: source ? '预览关联当前源' : '预览关联本地发行', exact: true }).click(); await expect(panel.getByRole('group', { name: '本地关联具体预览', exact: true })).toBeVisible()
  await pageScreenshot(panel, screenshot)
  const confirm = panel.getByRole('button', { name: source ? '确认关联当前源' : '确认关联本地发行', exact: true }); await confirm.focus(); await confirm.press('Tab'); await expect(panel.getByRole('button', { name: '取消本地关联预览', exact: true })).toBeFocused(); await confirm.click(); await expect(panel).toContainText('本地关联已保存。'); await panel.getByRole('button', { name: '关闭本地关联编辑', exact: true }).click()
}
async function pageScreenshot(panel: Locator, filename: string): Promise<void> { await panel.page().screenshot({ path: test.info().outputPath(filename) }) }
async function revokeUndo(panel: Locator, screenshot = '014-cas-undo-preview.png'): Promise<void> {
  await panel.getByRole('button', { name: '解除本地关联', exact: true }).click(); await panel.getByLabel('解除理由', { exact: true }).fill('解除当前关系，保留全部旧内容与历史'); await panel.getByRole('button', { name: '预览解除本地关联', exact: true }).click(); await panel.getByRole('button', { name: '确认解除本地关联', exact: true }).click(); await expect(panel).toContainText('本地关联已解除。'); await panel.getByRole('button', { name: '关闭本地关联编辑', exact: true }).click()
  await panel.getByRole('button', { name: /^读取本地关系历史 [0-9a-f-]+$/u }).click(); await panel.getByRole('button', { name: /^准备撤销本地关系操作 [0-9a-f-]+$/u }).click(); await panel.getByLabel('撤销理由', { exact: true }).fill('明确撤销上一次解除，重新核对当前关系修订'); await panel.getByRole('button', { name: '预览撤销本地关系操作', exact: true }).click(); await pageScreenshot(panel, screenshot); await panel.getByRole('button', { name: '确认撤销本地关系操作', exact: true }).click(); await expect(panel).toContainText('关系操作已撤销。'); await panel.getByRole('button', { name: '关闭本地关联编辑', exact: true }).click()
}
async function persistedWrites(profile: string) {
  const file = path.join(profile, 'data/command-outbox.v1.sqlite')
  async function shmState() {
    const entry = await lstat(file + '-shm').catch((cause: unknown) => { if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') return null; throw cause })
    if (entry === null) return { state: { kind: 'absent' }, bytes: null }
    const uid = process.getuid?.(); if (uid === undefined) throw new Error('Outbox SHM文件所有权无法核对')
    expect(entry.isSymbolicLink()).toBe(false); expect(entry.isFile()).toBe(true); expect(entry.uid).toBe(uid); expect(entry.nlink).toBe(1)
    const bytes = await readFile(file + '-shm'); expect(bytes.length).toBe(entry.size)
    return { state: { kind: 'present', regularFile: true, device: entry.dev, inode: entry.ino, uid: entry.uid, gid: entry.gid, mode: entry.mode, links: entry.nlink, size: entry.size, sha256: hash(bytes), mtimeMs: entry.mtimeMs, ctimeMs: entry.ctimeMs }, bytes }
  }
  await expect(stat(file + '-wal')).rejects.toMatchObject({ code: 'ENOENT' }); const beforeShm = await shmState(), before = hash(await readFile(file)), db = new DatabaseSync(':memory:', { allowExtension: false }), uri = pathToFileURL(file); uri.search = '?mode=ro&immutable=1'
  try { db.prepare('ATTACH DATABASE ? AS legacy').run(uri.href); const rows = db.prepare('SELECT e.request_json,s.state,s.acknowledged FROM legacy.outbox_entries e JOIN legacy.outbox_states s ON s.id=e.id ORDER BY e.command_id').all(); return rows.flatMap(row => { const request = JSON.parse(String(row.request_json)) as { command: string }; return request.command.startsWith('localLegacyLinks.') ? [{ request, state: String(row.state), acknowledged: row.acknowledged === 1 }] : [] }) }
  finally {
    db.close(); const after = hash(await readFile(file)); await expect(stat(file + '-wal')).rejects.toMatchObject({ code: 'ENOENT' }); const afterShm = await shmState()
    const receipt = { consumer: 'OUTBOX_IMMUTABLE_COLD_READ', database: file, databaseSha256: { before, after }, walAbsentBeforeAndAfter: true, shm: { before: beforeShm.state, after: afterShm.state, allBytesEqual: beforeShm.bytes === null ? afterShm.bytes === null : afterShm.bytes !== null && beforeShm.bytes.equals(afterShm.bytes) } }
    await writeFile(test.info().outputPath('014-outbox-cold-read-' + crypto.randomUUID() + '.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    expect(after).toBe(before); expect(afterShm.state).toEqual(beforeShm.state); expect(afterShm.bytes).toEqual(beforeShm.bytes)
  }
}

test('014 A生产离线空库：自制WAV扫描、明确实体发行关联/解除/CAS撤销、冷启动仅读与源SHA不变', async () => {
  test.setTimeout(180_000); const run = await mkdtemp(path.join(e2eTemporaryRoot(), 'mbrs014-a-')), profile = path.join(run, 'musicbridge-ui-e2e-' + path.basename(run)), source = path.join(run, 'own-source'); await mkdir(profile, { mode: 0o700 }); await mkdir(source); const file = path.join(source, 'fixture.wav'); await writeFile(file, wave(), { flag: 'wx', mode: 0o600 }); const before = hash(await readFile(file)), errors: string[] = [], closes: unknown[] = [], networks: unknown[] = []
  let app: ElectronApplication | null = null, completed = false, linkId = '', releaseId = '', trackId = '', editionId = '', writesBefore: Awaited<ReturnType<typeof persistedWrites>> = []
  try {
    app = await launch(profile); let page = await waitForMainWindow(app); page.on('pageerror', error => errors.push(error.message)); let view = await library(page); await view.locator('.local-library-management > summary').click()
    await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [directory] })) as typeof dialog.showOpenDialog }, source)
    await view.getByRole('button', { name: '授权源目录并加入音乐库', exact: true }).click(); trackId = await scan(page); editionId = await createEdition(page, trackId, '014 A明确本地发行')
    await physicalPage(page); await page.getByRole('button', { name: '添加实体音乐', exact: true }).click(); const editor = page.getByRole('dialog', { name: '添加实体音乐', exact: true }); await editor.getByLabel('艺术家', { exact: true }).fill('014 自制作者'); await editor.getByLabel('专辑 / 录音标题', { exact: true }).fill('014 A实体发行'); await editor.getByRole('button', { name: '保存音乐资料', exact: true }).click(); await expect(editor).toHaveCount(0)
    const releases = await page.evaluate(() => window.musicBridge.listPhysicalMusic({ offset: 0, limit: 24 })); releaseId = releases.items.find(entry => entry.title === '014 A实体发行')!.id; const physicalBefore = await page.evaluate(id => window.musicBridge.getPhysicalMusic(id), releaseId), oldBefore = await page.evaluate(id => window.musicBridge.getPhysicalLinks(id), releaseId)
    let panel = page.getByRole('region', { name: '本地发行关联', exact: true }); await expect(panel).toContainText('未建立本地关联'); await expect(page.getByRole('button', { name: '关联 Roon 专辑', exact: true })).toBeEnabled(); await chooseAndConfirm(panel, trackId, editionId)
    const key: LocalLegacyKey = { kind: 'physical-release', physicalReleaseId: releaseId }, linked = await relationPage(page, key); expect(linked.items).toHaveLength(1); linkId = linked.items[0]!.linkId; expect(linked.items[0]!.endpoints.kind === 'legacy-edition' && linked.items[0]!.endpoints.localEditionId).toBe(editionId); await revokeUndo(panel)
    expect((await relationHistory(page, linkId)).map(event => event.action)).toEqual(['confirmed', 'revoked', 'undone']); expect(await page.evaluate(id => window.musicBridge.getPhysicalMusic(id), releaseId)).toEqual(physicalBefore); expect(await page.evaluate(id => window.musicBridge.getPhysicalLinks(id), releaseId)).toEqual(oldBefore); networks.push(await network(app)); closes.push(await closeNormally(app)); app = null
    writesBefore = await persistedWrites(profile); expect(writesBefore).toHaveLength(3); expect(writesBefore.every(entry => entry.state === 'succeeded' && entry.acknowledged)).toBe(true)
    app = await launch(profile); page = await waitForMainWindow(app); page.on('pageerror', error => errors.push(error.message)); panel = await openRelease(page, '014 A实体发行'); await expect(panel.getByRole('article', { name: '已保存本地关联', exact: true })).toContainText(editionId); await panel.getByRole('button', { name: /^读取本地关系历史 [0-9a-f-]+$/u }).click(); await expect(panel).toContainText('已撤销关系操作'); expect((await relationHistory(page, linkId)).map(event => event.action)).toEqual(['confirmed', 'revoked', 'undone']); await pageScreenshot(panel, '014-a-cold-history.png'); networks.push(await network(app)); closes.push(await closeNormally(app)); app = null
    expect(await persistedWrites(profile)).toEqual(writesBefore); expect(hash(await readFile(file))).toBe(before); expect(errors).toEqual([]); completed = true
  } finally {
    if (app) { networks.push(await network(app)); closes.push(await closeNormally(app)); app = null }
    const evidence = { layer: 'PRODUCTION_OFFLINE_CONTROLLED_APP_A', completed, synthetic: true, profile, source: file, before, after: hash(await readFile(file)), trackId, editionId, releaseId, linkId, writesBefore, closes, networks, pageErrors: errors, realAccountRoonAudioOwner: 'NOT_RUN' }; await writeFile(path.join(run, '014-a-evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); await writeFile(test.info().outputPath('014-a-evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  }
})

type Cell = { sqliteType: 'NULL' } | { sqliteType: 'INTEGER'; exact: string } | { sqliteType: 'REAL'; ieee754le: string } | { sqliteType: 'TEXT'; utf8Base64: string } | { sqliteType: 'BLOB'; base64: string }
interface OriginalTable { name: string; sql: string; columns: { cid: number; name: string; type: string; notnull: number; dflt_value: Cell; pk: number }[]; orderBy: string; rows: Cell[][] }
interface OriginalBaseline { tables: OriginalTable[] }
function cell(value: SQLOutputValue | undefined, type: string, text: SQLOutputValue | undefined): Cell {
  if (type === 'null') { expect(value).toBe(null); return { sqliteType: 'NULL' } }
  if (type === 'integer') { expect(typeof value).toBe('bigint'); return { sqliteType: 'INTEGER', exact: String(value) } }
  if (type === 'real') { expect(typeof value).toBe('number'); const bytes = Buffer.alloc(8); bytes.writeDoubleLE(value as number); return { sqliteType: 'REAL', ieee754le: bytes.toString('hex') } }
  if (type === 'text') { expect(text).toBeInstanceOf(Uint8Array); return { sqliteType: 'TEXT', utf8Base64: Buffer.from(text as Uint8Array).toString('base64') } }
  expect(type).toBe('blob'); expect(value).toBeInstanceOf(Uint8Array); return { sqliteType: 'BLOB', base64: Buffer.from(value as Uint8Array).toString('base64') }
}
/** 只在所有作者正常关闭后读取；保留完整103表SQL/列合同/NULL/整数/REAL/TEXT原字节/BLOB及行序。 */
async function capture103(profile: string, baseline: OriginalBaseline): Promise<OriginalTable[]> {
  const file = path.join(profile, 'data/collection.v1.sqlite'); for (const suffix of ['-wal', '-shm']) await expect(stat(file + suffix)).rejects.toMatchObject({ code: 'ENOENT' })
  const before = hash(await readFile(file)), db = new DatabaseSync(':memory:', { allowExtension: false }), uri = pathToFileURL(file); uri.search = '?mode=ro&immutable=1'
  try { db.prepare('ATTACH DATABASE ? AS legacy').run(uri.href); return baseline.tables.map(old => {
    const sql = String(db.prepare("SELECT sql FROM legacy.sqlite_schema WHERE type='table' AND name=?").get(old.name)!.sql), actual = db.prepare(`PRAGMA legacy.table_info(${quote(old.name)})`).all(), columns = actual.map(column => ({ cid: Number(column.cid), name: String(column.name), type: String(column.type), notnull: Number(column.notnull), dflt_value: column.dflt_value === null ? { sqliteType: 'NULL' as const } : { sqliteType: 'TEXT' as const, utf8Base64: Buffer.from(String(column.dflt_value)).toString('base64') }, pk: Number(column.pk) }))
    expect(sql).toBe(old.sql); expect(columns).toEqual(old.columns); const select = columns.flatMap((column, index) => [`${quote(column.name)} AS "v${index}"`, `typeof(${quote(column.name)}) AS "t${index}"`, `CAST(${quote(column.name)} AS BLOB) AS "b${index}"`]).join(','); const statement = db.prepare(`SELECT ${select} FROM legacy.${quote(old.name)} ORDER BY ${old.orderBy}`); statement.setReadBigInts(true)
    return { name: old.name, sql, columns, orderBy: old.orderBy, rows: statement.all().map(row => columns.map((_, index) => cell(row[`v${index}`], String(row[`t${index}`]), row[`b${index}`]))) }
  }) } finally { db.close(); expect(hash(await readFile(file))).toBe(before); for (const suffix of ['-wal', '-shm']) await expect(stat(file + suffix)).rejects.toMatchObject({ code: 'ENOENT' }) }
}
/** 原ZIP目标会话仅在成功启动时使id=1的INTEGER epoch增加1；其他表、列、行、单元格完整保持。 */
function sessionEpoch(tables: OriginalTable[]): Extract<Cell, { sqliteType: 'INTEGER' }> {
  expect(tables).toHaveLength(103); const sessions = tables.filter(table => table.name === 'preparation_zip_session'); expect(sessions).toHaveLength(1)
  const table = sessions[0]!, idIndex = table.columns.findIndex(column => column.name === 'id'), epochIndex = table.columns.findIndex(column => column.name === 'epoch')
  expect(idIndex).toBeGreaterThanOrEqual(0); expect(epochIndex).toBeGreaterThanOrEqual(0); expect(table.columns[epochIndex]!.type).toBe('INTEGER'); expect(table.rows).toHaveLength(1)
  expect(table.rows[0]![idIndex]).toEqual({ sqliteType: 'INTEGER', exact: '1' }); const value = table.rows[0]![epochIndex]
  if (!value || value.sqliteType !== 'INTEGER') throw new Error('ZIP会话epoch必须保留完整INTEGER类型证据')
  return value
}
function expected103AfterBoots(baseline: OriginalBaseline, successfulBoots: 1 | 2): OriginalTable[] {
  expect([1, 2]).toContain(successfulBoots); const oldEpoch = sessionEpoch(baseline.tables), expected = structuredClone(baseline.tables), table = expected.find(item => item.name === 'preparation_zip_session')!
  const next = BigInt(oldEpoch.exact) + BigInt(successfulBoots); expect(next >= 0n && next <= 9007199254740991n).toBe(true)
  table.rows[0]![table.columns.findIndex(column => column.name === 'epoch')] = { sqliteType: 'INTEGER', exact: String(next) }
  return expected
}
/** 旧工作位置是页面操作的派生状态；逐项核对真实公共回执和追加ledger，不豁免业务历史行。 */
async function workspaceSnapshot(page: Page, draft: MasterDraft, revision: number, position: 'source' | 'workbench'): Promise<RecordingWorkspaceContext> {
  const expected: RecordingWorkspaceContext = { draftId: draft.id, draftRevision: draft.revision, contextRevision: revision, selection: {}, pagePosition: position, staleReasons: [] }
  await expect.poll(() => page.evaluate(id => window.musicBridge.getRecordingWorkspaceContext(id), draft.id)).toEqual(expected)
  const actual = await page.evaluate(id => window.musicBridge.getRecordingWorkspaceContext(id), draft.id); expect(actual).toEqual(expected); return actual!
}
function canonicalWorkspace(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalWorkspace).join(',') + ']'
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => JSON.stringify(key) + ':' + canonicalWorkspace(child)).join(',') + '}'
  return JSON.stringify(value)
}
function expected103AfterUi(baseline: OriginalBaseline, actual: OriginalTable[], boots: 1 | 2, snapshots: RecordingWorkspaceContext[], windows: { beganAt: number; closedAt: number }[], firstBootLedger?: Cell[][]): OriginalTable[] {
  const expected = expected103AfterBoots(baseline, boots), count = boots === 1 ? 2 : 3, positions = ['source', 'workbench', 'source'] as const
  expect(actual).toHaveLength(103); expect(snapshots).toHaveLength(count); expect(windows).toHaveLength(boots)
  const contexts = actual.find(table => table.name === 'recording_workspace_contexts')!, ledger = actual.find(table => table.name === 'recording_workspace_ledger')!
  const contextExpected = expected.find(table => table.name === contexts.name)!, ledgerExpected = expected.find(table => table.name === ledger.name)!
  expect(contextExpected.rows).toEqual([]); expect(ledgerExpected.rows).toEqual([]); expect(contexts.rows).toHaveLength(1); expect(ledger.rows).toHaveLength(count)
  expect(contexts.columns.map(column => column.name)).toEqual(['draft_id', 'draft_revision', 'context_revision', 'selection', 'page_position', 'updated_at'])
  expect(ledger.columns.map(column => column.name)).toEqual(['command_id', 'fingerprint', 'result', 'created_at'])
  const text = (value: string): Cell => ({ sqliteType: 'TEXT', utf8Base64: Buffer.from(value, 'utf8').toString('base64') }), integer = (value: number): Cell => ({ sqliteType: 'INTEGER', exact: String(value) })
  function timestamp(value: Cell | undefined, boot: number): string {
    const result = decodeText(value), parsed = Date.parse(result), window = windows[boot]!
    expect(Number.isFinite(parsed)).toBe(true); expect(new Date(parsed).toISOString()).toBe(result); expect(parsed).toBeGreaterThanOrEqual(window.beganAt); expect(parsed).toBeLessThanOrEqual(window.closedAt); return result
  }
  const commandIds = new Set<string>(), createdTimes: string[] = []
  ledgerExpected.rows = ledger.rows.map((row, index) => {
    expect(row).toHaveLength(4); const commandId = decodeText(row[0]); expect(commandId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u); expect(commandIds.has(commandId)).toBe(false); commandIds.add(commandId)
    const snapshot = snapshots[index]!, result: RecordingWorkspaceContext = { draftId: snapshots[0]!.draftId, draftRevision: snapshots[0]!.draftRevision, contextRevision: index + 1, selection: {}, pagePosition: positions[index]!, staleReasons: [] }; expect(snapshot).toEqual(result)
    const request = { commandId, draftId: result.draftId, expectedDraftRevision: result.draftRevision, expectedContextRevision: index, selection: {}, pagePosition: result.pagePosition }, createdAt = timestamp(row[3], index < 2 ? 0 : 1); createdTimes.push(createdAt)
    return [text(commandId), text(hash(Buffer.from(canonicalWorkspace(request)))), text(JSON.stringify(result)), text(createdAt)]
  })
  expect(ledger.rows).toEqual(ledgerExpected.rows); for (let index = 1; index < createdTimes.length; index++) expect(Date.parse(createdTimes[index]!)).toBeGreaterThanOrEqual(Date.parse(createdTimes[index - 1]!))
  if (boots === 2) { expect(firstBootLedger).toHaveLength(2); expect(ledger.rows.slice(0, 2)).toEqual(firstBootLedger) }
  const current = snapshots.at(-1)!, updatedAt = timestamp(contexts.rows[0]![5], boots - 1); expect(Date.parse(updatedAt)).toBeLessThanOrEqual(Date.parse(createdTimes.at(-1)!))
  contextExpected.rows = [[text(current.draftId), integer(current.draftRevision), integer(count), text('{}'), text(current.pagePosition), text(updatedAt)]]
  expect(contexts.rows).toEqual(contextExpected.rows); return expected
}
interface BBusiness { generatedSchema: number; business: { generationBase: string; draft: { draftId: string; trackIds: string[] }; sourceBindings: { id: string; rootId: string; relative: string; evidence: { sha256: string } }[]; commercial: MusicDetail; digital: { album: { id: string } }; record: { record: { id: string } }; retained: { directory: string; sourcePath: string; sourceFile: string }; ownedJpeg: { path: string }; modelId: string } }
interface P1Receipt { state: string; originalTables: number; originalBaseline: { path: string; sha256: string }; pdf: { path: string; sha256: string }; original103FullyComparedWithExactSessionEpoch: boolean; allowedSessionEpochIncreasePerSuccessfulBoot: number; businessHistoryRowExceptions: number }
async function requiredPath(name: string): Promise<string> { const value = process.env[name]; expect(value, `缺少${name}，B须从Root正常关闭并封存的P1开始`).toBeTruthy(); expect(path.isAbsolute(value!)).toBe(true); expect(await realpath(value!)).toBe(value); expect(value!.startsWith(e2eTemporaryRoot() + path.sep)).toBe(true); return value! }
function decodeText(value: Cell | undefined): string { expect(value?.sqliteType).toBe('TEXT'); return Buffer.from((value as Extract<Cell, { sqliteType: 'TEXT' }>).utf8Base64, 'base64').toString('utf8') }
async function vacuumP1(profile: string, destination: string): Promise<void> {
  const file = path.join(profile, 'data/collection.v1.sqlite'); for (const suffix of ['-wal', '-shm']) await expect(stat(file + suffix)).rejects.toMatchObject({ code: 'ENOENT' })
  const before = hash(await readFile(file)); await cp(profile, destination, { recursive: true, errorOnExist: true, force: false, filter: source => ![file, file + '-wal', file + '-shm'].includes(source) }); await mkdir(path.join(destination, 'data'), { recursive: true })
  const db = new DatabaseSync(':memory:', { allowExtension: false }), uri = pathToFileURL(file); uri.search = '?mode=ro&immutable=1'
  try { db.prepare('ATTACH DATABASE ? AS legacy').run(uri.href); db.exec(`VACUUM legacy INTO '${path.join(destination, 'data/collection.v1.sqlite').replace(/'/gu, "''")}'`) } finally { db.close(); expect(hash(await readFile(file))).toBe(before); for (const suffix of ['-wal', '-shm']) await expect(stat(file + suffix)).rejects.toMatchObject({ code: 'ENOENT' }) }
}
async function currentSource(page: Page, draft: MasterDraft, trackId: string): Promise<Locator> { await page.locator('[data-sidebar-source="recording"]').click(); await page.locator('.draft-card').filter({ hasText: draft.title }).click(); await page.locator(`[data-recording-return-focus="source-${trackId}"]`).click(); return page.getByRole('region', { name: '当前源关联', exact: true }) }

test('014 B生产离线非空自建库：P1后准确实体/数字/当前源关系全闭环、旧103逐值精确会话与工作位置派生、照片/输出/PDF/冻结历史不变', async () => {
  test.skip(process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted' && ['MBRS014_B_P1_RECEIPT', 'MBRS014_B_P1_PROFILE', 'MBRS014_B_P0_FACTS', 'MBRS014_B_P0_RETAINED_FILES'].every(name => process.env[name] === undefined), '仅本机自有P1副本用例；Hosted CI未提供私有P1基线，不计兼容通过')
  test.setTimeout(240_000); const receiptPath = await requiredPath('MBRS014_B_P1_RECEIPT'), originalProfile = await requiredPath('MBRS014_B_P1_PROFILE'), factsPath = await requiredPath('MBRS014_B_P0_FACTS'), retainedPath = await requiredPath('MBRS014_B_P0_RETAINED_FILES')
  const receipt = await json<P1Receipt>(receiptPath), facts = await json<BBusiness>(factsPath), retained = await json<{ files: { path: string; bytes: number; sha256: string }[] }>(retainedPath); expect(receipt.state).toBe('P1_EXACT_ORIGINAL_PRINT_DELTA_VALIDATED'); expect(receipt.originalTables).toBe(103); expect(receipt.original103FullyComparedWithExactSessionEpoch).toBe(true); expect(receipt.allowedSessionEpochIncreasePerSuccessfulBoot).toBe(1); expect(receipt.businessHistoryRowExceptions).toBe(0); expect(facts.generatedSchema).toBe(34); expect(facts.business.generationBase).toBe('b33357c09e6bded2b4c6c5acfcf7330e68366a5f'); expect(retained.files).toHaveLength(35)
  expect(hash(await readFile(receipt.originalBaseline.path))).toBe(receipt.originalBaseline.sha256); expect(hash(await readFile(receipt.pdf.path))).toBe(receipt.pdf.sha256); const baseline = await json<OriginalBaseline>(receipt.originalBaseline.path); expect(baseline.tables).toHaveLength(103); expect(await capture103(originalProfile, baseline)).toEqual(baseline.tables); const baselineEpoch = sessionEpoch(baseline.tables)
  const run = await mkdtemp(path.join(e2eTemporaryRoot(), 'mbrs014-b-')), profile = path.join(run, 'musicbridge-ui-e2e-' + path.basename(run)); await vacuumP1(originalProfile, profile); expect(await capture103(profile, baseline)).toEqual(baseline.tables)
  for (const item of retained.files) { const bytes = await readFile(item.path); expect(bytes.length).toBe(item.bytes); expect(hash(bytes)).toBe(item.sha256) }
  const first = facts.business.sourceBindings[0]!, ledger = baseline.tables.find(table => table.name === 'source_ledger')!, index = (name: string) => ledger.columns.findIndex(column => column.name === name), rootRow = ledger.rows.find(row => decodeText(row[index('result')]) === first.rootId)!
  const rootCommandId = decodeText(rootRow[index('command_id')]); expect(decodeText(rootRow[index('fingerprint')])).toBe(hash(Buffer.from(JSON.stringify(['authorize', rootCommandId])))); const rootTable = baseline.tables.find(table => table.name === 'source_roots')!, capabilityRow = rootTable.rows.find(row => decodeText(row[rootTable.columns.findIndex(column => column.name === 'id')]) === first.rootId)!, capability = JSON.parse(decodeText(capabilityRow[rootTable.columns.findIndex(column => column.name === 'data')])) as { id: string; path: string; authorized: boolean }; expect(capability.id).toBe(first.rootId); expect(capability.path).toBe(facts.business.retained.sourcePath); expect(capability.authorized).toBe(true); expect(hash(await readFile(facts.business.retained.sourceFile))).toBe(first.evidence.sha256)
  let app: ElectronApplication | null = null, completed = false, trackId = '', editionId = '', nativeAuthorizationPickerCalls = -1, final103: OriginalTable[] = [], actualEpochAfterFirstBoot: Cell | null = null, actualEpochAfterColdBoot: Cell | null = null, originalProfileEpochAfter: Cell | null = null, frozenBefore: unknown, frozenAfter: unknown, writesBefore: Awaited<ReturnType<typeof persistedWrites>> = []
  const workspaceSnapshots: RecordingWorkspaceContext[] = [], workspaceWindows: { beganAt: number; closedAt: number }[] = []; let firstBootLedger: Cell[][] = []
  const errors: string[] = [], closes: unknown[] = [], networks: unknown[] = [], identities: { physical: LocalLegacyKey; digital: LocalLegacyKey; source: LocalLegacyKey } = { physical: { kind: 'physical-release', physicalReleaseId: facts.business.commercial.entry.id }, digital: { kind: 'digital-album', digitalAlbumId: facts.business.digital.album.id }, source: { kind: 'draft-source', draftId: facts.business.draft.draftId, draftTrackId: facts.business.draft.trackIds[0]!, sourceBindingId: first.id } }
  try {
    const firstBootBeganAt = Date.now(); app = await launch(profile); let page = await waitForMainWindow(app); page.on('pageerror', error => errors.push(error.message))
    await app.evaluate(({ dialog }) => { const state = globalThis as typeof globalThis & { __mbrs014AuthorizationPickerCalls: number }; state.__mbrs014AuthorizationPickerCalls = 0; dialog.showOpenDialog = (async () => { state.__mbrs014AuthorizationPickerCalls++; throw new Error('已授权旧目录回执命中时不应再次打开chooser') }) as typeof dialog.showOpenDialog })
    const libraryRoot = await page.evaluate(commandId => window.musicBridge.chooseLocalLibraryRoot(commandId), rootCommandId); expect(libraryRoot?.sourceRootId).toBe(first.rootId); nativeAuthorizationPickerCalls = await app.evaluate(() => (globalThis as typeof globalThis & { __mbrs014AuthorizationPickerCalls: number }).__mbrs014AuthorizationPickerCalls); expect(nativeAuthorizationPickerCalls).toBe(0)
    // 初始化只复用原公共Main route/旧授权幂等回执；下面扫描与关系动作都由真实UI完成。
    trackId = await scan(page); editionId = await createEdition(page, trackId, '014 B明确本地发行'); const draft = await page.evaluate(id => window.musicBridge.getMasterDraft(id), facts.business.draft.draftId); expect(draft.tracks[0]!.id).toBe(facts.business.draft.trackIds[0]); const sourceSnapshot = await page.evaluate(id => window.musicBridge.getDraftSources(id), draft.id); expect(sourceSnapshot.tracks.find(item => item.trackId === draft.tracks[0]!.id)?.binding?.id).toBe(first.id)
    frozenBefore = await page.evaluate(async ({ draftId, recordId }) => ({ versions: await window.musicBridge.listMasterVersions(draftId), preparation: await window.musicBridge.listPreparations(draftId), record: await window.musicBridge.getRecordingRecord(recordId) }), { draftId: draft.id, recordId: facts.business.record.record.id })
    let panel = await openRelease(page, facts.business.commercial.entry.title); await expect(panel).toContainText('未建立本地关联'); await expect(page.getByRole('button', { name: '关联 Roon 专辑', exact: true })).toBeEnabled(); const photoRegion = page.getByRole('region', { name: '发行版实物照片', exact: true }); await photoRegion.scrollIntoViewIfNeeded(); const photo = photoRegion.locator('img').first(); await expect(photo).toBeVisible(); await expect.poll(() => photo.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(16); await pageScreenshot(panel, '014-b-physical-old-photo.png'); await chooseAndConfirm(panel, trackId, editionId, false, '014-b-physical-preview.png'); await revokeUndo(panel, '014-b-physical-cas-undo.png')
    await page.getByRole('button', { name: '查看数字关联详情', exact: true }).click(); panel = page.getByRole('region', { name: '本地发行关联', exact: true }); await expect(page.getByRole('button', { name: '重新定位 Roon 专辑', exact: true })).toBeEnabled(); await chooseAndConfirm(panel, trackId, editionId, false, '014-b-digital-preview.png'); await revokeUndo(panel, '014-b-digital-cas-undo.png'); await pageScreenshot(panel, '014-b-digital-history.png')
    panel = await currentSource(page, draft, draft.tracks[0]!.id); workspaceSnapshots.push(await workspaceSnapshot(page, draft, 1, 'source')); await expect(panel).toContainText('未建立本地关联'); await expect(page.getByRole('button', { name: '重新完整校验', exact: true })).toBeEnabled(); await chooseAndConfirm(panel, trackId, null, true, '014-b-source-preview.png'); const sourceLink = (await relationPage(page, identities.source)).items.find(link => link.state === 'active')!; expect(sourceLink.evidence.kind).toBe('exact-file'); expect(sourceLink.evidence.kind === 'exact-file' && sourceLink.evidence.sha256).toBe(first.evidence.sha256); expect(sourceLink.endpoints.kind === 'draft-source-track' && sourceLink.endpoints.localTrackId).toBe(trackId); await revokeUndo(panel, '014-b-source-cas-undo.png'); await pageScreenshot(panel, '014-b-source-history-frozen-preserved.png')
    const sourceRegion = page.getByRole('region', { name: '实际源文件', exact: true }); await sourceRegion.getByRole('button', { name: '关闭', exact: true }).click(); await expect(sourceRegion).toHaveCount(0); await expect(page.locator('.recording-view').getByRole('status').filter({ hasText: /^正在读取制作…$/u })).toHaveCount(0); workspaceSnapshots.push(await workspaceSnapshot(page, draft, 2, 'workbench'))
    const view = await library(page); await view.locator(`[data-local-detail-track="${trackId}"]`).click(); const detail = view.locator('.local-track-detail'); await detail.getByLabel('仅修改 MB 显示名称', { exact: true }).fill('014 B MB显示更正'); await detail.getByRole('button', { name: '保存显示更正', exact: true }).click(); await expect(detail.getByRole('heading', { name: '014 B MB显示更正', exact: true })).toBeVisible()
    await detail.getByRole('button', { name: '选择封面', exact: true }).click(); const artwork = page.locator('dialog.local-artwork-dialog'); await artwork.getByRole('combobox', { name: '所属独立发行', exact: true }).selectOption(editionId); await app.evaluate(({ dialog }, image) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [image] })) as typeof dialog.showOpenDialog }, facts.business.ownedJpeg.path); await artwork.getByRole('button', { name: '选择 PNG / JPEG', exact: true }).click(); await expect(artwork.locator('.candidate-choice')).toHaveCount(1); await artwork.locator('.candidate-choice').click(); await artwork.getByRole('button', { name: /^保存选图：/u }).click(); await expect(artwork).toContainText('封面选择已保存。'); await artwork.getByRole('button', { name: '关闭封面选图', exact: true }).click()
    const tapes = page.locator('[data-collection-view="tapes"]'); if (!await tapes.isVisible()) await page.locator('[data-sidebar-source="collection"]').click(); await tapes.click(); await page.getByRole('button', { name: '磁带墙', exact: true }).click(); const wallPhoto = page.locator('.inventory-card-photo img').first(); await expect(wallPhoto).toBeVisible(); await expect.poll(() => wallPhoto.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(16); await page.screenshot({ path: test.info().outputPath('014-b-tape-wall-photo.png') }); await page.getByRole('button', { name: '参考目录与版次', exact: true }).click(); await expect(page.locator('dialog.reference-dialog')).toContainText('参考目录与版次'); await page.screenshot({ path: test.info().outputPath('014-b-reference-catalog.png') }); await page.locator('dialog.reference-dialog').getByRole('button', { name: '关闭', exact: true }).click(); await expect(page.getByRole('button', { name: '参考目录与版次', exact: true })).toBeFocused()
    frozenAfter = await page.evaluate(async ({ draftId, recordId }) => ({ versions: await window.musicBridge.listMasterVersions(draftId), preparation: await window.musicBridge.listPreparations(draftId), record: await window.musicBridge.getRecordingRecord(recordId) }), { draftId: draft.id, recordId: facts.business.record.record.id }); expect(frozenAfter).toEqual(frozenBefore)
    networks.push(await network(app)); closes.push(await closeNormally(app)); app = null; workspaceWindows.push({ beganAt: firstBootBeganAt, closedAt: Date.now() }); final103 = await capture103(profile, baseline); expect(final103).toEqual(expected103AfterUi(baseline, final103, 1, workspaceSnapshots, workspaceWindows)); firstBootLedger = structuredClone(final103.find(table => table.name === 'recording_workspace_ledger')!.rows); actualEpochAfterFirstBoot = sessionEpoch(final103); writesBefore = await persistedWrites(profile); expect(writesBefore).toHaveLength(9); expect(writesBefore.every(entry => entry.state === 'succeeded' && entry.acknowledged)).toBe(true)
    const coldBootBeganAt = Date.now(); app = await launch(profile); page = await waitForMainWindow(app); page.on('pageerror', error => errors.push(error.message)); panel = await openRelease(page, facts.business.commercial.entry.title); await expect(panel).toContainText(editionId); await panel.getByRole('button', { name: /^读取本地关系历史 [0-9a-f-]+$/u }).click(); await expect(panel).toContainText('已撤销关系操作'); panel = await currentSource(page, draft, draft.tracks[0]!.id); workspaceSnapshots.push(await workspaceSnapshot(page, draft, 3, 'source')); await expect(panel).toContainText(first.evidence.sha256); await panel.getByRole('button', { name: /^读取本地关系历史 [0-9a-f-]+$/u }).click(); await expect(panel).toContainText('已撤销关系操作'); await pageScreenshot(panel, '014-b-cold-current-source-history.png')
    for (const key of Object.values(identities)) { const relation = await relationPage(page, key); expect(relation.items.filter(link => link.state === 'active')).toHaveLength(1); expect((await relationHistory(page, relation.items[0]!.linkId)).map(event => event.action)).toEqual(['confirmed', 'revoked', 'undone']) }
    networks.push(await network(app)); closes.push(await closeNormally(app)); app = null; workspaceWindows.push({ beganAt: coldBootBeganAt, closedAt: Date.now() }); final103 = await capture103(profile, baseline); expect(final103).toEqual(expected103AfterUi(baseline, final103, 2, workspaceSnapshots, workspaceWindows, firstBootLedger)); actualEpochAfterColdBoot = sessionEpoch(final103); expect(await persistedWrites(profile)).toEqual(writesBefore); const originalProfileAfter = await capture103(originalProfile, baseline); expect(originalProfileAfter).toEqual(baseline.tables); originalProfileEpochAfter = sessionEpoch(originalProfileAfter); expect(hash(await readFile(receipt.pdf.path))).toBe(receipt.pdf.sha256); for (const item of retained.files) expect(hash(await readFile(item.path))).toBe(item.sha256); expect(errors).toEqual([]); completed = true
  } finally {
    if (app) { networks.push(await network(app)); closes.push(await closeNormally(app)); app = null }
    const evidence = { layer: 'PRODUCTION_OFFLINE_CONTROLLED_APP_B_SELF_OWNED_NONEMPTY', completed, realUserMigration: 'NOT_RUN', p1ReceiptPath: receiptPath, p1ReceiptSha256: hash(await readFile(receiptPath)), originalProfileReadOnly: originalProfile, profile, generationBase: facts.business.generationBase, rootCommandId, originalSourceRootId: first.rootId, nativeAuthorizationPickerCalls, initialization: '既有公共Main route精确复用已授权旧目录回执；未执行原生chooser。扫描/候选/关联/解除/撤销/metadata/art/cold为实际UI。', identities, trackId, editionId, frozenBefore, frozenAfter, closes, networks, pageErrors: errors, original103FullyComparedWithExactSessionAndWorkspace: completed, businessHistoryRowExceptions: 0, original100TablesAndAllOtherCellsExact: completed, originalP1ProfileAll103Exact: completed, sessionEpochRule: { table: 'preparation_zip_session', key: { id: { sqliteType: 'INTEGER', exact: '1' } }, column: 'epoch', allowedSessionEpochIncreasePerSuccessfulBoot: 1, baselineP1: baselineEpoch, firstBoot: { successfulBoots: 1, expected: sessionEpoch(expected103AfterBoots(baseline, 1)), actual: actualEpochAfterFirstBoot }, coldBoot: { successfulBoots: 2, expected: sessionEpoch(expected103AfterBoots(baseline, 2)), actual: actualEpochAfterColdBoot }, originalP1Profile: { before: baselineEpoch, after: originalProfileEpochAfter } }, workspaceRule: { tables: ['recording_workspace_contexts', 'recording_workspace_ledger'], positions: ['source', 'workbench', 'source'], actualPublicSnapshots: workspaceSnapshots, bootWindows: workspaceWindows, firstBootLedger, firstBootLedgerUnchangedAfterColdBoot: completed, originalP1WorkspaceUntouched: completed, timestamps: '完整ISO字节保留且必须处于对应实际boot窗口；当前updated_at不晚于同次ledger.created_at', exactRequestFingerprintsAndReceiptCells: completed }, retainedFiles: retained.files, originalPdf: receipt.pdf, writesBefore, realAccountRoonAudioOwner: 'NOT_RUN' }; await writeFile(path.join(run, '014-b-evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); await writeFile(test.info().outputPath('014-b-evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); await writeFile(path.join(run, '014-b-original103-after.json'), JSON.stringify(final103, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  }
})
