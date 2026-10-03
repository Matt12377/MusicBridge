import { Worker, type WorkerOptions } from 'node:worker_threads'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync, writeSync } from 'node:fs'
import path from 'node:path'
import { validateIpcRequest } from '@music-bridge/contracts'
import type { DesktopCoreHostOptions } from './core-host.js'
import type { UtilityPort } from '../../../../packages/bridge-core/src/utility-main.js'
import type { DatasetOwnerEndpoint } from '../../../../packages/bridge-core/src/collection/dataset-owner-protocol.js'
import type { RustSidecarObservation } from '../../../../packages/bridge-core/src/rust-core/readonly-sidecar.js'
import type { RustCoreResource } from './rust-core-resource.js'
import { createCollectionReadonlyEvidenceWriter } from './collection-readonly-main-probe.js'

declare const __MUSIC_BRIDGE_COLLECTION_READONLY_DIAGNOSTICS__: boolean
interface ParentPort { once(event: 'message', listener: (event: { data: unknown; ports?: UtilityPort[] }) => void): unknown }
export interface CollectionReadonlyCoreObserverOptions { getStatus(): unknown; parent?: ParentPort; sink?: (line: string) => void; env?: NodeJS.ProcessEnv }
const allowed = new Set(['commandOutbox.context', 'commandOutbox.execute', 'collection.list', 'collection.detail', 'core.shutdown', 'recordingPrintWorker.claim'])
export function assertCollectionReadonlyCoreObserverEnvironment(env: NodeJS.ProcessEnv): void {
  if (typeof __MUSIC_BRIDGE_COLLECTION_READONLY_DIAGNOSTICS__ !== 'boolean' || !__MUSIC_BRIDGE_COLLECTION_READONLY_DIAGNOSTICS__
    || env.MUSIC_BRIDGE_CORE_TEST_MODE !== '1' || env.MUSIC_BRIDGE_UI_E2E !== '1' || !env.MUSIC_BRIDGE_DATA_DIRECTORY) throw new Error('Core只读观察仅允许编译候选与原离线合成环境。')
  const data = env.MUSIC_BRIDGE_DATA_DIRECTORY, profile = path.dirname(data)
  if (path.basename(data) !== 'data' || !profile.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/') || path.resolve(profile) !== profile || realpathSync(profile) !== profile) throw new Error('Core观察工作库范围无效。')
  const volume = lstatSync('/Volumes/LifeWeave', { bigint: true }), identity = lstatSync(profile, { bigint: true })
  const markerFile = path.join(profile, 'rust014-profile.json'), file = lstatSync(markerFile, { bigint: true })
  if (!identity.isDirectory() || identity.dev !== volume.dev || (identity.mode & 0o077n) !== 0n || !file.isFile() || file.isSymbolicLink() || file.nlink !== 1n || file.size > 1024n || (file.mode & 0o077n) !== 0n) throw new Error('Core观察profile真实身份无效。')
  const marker = JSON.parse(readFileSync(markerFile, 'utf8'))
  if (Object.keys(marker).length !== 3 || marker.schemaVersion !== 1 || marker.kind !== 'rust014-synthetic-profile' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(marker.nonce)) throw new Error('Core观察nonce未准入。')
}
/** 固定fd1同步被动观察；输出异常由收据拒绝，不改变原ACK或Promise。 */
export function createCollectionReadonlyCoreEvidenceSink(): (line: string) => void {
  return line => { const bytes = Buffer.from(line); let offset = 0; while (offset < bytes.length) { const n = writeSync(1, bytes, offset, bytes.length - offset); if (!Number.isSafeInteger(n) || n <= 0) throw new Error('Core观察输出不完整。'); offset += n } }
}
export function installCollectionReadonlyCoreObserver(options: CollectionReadonlyCoreObserverOptions) {
  assertCollectionReadonlyCoreObserverEnvironment(options.env ?? process.env)
  const parent = options.parent ?? (process as typeof process & { parentPort?: ParentPort }).parentPort
  if (!parent || typeof options.getStatus !== 'function') throw new Error('Core观察缺少原父端口或可信状态旁路。')
  const emit = createCollectionReadonlyEvidenceWriter('core', options.sink ?? createCollectionReadonlyCoreEvidenceSink())
  const status = (): unknown => { try { return structuredClone(options.getStatus()) } catch { emit('core.observationRejected'); return null } }
  emit('core.diagnosticsInstalled')
  parent.once('message', event => {
    // 只旁路原public首port，既不消费/改写bootstrap，也不取得私有控制port。
    const port = event.ports?.[0]
    if (!port || event.ports?.length !== 1 || (event.data as { type?: string })?.type !== 'musicbridge.core.port') { emit('core.observationRejected'); return }
    const requests = new Map<string, string>()
    port.on('message', ({ data }) => { try { const checked = validateIpcRequest(data); if (checked.ok && allowed.has(checked.value.command)) { requests.set(checked.value.id, checked.value.command); emit('core.publicRequest', { request: structuredClone(data), status: status() }) } } catch { emit('core.observationRejected') } })
    const post = port.postMessage.bind(port)
    port.postMessage = value => {
      try {
        const packet = value as { id?: string; event?: string }
        if (packet.event === 'core.ready') emit('core.ready', { status: status() })
        if (packet.id && requests.has(packet.id)) { const command = requests.get(packet.id)!; requests.delete(packet.id); emit('core.publicReply', { reply: structuredClone(value), command, status: status() }); if (command === 'core.shutdown') emit('core.closedStatus', { status: status() }) }
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
      prepare: () => { emit('node.prepare'); return observePromise(source.prepare(), identity => emit('node.prepared', { identity })) },
      commitBoot: () => { emit('node.boot'); return observePromise(source.commitBoot(), () => emit('node.bootComplete')) },
      dispatch: request => {
        if (allowed.has(request.command)) emit('node.dispatch', { request })
        return observePromise(source.dispatch(request), result => { if (allowed.has(request.command)) emit('node.reply', { requestId: request.id, command: request.command, result }) }, () => { if (allowed.has(request.command)) emit('node.dispatchFailed', { requestId: request.id, command: request.command }) })
      },
      close: () => { emit('node.closeStarted'); return observePromise(source.close(), () => emit('node.closeCompleted')) },
    }
    const snapshot = source as DatasetOwnerEndpoint & Record<string, any>
    for (const key of ['getCollectionSnapshotVersion', 'exportCollectionSnapshot', 'exportVersionedCollectionSnapshot', 'exportLargeVersionedCollectionSnapshot']) {
      if (typeof snapshot[key] !== 'function') continue
      overrides[key] = (...args) => observePromise(snapshot[key](...args), (value: any) => {
        if (key === 'getCollectionSnapshotVersion') emit('node.snapshotVersion', { version: value })
        else if (key === 'exportVersionedCollectionSnapshot') emit('node.versionedSnapshotExport', { version: value.version, snapshotId: value.snapshot.snapshotId, modelCount: value.snapshot.models.length, modelsSha256: createHash('sha256').update(JSON.stringify(value.snapshot.models)).digest('hex') })
        else if (key === 'exportCollectionSnapshot') emit('node.snapshotExport', { epoch: value.epoch, datasetId: value.datasetId, snapshotId: value.snapshotId, modelCount: value.models.length, modelsSha256: createHash('sha256').update(JSON.stringify(value.models)).digest('hex') })
        else emit('node.largeSnapshotExport')
      })
    }
    const bound = new Map<PropertyKey, unknown>()
    return new Proxy(source, { get(target, key) { if (typeof key === 'string' && Object.hasOwn(overrides, key)) return overrides[key]; if (!bound.has(key)) { const value: unknown = Reflect.get(target, key, target); bound.set(key, typeof value === 'function' ? value.bind(target) : value) } return bound.get(key) } })
  }
  const dependencies: NonNullable<DesktopCoreHostOptions['dependencies']> = { decorateDatasetOwner, createWorker(entry: URL, workerOptions: WorkerOptions) { const worker = new Worker(entry, workerOptions), threadId = worker.threadId; emit('node.spawn', { threadId, hostPid: process.pid, entry: entry.href }); worker.once('exit', code => emit('node.exit', { threadId, code })); return worker } }
  return { dependencies, emit, onObservation(value: RustSidecarObservation) { const { event, ...data } = value; emit(`rust.${event}`, data) }, onResourceValidated(resource: RustCoreResource) { emit('core.resourceValidated', { binary: resource.binary, manifestSha256: resource.manifestSha256, manifest: resource.manifest }) } }
}
