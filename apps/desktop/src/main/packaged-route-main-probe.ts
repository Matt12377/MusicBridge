import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { StringDecoder } from 'node:string_decoder'
import { validateIpcRequest, type CollectionFilter, type CollectionReceiveRequest, type IpcRequest } from '@music-bridge/contracts'
import type { CoreMessagePort, CoreChildProcess, CoreSupervisor } from './core-supervisor.js'

export const PACKAGED_ROUTE_EVIDENCE_PREFIX = 'RUST012_EVIDENCE '
export interface PackagedRouteEvidenceEvent {
  schemaVersion: 1; actor: 'main' | 'core'; sequence: number; elapsedMs: number; pid: number; event: string; data: Record<string, unknown>
}
export function createPackagedRouteEvidenceWriter(actor: 'main' | 'core', sink: (line: string) => void = line => { process.stdout.write(line) }) {
  let sequence = 0
  const start = performance.now()
  return (event: string, data: Record<string, unknown> = {}) => {
    try {
      const returned: unknown = sink(`${PACKAGED_ROUTE_EVIDENCE_PREFIX}${JSON.stringify({ schemaVersion: 1, actor, sequence: ++sequence, elapsedMs: performance.now() - start, pid: process.pid, event, data })}\n`)
      if (returned !== undefined) void Promise.resolve(returned).catch(() => {})
    } catch { /* 证据管道失败由完整收据门禁拒绝，不改变原写回执或关闭。 */ }
  }
}
export function assertPackagedRouteDiagnosticEnvironment(env: NodeJS.ProcessEnv): void {
  if (env.MUSIC_BRIDGE_UI_E2E !== '1' || env.MUSIC_BRIDGE_UI_E2E_OFFLINE !== '1'
    || !env.MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR || env.MUSIC_BRIDGE_STARTUP_TEST !== undefined) throw new Error('候选诊断只接受固定离线合成工作库。')
}
export function parsePackagedRouteRefreshRequest(value: unknown, expectedOrdinal: 1 | 2): 1 | 2 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const fields = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(value).length !== 3 || !['schemaVersion', 'type', 'ordinal'].every(key => fields[key]?.enumerable && Object.hasOwn(fields[key]!, 'value'))) return null
  return fields.schemaVersion!.value === 1 && fields.type!.value === 'rust012.refresh' && fields.ordinal!.value === expectedOrdinal ? expectedOrdinal : null
}
const observedCommands = new Set(['commandOutbox.context', 'commandOutbox.execute', 'collection.list', 'collection.detail', 'core.shutdown', 'recordingPrintWorker.claim'])
export const PACKAGED_ROUTE_FILTER_MATRIX: readonly { page: { offset: number; limit: number }; filter?: CollectionFilter }[] = Object.freeze([
  { page: { offset: 0, limit: 25 } }, { page: { offset: 0, limit: 1 } }, { page: { offset: 1, limit: 1 } }, { page: { offset: 3, limit: 2 } },
  { page: { offset: 0, limit: 25 }, filter: { query: '合成' } }, { page: { offset: 0, limit: 25 }, filter: { query: 'Ａlpha' } },
  { page: { offset: 0, limit: 25 }, filter: { brand: '合成甲' } }, { page: { offset: 0, limit: 25 }, filter: { decade: 1990 } },
  { page: { offset: 0, limit: 25 }, filter: { decade: 'unknown' } }, { page: { offset: 0, limit: 25 }, filter: { stockState: 'blank' } },
  { page: { offset: 0, limit: 25 }, filter: { stockState: 'needs-review' } }, { page: { offset: 0, limit: 25 }, filter: { query: '不存在的合成型号' } },
])
const descriptors: readonly CollectionReceiveRequest['model'][] = [
  { brand: '合成甲', name: 'Alpha 合成磁带', edition: '诊断', year: 1991, format: 'cassette', tapeType: 'II', identification: 'verified' },
  { brand: '合成乙', name: 'Beta 合成磁带', edition: '诊断', year: null, format: 'cassette', tapeType: 'unknown', identification: 'unidentified' },
  { brand: 'Synthetic', name: 'Gamma 合成 DAT', edition: '诊断', year: 2001, format: 'dat', tapeType: 'dat', identification: 'verified' },
]

/** 此探针只由编译期候选钩子创建，公共请求仍使用真实CoreSupervisor。 */
export function createPackagedRouteMainProbe(options: { sink?: (line: string) => void; refreshTimeoutMs?: number } = {}) {
  const sink = options.sink ?? (line => { process.stdout.write(line) })
  const emit = createPackagedRouteEvidenceWriter('main', sink)
  const requests = new Map<string, IpcRequest>()
  let diagnosticPort: CoreMessagePort | undefined
  const refreshes = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>()
  emit('main.diagnosticsInstalled')
  function bindDiagnosticPort(port: CoreMessagePort) {
    diagnosticPort = port
    port.on('message', ({ data }) => {
      const value = data as Record<string, unknown>
      if (!value || Object.keys(value).some(key => !['schemaVersion', 'type', 'ordinal', 'mode', 'status', 'code'].includes(key))
        || value.schemaVersion !== 1 || !['rust012.refreshed', 'rust012.rejected'].includes(String(value.type)) || value.ordinal !== 1 && value.ordinal !== 2
        || value.type === 'rust012.refreshed' && value.mode !== 'node' && value.mode !== 'rust') {
        emit('main.diagnosticRejected'); return
      }
      const pending = refreshes.get(Number(value.ordinal))
      if (!pending) { emit('main.diagnosticRejected'); return }
      clearTimeout(pending.timer); refreshes.delete(Number(value.ordinal))
      emit('main.refreshReply', { reply: value })
      if (value.type === 'rust012.rejected') pending.reject(new Error('Core候选刷新被拒绝。'))
      else pending.resolve(value)
    })
    port.start()
  }
  async function refresh(ordinal: 1 | 2): Promise<void> {
    if (!diagnosticPort) throw new Error('候选缺少私有诊断端口。')
    emit('main.refreshRequested', { ordinal })
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { refreshes.delete(ordinal); reject(new Error('候选刷新超过期限。')) }, options.refreshTimeoutMs ?? 30_000)
      refreshes.set(ordinal, { resolve, reject, timer })
      diagnosticPort!.postMessage({ schemaVersion: 1, type: 'rust012.refresh', ordinal })
    })
  }
  return {
    emit,
    observePublicPort(port: CoreMessagePort) {
      const post = port.postMessage.bind(port)
      port.postMessage = value => {
        const checked = validateIpcRequest(value)
        if (checked.ok && observedCommands.has(checked.value.command)) {
          requests.set(checked.value.id, structuredClone(checked.value)); emit('main.request', { request: structuredClone(value) })
        }
        post(value)
      }
      port.on('message', ({ data }) => {
        if (!data || typeof data !== 'object') return
        const value = data as { id?: string; event?: string }
        if (value.id && requests.has(value.id)) { emit('main.response', { reply: structuredClone(data) }); requests.delete(value.id) }
        else if (value.event === 'core.ready') emit('main.coreReady')
      })
      emit('main.channelCreated')
    },
    observeChild(child: CoreChildProcess, entryPath: string, args: string[], diagnostic: { port1: CoreMessagePort; port2: CoreMessagePort }) {
      emit('main.coreFork', { entryPath, args: [...args] })
      const nativeChild = child as unknown as { pid?: number; once(event: 'spawn', callback: () => void): unknown }
      let spawnedPid: number | null = null
      nativeChild.once('spawn', () => { spawnedPid = nativeChild.pid ?? null; emit('main.coreSpawn', { pid: spawnedPid }) })
      bindDiagnosticPort(diagnostic.port2)
      const post = child.postMessage.bind(child), kill = child.kill.bind(child)
      child.postMessage = (value, transfer) => {
        if (!value || typeof value !== 'object' || (value as { type?: string }).type !== 'musicbridge.core.port' || transfer?.length !== 1) throw new Error('候选不允许改变公有Core启动合同。')
        post(value, [...transfer, diagnostic.port1]); emit('main.diagnosticPortTransferred')
      }
      child.kill = () => { emit('main.coreKill'); return kill() }
      let buffer = ''
      const decoder = new StringDecoder('utf8')
      child.stdout?.on('data', chunk => {
        buffer += Buffer.isBuffer(chunk) ? decoder.write(chunk) : chunk.toString()
        if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) { emit('main.coreEvidenceOverflow'); buffer = ''; return }
        while (buffer.includes('\n')) {
          const at = buffer.indexOf('\n'), line = buffer.slice(0, at); buffer = buffer.slice(at + 1)
          if (line.startsWith(PACKAGED_ROUTE_EVIDENCE_PREFIX)) sink(`${line}\n`)
        }
      })
      child.once('exit', code => {
        emit('main.coreExit', { code, pid: spawnedPid })
        diagnostic.port2.close()
        for (const pending of refreshes.values()) { clearTimeout(pending.timer); pending.reject(new Error('Core退出中断候选刷新。')) }
        refreshes.clear()
      })
    },
    async run(supervisor: Pick<CoreSupervisor, 'request'>): Promise<void> {
      const { datasetId } = await supervisor.request('commandOutbox.context', {})
      emit('main.probePhase', { phase: 'empty', datasetId })
      const empty = await supervisor.request('collection.list', { page: { offset: 0, limit: 25 } }, datasetId)
      if (empty.total !== 0) throw new Error('候选必须使用全新空合成工作库。')
      const receive = (model: CollectionReceiveRequest['model']): CollectionReceiveRequest => ({ commandId: randomUUID(), model, lengthMinutes: 60, quantities: { openedBlank: 1, sealedBlank: 0, legacyUsed: 0, unclassified: 0 } })
      for (const descriptor of descriptors) await supervisor.request('commandOutbox.execute', { datasetId, command: 'collection.receive', payload: receive(descriptor) }, datasetId)
      await refresh(1)
      emit('main.probePhase', { phase: 'matrix', datasetId })
      for (const payload of PACKAGED_ROUTE_FILTER_MATRIX) await supervisor.request('collection.list', structuredClone(payload), datasetId)
      const payload = receive({ brand: '合成写后', name: 'Delta 合成追加', edition: '诊断', year: 1995, format: 'cassette', tapeType: 'II', identification: 'verified' })
      emit('main.probePhase', { phase: 'write-fallback', datasetId, commandId: payload.commandId })
      const request = { datasetId, command: 'collection.receive' as const, payload }
      const first = await supervisor.request('commandOutbox.execute', request, datasetId)
      const fallback = await supervisor.request('collection.list', { page: { offset: 0, limit: 25 } }, datasetId)
      const second = await supervisor.request('commandOutbox.execute', request, datasetId)
      const replay = await supervisor.request('collection.list', { page: { offset: 0, limit: 25 } }, datasetId)
      if (!isDeepStrictEqual(first, second) || !isDeepStrictEqual(fallback, replay) || fallback.total !== 4
        || fallback.items.find(model => model.name === payload.model.name)?.counts.openedBlank !== 1) throw new Error('Node写后回退或幂等回执不一致。')
      await refresh(2)
      emit('main.probePhase', { phase: 'refreshed', datasetId })
      const resumed = await supervisor.request('collection.list', { page: { offset: 0, limit: 25 } }, datasetId)
      if (!isDeepStrictEqual(resumed, replay)) throw new Error('Rust刷新后的完整DTO不同于Node写后回执。')
      emit('main.probeComplete', { datasetId, seedModels: 3, finalModels: 4, matrixRequests: PACKAGED_ROUTE_FILTER_MATRIX.length })
    },
  }
}
