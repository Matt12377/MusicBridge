import { computed, reactive, ref, shallowRef } from 'vue'
import {
  LOCAL_ORGANIZER_FIELDS, isCollectionId, isCommandOutboxOverview, isLocalOrganizerCommandResult,
  isLocalOrganizerPatch, isLocalOrganizerPlan, isLocalOrganizerTarget,
  type AlbumEdition, type ChangeLocalOrganizer, type CommandOutboxOverview, type CommandOutboxPublicApi,
  type ConfirmLocalOrganizer, type LocalGroupingSuggestion, type LocalMetadata, type LocalMetadataAnnotations,
  type LocalOrganizerCommandResults, type LocalOrganizerItem, type LocalOrganizerPatch, type LocalOrganizerPlan,
  type LocalOrganizerPublicApi, type LocalOrganizerState, type LocalOrganizerTarget, type PreviewLocalOrganizer,
} from '@music-bridge/contracts'

export type OrganizerDraftAction = 'keep' | 'set' | 'clear'
type Field = typeof LOCAL_ORGANIZER_FIELDS[number]
type PendingKind = 'preview' | 'confirm' | 'undo' | 'cancel'
interface Pending {
  kind: PendingKind; request: PreviewLocalOrganizer | ConfirmLocalOrganizer | ChangeLocalOrganizer;
  planId: string; originPlanId: string | null; datasetId: string; targetKey: string;
  terminal: 'succeeded' | 'rejected' | null; uncertain: boolean; invalidated: boolean;
}
interface Options {
  api: LocalOrganizerPublicApi & Partial<Pick<CommandOutboxPublicApi, 'getCommandOutbox'>>
  onApplied?: () => void
}
export const organizerStateLabels: Record<LocalOrganizerState, string> = {
  DRAFT: '待保存预览', BLOCKED: '当前不可保存', CONFIRMED: '已确认，等待处理', EXECUTING: '正在处理',
  COMPLETED: '已完成', PARTIAL: '部分完成', FAILED: '未完成', CANCELLED: '已取消',
  RECOVERY_REQUIRED: '需要核对恢复', ROLLED_BACK: '已撤销',
}
export function organizerIssueMessage(issue: string | null): string {
  if (!issue) return ''
  if (issue === 'PLAN_EXPIRED') return '预览已过期，请按当前信息重新预览。'
  if (issue === 'SOURCE_FILES_WRITE_OFF') return '此文件计划目前不可执行。'
  if (issue === 'CONFIRMATION_INTERRUPTED') return '处理曾被中断，请先核对逐项结果，再决定是否保存。'
  if (issue.includes('TIMEOUT')) return '读取未能在本次等待内完成，原信息保留，请重新读取核对。'
  return '信息、目录许可或计划状态已改变，请核对当前结果后重新预览。'
}
export function organizerValue(value: string | undefined, absent = '未提供'): string {
  return value === undefined ? absent : value === '' ? '空值' : value
}
export function organizerEffective(item: LocalOrganizerItem, field: Field, after = false): string | undefined {
  const fields = after ? item.after.fields : item.before.fields
  return Object.hasOwn(fields, field) ? fields[field] : item.raw[field]
}
function immutable<T>(value: T): T {
  const copy = structuredClone(value)
  const freeze = (item: unknown): void => {
    if (item && typeof item === 'object') { Object.values(item).forEach(freeze); Object.freeze(item) }
  }
  freeze(copy); return copy
}
const keyOf = (target: LocalOrganizerTarget | null) => target ? JSON.stringify(target.mode === 'batch' ? { ...target, trackIds: [...target.trackIds].sort() } : target) : ''
const cancellable = (plan: LocalOrganizerPlan) => ['DRAFT', 'BLOCKED', 'CONFIRMED', 'RECOVERY_REQUIRED'].includes(plan.state)
const finalState = (plan: LocalOrganizerPlan) => ['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED', 'ROLLED_BACK'].includes(plan.state)

/** 只保存局部意图；计划与逐项事实来自原作者，关闭或重开不会重发未知业务。 */
export function useLocalOrganizer(options: Options) {
  const isOpen = ref(false), view = ref<'edit' | 'preview' | 'history'>('edit')
  const target = shallowRef<LocalOrganizerTarget | null>(null), targetLabel = ref(''), editions = shallowRef<AlbumEdition[]>([])
  const plan = shallowRef<LocalOrganizerPlan | null>(null), error = ref(''), notice = ref('')
  const loading = ref(false), previewing = ref(false), confirming = ref(false), undoing = ref(false), cancelling = ref(false)
  const fields = reactive(Object.fromEntries(LOCAL_ORGANIZER_FIELDS.map(field => [field, { action: 'keep' as OrganizerDraftAction, value: '' }])) as Record<Field, { action: OrganizerDraftAction; value: string }>)
  const annotations = reactive({ versionAction: 'keep' as OrganizerDraftAction, versionDescription: '', groupingAction: 'keep' as OrganizerDraftAction, groupingSuggestions: [] as LocalGroupingSuggestion[] })
  const history = shallowRef<LocalOrganizerCommandResults['localOrganizer.history']>({ offset: 0, limit: 20, total: 0, items: [] })
  const historyLoaded = ref(false), refreshedPlans = new Set<string>()
  const pending = shallowRef<Pending[]>([]), appliedCount = ref(0), datasetChanged = ref(false)
  let datasetId: string | null = null, generation = 0, readGeneration = 0, draftGeneration = 0, previewGeneration = 0, disposed = false
  const busy = computed(() => loading.value || previewing.value || confirming.value || undoing.value || cancelling.value)
  const unknown = computed(() => pending.value.some(item => item.uncertain))
  const draftLocked = computed(() => confirming.value || undoing.value || cancelling.value || unknown.value || datasetChanged.value)
  const canPreview = computed(() => !!target.value && !busy.value && !pending.value.length && !datasetChanged.value && isLocalOrganizerPatch(makePatch()))
  const canConfirm = computed(() => !!plan.value && view.value === 'preview' && !busy.value && !pending.value.length && !datasetChanged.value
    && plan.value.scope === 'MB_ONLY' && ['DRAFT', 'RECOVERY_REQUIRED'].includes(plan.value.state) && Date.parse(plan.value.expiresAt) > Date.now())
  const canUndo = computed(() => !!plan.value && plan.value.scope === 'MB_ONLY' && plan.value.state === 'COMPLETED' && !busy.value && !pending.value.length && !datasetChanged.value)
  // 取消允许在confirm等待中读取最新计划；不能用本地DRAFT修订猜测服务器CONFIRMED修订。
  const canCancel = computed(() => !!plan.value && cancellable(plan.value) && !loading.value && !undoing.value && !cancelling.value && !datasetChanged.value
    && !pending.value.some(item => item.kind === 'preview' || item.kind === 'undo' || item.kind === 'cancel'))
  const current = (scope: number) => !disposed && isOpen.value && scope === generation
  const unknownMessage = '结果未确认，原请求已保留。请重新读取核对或查看未确认操作；不会自动重发。'

  function makePatch(): LocalOrganizerPatch {
    const patch: LocalOrganizerPatch = { fields: {} }
    for (const field of LOCAL_ORGANIZER_FIELDS) {
      const draft = fields[field]
      if (draft.action === 'set') patch.fields[field] = { action: 'set', value: draft.value }
      else if (draft.action === 'clear') patch.fields[field] = { action: 'clear' }
    }
    const extra: NonNullable<LocalOrganizerPatch['annotations']> = {}
    if (annotations.versionAction === 'set') extra.versionDescription = { action: 'set', value: annotations.versionDescription }
    else if (annotations.versionAction === 'clear') extra.versionDescription = { action: 'clear' }
    if (annotations.groupingAction === 'set') extra.groupingSuggestions = { action: 'set', value: annotations.groupingSuggestions.map(item => ({ ...item })) }
    else if (annotations.groupingAction === 'clear') extra.groupingSuggestions = { action: 'clear' }
    if (Object.keys(extra).length) patch.annotations = extra
    return patch
  }
  function invalidate(): void {
    draftGeneration++; previewGeneration++; previewing.value = false
    for (const binding of pending.value) if (binding.kind === 'preview') binding.invalidated = true
    if (plan.value && view.value === 'preview') { plan.value = null; view.value = 'edit'; notice.value = '草稿已改变，请重新预览具体更正。' }
    if (!unknown.value) error.value = ''
  }
  function setFieldAction(field: Field, action: OrganizerDraftAction): void { if (draftLocked.value) return; fields[field].action = action; invalidate() }
  function setFieldValue(field: Field, value: string): void { if (draftLocked.value) return; fields[field].value = value; invalidate() }
  function setVersionAction(action: OrganizerDraftAction): void { if (draftLocked.value) return; annotations.versionAction = action; invalidate() }
  function setVersionDescription(value: string): void { if (draftLocked.value) return; annotations.versionDescription = value; invalidate() }
  function setGroupingAction(action: OrganizerDraftAction): void { if (draftLocked.value) return; annotations.groupingAction = action; invalidate() }
  function setGroupingSuggestions(values: LocalGroupingSuggestion[]): void { if (draftLocked.value) return; annotations.groupingSuggestions = values.map(value => ({ ...value })); invalidate() }
  function removePending(binding: Pending): void { pending.value = pending.value.filter(value => value !== binding) }
  function receive(value: unknown, expectedId: string): LocalOrganizerPlan {
    if (!isLocalOrganizerPlan(value) || value.planId !== expectedId || datasetId !== null && value.datasetId !== datasetId) throw new Error('整理计划身份不一致')
    datasetId ??= value.datasetId
    return value
  }
  function markTerminals(overview: CommandOutboxOverview): void {
    if (!isCommandOutboxOverview(overview) || overview.datasetId !== datasetId) return
    for (const binding of pending.value) {
      if (binding.datasetId !== overview.datasetId || !['confirm', 'undo'].includes(binding.kind)) continue
      const entry = overview.entries.find(value => value.datasetId === binding.datasetId && value.commandId === binding.request.commandId && value.command === `localOrganizer.${binding.kind}`)
      if (entry?.state === 'succeeded' || entry?.state === 'rejected') binding.terminal = entry.state
    }
  }
  async function captureDataset(scope: number): Promise<string> {
    if (options.api.getCommandOutbox) {
      const overview = await options.api.getCommandOutbox()
      if (!current(scope)) throw new Error('读取上下文已关闭')
      if (!isCommandOutboxOverview(overview)) throw new Error('工作库身份未确认')
      datasetId ??= overview.datasetId; datasetChanged.value = overview.datasetId !== datasetId
      if (datasetChanged.value) throw new Error('工作库已变化')
      markTerminals(overview)
    }
    if (!datasetId) throw new Error('工作库身份尚未就绪')
    return datasetId
  }
  function notifyApplied(value: LocalOrganizerPlan): void {
    const key = `${value.planId}:${value.revision}`
    if (!value.results.some(item => item.state === 'applied') || refreshedPlans.has(key)) return
    refreshedPlans.add(key)
    appliedCount.value++
    try { options.onApplied?.() } catch { notice.value = '更正已保存，列表刷新暂未完成，请重新读取。' }
  }
  function showPlan(value: LocalOrganizerPlan): void {
    if (plan.value?.planId === value.planId && BigInt(value.revision) < BigInt(plan.value.revision)) return
    plan.value = value; view.value = 'preview'
    notice.value = organizerStateLabels[value.state]
    error.value = organizerIssueMessage(value.issue)
  }
  function requestedTarget(value: LocalOrganizerPlan, selection: LocalOrganizerTarget): boolean {
    return selection.mode === 'single' ? value.items.length === 1 && value.items[0]?.trackId === selection.trackId
      : selection.mode === 'batch' ? value.items.length === selection.trackIds.length && value.items.every(item => selection.trackIds.includes(item.trackId))
        : value.editionBindings.some(item => item.editionId === selection.editionId)
  }
  async function open(selection: LocalOrganizerTarget, label = '', choices: AlbumEdition[] = [], defaults: LocalMetadata = {}, extra: LocalMetadataAnnotations = {}): Promise<void> {
    if (disposed || !isLocalOrganizerTarget(selection)) return
    generation++; readGeneration++; previewGeneration++; draftGeneration++
    const scope = generation
    isOpen.value = true; view.value = 'edit'; target.value = immutable(selection); targetLabel.value = label; editions.value = choices.map(value => ({ ...value })); plan.value = null
    error.value = ''; notice.value = ''; loading.value = false; previewing.value = false
    for (const field of LOCAL_ORGANIZER_FIELDS) { fields[field].action = 'keep'; fields[field].value = defaults[field] ?? '' }
    annotations.versionAction = 'keep'; annotations.versionDescription = extra.versionDescription ?? ''; annotations.groupingAction = 'keep'; annotations.groupingSuggestions = extra.groupingSuggestions?.map(value => ({ ...value })) ?? []
    try { await captureDataset(scope); if (current(scope) && pending.value.some(binding => binding.targetKey === keyOf(selection))) await reconcile() }
    catch { if (current(scope)) error.value = datasetChanged.value ? '工作库已变化，请返回原工作库核对，原请求与选择保留。' : '暂时无法核对工作库，请重新读取；尚未派发更正。' }
  }
  async function preview(): Promise<void> {
    if (!canPreview.value || !isOpen.value || !target.value) return
    const scope = generation, draft = draftGeneration, reading = ++previewGeneration, selection = target.value, patch = makePatch()
    previewing.value = true; error.value = ''; notice.value = ''
    let binding: Pending | null = null
    try {
      const owner = await captureDataset(scope); if (!current(scope) || draft !== draftGeneration) return
      const request = immutable<PreviewLocalOrganizer>({ commandId: crypto.randomUUID(), scope: 'MB_ONLY', target: selection, patch })
      binding = { kind: 'preview', request, planId: request.commandId, originPlanId: null, datasetId: owner, targetKey: keyOf(selection), terminal: null, uncertain: false, invalidated: false }; pending.value = [...pending.value, binding]
      const result = receive(await options.api.previewLocalOrganizer(request), request.commandId)
      if (result.scope !== 'MB_ONLY' || !requestedTarget(result, selection)) throw new Error('预览范围不一致')
      removePending(binding)
      if (current(scope) && draft === draftGeneration && reading === previewGeneration) showPlan(result)
    } catch {
      if (binding && pending.value.includes(binding)) { binding.uncertain = true; pending.value = [...pending.value]; if (current(scope)) error.value = unknownMessage }
      else if (current(scope)) error.value = '暂时无法核对工作库，尚未派发预览。'
    } finally { if (current(scope) && reading === previewGeneration) previewing.value = false }
  }
  async function save(): Promise<void> {
    if (!canConfirm.value || !plan.value || !isOpen.value) return
    if (Date.parse(plan.value.expiresAt) <= Date.now()) { error.value = organizerIssueMessage('PLAN_EXPIRED'); return }
    const original = plan.value, scope = generation
    confirming.value = true; error.value = ''; notice.value = ''; readGeneration++
    let binding: Pending | null = null
    try {
      const owner = await captureDataset(scope); if (!current(scope) || plan.value?.planId !== original.planId) return
      const request = immutable<ConfirmLocalOrganizer>({ commandId: crypto.randomUUID(), planId: original.planId, expectedRevision: original.revision, scope: original.scope, planHash: original.planHash, contextFingerprint: original.contextFingerprint })
      binding = { kind: 'confirm', request, planId: original.planId, originPlanId: original.planId, datasetId: owner, targetKey: keyOf(target.value), terminal: null, uncertain: false, invalidated: false }; pending.value = [...pending.value, binding]
      const result = receive(await options.api.confirmLocalOrganizer(request), original.planId)
      if (result.planHash !== request.planHash || result.contextFingerprint !== request.contextFingerprint || result.scope !== request.scope) throw new Error('保存回执与预览不一致')
      removePending(binding); notifyApplied(result)
      if (current(scope) && plan.value?.planId === original.planId) showPlan(result)
    } catch {
      if (binding && pending.value.includes(binding)) { binding.uncertain = true; pending.value = [...pending.value]; if (current(scope)) error.value = unknownMessage }
      else if (current(scope)) error.value = '工作库暂时无法核对，尚未派发保存。'
    } finally { confirming.value = false }
  }
  async function previewUndo(): Promise<void> {
    if (!canUndo.value || !plan.value || !isOpen.value) return
    const original = plan.value, scope = generation
    undoing.value = true; error.value = ''; notice.value = ''; readGeneration++
    let binding: Pending | null = null
    try {
      const owner = await captureDataset(scope); if (!current(scope) || plan.value?.planId !== original.planId) return
      const request = immutable<ChangeLocalOrganizer>({ commandId: crypto.randomUUID(), planId: original.planId, expectedRevision: original.revision })
      binding = { kind: 'undo', request, planId: request.commandId, originPlanId: original.planId, datasetId: owner, targetKey: keyOf(target.value), terminal: null, uncertain: false, invalidated: false }; pending.value = [...pending.value, binding]
      const result = receive(await options.api.undoLocalOrganizer(request), request.commandId)
      if (result.undoOf !== original.planId || result.scope !== 'MB_ONLY') throw new Error('撤销预览身份不一致')
      removePending(binding)
      if (current(scope) && plan.value?.planId === original.planId) { showPlan(result); notice.value = '这是撤销预览，保存后才恢复此前的人工信息。' }
    } catch {
      if (binding && pending.value.includes(binding)) { binding.uncertain = true; pending.value = [...pending.value]; if (current(scope)) error.value = unknownMessage }
      else if (current(scope)) error.value = '暂时无法核对撤销范围，尚未派发撤销预览。'
    } finally { undoing.value = false }
  }
  async function cancelPlan(): Promise<void> {
    if (!canCancel.value || !plan.value || !isOpen.value) return
    const originalId = plan.value.planId, scope = generation
    cancelling.value = true; error.value = ''; notice.value = ''
    let binding: Pending | null = null
    try {
      const owner = await captureDataset(scope), latest = receive(await options.api.getLocalOrganizerPlan({ planId: originalId }), originalId)
      if (!current(scope) || plan.value?.planId !== originalId) return
      showPlan(latest)
      if (!cancellable(latest)) { notice.value = '当前结果已确定，不能取消已提交的更正。'; return }
      const request = immutable<ChangeLocalOrganizer>({ commandId: crypto.randomUUID(), planId: latest.planId, expectedRevision: latest.revision })
      binding = { kind: 'cancel', request, planId: latest.planId, originPlanId: latest.planId, datasetId: owner, targetKey: keyOf(target.value), terminal: null, uncertain: false, invalidated: false }; pending.value = [...pending.value, binding]
      const result = receive(await options.api.cancelLocalOrganizer(request), latest.planId)
      removePending(binding)
      if (finalState(result)) pending.value = pending.value.filter(value => value.kind !== 'confirm' || value.planId !== originalId)
      if (current(scope) && plan.value?.planId === originalId) showPlan(result)
    } catch {
      if (binding && pending.value.includes(binding)) { binding.uncertain = true; pending.value = [...pending.value]; if (current(scope)) error.value = unknownMessage }
      else if (current(scope)) error.value = '计划状态暂时无法核对，尚未派发取消。'
    } finally { cancelling.value = false }
  }
  async function loadPlan(planId: string): Promise<void> {
    if (!isCollectionId(planId) || !isOpen.value || disposed) return
    const scope = generation, reading = ++readGeneration; loading.value = true; error.value = ''
    try {
      await captureDataset(scope); const value = receive(await options.api.getLocalOrganizerPlan({ planId }), planId)
      if (current(scope) && reading === readGeneration) { showPlan(value); if (pending.value.length) error.value = unknownMessage }
    } catch { if (current(scope) && reading === readGeneration) error.value = datasetChanged.value ? '工作库已变化，旧整理请求保留，请返回原工作库核对。' : '计划暂时无法读取，保留上次成功结果，请重新读取。' }
    finally { if (current(scope) && reading === readGeneration) loading.value = false }
  }
  async function loadHistory(offset = 0): Promise<void> {
    if (!isOpen.value || disposed || !Number.isSafeInteger(offset) || offset < 0) return
    const scope = generation, reading = ++readGeneration; loading.value = true; error.value = ''
    try {
      await captureDataset(scope); const value = await options.api.listLocalOrganizerHistory({ offset, limit: 20 })
      if (!isLocalOrganizerCommandResult('localOrganizer.history', value) || value.offset !== offset || value.limit !== 20) throw new Error('整理历史分页不一致')
      if (current(scope) && reading === readGeneration) { history.value = value; historyLoaded.value = true; view.value = 'history' }
    } catch { if (current(scope) && reading === readGeneration) error.value = datasetChanged.value ? '工作库已变化，请返回原工作库读取历史。' : '整理历史暂时无法读取，原记录保留，请重试。' }
    finally { if (current(scope) && reading === readGeneration) loading.value = false }
  }
  async function openHistory(): Promise<void> {
    if (disposed) return
    generation++; readGeneration++; previewGeneration++; isOpen.value = true; target.value = null; targetLabel.value = '已保存的整理记录'; view.value = 'history'; plan.value = null; notice.value = ''; error.value = ''; previewing.value = false
    await loadHistory()
  }
  async function reconcile(): Promise<void> {
    if (!isOpen.value || disposed || loading.value || cancelling.value) return
    const scope = generation, reading = ++readGeneration; loading.value = true
    try {
      await captureDataset(scope)
      const originals = [...pending.value]
      for (const binding of originals) {
        if (!current(scope) || reading !== readGeneration || binding.datasetId !== datasetId) return
        if (binding.kind === 'preview' && !binding.uncertain) continue
        let value: LocalOrganizerPlan
        try { value = receive(await options.api.getLocalOrganizerPlan({ planId: binding.planId }), binding.planId) } catch { continue }
        if (binding.kind === 'preview' && (value.scope !== 'MB_ONLY' || !requestedTarget(value, (binding.request as PreviewLocalOrganizer).target))
          || binding.kind === 'undo' && (value.undoOf !== binding.originPlanId || value.scope !== 'MB_ONLY')
          || binding.kind === 'confirm' && (value.planHash !== (binding.request as ConfirmLocalOrganizer).planHash || value.contextFingerprint !== (binding.request as ConfirmLocalOrganizer).contextFingerprint || value.scope !== (binding.request as ConfirmLocalOrganizer).scope)) continue
        const completed = binding.kind === 'preview' || binding.kind === 'cancel' && value.state === 'CANCELLED' || binding.kind === 'undo' && value.undoOf === binding.originPlanId || binding.terminal !== null || binding.kind === 'confirm' && finalState(value)
        if (completed) { removePending(binding); if (binding.kind === 'confirm') notifyApplied(value) }
        const visible = plan.value?.planId === binding.planId || plan.value?.planId === binding.originPlanId || binding.targetKey !== '' && binding.targetKey === keyOf(target.value)
        if (visible && current(scope) && !binding.invalidated) { showPlan(value); if (binding.terminal === 'rejected') error.value = '原操作已被拒绝，请核对当前计划后重新预览；没有重发原请求。' }
        else if (binding.invalidated && current(scope) && completed) notice.value = '旧预览已核对，当前草稿保留，请重新预览。'
      }
      if (!originals.length && plan.value) {
        const id = plan.value.planId, value = receive(await options.api.getLocalOrganizerPlan({ planId: id }), id)
        if (current(scope) && reading === readGeneration && plan.value?.planId === id) showPlan(value)
      }
      if (current(scope) && pending.value.length) error.value = unknownMessage
    } catch { if (current(scope)) error.value = datasetChanged.value ? '工作库已变化，请返回原工作库核对，原请求保留。' : '当前结果暂时无法核对，请重新读取；原请求保留。' }
    finally { if (current(scope) && reading === readGeneration) loading.value = false }
  }
  function observeOutbox(overview: CommandOutboxOverview): void {
    if (disposed || !isCommandOutboxOverview(overview) || overview.datasetId !== datasetId) return
    markTerminals(overview)
    if (isOpen.value && pending.value.some(binding => binding.terminal !== null)) void reconcile()
  }
  function edit(): void { if (!draftLocked.value && target.value) { readGeneration++; loading.value = false; view.value = 'edit'; plan.value = null; notice.value = '' } }
  function close(): void { generation++; readGeneration++; previewGeneration++; isOpen.value = false; loading.value = false; previewing.value = false }
  function dispose(): void { close(); disposed = true }
  return { isOpen, view, target, targetLabel, editions, plan, fields, annotations, history, historyLoaded, pending, appliedCount, error, notice,
    stateLabels: organizerStateLabels, formatValue: organizerValue, effectiveValue: organizerEffective, issueMessage: organizerIssueMessage,
    loading, previewing, confirming, undoing, cancelling, busy, unknown, draftLocked, datasetChanged, canPreview, canConfirm, canUndo, canCancel,
    makePatch, setFieldAction, setFieldValue, setVersionAction, setVersionDescription, setGroupingAction, setGroupingSuggestions,
    open, preview, save, previewUndo, cancelPlan, loadPlan, loadHistory, openHistory, reconcile, observeOutbox, edit, close, dispose }
}
