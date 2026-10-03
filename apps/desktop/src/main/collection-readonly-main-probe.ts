import { types } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { isDeepStrictEqual } from 'node:util'
import { validateIpcRequest, validateIpcResponseForCommand, isCollectionModel, type CollectionModel, type IpcRequest } from '@music-bridge/contracts'
import type { BrowserWindow } from 'electron'
import type { CoreMessagePort, CoreChildProcess, CoreSupervisorLifecycle } from './core-supervisor.js'
import { COLLECTION_READONLY_FIXTURE, COLLECTION_READONLY_FIXTURE_SHA256, collectionReadonlyDomExpression, type CollectionReadonlyDomOperation, type CollectionReadonlyDomSnapshot } from './collection-readonly-dom-driver.js'

declare const __MUSIC_BRIDGE_COLLECTION_READONLY_DIAGNOSTICS__: boolean
declare const __MUSIC_BRIDGE_COLLECTION_READONLY_PROBE_EXPECTATION__: null | 'node' | 'rust' | 'pin'
export const COLLECTION_READONLY_EVIDENCE_PREFIX = 'RUST014_EVIDENCE '
export interface CollectionReadonlyEvidenceEvent {
  schemaVersion: 1; actor: 'main' | 'core'; sequence: number; elapsedMs: number; pid: number; event: string; data: Record<string, unknown>
}
export const collectionReadonlyJsonSha256 = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function createCollectionReadonlyEvidenceWriter(actor: 'main' | 'core', sink: (line: string) => void = line => { process.stdout.write(line) }) {
  let sequence = 0
  const start = performance.now()
  return (event: string, data: Record<string, unknown> = {}): void => {
    try {
      const returned: unknown = sink(`${COLLECTION_READONLY_EVIDENCE_PREFIX}${JSON.stringify({ schemaVersion: 1, actor, sequence: ++sequence, elapsedMs: performance.now() - start, pid: process.pid, event, data })}\n`)
      if (returned !== undefined) void Promise.resolve(returned).catch(() => {})
    } catch { /* 观察失败留给证据门禁拒绝，不改变原业务或退出。 */ }
  }
}
export function assertCollectionReadonlyDiagnosticEnvironment(env: NodeJS.ProcessEnv): void {
  if (typeof __MUSIC_BRIDGE_COLLECTION_READONLY_DIAGNOSTICS__ !== 'boolean' || !__MUSIC_BRIDGE_COLLECTION_READONLY_DIAGNOSTICS__) throw new Error('只读观察仅允许编译诊断候选。')
  if (env.MUSIC_BRIDGE_UI_E2E !== '1' || env.MUSIC_BRIDGE_UI_E2E_OFFLINE !== '1'
    || !env.MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR || env.MUSIC_BRIDGE_STARTUP_TEST !== undefined) throw new Error('候选诊断只接受固定离线合成工作库。')
}
const externalRoot = '/Volumes/LifeWeave/Developer/CommandLine/tmp'
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value)
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const exact = (value: unknown, keys: readonly string[]): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value) && Reflect.ownKeys(value).length === keys.length && keys.every(key => { const field = Object.getOwnPropertyDescriptor(value, key); return field?.enumerable && Object.hasOwn(field, 'value') })
export interface CollectionReadonlyCompletedMarker {
  schemaVersion: 1; kind: 'rust014-completed-profile'; nonce: string; fixtureSha256: string; datasetId: string
  commandIds: string[]; outboxIds: string[]; models: CollectionModel[]; policyModelId: string; policyRevision: number
}
export function readCollectionReadonlyProfile(env: NodeJS.ProcessEnv) {
  assertCollectionReadonlyDiagnosticEnvironment(env)
  const directory = env.MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR!
  if (!directory.startsWith(externalRoot + '/') || path.resolve(directory) !== directory || !/^musicbridge-ui-diagnostics-[A-Za-z0-9._-]+$/u.test(path.basename(directory))) throw new Error('合成工作库路径未准入。')
  const volume = lstatSync('/Volumes/LifeWeave', { bigint: true }), profile = lstatSync(directory, { bigint: true })
  if (!profile.isDirectory() || profile.isSymbolicLink() || profile.dev !== volume.dev || (profile.mode & 0o077n) !== 0n || realpathSync(directory) !== directory) throw new Error('合成工作库真实身份无效。')
  const markerPath = path.join(directory, 'rust014-profile.json'), markerIdentity = lstatSync(markerPath, { bigint: true })
  if (!markerIdentity.isFile() || markerIdentity.isSymbolicLink() || markerIdentity.nlink !== 1n || (markerIdentity.mode & 0o077n) !== 0n || markerIdentity.size > 1024n) throw new Error('合成工作库标记无效。')
  const bytes = readFileSync(markerPath), marker: unknown = JSON.parse(bytes.toString())
  if (!exact(marker, ['schemaVersion', 'kind', 'nonce']) || marker.schemaVersion !== 1 || marker.kind !== 'rust014-synthetic-profile' || !uuid(marker.nonce)) throw new Error('合成工作库标记未准入。')
  const completedPath = path.join(directory, 'rust014-completed.json')
  let completed: CollectionReadonlyCompletedMarker | undefined, completedMarkerSha256: string | undefined
  try {
    const identity = lstatSync(completedPath, { bigint: true })
    if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1n || (identity.mode & 0o077n) !== 0n || identity.size > 1024n * 1024n) throw new Error('完成标记真实身份无效。')
    const completedBytes = readFileSync(completedPath), value: unknown = JSON.parse(completedBytes.toString())
    if (!exact(value, ['schemaVersion', 'kind', 'nonce', 'fixtureSha256', 'datasetId', 'commandIds', 'outboxIds', 'models', 'policyModelId', 'policyRevision'])
      || value.schemaVersion !== 1 || value.kind !== 'rust014-completed-profile' || value.nonce !== marker.nonce || value.fixtureSha256 !== COLLECTION_READONLY_FIXTURE_SHA256
      || !uuid(value.datasetId) || !Array.isArray(value.commandIds) || value.commandIds.length !== 27 || !value.commandIds.every(uuid) || new Set(value.commandIds).size !== 27
      || !Array.isArray(value.outboxIds) || value.outboxIds.length !== 27 || !value.outboxIds.every(uuid) || new Set(value.outboxIds).size !== 27
      || !Array.isArray(value.models) || value.models.length !== 26 || !value.models.every(isCollectionModel) || !uuid(value.policyModelId) || !Number.isSafeInteger(value.policyRevision)) throw new Error('完成标记不完整。')
    completed = value as unknown as CollectionReadonlyCompletedMarker; completedMarkerSha256 = sha(completedBytes)
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  return { directory, nonce: marker.nonce as string, profileDev: String(profile.dev), profileIno: String(profile.ino), markerSha256: sha(bytes), completedPath, completed, completedMarkerSha256 }
}
const observedCommands = new Set(['commandOutbox.context', 'commandOutbox.execute', 'collection.list', 'collection.detail', 'core.shutdown', 'recordingPrintWorker.claim'])
interface CollectionReadonlyControlReply { actionId:string|null;channel:string;args:any[];result:any }
/** 只消费真实普通IPC旁路回执，不发出任何业务请求。 */
export function collectionReadonlyRefreshSettled(options:{actionId:string|null;expectation:'node'|'rust'|'pin';snapshot:CollectionReadonlyDomSnapshot;expectedDetailId:string|null;controlReplies:readonly CollectionReadonlyControlReply[];readReplies:readonly CollectionReadonlyControlReply[]}):boolean {
  return !options.snapshot.inventoryLoading
    && options.controlReplies.some(reply=>reply.actionId===options.actionId&&reply.channel==='collection:refresh'&&reply.result.refreshed===(options.expectation==='rust'))
    && options.readReplies.some(reply=>reply.actionId===options.actionId&&reply.channel==='collection:list'&&reply.args[0]?.limit===24&&reply.result?.limit===24)
    && (options.expectedDetailId===null || options.snapshot.detail?.modelId===options.expectedDetailId
      && options.readReplies.some(reply=>reply.actionId===options.actionId&&reply.channel==='collection:detail'&&reply.args[0]===options.expectedDetailId&&reply.result?.model?.id===options.expectedDetailId))
}
export function createCollectionReadonlyMainProbe(options: { sink?: (line: string) => void } = {}) {
  readCollectionReadonlyProfile(process.env)
  const sink = options.sink ?? (line => { process.stdout.write(line) }), emit = createCollectionReadonlyEvidenceWriter('main', sink)
  const requests = new Map<string, { request: IpcRequest; started: number; actionId: string | null }>()
  const ipcRequests = new Map<string, Record<string, any>>(), submissions: { commandId: string; outboxId: string; datasetId: string; command: string; payload: any; result: any }[] = [], acknowledged = new Set<string>(), models = new Map<string, CollectionModel>()
  let actionId: string | null = null
  const controlReplies: CollectionReadonlyControlReply[] = [], readReplies: CollectionReadonlyControlReply[] = []
  let windowObserved = false
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
        if (original && ['collection:readonly-settings','collection:set-readonly-enabled','collection:refresh'].includes(original.channel)) controlReplies.push({actionId:attributedAction,channel:original.channel,args:original.args,result:structuredClone(copy.result)})
        if (original && ['collection:list','collection:detail'].includes(original.channel)) readReplies.push({actionId:attributedAction,channel:original.channel,args:original.args,result:structuredClone(copy.result)})
        if (original?.channel === 'commandOutbox:acknowledge' && copy.result?.acknowledged === true && copy.result?.id === original.args?.[0]?.id) acknowledged.add(copy.result.id)
      }
      if (event === 'main.ipcRejected') { attributedAction = ipcRequests.get(copy.invokeId)?.actionId ?? null; ipcRequests.delete(copy.invokeId) }
      emit(event, { ...copy, actionId: attributedAction })
    } catch { emit('main.observationRejected') }
  }
  return {
    emit,
    observeLifecycle(event: CoreSupervisorLifecycle | string, code?: number): void {
      if (typeof event === 'string') emit('main.lifecycle', { event, actionId: null, ...(code === undefined ? {} : { code }) })
      else emit('main.supervisorLifecycle', { ...event })
    },
    observeWindow(window: BrowserWindow): void {
      if (windowObserved) return
      windowObserved = true
      const web = window.webContents
      emit('main.window', { webContentsId: web.id, rendererPid: web.getOSProcessId(), frameUrl: web.getURL(), visible: window.isVisible(), bounds: window.getBounds() })
    },
    observeIpc<E, A extends unknown[], R>(options: {channel: string; listener(event: E, ...args: A): R; trustedSender(event: E): {webContentsId:number;rendererPid:number;frameUrl:string;trusted:true}|undefined}): (event:E,...args:A)=>R {
      return observeCollectionReadonlyIpc({ ...options, observe: observeMainEvent })
    },
    observePublicPort(port: CoreMessagePort): void {
      const post = port.postMessage.bind(port)
      port.postMessage = value => {
        try {
        const checked = validateIpcRequest(value)
        if (checked.ok && observedCommands.has(checked.value.command)) {
          const request = structuredClone(checked.value), serialized = JSON.stringify(request)
          emit('main.request', { actionId, request, requestJsonBytes: Buffer.byteLength(serialized), requestSha256: collectionReadonlyJsonSha256(request) })
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
          emit('main.response', { actionId: pending.actionId, reply: structuredClone(data), requestId: packet.id, command: pending.request.command, durationMs, replyJsonBytes: Buffer.byteLength(JSON.stringify(data)), replySha256: collectionReadonlyJsonSha256(data) })
        } else if (packet.event === 'core.ready') emit('main.coreReady')
        } catch { emit('main.observationRejected') }
      })
      emit('main.channelCreated')
    },
    observeChild(child: CoreChildProcess, entryPath: string, args: string[]): void {
      emit('main.coreFork', { entryPath, args: [...args] })
      const native = child as unknown as { pid?: number; once(event: 'spawn', listener: () => void): unknown }
      let spawnedPid: number | null = null
      native.once('spawn', () => { spawnedPid = native.pid ?? null; emit('main.coreSpawn', { pid: spawnedPid }) })
      const kill = child.kill.bind(child)
      child.kill = () => { emit('main.coreKill'); return kill() }
      const decoder = new StringDecoder('utf8'); let buffer = ''
      child.stdout?.on('data', chunk => {
        buffer += Buffer.isBuffer(chunk) ? decoder.write(chunk) : chunk.toString()
        if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) { emit('main.coreEvidenceOverflow'); buffer = ''; return }
        while (buffer.includes('\n')) {
          const index = buffer.indexOf('\n'), line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
          if (line.startsWith(COLLECTION_READONLY_EVIDENCE_PREFIX)) {
            try { const value = JSON.parse(line.slice(COLLECTION_READONLY_EVIDENCE_PREFIX.length)); if (value.actor === 'core') { const returned: unknown = sink(line + '\n'); if (returned !== undefined) void Promise.resolve(returned).catch(() => {}) } } catch { emit('main.coreEvidenceRejected') }
          }
        }
      })
      child.once('exit', code => {
        emit('main.coreExit', { code, pid: spawnedPid })
      })
    },
    async runWindowProbe(window: BrowserWindow): Promise<void> {
      if (executed) throw new Error('固定控件流程不能重复启动。')
      executed = true
      try {
        const expectation = typeof __MUSIC_BRIDGE_COLLECTION_READONLY_PROBE_EXPECTATION__ === 'undefined' ? null : __MUSIC_BRIDGE_COLLECTION_READONLY_PROBE_EXPECTATION__
        if (!['node','rust','pin'].includes(expectation ?? '')) throw new Error('工程静态原控件流程身份无效。')
        const profile = readCollectionReadonlyProfile(process.env), start = performance.now(), web = window.webContents
        emit('main.profileValidated', { profileDirectory: profile.directory, profileDev: profile.profileDev, profileIno: profile.profileIno, markerSha256: profile.markerSha256, nonce: profile.nonce })
        const imageDirectory = path.join(profile.directory, `rust014-screenshots-${randomUUID()}`)
        await mkdir(imageDirectory, { mode: 0o700 })
        let step = 0
        const bounded = async <T>(work: Promise<T>): Promise<T> => {
          let timer: NodeJS.Timeout | undefined
          try { return await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('原控件执行超过固定预算。')), Math.max(1, Math.min(30_000, 180_000 - (performance.now() - start)))) })]) }
          finally { if (timer) clearTimeout(timer) }
        }
        const snapshot = async (): Promise<CollectionReadonlyDomSnapshot> => {
          const value = await bounded(web.executeJavaScript(collectionReadonlyDomExpression('snapshot'))) as CollectionReadonlyDomSnapshot
          if (value.frameUrl !== 'musicbridge://app/index.html' || value.errorCount || value.rows.some(row => !row.label.includes('RUST014 合成型号'))) throw new Error('原控件出现未准入状态。')
          return value
        }
        const wait = async (predicate: (value: CollectionReadonlyDomSnapshot) => boolean): Promise<CollectionReadonlyDomSnapshot> => {
          const tick = performance.now(); let count = 0
          while (performance.now() - tick < 30_000 && performance.now() - start < 180_000) {
            const value = await snapshot(); count++
            if (predicate(value)) { emit('main.domSettled', { actionId, pollCount: count, elapsedMs: performance.now() - tick, snapshot: value }); return value }
            await new Promise(resolve => setTimeout(resolve, 50))
          }
          throw new Error('原控件等待超过固定预算。')
        }
        const action = async (operation: CollectionReadonlyDomOperation, predicate: (value: CollectionReadonlyDomSnapshot) => boolean, fixtureIndex?: number): Promise<CollectionReadonlyDomSnapshot> => {
          actionId = `dom-${String(++step).padStart(3, '0')}-${operation}`
          const expectedDetailId = operation === 'refresh' ? (await snapshot()).detail?.modelId ?? null : null
          emit('main.domAction', { actionId, operation: operation === 'receive-save' || operation === 'policy-save' ? 'form' : 'click', control: operation, ...(fixtureIndex === undefined ? {} : { fixtureIndex }), mechanism: 'fixed-dom', isTrusted: false })
          await bounded(web.executeJavaScript(collectionReadonlyDomExpression(operation, fixtureIndex)))
          return wait(value => predicate(value) && (operation === 'refresh'
            ? collectionReadonlyRefreshSettled({actionId,expectation:expectation as 'node'|'rust'|'pin',snapshot:value,expectedDetailId,controlReplies,readReplies})
            : operation === 'readonly-on' || operation === 'readonly-off'
              ? controlReplies.some(reply => reply.actionId === actionId && reply.channel === 'collection:set-readonly-enabled' && reply.result.enabled === (operation === 'readonly-on')) : true))
        }
        const capture = async (): Promise<void> => {
          const image = await bounded(web.capturePage()), bytes = image.toPNG(), size = image.getSize(), file = path.join(imageDirectory, `${actionId ?? 'initial'}.png`)
          await writeFile(file, bytes, { flag: 'wx', mode: 0o600 })
          emit('main.screenshot', { actionId, path: file, sha256: sha(bytes), bytes: bytes.length, width: size.width, height: size.height })
        }
        await wait(value => value.readyState === 'complete')
        if (!windowObserved) { windowObserved = true; emit('main.window', { webContentsId: web.id, rendererPid: web.getOSProcessId(), frameUrl: web.getURL(), visible: window.isVisible(), bounds: window.getBounds() }) }
        const initial = await action('navigate', value => value.total !== null && !value.inventoryLoading)
        phase = profile.completed ? 'cold' : 'fresh'; phaseEvent(phase)
        if (phase === 'fresh') {
          if (initial.total !== 0 || initial.rows.length || models.size) throw new Error('首次合成工作库不是空状态。')
          await capture()
          for (let index = 0; index < 26; index++) {
            await action('receive-open', value => value.dialog)
            await action('receive-save', value => !value.dialog && !value.inventoryLoading && value.total === index + 1 && submissions.length === index + 1 && submissions.every(entry => acknowledged.has(entry.outboxId)), index)
          }
          phaseEvent('seeded')
          await action('settings-open', value => value.readonlySettings?.enabled === false && value.readonlySettings.mode === 'node' && value.readonlySettings.state === 'off')
          if (expectation !== 'node') await action('readonly-on', value => value.readonlySettings?.enabled === true && value.readonlySettings.mode === (expectation === 'rust' ? 'rust' : 'node') && value.readonlySettings.state === (expectation === 'rust' ? 'ready' : 'failed'))
          await capture()
          await action('settings-close', value => !value.inventoryLoading && value.total === 26)
          if (expectation !== 'rust') await action('refresh', value => !value.inventoryLoading && value.total === 26)
          phaseEvent('matrix')
          for (const [operation, total] of [['filter-brand', 13], ['filter-query', 1], ['filter-decade', 9], ['filter-state', 5]] as const) {
            await action(operation, value => !value.inventoryLoading && value.total === total)
            await action('clear', value => !value.inventoryLoading && value.total === 26 && value.page === '1 / 2')
          }
          await action('next', value => !value.inventoryLoading && value.page === '2 / 2' && value.rows.length === 2); await capture()
          await action('previous', value => !value.inventoryLoading && value.page === '1 / 2' && value.rows.length === 24)
          await action('next', value => !value.inventoryLoading && value.page === '2 / 2' && value.rows.some(row => row.label.includes(COLLECTION_READONLY_FIXTURE[0]!.model.name)))
          await action('detail-open', value => value.detail?.modelId === submissions[0]?.result.modelId, 0)
          phaseEvent('policy'); await action('policy-open', value => !!value.detail && value.detail.policy === 'normal')
          phaseEvent('stale')
          await action('policy-save', value => value.detail?.policy === 'collector' && value.detail.reserve === '2' && submissions.length === 27 && submissions.every(entry => acknowledged.has(entry.outboxId)) && models.get(value.detail.modelId)?.collectorPolicy === 'collector')
          await capture(); await action('refresh', value => !value.inventoryLoading && !!value.detail); phaseEvent('refreshed')
          await action('detail-close', value => value.total === 26 && !value.detail)
          // 原筛选submit重新查询；不会调用旧错误态“刷新库存”或业务API。
          await action('filter-brand', value => !value.inventoryLoading && value.total === 13)
          await action('clear', value => !value.inventoryLoading && value.total === 26)
          await action('next', value => !value.inventoryLoading && value.page === '2 / 2' && value.rows.length === 2)
          await action('previous', value => !value.inventoryLoading && value.page === '1 / 2' && value.rows.length === 24)
          if (expectation !== 'node') {
            phaseEvent('off-on')
            await action('settings-open', value => value.readonlySettings?.enabled === true)
            await action('readonly-off', value => value.readonlySettings?.enabled === false && value.readonlySettings.mode === 'node' && value.readonlySettings.state === 'off')
            await capture()
            await action('readonly-on', value => value.readonlySettings?.enabled === true && value.readonlySettings.mode === (expectation === 'rust' ? 'rust' : 'node') && value.readonlySettings.state === (expectation === 'rust' ? 'ready' : 'failed'))
            await capture()
            await action('settings-close', value => !value.inventoryLoading && value.total === 26 && value.page === '1 / 2')
          }
        } else {
          if (initial.total !== 26 || submissions.length || domainWrites) throw new Error('冷启动合成库不完整或出现业务写入。')
          await action('settings-open', value => value.readonlySettings?.enabled === (expectation === 'rust') && value.readonlySettings.mode === (expectation === 'rust' ? 'rust' : 'node') && value.readonlySettings.state === (expectation === 'rust' ? 'ready' : 'off'))
          await capture()
          await action('settings-close', value => !value.inventoryLoading && value.total === 26 && value.page === '1 / 2')
          await action('next', value => !value.inventoryLoading && value.page === '2 / 2' && value.rows.length === 2)
          await action('previous', value => !value.inventoryLoading && value.page === '1 / 2' && value.rows.length === 24)
        }
        await action('next', value => !value.inventoryLoading && value.page === '2 / 2' && value.rows.some(row => row.label.includes(COLLECTION_READONLY_FIXTURE[0]!.model.name)))
        const finalDetail = await action('detail-open', value => value.detail?.policy === 'collector' && value.detail.reserve === '2' && value.detail.total === 1 && value.detail.openedBlank === 1, 0)
        await capture()
        const actualModels = [...models.values()].sort((left, right) => left.name.localeCompare(right.name, 'en'))
        if (actualModels.length !== 26) throw new Error('实际型号集合不完整。')
        for (let index = 0; index < 26; index++) {
          const actual = actualModels[index]!, fixture = COLLECTION_READONLY_FIXTURE[index]!
          if (!Object.entries(fixture.model).every(([key, value]) => isDeepStrictEqual(actual[key as keyof CollectionModel], value)) || actual.counts.total !== 1 || actual.counts.openedBlank !== 1 || actual.lengths.length !== 1 || actual.lengths[0] !== 60 || actual.minimumSealedReserve !== (index === 0 ? 2 : 0) || actual.collectorPolicy !== (index === 0 ? 'collector' : 'normal')) throw new Error('实际型号或保护结果不符合固定fixture。')
        }
        const policyModelId = finalDetail.detail!.modelId, policyRevision = models.get(policyModelId)!.revision
        let marker: CollectionReadonlyCompletedMarker, completedMarkerSha256: string
        if (phase === 'fresh') {
          if (domainWrites !== 27 || submissions.length !== 27 || new Set(submissions.map(entry => entry.commandId)).size !== 27 || acknowledged.size !== 27 || submissions.slice(0, 26).some((entry, index) => entry.command !== 'collection.receive' || !isDeepStrictEqual({ model: entry.payload.model, lengthMinutes: entry.payload.lengthMinutes, quantities: entry.payload.quantities }, COLLECTION_READONLY_FIXTURE[index])) || submissions[26]?.command !== 'collection.setPolicy' || submissions[26].payload.modelId !== policyModelId || submissions[26].payload.collectorPolicy !== 'collector' || submissions[26].payload.minimumSealedReserve !== 2) throw new Error('原持久outbox回执不完整。')
          marker = { schemaVersion: 1, kind: 'rust014-completed-profile', nonce: profile.nonce, fixtureSha256: COLLECTION_READONLY_FIXTURE_SHA256, datasetId: submissions[0]!.datasetId, commandIds: submissions.map(entry => entry.commandId), outboxIds: submissions.map(entry => entry.outboxId), models: actualModels, policyModelId, policyRevision }
          const bytes = Buffer.from(JSON.stringify(marker, null, 2) + '\n'); await writeFile(profile.completedPath, bytes, { flag: 'wx', mode: 0o600 }); completedMarkerSha256 = sha(bytes)
        } else {
          marker = profile.completed!
          if (submissions.length || domainWrites || !isDeepStrictEqual(actualModels, marker.models) || marker.policyModelId !== policyModelId || marker.policyRevision !== policyRevision) throw new Error('冷启实际DTO与完成标记不一致。')
          completedMarkerSha256 = profile.completedMarkerSha256!
        }
        emit('main.rendererProbeComplete', { phase, fixtureCount: 26, fixtureSha256: COLLECTION_READONLY_FIXTURE_SHA256, commandIds: marker.commandIds, modelIds: actualModels.map(model => model.id), policyModelId, policyRevision, nonce: profile.nonce, completedMarkerSha256 })
      } catch (error) { emit('main.probeFailed', { code: 'PROBE_FAILED' }); throw error }
      finally { actionId = null }
    },
  }
}

export interface CollectionReadonlyIpcSender {
  webContentsId: number
  rendererPid: number
  frameUrl: string
  trusted: true
}
const channels = new Set(['collection:readonly-settings','collection:set-readonly-enabled','collection:refresh','collection:list', 'collection:detail', 'commandOutbox:context', 'commandOutbox:overview',
  'commandOutbox:submit', 'commandOutbox:revokePreparedBatch', 'commandOutbox:retry', 'commandOutbox:dismiss', 'commandOutbox:acknowledge'])
const publicCodes = new Set(['NOT_READY', 'INVALID_IPC_REQUEST', 'INVALID_IPC_RESPONSE', 'INTERNAL_ERROR', 'INVENTORY_CONFLICT',
  'BACKUP_CONFLICT', 'OUTBOX_CONFLICT', 'OUTBOX_UNAVAILABLE', 'OUTBOX_SCOPE_MISMATCH', 'OUTBOX_LIMIT_EXCEEDED', 'OUTBOX_RESULT_UNKNOWN'])
let invocationSequence = 0
function publicCode(error: unknown): string {
  try {
    if (error instanceof Error) {
      const code = /\[([A-Z_]+)\]/u.exec(error.message)?.[1]
      if (code && publicCodes.has(code)) return code
    }
  } catch { /* 观察失败不借错误对象扩展业务行为。 */ }
  return 'INTERNAL_ERROR'
}
export function observeCollectionReadonlyIpc<E, A extends unknown[], R>(options: {
  channel: string
  listener(event: E, ...args: A): R
  trustedSender(event: E): CollectionReadonlyIpcSender | undefined
  observe(event: string, data: Record<string, unknown>): unknown
}): (event: E, ...args: A) => R {
  if (!channels.has(options.channel)) return options.listener
  function observe(event: string, data: Record<string, unknown>): void {
    try {
      const returned = options.observe(event, structuredClone(data))
      if (returned !== undefined) void Promise.resolve(returned).catch(() => {})
    } catch { /* 严格 Gate 拒绝缺失观察；原 listener 与回执保持。 */ }
  }
  return (event, ...args) => {
    let sender: CollectionReadonlyIpcSender | undefined
    try { sender = options.trustedSender(event) } catch { /* 原 listener 仍自行验证并返回原拒绝。 */ }
    if (!sender) return options.listener(event, ...args)
    const invokeId = `ipc-${++invocationSequence}`, channel = options.channel
    observe('main.ipcRequest', { invokeId, channel, args, sender })
    let result: R
    try { result = options.listener(event, ...args) }
    catch (error) { observe('main.ipcRejected', { invokeId, channel, code: publicCode(error) }); throw error }
    // 原 Promise 身份与完成时刻不变，只登记消费后的独立旁路。
    if (types.isPromise(result)) {
      try {
        void result.then(value => { observe('main.ipcReply', { invokeId, channel, result: value }) },
          error => { observe('main.ipcRejected', { invokeId, channel, code: publicCode(error) }) }).catch(() => {})
      } catch { /* 非标准 Promise 的观察异常不能改变原返回。 */ }
    } else observe('main.ipcReply', { invokeId, channel, result })
    return result
  }
}
