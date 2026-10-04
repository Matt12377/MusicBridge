import { Worker, type WorkerOptions } from 'node:worker_threads'
import { createHash } from 'node:crypto'
import { writeSync } from 'node:fs'
import path from 'node:path'
import { validateIpcRequest } from '@music-bridge/contracts'
import type { DesktopCoreHostOptions } from './core-host.js'
import type { UtilityPort } from '../../../../packages/bridge-core/src/utility-main.js'
import type { DatasetOwnerEndpoint } from '../../../../packages/bridge-core/src/collection/dataset-owner-protocol.js'
import type { RustSidecarObservation } from '../../../../packages/bridge-core/src/rust-core/readonly-sidecar.js'
import type { RustCoreResource } from './rust-core-resource.js'
import { createCollectionScaleEvidenceWriter, readCollectionScaleProfile } from './collection-scale-main-probe.js'

declare const __MUSIC_BRIDGE_COLLECTION_SCALE_DIAGNOSTICS__: boolean
interface ParentPort { once(event: 'message', listener: (event: { data: unknown; ports?: UtilityPort[] }) => void): unknown }
export interface CollectionScaleCoreObserverOptions { getStatus(): unknown; parent?: ParentPort; sink?: (line: string) => void; env?: NodeJS.ProcessEnv; profileReader?: typeof readCollectionScaleProfile }
const allowed = new Set(['commandOutbox.context', 'commandOutbox.execute', 'collection.list', 'collection.detail', 'core.shutdown', 'recordingPrintWorker.claim'])
export function assertCollectionScaleCoreObserverEnvironment(env: NodeJS.ProcessEnv, profileReader: typeof readCollectionScaleProfile = readCollectionScaleProfile): void {
  if (typeof __MUSIC_BRIDGE_COLLECTION_SCALE_DIAGNOSTICS__ !== 'boolean' || !__MUSIC_BRIDGE_COLLECTION_SCALE_DIAGNOSTICS__
    || env.MUSIC_BRIDGE_CORE_TEST_MODE !== '1' || env.MUSIC_BRIDGE_UI_E2E !== '1' || !env.MUSIC_BRIDGE_DATA_DIRECTORY) throw new Error('Core只读观察仅允许编译候选与原离线合成环境。')
  const profile = path.dirname(env.MUSIC_BRIDGE_DATA_DIRECTORY)
  profileReader({ ...env, MUSIC_BRIDGE_UI_E2E_OFFLINE: "1", MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR: profile })
}
/** 固定fd1同步被动观察；输出异常由收据拒绝，不改变原ACK或Promise。 */
export function createCollectionScaleCoreEvidenceSink(): (line: string) => void {
  const waitCell = new Int32Array(new SharedArrayBuffer(4))
  let failed: unknown
  return line => {
    if (failed) throw failed
    const bytes = Buffer.from(line), started = performance.now(); let offset = 0, attempts = 0
    try {
      if (bytes.length > 16 * 1024 * 1024) throw new Error('Core观察输出超过固定大小预算。')
      while (offset < bytes.length) {
        if (++attempts > 4096 || performance.now() - started >= 2000) throw new Error('Core观察输出超过有界背压预算。')
        try {
          const n = writeSync(1, bytes, offset, bytes.length - offset)
          if (!Number.isSafeInteger(n) || n <= 0) throw new Error('Core观察输出不完整。')
          offset += n
        } catch (error) {
          if (!['EAGAIN', 'EWOULDBLOCK', 'EINTR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
          // 原fd1非阻塞pipe可能短写；仅同步旁路有界退避，原业务Promise/ACK没有额外await。
          Atomics.wait(waitCell, 0, 0, Math.min(5, Math.max(0, 2000 - (performance.now() - started))))
        }
      }
    } catch (error) { failed = error; throw error } // 半行失败后停止这个sink，不能拼新证据洗掉缺口。
  }
}
export function installCollectionScaleCoreObserver(options: CollectionScaleCoreObserverOptions) {
  assertCollectionScaleCoreObserverEnvironment(options.env ?? process.env, options.profileReader)
  const parent = options.parent ?? (process as typeof process & { parentPort?: ParentPort }).parentPort
  if (!parent || typeof options.getStatus !== 'function') throw new Error('Core观察缺少原父端口或可信状态旁路。')
  const emit = createCollectionScaleEvidenceWriter('core', options.sink ?? createCollectionScaleCoreEvidenceSink())
  const status = (): unknown => { try { return structuredClone(options.getStatus()) } catch { emit('core.observationRejected'); return null } }
  emit('core.diagnosticsInstalled')
  parent.once('message', event => {
    // 只旁路原public首port，既不消费/改写bootstrap，也不取得私有控制port。
    const port = event.ports?.[0]
    if (!port || event.ports?.length !== 1 || (event.data as { type?: string })?.type !== 'musicbridge.core.port') { emit('core.observationRejected'); return }
    const requests = new Map<string, { command: string; started: number }>()
    port.on('message', ({ data }) => { try { const checked = validateIpcRequest(data); if (checked.ok && allowed.has(checked.value.command)) { requests.set(checked.value.id, { command: checked.value.command, started: performance.now() }); emit('core.publicRequest', { request: structuredClone(data), status: status() }) } } catch { emit('core.observationRejected') } })
    const post = port.postMessage.bind(port)
    port.postMessage = value => {
      try {
        const packet = value as { id?: string; event?: string }
        if (packet.event === 'core.ready') emit('core.ready', { status: status() })
        if (packet.id && requests.has(packet.id)) { const pending = requests.get(packet.id)!; const command = pending.command; requests.delete(packet.id); emit('core.publicReply', { reply: structuredClone(value), requestId: packet.id, command, durationMs: performance.now() - pending.started, status: status() }); if (command === 'core.shutdown') emit('core.closedStatus', { status: status() }) }
      } catch { emit('core.observationRejected') }
      post(value)
    }
    emit('core.publicPortObserved')
  })
  function observePromise<T>(work: Promise<T>, observed: (value: T) => void, failed?: () => void): Promise<T> {
    try { void work.then(value => { try { observed(value) } catch { emit('core.observationRejected') } }, () => { try { failed?.() } catch { emit('core.observationRejected') } }).catch(() => {}) } catch { emit('core.observationRejected') }
    return work
  }
  function decorateDatasetOwner(source: DatasetOwnerEndpoint): DatasetOwnerEndpoint {
    const overrides: Record<string, (...args: any[]) => unknown> = {
      prepare: () => { const started = performance.now(); emit('node.prepare'); return observePromise(source.prepare(), identity => emit('node.prepared', { identity, durationMs: performance.now() - started })) },
      commitBoot: () => { const started = performance.now(); emit('node.boot'); return observePromise(source.commitBoot(), () => emit('node.bootComplete', { durationMs: performance.now() - started })) },
      dispatch: request => {
        const started = performance.now(); if (allowed.has(request.command)) emit('node.dispatch', { request })
        return observePromise(source.dispatch(request), result => { if (allowed.has(request.command)) emit('node.reply', { requestId: request.id, command: request.command, result, durationMs: performance.now() - started }) }, () => { if (allowed.has(request.command)) emit('node.dispatchFailed', { requestId: request.id, command: request.command, durationMs: performance.now() - started }) })
      },
      close: () => { const started = performance.now(); emit('node.closeStarted'); return observePromise(source.close(), () => emit('node.closeCompleted', { durationMs: performance.now() - started }), () => emit('node.closeRejected', { durationMs: performance.now() - started })) },
    }
    const snapshot = source as DatasetOwnerEndpoint & Record<string, any>
    for (const key of ['getCollectionSnapshotVersion', 'exportCollectionSnapshot', 'exportVersionedCollectionSnapshot', 'exportLargeVersionedCollectionSnapshot']) {
      if (typeof snapshot[key] !== 'function') continue
      overrides[key] = (...args) => { const started = performance.now(); return observePromise(snapshot[key](...args), (value: any) => {
        emit('node.snapshotOperation', { operation: key, outcome: 'fulfilled', durationMs: performance.now() - started, value, jsonBytes: Buffer.byteLength(JSON.stringify(value)), sha256: createHash('sha256').update(JSON.stringify(value)).digest('hex') })
        if (key === 'getCollectionSnapshotVersion') emit('node.snapshotVersion', { version: value })
        else if (key === 'exportVersionedCollectionSnapshot') emit('node.versionedSnapshotExport', { version: value.version, snapshotId: value.snapshot.snapshotId, modelCount: value.snapshot.models.length, modelsSha256: createHash('sha256').update(JSON.stringify(value.snapshot.models)).digest('hex') })
        else if (key === 'exportCollectionSnapshot') emit('node.snapshotExport', { epoch: value.epoch, datasetId: value.datasetId, snapshotId: value.snapshotId, modelCount: value.models.length, modelsSha256: createHash('sha256').update(JSON.stringify(value.models)).digest('hex') })
        else emit('node.largeSnapshotExport')
      }, () => emit('node.snapshotOperation', { operation: key, outcome: 'rejected', durationMs: performance.now() - started })) }
    }
    const bound = new Map<PropertyKey, unknown>()
    return new Proxy(source, { get(target, key) { if (typeof key === 'string' && Object.hasOwn(overrides, key)) return overrides[key]; if (!bound.has(key)) { const value: unknown = Reflect.get(target, key, target); bound.set(key, typeof value === 'function' ? value.bind(target) : value) } return bound.get(key) } })
  }
  const dependencies: NonNullable<DesktopCoreHostOptions['dependencies']> = { decorateDatasetOwner, createWorker(entry: URL, workerOptions: WorkerOptions) { const worker = new Worker(entry, workerOptions), threadId = worker.threadId; emit('node.spawn', { threadId, hostPid: process.pid, entry: entry.href }); worker.once('exit', code => emit('node.exit', { threadId, code })); return worker } }
  return { dependencies, emit, onCostObservation(value: import('../../../../packages/bridge-core/src/rust-core/readonly-sidecar.js').RustReadonlyCostObservation) {
    // dispatch成本与原public请求观察共用闭集；辅助业务仍走原路，其他成本阶段保留。
    if (value.stage === 'routerDispatch' && !allowed.has(value.operation ?? '')) return
    emit('core.cost', { ...value })
  }, onObservation(value: RustSidecarObservation) { const { event, ...data } = value; emit(`rust.${event}`, data) }, onResourceValidated(resource: RustCoreResource) { emit('core.resourceValidated', { binary: resource.binary, manifestSha256: resource.manifestSha256, manifest: resource.manifest }) } }
}
