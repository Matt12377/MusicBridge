import { computed, shallowRef, ref, toRaw, watch } from 'vue'
import { isLocalLyricsCandidateDetail, isLocalLyricsCommandPayload, isLocalLyricsScope, isLocalLyricsId, isLocalLyricsLibraryRequest } from '@music-bridge/contracts'
import type {
  LocalLyricsCommand, LocalLyricsCommandPayloads, LocalLyricsCommandResults, LocalLyricsScope,
  LocalLyricsSession, LocalLyricsCandidateDetail, LocalLyricsSaveRequest, LocalLyricsSaveReceipt,
  LocalLyricsLibraryRequest, LocalLyricsJobStartRequest, LocalLyricsJobSnapshot, LocalLyricsInventoryPage,
} from '@music-bridge/contracts'
import { localWorkbenchLyricsResultKeyMatches, sameLocalWorkbenchLyricsResultKey } from './types.js'
import type { LocalWorkbenchLyricsResultKey, LocalWorkbenchLyricsOriginalEntry, LocalWorkbenchLyricsResultInspection, LocalWorkbenchLyricsInspectionOperation, LocalWorkbenchLyricsResultContext, LocalWorkbenchInspectionReadPhase } from './types.js'

export interface LocalLyricsRendererApi {
  localLibraryLyrics<C extends LocalLyricsCommand>(command: C, payload: LocalLyricsCommandPayloads[C]): Promise<LocalLyricsCommandResults[C]>
}
const copy = <T>(v: T): T => structuredClone(toRaw(v))
const sameScope = (a: LocalLyricsScope, b: LocalLyricsScope) => a.datasetId === b.datasetId && a.libraryId === b.libraryId && a.albumId === b.albumId && a.captureId === b.captureId
const sameLibrary = (a: LocalLyricsLibraryRequest, b: LocalLyricsLibraryRequest) => a.datasetId === b.datasetId && a.libraryId === b.libraryId && a.captureId === b.captureId
interface OriginalLyricsSave { request: LocalLyricsSaveRequest; receipt: LocalLyricsSaveReceipt; discarded?: true }
interface FinishedLyricsJob { request: LocalLyricsJobStartRequest; snapshot: LocalLyricsJobSnapshot; latestSnapshot?: LocalLyricsJobSnapshot }
const unconfirmed = (value: LocalLyricsSaveReceipt) => ['running', 'unknown'].includes(value.state)
  || ['pending', 'unknown'].includes(value.cover) || value.snapshot === 'pending'
  || value.tracks.some(row => ['pending', 'unknown'].includes(row.lrc) || ['pending', 'unknown'].includes(row.embed))
const saved = (value: LocalLyricsSaveReceipt) => value.state === 'complete' && value.snapshot !== 'failed' && !unconfirmed(value)
  && !['failed', 'cancelled'].includes(value.cover) && value.tracks.every(row => !['failed', 'cancelled'].includes(row.lrc) && !['failed', 'cancelled'].includes(row.embed))

/** 选择是零写；保存意图保留原body。全库任务不接收页面、搜索或筛选参数。 */
export function useLocalWorkbenchLyrics(options: {
  api: LocalLyricsRendererApi; makeCommandId?: () => string; pollMs?: number
  /** App只投影Owner已经核对的原entry；未接入时不创建新公开命令。 */
  readOriginalResultEntry?(key: LocalWorkbenchLyricsResultKey, context: LocalWorkbenchLyricsResultContext): Promise<LocalWorkbenchLyricsOriginalEntry | null>
}) {
  const scope = shallowRef<LocalLyricsScope | null>(null), library = shallowRef<LocalLyricsLibraryRequest | null>(null)
  const availableLibraries = shallowRef<readonly LocalLyricsLibraryRequest[]>([])
  const session = shallowRef<LocalLyricsSession | null>(null), detail = shallowRef<LocalLyricsCandidateDetail | null>(null)
  const receipt = shallowRef<LocalLyricsSaveReceipt | null>(null), originalSave = shallowRef<LocalLyricsSaveRequest | null>(null)
  const saveOperations = shallowRef<readonly OriginalLyricsSave[]>([])
  const job = shallowRef<LocalLyricsJobSnapshot | null>(null), originalJob = shallowRef<LocalLyricsJobStartRequest | null>(null)
  const jobHistory = shallowRef<readonly FinishedLyricsJob[]>([])
  const confirmedJobStop = shallowRef<LocalLyricsJobSnapshot | null>(null)
  const inventory = shallowRef<LocalLyricsInventoryPage | null>(null)
  const resultInspection = shallowRef<LocalWorkbenchLyricsResultInspection | null>(null)
  const busy = ref(false), writing = ref(false), batchBusy = ref(false), jobUnknown = ref(false), batchDiscarded = ref(false), embed = ref(true)
  const error = ref(''), notice = ref(''), inventoryFilter = ref<'all' | 'missingLyrics'>('all'), inventoryOffset = ref(0)
  let generation = 0, detailGeneration = 0, inventoryGeneration = 0, inventorySelectionGeneration = 0, disposed = false, timer: ReturnType<typeof setTimeout> | undefined
  let resultGeneration = 0, resultDetailGeneration = 0, resultController: AbortController | undefined
  const resultReceiptTurns = new Map<string, number>()
  const id = options.makeCommandId ?? (() => crypto.randomUUID())
  const selectedCount = computed(() => session.value?.tracks.filter(v => v.selectedCandidateId !== null).length ?? 0)
  const locked = computed(() => writing.value || jobUnknown.value || batchBusy.value
    || saveOperations.value.some(value => !value.discarded && unconfirmed(value.receipt))
    || !!job.value?.unknownAlbumIds.length
    || ['queued', 'running', 'unknown'].includes(job.value?.state ?? ''))
  const pending = computed(() => busy.value || session.value?.state === 'querying'
    || selectedCount.value > 0 && (!receipt.value || !saved(receipt.value))
    || saveOperations.value.some(value => !value.discarded && !saved(value.receipt))
    || !batchDiscarded.value && ['partial', 'failed'].includes(job.value?.state ?? '') || locked.value)
  const knownJob = (value: LocalLyricsJobSnapshot) => !value.unknownAlbumIds.length
    && ['stopped', 'complete', 'partial', 'failed'].includes(value.state)
  const canNewBatch = computed(() => !pending.value && !locked.value && !!originalJob.value && !!job.value
    && job.value.jobId === originalJob.value.commandId && sameLibrary(job.value.library, originalJob.value.library)
    && knownJob(job.value) && (job.value.state === 'complete' || batchDiscarded.value && !!confirmedJobStop.value
      && confirmedJobStop.value.jobId === originalJob.value.commandId && sameLibrary(confirmedJobStop.value.library, originalJob.value.library)))
  const current = (owner: number) => !disposed && generation === owner
  function message(): void { error.value = '此操作尚未获确认；原选择和原请求已保留，请核对原状态。' }
  async function request<C extends LocalLyricsCommand>(command: C, payload: LocalLyricsCommandPayloads[C]): Promise<LocalLyricsCommandResults[C]> {
    if (!isLocalLyricsCommandPayload(command, payload)) throw new Error('歌词操作身份无效，请重新读取。')
    return options.api.localLibraryLyrics(command, copy(payload))
  }
  function originalResultKeyCurrent(key: LocalWorkbenchLyricsResultKey): boolean {
    if (!key || !isLocalLyricsId(key.jobId) || !isLocalLyricsId(key.albumId) || !isLocalLyricsLibraryRequest(key.library)
      || !Number.isSafeInteger(key.jobRevision) || key.jobRevision < 0 || !['review', 'failed', 'unknown'].includes(key.category)) return false
    if (localWorkbenchLyricsResultKeyMatches(key, job.value, originalJob.value)) return true
    const histories = jobHistory.value.filter(entry => entry.request.commandId === key.jobId)
    return histories.length === 1 && localWorkbenchLyricsResultKeyMatches(key, histories[0]!.latestSnapshot ?? histories[0]!.snapshot, histories[0]!.request)
  }
  function invalidateResultInspection(): void {
    resultGeneration++; resultDetailGeneration++; resultReceiptTurns.clear(); resultController?.abort(); resultController = undefined
    if (resultInspection.value) resultInspection.value = { ...resultInspection.value, phase: 'stale', sessionPhase: 'stale', error: '原结果的检查上下文已变化；原任务、选择与请求继续保留。' }
  }
  function closeResultInspection(): void { invalidateResultInspection(); resultInspection.value = null }
  function resultCurrent(owner: number, key: LocalWorkbenchLyricsResultKey): boolean {
    return !disposed && owner === resultGeneration && !!resultInspection.value && sameLocalWorkbenchLyricsResultKey(resultInspection.value.key, key) && originalResultKeyCurrent(key)
  }
  function resultFailure(error: unknown): LocalWorkbenchInspectionReadPhase {
    const code = error && typeof error === 'object' && 'code' in error ? (error as { code: unknown }).code : null
    return code === 'NOT_FOUND' ? 'not-found' : ['STALE', 'EXPIRED', 'CHANGED', 'CLOSED'].includes(String(code)) ? 'stale' : 'error'
  }
  function checkResultEntry(entry: LocalWorkbenchLyricsOriginalEntry, key: LocalWorkbenchLyricsResultKey): void {
    if (!entry || Reflect.ownKeys(entry).length !== 3 || !['scope', 'sessionId', 'saveRequest'].every(field => Object.hasOwn(entry, field))
      || !isLocalLyricsScope(entry.scope) || entry.scope.datasetId !== key.library.datasetId || entry.scope.libraryId !== key.library.libraryId || entry.scope.albumId !== key.albumId
      || entry.sessionId !== null && !isLocalLyricsId(entry.sessionId)
      || entry.saveRequest !== null && (!isLocalLyricsCommandPayload('localLyrics.save', entry.saveRequest) || entry.sessionId !== null && entry.saveRequest.sessionId !== entry.sessionId)) throw new Error('原任务entry与完整原scope不一致。')
  }
  function resultOperations(value: LocalLyricsSession, entry: LocalWorkbenchLyricsOriginalEntry): readonly LocalWorkbenchLyricsInspectionOperation[] {
    const operations: LocalWorkbenchLyricsInspectionOperation[] = entry.saveRequest ? [{ request: Object.freeze(copy(entry.saveRequest)), receipt: null, phase: 'idle', error: null }] : []
    for (const row of value.pendingOperations ?? []) {
      if (!isLocalLyricsCommandPayload('localLyrics.save', row.request) || row.receipt.commandId !== row.request.commandId || row.receipt.sessionId !== row.request.sessionId) throw new Error('原结果持久操作身份不一致。')
      const index = operations.findIndex(operation => operation.request.commandId === row.request.commandId)
      if (index >= 0 && (operations[index]!.request.sessionId !== row.request.sessionId || operations[index]!.request.embed !== row.request.embed)) throw new Error('原结果持久请求正文已变化。')
      const operation = { request: Object.freeze(copy(row.request)), receipt: copy(row.receipt), phase: 'ready' as const, error: null }
      if (index < 0) operations.push(operation); else operations[index] = operation
    }
    return operations
  }
  /** 只读原entry/session；与当前查询、保存和离开门禁没有状态转移。 */
  async function inspectOriginalResult(key: LocalWorkbenchLyricsResultKey, originalEntry?: LocalWorkbenchLyricsOriginalEntry | null): Promise<void> {
    if (disposed) return
    closeResultInspection()
    const expected = copy(key), owner = resultGeneration
    resultInspection.value = { key: expected, phase: 'loading', album: null, trackPage: null, capture: null, error: null, originalEntry: null, session: null, operations: [], detail: null, sessionPhase: 'idle', detailPhase: 'idle' }
    if (!originalResultKeyCurrent(expected)) { resultInspection.value = { ...resultInspection.value, phase: 'stale', error: '此原任务、修订或类别成员已变化，请只读取原批次核对。' }; return }
    resultController = new AbortController()
    let entry: LocalWorkbenchLyricsOriginalEntry | null | undefined
    try {
      if (originalEntry === undefined && !options.readOriginalResultEntry) {
        resultInspection.value = { ...resultInspection.value, phase: 'error', error: '原任务逐项定位尚未接入；原key与未确认任务已保留，没有新查询。' }; return
      }
      entry = originalEntry === undefined ? await options.readOriginalResultEntry!(copy(expected), { signal: resultController.signal }) : copy(originalEntry)
      if (!resultCurrent(owner, expected)) return
      if (!entry) throw new Error('尚未定位此原任务entry。')
      checkResultEntry(entry, expected)
      entry = copy(entry)
      resultInspection.value = { ...resultInspection.value!, originalEntry: entry, operations: entry.saveRequest ? [{ request: Object.freeze(copy(entry.saveRequest)), receipt: null, phase: 'idle', error: null }] : [], sessionPhase: entry.sessionId === null ? 'not-found' : 'loading' }
      if (entry.sessionId === null) { resultInspection.value = { ...resultInspection.value, phase: 'error', error: '原entry没有已登记的会话，原任务继续保留。' }; return }
      const value = await request('localLyrics.session.read', { sessionId: entry.sessionId })
      if (!resultCurrent(owner, expected)) return
      if (value.sessionId !== entry.sessionId || !sameScope(value.scope, entry.scope)) throw new Error('返回的原会话与Owner完整原scope不一致。')
      resultInspection.value = { ...resultInspection.value!, phase: value.state === 'stale' ? 'stale' : 'ready', sessionPhase: value.state === 'stale' ? 'stale' : 'ready', session: copy(value), operations: resultOperations(value, entry), error: value.state === 'stale' ? '原会话读取引用已陈旧，不会换签新会话。' : null }
    } catch (error) {
      if (!resultCurrent(owner, expected)) return
      const failure = resultFailure(error)
      const acceptedEntry = resultInspection.value!.originalEntry
      resultInspection.value = { ...resultInspection.value!, phase: failure === 'stale' ? 'stale' : 'error', sessionPhase: acceptedEntry ? failure : 'idle', error: !acceptedEntry ? '原任务entry尚未定位确认；原key与原请求继续保留。' : failure === 'not-found' ? '原会话不存在或已结束；已知原保存请求仍可只读核对。' : failure === 'stale' ? '原会话或捕获已陈旧，不会换签或重发。' : '此原结果尚未读取确认；原key与原请求继续保留。' }
    }
  }
  async function previewResultCandidate(candidateId: string): Promise<void> {
    const inspection = resultInspection.value, original = inspection?.session, candidate = original?.candidates.find(value => value.candidateId === candidateId)
    if (!inspection || !original || !candidate || original.state !== 'ready' || inspection.phase !== 'ready' || !originalResultKeyCurrent(inspection.key) || disposed) return
    const owner = resultGeneration, turn = ++resultDetailGeneration, expected = copy(inspection.key)
    resultInspection.value = { ...inspection, detailPhase: 'loading' }
    const latest = () => resultCurrent(owner, expected) && turn === resultDetailGeneration && resultInspection.value?.session?.sessionId === original.sessionId
    try {
      const value = await request('localLyrics.detail', { sessionId: original.sessionId, candidateId })
      if (!latest()) return
      if (!isLocalLyricsCandidateDetail(value) || (Object.keys(candidate) as (keyof typeof candidate)[]).some(field => value.candidate[field] !== candidate[field])) throw new Error('正文不是此原会话的候选。')
      resultInspection.value = { ...resultInspection.value!, detail: copy(value), detailPhase: 'ready' }
    } catch (error) { if (latest()) resultInspection.value = { ...resultInspection.value!, detailPhase: resultFailure(error), error: '原候选正文尚未确认，原会话与当前选择保留。' } }
  }
  async function readResultReceipt(commandId: string): Promise<void> {
    const inspection = resultInspection.value, operation = inspection?.operations.find(row => row.request.commandId === commandId)
    if (!inspection || !operation || !originalResultKeyCurrent(inspection.key) || disposed || inspection.phase === 'stale') return
    const owner = resultGeneration, expected = copy(inspection.key), original = copy(operation.request), pair = JSON.stringify([original.sessionId, original.commandId])
    const turn = (resultReceiptTurns.get(pair) ?? 0) + 1; resultReceiptTurns.set(pair, turn)
    const latest = () => resultCurrent(owner, expected) && resultReceiptTurns.get(pair) === turn
      && resultInspection.value!.operations.some(row => row.request.commandId === original.commandId && row.request.sessionId === original.sessionId && row.request.embed === original.embed)
    const update = (phase: LocalWorkbenchInspectionReadPhase, receipt: LocalLyricsSaveReceipt | null, message: string | null) => {
      resultInspection.value = { ...resultInspection.value!, ...(receipt ? { phase: 'ready' as const } : {}), operations: resultInspection.value!.operations.map(row => row.request.commandId === original.commandId && row.request.sessionId === original.sessionId
        ? { ...row, receipt: receipt ? copy(receipt) : row.receipt, phase, error: message } : row) }
    }
    update('loading', null, null)
    try {
      const value = await request('localLyrics.receipt', { sessionId: original.sessionId, commandId: original.commandId })
      if (!latest()) return
      if (value && (value.commandId !== original.commandId || value.sessionId !== original.sessionId)) throw new Error('原结果回执身份不一致。')
      update(value ? 'ready' : 'not-found', value, value ? null : '本次尚未查到原回执，原请求与上次回显继续保留。')
    } catch (error) { if (latest()) update(resultFailure(error), null, '原回执尚未确认，原请求继续保留，没有重发。') }
  }
  function invalidateInventory(): void {
    inventoryGeneration++; inventorySelectionGeneration++; inventory.value = null; inventoryFilter.value = 'all'; inventoryOffset.value = 0
  }
  function bind(next: LocalLyricsScope | null, nextLibrary: LocalLyricsLibraryRequest | null = null): boolean {
    if (next !== null && !isLocalLyricsScope(next)) throw new Error('歌词目标身份无效。')
    const changing = !!scope.value && (!next || !sameScope(scope.value, next))
    const changingLibrary = !!library.value && (!nextLibrary || !sameLibrary(library.value, nextLibrary))
    if ((changing || changingLibrary) && pending.value) { error.value = '原目标有待保存或未确认歌词，请先核对后切换。'; return false }
    if (nextLibrary && !isLocalLyricsCommandPayload('localLyrics.inventory', { library: nextLibrary, filter: 'all', offset: 0, limit: 200 })) throw new Error('歌词库捕获身份无效。')
    invalidateInventory(); invalidateResultInspection()
    if (changing || next === null) { generation++; detailGeneration++; clearTimeout(timer); session.value = null; detail.value = null; originalSave.value = null; receipt.value = null; saveOperations.value = [] }
    scope.value = next ? copy(next) : null
    // album scope与library capture属于不同Opaque引用，不把albumId冒充library全组。
    library.value = nextLibrary ? { datasetId: nextLibrary.datasetId, libraryId: nextLibrary.libraryId, captureId: nextLibrary.captureId } : null
    return true
  }
  function setLibraries(values: readonly LocalLyricsLibraryRequest[]): void {
    if (values.some(value => !isLocalLyricsCommandPayload('localLyrics.inventory', { library: value, filter: 'all', offset: 0, limit: 200 }))
      || new Set(values.map(value => value.libraryId)).size !== values.length) throw new Error('歌词库捕获回显无效。')
    availableLibraries.value = copy(values)
    invalidateInventory(); invalidateResultInspection()
    if (pending.value) return
    const selected = values.find(value => library.value && sameLibrary(value, library.value)) ?? (values.length === 1 ? values[0] : null)
    library.value = selected ? copy(selected) : null
  }
  function chooseLibrary(libraryId: string): void {
    if (pending.value || originalJob.value && !canNewBatch.value) return
    const target = availableLibraries.value.find(value => value.libraryId === libraryId)
    if (!target) return
    invalidateResultInspection()
    if (originalJob.value) newBatch()
    invalidateInventory(); library.value = copy(target)
  }
  function acceptSession(value: LocalLyricsSession, expected: LocalLyricsScope, owner: number): boolean {
    if (!current(owner)) return false
    if (!sameScope(value.scope, expected) || session.value && value.sessionId !== session.value.sessionId) throw new Error('歌词会话与原目标不一致。')
    for (const operation of value.pendingOperations ?? []) {
      if (!isLocalLyricsCommandPayload('localLyrics.save', operation.request)) throw new Error('歌词恢复原请求身份无效。')
      // 新查询会话可回显旧持久pair；不能把它的sessionId改成新会话或重建embed/body。
      acceptReceipt(operation.receipt, Object.freeze(copy(operation.request)))
    }
    session.value = copy(value)
    return true
  }
  function scheduleSession(owner: number): void {
    clearTimeout(timer)
    if (current(owner) && session.value?.state === 'querying') timer = setTimeout(() => { void refreshSession(owner) }, options.pollMs ?? 300)
  }
  async function refreshSession(owner = generation): Promise<void> {
    const s = session.value, target = scope.value
    if (!s || !target || disposed) return
    try { const next = await request('localLyrics.session.read', { sessionId: s.sessionId }); if (acceptSession(next, target, owner)) scheduleSession(owner) }
    catch { if (current(owner)) message() }
  }
  async function query(): Promise<void> {
    if (busy.value || pending.value || !scope.value || disposed) return
    const target = copy(scope.value), owner = ++generation
    busy.value = true; error.value = ''; detail.value = null; session.value = null; originalSave.value = null; receipt.value = null; saveOperations.value = []
    try { const value = await request('localLyrics.query', { scope: target }); if (acceptSession(value, target, owner)) scheduleSession(owner) }
    catch { if (current(owner)) message() }
    finally { if (current(owner)) busy.value = false }
  }
  async function preview(candidateId: string): Promise<void> {
    const s = session.value, candidate = s?.candidates.find(v => v.candidateId === candidateId)
    if (!s || !candidate || disposed) return
    const owner = generation, turn = ++detailGeneration
    try {
      const value = await request('localLyrics.detail', { sessionId: s.sessionId, candidateId })
      if (!current(owner) || turn !== detailGeneration) return
      if (!isLocalLyricsCandidateDetail(value) || value.candidate.candidateId !== candidateId || value.candidate.trackId !== candidate.trackId) throw new Error('歌词正文不属于此候选。')
      detail.value = copy(value)
    } catch { if (current(owner) && turn === detailGeneration) message() }
  }
  async function select(trackId: string, candidateId: string | null): Promise<void> {
    const s = session.value, target = scope.value
    if (locked.value || busy.value || !s || !target || s.state !== 'ready' || disposed) return
    if (originalSave.value) { error.value = '原保存已有回执，请先核对原操作后重新查询明确的目标。'; return }
    if (candidateId !== null && !s.candidates.some(v => v.candidateId === candidateId && v.trackId === trackId)) return
    const owner = generation; busy.value = true; error.value = ''
    try { acceptSession(await request('localLyrics.select', { sessionId: s.sessionId, trackId, candidateId }), target, owner) }
    catch { if (current(owner)) message() }
    finally { if (current(owner)) busy.value = false }
  }
  function acceptReceipt(value: LocalLyricsSaveReceipt, original: LocalLyricsSaveRequest): void {
    if (value.commandId !== original.commandId || value.sessionId !== original.sessionId) throw new Error('歌词原回执身份无效。')
    const index = saveOperations.value.findIndex(row => row.request.commandId === original.commandId)
    const old = saveOperations.value[index]
    if (old && (old.request.sessionId !== original.sessionId || old.request.embed !== original.embed)) throw new Error('歌词原请求正文已变化。')
    const accepted = old?.discarded || old?.receipt.state === 'complete' && value.state !== 'complete'
      ? old : { request: Object.freeze(copy(original)), receipt: copy(value) }
    const next = [...saveOperations.value]; if (index < 0) next.push(accepted); else next[index] = accepted
    saveOperations.value = next
    if (!originalSave.value || originalSave.value.commandId === original.commandId) {
      originalSave.value = accepted.request; receipt.value = copy(accepted.receipt); embed.value = accepted.request.embed
    }
  }
  function selectOriginal(commandId: string): void {
    if (writing.value) return
    const operation = saveOperations.value.find(row => row.request.commandId === commandId)
    if (!operation) return
    originalSave.value = operation.request; receipt.value = copy(operation.receipt); embed.value = operation.request.embed
  }
  async function readOriginal(commandId?: string): Promise<boolean> {
    const originals = saveOperations.value.filter(row => !row.discarded && (!commandId || row.request.commandId === commandId)).map(row => row.request)
    if (!originals.length || writing.value || disposed) return false
    writing.value = true; error.value = ''
    try {
      for (const original of originals) {
        const value = await request('localLyrics.receipt', { sessionId: original.sessionId, commandId: original.commandId })
        if (disposed) return false
        if (value) acceptReceipt(value, original)
        else notice.value = '尚未查到原回执；原请求继续保留，没有重发。'
      }
    } catch { if (!disposed) message() }
    finally { writing.value = false }
    return saveOperations.value.every(row => row.discarded || saved(row.receipt))
  }
  async function save(): Promise<boolean> {
    if (originalSave.value) return readOriginal()
    const s = session.value
    if (locked.value || busy.value || !s || s.state !== 'ready' || !selectedCount.value || disposed) return false
    const original = Object.freeze({ sessionId: s.sessionId, commandId: id(), embed: embed.value })
    originalSave.value = original; writing.value = true; error.value = ''
    try { const value = await request('localLyrics.save', original); if (!disposed) acceptReceipt(value, original) }
    catch { if (!disposed) { acceptReceipt({ commandId: original.commandId, sessionId: original.sessionId, state: 'unknown', cover: 'unknown', tracks: [], snapshot: 'not-requested' }, original); message() } }
    finally { writing.value = false }
    return receipt.value !== null && saved(receipt.value)
  }
  async function retryFailed(): Promise<void> {
    const original = originalSave.value, value = receipt.value
    if (!original || locked.value || !value || !['partial', 'failed'].includes(value.state)
      || ['unknown', 'pending'].includes(value.cover) || value.tracks.some(v => ['unknown', 'pending'].includes(v.lrc) || ['unknown', 'pending'].includes(v.embed)) || disposed) return
    writing.value = true; error.value = ''
    try { const next = await request('localLyrics.save.retry', { sessionId: original.sessionId, commandId: original.commandId }); if (!disposed) acceptReceipt(next, original) }
    catch { if (!disposed) message() } finally { writing.value = false }
  }
  async function retrySnapshot(): Promise<void> {
    const original = originalSave.value
    if (!original || locked.value || receipt.value?.snapshot !== 'failed' || disposed) return
    writing.value = true
    try { const value = await request('localLyrics.snapshot.retry', { sessionId: original.sessionId, commandId: original.commandId }); if (!disposed) acceptReceipt(value, original) }
    catch { if (!disposed) message() } finally { writing.value = false }
  }
  async function cancelQuery(): Promise<void> {
    const s = session.value; clearTimeout(timer)
    if (!s || locked.value || disposed) return
    const owner = generation; busy.value = true
    try { const value = await request('localLyrics.cancel', { sessionId: s.sessionId }); if (current(owner) && scope.value) acceptSession(value, scope.value, owner) }
    catch { if (current(owner)) message() } finally { if (current(owner)) busy.value = false }
  }
  async function discard(): Promise<boolean> {
    if (locked.value || busy.value || disposed) return false
    const originalSession = session.value, owner = generation
    writing.value = true; error.value = ''
    try {
      if (originalJob.value && !batchDiscarded.value && ['partial', 'failed', 'stopped'].includes(job.value?.state ?? '')) {
        const value = await request('localLyrics.job.stop', { jobId: originalJob.value.commandId })
        if (!current(owner)) return false
        if (!acceptJob(value, originalJob.value.library) || !knownJob(value)) throw new Error('歌词批次停止尚未确认。')
        // 原Owner stop已等待查询和writer收口；只登记同一原job的已知回执，不重签任务。
        confirmedJobStop.value = copy(value); batchDiscarded.value = true
      }
      for (const operation of saveOperations.value.filter(row => !row.discarded)) {
        const value = await request('localLyrics.discard', { sessionId: operation.request.sessionId, commandId: operation.request.commandId })
        if (!current(owner)) return false
        if (!('commandId' in value) || value.commandId !== operation.request.commandId || value.sessionId !== operation.request.sessionId || unconfirmed(value)) throw new Error('歌词原丢弃回执尚未确认。')
        saveOperations.value = saveOperations.value.map(row => row.request.commandId === operation.request.commandId ? { ...row, receipt: copy(value), discarded: true } : row)
      }
      if (originalSession) {
        const value = await request('localLyrics.discard', { sessionId: originalSession.sessionId })
        if (!current(owner)) return false
        if ('commandId' in value || value.sessionId !== originalSession.sessionId || !sameScope(value.scope, originalSession.scope) || value.state === 'querying'
          || value.pendingOperations?.some(row => unconfirmed(row.receipt))) throw new Error('歌词查询停止与丢弃尚未确认。')
      }
      generation++; detailGeneration++; invalidateInventory(); clearTimeout(timer); session.value = null; detail.value = null; receipt.value = null; originalSave.value = null; saveOperations.value = []
      return true
    } catch { if (current(owner)) message(); return false }
    finally { writing.value = false }
  }
  function acceptJob(value: LocalLyricsJobSnapshot, expected: LocalLyricsLibraryRequest): boolean {
    if (value.jobId !== originalJob.value?.commandId || !sameLibrary(value.library, expected) || job.value && job.value.jobId !== value.jobId) throw new Error('歌词批次目标已变化。')
    if (job.value && value.revision < job.value.revision) return false
    job.value = copy(value); jobUnknown.value = value.state === 'unknown'
    return true
  }
  async function startBatch(): Promise<void> {
    if (!library.value || originalJob.value || batchBusy.value || pending.value || disposed) return
    const original = Object.freeze({ commandId: id(), library: copy(library.value), embed: embed.value })
    originalJob.value = original; batchDiscarded.value = false; confirmedJobStop.value = null; batchBusy.value = true; error.value = ''
    try { const value = await request('localLyrics.job.start', original); if (!disposed) acceptJob(value, original.library) }
    catch { if (!disposed) { jobUnknown.value = true; message() } } finally { batchBusy.value = false }
  }
  async function batchAction(action: 'read' | 'stop' | 'resume' | 'retry'): Promise<void> {
    const original = originalJob.value, currentJob = job.value
    if (!original || batchBusy.value || disposed) return
    // jobId由Owner固定原commandId；lost start也只查询该原任务，不重发start。
    const jobId = currentJob?.jobId ?? original.commandId
    if (action !== 'read' && (!currentJob || jobUnknown.value || currentJob.state === 'unknown' || currentJob.unknownAlbumIds.length)) return
    if (action === 'resume' || action === 'retry') { batchDiscarded.value = false; confirmedJobStop.value = null }
    batchBusy.value = true; error.value = ''
    try {
      const value = action === 'retry'
        ? await request('localLyrics.job.retry', { jobId, albumIds: [...currentJob!.failedAlbumIds] })
        : await request(`localLyrics.job.${action}`, { jobId })
      if (!disposed && value) acceptJob(value, original.library)
      if (!value) notice.value = '尚未查到此原批次；原body继续保留。'
    } catch { if (!disposed) message() } finally { batchBusy.value = false }
  }
  function newBatch(): void {
    if (!canNewBatch.value || !originalJob.value || !job.value || disposed) return
    // 显式结束活动指针前保留原body及已核回执，历史查询仍只用原jobId。
    jobHistory.value = [...jobHistory.value, { request: copy(originalJob.value), snapshot: copy(confirmedJobStop.value ?? job.value), latestSnapshot: copy(job.value) }]
    originalJob.value = null; job.value = null; batchDiscarded.value = false; confirmedJobStop.value = null
  }
  async function readJobHistory(commandId: string): Promise<void> {
    const entry = jobHistory.value.find(value => value.request.commandId === commandId)
    if (!entry || batchBusy.value || disposed) return
    batchBusy.value = true
    try {
      const value = await request('localLyrics.job.read', { jobId: entry.request.commandId })
      if (disposed) return
      if (!value) { notice.value = '尚未查到此已结束原批次，原body和上次回执保留。'; return }
      if (value.jobId !== entry.request.commandId || !sameLibrary(value.library, entry.request.library)) throw new Error('已结束歌词批次回执身份无效。')
      if (value.revision < (entry.latestSnapshot ?? entry.snapshot).revision) return
      // 核对的新回显另存；原停止确认的身份、revision和快照不被后续读取覆盖。
      jobHistory.value = jobHistory.value.map(row => row.request.commandId === commandId ? { ...row, latestSnapshot: copy(value) } : row)
    } catch { if (!disposed) message() } finally { batchBusy.value = false }
  }
  async function readInventory(filter = inventoryFilter.value, offset = inventoryOffset.value): Promise<void> {
    if (!library.value || disposed) return
    const expected = copy(library.value), owner = generation, sequence = ++inventoryGeneration, selection = inventorySelectionGeneration
    inventoryFilter.value = filter; inventoryOffset.value = offset
    const latest = () => current(owner) && sequence === inventoryGeneration && selection === inventorySelectionGeneration
      && !!library.value && sameLibrary(library.value, expected)
    try {
      const page = await request('localLyrics.inventory', { library: expected, filter, offset, limit: 200 })
      if (!latest()) return
      if (page.offset !== offset) throw new Error('歌词库存页身份无效。')
      inventory.value = copy(page); inventoryFilter.value = filter; inventoryOffset.value = offset
    } catch { if (latest()) message() }
  }
  const stopResultWatch = watch(() => [job.value, originalJob.value, jobHistory.value], () => {
    if (resultInspection.value && !originalResultKeyCurrent(resultInspection.value.key)) invalidateResultInspection()
  }, { flush: 'sync' })
  function dispose(): void { generation++; detailGeneration++; inventoryGeneration++; inventorySelectionGeneration++; invalidateResultInspection(); stopResultWatch(); clearTimeout(timer); disposed = true }
  return { scope, library, availableLibraries, session, detail, receipt, originalSave, saveOperations, job, originalJob, jobHistory, canNewBatch, inventory, embed, error, notice,
    busy, writing, batchBusy, pending, locked, selectedCount, inventoryFilter, inventoryOffset,
    bind, setLibraries, chooseLibrary, query, refreshSession, preview, select, save, readOriginal, selectOriginal, retryFailed, retrySnapshot, cancelQuery, discard,
    startBatch, batchAction, newBatch, readJobHistory, readInventory, resultInspection, inspectOriginalResult, closeResultInspection, previewResultCandidate, readResultReceipt,
    isOriginalResultKey: originalResultKeyCurrent, resultKeyMatches: localWorkbenchLyricsResultKeyMatches, sameResultKey: sameLocalWorkbenchLyricsResultKey, dispose }
}
export type LocalWorkbenchLyrics = ReturnType<typeof useLocalWorkbenchLyrics>
