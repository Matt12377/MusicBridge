import { Worker, type WorkerOptions } from 'node:worker_threads'
import { createHash } from 'node:crypto'
import { writeSync } from 'node:fs'
import { validateIpcRequest } from '@music-bridge/contracts'
import type { DesktopCoreHostOptions } from './core-host.js'
import type { UtilityPort } from '../../../../packages/bridge-core/src/utility-main.js'
import type { DatasetOwnerEndpoint, DatasetOwnerVersionedSnapshotEndpoint, DatasetOwnerLargeSnapshotEndpoint } from '../../../../packages/bridge-core/src/collection/dataset-owner-protocol.js'
import type { RustReadonlyCoreController } from '../../../../packages/bridge-core/src/rust-core/host-controller.js'
import type { RustSidecarObservation } from '../../../../packages/bridge-core/src/rust-core/readonly-sidecar.js'
import type { RustCoreResource } from './rust-core-resource.js'
import { createPackagedRendererEvidenceWriter, parsePackagedRendererRefreshRequest } from './packaged-renderer-main-probe.js'

interface ParentPort { once(event: 'message', listener: (event: { data: unknown; ports?: UtilityPort[] }) => void): unknown }
interface CoreObserverHooks {
  dependencies: NonNullable<DesktopCoreHostOptions['dependencies']>
  onRustReadonlyCoreController?: (controller: RustReadonlyCoreController) => void
  onObservation?: (value: RustSidecarObservation) => void
  onResourceValidated?: (resource: RustCoreResource) => void
}
type SnapshotOwner = DatasetOwnerEndpoint & Partial<DatasetOwnerVersionedSnapshotEndpoint & DatasetOwnerLargeSnapshotEndpoint>
const allowed = new Set(['commandOutbox.context', 'commandOutbox.execute', 'collection.list', 'collection.detail', 'core.shutdown', 'recordingPrintWorker.claim'])

/** 候选固定 stdout 能力；由真实子进程尾丢失回归验证，不代表关闭 ACK。 */
export function createPackagedRendererCoreEvidenceSink(): (line: string) => void {
  return line => {
    const bytes = Buffer.from(line, 'utf8')
    let offset = 0
    while (offset < bytes.length) {
      const written = writeSync(1, bytes, offset, bytes.length - offset)
      if (!Number.isSafeInteger(written) || written <= 0) throw new Error('候选 Core 观察输出未完整写入。')
      offset += written
    }
  }
}

/** 候选静态入口同步安装；普通Core入口不导入，也不登记此诊断能力。 */
export function installPackagedRendererCoreObserver(mode: 'rust' | 'node', options: { parent?: ParentPort; sink?: (line: string) => void } = {}): CoreObserverHooks {
  const parent = options.parent ?? (process as typeof process & { parentPort?: ParentPort }).parentPort
  if (!parent) throw new Error('候选Core观察缺少真实父端口。')
  const emit = createPackagedRendererEvidenceWriter('core', options.sink ?? createPackagedRendererCoreEvidenceSink())
  let controller: RustReadonlyCoreController | undefined, expectedOrdinal: 1 | 2 = 1, refreshing = false, finished = false
  emit('core.diagnosticsInstalled', { mode })
  parent.once('message', event => {
    const publicPort = event.ports?.[0], diagnostic = event.ports?.[1]
    if (!publicPort || !diagnostic || event.ports?.length !== 2) throw new Error('候选需要固定公有与私有双端口。')
    const requests = new Map<string, string>()
    publicPort.on('message', ({ data }) => {
      const checked = validateIpcRequest(data)
      if (checked.ok && allowed.has(checked.value.command)) {
        requests.set(checked.value.id, checked.value.command)
        emit('core.publicRequest', { request: data, ...(controller ? { status: controller.getStatus() } : {}) })
      }
    })
    const post = publicPort.postMessage.bind(publicPort)
    publicPort.postMessage = value => {
      const packet = value as { id?: string; event?: string }
      if (packet.event === 'core.ready') emit('core.ready', { ...(controller ? { status: controller.getStatus() } : {}) })
      if (packet.id && requests.has(packet.id)) {
        const command = requests.get(packet.id); requests.delete(packet.id)
        emit('core.publicReply', { reply: value, command, ...(controller ? { status: controller.getStatus() } : {}) })
        if (command === 'core.shutdown') emit('core.closedStatus', { mode, ...(controller ? { status: controller.getStatus() } : {}) })
      }
      post(value)
    }
    diagnostic.on('message', ({ data }) => {
      const ordinal = finished || refreshing ? null : parsePackagedRendererRefreshRequest(data, expectedOrdinal)
      if (ordinal === null) {
        emit('core.diagnosticRejected')
        diagnostic.postMessage({ schemaVersion: 1, type: 'rust013.rejected', ordinal: expectedOrdinal, code: 'INVALID_REQUEST' }); return
      }
      refreshing = true
      emit('core.explicitRefreshStarted', { ordinal, mode, ...(controller ? { status: controller.getStatus() } : {}) })
      let timer: ReturnType<typeof setTimeout> | undefined
      const refresh = (async () => {
        if (mode === 'rust') {
          if (!controller) throw new Error('Rust候选尚未交付可信控制能力。')
          await controller.refresh()
        }
      })()
      // 固定桥总期限；消费迟到刷新，不把失败或超时恢复成成功。
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('候选可信刷新超过固定期限。')), 30_000)
      })
      void Promise.race([refresh, deadline]).then(() => {
        const status = controller?.getStatus()
        emit('core.explicitRefreshCompleted', { ordinal, mode, ...(status ? { status } : {}) })
        diagnostic.postMessage({ schemaVersion: 1, type: 'rust013.refreshed', ordinal, mode, ...(status ? { status } : {}) })
        if (ordinal === 1) expectedOrdinal = 2; else finished = true
      }).catch(() => {
        finished = true
        emit('core.explicitRefreshFailed', { ordinal, mode })
        diagnostic.postMessage({ schemaVersion: 1, type: 'rust013.rejected', ordinal, code: 'NOT_READY' })
      }).finally(() => { if (timer) clearTimeout(timer); refreshing = false })
    })
    diagnostic.start()
    emit('core.diagnosticPortBound')
  })
  function decorateDatasetOwner(source: DatasetOwnerEndpoint): DatasetOwnerEndpoint {
    const original = source as SnapshotOwner
    const wrapped: SnapshotOwner = {
      ...original,
      async prepare() { emit('node.prepare'); const identity = await original.prepare(); emit('node.prepared', { identity }); return identity },
      async commitBoot() { emit('node.boot'); await original.commitBoot(); emit('node.bootComplete') },
      async dispatch(request) {
        if (allowed.has(request.command)) emit('node.dispatch', { request })
        try {
          const result = await original.dispatch(request)
          if (allowed.has(request.command)) emit('node.reply', { requestId: request.id, command: request.command, result })
          return result
        } catch (error) { emit('node.dispatchFailed', { requestId: request.id, command: request.command }); throw error }
      },
      async close() { emit('node.closeStarted'); await original.close(); emit('node.closeCompleted') },
    }
    if (original.getCollectionSnapshotVersion) wrapped.getCollectionSnapshotVersion = async () => {
      const version = await original.getCollectionSnapshotVersion!(); emit('node.snapshotVersion', { version }); return version
    }
    if (original.exportCollectionSnapshot) wrapped.exportCollectionSnapshot = async () => {
      const snapshot = await original.exportCollectionSnapshot!()
      emit('node.snapshotExport', { epoch: snapshot.epoch, datasetId: snapshot.datasetId, snapshotId: snapshot.snapshotId, modelCount: snapshot.models.length, modelsSha256: createHash('sha256').update(JSON.stringify(snapshot.models)).digest('hex') })
      return snapshot
    }
    if (original.exportVersionedCollectionSnapshot) wrapped.exportVersionedCollectionSnapshot = async () => {
      const value = await original.exportVersionedCollectionSnapshot!()
      emit('node.versionedSnapshotExport', { version: value.version, snapshotId: value.snapshot.snapshotId, modelCount: value.snapshot.models.length, modelsSha256: createHash('sha256').update(JSON.stringify(value.snapshot.models)).digest('hex') })
      return value
    }
    if (original.exportLargeVersionedCollectionSnapshot) wrapped.exportLargeVersionedCollectionSnapshot = () => original.exportLargeVersionedCollectionSnapshot!()
    return wrapped
  }
  return {
    dependencies: {
      decorateDatasetOwner,
      createWorker(entry: URL, workerOptions: WorkerOptions) {
        const worker = new Worker(entry, workerOptions), threadId = worker.threadId
        emit('node.spawn', { threadId, hostPid: process.pid, entry: entry.href })
        worker.once('exit', code => emit('node.exit', { threadId, code }))
        return worker
      },
    },
    ...(mode === 'rust' ? {
      onRustReadonlyCoreController(value: RustReadonlyCoreController) { controller = value; emit('core.controllerDelivered', { keys: Object.keys(value), frozen: Object.isFrozen(value), status: value.getStatus() }) },
      onObservation(value: RustSidecarObservation) { const { event, ...data } = value; emit(`rust.${event}`, data) },
      onResourceValidated(resource: RustCoreResource) { emit('core.resourceValidated', { binary: resource.binary, manifestSha256: resource.manifestSha256, manifest: resource.manifest }) },
    } : {}),
  }
}
