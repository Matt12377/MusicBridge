import childProcess from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { validateIpcRequest, type IpcRequest } from '@music-bridge/contracts'
import { runDesktopCoreHost } from '../src/main/core-host.js'
import { runCoreUtilityProcess, type UtilityPort } from '../../../packages/bridge-core/src/utility-main.js'
import type { DatasetOwnerEndpoint, DatasetOwnerVersionedSnapshotEndpoint, DatasetOwnerLargeSnapshotEndpoint } from '../../../packages/bridge-core/src/collection/dataset-owner-protocol.js'
import type { RustReadonlyCoreController } from '../../../packages/bridge-core/src/rust-core/host-controller.js'

declare const __RUST_COLLECTION_HOST_BINARY__: string
declare const __RUST_COLLECTION_HOST_SHA256__: string
interface PrivatePort extends UtilityPort { close?(): void }
interface Parent { once(event: 'message', callback: (event: { data: unknown; ports: PrivatePort[] }) => void): unknown }
interface Observation { sequence: number; elapsedMs: number; event: string; [key: string]: unknown }

/** 配置由各编译入口的静态参数与编译常量固定，父消息/环境不能选择 Rust。 */
export async function startPrivateDesktopHost(rust: boolean, models: number, large = false): Promise<void> {
  if (process.env.MUSIC_BRIDGE_CORE_TEST_MODE !== '1' || process.env.MUSIC_BRIDGE_UI_E2E !== '1') throw new Error('隔离宿主只接受合成环境。')
  const parent = (process as unknown as { parentPort?: Parent }).parentPort
  if (!parent) throw new Error('隔离宿主缺少可信父端口。')
  function validateBootstrap(event: { data: unknown; ports: PrivatePort[] }): void {
    const { data, ports } = event
    if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('隔离宿主启动消息无效。')
    const message = data as Record<string, unknown>
    if (message.type !== 'musicbridge.core.port'
      || Object.keys(message).some(key => !['type', 'playbackEventProtocol', 'relocationMainPort'].includes(key))
      || (message.playbackEventProtocol !== undefined && message.playbackEventProtocol !== 'compact-v1')
      || (message.relocationMainPort !== undefined && message.relocationMainPort !== 'local-relocation-main-port-v1')) {
      throw new Error('隔离宿主启动消息无效。')
    }
    const hasRelocationPort = message.relocationMainPort === 'local-relocation-main-port-v1'
    if (!Array.isArray(ports) || !(hasRelocationPort ? [3, 4] : [2, 3]).includes(ports.length)
      || Array.from(ports).some(port => typeof port !== 'object' || port === null || Array.isArray(port))
      || new Set(ports).size !== ports.length) throw new Error('隔离宿主启动端口集合无效。')
  }
  const observations: Observation[] = [], tick = performance.now()
  let sequence = 0, controlPort: PrivatePort | undefined, controller: RustReadonlyCoreController | undefined
  let shutdownId: string | undefined
  const requests = new Map<string, IpcRequest>()
  const approved = new Set(['collection.list','collection.detail','collection.copy','collection.photo','collectionProgress.modelLengths','collectionProgress.current','collectionProgress.wants','collectionProgress.wantHistory','collectionProgress.snapshots','collectionProgress.snapshot','referenceCatalog.sources','referenceCatalog.history','referenceCatalog.revision','referenceCatalog.snapshot','referenceCatalog.source','referenceCatalog.sourceZipReceipts'])
  let exportHold = false, releaseExport: (() => void) | undefined
  const frameRequests = new Map<string, string>()
  let rawOwner: (DatasetOwnerEndpoint & Partial<DatasetOwnerVersionedSnapshotEndpoint & DatasetOwnerLargeSnapshotEndpoint>) | undefined
  const observe = (event: string, values: Record<string, unknown> = {}) => {
    const item = { sequence: ++sequence, elapsedMs: performance.now() - tick, event, ...values }
    observations.push(item); controlPort?.postMessage({ type: 'rust009.observation', value: item })
  }
  const status = () => ({ rustConfigured: rust, configuredModels: models, observations: [...observations],
    ...(controller ? { controller: controller.getStatus() } : {}) })
  const spawn = childProcess.spawn, children = new Map<number, ReturnType<typeof spawn>>()
  childProcess.spawn = ((...args: Parameters<typeof spawn>) => {
    if (args[0] !== __RUST_COLLECTION_HOST_BINARY__) throw new Error('隔离宿主只能启动固定 Rust 二进制。')
    const child = spawn(...args)
    const write = child.stdin!.write.bind(child.stdin!)
    child.stdin!.write = ((chunk: unknown, ...rest: unknown[]) => {
      const frame = JSON.parse(String(chunk)) as { requestId: string; payload?: { request?: IpcRequest } }
      if (frame.payload?.request) frameRequests.set(frame.requestId, frame.payload.request.id)
      return (write as (...args: unknown[]) => boolean)(chunk, ...rest)
    }) as NonNullable<typeof child.stdin>['write']
    if (child.pid !== undefined) children.set(child.pid, child)
    observe('rust.spawn', { pid: child.pid, liveChildren: children.size })
    let buffered = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      buffered += chunk.toString()
      while (buffered.includes('\n')) {
        const index = buffered.indexOf('\n'), frame = JSON.parse(buffered.slice(0, index)) as { operation: string; ok: boolean; requestId: string; epoch: string; datasetId: string; snapshotId: string }
        buffered = buffered.slice(index + 1)
        observe('rust.frame', { pid: child.pid, operation: frame.operation, ok: frame.ok, frameRequestId: frame.requestId, requestId: frameRequests.get(frame.requestId), scope: { epoch: frame.epoch, datasetId: frame.datasetId, snapshotId: frame.snapshotId }, generation: controller?.getStatus().router?.generation })
      }
    })
    child.once('close', (code, signal) => {
      if (child.pid !== undefined) children.delete(child.pid)
      observe('rust.exit', { pid: child.pid, code, signal, liveChildren: children.size })
    })
    return child
  }) as typeof spawn
  parent.once('message', event => {
    validateBootstrap(event)
    controlPort = event.ports[event.ports.length - 1]
    if (!controlPort) throw new Error('隔离宿主缺少独立的可信观察端口。')
    controlPort.on('message', event => {
      const value = event.data as Record<string, unknown>
      if (!value || typeof value !== 'object' || typeof value.id !== 'string'
        || Object.keys(value).some(key => !['id', 'operation', 'request'].includes(key))
        || !['status', 'refresh', 'invalidate', 'oracle', 'armExport', 'releaseExport'].includes(String(value.operation))) {
        controlPort?.postMessage({ type: 'rust009.reply', id: value?.id, ok: false, code: 'INVALID_REQUEST' }); return
      }
      void (async () => {
        let result: unknown
        if (value.operation === 'status') result = status()
        else if (value.operation === 'armExport') { exportHold = true; result = status() }
        else if (value.operation === 'releaseExport') { releaseExport?.(); result = status() }
        else if (value.operation === 'oracle') {
          if (!rawOwner) throw Object.assign(new Error('尚未准备。'), { code: 'NOT_READY' })
          const checked = validateIpcRequest(value.request)
          if (!checked.ok || !approved.has(checked.value.command)) throw Object.assign(new Error('参照读取格式无效。'), { code: 'INVALID_REQUEST' })
          const data = await rawOwner.dispatch(checked.value)
          result = { version: 1, id: checked.value.id, ok: true, result: data }
        } else {
          if (!controller) throw Object.assign(new Error('未交付控制能力。'), { code: 'NOT_READY' })
          if (value.operation === 'refresh') { observe('host.explicitRefresh'); await controller.refresh() }
          if (value.operation === 'invalidate') controller.invalidate()
          observe('host.controlComplete', { operation: value.operation, status: controller.getStatus() })
          result = status()
        }
        controlPort?.postMessage({ type: 'rust009.reply', id: value.id, ok: true, result })
      })().catch(error => {
        const codes = ['CLOSING', 'NOT_READY', 'STALE_SNAPSHOT', 'INVALID_REQUEST', 'TIMEOUT', 'PROCESS_EXIT', 'SNAPSHOT_UNAVAILABLE']
        controlPort?.postMessage({ type: 'rust009.reply', id: value.id, ok: false, code: codes.includes(error?.code) ? error.code : 'SNAPSHOT_UNAVAILABLE' })
      })
    })
    controlPort.start()
    const publicPort = event.ports[0]!
    publicPort.on('message', event => {
      const request = event.data as Partial<IpcRequest>
      if (typeof request.command === 'string') observe('core.publicRequest', { command: request.command, requestId: request.id, ...((approved.has(request.command) || request.command === 'commandOutbox.execute') ? { request: structuredClone(request), status: controller?.getStatus() } : {}) })
      if (typeof request.id === 'string' && typeof request.command === 'string') requests.set(request.id, request as IpcRequest)
      if (request.command === 'core.shutdown') shutdownId = request.id
    })
    const post = publicPort.postMessage.bind(publicPort)
    publicPort.postMessage = message => {
      const value = message as { event?: string; id?: string; ok?: boolean; result?: { lease?: unknown } }
      if (value.event === 'core.ready') observe('core.ready')
      if (value.id) {
        const command = requests.get(value.id)?.command; requests.delete(value.id)
        observe('core.publicReply', { requestId: value.id, command, ok: value.ok, ...(command && (approved.has(command) || command === 'commandOutbox.execute') ? { reply: structuredClone(message) } : {}),
          ...(command === 'recordingPrintWorker.claim' ? { leaseNull: value.ok === true && value.result?.lease === null } : {}) })
      }
      if (value.id === shutdownId && value.ok) {
        if (controller) observe('host.closedStatus', { status: controller.getStatus() })
        controlPort?.postMessage({ type: 'rust009.final', value: status() })
      }
      post(message)
    }
  })
  async function holdExport() {
    if (!exportHold) return
    exportHold = false; observe('host.exportHeld')
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { releaseExport = undefined; reject(new Error('受控导出等待超时。')) }, 9000)
      releaseExport = () => { clearTimeout(timeout); releaseExport = undefined; observe('host.exportReleased'); resolve() }
    })
  }
  const observedUtility: typeof runCoreUtilityProcess = (...args) => {
    const originalFactory = args[5]
    if (!originalFactory) throw new Error('共享 adapter 未提供生产 Owner factory。')
    args[5] = factoryOptions => {
      const client = originalFactory(factoryOptions) as NonNullable<typeof rawOwner>
      rawOwner = client
      const wrapped: NonNullable<typeof rawOwner> = {
        ...client,
        async prepare() { observe('node.prepare'); const identity = await client.prepare(); observe('node.prepared', { identity }); return identity },
        async commitBoot() {
          observe('node.boot'); await client.commitBoot()
          const identity = await client.prepare()
          const original = await client.dispatch({ version: 1, id: randomUUID(), command: 'collection.list', payload: { page: { offset: 0, limit: 1 } }, expectedDatasetId: identity.datasetId }) as { total: number }
          if (original.total !== models) throw new Error('启动前合成库规模与静态入口不一致。')
          observe('node.seeded', { models, writer: 'Node-before-Main', existingSynthetic: true })
          observe('node.bootComplete')
        },
        async dispatch(request) {
          observe('node.dispatch', { command: request.command, requestId: request.id })
          const result = await client.dispatch(request)
          if (request.command === 'recordingPrintWorker.claim') observe('node.claimComplete', { requestId: request.id, leaseNull: Boolean(result && typeof result === 'object' && 'lease' in result && result.lease === null) })
          return result
        },
        async close() { observe('node.close'); await client.close(); observe('node.closed') },
      }
      if (client.getCollectionSnapshotVersion) wrapped.getCollectionSnapshotVersion = async () => { observe('node.version'); return client.getCollectionSnapshotVersion!() }
      if (client.exportCollectionSnapshot) wrapped.exportCollectionSnapshot = async () => { observe('node.exportPlain'); return client.exportCollectionSnapshot!() }
      if (client.exportVersionedCollectionSnapshot) wrapped.exportVersionedCollectionSnapshot = async () => { observe('node.export'); const result = await client.exportVersionedCollectionSnapshot!(); await holdExport(); return result }
      if (client.exportLargeVersionedCollectionSnapshot) wrapped.exportLargeVersionedCollectionSnapshot = async () => { observe('node.exportLarge'); const result = await client.exportLargeVersionedCollectionSnapshot!(); await holdExport(); return result }
      return wrapped
    }
    // 最末端口只供观察；保留原生产端口全集，Node只读驱动没有Main源写端口。
    const once = parent.once
    parent.once = (name, listener) => once.call(parent, name, event => {
      validateBootstrap(event)
      listener({ data: event.data, ports: event.ports.slice(0, -1) })
    })
    try { return runCoreUtilityProcess(...args) } finally { parent.once = once }
  }
  await runDesktopCoreHost({ dependencies: {
    runCoreUtilityProcess: observedUtility,
    createWorker(entry, options) {
      const worker = new Worker(entry, options)
      observe('node.spawn', { threadId: worker.threadId, hostPid: process.pid, nodeVersion: process.version, entry: 'production-dataset-owner.js' })
      worker.once('exit', code => observe('node.exit', { code }))
      return worker
    },
  }, ...(rust ? { rustReadonlyCollection: { binary: { path: __RUST_COLLECTION_HOST_BINARY__, sha256: __RUST_COLLECTION_HOST_SHA256__ }, startupTimeoutMs: 30_000, requestTimeoutMs: 10_000,
    ...(large ? { snapshotProfile: 'v3-5000' as const } : {}) }, onRustReadonlyCoreController(value: RustReadonlyCoreController) {
      controller = value; observe('host.delivered', { frozen: Object.isFrozen(value), keys: Object.keys(value), status: value.getStatus() })
    } } : {}) })
}
