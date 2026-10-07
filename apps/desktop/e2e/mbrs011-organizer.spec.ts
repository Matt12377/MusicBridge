import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { LocalOrganizerPlan } from '@music-bridge/contracts'
import { verifiedElectronExecution } from '../scripts/electron-identity.mjs'
import { testElectronArguments } from '../scripts/test-keychain.mjs'
import { e2eTemporaryRoot } from './temporary-root.js'
import { waitForMainWindow } from './main-window.js'

const desktopRoot = path.resolve(import.meta.dirname, '..'), sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
/** 自有、非零双声道PCM与RIFF INFO；扫描、IPC和业务作者使用生产实现。 */
function wave(title: string): Buffer {
  const pcm = Buffer.alloc(1024 * 4)
  for (let n = 0; n < 1024; n++) { pcm.writeInt16LE((n % 31) * 107 + 1, n * 4); pcm.writeInt16LE(-((n % 19) * 113 + 1), n * 4 + 2) }
  const info = Object.entries({ INAM: title, IART: '011 Synthetic Artist', IPRD: '011 Synthetic Album', ICRD: '2000' }).flatMap(([key, value]) => { const bytes = Buffer.from(value + '\0'), header = Buffer.alloc(8); header.write(key); header.writeUInt32LE(bytes.length, 4); return [header, bytes, Buffer.alloc(bytes.length % 2)] })
  const listBody = Buffer.concat([Buffer.from('INFO'), ...info]), list = Buffer.alloc(8); list.write('LIST'); list.writeUInt32LE(listBody.length, 4)
  const format = Buffer.alloc(24); format.write('fmt '); format.writeUInt32LE(16, 4); format.writeUInt16LE(1, 8); format.writeUInt16LE(2, 10); format.writeUInt32LE(44100, 12); format.writeUInt32LE(44100 * 4, 16); format.writeUInt16LE(4, 20); format.writeUInt16LE(16, 22)
  const data = Buffer.alloc(8); data.write('data'); data.writeUInt32LE(pcm.length, 4)
  const body = Buffer.concat([Buffer.from('WAVE'), format, data, pcm, list, listBody]), riff = Buffer.alloc(8); riff.write('RIFF'); riff.writeUInt32LE(body.length, 4)
  return Buffer.concat([riff, body])
}
async function plans(page: Page): Promise<LocalOrganizerPlan[]> {
  return page.evaluate(async () => { const history = await window.musicBridge.listLocalOrganizerHistory({ offset: 0, limit: 100 }); return Promise.all(history.items.map(item => window.musicBridge.getLocalOrganizerPlan({ planId: item.planId }))) })
}
async function networkEvidence(app: ElectronApplication) {
  return app.evaluate(() => (globalThis as typeof globalThis & { __musicBridgeUiE2eNetworkEvidence?: { installedBeforeWindow: boolean; blockedExternalAttempts: number; blockedHosts: string[] } }).__musicBridgeUiE2eNetworkEvidence)
}
interface PersistedOrganizerCommand { commandId: string; command: string; datasetId: string; fingerprint: string; state: string; acknowledged: boolean }
/** 仅在原应用正常退出后读取Main持久账本；ACK会从公开的未确认列表隐藏成功项。 */
async function persistedOrganizerCommands(profile: string): Promise<PersistedOrganizerCommand[]> {
  const file = path.join(profile, 'data/command-outbox.v1.sqlite'), before = sha256(await readFile(file))
  const db = new DatabaseSync(file, { readOnly: true, allowExtension: false })
  let values: PersistedOrganizerCommand[]
  try {
    const rows = db.prepare('SELECT e.request_json,s.state,s.acknowledged FROM outbox_entries e JOIN outbox_states s ON s.id=e.id ORDER BY e.command_id').all()
    values = rows.flatMap(row => {
      const request = JSON.parse(String(row.request_json)) as { commandId: string; command: string; datasetId: string; fingerprint: string }
      return request.command.startsWith('localOrganizer.') ? [{ commandId: request.commandId, command: request.command, datasetId: request.datasetId, fingerprint: request.fingerprint, state: String(row.state), acknowledged: row.acknowledged === 1 }] : []
    })
  } finally { db.close() }
  expect(sha256(await readFile(file))).toBe(before)
  return values
}
async function closeWithEvidence(app: ElectronApplication) {
  const child = app.process()
  const exited = child.exitCode !== null ? Promise.resolve({ code: child.exitCode, signal: child.signalCode }) : new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
  await app.close(); return exited
}

test('011生产离线App：单曲/具体发行/跨搜索批量/撤销预览，增量扫描与重启保留且源SHA不变', async () => {
  test.setTimeout(180_000)
  const temporaryRoot = e2eTemporaryRoot(), run = await mkdtemp(path.join(temporaryRoot, 'mbrs011-organizer-')), profile = await mkdtemp(path.join(temporaryRoot, 'musicbridge-ui-e2e-011-')), source = path.join(run, 'synthetic-audio')
  await mkdir(source)
  const titles = ['011 Studio A', '011 Studio B', '011 Live A', '011 Remaster A'], before: Record<string, string> = {}, after: Record<string, string> = {}, exits: Awaited<ReturnType<typeof closeWithEvidence>>[] = [], networks: Awaited<ReturnType<typeof networkEvidence>>[] = [], pageErrors: string[] = [], milestones: string[] = []
  for (const title of titles) { const filename = `${title}.wav`, bytes = wave(title); await writeFile(path.join(source, filename), bytes, { flag: 'wx', mode: 0o600 }); before[filename] = sha256(bytes) }
  const identity = verifiedElectronExecution(), env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !/^(MUSIC_BRIDGE_|NETEASE_|ROON_)/u.test(key))) as Record<string, string>
  Object.assign(env, { MUSIC_BRIDGE_UI_E2E: '1', MUSIC_BRIDGE_UI_E2E_OFFLINE: '1', MUSIC_BRIDGE_CORE_TEST_MODE: '1', MUSIC_BRIDGE_TEST_KEYCHAIN_MODE: 'mock', MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR: profile })
  const launch = () => electron.launch({ executablePath: path.join(identity.packageRoot, 'dist', 'Electron.app/Contents/MacOS/Electron'), args: testElectronArguments([path.join(desktopRoot, 'dist/main/index.js')], 'mock'), cwd: desktopRoot, env })
  let persistedBefore: PersistedOrganizerCommand[] = [], persistedAfter: PersistedOrganizerCommand[] = []
  let app: ElectronApplication | null = null, completed = false, finalPlans: LocalOrganizerPlan[] = [], originalTrackIds: string[] = [], selectedEditionId = '', otherEditionId = '', batchPlanId = '', undoPlanId = ''
  try {
    app = await launch(); let page = await waitForMainWindow(app); page.on('pageerror', error => pageErrors.push(error.message))
    await page.locator('[data-sidebar-source="local-library"]').click(); let view = page.getByTestId('local-library-view')
    await expect(view.getByText('本地音乐库还没有曲目', { exact: true })).toBeVisible()
    await view.locator('.local-library-management > summary').click()
    // 唯一替换为本次隔离自有目录的原生picker回执；不替换业务或IPC。
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [selected] })) as typeof dialog.showOpenDialog }, source)
    await view.getByRole('button', { name: '授权源目录并加入音乐库', exact: true }).click(); await expect(view.getByRole('button', { name: '增量扫描', exact: true })).toBeEnabled(); await view.getByRole('button', { name: '增量扫描', exact: true }).click()
    await expect(view.getByRole('list', { name: '扫描任务' })).toContainText('已完成', { timeout: 45_000 }); await expect(view.locator('.local-results-summary')).toContainText('4 首', { timeout: 10_000 }); await view.locator('.local-library-management > summary').click()
    const scanned = await page.evaluate(() => window.musicBridge.queryLocalLibraryTracks({ query: '', rootId: null, offset: 0, limit: 100 })); expect(scanned.items).toHaveLength(4); originalTrackIds = scanned.items.map(item => item.track.id).sort()
    const studio = scanned.items.find(item => item.metadata.title === '011 Studio A')!, secondStudio = scanned.items.find(item => item.metadata.title === '011 Studio B')!; expect(studio).toBeDefined(); expect(secondStudio).toBeDefined()
    const rawBefore = await page.evaluate(async ids => Promise.all(ids.map(id => window.musicBridge.getLocalLibraryMetadata(id))), originalTrackIds)
    milestones.push('真实Node只读扫描4个自有WAV')
    const search = view.getByRole('searchbox', { name: '搜索曲目、艺术家、专辑与已有版本', exact: true })
    await search.fill('011 Studio A'); await search.press('Enter'); await expect(view.locator('.local-results-summary')).toContainText('1 首')
    await view.getByRole('button', { name: '查看 011 Studio A 的版本与文件详情', exact: true }).click(); const detail = view.locator('.local-track-detail'), trigger = detail.getByRole('button', { name: '整理此曲目信息', exact: true }); await trigger.click()
    let organizer = page.locator('dialog.local-organizer-dialog'); await expect(organizer.locator('#local-organizer-title')).toBeFocused()
    await organizer.getByLabel('标题更正方式', { exact: true }).selectOption('set'); await organizer.getByLabel('标题更正值', { exact: true }).fill('011 MB Studio A'); await organizer.getByLabel('艺术家更正方式', { exact: true }).selectOption('set'); await organizer.getByLabel('艺术家更正值', { exact: true }).fill('')
    await organizer.getByLabel('版本说明更正方式', { exact: true }).selectOption('set'); await organizer.getByLabel('版本说明内容', { exact: true }).fill('自有Studio版本说明，保留独立发行身份')
    await organizer.getByRole('button', { name: '预览更正', exact: true }).click(); await expect(organizer.locator('.organizer-preview-item')).toHaveCount(1); await expect(organizer.getByRole('columnheader')).toHaveText(['字段', '原始标签', '当前人工更正', '当前生效值', '待保存生效值']); await expect(organizer).toContainText('空值')
    let snapshots = await plans(page); expect(snapshots).toHaveLength(1); expect(snapshots[0]!.state).toBe('DRAFT'); expect(snapshots[0]!.scope).toBe('MB_ONLY'); expect(snapshots[0]!.items.map(item => item.trackId)).toEqual([studio.track.id]); expect(snapshots[0]!.items[0]!.after.fields.artist).toBe('')
    const beforeConfirm = await page.evaluate(() => window.musicBridge.getCommandOutbox()); expect(beforeConfirm.entries.filter(entry => entry.command === 'localOrganizer.confirm')).toHaveLength(0)
    await page.screenshot({ path: test.info().outputPath('011-single-preview.png') }); await organizer.getByRole('button', { name: '保存这些更正', exact: true }).click(); await expect(organizer.locator('.organizer-preview-heading')).toContainText('已完成'); await expect(organizer.locator('.organizer-item-result')).toHaveText('已保存')
    await organizer.locator('#local-organizer-title').press('Escape'); await expect(organizer).toHaveCount(0); await expect(trigger).toBeFocused(); await expect(detail.getByRole('heading', { name: '011 MB Studio A', exact: true })).toBeVisible(); milestones.push('单曲具体预览后一次保存，空串与版本注记真实持久化，Esc返回焦点')

    // 从保留的010入口建立两个同名、彼此独立的发行；后续011只整理其中明确选择的一个。
    await detail.getByRole('button', { name: '选择封面', exact: true }).click(); const artwork = page.locator('dialog.local-artwork-dialog'); await artwork.getByLabel('独立发行名称', { exact: true }).fill('011 同名独立发行'); await artwork.getByRole('button', { name: '建立独立发行用于选图', exact: true }).click(); await expect(artwork).toContainText('独立发行已建立')
    await artwork.getByRole('button', { name: '建立另一独立发行', exact: true }).click(); await artwork.getByLabel('独立发行名称', { exact: true }).fill('011 同名独立发行'); await artwork.getByRole('button', { name: '建立独立发行用于选图', exact: true }).click(); await expect(artwork.getByLabel('所属独立发行').locator('option')).toHaveCount(2); await artwork.getByRole('button', { name: '关闭封面选图', exact: true }).click(); await view.getByRole('button', { name: '刷新', exact: true }).click()
    const linked = await page.evaluate(id => window.musicBridge.getLocalLibraryTrackDetail(id), studio.track.id); expect(linked.editions).toHaveLength(2); selectedEditionId = linked.editions[0]!.id; otherEditionId = linked.editions[1]!.id; expect(selectedEditionId).not.toBe(otherEditionId)
    await detail.getByRole('button', { name: new RegExp(`^整理具体发行 011 同名独立发行\\s+${selectedEditionId}$`, 'u') }).click(); organizer = page.locator('dialog.local-organizer-dialog'); await expect(organizer).toContainText(selectedEditionId.slice(-8))
    await organizer.getByLabel('艺术家更正方式', { exact: true }).selectOption('clear'); await organizer.getByLabel('版本说明更正方式', { exact: true }).selectOption('set'); await organizer.getByLabel('版本说明内容', { exact: true }).fill('只整理此次明确发行，不合并同名条目'); await organizer.getByLabel('分组建议更正方式', { exact: true }).selectOption('set'); await organizer.getByLabel('具体发行', { exact: true }).selectOption(otherEditionId); await organizer.getByLabel('建议理由', { exact: true }).fill('同名发行独立保留，人工建议另行辨认'); await organizer.getByRole('button', { name: '加入建议', exact: true }).click(); await organizer.getByRole('button', { name: '预览更正', exact: true }).click(); await expect(organizer.locator('.organizer-preview-item')).toHaveCount(1)
    snapshots = await plans(page); const editionPlan = snapshots.find(value => value.state === 'DRAFT')!; expect(editionPlan.editionBindings.some(value => value.editionId === selectedEditionId)).toBe(true); expect(editionPlan.items.map(item => item.trackId)).toEqual([studio.track.id]); expect(editionPlan.items[0]!.before.fields.artist).toBe(''); expect(editionPlan.items[0]!.after.fields.artist).toBeUndefined(); await expect(organizer).toContainText('恢复原始标签'); expect(editionPlan.items[0]!.after.annotations.groupingSuggestions).toEqual([{ editionId: otherEditionId, expectedRevision: linked.editions[1]!.revision, reason: '同名发行独立保留，人工建议另行辨认' }])
    await organizer.getByRole('button', { name: '保存这些更正', exact: true }).click(); await expect(organizer.locator('.organizer-preview-heading')).toContainText('已完成'); await organizer.getByRole('button', { name: '关闭信息整理', exact: true }).click(); const stillIndependent = await page.evaluate(id => window.musicBridge.getLocalLibraryTrackDetail(id), studio.track.id); expect(stillIndependent.editions.map(value => value.id).sort()).toEqual([selectedEditionId, otherEditionId].sort()); milestones.push('明确发行与revision/reason分组建议保存，不合并同名发行')

    await view.getByRole('button', { name: '选择曲目', exact: true }).click(); await view.getByRole('checkbox', { name: '选择 011 MB Studio A', exact: true }).check(); await search.fill('011 Studio B'); await search.press('Enter'); await expect(view.locator('.local-results-summary')).toContainText('1 首'); await view.getByRole('checkbox', { name: '选择 011 Studio B', exact: true }).check(); await expect(view.locator('.local-organizer-toolbar')).toContainText('已选 2 / 100 首')
    const table = view.getByRole('table', { name: '歌曲列表', exact: true }); await expect(table.getByRole('columnheader')).toHaveCount(4)
    const dimensions = await table.locator('.track-row:not(.track-row-placeholder)').first().evaluate(element => { const row = element.getBoundingClientRect(), actions = element.querySelector('.row-actions')!, leading = element.querySelector('.track-leading')!; return { rowHeight: row.height, leadingWidth: leading.getBoundingClientRect().width, buttons: actions.querySelectorAll('button').length } }); expect(Math.abs(dimensions.rowHeight - 84)).toBeLessThan(0.5); expect(dimensions.leadingWidth).toBeGreaterThanOrEqual(44); expect(dimensions.buttons).toBe(3)
    await view.getByRole('button', { name: '整理已选曲目', exact: true }).click(); organizer = page.locator('dialog.local-organizer-dialog'); await expect(organizer.getByLabel('标题更正方式', { exact: true })).toHaveValue('keep'); await expect(organizer.getByLabel('艺术家更正方式', { exact: true })).toHaveValue('keep')
    for (const [label, value] of [['专辑', '011 MB Batch Album'], ['年份', '2026'], ['碟号', '2'], ['曲序', '9']] as const) { await organizer.getByLabel(`${label}更正方式`, { exact: true }).selectOption('set'); await organizer.getByLabel(`${label}更正值`, { exact: true }).fill(value) }
    await organizer.getByRole('button', { name: '预览更正', exact: true }).click(); await expect(organizer.locator('.organizer-preview-item')).toHaveCount(2); snapshots = await plans(page); const batch = snapshots.find(value => value.state === 'DRAFT')!; batchPlanId = batch.planId; expect(batch.items.map(item => item.trackId).sort()).toEqual([studio.track.id, secondStudio.track.id].sort()); expect(batch.items.find(item => item.trackId === studio.track.id)?.after.fields.title).toBe('011 MB Studio A'); expect(batch.items.find(item => item.trackId === secondStudio.track.id)?.after.fields.title).toBeUndefined()
    await page.screenshot({ path: test.info().outputPath('011-batch-preview.png') }); await organizer.getByRole('button', { name: '保存这些更正', exact: true }).click(); await expect(organizer.locator('.organizer-preview-heading')).toContainText('已完成'); await expect(organizer.locator('.organizer-item-result')).toHaveText(['已保存', '已保存']); milestones.push('跨搜索选择2个真实identity，批量保持与四字段明确更正')
    const batchValues = await page.evaluate(async ids => Promise.all(ids.map(id => window.musicBridge.getLocalLibraryMetadata(id))), [studio.track.id, secondStudio.track.id])
    await organizer.getByRole('button', { name: '预览撤销', exact: true }).click(); await expect(organizer.getByRole('heading', { name: '预览撤销更正', exact: true })).toBeVisible(); snapshots = await plans(page); const reverse = snapshots.find(value => value.undoOf === batchPlanId)!; undoPlanId = reverse.planId; expect(reverse.state).toBe('DRAFT'); expect(reverse.items.map(item => item.after)).toEqual(batch.items.map(item => item.before)); expect(await page.evaluate(async ids => Promise.all(ids.map(id => window.musicBridge.getLocalLibraryMetadata(id))), [studio.track.id, secondStudio.track.id])).toEqual(batchValues)
    await page.screenshot({ path: test.info().outputPath('011-undo-preview.png') }); await organizer.getByRole('button', { name: '保存这些更正', exact: true }).click(); await expect(organizer.locator('.organizer-preview-heading')).toContainText('已完成'); snapshots = await plans(page); expect(snapshots.find(value => value.planId === batchPlanId)?.state).toBe('ROLLED_BACK'); expect(snapshots.find(value => value.planId === undoPlanId)?.state).toBe('COMPLETED'); await organizer.getByRole('button', { name: '关闭信息整理', exact: true }).click(); milestones.push('撤销仅生成反向预览，第二次明确保存才恢复此前overlay')
    await view.getByRole('button', { name: '结束选择', exact: true }).click(); await expect(table.getByRole('columnheader')).toHaveCount(3); await view.locator('.local-library-management > summary').click(); await view.getByRole('button', { name: '增量扫描', exact: true }).click()
    await expect.poll(async () => { const jobs = await page.evaluate(() => window.musicBridge.localLibraryScan('localScan.page', { offset: 0, limit: 200 })); return jobs.items.length === 2 && jobs.items.every(job => job.phase === 'completed') }, { timeout: 45_000 }).toBe(true)
    const rescanned = await page.evaluate(() => window.musicBridge.queryLocalLibraryTracks({ query: '', rootId: null, offset: 0, limit: 100 })); expect(rescanned.items.map(item => item.track.id).sort()).toEqual(originalTrackIds)
    const afterScan = await page.evaluate(async ids => Promise.all(ids.map(id => window.musicBridge.getLocalLibraryMetadata(id))), originalTrackIds); expect(afterScan.map(value => value.raw)).toEqual(rawBefore.map(value => value.raw)); const restoredStudio = afterScan.find(value => value.override?.trackId === studio.track.id)!; expect(restoredStudio.effective.title).toBe('011 MB Studio A'); expect(restoredStudio.override?.fields.artist).toBeUndefined(); expect(restoredStudio.effective.artist).toBe(restoredStudio.raw.artist); expect(afterScan.every(value => value.override?.fields.album !== '011 MB Batch Album')).toBe(true)
    networks.push(await networkEvidence(app)); await page.screenshot({ path: test.info().outputPath('011-after-incremental-scan.png') }); exits.push(await closeWithEvidence(app)); app = null; expect(exits[0]!.code).toBe(0); milestones.push('增量扫描保留track身份、原始值与已撤销后的overlay，第一次正常退出')
    persistedBefore = await persistedOrganizerCommands(profile); expect(persistedBefore).toHaveLength(5); expect(persistedBefore.every(entry => entry.state === 'succeeded' && entry.acknowledged)).toBe(true); expect(persistedBefore.filter(entry => entry.command === 'localOrganizer.confirm')).toHaveLength(4); expect(persistedBefore.filter(entry => entry.command === 'localOrganizer.undo')).toHaveLength(1)
    app = await launch(); page = await waitForMainWindow(app); page.on('pageerror', error => pageErrors.push(error.message)); await page.locator('[data-sidebar-source="local-library"]').click(); view = page.getByTestId('local-library-view'); await expect(view.locator('.local-results-summary')).toContainText('4 首')
    const recoveredTracks = await page.evaluate(() => window.musicBridge.queryLocalLibraryTracks({ query: '', rootId: null, offset: 0, limit: 100 })); expect(recoveredTracks.items.map(item => item.track.id).sort()).toEqual(originalTrackIds); expect(await page.evaluate(async ids => Promise.all(ids.map(id => window.musicBridge.getLocalLibraryMetadata(id))), originalTrackIds)).toEqual(afterScan)
    await view.getByRole('button', { name: '整理历史', exact: true }).click(); organizer = page.locator('dialog.local-organizer-dialog'); await expect(organizer.locator('.organizer-history')).toContainText('4 条记录'); await organizer.locator('.organizer-history li').filter({ hasText: '2 首 · 已完成' }).getByRole('button', { name: '查看 2 首的整理记录', exact: true }).click(); await expect(organizer.locator('.organizer-preview-item')).toHaveCount(2); await expect(organizer.locator('.organizer-item-result')).toHaveText(['已保存', '已保存']); await expect(organizer.getByRole('heading', { name: '撤销更正结果', exact: true })).toBeVisible(); await expect(organizer.getByRole('button', { name: '保存这些更正', exact: true })).toBeDisabled()
    finalPlans = await plans(page); expect(finalPlans).toHaveLength(4); expect(finalPlans.find(value => value.planId === batchPlanId)?.state).toBe('ROLLED_BACK'); expect(finalPlans.find(value => value.planId === undoPlanId)?.state).toBe('COMPLETED'); await page.screenshot({ path: test.info().outputPath('011-restarted-history-results.png') }); networks.push(await networkEvidence(app)); milestones.push('重启后history/get恢复4个真实计划与逐项终态，零自动保存')
    for (const title of titles) { const filename = `${title}.wav`; after[filename] = sha256(await readFile(path.join(source, filename))); expect(after[filename]).toBe(before[filename]) }
    expect(networks.every(value => value?.installedBeforeWindow === true && value.blockedExternalAttempts === 0 && value.blockedHosts.length === 0)).toBe(true); expect(pageErrors).toEqual([])
    exits.push(await closeWithEvidence(app)); app = null; expect(exits[1]!.code).toBe(0); persistedAfter = await persistedOrganizerCommands(profile); expect(persistedAfter).toEqual(persistedBefore); milestones.push('两次正常退出后的Main持久账本均为同一5个已确认成功请求，重启与history读取零自动新增'); completed = true
  } finally {
    if (app) { networks.push(await networkEvidence(app).catch(() => undefined)); exits.push(await closeWithEvidence(app)); app = null }
    for (const title of titles) { const filename = `${title}.wav`; after[filename] = sha256(await readFile(path.join(source, filename))) }
    const evidence = { layer: 'PRODUCTION_OFFLINE_CONTROLLED_APP_AUTOMATION', completed, synthetic: true, source, profile, milestones, before, after, sourceFilesUnchanged: Object.keys(before).every(key => before[key] === after[key]), originalTrackIds, selectedEditionId, otherEditionId, batchPlanId, undoPlanId, finalPlans, persistedBefore, persistedAfter, networks, exits, pageErrors, realAccountRoonAudioOwner: 'NOT_RUN' }
    await writeFile(path.join(run, '011-organizer-evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); await writeFile(test.info().outputPath('011-organizer-evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    for (const exit of exits) expect(exit.code).toBe(0)
  }
})
