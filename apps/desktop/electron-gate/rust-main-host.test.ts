import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { _electron as electron, type ElectronApplication, type Page as ElectronPage } from '@playwright/test'
import type { CollectionModel, Page } from '@music-bridge/contracts'
import { testElectronArguments } from '../scripts/test-keychain.mjs'
import { waitForMainWindow } from '../e2e/main-window.js'
import { buildRoot, manifest, manifestPath, manifestSha256, count, dispatchCounts, naturalResources, scrubbedEnvironment, until, type HostSnapshot, type HostObservation } from '../test/helpers/rust-main-background-evidence.js'

interface MainEvidence { observations: HostObservation[]; main: Record<string, unknown>[]; final: HostSnapshot; coreExit: number; rustConfigured: boolean }
const reports: Record<string, unknown>[] = []
const require = createRequire(import.meta.url), electronPackage = path.dirname(require.resolve('electron/package.json'))
const electronPathFile = path.join(electronPackage, 'path.txt')
assert.ok(existsSync(electronPathFile), '真实Electron依赖未准备；禁止测试隐式下载或安装。')
const electronExecutable = path.join(electronPackage, 'dist', readFileSync(electronPathFile, 'utf8').trim())
assert.ok(existsSync(electronExecutable), '真实Electron可执行文件缺失；不能用Worker代替此Gate。')
async function control(application: ElectronApplication, operation: string, parameters: Record<string, unknown> = {}) {
  return application.evaluate(async (_electron, input) => {
    const host = (globalThis as typeof globalThis & { __rust008Host: { control(operation: string, parameters?: unknown): Promise<unknown> } }).__rust008Host
    return host.control(input.operation, input.parameters)
  }, { operation, parameters })
}
async function launch(t: test.TestContext, rust: boolean) {
  const tick = performance.now()
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-ui-e2e-rust-main-'))
  const application = await electron.launch({ executablePath: electronExecutable, args: testElectronArguments([path.join(buildRoot, 'main', rust ? 'private-rust-main-wrapper.mjs' : 'private-rust-node-main-wrapper.mjs')], 'mock'),
    cwd: path.resolve('.'), timeout: 60_000,
    env: Object.fromEntries(Object.entries(scrubbedEnvironment({ MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR: directory, MUSIC_BRIDGE_UI_E2E_LIFECYCLE_TRACE: '1' })).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
  })
  let processOutput = ''
  application.process().stderr?.on('data', chunk => { processOutput += String(chunk) })
  application.process().stdout?.on('data', chunk => { processOutput += String(chunk) })
  let closed = false
  async function close(): Promise<MainEvidence> {
    assert.equal(closed, false); closed = true
    const owned = application.process()
    const result = owned.exitCode !== null || owned.signalCode !== null ? Promise.resolve({ code: owned.exitCode, signal: owned.signalCode })
      : new Promise<{ code: number | null; signal: string | null }>(resolve => owned.once('close', (code, signal) => resolve({ code, signal })))
    await application.evaluate(({ app }) => { app.quit() }).catch(() => undefined)
    await until(() => owned.exitCode !== null || owned.signalCode !== null, '真实Electron自然退出', 30_000)
    const exit = await result
    assert.deepEqual(exit, { code: 0, signal: null }, 'Electron必须正常退出，不能由Playwright强杀取得绿灯。')
    const evidence = JSON.parse(await readFile(path.join(directory, 'rust008-main-evidence.json'), 'utf8')) as MainEvidence
    assert.equal(evidence.coreExit, 0); assert.equal(evidence.main.filter(value => value.event === 'main.coreFork').length, 1)
    assert.equal(evidence.main.filter(value => value.event === 'main.coreExit').length, 1)
    const coreSpawn = evidence.main.find(value => value.event === 'main.coreSpawn')!
    assert.ok(typeof coreSpawn.pid === 'number' && coreSpawn.pid > 0)
    assert.equal(evidence.final.observations.find(value => value.event === 'node.spawn')!.hostPid, coreSpawn.pid)
    assert.ok(evidence.final, '真实 Main 退出前必须持久保存Core最终资源观察。')
    return evidence
  }
  t.after(async () => { if (!closed) await close() })
  let page: ElectronPage
  try {
    page = await waitForMainWindow(application)
    await page.waitForFunction(async () => (await window.musicBridge.getCoreHealth()).runtime === 'ready')
    await until(async () => count(await control(application, 'status') as HostSnapshot, 'node.claimComplete') >= 2, '真实 Main 默认打印worker两次实际领取', 30_000)
  } catch (error) { t.diagnostic(`真实Electron启动日志：${processOutput}`); throw error }
  const runtimeVersions = await application.evaluate(() => ({ node: process.versions.node, electron: process.versions.electron, chrome: process.versions.chrome }))
  t.diagnostic(`真实 Electron 离线合成profile：${directory}`)
  return { directory, application, page, close, electronPid: application.process().pid, runtimeVersions, elapsedMs: () => performance.now() - tick }
}

test('真实 Electron 生产 Main 默认 Node：后台初始化零 Rust/零私有导出', { timeout: 120_000 }, async t => {
  const f = await launch(t, false)
  const snapshot = await control(f.application, 'status') as HostSnapshot
  assert.equal(snapshot.rustConfigured, false); assert.equal(snapshot.controller, undefined)
  assert.equal(count(snapshot, 'rust.spawn'), 0)
  assert.equal(count(snapshot, 'node.export') + count(snapshot, 'node.exportLarge') + count(snapshot, 'node.exportPlain'), 0)
  assert.ok(snapshot.observations.filter(value => value.event === 'node.dispatch' && value.command === 'commandOutbox.context').length >= 2)
  assert.ok(snapshot.observations.filter(value => value.event === 'node.claimComplete' && value.leaseNull).length >= 2)
  const page = await f.page.evaluate(() => window.musicBridge.listCollection({ offset: 0, limit: 100 }))
  assert.deepEqual(page, await control(f.application, 'oracleList'))
  const evidence = await f.close()
  reports.push({ scenario: 'default-node-real-Main', directory: f.directory, models: page.total, nullClaimCount: count(evidence.final, 'node.claimComplete'),
    exportCount: 0, electronPid: f.electronPid, runtimeVersions: f.runtimeVersions, dispatchCounts: dispatchCounts(evidence.final), completeSceneElapsedMs: f.elapsedMs(),
    resources: naturalResources(evidence.final, 0), main: evidence.main, observations: evidence.final.observations,
    actualLayers: ['Electron', 'Main-index', 'CoreSupervisor', 'utilityProcess', 'sharedDesktopCoreHost', 'production-DatasetOwner-entry', 'preload', 'actual-recordingPrintWorker'], mockKeychain: true })
})

test('真实 Electron 生产 Main 可选 Rust：初始化保持、原 preload durable outbox 单写、可信刷新后空轮询保持', { timeout: 120_000 }, async t => {
  const f = await launch(t, true)
  const initial = await control(f.application, 'status') as HostSnapshot
  assert.equal(initial.controller?.phase, 'ready'); assert.equal(initial.controller?.router?.phase, 'rust')
  assert.equal(count(initial, 'rust.spawn'), 1); assert.equal(count(initial, 'rust.exit'), 0)
  const delivered = initial.observations.find(value => value.event === 'host.delivered')!
  assert.equal(delivered.frozen, true); assert.deepEqual(delivered.keys, ['refresh', 'invalidate', 'getStatus'])
  assert.ok(delivered.sequence < initial.observations.find(value => value.event === 'node.prepare')!.sequence)
  assert.ok(initial.observations.filter(value => value.event === 'node.claimComplete' && value.leaseNull).length >= 2)
  assert.ok(initial.observations.filter(value => value.event === 'node.dispatch' && value.command === 'commandOutbox.context').length >= 2)
  const first = await f.page.evaluate(() => window.musicBridge.listCollection({ offset: 0, limit: 100 }))
  assert.equal(first.total, 100); assert.deepEqual(first, await control(f.application, 'oracleList'))
  assert.deepEqual((await control(f.application, 'status') as HostSnapshot).controller, initial.controller)
  const model = first.items[0]!, commandId = randomUUID()
  const mutation = await f.page.evaluate(async input => window.musicBridge.setCollectionPolicy(input), {
    commandId, modelId: model.id, expectedRevision: model.revision, collectorPolicy: 'collector' as const, minimumSealedReserve: 1,
  })
  assert.equal(mutation.modelId, model.id)
  const afterWrite = await control(f.application, 'status') as HostSnapshot
  assert.equal(afterWrite.controller?.router?.phase, 'stale')
  assert.equal(afterWrite.observations.filter(value => value.event === 'node.dispatch' && value.command === 'commandOutbox.execute').length, 1)
  assert.equal(count(afterWrite, 'rust.spawn'), 1)
  assert.equal(count(afterWrite, 'node.export') + count(afterWrite, 'node.exportLarge'), 1)
  assert.deepEqual(await f.page.evaluate(() => window.musicBridge.listCollection({ offset: 0, limit: 100 })), await control(f.application, 'oracleList'))
  const refreshed = await control(f.application, 'refresh') as HostSnapshot
  assert.equal(refreshed.controller?.router?.phase, 'rust'); assert.equal(count(refreshed, 'rust.spawn'), 2)
  const claims = count(refreshed, 'node.claimComplete')
  await until(async () => count(await control(f.application, 'status') as HostSnapshot, 'node.claimComplete') >= claims + 2, '可信刷新后真实Main两次空领取')
  const retained = await control(f.application, 'status') as HostSnapshot
  assert.deepEqual(retained.controller, refreshed.controller); assert.equal(count(retained, 'rust.spawn'), 2)
  assert.deepEqual(await f.page.evaluate(() => window.musicBridge.listCollection({ offset: 0, limit: 100 })), await control(f.application, 'oracleList'))
  const evidence = await f.close()
  // Main 持有 outbox 排他连接；自然关闭后再直接读取同一持久账本，不绕过原服务。
  const outbox = new DatabaseSync(path.join(f.directory, 'data', 'command-outbox.v1.sqlite'), { readOnly: true })
  const stored = outbox.prepare('SELECT e.command_id,s.state,s.acknowledged FROM outbox_entries e JOIN outbox_states s ON s.id=e.id WHERE command_id=?').all(commandId)
  assert.equal(stored.length, 1); assert.equal(stored[0]!.state, 'succeeded'); assert.equal(stored[0]!.acknowledged, 1); outbox.close()
  const spawns = evidence.final.observations.filter(value => value.event === 'rust.spawn'), exits = evidence.final.observations.filter(value => value.event === 'rust.exit')
  assert.ok(exits[0]!.sequence < spawns[1]!.sequence)
  reports.push({ scenario: 'explicit-rust-real-Main-outbox-refresh', directory: f.directory, models: first.total, differentialPages: 3,
    initialStatus: initial.controller, afterWriteStatus: afterWrite.controller, refreshedStatus: refreshed.controller,
    initialNullClaimCount: count(initial, 'node.claimComplete'), postRefreshNullClaimCount: count(retained, 'node.claimComplete') - claims,
    nodeOutboxExecuteCount: 1, outboxSucceededRows: 1, outboxAcknowledgedRows: 1, electronPid: f.electronPid, runtimeVersions: f.runtimeVersions,
    dispatchCounts: dispatchCounts(evidence.final), completeSceneElapsedMs: f.elapsedMs(),
    resources: naturalResources(evidence.final, 2), main: evidence.main, observations: evidence.final.observations, mockKeychain: true,
    actualLayers: ['Electron', 'Main-index', 'CoreSupervisor', 'utilityProcess', 'sharedDesktopCoreHost', 'production-DatasetOwner-entry', 'original-preload-outbox', 'Main-durable-outbox-service-executor', 'actual-recordingPrintWorker'],
    collectionUiAdmission: 'NOT_CLAIMED：停留默认主页，未审定collectionProgress.current仍保守失效' })
})

test('保存真实 Electron/Main 独立冻结报告', async () => {
  assert.equal(reports.length, 2)
  const output = process.env.MUSIC_BRIDGE_RUST_ELECTRON_REPORT
  assert.ok(output && path.isAbsolute(output), '真实Electron Gate必须保存完整报告。')
  await writeFile(output, JSON.stringify({ schemaVersion: 1, task: 'RUST-008', evidenceLayer: 'real-Electron-production-Main', sourceSha: manifest.sourceSha,
    sourceAggregateSha256: manifest.sourceAggregateSha256, artifactManifestPath: manifestPath, artifactManifestSha256: manifestSha256, artifacts: manifest.artifacts, sources: manifest.sources,
    binaryPath: manifest.binaryPath, binarySha256: manifest.binarySha256, nodeVersion: process.version, scenarios: reports, productionDefault: 'Node',
    coverage: '真实Electron与生产Main组件/生产Owner入口，共享adapter；Bridge Provider/Roon运行时使用明确合成test mode。',
    costs: '5/10ms观测轮询不是精确Core计时；真实Electron场景没有性能推广。', realProvider: 'NOT_RUN', realRoon: 'NOT_RUN', realAccount: 'NOT_RUN',
    realAudioRecording: 'NOT_RUN', pdfDevice: 'NOT_RUN', systemKeychain: 'NOT_RUN', installedApplication: 'NOT_CHANGED', ownerAcceptance: 'NOT_RUN' }, null, 2) + '\n')
})
