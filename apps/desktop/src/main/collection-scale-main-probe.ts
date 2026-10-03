import { createHash, randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Readable } from 'node:stream'
import { closeSync, constants, lstatSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { isCollectionModel, isCollectionReadonlySettings, validateIpcRequest, validateIpcResponseForCommand, type CollectionModel, type IpcRequest } from '@music-bridge/contracts'
import type { BrowserWindow } from 'electron'
import type { CoreMessagePort, CoreChildProcess, CoreSupervisorLifecycle } from './core-supervisor.js'
import type { CollectionReadonlyControlPort } from './collection-readonly-control-client.js'
import { observeCollectionReadonlyIpc } from './collection-readonly-main-probe.js'
import { writeCollectionReadonlyPreference } from './collection-readonly-settings.js'
import { collectionScaleDomExpression, COLLECTION_SCALE_WORKLOADS, type CollectionScaleDomOperation, type CollectionScaleWorkload, type CollectionScaleDomSnapshot } from '../../e2e/collection-scale-dom-driver.js'
import type { CollectionReadonlyDomSnapshot } from './collection-readonly-dom-driver.js'

declare const __MUSIC_BRIDGE_COLLECTION_SCALE_DIAGNOSTICS__: boolean
declare const __MUSIC_BRIDGE_COLLECTION_SCALE_MODELS__: number | null
export const COLLECTION_SCALE_EVIDENCE_PREFIX = 'RUST015_EVIDENCE '
const counts = [0, 100, 2000, 2001, 5000, 5001] as const
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value)
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const exact = (value: unknown, keys: readonly string[]): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value) && Reflect.ownKeys(value).length === keys.length && keys.every(key => { const field = Object.getOwnPropertyDescriptor(value, key); return field?.enumerable && Object.hasOwn(field, 'value') })
export function createCollectionScaleEvidenceWriter(actor: 'main' | 'core', sink: (line: string) => void = line => { process.stdout.write(line) }) {
  let sequence = 0; const origin = performance.now()
  return (event: string, data: Record<string, unknown> = {}): void => {
    try { const result: unknown = sink(`${COLLECTION_SCALE_EVIDENCE_PREFIX}${JSON.stringify({ schemaVersion: 1, actor, pid: process.pid, sequence: ++sequence, elapsedMs: performance.now() - origin, event, data })}\n`); if (result !== undefined) void Promise.resolve(result).catch(() => {}) } catch { /* 缺失观察由Gate拒绝，不改变业务。 */ }
  }
}
export interface CollectionScaleCompletedMarker { schemaVersion: 1; kind: 'rust015-completed-profile'; nonce: string; modelCount: number; datasetId: string; commandIds: string[]; outboxIds: string[]; policyModelId: string | null; policyRevision: number | null }
export function readCollectionScaleProfile(env: NodeJS.ProcessEnv) {
  if (typeof __MUSIC_BRIDGE_COLLECTION_SCALE_DIAGNOSTICS__ !== 'boolean' || !__MUSIC_BRIDGE_COLLECTION_SCALE_DIAGNOSTICS__ || typeof __MUSIC_BRIDGE_COLLECTION_SCALE_MODELS__ !== 'number' || !counts.includes(__MUSIC_BRIDGE_COLLECTION_SCALE_MODELS__ as typeof counts[number])
    || env.MUSIC_BRIDGE_UI_E2E !== '1' || env.MUSIC_BRIDGE_UI_E2E_OFFLINE !== '1' || env.MUSIC_BRIDGE_STARTUP_TEST !== undefined) throw new Error('规模观察仅允许静态候选与固定离线profile。')
  const directory = env.MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR
  if (!directory || !directory.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/') || path.resolve(directory) !== directory || !/^musicbridge-ui-diagnostics-[A-Za-z0-9._-]+$/u.test(path.basename(directory))) throw new Error('规模profile词法边界未准入。')
  const volume = lstatSync('/Volumes/LifeWeave', { bigint: true }), identity = lstatSync(directory, { bigint: true })
  if (!identity.isDirectory() || identity.isSymbolicLink() || identity.dev !== volume.dev || (identity.mode & 0o077n) !== 0n || realpathSync(directory) !== directory) throw new Error('规模profile真实身份无效。')
  const read = (file: string, max: bigint): Buffer => { const info = lstatSync(file, { bigint: true }); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || (info.mode & 0o077n) !== 0n || info.size > max) throw new Error('规模标记真实身份无效。'); return readFileSync(file) }
  const markerBytes = read(path.join(directory, 'rust015-profile.json'), 4096n), marker: unknown = JSON.parse(markerBytes.toString())
  if (!exact(marker, ['schemaVersion', 'kind', 'nonce', 'modelCount', 'seedReceipt']) || marker.schemaVersion !== 1 || marker.kind !== 'rust015-synthetic-profile' || !uuid(marker.nonce) || marker.modelCount !== __MUSIC_BRIDGE_COLLECTION_SCALE_MODELS__ || !exact(marker.seedReceipt, ['path', 'sha256']) || typeof marker.seedReceipt.path !== 'string' || !/^[a-f0-9]{64}$/u.test(marker.seedReceipt.sha256)) throw new Error('规模标记与静态期待不一致。')
  const receiptPath = marker.seedReceipt.path as string
  if (path.resolve(receiptPath) !== receiptPath || path.dirname(receiptPath) !== directory) throw new Error('规模seed收据必须属于同profile。')
  const seedReceiptBytes = read(receiptPath, 64n * 1024n * 1024n)
  if (hash(seedReceiptBytes) !== marker.seedReceipt.sha256) throw new Error('规模seed收据身份不一致。')
  const completedPath = path.join(directory, 'rust015-completed.json'); let completed: CollectionScaleCompletedMarker | undefined, completedMarkerSha256: string | undefined
  try {
    const bytes = read(completedPath, 4096n), value: unknown = JSON.parse(bytes.toString())
    if (!exact(value, ['schemaVersion', 'kind', 'nonce', 'modelCount', 'datasetId', 'commandIds', 'outboxIds', 'policyModelId', 'policyRevision']) || value.schemaVersion !== 1 || value.kind !== 'rust015-completed-profile' || value.nonce !== marker.nonce || value.modelCount !== marker.modelCount || !uuid(value.datasetId) || !Array.isArray(value.commandIds) || !Array.isArray(value.outboxIds) || value.commandIds.length !== (marker.modelCount ? 1 : 0) || value.outboxIds.length !== value.commandIds.length || !value.commandIds.every(uuid) || !value.outboxIds.every(uuid) || (marker.modelCount ? !uuid(value.policyModelId) || !Number.isSafeInteger(value.policyRevision) : value.policyModelId !== null || value.policyRevision !== null)) throw new Error('规模完成标记不完整。')
    completed = value as unknown as CollectionScaleCompletedMarker; completedMarkerSha256 = hash(bytes)
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  return { directory, nonce: marker.nonce as string, modelCount: marker.modelCount as number, markerSha256: hash(markerBytes), seedReceiptSha256: marker.seedReceipt.sha256 as string, profileDev: String(identity.dev), profileIno: String(identity.ino), completedPath, completed, completedMarkerSha256 }
}
const commands = new Set(['commandOutbox.context', 'commandOutbox.execute', 'collection.list', 'collection.detail', 'core.shutdown', 'recordingPrintWorker.claim'])
/** 仅原控件明确发送的两个空文本字段观察等价；原IPC/fullDTO完全保留。 */
export function collectionScaleFilterEquivalent(actual: unknown, expected: unknown): boolean {
  const canonical = (value: unknown): unknown => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !Object.getOwnPropertyDescriptor(value, key)?.enumerable || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))) return value
    return Object.fromEntries(Object.entries(value).filter(([key, field]) => !(['query', 'brand'].includes(key) && field === '')))
  }
  return isDeepStrictEqual(canonical(actual), canonical(expected))
}
export interface CollectionScaleWarmSelection { finalSubmitRendererSequence: number; observationId: string; generation: number; catalogOrdinal: number; invokeId: string; requestId: string; paintRendererSequence: number }
type WarmEvidence = { renderer: { pid?: number; sequence: number; event: string; data: any }[]; main: { event: string; data: any }[] }
export interface CollectionScaleSettingsStatusSelection { observationId: string; generation: number; invokeId: string; requestId: string; paintRendererSequence: number }
/** 仅选择当前已接收事件中的最新status；之后同action的周期轮询仍完整保留。 */
export function selectCollectionScaleSettingsStatus(actionId: string, snapshot: CollectionReadonlyDomSnapshot, evidence: WarmEvidence): CollectionScaleSettingsStatusSelection | undefined {
  const renderer = evidence.renderer.filter(value => value.data.actionId === actionId), main = evidence.main.filter(value => value.data.actionId === actionId)
  const reads = renderer.filter(value => value.event === 'renderer.begin' && value.data.layer === 'control' && value.data.request?.operation === 'status')
  const latest = reads.at(-1)
  if (!latest) return undefined
  const ipcs = main.filter(value => value.event === 'main.ipcRequest' && value.data.channel === 'collection:readonly-settings'), controls = main.filter(value => value.event === 'main.controlRequest' && value.data.request?.type === 'status')
  // 两个进程独立到达；数量尚未闭合时继续等，不能猜测邻近日志或相同DTO。
  if (ipcs.length !== reads.length || controls.length !== reads.length) return undefined
  for (let index = 0; index < reads.length; index++) {
    const read = reads[index]!, ipc = ipcs[index]!.data, control = controls[index]!.data.request
    if (!isDeepStrictEqual(read.data.request, { operation: 'status' }) || !isDeepStrictEqual(ipc.args, []) || ipc.sender?.trusted !== true || ipc.sender.rendererPid !== read.pid || ipc.sender.frameUrl !== 'musicbridge://app/index.html' || (index > 0 && read.data.generation <= reads[index - 1]!.data.generation) || control.schemaVersion !== 1 || !uuid(control.requestId) || !uuid(control.generationNonce)) throw new Error('原settings status读取次序、sender或请求身份不一致。')
  }
  const fields = latest.data, stages = ['renderer.invokeReply', 'renderer.commit', 'renderer.nextTick', 'renderer.paint'].map(event => renderer.filter(value => value.event === event && value.data.observationId === fields.observationId))
  if (renderer.some(value => ['renderer.discarded', 'renderer.invokeRejected', 'renderer.observationRejected'].includes(value.event) && value.data.observationId === fields.observationId)) throw new Error('原settings最新status观察已拒绝。')
  if (stages.some(values => !values.length)) return undefined
  if (stages.some(values => values.length !== 1)) throw new Error('原settings最新status观察阶段不唯一。')
  const [invoke, commit, tick, paint] = stages.map(values => values[0]!)
  if (!(latest.sequence < invoke!.sequence && invoke!.sequence < commit!.sequence && commit!.sequence < tick!.sequence && tick!.sequence < paint!.sequence) || [invoke, commit, tick, paint].some(value => value!.pid !== latest.pid || value!.data.layer !== 'control' || value!.data.generation !== fields.generation || value!.data.triggerSequence !== fields.triggerSequence || value!.data.triggerDomEvent !== fields.triggerDomEvent || value!.data.catalogOrdinal !== null || !isDeepStrictEqual(value!.data.request, fields.request))) throw new Error('原settings最新status commit/tick/paint身份未闭合。')
  const ipc = ipcs.at(-1)!.data, control = controls.at(-1)!.data.request
  const replies = main.filter(value => value.event === 'main.ipcReply' && value.data.invokeId === ipc.invokeId), privateReplies = main.filter(value => value.event === 'main.controlReply' && value.data.requestId === control.requestId)
  if (main.some(value => value.event === 'main.ipcRejected' && value.data.invokeId === ipc.invokeId)) throw new Error('原settings status IPC已拒绝。')
  if (!replies.length || !privateReplies.length) return undefined
  const status = replies[0]!.data.result, response = privateReplies[0]!.data.response
  if (replies.length !== 1 || privateReplies.length !== 1 || replies[0]!.data.channel !== 'collection:readonly-settings' || !isCollectionReadonlySettings(status) || privateReplies[0]!.data.generationNonce !== control.generationNonce || response.schemaVersion !== 1 || response.type !== 'status' || response.ok !== true || response.requestId !== control.requestId || response.generationNonce !== control.generationNonce || [invoke!.data.result, commit!.data.result, response.status].some(value => !isDeepStrictEqual(value, status))) throw new Error('原settings status完整DTO或私有回执不一致。')
  if (!isDeepStrictEqual(snapshot.readonlySettings, { enabled: status.enabled, mode: status.mode, state: status.state })) return undefined
  return { observationId: fields.observationId, generation: fields.generation, invokeId: ipc.invokeId, requestId: control.requestId, paintRendererSequence: paint!.sequence }
}
/** 按原Buffer/LF分帧，UTF8只在完整原行解码；尾片段必须成为失败证据。 */
export function createCollectionScaleCoreEvidenceReader(options: { line(bytes: Buffer): void; incomplete(bytes: Buffer): void; overflow(): void }) {
  let chunks: Buffer[] = [], length = 0, discarding = false, ended = false
  return {
    push(bytes: Buffer): void {
      if (ended) return
      let offset = 0
      while (offset < bytes.length) {
        const newline = bytes.indexOf(10, offset), end = newline < 0 ? bytes.length : newline + 1, part = bytes.subarray(offset, end)
        if (!discarding && length + part.length > 16 * 1024 * 1024) { chunks = []; length = 0; discarding = true; options.overflow() }
        if (!discarding) { chunks.push(part); length += part.length }
        if (newline >= 0) { if (!discarding) options.line(Buffer.concat(chunks, length)); chunks = []; length = 0; discarding = false }
        offset = end
      }
    },
    end(): void { if (ended) return; ended = true; if (length) options.incomplete(Buffer.concat(chunks, length)); chunks = []; length = 0 },
  }
}

/** Electron exit的finally会清stdout监听；先暂停，再在microtask仅恢复本观察器。 */
export function createCollectionScaleCoreStreamDrain(stream: Readable, callbacks: { data(chunk: Buffer): void; end(): void }) {
  let ended = false, disposed = false, resolve!: () => void
  const done = new Promise<void>(accept => { resolve = accept })
  const data = (chunk: Buffer | string) => callbacks.data(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  const detach = () => { stream.off('data', data); stream.off('end', end); stream.off('close', end) }
  const end = () => { if (ended || disposed) return; ended = true; detach(); callbacks.end(); resolve() }
  const attach = () => { stream.on('data', data); stream.on('end', end); stream.on('close', end) }
  if (stream.readableEnded || stream.closed) end(); else attach()
  return {
    done,
    exit(): void {
      if (ended || disposed) return
      stream.pause?.()
      queueMicrotask(() => {
        if (ended || disposed) return
        if (stream.readableEnded || stream.closed) { end(); return }
        // 不删除或恢复其它消费者；避免重复挂本probe三个监听。
        detach(); attach(); stream.resume?.()
      })
    },
    dispose(): void { if (disposed) return; disposed = true; detach() },
  }
}
/** 排空属于诊断IO开销；受控负例可收紧预算，候选固定最多5秒。 */
export function waitForCollectionScaleEvidenceDrain(drains: ReturnType<typeof createCollectionScaleCoreStreamDrain>[], flush: () => Promise<void>, budgetMs = 5000): Promise<void> {
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 5000) return Promise.reject(new Error('Core证据排空预算无效。'))
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: unknown) => {
      if (settled) return; settled = true; clearTimeout(timer)
      for (const drain of drains) drain.dispose()
      if (error !== undefined) reject(error); else resolve()
    }
    const timer = setTimeout(() => finish(new Error('Core证据输出未在5秒预算内排空。')), budgetMs)
    void Promise.resolve().then(flush).then(() => Promise.all(drains.map(value => value.done))).then(flush).then(() => finish(), finish)
  })
}
/** 每个原读取都核对；仅最后真实submit的当前最高代际可成为样本。 */
export function selectCollectionScaleWarmRead(actionId: string, workload: CollectionScaleWorkload, evidence: WarmEvidence): { selection: CollectionScaleWarmSelection; reply: any } | undefined {
  const renderer = evidence.renderer.filter(value => value.data.actionId === actionId), main = evidence.main.filter(value => value.data.actionId === actionId)
  const submit = renderer.filter(value => value.event === 'renderer.trigger' && value.data.domEvent === 'submit').at(-1)
  if (!submit) return undefined
  if (submit.data.target !== 'FORM') throw new Error('最终submit不是原FORM事件。')
  const reads = renderer.filter(value => value.event === 'renderer.begin' && value.data.layer === 'catalog'), latest = reads.at(-1)
  if (!latest || latest.sequence < submit.sequence) return undefined
  const final = reads.filter(value => value.data.triggerSequence === submit.sequence && value.data.triggerDomEvent === 'submit')
  if (final.length !== 1 || final[0] !== latest || reads.some(value => value.data.generation > latest.data.generation)) throw new Error('最终submit并非唯一最新catalog读取。')
  const stages = ['renderer.invokeReply', 'renderer.commit', 'renderer.nextTick', 'renderer.paint'].map(event => renderer.filter(value => value.event === event && value.data.observationId === latest.data.observationId))
  if (stages.some(values => !values.length)) return undefined
  if (stages.some(values => values.length !== 1)) throw new Error('最终submit观察阶段不唯一。')
  const [invoke, commit, tick, paint] = stages.map(values => values[0]!)
  if (!(latest.sequence < invoke!.sequence && invoke!.sequence < commit!.sequence && commit!.sequence < tick!.sequence && tick!.sequence < paint!.sequence) || [invoke, commit, tick, paint].some(value => value!.data.generation !== latest.data.generation || value!.data.catalogOrdinal !== latest.data.catalogOrdinal || value!.data.triggerSequence !== submit.sequence || value!.data.triggerDomEvent !== 'submit' || !isDeepStrictEqual(value!.data.request, latest.data.request))) throw new Error('最终submit最新代际paint身份未闭合。')
  const ipcs = main.filter(value => value.event === 'main.ipcRequest' && value.data.channel === 'collection:list' && value.data.args?.[0]?.limit === 24)
  if (ipcs.length < reads.length) return undefined
  if (ipcs.length !== reads.length) throw new Error('同action原catalog读取数量不一致。')
  for (let index = 0; index < reads.length; index++) {
    const read = reads[index]!.data, ipc = ipcs[index]!.data
    if (read.catalogOrdinal !== index + 1 || ipc.catalogOrdinal !== index + 1 || (index > 0 && read.generation <= reads[index - 1]!.data.generation) || !isDeepStrictEqual(read.request, { page: ipc.args[0], filter: ipc.args[1] ?? {} })) throw new Error('同action原catalog次序或参数不一致。')
    const publicRequests = main.filter(value => value.event === 'main.request' && value.data.invokeId === ipc.invokeId && value.data.request?.command === 'collection.list')
    if (!publicRequests.length) return undefined
    if (publicRequests.length !== 1 || publicRequests[0]!.data.catalogOrdinal !== read.catalogOrdinal || !isDeepStrictEqual(publicRequests[0]!.data.request.payload, read.request)) throw new Error('原IPC与公开请求owner身份未闭合。')
  }
  if (!collectionScaleFilterEquivalent(latest.data.request.filter, COLLECTION_SCALE_WORKLOADS[workload]) || !isDeepStrictEqual(latest.data.request.page, { offset: 0, limit: 24 })) throw new Error('最终submit工作量参数不一致。')
  const ipc = ipcs.at(-1)!.data, request = main.find(value => value.event === 'main.request' && value.data.invokeId === ipc.invokeId && value.data.request?.command === 'collection.list')!.data.request
  const replies = main.filter(value => value.event === 'main.ipcReply' && value.data.invokeId === ipc.invokeId), responses = main.filter(value => value.event === 'main.response' && value.data.requestId === request.id && value.data.invokeId === ipc.invokeId)
  if (!replies.length || !responses.length) return undefined
  if (replies.length !== 1 || responses.length !== 1 || replies[0]!.data.catalogOrdinal !== latest.data.catalogOrdinal || responses[0]!.data.catalogOrdinal !== latest.data.catalogOrdinal || responses[0]!.data.reply?.ok !== true || renderer.some(value => value.event === 'renderer.discarded' && value.data.observationId === latest.data.observationId) || [invoke!.data.result, commit!.data.result, responses[0]!.data.reply.result].some(value => !isDeepStrictEqual(value, replies[0]!.data.result))) throw new Error('最终submit原回执或最新commit不一致。')
  return { selection: { finalSubmitRendererSequence: submit.sequence, observationId: latest.data.observationId, generation: latest.data.generation, catalogOrdinal: latest.data.catalogOrdinal, invokeId: ipc.invokeId, requestId: request.id, paintRendererSequence: paint!.sequence }, reply: replies[0]!.data.result }
}
/** 无筛选时原UI没有清除按钮；省略动作前仍核对实际普通IPC筛选事实。 */
export function collectionScaleResetRequired(snapshot: Pick<CollectionScaleDomSnapshot, 'filterClearVisible'>, lastFilter: unknown): boolean {
  if (snapshot.filterClearVisible === true) return true
  if (snapshot.filterClearVisible !== false || !collectionScaleFilterEquivalent(lastFilter, {})) throw new Error('原清除控件缺失但上一查询并非无筛选。')
  return false
}
export function createCollectionScaleMainProbe(options: { sink?: (line: string) => void; flush?: () => Promise<void> } = {}) {
  const profile = readCollectionScaleProfile(process.env), sink = options.sink ?? (line => { process.stdout.write(line) }), writeEvidence = createCollectionScaleEvidenceWriter('main', sink)
  const evidence: WarmEvidence = { main: [], renderer: [] }, emit = (event: string, data: Record<string, unknown> = {}) => { evidence.main.push({ event, data }); writeEvidence(event, data) }
  const ipcOwner = new AsyncLocalStorage<{ actionId: string | null; invokeId: string | null; catalogOrdinal: number | null }>(), catalogOrdinals = new Map<string, number>()
  const requests = new Map<string, { request: IpcRequest; started: number; actionId: string | null; invokeId: string | null; catalogOrdinal: number | null }>(), invocations = new Map<string, { data: any; started: number; actionId: string | null }>()
  const replies: { actionId: string | null; channel: string; args: any[]; result: any }[] = [], paints: any[] = [], models = new Map<string, CollectionModel>(), submissions: any[] = [], acknowledged = new Set<string>()
  const latestRendererReads = new Map<string, string>()
  let actionId: string | null = null, executed = false, domainWrites = 0, datasetId: string | undefined
  let ipcRequestCount = 0, ipcReplyCount = 0, ipcRejectedCount = 0, uiPublicRejected = false
  const lifecycleStarts = new Map<string, number>()
  let closeStarted: number | undefined
  const coreDrains: ReturnType<typeof createCollectionScaleCoreStreamDrain>[] = []
  let evidenceFlush: Promise<void> | undefined
  let rejectedCoreLines = 0
  const rejectCoreLine = (reason: 'INVALID_JSON' | 'FORWARD_FAILED' | 'INCOMPLETE_FRAGMENT', bytes: Buffer): void => {
    const ordinal = ++rejectedCoreLines
    let rawLinePath: string | null = null, rawSaved = false
    if (ordinal <= 4 && bytes.length <= 16 * 1024 * 1024) {
      const file = path.join(profile.directory, `rust015-core-rejected-${profile.nonce}-${process.pid}-${ordinal}.bin`)
      try {
        const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        try { writeFileSync(fd, bytes) } finally { closeSync(fd) }
        rawLinePath = file; rawSaved = true
      } catch { /* 原片段保存失败仍作为失败，不伪造可读文件。 */ }
    }
    emit('main.coreEvidenceRejected', { reason, rawBytes: bytes.length, rawSha256: hash(bytes), rawLinePath, rawSaved })
  }
  emit('main.diagnosticsInstalled', { modelCount: profile.modelCount, clock: 'main.performance.now', serialization: 'full-dto-diagnostic-overhead-included' })
  const observe = (event: string, data: Record<string, unknown>): void => {
    try {
      const copy = structuredClone(data) as any
      const owner = ipcOwner.getStore()
      let attributed = owner ? owner.actionId : actionId
      if (event === 'main.ipcRequest') {
        ipcRequestCount++
        copy.catalogOrdinal = attributed && copy.channel === 'collection:list' && copy.args?.[0]?.limit === 24 ? (catalogOrdinals.get(attributed) ?? 0) + 1 : null
        if (copy.catalogOrdinal !== null) catalogOrdinals.set(attributed!, copy.catalogOrdinal)
        if (owner) { owner.invokeId = copy.invokeId; owner.catalogOrdinal = copy.catalogOrdinal }
        invocations.set(copy.invokeId, { data: copy, started: performance.now(), actionId: attributed })
      }
      if (event === 'main.ipcReply' || event === 'main.ipcRejected') {
        if (event === 'main.ipcReply') ipcReplyCount++; else ipcRejectedCount++
        const pending = invocations.get(copy.invokeId); invocations.delete(copy.invokeId); attributed = pending?.actionId ?? null
        if (pending) copy.durationMs = performance.now() - pending.started
        if (event === 'main.ipcReply') copy.catalogOrdinal = pending?.data.catalogOrdinal ?? null
        if (pending && event === 'main.ipcReply') {
          replies.push({ actionId: attributed, channel: pending.data.channel, args: pending.data.args, result: copy.result })
          if (pending.data.channel === 'commandOutbox:submit' && copy.result?.ok === true) { const request = pending.data.args?.[0]?.request; if (request?.command === 'collection.setPolicy') submissions.push({ commandId: request.payload.commandId, outboxId: copy.result.outboxId, datasetId: request.datasetId, payload: request.payload, result: copy.result.result }) }
          if (pending.data.channel === 'commandOutbox:acknowledge' && copy.result?.acknowledged === true) acknowledged.add(copy.result.id)
        }
      }
      emit(event, { ...copy, actionId: attributed })
    } catch { emit('main.observationRejected') }
  }
  return {
    emit,
    flushCoreEvidence(): Promise<void> {
      return evidenceFlush ??= waitForCollectionScaleEvidenceDrain(coreDrains, options.flush ?? (() => new Promise<void>((resolve, reject) => {
        process.stdout.write('', error => error ? reject(error) : resolve())
      }))).catch(error => {
        emit('main.probeFailed', { code: 'PROBE_FAILED', reason: 'Core诊断输出排空失败。' })
        throw error
      })
    },
    observeIpc<E, A extends unknown[], R>(value: { channel: string; listener(event: E, ...args: A): R; trustedSender(event: E): { webContentsId: number; rendererPid: number; frameUrl: string; trusted: true } | undefined }) {
      const observed = observeCollectionReadonlyIpc({ ...value, observe })
      // 仅旁路owner贯穿原listener异步continuation；返回原Promise，不增加业务等待。
      return (event: E, ...args: A): R => ipcOwner.run({ actionId, invokeId: null, catalogOrdinal: null }, () => observed(event, ...args))
    },
    async writePreference(file: string, enabled: boolean): Promise<void> { const started = performance.now(); try { await writeCollectionReadonlyPreference(file, enabled); emit('main.preferenceSaved', { actionId, enabled, durationMs: performance.now() - started }) } catch (error) { emit('main.preferenceRejected', { actionId, enabled, durationMs: performance.now() - started }); throw error } },
    observeControlPort(port: CollectionReadonlyControlPort): void {
      const pending = new Map<string, { started: number; actionId: string | null }>(), post = port.postMessage.bind(port)
      port.postMessage = value => { try { const request = value as any; if (uuid(request.requestId)) { pending.set(request.requestId, { started: performance.now(), actionId }); emit('main.controlRequest', { actionId, request }) } } catch { emit('main.observationRejected') } post(value) }
      port.on('message', ({ data }) => { try { const response = data as any, own = pending.get(response.requestId); if (!own) return; pending.delete(response.requestId); emit('main.controlReply', { actionId: own.actionId, requestId: response.requestId, generationNonce: response.generationNonce, response, durationMs: performance.now() - own.started }) } catch { emit('main.observationRejected') } })
      port.on('close', () => emit('main.controlClosed', { pendingCount: pending.size }))
    },
    observeLifecycle(value: CoreSupervisorLifecycle | string, code?: number): void {
      if (typeof value !== 'string') { emit('main.supervisorLifecycle', { ...value }); return }
      if (value === 'before-quit') closeStarted ??= performance.now()
      if (value.endsWith('-start')) lifecycleStarts.set(value.slice(0, -6), performance.now())
      const key = value.endsWith('-end') ? value.slice(0, -4) : null, started = key ? lifecycleStarts.get(key) : undefined
      emit('main.lifecycle', { event: value, ...(code === undefined ? {} : { code }), ...(started === undefined ? {} : { durationMs: performance.now() - started }) })
      if (value === 'will-quit' && closeStarted !== undefined) emit('main.closeCost', { durationMs: performance.now() - closeStarted, scope: 'ordinary-before-quit-to-will-quit', outboxCloseIncluded: true })
    },
    observeWindow(window: BrowserWindow): void { emit('main.window', { webContentsId: window.webContents.id, rendererPid: window.webContents.getOSProcessId(), frameUrl: window.webContents.getURL(), visible: window.isVisible(), bounds: window.getBounds() }) },
    observeRenderer(window: BrowserWindow): void {
      window.webContents.on('console-message', (_event, _level, message) => {
        if (!message.startsWith(COLLECTION_SCALE_EVIDENCE_PREFIX)) return
        try {
          const value = JSON.parse(message.slice(COLLECTION_SCALE_EVIDENCE_PREFIX.length))
          if (value.actor !== 'renderer' || value.schemaVersion !== 1 || !Number.isSafeInteger(value.sequence) || !Number.isFinite(value.elapsedMs) || typeof value.event !== 'string' || !value.event.startsWith('renderer.')) throw new Error('Renderer观察结构无效。')
          value.pid = window.webContents.getOSProcessId()
          evidence.renderer.push(value)
          if (value.event === 'renderer.begin' && value.data.request?.operation !== 'status') latestRendererReads.set(`${value.data.actionId}:${value.data.layer}`, value.data.observationId)
          if (value.event === 'renderer.paint') paints.push(value.data)
          sink(COLLECTION_SCALE_EVIDENCE_PREFIX + JSON.stringify(value) + '\n')
        } catch { emit('main.rendererEvidenceRejected') }
      })
    },
    observePublicPort(port: CoreMessagePort): void {
      const post = port.postMessage.bind(port)
      port.postMessage = value => { try { const checked = validateIpcRequest(value); if (checked.ok && commands.has(checked.value.command)) {
        const request = structuredClone(checked.value), owner = ipcOwner.getStore(), attributed = owner ? owner.actionId : actionId, invokeId = owner?.invokeId ?? null, catalogOrdinal = owner?.catalogOrdinal ?? null
        requests.set(request.id, { request, started: performance.now(), actionId: attributed, invokeId, catalogOrdinal }); if (request.command === 'commandOutbox.execute') domainWrites++
        emit('main.request', { actionId: attributed, invokeId, catalogOrdinal, request, requestJsonBytes: Buffer.byteLength(JSON.stringify(request)), requestSha256: digest(request) })
      } } catch { emit('main.observationRejected') } post(value) }
      port.on('message', ({ data }) => { try { const packet = data as any, own = requests.get(packet?.id); if (!own) return; requests.delete(packet.id); const checked = validateIpcResponseForCommand(data, own.request.command); if (own.invokeId !== null && (!checked.ok || !checked.value.ok)) uiPublicRejected = true; if (checked.ok && checked.value.ok && own.request.command === 'commandOutbox.context') datasetId = (checked.value.result as { datasetId: string }).datasetId; if (checked.ok && checked.value.ok && ['collection.list', 'collection.detail'].includes(own.request.command)) { const result = checked.value.result as any; for (const model of own.request.command === 'collection.list' ? result.items : [result.model]) if (isCollectionModel(model)) models.set(model.id, structuredClone(model)) } emit('main.response', { actionId: own.actionId, invokeId: own.invokeId, catalogOrdinal: own.catalogOrdinal, requestId: packet.id, command: own.request.command, reply: data, durationMs: performance.now() - own.started, replyJsonBytes: Buffer.byteLength(JSON.stringify(data)), replySha256: digest(data) }) } catch { emit('main.observationRejected') } })
      emit('main.channelCreated')
    },
    observeChild(child: CoreChildProcess, entryPath: string, args: string[]): void {
      emit('main.coreFork', { entryPath, args: [...args] }); let pid: number | null = null;
      (child as unknown as { once(event: 'spawn', listener: () => void): unknown }).once('spawn', () => { pid = (child as any).pid ?? null; emit('main.coreSpawn', { pid }) })
      const reader = createCollectionScaleCoreEvidenceReader({
        line: bytes => {
          if (!bytes.subarray(0, COLLECTION_SCALE_EVIDENCE_PREFIX.length).equals(Buffer.from(COLLECTION_SCALE_EVIDENCE_PREFIX))) return
          let line: string, value: any
          try { line = new TextDecoder('utf-8', { fatal: true }).decode(bytes); value = JSON.parse(line.slice(COLLECTION_SCALE_EVIDENCE_PREFIX.length)) } catch { rejectCoreLine('INVALID_JSON', bytes); return }
          if (value.actor === 'core') { try { sink(line) } catch { rejectCoreLine('FORWARD_FAILED', bytes) } }
        },
        incomplete: bytes => rejectCoreLine('INCOMPLETE_FRAGMENT', bytes),
        overflow: () => emit('main.coreEvidenceOverflow'),
      })
      const stream = child.stdout as unknown as Readable | undefined
      const drain = stream ? createCollectionScaleCoreStreamDrain(stream, { data: bytes => reader.push(bytes), end: () => reader.end() }) : undefined
      if (drain) coreDrains.push(drain)
      child.once('exit', code => { drain?.exit(); emit('main.coreExit', { code, pid }) })
    },
    async runWindowProbe(window: BrowserWindow): Promise<void> {
      if (executed) throw new Error('固定规模流程不能重复。'); executed = true
      const phase = profile.completed ? 'cold' : 'fresh', start = performance.now(), web = window.webContents, count = profile.modelCount
      emit('main.profileValidated', { ...profile, completed: undefined, phase })
      const snapshot = async () => await web.executeJavaScript(collectionScaleDomExpression('snapshot')) as CollectionScaleDomSnapshot
      const wait = async (predicate: (value: CollectionReadonlyDomSnapshot) => boolean, settingsActionId?: string) => {
        const started = performance.now(); let pollCount = 0
        while (performance.now() - started < 30_000 && performance.now() - start < 600_000) {
          const value = await snapshot(); pollCount++
          if (value.frameUrl !== 'musicbridge://app/index.html' || value.errorCount || value.rows.some(row => !row.label.includes('RUST015 合成型号'))) throw new Error('规模控件出现未准入状态。')
          const settingsStatusSelection = settingsActionId ? selectCollectionScaleSettingsStatus(settingsActionId, value, evidence) : null
          if (predicate(value) && (!settingsActionId || settingsStatusSelection)) { emit('main.domSettled', { actionId, pollCount, durationMs: performance.now() - started, scope: 'engineering-poll-wait', snapshot: value, settingsStatusSelection }); return value }
          await new Promise(resolve => setTimeout(resolve, 20))
        }
        throw new Error('固定规模控件等待超过预算。')
      }
      const action = async (operation: CollectionScaleDomOperation, predicate: (value: CollectionReadonlyDomSnapshot) => boolean, metadata: { workload?: CollectionScaleWorkload; iteration?: number; mode?: 'node' | 'rust' } = {}, paintLayer?: 'catalog' | 'detail' | 'refresh' | 'control') => {
        actionId = randomUUID(); const own = actionId
        emit('main.domAction', { actionId, operation, ...metadata, mechanism: 'fixed-dom', isTrusted: false })
        const executeStarted = performance.now()
        await web.executeJavaScript(collectionScaleDomExpression(operation, { kind: 'rust015-dom-action', actionId, operation, ...metadata }))
        emit('main.domExecution', { actionId, durationMs: performance.now() - executeStarted, scope: 'engineering-execute-and-control-ready-wait' })
        return wait(value => predicate(value) && (operation === 'workload' ? !!selectCollectionScaleWarmRead(own, metadata.workload!, evidence) : !paintLayer || paints.some(item => item.actionId === own && item.layer === paintLayer && item.observationId === latestRendererReads.get(`${own}:${paintLayer}`))) && (!['readonly-on', 'readonly-off'].includes(operation) || replies.some(reply => reply.actionId === own && reply.channel === 'collection:set-readonly-enabled' && reply.result.enabled === (operation === 'readonly-on'))), operation === 'settings-open' ? own : undefined)
      }
      const settings = async (enabled: boolean) => {
        await action('settings-open', value => !!value.readonlySettings && !['enabling', 'closing'].includes(value.readonlySettings.state))
        const current = await snapshot()
        if (current.readonlySettings?.enabled !== enabled) await action(enabled ? 'readonly-on' : 'readonly-off', value => value.readonlySettings?.enabled === enabled && value.readonlySettings.mode === (enabled && count <= 2000 ? 'rust' : 'node') && value.readonlySettings.state === (enabled ? count <= 2000 ? 'ready' : 'failed' : 'off'), {}, 'control')
        await action('settings-close', value => value.total !== null && !value.inventoryLoading, {}, 'catalog')
      }
      const reset = async (): Promise<void> => {
        const value = await snapshot()
        const lastCatalog = replies.filter(reply => reply.channel === 'collection:list' && reply.args[0]?.limit === 24).at(-1)
        if (collectionScaleResetRequired(value, lastCatalog?.args[1] ?? (lastCatalog ? {} : undefined))) await action('clear', state => state.total === count && !state.inventoryLoading, {}, 'catalog')
        else {
          emit('main.domResetSkipped', { reason: 'original-clear-control-absent-in-unfiltered-state' })
        }
      }
      try {
        await wait(value => value.readyState === 'complete')
        await action('navigate', value => value.total === count && !value.inventoryLoading, {}, 'catalog')
        await settings(false)
        await reset()
        // 全页读取只走原分页控件；完整事实另由闭库SQLite独立核验。
        for (let page = 2; page <= Math.max(1, Math.ceil(count / 24)); page++) await action('next', value => value.page === `${page} / ${Math.ceil(count / 24)}` && !value.inventoryLoading, {}, 'catalog')
        if (models.size !== count) throw new Error('原Node分页未取得全部型号。')
        if (count) {
          await settings(true)
          await action('target', value => value.total === 1 && !value.inventoryLoading, {}, 'catalog')
          await action('detail-open', value => value.detail?.label.includes('RUST015 合成型号 000001') === true, {}, 'detail')
          if (phase === 'fresh') {
            await action('policy-open', value => value.detail?.policy === 'normal')
            await action('policy-save', value => value.detail?.policy === 'collector' && value.detail.reserve === '2' && submissions.length === 1 && acknowledged.has(submissions[0]?.outboxId), {}, 'detail')
          } else if (submissions.length || domainWrites) throw new Error('冷启出现重复策略写入。')
          await action('refresh', value => !value.inventoryLoading && !!value.detail, {}, 'refresh')
          if (!replies.some(reply => reply.actionId === actionId && reply.channel === 'collection:refresh' && reply.result.refreshed === (count <= 2000))) throw new Error('原refresh边界回执不一致。')
          await action('detail-close', value => !value.detail)
        } else { await settings(true); await action('refresh', value => value.total === 0 && !value.inventoryLoading, {}, 'refresh') }
        if (phase === 'fresh' && count <= 2000) {
          for (let iteration = -1; iteration < 10; iteration++) for (const mode of ['node', 'rust'] as const) {
            await settings(mode === 'rust')
            for (const workload of Object.keys(COLLECTION_SCALE_WORKLOADS) as CollectionScaleWorkload[]) {
              await reset()
              await action('workload', value => !value.inventoryLoading, { workload, iteration, mode }, 'catalog')
              const own = actionId!, selected = selectCollectionScaleWarmRead(own, workload, evidence)
              if (!selected) throw new Error('最终submit原工作量回执或paint缺失。')
              emit('main.warmSample', { actionId: own, workload, iteration, mode, warmup: iteration === -1, ...selected })
            }
          }
        }
        await reset()
        if (count > 2000) { await settings(false); await settings(true); await action('refresh', value => value.total === count && !value.inventoryLoading, {}, 'refresh') }
        await settings(true)
        const target = [...models.values()].find(model => model.name === 'RUST015 合成型号 000001'), policyModelId = target?.id ?? null, policyRevision = target?.revision ?? null
        if (count && (!target || target.collectorPolicy !== 'collector' || target.minimumSealedReserve !== 2)) throw new Error('原策略保存事实未确认。')
        if (!datasetId) throw new Error('原公开dataset身份缺失。')
        let completedMarkerSha256 = profile.completedMarkerSha256
        if (phase === 'fresh') {
          if (domainWrites !== (count ? 1 : 0) || submissions.length !== domainWrites || acknowledged.size !== domainWrites) throw new Error('原策略outbox唯一写入或ACK不完整。')
          const marker: CollectionScaleCompletedMarker = { schemaVersion: 1, kind: 'rust015-completed-profile', nonce: profile.nonce, modelCount: count, datasetId, commandIds: submissions.map(item => item.commandId), outboxIds: submissions.map(item => item.outboxId), policyModelId, policyRevision }
          const bytes = Buffer.from(JSON.stringify(marker, null, 2) + '\n'); await writeFile(profile.completedPath, bytes, { flag: 'wx', mode: 0o600 }); completedMarkerSha256 = hash(bytes)
        } else if (profile.completed?.policyModelId !== policyModelId || profile.completed.policyRevision !== policyRevision) throw new Error('冷启策略事实与完成标记不一致。')
        // 原DOM的微任务/绘制屏障让catalog watch后台读取先实际发出；每轮动态检查全部UI owner。
        const drainStarted = performance.now(), pendingUiCount = () => invocations.size + [...requests.values()].filter(value => value.invokeId !== null).length
        while (true) {
          const remaining = Math.min(30_000 - (performance.now() - drainStarted), 600_000 - (performance.now() - start))
          if (remaining <= 0) throw new Error('原UI IPC退出收口超过预算或缺少回执。')
          let timeout: ReturnType<typeof setTimeout> | undefined
          const value = await Promise.race([
            web.executeJavaScript(`(async()=>{await Promise.resolve();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));return await ${collectionScaleDomExpression('snapshot')};})()`) as Promise<CollectionScaleDomSnapshot>,
            new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('原UI DOM退出屏障超过预算。')), remaining) }),
          ]).finally(() => { if (timeout) clearTimeout(timeout) })
          if (value.frameUrl !== 'musicbridge://app/index.html' || value.errorCount || value.rows.some(row => !row.label.includes('RUST015 合成型号')) || value.total !== count || value.inventoryLoading || value.readonlySettings !== null || value.detail !== null || value.dialog) throw new Error('退出前原DOM最终事实不完整。')
          if (ipcRejectedCount || uiPublicRejected) throw new Error('退出前原UI IPC或公开请求已拒绝。')
          if (pendingUiCount() === 0 && ipcRequestCount === ipcReplyCount && paints.some(item => item.actionId === actionId && item.layer === 'catalog' && item.observationId === latestRendererReads.get(`${actionId}:catalog`))) break
          await new Promise(resolve => setTimeout(resolve, 20))
        }
        // 从最终DOM返回到原quit之间不再await；原观察计数与实时owner表仍必须同时闭合。
        if (pendingUiCount() || ipcRejectedCount || uiPublicRejected || ipcRequestCount !== ipcReplyCount) throw new Error('退出前原UI IPC最终同步收口失败。')
        emit('main.rendererIpcDrained', { scope: 'before-original-quit', pendingCount: 0, requestCount: ipcRequestCount, replyCount: ipcReplyCount, rejectedCount: 0 })
        emit('main.rendererProbeComplete', { phase, modelCount: count, commandIds: profile.completed?.commandIds ?? submissions.map(item => item.commandId), outboxIds: profile.completed?.outboxIds ?? submissions.map(item => item.outboxId), policyModelId, policyRevision, nonce: profile.nonce, completedMarkerSha256 })
      } catch (error) { emit('main.probeFailed', { code: 'PROBE_FAILED', reason: error instanceof Error ? error.message : '未知工程失败' }); throw error }
      finally { actionId = null }
    },
  }
}
