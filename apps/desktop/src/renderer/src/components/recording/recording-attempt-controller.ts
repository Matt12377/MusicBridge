import {
  isCollectionId, isRecordingAttempt, isRecordingAttemptReceipt, isRecordingAttemptsPage, isRecordingPreflightResult, MAX_RECORDING_ATTEMPT_PAGE_SIZE,
  type BeginRecordingAttemptRequest, type BeginRecordingAttemptSideRequest, type ConfirmRecordingAttemptRequest, type RecordingAttempt,
  type RecordingAttemptConfirmation, type RecordingAttemptReceiptRequest, type RecordingAttemptsPage, type RecordingAttemptsPublicApi,
  type RecordingPlanVersion, type RecordingPlansPublicApi, type RecordingPreflightResult, type RenderSide, type StopRecordingAttemptRequest,
} from '@music-bridge/contracts'

type Operation = { kind: 'confirm'; request: ConfirmRecordingAttemptRequest } | { kind: 'beginSide'; request: BeginRecordingAttemptSideRequest } | { kind: 'stop'; request: StopRecordingAttemptRequest }
type Pending = Operation & { snapshot: RecordingAttempt }
type PendingBegin = { request: BeginRecordingAttemptRequest; planId: string; planContentHash: string }
export interface RecordingAttemptState {
  plan?: RecordingPlanVersion
  page?: RecordingAttemptsPage
  listPhase: 'unread' | 'loading' | 'ready' | 'error'
  listError: string
  selectedId: string
  stopId: string
  attempt?: RecordingAttempt
  reading: boolean
  detailError: string
  confirmed: boolean
  sideConfirmed: boolean
  startConfirmed: boolean
  preflightPhase: 'unread' | 'loading' | 'ready' | 'blocked' | 'error'
  preflight?: RecordingPreflightResult
  preflightError: string
  beginSending: boolean
  pendingBegin?: PendingBegin
  sending: boolean
  pending?: Pending
  stopRecovery?: Extract<Pending, { kind: 'stop' }>
  operationError: string
  notice: string
  receiptReading: boolean
  receiptError: string
  receiptNotice: string
}

export function createRecordingAttemptController(options: { api: RecordingAttemptsPublicApi & Pick<RecordingPlansPublicApi, 'preflightRecordingPlan'>; onChange?: () => void }) {
  const state: RecordingAttemptState = { listPhase: 'unread', listError: '', selectedId: '', stopId: '', reading: false, detailError: '', confirmed: false, sideConfirmed: false,
    startConfirmed: false, preflightPhase: 'unread', preflightError: '', beginSending: false, sending: false, operationError: '', notice: '', receiptReading: false, receiptError: '', receiptNotice: '' }
  const { api } = options
  let alive = true, context = 0, listRead = 0, detailRead = 0, admissionRead = 0, operationMutation = 0, beginMutation = 0, receiptRead = 0
  let preflightPlanHash = '', pollTimer: ReturnType<typeof setTimeout> | undefined
  // 仅当前明确选择的记录保留最近可信身份：失败读取不可用于确认，但不能挡住stop。
  let observed: RecordingAttempt | undefined
  const hasUnsettledOutput = (value: RecordingAttempt | undefined): boolean => !!value?.sides.some(side => side.runId && (!side.engineStoppedSubmitting || !side.cleanupQuiescent))
  const needsObservation = (value: RecordingAttempt | undefined): boolean => value?.status === 'in-progress' || hasUnsettledOutput(value)
  const sameIdentity = (before: RecordingAttempt, value: RecordingAttempt): boolean => before.id === value.id && before.planVersionId === value.planVersionId
    && before.planContentHash === value.planContentHash && before.draftId === value.draftId && before.physicalId === value.physicalId
    && before.executionAssetId === value.executionAssetId && before.createdAt === value.createdAt && before.sides.length === value.sides.length
    && before.sides.every((side, index) => {
      const next = value.sides[index]!
      return side.side === next.side && side.recipeHash === next.recipeHash && side.audioSha256 === next.audioSha256 && side.pcmSha256 === next.pcmSha256
        && side.frameCount === next.frameCount && (!side.runId || side.runId === next.runId)
    })
  const conflictsWithObserved = (value: RecordingAttempt): boolean => !!observed && observed.id === value.id
    && (!sameIdentity(observed, value) || value.revision === observed.revision && JSON.stringify(value) !== JSON.stringify(observed))
  const emit = () => { if (alive) options.onChange?.() }
  const clearPoll = () => { if (pollTimer) clearTimeout(pollTimer); pollTimer = undefined }
  function schedulePoll(): void {
    clearPoll()
    if (alive && needsObservation(observed) && state.selectedId === observed?.id) {
      pollTimer = setTimeout(() => { void pollSelected() }, 1000)
      ;(pollTimer as { unref?: () => void }).unref?.()
    }
  }
  function accept(value: RecordingAttempt): void {
    observed = structuredClone(value); state.attempt = structuredClone(value)
    // Stop受理不证明close和输入租期已收口；新鲜静止事实才释放原命令描述符。
    if (state.stopRecovery?.snapshot.id === value.id && !hasUnsettledOutput(value)) state.stopRecovery = undefined
    state.stopId = needsObservation(value) ? value.id : ''
    schedulePoll()
  }
  function bindKnownAttempt(value: RecordingAttempt): void {
    if (conflictsWithObserved(value)) throw new Error('可信录音事实冲突')
    const latest = observed?.id === value.id && observed.revision > value.revision ? observed : value
    ++detailRead; state.reading = false; state.selectedId = value.id; state.detailError = ''; state.confirmed = false; state.sideConfirmed = false
    accept(latest)
  }
  function invalidateReceiptRead(): void {
    ++receiptRead; state.receiptReading = false; state.receiptError = ''; state.receiptNotice = ''
  }
  const matchesPlan = (value: RecordingAttempt, plan = state.plan): boolean => !!plan && value.planVersionId === plan.id && value.planContentHash === plan.contentHash
    && value.draftId === plan.draftId && value.physicalId === plan.physicalCopy.physicalId && value.executionAssetId === plan.execution.assetId
    && value.sides.length === plan.execution.audio.length && value.sides.every((side, index) => {
      const receipt = plan.execution.audio[index]
      return !!receipt && side.side === receipt.recipe.side && side.recipeHash === receipt.recipeHash && side.audioSha256 === receipt.audio.sha256 && side.pcmSha256 === receipt.audio.pcmSha256 && side.frameCount === receipt.audio.frameCount
    })
  /** 排除只读进度计数与更新时间；保留人工确认、阶段和输出身份的真实依据。 */
  const confirmationBasis = (value: RecordingAttempt): string => JSON.stringify({
    id: value.id, planVersionId: value.planVersionId, planContentHash: value.planContentHash, physicalId: value.physicalId,
    executionAssetId: value.executionAssetId, status: value.status, phase: value.phase, activeSide: value.activeSide, reason: value.reason,
    flipConfirmedAt: value.flipConfirmedAt, physicalRecordingConfirmedAt: value.physicalRecordingConfirmedAt,
    finalVerificationCompleteAt: value.finalVerificationCompleteAt,
    sides: value.sides.map(side => ({ side: side.side, phase: side.phase, runId: side.runId, recipeHash: side.recipeHash,
      audioSha256: side.audioSha256, pcmSha256: side.pcmSha256, frameCount: side.frameCount,
      sourceEof: side.sourceEof, backendDrained: side.backendDrained, engineStoppedSubmitting: side.engineStoppedSubmitting,
      stopAcknowledged: side.stopAcknowledged, cleanupQuiescent: side.cleanupQuiescent, physicalStopConfirmedAt: side.physicalStopConfirmedAt,
      reason: side.reason })),
  })
  function setPlan(plan?: RecordingPlanVersion): void {
    if (!alive) return
    if (state.plan && plan?.id === state.plan.id && plan.contentHash === state.plan.contentHash) return
    if (state.plan && !canLeave()) { state.operationError = '当前输出或原命令尚未收口，不能切换计划；停止入口保持可用。'; emit(); return }
    ++context; ++listRead; ++detailRead; ++admissionRead; clearPoll(); invalidateReceiptRead()
    state.plan = plan?.status === 'frozen' && plan.formalReady === false && isCollectionId(plan.id) && isCollectionId(plan.draftId) && Array.isArray(plan.execution?.audio) ? structuredClone(plan) : undefined
    state.page = undefined; state.listPhase = 'unread'; state.listError = ''; state.selectedId = ''; state.stopId = ''; state.stopRecovery = undefined; observed = undefined; state.attempt = undefined; state.reading = false; state.detailError = ''; state.confirmed = false; state.sideConfirmed = false; state.startConfirmed = false; state.notice = ''
    state.preflight = undefined; state.preflightPhase = 'unread'; state.preflightError = ''; preflightPlanHash = ''
    // 未确认的命令只保留一份；换上下文不重放，回到原Attempt后才允许手动重试。
    emit()
  }
  function invalidateAdmission(): void {
    ++admissionRead; state.preflight = undefined; state.preflightPhase = 'unread'; state.preflightError = ''; preflightPlanHash = ''
    state.startConfirmed = false; state.sideConfirmed = false
  }
  const admissionReady = (): boolean => !!state.plan && preflightPlanHash === state.plan.contentHash
    && state.preflightPhase === 'ready' && state.preflight?.planVersionId === state.plan.id
    && state.preflight.state === 'ready' && state.preflight.gateB === 'VERIFIED' && state.preflight.formalReady === true
  async function preflight(): Promise<boolean> {
    const plan = state.plan
    if (!alive || !plan || state.preflightPhase === 'loading' || state.beginSending) return false
    const token = ++admissionRead, generation = context
    state.preflight = undefined; state.preflightPhase = 'loading'; state.preflightError = ''; preflightPlanHash = ''; emit()
    try {
      const result = await api.preflightRecordingPlan({ readId: crypto.randomUUID(), planVersionId: plan.id })
      if (!alive || generation !== context || token !== admissionRead || state.plan?.id !== plan.id || state.plan.contentHash !== plan.contentHash) return false
      if (!isRecordingPreflightResult(result) || result.planVersionId !== plan.id) throw new Error('预检回执与当前计划不一致')
      state.preflight = result; preflightPlanHash = plan.contentHash
      state.preflightPhase = result.state === 'ready' ? 'ready' : 'blocked'
      if (result.state !== 'ready') { state.startConfirmed = false; state.sideConfirmed = false }
      return admissionReady()
    } catch {
      if (alive && generation === context && token === admissionRead) { state.preflightPhase = 'error'; state.preflightError = '本次正式输出预检未完成，不能据此开始录音；请核对计划后重试。' }
      return false
    } finally { if (alive && generation === context && token === admissionRead) emit() }
  }
  const canBegin = (): boolean => alive && admissionReady() && state.startConfirmed && !state.beginSending && !state.sending && !state.pending && !state.pendingBegin
    && !state.receiptReading && !state.reading && !state.detailError && !needsObservation(observed)
  const canBeginSide = (): boolean => alive && admissionReady() && state.sideConfirmed && !state.beginSending && !state.sending && !state.pending && !state.pendingBegin && !state.receiptReading
    && !state.reading && !state.detailError && !!state.attempt && state.attempt.id === state.selectedId
    && !hasUnsettledOutput(state.attempt)
    && state.attempt.status === 'in-progress' && state.attempt.phase === 'awaiting-side-b'
    && state.attempt.sides[1]?.side === 'B' && state.attempt.sides[1].phase === 'pending'
  function setStartConfirmed(value: boolean): void { if (alive && !state.beginSending) { state.startConfirmed = value; emit() } }
  function setSideConfirmed(value: boolean): void { if (alive && !state.beginSending && !state.sending) { state.sideConfirmed = value; emit() } }
  async function refresh(offset = 0): Promise<void> {
    if (!alive || !state.plan || !Number.isSafeInteger(offset) || offset < 0 || offset % MAX_RECORDING_ATTEMPT_PAGE_SIZE !== 0) return
    const plan = state.plan, token = ++listRead, generation = context
    state.page = undefined; state.listPhase = 'loading'; state.listError = ''; emit()
    try {
      const value = await api.listRecordingAttempts({ planVersionId: plan.id, draftId: plan.draftId, page: { offset, limit: MAX_RECORDING_ATTEMPT_PAGE_SIZE } })
      if (!alive || generation !== context || token !== listRead) return
      if (!isRecordingAttemptsPage(value) || value.offset !== offset || value.limit !== MAX_RECORDING_ATTEMPT_PAGE_SIZE || !value.items.every(item => matchesPlan(item, plan))) throw new Error('历史回执不匹配')
      state.page = structuredClone(value); state.listPhase = 'ready'
    } catch {
      if (alive && generation === context && token === listRead) { state.listPhase = 'error'; state.listError = '录音尝试读取失败，请重试；不能据此判断没有历史记录。' }
    } finally { if (alive && generation === context && token === listRead) emit() }
  }
  async function readSelected(): Promise<void> {
    if (!alive || !state.plan || !state.selectedId) return
    const plan = state.plan, id = state.selectedId, token = ++detailRead, generation = context
    state.attempt = undefined; state.reading = true; state.detailError = ''; state.confirmed = false; state.notice = ''; emit()
    try {
      const response = await api.getRecordingAttempt(id)
      if (!alive || generation !== context || token !== detailRead) return
      const value = response?.attempt
      if (!response || Object.keys(response).length !== 1 || !isRecordingAttempt(value) || value.id !== id || !matchesPlan(value, plan)
        || observed && value.revision < observed.revision || conflictsWithObserved(value)) throw new Error('录音事实回执不匹配')
      accept(value)
    } catch {
      if (alive && generation === context && token === detailRead) state.detailError = '本次录音事实读取失败或已不可用。请重新读取；不能沿用旧事实进行确认。'
    } finally { if (alive && generation === context && token === detailRead) { state.reading = false; schedulePoll(); emit() } }
  }
  /** 自动只读轮询不清空用户确认或操作回执；仅可信事实修订变化时撤销旧确认。 */
  async function pollSelected(): Promise<void> {
    if (!alive || !state.plan || !state.selectedId || state.reading || state.sending) { schedulePoll(); return }
    const plan = state.plan, id = state.selectedId, token = ++detailRead, generation = context
    try {
      const response = await api.getRecordingAttempt(id)
      if (!alive || generation !== context || token !== detailRead || state.selectedId !== id) return
      const value = response?.attempt
      if (!response || Object.keys(response).length !== 1 || !isRecordingAttempt(value) || value.id !== id || !matchesPlan(value, plan)
        || observed && value.revision < observed.revision || conflictsWithObserved(value)) throw new Error('录音事实回执不匹配')
      if (!observed || confirmationBasis(value) !== confirmationBasis(observed)) { state.confirmed = false; invalidateAdmission() }
      state.detailError = ''; accept(value)
    } catch {
      if (alive && generation === context && token === detailRead) state.detailError = '实时状态读取失败；不会清除停止入口，其他确认请在读取恢复后操作。'
    } finally { if (alive && generation === context && token === detailRead) { schedulePoll(); emit() } }
  }
  async function select(id: string): Promise<void> {
    if (!alive || !state.page?.items.some(item => item.id === id)) return
    if (!canSelect(id)) { state.operationError = selectionLockReason()!; emit(); return }
    clearPoll()
    if (id !== state.selectedId) { observed = undefined; state.stopId = '' }
    ++detailRead; state.selectedId = id; state.attempt = undefined; state.confirmed = false; state.sideConfirmed = false
    await readSelected()
  }
  const canConfirm = (kind: RecordingAttemptConfirmation, side?: RenderSide): boolean => {
    const value = state.attempt
    if (!alive || !value || state.reading || state.detailError || state.sending || state.pending || state.beginSending || state.pendingBegin || state.receiptReading) return false
    if (kind === 'physical-stop') {
      const selected = value.sides.find(item => item.side === side)
      return !!selected?.runId && !selected.physicalStopConfirmedAt && (value.status !== 'in-progress' && value.status !== 'completed' || selected.phase === 'awaiting-physical-stop' && selected.engineStoppedSubmitting)
    }
    if (value.status !== 'in-progress') return false
    if (kind === 'flip') return value.phase === 'awaiting-flip' && !value.flipConfirmedAt
    if (kind === 'physical-recording') return value.phase === 'final-verification' && !value.physicalRecordingConfirmedAt
    return value.phase === 'final-verification' && !!value.physicalRecordingConfirmedAt && !value.finalVerificationCompleteAt
  }
  function setConfirmed(value: boolean): void { if (alive && !state.detailError && !state.sending && !state.pending) { state.confirmed = value; emit() } }
  const canRetry = () => alive && !state.sending && !state.receiptReading && !!state.pending && state.selectedId === state.pending.snapshot.id && matchesPlan(state.pending.snapshot)
  const canStop = () => alive && !!state.stopId && observed?.id === state.selectedId && needsObservation(observed) && !(state.sending && state.pending?.kind === 'stop')
  const selectionLockReason = (): string | null => state.pendingBegin || state.beginSending || state.pending || state.sending || needsObservation(observed)
    ? '当前录音或原操作尚未收口，不能切换到另一条录音尝试；停止入口保持可用。' : null
  const canSelect = (id: string): boolean => id === state.selectedId || selectionLockReason() === null
  function leaveBlockReason(): string | null {
    if (state.beginSending || state.pendingBegin) return '开始命令回执尚未确认；请保留本页，按原命令核对，不会自动重发。'
    if (state.sending || state.pending) return '录音操作回执尚未确认；停止入口仍保持可用，请先核对原操作。'
    if (hasUnsettledOutput(observed)) return '本次正式输出或停止收口尚未证明引擎停止提交及资源静止；终态和实体人工停止不能替代软件关闭，请保留本页核对或恢复停止。'
    if (observed?.status === 'in-progress' && ['outputting', 'draining', 'awaiting-physical-stop'].includes(observed.phase))
      return '本次正式输出或停止收口仍在进行；请先明确停止或等到可安全离开的人工阶段。'
    return null
  }
  const canLeave = (): boolean => leaveBlockReason() === null
  async function send(pending: Pending): Promise<void> {
    const token = ++operationMutation, generation = context, selectedId = state.selectedId
    invalidateReceiptRead()
    if (pending.kind === 'stop') state.stopRecovery = structuredClone(pending)
    ++detailRead; state.reading = false; state.pending = pending; state.sending = true; state.confirmed = false; invalidateAdmission(); state.operationError = ''; state.notice = ''; emit()
    try {
      const value = pending.kind === 'confirm' ? await api.confirmRecordingAttempt(structuredClone(pending.request))
        : pending.kind === 'stop' ? await api.stopRecordingAttempt(structuredClone(pending.request)) : await api.beginRecordingAttemptSide(structuredClone(pending.request))
      if (!alive || token !== operationMutation) return
      const original = pending.snapshot
      if (!isRecordingAttempt(value) || value.id !== original.id || value.planVersionId !== original.planVersionId || value.planContentHash !== original.planContentHash
        || value.draftId !== original.draftId || value.physicalId !== original.physicalId || value.executionAssetId !== original.executionAssetId || value.createdAt !== original.createdAt
        || value.sides.length !== original.sides.length || !value.sides.every((side, index) => {
          const before = original.sides[index]!
          return side.side === before.side && side.recipeHash === before.recipeHash && side.audioSha256 === before.audioSha256 && side.pcmSha256 === before.pcmSha256 && side.frameCount === before.frameCount
        })) throw new Error('操作回执不匹配')
      if (value.revision < pending.snapshot.revision) throw new Error('操作回执版本回退')
      if (!sameIdentity(original, value) || conflictsWithObserved(value)) throw new Error('操作回执身份冲突')
      state.pending = undefined
      if (generation === context && selectedId === state.selectedId) {
        ++detailRead; state.reading = false
        if (!observed || value.revision >= observed.revision) accept(value)
        state.notice = '已收到本次操作回执；设备排空、资源静止和实体停止仍以各项事实为准。'
      }
    } catch {
      if (alive && token === operationMutation) state.operationError = '操作回执未确认，不能假定已停止或已完成。请手动重试原操作；不会自动重放。'
    } finally { if (alive && token === operationMutation) { state.sending = false; schedulePoll(); emit() } }
  }
  async function confirm(kind: RecordingAttemptConfirmation, side?: RenderSide): Promise<void> {
    if (!state.confirmed || !canConfirm(kind, side)) return
    const snapshot = structuredClone(state.attempt!), base = { commandId: crypto.randomUUID(), attemptId: snapshot.id, expectedRevision: snapshot.revision, userConfirmed: true as const }
    const request: ConfirmRecordingAttemptRequest = kind === 'physical-stop' ? { ...base, kind, side: side! } : { ...base, kind }
    await send({ kind: 'confirm', request, snapshot })
  }
  async function sendBegin(pending: PendingBegin): Promise<void> {
    const plan = state.plan
    if (!alive || !plan || plan.id !== pending.planId || plan.contentHash !== pending.planContentHash || state.beginSending || state.sending || state.pending) return
    const token = ++beginMutation, generation = context
    invalidateReceiptRead()
    state.beginSending = true; state.pendingBegin = pending; state.operationError = ''; invalidateAdmission(); emit()
    try {
      const value = await api.beginRecordingAttempt(structuredClone(pending.request))
      if (!alive || token !== beginMutation || state.pendingBegin?.request.commandId !== pending.request.commandId) return
      if (!isRecordingAttempt(value) || !matchesPlan(value, plan)) throw new Error('开始回执与本次计划不一致')
      if (generation === context && state.plan?.id === plan.id && state.plan.contentHash === plan.contentHash) {
        const retainedNewerFact = observed?.id === value.id && observed.revision > value.revision
        bindKnownAttempt(value)
        state.pendingBegin = undefined
        state.notice = retainedNewerFact
          ? '原开始命令回执已确认；当前录音事实更新，以较新的停止或终态为准。'
          : value.status === 'in-progress' ? '已收到正式输出尝试回执；软件输出、驱动排空与实体录制仍分别核对。' : '已收到开始失败的真实记录；未形成录音完成事实。'
        state.page = undefined; state.listPhase = 'unread'; void refresh()
      }
    } catch (cause) {
      if (!alive || token !== beginMutation || generation !== context || state.pendingBegin?.request.commandId !== pending.request.commandId) return
      if (/\[ATTEMPT_NOT_ACCEPTED\]/u.test(cause instanceof Error ? cause.message : '')) {
        state.pendingBegin = undefined
        state.operationError = '正式输出准入已变化，开始请求未获接受；请重新预检并确认。'
      } else state.operationError = '开始回执未确认；不会自动重发或假定已开始。请核对当前记录，再按原命令重试。'
    } finally { if (alive && token === beginMutation) { state.beginSending = false; emit() } }
  }
  async function begin(): Promise<void> {
    if (!canBegin()) return
    const plan = state.plan!
    // 点击开始时再做一次实时预检；先前的绿色状态不是永久许可。
    if (!await preflight() || !canBegin() || state.plan?.id !== plan.id || state.plan.contentHash !== plan.contentHash) return
    await sendBegin({ request: { commandId: crypto.randomUUID(), planVersionId: plan.id, planContentHash: plan.contentHash, userConfirmed: true }, planId: plan.id, planContentHash: plan.contentHash })
  }
  async function retryBegin(): Promise<void> {
    const pending = state.pendingBegin
    if (pending && !state.beginSending && !state.sending && !state.pending && !state.receiptReading) await sendBegin(pending)
  }
  async function beginSide(): Promise<void> {
    if (!canBeginSide()) return
    const plan = state.plan!, selected = state.attempt!
    if (!await preflight() || !canBeginSide() || state.plan?.id !== plan.id || state.plan.contentHash !== plan.contentHash
      || state.attempt?.id !== selected.id || state.attempt.revision !== selected.revision) return
    const snapshot = structuredClone(state.attempt)
    await send({ kind: 'beginSide', snapshot, request: { commandId: crypto.randomUUID(), attemptId: snapshot.id, expectedRevision: snapshot.revision, side: 'B', userConfirmed: true } })
  }
  async function stop(): Promise<void> {
    if (!canStop()) return
    if (state.pending?.kind === 'stop' && state.pending.snapshot.id === observed!.id) { await send(state.pending); return }
    if (state.stopRecovery?.snapshot.id === observed!.id) { await send(state.stopRecovery); return }
    const snapshot = structuredClone(observed!)
    await send({ kind: 'stop', snapshot, request: { commandId: crypto.randomUUID(), attemptId: snapshot.id } })
  }
  async function retry(): Promise<void> { if (canRetry()) await send(state.pending!) }
  const canReconcileReceipt = (): boolean => alive && !!(state.pending || state.pendingBegin || state.stopRecovery) && !state.sending && !state.beginSending && !state.receiptReading && typeof api.getRecordingAttemptReceipt === 'function'
  async function reconcileReceipt(): Promise<void> {
    if (!canReconcileReceipt()) return
    const pending = state.pending ?? state.stopRecovery, pendingBegin = state.pendingBegin, plan = state.plan
    const input: RecordingAttemptReceiptRequest = pending ? { action: pending.kind, request: structuredClone(pending.request) } as RecordingAttemptReceiptRequest
      : { action: 'begin', request: structuredClone(pendingBegin!.request) }
    const token = ++receiptRead, generation = context
    state.receiptReading = true; state.receiptError = ''; state.receiptNotice = ''; emit()
    try {
      const result = await api.getRecordingAttemptReceipt!(structuredClone(input))
      if (!alive || token !== receiptRead || generation !== context || (pending ? (state.pending ?? state.stopRecovery)?.request.commandId : state.pendingBegin?.request.commandId) !== input.request.commandId) return
      if (!isRecordingAttemptReceipt(result) || result.commandId !== input.request.commandId || result.action !== input.action) throw new Error('原命令回执身份不一致')
      if (result.status !== 'accepted') {
        state.receiptNotice = result.status === 'pending' ? '原命令仍待确认；本次核对未重发执行请求，请保留原命令身份。' : '本次未取得原命令的受理证明；缺席不等于未受理，不会重发或生成新命令。'
        return
      }
      const { receipt, attempt: latest } = result
      if (!matchesPlan(receipt, plan) || !matchesPlan(latest, plan) || !sameIdentity(receipt, latest) || latest.revision < receipt.revision
        || latest.revision === receipt.revision && JSON.stringify(latest) !== JSON.stringify(receipt) || conflictsWithObserved(latest)) throw new Error('原命令谱系或当前录音事实不一致')
      if (input.action === 'begin') {
        if (receipt.planVersionId !== input.request.planVersionId || receipt.planContentHash !== input.request.planContentHash) throw new Error('开始命令计划不一致')
      } else if (!pending || receipt.id !== input.request.attemptId || !sameIdentity(pending.snapshot, receipt) || receipt.revision < pending.snapshot.revision) throw new Error('原操作记录不一致')
      if (pending?.kind === 'stop') state.stopRecovery = structuredClone(pending)
      bindKnownAttempt(latest)
      if (pending) { state.pending = undefined; ++operationMutation }
      else { state.pendingBegin = undefined; ++beginMutation }
      state.operationError = ''; invalidateAdmission()
      state.receiptNotice = '原命令受理已核对；本次只读取回执，软件静止和实体停止仍分别核对，不自动开始或继续输出。'
    } catch {
      if (alive && token === receiptRead && generation === context) state.receiptError = '原命令回执核对失败或事实不一致；保留原命令与停止入口，不能假定未受理或已停止。'
    } finally { if (alive && token === receiptRead && generation === context) { state.receiptReading = false; schedulePoll(); emit() } }
  }
  function dispose(): void { alive = false; ++context; ++listRead; ++detailRead; ++admissionRead; ++operationMutation; ++beginMutation; invalidateReceiptRead(); clearPoll(); state.attempt = undefined; observed = undefined; state.stopId = ''; state.stopRecovery = undefined }
  return { state, setPlan, refresh, select, readSelected, pollSelected, preflight, canBegin, canBeginSide, setStartConfirmed, setSideConfirmed,
    begin, retryBegin, canConfirm, setConfirmed, canRetry, canStop, canSelect, selectionLockReason, canLeave, leaveBlockReason, confirm, beginSide, stop, retry,
    canReconcileReceipt, reconcileReceipt, dispose }
}
