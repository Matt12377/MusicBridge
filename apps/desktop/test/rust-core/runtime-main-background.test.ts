/// <reference lib="es2023.array" />

// 本测试在 Node 22 运行，复用的合成夹具需要 ES2023 数组声明；不改变桌面生产编译目标。
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, cp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { MessageChannel, Worker, type MessagePort } from 'node:worker_threads'
import type { CollectionFilter, RecordingPrintLease } from '@music-bridge/contracts'
import { CoreSupervisor, type CoreMessagePort } from '../../src/main/core-supervisor.js'
import { createRecordingPrintWorker } from '../../src/main/recording-print-worker.js'
import { createCommandOutboxStore } from '../../src/main/command-outbox-store.js'
import { createCommandOutboxService } from '../../src/main/command-outbox-service.js'
import { createCommandOutboxExecutor } from '../../src/main/command-outbox-executor.js'
import { createCollectionRepository } from '../../../../packages/bridge-core/src/collection/repository.js'
import { seedRustCollection } from '../../../../packages/bridge-core/test/helpers/rust-core-collection-fixture.js'
import { recordingRecordFixture } from '../../../../packages/bridge-core/test/helpers/recording-record-fixture.js'
import { DatabaseSync } from 'node:sqlite'
import { buildRoot, manifest, manifestPath, manifestSha256, count, dispatchCounts, naturalResources, scrubbedEnvironment, until, type HostSnapshot } from '../helpers/rust-main-background-evidence.js'

const reports: Record<string, unknown>[] = []
function portAdapter(port: MessagePort): CoreMessagePort {
  return Object.assign({ on(_event: 'message', listener: (value: { data: unknown }) => void) { return port.on('message', data => listener({ data })) },
    start() { port.start() }, close() { port.close() }, postMessage(data: unknown) { port.postMessage(data) } }, { native: port })
}
async function subject(t: test.TestContext, models: number, preparedFile?: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-ui-e2e-main-components-'))
  const file = path.join(directory, 'collection.v1.sqlite')
  if (preparedFile) await cp(preparedFile, file)
  else {
    // 数据装载结束并关闭连接后才启动生产 Owner，运行阶段只有 Node Owner 写入。
    const repository = createCollectionRepository({ filePath: file }); repository.list({ offset: 0, limit: 1 }); repository.close()
    seedRustCollection(file, models)
  }
  const channel = new MessageChannel(), observations: HostSnapshot['observations'] = [], replies = new Map<string, { ok: boolean; result?: unknown; code?: string }>()
  let final: HostSnapshot | undefined, coreExit: number | undefined, forcedCleanup = false, rustBootReady: HostSnapshot | undefined
  let worker: Worker | undefined, printWorker: ReturnType<typeof createRecordingPrintWorker> | undefined
  let releaseRender: (() => void) | undefined, capturedLease: RecordingPrintLease | undefined, renderCalls = 0
  channel.port1.on('message', value => {
    if (value.type === 'rust008.observation') observations.push(value.value)
    if (value.type === 'rust008.reply') replies.set(value.id, value)
    if (value.type === 'rust008.final') final = value.value
  })
  async function control(operation: 'status' | 'refresh' | 'oracleList', parameters: Record<string, unknown> = {}) {
    const id = randomUUID(); channel.port1.postMessage({ id, operation, ...parameters })
    await until(() => replies.has(id), `受控 ${operation} 回执`)
    const result = replies.get(id)!; replies.delete(id); assert.equal(result.ok, true, result.code); return result.result
  }
  const entry = path.join(buildRoot, 'main', models === 5_000 ? 'private-rust-core-5000.js' : models === 2_000 ? 'private-rust-core-2000.js' : 'private-rust-core.js')
  const supervisor = new CoreSupervisor({ entryPath: entry, cwd: directory, playbackEventProtocol: null, requestTimeoutMs: 10_000, startupTimeoutMs: 30_000,
    env: scrubbedEnvironment({ MUSIC_BRIDGE_DATA_DIRECTORY: directory }),
    dependencies: {
      createChannel() { const main = new MessageChannel(); return { port1: portAdapter(main.port1), port2: portAdapter(main.port2) } },
      fork(entry, _args, options) {
        worker = new Worker(new URL('../helpers/rust-main-background-utility.ts', import.meta.url), {
          execArgv: ['--import', 'tsx'], env: options.env, workerData: { entry, buildRoot },
        })
        const owned = worker
        owned.once('exit', code => { coreExit = code })
        return { once(_event, listener) { return owned.once('exit', listener) }, kill() { forcedCleanup = true; void owned.terminate(); return true },
          postMessage(message, ports) {
            // CoreSupervisor 的原封闭 startup data 原样转交；第二 port 仅是测试观察能力。
            const actual = ports!.map(port => port as unknown as { native?: MessagePort })
            try {
              owned.postMessage({ type: 'rust008.bind', data: message, ports: [...actual.map(value => value.native), channel.port2] }, [...actual.map(value => value.native!), channel.port2])
            } catch (error) { t.diagnostic(`受控真实端口转交失败：${String(error)}`); throw error }
          } }
      },
    },
    onReady: async client => {
      rustBootReady = await control('status') as HostSnapshot
      const { datasetId } = await client.request('commandOutbox.context', {})
      printWorker = createRecordingPrintWorker({ datasetId,
        requestInternal: client.requestInternal.bind(client), renderer: {
          async render(lease) {
            renderCalls++; capturedLease = lease
            return new Promise((_resolve, reject) => { releaseRender = () => reject(new Error('受控场景停在渲染边界。')) })
          }, close() { releaseRender?.() },
        } })
      printWorker.start()
    },
  })
  // 仅传输适配器需要保留真正 MessagePort；不改变 Supervisor 生产逻辑。
  await supervisor.start()
  assert.equal(supervisor.status, 'ready'); assert.equal(supervisor.restarts, 0)
  const store = createCommandOutboxStore({ filePath: path.join(directory, 'command-outbox.v1.sqlite') })
  const executor = createCommandOutboxExecutor({ supervisor, async pick() { throw new Error('合成场景不得打开文件选择器。') } })
  const service = createCommandOutboxService({ store, currentDataset: async () => (await supervisor.request('commandOutbox.context', {})).datasetId, ...executor })
  let stopped = false
  async function close() {
    if (stopped) return
    await printWorker?.stop(); await supervisor.shutdown(); await service.close()
    stopped = true
    await until(() => final !== undefined && coreExit !== undefined, '受控 Core 自然退出与最终观察')
    channel.port1.close()
    assert.equal(forcedCleanup, false); assert.equal(coreExit, 0); assert.equal(supervisor.restarts, 0)
  }
  t.after(close)
  return { directory, file, supervisor, service, observations, control, close,
    get snapshot() { return final! }, get bootStatus() { return rustBootReady! }, get lease() { return capturedLease }, get renderCalls() { return renderCalls },
  }
}

for (const models of [100, 2_000, 5_000]) {
  test(`受控生产 Main 组件 ${models} 型号实际空打印轮询/outbox 单写/显式刷新完整差分`, { timeout: 120_000 }, async t => {
    const tick = performance.now()
    const f = await subject(t, models)
    await until(() => f.observations.filter(value => value.event === 'node.claimComplete' && value.leaseNull).length >= 2, '真实 print worker 至少两轮空 claim')
    const initial = await f.control('status') as HostSnapshot
    assert.equal(initial.controller?.router?.phase, 'rust'); assert.deepEqual(initial.controller, f.bootStatus.controller)
    assert.equal(f.renderCalls, 0)
    const context = await f.supervisor.request('commandOutbox.context', {})
    await f.service.list()
    let pages = 0; const filters: CollectionFilter[] = [{}, { query: '　ＳＡ　９０％　' }, { query: 'A_B%' }, { query: '中文品牌🎵' }, { brand: '　ＴＤＫ　' }, { stockState: 'needs-review' }, { stockState: 'recorded' }, { decade: 'unknown' }]
    for (const filter of filters) for (const page of [{ offset: 0, limit: 100 }, { offset: 99, limit: 3 }, { offset: models - 1, limit: 100 }, { offset: models, limit: 1 }]) {
      const expected = await f.control('oracleList', { filter, page })
      assert.deepEqual(await f.supervisor.request('collection.list', { filter, page }, context.datasetId), expected); pages++
    }
    assert.equal(pages, 32)
    const first = (await f.supervisor.request('collection.list', { page: { offset: 0, limit: 100 } }, context.datasetId)).items[0]!
    const commandId = randomUUID()
    const submission = await f.service.submit({ datasetId: context.datasetId, command: 'collection.setPolicy', payload: { commandId, modelId: first.id,
      expectedRevision: first.revision, collectorPolicy: 'collector', minimumSealedReserve: 1 } })
    assert.equal((await f.control('status') as HostSnapshot).controller?.router?.phase, 'stale')
    assert.equal((await f.service.list()).entries[0]!.state, 'succeeded')
    assert.equal(f.observations.filter(value => value.event === 'node.dispatch' && value.command === 'commandOutbox.execute').length, 1)
    assert.equal(count(await f.control('status') as HostSnapshot, 'node.export') + count(await f.control('status') as HostSnapshot, 'node.exportLarge'), 1)
    assert.deepEqual(await f.supervisor.request('collection.list', { page: { offset: 0, limit: 100 } }, context.datasetId), await f.control('oracleList'))
    f.service.ack({ id: submission.outboxId })
    const previousClaims = f.observations.filter(value => value.event === 'core.publicReply' && value.command === 'recordingPrintWorker.claim' && value.leaseNull).length
    // 保留生产1500ms轮询。明确观察下一次真实空领取后发起一次刷新，不关worker、不重放失败刷新。
    await until(() => f.observations.filter(value => value.event === 'core.publicReply' && value.command === 'recordingPrintWorker.claim' && value.leaseNull).length > previousClaims, '写后Node回退真实worker完整空领取回执')
    const beforeClaims = f.observations.filter(value => value.event === 'node.claimComplete').length
    const refreshed = await f.control('refresh') as HostSnapshot
    assert.equal(refreshed.controller?.router?.phase, 'rust')
    await until(() => f.observations.filter(value => value.event === 'node.claimComplete' && value.leaseNull).length >= beforeClaims + 2, '刷新后真实 print worker 至少两轮空 claim')
    const after = await f.control('status') as HostSnapshot
    assert.deepEqual(after.controller, refreshed.controller)
    assert.deepEqual(await f.supervisor.request('collection.list', { page: { offset: 0, limit: 100 } }, context.datasetId), await f.control('oracleList'))
    await f.close()
    reports.push({ scenario: 'controlled-Main-components-background-outbox-refresh', models, differentialPages: pages + 2, directory: f.directory,
      actualComponents: ['CoreSupervisor', 'createRecordingPrintWorker', 'CommandOutboxStore', 'CommandOutboxService', 'CommandOutboxExecutor', 'sharedDesktopCoreHost', 'productionDatasetOwnerEntry'],
      renderer: '停在render边界；空队列未调用', electron: 'NOT_RUN', initialStatus: initial.controller, refreshedStatus: refreshed.controller,
      nullClaimCount: f.observations.filter(value => value.event === 'node.claimComplete' && value.leaseNull).length,
      nodeOutboxExecuteCount: 1, dispatchCounts: dispatchCounts(f.snapshot), completeSceneElapsedMs: performance.now() - tick,
      resources: naturalResources(f.snapshot, 2, models === 5_000 ? models : undefined), observations: f.snapshot.observations })
  })
}

test('受控生产 print worker 领取新合成有效 pending job 写真实租约并失效 Rust', { timeout: 120_000 }, async t => {
  const tick = performance.now()
  const fixture = await recordingRecordFixture(t)
  const pending = await fixture.readyForFinal(); await fixture.attempts.confirm(pending.request)
  const db = new DatabaseSync(fixture.filePath, { readOnly: true })
  assert.equal(db.prepare("SELECT count(*) n FROM recording_print_jobs WHERE json_extract(data,'$.state')='pending'").get()!.n, 1); db.close()
  await fixture.attempts.close(); fixture.repository.close()
  const f = await subject(t, 100, fixture.filePath)
  await until(() => f.lease !== undefined, '真实 claim 租约进入实际 print worker render 边界')
  assert.equal(f.renderCalls, 1)
  assert.equal((await f.control('status') as HostSnapshot).controller?.router?.phase, 'stale')
  const observed = new DatabaseSync(f.file, { readOnly: true })
  assert.equal(observed.prepare("SELECT count(*) n FROM recording_print_jobs WHERE json_extract(data,'$.state')='rendering' AND lease IS NOT NULL").get()!.n, 1)
  assert.equal(observed.prepare("SELECT count(*) n FROM recording_print_events WHERE kind='claim'").get()!.n, 1); observed.close()
  assert.equal(f.observations.filter(value => value.event === 'node.dispatch' && value.command === 'recordingPrintWorker.claim').length, 1)
  await f.close()
  reports.push({ scenario: 'real-print-lease-write', directory: f.directory, validPendingJob: true, realLease: true, claimDispatchCount: 1,
    rendererCalls: 1, renderer: '仅停在render边界，未生成PDF', electron: 'NOT_RUN', realRecording: 'NOT_RUN', syntheticRecordPreparation: '新合成fixture/软件事件，非真实录音或设备',
    dispatchCounts: dispatchCounts(f.snapshot), completeSceneElapsedMs: performance.now() - tick,
    resources: naturalResources(f.snapshot, 1), observations: f.snapshot.observations })
})

test('保存受控生产 Main 组件独立证据层', async () => {
  assert.equal(reports.length, 4)
  const output = process.env.MUSIC_BRIDGE_RUST_MAIN_COMPONENT_REPORT
  assert.ok(output && path.isAbsolute(output), '组件 Gate 必须保存完整报告。')
  await writeFile(output, JSON.stringify({ schemaVersion: 1, task: 'RUST-008', evidenceLayer: 'controlled-production-Main-components',
    sourceSha: manifest.sourceSha, sourceAggregateSha256: manifest.sourceAggregateSha256, artifactManifestPath: manifestPath, artifactManifestSha256: manifestSha256, binaryPath: manifest.binaryPath, binarySha256: manifest.binarySha256,
    artifacts: manifest.artifacts, sources: manifest.sources, nodeVersion: process.version, scenarios: reports, productionDefault: 'Node',
    coverage: '实际生产Supervisor/print worker/outbox组件、共享adapter/生产Owner入口/真实Rust；transport为Node Worker适配，完整Main index/Electron/BrowserWindow/utilityProcess未运行。',
    costs: '观察轮询与SQLite参照包含在耗时内，不能推导精确Core或真实媒体库性能。', realProvider: 'NOT_RUN', realRoon: 'NOT_RUN', realAudio: 'NOT_RUN', ownerAcceptance: 'NOT_RUN' }, null, 2) + '\n')
})
