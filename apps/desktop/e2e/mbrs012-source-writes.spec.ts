import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { constants, type Stats } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { LocalSourceWritesPlan, LocalSourceWritesRange } from '@music-bridge/contracts'
import { verifiedElectronExecution } from '../scripts/electron-identity.mjs'
import { testElectronArguments } from '../scripts/test-keychain.mjs'
import { e2eTemporaryRoot } from './temporary-root.js'
import { waitForMainWindow } from './main-window.js'

const desktop = path.resolve(import.meta.dirname, '..'), samples = path.resolve(desktop, '../../packages/bridge-core/test/fixtures/mbrs012-source')
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
interface Manifest { schema: string; synthetic: boolean; allContentOwned: boolean; files: { file: string; kind: string; bytes: number; sha256: string; audioStart?: number; audioPayloadSha256?: string }[] }
interface AudioProjection { audioStart: number; audioSha: string; tags: Record<string, string[]>; rawEntries: { field: string; raw: string }[]; opaque: string[]; pictures: string[] }
interface FileSnapshot { file: string; exists: boolean; bytes: number | null; sha256: string | null }
interface PlanAudit { protectedFiles: string[]; latestPlans: Map<string, LocalSourceWritesPlan>; previewFiles: { planId: string; kind: 'preview' | 'undo-preview'; before: FileSnapshot[]; ready: FileSnapshot[] }[] }
const tagFields = new Set(['TITLE', 'ARTIST', 'ALBUM', 'DATE', 'DISCNUMBER', 'DISC', 'TRACKNUMBER', 'TRACK', 'TIT2', 'TPE1', 'TALB', 'TDRC', 'TPOS', 'TRCK'])
const nativeFileTool = promisify(execFile)
const appProcesses = new WeakMap<ElectronApplication, ReturnType<ElectronApplication['process']>>()
/** 首次启动 App 前独立保存真实写前 inode/权限/系统属性；不取 writer 的返回 Hash。 */
async function captureOwnedBaseline(file: string, run: string) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const first = await handle.stat({ bigint: true })
    expect(first.isFile() && first.nlink === 1n).toBe(true)
    expect(first.size <= 268435456n).toBe(true)
    const bytes = await handle.readFile()
    async function tool(executable: string, args: string[]) {
      const result = await nativeFileTool(executable, args, { timeout: 5000, maxBuffer: 16384, encoding: 'utf8', env: { LANG: 'C', LC_ALL: 'C' } })
      expect(result.stderr).toBe('')
      return result.stdout
    }
    expect(process.platform).toBe('darwin')
    const names = await tool('/usr/bin/xattr', [file])
    expect(['', 'com.apple.provenance\n']).toContain(names)
    let profile: { proof: string; provenance?: { bytes: number; sha256: string } } = { proof: 'MACOS_EMPTY_XATTR_ACL_FLAGS_V1' }
    if (names) {
      const raw = await tool('/usr/bin/xattr', ['-px', 'com.apple.provenance', file])
      expect(raw).toMatch(/^[0-9a-fA-F \t\r\n]+$/u)
      const hex = raw.replace(/[ \t\r\n]/gu, '')
      expect(hex).toMatch(/^[0-9a-fA-F]{22}$/u)
      profile = { proof: 'MACOS_PROVENANCE_ONLY_ACL_FLAGS_V1', provenance: { bytes: 11, sha256: sha(Buffer.from(hex, 'hex')) } }
    }
    const acl = (await tool('/bin/ls', ['-lde', file])).trimEnd().split('\n')
    expect(acl).toHaveLength(1)
    expect(acl[0]!.split(/\s+/u)[0]).toMatch(names ? /^-[rwxstST-]{9}@$/u : /^-[rwxstST-]{9}$/u)
    expect(await tool('/usr/bin/stat', ['-f', '%f', file])).toBe('0\n')
    const last = await handle.stat({ bigint: true }), named = await lstat(file, { bigint: true })
    const keys = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'gid', 'nlink'] as const
    for (const key of keys) { expect(last[key]).toBe(first[key]); expect(named[key]).toBe(first[key]) }
    const before = path.join(run, 'pre-app-' + path.basename(file))
    await writeFile(before, bytes, { flag: 'wx', mode: 0o600 })
    const originalStat = { dev: String(first.dev), ino: String(first.ino), mode: String(first.mode & 0o7777n), uid: String(first.uid), gid: String(first.gid) }
    return { capturePhase: 'BEFORE_FIRST_APP_LAUNCH', target: file, before, bytes: bytes.length, sha256: sha(bytes), originalStat, originalAttributes: { mode: originalStat.mode, uid: originalStat.uid, gid: originalStat.gid, ...profile } }
  } finally { await handle.close() }
}
/** 独立小解析器只读取自有夹具的格式；不导入生产writer或其回读器。 */
function audio(bytes: Buffer): AudioProjection {
  const tags: Record<string, string[]> = {}, rawEntries: AudioProjection['rawEntries'] = [], opaque: string[] = [], pictures: string[] = []
  const add = (field: string, value: string, raw: Buffer) => { (tags[field] ??= []).push(value); rawEntries.push({ field, raw: raw.toString('hex') }) }
  let at = 0
  if (bytes.subarray(0, 4).toString('ascii') === 'fLaC') {
    at = 4; let last = false
    while (!last) {
      const start = at, header = bytes[at]!, type = header & 127, length = bytes.readUIntBE(at + 1, 3); at += 4; expect(at + length).toBeLessThanOrEqual(bytes.length)
      const block = bytes.subarray(at, at + length); last = (header & 128) !== 0
      if (type === 4) {
        let cursor = 0; const vendor = block.readUInt32LE(cursor); cursor += 4 + vendor; const count = block.readUInt32LE(cursor); cursor += 4
        for (let index = 0; index < count; index++) { const start = cursor, length = block.readUInt32LE(cursor); cursor += 4; const value = block.subarray(cursor, cursor + length).toString('utf8'), split = value.indexOf('='); cursor += length; add(value.slice(0, split).toUpperCase(), value.slice(split + 1), block.subarray(start, cursor)) }
        expect(cursor).toBe(block.length)
      } else if (type === 6) {
        let cursor = 4; const mimeLength = block.readUInt32BE(cursor); cursor += 4 + mimeLength; const description = block.readUInt32BE(cursor); cursor += 4 + description + 16; const length = block.readUInt32BE(cursor); cursor += 4
        if (block.readUInt32BE(0) === 3) pictures.push(sha(block.subarray(cursor, cursor + length)))
      } else if (type !== 1) opaque.push(bytes.subarray(start, at + length).toString('hex'))
      at += length
    }
  } else {
    expect(bytes.subarray(0, 6).equals(Buffer.from([73, 68, 51, 4, 0, 0]))).toBe(true)
    const sync = (offset: number) => { const value = bytes.subarray(offset, offset + 4); expect([...value].every(part => part < 128)).toBe(true); return value.reduce((total, part) => total * 128 + part, 0) }
    at = 10 + sync(6); let cursor = 10
    while (cursor < at && bytes[cursor] !== 0) {
      const start = cursor, field = bytes.subarray(cursor, cursor + 4).toString('ascii'), size = sync(cursor + 4); expect(bytes.readUInt16BE(cursor + 8)).toBe(0); cursor += 10; const body = bytes.subarray(cursor, cursor + size); cursor += size
      if (field === 'APIC') { const mimeEnd = body.indexOf(0, 1), type = body[mimeEnd + 1], descriptionEnd = body.indexOf(0, mimeEnd + 2); if (type === 3) pictures.push(sha(body.subarray(descriptionEnd + 1))) }
      else if (tagFields.has(field)) { expect([0, 3]).toContain(body[0]); add(field, body.subarray(1).toString(body[0] === 3 ? 'utf8' : 'latin1').replace(/\0$/u, ''), bytes.subarray(start, cursor)) }
      else rawEntries.push({ field, raw: bytes.subarray(start, cursor).toString('hex') })
    }
    expect(bytes.subarray(cursor, at).every(value => value === 0)).toBe(true)
  }
  return { audioStart: at, audioSha: sha(bytes.subarray(at)), tags, rawEntries, opaque, pictures }
}
function unchangedAudio(before: AudioProjection, after: AudioProjection): void { expect(after.audioStart).toBe(before.audioStart); expect(after.audioSha).toBe(before.audioSha); expect(after.opaque).toEqual(before.opaque) }
function unchangedUnselected(before: AudioProjection, after: AudioProjection, selected: Set<string>): void { expect(after.rawEntries.filter(item => !selected.has(item.field))).toEqual(before.rawEntries.filter(item => !selected.has(item.field))) }
async function launch(profile: string, errors: string[]): Promise<ElectronApplication> {
  const identity = verifiedElectronExecution(), env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) => value !== undefined && !/^(MUSIC_BRIDGE_|NETEASE_|ROON_)/u.test(name))) as Record<string, string>
  Object.assign(env, { MUSIC_BRIDGE_UI_E2E: '1', MUSIC_BRIDGE_UI_E2E_OFFLINE: '1', MUSIC_BRIDGE_CORE_TEST_MODE: '1', MUSIC_BRIDGE_TEST_KEYCHAIN_MODE: 'mock', MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR: profile })
  const app = await electron.launch({ executablePath: path.join(identity.packageRoot, 'dist/Electron.app/Contents/MacOS/Electron'), args: testElectronArguments([path.join(desktop, 'dist/main/index.js')], 'mock'), cwd: desktop, env })
  appProcesses.set(app, app.process())
  const observed = new WeakSet<Page>(), observe = (page: Page) => { if (observed.has(page)) return; observed.add(page); page.on('pageerror', error => errors.push(error.message)) }
  app.on('window', observe); for (const page of app.windows()) observe(page)
  return app
}
async function ownPickers(app: ElectronApplication, source: string): Promise<void> {
  await app.evaluate(({ dialog }, paths) => { const state = globalThis as typeof globalThis & { __sourcePickerCalls: number }; state.__sourcePickerCalls = 0; dialog.showOpenDialog = (async (...args: unknown[]) => { state.__sourcePickerCalls++; const options = args.at(-1) as { properties?: string[] }; return { canceled: false, filePaths: [options.properties?.includes('openDirectory') ? paths.source : paths.image] } }) as typeof dialog.showOpenDialog }, { source, image: path.join(source, 'owned-cover-16.png') })
}
async function normalClose(app: ElectronApplication, closes: unknown[]) {
  const child = appProcesses.get(app)
  if (!child) throw new Error('未捕获原 App 子进程身份，不能证明正常关闭。')
  const finished = child.exitCode === null && child.signalCode === null ? new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('close', (exitCode, signal) => resolve({ exitCode, signal }))) : Promise.resolve({ exitCode: child.exitCode, signal: child.signalCode })
  await app.close(); const result = await finished; closes.push(result); expect(result).toEqual({ exitCode: 0, signal: null }); return result
}
async function offline(app: ElectronApplication, networks: unknown[]) {
  const result = await app.evaluate(() => (globalThis as typeof globalThis & { __musicBridgeUiE2eNetworkEvidence?: { installedBeforeWindow: boolean; blockedExternalAttempts: number; blockedHosts: string[] } }).__musicBridgeUiE2eNetworkEvidence)
  networks.push(result); expect(result?.installedBeforeWindow).toBe(true); expect(result?.blockedExternalAttempts).toBe(0); expect(result?.blockedHosts).toEqual([]); return result
}
async function library(page: Page): Promise<Locator> { await page.locator('[data-sidebar-source="local-library"]').click(); const view = page.getByTestId('local-library-view'); await expect(view).toBeVisible(); return view }
async function plan(page: Page, planId: string, audit: PlanAudit): Promise<LocalSourceWritesPlan> {
  const value = await page.evaluate(async planId => { const { datasetId } = await window.musicBridge.getCommandOutbox(); const value = await window.musicBridge.getLocalSourceWrites({ datasetId, selector: { kind: 'plan', planId } }); if (value.kind !== 'plan' || !value.plan) throw new Error('原计划不可读取'); return value.plan }, planId)
  audit.latestPlans.set(planId, value); return value
}
function planReason(value: LocalSourceWritesPlan | undefined): string { return JSON.stringify(value ? { planId: value.planId, state: value.state, issues: value.issues, items: value.items.map(item => ({ operationId: item.operationId, trackId: item.trackId, state: item.state, phase: item.phase, issue: item.issue })) } : { issue: '尚未读到原计划' }) }
async function waitPlan(page: Page, planId: string, expected: 'READY' | 'BLOCKED' | 'COMPLETED', timeout: number, audit: PlanAudit): Promise<LocalSourceWritesPlan> {
  try {
    await expect.poll(async () => {
      const value = await plan(page, planId, audit)
      return value.state === expected || ['BLOCKED', 'PARTIAL', 'FAILED', 'RECOVERY_REQUIRED', 'CANCELLED', 'COMPLETED'].includes(value.state) || expected !== 'COMPLETED' && value.state === 'READY'
    }, { timeout }).toBe(true)
  } catch (error) { throw new Error(`等待 ${expected} 失败；真实计划：${planReason(audit.latestPlans.get(planId))}`, { cause: error }) }
  const value = await plan(page, planId, audit); expect(value.state, `真实计划：${planReason(value)}`).toBe(expected); return value
}
function exactItems(value: LocalSourceWritesPlan, trackIds: string[]): void {
  expect(trackIds.length).toBeGreaterThan(0); expect(new Set(trackIds).size).toBe(trackIds.length); expect(value.items).toHaveLength(trackIds.length)
  expect(value.items.map(item => item.trackId).sort()).toEqual([...trackIds].sort()); expect(new Set(value.items.map(item => item.operationId)).size).toBe(trackIds.length)
  for (const item of value.items) expect(item.operationId).not.toBe('')
}
async function snapshots(protectedFiles: string[]): Promise<FileSnapshot[]> {
  return Promise.all(protectedFiles.map(async file => {
    let info: Stats
    try { info = await lstat(file) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { file, exists: false, bytes: null, sha256: null }; throw error }
    expect(info.isSymbolicLink()).toBe(false); expect(info.isFile()).toBe(true); const bytes = await readFile(file); expect(bytes.length).toBe(info.size)
    return { file, exists: true, bytes: bytes.length, sha256: sha(bytes) }
  }))
}
async function history(page: Page) { return page.evaluate(async () => { const { datasetId } = await window.musicBridge.getCommandOutbox(); const page = await window.musicBridge.listLocalSourceWritesHistory({ datasetId, selector: { kind: 'plans', range: 'all' }, cursor: null, limit: 100 }); if (page.kind !== 'plans') throw new Error('历史类型错误'); return page.items }) }
async function detail(page: Page, trackId: string): Promise<Locator> { const view = await library(page); await view.locator(`[data-local-detail-track="${trackId}"]`).click(); const current = view.locator('.local-track-detail'); await expect(current.getByRole('button', { name: '预览此曲目源写', exact: true })).toBeEnabled(); return current }
async function openSource(page: Page, trackId: string, editionId?: string): Promise<Locator> {
  const current = await detail(page, trackId)
  if (editionId) await current.getByRole('button', { name: new RegExp(`预览具体发行 .* ${editionId} 的源写`, 'u') }).click()
  else { await current.getByRole('button', { name: '整理此曲目信息', exact: true }).click(); await page.getByRole('dialog', { name: '整理 MB 信息', exact: true }).getByRole('button', { name: '预览源标签写回', exact: true }).click() }
  const dialog = page.getByRole('dialog', { name: '源文件写入', exact: true }); await expect(dialog).toBeVisible(); return dialog
}
async function preview(page: Page, dialog: Locator, range: LocalSourceWritesRange, screenshot: string, trackIds: string[], audit: PlanAudit, expected: 'READY' | 'BLOCKED' = 'READY'): Promise<LocalSourceWritesPlan> {
  const beforeFiles = await snapshots(audit.protectedFiles)
  const previous = new Set((await history(page)).map(item => item.planId)); await dialog.getByRole('button', { name: '预览具体源写计划', exact: true }).click()
  let id = ''
  await expect.poll(async () => { const next = (await history(page)).filter(item => !previous.has(item.planId)); if (next.length === 1) id = next[0]!.planId; return next.length }, { timeout: 20_000 }).toBe(1)
  const value = await waitPlan(page, id, expected, 30_000, audit); expect(value.range).toBe(range); if (expected === 'READY') exactItems(value, trackIds); expect(value.items.every(item => item.state === 'planned')).toBe(true)
  const readyFiles = await snapshots(audit.protectedFiles); audit.previewFiles.push({ planId: id, kind: 'preview', before: beforeFiles, ready: readyFiles }); expect(readyFiles).toEqual(beforeFiles)
  const confirmation = dialog.getByRole('button', { name: '确认这份源写计划', exact: true }); if (expected === 'READY') await expect(confirmation).toBeEnabled(); else await expect(confirmation).toBeDisabled(); await page.screenshot({ path: screenshot }); return value
}
async function rescan(page: Page): Promise<void> {
  const view = await library(page), management = view.locator('.local-library-management')
  if (!(await management.evaluate(element => (element as HTMLDetailsElement).open))) await management.locator(':scope > summary').click()
  const before = await page.evaluate(async () => (await window.musicBridge.localLibraryScan('localScan.page', { offset: 0, limit: 200 })).items.map(value => value.jobId))
  await view.getByRole('button', { name: '增量扫描', exact: true }).click()
  await expect.poll(async () => page.evaluate(async before => { const jobs = (await window.musicBridge.localLibraryScan('localScan.page', { offset: 0, limit: 200 })).items.filter(value => !before.includes(value.jobId)); return jobs.length === 1 ? jobs[0]!.phase : '等待真实新任务' }, before), { timeout: 45_000 }).toBe('completed')
  await view.getByRole('button', { name: '刷新', exact: true }).click()
}
async function showRecordedPlan(page: Page, value: LocalSourceWritesPlan): Promise<Locator> {
  const view = await library(page); await view.getByRole('button', { name: '源写历史与恢复', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '源文件写入', exact: true }); await dialog.locator(`[data-source-plan-id="${value.planId}"]`).getByRole('button', { name: `查看 ${value.items.length} 项源写计划`, exact: true }).click(); await expect(dialog.getByRole('button', { name: '预览源写撤销', exact: true })).toBeVisible(); return dialog
}
async function confirm(page: Page, dialog: Locator, value: LocalSourceWritesPlan, audit: PlanAudit): Promise<LocalSourceWritesPlan> {
  exactItems(value, value.items.map(item => item.trackId)); expect(value.state).toBe('READY')
  const before = await page.evaluate(async () => (await window.musicBridge.getCommandOutbox()).entries.filter(item => item.command === 'localSourceWrites.confirm').map(item => item.commandId))
  await dialog.getByRole('button', { name: '确认这份源写计划', exact: true }).click()
  const result = await waitPlan(page, value.planId, 'COMPLETED', 45_000, audit); exactItems(result, value.items.map(item => item.trackId))
  expect(result.datasetId).toBe(value.datasetId); expect(result.planId).toBe(value.planId); expect(result.jobId).toBe(value.jobId); expect(result.scope).toBe(value.scope); expect(result.range).toBe(value.range)
  const bindings = (plan: LocalSourceWritesPlan) => plan.items.map(item => ({ operationId: item.operationId, trackId: item.trackId, assetId: item.assetId, resourceRef: item.resourceRef })).sort((a, b) => a.operationId.localeCompare(b.operationId))
  expect(bindings(result)).toEqual(bindings(value)); expect(result.items.every(item => item.state === 'applied' && item.verification.reread === 'verified' && ['verified', 'retained'].includes(item.backup.state))).toBe(true)
  const newEntries = await page.evaluate(async before => (await window.musicBridge.getCommandOutbox()).entries.filter(item => item.command === 'localSourceWrites.confirm' && !before.includes(item.commandId)), before); expect(newEntries).toHaveLength(1); expect(newEntries[0]!.canRetry).toBe(false)
  const receipt = await page.evaluate(async entry => window.musicBridge.getLocalSourceWrites({ datasetId: entry.datasetId, selector: { kind: 'command', commandId: entry.commandId, expectedCommand: 'localSourceWrites.confirm', requestFingerprint: entry.sourceRequestFingerprint! } }), newEntries[0]!)
  expect(receipt.kind === 'command' && receipt.receipt?.outcome).toBe('accepted'); expect(receipt.kind === 'command' && receipt.receipt?.planId).toBe(value.planId); return result
}
async function undo(page: Page, dialog: Locator, value: LocalSourceWritesPlan, audit: PlanAudit): Promise<LocalSourceWritesPlan> {
  exactItems(value, value.items.map(item => item.trackId)); const beforeFiles = await snapshots(audit.protectedFiles)
  const previous = new Set((await history(page)).map(item => item.planId)); await expect(dialog.getByRole('button', { name: '预览源写撤销', exact: true })).toBeVisible(); await dialog.getByRole('button', { name: '预览源写撤销', exact: true }).click()
  let id = ''; await expect.poll(async () => { const next = (await history(page)).filter(item => !previous.has(item.planId)); if (next.length === 1) id = next[0]!.planId; return next.length }, { timeout: 20_000 }).toBe(1)
  const reverse = await waitPlan(page, id, 'READY', 30_000, audit); expect(reverse.undoOf).toBe(value.planId); expect(reverse.range).toBe(value.range); exactItems(reverse, value.items.map(item => item.trackId))
  expect(reverse.items.every(item => item.artwork === null && item.restoration?.originPlanId === value.planId && value.items.some(origin => origin.operationId === item.restoration?.originOperationId))).toBe(true)
  expect(reverse.items.map(item => item.restoration!.originOperationId).sort()).toEqual(value.items.map(item => item.operationId).sort())
  if (value.range === 'DIRECTORY_COVER') { expect(reverse.items.every(item => item.restoration?.kind === 'remove-new-directory-cover' && item.restoration.material === 'verified-absence' && item.restoration.expectedOutputSha256 === null)).toBe(true); await expect(dialog).toContainText('恢复原无目录封面状态') }
  else { expect(reverse.items.every(item => item.restoration?.kind === 'restore-audio-file' && item.restoration.material === 'verified-backup' && /^[a-f0-9]{64}$/u.test(item.restoration.expectedOutputSha256 ?? ''))).toBe(true); await expect(dialog).toContainText('从已核验备份恢复原音频文件') }
  const readyFiles = await snapshots(audit.protectedFiles); audit.previewFiles.push({ planId: id, kind: 'undo-preview', before: beforeFiles, ready: readyFiles }); expect(readyFiles).toEqual(beforeFiles)
  await expect(dialog.getByRole('button', { name: '确认这份源写计划', exact: true })).toBeEnabled(); return confirm(page, dialog, reverse, audit)
}
async function files(root: string): Promise<{ file: string; bytes: number; sha256: string }[]> {
  const result: { file: string; bytes: number; sha256: string }[] = []
  async function visit(directory: string) { for (const name of await readdir(directory)) { const file = path.join(directory, name), info = await lstat(file); if (info.isSymbolicLink()) continue; if (info.isDirectory()) await visit(file); else if (info.isFile() && info.size <= 2097152) result.push({ file: path.relative(root, file), bytes: info.size, sha256: sha(await readFile(file)) }) } }
  await visit(root); return result
}
function errorFact(error: unknown) { return error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { name: '非 Error 异常', message: String(error) } }

test('012生产离线自有FLAC/MP3：四范围、具体确认、原图、逐项结果、撤销与冷启动，音频和非目标元数据保留', async () => {
  test.setTimeout(240_000)
  const manifest = JSON.parse(await readFile(path.join(samples, 'manifest.json'), 'utf8')) as Manifest
  expect(manifest.schema).toBe('mbrs012.owned-writer-fixtures.v1'); expect(manifest.synthetic && manifest.allContentOwned).toBe(true)
  const run = await mkdtemp(path.join(e2eTemporaryRoot(), 'mbrs012-source-')), profile = path.join(run, 'musicbridge-ui-e2e-' + path.basename(run)), source = path.join(run, 'owned-source'); await mkdir(profile, { mode: 0o700 }); await mkdir(source, { mode: 0o700 })
  for (const input of manifest.files) { const original = await readFile(path.join(samples, input.file)); expect(original.length).toBe(input.bytes); expect(sha(original)).toBe(input.sha256); await copyFile(path.join(samples, input.file), path.join(source, input.file)) }
  const originals = new Map(manifest.files.filter(item => item.kind === 'audio').map(item => [item.file, item])), evidence: unknown[] = [], errors: string[] = [], closes: unknown[] = [], networks: unknown[] = []
  const baselines = []
  for (const input of originals.values()) {
    const baseline = await captureOwnedBaseline(path.join(source, input.file), run)
    expect(baseline.bytes).toBe(input.bytes); expect(baseline.sha256).toBe(input.sha256); baselines.push(baseline)
  }
  await expect(lstat(path.join(source, 'cover.png'))).rejects.toMatchObject({ code: 'ENOENT' })
  await writeFile(path.join(run, 'pre-app-baselines.json'), JSON.stringify({ schema: 'mbrs012.owned-app-prepublication.v1', baselines, directoryCoverBefore: 'GENUINE_ABSENCE', productionWriterImported: false }, null, 2), { flag: 'wx', mode: 0o600 })
  const audit: PlanAudit = { protectedFiles: [...originals.values()].map(input => path.join(source, input.file)).concat(path.join(source, 'cover.png')), latestPlans: new Map(), previewFiles: [] }
  const cleanupFailures: { stage: string; error: unknown }[] = []
  let app: ElectronApplication | null = null, completed = false, failed = false, failure: unknown
  try {
    app = await launch(profile, errors); let page = await waitForMainWindow(app); let view = await library(page); await view.locator('.local-library-management > summary').click()
    await ownPickers(app, source)
    await view.getByRole('button', { name: '授权源目录并加入音乐库', exact: true }).click(); await view.getByRole('button', { name: '增量扫描', exact: true }).click(); await expect(view.getByRole('list', { name: '扫描任务' })).toContainText('已完成', { timeout: 45_000 }); await view.getByRole('button', { name: '刷新', exact: true }).click(); await expect(view.locator('.local-results-summary')).toContainText('2 首', { timeout: 10_000 })
    const rows = await page.evaluate(() => window.musicBridge.queryLocalLibraryTracks({ query: '', rootId: null, offset: 0, limit: 100 })); expect(rows.items).toHaveLength(2)
    const blockedDialog = await openSource(page, rows.items[0]!.track.id); await blockedDialog.getByRole('combobox', { name: '标题源标签操作', exact: true }).selectOption('set'); await blockedDialog.getByRole('textbox', { name: '标题源标签值', exact: true }).fill('关闭策略时不得写入'); const blocked = await preview(page, blockedDialog, 'TAGS', path.join(run, 'policy-off-blocked.png'), [rows.items[0]!.track.id], audit, 'BLOCKED'); expect(blocked.issues).toContain('POLICY_DISABLED'); for (const input of originals.values()) expect(sha(await readFile(path.join(source, input.file)))).toBe(input.sha256); await blockedDialog.getByRole('button', { name: '关闭源文件写入', exact: true }).click()
    await page.getByRole('button', { name: '打开设置', exact: true }).click(); await page.getByRole('tab', { name: '应用', exact: true }).click(); const settings = page.getByTestId('source-write-settings'), enabled = settings.getByRole('checkbox', { name: '允许具体源文件写入', exact: true }); await expect(enabled).not.toBeChecked(); await enabled.check(); await expect(enabled).toBeChecked(); await expect(settings).toContainText('源写开关已保存。')
    for (const row of rows.items) {
      const current = await page.evaluate(id => window.musicBridge.getLocalLibraryTrackDetail(id), row.track.id), flac = current.fileParameters?.codec.toLowerCase().includes('flac') === true, name = flac ? 'owned-stereo-fixed-tags.flac' : 'owned-stereo-id3v240.mp3', file = path.join(source, name), original = originals.get(name)!, initialBytes = await readFile(file), initial = audio(initialBytes)
      expect(initial.audioStart).toBe(original.audioStart); expect(initial.audioSha).toBe(original.audioPayloadSha256)
      expect(initial.tags[flac ? 'DATE' : 'TDRC']).toEqual(['2026']); expect(initial.tags[flac ? 'DISCNUMBER' : 'TPOS']).toEqual(['1']); expect(initial.tags[flac ? 'TRACKNUMBER' : 'TRCK']).toEqual(['2'])
      let currentView = await detail(page, row.track.id); await currentView.getByLabel('仅修改 MB 显示名称', { exact: true }).fill('012 MB-only 显示更正'); await currentView.getByRole('button', { name: '保存显示更正', exact: true }).click(); await expect(currentView).toContainText('012 MB-only 显示更正'); expect(sha(await readFile(file))).toBe(original.sha256)
      await currentView.getByRole('button', { name: '选择封面', exact: true }).click(); const artwork = page.locator('dialog.local-artwork-dialog'); await artwork.getByLabel('独立发行名称', { exact: true }).fill('012 ' + (flac ? 'FLAC' : 'MP3') + ' 精确发行'); await artwork.getByRole('button', { name: '建立独立发行用于选图', exact: true }).click(); await expect(artwork).toContainText('独立发行已建立'); await artwork.getByRole('button', { name: '选择 PNG / JPEG', exact: true }).click(); await expect(artwork.locator('.candidate-choice')).toHaveCount(1); await artwork.locator('.candidate-choice').click(); await artwork.getByRole('button', { name: /^保存选图：/u }).click(); await expect(artwork).toContainText('封面选择已保存。'); await artwork.getByRole('button', { name: '关闭封面选图', exact: true }).click()
      const refreshed = await page.evaluate(id => window.musicBridge.getLocalLibraryTrackDetail(id), row.track.id), edition = refreshed.editions.find(value => value.title === '012 ' + (flac ? 'FLAC' : 'MP3') + ' 精确发行')!; expect(edition).toBeDefined(); expect(sha(await readFile(file))).toBe(original.sha256)
      let dialog = await openSource(page, row.track.id, flac ? undefined : edition.id); await dialog.getByRole('combobox', { name: '标题源标签操作', exact: true }).selectOption('set'); await dialog.getByRole('textbox', { name: '标题源标签值', exact: true }).fill('012 源写新标题'); for (const field of ['艺术家', '专辑']) { await dialog.getByRole('combobox', { name: field + '源标签操作', exact: true }).selectOption('set'); await dialog.getByRole('textbox', { name: field + '源标签值', exact: true }).fill('012 ' + field) }; for (const field of ['年份', '碟号', '曲序']) await dialog.getByRole('combobox', { name: field + '源标签操作', exact: true }).selectOption('remove')
      const ready = await preview(page, dialog, 'TAGS', path.join(run, (flac ? 'flac' : 'mp3') + '-tags-ready.png'), [row.track.id], audit); expect(sha(await readFile(file))).toBe(original.sha256); const picksBefore = await app.evaluate(() => (globalThis as typeof globalThis & { __sourcePickerCalls: number }).__sourcePickerCalls)
      const written = await confirm(page, dialog, ready, audit), afterBytes = await readFile(file), after = audio(afterBytes); expect(sha(afterBytes)).not.toBe(original.sha256); unchangedAudio(initial, after); unchangedUnselected(initial, after, tagFields); expect(after.tags[flac ? 'TITLE' : 'TIT2']).toEqual(['012 源写新标题']); for (const field of flac ? ['DATE', 'DISC', 'DISCNUMBER', 'TRACK', 'TRACKNUMBER'] : ['TDRC', 'TPOS', 'TRCK']) expect(after.tags[field]).toBeUndefined(); await writeFile(path.join(run, (flac ? 'flac' : 'mp3') + '-tags-after.' + (flac ? 'flac' : 'mp3')), afterBytes, { flag: 'wx', mode: 0o600 }); expect(await app.evaluate(() => (globalThis as typeof globalThis & { __sourcePickerCalls: number }).__sourcePickerCalls)).toBe(picksBefore)
      const afterDetail = await page.evaluate(id => window.musicBridge.getLocalLibraryTrackDetail(id), row.track.id); expect(afterDetail.track.id).toBe(current.track.id); expect(afterDetail.asset.id).toBe(current.asset.id); expect(BigInt(afterDetail.asset.fileRevision)).toBe(BigInt(current.asset.fileRevision) + 1n); expect(afterDetail.metadata.raw.title).toBe('012 源写新标题'); for (const field of ['year', 'disc', 'track'] as const) expect(Object.hasOwn(afterDetail.metadata.raw, field)).toBe(false)
      await dialog.getByRole('button', { name: '关闭源文件写入', exact: true }).click(); await rescan(page)
      const afterScan = await page.evaluate(id => window.musicBridge.getLocalLibraryTrackDetail(id), row.track.id); expect(afterScan.asset.fileRevision).toBe(afterDetail.asset.fileRevision); expect(afterScan.metadata.raw).toEqual(afterDetail.metadata.raw)
      const oldArtistSearch = await page.evaluate(() => window.musicBridge.queryLocalLibraryTracks({ query: '测试艺人', rootId: null, offset: 0, limit: 100 })); expect(oldArtistSearch.items.some(value => value.track.id === row.track.id)).toBe(false)
      if (flac) {
        await offline(app, networks); await normalClose(app, closes); app = null
        app = await launch(profile, errors); await ownPickers(app, source); page = await waitForMainWindow(app); view = await library(page)
        const coldRemoved = await page.evaluate(id => window.musicBridge.getLocalLibraryTrackDetail(id), row.track.id); expect(coldRemoved.asset.id).toBe(afterDetail.asset.id); expect(coldRemoved.asset.fileRevision).toBe(afterDetail.asset.fileRevision); expect(coldRemoved.metadata.raw).toEqual(afterDetail.metadata.raw); for (const field of ['year', 'disc', 'track'] as const) expect(Object.hasOwn(coldRemoved.metadata.raw, field)).toBe(false); expect(sha(await readFile(file))).toBe(sha(afterBytes)); await detail(page, row.track.id); await page.screenshot({ path: path.join(run, 'cold-removed-raw.png') })
      }
      dialog = await showRecordedPlan(page, written)
      await undo(page, dialog, written, audit); expect(sha(await readFile(file))).toBe(original.sha256); await dialog.getByRole('button', { name: '关闭源文件写入', exact: true }).click()
      currentView = await detail(page, row.track.id); await currentView.getByRole('button', { name: '选择封面', exact: true }).click(); const savedArtwork = page.locator('dialog.local-artwork-dialog'); await savedArtwork.getByRole('combobox', { name: '所属独立发行', exact: true }).selectOption(edition.id); await savedArtwork.getByRole('button', { name: '预览封面源写回', exact: true }).click(); dialog = page.getByRole('dialog', { name: '源文件写入', exact: true }); await expect(dialog.getByRole('combobox', { name: '保存范围', exact: true })).toHaveValue('EMBEDDED_COVER'); await expect(dialog.getByRole('combobox', { name: '源写封面发行', exact: true })).toHaveValue(edition.id); const embeddedReady = await preview(page, dialog, 'EMBEDDED_COVER', path.join(run, (flac ? 'flac' : 'mp3') + '-embedded-ready.png'), [row.track.id], audit), embedded = await confirm(page, dialog, embeddedReady, audit), withImage = audio(await readFile(file)); unchangedAudio(initial, withImage); unchangedUnselected(initial, withImage, new Set()); expect(withImage.pictures).toContain(manifest.files.find(item => item.file === 'owned-cover-16.png')!.sha256); await writeFile(path.join(run, (flac ? 'flac' : 'mp3') + '-embedded-after.' + (flac ? 'flac' : 'mp3')), await readFile(file), { flag: 'wx', mode: 0o600 })
      await undo(page, dialog, embedded, audit); expect(sha(await readFile(file))).toBe(original.sha256); await dialog.getByRole('button', { name: '关闭源文件写入', exact: true }).click()
      if (flac) {
        const beforeDirectory = await page.evaluate(id => window.musicBridge.getLocalLibraryTrackDetail(id), row.track.id); dialog = await openSource(page, row.track.id); await dialog.getByRole('combobox', { name: '保存范围', exact: true }).selectOption('DIRECTORY_COVER'); await dialog.getByRole('combobox', { name: '源写封面发行', exact: true }).selectOption(edition.id); await dialog.getByRole('combobox', { name: '目录封面名称', exact: true }).selectOption('cover.png'); const directoryReady = await preview(page, dialog, 'DIRECTORY_COVER', path.join(run, 'directory-ready.png'), [row.track.id], audit), directory = await confirm(page, dialog, directoryReady, audit); expect(sha(await readFile(path.join(source, 'cover.png')))).toBe(manifest.files.find(item => item.file === 'owned-cover-16.png')!.sha256); expect(sha(await readFile(file))).toBe(original.sha256); const afterDirectory = await page.evaluate(id => window.musicBridge.getLocalLibraryTrackDetail(id), row.track.id); expect(afterDirectory.asset.fileRevision).toBe(beforeDirectory.asset.fileRevision); await undo(page, dialog, directory, audit); await expect(lstat(path.join(source, 'cover.png'))).rejects.toMatchObject({ code: 'ENOENT' }); await dialog.getByRole('button', { name: '关闭源文件写入', exact: true }).click()
      }
      evidence.push({ profile: flac ? 'NATIVE_FLAC_FIXED_TAG_REGION_V1' : 'MPEG1_LAYERIII_ID3V240_FIXED_TAG_REGION_V1', trackId: row.track.id, assetId: current.asset.id, editionId: edition.id, original: original.sha256, audioBefore: initial, tagsAfter: after, tagsAfterFileSha256: sha(afterBytes), embeddedAfter: withImage, confirmedPlan: written, sourceChooserCallsUnchangedAtFinalConfirm: true })
    }
    const batchBefore = await Promise.all([...originals.values()].map(async input => { const bytes = await readFile(path.join(source, input.file)); expect(sha(bytes)).toBe(input.sha256); return { input, projection: audio(bytes) } }))
    view = await library(page); await view.getByRole('button', { name: '选择曲目', exact: true }).click()
    for (const row of rows.items) {
      const selectedRow = view.getByRole('row').filter({ has: page.locator(`[data-local-detail-track="${row.track.id}"]`) })
      await expect(selectedRow).toHaveCount(1)
      await selectedRow.getByRole('checkbox').check()
    }
    await view.getByRole('button', { name: '预览已选曲目源写', exact: true }).click(); const batch = page.getByRole('dialog', { name: '源文件写入', exact: true }); await batch.getByRole('combobox', { name: '专辑源标签操作', exact: true }).selectOption('set'); await batch.getByRole('textbox', { name: '专辑源标签值', exact: true }).fill('012 明确两曲源写'); const batchReady = await preview(page, batch, 'TAGS', path.join(run, 'batch-ready.png'), rows.items.map(item => item.track.id), audit); expect(batchReady.items.map(item => item.trackId).sort()).toEqual(rows.items.map(item => item.track.id).sort()); const batchResult = await confirm(page, batch, batchReady, audit)
    for (const { input, projection } of batchBefore) {
      const bytes = await readFile(path.join(source, input.file)), written = audio(bytes); expect(sha(bytes)).not.toBe(input.sha256); expect(written.tags[input.file.endsWith('.flac') ? 'ALBUM' : 'TALB']).toEqual(['012 明确两曲源写']); unchangedAudio(projection, written); unchangedUnselected(projection, written, new Set(['ALBUM', 'TALB']))
      evidence.push({ kind: 'batch-written-file', file: input.file, beforeSha256: input.sha256, afterSha256: sha(bytes), before: projection, after: written }); await writeFile(path.join(run, 'batch-after-' + input.file), bytes, { flag: 'wx', mode: 0o600 })
    }
    await undo(page, batch, batchResult, audit); for (const input of originals.values()) expect(sha(await readFile(path.join(source, input.file)))).toBe(input.sha256); await batch.getByRole('button', { name: '关闭源文件写入', exact: true }).click()
    const beforeCold = await history(page); await offline(app, networks); await normalClose(app, closes); app = null
    const coldFiles = await files(run); for (const input of originals.values()) { expect(sha(await readFile(path.join(source, input.file)))).toBe(input.sha256); expect(coldFiles.some(item => !item.file.startsWith('owned-source/') && item.sha256 === input.sha256)).toBe(true) }
    app = await launch(profile, errors); page = await waitForMainWindow(app); view = await library(page); await view.getByRole('button', { name: '源写历史与恢复', exact: true }).click(); const historyDialog = page.getByRole('dialog', { name: '源文件写入', exact: true }); await expect(historyDialog).toContainText('逐项核验完成'); expect((await history(page)).map(item => ({ id: item.planId, state: item.state }))).toEqual(beforeCold.map(item => ({ id: item.planId, state: item.state }))); await page.screenshot({ path: path.join(run, 'cold-history.png') }); await historyDialog.getByRole('button', { name: '关闭源文件写入', exact: true }).click(); await detail(page, rows.items[0]!.track.id); await expect(view.locator('.local-track-detail').getByRole('button', { name: '原文件直送', exact: true })).toBeVisible()
    await offline(app, networks); await normalClose(app, closes); app = null; expect(errors).toEqual([]); for (const input of originals.values()) expect(sha(await readFile(path.join(source, input.file)))).toBe(input.sha256)
    await writeFile(path.join(run, 'receipt.json'), JSON.stringify({ schema: 'mbrs012.production-owned-source-e2e.v1', completed: true, sourceAuthority: 'Main专用物理端口/具体READY最终按钮，无额外批准modal', nativeChooser: '原目录/选图UI的自有路径回调；不称Owner人工操作', manifestSha256: sha(await readFile(path.join(samples, 'manifest.json'))), evidence, beforeCold, files: coldFiles, latestPlans: [...audit.latestPlans.values()], previewFiles: audit.previewFiles, pageErrors: errors, networks, closes, decodedPcmPostWriteVerification: '交Root独立解码实际保全/写后文件，不以本解析器冒充解码听感' }, null, 2), { flag: 'wx', mode: 0o600 }); completed = true
  } catch (error) { failed = true; failure = error
  } finally {
    try {
      if (app) {
        try { await offline(app, networks) } catch (error) { cleanupFailures.push({ stage: '外网审计', error }) }
        finally { try { await normalClose(app, closes) } catch (error) { cleanupFailures.push({ stage: '正常关闭', error }) } finally { app = null } }
      }
    } finally {
      if (!completed || failed || cleanupFailures.length) {
        try { await writeFile(path.join(run, 'failure.json'), JSON.stringify({ completed: false, primaryError: failed ? errorFact(failure) : null, cleanupFailures: cleanupFailures.map(item => ({ stage: item.stage, error: errorFact(item.error) })), evidence, latestPlans: [...audit.latestPlans.values()], previewFiles: audit.previewFiles, pageErrors: errors, networks, closes }, null, 2), { mode: 0o600 }) }
        catch (error) { cleanupFailures.push({ stage: '失败记录', error }) }
      }
    }
  }
  if (failed && cleanupFailures.length) throw new AggregateError([failure, ...cleanupFailures.map(item => item.error)], `源写原检查与收尾均失败：${errorFact(failure).message}`, { cause: failure })
  if (failed) throw failure
  if (cleanupFailures.length) throw new AggregateError(cleanupFailures.map(item => item.error), '源写收尾失败。')
})
