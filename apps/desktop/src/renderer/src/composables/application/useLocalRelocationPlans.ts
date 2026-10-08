import { computed, ref, shallowRef } from 'vue'
import * as dto from '@music-bridge/contracts'

type Mutation = dto.LocalRelocationPlanReceiptCommand
interface RecoveryFamily {
  origin: dto.LocalRelocationPlan
  choice: dto.LocalRelocationPlanRecoveryChoice
}
interface Pending {
  command: Mutation
  request: dto.LocalRelocationPlanCommandPayloads[Mutation]
  fingerprint: string
  generation: number
  draft: number
}
interface Options {
  api: Partial<dto.LocalRelocationPlanPublicApi> & Partial<Pick<dto.CommandOutboxPublicApi, 'getCommandOutbox'>>
  onApplied?: () => void
}
type Mode = 'rename' | 'move' | 'root-reassociate' | 'locate'
const terminal = (state: dto.LocalRelocationPlanState): boolean => ['BLOCKED', 'DEFERRED', 'SOURCE_RETAINED', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED', 'RECOVERY_REQUIRED'].includes(state)
const selection = (value: unknown): value is dto.LocalRelocationPlanSelection => dto.localRelocationRecord(value, ['assetId', 'expectedFileRevision', 'expectedLocationRevision', 'expectedRootRevision']) && dto.isCollectionId(value.assetId) && dto.isLocalCatalogRevision(value.expectedFileRevision) && dto.isLocalCatalogRevision(value.expectedLocationRevision) && dto.isLocalCatalogRevision(value.expectedRootRevision)
export const relocationStateLabels: Record<dto.LocalRelocationPlanState, string> = {
  PREVIEWING: '正在核验具体计划', READY: '具体预览可确认', BLOCKED: '当前不可搬迁', DEFERRED: '活动读取或保护中，已延期', QUEUED: '已受理，等待处理', RUNNING: '正在处理文件', VERIFIED_TARGET: '目标已完整验证，等待登记',
  SOURCE_RETAINED: '目标已登记，源材料保留', COMPLETED: '逐项处理完成', PARTIAL: '部分完成', FAILED: '未完成', CANCEL_REQUESTED: '正在安全收尾', CANCELLED: '已取消', RECOVERY_REQUIRED: '需要核对恢复材料',
}
export function relocationIssueLabel(issue: dto.LocalRelocationPlanIssue | null): string {
  if (!issue) return ''
  const labels: Partial<Record<dto.LocalRelocationPlanIssueCode, string>> = {
    POLICY_DISABLED: '文件搬迁开关已关闭；可继续读取计划与历史。', UNQUALIFIED: '文件搬迁资格尚未通过，不能处理源文件。', DRAINING: '已有文件任务正在安全收尾。',
    LEASE_ACTIVE: '文件正在播放、暂停读取或预取，本计划延期；不会停止播放。', FROZEN_REFERENCE: '此文件被已冻结制作引用，不能搬迁。', PREPARED_REFERENCE: '此文件被已准备的制作引用，不能搬迁。', ARCHIVE_REFERENCE: '此文件被归档引用，不能搬迁。',
    UNKNOWN_REFERENCE: '伴随文件的引用尚未核实，须先确定完整资源。', SHARED_REFERENCE: '共享伴随资源尚未完整核实，当前不处理。', CLOSURE_INCOMPLETE: '伴随资源闭集不完整，整个计划未获授权。',
    ROOT_IDENTITY_UNPROVEN: '目标卷或共享的底层身份尚未核实。', ROOT_OFFLINE: '目录离线，原对象与源材料保留。', ROOT_CHANGED: '目录身份或关联已改变，请重新核对。', ROOT_REVOKED: '目录许可已撤销。',
    COLLISION: '目标已有同名文件，本计划不会覆盖它。', SYMLINK: '路径包含符号链接，当前不处理。', OUT_OF_ROOT: '目标超出已授权目录。', SPACE_INSUFFICIENT: '目标空间不足，源材料保留。', SPACE_UNVERIFIED: '目标空间尚未核实。',
    COMMAND_UNKNOWN: '原命令结果未知，只能读取核对；不会重签或重放。', NOT_FOUND: '尚未找到原命令记录；不会据此重发。', VERIFY_FAILED: '目标独立回读未通过，不能清理源材料。', HASH_MISMATCH: '完整文件内容不一致，不能清理源材料。',
    CLEANUP_NOT_VERIFIED: '目标尚未完整验证并登记，不能清理源材料。', CLEANUP_NOT_ALLOWED: '原源仍有依赖或保护，不能清理。', OVER_BUDGET: '完整计划超过安全预算，没有截取部分资源处理。',
    STALE_VIEW: '具体计划修订已改变，请重新读取。', SOURCE_CHANGED: '原源文件已变化，请重新核对。', TARGET_CHANGED: '已验证目标已变化，源材料保留。', RECOVERY_REQUIRED: '请先核对逐项材料，再选择新的具体恢复计划。',
  }
  return labels[issue.code] ?? issue.label
}

/** 013独立会话：固定scope和原指纹；关闭、迟到ACK和未知结果均不派发第二次动作。 */
export function useLocalRelocationPlans(options: Options) {
  const capable = typeof options.api.localRelocationPlan === 'function' && typeof options.api.getCommandOutbox === 'function'
  const isOpen = ref(false), view = ref<'edit' | 'plan' | 'history'>('edit'), mode = ref<Mode>('move'), targetLabel = ref('')
  const targets = shallowRef<dto.LocalRelocationPlanSelection[]>([]), rootTarget = shallowRef<{ libraryRootId: string; expectedRootRevision: string } | null>(null), candidateId = ref<string | null>(null)
  const targetChoice = shallowRef<dto.LocalRelocationTargetChoice | null>(null), newName = ref(''), sourceDisposition = ref<dto.LocalRelocationSourceDisposition>('RETAIN')
  const context = shallowRef<dto.LocalRelocationPlanContext | null>(null), plan = shallowRef<dto.LocalRelocationPlan | null>(null), dataset = ref<string | null>(null), datasetChanged = ref(false)
  const recoveryOrigin = shallowRef<dto.LocalRelocationPlan | null>(null)
  const loading = ref(false), choosing = ref(false), previewing = ref(false), confirming = ref(false), cleaning = ref(false), cancelling = ref(false), policyBusy = ref(false)
  const error = ref(''), notice = ref(''), contextFailed = ref(false), historyLoaded = ref(false), eventsLoaded = ref(false)
  const history = shallowRef<dto.LocalRelocationPlanHistoryItem[]>([]), historyCursor = ref<string | null>(null), events = shallowRef<dto.LocalRelocationPlanEvent[]>([]), eventCursor = ref<string | null>(null)
  const pending = shallowRef<Pending[]>([]), observedAt = ref(Date.now())
  const applied = new Map<string, string>()
  let generation = 0, draft = 0, readSequence = 0, disposed = false, active = false, timer: ReturnType<typeof setTimeout> | undefined
  const current = (owner: number): boolean => !disposed && active && owner === generation
  const stopPoll = () => { clearTimeout(timer); timer = undefined }
  const busy = computed(() => loading.value || choosing.value || previewing.value || confirming.value || cleaning.value || cancelling.value || policyBusy.value)
  const unknown = computed(() => pending.value.length > 0)
  const locked = computed(() => busy.value || unknown.value || datasetChanged.value || contextFailed.value || !!plan.value && !terminal(plan.value.state) && plan.value.state !== 'READY')
  const choiceExpired = computed(() => !!targetChoice.value && Date.parse(targetChoice.value.expiresAt) <= observedAt.value)
  const planExpired = computed(() => !!plan.value && plan.value.state === 'READY' && Date.parse(plan.value.expiresAt) <= observedAt.value)
  const qualified = computed(() => context.value?.qualification.state === 'qualified')
  const recoveryFamily = computed(() => plan.value && recoveryOrigin.value ? familyForPlan(plan.value, recoveryOrigin.value) : null)
  const recoveryAction = computed(() => recoveryFamily.value?.choice ?? null)
  const canPreview = computed(() => isOpen.value && view.value === 'edit' && capable && !locked.value && !!dataset.value && !!context.value && !contextFailed.value && !choiceExpired.value && !!intent())
  const canConfirm = computed(() => isOpen.value && view.value === 'plan' && !busy.value && (!unknown.value || !!recoveryFamily.value && pendingForOrigin(recoveryFamily.value.origin)) && !datasetChanged.value && !contextFailed.value && qualified.value && !!context.value?.policy.enabled && !context.value.policy.draining && plan.value?.state === 'READY' && (plan.value.intent.kind !== 'recovery' || !!recoveryFamily.value) && plan.value.policyRevision === context.value.policy.revision && !planExpired.value)
  const canCleanup = computed(() => isOpen.value && view.value === 'plan' && !busy.value && !unknown.value && !datasetChanged.value && !contextFailed.value && qualified.value && !!context.value?.policy.enabled && !context.value.policy.draining && plan.value?.cleanup.state === 'eligible' && !!plan.value.cleanup.verifiedTargetFingerprint && plan.value.cleanup.sourceResourceIds.length > 0)
  const canCancel = computed(() => isOpen.value && view.value === 'plan' && !busy.value && !unknown.value && !datasetChanged.value && !contextFailed.value && !!plan.value && ['PREVIEWING', 'READY', 'BLOCKED', 'DEFERRED', 'QUEUED', 'RUNNING'].includes(plan.value.state))

  function exactChoice(origin: dto.LocalRelocationPlan, raw: unknown): dto.LocalRelocationPlanRecoveryChoice | null {
    try {
      const captured = dto.localRelocationDataSnapshot(raw)
      if (!dto.localRelocationRecord(captured, ['choiceId', 'originPlanId', 'expectedOriginViewRevision', 'recoveryFingerprint', 'action', 'label', 'resourceIds'])) return null
      const value = origin.recoveryChoices.find(choice => choice.choiceId === captured.choiceId)
      if (!value || origin.datasetId !== dataset.value || value.originPlanId !== origin.planId || value.expectedOriginViewRevision !== origin.viewRevision || dto.localRelocationCanonical(value) !== dto.localRelocationCanonical(captured)) return null
      const ids = new Set(value.resourceIds)
      if (!origin.closure.complete || !origin.resources.length || ids.size !== origin.resources.length || origin.resources.some(resource => !ids.has(resource.resourceId))) return null
      return value
    } catch { return null }
  }
  function pendingForOrigin(origin: dto.LocalRelocationPlan): boolean {
    return pending.value.every(binding => {
      if (binding.command !== 'localRelocationPlan.confirm') return false
      try {
        const request = dto.localRelocationPlanCommandSnapshot('localRelocationPlan.confirm', binding.request)
        return request.datasetId === origin.datasetId && request.datasetId === dataset.value && request.planId === origin.planId && request.planHash === origin.planHash && request.contextFingerprint === origin.contextFingerprint && BigInt(request.expectedViewRevision) <= BigInt(origin.viewRevision) && dto.isLocalRelocationPlanHash(binding.fingerprint)
      } catch { return false }
    })
  }
  function familyForPlan(value: dto.LocalRelocationPlan, origin: dto.LocalRelocationPlan): RecoveryFamily | null {
    const intent = value.intent
    if (intent.kind !== 'recovery' || value.datasetId !== origin.datasetId || value.planId === origin.planId || value.jobId === origin.jobId || value.planHash === origin.planHash || value.contextFingerprint === origin.contextFingerprint || intent.originPlanId !== origin.planId || intent.expectedOriginViewRevision !== origin.viewRevision) return null
    const choice = origin.recoveryChoices.find(entry => entry.choiceId === intent.choiceId && entry.recoveryFingerprint === intent.recoveryFingerprint)
    return choice && exactChoice(origin, choice) ? { origin, choice } : null
  }
  function canPreviewRecovery(choice: dto.LocalRelocationPlanRecoveryChoice): boolean {
    const origin = plan.value
    return isOpen.value && view.value === 'plan' && capable && !busy.value && !datasetChanged.value && !contextFailed.value && qualified.value && !!context.value?.policy.enabled && !context.value.policy.draining && !!origin && origin.policyRevision === context.value.policy.revision && !!exactChoice(origin, choice) && pendingForOrigin(origin)
  }
  function recoveryMutationAllowed<C extends Mutation>(command: C, request: dto.LocalRelocationPlanCommandPayloads[C], family?: RecoveryFamily): boolean {
    if (!family || contextFailed.value || datasetChanged.value || !qualified.value || !context.value?.policy.enabled || context.value.policy.draining || !pendingForOrigin(family.origin)) return false
    if (command === 'localRelocationPlan.preview') {
      const preview = dto.localRelocationPlanCommandSnapshot('localRelocationPlan.preview', request), intent = preview.intent
      return plan.value?.planId === family.origin.planId && plan.value.viewRevision === family.origin.viewRevision && !!exactChoice(plan.value, family.choice) && intent.kind === 'recovery' && preview.datasetId === family.origin.datasetId && intent.originPlanId === family.origin.planId && intent.expectedOriginViewRevision === family.origin.viewRevision && intent.choiceId === family.choice.choiceId && intent.recoveryFingerprint === family.choice.recoveryFingerprint
    }
    if (command === 'localRelocationPlan.confirm') {
      const confirm = dto.localRelocationPlanCommandSnapshot('localRelocationPlan.confirm', request), value = plan.value
      return !!value && value.state === 'READY' && Date.parse(value.expiresAt) > Date.now() && !!familyForPlan(value, family.origin) && confirm.datasetId === value.datasetId && confirm.planId === value.planId && confirm.expectedViewRevision === value.viewRevision && confirm.planHash === value.planHash && confirm.contextFingerprint === value.contextFingerprint
    }
    return false
  }

  async function scope(owner = generation): Promise<string> {
    if (!capable) throw new Error('文件搬迁服务尚未就绪，原播放与找回入口保留。')
    const overview = await options.api.getCommandOutbox!()
    if (!current(owner) || !dto.isCommandOutboxOverview(overview)) throw new Error('当前工作库身份尚未核实。')
    if (dataset.value && dataset.value !== overview.datasetId) { datasetChanged.value = true; stopPoll(); throw new Error('工作库已改变；原命令保留，不会改绑或重发。') }
    dataset.value ??= overview.datasetId
    return dataset.value
  }
  function observeOutbox(overview: dto.CommandOutboxOverview): void {
    if (dto.isCommandOutboxOverview(overview) && dataset.value && overview.datasetId !== dataset.value) { datasetChanged.value = true; stopPoll() }
    // 旧Outbox条目不能成为本域receipt、grant或文件结果。
  }
  async function readContext(): Promise<void> {
    const owner = generation, sequence = ++readSequence
    loading.value = true
    try {
      const datasetId = await scope(owner), raw = await options.api.localRelocationPlan!('localRelocationPlan.get', { datasetId, selector: { kind: 'context' } })
      const value = dto.localRelocationPlanCommandResultSnapshot('localRelocationPlan.get', raw)
      if (!current(owner) || sequence !== readSequence) return
      if (value.kind !== 'context' || value.datasetId !== datasetId) throw new Error('搬迁设置身份未核实。')
      context.value = value; contextFailed.value = false; error.value = ''
    } catch { if (current(owner) && sequence === readSequence) { contextFailed.value = true; error.value = '搬迁设置暂未读取，现有计划与材料保留。' } }
    finally { if (current(owner) && sequence === readSequence) loading.value = false }
  }
  function displayPlan(value: dto.LocalRelocationPlan, owner: number, origin: dto.LocalRelocationPlan | null = null): void {
    if (!current(owner)) return
    if (plan.value?.planId !== value.planId) { events.value = []; eventCursor.value = null; eventsLoaded.value = false }
    recoveryOrigin.value = origin
    plan.value = value; view.value = 'plan'; error.value = ''; observedAt.value = Date.now(); stopPoll()
    const committed = value.items.filter(item => ['registered', 'retained', 'cleaned'].includes(item.state)).map(item => `${item.operationId}:${item.state}`).join('|')
    if (committed && applied.get(value.planId) !== committed) { applied.set(value.planId, committed); options.onApplied?.() }
    if (value.state === 'READY') timer = setTimeout(() => { if (current(owner)) observedAt.value = Date.now() }, Math.max(1, Date.parse(value.expiresAt) - Date.now() + 1))
    else if (!terminal(value.state)) timer = setTimeout(() => { if (current(owner) && !busy.value) void loadPlan(value.planId) }, 800)
  }
  async function loadPlan(planId: string): Promise<boolean> {
    const owner = generation, sequence = ++readSequence
    loading.value = true
    try {
      const datasetId = await scope(owner), raw = await options.api.localRelocationPlan!('localRelocationPlan.get', { datasetId, selector: { kind: 'plan', planId } })
      const value = dto.localRelocationPlanCommandResultSnapshot('localRelocationPlan.get', raw)
      if (!current(owner) || sequence !== readSequence) return false
      if (value.datasetId !== datasetId || value.kind !== 'plan' || value.planId !== planId || !value.plan || value.plan.planId !== planId) throw new Error('原计划暂未核实。')
      let origin: dto.LocalRelocationPlan | null = null
      if (value.plan.intent.kind === 'recovery' && value.plan.state === 'READY') {
        const intent = value.plan.intent, originRaw = await options.api.localRelocationPlan!('localRelocationPlan.get', { datasetId, selector: { kind: 'plan', planId: intent.originPlanId } })
        const original = dto.localRelocationPlanCommandResultSnapshot('localRelocationPlan.get', originRaw)
        if (!current(owner) || sequence !== readSequence) return false
        if (original.datasetId !== datasetId || original.kind !== 'plan' || original.planId !== intent.originPlanId || !original.plan || original.plan.planId !== intent.originPlanId) throw new Error('恢复原计划尚未核实。')
        if (familyForPlan(value.plan, original.plan)) origin = original.plan
      }
      displayPlan(value.plan, owner, origin)
      if (value.plan.intent.kind === 'recovery' && value.plan.state === 'READY' && !origin) error.value = '原恢复选择或修订已改变；请重新读取原计划，再生成新的具体恢复预览。'
      return true
    } catch { if (current(owner) && sequence === readSequence) error.value = '原计划暂未读取，已有状态与源材料保留；不会重新提交。' }
    finally { if (current(owner) && sequence === readSequence) loading.value = false }
    return false
  }
  function intent(): dto.LocalRelocationPlanIntent | null {
    const disposition = sourceDisposition.value
    if (mode.value === 'rename') {
      if (targets.value.length !== 1 || !dto.isLocalRelocationPlanBasename(newName.value)) return null
      return { kind: 'rename', target: targets.value[0]!, newName: newName.value, sourceDisposition: disposition }
    }
    const choice = targetChoice.value
    if (!choice || Date.parse(choice.expiresAt) <= Date.now()) return null
    if (mode.value === 'root-reassociate' && rootTarget.value && choice.kind === 'directory') return { kind: 'root-reassociate', ...rootTarget.value, targetChoiceId: choice.choiceId, sourceDisposition: 'RETAIN' }
    if (mode.value === 'locate' && targets.value.length === 1 && candidateId.value && choice.kind === 'file') return { kind: 'locate', target: targets.value[0]!, candidateId: candidateId.value, targetChoiceId: choice.choiceId, sourceDisposition: 'RETAIN' }
    if (mode.value === 'move' && targets.value.length > 0 && choice.kind === 'directory') return { kind: 'move', targets: [...targets.value], targetChoiceId: choice.choiceId, sourceDisposition: disposition }
    return null
  }
  function invalidate(): void {
    draft++; stopPoll(); observedAt.value = Date.now()
    if (plan.value && ['READY', 'BLOCKED', 'DEFERRED'].includes(plan.value.state)) { plan.value = null; view.value = 'edit'; notice.value = '内容已改变，请重新生成完整具体预览。' }
    const choice = targetChoice.value, owner = generation
    if (choice) timer = setTimeout(() => { if (current(owner)) observedAt.value = Date.now() }, Math.max(1, Date.parse(choice.expiresAt) - Date.now() + 1))
  }
  function setMode(value: 'rename' | 'move'): void { if (locked.value || targets.value.length !== 1 && value === 'rename') return; mode.value = value; targetChoice.value = null; invalidate() }
  function setNewName(value: string): void { if (locked.value) return; newName.value = value; invalidate() }
  function setDisposition(value: dto.LocalRelocationSourceDisposition): void { if (locked.value) return; sourceDisposition.value = value; invalidate() }
  async function chooseTarget(): Promise<void> {
    if (locked.value || mode.value === 'rename') return
    const owner = generation, previousDraft = draft
    choosing.value = true
    try {
      const datasetId = await scope(owner), kind = mode.value === 'locate' ? 'file' : 'directory'
      const raw = await options.api.localRelocationPlan!('localRelocationPlan.chooseTarget', { datasetId, commandId: crypto.randomUUID(), kind })
      const choice = dto.localRelocationPlanCommandResultSnapshot('localRelocationPlan.chooseTarget', raw)
      if (!current(owner) || previousDraft !== draft) return
      if (choice && (choice.kind !== kind || Date.parse(choice.expiresAt) <= Date.now())) throw new Error('目标选择已过期。')
      if (!choice) { notice.value = '已取消目标选择，尚未创建搬迁计划。'; return }
      targetChoice.value = choice; invalidate(); error.value = ''
    } catch { if (current(owner)) error.value = '目标选择暂未确认，请重新读取；尚未派发文件搬迁。' }
    finally { if (current(owner)) choosing.value = false }
  }
  async function acceptReceipt(binding: Pending, raw: unknown, displayOwner = binding.generation): Promise<void> {
    if (!pending.value.includes(binding)) return
    const receipt = dto.localRelocationPlanCommandResultSnapshot(binding.command, raw)
    if (receipt.datasetId !== binding.request.datasetId || receipt.commandId !== binding.request.commandId || receipt.command !== binding.command || receipt.requestFingerprint !== binding.fingerprint) throw new Error('原命令回执身份未核实。')
    if (datasetChanged.value) return
    pending.value = pending.value.filter(item => item !== binding)
    if (!current(displayOwner) || binding.command === 'localRelocationPlan.preview' && binding.draft !== draft) return
    if (receipt.policy && context.value) context.value = { ...context.value, policy: receipt.policy }
    notice.value = receipt.outcome === 'accepted' ? receipt.policy ? '搬迁开关已保存。' : '原命令已受理，请核对持久计划的逐项文件结果。' : relocationIssueLabel(receipt.issue)
    if (receipt.planId) await loadPlan(receipt.planId)
  }
  async function mutate<C extends Mutation>(command: C, raw: dto.LocalRelocationPlanCommandPayloads[C], flag: typeof previewing, family?: RecoveryFamily): Promise<void> {
    if (flag.value || datasetChanged.value || contextFailed.value || unknown.value && !recoveryMutationAllowed(command, raw, family)) return
    const owner = generation, previousDraft = draft
    flag.value = true; error.value = ''
    let binding: Pending | undefined
    try {
      const request = dto.localRelocationPlanCommandSnapshot(command, raw)
      const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(dto.localRelocationRequestFingerprintInput(command, request)))
      const fingerprint = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('')
      if (!current(owner) || datasetChanged.value || contextFailed.value || previousDraft !== draft && command === 'localRelocationPlan.preview' || family && !recoveryMutationAllowed(command, request, family)) return
      binding = { command, request, fingerprint, generation: owner, draft: previousDraft }
      pending.value = [...pending.value, binding]
      await acceptReceipt(binding, await options.api.localRelocationPlan!(command, request))
    } catch { if (current(owner)) error.value = binding ? '结果未知，原命令与指纹已保留。请只重新读取核对，不会重签或重放。' : '具体请求尚未形成，请重新读取并核对输入。' }
    finally { if (current(owner)) flag.value = false }
  }
  async function preview(): Promise<void> {
    if (!canPreview.value) return
    const value = intent(); if (!value || !dataset.value) return
    await mutate('localRelocationPlan.preview', { datasetId: dataset.value, commandId: crypto.randomUUID(), intent: value }, previewing)
  }
  async function confirm(): Promise<void> {
    let value = plan.value
    if (!value || !canConfirm.value || Date.parse(value.expiresAt) <= Date.now()) return
    if (value.intent.kind === 'recovery') {
      const owner = generation, planId = value.planId
      await readContext()
      if (!current(owner) || contextFailed.value || !await loadPlan(planId) || !current(owner) || plan.value?.planId !== planId || !canConfirm.value) return
      value = plan.value
    }
    await mutate('localRelocationPlan.confirm', { datasetId: value.datasetId, commandId: crypto.randomUUID(), planId: value.planId, expectedViewRevision: value.viewRevision, domain: 'LOCAL_RELOCATION_V1', planHash: value.planHash, contextFingerprint: value.contextFingerprint }, confirming, recoveryFamily.value ?? undefined)
  }
  async function cleanup(): Promise<void> {
    const owner = generation, planId = plan.value?.planId
    if (!canCleanup.value || !planId || !await loadPlan(planId) || !current(owner) || plan.value?.planId !== planId || !canCleanup.value) return
    const value = plan.value
    await mutate('localRelocationPlan.cleanup', { datasetId: value.datasetId, commandId: crypto.randomUUID(), planId: value.planId, expectedViewRevision: value.viewRevision, domain: 'LOCAL_RELOCATION_V1', planHash: value.planHash, contextFingerprint: value.contextFingerprint, verifiedTargetFingerprint: value.cleanup.verifiedTargetFingerprint!, sourceResourceIds: [...value.cleanup.sourceResourceIds] }, cleaning)
  }
  async function cancel(): Promise<void> {
    const owner = generation, planId = plan.value?.planId
    if (!canCancel.value || !planId || !await loadPlan(planId) || !current(owner) || plan.value?.planId !== planId || !canCancel.value) return
    await mutate('localRelocationPlan.cancel', { datasetId: plan.value.datasetId, commandId: crypto.randomUUID(), planId, expectedViewRevision: plan.value.viewRevision }, cancelling)
  }
  async function previewRecovery(choice: dto.LocalRelocationPlanRecoveryChoice): Promise<void> {
    if (!canPreviewRecovery(choice) || !plan.value) return
    const captured = dto.localRelocationDataSnapshot(choice), owner = generation, originPlanId = plan.value.planId
    await readContext()
    if (!current(owner) || contextFailed.value || !await loadPlan(originPlanId) || !current(owner) || plan.value?.planId !== originPlanId) return
    const origin = plan.value, selected = exactChoice(origin, captured)
    if (!selected || !canPreviewRecovery(selected)) { error.value = '原恢复选择或修订已改变；请重新读取，尚未提交新的恢复计划。'; return }
    await mutate('localRelocationPlan.preview', { datasetId: origin.datasetId, commandId: crypto.randomUUID(), intent: { kind: 'recovery', originPlanId: selected.originPlanId, expectedOriginViewRevision: selected.expectedOriginViewRevision, choiceId: selected.choiceId, recoveryFingerprint: selected.recoveryFingerprint } }, previewing, { origin, choice: selected })
  }
  async function setPolicy(enabled: boolean): Promise<void> {
    if (busy.value || unknown.value || datasetChanged.value || contextFailed.value || !context.value) return
    await mutate('localRelocationPlan.setPolicy', { datasetId: context.value.datasetId, commandId: crypto.randomUUID(), expectedPolicyRevision: context.value.policy.revision, enabled }, policyBusy)
  }
  async function reconcile(): Promise<void> {
    const owner = generation
    await readContext()
    if (!current(owner) || datasetChanged.value || contextFailed.value) return
    for (const binding of [...pending.value]) {
      try {
        const raw = await options.api.localRelocationPlan!('localRelocationPlan.get', { datasetId: binding.request.datasetId, selector: { kind: 'command', commandId: binding.request.commandId, expectedCommand: binding.command, requestFingerprint: binding.fingerprint } })
        const value = dto.localRelocationPlanCommandResultSnapshot('localRelocationPlan.get', raw)
        if (!current(owner)) return
        if (value.kind !== 'command' || value.datasetId !== binding.request.datasetId || value.commandId !== binding.request.commandId || value.expectedCommand !== binding.command || value.requestFingerprint !== binding.fingerprint) throw new Error('原命令查询身份无效。')
        if (value.receipt) await acceptReceipt(binding, value.receipt, owner)
        else notice.value = relocationIssueLabel(value.issue) || '原命令仍未知，只读取核对，不会重发。'
      } catch { if (current(owner)) error.value = '原命令结果仍未核实；保留原绑定与材料，不会重发。' }
    }
    if (current(owner) && plan.value) await loadPlan(plan.value.planId)
  }
  async function loadHistory(more = false): Promise<void> {
    if (busy.value && !loading.value) return
    const owner = generation, sequence = ++readSequence
    loading.value = true
    try {
      const datasetId = await scope(owner), raw = await options.api.localRelocationPlan!('localRelocationPlan.history', { datasetId, selector: { kind: 'plans' }, cursor: more ? historyCursor.value : null, limit: 100 })
      const value = dto.localRelocationPlanCommandResultSnapshot('localRelocationPlan.history', raw)
      if (!current(owner) || sequence !== readSequence) return
      if (value.kind !== 'plans' || value.datasetId !== datasetId || value.limit !== 100) throw new Error('历史身份无效。')
      stopPoll(); plan.value = null; recoveryOrigin.value = null; history.value = value.items; historyCursor.value = value.cursor; historyLoaded.value = true; view.value = 'history'; error.value = ''
    } catch { if (current(owner) && sequence === readSequence) error.value = '搬迁历史暂未读取，已有逐项结果保留。' }
    finally { if (current(owner) && sequence === readSequence) loading.value = false }
  }
  async function loadEvents(more = false): Promise<void> {
    if (!plan.value || busy.value) return
    const owner = generation, planId = plan.value.planId
    loading.value = true
    try {
      const datasetId = await scope(owner), raw = await options.api.localRelocationPlan!('localRelocationPlan.history', { datasetId, selector: { kind: 'events', planId }, cursor: more ? eventCursor.value : null, limit: 100 })
      const value = dto.localRelocationPlanCommandResultSnapshot('localRelocationPlan.history', raw)
      if (!current(owner) || plan.value?.planId !== planId) return
      if (value.kind !== 'events' || value.datasetId !== datasetId || value.planId !== planId || value.limit !== 100) throw new Error('事件身份无效。')
      events.value = more ? [...events.value, ...value.items] : value.items; eventCursor.value = value.cursor; eventsLoaded.value = true
    } catch { if (current(owner)) error.value = '逐项阶段历史暂未读取，不改变已有文件结果。' }
    finally { if (current(owner)) loading.value = false }
  }
  function edit(): void { if (!locked.value) { view.value = 'edit'; plan.value = null; invalidate() } }
  function close(): void { active = false; isOpen.value = false; generation++; stopPoll(); loading.value = false; choosing.value = false; previewing.value = false; confirming.value = false; cleaning.value = false; cancelling.value = false; policyBusy.value = false }
  async function open(selections: dto.LocalRelocationPlanSelection[], label = '', initialMode: 'rename' | 'move' = 'move'): Promise<void> {
    close(); if (disposed) return
    let captured: unknown
    try { captured = dto.localRelocationDataSnapshot(selections) } catch { return }
    if (!Array.isArray(captured) || captured.length < 1 || captured.length > dto.LOCAL_RELOCATION_PLAN_BUDGET.operations || !captured.every(selection) || new Set(captured.map(value => value.assetId)).size !== captured.length || initialMode === 'rename' && captured.length !== 1) return
    draft++; active = true; isOpen.value = true; targets.value = captured; rootTarget.value = null; candidateId.value = null; targetLabel.value = label; mode.value = initialMode; targetChoice.value = null; newName.value = ''; sourceDisposition.value = 'RETAIN'; plan.value = null; view.value = 'edit'; context.value = null; error.value = ''; notice.value = ''
    await readContext()
  }
  async function openRoot(root: { libraryRootId: string; expectedRootRevision: string }, label: string): Promise<void> {
    close(); if (disposed) return
    draft++; active = true; isOpen.value = true; targets.value = []; rootTarget.value = { ...root }; candidateId.value = null; targetLabel.value = label; mode.value = 'root-reassociate'; targetChoice.value = null; sourceDisposition.value = 'RETAIN'; plan.value = null; view.value = 'edit'; context.value = null; error.value = ''; notice.value = ''
    await readContext()
  }
  async function openCandidate(selection: dto.LocalRelocationPlanSelection, id: string, label: string): Promise<void> {
    const opening = open([selection], label), owner = generation
    await opening
    if (current(owner)) { mode.value = 'locate'; candidateId.value = id; sourceDisposition.value = 'RETAIN' }
  }
  async function openHistory(): Promise<void> { close(); if (disposed) return; active = true; isOpen.value = true; plan.value = null; view.value = 'history'; error.value = ''; await readContext(); if (!contextFailed.value) await loadHistory() }
  async function activateSettings(): Promise<void> { if (disposed) return; active = true; await readContext() }
  function dispose(): void { close(); disposed = true }
  return { capable, isOpen, view, mode, targetLabel, targets, rootTarget, candidateId, targetChoice, newName, sourceDisposition, context, plan, datasetChanged,
    loading, choosing, previewing, confirming, cleaning, cancelling, policyBusy, error, notice, contextFailed, historyLoaded, eventsLoaded, history, historyCursor, events, eventCursor, pending,
    busy, unknown, locked, choiceExpired, planExpired, qualified, canPreview, canConfirm, canCleanup, canCancel, canPreviewRecovery, recoveryAction, stateLabel: (state: dto.LocalRelocationPlanState) => relocationStateLabels[state], issue: relocationIssueLabel,
    open, openRoot, openCandidate, openHistory, activateSettings, close, dispose, setMode, setNewName, setDisposition, chooseTarget, readContext, observeOutbox, preview, confirm, cleanup, cancel, previewRecovery, reconcile, loadPlan, loadHistory, loadEvents, edit, setPolicy }
}
