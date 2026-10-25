import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isMainThread, MessageChannel, type MessagePort, parentPort, Worker, workerData } from 'node:worker_threads'
import { CoreSupervisor, type CoreChildProcess, type CoreMessagePort } from '../src/main/core-supervisor.js'
import { attachCoreRuntimePort } from '../../../packages/bridge-core/src/utility-main.js'
import { createTestBridgeRuntime } from '../../../packages/bridge-core/src/runtime.js'
import { createDatasetOwnerClient } from '../../../packages/bridge-core/src/collection/dataset-owner-client.js'
import { attachDatasetOwnerWorkerPort } from '../../../packages/bridge-core/src/collection/dataset-owner-worker.js'
import { prepareOwnedDatasetDomain } from '../../../packages/bridge-core/src/collection/dataset-domain.js'
import { openCollectionDataset } from '../../../packages/bridge-core/src/recording/restore-dataset-runtime.js'
import { authorizeSourceDirectory } from '../../../packages/bridge-core/src/recording/source-files.js'
import { RUST_MEDIA_METADATA_PARSER_VERSION, type MetadataReaderPort } from '../../../packages/bridge-core/src/library/metadata-reader-types.js'
import { closeRustMediaWorkerPool } from '../../../packages/bridge-core/src/library/rust-media-worker.js'
import type { DatasetOwnerProjectionHandler, DatasetProjectionCommand, DatasetProjectionCommandPayloads, DatasetProjectionCommandResults } from '../../../packages/bridge-core/src/collection/dataset-owner-protocol.js'

function errorShape(error: unknown): unknown {
  return error instanceof Error ? { name: error.name, message: error.message, stack: error.stack,
    ...('cause' in error ? { cause: errorShape(error.cause) } : {}),
    ...(error instanceof AggregateError ? { errors: error.errors.map(errorShape) } : {}) } : String(error)
}

if (!isMainThread) {
  if (!parentPort) throw new Error('合成恢复 Owner 缺少真实父端口。')
  const signals = new Int32Array(workerData.signals as SharedArrayBuffer, workerData.signalsOffset * 4, 3)
  const record = (stage: string, error?: unknown): void => appendFileSync(workerData.evidence,
    `${JSON.stringify({ stage, ...(error === undefined ? {} : { error: errorShape(error) }) })}\n`)
  const reader: MetadataReaderPort = {
    async read(input, signal) {
      const fd = await open(path.join(input.root.path, input.relative), 'r')
      Atomics.add(signals, 0, 1)
      try {
        if (!signal?.aborted) await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }))
        Atomics.add(signals, 1, 1)
        return { status: 'failure', code: 'CANCELLED', readEvidence: null }
      } finally { await fd.close(); Atomics.add(signals, 2, 1); record('reader.fd-closed') }
    },
    async close() { record('reader.closed') },
  }
  attachDatasetOwnerWorkerPort(parentPort, {
    async prepare(epoch, projection) {
      const domain = await prepareOwnedDatasetDomain({ dataDirectory: workerData.dataDirectory,
        epoch, projection, testMode: true, scanMetadataReader: reader })
      const closeScan = domain.localScan.close.bind(domain.localScan)
      domain.localScan.close = async () => {
        record('scan.close.start')
        try { await closeScan(); record('scan.close.complete') }
        catch (error) { record('scan.close.error', error); throw error }
      }
      return { ...domain, async close(before: Parameters<typeof domain.close>[0]) {
        record('domain.close.start')
        try { await domain.close(before); record('domain.close.complete') }
        catch (error) { record('domain.close.error', error); throw error }
      } }
    },
  })
} else {
  after(closeRustMediaWorkerPool)

  class Port implements CoreMessagePort {
    constructor(readonly raw: MessagePort) {}
    on(_event: 'message', listener: (event: { data: unknown }) => void): void { this.raw.on('message', data => listener({ data })) }
    start(): void { this.raw.start() }
    close(): void { this.raw.close() }
    postMessage(message: unknown): void { this.raw.postMessage(message) }
  }

  async function until(predicate: () => boolean, description: string): Promise<void> {
    const deadline = performance.now() + 8_000
    while (!predicate()) {
      assert.ok(performance.now() < deadline, description)
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }

  test('V4：冷恢复 running/0 扫描后真实 Owner 与读取许可在 supervisor 重启时关闭', { timeout: 20_000 }, async t => {
    const temporary = process.env.TMPDIR
    assert.ok(temporary && path.isAbsolute(temporary))
    if (process.platform === 'darwin') assert.ok(temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'))
    assert.ok((await lstat(temporary)).isDirectory())
    const directory = await mkdtemp(path.join(temporary, 'musicbridge-scan-restart-'))
    const evidence = path.join(directory, 'owner-events.jsonl'), media = path.join(directory, 'media'), dataDirectory = path.join(directory, 'data')
    await mkdir(media, { mode: 0o700 }); await mkdir(dataDirectory, { mode: 0o700 })
    await writeFile(path.join(media, '自有音频.wav'), await readFile(new URL('../../../packages/bridge-core/test/fixtures/mbrs003/audio/fixtures/core-wav.wav', import.meta.url)), { flag: 'wx', mode: 0o600 })
    const seed = await openCollectionDataset(dataDirectory)
    const source = seed.repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media))
    const root = seed.repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' })
    const pending = seed.repository.localScan.start({ commandId: randomUUID(), datasetId: seed.datasetId,
      libraryRootId: root.id, expectedRootRevision: root.revision, parserVersion: RUST_MEDIA_METADATA_PARSER_VERSION }).job
    const running = seed.repository.localScan.resume({ commandId: randomUUID(), jobId: pending.jobId, expectedRevision: pending.jobRevision })
    assert.equal(running.phase, 'running'); assert.deepEqual(running.progress, { visited: '0', accepted: '0', rejected: '0' })
    seed.commit(); seed.close()

    const signals = new Int32Array(new SharedArrayBuffer(24))
    const channels: Port[] = [], workers: Worker[] = [], failures: unknown[] = [], projections: string[] = []
    const runtimes: ReturnType<typeof createTestBridgeRuntime>[] = []
    const endpoints: ReturnType<typeof createDatasetOwnerClient>[] = []
    const lifecycle: string[] = []
    let forks = 0
    const supervisor = new CoreSupervisor({ entryPath: '合成-不启动应用', cwd: directory, requestTimeoutMs: 2_000,
      startupTimeoutMs: 8_000, playbackEventProtocol: null, onLifecycle: event => lifecycle.push(event.event), dependencies: {
        createChannel() { const channel = new MessageChannel(), first = new Port(channel.port1), second = new Port(channel.port2); channels.push(first, second); return { port1: first, port2: second } },
        fork() {
          forks++
          const signalsOffset = (forks - 1) * 3
          const listeners: Array<(code: number) => void> = []
          let exited = false
          const exit = () => { if (exited) return; exited = true; for (const listener of listeners.splice(0)) listener(0) }
          const child: CoreChildProcess = {
            once(_event, listener) { listeners.push(listener) },
            kill() { throw new Error('集成 fixture 不用 kill 伪造 Owner 静止。') },
            postMessage(_message, transfer) {
              const utility = (transfer?.[0] as Port).raw
              const main = channels.at(-1)!.raw
              void (async () => {
                const worker = new Worker(new URL(import.meta.url), { execArgv: ['--import', 'tsx'], workerData: { dataDirectory, signals: signals.buffer, signalsOffset, evidence } })
                workers.push(worker)
                let runtime: ReturnType<typeof createTestBridgeRuntime> | undefined
                const projection: DatasetOwnerProjectionHandler = async <K extends DatasetProjectionCommand>(command: K, payload: DatasetProjectionCommandPayloads[K], context: Parameters<DatasetOwnerProjectionHandler>[2]): Promise<DatasetProjectionCommandResults[K]> => {
                  projections.push(command)
                  const admission = runtime?.getDatasetScanReadAdmission?.()
                  assert.ok(admission); assert.ok(context.datasetId)
                  const scope = { epoch: context.epoch, datasetId: context.datasetId }
                  let result: unknown
                  if (command === 'scanReadAcquire') result = admission.acquire(scope)
                  else if (command === 'scanReadWatchRevocation') result = await admission.watchRevocation(scope, (payload as { permitId: string }).permitId)
                  else if (command === 'scanReadRelease') result = admission.release(scope, (payload as { permitId: string }).permitId)
                  else throw new Error('此合成 fixture 只允许真实扫描读取许可。')
                  return result as DatasetProjectionCommandResults[K]
                }
                const endpoint = createDatasetOwnerClient({ worker, projection, onFatal: reason => failures.push({ stage: 'owner.fatal', reason }) })
                endpoints.push(endpoint)
                await endpoint.prepare()
                runtime = createTestBridgeRuntime({ datasetOwnerEndpoint: endpoint }); runtimes.push(runtime)
                let shutdownId: unknown
                // 真实消息必须先到 Main 并消费原 ACK；Utility 发出消息不等于 Main 已收到。
                main.on('message', (reply: { id?: unknown; ok?: unknown }) => {
                  if (reply.id === shutdownId && reply.ok === true) setImmediate(exit)
                })
                await attachCoreRuntimePort({
                  on(_event, listener) { utility.on('message', data => { if ((data as { command?: unknown }).command === 'core.shutdown') shutdownId = (data as { id: unknown }).id; listener({ data }) }) },
                  start() { utility.start() },
                  postMessage(message) {
                    const reply = message as { id?: unknown; ok?: unknown; error?: unknown }
                    if (reply.id === shutdownId && reply.ok === false) failures.push({ stage: 'core.shutdown.reply', error: reply.error })
                    utility.postMessage(message)
                  },
                }, runtime, { beforeReady: () => endpoint.commitBoot() })
              })().catch(error => failures.push({ stage: 'core.bootstrap', error: errorShape(error) }))
            },
          }
          return child
        },
      } })
    t.diagnostic(`私有证据：${evidence}`)
    t.after(async () => {
      try { await supervisor.shutdown() } catch (error) { failures.push({ stage: 'cleanup.shutdown', error: errorShape(error) }) }
      for (const runtime of runtimes) try { await runtime.shutdown() } catch { /* 失败仍由原断言和证据记录。 */ }
      for (const channel of channels) channel.close()
      for (const worker of workers) worker.unref()
    })
    await supervisor.start()
    // FD 已打开时，异步撤权订阅仍可能在主线程队列中；两项均就绪后才开始验证重启。
    await until(() => Atomics.load(signals, 0) > 0 && projections.includes('scanReadWatchRevocation'), '冷恢复扫描必须打开自有音频 FD，并完成真实撤权订阅。')
    assert.ok(projections.includes('scanReadAcquire')); assert.ok(projections.includes('scanReadWatchRevocation'))
    try { await supervisor.restart() }
    catch (error) {
      t.diagnostic(JSON.stringify({ first: errorShape(error), failures, forks, lifecycle, projections, counters: [...signals], ownerEvents: await readFile(evidence, 'utf8') }))
      throw error
    }
    assert.equal(supervisor.status, 'ready'); assert.equal(forks, 2)
    assert.equal(Atomics.load(signals, 0), Atomics.load(signals, 2), '重启旧 Owner 的全部实际音频 FD 必须已关闭。')
    assert.deepEqual(failures, [])
    await supervisor.shutdown()
    assert.equal(Atomics.load(signals, 3), Atomics.load(signals, 5), '第二代 Owner 的实际音频 FD 也必须已关闭。')
    for (const runtime of runtimes) assert.deepEqual(runtime.getDatasetScanReadAdmission?.().resourceCounts(), { permits: 0, revoked: 0, watches: 0, timers: 0, closed: true })
    assert.ok(endpoints.length === 2)
  })
}
