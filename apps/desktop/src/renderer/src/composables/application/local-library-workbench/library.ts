import { computed, ref, shallowRef, toRaw } from 'vue'
import { logLibraryOperation } from '../../../../../../../../packages/bridge-core/src/shared/library-operation-log.js'
import { isLocalLibraryManagementPayload, isLocalLibraryManagementResult, isLocalLibraryManagementMainPayload, isLocalNameSettingsPayload } from '@music-bridge/contracts'
import type {
  LocalLibraryManagementCommand, LocalLibraryManagementPayloads, LocalLibraryManagementResults,
  LocalLibraryManagementMainCommand, LocalLibraryManagementMainPayloads, LocalLibraryManagementMainResults,
  LocalLibraryManagementReadback, LocalLibraryImportChoice, LocalLibraryRole, LocalLibraryCompleteCapture,
  LocalLibraryManagementOperation, LocalLibraryBatchPage, LocalNameSettingsCommand, LocalNameSettingsPayloads,
  LocalNameSettingsResults, LocalNameSettings, LocalNameSettingsInput, LocalAiBackend, LocalCueOutputTarget,
} from '@music-bridge/contracts'

export interface LocalLibraryWorkspaceApi {
  localLibraryManagement<C extends LocalLibraryManagementMainCommand>(command: C, payload: LocalLibraryManagementMainPayloads[C]): Promise<LocalLibraryManagementMainResults[C]>
  localNameSettings<C extends LocalNameSettingsCommand>(command: C, payload: LocalNameSettingsPayloads[C]): Promise<LocalNameSettingsResults[C]>
}
const copy = <T>(v: T): T => structuredClone(toRaw(v))
const nameInput = (v: LocalNameSettings): LocalNameSettingsInput => ({ expectedRevision: v.revision, backend: v.backend, ollama: copy(v.ollama), vllm: copy(v.vllm), cloud: { endpoint: v.cloud.endpoint, model: v.cloud.model } })
type LibraryMutation = 'library.import.confirm' | 'library.rename' | 'library.remove' | 'library.snapshot.load' | 'library.snapshot.retry' | 'library.settings.save' | 'library.watch.set'
type OriginalMutation = { [C in LibraryMutation]: { command: C; payload: LocalLibraryManagementPayloads[C] } }[LibraryMutation]
type OriginalJob = { command: 'library.ai.start'; payload: LocalLibraryManagementPayloads['library.ai.start'] } | { command: 'library.cue.start'; payload: LocalLibraryManagementPayloads['library.cue.start'] }
type AddReason = 'ADD_CHOOSING' | 'ADD_ALREADY_ACTIVE' | 'ADD_PENDING' | 'ADD_BUSY' | 'ADD_CONTEXT_CHANGED' | 'ADD_READ_FAILED'
  | 'ADD_CHANGE_BLOCKED' | 'ADD_PICKER_CANCELLED' | 'ADD_PREPARE_FAILED' | 'ADD_CHOICE_READY' | 'ADD_CONFIRMING'
  | 'ADD_CONFIRM_UNKNOWN' | 'ADD_CONFIRM_RUNNING' | 'ADD_CONFIRM_FAILED' | 'ADD_CONFIRM_PARTIAL' | 'ADD_CONFIRM_CANCELLED' | 'ADD_REGISTERED'
export interface LocalLibraryAddFeedback {
  phase: 'choosing' | 'confirming' | 'cancelled' | 'interrupted' | 'unconfirmed' | 'failed' | 'added'
  code: AddReason
  message: string
  commandId: string | null
  libraryIds: readonly string[]
}
type RemoveReason = 'REMOVE_STARTED' | 'REMOVE_SUCCEEDED' | 'REMOVE_REFRESH_PENDING' | 'REMOVE_FAILED' | 'REMOVE_PARTIAL'
  | 'REMOVE_CANCELLED' | 'REMOVE_UNKNOWN' | 'REMOVE_RUNNING' | 'REMOVE_REQUEST_UNCONFIRMED' | 'REMOVE_QUERY_UNCONFIRMED' | 'REMOVE_QUERY_MISSING'
export interface LocalLibraryRemoveFeedback {
  phase: 'removing' | 'removed' | 'failed' | 'unconfirmed' | 'cancelled'
  code: RemoveReason
  message: string
  commandId: string
  libraryIds: readonly string[]
}
type ImportPreparation = { code: 'ADD_CHOICE_READY'; choice: LocalLibraryImportChoice }
  | { code: 'ADD_PENDING' | 'ADD_BUSY' | 'ADD_CONTEXT_CHANGED' | 'ADD_READ_FAILED' | 'ADD_PICKER_CANCELLED' | 'ADD_PREPARE_FAILED' }
const importPreparationFailureMessage = '文件夹准备未完成，尚未提交添加确认；请核对目录可读性后重新选择。'

/** 全库捕获来自唯一Owner；UI页、搜索和选中100项不充作全库水位。 */
export function useLocalWorkbenchLibrary(options: { api: LocalLibraryWorkspaceApi; makeCommandId?: () => string; storage?: Pick<Storage, 'getItem' | 'setItem'>; onChanged?: () => void; canChangeLibrary?: () => boolean }) {
  const state = shallowRef<LocalLibraryManagementReadback | null>(null), capture = shallowRef<LocalLibraryCompleteCapture | null>(null)
  const selectedLibraryIds = ref<readonly string[]>([]), importChoice = shallowRef<LocalLibraryImportChoice | null>(null), role = ref<LocalLibraryRole>('catalog')
  const operations = shallowRef<readonly LocalLibraryManagementOperation[]>([]), originals = shallowRef<readonly OriginalMutation[]>([])
  const job = shallowRef<LocalLibraryBatchPage | null>(null), originalJob = shallowRef<OriginalJob | null>(null), jobOffset = ref(0), unknownJob = ref(false), batchDiscarded = ref(false)
  const settings = shallowRef<LocalNameSettings | null>(null), settingsDraft = shallowRef<LocalNameSettingsInput | null>(null)
  const originalNameSave = shallowRef<LocalNameSettingsPayloads['name.settings.save'] | null>(null), scanConcurrency = ref(12)
  const originalImportCancel = shallowRef<{ datasetId: string; choiceId: string } | null>(null)
  const busy = ref(false), writing = ref(false), startingJob = ref(false), addingLibrary = ref(false), error = ref(''), notice = ref('')
  // 只标记普通library.read的真实失败；写入未知、名称设置或任务错误不能据此自动恢复。
  const readFailed = ref(false)
  // 本次添加回执独立于读取错误；成功轮询不能擦掉取消、中断或未知写入的结果。
  const addFeedback = shallowRef<LocalLibraryAddFeedback | null>(null)
  const removeFeedback = shallowRef<LocalLibraryRemoveFeedback | null>(null)
  const removedLibraries = shallowRef<readonly { libraryId: string; order: number }[]>([])
  let removedDatasetId: string | null = null
  let removeContext: { commandId: string; datasetId: string | null; libraryIds: readonly string[]; order: number; started: number; applied: boolean } | null = null
  const confirmedRemovedLibraryIds = computed(() => {
    const removed = removedLibraries.value
    return state.value && state.value.datasetId !== removedDatasetId ? [] : removed.map(value => value.libraryId)
  })
  let addContext: { commandId: string; label: string; started: number } | null = null, addStarted = 0
  let readCompletion: Promise<boolean> | null = null
  let generation = 0, captureSequence = 0, selectionGeneration = 0, jobStartSequence = 0, disposed = false, selectionRestoredFor = '', libraryAnchor: string | null = null
  const id = options.makeCommandId ?? (() => crypto.randomUUID())
  const unresolved = computed(() => operations.value.filter(v => v.state === 'unknown' || v.state === 'running'))
  const nameDirty = computed(() => !!settings.value && !!settingsDraft.value && JSON.stringify(settingsDraft.value) !== JSON.stringify(nameInput(settings.value)))
  const ordinaryOperationLocked = computed(() => writing.value || unresolved.value.length > 0 || !!originalNameSave.value || unknownJob.value || ['queued', 'running', 'unknown'].includes(job.value?.state ?? ''))
  const operationLocked = computed(() => ordinaryOperationLocked.value || !!originalImportCancel.value)
  const locked = computed(() => startingJob.value || operationLocked.value)
  const pending = computed(() => locked.value || !!importChoice.value || nameDirty.value || !!state.value && scanConcurrency.value !== state.value.scanConcurrency
    || !batchDiscarded.value && ['partial', 'failed'].includes(job.value?.state ?? ''))
  const selectionLocked = computed(() => addingLibrary.value || pending.value || options.canChangeLibrary?.() === false)
  const unknownAlbums = new Set<string>()
  const current = (owner: number) => !disposed && generation === owner
  function fail(): void { error.value = '此库操作结果尚未确认；原请求已保留，请读取原状态，不要更换参数重试。' }
  function feedback(phase: LocalLibraryAddFeedback['phase'], code: AddReason, message: string, commandId: string | null = null, libraryIds: readonly string[] = []): void {
    addFeedback.value = { phase, code, message, commandId, libraryIds: [...libraryIds] }
  }
  function traceAdd(action: string, result: 'start' | 'complete' | 'error' | 'cancelled' | 'skipped' | 'progress', code: AddReason, started = addStarted): void {
    logLibraryOperation('ui', action, result, { code, elapsedMs: Math.max(0, performance.now() - started), roots: state.value?.libraries.length ?? 0 })
  }
  function observeAddReceipt(value: LocalLibraryManagementOperation): void {
    if (!addContext || value.commandId !== addContext.commandId || value.kind !== 'library.import.confirm') return
    const { commandId, label, started } = addContext
    const outcomes = {
      succeeded: ['added', 'ADD_REGISTERED', `已登记“${label}”。正在读取真实扫描进度，专辑会随扫描结果更新。`, 'complete'],
      running: ['unconfirmed', 'ADD_CONFIRM_RUNNING', '目录添加仍在处理中；原请求已保留，请查询原添加结果。扫描状态尚待确认。', 'progress'],
      unknown: ['unconfirmed', 'ADD_CONFIRM_UNKNOWN', '目录添加结果尚未确认；原请求已保留，请查询原添加结果，不要重复添加。', 'error'],
      failed: ['failed', 'ADD_CONFIRM_FAILED', '目录添加未完成。原选择与操作回执已保留，请核对原添加结果。', 'error'],
      partial: ['failed', 'ADD_CONFIRM_PARTIAL', '目录仅部分添加。请核对原添加结果与各音乐库的真实扫描状态。', 'error'],
      cancelled: ['cancelled', 'ADD_CONFIRM_CANCELLED', '本次目录添加已取消，请核对下方已有音乐库与扫描记录。', 'cancelled'],
    } as const
    const [phase, code, message, result] = outcomes[value.state]
    if (addFeedback.value?.commandId === commandId && addFeedback.value.code === code) return
    feedback(phase, code, message, commandId, value.libraryIds)
    traceAdd('add.confirmed', result, code, started)
  }
  function removalFeedback(phase: LocalLibraryRemoveFeedback['phase'], code: RemoveReason, message: string): void {
    if (!removeContext || removeFeedback.value?.commandId === removeContext.commandId && removeFeedback.value.code === code) return
    removeFeedback.value = { phase, code, message, commandId: removeContext.commandId, libraryIds: [...removeContext.libraryIds] }
    logLibraryOperation('ui', 'remove.receipt', phase === 'removing' ? 'start' : phase === 'removed' ? 'complete' : phase === 'cancelled' ? 'cancelled' : 'error',
      { code, elapsedMs: Math.max(0, performance.now() - removeContext.started), count: removeContext.libraryIds.length })
  }
  function observeRemoveReceipt(value: LocalLibraryManagementOperation): void {
    const context = removeContext
    if (!context || value.commandId !== context.commandId || value.kind !== 'library.remove') return
    if (value.state === 'succeeded') {
      if (context.applied) return
      context.applied = true
      if (state.value?.datasetId === context.datasetId) {
        removedDatasetId = context.datasetId
        removedLibraries.value = [...removedLibraries.value.filter(item => !context.libraryIds.includes(item.libraryId)), ...context.libraryIds.map(libraryId => ({ libraryId, order: context.order }))]
        selectedLibraryIds.value = selectedLibraryIds.value.filter(libraryId => !context.libraryIds.includes(libraryId))
        if (libraryAnchor && context.libraryIds.includes(libraryAnchor)) libraryAnchor = null
        selectionGeneration++; captureSequence++; capture.value = null; rememberSelection()
      }
      removalFeedback('removed', 'REMOVE_REFRESH_PENDING', '已移除选中音乐库的本地记录，列表刷新待确认；源音乐文件保留。')
      return
    }
    const outcomes = {
      running: ['unconfirmed', 'REMOVE_RUNNING', '移除仍在处理中；原请求已保留，请查询原移除结果，不要重复提交。'],
      unknown: ['unconfirmed', 'REMOVE_UNKNOWN', '移除结果尚未确认；原请求已保留，请查询原移除结果，不要重复提交。'],
      failed: ['failed', 'REMOVE_FAILED', '移除未完成。原操作回执已保留，现有音乐库继续显示，请核对原结果。'],
      partial: ['failed', 'REMOVE_PARTIAL', '移除仅部分完成。原操作回执已保留，请核对各音乐库状态。'],
      cancelled: ['cancelled', 'REMOVE_CANCELLED', '本次移除已取消，现有音乐库继续显示；源音乐文件保留。'],
    } as const
    const [phase, code, message] = outcomes[value.state]
    removalFeedback(phase, code, message)
  }
  function request<C extends LocalLibraryManagementCommand>(command: C, payload: LocalLibraryManagementPayloads[C]): Promise<LocalLibraryManagementResults[C]>
  function request(command: 'library.import.cancel', payload: LocalLibraryManagementMainPayloads['library.import.cancel']): Promise<LocalLibraryManagementMainResults['library.import.cancel']>
  async function request(command: LocalLibraryManagementMainCommand, payload: LocalLibraryManagementMainPayloads[LocalLibraryManagementMainCommand]): Promise<LocalLibraryManagementMainResults[LocalLibraryManagementMainCommand]> {
    if (!isLocalLibraryManagementMainPayload(command, payload)) throw new Error('库操作输入无效，请核对当前选择。')
    return options.api.localLibraryManagement(command, copy(payload))
  }
  async function nameRequest<C extends LocalNameSettingsCommand>(command: C, payload: LocalNameSettingsPayloads[C]): Promise<LocalNameSettingsResults[C]> {
    if (!isLocalNameSettingsPayload(command, payload)) throw new Error('模型配置输入无效，请使用不带凭据的端点。')
    return options.api.localNameSettings(command, copy(payload))
  }
  function rememberSelection(): void {
    if (!state.value) return
    try { options.storage?.setItem('musicbridge.coverdrop.libraries.' + state.value.datasetId, JSON.stringify(selectedLibraryIds.value)) } catch { notice.value = '当前选择可继续使用，但本机保存失败。' }
  }
  async function read(): Promise<boolean> {
    if (disposed) return false
    if (busy.value) return readCompletion ?? false
    const owner = generation; busy.value = true
    const removedBeforeRead = removeFeedback.value?.phase === 'removed' ? removeContext : null
    let releaseRead!: (succeeded: boolean) => void, succeeded = false
    const completion = new Promise<boolean>(resolve => { releaseRead = resolve }); readCompletion = completion
    try {
      const next = await request('library.read', {})
      if (!current(owner)) return false
      if (state.value && next.datasetId !== state.value.datasetId && locked.value) { error.value = '工作库已变化；原请求继续保留，不能绑定到新库。'; return false }
      const scanDirty = state.value !== null && scanConcurrency.value !== state.value.scanConcurrency
      const wasEmpty = state.value?.libraries.length === 0
      if (removedDatasetId !== null && next.datasetId !== removedDatasetId) { removedLibraries.value = []; removedDatasetId = null }
      state.value = copy(next)
      if (selectionRestoredFor !== next.datasetId) {
        selectionRestoredFor = next.datasetId
        try { const saved = JSON.parse(options.storage?.getItem('musicbridge.coverdrop.libraries.' + next.datasetId) ?? '[]'); selectedLibraryIds.value = Array.isArray(saved) ? saved.filter((v): v is string => typeof v === 'string' && next.libraries.some(l => l.libraryId === v)) : [] } catch { selectedLibraryIds.value = [] }
        if (!selectedLibraryIds.value.length && next.libraries.length === 1) selectedLibraryIds.value = [next.libraries[0]!.libraryId]
      } else if (wasEmpty && next.libraries.length && !selectedLibraryIds.value.length) {
        // 首次添加完成后让设置整理入口使用真正的新根；后续浏览不覆盖用户清空的选择。
        selectedLibraryIds.value = next.libraries.map(library => library.libraryId); rememberSelection()
      }
      if (!locked.value && !scanDirty) scanConcurrency.value = next.scanConcurrency
      if (removedBeforeRead && removeContext === removedBeforeRead && next.datasetId === removedBeforeRead.datasetId
        && !next.libraries.some(library => removedBeforeRead.libraryIds.includes(library.libraryId))) {
        removalFeedback('removed', 'REMOVE_SUCCEEDED', '已移除选中音乐库的本地记录；源音乐文件保留。')
      }
      readFailed.value = false; error.value = ''; succeeded = true
      return true
    } catch {
      if (current(owner)) { readFailed.value = true; error.value = removedBeforeRead ? '音乐库列表刷新待确认；已确认的移除结果保留。' : '音乐库列表读取未完成；已有音乐库信息保留，请重试读取。' }
      return false
    } finally {
      if (readCompletion === completion) readCompletion = null
      if (current(owner)) busy.value = false
      releaseRead(succeeded)
    }
  }
  function selectLibrary(libraryId: string, selected: boolean): void {
    if (selectionLocked.value || options.canChangeLibrary?.() === false || !state.value?.libraries.some(v => v.libraryId === libraryId)) return
    selectedLibraryIds.value = selected ? [...new Set([...selectedLibraryIds.value, libraryId])] : selectedLibraryIds.value.filter(v => v !== libraryId)
    selectionGeneration++; capture.value = null; rememberSelection()
  }
  function selectLibraries(ids: readonly string[]): void {
    if (selectionLocked.value || options.canChangeLibrary?.() === false || !state.value || new Set(ids).size !== ids.length || ids.some(id => !state.value!.libraries.some(value => value.libraryId === id))) return
    selectedLibraryIds.value = [...ids]; capture.value = null; rememberSelection()
    selectionGeneration++
  }
  function selectLibraryAt(libraryId: string, range: boolean): void {
    if (selectionLocked.value || options.canChangeLibrary?.() === false || !state.value) return
    const index = state.value.libraries.findIndex(value => value.libraryId === libraryId), anchor = state.value.libraries.findIndex(value => value.libraryId === libraryAnchor)
    if (index < 0) return
    if (range && anchor >= 0) selectLibraries([...new Set([...selectedLibraryIds.value, ...state.value.libraries.slice(Math.min(index, anchor), Math.max(index, anchor) + 1).map(value => value.libraryId)])])
    else { selectLibrary(libraryId, !selectedLibraryIds.value.includes(libraryId)); libraryAnchor = libraryId }
  }
  async function captureLibraries(ids?: readonly string[]): Promise<LocalLibraryCompleteCapture | null> {
    return captureLibraryIntent(ids ?? selectedLibraryIds.value, ids === undefined, false)
  }
  async function captureLibraryIntent(ids: readonly string[], followsSelection: boolean, forStartingJob: boolean): Promise<LocalLibraryCompleteCapture | null> {
    if (!state.value || !ids.length || operationLocked.value || startingJob.value && !forStartingJob || disposed) return null
    const expected = [...ids], dataset = state.value.datasetId, owner = generation, sequence = ++captureSequence, selection = selectionGeneration
    try {
      const next = await request('library.capture', { libraryIds: expected })
      if (!current(owner) || sequence !== captureSequence || state.value?.datasetId !== dataset
        || followsSelection && (selection !== selectionGeneration || !sameSelection(expected, selectedLibraryIds.value))) return null
      if (next.datasetId !== dataset || next.libraryIds.length !== expected.length || expected.some(v => !next.libraryIds.includes(v))
        || next.lyricsLibraries.some(v => v.datasetId !== dataset || !expected.includes(v.libraryId))) throw new Error('完整库捕获不属于此选择。')
      capture.value = copy(next); return next
    } catch { if (current(owner) && sequence === captureSequence && state.value?.datasetId === dataset
      && (!followsSelection || selection === selectionGeneration && sameSelection(expected, selectedLibraryIds.value))) error.value = '音乐库范围读取未完成；请核对当前选择后重新读取。'; return null }
  }
  async function chooseImport(): Promise<ImportPreparation> {
    if (disposed) return { code: 'ADD_CONTEXT_CHANGED' }
    if (pending.value) return { code: 'ADD_PENDING' }
    const owner = generation, datasetId = state.value?.datasetId
    // 只等待当前读取自然结算；单次点击不因初始读占忙而丢失，也不排队重放原生选择。
    const readSucceeded = readCompletion ? await readCompletion : true
    if (!current(owner) || datasetId !== undefined && state.value?.datasetId !== datasetId) return { code: 'ADD_CONTEXT_CHANGED' }
    if (!readSucceeded) return { code: 'ADD_READ_FAILED' }
    if (pending.value) return { code: 'ADD_PENDING' }
    if (busy.value) return { code: 'ADD_BUSY' }
    busy.value = true; error.value = ''
    // 只有实际接受下一次准备才结束上次准备反馈；普通列表读取不擦除它。
    if (addFeedback.value?.code === 'ADD_PREPARE_FAILED') addFeedback.value = null
    try {
      const next = await request('library.import.prepare', {})
      if (!current(owner)) return { code: 'ADD_CONTEXT_CHANGED' }
      importChoice.value = next ? copy(next) : null
      if (!next) return { code: 'ADD_PICKER_CANCELLED' }
      role.value = next.suggestedRole; return { code: 'ADD_CHOICE_READY', choice: copy(next) }
    } catch {
      if (current(owner)) feedback('failed', 'ADD_PREPARE_FAILED', importPreparationFailureMessage)
      return { code: current(owner) ? 'ADD_PREPARE_FAILED' : 'ADD_CONTEXT_CHANGED' }
    }
    finally { if (current(owner)) busy.value = false }
  }
  async function prepareImport(): Promise<void> {
    if (addingLibrary.value) return
    await chooseImport()
  }
  /** 添加入口共用库管理Owner：目录选择成功后沿原角色建议确认，扫描仍由Owner启动。 */
  async function addMusicLibrary(): Promise<boolean> {
    if (addingLibrary.value) { traceAdd('add.request', 'skipped', 'ADD_ALREADY_ACTIVE'); return false }
    if (pending.value || disposed || options.canChangeLibrary?.() === false) {
      const code = disposed ? 'ADD_CONTEXT_CHANGED' : pending.value ? 'ADD_PENDING' : 'ADD_CHANGE_BLOCKED'
      if (!disposed && !(pending.value && addFeedback.value?.phase === 'unconfirmed')) feedback('interrupted', code, '本次添加因当前操作状态中断，尚未登记新目录。请先核对进行中的操作。')
      traceAdd('add.request', 'skipped', code, performance.now()); return false
    }
    const owner = generation, started = performance.now()
    addingLibrary.value = true; error.value = ''; addContext = null; addStarted = started
    feedback('choosing', 'ADD_CHOOSING', '正在选择音乐文件夹…')
    traceAdd('add.request', 'start', 'ADD_CHOOSING')
    try {
      const preparation = await chooseImport()
      if (preparation.code !== 'ADD_CHOICE_READY') {
        const cancelled = preparation.code === 'ADD_PICKER_CANCELLED', failed = preparation.code === 'ADD_PREPARE_FAILED' || preparation.code === 'ADD_READ_FAILED'
        if (current(owner)) feedback(cancelled ? 'cancelled' : failed ? 'failed' : 'interrupted', preparation.code,
          cancelled ? '本次未收到文件夹选择结果，未添加音乐库，也未启动扫描。'
            : preparation.code === 'ADD_PREPARE_FAILED' ? importPreparationFailureMessage
            : failed ? '音乐库列表读取未完成，尚未提交添加确认；请重试读取。'
              : '本次添加因当前操作状态中断，尚未确认登记。原选择与已有音乐库保留。')
        traceAdd('add.request', cancelled ? 'cancelled' : failed ? 'error' : 'skipped', preparation.code)
        return false
      }
      const choice = preparation.choice
      traceAdd('add.selected', 'complete', 'ADD_CHOICE_READY')
      if (!current(owner) || locked.value || options.canChangeLibrary?.() === false) {
        const code = !current(owner) ? 'ADD_CONTEXT_CHANGED' : locked.value ? 'ADD_PENDING' : 'ADD_CHANGE_BLOCKED'
        if (current(owner)) feedback('interrupted', code, '文件夹已选择，添加因当前操作状态变化而中断。原选择已保留，尚未确认登记或扫描。')
        traceAdd('add.request', 'skipped', code); return false
      }
      role.value = choice.suggestedRole
      const accepted = await confirmImport()
      const commandId = addFeedback.value?.commandId
      if (current(owner) && commandId) {
        const original = operations.value.find(value => value.commandId === commandId)
        if (original) observeAddReceipt(original)
      }
      return accepted
    } finally { if (current(owner)) addingLibrary.value = false }
  }
  /** 原生drop只交付Main已经登记的候选；界面锁与代际不构成来源许可。 */
  function beginNativeImport():((choice:LocalLibraryImportChoice|null,failed?:boolean)=>boolean)|null {
    if(addingLibrary.value||pending.value||busy.value||disposed||!state.value||options.canChangeLibrary?.()===false)return null
    const owner=generation,datasetId=state.value.datasetId;let settled=false
    busy.value=true;error.value=''
    return (choice,failed=false)=>{
      if(settled)return false
      settled=true
      if(!current(owner))return false
      busy.value=false
      if(state.value?.datasetId!==datasetId||pending.value||options.canChangeLibrary?.()===false)return false
      if(failed||!isLocalLibraryManagementResult('library.import.prepare',choice,{})){error.value='拖入目录尚未确认，请重新选择目录。';return false}
      importChoice.value=choice?copy(choice):null
      if(choice)role.value=choice.suggestedRole
      return true
    }
  }
  function acceptOperation(value: LocalLibraryManagementOperation, commandId: string): void {
    if (value.commandId !== commandId) throw new Error('原库回执身份无效。')
    const order = originals.value.findIndex(original => original.payload.commandId === commandId)
    if (originals.value[order]?.command === 'library.remove' && value.kind !== 'library.remove') throw new Error('原移除回执身份无效。')
    const old = operations.value.find(v => v.commandId === commandId)
    if (old && !['unknown', 'running'].includes(old.state) && ['unknown', 'running'].includes(value.state)) return
    operations.value = [...operations.value.filter(v => v.commandId !== commandId), copy(value)]
    observeAddReceipt(value)
    observeRemoveReceipt(value)
    if (value.state === 'succeeded') {
      // 后来的明确添加解除对应隐藏；重复查询旧移除回执不能再次隐藏新库。
      if (value.kind === 'library.import.confirm' && state.value?.datasetId === removedDatasetId) {
        removedLibraries.value = removedLibraries.value.filter(item => item.order >= order || !value.libraryIds.includes(item.libraryId))
      }
      if (value.kind !== 'library.remove' || old?.state !== 'succeeded') options.onChanged?.()
    }
  }
  async function mutate<C extends LibraryMutation>(command: C, payload: LocalLibraryManagementPayloads[C]): Promise<boolean> {
    if (locked.value || disposed || !isLocalLibraryManagementPayload(command, payload)) return false
    const original = copy({ command, payload }) as OriginalMutation
    if (command === 'library.import.confirm' && addingLibrary.value) {
      addContext = { commandId: payload.commandId, label: importChoice.value?.label ?? '音乐文件夹', started: addStarted }
      feedback('confirming', 'ADD_CONFIRMING', '正在确认添加音乐文件夹…', payload.commandId)
      traceAdd('add.confirmation', 'start', 'ADD_CONFIRMING')
    }
    originals.value = [...originals.value, original]; writing.value = true; error.value = ''
    if (command === 'library.remove') {
      removeContext = { commandId: payload.commandId, datasetId: state.value?.datasetId ?? null, libraryIds: [...(payload as LocalLibraryManagementPayloads['library.remove']).libraryIds], order: originals.value.length - 1, started: performance.now(), applied: false }
      removalFeedback('removing', 'REMOVE_STARTED', '正在移除选中音乐库的本地记录，等待原操作回执…')
    }
    operations.value = [...operations.value, { commandId: payload.commandId, kind: command, state: 'unknown', libraryIds: 'libraryIds' in original.payload ? [...original.payload.libraryIds] : 'libraryId' in original.payload ? [original.payload.libraryId] : [], message: null }]
    try { const result = await request(command, payload); if (!disposed) acceptOperation(result, payload.commandId) }
    catch { if (!disposed) { fail(); if (command === 'library.remove') removalFeedback('unconfirmed', 'REMOVE_REQUEST_UNCONFIRMED', '移除结果尚未确认；原请求已保留，请查询原移除结果，不要重复提交。') } } finally { writing.value = false }
    const passed = operations.value.find(v => v.commandId === payload.commandId)?.state === 'succeeded'
    if (passed && command === 'library.import.confirm') importChoice.value = null
    if (passed) await read()
    return passed
  }
  async function confirmImport(): Promise<boolean> { if (locked.value || disposed) return false; return importChoice.value ? mutate('library.import.confirm', { commandId: id(), choiceId: importChoice.value.choiceId, role: role.value }) : false }
  async function rename(libraryId: string, name: string): Promise<boolean> { if (locked.value || disposed) return false; return mutate('library.rename', { commandId: id(), libraryId, name: name.trim() }) }
  async function remove(ids = selectedLibraryIds.value): Promise<boolean> { if (locked.value || disposed) return false; return mutate('library.remove', { commandId: id(), libraryIds: [...ids] }) }
  async function snapshot(libraryId: string, operation: 'load' | 'retry'): Promise<boolean> { if (locked.value || disposed) return false; return mutate(`library.snapshot.${operation}`, { commandId: id(), libraryId }) }
  async function watchLibrary(libraryId: string, enabled: boolean): Promise<boolean> { if (locked.value || disposed) return false; return mutate('library.watch.set', { commandId: id(), libraryId, enabled }) }
  async function readOriginal(commandId: string): Promise<void> {
    if (writing.value || !originals.value.some(v => v.payload.commandId === commandId) || disposed) return
    writing.value = true
    try {
      const value = await request('library.operation.read', { commandId })
      if (!disposed && value) acceptOperation(value, commandId)
      else if (!disposed && commandId === removeContext?.commandId && removeFeedback.value?.phase !== 'removed') removalFeedback('unconfirmed', 'REMOVE_QUERY_MISSING', '原移除结果尚未确认；原请求已保留，请稍后查询，不要重复提交。')
    } catch { if (!disposed) { fail(); if (commandId === removeContext?.commandId && removeFeedback.value?.phase !== 'removed') removalFeedback('unconfirmed', 'REMOVE_QUERY_UNCONFIRMED', '原移除结果暂时无法读取；原请求已保留，请稍后查询，不要重复提交。') } } finally { writing.value = false }
    if (!locked.value) await read()
  }
  async function readNameSettings(): Promise<boolean> {
    if (disposed) return false
    const owner = generation
    try {
      const next = await nameRequest('name.settings.read', {}); if (!current(owner)) return false
      const original = originalNameSave.value
      if (original && next.revision !== original.settings.expectedRevision && JSON.stringify({ ...nameInput(next), expectedRevision: original.settings.expectedRevision }) === JSON.stringify(original.settings)) originalNameSave.value = null
      const dirty = nameDirty.value
      settings.value = copy(next); if (!originalNameSave.value && (!dirty || original !== null)) settingsDraft.value = nameInput(next)
      if (!settingsDraft.value) settingsDraft.value = nameInput(next)
      return true
    } catch { if (current(owner)) fail(); return false }
  }
  function editName(next: LocalNameSettingsInput): void { if (!locked.value) settingsDraft.value = copy(next) }
  async function saveNameSettings(): Promise<boolean> {
    if (!settingsDraft.value || locked.value || disposed) return false
    const payload = Object.freeze({ commandId: id(), settings: copy(settingsDraft.value) })
    if (!isLocalNameSettingsPayload('name.settings.save', payload)) { error.value = '请核对端点和模型；端点不得含凭据、query或fragment，云端使用HTTPS。'; return false }
    originalNameSave.value = payload; writing.value = true
    try { const value = await nameRequest('name.settings.save', payload); if (!disposed) { settings.value = copy(value); settingsDraft.value = nameInput(value); originalNameSave.value = null } }
    catch { if (!disposed) fail() } finally { writing.value = false }
    return originalNameSave.value === null
  }
  async function configureCloudKey(): Promise<void> {
    if (locked.value || disposed) return
    writing.value = true
    try { const result = await nameRequest('name.settings.securityPrompt', { commandId: id(), backend: 'cloud' }); if (!disposed) notice.value = result.cancelled ? '已取消本地安全输入，原配置保留。' : result.configured ? '密钥已由Main本地保险库保管。' : '密钥未配置。' }
    catch { if (!disposed) fail() } finally { writing.value = false }
    await readNameSettings()
  }
  async function save(): Promise<boolean> {
    if (locked.value || importChoice.value) return false
    if (state.value && scanConcurrency.value !== state.value.scanConcurrency && !await mutate('library.settings.save', { commandId: id(), scanConcurrency: scanConcurrency.value })) return false
    if (nameDirty.value && !await saveNameSettings()) return false
    return !pending.value
  }
  async function discard(): Promise<boolean> {
    // 取消未知时只可重试同choice；普通写入/批次锁仍不能绕过。
    if (startingJob.value || ordinaryOperationLocked.value || disposed) return false
    if (importChoice.value || originalImportCancel.value) {
      const choice = importChoice.value, owner = generation, datasetId = state.value?.datasetId
      if (!choice || !datasetId) return false
      const original = originalImportCancel.value ?? { datasetId, choiceId: choice.choiceId }
      if (original.datasetId !== datasetId || original.choiceId !== choice.choiceId) { fail(); return false }
      originalImportCancel.value = original; writing.value = true; error.value = ''
      try {
        const released = await request('library.import.cancel', { choiceId: original.choiceId })
        if (!current(owner) || state.value?.datasetId !== original.datasetId || importChoice.value?.choiceId !== original.choiceId) return false
        if (released.choiceId !== original.choiceId || !released.released) { fail(); return false }
        importChoice.value = null; originalImportCancel.value = null
      } catch { if (current(owner)) fail(); return false } finally { writing.value = false }
    }
    if (originalJob.value && !batchDiscarded.value && ['partial', 'failed'].includes(job.value?.state ?? '')) {
      const original = originalJob.value, owner = generation, datasetId = state.value?.datasetId
      writing.value = true
      try {
        const value = await request('library.job.stop', { jobId: original.payload.commandId })
        if (!current(owner) || state.value?.datasetId !== datasetId || originalJob.value !== original
          || ['queued', 'running', 'unknown'].includes(value.state) || value.items.some(row => ['queued', 'running', 'unknown'].includes(row.state))) return false
        acceptJob(value, original.payload.commandId); batchDiscarded.value = true
      } catch { if (current(owner)) fail(); return false } finally { writing.value = false }
    }
    importChoice.value = null; scanConcurrency.value = state.value?.scanConcurrency ?? 12; settingsDraft.value = settings.value ? nameInput(settings.value) : null; return true
  }
  async function startAi(backend: LocalAiBackend, selectedAlbumIds?: readonly string[]): Promise<void> {
    const selected = selectedAlbumIds ? [...selectedAlbumIds] : null
    await prepareJob(captured => ({ command: 'library.ai.start', payload: { commandId: id(), captureId: captured.captureId, backend, selection: selected ? 'selected' : 'missing-cover', albumIds: selected ?? [] } }))
  }
  async function startCue(selections: readonly { albumId: string; cueId: string }[], outputFormat: string, target: LocalCueOutputTarget): Promise<void> {
    const selected = copy(selections), output = copy(target)
    await prepareJob(captured => ({ command: 'library.cue.start', payload: { commandId: id(), captureId: captured.captureId, selection: 'selected', selections: selected, outputFormat, target: output } }))
  }
  async function startAllCue(outputFormat: string, target: LocalCueOutputTarget): Promise<void> {
    const output = copy(target)
    await prepareJob(captured => ({ command: 'library.cue.start', payload: { commandId: id(), captureId: captured.captureId, selection: 'all-unsplit', selections: [], outputFormat, target: output } }))
  }
  function sameSelection(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every(value => b.includes(value))
  }
  async function prepareJob(makeOriginal: (captured: LocalLibraryCompleteCapture) => OriginalJob): Promise<void> {
    if (originalJob.value || pending.value || disposed || options.canChangeLibrary?.() === false) return
    const owner = generation, sequence = ++jobStartSequence, selection = selectionGeneration, expected = [...selectedLibraryIds.value]
    // 捕获也是本次启动的一部分；首个await前占位，双击不能创建第二个原命令。
    startingJob.value = true
    try {
      const captured = await captureLibraryIntent(expected, true, true)
      if (!captured || !current(owner) || sequence !== jobStartSequence || originalJob.value || operationLocked.value
        || selection !== selectionGeneration || !sameSelection(expected, selectedLibraryIds.value)
        || options.canChangeLibrary?.() === false) return
      await startJob(makeOriginal(captured))
    } finally { if (sequence === jobStartSequence) startingJob.value = false }
  }
  function observeJobUnknown(value: LocalLibraryBatchPage): void {
    // 当前页只确认本页原条目；读回其他页不能清掉已观察到的UNKNOWN。
    for (const row of value.items) { if (row.state === 'unknown') unknownAlbums.add(row.albumId); else unknownAlbums.delete(row.albumId) }
    unknownJob.value = value.state === 'unknown' || unknownAlbums.size > 0
  }
  function acceptJob(value: LocalLibraryBatchPage, expectedId: string): void {
    if (value.jobId !== expectedId || value.captureId !== originalJob.value?.payload.captureId) throw new Error('全库原任务身份无效。')
    job.value = copy(value); observeJobUnknown(value); jobOffset.value = value.offset
  }
  async function startJob(original: OriginalJob): Promise<void> {
    if (originalJob.value || operationLocked.value || disposed || !isLocalLibraryManagementPayload(original.command, original.payload)) return
    originalJob.value = copy(original); batchDiscarded.value = false; writing.value = true
    try { const value = original.command === 'library.ai.start' ? await request(original.command, original.payload) : await request(original.command, original.payload); if (!disposed) acceptJob(value, original.payload.commandId) }
    catch { if (!disposed) { unknownJob.value = true; fail() } } finally { writing.value = false }
  }
  async function jobAction(action: 'read' | 'stop' | 'resume' | 'retry', offset = jobOffset.value, failedIds?: readonly string[]): Promise<void> {
    const original = originalJob.value
    if (!original || writing.value || disposed) return
    if (action !== 'read' && (!job.value || unknownJob.value || job.value.state === 'unknown' || job.value.items.some(value => value.state === 'unknown'))) return
    if (action === 'resume' || action === 'retry') batchDiscarded.value = false
    const jobId = original.payload.commandId; writing.value = true
    try {
      const value = action === 'read' ? await request('library.job.read', { jobId, offset, limit: 200 })
        : action === 'retry' ? await request('library.job.retry', { jobId, albumIds: [...(failedIds ?? job.value?.items.filter(v => v.state === 'failed').map(v => v.albumId) ?? [])] })
          : await request(`library.job.${action}`, { jobId })
      if (!disposed && value) acceptJob(value, jobId)
    } catch { if (!disposed) fail() } finally { writing.value = false }
  }
  async function retryAllFailed(): Promise<void> {
    const original = originalJob.value, previous = job.value
    if (!original || !previous || writing.value || unknownJob.value || ['queued', 'running', 'unknown'].includes(previous.state) || !previous.failedAlbums || disposed) return
    writing.value = true; error.value = ''
    batchDiscarded.value = false
    try {
      const failed: string[] = [], seen = new Set<string>(), total = previous.totalAlbums
      if (total > 10000) throw new Error('库任务超过单次恢复资格。')
      for (let offset = 0; offset < total; offset += 200) {
        const page = await request('library.job.read', { jobId: original.payload.commandId, offset, limit: 200 })
        if (disposed) return
        if (page?.jobId === original.payload.commandId && page.captureId === original.payload.captureId && page.state === 'unknown') unknownJob.value = true
        if (!page || page.jobId !== original.payload.commandId || page.captureId !== original.payload.captureId || page.offset !== offset || page.totalAlbums !== total
          || ['queued', 'running', 'unknown'].includes(page.state) || page.items.length === 0) throw new Error('原任务读取尚未确认。')
        for (const row of page.items) { if (seen.has(row.albumId)) throw new Error('原任务分页重复。'); seen.add(row.albumId); if (row.state === 'failed') failed.push(row.albumId) }
        observeJobUnknown(page)
      }
      if (seen.size !== total || failed.length !== previous.failedAlbums) throw new Error('原失败集合尚未完整确认。')
      if (unknownJob.value) throw new Error('原任务仍有UNKNOWN，只能读取原条目，不能重试其他失败。')
      const next = await request('library.job.retry', { jobId: original.payload.commandId, albumIds: failed })
      if (!disposed) acceptJob(next, original.payload.commandId)
    } catch { if (!disposed) fail() } finally { writing.value = false }
  }
  function newBatch(): void {
    if (locked.value || !job.value || job.value.state !== 'complete') return
    originalJob.value = null; job.value = null; jobOffset.value = 0; capture.value = null
  }
  function dispose(): void { disposed = true; generation++ }
  return { state, capture, selectedLibraryIds, importChoice, role, operations, originals, job, originalJob, jobOffset,
    settings, settingsDraft, originalNameSave, scanConcurrency, nameDirty, busy, readFailed, writing, addingLibrary, addFeedback, removeFeedback, confirmedRemovedLibraryIds, error, notice, pending, locked, selectionLocked, unresolved,
    read, selectLibrary, selectLibraries, selectLibraryAt, captureLibraries, prepareImport, addMusicLibrary, beginNativeImport, confirmImport, rename, remove, snapshot, watchLibrary, readOriginal,
    readNameSettings, editName, saveNameSettings, configureCloudKey, save, discard, startAi, startCue, startAllCue, jobAction, retryAllFailed, newBatch, dispose }
}
export type LocalWorkbenchLibrary = ReturnType<typeof useLocalWorkbenchLibrary>
