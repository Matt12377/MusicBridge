import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { externalSyntheticProfileRoot, validateSyntheticProfileDirectory, type SyntheticProfileRoot } from './synthetic-profile-root.js'
import { StringDecoder } from 'node:string_decoder'
import { isDeepStrictEqual } from 'node:util'
import { validateIpcRequest, validateIpcResponseForCommand, isCollectionModel, type CollectionModel, type IpcRequest } from '@music-bridge/contracts'
import type { BrowserWindow } from 'electron'
import type { CoreMessagePort, CoreChildProcess } from './core-supervisor.js'
import { PACKAGED_RENDERER_FIXTURE, PACKAGED_RENDERER_FIXTURE_SHA256, packagedRendererDomExpression, type PackagedRendererDomOperation, type PackagedRendererDomSnapshot } from './packaged-renderer-dom-driver.js'

export const PACKAGED_RENDERER_EVIDENCE_PREFIX = 'RUST013_EVIDENCE '
export interface PackagedRendererEvidenceEvent {
  schemaVersion: 1; actor: 'main' | 'core'; sequence: number; elapsedMs: number; pid: number; event: string; data: Record<string, unknown>
}
export const packagedRendererJsonSha256 = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function createPackagedRendererEvidenceWriter(actor: 'main' | 'core', sink: (line: string) => void = line => { process.stdout.write(line) }) {
  let sequence = 0
  const start = performance.now()
  return (event: string, data: Record<string, unknown> = {}): void => {
    try {
      const returned: unknown = sink(`${PACKAGED_RENDERER_EVIDENCE_PREFIX}${JSON.stringify({ schemaVersion: 1, actor, sequence: ++sequence, elapsedMs: performance.now() - start, pid: process.pid, event, data })}\n`)
      if (returned !== undefined) void Promise.resolve(returned).catch(() => {})
    } catch { /* 观察失败留给证据门禁拒绝，不改变原业务或退出。 */ }
  }
}
export function parsePackagedRendererRefreshRequest(value: unknown, expectedOrdinal: 1 | 2): 1 | 2 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const fields = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(value).length !== 3 || !['schemaVersion', 'type', 'ordinal'].every(key => fields[key]?.enumerable && Object.hasOwn(fields[key]!, 'value'))) return null
  return fields.schemaVersion!.value === 1 && fields.type!.value === 'rust013.refresh' && fields.ordinal!.value === expectedOrdinal ? expectedOrdinal : null
}
export function assertPackagedRendererDiagnosticEnvironment(env: NodeJS.ProcessEnv): void {
  if (env.MUSIC_BRIDGE_UI_E2E !== '1' || env.MUSIC_BRIDGE_UI_E2E_OFFLINE !== '1'
    || !env.MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR || env.MUSIC_BRIDGE_STARTUP_TEST !== undefined) throw new Error('候选诊断只接受固定离线合成工作库。')
}
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value)
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const exact = (value: unknown, keys: readonly string[]): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value) && Reflect.ownKeys(value).length === keys.length && keys.every(key => { const field = Object.getOwnPropertyDescriptor(value, key); return field?.enumerable && Object.hasOwn(field, 'value') })
export interface PackagedRendererCompletedMarker {
  schemaVersion: 1; kind: 'rust013-completed-profile'; nonce: string; fixtureSha256: string; datasetId: string
  commandIds: string[]; outboxIds: string[]; models: CollectionModel[]; policyModelId: string; policyRevision: number
}
export function readPackagedRendererProfile(env: NodeJS.ProcessEnv) {
  assertPackagedRendererDiagnosticEnvironment(env)
  return readPackagedRendererProfileWithinRoot(env, externalSyntheticProfileRoot())
}
export function readPackagedRendererProfileWithinRoot(env: NodeJS.ProcessEnv, trustedRoot: SyntheticProfileRoot) {
  assertPackagedRendererDiagnosticEnvironment(env)
  const directory = env.MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR!
  const profile = validateSyntheticProfileDirectory(directory, trustedRoot)
  const markerPath = path.join(directory, 'rust013-profile.json'), markerIdentity = lstatSync(markerPath, { bigint: true })
  if (!markerIdentity.isFile() || markerIdentity.isSymbolicLink() || markerIdentity.nlink !== 1n || (markerIdentity.mode & 0o077n) !== 0n || markerIdentity.size > 1024n) throw new Error('合成工作库标记无效。')
  const bytes = readFileSync(markerPath), marker: unknown = JSON.parse(bytes.toString())
  if (!exact(marker, ['schemaVersion', 'kind', 'nonce']) || marker.schemaVersion !== 1 || marker.kind !== 'rust013-synthetic-profile' || !uuid(marker.nonce)) throw new Error('合成工作库标记未准入。')
  const completedPath = path.join(directory, 'rust013-completed.json')
  let completed: PackagedRendererCompletedMarker | undefined, completedMarkerSha256: string | undefined
  try {
    const identity = lstatSync(completedPath, { bigint: true })
    if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1n || (identity.mode & 0o077n) !== 0n || identity.size > 1024n * 1024n) throw new Error('完成标记真实身份无效。')
    const completedBytes = readFileSync(completedPath), value: unknown = JSON.parse(completedBytes.toString())
    if (!exact(value, ['schemaVersion', 'kind', 'nonce', 'fixtureSha256', 'datasetId', 'commandIds', 'outboxIds', 'models', 'policyModelId', 'policyRevision'])
      || value.schemaVersion !== 1 || value.kind !== 'rust013-completed-profile' || value.nonce !== marker.nonce || value.fixtureSha256 !== PACKAGED_RENDERER_FIXTURE_SHA256
      || !uuid(value.datasetId) || !Array.isArray(value.commandIds) || value.commandIds.length !== 27 || !value.commandIds.every(uuid) || new Set(value.commandIds).size !== 27
      || !Array.isArray(value.outboxIds) || value.outboxIds.length !== 27 || !value.outboxIds.every(uuid) || new Set(value.outboxIds).size !== 27
      || !Array.isArray(value.models) || value.models.length !== 26 || !value.models.every(isCollectionModel) || !uuid(value.policyModelId) || !Number.isSafeInteger(value.policyRevision)) throw new Error('完成标记不完整。')
    completed = value as unknown as PackagedRendererCompletedMarker; completedMarkerSha256 = sha(completedBytes)
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  return { directory, nonce: marker.nonce as string, profileDev: String(profile.dev), profileIno: String(profile.ino), markerSha256: sha(bytes), completedPath, completed, completedMarkerSha256 }
}
const observedCommands = new Set(['commandOutbox.context', 'commandOutbox.execute', 'collection.list', 'collection.detail', 'core.shutdown', 'recordingPrintWorker.claim'])
export function createPackagedRendererMainProbe(options: { sink?: (line: string) => void; profileReader?: typeof readPackagedRendererProfile } = {}) {
  const sink = options.sink ?? (line => { process.stdout.write(line) }), emit = createPackagedRendererEvidenceWriter('main', sink)
  const requests = new Map<string, { request: IpcRequest; started: number; actionId: string | null }>()
  const ipcRequests = new Map<string, Record<string, any>>(), submissions: { commandId: string; outboxId: string; datasetId: string; command: string; payload: any; result: any }[] = [], acknowledged = new Set<string>(), models = new Map<string, CollectionModel>()
  let actionId: string | null = null, diagnosticPort: CoreMessagePort | undefined, nextOrdinal: 1 | 2 | 3 = 1
  let pendingRefresh: { ordinal: 1 | 2; resolve(): void; reject(error: Error): void; timer: NodeJS.Timeout } | undefined
  let executed = false, domainWrites = 0, phase: 'fresh' | 'cold' | undefined
  emit('main.diagnosticsInstalled')
  const phaseEvent = (value: string) => emit('main.probePhase', { phase: value })
  function observeMainEvent(event: string, data: Record<string, unknown>): void {
    try {
      const copy = structuredClone(data) as Record<string, any>
      let attributedAction = actionId
      if (event === 'main.ipcRequest' && typeof copy.invokeId === 'string') ipcRequests.set(copy.invokeId, { ...copy, actionId })
      if (event === 'main.ipcReply') {
        const original = ipcRequests.get(copy.invokeId); ipcRequests.delete(copy.invokeId)
        attributedAction = original?.actionId ?? null
        if (original?.channel === 'commandOutbox:submit' && copy.result?.ok === true) {
          const request = original.args?.[0]?.request
          if (request && ['collection.receive', 'collection.setPolicy'].includes(request.command) && uuid(request.payload?.commandId) && uuid(copy.result.outboxId)) submissions.push({ commandId: request.payload.commandId, outboxId: copy.result.outboxId, datasetId: request.datasetId, command: request.command, payload: structuredClone(request.payload), result: structuredClone(copy.result.result) })
        }
        if (original?.channel === 'commandOutbox:acknowledge' && copy.result?.acknowledged === true && copy.result?.id === original.args?.[0]?.id) acknowledged.add(copy.result.id)
      }
      if (event === 'main.ipcRejected') { attributedAction = ipcRequests.get(copy.invokeId)?.actionId ?? null; ipcRequests.delete(copy.invokeId) }
      emit(event, { ...copy, actionId: attributedAction })
    } catch { emit('main.observationRejected') }
  }
  function bindDiagnosticPort(port: CoreMessagePort): void {
    diagnosticPort = port
    port.on('message', ({ data }) => {
      const keys = ['schemaVersion', 'type', 'ordinal', 'mode', ...(data && typeof data === 'object' && Object.hasOwn(data, 'status') ? ['status'] : [])]
      const success = exact(data, keys) && data.schemaVersion === 1 && data.type === 'rust013.refreshed' && (data.mode === 'node' || data.mode === 'rust')
      const failure = exact(data, ['schemaVersion', 'type', 'ordinal', 'code']) && data.schemaVersion === 1 && data.type === 'rust013.rejected' && ['INVALID_REQUEST', 'NOT_READY'].includes(data.code)
      if ((!success && !failure) || !pendingRefresh || (data as any).ordinal !== pendingRefresh.ordinal) { emit('main.diagnosticRejected'); return }
      const pending = pendingRefresh; pendingRefresh = undefined; clearTimeout(pending.timer)
      emit('main.refreshReply', { reply: structuredClone(data) })
      if (failure) pending.reject(new Error('可信刷新被拒绝。')); else { nextOrdinal++; pending.resolve() }
    })
    port.start()
  }
  async function refresh(ordinal: 1 | 2): Promise<void> {
    if (!diagnosticPort || pendingRefresh || ordinal !== nextOrdinal || phase !== 'fresh') throw new Error('可信刷新顺序无效。')
    emit('main.refreshRequested', { ordinal })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { pendingRefresh = undefined; reject(new Error('可信刷新超过30秒。')) }, 30_000)
      pendingRefresh = { ordinal, resolve, reject, timer }
      try { diagnosticPort!.postMessage({ schemaVersion: 1, type: 'rust013.refresh', ordinal }) }
      catch (error) { clearTimeout(timer); pendingRefresh = undefined; reject(error) }
    })
  }
  return {
    emit, observeMainEvent,
    observePublicPort(port: CoreMessagePort): void {
      const post = port.postMessage.bind(port)
      port.postMessage = value => {
        try {
        const checked = validateIpcRequest(value)
        if (checked.ok && observedCommands.has(checked.value.command)) {
          const request = structuredClone(checked.value), serialized = JSON.stringify(request)
          emit('main.request', { actionId, request, requestJsonBytes: Buffer.byteLength(serialized), requestSha256: packagedRendererJsonSha256(request) })
          requests.set(request.id, { request, started: performance.now(), actionId })
          if (request.command === 'commandOutbox.execute') domainWrites++
        }
        } catch { emit('main.observationRejected') }
        post(value)
      }
      port.on('message', ({ data }) => {
        try {
        if (!data || typeof data !== 'object') return
        const packet = data as { id?: string; event?: string }
        const pending = packet.id ? requests.get(packet.id) : undefined
        if (pending && packet.id) {
          const durationMs = performance.now() - pending.started; requests.delete(packet.id)
          const checked = validateIpcResponseForCommand(data, pending.request.command)
          if (checked.ok && checked.value.ok && (pending.request.command === 'collection.list' || pending.request.command === 'collection.detail')) {
            const result = checked.value.result as any
            for (const model of (pending.request.command === 'collection.list' ? result.items : [result.model])) if (isCollectionModel(model)) models.set(model.id, structuredClone(model))
          }
          emit('main.response', { actionId: pending.actionId, reply: structuredClone(data), requestId: packet.id, command: pending.request.command, durationMs, replyJsonBytes: Buffer.byteLength(JSON.stringify(data)), replySha256: packagedRendererJsonSha256(data) })
        } else if (packet.event === 'core.ready') emit('main.coreReady')
        } catch { emit('main.observationRejected') }
      })
      emit('main.channelCreated')
    },
    observeChild(child: CoreChildProcess, entryPath: string, args: string[], diagnostic: { port1: CoreMessagePort; port2: CoreMessagePort }): void {
      emit('main.coreFork', { entryPath, args: [...args] })
      const native = child as unknown as { pid?: number; once(event: 'spawn', listener: () => void): unknown }
      let spawnedPid: number | null = null
      native.once('spawn', () => { spawnedPid = native.pid ?? null; emit('main.coreSpawn', { pid: spawnedPid }) })
      bindDiagnosticPort(diagnostic.port2)
      const post = child.postMessage.bind(child), kill = child.kill.bind(child)
      child.postMessage = (value, transfer) => {
        if (!value || typeof value !== 'object' || (value as { type?: string }).type !== 'musicbridge.core.port' || transfer?.length !== 1) throw new Error('候选公有启动端口不合规。')
        post(value, [...transfer, diagnostic.port1]); emit('main.diagnosticPortTransferred')
      }
      child.kill = () => { emit('main.coreKill'); return kill() }
      const decoder = new StringDecoder('utf8'); let buffer = ''
      child.stdout?.on('data', chunk => {
        buffer += Buffer.isBuffer(chunk) ? decoder.write(chunk) : chunk.toString()
        if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) { emit('main.coreEvidenceOverflow'); buffer = ''; return }
        while (buffer.includes('\n')) {
          const index = buffer.indexOf('\n'), line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
          if (line.startsWith(PACKAGED_RENDERER_EVIDENCE_PREFIX)) {
            try { const value = JSON.parse(line.slice(PACKAGED_RENDERER_EVIDENCE_PREFIX.length)); if (value.actor === 'core') { const returned: unknown = sink(line + '\n'); if (returned !== undefined) void Promise.resolve(returned).catch(() => {}) } } catch { emit('main.coreEvidenceRejected') }
          }
        }
      })
      child.once('exit', code => {
        emit('main.coreExit', { code, pid: spawnedPid }); diagnostic.port2.close()
        if (pendingRefresh) { clearTimeout(pendingRefresh.timer); pendingRefresh.reject(new Error('Core退出中断刷新。')); pendingRefresh = undefined }
      })
    },
    async run(window: BrowserWindow): Promise<void> {
      if (executed) throw new Error('固定控件流程不能重复启动。')
      executed = true
      try {
        const profile = (options.profileReader ?? readPackagedRendererProfile)(process.env), start = performance.now(), web = window.webContents
        emit('main.profileValidated', { profileDirectory: profile.directory, profileDev: profile.profileDev, profileIno: profile.profileIno, markerSha256: profile.markerSha256, nonce: profile.nonce })
        const imageDirectory = path.join(profile.directory, `rust013-screenshots-${randomUUID()}`)
        await mkdir(imageDirectory, { mode: 0o700 })
        let step = 0
        const bounded = async <T>(work: Promise<T>): Promise<T> => {
          let timer: NodeJS.Timeout | undefined
          try { return await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('原控件执行超过固定预算。')), Math.max(1, Math.min(30_000, 180_000 - (performance.now() - start)))) })]) }
          finally { if (timer) clearTimeout(timer) }
        }
        const snapshot = async (): Promise<PackagedRendererDomSnapshot> => {
          const value = await bounded(web.executeJavaScript(packagedRendererDomExpression('snapshot'))) as PackagedRendererDomSnapshot
          if (value.frameUrl !== 'musicbridge://app/index.html' || value.errorCount || value.rows.some(row => !row.label.includes('RUST013 合成型号'))) throw new Error('原控件出现未准入状态。')
          return value
        }
        const wait = async (predicate: (value: PackagedRendererDomSnapshot) => boolean): Promise<PackagedRendererDomSnapshot> => {
          const tick = performance.now(); let count = 0
          while (performance.now() - tick < 30_000 && performance.now() - start < 180_000) {
            const value = await snapshot(); count++
            if (predicate(value)) { emit('main.domSettled', { actionId, pollCount: count, elapsedMs: performance.now() - tick, snapshot: value }); return value }
            await new Promise(resolve => setTimeout(resolve, 50))
          }
          throw new Error('原控件等待超过固定预算。')
        }
        const action = async (operation: PackagedRendererDomOperation, predicate: (value: PackagedRendererDomSnapshot) => boolean, fixtureIndex?: number): Promise<PackagedRendererDomSnapshot> => {
          actionId = `dom-${String(++step).padStart(3, '0')}-${operation}`
          emit('main.domAction', { actionId, operation: operation === 'receive-save' || operation === 'policy-save' ? 'form' : 'click', control: operation, ...(fixtureIndex === undefined ? {} : { fixtureIndex }), mechanism: 'fixed-dom', isTrusted: false })
          await bounded(web.executeJavaScript(packagedRendererDomExpression(operation, fixtureIndex)))
          return wait(predicate)
        }
        const capture = async (): Promise<void> => {
          const image = await bounded(web.capturePage()), bytes = image.toPNG(), size = image.getSize(), file = path.join(imageDirectory, `${actionId ?? 'initial'}.png`)
          await writeFile(file, bytes, { flag: 'wx', mode: 0o600 })
          emit('main.screenshot', { actionId, path: file, sha256: sha(bytes), bytes: bytes.length, width: size.width, height: size.height })
        }
        await wait(value => value.readyState === 'complete')
        emit('main.window', { webContentsId: web.id, rendererPid: web.getOSProcessId(), frameUrl: web.getURL(), visible: window.isVisible(), bounds: window.getBounds() })
        const initial = await action('navigate', value => value.total !== null && !value.inventoryLoading)
        phase = profile.completed ? 'cold' : 'fresh'; phaseEvent(phase)
        if (phase === 'fresh') {
          if (initial.total !== 0 || initial.rows.length || models.size) throw new Error('首次合成工作库不是空状态。')
          await capture()
          for (let index = 0; index < 26; index++) {
            await action('receive-open', value => value.dialog)
            await action('receive-save', value => !value.dialog && !value.inventoryLoading && value.total === index + 1 && submissions.length === index + 1 && submissions.every(entry => acknowledged.has(entry.outboxId)), index)
          }
          phaseEvent('seeded'); await refresh(1); phaseEvent('matrix')
          for (const [operation, total] of [['filter-brand', 13], ['filter-query', 1], ['filter-decade', 9], ['filter-state', 5]] as const) {
            await action(operation, value => !value.inventoryLoading && value.total === total)
            await action('clear', value => !value.inventoryLoading && value.total === 26 && value.page === '1 / 2')
          }
          await action('next', value => !value.inventoryLoading && value.page === '2 / 2' && value.rows.length === 2); await capture()
          await action('previous', value => !value.inventoryLoading && value.page === '1 / 2' && value.rows.length === 24)
          await action('next', value => !value.inventoryLoading && value.page === '2 / 2' && value.rows.some(row => row.label.includes(PACKAGED_RENDERER_FIXTURE[0]!.model.name)))
          await action('detail-open', value => value.detail?.modelId === submissions[0]?.result.modelId, 0)
          phaseEvent('policy'); await action('policy-open', value => !!value.detail && value.detail.policy === 'normal')
          phaseEvent('stale')
          await action('policy-save', value => value.detail?.policy === 'collector' && value.detail.reserve === '2' && submissions.length === 27 && submissions.every(entry => acknowledged.has(entry.outboxId)) && models.get(value.detail.modelId)?.collectorPolicy === 'collector')
          await capture(); await refresh(2); phaseEvent('refreshed')
          await action('detail-close', value => value.total === 26 && !value.detail)
          // 原筛选submit重新查询；不会调用旧错误态“刷新库存”或业务API。
          await action('filter-brand', value => !value.inventoryLoading && value.total === 13)
          await action('clear', value => !value.inventoryLoading && value.total === 26)
          await action('next', value => !value.inventoryLoading && value.page === '2 / 2' && value.rows.length === 2)
          await action('previous', value => !value.inventoryLoading && value.page === '1 / 2' && value.rows.length === 24)
        } else {
          if (initial.total !== 26 || submissions.length || domainWrites) throw new Error('冷启动合成库不完整或出现业务写入。')
          await action('next', value => !value.inventoryLoading && value.page === '2 / 2' && value.rows.length === 2)
          await action('previous', value => !value.inventoryLoading && value.page === '1 / 2' && value.rows.length === 24)
        }
        await action('next', value => !value.inventoryLoading && value.page === '2 / 2' && value.rows.some(row => row.label.includes(PACKAGED_RENDERER_FIXTURE[0]!.model.name)))
        const finalDetail = await action('detail-open', value => value.detail?.policy === 'collector' && value.detail.reserve === '2' && value.detail.total === 1 && value.detail.openedBlank === 1, 0)
        await capture()
        const actualModels = [...models.values()].sort((left, right) => left.name.localeCompare(right.name, 'en'))
        if (actualModels.length !== 26) throw new Error('实际型号集合不完整。')
        for (let index = 0; index < 26; index++) {
          const actual = actualModels[index]!, fixture = PACKAGED_RENDERER_FIXTURE[index]!
          if (!Object.entries(fixture.model).every(([key, value]) => isDeepStrictEqual(actual[key as keyof CollectionModel], value)) || actual.counts.total !== 1 || actual.counts.openedBlank !== 1 || actual.lengths.length !== 1 || actual.lengths[0] !== 60 || actual.minimumSealedReserve !== (index === 0 ? 2 : 0) || actual.collectorPolicy !== (index === 0 ? 'collector' : 'normal')) throw new Error('实际型号或保护结果不符合固定fixture。')
        }
        const policyModelId = finalDetail.detail!.modelId, policyRevision = models.get(policyModelId)!.revision
        let marker: PackagedRendererCompletedMarker, completedMarkerSha256: string
        if (phase === 'fresh') {
          if (domainWrites !== 27 || submissions.length !== 27 || new Set(submissions.map(entry => entry.commandId)).size !== 27 || acknowledged.size !== 27 || submissions.slice(0, 26).some((entry, index) => entry.command !== 'collection.receive' || !isDeepStrictEqual({ model: entry.payload.model, lengthMinutes: entry.payload.lengthMinutes, quantities: entry.payload.quantities }, PACKAGED_RENDERER_FIXTURE[index])) || submissions[26]?.command !== 'collection.setPolicy' || submissions[26].payload.modelId !== policyModelId || submissions[26].payload.collectorPolicy !== 'collector' || submissions[26].payload.minimumSealedReserve !== 2) throw new Error('原持久outbox回执不完整。')
          marker = { schemaVersion: 1, kind: 'rust013-completed-profile', nonce: profile.nonce, fixtureSha256: PACKAGED_RENDERER_FIXTURE_SHA256, datasetId: submissions[0]!.datasetId, commandIds: submissions.map(entry => entry.commandId), outboxIds: submissions.map(entry => entry.outboxId), models: actualModels, policyModelId, policyRevision }
          const bytes = Buffer.from(JSON.stringify(marker, null, 2) + '\n'); await writeFile(profile.completedPath, bytes, { flag: 'wx', mode: 0o600 }); completedMarkerSha256 = sha(bytes)
        } else {
          marker = profile.completed!
          if (submissions.length || domainWrites || !isDeepStrictEqual(actualModels, marker.models) || marker.policyModelId !== policyModelId || marker.policyRevision !== policyRevision) throw new Error('冷启实际DTO与完成标记不一致。')
          completedMarkerSha256 = profile.completedMarkerSha256!
        }
        emit('main.rendererProbeComplete', { phase, fixtureCount: 26, fixtureSha256: PACKAGED_RENDERER_FIXTURE_SHA256, commandIds: marker.commandIds, modelIds: actualModels.map(model => model.id), policyModelId, policyRevision, nonce: profile.nonce, completedMarkerSha256 })
      } catch (error) { emit('main.probeFailed', { code: 'PROBE_FAILED' }); throw error }
      finally { actionId = null }
    },
  }
}
