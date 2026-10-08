import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import type { LocalLibraryTrackDetail, LocalRelocationPlan } from '@music-bridge/contracts'
import * as dto from '@music-bridge/contracts'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { verifiedElectronExecution } from '../scripts/electron-identity.mjs'
import { testElectronArguments } from '../scripts/test-keychain.mjs'
import { e2eTemporaryRoot } from './temporary-root.js'
import { waitForMainWindow } from './main-window.js'

const desktop = path.resolve(import.meta.dirname, '..')
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const processes = new WeakMap<ElectronApplication, ReturnType<ElectronApplication['process']>>()

/** 013 自有合成 PCM/WAVE；不复制任何012 App或旧fixture材料。 */
function ownedWave(): Buffer {
  const sampleRate = 44100, samples = 8820, pcm = Buffer.alloc(samples * 2)
  for (let index = 0; index < samples; index++) pcm.writeInt16LE(Math.round(3200 * Math.sin(2 * Math.PI * 440 * index / sampleRate)), index * 2)
  const chunk = (id: string, bytes: Buffer): Buffer => {
    const header = Buffer.alloc(8); header.write(id, 0, 4, 'ascii'); header.writeUInt32LE(bytes.length, 4)
    return Buffer.concat([header, bytes, bytes.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)])
  }
  const format = Buffer.alloc(16); format.writeUInt16LE(1, 0); format.writeUInt16LE(1, 2); format.writeUInt32LE(sampleRate, 4)
  format.writeUInt32LE(sampleRate * 2, 8); format.writeUInt16LE(2, 12); format.writeUInt16LE(16, 14)
  const info = Buffer.concat([Buffer.from('INFO'), chunk('INAM', Buffer.from('013 owned relocation\0')), chunk('IART', Buffer.from('MusicBridge synthetic author\0'))])
  const body = Buffer.concat([Buffer.from('WAVE'), chunk('fmt ', format), chunk('LIST', info), chunk('data', pcm)])
  const header = Buffer.alloc(8); header.write('RIFF', 0, 4, 'ascii'); header.writeUInt32LE(body.length, 4)
  return Buffer.concat([header, body])
}

async function ownedMaterial(directory: string) {
  const source = path.join(directory, 'source'), target = path.join(directory, 'target'), profile = path.join(directory, 'musicbridge-ui-e2e-' + path.basename(directory))
  await Promise.all([source, target, profile].map(file => mkdir(file, { recursive: true, mode: 0o700 })))
  const files = [{ name: 'owned-original.wav', kind: 'audio', bytes: ownedWave() }, { name: 'owned-original.lrc', kind: 'lyrics', bytes: Buffer.from('[00:00.00]013 自有合成材料\n', 'utf8') }]
  const manifest = []
  for (const file of files) {
    const absolute = path.join(source, file.name)
    await writeFile(absolute, file.bytes, { flag: 'wx', mode: 0o600 })
    manifest.push({ file: file.name, kind: file.kind, bytes: file.bytes.length, sha256: sha(file.bytes) })
  }
  await writeFile(path.join(directory, 'owned-materials.json'), JSON.stringify({ schema: 'mbrs013.owned-e2e-materials.v1', synthetic: true, allContentOwned: true, files: manifest }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  return { source, target, profile, manifest }
}

/** 独立实际 FD 全流读取；目标在读前、读后和按名核对同一文件。 */
async function readIdentity(file: string) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat({ bigint: true }); expect(before.isFile()).toBe(true); expect(before.nlink).toBe(1n)
    const bytes = await handle.readFile(), after = await handle.stat({ bigint: true }), named = await lstat(file, { bigint: true })
    for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'gid', 'nlink'] as const) { expect(after[key]).toBe(before[key]); expect(named[key]).toBe(before[key]) }
    expect(BigInt(bytes.length)).toBe(before.size)
    return { bytes: bytes.length, sha256: sha(bytes), dev: String(before.dev), ino: String(before.ino), mode: String(before.mode & 0o7777n), uid: String(before.uid), gid: String(before.gid) }
  } finally { await handle.close() }
}

async function launch(profile: string, errors: string[]): Promise<ElectronApplication> {
  const identity = verifiedElectronExecution()
  const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) => value !== undefined && !/^(MUSIC_BRIDGE_|NETEASE_|ROON_)/u.test(name))) as Record<string, string>
  Object.assign(env, { MUSIC_BRIDGE_UI_E2E: '1', MUSIC_BRIDGE_UI_E2E_OFFLINE: '1', MUSIC_BRIDGE_CORE_TEST_MODE: '1', MUSIC_BRIDGE_TEST_KEYCHAIN_MODE: 'mock', MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR: profile })
  const app = await electron.launch({ executablePath: path.join(identity.packageRoot, 'dist/Electron.app/Contents/MacOS/Electron'), args: testElectronArguments([path.join(desktop, 'dist/main/index.js')], 'mock'), cwd: desktop, env })
  processes.set(app, app.process())
  const observed = new WeakSet<Page>()
  const observe = (page: Page) => { if (!observed.has(page)) { observed.add(page); page.on('pageerror', cause => errors.push(cause.message)) } }
  app.on('window', observe); for (const page of app.windows()) observe(page)
  return app
}

async function closeNormally(app: ElectronApplication, closes: unknown[]): Promise<void> {
  const child = processes.get(app); if (!child) throw new Error('未捕获013原App子进程身份。')
  const closed = child.exitCode === null && child.signalCode === null
    ? new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('close', (exitCode, signal) => resolve({ exitCode, signal })))
    : Promise.resolve({ exitCode: child.exitCode, signal: child.signalCode })
  await app.close(); const result = await closed; closes.push({ pid: child.pid, ...result }); expect(result).toEqual({ exitCode: 0, signal: null })
}

async function auditOffline(app: ElectronApplication, observations: unknown[]): Promise<void> {
  const value = await app.evaluate(() => (globalThis as typeof globalThis & { __musicBridgeUiE2eNetworkEvidence?: { installedBeforeWindow: boolean; blockedExternalAttempts: number; blockedHosts: string[] } }).__musicBridgeUiE2eNetworkEvidence)
  expect(value?.installedBeforeWindow).toBe(true); expect(value?.blockedExternalAttempts).toBe(0); expect(value?.blockedHosts).toEqual([]); observations.push(value)
}

/** 仅控制原生目录选择结果；协议、网络guard、Core能力和文件处理都沿生产入口。 */
async function ownDirectoryPicker(app: ElectronApplication, directory: string): Promise<void> {
  await app.evaluate(({ dialog }, directory) => {
    const state = globalThis as typeof globalThis & { __ownedRelocationPickerCalls: number; __ownedRelocationDialogResult?: Promise<{ canceled: boolean; filePaths: string[] }> }
    state.__ownedRelocationPickerCalls = 0
    dialog.showOpenDialog = ((...args: unknown[]) => {
      const options = args.at(-1) as { properties?: string[] }
      if (!options.properties?.includes('openDirectory')) throw new Error('013自有用例只选择目录，不替换文件或凭据入口。')
      state.__ownedRelocationPickerCalls++
      state.__ownedRelocationDialogResult = Promise.resolve({ canceled: false, filePaths: [directory] })
      return state.__ownedRelocationDialogResult
    }) as typeof dialog.showOpenDialog
  }, directory)
}
async function pickerCalls(app: ElectronApplication): Promise<number> {
  return app.evaluate(() => (globalThis as typeof globalThis & { __ownedRelocationPickerCalls: number }).__ownedRelocationPickerCalls)
}
async function library(page: Page): Promise<Locator> {
  await page.locator('[data-sidebar-source="local-library"]').click()
  const view = page.getByTestId('local-library-view'); await expect(view).toBeVisible(); return view
}
async function detail(page: Page, trackId: string): Promise<Locator> {
  const view = await library(page), trigger = view.locator(`[data-local-detail-track="${trackId}"]`)
  await expect(trigger).toHaveCount(1); await trigger.click()
  const current = view.locator('.local-track-detail'); await expect(current).toBeVisible(); return current
}
async function readPlan(page: Page, planId: string): Promise<LocalRelocationPlan> {
  return page.evaluate(async planId => {
    const { datasetId } = await window.musicBridge.getCommandOutbox()
    const value = await window.musicBridge.localRelocationPlan('localRelocationPlan.get', { datasetId, selector: { kind: 'plan', planId } })
    if (value.kind !== 'plan' || value.planId !== planId || !value.plan || value.plan.planId !== planId) throw new Error('原搬迁计划暂未核实。')
    return value.plan
  }, planId)
}
async function history(page: Page) {
  return page.evaluate(async () => {
    const { datasetId } = await window.musicBridge.getCommandOutbox()
    const value = await window.musicBridge.localRelocationPlan('localRelocationPlan.history', { datasetId, selector: { kind: 'plans' }, cursor: null, limit: 100 })
    if (value.kind !== 'plans' || value.hasMore) throw new Error('自有013用例的完整历史超出当前页，不能截取证明。')
    return value.items
  })
}
async function waitPlan(page: Page, planId: string, state: 'READY' | 'BLOCKED' | 'SOURCE_RETAINED' | 'COMPLETED', cleanupFrom?: LocalRelocationPlan): Promise<LocalRelocationPlan> {
  let last: LocalRelocationPlan | undefined
  await expect.poll(async () => {
    last = await readPlan(page, planId)
    if (state === 'COMPLETED' && cleanupFrom && last.state === 'SOURCE_RETAINED' && last.cleanup.state === 'eligible' && last.cleanup.issue === null && last.issues.length === 0) {
      const { viewRevision, journalSequence, ...body } = last
      const { viewRevision: originalView, journalSequence: originalSequence, ...originalBody } = cleanupFrom
      const advance = BigInt(viewRevision) - BigInt(originalView)
      // 原快照及单次 challenge 只推进修订的窗口仍待执行；其它终态和 issue 立即保留失败。
      if ((advance === 0n || advance === 1n) && BigInt(journalSequence) - BigInt(originalSequence) === advance && isDeepStrictEqual(body, originalBody)) return false
    }
    return last.state === state || ['BLOCKED', 'DEFERRED', 'PARTIAL', 'FAILED', 'CANCELLED', 'RECOVERY_REQUIRED', 'SOURCE_RETAINED', 'COMPLETED'].includes(last.state)
  }, { timeout: 45_000 }).toBe(true)
  expect(last?.state, JSON.stringify(last && { state: last.state, viewRevision: last.viewRevision, journalSequence: last.journalSequence, cleanup: last.cleanup, issues: last.issues, resources: last.resources })).toBe(state)
  return last!
}
async function preview(page: Page, dialog: Locator, state: 'READY' | 'BLOCKED'): Promise<LocalRelocationPlan> {
  const before = new Set((await history(page)).map(value => value.planId))
  await dialog.getByRole('button', { name: '预览具体搬迁计划', exact: true }).click()
  let planId = ''
  await expect.poll(async () => { const fresh = (await history(page)).filter(value => !before.has(value.planId)); if (fresh.length === 1) planId = fresh[0]!.planId; return fresh.length }, { timeout: 20_000 }).toBe(1)
  const value = await waitPlan(page, planId, state)
  const confirm = dialog.getByRole('button', { name: '确认这份搬迁计划', exact: true })
  if (state === 'READY') await expect(confirm).toBeEnabled(); else await expect(confirm).toBeDisabled()
  return value
}
function preservedTrack(before: LocalLibraryTrackDetail, after: LocalLibraryTrackDetail): void {
  expect(after.track).toEqual(before.track)
  for (const key of ['id', 'fileRevision', 'sampleFrames', 'timebaseHz'] as const) expect(after.asset[key]).toBe(before.asset[key])
  expect(after.metadata.raw).toEqual(before.metadata.raw); expect(after.metadata.override).toEqual(before.metadata.override); expect(after.metadata.effective).toEqual(before.metadata.effective)
  expect(after.editions).toEqual(before.editions); expect(after.versionTokens).toEqual(before.versionTokens)
}
function publicBoundary(value: unknown, source: string, target: string): void {
  const text = JSON.stringify(value)
  expect(text).not.toContain(source); expect(text).not.toContain(target)
  for (const key of ['absolutePath', 'grant', 'fd', 'ownerEpoch', 'nonce', 'signature', 'readFacts', 'actor']) expect(text).not.toContain(`"${key}":`)
}
/** 所有作者自然关闭后，只读附加真实自有SQLite；空历史明确不能替代非空历史验证。 */
async function closedCatalog(profile: string, trackId: string, assetId: string) {
  const file = path.join(profile, 'data/collection.v1.sqlite')
  for (const suffix of ['-wal', '-shm']) await expect(lstat(file + suffix)).rejects.toMatchObject({ code: 'ENOENT' })
  const before = await readIdentity(file), uri = pathToFileURL(file); uri.search = '?mode=ro&immutable=1'
  const db = new DatabaseSync(':memory:', { allowExtension: false })
  try {
    db.prepare('ATTACH DATABASE ? AS owned').run(uri.href)
    const sourceBindings = db.prepare('SELECT id,hex(CAST(data AS BLOB)) AS dataUtf8Hex FROM owned.source_bindings ORDER BY id').all()
    const asset = db.prepare('SELECT id,root_id,source_root_id,relative,sha256,data FROM owned.local_catalog_assets WHERE id=?').get(assetId)
    const track = db.prepare('SELECT id,asset_id,data FROM owned.local_catalog_tracks WHERE id=?').get(trackId)
    expect(asset?.id).toBe(assetId); expect(track?.id).toBe(trackId); expect(track?.asset_id).toBe(assetId)
    return { sourceBindings, asset, track }
  } finally {
    db.close(); expect(await readIdentity(file)).toEqual(before)
    for (const suffix of ['-wal', '-shm']) await expect(lstat(file + suffix)).rejects.toMatchObject({ code: 'ENOENT' })
  }
}

/** 默认OFF没有plan；自然关闭后读取同Owner库原始receipt，并严格绑定完整请求。 */
async function closedOffPreview(profile: string, datasetId: string, original: LocalLibraryTrackDetail) {
  const file = path.join(profile, 'data/collection.v1.sqlite')
  for (const suffix of ['-wal', '-shm']) await expect(lstat(file + suffix)).rejects.toMatchObject({ code: 'ENOENT' })
  const before = await readIdentity(file), uri = pathToFileURL(file); uri.search = '?mode=ro&immutable=1'
  const db = new DatabaseSync(':memory:', { allowExtension: false })
  try {
    db.prepare('ATTACH DATABASE ? AS owned').run(uri.href)
    const rows = db.prepare('SELECT command_id,fingerprint,operation,request,result,created_at FROM owned.local_catalog_ledger WHERE operation=? ORDER BY rowid').all('LOCAL_RELOCATION_V1')
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.operation).toBe('LOCAL_RELOCATION_V1'); expect(typeof row.request).toBe('string')
    const event = dto.localRelocationDataSnapshot(JSON.parse(String(row.request)))
    if (!dto.localRelocationRecord(event, ['version', 'eventId', 'datasetId', 'planId', 'occurredAt', 'eventHash', 'kind', 'command', 'request', 'requestFingerprint', 'receipt', 'header', 'ownerEpoch'])) throw new Error('OFF原receipt事件闭集无效。')
    expect(event.version).toBe(1); expect(event.kind).toBe('receipt'); expect(event.command).toBe('localRelocationPlan.preview')
    expect(event.datasetId).toBe(datasetId); expect(event.planId).toBeNull(); expect(event.header).toBeNull()
    expect(dto.isCollectionId(event.eventId)).toBe(true); expect(dto.isCollectionId(event.ownerEpoch)).toBe(true)
    expect(dto.isLocalRelocationPlanDate(event.occurredAt)).toBe(true); expect(dto.isLocalRelocationPlanHash(event.eventHash)).toBe(true)
    const request = dto.localRelocationPlanCommandSnapshot('localRelocationPlan.preview', event.request)
    expect(request).toEqual({ datasetId, commandId: request.commandId, intent: { kind: 'rename', target: { assetId: original.asset.id, expectedFileRevision: original.asset.fileRevision, expectedLocationRevision: original.asset.locationRevision, expectedRootRevision: original.asset.rootRevision }, newName: 'owned-disabled.wav', sourceDisposition: 'RETAIN' } })
    const requestFingerprint = sha(Buffer.from(dto.localRelocationRequestFingerprintInput('localRelocationPlan.preview', request), 'utf8'))
    expect(event.requestFingerprint).toBe(requestFingerprint); expect(row.command_id).toBe(request.commandId); expect(row.fingerprint).toBe(requestFingerprint)
    const receipt = dto.localRelocationPlanCommandResultSnapshot('localRelocationPlan.preview', event.receipt)
    expect(receipt.datasetId).toBe(datasetId); expect(receipt.commandId).toBe(request.commandId); expect(receipt.command).toBe('localRelocationPlan.preview'); expect(receipt.requestFingerprint).toBe(requestFingerprint)
    expect(receipt.outcome).toBe('rejected'); expect(receipt.planId).toBeNull(); expect(receipt.jobId).toBeNull(); expect(receipt.policy).toBeNull(); expect(receipt.issue?.code).toBe('POLICY_DISABLED')
    const { eventHash, ...body } = event
    expect(eventHash).toBe(sha(Buffer.from(`LOCAL_RELOCATION_V1\nJOURNAL\n${dto.localRelocationCanonical(body)}`, 'utf8')))
    expect(row.request).toBe(dto.localRelocationCanonical(event)); expect(row.result).toBe(dto.localRelocationCanonical({ version: 1, eventId: event.eventId, eventHash })); expect(row.created_at).toBe(event.occurredAt)
    return { ledger: row, event, request, requestFingerprint, receipt, databaseBefore: before }
  } finally {
    db.close(); expect(await readIdentity(file)).toEqual(before)
    for (const suffix of ['-wal', '-shm']) await expect(lstat(file + suffix)).rejects.toMatchObject({ code: 'ENOENT' })
  }
}

test('013生产离线自有WAVE与歌词：默认OFF、完整具体预览、源保留、独立目标回读、具体清理和冷启动', async () => {
  test.setTimeout(240_000)
  const run = await mkdtemp(path.join(e2eTemporaryRoot(), 'mbrs013-relocation-')), material = await ownedMaterial(run)
  const before = await Promise.all(material.manifest.map(async value => ({ file: value.file, ...await readIdentity(path.join(material.source, value.file)) })))
  for (const value of before) { const original = material.manifest.find(file => file.file === value.file)!; expect(value.bytes).toBe(original.bytes); expect(value.sha256).toBe(original.sha256) }
  await writeFile(path.join(run, 'pre-app-baselines.json'), JSON.stringify({ schema: 'mbrs013.owned-app-prepublication.v1', baselines: before, targetGenuineAbsence: await readdir(material.target), originalMaterialCapturedBeforeFirstApp: true }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  const errors: string[] = [], closes: unknown[] = [], networks: unknown[] = [], plans = new Map<string, LocalRelocationPlan>()
  const facts: Record<string, unknown> = {}, cleanupFailures: unknown[] = []
  let app: ElectronApplication | null = null, completed = false, failure: unknown
  try {
    app = await launch(material.profile, errors); let page = await waitForMainWindow(app), view = await library(page)
    const management = view.locator('.local-library-management'); await management.locator(':scope > summary').click()
    await ownDirectoryPicker(app, material.source)
    await management.getByRole('button', { name: '授权源目录并加入音乐库', exact: true }).click()
    await management.getByRole('button', { name: '增量扫描', exact: true }).click()
    await expect(management.getByRole('list', { name: '扫描任务' })).toContainText('已完成', { timeout: 45_000 })
    await view.getByRole('button', { name: '刷新', exact: true }).click()
    await expect(view.locator('.local-results-summary')).toContainText('1 首', { timeout: 10_000 })
    const rows = await page.evaluate(() => window.musicBridge.queryLocalLibraryTracks({ query: '', rootId: null, offset: 0, limit: 100 }))
    expect(rows.items).toHaveLength(1)
    const trackId = rows.items[0]!.track.id, assetId = rows.items[0]!.asset.id
    let current = await detail(page, trackId)
    await current.getByLabel('仅修改 MB 显示名称', { exact: true }).fill('013 自有 MB 显示更正')
    await current.getByRole('button', { name: '保存显示更正', exact: true }).click(); await expect(current).toContainText('013 自有 MB 显示更正')
    const original = await page.evaluate(trackId => window.musicBridge.getLocalLibraryTrackDetail(trackId), trackId)
    const context = await page.evaluate(async () => { const { datasetId } = await window.musicBridge.getCommandOutbox(); const value = await window.musicBridge.localRelocationPlan('localRelocationPlan.get', { datasetId, selector: { kind: 'context' } }); if (value.kind !== 'context') throw new Error('013实际资格context类型无效。'); return value })
    expect(context.policy.enabled).toBe(false); expect(context.qualification.state, '需要真实Core资格证明；不得用临时toggle或假DTO放行App用例。').toBe('qualified')
    expect(context.qualification.proofFingerprint).toMatch(/^[a-f0-9]{64}$/u); facts.actualContextBefore = context
    await current.getByRole('button', { name: '预览此源文件改名', exact: true }).click()
    let dialog = page.getByRole('dialog', { name: '文件搬迁与重关联', exact: true }); await expect(dialog).toBeVisible()
    await dialog.getByRole('textbox', { name: '搬迁新文件名', exact: true }).fill('owned-disabled.wav')
    expect(await history(page)).toEqual([])
    await dialog.getByRole('button', { name: '预览具体搬迁计划', exact: true }).click()
    await expect(dialog).toContainText('文件搬迁开关已关闭；可继续读取计划与历史。')
    expect(await history(page)).toEqual([])
    await expect(dialog.getByRole('button', { name: '确认这份搬迁计划', exact: true })).toHaveCount(0)
    for (const value of before) { const { file, ...identity } = value; expect(await readIdentity(path.join(material.source, file))).toEqual(identity) }
    await expect(lstat(path.join(material.source, 'owned-disabled.wav'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(material.target)).toEqual([]); await page.screenshot({ path: path.join(run, 'policy-off-blocked.png') })
    await dialog.getByRole('button', { name: '关闭文件搬迁', exact: true }).click()
    await auditOffline(app, networks); await closeNormally(app, closes); app = null
    const baseline = await closedCatalog(material.profile, trackId, assetId); expect(baseline.sourceBindings).toEqual([]); facts.closedBaseline = baseline
    const off = await closedOffPreview(material.profile, context.datasetId, original); facts.policyOffOriginalReceipt = off
    publicBoundary({ request: off.request, receipt: off.receipt }, material.source, material.target)

    app = await launch(material.profile, errors); page = await waitForMainWindow(app)
    const coldOff = dto.localRelocationPlanCommandResultSnapshot('localRelocationPlan.get', await page.evaluate(async binding => window.musicBridge.localRelocationPlan('localRelocationPlan.get', { datasetId: binding.datasetId, selector: { kind: 'command', commandId: binding.commandId, expectedCommand: 'localRelocationPlan.preview', requestFingerprint: binding.requestFingerprint } }), { datasetId: off.request.datasetId, commandId: off.request.commandId, requestFingerprint: off.requestFingerprint }))
    if (coldOff.kind !== 'command') throw new Error('冷启动OFF原命令查询类型无效。')
    expect(coldOff.datasetId).toBe(off.request.datasetId); expect(coldOff.commandId).toBe(off.request.commandId); expect(coldOff.expectedCommand).toBe('localRelocationPlan.preview'); expect(coldOff.requestFingerprint).toBe(off.requestFingerprint)
    expect(coldOff.issue).toBeNull(); expect(coldOff.receipt).toEqual(off.receipt); expect(await history(page)).toEqual([]); facts.policyOffColdOriginalQuery = coldOff
    for (const value of before) { const { file, ...identity } = value; expect(await readIdentity(path.join(material.source, file))).toEqual(identity) }
    await expect(lstat(path.join(material.source, 'owned-disabled.wav'))).rejects.toMatchObject({ code: 'ENOENT' }); expect(await readdir(material.target)).toEqual([])
    await page.getByRole('button', { name: '打开设置', exact: true }).click(); await page.getByRole('tab', { name: '应用', exact: true }).click()
    const settings = page.getByRole('region', { name: '具体文件搬迁设置', exact: true }), enabled = settings.getByRole('checkbox', { name: '允许具体文件搬迁', exact: true })
    await expect(enabled).not.toBeChecked(); await expect(enabled).toBeEnabled(); await enabled.check(); await expect(enabled).toBeChecked(); await expect(settings).toContainText('搬迁开关已保存。')
    current = await detail(page, trackId); await current.getByRole('button', { name: '预览此源文件移动', exact: true }).click()
    dialog = page.getByRole('dialog', { name: '文件搬迁与重关联', exact: true }); await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('combobox', { name: '搬迁源材料处理', exact: true })).toHaveValue('RETAIN')
    await ownDirectoryPicker(app, material.target); await dialog.getByRole('button', { name: '选择搬迁目标目录', exact: true }).click()
    const ready = await preview(page, dialog, 'READY'); plans.set(ready.planId, ready)
    expect(ready.domain).toBe('LOCAL_RELOCATION_V1'); expect(ready.intent.kind).toBe('move'); expect(ready.sourceDisposition).toBe('RETAIN')
    expect(ready.closure.complete).toBe(true); expect(ready.closure.operationCount).toBe(1); expect(ready.closure.resourceCount).toBe(2); expect(ready.closure.referenceEdgeCount).toBe(1)
    expect(ready.closure.totalSourceBytes).toBe(String(material.manifest.reduce((sum, value) => sum + value.bytes, 0)))
    expect(ready.resources.map(value => value.role).sort()).toEqual(['AUDIO', 'LYRIC']); expect(ready.items).toHaveLength(1)
    expect(ready.items[0]!.assetId).toBe(assetId); expect(ready.items[0]!.trackIds).toEqual([trackId]); expect(new Set(ready.resources.map(value => value.resourceId)).size).toBe(2)
    publicBoundary(ready, material.source, material.target)
    for (const value of before) { const { file, ...identity } = value; expect(await readIdentity(path.join(material.source, file))).toEqual(identity) }
    expect(await readdir(material.target)).toEqual([]); await expect(dialog.locator('tbody tr[data-relocation-resource-id]')).toHaveCount(2)
    await page.screenshot({ path: path.join(run, 'move-ready-complete-closure.png') }); const choices = await pickerCalls(app); expect(choices).toBe(1)
    await dialog.getByRole('button', { name: '确认这份搬迁计划', exact: true }).click()
    const retained = await waitPlan(page, ready.planId, 'SOURCE_RETAINED'); plans.set(retained.planId, retained)
    expect(retained.planHash).toBe(ready.planHash); expect(retained.contextFingerprint).toBe(ready.contextFingerprint)
    expect(retained.resources.map(value => value.resourceId)).toEqual(ready.resources.map(value => value.resourceId)); expect(retained.items[0]!.operationId).toBe(ready.items[0]!.operationId)
    expect(retained.cleanup.state).toBe('eligible'); expect(retained.cleanup.sourceResourceIds.slice().sort()).toEqual(retained.resources.map(value => value.resourceId).sort())
    const targetBeforeCleanup = []
    for (const value of before) {
      const { file, ...identity } = value, copied = await readIdentity(path.join(material.target, file))
      expect(await readIdentity(path.join(material.source, file))).toEqual(identity); expect(copied.bytes).toBe(value.bytes); expect(copied.sha256).toBe(value.sha256)
      expect(`${copied.dev}:${copied.ino}`).not.toBe(`${value.dev}:${value.ino}`); expect(copied.mode).toBe(value.mode); expect(copied.uid).toBe(value.uid); expect(copied.gid).toBe(value.gid)
      targetBeforeCleanup.push({ file, ...copied })
    }
    const moved = await page.evaluate(trackId => window.musicBridge.getLocalLibraryTrackDetail(trackId), trackId); preservedTrack(original, moved)
    expect(BigInt(moved.asset.locationRevision)).toBeGreaterThan(BigInt(original.asset.locationRevision)); expect(moved.asset.sourceRootId).not.toBe(original.asset.sourceRootId); expect(moved.asset.libraryRootId).not.toBe(original.asset.libraryRootId)
    await dialog.getByRole('button', { name: '重新读取搬迁结果', exact: true }).click(); await expect(dialog).toContainText('目标已登记，源材料保留')
    expect(await pickerCalls(app)).toBe(choices); await page.screenshot({ path: path.join(run, 'target-verified-source-retained.png') })
    const cleanup = dialog.getByRole('button', { name: '清理这份已验证计划的源副本', exact: true }); await expect(cleanup).toBeEnabled(); await cleanup.click()
    const cleaned = await waitPlan(page, ready.planId, 'COMPLETED', retained); plans.set(cleaned.planId, cleaned)
    expect(cleaned.cleanup.state).toBe('completed'); expect(cleaned.resources.every(value => value.sourceHandling === 'removed' && value.state === 'cleaned' && value.verification === 'verified-target')).toBe(true)
    await expect(dialog).toContainText('本次具体清理已完成')
    for (const value of before) await expect(lstat(path.join(material.source, value.file))).rejects.toMatchObject({ code: 'ENOENT' })
    for (const value of targetBeforeCleanup) { const { file, ...identity } = value; expect(await readIdentity(path.join(material.target, file))).toEqual(identity) }
    expect(await pickerCalls(app)).toBe(choices)
    const afterCleanup = await page.evaluate(trackId => window.musicBridge.getLocalLibraryTrackDetail(trackId), trackId); expect(afterCleanup.track).toEqual(moved.track); expect(afterCleanup.asset).toEqual(moved.asset); preservedTrack(original, afterCleanup)
    const outbox = await page.evaluate(() => window.musicBridge.getCommandOutbox()); expect(outbox.entries.filter(value => value.command.startsWith('localRelocationPlan.'))).toEqual([])
    publicBoundary(cleaned, material.source, material.target); await page.screenshot({ path: path.join(run, 'specific-cleanup-completed.png') })
    facts.original = original; facts.moved = moved; facts.afterCleanup = afterCleanup; facts.targetBeforeCleanup = targetBeforeCleanup; facts.pickerCallsAtFinalConfirmAndCleanup = choices
    await dialog.getByRole('button', { name: '关闭文件搬迁', exact: true }).click(); await auditOffline(app, networks); await closeNormally(app, closes); app = null
    const closedAfterCleanup = await closedCatalog(material.profile, trackId, assetId)
    expect(closedAfterCleanup.sourceBindings).toEqual(baseline.sourceBindings); expect(closedAfterCleanup.track).toEqual(baseline.track)
    expect(closedAfterCleanup.asset?.relative).toBe('owned-original.wav'); expect(closedAfterCleanup.asset?.sha256).toBe(baseline.asset?.sha256); facts.closedAfterCleanup = closedAfterCleanup

    app = await launch(material.profile, errors); page = await waitForMainWindow(app); view = await library(page)
    const cold = await page.evaluate(trackId => window.musicBridge.getLocalLibraryTrackDetail(trackId), trackId); expect(cold.track).toEqual(moved.track); expect(cold.asset).toEqual(moved.asset); preservedTrack(original, cold)
    expect(await readPlan(page, ready.planId)).toEqual(cleaned)
    await view.getByRole('button', { name: '搬迁历史与恢复', exact: true }).click(); dialog = page.getByRole('dialog', { name: '文件搬迁与重关联', exact: true })
    const recorded = dialog.locator(`[data-relocation-plan-id="${ready.planId}"]`); await expect(recorded).toHaveCount(1); await recorded.getByRole('button', { name: `查看搬迁计划 ${ready.planId}`, exact: true }).click()
    await expect(dialog).toContainText('本次具体清理已完成'); await expect(dialog.locator('tbody tr[data-relocation-resource-id]')).toHaveCount(2)
    for (const value of targetBeforeCleanup) { const { file, ...identity } = value; expect(await readIdentity(path.join(material.target, file))).toEqual(identity) }
    const finalHistory = await history(page); expect(finalHistory).toHaveLength(1); expect(finalHistory[0]!.planId).toBe(ready.planId); facts.cold = cold; facts.finalHistory = finalHistory
    await page.screenshot({ path: path.join(run, 'cold-original-plan-and-track.png') }); await auditOffline(app, networks); await closeNormally(app, closes); app = null
    const closedCold = await closedCatalog(material.profile, trackId, assetId); expect(closedCold.sourceBindings).toEqual(baseline.sourceBindings); expect(closedCold.track).toEqual(baseline.track); facts.closedCold = closedCold
    expect(errors).toEqual([]); expect(closes).toHaveLength(3); expect(new Set(closes.map(value => (value as { pid: number }).pid)).size).toBe(3); expect(networks).toHaveLength(3)
    completed = true
  } catch (cause) { failure = cause }
  finally {
    if (app) {
      try { await auditOffline(app, networks) } catch (cause) { cleanupFailures.push({ stage: '最后网络核对', error: cause instanceof Error ? cause.message : String(cause) }) }
      try { await closeNormally(app, closes) } catch (cause) { cleanupFailures.push({ stage: '最后正常关闭', error: cause instanceof Error ? cause.message : String(cause) }) }
    }
    const receipt = { schema: 'mbrs013.owned-production-relocation-app.v1', completed, allContentOwned: true, synthetic: true, nativeDirectoryDialogControlled: true, productionMainCoreScannerAndFilesystemUsed: !!facts.moved, qualificationOverrideUsed: false, sourceBindingsNonemptyHistoryProven: false, sourceBindingsHistoryBoundary: '本自有WAVE未建立非空录音历史；非空SourceBinding保留由独立Core集成验证，不借用014旧fixture。', realProvider: 'NOT_RUN', roonDelivery: 'NOT_RUN', realAudio: 'NOT_RUN', crossVolume: 'NOT_RUN', ownerAcceptance: 'NOT_RUN', manifest: material.manifest, before, plans: [...plans.values()], facts, closes, networks, pageErrors: errors, cleanupFailures, failure: failure instanceof Error ? { name: failure.name, message: failure.message, stack: failure.stack } : failure ?? null }
    await writeFile(path.join(run, completed && cleanupFailures.length === 0 ? 'receipt.json' : 'failure.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  }
  if (failure) throw failure
  expect(cleanupFailures).toEqual([]); expect(completed).toBe(true)
})
