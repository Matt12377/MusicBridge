import { computed, reactive, ref, shallowRef } from 'vue'
import * as dto from '@music-bridge/contracts'
import { sourceWriteRequestFingerprint } from '../../../../shared/source-write-fingerprint.js'

type DraftAction = 'keep' | 'set' | 'remove'
type Mutation = dto.PreviewLocalSourceWrites | dto.ConfirmLocalSourceWrites | dto.UndoLocalSourceWrites | dto.CancelLocalSourceWrites | dto.SetLocalSourceWritesPolicy
type Pending = { command: dto.LocalSourceWritesReceiptCommand; request: Mutation | { datasetId: string; commandId: string }; fingerprint: string; generation: number; draft: number; invalidated: boolean }
interface Options { api: Partial<dto.LocalSourceWritesPublicApi> & Partial<Pick<dto.CommandOutboxPublicApi, 'getCommandOutbox'>>; onApplied?: () => void }
const terminal = (state: dto.LocalSourceWritesState) => ['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED', 'BLOCKED', 'RECOVERY_REQUIRED'].includes(state)
export const sourceWriteStateLabels: Record<dto.LocalSourceWritesState, string> = { PREVIEWING: '正在核验预览', READY: '具体预览可确认', BLOCKED: '当前不可写入', QUEUED: '已受理，等待处理', RUNNING: '正在处理文件', COMPLETED: '逐项核验完成', PARTIAL: '部分完成', FAILED: '未完成', CANCEL_REQUESTED: '正在安全收尾', CANCELLED: '已取消', RECOVERY_REQUIRED: '需要核对恢复' }
export const sourceWriteRangeLabels: Record<dto.LocalSourceWritesRange, string> = { TAGS: '源标签', EMBEDDED_COVER: '音频内嵌封面', DIRECTORY_COVER: '目录封面' }
export function sourceWriteIssueMessage(issue: dto.LocalSourceWritesIssue | null): string {
  if (!issue) return ''
  const labels: Partial<Record<dto.LocalSourceWritesIssue, string>> = {
    POLICY_DISABLED: '源文件写入开关已关闭，请在应用设置中开启后重新预览。', POLICY_CHANGED: '写入设置已改变，请重新预览。', POLICY_DRAINING: '已有任务正在安全收尾，请稍后读取。', PLAN_EXPIRED: '预览已过期，请重新预览。',
    ARTWORK_UNAVAILABLE: '原图尚未留存，请从原选图入口重新取得并保存 MB 封面。', ARTWORK_CHANGED: '所选封面已改变，请重新读取并预览。',
    UNSUPPORTED_FORMAT: '此源格式不支持写入；原播放与只读信息保留。', UNSUPPORTED_TAGS: '此文件的标签结构不支持安全写入。', FORMAT_NOT_QUALIFIED: '此格式写入尚未通过准入。', INSUFFICIENT_PADDING: '原标签区域空间不足，不能在保留音频位置的条件下写入。',
    FROZEN_SOURCE: '此文件被已冻结制作引用，不能写入。', ACTIVE_READER: '此文件正在播放或被读取，请结束读取后重新预览。', SOURCE_OFFLINE: '源目录离线，请先恢复目录。', SOURCE_REVOKED: '源目录许可已撤销。', SOURCE_CHANGED: '源文件已变化，请重新读取。', UNKNOWN_PROTECTION: '文件保护状态尚未核实，不能写入。',
    RECOVERY_REQUIRED: '需要核对逐项保全状态，再选择具体恢复预览。', COMMIT_UNKNOWN: '文件与本地事实提交结果尚未核实。', REPLACEMENT_UNKNOWN: '发布结果尚未核实，保全文件仍保留。', RELEASE_UNKNOWN: '保护释放结果尚未核实。', UNDO_CONFLICT: '当前文件不再等于原写入结果，不能直接撤销。', NOT_FOUND: '暂未找到原请求记录；不会重发。',
    BUDGET_EXCEEDED: '本次材料或计划超过安全预算，请缩小选择。', SEGMENTED_SOURCE: '分段源文件不支持写入。', HARD_LINKED_SOURCE: '此源文件有多个硬链接，不能安全写入。', SHARED_RESOURCE_UNKNOWN: '共享此文件的目标尚未完整核实。',
  }
  return labels[issue] ?? '文件、许可或具体计划状态已变化，请重新读取逐项结果。'
}
const apiNames = ['previewLocalSourceWrites', 'getLocalSourceWrites', 'listLocalSourceWritesHistory', 'confirmLocalSourceWrites', 'undoLocalSourceWrites', 'cancelLocalSourceWrites', 'setLocalSourceWritesPolicy'] as const

/** 关闭、换对象与迟到回执都不重派；接受回执仅触发持久状态读取。 */
export function useLocalSourceWrites(options: Options) {
  const capable = apiNames.every(name => typeof options.api[name] === 'function')
  const isOpen = ref(false), view = ref<'edit' | 'plan' | 'history'>('edit'), targetLabel = ref('')
  const target = shallowRef<dto.LocalSourceWritesTarget | null>(null), context = shallowRef<dto.LocalSourceWritesContext | null>(null), plan = shallowRef<dto.LocalSourceWritesPlan | null>(null)
  const range = ref<dto.LocalSourceWritesRange>('TAGS'), fileName = ref<'cover.jpg' | 'cover.png'>('cover.jpg'), editionId = ref('')
  const fields = reactive(Object.fromEntries(dto.LOCAL_SOURCE_WRITES_FIELDS.map(key => [key, { action: 'keep' as DraftAction, value: '' }])) as Record<dto.LocalSourceWritesField, { action: DraftAction; value: string }>)
  const loading = ref(false), previewing = ref(false), confirming = ref(false), undoing = ref(false), cancelling = ref(false), policyBusy = ref(false)
  const error = ref(''), notice = ref(''), contextFailed = ref(false), historyLoaded = ref(false), datasetChanged = ref(false)
  const history = shallowRef<dto.LocalSourceWritesPlanSummary[]>([]), historyCursor = ref<string | null>(null)
  const events = shallowRef<dto.LocalSourceWritesHistoryEvent[]>([]), eventCursor = ref<string | null>(null), eventsLoaded = ref(false)
  const pending = shallowRef<Pending[]>([]), dataset = ref<string | null>(null), observedAt = ref(Date.now())
  let generation = 0, draft = 0, readSequence = 0, disposed = false, timer: ReturnType<typeof setTimeout> | undefined
  const appliedViews = new Map<string, string>()
  const resolvedCommands = new Set<string>()
  const busy = computed(() => loading.value || previewing.value || confirming.value || undoing.value || cancelling.value || policyBusy.value)
  const unknown = computed(() => pending.value.length > 0)
  const locked = computed(() => confirming.value || undoing.value || cancelling.value || policyBusy.value || pending.value.some(item => item.command !== 'localSourceWrites.preview') || datasetChanged.value || !!plan.value && !terminal(plan.value.state) && !['READY', 'PREVIEWING'].includes(plan.value.state))
  const selectedMaterial = computed(() => context.value?.materials.find(value => value.editionId === editionId.value && value.availability === 'available') ?? null)
  const canPreview = computed(() => capable && !!target.value && !!context.value && !contextFailed.value && !!dataset.value && !busy.value && !unknown.value && !datasetChanged.value && dto.isLocalSourceWritesIntent(intent()))
  const planExpired = computed(() => !!plan.value && plan.value.state === 'READY' && Date.parse(plan.value.expiresAt ?? '') <= observedAt.value)
  const canConfirm = computed(() => !busy.value && !unknown.value && !datasetChanged.value && !!context.value?.policy.enabled && !context.value.policy.draining && !!plan.value && plan.value.state === 'READY' && !planExpired.value && plan.value.planHash !== null && plan.value.contextFingerprint !== null && Date.parse(plan.value.expiresAt ?? '') > Date.now())
  const canUndo = computed(() => !busy.value && !unknown.value && !datasetChanged.value && !!plan.value && plan.value.items.some(item => item.state === 'applied') && ['COMPLETED', 'PARTIAL'].includes(plan.value.state))
  const canCancel = computed(() => !loading.value && !cancelling.value && !undoing.value && !datasetChanged.value && !!plan.value && ['PREVIEWING', 'READY', 'QUEUED', 'RUNNING', 'BLOCKED'].includes(plan.value.state))
  const current = (value: number) => !disposed && isOpen.value && generation === value
  const stopPoll = () => { clearTimeout(timer); timer = undefined }
  function invalidate(): void {
    draft++; stopPoll(); for (const item of pending.value) if (item.command === 'localSourceWrites.preview') item.invalidated = true
    if (plan.value && ['PREVIEWING', 'READY', 'BLOCKED'].includes(plan.value.state)) { plan.value = null; view.value = 'edit'; notice.value = '内容已改变，请重新生成具体预览。' }
  }
  function setRange(value: dto.LocalSourceWritesRange): void { if (locked.value) return; range.value = value; invalidate() }
  function setAction(key: dto.LocalSourceWritesField, value: DraftAction): void { if (locked.value) return; fields[key].action = value; invalidate() }
  function setValue(key: dto.LocalSourceWritesField, value: string): void { if (locked.value) return; fields[key].value = value; invalidate() }
  function setEdition(value: string): void { if (locked.value) return; editionId.value = value; invalidate() }
  function setFileName(value: 'cover.jpg' | 'cover.png'): void { if (locked.value) return; fileName.value = value; invalidate() }
  function intent(): dto.LocalSourceWritesIntent | null {
    if (!target.value) return null
    if (range.value === 'TAGS') {
      const changes: Partial<Record<dto.LocalSourceWritesField, dto.LocalSourceWritesTagChange>> = {}
      for (const key of dto.LOCAL_SOURCE_WRITES_FIELDS) { if (fields[key].action === 'set') changes[key] = { action: 'set', value: fields[key].value }; else if (fields[key].action === 'remove') changes[key] = { action: 'remove' } }
      return { kind: 'tags', target: target.value, fields: changes }
    }
    const material = selectedMaterial.value
    if (!material?.candidateId || !material.contentRef || !material.originalSha256) return null
    const artwork = { editionId: material.editionId, candidateId: material.candidateId, selectionId: material.selectionId, expectedSelectionRevision: material.selectionRevision, contentRef: material.contentRef, originalSha256: material.originalSha256 }
    return range.value === 'EMBEDDED_COVER' ? { kind: 'embedded-cover', target: target.value, artwork, slot: 'front' } : { kind: 'directory-cover', target: target.value, artwork, fileName: fileName.value }
  }
  async function scope(owner = generation): Promise<string> {
    if (!options.api.getCommandOutbox) throw new Error('写入服务尚未就绪；MB 信息与封面仍可保存。')
    const overview = await options.api.getCommandOutbox()
    if (!current(owner)) throw new Error('此处读取已结束。')
    if (!dto.isCommandOutboxOverview(overview)) throw new Error('当前工作库范围暂未核实。')
    if (dataset.value && dataset.value !== overview.datasetId) { datasetChanged.value = true; throw new Error('工作库已改变；原请求保留且不会重发。') }
    dataset.value = overview.datasetId
    observeOutbox(overview)
    return overview.datasetId
  }
  async function readContext(): Promise<void> {
    const owner = generation, sequence = ++readSequence
    loading.value = true; contextFailed.value = false
    try {
      if (!capable) throw new Error('源写服务尚未就绪；MB 信息与封面仍可保存。')
      const datasetId = await scope(), result = await options.api.getLocalSourceWrites!({ datasetId, selector: { kind: 'context', target: target.value } })
      if (!current(owner) || sequence !== readSequence) return
      if (!dto.isLocalSourceWritesCommandResult('localSourceWrites.get', result) || result.kind !== 'context' || result.datasetId !== datasetId) throw new Error('源写上下文身份无效。')
      context.value = result.context; error.value = ''
      if (!result.context.materials.some(item => item.editionId === editionId.value)) editionId.value = result.context.materials[0]?.editionId ?? ''
    } catch (failure) { if (current(owner) && sequence === readSequence) { contextFailed.value = true; error.value = failure instanceof Error ? failure.message : '写入设置与材料暂时无法读取；保留已有结果。' } }
    finally { if (current(owner) && sequence === readSequence) loading.value = false }
  }
  function observeOutbox(overview: dto.CommandOutboxOverview): void {
    if (!dto.isCommandOutboxOverview(overview)) return
    if (dataset.value && dataset.value !== overview.datasetId) { datasetChanged.value = true; stopPoll(); return }
    dataset.value ??= overview.datasetId
    // 持久 Outbox 的回执不能冒充文件结果；隐藏 ACK 也不触发业务调用。
    for (const entry of overview.entries) {
      if (!dto.isLocalSourceWritesOutboxCommand(entry.command) || entry.datasetId !== dataset.value || pending.value.some(item => item.request.commandId === entry.commandId)) continue
      if (entry.sourceRequestFingerprint && resolvedCommands.has(`${entry.datasetId}:${entry.commandId}:${entry.sourceRequestFingerprint}`)) continue
      if (entry.state === 'pending' || entry.state === 'sending' || entry.state === 'uncertain') {
        notice.value = '有原源写请求尚未核对，请从未确认操作或历史读取；不会自动重发。'
        if (entry.sourceRequestFingerprint) pending.value = [...pending.value, { command: entry.command, request: { datasetId: entry.datasetId, commandId: entry.commandId }, fingerprint: entry.sourceRequestFingerprint, generation, draft, invalidated: false }]
      }
    }
  }
  function displayPlan(value: dto.LocalSourceWritesPlan, owner: number): void {
    if (!current(owner)) return
    if (plan.value?.planId !== value.planId) { events.value = []; eventCursor.value = null; eventsLoaded.value = false }
    plan.value = value; view.value = 'plan'; error.value = ''
    const applied = value.items.filter(item => item.state === 'applied').map(item => `${item.operationId}:${item.currentFileRevision}`).join('|')
    if (applied && appliedViews.get(value.planId) !== applied) { appliedViews.set(value.planId, applied); options.onApplied?.() }
    stopPoll()
    observedAt.value = Date.now()
    if (value.state === 'READY' && value.expiresAt) timer = setTimeout(() => { if (current(owner)) observedAt.value = Date.now() }, Math.max(1, Date.parse(value.expiresAt) - Date.now() + 1))
    else if (!terminal(value.state)) timer = setTimeout(() => { if (current(owner)) void loadPlan(value.planId) }, 800)
  }
  async function loadPlan(planId: string): Promise<boolean> {
    const owner = generation, sequence = ++readSequence
    loading.value = true
    try {
      const datasetId = await scope(), result = await options.api.getLocalSourceWrites!({ datasetId, selector: { kind: 'plan', planId } })
      if (!current(owner) || sequence !== readSequence) return false
      if (!dto.isLocalSourceWritesCommandResult('localSourceWrites.get', result) || result.kind !== 'plan' || result.datasetId !== datasetId || !result.plan || result.plan.planId !== planId) throw new Error('原计划暂时无法读取，已有请求保留。')
      displayPlan(result.plan, owner)
      return true
    } catch (failure) { if (current(owner) && sequence === readSequence) error.value = failure instanceof Error ? failure.message : '计划暂时无法核对，请重新读取。' }
    finally { if (current(owner) && sequence === readSequence) loading.value = false }
    return false
  }
  async function receipt(binding: Pending, value: dto.LocalSourceWritesReceipt, displayOwner = binding.generation): Promise<void> {
    if (!pending.value.includes(binding)) return
    if (!dto.isLocalSourceWritesReceipt(value) || value.commandId !== binding.request.commandId || value.command !== binding.command || value.datasetId !== binding.request.datasetId || value.requestFingerprint !== binding.fingerprint) throw new Error('原请求回执身份无效。')
    pending.value = pending.value.filter(item => item !== binding)
    resolvedCommands.add(`${binding.request.datasetId}:${binding.request.commandId}:${binding.fingerprint}`)
    if (!current(displayOwner) || binding.invalidated || binding.draft !== draft && binding.command === 'localSourceWrites.preview') return
    if (value.policy && context.value) context.value = { ...context.value, policy: value.policy }
    notice.value = value.outcome === 'accepted' ? binding.command === 'localSourceWrites.setPolicy' && value.policy ? '源写开关已保存。' : '请求已受理；请核对计划的逐项结果。' : sourceWriteIssueMessage(value.issue)
    if (value.planId) await loadPlan(value.planId)
  }
  async function mutate(command: dto.LocalSourceWritesReceiptCommand, request: Mutation, flag: typeof previewing): Promise<void> {
    if (flag.value) return
    const owner = generation, requestDraft = draft
    flag.value = true; error.value = ''
    let binding: Pending | undefined
    try {
      if (!dto.isLocalSourceWritesCommandPayload(command, request)) throw new Error('具体请求无效，请核对输入。')
      const fingerprint = await sourceWriteRequestFingerprint(command, request)
      if (!current(owner)) return
      if (requestDraft !== draft && command === 'localSourceWrites.preview') return
      binding = { command, request, fingerprint, generation: owner, draft: requestDraft, invalidated: false }
      pending.value = [...pending.value, binding]
      const value = command === 'localSourceWrites.preview' ? await options.api.previewLocalSourceWrites!(request as dto.PreviewLocalSourceWrites)
        : command === 'localSourceWrites.confirm' ? await options.api.confirmLocalSourceWrites!(request as dto.ConfirmLocalSourceWrites)
          : command === 'localSourceWrites.undo' ? await options.api.undoLocalSourceWrites!(request as dto.UndoLocalSourceWrites)
            : command === 'localSourceWrites.cancel' ? await options.api.cancelLocalSourceWrites!(request as dto.CancelLocalSourceWrites)
              : await options.api.setLocalSourceWritesPolicy!(request as dto.SetLocalSourceWritesPolicy)
      await receipt(binding, value)
    } catch (failure) {
      if (current(owner) && (!binding || pending.value.includes(binding))) error.value = binding ? '结果未知，原请求已保留。请只重新读取核对；不会重发或重新授权。' : failure instanceof Error ? failure.message : '请求暂未形成，请重新读取。'
    } finally { if (current(owner)) flag.value = false }
  }
  async function preview(): Promise<void> { if (!canPreview.value) return; const value = intent(); if (!value) return; await mutate('localSourceWrites.preview', { datasetId: dataset.value!, commandId: crypto.randomUUID(), intent: value }, previewing) }
  async function confirm(): Promise<void> {
    const value = plan.value
    if (!value || !canConfirm.value || !value.planHash || !value.contextFingerprint) return
    await mutate('localSourceWrites.confirm', { datasetId: value.datasetId, commandId: crypto.randomUUID(), planId: value.planId, expectedViewRevision: value.viewRevision, scope: 'SOURCE_FILES', range: value.range, planHash: value.planHash, contextFingerprint: value.contextFingerprint }, confirming)
  }
  async function previewUndo(): Promise<void> {
    if (!canUndo.value || !plan.value) return
    const value = plan.value
    await mutate('localSourceWrites.undo', { datasetId: value.datasetId, commandId: crypto.randomUUID(), planId: value.planId, expectedViewRevision: value.viewRevision, operationIds: value.items.filter(item => item.state === 'applied').map(item => item.operationId), journalFingerprint: value.journalFingerprint }, undoing)
  }
  async function previewRecovery(choice: dto.LocalSourceWritesRecoveryChoice): Promise<void> {
    if (busy.value || unknown.value || !plan.value || !plan.value.recoveryChoices.some(item => item.choiceId === choice.choiceId)) return
    await mutate('localSourceWrites.preview', { datasetId: plan.value.datasetId, commandId: crypto.randomUUID(), intent: { kind: 'recovery', originPlanId: choice.originPlanId, expectedOriginViewRevision: choice.expectedOriginViewRevision, choiceId: choice.choiceId, recoveryFingerprint: choice.recoveryFingerprint } }, previewing)
  }
  async function cancel(): Promise<void> {
    if (!canCancel.value || !plan.value) return
    const origin = plan.value.planId, owner = generation
    // confirm 可能已推进修订；先读作者当前状态，再提交准确的取消修订。
    if (!await loadPlan(origin)) return
    if (!current(owner) || !plan.value || plan.value.planId !== origin || !canCancel.value) return
    await mutate('localSourceWrites.cancel', { datasetId: plan.value.datasetId, commandId: crypto.randomUUID(), planId: origin, expectedViewRevision: plan.value.viewRevision }, cancelling)
  }
  async function setPolicy(enabled: boolean): Promise<void> {
    if (busy.value || unknown.value || datasetChanged.value || !context.value) return
    await mutate('localSourceWrites.setPolicy', { datasetId: context.value.datasetId, commandId: crypto.randomUUID(), expectedPolicyRevision: context.value.policy.revision, enabled }, policyBusy)
  }
  async function reconcile(): Promise<void> {
    const owner = generation
    for (const binding of [...pending.value]) {
      try {
        const result = await options.api.getLocalSourceWrites!({ datasetId: binding.request.datasetId, selector: { kind: 'command', commandId: binding.request.commandId, expectedCommand: binding.command, requestFingerprint: binding.fingerprint } })
        if (!current(owner)) return
        if (!dto.isLocalSourceWritesCommandResult('localSourceWrites.get', result) || result.kind !== 'command' || result.datasetId !== binding.request.datasetId || result.commandId !== binding.request.commandId || result.expectedCommand !== binding.command || result.requestFingerprint !== binding.fingerprint) throw new Error('原回执身份无效。')
        if (result.receipt) await receipt(binding, result.receipt, owner)
        else notice.value = '暂未找到原请求记录；仍保留原请求，不会重发。'
      } catch { if (current(owner)) error.value = '原请求暂时无法核对；请稍后重新读取。' }
    }
    if (!current(owner)) return
    if (plan.value) await loadPlan(plan.value.planId)
    else await readContext()
  }
  async function loadHistory(more = false): Promise<void> {
    if (loading.value) return
    const owner = generation, sequence = ++readSequence; stopPoll(); view.value = 'history'; loading.value = true
    try {
      const datasetId = await scope(), page = await options.api.listLocalSourceWritesHistory!({ datasetId, selector: { kind: 'plans', range: 'all' }, cursor: more ? historyCursor.value : null, limit: 20 })
      if (!current(owner) || sequence !== readSequence) return
      if (page.kind !== 'plans' || page.datasetId !== datasetId) throw new Error('历史身份无效。')
      history.value = more ? [...history.value, ...page.items] : page.items; historyCursor.value = page.cursor; historyLoaded.value = true; error.value = ''
    } catch { if (current(owner)) error.value = '持久历史暂时无法读取；已有记录保留。' }
    finally { if (current(owner) && sequence === readSequence) loading.value = false }
  }
  async function loadEvents(more = false): Promise<void> {
    if (!plan.value || loading.value) return
    const value = plan.value, owner = generation; loading.value = true
    try {
      const page = await options.api.listLocalSourceWritesHistory!({ datasetId: value.datasetId, selector: { kind: 'events', planId: value.planId }, cursor: more ? eventCursor.value : null, limit: 100 })
      if (!current(owner) || plan.value?.planId !== value.planId) return
      if (page.kind !== 'events' || page.planId !== value.planId) throw new Error('事件身份无效。')
      events.value = more ? [...events.value, ...page.items] : page.items; eventCursor.value = page.cursor; eventsLoaded.value = true
    } catch { if (current(owner)) error.value = '具体处理历史暂时无法读取。' }
    finally { if (current(owner)) loading.value = false }
  }
  async function open(value: dto.LocalSourceWritesTarget | null, label = '', initial: dto.LocalSourceWritesRange = 'TAGS', initialEditionId = ''): Promise<void> {
    generation++; readSequence++; draft++; stopPoll(); isOpen.value = true; target.value = value ? dto.localSourceWritesDataSnapshot(value) as dto.LocalSourceWritesTarget : null; targetLabel.value = label
    range.value = initial; editionId.value = initialEditionId; plan.value = null; context.value = null; view.value = 'edit'; error.value = ''; notice.value = ''; events.value = []; eventsLoaded.value = false
    loading.value = previewing.value = confirming.value = undoing.value = cancelling.value = policyBusy.value = false
    for (const key of dto.LOCAL_SOURCE_WRITES_FIELDS) fields[key] = { action: 'keep', value: '' }
    await readContext()
  }
  async function openHistory(): Promise<void> { await open(null, '源文件写入历史'); await loadHistory() }
  function close(): void { generation++; readSequence++; isOpen.value = false; stopPoll(); loading.value = previewing.value = confirming.value = undoing.value = cancelling.value = policyBusy.value = false }
  function dispose(): void { close(); disposed = true }
  function edit(): void { if (locked.value) return; stopPoll(); draft++; plan.value = null; view.value = 'edit' }
  return { capable, isOpen, view, target, targetLabel, context, contextFailed, plan, planExpired, range, fileName, editionId, fields, selectedMaterial, loading, previewing, confirming, undoing, cancelling, policyBusy, busy, unknown, locked, error, notice, pending, datasetChanged, canPreview, canConfirm, canUndo, canCancel, history, historyLoaded, historyCursor, events, eventsLoaded, eventCursor,
    stateLabel: (state: dto.LocalSourceWritesState) => sourceWriteStateLabels[state], rangeLabel: (value: dto.LocalSourceWritesRange) => sourceWriteRangeLabels[value], issue: sourceWriteIssueMessage,
    open, openHistory, close, dispose, readContext, setRange, setAction, setValue, setEdition, setFileName, preview, confirm, previewUndo, previewRecovery, cancel, setPolicy, reconcile, loadPlan, loadHistory, loadEvents, observeOutbox, edit }
}
