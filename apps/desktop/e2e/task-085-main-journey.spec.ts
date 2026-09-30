import { testElectronArguments } from '../scripts/test-keychain.mjs'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { waitForMainWindow } from './main-window.js'
import { e2eTemporaryRoot } from './temporary-root.js'
import { privatePlanOutputBackend, seedRecordingPlan, selectDirectRecordingContext } from './task-072-workflows.js'

const desktopRoot = path.resolve(import.meta.dirname, '..')
const temporaryRoot = e2eTemporaryRoot()
let app: ElectronApplication | undefined, page: Page, directory: string

async function launch(): Promise<void> {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !/^(MUSIC_BRIDGE_|NETEASE_|ROON_)/u.test(key))) as Record<string, string>
  // Main/Preload/Outbox 使用正式代码；仅隔离 Core 的设备目录是构造器Fake，无GateB认证或输出驱动。
  app = await electron.launch({ args: testElectronArguments([path.join(desktopRoot, 'e2e/private-core-main-wrapper.mjs')], 'mock'), cwd: desktopRoot,
    env: { ...inherited, MUSIC_BRIDGE_UI_E2E: '1', MUSIC_BRIDGE_UI_E2E_OFFLINE: '1', MUSIC_BRIDGE_CORE_TEST_MODE: '1', MUSIC_BRIDGE_SYNTHETIC_ROON_LIBRARY: '1', MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR: directory } })
  page = await waitForMainWindow(app)
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('#home-heading')).toBeVisible()
  await expect.poll(async () => (await page.evaluate(() => window.musicBridge.getCoreHealth())).runtime).toBe('ready')
}
async function close(): Promise<void> { const running = app; app = undefined; await running?.close() }
test.beforeEach(async () => {
  test.setTimeout(180_000)
  directory = await mkdtemp(path.join(temporaryRoot, 'musicbridge-ui-e2e-main-journey-'))
  await mkdir(test.info().outputDir, { recursive: true })
  await writeFile(test.info().outputPath('synthetic-user-data-path.txt'), directory)
  await launch()
})
test.afterEach(close)

test('外审主流程正式IPC：干净工作库源→草稿→母版/布局→Session→执行/归档/Plan，阻断后冷启不造Attempt', async () => {
  // 当前没有独立Original Master/Project对象：源binding、draft、master/layout是实际持久合同。
  expect((await page.evaluate(() => window.musicBridge.listMasterDrafts({ offset: 0, limit: 25 }))).total).toBe(0)
  expect((await page.evaluate(() => window.musicBridge.listRecordingAttempts({ page: { offset: 0, limit: 25 } }))).total).toBe(0)
  const f = await seedRecordingPlan(page, app!, directory, privatePlanOutputBackend)
  const identity = await page.evaluate(async draftId => ({
    draft: await window.musicBridge.getMasterDraft(draftId), sources: await window.musicBridge.getDraftSources(draftId),
    versions: await window.musicBridge.listMasterVersions(draftId), session: await window.musicBridge.getRecordingSession(draftId),
    assets: await window.musicBridge.listExecutionAssets(draftId), archives: await window.musicBridge.listArchives(draftId),
  }), f.draft.draftId)
  expect(identity.sources.tracks[0]!.binding).toMatchObject({ userConfirmed: true, sourceLockEligible: true, availability: 'ONLINE' })
  const master = identity.versions.masters[0]!
  expect(master.content.tracks.map(track => track.trackId)).toEqual(f.draft.trackIds)
  expect(f.layout.masterVersionId).toBe(master.id)
  expect(f.asset.layoutVersionId).toBe(f.layout.id)
  expect(f.archive.assetId).toBe(f.asset.id)
  expect(identity.session.session).toEqual(f.session)
  const outputSelection = await page.evaluate(async () => {
    const candidates = await window.musicBridge.listRecordingDeviceCandidates()
    return window.musicBridge.selectRecordingDevice({ endpointId: candidates.candidates[0]!.endpointId })
  })
  const selection = { ...f.selection, outputSelection }
  const proposal = await page.evaluate(selection => window.musicBridge.previewRecordingPlan({ readId: crypto.randomUUID(), selection }), selection)
  const freeze = { commandId: randomUUID(), selection, proposalFingerprint: proposal.proposalFingerprint, userConfirmed: true as const }
  const plan = await page.evaluate(request => window.musicBridge.freezeRecordingPlan(request), freeze)
  expect(plan).toMatchObject({ draftId: f.draft.draftId, master: { id: master.id }, layout: { id: f.layout.id }, execution: { assetId: f.asset.id }, archive: { operationId: f.archive.id }, profileSnapshot: { sessionRevision: f.session.revision }, formalReady: false })
  const preflight = await page.evaluate(planVersionId => window.musicBridge.preflightRecordingPlan({ planVersionId, readId: crypto.randomUUID() }), plan.id)
  expect(preflight).toMatchObject({ state: 'blocked', gateB: 'NOT_RUN', formalReady: false })
  expect(preflight.checks.filter(check => check.category !== 'backend').every(check => check.state === 'passed')).toBe(true)
  expect(preflight.checks.find(check => check.category === 'backend')?.code).toBe('BACKEND_NOT_CERTIFIED')
  const begin = { commandId: randomUUID(), planVersionId: plan.id, planContentHash: plan.contentHash, userConfirmed: true as const }
  await expect(page.evaluate(request => window.musicBridge.beginRecordingAttempt(request), begin)).rejects.toThrow(/NOT_READY/u)
  expect((await page.evaluate(() => window.musicBridge.listRecordingAttempts({ page: { offset: 0, limit: 25 } }))).total).toBe(0)

  await page.locator('[data-sidebar-source="recording"]').click()
  await page.getByRole('button', { name: /^计划与预检合成草稿 /u }).click()
  await selectDirectRecordingContext(page, f.media.id, f.layout.id)
  const readWorkbenchSides = () => page.locator('.side-card').evaluateAll(cards => cards.map(card => ({
    side: card.querySelector('.side-badge')?.textContent?.trim(),
    duration: card.querySelector('header > span')?.textContent?.trim(),
    titles: Array.from(card.querySelectorAll('.track-copy > strong'), title => title.textContent?.trim()),
  })))
  const expectedSides = f.media.layout.sides.map(side => ({
    side: side.name,
    duration: `${Math.floor(side.durationMs! / 60_000)}:${String(Math.floor(side.durationMs! / 1000) % 60).padStart(2, '0')}`,
    titles: side.tracks.map(track => identity.draft.tracks.find(item => item.id === track.trackId)!.metadata.title),
  }))
  // 首次选择与冷启必须使用同一保存规划的分面及估算，不能首次显示默认草稿分面。
  expect(f.media.layout.sides.every(side => side.durationMs !== undefined && Number.isFinite(side.durationMs))).toBe(true)
  await expect.poll(readWorkbenchSides).toEqual(expectedSides)
  await page.getByText('版本、Logic 与计划', { exact: true }).click()
  await page.getByRole('button', { name: '计划与预检', exact: true }).click()
  const panel = page.getByTestId('recording-plan-panel')
  await panel.getByRole('button', { name: '查看计划第 1 版', exact: true }).click()
  await panel.getByRole('button', { name: '重新执行只读预检', exact: true }).click()
  await expect(panel).toContainText('BACKEND_NOT_CERTIFIED')
  await expect(page.getByTestId('recording-attempt-panel').getByRole('button', { name: '开始正式录音', exact: true })).toBeDisabled()
  await page.screenshot({ path: test.info().outputPath('main-journey-default-gate-b-blocked.png') })
  const workspace = await page.evaluate(id => window.musicBridge.getRecordingWorkspaceContext(id), f.draft.draftId)
  expect(workspace?.selection).toMatchObject({ planId: f.media.id, layoutId: f.layout.id, path: 'direct' })
  const beforeOutbox = await page.evaluate(() => window.musicBridge.getCommandOutbox())
  await writeFile(test.info().outputPath('main-journey-identities.json'), JSON.stringify({ identity, plan, preflight, workspace }, null, 2))
  await close(); await launch()
  const reopened = await page.evaluate(async draftId => ({
    draft: await window.musicBridge.getMasterDraft(draftId), sources: await window.musicBridge.getDraftSources(draftId),
    versions: await window.musicBridge.listMasterVersions(draftId), session: await window.musicBridge.getRecordingSession(draftId),
    assets: await window.musicBridge.listExecutionAssets(draftId), archives: await window.musicBridge.listArchives(draftId),
  }), f.draft.draftId)
  expect(reopened).toEqual(identity)
  expect((await page.evaluate(id => window.musicBridge.getRecordingPlanVersion(id), plan.id)).plan).toEqual(plan)
  expect(await page.evaluate(id => window.musicBridge.getRecordingWorkspaceContext(id), f.draft.draftId)).toEqual(workspace)
  expect((await page.evaluate(() => window.musicBridge.listRecordingAttempts({ page: { offset: 0, limit: 25 } }))).total).toBe(0)
  expect(await page.evaluate(() => window.musicBridge.getCommandOutbox())).toEqual(beforeOutbox)
  await expect(page.evaluate(request => window.musicBridge.beginRecordingAttempt(request), begin)).rejects.toThrow(/NOT_READY/u)
  expect(await readFile(f.sourceFile)).toEqual(f.bytes)
  expect(await page.evaluate(() => window.musicBridge.getRecordingOutputStatus())).toMatchObject({ deviceAccess: 'not-authorized', gateB: 'NOT_RUN', formalReady: false })
  await page.locator('[data-sidebar-source="recording"]').click()
  await page.getByRole('button', { name: /^计划与预检合成草稿 /u }).click()
  await page.getByRole('button', { name: '关闭计划与预检', exact: true }).click()
  await expect.poll(readWorkbenchSides).toEqual(expectedSides)
})
