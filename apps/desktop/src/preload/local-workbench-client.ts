import * as dto from '@music-bridge/contracts'
import type { DatasetScope } from './command-outbox-client.js'

const invalid = (): never => { throw new Error('[INVALID_IPC_REQUEST] 整理请求或原结果身份无效，请重新读取。') }
const changed = (): never => { throw new Error('[DATASET_CHANGED] 工作库已改变；请重新加载，已派发操作只核对原回执。') }

export interface LocalWorkbenchLyricsPublicApi {
  localLibraryLyrics<C extends dto.LocalLyricsCommand>(command: C, payload: dto.LocalLyricsCommandPayloads[C]): Promise<dto.LocalLyricsCommandResults[C]>
}
const ownResult = (value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value)
  return required.every(key => descriptors[key] !== undefined) && keys.every(key => typeof key === 'string' && [...required, ...optional].includes(key) && descriptors[key]?.enumerable === true && 'value' in descriptors[key]!)
}
const arrayResult = (value: unknown, max: number): value is unknown[] => Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype
  && value.length <= max && Reflect.ownKeys(value).length === value.length + 1
  && Array.from({ length: value.length }, (_, i) => Object.getOwnPropertyDescriptor(value, String(i))).every(d => d?.enumerable === true && 'value' in d)
const idsResult = (value: unknown): value is string[] => arrayResult(value, 10000) && value.every(dto.isLocalLyricsId) && new Set(value).size === value.length
const naturalResult = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
const stateResult = (value: unknown, allowed: readonly string[]): boolean => typeof value === 'string' && allowed.includes(value)
function publicDataResult(value: unknown, ancestors = new Set<object>(), depth = 0): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || depth > 16 || ancestors.has(value)) return false
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value)
  if (prototype !== (array ? Array.prototype : Object.prototype) && (array || prototype !== null)) return false
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value)
  if (keys.some(key => typeof key !== 'string' || !('value' in descriptors[key]!) || key !== 'length' && descriptors[key]?.enumerable !== true)) return false
  ancestors.add(value)
  try { return keys.every(key => array && key === 'length' || publicDataResult(descriptors[key as string]!.value, ancestors, depth + 1)) }
  finally { ancestors.delete(value) }
}
const equalScope = (a: dto.LocalLyricsScope, b: dto.LocalLyricsScope) => a.datasetId === b.datasetId && a.libraryId === b.libraryId && a.albumId === b.albumId && a.captureId === b.captureId
const equalLibrary = (a: dto.LocalLyricsLibraryRequest, b: dto.LocalLyricsLibraryRequest) => a.datasetId === b.datasetId && a.libraryId === b.libraryId && a.captureId === b.captureId
function lyricsReceiptResult(value: unknown): value is dto.LocalLyricsSaveReceipt {
  if (!ownResult(value, ['commandId', 'sessionId', 'state', 'cover', 'tracks', 'snapshot']) || !dto.isLocalLyricsId(value.commandId) || !dto.isLocalLyricsId(value.sessionId)
    || !stateResult(value.state, ['running','complete','partial','unknown','cancelled','failed']) || !stateResult(value.snapshot, ['not-requested','pending','saved','failed']) || !arrayResult(value.tracks,10000)) return false
  const states = ['not-requested','pending','saved','existing','failed','unknown','cancelled']
  return stateResult(value.cover, states) && value.tracks.every(row => ownResult(row,['trackId','lrc','embed']) && dto.isLocalLyricsId(row.trackId) && stateResult(row.lrc,states) && stateResult(row.embed,states))
    && new Set(value.tracks.map(row => (row as dto.LocalLyricsTrackReceipt).trackId)).size === value.tracks.length
}
function lyricsSessionResult(value: unknown): value is dto.LocalLyricsSession {
  if (!ownResult(value,['sessionId','scope','state','tracks','candidates'],['pendingOperations']) || !dto.isLocalLyricsId(value.sessionId) || !dto.isLocalLyricsScope(value.scope)
    || !stateResult(value.state,['querying','ready','cancelled','stale']) || !arrayResult(value.tracks,10000) || !arrayResult(value.candidates,dto.LOCAL_LYRICS_LIMITS.sessionBodyBytes)) return false
  if (!value.candidates.every(candidate => dto.isLocalLyricsCandidateDetail({candidate,body:'核验候选'}))) return false
  const candidates = value.candidates as unknown as dto.LocalLyricsCandidate[]
  if (new Set(candidates.map(row => row.candidateId)).size !== candidates.length || !value.tracks.every(track => {
    if (!ownResult(track,['trackId','title','presence','match','candidateIds','selectedCandidateId','sources']) || !dto.isLocalLyricsId(track.trackId) || !dto.isLocalLyricsSafeText(track.title,2048)
      || !stateResult(track.presence,['unknown','false','true']) || !stateResult(track.match,['existing','whole-track','recommended','review','not-found','failed','unknown']) || !idsResult(track.candidateIds)
      || track.selectedCandidateId !== null && (!dto.isLocalLyricsId(track.selectedCandidateId) || !track.candidateIds.includes(track.selectedCandidateId)) || !arrayResult(track.sources,5)) return false
    return track.candidateIds.every(id => candidates.some(row => row.candidateId === id && row.trackId === track.trackId))
      && track.sources.every(source => ownResult(source,['source','state']) && dto.LOCAL_LYRICS_SOURCES.includes(source.source as dto.LocalLyricsSource) && stateResult(source.state,['ok','failed','unavailable','budget','cancelled']))
      && new Set(track.sources.map(source => (source as dto.LocalLyricsSourceResult).source)).size === track.sources.length
  })) return false
  const tracks = value.tracks as unknown as dto.LocalLyricsTrackView[]
  if (new Set(tracks.map(row => row.trackId)).size !== tracks.length || candidates.some(row => !tracks.some(track => track.trackId === row.trackId))) return false
  if (Object.hasOwn(value,'pendingOperations') && (!arrayResult(value.pendingOperations,10000) || !value.pendingOperations.every(row => ownResult(row,['request','receipt'])
    && dto.isLocalLyricsCommandPayload('localLyrics.save',row.request) && lyricsReceiptResult(row.receipt)
    && row.receipt.commandId === (row.request as dto.LocalLyricsSaveRequest).commandId && row.receipt.sessionId === (row.request as dto.LocalLyricsSaveRequest).sessionId)
    || new Set((value.pendingOperations as { request: dto.LocalLyricsSaveRequest }[]).map(row=>row.request.commandId)).size !== (value.pendingOperations as unknown[]).length)) return false
  return true
}
function lyricsJobResult(value: unknown, datasetId: string): value is dto.LocalLyricsJobSnapshot {
  if (!ownResult(value,['jobId','library','state','totalAlbums','processedAlbums','savedAlbums','reviewAlbumIds','failedAlbumIds','unknownAlbumIds','sidecars','embedded','inspectionFailures','revision'],['originalEntry'])
    || !dto.isLocalLyricsId(value.jobId) || !dto.isLocalLyricsLibraryRequest(value.library) || value.library.datasetId !== datasetId
    || !stateResult(value.state,['queued','running','stopped','complete','partial','unknown','failed'])
    || !['totalAlbums','processedAlbums','savedAlbums','sidecars','embedded','inspectionFailures','revision'].every(key=>naturalResult(value[key]))
    || Number(value.processedAlbums)>Number(value.totalAlbums) || Number(value.savedAlbums)>Number(value.processedAlbums)
    || !idsResult(value.reviewAlbumIds) || !idsResult(value.failedAlbumIds) || !idsResult(value.unknownAlbumIds)) return false
  const ids = [...value.reviewAlbumIds,...value.failedAlbumIds,...value.unknownAlbumIds]
  return new Set(ids).size === ids.length && ids.length <= Number(value.totalAlbums)
    && (!Object.hasOwn(value,'originalEntry') || value.originalEntry === null
      || dto.isLocalLyricsJobOriginalEntry(value.originalEntry) && value.originalEntry.scope.datasetId === datasetId && value.originalEntry.scope.libraryId === value.library.libraryId)
}
/** public只消费闭集结果；不从候选正文或源URL构造路径/许可。 */
export function isLocalWorkbenchLyricsResult<C extends dto.LocalLyricsCommand>(command: C, value: unknown, payload: dto.LocalLyricsCommandPayloads[C], datasetId: string): value is dto.LocalLyricsCommandResults[C] {
  try {
    if (!dto.isLocalLyricsCommandPayload(command,payload) || !publicDataResult(value) || new TextEncoder().encode(JSON.stringify(value)).byteLength > dto.LOCAL_LYRICS_LIMITS.sessionBodyBytes) return false
    if (command === 'localLyrics.detail') return dto.isLocalLyricsCandidateDetail(value) && value.candidate.candidateId === (payload as dto.LocalLyricsDetailRequest).candidateId
    if (command === 'localLyrics.query') return lyricsSessionResult(value) && equalScope(value.scope,(payload as dto.LocalLyricsQueryRequest).scope) && value.scope.datasetId === datasetId
    if (['localLyrics.session.read','localLyrics.select','localLyrics.cancel'].includes(command) || command === 'localLyrics.discard' && !('commandId' in payload)) {
      if (!lyricsSessionResult(value) || value.scope.datasetId !== datasetId || value.sessionId !== (payload as dto.LocalLyricsSessionRequest).sessionId) return false
      if (command === 'localLyrics.select') { const p=payload as dto.LocalLyricsSelectionRequest; return value.tracks.some(row=>row.trackId===p.trackId && row.selectedCandidateId===p.candidateId) }
      return true
    }
    if (['localLyrics.save','localLyrics.receipt','localLyrics.save.retry','localLyrics.snapshot.retry','localLyrics.discard'].includes(command)) {
      if (value === null) return command === 'localLyrics.receipt'
      const p=payload as dto.LocalLyricsReceiptRequest
      return lyricsReceiptResult(value) && value.sessionId===p.sessionId && value.commandId===p.commandId
    }
    if (command === 'localLyrics.inventory') {
      const p=payload as dto.LocalLyricsInventoryRequest
      return ownResult(value,['total','offset','rows','watermark']) && naturalResult(value.total) && value.offset===p.offset && dto.isLocalLyricsSafeText(value.watermark,2048) && (value.watermark as string).length>0
        && arrayResult(value.rows,p.limit) && value.rows.every(row=>ownResult(row,['albumId','presence']) && dto.isLocalLyricsId(row.albumId) && stateResult(row.presence,['unknown','false','true']))
        && new Set(value.rows.map(row=>(row as dto.LocalLyricsInventoryRow).albumId)).size===value.rows.length && value.rows.length===Math.min(p.limit,Math.max(0,Number(value.total)-p.offset)) && (p.filter!=='missingLyrics' || value.rows.every(row=>(row as dto.LocalLyricsInventoryRow).presence==='false'))
    }
    if (value === null) return command === 'localLyrics.job.read'
    if (!lyricsJobResult(value,datasetId)) return false
    if (command === 'localLyrics.job.read') {
      const p = payload as dto.LocalLyricsJobReadRequest
      return value.jobId === p.jobId && (Object.hasOwn(p,'albumId')
        ? Object.hasOwn(value,'originalEntry') && (value.originalEntry === null || value.originalEntry !== undefined && value.originalEntry.scope.albumId === p.albumId)
        : !Object.hasOwn(value,'originalEntry'))
    }
    if (Object.hasOwn(value,'originalEntry')) return false
    if (command === 'localLyrics.job.start') { const p=payload as dto.LocalLyricsJobStartRequest;return value.jobId===p.commandId && equalLibrary(value.library,p.library) }
    return value.jobId === (payload as dto.LocalLyricsJobRequest).jobId
  } catch { return false }
}

/** 固定渠道、闭集输入和工作库围栏；AbortSignal 不跨 contextBridge。 */
export function createLocalWorkbenchClient(invoke: (channel: string, value: unknown) => Promise<unknown>, scope: DatasetScope): dto.LocalWorkbenchPublicApi & LocalWorkbenchLyricsPublicApi {
  async function datasetFor<C extends dto.LocalWorkbenchCommand>(command: C, payload: dto.LocalWorkbenchCommandPayloads[C]): Promise<string> {
    if (!dto.isLocalWorkbenchCommandPayload(command, payload)) return invalid()
    const datasetId = await scope()
    if (!dto.isCommandOutboxDatasetId(datasetId)) return invalid()
    if ('datasetId' in payload && payload.datasetId !== datasetId) return changed()
    if (command === 'localWorkbench.plan.cancel' && (payload as dto.LocalWorkbenchCancelRequest).original.datasetId !== datasetId) return changed()
    return datasetId
  }
  async function request<C extends dto.LocalWorkbenchCommand>(command: C, payload: dto.LocalWorkbenchCommandPayloads[C]): Promise<dto.LocalWorkbenchCommandResults[C]> {
    // 在等待 context 前确认描述符并复制，不能让等待期间的表单变动改写意图。
    if (!dto.isLocalWorkbenchCommandPayload(command, payload)) return invalid()
    const copied = structuredClone(payload), datasetId = await datasetFor(command, copied)
    const result = await invoke('localWorkbench:request', { datasetId, command, payload: copied })
    if (await scope() !== datasetId) return changed()
    if (!publicDataResult(result) || !dto.isLocalWorkbenchCommandResult(command, result, copied)
      || command === 'localWorkbench.read' && (result as dto.LocalWorkbenchReadback).datasetId !== datasetId) return invalid()
    return result as dto.LocalWorkbenchCommandResults[C]
  }
  async function read<C extends dto.LocalWorkbenchReadCommand>(envelope: dto.LocalWorkbenchReadRequestEnvelope<C>): Promise<dto.LocalWorkbenchCommandResults[C]> {
    if (!dto.isLocalWorkbenchReadRequestEnvelope(envelope)) return invalid()
    const copied = structuredClone(envelope), datasetId = await datasetFor(copied.command, copied.payload)
    const result = await invoke('localWorkbench:read', { datasetId, request: copied })
    if (await scope() !== datasetId) return changed()
    if (!publicDataResult(result) || !dto.isLocalWorkbenchReadResult<C>(result, copied)
      || copied.command === 'localWorkbench.read' && (!dto.isLocalWorkbenchReadback(result) || result.datasetId !== datasetId)) return invalid()
    return result
  }
  async function management<C extends dto.LocalLibraryManagementMainCommand>(command: C, payload: dto.LocalLibraryManagementMainPayloads[C]): Promise<dto.LocalLibraryManagementMainResults[C]> {
    if (!dto.isLocalLibraryManagementMainCommand(command) || !dto.isLocalLibraryManagementMainPayload(command,payload)) return invalid()
    const copied=structuredClone(payload), datasetId=await scope()
    if (!dto.isCommandOutboxDatasetId(datasetId)) return invalid()
    const value=await invoke('localWorkbench:management',{datasetId,command,payload:copied})
    if (await scope()!==datasetId) return changed()
    if (!publicDataResult(value) || !dto.isLocalLibraryManagementMainResult(command,value,copied) || value && typeof value==='object' && 'datasetId' in value && value.datasetId!==datasetId
      || value && typeof value==='object' && 'originalEntry' in value && value.originalEntry!==null
        && (!dto.isLocalLibraryJobOriginalEntry(value.originalEntry) || value.originalEntry.datasetId!==datasetId)) return invalid()
    return value
  }
  async function nameSettings<C extends dto.LocalNameSettingsCommand>(command:C,payload:dto.LocalNameSettingsPayloads[C]):Promise<dto.LocalNameSettingsResults[C]> {
    if (!dto.isLocalNameSettingsCommand(command) || !dto.isLocalNameSettingsPayload(command,payload)) return invalid()
    const copied=structuredClone(payload),datasetId=await scope()
    if (!dto.isCommandOutboxDatasetId(datasetId)) return invalid()
    const value=await invoke('localWorkbench:nameSettings',{datasetId,command,payload:copied})
    if(await scope()!==datasetId)return changed()
    if(!publicDataResult(value)||!dto.isLocalNameSettingsResult(command,value,copied))return invalid()
    return value
  }
  async function lyrics<C extends dto.LocalLyricsCommand>(command:C,payload:dto.LocalLyricsCommandPayloads[C]):Promise<dto.LocalLyricsCommandResults[C]> {
    if(!(dto.LOCAL_LYRICS_COMMANDS as readonly unknown[]).includes(command)||!dto.isLocalLyricsCommandPayload(command,payload))return invalid()
    const copied=structuredClone(payload),datasetId=await scope()
    if(!dto.isCommandOutboxDatasetId(datasetId))return invalid()
    if('scope' in copied && copied.scope.datasetId!==datasetId || 'library' in copied && copied.library.datasetId!==datasetId)return changed()
    const value=await invoke('localWorkbench:lyrics',{datasetId,command,payload:copied})
    if(await scope()!==datasetId)return changed()
    if(!isLocalWorkbenchLyricsResult(command,value,copied,datasetId))return invalid()
    return value
  }
  return {
    localLibraryManagement: management,
    localNameSettings: nameSettings,
    localLibraryLyrics: lyrics,
    requestLocalWorkbenchRead: read,
    async cancelLocalWorkbenchRead(value) {
      if (!dto.isLocalWorkbenchCancelReadRequest(value)) return invalid()
      const request = structuredClone(value), datasetId = await scope()
      if (!dto.isCommandOutboxDatasetId(datasetId)) return invalid()
      const result = await invoke('localWorkbench:cancelRead', { datasetId, request })
      if (await scope() !== datasetId) return changed()
      if (!dto.isLocalWorkbenchCancelReadReply(result)) return invalid()
      return result
    },
    localWorkbenchCapabilities: () => request('localWorkbench.capabilities', {}),
    readLocalWorkbenchAlbums: payload => request('localWorkbench.read', payload),
    findLocalWorkbenchArtwork: payload => request('localWorkbench.artwork.local', payload),
    searchLocalWorkbenchArtwork: payload => request('localWorkbench.artwork.search', payload),
    chooseLocalWorkbenchArtwork: payload => request('localWorkbench.artwork.file', payload),
    importLocalWorkbenchArtwork: payload => request('localWorkbench.artwork.import', payload),
    previewLocalWorkbenchArtwork: payload => request('localWorkbench.artwork.preview', payload),
    suggestLocalWorkbenchNames: payload => request('localWorkbench.ai.suggest', payload),
    previewLocalWorkbenchNames: payload => request('localWorkbench.ai.preview', payload),
    chooseLocalWorkbenchCueTarget: () => request('localWorkbench.cue.target', {}),
    previewLocalWorkbenchCue: payload => request('localWorkbench.cue.preview', payload),
    applyLocalWorkbenchPlan: payload => request('localWorkbench.plan.apply', payload),
    readLocalWorkbenchReceipt: payload => request('localWorkbench.plan.receipt', payload),
    cancelLocalWorkbenchPlan: payload => request('localWorkbench.plan.cancel', payload),
    openLocalWorkbenchExisting: payload => request('localWorkbench.existing.open', payload),
  }
}

export type TrustedDirectoryDropEvent = { phase: 'start'; id: number }
  | { phase: 'finish'; id: number; choice: dto.LocalLibraryImportChoice | null }
  | { phase: 'error'; id: number; message: string }
export interface TrustedDirectoryDropOptions {
  document: Document
  scope: DatasetScope
  /** 只由真实isolated preload装配Electron webUtils；不经contextBridge暴露。 */
  getPathForFile(file: File): string
  invoke(channel: string, value: unknown): Promise<unknown>
  /** start须同步返回true；订阅者负责原generation/dataset/UI门，不能以void返回视为接受。 */
  deliver(event: TrustedDirectoryDropEvent): boolean | void
}
/** 只有实际用户drop可进入；返回对象不提供path/drop调用口或Source许可。 */
export function installTrustedDirectoryDrop(options: TrustedDirectoryDropOptions) {
  const doc = options.document, nullableView = doc.defaultView
  if (!nullableView || typeof nullableView.DragEvent !== 'function' || typeof nullableView.File !== 'function' || typeof nullableView.Element !== 'function') return invalid()
  const view = nullableView
  const selector = 'aside[data-musicbridge-native-directory-drop][data-musicbridge-native-directory-available="true"]', pending = new Set<Promise<void>>()
  let disposed = false, sequence = 0
  const deliver = (event: TrustedDirectoryDropEvent): boolean => { if (!disposed) try { return options.deliver(event) === true } catch { /* 订阅者不能改变Main的原任务。 */ } return false }
  const report = (id: number, message: string) => { deliver({ phase: 'error', id, message }) }
  const target = (event: DragEvent): Element | null => event.target instanceof view.Element ? event.target.closest(selector) : null
  const original = (event: Event): event is DragEvent => !disposed && event instanceof view.DragEvent && event.isTrusted === true
    && !!target(event) && doc.contains(target(event))
  function dragover(event: DragEvent): void {
    if (original(event) && event.dataTransfer && Array.from(event.dataTransfer.types).includes('Files')) {
      event.preventDefault(); event.dataTransfer.dropEffect = 'copy'
    }
  }
  function drop(event: DragEvent): void {
    if (!original(event)) return
    event.preventDefault(); event.stopPropagation()
    if (!Number.isSafeInteger(sequence + 1)) return
    const id = ++sequence
    if (pending.size) { report(id, '[NOT_READY] 原拖入目录尚未收口。'); return }
    let nativePath: string
    try {
      const transfer = event.dataTransfer
      if (!transfer || transfer.files.length !== 1 || transfer.items.length !== 1 || transfer.items[0]?.kind !== 'file') return invalid()
      const file = transfer.files[0]
      if (!(file instanceof view.File) || !(transfer.items[0].getAsFile() instanceof view.File)) return invalid()
      // 必须在drop原同步上下文读取File；不接Renderer字符串或File.path。
      nativePath = options.getPathForFile(file)
      if (typeof nativePath !== 'string' || !nativePath.startsWith('/') || nativePath.length > 64 * 1024 || nativePath.includes('\0')) return invalid()
    } catch { report(id, '[INVALID_IPC_REQUEST] 请拖入一个真实本地目录。'); return }
    if (!deliver({ phase: 'start', id })) return
    const work = (async () => {
      const datasetId = await options.scope()
      if (disposed) return
      if (!dto.isCommandOutboxDatasetId(datasetId)) return invalid()
      const choice = await options.invoke('localWorkbench:directoryDrop', { datasetId, path: nativePath })
      if (disposed) return
      if (await options.scope() !== datasetId) return changed()
      if (disposed) return
      if (!publicDataResult(choice) || !dto.isLocalLibraryManagementResult('library.import.prepare', choice, {})) return invalid()
      deliver({ phase: 'finish', id, choice: structuredClone(choice) as dto.LocalLibraryImportChoice | null })
    })().catch(() => { report(id, '[NOT_READY] 原拖入目录未确认，请重新读取当前工作库。') })
    pending.add(work); void work.then(() => pending.delete(work), () => pending.delete(work))
  }
  doc.addEventListener('dragover', dragover, true); doc.addEventListener('drop', drop, true)
  return {
    dispose(): void { if (disposed) return; disposed = true; doc.removeEventListener('dragover', dragover, true); doc.removeEventListener('drop', drop, true) },
    /** 只等已投递原请求settle；dispose不宣称Main FD或Owner已关闭。 */
    async join(): Promise<void> { await Promise.allSettled([...pending]) },
    pending(): number { return pending.size },
  }
}
